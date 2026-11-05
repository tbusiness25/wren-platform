'use strict';
/*
 * Termly-update status (Prompt 28).
 *
 * A "termly update" (the EYFS "Termly Update & Tracking" document — formerly
 * called the Learning Journey PDF) is recorded as an observation with
 * observations.termly_update = true. Every key child should get one each cycle
 * (a rolling term of ~6–8 weeks). This module is the single source of truth for
 * "has this child had their termly update this cycle?" — shared by the
 * /api/observations/termly-status endpoint AND the reminder drainer so both
 * agree exactly.
 *
 * Cycle window is configurable in settings:
 *   termly_update_cycle_weeks  (default 8)  — Done if last update within this many weeks
 *   termly_update_grace_weeks  (default 2)  — Due during the grace window, Overdue after
 *
 * ── b246 (2026-08-28): THE CYCLE NOW FOLLOWS EALING'S TERM DATES ────────────
 * Toby: "every 6 weeks the child has termly update […] Follows ealing school dates."
 *
 * The rolling window described above put every child on a private clock counted
 * from their own last update. One child slipping a fortnight stayed a fortnight
 * out of step for good, a room's updates smeared across the calendar, and the
 * half-term breaks — when there is nothing to observe and nobody to hand a
 * document to — landed in the middle of somebody's cycle.
 *
 * So when `settings.termly_update_anchor` is 'school_terms' (the default, seeded
 * by migrations/2026-08-28-b246-termly-update.sql) the due and overdue dates come
 * from ladn.school_terms — Ealing's own published half-terms, loaded by b217 —
 * via src/lib/termly-cycle.js. The rolling logic is UNCHANGED and still runs
 * whenever the anchor is 'rolling', or the calendar cannot answer for today.
 *
 * TWO OTHER THINGS CHANGED HERE, both additive:
 *   • A b246 termly-update DOCUMENT (ladn.reports, report_type='termly_update',
 *     sent) now satisfies the cycle as well as the observations.termly_update
 *     flag. Both are real ways a practitioner writes one, and counting only the
 *     older path would have chased people for updates they had already sent.
 *   • Each child now carries cycle_key / cycle_label / due_on / overdue_on, so
 *     the reminder drainer and the boards can say WHICH half-term is outstanding
 *     rather than only "overdue".
 *
 * Every field this module returned before b246 is still returned, unchanged in
 * name and meaning, because staff-analytics, the /api/observations/termly-status
 * endpoint, the reminder drainer and src/lib/report-cycle.js all read them.
 */

const TC = require('../lib/termly-cycle');

const CYCLE_DEFAULT = 8;
const GRACE_DEFAULT = 2;

async function getCycleConfig(db) {
  let cycleWeeks = CYCLE_DEFAULT;
  let graceWeeks = GRACE_DEFAULT;
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings
       WHERE key IN ('termly_update_cycle_weeks','termly_update_grace_weeks')`);
    for (const r of rows) {
      const n = parseInt(r.value, 10);
      if (r.key === 'termly_update_cycle_weeks' && Number.isFinite(n) && n > 0) cycleWeeks = n;
      if (r.key === 'termly_update_grace_weeks' && Number.isFinite(n) && n >= 0) graceWeeks = n;
    }
  } catch (e) { /* settings table missing → defaults */ }
  return { cycleWeeks, graceWeeks };
}

// Classify a single child given days since last termly update (null = never)
// and days since enrolment (null = unknown).
function classify(daysSince, daysEnrolled, cycleWeeks, graceWeeks) {
  const cycleDays = cycleWeeks * 7;
  const graceDays = (cycleWeeks + graceWeeks) * 7;
  if (daysSince != null) {
    if (daysSince <= cycleDays) return 'done';
    if (daysSince <= graceDays) return 'due';
    return 'overdue';
  }
  // Never had a termly update: give recently-enrolled children the grace window
  // before they count as overdue.
  if (daysEnrolled != null && daysEnrolled <= graceDays) return 'due';
  return 'overdue';
}

// Cached per process: the answer only changes when a migration runs, which means
// a restart. `undefined` = not yet asked.
let _hasCycleKey;
async function _cycleKeyExists(db) {
  if (_hasCycleKey !== undefined) return _hasCycleKey;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'reports' AND column_name = 'cycle_key'
          AND table_schema = ANY (current_schemas(false)) LIMIT 1`);
    _hasCycleKey = rows.length > 0;
  } catch (_) {
    _hasCycleKey = false;
  }
  return _hasCycleKey;
}

/*
 * Returns { cycleWeeks, graceWeeks, children: [...] }.
 * Each child: { child_id, first_name, last_name, name, room_id, room_name,
 *   key_person_id, key_person_name, last_termly_date, last_obs_id, days_since, status }
 *
 * opts.staffId  — restrict to that staff member's key children (null = all)
 * opts.onlyKeyed — only children who have a key person assigned
 * opts.on       — b246: judge as at this 'YYYY-MM-DD' rather than today (testing,
 *                 and "what did this board look like in September")
 */
async function fetchTermlyStatuses(db, opts = {}) {
  const { staffId = null, onlyKeyed = false } = opts;
  const { cycleWeeks, graceWeeks } = await getCycleConfig(db);

  // ── b246: which half-term are we in? ──────────────────────────────────────
  // Loaded once for the whole sweep, and BEFORE the query, because the current
  // cycle's key is a parameter to it. `anchored` is false when the setting says
  // 'rolling' OR the calendar cannot answer for `on` — a nursery with no term
  // dates loaded keeps the pre-b246 behaviour rather than every child falling
  // off the board.
  const on = opts.on && /^\d{4}-\d{2}-\d{2}$/.test(opts.on) ? opts.on : TC.ymd(new Date());
  let cfg = null, cycle = null, calendar = null, anchored = false;
  try {
    const loaded = await TC.loadCycles(db);
    cfg = loaded.config;
    calendar = TC.calendarHealth(loaded.cycles, on);
    if (cfg.anchor === 'school_terms') {
      cycle = TC.currentCycle(loaded.cycles, on);
      anchored = !!cycle;
    }
  } catch (e) {
    // No school_terms table, or it could not be read. Fall back rather than fail:
    // this feeds the reminder drainer, and "I could not look" must not become
    // "nobody is overdue".
    calendar = { ok: false, code: 'unavailable', message: e.message };
  }

  const params = [];
  const conds = ['c.is_active = true'];
  if (staffId) { params.push(staffId); conds.push(`c.key_person_id = $${params.length}`); }
  if (onlyKeyed) conds.push('c.key_person_id IS NOT NULL');
  // ── Does this schema have b246's reports.cycle_key yet? ───────────────────
  // This function feeds the reminder drainer, and the drainer is started by the
  // server, not by a request. If a deploy lands before
  // migrations/2026-08-28-b246-termly-update.sql is run, an unguarded reference
  // to a missing column would make every sweep throw — and a sweep that throws is
  // a nursery that stops being reminded, silently. So the column is probed once
  // per process and the join is only added when it is really there.
  const hasCycleKey = await _cycleKeyExists(db);
  let cycleParam = null;
  if (hasCycleKey) {
    params.push(cycle ? cycle.key : null);
    cycleParam = `$${params.length}`;
  }
  const cycleJoin = hasCycleKey ? `
    -- A document written FOR this half-term satisfies this half-term, whatever
    -- date it happened to be sent on. The date comparison further down is the
    -- fallback for the older path — an observation flagged termly_update carries
    -- no cycle_key, so all we can do is ask which cycle its date falls in.
    -- Without this join, an update sent in the last days of the summer holiday
    -- for the Autumn 1 cycle would leave that cycle looking outstanding all term.
    LEFT JOIN LATERAL (
      SELECT rp.id AS cycle_report_id
      FROM reports rp
      WHERE rp.child_id = c.id AND rp.report_type = 'termly_update'
        AND rp.cycle_key = ${cycleParam} AND rp.sent_at IS NOT NULL
      ORDER BY rp.id DESC LIMIT 1
    ) thiscycle ON true` : '';
  const cycleCol = hasCycleKey ? 'thiscycle.cycle_report_id' : 'NULL::int AS cycle_report_id';

  // b246: the child's last termly update comes from EITHER path — the
  // observations.termly_update flag (how it has always been recorded) or a SENT
  // b246 document. `doc` is a LEFT JOIN LATERAL rather than a UNION so a schema
  // without the reports table would fail loudly here rather than silently
  // halving the answer; every schema carrying observations carries reports.
  const { rows } = await db.query(`
    SELECT c.id AS child_id, c.first_name, c.last_name,
           c.first_name || ' ' || c.last_name AS name,
           c.room_id, r.name AS room_name,
           c.key_person_id,
           kp.first_name || ' ' || kp.last_name AS key_person_name,
           COALESCE(c.start_date, c.created_at::date) AS enrolled_date,
           to_char(c.start_date,'YYYY-MM-DD') AS start_ymd,
           to_char(c.leave_date,'YYYY-MM-DD') AS leave_ymd,
           t.last_date, t.last_obs_id,
           doc.last_sent_date, doc.last_report_id,
           pr.last_pr_date, pr.last_parent_report_id,
           ${cycleCol}
    FROM children c
    LEFT JOIN rooms r ON r.id = c.room_id
    LEFT JOIN staff kp ON kp.id = c.key_person_id
    -- weeklybugs-20261031 (staff-app:16): created_at/sent_at/finalised_at are timestamptz;
    -- a bare ::date truncates in the SESSION timezone (UTC), not Europe/London, so a row
    -- logged just after midnight BST (e.g. 00:30 local = 23:30 UTC the day before) reads
    -- a day earlier than its real London calendar date — the exact miss that can put
    -- last_date just short of cycle.opens_on and mark a current child overdue.
    LEFT JOIN LATERAL (
      SELECT (o.created_at AT TIME ZONE 'Europe/London')::date AS last_date, o.id AS last_obs_id
      FROM observations o
      WHERE o.child_id = c.id AND o.termly_update = true
      ORDER BY o.created_at DESC LIMIT 1
    ) t ON true
    LEFT JOIN LATERAL (
      SELECT (rp.sent_at AT TIME ZONE 'Europe/London')::date AS last_sent_date, rp.id AS last_report_id
      FROM reports rp
      WHERE rp.child_id = c.id AND rp.report_type = 'termly_update'
        AND rp.sent_at IS NOT NULL
      ORDER BY rp.sent_at DESC LIMIT 1
    ) doc ON true
    -- termly-fix-20261030: the third path. Nest's "Write report" (/ey/reports/summative,
    -- where trackers, home and the obs tracker all send staff) writes ladn.parent_reports,
    -- which this board never read — a finished termly report left the child "Overdue".
    -- A FINALISED or SENT termly report counts; a draft does not.
    LEFT JOIN LATERAL (
      SELECT (COALESCE(pr0.sent_at, pr0.finalised_at) AT TIME ZONE 'Europe/London')::date AS last_pr_date, pr0.id AS last_parent_report_id
      FROM parent_reports pr0
      WHERE pr0.child_id = c.id AND pr0.report_type = 'termly'
        AND (pr0.sent_at IS NOT NULL OR pr0.finalised_at IS NOT NULL)
      ORDER BY COALESCE(pr0.sent_at, pr0.finalised_at) DESC LIMIT 1
    ) pr ON true${cycleJoin}
    WHERE ${conds.join(' AND ')}
    ORDER BY c.first_name, c.last_name
  `, params);

  const now = Date.now();
  const DAY = 86400000;
  const children = rows.map(row => {
    const obsDate  = row.last_date ? TC.ymd(row.last_date) : null;
    const sentDate = row.last_sent_date ? TC.ymd(row.last_sent_date) : null;
    const prDate   = row.last_pr_date ? TC.ymd(row.last_pr_date) : null;   // termly-fix-20261030
    // Whichever is later. A child can legitimately have both: an observation
    // flagged in Autumn 1 and a b246 document sent in Autumn 2.
    const lastYmd = [obsDate, sentDate, prDate].filter(Boolean).sort().pop() || null;
    const lastDate = lastYmd ? new Date(lastYmd) : null;
    const enrolled = row.enrolled_date ? new Date(row.enrolled_date) : null;
    const daysSince    = lastDate ? Math.floor((now - lastDate.getTime()) / DAY) : null;
    const daysEnrolled = enrolled ? Math.floor((now - enrolled.getTime()) / DAY) : null;

    let status, cycleFields = {
      cycle_key: null, cycle_label: null, due_on: null, overdue_on: null,
      anchor: anchored ? 'school_terms' : 'rolling', reason: null,
    };
    if (anchored) {
      // An update SENT for this cycle counts as this cycle's, on any date. Passed
      // to statusFor as the cycle's opening day so it satisfies the comparison
      // without the caller having to know how that comparison works.
      const forThisCycle = row.cycle_report_id ? cycle.opens_on : null;
      const effective = [lastYmd, forThisCycle].filter(Boolean).sort().pop() || null;
      const st = TC.statusFor(cycle,
        { start_date: row.start_ymd, leave_date: row.leave_ymd }, effective, on, cfg);
      // 'not_applicable' (too new to be owed this cycle, or already left) is a
      // b246 state the pre-b246 vocabulary has no word for. It maps to 'done' for
      // every existing caller — the drainer must not chase it and the tracker
      // must not colour it red — and `state` carries the real answer for callers
      // that know about it.
      status = st.state === 'not_applicable' ? 'done'
             : (st.state === 'upcoming' ? 'done' : st.state);
      cycleFields = {
        cycle_key: st.cycle_key, cycle_label: st.cycle_label,
        due_on: st.due_on, overdue_on: st.overdue_on,
        anchor: 'school_terms', reason: st.reason, state: st.state,
      };
    } else {
      status = classify(daysSince, daysEnrolled, cycleWeeks, graceWeeks);
      cycleFields.state = status;
    }

    return {
      child_id: row.child_id,
      first_name: row.first_name,
      last_name: row.last_name,
      name: row.name,
      room_id: row.room_id,
      room_name: row.room_name,
      key_person_id: row.key_person_id,
      key_person_name: row.key_person_id ? row.key_person_name : null,
      last_termly_date: lastYmd,
      last_obs_id: row.last_obs_id || null,
      // b246 — which of the two paths the last update came from, and the document
      // if it was one, so a board can link straight to it.
      last_update_source: lastYmd ? (lastYmd === sentDate ? 'termly_update'
        : lastYmd === prDate ? 'termly_report' : 'observation') : null,
      last_parent_report_id: lastYmd && lastYmd === prDate ? row.last_parent_report_id : null,
      last_report_id: lastYmd && lastYmd === sentDate ? row.last_report_id : null,
      // b246 — the document written for THIS half-term, if one has been sent.
      cycle_report_id: row.cycle_report_id || null,
      days_since: daysSince,
      status,
      ...cycleFields,
    };
  });

  return { cycleWeeks, graceWeeks, children, anchor: anchored ? 'school_terms' : 'rolling',
           cycle: cycle || null, calendar, on };
}

module.exports = { getCycleConfig, classify, fetchTermlyStatuses };
