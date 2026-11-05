'use strict';
// b270 (2026-09-02) — the fee-modeller maths, kept in one place so it can be
// unit-tested against a hand-worked example (scripts/b270-verify.js) instead of
// only ever being exercised through an HTTP endpoint.
//
// Nothing in here touches the database. Callers pass plain numbers in and get
// the full workings back, because a manager setting fees has to be able to see
// WHY a total moved, not just that it did.
//
// ── The rules (from Toby's April-2027 fee brief) ─────────────────────────────
//   * 52 weeks a year. Corrected 2026-09-10.
//     This said 51, on the basis that the fee documents reconciled on 51 and a
//     competitor's monthly figures reproduced exactly on 51. Toby's own EyLog
//     invoices settle it the other way and are the authority: they print
//     "Invoice Calculation Factor: 52.00 weeks/12.00 months" and the same for
//     funding. The note directly below has always agreed — EyLog's stretched
//     rows spread over 52 (21.92 = 30 x 38 / 52), so computing on 51 while
//     reading hours derived on 52 was inconsistent with itself.
//     Toby, 2026-09-10: "We do everything for 52 weeks."
//     Fees are payable for all 52 — bank holidays, the three inset days and the
//     three days the nursery closes at Christmas included.
//   * A day is 10 hours (8am–6pm) unless ladn.settings says otherwise
//     (invoice_session_hours).
//   * Stretched funding: entitlement × 38 term weeks ÷ 52 = weekly funded hours.
//     A 30-hour child draws 21.92 h/week, not 30.
//   * Funded hours bill at £0. Private hours bill at day_rate ÷ 10 per hour.
//   * A meal / consumables charge is a FLAT weekly amount. It must never be
//     derived from funded hours — see the note on billChildYear below.

const WEEKS_PER_YEAR = 52;   // see above — corrected from 51 on 2026-09-10.
const TERM_WEEKS     = 38;
const DAY_HOURS      = 10;

// The basis EyLog used when it wrote ladn.child_funding. Its stretched rows hold
// hours ALREADY spread over 52 weeks — 21.92 = 30 × 38 ÷ 52, 10.96 = 15 × 38 ÷ 52,
// 14.61 = 20 × 38 ÷ 52. Verified on wren_dev 2026-09-02: every 'stretched' row
// recovers a statutory entitlement to within 0.01h on this basis and none does on 51.
// Applying × 38 ÷ 51 to those numbers directly would stretch them a SECOND time
// (21.92 → 16.33) and understate funded hours by roughly a quarter.
const EYLOG_STRETCH_BASIS_WEEKS = 52;

// The statutory entitlement ladder. Recovered entitlements land a hair off these
// (29.996 rather than 30) because the stored figure is rounded to 2dp, so snap
// when we are clearly looking at one of them.
const STATUTORY_ENTITLEMENTS = [15, 20, 30];
const SNAP_TOLERANCE_HOURS = 0.1;

/**
 * Recover a child's TERM-TIME statutory entitlement from what child_funding stores.
 *
 * @param {object} f
 * @param {number} f.totalHoursWeek     child_funding.total_hours_week
 * @param {string|null} f.eylogHoursBasis child_funding.eylog_hours_basis
 * @param {boolean} f.stretchedFunding  child_funding.stretched_funding
 * @returns {{entitlementHours:number, rawEntitlementHours:number, snapped:boolean, basis:string}}
 */
function termTimeEntitlement(f) {
  const stored = Number(f.totalHoursWeek || 0);
  if (stored <= 0) {
    return { entitlementHours: 0, rawEntitlementHours: 0, snapped: false, basis: 'none' };
  }
  // 'stretched' is the only value that means "already spread"; term_time and NULL
  // both mean the stored number IS the term-time entitlement.
  const isStretchedStore = (f.eylogHoursBasis || '').toLowerCase() === 'stretched';
  const raw = isStretchedStore
    ? (stored * EYLOG_STRETCH_BASIS_WEEKS) / TERM_WEEKS
    : stored;

  let snapped = false;
  let ent = raw;
  for (const s of STATUTORY_ENTITLEMENTS) {
    if (Math.abs(raw - s) <= SNAP_TOLERANCE_HOURS) { ent = s; snapped = true; break; }
  }
  return {
    entitlementHours: ent,
    rawEntitlementHours: raw,
    snapped,
    basis: isStretchedStore ? `stored stretched on ${EYLOG_STRETCH_BASIS_WEEKS} weeks` : 'stored term-time',
  };
}

/**
 * Weekly funded hours once an entitlement is stretched across the fee year.
 * entitlement × 38 ÷ 52.
 */
function stretchedWeeklyHours(entitlementHours, opts = {}) {
  const termWeeks = opts.termWeeks || TERM_WEEKS;
  const weeks = opts.weeksPerYear || WEEKS_PER_YEAR;
  return (Number(entitlementHours || 0) * termWeeks) / weeks;
}

/**
 * Bill ONE child (one billing unit) for a whole fee year under a given day rate.
 *
 * Returns the complete workings — every intermediate a manager might want to
 * expand — plus the annual totals in pence.
 *
 * @param {object} a
 * @param {number} a.daysPerWeek          1..5 booked days
 * @param {number} a.dayRatePence         the scenario's rate for this cell
 * @param {number} a.entitlementHours     TERM-TIME entitlement (from termTimeEntitlement)
 * @param {boolean} a.stretched           is the child's funding stretched across the year?
 * @param {number} [a.mealChargeWeeklyPence] flat weekly meal/consumables charge
 * @param {number} [a.dayHours]           hours in a chargeable day
 * @param {number} [a.weeksPerYear]
 * @param {number} [a.termWeeks]
 */
function billChildYear(a) {
  const dayHours  = a.dayHours  || DAY_HOURS;
  const weeks     = a.weeksPerYear || WEEKS_PER_YEAR;
  const termWeeks = a.termWeeks || TERM_WEEKS;
  const days      = Number(a.daysPerWeek || 0);
  const dayRate   = Number(a.dayRatePence || 0);
  const ent       = Number(a.entitlementHours || 0);

  const attendedHoursWeek = days * dayHours;
  const hourlyRatePence   = dayRate / dayHours;
  const annualAttendedHours = attendedHoursWeek * weeks;

  let fundedWeeklyHours, annualFundedHours, annualPrivateHours, wastedFundedHours;

  if (a.stretched) {
    // Funding spread evenly across all 52 weeks. A child cannot draw more funded
    // hours in a week than they actually attend, so cap it.
    const uncapped = stretchedWeeklyHours(ent, { weeksPerYear: weeks, termWeeks });
    fundedWeeklyHours  = Math.min(uncapped, attendedHoursWeek);
    annualFundedHours  = fundedWeeklyHours * weeks;
    annualPrivateHours = (attendedHoursWeek - fundedWeeklyHours) * weeks;
    wastedFundedHours  = (uncapped - fundedWeeklyHours) * weeks;
  } else {
    // Term-time only: the entitlement is drawn across 38 weeks and nothing in the
    // remaining 14, so those weeks bill in full. Capped the same way — a 15-hour
    // child attending 10 hours a week cannot bank the other 5.
    const termFunded   = Math.min(ent, attendedHoursWeek);
    fundedWeeklyHours  = termFunded; // during term only
    annualFundedHours  = termFunded * termWeeks;
    annualPrivateHours = (attendedHoursWeek - termFunded) * termWeeks
                       + attendedHoursWeek * (weeks - termWeeks);
    wastedFundedHours  = (ent - termFunded) * termWeeks;
  }

  const annualFeePence = annualPrivateHours * hourlyRatePence;

  // Meal / consumables charge — b299 (2026-09-10). A FLAT weekly amount, billed
  // for every week of the fee year and for nothing else.
  //
  // It used to be pro-rated by funded hours, mirroring the fee_items formula
  // `weekly_funded_hours * meal_rate_weekly / meal_hours_basis` that EyLog uses
  // (£15.35/21.92 for a 2-year-old, £37.05/21.92 for a 3-4-year-old). That is a
  // charge which RISES with the funding a child draws — the funding shortfall
  // recovered under another name — and a provider may not make a funded place
  // conditional on paying the difference. Toby, 2026-09-10: "we're not supposed
  // to be charging the shortfall."
  //
  // So the basis is gone, not just the number. There is no arithmetic here that
  // can see annualFundedHours, which is what stops it coming back by accident.
  // 2026-09-17 — Toby reinstated the EyLog basis ("keep the EyLog rates, I don't
  // want parents complaining that these are different since we switched"). The
  // weekly rate is for mealHoursBasis funded hours (21.92), so the charge follows
  // the funded hours a child draws — and it is voluntary: a family can opt out and
  // bring their own, which is what the funding guide explains. Invoices use the
  // same arithmetic (services/itemised-billing.js, routes/finance-invoices.js).
  const mealRate = Number(a.mealChargeWeeklyPence || 0);
  const mealBasis = Number(a.mealHoursBasis || 21.92);
  const annualMealPence = (mealRate > 0 && fundedWeeklyHours > 0)
    ? Math.round(mealRate * (fundedWeeklyHours / mealBasis) * weeks) : 0;

  const annualTotalPence = annualFeePence + annualMealPence;

  return {
    days_per_week: days,
    day_rate_pence: dayRate,
    hourly_rate_pence: round2(hourlyRatePence),
    attended_hours_week: round2(attendedHoursWeek),
    entitlement_hours_week: round2(ent),
    stretched: !!a.stretched,
    funded_hours_week: round2(fundedWeeklyHours),
    annual_attended_hours: round2(annualAttendedHours),
    annual_funded_hours: round2(annualFundedHours),
    annual_private_hours: round2(annualPrivateHours),
    // Entitlement the child cannot use because they do not attend enough hours.
    annual_wasted_funded_hours: round2(Math.max(0, wastedFundedHours)),
    annual_fee_pence: Math.round(annualFeePence),
    annual_meal_pence: Math.round(annualMealPence),
    annual_total_pence: Math.round(annualTotalPence),
    weeks_per_year: weeks,
    term_weeks: termWeeks,
    day_hours: dayHours,
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

module.exports = {
  WEEKS_PER_YEAR,
  TERM_WEEKS,
  DAY_HOURS,
  EYLOG_STRETCH_BASIS_WEEKS,
  STATUTORY_ENTITLEMENTS,
  termTimeEntitlement,
  stretchedWeeklyHours,
  billChildYear,
  round2,
};
