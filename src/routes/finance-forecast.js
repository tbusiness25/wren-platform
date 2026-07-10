'use strict';
// Finance Forecast — 12 months actual + 12 months projected income.
// Mounted at /api/finance/forecast

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const managerGuard = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerGuard);

// ── GET /api/finance/forecast ─────────────────────────────────────────────────
// Returns 24-month series: prev 12 actual, next 12 forecast.
router.get('/', async (req, res) => {
  const db  = getPool();
  const now = new Date();
  try {
    // ── Historical: monthly invoice totals for last 12 months ─────────────────
    const { rows: historical } = await db.query(`
      SELECT
        period_year  AS year,
        period_month AS month,
        COALESCE(SUM(amount_pence), 0)                                      AS invoiced_pence,
        COALESCE(SUM(amount_pence) FILTER (WHERE status = 'paid'), 0)       AS paid_pence,
        COALESCE(SUM(amount_pence) FILTER (WHERE status = 'overdue'), 0)    AS overdue_pence,
        COALESCE(SUM(funding_deduction_pence), 0)                           AS funding_pence,
        COUNT(*) FILTER (WHERE status NOT IN ('draft','written_off'))        AS invoice_count
      FROM invoices
      WHERE period_year IS NOT NULL
        AND (period_year * 100 + period_month) >=
            ((EXTRACT(YEAR FROM NOW())::int - 1) * 100 + EXTRACT(MONTH FROM NOW())::int)
        AND (period_year * 100 + period_month) <
            (EXTRACT(YEAR FROM NOW())::int * 100 + EXTRACT(MONTH FROM NOW())::int)
      GROUP BY period_year, period_month
      ORDER BY period_year, period_month
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
      WHERE i.period_year IS NOT NULL
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
        EXTRACT(YEAR FROM created_at)::int  AS year,
        EXTRACT(MONTH FROM created_at)::int AS month,
        COALESCE(SUM(amount_pence), 0)      AS collected_pence
      FROM payments
      WHERE status = 'succeeded'
        AND created_at >= NOW() - INTERVAL '12 months'
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);

    // ── Forecast: current children × average monthly fee ─────────────────────
    const { rows: [feeStats] } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active_children,
        COALESCE(AVG(amount_pence) FILTER (WHERE status NOT IN ('draft','written_off','paid')
          AND created_at > NOW() - INTERVAL '3 months'), 0) AS avg_invoice_pence
      FROM invoices`);

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

    res.json({
      months,
      summary: {
        active_children:   activeKids,
        avg_monthly_fee:   Math.round(avgFee),
        monthly_forecast:  forecastBase,
        ytd_collected:     months.filter(m => m.year === now.getFullYear() && m.is_actual)
                                .reduce((s, m) => s + m.collected_pence, 0),
      },
    });
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

module.exports = router;
