// @ts-check  (b508, 2026-10-18) — this file is type-checked. jsconfig.json has
// checkJs:false, so only files carrying this comment are checked; see jsconfig.json
// for how to run it. Keep it passing, or take the comment off deliberately.
// NOTE: this comment must stay the FIRST thing in the file — above 'use strict' —
// or TypeScript ignores it and the file is silently not checked.
'use strict';
/* ===========================================================================
 * clock-day.js — b310 (2026-09-10)
 *
 * The one place a worked day is derived. Every writer of a clock event — the fob
 * webhook, the PIN board, a manager's manual entry, a staff member answering
 * "what time did you leave?" — calls recomputeDay() afterwards, and nothing else
 * ever writes ladn.staff_shifts by hand. Before b310 there were three separate
 * hand-rolled UPDATEs of that table and they did not agree with each other.
 *
 * DERIVATION IS ALWAYS FROM THE EVENTS, NEVER INCREMENTAL. Replaying the whole day
 * from ladn.staff_clock_events_current is the only way a correction can take effect
 * without editing anything: the new row supersedes the old one, the day is replayed,
 * and the shift row catches up. An incremental "add the difference" would need the
 * old value to have been right, which is precisely what a correction disputes.
 *
 * DATES ARE Europe/London THROUGHOUT. Events are timestamptz; a "day" is the local
 * calendar day, because that is the day on a timesheet and the day on a rota.
 * ===========================================================================*/

const PAIR = require('./clock-pairing');

const TZ = 'Europe/London';
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s);

/** A numeric setting, with a stated fallback. Never throws. */
async function setting(db, key, fallback) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    const n = rows.length ? Number(rows[0].value) : NaN;
    return Number.isFinite(n) ? n : fallback;
  } catch (_) { return fallback; }
}

/** Today, in Europe/London, as YYYY-MM-DD. */
function londonToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

/** Live (non-superseded, non-void) events for one person on one local day. */
async function dayEvents(db, staffId, date) {
  const { rows } = await db.query(`
    SELECT id, event_type, event_time, source, method, device_id, recorded_by
      FROM staff_clock_events_current
     WHERE staff_id = $1
       AND (event_time AT TIME ZONE '${TZ}')::date = $2::date
     ORDER BY event_time ASC, id ASC`, [staffId, date]);
  return rows.map(r => ({
    id: r.id,
    type: r.event_type,
    at: new Date(r.event_time).getTime(),
    at_iso: r.event_time,
    source: r.source || r.method || null,
    device_id: r.device_id || null,
  }));
}

/**
 * Replay one person's day and write the derived shift row.
 * Returns the pairing result, so a caller can tell the person what they just did.
 */
async function recomputeDay(db, staffId, date) {
  if (!isDate(date)) throw new Error('recomputeDay: date must be YYYY-MM-DD');
  const repeatTapSeconds = await setting(db, 'clock_repeat_tap_seconds', 180);
  const events = await dayEvents(db, staffId, date);
  const r = PAIR.pairDay(events, { repeatTapSeconds });

  // No live events left (every tap on the day was voided) — say so rather than
  // leaving a stale shift row behind claiming hours nobody worked.
  const firstIn = r.firstIn ? new Date(r.firstIn.at) : null;
  const lastOut = r.lastOut ? new Date(r.lastOut.at) : null;
  const status  = !events.length ? 'none' : (r.open ? 'open' : 'complete');

  await db.query(`
    INSERT INTO staff_shifts
      (staff_id, shift_date, clock_in_time, clock_out_time, total_minutes,
       worked_minutes, break_minutes, pairs, anomalies, status, method, derived_at)
    VALUES ($1, $2::date, $3, $4, $5, $5, $6, $7::jsonb, $8::jsonb, $9, $10, now())
    ON CONFLICT (staff_id, shift_date) DO UPDATE SET
       clock_in_time  = EXCLUDED.clock_in_time,
       clock_out_time = EXCLUDED.clock_out_time,
       total_minutes  = EXCLUDED.total_minutes,
       worked_minutes = EXCLUDED.worked_minutes,
       break_minutes  = EXCLUDED.break_minutes,
       pairs          = EXCLUDED.pairs,
       anomalies      = EXCLUDED.anomalies,
       status         = EXCLUDED.status,
       method         = EXCLUDED.method,
       derived_at     = now()`,
    [staffId, date, firstIn, lastOut,
     events.length ? r.workedMinutes : null,
     events.length ? r.breakMinutes : null,
     JSON.stringify(r.pairs.map(p => ({
       in: new Date(p.in_at).toISOString(), out: new Date(p.out_at).toISOString(),
       minutes: p.minutes, in_event_id: p.in_event_id, out_event_id: p.out_event_id,
       in_device: p.in_device, out_device: p.out_device,
     }))),
     JSON.stringify(r.anomalies),
     status,
     // `method` is pre-b310 and other screens still read it. Keep it truthful:
     // the source of the FIRST live event of the day.
     (events[0] && (events[0].source || null)) || null,
    ]);

  return r;
}

/** The rota's planned start/end for one person on one day, if the rota knows. */
async function rotaTimes(db, staffId, date) {
  try {
    const { rows } = await db.query(`
      SELECT to_char(min(planned_start), 'HH24:MI') AS start,
             to_char(max(planned_end),   'HH24:MI') AS finish
        FROM rota_shifts
       WHERE staff_id = $1 AND shift_date = $2::date
         AND COALESCE(is_absent, false) = false
         AND COALESCE(is_open,   false) = false`, [staffId, date]);
    return { start: rows[0]?.start || null, end: rows[0]?.finish || null };
  } catch (_) { return { start: null, end: null }; }
}

/**
 * Find days that need a question asked, and ask it.
 *
 * A question is raised when a day has an unpaired tap AND the moment has passed
 * where a late tap could still turn up:
 *   • an unpaired 'in'  → 'missing_out', once the rota's end + grace has gone by
 *                         (or, with no rota, once the local day is over)
 *   • an unpaired 'out' → 'missing_in',  immediately: an out with no in cannot be
 *                         waiting for anything.
 *
 * Idempotent — safe to call on every page load, which is exactly how it runs.
 * There is no cron line for this on purpose: host scripts in wren/scripts run from
 * the working tree and reach prod the same night, which a DEV-ONLY build must not do.
 *
 * @param {{ query: Function }} db
 * @param {{ from?: string, to?: string, staffId?: number }} [opts]
 *        from/to are YYYY-MM-DD; both default to a 14-day window ending today.
 *        (b508: the options bag was untyped, so `// @ts-check` could not see these
 *        three names at all. Documentation only — no behaviour change.)
 */
async function sweepQueries(db, { from, to, staffId } = {}) {
  const today = londonToday();
  const toDate   = isDate(to)   ? to   : today;
  const fromDate = isDate(from) ? from : (() => {
    const d = new Date(toDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 13);
    return d.toISOString().slice(0, 10);
  })();

  const graceMin = await setting(db, 'clock_missing_out_grace_minutes', 60);
  const repeatTapSeconds = await setting(db, 'clock_repeat_tap_seconds', 180);

  // b508: typed because a SQL parameter list is mixed by nature — two date strings and
  // then, optionally, a numeric staff id. Without this, `// @ts-check` infers string[]
  // from the initialiser and rejects the push. Annotation only, no behaviour change.
  /** @type {(string|number)[]} */
  const params = [fromDate, toDate];
  let staffClause = '';
  if (staffId) { params.push(staffId); staffClause = ` AND e.staff_id = $${params.length}`; }

  const { rows: days } = await db.query(`
    SELECT e.staff_id, (e.event_time AT TIME ZONE '${TZ}')::date::text AS date
      FROM staff_clock_events_current e
     WHERE (e.event_time AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date
       ${staffClause}
     GROUP BY 1, 2`, params);

  const raised = [], closed = [];
  for (const d of days) {
    const events = await dayEvents(db, d.staff_id, d.date);
    const r = PAIR.pairDay(events, { repeatTapSeconds });
    const rota = await rotaTimes(db, d.staff_id, d.date);

    // Days that resolved themselves: a real tap arrived after the question was
    // asked. Mark superseded, never delete — the question was genuinely asked.
    if (!r.open && !r.orphanOut) {
      const { rowCount } = await db.query(
        `UPDATE clock_queries SET status = 'superseded', updated_at = now()
          WHERE staff_id = $1 AND occurred_on = $2::date AND status = 'open'`,
        [d.staff_id, d.date]);
      if (rowCount) closed.push({ staff_id: d.staff_id, date: d.date });
      continue;
    }

    if (r.open) {
      // Is it too soon to ask? Only if the day is TODAY and the shift has not
      // finished yet — somebody still at work is not a missing tap-out.
      let ready = d.date < today;
      if (!ready && d.date === today) {
        const dueMs = rota.end
          ? new Date(`${d.date}T${rota.end}:00`).getTime() + graceMin * 60000
          : null;
        ready = dueMs != null && Date.now() > dueMs;
      }
      if (ready) {
        const ins = await db.query(`
          INSERT INTO clock_queries
            (staff_id, occurred_on, kind, open_event_id, opened_at,
             scheduled_start, scheduled_end, suggested_time)
          VALUES ($1, $2::date, 'missing_out', $3, $4, $5::time, $6::time, $6::time)
          ON CONFLICT (staff_id, occurred_on, kind) DO NOTHING
          RETURNING id`,
          [d.staff_id, d.date, r.open.id, new Date(r.open.at), rota.start, rota.end]);
        if (ins.rowCount) raised.push({ staff_id: d.staff_id, date: d.date, kind: 'missing_out', id: ins.rows[0].id });
      }
    }

    if (r.orphanOut) {
      const ins = await db.query(`
        INSERT INTO clock_queries
          (staff_id, occurred_on, kind, open_event_id, opened_at,
           scheduled_start, scheduled_end, suggested_time)
        VALUES ($1, $2::date, 'missing_in', $3, $4, $5::time, $6::time, $5::time)
        ON CONFLICT (staff_id, occurred_on, kind) DO NOTHING
        RETURNING id`,
        [d.staff_id, d.date, r.orphanOut.id, new Date(r.orphanOut.at), rota.start, rota.end]);
      if (ins.rowCount) raised.push({ staff_id: d.staff_id, date: d.date, kind: 'missing_in', id: ins.rows[0].id });
    }
  }
  return { raised, closed, window: { from: fromDate, to: toDate } };
}

/**
 * b366 — the last live event of a person's day, whatever wrote it.
 *
 * The fob reader and the PIN board are two doors into one record, and before
 * this they could disagree about which way the next action counted. The gate is
 * an 'in' reader: tap it at 08:00, walk to the tablet, press your card and your
 * PIN at 08:01, and the board — which decided direction by flipping the last
 * event — signed you OUT while you were stood in the building.
 *
 * So both writers now ask the same question of the same table before they write,
 * and neither cares which one got there first. Note this deliberately does NOT
 * filter by source or by device: the whole point is that a fob tap and a finger
 * on the tablet inside the window are one arrival.
 */
async function lastEvent(db, staffId, date) {
  const { rows } = await db.query(`
    SELECT id, event_type, event_time, source, method, device_id
      FROM staff_clock_events_current
     WHERE staff_id = $1 AND (event_time AT TIME ZONE '${TZ}')::date = $2::date
     ORDER BY event_time DESC, id DESC
     LIMIT 1`, [staffId, date]);
  return rows[0] || null;
}

/**
 * Is this action a re-run of the one just recorded?
 *
 * Returns the event it duplicates, or null. `seconds` is
 * settings.clock_repeat_tap_seconds — ONE window, shared by both writers, so
 * "three minutes" means the same thing at the gate and at the tablet.
 *
 * A repeat is answered with the status the person already has and NOTHING is
 * written: an employment record should not carry rows that mean nothing
 * happened, and it certainly should not carry a departure that never occurred.
 */
function repeatOf(last, at, seconds) {
  if (!last) return null;
  const gap = Math.abs(new Date(at).getTime() - new Date(last.event_time).getTime());
  if (gap > Math.max(0, Number(seconds) || 0) * 1000) return null;
  return { id: last.id, event_type: last.event_type, event_time: last.event_time,
           source: last.source || last.method || null, device_id: last.device_id || null,
           seconds: Math.round(gap / 1000) };
}

/** How a status was captured, in words a person can read on a board. */
function sourceLabel(source, method) {
  const s = String(source || method || '').toLowerCase();
  if (s === 'pin_board' || s === 'pin') return 'sign-in board';
  if (s === 'self_reported') return 'told us later';
  if (s === 'manager_reported') return 'entered by a manager';
  // b404 — an on-read auto-close (closing time passed, or a long gap with
  // nobody tapping out). Shown wherever sourceLabel() already is, including
  // the sign-in board's "via" line, so a manager sees it without a new screen.
  if (s === 'auto_close') return 'closed automatically';
  if (s.startsWith('fob') || s === 'fob_reader') return 'fob';
  return s ? s.replace(/_/g, ' ') : null;
}

/**
 * Answer a question. Writes the event the person's answer implies, marked
 * source='self_reported' (or 'manager_reported' when somebody answers on their
 * behalf), links it back to the question, and replays the day.
 *
 * The suggested time is NEVER used as a default here — the caller must pass a
 * time. Offering the rota's end on screen and writing it when nobody typed
 * anything would be exactly the silent assumption this build exists to remove.
 */
async function answerQuery(db, { queryId, time, note, byStaffId, source }) {
  if (!isTime(time)) throw new Error('A time (HH:MM) is required — the rota default is offered on screen but never written on its own.');
  const { rows } = await db.query('SELECT * FROM clock_queries WHERE id = $1', [queryId]);
  const q = rows[0];
  if (!q) return { ok: false, error: 'not_found' };
  if (q.status !== 'open') return { ok: false, error: 'not_open', status: q.status };

  const date = new Date(q.occurred_on).toLocaleDateString('en-CA', { timeZone: TZ });
  const eventType = q.kind === 'missing_out' ? 'clock_out' : 'clock_in';
  const src = source === 'manager' ? 'manager_reported' : 'self_reported';

  const { rows: ev } = await db.query(`
    INSERT INTO staff_clock_events
      (staff_id, event_type, method, event_time, source, recorded_by, query_id, source_raw)
    VALUES ($1, $2, 'self_report',
            ($3::text || ' ' || $4::text)::timestamp AT TIME ZONE '${TZ}',
            $5, $6, $7, $8::jsonb)
    RETURNING id, event_time`,
    [q.staff_id, eventType, date, time, src, byStaffId || null, q.id,
     JSON.stringify({ answered_question: q.id, kind: q.kind, note: note || null, suggested_was: q.suggested_time || null })]);

  await db.query(`
    UPDATE clock_queries
       SET status = 'answered', answer_time = $2::time, answer_source = $3,
           answer_note = $4, answered_by = $5, answered_at = now(),
           event_id = $6, updated_at = now()
     WHERE id = $1`,
    [q.id, time, src, note || null, byStaffId || null, ev[0].id]);

  const day = await recomputeDay(db, q.staff_id, date);
  return { ok: true, event_id: ev[0].id, date, event_type: eventType, source: src, day };
}

module.exports = {
  TZ, londonToday, isDate, isTime, setting,
  dayEvents, recomputeDay, rotaTimes, sweepQueries, answerQuery,
  // b366 — shared by the fob webhook and the PIN board so neither can
  // contradict the other about which way the next action counts.
  lastEvent, repeatOf, sourceLabel,
};
