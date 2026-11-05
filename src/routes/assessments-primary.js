// Primary school assessment markbook
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET / — get assessments (filtered)
router.get('/', async (req, res) => {
  const { child_id, class_group, term, subject, assessment_type, academic_year } = req.query;
  try {
    const db = getPool();
    const params = [];
    const conditions = [];
    let pi = 1;
    if (child_id) { conditions.push('a.child_id=$'+pi++); params.push(parseInt(child_id)); }
    if (term) { conditions.push('a.term=$'+pi++); params.push(term); }
    if (subject) { conditions.push('a.subject=$'+pi++); params.push(subject); }
    if (assessment_type) { conditions.push('a.assessment_type=$'+pi++); params.push(assessment_type); }
    if (academic_year) { conditions.push('a.academic_year=$'+pi++); params.push(academic_year); }
    if (class_group) { conditions.push('c.class_group=$'+pi++); params.push(class_group); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await db.query(`
      SELECT a.*, c.first_name, c.last_name, c.year_group, c.class_group,
             s.first_name||' '||s.last_name as assessed_by_name
      FROM assessments_primary a
      JOIN children c ON c.id=a.child_id
      LEFT JOIN staff s ON s.id=a.assessed_by
      ${where}
      ORDER BY c.last_name, c.first_name, a.subject
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST / — record assessment
router.post('/', async (req, res) => {
  const { child_id, term, subject, grade, assessment_type, notes, academic_year } = req.body;
  if (!child_id || !subject || !grade) return res.status(400).json({ error: 'child_id, subject, grade required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO assessments_primary (child_id, academic_year, term, subject, grade, assessment_type, notes, assessed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [child_id, academic_year||'2025-2026', term, subject, grade, assessment_type||'formative', notes||null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id — update assessment
router.put('/:id', async (req, res) => {
  const { grade, notes } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE assessments_primary SET grade=COALESCE($1,grade), notes=COALESCE($2,notes) WHERE id=$3 RETURNING *',
      [grade, notes, req.params.id]
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
