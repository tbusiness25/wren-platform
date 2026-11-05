'use strict';
// src/lib/invoice-account.js — invpdf-20261028
//
// Toby (28 Oct, before the November run): "when I generate invoices it will clearly show
// their previous balance, what they're then owed or is now in credit … and they can just pay".
//
// It didn't. The statement's "prior balance" summed what was still owed on earlier bills, so
// a family in CREDIT (EyLog credit brought forward, a credit note bigger than its bill) saw
// nothing at all, and "Total due" was this invoice alone — arrears sat on a line above it and
// were never added in. Ten families in credit would have been emailed a bill for the full amount.
//
// This is EyMan's layout, worked from the child's account ledger (family-ledger.js — the same
// balance the parents app and Roost show):
//
//   Account balance before this invoice   everything on the account dated before it (signed:
//                                         owed > 0, credit < 0)
//   Invoice total                         this bill
//   Payments received                     payments dated on/after its issue date, plus its
//                                         own credit notes
//   Total due                             the sum, never below zero; anything below zero is
//                                         "credit left on your account"
//
// It equals the ledger balance by construction. It applies only to the child's LATEST bill
// (the one being sent): an older statement keeps its original totals, because later bills and
// payments belong to later statements. Per child, not per family — invoices are per child.

const { familyLedger } = require('./family-ledger');

function _iso(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/**
 * @returns {Promise<null|{prior_balance_pence:number, payments_pence:number, total_due_pence:number,
 *           credit_remaining_pence:number, payments:object[]}>} null = keep the statement's own totals.
 */
async function accountTotals(db, invIn, { schema = 'ladn' } = {}) {
  if (!invIn || !invIn.id) return null;
  const S = /^[a-z_][a-z0-9_]*$/.test(schema) ? schema : 'ladn';
  // The invoice's OWN row: the statement loaders join the CHILD's eylog_ref over i.eylog_ref.
  const { rows: [inv] } = await db.query(
    `SELECT id, child_id, status, amount_pence, issued_on, credit_note_for_id, eylog_ref, source
       FROM ${S}.invoices WHERE id = $1`, [invIn.id]);
  if (!inv || !inv.child_id) return null;
  if (['draft', 'written_off', 'credit_note', 'brought_forward'].includes(inv.status)) return null;
  if (inv.credit_note_for_id || inv.eylog_ref || /^eylog|opening-balance/.test(String(inv.source || ''))) return null;
  if (!(Number(inv.amount_pence) >= 0)) return null;
  const issued = _iso(inv.issued_on);
  if (!issued) return null;

  // Latest bill only.
  const { rows: [later] } = await db.query(`
    SELECT 1 FROM ${S}.invoices o
     WHERE o.child_id = $1 AND o.id <> $2 AND o.credit_note_for_id IS NULL
       AND COALESCE(o.status,'') NOT IN ('draft','written_off','credit_note')
       AND o.amount_pence > 0
       AND (o.issued_on > $3::date OR (o.issued_on = $3::date AND o.id > $2))
     LIMIT 1`, [inv.child_id, inv.id, issued]);
  if (later) return null;

  const { rows: cnRows } = await db.query(
    `SELECT id FROM ${S}.invoices WHERE credit_note_for_id = $1 AND status = 'credit_note'`, [inv.id]);
  const cnIds = new Set(cnRows.map(r => Number(r.id)));

  const led = await familyLedger(db, [inv.child_id], { schema: S });
  let before = 0, received = 0;
  const payments = [];
  for (const t of led.transactions) {
    const amt = Number(t.amount_pence) || 0;
    if (t.kind === 'invoice' && Number(t.id) === Number(inv.id)) continue;
    const on = _iso(t.on_date);
    if (t.kind === 'invoice' && cnIds.has(Number(t.id))) {
      received += -amt;
      payments.push({ id: t.id, amount_pence: -amt, method: 'Credit note', reference: t.label || '', date: on, status: 'succeeded' });
      continue;
    }
    if (t.kind === 'payment' && !t.opening_balance && on && on >= issued) {
      received += -amt;
      payments.push({ id: t.id, amount_pence: -amt, method: t.mode || t.type || 'Payment',
                      reference: t.reference || t.label || '', date: on, status: 'succeeded' });
      continue;
    }
    before += amt;
  }
  const total = before + Number(inv.amount_pence) - received;
  payments.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return {
    prior_balance_pence: before,
    payments_pence: received,
    total_due_pence: Math.max(0, total),
    credit_remaining_pence: total < 0 ? -total : 0,
    payments,
  };
}

/** Overwrite a built statement's totals with the account view, when it applies. */
async function applyAccountTotals(db, statement, inv, opts) {
  let acc = null;
  try { acc = await accountTotals(db, inv, opts); }
  catch (e) { console.error('[invoice-account]', e.message); }
  if (!acc || !statement || !statement.totals) return statement;
  statement.totals = {
    ...statement.totals,
    prior_balance_pence: acc.prior_balance_pence,
    payments_pence: acc.payments_pence,
    total_due_pence: acc.total_due_pence,
    credit_remaining_pence: acc.credit_remaining_pence,
    settled_without_payment_record: false,
    basis: 'account',
  };
  statement.payments = acc.payments;
  if (acc.total_due_pence === 0) statement.payment_status = acc.credit_remaining_pence > 0 ? 'Paid — in credit' : 'Paid';
  return statement;
}

module.exports = { accountTotals, applyAccountTotals };
