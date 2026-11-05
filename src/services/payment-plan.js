'use strict';
// Payment-plan calculator service (pure, no DB / no I/O).
// Build log 2026-08-03 §2 — fees payment plans + arrears + baby pre-funding deferral.
//
// All money is in integer PENCE. All dates are ISO 'YYYY-MM-DD' strings.
// The calc is deliberately month-granular: nursery fees are billed monthly, so a
// "billing month" is one calendar month. Arrears accrue when a family pays less
// than the monthly-after-funding fee; we then spread the accrued balance over a
// run of equal catch-up instalments (with the last one absorbing the remainder).

function _clampInt(n) { return Math.max(0, Math.round(Number(n) || 0)); }

function _ymAdd(ym, delta) {
  // ym = {y, m} (m 1-12) → advance by delta months.
  let idx = ym.y * 12 + (ym.m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}
function _parseYM(iso) {
  const [y, m] = String(iso).slice(0, 7).split('-').map(Number);
  return { y, m };
}
function _label(ym) {
  return `${ym.y}-${String(ym.m).padStart(2, '0')}`;
}
function _prettyLabel(ym) {
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${MON[ym.m - 1]} ${ym.y}`;
}

// Count of inclusive calendar months from startIso..endIso (both billed).
// e.g. Jan..Mar = 3. Returns 0 if end precedes start.
function monthsInclusive(startIso, endIso) {
  const a = _parseYM(startIso), b = _parseYM(endIso);
  const n = (b.y * 12 + b.m) - (a.y * 12 + a.m) + 1;
  return Math.max(0, n);
}

function gbp(pence) {
  return '£' + (_clampInt(pence) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * computePlan — arrears build-up + balance at leave + catch-up instalments.
 *
 * @param {object} o
 * @param {number} o.monthlyPence     monthly fee AFTER funding is deducted
 * @param {number} o.payNowPence      what the family can pay each month right now
 * @param {string} o.startDate        ISO date the plan starts (default: today)
 * @param {string} o.leaveDate        ISO date fees stop (child's leave date)
 * @param {number} [o.catchUpMonthly] £/mo (pence) they can pay AFTER leave to clear arrears
 * @param {number} [o.catchUpMonths]  alternatively, spread arrears over this many months
 * @returns {object} full plan (schedule, balanceAtLeavePence, instalments, summary)
 */
function computePlan(o) {
  const monthly = _clampInt(o.monthlyPence);
  const payNow  = Math.min(_clampInt(o.payNowPence), monthly); // can't "pay" more than owed per month
  const startDate = o.startDate || new Date().toISOString().slice(0, 10);
  const leaveDate = o.leaveDate || startDate;

  const monthShortfall = Math.max(0, monthly - payNow);
  const nMonths = monthsInclusive(startDate, leaveDate);

  // Month-by-month arrears build-up.
  const schedule = [];
  let cumulative = 0;
  let ym = _parseYM(startDate);
  for (let i = 0; i < nMonths; i++) {
    cumulative += monthShortfall;
    schedule.push({
      month: _label(ym),
      month_label: _prettyLabel(ym),
      charged_pence: monthly,
      paid_pence: payNow,
      shortfall_pence: monthShortfall,
      cumulative_arrears_pence: cumulative,
    });
    ym = _ymAdd(ym, 1);
  }

  const balanceAtLeavePence = cumulative; // == monthShortfall * nMonths

  // Catch-up instalment plan to clear the balance after the child leaves.
  // Priority: explicit catchUpMonthly → explicit catchUpMonths → sensible default
  // (keep paying what they were paying; if payNow is 0, spread over 12 months).
  let catchUpMonthly = _clampInt(o.catchUpMonthly);
  if (!catchUpMonthly && o.catchUpMonths) {
    catchUpMonthly = Math.ceil(balanceAtLeavePence / Math.max(1, Number(o.catchUpMonths)));
  }
  if (!catchUpMonthly) {
    catchUpMonthly = payNow > 0 ? payNow : Math.ceil(balanceAtLeavePence / 12);
  }

  const instalments = [];
  if (balanceAtLeavePence > 0 && catchUpMonthly > 0) {
    let remaining = balanceAtLeavePence;
    // instalments start the month AFTER leave.
    let iy = _ymAdd(_parseYM(leaveDate), 1);
    let guard = 0;
    while (remaining > 0 && guard < 600) {
      const amount = Math.min(catchUpMonthly, remaining);
      remaining -= amount;
      instalments.push({
        month: _label(iy),
        month_label: _prettyLabel(iy),
        amount_pence: amount,
        remaining_pence: remaining,
      });
      iy = _ymAdd(iy, 1);
      guard++;
    }
  }

  const catchUpMonths = instalments.length;
  return {
    inputs: {
      monthly_pence: monthly,
      pay_now_pence: payNow,
      start_date: startDate,
      leave_date: leaveDate,
      catch_up_monthly_pence: catchUpMonthly,
    },
    billing_months: nMonths,
    month_shortfall_pence: monthShortfall,
    schedule,
    balance_at_leave_pence: balanceAtLeavePence,
    instalments,
    catch_up_months: catchUpMonths,
    catch_up_monthly_pence: catchUpMonthly,
    summary: balanceAtLeavePence === 0
      ? `Paying ${gbp(payNow)}/mo clears the ${gbp(monthly)}/mo fee in full — no arrears build up.`
      : `Paying ${gbp(payNow)}/mo against a ${gbp(monthly)}/mo fee builds ${gbp(balanceAtLeavePence)} of arrears over ${nMonths} month${nMonths === 1 ? '' : 's'}, cleared by ${catchUpMonths} × ${gbp(catchUpMonthly)} after the leave date.`,
  };
}

/**
 * babyPrefundingPlan — deferral for babies who start (~9mo) BEFORE under-2
 * working-parent funding begins. During the pre-funding window the family pays a
 * small holding amount; the difference is deferred and cleared once funding lands.
 *
 * @param {object} o
 * @param {number} o.monthlyPence       full private monthly fee before funding
 * @param {string} o.startDate          baby's (expected) start date
 * @param {string} o.fundingStartDate   when under-2 funding begins (term start)
 * @param {number} [o.smallMonthlyPence] holding payment during deferral (default £100/mo)
 * @param {number} [o.catchUpMonths]    months to clear the deferred balance (default 6)
 * @returns {object} { deferral, plan, assumptions }
 */
function babyPrefundingPlan(o) {
  const monthly = _clampInt(o.monthlyPence);
  const startDate = o.startDate || new Date().toISOString().slice(0, 10);
  const fundingStartDate = o.fundingStartDate;
  const smallMonthly = o.smallMonthlyPence != null ? _clampInt(o.smallMonthlyPence) : 10000; // £100 default
  const catchUpMonths = Number(o.catchUpMonths) || 6;

  // Pre-funding window = months from start up to (but not including) funding start.
  // computePlan bills inclusive, so use the month BEFORE funding start as leaveDate.
  const fs = _parseYM(fundingStartDate);
  const lastPrefundingMonth = _ymAdd(fs, -1);
  const leaveIso = `${lastPrefundingMonth.y}-${String(lastPrefundingMonth.m).padStart(2, '0')}-01`;

  const plan = computePlan({
    monthlyPence: monthly,
    payNowPence: Math.min(smallMonthly, monthly),
    startDate,
    leaveDate: leaveIso,
    catchUpMonths,
  });

  return {
    deferral: {
      window_start: startDate,
      funding_start: fundingStartDate,
      prefunding_months: plan.billing_months,
      holding_payment_pence: Math.min(smallMonthly, monthly),
      deferred_balance_pence: plan.balance_at_leave_pence,
    },
    plan,
    assumptions: [
      'Under-2 working-parent funding is assumed to begin at fundingStartDate (the start of the first funding term on/after the child turns 9 months, unless overridden).',
      `During the pre-funding window the family pays a holding amount of ${gbp(Math.min(smallMonthly, monthly))}/mo; the remainder is deferred.`,
      `The deferred balance (${gbp(plan.balance_at_leave_pence)}) is cleared over ~${catchUpMonths} instalments once funding lands and the ongoing fee drops.`,
    ],
    summary: plan.billing_months === 0
      ? 'Funding starts at or before the start date — no pre-funding deferral needed.'
      : `Baby starts ${startDate}, ${plan.billing_months} month${plan.billing_months === 1 ? '' : 's'} before funding on ${fundingStartDate}. Defer ${gbp(plan.balance_at_leave_pence)}, then clear over ${plan.instalments.length} × ${gbp(plan.catch_up_monthly_pence)}.`,
  };
}

module.exports = { computePlan, babyPrefundingPlan, monthsInclusive, gbp, DEFAULT_SUPPORT_MESSAGE: [
  'We understand that things can be hard, and money worries are common.',
  'Payment plans are available — talk to us and we can spread your costs into affordable instalments.',
  'We can signpost you to grants and financial support you may be entitled to.',
  'Your funding situation may change (for example when your child qualifies for funded hours), and we will always review your plan with you.',
  'Your child\'s place and care are never affected by a payment plan.',
].join(' ') };
