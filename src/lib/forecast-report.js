'use strict';
// forecast-report.js — 2026-10-26 (Nathan, the company's accountant: "Could I get a similar
// report with the raw data tables for the sessions data? So I can drill into the numbers on
// the 'forecast report'.")
//
// The two Finance (full) forecasts, computed in ONE place so a second caller can never
// re-derive them and drift:
//
//   forecastSeries(db)            → exactly what GET /api/finance/forecast returns (the
//                                   Forecast tab: invoiced history + cash, carried forward)
//   forecastReport(db, {months})  → { report, detail }. `report` is exactly what
//                                   GET /api/finance/forecast/report returns (the Forecast
//                                   Report tab: current bookings × rates). `detail` is what
//                                   the sessions data pack needs to show its working: every
//                                   child's contribution to every category in every month,
//                                   the rates actually used and where each came from.
//
// Moved here verbatim from src/routes/finance-forecast.js. The only change to the queries is
// that the per-child snapshot now also returns the child_bookings and child_funding row ids
// (so the pack can point at the raw rows) and is ORDERed by child then booking, so the report
// and the pack add the children up in the same order every time. The report JSON was compared
// byte-for-byte before and after on wren_dev (generated_at aside) — see
// ladn-ready/logs/nathan-20261026.NOTES.md.

// Ordered category list (drives table columns + pie slices)
const CATS = [
  'Baby Room', 'Pre-School',
  'Meal charge - 2y funding', 'Meal charge - 3-4y funding',
  'Under Two Year Funding', 'Two Year Funding (Working Parents)',
  'Two Year Funding (Disadvantaged)', 'Three Year Funding',
  'Minimum Booking Fees', 'Unassigned',
];

// Fallback rates (used only if the DB row is missing). Pence.
const DEFAULT_DAY  = { under_2: 10500, '2yo': 9700, '3_4yo': 8900 };
const DEFAULT_FUND = { under_2: 1256,  '2yo': 896,  '3_4yo': 594 };
const DEFAULT_MEAL_WEEK_PENCE = 1500; // £15/wk — fee_items food prices are NULL in DB
const WEEKS_PER_MONTH = 52 / 12;      // 4.3333 — flat billing-week assumption

// ── GET /api/finance/forecast ─────────────────────────────────────────────────
// Returns 24-month series: prev 12 actual, next 12 forecast.
async function forecastSeries(db) {
  const now = new Date();
  // ── Historical: monthly invoice totals for last 12 months ─────────────────
  const { rows: historical } = await db.query(`
      SELECT
        i.period_year  AS year,
        i.period_month AS month,
        COALESCE(SUM(i.amount_pence), 0)                                      AS invoiced_pence,
        COALESCE(SUM(i.amount_pence) FILTER (WHERE i.status = 'paid'), 0)       AS paid_pence,
        COALESCE(SUM(i.amount_pence) FILTER (WHERE i.status = 'overdue'), 0)    AS overdue_pence,
        COALESCE(SUM(i.funding_deduction_pence), 0)                           AS funding_pence,
        COUNT(*) FILTER (WHERE i.status NOT IN ('draft','written_off'))        AS invoice_count
      FROM invoices i
      LEFT JOIN children c ON c.id = i.child_id
      WHERE i.period_year IS NOT NULL
        AND COALESCE(c.is_demo, false) = false
        AND (i.period_year * 100 + i.period_month) >=
            ((EXTRACT(YEAR FROM NOW())::int - 1) * 100 + EXTRACT(MONTH FROM NOW())::int)
        AND (i.period_year * 100 + i.period_month) <
            (EXTRACT(YEAR FROM NOW())::int * 100 + EXTRACT(MONTH FROM NOW())::int)
      GROUP BY i.period_year, i.period_month
      ORDER BY i.period_year, i.period_month
    `);

  // ── Historical by room ────────────────────────────────────────────────────
  const { rows: byRoom } = await db.query(`
      SELECT
        i.period_year AS year,
        i.period_month AS month,
        COALESCE(r.name, 'Unassigned') AS room_name,
        COALESCE(SUM(i.amount_pence), 0) AS pence
      FROM invoices i
      LEFT JOIN rooms r ON r.id = i.room_id
      LEFT JOIN children c ON c.id = i.child_id
      WHERE i.period_year IS NOT NULL
        AND COALESCE(c.is_demo, false) = false
        AND (i.period_year * 100 + i.period_month) >=
            ((EXTRACT(YEAR FROM NOW())::int - 1) * 100 + EXTRACT(MONTH FROM NOW())::int)
        AND (i.period_year * 100 + i.period_month) <
            (EXTRACT(YEAR FROM NOW())::int * 100 + EXTRACT(MONTH FROM NOW())::int)
      GROUP BY i.period_year, i.period_month, r.name
      ORDER BY i.period_year, i.period_month, r.name
    `).catch(() => ({ rows: [] }));

  // ── Actual payments by month (cash flow) ─────────────────────────────────
  const { rows: cashflow } = await db.query(`
      SELECT
        EXTRACT(YEAR FROM p.created_at)::int  AS year,
        EXTRACT(MONTH FROM p.created_at)::int AS month,
        COALESCE(SUM(p.amount_pence), 0)      AS collected_pence
      FROM payments p
      LEFT JOIN children c ON c.id = p.child_id
      WHERE p.status = 'succeeded'
        AND p.created_at >= NOW() - INTERVAL '12 months'
        AND COALESCE(c.is_demo, false) = false
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);

  // ── Forecast: current children × average monthly fee ─────────────────────
  const { rows: [feeStats] } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE i.status = 'active') AS active_children,
        COALESCE(AVG(i.amount_pence) FILTER (WHERE i.status NOT IN ('draft','written_off','paid')
          AND i.created_at > NOW() - INTERVAL '3 months'), 0) AS avg_invoice_pence
      FROM invoices i
      LEFT JOIN children c ON c.id = i.child_id
      WHERE COALESCE(c.is_demo, false) = false`);

  const avgFee     = parseFloat(feeStats.avg_invoice_pence) || 0;
  const activeKids = parseInt(feeStats.active_children) || 0;
  const projMonthly = Math.round(avgFee > 0 ? avgFee * activeKids : 0);

  // Fall back to average of last 3 months cashflow if no invoice avg
  let forecastBase = projMonthly;
  if (forecastBase < 100 && cashflow.length) {
    const recent = cashflow.slice(-3);
    forecastBase = Math.round(recent.reduce((s, r) => s + parseInt(r.collected_pence), 0) / recent.length);
  }

  // ── Build 24-month timeline ───────────────────────────────────────────────
  const months = [];
  for (let i = -12; i <= 11; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const label = d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

    const hist = historical.find(r => r.year === y && r.month === m);
    const cash = cashflow.find(r => r.year === y && r.month === m);
    const rooms = byRoom.filter(r => r.year === y && r.month === m)
      .map(r => ({ room: r.room_name, pence: parseInt(r.pence) }));

    const isActual = i < 0;
    months.push({
      year: y, month: m, label,
      is_actual:        isActual,
      invoiced_pence:   hist ? parseInt(hist.invoiced_pence) : 0,
      paid_pence:       hist ? parseInt(hist.paid_pence)     : 0,
      overdue_pence:    hist ? parseInt(hist.overdue_pence)  : 0,
      funding_pence:    hist ? parseInt(hist.funding_pence)  : 0,
      invoice_count:    hist ? parseInt(hist.invoice_count)  : 0,
      collected_pence:  cash ? parseInt(cash.collected_pence): 0,
      forecast_pence:   isActual ? null : forecastBase,
      by_room:          rooms,
    });
  }

  // Running total for cumulative line chart
  let cumulative = 0;
  months.forEach(m => {
    const add = m.is_actual ? m.collected_pence : (m.forecast_pence || 0);
    cumulative += add;
    m.cumulative_pence = cumulative;
  });

  return {
    months,
    summary: {
      active_children:   activeKids,
      avg_monthly_fee:   Math.round(avgFee),
      monthly_forecast:  forecastBase,
      ytd_collected:     months.filter(m => m.year === now.getFullYear() && m.is_actual)
                              .reduce((s, m) => s + m.collected_pence, 0),
    },
    // Not part of the endpoint's JSON (the route sends only the two keys above) — the pack
    // uses it to say plainly which branch produced the forward figure.
    _basis: {
      projected_from_invoices_pence: projMonthly,
      invoice_status_active_count: activeKids,
      cash_months_averaged: projMonthly < 100 && cashflow.length ? cashflow.slice(-3).map(r => ({ year: r.year, month: r.month, collected_pence: parseInt(r.collected_pence) })) : [],
    },
  };
}

// ── GET /api/finance/forecast/report?months=12 ────────────────────────────────
// EyLog-parity "Income Forecast Report": projected monthly income for the next N
// months, each month broken into EyLog's line categories, plus year_totals for a
// pie chart.
//
// Categories (match EyLog "Income Forecast By: Rooms / Groups"):
//   Rooms:            Baby Room, Pre-School
//   Products/Services: Meal charge - 2y funding, Meal charge - 3-4y funding
//   Funding streams:  Under Two Year Funding, Two Year Funding (Working Parents),
//                     Two Year Funding (Disadvantaged), Three Year Funding
//   Minimum Booking Fees, Unassigned
async function forecastReport(db, { months: monthsParam } = {}) {
  const N  = Math.min(24, Math.max(1, parseInt(monthsParam) || 12));
  const now = new Date();

  const assumptions = [];
  // ── Reference rates ───────────────────────────────────────────────────────
  const { rows: feeRows } = await db.query(
    `SELECT age_band, price_pence FROM fee_items
      WHERE active AND statutory_category='additional_paid_hours' AND unit='day' AND price_pence IS NOT NULL`
  ).catch(() => ({ rows: [] }));
  const dayRate = { ...DEFAULT_DAY };
  const dayRateSource = { under_2: 'fallback', '2yo': 'fallback', '3_4yo': 'fallback' };
  feeRows.forEach(r => { if (r.price_pence != null) { dayRate[r.age_band] = parseInt(r.price_pence); dayRateSource[r.age_band] = 'fee_items'; } });

  const { rows: fundRows } = await db.query(
    `SELECT DISTINCT ON (age_band) age_band, pence_per_hour
       FROM funding_rates ORDER BY age_band, funding_year DESC`
  ).catch(() => ({ rows: [] }));
  const fundRate = { ...DEFAULT_FUND };
  const fundRateSource = { under_2: 'fallback', '2yo': 'fallback', '3_4yo': 'fallback' };
  fundRows.forEach(r => {
    const b = r.age_band === '3yo' ? '3_4yo' : r.age_band; // funding_rates uses '3yo'
    fundRate[b] = parseInt(r.pence_per_hour);
    fundRateSource[b] = 'funding_rates';
  });

  const { rows: mealRows } = await db.query(
    `SELECT age_band, unit, price_pence FROM fee_items
      WHERE active AND statutory_category='food' AND price_pence IS NOT NULL AND price_pence>0`
  ).catch(() => ({ rows: [] }));
  const mealWeek = { '2yo': DEFAULT_MEAL_WEEK_PENCE, '3_4yo': DEFAULT_MEAL_WEEK_PENCE };
  const mealWeekSource = { '2yo': 'fallback', '3_4yo': 'fallback' };
  mealRows.forEach(r => {
    const b = r.age_band === '3_4yo' ? '3_4yo' : r.age_band === '2yo' ? '2yo' : null;
    if (!b) return;
    mealWeek[b] = r.unit === 'day' ? parseInt(r.price_pence) * 5 : parseInt(r.price_pence);
    mealWeekSource[b] = 'fee_items';
  });

  // ── Per-child booking + funding snapshot ─────────────────────────────────
  const { rows: kids } = await db.query(`
    SELECT c.id, c.date_of_birth,
           cb.id AS booking_id,
           cb.room_id, r.name AS room_name,
           (cb.mon::int+cb.tue::int+cb.wed::int+cb.thu::int+cb.fri::int) AS days_week,
           cb.start_date, cb.end_date,
           cf.funding_id,
           cf.universal_hours_week, cf.extended_hours_week,
           cf.funding_type, cf.pupil_premium, cf.eypp_eligible
    FROM children c
    JOIN child_bookings cb ON cb.child_id = c.id AND cb.is_active
    LEFT JOIN rooms r ON r.id = cb.room_id
    LEFT JOIN LATERAL (
      SELECT f.id AS funding_id, universal_hours_week, extended_hours_week, funding_type, pupil_premium, eypp_eligible
        FROM child_funding f WHERE f.child_id = c.id
        ORDER BY term_id DESC NULLS LAST LIMIT 1
    ) cf ON true
    WHERE c.is_active AND (c.status IS NULL OR c.status = 'active') AND COALESCE(c.is_demo, false) = false
    ORDER BY c.id, cb.id
  `);

  // ── Trailing invoice average (fallback + sanity) ─────────────────────────
  const { rows: [inv] } = await db.query(`
    SELECT COALESCE(AVG(m.tot),0) AS avg_month_pence
    FROM (
      SELECT i.period_year AS period_year, i.period_month AS period_month, SUM(i.amount_pence) AS tot
        FROM invoices i
        LEFT JOIN children c ON c.id = i.child_id
       WHERE i.period_year IS NOT NULL AND i.status NOT IN ('draft','written_off')
         AND COALESCE(c.is_demo, false) = false
         AND (i.period_year*100+i.period_month) >= ((EXTRACT(YEAR FROM NOW())::int)*100+EXTRACT(MONTH FROM NOW())::int) - 6
       GROUP BY i.period_year, i.period_month
    ) m
  `).catch(() => ({ rows: [{ avg_month_pence: 0 }] }));
  const trailingAvg = Math.round(parseFloat(inv?.avg_month_pence) || 0);

  // ── Age-band helper (as of a given date) ─────────────────────────────────
  const bandFor = (dob, at) => {
    if (!dob) return '3_4yo';
    const d = new Date(dob);
    let age = at.getFullYear() - d.getFullYear();
    const mdiff = at.getMonth() - d.getMonth() + (at.getDate() < d.getDate() ? -1 : 0);
    age = age + (mdiff < 0 ? -1 : 0);
    if (age < 2) return 'under_2';
    if (age < 3) return '2yo';
    return '3_4yo';
  };

  const streamFor = (band, k) => {
    if (band === 'under_2') return 'Under Two Year Funding';
    if (band === '2yo') {
      const disadv = k.pupil_premium || k.eypp_eligible ||
        /disadvantag|dis|2yo_disadv|eypp/i.test(k.funding_type || '');
      return disadv ? 'Two Year Funding (Disadvantaged)' : 'Two Year Funding (Working Parents)';
    }
    return 'Three Year Funding';
  };

  // ── Build the horizon ────────────────────────────────────────────────────
  const months = [];
  const perChild = [];   // detail: one entry per month × booking row that contributed
  let anyProjected = 0;
  for (let i = 0; i < N; i++) {
    const first = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const last  = new Date(now.getFullYear(), now.getMonth() + i + 1, 0);
    const y = first.getFullYear(), m = first.getMonth() + 1;
    const bd = Object.fromEntries(CATS.map(c => [c, 0]));

    for (let ki = 0; ki < kids.length; ki++) {
      const k = kids[ki];
      // booking must be active during this month
      if (k.start_date && new Date(k.start_date) > last) continue;
      if (k.end_date   && new Date(k.end_date)   < first) continue;
      const days = parseInt(k.days_week) || 0;
      if (days <= 0) continue;

      const contrib = {};
      const add = (cat, v) => { bd[cat] += v; contrib[cat] = (contrib[cat] || 0) + v; };

      const band = bandFor(k.date_of_birth, first);
      const gross = (dayRate[band] || 0) * days * WEEKS_PER_MONTH;

      const funded = (parseFloat(k.universal_hours_week) || 0) + (parseFloat(k.extended_hours_week) || 0);
      const fundingValue = funded > 0 ? funded * (fundRate[band] || 0) * WEEKS_PER_MONTH : 0;

      // Funding income → its stream
      if (fundingValue > 0) add(streamFor(band, k), fundingValue);

      // Private room fee = gross minus the value the LA covers (floored at 0)
      const roomName = k.room_name === 'Baby Room' ? 'Baby Room'
                     : k.room_name === 'Pre-school' ? 'Pre-School'
                     : null;
      const priv = Math.max(0, gross - fundingValue);
      if (roomName) add(roomName, priv);
      else add('Unassigned', priv);

      // Meal / consumable charge for funded 2y & 3-4y children
      let meal = 0;
      if (funded > 0 && (band === '2yo' || band === '3_4yo')) {
        meal = (mealWeek[band] || 0) * WEEKS_PER_MONTH;
        add(band === '2yo' ? 'Meal charge - 2y funding' : 'Meal charge - 3-4y funding', meal);
      }
      perChild.push({ month_index: i, year: y, month: m, kid_index: ki, band, days, gross, funded_hours_week: funded,
                      funding_value: fundingValue, meal, contrib });
    }

    // Round each line; compute month total
    let total = 0;
    const breakdown = CATS.map(c => {
      const p = Math.round(bd[c]);
      total += p;
      return { category: c, pence: p };
    });
    anyProjected += total;
    months.push({
      label: first.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
      year: y, month: m, total_pence: total, breakdown,
    });
  }

  // ── Fallback to trailing invoice average if bottom-up produced nothing ────
  let model = 'bottom_up';
  if (anyProjected < 100 && trailingAvg > 0) {
    model = 'trailing_average';
    assumptions.push('No current bookings found — projection falls back to the trailing 6-month average invoiced total, attributed to Unassigned.');
    months.forEach(mo => {
      mo.total_pence = trailingAvg;
      mo.breakdown = CATS.map(c => ({ category: c, pence: c === 'Unassigned' ? trailingAvg : 0 }));
    });
  }

  // ── Year totals for the pie ──────────────────────────────────────────────
  const year_totals = Object.fromEntries(CATS.map(c => [c, 0]));
  months.forEach(mo => mo.breakdown.forEach(b => { year_totals[b.category] += b.pence; }));

  const horizonTotal = months.reduce((s, mo) => s + mo.total_pence, 0);

  // ── Assumptions / limitations ────────────────────────────────────────────
  assumptions.push(
    `Projection is flat across the ${N}-month horizon: it assumes current active bookings and funding continue unchanged (no seasonal enrolment, no new starters/leavers beyond recorded booking start/end dates).`,
    `Billing weeks per month assumed ${WEEKS_PER_MONTH.toFixed(4)} (52/12).`,
    `Day rates from fee_items (additional_paid_hours); missing bands default to under-2 £${(DEFAULT_DAY.under_2/100)}, 2yo £${(DEFAULT_DAY['2yo']/100)}, 3-4yo £${(DEFAULT_DAY['3_4yo']/100)}.`,
    `Funding income = recorded funded hours/week × funding_rates £/hr; room fee shown net of funded value.`,
    mealRows.length
      ? 'Meal/consumable charges use fee_items food prices.'
      : `Meal charges use a placeholder of £${(DEFAULT_MEAL_WEEK_PENCE/100)}/week for funded 2y & 3-4y children — fee_items food prices are not set.`,
    'Age band (under-2 / 2yo / 3-4yo) is recomputed per month from each child\'s date of birth, so children crossing a birthday move funding stream mid-horizon.',
    `Trailing 6-month average invoiced total for reference: £${(trailingAvg/100).toFixed(2)}/month.`,
  );

  const report = {
    horizon_months: N,
    generated_at: new Date().toISOString(),
    model,
    categories: CATS,
    months,
    year_totals,
    headline: {
      total_pence: horizonTotal,
      avg_month_pence: Math.round(horizonTotal / N),
      trailing_avg_month_pence: trailingAvg,
    },
    assumptions,
  };
  const detail = {
    kids, perChild, trailingAvg, model,
    rates: { dayRate, dayRateSource, fundRate, fundRateSource, mealWeek, mealWeekSource,
             feeRowsRead: feeRows.length, fundRowsRead: fundRows.length, mealRowsRead: mealRows.length },
  };
  return { report, detail };
}

// Whole-pence shares of `target` for exact (fractional) pence `values`, so the shares add up
// to target exactly: floor each, then hand the leftover pennies to the largest fractions
// (largest-remainder). No share moves by more than 1p from its exact value.
function apportion(values, target) {
  const floors = values.map(v => Math.floor(v));
  let left = target - floors.reduce((s, v) => s + v, 0);
  const order = values.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const out = floors.slice();
  for (let j = 0; left > 0 && j < order.length; j++, left--) out[order[j][1]] += 1;
  // Cannot happen (target = round(sum) ≥ sum of floors, and ≤ that + n), but never lose a penny.
  if (left !== 0 && out.length) { let big = 0; out.forEach((v, i) => { if (v > out[big]) big = i; }); out[big] += left; }
  return out;
}

module.exports = { CATS, DEFAULT_DAY, DEFAULT_FUND, DEFAULT_MEAL_WEEK_PENCE, WEEKS_PER_MONTH,
                   forecastSeries, forecastReport, apportion };
