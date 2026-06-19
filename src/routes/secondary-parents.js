'use strict';
// Secondary parent portal API — email/password + OTP auth, read-only child data
const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { getPool } = require('../db/pool');
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({ windowMs:60000, max:10, standardHeaders:true, legacyHeaders:false });
const schema = () => process.env.PG_SCHEMA || 'demo_secondary';

// ── Parent JWT middleware ──────────────────────────────────────────────────
function parentAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthenticated' });
  try {
    req.parent = jwt.verify(token, process.env.JWT_SECRET);
    if (req.parent.type !== 'secondary_parent') throw new Error('Not a parent token');
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

function makeToken(par) {
  return jwt.sign(
    { id: par.id, email: par.email, child_id: par.child_id, type: 'secondary_parent',
      first_name: par.first_name || 'Parent' },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

// ── POST /parent-login ────────────────────────────────────────────────────
router.post('/parent-login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT pa.*, c.first_name as child_first, c.last_name as child_last, c.year_group
       FROM ${schema()}.parent_portal_access pa
       LEFT JOIN ${schema()}.children c ON c.id = pa.child_id
       WHERE pa.email = $1 AND pa.is_active = true LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    const par = rows[0];
    if (!par) return res.status(401).json({ error: 'Invalid email or password' });

    let valid = false;
    if (!par.password_hash) {
      if (process.env.DEMO_MODE === 'true' && (password === 'demo1234' || password === '1234'))
        valid = true;
    } else {
      valid = await bcrypt.compare(password, par.password_hash);
    }
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    await db.query(`UPDATE ${schema()}.parent_portal_access SET last_login=NOW() WHERE id=$1`, [par.id]);
    res.json({ token: makeToken(par), parent: { id:par.id, email:par.email, first_name:par.first_name, child_id:par.child_id }});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /parent-otp — request OTP ───────────────────────────────────────
router.post('/parent-otp', loginLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id FROM ${schema()}.parent_portal_access WHERE email=$1 AND is_active=true`,
      [email.toLowerCase().trim()]
    );
    if (!rows.length) { res.json({ ok: true }); return; }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await db.query(
      `UPDATE ${schema()}.parent_portal_access SET otp_code=$1, otp_expires_at=$2 WHERE email=$3`,
      [code, expires, email.toLowerCase().trim()]
    );
    console.log(`[secondary-parent-otp] Code for ${email}: ${code}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /parent-otp-verify ───────────────────────────────────────────────
router.post('/parent-otp-verify', loginLimiter, async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT pa.*, c.first_name as child_first, c.last_name as child_last
       FROM ${schema()}.parent_portal_access pa
       LEFT JOIN ${schema()}.children c ON c.id=pa.child_id
       WHERE pa.email=$1 AND pa.otp_code=$2 AND pa.otp_expires_at > NOW() AND pa.is_active=true LIMIT 1`,
      [email.toLowerCase().trim(), code.trim()]
    );
    const par = rows[0];
    if (!par) return res.status(401).json({ error: 'Invalid or expired code' });
    await db.query(
      `UPDATE ${schema()}.parent_portal_access SET otp_code=NULL, otp_expires_at=NULL, last_login=NOW() WHERE id=$1`,
      [par.id]
    );
    res.json({ token: makeToken(par), parent: { id:par.id, email:par.email, first_name:par.first_name, child_id:par.child_id }});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /parent/child — child overview ────────────────────────────────────
router.get('/parent/child', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT c.*, attsum.sessions_possible, attsum.sessions_attended, attsum.pa_flag,
              (SELECT COUNT(*) FROM ${s}.behaviour_log b WHERE b.child_id=c.id AND b.behaviour_type='positive') as pos_count,
              (SELECT COUNT(*) FROM ${s}.behaviour_log b WHERE b.child_id=c.id AND b.behaviour_type!='positive') as neg_count,
              (SELECT COUNT(*) FROM ${s}.homework h JOIN ${s}.classes cl ON cl.id=h.class_id
               WHERE cl.year_group::text=REPLACE(c.year_group,'Year ','') AND h.is_published=true AND h.due_date>=CURRENT_DATE) as hw_due
       FROM ${s}.children c
       LEFT JOIN ${s}.attendance_summary attsum ON attsum.child_id=c.id
       WHERE c.id=$1`,
      [req.parent.child_id]
    );
    const child = rows[0];
    if (!child) return res.status(404).json({ error: 'Child not found' });
    const attPct = child.sessions_possible > 0
      ? Math.round(child.sessions_attended / child.sessions_possible * 100) : null;
    res.json({ ...child, attendance_pct: attPct });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /parent/timetable ─────────────────────────────────────────────────
router.get('/parent/timetable', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows: child } = await db.query(
      `SELECT year_group, form_group, class_group FROM ${s}.children WHERE id=$1`, [req.parent.child_id]);
    if (!child[0]) return res.status(404).json({ error: 'Not found' });
    const p = child[0];

    const yrNum = (p.year_group || '').replace('Year ', '').trim();
    const { rows: slots } = await db.query(
      `SELECT ts.*, cl.name as class_name, st.first_name||' '||st.last_name as teacher_name
       FROM ${s}.timetable_slots ts
       JOIN ${s}.classes cl ON cl.id = ts.class_id
       LEFT JOIN ${s}.staff st ON st.id = ts.teacher_id
       WHERE (cl.code = ANY($1::text[]) OR cl.year_group::text = $2)
       ORDER BY ts.day_of_week, ts.period`,
      [[p.form_group, p.class_group].filter(Boolean), yrNum]
    );
    const { rows: periods } = await db.query(`SELECT * FROM ${s}.timetable_periods ORDER BY day_of_week, period_num`);
    res.json({ timetable: slots, periods });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /parent/attendance ────────────────────────────────────────────────
router.get('/parent/attendance', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT attsum.* FROM ${s}.attendance_summary attsum WHERE attsum.child_id=$1`, [req.parent.child_id]);
    const sum = rows[0] || {};
    const pct = sum.sessions_possible > 0 ? Math.round(sum.sessions_attended/sum.sessions_possible*100) : null;
    const { rows: records } = await db.query(
      `SELECT * FROM ${s}.attendance WHERE child_id=$1 ORDER BY date DESC LIMIT 20`,
      [req.parent.child_id]
    ).catch(()=>({rows:[]}));
    res.json({ summary: { ...sum, attendance_pct: pct }, records });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /parent/behaviour ─────────────────────────────────────────────────
router.get('/parent/behaviour', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT b.*, st.first_name||' '||st.last_name as staff_name
       FROM ${s}.behaviour_log b
       LEFT JOIN ${s}.staff st ON st.id=b.staff_id
       WHERE b.child_id=$1 ORDER BY b.log_date DESC, b.created_at DESC`,
      [req.parent.child_id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /parent/homework ──────────────────────────────────────────────────
router.get('/parent/homework', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows: child } = await db.query(`SELECT year_group FROM ${s}.children WHERE id=$1`, [req.parent.child_id]);
    if (!child[0]) return res.status(404).json({ error: 'Not found' });
    const yr = child[0].year_group?.replace('Year ','') || '';

    const { rows } = await db.query(
      `SELECT h.*, cl.name as class_name, cl.year_group as hw_year,
              st.first_name||' '||st.last_name as teacher_name,
              sub.submitted_at, sub.grade
       FROM ${s}.homework h
       JOIN ${s}.classes cl ON cl.id=h.class_id
       LEFT JOIN ${s}.staff st ON st.id=h.set_by_teacher_id
       LEFT JOIN ${s}.homework_submissions sub ON sub.homework_id=h.id AND sub.pupil_id=$1
       WHERE h.is_published=true AND cl.year_group::text=$2
       ORDER BY h.due_date ASC`,
      [req.parent.child_id, yr]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /parent/assessments ───────────────────────────────────────────────
router.get('/parent/assessments', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT a.*, st.first_name||' '||st.last_name as teacher_name
       FROM ${s}.assessments_secondary a
       LEFT JOIN ${s}.staff st ON st.id=a.assessed_by
       WHERE a.child_id=$1 ORDER BY a.term, a.subject`,
      [req.parent.child_id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /parent/parents-evening ───────────────────────────────────────────
router.get('/parent/parents-evening', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT pes.*, st.first_name||' '||st.last_name as teacher_name
       FROM ${s}.parents_evening_slots pes
       LEFT JOIN ${s}.staff st ON st.id=pes.teacher_id
       WHERE pes.slot_date >= CURRENT_DATE
       ORDER BY pes.slot_date, pes.slot_time`
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /parent/parents-evening/:slot_id — book slot ────────────────────
router.post('/parent/parents-evening/:id', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows: existing } = await db.query(
      `SELECT id FROM ${s}.parents_evening_slots WHERE id=$1 AND pupil_id IS NOT NULL`, [req.params.id]);
    if (existing.length) return res.status(409).json({ error: 'Slot already booked' });
    const { rows } = await db.query(
      `UPDATE ${s}.parents_evening_slots
       SET pupil_id=$1, booked_by_parent_email=$2
       WHERE id=$3 AND pupil_id IS NULL RETURNING *`,
      [req.parent.child_id, req.parent.email, req.params.id]
    );
    if (!rows[0]) return res.status(409).json({ error: 'Slot no longer available' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /parent/parents-evening/:slot_id — cancel booking ─────────────
router.delete('/parent/parents-evening/:id', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    await db.query(
      `UPDATE ${s}.parents_evening_slots SET pupil_id=NULL, booked_by_parent_email=NULL
       WHERE id=$1 AND pupil_id=$2`,
      [req.params.id, req.parent.child_id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /parent/messages ──────────────────────────────────────────────────
router.get('/parent/messages', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const s = schema();
    const { rows } = await db.query(
      `SELECT mt.*, m.id as msg_id, m.body, m.sender_type, m.created_at as msg_at
       FROM ${s}.message_threads mt
       LEFT JOIN ${s}.messages m ON m.thread_id=mt.id
       WHERE mt.child_id=$1
       ORDER BY mt.id, m.created_at ASC`,
      [req.parent.child_id]
    ).catch(()=>({rows:[]}));
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /parent/messages ─────────────────────────────────────────────────
router.post('/parent/messages', parentAuth, async (req, res) => {
  const { body, thread_id } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  try {
    const db = getPool();
    const s = schema();
    let tid = thread_id;
    if (!tid) {
      const { rows } = await db.query(
        `INSERT INTO ${s}.message_threads (child_id, subject, created_at)
         VALUES ($1,'Message from Parent',NOW()) RETURNING id`,
        [req.parent.child_id]
      );
      tid = rows[0].id;
    }
    const { rows } = await db.query(
      `INSERT INTO ${s}.messages (thread_id, body, sender_type, created_at)
       VALUES ($1,$2,'parent',NOW()) RETURNING *`,
      [tid, body]
    );
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /parent/invoices — trip / exam-resit fees ─────────────────────────
router.get('/parent/invoices', parentAuth, async (req, res) => {
  // Demo: return synthetic invoices until proper invoice table is wired
  const demos = [
    { id:1, description:'Year 11 Revision Trip — Hampton Court', amount:2800, status:'unpaid', due_date:'2026-05-16' },
    { id:2, description:'Exam Re-sit Fee — Maths Paper 1', amount:1500, status:'unpaid', due_date:'2026-06-01' },
  ];
  res.json(process.env.DEMO_MODE === 'true' ? demos : []);
});

module.exports = router;
