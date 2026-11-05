'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b233 — generic OIDC relying-party verifier, driven by a PROVIDER CONFIG.
//
// This is b210's src/lib/google-oidc.js generalised, not forked. Every check
// that file performed still happens here, on exactly the same code path;
// google-oidc.js is now a thin binding of this module to the `google` provider
// entry and keeps all of its old exports, so src/routes/auth-google.js and
// scripts/b210-google-sso-selftest.js are untouched and unbroken.
//
// Why generalise at all: wren-docs/decisions/2026-08-26-authentik-own-idp.md.
// Wren is standing up its OWN identity provider (Authentik) so that a nursery
// buying Wren does not need a Cloudflare account, and is not capped at 50 seats.
// Authentik speaks OIDC, so it is a second entry in PROVIDERS rather than a
// second copy of this file.
//
// WHAT THIS MODULE IS NOT:
//   • It never mints, grants or implies a role. It answers one question:
//     "which verified identity is this?" Authority stays in Wren's own tables.
//   • It touches no database and no Express — deliberately, so a test harness
//     can drive the exact code the HTTP route runs.
//   • It never touches GOOGLE_SA_KEY. That key holds domain-wide delegation and
//     could impersonate any mailbox in the domain; using it in a login path
//     would make anyone who can reach the endpoint into every member of staff.
//
// Signature verification follows the pattern proven in src/lib/cf-access-verify.js
// — fetch the provider's JWKS, turn the JWK into a PEM with node's own crypto,
// hand it to jsonwebtoken. No new dependency.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWKS_TTL_MS = 60 * 60 * 1000;      // 1h, same as the CF verifier
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h

const DEFAULT_DOMAIN = 'example-nursery.co.uk';

// ── Provider registry ────────────────────────────────────────────────────────
// A provider entry answers: where do I send the browser, where do I redeem the
// code, whose keys sign the ID token, and what must the resulting claims look
// like before Wren will even try to match a person to them.
//
// Two shapes:
//   • STATIC endpoints (Google). Hard-coded on purpose — an env-overridable
//     issuer or JWKS URL for a public provider is an authentication bypass
//     waiting to be misconfigured.
//   • DISCOVERED endpoints (Authentik). A self-hosted IdP has no fixed URL, so
//     its issuer HAS to be configuration. The mitigations are in
//     resolveEndpoints() below: https (or an explicitly-allowed private-address
//     http for dev), the discovery document's own `issuer` must equal the
//     configured issuer character for character, and every endpoint it names
//     must be same-origin as that issuer. A half-poisoned discovery document
//     therefore cannot point JWKS somewhere else.
const PROVIDERS = {
  google: {
    key: 'google',
    label: 'Google',
    discovery: false,
    authUrl:  'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    jwksUrl:  'https://www.googleapis.com/oauth2/v3/certs',
    // Google signs ID tokens with either spelling of the issuer.
    issuers:  ['https://accounts.google.com', 'accounts.google.com'],
    scope: 'openid email profile',
    // We only ever want an identity assertion — no refresh token, nothing to
    // store, nothing to leak.
    extraAuthParams: {
      access_type: 'online',
      prompt: 'select_account',
      include_granted_scopes: 'false',
    },
    // `hd` narrows Google's own account chooser to the Workspace domain. It is
    // a UX hint a client can strip, which is exactly why the claim is re-checked
    // server-side in checkIdentityClaims().
    sendHdParam: true,
    claims: {
      // A consumer @gmail.com account has no `hd` at all, so requiring it is
      // what keeps "any Google account on earth" out.
      requireWorkspaceDomain: true,
      // Google publishes email_verified on every account. Absent means something
      // is wrong, so absent is a refusal.
      emailVerified: 'required',
    },
    env: {
      clientId: 'GOOGLE_OAUTH_CLIENT_ID',
      clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
      redirectBase: 'GOOGLE_OAUTH_REDIRECT_BASE',
      killSwitch: 'WREN_GOOGLE_SSO',
      domain: 'WREN_SSO_DOMAIN',
    },
    callbackPath: '/api/auth/google/callback',
  },

  authentik: {
    key: 'authentik',
    label: 'Wren ID',
    discovery: true,
    // Filled in at runtime from the discovery document (see resolveEndpoints).
    authUrl: null,
    tokenUrl: null,
    jwksUrl: null,
    issuers: null,
    scope: 'openid email profile',
    extraAuthParams: {},
    sendHdParam: false,
    claims: {
      // Authentik is OUR OWN directory. The address in it is the one a manager
      // put there, so there is no third-party domain to gate on — and gating on
      // one would lock out every parent, who all use personal addresses. The
      // real gate is downstream: the address must already exist as an ACTIVE
      // ladn.staff / ladn.parent_portal_access row.
      requireWorkspaceDomain: false,
      // Authentik does emit email_verified, but versions differ on whether it
      // appears without the `email` scope being explicitly mapped. Absent is
      // tolerated; present-and-false is a refusal — we never silently accept an
      // identity our own IdP is telling us it does not vouch for.
      emailVerified: 'if_present',
    },
    env: {
      issuer: 'WREN_OIDC_ISSUER',
      clientId: 'WREN_OIDC_CLIENT_ID',
      clientSecret: 'WREN_OIDC_CLIENT_SECRET',
      redirectBase: 'WREN_OIDC_REDIRECT_BASE',
      killSwitch: 'WREN_OIDC_SSO',
      allowInsecureIssuer: 'WREN_OIDC_ALLOW_INSECURE_ISSUER',
    },
    callbackPath: '/api/auth/oidc/callback',
  },
};

function getProvider(key) {
  const p = PROVIDERS[key];
  if (!p) throw new Error(`unknown oidc provider: ${key}`);
  return p;
}

// ── Config ───────────────────────────────────────────────────────────────────
/**
 * providerConfig — read one provider's configuration from the environment.
 *
 * SSO for a provider is OFF unless every part of a real OAuth client is
 * present. There is no default, no fallback and no stub: an unconfigured
 * install simply does not offer the button. Fail-closed on purpose.
 */
function providerConfig(key) {
  const p = getProvider(key);
  const env = p.env;
  const clientId = (process.env[env.clientId] || '').trim();
  const clientSecret = (process.env[env.clientSecret] || '').trim();
  const killed = String(process.env[env.killSwitch] || '').trim().toLowerCase() === 'off';
  const domain = (process.env[env.domain] ? process.env[env.domain] : DEFAULT_DOMAIN)
    .trim().toLowerCase();

  let issuer = null;
  let issuerOk = true;
  let issuerReason = null;
  if (p.discovery) {
    issuer = (process.env[env.issuer] || '').trim().replace(/\/+$/, '');
    const allowInsecure = String(process.env[env.allowInsecureIssuer] || '').trim().toLowerCase() === 'true';
    const check = validateIssuerUrl(issuer, allowInsecure);
    issuerOk = check.ok;
    issuerReason = check.reason;
  }

  const configured = !!(clientId && clientSecret) && issuerOk && (!p.discovery || !!issuer);
  return {
    provider: p.key,
    label: p.label,
    clientId,
    clientSecret,
    issuer,
    domain,
    configured,
    killed,
    enabled: configured && !killed,
    // Distinguishes "nobody has created the OAuth client yet" from "switched
    // off" from "the issuer URL is not one we will talk to", so diagnostics are
    // unambiguous. No secret is implied by any of them.
    reason: killed ? 'disabled_by_env'
      : !clientId || !clientSecret ? 'not_configured'
        : p.discovery && !issuer ? 'no_issuer'
          : !issuerOk ? `bad_issuer:${issuerReason}`
            : null,
  };
}

/**
 * validateIssuerUrl — the guard on the one piece of a discovered provider's
 * configuration that is env-controlled.
 *
 * https is required, because an ID token fetched over plain http can be swapped
 * in flight by anything on the path. The single exception is a loopback or
 * RFC1918 address with WREN_OIDC_ALLOW_INSECURE_ISSUER=true, which is how the
 * dev container talks to Authentik on this box before there is a certificate.
 * That flag is a explicit opt-in and is never set in production.
 */
function validateIssuerUrl(raw, allowInsecure) {
  if (!raw) return { ok: false, reason: 'empty' };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'unparseable' }; }
  if (u.protocol === 'https:') return { ok: true, reason: null };
  if (u.protocol !== 'http:') return { ok: false, reason: 'scheme' };
  if (!allowInsecure) return { ok: false, reason: 'http_not_allowed' };
  const h = u.hostname;
  const isPrivate =
    h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || // Tailscale CGNAT range
    /^host\.docker\.internal$/.test(h) ||
    /^authentik-server$/.test(h);
  return isPrivate ? { ok: true, reason: null } : { ok: false, reason: 'http_public_host' };
}

/**
 * redirectUriFor — the exact redirect_uri for this request's host.
 * Must match a URI registered at the provider character for character; the
 * provider itself rejects anything else, so a spoofed Host header gets an error
 * from the provider rather than a login. We additionally pin the URI into the
 * login session and re-check it at callback time.
 */
function redirectUriFor(key, req) {
  const p = getProvider(key);
  const override = (process.env[p.env.redirectBase] || '').trim().replace(/\/+$/, '');
  if (override) {
    // 2026-10-20: the override pinned EVERY portal's callback to one host (it was set to the parents
    // portal), so a Wren ID login started on Roost/HR came back to parents and 404'd. Keep the override's
    // scheme, but use the portal's own host when it is a sibling under the same domain. Anything else
    // (an unexpected Host header) keeps the override, and the IdP still enforces its registered URIs.
    try {
      const o = new URL(override);
      const host = String((req.get ? req.get('host') : req.headers && req.headers.host) || '').toLowerCase().split(':')[0];
      const base = o.hostname.split('.').slice(1).join('.');
      if (host && base && host !== o.hostname && host.endsWith('.' + base) && /^[a-z0-9.-]+$/.test(host)) {
        return `${o.protocol}//${host}${p.callbackPath}`;
      }
    } catch (_) { /* malformed override: fall through to it unchanged */ }
    return `${override}${p.callbackPath}`;
  }
  const proto = req.protocol || 'https';
  const host = req.get ? req.get('host') : req.headers.host;
  return `${proto}://${host}${p.callbackPath}`;
}

// ── PKCE + one-time secrets ──────────────────────────────────────────────────
function pkcePair() {
  // 48 random bytes → 64 base64url chars, inside RFC 7636's 43–128.
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time compare for opaque tokens of equal expected length. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── Discovery ────────────────────────────────────────────────────────────────
const _discoveryCache = new Map(); // issuer → { at, endpoints }

function __clearDiscoveryCache() { _discoveryCache.clear(); }

/**
 * resolveEndpoints — the concrete auth/token/JWKS URLs for a provider.
 *
 * Static providers return their hard-coded set. Discovered providers fetch
 * <issuer>/.well-known/openid-configuration and then REFUSE it unless:
 *   • the document's own `issuer` equals the configured issuer exactly, and
 *   • authorization_endpoint / token_endpoint / jwks_uri are all same-origin
 *     with that issuer.
 * Both matter. Without the first, anything that can answer on the configured
 * host can claim to be a different issuer. Without the second, a document that
 * is genuinely served by our IdP but has been tampered with in one field could
 * send us to fetch signing keys from an attacker, and every subsequent
 * signature check would pass against the wrong keys.
 */
async function resolveEndpoints(key, cfg) {
  const p = getProvider(key);
  if (!p.discovery) {
    return { ok: true, endpoints: { authUrl: p.authUrl, tokenUrl: p.tokenUrl, jwksUrl: p.jwksUrl, issuers: p.issuers } };
  }
  const issuer = (cfg && cfg.issuer) || '';
  if (!issuer) return { ok: false, reason: 'no_issuer' };

  const cached = _discoveryCache.get(issuer);
  if (cached && (Date.now() - cached.at) < DISCOVERY_TTL_MS) {
    return { ok: true, endpoints: cached.endpoints };
  }

  let doc;
  try {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(6000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, reason: `discovery_http_${res.status}` };
    doc = await res.json();
  } catch {
    return { ok: false, reason: 'discovery_unreachable' };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'discovery_bad_json' };

  // The document must claim to be the issuer we asked for. Trailing slashes are
  // the one difference we forgive, because IdPs are inconsistent about them.
  const docIssuer = String(doc.issuer || '').replace(/\/+$/, '');
  if (docIssuer !== issuer) return { ok: false, reason: 'discovery_issuer_mismatch' };

  const need = ['authorization_endpoint', 'token_endpoint', 'jwks_uri'];
  for (const k of need) {
    if (!doc[k] || typeof doc[k] !== 'string') return { ok: false, reason: `discovery_missing_${k}` };
  }

  let base;
  try { base = new URL(issuer); } catch { return { ok: false, reason: 'discovery_bad_issuer' }; }
  for (const k of need) {
    let u;
    try { u = new URL(doc[k]); } catch { return { ok: false, reason: `discovery_bad_${k}` }; }
    if (u.origin !== base.origin) return { ok: false, reason: `discovery_offsite_${k}` };
  }

  const endpoints = {
    authUrl: doc.authorization_endpoint,
    tokenUrl: doc.token_endpoint,
    jwksUrl: doc.jwks_uri,
    // An OIDC ID token's `iss` must equal the discovery document's `issuer`.
    // Both spellings are accepted because that is the ONE difference forgiven
    // above: Authentik publishes `issuer` with a trailing slash and puts the
    // same string in the `iss` claim, so comparing only against the stripped
    // form refuses every genuine token. Verified live — this exact mismatch
    // failed the first end-to-end sign-in on dev. Nothing else about the
    // issuer is forgiven: a different host, scheme or path is still refused.
    issuers: Array.from(new Set([docIssuer, `${docIssuer}/`, String(doc.issuer)])),
  };
  _discoveryCache.set(issuer, { at: Date.now(), endpoints });
  return { ok: true, endpoints };
}

// ── Authorization request ────────────────────────────────────────────────────
function buildAuthUrl(key, { endpoints, clientId, redirectUri, state, nonce, codeChallenge, domain, loginHint }) {
  const p = getProvider(key);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scope,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  for (const [k, v] of Object.entries(p.extraAuthParams || {})) params.set(k, v);
  if (p.sendHdParam && domain) params.set('hd', domain);
  if (loginHint) params.set('login_hint', loginHint);
  return `${endpoints.authUrl}?${params.toString()}`;
}

// ── Code → ID token ──────────────────────────────────────────────────────────
/**
 * exchangeCode — swap the authorization code for an ID token at the provider's
 * token endpoint. The client secret is sent here and nowhere else; neither it
 * nor the returned tokens are ever logged or persisted.
 */
async function exchangeCode(key, { endpoints, code, codeVerifier, redirectUri, clientId, clientSecret }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });
  let res;
  try {
    res = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return { ok: false, reason: 'token_endpoint_unreachable' };
  }
  let payload;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, reason: 'token_endpoint_bad_json' };
  }
  if (!res.ok) {
    // payload.error is the provider's short code ('invalid_grant' etc). Safe to
    // keep — it carries no token material.
    return { ok: false, reason: `token_exchange_failed:${payload && payload.error ? payload.error : res.status}` };
  }
  if (!payload || !payload.id_token) return { ok: false, reason: 'no_id_token' };
  return { ok: true, idToken: payload.id_token };
}

// ── JWKS ─────────────────────────────────────────────────────────────────────
// Keyed by JWKS URL so two providers cannot poison each other's key set.
const _jwksCache = new Map(); // jwksUrl → { at, keys, pinned }

async function _getJwks(jwksUrl) {
  const now = Date.now();
  const hit = _jwksCache.get(jwksUrl);
  if (hit && (hit.pinned || (now - hit.at) < JWKS_TTL_MS)) return hit.keys;
  const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`jwks fetch failed: HTTP ${res.status}`);
  const jwks = await res.json();
  if (!Array.isArray(jwks && jwks.keys) || !jwks.keys.length) throw new Error('jwks: no keys in response');
  _jwksCache.set(jwksUrl, { at: now, keys: jwks.keys, pinned: false });
  return jwks.keys;
}

function _jwkToPem(jwk) {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
}

// ── ID token verification ────────────────────────────────────────────────────
/**
 * verifyIdToken — full RFC-compliant check of an ID token.
 *   • RS256 signature against the provider's published JWKS (fails CLOSED)
 *   • alg pinned, so an HS256 alg-confusion token is refused
 *   • iss is the provider's issuer
 *   • aud is *our* OAuth client (a token minted for any other app is refused)
 *   • exp / iat within tolerance
 *   • nonce matches the one bound to this login session (replay defence)
 *
 * Returns { ok: true, payload } or { ok: false, reason }.
 */
async function verifyIdToken(rawIdToken, { endpoints, clientId, nonce }) {
  if (!rawIdToken) return { ok: false, reason: 'no_id_token' };
  if (!clientId) return { ok: false, reason: 'no_client_id' };
  if (!endpoints || !endpoints.jwksUrl) return { ok: false, reason: 'no_jwks_url' };

  let header;
  try {
    header = JSON.parse(Buffer.from(String(rawIdToken).split('.')[0], 'base64url').toString());
  } catch {
    return { ok: false, reason: 'bad_jwt_format' };
  }
  if (header.alg !== 'RS256') return { ok: false, reason: 'unexpected_alg' };

  let keys;
  try {
    keys = await _getJwks(endpoints.jwksUrl);
  } catch (e) {
    return { ok: false, reason: 'jwks_fetch_failed' };
  }

  const match = keys.find((k) => k.kid === header.kid);
  // Fall back to trying every key so an unannounced key rotation is a slow
  // verify, not an outage. The signature still has to check out.
  const candidates = match ? [match] : keys;

  let payload = null;
  let lastErr = 'signature_verify_failed';
  for (const jwk of candidates) {
    try {
      payload = jwt.verify(rawIdToken, _jwkToPem(jwk), {
        algorithms: ['RS256'],
        audience: clientId,
        issuer: endpoints.issuers,
        clockTolerance: 30,
      });
      break;
    } catch (e) {
      lastErr = e && e.name === 'TokenExpiredError' ? 'id_token_expired'
        : e && e.name === 'JsonWebTokenError' && /audience/i.test(e.message) ? 'aud_mismatch'
          : e && e.name === 'JsonWebTokenError' && /issuer/i.test(e.message) ? 'iss_mismatch'
            : 'signature_verify_failed';
    }
  }
  if (!payload) return { ok: false, reason: lastErr };

  // Nonce binds this ID token to the authorization request WE started.
  if (!nonce) return { ok: false, reason: 'no_session_nonce' };
  if (!payload.nonce || !safeEqual(payload.nonce, nonce)) return { ok: false, reason: 'nonce_mismatch' };

  if (!payload.sub) return { ok: false, reason: 'no_sub_claim' };
  return { ok: true, payload };
}

/**
 * checkIdentityClaims — the identity gate, applied to the *verified* payload.
 *
 * For a public provider (Google) both halves of the domain check matter:
 *   • `hd` is the Workspace-domain claim Google puts on accounts that belong to
 *     a Workspace. A consumer @gmail.com account has no `hd` at all.
 *   • The email's own domain is checked too, because `hd` on the *request* is
 *     only a UI hint and must never be mistaken for a control.
 *
 * For our own IdP there is no domain to check — every parent has a personal
 * address — so the gate is the downstream match against ladn.staff /
 * ladn.parent_portal_access, which this module deliberately knows nothing about.
 */
function checkIdentityClaims(key, payload, domain) {
  const p = getProvider(key);
  const policy = p.claims || {};
  const email = String(payload.email || '').toLowerCase().trim();
  if (!email) return { ok: false, reason: 'no_email_claim', email: null };

  const hasVerified = Object.prototype.hasOwnProperty.call(payload, 'email_verified');
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (policy.emailVerified === 'required' && !verified) {
    return { ok: false, reason: 'email_not_verified', email };
  }
  if (policy.emailVerified === 'if_present' && hasVerified && !verified) {
    return { ok: false, reason: 'email_not_verified', email };
  }

  const hd = String(payload.hd || '').toLowerCase().trim();
  if (policy.requireWorkspaceDomain) {
    const wanted = String(domain || '').toLowerCase();
    if (!hd) return { ok: false, reason: 'not_a_workspace_account', email };
    if (hd !== wanted) return { ok: false, reason: 'wrong_workspace_domain', email };
    const emailDomain = email.split('@')[1] || '';
    if (emailDomain !== wanted) return { ok: false, reason: 'wrong_email_domain', email };
  }

  return {
    ok: true,
    email,
    sub: String(payload.sub),
    hd: hd || null,
    name: payload.name || payload.preferred_username || null,
    groups: Array.isArray(payload.groups) ? payload.groups.map(String) : [],
  };
}

// ── Test seam ────────────────────────────────────────────────────────────────
// Used ONLY by the self-test harnesses, which sign tokens with a throwaway key
// so the real verifier can be driven through every reject path without a live
// provider. Not reachable from any request path and not switchable by an
// environment variable.
function __setJwksForTest(jwksUrl, keys) {
  _jwksCache.set(jwksUrl, { at: Date.now(), keys, pinned: true });
}

module.exports = {
  PROVIDERS,
  getProvider,
  providerConfig,
  validateIssuerUrl,
  redirectUriFor,
  resolveEndpoints,
  pkcePair,
  randomToken,
  sha256,
  safeEqual,
  buildAuthUrl,
  exchangeCode,
  verifyIdToken,
  checkIdentityClaims,
  DEFAULT_DOMAIN,
  __setJwksForTest,
  __clearDiscoveryCache,
};
