// Secondary school assessments — KS3/4/5 markbook + Progress 8
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET / — get assessments
router.get('/', async (req, res) => {
  const { child_id, class_group, term, subject, assessment_type, academic_year, key_stage } = req.query;
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
    if (key_stage) { conditions.push('c.key_stage=$'+pi++); params.push(key_stage); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await db.query(`
      SELECT a.*, c.first_name, c.last_name, c.year_group, c.class_group, c.key_stage,
             s.first_name||' '||s.last_name as assessed_by_name
      FROM assessments_secondary a
      JOIN children c ON c.id=a.child_id
      LEFT JOIN staff s ON s.id=a.assessed_by
      ${where}
      ORDER BY c.year_group, c.last_name, c.first_name, a.subject
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST / — record assessment
router.post('/', async (req, res) => {
  const { child_id, term, subject, grade, score, assessment_type, notes, academic_year } = req.body;
  if (!child_id || !subject) return res.status(400).json({ error: 'child_id, subject required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO assessments_secondary (child_id, academic_year, term, subject, grade, score, assessment_type, notes, assessed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [child_id, academic_year||'2025-2026', term, subject, grade||null, score||null, assessment_type||'formative', notes||null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id — update
router.put('/:id', async (req, res) => {
  const { grade, score, notes } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE assessments_secondary SET grade=COALESCE($1,grade), score=COALESCE($2,score), notes=COALESCE($3,notes) WHERE id=$4 RETURNING *',
      [grade, score, notes, req.params.id]
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /progress8 — Progress 8 calculator for a cohort
router.get('/progress8', async (req, res) => {
  const { academic_year, class_group } = req.query;
  const ay = academic_year || '2025-2026';
  try {
    const db = getPool();
    const params = [ay];
    let extra = class_group ? ' AND c.class_group=$2' : '';
    if (class_group) params.push(class_group);
    // Get GCSE grades (assessment_type = 'gcse')
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.class_group,
        json_object_agg(a.subject, a.grade) as grades
      FROM children c
      JOIN assessments_secondary a ON a.child_id=c.id AND a.academic_year=$1 AND a.assessment_type='gcse'
      WHERE c.is_active=true AND c.year_group='11'${extra}
      GROUP BY c.id, c.first_name, c.last_name, c.class_group
      ORDER BY c.last_name
    `, params);
    // Calculate Progress 8 score per pupil (simplified — grade points: A*=8,A=7,B=6,C=5,D=4,E=3,F=2,G=1, Num=direct)
    const gradePoints = { 'A*':8,'A':7,'B':6,'C':5,'D':4,'E':3,'F':2,'G':1,'U':0,'9':9,'8':8,'7':7,'6':6,'5':5,'4':4,'3':3,'2':2,'1':1 };
    const calc = rows.map(p => {
      const g = p.grades || {};
      const pt = s => gradePoints[s] || 0;
      const eng = Math.max(pt(g['English Language']), pt(g['English Literature']));
      const mat = pt(g['Maths']);
      const ebacc = ['Science','History','Geography','French','Spanish','German','Computer Science'].map(s => pt(g[s])).sort((a,b)=>b-a).slice(0,3);
      const open = Object.keys(g).filter(s => !['English Language','English Literature','Maths',...'Science,History,Geography,French,Spanish,German,Computer Science'.split(',')].includes(s)).map(s => pt(g[s])).sort((a,b)=>b-a).slice(0,3);
      const total = eng + (mat * 2) + ebacc.reduce((a,b)=>a+b,0) + open.reduce((a,b)=>a+b,0);
      const p8 = (total / 10).toFixed(2);
      return { ...p, p8_score: parseFloat(p8), total_points: total };
    });
    res.json(calc);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
