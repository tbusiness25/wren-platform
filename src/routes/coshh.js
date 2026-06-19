/**
 * coshh.js — COSHH (Control of Substances Hazardous to Health) register
 */

const express  = require('express');
const router   = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

function isManager(req) {
  return ['manager','deputy_manager','admin'].includes(req.user?.role);
}

router.get('/', async (req, res) => {
  const { category, active } = req.query;
  try {
    const db = getPool();
    const conds = [`is_active=${active === 'false' ? 'false' : 'true'}`];
    const params = [];
    let pi = 1;
    if (category) { conds.push(`category=$${pi++}`); params.push(category); }
    const { rows } = await db.query(`
      SELECT cr.*,
        s.first_name||' '||s.last_name as reviewed_by_name,
        cr.review_date < CURRENT_DATE as review_overdue,
        cr.review_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30 as review_due_soon
      FROM coshh_register cr
      LEFT JOIN staff s ON s.id=cr.reviewed_by
      WHERE ${conds.join(' AND ')}
      ORDER BY cr.substance_name
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM coshh_register WHERE id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  const {
    substance_name, trade_name, category, hazard_type=[],
    storage_location, max_quantity, supplier, sds_url,
    first_aid_response, disposal_method, ppe_required=[], ppe_notes, review_date,
  } = req.body;
  if (!substance_name) return res.status(400).json({ error: 'substance_name required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO coshh_register
        (substance_name, trade_name, category, hazard_type, storage_location,
         max_quantity, supplier, sds_url, first_aid_response, disposal_method,
         ppe_required, ppe_notes, review_date, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *
    `, [substance_name, trade_name||null, category||null, hazard_type,
        storage_location||null, max_quantity||null, supplier||null, sds_url||null,
        first_aid_response||null, disposal_method||null, ppe_required, ppe_notes||null,
        review_date||null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  const {
    substance_name, trade_name, category, hazard_type, storage_location,
    max_quantity, supplier, sds_url, first_aid_response, disposal_method,
    ppe_required, ppe_notes, review_date, is_active,
  } = req.body;
  try {
    const db = getPool();
    const updates = ['updated_at=NOW()'];
    const params = [];
    let pi = 1;
    const add = (col, val) => { if (val !== undefined) { updates.push(`${col}=$${pi++}`); params.push(val); }};
    add('substance_name', substance_name);
    add('trade_name', trade_name);
    add('category', category);
    add('hazard_type', hazard_type);
    add('storage_location', storage_location);
    add('max_quantity', max_quantity);
    add('supplier', supplier);
    add('sds_url', sds_url);
    add('first_aid_response', first_aid_response);
    add('disposal_method', disposal_method);
    add('ppe_required', ppe_required);
    add('ppe_notes', ppe_notes);
    add('review_date', review_date);
    add('is_active', is_active);
    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE coshh_register SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/review', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  const { next_review_date } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE coshh_register SET
        reviewed_by=$1, review_date=$2, updated_at=NOW()
      WHERE id=$3 RETURNING *
    `, [req.user.id, next_review_date||null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/expiring/list', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT *, review_date - CURRENT_DATE as days_until_review
      FROM coshh_register
      WHERE is_active=true
        AND review_date IS NOT NULL
        AND review_date <= CURRENT_DATE + ($1::int)
      ORDER BY review_date ASC
    `, [days]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
