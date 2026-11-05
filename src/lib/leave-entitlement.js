'use strict';
/* ===========================================================================
 * leave-entitlement.js — b309 (2026-09-10)
 *
 * The annual-leave entitlement engine. Pure: nothing in here touches the
 * database, reads an environment variable or knows what a request is. You hand
 * it plain numbers and dates and it hands back a number AND the workings that
 * produced it — the same shape as src/lib/fee-model.js, and for the same reason.
 * A manager arguing about a balance needs to see why, not just what.
 *
 * WHY IT EXISTS
 * -------------
 * GET /api/absence/entitlement returned a hard-coded 28 days and
 * ladn.staff_entitlement was empty, so every leave balance on every screen was
 * fictional (wren-docs/research/reports/14-brighthr-parity.html, finding 2). For
 * a nursery of part-timers, 28 is not merely imprecise — it is roughly double
 * what a three-day-a-week practitioner is owed, and it is BELOW what a full-timer
 * here actually gets once bank holidays are counted. It was wrong in both
 * directions at once.
 *
 * THE RULES
 * ---------
 * 1. LADN's allowance is `policyLeaveWeeks` (5) x the number of days the person
 *    works in a week. Toby, 2026-08-28: "entitlement is per person from their
 *    work pattern. its 5 x weekly hours." Three days a week -> 15 days.
 *
 * 2. Bank holidays are ON TOP by default (`bhHandling: 'in_addition'`). The
 *    nursery is closed, nobody is asked to spend an allowance day on a day they
 *    could not have worked, and ladn.work_patterns.public_holiday_handling
 *    already defaults to 'not_deducted'. Only bank holidays that fall on a day
 *    the person actually works count — a Monday-to-Wednesday practitioner gains
 *    nothing from Good Friday.
 *
 * 3. The statutory floor is 5.6 weeks INCLUDING bank holidays (Working Time
 *    Regulations 1998 reg. 13 + 13A), capped at 28 days for anyone working five
 *    or more days a week. Note the word *including*: 5 weeks of allowance plus
 *    the bank holidays that land on working days is compared against it, and if
 *    the total falls short the allowance is topped up. This is what makes the
 *    5-week policy lawful, and it is exactly the check that bites for someone
 *    whose working days never coincide with a bank holiday.
 *
 * 4. Part-year (a mid-year start or a leaver) pro-rates by DAYS in the leave
 *    year, not by whole months. Both the allowance and the statutory floor are
 *    pro-rated; bank holidays are not, because either the day fell inside the
 *    employment window or it did not.
 *
 * 5. Everything rounds UP to the nearest half day. WTR reg. 15A rounds first-year
 *    accrual up, and a rounding rule that quietly favours the employer is not one
 *    you want to explain at a tribunal.
 *
 * 6. Carry-over is capped, and the cap is a cap — not an entitlement. Carried
 *    days are reported separately from the year's own allowance so the two can
 *    never be confused on screen.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * If it does not know how many days a week someone works, it returns
 * `entitlementDays: null` with a `notSetReason` in plain English. It does not
 * guess, it does not interpolate, and it never falls back to 28. A wrong balance
 * that looks right is worse than a blank.
 * ===========================================================================*/

/** Statutory minimum, in weeks, INCLUDING bank holidays. WTR 1998 reg. 13 + 13A. */
const STATUTORY_WEEKS = 5.6;
/** The statutory cap: 5.6 weeks x 5 days. Nobody accrues more than this by statute. */
const STATUTORY_MAX_DAYS = 28;
/** Everything is expressed to the half day. */
const ROUND_TO = 0.5;

const DAY_MS = 86400000;
const isDateStr = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** UTC midnight for a 'YYYY-MM-DD'. Never a local Date — see reference_pg_date_ymd_trap. */
function d(s) { return new Date(s + 'T00:00:00Z'); }

/** Inclusive day count between two 'YYYY-MM-DD' strings. 1 Jan..31 Dec = 365. */
function daysInclusive(from, to) {
  return Math.round((d(to) - d(from)) / DAY_MS) + 1;
}

/** 0 = Sunday … 6 = Saturday, in UTC so a BST date never slides a day. */
function dowOf(s) { return d(s).getUTCDay(); }

/** Round up to the nearest half day. 7.5616 -> 8.0, 15.0 -> 15.0. */
function roundUpHalf(n) {
  // The 1e-9 nudge stops 15.000000000000002 (a perfectly ordinary float) from
  // rounding up to 15.5 and handing someone a free half day every year.
  return Math.ceil((n / ROUND_TO) - 1e-9) * ROUND_TO;
}

/** 2dp, for hours. */
function round2(n) { return Math.round(n * 100) / 100; }

/** Later of two date strings. */
function maxDate(a, b) { return a > b ? a : b; }
/** Earlier of two date strings. */
function minDate(a, b) { return a < b ? a : b; }

/**
 * The holiday year containing `on`, given a start month-day like '01-01'.
 * LADN runs the calendar year; the setting exists so a setting that runs
 * April-to-March is a configuration change and not a code change.
 *
 * @param {string} on      'YYYY-MM-DD'
 * @param {string} startMd 'MM-DD'
 * @returns {{yearStart:string, yearEnd:string, label:string}}
 */
function holidayYearFor(on, startMd = '01-01') {
  const md = /^\d{2}-\d{2}$/.test(String(startMd || '')) ? startMd : '01-01';
  const y = Number(on.slice(0, 4));
  let start = `${y}-${md}`;
  if (on < start) start = `${y - 1}-${md}`;
  const sY = Number(start.slice(0, 4));
  // The day before the same month-day one year later.
  const nextStart = d(`${sY + 1}-${md}`);
  const end = new Date(nextStart.getTime() - DAY_MS).toISOString().slice(0, 10);
  const label = md === '01-01' ? String(sY) : `${sY}-${sY + 1}`;
  return { yearStart: start, yearEnd: end, label };
}

/**
 * Work out one person's leave entitlement for one holiday year.
 *
 * @param {object} o
 * @param {string}   o.yearStart          'YYYY-MM-DD' — first day of the holiday year
 * @param {string}   o.yearEnd            'YYYY-MM-DD' — last day of the holiday year
 * @param {number}   o.daysPerWeek        days worked per week (from the work pattern). REQUIRED.
 * @param {number}  [o.weeklyHours]       contracted hours per week — only used to express the answer in hours
 * @param {number}  [o.policyLeaveWeeks]  weeks of allowance the setting gives. Default 5.
 * @param {string}  [o.employmentStart]   'YYYY-MM-DD' — pro-rate from here if inside the year
 * @param {string}  [o.employmentEnd]     'YYYY-MM-DD' — pro-rate to here if inside the year
 * @param {number[]}[o.workingDows]       0..6 (Sun..Sat) the person works. Needed to count bank holidays.
 * @param {string[]}[o.bankHolidays]      'YYYY-MM-DD' list for the year (england-and-wales)
 * @param {string}  [o.bhHandling]        'in_addition' (default) | 'deducted'
 * @param {number}  [o.carriedInDays]     days brought forward from last year
 * @param {number}  [o.carryCapDays]      the cap on that. Default 5.
 * @returns {object} the answer plus `workings`, an ordered list of readable steps.
 */
function computeEntitlement(o = {}) {
  const out = {
    yearStart: o.yearStart, yearEnd: o.yearEnd,
    daysPerWeek: null, weeklyHours: null, hoursPerDay: null,
    policyLeaveWeeks: null,
    windowStart: null, windowEnd: null, windowDays: null, yearDays: null, fraction: null,
    fullYearPolicyDays: null, proRataPolicyDays: null,
    bankHolidayDays: null, bankHolidayDates: [],
    statutoryFloorDays: null, topUpDays: null,
    entitlementDays: null, entitlementHours: null,
    carriedInDays: 0, carriedInApplied: 0, carryCapDays: null,
    totalAvailableDays: null,
    bhHandling: o.bhHandling === 'deducted' ? 'deducted' : 'in_addition',
    notSetReason: null,
    workings: [],
  };
  const step = (label, detail, value) => out.workings.push({ label, detail, value });

  // ── Guards. Each one produces a blank with a reason, never a number. ───────
  // A blank still gets workings: "no figure" with an empty drawer looks like a
  // bug, and the one thing worth showing is exactly what was missing and what
  // would fix it.
  if (!isDateStr(o.yearStart) || !isDateStr(o.yearEnd) || o.yearStart > o.yearEnd) {
    out.notSetReason = 'The holiday year is not set.';
    step('No entitlement can be calculated', 'the holiday year has no start and end date', 'not set');
    step('What would fix it', 'set leave_year_start_md in Settings', '—');
    return out;
  }
  const dpw = Number(o.daysPerWeek);
  if (!Number.isFinite(dpw) || dpw <= 0 || dpw > 7) {
    out.notSetReason = 'No work pattern on file — we do not know how many days a week this person works, so no entitlement can be calculated.';
    step('Holiday year', `${o.yearStart} to ${o.yearEnd}`, `${daysInclusive(o.yearStart, o.yearEnd)} days`);
    step('Days worked per week', 'no work pattern on file for this person', 'unknown');
    step('No entitlement can be calculated',
      'the allowance is a multiple of the days worked in a week, so without that there is no figure — and we will not invent one',
      'not set');
    step('What would fix it', 'give this person a work pattern on Staff → Rota, then recalculate', '—');
    return out;
  }
  const weeks = Number.isFinite(Number(o.policyLeaveWeeks)) && Number(o.policyLeaveWeeks) > 0
    ? Number(o.policyLeaveWeeks) : 5;

  out.daysPerWeek = dpw;
  out.policyLeaveWeeks = weeks;
  const wh = Number(o.weeklyHours);
  if (Number.isFinite(wh) && wh > 0) {
    out.weeklyHours = wh;
    out.hoursPerDay = round2(wh / dpw);
  }

  // ── 1. The window: the part of the holiday year this person is employed for ─
  const empStart = isDateStr(o.employmentStart) ? o.employmentStart : null;
  const empEnd   = isDateStr(o.employmentEnd)   ? o.employmentEnd   : null;
  const windowStart = empStart ? maxDate(o.yearStart, empStart) : o.yearStart;
  const windowEnd   = empEnd   ? minDate(o.yearEnd,   empEnd)   : o.yearEnd;
  if (windowStart > windowEnd) {
    out.notSetReason = 'Not employed at any point in this holiday year.';
    step('Holiday year', `${o.yearStart} to ${o.yearEnd}`, `${daysInclusive(o.yearStart, o.yearEnd)} days`);
    step('Employment', `${empStart || 'unknown start'} to ${empEnd || 'no end date'}`, 'outside this year');
    step('No entitlement for this year', 'this person is not employed on any day of it', 'not set');
    return out;
  }
  const yearDays   = daysInclusive(o.yearStart, o.yearEnd);
  const windowDays = daysInclusive(windowStart, windowEnd);
  const fraction   = windowDays / yearDays;

  out.windowStart = windowStart; out.windowEnd = windowEnd;
  out.yearDays = yearDays; out.windowDays = windowDays; out.fraction = fraction;

  step('Holiday year', `${o.yearStart} to ${o.yearEnd}`, `${yearDays} days`);
  if (windowDays !== yearDays) {
    const why = empStart && windowStart === empStart && empEnd && windowEnd === empEnd
      ? 'started and left inside this year'
      : (empStart && windowStart === empStart ? 'started part-way through the year' : 'leaves part-way through the year');
    step('Employed for part of the year', `${windowStart} to ${windowEnd} — ${why}`,
      `${windowDays} of ${yearDays} days (${(fraction * 100).toFixed(1)}%)`);
  } else {
    step('Employed for the whole year', 'no pro-rata applies', '100%');
  }

  // ── 2. The setting's own allowance ────────────────────────────────────────
  const fullYearPolicyDays = weeks * dpw;
  const proRataPolicyDays  = fullYearPolicyDays * fraction;
  out.fullYearPolicyDays = round2(fullYearPolicyDays);
  out.proRataPolicyDays  = round2(proRataPolicyDays);
  const dayWord = n => `${n} day${Number(n) === 1 ? '' : 's'} a week`;
  step('Setting allowance', `${weeks} weeks x ${dayWord(dpw)}`, `${round2(fullYearPolicyDays)} days a year`);
  if (windowDays !== yearDays) {
    step('Pro-rata for part-year', `${round2(fullYearPolicyDays)} x ${windowDays}/${yearDays}`,
      `${round2(proRataPolicyDays)} days`);
  }

  // ── 3. Bank holidays falling on days this person actually works ───────────
  const dows = Array.isArray(o.workingDows) && o.workingDows.length
    ? o.workingDows.map(Number).filter(n => n >= 0 && n <= 6)
    : null;
  const bhList = Array.isArray(o.bankHolidays) ? o.bankHolidays.filter(isDateStr) : [];
  const inWindow = bhList.filter(x => x >= windowStart && x <= windowEnd);
  let bhOnWorkingDays;
  if (dows) {
    const hits = inWindow.filter(x => dows.includes(dowOf(x)));
    bhOnWorkingDays = hits.length;
    out.bankHolidayDates = hits;
    step('Bank holidays on working days',
      hits.length ? hits.join(', ') : 'none fall on a day this person works',
      `${hits.length} days`);
  } else {
    // No day-of-week detail on the pattern. Estimate proportionally rather than
    // pretend to zero — and SAY that it is an estimate, on screen, in the workings.
    bhOnWorkingDays = inWindow.length * Math.min(dpw, 5) / 5;
    out.bankHolidayDates = [];
    step('Bank holidays on working days',
      `estimated — the work pattern does not say which weekdays are worked. ${inWindow.length} bank holidays x ${Math.min(dpw, 5)}/5`,
      `${round2(bhOnWorkingDays)} days (estimate)`);
  }
  out.bankHolidayDays = round2(bhOnWorkingDays);

  // ── 4. The statutory floor — 5.6 weeks INCLUDING bank holidays ────────────
  const statFullYear = Math.min(STATUTORY_WEEKS * Math.min(dpw, 5), STATUTORY_MAX_DAYS);
  const statutoryFloorDays = statFullYear * fraction;
  out.statutoryFloorDays = round2(statutoryFloorDays);
  step('Statutory minimum', `${STATUTORY_WEEKS} weeks x ${dayWord(Math.min(dpw, 5))}, including bank holidays`
    + (windowDays !== yearDays ? `, pro-rated x ${windowDays}/${yearDays}` : ''),
    `${round2(statutoryFloorDays)} days`);

  const countsTowardFloor = out.bhHandling === 'in_addition'
    ? proRataPolicyDays + bhOnWorkingDays
    : proRataPolicyDays;
  const topUp = Math.max(0, statutoryFloorDays - countsTowardFloor);
  out.topUpDays = round2(topUp);
  if (topUp > 0) {
    step('Statutory top-up', `${round2(countsTowardFloor)} days (allowance`
      + (out.bhHandling === 'in_addition' ? ' + bank holidays' : '')
      + `) is below the ${round2(statutoryFloorDays)}-day minimum`,
      `+${round2(topUp)} days`);
  } else {
    step('Statutory check', `${round2(countsTowardFloor)} days (allowance`
      + (out.bhHandling === 'in_addition' ? ' + bank holidays' : '')
      + `) meets the ${round2(statutoryFloorDays)}-day minimum`, 'no top-up');
  }

  // ── 5. The bookable allowance ─────────────────────────────────────────────
  const bookableRaw = proRataPolicyDays + topUp;
  const entitlementDays = roundUpHalf(bookableRaw);
  out.entitlementDays = entitlementDays;
  step('Bookable leave this year', `${round2(bookableRaw)} days, rounded up to the nearest half day`,
    `${entitlementDays} days`);
  if (out.hoursPerDay) {
    out.entitlementHours = round2(entitlementDays * out.hoursPerDay);
    step('In hours', `${entitlementDays} days x ${out.hoursPerDay} h a day (${out.weeklyHours} h / ${dpw} days)`,
      `${out.entitlementHours} hours`);
  }

  // ── 6. Carry-over ─────────────────────────────────────────────────────────
  const carriedIn = Number.isFinite(Number(o.carriedInDays)) ? Math.max(0, Number(o.carriedInDays)) : 0;
  const cap = Number.isFinite(Number(o.carryCapDays)) ? Math.max(0, Number(o.carryCapDays)) : 5;
  const applied = Math.min(carriedIn, cap);
  out.carriedInDays = round2(carriedIn);
  out.carryCapDays  = round2(cap);
  out.carriedInApplied = round2(applied);
  if (carriedIn > 0) {
    step('Carried over from last year',
      carriedIn > cap ? `${round2(carriedIn)} days carried, capped at ${round2(cap)}` : `${round2(carriedIn)} days, within the ${round2(cap)}-day cap`,
      `+${round2(applied)} days`);
  }
  out.totalAvailableDays = round2(entitlementDays + applied);
  step('Total available', 'this year\'s allowance plus anything carried over',
    `${out.totalAvailableDays} days`);

  return out;
}

/**
 * How much of the year's entitlement has been EARNED by a given date.
 * Leave accrues across the employment window, not in one lump on 1 January —
 * which is the number that matters when someone leaves owing or owed days.
 *
 * @param {object} ent  the object computeEntitlement() returned
 * @param {string} asOf 'YYYY-MM-DD'
 * @returns {{accruedDays:number|null, elapsedDays:number, windowDays:number, note:string}}
 */
function accruedToDate(ent, asOf) {
  if (!ent || ent.entitlementDays == null || !isDateStr(asOf)) {
    return { accruedDays: null, elapsedDays: 0, windowDays: ent && ent.windowDays || 0, note: 'Entitlement not set.' };
  }
  if (asOf < ent.windowStart) {
    return { accruedDays: 0, elapsedDays: 0, windowDays: ent.windowDays, note: 'Employment has not started yet in this holiday year.' };
  }
  const to = minDate(asOf, ent.windowEnd);
  const elapsed = daysInclusive(ent.windowStart, to);
  const raw = ent.entitlementDays * (elapsed / ent.windowDays);
  const accrued = Math.min(ent.entitlementDays, roundUpHalf(raw));
  return {
    accruedDays: accrued,
    elapsedDays: elapsed,
    windowDays: ent.windowDays,
    note: `${elapsed} of ${ent.windowDays} days worked — ${accrued} of ${ent.entitlementDays} days accrued`,
  };
}

/**
 * Turn an entitlement plus what has been booked into the balance a screen shows.
 * Kept here so every surface subtracts the same things in the same order.
 *
 * @param {object} ent    the object computeEntitlement() returned
 * @param {object} usage  {takenDays, pendingDays, upcomingDays}
 * @returns {object} balance, with every component named
 */
function balanceFor(ent, usage = {}) {
  const taken    = Math.max(0, Number(usage.takenDays)    || 0);
  const pending  = Math.max(0, Number(usage.pendingDays)  || 0);
  const upcoming = Math.max(0, Number(usage.upcomingDays) || 0);
  if (!ent || ent.entitlementDays == null) {
    return {
      set: false, entitlementDays: null, carriedInApplied: 0, totalAvailableDays: null,
      takenDays: round2(taken), upcomingDays: round2(upcoming), pendingDays: round2(pending),
      remainingDays: null, remainingIfPendingApproved: null,
      notSetReason: (ent && ent.notSetReason) || 'Entitlement not set.',
    };
  }
  const total = ent.totalAvailableDays;
  const remaining = round2(total - taken - upcoming);
  return {
    set: true,
    entitlementDays: ent.entitlementDays,
    carriedInApplied: ent.carriedInApplied,
    totalAvailableDays: total,
    takenDays: round2(taken),
    upcomingDays: round2(upcoming),
    pendingDays: round2(pending),
    remainingDays: remaining,
    remainingIfPendingApproved: round2(remaining - pending),
    notSetReason: null,
  };
}

module.exports = {
  computeEntitlement,
  accruedToDate,
  balanceFor,
  holidayYearFor,
  // exported for the unit test and for anything that needs the same rounding
  roundUpHalf, daysInclusive, dowOf,
  STATUTORY_WEEKS, STATUTORY_MAX_DAYS, ROUND_TO,
};
