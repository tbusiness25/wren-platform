'use strict';
/**
 * ey-inbox-permissions.js — b487 (2026-10-12)
 *
 * Content-level filtering for the EY tablet's staff inbox, on top of
 * src/lib/inbox-access.js's mailbox-level gate. Mailbox access answers "may
 * this person open the staff@ inbox at all"; this answers the narrower
 * question Toby asked for: "Do things like suggested draft replies, and if
 * it's pulling any data from anywhere else, if the staff don't have access
 * they can't see it" — specifically:
 *   - finance-section email  → only a viewer with finance.view
 *   - staff-section email    → only a manager/owner (never a room leader)
 *   - a safeguarding case    → only the DSL/deputy DSL and managers/owner
 *
 * Fails CLOSED throughout: a DB error while checking a permission denies the
 * email rather than showing it. This is the Roost inbox's exemption, not the
 * EY one — comms_manager_staff_ids already restricts Roost email access to
 * Toby/the office manager/whoever Toby adds, so this module is never consulted there.
 */

const { getPool } = require('../db/pool');
const { hasCapability, isOwnerRole, rawRole } = require('./capabilities');
const { SAFEGUARD_RE } = require('./safeguarding-keywords');

const RESTRICTED_SECTIONS = { finance: true, staff: true };

/** Is this person a manager/owner (the role, not the per-staff DSL flag)? */
function isManagerOrOwner(user) {
  return isOwnerRole(user) || rawRole(user) === 'manager';
}

/**
 * b486c (2026-10-13, CHECK.md defect 3): "Deputies see the same sections as
 * room leaders, plus staff. Room leaders do not see staff." (Toby, 2026-10-12).
 * Deliberately separate from isManagerOrOwner — that function also gates
 * canSeeSafeguarding()'s manager/owner shortcut, and broadening IT would hand
 * every deputy automatic safeguarding visibility regardless of the DSL/deputy-DSL
 * flag, which nobody asked for. This is narrower: only the 'staff' section.
 */
function isDeputyRole(user) {
  return rawRole(user) === 'deputy_manager';
}

let _dslCache = new Map(); // staffId -> { at, is_dsl, is_deputy_dsl }
const DSL_TTL_MS = 60 * 1000;

/** staff.is_dsl / is_deputy_dsl for one staff id. Small, short-lived cache —
 * this is read on every EY inbox list/action, and the flag changes rarely. */
async function dslFlags(db, staffId) {
  const cached = _dslCache.get(staffId);
  if (cached && Date.now() - cached.at < DSL_TTL_MS) return cached;
  try {
    const { rows } = await db.query(
      'SELECT is_dsl, is_deputy_dsl FROM staff WHERE id=$1', [staffId]);
    const v = { at: Date.now(), is_dsl: !!rows[0]?.is_dsl, is_deputy_dsl: !!rows[0]?.is_deputy_dsl };
    _dslCache.set(staffId, v);
    return v;
  } catch (_) {
    // Fail closed: an unknown DSL status is treated as "not the DSL".
    return { at: Date.now(), is_dsl: false, is_deputy_dsl: false };
  }
}
function invalidateDslCache() { _dslCache = new Map(); }

/** True if this user may see safeguarding-flagged mail. */
async function canSeeSafeguarding(db, user) {
  if (!user) return false;
  if (isManagerOrOwner(user)) return true;
  try {
    const f = await dslFlags(db, Number(user.id));
    return f.is_dsl || f.is_deputy_dsl;
  } catch (_) { return false; }
}

/**
 * Haystack used for the on-the-fly keyword check. b486c (2026-10-13, CHECK.md
 * defect 5): this used to be subject/snippet/summary only, on the theory that
 * "a subject/snippet/summary is already what the rest of the inbox shows in a
 * list" — but the LIST now carries body_text for any row it is about to return
 * (see src/routes/comms.js's GET /emails), and a safeguarding phrase mentioned
 * only in the body (fixture S5: "bruise" nowhere but the body) was reaching a
 * room leader because this check never looked there. body_text is included
 * for the DETECTION only — a row this flags is excluded outright, never sent
 * with the phrase intact.
 */
function emailHaystack(email) {
  return `${email.subject || ''}\n${email.snippet || ''}\n${email.summary || ''}\n${email.body_text || ''}`;
}

/** True if this email looks like a safeguarding case — a card's case_kind
 * (set by src/lib/inbox-hermes.js) when one exists, else the same keyword
 * pattern run directly against what the list already has in hand. */
function isSafeguardingFlagged(email, card) {
  if (card && card.case_kind === 'safeguarding') return true;
  return SAFEGUARD_RE.test(emailHaystack(email));
}

/**
 * The sections to exclude outright for a LIST query (finance/staff, only
 * those this viewer lacks) — foldable straight into a SQL WHERE clause.
 * Safeguarding is deliberately NOT included here: Postgres's regex dialect
 * treats `\b` as a literal backspace character, not a word boundary (it uses
 * `\y` for that), so the exact JS pattern used everywhere else in Wren cannot
 * just be pasted into `~*` — see filterListForSafeguarding() below, which
 * runs the real, single SAFEGUARD_RE in JS instead of maintaining a second,
 * Postgres-flavoured copy that could silently drift from it.
 * @returns {Promise<string[]>}
 */
async function listBlockedSections(db, user) {
  const blockedSections = [];
  if (!(await hasCapability(user, 'finance.view'))) blockedSections.push('finance');
  if (!isManagerOrOwner(user) && !isDeputyRole(user)) blockedSections.push('staff');
  return blockedSections;
}

/**
 * Post-fetch safeguarding filter for a LIST of email rows. Returns
 * { rows, hiddenCount } so a caller can also correct a total/count by the
 * number removed. No-ops (returns the rows unchanged) when the viewer may
 * see safeguarding mail at all.
 */
async function filterListForSafeguarding(db, user, rows) {
  if (await canSeeSafeguarding(db, user)) return { rows, hiddenCount: 0 };
  // b486c (2026-10-13, CHECK.md defect 5): read the row's OWN case_kind (the
  // list's SQL now joins inbox_intel_cards) instead of always passing null —
  // this used to mean the list ignored the Hermes card entirely and relied on
  // the subject/snippet/summary keyword check alone, while the by-id action
  // path (canSeeEmail, below) DID consult the card, so the two could disagree
  // (the list showed a row the action path would 403 on, or vice versa). Same
  // column, same isSafeguardingFlagged() call, on both paths now.
  const kept = rows.filter(r => !isSafeguardingFlagged(r, r.case_kind ? { case_kind: r.case_kind } : null));
  return { rows: kept, hiddenCount: rows.length - kept.length };
}

/**
 * Per-email check for an ACTION (send-draft / ignore) rather than a list —
 * used so an EY caller cannot act on a row by id that the list would never
 * have shown them. db is passed through for the DSL lookup.
 * @returns {Promise<boolean>}
 */
async function canSeeEmail(db, user, email, card) {
  if (!email) return false;
  if (email.section && RESTRICTED_SECTIONS[email.section]) {
    if (email.section === 'finance' && !(await hasCapability(user, 'finance.view'))) return false;
    if (email.section === 'staff' && !isManagerOrOwner(user) && !isDeputyRole(user)) return false;
  }
  if (isSafeguardingFlagged(email, card) && !(await canSeeSafeguarding(db, user))) return false;
  return true;
}

module.exports = {
  RESTRICTED_SECTIONS, isManagerOrOwner, isDeputyRole, canSeeSafeguarding, isSafeguardingFlagged,
  listBlockedSections, filterListForSafeguarding, canSeeEmail, dslFlags, invalidateDslCache,
};
