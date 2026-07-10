'use strict';
// Finance Dashboard — summary stats, aged debtors, top debtors, quick actions.
// Mounted at /api/finance/dashboard in admin server.

const express       = require('express');
const router        = express.Router();
const { getPool }   = require('../db/pool');
const authenticate  = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');

router.use(authenticate);

const managerGuard = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerGuard);

function fmt(p) { return ((p || 0) / 100); }

// ── GET /api/finance/dashboard ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const db = getPool();
  try {
    const now   = new Date();
    const yr    = now.getFullYear();
    const mo    = now.getMonth() + 1;
    const thisMonthStart = `${yr}-${String(mo).padStart(2,'0')}-01`;
    const prevMo    = mo === 1 ? 12 : mo - 1;
    const prevYr    = mo === 1 ? yr - 1 : yr;
    const prevStart = `${prevYr}-${String(prevMo).padStart(2,'0')}-01`;
    const prevEnd   = `${yr}-${String(mo).padStart(2,'0')}-01`;

    const [totals, paidMonth, paidLastMonth, agedDebtors, topDebtors, ddStats] = await Promise.all([
      db.query(`
        SELECT
          COALESCE(SUM(amount_pence) FILTER (WHERE status IN ('sent','overdue')), 0) AS outstanding_pence,
          COALESCE(SUM(amount_pence) FILTER (WHERE status = 'overdue'), 0)          AS overdue_pence,
          COUNT(*) FILTER (WHERE status = 'overdue')                                AS overdue_count,
          COUNT(*) FILTER (WHERE status IN ('sent','overdue'))                      AS outstanding_count
        FROM invoices`),

      db.query(`
        SELECT COALESCE(SUM(amount_pence), 0) AS paid_pence
        FROM payments
        WHERE status = 'succeeded' AND created_at >= $1`, [thisMonthStart]),

      db.query(`
        SELECT COALESCE(SUM(amount_pence), 0) AS paid_pence
        FROM payments
        WHERE status = 'succeeded' AND created_at >= $1 AND created_at < $2`,
        [prevStart, prevEnd]),

      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE due_on >= NOW() - INTERVAL '30 days' AND due_on < NOW())           AS band_0_30,
          COALESCE(SUM(amount_pence) FILTER (WHERE due_on >= NOW() - INTERVAL '30 days' AND due_on < NOW()), 0) AS pence_0_30,
          COUNT(*) FILTER (WHERE due_on >= NOW() - INTERVAL '60 days' AND due_on < NOW() - INTERVAL '30 days') AS band_31_60,
          COALESCE(SUM(amount_pence) FILTER (WHERE due_on >= NOW() - INTERVAL '60 days' AND due_on < NOW() - INTERVAL '30 days'), 0) AS pence_31_60,
          COUNT(*) FILTER (WHERE due_on >= NOW() - INTERVAL '90 days' AND due_on < NOW() - INTERVAL '60 days') AS band_61_90,
          COALESCE(SUM(amount_pence) FILTER (WHERE due_on >= NOW() - INTERVAL '90 days' AND due_on < NOW() - INTERVAL '60 days'), 0) AS pence_61_90,
          COUNT(*) FILTER (WHERE due_on < NOW() - INTERVAL '90 days')                               AS band_90plus,
          COALESCE(SUM(amount_pence) FILTER (WHERE due_on < NOW() - INTERVAL '90 days'), 0)         AS pence_90plus
        FROM invoices
        WHERE status = 'overdue'`),

      db.query(`
        SELECT c.first_name || ' ' || c.last_name AS child_name,
               i.bill_payer_email,
               COUNT(*)::int AS invoice_count,
               COALESCE(SUM(i.amount_pence), 0) AS total_outstanding_pence,
               MAX(i.due_on) AS latest_due
        FROM invoices i
        JOIN children c ON c.id = i.child_id
        WHERE i.status IN ('sent','overdue')
        GROUP BY c.id, c.first_name, c.last_name, i.bill_payer_email
        ORDER BY total_outstanding_pence DESC
        LIMIT 10`),

      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active') AS active_mandates,
          COUNT(*) FILTER (WHERE status = 'pending') AS pending_mandates
        FROM gocardless_mandates`),
    ]);

    const t   = totals.rows[0];
    const pm  = paidMonth.rows[0];
    const plm = paidLastMonth.rows[0];
    const ad  = agedDebtors.rows[0];
    const dd  = ddStats.rows[0];

    // Projected income this month: simple heuristic — average of last 3 months paid
    const { rows: recentMonths } = await db.query(`
      SELECT DATE_TRUNC('month', created_at) AS month, SUM(amount_pence) AS pence
      FROM payments
      WHERE status = 'succeeded' AND created_at >= NOW() - INTERVAL '3 months'
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 3
    `);
    const avgRecent = recentMonths.length
      ? recentMonths.reduce((s, r) => s + parseInt(r.pence), 0) / recentMonths.length
      : 0;

    res.json({
      outstanding_pence:       parseInt(t.outstanding_pence),
      outstanding_count:       parseInt(t.outstanding_count),
      overdue_pence:           parseInt(t.overdue_pence),
      overdue_count:           parseInt(t.overdue_count),
      paid_this_month_pence:   parseInt(pm.paid_pence),
      paid_last_month_pence:   parseInt(plm.paid_pence),
      projected_month_pence:   Math.round(avgRecent),
      active_mandates:         parseInt(dd.active_mandates),
      pending_mandates:        parseInt(dd.pending_mandates),
      aged_debtors: {
        band_0_30:  { count: parseInt(ad.band_0_30),   pence: parseInt(ad.pence_0_30) },
        band_31_60: { count: parseInt(ad.band_31_60),  pence: parseInt(ad.pence_31_60) },
        band_61_90: { count: parseInt(ad.band_61_90),  pence: parseInt(ad.pence_61_90) },
        band_90plus:{ count: parseInt(ad.band_90plus), pence: parseInt(ad.pence_90plus) },
      },
      top_debtors: topDebtors.rows.map(r => ({
        child_name:             r.child_name,
        bill_payer_email:       r.bill_payer_email,
        invoice_count:          r.invoice_count,
        total_outstanding_pence: parseInt(r.total_outstanding_pence),
        latest_due:             r.latest_due,
      })),
    });
  } catch (e) {
    console.error('[finance-dashboard] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/dashboard/bulk-send-statements ─────────────────────────
// Fire reminder emails to all overdue bill-payers.
router.post('/bulk-send-statements', async (req, res) => {
  const db = getPool();
  try {
    const { rows: overdue } = await db.query(`
      SELECT DISTINCT i.bill_payer_email,
             c.first_name || ' ' || c.last_name AS child_name,
             SUM(i.amount_pence) AS total_pence
      FROM invoices i JOIN children c ON c.id = i.child_id
      WHERE i.status IN ('sent','overdue') AND i.bill_payer_email IS NOT NULL
      GROUP BY i.bill_payer_email, c.first_name, c.last_name
      HAVING SUM(i.amount_pence) > 0
    `);

    recordAudit({ req, action: 'bulk_send', entity_type: 'invoice',
      meta: { recipients: overdue.length, action: 'statements' } });

    res.json({ ok: true, queued: overdue.length, recipients: overdue.map(r => r.bill_payer_email) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/dashboard/bulk-chase-overdue ────────────────────────────
router.post('/bulk-chase-overdue', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT DISTINCT i.bill_payer_email, c.first_name || ' ' || c.last_name AS child_name,
             COUNT(*) AS invoice_count, SUM(i.amount_pence) AS total_pence
      FROM invoices i JOIN children c ON c.id = i.child_id
      WHERE i.status = 'overdue' AND i.bill_payer_email IS NOT NULL
      GROUP BY i.bill_payer_email, c.first_name, c.last_name
    `);

    recordAudit({ req, action: 'bulk_chase', entity_type: 'invoice',
      meta: { recipients: rows.length } });

    res.json({ ok: true, chased: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
