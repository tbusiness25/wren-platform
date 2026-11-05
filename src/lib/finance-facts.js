'use strict';
/**
 * finance-facts.js — b204 (2026-08-19)
 *
 * The financial intelligence layer. Turns the Xero accounting reports pulled by
 * src/lib/xero-reports.js into figures the manager (and the Roost assistant) can
 * actually reason with: revenue and cost per month, staff cost as a share of
 * income, cost per child, the occupancy needed to break even or to hit a target
 * margin, what a change in establishment does to margin, what a fee rise would
 * raise, which suppliers are climbing faster than income, and who owes what.
 *
 * It is built on the same pattern as buildLiveFacts() in src/routes/assistant.js
 * (b164): deterministic SQL, computed at question time, handed to the model as a
 * block it is told to prefer over anything it retrieved. buildFinancialFacts()
 * is the entry point for that.
 *
 * ── THE FOUR RULES THIS FILE EXISTS TO ENFORCE ──────────────────────────────
 *  1. TRACEABLE. Every figure carries the period it came from and the source it
 *     was read from. `period_label` is Xero's own wording where the figure came
 *     from a Xero report. Nothing is returned without one.
 *  2. NEVER FILL A GAP. A month that has not synced is reported in `gaps` and
 *     excluded from every average. There is no interpolation, no carry-forward,
 *     no "assume last month". A partial month (Xero was last updated before the
 *     month ended) is labelled partial and kept OUT of the averages too.
 *  3. IT ADVISES. Nothing here writes an invoice, a payment, a fee or a rota.
 *     Every function returns numbers and workings; the recommendation text is
 *     phrased as a scenario for a person to decide on.
 *  4. NO ONE IS NAMED IN A STAFFING SCENARIO. staffingScenario() deals in
 *     whole-establishment averages — FTE, average cost per FTE, margin effect.
 *     It cannot name an individual because it never selects one.
 *
 * MANAGER-ONLY. Everything here is commercially sensitive. The only callers are
 * src/routes/finance-intel.js (manager + admin portal, enforced server-side) and
 * the Roost assistant, which is already manager-only. It must never be reachable
 * from the EY, Parents or HR portals.
 */

const { getPool } = require('../db/pool');

// ── classification ───────────────────────────────────────────────────────────
// Which P&L lines are income, which are the wage bill, and which are everything
// else. Deliberately explicit rather than clever: a mis-classified line changes
// "staff cost as a % of revenue", which is the number most likely to drive a
// decision about a real person's job.
const REVENUE_SECTION_RX = /income|revenue|turnover|sales/i;
const EXPENSE_SECTION_RX = /expense|cost of sales|overhead|admin/i;

// The wage bill: gross pay, employer's on-costs and anything bought instead of
// them (agency). Training is a staff cost in the everyday sense but it is not
// establishment cost — it stays in "other" so the ratio means what it says.
const STAFF_COST_RX = /salar|wages?|payroll|pension|national insurance|employer'?s? ni\b|\bni contrib|staff cost|agency|apprenticeship levy/i;

// Excluded from operating cost: below-the-line items that do not move with how
// the nursery is run this month. Reported separately, never silently dropped.
const TAX_RX          = /corporation tax|\btax\b/i;
const NON_OPERATING_RX = /depreciation|amortisation|interest paid|interest expense/i;

const round2 = n => (n == null ? null : Math.round(n * 100) / 100);
const gbp    = p => (p == null ? null : round2(Number(p) / 100));
const pct    = (a, b) => (!b ? null : round2((Number(a) / Number(b)) * 100));
const num    = v => (v == null ? 0 : Number(v));

/** What kind of P&L line is this? Returns revenue | staff | other | tax | non_operating. */
function classifyLine(section, accountName) {
  const s = String(section || '');
  const a = String(accountName || '');
  if (REVENUE_SECTION_RX.test(s) && !EXPENSE_SECTION_RX.test(s)) return 'revenue';
  if (TAX_RX.test(a)) return 'tax';
  if (STAFF_COST_RX.test(a)) return 'staff';
  if (NON_OPERATING_RX.test(a)) return 'non_operating';
  return 'other';
}

// A month is only usable if Xero had been updated AFTER the month ended —
// otherwise we are looking at a month that was still being posted to.
function partialReason(period) {
  if (period.is_partial) return period.partial_reason || 'marked partial at sync time';
  const updated = period.xero_updated_at ? new Date(period.xero_updated_at) : null;
  if (updated && updated < new Date(period.period_to + 'T23:59:59Z')) {
    return `Xero data for this period was last updated ${updated.toISOString().slice(0, 10)}, `
         + `before the period ended (${period.period_to}) — the month is incomplete`;
  }
  return null;
}

// ── the periods ──────────────────────────────────────────────────────────────
/**
 * Every P&L period we hold, newest first, with its lines rolled up. One row per
 * calendar month; where the same month exists from more than one source the
 * Xero report itself wins over the derived monthly-balance backfill, and which
 * one was used is stated on the row.
 */
async function pnlPeriods(db, { limit = 15 } = {}) {
  const { rows } = await db.query(`
    SELECT p.id, p.report_type, p.period_from, p.period_to, p.period_label, p.source,
           p.xero_updated_at, p.synced_at,
           COALESCE(p.is_partial, false) AS is_partial, p.partial_reason,
           l.section, l.account_name, l.row_type, l.amount_pence
      FROM finance_pnl_periods p
      LEFT JOIN finance_pnl_lines l ON l.period_id = p.id
     WHERE p.report_type = 'pnl'
     ORDER BY p.period_to DESC, p.id DESC
  `).catch(() => ({ rows: [] }));

  const byPeriod = new Map();
  for (const r of rows) {
    if (!byPeriod.has(r.id)) {
      byPeriod.set(r.id, {
        id: r.id,
        period_from: r.period_from instanceof Date ? r.period_from.toISOString().slice(0, 10) : r.period_from,
        period_to:   r.period_to   instanceof Date ? r.period_to.toISOString().slice(0, 10)   : r.period_to,
        period_label: r.period_label, source: r.source,
        xero_updated_at: r.xero_updated_at, synced_at: r.synced_at,
        is_partial: r.is_partial, partial_reason: r.partial_reason,
        revenue_pence: 0, staff_pence: 0, other_pence: 0, tax_pence: 0, non_operating_pence: 0,
        lines: [],
      });
    }
    const p = byPeriod.get(r.id);
    // SummaryRows are Xero's own totals — keeping them would double-count.
    if (!r.account_name || r.row_type === 'SummaryRow') continue;
    const kind = classifyLine(r.section, r.account_name);
    const amt = num(r.amount_pence);
    if (kind === 'revenue')            p.revenue_pence += amt;
    else if (kind === 'staff')         p.staff_pence += amt;
    else if (kind === 'tax')           p.tax_pence += amt;
    else if (kind === 'non_operating') p.non_operating_pence += amt;
    else                               p.other_pence += amt;
    p.lines.push({ section: r.section, account: r.account_name, kind, amount_pence: amt });
  }

  // One period per month — the real report beats the derived backfill.
  const rank = src => (src === 'xero' ? 0 : src === 'xero-monthly-balances' ? 1 : 2);
  const byMonth = new Map();
  for (const p of byPeriod.values()) {
    const key = String(p.period_to).slice(0, 7);
    const cur = byMonth.get(key);
    if (!cur || rank(p.source) < rank(cur.source)) byMonth.set(key, p);
  }

  const out = [...byMonth.values()]
    .sort((a, b) => (a.period_to < b.period_to ? 1 : -1))
    .slice(0, limit)
    .map(p => {
      const operating_cost = p.staff_pence + p.other_pence;
      const total_cost = operating_cost + p.non_operating_pence;
      const reason = partialReason(p);
      return {
        ...p,
        month: String(p.period_to).slice(0, 7),
        operating_cost_pence: operating_cost,
        total_cost_pence: total_cost,
        net_pence: p.revenue_pence - total_cost,
        operating_net_pence: p.revenue_pence - operating_cost,
        margin_pct: pct(p.revenue_pence - total_cost, p.revenue_pence),
        staff_share_pct: pct(p.staff_pence, p.revenue_pence),
        usable: !reason && p.revenue_pence > 0,
        partial: reason,
        // The label often already names the source (the backfill writes it in);
        // appending it again produced a citation that read like a stutter.
        cite: p.period_label && /xero/i.test(p.period_label)
          ? p.period_label
          : `${p.period_label || `${p.period_from} to ${p.period_to}`} (${sourceLabel(p.source)})`,
      };
    });
  return out;
}

function sourceLabel(source) {
  if (source === 'xero') return 'Xero Profit & Loss report';
  if (source === 'xero-monthly-balances') return 'derived from Xero monthly account balances — not a Xero P&L report';
  return source || 'unknown source';
}

/**
 * Months with NO row at all — both holes in the middle of the history and, just
 * as importantly, the months since the last sync. A nursery asking "how are we
 * doing" in August needs to be told August has not synced, not handed June and
 * left to assume it is current. Reported so the assistant can say "no data for
 * August" instead of averaging around it and calling the result a trend.
 *
 * @param periods newest-first list from pnlPeriods()
 * @param upTo    'YYYY-MM' to scan to; defaults to the current month
 */
function missingMonths(periods, { upTo = new Date().toISOString().slice(0, 7) } = {}) {
  if (!periods.length) return [];
  const have = new Set(periods.map(p => p.month));
  const oldest = periods[periods.length - 1].month;
  const end = upTo > periods[0].month ? upTo : periods[0].month;
  const out = [];
  let [y, m] = oldest.split('-').map(Number);
  while (`${y}-${String(m).padStart(2, '0')}` <= end) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (!have.has(key)) out.push(key);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// ── occupancy / children ─────────────────────────────────────────────────────
// Reuses the b203 fee-review occupancy model so the fee review and the financial
// intelligence never disagree about how full the nursery is.
async function occupancyNow(db) {
  try {
    const { occupancy } = require('./fee-review-model');
    return await occupancy(db);
  } catch (e) {
    return { rooms: [], overall_occupancy_pct: null, error: e.message };
  }
}

async function childrenOnRoll(db) {
  const { rows } = await db.query(`
    SELECT count(*)::int n FROM children
     WHERE COALESCE(status,'active') = 'active'
       AND (leave_date IS NULL OR leave_date >= CURRENT_DATE)
       AND COALESCE(is_demo, false) = false`).catch(() => ({ rows: [{ n: 0 }] }));
  return rows[0] ? rows[0].n : 0;
}

// ── payroll on a P&L month (b301) ────────────────────────────────────────────
/**
 * The Wren payroll run that covers a P&L month, shaped for the row it sits on.
 *
 * Returns null when the caller may not see pay, and an explicit
 * {available:false, reason} when there simply is no run — those are different
 * facts and a screen has to be able to tell them apart. It never returns 0.
 */
function payrollFor(payrollByMonth, period, allowed) {
  if (!allowed) return null;
  const m = payrollByMonth.get(period.month);
  if (!m) {
    return { available: false, run_id: null,
             reason: `No Wren payroll run covers ${period.month}.` };
  }
  return {
    available: true,
    run_id: m.run_id,                     // the drill-through target
    period_label: m.period_label,
    status: m.status,
    staff_count: m.staff_count,
    gross_gbp: gbp(m.gross_pence),
    employer_ni_gbp: gbp(m.employer_ni_pence),
    employer_cost_gbp: gbp(m.employer_cost_pence),
    share_of_revenue_pct: pct(m.employer_cost_pence, period.revenue_pence),
    // Xero's staff line minus Wren's payroll. A large gap usually means agency
    // cover, a director's salary posted outside payroll, or a month where the
    // run was never generated — all worth seeing rather than smoothing.
    variance_vs_xero_gbp: gbp(period.staff_pence - m.employer_cost_pence),
    hours_inferred_lines: m.inferred_lines,
    warning_count: m.warning_count,
    employer_ni_estimated: !m.employer_ni_stored,
  };
}

// ── the headline picture ─────────────────────────────────────────────────────
/**
 * "How are we doing financially?" — answered from complete months only, with
 * every figure carrying its period, and every missing month named.
 */
async function financialOverview(db, { months = 6, includePayroll = false } = {}) {
  const periods = await pnlPeriods(db, { limit: Math.max(months, 12) });
  // b301: Wren's OWN payroll runs, joined on the calendar month. Passed in only
  // when the caller has already checked view_staff_salaries — this function does
  // no permission work of its own, and a floor manager reads the same overview.
  const payroll = includePayroll
    ? await require('./payroll-costs').payrollByMonth(db, { limit: 36 }).catch(() => new Map())
    : new Map();
  if (!periods.length) {
    return {
      available: false,
      reason: 'No Xero accounting periods have synced into finance_pnl_periods yet. '
            + 'Until a sync lands there is no financial picture to report — Wren will not estimate one.',
      periods: [], gaps: [],
    };
  }

  const usable = periods.filter(p => p.usable).slice(0, months);
  const [occ, children] = await Promise.all([occupancyNow(db), childrenOnRoll(db)]);
  const bookedChildren = (occ.rooms || []).reduce((s2, r) => s2 + (r.children || 0), 0);

  const sum = k => usable.reduce((s, p) => s + p[k], 0);
  const n = usable.length;
  const avgRevenue = n ? sum('revenue_pence') / n : null;
  const avgStaff   = n ? sum('staff_pence') / n : null;
  // b301: the same average from Wren's payroll, over the SAME complete months, so
  // the two are comparable. Months with no payroll run are excluded rather than
  // treated as zero — a month nobody ran payroll for did not cost nothing.
  const payrollUsable = usable.map(p => payroll.get(p.month)).filter(Boolean);
  const avgPayroll = payrollUsable.length
    ? payrollUsable.reduce((s2, m) => s2 + m.employer_cost_pence, 0) / payrollUsable.length
    : null;
  const avgOther   = n ? sum('other_pence') / n : null;
  const avgCost    = n ? sum('total_cost_pence') / n : null;
  const avgNet     = n ? sum('net_pence') / n : null;

  const latest = periods[0];
  const thisMonth = new Date().toISOString().slice(0, 7);
  const allGaps = missingMonths(periods, { upTo: thisMonth });
  const occPct = occ.overall_occupancy_pct;
  // Break-even occupancy assumes revenue moves with occupancy and cost does not.
  // Both halves of that are approximations and are stated as such wherever shown.
  const breakEvenOccPct = (occPct && avgRevenue) ? round2(occPct * (avgCost / avgRevenue)) : null;

  return {
    available: true,
    months_used: n,
    basis: n
      ? `Averages are over the ${n} complete month(s) listed below. Partial and missing months are excluded, never estimated.`
      : 'No complete month is available — every period held is partial or empty, so no average is offered.',
    latest_period: {
      month: latest.month, cite: latest.cite, partial: latest.partial,
      revenue_gbp: gbp(latest.revenue_pence), staff_cost_gbp: gbp(latest.staff_pence),
      other_cost_gbp: gbp(latest.other_pence), total_cost_gbp: gbp(latest.total_cost_pence),
      net_gbp: gbp(latest.net_pence), margin_pct: latest.margin_pct,
      staff_share_pct: latest.staff_share_pct,
      payroll: payrollFor(payroll, latest, includePayroll),
    },
    averages: n ? {
      revenue_gbp: gbp(avgRevenue), staff_cost_gbp: gbp(avgStaff), other_cost_gbp: gbp(avgOther),
      total_cost_gbp: gbp(avgCost), net_gbp: gbp(avgNet),
      margin_pct: pct(avgNet, avgRevenue),
      staff_share_of_revenue_pct: pct(avgStaff, avgRevenue),
      // b301: the ratio the Finance tile is actually asking for — Wren's own wage
      // bill over Xero's revenue — alongside the Xero-classified one, never
      // instead of it, so a disagreement between the two is visible.
      //
      // The three payroll fields are NULL, not 0, when the caller may not see pay.
      // pct(null, revenue) returns 0, and a wage bill rendered as "0% of revenue" is
      // worse than one that is absent: it is a wrong figure rather than a withheld one.
      payroll_cost_gbp: includePayroll ? gbp(avgPayroll) : null,
      payroll_share_of_revenue_pct: (includePayroll && avgPayroll != null)
        ? pct(avgPayroll, avgRevenue) : null,
      payroll_months_used: includePayroll ? payrollUsable.length : null,
      staff_cost_source: includePayroll
        ? (payrollUsable.length
            ? `Two figures, deliberately: staff_cost_gbp is Xero's, from P&L account names matching ${STAFF_COST_RX}; payroll_cost_gbp is Wren's own payroll runs (${payrollUsable.length} of the ${n} complete month(s) have one). Where they disagree, Xero is the accounts and Wren is the rota.`
            : `Xero only. No Wren payroll run covers any of the ${n} complete month(s) below, so payroll_cost_gbp is null rather than zero.`)
        : 'Xero only — payroll figures are withheld from this response because the caller does not hold view_staff_salaries.',
      cost_per_child_per_month_gbp: children ? gbp(avgCost / children) : null,
      revenue_per_child_per_month_gbp: children ? gbp(avgRevenue / children) : null,
      children_on_roll: children,
      children_with_active_bookings: bookedChildren,
      per_child_basis: `Divided by the ${children} children on roll (children, active). `
        + `${bookedChildren} of them have an active booking in child_bookings — where those two numbers `
        + `differ, the per-child figures are diluted by children on roll without a current booking, so read `
        + `them as a rough unit cost rather than a price.`,
    } : null,
    occupancy: {
      overall_pct: occPct,
      rooms: (occ.rooms || []).map(r => ({
        room: r.room, capacity: r.capacity, children: r.children,
        occupancy_pct: r.occupancy_pct, funded_share_pct: r.funded_share_pct,
      })),
      break_even_occupancy_pct: breakEvenOccPct,
      break_even_note: breakEvenOccPct
        ? `At the average cost of the ${n} complete month(s) below, income covers cost at about `
          + `${breakEvenOccPct}% occupancy — against ${occPct}% booked today. This assumes income moves `
          + `in proportion to occupancy and that cost does not; neither is exactly true, so treat it as a marker, not a threshold.`
        : 'Not calculable — needs both a complete P&L month and current bookings.',
      source: occ.source || 'child_bookings',
    },
    periods: periods.map(p => ({
      month: p.month, cite: p.cite, source: p.source, partial: p.partial,
      revenue_gbp: gbp(p.revenue_pence), staff_cost_gbp: gbp(p.staff_pence),
      other_cost_gbp: gbp(p.other_pence), total_cost_gbp: gbp(p.total_cost_pence),
      net_gbp: gbp(p.net_pence), margin_pct: p.margin_pct, staff_share_pct: p.staff_share_pct,
      payroll: payrollFor(payroll, p, includePayroll),
    })),
    gaps: allGaps,
    current_month: {
      month: thisMonth,
      status: periods.some(p => p.month === thisMonth)
        ? 'a period exists — see the table (it will be partial until the month closes)'
        : 'NOT SYNCED — no data for the month in progress',
    },
    months_since_last_period: allGaps.filter(g => g > periods[0].month).length,
    gaps_note: 'Months listed in `gaps` have not synced. They are excluded from every figure above '
             + 'and must be reported as "no data" — never estimated from the months either side. '
             + 'Gaps AFTER the newest period mean the sync has stopped: say so rather than presenting '
             + 'the last month held as if it were current.',
    advisory_only: 'These are figures and scenarios for a decision. Wren does not book, pay or change anything.',
  };
}

// ── staffing cost vs income ──────────────────────────────────────────────────
/**
 * What a change in ESTABLISHMENT does to margin. Whole-establishment averages
 * only — this function has no access to an individual and cannot produce one.
 * `delta_fte` may be negative (a smaller team) or positive (an extra pair of
 * hands); both are modelled the same way and neither is a recommendation.
 */
async function staffingScenario(db, { deltaFte = 0, months = 6 } = {}) {
  const overview = await financialOverview(db, { months });
  if (!overview.available || !overview.averages) {
    return { available: false, reason: overview.reason || 'No complete P&L month to model against.' };
  }

  const { rows: [est] } = await db.query(`
    SELECT COUNT(*)::int                                                     AS headcount,
           ROUND(SUM(COALESCE(hours_per_week, contracted_hours, 0))::numeric / 37.5, 2) AS fte
      FROM staff
     WHERE is_active = true AND COALESCE(role,'') NOT IN ('parent')
       AND COALESCE(is_demo, false) = false`).catch(() => ({ rows: [{ headcount: 0, fte: 0 }] }));

  const fte = Number(est.fte) || 0;
  const avgStaffPence = Number(overview.averages.staff_cost_gbp) * 100;
  const costPerFte = fte ? avgStaffPence / fte : null;
  const revenue = Number(overview.averages.revenue_gbp) * 100;
  const totalCost = Number(overview.averages.total_cost_gbp) * 100;

  const scenarios = [-2, -1, 0, 1, 2].concat(deltaFte && ![-2, -1, 0, 1, 2].includes(deltaFte) ? [deltaFte] : [])
    .sort((a, b) => a - b)
    .map(d => {
      if (costPerFte == null) return { delta_fte: d, available: false };
      const newStaffCost = avgStaffPence + d * costPerFte;
      const newTotal = totalCost + d * costPerFte;
      return {
        delta_fte: d,
        staff_cost_gbp: gbp(newStaffCost),
        total_cost_gbp: gbp(newTotal),
        net_gbp: gbp(revenue - newTotal),
        margin_pct: pct(revenue - newTotal, revenue),
        change_in_net_gbp: gbp(-d * costPerFte),
      };
    });

  return {
    available: costPerFte != null,
    basis: overview.basis,
    period_cite: overview.periods.filter(p => !p.partial).slice(0, months).map(p => p.cite),
    establishment: {
      headcount: est.headcount, fte,
      fte_basis: 'contracted hours ÷ 37.5 from staff (active, excluding parent accounts)',
      average_staff_cost_per_fte_per_month_gbp: gbp(costPerFte),
    },
    current: {
      staff_cost_gbp: overview.averages.staff_cost_gbp,
      revenue_gbp: overview.averages.revenue_gbp,
      staff_share_of_revenue_pct: overview.averages.staff_share_of_revenue_pct,
      margin_pct: overview.averages.margin_pct,
    },
    scenarios,
    workings: 'Each row moves the wage bill by (delta FTE × average cost per FTE) and leaves every other '
            + 'cost unchanged. It is arithmetic on an average, not a plan: it takes no account of ratio '
            + 'requirements, room cover, notice periods, redundancy cost or what those hours were doing.',
    ratio_warning: 'Any reduction must be checked against statutory ratios and room cover before it means '
                 + 'anything. Wren does not model whether a smaller team could legally staff the rooms.',
        boundary: 'This is a whole-establishment scenario. Wren does not identify individuals for a staffing '
            + 'decision and will not do so if asked.',
    advisory_only: 'A scenario to take to a decision, not a decision. Nothing here changes a rota or a contract.',
  };
}

// ── occupancy needed for a target margin ─────────────────────────────────────
/**
 * The occupancy each room would need for the setting to hit a target margin,
 * holding cost flat and assuming income scales with occupancy. Per room, using
 * each room's share of booked days to apportion.
 */
async function occupancyForMargin(db, { targetMarginPct = 15, months = 6 } = {}) {
  const overview = await financialOverview(db, { months });
  if (!overview.available || !overview.averages) {
    return { available: false, reason: overview.reason || 'No complete P&L month to model against.' };
  }
  const occ = await occupancyNow(db);
  const revenue = Number(overview.averages.revenue_gbp) * 100;
  const cost    = Number(overview.averages.total_cost_gbp) * 100;
  const occPct  = occ.overall_occupancy_pct;
  if (!revenue || !occPct) {
    return { available: false, reason: 'Needs both a complete P&L month and current bookings in child_bookings.' };
  }

  // Revenue needed so that (revenue - cost) / revenue = target.
  const neededRevenue = cost / (1 - targetMarginPct / 100);
  const neededOccPct  = round2(occPct * (neededRevenue / revenue));
  const revenuePerOccPoint = revenue / occPct;

  const totalBooked = (occ.rooms || []).reduce((s, r) => s + (r.booked_days_week || 0), 0);
  const rooms = (occ.rooms || []).map(r => {
    const share = totalBooked ? (r.booked_days_week || 0) / totalBooked : 0;
    const capDays = r.capacity_days_week || 0;
    const neededDays = capDays ? (neededOccPct / 100) * capDays : null;
    return {
      room: r.room, capacity: r.capacity, children: r.children,
      occupancy_pct: r.occupancy_pct,
      booked_days_week: r.booked_days_week, capacity_days_week: capDays,
      share_of_booked_days_pct: round2(share * 100),
      revenue_share_gbp: gbp(revenue * share),
      needed_occupancy_pct: neededOccPct,
      needed_booked_days_week: neededDays == null ? null : round2(neededDays),
      extra_days_week_needed: neededDays == null ? null : round2(Math.max(0, neededDays - (r.booked_days_week || 0))),
      note: 'Apportioned by this room\'s share of booked days — Wren does not hold revenue per room, so this '
          + 'assumes each booked day earns the setting average. A baby-room day earns more than a pre-school day, '
          + 'so treat the split as indicative.',
    };
  });

  return {
    available: true,
    target_margin_pct: targetMarginPct,
    basis: overview.basis,
    period_cite: overview.periods.filter(p => !p.partial).slice(0, months).map(p => p.cite),
    setting: {
      current_occupancy_pct: occPct,
      current_margin_pct: overview.averages.margin_pct,
      average_revenue_gbp: overview.averages.revenue_gbp,
      average_cost_gbp: overview.averages.total_cost_gbp,
      needed_revenue_gbp: gbp(neededRevenue),
      needed_occupancy_pct: neededOccPct,
      gap_occupancy_points: round2(neededOccPct - occPct),
      revenue_per_occupancy_point_gbp: gbp(revenuePerOccPoint),
    },
    rooms,
    workings: `Revenue needed = average cost ÷ (1 − target margin) = £${gbp(cost)} ÷ ${round2(1 - targetMarginPct / 100)} `
            + `= £${gbp(neededRevenue)} a month. At today's ${occPct}% occupancy earning £${gbp(revenue)}, each point of `
            + `occupancy is worth about £${gbp(revenuePerOccPoint)} — so the target needs about ${neededOccPct}% occupancy.`,
    assumptions: [
      'Cost is held flat as occupancy rises. Beyond a point it will not be — more children means more staff.',
      'Income is assumed proportional to occupancy at the current mix of funded and private hours.',
      'Occupancy comes from live bookings, the P&L from the months listed — they are different moments in time.',
    ],
    advisory_only: 'A target to aim at, with its arithmetic shown. Wren does not fill places or change fees.',
  };
}

// ── fee increase modelling ───────────────────────────────────────────────────
/**
 * What an across-the-board fee rise would raise, and where it would put us
 * against the local market (b203's competitor_fees). Deliberately simple and
 * explicit — the detailed per-room recommendation lives in the b203 fee review;
 * this is the "what does X% do to the bottom line" question the assistant gets asked.
 */
async function feeIncreaseImpact(db, { increasePct = 5, months = 6 } = {}) {
  const overview = await financialOverview(db, { months });
  if (!overview.available || !overview.averages) {
    return { available: false, reason: overview.reason || 'No complete P&L month to model against.' };
  }
  const revenue = Number(overview.averages.revenue_gbp) * 100;
  const cost    = Number(overview.averages.total_cost_gbp) * 100;

  // The funded share cannot be re-priced: an hour funded by the local authority
  // is paid at the LA's rate whatever we charge. Raising fees only moves the
  // private share, and pretending otherwise overstates the gain — the single
  // most common way this calculation gets done wrong.
  const occ = await occupancyNow(db);
  const totalDays  = (occ.rooms || []).reduce((s, r) => s + (r.booked_days_week || 0), 0);
  const fundedDays = (occ.rooms || []).reduce((s, r) => s + (r.funded_days_week || 0), 0);
  const privateShare = totalDays ? 1 - fundedDays / totalDays : null;

  const uplift = privateShare == null ? null : revenue * privateShare * (increasePct / 100);

  let market = { available: false, reason: 'b203 competitor fee data not available.' };
  try {
    const feeReview = require('./fee-review-model');
    const [m, ours] = await Promise.all([feeReview.market(db), feeReview.ourFees(db)]);
    if (m.available) {
      market = {
        available: true, scraped_at: m.scraped_at,
        bands: Object.entries(m.bands).map(([band, b]) => {
          const our = ours[band];
          const ourNew = our ? Math.round(our.day_pence * (1 + increasePct / 100)) : null;
          return {
            band, label: b.label, providers_compared: b.n,
            market_median_day_gbp: b.median_day_gbp,
            market_range_gbp: [gbp(b.min_day_pence), gbp(b.max_day_pence)],
            our_day_gbp: our ? our.day_gbp : null,
            our_day_after_increase_gbp: gbp(ourNew),
            vs_median_after_pct: (ourNew && b.median_day_pence) ? pct(ourNew - b.median_day_pence, b.median_day_pence) : null,
            position_after: (ourNew && b.median_day_pence)
              ? (ourNew > b.median_day_pence ? 'above the local median' : ourNew < b.median_day_pence ? 'below the local median' : 'at the local median')
              : 'not comparable — we have no published day rate for this band, or no usable market figure',
          };
        }),
        note: m.note,
      };
    } else {
      market = { available: false, reason: m.reason };
    }
  } catch (e) {
    market = { available: false, reason: `Competitor data unavailable: ${e.message}` };
  }

  return {
    available: uplift != null,
    increase_pct: increasePct,
    basis: overview.basis,
    period_cite: overview.periods.filter(p => !p.partial).slice(0, months).map(p => p.cite),
    current: {
      average_monthly_revenue_gbp: overview.averages.revenue_gbp,
      average_monthly_cost_gbp: overview.averages.total_cost_gbp,
      margin_pct: overview.averages.margin_pct,
    },
    funded_split: privateShare == null ? null : {
      booked_days_week: totalDays, funded_days_week: fundedDays,
      private_share_pct: round2(privateShare * 100),
      note: 'Funded hours are paid at the local authority rate and do not move when our fees do. '
          + 'Only the private share is re-priced here.',
    },
    impact: uplift == null ? null : {
      extra_revenue_per_month_gbp: gbp(uplift),
      extra_revenue_per_year_gbp: gbp(uplift * 12),
      new_monthly_revenue_gbp: gbp(revenue + uplift),
      new_margin_pct: pct(revenue + uplift - cost, revenue + uplift),
      margin_points_gained: round2((pct(revenue + uplift - cost, revenue + uplift) || 0) - (overview.averages.margin_pct || 0)),
    },
    market,
    workings: privateShare == null ? null
      : `£${gbp(revenue)} average monthly income × ${round2(privateShare * 100)}% private share × ${increasePct}% `
      + `= £${gbp(uplift)} a month, £${gbp(uplift * 12)} a year — before any family leaves over it.`,
    assumptions: [
      'Every family stays. A rise that loses two full-time places can raise less than nothing.',
      'The private/funded split is today\'s, from live bookings; it moves as children turn three.',
      'Cost is held flat — wage rises are modelled in the b203 April fee review, not here.',
    ],
    advisory_only: 'Modelling only. Wren never changes a fee; fee_items is not written by this code.',
    see_also: 'Finance → Fees (b203) for the per-room April recommendation with its full workings.',
  };
}

// ── spend outliers ───────────────────────────────────────────────────────────
/**
 * Cost lines rising faster than income. Compares the most recent complete
 * months with the same number of months before them, per account, and reports
 * the ones outpacing revenue growth. Anything without both windows is reported
 * as new or lapsed rather than shown as an infinite rise.
 */
async function spendOutliers(db, { window = 3 } = {}) {
  const periods = await pnlPeriods(db, { limit: window * 2 + 6 });
  const usable = periods.filter(p => p.usable);
  if (usable.length < window * 2) {
    return {
      available: false,
      reason: `Needs ${window * 2} complete months to compare two windows; ${usable.length} available `
            + `(${usable.map(p => p.month).join(', ') || 'none'}). Wren will not compare windows of different length.`,
    };
  }
  const recent = usable.slice(0, window);
  const prior  = usable.slice(window, window * 2);

  const bucket = list => {
    const m = new Map();
    for (const p of list) for (const l of p.lines) {
      if (l.kind === 'revenue') continue;
      m.set(l.account, (m.get(l.account) || 0) + l.amount_pence);
    }
    return m;
  };
  const recentSpend = bucket(recent), priorSpend = bucket(prior);
  const recentRevenue = recent.reduce((s, p) => s + p.revenue_pence, 0);
  const priorRevenue  = prior.reduce((s, p) => s + p.revenue_pence, 0);
  const revenueGrowthPct = pct(recentRevenue - priorRevenue, priorRevenue);

  const lines = [];
  for (const [account, amt] of recentSpend) {
    const before = priorSpend.get(account);
    if (!before) {
      lines.push({ account, recent_gbp: gbp(amt), prior_gbp: null, change_pct: null,
        status: 'new — no spend on this account in the earlier window, so there is no growth rate to quote' });
      continue;
    }
    const changePct = pct(amt - before, before);
    lines.push({
      account, recent_gbp: gbp(amt), prior_gbp: gbp(before),
      change_gbp: gbp(amt - before), change_pct: changePct,
      vs_revenue_points: (changePct != null && revenueGrowthPct != null) ? round2(changePct - revenueGrowthPct) : null,
      // When income has FALLEN, a flat account is technically outpacing it. Saying
      // "Depreciation is rising faster than income" about a line that did not move
      // by a penny is how a real signal gets lost in a list of noise, so a line
      // only counts as rising if it actually rose.
      status: (changePct != null && revenueGrowthPct != null && changePct > revenueGrowthPct)
        ? (changePct > 0 ? 'rising faster than income' : 'flat or falling — but income fell faster')
        : 'in line with or below income',
    });
  }
  for (const [account, before] of priorSpend) {
    if (!recentSpend.has(account)) {
      lines.push({ account, recent_gbp: 0, prior_gbp: gbp(before), change_pct: -100,
        status: 'stopped — nothing on this account in the recent window' });
    }
  }
  lines.sort((a, b) => (b.vs_revenue_points ?? -Infinity) - (a.vs_revenue_points ?? -Infinity));

  // Materiality floor: a £36 rise in bank fees is not intelligence, it is noise.
  const MATERIAL_PENCE = 10000;   // £100 across the whole window
  return {
    available: true,
    windows: {
      recent: recent.map(p => p.cite), prior: prior.map(p => p.cite),
      recent_revenue_gbp: gbp(recentRevenue), prior_revenue_gbp: gbp(priorRevenue),
      revenue_growth_pct: revenueGrowthPct,
    },
    outliers: lines
      .filter(l => l.status === 'rising faster than income'
                && Math.abs(Number(l.change_gbp) * 100) >= MATERIAL_PENCE)
      .slice(0, 12),
    materiality_note: `Lines that moved by less than £${MATERIAL_PENCE / 100} across the window are kept in `
                    + 'all_lines but left out of outliers — a few pounds either way is not a finding.',
    all_lines: lines,
    workings: `Each account's total across ${recent.map(p => p.month).join(', ')} against the same account across `
            + `${prior.map(p => p.month).join(', ')}, then compared with income growth of `
            + `${revenueGrowthPct == null ? 'n/a' : revenueGrowthPct + '%'} over the same two windows.`,
    caution: 'A three-month window catches a one-off — an annual insurance premium or a boiler — and shows it as a '
           + 'trend. Read the account name before reading the percentage.',
    advisory_only: 'Wren flags; it does not cancel a supplier or move a budget.',
  };
}

// ── cash + debtors ───────────────────────────────────────────────────────────
/** Bank balances from the most recent Balance Sheet we hold, with its as-at date. */
async function cashFromBalanceSheet(db) {
  const { rows } = await db.query(`
    SELECT p.period_to, p.period_label, p.source, l.section, l.account_name, l.amount_pence, l.row_type
      FROM finance_pnl_periods p JOIN finance_pnl_lines l ON l.period_id = p.id
     WHERE p.report_type = 'balance_sheet'
       AND p.period_to = (SELECT max(period_to) FROM finance_pnl_periods WHERE report_type='balance_sheet')
     ORDER BY l.sort_order`).catch(() => ({ rows: [] }));
  if (!rows.length) return { available: false, reason: 'No Balance Sheet has synced from Xero yet.' };
  const bank = rows.filter(r => /bank|cash/i.test(r.section) || /bank|current account|cash/i.test(r.account_name));
  // Local parts, not toISOString(): period_to comes back as a local-midnight Date,
  // and toISOString() shifts it into the previous day under BST — the figure was
  // labelled "As at 30 September 2026" while as_at read 2026-09-29.
  const asAt = rows[0].period_to instanceof Date
    ? `${rows[0].period_to.getFullYear()}-${String(rows[0].period_to.getMonth() + 1).padStart(2, '0')}-${String(rows[0].period_to.getDate()).padStart(2, '0')}`
    : rows[0].period_to;
  // The Xero bank balance is KNOWN to be overstated (2026-09-08). Before the b226
  // guard, the nightly push created a Payment against the LADN account for every
  // historical 'paid' invoice it back-filled — money the real bank feed had
  // already recorded. 543 such payments are still in Xero. Wren reports what Xero
  // says, so the figure is faithful but wrong, and showing it bare invites a
  // decision on money that is not there. The caveat travels WITH the number:
  // every caller — the finance page, the assistant's grounding block, any export
  // — gets it, because a warning that lives only in the UI is a warning the
  // assistant will happily talk straight past.
  let distortion = null;
  try {
    const { rows: dRows } = await db.query(
      "SELECT value FROM settings WHERE key = 'xero_balance_distortion_pence'");
    const pence = dRows.length ? parseInt(dRows[0].value, 10) : NaN;
    if (Number.isFinite(pence) && pence > 0) distortion = pence;
  } catch (_) { /* no setting, no caveat */ }

  const accounts = bank.filter(r => r.row_type !== 'SummaryRow')
    .map(r => ({ account: r.account_name, balance_gbp: gbp(r.amount_pence) }));
  const totalPence = bank.filter(r => r.row_type !== 'SummaryRow')
    .reduce((s, r) => s + num(r.amount_pence), 0);

  return {
    available: true,
    as_at: asAt,
    cite: `${rows[0].period_label || `as at ${asAt}`} (${sourceLabel(rows[0].source)})`,
    accounts,
    total_gbp: gbp(totalPence),
    ...(distortion ? (() => {
      // Subtracting the whole logged distortion currently lands BELOW zero, which
      // is not a possible bank balance — so the logged total is an upper bound,
      // not a correction: it counts every payment Wren ever pushed, including any
      // already deleted in Xero and any retried line. Confirming which are still
      // present needs the live Payments API, and the report script cannot reach it
      // (its refreshTokenIfNeeded path 400s while the nightly sync's own path
      // works). Until that is confirmed, publish the WARNING and withhold the
      // corrected figure. An implausible number stated confidently is worse than
      // no number: someone would spend against it.
      const corrected = totalPence - distortion;
      const plausible = corrected >= 0;
      return {
        overstated: true,
        overstated_by_gbp_upper_bound: gbp(distortion),
        corrected_total_gbp: plausible ? gbp(corrected) : null,
        caveat: `DO NOT USE THIS FIGURE FOR A DECISION. Xero's bank balance is overstated: before the `
          + `2026-08-25 guard, Wren's nightly push created a duplicate Payment for every historical `
          + `'paid' invoice it back-filled, against money the real bank feed had already recorded. `
          + `543 such payments totalling about £${gbp(distortion)} are logged. `
          + (plausible
              ? `That puts the true figure near £${gbp(corrected)} — an estimate, not a balance.`
              : `Subtracting all of them gives a negative balance, so that total is an UPPER BOUND, `
                + `not a correction — some are likely already removed. The true figure is unknown `
                + `until the live Xero Payments API confirms which are still present.`)
          + ` They must be removed in Xero by hand; run scripts/xero-bogus-payment-report.js for the list.`,
      };
    })() : {}),
  };
}

/** Latest bank position from the Xero bank feed — the fallback when no Balance Sheet exists. */
async function cashFromBankFeed(db) {
  const { rows } = await db.query(`
    SELECT DISTINCT ON (account_id) account_id, account_name, balance_pence, transaction_date
      FROM bank_statement_lines
     WHERE balance_pence IS NOT NULL
     ORDER BY account_id, transaction_date DESC, id DESC`).catch(() => ({ rows: [] }));
  if (!rows.length) return { available: false, reason: 'No bank statement lines with a running balance.' };
  return {
    available: true,
    as_at: rows.map(r => r.transaction_date).sort().slice(-1)[0],
    accounts: rows.map(r => ({
      account: r.account_name, balance_gbp: gbp(r.balance_pence),
      as_at: r.transaction_date instanceof Date ? r.transaction_date.toISOString().slice(0, 10) : r.transaction_date,
    })),
    total_gbp: gbp(rows.reduce((s, r) => s + num(r.balance_pence), 0)),
    caveat: 'Running balances from the last bank line seen per account — the date each was last updated is shown. '
          + 'This is the bank feed, not a reconciled Balance Sheet.',
  };
}

/**
 * Debtor ageing + the chase list. Xero's aged receivables where it has synced;
 * otherwise Wren's own unpaid invoices, clearly labelled as such — the two are
 * not the same ledger and are never merged.
 */
async function debtors(db, { limit = 15 } = {}) {
  // Anchor on the last SUCCESSFUL report sync, not on max(as_at) in finance_aged.
  //
  // The writer replaces a snapshot with DELETE ... WHERE as_at = <today> followed
  // by an insert per contact. When nothing is outstanding it deletes nothing and
  // inserts nothing, so no row exists for today at all — and max(as_at) stays
  // pinned to the last day debt existed. On 2026-09-09, after the phantom
  // invoices were voided, Xero reported zero aged receivables and Wren carried on
  // reporting £582,520.32 from the previous day's photograph, indefinitely.
  //
  // The sync run IS the evidence a report was taken. If the latest successful run
  // found no aged rows, the answer is zero — not "whatever we last saw".
  const { rows: runRows } = await db.query(`
    SELECT finished_at::date AS ran_on, aged_rows
      FROM finance_report_sync_runs
     WHERE status='success' AND finished_at IS NOT NULL
     ORDER BY finished_at DESC LIMIT 1`).catch(() => ({ rows: [] }));
  const lastRun = runRows[0] || null;

  if (lastRun && Number(lastRun.aged_rows) === 0) {
    return {
      available: true, source: 'Xero aged receivables',
      // ran_on comes back as a Date; String()ing it gives "Wed Sep 09 ...", not a date.
      as_at: lastRun.ran_on instanceof Date
        ? `${lastRun.ran_on.getFullYear()}-${String(lastRun.ran_on.getMonth() + 1).padStart(2, '0')}-${String(lastRun.ran_on.getDate()).padStart(2, '0')}`
        : String(lastRun.ran_on).slice(0, 10),
      buckets: { current_gbp: 0, d1_30_gbp: 0, d31_60_gbp: 0, d61_90_gbp: 0, d90_plus_gbp: 0 },
      total_gbp: 0, overdue_gbp: 0, contacts: [], count: 0,
      note: 'Xero reports nothing outstanding as at this date.',
    };
  }

  const { rows: aged } = await db.query(`
    SELECT * FROM finance_aged
     WHERE report_type='aged_receivables'
       AND as_at = (SELECT max(as_at) FROM finance_aged WHERE report_type='aged_receivables')
     ORDER BY total_pence DESC`).catch(() => ({ rows: [] }));

  if (aged.length) {
    const t = k => aged.reduce((s, r) => s + num(r[k]), 0);
    return {
      available: true, source: 'Xero aged receivables', method: aged[0].method,
      as_at: aged[0].as_at instanceof Date ? aged[0].as_at.toISOString().slice(0, 10) : aged[0].as_at,
      buckets: {
        current_gbp: gbp(t('current_pence')), d1_30_gbp: gbp(t('d1_30_pence')),
        d31_60_gbp: gbp(t('d31_60_pence')), d61_90_gbp: gbp(t('d61_90_pence')),
        d90_plus_gbp: gbp(t('d90_plus_pence')),
      },
      total_gbp: gbp(t('total_pence')),
      overdue_gbp: gbp(t('d1_30_pence') + t('d31_60_pence') + t('d61_90_pence') + t('d90_plus_pence')),
      chase_list: aged.filter(r => num(r.total_pence) > num(r.current_pence)).slice(0, limit).map(r => ({
        contact: r.contact_name, total_gbp: gbp(r.total_pence),
        overdue_gbp: gbp(num(r.total_pence) - num(r.current_pence)),
        oldest_due: r.oldest_due_date instanceof Date ? r.oldest_due_date.toISOString().slice(0, 10) : r.oldest_due_date,
        invoices: r.invoice_count,
        worst_bucket: num(r.d90_plus_pence) ? '90+ days' : num(r.d61_90_pence) ? '61–90 days'
                    : num(r.d31_60_pence) ? '31–60 days' : num(r.d1_30_pence) ? '1–30 days' : 'not yet due',
      })),
    };
  }

  // Fallback: Wren's own invoice ledger.
  const { rows } = await db.query(`
    SELECT i.id, i.amount_pence, i.due_on, i.status, i.invoice_number,
           COALESCE(NULLIF(TRIM(c.first_name || ' ' || c.last_name), ''), i.bill_payer_email, 'Unknown') AS payer
      FROM invoices i
      LEFT JOIN children c ON c.id = i.child_id
     WHERE i.status NOT IN ('paid','cancelled','void','credited','draft')
       AND i.amount_pence > 0
       AND COALESCE(c.is_demo, false) = false
     ORDER BY i.due_on NULLS LAST`).catch(() => ({ rows: [] }));
  if (!rows.length) {
    return { available: false, reason: 'No Xero aged receivables have synced, and Wren holds no unpaid invoices.' };
  }
  const today = new Date();
  const bucketOf = due => {
    if (!due) return 'current';
    const days = Math.floor((today - new Date(due)) / 86400000);
    return days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus';
  };
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const byPayer = new Map();
  for (const r of rows) {
    const b = bucketOf(r.due_on);
    buckets[b] += num(r.amount_pence);
    const key = r.payer;
    if (!byPayer.has(key)) byPayer.set(key, { contact: key, total: 0, overdue: 0, invoices: 0, oldest: null, worst: 'current' });
    const p = byPayer.get(key);
    p.total += num(r.amount_pence); p.invoices += 1;
    if (b !== 'current') p.overdue += num(r.amount_pence);
    const dueStr = r.due_on instanceof Date ? r.due_on.toISOString().slice(0, 10) : r.due_on;
    if (dueStr && (!p.oldest || dueStr < p.oldest)) p.oldest = dueStr;
    const order = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'];
    if (order.indexOf(b) > order.indexOf(p.worst)) p.worst = b;
  }
  const label = { current: 'not yet due', d1_30: '1–30 days', d31_60: '31–60 days', d61_90: '61–90 days', d90_plus: '90+ days' };
  return {
    available: true,
    source: 'Wren invoice ledger (invoices) — NOT Xero. Xero aged receivables have not synced.',
    as_at: today.toISOString().slice(0, 10),
    buckets: {
      current_gbp: gbp(buckets.current), d1_30_gbp: gbp(buckets.d1_30), d31_60_gbp: gbp(buckets.d31_60),
      d61_90_gbp: gbp(buckets.d61_90), d90_plus_gbp: gbp(buckets.d90_plus),
    },
    total_gbp: gbp(Object.values(buckets).reduce((s, v) => s + v, 0)),
    overdue_gbp: gbp(buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90_plus),
    chase_list: [...byPayer.values()].filter(p => p.overdue > 0)
      .sort((a, b) => b.overdue - a.overdue).slice(0, limit)
      .map(p => ({ contact: p.contact, total_gbp: gbp(p.total), overdue_gbp: gbp(p.overdue),
                   oldest_due: p.oldest, invoices: p.invoices, worst_bucket: label[p.worst] })),
    caveat: 'Wren\'s own ledger knows nothing about payments taken directly in Xero or by bank transfer that '
          + 'were never reconciled back — an invoice here may already have been paid.',
  };
}

/** Cash position, debtor days and the chase list in one answer. */
async function cashPosition(db, { months = 6 } = {}) {
  const [bs, feed, debt, overview] = await Promise.all([
    cashFromBalanceSheet(db), cashFromBankFeed(db), debtors(db), financialOverview(db, { months }),
  ]);
  const cash = bs.available ? bs : feed;
  const dailyRevenue = (overview.available && overview.averages)
    ? (Number(overview.averages.revenue_gbp) * 100) / 30 : null;
  const debtorDays = (dailyRevenue && debt.available && debt.total_gbp)
    ? round2((Number(debt.total_gbp) * 100) / dailyRevenue) : null;

  return {
    cash: cash.available
      ? { ...cash, preferred_source: bs.available ? 'Xero Balance Sheet' : 'Xero bank feed (no Balance Sheet synced)' }
      : { available: false, reason: `${bs.reason || ''} ${feed.reason || ''}`.trim() },
    debtors: debt,
    debtor_days: debtorDays,
    debtor_days_workings: debtorDays == null ? 'Not calculable — needs both an outstanding balance and a complete P&L month.'
      : `£${debt.total_gbp} outstanding ÷ (£${overview.averages.revenue_gbp} average monthly income ÷ 30) = `
      + `${debtorDays} days of income sitting unpaid. Income basis: ${overview.periods.filter(p => !p.partial).slice(0, months).map(p => p.month).join(', ')}.`,
    runway_note: (cash.available && overview.available && overview.averages && Number(overview.averages.net_gbp) < 0)
      ? `Average net is negative (£${overview.averages.net_gbp}/month over the months listed) — at that rate the `
        + `cash shown would last about ${round2(Number(cash.total_gbp) / Math.abs(Number(overview.averages.net_gbp)))} months. `
        + 'A single arithmetic projection, not a forecast: it ignores seasonality, funding timing and anything already committed.'
      : null,
    advisory_only: 'A chase list is a list to work through, not an action Wren takes. Wren sends nothing and charges nothing.',
  };
}

// ── the grounding block ──────────────────────────────────────────────────────
// Trigger: only build this for a question that is actually about money.
const FINANCE_RX = /financ|profit|loss|p&l|p and l|revenue|income|turnover|margin|cost|costs|spend|spending|expense|cash|bank balance|debtor|owe|owed|outstanding|invoice|arrears|break[- ]?even|fee increase|raise fees|put.{0,12}fees up|budget|xero|payroll cost|wage bill|how are we doing|how's business|how is business|afford/i;

/**
 * The LIVE FINANCIAL FACTS block handed to the Roost assistant. Same contract as
 * buildLiveFacts(): deterministic, computed now, authoritative over anything the
 * model retrieved. Returns '' for a question that is not about money, and for a
 * caller who is not a manager — the caller must also enforce that.
 *
 * @param {object} db      pg pool
 * @param {string} message the manager's question
 * @param {object} opts    { isManager: boolean }
 */
async function buildFinancialFacts(db, message, { isManager = false } = {}) {
  if (!isManager) return '';
  if (!FINANCE_RX.test(String(message || ''))) return '';

  const overview = await financialOverview(db, { months: 6 }).catch(e => ({ available: false, reason: e.message }));
  const parts = [];

  parts.push([
    'RULES FOR THIS BLOCK (they override any instinct to be helpful):',
    '- Quote a figure ONLY with the period it came from. Every row below carries one.',
    '- A month listed as MISSING or PARTIAL has no data. Say "no data for that month". Do NOT estimate it, ',
    '  average around it and call it that month, or carry the previous month forward.',
    '- These are figures for a decision. Wren advises: it does not book, pay, invoice or change a fee, and',
    '  must not offer to.',
    '- Staffing figures are whole-establishment scenarios. Never name an individual in connection with',
    '  reducing hours, redundancy or cost saving, even if asked directly — say that Wren does not do that,',
    '  and give the scenario in numbers instead.',
  ].join('\n'));

  if (!overview.available) {
    parts.push(`### Financial position\nNO DATA. ${overview.reason}\nSay exactly that if asked how the nursery is doing financially — do not infer a position from invoices, bank lines or memory.`);
    return `\n\n--- LIVE FINANCIAL FACTS (Xero, computed from the Wren database just now — authoritative) ---\n${parts.join('\n\n')}`;
  }

  const rows = overview.periods.slice(0, 8).map(p =>
    `| ${p.month} | ${p.revenue_gbp == null ? '—' : '£' + p.revenue_gbp} | £${p.staff_cost_gbp} | £${p.other_cost_gbp} | £${p.net_gbp} | ${p.margin_pct == null ? '—' : p.margin_pct + '%'} | ${p.staff_share_pct == null ? '—' : p.staff_share_pct + '%'} | ${p.partial ? 'PARTIAL — ' + p.partial : 'complete'} | ${p.source} |`
  ).join('\n');

  parts.push(
    `### Profit & loss by month (source: ${overview.periods.length ? sourceLabel(overview.periods[0].source) : 'n/a'})\n`
    + '| Month | Income | Staff cost | Other cost | Net | Margin | Staff % of income | Completeness | Source |\n'
    + '|---|---|---|---|---|---|---|---|---|\n' + rows
    + (overview.gaps.length ? `\n\nMISSING — no data at all for: ${overview.gaps.join(', ')}. These months have not synced from Xero.` : '')
    + (overview.months_since_last_period
        ? `\n\nTHE SYNC IS BEHIND: the newest period held is ${overview.periods[0].month}, and `
          + `${overview.months_since_last_period} month(s) since then have not synced. `
          + `${overview.current_month.month} is ${overview.current_month.status}. If asked how the nursery is `
          + `doing "now", say plainly that the most recent figures are ${overview.periods[0].month} and that `
          + `nothing since has come through.`
        : '')
    + `\n\n${overview.basis}`);

  if (overview.averages) {
    const a = overview.averages;
    const used = overview.periods.filter(p => !p.partial).slice(0, overview.months_used);
    parts.push(
      `### Averages over the ${overview.months_used} complete month(s)\n`
      + `- Income £${a.revenue_gbp}/month; total cost £${a.total_cost_gbp}; net £${a.net_gbp} (margin ${a.margin_pct}%).\n`
      + `- Staff cost £${a.staff_cost_gbp}/month = ${a.staff_share_of_revenue_pct}% of income.\n`
      + `- ${a.children_on_roll} children on roll → cost £${a.cost_per_child_per_month_gbp}/child/month, `
      + `income £${a.revenue_per_child_per_month_gbp}/child/month.\n`
      // One source line, not the same forty-word citation repeated per month —
      // the model reads this whole block and repetition crowds out the figures.
      + `- Periods used: ${used.map(p => p.month).join(', ')}.\n`
      + `- Source: ${[...new Set(used.map(p => sourceLabel(p.source)))].join(' + ')}.`);
  }

  const o = overview.occupancy;
  parts.push(
    `### Occupancy vs break-even\n`
    + `- Booked today: ${o.overall_pct == null ? 'no booking data' : o.overall_pct + '%'} `
    + `(${o.rooms.map(r => `${r.room} ${r.occupancy_pct}% of ${r.capacity}`).join('; ') || 'no rooms'}).\n`
    + `- ${o.break_even_note}`);

  // Only pull the heavier blocks when the question actually reaches for them.
  const msg = String(message);
  if (/staff|wage|payroll|salar|establishment|headcount|redundan|let go|lose|cut/i.test(msg)) {
    const s = await staffingScenario(db, {}).catch(() => null);
    if (s && s.available) {
      parts.push(
        `### Staffing cost scenarios (whole establishment — NO individual is identified)\n`
        + `Establishment: ${s.establishment.headcount} active staff ≈ ${s.establishment.fte} FTE, `
        + `average £${s.establishment.average_staff_cost_per_fte_per_month_gbp}/FTE/month.\n`
        + '| Change in FTE | Staff cost | Total cost | Net | Margin |\n|---|---|---|---|---|\n'
        + s.scenarios.filter(x => x.available !== false).map(x =>
            `| ${x.delta_fte > 0 ? '+' : ''}${x.delta_fte} | £${x.staff_cost_gbp} | £${x.total_cost_gbp} | £${x.net_gbp} | ${x.margin_pct}% |`).join('\n')
        + `\n\n${s.workings}\n${s.ratio_warning}\n${s.boundary}`);
    }
  }
  if (/cash|bank|debtor|owe|owed|outstanding|arrears|chase|unpaid/i.test(msg)) {
    const c = await cashPosition(db, { months: 6 }).catch(() => null);
    if (c) {
      parts.push(
        `### Cash and debtors\n`
        + (c.cash.available
            ? `- Cash: £${c.cash.total_gbp} as at ${c.cash.as_at} (${c.cash.preferred_source}).\n`
            : `- Cash: NO DATA. ${c.cash.reason}\n`)
        + (c.debtors.available
            ? `- Outstanding: £${c.debtors.total_gbp}, of which £${c.debtors.overdue_gbp} is overdue `
              + `(90+ days: £${c.debtors.buckets.d90_plus_gbp}). Source: ${c.debtors.source}. `
              + `${c.debtors.chase_list.length} account(s) on the chase list — the named list is on `
              + `Roost → Finance → Intelligence, not in this block.\n`
            : `- Debtors: NO DATA. ${c.debtors.reason}\n`)
        + (c.debtor_days != null ? `- Debtor days: ${c.debtor_days}. ${c.debtor_days_workings}\n` : '')
        + (c.runway_note ? `- ${c.runway_note}\n` : ''));
    }
  }
  if (/spend|supplier|cost.{0,15}(rise|rising|up|increase)|outlier|where.{0,15}money.{0,10}go/i.test(msg)) {
    const s = await spendOutliers(db, { window: 3 }).catch(() => null);
    if (s && s.available) {
      parts.push(
        `### Spend rising faster than income\n`
        + `Income growth between the two windows: ${s.windows.revenue_growth_pct}%.\n`
        + (s.outliers.length
            ? s.outliers.map(l => `- ${l.account}: £${l.prior_gbp} → £${l.recent_gbp} (${l.change_pct}%, `
                + `${l.vs_revenue_points} points above income growth)`).join('\n')
            : '- Nothing is rising faster than income across these two windows.')
        + `\n${s.workings}\n${s.caution}`);
    } else if (s) {
      parts.push(`### Spend rising faster than income\nNO DATA. ${s.reason}`);
    }
  }
  if (/fee|price|charge|rate|increase|put.{0,12}up/i.test(msg)) {
    const f = await feeIncreaseImpact(db, { increasePct: 5 }).catch(() => null);
    if (f && f.available) {
      parts.push(
        `### Fee increase modelling (illustrative 5%)\n`
        + `- ${f.workings}\n`
        + `- Margin would move from ${f.current.margin_pct}% to ${f.impact.new_margin_pct}% `
        + `(+${f.impact.margin_points_gained} points).\n`
        + (f.market.available
            ? f.market.bands.filter(b => b.our_day_gbp).map(b =>
                `- ${b.label}: ours £${b.our_day_gbp}/day → £${b.our_day_after_increase_gbp}, local median `
                + `£${b.market_median_day_gbp} (${b.providers_compared} providers) — ${b.position_after}.`).join('\n')
            : `- Local market: NO DATA. ${f.market.reason}`)
        + `\n- ${f.assumptions.join(' ')}\n- ${f.advisory_only}`);
    }
  }

  const body = parts.join('\n\n').slice(0, 11000);
  return `\n\n--- LIVE FINANCIAL FACTS (Xero, computed from the Wren database just now — authoritative) ---\n${body}`;
}

module.exports = {
  buildFinancialFacts, financialOverview, staffingScenario, occupancyForMargin,
  feeIncreaseImpact, spendOutliers, cashPosition, debtors, pnlPeriods,
  classifyLine, missingMonths, sourceLabel, FINANCE_RX,
};
