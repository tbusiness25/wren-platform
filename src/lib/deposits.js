'use strict';
// 2026-10-05 — Toby: "bring the deposit into their current balance. We don't hold onto these!"
// LADN does not keep a deposit apart from the fee account. A deposit for a child who is on roll
// is a PAYMENT on the family's account the moment it is recorded: it pays the oldest open
// invoice, or sits as credit if there is none. A deposit for a child still on the waiting list
// (no child record yet) is kept on child_deposits (status 'paid') only until they start; it is
// then applied the same way. One function, so every path does it identically.

/**
 * Apply a child_deposits row to the child's account. Idempotent: only a 'paid' deposit with a
 * child is applied; it becomes 'credited' with the payment's invoice recorded.
 * @param {import('pg').PoolClient|import('pg').Pool} db  (call inside the caller's transaction)
 * @returns {Promise<{payment_id:number, invoice_id:number|null}|null>}
 */
async function applyDepositToAccount(db, depositId, { onDate = null, source = 'manual', bankLineId = null } = {}) {
  const { rows: [d] } = await db.query(
    `SELECT id, child_id, amount_pence, paid_date FROM child_deposits
      WHERE id = $1 AND status = 'paid' AND child_id IS NOT NULL FOR UPDATE`, [depositId]);
  if (!d || !(Number(d.amount_pence) > 0)) return null;
  // the oldest invoice still owing for this child — a deposit pays what is due first
  const { rows: [inv] } = await db.query(`
    SELECT i.id, i.bill_payer_email FROM invoices i
     WHERE i.child_id = $1 AND i.status IN ('sent','overdue') AND i.amount_pence > 0
       AND i.amount_pence > COALESCE((SELECT SUM(p.amount_pence) FROM payments p
                                       WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0)
     ORDER BY i.issued_on NULLS LAST, i.id LIMIT 1`, [d.child_id]);
  const { rows: [pmt] } = await db.query(`
    INSERT INTO payments (invoice_id, child_id, bill_payer_email, amount_pence, payment_method, status,
                          description, bank_statement_line_id, reconciliation_status, paid_on, source, updated_at)
    VALUES ($1,$2,$3,$4,'deposit','succeeded','Deposit — taken onto the account',$5,'reconciled',
            COALESCE($6::date, $7::date, CURRENT_DATE),$8,NOW())
    RETURNING id`,
    [inv ? inv.id : null, d.child_id, inv ? inv.bill_payer_email : null, d.amount_pence,
     bankLineId, onDate, d.paid_date, source]);
  if (inv) {
    await db.query(`
      UPDATE invoices i SET status='paid', paid_on=COALESCE($2::date, CURRENT_DATE), updated_at=NOW()
       WHERE i.id=$1 AND i.status <> 'paid'
         AND (SELECT COALESCE(SUM(p.amount_pence),0) FROM payments p WHERE p.invoice_id=i.id AND p.status='succeeded') >= i.amount_pence`,
      [inv.id, onDate]);
  }
  await db.query(`
    UPDATE child_deposits SET status='credited', applied_invoice_id=$2,
           notes = COALESCE(notes || ' · ', '') || 'Taken onto the account (payment ' || $3 || ')'
     WHERE id=$1`, [d.id, inv ? inv.id : null, pmt.id]);
  // 2026-10-06 — the family sees it on their account (in-app bell only, never email).
  try {
    await require('./parent-payment-notice').notifyPaymentReceived(
      db, d.child_id, d.amount_pence, { onDate: onDate || d.paid_date, kind: 'deposit' });
  } catch (_) {}
  return { payment_id: pmt.id, invoice_id: inv ? inv.id : null };
}

/**
 * A child record has just been created (registration form, enquiry portal, convert):
 * adopt any deposit taken while they were on the waiting list — same name, and the
 * same date of birth when both are known — and take it onto their account.
 */
async function adoptWaitlistDeposits(db, childId) {
  await db.query(`
    UPDATE child_deposits d SET child_id = c.id
      FROM children c, waiting_list w
     WHERE c.id = $1 AND d.waiting_list_id = w.id AND d.child_id IS NULL AND d.status = 'paid'
       AND lower(btrim(w.child_first_name)) = lower(btrim(c.first_name))
       AND lower(btrim(w.child_last_name))  = lower(btrim(c.last_name))
       AND (w.child_dob IS NULL OR c.date_of_birth IS NULL OR w.child_dob = c.date_of_birth)`, [childId]);
  const { rows } = await db.query(`SELECT id FROM child_deposits WHERE child_id = $1 AND status = 'paid' AND waiting_list_id IS NOT NULL`, [childId]);
  const out = [];
  for (const r of rows) out.push(await applyDepositToAccount(db, r.id, { source: 'manual' }));
  return out.filter(Boolean);
}

module.exports = { applyDepositToAccount, adoptWaitlistDeposits };
