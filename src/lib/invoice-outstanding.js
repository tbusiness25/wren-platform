'use strict';
// 2026-10-06 — ONE answer to "how much is still owed on this invoice?"
//
// Two payment models live side by side: payment_allocations rows (EyLog import, card,
// b397 manual payments) and payments.invoice_id with no allocation (bank Reconcile,
// deposits taken onto the account). The card page and Direct Debit only counted the
// first, so a transfer confirmed in Reconcile, or a deposit, did not reduce what they
// would charge. Here a payment counts through its allocations if it has any, and
// through payments.invoice_id if it has none — never both.
//
// And a family that is in credit (a deposit paid before the first invoice) must not be
// charged the whole invoice: applyUnallocatedCredit() puts that money onto the bill,
// oldest credit first, the same way Reconcile would, so the invoice, the statement, the
// card page and Direct Debit all agree.

const sch = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s || '')) throw new Error('bad schema'); return s; };

/** SQL expression: what is still owed on invoice alias `i` (negative = overpaid). */
function outstandingSql(i = 'i', schema = 'ladn') {
  const S = sch(schema);
  return `(${i}.amount_pence
    + COALESCE((SELECT SUM(cn.amount_pence) FROM ${S}.invoices cn
                 WHERE cn.credit_note_for_id = ${i}.id AND cn.status = 'credit_note'), 0)
    - COALESCE((SELECT SUM(a.amount_pence) FROM ${S}.payment_allocations a WHERE a.invoice_id = ${i}.id), 0)
    - COALESCE((SELECT SUM(p.amount_pence) FROM ${S}.payments p
                 WHERE p.invoice_id = ${i}.id AND p.status = 'succeeded'
                   AND NOT EXISTS (SELECT 1 FROM ${S}.payment_allocations a2 WHERE a2.payment_id = p.id)), 0))`;
}

/** The children who share this child's billing family (by billing email), always including the child. */
async function familyChildIds(db, childId, schema = 'ladn') {
  const S = sch(schema);
  const { rows } = await db.query(`
    SELECT o.id FROM ${S}.children c
      JOIN ${S}.children o ON o.id = c.id
        OR (NULLIF(lower(btrim(c.primary_contact_email)), '') IS NOT NULL
            AND lower(btrim(o.primary_contact_email)) = lower(btrim(c.primary_contact_email)))
     WHERE c.id = $1`, [childId]);
  return rows.length ? rows.map(r => Number(r.id)) : [Number(childId)];
}

/**
 * Put the family's unallocated money (payments with no invoice and no allocation —
 * deposits taken onto the account, "on account" payments) onto this invoice, oldest
 * first, while each one fits in what is still owed. A credit bigger than the bill is
 * left as credit for the next one. Marks the invoice paid if that settles it.
 * @returns {Promise<{applied:number, pence:number}>}
 */
async function applyUnallocatedCredit(db, invoiceId, schema = 'ladn') {
  const S = sch(schema);
  const { rows: [inv] } = await db.query(
    `SELECT i.id, i.child_id, i.status, ${outstandingSql('i', S)} AS owed FROM ${S}.invoices i WHERE i.id = $1`, [invoiceId]);
  if (!inv || !['sent', 'overdue'].includes(inv.status)) return { applied: 0, pence: 0 };
  let owed = Number(inv.owed) || 0;
  if (owed <= 0) return { applied: 0, pence: 0 };
  const ids = await familyChildIds(db, inv.child_id, S);
  // 2026-10-06: never EyLog's own payments — their effect is already inside the EyLog
  // closing balance (an opening balance), and the legacy import left hundreds unallocated.
  // A "Credit brought forward" (source 'opening-balance') is applied in PART through
  // payment_allocations, because EyLog credit is rarely the size of one bill.
  const { rows: credits } = await db.query(`
    SELECT p.id, p.child_id, p.source, p.amount_pence,
           p.amount_pence - COALESCE((SELECT SUM(a.amount_pence) FROM ${S}.payment_allocations a
                                       WHERE a.payment_id = p.id), 0) AS remaining
      FROM ${S}.payments p
     WHERE p.child_id = ANY($1::int[]) AND p.status = 'succeeded' AND p.amount_pence > 0
       AND p.invoice_id IS NULL
       AND COALESCE(p.source, '') <> 'eylog-import-b205' AND p.eylog_payment_no IS NULL
       AND (p.source IN ('opening-balance', 'credit-note-excess')
            OR NOT EXISTS (SELECT 1 FROM ${S}.payment_allocations a WHERE a.payment_id = p.id))
     ORDER BY COALESCE(p.paid_on, p.created_at::date), p.id`, [ids]);
  let applied = 0, pence = 0;
  for (const c of credits) {
    if (owed <= 0) break;
    // 2026-10-09: a credit note bigger than its bill leaves the rest on account as a
    // 'credit-note-excess' credit (see createCreditNote) — used in part, like EyLog credit.
    if (c.source === 'opening-balance' || c.source === 'credit-note-excess') {
      const part = Math.min(Number(c.remaining) || 0, owed);
      if (part <= 0) continue;
      const ob = c.source === 'opening-balance';
      await db.query(
        `INSERT INTO ${S}.payment_allocations (payment_id, invoice_id, child_id, amount_pence, allocated_on, source, reference)
         VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6)`,
        [c.id, invoiceId, inv.child_id, part, ob ? 'opening-balance-credit' : 'credit-note-excess',
         ob ? 'Credit brought forward from EyLog' : 'Credit on account from a credit note']);
      applied++; pence += part; owed -= part;
      continue;
    }
    const amt = Number(c.amount_pence);
    if (amt > owed) continue;
    const r = await db.query(
      `UPDATE ${S}.payments SET invoice_id = $2, updated_at = NOW() WHERE id = $1 AND invoice_id IS NULL`, [c.id, invoiceId]);
    if (r.rowCount) { applied++; pence += amt; owed -= amt; }
  }
  if (applied && owed <= 0) {
    await db.query(`UPDATE ${S}.invoices SET status = 'paid', paid_on = COALESCE(paid_on, CURRENT_DATE), updated_at = NOW()
                     WHERE id = $1 AND status IN ('sent', 'overdue')`, [invoiceId]);
  }
  return { applied, pence };
}

/** The family's statement balance (positive = owes), the one figure parents see. */
async function familyBalance(db, childId, schema = 'ladn') {
  const ids = await familyChildIds(db, childId, schema);
  const { familyLedger } = require('./family-ledger');
  const l = await familyLedger(db, ids, { schema });
  return Number(l.balance_pence) || 0;
}

/**
 * 2026-10-12 (b492) — the family's open invoices, oldest first then by child, each
 * with what is truly left to pay right now: GREATEST(outstandingSql, 0), the exact
 * figure the Invoices page and the card page already agree on (never
 * payment-matcher.js's planAllocation(), which predates the 2026-10-05/06 credit-note
 * and payment_allocations fixes — see this file's header). A credit note or a part
 * payment already recorded shows up as a smaller outstanding_pence, never a second row.
 * Demo children (is_demo) never contribute to a real family's balance.
 * @returns {Promise<object[]>} only invoices with something still owed on them.
 */
async function familyOpenInvoices(db, childIds, schema = 'ladn') {
  const S = sch(schema);
  const ids = (childIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return [];
  const { rows } = await db.query(`
    SELECT i.id, i.child_id, i.invoice_number, i.reference, i.period_label, i.amount_pence,
           c.first_name AS child_first_name,
           GREATEST(${outstandingSql('i', S)}, 0)::int AS outstanding_pence
      FROM ${S}.invoices i
      JOIN ${S}.children c ON c.id = i.child_id
     WHERE i.child_id = ANY($1::int[]) AND COALESCE(c.is_demo, false) = false
       AND i.credit_note_for_id IS NULL
       AND COALESCE(i.status, '') NOT IN
           ('draft','void','cancelled','written_off','writeoff','credited','credit_note','paid','brought_forward')
     ORDER BY i.issued_on NULLS LAST, i.child_id, i.id`, [ids]);
  return rows.filter(r => Number(r.outstanding_pence) > 0);
}

module.exports = {
  outstandingSql, applyUnallocatedCredit, familyBalance, familyChildIds, familyOpenInvoices,
};
