// Parent-recipient allowlist for staff outbound email (PROMPT 63, 2026-07-02).
//
// Purpose: practitioners / room leaders / apprentices / cooks must only be able
// to email the PARENTS of enrolled children. Manager-level roles bypass entirely
// (they legitimately email Ofsted, suppliers, the LA, etc.). Staff-to-staff mail
// on the nursery's own Google Workspace domain is always allowed.
//
// The allowlist is the union of:
//   - children.parent_1_email / parent_2_email / primary_contact_email
//     (active children only)
//   - parent_portal_access.email (active portal accounts)
// contacts is deliberately NOT included: it has no reliable "parent" type
// column (only primary_email) and holds suppliers/professionals, so pulling it in
// would defeat the restriction.
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
  // Parents on the children register (active children).
  try {
    const { rows } = await db.query(`
      SELECT lower(trim(email)) AS email FROM (
        SELECT parent_1_email        AS email FROM children WHERE is_active = true
        UNION ALL SELECT parent_2_email        FROM children WHERE is_active = true
        UNION ALL SELECT primary_contact_email FROM children WHERE is_active = true
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

/** Force the cache to reload on the next call (e.g. after a child is enrolled). */
function invalidate() {
  _cache = { at: 0, set: null, list: null };
}

module.exports = {
  isAllowedRecipient,
  getAllowedEmails,
  getAllowedSet,
  isManagerRole,
  invalidate,
  BYPASS_ROLES,
  INTERNAL_DOMAIN,
};
