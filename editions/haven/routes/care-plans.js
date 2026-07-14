'use strict';
// Haven — care plans with review cycles
const express = require('express');
const router = express.Router();
const { getPool } = require('../../../src/db/pool');
const authenticate = require('../../../src/middleware/auth');
const { requirePerm, fail } = require('../lib/permissions');
const { recordAudit } = require('../../../src/utils/audit');

router.use(authenticate);

// GET /?resident_id=&status=  — list (default: active)
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const params = [];
    const where = [];
    if (req.query.resident_id) { params.push(req.query.resident_id); where.push(`cp.resident_id = $${params.length}`); }
    params.push(req.query.status || 'active'); where.push(`cp.status = $${params.length}`);
    const { rows } = await db.query(`
      SELECT cp.*, r.first_name, r.last_name,
             s.first_name AS created_by_first, s.last_name AS created_by_last,
             (SELECT count(*) FROM care_plan_reviews cr WHERE cr.care_plan_id = cp.id)::int AS review_count,
             (SELECT max(cr.review_date) FROM care_plan_reviews cr WHERE cr.care_plan_id = cp.id) AS last_reviewed,
             (cp.next_review_due IS NOT NULL AND cp.next_review_due < CURRENT_DATE) AS review_overdue
      FROM care_plans cp
      JOIN residents r ON r.id = cp.resident_id
      LEFT JOIN staff s ON s.id = cp.created_by
      WHERE ${where.join(' AND ')}
      ORDER BY cp.next_review_due NULLS LAST, cp.id`, params);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// GET /due — plans overdue or due within 14 days
router.get('/due', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT cp.id, cp.title, cp.category, cp.next_review_due, r.id AS resident_id,
             r.first_name, r.last_name,
             (cp.next_review_due < CURRENT_DATE) AS overdue
      FROM care_plans cp JOIN residents r ON r.id = cp.resident_id
      WHERE cp.status='active' AND cp.next_review_due <= CURRENT_DATE + 14
      ORDER BY cp.next_review_due`);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// GET /:id — one plan + its reviews
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT cp.*, r.first_name, r.last_name FROM care_plans cp
       JOIN residents r ON r.id = cp.resident_id WHERE cp.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Care plan not found' });
    const { rows: reviews } = await db.query(
      `SELECT cr.*, s.first_name AS reviewer_first, s.last_name AS reviewer_last
       FROM care_plan_reviews cr LEFT JOIN staff s ON s.id = cr.reviewed_by
       WHERE cr.care_plan_id = $1 ORDER BY cr.review_date DESC, cr.id DESC`, [req.params.id]);
    res.json({ ...rows[0], reviews });
  } catch (e) { fail(res, e); }
});

// POST / — create plan
router.post('/', requirePerm('clinical_write'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.resident_id || !b.category || !b.title) {
      return res.status(400).json({ error: 'resident_id, category, title required' });
    }
    const freq = parseInt(b.review_frequency_days || 30, 10);
    const { rows } = await getPool().query(
      `INSERT INTO care_plans (resident_id, category, title, need, goal, interventions,
         resident_involvement, review_frequency_days, next_review_due, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::int, COALESCE($9::date, CURRENT_DATE + $8::int), $10)
       RETURNING *`,
      [b.resident_id, b.category, b.title, b.need || null, b.goal || null,
       b.interventions || null, b.resident_involvement || null, freq,
       b.next_review_due || null, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'care_plan', entity_id: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e); }
});

// PATCH /:id — update plan content/status
router.patch('/:id', requirePerm('clinical_write'), async (req, res) => {
  try {
    const b = req.body || {};
    const cols = ['category','title','need','goal','interventions','resident_involvement',
      'review_frequency_days','next_review_due','status'].filter(c => b[c] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'No editable fields supplied' });
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const { rows } = await getPool().query(
      `UPDATE care_plans SET ${sets}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map(c => b[c]), req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Care plan not found' });
    recordAudit({ req, action: 'update', entity_type: 'care_plan', entity_id: rows[0].id, meta: { fields: cols } });
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

// POST /:id/reviews — record a review; rolls next_review_due forward
router.post('/:id/reviews', requirePerm('clinical_write'), async (req, res) => {
  const db = getPool();
  const client = await db.connect();
  try {
    const b = req.body || {};
    if (!['no_change','updated','superseded','archived'].includes(b.outcome)) {
      return res.status(400).json({ error: 'outcome must be no_change|updated|superseded|archived' });
    }
    await client.query('BEGIN');
    const { rows: planRows } = await client.query('SELECT * FROM care_plans WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!planRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Care plan not found' }); }
    const plan = planRows[0];
    const nextDue = b.next_review_due
      || (['no_change','updated'].includes(b.outcome)
          ? new Date(Date.now() + (plan.review_frequency_days || 30) * 86400000).toISOString().slice(0, 10)
          : null);
    const { rows } = await client.query(
      `INSERT INTO care_plan_reviews (care_plan_id, review_date, outcome, notes,
         resident_or_family_involved, next_review_due, reviewed_by)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7) RETURNING *`,
      [plan.id, b.review_date || null, b.outcome, b.notes || null,
       !!b.resident_or_family_involved, nextDue, req.user.id]);
    const newStatus = b.outcome === 'superseded' ? 'superseded' : b.outcome === 'archived' ? 'archived' : plan.status;
    await client.query(
      'UPDATE care_plans SET next_review_due = $1, status = $2, updated_at = now() WHERE id = $3',
      [nextDue, newStatus, plan.id]);
    await client.query('COMMIT');
    recordAudit({ req, action: 'create', entity_type: 'care_plan_review', entity_id: rows[0].id, meta: { care_plan_id: plan.id, outcome: b.outcome } });
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, e);
  } finally { client.release(); }
});

module.exports = router;
