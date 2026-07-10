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
  const { pupil_id, subject_id, qualification, entry_year } = req.query;
  try {
    let where = ['1=1'];
    const vals = [];
    if (pupil_id)     { vals.push(pupil_id);     where.push(`ee.pupil_id=$${vals.length}`); }
    if (subject_id)   { vals.push(subject_id);   where.push(`ee.subject_id=$${vals.length}`); }
    if (qualification){ vals.push(qualification); where.push(`ee.qualification=$${vals.length}`); }
    if (entry_year)   { vals.push(entry_year);   where.push(`ee.entry_year=$${vals.length}`); }
    const { rows } = await pool.query(
      `SELECT ee.*, CONCAT(ch.first_name,' ',ch.last_name) AS pupil_name, subj.name AS subject_name
       FROM ${s}.exam_entries ee
       LEFT JOIN ${s}.children ch ON ch.id=ee.pupil_id
       LEFT JOIN ${s}.subjects subj ON subj.id=ee.subject_id
       WHERE ${where.join(' AND ')} ORDER BY ch.last_name, ch.first_name, subj.name`, vals
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Summary: grade distribution by subject
router.get('/summary', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(
      `SELECT subj.name AS subject_name, ee.qualification,
        COUNT(*) AS entries,
        COUNT(ee.predicted_grade) AS with_predicted,
        AVG(CASE WHEN ee.predicted_grade ~ '^[0-9]$' THEN ee.predicted_grade::int END) AS avg_predicted_num,
        json_object_agg(ee.mock_grade, mc) FILTER (WHERE ee.mock_grade IS NOT NULL) AS mock_distribution
       FROM ${s}.exam_entries ee
       JOIN ${s}.subjects subj ON subj.id=ee.subject_id
       CROSS JOIN LATERAL (SELECT COUNT(*) AS mc FROM ${s}.exam_entries e2
         WHERE e2.subject_id=ee.subject_id AND e2.mock_grade=ee.mock_grade) sub
       GROUP BY subj.name, ee.qualification ORDER BY subj.name`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id', async (req, res) => {
  const s = schema();
  const allowed = ['predicted_grade','target_grade','mock_grade','final_grade','tier'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE ${s}.exam_entries SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );
    res.json(rows[0] || { error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
