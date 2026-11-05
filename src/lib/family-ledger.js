'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// The family ledger (2026-10-01) — every invoice and payment for a set of children,
// with a running balance, laid out the way EyLog's Transactions/Payments screen is:
// Transaction No. · Date · Type · Mode · Reference · Amount · Balance.
//
// ONE place for the rules. The parent app (/welcome/invoices/api/transactions) and
// Roost's child profile (/api/payments-admin/ledger) both call this, so a parent and
// the office always see the same numbers.
//
// The rules (they decide whether the balance matches EyMan — keep them together):
//   • invoices: everything but drafts and write-offs; EyLog's "payments on account"
//     were imported as negative invoices AND as payments, so negative non-credit-note
//     invoices are left out (counting both doubled every family's credit);
//   • payments: succeeded and non-zero; EyLog's £0 'credit_note' echoes are left out.
//     'used_as_fees' rows are left out EXCEPT a deposit's (is_deposit): EyLog holds a
//     deposit apart from the fee balance, and applying it to fees is the moment it pays
//     a bill. Leaving those out too (before 2026-10-05) showed the twins £950 each and a
//     leaver £804.04 more owed than EyLog — checked against EyMan r76, child by child.
//     Every other used_as_fees row is £0.
// Balance: positive = the family owes, negative = in credit. Payments are negative.
//
// 2026-10-06 — the EyLog cutover is a point in time (Toby: "make sure that was set as a
// point in time and then the balance was whatever it was and that's when Wren started").
// A child with a row in ladn.opening_balances starts from EyLog's own closing balance
// (EyMan r76), held as a real "Balance brought forward" invoice (owed) or "Credit brought
// forward" payment (in credit), source 'opening-balance'. Everything from before that —
// rows imported from EyLog, or created before opening_balances.as_of — is HISTORY: returned
// in `history` so it can still be looked back on, never added to the balance again.
// A child with no opening balance (a family that started in Wren) is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const MODES = [
  [/opayo|stripe|^card/i, 'Card'],
  [/tax\s*free/i, 'Tax Free Childcare'],
  [/voucher/i, 'Childcare vouchers'],
  [/gocardless|direct\s*debit/i, 'Direct Debit'],
  [/bacs|transfer/i, 'Bank transfer'],
  [/salary/i, 'Salary deduction'],
  [/^credit$/i, 'Credit'],
  [/cash/i, 'Cash'],
];
function modeOf(method) {
  const m = String(method || '').trim();
  if (!m) return null;
  for (const [re, label] of MODES) if (re.test(m)) return label;
  return /^(eylog|manual)$/i.test(m) ? 'Other' : m;
}

function schemaName(s) {
  if (!/^[a-z_][a-z0-9_]*$/.test(s || '')) throw new Error('bad schema');
  return s;
}

/**
 * @param {import('pg').Pool} db
 * @param {number[]} childIds  the children whose money this is (a parent's children, or one child)
 * @param {{schema?: string}} [opts]
 * @returns {Promise<{transactions: object[], balance_pence: number, deposit_pence: number}>}
 *          transactions newest first, each with balance_pence after that row.
 */
async function familyLedger(db, childIds, { schema = 'ladn' } = {}) {
  const S = schemaName(schema);
  const ids = (childIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return { transactions: [], balance_pence: 0, deposit_pence: 0 };
  const hasOpening = await openingBalancesExist(db, S);
  // pre_wren: this row is EyLog history for a child whose balance now starts from an opening
  // balance. FALSE for every row of a child with no opening balance.
  const preInv = hasOpening
    ? `(ob.child_id IS NOT NULL AND COALESCE(i.source,'') <> 'opening-balance'
        AND (COALESCE(i.source,'') = 'eylog-import-b205' OR i.eylog_ref IS NOT NULL OR i.created_at < ob.as_of))`
    : 'false';
  const prePay = hasOpening
    ? `(ob.child_id IS NOT NULL AND COALESCE(p.source,'') <> 'opening-balance'
        AND (COALESCE(p.source,'') = 'eylog-import-b205' OR p.eylog_payment_no IS NOT NULL OR p.created_at < ob.as_of))`
    : 'false';
  const obJoinI = hasOpening ? `LEFT JOIN ${S}.opening_balances ob ON ob.child_id = i.child_id` : '';
  const obJoinP = hasOpening ? `LEFT JOIN ${S}.opening_balances ob ON ob.child_id = p.child_id` : '';
  const { rows } = await db.query(`
    SELECT 'invoice' AS kind, i.id, i.child_id, COALESCE(i.issued_on, i.created_at::date) AS on_date,
           COALESCE(i.period_label, i.invoice_number, '#'||i.id) AS label,
           i.invoice_number AS txn_no, i.status, i.amount_pence AS amount_pence,
           NULL::text AS method, i.period_label AS reference,
           COALESCE(i.source,'') AS source, COALESCE(${preInv}, false) AS pre_wren
      FROM ${S}.invoices i ${obJoinI}
     WHERE i.child_id = ANY($1::int[]) AND i.status NOT IN ('draft','written_off')
       AND NOT (i.amount_pence < 0 AND i.status <> 'credit_note' AND COALESCE(i.eylog_invoice_type,'') <> 'Credit Note')
       -- 2026-10-05: a credit note raised against an invoice that was ALSO written off cancels
       -- money the write-off already removed. Counting both credited 3 families twice (£916.67).
       AND NOT (i.status = 'credit_note' AND EXISTS (SELECT 1 FROM ${S}.invoices o
                 WHERE o.id = i.credit_note_for_id AND o.status = 'written_off'))
    UNION ALL
    SELECT 'payment' AS kind, p.id, p.child_id, COALESCE(p.paid_on, p.created_at::date) AS on_date,
           COALESCE(p.description, p.payment_method, 'Payment') AS label,
           COALESCE(p.eylog_payment_no::text, 'W' || p.id) AS txn_no, p.status, -p.amount_pence AS amount_pence,
           p.payment_method AS method,
           NULLIF(btrim(COALESCE(p.cash_reference, '')), '') AS reference,
           COALESCE(p.source,'') AS source, COALESCE(${prePay}, false) AS pre_wren
      FROM ${S}.payments p ${obJoinP}
     WHERE p.child_id = ANY($1::int[]) AND p.status = 'succeeded' AND p.amount_pence <> 0
       AND NOT (COALESCE(p.eylog_txn_kind,'') = 'credit_note'
              OR (COALESCE(p.eylog_txn_kind,'') = 'used_as_fees' AND NOT COALESCE(p.is_deposit,false)))
    ORDER BY on_date ASC, kind ASC, id ASC
  `, [ids]);
  const shape = (r, bal) => {
    const isInvoice = r.kind === 'invoice';
    const opening = r.source === 'opening-balance';
    const type = opening
      ? (isInvoice ? 'Balance brought forward' : 'Credit brought forward')
      : isInvoice
        ? (r.status === 'credit_note' || Number(r.amount_pence) < 0 ? 'Credit note' : 'Invoice')
        : (Number(r.amount_pence) > 0 ? 'Refund' : 'Payment');
    return {
      kind: r.kind, id: r.id, child_id: r.child_id, on_date: r.on_date, label: r.label,
      invoice_number: isInvoice ? r.txn_no : null,
      txn_no: r.txn_no, type, mode: isInvoice || opening ? null : modeOf(r.method),
      reference: r.reference, status: r.status, opening_balance: opening,
      amount_pence: Number(r.amount_pence) || 0, balance_pence: bal,
    };
  };
  let bal = 0, hbal = 0;
  const tx = [], history = [];
  for (const r of rows) {
    if (r.pre_wren) { hbal += Number(r.amount_pence) || 0; history.push(shape(r, hbal)); continue; }
    bal += Number(r.amount_pence) || 0;
    tx.push(shape(r, bal));
  }
  // A deposit held is shown beside the balance, as EyLog does: deposit money in, less any
  // moved onto fees or transferred. Comes from the deposit columns only — never from the ledger.
  // 2026-10-05: plus deposits recorded in Wren itself (ladn.child_deposits, status 'paid' =
  // held) — the Reconcile "Deposit…" button and deposits added by the office. Before this a
  // deposit taken in Wren never showed to the family ("dad says the £388 isn't showing").
  const { rows: [d] } = await db.query(`
    SELECT (COALESCE((SELECT SUM(deposit_pence) FROM ${S}.payments
                       WHERE child_id = ANY($1::int[]) AND is_deposit = true), 0)
          + COALESCE((SELECT SUM(amount_pence) FROM ${S}.child_deposits
                       WHERE child_id = ANY($1::int[]) AND status = 'paid'), 0))::int AS held`, [ids])
    .catch(() => db.query(`SELECT COALESCE(SUM(deposit_pence), 0)::int AS held
                             FROM ${S}.payments WHERE child_id = ANY($1::int[]) AND is_deposit = true`, [ids]));
  tx.reverse();
  history.reverse();
  const opening = hasOpening
    ? (await db.query(`SELECT child_id, as_of, balance_pence::int AS balance_pence, eyman_as_of_month
                         FROM ${S}.opening_balances WHERE child_id = ANY($1::int[]) ORDER BY child_id`, [ids])).rows
    : [];
  return { transactions: tx, balance_pence: bal, deposit_pence: Math.max(0, Number(d && d.held) || 0),
           opening, history };
}

// The table only exists once the 2026-10-06 migration has run; until then every child is
// "started in Wren" and the ledger behaves exactly as before.
const _obCache = new Map();
async function openingBalancesExist(db, S) {
  const hit = _obCache.get(S);
  if (hit && Date.now() - hit.at < 60000) return hit.v;
  const { rows: [r] } = await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${S}.opening_balances`]);
  const v = !!(r && r.ok);
  _obCache.set(S, { v, at: Date.now() });
  return v;
}

/**
 * login-20261023 — which children make up this child's FAMILY for billing: every child sharing an
 * active parent login with this one — the same set the parent app shows that family. (Moved here
 * from payments-admin.js's /ledger so Roost and the EY leadership view use one definition.)
 */
async function familyChildIds(db, childId, { schema = 'ladn' } = {}) {
  const S = schemaName(schema);
  const id = Number(childId);
  let ids = [id];
  try {
    const { rows: [f] } = await db.query(
      `SELECT array_agg(DISTINCT b.child_id) AS ids
         FROM ${S}.parent_portal_access a
         JOIN ${S}.parent_portal_access b ON lower(b.email) = lower(a.email) AND b.is_active AND b.child_id IS NOT NULL
        WHERE a.child_id = $1 AND a.is_active`, [id]);
    if (f && Array.isArray(f.ids) && f.ids.length) ids = Array.from(new Set([id, ...f.ids.map(Number)]));
  } catch (_) { /* no parent logins table in this edition: the child alone */ }
  return ids;
}

module.exports = { familyLedger, familyChildIds, modeOf, openingBalancesExist };
