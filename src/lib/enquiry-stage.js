'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// b398 (2026-10-06) — the pipeline moves forward on its own, and never backwards.
//
// wren-docs/workflows/new-family-journey-2026-10-06.pdf, gap 4: "Booking a
// viewing or making an offer doesn't change the stage. Pressing '→ Waiting
// list' on an 'Offer accepted' card moves it back to 'On waiting list'."
//
// One helper, one explicit order. Every place that already changes an
// enquiry's stage (convert-to-waiting-list, convert-to-child, the offer and
// respond routes, a viewing confirm) moves it forward through here instead of
// writing `stage=…` directly, so a card can never fall back to an earlier
// stage by accident.
//
// It deliberately does NOT cover 'lost' or 'declined' — those are an explicit
// decision a person makes (the enquiry PUT route, or a dedicated decline
// action), not a step in the forward funnel, and are never touched here.
// ═══════════════════════════════════════════════════════════════════════════

const STAGE_ORDER = [
  'new', 'tour_booked', 'tour_done', 'on_waiting_list',
  'offer_made', 'offer_accepted', 'registered',
];
const RANK = Object.fromEntries(STAGE_ORDER.map((s, i) => [s, i]));

// waiting_list and enquiries both represent a family on the pipeline, and a
// viewing/offer may be booked against either depending on how the family got
// there. This resolves either shape down to the enquiries.id that actually
// carries `stage`, or null if there isn't a linked enquiry to move.
async function resolveEnquiryId(db, familyType, familyId) {
  if (!familyType || !familyId) return null;
  if (familyType === 'enquiry') return Number(familyId);
  if (familyType === 'waiting_list') {
    const { rows } = await db.query(`SELECT enquiry_id FROM waiting_list WHERE id=$1`, [familyId]);
    return rows[0]?.enquiry_id || null;
  }
  return null;
}

// Moves enquiries.stage to `stage` IF that is further along the funnel than
// where it is now. Never moves it backwards or sideways, and never touches a
// card that is already lost/declined (those are closed, not "earlier in the
// funnel"). Silently a no-op on an unknown enquiry, an unknown stage or an
// out-of-order call — callers fire this from several places in the journey
// and should never have to check what stage a card is on first.
async function advanceEnquiry(db, enquiryId, stage, { reason, req } = {}) {
  if (!enquiryId || !(stage in RANK)) return null;
  const { rows } = await db.query(`SELECT id, stage FROM enquiries WHERE id=$1`, [enquiryId]);
  if (!rows.length) return null;
  const cur = rows[0].stage;
  if (cur === 'lost' || cur === 'declined') return null;
  const curRank = RANK[cur] ?? -1;
  if (curRank >= RANK[stage]) return null;

  const { rows: upd } = await db.query(
    `UPDATE enquiries SET stage=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [stage, enquiryId]);

  try {
    require('../utils/audit').recordAudit({
      req, action: 'stage_advance', entity_type: 'enquiry', entity_id: Number(enquiryId),
      meta: { from: cur, to: stage, reason: reason || null },
    });
  } catch (_) { /* audit is best-effort; the stage move itself already committed */ }

  return upd[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// b424 (2026-10-08) — offer_accepted is now labelled "Registration forms &
// deposits received" because that is genuinely what a family sitting in that
// column is doing. Submitting the registration form used to jump straight to
// 'registered' regardless of the deposit — gate it on both, so a card only
// reaches Registered once it is actually true. Call tryAdvanceToRegistered
// from every place either half can become true (the form-submit route, and
// every place a deposit gets marked paid); whichever happens second completes
// the move.
// ═══════════════════════════════════════════════════════════════════════════

// A deposit is settled if the waiting-list row has been marked paid, or marked
// not required (funded-only families), or a child_deposits row for this family
// (via either the waiting-list link or the child's own enquiry_id) is paid/credited.
async function isDepositSatisfied(db, enquiryId) {
  // b428 — read through waiting_list_live (merged_into_id IS NULL), not the raw
  // table: an enquiry that was merged could otherwise match a tombstoned
  // duplicate row with stale deposit_paid/deposit_required, decided by
  // whichever row Postgres happened to return first.
  const { rows } = await db.query(
    `SELECT w.id AS waiting_list_id, w.deposit_paid, w.deposit_required
       FROM waiting_list_live w WHERE w.enquiry_id=$1 ORDER BY w.id DESC LIMIT 1`, [enquiryId]);
  const w = rows[0];
  if (w && w.deposit_required === false) return true;
  if (w && w.deposit_paid) return true;
  const { rows: cd } = await db.query(
    `SELECT 1 FROM child_deposits d
       LEFT JOIN children c ON c.id = d.child_id
      WHERE d.status IN ('paid','credited')
        AND (d.waiting_list_id = $2 OR c.enquiry_id = $1) LIMIT 1`,
    [enquiryId, w ? w.waiting_list_id : null]);
  return cd.length > 0;
}

// Forms are "in" once a children row exists off the back of this enquiry with a
// real registration submission — status 'enquiry' (b399's provisional, chat-only
// row created by "Invite to the parents app") does not count on its own.
async function hasRegistrationForm(db, enquiryId) {
  const { rows } = await db.query(
    `SELECT 1 FROM children WHERE enquiry_id=$1 AND status IN ('pending','active') LIMIT 1`, [enquiryId]);
  return rows.length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// b531 (2026-10-27) — the admissions lead's "Wren pipeline stages and actions":
//   Allocated (offer_made)        → we've offered a place; deposit info and the
//                                   registration form go out at the right time.
//   Forms & deposit (offer_accepted) → BOTH the registration form and the
//                                   deposit are in. Waiting for the welcome pack.
//   Registered                    → the welcome pack has been sent.
// So the form+deposit check now moves the card to Forms & deposit (it used to
// jump to Registered), and sending the welcome pack is what makes it Registered
// (welcome-pack.js). The function keeps its name so the four callers (form
// submit, deposit marked, deposit reconciled, enrol) don't change.
// ═══════════════════════════════════════════════════════════════════════════
async function tryAdvanceToRegistered(db, enquiryId, { reason, req } = {}) {
  if (!enquiryId) return null;
  const [formIn, depositOk] = await Promise.all([
    hasRegistrationForm(db, enquiryId),
    isDepositSatisfied(db, enquiryId),
  ]);
  if (!formIn || !depositOk) return null;
  return advanceEnquiry(db, enquiryId, 'offer_accepted', { reason, req });
}

// b531 — the welcome pack has gone, so the family is Registered.
async function advanceOnWelcomePack(db, childId, { req } = {}) {
  const { rows } = await db.query(`SELECT enquiry_id FROM children WHERE id=$1`, [childId]);
  if (!rows[0] || !rows[0].enquiry_id) return null;
  return advanceEnquiry(db, rows[0].enquiry_id, 'registered', { req, reason: 'welcome pack sent' });
}

module.exports = {
  STAGE_ORDER, RANK, resolveEnquiryId, advanceEnquiry,
  isDepositSatisfied, hasRegistrationForm, tryAdvanceToRegistered, advanceOnWelcomePack,
};
