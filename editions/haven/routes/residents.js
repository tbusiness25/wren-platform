'use strict';
// Haven — residents register
const express = require('express');
const router = express.Router();
const { getPool } = require('../../../src/db/pool');
const authenticate = require('../../../src/middleware/auth');
const { requirePerm, fail } = require('../lib/permissions');
const { recordAudit } = require('../../../src/utils/audit');

router.use(authenticate);

const EDITABLE = [
  'first_name','last_name','preferred_name','date_of_birth','sex','nhs_number','room_number',
  'admission_date','discharge_date','is_active','photo','gp_name','gp_practice','gp_phone',
  'nok_name','nok_relationship','nok_phone','nok_email','nok_is_lpa','lpa_type',
  'care_level','dnacpr','dnacpr_reviewed_at','allergies','dietary_notes','mobility_notes',
  'communication_notes','life_history',
];

// GET / — active residents (?all=1 includes discharged)
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const where = req.query.all === '1' ? '' : 'WHERE r.is_active = true';
    const { rows } = await db.query(`
      SELECT r.id, r.first_name, r.last_name, r.preferred_name, r.date_of_birth, r.sex,
             r.room_number, r.care_level, r.admission_date, r.is_active, r.dnacpr, r.photo,
             date_part('year', age(r.date_of_birth))::int AS age,
             (SELECT count(*) FROM care_plans cp WHERE cp.resident_id = r.id AND cp.status='active')::int AS care_plan_count,
             (SELECT min(cp.next_review_due) FROM care_plans cp WHERE cp.resident_id = r.id AND cp.status='active') AS next_care_plan_review,
             (SELECT cs.band FROM clinical_scores cs WHERE cs.resident_id = r.id AND cs.tool='news2' ORDER BY cs.scored_at DESC LIMIT 1) AS latest_news2_band
      FROM residents r ${where}
      ORDER BY r.last_name, r.first_name`);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// GET /:id — full profile
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT r.*, date_part('year', age(r.date_of_birth))::int AS age,
              s.first_name AS created_by_first, s.last_name AS created_by_last
       FROM residents r LEFT JOIN staff s ON s.id = r.created_by
       WHERE r.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Resident not found' });
    recordAudit({ req, action: 'view', entity_type: 'resident', entity_id: rows[0].id });
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

// POST / — create resident
router.post('/', requirePerm('admin_write'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.first_name || !b.last_name || !b.date_of_birth) {
      return res.status(400).json({ error: 'first_name, last_name, date_of_birth required' });
    }
    const cols = EDITABLE.filter(c => b[c] !== undefined);
    const vals = cols.map(c => b[c]);
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO residents (${cols.join(',')}, created_by)
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}, $${cols.length + 1})
       RETURNING *`, [...vals, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'resident', entity_id: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e); }
});

// PATCH /:id — update
router.patch('/:id', requirePerm('admin_write'), async (req, res) => {
  try {
    const b = req.body || {};
    const cols = EDITABLE.filter(c => b[c] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'No editable fields supplied' });
    const db = getPool();
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const { rows } = await db.query(
      `UPDATE residents SET ${sets}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map(c => b[c]), req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Resident not found' });
    recordAudit({ req, action: 'update', entity_type: 'resident', entity_id: rows[0].id, meta: { fields: cols } });
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

module.exports = router;
