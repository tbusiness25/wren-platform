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
  const { key_stage, area } = req.query;
  try {
    let where = ['1=1'];
    const vals = [];
    if (key_stage) { vals.push(parseInt(key_stage)); where.push(`$${vals.length}=ANY(key_stages)`); }
    if (area)      { vals.push(area); where.push(`curriculum_area=$${vals.length}`); }
    const { rows } = await pool.query(
      `SELECT * FROM ${s}.subjects WHERE ${where.join(' AND ')} ORDER BY curriculum_area, name`, vals
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
