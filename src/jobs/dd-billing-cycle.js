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

  // 2026-10-01 — a master switch. The GoCardless key in the environment is the LIVE one, and this
  // job had no guard: on 2 Oct it would have collected £2,959.51 from two families who had not
  // been told Wren (rather than EyLog) now collects. Nothing is collected until
  // settings.dd_collection_enabled = 'on', which is a decision Toby makes, not a default.
  const { rows: sw } = await db.query(`SELECT value FROM settings WHERE key = 'dd_collection_enabled'`);
  if (!sw.length || String(sw[0].value).toLowerCase() !== 'on') {
    console.log('[dd-billing] OFF (settings.dd_collection_enabled is not "on") — nothing collected');
    try { await db.end?.(); } catch (_) {}
    return { processed: 0, skipped: 0, failed: 0, disabled: true };
  }

  try {
    // 2026-10-06 — credit the family already holds (a deposit paid before the first invoice,
    // an "on account" payment) goes onto the bill BEFORE anything is collected. The invoice
    // then has a payment against it and is left for the office (p.id IS NULL below), rather
    // than the full amount being taken from a family that has partly paid already.
    const IO = require('../lib/invoice-outstanding');
    const { rows: pre } = await db.query(`
      SELECT i.id FROM invoices i
       WHERE i.status IN ('sent','overdue') AND i.due_on <= CURRENT_DATE
         AND i.due_on >= COALESCE((SELECT NULLIF(btrim(value), '')::date FROM settings WHERE key = 'dd_collect_from'), DATE '1900-01-01')
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status IN ('pending','succeeded'))`);
    for (const r of pre) { try { await IO.applyUnallocatedCredit(db, r.id); } catch (_) {} }

    // Find all outstanding invoices where the bill-payer has an active mandate
    const { rows: due } = await db.query(`
      SELECT i.id AS invoice_id,
             -- collect what is still OWED: invoice less allocations and less any credit notes against it
             ${require('../lib/invoice-outstanding').outstandingSql('i', 'ladn')} AS amount_pence,
             i.bill_payer_email,
             i.reference, i.child_id,
             m.id AS mandate_db_id, m.mandate_id, m.status AS mandate_status
      FROM invoices i
      JOIN gocardless_mandates m
        ON lower(m.bill_payer_email) = lower(i.bill_payer_email)
        AND m.status = 'active'
        AND m.mandate_id IS NOT NULL
      LEFT JOIN payments p
        ON p.invoice_id = i.id AND p.status IN ('pending','succeeded')
      LEFT JOIN children dchild ON dchild.id = i.child_id
      WHERE i.status IN ('sent', 'overdue')
        AND i.due_on <= CURRENT_DATE
        -- b484 (2026-10-12): a demo child never gets collected by Direct Debit, even if a
        -- hand-created test invoice and a real mandate happen to share an email.
        AND COALESCE(dchild.is_demo, false) = false
        -- 2026-10-01 — a start date (settings.dd_collect_from, YYYY-MM-DD). Collection was switched on
        -- while payments since 28 Sep were not yet in Wren, so anything due before it is left for the
        -- office to reconcile rather than collected from a family who may already have paid another way.
        AND i.due_on >= COALESCE((SELECT NULLIF(btrim(value), '')::date FROM settings WHERE key = 'dd_collect_from'), DATE '1900-01-01')
        AND p.id IS NULL
      ORDER BY i.due_on ASC
    `);

    console.log(`[dd-billing] Found ${due.length} invoices due for DD collection`);

    for (const row of due) {
      if (!(Number(row.amount_pence) > 0)) { skipped++; continue; }   // nothing left owing
      // 2026-10-06 — never collect more than the family owes overall (their statement balance).
      try {
        const bal = await require('../lib/invoice-outstanding').familyBalance(db, row.child_id);
        if (bal < Number(row.amount_pence)) row.amount_pence = Math.max(0, bal);
      } catch (_) {}
      if (!(Number(row.amount_pence) > 0)) { skipped++; continue; }   // family is up to date or in credit
      try {
        const desc = `Your Nursery fees — invoice ${row.reference || row.invoice_id}`;
        const gcPayment = await gc.createPayment({
          mandateId:   row.mandate_id,
          amountPence: row.amount_pence,
          description: desc,
          // 2026-11-01 — no custom `reference`: GoCardless refuses it on our scheme identifier
          // ("Custom payment references are not enabled"), which failed all three November
          // collections. GoCardless sets its own; the invoice number is in the description.
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
