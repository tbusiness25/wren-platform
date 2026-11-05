'use strict';
/**
 * finance-pnl.js — b365 (2026-09-29)  ·  mounted at /api/finance/pnl
 *
 * Finance → P&L. Xero's income and expense lines by month, Wren's own fee and
 * funding income beside them, the wage bill from payroll_runs, and a budget
 * column a manager can type into.
 *
 *   GET    /                   the month-by-month table
 *   GET    /transactions       the local Xero transaction mirror, filterable
 *   GET    /budget             budget lines + the line names that exist
 *   PUT    /budget             save one or more budget figures
 *   POST   /sync-transactions  refresh the mirror from Xero (a READ of Xero)
 *   GET    /sync-status        when the mirror last ran, and why it stopped
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Manager role AND the admin (Roost) portal, both server-side — the same guard
 * as finance-reports.js and for the same reason: a manager signing in on the EY
 * portal holds a token with audience 'learning' and would pass requireRole
 * alone. Pay is a SECOND gate on top of that (b301): passing this guard does not
 * make you allowed to see the wage bill, so payroll is omitted — not zeroed —
 * for anyone without view_staff_salaries.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { canViewSalaries } = require('../lib/capabilities');
const pnl = require('../lib/finance-pnl');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

function managerAdminOnly(req, res, next) {
  if ((req._portal || null) !== 'admin') {
    return res.status(403).json({
      error: 'forbidden_portal',
      message: 'The P&L is available on the Roost (admin) portal only.',
    });
  }
  // b480: 'accountant' added — safe only because the accountant-scope gate in
  // server-unified.js has already restricted that role to GET requests on a
  // short allowlist (this router's paths included) before this ever runs.
  // The wage bill is a second, independent gate below (canViewSalaries) —
  // accountant never holds view_staff_salaries, so it is omitted, not zeroed.
  if (!req.user || !hasRole(req.user, ['manager', 'admin', 'accountant'])) {
    return res.status(403).json({
      error: 'forbidden_role',
      message: 'Manager access only — these are the company\'s accounts.',
    });
  }
  next();
}
const guard = [authenticate, managerAdminOnly];

const intParam = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

// ── GET / ────────────────────────────────────────────────────────────────────
router.get('/', guard, async (req, res) => {
  try {
    const includePayroll = await canViewSalaries(req.user);
    const data = await pnl.profitAndLoss(getPool(), {
      months: intParam(req.query.months, 12, 1, 36),
      includePayroll,
    });
    res.json(data);
  } catch (e) {
    console.error('finance-pnl:', e.message);
    res.status(500).json({ error: 'pnl_failed', message: e.message });
  }
});

// ── GET /transactions ────────────────────────────────────────────────────────
// ?months=6 &direction=in|out &kind=bank_transaction|bill|sales_invoice
// &contact=<substring> &limit=200
//
// `contact` is a supplier name, not a family name: these rows are Xero's
// purchase and bank ledger. Wren's own parent payments are on the Payments tab,
// which is where a family's money belongs.
router.get('/transactions', guard, async (req, res) => {
  const db = getPool();
  try {
    const months = intParam(req.query.months, 6, 1, 120);
    const params = [months];
    let where = `t.txn_date >= (date_trunc('month', CURRENT_DATE) - make_interval(months => $1::int - 1))`;
    if (['in', 'out'].includes(req.query.direction)) {
      params.push(req.query.direction); where += ` AND t.direction = $${params.length}`;
    }
    if (['bank_transaction', 'bill', 'sales_invoice'].includes(req.query.kind)) {
      params.push(req.query.kind); where += ` AND t.kind = $${params.length}`;
    }
    if (req.query.contact) {
      params.push(`%${String(req.query.contact).slice(0, 80).toLowerCase()}%`);
      where += ` AND lower(t.contact_name) LIKE $${params.length}`;
    }
    params.push(intParam(req.query.limit, 200, 1, 2000));

    const { rows } = await db.query(`
      SELECT t.id, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.kind, t.xero_type, t.direction,
             t.contact_name, t.reference, t.description, t.account_code, t.account_name,
             t.total_pence, t.currency, t.status, t.is_reconciled
        FROM xero_transactions t
       WHERE ${where}
       ORDER BY t.txn_date DESC NULLS LAST, t.id DESC
       LIMIT $${params.length}`, params);

    const { rows: [tot] } = await db.query(`
      SELECT COALESCE(SUM(total_pence) FILTER (WHERE direction='out'), 0) AS out_pence,
             COALESCE(SUM(total_pence) FILTER (WHERE direction='in'),  0) AS in_pence,
             count(*) AS n
        FROM xero_transactions t WHERE ${where}`, params.slice(0, params.length - 1));

    res.json({
      transactions: rows, months,
      totals: { count: Number(tot.n), out_pence: Number(tot.out_pence), in_pence: Number(tot.in_pence) },
      note: 'A read-only local mirror of Xero. Nothing on this screen writes to Xero. An empty list means the '
          + 'mirror has not been synced, not that the business had no transactions — see /sync-status.',
    });
  } catch (e) {
    res.status(500).json({ error: 'transactions_failed', message: e.message });
  }
});

// ── GET /budget ──────────────────────────────────────────────────────────────
router.get('/budget', guard, async (req, res) => {
  const db = getPool();
  try {
    const months = intParam(req.query.months, 12, 1, 36);
    const [template, byMonth] = await Promise.all([
      pnl.budgetTemplate(db, { months }),
      pnl.budgetByMonth(db),
    ]);
    const window = pnl.monthWindow(months);
    res.json({
      lines: template,
      months: window.map(w => ({
        month: w.key, label: w.label,
        budget: byMonth.get(w.key) || { lines: {}, income_pence: 0, expense_pence: 0 },
      })),
      note: 'Budget figures live in Wren (ladn.finance_budget_lines) and are never pushed to Xero. The line '
          + 'names offered are the ones this business actually has on its P&L, not a generic chart of accounts.',
    });
  } catch (e) {
    res.status(500).json({ error: 'budget_failed', message: e.message });
  }
});

// ── PUT /budget ──────────────────────────────────────────────────────────────
// { lines: [{ period_year, period_month, section, line_key, line_label, budget_pence, note }] }
// Upsert only. A budget is a person's own figure, so it is never derived, never
// defaulted and never overwritten by a sync.
router.put('/budget', guard, async (req, res) => {
  const db = getPool();
  const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : null;
  if (!lines) return res.status(400).json({ error: 'bad_request', message: 'Expected { lines: [...] }' });
  if (lines.length > 500) return res.status(400).json({ error: 'too_many', message: 'At most 500 lines per save.' });
  try {
    let saved = 0;
    for (const l of lines) {
      const y = parseInt(l.period_year, 10);
      const m = parseInt(l.period_month, 10);
      const section = l.section === 'income' ? 'income' : 'expense';
      const key = String(l.line_key || '').trim().toLowerCase().slice(0, 200);
      if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12 || !key) continue;
      const amount = Math.round(Number(l.budget_pence) || 0);
      await db.query(`
        INSERT INTO finance_budget_lines
          (period_year, period_month, section, line_key, line_label, budget_pence, note, updated_by, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
        ON CONFLICT (period_year, period_month, section, line_key) DO UPDATE SET
          line_label=EXCLUDED.line_label, budget_pence=EXCLUDED.budget_pence,
          note=EXCLUDED.note, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [y, m, section, key, String(l.line_label || key).slice(0, 200), amount,
         l.note ? String(l.note).slice(0, 500) : null, req.user.id]);
      saved++;
    }
    recordAudit({ req, action: 'update', entity_type: 'finance_budget', meta: { lines: saved } });
    res.json({ ok: true, saved });
  } catch (e) {
    res.status(500).json({ error: 'budget_save_failed', message: e.message });
  }
});

// ── POST /sync-transactions ──────────────────────────────────────────────────
router.post('/sync-transactions', guard, async (req, res) => {
  try {
    const { syncTransactions } = require('../services/xero-txn-sync');
    const result = await syncTransactions({
      months: intParam(req.body && req.body.months, 24, 1, 120),
      triggeredBy: `roost:${req.user.id}`,
    });
    res.status(result.ok ? 200 : 502).json(result);
  } catch (e) {
    res.status(500).json({ error: 'sync_failed', message: e.message });
  }
});

// ── GET /sync-status ─────────────────────────────────────────────────────────
// What the mirror knows and when it last managed to ask. A screen that shows an
// empty transaction list has to be able to say WHY it is empty.
router.get('/sync-status', guard, async (req, res) => {
  const db = getPool();
  try {
    const { rows: runs } = await db.query(
      `SELECT id, started_at, finished_at, status, from_date, transactions, bills, sales,
              http_status, error_message, triggered_by
         FROM xero_txn_sync_runs ORDER BY id DESC LIMIT 5`);
    const { rows: [mirror] } = await db.query(
      `SELECT count(*) AS n, min(txn_date) AS oldest, max(txn_date) AS newest, max(synced_at) AS last_synced
         FROM xero_transactions`);
    const { rows: [prov] } = await db.query(
      `SELECT id, display_name, tenant_id IS NOT NULL AS has_tenant, last_sync_at, last_sync_status
         FROM finance_providers WHERE provider='xero' AND is_active=true
         ORDER BY (tenant_id IS NOT NULL) DESC, id DESC LIMIT 1`);
    const { rows: [periods] } = await db.query(
      `SELECT count(*) AS n, max(synced_at) AS last_synced,
              count(*) FILTER (WHERE source <> 'xero') AS derived
         FROM finance_pnl_periods`);
    res.json({
      connection: prov || null,
      transaction_mirror: {
        rows: Number(mirror.n),
        oldest: mirror.oldest ? String(mirror.oldest).slice(0, 10) : null,
        newest: mirror.newest ? String(mirror.newest).slice(0, 10) : null,
        last_synced: mirror.last_synced,
      },
      pnl_mirror: {
        periods: Number(periods.n), last_synced: periods.last_synced,
        derived_periods: Number(periods.derived),
        derived_note: Number(periods.derived)
          ? `${periods.derived} of ${periods.n} periods were derived from Xero monthly account balances rather `
            + 'than from a Xero Profit & Loss report (b204). They are real Xero figures, but they are not the '
            + 'report, and each one says so in its label.'
          : null,
      },
      recent_runs: runs,
    });
  } catch (e) {
    res.status(500).json({ error: 'status_failed', message: e.message });
  }
});

module.exports = router;
