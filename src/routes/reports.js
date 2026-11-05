const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');
// b237 (2026-08-27) — reports.write / reports.send-to-parents were decorative.
const { requireCapabilityLevel } = require('../lib/capabilities');

router.use(authenticate);

// b491 (2026-10-12, security hardening item 6) — GET / and GET /:id had NO scope
// check at all beyond being logged in: any practitioner could list or fetch EVERY
// child's report, not just their key children's. EY_SCOPED_ROLES forces the
// key_person_id filter for those roles — not the opt-in `?mine=1` pattern used
// elsewhere (src/routes/observations.js), because that is a convenience filter a
// caller can simply omit, not a security boundary.
const EY_SCOPED_ROLES = ['practitioner', 'apprentice'];
async function _isKeyPersonOf(db, childId, staffId) {
  if (!childId || !staffId) return false;
  const { rows } = await db.query('SELECT 1 FROM children WHERE id=$1 AND key_person_id=$2', [childId, staffId]);
  return rows.length > 0;
}

// b333: host + model from the one resolver (src/lib/ai-models.js). A report for
// parents is long-form drafting — the 'heavy' role.
const ai = require('../lib/ai-models');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const OLLAMA_HOST = ai.host();
const OLLAMA_MODEL = () => ai.model('heavy');

// GET /
router.get('/', async (req, res) => {
  const { child_id } = req.query;
  const scoped = hasRole(req.user, EY_SCOPED_ROLES);
  try {
    const db = getPool();
    // b491: a scoped role (practitioner/apprentice) only ever sees their own
    // key children's reports — ANDed in regardless of what child_id asks for.
    const conds = [];
    const params = [];
    if (child_id) { params.push(child_id); conds.push(`r.child_id=$${params.length}`); }
    if (scoped) { params.push(req.user.id); conds.push(`c.key_person_id=$${params.length}`); }
    const { rows } = await db.query(`
      SELECT r.*, c.first_name || ' ' || c.last_name as child_name,
             s.first_name || ' ' || s.last_name as staff_name
      FROM reports r
      LEFT JOIN children c ON c.id = r.child_id
      LEFT JOIN staff s ON s.id = r.staff_id
      ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
      ORDER BY r.created_at DESC LIMIT 100
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /email-log — must be before /:id to avoid route shadowing
router.get('/email-log', authenticate, async (req, res) => {
  try {
    const db = getLadnPool();
    const { rows } = await db.query(`
      SELECT id, sender_name, sender_email, subject, email_body, body,
             draft_reply, sent_reply, decision_type as status,
             created_at, decided_at as decision_at
      FROM decision_log
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /:id
router.get('/:id', async (req, res) => {
  if (isNaN(Number(req.params.id))) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT r.*, c.first_name || ' ' || c.last_name as child_name
      FROM reports r LEFT JOIN children c ON c.id = r.child_id
      WHERE r.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // b491 (2026-10-12): same key-person scope as GET / — otherwise a practitioner
    // who knows (or guesses) another child's report id reads it anyway.
    if (hasRole(req.user, EY_SCOPED_ROLES) && !(await _isKeyPersonOf(db, rows[0].child_id, req.user.id))) {
      return res.status(403).json({ error: 'Not your key child' });
    }
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// b238 (2026-08-27) — REPORTS ARE PDFs
// Spec: wren-docs/ey-portal-restructure-2026-08-27.md §9
//   "Reports that Wren generates must be generated as PDFs."
//   "Nothing kept on the website. No report content living as a web page."
//
// The document is the artefact. GET /:id/pdf renders the report once, caches the
// file under the uploads root and streams it; the EY reports screen links to it
// instead of rendering the body into HTML. Re-rendering only happens when the
// report has been edited since the cached file was written, so opening a report
// twice is a file read, not two pdfkit runs.
//
// jsonb `content` is unchanged and still the source of truth — the PDF is a
// rendering of it, never a second copy that can drift.
// ═══════════════════════════════════════════════════════════════════════════

const fsp = require('fs').promises;
const nodePath = require('path');
const { renderReportPdf, reportFilename } = require('../lib/report-pdf');

const REPORTS_PDF_DIR = process.env.REPORTS_PDF_DIR
  || nodePath.join(process.env.UPLOAD_ROOT || '/app/uploads', 'reports');

async function _settingHeader(db) {
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key IN ('nursery_name','setting_name','nursery_address')`);
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return {
      name: m.nursery_name || m.setting_name || 'Your Nursery',
      address: m.nursery_address || '',
    };
  } catch {
    return { name: 'Your Nursery', address: '' };
  }
}

// GET /:id/pdf — the report, as a document.
router.get('/:id/pdf', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  const download = req.query.download === '1';
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT r.*,
             c.first_name || ' ' || c.last_name AS child_name,
             rm.name AS room_name,
             s.first_name || ' ' || s.last_name AS author_name
        FROM reports r
        LEFT JOIN children c ON c.id = r.child_id
        LEFT JOIN rooms rm   ON rm.id = c.room_id
        LEFT JOIN staff s    ON s.id = r.staff_id
       WHERE r.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const report = rows[0];
    // b491 (2026-10-12): same key-person scope as GET / and GET /:id.
    if (hasRole(req.user, EY_SCOPED_ROLES) && !(await _isKeyPersonOf(db, report.child_id, req.user.id))) {
      return res.status(403).json({ error: 'Not your key child' });
    }

    const filename = reportFilename(
      report.report_type === 'two_year_check'
        ? Object.assign({ display_title: 'Progress Check at Age Two' }, report)
        : report);
    const disposition = (download ? 'attachment' : 'inline') +
      '; filename="' + filename.replace(/"/g, '') + '"';

    // An IMPORTED PDF (EyLog) is the report — never re-render it.
    if (report.source === 'eylog' && report.pdf_path) {
      const abs = nodePath.resolve(REPORTS_PDF_DIR, nodePath.basename(report.pdf_path));
      try {
        const buf = await fsp.readFile(abs);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', disposition);
        return res.end(buf);
      } catch {
        return res.status(404).json({ error: 'The imported PDF for this report is missing on disk' });
      }
    }

    // Cached render still current?
    //
    // b238 reasoned: "reports has no updated_at — created_at is the only
    // timestamp, so a cache written after it is by definition up to date." That
    // held until b243 added reports.updated_at, because a 2-year check IS edited
    // after it is created: the key person rewrites the draft before sending. A
    // cache written before the last edit would hand a parent the model's words
    // instead of the practitioner's. Re-render when the row has moved on.
    const _cacheStale = report.updated_at && report.pdf_generated_at &&
      new Date(report.updated_at) > new Date(report.pdf_generated_at);
    if (report.pdf_path && report.pdf_generated_at && !_cacheStale) {
      const abs = nodePath.resolve(REPORTS_PDF_DIR, nodePath.basename(report.pdf_path));
      try {
        const buf = await fsp.readFile(abs);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', disposition);
        return res.end(buf);
      } catch { /* cache gone — fall through and render again */ }
    }

    const setting = await _settingHeader(db);

    // b243 — a two_year_check's jsonb carries the key person's working material
    // (evidence refs like [OBS-412], sufficiency counts, invalid-citation lists)
    // alongside the prose. None of that belongs in the document a family takes to
    // a health visitor. Normalise it through the same helper the b243 route uses,
    // so there is still exactly ONE PDF path (b238) and the two cannot drift.
    let _renderable = report;
    if (report.report_type === 'two_year_check') {
      try { _renderable = require('./two-year-check').renderable(report); }
      catch (e) { console.error('[b243] renderable() unavailable, printing raw:', e.message); }
    }
    const buf = await renderReportPdf(_renderable, setting);

    // Cache it. A write failure (read-only volume, missing mount) must not stop
    // the practitioner getting their PDF — stream it either way.
    const stored = `report-${report.id}.pdf`;
    try {
      await fsp.mkdir(REPORTS_PDF_DIR, { recursive: true });
      await fsp.writeFile(nodePath.join(REPORTS_PDF_DIR, stored), buf);
      await db.query(
        `UPDATE reports SET pdf_path=$2, pdf_generated_at=now(), pdf_bytes=$3,
                            source=COALESCE(source,'wren')
          WHERE id=$1`, [report.id, stored, buf.length]);
    } catch (e) {
      console.error('[b238] could not cache report PDF', report.id, e.message);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', disposition);
    res.end(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /generate — AI-assisted report
router.post('/generate', requireCapabilityLevel('reports.write', 'edit'), async (req, res) => {
  const { child_id, report_type } = req.body;
  if (!child_id || !report_type) {
    return res.status(400).json({ error: 'child_id and report_type required' });
  }

  try {
    const db = getPool();
    // Gather child data
    const [childRes, obsRes, diaryRes, attendanceRes] = await Promise.all([
      db.query(`SELECT c.*, r.name as room_name,
        EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)) as age_months
        FROM children c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1`, [child_id]),
      db.query(`SELECT observation_text, eyfs_areas, created_at FROM observations
        WHERE child_id=$1 ORDER BY created_at DESC LIMIT 10`, [child_id]),
      db.query(`SELECT mood, meals, activities FROM daily_diary
        WHERE child_id=$1 AND date >= CURRENT_DATE - INTERVAL '14 days'
        ORDER BY date DESC LIMIT 7`, [child_id]),
      db.query(`SELECT COUNT(*) FILTER (WHERE NOT absent) as present,
        COUNT(*) FILTER (WHERE absent) as absent
        FROM attendance WHERE child_id=$1 AND date >= CURRENT_DATE - INTERVAL '30 days'`, [child_id])
    ]);

    if (!childRes.rows.length) return res.status(404).json({ error: 'Child not found' });
    const child = childRes.rows[0];
    const observations = obsRes.rows.map(o => o.observation_text).join('\n- ');
    const attendance = attendanceRes.rows[0];

    const prompt = `Write a ${report_type} report for ${child.first_name} ${child.last_name}, aged ${child.age_months} months, in ${child.room_name}.

Recent observations:
- ${observations || 'No recent observations'}

Attendance: ${attendance.present} days present, ${attendance.absent} days absent (last 30 days)

Write a professional, warm, Ofsted-ready report. Include: current stage of development, strengths, next steps. 3-4 paragraphs. Address to parents.`;

    const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL(),
        prompt,
        stream: false, think: false,
        options: ai.options({ num_predict: 800 })
      }),
      signal: AbortSignal.timeout(60000)
    });

    let reportText = '';
    if (response.ok) {
      const data = await response.json();
      reportText = data.response || '';
    }

    // Save to DB
    const { rows } = await db.query(`
      INSERT INTO reports (child_id, staff_id, report_type, content, ai_generated)
      VALUES ($1,$2,$3,$4,true)
      RETURNING *
    `, [child_id, req.user.id, report_type, JSON.stringify({ text: reportText })]);

    res.status(201).json({ ...rows[0], generated_text: reportText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id/share
// b237: sharing a report IS sending it to parents.
router.put('/:id/share', requireCapabilityLevel('reports.send-to-parents', 'edit'), async (req, res) => {
  try {
    const db = getPool();
    // b404-C (Toby, 17 Oct 2026): a termly update is approved by a room leader (or a
    // manager / deputy) before a family sees it, and it goes through
    // POST /api/termly-update/:id/send, which also writes the PDF and the
    // approval record. This generic share must not be a way round that.
    const { rows: typ } = await db.query('SELECT report_type FROM reports WHERE id=$1', [req.params.id]);
    if (typ[0] && typ[0].report_type === 'termly_update') {
      return res.status(403).json({ error: 'Termly updates are approved and sent from the Progress Updates screen, by a room leader.' });
    }
    const { rows } = await db.query(`
      UPDATE reports SET shared_with_parents=true WHERE id=$1 RETURNING *
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const rep = rows[0];

    // b177: staff-side ping scoped to the child's key person only (never all-staff) —
    // falls back to all-managers only when the child has no key person assigned,
    // matching the convention already used by scripts/report-engine-nightly.js.
    try {
      const { rows: cRows } = await db.query(
        'SELECT key_person_id, first_name, last_name FROM children WHERE id=$1', [rep.child_id]);
      const child = cRows[0];
      const childName = child ? `${child.first_name} ${child.last_name}` : null;
      const title = `Report shared: ${childName || 'a child'}`;
      const body  = `${rep.report_type || 'A report'} was shared with parents.`;
      const link  = `/ey/reports`;
      // notify() is fire-and-forget (returns undefined, handles its own errors
      // internally) — call it plain, don't chain .then/.catch onto its return value.
      notify('report_shared', 'parent', rep.child_id, title, body,
        { relatedTable: 'reports', relatedId: rep.id, link });
      if (child && child.key_person_id && Number(child.key_person_id) !== Number(req.user.id)) {
        notify('report_shared', 'staff', child.key_person_id, title, body,
          { relatedTable: 'reports', relatedId: rep.id, link });
      } else if (!child || !child.key_person_id) {
        notify('report_shared', 'all-managers', null, title, body,
          { relatedTable: 'reports', relatedId: rep.id, link });
      }
    } catch (e) { /* non-fatal — share already succeeded */ }

    res.json(rep);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Email / Messages inbox (reads from ladn_management decision_log) ──────────
const { Pool: LadnPool } = require('pg');

function getLadnPool() {
  if (!global._ladnPool) {
    global._ladnPool = new LadnPool({
      host: process.env.PG_HOST || 'localhost',
      port: 5433,
      database: 'ladn_management',
      user: process.env.LADN_PG_USER || 'ladn_user',
      password: process.env.LADN_PG_PASSWORD || '', // <redacted — set in .env, not committed>
    });
  }
  return global._ladnPool;
}

router.post('/send-reply', authenticate, async (req, res) => {
  const { id, use_draft, custom_text } = req.body;
  try {
    const db = getLadnPool();
    const { rows } = await db.query('SELECT * FROM decision_log WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const msg = rows[0];
    const replyText = custom_text || msg.draft_reply;
    if (!replyText) return res.status(400).json({ error: 'No reply text' });

    // Call n8n webhook to send the actual Gmail reply
    const n8nUrl = 'http://localhost:5678/webhook/send-email-reply';
    await fetch(n8nUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, reply_text: replyText, message_id: msg.message_id || msg.gmail_id })
    }).catch(() => {}); // fire and forget

    await db.query(
      'UPDATE decision_log SET decision_type=$1, sent_reply=$2, decided_at=NOW() WHERE id=$3',
      ['sent', replyText, id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/skip', authenticate, async (req, res) => {
  const { id } = req.body;
  try {
    const db = getLadnPool();
    await db.query('UPDATE decision_log SET decision_type=$1, decided_at=NOW() WHERE id=$2', ['skipped', id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
