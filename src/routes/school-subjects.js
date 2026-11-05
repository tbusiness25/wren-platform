const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
// b264: connection details come from src/db/connection.js. This file used to read
// process.env.PG_DATABASE, which NO container sets — every container sets PG_DB — so it
// silently connected to the literal default `wren` (production) whatever the process was
// configured with. resolveConnection() reads PG_DB first and keeps PG_DATABASE as a
// fallback, so behaviour is unchanged wherever PG_DB is already `wren`.
const { resolveConnection } = require('../db/connection');

const pool = new Pool({ ...resolveConnection() });

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
