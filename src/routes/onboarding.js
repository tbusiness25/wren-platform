// Admissions onboarding — deposit, settling-in schedule, home visit (2026-07-11).
// Once a place is confirmed the setting asks for a deposit (default 2 weeks' fees,
// credited to the first invoice), agrees a settling-in schedule (LADN: 1 week for
// pre-school, 2 weeks for babies; sessions 15 min–10 hours, fully editable), and
// the BABY ROOM offers a home visit (pre-school does not).
'use strict';
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { getPool } = require('../db/pool');

const WRITE_ROLES = ['manager', 'deputy_manager', 'admin', 'senior_practitioner', 'room_leader'];

router.use((req, res, next) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-wren-token'] || '';
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }
  if (!Number.isInteger(req.user.id)) return res.status(401).json({ error: 'Staff only' });
  next();
});
const canWrite = (req, res, next) => WRITE_ROLES.includes(req.user.role) ? next() : res.status(403).json({ error: 'Insufficient role' });

// Baby-room detection: LADN has "Baby Room" (age band up to ~2yr). Home visits
// are baby-room only. We match on the room name.
async function isBabyRoom(db, childId) {
  const { rows } = await db.query(
    `SELECT r.name FROM children c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1`, [childId]);
  return /bab(y|ies)|under.?2|infant/i.test(rows[0]?.name || '');
}

// ── Deposit ───────────────────────────────────────────────────────────────────
// GET current deposit for a child.
router.get('/child/:id/deposit', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM child_deposits WHERE child_id=$1 ORDER BY created_at DESC LIMIT 1`, [req.params.id]);
    res.json(rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Raise a deposit as due — default 2 weeks of the child's current weekly fee.
router.post('/child/:id/deposit/raise', canWrite, async (req, res) => {
  const db = getPool();
  try {
    let amount = req.body && req.body.amount_pence;
    const weeks = (req.body && req.body.weeks_basis) || 2;
    if (amount == null) {
      // Estimate weekly fee from the child's booked sessions × room rate if available;
      // fall back to leaving it null for the manager to fill in.
      const { rows } = await db.query(
        `SELECT COALESCE(mb.monthly_fee_pence,0) AS m FROM children c
         LEFT JOIN rooms r ON r.id=c.room_id
         LEFT JOIN LATERAL (SELECT monthly_fee_pence FROM rooms WHERE id=c.room_id) mb ON true
         WHERE c.id=$1`, [req.params.id]).catch(() => ({ rows: [] }));
      const monthly = parseInt(rows[0]?.m) || 0;
      amount = monthly ? Math.round((monthly / 52 * 12) * weeks) : null; // ~weekly × weeks
    }
    const { rows } = await db.query(
      `INSERT INTO child_deposits (child_id, amount_pence, weeks_basis, status, due_date, notes, created_by)
       VALUES ($1,$2,$3,'due',$4,$5,$6) RETURNING *`,
      [req.params.id, amount, weeks, req.body?.due_date || null,
       'Deposit = ' + weeks + ' weeks fees, credited to first invoice.', req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/deposit/:depositId/pay', canWrite, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `UPDATE child_deposits SET status='paid', paid_date=COALESCE($2,CURRENT_DATE) WHERE id=$1 RETURNING *`,
      [req.params.depositId, req.body?.paid_date || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Credit a paid deposit to an invoice (marks it credited + records which invoice).
router.post('/deposit/:depositId/credit', canWrite, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `UPDATE child_deposits SET status='credited', applied_invoice_id=$2 WHERE id=$1 AND status='paid' RETURNING *`,
      [req.params.depositId, req.body?.invoice_id || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found or not paid' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Settling-in schedule ──────────────────────────────────────────────────────
router.get('/child/:id/settling-plan', async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT * FROM settling_in_plans WHERE child_id=$1`, [req.params.id]);
    res.json(rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate a default plan: babies = 2 weeks, pre-school = 1 week, short sessions
// ramping up. Fully editable afterwards. Sessions are {date,start,end,notes}.
router.post('/child/:id/settling-plan/generate', canWrite, async (req, res) => {
  const db = getPool();
  try {
    const baby = await isBabyRoom(db, req.params.id);
    const startDate = req.body?.start_date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.start_date)
      ? req.body.start_date : new Date().toISOString().slice(0, 10);
    const roomType = baby ? 'baby' : 'preschool';
    // A gentle default ramp — the setting edits times freely (15 min → 10 hours).
    const babyRamp = ['10:00-10:45', '10:00-11:30', '09:30-12:00', '09:00-13:00', '09:00-15:00',
                      '09:00-16:00', '08:30-16:30', '08:00-17:00', '08:00-17:30', '08:00-18:00'];
    const preRamp = ['09:30-11:00', '09:30-12:30', '09:00-14:00', '09:00-16:00', '08:00-18:00'];
    const ramp = baby ? babyRamp : preRamp;
    const sessions = [];
    const d = new Date(startDate + 'T00:00:00Z');
    let added = 0;
    while (added < ramp.length) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) { // weekdays only
        const [start, end] = ramp[added].split('-');
        sessions.push({ date: d.toISOString().slice(0, 10), start, end, notes: '' });
        added++;
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const { rows } = await db.query(
      `INSERT INTO settling_in_plans (child_id, room_type, sessions, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (child_id) DO UPDATE SET room_type=$2, sessions=$3, updated_at=now()
       RETURNING *`,
      [req.params.id, roomType, JSON.stringify(sessions), req.user.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save an edited plan (staff customise every session freely).
router.put('/child/:id/settling-plan', canWrite, async (req, res) => {
  const sessions = Array.isArray(req.body?.sessions) ? req.body.sessions : null;
  if (!sessions) return res.status(400).json({ error: 'sessions array required' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO settling_in_plans (child_id, room_type, sessions, notes, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (child_id) DO UPDATE SET sessions=$3, notes=$4, room_type=COALESCE($2,settling_in_plans.room_type), updated_at=now()
       RETURNING *`,
      [req.params.id, req.body?.room_type || null, JSON.stringify(sessions), req.body?.notes || null, req.user.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Home visit (BABY ROOM only) ───────────────────────────────────────────────
router.get('/child/:id/home-visit', async (req, res) => {
  try {
    const eligible = await isBabyRoom(getPool(), req.params.id);
    const { rows } = await getPool().query(
      `SELECT hv.*, s.first_name || ' ' || s.last_name AS staff_name
       FROM home_visits hv LEFT JOIN staff s ON s.id=hv.staff_id
       WHERE hv.child_id=$1 ORDER BY hv.created_at DESC`, [req.params.id]);
    res.json({ eligible, visits: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/child/:id/home-visit', canWrite, async (req, res) => {
  const db = getPool();
  try {
    if (!(await isBabyRoom(db, req.params.id))) {
      return res.status(422).json({ error: 'Home visits are offered for the Baby Room only.' });
    }
    const { rows } = await db.query(
      `INSERT INTO home_visits (child_id, scheduled_date, scheduled_time, staff_id, status, notes, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,'booked'),$6,$7) RETURNING *`,
      [req.params.id, req.body?.scheduled_date || null, req.body?.scheduled_time || null,
       req.body?.staff_id || req.user.id, req.body?.status || null, req.body?.notes || null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/home-visit/:visitId/status', canWrite, async (req, res) => {
  const st = String(req.body?.status || '');
  if (!['requested', 'booked', 'completed', 'cancelled'].includes(st)) return res.status(400).json({ error: 'bad status' });
  try {
    const { rows } = await getPool().query(
      `UPDATE home_visits SET status=$1, notes=COALESCE($3,notes) WHERE id=$2 RETURNING *`,
      [st, req.params.visitId, req.body?.notes || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
