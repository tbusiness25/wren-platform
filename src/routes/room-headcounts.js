'use strict';
// b125 — Scheduled room headcounts + live ratio-compliance log (EYFS safeguarding).
// Reuses the shared ratio-engine (src/services/ratio-engine.js) for the required-staff
// maths — same numbers occupancy.js and the absence gatekeeper already use. This route
// is the LIVE/ACTUAL compliance record (distinct from b122 occupancy-sandbox, which is
// the planning what-if).
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const ratioEngine = require('../services/ratio-engine');
const { notify } = require('../services/notification-dispatcher');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'room_leader'])) return res.status(403).json({ error: 'Manager access required' });
  next();
};

const DEFAULT_SLOT_TIMES = ['10:30', '13:00', '15:30'];
const ymd = d => new Date(d).toISOString().slice(0, 10);

// Staff roles never counted toward ratio (mirrors ratio-engine.js EXCLUDED_ROLES/NAME_RE
// and occupancy.js's isRatioCountable — kept in sync manually, same numbers, no import
// cycle since ratio-engine doesn't export the regex).
// b271 (2026-09-04): 'manager' out, 'admin' in — the ex-deputies (now
// 'manager') are on the floor and DO count; the owners (now 'admin') do not.
const NON_RATIO_ROLES = new Set(['admin', 'chef', 'cook', 'owner', 'director']);
const NON_RATIO_NAME_RE = /\b(hetty|henrietta|clare)\b/i;
function isRatioStaff(s) {
  return !NON_RATIO_ROLES.has((s.role || '').toLowerCase()) && !NON_RATIO_NAME_RE.test(`${s.first_name || ''} ${s.last_name || ''}`);
}

async function getSlotTimes(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='headcount_slot_times'`);
    const v = rows[0]?.value;
    if (v) {
      const times = v.split(',').map(t => t.trim()).filter(t => /^\d{2}:\d{2}$/.test(t));
      if (times.length) return times;
    }
  } catch (_) { /* settings row absent → default */ }
  return DEFAULT_SLOT_TIMES;
}

// Idempotent: creates today's (or a given date's) scheduled slots for every room.
// Safe to call repeatedly (ON CONFLICT DO NOTHING on the room_id+scheduled_for unique index).
async function generateSlotsForDate(db, dateStr) {
  const slotTimes = await getSlotTimes(db);
  const { rows: rooms } = await db.query(`SELECT id FROM rooms ORDER BY id`);
  let created = 0;
  for (const room of rooms) {
    for (const t of slotTimes) {
      const { rowCount } = await db.query(
        `INSERT INTO room_headcounts (room_id, scheduled_for, status)
         VALUES ($1, $2::timestamptz, 'scheduled')
         ON CONFLICT (room_id, scheduled_for) DO NOTHING`,
        [room.id, `${dateStr} ${t}:00`]
      );
      created += rowCount;
    }
  }
  return created;
}

// Sweep: flip overdue 'scheduled' slots to 'missed' + escalate to manager once.
// graceMinutes: how long past scheduled_for before we give up on it being completed.
async function sweepMissed(db, graceMinutes) {
  const { rows } = await db.query(`
    SELECT rh.id, rh.room_id, r.name AS room_name, rh.scheduled_for
    FROM room_headcounts rh JOIN rooms r ON r.id = rh.room_id
    WHERE rh.status = 'scheduled'
      AND rh.scheduled_for < NOW() - ($1 || ' minutes')::interval
  `, [graceMinutes]);
  for (const row of rows) {
    await db.query(`UPDATE room_headcounts SET status='missed' WHERE id=$1`, [row.id]);
    notify('headcount_missed', 'all-managers', null,
      'Room headcount missed',
      `${row.room_name} headcount scheduled for ${new Date(row.scheduled_for).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} was not completed.`,
      { priority: 'high', relatedTable: 'room_headcounts', relatedId: row.id });
  }
  return rows.length;
}

// Reminder: notify a room's assigned active staff once a slot is due, respecting a
// cooldown (don't re-notify the same slot repeatedly) via checking existing deliveries.
async function sweepDueReminders(db, windowMinutes) {
  const { rows: due } = await db.query(`
    SELECT rh.id, rh.room_id, r.name AS room_name, rh.scheduled_for
    FROM room_headcounts rh JOIN rooms r ON r.id = rh.room_id
    WHERE rh.status = 'scheduled'
      AND rh.scheduled_for <= NOW()
      AND rh.scheduled_for > NOW() - ($1 || ' minutes')::interval
  `, [windowMinutes]);
  let notified = 0;
  for (const row of due) {
    const { rows: already } = await db.query(
      `SELECT 1 FROM notifications WHERE category='headcount_due' AND related_table='room_headcounts' AND related_id=$1 LIMIT 1`,
      [row.id]);
    if (already.length) continue;
    const { rows: staff } = await db.query(
      `SELECT id FROM staff WHERE room_id=$1 AND is_active=true`, [row.room_id]);
    const when = new Date(row.scheduled_for).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    for (const s of staff) {
      notify('headcount_due', 'staff', s.id,
        `${row.room_name} headcount due`,
        `The ${when} headcount for ${row.room_name} is due — please complete it now.`,
        { priority: 'normal', relatedTable: 'room_headcounts', relatedId: row.id, link: '/ey/room-headcount' });
      notified++;
    }
  }
  return notified;
}

// GET /today?room_id= — today's slots for a room (defaults to caller's own room).
router.get('/today', async (req, res) => {
  const db = getPool();
  try {
    let roomId = req.query.room_id ? Number(req.query.room_id) : null;
    if (!roomId) {
      const { rows } = await db.query(`SELECT room_id FROM staff WHERE id=$1`, [req.user.id]);
      roomId = rows[0]?.room_id || null;
    }
    if (!roomId) return res.status(400).json({ error: 'room_id required (no room on your staff profile)' });
    const today = ymd(new Date());
    const { rows } = await db.query(`
      SELECT rh.*, r.name AS room_name, s.first_name AS completed_by_first, s.last_name AS completed_by_last
      FROM room_headcounts rh
      JOIN rooms r ON r.id = rh.room_id
      LEFT JOIN staff s ON s.id = rh.completed_by
      WHERE rh.room_id=$1 AND rh.scheduled_for >= $2::date AND rh.scheduled_for < $2::date + INTERVAL '1 day'
      ORDER BY rh.scheduled_for
    `, [roomId, today]);
    res.json(rows);
  } catch (e) { console.error('[room-headcounts/today]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /pending?room_id= — the current due-or-next incomplete slot, prefilled with the
// live register (children currently signed in, not out, not absent) + room-assigned staff.
router.get('/pending', async (req, res) => {
  const db = getPool();
  try {
    let roomId = req.query.room_id ? Number(req.query.room_id) : null;
    if (!roomId) {
      const { rows } = await db.query(`SELECT room_id FROM staff WHERE id=$1`, [req.user.id]);
      roomId = rows[0]?.room_id || null;
    }
    if (!roomId) return res.status(400).json({ error: 'room_id required (no room on your staff profile)' });

    await generateSlotsForDate(db, ymd(new Date()));

    const { rows: slotRows } = await db.query(`
      SELECT * FROM room_headcounts
      WHERE room_id=$1 AND status='scheduled' AND scheduled_for >= CURRENT_DATE AND scheduled_for < CURRENT_DATE + INTERVAL '1 day'
      ORDER BY scheduled_for LIMIT 1
    `, [roomId]);
    if (!slotRows.length) return res.json({ slot: null, children: [], staff: [] });
    const slot = slotRows[0];

    const { rows: children } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.date_of_birth AS dob
      FROM children c
      JOIN attendance a ON a.child_id = c.id
      WHERE c.room_id=$1 AND a.date=CURRENT_DATE AND a.sign_in_time IS NOT NULL
        AND a.sign_out_time IS NULL AND COALESCE(a.absent,false)=false
        AND COALESCE(c.is_demo, false) = false
      ORDER BY c.first_name
    `, [roomId]);

    const { rows: staffRows } = await db.query(`
      SELECT id, first_name, last_name, role FROM staff WHERE room_id=$1 AND is_active=true
         AND COALESCE(is_demo, false) = false ORDER BY first_name
    `, [roomId]);
    const staff = staffRows.filter(isRatioStaff).map(s => ({ id: s.id, first_name: s.first_name, last_name: s.last_name, role: s.role }));

    res.json({
      slot: { id: slot.id, scheduled_for: slot.scheduled_for, status: slot.status },
      children: children.map(c => ({ id: c.id, first_name: c.first_name, last_name: c.last_name })),
      staff,
      ratios: ratioEngine.RATIOS,
    });
  } catch (e) { console.error('[room-headcounts/pending]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /:id/complete — record who's actually present + get the instant ratio verdict.
router.post('/:id/complete', async (req, res) => {
  const db = getPool();
  try {
    const { children_ids = [], staff_ids = [], notes = null } = req.body || {};
    const { rows: existing } = await db.query(`SELECT * FROM room_headcounts WHERE id=$1`, [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Headcount slot not found' });

    const today = ymd(new Date());
    let bands = { under2: 0, two: 0, threePlus: 0 };
    if (children_ids.length) {
      const { rows: kids } = await db.query(
        `SELECT id, date_of_birth FROM children WHERE id = ANY($1::int[])`, [children_ids]);
      for (const k of kids) {
        if (!k.date_of_birth) continue;
        bands[ratioEngine.ageBandOn(k.date_of_birth, today)]++;
      }
    }
    const required_staff = ratioEngine.requiredStaff(bands);
    const staff_present = staff_ids.length;
    const ratio_ok = staff_present >= required_staff;

    const { rows } = await db.query(`
      UPDATE room_headcounts SET
        status='completed', completed_at=NOW(), completed_by=$2,
        children_present=$3, staff_present=$4, age_breakdown=$5,
        required_staff=$6, ratio_ok=$7, children_ids=$8, staff_ids=$9, notes=$10
      WHERE id=$1
      RETURNING *
    `, [req.params.id, req.user.id, children_ids.length, staff_present,
        JSON.stringify(bands), required_staff, ratio_ok,
        JSON.stringify(children_ids), JSON.stringify(staff_ids), notes]);

    if (!ratio_ok) {
      const room = await db.query(`SELECT name FROM rooms WHERE id=$1`, [existing[0].room_id]);
      notify('room_ratio_breach', 'all-managers', null,
        'Headcount ratio breach',
        `${room.rows[0]?.name || 'A room'}: ${staff_present} staff for ${children_ids.length} children (need ${required_staff}).`,
        { priority: 'high', relatedTable: 'room_headcounts', relatedId: rows[0].id });
    }

    res.json(rows[0]);
  } catch (e) { console.error('[room-headcounts/complete]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /overview?date= — manager oversight: every room's slots for a given day (default today).
router.get('/overview', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : ymd(new Date());
    if (date === ymd(new Date())) await generateSlotsForDate(db, date);
    const { rows } = await db.query(`
      SELECT rh.*, r.name AS room_name, s.first_name AS completed_by_first, s.last_name AS completed_by_last
      FROM room_headcounts rh
      JOIN rooms r ON r.id = rh.room_id
      LEFT JOIN staff s ON s.id = rh.completed_by
      WHERE rh.scheduled_for >= $1::date AND rh.scheduled_for < $1::date + INTERVAL '1 day'
      ORDER BY r.name, rh.scheduled_for
    `, [date]);
    res.json({ date, slots: rows });
  } catch (e) { console.error('[room-headcounts/overview]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /history?from=&to=&room_id=&status= — the Ofsted-evidence audit trail.
router.get('/history', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const today = ymd(new Date());
    let to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    let from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : (() => {
      const d = new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 13); return ymd(d);
    })();
    const params = [from, to];
    let where = `rh.scheduled_for >= $1::date AND rh.scheduled_for < $2::date + INTERVAL '1 day'`;
    if (req.query.room_id) { params.push(Number(req.query.room_id)); where += ` AND rh.room_id=$${params.length}`; }
    if (['scheduled', 'completed', 'missed'].includes(req.query.status)) { params.push(req.query.status); where += ` AND rh.status=$${params.length}`; }
    const { rows } = await db.query(`
      SELECT rh.*, r.name AS room_name, s.first_name AS completed_by_first, s.last_name AS completed_by_last
      FROM room_headcounts rh
      JOIN rooms r ON r.id = rh.room_id
      LEFT JOIN staff s ON s.id = rh.completed_by
      WHERE ${where}
      ORDER BY rh.scheduled_for DESC
      LIMIT 500
    `, params);
    res.json({ from, to, count: rows.length, slots: rows });
  } catch (e) { console.error('[room-headcounts/history]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /generate?date= — manager-triggered (also called internally by /pending + /overview + the drainer).
router.post('/generate', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const bodyDate = (req.body && req.body.date) || '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || bodyDate) ? (req.query.date || bodyDate) : ymd(new Date());
    const created = await generateSlotsForDate(db, date);
    res.json({ date, created });
  } catch (e) { console.error('[room-headcounts/generate]', e.message); res.status(500).json({ error: e.message }); }
});

// Auto-complete due scheduled headcounts from the LIVE register — no staff action needed
// (2026-07-30). Snapshots children currently signed in (per room) + room-assigned ratio staff,
// computes the EYFS ratio, and marks the slot 'completed' (completed_by=NULL = system/auto).
// Only touches slots staff haven't already done; notifies managers on a ratio breach.
async function autoCompleteDue(db) {
  const today = ymd(new Date());
  const { rows: due } = await db.query(
    `SELECT * FROM room_headcounts WHERE status='scheduled' AND scheduled_for <= NOW()
       AND scheduled_for >= CURRENT_DATE ORDER BY scheduled_for`);
  let done = 0;
  for (const slot of due) {
    const { rows: children } = await db.query(
      `SELECT c.id, c.date_of_birth FROM children c JOIN attendance a ON a.child_id=c.id
        WHERE c.room_id=$1 AND a.date=CURRENT_DATE AND a.sign_in_time IS NOT NULL
          AND a.sign_out_time IS NULL AND COALESCE(a.absent,false)=false
          AND COALESCE(c.is_demo, false) = false`, [slot.room_id]);
    const { rows: staff } = await db.query(
      `SELECT id, role FROM staff WHERE room_id=$1 AND is_active=true
          AND COALESCE(is_demo, false) = false`, [slot.room_id]);  // b485 port: demo staff never count on ratio
    const child_ids = children.map(c => c.id);
    const staff_ids = staff.filter(s => isRatioStaff(s.role)).map(s => s.id);
    const bands = { under2: 0, two: 0, threePlus: 0 };
    for (const k of children) { if (k.date_of_birth) bands[ratioEngine.ageBandOn(k.date_of_birth, today)]++; }
    const required_staff = ratioEngine.requiredStaff(bands);
    const ratio_ok = staff_ids.length >= required_staff;
    await db.query(`UPDATE room_headcounts SET status='completed', completed_at=NOW(), completed_by=NULL,
        children_present=$2, staff_present=$3, age_breakdown=$4, required_staff=$5, ratio_ok=$6,
        children_ids=$7, staff_ids=$8, notes='Auto-completed from live register' WHERE id=$1`,
      [slot.id, child_ids.length, staff_ids.length, JSON.stringify(bands), required_staff, ratio_ok,
       JSON.stringify(child_ids), JSON.stringify(staff_ids)]);
    if (!ratio_ok) {
      const r = await db.query(`SELECT name FROM rooms WHERE id=$1`, [slot.room_id]);
      notify('room_ratio_breach', 'all-managers', null, 'Headcount ratio breach (auto)',
        `${r.rows[0]?.name || 'A room'}: ${staff_ids.length} staff for ${child_ids.length} children (need ${required_staff}).`,
        { priority: 'high', relatedTable: 'room_headcounts', relatedId: slot.id });
    }
    done++;
  }
  return done;
}

// POST /auto-run — generate today's slots + auto-complete any that are due (cron/internal token).
router.post('/auto-run', async (req, res) => {
  const db = getPool();
  try {
    await generateSlotsForDate(db, ymd(new Date()));
    const auto_completed = await autoCompleteDue(db);
    res.json({ ok: true, auto_completed });
  } catch (e) { console.error('[room-headcounts/auto-run]', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.internals = { generateSlotsForDate, sweepMissed, sweepDueReminders, isRatioStaff, getSlotTimes, autoCompleteDue };
