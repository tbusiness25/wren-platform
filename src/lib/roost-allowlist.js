// Roost (admin portal) person allowlist — b126, 2026-07-21.
//
// Toby's decision (2026-07-21): Roost/admin is Toby (staff id=1) ONLY for now.
// Everyone else — including the deputy_manager/manager rows that used to get
// admin access via role equivalence — loses it. the office manager gets added later by
// appending her staff id to ladn.settings 'roost_admin_staff_ids' (one UPDATE,
// picked up within CACHE_TTL_MS, no redeploy needed).
//
// Deliberately a PERSON allowlist, not a role check: requireRole('manager',
// 'deputy_manager', ...) is scattered across src/routes/*.js and treats those
// roles as manager-equivalent everywhere — that's how the 3 deputy_manager +
// 2 other manager staff got Roost access in the first place. This sits in
// front of those existing role gates rather than replacing them.

const { getPool } = require('../db/pool');

const CACHE_TTL_MS = 30 * 1000;
// `ids: null` (unconfigured) is distinct from `ids: []` (configured but empty) —
// this router is shared with the demo/school editions (eyfs/primary/secondary/
// childrenscorner/htps), none of which have a 'roost_admin_staff_ids' settings
// row. Those editions must stay unrestricted (fail-open) rather than silently
// getting locked to "staff id 1 only" the moment this file loads there.
let _cache = { at: 0, ids: null, configured: false };

async function _load() {
  try {
    const db = getPool();
    const { rows } = await db.query("SELECT value FROM settings WHERE key='roost_admin_staff_ids'");
    if (!rows.length) return { ids: null, configured: false };
    const parsed = JSON.parse(rows[0].value);
    let ids = Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
    if (!ids.includes(1)) ids.push(1); // owner is never lockable out
    return { ids, configured: true };
  } catch (e) {
    console.error('[roost-allowlist] load failed, failing open:', e.message);
    return { ids: null, configured: false };
  }
}

/** Returns { ids, configured } — ids is null when this schema has no allowlist set. */
async function getRoostAllowlist() {
  const now = Date.now();
  if (now - _cache.at < CACHE_TTL_MS) return _cache;
  const loaded = await _load();
  _cache = { at: now, ...loaded };
  return _cache;
}

/** True if this staff id may use Roost / admin-only APIs. Fails OPEN (allowed)
 *  on schemas where roost_admin_staff_ids has never been set (e.g. demo editions) —
 *  fails CLOSED (denied unless listed) once it has (LADN production, 2026-07-21). */
async function isRoostAllowed(staffId) {
  if (Number(staffId) === 1) return true; // fast path, never a DB round-trip for the owner
  const { ids, configured } = await getRoostAllowlist();
  if (!configured) return true;
  return ids.includes(Number(staffId));
}

/** Force the cache to reload on the next call (e.g. right after the setting is edited). */
function invalidate() {
  _cache = { at: 0, ids: null };
}

module.exports = { getRoostAllowlist, isRoostAllowed, invalidate };
