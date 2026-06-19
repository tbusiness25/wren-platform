'use strict';
// Stripe + GoCardless webhook handlers.
// MUST be registered BEFORE express.json() in server.js so req.body remains a raw Buffer.
// Both routers use express.raw({ type: 'application/json' }) at the route level.

const express = require('express');
const { getPool }     = require('../db/pool');
const { recordAudit } = require('../utils/audit');
const { sendEmail }   = require('../utils/email');
const stripe = require('../lib/stripe-client');
const gc     = require('../lib/gocardless-client');

// ── Stripe webhook router ──────────────────────────────────────────────────────
const stripeRouter = express.Router();
stripeRouter.use(express.raw({ type: 'application/json' }));

stripeRouter.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).send('Missing Stripe-Signature');

  let event;
  try {
    event = await stripe.verifyWebhook(req.body, sig);
  } catch (e) {
    console.error('[stripe-webhook] verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  const db = getPool();

  // Idempotency — skip already-processed events
  try {
    await db.query(`
      INSERT INTO stripe_webhook_events (event_id, event_type, meta)
      VALUES ($1, $2, $3)
    `, [event.id, event.type, JSON.stringify({ object: event.data?.object?.id })]);
  } catch (e) {
    if (e.code === '23505') {
      // Duplicate — already processed
      return res.json({ ok: true, duplicate: true });
    }
    console.error('[stripe-webhook] idempotency insert error:', e.message);
    return res.status(500).send('DB error');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleStripeCheckoutComplete(db, event.data.object);
        break;
      case 'checkout.session.expired':
        await handleStripeCheckoutExpired(db, event.data.object);
        break;
      case 'payment_intent.payment_failed':
        await handleStripePaymentFailed(db, event.data.object);
        break;
      default:
        // Accepted but not handled
        break;
    }
  } catch (e) {
    console.error('[stripe-webhook] handler error:', event.type, e.message);
    // Return 200 to prevent Stripe retries for handler errors — log and investigate separately.
  }

  res.json({ ok: true });
});

async function handleStripeCheckoutComplete(db, session) {
  const sessionId   = session.id;
  const invoiceId   = session.metadata?.invoice_id ? parseInt(session.metadata.invoice_id) : null;
  const paymentIntent = session.payment_intent;
  const customerEmail = (session.customer_email || session.customer_details?.email || '').toLowerCase();
  const amountPaid  = session.amount_total;

  // Update the pending payment row
  const { rows } = await db.query(`
    UPDATE payments
    SET status='succeeded', provider_payment_id=$1, updated_at=NOW()
    WHERE stripe_checkout_session_id=$2
    RETURNING *
  `, [paymentIntent, sessionId]);

  if (rows.length) {
    const payment = rows[0];
    // Mark the invoice paid
    if (invoiceId) {
      await db.query(
        `UPDATE invoices SET status='paid', paid_on=CURRENT_DATE, payment_method='stripe' WHERE id=$1 AND status != 'paid'`,
        [invoiceId]
      );
    }
    // Send receipt email
    await sendReceiptEmail(payment, amountPaid, customerEmail, 'card (Stripe)');
    await db.query('UPDATE payments SET receipt_email_sent=true WHERE id=$1', [payment.id]);
  } else {
    // No pending row found — create succeeded row from scratch
    if (invoiceId) {
      const { rows: invRows } = await db.query('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
      const inv = invRows[0];
      if (inv) {
        await db.query(`
          INSERT INTO payments (invoice_id, child_id, bill_payer_email, amount_pence,
                                payment_method, provider_payment_id, stripe_checkout_session_id, status)
          VALUES ($1,$2,$3,$4,'stripe',$5,$6,'succeeded')
        `, [invoiceId, inv.child_id, customerEmail, amountPaid, paymentIntent, sessionId]);
        await db.query(
          `UPDATE invoices SET status='paid', paid_on=CURRENT_DATE, payment_method='stripe' WHERE id=$1 AND status != 'paid'`,
          [invoiceId]
        );
      }
    }
  }

  recordAudit({ req: null, action: 'update', entity_type: 'payment',
    entity_id: sessionId, actor_type: 'system',
    meta: { event: 'checkout.session.completed', invoice_id: invoiceId } });
}

async function handleStripeCheckoutExpired(db, session) {
  await db.query(`
    UPDATE payments SET status='failed', updated_at=NOW()
    WHERE stripe_checkout_session_id=$1 AND status='pending'
  `, [session.id]);
}

async function handleStripePaymentFailed(db, paymentIntent) {
  await db.query(`
    UPDATE payments SET status='failed', updated_at=NOW()
    WHERE provider_payment_id=$1 AND status='pending'
  `, [paymentIntent.id]);

  // Notify parent (best-effort)
  const { rows } = await db.query(
    `SELECT p.*, i.reference AS invoice_ref FROM payments p
     LEFT JOIN invoices i ON i.id=p.invoice_id
     WHERE p.provider_payment_id=$1`, [paymentIntent.id]
  );
  if (rows[0]?.bill_payer_email) {
    await sendEmail({
      to: rows[0].bill_payer_email,
      subject: 'Payment failed — Your Nursery',
      html: `<p>Your payment of ${fmt(rows[0].amount_pence)} for ${rows[0].description || 'nursery fees'} did not go through. Please log in to the parent hub to try again.</p>`,
      text: `Your payment of ${fmt(rows[0].amount_pence)} for ${rows[0].description || 'nursery fees'} did not go through. Please log in to the parent hub to try again.`,
    });
  }
}

// ── GoCardless webhook router ──────────────────────────────────────────────────
const gcRouter = express.Router();
gcRouter.use(express.raw({ type: 'application/json' }));

gcRouter.post('/', async (req, res) => {
  const sig = req.headers['webhook-signature'];
  if (!sig) return res.status(400).send('Missing Webhook-Signature');

  let payload;
  try {
    payload = await gc.verifyWebhook(req.body, sig);
  } catch (e) {
    console.error('[gc-webhook] verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  const db = getPool();
  const events = payload.events || [];

  for (const evt of events) {
    // Idempotency
    try {
      await db.query(`
        INSERT INTO gocardless_webhook_events (event_id, action, resource_type, meta)
        VALUES ($1, $2, $3, $4)
      `, [evt.id, evt.action, evt.resource_type, JSON.stringify(evt.links || {})]);
    } catch (e) {
      if (e.code === '23505') continue; // duplicate
      console.error('[gc-webhook] idempotency insert error:', e.message);
      continue;
    }

    try {
      if (evt.resource_type === 'payments') {
        await handleGCPaymentEvent(db, evt);
      } else if (evt.resource_type === 'mandates') {
        await handleGCMandateEvent(db, evt);
      }
    } catch (e) {
      console.error('[gc-webhook] handler error:', evt.resource_type, evt.action, e.message);
    }
  }

  res.json({ ok: true });
});

async function handleGCPaymentEvent(db, evt) {
  const gcPaymentId = evt.links?.payment;
  if (!gcPaymentId) return;

  const { rows } = await db.query(
    'SELECT * FROM payments WHERE provider_payment_id=$1', [gcPaymentId]
  );
  const payment = rows[0];

  if (evt.action === 'paid_out' || evt.action === 'confirmed') {
    await db.query(`
      UPDATE payments SET status='succeeded', updated_at=NOW()
      WHERE provider_payment_id=$1 AND status != 'succeeded'
    `, [gcPaymentId]);

    if (payment?.invoice_id) {
      await db.query(
        `UPDATE invoices SET status='paid', paid_on=CURRENT_DATE, payment_method='gocardless'
         WHERE id=$1 AND status != 'paid'`,
        [payment.invoice_id]
      );
    }

    if (payment && !payment.receipt_email_sent && payment.bill_payer_email) {
      await sendReceiptEmail(payment, payment.amount_pence, payment.bill_payer_email, 'Direct Debit');
      await db.query('UPDATE payments SET receipt_email_sent=true WHERE id=$1', [payment.id]);
    }
  } else if (['failed', 'cancelled', 'charged_back'].includes(evt.action)) {
    await db.query(`
      UPDATE payments SET status='failed', updated_at=NOW()
      WHERE provider_payment_id=$1 AND status NOT IN ('succeeded', 'refunded')
    `, [gcPaymentId]);

    if (payment?.invoice_id) {
      await db.query(
        `UPDATE invoices SET status='sent', paid_on=NULL WHERE id=$1 AND status='paid'`,
        [payment.invoice_id]
      );
    }

    // Notify parent + admin
    if (payment?.bill_payer_email) {
      const amount = fmt(payment.amount_pence);
      await sendEmail({
        to: payment.bill_payer_email,
        subject: `Direct Debit collection failed — Your Nursery`,
        html: `<p>We were unable to collect ${amount} by Direct Debit for ${payment.description || 'nursery fees'}. Please log in to your parent hub to make alternative payment arrangements.</p>`,
        text: `We were unable to collect ${amount} by Direct Debit for ${payment.description || 'nursery fees'}. Please log in to your parent hub.`,
      });
    }

    // Notify admin via DB notification
    const db2 = getPool();
    try {
      await db2.query(`
        INSERT INTO notifications (type, title, body, data)
        VALUES ('payment_failed', 'Direct Debit collection failed',
                $1, $2)
      `, [
        `${payment?.bill_payer_email || 'Unknown'} — ${fmt(payment?.amount_pence)} failed (${evt.action})`,
        JSON.stringify({ payment_id: payment?.id, gc_payment_id: gcPaymentId }),
      ]);
    } catch { /* notifications table may not exist in all editions */ }
  }
}

async function handleGCMandateEvent(db, evt) {
  const gcMandateId = evt.links?.mandate;
  if (!gcMandateId) return;

  const statusMap = {
    submitted: 'pending',
    active: 'active',
    reinstated: 'active',
    cancelled: 'cancelled',
    failed: 'failed',
    expired: 'expired',
  };

  const newStatus = statusMap[evt.action];
  if (newStatus) {
    await db.query(
      'UPDATE gocardless_mandates SET status=$1, updated_at=NOW() WHERE mandate_id=$2',
      [newStatus, gcMandateId]
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt(pence) {
  return '£' + ((pence || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 });
}

async function sendReceiptEmail(payment, amountPence, toEmail, method) {
  if (!toEmail) return;
  try {
    await sendEmail({
      to: toEmail,
      subject: `Payment received — Your Nursery`,
      html: `
        <p>Thank you for your payment.</p>
        <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
          <tr><td style="padding:6px 12px;color:#666">Amount</td>
              <td style="padding:6px 12px;font-weight:600">${fmt(amountPence)}</td></tr>
          <tr><td style="padding:6px 12px;color:#666">For</td>
              <td style="padding:6px 12px">${payment.description || 'Nursery fees'}</td></tr>
          <tr><td style="padding:6px 12px;color:#666">Method</td>
              <td style="padding:6px 12px">${method}</td></tr>
          <tr><td style="padding:6px 12px;color:#666">Date</td>
              <td style="padding:6px 12px">${new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}</td></tr>
        </table>
        <p style="margin-top:16px;font-size:12px;color:#999">Your Nursery, 1A Example Lane, London W13 9LU</p>
      `,
      text: `Thank you for your payment of ${fmt(amountPence)} for ${payment.description || 'nursery fees'}. Paid by ${method}.`,
    });
  } catch (e) {
    console.error('[payments] receipt email error:', e.message);
  }
}

module.exports = { stripe: stripeRouter, gocardless: gcRouter };
