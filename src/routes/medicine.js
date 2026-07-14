const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');
const { hasCapability } = require('../lib/capabilities');
const { recordAudit } = require('../utils/audit');

router.use(authenticate);

// Medicine access is governed by the 'medicine_record' capability — granted by
// role OR per-staff override (see staff_capabilities). This replaced the
// hardcoded manager-only role gate on 2026-06-06 (CLAUDE.md ABSOLUTE RULE 6
// deliberately superseded by Toby — per-practitioner permissions, EyLog-style).
// Toby (id=1) and managers always resolve true. Optional x-medicine-token
// header is kept as an extra protection layer.
const MEDICINE_TOKEN = process.env.MEDICINE_TOKEN;
router.use(async (req, res, next) => {
  try {
    if (!(await hasCapability(req.user, 'medicine_record'))) {
      return res.status(403).json({ error: 'Medicine capability required (medicine_record)' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Capability check failed' });
  }
  if (MEDICINE_TOKEN && req.headers['x-medicine-token'] !== MEDICINE_TOKEN) {
    return res.status(401).json({ error: 'Medicine token required' });
  }
  next();
});

// GET /today
router.get('/today', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT m.*, c.first_name || ' ' || c.last_name as child_name, c.room_id,
             s.first_name || ' ' || s.last_name as staff_name
      FROM medicine_records m
      JOIN children c ON c.id = m.child_id
      LEFT JOIN staff s ON s.id = m.staff_id
      WHERE m.time_given >= CURRENT_DATE OR m.created_at >= CURRENT_DATE
      ORDER BY m.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId
router.get('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT m.*, s.first_name || ' ' || s.last_name as staff_name
      FROM medicine_records m
      LEFT JOIN staff s ON s.id = m.staff_id
      WHERE m.child_id=$1
      ORDER BY m.created_at DESC LIMIT 50
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /
router.post('/', async (req, res) => {
  const { child_id, medicine_name, dose, time_given, parent_consent, notes,
          temperature, consent_method, staff_signature } = req.body;
  if (!child_id || !medicine_name) {
    return res.status(400).json({ error: 'child_id and medicine_name required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO medicine_records (child_id, staff_id, medicine_name, dose, time_given, parent_consent, notes,
                                    temperature, consent_method, staff_signature)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [child_id, req.user.id, medicine_name, dose,
        time_given || new Date(), parent_consent || false, notes,
        temperature != null && temperature !== '' ? temperature : null,
        consent_method || (parent_consent ? 'written' : null),
        staff_signature ? String(staff_signature).slice(0, 120) : null]);
    // Notify all-managers (and key person via my_keychildren scope in prefs)
    const { rows: childRow } = await db.query(
      `SELECT first_name || ' ' || last_name as name FROM children WHERE id=$1`, [child_id]
    ).catch(() => ({ rows: [] }));
    notify('medicine_given', 'all-managers', null,
      `Medicine given: ${medicine_name}`,
      `Child: ${childRow[0]?.name || child_id}. Dose: ${dose || 'not recorded'}. Given at ${new Date(time_given || Date.now()).toLocaleTimeString('en-GB')}.`,
      { priority: 'normal', relatedTable: 'children', relatedId: parseInt(child_id) }
    );
    recordAudit({ req, action: 'create', entity_type: 'medicine_record', entity_id: rows[0].id,
      meta: { child_id, medicine_name, dose: dose || null, parent_consent: !!parent_consent } });
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/sign-off — manager signs off medicine record
router.post('/:id/sign-off', async (req, res) => {
  if (!(await hasCapability(req.user, 'medicine_signoff'))) return res.status(403).json({ error: 'Medicine sign-off capability required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE medicine_records SET manager_sign_off_at=NOW(), manager_signed_by=$2 WHERE id=$1 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    recordAudit({ req, action: 'sign-off', entity_type: 'medicine_record', entity_id: req.params.id });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /export — export medicine records for a month
router.get('/export', async (req, res) => {
  if (!(await hasCapability(req.user, 'medicine_signoff'))) return res.status(403).json({ error: 'Medicine sign-off capability required' });
  const month = req.query.month; // YYYY-MM
  try {
    const db = getPool();
    let q = `
      SELECT m.*, c.first_name||' '||c.last_name as child_name,
             s.first_name||' '||s.last_name as given_by_name,
             sm.first_name||' '||sm.last_name as manager_name
      FROM medicine_records m
      JOIN children c ON c.id=m.child_id
      LEFT JOIN staff s ON s.id=m.staff_id
      LEFT JOIN staff sm ON sm.id=m.manager_signed_by
    `;
    const params = [];
    if (month) {
      q += ` WHERE TO_CHAR(m.created_at, 'YYYY-MM')=$1`;
      params.push(month);
    } else {
      q += ` WHERE m.created_at >= DATE_TRUNC('month', NOW())`;
    }
    q += ' ORDER BY m.created_at ASC';
    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /bulk-export — combined printable HTML of filtered medicine records
router.get('/bulk-export', async (req, res) => {
  if (!(await hasCapability(req.user, 'medicine_signoff'))) return res.status(403).json({ error: 'Medicine sign-off capability required' });
  const { from, to, child_id } = req.query;
  try {
    const db = getPool();
    let q = `
      SELECT m.*, c.first_name||' '||c.last_name as child_name, c.date_of_birth,
             s.first_name||' '||s.last_name as given_by_name,
             sm.first_name||' '||sm.last_name as manager_name
      FROM medicine_records m
      JOIN children c ON c.id=m.child_id
      LEFT JOIN staff s ON s.id=m.staff_id
      LEFT JOIN staff sm ON sm.id=m.manager_signed_by
      WHERE 1=1
    `;
    const params = [];
    if (from) { params.push(from); q += ` AND m.created_at >= $${params.length}::date`; }
    if (to) { params.push(to); q += ` AND m.created_at < ($${params.length}::date + INTERVAL '1 day')`; }
    if (child_id) { params.push(child_id); q += ` AND m.child_id = $${params.length}`; }
    q += ' ORDER BY m.created_at ASC';
    const { rows } = await db.query(q, params);

    // Generate combined printable HTML
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmt = d => d ? new Date(d).toLocaleString('en-GB', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
    const title = `Medicine Records ${from||''} ${to||''} ${child_id?'(filtered)':''}`.trim();

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${esc(title)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:20px auto;padding:20px;background:#f8fafc}
h1{font-size:22px;margin-bottom:6px;color:#0f172a}
.meta{font-size:13px;color:#64748b;margin-bottom:20px}
.record{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:12px;page-break-inside:avoid}
.record-header{font-weight:600;font-size:16px;margin-bottom:8px;color:#0f172a}
.field{display:grid;grid-template-columns:140px 1fr;gap:8px;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:14px}
.field:last-child{border:none}
.field-label{color:#64748b;font-weight:500}
.field-value{color:#0f172a}
.signed{color:#22c55e;font-weight:600}
.unsigned{color:#f59e0b;font-weight:600}
@media print{body{background:#fff;margin:0}}
</style>
</head><body>
<h1>${esc(title)}</h1>
<div class="meta">Generated ${new Date().toLocaleString('en-GB')} | ${rows.length} record(s)</div>
${rows.length === 0 ? '<p style="color:#64748b">No medicine records found for the selected filters.</p>' :
  rows.map((m, i) => `<div class="record">
  <div class="record-header">#${i+1} — ${esc(m.child_name)} — ${esc(m.medicine_name)}</div>
  <div class="field"><span class="field-label">Child</span><span class="field-value">${esc(m.child_name)} (DOB: ${fmt(m.date_of_birth)})</span></div>
  <div class="field"><span class="field-label">Medicine</span><span class="field-value">${esc(m.medicine_name)}</span></div>
  <div class="field"><span class="field-label">Dose</span><span class="field-value">${esc(m.dose || '—')}</span></div>
  <div class="field"><span class="field-label">Time given</span><span class="field-value">${fmt(m.time_given || m.created_at)}</span></div>
  <div class="field"><span class="field-label">Given by</span><span class="field-value">${esc(m.given_by_name || '—')}</span></div>
  <div class="field"><span class="field-label">Parent consent</span><span class="field-value">${m.parent_consent ? 'Yes' : 'No'}${m.consent_method ? ' ('+esc(m.consent_method)+')' : ''}</span></div>
  ${m.temperature ? `<div class="field"><span class="field-label">Temperature</span><span class="field-value">${esc(m.temperature)}°C</span></div>` : ''}
  ${m.notes ? `<div class="field"><span class="field-label">Notes</span><span class="field-value">${esc(m.notes)}</span></div>` : ''}
  <div class="field"><span class="field-label">Manager sign-off</span><span class="field-value ${m.manager_sign_off_at ? 'signed' : 'unsigned'}">${m.manager_sign_off_at ? '✓ Signed by '+esc(m.manager_name)+' at '+fmt(m.manager_sign_off_at) : 'Awaiting sign-off'}</span></div>
</div>`).join('')}
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="medicine-records-${from||'all'}-${to||'all'}.html"`);
    res.send(html);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /parent-consents — staff view pending parent medicine consents
router.get('/parent-consents', async (req, res) => {
  try {
    const db = getPool();
    const status = req.query.status || 'submitted';
    const { rows } = await db.query(`
      SELECT p.*, c.first_name || ' ' || c.last_name as child_name,
             s.first_name || ' ' || s.last_name as acknowledged_by_name
      FROM parent_medicine_consents p
      JOIN children c ON c.id = p.child_id
      LEFT JOIN staff s ON s.id = p.acknowledged_by
      WHERE p.status = $1
      ORDER BY p.created_at DESC
    `, [status]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /parent-consents/child/:childId — staff view parent consents for a specific child
router.get('/parent-consents/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT p.*, s.first_name || ' ' || s.last_name as acknowledged_by_name
      FROM parent_medicine_consents p
      LEFT JOIN staff s ON s.id = p.acknowledged_by
      WHERE p.child_id = $1
      ORDER BY p.created_at DESC
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /parent-consents/:id/acknowledge — staff acknowledges a parent consent
router.post('/parent-consents/:id/acknowledge', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE parent_medicine_consents
      SET status='acknowledged', acknowledged_by=$1, acknowledged_at=NOW()
      WHERE id=$2
      RETURNING *
    `, [req.user.id, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Consent not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
