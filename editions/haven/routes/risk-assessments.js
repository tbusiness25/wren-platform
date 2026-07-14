'use strict';
// Haven — resident risk assessments
const express = require('express');
const router = express.Router();
const { getPool } = require('../../../src/db/pool');
const authenticate = require('../../../src/middleware/auth');
const { requirePerm, fail } = require('../lib/permissions');
const { recordAudit } = require('../../../src/utils/audit');

router.use(authenticate);

// GET /?resident_id=&status=
router.get('/', async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (req.query.resident_id) { params.push(req.query.resident_id); where.push(`ra.resident_id = $${params.length}`); }
    params.push(req.query.status || 'active'); where.push(`ra.status = $${params.length}`);
    const { rows } = await getPool().query(`
      SELECT ra.*, r.first_name, r.last_name,
             (ra.next_review_due IS NOT NULL AND ra.next_review_due < CURRENT_DATE) AS review_overdue
      FROM risk_assessments ra JOIN residents r ON r.id = ra.resident_id
      WHERE ${where.join(' AND ')}
      ORDER BY ra.risk_rating DESC NULLS LAST, ra.next_review_due`, params);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// POST /
router.post('/', requirePerm('clinical_write'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.resident_id || !b.category || !b.title) {
      return res.status(400).json({ error: 'resident_id, category, title required' });
    }
    const freq = parseInt(b.review_frequency_days || 90, 10);
    const { rows } = await getPool().query(
      `INSERT INTO risk_assessments (resident_id, category, title, hazard, who_at_risk,
         existing_controls, further_actions, likelihood, severity, review_frequency_days,
         next_review_due, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::int, COALESCE($11::date, CURRENT_DATE + $10::int), $12)
       RETURNING *`,
      [b.resident_id, b.category, b.title, b.hazard || null, b.who_at_risk || null,
       b.existing_controls || null, b.further_actions || null,
       b.likelihood || null, b.severity || null, freq, b.next_review_due || null, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'risk_assessment', entity_id: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e); }
});

// PATCH /:id
router.patch('/:id', requirePerm('clinical_write'), async (req, res) => {
  try {
    const b = req.body || {};
    const cols = ['category','title','hazard','who_at_risk','existing_controls','further_actions',
      'likelihood','severity','review_frequency_days','next_review_due','status']
      .filter(c => b[c] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'No editable fields supplied' });
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const { rows } = await getPool().query(
      `UPDATE risk_assessments SET ${sets}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map(c => b[c]), req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Risk assessment not found' });
    recordAudit({ req, action: 'update', entity_type: 'risk_assessment', entity_id: rows[0].id, meta: { fields: cols } });
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

module.exports = router;
