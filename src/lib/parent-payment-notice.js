'use strict';
// 2026-10-06 — "Payment received" for the family, IN THE APP ONLY (a bell on their child),
// when the office records money: a bank transfer confirmed in Reconcile, a split, a manual
// "Add payment", a deposit taken onto the account. Card payments already ring their own bell.
// Never an email or push: a parent is not emailed by Wren without a person pressing Send
// (memory feedback_no_auto_email_to_parents). Parents read their bell by CHILD id.
async function notifyPaymentReceived(db, childId, amountPence, { onDate = null, kind = 'payment', schema = 'ladn' } = {}) {
  const id = parseInt(childId, 10);
  const amt = Math.abs(parseInt(amountPence, 10) || 0);
  if (!Number.isInteger(id) || !amt) return false;
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) return false;
  const gbp = `£${(amt / 100).toFixed(2)}`;
  const when = onDate ? ` on ${new Date(onDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` : '';
  const title = kind === 'deposit' ? 'Deposit received' : 'Payment received';
  const body = kind === 'deposit'
    ? `We've received your deposit of ${gbp}${when} — thank you. It's on your account and comes off your bill.`
    : `We've received your payment of ${gbp}${when} — thank you. It's on your statement under Invoices.`;
  try {
    await db.query(
      `INSERT INTO ${schema}.notifications (recipient_type, recipient_id, category, title, body, link, priority)
       VALUES ('parent', $1, 'payment_received', $2, $3, '/welcome/invoices', 'normal')`, [id, title, body]);
    return true;
  } catch (_) { return false; }
}
module.exports = { notifyPaymentReceived };
