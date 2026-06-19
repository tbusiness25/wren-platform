const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');

router.use(authenticate);

// GET / — list CPD records (own by default, all if manager)
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const isManager = ['manager','deputy_manager','admin'].includes(req.user.role);
    const staffFilter = isManager && req.query.staff_id
      ? parseInt(req.query.staff_id)
      : isManager ? null : req.user.id;

    let where = staffFilter ? 'WHERE cr.staff_id=$1' : '';
    const params = staffFilter ? [staffFilter] : [];

    const { rows } = await db.query(`
      SELECT cr.*, s.first_name || ' ' || s.last_name as staff_name
      FROM cpd_records cr
      LEFT JOIN staff s ON s.id = cr.staff_id
      ${where}
      ORDER BY cr.completion_date DESC NULLS LAST
      LIMIT 200
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /summary — per-staff CPD summary
router.get('/summary', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT s.id, s.first_name || ' ' || s.last_name as name, s.role,
        COUNT(cr.id) as total_courses,
        SUM(cr.hours) as total_hours,
        COUNT(cr.id) FILTER (WHERE cr.expiry_date < CURRENT_DATE) as expired_count,
        COUNT(cr.id) FILTER (WHERE cr.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 60) as expiring_soon
      FROM staff s
      LEFT JOIN cpd_records cr ON cr.staff_id = s.id
      WHERE s.is_active = true
      GROUP BY s.id, s.first_name, s.last_name, s.role
      ORDER BY s.last_name
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /
router.post('/', async (req, res) => {
  const { staff_id, course_name, provider, completion_date, expiry_date, is_mandatory, hours, notes } = req.body;
  if (!course_name) return res.status(400).json({ error: 'course_name required' });
  const targetStaff = staff_id || req.user.id;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO cpd_records (staff_id,course_name,provider,completion_date,expiry_date,is_mandatory,hours,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [targetStaff, course_name, provider||null, completion_date||null,
        expiry_date||null, is_mandatory||false, hours||null, notes||null]);
    notify('course_completed', 'staff', targetStaff,
      `CPD recorded: ${course_name}`,
      `${provider ? provider + ' — ' : ''}${completion_date || 'no date'}${hours ? ', ' + hours + 'h' : ''}`,
      { relatedTable: 'cpd_records', relatedId: rows[0].id }
    );
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id
router.put('/:id', async (req, res) => {
  const { course_name, provider, completion_date, expiry_date, is_mandatory, hours, notes } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE cpd_records SET
        course_name=COALESCE($1,course_name),
        provider=COALESCE($2,provider),
        completion_date=COALESCE($3,completion_date),
        expiry_date=COALESCE($4,expiry_date),
        is_mandatory=COALESCE($5,is_mandatory),
        hours=COALESCE($6,hours),
        notes=COALESCE($7,notes)
      WHERE id=$8 RETURNING *
    `, [course_name, provider, completion_date, expiry_date, is_mandatory, hours, notes, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    const db = getPool();
    await db.query('DELETE FROM cpd_records WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MANDATORY TRAINING ────────────────────────────────────

// GET /mandatory — all mandatory training (manager: all staff; staff: own)
router.get('/mandatory', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  try {
    const db = getPool();
    let q, p;
    if (isManager) {
      q = `SELECT mt.*, s.first_name || ' ' || s.last_name as staff_name, s.role
           FROM mandatory_training mt
           JOIN staff s ON s.id = mt.staff_id
           WHERE s.is_active=true
           ORDER BY s.last_name, mt.training_type`;
      p = [];
    } else {
      q = `SELECT * FROM mandatory_training WHERE staff_id=$1 ORDER BY training_type`;
      p = [req.user.id];
    }
    const { rows } = await db.query(q, p);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /mandatory/:id — update completion/expiry
router.put('/mandatory/:id', async (req, res) => {
  const { completed_date, expiry_date, provider, certificate_url } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE mandatory_training
      SET completed_date=$1, expiry_date=$2, provider=$3, certificate_url=$4
      WHERE id=$5 RETURNING *
    `, [completed_date||null, expiry_date||null, provider||null, certificate_url||null, req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /mandatory — add new mandatory training record
router.post('/mandatory', async (req, res) => {
  const { staff_id, training_type, completed_date, expiry_date, provider } = req.body;
  if (!training_type) return res.status(400).json({ error: 'training_type required' });
  const targetStaff = staff_id || req.user.id;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO mandatory_training (staff_id, training_type, completed_date, expiry_date, provider)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (staff_id, training_type) DO UPDATE SET
        completed_date=EXCLUDED.completed_date, expiry_date=EXCLUDED.expiry_date,
        provider=EXCLUDED.provider
      RETURNING *
    `, [targetStaff, training_type, completed_date||null, expiry_date||null, provider||null]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id/quiz — save quiz score
router.put('/:id/quiz', async (req, res) => {
  const { quiz_score } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE cpd_records SET quiz_score=$1, quiz_completed_at=NOW()
      WHERE id=$2 RETURNING *
    `, [quiz_score, req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
