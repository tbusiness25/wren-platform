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
const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday'];

router.get('/', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(
      `SELECT sc.*, CONCAT(st.first_name,' ',st.last_name) AS lead_teacher_name,
        (SELECT count(*)::int FROM ${s}.club_bookings cb WHERE cb.club_id=sc.id) AS booking_count
       FROM ${s}.school_clubs sc
       LEFT JOIN ${s}.staff st ON st.id=sc.lead_teacher_id
       WHERE sc.is_active=true ORDER BY sc.day_of_week, sc.start_time`
    );
    res.json(rows.map(r => ({ ...r, day_name: DAYS[r.day_of_week] })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/book', async (req, res) => {
  const s = schema();
  const { pupil_id, term_start, term_end, booked_by_parent_email } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO ${s}.club_bookings (club_id,pupil_id,term_start,term_end,booked_by_parent_email)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, pupil_id, term_start, term_end, booked_by_parent_email]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/book/:bookId', async (req, res) => {
  const s = schema();
  try {
    await pool.query(`DELETE FROM ${s}.club_bookings WHERE id=$1 AND club_id=$2`, [req.params.bookId, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
