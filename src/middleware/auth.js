// @ts-check  (b508, 2026-10-18) — this file is type-checked. jsconfig.json has
// checkJs:false, so only files carrying this comment are checked; see jsconfig.json
// for how to run it. Keep it passing, or take the comment off deliberately.
// NOTE: this comment must stay the FIRST thing in the file — above 'use strict' —
// or TypeScript ignores it and the file is silently not checked.
const jwt = require('jsonwebtoken');

// Check if IP is on Tailscale network (100.x.x.x)
// req.ip is populated correctly when app.set('trust proxy', 1) is set in server.js
function isTailscaleIP(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip.startsWith('100.') || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.');
}

module.exports = function authenticate(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : req.headers['x-wren-token'] || '';

  if (!token) return res.status(401).json({ error: 'Unauthorised' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const expectedAud = req._portal || 'learning';
    // Strict audience check — grace period ended 2026-05-20
    if (!decoded.aud || decoded.aud !== expectedAud) {
      return res.status(401).json({ error: 'Invalid token audience' });
    }
    // School editions (primary/secondary/HT) use 'headteacher' as their top role —
    // manager-equivalent for every shared requireRole gate (2026-07-04). Original
    // kept on role_original for display. No LADN staff carry this role.
    if (decoded.role === 'headteacher') {
      decoded.role_original = 'headteacher';
      decoded.role = 'manager';
    }
    req.user = decoded;
    req.isTailscale = isTailscaleIP(req);
    // b320 "View as" — a second, independent refusal. The real gate is
    // _viewAs.viewAsGuard, mounted on /api ahead of every router in
    // server-unified.js; this one exists because src/routes/* is also mounted by
    // the demo and school editions' own servers, which do not have that gate.
    // A token carrying `vas` may read and may never write, wherever it is used.
    if (decoded && decoded.vas && decoded.impersonated_by != null) {
      req.viewAs = req.viewAs || {
        jti: decoded.vas,
        by: decoded.impersonated_by,
        by_name: decoded.impersonated_by_name || null,
      };
      const m = (req.method || 'GET').toUpperCase();
      if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') {
        return res.status(403).json({
          error: 'view_as_read_only',
          message: 'You are viewing this account as someone else. Nothing can be changed, sent or saved from here.',
        });
      }
    }
    // b164 (2026-07-27): automatic activity audit — every authenticated API request
    // is logged (view/create/update/delete/download) with no per-route wiring.
    // Fire-and-forget; can never block or fail the request.
    try { require('../utils/request-audit').logRequest(req, res); } catch { /* non-fatal */ }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// login-20261023: requireNetworkAccess() was removed — nothing called it, and its private list of
// "EY data" routes had drifted from the real on-site/off-site gates in server-unified.js.

// b271 (2026-09-04) — the role rename. `manager` (Toby id=1, the office manager id=13, the business manager
// id=23) became `admin`; `deputy_manager` (the room leader id=2, a practitioner id=11, the deputy id=17)
// became `manager`, because the deputies are on the floor and the owners are not.
//
// Every one of the 72 requireRole() call sites in src/routes/*.js names 'manager'
// and most also name 'deputy_manager'. Rewriting all 72 to add 'admin' would be a
// half-rename waiting to happen — miss one and an owner gets a 403 on a screen
// nobody tests. So the gate expands the caller's list once, here:
//
//   admin   satisfies  admin | manager | deputy_manager | owner
//   manager satisfies  manager | deputy_manager
//
// The floor managers therefore keep every gate a deputy passes today AND gain
// every gate a manager passes; the owners lose nothing. This deliberately does
// NOT cover pay: salary/payroll is gated by requireSalaryView / canViewSalaries
// in src/lib/capabilities.js, which is owner-only after b271.
const ROLE_SATISFIES = {
  admin:   ['admin', 'manager', 'deputy_manager', 'owner'],
  owner:   ['owner', 'admin', 'manager', 'deputy_manager'],
  manager: ['manager', 'deputy_manager'],
};
module.exports.ROLE_SATISFIES = ROLE_SATISFIES;

/** Every role string `role` is allowed to satisfy. Never empty. */
function rolesHeldBy(role) {
  return ROLE_SATISFIES[role] || [role];
}
module.exports.rolesHeldBy = rolesHeldBy;

/**
 * login-20261023 — THE inline role check. Same rule as requireRole() (ROLE_SATISFIES above), for
 * code that decides inside a handler. Takes role names or arrays of them:
 *   hasRole(req.user, MANAGER_ROLES)   hasRole(req.user, 'manager', 'room_leader')
 * 337 hand-written `[...].includes(req.user.role)` checks were moved onto this; a simulation of
 * every one for admin/manager/deputy/room leader/practitioner/apprentice/accountant/cook showed no
 * change in who gets through. Change a role's meaning in ROLE_SATISFIES, not at a call site.
 */
function hasRole(user, ...roles) {
  const want = roles.flat().map(String);
  if (!user || !user.role) return false;
  return rolesHeldBy(user.role).some((r) => want.includes(r));
}
module.exports.hasRole = hasRole;

module.exports.requireRole = function requireRole(...roles) {
  return [
    module.exports,
    (req, res, next) => {
      const held = rolesHeldBy(req.user && req.user.role);
      if (!held.some(r => roles.includes(r))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    }
  ];
};
