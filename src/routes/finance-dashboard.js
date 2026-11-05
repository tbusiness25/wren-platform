'use strict';
// Finance Dashboard — summary stats, aged debtors, top debtors, quick actions.
// Mounted at /api/finance/dashboard in admin server.

const express       = require('express');
const router        = express.Router();
const { getPool }   = require('../db/pool');
const authenticate  = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { familyLedger } = require('../lib/family-ledger');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

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

function fmt(p) { return ((p || 0) / 100); }

// b401 (2026-10-06) — "still owed" on an open invoice, by the same rule as
// src/lib/invoice-outstanding.js's outstandingSql(): the billed amount, less any credit
// note, less whatever payment_allocations or an unallocated linked payment already cleared.
// Unqualified/search_path on purpose, with a fallback for a schema with no
// payment_allocations table (demo editions) — this route is shared across editions.
const OUTSTANDING_FULL = `(i.amount_pence
    + COALESCE((SELECT SUM(cn.amount_pence) FROM invoices cn
                 WHERE cn.credit_note_for_id = i.id AND cn.status = 'credit_note'), 0)
    - COALESCE((SELECT SUM(a.amount_pence) FROM payment_allocations a WHERE a.invoice_id = i.id), 0)
    - COALESCE((SELECT SUM(p.amount_pence) FROM payments p
                 WHERE p.invoice_id = i.id AND p.status = 'succeeded'
                   AND NOT EXISTS (SELECT 1 FROM payment_allocations a2 WHERE a2.payment_id = p.id)), 0))`;
const OUTSTANDING_FALLBACK = `(i.amount_pence
    - COALESCE((SELECT SUM(p.amount_pence) FROM payments p
                 WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0))`;

function totalsQuery(db, expr) {
  return db.query(`
    SELECT
      COALESCE(SUM(${expr}) FILTER (WHERE i.status IN ('sent','overdue') AND i.amount_pence > 0), 0) AS outstanding_pence,
      COALESCE(SUM(${expr}) FILTER (WHERE i.status = 'overdue' AND i.amount_pence > 0), 0)           AS overdue_pence,
      COUNT(*) FILTER (WHERE i.status = 'overdue' AND i.amount_pence > 0)                             AS overdue_count,
      COUNT(*) FILTER (WHERE i.status IN ('sent','overdue') AND i.amount_pence > 0)                   AS outstanding_count
    FROM invoices i
    LEFT JOIN children c ON c.id = i.child_id
    WHERE COALESCE(c.is_demo, false) = false`);
}

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

    const [totals, paidMonth, paidLastMonth, agedDebtors, candidateDebtors, ddStats] = await Promise.all([
      totalsQuery(db, OUTSTANDING_FULL).catch(() => totalsQuery(db, OUTSTANDING_FALLBACK)),

      db.query(`
        SELECT COALESCE(SUM(p.amount_pence), 0) AS paid_pence
        FROM payments p
        LEFT JOIN children c ON c.id = p.child_id
        WHERE p.status = 'succeeded' AND p.created_at >= $1 AND COALESCE(c.is_demo, false) = false`, [thisMonthStart]),

      db.query(`
        SELECT COALESCE(SUM(p.amount_pence), 0) AS paid_pence
        FROM payments p
        LEFT JOIN children c ON c.id = p.child_id
        WHERE p.status = 'succeeded' AND p.created_at >= $1 AND p.created_at < $2
          AND COALESCE(c.is_demo, false) = false`,
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
        FROM invoices i
        LEFT JOIN children c ON c.id = i.child_id
        WHERE i.status = 'overdue' AND COALESCE(c.is_demo, false) = false`),

      // b401 — a naive, cheap top-40 by billed amount, just to bound how many children get
      // a real familyLedger() lookup below. The actual ranking/figure shown comes from that.
      db.query(`
        SELECT c.id AS child_id, c.first_name || ' ' || c.last_name AS child_name,
               i.bill_payer_email,
               COUNT(*)::int AS invoice_count,
               COALESCE(SUM(i.amount_pence), 0) AS naive_pence,
               MAX(i.due_on) AS latest_due
        FROM invoices i
        JOIN children c ON c.id = i.child_id
        WHERE i.status IN ('sent','overdue') AND i.amount_pence > 0 AND COALESCE(c.is_demo, false) = false
        GROUP BY c.id, c.first_name, c.last_name, i.bill_payer_email
        ORDER BY naive_pence DESC
        LIMIT 40`),

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
      SELECT DATE_TRUNC('month', p.created_at) AS month, SUM(p.amount_pence) AS pence
      FROM payments p
      LEFT JOIN children c ON c.id = p.child_id
      WHERE p.status = 'succeeded' AND p.created_at >= NOW() - INTERVAL '3 months'
        AND COALESCE(c.is_demo, false) = false
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 3
    `);
    const avgRecent = recentMonths.length
      ? recentMonths.reduce((s, r) => s + parseInt(r.pence), 0) / recentMonths.length
      : 0;

    // b401 — "Top debtors" by what is actually still owed (familyLedger, per child), not by
    // summing raw invoice amounts: that counted an invoice a credit note or a payment had
    // already cleared, and EyLog's imported negative "payment on account" invoices as debt.
    // Never default to 'ladn': an edition without PG_SCHEMA gets no list rather than
    // another schema's balances against its own child ids.
    const schema = process.env.PG_SCHEMA ? String(process.env.PG_SCHEMA) : null;
    const scored = !schema ? [] : await Promise.all(candidateDebtors.rows.map(async r => {
      const l = await familyLedger(db, [r.child_id], { schema }).catch(() => null);
      return l ? { ...r, balance_pence: Number(l.balance_pence) || 0 } : null;
    }));
    const topDebtorsRows = scored
      .filter(r => r && r.balance_pence > 0)
      .sort((a, b) => b.balance_pence - a.balance_pence)
      .slice(0, 10);

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
      top_debtors: topDebtorsRows.map(r => ({
        child_name:              r.child_name,
        bill_payer_email:        r.bill_payer_email,
        invoice_count:           r.invoice_count,
        total_outstanding_pence: r.balance_pence,
        latest_due:              r.latest_due,
      })),
    });
  } catch (e) {
    console.error('[finance-dashboard] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/dashboard/bulk-send-statements ─────────────────────────
// b401 (2026-10-06) — this never sent an email; it only counted who it WOULD contact and
// toasted "Queued statements for N families", which told Toby it had. It still sends
// nothing — that is a separate, deliberate step (Finance → Invoices → Send) — but now says
// so, and hands back child_id + amount only (no names/emails) for the UI to list.
router.post('/bulk-send-statements', async (req, res) => {
  const db = getPool();
  try {
    const { rows: overdue } = await (db.query(`
      SELECT DISTINCT i.child_id, SUM(${OUTSTANDING_FULL}) AS total_pence
      FROM invoices i
      LEFT JOIN children c ON c.id = i.child_id
      WHERE i.status IN ('sent','overdue') AND i.bill_payer_email IS NOT NULL AND i.amount_pence > 0
        AND COALESCE(c.is_demo, false) = false
      GROUP BY i.child_id
      HAVING SUM(${OUTSTANDING_FULL}) > 0
    `).catch(() => db.query(`
      SELECT DISTINCT i.child_id, SUM(${OUTSTANDING_FALLBACK}) AS total_pence
      FROM invoices i
      LEFT JOIN children c ON c.id = i.child_id
      WHERE i.status IN ('sent','overdue') AND i.bill_payer_email IS NOT NULL AND i.amount_pence > 0
        AND COALESCE(c.is_demo, false) = false
      GROUP BY i.child_id
      HAVING SUM(${OUTSTANDING_FALLBACK}) > 0
    `)));

    recordAudit({ req, action: 'bulk_send', entity_type: 'invoice',
      meta: { recipients: overdue.length, action: 'statements_preview_only' } });

    res.json({
      ok: true,
      sent: false,
      families: overdue.map(r => ({ child_id: r.child_id, amount_pence: parseInt(r.total_pence, 10) || 0 })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/dashboard/bulk-chase-overdue ────────────────────────────
// b401 — same fix as above: no email leaves here, and the response says so.
router.post('/bulk-chase-overdue', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await (db.query(`
      SELECT DISTINCT i.child_id, COUNT(*) AS invoice_count, SUM(${OUTSTANDING_FULL}) AS total_pence
      FROM invoices i
      LEFT JOIN children c ON c.id = i.child_id
      WHERE i.status = 'overdue' AND i.bill_payer_email IS NOT NULL AND i.amount_pence > 0
        AND COALESCE(c.is_demo, false) = false
      GROUP BY i.child_id
      HAVING SUM(${OUTSTANDING_FULL}) > 0
    `).catch(() => db.query(`
      SELECT DISTINCT i.child_id, COUNT(*) AS invoice_count, SUM(${OUTSTANDING_FALLBACK}) AS total_pence
      FROM invoices i
      LEFT JOIN children c ON c.id = i.child_id
      WHERE i.status = 'overdue' AND i.bill_payer_email IS NOT NULL AND i.amount_pence > 0
        AND COALESCE(c.is_demo, false) = false
      GROUP BY i.child_id
      HAVING SUM(${OUTSTANDING_FALLBACK}) > 0
    `)));

    recordAudit({ req, action: 'bulk_chase', entity_type: 'invoice',
      meta: { recipients: rows.length, action: 'chase_preview_only' } });

    res.json({
      ok: true,
      chased: false,
      families: rows.map(r => ({ child_id: r.child_id, amount_pence: parseInt(r.total_pence, 10) || 0 })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/dashboard/opening-checks ─────────────────────────────────
// 2026-10-06 — which families have confirmed (or queried) the balance carried over from
// EyLog (ladn.opening_balances), from the card in the parents app. ?child_id= for one child.
// Editions without opening balances get an empty list, never an error.
router.get('/opening-checks', async (req, res) => {
  const db = getPool();
  const childId = req.query.child_id ? parseInt(req.query.child_id, 10) : null;
  try {
    const { rows } = await db.query(`
      SELECT ob.child_id, c.first_name || ' ' || c.last_name AS child_name, c.status AS child_status,
             (ob.as_of - 1) AS eylog_date, ob.balance_pence::bigint AS balance_pence,
             k.response, k.created_at AS answered_at, k.thread_id
        FROM opening_balances ob
        JOIN children c ON c.id = ob.child_id
        LEFT JOIN LATERAL (SELECT response, created_at, thread_id FROM opening_balance_checks x
                            WHERE x.child_id = ob.child_id ORDER BY created_at DESC LIMIT 1) k ON true
       WHERE ($1::int IS NULL AND c.status IN ('active','pending')) OR ob.child_id = $1::int
       ORDER BY k.response NULLS FIRST, c.first_name`, [childId]);
    const out = rows.map(r => ({ ...r, balance_pence: Number(r.balance_pence) }));
    res.json({ checks: out,
      counts: { confirmed: out.filter(r => r.response === 'confirmed').length,
                queried: out.filter(r => r.response === 'queried').length,
                waiting: out.filter(r => !r.response).length } });
  } catch (e) {
    if (e.code === '42P01') return res.json({ checks: [], counts: { confirmed: 0, queried: 0, waiting: 0 } });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
