'use strict';
/**
 * termly-cycle.js — b246 (2026-08-28)
 *
 * WHEN a child's termly update is due, on Ealing's school term dates.
 *
 * ── WHY NOT SIX WEEKS FROM THE LAST ONE ─────────────────────────────────────
 * Toby, 2026-08-28: "every 6 weeks the child has termly update […] Follows
 * ealing school dates."
 *
 * Those two sentences are not the same rule, and the second one wins. A rolling
 * six weeks from each child's own last update — which is what
 * src/services/termly-status.js did before this build — puts every child on a
 * private clock. One child slips a fortnight and is permanently a fortnight out
 * of step with the room; a whole room's updates smear across the calendar; and
 * the half-term breaks, when there is nothing to observe and nobody to hand a
 * document to, land in the middle of somebody's cycle.
 *
 * Anchoring to the half-term fixes all three at once. Ealing's 2026/27 year has
 * six half-terms averaging 6.4 teaching weeks, so "every six weeks" comes out
 * right anyway — but it comes out right in a way that lands the whole room
 * together, on dates the families already know, with the breaks where the
 * nursery's breaks are.
 *
 * ── WHERE THE DATES COME FROM ───────────────────────────────────────────────
 * ladn.school_terms and ladn.school_breaks, seeded by b217 from ealing.gov.uk
 * (source column records the fetch). This module adds NO new source of term
 * dates and no second copy of them — it reads src/lib/school-calendar.js, the
 * same loader the planner uses.
 *
 * ── ONE CYCLE PER HALF-TERM ─────────────────────────────────────────────────
 * Cycle H opens on the first day of half-term H. That is the earliest the update
 * can honestly be written, because it is the first day on which the term it
 * looks BACK at (H-1) is complete.
 *
 *   opens_on    H.start_date
 *   due_on      opens_on + due_weeks       (default 2)
 *   overdue_on  opens_on + overdue_weeks   (default 4)
 *   closes_on   H.end_date
 *
 * Due early on purpose. The update says what went well last term and what we are
 * working on THIS term; written in week five of a six-week half-term the second
 * half of it describes a term that is over, and the next steps it sets have no
 * time left to be worked on.
 *
 * ── A CHILD WHO STARTS MID-TERM ─────────────────────────────────────────────
 * They are not owed the cycle that is already running. A child who joined on the
 * Wednesday of week four has no "last term" and three days of "this term"; an
 * update for them would be a form with nothing in it, and the board would show
 * it overdue by the following Monday. owedBy() requires min_days (default 21) of
 * attendance by the cycle's due date, so their first update is the next cycle —
 * which is also the first one where the look-back window contains anything.
 *
 * Nothing in this file knows about rooms, and that is deliberate. A child moving
 * baby room -> pre-school stays on the same cycle as everybody else, because the
 * cycle belongs to the calendar and not to the child.
 */

const SC = require('./school-calendar');

// Defaults are the numbers in migrations/2026-08-28-b246-termly-update.sql.
// Duplicated here so the library works on a schema where the settings rows were
// never inserted, rather than falling back to zero and declaring everything due.
const DEFAULTS = {
  anchor: 'school_terms',
  due_weeks: 2,
  overdue_weeks: 4,
  min_days: 21,
  // Only used by the 'rolling' fallback, and read from the PRE-b246 keys so the
  // old behaviour is byte-for-byte the old behaviour.
  cycle_weeks: 8,
  grace_weeks: 2,
};

const SETTING_KEYS = {
  anchor:        'termly_update_anchor',
  due_weeks:     'termly_update_due_weeks',
  overdue_weeks: 'termly_update_overdue_weeks',
  min_days:      'termly_update_min_days',
  cycle_weeks:   'termly_update_cycle_weeks',
  grace_weeks:   'termly_update_grace_weeks',
};

async function loadConfig(db) {
  const cfg = Object.assign({}, DEFAULTS);
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
      [Object.values(SETTING_KEYS)]);
    const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (byKey[SETTING_KEYS.anchor] === 'rolling') cfg.anchor = 'rolling';
    for (const field of ['due_weeks', 'overdue_weeks', 'min_days', 'cycle_weeks', 'grace_weeks']) {
      const n = parseInt(byKey[SETTING_KEYS[field]], 10);
      // >= 0: a setting of 0 due_weeks ("due on the first day of term") is a
      // legitimate choice. Only a missing or non-numeric value falls back.
      if (Number.isFinite(n) && n >= 0) cfg[field] = n;
    }
  } catch (_) { /* no settings table — the defaults above are Toby's cadence */ }
  return cfg;
}

// ── Dates ────────────────────────────────────────────────────────────────────
// Everything here is a 'YYYY-MM-DD' string. school-calendar.js casts its dates
// with to_char for exactly this reason: string comparison on that format is date
// comparison, and nothing depends on how the driver parsed a DATE. See
// memory/reference_pg_date_ymd_trap.md — pg hands a DATE back as a local-midnight
// JS Date and toISOString() on that moves a BST date back a day.
const { isYmd, addDays, todayYmd, fmtLong, fmtRange, academicYearOf } = SC;
const addWeeks = (ymd, n) => addDays(ymd, n * 7);

/** 'YYYY-MM-DD' from whatever pg or a caller handed over. LOCAL getters. */
function ymd(v) {
  if (!v) return null;
  if (typeof v === 'string') return isYmd(v) ? v : (isYmd(v.slice(0, 10)) ? v.slice(0, 10) : null);
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(a, b) {
  if (!isYmd(a) || !isYmd(b)) return null;
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

/**
 * The stable identifier for a cycle: '2026-2027/autumn-1'.
 *
 * It goes in reports.cycle_key and is what the unique index keys on, so it must
 * never change for a half-term that already has documents against it. Built from
 * academic_year + term + half rather than from the row id, because a term row
 * re-imported from ealing.gov.uk gets a new id and would orphan every update
 * written against the old one.
 */
function cycleKey(term) {
  const year = term.academic_year || academicYearOf(term.start_date);
  const name = String(term.term || term.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const half = term.half == null ? '' : '-' + term.half;
  return `${year}/${name}${half}`;
}

/**
 * Every termly-update cycle the calendar knows about, in date order.
 *
 * @param {Array}  terms   ladn.school_terms rows (school-calendar.loadHalfTerms)
 * @param {Array}  breaks  ladn.school_breaks rows — carried through so the UI can
 *                         say "written over the half-term break" without a second query
 * @param {object} cfg     loadConfig()
 */
function buildCycles(terms, breaks, cfg) {
  const conf = Object.assign({}, DEFAULTS, cfg || {});
  const sorted = (terms || []).filter(t => isYmd(t.start_date) && isYmd(t.end_date))
    .slice().sort((a, b) => a.start_date.localeCompare(b.start_date));

  return sorted.map((t, i) => {
    // What "last term" means for this cycle: the half-term immediately before it
    // IN THE CALENDAR. When the calendar does not go back that far — which is the
    // case for Autumn 1 2026/27, the first half-term Wren holds — the look-back
    // is a plain 8 weeks before this term started, and reviewsIsPartial says so
    // rather than the document quietly reviewing less than it claims.
    const prev = i > 0 ? sorted[i - 1] : null;
    const opens = t.start_date;
    return {
      key: cycleKey(t),
      half_term_id: t.id,
      academic_year: t.academic_year || academicYearOf(opens),
      term: t.term || null,
      half: t.half == null ? null : Number(t.half),
      name: t.name || [t.term, t.half].filter(x => x != null).join(' '),
      label: `${t.name || t.term} ${t.academic_year || academicYearOf(opens)}`,
      term_start: opens,
      term_end: t.end_date,
      opens_on: opens,
      due_on: addWeeks(opens, conf.due_weeks),
      overdue_on: addWeeks(opens, conf.overdue_weeks),
      closes_on: t.end_date,
      // The window the "what went well last term" section is written from.
      reviews: prev ? { name: prev.name || prev.term, from: prev.start_date, to: prev.end_date } : null,
      reviews_from: prev ? prev.start_date : addWeeks(opens, -8),
      reviews_to: prev ? prev.end_date : addDays(opens, -1),
      reviews_is_previous_half_term: !!prev,
      // Non-teaching days inside this half-term, for the review screen's context.
      closures: (breaks || []).filter(b => b.start_date <= t.end_date && b.end_date >= opens)
        .map(b => ({ name: b.name, kind: b.kind, start_date: b.start_date, end_date: b.end_date })),
      pretty: {
        term: fmtRange(opens, t.end_date),
        due: fmtLong(addWeeks(opens, conf.due_weeks)),
      },
    };
  });
}

/** Load the cycles straight from the database. */
async function loadCycles(db, opts = {}) {
  const cfg = opts.config || await loadConfig(db);
  // Every academic year, not just the current one: the current cycle in early
  // September belongs to the year that has just begun, and the one it reviews
  // belongs to the year that has just ended.
  const [terms, breaks] = await Promise.all([SC.loadHalfTerms(db, null), SC.loadBreaks(db, null)]);
  return { config: cfg, cycles: buildCycles(terms, breaks, cfg), terms, breaks };
}

/**
 * The cycle that is LIVE on a given date — the most recent one to have opened.
 *
 * Note it stays live through the half-term break that follows it: on the Tuesday
 * of October half term the Autumn 1 update is still the one being chased, and
 * Autumn 2's does not open until 2 November. That is the intended behaviour and
 * it is why this is "the last one to open" rather than "the one covering today".
 */
function currentCycle(cycles, on) {
  const day = on || todayYmd();
  let live = null;
  for (const c of cycles) { if (c.opens_on <= day) live = c; else break; }
  return live;
}

function nextCycle(cycles, on) {
  const day = on || todayYmd();
  return cycles.find(c => c.opens_on > day) || null;
}

function cycleByKey(cycles, key) {
  return cycles.find(c => c.key === key) || null;
}

/**
 * Is this child owed THIS cycle's update?
 *
 * @returns {{owed:boolean, reason:string|null}}
 */
function owedBy(cycle, child, cfg) {
  const conf = Object.assign({}, DEFAULTS, cfg || {});
  const start = ymd(child && child.start_date);
  const leave = ymd(child && child.leave_date);
  if (!cycle) return { owed: false, reason: 'There is no school term calendar covering this date.' };
  if (!start) return { owed: false, reason: 'No start date on file, so we cannot tell which cycle they joined on.' };

  // Gone before it was due. Not owed, and not a failure.
  if (leave && leave < cycle.due_on) {
    return { owed: false, reason: `Left ${fmtLong(leave)}, before this update was due.` };
  }

  const settled = daysBetween(start, cycle.due_on);
  if (settled == null || settled < conf.min_days) {
    return {
      owed: false,
      reason: `Started ${fmtLong(start)}, ${settled == null ? 'less than' : settled < 0 ? 'after' : 'only ' + settled + ' days before'} `
            + `this update was due. Their first progress update is the next one — there is not yet a term to look back on.`,
    };
  }
  return { owed: true, reason: null };
}

/**
 * The state of one child against one cycle.
 *
 * @param {object} cycle
 * @param {object} child       { start_date, leave_date }
 * @param {string} lastUpdate  'YYYY-MM-DD' of their most recent termly update
 *                             (observation flag OR sent b246 document), or null
 * @param {string} on          the date to judge as at
 * @param {object} cfg
 * @returns {{state, reason, cycle_key, due_on, overdue_on, opens_on, days_over}}
 *
 * States, the same vocabulary src/lib/report-cycle.js uses:
 *   done            an update dated on or after this cycle opened
 *   upcoming        the cycle is open but not yet due
 *   due / overdue   past the respective date with nothing on file
 *   not_applicable  not owed this cycle, always with a reason
 */
function statusFor(cycle, child, lastUpdate, on, cfg) {
  const day = on || todayYmd();
  const base = cycle ? {
    cycle_key: cycle.key, cycle_label: cycle.label,
    opens_on: cycle.opens_on, due_on: cycle.due_on, overdue_on: cycle.overdue_on,
    closes_on: cycle.closes_on,
    days_over: daysBetween(cycle.due_on, day),
  } : { cycle_key: null, cycle_label: null, opens_on: null, due_on: null, overdue_on: null,
        closes_on: null, days_over: null };

  if (!cycle) {
    return Object.assign(base, {
      state: 'not_applicable',
      reason: 'No school term calendar covers this date, so there is no cycle to be due in.',
    });
  }

  const owed = owedBy(cycle, child, cfg);
  const last = ymd(lastUpdate);

  if (!owed.owed) {
    // A child not owed the CURRENT cycle may still have had one in a past cycle.
    // Report it, so the screen can show "last update 12 Sept" rather than nothing.
    return Object.assign(base, { state: 'not_applicable', reason: owed.reason, last_update: last });
  }
  if (last && last >= cycle.opens_on) {
    return Object.assign(base, {
      state: 'done', reason: `Written ${fmtLong(last)} for ${cycle.label}.`, last_update: last,
    });
  }
  if (day >= cycle.overdue_on) return Object.assign(base, { state: 'overdue', reason: null, last_update: last });
  if (day >= cycle.due_on)     return Object.assign(base, { state: 'due',     reason: null, last_update: last });
  return Object.assign(base, {
    state: 'upcoming', last_update: last,
    reason: `${cycle.label} opened ${fmtLong(cycle.opens_on)}; this update is due ${fmtLong(cycle.due_on)}.`,
  });
}

/**
 * Is the calendar in a fit state to schedule from, and if not, what is wrong?
 *
 * Said out loud rather than logged, because the failure is silent otherwise: a
 * calendar that has run out produces a board with nothing on it, which reads
 * exactly like a board with nothing outstanding. Ealing publish one academic
 * year at a time, so this WILL come true — b217 fetched 2026/27 on 2026-08-24
 * and there is nothing beyond 27 July 2027.
 */
function calendarHealth(cycles, on) {
  const day = on || todayYmd();
  if (!cycles.length) {
    return { ok: false, code: 'no_calendar',
      message: 'No school term dates are loaded, so progress updates cannot follow Ealing\'s calendar. '
             + 'Add the term dates under Planning → Term calendar.' };
  }
  const last = cycles[cycles.length - 1];
  const live = currentCycle(cycles, day);
  if (!live) {
    return { ok: false, code: 'before_calendar', next: cycles[0].key,
      message: `The term calendar starts on ${fmtLong(cycles[0].opens_on)}. There is no cycle covering ${fmtLong(day)}.` };
  }
  const daysLeft = daysBetween(day, last.closes_on);
  if (daysLeft != null && daysLeft < 84) {
    return { ok: true, code: 'running_out', through: last.closes_on, days_left: daysLeft,
      message: `The term calendar runs out on ${fmtLong(last.closes_on)} (${last.label}). `
             + 'Add next year\'s Ealing dates before then or progress updates will stop being scheduled.' };
  }
  return { ok: true, code: 'ok', through: last.closes_on, days_left: daysLeft, message: null };
}

module.exports = {
  DEFAULTS, SETTING_KEYS,
  loadConfig, loadCycles, buildCycles, cycleKey,
  currentCycle, nextCycle, cycleByKey,
  owedBy, statusFor, calendarHealth,
  ymd, daysBetween, addWeeks,
};
