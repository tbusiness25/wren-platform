'use strict';
// Parent-facing payment routes for primary/secondary editions.
// Uses JWT Bearer auth (same as parents-portal.js) rather than CF Access headers.
// Mounts at /api/payments in primary + secondary server.js.

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { getPool }            = require('../db/pool');
const stripe                 = require('../lib/stripe-client');
const gc                     = require('../lib/gocardless-client');
const { recordAudit }        = require('../utils/audit');

const PARENTS_BASE = process.env.PARENTS_BASE_URL || '';

function parentAuth(req, res, next) {
  const h = (req.headers.authorization || '').trim();
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthenticated' });
  try {
    req.parent = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    req.parentEmail = (req.parent.email || '').toLowerCase().trim();
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function parentChildIds(db, email) {
  const { rows } = await db.query(
    'SELECT child_id FROM parent_portal_access WHERE lower(email)=$1 AND is_active=true',
    [email]
  );
  return rows.map(r => r.child_id);
}

// ── GET /api/payments/invoices ─────────────────────────────────────────────────
router.get('/invoices', parentAuth, async (req, res) => {
  const email = req.parentEmail;
  const db = getPool();
  try {
    const childIds = await parentChildIds(db, email);
    if (!childIds.length) return res.json({ invoices: [] });

    const { rows } = await db.query(`
      SELECT i.id, i.child_id, i.amount_pence, i.status, i.issued_on, i.due_on,
             i.reference, i.line_items, i.stripe_session_id, i.invoice_number,
             i.period_label, i.gc_payment_id,
             c.first_name || ' ' || COALESCE(c.last_name, '') AS child_name,
             (SELECT json_agg(json_build_object(
               'id', p.id, 'amount_pence', p.amount_pence, 'status', p.status,
               'payment_method', p.payment_method, 'created_at', p.created_at
             ) ORDER BY p.created_at DESC)
              FROM payments p WHERE p.invoice_id = i.id AND p.status IN ('completed','succeeded')
             ) AS completed_payments
      FROM invoices i
      JOIN children c ON c.id = i.child_id
      WHERE i.child_id = ANY($1::int[])
        AND i.status NOT IN ('draft', 'written_off')
      ORDER BY
        CASE i.status WHEN 'overdue' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
        i.due_on ASC NULLS LAST
    `, [childIds]);

    res.json({ invoices: rows });
  } catch (e) {
    console.error('[payments-parent] invoices error:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /api/payments/stripe/session ─────────────────────────────────────────
router.post('/stripe/session', parentAuth, async (req, res) => {
  const email = req.parentEmail;
  const { invoice_id } = req.body;
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id required' });

  const db = getPool();
  try {
    const childIds = await parentChildIds(db, email);
    if (!childIds.length) return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await db.query(
      `SELECT * FROM invoices WHERE id=$1 AND child_id = ANY($2::int[]) AND status != 'paid'`,
      [invoice_id, childIds]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invoice not found or already paid' });
    const inv = rows[0];

    const isTest = await stripe.isTestMode();
    const desc   = inv.period_label || `Invoice #${inv.reference || inv.id}`;

    const base = process.env.PARENTS_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.createCheckoutSession({
      invoiceId:     inv.id,
      amountPence:   inv.amount_pence,
      description:   desc,
      customerEmail: email,
      successUrl: `${base}/parent/payments-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${base}/parent/index.html`,
    });

    await db.query('UPDATE invoices SET stripe_session_id=$1 WHERE id=$2', [session.id, inv.id]);
    await db.query(`
      INSERT INTO payments (invoice_id, child_id, bill_payer_email, amount_pence,
                            payment_method, stripe_checkout_session_id, status, description)
      VALUES ($1,$2,$3,$4,'stripe',$5,'pending',$6)
    `, [inv.id, inv.child_id, email, inv.amount_pence, session.id, desc]);

    recordAudit({ req, action: 'create', entity_type: 'payment', entity_id: inv.id,
      meta: { payment_method: 'stripe', session_id: session.id, test_mode: isTest } });

    res.json({ session_url: session.url, test_mode: isTest });
  } catch (e) {
    console.error('[payments-parent] stripe error:', e.message);
    const code = e.message.includes('not configured') ? 503 : 500;
    res.status(code).json({ error: e.message });
  }
});

// ── GET /api/payments/mandates ─────────────────────────────────────────────────
router.get('/mandates', parentAuth, async (req, res) => {
  const email = req.parentEmail;
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id, status, gc_account_holder, gc_bank_name, gc_account_number_end, created_at
       FROM gocardless_mandates
       WHERE lower(bill_payer_email)=$1 AND status != 'cancelled'
       ORDER BY created_at DESC`,
      [email]
    );
    res.json({ mandates: rows });
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /api/payments/gocardless/start ────────────────────────────────────────
router.post('/gocardless/start', parentAuth, async (req, res) => {
  const email = req.parentEmail;
  const db = getPool();
  try {
    const childIds = await parentChildIds(db, email);
    if (!childIds.length) return res.status(403).json({ error: 'Forbidden' });

    const sessionToken = require('crypto').randomBytes(20).toString('hex');
    const isTest = await gc.isTestMode();

    const base = process.env.PARENTS_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const flow = await gc.createRedirectFlow({
      description:       'School Payments — Direct Debit',
      sessionToken,
      successRedirectUrl: `${base}/parent/dd-complete.html?redirect_flow_id={REDIRECT_FLOW_ID}`,
      email,
    });

    const { rows } = await db.query(`
      INSERT INTO gocardless_mandates (child_id, bill_payer_email, redirect_flow_id, status)
      VALUES ($1, $2, $3, 'pending_submission')
      RETURNING id
    `, [childIds[0], email, flow.id]);

    await db.query(
      'UPDATE gocardless_mandates SET gc_account_holder=$1 WHERE id=$2',
      [sessionToken, rows[0].id]
    );

    res.json({ redirect_url: flow.redirect_url, test_mode: isTest });
  } catch (e) {
    console.error('[payments-parent] gc start error:', e.message);
    const code = e.message.includes('not configured') ? 503 : 500;
    res.status(code).json({ error: e.message });
  }
});

// ── GET /api/payments/history ──────────────────────────────────────────────────
router.get('/history', parentAuth, async (req, res) => {
  const email = req.parentEmail;
  const db = getPool();
  try {
    const childIds = await parentChildIds(db, email);
    if (!childIds.length) return res.json({ payments: [] });

    const { rows } = await db.query(`
      SELECT p.id, p.invoice_id, p.amount_pence, p.payment_method, p.status,
             p.created_at, i.period_label, i.reference AS invoice_ref,
             c.first_name || ' ' || COALESCE(c.last_name,'') AS child_name
      FROM payments p
      LEFT JOIN invoices i ON i.id = p.invoice_id
      LEFT JOIN children c ON c.id = p.child_id
      WHERE p.child_id = ANY($1::int[])
        AND p.status IN ('completed','succeeded','pending')
      ORDER BY p.created_at DESC
      LIMIT 50
    `, [childIds]);

    res.json({ payments: rows });
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
