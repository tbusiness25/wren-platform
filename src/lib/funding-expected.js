'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b524 (2026-10-21) — what Ealing owes us for a claim month, by age group, and
// what actually arrived.
//
// THE JULY LESSON. In July 2026 the under-2s money did not come and nobody
// noticed, because nothing in Wren ever stated what the figure should have been.
// b298 gave us the claim MONTHS (funding_claim_periods) and b346 gave us the
// payment dates; what was missing is the arithmetic in between. This module is
// that arithmetic and nothing else — it reads, it never writes.
//
// expected = claim hours/week × the claim month's WEEKS × the hourly rate
//
// Three things about that line are easy to get wrong:
//
//  • THE WEEKS ARE EALING'S, NOT THE CALENDAR'S. `funding_claim_periods.weeks`
//    is published in their payment timetable and is not days ÷ 7 (their Autumn
//    is 18 weeks where the calendar gives 17.43). Where `weeks_confirmed` is
//    false the number is Wren's own guess, so every figure derived from it is
//    returned with `weeks_confirmed:false` and the UI says so. An unconfirmed
//    month is never allowed to raise a shortfall alert — it would fire on our
//    own arithmetic, not on Ealing's.
//
//  • AGE IS TAKEN AT THE START OF THE CLAIM MONTH. The LA counts age at the
//    start of the funding period, and `ageBand` in src/lib/funding-rate.js is
//    the one place that rule lives. A child who turns 2 mid-month is an under-2
//    for that claim — which is precisely the population that went missing.
//
//  • TWO TERMS CAN COVER ONE MONTH. Prod has two funding_terms rows over every
//    month from Apr 2026 (the duplicate-term problem in
//    reference_funding_read_only_from_is_current_term), so a month has two claim
//    periods. Their expected amounts must NEVER be added together: the children
//    hang off ONE of the two terms and the other reads as zero. Each claim
//    period is costed from the children on ITS OWN term, and `primaryFor()`
//    picks the one that actually has them.
//
// COUNTS, TOTALS AND AGE BANDS ONLY. No child is named, listed or identified
// here; the only per-child value that leaves this module is a count.
// ─────────────────────────────────────────────────────────────────────────────

const { ageBand } = require('./funding-rate');

// age band (funding-rate.js) → ladn.funding_rates.age_band
const RATE_BAND = { under_2: 'under_2', two: '2yo', three_four: '3yo' };
const BAND_LABEL = {
  under_2: 'Under 2', two: 'Two-year-olds', three_four: 'Three and four-year-olds',
  over_5: 'Over 5', unknown: 'Date of birth missing',
};
// The order they are shown in, and the order a shortfall is reported in.
const BANDS = ['under_2', 'two', 'three_four', 'over_5', 'unknown'];

/** The DfE funding year a date falls in: April to March. 2026-07-13 → '2026-27'. */
function fundingYear(d) {
  const dt = (d instanceof Date) ? d : new Date(String(d));
  if (isNaN(dt)) return null;
  const y = dt.getMonth() + 1 >= 4 ? dt.getFullYear() : dt.getFullYear() - 1;
  return `${y}-${String(y + 1).slice(2)}`;
}

const int = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * The hours a child is claimed for in a week.
 *
 * `funded_hours_week` is what the b205 EyLog import recorded as actually claimed;
 * `total_hours_week` is the generated universal + extended column. Prefer the
 * recorded figure and fall back to the entitlement, saying which was used — a
 * child allocated 30 hours who attends 24 is claimed for 24, and reporting the
 * entitlement would invent a shortfall that Ealing does not owe.
 */
function hoursPerWeek(cf) {
  const funded = int(cf.funded_hours_week);
  const total = int(cf.total_hours_week);
  const base = funded > 0 ? { hours: funded, basis: 'funded_hours_week' }
             : total > 0 ? { hours: total, basis: 'entitlement' } : { hours: 0, basis: 'none' };
  // 2026-10-26 (checked against Ealing's portal, Months 5 and 6): Ealing pays TERM-TIME hours
  // (30 a week × the claim month's term weeks: 120 h in September, 90 h in October). Wren stores
  // a stretched child's hours spread over 52 weeks (30 × 38/52 = 21.92), which under-stated every
  // claim month by about a quarter. Convert back, to the nearest half hour: 21.92 → 30, 14.61 → 20.
  if (cf.stretched_funding && base.hours > 0) {
    return { hours: Math.round(base.hours * 52 / 38 * 2) / 2, basis: base.basis + ' (stretched → term-time)' };
  }
  return base;
}

// 2026-10-26: Ealing bands a child by the entitlement on its claim, not by age on the 1st of
// the month (the engine counted 9/7/7 children for September where the portal has 8/8/4).
const TYPE_BAND = { under_2: 'under_2', '2yr_working': 'two', two_year: 'two', extended: 'three_four', universal: 'three_four' };

/** A pg DATE (a JS Date at local midnight) or a 'YYYY-MM-DD' string → 'YYYY-MM-DD'; null if empty. */
function toYmd(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

/** Mondays inside the school terms between two dates (inclusive). Null when no term dates are held. */
function termMondays(from, to, terms) {
  if (!terms || !terms.length) return null;
  const d = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  let n = 0;
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
    const iso = d.toISOString().slice(0, 10);
    if (terms.some((t) => iso >= t.start && iso <= t.end)) n += 1;
  }
  return n;
}

/**
 * The claim weeks for one child. A child who starts or leaves part-way through the month is
 * claimed only for the term weeks they were on roll (the portal paid the 16 Oct leaver 60 of 90 h).
 * Counted from ladn.school_terms; if those don't reproduce Ealing's own week count for the month,
 * the child's share of Ealing's weeks is used instead.
 */
function childWeeks(r, period, weeks, terms) {
  const s = toYmd(r.start_date), l = toYmd(r.leave_date);
  const from = s && s > period.claim_start ? s : period.claim_start;
  const to = l && l < period.claim_end ? l : period.claim_end;
  if (from === period.claim_start && to === period.claim_end) return weeks;
  if (from > to) return 0;
  const all = termMondays(period.claim_start, period.claim_end, terms);
  const mine = termMondays(from, to, terms);
  if (all == null || mine == null || all === 0) return weeks;
  return all === weeks ? mine : Math.round(weeks * mine / all * 100) / 100;
}

/**
 * Cost one claim period.
 *
 * @param rows   one row per funded child on this period's TERM:
 *               { child_id, dob, funding_type, funded_hours_week, total_hours_week }
 * @param period funding_claim_periods row
 * @param rates  Map 'age_band|funding_year' → pence_per_hour
 * @param term   the funding_terms row, for the rate fallback
 */
function costPeriod(rows, period, rates, term, terms) {
  const year = fundingYear(period.claim_start);
  const weeks = int(period.weeks);
  const bands = {};
  for (const b of BANDS) {
    bands[b] = { band: b, label: BAND_LABEL[b], children: 0, hours_week: 0, hours_claim: 0,
                 pence_per_hour: null, rate_source: null, expected_pence: 0 };
  }

  let missingRate = 0, zeroHours = 0;

  for (const r of rows) {
    if (r.funding_type === 'none') continue;   // on the term's list but not claimed
    const band = TYPE_BAND[r.funding_type] || ageBand(r.dob, period.claim_start);
    const slot = bands[band] || bands.unknown;
    const { hours } = hoursPerWeek(r);
    const w = childWeeks(r, period, weeks, terms);
    if (w <= 0) continue;                       // not on roll in this claim month
    slot.children += 1;
    if (hours <= 0) { zeroHours += 1; continue; }

    // The rate. funding_rates first, as the brief says; the term's own rate_*
    // column (src/lib/funding-rate.js) is the fallback, because Summer 26 carries
    // real rates and funding_rates only has one year in it.
    let pph = null, src = null;
    const key = `${RATE_BAND[band] || band}|${year}`;
    if (rates.has(key)) { pph = int(rates.get(key)); src = `funding_rates ${year}`; }
    if (!pph && term) {
      const { rateFor } = require('./funding-rate');
      const pounds = rateFor(term, r.funding_type);
      if (pounds > 0) { pph = Math.round(pounds * 100); src = 'funding_terms rate column'; }
    }
    if (!pph) { missingRate += 1; continue; }

    slot.hours_week  += hours;
    slot.hours_claim += hours * w;
    slot.pence_per_hour = pph;           // one rate per band per year
    slot.rate_source = src;
    slot.expected_pence += Math.round(hours * w * pph);
  }

  // Hours are summed as floats (child_funding stores NUMERIC(8,2)), so a total
  // prints as 197.28000000000003. Round for display; the expected PENCE figure
  // is already an integer and is computed per child, never from this total.
  for (const b of Object.values(bands)) {
    b.hours_week  = Math.round(b.hours_week  * 100) / 100;
    b.hours_claim = Math.round(b.hours_claim * 100) / 100;
  }

  const used = BANDS.map(b => bands[b]).filter(s => s.children > 0);
  const expected = used.reduce((a, s) => a + s.expected_pence, 0);

  return {
    claim_period_id: period.id,
    term_id: period.term_id,
    period_year: period.period_year,
    period_month: period.period_month,
    period_label: period.period_label,
    claim_start: period.claim_start,
    claim_end: period.claim_end,
    weeks,
    weeks_confirmed: !!period.weeks_confirmed,
    funding_year: year,
    payment_expected: period.payment_expected || null,
    adj_payment_expected: period.adj_payment_expected || null,
    children: used.reduce((a, s) => a + s.children, 0),
    expected_pence: expected,
    bands: used,
    // Everything the figure could NOT account for, named rather than absorbed.
    gaps: {
      children_with_no_rate: missingRate,
      children_with_no_hours: zeroHours,
    },
  };
}

/**
 * Which of a month's claim periods is the one that matters.
 *
 * Two terms covering one month is a data fault, not a feature, and the receipt
 * belongs to whichever of them the children are actually on. Highest expected
 * wins; ties go to the lower id so the answer is stable between calls.
 */
function primaryFor(periodsForMonth) {
  const live = (periodsForMonth || []).filter(Boolean);
  if (!live.length) return null;
  return live.slice().sort((a, b) =>
    (b.expected_pence - a.expected_pence) || (a.claim_period_id - b.claim_period_id))[0];
}

/**
 * Compare a costed month against what came in.
 *
 * `shortPct` is the tolerance from settings (default 5). `lateDays` is how long
 * after payment_expected an absent payment becomes a problem (default 3).
 */
function compare(costed, receipts, { shortPct = 5, lateDays = 3, today = new Date() } = {}) {
  const received = (receipts || []).reduce((a, r) => a + int(r.amount_pence), 0);
  const expected = int(costed.expected_pence);
  const diff = received - expected;
  const pct = expected > 0 ? (diff / expected) * 100 : null;

  // The date the money is due. Ealing pay the claim, then an adjustment later;
  // the first date is the one a missing payment is measured against.
  const due = costed.payment_expected || null;
  const dueDate = due ? new Date(`${String(due).slice(0, 10)}T00:00:00Z`) : null;
  const now = (today instanceof Date) ? today : new Date(String(today));
  const daysPastDue = dueDate ? Math.floor((now - dueDate) / 86400000) : null;

  const flags = [];
  // 2026-10-26: the portal adds a deprivation supplement (DEP, about 40p an hour) for some
  // three- and four-year-olds. Wren holds no DEP flags yet, so say it is left out rather
  // than let a small gap look like a short payment.
  const tf = (costed.bands || []).find((b) => b.band === 'three_four');
  if (tf && tf.children > 0) {
    flags.push({ code: 'deprivation_not_held', severity: 'info',
      message: "Ealing also pays a deprivation supplement (about 40p an hour) for some three- and four-year-olds. Wren doesn't hold which children get it, so it isn't in this figure." });
  }
  // An unconfirmed week count means the expected figure is Wren's guess. Say so,
  // and raise nothing off the back of it.
  if (!costed.weeks_confirmed) {
    flags.push({ code: 'weeks_unconfirmed', severity: 'info',
      message: "Ealing's week count for this month has not been confirmed, so the expected figure is Wren's own calendar estimate. No alert is raised from it." });
  } else if (expected <= 0) {
    flags.push({ code: 'no_expectation', severity: 'info',
      message: 'No funded hours are recorded against this claim month, so there is nothing to expect.' });
  } else if (received === 0) {
    if (daysPastDue != null && daysPastDue > lateDays) {
      flags.push({ code: 'missing', severity: 'high',
        message: `Nothing has arrived and payment was expected on ${String(due).slice(0, 10)}, ${daysPastDue} days ago.` });
    } else {
      flags.push({ code: 'awaiting', severity: 'info',
        message: due ? `Awaiting payment, expected ${String(due).slice(0, 10)}.` : 'Awaiting payment; no expected date is set for this month.' });
    }
  } else if (pct != null && pct < -shortPct) {
    flags.push({ code: 'short', severity: 'high',
      message: `Short by ${Math.abs(pct).toFixed(1)}% of what the claim should have paid.` });
  } else if (pct != null && pct > shortPct) {
    flags.push({ code: 'over', severity: 'medium',
      message: `More arrived than the claim accounts for (${pct.toFixed(1)}% over) — likely an adjustment for an earlier month.` });
  } else {
    flags.push({ code: 'ok', severity: 'ok', message: 'Received as expected.' });
  }
  for (const g of ['children_with_no_rate', 'children_with_no_hours']) {
    if (costed.gaps[g] > 0) {
      flags.push({ code: g, severity: 'info',
        message: g === 'children_with_no_rate'
          ? `${costed.gaps[g]} funded children have no hourly rate for ${costed.funding_year}, so they are not in the expected figure.`
          : `${costed.gaps[g]} funded children have no claim hours recorded, so they are not in the expected figure.` });
    }
  }

  // Where the money went missing, band by band. Apportioned by each band's share
  // of the expected total: Ealing pay one lump, so the split is an attribution,
  // not a measurement, and it is labelled as one.
  const bands = costed.bands.map((b) => {
    const share = expected > 0 ? b.expected_pence / expected : 0;
    const apportioned = Math.round(received * share);
    return Object.assign({}, b, {
      received_apportioned_pence: apportioned,
      shortfall_pence: b.expected_pence - apportioned,
    });
  });

  return Object.assign({}, costed, {
    received_pence: received,
    receipt_count: (receipts || []).length,
    difference_pence: diff,
    difference_pct: pct == null ? null : Number(pct.toFixed(2)),
    days_past_due: daysPastDue,
    is_short: !!(costed.weeks_confirmed && expected > 0 && pct != null && pct < -shortPct),
    is_missing: !!(costed.weeks_confirmed && expected > 0 && received === 0
                   && daysPastDue != null && daysPastDue > lateDays),
    flags,
    bands,
    apportionment_note: 'Ealing pay one amount for the whole claim, so the per-band received figures are the total apportioned by each band\'s share of what was expected — not separate payments.',
  });
}

module.exports = {
  BANDS, BAND_LABEL, RATE_BAND,
  fundingYear, hoursPerWeek, costPeriod, primaryFor, compare,
};
