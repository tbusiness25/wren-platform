'use strict';
// Secondary student portal API — read-mostly, student auth via username + PIN
const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const schema = () => process.env.PG_SCHEMA || 'demo_secondary';

// ── Student JWT auth middleware ────────────────────────────────────────────
function studentAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthenticated' });
  try {
    req.student = jwt.verify(token, process.env.JWT_SECRET);
    if (req.student.type !== 'student') throw new Error('Not a student token');
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// ── POST /student-login ────────────────────────────────────────────────────
router.post('/student-login', async (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ error: 'username and pin required' });
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT spa.*, c.first_name, c.last_name, c.year_group, c.form_group, c.class_group, c.key_stage
       FROM ${s}.student_portal_access spa
       JOIN ${s}.children c ON c.id = spa.child_id
       WHERE spa.username = $1 AND spa.is_active = true
       LIMIT 1`,
      [username.toLowerCase().trim()]
    );
    const stu = rows[0];
    if (!stu) return res.status(401).json({ error: 'Invalid username or PIN' });

    // Demo mode: accept pin 1234 with any hash, or bcrypt verify
    let valid = false;
    if (process.env.DEMO_MODE === 'true' && pin === '1234') {
      valid = true;
    } else if (stu.pin_hash) {
      valid = await bcrypt.compare(pin, stu.pin_hash);
    }
    if (!valid) return res.status(401).json({ error: 'Invalid username or PIN' });

    await db.query(`UPDATE ${s}.student_portal_access SET last_login=NOW() WHERE id=$1`, [stu.id]);

    const token = jwt.sign(
      { id: stu.id, child_id: stu.child_id, username: stu.username, type: 'student',
        first_name: stu.first_name, last_name: stu.last_name,
        year_group: stu.year_group, form_group: stu.form_group },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({ token, student: {
      id: stu.id, child_id: stu.child_id, username: stu.username,
      first_name: stu.first_name, last_name: stu.last_name,
      year_group: stu.year_group, form_group: stu.form_group, key_stage: stu.key_stage
    }});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /student/me ────────────────────────────────────────────────────────
router.get('/student/me', studentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT c.*, attsum.sessions_possible, attsum.sessions_attended, attsum.pa_flag
       FROM ${s}.children c
       LEFT JOIN ${s}.attendance_summary attsum ON attsum.child_id=c.id
       WHERE c.id=$1`, [req.student.child_id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const att = rows[0].sessions_possible > 0
      ? Math.round(rows[0].sessions_attended / rows[0].sessions_possible * 100)
      : null;
    res.json({ ...rows[0], attendance_pct: att });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /student/timetable — today and week for this student's classes ────
router.get('/student/timetable', studentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT c.id, c.first_name, c.last_name, c.year_group, c.form_group, c.class_group FROM ${s}.children c WHERE c.id=$1`,
      [req.student.child_id]);
    const pupil = rows[0];
    if (!pupil) return res.status(404).json({ error: 'Not found' });

    // Match form group exactly, plus all subject classes in the same year group
    const yrNum = (pupil.year_group || '').replace('Year ', '').trim();
    const { rows: slots } = await db.query(
      `SELECT ts.*, cl.name as class_name, cl.code as class_code,
              st.first_name||' '||st.last_name as teacher_name
       FROM ${s}.timetable_slots ts
       JOIN ${s}.classes cl ON cl.id = ts.class_id
       LEFT JOIN ${s}.staff st ON st.id = ts.teacher_id
       WHERE (cl.code = $1 OR cl.year_group::text = $2)
         AND ts.period BETWEEN 1 AND 8
       ORDER BY ts.day_of_week, ts.period`,
      [pupil.form_group || pupil.class_group || '', yrNum]
    );

    const { rows: periods } = await db.query(
      `SELECT * FROM ${s}.timetable_periods ORDER BY day_of_week, period_num`
    );

    res.json({ timetable: slots, periods, pupil });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /student/homework ──────────────────────────────────────────────────
router.get('/student/homework', studentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows: pupil } = await db.query(
      `SELECT year_group, class_group, form_group FROM ${s}.children WHERE id=$1`, [req.student.child_id]);
    if (!pupil[0]) return res.status(404).json({ error: 'Not found' });

    const p = pupil[0];
    const { rows: hw } = await db.query(
      `SELECT h.*,
              cl.name as class_name, cl.code as class_code, cl.year_group as hw_year,
              st.first_name||' '||st.last_name as teacher_name,
              sub.submitted_at, sub.grade, sub.teacher_feedback
       FROM ${s}.homework h
       JOIN ${s}.classes cl ON cl.id = h.class_id
       LEFT JOIN ${s}.staff st ON st.id = h.set_by_teacher_id
       LEFT JOIN ${s}.homework_submissions sub ON sub.homework_id=h.id AND sub.pupil_id=$1
       WHERE h.is_published = true
         AND cl.year_group::text = $2
       ORDER BY h.due_date ASC`,
      [req.student.child_id, p.year_group?.replace('Year ', '') || '']
    );
    res.json(hw);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /student/homework/:id/submit ─────────────────────────────────────
router.post('/student/homework/:id/submit', studentAuth, async (req, res) => {
  const { content } = req.body;
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `INSERT INTO ${s}.homework_submissions (homework_id, pupil_id, submitted_at, content)
       VALUES ($1,$2,NOW(),$3)
       ON CONFLICT (homework_id, pupil_id) DO UPDATE SET submitted_at=NOW(), content=EXCLUDED.content
       RETURNING *`,
      [req.params.id, req.student.child_id, content || '']
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /student/attendance ────────────────────────────────────────────────
router.get('/student/attendance', studentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT att.*, attsum.sessions_possible, attsum.sessions_attended, attsum.pa_flag
       FROM ${s}.children att
       LEFT JOIN ${s}.attendance_summary attsum ON attsum.child_id=att.id
       WHERE att.id=$1`, [req.student.child_id]);
    const pupil = rows[0] || {};
    const pct = pupil.sessions_possible > 0
      ? Math.round(pupil.sessions_attended / pupil.sessions_possible * 100) : null;

    const { rows: records } = await db.query(
      `SELECT * FROM ${s}.attendance WHERE child_id=$1 ORDER BY date DESC LIMIT 30`,
      [req.student.child_id]
    ).catch(() => ({ rows: [] }));

    res.json({
      summary: { sessions_possible: pupil.sessions_possible, sessions_attended: pupil.sessions_attended, pct, pa_flag: pupil.pa_flag },
      records
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /student/behaviour ─────────────────────────────────────────────────
router.get('/student/behaviour', studentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT b.*, s.first_name||' '||s.last_name as staff_name
       FROM ${s}.behaviour_log b
       LEFT JOIN ${s}.staff s ON s.id=b.staff_id
       WHERE b.child_id=$1
       ORDER BY b.log_date DESC, b.created_at DESC`,
      [req.student.child_id]
    );
    const positive = rows.filter(r=>r.behaviour_type==='positive');
    const negative = rows.filter(r=>r.behaviour_type!=='positive');
    const totalPoints = rows.reduce((sum,r)=>(r.points>0?sum+r.points:sum),0);
    res.json({ events: rows, positive_count: positive.length, negative_count: negative.length, total_positive_points: totalPoints });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /student/assessments ───────────────────────────────────────────────
router.get('/student/assessments', studentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT a.*, st.first_name||' '||st.last_name as teacher_name
       FROM ${s}.assessments_secondary a
       LEFT JOIN ${s}.staff st ON st.id=a.assessed_by
       WHERE a.child_id=$1
       ORDER BY a.term, a.subject`,
      [req.student.child_id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /student/classroom — mock Google Classroom data ───────────────────
router.get('/student/classroom', studentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows: settings } = await db.query(
      `SELECT gc_enabled FROM ${s}.classroom_settings WHERE id=1 LIMIT 1`
    ).catch(() => ({ rows: [] }));

    if (!settings[0]?.gc_enabled) {
      return res.json({ enabled: false, message: 'Google Classroom not connected. Ask your IT lead to set up in Classroom Settings.' });
    }
    // In production: fetch from Google Classroom API using stored token
    res.json({ enabled: true, courses: [], assignments: [] });
  } catch(e) { res.json({ enabled: false, error: e.message }); }
});

// ── GET /student/wren-points ───────────────────────────────────────────────
router.get('/student/wren-points', studentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT wa.*, wc.name as category_name, wc.icon, st.first_name||' '||st.last_name as awarded_by_name
       FROM ${s}.wp_awards wa
       JOIN ${s}.wp_categories wc ON wc.id=wa.category_id
       LEFT JOIN ${s}.staff st ON st.id=wa.awarded_by_staff_id
       WHERE wa.child_id=$1
       ORDER BY wa.awarded_at DESC`,
      [req.student.child_id]
    );
    const total = rows.reduce((sum,r)=>sum+(r.value||0),0);
    res.json({ awards: rows, total_points: total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Destinations (admin-facing, also used by destinations.html) ────────────
router.get('/destinations', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT pd.*, c.first_name, c.last_name, c.year_group, c.form_group
       FROM ${s}.pupil_destinations pd
       JOIN ${s}.children c ON c.id=pd.child_id
       ORDER BY c.last_name, c.first_name`
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/destinations', authenticate, async (req, res) => {
  const { child_id, destination, institution, notes } = req.body;
  if (!child_id || !destination) return res.status(400).json({ error: 'child_id, destination required' });
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `INSERT INTO ${s}.pupil_destinations (child_id, year_group, destination, institution, notes)
       SELECT $1, c.year_group, $2, $3, $4 FROM ${s}.children c WHERE c.id=$1
       RETURNING *`,
      [child_id, destination, institution||null, notes||null]
    );
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/destinations/:id', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    await db.query(`DELETE FROM ${s}.pupil_destinations WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Option choices ─────────────────────────────────────────────────────────
router.get('/option-choices', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT poc.*, c.first_name, c.last_name, c.year_group
       FROM ${s}.pupil_option_choices poc
       JOIN ${s}.children c ON c.id=poc.child_id
       ORDER BY c.last_name, c.first_name, poc.block`
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/option-choices', authenticate, async (req, res) => {
  const { child_id, block, subject, confirmed } = req.body;
  if (!child_id || !block || !subject) return res.status(400).json({ error: 'child_id, block, subject required' });
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `INSERT INTO ${s}.pupil_option_choices (child_id, block, subject, confirmed)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [child_id, block, subject, confirmed||false]
    );
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/option-choices/:id', authenticate, async (req, res) => {
  const { confirmed } = req.body;
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `UPDATE ${s}.pupil_option_choices SET confirmed=$1 WHERE id=$2 RETURNING *`,
      [confirmed, req.params.id]
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/option-choices/:id', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    await db.query(`DELETE FROM ${s}.pupil_option_choices WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
