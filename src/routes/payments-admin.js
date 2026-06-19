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

router.use(authenticate);

const managerGuard = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role)) {
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
router.get('/list', async (req, res) => {
  const db = getPool();
  try {
    const { method, status, limit = 50, offset = 0 } = req.query;
    let q = `
      SELECT p.*, i.reference AS invoice_ref,
             c.first_name || ' ' || c.last_name AS child_name
      FROM payments p
      LEFT JOIN invoices i ON i.id = p.invoice_id
      LEFT JOIN children c ON c.id = p.child_id
      WHERE 1=1
    `;
    const params = [];
    if (method)  { params.push(method);  q += ` AND p.payment_method=$${params.length}`; }
    if (status)  { params.push(status);  q += ` AND p.status=$${params.length}`; }
    q += ` ORDER BY p.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
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

// ── GET /api/payments-admin/mandates ──────────────────────────────────────────
router.get('/mandates', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT m.*, c.first_name || ' ' || c.last_name AS child_name
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
