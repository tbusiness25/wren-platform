// Cloudflare Access JWT assertion verification — real signature check against
// Cloudflare's published JWKS (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs).
//
// Replaces the previously-broken inline verifier in src/routes/auth.js, which
// assumed a non-existent `public_key`/`public_keys` response shape. The real
// certs endpoint returns standard JWKS: { keys: [{ kid, kty, n, e, ... }] }.
//
// Used to close the parent-portal auth bypass (2026-07-21 security pass):
// ~25 /welcome/*/api/* routes previously trusted the plaintext
// cf-access-authenticated-user-email header with no verification at all —
// anyone who could reach the origin (e.g. the Tailscale mesh, bypassing the
// Cloudflare Access edge entirely) could impersonate any parent by setting
// that header to any email. This module verifies the *signed* JWT Cloudflare
// Access injects alongside that header (Cf-Access-Jwt-Assertion) against
// Cloudflare's real signing keys, so only a request that actually passed
// through the CF Access edge (and was authenticated there) can pass.
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const CF_ACCESS_TEAM = process.env.CF_ACCESS_TEAM || 'ladnealing.cloudflareaccess.com';
const CF_CERTS_URL = `https://${CF_ACCESS_TEAM}/cdn-cgi/access/certs`;
const CF_ISSUER = `https://${CF_ACCESS_TEAM}`;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h cache — avoid a network round-trip per request

let _jwksCache = null;
let _jwksCacheAt = 0;

async function _getJwks() {
  const now = Date.now();
  if (_jwksCache && (now - _jwksCacheAt) < JWKS_TTL_MS) return _jwksCache;
  const res = await fetch(CF_CERTS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`cf certs fetch failed: HTTP ${res.status}`);
  const jwks = await res.json();
  if (!Array.isArray(jwks?.keys) || !jwks.keys.length) throw new Error('cf certs: no keys in response');
  _jwksCache = jwks.keys;
  _jwksCacheAt = now;
  return _jwksCache;
}

function _jwkToPem(jwk) {
  const keyObj = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return keyObj.export({ type: 'spki', format: 'pem' });
}

// Verify a raw Cf-Access-Jwt-Assertion against Cloudflare's real signing keys
// and confirm its email claim matches the claimed identity.
// Returns { ok: true, email } or { ok: false, reason }
async function verifyCfAccessJwt(rawJwt, claimedEmail) {
  if (!rawJwt) return { ok: false, reason: 'no_assertion' };
  let header;
  try {
    header = JSON.parse(Buffer.from(String(rawJwt).split('.')[0], 'base64url').toString());
  } catch {
    return { ok: false, reason: 'bad_jwt_format' };
  }

  let keys;
  try {
    keys = await _getJwks();
  } catch (e) {
    return { ok: false, reason: `jwks_fetch_failed: ${e.message}` };
  }

  const match = keys.find(k => k.kid === header.kid);
  const candidates = match ? [match] : keys; // fall back to trying all (covers unannounced key rotation)

  let lastErr = 'signature_verify_failed';
  for (const jwk of candidates) {
    try {
      const pem = _jwkToPem(jwk);
      const decoded = jwt.verify(rawJwt, pem, {
        algorithms: ['RS256'],
        issuer: CF_ISSUER,
        clockTolerance: 30,
      });
      const jwtEmail = (decoded.email || decoded.sub || '').toLowerCase().trim();
      if (!jwtEmail) return { ok: false, reason: 'no_email_claim' };
      if (claimedEmail && jwtEmail !== String(claimedEmail).toLowerCase().trim()) {
        return { ok: false, reason: 'email_mismatch', jwt_email: jwtEmail };
      }
      return { ok: true, email: jwtEmail };
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { ok: false, reason: lastErr };
}

module.exports = { verifyCfAccessJwt, CF_ISSUER, CF_CERTS_URL };
