#!/usr/bin/env node
'use strict';
// DD billing cycle job — creates GoCardless payments for active mandates
// with outstanding invoices due today or earlier.
//
// Run via cron or task runner:
//   node /app/src/jobs/dd-billing-cycle.js
//
// Task runner (port 3847):
//   curl -X POST http://localhost:3847/run/dd-billing-cycle \
//     -H "x-task-secret: <TASK_SECRET — see .env, not committed>"

require('dotenv').config({ path: require('path').join(__dirname, '../../editions/ladn/.env'), override: false });

const { getPool } = require('../db/pool');
const gc          = require('../lib/gocardless-client');
const { sendEmail } = require('../utils/email');

async function run() {
  const db = getPool();
  console.log('[dd-billing] Starting DD billing cycle', new Date().toISOString());

  let processed = 0, skipped = 0, failed = 0;

  try {
    // Find all outstanding invoices where the bill-payer has an active mandate
    const { rows: due } = await db.query(`
      SELECT i.id AS invoice_id, i.amount_pence, i.bill_payer_email,
             i.reference, i.child_id,
             m.id AS mandate_db_id, m.mandate_id, m.status AS mandate_status
      FROM invoices i
      JOIN gocardless_mandates m
        ON lower(m.bill_payer_email) = lower(i.bill_payer_email)
        AND m.status = 'active'
        AND m.mandate_id IS NOT NULL
      LEFT JOIN payments p
        ON p.invoice_id = i.id AND p.status IN ('pending','succeeded')
      WHERE i.status IN ('sent', 'overdue')
        AND i.due_on <= CURRENT_DATE
        AND p.id IS NULL
      ORDER BY i.due_on ASC
    `);

    console.log(`[dd-billing] Found ${due.length} invoices due for DD collection`);

    for (const row of due) {
      try {
        const desc = `Your Nursery fees — invoice ${row.reference || row.invoice_id}`;
        const gcPayment = await gc.createPayment({
          mandateId:   row.mandate_id,
          amountPence: row.amount_pence,
          description: desc,
          reference:   String(row.reference || row.invoice_id).slice(0, 10),
        });

        await db.query(`
          INSERT INTO payments
            (invoice_id, child_id, bill_payer_email, amount_pence, payment_method,
             provider_payment_id, gocardless_mandate_id, status, description)
          VALUES ($1,$2,$3,$4,'gocardless',$5,$6,'pending',$7)
        `, [row.invoice_id, row.child_id, row.bill_payer_email,
            row.amount_pence, gcPayment.id, row.mandate_db_id, desc]);

        console.log(`[dd-billing] Created GC payment ${gcPayment.id} for invoice ${row.invoice_id}`);
        processed++;
      } catch (e) {
        console.error(`[dd-billing] Failed for invoice ${row.invoice_id}:`, e.message);
        failed++;
      }
    }
  } finally {
    await db.end?.();
  }

  const summary = `DD billing cycle complete: ${processed} created, ${skipped} skipped, ${failed} failed`;
  console.log('[dd-billing]', summary);

  if (failed > 0) {
    await sendEmail({
      to: process.env.ADMIN_EMAIL || 'admin@example.com',
      subject: `DD billing: ${failed} failure(s) — action needed`,
      html: `<p>${summary}</p><p>Check the payments table for details.</p>`,
      text: summary,
    }).catch(() => {});
  }

  return { processed, skipped, failed };
}

// Run directly if called as a script
if (require.main === module) {
  run().then(r => {
    console.log('[dd-billing] Done:', r);
    process.exit(0);
  }).catch(e => {
    console.error('[dd-billing] Fatal:', e.message);
    process.exit(1);
  });
}

module.exports = { run };
