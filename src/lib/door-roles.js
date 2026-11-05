'use strict';
/**
 * b272 (2026-09-04) — who may operate the front door.
 *
 * Toby, from the floor: "allow the door entry to be used by all up to
 * practitioner (not apprentices)".
 *
 * WHY THIS FILE EXISTS. Three routers can physically release the same door and
 * each carried its own, different gate:
 *
 *   src/routes/door.js      POST /api/door/open              — b195. Had a role
 *       set (manager/room_leader/practitioner + aliases) that ALREADY matched
 *       what Toby asked for. Verified on wren-ladn-dev before this build:
 *       practitioner 200, apprentice 403.
 *   src/routes/doorbell.js  POST /api/doorbell/open          — b99, legacy, still
 *       mounted. Gate was `role !== 'parent'`, so an APPRENTICE token opened the
 *       door here (verified: 200 on dev) while being refused on /api/door/open.
 *       This is the bug behind Toby's request — the narrow gate was real, it just
 *       was not the only door.
 *   src/routes/intercom.js  POST /api/intercom/events/:id/release-door — same
 *       `role !== 'parent'` gate, additionally requires a ring in the last 5 min.
 *
 * So the fix is not "widen door.js" — practitioners were never blocked there —
 * it is "make the other two agree with it". One list, imported by all three.
 *
 * DENY IS CHECKED FIRST, deliberately. An allow-list alone means the day someone
 * adds a role here in a hurry, apprentices are back in. `apprentice` being in
 * DENY_ROLES makes Toby's "not apprentices" survive a careless future edit.
 *
 * COOK / CHEF ARE NOT CHANGED BY THIS BUILD. They are already refused every door
 * route — not here, but one layer up: editions/ladn/server-unified.js runs a
 * COOK_ALLOW allow-list over /api that 403s a cook/chef token on any path segment
 * outside the kitchen set ("Forbidden — kitchen access only"). They therefore
 * never reach these gates at all. They are listed in DENY_ROLES anyway so that
 * this file states the intended answer rather than relying on a gate in another
 * file — but nothing about a cook's access changes today.
 *
 * NOT in ALLOW: 'ect', 'bank', 'supply'. These are rows in ladn.roles (the
 * permissions matrix) but no member of staff carries them in ladn.staff.role on
 * prod or dev, and Toby named the floor hierarchy, not cover staff. Adding them
 * is a one-line change once he says so — see logs/b272.NOTES.md.
 *
 * Role strings here are ladn.staff.role / JWT values, NOT ladn.roles.key — the
 * two are separate namespaces bridged by ROLE_KEY_ALIASES in src/lib/capabilities.js
 * (staff.role 'room_leader' ↔ roles.key 'room-leader'). Both spellings are listed
 * so a token minted from either namespace resolves the same way.
 */

// Never operates the door, whatever else the lists say. Checked first.
const DENY_ROLES = new Set([
  'apprentice',          // Toby, 2026-09-04 — the point of this build
  'parent',              // not staff
  'cook', 'chef',        // already blocked by COOK_ALLOW; unchanged, stated here
  'student', 'volunteer', // on placement, unsupervised door release is not theirs
]);

// Practitioner and everything above it. b271 renamed the top of the tree
// (staff.role 'manager' → 'admin', 'deputy_manager' → 'manager'), so BOTH the
// pre- and post-rename spellings are listed: prod is still on the old ones.
const DOOR_OPEN_ROLES = new Set([
  'practitioner', 'senior_practitioner',
  'room_leader', 'room-leader',
  'deputy', 'deputy_manager',
  'manager',
  'admin', 'owner', 'headteacher',
]);

/** The role string to gate on, honouring auth.js's headteacher rewrite. */
function _roleOf(user) {
  if (!user) return '';
  return String(user.role_original || user.role || '');
}

/**
 * May this user operate the front door (release it / answer the intercom)?
 * Fails closed: unknown or missing role → false.
 * @param {object} user  req.user
 */
function canOperateDoor(user) {
  const role = _roleOf(user);
  if (!role) return false;
  if (DENY_ROLES.has(role)) return false;
  return DOOR_OPEN_ROLES.has(role);
}

/**
 * Express middleware. 403s with the same shape door.js has always returned, so
 * the EY door console's existing error handling keeps working unchanged.
 */
function requireDoorRole(req, res, next) {
  if (canOperateDoor(req.user)) return next();
  return res.status(403).json({
    error: 'role_not_permitted',
    message: 'Your role cannot release the front door.',
  });
}

module.exports = { DOOR_OPEN_ROLES, DENY_ROLES, canOperateDoor, requireDoorRole };
