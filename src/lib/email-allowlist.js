// Parent-recipient allowlist for staff outbound email (PROMPT 63, 2026-07-02).
//
// Purpose: practitioners / room leaders / apprentices / cooks must only be able
// to email the PARENTS of enrolled children. Manager-level roles bypass entirely
// (they legitimately email Ofsted, suppliers, the LA, etc.). Staff-to-staff mail
// on the nursery's own Google Workspace domain is always allowed.
//
// The allowlist is the union of:
//   - children.parent_1_email / parent_2_email / primary_contact_email
//     (active OR future-starter children, not yet left)
//   - parent_portal_access.email (active portal accounts)
//   - enquiries.parent_email (prospect parents, b124 2026-07-21)
//   - waiting_list.parent_email (not-yet-started parents, b124 2026-07-21)
// contacts is deliberately NOT included: it has no reliable "parent" type
// column (only primary_email) and holds suppliers/professionals, so pulling it in
// would defeat the restriction.
//
// b124 NOTE for Toby: this same set gates isAllowedRecipient() below, i.e. which
// addresses NON-manager staff may email. Adding enquiries/waiting_list means
// front-line staff can now email prospect parents too, not just enrolled ones.
// You asked for enquiries to be covered for the comms/sync side, so this ships
// as one list — flagged here in case you'd rather split "comms allowlist" (broad)
// from "staff-send allowlist" (enrolled only) later. See
// logs/b124-parent-allowlist-coverage.NOTES.md.
//
// Cached for 5 minutes — the register does not change minute-by-minute.

const { getPool } = require('../db/pool');

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = { at: 0, set: null, list: null };

// Manager-level roles that may email ANY address. Everyone else (practitioner,
// room_leader, senior_practitioner, apprentice, cook, plain 'staff', …) is
// restricted to the parent allowlist. Toby (id=1) always bypasses.
const BYPASS_ROLES = [
  'manager', 'deputy_manager', 'deputy', 'admin', 'owner',
  'headteacher', 'business_manager',
];

// Staff on the nursery's own Google Workspace domain — inter-staff mail is always
// permitted regardless of role.
const INTERNAL_DOMAIN = (process.env.STAFF_EMAIL_DOMAIN || 'example-nursery.co.uk').toLowerCase();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const norm = (e) => String(e || '').trim().toLowerCase();

async function _load() {
  const db = getPool();
  const set = new Set();
  // Parents on the children register (active OR future-starter, not yet left).
  try {
    const { rows } = await db.query(`
      SELECT lower(trim(email)) AS email FROM (
        SELECT parent_1_email        AS email FROM children WHERE (is_active = true OR start_date > CURRENT_DATE) AND (leave_date IS NULL OR leave_date >= CURRENT_DATE)
        UNION ALL SELECT parent_2_email        FROM children WHERE (is_active = true OR start_date > CURRENT_DATE) AND (leave_date IS NULL OR leave_date >= CURRENT_DATE)
        UNION ALL SELECT primary_contact_email FROM children WHERE (is_active = true OR start_date > CURRENT_DATE) AND (leave_date IS NULL OR leave_date >= CURRENT_DATE)
      ) e
      WHERE lower(trim(email)) ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'
    `);
    rows.forEach((r) => set.add(r.email));
  } catch (e) {
    console.error('[email-allowlist] children load failed:', e.message);
  }
  // Parent portal accounts.
  try {
    const { rows } = await db.query(`
      SELECT lower(trim(email)) AS email FROM parent_portal_access
      WHERE (is_active IS DISTINCT FROM false)
        AND lower(trim(email)) ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'
    `);
    rows.forEach((r) => set.add(r.email));
  } catch (e) {
    console.error('[email-allowlist] parent_portal_access load failed:', e.message);
  }
  // Enquiries (prospect parents, b124 2026-07-21).
  try {
    const { rows } = await db.query(`
      SELECT lower(trim(parent_email)) AS email FROM enquiries
      WHERE lower(trim(parent_email)) ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'
    `);
    rows.forEach((r) => set.add(r.email));
  } catch (e) {
    console.error('[email-allowlist] enquiries load failed:', e.message);
  }
  // Waiting list (not-yet-started parents, b124 2026-07-21).
  try {
    const { rows } = await db.query(`
      SELECT lower(trim(parent_email)) AS email FROM waiting_list_live
      WHERE lower(trim(parent_email)) ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'
    `);
    rows.forEach((r) => set.add(r.email));
  } catch (e) {
    console.error('[email-allowlist] waiting_list load failed:', e.message);
  }
  return set;
}

/** Returns the cached Set of allowed (lowercased) parent emails. */
async function getAllowedSet() {
  const now = Date.now();
  if (_cache.set && now - _cache.at < CACHE_TTL_MS) return _cache.set;
  const set = await _load();
  _cache = { at: now, set, list: [...set].sort() };
  return set;
}

/** Returns a fresh sorted array copy of the allowlist (for the admin endpoint / sync). */
async function getAllowedEmails() {
  await getAllowedSet();
  return _cache.list.slice();
}

/** True if this user's role may email any address. */
function isManagerRole(user) {
  if (!user) return false;
  if (Number(user.id) === 1) return true;
  return BYPASS_ROLES.includes(user && user.role);
}

/**
 * Is `email` a permitted recipient for this `user`?
 * Managers → always true. Everyone else → must be a parent of an enrolled child,
 * or an inter-staff address on the nursery's own domain.
 * @returns {Promise<boolean>}
 */
async function isAllowedRecipient(email, user) {
  if (isManagerRole(user)) return true;
  const e = norm(email);
  if (!e || !EMAIL_RE.test(e)) return false;
  if (e.endsWith('@' + INTERNAL_DOMAIN)) return true; // inter-staff
  const set = await getAllowedSet();
  return set.has(e);
}

/* ── The mailing list — narrower than the allowlist (2026-09-17) ────────────
 * These answer two different questions and must not be the same list.
 *   getAllowedEmails()     — may a member of staff email this person at all?
 *                            Includes enquiries and the waiting list, because
 *                            Toby and the team reply to them. Leave it alone.
 *   getMailingListEmails() — who belongs on the parents GROUP, i.e. who gets
 *                            the newsletter and anything sent to everyone.
 * Toby's rule for the group (2026-09-17): every child here now, plus every
 * child due to start inside the lead window, and nobody past their last day —
 * an address drops out the morning after a child's last day. No enquiries and
 * no waiting list: those were 28 addresses receiving parent mail they had
 * never been enrolled for. Window: settings key mailing_list_lead_days.
 */
const MAILING_LEAD_DAYS = 60;

async function mailingListLeadDays(db) {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'mailing_list_lead_days'");
    const n = parseInt(rows[0] && rows[0].value, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 365) return n;
  } catch { /* fall through to the default */ }
  return MAILING_LEAD_DAYS;
}

/** The broadcast audience: parents of children here now or starting soon. */
async function getMailingListEmails() {
  const db = getPool();
  const leadDays = await mailingListLeadDays(db);
  const { rows } = await db.query(`
    WITH on_the_register AS (
      SELECT id
        FROM children
       WHERE (is_active = true
              OR (start_date IS NOT NULL AND start_date <= CURRENT_DATE + ($1 || ' days')::interval))
         AND (leave_date IS NULL OR leave_date >= CURRENT_DATE)
    )
    SELECT lower(trim(v.e)) AS email
      FROM children c
      JOIN on_the_register r ON r.id = c.id
      CROSS JOIN LATERAL (VALUES (c.parent_1_email), (c.parent_2_email), (c.primary_contact_email)) v(e)
     WHERE lower(trim(v.e)) ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'
     UNION
    SELECT lower(trim(pa.email))
      FROM parent_portal_access pa
      JOIN on_the_register r ON r.id = pa.child_id
     WHERE pa.is_active IS DISTINCT FROM false
       AND lower(trim(pa.email)) ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'
     ORDER BY 1`, [String(leadDays)]);
  return rows.map((r) => r.email);
}

/** Force the cache to reload on the next call (e.g. after a child is enrolled). */
function invalidate() {
  _cache = { at: 0, set: null, list: null };
}

module.exports = {
  getMailingListEmails,
  mailingListLeadDays,
  isAllowedRecipient,
  getAllowedEmails,
  getAllowedSet,
  isManagerRole,
  invalidate,
  BYPASS_ROLES,
  INTERNAL_DOMAIN,
};
