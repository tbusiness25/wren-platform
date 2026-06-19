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

const SOURCE_FAVICONS = {
  twinkl: 'https://www.twinkl.co.uk/favicon.ico',
  bbc_bitesize: 'https://www.bbc.co.uk/favicon.ico',
  oak_national: 'https://www.thenational.academy/favicon.ico',
  bug_club: 'https://www.mymaths.co.uk/favicon.ico',
  white_rose: 'https://whiteroseeducation.com/favicon.ico',
  internal: null,
};

router.get('/', async (req, res) => {
  const s = schema();
  const { subject_id, year_group, key_stage, type, source, search, teacher_id } = req.query;
  try {
    let where = ['1=1'];
    const vals = [];
    if (subject_id) { vals.push(subject_id); where.push(`tr.subject_id=$${vals.length}`); }
    if (year_group) { vals.push(year_group); where.push(`tr.year_group=$${vals.length}`); }
    if (key_stage)  { vals.push(key_stage);  where.push(`tr.key_stage=$${vals.length}`); }
    if (type)       { vals.push(type);        where.push(`tr.type=$${vals.length}`); }
    if (source)     { vals.push(source);      where.push(`tr.source=$${vals.length}`); }
    if (search)     { vals.push(`%${search.toLowerCase()}%`); where.push(`lower(tr.title) LIKE $${vals.length}`); }
    const { rows } = await pool.query(
      `SELECT tr.*, subj.name AS subject_name
       FROM ${s}.teaching_resources tr
       LEFT JOIN ${s}.subjects subj ON subj.id=tr.subject_id
       WHERE ${where.join(' AND ')} ORDER BY tr.subject_id, tr.year_group, tr.title`, vals
    );
    res.json(rows.map(r => ({ ...r, favicon: SOURCE_FAVICONS[r.source] || null })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sources', (req, res) => {
  res.json(Object.keys(SOURCE_FAVICONS).map(k => ({ key: k, favicon: SOURCE_FAVICONS[k] })));
});

router.post('/', async (req, res) => {
  const s = schema();
  const { subject_id, year_group, key_stage, title, description, type, source, url, tags, created_by } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO ${s}.teaching_resources (subject_id,year_group,key_stage,title,description,type,source,url,tags,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [subject_id, year_group, key_stage, title, description, type, source, url, tags || [], created_by]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark resource as used by a teacher
router.post('/:id/use', async (req, res) => {
  const s = schema();
  const { teacher_id } = req.body;
  try {
    await pool.query(
      `UPDATE ${s}.teaching_resources
       SET used_by_teacher_ids = array_append(used_by_teacher_ids, $1)
       WHERE id=$2 AND NOT ($1=ANY(coalesce(used_by_teacher_ids,'{}')))`,
      [teacher_id, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
