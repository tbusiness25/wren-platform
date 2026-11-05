'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b210 — Google Workspace OIDC for staff sign-in (Roost + Seed only).
// b233 — GENERALISED, NOT FORKED. Every function below is now a thin binding of
//        src/lib/oidc-core.js to the `google` entry in its provider registry.
//
// Nothing about this module's contract changed: the same names, the same
// arguments, the same return shapes, the same refusals. src/routes/auth-google.js
// and scripts/b210-google-sso-selftest.js require this file exactly as they did
// and are untouched. What changed is that the implementation is shared with
// Wren's own identity provider (Authentik) instead of being copied for it —
// see wren-docs/decisions/2026-08-26-authentik-own-idp.md.
//
// This module does the *verification*. It deliberately contains no Express and
// no database access, so the exact code the HTTP route runs can also be driven
// straight from a test harness (scripts/b210-google-sso-selftest.js).
//
// What it is NOT:
//   • It is not the Gmail service account. GOOGLE_SA_KEY is domain-wide
//     delegation for server-to-server mail and can impersonate any mailbox in
//     the domain — using it to "log a human in" would mean anyone who can hit
//     the endpoint is every member of staff. Nothing here touches it.
//   • It never mints, grants or implies a role. It answers one question:
//     "which verified Google identity is this?" Authority stays in Wren's own
//     tables.
//
// WHERE THE CHECKS LIVE NOW: src/lib/oidc-core.js. Grepping THIS file for
// "jwks" finds only this comment. That is not evidence the checks are absent —
// that conclusion was drawn once already, in the 2026-08-21 review, and it was
// wrong. verifyIdToken() below calls straight into the core, which does the
// RS256/JWKS signature check, the alg pin, iss, aud, exp and nonce.
// ─────────────────────────────────────────────────────────────────────────────
const core = require('./oidc-core');

const GOOGLE = core.PROVIDERS.google;
const DEFAULT_DOMAIN = core.DEFAULT_DOMAIN;

// Google's endpoints stay exported by name because b210's tests and comments
// reference them. They are the same constants, read from the provider entry.
const GOOGLE_AUTH_URL  = GOOGLE.authUrl;
const GOOGLE_TOKEN_URL = GOOGLE.tokenUrl;
const GOOGLE_JWKS_URL  = GOOGLE.jwksUrl;
const GOOGLE_ISSUERS   = GOOGLE.issuers;

// Google is a static-endpoint provider, so its endpoint set is fixed and needs
// no discovery round-trip. Built once here and handed to the core on each call.
const GOOGLE_ENDPOINTS = {
  authUrl: GOOGLE_AUTH_URL,
  tokenUrl: GOOGLE_TOKEN_URL,
  jwksUrl: GOOGLE_JWKS_URL,
  issuers: GOOGLE_ISSUERS,
};

/**
 * ssoConfig — read the Google SSO configuration from the environment.
 * SSO is OFF unless BOTH halves of a real OAuth web-application client are
 * present. There is no default, no fallback and no stub: an unconfigured
 * install simply does not offer the button.
 */
function ssoConfig() {
  const cfg = core.providerConfig('google');
  return {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    domain: cfg.domain,
    configured: cfg.configured,
    killed: cfg.killed,
    enabled: cfg.enabled,
  };
}

/** The exact redirect_uri for this request's host. */
function redirectUriFor(req) {
  return core.redirectUriFor('google', req);
}

/** The Google authorization endpoint URL to redirect the browser to. */
function buildAuthUrl(opts) {
  return core.buildAuthUrl('google', Object.assign({ endpoints: GOOGLE_ENDPOINTS }, opts));
}

/** Swap the authorization code for an ID token at Google's token endpoint. */
function exchangeCode(opts) {
  return core.exchangeCode('google', Object.assign({ endpoints: GOOGLE_ENDPOINTS }, opts));
}

/** Full RFC-compliant check of a Google ID token — see oidc-core.verifyIdToken. */
function verifyIdToken(rawIdToken, { clientId, nonce } = {}) {
  return core.verifyIdToken(rawIdToken, { endpoints: GOOGLE_ENDPOINTS, clientId, nonce });
}

/** The Workspace-domain + verified-email gate, applied to the VERIFIED payload. */
function checkIdentityClaims(payload, domain) {
  return core.checkIdentityClaims('google', payload, domain);
}

// ── Test seam ────────────────────────────────────────────────────────────────
// Signature preserved from b210: the harness calls __setJwksForTest(keys) with
// no URL. Pins the cache entry for Google's JWKS URL specifically, so a pinned
// test key set can never be served for any other provider.
function __setJwksForTest(keys) {
  core.__setJwksForTest(GOOGLE_JWKS_URL, keys);
}

module.exports = {
  ssoConfig,
  redirectUriFor,
  pkcePair: core.pkcePair,
  randomToken: core.randomToken,
  sha256: core.sha256,
  safeEqual: core.safeEqual,
  buildAuthUrl,
  exchangeCode,
  verifyIdToken,
  checkIdentityClaims,
  DEFAULT_DOMAIN,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_JWKS_URL,
  GOOGLE_ISSUERS,
  __setJwksForTest,
};
