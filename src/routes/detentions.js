const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER || 'wren',
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || 'wren',
});

const schema = () => process.env.PG_SCHEMA || 'demo_secondary';

router.get('/', async (req, res) => {
  const s = schema();
  const { pupil_id, served, date_from, date_to } = req.query;
  try {
    let where = ['1=1'];
    const vals = [];
    if (pupil_id)  { vals.push(pupil_id);  where.push(`d.pupil_id=$${vals.length}`); }
    if (served !== undefined) { vals.push(served === 'true'); where.push(`d.served=$${vals.length}`); }
    if (date_from) { vals.push(date_from);  where.push(`d.scheduled_date>=$${vals.length}`); }
    if (date_to)   { vals.push(date_to);    where.push(`d.scheduled_date<=$${vals.length}`); }
    const { rows } = await pool.query(
      `SELECT d.*, CONCAT(ch.first_name,' ',ch.last_name) AS pupil_name, CONCAT(st.first_name,' ',st.last_name) AS teacher_name
       FROM ${s}.detentions d
       LEFT JOIN ${s}.children ch ON ch.id=d.pupil_id
       LEFT JOIN ${s}.staff st ON st.id=d.set_by_teacher_id
       WHERE ${where.join(' AND ')} ORDER BY d.scheduled_date DESC, d.served`, vals
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const s = schema();
  const { pupil_id, set_by_teacher_id, reason, scheduled_date, duration_minutes, parent_notified } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO ${s}.detentions (pupil_id,set_by_teacher_id,reason,scheduled_date,duration_minutes,parent_notified)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [pupil_id, set_by_teacher_id, reason, scheduled_date, duration_minutes || 30, parent_notified || false]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/serve', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(
      `UPDATE ${s}.detentions SET served=true WHERE id=$1 RETURNING *`, [req.params.id]
    );
    res.json(rows[0] || { error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
