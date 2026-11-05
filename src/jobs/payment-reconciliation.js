#!/usr/bin/env node
'use strict';
// Nightly payment reconciliation job.
// Compares Wren's payments table to Stripe + GoCardless API for the last 7 days.
// Discrepancies are written to payment_reconciliation_flags.
//
// Run via cron (e.g. daily at 02:00):
//   node /app/src/jobs/payment-reconciliation.js

require('dotenv').config({ path: require('path').join(__dirname, '../../editions/ladn/.env'), override: false });

const { getPool }   = require('../db/pool');
const stripe        = require('../lib/stripe-client');
const gc            = require('../lib/gocardless-client');
const { sendEmail } = require('../utils/email');

async function run() {
  const db  = getPool();
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  console.log('[reconcile] Starting reconciliation for', since.toISOString(), '→', now.toISOString());

  let flags = 0;

  try {
    flags += await reconcileStripe(db, since);
    flags += await reconcileGoCardless(db, since);
  } finally {
    await db.end?.();
  }

  console.log(`[reconcile] Done — ${flags} flag(s) raised`);

  if (flags > 0) {
    await sendEmail({
      to: process.env.ADMIN_EMAIL || 'admin@example.com',
      subject: `Payment reconciliation: ${flags} discrepancy(ies) found`,
      html: `<p>${flags} discrepancy flag(s) were raised during the nightly reconciliation. Check the Payment Admin panel for details.</p>`,
      text: `${flags} discrepancy flag(s) during reconciliation. Check Payment Admin panel.`,
    }).catch(() => {});
  }

  return { flags };
}

async function reconcileStripe(db, since) {
  let flags = 0;
  try {
    const stripeData = await stripe.listPaymentIntents({ limit: 100, createdAfter: since });
    const stripeMap  = new Map((stripeData.data || []).map(pi => [pi.id, pi]));

    const { rows: wrenPayments } = await db.query(`
      SELECT * FROM payments
      WHERE payment_method='stripe' AND created_at > $1
    `, [since]);

    for (const wp of wrenPayments) {
      if (!wp.provider_payment_id) continue;
      const sp = stripeMap.get(wp.provider_payment_id);

      if (!sp) {
        // Missing in Stripe — flag it
        await raiseFlag(db, wp.id, 'stripe', 'missing_in_provider', {
          wren_status: wp.status, provider_payment_id: wp.provider_payment_id,
        });
        flags++;
        continue;
      }

      // Amount mismatch (Stripe stores in pence already for GBP)
      if (sp.amount !== wp.amount_pence) {
        await raiseFlag(db, wp.id, 'stripe', 'amount_mismatch', {
          wren_amount: wp.amount_pence, provider_amount: sp.amount,
        });
        flags++;
      }

      // Status mismatch
      const expectedWren = stripeStatusToWren(sp.status);
      if (expectedWren && wp.status !== expectedWren) {
        await raiseFlag(db, wp.id, 'stripe', 'status_mismatch', {
          wren_status: wp.status, provider_status: sp.status, expected: expectedWren,
        });
        flags++;
      }
    }

    // Mark reconciled payments
    await db.query(`
      UPDATE payments SET reconciled_at=NOW()
      WHERE payment_method='stripe' AND created_at > $1 AND reconciled_at IS NULL
        AND status='succeeded'
    `, [since]);

  } catch (e) {
    console.error('[reconcile] Stripe error:', e.message);
    // If Stripe not configured, skip gracefully
  }
  return flags;
}

async function reconcileGoCardless(db, since) {
  let flags = 0;
  try {
    const gcPayments = await gc.listPayments({ limit: 500, createdAfter: since });
    const gcMap      = new Map(gcPayments.map(p => [p.id, p]));

    const { rows: wrenPayments } = await db.query(`
      SELECT * FROM payments
      WHERE payment_method='gocardless' AND created_at > $1
    `, [since]);

    for (const wp of wrenPayments) {
      if (!wp.provider_payment_id) continue;
      const gp = gcMap.get(wp.provider_payment_id);

      if (!gp) {
        await raiseFlag(db, wp.id, 'gocardless', 'missing_in_provider', {
          wren_status: wp.status, provider_payment_id: wp.provider_payment_id,
        });
        flags++;
        continue;
      }

      // Amount mismatch
      if (gp.amount !== wp.amount_pence) {
        await raiseFlag(db, wp.id, 'gocardless', 'amount_mismatch', {
          wren_amount: wp.amount_pence, provider_amount: gp.amount,
        });
        flags++;
      }

      const expectedWren = gcStatusToWren(gp.status);
      if (expectedWren && wp.status !== expectedWren) {
        await raiseFlag(db, wp.id, 'gocardless', 'status_mismatch', {
          wren_status: wp.status, provider_status: gp.status, expected: expectedWren,
        });
        flags++;
      }
    }

    await db.query(`
      UPDATE payments SET reconciled_at=NOW()
      WHERE payment_method='gocardless' AND created_at > $1 AND reconciled_at IS NULL
        AND status='succeeded'
    `, [since]);

  } catch (e) {
    console.error('[reconcile] GoCardless error:', e.message);
  }
  return flags;
}

async function raiseFlag(db, paymentId, provider, flagType, detail) {
  try {
    await db.query(`
      INSERT INTO payment_reconciliation_flags (payment_id, provider, flag_type, detail)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [paymentId, provider, flagType, JSON.stringify(detail)]);
    console.log(`[reconcile] Flag raised: ${provider}/${flagType} for payment ${paymentId}`);
  } catch (e) {
    console.error('[reconcile] flag insert error:', e.message);
  }
}

function stripeStatusToWren(status) {
  return { succeeded: 'succeeded', canceled: 'failed', requires_payment_method: 'pending' }[status] || null;
}

function gcStatusToWren(status) {
  return {
    paid_out: 'succeeded', confirmed: 'succeeded',
    failed: 'failed', cancelled: 'failed', charged_back: 'refunded',
    pending_submission: 'pending', submitted: 'pending', pending_customer_approval: 'pending',
  }[status] || null;
}

if (require.main === module) {
  run().then(r => {
    console.log('[reconcile] Done:', r);
    process.exit(0);
  }).catch(e => {
    console.error('[reconcile] Fatal:', e.message);
    process.exit(1);
  });
}

module.exports = { run };
