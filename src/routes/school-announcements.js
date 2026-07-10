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
  const { audience, live } = req.query;
  try {
    let where = ['1=1'];
    const vals = [];
    if (audience) { vals.push(audience); where.push(`(sa.audience=$${vals.length} OR sa.audience='all')`); }
    if (live === 'true') {
      where.push(`sa.valid_from <= now() AND (sa.valid_until IS NULL OR sa.valid_until >= now())`);
    }
    const { rows } = await pool.query(
      `SELECT sa.*, CONCAT(st.first_name,' ',st.last_name) AS created_by_name
       FROM ${s}.school_announcements sa
       LEFT JOIN ${s}.staff st ON st.id=sa.created_by
       WHERE ${where.join(' AND ')} ORDER BY sa.urgency DESC, sa.valid_from DESC`, vals
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const s = schema();
  const { title, body, audience, urgency, valid_from, valid_until, created_by } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO ${s}.school_announcements (title,body,audience,urgency,valid_from,valid_until,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title, body, audience || 'all', urgency || 'normal', valid_from || 'now()', valid_until, created_by]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
