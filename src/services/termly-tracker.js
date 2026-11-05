'use strict';
/**
 * termly-tracker.js — b277 (2026-09-04)
 *
 * Toby, 2026-09-04: "this is technically an oberservation, but has its own
 * tracker, so we can keep track of staff sending them out on time … and I get
 * termly reports on staff missed dates etc".
 *
 * ── TWO DATES, AND THEY ARE NOT THE SAME DATE ───────────────────────────────
 * "Sending them out on time" hides a question the tracker has to answer
 * out loud, because the two possible answers are different numbers:
 *
 *   completed_on   the day the key person DID the termly update — the day they
 *                  flagged the observation. This is the staff member's own act
 *                  and it is what they are accountable for.
 *   sent_on        the day the document reached the family. With the watcher on
 *                  auto this is minutes after completed_on; with it on review,
 *                  or when it errored, it can be days later or never.
 *
 * Both are returned for every child, both are shown, and `on_time` is measured
 * against completed_on — a key person who wrote theirs on the due date is on
 * time even if the delivery leg had a problem. `delivery_lag_days` is the gap
 * between them, so a systemic delivery failure shows up as a column of large
 * numbers rather than as a room full of apparently late practitioners.
 *
 * ── NO TABLE ────────────────────────────────────────────────────────────────
 * Everything here is derived, per request, from ladn.children, the observation
 * flag and ladn.reports. Nothing is stored, so nothing can go stale and there is
 * no backfill. b246's cycle maths (src/lib/termly-cycle.js) decides who is owed
 * what and when — this module never invents a deadline.
 *
 * ── ROLES ───────────────────────────────────────────────────────────────────
 * This is a staff-facing management view: children appear by name, as they do on
 * b246's queue and b244's board. The route in front of it scopes a non-lead to
 * their own key children and denies the parents and HR portals. Nothing in here
 * is ever logged — see the log rule in logs/b277.NOTES.md.
 */

const TC = require('../lib/termly-cycle');
const TS = require('../lib/termly-sources');

const MANAGER_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager']);

/** Blank aggregate. Every counter that exists, so the UI never sees undefined. */
function emptyAgg(extra) {
  return Object.assign({
    owed: 0, done: 0, outstanding: 0, on_time: 0, late: 0,
    not_applicable: 0, in_progress: 0, published: 0, unpublished: 0,
    days_late_total: 0, worst_days_late: 0,
    missed: [],
  }, extra || {});
}

function finishAgg(a) {
  a.avg_days_late = a.late ? Math.round((a.days_late_total / a.late) * 10) / 10 : 0;
  a.on_time_pct = a.done ? Math.round((a.on_time / a.done) * 100) : null;
  a.completion_pct = a.owed ? Math.round((a.done / a.owed) * 100) : null;
  delete a.days_late_total;
  return a;
}

/**
 * The tracker for one cycle.
 *
 * @param {object} db
 * @param {object} opts { cycleKey, on, keyPersonId, roomId, includeInactive }
 * @returns {Promise<object>} { cycle, config, on, calendar, children, staff, rooms, totals }
 */
async function trackerFor(db, opts = {}) {
  const on = TC.ymd(opts.on) || TC.ymd(new Date());
  const { cycles, config } = await TC.loadCycles(db);
  const cycle = opts.cycleKey ? TC.cycleByKey(cycles, String(opts.cycleKey)) : TC.currentCycle(cycles, on);
  const calendar = TC.calendarHealth(cycles, on);

  if (!cycle) {
    return { on, cycle: null, config, calendar, children: [], staff: [], rooms: [],
             totals: finishAgg(emptyAgg()), cycles: cycles.map(slim) };
  }

  // ⚠ ONE DEFINITION OF "COMPLETED", SHARED WITH THE WATCHER.
  // The tracker used to be able to answer this itself with a LATERAL on
  // observations.termly_update — and it would then have disagreed with the
  // watcher the moment an EyLog tag or text match completed an update without
  // setting that flag: the family would have the document while the board still
  // said overdue. So the completion set comes from src/lib/termly-sources.js,
  // the same function the watcher fires on, and there is no second rule to drift.
  const sourceCfg = opts.sourceConfig || await TS.loadSourceConfig(db);
  const completions = new Map();
  try {
    const sigs = await TS.detectCompletions(db, cycle, { config: sourceCfg, window_to: on, limit: 2000 });
    for (const s of sigs) completions.set(Number(s.child_id), s);
  } catch (e) {
    // A bad regex in termly_watcher_eylog_text_re must not blank the board.
    // Fall back to the flag alone and say so on the response.
    const fallback = await db.query(`
      SELECT DISTINCT ON (o.child_id) o.child_id, o.id AS observation_id, o.staff_id,
             to_char(o.created_at AT TIME ZONE 'Europe/London','YYYY-MM-DD') AS completed_on,
             (o.eylog_ref IS NOT NULL) AS from_eylog
        FROM observations o
       WHERE o.termly_update = true
         -- weeklybugs-20261031 (staff-app:16): same UTC-vs-Europe/London boundary bug as
         -- termly-sources.js's detectCompletions — see that file's comment.
         AND (o.created_at AT TIME ZONE 'Europe/London') >= $1::date
         AND (o.created_at AT TIME ZONE 'Europe/London') <  ($2::date + 1)
         AND COALESCE(o.review_status,'published') = 'published'
       ORDER BY o.child_id, o.created_at ASC, o.id ASC`, [cycle.opens_on, on]);
    for (const r of fallback.rows) {
      completions.set(Number(r.child_id), {
        child_id: r.child_id, observation_id: r.observation_id, staff_id: r.staff_id,
        completed_on: r.completed_on, source: r.from_eylog ? 'eylog' : 'wren', matched_by: 'flag',
      });
    }
    opts._sourceError = e.message;
  }

  const params = [cycle.key];
  const conds = [opts.includeInactive ? 'TRUE' : 'c.is_active = true'];
  if (/^\d+$/.test(String(opts.keyPersonId || ''))) {
    params.push(parseInt(opts.keyPersonId, 10)); conds.push(`c.key_person_id = $${params.length}`);
  }
  if (/^\d+$/.test(String(opts.roomId || ''))) {
    params.push(parseInt(opts.roomId, 10)); conds.push(`c.room_id = $${params.length}`);
  }

  // One query. Per child: the earliest completion flag inside this cycle (which
  // is the completion — see termly-sources.js for why earliest and not latest),
  // this cycle's document if one exists, and the last update from any cycle.
  const { rows } = await db.query(`
    SELECT c.id                                        AS child_id,
           c.first_name, c.last_name, c.preferred_name,
           c.room_id, c.key_person_id,
           to_char(c.start_date,'YYYY-MM-DD')          AS start_date,
           to_char(c.leave_date,'YYYY-MM-DD')          AS leave_date,
           rm.name                                     AS room_name,
           kp.first_name || ' ' || kp.last_name        AS key_person_name,
           kp.role                                     AS key_person_role,
           doc.id                                      AS report_id,
           doc.status                                  AS report_status,
           doc.shared_with_parents,
           to_char(doc.sent_at,'YYYY-MM-DD')           AS sent_on,
           doc.content -> 'watcher' ->> 'source'       AS watcher_source,
           doc.content -> 'watcher' ->> 'matched_by'   AS watcher_matched_by,
           doc.content ->> 'variant'                   AS doc_variant,
           prev.last_sent_on
      FROM children c
      LEFT JOIN rooms rm ON rm.id = c.room_id
      LEFT JOIN staff kp ON kp.id = c.key_person_id
      LEFT JOIN LATERAL (
        SELECT r.id, r.status, r.sent_at, r.shared_with_parents, r.content
          FROM reports r
         WHERE r.child_id = c.id AND r.report_type = 'termly_update' AND r.cycle_key = $1
         ORDER BY r.id DESC LIMIT 1) doc ON true
      LEFT JOIN LATERAL (
        SELECT to_char(MAX(r2.sent_at),'YYYY-MM-DD') AS last_sent_on
          FROM reports r2
         WHERE r2.child_id = c.id AND r2.report_type = 'termly_update' AND r2.sent_at IS NOT NULL) prev ON true
     WHERE ${conds.join(' AND ')}
     ORDER BY c.first_name, c.last_name
     LIMIT 600`, params);

  const byStaff = new Map();
  const byRoom = new Map();
  const totals = emptyAgg();
  const children = [];

  for (const r of rows) {
    const owedRes = TC.owedBy(cycle, { start_date: r.start_date, leave_date: r.leave_date }, config);
    const comp = completions.get(Number(r.child_id)) || null;

    // "Done" for the TRACKER is the staff member's act — the flag — or a sent
    // document for this cycle. A document sitting in review is NOT done: the
    // family has not had it. It is 'in_progress', which is a different problem
    // from 'not started' and reads differently on the board.
    const completedOn = (comp && comp.completed_on) || null;
    const sentOn = r.sent_on || null;
    const done = !!(completedOn || sentOn);

    let state;
    if (!owedRes.owed) state = 'not_applicable';
    else if (done) state = 'done';
    else if (r.report_id && r.report_status !== 'sent') state = 'in_progress';
    else if (on >= cycle.overdue_on) state = 'overdue';
    else if (on >= cycle.due_on) state = 'due';
    else state = 'upcoming';

    // ── The on-time maths, and it is this simple on purpose ─────────────────
    // on_time  = the key person completed on or before the due date.
    // days_late = how many days past it. Negative days (early) are not counted
    //            as a negative lateness — early is just on time.
    const daysLate = (completedOn && cycle.due_on)
      ? Math.max(0, TC.daysBetween(cycle.due_on, completedOn) || 0) : null;
    const onTime = completedOn && cycle.due_on ? (completedOn <= cycle.due_on) : null;
    const lag = (completedOn && sentOn) ? TC.daysBetween(completedOn, sentOn) : null;

    const row = {
      child_id: r.child_id,
      name: [(r.preferred_name || r.first_name), r.last_name].filter(Boolean).join(' '),
      room_id: r.room_id, room_name: r.room_name || null,
      key_person_id: r.key_person_id || null,
      key_person_name: r.key_person_name || null,
      state,
      owed: owedRes.owed,
      reason: owedRes.owed ? null : owedRes.reason,
      due_on: cycle.due_on, overdue_on: cycle.overdue_on, closes_on: cycle.closes_on,
      completed_on: completedOn,
      completed_by_staff_id: (comp && comp.staff_id) || null,
      completion_observation_id: (comp && comp.observation_id) || null,
      sent_on: sentOn,
      published: !!(r.shared_with_parents && r.report_status === 'sent'),
      on_time: onTime,
      days_late: daysLate,
      delivery_lag_days: lag,
      days_over: (on >= cycle.due_on) ? TC.daysBetween(cycle.due_on, on) : 0,
      report_id: r.report_id || null,
      report_status: r.report_status || null,
      doc_variant: r.doc_variant || null,
      source: r.watcher_source || (comp ? comp.source : null),
      matched_by: r.watcher_matched_by || (comp ? comp.matched_by : null),
      last_sent_on: r.last_sent_on || null,
    };
    children.push(row);

    // ── Aggregates ─────────────────────────────────────────────────────────
    // A child with no key person is still counted in the room and in the totals,
    // and appears under a null staff bucket so "nobody owns this child" is
    // visible rather than the row silently vanishing from every aggregate.
    const staffKey = r.key_person_id == null ? 'none' : String(r.key_person_id);
    if (!byStaff.has(staffKey)) {
      byStaff.set(staffKey, emptyAgg({
        staff_id: r.key_person_id || null,
        name: r.key_person_name || 'No key person',
        role: r.key_person_role || null,
      }));
    }
    const roomKey = r.room_id == null ? 'none' : String(r.room_id);
    if (!byRoom.has(roomKey)) {
      byRoom.set(roomKey, emptyAgg({ room_id: r.room_id || null, name: r.room_name || 'No room' }));
    }

    for (const agg of [byStaff.get(staffKey), byRoom.get(roomKey), totals]) {
      if (!owedRes.owed) { agg.not_applicable++; continue; }
      agg.owed++;
      if (state === 'in_progress') agg.in_progress++;
      if (done) {
        agg.done++;
        if (onTime === true) agg.on_time++;
        else if (onTime === false) {
          agg.late++;
          agg.days_late_total += (daysLate || 0);
          if ((daysLate || 0) > agg.worst_days_late) agg.worst_days_late = daysLate || 0;
        }
        if (row.published) agg.published++; else agg.unpublished++;
      } else {
        agg.outstanding++;
        // The missed list is what Toby's termly report is built from. Names,
        // because a manager chasing needs to know who — but it never leaves the
        // response and is never written to a log.
        agg.missed.push({ child_id: row.child_id, name: row.name, room_name: row.room_name,
                          due_on: cycle.due_on, days_over: row.days_over, state });
      }
    }
  }

  const ORDER = { overdue: 0, due: 1, in_progress: 2, upcoming: 3, done: 4, not_applicable: 5 };
  children.sort((a, b) => (ORDER[a.state] - ORDER[b.state])
    || ((b.days_late || 0) - (a.days_late || 0))
    || a.name.localeCompare(b.name));

  const staff = [...byStaff.values()].map(finishAgg)
    .sort((a, b) => b.outstanding - a.outstanding || b.late - a.late || String(a.name).localeCompare(String(b.name)));
  const rooms = [...byRoom.values()].map(finishAgg)
    .sort((a, b) => b.outstanding - a.outstanding || String(a.name).localeCompare(String(b.name)));

  return {
    on, cycle, config, calendar,
    sources: TS.describeSources(sourceCfg),
    source_error: opts._sourceError || null,
    children, staff, rooms,
    totals: finishAgg(totals),
    cycles: cycles.map(slim),
  };
}

function slim(c) {
  return { key: c.key, label: c.label, name: c.name, academic_year: c.academic_year,
           opens_on: c.opens_on, due_on: c.due_on, overdue_on: c.overdue_on, closes_on: c.closes_on };
}

/**
 * Toby's termly report: per staff member, what they were owed, what they did,
 * when they did it and which children they missed.
 *
 * One cycle by default. Pass academicYear for the whole year — six cycles rolled
 * up per staff member, which is the version that answers "who is habitually
 * late" rather than "who was late once in a week they were off sick".
 */
async function termReport(db, opts = {}) {
  const on = TC.ymd(opts.on) || TC.ymd(new Date());
  const { cycles } = await TC.loadCycles(db);

  let wanted;
  if (opts.academicYear) {
    // Only cycles that have actually OPENED. A report that counts four future
    // half-terms as "missed" is a report nobody can act on.
    wanted = cycles.filter(c => c.academic_year === String(opts.academicYear) && c.opens_on <= on);
  } else {
    const one = opts.cycleKey ? TC.cycleByKey(cycles, String(opts.cycleKey)) : TC.currentCycle(cycles, on);
    wanted = one ? [one] : [];
  }
  if (!wanted.length) {
    return { on, academic_year: opts.academicYear || null, cycles: [], staff: [], totals: finishAgg(emptyAgg()) };
  }

  const perCycle = [];
  const byStaff = new Map();
  const totals = emptyAgg();

  for (const cycle of wanted) {
    // As at the END of the half-term, not today: a cycle that closed in October
    // is judged on what was true when it closed, so a report re-run in March
    // gives the same answer it gave in November.
    const asAt = cycle.closes_on < on ? cycle.closes_on : on;
    const t = await trackerFor(db, { cycleKey: cycle.key, on: asAt });
    perCycle.push({
      cycle: slim(cycle), on: asAt, totals: t.totals,
      staff: t.staff.map(s => ({ staff_id: s.staff_id, name: s.name, owed: s.owed, done: s.done,
                                 on_time: s.on_time, late: s.late, outstanding: s.outstanding })),
    });

    for (const s of t.staff) {
      const k = s.staff_id == null ? 'none' : String(s.staff_id);
      if (!byStaff.has(k)) {
        byStaff.set(k, emptyAgg({ staff_id: s.staff_id, name: s.name, role: s.role, cycles: [] }));
      }
      const a = byStaff.get(k);
      a.owed += s.owed; a.done += s.done; a.outstanding += s.outstanding;
      a.on_time += s.on_time; a.late += s.late; a.not_applicable += s.not_applicable;
      a.published += s.published; a.unpublished += s.unpublished;
      a.days_late_total += (s.avg_days_late || 0) * (s.late || 0);
      if (s.worst_days_late > a.worst_days_late) a.worst_days_late = s.worst_days_late;
      a.cycles.push({ cycle_key: cycle.key, label: cycle.label, due_on: cycle.due_on,
                      owed: s.owed, done: s.done, on_time: s.on_time, late: s.late,
                      outstanding: s.outstanding });
      for (const m of s.missed) a.missed.push(Object.assign({ cycle_key: cycle.key, cycle_label: cycle.label }, m));
    }
    for (const f of ['owed', 'done', 'outstanding', 'on_time', 'late', 'not_applicable', 'published', 'unpublished']) {
      totals[f] += t.totals[f] || 0;
    }
    totals.days_late_total += (t.totals.avg_days_late || 0) * (t.totals.late || 0);
    if (t.totals.worst_days_late > totals.worst_days_late) totals.worst_days_late = t.totals.worst_days_late;
    for (const s of t.staff) for (const m of s.missed) {
      totals.missed.push(Object.assign({ cycle_key: cycle.key, staff_id: s.staff_id, staff_name: s.name }, m));
    }
  }

  const staff = [...byStaff.values()].map(finishAgg)
    .sort((a, b) => b.outstanding - a.outstanding || b.late - a.late || String(a.name).localeCompare(String(b.name)));

  return {
    on,
    academic_year: opts.academicYear || (wanted[0] && wanted[0].academic_year) || null,
    cycles: perCycle,
    staff,
    totals: finishAgg(totals),
  };
}

module.exports = { trackerFor, termReport, MANAGER_ROLES };
