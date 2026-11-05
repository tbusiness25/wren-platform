'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b239 — the ONE place a parent's identity is decided.
//
// WHY THIS FILE EXISTS
//   Cloudflare Access is currently *doing* the parent login, not merely gating
//   it: 0 of 82 active parent_portal_access rows carry a credential, and 77
//   endpoints resolve "which parent is this" from a Cloudflare header. The full
//   list, generated rather than typed, is logs/b239-parent-identity-routes.md —
//   read it before changing anything here. 38 of those endpoints never pass
//   through the 2026-07-21 signature gate at all; today they are protected only
//   by CF Access refusing the request at its edge, which is precisely what the
//   cutover takes away.
//
//   So identity has to stop being "a header a handler happens to read" and
//   become one function with one answer.
//
// THE ORDER, AND WHY IT IS THIS WAY ROUND
//   1. A Wren-minted parent JWT (`aud` = the parents portal, `role` = parent).
//   2. Failing that, the Cloudflare assertion — but ONLY while
//      PARENT_CF_JWT_ENFORCE is still on.
//   JWT first so that the moment a parent has a real Wren credential, that is
//   what authenticates them, and CF becomes a fallback that can be switched off
//   underneath them without a second code change. Roll-forward and rollback are
//   then the same lever, which is what makes the five-minute rollback in
//   wren-docs/decisions/2026-08-27-parent-login-cutover.md actually true.
//
// FAIL CLOSED — the whole point.
//   No identity is 401. Not "any parent", not a demo constant, not an address
//   the caller supplied in a query string. Three endpoints did exactly those
//   things before this build (marked `!` in the enumerator's output).
//
// WHAT THIS FILE DOES NOT DO
//   It never creates a parent_portal_access row, never grants access to a child,
//   and never widens a scope. It answers "which existing, active parent is
//   this?" and nothing else. Child scope stays where it already is: re-read at
//   use time by the handler, so a child who left between login and request is
//   not in the answer.
// ─────────────────────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
let { verifyCfAccessJwt } = require('./cf-access-verify');

// ── Test seam ────────────────────────────────────────────────────────────────
// Used ONLY by scripts/b239-parent-auth-probe.js, which has to drive the CF arm
// on a box that has no Cloudflare in front of it. It swaps the verifier for one
// that accepts a known-good assertion, so the probe exercises the REAL resolver
// — the ordering, the confirmation query, the fail-closed branches — rather than
// a copy of it. Not reachable from any request path and not switchable by an
// environment variable; the same pattern as oidc-core.js's __setJwksForTest.
function __setCfVerifierForTest(fn) { verifyCfAccessJwt = fn; }
const { getPool } = require('../db/pool');

// The audience claim on a parent token. cf-auto-login, /parent-login and the
// OIDC /exchange all mint with `audience: req._portal || 'parents'`, and the
// parents portal sets _portal='parents' — so this is the one accepted value.
// Pinning it is what stops a staff token, or a token minted for Roost, being
// replayed as a parent on this portal.
const PARENT_AUDIENCE = 'parents';

// ── The parent session cookie, and why it had to exist ───────────────────────
// The parents portal front-end does not send a bearer token. Every gated page
// fetches with `credentials:'include'` and nothing else — the Cloudflare Access
// cookie IS the credential, on all ~40 of them. A handful of pages mint a JWT
// on demand via /api/auth/cf-auto-login for one specific call and then drop it.
//
// So "accept a Wren JWT instead of the CF assertion" is not reachable from a
// browser until Wren sets a cookie of its own. Without this, cutover day would
// have meant editing forty HTML files to attach an Authorization header — and
// any one of them missed is a parent staring at an empty diary.
//
// Same token, same claims, same expiry as the bearer one; only the transport is
// new. HttpOnly so script cannot read it. SameSite=Lax is the CSRF control: a
// cross-site POST does not carry a Lax cookie, which is what makes cookie-borne
// auth safe on the state-changing routes here. `secure` follows the real scheme
// so the flow is testable on plain-HTTP dev :3015 and is always Secure behind
// nginx/Cloudflare.
const PARENT_COOKIE = 'wren_parent';
const PARENT_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // matches the JWT's 30d

function setParentSessionCookie(req, res, token) {
  res.cookie(PARENT_COOKIE, token, {
    httpOnly: true,
    secure: req.secure === true,
    sameSite: 'Lax',
    maxAge: PARENT_COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

function clearParentSessionCookie(res) {
  res.clearCookie(PARENT_COOKIE, { path: '/' });
}

// Confirming an identity against the register costs a query. Parents click
// through several endpoints per page, so the answer is cached briefly. Short
// enough that deactivating a parent takes effect within a minute; long enough
// that one page load is one query. Keyed by email; holds no personal data
// beyond the address that was already in the request.
const CONFIRM_TTL_MS = 30 * 1000;
const _confirmCache = new Map();

function cfEnforced() {
  return process.env.PARENT_CF_JWT_ENFORCE !== 'false';
}

/** True once parents authenticate against Wren's own IdP rather than CF Access. */
function parentSsoEnabled() {
  return String(process.env.WREN_OIDC_PARENTS || '').trim().toLowerCase() === 'on';
}

// b320 — the "view as" cookie, read BEFORE the ordinary parent one.
//
// Its own name rather than overwriting `wren_parent`: if the manager happens to
// be a parent here too, their real thirty-day session survives the thirty
// minutes and is still there when they exit. Ordering it first is what makes
// "view as" win in a browser that holds both.
//
// This adds a source of identity; it removes no check. The token is one Wren
// minted, for this portal, with role 'parent' — fromWrenJwt below still
// verifies all three, and confirmParent still confirms the address against the
// register. Cloudflare Access is untouched: the manager passed it as
// themselves to reach the origin at all.
const VIEW_AS_COOKIE = 'wren_view_as';

function bearerOf(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const hdr = String(req.headers['x-wren-token'] || '').trim();
  if (hdr) return hdr;
  const viewAs = String((req.cookies && req.cookies[VIEW_AS_COOKIE]) || '').trim();
  if (viewAs) return viewAs;
  // …and finally the session cookie, which is how the existing parents portal
  // pages (which send no header at all) will authenticate after cutover.
  return String((req.cookies && req.cookies[PARENT_COOKIE]) || '').trim();
}

// ── Path 1: a Wren-minted parent JWT ─────────────────────────────────────────
/**
 * The token must be one WE minted, for THIS portal, for a parent. A staff token
 * is refused even though it verifies — same secret, different audience and role.
 */
function fromWrenJwt(req) {
  const raw = bearerOf(req);
  if (!raw) return { ok: false, reason: 'no_token' };
  let d;
  try {
    d = jwt.verify(raw, process.env.JWT_SECRET, { audience: PARENT_AUDIENCE });
  } catch (e) {
    return { ok: false, reason: e && e.name === 'TokenExpiredError' ? 'token_expired' : 'bad_token' };
  }
  if (!d || d.role !== 'parent') return { ok: false, reason: 'not_a_parent_token' };
  // cf-auto-login puts the address in `name`; /parent-login and the OIDC
  // exchange set `email` as well. Accept either, demand it look like an address.
  const email = String(d.email || d.name || '').toLowerCase().trim();
  if (!email || email.indexOf('@') === -1) return { ok: false, reason: 'no_email_claim' };
  return { ok: true, email, source: 'wren_jwt', claims: d };
}

// ── Path 2: the Cloudflare Access assertion ──────────────────────────────────
/**
 * The plaintext `cf-access-authenticated-user-email` header is NEVER trusted on
 * its own — it is a client-controlled string, and anything reaching this origin
 * without traversing Cloudflare's edge (the Tailscale mesh, dev port 3015,
 * `docker exec`) can set it to any value. It is only ever used as the claimed
 * identity that the signed assertion must then match.
 */
async function fromCfAssertion(req) {
  if (!cfEnforced()) return { ok: false, reason: 'cf_not_enforced' };
  const email = String(req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return { ok: false, reason: 'no_cf_header' };
  const rawAssertion = (
    req.headers['cf-access-jwt-assertion'] ||
    req.headers['cf-access-jwt'] ||
    (req.cookies && req.cookies.CF_Authorization) || ''
  ).toString().trim();
  const result = await verifyCfAccessJwt(rawAssertion, email);
  if (!result.ok) return { ok: false, reason: `cf_${result.reason}` };
  return { ok: true, email: result.email, source: 'cf_access' };
}

// ── Confirmation against the register ────────────────────────────────────────
/**
 * Does this verified address belong to a parent Wren actually knows?
 *
 * The union is deliberately the SAME one cf-auto-login and the OIDC exchange
 * use, and it has two arms for a reason:
 *   - an active parent_portal_access row (the normal case, and the only arm
 *     that covers a leaver still collecting their keepsake), OR
 *   - an active child carrying the address as parent_1/parent_2.
 * The second arm is what lets provisional / enquiry families (child
 * is_active=false) message the nursery before they start. Dropping it silently
 * locks them out, which is why it is written down here rather than inferred.
 */
async function confirmParent(db, email) {
  const now = Date.now();
  const hit = _confirmCache.get(email);
  if (hit && now - hit.at < CONFIRM_TTL_MS) return hit.value;

  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FROM parent_portal_access
         WHERE lower(email) = $1 AND is_active = true)::int AS access_rows,
       (SELECT count(*) FROM children
         WHERE (lower(parent_1_email) = $1 OR lower(parent_2_email) = $1)
           AND is_active = true)::int AS child_rows`,
    [email]
  );
  const r = rows[0] || { access_rows: 0, child_rows: 0 };
  const value = {
    known: (r.access_rows + r.child_rows) > 0,
    access_rows: r.access_rows,
    child_rows: r.child_rows,
  };
  _confirmCache.set(email, { at: now, value });
  return value;
}

/** Drop the confirmation cache (a parent was deactivated, a child enrolled). */
function invalidate(email) {
  if (email) _confirmCache.delete(String(email).toLowerCase().trim());
  else _confirmCache.clear();
}

// ── The resolver ─────────────────────────────────────────────────────────────
/**
 * resolveParentIdentity — the single answer to "which parent is this request?".
 *
 * @returns {Promise<{ok:true, email:string, source:'wren_jwt'|'cf_access'}
 *                 | {ok:false, reason:string}>}
 */
async function resolveParentIdentity(req, opts = {}) {
  const confirm = opts.confirm !== false;

  let ident = fromWrenJwt(req);
  const jwtReason = ident.reason;
  if (!ident.ok) {
    const cf = await fromCfAssertion(req);
    // Report the more informative failure. "Your token expired" is a better
    // answer than "there is no Cloudflare header" when the parent had a token.
    if (!cf.ok) {
      const reason = (jwtReason && jwtReason !== 'no_token') ? jwtReason : cf.reason;
      return { ok: false, reason };
    }
    ident = cf;
  }

  // b320: carry the view-as marker through so requireParentIdentity can hang it
  // on req.parent. Nothing downstream branches on it — the read-only refusal is
  // the guard's job — but the audit trail must never lose the second identity.
  const vas = (ident.claims && ident.claims.vas) ? {
    jti: ident.claims.vas,
    by: ident.claims.impersonated_by,
    by_name: ident.claims.impersonated_by_name || null,
  } : null;

  if (!confirm) return { ok: true, email: ident.email, source: ident.source, view_as: vas };

  let known;
  try {
    known = await confirmParent(opts.db || getPool(), ident.email);
  } catch (e) {
    // Could not look is not the same as not there. Refuse rather than admit.
    return { ok: false, reason: 'confirm_failed' };
  }
  if (!known.known) {
    // 2026-10-27 — a thirty-day Wren cookie outlives the address it was minted
    // for: once that address loses its access, the cookie would otherwise lock
    // the browser out even after the person signs in to Cloudflare as someone
    // Wren does know (Toby's phone, toby@ → his own address). The CF assertion
    // is signed and confirmed exactly as above, so this widens nothing.
    if (ident.source === 'wren_jwt' && !vas) {
      const cf = await fromCfAssertion(req);
      if (cf.ok && cf.email !== ident.email) {
        let k2;
        try { k2 = await confirmParent(opts.db || getPool(), cf.email); } catch (e) { return { ok: false, reason: 'confirm_failed' }; }
        if (k2.known) return { ok: true, email: cf.email, source: cf.source, view_as: null, stale_cookie: true };
      }
    }
    return { ok: false, reason: 'no_wren_account' };
  }

  return { ok: true, email: ident.email, source: ident.source, view_as: vas };
}

// ── Express middleware ───────────────────────────────────────────────────────
/**
 * requireParentIdentity — resolve, or 401. Sets `req.parent = { email, source }`.
 *
 * Idempotent: mounting it twice on the same request resolves once. That matters
 * because the portal-wide gate in server-unified.js runs it for /welcome/*, and
 * individual routers mount it too so they are safe wherever they are mounted.
 */
async function requireParentIdentity(req, res, next) {
  if (req.parent && req.parent.email) return next();
  const r = await resolveParentIdentity(req);
  if (!r.ok) {
    // The reason goes to the log, never to the caller — telling an anonymous
    // caller "that address is not one of ours" is an enumeration oracle.
    console.warn(`[parent-identity] 401 (${r.reason}) — ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ error: 'Unauthorised' });
  }
  req.parent = { email: r.email, source: r.source };
  if (r.stale_cookie) clearParentSessionCookie(res);
  if (r.view_as) {
    req.parent.view_as = r.view_as;
    req.viewAs = req.viewAs || { jti: r.view_as.jti, by: r.view_as.by, by_name: r.view_as.by_name };
  }
  return next();
}

/**
 * parentEmailOf — the address for a request that has already been through the
 * resolver. Deliberately reads NO header: a handler calling this cannot
 * accidentally re-introduce header trust. Returns '' when identity was never
 * established, which every caller must treat as "refuse".
 */
function parentEmailOf(req) {
  return (req.parent && req.parent.email) || '';
}

module.exports = {
  resolveParentIdentity,
  setParentSessionCookie,
  clearParentSessionCookie,
  PARENT_COOKIE,
  requireParentIdentity,
  parentEmailOf,
  confirmParent,
  invalidate,
  cfEnforced,
  parentSsoEnabled,
  fromWrenJwt,
  fromCfAssertion,
  VIEW_AS_COOKIE,
  PARENT_AUDIENCE,
  __setCfVerifierForTest,
};
