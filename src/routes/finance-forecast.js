'use strict';
// Finance Forecast — 12 months actual + 12 months projected income.
// Mounted at /api/finance/forecast

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const FR = require('../lib/forecast-report');
const { recordAudit } = require('../utils/audit');

router.use(authenticate);

const managerGuard = (req, res, next) => {
  // b480: 'accountant' added — safe only because the accountant-scope gate in
  // server-unified.js has already restricted that role to GET requests on a
  // short allowlist (this router's paths included) before this ever runs.
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'accountant'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerGuard);

// ── GET /api/finance/forecast ─────────────────────────────────────────────────
// Returns 24-month series: prev 12 actual, next 12 forecast. The calculation lives in
// src/lib/forecast-report.js (2026-10-26) so the sessions data pack quotes the same figures.
router.get('/', async (req, res) => {
  const db  = getPool();
  try {
    const { months, summary } = await FR.forecastSeries(db);
    res.json({ months, summary });
  } catch (e) {
    console.error('[finance-forecast] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/forecast/month/:year/:month ──────────────────────────────
// Drill-down: invoices contributing to a specific month.
router.get('/month/:year/:month', async (req, res) => {
  const db  = getPool();
  const { year, month } = req.params;
  try {
    const { rows } = await db.query(`
      SELECT i.id, i.invoice_number, i.amount_pence, i.status,
             i.funding_deduction_pence, i.notes, i.due_on,
             c.first_name || ' ' || c.last_name AS child_name,
             i.bill_payer_email, i.payment_method
      FROM invoices i
      JOIN children c ON c.id = i.child_id
      WHERE i.period_year = $1 AND i.period_month = $2
        AND i.status NOT IN ('draft','written_off')
        AND COALESCE(c.is_demo, false) = false
      ORDER BY i.status = 'overdue' DESC, c.first_name, c.last_name
    `, [parseInt(year), parseInt(month)]);

    const totals = rows.reduce((acc, r) => {
      acc.total += parseInt(r.amount_pence);
      if (r.status === 'paid') acc.paid += parseInt(r.amount_pence);
      if (r.status === 'overdue') acc.overdue += parseInt(r.amount_pence);
      return acc;
    }, { total: 0, paid: 0, overdue: 0 });

    res.json({ invoices: rows, totals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/forecast/report?months=12 ────────────────────────────────
// EyLog-parity "Income Forecast Report": projected monthly income for the next N
// months, each month broken into EyLog's line categories, plus year_totals for a
// pie chart. Additive — does not touch the / or /month/:y/:m endpoints above.
// 2026-10-26: the calculation moved, unchanged, to src/lib/forecast-report.js so the
// sessions data pack below is built from the very same numbers (one place, one version).
router.get('/report', async (req, res) => {
  const db = getPool();
  try {
    const { report } = await FR.forecastReport(db, { months: req.query.months });
    res.json(report);
  } catch (e) {
    console.error('[finance-forecast/report] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/forecast/report/data-pack.xlsx?months=12&names=0|1 ─────────
// 2026-10-26 — Nathan (accountant): "Could I get a similar report with the raw data tables for
// the sessions data? So I can drill into the numbers on the 'forecast report'."
// The Forecast Report's working, as one Excel workbook, modelled on the accountant data pack
// (finance-payments.js GET /accountant-pack): same xlsx library, same identifiers (child_id +
// family_ref, the family's payment reference), names only with names=1, demo children never
// (the report already leaves them out), the same role gate (this router's managerGuard), audited.
// Every figure comes from ONE call to FR.forecastReport — the function GET /report above sends —
// so the Monthly sheet IS the report, and Per child per month is apportioned to the penny from
// the same per-child values the report added up. The Checks sheet proves both.
router.get('/report/data-pack.xlsx', async (req, res) => {
  const db = getPool();
  const names = req.query.names === '1';
  try {
    const XLSX = require('xlsx');
    const PM = require('../services/payment-matcher');
    const FAMILY_KEY_SQL = PM.FAMILY_KEY_SQL('c');
    const { report, detail } = await FR.forecastReport(db, { months: req.query.months });
    const series = await FR.forecastSeries(db);
    const N = report.horizon_months;
    const CATS = report.categories;
    const gbp = (p) => p == null ? null : Math.round(Number(p)) / 100;
    const d = (v) => { if (!v) return null; const x = new Date(v); if (isNaN(x)) return String(v);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
    const BAND = { under_2: 'under 2', '2yo': '2 year old', '3_4yo': '3-4 year old' };

    // child → family reference (and names only if asked) — the accountant pack's own lookup.
    const kidIds = [...new Set(detail.kids.map(k => Number(k.id)))];
    const { rows: refs } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, r.payment_ref
        FROM children c LEFT JOIN family_payment_refs r ON r.family_key = ${FAMILY_KEY_SQL}
       WHERE COALESCE(c.is_demo, false) = false AND c.id = ANY($1::int[])`, [kidIds]);
    const kid = new Map(refs.map(k => [Number(k.id), k]));
    const who = (cid) => { const k = kid.get(Number(cid)); if (!k) return { child_id: cid, family_ref: null };
      return names ? { child_id: k.id, family_ref: k.payment_ref || null, child: `${k.first_name || ''} ${k.last_name || ''}`.trim() }
                   : { child_id: k.id, family_ref: k.payment_ref || null }; };

    // ── Monthly — exactly the report's month × category table ──────────────────
    const monthly = report.months.map(mo => {
      const by = Object.fromEntries(mo.breakdown.map(b => [b.category, b.pence]));
      return { month: ym(mo.year, mo.month), label: mo.label, ...Object.fromEntries(CATS.map(c => [c, gbp(by[c])])), total_gbp: gbp(mo.total_pence) };
    });
    monthly.push({ month: 'HORIZON TOTAL', label: `${N} months`, ...Object.fromEntries(CATS.map(c => [c, gbp(report.year_totals[c])])),
                   total_gbp: gbp(report.headline.total_pence) });

    // ── Per child per month — the report's own per-child values, in whole pence ─
    // Each category's exact (fractional) pence are rounded with largest-remainder so that,
    // for every month and category, the children add up to the Monthly figure exactly.
    const perChildRows = [];
    const sums = new Map(); // `${i}|${cat}` → pence summed from the rows written
    const addSum = (i, c, p) => { const k = i + '|' + c; sums.set(k, (sums.get(k) || 0) + p); };
    for (let i = 0; i < N; i++) {
      const mo = report.months[i];
      const target = Object.fromEntries(mo.breakdown.map(b => [b.category, b.pence]));
      if (detail.model === 'trailing_average') {
        perChildRows.push({ month: ym(mo.year, mo.month), child_id: null, family_ref: 'NO BOOKINGS — trailing 6-month invoice average', ...(names ? { child: null } : {}),
          booking_id: null, room: null, age_band: null, days_per_week: null, funded_hours_week: null,
          ...Object.fromEntries(CATS.map(c => [c, gbp(target[c])])), total_gbp: gbp(mo.total_pence), exact_total_pence: mo.total_pence });
        CATS.forEach(c => addSum(i, c, target[c]));
        continue;
      }
      const E = detail.perChild.filter(e => e.month_index === i);
      const shares = Object.fromEntries(CATS.map(c => [c, FR.apportion(E.map(e => e.contrib[c] || 0), target[c])]));
      E.forEach((e, j) => {
        const k = detail.kids[e.kid_index];
        let tot = 0, exact = 0;
        const cols = Object.fromEntries(CATS.map(c => { tot += shares[c][j]; exact += (e.contrib[c] || 0); addSum(i, c, shares[c][j]); return [c, gbp(shares[c][j])]; }));
        perChildRows.push({ month: ym(e.year, e.month), ...who(k.id), booking_id: k.booking_id, room: k.room_name || null,
          age_band: BAND[e.band] || e.band, days_per_week: e.days, funded_hours_week: e.funded_hours_week,
          ...cols, total_gbp: gbp(tot), exact_total_pence: Math.round(exact * 10000) / 10000 });
      });
    }

    // ── Children — one row per booking the report read ─────────────────────────
    const R = detail.rates;
    const children = detail.kids.map((k, ki) => {
      const mine = detail.perChild.filter(e => e.kid_index === ki);
      const days = parseInt(k.days_week) || 0;
      const first = mine[0], lastE = mine[mine.length - 1];
      const bandFirst = first ? first.band : null, bandLast = lastE ? lastE.band : null;
      const changeAt = mine.find(e => first && e.band !== first.band);
      const funded = (parseFloat(k.universal_hours_week) || 0) + (parseFloat(k.extended_hours_week) || 0);
      const mealOn = funded > 0 && (bandFirst === '2yo' || bandFirst === '3_4yo');
      return { ...who(k.id), booking_id: k.booking_id, funding_row_id: k.funding_id || null, room: k.room_name || null,
        category_for_room_fee: k.room_name === 'Baby Room' ? 'Baby Room' : k.room_name === 'Pre-school' ? 'Pre-School' : 'Unassigned',
        age_band_used: bandFirst ? BAND[bandFirst] : null,
        age_band_changes: changeAt ? `${BAND[bandFirst]} → ${BAND[changeAt.band]} from ${ym(changeAt.year, changeAt.month)}` : null,
        days_per_week: days, booking_start: d(k.start_date), booking_end: d(k.end_date),
        funding_type: k.funding_type || null, universal_hours_week: k.universal_hours_week == null ? null : Number(k.universal_hours_week),
        extended_hours_week: k.extended_hours_week == null ? null : Number(k.extended_hours_week),
        day_rate_used_gbp: bandFirst ? gbp(R.dayRate[bandFirst]) : null, day_rate_from: bandFirst ? R.dayRateSource[bandFirst] : null,
        day_rate_after_band_change_gbp: changeAt ? gbp(R.dayRate[changeAt.band]) : null,
        funding_rate_used_gbp_per_hour: bandFirst && funded > 0 ? R.fundRate[bandFirst] / 100 : null,
        funding_rate_from: bandFirst && funded > 0 ? R.fundRateSource[bandFirst] : null,
        weekly_meal_charge_used_gbp: mealOn ? gbp(R.mealWeek[bandFirst]) : 0, meal_charge_from: mealOn ? R.mealWeekSource[bandFirst] : null,
        months_counted: mine.length,
        left_out_because: days <= 0 ? 'no weekdays ticked on the booking' : (!mine.length ? 'booking not live in any month of the horizon' : null) };
    });

    // ── Bookings — the raw child_bookings rows behind it ───────────────────────
    const bookingIds = detail.kids.map(k => Number(k.booking_id));
    const { rows: bk } = await db.query(`
      SELECT id, child_id, room_id, mon, tue, wed, thu, fri, start_date, end_date, funded, source, is_active, session_type,
             start_time, finish_time, repeat_mode, extra_session, exclude_from_funding, created_at, created_by, updated_at, updated_by, notes
        FROM child_bookings WHERE id = ANY($1::int[]) ORDER BY child_id, id`, [bookingIds]);
    const bookings = bk.map(b => { const { notes, child_id, ...rest } = b; const o = { booking_id: b.id, ...who(child_id) };
      for (const [kk, v] of Object.entries(rest)) if (kk !== 'id') o[kk] = v instanceof Date ? (/_at$/.test(kk) ? v.toISOString().slice(0, 16).replace('T', ' ') : d(v)) : v;
      if (names) o.notes = notes || null; return o; });

    // ── Funding — the child_funding rows used, ALLOW-LISTED columns only ───────
    // Identity and reference fields (NI numbers, dates of birth, partner details, eligibility
    // codes, LA references, URNs, declaration tokens) and free-text notes are never selected.
    const FUND_COLS = ['id', 'child_id', 'term_id', 'funding_type', 'stretched_funding', 'pupil_premium', 'deprivation_weighting', 'eypp_eligible',
      'universal_hours_week', 'extended_hours_week', 'total_hours_week', 'termtime_hours_week', 'stretch_weeks', 'weeks_in_term', 'total_hours_term',
      'attended_hours_week', 'funded_hours_week', 'total_funded_hours', 'calculation_type', 'eylog_hours_basis', 'funded_pence', 'parent_paid_pence',
      'source', 'created_at', 'updated_at'];
    const fundIds = detail.kids.map(k => k.funding_id).filter(v => v != null).map(Number);
    const { rows: fr } = await db.query(`
      SELECT ${FUND_COLS.map(c => 'f.' + c).join(', ')}, ft.name AS term_name
        FROM child_funding f LEFT JOIN funding_terms ft ON ft.id = f.term_id
       WHERE f.id = ANY($1::int[]) ORDER BY f.child_id, f.id`, [fundIds]);
    const funding = fr.map(f => { const o = { funding_row_id: f.id, ...who(f.child_id), term: f.term_name || null };
      for (const c of FUND_COLS) if (c !== 'id' && c !== 'child_id') o[c] = f[c] instanceof Date ? f[c].toISOString().slice(0, 16).replace('T', ' ') : f[c];
      return o; });

    // ── Rates — what the report used, and the fee_items / funding_rates rows it read ─
    const { rows: feeItems } = await db.query(`
      SELECT id, code, name, statutory_category, unit, price_pence, age_band, optoutable, effective_from, effective_to, active, source
        FROM fee_items
       WHERE active AND ((statutory_category='additional_paid_hours' AND unit='day' AND price_pence IS NOT NULL)
                      OR (statutory_category='food' AND price_pence IS NOT NULL AND price_pence>0))
       ORDER BY statutory_category, age_band, id`).catch(() => ({ rows: [] }));
    const { rows: fRates } = await db.query(`
      SELECT id, age_band, pence_per_hour, funding_year, provisional, source,
             id = (SELECT r2.id FROM funding_rates r2 WHERE r2.age_band = funding_rates.age_band ORDER BY r2.funding_year DESC LIMIT 1) AS latest_for_band
        FROM funding_rates ORDER BY age_band, funding_year DESC, id`).catch(() => ({ rows: [] }));
    const rateRows = [['Rates the report used'], ['age band', 'day rate (GBP)', 'day rate from', 'funding rate (GBP/hour)', 'funding rate from', 'weekly meal charge (GBP)', 'meal charge from']];
    for (const b of ['under_2', '2yo', '3_4yo']) {
      rateRows.push([BAND[b], gbp(R.dayRate[b]), R.dayRateSource[b], R.fundRate[b] / 100, R.fundRateSource[b],
                     b === 'under_2' ? 'not charged' : gbp(R.mealWeek[b]), b === 'under_2' ? '' : R.mealWeekSource[b]]);
    }
    rateRows.push([], ['"fallback" = no row in the database, so the report used its built-in default (listed on the README).'], [],
                  ['fee_items rows read (active day rates and food prices)']);
    const feeOut = feeItems.map(f => ({ ...f, price_gbp: gbp(f.price_pence), effective_from: d(f.effective_from), effective_to: d(f.effective_to) }));
    if (feeOut.length) { rateRows.push(Object.keys(feeOut[0])); feeOut.forEach(f => rateRows.push(Object.values(f))); } else rateRows.push(['(none)']);
    rateRows.push([], ['funding_rates rows read (the report takes the latest funding_year per age band; funding_rates calls 3-4 year olds "3yo")']);
    if (fRates.length) { rateRows.push(Object.keys(fRates[0]).concat('gbp_per_hour')); fRates.forEach(f => rateRows.push(Object.values(f).concat(Number(f.pence_per_hour) / 100))); }
    else rateRows.push(['(none)']);

    // ── Checks — every tie-out, TRUE/FALSE ─────────────────────────────────────
    const checks = [];
    for (let i = 0; i < N; i++) {
      const mo = report.months[i];
      let catSum = 0;
      for (const b of mo.breakdown) {
        const s = sums.get(i + '|' + b.category) || 0;
        catSum += b.pence;
        checks.push({ check: 'Per child per month adds up to Monthly', month: ym(mo.year, mo.month), category: b.category,
          monthly_gbp: gbp(b.pence), per_child_sum_gbp: gbp(s), difference_pence: s - b.pence, ties_out: s === b.pence });
      }
      checks.push({ check: 'Categories add up to the month total', month: ym(mo.year, mo.month), category: 'ALL',
        monthly_gbp: gbp(mo.total_pence), per_child_sum_gbp: gbp(catSum), difference_pence: catSum - mo.total_pence, ties_out: catSum === mo.total_pence });
    }
    for (const c of CATS) {
      const s = report.months.reduce((t, mo) => t + (mo.breakdown.find(b => b.category === c) || { pence: 0 }).pence, 0);
      checks.push({ check: 'Months add up to the horizon total', month: 'HORIZON', category: c, monthly_gbp: gbp(report.year_totals[c]),
        per_child_sum_gbp: gbp(s), difference_pence: s - report.year_totals[c], ties_out: s === report.year_totals[c] });
    }
    const allPer = [...sums.values()].reduce((t, v) => t + v, 0);
    checks.push({ check: 'Every per-child penny adds up to the report headline total', month: 'HORIZON', category: 'ALL',
      monthly_gbp: gbp(report.headline.total_pence), per_child_sum_gbp: gbp(allPer), difference_pence: allPer - report.headline.total_pence,
      ties_out: allPer === report.headline.total_pence });
    const maxShift = detail.model === 'trailing_average' ? 0 : perChildRows.reduce((m, r) => Math.max(m, Math.abs(Math.round(r.total_gbp * 100) - r.exact_total_pence)), 0);
    checks.push({ check: `Rounding moved no child-month by more than 1p per category (largest move ${maxShift.toFixed(4)}p across ${CATS.length} categories)`,
      month: 'ALL', category: 'ALL', monthly_gbp: null, per_child_sum_gbp: null, difference_pence: null, ties_out: maxShift <= CATS.length });
    const allTrue = checks.every(c => c.ties_out === true);

    // ── Forecast vs the Forecast tab ────────────────────────────────────────────
    const fut = series.months.filter(m => !m.is_actual);
    const lastActual = series.months.filter(m => m.is_actual).slice(-1)[0];
    const FUNDING_CATS = ['Under Two Year Funding', 'Two Year Funding (Working Parents)', 'Two Year Funding (Disadvantaged)', 'Three Year Funding'];
    const B = series._basis || {};
    const vs = [
      ['Forecast (tab) and Forecast report: why they do not match'], [],
      ['They are two different calculations, on purpose. Neither is the bill.'], [],
      ['Forecast tab — GET /api/finance/forecast'],
      ['Past 12 months: what was INVOICED (ladn.invoices by service month) and what was COLLECTED (ladn.payments marked succeeded, by the date the row was created).'],
      [`Future months: one flat figure. It is meant to be "children × average invoice", but it counts invoices with status 'active', and no invoice ever has that status (count here: ${B.invoice_status_active_count ?? 'n/a'}), so it always falls back to the average cash COLLECTED over the last three months of payments: £${(series.summary.monthly_forecast / 100).toFixed(2)} a month.`],
      ['So it is a cash run-rate from history. It does not look at bookings or rates at all.'], [],
      ['Forecast report — GET /api/finance/forecast/report (this workbook)'],
      ['Today\'s active bookings × day rates × 52/12 weeks, plus funded hours × the council rate, plus a meal charge for funded 2s and 3-4s. It counts the council\'s funding as income too, which an invoice to a parent never shows.'],
      ['So it is "what the bookings would earn at list price", from today forward, including the funding Ealing pays.'], [],
      ['The figure that ties to what actually gets billed is neither: it is Invoices & Payments → Income forecast (a preview of the real invoice run). The accountant data pack ties to that one.'], [],
      ['Side by side'],
      ['month', 'Forecast tab: forecast (GBP)', 'Forecast report: total (GBP)', 'of which parents (rooms, meals, unassigned)', 'of which council funding', 'report minus tab (GBP)'],
    ];
    report.months.forEach((mo, i) => {
      const t = fut.find(m => m.year === mo.year && m.month === mo.month);
      const fundP = mo.breakdown.filter(b => FUNDING_CATS.includes(b.category)).reduce((s, b) => s + b.pence, 0);
      vs.push([ym(mo.year, mo.month) + (i === 0 ? ' (latest month)' : ''), t ? gbp(t.forecast_pence) : null, gbp(mo.total_pence),
               gbp(mo.total_pence - fundP), gbp(fundP), t ? gbp(mo.total_pence - t.forecast_pence) : null]);
    });
    if (lastActual) {
      vs.push([], ['Last complete month on the Forecast tab (actuals)'], ['month', 'invoiced (GBP)', 'collected (GBP)', 'funding deducted on invoices (GBP)', 'invoices'],
              [ym(lastActual.year, lastActual.month), gbp(lastActual.invoiced_pence), gbp(lastActual.collected_pence), gbp(lastActual.funding_pence), lastActual.invoice_count]);
    }
    if ((B.cash_months_averaged || []).length) {
      vs.push([], ['The three months of cash the Forecast tab averaged'], ['month', 'collected (GBP)']);
      B.cash_months_averaged.forEach(c => vs.push([ym(c.year, c.month), gbp(c.collected_pence)]));
    }

    // ── README ──────────────────────────────────────────────────────────────────
    const usedFallback = [];
    for (const b of ['under_2', '2yo', '3_4yo']) {
      if (R.dayRateSource[b] === 'fallback') usedFallback.push(`day rate for ${BAND[b]}: £${(R.dayRate[b] / 100).toFixed(2)}`);
      if (R.fundRateSource[b] === 'fallback') usedFallback.push(`funding rate for ${BAND[b]}: £${(R.fundRate[b] / 100).toFixed(2)}/hour`);
    }
    for (const b of ['2yo', '3_4yo']) if (R.mealWeekSource[b] === 'fallback') usedFallback.push(`meal charge for ${BAND[b]}: £${(R.mealWeek[b] / 100).toFixed(2)}/week`);
    const readme = [
      ['Wren — sessions data pack (the data behind Finance (full) → Forecast report)'],
      [`Months covered: ${ym(report.months[0].year, report.months[0].month)} to ${ym(report.months[N - 1].year, report.months[N - 1].month)} (${N} months)`],
      [`Generated: ${report.generated_at.slice(0, 16).replace('T', ' ')} UTC by staff #${req.user && req.user.id}`],
      [names ? 'Names INCLUDED (children only; no parent names anywhere).' : 'Names hidden: children are shown by child_id and the family\'s payment reference (family_ref, e.g. LA-…).'],
      [`Model: ${report.model === 'bottom_up' ? 'bottom-up (bookings × rates)' : 'trailing average — there were no bookings to project from, so every month is the 6-month average invoiced total, under Unassigned'}`],
      [`Checks: ${allTrue ? 'every tie-out is TRUE' : 'AT LEAST ONE TIE-OUT IS FALSE — see Checks'}`], [],
      ['Sheet', 'What it is'],
      ['Monthly', 'Exactly the Forecast report table: one row per month, one column per category, in pounds. Same call, same numbers as the screen.'],
      ['Per child per month', 'Each child\'s share of each category in each month. For every month and category the children add up to Monthly exactly. Pennies: the report adds up unrounded amounts and rounds each category once; here each child\'s amount is rounded so the column still adds up (largest-remainder, never more than 1p per cell). exact_total_pence is the unrounded figure.'],
      ['Children', 'One row per booking the report read: room, the age band it used, days a week, booking dates, funding type and hours, and the day rate, funding rate and weekly meal charge it applied (and where each came from).'],
      ['Bookings', 'The raw child_bookings rows behind it (active bookings of children on roll).' + (names ? '' : ' Booking notes are hidden unless names are included.')],
      ['Funding', 'The child_funding row the report used for each child (the latest term on record). Allow-listed columns only: no identity or reference fields, no notes.'],
      ['Rates', 'The rates the report applied per age band, and the fee_items and funding_rates rows it read.'],
      ['Checks', 'Tie-outs with TRUE/FALSE: per child = Monthly for every month and category; categories = month total; months = horizon total; every penny = the headline.'],
      ['Forecast vs invoices', 'Why the Forecast tab and this report never match, with both sets of figures side by side.'], [],
      ['How the report works'],
      ['For each month, for each active booking that is live that month: gross = day rate × days a week × 52/12.'],
      ['Funded value = (universal + extended funded hours a week) × the council\'s hourly rate × 52/12. It goes to that age band\'s funding stream.'],
      ['Room fee = gross − funded value (never below 0), under Baby Room or Pre-School by the booking\'s room; any other room goes to Unassigned.'],
      ['Meal charge = weekly meal charge × 52/12, for funded 2 year olds and 3-4 year olds only.'],
      ['Age band is worked out each month from the child\'s date of birth, so a birthday can move a child to a new rate and stream part way through.'],
      ['Minimum Booking Fees is always 0: Wren has nothing that feeds it (it is there to match EyLog\'s column list).'], [],
      ['Assumptions'],
      [`WEEKS_PER_MONTH = 52/12 = ${FR.WEEKS_PER_MONTH.toFixed(4)}, every month, term-time or not.`],
      [`Built-in fallback day rates (used only when fee_items has no active day rate for the band): under 2 £${FR.DEFAULT_DAY.under_2 / 100}, 2 year old £${FR.DEFAULT_DAY['2yo'] / 100}, 3-4 year old £${FR.DEFAULT_DAY['3_4yo'] / 100}.`],
      [`Built-in fallback funding rates (used only when funding_rates has no row for the band): under 2 £${(FR.DEFAULT_FUND.under_2 / 100).toFixed(2)}, 2 year old £${(FR.DEFAULT_FUND['2yo'] / 100).toFixed(2)}, 3-4 year old £${(FR.DEFAULT_FUND['3_4yo'] / 100).toFixed(2)} an hour.`],
      [`Built-in fallback meal charge: £${(FR.DEFAULT_MEAL_WEEK_PENCE / 100).toFixed(2)} a week (used when fee_items has no food price).`],
      [usedFallback.length ? `Fallbacks ACTUALLY USED in this pack: ${usedFallback.join('; ')}.` : 'Fallbacks actually used in this pack: none — every rate came from the database.'],
      ['Bookings and funding are assumed to carry on unchanged, apart from booking start and end dates already recorded. No new starters, no leavers, no holidays.'],
      [`Trailing 6-month average invoiced total, for reference: £${(report.headline.trailing_avg_month_pence / 100).toFixed(2)} a month.`], [],
      ['The report\'s own wording, as it appears on screen:'],
      ...report.assumptions.map(a => ['• ' + a]), [],
      ['Money is in pounds (GBP) unless the column says pence. Dates are YYYY-MM-DD. IDs link the sheets together.'],
      ['Demo/test children (Wren test fixtures) are left out of every sheet, exactly as the report leaves them out.'],
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(readme), 'README');
    const add = (name, rows) => XLSX.utils.book_append_sheet(wb, rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([['(no rows)']]), name);
    add('Monthly', monthly);
    add('Per child per month', perChildRows);
    add('Children', children);
    add('Bookings', bookings);
    add('Funding', funding);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rateRows), 'Rates');
    add('Checks', checks);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(vs), 'Forecast vs invoices');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    recordAudit({ req, action: 'export', entity_type: 'finance', entity_id: null,
      meta: { type: 'sessions_data_pack', months: N, names, all_checks_true: allTrue,
              counts: { bookings: bookings.length, funding: funding.length, per_child_rows: perChildRows.length } } });
    const today = d(new Date());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="wren-sessions-data-pack-${today}-${N}m${names ? '-with-names' : ''}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    console.error('[finance-forecast/report/data-pack] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
