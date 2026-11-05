'use strict';
/**
 * finance-intel.js — b204 (2026-08-19)
 *
 * The manager-only financial intelligence API. Everything here is a READ or a
 * SYNC: there is deliberately no endpoint that books, pays, invoices or changes
 * a fee, and there never should be. The module it wraps (src/lib/finance-facts.js)
 * returns figures and workings; deciding what to do with them is a person's job.
 *
 *   GET  /api/finance/intel/overview     revenue, cost, margin, cost per child, break-even
 *   GET  /api/finance/intel/periods      what has synced, what is partial, what is missing
 *   GET  /api/finance/intel/staffing     margin effect of a change in establishment
 *   GET  /api/finance/intel/occupancy    occupancy needed for a target margin, per room
 *   GET  /api/finance/intel/fees         fee-increase modelling against b203 market data
 *   GET  /api/finance/intel/spend        cost lines rising faster than income
 *   GET  /api/finance/intel/cash         cash, debtor ageing, debtor days, chase list
 *   GET  /api/finance/intel/brief        all of the above in one call (the Roost panel)
 *   GET  /api/finance/intel/facts        the exact text the assistant is grounded in
 *   POST /api/finance/intel/sync         pull the Xero reports now
 *   POST /api/finance/intel/backfill     materialise periods from monthly balances
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Manager role AND the admin (Roost) portal, both enforced here, server-side.
 * The role check alone is not enough: a manager signing in on the EY portal gets
 * a token with audience 'learning', which passes requireRole('manager') on every
 * shared route. This is commercial data about a business and the people in it —
 * it belongs on one portal, so the portal is checked too.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const facts = require('../lib/finance-facts');
const payrollCosts = require('../lib/payroll-costs');
const { canViewSalaries } = require('../lib/capabilities');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// ── the guard ────────────────────────────────────────────────────────────────
// req._portal is set by the hostname dispatcher in editions/ladn/server-unified.js.
// A request that arrives without one is not from a portal we recognise and is
// refused rather than defaulted — failing open on a finance route is not a
// trade-off worth making.
function managerAdminOnly(req, res, next) {
  const portal = req._portal || null;
  if (portal !== 'admin') {
    return res.status(403).json({
      error: 'forbidden_portal',
      message: 'Financial intelligence is available on the Roost (admin) portal only.',
    });
  }
  if (!req.user || !hasRole(req.user, ['manager', 'admin'])) {
    return res.status(403).json({
      error: 'forbidden_role',
      message: 'Manager access only — these figures are commercially sensitive.',
    });
  }
  next();
}

// ── b301: pay is a second gate on top of the portal + role one ──────────────
// Passing managerAdminOnly is not the same as being allowed to see the wage bill.
// Since b271 staff.role 'manager' means the FLOOR manager — the room leader, a practitioner, the deputy —
// who read the Finance section and must not see their colleagues' pay. The salary
// capability is resolved once per request and every payroll figure hangs off it.
async function attachPayVisibility(req, _res, next) {
  try {
    req._canSeePay = await canViewSalaries(req.user);
  } catch {
    req._canSeePay = false;          // fail closed, as capabilities.js does
  }
  next();
}

/** 403 unless this request may see pay. For the payroll-only endpoints. */
function requirePayView(req, res, next) {
  if (req._canSeePay) return next();
  return res.status(403).json({
    error: 'salary_view_forbidden',
    message: 'Staff pay is restricted to the owner and finance roles. Hours are available on '
           + 'Staff → Payroll.',
  });
}

const guard = [authenticate, managerAdminOnly, attachPayVisibility];
const payGuard = [authenticate, managerAdminOnly, attachPayVisibility, requirePayView];

const intParam = (v, def, min, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const floatParam = (v, def, min, max) => {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

// Every response carries the same standing caveat, so it is impossible to read
// one of these payloads without the rule that governs it.
const ADVISORY = 'Wren advises. It does not book, pay, invoice, change a fee or alter a rota, and no '
               + 'endpoint here can. Figures are only ever quoted with the period they came from; a period '
               + 'that has not synced is reported as no data and is never estimated.';

function wrap(handler) {
  return async (req, res) => {
    try {
      const payload = await handler(getPool(), req);
      res.json({ ...payload, advisory: ADVISORY, generated_at: new Date().toISOString() });
    } catch (e) {
      console.error('[finance-intel]', req.path, e.message);
      res.status(500).json({ error: 'intel_failed', message: e.message });
    }
  };
}

// ── reads ────────────────────────────────────────────────────────────────────
router.get('/overview', guard, wrap((db, req) =>
  facts.financialOverview(db, { months: intParam(req.query.months, 6, 1, 24),
                                includePayroll: req._canSeePay })));

// ── b301: payroll, as a first-class Finance figure ──────────────────────────
/**
 * GET /api/finance/intel/payroll
 *
 * Wren's own payroll runs as monthly staff cost, next to the revenue of the same
 * month, with the run id on every row so the Finance table can drill through to
 * the run that produced it.
 *
 * This is the endpoint the "Salary Cost Ratio" tile should always have been
 * reading. Before b301 that tile showed ytdExpenses / ytdRevenue — every expense
 * over revenue — under a salary label.
 */
router.get('/payroll', payGuard, wrap(async (db, req) => {
  const months = intParam(req.query.months, 12, 1, 36);
  const [runs, periods, readiness] = await Promise.all([
    payrollCosts.payrollMonths(db, { limit: months }),
    facts.pnlPeriods(db, { limit: Math.max(months, 24) }),
    // b303 — counts only, never a name. See payrollReadiness().
    payrollCosts.payrollReadiness(db),
  ]);
  const revenue = new Map(periods.map(p => [p.month, p]));

  const rows = runs.map(r => {
    const p = revenue.get(r.month);
    return {
      ...r,
      gross_gbp: r.gross_pence / 100,
      employer_ni_gbp: r.employer_ni_pence / 100,
      employer_cost_gbp: r.employer_cost_pence / 100,
      revenue_gbp: p ? p.revenue_pence / 100 : null,
      revenue_cite: p ? p.cite : null,
      revenue_partial: p ? p.partial : null,
      // Null, not zero, when the month has not synced: a ratio against no revenue
      // is not 0% and it is not 100%, it is unknown.
      cost_to_revenue_pct: (p && p.revenue_pence)
        ? Math.round((r.employer_cost_pence / p.revenue_pence) * 1000) / 10
        : null,
      xero_staff_cost_gbp: p ? p.staff_pence / 100 : null,
      variance_vs_xero_gbp: p ? (p.staff_pence - r.employer_cost_pence) / 100 : null,
    };
  });

  const withRevenue = rows.filter(r => r.cost_to_revenue_pct != null);
  const totalCost = withRevenue.reduce((s, r) => s + r.employer_cost_pence, 0);
  const totalRev = withRevenue.reduce((s, r) => s + r.revenue_gbp * 100, 0);

  return {
    runs: rows,
    months_with_a_run: rows.length,
    months_comparable: withRevenue.length,
    // The ratio, computed from real payroll and stated as such.
    staff_cost_to_revenue_pct: totalRev
      ? Math.round((totalCost / totalRev) * 1000) / 10 : null,
    staff_cost_source: "ladn.payroll_runs — Wren's own payroll, not a Xero expense category",
    revenue_source: 'finance_pnl_periods — the Xero P&L, per month',
    // b303: whether payroll CAN be run properly for the people currently on the
    // books, as counts and a link. A tax code or employee statement missing for
    // somebody with a live contract is a real payroll problem and this is where
    // Finance says so. No staff member is named here or anywhere downstream.
    readiness,
    basis: payrollCosts.BASIS,
    excludes: payrollCosts.EXCLUDES,
    drill_through: 'Each row carries run_id. GET /api/payroll/runs/:run_id for the lines '
                 + 'behind it (that route masks pay for anyone without view_staff_salaries).',
    note: rows.length
      ? null
      : 'No payroll run exists yet. Staff → Payroll → Generate creates one; until then Finance '
        + 'has no Wren staff-cost figure and will not infer one from Xero account names.',
  };
}));

router.get('/staffing', guard, wrap((db, req) =>
  facts.staffingScenario(db, {
    deltaFte: floatParam(req.query.delta_fte, 0, -20, 20),
    months: intParam(req.query.months, 6, 1, 24),
  })));

router.get('/occupancy', guard, wrap((db, req) =>
  facts.occupancyForMargin(db, {
    targetMarginPct: floatParam(req.query.target_margin_pct, 15, -50, 90),
    months: intParam(req.query.months, 6, 1, 24),
  })));

router.get('/fees', guard, wrap((db, req) =>
  facts.feeIncreaseImpact(db, {
    increasePct: floatParam(req.query.increase_pct, 5, -20, 50),
    months: intParam(req.query.months, 6, 1, 24),
  })));

router.get('/spend', guard, wrap((db, req) =>
  facts.spendOutliers(db, { window: intParam(req.query.window, 3, 1, 12) })));

router.get('/cash', guard, wrap((db, req) =>
  facts.cashPosition(db, { months: intParam(req.query.months, 6, 1, 24) })));

/** What has actually synced — the honest state of the data behind everything else. */
router.get('/periods', guard, wrap(async (db, req) => {
  const periods = await facts.pnlPeriods(db, { limit: intParam(req.query.limit, 24, 1, 60) });
  const { rows: runs } = await db.query(
    `SELECT id, started_at, finished_at, status, months_requested, periods_upserted,
            lines_upserted, aged_rows, skipped_periods, error_message, triggered_by
       FROM finance_report_sync_runs ORDER BY id DESC LIMIT 5`).catch(() => ({ rows: [] }));
  const { rows: bs } = await db.query(
    `SELECT period_to, period_label, source FROM finance_pnl_periods
      WHERE report_type='balance_sheet' ORDER BY period_to DESC LIMIT 3`).catch(() => ({ rows: [] }));
  return {
    pnl_periods: periods.map(p => ({
      month: p.month, cite: p.cite, source: p.source, partial: p.partial,
      lines: p.lines.length, revenue_gbp: p.revenue_pence / 100, synced_at: p.synced_at,
    })),
    balance_sheets: bs,
    gaps: facts.missingMonths(periods),
    recent_runs: runs,
    note: 'A month absent from pnl_periods has no data. Nothing downstream fills it in.',
  };
}));

/** The exact grounding text the assistant receives — visible so it can be checked. */
router.get('/facts', guard, wrap(async (db, req) => {
  const q = String(req.query.q || 'how are we doing financially?');
  const text = await facts.buildFinancialFacts(db, q, { isManager: true });
  return { question: q, triggered: !!text, block: text || '(this question does not trigger the financial block)' };
}));

/** Everything the Roost panel needs, in one round trip. */
router.get('/brief', guard, wrap(async (db, req) => {
  const months = intParam(req.query.months, 6, 1, 24);
  const [overview, staffing, occupancy, fees, spend, cash] = await Promise.all([
    facts.financialOverview(db, { months, includePayroll: req._canSeePay }),
    facts.staffingScenario(db, { months }).catch(e => ({ available: false, reason: e.message })),
    facts.occupancyForMargin(db, { targetMarginPct: floatParam(req.query.target_margin_pct, 15, -50, 90), months })
      .catch(e => ({ available: false, reason: e.message })),
    facts.feeIncreaseImpact(db, { increasePct: floatParam(req.query.increase_pct, 5, -20, 50), months })
      .catch(e => ({ available: false, reason: e.message })),
    facts.spendOutliers(db, { window: intParam(req.query.window, 3, 1, 12) })
      .catch(e => ({ available: false, reason: e.message })),
    facts.cashPosition(db, { months }).catch(e => ({ cash: { available: false, reason: e.message } })),
  ]);
  // b301: the payroll block rides along on the brief so the Finance tab needs one
  // round trip, and is absent entirely — not blanked — when pay is not visible.
  let payroll = null;
  if (req._canSeePay) {
    const runs = await payrollCosts.payrollMonths(db, { limit: Math.max(months, 12) });
    const periods = await facts.pnlPeriods(db, { limit: Math.max(months, 24) });
    const rev = new Map(periods.map(p => [p.month, p]));
    payroll = {
      available: runs.length > 0,
      runs: runs.map(r => ({
        ...r,
        employer_cost_gbp: r.employer_cost_pence / 100,
        revenue_gbp: rev.has(r.month) ? rev.get(r.month).revenue_pence / 100 : null,
        cost_to_revenue_pct: (rev.get(r.month) && rev.get(r.month).revenue_pence)
          ? Math.round((r.employer_cost_pence / rev.get(r.month).revenue_pence) * 1000) / 10
          : null,
      })),
      basis: payrollCosts.BASIS,
      excludes: payrollCosts.EXCLUDES,
      reason: runs.length ? null : 'No payroll run exists yet — Staff → Payroll → Generate.',
    };
  }
  return { overview, staffing, occupancy, fees, spend, cash, payroll,
           pay_visible: !!req._canSeePay };
}));

// ── syncs (still not actions on the business — they only fetch) ──────────────
router.post('/sync', guard, wrap(async (db, req) => {
  const months = intParam(req.body && req.body.months, null, 1, 36);
  const result = await require('../lib/xero-reports').syncXeroReports({
    months: months || undefined,
    triggered_by: String((req.user && req.user.id) || 'manual'),
  });
  return { sync: result };
}));

router.post('/backfill', guard, wrap(async (db, req) => {
  const months = intParam(req.body && req.body.months, 24, 1, 120);
  const result = await require('../lib/xero-reports').backfillFromMonthlyBalances({ db, months });
  return { backfill: result };
}));

module.exports = router;
