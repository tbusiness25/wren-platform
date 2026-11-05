'use strict';
/**
 * finance-pnl.js — b365 (2026-09-29)
 *
 * Toby: "A full Xero port in Wren Finance, so we can see all transactions and do
 * budgets etc linked to staff wages etc. It's mostly used for P&L, so add staff
 * wages and Wren data — fees etc for the wider picture."
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * One month-by-month table with THREE independent columns of truth, never one
 * standing in for another:
 *
 *   Xero     the accounts. Income and expense lines from ladn.finance_pnl_lines,
 *            mirrored by b204 / the nightly report sync.
 *   Wren     the ledger. Fee income by INVOICE PERIOD (b365 part 1), fees
 *            billed, funding netted off, and the wage bill from payroll_runs.
 *   Budget   what a person typed, in ladn.finance_budget_lines.
 *
 * ── THE RULES THAT KEEP IT HONEST ───────────────────────────────────────────
 *
 * 1. A missing figure is NULL and says why. It is never 0. b301's finding is
 *    the reason: a wage bill rendered as "0% of revenue" is a wrong figure,
 *    where an absent one is a withheld one, and only the second is safe.
 *
 * 2. Employer cost = gross + employer NI. Employee tax/NI/pension come OUT of
 *    gross and are already inside it. Employer PENSION is not modelled by Wren
 *    at all, so the figure understates true cost and every response says so.
 *
 * 3. A partial month is flagged and excluded from every average (b204: July
 *    2026's balances synced on the 9th and read as a £15k loss).
 *
 * 4. Xero and Wren are shown side by side and are NOT reconciled into a single
 *    number. Where they disagree, Xero is the accounts and Wren is the ledger,
 *    and the disagreement is the interesting part.
 *
 * 5. Nothing here calls Xero and nothing here writes to Xero. It reads the local
 *    mirror. The sync is src/services/xero-txn-sync.js; the push guard (b226) is
 *    untouched.
 */

const AP = require('./allocation-period');

const num   = v => (v == null ? 0 : Number(v) || 0);
const pence = v => Math.round(num(v));
const gbp   = p => (p == null ? null : Number((num(p) / 100).toFixed(2)));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
const monthKey   = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const monthLabel = (y, m) => `${MONTHS[m - 1]} ${y}`;

/** Accounts whose NAME says "this is what the staff cost". Same regex as b301. */
const STAFF_COST_RX = /salar|wage|payroll|pension|national insurance|\bni\b/i;

function partialFlag(y, m, today = new Date()) {
  const ty = today.getFullYear(), tm = today.getMonth() + 1;
  if (y > ty || (y === ty && m > tm)) {
    return { partial: true, reason: 'Future month — not yet traded.' };
  }
  if (y === ty && m === tm) {
    const lastDay = new Date(y, m, 0).getDate();
    return { partial: true, reason: `Current month — ${today.getDate()} of ${lastDay} days elapsed.` };
  }
  return { partial: false, reason: null };
}

/** The last `months` months, newest first, ending with the current month. */
function monthWindow(months, today = new Date()) {
  const out = [];
  let y = today.getFullYear(), m = today.getMonth() + 1;
  for (let i = 0; i < months; i++) {
    out.push({ year: y, month: m, key: monthKey(y, m), label: monthLabel(y, m) });
    m--; if (m === 0) { m = 12; y--; }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// XERO SIDE
// ─────────────────────────────────────────────────────────────────────────────
async function xeroByMonth(db, from, to) {
  const { rows } = await db.query(`
    SELECT EXTRACT(year  FROM p.period_from)::int AS y,
           EXTRACT(month FROM p.period_from)::int AS m,
           p.source, p.is_partial, p.partial_reason, p.synced_at,
           l.section, l.account_name, l.amount_pence
      FROM finance_pnl_periods p
      JOIN finance_pnl_lines   l ON l.period_id = p.id
     WHERE p.period_from >= $1::date AND p.period_from <= $2::date
     ORDER BY p.period_from DESC, l.section, l.sort_order NULLS LAST, l.account_name`,
    [from, to]);

  const byMonth = new Map();
  for (const r of rows) {
    const key = monthKey(r.y, r.m);
    if (!byMonth.has(key)) {
      byMonth.set(key, {
        available: true, source: r.source, synced_at: r.synced_at,
        xero_partial: r.is_partial === true, xero_partial_reason: r.partial_reason,
        income: [], expense: [], income_pence: 0, expense_pence: 0, staff_pence: 0,
      });
    }
    const mo = byMonth.get(key);
    const isIncome = /income|revenue|turnover|sales/i.test(r.section || '');
    const line = { section: r.section, account_name: r.account_name,
                   line_key: String(r.account_name || '').trim().toLowerCase(),
                   amount_pence: pence(r.amount_pence) };
    if (isIncome) { mo.income.push(line);  mo.income_pence  += line.amount_pence; }
    else          { mo.expense.push(line); mo.expense_pence += line.amount_pence;
                    if (STAFF_COST_RX.test(r.account_name || '')) mo.staff_pence += line.amount_pence; }
  }
  for (const mo of byMonth.values()) mo.net_pence = mo.income_pence - mo.expense_pence;
  return byMonth;
}

// ─────────────────────────────────────────────────────────────────────────────
// WREN SIDE
// ─────────────────────────────────────────────────────────────────────────────
/** Fee income RECEIVED, by the period of the invoice it pays (b365 part 1). */
async function feesReceivedByPeriod(db) {
  const { rows } = await db.query(`
    SELECT period_year AS y, period_month AS m,
           SUM(amount_pence) AS pence, count(DISTINCT payment_id) AS payments
      FROM v_allocation_periods
     WHERE period_year IS NOT NULL AND period_month IS NOT NULL
       AND (payment_status IS NULL OR payment_status NOT IN ('failed','cancelled','refunded'))
     GROUP BY 1, 2`);
  const map = new Map();
  for (const r of rows) map.set(monthKey(r.y, r.m), { pence: pence(r.pence), payments: num(r.payments) });
  return map;
}

/**
 * Fees BILLED and funding netted off, by service period — the accrual side, so
 * the P&L can be read against Xero (which is on an accrual basis) rather than
 * only against the bank. Credit notes are excluded, drafts are excluded: a bill
 * nobody has seen is not income.
 */
async function billedByPeriod(db) {
  const { rows } = await db.query(`
    SELECT ap.period_year AS y, ap.period_month AS m,
           count(*)                                              AS invoices,
           COALESCE(SUM(i.amount_pence), 0)                      AS net_pence,
           COALESCE(SUM(COALESCE(i.gross_amount_pence, i.amount_pence)), 0) AS gross_pence,
           COALESCE(SUM(COALESCE(i.funding_reduction_pence, i.funding_deduction_pence, 0)), 0) AS funding_pence
      FROM invoices i
      ${AP.PERIOD_SQL}
     WHERE i.credit_note_for_id IS NULL
       AND COALESCE(i.status, '') NOT IN ('draft', 'void', 'cancelled')
       AND ap.period_year IS NOT NULL
     GROUP BY 1, 2`);
  const map = new Map();
  for (const r of rows) {
    map.set(monthKey(r.y, r.m), {
      invoices: num(r.invoices), net_pence: pence(r.net_pence),
      gross_pence: pence(r.gross_pence), funding_pence: pence(r.funding_pence),
    });
  }
  return map;
}

/**
 * The wage bill, from Wren's own payroll runs.
 *
 * Delegated to src/lib/payroll-costs.js rather than re-queried here, ON PURPOSE.
 * That module is b301's single definition of employer cost, including the NI
 * back-fill for runs generated before employer NI had a column — and the Finance
 * → Intelligence tab already reads it. A second query here would have quietly
 * disagreed with that tab by exactly the employer NI: measured on wren_dev
 * 2026-09-29, June 2026 read £33,173 here and £34,080.50 there.
 *
 * Returns an empty Map when payroll has never been run — never a zero, which
 * would read as "we spent nothing on staff".
 */
async function payrollByMonth(db) {
  const costs = require('./payroll-costs');
  const src = await costs.payrollByMonth(db, { limit: 36 }).catch(() => new Map());
  const map = new Map();
  for (const [key, m] of src) {
    map.set(key, {
      run_id: m.run_id, status: m.status, staff_count: m.staff_count,
      gross_pence: m.gross_pence,
      employer_ni_pence: m.employer_ni_pence,
      employer_cost_pence: m.employer_cost_pence,
      // b301's own word for it: the figure is real, but it was recomputed from
      // the run total rather than stored per line, so it is slightly generous.
      employer_ni_missing: !m.employer_ni_stored,
      employee_pension_pence: m.employee_pension_pence,
    });
  }
  return map;
}

async function budgetByMonth(db) {
  const { rows } = await db.query(`
    SELECT period_year AS y, period_month AS m, section, line_key, line_label, budget_pence, note
      FROM finance_budget_lines`);
  const map = new Map();
  for (const r of rows) {
    const key = monthKey(r.y, r.m);
    if (!map.has(key)) map.set(key, { lines: {}, income_pence: 0, expense_pence: 0 });
    const b = map.get(key);
    b.lines[`${r.section}|${r.line_key}`] = {
      section: r.section, line_key: r.line_key, line_label: r.line_label,
      budget_pence: pence(r.budget_pence), note: r.note,
    };
    if (r.section === 'income') b.income_pence += pence(r.budget_pence);
    else                        b.expense_pence += pence(r.budget_pence);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TABLE
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {object} db
 * @param {object} opts { months = 12, includePayroll = false, today }
 *   includePayroll is the b301 SECOND gate: passing the finance manager+portal
 *   guard is not the same as being allowed to see the wage bill. When it is
 *   false the payroll block is OMITTED, not zeroed.
 */
async function profitAndLoss(db, { months = 12, includePayroll = false, today = new Date() } = {}) {
  const n = Math.max(1, Math.min(36, months));
  const window = monthWindow(n, today);
  const oldest = window[window.length - 1];
  const from = `${oldest.year}-${String(oldest.month).padStart(2, '0')}-01`;
  const to   = `${window[0].year}-${String(window[0].month).padStart(2, '0')}-01`;

  const [xero, fees, billed, payroll, budget] = await Promise.all([
    xeroByMonth(db, from, to),
    feesReceivedByPeriod(db),
    billedByPeriod(db),
    includePayroll ? payrollByMonth(db) : Promise.resolve(new Map()),
    budgetByMonth(db),
  ]);

  const rows = window.map(w => {
    const p = partialFlag(w.year, w.month, today);
    const x = xero.get(w.key) || null;
    const f = fees.get(w.key)   || null;
    const b = billed.get(w.key) || null;
    const pr = includePayroll ? (payroll.get(w.key) || null) : null;
    const bud = budget.get(w.key) || null;

    const wrenIncome = b ? b.net_pence : (f ? f.pence : null);
    const staffCost = pr ? pr.employer_cost_pence : null;

    return {
      month: w.key, label: w.label, year: w.year, month_number: w.month,
      partial: p.partial, partial_reason: p.reason,
      xero: x ? {
        available: true, source: x.source, synced_at: x.synced_at,
        xero_partial: x.xero_partial, xero_partial_reason: x.xero_partial_reason,
        income_pence: x.income_pence, expense_pence: x.expense_pence, net_pence: x.net_pence,
        staff_cost_pence: x.staff_pence,
        income: x.income, expense: x.expense,
      } : { available: false, reason: 'No Xero period has been synced for this month.' },
      wren: {
        fees_received_pence: f ? f.pence : 0,
        fees_received_payments: f ? f.payments : 0,
        fees_billed_pence: b ? b.net_pence : null,
        fees_billed_gross_pence: b ? b.gross_pence : null,
        funding_income_pence: b ? b.funding_pence : null,
        invoices: b ? b.invoices : 0,
        income_pence: wrenIncome,
        basis_note: 'fees_received is money in, counted in the month of the INVOICE it pays. fees_billed is what '
                  + 'was invoiced for that month\'s care, excluding drafts and credit notes. The two differ by '
                  + 'what is still owed.',
      },
      payroll: includePayroll
        ? (pr ? {
            available: true, run_id: pr.run_id, status: pr.status, staff_count: pr.staff_count,
            gross_pence: pr.gross_pence, employer_ni_pence: pr.employer_ni_pence,
            employer_cost_pence: pr.employer_cost_pence,
            employer_ni_estimated: pr.employer_ni_missing,
          } : { available: false, reason: 'No payroll run covers this month — shown as absent, never as £0.' })
        : null,
      budget: bud ? { income_pence: bud.income_pence, expense_pence: bud.expense_pence,
                      net_pence: bud.income_pence - bud.expense_pence, lines: bud.lines }
                  : { income_pence: 0, expense_pence: 0, net_pence: 0, lines: {} },
      variance: (x && bud && (bud.income_pence || bud.expense_pence)) ? {
        income_pence: x.income_pence - bud.income_pence,
        expense_pence: x.expense_pence - bud.expense_pence,
        net_pence: (x.income_pence - x.expense_pence) - (bud.income_pence - bud.expense_pence),
      } : null,
      wage_ratio_pct: (staffCost != null && wrenIncome)
        ? Number(((staffCost / wrenIncome) * 100).toFixed(1)) : null,
    };
  });

  const usable = rows.filter(r => !r.partial && r.xero.available && !r.xero.xero_partial);
  const avg = (pick) => {
    const vals = usable.map(pick).filter(v => v != null);
    return vals.length ? Math.round(vals.reduce((a, b2) => a + b2, 0) / vals.length) : null;
  };

  return {
    months: rows,
    complete_months_used: usable.length,
    averages: {
      xero_income_pence:  avg(r => r.xero.available ? r.xero.income_pence : null),
      xero_expense_pence: avg(r => r.xero.available ? r.xero.expense_pence : null),
      xero_net_pence:     avg(r => r.xero.available ? r.xero.net_pence : null),
      wren_fees_received_pence: avg(r => r.wren.fees_received_pence),
      wren_fees_billed_pence:   avg(r => r.wren.fees_billed_pence),
      payroll_employer_cost_pence: includePayroll
        ? avg(r => (r.payroll && r.payroll.available) ? r.payroll.employer_cost_pence : null) : null,
      basis: `Averages use the ${usable.length} month(s) that are complete AND have a non-partial Xero period. `
           + 'A half-elapsed month drags a mean down and makes a business look like it is shrinking.',
    },
    payroll_included: includePayroll,
    payroll_note: includePayroll
      ? 'Employer cost is gross + employer NI. Employee tax, NI and pension come out of gross and are already '
      + 'inside it. Employer PENSION is not modelled by Wren, so this understates true staff cost.'
      : 'Payroll figures are withheld from this response because the caller does not hold view_staff_salaries. '
      + 'They are omitted, not zeroed.',
    xero_note: 'Xero figures are a local read-only mirror (ladn.finance_pnl_periods / finance_pnl_lines). Nothing '
             + 'on this page calls Xero or writes to it. Months whose source is "xero-monthly-balances" were '
             + 'derived from monthly account balances, not from a Xero Profit & Loss report, and say so.',
    reconciliation_note: 'Xero and Wren are shown beside each other and are deliberately NOT reconciled into one '
                       + 'number. Where they disagree, Xero is the accounts and Wren is the ledger.',
    generated_at: new Date().toISOString(),
  };
}

/**
 * Every distinct P&L line name in the window, so the budget editor can offer the
 * rows that actually exist in this business rather than a generic chart.
 */
async function budgetTemplate(db, { months = 12, today = new Date() } = {}) {
  const window = monthWindow(Math.max(1, Math.min(36, months)), today);
  const oldest = window[window.length - 1];
  const { rows } = await db.query(`
    SELECT DISTINCT l.section, l.account_name
      FROM finance_pnl_periods p JOIN finance_pnl_lines l ON l.period_id = p.id
     WHERE p.period_from >= $1::date
     ORDER BY l.section, l.account_name`,
    [`${oldest.year}-${String(oldest.month).padStart(2, '0')}-01`]);
  return rows.map(r => ({
    section: /income|revenue|turnover|sales/i.test(r.section || '') ? 'income' : 'expense',
    xero_section: r.section,
    line_key: String(r.account_name || '').trim().toLowerCase(),
    line_label: r.account_name,
  }));
}

module.exports = {
  profitAndLoss, budgetTemplate, monthWindow, partialFlag,
  xeroByMonth, feesReceivedByPeriod, billedByPeriod, payrollByMonth, budgetByMonth,
  STAFF_COST_RX, gbp, monthKey, monthLabel,
};
