'use strict';
// Primary-schema exclusions route — uses start_date / exclusion_type columns
const express   = require('express');
const router    = express.Router();
const { getPool }   = require('../db/pool');
const authenticate  = require('../middleware/auth');

router.use(authenticate);

router.get('/', async (req, res) => {
  const { child_id, exclusion_type, from, to } = req.query;
  try {
    const db = getPool();
    const params = [], conds = [];
    let pi = 1;
    if (child_id)       { conds.push(`e.child_id=$${pi++}`);       params.push(parseInt(child_id)); }
    if (exclusion_type) { conds.push(`e.exclusion_type=$${pi++}`); params.push(exclusion_type); }
    if (from)           { conds.push(`e.start_date>=$${pi++}`);    params.push(from); }
    if (to)             { conds.push(`e.start_date<=$${pi++}`);    params.push(to); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await db.query(`
      SELECT e.*, c.first_name, c.last_name, c.class_group, c.year_group
      FROM exclusions e
      JOIN children c ON c.id = e.child_id
      ${where}
      ORDER BY e.start_date DESC
      LIMIT 500
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const { child_id, exclusion_type, start_date, end_date, days_excluded, reason, notes, reintegration_plan } = req.body;
  if (!child_id || !start_date) return res.status(400).json({ error: 'child_id and start_date required' });
  try {
    const db = getPool();
    await db.query(`
      ALTER TABLE exclusions ADD COLUMN IF NOT EXISTS days_excluded NUMERIC(3,1);
      ALTER TABLE exclusions ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE exclusions ADD COLUMN IF NOT EXISTS reintegration_plan TEXT;
      ALTER TABLE exclusions ADD COLUMN IF NOT EXISTS logged_by INTEGER;
    `).catch(() => {});
    const { rows } = await db.query(`
      INSERT INTO exclusions (child_id, exclusion_type, start_date, end_date, days_excluded, reason, notes, reintegration_plan, logged_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [child_id, exclusion_type||'fixed', start_date, end_date||null, days_excluded||null, reason||null, notes||null, reintegration_plan||null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
