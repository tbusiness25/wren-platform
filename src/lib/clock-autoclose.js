'use strict';
/* ===========================================================================
 * clock-autoclose.js — b404 (2026-10-06), ported to the release tree 2026-10-17
 *
 * Toby (brief section 4, "Staff sign in/out"): "Auto sign-out if they forget:
 * at closing time, or after a long gap; check settings for opening hours.
 * The auto sign-out is recorded and flagged as automatic so managers can see
 * it."
 *
 * ON-READ, NOT A CRON JOB. There is no timer and no crontab line. This is called
 * from the endpoints that already answer "who is clocked in right now" — the
 * sign-in register board (staff-signin.js /board) and the kiosk board
 * (clockin.js /today) — immediately before they read. It is idempotent, so
 * calling it on every page load costs a couple of queries and nothing more.
 * A forgotten sign-out is therefore closed the next time ANYONE reads one of
 * those boards, not at the literal stroke of closing time. (A real-time version
 * would need a scheduled job; see sliceA-NOTES.md for the exact optional line.)
 *
 * WHAT COUNTS AS "FORGOT TO SIGN OUT"
 * Whoever's most recent LIVE event (ladn.staff_clock_events_current, so a
 * superseded or voided tap can never decide this) is an un-matched clock_in is
 * "open", whether that arrival was ten minutes ago or three days ago. For each:
 *
 *   closing_time  settings.closing_time (HH:MM, Europe/London) on the day of
 *                 their clock_in has passed AND settings.clock_autoclose_grace_minutes
 *                 (default 60) have gone by since. The clock_out is written AT the
 *                 closing time, flagged automatic. The grace is a port-time addition:
 *                 without it, the first read of the board after 18:00 — which is what
 *                 a closer does to tap out at 18:20 — would close them at 18:00 first,
 *                 and their real tap would then count as a new sign-IN.
 *   end_of_day    they clocked in at/after that day's closing time (a late meeting):
 *                 closed at 23:59 that day, once it has passed. (Also a port-time
 *                 addition: the original wrote a clock_out BEFORE the clock_in here
 *                 and re-wrote it on every board read.)
 *   long_gap      settings.clock_autoclose_long_gap_hours (default 14) have elapsed
 *                 since the clock_in; closed at "now" (capped at 23:59 that day).
 *
 * Every auto clock_out lands on the SAME London calendar day as the clock_in it
 * closes and AFTER it, which is what clock-day.js's per-day replay needs to pair
 * them. Each open clock_in is closed at most once (guarded by
 * source_raw.open_since_event_id), so two simultaneous board reads cannot
 * double-write.
 *
 * NEEDS (additive migration, migrations/2026-10-06-b404-staff-signin-autoclose.sql):
 *   staff_clock_events.is_automatic / auto_close_reason. If they are missing the
 *   sweep logs once a minute and skips — the boards still load.
 *
 * WHAT IS NEVER DONE
 * Never reads or writes ladn.staff.pin_hash. Never invents a time for a real tap:
 * it only ever writes a clock_out with is_automatic=true and auto_close_reason set,
 * so it is unmistakably not a real tap, a manual entry or a self-reported answer.
 * ===========================================================================*/

const CLOCKDAY = require('./clock-day');
const TZ = CLOCKDAY.TZ; // 'Europe/London'

let _retryAfter = 0; // set when the b404 columns are missing, so we don't spam errors

/** A time-of-day setting ('HH:MM'), with a stated fallback. Never throws. */
async function _timeSetting(db, key, fallback) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    const v = rows[0] && String(rows[0].value || '').trim();
    return (v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) ? v : fallback;
  } catch (_) { return fallback; }
}

/** A numeric setting >= min, with a stated fallback. Never throws. */
async function _numSetting(db, key, fallback, min) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    const n = rows.length ? Number(rows[0].value) : NaN;
    return Number.isFinite(n) && n >= min ? n : fallback;
  } catch (_) { return fallback; }
}

/**
 * Close out any staff member whose most recent LIVE clock event is an
 * unmatched clock_in that is now overdue (see the header). Safe to call on
 * every page load.
 *
 * @param {object} db
 * @param {{staffId?: number, now?: number}} [opts]  staffId limits the sweep to
 *        one person; now (ms since epoch) is for tests only.
 * @returns {Promise<Array<{staff_id:number, event_id:number, reason:string, closed_at:string}>>}
 */
async function autoCloseOverdueShifts(db, { staffId, now: nowOverride } = {}) {
  if (Date.now() < _retryAfter) return [];
  const closingTime  = await _timeSetting(db, 'closing_time', '18:00');
  const longGapHours = await _numSetting(db, 'clock_autoclose_long_gap_hours', 14, 0.01);
  const graceMin     = await _numSetting(db, 'clock_autoclose_grace_minutes', 60, 0);

  // One row per staff member — the single most recent live event they have,
  // ever — kept only when that event is an un-matched clock_in. Bounded by
  // headcount, not by how far back their open shift started.
  const { rows: open } = await db.query(`
    WITH last_ev AS (
      SELECT DISTINCT ON (e.staff_id) e.staff_id, e.id, e.event_type, e.event_time
        FROM staff_clock_events_current e
        JOIN staff s ON s.id = e.staff_id AND s.is_active = true
       WHERE ($1::int IS NULL OR e.staff_id = $1)
       ORDER BY e.staff_id, e.event_time DESC, e.id DESC
    )
    SELECT staff_id, id AS event_id, event_time,
           (((event_time AT TIME ZONE '${TZ}')::date)::text || ' ' || $2::text)::timestamp
             AT TIME ZONE '${TZ}' AS close_at,
           ((((event_time AT TIME ZONE '${TZ}')::date + 1)::timestamp AT TIME ZONE '${TZ}')
             - interval '1 minute') AS day_end
      FROM last_ev
     WHERE event_type = 'clock_in'`,
    [staffId || null, closingTime]
  );
  if (!open.length) return [];

  const now = nowOverride || Date.now();
  const closed = [];
  for (const row of open) {
    const clockInMs = new Date(row.event_time).getTime();
    const closeAtMs = new Date(row.close_at).getTime();
    const dayEndMs  = new Date(row.day_end).getTime();

    let reason = null, eventMs = null;
    if (clockInMs < closeAtMs) {
      if (now >= closeAtMs + graceMin * 60000) { reason = 'closing_time'; eventMs = closeAtMs; }
    } else if (dayEndMs > clockInMs && now >= dayEndMs) {
      reason = 'end_of_day'; eventMs = dayEndMs;
    }
    if (!reason && now - clockInMs >= longGapHours * 3600000) {
      reason = 'long_gap';
      eventMs = (dayEndMs > clockInMs) ? Math.min(now, dayEndMs) : now;
    }
    if (!reason) continue; // still legitimately open
    if (eventMs <= clockInMs) eventMs = clockInMs + 60000; // never before/at the tap it closes

    const dateOfEvent = new Date(row.event_time).toLocaleDateString('en-CA', { timeZone: TZ });

    let ins;
    try {
      ({ rows: ins } = await db.query(`
        INSERT INTO staff_clock_events
          (staff_id, event_type, method, event_time, source, recorded_by,
           is_automatic, auto_close_reason, source_raw)
        SELECT $1::int, 'clock_out', 'auto', $2::timestamptz, 'auto_close', NULL, true, $3::text, $4::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM staff_clock_events x
            WHERE x.staff_id = $1::int AND x.is_automatic = true
              AND (x.source_raw->>'open_since_event_id')::int = $5::int)
        RETURNING id`,
        [row.staff_id, new Date(eventMs).toISOString(), reason,
         JSON.stringify({
           closing_time: closingTime,
           grace_minutes: graceMin,
           long_gap_hours: longGapHours,
           open_since_event_id: row.event_id,
         }),
         row.event_id]
      ));
    } catch (e) {
      if (e && e.code === '42703') { // undefined_column: migration not applied yet
        _retryAfter = Date.now() + 60000;
        console.error('[clock-autoclose] skipped — apply migrations/2026-10-06-b404-staff-signin-autoclose.sql:', e.message);
        return closed;
      }
      throw e;
    }
    if (!ins.length) continue; // already closed by a concurrent read

    // b310 rule: staff_shifts is DERIVED, never patched by hand — replay the
    // whole day from the events, same as every other writer in this codebase.
    await CLOCKDAY.recomputeDay(db, row.staff_id, dateOfEvent);

    closed.push({ staff_id: row.staff_id, event_id: ins[0].id, reason, closed_at: new Date(eventMs).toISOString() });
  }
  return closed;
}

module.exports = { autoCloseOverdueShifts };
