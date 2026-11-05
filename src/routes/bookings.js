const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
// b315 — the ONE room writer. A booking names the room a child is in; the
// profile has to follow, and only this may move it.
const childRoom = require('../lib/child-room');
// b315 — the two dates a child's record calculates for itself.
const childDates = require('../lib/child-dates');

router.use(authenticate);

// Writes are manager/deputy only (matches the "managers set the bookings" spec).
const isManager = r => ['manager', 'deputy_manager', 'admin', 'headteacher'].includes(r);
function requireManager(req, res) {
  if (!isManager(req.user && req.user.role)) {
    res.status(403).json({ error: 'Manager or deputy only' });
    return false;
  }
  return true;
}

// 2026-10-21 — one-off extra sessions onto the next invoice (see src/lib/extra-sessions.js).
const XS = require('../lib/extra-sessions');
// b535 (2026-10-29) — a booking change moves the bill, so the save says which
// invoices it has just made out of date (src/lib/invoice-pricing.js). Read-only,
// never throws, and appended to the response — the booking write itself is untouched.
const PRICING = require('../lib/invoice-pricing');

/** A pg DATE (a JS Date at local midnight) or 'YYYY-MM-DD…' → 'YYYY-MM-DD'. */
function isoDay(d) {
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return String(d || '').slice(0, 10);
}

/** In-app only: a bell on the child for the family. Best-effort, never throws. */
async function notifyFamily(db, br, outcome) {
  try {
    const { rows } = await db.query('SELECT first_name FROM children WHERE id=$1', [br.child_id]);
    const name = (rows[0] && rows[0].first_name) || 'your child';
    const day = isoDay(br.request_date);
    const when = new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB',
      { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    const what = (XS.SESSION_LABEL[XS.normSession(br.session)] || 'Full day').toLowerCase();
    const title = outcome === 'declined' ? 'Extra session not available'
      : outcome === 'added' ? 'Extra session booked' : 'Extra session approved';
    const body = outcome === 'declined'
      ? `Sorry, we can't offer ${name} the extra ${what} session on ${when}.${br.resolution_notes ? ' ' + br.resolution_notes : ''}`
      : `${name} is booked in for an extra ${what} session on ${when}. It will be added to your next invoice at your normal session rate.`;
    await db.query(
      `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
       VALUES ('parent', $1, 'booking', $2, $3, '/welcome/bookings', 'booking_requests', $4, 'normal')`,
      [br.child_id, title, body, br.id]);
  } catch (e) { console.error('booking -> family notification:', e.message); }
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

// ═══════════════════════════════════════════════════════════════════════════
// b315 (2026-09-10) — SESSION TYPES
//
// EyMan's "Book a Session" asks for a session type and fills the start and
// finish times in from it. Wren already knew the setting that implies the
// standard one — invoice_session_start (08:00) for invoice_session_hours (10) —
// it just had nowhere to say there was more than one.
//
// The list lives in settings.booking_session_types as JSON so a manager can edit
// it without a migration. An empty or unparseable setting falls back to the same
// defaults in code, derived from the invoice settings rather than invented, so a
// tenant that has never touched it still gets sensible times.
// ═══════════════════════════════════════════════════════════════════════════
const SESSION_TYPES_KEY = 'booking_session_types';

/** 'HH:MM' | 'HH:MM:SS' → 'HH:MM', anything else → null. */
function normaliseTime(v) {
  if (v == null || v === '') return null;
  const m = String(v).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  if (h > 23 || parseInt(m[2], 10) > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** Add hours to 'HH:MM', capped at 23:59 — the day does not wrap here. */
function addHours(hhmm, hours) {
  const t = normaliseTime(hhmm);
  if (!t) return null;
  const mins = (+t.slice(0, 2)) * 60 + (+t.slice(3, 5)) + Math.round(hours * 60);
  const capped = Math.min(mins, 23 * 60 + 59);
  return `${String(Math.floor(capped / 60)).padStart(2, '0')}:${String(capped % 60).padStart(2, '0')}`;
}

async function loadSessionTypes(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key = ANY($1)`,
    [[SESSION_TYPES_KEY, 'invoice_session_start', 'invoice_session_hours']]);
  const bag = {};
  for (const r of rows) bag[r.key] = r.value;

  let list = null;
  try {
    const parsed = JSON.parse(bag[SESSION_TYPES_KEY] || 'null');
    if (Array.isArray(parsed) && parsed.length) list = parsed;
  } catch (_) { list = null; }

  if (!list) {
    // The nursery's own full day, from the settings that already state it.
    const start = normaliseTime(bag.invoice_session_start) || '08:00';
    const hours = Number(bag.invoice_session_hours) > 0 ? Number(bag.invoice_session_hours) : 10;
    const finish = addHours(start, hours) || '18:00';
    const midday = addHours(start, hours / 2) || '13:00';
    list = [
      { code: 'day', label: 'Day / Full time', start, finish },
      { code: 'am', label: 'Morning (AM)', start, finish: midday },
      { code: 'pm', label: 'Afternoon (PM)', start: midday, finish },
    ];
  }
  return list.map(t => ({
    code: String(t.code || t.label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    label: String(t.label || t.code || '').trim(),
    start: normaliseTime(t.start),
    finish: normaliseTime(t.finish),
  })).filter(t => t.code && t.label);
}

/** Match a submitted session type by code or by label. Unknown → null (kept verbatim). */
async function resolveSessionType(db, wanted) {
  if (!wanted) return null;
  const w = String(wanted).trim().toLowerCase();
  const list = await loadSessionTypes(db);
  return list.find(t => t.code === w || t.label.toLowerCase() === w) || null;
}

// GET /api/bookings/session-types — the picker's options. Read-only, any
// signed-in member of staff: it is a list of times, not child data.
router.get('/session-types', async (req, res) => {
  try {
    res.json(await loadSessionTypes(getPool()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * The auto end-date: the 31 August immediately BEFORE the child's 5th birthday,
 * which is the same day as the 31 August ON OR AFTER their 4th — the summer they
 * leave for Reception. Two phrasings of one rule.
 *
 * b315 moved the maths to src/lib/child-dates.js, where it is tested against its
 * SQL twin (ladn.expected_leave_date) over every date of birth in a six-year
 * span. This name is kept and still exported because other files import it.
 * @param {string|Date} dobStr 'YYYY-MM-DD' or a Date (node-pg returns DATE as Date)
 * @returns {string|null} 'YYYY-MM-DD' or null if dob unparseable
 */
function computeEndDate(dobStr) {
  return childDates.expectedLeaveDate(dobStr);
}

// GET /api/bookings/child/:childId — active patterns for a child
router.get('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT b.*, r.name AS room_name
      FROM child_bookings b
      LEFT JOIN rooms r ON r.id = b.room_id
      WHERE b.child_id = $1 AND b.is_active = true
      ORDER BY b.start_date DESC, b.id DESC
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bookings — create a pattern
router.post('/', async (req, res) => {
  if (!requireManager(req, res)) return;
  const b = req.body || {};
  const childId = parseInt(b.child_id, 10);
  if (!childId) return res.status(400).json({ error: 'child_id required' });
  if (!b.start_date) return res.status(400).json({ error: 'start_date required' });
  const days = {};
  let anyDay = false;
  for (const d of WEEKDAYS) { days[d] = !!b[d]; if (days[d]) anyDay = true; }
  if (!anyDay) return res.status(400).json({ error: 'At least one weekday must be ticked' });

  try {
    const db = getPool();
    // Validate child exists + get dob for the auto end-date. Format dob as text
    // in SQL — node-pg returns DATE columns as JS Date objects, which computeEndDate
    // (a string parser) would reject.
    const { rows: crows } = await db.query(
      "SELECT id, to_char(date_of_birth,'YYYY-MM-DD') AS dob, room_id FROM children WHERE id=$1", [childId]
    );
    if (!crows.length) return res.status(404).json({ error: 'Child not found' });
    const child = crows[0];

    let endDate = b.end_date || null;
    if (!endDate && child.dob) {
      endDate = computeEndDate(child.dob);
    }
    // Fall back to the child's current room if none specified on the booking
    const roomId = (b.room_id != null && b.room_id !== '') ? parseInt(b.room_id, 10) : (child.room_id || null);

    // b315 — the EyMan "Book a Session" fields. A session type carries its own
    // start and finish times; when the caller does not override them, they come
    // from the type. repeat 'none' is a one-off on a single date, so the end date
    // is the start date and every weekday flag but that day's is meaningless —
    // the day the date falls on is ticked for the caller.
    const st = await resolveSessionType(db, b.session_type);
    const repeat = b.repeat_mode === 'none' ? 'none' : 'weekly';
    const startTime = normaliseTime(b.start_time) || (st ? st.start : null);
    const finishTime = normaliseTime(b.finish_time) || (st ? st.finish : null);
    if (repeat === 'none') {
      endDate = b.start_date;
      const dow = childDates.isoDow(b.start_date);
      for (let i = 0; i < WEEKDAYS.length; i++) days[WEEKDAYS[i]] = (dow === i + 1);
      if (dow > 5) return res.status(400).json({ error: 'A one-off booking must fall on a weekday' });
    }

    const { rows } = await db.query(`
      INSERT INTO child_bookings
        (child_id, room_id, mon, tue, wed, thu, fri, start_date, end_date, funded, notes, source, created_by,
         session_type, start_time, finish_time, repeat_mode, extra_session, exclude_from_funding, updated_at, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual',$12,
              $13,$14,$15,$16,$17,$18,NOW(),$12)
      RETURNING *
    `, [childId, roomId, days.mon, days.tue, days.wed, days.thu, days.fri,
        b.start_date, endDate, !!b.funded, b.notes || null, req.user.id,
        st ? st.label : (b.session_type || null), startTime, finishTime, repeat,
        !!b.extra_session, !!b.exclude_from_funding]);

    // b314/b315 — a new booking that names a different room to the child's
    // profile IS a room decision: occupancy reads this row while the registers,
    // the diary and the kitchen read the profile. The sync is not written here —
    // it goes through the one room writer, which also records the move in
    // child_room_moves. Only a booking live TODAY moves the profile; a pattern
    // that starts next term must not move a child now (noteRoomFromBooking
    // enforces that, not this route).
    let profile_synced = false;
    let room_move = null;
    if (roomId && roomId !== child.room_id) {
      room_move = await childRoom.noteRoomFromBooking(db, {
        childId, booking: rows[0], actorId: req.user.id, source: 'booking-editor',
      });
      profile_synced = !!(room_move && room_move.profile_updated);
    }
    res.json({
      ...rows[0],
      ...(profile_synced ? { profile_synced: true, room_move } : {}),
      stale_invoices: await PRICING.staleForChild(db, childId),   // b535
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/bookings/:id — update a pattern
router.put('/:id', async (req, res) => {
  if (!requireManager(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;
  const push = (col, val) => { sets.push(`${col}=$${i++}`); vals.push(val); };

  for (const d of WEEKDAYS) if (d in b) push(d, !!b[d]);
  if ('room_id' in b) push('room_id', (b.room_id === '' || b.room_id == null) ? null : parseInt(b.room_id, 10));
  if ('start_date' in b) push('start_date', b.start_date);
  if ('end_date' in b) push('end_date', b.end_date || null);
  if ('funded' in b) push('funded', !!b.funded);
  if ('notes' in b) push('notes', b.notes || null);
  if ('is_active' in b) push('is_active', !!b.is_active);

  try {
    const db = getPool();

    // b315 — the EyMan session fields. Picking a session type without naming
    // times adopts that type's times; naming times keeps them.
    if ('session_type' in b) {
      const st = await resolveSessionType(db, b.session_type);
      push('session_type', st ? st.label : (b.session_type || null));
      if (st && !('start_time' in b)) push('start_time', st.start);
      if (st && !('finish_time' in b)) push('finish_time', st.finish);
    }
    if ('start_time' in b) push('start_time', normaliseTime(b.start_time));
    if ('finish_time' in b) push('finish_time', normaliseTime(b.finish_time));
    if ('repeat_mode' in b) push('repeat_mode', b.repeat_mode === 'none' ? 'none' : 'weekly');
    if ('extra_session' in b) push('extra_session', !!b.extra_session);
    if ('exclude_from_funding' in b) push('exclude_from_funding', !!b.exclude_from_funding);

    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    sets.push('updated_at = NOW()');
    push('updated_by', req.user.id);
    vals.push(id);

    const { rows } = await db.query(
      `UPDATE child_bookings SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });

    // b314/b315 — the room bug, running the other way. Occupancy reads
    // child_bookings.room_id; registers, the diary, the kitchen sheets and the
    // child's own profile read children.room_id. Moving the booking here left
    // the profile saying the old room indefinitely, so the two screens a manager
    // checks disagreed and neither of them said so.
    //
    // The follow-up goes through the one room writer, which decides whether this
    // booking is the live one (a future pattern must not move a child now) and
    // records the move. It is deliberately NOT setChildRoom(): the booking IS the
    // edit, so re-transferring it would open a second booking on top of the one
    // that was just saved.
    let profile_synced = false;
    let room_move = null;
    const b2 = rows[0];
    if ('room_id' in b && b2.room_id) {
      room_move = await childRoom.noteRoomFromBooking(db, {
        childId: b2.child_id, booking: b2, actorId: req.user.id, source: 'booking-editor',
      });
      profile_synced = !!(room_move && room_move.profile_updated);
    }
    res.json({ ...b2, ...(profile_synced ? { profile_synced: true, room_move } : {}),
               stale_invoices: await PRICING.staleForChild(db, b2.child_id) });   // b535
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/bookings/:id — soft-delete (is_active=false)
router.delete('/:id', async (req, res) => {
  if (!requireManager(req, res)) return;
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE child_bookings SET is_active=false WHERE id=$1 RETURNING id, child_id',
      [parseInt(req.params.id, 10)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    // b535 — ending a pattern is as much a billing change as starting one.
    res.json({ ok: true, id: rows[0].id, stale_invoices: await PRICING.staleForChild(db, rows[0].child_id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bookings/expected?date=YYYY-MM-DD — children expected that day.
// (active pattern covering the date, with the weekday bit set). Drives the
// register seed + occupancy. Defaults to today.
router.get('/expected', async (req, res) => {
  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
    ? req.query.date
    : new Date().toISOString().slice(0, 10);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT DISTINCT ON (c.id)
             c.id, c.first_name, c.last_name, c.room_id AS child_room_id,
             COALESCE(b.room_id, c.room_id) AS room_id,
             r.name AS room_name, b.funded, b.id AS booking_id
      FROM child_bookings b
      JOIN children c ON c.id = b.child_id
      LEFT JOIN rooms r ON r.id = COALESCE(b.room_id, c.room_id)
      WHERE b.is_active = true
        AND COALESCE(c.is_active, true) = true
        AND COALESCE(c.is_demo, false) = false
        AND $1::date BETWEEN b.start_date AND COALESCE(b.end_date, DATE '2100-01-01')
        AND CASE EXTRACT(DOW FROM $1::date)::int
              WHEN 1 THEN b.mon WHEN 2 THEN b.tue WHEN 3 THEN b.wed
              WHEN 4 THEN b.thu WHEN 5 THEN b.fri ELSE false END
      ORDER BY c.id, b.start_date DESC
    `, [date]);
    res.json({ date, count: rows.length, children: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Parent extra-session requests (manager review) ──────────────────────────
// Parents submit via the CF-Access twin POST /welcome/bookings/api/request
// (server-unified.js). These are REQUESTS awaiting manager approval — approving
// does NOT auto-create a confirmed booking (ratios/space are the manager's call);
// the manager can then add a real pattern via POST /api/bookings if they choose.
let _bookingReqReady = false;
async function ensureBookingRequests(db) {
  if (_bookingReqReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_requests (
      id serial PRIMARY KEY,
      child_id integer NOT NULL REFERENCES children(id),
      requested_by_email text NOT NULL,
      request_date date NOT NULL,
      session text,
      notes text,
      status text NOT NULL DEFAULT 'pending',
      resolved_by integer,
      resolved_at timestamptz,
      resolution_notes text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_booking_requests_status ON booking_requests(status);
    CREATE INDEX IF NOT EXISTS idx_booking_requests_child ON booking_requests(child_id);
  `);
  _bookingReqReady = true;
}

// GET /api/bookings/requests?status=pending — manager list of parent requests
router.get('/requests', async (req, res) => {
  if (!requireManager(req, res)) return;
  try {
    const db = getPool();
    await ensureBookingRequests(db);
    const status = ['pending', 'approved', 'declined'].includes(req.query.status) ? req.query.status : null;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE br.status = $1`; }
    const { rows } = await db.query(`
      SELECT br.*, c.first_name, c.last_name, r.name AS room_name
      FROM booking_requests br
      JOIN children c ON c.id = br.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      ${where}
      ORDER BY (br.status='pending') DESC, br.request_date ASC, br.id DESC
      LIMIT 200
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bookings/requests/:id/resolve  { decision:'approved'|'declined', notes }
router.post('/requests/:id/resolve', async (req, res) => {
  if (!requireManager(req, res)) return;
  const decision = req.body && req.body.decision;
  if (!['approved', 'declined'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'declined'" });
  }
  const notes = (req.body.notes || '').slice(0, 500) || null;
  try {
    const db = getPool();
    await ensureBookingRequests(db);
    const { rows } = await db.query(`
      UPDATE booking_requests
         SET status=$1, resolution_notes=$2, resolved_by=$3, resolved_at=NOW()
       WHERE id=$4 AND status='pending'
       RETURNING *
    `, [decision, notes, req.user.id, parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: 'Request not found or already resolved' });
    const resolved = rows[0];
    // b405 (2026-10-06) — billing bridge: an approved extra-session request gets a dated
    // ladn.child_fee_items row. 2026-10-21: the invoice generator now reads those rows
    // (src/lib/extra-sessions.js), so the session goes onto the family's NEXT invoice at
    // their normal session rate — nobody adds it by hand any more.
    if (decision === 'approved') {
      try {
        await XS.recordExtraSession(db, {
          childId: resolved.child_id, date: isoDay(resolved.request_date), session: resolved.session,
          source: 'booking-approval', meta: { booking_request_id: resolved.id, approved_by: req.user.id },
        });
      } catch (e) { console.error('booking approval -> child_fee_items:', e.message); }
    }
    // The family hears back in the app (a bell on their child) — never by email.
    await notifyFamily(db, resolved, decision);
    // b535 — approving a request puts a chargeable session on the account, so say which
    // invoices that has just changed.
    res.json(Object.assign({}, resolved,
      decision === 'approved' ? { stale_invoices: await PRICING.staleForChild(db, resolved.child_id) } : {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bookings/extra-session  { child_id, date:'YYYY-MM-DD', session:'full'|'am'|'pm', notes }
// 2026-10-21 — staff put a one-off extra session straight onto a child's account (no parent
// request needed). It is stored the same way as an approved parent request — an 'approved'
// booking_requests row, so it shows in the same lists and in the parents' Bookings page —
// and goes onto the family's next invoice at their normal session rate.
router.post('/extra-session', async (req, res) => {
  if (!requireManager(req, res)) return;
  const b = req.body || {};
  const childId = parseInt(b.child_id, 10);
  const date = String(b.date || '');
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'child_id required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
  }
  const session = XS.normSession(b.session);
  const notes = (b.notes || '').toString().slice(0, 500) || null;
  const db = getPool();
  try {
    await ensureBookingRequests(db);
    const { rows: kid } = await db.query('SELECT id FROM children WHERE id=$1', [childId]);
    if (!kid.length) return res.status(404).json({ error: 'Child not found' });
    const { rows } = await db.query(`
      INSERT INTO booking_requests
        (child_id, requested_by_email, request_date, session, notes, status, resolved_by, resolved_at, resolution_notes)
      VALUES ($1, $2, $3, $4, $5, 'approved', $6, NOW(), 'Added by the nursery')
      RETURNING *
    `, [childId, `staff:${req.user.id}`, date, session, notes, req.user.id]);
    const br = rows[0];
    const fee = await XS.recordExtraSession(db, {
      childId, date, session, source: 'staff-extra-session',
      meta: { booking_request_id: br.id, added_by: req.user.id },
    });
    await notifyFamily(db, br, 'added');
    res.status(201).json({ ...br, price_pence: fee.price_pence, child_fee_item_id: fee.id,
                           stale_invoices: await PRICING.staleForChild(db, childId) });   // b535
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b238 (2026-08-27) — NEW STARTERS: every starter must have a booking pattern
// Spec: wren-docs/ey-portal-restructure-2026-08-27.md §10 / brief §4
//
//   "Every starter must have the right booking pattern. On the New Starters
//    screen: show each starter's pattern, flag any starter with no pattern or an
//    incomplete one, and let it be set there."
//
// A starter here is a CHILD who has recently joined or is about to: start_date in
// the last 90 days or any time in the future. That is the same notion the EY home
// screen's "New starters" chip already uses (future start_date), widened backwards
// so a child who started three weeks ago with no pattern still shows up — that is
// exactly the case this exists to catch.
//
// Problems a starter can have:
//   · missing    — no active child_bookings row at all
//   · no_days    — a pattern exists but no weekday is ticked
//   · not_started — the pattern begins after the child's own start date, so they
//                   are expected on day one and booked for nobody
//   · ended      — every pattern's end_date is already in the past
// ═══════════════════════════════════════════════════════════════════════════

const STARTER_LOOKBACK_DAYS = 90;

// GET /api/bookings/starters?days=90
// Read is open to any authenticated staff member (they need to SEE the gap);
// writing a pattern stays manager/deputy-only via the existing POST/PUT above.
router.get('/starters', async (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || STARTER_LOOKBACK_DAYS));
  try {
    const db = getPool();
    const { rows } = await db.query(`
      WITH starters AS (
        SELECT c.id, c.first_name, c.last_name, c.room_id, c.start_date,
               c.date_of_birth, c.enrolment_status, r.name AS room_name
          FROM children c
          LEFT JOIN rooms r ON r.id = c.room_id
         WHERE COALESCE(c.is_active, true) = true
           AND COALESCE(c.enrolment_status, 'attending') <> 'left'
           AND c.leave_date IS NULL
           AND c.start_date IS NOT NULL
           AND c.start_date >= (CURRENT_DATE - ($1::int || ' days')::interval)
      )
      SELECT s.*,
             b.id AS booking_id, b.mon, b.tue, b.wed, b.thu, b.fri,
             b.start_date AS booking_start, b.end_date AS booking_end,
             b.funded, b.notes AS booking_notes, b.room_id AS booking_room_id
        FROM starters s
        LEFT JOIN LATERAL (
          SELECT * FROM child_bookings cb
           WHERE cb.child_id = s.id AND cb.is_active = true
           ORDER BY cb.start_date DESC, cb.id DESC
           LIMIT 1
        ) b ON true
       ORDER BY s.start_date DESC, s.id
    `, [days]);

    const today = new Date().toISOString().slice(0, 10);
    const ymdOf = (d) => {
      if (!d) return null;
      // node-pg hands DATE back as a local-midnight JS Date; toISOString() would
      // shift it a day under BST. Local getters only.
      if (d instanceof Date) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      return String(d).slice(0, 10);
    };

    const children = rows.map(r => {
      const days_ticked = ['mon', 'tue', 'wed', 'thu', 'fri'].filter(d => r[d] === true);
      const bStart = ymdOf(r.booking_start);
      const bEnd = ymdOf(r.booking_end);
      const cStart = ymdOf(r.start_date);
      let problem = null;
      if (!r.booking_id) problem = 'missing';
      else if (!days_ticked.length) problem = 'no_days';
      else if (bEnd && bEnd < today) problem = 'ended';
      else if (cStart && bStart && bStart > cStart) problem = 'not_started';
      return {
        child_id: r.id,
        first_name: r.first_name,
        last_name: r.last_name,
        room_id: r.room_id,
        room_name: r.room_name,
        start_date: cStart,
        enrolment_status: r.enrolment_status
          || (cStart && cStart > today ? 'confirmed' : 'attending'),
        booking: r.booking_id ? {
          id: r.booking_id, mon: r.mon, tue: r.tue, wed: r.wed, thu: r.thu, fri: r.fri,
          days: days_ticked, day_count: days_ticked.length,
          start_date: bStart, end_date: bEnd,
          funded: r.funded, notes: r.booking_notes, room_id: r.booking_room_id,
        } : null,
        problem,
        ok: problem === null,
      };
    });

    res.json({
      days,
      total: children.length,
      complete: children.filter(c => c.ok).length,
      needs_attention: children.filter(c => !c.ok).length,
      by_problem: ['missing', 'no_days', 'ended', 'not_started'].reduce((acc, k) => {
        acc[k] = children.filter(c => c.problem === k).length; return acc;
      }, {}),
      children,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bookings/starters/audit — the same question, counts and CHILD IDS only.
// Deliberately name-free: this is what a log, a cron or a build note may quote.
// build-logs is world-readable and unrotated, so nothing here may carry a name.
router.get('/starters/audit', async (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || STARTER_LOOKBACK_DAYS));
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id,
             (b.id IS NULL) AS no_pattern,
             COALESCE((b.mon OR b.tue OR b.wed OR b.thu OR b.fri), false) AS any_day,
             (b.end_date IS NOT NULL AND b.end_date < CURRENT_DATE) AS expired,
             (b.start_date IS NOT NULL AND b.start_date > c.start_date) AS starts_late
        FROM children c
        LEFT JOIN LATERAL (
          SELECT * FROM child_bookings cb
           WHERE cb.child_id = c.id AND cb.is_active = true
           ORDER BY cb.start_date DESC, cb.id DESC LIMIT 1
        ) b ON true
       WHERE COALESCE(c.is_active, true) = true
         AND COALESCE(c.enrolment_status, 'attending') <> 'left'
         AND c.leave_date IS NULL
         AND c.start_date IS NOT NULL
         AND c.start_date >= (CURRENT_DATE - ($1::int || ' days')::interval)
       ORDER BY c.id
    `, [days]);

    const bucket = (r) => r.no_pattern ? 'missing'
      : !r.any_day ? 'no_days'
      : r.expired ? 'ended'
      : r.starts_late ? 'not_started'
      : null;

    const out = { missing: [], no_days: [], ended: [], not_started: [] };
    let ok = 0;
    for (const r of rows) {
      const b = bucket(r);
      if (b) out[b].push(r.id); else ok += 1;
    }
    res.json({
      days,
      total: rows.length,
      complete: ok,
      needs_attention: rows.length - ok,
      counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])),
      child_ids: out,     // ids only — never names
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.computeEndDate = computeEndDate;
module.exports.loadSessionTypes = loadSessionTypes;
