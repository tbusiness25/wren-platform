'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b306 — one place that opens a member of staff's Wren ID account and writes
// down what happened.
//
// Toby, 2026-09-10: "And what exactly do you mean with she'll need the seed
// script run how do I do that."
//
// TWO CALLERS, ONE BEHAVIOUR:
//   • POST /api/onboarding-invites/approve/:id     — automatic, on activation
//   • POST /api/auth/oidc/enrolment/staff/:id/account — the manager's retry
// If those two ever meant different things, the retry button would be a second
// half-implemented feature rather than the answer to Toby's question.
//
// THE CONTRACT: this never throws and never rejects. Both callers have already
// committed something they must not undo — an approval, or a manager's click —
// and authentik being unreachable for thirty seconds is not a reason to lose a
// new starter's record. The failure is written to her staff row instead, and
// the Wren ID tab in Roost shows it with a button next to it.
//
// It sets no password and sends no email. A credential is a separate, explicit
// act — POST /enrolment/staff/invite, pressed by a named manager.
// ─────────────────────────────────────────────────────────────────────────────
const ak = require('./authentik-admin');
const { recordAudit } = require('../utils/audit');

/**
 * Open this member of staff's Wren ID account, and record what happened on their
 * staff row. Returns a small summary for the response; NEVER throws and never
 * rejects — every caller is a handler that has already committed something it
 * must not undo.
 *
 * Shared by approve/:id above and by POST /api/auth/oidc/enrolment/staff/:id/account,
 * so the retry button and the automatic attempt do exactly the same thing.
 */
async function provisionWrenId(db, staffId, req) {
  let r;
  try {
    r = await ak.ensureAccountForStaff(staffId, { db });
  } catch (e) {
    // ensureAccountForStaff is written not to throw. If it ever does, that is
    // still not a reason to fail an approval.
    r = { ok: false, reason: 'internal_error', permission: null,
          message: String((e && e.message) || 'Wren ID account creation failed').slice(0, 400) };
  }

  // Wren ID is simply not configured on most instances. That is not a failure
  // worth putting in front of a manager, or on a staff row.
  if (!r.ok && r.reason === 'not_configured') {
    return { ok: false, reason: r.reason, configured: false };
  }

  try {
    if (r.ok) {
      await db.query(
        `UPDATE staff SET wren_id_provisioned_at = now(), wren_id_provision_error = NULL WHERE id = $1`,
        [staffId]);
    } else {
      await db.query(
        `UPDATE staff SET wren_id_provision_error = $2 WHERE id = $1`,
        [staffId, String(r.message || r.reason).slice(0, 500)]);
    }
  } catch (e) {
    // The columns arrive with migrations/2026-09-10-b306-wren-id-provisioning.sql.
    // A tenant that has not run it yet still gets the account; it just has
    // nowhere to write the note.
    console.error('[onboarding/approve] could not record Wren ID state:', e.message);
  }

  // Counts and outcomes, never a person's details — this line goes to
  // build-logs, which is unwalled.
  console.log(`[wren-id] staff ${staffId}: ${r.ok ? (r.created ? 'account created' : 'account already existed') : `FAILED (${r.reason})`}` +
              (r.permission ? ` missing=${r.permission}` : ''));

  if (req) {
    recordAudit({
      req, action: r.created ? 'create' : 'update', entity_type: 'staff', entity_id: staffId,
      meta: { change: 'wren_id_account_provisioned', ok: !!r.ok, created: !!r.created,
              existed: !!r.existed, reason: r.reason || null, permission: r.permission || null },
    });
  }

  return { ok: !!r.ok, created: !!r.created, existed: !!r.existed,
           reason: r.reason || null, permission: r.permission || null, message: r.message || null };
}

module.exports = { provisionWrenId };
