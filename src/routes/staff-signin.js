// ── EyLog-style EY staff sign in/out (photo card + PIN) ──────────────────────
// Shared wall-tablet screen: a grid of practitioner photo cards; tap a card →
// enter PIN → toggles clock-in/out for that staff. Source of truth is
// ladn.staff_clock_events (event_type 'clock_in' / 'clock_out', method 'pin').
// This mirrors src/routes/clockin.js (fob/manual) so the existing /today kiosk
// board and staff_shifts reporting stay consistent.
//
// Auth posture (see report):
//   GET  /board   → on-site (nursery LAN / Tailscale) OR a valid staff JWT.
//                   No child/parent data is returned — only staff name, photo,
//                   role, and in/out status. Parent tokens are rejected.
//   POST /toggle  → PUBLIC but requires the staff member's correct PIN
//                   (bcrypt vs ladn.staff.pin_hash). Never special-cases id=1.
//                   Simple per-staff rate limit on wrong PINs.
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs'); // same module auth.js/parent-app-lock.js use ('bcrypt' is not installed)
const { getPool } = require('../db/pool');
// b310 — one derivation of a worked day, shared with src/routes/clockin.js.
const CLOCKDAY = require('../lib/clock-day');
// b404 — on-read auto sign-out: nobody who forgot to tap out stays "in"
// forever on the one screen that now shows it.
const CLOCKAUTO = require('../lib/clock-autoclose');

// ── Telegram helper (best-effort, mirrors clockin.js) ────────────────────────
// login-20261023: through the one Telegram sender (src/lib/notifications.js) — same text and format,
// plus its dev/MAIL_DISABLED guard, which this private copy never had.
function sendTelegram(text) { return require('../lib/notifications').sendTelegramNow({ text, parse_mode: null }); }

function fmtTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
}
function fmtDuration(minutes) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── On-site guard (copied from clockin.js so the kiosk works login-less) ─────
const _signinNurseryIp = process.env.NURSERY_PUBLIC_IP;
function _isOnSite(req) {
  const ip = (req.headers['cf-connecting-ip'] || '').trim()
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.ip || '').replace('::ffff:', '').trim();
  if (!ip) return false;
  if (ip === _signinNurseryIp) return true;
  if (/^127\./.test(ip) || ip === '::1') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  const m = ip.match(/^100\.(\d+)\./);
  if (m && +m[1] >= 64 && +m[1] <= 127) return true;
  return false;
}
function _hasStaffJwt(req) {
  const tok = (req.headers['authorization'] || '').startsWith('Bearer ')
    ? (req.headers['authorization'] || '').slice(7)
    : (req.headers['x-wren-token'] || '');
  if (!tok) return false;
  try {
    const { verify } = require('jsonwebtoken');
    const d = verify(tok, process.env.JWT_SECRET);
    // Staff token only — reject parent tokens (aud/role) as defence in depth.
    if (!d || !(Number(d.id) > 0)) return false;
    if (d.role === 'parent' || d.aud === 'parents') return false;
    return true;
  } catch { return false; }
}

// ── Derive current status from the latest clock event *today* ────────────────
async function currentStatus(db, staffId) {
  const { rows } = await db.query(
    // b310 — the _current view, not the base table: a superseded or voided event
    // must never decide which way the next PIN tap counts.
    `SELECT event_type, event_time
       FROM staff_clock_events_current
      WHERE staff_id = $1 AND (event_time AT TIME ZONE 'Europe/London')::date = CURRENT_DATE
      ORDER BY event_time DESC, id DESC
      LIMIT 1`,
    [staffId]
  );
  const last = rows[0];
  const isIn = last && last.event_type === 'clock_in';
  return { status: isIn ? 'in' : 'out', since: isIn ? last.event_time : null };
}

// ── GET /board — staff cards + status (on-site OR staff JWT) ─────────────────
router.get('/board', async (req, res) => {
  if (!_hasStaffJwt(req) && !_isOnSite(req)) {
    return res.status(403).json({ error: 'Sign-in board is only available on the nursery network or with staff login.' });
  }
  try {
    const db = getPool();
    // b404 — this is "the register page load" the brief names as the on-read
    // trigger point: close out anyone still "in" past closing time (+ grace) or past a
    // long gap, BEFORE the board is built, so the card itself tells the truth.
    // Fire-and-forget on a failure — a sweep going wrong must never block the
    // board from loading at all (same posture as b310Sweep in clockin.js).
    try { await CLOCKAUTO.autoCloseOverdueShifts(db); }
    catch (e) { console.error('[staff-signin/board] autoclose sweep:', e.message); }

    // b366 — the board reads every live event, whatever wrote it, and now says
    // WHICH. Before this it showed a status with no provenance, so a fob tap at
    // the gate and a finger on this tablet were indistinguishable on the one
    // screen where the difference matters ("it says I'm in — I never signed in").
    const { rows } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.role, s.job_title, s.photo_url,
             COALESCE(s.is_demo, false) AS is_demo,
             le.event_type AS last_event, le.event_time AS last_time,
             le.source AS last_source, le.method AS last_method, le.door_name AS last_door
        FROM staff s
        LEFT JOIN LATERAL (
          SELECT event_type, event_time, source, method, door_name
            FROM staff_clock_events_current e
           WHERE e.staff_id = s.id AND (e.event_time AT TIME ZONE 'Europe/London')::date = CURRENT_DATE
           ORDER BY e.event_time DESC, e.id DESC
           LIMIT 1
        ) le ON true
       WHERE s.is_active = true
       ORDER BY s.first_name, s.last_name`);
    const board = rows.map(r => {
      const isIn = r.last_event === 'clock_in';
      return {
        id: r.id,
        name: `${r.first_name} ${r.last_name}`.trim(),
        first_name: r.first_name,
        last_name: r.last_name,
        // weeklybugs-20261031 (staff-app:25): the card showed the coarse system role
        // ('practitioner', 'manager'...) labelled as a job title — ladn.staff.job_title
        // (BrightHR import) is the real, specific title; fall back to role when it's blank.
        role: r.job_title || r.role || null,
        photo_url: r.photo_url || null,
        is_demo: r.is_demo,
        status: isIn ? 'in' : 'out',
        since: isIn ? r.last_time : null,
        // How the CURRENT status was captured — shown on the card so a fob tap
        // and a PIN tap are visibly the same record rather than two stories.
        via: r.last_event ? CLOCKDAY.sourceLabel(r.last_source, r.last_method) : null,
        via_door: r.last_door || null,
        last_event_at: r.last_time || null
      };
    });
    res.json(board);
  } catch (e) {
    if (e.code === '42P01') return res.json([]); // table missing (demo)
    res.status(500).json({ error: e.message });
  }
});

// ── Simple in-memory wrong-PIN rate limiter (per staff) ──────────────────────
const _pinFails = new Map(); // staff_id -> { count, lockedUntil }
const MAX_FAILS = 5, LOCK_MS = 60 * 1000;
function _checkLock(staffId) {
  const rec = _pinFails.get(staffId);
  if (rec && rec.lockedUntil && Date.now() < rec.lockedUntil) {
    return Math.ceil((rec.lockedUntil - Date.now()) / 1000);
  }
  return 0;
}
function _recordFail(staffId) {
  const rec = _pinFails.get(staffId) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  // Cumulative: once over the threshold, EVERY further wrong PIN re-locks for another
  // window (we do NOT reset count) → sustained ~1 attempt/min, not 5/min. (H1 fix)
  if (rec.count >= MAX_FAILS) rec.lockedUntil = Date.now() + LOCK_MS;
  _pinFails.set(staffId, rec);
}
function _clearFail(staffId) { _pinFails.delete(staffId); }

// ── POST /toggle — { staff_id, pin } → verify PIN, flip clock in/out ─────────
router.post('/toggle', async (req, res) => {
  // Same boundary as the board: on-site (nursery LAN / Tailscale) OR a valid staff
  // JWT. Keeps the endpoint off the public internet / parents host so it can't be
  // scripted for roster enumeration + PIN brute-force. PIN is still required on top. (H1 fix)
  if (!_hasStaffJwt(req) && !_isOnSite(req)) {
    return res.status(403).json({ error: 'Sign-in is only available on the nursery network or with staff login.' });
  }
  const staffId = parseInt(req.body?.staff_id, 10);
  const pin = String(req.body?.pin || '');
  if (!staffId || !pin) return res.status(400).json({ error: 'staff_id and pin required' });

  const lockSecs = _checkLock(staffId);
  if (lockSecs) return res.status(429).json({ error: `Too many attempts. Try again in ${lockSecs}s.` });

  // Single generic failure for missing-staff / no-PIN / wrong-PIN so the endpoint
  // can't be used to enumerate which staff ids exist or have a PIN set. (H1 fix)
  const GENERIC_FAIL = { code: 401, body: { error: 'Incorrect PIN' } };

  try {
    const db = getPool();
    const { rows: staffRows } = await db.query(
      'SELECT id, first_name, last_name, pin_hash FROM staff WHERE id = $1 AND is_active = true',
      [staffId]
    );
    if (!staffRows.length) { _recordFail(staffId); return res.status(GENERIC_FAIL.code).json(GENERIC_FAIL.body); }
    const staff = staffRows[0];

    // Reuse the standard EY PIN check (bcrypt vs pin_hash). No id=1 special-case,
    // and NO '1234' fallback — a staff member with no PIN set cannot sign in here.
    if (!staff.pin_hash) { _recordFail(staffId); return res.status(GENERIC_FAIL.code).json(GENERIC_FAIL.body); }
    const ok = await bcrypt.compare(pin, staff.pin_hash);
    if (!ok) {
      _recordFail(staffId);
      return res.status(GENERIC_FAIL.code).json(GENERIC_FAIL.body);
    }
    _clearFail(staffId);

    const ts = new Date();
    const date = CLOCKDAY.londonToday();
    const name0 = `${staff.first_name} ${staff.last_name}`.trim();

    // ── b366: ONE RECORD, TWO DOORS ────────────────────────────────────────
    // A fob at the gate and a finger here are the same arrival. Before this,
    // direction was decided by flipping the last event with no regard for how
    // long ago it was, so the sequence Toby will actually see every morning —
    // tap the gate to get in, walk to the tablet, sign in — recorded an arrival
    // and then a departure a minute later, and the person was "out" all day.
    //
    // The repeat window is the SAME setting the fob reader uses
    // (clock_repeat_tap_seconds), read from the same place, so the two cannot
    // drift apart. Inside it, nothing is written and the person is told what
    // Wren already has. Outside it, this is a genuine second transition — going
    // out for lunch at 12:30 having tapped in at 08:00 — and it flips as before.
    const repeatSecs = await CLOCKDAY.setting(db, 'clock_repeat_tap_seconds', 180);
    const last = await CLOCKDAY.lastEvent(db, staffId, date);
    const dup = CLOCKDAY.repeatOf(last, ts, repeatSecs);
    if (dup) {
      const already = dup.event_type === 'clock_in' ? 'in' : 'out';
      const how = CLOCKDAY.sourceLabel(dup.source);
      return res.json({
        ok: true,
        ignored: 'repeat_tap',
        staff_id: staffId,
        name: name0,
        status: already,
        since: already === 'in' ? dup.event_time : null,
        duplicate_of: dup.id,
        within_seconds: repeatSecs,
        // Said out loud on the tablet: silently doing nothing looks like a dead
        // screen, and the person taps again.
        message: already === 'in'
          ? `You are already signed in${how ? ` — recorded ${dup.seconds < 60 ? 'just now' : `${Math.round(dup.seconds / 60)} min ago`} by ${how}` : ''}.`
          : `You are already signed out${how ? ` — recorded by ${how}` : ''}.`
      });
    }

    // Flip based on current status (source of truth = staff_clock_events, which
    // both writers share — so this reads the fob's taps too).
    const { status } = await currentStatus(db, staffId);
    const eventType = status === 'in' ? 'clock_out' : 'clock_in';

    await db.query(
      // b310 — `source` says HOW this was captured, which is the thing a timesheet
      // has to be able to answer six years later. 'pin_board' = the wall tablet.
      `INSERT INTO staff_clock_events (staff_id, event_type, method, event_time, source, recorded_by, source_raw)
       VALUES ($1, $2, 'pin', $3, 'pin_board', $1, $4)`,
      [staffId, eventType, ts, JSON.stringify({ via: 'staff-signin-board' })]
    );

    // b310 — staff_shifts is DERIVED, not patched. This route used to hand-roll its
    // own version of the same UPDATE that clockin.js hand-rolled, and the two did
    // not agree: this one made total_minutes a straight first-to-last span, so a
    // tapped lunch break was paid as work. CLOCKDAY.recomputeDay() replays the day
    // from the events and is now the only writer of that row.
    const day = await CLOCKDAY.recomputeDay(db, staffId, CLOCKDAY.londonToday());
    const totalMinutes = day.workedMinutes || null;

    const name = `${staff.first_name} ${staff.last_name}`.trim();
    sendTelegram(eventType === 'clock_in'
      ? `👤 ${name} signed IN — ${fmtTime(ts)} (PIN)`
      : `👋 ${name} signed OUT — ${fmtTime(ts)}${totalMinutes ? ` · shift ${fmtDuration(totalMinutes)}` : ''} (PIN)`);

    res.json({
      ok: true,
      staff_id: staffId,
      name,
      status: eventType === 'clock_in' ? 'in' : 'out',
      since: eventType === 'clock_in' ? ts : null,
      total_minutes: totalMinutes
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
