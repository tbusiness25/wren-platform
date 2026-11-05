'use strict';
/* ===========================================================================
 * leave-hours.js — b522 (2026-10-20)
 *
 * The hours-based annual-leave engine. Pure: nothing here touches the
 * database, reads an environment variable or knows what a request is. You hand
 * it plain numbers and dates and it hands back a number AND the workings that
 * produced it — the same contract as src/lib/leave-entitlement.js and
 * src/lib/fee-model.js, for the same reason: a manager arguing about a balance
 * needs to see why, not just what.
 *
 * WHY IT EXISTS, AND WHY IT IS NOT leave-entitlement.js
 * -----------------------------------------------------
 * b309 built a DAYS engine: 5 weeks x days-per-week, with bank holidays ON TOP.
 * That is a lawful policy and it is what the code assumed LADN ran.
 *
 * It is not what LADN runs. BrightHR has been running the other lawful shape,
 * and it is the one Toby is used to seeing and the one the January switch has
 * to reproduce exactly: an HOURS allowance of 5.6 weeks which *includes* bank
 * holidays. The difference is not cosmetic. Under b309 a Monday-to-Friday
 * practitioner gets 5 weeks of bookable leave and the eight bank holidays are
 * free on top. Under this engine she gets 5.6 weeks of HOURS and each bank
 * holiday that lands on one of her contracted days spends some of them. Same
 * person, same law, two different balances — so running them as two engines
 * that share nothing would be the bug. They share the work-pattern resolution
 * and the holiday-year helper; only the arithmetic differs.
 *
 * THE RULES
 * ---------
 * 1. The allowance is HOURS: `contractWeeks` x `weeklyHours`. 5.6 x 37.5 = 210
 *    hours. Nobody is asked to agree what a "day" is worth, which is the whole
 *    point of counting in hours for a nursery whose shifts run 7h, 7.5h and
 *    10h in the same week.
 *
 * 2. BANK HOLIDAYS ARE INSIDE IT. A gov.uk England-and-Wales date that falls
 *    on a contracted working day deducts THAT DAY'S contracted hours. A bank
 *    holiday on a day the person does not work deducts nothing — there is no
 *    row, not a zero row. Good Friday costs a Tuesday-to-Thursday practitioner
 *    nothing and costs a Monday-to-Friday one 7.5 hours, and neither of them
 *    has to ask why.
 *
 * 3. CLOSURE DAYS (the Christmas shutdown, an INSET day) work identically, and
 *    only when the setting says to. Default off. See the migration's comment.
 *
 * 4. Part-year — a starter or a leaver — pro-rates BY DAYS in the leave year,
 *    not by whole months, exactly as b309 does. Bank holidays are not
 *    pro-rated: either the date fell inside the employment window or it did not.
 *
 * 5. IRREGULAR HOURS / PART-YEAR workers accrue 12.07% of the hours they
 *    actually work, per pay period (Employment Rights (Amendment, Revocation
 *    and Transitional Provision) Regulations 2023, for leave years beginning on
 *    or after 1 April 2024). 12.07% is 5.6/(52-5.6). It is OPT-IN per person,
 *    because applying it to a fixed-pattern employee would under-pay them.
 *
 * 6. Rounding: hours to 2dp, and NOTHING rounds up into existence. b309 rounds
 *    the day figure up to the half day because WTR reg. 15A rounds first-year
 *    accrual up; in hours the same protection is already there — 0.25 of an
 *    hour is a real unit a manager can book — so rounding here is presentational
 *    only and never changes a balance.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * If it does not know a person's contracted weekly hours, it returns
 * `allowanceHours: null` with a `notSetReason` in plain English. It does not
 * guess, it does not interpolate from a day count, and there is no fallback
 * figure. b309's header makes this point and it is worth making twice: a wrong
 * balance that looks right is worse than a blank.
 * ===========================================================================*/

/** Statutory minimum, in weeks, INCLUDING bank holidays. WTR 1998 reg. 13 + 13A. */
const STATUTORY_WEEKS = 5.6;
/** 5.6 / (52 - 5.6). The accrual rate for irregular-hours and part-year workers. */
const ACCRUAL_RATE = 0.1207;

const DAY_MS = 86400000;
const isDateStr = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** UTC midnight for a 'YYYY-MM-DD'. Never a local Date — see reference_pg_date_ymd_trap. */
function d(s) { return new Date(s + 'T00:00:00Z'); }

/** Inclusive day count between two 'YYYY-MM-DD'. 1 Jan..31 Dec = 365. */
function daysInclusive(from, to) { return Math.round((d(to) - d(from)) / DAY_MS) + 1; }

/** 0 = Sunday .. 6 = Saturday, in UTC so a BST date never slides a day. */
function dowOf(s) { return d(s).getUTCDay(); }

/** The next day, as 'YYYY-MM-DD'. */
function addDay(s) { return new Date(d(s).getTime() + DAY_MS).toISOString().slice(0, 10); }

/** 2dp. Hours are always expressed to 2dp and compared after rounding. */
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function maxDate(a, b) { return a > b ? a : b; }
function minDate(a, b) { return a < b ? a : b; }

/**
 * A `dayHours` map is the single shape every function here takes for "what does
 * this person work in a week": { 0..6 (Sun..Sat) -> contracted hours }. A day
 * the person does not work is ABSENT from the map, not zero — so
 * `Object.keys(dayHours).length` is the days-per-week and a lookup miss is
 * unambiguously "not a working day".
 *
 * @param {object} dayHours
 * @returns {{daysPerWeek:number, weeklyHours:number}}
 */
function patternTotals(dayHours) {
  const out = { daysPerWeek: 0, weeklyHours: 0 };
  if (!dayHours || typeof dayHours !== 'object') return out;
  for (const k of Object.keys(dayHours)) {
    const h = Number(dayHours[k]);
    if (!Number.isFinite(h) || h <= 0) continue;
    out.daysPerWeek += 1;
    out.weeklyHours += h;
  }
  out.weeklyHours = round2(out.weeklyHours);
  return out;
}

/** The contracted hours on one date, or 0 if it is not a working day. */
function hoursOnDate(dayHours, dateStr) {
  if (!dayHours || !isDateStr(dateStr)) return 0;
  const h = Number(dayHours[dowOf(dateStr)]);
  return Number.isFinite(h) && h > 0 ? round2(h) : 0;
}

/**
 * The contracted hours a booking spans: every working day from `from` to `to`
 * inclusive. This is what a holiday request actually costs, and it is why
 * counting in hours is worth the trouble — a Monday-to-Friday week off costs
 * one practitioner 37.5 hours and another 22.5, and neither figure is "5 days".
 *
 * @param {object} dayHours
 * @param {string} from 'YYYY-MM-DD'
 * @param {string} to   'YYYY-MM-DD'
 * @param {number} [halfDayFactor] 0.5 for a half day; only applied when from === to
 * @returns {{hours:number, workingDays:number, dates:string[]}}
 */
function hoursForRange(dayHours, from, to, halfDayFactor) {
  const out = { hours: 0, workingDays: 0, dates: [] };
  if (!isDateStr(from) || !isDateStr(to) || from > to) return out;
  // Bounded: a typo'd year must not spin here. Two years of a single booking is
  // already absurd for leave, so 800 iterations is a generous ceiling.
  let cur = from;
  for (let i = 0; i < 800 && cur <= to; i++) {
    const h = hoursOnDate(dayHours, cur);
    if (h > 0) { out.hours += h; out.workingDays += 1; out.dates.push(cur); }
    cur = addDay(cur);
  }
  const f = Number(halfDayFactor);
  if (from === to && Number.isFinite(f) && f > 0 && f < 1) out.hours *= f;
  out.hours = round2(out.hours);
  return out;
}

/**
 * Work out one person's HOURS allowance for one holiday year.
 *
 * @param {object} o
 * @param {string}  o.yearStart         'YYYY-MM-DD'
 * @param {string}  o.yearEnd           'YYYY-MM-DD'
 * @param {object}  o.dayHours          { 0..6 -> hours }. REQUIRED for a figure.
 * @param {number} [o.contractWeeks]    weeks of leave INCLUDING bank holidays. Default 5.6.
 * @param {string} [o.employmentStart]  'YYYY-MM-DD' — pro-rate from here
 * @param {string} [o.employmentEnd]    'YYYY-MM-DD' — pro-rate to here
 * @param {string} [o.accrualMode]      'fixed' (default) | 'irregular_1207'
 * @param {number} [o.hoursWorked]      irregular_1207 only: hours actually worked so far
 * @param {number} [o.carryInHours]
 * @param {number} [o.carryCapHours]    0 = no carry-over allowed. Default 0.
 * @returns {object} the answer plus `workings`, an ordered list of readable steps.
 */
function computeAllowance(o = {}) {
  const out = {
    yearStart: o.yearStart, yearEnd: o.yearEnd,
    unit: 'hours',
    accrualMode: o.accrualMode === 'irregular_1207' ? 'irregular_1207' : 'fixed',
    contractWeeks: null,
    daysPerWeek: null, weeklyHours: null, dayHours: null,
    windowStart: null, windowEnd: null, windowDays: null, yearDays: null, fraction: null,
    allowanceFullHours: null, allowanceHours: null,
    statutoryFloorHours: null, topUpHours: null,
    hoursWorked: null, accrualRate: null,
    carryInHours: 0, carryInApplied: 0, carryCapHours: null,
    totalAvailableHours: null,
    notSetReason: null,
    workings: [],
  };
  const step = (label, detail, value) => out.workings.push({ label, detail, value });

  if (!isDateStr(o.yearStart) || !isDateStr(o.yearEnd) || o.yearStart > o.yearEnd) {
    out.notSetReason = 'The holiday year is not set.';
    step('No allowance can be calculated', 'the holiday year has no start and end date', 'not set');
    step('What would fix it', 'set the holiday-year start in Settings → Leave', '—');
    return out;
  }

  const totals = patternTotals(o.dayHours);
  if (!(totals.weeklyHours > 0)) {
    out.notSetReason = 'No working pattern on file — we do not know this person\'s contracted hours, so no allowance can be calculated.';
    step('Holiday year', `${o.yearStart} to ${o.yearEnd}`, `${daysInclusive(o.yearStart, o.yearEnd)} days`);
    step('Contracted hours a week', 'no working pattern on file for this person', 'unknown');
    step('No allowance can be calculated',
      'the allowance is a number of weeks of the person\'s own hours, so without those hours there is no figure — and we will not invent one',
      'not set');
    step('What would fix it', 'set a working pattern on this person\'s page, then recalculate', '—');
    return out;
  }
  out.daysPerWeek = totals.daysPerWeek;
  out.weeklyHours = totals.weeklyHours;
  out.dayHours = { ...o.dayHours };

  const weeks = Number.isFinite(Number(o.contractWeeks)) && Number(o.contractWeeks) > 0
    ? Number(o.contractWeeks) : STATUTORY_WEEKS;
  out.contractWeeks = weeks;

  // ── 1. The window: the part of the holiday year this person is employed for ─
  const empStart = isDateStr(o.employmentStart) ? o.employmentStart : null;
  const empEnd   = isDateStr(o.employmentEnd)   ? o.employmentEnd   : null;
  const windowStart = empStart ? maxDate(o.yearStart, empStart) : o.yearStart;
  const windowEnd   = empEnd   ? minDate(o.yearEnd,   empEnd)   : o.yearEnd;
  if (windowStart > windowEnd) {
    out.notSetReason = 'Not employed at any point in this holiday year.';
    step('Holiday year', `${o.yearStart} to ${o.yearEnd}`, `${daysInclusive(o.yearStart, o.yearEnd)} days`);
    step('Employment', `${empStart || 'unknown start'} to ${empEnd || 'no end date'}`, 'outside this year');
    step('No allowance for this year', 'this person is not employed on any day of it', 'not set');
    return out;
  }
  const yearDays   = daysInclusive(o.yearStart, o.yearEnd);
  const windowDays = daysInclusive(windowStart, windowEnd);
  const fraction   = windowDays / yearDays;
  out.windowStart = windowStart; out.windowEnd = windowEnd;
  out.yearDays = yearDays; out.windowDays = windowDays; out.fraction = fraction;

  step('Holiday year', `${o.yearStart} to ${o.yearEnd}`, `${yearDays} days`);
  step('Contracted hours', `${totals.daysPerWeek} day${totals.daysPerWeek === 1 ? '' : 's'} a week`,
    `${totals.weeklyHours} h a week`);

  if (windowDays !== yearDays) {
    const why = empStart && windowStart === empStart && empEnd && windowEnd === empEnd
      ? 'started and left inside this year'
      : (empStart && windowStart === empStart ? 'started part-way through the year' : 'leaves part-way through the year');
    step('Employed for part of the year', `${windowStart} to ${windowEnd} — ${why}`,
      `${windowDays} of ${yearDays} days (${(fraction * 100).toFixed(1)}%)`);
  } else {
    step('Employed for the whole year', 'no pro-rata applies', '100%');
  }

  // ── 2. The allowance ───────────────────────────────────────────────────────
  if (out.accrualMode === 'irregular_1207') {
    // Irregular hours: there is no yearly figure to pro-rate. The allowance IS
    // whatever has accrued, and it grows with every shift worked. The 5.6-week
    // figure is still printed, as context, so the two can be compared.
    // Number(null) is 0, not NaN — so this MUST test for null/'' before
    // coercing, or "we have no hours for this person" silently becomes "this
    // person has accrued zero hours", which reads on screen as a real balance.
    // (The same trap bit b511: see reference_building_devices_b511.)
    const worked = (o.hoursWorked == null || o.hoursWorked === '') ? NaN : Number(o.hoursWorked);
    out.accrualRate = ACCRUAL_RATE;
    out.allowanceFullHours = round2(weeks * totals.weeklyHours);
    step('Irregular hours / part-year', '12.07% of the hours actually worked (5.6 / (52 − 5.6))',
      `${(ACCRUAL_RATE * 100).toFixed(2)}%`);
    if (!Number.isFinite(worked) || worked < 0) {
      out.notSetReason = 'This person accrues leave at 12.07% of hours worked, but we have no record of hours worked in this leave year yet.';
      step('Hours worked this leave year', 'no clock-in or timesheet hours recorded yet', 'unknown');
      step('No allowance can be calculated', 'an accrual of nothing is not the same as an accrual of zero', 'not set');
      return out;
    }
    out.hoursWorked = round2(worked);
    out.allowanceHours = round2(worked * ACCRUAL_RATE);
    step('Hours worked this leave year', 'from clock-in / timesheet records', `${out.hoursWorked} h`);
    step('Accrued allowance', `${out.hoursWorked} h × ${(ACCRUAL_RATE * 100).toFixed(2)}%`,
      `${out.allowanceHours} h`);
    step('For comparison', `a fixed ${weeks}-week contract on ${totals.weeklyHours} h a week would be`,
      `${out.allowanceFullHours} h a year`);
  } else {
    const fullHours = weeks * totals.weeklyHours;
    out.allowanceFullHours = round2(fullHours);
    out.allowanceHours = round2(fullHours * fraction);
    step('Allowance', `${weeks} weeks × ${totals.weeklyHours} h a week, bank holidays included`,
      `${out.allowanceFullHours} h a year`);
    if (windowDays !== yearDays) {
      step('Pro-rata for part-year', `${out.allowanceFullHours} × ${windowDays}/${yearDays}`,
        `${out.allowanceHours} h`);
    }

    // ── 3. The statutory floor ──────────────────────────────────────────────
    // 5.6 weeks INCLUDING bank holidays is the floor, and the allowance here is
    // already expressed the same way — so unless contractWeeks is set BELOW 5.6
    // the check never bites. It is still run, and still printed, because a
    // setting that can be edited can be edited wrongly.
    const statFull = STATUTORY_WEEKS * totals.weeklyHours;
    out.statutoryFloorHours = round2(statFull * fraction);
    const topUp = Math.max(0, out.statutoryFloorHours - out.allowanceHours);
    out.topUpHours = round2(topUp);
    if (topUp > 0) {
      step('Statutory top-up',
        `${out.allowanceHours} h is below the ${STATUTORY_WEEKS}-week statutory minimum of ${out.statutoryFloorHours} h`,
        `+${out.topUpHours} h`);
      out.allowanceHours = round2(out.allowanceHours + topUp);
      step('Allowance after top-up', 'raised to the statutory minimum', `${out.allowanceHours} h`);
    } else {
      step('Statutory check', `${out.allowanceHours} h meets the ${STATUTORY_WEEKS}-week minimum of ${out.statutoryFloorHours} h`,
        'no top-up');
    }
  }

  // ── 4. Carry-over ──────────────────────────────────────────────────────────
  const carryIn = Number.isFinite(Number(o.carryInHours)) ? Math.max(0, Number(o.carryInHours)) : 0;
  const cap = Number.isFinite(Number(o.carryCapHours)) ? Math.max(0, Number(o.carryCapHours)) : 0;
  out.carryInHours = round2(carryIn);
  out.carryCapHours = round2(cap);
  out.carryInApplied = round2(Math.min(carryIn, cap));
  if (carryIn > 0) {
    step('Carried over from last year',
      carryIn > cap ? `${out.carryInHours} h carried, capped at ${out.carryCapHours} h`
                    : `${out.carryInHours} h, within the ${out.carryCapHours} h cap`,
      `+${out.carryInApplied} h`);
  }

  out.totalAvailableHours = round2(out.allowanceHours + out.carryInApplied);
  step('Total allowance', 'this year\'s allowance plus anything carried over',
    `${out.totalAvailableHours} h`);
  return out;
}

/**
 * Turn an allowance plus a ledger into the balance a card shows.
 *
 * `ledger` is the full list of movements for the year: holiday rows derived from
 * bookings, generated bank-holiday and closure rows, hand adjustments. Every
 * one carries SIGNED `hours` (see the migration), so this function SUMs and
 * never branches on kind to decide a direction — the one place a sign could be
 * got wrong is the one place it is written.
 *
 * `opening` is the January switch off BrightHR:
 *   { hours, mode: 'carry_in' | 'replaces_remaining', asAt: 'YYYY-MM-DD' }
 * In 'replaces_remaining' mode the figure IS the balance on `asAt`, so anything
 * dated BEFORE that day is excluded from the sum — BrightHR already counted it,
 * and counting it twice would halve someone's year.
 *
 * @param {object} allowance  what computeAllowance() returned
 * @param {Array}  ledger     [{kind, hours, status, entry_date, ...}]
 * @param {object} [opening]
 * @returns {object}
 */
function balanceHours(allowance, ledger = [], opening = null) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const op = opening && Number.isFinite(Number(opening.hours)) ? {
    hours: round2(Number(opening.hours)),
    mode: opening.mode === 'replaces_remaining' ? 'replaces_remaining' : 'carry_in',
    asAt: isDateStr(opening.asAt) ? opening.asAt : null,
  } : null;

  const replaces = !!(op && op.mode === 'replaces_remaining' && op.asAt);
  const counted = rows.filter(r => {
    if (r.is_void) return false;
    if (!replaces) return true;
    // A year-level adjustment (no date) is always counted: it was entered by a
    // human in Wren, so it is never part of the BrightHR figure.
    if (!r.entry_date) return true;
    return r.entry_date >= op.asAt;
  });

  const sum = kinds => round2(counted
    .filter(r => kinds.includes(r.kind) && (r.status || 'approved') === 'approved')
    .reduce((a, r) => a + (Number(r.hours) || 0), 0));

  const holidayHours      = -sum(['holiday']);         // stored negative; shown positive
  const bankHolidayHours  = -sum(['bank_holiday']);
  const closureHours      = -sum(['closure']);
  const adjustmentHours   =  sum(['adjustment', 'accrual']);  // signed, kept signed

  // Pending requests are not deducted — they are shown as "awaiting a decision"
  // so a card can say both "you have 40 h left" and "30 h of that is requested".
  const pendingHours = -round2(counted
    .filter(r => r.kind === 'holiday' && r.status === 'pending')
    .reduce((a, r) => a + (Number(r.hours) || 0), 0));

  // Booked-but-not-yet-taken is the split a manager asks for first: "how much of
  // the remaining figure is already spoken for".
  const today = new Date().toISOString().slice(0, 10);
  const splitTaken = kind => {
    const past = counted.filter(r => r.kind === kind && (r.status || 'approved') === 'approved'
      && r.entry_date && r.entry_date <= today);
    const future = counted.filter(r => r.kind === kind && (r.status || 'approved') === 'approved'
      && r.entry_date && r.entry_date > today);
    return { taken: -round2(past.reduce((a, r) => a + (Number(r.hours) || 0), 0)),
             booked: -round2(future.reduce((a, r) => a + (Number(r.hours) || 0), 0)) };
  };
  const hol = splitTaken('holiday');
  const bh  = splitTaken('bank_holiday');
  const clo = splitTaken('closure');

  const notSet = !allowance || allowance.allowanceHours == null;
  if (notSet && !replaces) {
    return {
      set: false, unit: 'hours',
      allowanceHours: null, openingBalanceHours: op ? op.hours : null,
      openingBalanceMode: op ? op.mode : null, openingBalanceAsAt: op ? op.asAt : null,
      totalAvailableHours: null,
      holidayHours, bankHolidayHours, closureHours, adjustmentHours, pendingHours,
      takenHours: round2(hol.taken + bh.taken + clo.taken),
      bookedHours: round2(hol.booked + bh.booked + clo.booked),
      usedHours: round2(holidayHours + bankHolidayHours + closureHours - adjustmentHours),
      remainingHours: null, remainingIfPendingApproved: null, percentRemaining: null,
      notSetReason: (allowance && allowance.notSetReason) || 'Allowance not set.',
    };
  }

  // In 'replaces_remaining' mode the BrightHR figure IS the starting total and
  // the calculated allowance is context only; in 'carry_in' mode it is added on
  // top of the calculated allowance, over and above any carry-over already in it.
  const total = replaces
    ? op.hours
    : round2((allowance.totalAvailableHours || 0) + (op ? op.hours : 0));

  const used = round2(holidayHours + bankHolidayHours + closureHours - adjustmentHours);
  const remaining = round2(total - used);

  return {
    set: true, unit: 'hours',
    allowanceHours: allowance ? allowance.allowanceHours : null,
    carryInApplied: allowance ? allowance.carryInApplied : 0,
    openingBalanceHours: op ? op.hours : null,
    openingBalanceMode: op ? op.mode : null,
    openingBalanceAsAt: op ? op.asAt : null,
    totalAvailableHours: total,
    holidayHours, bankHolidayHours, closureHours, adjustmentHours,
    takenHours: round2(hol.taken + bh.taken + clo.taken),
    bookedHours: round2(hol.booked + bh.booked + clo.booked),
    pendingHours,
    usedHours: used,
    remainingHours: remaining,
    remainingIfPendingApproved: round2(remaining - pendingHours),
    percentRemaining: total > 0 ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100))) : null,
    notSetReason: null,
  };
}

/**
 * Hours into days, for a card that wants to print both. The divisor is the
 * person's own average contracted day, so "28 days" means 28 of THEIR days.
 * Returns null rather than 0 when there is no pattern — "0 days" would be a lie.
 */
function hoursToDays(hours, weeklyHours, daysPerWeek) {
  const h = Number(hours), wh = Number(weeklyHours), dpw = Number(daysPerWeek);
  if (!Number.isFinite(h) || !Number.isFinite(wh) || !Number.isFinite(dpw) || wh <= 0 || dpw <= 0) return null;
  const perDay = wh / dpw;
  if (!(perDay > 0)) return null;
  return Math.round((h / perDay) * 100) / 100;
}

/** How much of a fixed yearly allowance has been EARNED by a given date. */
function accruedToDate(allowance, asOf) {
  if (!allowance || allowance.allowanceHours == null || !isDateStr(asOf)) {
    return { accruedHours: null, elapsedDays: 0, windowDays: (allowance && allowance.windowDays) || 0,
             note: 'Allowance not set.' };
  }
  if (allowance.accrualMode === 'irregular_1207') {
    return { accruedHours: allowance.allowanceHours, elapsedDays: 0, windowDays: allowance.windowDays,
             note: 'Irregular hours — the allowance IS what has accrued, so all of it is earned.' };
  }
  if (asOf < allowance.windowStart) {
    return { accruedHours: 0, elapsedDays: 0, windowDays: allowance.windowDays,
             note: 'Employment has not started yet in this holiday year.' };
  }
  const to = minDate(asOf, allowance.windowEnd);
  const elapsed = daysInclusive(allowance.windowStart, to);
  const accrued = Math.min(allowance.allowanceHours,
    round2(allowance.allowanceHours * (elapsed / allowance.windowDays)));
  return {
    accruedHours: accrued, elapsedDays: elapsed, windowDays: allowance.windowDays,
    note: `${elapsed} of ${allowance.windowDays} days into the year — ${accrued} of ${allowance.allowanceHours} h earned`,
  };
}

module.exports = {
  computeAllowance, balanceHours, accruedToDate,
  patternTotals, hoursOnDate, hoursForRange, hoursToDays,
  round2, daysInclusive, dowOf, addDay, isDateStr,
  STATUTORY_WEEKS, ACCRUAL_RATE,
};
