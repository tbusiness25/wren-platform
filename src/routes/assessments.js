const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET / — list assessments
router.get('/', async (req, res) => {
  const { child_id, subject, period, limit = 200 } = req.query;
  try {
    const db = getPool();
    const conditions = [];
    const params = [];
    let pi = 1;
    if (child_id) { conditions.push(`a.child_id=$${pi++}`); params.push(parseInt(child_id)); }
    if (subject) { conditions.push(`a.subject=$${pi++}`); params.push(subject); }
    if (period) { conditions.push(`a.period=$${pi++}`); params.push(period); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await db.query(`
      SELECT a.*, c.first_name || ' ' || c.last_name as child_name,
        s.first_name || ' ' || s.last_name as staff_name
      FROM assessments a
      LEFT JOIN children c ON c.id = a.child_id
      LEFT JOIN staff s ON s.id = a.staff_id
      ${where}
      ORDER BY a.assessment_date DESC
      LIMIT $${pi}
    `, [...params, parseInt(limit)]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /overview — class overview grouped by subject
router.get('/overview', async (req, res) => {
  const { period } = req.query;
  try {
    const db = getPool();
    const params = period ? [period] : [];
    const where = period ? 'WHERE period=$1' : '';
    const { rows } = await db.query(`
      SELECT subject, attainment, COUNT(*) as count,
        AVG(attainment_value) as avg_value
      FROM assessments
      ${where}
      GROUP BY subject, attainment
      ORDER BY subject, attainment_value
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /
router.post('/', async (req, res) => {
  const { child_id, subject, assessment_date, period, attainment, attainment_value, progress, notes } = req.body;
  if (!child_id || !subject || !attainment) {
    return res.status(400).json({ error: 'child_id, subject and attainment required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO assessments (child_id,staff_id,subject,assessment_date,period,attainment,attainment_value,progress,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [child_id, req.user.id, subject,
        assessment_date||new Date().toISOString().split('T')[0],
        period||null, attainment, attainment_value||null, progress||null, notes||null]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
