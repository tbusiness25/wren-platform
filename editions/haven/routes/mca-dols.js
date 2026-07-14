'use strict';
// Haven — Mental Capacity Act assessments + DoLS records
const express = require('express');
const router = express.Router();
const { getPool } = require('../../../src/db/pool');
const authenticate = require('../../../src/middleware/auth');
const { requirePerm, fail } = require('../lib/permissions');
const { recordAudit } = require('../../../src/utils/audit');

router.use(authenticate);

// GET /?resident_id=
router.get('/', async (req, res) => {
  try {
    const params = [];
    const where = ['1=1'];
    if (req.query.resident_id) { params.push(req.query.resident_id); where.push(`m.resident_id = $${params.length}`); }
    if (req.query.record_type) { params.push(req.query.record_type); where.push(`m.record_type = $${params.length}`); }
    const { rows } = await getPool().query(`
      SELECT m.*, r.first_name, r.last_name,
             (m.dols_expiry_date IS NOT NULL AND m.dols_expiry_date < CURRENT_DATE
              AND m.dols_status IN ('urgent_granted','standard_granted')) AS dols_expired,
             (m.review_due IS NOT NULL AND m.review_due < CURRENT_DATE) AS review_overdue
      FROM mca_dols m JOIN residents r ON r.id = m.resident_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.created_at DESC LIMIT 200`, params);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

const FIELDS = ['record_type','decision_subject','assessment_date','has_capacity',
  'best_interests_summary','consultees','dols_applied_date','dols_authority','dols_status',
  'dols_start_date','dols_expiry_date','dols_reference','conditions','review_due','notes'];

// POST /
router.post('/', requirePerm('senior_write'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.resident_id || !b.record_type) {
      return res.status(400).json({ error: 'resident_id, record_type required' });
    }
    const cols = FIELDS.filter(c => b[c] !== undefined);
    const { rows } = await getPool().query(
      `INSERT INTO mca_dols (resident_id, ${cols.join(',')}, created_by)
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(',')}, $${cols.length + 2}) RETURNING *`,
      [b.resident_id, ...cols.map(c => b[c]), req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'mca_dols', entity_id: rows[0].id,
      meta: { record_type: b.record_type } });
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e); }
});

// PATCH /:id
router.patch('/:id', requirePerm('senior_write'), async (req, res) => {
  try {
    const b = req.body || {};
    const cols = FIELDS.filter(c => b[c] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'No editable fields supplied' });
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const { rows } = await getPool().query(
      `UPDATE mca_dols SET ${sets}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map(c => b[c]), req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Record not found' });
    recordAudit({ req, action: 'update', entity_type: 'mca_dols', entity_id: rows[0].id, meta: { fields: cols } });
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

module.exports = router;
