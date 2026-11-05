'use strict';
// 2026-10-06 — the three things a family needs before it can see, be sent and pay a bill.
//
// Toby: "set up those three and build the fix". Mapping the journey from enquiry to first
// payment found that nothing in Roost ever set them for a new family:
//   1. children.primary_contact_email — the BILLING email. Invoices copy it as
//      bill_payer_email (no email = "No bill payer email" when sending), the family payment
//      reference (LA-XXXX) is keyed on it, Direct Debit matches on it, and "Add payment"
//      finds the family's invoices by it.
//   2. parent_portal_access rows — every money page in the parents app (invoices, how to
//      pay, card payment) scopes through them; signing in alone isn't enough.
//   3. the family payment reference itself.
//
// ONE function, called wherever a family becomes real: approving a registration, waiting
// list "Enrol", Roost "Add child", and saving a parent email on a child. Idempotent and
// additive: it fills blanks, never overwrites a billing email somebody chose, never
// re-opens access that was deliberately switched off, and never sends anything.

const norm = (v) => {
  const s = String(v || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
};

/**
 * @returns {Promise<{ok:boolean, reason?:string, billing_email_set?:boolean,
 *            access_created?:number, invoices_filled?:number, family_ref?:string|null}>}
 */
async function ensureFamilyAccess(db, childId) {
  const id = parseInt(childId, 10);
  if (!Number.isInteger(id)) return { ok: false, reason: 'bad child id' };
  const { rows: [c] } = await db.query(
    `SELECT id, status, parent_1_email, parent_2_email, primary_contact_email FROM children WHERE id = $1`, [id]);
  if (!c) return { ok: false, reason: 'child not found' };
  if (c.status === 'left') return { ok: false, reason: 'child has left' };

  const p1 = norm(c.parent_1_email), p2 = norm(c.parent_2_email);
  const billing = norm(c.primary_contact_email) || p1 || p2;
  if (!billing) return { ok: false, reason: 'no parent email on the child record' };

  const out = { ok: true, billing_email_set: false, access_created: 0, invoices_filled: 0, family_ref: null };

  if (!norm(c.primary_contact_email)) {
    const r = await db.query(
      `UPDATE children SET primary_contact_email = $2, updated_at = NOW()
        WHERE id = $1 AND NULLIF(btrim(primary_contact_email), '') IS NULL`, [id, billing]);
    out.billing_email_set = r.rowCount > 0;
  }

  // One access row per parent email, the shape every existing family's rows have.
  // ON CONFLICT DO NOTHING: an existing row — active or deliberately retired — is left alone.
  for (const email of [...new Set([p1, p2].filter(Boolean))]) {
    const r = await db.query(
      `INSERT INTO parent_portal_access (child_id, email, is_active, access_level)
       VALUES ($1, $2, true, 'parent')
       ON CONFLICT (child_id, email) DO NOTHING`, [id, email]);
    out.access_created += r.rowCount;
  }

  // b399 (2026-10-06) — a family that was in "enquiry mode" (pre-enrolment
  // parents-app access) becomes a real family the moment this function is
  // called from anywhere a family becomes real (approval, waiting-list
  // Enrol, Add child, saving a parent email) — lift their access the same
  // way, rather than leaving them on the restricted gate forever.
  const promoted = await db.query(
    `UPDATE parent_portal_access SET access_level='parent'
      WHERE child_id=$1 AND access_level='enquiry' AND is_active=true`, [id]);
  out.enquiry_access_promoted = promoted.rowCount;

  // Bills already raised without a payer (e.g. generated before the email was known).
  const inv = await db.query(
    `UPDATE invoices SET bill_payer_email = $2, updated_at = NOW()
      WHERE child_id = $1 AND NULLIF(btrim(bill_payer_email), '') IS NULL
        AND status IN ('draft', 'sent', 'overdue')`, [id, billing]);
  out.invoices_filled = inv.rowCount;

  try {
    const { ensureFamilyRef } = require('../services/payment-matcher');
    const r = await ensureFamilyRef(db, billing);
    out.family_ref = r && r.payment_ref || null;
  } catch (e) { out.family_ref_error = e.message; }

  return out;
}

module.exports = { ensureFamilyAccess };
