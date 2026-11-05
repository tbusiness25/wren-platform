// @ts-check  (b508, 2026-10-18) — this file is type-checked. jsconfig.json has
// checkJs:false, so only files carrying this comment are checked; see jsconfig.json
// for how to run it. Keep it passing, or take the comment off deliberately.
// NOTE: this comment must stay the FIRST thing in the file — above 'use strict' —
// or TypeScript ignores it and the file is silently not checked.
'use strict';
/**
 * media-url.js — b491 (2026-10-12, security hardening item 3).
 *
 * Short-lived HMAC-signed URLs for child/staff photos and other media that has
 * to be loaded via a plain <img>/<video>/<a> tag — which cannot carry an
 * Authorization header, hence the pre-existing `?token=<raw session JWT>`
 * fallback this replaces. A raw session JWT is long-lived (12h) and, pasted
 * into a URL, ends up in browser history, server access logs and Referer
 * headers; it is also a GENERAL-PURPOSE credential, so a route that only
 * checks the Authorization header (several did — release CHECK.md finding F1)
 * could be walked straight past by sending the same JWT as a query param
 * instead. A media-url signature is neither: it is scoped to one exact path,
 * expires in minutes, and is signed with a key (`MEDIA_URL_KEY`) that has no
 * other use — it cannot be replayed anywhere else in the app.
 *
 * Key source is deliberately NOT JWT_SECRET (see this build's NOTES.md item 8
 * — JWT_SECRET is already overloaded as a key root for several unrelated
 * things, which is exactly the problem item 8 is about). `MEDIA_URL_KEY` is
 * its own dedicated secret.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const MAX_TTL_SECONDS = 600; // the brief's ceiling — 10 minutes

function _key() {
  const k = process.env.MEDIA_URL_KEY;
  if (!k) throw new Error('media-url: MEDIA_URL_KEY is not set');
  return k;
}

function _sig(pathOnly, uid, portal, exp) {
  return crypto.createHmac('sha256', _key()).update(`${pathOnly}|${uid}|${portal}|${exp}`).digest('hex');
}

/**
 * Sign a bare path (e.g. '/uploads/child-photos/123.jpg' or
 * '/api/observations/photo/obs_xyz.jpg') for one subject on one portal.
 * `uid` is the staff id, or 0 for a parent token (parents all carry id:0 —
 * see src/routes/auth.js parent-login/cf-auto-login). The caller must already
 * have decided this subject is allowed to see this exact path BEFORE calling
 * sign() — the signature proves the URL came from that decision, not who is
 * holding it.
 */
function sign(pathOnly, { uid, portal }, ttlSeconds = MAX_TTL_SECONDS) {
  if (uid == null || !portal) throw new Error('media-url.sign: uid and portal are required');
  const ttl = Math.max(1, Math.min(Number(ttlSeconds) || MAX_TTL_SECONDS, MAX_TTL_SECONDS));
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = _sig(pathOnly, uid, portal, exp);
  const sep = pathOnly.includes('?') ? '&' : '?';
  return `${pathOnly}${sep}uid=${encodeURIComponent(uid)}&p=${encodeURIComponent(portal)}&exp=${exp}&sig=${sig}`;
}

/**
 * Verify an incoming request against its OWN path — never trust a path the
 * caller supplies, always recompute from the live request (req.originalUrl,
 * so it matches whatever sign() was given at mint time, including any mount
 * prefix). Returns {ok:true, uid, portal} or {ok:false, reason}.
 */
function verify(req) {
  const { uid, p, exp, sig } = req.query || {};
  if (uid == null || !p || !exp || !sig) return { ok: false, reason: 'missing_params' };
  const expNum = parseInt(exp, 10);
  if (!Number.isFinite(expNum)) return { ok: false, reason: 'missing_params' };
  if (Math.floor(Date.now() / 1000) > expNum) return { ok: false, reason: 'expired' };
  if (p !== (req._portal || '')) return { ok: false, reason: 'portal_mismatch' };
  const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
  let expected;
  try { expected = _sig(pathOnly, uid, p, expNum); } catch (e) { return { ok: false, reason: 'no_key' }; }
  let a, b;
  try { a = Buffer.from(String(sig), 'hex'); b = Buffer.from(expected, 'hex'); } catch { return { ok: false, reason: 'bad_signature' }; }
  if (a.length !== b.length || a.length === 0 || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, uid: String(uid), portal: p };
}

function _mediaKey() {
  const k = process.env.MEDIA_URL_KEY;
  if (!k) throw new Error('media-url: MEDIA_URL_KEY is not set');
  return k;
}

/**
 * observations.js/incidents.js/setting-incidents.js/messages.js's photo/
 * attachment routes carry real per-request authorisation logic beyond "is
 * this signature valid" — a parent's withdrawn-consent and watermarking
 * checks run on EVERY fetch, reading `decoded.role`/`decoded.child_id(s)`
 * from what today is the full 12h session JWT passed as `?token=`. Replacing
 * that with the plain path-bound HMAC above would mean reinventing all of
 * that logic. Instead this re-signs the SAME shape of claims the session
 * token already carries, but with MEDIA_URL_KEY (not JWT_SECRET) and a ≤10
 * minute expiry — every existing `decoded.whatever` read downstream keeps
 * working untouched, while the token can never be replayed as a normal
 * Bearer session anywhere else (it won't verify against JWT_SECRET) and
 * expires in minutes instead of hours. This is NOT bound to one exact path
 * the way sign()/verify() above are — it authorises "this request, from this
 * identity, for a few minutes", and the per-request ownership checks in each
 * of those four routes are what actually scope it to one file, exactly as
 * they already scope the long-lived JWT today.
 */
function signSessionToken(claims, ttlSeconds = MAX_TTL_SECONDS) {
  const ttl = Math.max(1, Math.min(Number(ttlSeconds) || MAX_TTL_SECONDS, MAX_TTL_SECONDS));
  // jwt.sign throws if a reserved claim (iat/exp/aud) is in BOTH the payload
  // and the options — iat/exp come from the original session token (spread
  // in by the caller) and aud is set via the `audience` option below instead.
  const { iat, exp, aud, ...rest } = claims || {};
  return jwt.sign(rest, _mediaKey(), { expiresIn: ttl, audience: aud });
}
function verifySessionToken(token, expectedAud) {
  try {
    const decoded = jwt.verify(token, _mediaKey());
    if (expectedAud && decoded.aud !== expectedAud) return null;
    return decoded;
  } catch { return null; }
}

// Paths using the simple path-bound HMAC scheme (sign/verify) — no per-request
// re-authorisation logic downstream, so binding the signature to the exact
// path is the whole security boundary.
const HMAC_PATH_RE = /^\/uploads\/(child-photos|staff-photos)\/[^/?]+$/;
// Paths using the session-shaped short-lived JWT scheme (signSessionToken/
// verifySessionToken) — these routes re-check ownership/consent/withdrawal
// per request, so the token only needs to prove identity + recency.
const SESSION_TOKEN_PATH_RE = /^\/api\/(observations\/photo|incidents\/photo|setting-incidents\/photo|messages\/attachment)\/.+$/;
// Union — "is this path one of ours at all" (used by the global signer to
// decide whether to even look at a string).
const MEDIA_PATH_RE = new RegExp(`(?:${HMAC_PATH_RE.source})|(?:${SESSION_TOKEN_PATH_RE.source})`);

module.exports = {
  sign, verify, signSessionToken, verifySessionToken,
  MAX_TTL_SECONDS, MEDIA_PATH_RE, HMAC_PATH_RE, SESSION_TOKEN_PATH_RE,
};
