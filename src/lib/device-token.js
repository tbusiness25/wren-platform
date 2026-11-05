'use strict';
/**
 * device-token.js — b491 (2026-10-12, security hardening item 3).
 *
 * A small, standalone copy of editions/ladn/server-unified.js's own device-
 * token verification (_verifyDeviceToken / _deviceOk / DEVICE_PORTAL_TYPE),
 * for the route files OUTSIDE that monolith (observations.js, incidents.js,
 * setting-incidents.js, messages.js) that now need the SAME "on EY, also
 * require an enrolled device" check for the new signed media URLs. Not a
 * refactor of the original — server-unified.js's own copy is untouched, to
 * avoid risking its existing (working) device-gate behaviour. Deliberately
 * tiny and dependency-free so it's obviously equivalent on inspection.
 */

const jwt = require('jsonwebtoken');
const { getPool } = require('../db/pool');

const DEVICE_PORTAL_TYPE = { admin: 'admin_pc', learning: 'ey_tablet', ey: 'ey_tablet', parents: 'parents', hr: 'hr' };
const DEVICE_ENFORCE_KEY = { admin: 'device_enforce_admin', learning: 'device_enforce_ey', ey: 'device_enforce_ey', parents: 'device_enforce_parents', hr: 'device_enforce_hr' };

function tokenOf(req) {
  const v = req.headers['x-wren-device'] || (req.query && req.query.dev) || '';
  return Array.isArray(v) ? String(v[0] || '') : v; // b491 review: ?dev= may repeat
}

function verifyRaw(raw) {
  if (!raw) return null;
  try { return jwt.verify(raw, process.env.JWT_SECRET, { issuer: 'wren-device' }); } catch { /* try the previous key */ }
  // b491 review: same fallback as server-unified.js _verifyDeviceToken (release 3818f5b2) — the 10
  // EY tablets were enrolled before the 9 Oct key rotation and still carry old-key device tokens.
  if (process.env.DEVICE_TOKEN_PREVIOUS_SECRET) {
    try { return jwt.verify(raw, process.env.DEVICE_TOKEN_PREVIOUS_SECRET, { issuer: 'wren-device' }); } catch { /* fall through */ }
  }
  return null;
}

async function _enforceOn(portal) {
  const key = DEVICE_ENFORCE_KEY[portal];
  if (!key) return false;
  if (process.env.DEVICE_ENFORCE !== 'true') return false; // master switch, same as server-unified.js
  try {
    const { rows } = await getPool().query('SELECT value FROM settings WHERE key=$1', [key]);
    return rows[0]?.value === 'on';
  } catch { return false; } // fail-open, same posture as the rest of the device gate
}

/**
 * Resolves whether THIS request is allowed through, for the device side of
 * the check only. Returns true when: enforcement is off for this portal, OR
 * the request carries a verified, non-revoked, right-type device token.
 */
async function isAllowed(req) {
  const portal = req._portal || 'learning';
  const wantType = DEVICE_PORTAL_TYPE[portal];
  if (!wantType) return true; // portal has no device concept (e.g. demo editions)
  if (!(await _enforceOn(portal))) return true;
  const d = verifyRaw(tokenOf(req));
  if (!d || !d.device_uuid) return false;
  if (d.exp && d.exp * 1000 < Date.now()) return false;
  try {
    const { rows } = await getPool().query(
      'SELECT device_type, revoked FROM enrolled_devices WHERE device_uuid=$1', [d.device_uuid]);
    if (!rows.length || rows[0].revoked) return false;
    return rows[0].device_type === wantType;
  } catch { return false; }
}

module.exports = { isAllowed, tokenOf, verifyRaw, DEVICE_PORTAL_TYPE };
