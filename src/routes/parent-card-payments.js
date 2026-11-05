'use strict';
/* ===========================================================================
 * parent-card-payments.js — 2026-10-01
 *
 * A parent pays an invoice by card, through Opayo Pi with 3-D Secure 2.
 * Mounted on the PARENTS portal at /welcome/pay (server-unified.js).
 *
 * Toby: "A parent said they can't see card payments … get the payment stuff up
 * and running." The October letter promised "card payments still work for
 * October only, while everyone gets set up" — and Wren had no card option at
 * all (Stripe never configured; the Payments page's button 503'd).
 *
 *   GET  /api/methods             what this family can pay with right now
 *   POST /api/card/start          { invoice_id } → a merchant session key + the amount
 *   POST /api/card/pay            { ref, card_identifier, browser } → Ok | 3DAuth | declined
 *   POST /3ds-return              the bank's challenge page posts cres here (PUBLIC — see below)
 *   GET  /api/card/attempt/:ref   how an attempt ended, for the result screen
 *
 * PCI: the card number goes from the parent's browser to Opayo inside Opayo's own
 * drop-in frame (sagepay.js). Wren only ever sees Opayo's single-use card
 * identifier, and does not store that either. SAQ A.
 *
 * THE 3-D SECURE RETURN is a cross-site POST from the issuer's page, so it
 * carries no session cookie and cannot pass Cloudflare Access: the path
 * /welcome/pay/3ds-return has its own Access BYPASS app. It authenticates by
 * the attempt instead — threeDSSessionData is our own single-use attempt code,
 * the attempt must be waiting on a challenge, and the result is re-read from
 * Opayo before anything is recorded. It can complete an attempt a parent
 * started; it can do nothing else.
 *
 * Money is recorded the way payment-matcher.applyProposal records it: one
 * payments row + allocation(s) with the INVOICE's period, invoice → paid only
 * when nothing is left owing. Idempotent on the Opayo transaction id
 * (payments_opayo_provider_id_uq), so a refresh or a double POST records once.
 * =========================================================================== */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getPool } = require('../db/pool');
const { parentEmailOf } = require('../lib/parent-identity');
const { getDecryptedSetting } = require('../lib/payment-settings');
const opayo = require('../lib/opayo-pi');
const AP = require('../lib/allocation-period');
const IO = require('../lib/invoice-outstanding');
const { recordAudit } = require('../utils/audit');
const { outstandingSql, familyOpenInvoices } = require('../lib/invoice-outstanding');

const S = 'ladn';
const PARENTS_BASE = process.env.PARENTS_PUBLIC_URL || 'https://parents.example-nursery.co.uk';

router.use(express.urlencoded({ extended: false, limit: '64kb' }));
router.use(express.json({ limit: '64kb' }));
router.use((req, res, next) => (req._portal && req._portal !== 'parents') ? next('router') : next());

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error('[card-pay]', req.method, req.path, e.message);
  res.status(e.status || 500).json({ error: e.publicMessage || 'Something went wrong. Nothing has been taken from your card.' });
});
const fail = (status, publicMessage) => Object.assign(new Error(publicMessage), { status, publicMessage });

async function settingValue(db, key, fallback = null) {
  const { rows } = await db.query(`SELECT value FROM ${S}.settings WHERE key = $1`, [key]);
  return rows.length ? rows[0].value : fallback;
}

async function opayoConfig() {
  const cfg = {
    vendor:              await getDecryptedSetting('opayo_vendor'),
    integrationKey:      await getDecryptedSetting('opayo_integration_key'),
    integrationPassword: await getDecryptedSetting('opayo_integration_password'),
    env:                 await getDecryptedSetting('opayo_env'),
  };
  return (cfg.vendor && cfg.integrationKey && cfg.integrationPassword) ? cfg : null;
}

/** Card payments are on while Opayo is configured and the letter's window is open. */
async function cardOpen(db) {
  if (!(await opayoConfig())) return false;
  const until = String(await settingValue(db, 'card_payments_until', '') || '').trim();
  if (!until) return true;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  return today <= until;
}

async function parentChildIds(db, email) {
  const { rows } = await db.query(
    `SELECT pa.child_id FROM ${S}.parent_portal_access pa
      WHERE lower(pa.email) = lower($1) AND pa.is_active = true`, [email]);
  return rows.map(r => Number(r.child_id));
}

/** The invoice, if it is this parent's and money is still owed on it. */
async function owedInvoice(db, email, invoiceId) {
  const ids = await parentChildIds(db, email);
  if (!ids.length) throw fail(403, 'This invoice is not on your account.');
  // 2026-10-06 — credit the family already holds (a deposit taken onto the account, an
  // "on account" payment) goes onto this bill first, so it is never charged twice.
  const { rows: own } = await db.query(
    `SELECT 1 FROM ${S}.invoices WHERE id = $1 AND child_id = ANY($2::int[])`, [invoiceId, ids]);
  if (own.length) { try { await IO.applyUnallocatedCredit(db, invoiceId, S); } catch (_) {} }
  const { rows } = await db.query(`
    SELECT i.id, i.child_id, i.invoice_number, i.reference, i.period_label, i.amount_pence, i.status,
           -- 2026-10-06: one rule for what's owed (src/lib/invoice-outstanding.js) — credit notes,
           -- allocations AND payments recorded straight against the invoice (bank Reconcile).
           ${IO.outstandingSql('i', S)} AS outstanding_pence
      FROM ${S}.invoices i
     WHERE i.id = $1 AND i.child_id = ANY($2::int[]) AND i.credit_note_for_id IS NULL
       AND COALESCE(i.status, '') NOT IN ('draft','void','cancelled','written_off','writeoff','credited','credit_note','paid','brought_forward')`,
    [invoiceId, ids]);
  if (!rows.length) throw fail(404, 'That invoice is already paid, or is not on your account.');
  const inv = rows[0];
  inv.outstanding_pence = Number(inv.outstanding_pence);
  // Never more than the family owes overall (the statement balance they can see).
  try {
    const bal = await IO.familyBalance(db, inv.child_id, S);
    if (bal < inv.outstanding_pence) inv.outstanding_pence = Math.max(0, bal);
  } catch (_) {}
  if (!(inv.outstanding_pence > 0)) throw fail(409, 'Nothing is left to pay — your account is up to date.');
  return inv;
}

/**
 * 2026-10-12 (b492) — the family's live balance: every open invoice across the
 * children this parent login can see, oldest first, and the total still owed. Called
 * fresh both when the card page opens AND again right before the card is charged —
 * "the amount is re-computed server-side at checkout and again on the provider
 * callback" — so a payment landing in between (the office keys one in, a sibling's
 * parent pays first) is never over-charged.
 */
async function familyBalancePlan(db, childIds) {
  // release-money2 review F2 — the same two steps owedInvoice() takes for one bill. Without
  // them the card charged the sum of the open bills while the Invoices page's "Pay balance £X"
  // (the family ledger) had already netted the family's on-account credit: £20 on account →
  // button £1,580, card charged £1,600, family left £20 in credit (4 of 22 owing logins on prod).
  let invoices = await familyOpenInvoices(db, childIds, S);
  for (const inv of invoices) { try { await IO.applyUnallocatedCredit(db, inv.id, S); } catch (_) {} }
  invoices = await familyOpenInvoices(db, childIds, S);
  const owedOnBills = invoices.reduce((s, r) => s + (Number(r.outstanding_pence) || 0), 0);
  let balance = owedOnBills;
  try {
    const { rows } = await db.query(
      `SELECT id FROM ${S}.children WHERE id = ANY($1::int[]) AND COALESCE(is_demo, false) = false`, [childIds]);
    const { familyLedger } = require('../lib/family-ledger');
    balance = Math.max(0, Number((await familyLedger(db, rows.map(r => Number(r.id)), { schema: S })).balance_pence) || 0);
  } catch (_) {}
  const total_pence = Math.min(owedOnBills, balance);
  return { invoices, total_pence, account_credit_pence: owedOnBills - total_pence };
}

/** The payer's name and billing address, from the child's record. */
async function payerDetails(db, childId, email) {
  const { rows } = await db.query(`
    SELECT c.parent_1_name, c.parent_1_email, c.parent_2_name, c.parent_2_email,
           c.address_line1, c.postcode,
           NULLIF(lower(btrim(c.primary_contact_email)), '') AS family_key
      FROM ${S}.children c WHERE c.id = $1`, [childId]);
  const c = rows[0] || {};
  const e = String(email || '').toLowerCase();
  const name = (String(c.parent_2_email || '').toLowerCase() === e && c.parent_2_name) ? c.parent_2_name
             : (c.parent_1_name || c.parent_2_name || 'Parent');
  const parts = String(name).trim().split(/\s+/);
  const { rows: ref } = c.family_key
    ? await db.query(`SELECT payment_ref FROM ${S}.family_payment_refs WHERE family_key = $1 AND retired_at IS NULL LIMIT 1`, [c.family_key])
    : { rows: [] };
  return {
    first: parts[0] || 'Parent',
    last: parts.length > 1 ? parts.slice(1).join(' ') : (parts[0] || 'Parent'),
    address1: c.address_line1 || '',
    postcode: c.postcode || '',
    familyRef: ref[0] ? ref[0].payment_ref : null,
  };
}

/**
 * 2026-10-12 (b492) — one Opayo payment, allocated across the family's open invoices
 * oldest-first (then by child): the same rule Reconcile uses
 * (src/services/payment-matcher.js planAllocation/applyProposal — a payments row per
 * invoice it settles, a payment_allocations row each), but computed from
 * outstandingSql so it agrees with the GREATEST(outstandingSql,0) the Invoices page and
 * familyOpenInvoices() already show, rather than planAllocation's older, simpler
 * figure (see src/lib/invoice-outstanding.js's header — two outstanding calculations
 * coexist in this codebase; this one is the current, fixed one).
 *
 * Re-locks and re-reads outstanding NOW, under FOR UPDATE — not the plan `/api/balance/
 * pay` made moments before charging the card — because another payment (the office,
 * a sibling's parent) can land in between. Any pence the card took that no longer fits
 * an open invoice (that race) is parked as an unallocated 'credit-note-excess' payment
 * — the exact shape applyUnallocatedCredit() already knows how to spend on the
 * family's next bill, rather than inventing a second credit mechanism.
 * @returns {Promise<number[]>} the payments.id rows created, first one first.
 */
async function recordFamilyBalancePayment(client, att, paidPence, today) {
  const { rows: open } = await client.query(`
    SELECT i.id, i.child_id, GREATEST(${outstandingSql('i', S)}, 0)::int AS outstanding_pence
      FROM ${S}.invoices i
      JOIN ${S}.children c ON c.id = i.child_id AND COALESCE(c.is_demo, false) = false
     WHERE i.id = ANY($1::int[]) AND i.credit_note_for_id IS NULL
       AND COALESCE(i.status, '') NOT IN
           ('draft','void','cancelled','written_off','writeoff','credited','credit_note','paid','brought_forward')
     ORDER BY i.issued_on NULLS LAST, i.child_id, i.id
     FOR UPDATE OF i`, [att.invoice_ids || []]);

  let remaining = Number(paidPence) || 0;
  const paymentIds = [];
  for (const inv of open) {
    if (remaining <= 0) break;
    const outstanding = Number(inv.outstanding_pence) || 0;
    if (outstanding <= 0) continue;
    const take = Math.min(remaining, outstanding);
    const { rows: [pmt] } = await client.query(`
      INSERT INTO ${S}.payments
        (invoice_id, child_id, bill_payer_email, amount_pence, currency, payment_method, provider_payment_id,
         status, description, paid_on, source, reconciliation_status, family_payment_ref, match_kind,
         match_certainty, match_evidence, card_attempt_id, updated_at)
      VALUES ($1,$2,$3,$4,'GBP','card',$5,'succeeded',$6,$7,'opayo','reconciled',$8,'card_opayo','certain',$9::jsonb,$10,now())
      RETURNING id`,
      [inv.id, inv.child_id, att.parent_email, take, `${att.opayo_transaction_id}-${inv.id}`,
       `Card payment (Opayo) — family balance — ${att.vendor_tx_code}`, today, att.family_payment_ref,
       JSON.stringify({ vendor_tx_code: att.vendor_tx_code, env: att.env, family_balance: true }), att.id]);
    paymentIds.push(pmt.id);
    const per = await AP.periodOfInvoiceId(client, inv.id);
    await client.query(`
      INSERT INTO ${S}.payment_allocations
        (payment_id, invoice_id, child_id, amount_pence, allocated_on, source, reference, period_year, period_month, period_source)
      VALUES ($1,$2,$3,$4,$5,'opayo',$6,$7,$8,$9)`,
      [pmt.id, inv.id, inv.child_id, take, today, att.family_payment_ref || att.vendor_tx_code,
       per.year, per.month, per.source]);
    if (take === outstanding) {
      await client.query(
        `UPDATE ${S}.invoices SET status='paid', paid_on=$1, payment_method='card', updated_at=now()
          WHERE id=$2 AND status IN ('sent','overdue','issued','partial','unpaid','pending')`, [today, inv.id]);
    }
    remaining -= take;
  }
  if (remaining > 0) {
    const { rows: [credit] } = await client.query(`
      INSERT INTO ${S}.payments
        (child_id, bill_payer_email, amount_pence, currency, payment_method, provider_payment_id,
         status, description, paid_on, source, reconciliation_status, family_payment_ref, card_attempt_id, updated_at)
      VALUES ($1,$2,$3,'GBP','card',$4,'succeeded',$5,$6,'credit-note-excess','reconciled',$7,$8,now())
      RETURNING id`,
      [att.child_id, att.parent_email, remaining, `${att.opayo_transaction_id}-credit`,
       `Card payment (Opayo) — family balance, held as credit — ${att.vendor_tx_code}`, today,
       att.family_payment_ref, att.id]);
    paymentIds.push(credit.id);
  }
  return paymentIds;
}

/** Record a successful card payment against its invoice — exactly once. */
async function recordPayment(db, attempt, tx) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [att] } = await client.query(
      `SELECT * FROM ${S}.opayo_payment_attempts WHERE id = $1 FOR UPDATE`, [attempt.id]);
    if (att.recorded_payment_id) { await client.query('COMMIT'); return att.recorded_payment_id; }

    const paidPence = Number(tx && tx.amount && tx.amount.totalAmount) || att.amount_pence;

    if (att.is_family_balance) {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
      const paymentIds = await recordFamilyBalancePayment(client, att, paidPence, today);
      await client.query(
        `UPDATE ${S}.opayo_payment_attempts SET status='ok', recorded_payment_id=$2, updated_at=now() WHERE id=$1`,
        [att.id, paymentIds[0]]);
      await client.query('COMMIT');
      try {
        const { notify } = require('../services/notification-dispatcher');
        const gbp = '£' + (paidPence / 100).toFixed(2);
        const n = (att.invoice_ids || []).length;
        notify('card_payment_received', 'parent', att.child_id, 'Payment received — thank you',
          `We've received your card payment of ${gbp} towards your family balance.`,
          { relatedTable: 'payments', relatedId: paymentIds[0], link: '/welcome/invoices' });
        const managerId = Number(await settingValue(db, 'call_notify_staff_id', '1')) || 1;
        notify('card_payment_received', 'staff', managerId, `Card payment ${gbp}`,
          `${att.family_payment_ref || 'A family'} paid ${gbp} by card — family balance payment across ${n} invoice${n === 1 ? '' : 's'}.`,
          { relatedTable: 'payments', relatedId: paymentIds[0], link: '/finance.html' });
      } catch (_) { /* a notification never undoes a payment */ }
      return paymentIds[0];
    }
    const { rows: [inv] } = await client.query(`
      SELECT i.id, i.child_id, i.amount_pence,
             ${IO.outstandingSql('i', S)} AS outstanding
        FROM ${S}.invoices i WHERE i.id = $1 FOR UPDATE`, [att.invoice_id]);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

    const { rows: pay } = await client.query(`
      INSERT INTO ${S}.payments
        (invoice_id, child_id, bill_payer_email, amount_pence, currency, payment_method, provider_payment_id,
         status, description, paid_on, source, reconciliation_status, family_payment_ref, match_kind,
         match_certainty, match_evidence, updated_at)
      VALUES ($1,$2,$3,$4,'GBP','card',$5,'succeeded',$6,$7,'opayo','reconciled',$8,'card_opayo','certain',$9::jsonb,now())
      ON CONFLICT (provider_payment_id) WHERE source = 'opayo' AND provider_payment_id IS NOT NULL DO NOTHING
      RETURNING id`,
      [att.invoice_id, att.child_id, att.parent_email, paidPence, att.opayo_transaction_id,
       `Card payment (Opayo) — ${att.vendor_tx_code}`, today, att.family_payment_ref,
       JSON.stringify({ vendor_tx_code: att.vendor_tx_code, env: att.env, three_ds: att.three_ds_status || null })]);
    let paymentId = pay[0] && pay[0].id;
    if (!paymentId) {
      const { rows: ex } = await client.query(
        `SELECT id FROM ${S}.payments WHERE source = 'opayo' AND provider_payment_id = $1`, [att.opayo_transaction_id]);
      paymentId = ex[0] && ex[0].id;
    } else {
      const per = await AP.periodOfInvoiceId(client, att.invoice_id);
      await client.query(`
        INSERT INTO ${S}.payment_allocations
          (payment_id, invoice_id, child_id, amount_pence, allocated_on, source, reference, period_year, period_month, period_source)
        VALUES ($1,$2,$3,$4,$5,'opayo',$6,$7,$8,$9)`,
        [paymentId, att.invoice_id, att.child_id, paidPence, today, att.family_payment_ref || att.vendor_tx_code,
         per.year, per.month, per.source]);
      if (inv && paidPence >= Number(inv.outstanding)) {
        await client.query(
          `UPDATE ${S}.invoices SET status='paid', paid_on=$1, payment_method='card', updated_at=now()
            WHERE id=$2 AND status IN ('sent','overdue','issued','partial','unpaid','pending')`, [today, att.invoice_id]);
      }
    }
    await client.query(
      `UPDATE ${S}.opayo_payment_attempts SET status='ok', recorded_payment_id=$2, updated_at=now() WHERE id=$1`,
      [att.id, paymentId]);
    await client.query('COMMIT');

    try {
      const { notify } = require('../services/notification-dispatcher');
      const gbp = '£' + (paidPence / 100).toFixed(2);
      notify('card_payment_received', 'parent', att.child_id, 'Payment received — thank you',
        `We've received your card payment of ${gbp}.`, { relatedTable: 'invoices', relatedId: att.invoice_id, link: '/welcome/invoices' });
      const managerId = Number(await settingValue(db, 'call_notify_staff_id', '1')) || 1;
      notify('card_payment_received', 'staff', managerId, `Card payment ${gbp}`,
        `${att.family_payment_ref || 'A family'} paid ${gbp} by card (invoice #${att.invoice_id}).`,
        { relatedTable: 'invoices', relatedId: att.invoice_id, link: '/finance.html' });
    } catch (_) { /* a notification never undoes a payment */ }
    return paymentId;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Opayo's answer → our attempt row, and the money if it was taken. */
async function settle(db, attempt, tx, cfg) {
  const status = String(tx && tx.status || '');
  const threeD = tx && tx['3DSecure'] && tx['3DSecure'].status || null;
  await db.query(`
    UPDATE ${S}.opayo_payment_attempts
       SET opayo_transaction_id = COALESCE(opayo_transaction_id, $2), status_code = $3, status_detail = $4,
           three_ds_status = COALESCE($5, three_ds_status),
           status = CASE WHEN $6 = 'Ok' THEN status WHEN $6 = '3DAuth' THEN '3dauth'
                         WHEN $6 IN ('NotAuthed','Rejected','Declined') THEN 'declined' ELSE 'error' END,
           updated_at = now()
     WHERE id = $1`,
    [attempt.id, tx && tx.transactionId || null, tx && tx.statusCode || null,
     String(tx && tx.statusDetail || '').slice(0, 300), threeD, status]);
  if (status !== 'Ok') return { status };
  // Never take the browser's word for it, nor even our own create call's: read it back.
  const back = await opayo.getTransaction(cfg, tx.transactionId);
  if (String(back.status) !== 'Ok' || String(back.transactionType || 'Payment') !== 'Payment') {
    await db.query(`UPDATE ${S}.opayo_payment_attempts SET status='error', status_detail=$2, updated_at=now() WHERE id=$1`,
      [attempt.id, `read-back disagreed: ${back.status}`]);
    return { status: 'error' };
  }
  const { rows: [fresh] } = await db.query(`SELECT * FROM ${S}.opayo_payment_attempts WHERE id=$1`, [attempt.id]);
  await recordPayment(db, fresh, back);
  return { status: 'Ok' };
}

// ── GET /api/methods ────────────────────────────────────────────────────────
router.get('/api/methods', wrap(async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not signed in' });
  const db = getPool();
  const until = String(await settingValue(db, 'card_payments_until', '') || '').trim() || null;
  // Direct Debit is offered only when GoCardless is configured AND live (token live_…, or
  // gocardless_env=live). Setting up a mandate collects nothing — collection is a separate
  // switch (settings.dd_collection_enabled) the manager turns on.
  let directDebit = false;
  try { directDebit = !(await require('../lib/gocardless-client').isTestMode()); } catch (_) { directDebit = false; }
  res.json({ card: await cardOpen(db), card_until: until, bank_transfer: true, direct_debit: directDebit });
}));

// ── POST /api/card/start ────────────────────────────────────────────────────
router.post('/api/card/start', wrap(async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not signed in' });
  const db = getPool();
  if (!(await cardOpen(db))) throw fail(409, 'Card payments are not available at the moment. Please pay by bank transfer.');
  const cfg = await opayoConfig();
  const inv = await owedInvoice(db, email, Number((req.body || {}).invoice_id));
  const payer = await payerDetails(db, inv.child_id, email);
  const vtc = 'LA' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(5).toString('hex').toUpperCase();
  await db.query(`
    INSERT INTO ${S}.opayo_payment_attempts (vendor_tx_code, invoice_id, child_id, parent_email, family_payment_ref, amount_pence, env, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'created')`,
    [vtc, inv.id, inv.child_id, email, payer.familyRef, inv.outstanding_pence, cfg.env === 'live' ? 'live' : 'sandbox']);
  const msk = await opayo.merchantSessionKey(cfg);
  res.json({
    ref: vtc, merchant_session_key: msk.key, expires_at: msk.expiresAt,
    script_url: opayo.baseFor(cfg.env).replace(/\/api\/v1$/, '') + '/api/v1/js/sagepay.js',
    amount_pence: inv.outstanding_pence,
    label: [inv.period_label, inv.invoice_number || inv.reference].filter(Boolean).join(' · '),
    env: cfg.env === 'live' ? 'live' : 'sandbox',
  });
}));

// ── POST /api/card/pay ──────────────────────────────────────────────────────
router.post('/api/card/pay', wrap(async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not signed in' });
  const db = getPool();
  const b = req.body || {};
  const { rows } = await db.query(
    `SELECT * FROM ${S}.opayo_payment_attempts WHERE vendor_tx_code = $1 AND lower(parent_email) = lower($2)`,
    [String(b.ref || ''), email]);
  if (!rows.length) throw fail(404, 'That payment has expired. Please start again.');
  const att = rows[0];
  if (att.status !== 'created') throw fail(409, 'This payment has already been submitted.');
  if (!b.card_identifier) throw fail(400, 'Card details are missing. Please try again.');
  // the amount is re-read now, not trusted from when the form opened
  const inv = await owedInvoice(db, email, att.invoice_id);
  const amount = Math.min(inv.outstanding_pence, att.amount_pence);
  await db.query(`UPDATE ${S}.opayo_payment_attempts SET status='submitted', amount_pence=$2, updated_at=now() WHERE id=$1`, [att.id, amount]);
  const cfg = await opayoConfig();
  const payer = await payerDetails(db, att.child_id, email);
  const apply3DS = String(await settingValue(db, 'opayo_apply_3dsecure', 'UseMSPSetting') || 'UseMSPSetting');
  const br = b.browser || {};
  let tx;
  try {
    tx = await opayo.createTransaction(cfg, {
      vendorTxCode: att.vendor_tx_code, amountPence: amount,
      description: `Your Nursery fees ${inv.invoice_number || ('#' + inv.id)}`,
      cardIdentifier: String(b.card_identifier), merchantSessionKey: String(b.merchant_session_key || ''),
      customerFirstName: payer.first, customerLastName: payer.last, customerEmail: email,
      billingAddress1: payer.address1 || 'Not given', billingCity: 'London', billingPostalCode: payer.postcode || 'AB1 2CD',
      apply3DSecure: apply3DS,
      notificationURL: `${PARENTS_BASE}/welcome/pay/3ds-return`,
      browser: {
        browserIP: String(req.headers['cf-connecting-ip'] || req.ip || '').replace(/^::ffff:/, ''),
        browserAcceptHeader: req.headers.accept || 'text/html',
        browserLanguage: br.language, browserColorDepth: br.colorDepth, browserScreenHeight: br.screenHeight,
        browserScreenWidth: br.screenWidth, browserTZ: br.tz, browserUserAgent: req.headers['user-agent'],
        challengeWindowSize: 'FullScreen',
      },
    });
  } catch (e) {
    await db.query(`UPDATE ${S}.opayo_payment_attempts SET status='error', status_detail=$2, updated_at=now() WHERE id=$1`,
      [att.id, String(e.message).slice(0, 300)]);
    console.error('[card-pay] create:', e.message);
    throw fail(402, 'Your card was not charged. Please check the details and try again, or pay by bank transfer.');
  }
  const out = await settle(db, att, tx, cfg);
  recordAudit({ req, action: 'create', entity_type: 'card_payment', entity_id: att.id,
    meta: { invoice_id: att.invoice_id, status: out.status, env: att.env } }).catch(() => {});
  if (out.status === '3DAuth') {
    return res.json({ status: '3dauth', acs_url: tx.acsUrl, creq: tx.cReq,
      three_ds_session_data: Buffer.from(att.vendor_tx_code).toString('base64url') });
  }
  if (out.status === 'Ok') return res.json({ status: 'ok', ref: att.vendor_tx_code });
  res.json({ status: 'declined', message: 'Your bank did not approve the payment. Nothing has been taken. You can try another card or pay by bank transfer.' });
}));

// ── Family balance in one payment — b492 (2026-10-12) ─────────────────────────────
// Toby: "families of twins — allow them to pay the full balance… if families have a
// few outstanding invoices there should be a button to just pay outstanding balance
// and clear everything, or they can pay separate invoices. Twin parents would want
// that one payment." One Opayo transaction for the family's WHOLE outstanding
// balance (parentChildIds — the same scope every other route in this file uses),
// allocated oldest-first by recordFamilyBalancePayment() above. The per-invoice
// /api/card/start+pay above are unchanged and still work for a single bill.

// ── POST /api/balance/start ────────────────────────────────────────────────────
router.post('/api/balance/start', wrap(async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not signed in' });
  const db = getPool();
  if (!(await cardOpen(db))) throw fail(409, 'Card payments are not available at the moment. Please pay by bank transfer.');
  const cfg = await opayoConfig();
  const childIds = await parentChildIds(db, email);
  if (!childIds.length) throw fail(403, 'No children on your account.');
  const plan = await familyBalancePlan(db, childIds);
  if (!(plan.total_pence > 0)) throw fail(409, 'There is nothing left to pay on your account.');
  const payer = await payerDetails(db, plan.invoices[0].child_id, email);
  const vtc = 'LA' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(5).toString('hex').toUpperCase();
  await db.query(`
    INSERT INTO ${S}.opayo_payment_attempts
      (vendor_tx_code, invoice_id, child_id, parent_email, family_payment_ref, amount_pence, env, status,
       is_family_balance, invoice_ids)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'created',true,$8)`,
    [vtc, plan.invoices[0].id, plan.invoices[0].child_id, email, payer.familyRef, plan.total_pence,
     cfg.env === 'live' ? 'live' : 'sandbox', plan.invoices.map(i => i.id)]);
  const msk = await opayo.merchantSessionKey(cfg);
  res.json({
    ref: vtc, merchant_session_key: msk.key, expires_at: msk.expiresAt,
    script_url: opayo.baseFor(cfg.env).replace(/\/api\/v1$/, '') + '/api/v1/js/sagepay.js',
    amount_pence: plan.total_pence,
    label: `Family balance — ${plan.invoices.length} invoice${plan.invoices.length === 1 ? '' : 's'}`,
    account_credit_pence: plan.account_credit_pence || 0,
    breakdown: plan.invoices.map(i => ({
      invoice_id: i.id, invoice_number: i.invoice_number || i.reference, period_label: i.period_label,
      child_id: i.child_id, child_name: i.child_first_name || null, invoice_total_pence: Number(i.amount_pence) || 0,
      outstanding_pence: Number(i.outstanding_pence) || 0,
    })),
    env: cfg.env === 'live' ? 'live' : 'sandbox',
  });
}));

// ── POST /api/balance/pay ──────────────────────────────────────────────────────
router.post('/api/balance/pay', wrap(async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not signed in' });
  const db = getPool();
  const b = req.body || {};
  const { rows } = await db.query(
    `SELECT * FROM ${S}.opayo_payment_attempts
      WHERE vendor_tx_code = $1 AND lower(parent_email) = lower($2) AND is_family_balance = true`,
    [String(b.ref || ''), email]);
  if (!rows.length) throw fail(404, 'That payment has expired. Please start again.');
  const att = rows[0];
  if (att.status !== 'created') throw fail(409, 'This payment has already been submitted.');
  if (!b.card_identifier) throw fail(400, 'Card details are missing. Please try again.');
  // the amount is re-read now, not trusted from when the breakdown was shown
  const childIds = await parentChildIds(db, email);
  const plan = await familyBalancePlan(db, childIds);
  if (!(plan.total_pence > 0)) throw fail(409, 'There is nothing left to pay — your balance has already been settled.');
  const amount = Math.min(plan.total_pence, att.amount_pence);
  await db.query(`
    UPDATE ${S}.opayo_payment_attempts SET status='submitted', amount_pence=$2, invoice_ids=$3, updated_at=now()
     WHERE id=$1`, [att.id, amount, plan.invoices.map(i => i.id)]);
  const cfg = await opayoConfig();
  const payer = await payerDetails(db, plan.invoices[0].child_id, email);
  const apply3DS = String(await settingValue(db, 'opayo_apply_3dsecure', 'UseMSPSetting') || 'UseMSPSetting');
  const br = b.browser || {};
  let tx;
  try {
    tx = await opayo.createTransaction(cfg, {
      vendorTxCode: att.vendor_tx_code, amountPence: amount,
      description: `Your Nursery fees — family balance (${plan.invoices.length} invoices)`,
      cardIdentifier: String(b.card_identifier), merchantSessionKey: String(b.merchant_session_key || ''),
      customerFirstName: payer.first, customerLastName: payer.last, customerEmail: email,
      billingAddress1: payer.address1 || 'Not given', billingCity: 'London', billingPostalCode: payer.postcode || 'AB1 2CD',
      apply3DSecure: apply3DS,
      notificationURL: `${PARENTS_BASE}/welcome/pay/3ds-return`,
      browser: {
        browserIP: String(req.headers['cf-connecting-ip'] || req.ip || '').replace(/^::ffff:/, ''),
        browserAcceptHeader: req.headers.accept || 'text/html',
        browserLanguage: br.language, browserColorDepth: br.colorDepth, browserScreenHeight: br.screenHeight,
        browserScreenWidth: br.screenWidth, browserTZ: br.tz, browserUserAgent: req.headers['user-agent'],
        challengeWindowSize: 'FullScreen',
      },
    });
  } catch (e) {
    await db.query(`UPDATE ${S}.opayo_payment_attempts SET status='error', status_detail=$2, updated_at=now() WHERE id=$1`,
      [att.id, String(e.message).slice(0, 300)]);
    console.error('[card-pay] balance create:', e.message);
    throw fail(402, 'Your card was not charged. Please check the details and try again, or pay by bank transfer.');
  }
  const out = await settle(db, att, tx, cfg);
  recordAudit({ req, action: 'create', entity_type: 'card_payment', entity_id: att.id,
    meta: { family_balance: true, invoice_count: plan.invoices.length, status: out.status, env: att.env } }).catch(() => {});
  // release-money2 review F1: settle() returns Opayo's own word, '3DAuth' (as /api/card/pay
  // checks). '3dauth' never matched, so every card that needs a bank challenge was told
  // "declined" and never sent to its bank.
  if (out.status === '3DAuth') {
    return res.json({ status: '3dauth', acs_url: tx.acsUrl, creq: tx.cReq,
      three_ds_session_data: Buffer.from(att.vendor_tx_code).toString('base64url') });
  }
  if (out.status === 'Ok') return res.json({ status: 'ok', ref: att.vendor_tx_code });
  res.json({ status: 'declined', message: 'Your bank did not approve the payment. Nothing has been taken. You can try another card or pay by bank transfer.' });
}));

// ── POST /3ds-return — the issuer's challenge page posts the parent back here ──
// PUBLIC (Cloudflare Access bypass on this one path). Authenticated by the attempt.
router.post('/3ds-return', async (req, res) => {
  const db = getPool();
  let ref = '';
  try {
    const cres = String((req.body || {}).cres || (req.body || {}).cRes || '');
    const sess = String((req.body || {}).threeDSSessionData || '');
    ref = Buffer.from(sess, 'base64url').toString('utf8');
    if (!cres || !/^LA[0-9A-Z]{6,40}$/.test(ref)) throw new Error('bad return');
    const { rows } = await db.query(`SELECT * FROM ${S}.opayo_payment_attempts WHERE vendor_tx_code = $1`, [ref]);
    const att = rows[0];
    if (!att || att.status !== '3dauth' || !att.opayo_transaction_id) throw new Error('no attempt waiting');
    if (Date.now() - new Date(att.updated_at).getTime() > 30 * 60 * 1000) throw new Error('challenge too old');
    const cfg = await opayoConfig();
    await db.query(`UPDATE ${S}.opayo_payment_attempts SET status='completing', updated_at=now() WHERE id=$1 AND status='3dauth'`, [att.id]);
    const tx = await opayo.complete3DSecure(cfg, att.opayo_transaction_id, { cres, threeDSSessionData: sess });
    await settle(db, att, { ...tx, transactionId: tx.transactionId || att.opayo_transaction_id }, cfg);
  } catch (e) {
    console.error('[card-pay] 3ds-return:', e.message);
    // never leave an attempt stuck at 'completing': the result screen must be able to say it failed
    if (/^LA[0-9A-Z]{6,40}$/.test(ref)) {
      await db.query(`UPDATE ${S}.opayo_payment_attempts SET status='error', status_detail=$2, updated_at=now()
                        WHERE vendor_tx_code=$1 AND status='completing'`, [ref, String(e.message).slice(0, 300)]).catch(() => {});
    }
  }
  res.redirect(303, '/welcome/pay-card?result=' + encodeURIComponent(ref || ''));
});

// ── GET /api/card/attempt/:ref ──────────────────────────────────────────────
router.get('/api/card/attempt/:ref', wrap(async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not signed in' });
  const db = getPool();
  const { rows } = await db.query(
    `SELECT a.id, a.status, a.amount_pence, a.invoice_id, a.is_family_balance, a.invoice_ids,
            i.period_label, i.invoice_number
       FROM ${S}.opayo_payment_attempts a LEFT JOIN ${S}.invoices i ON i.id = a.invoice_id
      WHERE a.vendor_tx_code = $1 AND lower(a.parent_email) = lower($2)`, [req.params.ref, email]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const r = rows[0];
  // b492 — a family-balance attempt's invoice_id is only the FIRST invoice it paid;
  // the result screen must say "family balance" and list every invoice it cleared
  // (one receipt for the whole payment), never just that one invoice's label.
  const n = (r.invoice_ids || []).length;
  let cleared = null;
  if (r.is_family_balance && r.status === 'ok') {
    const { rows: c } = await db.query(
      `SELECT p.amount_pence, i.period_label, i.invoice_number, ch.first_name
         FROM ${S}.payments p LEFT JOIN ${S}.invoices i ON i.id = p.invoice_id
         LEFT JOIN ${S}.children ch ON ch.id = i.child_id
        WHERE p.card_attempt_id = $1 ORDER BY p.id`, [r.id]);
    // review F4: name the child and the invoice — twins' bills share a month label
    cleared = c.map(x => ({ label: x.invoice_number ? [x.first_name, x.period_label, x.invoice_number].filter(Boolean).join(' · ') : 'Held as credit on your account',
                            amount_pence: x.amount_pence }));
  }
  const label = r.is_family_balance
    ? `Family balance — ${n} invoice${n === 1 ? '' : 's'}`
    : [r.period_label, r.invoice_number].filter(Boolean).join(' · ');
  res.json({ status: r.status === 'ok' ? 'ok' : (['declined', 'error', 'abandoned'].includes(r.status) ? 'declined' : 'pending'),
             amount_pence: r.amount_pence, label, cleared });
}));

module.exports = router;
module.exports._recordPayment = recordPayment;
module.exports._recordFamilyBalancePayment = recordFamilyBalancePayment;
module.exports._familyBalancePlan = familyBalancePlan;
