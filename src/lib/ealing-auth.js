'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Ealing EY Hub — authentication (build b196, 2026-08-19)
//
// These are EXTERNAL ORGANISATIONS, not nursery staff, so this deliberately does
// NOT reuse the staff PIN model (src/middleware/auth.js). Instead:
//   • email + bcrypt password (cost 12), or a single-use emailed magic link
//   • a JWT signed with a SEPARATE, DERIVED secret
//
// The derived secret is the important bit. Nursery tokens are signed with
// JWT_SECRET; hub tokens are signed with sha256(JWT_SECRET + '::wren-ealing-hub').
// So a hub token cannot be verified by ANY nursery route even if that route
// forgets to check the audience — and a stolen/forged staff token cannot open
// the hub. Issuer + audience are checked on top of that.
// ─────────────────────────────────────────────────────────────────────────────
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');

const ISSUER   = 'wren-ealing';
const AUDIENCE = 'wren-ealing-hub';
const TOKEN_TTL = '12h';
const BCRYPT_ROUNDS = 12;

/** True on the dev database (wren_dev). Used to gate dev-only conveniences. */
const IS_DEV_DB = (process.env.PG_DB || 'wren') !== 'wren';

let _secret;
function secret() {
  if (!_secret) {
    const base = process.env.JWT_SECRET;
    if (!base) throw new Error('JWT_SECRET is not set — cannot mint Ealing hub tokens');
    _secret = crypto.createHash('sha256').update(base + '::wren-ealing-hub').digest('hex');
  }
  return _secret;
}

// ── Passwords ────────────────────────────────────────────────────────────────
const hashPassword   = (plain) => bcrypt.hash(String(plain), BCRYPT_ROUNDS);
const verifyPassword = (plain, hash) => (hash ? bcrypt.compare(String(plain), hash) : Promise.resolve(false));

/** Minimum viable password policy for an external-org account. */
function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 10) return 'Password must be at least 10 characters.';
  if (!/[a-z]/i.test(s)) return 'Password must contain a letter.';
  if (!/[0-9]/.test(s)) return 'Password must contain a number.';
  return null;
}

// ── Single-use link tokens (magic link / password reset) ─────────────────────
const newLinkToken = () => crypto.randomBytes(32).toString('base64url');
const hashLinkToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

// ── JWT ──────────────────────────────────────────────────────────────────────
function mintToken(user) {
  return jwt.sign(
    {
      uid:      user.id,
      org_id:   user.org_id,
      role:     user.role,
      email:    user.email,
      name:     user.full_name,
      org_name: user.org_name,
    },
    secret(),
    { issuer: ISSUER, audience: AUDIENCE, expiresIn: TOKEN_TTL }
  );
}

function verifyToken(raw) {
  if (!raw) return null;
  try { return jwt.verify(raw, secret(), { issuer: ISSUER, audience: AUDIENCE }); }
  catch { return null; }
}

function tokenFromRequest(req) {
  const hdr = req.headers['authorization'] || '';
  if (hdr.startsWith('Bearer ')) return hdr.slice(7);
  return req.headers['x-ealing-token'] || (req.cookies && req.cookies.ealing_token) || '';
}

/**
 * Gate for every authenticated hub endpoint.
 *
 * Sets req.ealing = { userId, orgId, role, email, name, orgName }. orgId comes
 * ONLY from the verified token — never from the query string, body or a header —
 * which is what makes the per-setting scope filter a server-side guarantee.
 */
function requireEalingUser(req, res, next) {
  const dec = verifyToken(tokenFromRequest(req));
  if (!dec || !dec.uid || !dec.org_id) {
    return res.status(401).json({ error: 'not_authenticated', message: 'Sign in to the Ealing EY Hub.' });
  }
  req.ealing = {
    userId:  Number(dec.uid),
    orgId:   Number(dec.org_id),
    role:    dec.role || 'setting',
    email:   dec.email || null,
    name:    dec.name || null,
    orgName: dec.org_name || null,
  };
  next();
}

/** LA-side administrator (uploads reports, approves settings, publishes events). */
function requireLaAdmin(req, res, next) {
  if (!req.ealing || req.ealing.role !== 'la_admin') {
    return res.status(403).json({ error: 'la_admin_only', message: 'This is restricted to the Ealing EY team.' });
  }
  next();
}

module.exports = {
  ISSUER, AUDIENCE, IS_DEV_DB,
  hashPassword, verifyPassword, passwordProblem,
  newLinkToken, hashLinkToken,
  mintToken, verifyToken, tokenFromRequest,
  requireEalingUser, requireLaAdmin,
};
