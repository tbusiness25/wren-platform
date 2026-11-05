'use strict';
/**
 * b317 — the off-the-job training rules, and the young-worker limits, in ONE file.
 *
 * ── WHY A FILE AND NOT A LOOKUP TABLE ───────────────────────────────────────
 * These are rules of law and funding policy, not settings of this nursery. A
 * manager must not be able to edit "progress reviews don't count" out of the
 * system from a screen, and a tenant must not be able to drift away from it by
 * never running a migration. The one figure that IS per-apprenticeship — the
 * target hours — lives in the database, because it comes from the standard and
 * from that apprentice's recorded prior learning.
 *
 * ── PROVENANCE (all retrieved 2026-09-11) ───────────────────────────────────
 * Off-the-job training, the eligible/ineligible lists, the paid-hours rule and
 * the evidence tests:
 *   Apprenticeship off-the-job training guidance, version 6, August 2026 (DfE)
 *   https://www.gov.uk/government/publications/apprenticeships-off-the-job-training
 *   — Q12 the 4 tests; Q14 eligible activities; Q15 shadowing and mentoring;
 *     Q26 what cannot be included; Q7 compensation outside working hours;
 *     Q87 what the evidence must show.
 *
 * The 187-hour floor:
 *   Apprenticeship funding rules 2026 to 2027 (DfE) — a programme must not
 *   require less than 187 hours of off-the-job training; recognition of prior
 *   learning must not bring the required hours below it. (187 is 20% of eight
 *   months, which is where the number comes from; it is NOT a percentage rule.)
 *
 * The 20% rule is GONE. From 1 August 2025 each standard publishes its own
 * minimum. Nothing in this file multiplies anybody's working hours by 0.2, and
 * nothing in it knows a number for any particular standard — those are rows in
 * ladn.apprenticeship_standards, each carrying the URL it came from.
 *
 * Young workers (16–17):
 *   Working Time Regulations 1998 (SI 1998/1833)
 *   reg 5A  — 8 hours a day, 40 hours a week
 *   reg 10(2) — 12 consecutive hours' rest in each 24-hour period
 *   reg 11(3) — 48 hours' rest in each seven-day period
 *   reg 12(4) — a 30-minute break where daily working time exceeds 4.5 hours
 *   https://www.legislation.gov.uk/uksi/1998/1833
 */

// ── the funding floor ───────────────────────────────────────────────────────
const OTJ_FLOOR_HOURS = 187;

// ── what COUNTS ─────────────────────────────────────────────────────────────
// Toby's instinct is in this list and it is correct: in childcare most of the
// teaching is a room leader showing an apprentice something on the floor, and
// practical training, shadowing and mentoring are all eligible — provided the
// learning is NEW and it is written down.
const ACTIVITY_TYPES = [
  { key: 'practical',        label: 'Practical training on the floor',
    hint: 'Being taught to do something new in the room — a nappy-change routine, a new sleep check, setting up a provision area.' },
  { key: 'shadowing',        label: 'Shadowing',
    hint: 'Watching a colleague do something the apprentice has not yet learned. Not general "getting up to speed".' },
  { key: 'mentoring',        label: 'Mentoring or coaching on a topic',
    hint: 'A mentor teaching a specific topic from the standard. Pastoral support is not off-the-job training.' },
  { key: 'theory',           label: 'Taught theory',
    hint: 'A lecture, a session with the assessor, a taught workshop.' },
  { key: 'online',           label: 'Structured online learning',
    hint: 'An e-learning module or a webinar, done in paid hours.' },
  { key: 'simulation',       label: 'Role play or simulation',
    hint: 'Practising a scenario — a fire drill walkthrough taught as training, a safeguarding role play.' },
  { key: 'assignment',       label: 'Writing an assignment or portfolio evidence',
    hint: 'Time spent writing up, where the writing itself develops the knowledge.' },
  { key: 'revision',         label: 'Revision',
    hint: 'Preparing for the end-point assessment. The exam itself does not count.' },
  { key: 'learning_support', label: 'One-to-one learning support',
    hint: 'Extra time or personal support from the provider to help the apprentice stay on track.' },
  { key: 'industry_visit',   label: 'Industry visit',
    hint: 'A visit to another setting, where it teaches something new from the standard.' },
];
const ACTIVITY_KEYS = new Set(ACTIVITY_TYPES.map(a => a.key));

// ── what does NOT count, and WHY ────────────────────────────────────────────
// The reason is the point. A silent rejection teaches nobody; "progress reviews
// don't count as off-the-job training — they are a discussion about progress,
// not new learning" means the next entry is right first time.
const EXCLUDED_TYPES = [
  { key: 'progress_review',
    label: 'Progress review',
    reason: "Progress reviews don't count as off-the-job training — a review is a discussion about progress, not the teaching of anything new." },
  { key: 'english_maths',
    label: 'Standalone English or maths',
    reason: "Standalone English and maths qualifications don't count — an apprenticeship assumes the required level already, so this time is additional to it." },
  { key: 'exam',
    label: 'Exam or on-programme test',
    reason: "Exams and on-programme testing don't count — a test shows what has already been learned, it doesn't teach anything new. Revision beforehand does count." },
  { key: 'initial_assessment',
    label: 'Initial assessment',
    reason: "Initial assessment doesn't count — it establishes what training is needed rather than delivering any of it." },
  { key: 'onboarding',
    label: 'Onboarding or paperwork',
    reason: "Onboarding doesn't count — agreeing paperwork and setting somebody up is not new knowledge, skills or behaviours." },
  { key: 'existing_duties',
    label: 'Doing the job they can already do',
    reason: "Just doing the job doesn't count — off-the-job training has to teach something NEW against the standard. Write down what was new and pick the activity that delivered it." },
  { key: 'pastoral',
    label: 'Pastoral support',
    reason: "Pastoral mentoring doesn't count — it has to be teaching a topic from the apprenticeship standard, not general wellbeing support." },
];
const EXCLUDED_BY_KEY = new Map(EXCLUDED_TYPES.map(e => [e.key, e]));

// A few plain-English spellings people will actually type into the box, mapped
// onto the excluded reason so the refusal still explains itself.
const EXCLUDED_ALIASES = new Map([
  ['progress review', 'progress_review'], ['review', 'progress_review'],
  ['progress_reviews', 'progress_review'], ['progress-review', 'progress_review'],
  ['english', 'english_maths'], ['maths', 'english_maths'], ['functional skills', 'english_maths'],
  ['english and maths', 'english_maths'], ['english_and_maths', 'english_maths'],
  ['exam', 'exam'], ['examination', 'exam'], ['test', 'exam'], ['epa', 'exam'],
  ['end point assessment', 'exam'], ['end-point assessment', 'exam'],
  ['initial assessment', 'initial_assessment'], ['induction', 'onboarding'],
  ['onboarding', 'onboarding'], ['paperwork', 'onboarding'],
  ['pastoral', 'pastoral'],
]);

/** The excluded rule this value trips, or null. Accepts a key or loose text. */
function excludedFor(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return null;
  if (EXCLUDED_BY_KEY.has(raw)) return EXCLUDED_BY_KEY.get(raw);
  const alias = EXCLUDED_ALIASES.get(raw) || EXCLUDED_ALIASES.get(raw.replace(/[_-]/g, ' '));
  return alias ? EXCLUDED_BY_KEY.get(alias) : null;
}

// ── the target ──────────────────────────────────────────────────────────────
/**
 * The hours THIS apprentice is held to.
 *   published  the standard's own minimum ("Minimum hours for compliance"), or
 *              null when we have not verified it — in which case there is no
 *              target, and the screen must say so rather than show a number.
 *   prior      hours of documented prior learning to deduct.
 *
 * Returns { hours, floored, published, prior, note } — `hours` is null when no
 * published figure is known. Never guesses, never falls back to a percentage.
 */
function computeTarget(published, prior) {
  const pub = (published == null || published === '') ? null : Number(published);
  const pl = Math.max(0, Number(prior) || 0);
  if (pub == null || !isFinite(pub) || pub <= 0) {
    return {
      hours: null, floored: false, published: null, prior: pl,
      note: "Target not set — enter it from your provider's training plan, or from the standard's page on the Skills England site.",
    };
  }
  const reduced = pub - pl;
  const hours = Math.max(OTJ_FLOOR_HOURS, reduced);
  const floored = reduced < OTJ_FLOOR_HOURS;
  return {
    hours: Math.round(hours * 100) / 100,
    floored, published: pub, prior: pl,
    note: floored
      ? `Prior learning would have taken this to ${Math.round(reduced)} hours, but the funding floor is ${OTJ_FLOOR_HOURS} — recognition of prior learning must not take the requirement below it.`
      : null,
  };
}

/** Is a proposed target allowed? The 187 floor, stated as a sentence. */
function validateTarget(hours) {
  if (hours == null || hours === '') return { ok: true, value: null };
  const n = Number(hours);
  if (!isFinite(n)) return { ok: false, error: 'Target hours must be a number.' };
  if (n < OTJ_FLOOR_HOURS) {
    return {
      ok: false,
      error: `An off-the-job target cannot be set below ${OTJ_FLOOR_HOURS} hours. That is the funding floor — recognition of prior learning must not bring the required hours below it.`,
    };
  }
  return { ok: true, value: Math.round(n * 100) / 100 };
}

// ── one entry ───────────────────────────────────────────────────────────────
/**
 * Validate an off-the-job entry. Returns { ok:true, value } or
 * { ok:false, error, field, rule? } where `rule` names the excluded activity so
 * the caller can show the reason rather than a generic 400.
 *
 * The four tests this enforces, in the guidance's own terms:
 *   new            -> what_was_new, required, and long enough to be evidence
 *   relevant       -> activity_type is one of the eligible ones; ksb_ref asked for
 *   in paid hours  -> in_paid_hours, or compensated with a note saying how
 *   eligible       -> the excluded list is refused BY NAME with its reason
 */
function validateEntry(body) {
  const b = body || {};

  // eligible activity — checked FIRST, because if this is a progress review
  // nothing else about the entry matters and the reason is what they need.
  const excluded = excludedFor(b.activity_type);
  if (excluded) {
    return { ok: false, field: 'activity_type', rule: excluded.key, error: excluded.reason };
  }
  const type = String(b.activity_type || '').trim();
  if (!ACTIVITY_KEYS.has(type)) {
    return {
      ok: false, field: 'activity_type',
      error: 'Pick what kind of training this was. Allowed: ' + ACTIVITY_TYPES.map(a => a.key).join(', ') + '.',
    };
  }

  const date = String(b.entry_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, field: 'entry_date', error: 'A date is required — an auditor has to be able to see the training fell in normal working hours.' };
  }

  const minutes = Math.round(Number(b.minutes));
  if (!isFinite(minutes) || minutes <= 0) {
    return { ok: false, field: 'minutes', error: 'How long did it take? Off-the-job evidence has to be quantifiable, in hours.' };
  }
  if (minutes > 1440) {
    return { ok: false, field: 'minutes', error: 'More than 24 hours in one entry — split it across the days it happened on.' };
  }

  // new knowledge, skills or behaviours — the evidence itself
  const whatWasNew = String(b.what_was_new == null ? '' : b.what_was_new).trim();
  if (whatWasNew.length < 10) {
    return {
      ok: false, field: 'what_was_new',
      error: 'Write what was NEW. This is the evidence — an auditor reads this line to see the apprentice learned something they could not already do. A few words is enough, but it has to say what changed.',
    };
  }

  // in paid hours, or compensated
  const inPaid = b.in_paid_hours === undefined ? true : !!b.in_paid_hours;
  const compensated = !!b.compensated;
  if (!inPaid && !compensated) {
    return {
      ok: false, field: 'in_paid_hours',
      error: 'Off-the-job training has to take place in normal working hours. If this had to fall outside them, it only counts where the apprentice agreed and was compensated — tick compensated and say whether it was time off in lieu or an extra payment.',
    };
  }
  const compNote = String(b.compensation_note == null ? '' : b.compensation_note).trim();
  if (!inPaid && compensated && compNote.length < 4) {
    return {
      ok: false, field: 'compensation_note',
      error: 'Say how it was compensated — time off in lieu, or an additional payment. The progress review is where that gets confirmed.',
    };
  }

  return {
    ok: true,
    value: {
      entry_date: date,
      minutes,
      activity_type: type,
      delivery_method: strOrNull(b.delivery_method),
      ksb_ref: strOrNull(b.ksb_ref),
      what_was_new: whatWasNew,
      in_paid_hours: inPaid,
      compensated: !inPaid ? true : compensated,
      compensation_note: compNote || null,
    },
  };
}

function strOrNull(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s : null;
}

// ── progress ────────────────────────────────────────────────────────────────
/**
 * The number that tells a manager early. Hours still to do, divided by the weeks
 * left — so "4.2 hours a week from here" is comparable with the planned weekly
 * figure, and a gap between the two is visible months before the end date.
 *
 * Returns { target, logged, remaining, weeks_left, per_week_needed, on_track,
 *           status, note }. Everything is null-safe: no target, or no end date,
 *           returns nulls rather than a made-up number.
 */
function progress({ targetHours, loggedMinutes, endDate, today, plannedWeekly }) {
  const target = (targetHours == null || targetHours === '') ? null : Number(targetHours);
  const logged = Math.round(((Number(loggedMinutes) || 0) / 60) * 100) / 100;
  const out = {
    target, logged,
    remaining: null, weeks_left: null, per_week_needed: null,
    pct: null, on_track: null, status: 'unknown', note: null,
  };
  if (target == null || !isFinite(target) || target <= 0) {
    out.note = "No target set for this apprenticeship — enter it from the provider's training plan.";
    return out;
  }
  out.pct = Math.min(100, Math.round((logged / target) * 1000) / 10);
  out.remaining = Math.round(Math.max(0, target - logged) * 100) / 100;

  if (!endDate) {
    out.note = 'No expected end date, so hours-per-week cannot be worked out.';
    return out;
  }
  const days = daysBetween(today, endDate);
  if (out.remaining === 0) {
    out.weeks_left = Math.max(0, Math.round((days / 7) * 10) / 10);
    out.per_week_needed = 0;
    out.on_track = true;
    out.status = 'complete';
    out.note = 'Target reached.';
    return out;
  }
  if (days <= 0) {
    out.weeks_left = 0;
    out.per_week_needed = null;
    out.on_track = false;
    out.status = 'overdue';
    out.note = `The expected end date has passed with ${out.remaining} hours still to log.`;
    return out;
  }
  const weeks = days / 7;
  out.weeks_left = Math.round(weeks * 10) / 10;
  out.per_week_needed = Math.round((out.remaining / weeks) * 100) / 100;

  // "Behind" is judged against the PLANNED weekly figure where there is one,
  // because that is what the training plan promised. Without one, the honest
  // comparison is against the even rate the whole programme implies.
  const bar = (plannedWeekly != null && Number(plannedWeekly) > 0) ? Number(plannedWeekly) : null;
  if (bar != null) {
    out.on_track = out.per_week_needed <= bar;
    out.status = out.on_track ? 'on_track' : (out.per_week_needed > bar * 1.5 ? 'behind' : 'slipping');
    out.note = out.on_track
      ? `${out.per_week_needed} hours a week from here, against a plan of ${bar}.`
      : `${out.per_week_needed} hours a week are now needed, against a plan of ${bar}.`;
  } else {
    out.status = 'no_plan';
    out.note = `${out.per_week_needed} hours a week from here. No planned weekly figure is recorded to compare it with.`;
  }
  return out;
}

function daysBetween(fromYmd, toYmd) {
  const a = Date.UTC(...String(fromYmd).slice(0, 10).split('-').map(Number).map((v, i) => i === 1 ? v - 1 : v));
  const b = Date.UTC(...String(toYmd).slice(0, 10).split('-').map(Number).map((v, i) => i === 1 ? v - 1 : v));
  return Math.round((b - a) / 86400000);
}

// ════════════════════════════════════════════════════════════════════════════
// YOUNG WORKERS — Working Time Regulations 1998
// ════════════════════════════════════════════════════════════════════════════
// A young worker is over compulsory school age and under 18. Most childcare
// apprentices are 16 or 17 when they start, and the adult limits do not apply
// to them: the rota has to know.
//
// Working time excludes rest breaks (reg 2), so a 09:00–18:00 shift with a
// 60-minute break is 8 hours of working time and is at the limit, not over it.
const YOUNG_WORKER = {
  max_daily_hours: 8,          // reg 5A(1)(a)
  max_weekly_hours: 40,        // reg 5A(1)(b)
  break_after_hours: 4.5,      // reg 12(4) — "more than four and a half hours"
  break_minutes: 30,           // reg 12(4)
  daily_rest_hours: 12,        // reg 10(2)
  weekly_rest_hours: 48,       // reg 11(3)
  source: 'Working Time Regulations 1998 (SI 1998/1833), regs 5A, 10(2), 11(3), 12(4)',
};

/** Age in whole years on `onYmd`. Null if no date of birth. */
function ageOn(dobYmd, onYmd) {
  if (!dobYmd) return null;
  const d = String(dobYmd).slice(0, 10).split('-').map(Number);
  const o = String(onYmd).slice(0, 10).split('-').map(Number);
  if (d.length < 3 || o.length < 3) return null;
  let age = o[0] - d[0];
  if (o[1] < d[1] || (o[1] === d[1] && o[2] < d[2])) age -= 1;
  return age;
}

function isYoungWorkerOn(dobYmd, onYmd) {
  const age = ageOn(dobYmd, onYmd);
  return age != null && age < 18;
}

/** Minutes between two 'HH:MM[:SS]' times on the same day. */
function minutesBetweenTimes(startHms, endHms) {
  const t = s => {
    const p = String(s || '').split(':').map(Number);
    if (!isFinite(p[0])) return null;
    return p[0] * 60 + (p[1] || 0);
  };
  const a = t(startHms), b = t(endHms);
  if (a == null || b == null) return null;
  return b >= a ? b - a : (b + 1440) - a;   // a shift crossing midnight
}

/**
 * Every young-worker warning raised by ONE person's week of shifts.
 *
 * shifts: [{ id, shift_date, planned_start, planned_end, break_mins, is_absent }]
 *         — one member of staff, sorted or not, absences included (they are
 *         skipped here rather than by the caller, so nobody forgets).
 *
 * Returns an array of { rule, severity, shift_id?, date?, message, limit, actual }.
 * WARN ONLY. Nothing in this build refuses to save a shift: a manager may have
 * a reason, and a rota that silently deletes work is worse than one that asks.
 */
function youngWorkerWarnings(shifts, weekStart) {
  const out = [];
  const rows = (shifts || [])
    .filter(s => s && !s.is_absent && s.planned_start && s.planned_end)
    .map(s => {
      const span = minutesBetweenTimes(s.planned_start, s.planned_end);
      const brk = Math.max(0, Number(s.break_mins) || 0);
      return {
        id: s.id,
        date: String(s.shift_date).slice(0, 10),
        start: String(s.planned_start).slice(0, 5),
        end: String(s.planned_end).slice(0, 5),
        break_mins: brk,
        span_mins: span,
        work_mins: span == null ? null : Math.max(0, span - brk),
      };
    })
    .filter(r => r.work_mins != null)
    .sort((a, b) => (a.date === b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date)));

  // Per day: the 8-hour limit and the 30-minute break.
  const byDate = {};
  for (const r of rows) (byDate[r.date] = byDate[r.date] || []).push(r);

  for (const date of Object.keys(byDate).sort()) {
    const day = byDate[date];
    const workMins = day.reduce((a, r) => a + r.work_mins, 0);
    const breakMins = day.reduce((a, r) => a + r.break_mins, 0);
    const hours = Math.round((workMins / 60) * 100) / 100;

    if (hours > YOUNG_WORKER.max_daily_hours) {
      out.push({
        rule: 'daily_hours', severity: 'breach',
        shift_id: day[0].id, date,
        limit: YOUNG_WORKER.max_daily_hours, actual: hours,
        message: `${hours} hours on ${date}. A worker under 18 may not work more than ${YOUNG_WORKER.max_daily_hours} hours a day (Working Time Regulations 1998, reg 5A).`,
      });
    }
    if (workMins / 60 > YOUNG_WORKER.break_after_hours && breakMins < YOUNG_WORKER.break_minutes) {
      out.push({
        rule: 'break', severity: 'breach',
        shift_id: day[0].id, date,
        limit: YOUNG_WORKER.break_minutes, actual: breakMins,
        message: `${breakMins} minutes' break on ${date} for ${hours} hours' work. Over ${YOUNG_WORKER.break_after_hours} hours a young worker is entitled to a ${YOUNG_WORKER.break_minutes}-minute break (reg 12(4)).`,
      });
    }
  }

  // Across the week: the 40-hour limit.
  const weekMins = rows.reduce((a, r) => a + r.work_mins, 0);
  const weekHours = Math.round((weekMins / 60) * 100) / 100;
  if (weekHours > YOUNG_WORKER.max_weekly_hours) {
    out.push({
      rule: 'weekly_hours', severity: 'breach',
      limit: YOUNG_WORKER.max_weekly_hours, actual: weekHours,
      message: `${weekHours} hours across the week. A worker under 18 may not work more than ${YOUNG_WORKER.max_weekly_hours} hours a week (reg 5A).`,
    });
  }

  // Between shifts: 12 hours' rest in each 24 hours.
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    if (prev.date === cur.date) continue;
    const gapMins = gapBetween(prev.date, prev.end, cur.date, cur.start);
    if (gapMins == null) continue;
    const gapHours = Math.round((gapMins / 60) * 100) / 100;
    if (gapHours < YOUNG_WORKER.daily_rest_hours) {
      out.push({
        rule: 'daily_rest', severity: 'breach',
        shift_id: cur.id, date: cur.date,
        limit: YOUNG_WORKER.daily_rest_hours, actual: gapHours,
        message: `Only ${gapHours} hours off between ${prev.date} ${prev.end} and ${cur.date} ${cur.start}. A young worker is entitled to ${YOUNG_WORKER.daily_rest_hours} consecutive hours' rest in each 24 hours (reg 10(2)).`,
      });
    }
  }

  // Weekly rest: 48 unbroken hours somewhere in the seven-day period.
  //
  // This MUST be measured against the whole week, not merely the gaps between
  // the shifts given. A first version measured gap-to-gap and so reported
  // "the longest unbroken break is 15.5 hours" for an ordinary Monday-to-Friday
  // week — which is wrong twice over: the weekend is the rest, and a single
  // Monday shift in an otherwise empty week was flagged as no rest at all. A
  // warning that fires on a normal week is a warning nobody reads.
  if (rows.length) {
    const longest = longestRestHours(rows, weekWindow(rows, weekStart));
    if (longest != null && longest < YOUNG_WORKER.weekly_rest_hours) {
      out.push({
        rule: 'weekly_rest', severity: 'warning',
        limit: YOUNG_WORKER.weekly_rest_hours, actual: Math.round(longest * 10) / 10,
        message: `The longest unbroken break in this week is ${Math.round(longest * 10) / 10} hours. A young worker is entitled to ${YOUNG_WORKER.weekly_rest_hours} hours' rest in each seven-day period (reg 11(3)) — check the weeks either side before relying on this one.`,
      });
    }
  }

  return out;
}

function gapBetween(d1, t1, d2, t2) {
  const ms = ymdhm => {
    const [y, m, d] = String(ymdhm.d).split('-').map(Number);
    const [hh, mm] = String(ymdhm.t).split(':').map(Number);
    if (!isFinite(y) || !isFinite(hh)) return null;
    return Date.UTC(y, m - 1, d, hh, mm || 0);
  };
  const a = ms({ d: d1, t: t1 }), b = ms({ d: d2, t: t2 });
  if (a == null || b == null) return null;
  return Math.round((b - a) / 60000);
}

/**
 * The seven-day window the weekly-rest test is measured inside.
 * `weekStart` where the caller knows it (the rota always does); otherwise the
 * Monday on or before the earliest shift.
 */
function weekWindow(rows, weekStart) {
  let start = /^\d{4}-\d{2}-\d{2}$/.test(String(weekStart || '')) ? String(weekStart).slice(0, 10) : null;
  if (!start) {
    const first = rows[0].date;
    const [y, m, d] = first.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = dt.getUTCDay();                 // 0 = Sunday
    dt.setUTCDate(dt.getUTCDate() - ((dow + 6) % 7));   // back to Monday
    start = dt.toISOString().slice(0, 10);
  }
  const [y, m, d] = start.split('-').map(Number);
  const end = new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  return { start, end };
}

/**
 * The longest continuous period with no shift in it, measured across the WHOLE
 * seven-day window — so the time before the first shift and after the last one
 * counts as rest, which is what makes an ordinary Mon–Fri week pass.
 *
 * Measured only within the week the caller gave us; the warning text says so,
 * because the real 48 hours often straddles a week boundary this cannot see.
 */
function longestRestHours(rows, win) {
  if (!rows.length || !win) return null;
  let longest = 0;
  // before the first shift
  const pre = gapBetween(win.start, '00:00', rows[0].date, rows[0].start);
  if (pre != null) longest = Math.max(longest, pre / 60);
  // between shifts
  for (let i = 1; i < rows.length; i++) {
    const g = gapBetween(rows[i - 1].date, rows[i - 1].end, rows[i].date, rows[i].start);
    if (g != null) longest = Math.max(longest, g / 60);
  }
  // after the last shift, to the end of the window
  const last = rows[rows.length - 1];
  const post = gapBetween(last.date, last.end, win.end, '00:00');
  if (post != null) longest = Math.max(longest, post / 60);
  return longest;
}

module.exports = {
  OTJ_FLOOR_HOURS,
  ACTIVITY_TYPES,
  ACTIVITY_KEYS,
  EXCLUDED_TYPES,
  excludedFor,
  computeTarget,
  validateTarget,
  validateEntry,
  progress,
  YOUNG_WORKER,
  ageOn,
  isYoungWorkerOn,
  minutesBetweenTimes,
  youngWorkerWarnings,
};
