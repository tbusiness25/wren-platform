'use strict';
// Admin-facing payment routes — JWT auth, manager/admin only.
// Mounted at /api/payments-admin in editions/admin/server.js

const express  = require('express');
const router   = express.Router();
const { getPool }            = require('../db/pool');
const authenticate           = require('../middleware/auth');
const { recordAudit }        = require('../utils/audit');
const {
  getDecryptedSetting, setEncryptedSetting, getAllSettingsRaw, maskKey, SETTING_KEYS,
} = require('../lib/payment-settings');
const stripe = require('../lib/stripe-client');
const gc     = require('../lib/gocardless-client');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const managerGuard = (req, res, next) => {
  // b480: 'accountant' added — safe only because the accountant-scope gate in
  // server-unified.js has already restricted that role to GET requests on
  // /api/payments-admin/ledger only before this ever runs.
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'accountant'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerGuard);

// ── GET /api/payments-admin/settings ──────────────────────────────────────────
// Returns masked key values (last 4 chars only) and config status.
router.get('/settings', async (req, res) => {
  try {
    const raw = await getAllSettingsRaw();
    const masked = {};
    for (const k of SETTING_KEYS) {
      masked[k] = {
        configured: !!raw[k]?.value,
        masked:     maskKey(raw[k]?.value),
        updated_at: raw[k]?.updated_at,
      };
    }
    const stripeTest = !raw['stripe_secret_key']?.value ||
                       raw['stripe_secret_key'].value.startsWith('sk_test_');
    const gcTest     = !raw['gocardless_env']?.value ||
                       raw['gocardless_env'].value !== 'live';
    res.json({
      settings: masked,
      stripe_test_mode:     stripeTest,
      gocardless_test_mode: gcTest,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/payments-admin/settings ─────────────────────────────────────────
// Save one or more settings. Client sends only the keys it wants to update.
// Empty string means "clear this key".
router.post('/settings', async (req, res) => {
  try {
    const updates = req.body;
    if (typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Expected object of key:value pairs' });
    }
    const allowed = new Set(SETTING_KEYS);
    const changed = [];
    for (const [k, v] of Object.entries(updates)) {
      if (!allowed.has(k)) continue;
      if (typeof v !== 'string') continue;
      if (v === '') {
        const db = getPool();
        await db.query('DELETE FROM payment_settings WHERE key=$1', [k]);
      } else {
        await setEncryptedSetting(k, v.trim());
      }
      changed.push(k);
    }
    recordAudit({ req, action: 'update', entity_type: 'payment_settings',
      meta: { keys_changed: changed } });
    res.json({ ok: true, updated: changed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/payments-admin/stats ──────────────────────────────────────────────
// POST /opayo/test — ask Opayo for a merchant session key with whatever is stored.
// 2026-09-28: a key pair you cannot test is a key pair you find out about from a parent who
// could not pay. This costs nothing and answers "did that paste work" in one click.
router.post('/opayo/test', async (req, res) => {
  try {
    const opayo = require('../lib/opayo-pi');
    const cfg = {
      vendor:              await getDecryptedSetting('opayo_vendor'),
      integrationKey:      await getDecryptedSetting('opayo_integration_key'),
      integrationPassword: await getDecryptedSetting('opayo_integration_password'),
      env:                 await getDecryptedSetting('opayo_env'),
    };
    if (!cfg.integrationKey || !cfg.integrationPassword) {
      return res.status(400).json({ ok: false, error: 'No Opayo integration key/password saved yet.' });
    }
    const r = await opayo.verifyCredentials(cfg);
    res.json({ ok: true, env: r.env, vendor: cfg.vendor || null,
               message: `Opayo answered. Session key valid until ${r.expiresAt || 'shortly'}.` });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/stats', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [stats] } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='succeeded')                         AS total_count,
        COALESCE(SUM(amount_pence) FILTER (WHERE status='succeeded'), 0)  AS total_pence,
        COUNT(*) FILTER (WHERE status='pending')                           AS pending_count,
        COUNT(*) FILTER (WHERE status='failed')                            AS failed_count,
        COUNT(*) FILTER (WHERE payment_method='stripe' AND status='succeeded') AS stripe_count,
        COUNT(*) FILTER (WHERE payment_method='gocardless' AND status='succeeded') AS gc_count,
        COALESCE(SUM(amount_pence) FILTER (WHERE payment_method='stripe' AND status='succeeded'), 0) AS stripe_pence,
        COALESCE(SUM(amount_pence) FILTER (WHERE payment_method='gocardless' AND status='succeeded'), 0) AS gc_pence
      FROM payments
      WHERE created_at > NOW() - INTERVAL '30 days'
        AND NOT EXISTS (SELECT 1 FROM children dc WHERE dc.id = payments.child_id AND COALESCE(dc.is_demo, false))  -- b484 port: demo child never money
    `);
    const { rows: [mandateStats] } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='active')    AS active_mandates,
        COUNT(*) FILTER (WHERE status='pending')   AS pending_mandates,
        COUNT(*) FILTER (WHERE status='cancelled') AS cancelled_mandates
      FROM gocardless_mandates
    `);
    const { rows: recentFlags } = await db.query(`
      SELECT f.id, f.flag_type, f.provider, f.created_at, f.detail
      FROM payment_reconciliation_flags f
      WHERE f.resolved_at IS NULL
      ORDER BY f.created_at DESC LIMIT 10
    `);
    res.json({ stats, mandate_stats: mandateStats, unresolved_flags: recentFlags });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/payments-admin/list ───────────────────────────────────────────────
// 2026-10-01 — one child's ledger for Roost's child profile, in EyLog's Transactions/Payments
// layout: every invoice and payment with a running balance, plus the deposit held. Same rules
// as the parent app's statement (src/lib/family-ledger.js) so office and family see one number.
router.get('/ledger', managerGuard, async (req, res) => {
  const childId = parseInt(req.query.child_id, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'child_id required' });
  try {
    const { familyLedger, familyChildIds } = require('../lib/family-ledger');
    const schema = String(process.env.PG_SCHEMA || 'ladn');
    const db = getPool();
    // The FAMILY's ledger, not just this child's: siblings share a bill, and EyLog often
    // recorded a family's payment against one twin (login-20261023: the family rule is now
    // familyChildIds in the lib, shared with the EY leadership view).
    const ids = await familyChildIds(db, childId, { schema });
    res.json({ ...(await familyLedger(db, ids, { schema })), child_ids: ids });
  } catch (e) { console.error('[payments-admin] ledger:', e.message); res.status(500).json({ error: 'Could not load the ledger' }); }
});

router.get('/list', async (req, res) => {
  const db = getPool();
  try {
    // 2026-09-25 — child_id so the child's own screen can show their transactions. The
    // money was always here; there was just no way to ask for one family's slice of it.
    const { method, status, child_id, limit = 50, offset = 0 } = req.query;
    // paid_on as TEXT, not as a DATE: pg hands a DATE back as a local-midnight JS
    // Date, which JSON-serialises to the previous day in UTC over BST. to_char
    // keeps the day the money actually moved.
    let q = `
      SELECT p.*, i.reference AS invoice_ref,
             to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on_ymd,
             c.first_name || ' ' || c.last_name AS child_name
      FROM payments p
      LEFT JOIN invoices i ON i.id = p.invoice_id
      LEFT JOIN children c ON c.id = p.child_id
      WHERE 1=1
    `;
    const params = [];
    if (method)  { params.push(method);  q += ` AND p.payment_method=$${params.length}`; }
    if (status)  { params.push(status);  q += ` AND p.status=$${params.length}`; }
    if (child_id) { params.push(parseInt(child_id, 10)); q += ` AND p.child_id=$${params.length}`; }
    q += ` ORDER BY COALESCE(p.paid_on, p.created_at::date) DESC, p.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(parseInt(limit), parseInt(offset));
    const { rows } = await db.query(q, params);
    res.json({ payments: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/payments-admin/payments/:id/mark-paid ────────────────────────────
// Manual override — mark an invoice payment as succeeded.
router.post('/payments/:id/mark-paid', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT * FROM payments WHERE id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const payment = rows[0];

    await db.query(`
      UPDATE payments SET status='succeeded', updated_at=NOW(),
        reconciliation_note=$1 WHERE id=$2
    `, [`Manually marked paid by ${req.user.name || req.user.email}`, payment.id]);

    if (payment.invoice_id) {
      await db.query(
        `UPDATE invoices SET status='paid', paid_on=CURRENT_DATE, payment_method='manual' WHERE id=$1`,
        [payment.invoice_id]
      );
    }

    recordAudit({ req, action: 'update', entity_type: 'payment', entity_id: payment.id,
      diff: { old: { status: payment.status }, new: { status: 'succeeded' } },
      meta: { manual: true } });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/payments-admin/bank-lines — money IN, with who it came from ──────
// Toby, 2026-09-23: "I wanted to use our payment screen to find the payments rather than
// having to log into Barclays, which is why I wanted the names there."
//
// The name was always in the data — bank_statement_lines.description is populated on every
// row and is what Barclays puts on the credit, i.e. the payer. Nothing surfaced it. The
// `reference` column IS empty on all 251 rows, which is why matching on reference alone has
// never worked; the description is what a human actually reads to recognise a family.
//
// Each line comes back with any candidate matches already worked out: an unreconciled invoice
// for the exact amount, and a child whose family name appears in the description.
router.get('/bank-lines', async (req, res) => {
  const db = getPool();
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 90, 400);
    const showAll = req.query.all === 'true';
    const { rows } = await db.query(`
      SELECT l.id, to_char(l.transaction_date,'YYYY-MM-DD') AS paid_on,
             l.description, l.reference, l.amount_pence, l.reconciled,
             l.category,
             -- an unpaid invoice for exactly this amount is the strongest simple signal
             (SELECT json_agg(x) FROM (
                SELECT i.id, i.invoice_number, i.amount_pence,
                       c.first_name || ' ' || c.last_name AS child_name
                  FROM invoices i
                  LEFT JOIN children c ON c.id = i.child_id
                 WHERE i.amount_pence = l.amount_pence
                   AND i.status <> 'paid'
                 ORDER BY i.issued_on DESC LIMIT 4) x) AS amount_matches,
             -- or a child whose surname appears in what the bank wrote
             (SELECT json_agg(y) FROM (
                SELECT c.id, c.first_name || ' ' || c.last_name AS child_name
                  FROM children c
                 WHERE c.is_active
                   AND length(c.last_name) > 2
                   AND upper(l.description) LIKE '%' || upper(c.last_name) || '%'
                 LIMIT 4) y) AS name_matches
        FROM bank_statement_lines l
       WHERE l.amount_pence > 0 AND l.excluded_reason IS NULL
         AND l.transaction_date >= CURRENT_DATE - ($1 || ' days')::interval
         ${''}
         AND ($2::boolean IS TRUE OR l.reconciled = false)
       ORDER BY l.transaction_date DESC, l.id DESC`, [String(days), showAll]);
    const total = rows.reduce((a, r) => a + Number(r.amount_pence || 0), 0);
    res.json({ lines: rows, count: rows.length, total_pence: total, days, showing: showAll ? 'all' : 'unreconciled' });
  } catch (e) {
    console.error('[payments-admin] bank-lines:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/payments-admin/bank-lines/:id/assign — say who this money was from ──
// Records the decision against the line and, when an invoice is named, marks it paid.
router.post('/bank-lines/:id/assign', async (req, res) => {
  const db = getPool();
  const lineId = parseInt(req.params.id, 10);
  const invoiceId = req.body && req.body.invoice_id ? parseInt(req.body.invoice_id, 10) : null;
  const childId = req.body && req.body.child_id ? parseInt(req.body.child_id, 10) : null;
  if (!Number.isInteger(lineId)) return res.status(400).json({ error: 'bad line id' });
  if (!invoiceId && !childId) return res.status(400).json({ error: 'name an invoice or a child' });
  try {
    const { rows: [line] } = await db.query(`SELECT * FROM bank_statement_lines WHERE id=$1`, [lineId]);
    if (!line) return res.status(404).json({ error: 'Not found' });

    const { rows: [pay] } = await db.query(
      `INSERT INTO payments (invoice_id, child_id, amount_pence, currency, payment_method, status, paid_on, reconciliation_note, created_at)
       VALUES ($1,$2,$3,'GBP','BACS','succeeded',$4,$5,NOW()) RETURNING id`,
      [invoiceId, childId, line.amount_pence, line.transaction_date,
       `Assigned from bank line ${lineId} by ${req.user.name || req.user.email}`]);

    await db.query(`UPDATE bank_statement_lines SET reconciled=true, reconciled_at=NOW() WHERE id=$1`, [lineId]);
    if (invoiceId) {
      await db.query(`UPDATE invoices SET status='paid', paid_on=$2, payment_method='BACS' WHERE id=$1`, [invoiceId, line.transaction_date]);
      // b365 — the allocation is stamped with the period of the invoice it pays.
      // allocated_on keeps the bank's date; the period is the month the invoice
      // covers, which is the month this money counts in.
      const per = await require('../lib/allocation-period').periodOfInvoiceId(db, invoiceId);
      await db.query(`INSERT INTO payment_allocations (payment_id, invoice_id, child_id, amount_pence, allocated_on, source,
                                                       period_year, period_month, period_source)
                      VALUES ($1,$2,$3,$4,$5,'bank-assign',$6,$7,$8)`,
                     [pay.id, invoiceId, childId, line.amount_pence, line.transaction_date,
                      per.year, per.month, per.source]).catch(() => {});
    }
    recordAudit({ req, action: 'update', entity_type: 'bank_line', entity_id: lineId,
      meta: { invoice_id: invoiceId, child_id: childId, amount_pence: line.amount_pence } });
    res.json({ ok: true, payment_id: pay.id });
  } catch (e) {
    console.error('[payments-admin] assign:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/payments-admin/mandates ──────────────────────────────────────────
router.get('/mandates', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT m.id, m.child_id, m.bill_payer_email, m.redirect_flow_id, m.mandate_id,
             m.status, m.gc_account_holder, m.gc_bank_name, m.gc_account_number_end,
             m.created_at, m.updated_at,
             c.first_name || ' ' || c.last_name AS child_name
      FROM gocardless_mandates m
      LEFT JOIN children c ON c.id = m.child_id
      ORDER BY m.created_at DESC LIMIT 200
    `);
    res.json({ mandates: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/payments-admin/reconcile ─────────────────────────────────────────
// Trigger reconciliation run (async — results appear in flags table).
router.post('/reconcile', async (req, res) => {
  res.json({ ok: true, message: 'Reconciliation started — check flags table in ~60s' });
  // Fire-and-forget
  setImmediate(async () => {
    try {
      const { run } = require('../jobs/payment-reconciliation');
      await run();
    } catch (e) {
      console.error('[reconcile] trigger error:', e.message);
    }
  });
});

// ── POST /api/payments-admin/reconciliation-flags/:id/resolve ──────────────────
router.post('/reconciliation-flags/:id/resolve', async (req, res) => {
  const db = getPool();
  try {
    await db.query(
      'UPDATE payment_reconciliation_flags SET resolved_at=NOW() WHERE id=$1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
