'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b423 (2026-10-08, DEV ONLY) — editable EyLog opening balance, per child.
//
// Toby: "It would be a lot easier if we can add an opening balance somewhere and edit
// it in case it needs to be changed." Today a wrong figure (ladn.opening_balances,
// set once at the 2026-10-06 money cutover — see src/lib/family-ledger.js and
// wren-docs/decisions/2026-10-06-eylog-opening-balances.md) has to be fixed by hand in
// SQL, the way child 93 was fixed on 2026-10-08 (r76 said -£1,740.20, EyLog's own
// statement said -£365.22). This file is that by-hand procedure, automated.
//
// The opening balance is held as a REAL money row, not a number that floats free of
// the ledger (the cutover's own "a virtual opening-balance row" option was rejected for
// exactly this reason — the per-invoice machinery would never see it):
//   owed      → an invoice  "Balance brought forward from EyLog" (opening_balances.invoice_id)
//   in credit → a payment   "Credit brought forward from EyLog"  (opening_balances.payment_id)
// Changing the number means changing (or retiring and recreating) that row, and putting
// right whatever money had already settled against it — never deleting a financial record.
//
// THE RULE THAT MAKES THIS SAFE: every helper below only ever MOVES or REDUCES existing
// money (an allocation shrunk, a payment's invoice_id freed, credit reapplied elsewhere).
// Nothing here manufactures or destroys pence. That means the family's total ledger
// balance (src/lib/family-ledger.js) always moves by exactly (new_pence - old_pence) —
// the UI relies on this to show a before/after preview without a round trip.
//
// Everything is backed up as one row in ladn.opening_balance_changes per edit — a full
// before/after snapshot (the opening_balances row, the BF invoice or credit payment, and
// every allocation touched), so a correction can always be read back, never silent.
// ─────────────────────────────────────────────────────────────────────────────

const { outstandingSql, applyUnallocatedCredit, familyChildIds } = require('./invoice-outstanding');
const { familyLedger, modeOf } = require('./family-ledger');
const AP = require('./allocation-period');

const sch = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s || '')) throw new Error('bad schema'); return s; };
const pence = (v) => Math.round(Number(v) || 0);
const sign = (p) => (p > 0 ? 1 : p < 0 ? -1 : 0);
const CUTOVER_AS_OF = '2026-09-26';
const gbp = (p) => '£' + (Math.abs(Number(p) || 0) / 100).toFixed(2);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (d) => { if (!d) return ''; const dt = new Date(d); return Number.isNaN(dt.getTime()) ? '' : `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`; };
// b423c (2026-10-11) — the only money freeFromInvoice is ever allowed to move automatically:
// THIS CHILD's own prior opening-balance output (its own "Credit brought forward", or an
// earlier edit's leftover 'opening-balance-adjustment'/'credit-note-excess' parking). Anything
// else — a bank/card/DD/TFC payment, a reconciled bank line, a sibling's credit, anyone else's
// money — is real and must never be silently moved or have its payment row rewritten.
const SAFE_OWN_SOURCES = new Set(['opening-balance', 'opening-balance-adjustment', 'credit-note-excess']);

async function familyBalancePence(client, childIds, S) {
  const l = await familyLedger(client, childIds, { schema: S });
  return Number(l.balance_pence) || 0;
}

// ══ SNAPSHOT — the before/after backup for ladn.opening_balance_changes ═════════════════
async function snapshot(client, childId, S) {
  const { rows: [ob] } = await client.query(`SELECT * FROM ${S}.opening_balances WHERE child_id = $1`, [childId]);
  const invoice = ob && ob.invoice_id
    ? (await client.query(`SELECT * FROM ${S}.invoices WHERE id = $1`, [ob.invoice_id])).rows[0] || null
    : null;
  const invoiceAllocations = invoice
    ? (await client.query(`SELECT * FROM ${S}.payment_allocations WHERE invoice_id = $1 ORDER BY id`, [invoice.id])).rows
    : [];
  const invoiceDirectPayments = invoice
    ? (await client.query(`SELECT * FROM ${S}.payments WHERE invoice_id = $1`, [invoice.id])).rows
    : [];
  const payment = ob && ob.payment_id
    ? (await client.query(`SELECT * FROM ${S}.payments WHERE id = $1`, [ob.payment_id])).rows[0] || null
    : null;
  const paymentAllocations = payment
    ? (await client.query(`SELECT * FROM ${S}.payment_allocations WHERE payment_id = $1 ORDER BY id`, [payment.id])).rows
    : [];
  return { opening_balance: ob || null, invoice, invoice_allocations: invoiceAllocations,
    invoice_direct_payments: invoiceDirectPayments, payment, payment_allocations: paymentAllocations };
}

// ══ SHARED MECHANICS ═════════════════════════════════════════════════════════════════

/** Settle status to match what is actually still owed — the same rule write-off/reverse use. */
async function settleInvoiceStatus(client, invoiceId, S) {
  const { rows: [row] } = await client.query(
    `SELECT i.status, i.due_on, ${outstandingSql('i', S)} AS owed FROM ${S}.invoices i WHERE i.id = $1`, [invoiceId]);
  if (!row) return;
  const owed = pence(row.owed);
  if (owed <= 0 && ['sent', 'overdue'].includes(row.status)) {
    await client.query(
      `UPDATE ${S}.invoices SET status = 'paid', paid_on = COALESCE(paid_on, CURRENT_DATE), updated_at = now() WHERE id = $1`,
      [invoiceId]);
  } else if (owed > 0 && row.status === 'paid') {
    const overdue = row.due_on && new Date(row.due_on) < new Date();
    await client.query(
      `UPDATE ${S}.invoices SET status = $2, paid_on = NULL, updated_at = now() WHERE id = $1`,
      [invoiceId, overdue ? 'overdue' : 'sent']);
  }
}

/** The family's next open invoice with room left on it, oldest first, excluding one. */
async function nextOpenInvoiceWithRoom(client, childIds, excludeInvoiceId, S) {
  const { rows } = await client.query(`
    SELECT i.id, ${outstandingSql('i', S)} AS owed FROM ${S}.invoices i
     WHERE i.child_id = ANY($1::int[]) AND i.status IN ('sent', 'overdue') AND i.id <> $2
     ORDER BY COALESCE(i.issued_on, i.created_at::date), i.id`, [childIds, excludeInvoiceId]);
  return rows.find(r => pence(r.owed) > 0) || null;
}

/**
 * Free `amountToFree` pence off an invoice — but ONLY by touching SAFE_OWN_SOURCES money
 * that belongs to THIS SAME CHILD (see the header comment above `SAFE_OWN_SOURCES`).
 * Everything else sitting on the bill is left completely untouched; if there isn't
 * enough safe money to cover `amountToFree`, the WHOLE edit refuses (code 'locked_funds',
 * nothing mutated yet) rather than shrink or rewrite someone's real payment. This is the
 * b423c stop-gap (fixes reviewer defects 1–4 against b423b).
 *
 * Each pound freed looks for the family's next open bill to settle instead. Anything
 * still left over (no open bill to take it) is simply left as freed-up room on the
 * payment it came from — never a rewritten payment row, never a manufactured one.
 * applyUnallocatedCredit() already treats 'opening-balance'/'credit-note-excess' sourced
 * payments as usable in part (amount_pence minus its OWN allocations), so once we delete
 * or shrink the allocation that was pinning money to THIS invoice, that money is already
 * visible again next time it runs — no replacement row needed.
 *
 * First normalises: a safe payment linked by payments.invoice_id with no allocation row
 * is turned into an explicit allocation (then invoice_id cleared), so "money on this
 * invoice" is one shape — payment_allocations — and can be reduced newest-first.
 */
async function freeFromInvoice(client, { invoiceId, amountToFree, childIds, S, childId }) {
  if (amountToFree <= 0) return;

  const { rows: directPays } = await client.query(`
    SELECT p.id, p.child_id, p.amount_pence, p.paid_on, p.source, p.payment_method, p.cash_reference FROM ${S}.payments p
     WHERE p.invoice_id = $1 AND p.status = 'succeeded'
       AND NOT EXISTS (SELECT 1 FROM ${S}.payment_allocations a WHERE a.payment_id = p.id)
     ORDER BY p.id`, [invoiceId]);
  const { rows: existingAllocs } = await client.query(`
    SELECT a.id, a.payment_id, a.amount_pence, p.child_id, p.source, p.paid_on, p.payment_method
      FROM ${S}.payment_allocations a JOIN ${S}.payments p ON p.id = a.payment_id
     WHERE a.invoice_id = $1 ORDER BY a.id DESC`, [invoiceId]);

  const isSafe = (row) => Number(row.child_id) === Number(childId) && SAFE_OWN_SOURCES.has(row.source);
  const unsafeRows = [...directPays, ...existingAllocs].filter(r => !isSafe(r));
  const safeTotal = [...directPays, ...existingAllocs].filter(isSafe).reduce((s, r) => s + pence(r.amount_pence), 0);

  if (safeTotal < amountToFree) {
    const shortfall = amountToFree - safeTotal;
    const example = unsafeRows.slice().sort((a, b) => pence(b.amount_pence) - pence(a.amount_pence))[0];
    const who = example
      ? (Number(example.child_id) === Number(childId) ? (modeOf(example.payment_method) || 'a payment') : 'another child’s payment')
      : null;
    const when = example && example.paid_on ? ' ' + shortDate(example.paid_on) : '';
    throw Object.assign(new Error(
      `This EyLog balance has ${gbp(shortfall)} of real payments on it${who ? ` (${who}${when})` : ''}. ` +
      `Undo or move that payment in Reconcile first, then edit the opening balance.`
    ), { code: 'locked_funds' });
  }

  // Safe to proceed — from here on, only ever touch the SAFE rows found above.
  for (const p of directPays.filter(isSafe)) {
    const per = await AP.periodOfInvoiceId(client, invoiceId);
    await client.query(`
      INSERT INTO ${S}.payment_allocations
        (payment_id, invoice_id, child_id, amount_pence, allocated_on, source, reference, period_year, period_month, period_source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.id, invoiceId, p.child_id, p.amount_pence, p.paid_on, p.source, p.cash_reference, per.year, per.month, per.source]);
    await client.query(`UPDATE ${S}.payments SET invoice_id = NULL, updated_at = now() WHERE id = $1`, [p.id]);
  }

  const { rows: allocs } = await client.query(
    `SELECT a.id, a.payment_id, a.amount_pence FROM ${S}.payment_allocations a JOIN ${S}.payments p ON p.id = a.payment_id
      WHERE a.invoice_id = $1 AND p.child_id = $2 AND p.source = ANY($3::text[]) ORDER BY a.id DESC`,
    [invoiceId, childId, [...SAFE_OWN_SOURCES]]);
  let remaining = amountToFree;
  for (const a of allocs) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, pence(a.amount_pence));
    const newAmt = pence(a.amount_pence) - take;
    if (newAmt > 0) {
      await client.query(`UPDATE ${S}.payment_allocations SET amount_pence = $2 WHERE id = $1`, [a.id, newAmt]);
    } else {
      await client.query(`DELETE FROM ${S}.payment_allocations WHERE id = $1`, [a.id]);
      // outstandingSql() falls back to payments.invoice_id only when a payment has NO
      // allocation row at all — leaving it set here would make it silently re-count
      // against the very invoice this allocation just freed.
      await client.query(`UPDATE ${S}.payments SET invoice_id = NULL, updated_at = now() WHERE id = $1 AND invoice_id = $2`,
        [a.payment_id, invoiceId]);
    }
    remaining -= take;

    let toPlace = take;
    while (toPlace > 0) {
      const target = await nextOpenInvoiceWithRoom(client, childIds, invoiceId, S);
      if (!target) break;
      const per = await AP.periodOfInvoiceId(client, target.id);
      const placeAmt = Math.min(toPlace, pence(target.owed));
      await client.query(`
        INSERT INTO ${S}.payment_allocations
          (payment_id, invoice_id, child_id, amount_pence, allocated_on, source, reference, period_year, period_month, period_source)
        VALUES ($1,$2,(SELECT child_id FROM ${S}.invoices WHERE id = $2),$3,CURRENT_DATE,'opening-balance-adjustment',
                'Reallocated after an opening balance correction',$4,$5,$6)`,
        [a.payment_id, target.id, placeAmt, per.year, per.month, per.source]);
      await settleInvoiceStatus(client, target.id, S);
      toPlace -= placeAmt;
    }
    // Any pence still left over (no open bill anywhere to take it) needs no further
    // action: we have already deleted/shrunk the allocation that was pinning it to THIS
    // invoice, so applyUnallocatedCredit() already sees it as available again next time
    // it runs — never an existing payment rewritten, never a replacement row invented.
  }
  await settleInvoiceStatus(client, invoiceId, S);
}

/** Shrink the credit note(s) against `invoiceId` by `amountToFree` pence (newest first),
 * moving the freed value into a fresh unallocated credit (source 'credit-note-excess',
 * same shape createCreditNote's own excess uses) so it is still there for the next bill —
 * never just erased by capping the bill's own outstanding at zero. */
async function freeCreditNoteExcess(client, { invoiceId, amountToFree, childIds, S }) {
  if (amountToFree <= 0) return;
  const { rows: cns } = await client.query(
    `SELECT id, amount_pence, child_id FROM ${S}.invoices
      WHERE credit_note_for_id = $1 AND status = 'credit_note' ORDER BY id DESC`, [invoiceId]);
  let remaining = amountToFree, freed = 0, childId = null;
  for (const cn of cns) {
    if (remaining <= 0) break;
    const magnitude = pence(-cn.amount_pence);
    const take = Math.min(remaining, magnitude);
    if (take <= 0) continue;
    await client.query(`UPDATE ${S}.invoices SET amount_pence = amount_pence + $2, updated_at = now() WHERE id = $1`, [cn.id, take]);
    remaining -= take; freed += take; childId = cn.child_id;
  }
  if (freed > 0) {
    await client.query(`
      INSERT INTO ${S}.payments (child_id, amount_pence, currency, payment_method, status, description, paid_on, source, created_at, updated_at)
      VALUES ($1,$2,'GBP','credit','succeeded','Credit note excess after an opening balance correction',CURRENT_DATE,'credit-note-excess',now(),now())`,
      [childId, freed]);
    await growPaymentCredit(client, { childIds, S });
  }
}

/** A credit note against `invoiceId` is real money/discount already given to the family.
 * family-ledger.js excludes a credit note once its target bill is written_off (the
 * "counts once" rule, so a write-off never double-cancels money a credit note already
 * took off) — so when the bill itself is retired, the credit note's value must be moved
 * onto a live row or the family silently loses it. The original credit note row is left
 * exactly as it was (the historical record of what was credited and when); only its
 * value is carried forward, onto a fresh unallocated credit. */
async function moveCreditNotesOffRetiredInvoice(client, { invoiceId, childIds, S }) {
  const { rows: [inv] } = await client.query(`SELECT child_id FROM ${S}.invoices WHERE id = $1`, [invoiceId]);
  const { rows: [cn] } = await client.query(
    `SELECT COALESCE(SUM(-amount_pence), 0)::bigint AS v FROM ${S}.invoices WHERE credit_note_for_id = $1 AND status = 'credit_note'`,
    [invoiceId]);
  const value = pence(cn.v);
  if (value <= 0) return;
  await client.query(`
    INSERT INTO ${S}.payments (child_id, amount_pence, currency, payment_method, status, description, paid_on, source, created_at, updated_at)
    VALUES ($1,$2,'GBP','credit','succeeded','Credit note kept after its bill was retired',CURRENT_DATE,'credit-note-excess',now(),now())`,
    [inv.child_id, value]);
  await growPaymentCredit(client, { childIds, S });
}

/** Reduce a payment's allocations to at most `ceilingPence` — newest first — and settle
 * every invoice that loses cover. Ceiling 0 frees everything (used to retire a payment). */
async function shrinkPaymentAllocations(client, { paymentId, ceilingPence, S }) {
  const { rows: allocs } = await client.query(
    `SELECT id, invoice_id, amount_pence FROM ${S}.payment_allocations WHERE payment_id = $1 ORDER BY id DESC`, [paymentId]);
  const total = allocs.reduce((s, a) => s + pence(a.amount_pence), 0);
  let excess = total - ceilingPence;
  const touched = new Set();
  for (const a of allocs) {
    if (excess <= 0) break;
    const take = Math.min(excess, pence(a.amount_pence));
    const newAmt = pence(a.amount_pence) - take;
    if (newAmt > 0) {
      await client.query(`UPDATE ${S}.payment_allocations SET amount_pence = $2 WHERE id = $1`, [a.id, newAmt]);
    } else {
      await client.query(`DELETE FROM ${S}.payment_allocations WHERE id = $1`, [a.id]);
      await client.query(`UPDATE ${S}.payments SET invoice_id = NULL, updated_at = now() WHERE id = $1 AND invoice_id = $2`,
        [paymentId, a.invoice_id]);
    }
    if (a.invoice_id) touched.add(a.invoice_id);
    excess -= take;
  }
  for (const invId of touched) await settleInvoiceStatus(client, invId, S);
}

/** Apply a credit payment's remaining pence onto the family's open bills, oldest first —
 * exactly the loop set-opening-balances.sql ran once at the cutover. */
async function growPaymentCredit(client, { childIds, S }) {
  for (let i = 0; i < 50; i++) {
    const { rows: [inv] } = await client.query(`
      SELECT i.id FROM ${S}.invoices i
       WHERE i.child_id = ANY($1::int[]) AND i.status IN ('sent', 'overdue') AND i.amount_pence > 0
       ORDER BY COALESCE(i.issued_on, i.created_at::date), i.id LIMIT 1`, [childIds]);
    if (!inv) break;
    const { applied } = await applyUnallocatedCredit(client, inv.id, S);
    if (!applied) break;
  }
}

// ══ CREATE / RETIRE THE OPENING-BALANCE ROWS — same shape as the 2026-10-06 cutover ═════

async function nextBfInvoiceNumber(client, childId, S) {
  const { rows: [r] } = await client.query(
    `SELECT count(*)::int AS n FROM ${S}.invoices WHERE child_id = $1 AND invoice_number LIKE 'BF-' || $1 || '%'`, [childId]);
  return r.n > 0 ? `BF-${childId}-${r.n + 1}` : `BF-${childId}`;
}

async function createBfInvoice(client, { childId, amountPence, asOf, reason, S }) {
  const { rows: [child] } = await client.query(`SELECT primary_contact_email FROM ${S}.children WHERE id = $1`, [childId]);
  const { rows: [fam] } = await client.query(
    `SELECT family_payment_ref FROM ${S}.invoices WHERE child_id = $1 AND family_payment_ref IS NOT NULL ORDER BY id DESC LIMIT 1`, [childId]);
  const invoiceNumber = await nextBfInvoiceNumber(client, childId, S);
  const { rows: [ins] } = await client.query(`
    INSERT INTO ${S}.invoices
      (child_id, bill_payer_email, amount_pence, gross_amount_pence, status, issued_on, due_on,
       invoice_number, period_label, line_items, source, notes, family_payment_ref, created_at, updated_at)
    VALUES ($1,$2,$3::int,$3::int,'sent',($4::date - 1),($4::date - 1),$5,'Balance brought forward from EyLog',
      jsonb_build_array(jsonb_build_object('label','Balance brought forward from EyLog on ' || to_char($4::date - 1, 'FMDD Mon YYYY'),
        'category','opening_balance','quantity',1,'unit_pence',$3::int,'amount_pence',$3::int,
        'is_funded',false,'unit_label','','note','What was owed when Wren took over the account')),
      'opening-balance',$6,$7,now(),now())
    RETURNING id`,
    [childId, child ? child.primary_contact_email : null, amountPence, asOf, invoiceNumber,
     `Opening balance set by the office on ${new Date().toISOString().slice(0, 10)}${reason ? ' — ' + reason : ''}`,
     fam ? fam.family_payment_ref : null]);
  return ins.id;
}

async function createCreditPayment(client, { childId, amountPence, asOf, reason, S }) {
  const { rows: [child] } = await client.query(`SELECT primary_contact_email FROM ${S}.children WHERE id = $1`, [childId]);
  const { rows: [ins] } = await client.query(`
    INSERT INTO ${S}.payments
      (child_id, bill_payer_email, amount_pence, currency, payment_method, status, description, paid_on, source, manual_notes, created_at, updated_at)
    VALUES ($1,$2,$3,'GBP','credit','succeeded','Credit brought forward from EyLog',($4::date - 1),'opening-balance',$5,now(),now())
    RETURNING id`,
    [childId, child ? child.primary_contact_email : null, amountPence, asOf,
     `Opening balance set by the office on ${new Date().toISOString().slice(0, 10)}${reason ? ' — ' + reason : ''}`]);
  return ins.id;
}

/** Retire a BF invoice: free whatever real money is still applied against it, write it
 * off, then move any credit note's value somewhere it stays live (see
 * moveCreditNotesOffRetiredInvoice). Never deleted — written_off is the one "this no
 * longer counts" status the invoices check constraint actually has (there is no
 * 'cancelled'/'void'). */
async function retireInvoice(client, { invoiceId, childIds, S, childId }) {
  // Real money only — NOT outstandingSql, which also nets off credit notes; that value
  // isn't "settled" money to free from allocations, it's handled separately below.
  const { rows: [row] } = await client.query(`
    SELECT COALESCE((SELECT SUM(a.amount_pence) FROM ${S}.payment_allocations a WHERE a.invoice_id = i.id), 0)
         + COALESCE((SELECT SUM(p.amount_pence) FROM ${S}.payments p WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0) AS settled
      FROM ${S}.invoices i WHERE i.id = $1`, [invoiceId]);
  const settled = pence(row.settled);
  if (settled > 0) await freeFromInvoice(client, { invoiceId, amountToFree: settled, childIds, S, childId });
  await client.query(
    `UPDATE ${S}.invoices SET status = 'written_off',
       notes = COALESCE(notes, '') || ' — retired ' || CURRENT_DATE || ': opening balance corrected', updated_at = now()
     WHERE id = $1`, [invoiceId]);
  await moveCreditNotesOffRetiredInvoice(client, { invoiceId, childIds, S });
}

/** Retire a "Credit brought forward" payment: reversed, never deleted — any bill it had
 * settled goes back to unpaid, same as the existing manual-payment /reverse route. */
async function retirePayment(client, { paymentId, S }) {
  await shrinkPaymentAllocations(client, { paymentId, ceilingPence: 0, S });
  await client.query(`UPDATE ${S}.payments SET status = 'reversed', updated_at = now() WHERE id = $1`, [paymentId]);
}

// ══ THE THREE TRANSITIONS ════════════════════════════════════════════════════════════

async function owedToOwed(client, { ob, newPence, reason, S, childIds }) {
  const invoiceId = ob.invoice_id;
  const oldPence = pence(ob.balance_pence);
  await client.query(`
    UPDATE ${S}.invoices SET amount_pence = $2::int, gross_amount_pence = $2::int,
      line_items = jsonb_build_array(jsonb_build_object(
        'label', line_items->0->>'label', 'category','opening_balance','quantity',1,
        'unit_pence',$2::int,'amount_pence',$2::int,'is_funded',false,'unit_label','',
        'note', line_items->0->>'note')),
      notes = COALESCE(notes, '') || ' — amount corrected to £' || to_char($2::numeric / 100, 'FM999999990.00')
               || ' on ' || CURRENT_DATE || COALESCE(' (' || $3 || ')', ''),
      updated_at = now()
    WHERE id = $1`, [invoiceId, newPence, reason || null]);

  if (newPence > oldPence) {
    // b423c (defect 5) — the bill just grew. Reopen it at the new, bigger amount FIRST
    // (growPaymentCredit only ever looks at invoices already 'sent'/'overdue'), then let
    // any of the family's idle credit — freed by an earlier edit, or just sitting
    // unapplied — flow onto it, oldest-open-bill-first, same as any other invoice.
    // Without this, "lower to £400 then back to £1,000" leaves the BF short while the
    // family's true balance is already square again.
    await settleInvoiceStatus(client, invoiceId, S);
    await growPaymentCredit(client, { childIds, S });
    return { invoice_id: invoiceId, payment_id: null };
  }

  // How much is overpaid against the NEW amount — real money (allocations/direct
  // payments) and credit notes separately, because they're freed two different ways.
  const { rows: [row] } = await client.query(`
    SELECT COALESCE((SELECT SUM(-cn.amount_pence) FROM ${S}.invoices cn
                      WHERE cn.credit_note_for_id = $1 AND cn.status = 'credit_note'), 0)::bigint AS credit_notes,
           COALESCE((SELECT SUM(a.amount_pence) FROM ${S}.payment_allocations a WHERE a.invoice_id = $1), 0)::bigint
             + COALESCE((SELECT SUM(p.amount_pence) FROM ${S}.payments p WHERE p.invoice_id = $1 AND p.status = 'succeeded'), 0)::bigint AS settled
  `, [invoiceId]);
  const creditNotes = pence(row.credit_notes), settled = pence(row.settled);
  const overpayment = Math.max(0, creditNotes + settled - newPence);
  // Free real money first — it's the one that's actually movable to another bill.
  const freeFromSettled = Math.min(overpayment, settled);
  if (freeFromSettled > 0) await freeFromInvoice(client, { invoiceId, amountToFree: freeFromSettled, childIds, S, childId: ob.child_id });
  // Only once real money can't cover it does the credit note itself have to shrink —
  // never leave the bill negative just because a credit note is bigger than it now is.
  const stillOver = overpayment - freeFromSettled;
  if (stillOver > 0) await freeCreditNoteExcess(client, { invoiceId, amountToFree: stillOver, childIds, S });

  await settleInvoiceStatus(client, invoiceId, S);
  return { invoice_id: invoiceId, payment_id: null };
}

async function creditToCredit(client, { ob, newPence, reason, S, childIds }) {
  const paymentId = ob.payment_id;
  const newAmt = -newPence; // payments.amount_pence is stored positive; a credit's pence is negative
  await client.query(`
    UPDATE ${S}.payments SET amount_pence = $2::int,
      manual_notes = COALESCE(manual_notes, '') || ' — amount corrected to £' || to_char($2::numeric / 100, 'FM999999990.00')
               || ' on ' || CURRENT_DATE || COALESCE(' (' || $3 || ')', ''),
      updated_at = now()
    WHERE id = $1`, [paymentId, newAmt, reason || null]);
  const { rows: [sum] } = await client.query(
    `SELECT COALESCE(SUM(amount_pence), 0)::bigint AS allocated FROM ${S}.payment_allocations WHERE payment_id = $1`, [paymentId]);
  const allocated = pence(sum.allocated);
  if (allocated > newAmt) {
    await shrinkPaymentAllocations(client, { paymentId, ceilingPence: newAmt, S });
  } else if (newAmt > allocated) {
    await growPaymentCredit(client, { childIds, S });
  }
  return { invoice_id: null, payment_id: paymentId };
}

async function retireAndRecreate(client, { ob, childId, oldSign, newSign, newPence, asOf, reason, S, childIds }) {
  if (oldSign === 1) await retireInvoice(client, { invoiceId: ob.invoice_id, childIds, S, childId });
  else if (oldSign === -1) await retirePayment(client, { paymentId: ob.payment_id, S });

  let invoiceId = null, paymentId = null;
  if (newSign === 1) {
    invoiceId = await createBfInvoice(client, { childId, amountPence: newPence, asOf, reason, S });
    // b423c (defect 5) — "turns credit into owed" (or a fresh Add): any idle family
    // credit should flow onto the new bill too, same as owedToOwed's raise branch.
    await growPaymentCredit(client, { childIds, S });
  } else if (newSign === -1) {
    paymentId = await createCreditPayment(client, { childId, amountPence: -newPence, asOf, reason, S });
    await growPaymentCredit(client, { childIds, S });
  }
  return { invoice_id: invoiceId, payment_id: paymentId };
}

/** A row that would turn into invisible history the moment an opening balance is first
 * added (family-ledger.js's pre_wren rule: EyLog-sourced OR created before as_of) but
 * that is NOT itself EyLog's — a genuine Wren bill/payment that would silently vanish
 * from the family balance. EyLog-sourced rows are excluded here: becoming history is
 * exactly what they're supposed to do. */
async function preAsOfWrenRows(client, childId, asOf, S) {
  const { rows: [r] } = await client.query(`
    SELECT
      (SELECT count(*) FROM ${S}.invoices
         WHERE child_id = $1 AND status NOT IN ('draft', 'written_off')
           AND COALESCE(source, '') NOT IN ('eylog-import-b205', 'opening-balance')
           AND eylog_ref IS NULL AND created_at < $2)::int AS invoices,
      (SELECT count(*) FROM ${S}.payments
         WHERE child_id = $1 AND status = 'succeeded'
           AND COALESCE(source, '') NOT IN ('eylog-import-b205', 'opening-balance')
           AND eylog_payment_no IS NULL AND created_at < $2)::int AS payments
  `, [childId, asOf]);
  return { invoices: Number(r.invoices) || 0, payments: Number(r.payments) || 0 };
}

// ══ ENTRY POINT ══════════════════════════════════════════════════════════════════════

/**
 * Set (or add) a child's EyLog opening balance to `newPence` (+ = owed, - = in credit, 0 = none).
 * One transaction; every row touched is snapshotted before and after into
 * ladn.opening_balance_changes. See the file header for why this never loses money.
 *
 * `preview: true` runs the exact same code and then rolls back instead of committing,
 * returning the family's real ledger balance before and after — nothing is saved, and
 * no history/audit row is written. `override: true` is required to add a FIRST opening
 * balance for a child who has genuine Wren-era bills/payments before the cutover date
 * (see preAsOfWrenRows) — without it the call refuses rather than silently hiding them.
 *
 * @returns {Promise<{old_pence:number, new_pence:number, invoice_id:number|null, payment_id:number|null,
 *   no_op?:boolean, preview?:boolean, before_family_balance_pence?:number, after_family_balance_pence?:number}>}
 */
async function setOpeningBalance(db, childId, newPenceIn, { reason, req, schema = 'ladn', preview = false, override = false } = {}) {
  const S = sch(schema);
  const id = parseInt(childId, 10);
  if (!Number.isInteger(id)) throw Object.assign(new Error('child_id required'), { code: 'bad_request' });
  const newPence = pence(newPenceIn);
  const by = (req && req.user && (req.user.name || req.user.email)) || null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [child] } = await client.query(`SELECT id FROM ${S}.children WHERE id = $1 FOR UPDATE`, [id]);
    if (!child) throw Object.assign(new Error('Child not found'), { code: 'not_found' });
    const { rows: [ob] } = await client.query(`SELECT * FROM ${S}.opening_balances WHERE child_id = $1 FOR UPDATE`, [id]);

    const oldPence = ob ? pence(ob.balance_pence) : 0;
    const asOf = ob ? ob.as_of : CUTOVER_AS_OF;
    const childIds = await familyChildIds(client, id, S);

    // A no-op (same figure, or a fractional difference that rounds away) never touches
    // anything — no history row, no audit row, no note appended.
    if (newPence === oldPence) {
      let before, after;
      if (preview) { before = after = await familyBalancePence(client, childIds, S); }
      await client.query('ROLLBACK');
      return {
        old_pence: oldPence, new_pence: newPence, invoice_id: ob ? ob.invoice_id : null, payment_id: ob ? ob.payment_id : null,
        no_op: true, ...(preview ? { preview: true, before_family_balance_pence: before, after_family_balance_pence: after } : {}),
      };
    }

    if (!ob && !override) {
      const pre = await preAsOfWrenRows(client, id, asOf, S);
      const total = pre.invoices + pre.payments;
      if (total > 0) {
        await client.query('ROLLBACK');
        throw Object.assign(new Error(
          `This child has ${total} Wren bill${total === 1 ? '' : 's'}/payment${total === 1 ? '' : 's'} ` +
          `dated before 26 Sep 2026 (${pre.invoices} invoice(s), ${pre.payments} payment(s)) that would drop out of ` +
          `the family balance once an opening balance is added. Tick "I understand" to proceed anyway.`
        ), { code: 'needs_override', can_override: true, pre });
      }
    }

    const beforeBalance = await familyBalancePence(client, childIds, S);
    const rowsBefore = await snapshot(client, id, S);

    const oldSign = sign(oldPence), newSign = sign(newPence);
    let result;
    if (oldSign === 1 && newSign === 1) {
      result = await owedToOwed(client, { ob, newPence, reason, S, childIds });
    } else if (oldSign === -1 && newSign === -1) {
      result = await creditToCredit(client, { ob, newPence, reason, S, childIds });
    } else {
      result = await retireAndRecreate(client, { ob, childId: id, oldSign, newSign, newPence, asOf, reason, S, childIds });
    }

    const noteLine = `[${new Date().toISOString().slice(0, 10)}] ${pence(oldPence) / 100} → ${newPence / 100}` +
      (reason ? `: ${reason}` : '');
    // created_by is the ORIGINAL creator of the row (set once, on insert, never on edit);
    // updated_by tracks whoever most recently corrected it.
    await client.query(`
      INSERT INTO ${S}.opening_balances (child_id, as_of, balance_pence, source, invoice_id, payment_id, note, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (child_id) DO UPDATE SET
        balance_pence = $3, invoice_id = $5, payment_id = $6,
        note = COALESCE(${S}.opening_balances.note, '') || E'\\n' || $7,
        updated_by = $8, updated_at = now()`,
      [id, asOf, newPence, ob ? ob.source : 'manual', result.invoice_id, result.payment_id, noteLine, by]);

    const rowsAfter = await snapshot(client, id, S);
    await client.query(`
      INSERT INTO ${S}.opening_balance_changes (child_id, old_pence, new_pence, reason, changed_by, rows_before, rows_after)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, oldPence, newPence, reason || null, by, JSON.stringify(rowsBefore), JSON.stringify(rowsAfter)]);

    if (preview) {
      const afterBalance = await familyBalancePence(client, childIds, S);
      await client.query('ROLLBACK');
      return {
        old_pence: oldPence, new_pence: newPence, invoice_id: result.invoice_id, payment_id: result.payment_id,
        preview: true, before_family_balance_pence: beforeBalance, after_family_balance_pence: afterBalance,
      };
    }

    await client.query('COMMIT');
    return { old_pence: oldPence, new_pence: newPence, invoice_id: result.invoice_id, payment_id: result.payment_id };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function getOpeningBalance(db, childId, { schema = 'ladn' } = {}) {
  const S = sch(schema);
  const id = parseInt(childId, 10);
  const { rows: [ob] } = await db.query(`SELECT * FROM ${S}.opening_balances WHERE child_id = $1`, [id]);
  const { rows: history } = await db.query(
    `SELECT id, old_pence, new_pence, reason, changed_by, changed_at
       FROM ${S}.opening_balance_changes WHERE child_id = $1 ORDER BY changed_at DESC`, [id]);
  return { opening_balance: ob || null, history };
}

module.exports = { setOpeningBalance, getOpeningBalance, CUTOVER_AS_OF };
