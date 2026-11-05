const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { operationalChildFilter, ensureEnrolmentMiddleware } = require('../utils/enrolment'); // b96
const { recordAudit } = require('../utils/audit');
const CLOCKDAY = require('../lib/clock-day');
router.use(ensureEnrolmentMiddleware(getPool));

// b495 (M4) — staff_id || req.user.id let ANY authenticated staff member clock
// another staff member in/out (or start/end their break) just by naming their
// id in the body. Only the signed-in person, or a manager acting on someone
// else's behalf, may do this — and the manager case is audited.
function _resolveClockTarget(req, res) {
  const requested = req.body.staff_id ? Number(req.body.staff_id) : req.user.id;
  if (requested === req.user.id) return requested;
  const isManager = authenticate.rolesHeldBy(req.user.role).includes('manager');
  if (!isManager) { res.status(403).json({ error: 'You can only clock yourself in or out.' }); return null; }
  recordAudit({
    req, action: 'update', entity_type: 'staff_attendance', entity_id: requested,
    meta: { action_detail: 'manager_clocked_other_staff', clocked_staff_id: requested },
  });
  return requested;
}

// b495 review F3 — the one way this file writes the shared clock store. Skips a
// repeat (same direction as the person's latest live event today, or a clock-out
// with nothing to close) so a double tap / second tab never adds a phantom row,
// then recomputes the derived shift like every other writer.
async function _writeClockEvent(db, staffId, type, recordedBy, source, method, raw) {
  try {
    const last = await CLOCKDAY.lastEvent(db, staffId, CLOCKDAY.londonToday());
    if (last && last.event_type === type) return false;
    if (!last && type === 'clock_out') return false;
    await db.query(
      `INSERT INTO staff_clock_events (staff_id, event_type, method, event_time, source, recorded_by, source_raw)
       VALUES ($1, $2, $3, NOW(), $4, $5, $6)`,
      [staffId, type, method, source, recordedBy, JSON.stringify(raw || {})]);
    CLOCKDAY.recomputeDay(db, staffId, CLOCKDAY.londonToday()).catch(() => {});
    return true;
  } catch (e) { console.error('[attendance] clock_events write failed:', e.message); return false; }
}

// b495 review F2 — the kiosk used to 500 on every call (missing 'bcrypt'), so it was
// dead. Fixed, it is a public PIN check: give it the same boundary and lockout as the
// EY sign-in board (staff-signin.js /toggle) — on-site or staff JWT, never the parents
// host, 5 wrong PINs → 5-minute lock, one generic failure (no staff-id enumeration).
const _kioskFails = new Map();
function _kioskLockSecs(id) { const f = _kioskFails.get(id); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
function _kioskFail(id) { const f = _kioskFails.get(id) || { n: 0, until: 0 }; f.n += 1; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 5 * 60 * 1000; } _kioskFails.set(id, f); }
function _attHasStaffJwt(req) {
  const tok = (req.headers['authorization'] || '').startsWith('Bearer ') ? req.headers['authorization'].slice(7) : (req.headers['x-wren-token'] || '');
  if (!tok) return false;
  try { const d = require('jsonwebtoken').verify(tok, process.env.JWT_SECRET); return !!(d && Number(d.id) > 0 && d.role !== 'parent' && d.aud !== 'parents'); }
  catch { return false; }
}

// Public endpoint — PIN-validated kiosk (no JWT)
router.post('/staff/kiosk-action', async (req, res) => {
  const { pin, action } = req.body;
  const staff_id = parseInt(req.body.staff_id, 10);
  if (!staff_id || !pin || !action) return res.status(400).json({ error: 'staff_id, pin, action required' });
  if (req._portal === 'parents' || (!_attIsOnSite(req) && !_attHasStaffJwt(req))) {
    return res.status(403).json({ error: 'The clock-in kiosk is only available on the nursery network.' });
  }
  const lockSecs = _kioskLockSecs(staff_id);
  if (lockSecs) return res.status(429).json({ error: `Too many attempts. Try again in ${lockSecs}s.` });
  try {
    const db = getPool();
    const bcrypt = require('bcryptjs'); // 'bcrypt' (native) is not installed in this image — see src/routes/auth.js etc.
    const { rows: staffRows } = await db.query(
      'SELECT id, first_name, pin_hash FROM staff WHERE id=$1 AND is_active=true', [staff_id]
    );
    const staff = staffRows[0];
    const pinMatch = staff && staff.pin_hash ? await bcrypt.compare(String(pin), staff.pin_hash) : false;
    if (!pinMatch) { _kioskFail(staff_id); return res.status(401).json({ error: 'Invalid PIN' }); }
    _kioskFails.delete(staff_id);

    let result;
    if (action === 'clock_in') {
      const dow = new Date().getDay();
      const { rows: sched } = await db.query(
        'SELECT start_time, end_time FROM timetable WHERE staff_id=$1 AND day_of_week=$2 LIMIT 1', [staff_id, dow]
      );
      const { rows } = await db.query(`
        INSERT INTO staff_attendance (staff_id, date, clock_in, source, scheduled_start, scheduled_end)
        VALUES ($1, CURRENT_DATE, NOW(), 'kiosk', $2, $3)
        ON CONFLICT (staff_id, date) DO UPDATE SET clock_in=NOW(), source='kiosk'
        RETURNING *
      `, [staff_id, sched[0]?.start_time || null, sched[0]?.end_time || null]);
      result = rows[0];
      await _writeClockEvent(db, staff_id, 'clock_in', staff_id, 'kiosk', 'pin', { via: 'kiosk-action' });
    } else if (action === 'clock_out') {
      const { rows: ex } = await db.query('SELECT clock_in FROM staff_attendance WHERE staff_id=$1 AND date=CURRENT_DATE', [staff_id]);
      let hw = null;
      if (ex[0]?.clock_in) hw = Math.round((Date.now() - new Date(ex[0].clock_in).getTime()) / 36000) / 100;
      const { rows } = await db.query(
        'UPDATE staff_attendance SET clock_out=NOW(), hours_worked=$2 WHERE staff_id=$1 AND date=CURRENT_DATE RETURNING *',
        [staff_id, hw]
      );
      result = rows[0];
      await _writeClockEvent(db, staff_id, 'clock_out', staff_id, 'kiosk', 'pin', { via: 'kiosk-action' });
    } else if (action === 'break_start') {
      const { rows } = await db.query('UPDATE staff_attendance SET break_start=NOW() WHERE staff_id=$1 AND date=CURRENT_DATE RETURNING *', [staff_id]);
      result = rows[0];
    } else if (action === 'break_end') {
      const { rows } = await db.query('UPDATE staff_attendance SET break_end=NOW() WHERE staff_id=$1 AND date=CURRENT_DATE RETURNING *', [staff_id]);
      result = rows[0];
    }
    res.json({ ok: true, staff_name: staff.first_name, result });
  } catch (e) {
    console.error('[attendance] kiosk-action failed:', e);
    res.status(500).json({ error: 'Could not record that action — try again.' });
  }
});

// On-site guard for public attendance board (H4 fix)
const _attNurseryIp = process.env.NURSERY_PUBLIC_IP;
function _attIsOnSite(req) {
  const ip = (req.headers['cf-connecting-ip'] || '').trim()
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.ip || '').replace('::ffff:', '').trim();
  if (!ip) return false;
  if (ip === _attNurseryIp) return true;
  if (/^127\./.test(ip) || ip === '::1') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  const m = ip.match(/^100\.(\d+)\./);
  if (m && +m[1] >= 64 && +m[1] <= 127) return true;
  return false;
}

// Public endpoint — all staff clock status (for kiosk display)
// H4: gated — allow JWT or on-site, else 403
router.get('/staff/today', async (req, res) => {
  const hasJwt = !!(req.headers['authorization'] || '').startsWith('Bearer ');
  const tok = (req.headers['authorization'] || '').slice(7) || (req.headers['x-wren-token'] || '');
  let jwtOk = false;
  if (hasJwt) {
    try {
      const { verify } = require('jsonwebtoken');
      const d = verify(tok, process.env.JWT_SECRET);
      if (d && Number(d.id) > 0) jwtOk = true;
    } catch {}
  }
  if (!jwtOk && !_attIsOnSite(req)) {
    return res.status(403).json({ error: 'Attendance board is only available on the nursery network or with staff login.' });
  }
  // Allow without JWT for kiosk (on-site)
  try {
    const db = getPool();
    // b495 (M4) — the EY sign-in board (staff-signin.js) writes staff_clock_events
    // and never touches staff_attendance, so a staff member who signed in on the
    // board looked "not in" on this page. staff_clock_events_current is the shared
    // source of truth for "are they actually in right now"; staff_attendance stays
    // the source for breaks/scheduled times/hours_worked, which clock_events does
    // not model at all.
    const { rows } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.role, s.room_id, r.name as room_name,
        -- b495 review F3: when there are events, they decide. clock_out is only set when the
        -- LATEST event is a clock-out — out at 12:30 and back at 13:15 is "in", as on the board.
        CASE WHEN ce.last_type IS NULL THEN sa.clock_in ELSE ce.first_in END AS clock_in,
        CASE WHEN ce.last_type IS NULL THEN sa.clock_out
             WHEN ce.last_type = 'clock_out' THEN ce.last_out END AS clock_out,
        sa.break_start, sa.break_end,
        sa.scheduled_start, sa.scheduled_end, sa.hours_worked
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      LEFT JOIN staff_attendance sa ON sa.staff_id = s.id AND sa.date = CURRENT_DATE
      LEFT JOIN LATERAL (
        SELECT
          MIN(event_time) FILTER (WHERE event_type = 'clock_in')  AS first_in,
          MAX(event_time) FILTER (WHERE event_type = 'clock_out') AS last_out,
          (ARRAY_AGG(event_type ORDER BY event_time DESC, id DESC))[1] AS last_type
        FROM staff_clock_events_current e
        WHERE e.staff_id = s.id
          AND (e.event_time AT TIME ZONE 'Europe/London')::date = CURRENT_DATE
      ) ce ON true
      WHERE s.is_active = true
      ORDER BY r.name, s.first_name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.use(authenticate);

// GET /today — all children with today's attendance
router.get('/today', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.room_id, c.allergies,
             r.name as room_name,
             a.attendance_id, a.sign_in_time, a.sign_out_time,
             a.absent, a.absence_reason, a.session,
             ev.events,
             -- item 5: is the child expected/booked in today? (mirrors seed-daily-register)
             COALESCE(bk.booked, false) AS booked,
             COALESCE(c.is_demo, false) AS is_demo   -- b484 port: register lists it, header counts skip it
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      -- Collapse ALL of today's attendance rows for a child into ONE register entry.
      -- A child can end up with >1 row/day (a booking/EyLog shell in one session PLUS
      -- a staff sign-in in another). Before this, the LEFT JOIN returned the child twice
      -- — once "In", once "Not in" — so a genuine sign-in looked like it "didn't stick".
      -- Pick ONE representative row (a currently-in row wins) and report its
      -- sign_in_time AND sign_out_time TOGETHER. The old version took min(sign_in)
      -- and max(sign_out) ACROSS all rows, so a child with a stale earlier row
      -- (e.g. an EyLog/booking shell already "out") reported a sign_out_time even
      -- while genuinely signed in on another row — the register showed them "out"
      -- and the Sign Out button stayed disabled (2026-07-30 fix).
      LEFT JOIN LATERAL (
        SELECT rep.id AS attendance_id, rep.sign_in_time, rep.sign_out_time,
               rep.session,
               (agg.any_absent AND NOT agg.any_signin) AS absent,
               rep.absence_reason
        FROM (
          SELECT a0.id, a0.sign_in_time, a0.sign_out_time, a0.absence_reason,
                 COALESCE(a0.session, 'full_day') AS session
          FROM attendance a0
          WHERE a0.child_id = c.id AND a0.date = CURRENT_DATE
          ORDER BY (a0.sign_in_time IS NOT NULL) DESC, (a0.sign_out_time IS NULL) DESC, a0.id DESC
          LIMIT 1
        ) rep
        CROSS JOIN (
          SELECT bool_or(a1.absent) AS any_absent,
                 bool_or(a1.sign_in_time IS NOT NULL) AS any_signin
          FROM attendance a1 WHERE a1.child_id = c.id AND a1.date = CURRENT_DATE
        ) agg
      ) a ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('event', e.event, 'at', e.at) ORDER BY e.at) AS events
        FROM attendance_events e WHERE e.child_id=c.id AND e.date=CURRENT_DATE
      ) ev ON true
      LEFT JOIN LATERAL (
        SELECT true AS booked
        FROM child_bookings b
        WHERE b.child_id = c.id AND b.is_active = true
          AND CURRENT_DATE BETWEEN b.start_date AND COALESCE(b.end_date, DATE '2100-01-01')
          AND CASE EXTRACT(DOW FROM CURRENT_DATE)::int
                WHEN 1 THEN b.mon WHEN 2 THEN b.tue WHEN 3 THEN b.wed
                WHEN 4 THEN b.thu WHEN 5 THEN b.fri ELSE false END
        LIMIT 1
      ) bk ON true
      WHERE ${operationalChildFilter('c')}
      ORDER BY r.name, c.first_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /sign-in
router.post('/sign-in', async (req, res) => {
  const { child_id, session } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO attendance (child_id, date, session, sign_in_time, signed_in_by)
      VALUES ($1, CURRENT_DATE, $2, NOW(), $3)
      ON CONFLICT (child_id, date, session)
      DO UPDATE SET sign_in_time=COALESCE(attendance.sign_in_time, NOW()), sign_out_time=NULL,
                    signed_in_by=$3, absent=false, absence_reason=NULL,
                    collected_by=NULL, signed_out_by=NULL
      RETURNING *
    `, [child_id, session || 'full_day', req.user.id]);
    // Event log (2026-07-10): children can leave for an appointment and return —
    // every in/out is recorded here; the attendance row keeps first-in/last-out.
    await db.query(`INSERT INTO attendance_events (child_id, event, by_staff) VALUES ($1,'in',$2)`,
      [child_id, req.user.id]).catch(() => {});

    // When child arrives back, un-finalise diary (they may add more entries today)
    await db.query(
      'UPDATE daily_diary SET finalised_at=NULL WHERE child_id=$1 AND date=CURRENT_DATE',
      [child_id]
    ).catch(() => {});

    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /sign-out
router.post('/sign-out', async (req, res) => {
  const { child_id, session, collected_by } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();

    // SAFEGUARDING: block collection by a barred / court-order person (s06).
    // FAIL-CLOSED — if this check errors for ANY reason we BLOCK the sign-out.
    // A child under a court-order restriction must never be signed out to a barred
    // person because a lookup failed. Columns match ladn.carer_restrictions exactly:
    //   restricted_person_name / active / details (NOT collector_name/is_active/notes).
    if (collected_by) {
      let restrictions;
      try {
        ({ rows: restrictions } = await db.query(
          `SELECT id, restriction_type, details FROM carer_restrictions
           WHERE child_id=$1
             AND lower(trim(restricted_person_name)) = lower(trim($2))
             AND active = true`,
          [child_id, collected_by]
        ));
      } catch (e) {
        // Could not verify restrictions — cannot prove the collector is safe → BLOCK.
        return res.status(503).json({
          error: 'Collection blocked',
          reason: 'Unable to verify collection restrictions — sign-out blocked for safety. Please check with a manager.',
          detail: e.message
        });
      }

      if (restrictions.length > 0) {
        const r = restrictions[0];
        return res.status(403).json({
          error: 'Collection blocked',
          reason: `${r.restriction_type}: ${r.details || 'Court order / safeguarding restriction'}`,
          restriction_id: r.id
        });
      }
    }

    // Set sign_out_time + collected_by on attendance record
    const { rows } = await db.query(`
      INSERT INTO attendance (child_id, date, session, sign_out_time, signed_out_by, collected_by)
      VALUES ($1, CURRENT_DATE, $2, NOW(), $3, $4)
      ON CONFLICT (child_id, date, session)
      DO UPDATE SET sign_out_time=NOW(), signed_out_by=$3, collected_by=$4
      RETURNING *
    `, [child_id, session || 'full_day', req.user.id, collected_by || null]);
    await db.query(`INSERT INTO attendance_events (child_id, event, by_staff) VALUES ($1,'out',$2)`,
      [child_id, req.user.id]).catch(() => {});

    // Finalise today's diary entries for this child (they were drafts while live)
    await db.query(
      'UPDATE daily_diary SET finalised_at=NOW() WHERE child_id=$1 AND date=CURRENT_DATE AND finalised_at IS NULL',
      [child_id]
    ).catch(() => {});
    // diarypub-20261028: signed out → today's diary goes out to the family (drafts → published)
    await require('../lib/diary-auto-publish').publishRevealedDiaries(db, { childId: child_id })
      .catch(e => console.error('[diary-auto-publish] sign-out:', e.message));

    // Create parent notification about collection
    if (collected_by) {
      const { rows: childRows } = await db.query(
        `SELECT first_name, last_name FROM children WHERE id=$1`, [child_id]
      );
      if (childRows.length) {
        const child = childRows[0];
        const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const title = `${child.first_name} collected`;
        const body = `${child.first_name} ${child.last_name || ''} was collected at ${now} by ${collected_by}`;

        await db.query(
          `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, priority)
           VALUES ('parent', $1, 'collection', $2, $3, 'normal')`,
          [child_id, title, body]
        ).catch(() => {}); // Graceful failure if notifications table doesn't exist in dev
      }
    }

    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /mark-absent
router.post('/mark-absent', async (req, res) => {
  const { child_id, absence_reason, session } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO attendance (child_id, date, session, absent, absence_reason)
      VALUES ($1, CURRENT_DATE, $2, true, $3)
      ON CONFLICT (child_id, date, session)
      DO UPDATE SET absent=true, absence_reason=$3
      RETURNING *
    `, [child_id, session || 'full_day', absence_reason || null]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId — history
router.get('/child/:childId', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT * FROM attendance
      WHERE child_id=$1 AND date >= CURRENT_DATE - INTERVAL '${days} days'
      ORDER BY date DESC
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /staff/clock-in — auto clock-in on login
router.post('/staff/clock-in', async (req, res) => {
  const staffId = _resolveClockTarget(req, res);
  if (staffId == null) return;
  const source = req.body.source || 'portal_login';
  try {
    const db = getPool();
    // Look up scheduled start from timetable
    const dow = new Date().getDay(); // 0=Sun
    const { rows: sched } = await db.query(
      'SELECT start_time, end_time FROM timetable WHERE staff_id=$1 AND day_of_week=$2 LIMIT 1',
      [staffId, dow]
    );
    const schedStart = sched[0]?.start_time || null;
    const schedEnd = sched[0]?.end_time || null;

    const { rows } = await db.query(`
      INSERT INTO staff_attendance (staff_id, date, clock_in, source, scheduled_start, scheduled_end)
      VALUES ($1, CURRENT_DATE, NOW(), $2, $3, $4)
      ON CONFLICT (staff_id, date) DO NOTHING
      RETURNING *
    `, [staffId, source, schedStart, schedEnd]);
    // b495 (M4) — also write the shared clock_events store (what the EY sign-in
    // board and the fob both read/write) so a clock-in made from this page isn't
    // invisible there. Review F3: ONLY for an explicit action (the staff-clock page
    // names staff_id). wren-shell.js's automatic "clock in on first page load" posts
    // no body — it must never put someone back "in" on the board / fire list.
    if (req.body && req.body.staff_id != null) {
      await _writeClockEvent(db, staffId, 'clock_in', req.user.id, 'staff_clock_page', 'app', { via: 'staff-clock-page', source });
    }
    res.json(rows[0] || { skipped: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /staff/clock-out
router.post('/staff/clock-out', async (req, res) => {
  const staffId = _resolveClockTarget(req, res);
  if (staffId == null) return;
  try {
    const db = getPool();
    const { rows: existing } = await db.query(
      'SELECT clock_in FROM staff_attendance WHERE staff_id=$1 AND date=CURRENT_DATE', [staffId]
    );
    const clockIn = existing[0]?.clock_in;
    let hoursWorked = null;
    if (clockIn) {
      const diffMs = Date.now() - new Date(clockIn).getTime();
      hoursWorked = Math.round((diffMs / 3600000) * 100) / 100;
    }
    const { rows } = await db.query(`
      UPDATE staff_attendance SET clock_out=NOW(), hours_worked=$2
      WHERE staff_id=$1 AND date=CURRENT_DATE
      RETURNING *
    `, [staffId, hoursWorked]);
    await _writeClockEvent(db, staffId, 'clock_out', req.user.id, 'staff_clock_page', 'app', { via: 'staff-clock-page' });
    res.json(rows[0] || { skipped: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /staff/break-start
router.post('/staff/break-start', async (req, res) => {
  const staffId = _resolveClockTarget(req, res);
  if (staffId == null) return;
  try {
    const db = getPool();
    const { rows } = await db.query(
      // review F3: upsert — a board sign-in has no staff_attendance row, so UPDATE was a silent no-op
      `INSERT INTO staff_attendance (staff_id, date, break_start, source) VALUES ($1, CURRENT_DATE, NOW(), 'staff_clock_page')
       ON CONFLICT (staff_id, date) DO UPDATE SET break_start=NOW() RETURNING *`,
      [staffId]
    );
    res.json(rows[0] || { skipped: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /staff/break-end
router.post('/staff/break-end', async (req, res) => {
  const staffId = _resolveClockTarget(req, res);
  if (staffId == null) return;
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO staff_attendance (staff_id, date, break_end, source) VALUES ($1, CURRENT_DATE, NOW(), 'staff_clock_page')
       ON CONFLICT (staff_id, date) DO UPDATE SET break_end=NOW() RETURNING *`,
      [staffId]
    );
    res.json(rows[0] || { skipped: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /staff/:id — history for a staff member
// GET /summary — attendance summary for admin dashboard
// Uses attendance_pct column on children (primary) or attendance table (EYFS)
router.get('/summary', authenticate, async (req, res) => {
  try {
    const db = getPool();
    // Primary: use attendance_pct on children
    const { rows: childRows } = await db.query(
      `SELECT id, first_name, last_name, year_group, attendance_pct, is_active FROM children WHERE is_active=true AND is_demo=false`
    ).catch(() => ({ rows: [] }));

    if (childRows.length) {
      const withPct = childRows.filter(c => c.attendance_pct != null);
      const avg = withPct.length ? (withPct.reduce((s,c) => s + parseFloat(c.attendance_pct||0), 0) / withPct.length).toFixed(1) : null;
      const paCount = withPct.filter(c => parseFloat(c.attendance_pct) < 90).length;
      const paPct = withPct.length ? ((paCount / childRows.length) * 100).toFixed(1) : '0.0';

      // Breakdown by year group
      const byYear = {};
      for (const c of withPct) {
        const yr = c.year_group || 'Unknown';
        if (!byYear[yr]) byYear[yr] = { sum: 0, count: 0 };
        byYear[yr].sum += parseFloat(c.attendance_pct);
        byYear[yr].count++;
      }
      const byYearArr = Object.entries(byYear).map(([yr, v]) => ({
        year_group: yr, avg_pct: (v.sum / v.count).toFixed(1), count: v.count
      })).sort((a,b) => a.year_group > b.year_group ? 1 : -1);

      const paList = childRows
        .filter(c => c.attendance_pct != null && parseFloat(c.attendance_pct) < 90)
        .map(c => ({ id: c.id, name: c.first_name+' '+c.last_name, attendance_pct: c.attendance_pct, year_group: c.year_group }));

      return res.json({
        overall_pct: avg, weekly_pct: avg,
        pa_pct: paPct, pa_count: paCount,
        by_year: byYearArr, pa_pupils: paList
      });
    }

    // EYFS fallback: count today's sign-ins
    const today = new Date().toISOString().slice(0,10);
    const { rows } = await db.query(
      `SELECT COUNT(*) as present, COUNT(DISTINCT child_id) as total
       FROM attendance WHERE date=$1 AND absent=false`, [today]
    ).catch(() => ({ rows: [{ present: 0, total: 0 }] }));
    res.json({ overall_pct: null, weekly_pct: null, pa_pct: '0', ...rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/staff/:id', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT * FROM staff_attendance
      WHERE staff_id=$1
      ORDER BY date DESC LIMIT $2
    `, [req.params.id, days]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b238 (2026-08-27) — MORNING AND AFTERNOON REGISTER
// Spec: wren-docs/ey-portal-restructure-2026-08-27.md §7
//   "Keep the child register in More. Morning register and afternoon register."
//
// Why a separate table (ladn.register_checks) rather than attendance.session:
// every attendance row in both wren and wren_dev carries session='full_day'
// (verified 2026-08-27), so the split cannot be derived from what is there.
// attendance records the child's DAY — arrival to collection — and is written by
// sign-in/sign-out, the EyLog import and the booking seed. The register is a
// different act: a named person counted the room at a point in time. Overloading
// one column with three writers would also collide with the
// (child_id, date, session) unique constraint the register seed relies on.
//
// See scripts/b238-ey-restructure-schema.sql for the DDL.
// ═══════════════════════════════════════════════════════════════════════════

const REGISTER_SESSIONS = ['morning', 'afternoon'];

function _regSession(v) {
  const s = String(v || '').toLowerCase();
  if (REGISTER_SESSIONS.includes(s)) return s;
  // No session asked for: default to whichever one is being taken right now.
  return new Date().getHours() < 13 ? 'morning' : 'afternoon';
}
function _regDate(v) {
  return (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;   // null → CURRENT_DATE in SQL
}

// GET /api/attendance/register?session=morning|afternoon&date=YYYY-MM-DD
// Who should be on this session's register, and who has already been counted.
router.get('/register', authenticate, async (req, res) => {
  const session = _regSession(req.query.session);
  const date = _regDate(req.query.date);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id AS child_id, c.first_name, c.last_name, c.room_id, r.name AS room_name,
             rc.id AS check_id, rc.present, rc.note, rc.taken_at,
             s.first_name AS taken_by_first_name,
             -- the child's own day, for context next to the count
             a.sign_in_time, a.sign_out_time, a.absent
        FROM children c
        LEFT JOIN rooms r ON r.id = c.room_id
        LEFT JOIN register_checks rc
               ON rc.child_id = c.id
              AND rc.check_date = COALESCE($1::date, CURRENT_DATE)
              AND rc.session = $2
        LEFT JOIN staff s ON s.id = rc.taken_by
        LEFT JOIN LATERAL (
          SELECT a0.sign_in_time, a0.sign_out_time, a0.absent
            FROM attendance a0
           WHERE a0.child_id = c.id AND a0.date = COALESCE($1::date, CURRENT_DATE)
           ORDER BY (a0.sign_in_time IS NOT NULL) DESC, a0.id DESC
           LIMIT 1
        ) a ON true
       WHERE ${operationalChildFilter('c')}
       ORDER BY r.name NULLS LAST, c.first_name, c.last_name
    `, [date, session]);

    const counted = rows.filter(r => r.check_id !== null);
    res.json({
      date: date || new Date().toISOString().slice(0, 10),
      session,
      total: rows.length,
      counted: counted.length,
      present: counted.filter(r => r.present).length,
      absent: counted.filter(r => !r.present).length,
      outstanding: rows.length - counted.length,
      children: rows.map(r => ({
        child_id: r.child_id, first_name: r.first_name, last_name: r.last_name,
        room_id: r.room_id, room_name: r.room_name,
        checked: r.check_id !== null,
        present: r.check_id !== null ? r.present : null,
        note: r.note, taken_at: r.taken_at, taken_by: r.taken_by_first_name || null,
        sign_in_time: r.sign_in_time, sign_out_time: r.sign_out_time, day_absent: r.absent,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/attendance/register  { child_id, session, present, note?, date? }
// Idempotent: taking the register twice corrects it rather than erroring, and
// records who corrected it and when.
router.post('/register', authenticate, async (req, res) => {
  const b = req.body || {};
  const childId = parseInt(b.child_id, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'child_id required' });
  if (typeof b.present !== 'boolean') return res.status(400).json({ error: 'present must be true or false' });
  const session = _regSession(b.session);
  const date = _regDate(b.date);
  try {
    const { rows } = await getPool().query(`
      INSERT INTO register_checks (child_id, check_date, session, present, note, taken_by)
      VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6)
      ON CONFLICT (child_id, check_date, session) DO UPDATE
        SET present = EXCLUDED.present,
            note     = EXCLUDED.note,
            taken_by = EXCLUDED.taken_by,
            taken_at = now()
      RETURNING *`,
      [childId, date, session, b.present, (b.note || null), req.user.id]);
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'child_id does not refer to a real child' });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
