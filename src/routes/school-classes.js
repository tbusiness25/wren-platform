const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const authenticate = require('../middleware/auth');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER || 'wren',
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || 'wren',
});

const schema = () => process.env.PG_SCHEMA || 'demo_primary';

router.use(authenticate);

router.get('/', async (req, res) => {
  const s = schema();
  const { year_group, teacher_id, active } = req.query;
  try {
    let where = ['1=1'];
    const vals = [];
    if (year_group) { vals.push(year_group); where.push(`c.year_group=$${vals.length}`); }
    if (teacher_id) { vals.push(teacher_id); where.push(`c.teacher_id=$${vals.length}`); }
    if (active !== 'all') where.push('c.is_active=true');
    const { rows } = await pool.query(
      `SELECT c.*, CONCAT(st.first_name,' ',st.last_name) AS teacher_name,
        (SELECT count(*)::int FROM ${s}.children ch WHERE ch.class_id=c.id) AS actual_pupils
       FROM ${s}.classes c
       LEFT JOIN ${s}.staff st ON st.id=c.teacher_id
       WHERE ${where.join(' AND ')} ORDER BY c.year_group, c.name`, vals
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  const s = schema();
  try {
    const cls = await pool.query(
      `SELECT c.*, CONCAT(st.first_name,' ',st.last_name) AS teacher_name FROM ${s}.classes c
       LEFT JOIN ${s}.staff st ON st.id=c.teacher_id WHERE c.id=$1`, [req.params.id]
    );
    if (!cls.rows.length) return res.status(404).json({ error: 'Not found' });
    const pupils = await pool.query(
      `SELECT id, first_name, last_name, CONCAT(first_name,' ',last_name) AS name, date_of_birth AS dob, parent_1_email AS parent_email FROM ${s}.children
       WHERE class_id=$1 AND is_active=true ORDER BY last_name, first_name`, [req.params.id]
    );
    res.json({ ...cls.rows[0], pupils: pupils.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/timetable', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(
      `SELECT ts.*, CONCAT(st.first_name,' ',st.last_name) AS teacher_name FROM ${s}.timetable_slots ts
       LEFT JOIN ${s}.staff st ON st.id=ts.teacher_id
       WHERE ts.class_id=$1 ORDER BY ts.day_of_week, ts.period`, [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
