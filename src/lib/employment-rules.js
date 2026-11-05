'use strict';
/* ===========================================================================
 * employment-rules.js — b318 (2026-09-11)
 *
 * The rules, in words, plus the arithmetic behind them. No database, no
 * express, no I/O: everything here takes facts and returns findings, so it can
 * be exercised from a script without a server (scripts/b318-verify.js does
 * exactly that).
 *
 * WHY THE SENTENCES LIVE HERE AND THE KNOBS LIVE IN THE DATABASE.
 * ladn.employment_rules holds enforcement ('warn' | 'block' | 'off') and the
 * numbers, because those are Toby's to change without a deploy. The WORDING
 * lives in this file, because the same sentence has to appear on the HR screen,
 * in the manager's queue and in a Telegram line, and three copies of a sentence
 * drift. A finding is therefore assembled from both: the row supplies the
 * provenance and the threshold, this file supplies the English.
 *
 * THE SHAPE OF A FINDING, and it is the point of the build:
 *
 *   {
 *     rule_key, title,
 *     rule:   'Only one person can be on annual leave at a time.',   ← the rule
 *     source: 'Employee Handbook — Holiday Entitlement…, A) 8',      ← whose rule
 *     detail: 'a room leader is already off 7–11 Sept.',            ← why it fired
 *     status: 'pass' | 'note' | 'warn' | 'block' | 'unknown',
 *     enforcement, source_url, anchor
 *   }
 *
 * Never a bare "not permitted". A person who is told a rule and its source can
 * argue with it, ask for an exception, or plan around it. A person who is told
 * "computer says no" learns nothing and resents it.
 *
 * WARN BY DEFAULT. Every rule ships at enforcement 'warn' except the ACAS step
 * order, which blocks — an outcome recorded before an invitation and a meeting
 * is not a record of a fair process, it is a record of an unfair one. Anything
 * a manager overrides is recorded in ladn.employment_rule_overrides with a
 * reason, which is NOT NULL on purpose.
 *
 * TIME. The container runs with TZ unset, so `new Date().getHours()` is UTC and
 * a 06:30 sickness deadline compared that way is an hour wrong for seven months
 * of the year. Every wall-clock comparison below goes through londonParts().
 * =========================================================================== */

const otj = require('./otj-rules');

const LONDON = 'Europe/London';

// ── Time, in London, always ─────────────────────────────────────────────────

/** { y, m, d, hh, mm, dow } for an instant, as read off a clock in London. */
function londonParts(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const p = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    hh: Number(p.hour === '24' ? '00' : p.hour), mm: Number(p.minute),
    dow: DOW[p.weekday] || null,
    ymd: `${p.year}-${p.month}-${p.day}`,
    hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`,
  };
}

/**
 * The instant at which a given wall-clock time occurs in London on a given day.
 * Found by probing rather than by assuming an offset, so it is right on both
 * sides of a clock change and needs no table of DST dates.
 */
function londonInstant(ymd, hm) {
  const [Y, M, D] = String(ymd).slice(0, 10).split('-').map(Number);
  const [h, mi] = String(hm || '00:00').split(':').map(Number);
  if (!Y || !M || !D || !Number.isFinite(h)) return null;
  // Start from the UTC reading of that wall clock, then correct by the offset
  // London actually had at that moment. One correction is enough everywhere
  // except inside the one missing hour in spring, where the result lands on the
  // start of BST — which is the right answer for a deadline.
  let guess = Date.UTC(Y, M - 1, D, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = londonParts(new Date(guess));
    if (!p) return null;
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    const want = Date.UTC(Y, M - 1, D, h, mi);
    if (seen === want) break;
    guess += want - seen;
  }
  return new Date(guess);
}

/** 'YYYY-MM-DD' from a Date or a string. Never toISOString() — see memory. */
function ymd(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

const addDays = (s, n) => {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};

/** ISO weekday, 1 = Monday … 7 = Sunday, for a 'YYYY-MM-DD'. */
function isoDow(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

const mondayOf = s => addDays(s, -(isoDow(s) - 1));

const daysBetweenYmd = (a, b) => {
  const p = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86400000);
};

/** Every date from a to b inclusive. */
function eachDate(a, b) {
  const out = [];
  for (let d = ymd(a); daysBetweenYmd(d, ymd(b)) >= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Mon–Fri days in a range. Bank holidays are handled by the b309 engine. */
const workingDaysIn = (a, b) => eachDate(a, b).filter(d => isoDow(d) <= 5).length;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * '7–11 September' / '3 March' / '28 February – 4 March' — the way a person says
 * it, with the YEAR added whenever the date is not in the year we are in now.
 *
 * The year matters more than it looks: "protection starts 21 March" is a
 * different sentence from "protection starts 21 March 2027", and this build
 * spends most of its time talking about dates on the far side of a commencement
 * date. The reference year is read off the London clock, so a container running
 * in UTC does not shift it on New Year's Eve.
 */
function prettyRange(a, b, refYear) {
  const A = ymd(a), B = ymd(b);
  if (!A) return '';
  const thisYear = Number.isFinite(refYear) ? refYear : londonParts(new Date()).y;
  const [ay, am, ad] = A.split('-').map(Number);
  const yA = ay === thisYear ? '' : ` ${ay}`;
  if (!B || A === B) return `${ad} ${MONTHS[am - 1]}${yA}`;
  const [by, bm, bd] = B.split('-').map(Number);
  const yB = by === thisYear ? '' : ` ${by}`;
  if (ay === by && am === bm) return `${ad}–${bd} ${MONTHS[am - 1]}${yB}`;
  if (ay === by) return `${ad} ${MONTHS[am - 1]} – ${bd} ${MONTHS[bm - 1]}${yB}`;
  return `${ad} ${MONTHS[am - 1]}${yA || ' ' + ay} – ${bd} ${MONTHS[bm - 1]}${yB || ' ' + by}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

// ── The catalogue, as this file understands it ──────────────────────────────
//
// One entry per rule_key in ladn.employment_rules. `rule` is the sentence the
// screens print. `fallback` is the config used when the database row is absent
// (an older schema, or a tenant that has not run the migration) — the check
// still runs and still cites its source rather than silently disappearing.

const RULE_TEXT = {
  'leave.one_at_a_time': {
    rule: 'Only one member of staff can be on annual leave at any one time.',
    fallback: { applies_to: ['holiday'] },
  },
  'leave.before_rota': {
    rule: 'Leave has to be asked for before that week’s rota is written, which happens Friday morning.',
    fallback: { applies_to: ['holiday'], rota_weekday: 5, rota_time: '09:00' },
  },
  'leave.summer_cap': {
    rule: 'No more than two working weeks of annual leave across July and August.',
    fallback: { applies_to: ['holiday'], months: [7, 8], max_days: 10 },
  },
  'leave.consecutive_cap': {
    rule: 'No more than two working weeks off in a row, unless a manager agrees otherwise.',
    fallback: { applies_to: ['holiday'], max_days: 10 },
  },
  'leave.christmas_reserve': {
    rule: 'Enough days have to be kept back to cover the Christmas and New Year shutdown.',
    fallback: { applies_to: ['holiday'], reserve_days: 5 },
  },
  'leave.no_carry_forward': {
    rule: 'Holiday cannot be carried into next year and is not paid in lieu.',
    fallback: { applies_to: ['holiday'] },
  },
  'leave.statutory_notice': {
    rule: 'Notice of at least twice the length of the leave being taken.',
    fallback: { applies_to: ['holiday'], multiplier: 2 },
  },
  'sickness.report_deadline': {
    rule: 'Sickness has to be reported by 10pm the night before, or 6:30am on the day.',
    fallback: { applies_to: ['sick'], prev_evening: '22:00', same_day: '06:30', to: 'deputy manager' },
  },
  'sickness.daily_contact': {
    rule: 'Ring by 4pm each day to say whether you are back the next day.',
    fallback: { applies_to: ['sick'], by: '16:00' },
    // PUBLISHED BUT NOT CHECKED. There is no per-day contact log in the schema —
    // an absence is one row with a start and an end, not a row per day — so
    // there is nothing to test "did they ring by 4pm on the Wednesday" against.
    // The rule is still catalogued, because a rule people can read is worth
    // having even before it can be enforced; what would NOT be acceptable is a
    // screen implying Wren is watching this when it is not. Every surface reads
    // `evaluated` and says so.
    evaluated: false,
  },
  'sickness.self_cert_limit': {
    rule: 'Up to seven calendar days can be self-certified; after that a fit note is needed.',
    fallback: { applies_to: ['sick'], self_cert_days: 7 },
  },
  'sickness.return_to_work': {
    rule: 'A return-to-work form is filled in before coming back.',
    fallback: { applies_to: ['sick'] },
  },
  'sickness.ssp_day_one': {
    rule: 'Statutory Sick Pay is paid from the first day, at the lower of the flat rate and 80% of normal weekly earnings.',
    fallback: { applies_to: ['sick'], weekly_rate: 123.25, percent_of_earnings: 80, waiting_days: 0, in_force: '2026-04-06' },
  },
  'working_time.weekly_48': {
    rule: 'An average working week of no more than 48 hours, unless you have opted out in writing.',
    fallback: { limit_hours: 48, reference_weeks: 17 },
  },
  'working_time.break_20': {
    rule: 'A 20-minute uninterrupted break on any shift longer than six hours.',
    fallback: { after_hours: 6, break_minutes: 20 },
  },
  'working_time.daily_rest_11': {
    rule: 'Eleven consecutive hours off between one shift and the next.',
    fallback: { rest_hours: 11 },
  },
  'working_time.weekly_rest_24': {
    rule: 'Twenty-four hours off in a row in every seven-day period.',
    fallback: { rest_hours: 24, fortnight_hours: 48 },
  },
  'discipline.acas_order': {
    rule: 'Investigate, invite in writing, hold the meeting, then decide — and offer an appeal.',
    fallback: {},
  },
  'discipline.right_to_be_accompanied': {
    rule: 'Anyone at a formal disciplinary meeting may bring a colleague or a union representative.',
    fallback: {},
  },
  'discipline.warning_expiry': {
    rule: 'Warnings are disregarded after their period: verbal 3 months, written 6, final written 12.',
    fallback: { verbal_warning: 3, written_warning: 6, final_written_warning: 12 },
  },
  'discipline.qualifying_period': {
    rule: 'From 1 January 2027, unfair-dismissal rights start after six months, not two years, and the compensation cap is gone.',
    fallback: { in_force: '2027-01-01', months_before: 24, months_after: 6, cap_removed: true },
  },
};

/** 'Employee Handbook — Holiday…, A) 8' / 'Working Time Regulations 1998, reg 15'. */
function sourceLabel(row) {
  if (!row) return null;
  if (row.source_kind === 'handbook') return `Employee Handbook — ${row.source_ref}`;
  return row.source_ref;
}

/**
 * A rule as the checks want it: the database row where there is one, the
 * fallback where there is not, and the sentence either way.
 *
 * `rows` is a Map keyed by rule_key (what the service hands us).
 */
function ruleFor(rows, key) {
  const row = (rows && (rows.get ? rows.get(key) : rows[key])) || null;
  const text = RULE_TEXT[key] || { rule: key, fallback: {} };
  const cfg = Object.assign({}, text.fallback, (row && row.config) || {});
  return {
    rule_key: key,
    title: (row && row.title) || key,
    rule: text.rule,
    source: sourceLabel(row) || 'Employee Handbook',
    source_kind: (row && row.source_kind) || 'handbook',
    source_url: (row && row.source_url) || null,
    anchor: (row && row.handbook_anchor) || null,
    enforcement: (row && row.enforcement) || 'warn',
    // Is there actually a check behind this rule today? Defaults to true; a
    // rule declares itself unenforceable by setting evaluated:false above.
    evaluated: text.evaluated !== false,
    // 'off' is how a rule is switched out without deleting its provenance —
    // treated exactly like is_active=false by every check below.
    active: row ? (row.is_active !== false && row.enforcement !== 'off') : true,
    supersedes_handbook: !!(row && row.supersedes_handbook),
    config: cfg,
  };
}

/** A finding, with the rule and its source attached. */
function finding(r, status, detail, extra) {
  // A rule set to 'block' downgrades a warn to a block; a rule set to 'warn'
  // never upgrades. Nothing here can make a rule stricter than the catalogue
  // says it is — that is the point of the enforcement column.
  const effective = status === 'warn' && r.enforcement === 'block' ? 'block' : status;
  return Object.assign({
    rule_key: r.rule_key,
    title: r.title,
    rule: r.rule,
    source: r.source,
    source_kind: r.source_kind,
    source_url: r.source_url,
    anchor: r.anchor,
    enforcement: r.enforcement,
    supersedes_handbook: r.supersedes_handbook,
    status: effective,
    detail: detail || '',
  }, extra || {});
}

const applies = (r, type) => {
  const a = r.config.applies_to;
  return !Array.isArray(a) || a.indexOf(type) !== -1;
};

// ════════════════════════════════════════════════════════════════════════════
// ANNUAL LEAVE
// ════════════════════════════════════════════════════════════════════════════
/**
 * Every leave rule, checked against one request.
 *
 * facts — gathered by the service, never looked up here:
 *   request       { staff_id, start_date, end_date, request_type }
 *   now           Date (defaults to real now; injectable so a test is a test)
 *   overlaps      [{ staff_id, name, start_date, end_date, request_type }]
 *                 APPROVED annual leave by OTHER people over these dates
 *   summer_days_booked  working days of holiday already booked in Jul+Aug of
 *                       the request's year, this request excluded
 *   entitlement   { set, remainingDays, yearEnd } | null
 *   spans_weeks   number of ISO weeks the request touches
 */
function leaveChecks(rules, facts) {
  const out = [];
  const req = facts.request || {};
  const type = req.request_type || 'holiday';
  const start = ymd(req.start_date), end = ymd(req.end_date) || ymd(req.start_date);
  if (!start) return out;
  const now = facts.now instanceof Date ? facts.now : new Date();
  const reqDays = workingDaysIn(start, end);

  // ── Only one person off at a time ───────────────────────────────────────
  {
    const r = ruleFor(rules, 'leave.one_at_a_time');
    if (r.active && applies(r, type)) {
      const clashes = (facts.overlaps || []).filter(o => (o.request_type || 'holiday') === 'holiday');
      if (!clashes.length) {
        out.push(finding(r, 'pass', 'Nobody else has annual leave approved over these dates.'));
      } else {
        const who = clashes.slice(0, 3)
          .map(o => `${o.name} is already off ${prettyRange(o.start_date, o.end_date)}`)
          .join('; ');
        const more = clashes.length > 3 ? `, and ${clashes.length - 3} more` : '';
        out.push(finding(r, 'warn', `${who}${more}.`, { clashes: clashes.length }));
      }
    }
  }

  // ── Before the rota is written ──────────────────────────────────────────
  {
    const r = ruleFor(rules, 'leave.before_rota');
    if (r.active && applies(r, type)) {
      // The rota for the week containing the first day of leave is written on
      // the rota_weekday BEFORE that week starts. For a Friday rota and a week
      // beginning Monday, that is the Friday three days earlier.
      // Leave week = the Monday..Sunday containing the first day off. The rota
      // for that week is written on rota_weekday of the week BEFORE it, so for
      // a Friday rota and a Monday-start week the cutoff is three days earlier.
      // Getting this arithmetic wrong is the difference between a warning that
      // fires on every request and one that never fires at all.
      const weekStart = mondayOf(start);
      const cutoffDay = addDays(weekStart, (Number(r.config.rota_weekday) || 5) - 8);
      const cutoff = londonInstant(cutoffDay, r.config.rota_time || '09:00');
      const late = cutoff && now.getTime() > cutoff.getTime();
      const when = `${prettyRange(cutoffDay, cutoffDay)} at ${r.config.rota_time || '09:00'}`;
      if (!cutoff) {
        out.push(finding(r, 'unknown', 'Could not work out when that week’s rota was written.'));
      } else if (late) {
        const daysAgo = Math.max(0, Math.round((now.getTime() - cutoff.getTime()) / 86400000));
        out.push(finding(r, 'warn',
          `The rota for the week of ${prettyRange(weekStart, addDays(weekStart, 6))} was written on ${when}` +
          `${daysAgo >= 1 ? `, ${plural(daysAgo, 'day')} ago` : ''}. This request comes after it, so cover has already been planned around you being in.`,
          { rota_cutoff: cutoffDay }));
      } else {
        out.push(finding(r, 'pass', `In before the rota for that week, which is written on ${when}.`,
          { rota_cutoff: cutoffDay }));
      }
    }
  }

  // ── Two working weeks in July and August ────────────────────────────────
  {
    const r = ruleFor(rules, 'leave.summer_cap');
    if (r.active && applies(r, type)) {
      const months = Array.isArray(r.config.months) ? r.config.months.map(Number) : [7, 8];
      const cap = Number(r.config.max_days) || 10;
      const thisReq = eachDate(start, end)
        .filter(d => isoDow(d) <= 5 && months.indexOf(Number(d.slice(5, 7))) !== -1).length;
      if (!thisReq) {
        out.push(finding(r, 'pass', 'None of these dates fall in July or August.'));
      } else {
        const already = Number(facts.summer_days_booked) || 0;
        const total = already + thisReq;
        const label = months.map(m => MONTHS[m - 1]).join(' and ');
        if (total > cap) {
          out.push(finding(r, 'warn',
            `This would make ${plural(total, 'working day')} of leave in ${label} — ${plural(already, 'day')} already booked plus ${plural(thisReq, 'day')} here. The limit is ${plural(cap, 'working day')}, which is two weeks.`,
            { summer_days: total, cap }));
        } else {
          out.push(finding(r, 'pass',
            `${plural(total, 'working day')} in ${label} including this request, against a limit of ${cap}.`,
            { summer_days: total, cap }));
        }
      }
    }
  }

  // ── Two working weeks in a row ──────────────────────────────────────────
  {
    const r = ruleFor(rules, 'leave.consecutive_cap');
    if (r.active && applies(r, type)) {
      const cap = Number(r.config.max_days) || 10;
      if (reqDays > cap) {
        out.push(finding(r, 'warn',
          `This is ${plural(reqDays, 'working day')} in one block. Anything over ${plural(cap, 'working day')} needs a manager to agree it specifically.`,
          { request_days: reqDays, cap }));
      } else {
        out.push(finding(r, 'pass', `${plural(reqDays, 'working day')} in one block, against a limit of ${cap}.`,
          { request_days: reqDays, cap }));
      }
    }
  }

  // ── Christmas / New Year reserve ────────────────────────────────────────
  {
    const r = ruleFor(rules, 'leave.christmas_reserve');
    if (r.active && applies(r, type)) {
      const reserve = Number(r.config.reserve_days) || 5;
      const ent = facts.entitlement;
      if (!ent || !ent.set) {
        out.push(finding(r, 'unknown',
          `Your holiday entitlement is not set, so we cannot tell whether ${plural(reserve, 'day')} would still be left for the shutdown. A manager decides this one.`));
      } else {
        const after = Number(ent.remainingDays) - reqDays;
        if (after < reserve) {
          out.push(finding(r, 'warn',
            `This would leave ${after.toFixed(1)} days for the rest of the year, and the Christmas/New Year shutdown needs about ${plural(reserve, 'day')} of your own entitlement. Days you do not have are taken unpaid.`,
            { remaining_after: Math.round(after * 10) / 10, reserve }));
        } else {
          out.push(finding(r, 'pass',
            `${after.toFixed(1)} days would be left afterwards, enough for the ${plural(reserve, 'day')} Christmas shutdown.`,
            { remaining_after: Math.round(after * 10) / 10, reserve }));
        }
      }
    }
  }

  // ── Statutory notice ────────────────────────────────────────────────────
  //
  // WARN ONLY, deliberately, and the detail says so. The handbook varies this
  // (reg 15(5) allows it) to "as much notice as possible" and "before the rota",
  // so which rule bites is Toby's decision and not this build's.
  {
    const r = ruleFor(rules, 'leave.statutory_notice');
    if (r.active && applies(r, type)) {
      const mult = Number(r.config.multiplier) || 2;
      const nowYmd = londonParts(now).ymd;
      const noticeDays = daysBetweenYmd(nowYmd, start);
      const needed = Math.ceil(reqDays * mult);
      if (noticeDays < needed) {
        // A negative figure means the leave has already started — which happens
        // when a saved request is re-checked months later, not when somebody is
        // filling the form in. "−3 days notice" is nonsense on a screen; say
        // what actually happened instead.
        const given = noticeDays < 0
          ? `These dates have already started`
          : `${plural(noticeDays, 'day')} notice for ${plural(reqDays, 'day')} off`;
        out.push(finding(r, 'warn',
          `${given}. The Working Time Regulations ask for ${plural(needed, 'day')} — ${mult}× the leave — unless we have agreed otherwise, and our handbook says only “as much notice as possible”, before the rota. This is a flag for your manager, not a refusal.`,
          { notice_days: noticeDays, notice_needed: needed, multiplier: mult }));
      } else {
        out.push(finding(r, 'pass',
          `${plural(noticeDays, 'day')} notice, against the ${plural(needed, 'day')} the regulations ask for.`,
          { notice_days: noticeDays, notice_needed: needed, multiplier: mult }));
      }
    }
  }

  // ── No carry-forward (informational) ────────────────────────────────────
  {
    const r = ruleFor(rules, 'leave.no_carry_forward');
    const ent = facts.entitlement;
    if (r.active && applies(r, type) && ent && ent.set && ent.yearEnd) {
      const left = Number(ent.remainingDays) - reqDays;
      const daysToYearEnd = daysBetweenYmd(londonParts(now).ymd, ymd(ent.yearEnd));
      if (left > 0.5 && daysToYearEnd >= 0 && daysToYearEnd <= 120) {
        out.push(finding(r, 'note',
          `${left.toFixed(1)} days would still be unbooked, and the holiday year ends on ${prettyRange(ent.yearEnd, ent.yearEnd)}. Anything left then is lost.`,
          { remaining_after: Math.round(left * 10) / 10 }));
      }
    }
  }

  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// SICKNESS REPORTING
// ════════════════════════════════════════════════════════════════════════════
/**
 * Was the absence reported in time?
 *
 * The handbook gives two deadlines and they are an OR, not an AND: "by 10pm the
 * day before or at 6:30am the day of". Reporting at 11pm the night before misses
 * the first and meets the second, and is on time — so the test is against the
 * later of the two, with the earlier one reported as a courtesy.
 *
 * @param reportedAt  Date | ISO string | null
 * @param firstDay    'YYYY-MM-DD' — the first day of the absence
 */
function sickReportCheck(rules, reportedAt, firstDay, opts) {
  const r = ruleFor(rules, 'sickness.report_deadline');
  const day = ymd(firstDay);
  if (!day) return finding(r, 'unknown', 'No absence date to check against.');
  const prevEvening = londonInstant(addDays(day, -1), r.config.prev_evening || '22:00');
  const sameDay = londonInstant(day, r.config.same_day || '06:30');
  if (!reportedAt) {
    return finding(r, 'unknown',
      `Nobody recorded when this was reported, so it cannot be checked. The deadline was ${r.config.prev_evening || '22:00'} on ${prettyRange(addDays(day, -1), addDays(day, -1))} or ${r.config.same_day || '06:30'} on ${prettyRange(day, day)}.`,
      { timeliness: 'unknown' });
  }
  const at = reportedAt instanceof Date ? reportedAt : new Date(reportedAt);
  if (Number.isNaN(at.getTime())) return finding(r, 'unknown', 'The reported time could not be read.', { timeliness: 'unknown' });
  const p = londonParts(at);
  const to = r.config.to || 'the deputy manager';

  if (at.getTime() <= sameDay.getTime()) {
    const alsoEarly = at.getTime() <= prevEvening.getTime();
    return finding(r, 'pass',
      `Reported at ${p.hm} on ${prettyRange(p.ymd, p.ymd)}` +
      (alsoEarly ? `, before the ${r.config.prev_evening || '22:00'} deadline the night before.`
                 : `, inside the ${r.config.same_day || '06:30'} deadline on the day.`),
      { timeliness: 'on_time', reported_at: at.toISOString() });
  }
  const lateMins = Math.round((at.getTime() - sameDay.getTime()) / 60000);
  const lateText = lateMins < 60
    ? `${plural(lateMins, 'minute')} late`
    : `${plural(Math.round(lateMins / 60), 'hour')} late`;
  return finding(r, 'warn',
    `Reported at ${p.hm} on ${prettyRange(p.ymd, p.ymd)} — ${lateText}. The deadline is ${r.config.same_day || '06:30'} on the day (or ${r.config.prev_evening || '22:00'} the night before) to ${to}, so cover can be arranged before the doors open.`,
    { timeliness: 'late', minutes_late: lateMins, reported_at: at.toISOString() });
}

/** Self-certify to 7 days, fit note beyond — and whether one is attached. */
function sickEvidenceCheck(rules, absence) {
  const r = ruleFor(rules, 'sickness.self_cert_limit');
  const start = ymd(absence && absence.start_date), end = ymd(absence && absence.end_date);
  if (!start) return finding(r, 'unknown', 'No dates to check.');
  const limit = Number(r.config.self_cert_days) || 7;
  const calDays = daysBetweenYmd(start, end || start) + 1;
  const hasProof = !!(absence && absence.proof_uploaded_at);
  if (calDays <= limit) {
    return finding(r, 'pass',
      `${plural(calDays, 'calendar day')} — inside the ${limit} days that can be self-certified. A fit note is not needed.`,
      { calendar_days: calDays });
  }
  if (hasProof) {
    return finding(r, 'pass',
      `${plural(calDays, 'calendar day')}, and a fit note is on file.`, { calendar_days: calDays });
  }
  return finding(r, 'warn',
    `${plural(calDays, 'calendar day')} — over the ${limit} days that can be self-certified, and no fit note has been attached yet.`,
    { calendar_days: calDays, needs_fit_note: true });
}

/** Return-to-work form before coming back. */
function returnToWorkCheck(rules, absence, now) {
  const r = ruleFor(rules, 'sickness.return_to_work');
  const end = ymd(absence && absence.end_date);
  if (!end) return finding(r, 'unknown', 'No end date to check.');
  if (absence.rtw_form_at) {
    const p = londonParts(absence.rtw_form_at);
    return finding(r, 'pass', `Return-to-work form completed on ${prettyRange(p.ymd, p.ymd)}.`);
  }
  const today = londonParts(now instanceof Date ? now : new Date()).ymd;
  if (daysBetweenYmd(end, today) < 0) {
    return finding(r, 'note', `Still off. The return-to-work form is filled in before coming back, so it is due by ${prettyRange(addDays(end, 1), addDays(end, 1))}.`);
  }
  return finding(r, 'warn',
    `No return-to-work form has been recorded, and the absence ended on ${prettyRange(end, end)}. The handbook asks for it before returning.`,
    { overdue_days: daysBetweenYmd(end, today) });
}

// ════════════════════════════════════════════════════════════════════════════
// STATUTORY SICK PAY
// ════════════════════════════════════════════════════════════════════════════
//
// The rules CHANGED on 6 April 2026, so which set applies depends on when the
// absence started, not on when the calculation is run. Both are implemented
// because the nursery's own absence table holds 2,944 imported rows going back
// years and quietly applying today's rules to 2024 would produce figures that
// do not match what was actually paid.
//
// From 6 April 2026 (Employment Rights Act 2025 ss.10–11):
//   * payable from the FIRST qualifying day — no waiting days
//   * no lower earnings limit — the earnings test is gone
//   * the weekly amount is the LOWER of the flat rate and 80% of normal weekly
//     earnings
// Before that: a period of incapacity for work needed four consecutive days,
// the first three qualifying days were unpaid waiting days, and earnings below
// the lower earnings limit disqualified the person entirely.

const SSP_REFORM_DATE = '2026-04-06';

/**
 * @param opts.start_date, opts.end_date       the absence
 * @param opts.qualifying_dows  ISO weekdays [1..7] the person normally works.
 *                              Defaults to Mon–Fri; NOT guessed from thin air —
 *                              the caller passes the b309 work pattern.
 * @param opts.weekly_earnings  normal weekly earnings, or null
 * @param opts.weekly_rate      the flat rate (settings)
 * @param opts.percent          the earnings percentage (settings)
 * @returns { set, regime, ... , workings: [...] }
 */
function sspCalculate(opts) {
  const start = ymd(opts.start_date), end = ymd(opts.end_date) || ymd(opts.start_date);
  const rate = Number(opts.weekly_rate);
  const pct = Number(opts.percent) || 80;
  const dows = Array.isArray(opts.qualifying_dows) && opts.qualifying_dows.length
    ? opts.qualifying_dows.map(Number) : [1, 2, 3, 4, 5];
  const workings = [];

  if (!start) return { set: false, reason: 'No absence dates.' };
  if (!Number.isFinite(rate) || rate <= 0) {
    return { set: false, reason: 'The SSP weekly rate is not set (settings key ssp_weekly_rate).' };
  }

  const reformed = start >= SSP_REFORM_DATE;
  const regime = reformed ? 'from_2026_04_06' : 'pre_2026_04_06';
  const all = eachDate(start, end);
  const qualifying = all.filter(d => dows.indexOf(isoDow(d)) !== -1);
  workings.push({
    step: 'Days of absence',
    value: `${all.length} calendar days, ${qualifying.length} of them working days`,
    note: `Qualifying days are the days this person normally works: ${dows.map(n => ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][n - 1]).join(', ')}.`,
  });

  const weekly = Number(opts.weekly_earnings);
  let weeklyAmount = rate, basis = `the flat rate of £${rate.toFixed(2)}`;
  if (reformed) {
    if (!Number.isFinite(weekly) || weekly <= 0) {
      return {
        set: false, regime,
        reason: 'Normal weekly earnings are not on file for this person, and since 6 April 2026 SSP is the LOWER of the flat rate and 80% of earnings — so without the earnings figure there is no answer, only a guess.',
        workings,
        source: 'Employment Rights Act 2025, ss.10–11, in force 6 April 2026',
      };
    }
    const eightyPct = Math.round(weekly * (pct / 100) * 100) / 100;
    weeklyAmount = Math.min(rate, eightyPct);
    basis = weeklyAmount === eightyPct
      ? `${pct}% of £${weekly.toFixed(2)} normal weekly earnings = £${eightyPct.toFixed(2)}, which is lower than the £${rate.toFixed(2)} flat rate`
      : `the flat rate of £${rate.toFixed(2)}, which is lower than ${pct}% of earnings (£${eightyPct.toFixed(2)})`;
    workings.push({ step: 'Weekly amount', value: `£${weeklyAmount.toFixed(2)}`, note: basis });
  } else {
    workings.push({ step: 'Weekly amount', value: `£${rate.toFixed(2)}`, note: 'The flat rate. Before 6 April 2026 there was no 80%-of-earnings comparison.' });
  }

  let waiting = 0, payableDays = qualifying.length, piwMet = true;
  if (!reformed) {
    piwMet = all.length >= 4;
    waiting = Math.min(3, qualifying.length);
    payableDays = piwMet ? Math.max(0, qualifying.length - waiting) : 0;
    workings.push({
      step: 'Waiting days',
      value: piwMet ? `${waiting} unpaid` : 'not payable',
      note: piwMet
        ? 'Under the pre-April-2026 rules the first three qualifying days were unpaid waiting days.'
        : 'Under the pre-April-2026 rules an absence had to run to four consecutive days before any SSP was due.',
    });
  } else {
    workings.push({
      step: 'Waiting days',
      value: 'none',
      note: 'Since 6 April 2026 SSP is payable from the first qualifying day. The three waiting days and the four-day minimum were both removed, as was the lower earnings limit.',
    });
  }

  const daily = Math.round((weeklyAmount / Math.max(1, dows.length)) * 100) / 100;
  const total = Math.round(daily * payableDays * 100) / 100;
  workings.push({
    step: 'Daily rate',
    value: `£${daily.toFixed(2)}`,
    note: `£${weeklyAmount.toFixed(2)} ÷ ${dows.length} qualifying days in the week.`,
  });
  workings.push({ step: 'Total', value: `£${total.toFixed(2)}`, note: `${payableDays} payable day(s) × £${daily.toFixed(2)}.` });

  return {
    set: true, regime,
    reformed,
    calendar_days: all.length,
    qualifying_days: qualifying.length,
    waiting_days: waiting,
    payable_days: payableDays,
    weekly_amount: weeklyAmount,
    daily_rate: daily,
    total,
    workings,
    source: reformed
      ? 'Employment Rights Act 2025, ss.10–11, in force 6 April 2026'
      : 'Social Security Contributions and Benefits Act 1992, as it stood before 6 April 2026',
    handbook_note: reformed
      ? 'Our handbook still describes four qualifying days and three waiting days. Those rules ended on 6 April 2026 — the figure above follows the current law.'
      : null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// WORKING TIME — ADULTS
// ════════════════════════════════════════════════════════════════════════════
//
// The under-18 limits are TIGHTER and already live in otj-rules.js
// (youngWorkerWarnings, b317). This function is for everybody else and shares
// that file's helpers rather than re-deriving them — the brief says "shared
// with b317; do not implement twice".
//
// WARN ONLY. A rota that silently refuses to save a week is worse than one that
// asks, and reg 4's 48 hours is an AVERAGE over 17 weeks that a single planned
// week cannot prove either way. The finding says so on its face.

/**
 * @param shifts  [{ id, shift_date, planned_start, planned_end, break_mins, is_absent }]
 *                for ONE person, one rota week
 * @param weekStart 'YYYY-MM-DD' Monday
 * @param opts.opted_out  true where a reg 5 opt-out agreement is on file
 */
function adultWorkingTimeWarnings(rules, shifts, weekStart, opts) {
  const out = [];
  const o = opts || {};
  const rows = (shifts || [])
    .filter(s => s && !s.is_absent && s.planned_start && s.planned_end)
    .map(s => {
      const span = otj.minutesBetweenTimes(s.planned_start, s.planned_end);
      const brk = Math.max(0, Number(s.break_mins) || 0);
      return {
        id: s.id,
        date: ymd(s.shift_date),
        start: String(s.planned_start).slice(0, 5),
        end: String(s.planned_end).slice(0, 5),
        break_mins: brk,
        span_mins: span,
        work_mins: span == null ? null : Math.max(0, span - brk),
      };
    })
    .filter(r => r.work_mins != null && r.date)
    .sort((a, b) => (a.date === b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date)));

  if (!rows.length) return out;

  // ── 20-minute break over six hours ──────────────────────────────────────
  {
    const r = ruleFor(rules, 'working_time.break_20');
    if (r.active) {
      const afterH = Number(r.config.after_hours) || 6;
      const minB = Number(r.config.break_minutes) || 20;
      const byDate = {};
      for (const row of rows) (byDate[row.date] = byDate[row.date] || []).push(row);
      for (const date of Object.keys(byDate).sort()) {
        const day = byDate[date];
        const workMins = day.reduce((a, x) => a + x.work_mins, 0);
        const breakMins = day.reduce((a, x) => a + x.break_mins, 0);
        const hours = Math.round((workMins / 60) * 100) / 100;
        if (workMins / 60 > afterH && breakMins < minB) {
          out.push(finding(r, 'warn',
            `${hours} hours on ${prettyRange(date, date)} with ${plural(breakMins, 'minute')} of break. Over ${afterH} hours the break must be at least ${minB} minutes, uninterrupted and away from the workstation.`,
            { date, shift_id: day[0].id, limit: minB, actual: breakMins }));
        }
      }
    }
  }

  // ── 48-hour week ────────────────────────────────────────────────────────
  {
    const r = ruleFor(rules, 'working_time.weekly_48');
    if (r.active) {
      const limit = Number(r.config.limit_hours) || 48;
      const refWeeks = Number(r.config.reference_weeks) || 17;
      const weekHours = Math.round((rows.reduce((a, x) => a + x.work_mins, 0) / 60) * 100) / 100;
      if (weekHours > limit) {
        out.push(finding(r, o.opted_out ? 'note' : 'warn',
          o.opted_out
            ? `${weekHours} hours planned this week, over the ${limit}-hour limit — but an opt-out agreement is on file, so the limit does not apply. The daily and weekly rest rules still do.`
            : `${weekHours} hours planned this week, against a ${limit}-hour limit. The limit is an average over ${refWeeks} weeks, so one week over it is not automatically a breach — but no opt-out agreement is recorded for this person, so the average has to come back under.`,
          { actual: weekHours, limit, opted_out: !!o.opted_out }));
      }
    }
  }

  // ── 11 hours between shifts ─────────────────────────────────────────────
  {
    const r = ruleFor(rules, 'working_time.daily_rest_11');
    if (r.active) {
      const need = Number(r.config.rest_hours) || 11;
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1], cur = rows[i];
        if (prev.date === cur.date) continue;
        const gapH = hoursBetween(prev.date, prev.end, cur.date, cur.start);
        if (gapH == null || gapH >= need) continue;
        out.push(finding(r, 'warn',
          `Only ${Math.round(gapH * 10) / 10} hours off between ${prettyRange(prev.date, prev.date)} finishing at ${prev.end} and ${prettyRange(cur.date, cur.date)} starting at ${cur.start}. The entitlement is ${need} consecutive hours in every 24.`,
          { date: cur.date, shift_id: cur.id, limit: need, actual: Math.round(gapH * 10) / 10 }));
      }
    }
  }

  // ── 24 hours off in the week ────────────────────────────────────────────
  //
  // Measured across the WHOLE seven-day window, for the same reason b317's
  // young-worker version does: gap-to-gap measurement flags an ordinary
  // Monday-to-Friday week, and a warning that fires on a normal week is a
  // warning nobody reads.
  {
    const r = ruleFor(rules, 'working_time.weekly_rest_24');
    if (r.active) {
      const need = Number(r.config.rest_hours) || 24;
      const win = { start: mondayOf(weekStart || rows[0].date), end: null };
      win.end = addDays(win.start, 7);
      let longest = 0;
      const pre = hoursBetween(win.start, '00:00', rows[0].date, rows[0].start);
      if (pre != null) longest = Math.max(longest, pre);
      for (let i = 1; i < rows.length; i++) {
        const g = hoursBetween(rows[i - 1].date, rows[i - 1].end, rows[i].date, rows[i].start);
        if (g != null) longest = Math.max(longest, g);
      }
      const last = rows[rows.length - 1];
      const post = hoursBetween(last.date, last.end, win.end, '00:00');
      if (post != null) longest = Math.max(longest, post);
      if (longest < need) {
        out.push(finding(r, 'warn',
          `The longest unbroken break in this week is ${Math.round(longest * 10) / 10} hours, against an entitlement of ${need}. The regulations also allow two such breaks, or one of ${Number(r.config.fortnight_hours) || 48} hours, across a fortnight — so check the weeks either side before treating this as a breach.`,
          { limit: need, actual: Math.round(longest * 10) / 10 }));
      }
    }
  }

  return out;
}

function hoursBetween(d1, t1, d2, t2) {
  const ms = (d, t) => {
    const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number);
    const [hh, mi] = String(t).split(':').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(hh)) return null;
    return Date.UTC(y, m - 1, dd, hh, mi || 0);
  };
  const a = ms(d1, t1), b = ms(d2, t2);
  if (a == null || b == null) return null;
  return (b - a) / 3600000;
}

// ════════════════════════════════════════════════════════════════════════════
// DISCIPLINARY — the ACAS Code, as an order you cannot skip
// ════════════════════════════════════════════════════════════════════════════

const ACAS_STEPS = [
  { key: 'concern',           label: 'Concern recorded',    required: true,
    help: 'What the concern is, when it arose, and who raised it.' },
  { key: 'investigation',     label: 'Investigation',       required: true,
    help: 'Establish the facts before deciding anything. Where the same person cannot both investigate and decide, say who did which.' },
  { key: 'invitation',        label: 'Invitation to meeting', required: true,
    help: 'In writing, with enough detail for them to prepare, and telling them they may bring a colleague or union representative.' },
  { key: 'meeting',           label: 'Disciplinary meeting', required: true,
    help: 'They put their case, and it is heard before any decision is made.' },
  { key: 'outcome',           label: 'Outcome in writing',   required: true,
    help: 'The decision, the reason, and the right of appeal — in writing.' },
  { key: 'appeal_invitation', label: 'Appeal invitation',    required: false,
    help: 'Only where an appeal has been lodged.' },
  { key: 'appeal_meeting',    label: 'Appeal meeting',       required: false,
    help: 'Heard by someone not involved in the original decision where that is possible.' },
  { key: 'appeal_outcome',    label: 'Appeal outcome',       required: false,
    help: 'The appeal decision, in writing. This is the end of the process.' },
];

const ACAS_ORDER = ACAS_STEPS.reduce((m, s, i) => (m[s.key] = i, m), {});

/**
 * Can an outcome be recorded on this case yet?
 *
 * This is the ONE rule in the catalogue that blocks. A tribunal reduces or
 * increases an award by up to 25% for an unreasonable failure to follow the
 * Code (TULR(C)A 1992, s.207A), and from 1 January 2027 the award it is applied
 * to is uncapped. A record that lets an outcome be written before an invitation
 * and a meeting is not a record of a fair process.
 *
 * @param steps  [{ step_key, occurred_on }]
 */
function canRecordOutcome(steps) {
  const have = {};
  for (const s of steps || []) {
    const k = s.step_key;
    const d = ymd(s.occurred_on);
    if (!have[k] || (d && d < have[k])) have[k] = d || have[k] || '';
  }
  const missing = [];
  if (!have.invitation) missing.push('an invitation to a disciplinary meeting');
  if (!have.meeting) missing.push('the meeting itself');
  if (missing.length) {
    return {
      ok: false,
      missing,
      message: `An outcome cannot be recorded yet — this case has no record of ${missing.join(' and ')}. `
             + 'Invite them in writing (telling them they may be accompanied), hold the meeting, and then decide. '
             + 'ACAS Code of Practice 1, paras 9–21.',
    };
  }
  if (have.meeting && have.invitation && have.meeting < have.invitation) {
    return {
      ok: false,
      missing: ['a meeting held on or after the invitation'],
      message: `The meeting is recorded on ${prettyRange(have.meeting, have.meeting)} but the invitation on ${prettyRange(have.invitation, have.invitation)} — the meeting cannot come first. Check the dates. ACAS Code of Practice 1, para 11.`,
    };
  }
  return { ok: true, missing: [], message: null };
}

/** The next step this case is waiting on, in plain words. */
function nextStep(caseRow, steps) {
  const have = new Set((steps || []).map(s => s.step_key));
  for (const s of ACAS_STEPS) {
    if (!s.required) break;
    if (!have.has(s.key)) return s;
  }
  if (caseRow && caseRow.appeal_lodged_on && !have.has('appeal_outcome')) {
    if (!have.has('appeal_invitation')) return ACAS_STEPS.find(s => s.key === 'appeal_invitation');
    if (!have.has('appeal_meeting')) return ACAS_STEPS.find(s => s.key === 'appeal_meeting');
    return ACAS_STEPS.find(s => s.key === 'appeal_outcome');
  }
  return null;
}

/** Outcomes that carry a warning, and how long the handbook says it lives. */
const WARNING_MONTHS = {
  verbal_warning: 'verbal_warning',
  written_warning: 'written_warning',
  final_written_warning: 'final_written_warning',
};

function warningExpiry(rules, outcome, outcomeOn) {
  const r = ruleFor(rules, 'discipline.warning_expiry');
  const cfgKey = WARNING_MONTHS[outcome];
  if (!cfgKey) return null;
  const months = Number(r.config[cfgKey]);
  const on = ymd(outcomeOn);
  if (!Number.isFinite(months) || !on) return null;
  const [y, m, d] = on.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return { expires_on: dt.toISOString().slice(0, 10), months, rule: r.rule, source: r.source };
}

/**
 * Where this person stands on unfair-dismissal rights, and when that changes.
 *
 * Both changes land on 1 January 2027: two years becomes six months, and the
 * compensatory award becomes uncapped. The note is deliberately about the DATE
 * rather than about how to dismiss anybody — the point is that a decision that
 * was low-risk in December is not in January.
 */
function unfairDismissalPosition(rules, contractStart, now) {
  const r = ruleFor(rules, 'discipline.qualifying_period');
  const start = ymd(contractStart);
  const today = londonParts(now instanceof Date ? now : new Date()).ymd;
  const inForce = r.config.in_force || '2027-01-01';
  if (!start) {
    return { set: false, rule: r.rule, source: r.source, source_url: r.source_url,
             note: 'No employment start date on file, so the qualifying date cannot be worked out.' };
  }
  const addMonths = (s, n) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10);
  };
  const monthsBefore = Number(r.config.months_before) || 24;
  const monthsAfter = Number(r.config.months_after) || 6;
  const twoYearPoint = addMonths(start, monthsBefore);
  const sixMonthPoint = addMonths(start, monthsAfter);
  // On and after the commencement date the six-month point governs. Before it,
  // the old two-year point still does — but the six-month date is shown anyway,
  // because that is the date a manager needs to have in mind now.
  const qualifiesToday = today >= inForce ? today >= sixMonthPoint : today >= twoYearPoint;
  // The date protection ACTUALLY starts for this person.
  //   * Somebody already protected under the old two-year rule was protected
  //     from their two-year point — printing 1 January 2027 for a six-year
  //     veteran would read as though they gain rights they have had since 2022.
  //   * Everybody else is protected from the LATER of their six-month point and
  //     the commencement date.
  const effectiveFrom = qualifiesToday && today < inForce
    ? twoYearPoint
    : (sixMonthPoint > inForce ? sixMonthPoint : inForce);
  return {
    set: true,
    rule: r.rule,
    source: r.source,
    source_url: r.source_url,
    employment_start: start,
    six_month_point: sixMonthPoint,
    two_year_point: twoYearPoint,
    in_force: inForce,
    qualifies_today: qualifiesToday,
    protected_from: effectiveFrom,
    service_months: Math.round((daysBetweenYmd(start, today) / 30.4375) * 10) / 10,
    note: qualifiesToday
      ? `Has unfair-dismissal protection today (started ${prettyRange(start, start)}).`
      : `Unfair-dismissal protection starts ${prettyRange(effectiveFrom, effectiveFrom)}` +
        (effectiveFrom === inForce
          ? ' — the day the six-month qualifying period comes in, by which time they will already have six months\' service.'
          : ', six months after they started.') +
        ' From that date the compensatory award is also uncapped.',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// THE HANDBOOK — contents, sections, search
// ════════════════════════════════════════════════════════════════════════════
//
// The live copy lives in ladn.starter_pack_documents.body_html and stays there.
// This splits it into addressable sections so a rule can link to its paragraph
// and a reader can search it. Pure: the same html always yields the same slugs,
// which is what lets ladn.employment_rules.handbook_anchor be seeded by hand.

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x2019;|&rsquo;/g, '’').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}

function slugify(s) {
  return decodeEntities(s).toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * @returns [{ level, title, slug, anchor_of_parent, html, text, index }]
 *          — one entry per <h2>/<h3>, in document order, each holding the html
 *          that follows it up to the next heading.
 */
function handbookSections(html) {
  const src = String(html || '');
  const re = /<h([23])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const heads = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    heads.push({ level: Number(m[1]), raw: m[2], start: m.index, bodyStart: m.index + m[0].length });
  }
  const used = {};
  const out = [];
  let parent = null;
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const title = decodeEntities(h.raw.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    let slug = slugify(title) || `section-${i + 1}`;
    if (h.level === 3 && parent) slug = `${parent.slug}--${slug}`;
    if (used[slug]) slug = `${slug}-${(used[slug] += 1)}`;
    else used[slug] = 1;
    const end = i + 1 < heads.length ? heads[i + 1].start : src.length;
    const body = src.slice(h.bodyStart, end);
    const entry = {
      index: i,
      level: h.level,
      title,
      slug,
      parent_slug: h.level === 3 && parent ? parent.slug : null,
      parent_title: h.level === 3 && parent ? parent.title : null,
      html: body,
      text: decodeEntities(body.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
    };
    if (h.level === 2) parent = entry;
    out.push(entry);
  }
  return out;
}

/** A contents tree: top-level sections, each with its sub-headings. */
function handbookContents(sections) {
  const top = [];
  for (const s of sections) {
    if (s.level === 2) top.push({ title: s.title, slug: s.slug, children: [] });
    else if (top.length) top[top.length - 1].children.push({ title: s.title, slug: s.slug });
  }
  return top;
}

module.exports = {
  // time
  londonParts, londonInstant, ymd, addDays, isoDow, mondayOf, daysBetweenYmd,
  eachDate, workingDaysIn, prettyRange,
  // catalogue
  RULE_TEXT, ruleFor, sourceLabel, finding,
  // leave
  leaveChecks,
  // sickness
  sickReportCheck, sickEvidenceCheck, returnToWorkCheck, sspCalculate, SSP_REFORM_DATE,
  // working time
  adultWorkingTimeWarnings,
  // discipline
  ACAS_STEPS, ACAS_ORDER, canRecordOutcome, nextStep, warningExpiry, unfairDismissalPosition,
  // handbook
  handbookSections, handbookContents, slugify, decodeEntities,
};
