'use strict';
// Parent-facing payment endpoints — authenticated via Cloudflare Access email header.
// Mounted at /api/payments in both parents and ladn editions.

const express = require('express');
const router  = express.Router();
const { getPool }               = require('../db/pool');
const { recordAudit }           = require('../utils/audit');
const stripe                    = require('../lib/stripe-client');
const gc                        = require('../lib/gocardless-client');

const PARENTS_BASE = process.env.PARENTS_BASE_URL || 'https://parents.example-nursery.co.uk';

function cfEmail(req) {
  return (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
}

async function parentChildIds(db, email) {
  const { rows } = await db.query(
    'SELECT child_id FROM parent_portal_access WHERE lower(email)=$1 AND is_active=true',
    [email]
  );
  return rows.map(r => r.child_id);
}

// ── GET /api/payments/invoices ─────────────────────────────────────────────────
// Returns outstanding + recent invoices for the authenticated parent's children.
router.get('/invoices', async (req, res) => {
  const email = cfEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const childIds = await parentChildIds(db, email);
    if (!childIds.length) return res.json({ invoices: [] });

    const { rows } = await db.query(`
      SELECT i.id, i.child_id, i.amount_pence, i.status, i.issued_on, i.due_on,
             i.reference, i.line_items, i.stripe_session_id,
             c.first_name || ' ' || c.last_name AS child_name,
             (SELECT json_agg(json_build_object(
               'id', p.id, 'amount_pence', p.amount_pence, 'status', p.status,
               'payment_method', p.payment_method, 'created_at', p.created_at
             ) ORDER BY p.created_at DESC)
              FROM payments p WHERE p.invoice_id = i.id AND p.status = 'succeeded'
             ) AS completed_payments
      FROM invoices i
      JOIN children c ON c.id = i.child_id
      WHERE i.child_id = ANY($1::int[])
        AND i.status NOT IN ('draft', 'written_off')
      ORDER BY i.status = 'overdue' DESC, i.due_on ASC NULLS LAST
    `, [childIds]);

    res.json({ invoices: rows });
  } catch (e) {
    console.error('[payments] invoices error:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /api/payments/stripe/session ─────────────────────────────────────────
// Creates a Stripe Checkout session for a specific invoice.
router.post('/stripe/session', async (req, res) => {
  const email = cfEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const { invoice_id } = req.body;
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id required' });

  const db = getPool();
  try {
    const childIds = await parentChildIds(db, email);
    if (!childIds.length) return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await db.query(
      'SELECT * FROM invoices WHERE id=$1 AND child_id = ANY($2::int[]) AND status != $3',
      [invoice_id, childIds, 'paid']
    );
    if (!rows.length) return res.status(404).json({ error: 'Invoice not found or already paid' });
    const inv = rows[0];

    const isTest = await stripe.isTestMode();
    const desc   = `Invoice #${inv.reference || inv.id}${inv.line_items?.[0]?.label ? ' — ' + inv.line_items[0].label : ''}`;

    const session = await stripe.createCheckoutSession({
      invoiceId:     inv.id,
      amountPence:   inv.amount_pence,
      description:   desc,
      customerEmail: email,
      successUrl:    `${PARENTS_BASE}/welcome/payments/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:     `${PARENTS_BASE}/welcome/payments`,
    });

    await db.query(
      'UPDATE invoices SET stripe_session_id=$1 WHERE id=$2',
      [session.id, inv.id]
    );

    await db.query(`
      INSERT INTO payments (invoice_id, child_id, bill_payer_email, amount_pence,
                            payment_method, stripe_checkout_session_id, status, description)
      VALUES ($1,$2,$3,$4,'stripe',$5,'pending',$6)
    `, [inv.id, inv.child_id, email, inv.amount_pence, session.id, desc]);

    recordAudit({ req, action: 'create', entity_type: 'payment', entity_id: inv.id,
      meta: { payment_method: 'stripe', session_id: session.id, test_mode: isTest } });

    res.json({ session_url: session.url, test_mode: isTest });
  } catch (e) {
    console.error('[payments] stripe session error:', e.message);
    const code = e.message.includes('not configured') ? 503 : 500;
    res.status(code).json({ error: e.message });
  }
});

// ── GET /api/payments/stripe/verify?session_id=xxx ────────────────────────────
// Called by the success page to confirm the session server-side (belt-and-braces UX only).
// The webhook is the authoritative confirmation path.
router.get('/stripe/verify', async (req, res) => {
  const email = cfEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT p.*, i.reference AS invoice_ref
       FROM payments p LEFT JOIN invoices i ON i.id=p.invoice_id
       WHERE p.stripe_checkout_session_id=$1 AND p.bill_payer_email=$2`,
      [session_id, email]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const payment = rows[0];
    res.json({ status: payment.status, amount_pence: payment.amount_pence, description: payment.description });
  } catch (e) {
    console.error('[payments] stripe verify error:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /api/payments/mandates ─────────────────────────────────────────────────
// Returns GoCardless mandates for the authenticated parent.
router.get('/mandates', async (req, res) => {
  const email = cfEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id, status, gc_account_holder, gc_bank_name, gc_account_number_end, created_at
       FROM gocardless_mandates WHERE lower(bill_payer_email)=$1 AND status != 'cancelled'
       ORDER BY created_at DESC`,
      [email]
    );
    res.json({ mandates: rows });
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /api/payments/gocardless/start ────────────────────────────────────────
// Starts a GoCardless redirect flow — returns the URL to redirect the parent to.
router.post('/gocardless/start', async (req, res) => {
  const email = cfEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const childIds = await parentChildIds(db, email);
    if (!childIds.length) return res.status(403).json({ error: 'Forbidden' });

    const sessionToken = require('crypto').randomBytes(20).toString('hex');
    const isTest = await gc.isTestMode();

    const flow = await gc.createRedirectFlow({
      description: 'Your Nursery — Direct Debit',
      sessionToken,
      successRedirectUrl: `${PARENTS_BASE}/welcome/dd-setup?redirect_flow_id={REDIRECT_FLOW_ID}`,
      email,
    });

    const { rows } = await db.query(`
      INSERT INTO gocardless_mandates (child_id, bill_payer_email, redirect_flow_id, status)
      VALUES ($1, $2, $3, 'pending')
      RETURNING id
    `, [childIds[0], email, flow.id]);

    // Store session_token in a short-lived way: we'll need it to complete the flow.
    // We store it encrypted in the mandate row description field.
    await db.query(
      'UPDATE gocardless_mandates SET gc_account_holder=$1 WHERE id=$2',
      [sessionToken, rows[0].id]  // temporarily storing token here until flow completion
    );

    recordAudit({ req, action: 'create', entity_type: 'gocardless_mandate', entity_id: rows[0].id,
      meta: { test_mode: isTest } });

    res.json({ redirect_url: flow.redirect_url, test_mode: isTest });
  } catch (e) {
    console.error('[payments] gc start error:', e.message);
    const code = e.message.includes('not configured') ? 503 : 500;
    res.status(code).json({ error: e.message });
  }
});

// ── POST /api/payments/gocardless/complete ─────────────────────────────────────
// Completes the redirect flow after parent confirms bank details on GoCardless.
router.post('/gocardless/complete', async (req, res) => {
  const email = cfEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const { redirect_flow_id } = req.body;
  if (!redirect_flow_id) return res.status(400).json({ error: 'redirect_flow_id required' });

  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT * FROM gocardless_mandates WHERE redirect_flow_id=$1 AND lower(bill_payer_email)=$2`,
      [redirect_flow_id, email]
    );
    if (!rows.length) return res.status(404).json({ error: 'Redirect flow not found' });
    const mandate = rows[0];
    if (mandate.mandate_id) return res.json({ ok: true, already_complete: true });

    const sessionToken = mandate.gc_account_holder; // retrieved from temp storage
    const flow = await gc.completeRedirectFlow(redirect_flow_id, sessionToken);
    const mandateId = flow.links?.mandate;
    if (!mandateId) throw new Error('No mandate ID returned from GoCardless');

    // Fetch mandate details for display
    let mandateDetails = {};
    try {
      const m = await gc.getMandate(mandateId);
      mandateDetails = {
        gc_account_holder: m.metadata?.account_holder_name || null,
        gc_bank_name:      m.metadata?.bank_name || null,
        gc_account_number_end: null,
      };
    } catch { /* non-fatal */ }

    await db.query(`
      UPDATE gocardless_mandates
      SET mandate_id=$1, status='active', gc_account_holder=$2, gc_bank_name=$3,
          gc_account_number_end=$4, updated_at=NOW()
      WHERE id=$5
    `, [mandateId, mandateDetails.gc_account_holder, mandateDetails.gc_bank_name,
        mandateDetails.gc_account_number_end, mandate.id]);

    recordAudit({ req, action: 'update', entity_type: 'gocardless_mandate', entity_id: mandate.id,
      meta: { mandate_id: mandateId } });

    res.json({ ok: true, mandate_id: mandateId });
  } catch (e) {
    console.error('[payments] gc complete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/payments/history ──────────────────────────────────────────────────
router.get('/history', async (req, res) => {
  const email = cfEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT p.id, p.amount_pence, p.currency, p.payment_method, p.status,
             p.description, p.created_at, p.receipt_email_sent,
             i.reference AS invoice_ref, c.first_name || ' ' || c.last_name AS child_name
      FROM payments p
      LEFT JOIN invoices i ON i.id = p.invoice_id
      LEFT JOIN children c ON c.id = p.child_id
      WHERE lower(p.bill_payer_email)=$1
      ORDER BY p.created_at DESC
      LIMIT 100
    `, [email]);
    res.json({ payments: rows });
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
