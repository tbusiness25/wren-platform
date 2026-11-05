'use strict';
/**
 * b203 — Suggested April fee increase.  (2026-08-19)
 *
 * Toby raises fees each April and wants the evidence assembled by September.  This module
 * assembles it.  It produces a RECOMMENDATION with its workings; nothing here ever writes a
 * fee.  ladn.fee_items is never updated by this code, and the API exposes no path that would —
 * the output is a document to take to a decision, not an action.
 *
 * ── WHY IT IS NOT JUST "MATCH THE MARKET" ───────────────────────────────────────
 * A fee that tracks the local median can still lose money, and a nursery that raises fees
 * because a competitor did has no answer when a parent asks why.  So the recommendation is
 * built from Toby's own numbers first — what the rooms cost to staff, how full they actually
 * are, and how much of the week is funded rather than billable — and the market is used only
 * to bound the answer: it tells you what you can charge, not what you need to.
 *
 * ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────────
 * Every input can be missing, and each missing input is REPORTED rather than defaulted to
 * something convenient.  If the Xero P&L has not been synced there is no non-staff cost line,
 * the model says so in `caveats`, and the recommendation is explicitly flagged as covering
 * staff costs only — which makes it an understatement, not a guess.  A recommendation built
 * on three inputs where five were expected must look like one.
 */

const { getPool } = require('../db/pool');

// Employer on-costs on top of gross pay (NI + pension + levy).  An ASSUMPTION, surfaced as
// one: it appears in the workings and in `caveats`, and the caller can override it.
const DEFAULT_ONCOST_PCT = 18;

// Weeks a full-year place is billed over.  Read from ladn.settings.invoice_calculation_factor
// ("52.00/12.00") so the review and the invoice generator agree; this is only the fallback.
const DEFAULT_WEEKS = 52;

// How much of the gap to the local median to close in one April.  Closing it all in one
// step is how a nursery loses families; the default takes a third and says so.
const MARKET_CATCHUP_SHARE = 1 / 3;

const BANDS = ['under_2', '2yo', '3_4yo'];
const BAND_LABEL = { under_2: 'Under 2s', '2yo': '2 year olds', '3_4yo': '3–4 year olds' };

const round2 = n => Math.round(n * 100) / 100;
const pctRound = n => Math.round(n * 2) / 2;              // nearest 0.5%
const gbp = p => (p == null ? null : round2(p / 100));

/** A child's band on the given date, from date of birth — the same split fee_items uses. */
function bandForAgeMonths(months) {
  if (months == null) return null;
  if (months < 24) return 'under_2';
  if (months < 36) return '2yo';
  return '3_4yo';
}

// ── inputs ───────────────────────────────────────────────────────────────────

/** Our own current day rates, straight from ladn.fee_items. */
async function ourFees(db) {
  const { rows } = await db.query(`
    SELECT code, name, age_band, price_pence, unit, effective_from
    FROM fee_items
    WHERE active = true AND unit = 'day' AND price_pence > 0 AND age_band IS NOT NULL
      AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
    ORDER BY age_band`);
  const byBand = {};
  for (const r of rows) {
    if (!BANDS.includes(r.age_band)) continue;
    byBand[r.age_band] = {
      code: r.code, name: r.name, day_pence: r.price_pence,
      day_gbp: gbp(r.price_pence), effective_from: r.effective_from,
    };
  }
  return byBand;
}

/**
 * Occupancy and the funded/private split, from ladn.child_bookings — Wren's own record of
 * who is expected, rather than the attendance register (which is history, not commitment).
 * Everything is aggregated: no child-level rows leave this function.
 */
async function occupancy(db) {
  const { rows: rooms } = await db.query(`
    SELECT r.id, r.name, r.capacity, r.target_capacity, r.min_age_months, r.max_age_months
    FROM rooms r ORDER BY r.id`);

  const { rows: booked } = await db.query(`
    SELECT cb.room_id,
           CASE WHEN age_months < 24 THEN 'under_2'
                WHEN age_months < 36 THEN '2yo'
                ELSE '3_4yo' END                                  AS age_band,
           COUNT(*)::int                                          AS children,
           SUM(days_wk)::int                                      AS booked_days_week,
           SUM(CASE WHEN cb.funded THEN days_wk ELSE 0 END)::int   AS funded_days_week,
           ROUND(AVG(COALESCE(f.total_hours_week, 0))::numeric, 2) AS avg_funded_hours_week
    FROM (
      SELECT cb.*,
             (cb.mon::int + cb.tue::int + cb.wed::int + cb.thu::int + cb.fri::int) AS days_wk,
             EXTRACT(YEAR FROM age(CURRENT_DATE, c.date_of_birth)) * 12
               + EXTRACT(MONTH FROM age(CURRENT_DATE, c.date_of_birth))            AS age_months
      FROM child_bookings cb
      JOIN children c ON c.id = cb.child_id
      WHERE cb.is_active = true
        AND (cb.end_date IS NULL OR cb.end_date >= CURRENT_DATE)
        AND cb.start_date <= CURRENT_DATE
        AND COALESCE(c.status, 'active') = 'active'
        AND (c.leave_date IS NULL OR c.leave_date >= CURRENT_DATE)
        AND c.date_of_birth IS NOT NULL
        AND COALESCE(c.is_demo, false) = false
    ) cb
    LEFT JOIN LATERAL (
      SELECT total_hours_week FROM child_funding cf
      WHERE cf.child_id = cb.child_id ORDER BY cf.id DESC LIMIT 1
    ) f ON true
    GROUP BY cb.room_id, 2`);

  const byRoom = rooms.map(r => {
    const mine = booked.filter(b => b.room_id === r.id);
    const bookedDays = mine.reduce((s, b) => s + b.booked_days_week, 0);
    const fundedDays = mine.reduce((s, b) => s + b.funded_days_week, 0);
    const capacityDays = (r.capacity || 0) * 5;
    return {
      room_id: r.id, room: r.name,
      capacity: r.capacity, target_capacity: r.target_capacity,
      children: mine.reduce((s, b) => s + b.children, 0),
      booked_days_week: bookedDays,
      capacity_days_week: capacityDays,
      occupancy_pct: capacityDays ? round2((bookedDays / capacityDays) * 100) : null,
      funded_days_week: fundedDays,
      funded_share_pct: bookedDays ? round2((fundedDays / bookedDays) * 100) : null,
      bands: mine.map(b => ({
        age_band: b.age_band, label: BAND_LABEL[b.age_band] || b.age_band,
        children: b.children, booked_days_week: b.booked_days_week,
        avg_funded_hours_week: Number(b.avg_funded_hours_week) || 0,
      })),
    };
  });

  const totalBooked = byRoom.reduce((s, r) => s + r.booked_days_week, 0);
  const totalCap    = byRoom.reduce((s, r) => s + r.capacity_days_week, 0);
  return {
    rooms: byRoom,
    total_booked_days_week: totalBooked,
    total_capacity_days_week: totalCap,
    overall_occupancy_pct: totalCap ? round2((totalBooked / totalCap) * 100) : null,
    source: 'child_bookings (active bookings as at today) × children date_of_birth',
  };
}

/**
 * Staff cost.  Rota is the truth where it exists (it is what actually got worked); contracted
 * hours are the fallback, and which one was used is reported so the number is never mistaken
 * for something firmer than it is.
 */
async function staffCost(db, { oncostPct }) {
  const { rows: [rota] } = await db.query(`
    SELECT COALESCE(SUM(
             (EXTRACT(EPOCH FROM (rs.planned_end - rs.planned_start)) / 3600
              - COALESCE(rs.break_mins, 0) / 60.0)
             * COALESCE(s.hourly_rate, 0)), 0)                     AS pay,
           COUNT(DISTINCT rs.shift_date)::int                      AS days_covered,
           COUNT(*)::int                                           AS shifts
    FROM rota_shifts rs
    JOIN staff s ON s.id = rs.staff_id
    WHERE rs.shift_date >= CURRENT_DATE - INTERVAL '12 weeks'
      AND rs.shift_date <  CURRENT_DATE
      AND COALESCE(rs.is_absent, false) = false
      AND rs.planned_start IS NOT NULL AND rs.planned_end IS NOT NULL`);

  const { rows: [contract] } = await db.query(`
    SELECT COALESCE(SUM(COALESCE(s.hours_per_week, s.contracted_hours, 0) * COALESCE(s.hourly_rate, 0)), 0) AS weekly_pay,
           COUNT(*) FILTER (WHERE s.hourly_rate IS NOT NULL)::int AS staff_with_rate,
           COUNT(*)::int AS staff_total
    FROM staff s
    WHERE s.is_active = true AND COALESCE(s.role, '') <> 'parent'`);

  const rotaWeeks   = rota.days_covered ? rota.days_covered / 5 : 0;
  const rotaWeekly  = rotaWeeks >= 4 ? Number(rota.pay) / rotaWeeks : null;   // need a month+ to mean anything
  const contractWeekly = Number(contract.weekly_pay) || 0;

  const basis = rotaWeekly != null ? 'rota_shifts (last 12 weeks, actual rostered hours)'
                                   : 'staff contracted hours × hourly_rate (no usable rota history)';
  const weeklyGross = rotaWeekly != null ? rotaWeekly : contractWeekly;
  const weeklyTotal = weeklyGross * (1 + oncostPct / 100);

  return {
    basis,
    weekly_gross_pence:  Math.round(weeklyGross * 100),
    weekly_total_pence:  Math.round(weeklyTotal * 100),
    annual_total_pence:  Math.round(weeklyTotal * 52 * 100),
    oncost_pct: oncostPct,
    staff_total: contract.staff_total,
    staff_with_rate: contract.staff_with_rate,
    rota_weeks_sampled: round2(rotaWeeks),
    contracted_weekly_pence: Math.round(contractWeekly * 100),
    available: weeklyGross > 0,
  };
}

/**
 * Non-staff cost from the Xero P&L (ladn.finance_monthly_balances, filled by the Xero sync).
 * Deliberately returns { available:false } rather than an estimate when nothing has synced —
 * an invented overhead line would change the recommended percentage, and a fee decision is
 * not a place for a plausible-looking placeholder.
 */
async function nonStaffCost(db, { year }) {
  const { rows } = await db.query(`
    SELECT fa.name, fa.code, SUM(mb.amount) AS total, COUNT(DISTINCT mb.month)::int AS months
    FROM finance_monthly_balances mb
    JOIN finance_accounts fa ON fa.id = mb.account_id
    JOIN finance_providers fp ON fp.id = mb.provider_id
    WHERE fp.is_active = true AND mb.year = $1
      AND (fa.type = 'EXPENSE' OR fa.class = 'EXPENSE')
      AND NOT (fa.name ILIKE '%wage%' OR fa.name ILIKE '%salar%' OR fa.name ILIKE '%payroll%'
               OR fa.name ILIKE '%staff cost%' OR fa.name ILIKE '%pension%'
               OR fa.name ILIKE '%national insurance%')
    GROUP BY fa.name, fa.code
    ORDER BY SUM(mb.amount) DESC`, [year]);

  if (!rows.length) {
    return {
      available: false,
      reason: `No Xero P&L rows for ${year} in finance_monthly_balances. Run the Xero sync ` +
              `(Finance → Reconcile → Sync from Xero) to bring rent, food, utilities and insurance ` +
              `into this review. Until then the recommendation reflects STAFF cost pressure only, ` +
              `which understates the true pressure.`,
      annual_total_pence: null, lines: [],
    };
  }

  const monthsSeen = Math.max(...rows.map(r => r.months), 1);
  const total = rows.reduce((s, r) => s + Number(r.total || 0), 0);
  return {
    available: true,
    months_seen: monthsSeen,
    annual_total_pence: Math.round((total / monthsSeen) * 12 * 100),
    lines: rows.slice(0, 12).map(r => ({
      account: r.name, code: r.code,
      annual_pence: Math.round((Number(r.total) / r.months) * 12 * 100),
    })),
    note: `Annualised from ${monthsSeen} month(s) of ${year} Xero data.`,
  };
}

/**
 * The local market, from the latest completed fee scrape.  Only standard (unfunded) rates
 * with an honest per-day equivalent are used — funded rates depend on each family's
 * entitlement and are not comparable between providers, and a fee whose per-day conversion
 * we refused to make must not sneak into a median.
 */
async function market(db) {
  const { rows: [run] } = await db.query(
    `SELECT * FROM competitor_fee_runs WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`);
  if (!run) return { available: false, reason: 'No completed fee scrape yet — run one from the Fees tab.', bands: {} };

  // The LATEST KNOWN price per price point, not "everything in the newest run".  Two reasons,
  // both of which bit in testing: a manually entered fee creates its own one-row run, and a
  // site that was unreachable this Monday still has a perfectly good price from last Monday.
  // Keying off a single run threw away both. Each figure carries the date it was read, so a
  // stale one is visible rather than silently passed off as current.
  const { rows } = await db.query(`
    SELECT DISTINCT ON (provider_key, age_band, room_label, session_type, days_per_week)
           provider, provider_key, age_band, room_label, session_type, days_per_week,
           fee_pence, period, day_equiv_pence, confidence, source_quote, url, scraped_at
    FROM competitor_fees
    WHERE funding_basis = 'standard'
      AND day_equiv_pence IS NOT NULL AND confidence IN ('high', 'medium')
      AND session_type NOT IN ('registration', 'deposit', 'consumables', 'late_fee', 'funding_offset')
      AND scraped_at >= now() - INTERVAL '120 days'
    ORDER BY provider_key, age_band, room_label, session_type, days_per_week, scraped_at DESC`);

  const bands = {};
  for (const band of BANDS) {
    // A provider quoting one rate for the whole 2–5 range ('over_2') counts in both the 2yo
    // and 3–4 columns — that IS the price a parent of either age is quoted there.
    const relevant = rows.filter(r => r.age_band === band || (r.age_band === 'over_2' && band !== 'under_2'));

    // One figure per provider: their cheapest full-week day rate, which is what a full-time
    // parent actually pays. Taking every row would let a provider with a nine-row fee table
    // outvote one with a single published rate.
    const perProvider = {};
    for (const r of relevant) {
      const cur = perProvider[r.provider_key];
      // Deterministic, and defensible: prefer a headline full-day rate, then the fullest
      // week, then the LOWEST per-day figure — that is the price a parent ringing round is
      // quoted, and picking whichever row happened to come back first is not a basis for a
      // median that feeds a fee decision.
      const rank = x => [x.session_type === 'full_day' ? 0 : 1, -(x.days_per_week || 0), x.day_equiv_pence];
      if (!cur) { perProvider[r.provider_key] = r; continue; }
      const [a, b] = [rank(r), rank(cur)];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        if (a[i] < b[i]) perProvider[r.provider_key] = r;
        break;
      }
    }
    const list = Object.values(perProvider)
      .map(r => ({
        provider: r.provider, provider_key: r.provider_key,
        day_pence: r.day_equiv_pence, day_gbp: gbp(r.day_equiv_pence),
        basis: r.session_type + (r.days_per_week ? ` (${r.days_per_week} days/wk)` : ''),
        room_label: r.room_label,
        quoted_for: r.age_band === 'over_2' ? 'provider quotes one rate for 2–5s' : null,
        // A term-time maintained-school nursery is a real local alternative for a parent, so
        // it belongs in the comparison — but it is not like-for-like with a full-year private
        // place, and a median that hides that invites the wrong conclusion.
        // b299 — the week count comes from DEFAULT_WEEKS rather than being typed into the
        // sentence. It said 51 for six weeks after the constant said 52.
        not_like_for_like: /term-time/i.test(r.room_label || '')
          ? `term-time only (maintained school) — not a ${DEFAULT_WEEKS}-week private place` : null,
        confidence: r.confidence, source_quote: r.source_quote, url: r.url,
        read_on: r.scraped_at,
        stale: (Date.now() - new Date(r.scraped_at).getTime()) > 45 * 86400000
          ? 'last read over six weeks ago — the provider may have changed it since' : null,
      }))
      .sort((a, b) => a.day_pence - b.day_pence);

    const vals = list.map(x => x.day_pence);
    const median = vals.length
      ? (vals.length % 2 ? vals[(vals.length - 1) / 2]
                         : Math.round((vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2))
      : null;
    bands[band] = {
      label: BAND_LABEL[band], providers: list, n: list.length,
      median_day_pence: median, median_day_gbp: gbp(median),
      min_day_pence: vals[0] ?? null, max_day_pence: vals[vals.length - 1] ?? null,
    };
  }

  return {
    available: true,
    run_id: run.id, scraped_at: run.started_at,
    sources_parsed: run.sources_parsed, sources_unreadable: run.sources_unreadable,
    bands,
    note: 'Latest known standard (unfunded) rate per provider, read within the last 120 days and converted ' +
          'to a per-day equivalent using each provider\'s own stated weeks/year factor. Providers whose fee ' +
          'could not be converted honestly are excluded from the median; each row shows when it was read.',
  };
}

async function benchmarks(db) {
  const { rows } = await db.query(
    `SELECT scope, scope_label, metric, label, age_band, value_pence, period, as_of, source_name, source_url, note
     FROM fee_benchmarks ORDER BY scope, scope_label, metric`);
  return rows.map(r => ({ ...r, value_gbp: gbp(r.value_pence) }));
}

// ── the recommendation ───────────────────────────────────────────────────────

/**
 * Build the whole review.  Returns inputs, workings and recommendation as three separate
 * objects so the export can show its arithmetic — the recommendation on its own is worth
 * very little to a decision.
 */
async function buildFeeReview({
  reviewYear = new Date().getFullYear() + 1,
  oncostPct = DEFAULT_ONCOST_PCT,
  wageInflationPct = null,      // null → fall back to the cited LA-funding-uplift proxy
  maxIncreasePct = 10,
} = {}) {
  const db = getPool();

  const [fees, occ, staff, marketData, bench] = await Promise.all([
    ourFees(db), occupancy(db), staffCost(db, { oncostPct }), market(db), benchmarks(db),
  ]);
  const nonStaff = await nonStaffCost(db, { year: reviewYear - 1 });

  const { rows: [factorRow] } = await db.query(
    `SELECT value FROM settings WHERE key = 'invoice_calculation_factor' LIMIT 1`);
  const factorM = /^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/.exec(String(factorRow?.value || ''));
  const billedWeeks = factorM ? parseFloat(factorM[1]) : DEFAULT_WEEKS;

  const caveats = [];

  // Wage inflation. There is no way to derive next April's pay award from our own data, so
  // it is an input. Its default is the Ealing 3–4s LA funding uplift already in
  // fee_benchmarks — a cited, local, published number rather than a made-up one — and it is
  // labelled as a proxy everywhere it appears.
  let wageInflation = wageInflationPct;
  let wageInflationSource;
  if (wageInflation == null) {
    const note = bench.find(b => b.metric === 'la_funding_rate_3_4yo')?.note || '';
    const m = /up ([\d.]+)%/.exec(note);
    wageInflation = m ? parseFloat(m[1]) : 4.5;
    wageInflationSource = `PROXY — Ealing's 2026-27 LA funding uplift for 3–4s (${wageInflation}%), used as a stand-in for next April's staff-cost inflation. Replace it with your actual expected pay award.`;
    caveats.push(wageInflationSource);
  } else {
    wageInflationSource = `Set by you: ${wageInflation}% expected staff-cost inflation.`;
  }

  if (!staff.available) caveats.push('No usable staff cost: neither the rota nor staff hourly rates are populated. The cost side of this review is empty — treat the market column as the only evidence here.');
  if (staff.staff_with_rate < staff.staff_total) {
    caveats.push(`${staff.staff_total - staff.staff_with_rate} of ${staff.staff_total} active staff have no hourly rate on record, so the wage bill is understated.`);
  }
  if (!nonStaff.available) caveats.push(nonStaff.reason);
  if (!marketData.available) caveats.push(marketData.reason);
  else if (marketData.sources_unreadable) {
    caveats.push(`${marketData.sources_unreadable} of the tracked fee sources could not be read in the latest scrape (gated, unreachable or not published) — the local median is built from the ${marketData.sources_parsed} that could.`);
  }
  if (occ.total_booked_days_week === 0) caveats.push('No active child bookings — occupancy and revenue cannot be computed.');

  // ── revenue at CURRENT occupancy, per band ───────────────────────────────
  // Funded days earn the LA rate, not our day rate. Ignoring that is the mistake that makes
  // a nursery think a 3–4 room is profitable when the entitlement is covering most of it.
  const laRate = {
    under_2: bench.find(b => b.metric === 'la_funding_rate_under2')?.value_pence || null,
    '2yo':   bench.find(b => b.metric === 'la_funding_rate_2yo')?.value_pence || null,
    '3_4yo': bench.find(b => b.metric === 'la_funding_rate_3_4yo')?.value_pence || null,
  };
  const { rows: [hoursRow] } = await db.query(
    `SELECT value FROM settings WHERE key = 'invoice_session_hours' LIMIT 1`);
  const sessionHours = parseFloat(hoursRow?.value) || 10;   // a full day at LADN is 8am–6pm

  const bandRevenue = {};
  for (const band of BANDS) {
    const rooms = occ.rooms.filter(r => r.bands.some(b => b.age_band === band));
    const bookedDays = rooms.reduce((s, r) =>
      s + (r.bands.find(b => b.age_band === band)?.booked_days_week || 0), 0);
    const children = rooms.reduce((s, r) =>
      s + (r.bands.find(b => b.age_band === band)?.children || 0), 0);
    const avgFundedHrs = rooms.length
      ? rooms.reduce((s, r) => s + (r.bands.find(b => b.age_band === band)?.avg_funded_hours_week || 0), 0) / rooms.length
      : 0;

    const dayPence = fees[band]?.day_pence || null;
    const grossWeekly = dayPence ? dayPence * bookedDays : null;
    // Funded hours displace private billing at our own day rate, and are replaced by the LA
    // hourly rate. Both halves are shown so the swap is visible.
    const fundedHoursWeekly = avgFundedHrs * children;
    const fundedDisplacedPence = dayPence ? Math.round((dayPence / sessionHours) * fundedHoursWeekly) : null;
    const fundedIncomePence = laRate[band] ? Math.round(laRate[band] * fundedHoursWeekly) : null;

    bandRevenue[band] = {
      label: BAND_LABEL[band], children, booked_days_week: bookedDays,
      our_day_pence: dayPence, our_day_gbp: gbp(dayPence),
      gross_weekly_pence: grossWeekly,
      funded_hours_week: round2(fundedHoursWeekly),
      funded_displaced_weekly_pence: fundedDisplacedPence,
      funded_income_weekly_pence: fundedIncomePence,
      net_weekly_pence: grossWeekly == null ? null
        : grossWeekly - (fundedDisplacedPence || 0) + (fundedIncomePence || 0),
      la_hourly_pence: laRate[band],
    };
  }

  const totalNetWeekly = BANDS.reduce((s, b) => s + (bandRevenue[b].net_weekly_pence || 0), 0);
  const totalCostWeekly = (staff.weekly_total_pence || 0)
    + (nonStaff.available ? Math.round(nonStaff.annual_total_pence / 52) : 0);

  // ── per-band recommendation ──────────────────────────────────────────────
  const staffShareOfRevenue = totalNetWeekly ? staff.weekly_total_pence / totalNetWeekly : null;
  // A wage bill above fee income is possible but rare; far more often it means bookings are
  // incomplete or staff hours are over-stated. Say which, rather than letting the reader
  // discover a -24% margin at the bottom of a page and lose faith in the whole review.
  if (staffShareOfRevenue != null && staffShareOfRevenue > 1) {
    caveats.push(
      `IMPLAUSIBLE INPUT: the staff bill (£${gbp(staff.weekly_total_pence)}/wk) is larger than net fee ` +
      `income (£${gbp(totalNetWeekly)}/wk) — ${Math.round(staffShareOfRevenue * 100)}% of revenue. Check that ` +
      `child_bookings holds every current booking and that staff hours are current before ` +
      `relying on the margin figures; the per-band cost-pressure percentages inherit this error.`);
  }

  const recommendation = BANDS.map(band => {
    const rev = bandRevenue[band];
    const mkt = marketData.available ? marketData.bands[band] : null;
    const reasoning = [];

    // 1. Cost pressure — the increase needed just to stand still. A W% rise on a wage bill
    //    that is S of revenue needs W×S on fees to hold the same £ margin.
    let costPressure = null;
    if (staffShareOfRevenue != null && staff.available) {
      costPressure = wageInflation * staffShareOfRevenue;
      reasoning.push(
        `Cost: staff cost is ${Math.round(staffShareOfRevenue * 100)}% of net fee income ` +
        `(£${gbp(staff.weekly_total_pence)}/wk incl. ${oncostPct}% employer on-costs against ` +
        `£${gbp(totalNetWeekly)}/wk). A ${wageInflation}% pay award therefore needs ` +
        `${round2(costPressure)}% on fees just to hold the current margin.`);
      if (!nonStaff.available) {
        reasoning.push('Cost: non-staff overheads (rent, food, utilities, insurance) are NOT in this figure — no Xero P&L has been synced — so the real cost pressure is higher than the number above.');
      }
    } else {
      reasoning.push('Cost: not computed — no usable staff-cost or revenue figure.');
    }

    // 2. Market position.
    let marketHeadroom = null;
    if (mkt && mkt.median_day_pence && rev.our_day_pence) {
      const gap = mkt.median_day_pence - rev.our_day_pence;
      marketHeadroom = (gap / rev.our_day_pence) * 100;
      reasoning.push(
        `Market: we charge £${rev.our_day_gbp}/day; the local median of ${mkt.n} published ` +
        `rate(s) is £${mkt.median_day_gbp} (range £${gbp(mkt.min_day_pence)}–£${gbp(mkt.max_day_pence)}). ` +
        `That is a gap of £${round2(gap / 100)} (${round2(marketHeadroom)}%) ` +
        `${gap > 0 ? 'BELOW' : 'ABOVE'} the local median.`);
    } else {
      reasoning.push('Market: no comparable published local rate for this band in the latest scrape.');
    }

    // 3. Occupancy — a full room can take an increase; a half-empty one cannot.
    const roomsForBand = occ.rooms.filter(r => r.bands.some(b => b.age_band === band));
    const occPct = roomsForBand.length
      ? round2(roomsForBand.reduce((s, r) => s + (r.occupancy_pct || 0), 0) / roomsForBand.length)
      : null;
    if (occPct != null) {
      reasoning.push(
        `Occupancy: ${roomsForBand.map(r => `${r.room} ${r.occupancy_pct}%`).join(', ')}. ` +
        (occPct >= 85 ? 'Close to full — an increase carries little volume risk.'
         : occPct >= 65 ? 'Reasonably full, but there are empty days — a large rise risks losing them.'
         : 'Well below capacity. Raising fees here is the wrong lever; the gap is volume, not price.'));
    }

    // 4. Funded mix — the part of the week a fee increase does not touch.
    if (rev.funded_hours_week > 0 && rev.booked_days_week) {
      const fundedShare = (rev.funded_hours_week / (rev.booked_days_week * sessionHours)) * 100;
      reasoning.push(
        `Funded mix: about ${Math.round(fundedShare)}% of this band's booked hours are funded ` +
        `at Ealing's £${gbp(rev.la_hourly_pence)}/hr, which a fee rise does not touch. ` +
        `A ${band === '3_4yo' ? '3–4' : band} increase therefore lands on the remaining ` +
        `${Math.round(100 - fundedShare)}% of hours, so its effect on income is diluted by roughly that much.`);
    }

    // Blend: cover the cost, then move a third of the way to the median if there is room.
    let suggested = costPressure ?? 0;
    if (marketHeadroom != null && marketHeadroom > 0) {
      suggested += marketHeadroom * MARKET_CATCHUP_SHARE;
      reasoning.push(`Blend: cost pressure ${round2(costPressure ?? 0)}% + one third of the ${round2(marketHeadroom)}% gap to the local median.`);
    } else if (marketHeadroom != null && marketHeadroom < 0) {
      reasoning.push(`Blend: we are already above the local median, so no market catch-up is added — the suggestion covers cost pressure only.`);
    }
    if (occPct != null && occPct < 65) {
      suggested = Math.min(suggested, costPressure ?? 0);
      reasoning.push('Blend: capped at cost pressure because the room is under 65% full.');
      if (marketHeadroom != null && marketHeadroom < 0) {
        reasoning.push(
          'WARNING: this band is already priced ABOVE the local median AND the room has empty ' +
          'days. An increase here makes the cheapest local alternative cheaper still. Before ' +
          'taking this number, decide whether the answer is a smaller rise plus filling the ' +
          'empty days, or a rise funded by a cost change rather than by parents.');
      }
    }
    suggested = Math.max(0, Math.min(maxIncreasePct, suggested));
    const suggestedPct = pctRound(suggested);

    const newDay = rev.our_day_pence ? Math.round(rev.our_day_pence * (1 + suggestedPct / 100)) : null;
    const extraWeekly = rev.our_day_pence && rev.booked_days_week
      ? Math.round((newDay - rev.our_day_pence) * rev.booked_days_week) : null;

    return {
      age_band: band, label: BAND_LABEL[band],
      current_day_pence: rev.our_day_pence, current_day_gbp: gbp(rev.our_day_pence),
      suggested_pct: suggestedPct,
      suggested_day_pence: newDay, suggested_day_gbp: gbp(newDay),
      cost_pressure_pct: costPressure == null ? null : round2(costPressure),
      market_headroom_pct: marketHeadroom == null ? null : round2(marketHeadroom),
      occupancy_pct: occPct,
      extra_weekly_pence: extraWeekly,
      extra_annual_pence: extraWeekly == null ? null : Math.round(extraWeekly * billedWeeks),
      local_median_day_gbp: mkt?.median_day_gbp ?? null,
      reasoning,
    };
  });

  // ── what it does to the margin at CURRENT occupancy ──────────────────────
  const extraWeekly = recommendation.reduce((s, r) => s + (r.extra_weekly_pence || 0), 0);
  const marginNow   = totalNetWeekly ? (totalNetWeekly - totalCostWeekly) / totalNetWeekly * 100 : null;
  // Costs rise too — that is the whole point of the exercise.
  const costAfter   = Math.round(staff.weekly_total_pence * (1 + wageInflation / 100))
                    + (nonStaff.available ? Math.round(nonStaff.annual_total_pence / 52) : 0);
  const revAfter    = totalNetWeekly + extraWeekly;
  const marginAfter = revAfter ? (revAfter - costAfter) / revAfter * 100 : null;

  return {
    meta: {
      review_year: reviewYear,
      generated_at: new Date().toISOString(),
      billed_weeks_per_year: billedWeeks,
      session_hours_per_day: sessionHours,
      wage_inflation_pct: wageInflation,
      wage_inflation_source: wageInflationSource,
      oncost_pct: oncostPct,
      market_catchup_share: MARKET_CATCHUP_SHARE,
      max_increase_pct: maxIncreasePct,
      disclaimer: 'A recommendation with its workings. Wren never applies a fee change — fee_items is not written by this review.',
    },
    inputs: { our_fees: fees, occupancy: occ, staff_cost: staff, non_staff_cost: nonStaff, market: marketData, benchmarks: bench },
    workings: {
      band_revenue: bandRevenue,
      total_net_weekly_pence: totalNetWeekly,
      total_cost_weekly_pence: totalCostWeekly,
      staff_share_of_revenue_pct: staffShareOfRevenue == null ? null : round2(staffShareOfRevenue * 100),
      margin_now_pct: marginNow == null ? null : round2(marginNow),
      margin_after_pct: marginAfter == null ? null : round2(marginAfter),
      extra_weekly_pence: extraWeekly,
      extra_annual_pence: Math.round(extraWeekly * billedWeeks),
      cost_after_weekly_pence: costAfter,
      revenue_after_weekly_pence: revAfter,
    },
    recommendation,
    caveats,
  };
}

module.exports = { buildFeeReview, ourFees, occupancy, market, benchmarks,
                   BANDS, BAND_LABEL, DEFAULT_ONCOST_PCT, MARKET_CATCHUP_SHARE };
