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

const schema = () => process.env.PG_SCHEMA || 'demo_primary';

router.get('/', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(
      `SELECT t.*,
        (SELECT count(*)::int FROM ${s}.trip_signups ts WHERE ts.trip_id=t.id) AS signups,
        (SELECT count(*)::int FROM ${s}.trip_signups ts WHERE ts.trip_id=t.id AND ts.paid=true) AS paid_count
       FROM ${s}.school_trips t ORDER BY t.trip_date ASC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  const s = schema();
  try {
    const trip = await pool.query(`SELECT * FROM ${s}.school_trips WHERE id=$1`, [req.params.id]);
    if (!trip.rows.length) return res.status(404).json({ error: 'Not found' });
    const signups = await pool.query(
      `SELECT ts.*, CONCAT(ch.first_name,' ',ch.last_name) AS pupil_name FROM ${s}.trip_signups ts
       LEFT JOIN ${s}.children ch ON ch.id=ts.pupil_id
       WHERE ts.trip_id=$1 ORDER BY ch.last_name, ch.first_name`, [req.params.id]
    );
    res.json({ ...trip.rows[0], signups: signups.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/signup', async (req, res) => {
  const s = schema();
  const { pupil_id, parent_consent, dietary_notes, medical_notes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO ${s}.trip_signups (trip_id,pupil_id,parent_consent,dietary_notes,medical_notes)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`,
      [req.params.id, pupil_id, parent_consent || false, dietary_notes, medical_notes]
    );
    res.status(201).json(rows[0] || { already_signed_up: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
