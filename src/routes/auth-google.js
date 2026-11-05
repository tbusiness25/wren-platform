'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b210 — "Sign in with Google" for staff, on Roost (admin) and Seed (hr) ONLY.
//
// Mounted at /api/auth/google from src/routes/auth.js (one added line there —
// the PIN login in that file is untouched and stays the primary path).
//
// SCOPE, deliberately narrow:
//   • Roost + Seed only. EY tablets keep PIN login: they are shared devices in
//     a room, where a 6-digit PIN is the correct control and an SSO session
//     would silently leave the last person signed in.
//   • Parents are not in the Workspace and are not touched here.
//   • This sits ALONGSIDE Cloudflare Access, which is not weakened by this
//     build. Whether CF Access later comes off the staff portals is a separate
//     decision with its own review.
//
// THE RULE THAT SHAPES EVERYTHING BELOW:
//   Google supplies identity. Wren supplies authority.
//   A verified Google account is only ever MATCHED to an existing, active
//   ladn.staff row by email. It can never create a staff record, never invent
//   a role, and never widen one. Role, scope and capabilities are read from
//   Wren's own tables exactly as they are for a PIN login, and the JWT minted
//   here is byte-for-byte the same shape with the same per-portal `aud`.
//
// Flow (Authorization Code + PKCE):
//   GET  /api/auth/google/start     → 302 to Google (state cookie + DB session)
//   GET  /api/auth/google/callback  → verify, resolve staff, 302 back with a
//                                     one-time hand-off code
//   POST /api/auth/google/exchange  → redeem the code for a Wren JWT
//
// The JWT is minted at /exchange, not at /callback, so no token is ever put in
// a URL, in browser history, or in a database row.
//
// WHERE THE SECURITY CONTROLS LIVE - read this before reviewing this file:
//   ID-token signature verification (Google JWKS), iss/aud/exp, nonce,
//   email_verified and the server-side domain re-check all live in
//   src/lib/google-oidc.js and are called from /callback below. They sit in
//   that module rather than inline here so the self-test can drive the
//   identical code path. A grep of THIS file alone for "jwks" or
//   "email_verified" finds nothing, and that is NOT evidence the checks are
//   absent - that conclusion was drawn once already, in the 2026-08-21 review,
//   and it was wrong. Evidence the checks work:
//   scripts/b210-google-sso-selftest.js refuses forged-key, alg-confusion,
//   wrong-aud, wrong-iss, expired, replayed-nonce and unverified-email tokens.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const oidc = require('../lib/google-oidc');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// Portals where SSO exists at all. Anything else — most importantly the EY
// portal ('learning') and the parents portal — 404s as though these routes had
// never been mounted.
const SSO_PORTALS = new Set(['admin', 'hr']);

// Roles that require TOTP when enrolled — mirrors src/routes/auth.js so an SSO
// login cannot be used to step around a second factor a PIN login enforces.

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];

const STATE_COOKIE = 'wren_sso_state';
const STATE_TTL_MS = 10 * 60 * 1000;   // authorization round-trip
const EXCHANGE_TTL_MS = 2 * 60 * 1000; // login page redeeming the hand-off code

// Crude DoS backstop only, deliberately set well above real use.
//
// It is keyed by IP, and the whole nursery leaves through ONE public IP — so a
// tight bucket here would repeat the bug Card #21 fixed for PIN login, where an
// IP-keyed limiter let one person's failures lock out everyone in the building.
// The actual anti-guessing control on /callback and /exchange is not this: it is
// that both consume a single-use 32-byte random token bound to a server-side
// session row, which is not guessable at any rate.
const ssoLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => (req.headers['cf-connecting-ip'] || req.ip || 'unknown').toString(),
  message: { error: 'Too many sign-in attempts, please try again shortly' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function portalOf(req) { return req._portal || 'learning'; }

function portalGuard(req, res, next) {
  if (!SSO_PORTALS.has(portalOf(req))) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

/**
 * Audit every attempt — success and failure — with the email tried and the
 * reason, into the existing audit_log via the shared recordAudit helper.
 * Never receives a token, a code or a secret.
 */
function auditSso(req, { success, reason, email, staffId, extra }) {
  recordAudit({
    req,
    action: 'login',
    entity_type: 'staff',
    entity_id: staffId || undefined,
    actor_type: success ? 'staff' : 'anonymous',
    actor_id: staffId || null,
    actor_email: email || null,
    meta: Object.assign({
      method: 'google_sso',
      portal: portalOf(req),
      success: !!success,
      reason: reason || null,
      email_tried: email || null,
    }, extra || {}),
  });
}

/** Cookies: Lax (not Strict) — the callback is a top-level cross-site redirect
 *  from Google, and a Strict cookie would simply not be sent. Secure follows
 *  the real scheme so the flow is testable on the plain-HTTP dev port while
 *  always being Secure behind nginx/Cloudflare in production. */
function setStateCookie(req, res, rawState) {
  res.cookie(STATE_COOKIE, rawState, {
    httpOnly: true,
    secure: req.secure === true,
    sameSite: 'Lax',
    maxAge: STATE_TTL_MS,
    path: '/api/auth/google',
  });
}

function clearStateCookie(res) {
  res.clearCookie(STATE_COOKIE, { path: '/api/auth/google' });
}

function loginPageFor(req) {
  return '/login.html';
}

function bounceToLogin(req, res, params) {
  const qs = new URLSearchParams(params).toString();
  return res.redirect(302, `${loginPageFor(req)}?${qs}`);
}

// A deliberately small, non-enumerating set of messages. Anything that would
// tell an anonymous caller whether a given address is staff here is collapsed
// into the same neutral text; the precise reason still goes to the audit log.
const FRIENDLY = {
  no_wren_account: 'There is no Wren account for that address — ask your manager to set one up.',
  account_inactive: 'There is no Wren account for that address — ask your manager to set one up.',
  ambiguous_account: 'That address matches more than one staff record. Ask your manager to sort it out.',
  link_revoked: 'Google sign-in has been turned off for this account. Sign in with your PIN, or ask your manager.',
  link_mismatch: 'This Google account does not match the one linked to your Wren account. Ask your manager to unlink it.',
  sub_bound_elsewhere: 'This Google account is already linked to a different staff record.',
  wrong_workspace_domain: '__DOMAIN__',
  not_a_workspace_account: '__DOMAIN__',
  wrong_email_domain: '__DOMAIN__',
  email_not_verified: 'That Google account has no verified email address.',
  sso_disabled: 'Google sign-in is not enabled on this site.',
  bad_state: 'That sign-in link expired or was already used. Please try again.',
  access_denied: 'Sign-in was cancelled.',
};
function friendly(reason) {
  const msg = FRIENDLY[reason];
  if (!msg) return 'Google sign-in failed. Please use your PIN, or try again.';
  if (msg === '__DOMAIN__') return `Use your @${oidc.ssoConfig().domain} work account.`;
  return msg;
}

/**
 * resolveStaffForGoogle — the whole authority decision, in one place.
 *
 * Takes an ALREADY-VERIFIED Google identity and answers: which ladn.staff row,
 * if any, is this person allowed to be? Exported so the self-test harness
 * drives the same code the HTTP callback runs.
 *
 * Never inserts into `staff`. The only row it may create is the identity
 * binding in staff_google_identities, which records *who signed in*, not what
 * they may do.
 *
 * b233 (2026-08-26): that table is now shared with Wren's own identity provider
 * (Authentik), keyed by (provider, …). Every statement below is scoped to
 * provider='google' — without that, one staff member holding both a Google and
 * a Wren ID binding would get whichever row the planner happened to return,
 * and revoking one would revoke both. Nothing else about this function changed.
 */
async function resolveStaffForGoogle(db, { email, sub, hd }) {
  const lower = String(email || '').toLowerCase().trim();
  if (!lower || !sub) return { ok: false, reason: 'no_identity' };

  // Match by email against staff we ALREADY have. Inactive rows are fetched
  // too, purely so we can tell "left the nursery" apart from "never existed"
  // in the audit log — both give the caller the same neutral message.
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, role, room_id, is_active, email,
            scope, scope_value, totp_verified
       FROM staff
      WHERE lower(email) = $1
      ORDER BY is_active DESC, id ASC`,
    [lower]
  );
  if (!rows.length) return { ok: false, reason: 'no_wren_account' };

  const active = rows.filter((r) => r.is_active === true);
  if (!active.length) return { ok: false, reason: 'account_inactive', staffId: rows[0].id };
  if (active.length > 1) return { ok: false, reason: 'ambiguous_account' };

  const staff = active[0];

  // ── Identity binding ──────────────────────────────────────────────────────
  // Is this Google account already spoken for by somebody else?
  const { rows: subRows } = await db.query(
    // b233: scoped to provider='google'. The table is shared with Wren's own
    // IdP since b233 and its uniques are now (provider, …) — an unscoped lookup
    // here would answer with an Authentik binding.
    "SELECT staff_id, revoked FROM staff_google_identities WHERE provider = 'google' AND google_sub = $1",
    [String(sub)]
  );
  if (subRows.length && Number(subRows[0].staff_id) !== Number(staff.id)) {
    return { ok: false, reason: 'sub_bound_elsewhere', staffId: staff.id };
  }

  const { rows: linkRows } = await db.query(
    "SELECT * FROM staff_google_identities WHERE provider = 'google' AND staff_id = $1", [staff.id]
  );
  const link = linkRows[0];

  if (!link) {
    // First sign-in: bind. This happens only *inside* an already-verified
    // boundary — Google-signed, domain-checked, matched to an existing active
    // staff row — so it grants nothing that the email match had not already
    // established. What it buys is the check on the next line down: from now
    // on the `sub` has to match, so if this Workspace address is ever deleted
    // and reassigned to a new starter, that new account is refused instead of
    // quietly inheriting this person's Wren access.
    await db.query(
      `INSERT INTO staff_google_identities
         (provider, staff_id, google_sub, google_email, google_hd, linked_by, last_login_at, login_count)
       VALUES ('google',$1,$2,$3,$4,NULL,now(),1)`,
      [staff.id, String(sub), lower, hd || null]
    );
    return { ok: true, staff, linked: 'created' };
  }

  if (link.revoked === true) return { ok: false, reason: 'link_revoked', staffId: staff.id };
  if (String(link.google_sub) !== String(sub)) return { ok: false, reason: 'link_mismatch', staffId: staff.id };

  await db.query(
    `UPDATE staff_google_identities
        SET last_login_at = now(),
            login_count = login_count + 1,
            google_email = $2,
            google_hd = COALESCE($3, google_hd)
      WHERE id = $1`,
    [link.id, lower, hd || null]
  );
  return { ok: true, staff, linked: 'existing' };
}

/** Mint the staff JWT — identical claims, expiry and audience to PIN login. */
function mintStaffToken(staff, portal) {
  return jwt.sign(
    {
      id: staff.id,
      name: `${staff.first_name} ${staff.last_name}`,
      role: staff.role,
      room_id: staff.room_id,
      scope: staff.scope || 'all',
      scope_value: staff.scope_value || null,
    },
    process.env.JWT_SECRET,
    { expiresIn: '12h', audience: portal }
  );
}

/** Same TOTP gate as PIN login — SSO is not a way round a second factor. */
// login-20261023: reads the same Roost → Security role list as PIN login (src/lib/totp-policy.js);
// this used a hard-coded copy, so changing the setting changed PIN sign-in only.
async function needsTotp(staff, db) {
  const policy = require('../lib/totp-policy');
  if (policy.totpSwitchedOff()) return false;
  const roles = await policy.getTotpRoles(db || getPool());
  return roles.includes(staff.role) && staff.totp_verified === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/google/config — may the login page show the button?
// Unauthenticated by necessity (it is read by the login page itself). Reveals
// only whether SSO is switched on and which domain it accepts.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/config', (req, res) => {
  const cfg = oidc.ssoConfig();
  const portalOk = SSO_PORTALS.has(portalOf(req));
  res.json({
    enabled: cfg.enabled && portalOk,
    domain: cfg.domain,
    portal: portalOf(req),
    portal_supported: portalOk,
    // Distinguishes "Toby hasn't made the OAuth client yet" from "switched off"
    // so the NOTES/diagnostics are unambiguous. No secret is implied either way.
    reason: !portalOk ? 'portal_not_enabled'
      : cfg.killed ? 'disabled_by_env'
        : !cfg.configured ? 'not_configured'
          : null,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/google/start — begin the Authorization Code + PKCE flow.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/start', ssoLimiter, portalGuard, async (req, res) => {
  const cfg = oidc.ssoConfig();
  if (!cfg.enabled) {
    auditSso(req, { success: false, reason: cfg.killed ? 'sso_disabled' : 'sso_not_configured' });
    return res.status(503).json({ error: 'sso_disabled', message: friendly('sso_disabled') });
  }

  const db = getPool();
  const portal = portalOf(req);
  const redirectUri = oidc.redirectUriFor(req);
  const state = oidc.randomToken(32);
  const nonce = oidc.randomToken(32);
  const { verifier, challenge } = oidc.pkcePair();

  try {
    // Opportunistic sweep — these rows are single-use and worthless once stale.
    db.query("DELETE FROM sso_login_sessions WHERE created_at < now() - interval '24 hours'").catch(() => {});

    await db.query(
      `INSERT INTO sso_login_sessions
         (provider, state_hash, nonce, code_verifier, portal, redirect_uri, expires_at, ip, user_agent)
       VALUES ('google',$1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        oidc.sha256(state), nonce, verifier, portal, redirectUri,
        new Date(Date.now() + STATE_TTL_MS),
        (req.headers['cf-connecting-ip'] || req.ip || '').toString().slice(0, 60),
        (req.headers['user-agent'] || '').toString().slice(0, 200),
      ]
    );
  } catch (e) {
    auditSso(req, { success: false, reason: 'session_store_failed' });
    return res.status(500).json({ error: 'sso_unavailable' });
  }

  // The state is bound to THIS browser by a cookie as well as being stored
  // server-side; the callback demands all three agree.
  setStateCookie(req, res, state);

  const url = oidc.buildAuthUrl({
    clientId: cfg.clientId,
    redirectUri,
    state,
    nonce,
    codeChallenge: challenge,
    domain: cfg.domain,
    loginHint: (req.query.login_hint || '').toString().slice(0, 120) || null,
  });
  return res.redirect(302, url);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/google/callback — Google sends the browser back here.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/callback', ssoLimiter, portalGuard, async (req, res) => {
  const cfg = oidc.ssoConfig();
  const db = getPool();

  const finish = (reason, email, staffId) => {
    clearStateCookie(res);
    auditSso(req, { success: false, reason, email, staffId });
    return bounceToLogin(req, res, { sso_error: reason, sso_message: friendly(reason) });
  };

  if (!cfg.enabled) return finish('sso_disabled');

  // The user pressed "cancel", or Google refused.
  if (req.query.error) {
    return finish(String(req.query.error).slice(0, 40).replace(/[^a-z_]/gi, '') || 'access_denied');
  }

  const rawState = (req.query.state || '').toString();
  const cookieState = (req.cookies && req.cookies[STATE_COOKIE]) || '';
  const code = (req.query.code || '').toString();
  if (!rawState || !code) return finish('bad_state');

  // CSRF: the state in the URL must equal the state in this browser's cookie.
  // Without this, an attacker can complete the flow with *their* code in
  // *your* browser and silently sign you into their account.
  if (!oidc.safeEqual(rawState, cookieState)) return finish('bad_state');

  // …and must correspond to a live, unconsumed session we started ourselves.
  // Claiming is a conditional UPDATE, so two concurrent callbacks cannot both
  // win the same session row.
  let session;
  try {
    const { rows } = await db.query(
      `UPDATE sso_login_sessions
          SET consumed_at = now()
        WHERE state_hash = $1
          AND provider = 'google'
          AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING *`,
      [oidc.sha256(rawState)]
    );
    session = rows[0];
  } catch (e) {
    return finish('session_lookup_failed');
  }
  if (!session) return finish('bad_state');
  // A session started on Seed must not be finished on Roost.
  if (session.portal !== portalOf(req)) return finish('portal_mismatch');
  if (session.redirect_uri !== oidc.redirectUriFor(req)) return finish('redirect_uri_mismatch');

  // ── Code → ID token (client secret used here and nowhere else) ────────────
  const ex = await oidc.exchangeCode({
    code,
    codeVerifier: session.code_verifier,
    redirectUri: session.redirect_uri,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });
  if (!ex.ok) return finish(ex.reason);

  // ── Verify the ID token properly ──────────────────────────────────────────
  // THIS IS THE LOAD-BEARING SECURITY STEP. It is implemented in
  // src/lib/google-oidc.js -> verifyIdToken(), NOT inline here, because that
  // module is Express-free and DB-free so the test harness can drive the exact
  // code this line runs (scripts/b210-google-sso-selftest.js).
  //
  // Grepping THIS FILE for "jwks" therefore returns nothing, which has already
  // been mis-read once as "no signature verification". verifyIdToken() does:
  //   - RS256 signature against Google's published JWKS
  //     (https://www.googleapis.com/oauth2/v3/certs, cached 1h, fails CLOSED)
  //   - alg pinned to RS256, so an HS256 alg-confusion token is refused
  //   - iss is accounts.google.com
  //   - aud === our OAuth client, so a token minted for another app is refused
  //   - exp, with 30s clock tolerance
  //   - nonce === the nonce bound to this login session (replay defence)
  const v = await oidc.verifyIdToken(ex.idToken, { clientId: cfg.clientId, nonce: session.nonce });
  if (!v.ok) return finish(v.reason);

  // ── Domain + verified-email gate, on the verified claims ──────────────────
  // Also in src/lib/google-oidc.js -> checkIdentityClaims(). Runs against the
  // SIGNATURE-VERIFIED payload above, never against anything from the request:
  //   - email_verified === true; an unverified address proves nothing
  //   - the hd CLAIM equals our Workspace domain (a consumer @gmail.com has none)
  //   - the email's own domain equals it too, because the `hd` we put on the
  //     authorization REQUEST is only a UI hint and is not a control
  const ident = oidc.checkIdentityClaims(v.payload, cfg.domain);
  if (!ident.ok) return finish(ident.reason, ident.email);

  // ── Match an existing staff row. Never create one. ────────────────────────
  let resolved;
  try {
    resolved = await resolveStaffForGoogle(db, { email: ident.email, sub: ident.sub, hd: ident.hd });
  } catch (e) {
    return finish('staff_lookup_failed', ident.email);
  }
  if (!resolved.ok) return finish(resolved.reason, ident.email, resolved.staffId);

  // ── Hand off to the login page with a one-time code ───────────────────────
  // The JWT is minted at /exchange, so nothing bearer-shaped touches the URL.
  const handoff = oidc.randomToken(32);
  try {
    await db.query(
      `UPDATE sso_login_sessions
          SET exchange_hash = $2, exchange_expires_at = $3, staff_id = $4, outcome = 'ok'
        WHERE id = $1`,
      [session.id, oidc.sha256(handoff), new Date(Date.now() + EXCHANGE_TTL_MS), resolved.staff.id]
    );
  } catch (e) {
    return finish('handoff_store_failed', ident.email, resolved.staff.id);
  }

  auditSso(req, {
    success: true,
    reason: 'verified',
    email: ident.email,
    staffId: resolved.staff.id,
    extra: { stage: 'callback', link: resolved.linked },
  });

  return bounceToLogin(req, res, { sso: handoff });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/google/exchange — login page redeems the hand-off code.
// This is the mint point, and it is deliberately a normal JSON endpoint so the
// Roost allowlist gate in server-unified.js (_ROOST_MINT_PATHS) inspects the
// token exactly as it does for a PIN or remember-device login.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/exchange', ssoLimiter, portalGuard, async (req, res) => {
  const db = getPool();
  const portal = portalOf(req);
  const handoff = (req.body && req.body.code ? String(req.body.code) : '');
  const cookieState = (req.cookies && req.cookies[STATE_COOKIE]) || '';
  if (!handoff) return res.status(400).json({ error: 'code required' });

  let session;
  try {
    const { rows } = await db.query(
      `UPDATE sso_login_sessions
          SET exchange_used_at = now()
        WHERE exchange_hash = $1
          AND exchange_used_at IS NULL
          AND exchange_expires_at > now()
        RETURNING *`,
      [oidc.sha256(handoff)]
    );
    session = rows[0];
  } catch (e) {
    return res.status(500).json({ error: 'sso_unavailable' });
  }
  if (!session || !session.staff_id) {
    auditSso(req, { success: false, reason: 'bad_handoff' });
    return res.status(401).json({ error: 'sso_expired', message: friendly('bad_state') });
  }
  if (session.portal !== portal) {
    auditSso(req, { success: false, reason: 'portal_mismatch', staffId: session.staff_id });
    return res.status(401).json({ error: 'sso_expired', message: friendly('bad_state') });
  }
  // Same-browser check: the hand-off code is only redeemable by the browser
  // that started the flow, proven by it still holding that flow's state cookie.
  if (!cookieState || oidc.sha256(cookieState) !== session.state_hash) {
    auditSso(req, { success: false, reason: 'state_cookie_mismatch', staffId: session.staff_id });
    return res.status(401).json({ error: 'sso_expired', message: friendly('bad_state') });
  }

  // Re-read the staff row at mint time — active state and role are taken now,
  // not from anything carried across the redirect.
  let staff;
  try {
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, role, room_id, is_active, email,
              scope, scope_value, profile_photo, totp_verified
         FROM staff WHERE id = $1`,
      [session.staff_id]
    );
    staff = rows[0];
  } catch (e) {
    return res.status(500).json({ error: 'sso_unavailable' });
  }
  if (!staff || staff.is_active !== true) {
    auditSso(req, { success: false, reason: 'account_inactive', staffId: session.staff_id });
    return res.status(403).json({ error: 'account_inactive', message: friendly('account_inactive') });
  }

  clearStateCookie(res);

  if (await needsTotp(staff)) {
    const challengeToken = jwt.sign(
      { id: staff.id, role: staff.role, scope: 'totp_only' },
      process.env.JWT_SECRET,
      { expiresIn: '5m', audience: portal }
    );
    auditSso(req, { success: true, reason: 'totp_required', email: staff.email, staffId: staff.id, extra: { stage: 'exchange' } });
    return res.json({ requires_totp: true, challenge_token: challengeToken });
  }

  const token = mintStaffToken(staff, portal);
  db.query('UPDATE staff SET last_login_at = now() WHERE id = $1', [staff.id]).catch(() => {});
  auditSso(req, { success: true, reason: 'signed_in', email: staff.email, staffId: staff.id, extra: { stage: 'exchange' } });

  return res.json({
    token,
    staff: {
      id: staff.id,
      first_name: staff.first_name,
      last_name: staff.last_name,
      role: staff.role,
      room_id: staff.room_id,
      profile_photo: staff.profile_photo,
      scope: staff.scope || 'all',
      scope_value: staff.scope_value || null,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Manager-facing link management (staff profile → Details).
// ─────────────────────────────────────────────────────────────────────────────
function requireManager(req, res, next) {
  if (!MANAGER_ROLES.includes(req.user && req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
}

// GET /api/auth/google/link/:staff_id — which Google account is bound?
router.get('/link/:staff_id', authenticate, async (req, res) => {
  const staffId = Number(req.params.staff_id);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'bad staff_id' });
  // A manager can see anyone's; everyone else can see only their own.
  if (!hasRole(req.user, MANAGER_ROLES) && Number(req.user.id) !== staffId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, staff_id, google_email, google_hd, linked_at, linked_by,
              last_login_at, login_count, revoked, revoked_at, revoked_by
         FROM staff_google_identities WHERE provider = 'google' AND staff_id = $1`,
      [staffId]
    );
    const cfg = oidc.ssoConfig();
    // google_sub is intentionally not returned — it is an identifier the UI has
    // no use for.
    res.json({ sso_enabled: cfg.enabled, domain: cfg.domain, link: rows[0] || null });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/google/link/:staff_id — revoke. Keeps the row (and its
// history) but refuses every future Google sign-in for that account.
router.delete('/link/:staff_id', authenticate, requireManager, async (req, res) => {
  const staffId = Number(req.params.staff_id);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'bad staff_id' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE staff_google_identities
          SET revoked = true, revoked_at = now(), revoked_by = $2
        WHERE provider = 'google' AND staff_id = $1 AND revoked = false
        RETURNING id, google_email`,
      [staffId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No active Google link for this staff member' });
    recordAudit({
      req, action: 'update', entity_type: 'staff', entity_id: staffId,
      meta: { change: 'google_sso_revoked', google_email: rows[0].google_email, by: req.user.id },
    });
    res.json({ ok: true, revoked: true });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/google/link/:staff_id/allow — clear the binding entirely so
// the staff member's next Google sign-in binds afresh. Used after "wrong
// account linked" or a Workspace account being recreated.
//
// There is deliberately NO endpoint that lets a manager type an arbitrary
// address and bind it to a staff row: that would decouple the binding from
// ladn.staff.email and hand anyone with manager rights a way to point somebody
// else's Wren account at a mailbox they control.
router.post('/link/:staff_id/allow', authenticate, requireManager, async (req, res) => {
  const staffId = Number(req.params.staff_id);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'bad staff_id' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      "DELETE FROM staff_google_identities WHERE provider = 'google' AND staff_id = $1 RETURNING google_email",
      [staffId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No Google link for this staff member' });
    recordAudit({
      req, action: 'update', entity_type: 'staff', entity_id: staffId,
      meta: { change: 'google_sso_link_cleared', previous_google_email: rows[0].google_email, by: req.user.id },
    });
    res.json({ ok: true, cleared: true });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.resolveStaffForGoogle = resolveStaffForGoogle;
module.exports.SSO_PORTALS = SSO_PORTALS;
