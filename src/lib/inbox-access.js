'use strict';
/**
 * inbox-access.js — b364 (2026-09-29)
 *
 * The one place that answers "may this person read email, and which mailboxes".
 *
 * ── WHY A LIB AND NOT A COPY ────────────────────────────────────────────────
 * b338 put this logic inside src/routes/comms.js as three private functions
 * (managerStaffIds / allowedMailboxes / isCommsManager). b364 needs the same
 * answer on a different router, and a second copy of an access rule is how two
 * screens end up disagreeing about who the admissions lead is. So the rule is lifted here
 * VERBATIM in behaviour — same settings key, same grants table, same "empty list
 * means no email access at all" — and comms.js is left exactly as it is. Nothing
 * widens: this module can only ever return a subset of the mailboxes that
 * settings.comms_manager_staff_ids plus comms_mailbox_access already allow.
 *
 * ── THE RULE (Toby, 2026-09-17, restated 2026-09-24) ────────────────────────
 * "Only management can read email: Toby, the office manager and the admissions lead." That is a PERSON
 * list, not a role check, and it is deliberately not derived from `role`:
 * requireRole('manager') treats every deputy as manager-equivalent across a
 * hundred shared routes, and the brief says "Not deputies by default".
 *
 * the admissions lead's staff record was being created on 2026-09-29. She gets access by being
 * added to settings.comms_manager_staff_ids and given a comms_mailbox_access row
 * — one UPDATE and one INSERT, no deploy — which is also how "plus anyone Toby
 * grants" works. Nothing in b364 hard-codes a staff id.
 */

const { getPool } = require('../db/pool');
const { isOwnerRole, rawRole } = require('./capabilities');
const gmail = require('./gmail-sender');

const MANAGER_IDS_KEY = 'comms_manager_staff_ids';
const MAILBOXES_KEY   = 'comms_mailboxes';

/** The staff ids allowed to read email at all. [] when unset — fails CLOSED. */
async function managerStaffIds(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key=$1`, [MANAGER_IDS_KEY]);
    const parsed = JSON.parse(rows[0]?.value || '[]');
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch { return []; }
}

/** The configured mailboxes: [{ address, label, confidential }]. */
async function mailboxDefinitions(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key=$1`, [MAILBOXES_KEY]);
    const parsed = JSON.parse(rows[0]?.value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * Mailbox addresses this staff member may read. An empty array means no email
 * access at all, and every b364 read treats it that way — no allowed mailbox, no
 * rows, before any other filter is considered.
 */
async function allowedMailboxes(db, staffId) {
  const mgrs = await managerStaffIds(db);
  if (!mgrs.includes(Number(staffId))) return [];
  try {
    const { rows } = await db.query(
      `SELECT mailbox FROM comms_mailbox_access WHERE staff_id=$1`, [staffId]);
    return rows.map(r => r.mailbox);
  } catch { return []; }
}

/** True if this person is on the email-reading list at all. */
async function isCommsManager(db, staffId) {
  const mgrs = await managerStaffIds(db);
  return mgrs.includes(Number(staffId));
}

/** Everyone who may read email — the people a section alert may be sent to. */
async function commsManagerIds(db) {
  const ids = await managerStaffIds(db);
  if (!ids.length) return [];
  try {
    const { rows } = await db.query(
      `SELECT id FROM staff WHERE id = ANY($1::int[]) AND is_active = true ORDER BY id`, [ids]);
    return rows.map(r => r.id);
  } catch { return ids; }
}

/**
 * True when the mailbox is flagged confidential in the settings row.
 *
 * b486c (2026-10-13, CHECK.md defect 9): a mailbox with NO entry in
 * comms_mailboxes used to come back `false` — not confidential — which fails
 * OPEN exactly when it matters most: POLL_MAILBOXES widened to include toby@
 * before the settings SQL runs, or the settings row itself missing/corrupt.
 * Either way `mailboxDefinitions()` returns `[]`/no hit, and every caller of
 * this function (assertMailboxActionable's pin/edit/ignore/send-draft guard
 * included) would have treated the UNKNOWN mailbox as safe to act on. An
 * unknown mailbox now counts as confidential UNLESS it is one of the two
 * mailboxes that are safe before any settings row exists at all — today's
 * staff@ default (gmail.INBOX_MAILBOX) and admin@ (gmail.COMMS_MAILBOX),
 * which has always been able to send. A mailbox explicitly found in defs still
 * resolves by its own `confidential` flag exactly as before.
 */
async function isConfidentialMailbox(db, mailbox) {
  if (!mailbox) return false;
  const defs = await mailboxDefinitions(db);
  const m = String(mailbox).toLowerCase();
  const hit = defs.find(d => String(d.address || '').toLowerCase() === m);
  if (hit) return !!hit.confidential;
  const safeDefaults = [gmail.INBOX_MAILBOX, gmail.COMMS_MAILBOX]
    .filter(Boolean).map(s => String(s).toLowerCase());
  return !safeDefaults.includes(m);
}

/**
 * b486c (2026-10-13): the allow-list counterpart to confidentialMailboxAddresses()
 * below, for the ambient, no-per-viewer-check surfaces (Cockpit, James, the
 * planner, induction, the waitlist board, email-gateway) that used to deny-list
 * confidential mailboxes instead — the same fail-open shape as isConfidentialMailbox
 * had (CHECK.md defect 9). staff@ and admin@ are included only while settings has NO
 * entry for them (the two mailboxes safe before any comms_mailboxes row exists —
 * review 2026-10-13: an entry that says confidential:true wins, as admin@ does on
 * prod); anything else must be EXPLICITLY marked `confidential: false` in settings
 * to be surfaced here. An unconfigured or newly-widened mailbox is excluded by default.
 */
async function nonConfidentialMailboxAddresses(db) {
  const defs = await mailboxDefinitions(db);
  const allow = new Set(
    defs.filter(d => d.confidential === false).map(d => String(d.address || '').toLowerCase()).filter(Boolean)
  );
  // review 2026-10-13: the two built-in defaults apply ONLY when settings has no entry for
  // them. On prod admin@ has an entry with confidential:true (granted to Toby alone) — adding
  // it here unconditionally put admin@ mail into Cockpit/James/planner/induction/waitlist/
  // gateway, which the b487 deny-list had correctly excluded. A mailbox settings names wins.
  const named = new Set(defs.map(d => String(d.address || '').toLowerCase()).filter(Boolean));
  for (const dflt of [gmail.INBOX_MAILBOX, gmail.COMMS_MAILBOX]) {
    const a = dflt ? String(dflt).toLowerCase() : '';
    if (a && !named.has(a)) allow.add(a);
  }
  return [...allow];
}

/**
 * b486c (2026-10-13): who may be notified/act on a specific mailbox — the
 * reverse of allowedMailboxes() above (which answers "which mailboxes may
 * staff X read"). Used by the poller's new-mail notification (defect 2) so a
 * confidential mailbox only ever pings the people comms_mailbox_access names
 * for it, not every manager/deputy/inbox_access staff member.
 */
async function mailboxGranteeIds(db, mailbox) {
  const mgrs = await managerStaffIds(db);
  if (!mgrs.length) return [];
  try {
    const { rows } = await db.query(
      `SELECT staff_id FROM comms_mailbox_access WHERE mailbox=$1 AND staff_id = ANY($2::int[])`,
      [mailbox, mgrs]);
    return rows.map(r => r.staff_id);
  } catch { return []; }
}

/**
 * b487 (2026-10-12): every mailbox address flagged confidential — for the
 * several places in Wren that read comms_email_queue as an ambient, broad-
 * audience surface (the Cockpit "what needs me" widget, the AI assistant's
 * email search, James's front-desk digest, the planner's calendar extraction,
 * the waitlist board's leaver-notice scan, the apprenticeship-candidates
 * list) rather than through a per-caller mailbox-access check. None of those
 * knew a confidential mailbox existed; adding toby@ without them filtering it
 * out would have put Toby's confidential mail into every one of them for
 * whichever staff happens to view that screen. They exclude confidential
 * mail unconditionally rather than resolving per-viewer access, because none
 * of them render per-viewer today (a cron-built digest, a dashboard widget
 * with no viewer-aware query) — simpler and narrower than threading a staff
 * id through six unrelated files for the one Roost screen that actually
 * needs toby@ visible, which already has its own, correct, per-caller check.
 */
async function confidentialMailboxAddresses(db) {
  const defs = await mailboxDefinitions(db);
  return defs.filter(d => d.confidential).map(d => d.address).filter(Boolean);
}

/**
 * Express guard for the b364 router. Roost only, on the email-reading list, with
 * at least one mailbox granted. Attaches req._mailboxes.
 *
 * Roost-only for the same reason src/routes/inbox-intel.js is: a manager signed
 * in on the EY portal carries a token with audience 'learning' that passes every
 * shared requireRole('manager'), and this router reads parent correspondence.
 */
function guard() {
  return async function inboxGuard(req, res, next) {
    if ((req._portal || null) !== 'admin') {
      return res.status(403).json({
        error: 'forbidden_portal',
        message: 'The Hermes inbox is on the Roost (admin) portal only.',
      });
    }
    if (!req.user || !Number.isInteger(req.user.id)) {
      return res.status(403).json({ error: 'forbidden', message: 'Staff sign-in required.' });
    }
    try {
      const db = getPool();
      const mailboxes = await allowedMailboxes(db, req.user.id);
      if (!mailboxes.length) {
        return res.status(403).json({
          error: 'no_mailbox_access',
          message: 'Email is readable by the people on the management email list only. '
                 + 'Ask Toby to add you in Settings → Shared inbox.',
        });
      }
      req._mailboxes = mailboxes;
      next();
    } catch (e) {
      res.status(500).json({ error: 'access_check_failed', message: e.message });
    }
  };
}

// ── b487 (2026-10-12): the EY tablet's staff inbox ─────────────────────────
// A SECOND, independent path onto the same table, for a different question:
// not "is this person on the Roost management email list" (above — Toby,
// the office manager, the per-mailbox grants table) but "is this person a deputy manager,
// room leader or manager, reading the ordinary staff@ mailbox from the EY
// tablet". Toby, 2026-10-12: "Staff should now see the staff inbox on the EY
// tablet the same way I see it on admin, but only deputy managers and room
// leaders." Deliberately role-based (unlike the Roost list above, which is
// deliberately NOT role-based) because that is what he asked for, and
// deliberately NEVER returns a confidential mailbox — EY is a shared tablet,
// not Toby's own device, and toby@ must stay reachable only from Roost by the
// two people on comms_mailbox_access, however this function is called.
//
// 'manager' here is the POST-b271 floor-manager role (what CLAUDE.md calls
// "Deputy: the deputy") — see src/lib/capabilities.js's header comment. room_leader
// is a real, live staff.role value (b237's roles.key 'room-leader' alias),
// not something this build needed to invent.
// b486c (2026-10-13, CHECK.md defect 3): 'deputy_manager' added — prod's
// deputies (the deputy and the other floor deputy, ids 2 and 17) are still role
// 'deputy_manager' there; the b271 'manager' rename is live in dev only. Without
// this they fell through to isOwnerRole (false — they're not admin/owner/
// headteacher) and got an empty list despite the EY nav tile showing for them.
const EY_INBOX_ROLES = ['manager', 'deputy_manager', 'room_leader'];

/** True for Toby/owner-equivalent, floor managers (deputy managers) and room leaders. */
function isEyInboxEligible(user) {
  if (!user) return false;
  if (isOwnerRole(user)) return true;
  return EY_INBOX_ROLES.includes(rawRole(user));
}

/** The mailboxes the EY staff inbox may ever show: every configured mailbox
 * that is NOT flagged confidential. Role-independent — every eligible EY
 * viewer sees the same (non-confidential) set; there is no per-person grant
 * on this path the way there is for the Roost list. */
async function eyAllowedMailboxes(db) {
  const defs = await mailboxDefinitions(db);
  return defs.filter(d => !d.confidential).map(d => d.address).filter(Boolean);
}

module.exports = {
  MANAGER_IDS_KEY, MAILBOXES_KEY,
  managerStaffIds, mailboxDefinitions, allowedMailboxes,
  isCommsManager, commsManagerIds, isConfidentialMailbox, guard,
  // b487
  EY_INBOX_ROLES, isEyInboxEligible, eyAllowedMailboxes, confidentialMailboxAddresses,
  // b486c
  nonConfidentialMailboxAddresses, mailboxGranteeIds,
};
