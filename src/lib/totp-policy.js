'use strict';
// login-20261023 — ONE answer to "does this role need the authenticator-app code?".
//
// PIN sign-in (src/routes/auth.js) read Roost → Security's setting (settings.security_totp_roles),
// while Google SSO and Wren ID each had a hard-coded copy of the default list, and Login health a
// third. Change the setting and two of the four doors ignored it. All four read this now.
const DEFAULT_TOTP_ROLES = ['manager', 'deputy_manager', 'admin'];

/** The roles that must use 2FA on HR and Roost: the Roost → Security setting, else the default. */
async function getTotpRoles(db) {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key='security_totp_roles'");
    const custom = String((rows[0] && rows[0].value) || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (custom.length) return custom;
  } catch (_) { /* fall through to the default */ }
  return DEFAULT_TOTP_ROLES;
}

/** The environment switches that turn the gate off (dev / the old grace period). */
function totpSwitchedOff() {
  if (process.env.WREN_TOTP_DISABLED === 'true') return true;
  const graceUntil = process.env.TOTP_GRACE_UNTIL ? new Date(process.env.TOTP_GRACE_UNTIL) : null;
  return !!(graceUntil && new Date() < graceUntil);
}

module.exports = { DEFAULT_TOTP_ROLES, getTotpRoles, totpSwitchedOff };
