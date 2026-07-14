'use strict';
// ── Data Governance module (PROMPT 45) ───────────────────────────────────────
// Legal retention scheduling, RAG compliance dashboard, records map, secure
// off-site archival logging + manager sign-off, and a printable GDPR report.
// ADDITIVE: never auto-deletes hot data — archival/erasure require explicit
// manager action. Encryption of archives runs sovereignly on the host via
// scripts/governance-archive.sh (host gpg); this route logs + reports.
const express = require('express');
const router = express.Router();
const PDFDoc = require('pdfkit');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');

router.use(authenticate);

const MGR_ROLES = ['manager', 'admin', 'headteacher'];
const ADMIN_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'];

const adminOnly = (req, res, next) => {
  if (!ADMIN_ROLES.includes(req.user?.role)) return res.status(403).json({ error: 'Admin access required' });
  next();
};
const managerOnly = (req, res, next) => {
  if (!MGR_ROLES.includes(req.user?.role)) return res.status(403).json({ error: 'Manager access required' });
  next();
};

// Per-record-type live-count queries. $1 = active_window interval, $2 = retention interval.
// Each is wrapped in try/catch at call time so a missing column never 500s the dashboard.
const COMPUTE = {
  child_record: {
    held:   `SELECT count(*)::int n FROM children`,
    review: `SELECT count(*)::int n FROM children WHERE leave_date IS NOT NULL AND leave_date + $1::interval < now() AND leave_date + $2::interval >= now()`,
    over:   `SELECT count(*)::int n FROM children WHERE leave_date IS NOT NULL AND leave_date + $1::interval < now()`,
    anchor: 'children who have left (leave_date)',
  },
  eyfs_developmental: {
    held:   `SELECT count(*)::int n FROM observations`,
    review: `SELECT count(*)::int n FROM observations o JOIN children c ON c.id=o.child_id WHERE c.leave_date IS NOT NULL AND c.leave_date + $1::interval < now() AND c.leave_date + $2::interval >= now()`,
    over:   `SELECT count(*)::int n FROM observations o JOIN children c ON c.id=o.child_id WHERE c.leave_date IS NOT NULL AND c.leave_date + $1::interval < now()`,
    anchor: 'observations of children who have left',
  },
  attendance_register: {
    held:   `SELECT count(*)::int n FROM attendance`,
    review: `SELECT count(*)::int n FROM attendance WHERE date + $1::interval < now() AND date + $2::interval >= now()`,
    over:   `SELECT count(*)::int n FROM attendance WHERE date + $1::interval < now()`,
    anchor: 'register date',
  },
  incident: {
    held:   `SELECT count(*)::int n FROM incidents`,
    review: `SELECT count(*)::int n FROM incidents WHERE incident_date + $1::interval < now() AND incident_date + $2::interval >= now()`,
    over:   `SELECT count(*)::int n FROM incidents WHERE incident_date + $1::interval < now()`,
    anchor: 'incident date',
  },
  medication_record: {
    held:   `SELECT count(*)::int n FROM medicine_records`,
    review: null, over: null,
    anchor: 'administration date (auto-calc unavailable — manual review)',
  },
  safeguarding_case: {
    held:   `SELECT count(*)::int n FROM safeguarding_concerns`,
    review: null, over: null,
    anchor: 'never auto-archived — retained hot for full statutory period',
  },
  financial: {
    held:   `SELECT count(*)::int n FROM invoices`,
    review: `SELECT count(*)::int n FROM invoices WHERE issued_on IS NOT NULL AND issued_on + $1::interval < now() AND issued_on + $2::interval >= now()`,
    over:   `SELECT count(*)::int n FROM invoices WHERE issued_on IS NOT NULL AND issued_on + $1::interval < now()`,
    anchor: 'invoice issue date',
  },
  staff_employment: {
    // NB id=1 (Toby, protected) excluded from any archival calculation.
    held:   `SELECT count(*)::int n FROM staff WHERE id<>1`,
    review: `SELECT count(*)::int n FROM staff WHERE id<>1 AND is_active=false AND termination_date IS NOT NULL AND termination_date + $1::interval < now() AND termination_date + $2::interval >= now()`,
    over:   `SELECT count(*)::int n FROM staff WHERE id<>1 AND is_active=false AND termination_date IS NOT NULL AND termination_date + $1::interval < now()`,
    anchor: 'employment end date (excludes protected id=1)',
  },
  parent_communication: {
    held:   `SELECT count(*)::int n FROM messages`,
    review: `SELECT count(*)::int n FROM messages WHERE created_at + $1::interval < now() AND created_at + $2::interval >= now()`,
    over:   `SELECT count(*)::int n FROM messages WHERE created_at + $1::interval < now()`,
    anchor: 'message date',
  },
  complaint: {
    held:   `SELECT count(*)::int n FROM enquiries`,
    review: null, over: null,
    anchor: 'resolution date (proxy: enquiries table — manual review)',
  },
};

async function scalar(db, sql, params) {
  try { const { rows } = await db.query(sql, params); return rows[0]?.n ?? null; }
  catch (_) { return null; }
}

// Build the RAG dashboard rows (one per policy)
async function buildDashboard(db) {
  const { rows: policies } = await db.query(
    `SELECT id, record_type, retention_rule::text, trigger_event, active_window::text,
            legal_basis, source_citation, data_category, record_tables, status, notes
       FROM retention_policies ORDER BY data_category, record_type`);
  const out = [];
  for (const p of policies) {
    const c = COMPUTE[p.record_type];
    let held = null, reviewDue = null, overRetention = null, computed = false;
    if (c) {
      held = await scalar(db, c.held, []);
      if (c.review && c.over) {
        reviewDue     = await scalar(db, c.review, [p.active_window, p.retention_rule]);
        overRetention = await scalar(db, c.over,   [p.retention_rule]);
        computed = reviewDue !== null && overRetention !== null;
      }
    } else if (Array.isArray(p.record_tables) && p.record_tables[0]) {
      held = await scalar(db, `SELECT count(*)::int n FROM ${p.record_tables[0].replace(/[^a-z_]/gi,'')}`, []);
    }
    // RAG
    let rag = 'na';
    if (overRetention && overRetention > 0) rag = 'red';
    else if (reviewDue && reviewDue > 0)    rag = 'amber';
    else if (computed)                       rag = 'green';
    else if (held !== null)                  rag = 'na';
    out.push({
      ...p,
      anchor: c?.anchor || null,
      held, review_due: reviewDue, over_retention: overRetention, computed, rag,
    });
  }
  return out;
}

// ── GET /retention-policies — full enriched schedule ─────────────────────────
router.get('/retention-policies', adminOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, record_type, retention_rule::text AS retention_rule, trigger_event,
              active_window::text AS active_window, legal_basis, source_citation,
              data_category, record_tables, status, notes, updated_at, updated_by, created_at
         FROM retention_policies ORDER BY data_category, record_type`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /retention-policies — upsert a configurable policy (manager) ────────
router.post('/retention-policies', managerOnly, async (req, res) => {
  const { record_type, retention_rule, trigger_event, legal_basis, source_citation,
          data_category, record_tables, active_window, notes } = req.body || {};
  if (!record_type || !retention_rule || !trigger_event || !legal_basis || !source_citation)
    return res.status(400).json({ error: 'record_type, retention_rule, trigger_event, legal_basis, source_citation required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO retention_policies
         (record_type, retention_rule, trigger_event, legal_basis, source_citation,
          data_category, record_tables, active_window, notes, status, updated_at, updated_by)
       VALUES ($1,$2::interval,$3,$4,$5,$6,$7,$8::interval,$9,'draft',now(),$10)
       ON CONFLICT (record_type, trigger_event) DO UPDATE SET
         retention_rule=EXCLUDED.retention_rule, legal_basis=EXCLUDED.legal_basis,
         source_citation=EXCLUDED.source_citation, data_category=EXCLUDED.data_category,
         record_tables=EXCLUDED.record_tables, active_window=EXCLUDED.active_window,
         notes=EXCLUDED.notes, updated_at=now(), updated_by=EXCLUDED.updated_by
       RETURNING *`,
      [record_type, retention_rule, trigger_event, legal_basis, source_citation,
       data_category || null, record_tables || null, active_window || null, notes || null,
       req.user?.name || req.user?.email || 'admin']);
    await recordAudit({ req, action: 'update', entity_type: 'retention_policy', entity_id: rows[0].id,
      meta: { record_type, retention_rule, trigger_event } });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /retention-policies/:id/confirm — Toby confirms a DRAFT policy ───────
router.post('/retention-policies/:id/confirm', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE retention_policies SET status='confirmed', updated_at=now(), updated_by=$2
         WHERE id=$1 RETURNING id, record_type, status`, [req.params.id, req.user?.name || 'manager']);
    if (!rows.length) return res.status(404).json({ error: 'Policy not found' });
    await recordAudit({ req, action: 'confirm', entity_type: 'retention_policy', entity_id: req.params.id,
      meta: { record_type: rows[0].record_type } });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /dashboard — RAG compliance summary per record type ───────────────────
router.get('/dashboard', adminOnly, async (req, res) => {
  try {
    const db = getPool();
    const rows = await buildDashboard(db);
    const summary = {
      red: rows.filter(r => r.rag === 'red').length,
      amber: rows.filter(r => r.rag === 'amber').length,
      green: rows.filter(r => r.rag === 'green').length,
      na: rows.filter(r => r.rag === 'na').length,
      draft: rows.filter(r => r.status !== 'confirmed').length,
      total: rows.length,
    };
    const { rows: [n] } = await db.query(`SELECT body, model, generated_at FROM governance_narrative WHERE section='framework_summary'`);
    res.json({ summary, policies: rows, narrative: n || null, generated_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /records-map — where each data category lives (tables + live counts) ──
router.get('/records-map', adminOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows: policies } = await db.query(
      `SELECT record_type, data_category, record_tables FROM retention_policies ORDER BY data_category`);
    const map = {};
    for (const p of policies) {
      const cat = p.data_category || 'Uncategorised';
      map[cat] = map[cat] || { category: cat, tables: [] };
      for (const t of (p.record_tables || [])) {
        const safe = t.replace(/[^a-z_]/gi, '');
        if (!safe || map[cat].tables.find(x => x.table === safe)) continue;
        const count = await scalar(db, `SELECT count(*)::int n FROM ${safe}`, []);
        map[cat].tables.push({ table: safe, count, record_type: p.record_type });
      }
    }
    res.json(Object.values(map));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /narrative — sovereign-AI framework summary ──────────────────────────
router.get('/narrative', adminOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT section, body, model, generated_at FROM governance_narrative`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /archives — history of off-site archival runs ────────────────────────
router.get('/archives', adminOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM data_archives ORDER BY created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /archive — record a manager-authorised archival REQUEST ──────────────
// Actual encryption runs sovereignly on the host (scripts/governance-archive.sh).
// Data is NEVER removed from the hot DB here.
router.post('/archive', managerOnly, async (req, res) => {
  const { record_type } = req.body || {};
  if (!record_type) return res.status(400).json({ error: 'record_type required' });
  try {
    const db = getPool();
    const { rows: [pol] } = await db.query(
      `SELECT record_type, data_category, active_window::text, retention_rule::text
         FROM retention_policies WHERE record_type=$1 LIMIT 1`, [record_type]);
    if (!pol) return res.status(404).json({ error: 'No retention policy for that record type' });
    const criteria = `records past active window (${pol.active_window}) from trigger, still within legal retention (${pol.retention_rule})`;
    const { rows: [a] } = await db.query(
      `INSERT INTO data_archives (record_type, data_category, criteria, status, created_by, notes)
       VALUES ($1,$2,$3,'requested',$4,$5) RETURNING *`,
      [record_type, pol.data_category, criteria, req.user?.name || 'manager',
       'Requested via Data Governance UI; run scripts/governance-archive.sh to encrypt + ship off-site.']);
    await recordAudit({ req, action: 'archive_request', entity_type: 'data_archive', entity_id: a.id,
      meta: { record_type, criteria } });
    res.json({ ok: true, archive: a,
      host_command: `bash /home/toby/wren/scripts/governance-archive.sh ${record_type} ${a.id}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /archives/:id/sign-off — manager authorises hot-DB removal ───────────
// Records the sign-off + audit. Does NOT delete data itself (deliberate,
// separate action — see leavers/erasure flow, prompt 46).
router.post('/archives/:id/sign-off', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE data_archives
          SET signed_off_by=$2, signed_off_at=now()
        WHERE id=$1 AND status IN ('archived','requested') RETURNING *`,
      [req.params.id, req.user?.name || 'manager']);
    if (!rows.length) return res.status(404).json({ error: 'Archive not found or not in a sign-off-able state' });
    await recordAudit({ req, action: 'archive_signoff', entity_type: 'data_archive', entity_id: req.params.id,
      meta: { record_type: rows[0].record_type } });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /pdf-report — printable Data Governance / GDPR compliance report ──────
router.get('/pdf-report', adminOnly, async (req, res) => {
  try {
    const db = getPool();
    const policies = await buildDashboard(db);
    const { rows: [n] } = await db.query(`SELECT body, model, generated_at FROM governance_narrative WHERE section='framework_summary'`);
    const { rows: archives } = await db.query(`SELECT record_type, row_count, sha256, offsite_remote, cipher, status, created_at FROM data_archives ORDER BY created_at DESC LIMIT 20`);
    const { rows: [settings] } = await db.query("SELECT value FROM settings WHERE key='setting_name' LIMIT 1").catch(() => ({ rows: [] }));
    const settingName = settings?.value || 'Little Angels Day Nursery';

    await recordAudit({ req, action: 'export', entity_type: 'governance_report', meta: { format: 'pdf' } });

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const version = process.env.WREN_VERSION || '1.x';
    const ragCol = (r) => ({ green: '#16a34a', amber: '#f59e0b', red: '#dc2626', na: '#6b7280' }[r] || '#6b7280');
    const ragLabel = (r) => ({ green: '✓ WITHIN POLICY', amber: '⚠ REVIEW DUE', red: '✗ OVER-RETENTION', na: '— MANUAL' }[r] || '—');

    const doc = new PDFDoc({ size: 'A4', margins: { top: 60, bottom: 60, left: 60, right: 60 }, autoFirstPage: false });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="wren-data-governance-report-${now.toISOString().slice(0,10)}.pdf"`);
    doc.pipe(res);
    const footer = () => doc.fontSize(8).fillColor('#6b7280').text(
      `Generated by Wren v${version} on ${dateStr} for ${settingName}. Retention periods are DRAFT until confirmed with the DPO — this report is evidence of process, not legal advice.`,
      60, doc.page.height - 55, { align: 'center', width: doc.page.width - 120 });

    // Cover
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 175).fill('#0f172a');
    doc.fillColor('#4a9abf').fontSize(28).font('Helvetica-Bold').text('Wren', 60, 55);
    doc.fillColor('#f1f5f9').fontSize(20).text('Data Governance & GDPR Compliance Report', 60, 90, { width: doc.page.width - 220 });
    doc.fillColor('#94a3b8').fontSize(11).text(settingName, 60, 135).text(dateStr, 60, 152);
    const counts = { red:0, amber:0, green:0, na:0 };
    policies.forEach(p => counts[p.rag]++);
    const cards = [
      { label: 'Within policy', count: counts.green, col: '#16a34a' },
      { label: 'Review due', count: counts.amber, col: '#f59e0b' },
      { label: 'Over-retention', count: counts.red, col: '#dc2626' },
      { label: 'Manual review', count: counts.na, col: '#6b7280' },
    ];
    let bx = 60;
    for (const c of cards) {
      doc.rect(bx, 210, 108, 62).fill(c.col);
      doc.fillColor('#fff').fontSize(24).font('Helvetica-Bold').text(String(c.count), bx, 220, { width: 108, align: 'center' });
      doc.fillColor('#fff').fontSize(9).font('Helvetica').text(c.label, bx, 250, { width: 108, align: 'center' });
      bx += 118;
    }
    doc.rect(60, 300, doc.page.width - 120, 96).fill('#e0f2fe');
    doc.fillColor('#0c4a6e').fontSize(9.5).font('Helvetica').text(
      `This report shows the records this setting holds, the statutory retention period applied to each, and their compliance status. It is produced by automated self-checks on the setting's own hardware; archived data is encrypted before it leaves the premises and no personal data is transmitted in producing this report. Retention periods are configurable and shown as DRAFT until confirmed with the Data Protection Officer.`,
      74, 312, { width: doc.page.width - 148 });
    if (n?.body) {
      doc.fillColor('#0f172a').fontSize(13).font('Helvetica-Bold').text('Legal framework', 60, 420);
      doc.fillColor('#334155').fontSize(9).font('Helvetica').text(n.body, 60, 442, { width: doc.page.width - 120, align: 'left' });
      doc.fillColor('#94a3b8').fontSize(7.5).text(`Framework summary generated by ${n.model}.`, 60, doc.y + 6);
    }
    footer();

    // Retention schedule table
    doc.addPage();
    doc.fillColor('#0f172a').fontSize(16).font('Helvetica-Bold').text('Retention schedule & compliance status', 60, 55);
    let y = 92;
    for (const p of policies) {
      if (y > doc.page.height - 150) { footer(); doc.addPage(); y = 60; }
      const col = ragCol(p.rag);
      doc.rect(60, y, doc.page.width - 120, 22).fill(col + '22');
      doc.rect(60, y, 4, 22).fill(col);
      doc.fillColor(col).fontSize(8).font('Helvetica-Bold').text(ragLabel(p.rag), 70, y + 6, { width: 92 });
      doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold').text(`${p.record_type}`, 168, y + 3, { width: 200 });
      doc.fillColor('#475569').fontSize(8).font('Helvetica').text(`${p.data_category || ''}`, 168, y + 13, { width: 200 });
      doc.fillColor('#0f172a').fontSize(9).font('Helvetica')
        .text(`keep ${p.retention_rule} · from ${p.trigger_event}`, 370, y + 3, { width: 180 });
      doc.fillColor('#475569').fontSize(8)
        .text(`held ${p.held ?? '—'} · review ${p.review_due ?? '—'} · over ${p.over_retention ?? '—'} · ${p.status}`, 370, y + 13, { width: 180 });
      y += 26;
      doc.fillColor('#64748b').fontSize(7.5).font('Helvetica-Oblique').text(p.source_citation, 70, y, { width: doc.page.width - 140 });
      y += doc.heightOfString(p.source_citation, { width: doc.page.width - 140, fontSize: 7.5 }) + 8;
    }
    footer();

    // Archive log
    doc.addPage();
    doc.fillColor('#0f172a').fontSize(16).font('Helvetica-Bold').text('Secure off-site archive log', 60, 55);
    doc.fillColor('#475569').fontSize(9).font('Helvetica').text('Archives are gpg-AES256 encrypted on the setting hardware before transfer to encrypted off-site storage. SHA-256 recorded for integrity. Hot-DB removal only occurs on explicit manager sign-off.', 60, 80, { width: doc.page.width - 120 });
    y = 120;
    if (!archives.length) {
      doc.fillColor('#94a3b8').fontSize(10).text('No archival runs recorded yet.', 60, y);
    } else {
      for (const a of archives) {
        if (y > doc.page.height - 120) { footer(); doc.addPage(); y = 60; }
        doc.fillColor('#0f172a').fontSize(9).font('Helvetica-Bold').text(`${a.record_type} · ${a.status}`, 60, y);
        doc.fillColor('#475569').fontSize(8).font('Helvetica').text(
          `${a.created_at ? new Date(a.created_at).toLocaleString('en-GB') : ''} · ${a.row_count ?? '—'} rows · ${a.cipher || '—'} · ${a.offsite_remote || 'pending'} · sha256 ${a.sha256 ? a.sha256.slice(0,16)+'…' : '—'}`,
          60, y + 12, { width: doc.page.width - 120 });
        y += 34;
      }
    }
    footer();
    doc.end();
  } catch (e) {
    console.error('[data-governance] pdf-report:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'PDF generation failed: ' + e.message });
  }
});

module.exports = router;
