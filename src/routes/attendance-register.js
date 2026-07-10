// AM/PM attendance register for Primary/Secondary schools
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET / — today's register for a class
router.get('/', async (req, res) => {
  const { date, class_group } = req.query;
  const d = date || new Date().toISOString().slice(0,10);
  try {
    const db = getPool();
    let where = 'WHERE c.is_active=true';
    const params = [d, d];
    if (class_group) { where += ' AND c.class_group=$3'; params.push(class_group); }
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.year_group, c.class_group,
        c.pupil_premium, c.key_stage,
        am.code as am_code, am.notes as am_notes,
        pm.code as pm_code, pm.notes as pm_notes
      FROM children c
      LEFT JOIN attendance_register am ON am.child_id=c.id AND am.date=$1 AND am.session='am'
      LEFT JOIN attendance_register pm ON pm.child_id=c.id AND pm.date=$2 AND pm.session='pm'
      ${where}
      ORDER BY c.year_group, c.class_group, c.last_name, c.first_name
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /week — week view for class
router.get('/week', async (req, res) => {
  const { week_start, class_group } = req.query;
  if (!week_start) return res.status(400).json({ error: 'week_start required' });
  try {
    const db = getPool();
    const params = [week_start];
    let where = 'WHERE ar.date >= $1 AND ar.date < $1::date + INTERVAL \'5 days\'';
    if (class_group) { where += ' AND c.class_group=$2'; params.push(class_group); }
    const { rows } = await db.query(`
      SELECT ar.*, c.first_name, c.last_name, c.class_group, c.year_group
      FROM attendance_register ar
      JOIN children c ON c.id=ar.child_id
      ${where}
      ORDER BY ar.date, c.last_name
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST / — record/update a mark
router.post('/', async (req, res) => {
  const { child_id, date, session, code, notes } = req.body;
  if (!child_id || !date || !session || !code) return res.status(400).json({ error: 'child_id, date, session, code required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO attendance_register (child_id, date, session, code, notes, recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (child_id, date, session) DO UPDATE SET code=$4, notes=$5, recorded_by=$6
      RETURNING *
    `, [child_id, date, session, code, notes||null, req.user.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /stats — attendance percentage stats
router.get('/stats', async (req, res) => {
  const { class_group, from, to } = req.query;
  try {
    const db = getPool();
    const f = from || new Date(new Date().getFullYear(), 8, 1).toISOString().slice(0,10);
    const t = to || new Date().toISOString().slice(0,10);
    const params = [f, t];
    let where = 'WHERE ar.date>=$1 AND ar.date<=$2';
    if (class_group) { where += ' AND c.class_group=$3'; params.push(class_group); }
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.class_group, c.year_group,
        COUNT(*) FILTER (WHERE ar.code='/') as present_count,
        COUNT(*) FILTER (WHERE ar.code NOT IN ('/','/')) as absent_count,
        COUNT(*) as total_marks,
        ROUND(COUNT(*) FILTER (WHERE ar.code='/')::numeric / NULLIF(COUNT(*),0) * 100, 1) as pct
      FROM attendance_register ar
      JOIN children c ON c.id=ar.child_id
      ${where}
      GROUP BY c.id, c.first_name, c.last_name, c.class_group, c.year_group
      ORDER BY pct ASC
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
