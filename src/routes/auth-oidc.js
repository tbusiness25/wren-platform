'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b233 — "Sign in with Wren ID": OIDC against Wren's OWN identity provider.
//
// Implements wren-docs/decisions/2026-08-26-authentik-own-idp.md.
// Mounted at /api/auth/oidc from src/routes/auth.js (one added line there —
// the PIN login in that file is untouched and stays the primary path).
//
// WHY THIS EXISTS AT ALL
//   Cloudflare Access is currently *doing* the authentication for parents, not
//   merely gating it: of 82 active parent_portal_access rows, token_hash is set
//   on 0 and last_login on 0. Every parent enters via cf-auto-login off a CF
//   assertion. That caps Wren at 50 CF seats and ties every future customer to
//   Toby's Cloudflare tenancy. Wren has to own its own login.
//
// WHAT THIS BUILD DOES *NOT* DO — and this is deliberate:
//   Cloudflare Access is NOT removed, weakened or reconfigured. Authentik runs
//   ALONGSIDE it. PARENT_CF_JWT_ENFORCE stays on, and the parent CF gate in
//   editions/ladn/server-unified.js (_requireVerifiedParentSession) is not
//   touched by this file. A real impersonation hole was found in exactly that
//   path in July; taking CF off is a later build with its own review.
//
// THE RULE THAT SHAPES EVERYTHING BELOW — unchanged from b210:
//   Authentik supplies IDENTITY. Wren supplies AUTHORITY.
//   A verified Authentik account is only ever MATCHED to an existing, active
//   ladn.staff row (staff) or ladn.parent_portal_access row (parent) by email.
//   It can never create a row, never invent a role, and never widen one. The
//   JWT minted here is the same shape, claims, `aud` and expiry as the PIN one.
//
// Flow (Authorization Code + PKCE), same three legs as b210:
//   GET  /api/auth/oidc/start     → 302 to Authentik (state cookie + DB session)
//   GET  /api/auth/oidc/callback  → verify, resolve subject, 302 back with a
//                                   one-time hand-off code
//   POST /api/auth/oidc/exchange  → redeem the code for a Wren JWT
// The JWT is minted at /exchange, so no token ever touches a URL, browser
// history, or a database row.
//
// WHERE THE SECURITY CONTROLS LIVE — read this before reviewing this file:
//   ID-token signature verification (JWKS), the alg pin, iss/aud/exp, the
//   nonce, the discovery-document same-origin check and the email_verified
//   policy are ALL in src/lib/oidc-core.js and are called from /callback below.
//   Grepping THIS file for "jwks" finds only this comment; that is not evidence
//   the checks are absent. That exact conclusion was drawn about b210's
//   equivalent file in the 2026-08-21 review, and it was wrong.
//   Evidence: scripts/b233-oidc-selftest.js drives the real verifier and the
//   real authority decision through every reject path.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const core = require('../lib/oidc-core');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const { setParentSessionCookie } = require('../lib/parent-identity'); // b239

const PROVIDER = 'authentik';

// Portals where staff SSO exists at all. The EY portal ('learning') is
// deliberately excluded for the same reason as b210: EY tablets are shared
// devices in a room, where a 6-digit PIN is the correct control and an SSO
// session would silently leave the last person signed in.
const STAFF_PORTALS = new Set(['admin', 'hr']);

// Parent SSO is built here but OFF unless explicitly switched on. Phase 1 is
// "stand the IdP up alongside CF Access"; not one parent is enrolled in
// Authentik yet, so leaving this on would open a second parent door that
// nobody can walk through and nobody is watching. Toby turns it on when
// enrolment has actually happened.
function parentSsoEnabled() {
  return String(process.env.WREN_OIDC_PARENTS || '').trim().toLowerCase() === 'on';
}

// Sending real enrolment mail is a separate switch again, and this build never
// sets it. See /enrolment/invitations.
function inviteSendEnabled() {
  return String(process.env.WREN_OIDC_INVITE_SEND || '').trim().toLowerCase() === 'on';
}

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];

const STATE_COOKIE = 'wren_oidc_state';
const STATE_TTL_MS = 10 * 60 * 1000;   // authorization round-trip
const EXCHANGE_TTL_MS = 2 * 60 * 1000; // login page redeeming the hand-off code
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // enrolment link lifetime

// Crude DoS backstop only, deliberately set well above real use.
//
// Keyed by IP, and the whole nursery leaves through ONE public IP — so a tight
// bucket here would repeat the bug Card #21 fixed for PIN login, where an
// IP-keyed limiter let one person's failures lock out everyone in the building.
// The real anti-guessing control on /callback and /exchange is not this: both
// consume a single-use 32-byte random token bound to a server-side session row,
// which is not guessable at any rate.
const oidcLimiter = rateLimit({
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

/** Which kind of person can sign in on this portal, if any. */
function subjectKindFor(req) {
  const portal = portalOf(req);
  if (STAFF_PORTALS.has(portal)) return 'staff';
  if (portal === 'parents' && parentSsoEnabled()) return 'parent';
  return null;
}

function portalGuard(req, res, next) {
  if (!subjectKindFor(req)) return res.status(404).json({ error: 'Not found' });
  next();
}

/**
 * Audit every attempt — success and failure — with the email tried and the
 * reason, into the existing audit_log via the shared recordAudit helper.
 * Never receives a token, a code or a secret.
 */
function auditOidc(req, { success, reason, email, staffId, extra }) {
  recordAudit({
    req,
    action: 'login',
    entity_type: 'staff',
    entity_id: staffId || undefined,
    actor_type: success ? 'staff' : 'anonymous',
    actor_id: staffId || null,
    actor_email: email || null,
    meta: Object.assign({
      method: 'authentik_sso',
      provider: PROVIDER,
      portal: portalOf(req),
      success: !!success,
      reason: reason || null,
      email_tried: email || null,
    }, extra || {}),
  });
}

/** Cookies: Lax (not Strict) — the callback is a top-level cross-site redirect
 *  from Authentik, and a Strict cookie would simply not be sent. Secure follows
 *  the real scheme so the flow is testable on the plain-HTTP dev port while
 *  always being Secure behind nginx/Cloudflare in production. */
function setStateCookie(req, res, rawState) {
  res.cookie(STATE_COOKIE, rawState, {
    httpOnly: true,
    secure: req.secure === true,
    sameSite: 'Lax',
    maxAge: STATE_TTL_MS,
    path: '/api/auth/oidc',
  });
}

function clearStateCookie(res) {
  res.clearCookie(STATE_COOKIE, { path: '/api/auth/oidc' });
}

function loginPageFor(req) {
  // b239 — was '/welcome' for parents. /welcome is the portal HOME: a parent whose
  // address matched nothing landed on a page that then failed to load any data,
  // with the reason sitting unread in the query string. The brief asks for "a clear
  // 'we don't recognise that address, speak to the nursery' page, not a silent
  // failure" — that page is /login.html, which already has an error box and the
  // nursery's phone number in it, and now reads oidc_error/oidc_message.
  return '/login.html';
}

function bounceToLogin(req, res, params) {
  const qs = new URLSearchParams(params).toString();
  return res.redirect(302, `${loginPageFor(req)}?${qs}`);
}

// A deliberately small, non-enumerating set of messages. Anything that would
// tell an anonymous caller whether a given address belongs to this nursery is
// collapsed into the same neutral text; the precise reason still goes to the
// audit log.
const FRIENDLY = {
  no_wren_account: 'There is no Wren account for that address — ask the nursery to set one up.',
  account_inactive: 'There is no Wren account for that address — ask the nursery to set one up.',
  ambiguous_account: 'That address matches more than one staff record. Ask your manager to sort it out.',
  link_revoked: 'Wren ID sign-in has been turned off for this account. Sign in with your PIN, or ask your manager.',
  link_mismatch: 'This Wren ID does not match the one linked to your account. Ask your manager to unlink it.',
  sub_bound_elsewhere: 'This Wren ID is already linked to a different account.',
  email_not_verified: 'That Wren ID has no verified email address.',
  sso_disabled: 'Wren ID sign-in is not enabled on this site.',
  bad_state: 'That sign-in link expired or was already used. Please try again.',
  access_denied: 'Sign-in was cancelled.',
};
function friendly(reason) {
  return FRIENDLY[reason] || 'Wren ID sign-in failed. Please use your PIN, or try again.';
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTHORITY DECISIONS
// Both resolvers below take an ALREADY-VERIFIED identity and answer only:
// which existing Wren record, if any, is this person allowed to be? Neither
// ever inserts into `staff`, `children` or `parent_portal_access`. The only row
// either may create is the identity binding, which records *who signed in*, not
// what they may do. Exported so the self-test harness drives the same code the
// HTTP callback runs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * resolveStaffForOidc — the staff half. Structurally identical to b210's
 * resolveStaffForGoogle, but reads and writes the provider-scoped binding
 * introduced by scripts/b233-authentik-oidc-schema.sql.
 */
async function resolveStaffForOidc(db, { email, sub, provider = PROVIDER }) {
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

  // Is this Authentik account already spoken for by somebody else?
  const { rows: subRows } = await db.query(
    'SELECT staff_id FROM staff_google_identities WHERE provider = $1 AND google_sub = $2',
    [provider, String(sub)]
  );
  if (subRows.length && Number(subRows[0].staff_id) !== Number(staff.id)) {
    return { ok: false, reason: 'sub_bound_elsewhere', staffId: staff.id };
  }

  const { rows: linkRows } = await db.query(
    'SELECT * FROM staff_google_identities WHERE provider = $1 AND staff_id = $2',
    [provider, staff.id]
  );
  const link = linkRows[0];

  if (!link) {
    // First sign-in: bind. This happens only *inside* an already-verified
    // boundary — signed by our IdP, matched to an existing active staff row —
    // so it grants nothing the email match had not already established. What it
    // buys is the check below: from now on the `sub` has to match, so if this
    // address is ever deleted in Authentik and reassigned to a new starter,
    // that new account is refused instead of quietly inheriting this person's
    // Wren access.
    await db.query(
      `INSERT INTO staff_google_identities
         (provider, staff_id, google_sub, google_email, google_hd, linked_by, last_login_at, login_count)
       VALUES ($1,$2,$3,$4,NULL,NULL,now(),1)`,
      [provider, staff.id, String(sub), lower]
    );
    return { ok: true, staff, linked: 'created' };
  }

  if (link.revoked === true) return { ok: false, reason: 'link_revoked', staffId: staff.id };
  if (String(link.google_sub) !== String(sub)) return { ok: false, reason: 'link_mismatch', staffId: staff.id };

  await db.query(
    `UPDATE staff_google_identities
        SET last_login_at = now(),
            login_count = login_count + 1,
            google_email = $2
      WHERE id = $1`,
    [link.id, lower]
  );
  return { ok: true, staff, linked: 'existing' };
}

/**
 * resolveParentForOidc — the parent half.
 *
 * Keyed by EMAIL rather than by a single row, because one address routinely
 * covers siblings across several parent_portal_access rows. The child scope is
 * NOT decided here and is not carried across the redirect — /exchange re-reads
 * it at mint time, exactly as cf-auto-login does.
 */
async function resolveParentForOidc(db, { email, sub, provider = PROVIDER }) {
  const lower = String(email || '').toLowerCase().trim();
  if (!lower || !sub) return { ok: false, reason: 'no_identity' };

  const { rows } = await db.query(
    `SELECT id, child_id, is_active
       FROM parent_portal_access
      WHERE lower(email) = $1
      ORDER BY is_active DESC, id ASC`,
    [lower]
  );
  if (!rows.length) return { ok: false, reason: 'no_wren_account' };

  const active = rows.filter((r) => r.is_active === true);
  if (!active.length) return { ok: false, reason: 'account_inactive' };

  const { rows: subRows } = await db.query(
    'SELECT parent_email FROM parent_oidc_identities WHERE provider = $1 AND subject = $2',
    [provider, String(sub)]
  );
  if (subRows.length && String(subRows[0].parent_email).toLowerCase() !== lower) {
    return { ok: false, reason: 'sub_bound_elsewhere' };
  }

  const { rows: linkRows } = await db.query(
    'SELECT * FROM parent_oidc_identities WHERE provider = $1 AND lower(parent_email) = $2',
    [provider, lower]
  );
  const link = linkRows[0];

  if (!link) {
    await db.query(
      `INSERT INTO parent_oidc_identities
         (provider, subject, parent_email, provider_email, last_login_at, login_count)
       VALUES ($1,$2,$3,$4,now(),1)`,
      [provider, String(sub), lower, lower]
    );
    return { ok: true, parentEmail: lower, accessId: active[0].id, linked: 'created' };
  }

  if (link.revoked === true) return { ok: false, reason: 'link_revoked' };
  if (String(link.subject) !== String(sub)) return { ok: false, reason: 'link_mismatch' };

  await db.query(
    `UPDATE parent_oidc_identities
        SET last_login_at = now(), login_count = login_count + 1, provider_email = $2
      WHERE id = $1`,
    [link.id, lower]
  );

  // An invitation that has actually been walked through is no longer pending.
  db.query(
    `UPDATE parent_enrolment_invites
        SET status = 'enrolled', enrolled_at = now()
      WHERE lower(parent_email) = $1 AND status IN ('generated','sent')`,
    [lower]
  ).catch(() => {});

  return { ok: true, parentEmail: lower, accessId: active[0].id, linked: 'existing' };
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

/** Mint the parent JWT — identical shape to /api/auth/cf-auto-login's. */
function mintParentToken({ email, child, childIds }, portal) {
  return jwt.sign(
    { id: 0, name: email, role: 'parent', child_id: child.id, child_ids: childIds, room_id: child.room_id },
    process.env.JWT_SECRET,
    { expiresIn: '30d', audience: portal }
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
// GET /api/auth/oidc/config — may the login page show the button?
// Unauthenticated by necessity (it is read by the login page itself). Reveals
// only whether Wren ID is switched on for this portal, and never the issuer's
// client secret or anything derived from it.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/config', (req, res) => {
  const cfg = core.providerConfig(PROVIDER);
  const kind = subjectKindFor(req);
  res.json({
    enabled: cfg.enabled && !!kind,
    provider: PROVIDER,
    label: cfg.label,
    portal: portalOf(req),
    subject_kind: kind,
    portal_supported: !!kind,
    reason: !kind ? 'portal_not_enabled' : cfg.reason,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/oidc/start — begin the Authorization Code + PKCE flow.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/start', oidcLimiter, portalGuard, async (req, res) => {
  const cfg = core.providerConfig(PROVIDER);
  if (!cfg.enabled) {
    auditOidc(req, { success: false, reason: cfg.reason || 'sso_disabled' });
    return res.status(503).json({ error: 'sso_disabled', message: friendly('sso_disabled') });
  }

  // Endpoints come from the IdP's discovery document, validated same-origin
  // against the configured issuer — see oidc-core.resolveEndpoints().
  const disco = await core.resolveEndpoints(PROVIDER, cfg);
  if (!disco.ok) {
    auditOidc(req, { success: false, reason: disco.reason });
    return res.status(503).json({ error: 'sso_unavailable', message: friendly('sso_disabled') });
  }

  const db = getPool();
  const portal = portalOf(req);
  const kind = subjectKindFor(req);
  const redirectUri = core.redirectUriFor(PROVIDER, req);
  const state = core.randomToken(32);
  const nonce = core.randomToken(32);
  const { verifier, challenge } = core.pkcePair();

  try {
    // Opportunistic sweep — these rows are single-use and worthless once stale.
    db.query("DELETE FROM sso_login_sessions WHERE created_at < now() - interval '24 hours'").catch(() => {});

    await db.query(
      `INSERT INTO sso_login_sessions
         (provider, state_hash, nonce, code_verifier, portal, redirect_uri, expires_at, ip, user_agent, subject_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        PROVIDER, core.sha256(state), nonce, verifier, portal, redirectUri,
        new Date(Date.now() + STATE_TTL_MS),
        (req.headers['cf-connecting-ip'] || req.ip || '').toString().slice(0, 60),
        (req.headers['user-agent'] || '').toString().slice(0, 200),
        kind,
      ]
    );
  } catch (e) {
    auditOidc(req, { success: false, reason: 'session_store_failed' });
    return res.status(500).json({ error: 'sso_unavailable' });
  }

  // The state is bound to THIS browser by a cookie as well as being stored
  // server-side; the callback demands all three agree.
  setStateCookie(req, res, state);

  const url = core.buildAuthUrl(PROVIDER, {
    endpoints: disco.endpoints,
    clientId: cfg.clientId,
    redirectUri,
    state,
    nonce,
    codeChallenge: challenge,
    loginHint: (req.query.login_hint || '').toString().slice(0, 120) || null,
  });
  return res.redirect(302, url);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/oidc/callback — Authentik sends the browser back here.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/callback', oidcLimiter, portalGuard, async (req, res) => {
  const cfg = core.providerConfig(PROVIDER);
  const db = getPool();

  const finish = (reason, email, staffId) => {
    clearStateCookie(res);
    auditOidc(req, { success: false, reason, email, staffId });
    return bounceToLogin(req, res, { oidc_error: reason, oidc_message: friendly(reason) });
  };

  if (!cfg.enabled) return finish('sso_disabled');

  // The user pressed "cancel", or the IdP refused.
  if (req.query.error) {
    return finish(String(req.query.error).slice(0, 40).replace(/[^a-z_]/gi, '') || 'access_denied');
  }

  const rawState = (req.query.state || '').toString();
  const cookieState = (req.cookies && req.cookies[STATE_COOKIE]) || '';
  const code = (req.query.code || '').toString();
  if (!rawState || !code) return finish('bad_state');

  // CSRF: the state in the URL must equal the state in this browser's cookie.
  // Without this, an attacker can complete the flow with *their* code in *your*
  // browser and silently sign you into their account.
  if (!core.safeEqual(rawState, cookieState)) return finish('bad_state');

  // …and must correspond to a live, unconsumed session we started ourselves.
  // Claiming is a conditional UPDATE, so two concurrent callbacks cannot both
  // win the same session row.
  let session;
  try {
    const { rows } = await db.query(
      `UPDATE sso_login_sessions
          SET consumed_at = now()
        WHERE state_hash = $1
          AND provider = $2
          AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING *`,
      [core.sha256(rawState), PROVIDER]
    );
    session = rows[0];
  } catch (e) {
    return finish('session_lookup_failed');
  }
  if (!session) return finish('bad_state');
  // A session started on Seed must not be finished on Roost.
  if (session.portal !== portalOf(req)) return finish('portal_mismatch');
  if (session.redirect_uri !== core.redirectUriFor(PROVIDER, req)) return finish('redirect_uri_mismatch');
  // …nor a parent session finished as a staff one.
  if (session.subject_kind !== subjectKindFor(req)) return finish('subject_kind_mismatch');

  const disco = await core.resolveEndpoints(PROVIDER, cfg);
  if (!disco.ok) return finish(disco.reason);

  // ── Code → ID token (client secret used here and nowhere else) ────────────
  const ex = await core.exchangeCode(PROVIDER, {
    endpoints: disco.endpoints,
    code,
    codeVerifier: session.code_verifier,
    redirectUri: session.redirect_uri,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });
  if (!ex.ok) return finish(ex.reason);

  // ── Verify the ID token properly ──────────────────────────────────────────
  // THIS IS THE LOAD-BEARING SECURITY STEP, and it is implemented in
  // src/lib/oidc-core.js -> verifyIdToken(), not inline here, so the test
  // harness can drive the exact code this line runs. It does:
  //   - RS256 signature against the IdP's published JWKS (cached 1h, fails CLOSED)
  //   - alg pinned to RS256, so an HS256 alg-confusion token is refused
  //   - iss === the discovery document's own issuer
  //   - aud === our OAuth client, so a token minted for another app is refused
  //   - exp, with 30s clock tolerance
  //   - nonce === the nonce bound to this login session (replay defence)
  const v = await core.verifyIdToken(ex.idToken, {
    endpoints: disco.endpoints,
    clientId: cfg.clientId,
    nonce: session.nonce,
  });
  if (!v.ok) return finish(v.reason);

  // ── Claims gate, on the VERIFIED payload ──────────────────────────────────
  const ident = core.checkIdentityClaims(PROVIDER, v.payload, cfg.domain);
  if (!ident.ok) return finish(ident.reason, ident.email);

  // ── Match an existing record. Never create one. ───────────────────────────
  let resolved;
  const kind = session.subject_kind;
  try {
    resolved = kind === 'parent'
      ? await resolveParentForOidc(db, { email: ident.email, sub: ident.sub })
      : await resolveStaffForOidc(db, { email: ident.email, sub: ident.sub });
  } catch (e) {
    return finish('subject_lookup_failed', ident.email);
  }
  if (!resolved.ok) return finish(resolved.reason, ident.email, resolved.staffId);

  // ── Hand off to the login page with a one-time code ───────────────────────
  // The JWT is minted at /exchange, so nothing bearer-shaped touches the URL.
  const handoff = core.randomToken(32);
  try {
    await db.query(
      `UPDATE sso_login_sessions
          SET exchange_hash = $2, exchange_expires_at = $3,
              staff_id = $4, parent_access_id = $5, parent_email = $6, outcome = 'ok'
        WHERE id = $1`,
      [
        session.id, core.sha256(handoff), new Date(Date.now() + EXCHANGE_TTL_MS),
        kind === 'staff' ? resolved.staff.id : null,
        kind === 'parent' ? resolved.accessId : null,
        kind === 'parent' ? resolved.parentEmail : null,
      ]
    );
  } catch (e) {
    return finish('handoff_store_failed', ident.email, resolved.staff && resolved.staff.id);
  }

  auditOidc(req, {
    success: true,
    reason: 'verified',
    email: ident.email,
    staffId: kind === 'staff' ? resolved.staff.id : null,
    extra: { stage: 'callback', link: resolved.linked, subject_kind: kind },
  });

  return bounceToLogin(req, res, { oidc: handoff });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/oidc/exchange — login page redeems the hand-off code.
//
// This is the mint point, and it is deliberately a normal JSON endpoint so the
// Roost allowlist gate in server-unified.js (_ROOST_MINT_PATHS) inspects the
// token exactly as it does for a PIN, remember-device or Google login. b210
// found that omitting a mint path from that set turns SSO into a way around
// the Roost manager allowlist — '/api/auth/oidc/exchange' is registered there.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/exchange', oidcLimiter, portalGuard, async (req, res) => {
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
          AND provider = $2
          AND exchange_used_at IS NULL
          AND exchange_expires_at > now()
        RETURNING *`,
      [core.sha256(handoff), PROVIDER]
    );
    session = rows[0];
  } catch (e) {
    return res.status(500).json({ error: 'sso_unavailable' });
  }
  if (!session) {
    auditOidc(req, { success: false, reason: 'bad_handoff' });
    return res.status(401).json({ error: 'sso_expired', message: friendly('bad_state') });
  }
  if (session.portal !== portal || session.subject_kind !== subjectKindFor(req)) {
    auditOidc(req, { success: false, reason: 'portal_mismatch', staffId: session.staff_id });
    return res.status(401).json({ error: 'sso_expired', message: friendly('bad_state') });
  }
  // Same-browser check: the hand-off code is only redeemable by the browser
  // that started the flow, proven by it still holding that flow's state cookie.
  if (!cookieState || core.sha256(cookieState) !== session.state_hash) {
    auditOidc(req, { success: false, reason: 'state_cookie_mismatch', staffId: session.staff_id });
    return res.status(401).json({ error: 'sso_expired', message: friendly('bad_state') });
  }

  clearStateCookie(res);

  return session.subject_kind === 'parent'
    ? mintForParent(req, res, db, session, portal)
    : mintForStaff(req, res, db, session, portal);
});

async function mintForStaff(req, res, db, session, portal) {
  if (!session.staff_id) {
    auditOidc(req, { success: false, reason: 'bad_handoff' });
    return res.status(401).json({ error: 'sso_expired', message: friendly('bad_state') });
  }
  // Re-read the staff row at mint time — active state and role are taken NOW,
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
    auditOidc(req, { success: false, reason: 'account_inactive', staffId: session.staff_id });
    return res.status(403).json({ error: 'account_inactive', message: friendly('account_inactive') });
  }

  if (await needsTotp(staff)) {
    const challengeToken = jwt.sign(
      { id: staff.id, role: staff.role, scope: 'totp_only' },
      process.env.JWT_SECRET,
      { expiresIn: '5m', audience: portal }
    );
    auditOidc(req, { success: true, reason: 'totp_required', email: staff.email, staffId: staff.id, extra: { stage: 'exchange' } });
    return res.json({ requires_totp: true, challenge_token: challengeToken });
  }

  const token = mintStaffToken(staff, portal);
  db.query('UPDATE staff SET last_login_at = now() WHERE id = $1', [staff.id]).catch(() => {});
  auditOidc(req, { success: true, reason: 'signed_in', email: staff.email, staffId: staff.id, extra: { stage: 'exchange' } });

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
}

async function mintForParent(req, res, db, session, portal) {
  const email = String(session.parent_email || '').toLowerCase();
  if (!email) {
    auditOidc(req, { success: false, reason: 'bad_handoff' });
    return res.status(401).json({ error: 'sso_expired', message: friendly('bad_state') });
  }
  // The child scope is resolved HERE, at mint time, with the same query
  // cf-auto-login uses — never carried across the redirect. A child who left
  // between /start and /exchange is therefore not in the token.
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT c.id, c.first_name, c.last_name, c.room_id FROM children c
        WHERE ((lower(c.parent_1_email)=$1 OR lower(c.parent_2_email)=$1) AND c.is_active=true)
           OR EXISTS (SELECT 1 FROM parent_portal_access pa
                      WHERE pa.child_id=c.id AND lower(pa.email)=$1 AND pa.is_active=true)
        ORDER BY c.is_active DESC, c.id`,
      [email]
    ));
  } catch (e) {
    return res.status(500).json({ error: 'sso_unavailable' });
  }
  if (!rows.length) {
    auditOidc(req, { success: false, reason: 'no_wren_account', email });
    return res.status(401).json({ error: 'no_child', message: friendly('no_wren_account') });
  }

  const child = rows[0];
  const childIds = rows.map((r) => r.id);
  const token = mintParentToken({ email, child, childIds }, portal);
  // b239 — the parents portal pages send no bearer token, so the JWT also has to
  // land in a cookie or nothing after this redirect can use it.
  setParentSessionCookie(req, res, token);
  db.query('UPDATE parent_portal_access SET last_login=now() WHERE lower(email)=$1', [email]).catch(() => {});
  auditOidc(req, { success: true, reason: 'signed_in', email, extra: { stage: 'exchange', subject_kind: 'parent' } });

  return res.json({ token, child, children: rows });
}

// ─────────────────────────────────────────────────────────────────────────────
// Manager-facing link management (staff profile → Details).
// ─────────────────────────────────────────────────────────────────────────────
function requireManager(req, res, next) {
  if (!MANAGER_ROLES.includes(req.user && req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
}

// GET /api/auth/oidc/link/:staff_id — which Wren ID is bound?
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
      `SELECT id, staff_id, provider, google_email AS subject_email, linked_at, linked_by,
              last_login_at, login_count, revoked, revoked_at, revoked_by
         FROM staff_google_identities WHERE provider = $1 AND staff_id = $2`,
      [PROVIDER, staffId]
    );
    const cfg = core.providerConfig(PROVIDER);
    // The subject identifier is intentionally not returned — the UI has no use
    // for it.
    res.json({ sso_enabled: cfg.enabled, provider: PROVIDER, link: rows[0] || null });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/oidc/link/:staff_id — revoke. Keeps the row (and its
// history) but refuses every future Wren ID sign-in for that account.
router.delete('/link/:staff_id', authenticate, requireManager, async (req, res) => {
  const staffId = Number(req.params.staff_id);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'bad staff_id' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE staff_google_identities
          SET revoked = true, revoked_at = now(), revoked_by = $3
        WHERE provider = $1 AND staff_id = $2 AND revoked = false
        RETURNING id, google_email`,
      [PROVIDER, staffId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No active Wren ID link for this staff member' });
    recordAudit({
      req, action: 'update', entity_type: 'staff', entity_id: staffId,
      meta: { change: 'oidc_sso_revoked', provider: PROVIDER, subject_email: rows[0].google_email, by: req.user.id },
    });
    res.json({ ok: true, revoked: true });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/oidc/link/:staff_id/allow — clear the binding entirely so the
// staff member's next Wren ID sign-in binds afresh.
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
      'DELETE FROM staff_google_identities WHERE provider = $1 AND staff_id = $2 RETURNING google_email',
      [PROVIDER, staffId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No Wren ID link for this staff member' });
    recordAudit({
      req, action: 'update', entity_type: 'staff', entity_id: staffId,
      meta: { change: 'oidc_sso_link_cleared', provider: PROVIDER, previous_subject_email: rows[0].google_email, by: req.user.id },
    });
    res.json({ ok: true, cleared: true });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PARENT ENROLMENT GROUNDWORK — Roost only, manager only.
//
// Phase 1 BUILDS this and does not RUN it. Nothing here emails anybody: the
// send path is gated behind WREN_OIDC_INVITE_SEND, which this build never sets,
// and the generator writes tokens to ladn.parent_enrolment_invites plus a file
// the manager can hand to whoever is doing the comms.
//
// GDPR: these endpoints deliberately return COUNTS AND ADDRESSES ONLY. No
// child name, no date of birth, no room, nothing about a family beyond the
// address the invitation would go to and whether they have enrolled.
// ─────────────────────────────────────────────────────────────────────────────
// This router is shared with the demo/school editions (eyfs, primary, secondary,
// childrenscorner, htps, ht), several of which bind-mount src/ and
// editions/admin/public from this working tree and so pick these files up
// without anyone deploying anything. Their schemas do not have the b233 tables,
// and a manager opening the screen there would otherwise get a bare 500.
// 42P01 is postgres's "relation does not exist" — answer it honestly instead.
function schemaMissing(e) {
  return e && (e.code === '42P01' || e.code === '42703');
}
function notApplied(res) {
  return res.status(501).json({
    error: 'oidc_schema_not_applied',
    message: 'Wren ID is not set up on this instance — scripts/b233-authentik-oidc-schema.sql has not been applied to this database.',
  });
}

function requireRoostManager(req, res, next) {
  if (portalOf(req) !== 'admin') return res.status(404).json({ error: 'Not found' });
  return requireManager(req, res, next);
}

// GET /api/auth/oidc/enrolment/parents — who is enrolled, invited, or neither?
router.get('/enrolment/parents', authenticate, requireRoostManager, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `WITH addresses AS (
         SELECT DISTINCT lower(ppa.email) AS email
           FROM parent_portal_access ppa
          WHERE ppa.is_active = true AND ppa.email IS NOT NULL AND ppa.email <> ''
       )
       SELECT a.email,
              (SELECT count(*) FROM parent_portal_access p
                WHERE lower(p.email) = a.email AND p.is_active = true)          AS access_rows,
              i.last_login_at,
              i.login_count,
              i.revoked,
              inv.status      AS invite_status,
              inv.created_at  AS invite_created_at,
              inv.expires_at  AS invite_expires_at
         FROM addresses a
         LEFT JOIN parent_oidc_identities i
                ON i.provider = $1 AND lower(i.parent_email) = a.email
         LEFT JOIN LATERAL (
                SELECT status, created_at, expires_at
                  FROM parent_enrolment_invites e
                 WHERE lower(e.parent_email) = a.email
                 ORDER BY e.created_at DESC LIMIT 1
              ) inv ON true
        ORDER BY a.email`,
      [PROVIDER]
    );

    const parents = rows.map((r) => ({
      email: r.email,
      access_rows: Number(r.access_rows),
      state: r.revoked ? 'revoked'
        : r.last_login_at ? 'enrolled'
          : r.invite_status === 'sent' ? 'invited'
            : r.invite_status === 'generated' ? 'invite_ready'
              : 'never',
      last_login_at: r.last_login_at,
      login_count: Number(r.login_count || 0),
      invite_status: r.invite_status || null,
      invite_created_at: r.invite_created_at || null,
      invite_expires_at: r.invite_expires_at || null,
    }));

    const counts = parents.reduce((acc, p) => { acc[p.state] = (acc[p.state] || 0) + 1; return acc; }, {});
    const cfg = core.providerConfig(PROVIDER);
    res.json({
      total: parents.length,
      counts,
      parents,
      provider_enabled: cfg.enabled,
      parent_sso_enabled: parentSsoEnabled(),
      send_enabled: inviteSendEnabled(),
    });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/oidc/enrolment/invitations — what has been prepared so far.
router.get('/enrolment/invitations', authenticate, requireRoostManager, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, parent_email, status, batch, note, created_at, created_by,
              expires_at, sent_at, enrolled_at, revoked_at
         FROM parent_enrolment_invites
        ORDER BY created_at DESC, id DESC
        LIMIT 500`
    );
    res.json({ invitations: rows, send_enabled: inviteSendEnabled() });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/oidc/enrolment/invitations — GENERATE enrolment links.
//
// Body: { emails: ['a@b.com', ...], batch: 'baby-room-2026-09' }
//   or  { all_unenrolled: true, batch: '...' }
//
// Generates one link per address, stores only its sha256, and returns the raw
// links ONCE to the calling manager. It does not email anyone: `sent: false` is
// in every response, and the only way that becomes true is Toby setting
// WREN_OIDC_INVITE_SEND=on, which is a separate decision recorded in the b233
// NOTES. Wren's outbound mail path is src/lib/gmail-sender.js on
// COMMS_MAILBOX=admin@ — we are not standing up a second mail identity for this.
router.post('/enrolment/invitations', authenticate, requireRoostManager, async (req, res) => {
  const db = getPool();
  const batch = (req.body && req.body.batch ? String(req.body.batch) : '').slice(0, 60) || null;
  const note = (req.body && req.body.note ? String(req.body.note) : '').slice(0, 200) || null;

  let emails = [];
  try {
    if (req.body && req.body.all_unenrolled === true) {
      const { rows } = await db.query(
        `SELECT DISTINCT lower(ppa.email) AS email
           FROM parent_portal_access ppa
           LEFT JOIN parent_oidc_identities i
                  ON i.provider = $1 AND lower(i.parent_email) = lower(ppa.email)
          WHERE ppa.is_active = true
            AND ppa.email IS NOT NULL AND ppa.email <> ''
            AND (i.id IS NULL OR i.last_login_at IS NULL)
          ORDER BY 1`,
        [PROVIDER]
      );
      emails = rows.map((r) => r.email);
    } else {
      const raw = (req.body && Array.isArray(req.body.emails)) ? req.body.emails : [];
      emails = raw.map((e) => String(e || '').toLowerCase().trim()).filter(Boolean);
      if (!emails.length) return res.status(400).json({ error: 'emails[] or all_unenrolled required' });
      // Only addresses that are ALREADY an active parent here. A manager cannot
      // mint an enrolment link for an arbitrary address, which would be a way to
      // hand somebody a credential that later matches a family record.
      const { rows } = await db.query(
        `SELECT DISTINCT lower(email) AS email FROM parent_portal_access
          WHERE is_active = true AND lower(email) = ANY($1::text[])`,
        [emails]
      );
      const known = new Set(rows.map((r) => r.email));
      const unknown = emails.filter((e) => !known.has(e));
      if (unknown.length) return res.status(400).json({ error: 'unknown_parent_addresses', count: unknown.length });
    }
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!emails.length) return res.json({ generated: 0, sent: false, invitations: [] });

  // The link needs an absolute base or it is not a link. Refusing here rather
  // than emitting "/if/flow/…?itoken=…" matters: a half-formed link written to
  // a file is exactly the kind of thing that gets emailed to 74 families and
  // silently fails for every one of them.
  const base = (process.env.WREN_OIDC_ENROL_BASE || '').trim().replace(/\/+$/, '')
    || (core.providerConfig(PROVIDER).issuer || '').replace(/\/application\/o\/[^/]+\/?$/, '');
  if (!base) {
    return res.status(400).json({
      error: 'enrolment_base_not_configured',
      message: 'Set WREN_OIDC_ISSUER (or WREN_OIDC_ENROL_BASE) before generating enrolment links — '
             + 'without it the links have no host and would not work.',
    });
  }
  const expires = new Date(Date.now() + INVITE_TTL_MS);
  const out = [];

  try {
    for (const email of emails) {
      const token = crypto.randomBytes(32).toString('base64url');
      await db.query(
        `INSERT INTO parent_enrolment_invites
           (parent_email, token_hash, status, created_by, expires_at, batch, note)
         VALUES ($1,$2,'generated',$3,$4,$5,$6)`,
        [email, core.sha256(token), req.user.id, expires, batch, note]
      );
      // The enrolment link points at Authentik's own enrolment flow, carrying
      // the one-time token. Returned to the manager here and never stored raw.
      out.push({ email, link: `${base}/if/flow/wren-parent-enrolment/?itoken=${token}` });
    }
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // Also drop them to a file so the person doing the comms is not copy-pasting
  // out of a browser. DEV ONLY, and enforced rather than intended: if this
  // server is pointed at the production `wren` database, nothing is written to
  // disk at all. Raw enrolment links on a filesystem are a credential store;
  // they belong on a dev box while the process is being rehearsed, and nowhere
  // near prod without Toby deciding that separately.
  let fileWritten = null;
  const isProdDb = (process.env.PG_DB || 'wren') === 'wren';
  if (!isProdDb) {
    try {
      const dir = (process.env.WREN_OIDC_INVITE_DIR || '/tmp/wren-b233-invites');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const name = `invites-${batch || 'unbatched'}-${expires.toISOString().slice(0, 10)}.txt`;
      const file = path.join(dir, name);
      fs.writeFileSync(file,
        `# b233 parent enrolment links — GENERATED, NOT SENT\n` +
        `# generated ${new Date().toISOString()} by staff id ${req.user.id}\n` +
        `# expires ${expires.toISOString()}  batch=${batch || '-'}\n` +
        `# Each link is single-use and is NOT recoverable from the database.\n\n` +
        out.map((o) => `${o.email}\t${o.link}`).join('\n') + '\n',
        { mode: 0o600 });
      fileWritten = file;
    } catch (e) {
      // A failed file write must not lose the links — they are already in the
      // response, which is the authoritative copy.
      fileWritten = null;
    }
  }

  recordAudit({
    req, action: 'create', entity_type: 'parent_enrolment_invites',
    meta: { change: 'oidc_enrolment_invites_generated', count: out.length, batch, sent: false, file: fileWritten },
  });

  res.json({
    file: fileWritten,
    generated: out.length,
    // Phase 1 truth, stated in the response so no caller can mistake it.
    sent: false,
    send_enabled: inviteSendEnabled(),
    expires_at: expires,
    invitations: out,
    note: 'Generated only — nothing has been emailed. Links are shown once and are not recoverable.',
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// b292 — STAFF WREN ID ENROLMENT. Roost only, manager only, ONE SEND PER PRESS.
//
// Implements wren-docs/decisions/2026-09-08-authentik-go-live.md option 2.
// Wren ID went live on 2026-09-08 with 18 staff accounts and no way for any of
// them to sign in: no password, authentik's SMTP a deliberate dead sink, and no
// recovery flow. This is the missing half — Wren mints an authentik invitation
// and posts the link through src/lib/gmail-sender.js, so there is still exactly
// one mail identity.
//
// ⚠️ THERE IS NO CRON HERE AND THERE MUST NEVER BE ONE.
//    Every send is a manager pressing a button, per press. See
//    wren-docs/decisions/2026-09-08-no-auto-parent-email.md — that decision is
//    about parents, but these are 18 real people's personal inboxes and the
//    discipline is the same. Nothing in this file is scheduled, retried in the
//    background, or triggered by a state change.
//
// WHAT AN INVITATION IS AND IS NOT
//    It is a single-use, expiring authentik invitation, pinned to the staff
//    enrolment flow and carrying the staff member's email + id. It lets ONE
//    named person put a password on an account that ALREADY EXISTS. It cannot
//    create an account (the flow's user_write is never_create), cannot be used
//    twice (single_use), cannot be used late (expires), and cannot be pointed at
//    a different flow.
//    It grants NOTHING in Wren. Sign-in still goes through resolveStaffForOidc
//    above, which re-reads ladn.staff every time; an authentik account with a
//    brand-new password and no active staff row gets exactly nowhere.
//
// GDPR: these endpoints return staff names, addresses and enrolment state —
// employment data the manager screen already shows. Nothing about a child or a
// family passes through here, and no invitation link is ever stored or logged.
// ═════════════════════════════════════════════════════════════════════════════
const ak = require('../lib/authentik-admin');
const { composeInviteEmail, sendInviteEmail } = require('../lib/wren-id-invite');
// b306 — the SAME function that runs when a starter is approved. The button on
// this screen and the automatic attempt must never diverge.
const { provisionWrenId } = require('../lib/wren-id-provision');

// A fortnight. Long enough that a part-time member of staff who is off for a
// week still gets to it; short enough that a link sitting unread in an inbox
// stops being a credential reasonably soon. Same window as the parent one.
const STAFF_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** A slug authentik will accept as an invitation `name` (validate_slug). */
function inviteName(staffId) {
  return `wren-staff-${Number(staffId)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Where the email says they will sign in afterwards. */
/**
 * login-20261023 — where the set-up email tells THIS person to sign in.
 * It used to be Roost for everyone, but Roost admits only its allowlisted
 * managers (and Cloudflare in front of it only their addresses), so most staff
 * were sent somewhere that turned them away. Roost people keep Roost; everyone
 * else gets the HR portal (the staff portal on a phone), derived from the
 * Roost address when it is admin.<domain>, or WREN_HR_URL when set.
 */
async function staffPortalUrlFor(req, staffId, role) {
  const roost = roostUrlFor(req);
  if (role === 'accountant') return roost;   // b480: Roost (via Wren ID) is the accountant's only door
  try {
    if (await require('../lib/roost-allowlist').isRoostAllowed(staffId)) return roost;
  } catch (_) { return roost; }
  const explicit = (process.env.WREN_HR_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '') + '/';
  const hrHost = (process.env.HR_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (hrHost) return `https://${hrHost}/`;
  const m = /^https:\/\/admin\.([^/]+)\/$/.exec(roost);
  return m ? `https://hr.${m[1]}/` : roost;
}

function roostUrlFor(req) {
  const explicit = (process.env.WREN_ROOST_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '') + '/';
  const host = (process.env.ADMIN_DOMAIN || '').trim();
  if (host) return `https://${host.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/`;
  return 'https://admin.example-nursery.co.uk/';
}

/**
 * Kill a live invitation, in authentik first and then in Wren.
 *
 * Order matters. If the authentik delete fails we must NOT mark the Wren row
 * revoked, because the link would still work while the screen said it did not.
 * Returns true when the row was closed.
 */
async function revokeLiveInvite(db, row, { by, reason }) {
  try {
    await ak.deleteInvitationByName(row.invitation_name);
  } catch (e) {
    // 404 is success: a redeemed or expired invitation is as dead as a deleted
    // one, and deleteInvitationByName already returns false rather than throwing
    // when it simply is not there. EVERY other failure — and especially status 0,
    // which is "authentik did not answer" — is re-thrown, because the caller must
    // not go on to mark the Wren row revoked while the link still works.
    if (!(e instanceof ak.AuthentikError) || e.status !== 404) throw e;
  }
  await db.query(
    `UPDATE staff_enrolment_invites
        SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoked_reason = $3
      WHERE id = $1 AND status IN ('sent','opened')`,
    [row.id, by || null, String(reason || '').slice(0, 120) || null]
  );
  return true;
}

/**
 * Bring Wren's view of every outstanding invitation up to date with what
 * actually happened on the other side of the exchange.
 *
 * Wren knows it posted a link, and it knows when somebody signed in to Wren.
 * The two steps in between happen inside authentik, so authentik's own audit
 * log is the honest source for them:
 *   invitation still listed      → nobody has followed the link yet
 *   gone, and the window is open → it was followed (authentik deletes a
 *                                  single-use invitation the moment it is
 *                                  redeemed, which is BEFORE the password is
 *                                  chosen — so this is 'opened', not 'done')
 *   gone, and the window closed  → it expired unopened
 *   password_set event for them  → they finished
 *
 * Also closes any invitation belonging to a staff row that is no longer active.
 * That is a security reconciliation, not bookkeeping: a leaver's outstanding
 * link should stop working the moment anyone looks, not at the manager's next
 * convenience. It is safe to do on a read because it only ever REMOVES access.
 *
 * Never throws. If authentik is unreachable the screen shows what Wren last
 * knew, flagged as stale, rather than failing.
 */
async function reconcileStaffInvites(db) {
  const out = { ok: false, reason: null, checked: 0, changed: 0 };
  const { rows: live } = await db.query(
    `SELECT i.id, i.staff_id, i.invitation_name, i.token_hash, i.status, i.expires_at,
            i.created_at, i.authentik_user_id, s.is_active AS staff_active
       FROM staff_enrolment_invites i
       LEFT JOIN staff s ON s.id = i.staff_id
      WHERE i.provider = $1 AND i.status IN ('sent','opened')`,
    [PROVIDER]
  );
  out.checked = live.length;
  if (!live.length) { out.ok = true; return out; }

  const cfg = ak.adminConfig();
  if (!cfg.configured) { out.reason = cfg.reason; return out; }

  let invitations;
  let usedByHash;
  try {
    [invitations, usedByHash] = await Promise.all([ak.listInvitationsByName(), ak.inviteUsedByHash()]);
  } catch (e) {
    // 2026-09-23 — "unreachable" was covering two very different faults and sending people to
    // look at the network. Wren ID was answering perfectly; the service-account token simply is
    // not allowed to read /events/events/, which authentik gates behind view_event. Say which.
    if (e instanceof ak.AuthentikError && (e.status === 401 || e.status === 403)) {
      out.reason = 'authentik_forbidden';
      out.detail = 'Wren ID answered, but its API token is not allowed to read the events log '
                 + '(needs the view_event permission on the service account). Enrolment states '
                 + 'below are the last ones Wren recorded.';
    } else {
      out.reason = e instanceof ak.AuthentikError ? 'authentik_unreachable' : 'reconcile_failed';
    }
    return out;
  }
  out.ok = true;

  const now = Date.now();
  for (const row of live) {
    // A leaver's link dies first, whatever else is true of it.
    if (row.staff_active !== true) {
      try {
        await revokeLiveInvite(db, row, { by: null, reason: 'staff row is no longer active' });
        out.changed++;
      } catch (_) { /* authentik unreachable — leave it live and visibly stale */ }
      continue;
    }

    const stillThere = invitations.has(row.invitation_name);
    if (stillThere) continue;                       // posted, untouched

    const openedAt = usedByHash.get(row.token_hash) || null;
    const expired = new Date(row.expires_at).getTime() < now;

    if (!openedAt) {
      if (expired) {
        await db.query(
          `UPDATE staff_enrolment_invites SET status = 'expired' WHERE id = $1 AND status IN ('sent','opened')`,
          [row.id]);
        out.changed++;
      }
      // Gone from the invitation list, not expired, and no invitation_used
      // event to explain it. Two things look like this: authentik's event log
      // has not caught up yet, or somebody deleted the invitation by hand in
      // authentik's own UI. Neither is worth guessing about — the row stays
      // 'sent' and turns into 'expired' on its own when the window closes.
      //
      // (inviteUsedByHash reads the most recent 200 invitation_used events. At
      // eighteen members of staff, invitations are rare enough that an opened
      // one can never fall off the end of that window. On a setting large
      // enough for it to matter, this is the number to raise.)
      continue;
    }

    // It was followed. Did they finish?
    let finishedAt = null;
    try {
      const username = await usernameForInvite(row);
      if (username) finishedAt = await ak.passwordSetAt(username);
      // Only a password set AFTER the invitation went out counts as finishing
      // this enrolment. Somebody who set a password months ago has not.
      if (finishedAt && new Date(finishedAt) < new Date(row.created_at)) finishedAt = null;
    } catch (_) { /* fall back to 'opened' */ }

    if (finishedAt) {
      await db.query(
        `UPDATE staff_enrolment_invites
            SET status = 'enrolled', opened_at = COALESCE(opened_at, $2), enrolled_at = $3
          WHERE id = $1 AND status IN ('sent','opened')`,
        [row.id, openedAt, finishedAt]);
    } else {
      await db.query(
        `UPDATE staff_enrolment_invites
            SET status = 'opened', opened_at = COALESCE(opened_at, $2)
          WHERE id = $1 AND status = 'sent'`,
        [row.id, openedAt]);
    }
    out.changed++;
  }
  return out;
}

// Cache of authentik user pk → username, so reconciling N outstanding
// invitations does not make N lookups. Holds nothing secret, and is bounded:
// past a couple of hundred entries it is cleared rather than grown, because a
// process that runs for months should not accumulate a row per account that has
// ever been invited.
const _usernameCache = new Map();
const USERNAME_CACHE_MAX = 200;
async function usernameForInvite(row) {
  if (!row.authentik_user_id) return null;
  if (_usernameCache.has(row.authentik_user_id)) return _usernameCache.get(row.authentik_user_id);
  const u = await ak.api('GET', `/core/users/${Number(row.authentik_user_id)}/`);
  const name = (u && u.username) || null;
  if (_usernameCache.size >= USERNAME_CACHE_MAX) _usernameCache.clear();
  _usernameCache.set(row.authentik_user_id, name);
  return name;
}

/** The one place the five states in Toby's brief are decided. */
function staffState(r) {
  if (r.link_revoked) return 'revoked';
  if (r.last_login_at) return 'signed_in';
  if (r.invite_status === 'enrolled') return 'password_set';
  if (r.invite_status === 'opened') return 'opened';
  if (r.invite_status === 'sent') {
    return new Date(r.invite_expires_at).getTime() < Date.now() ? 'expired' : 'invited';
  }
  if (r.invite_status === 'expired') return 'expired';
  if (r.invite_status === 'failed') return 'send_failed';
  return 'never';
}

// ── GET /api/auth/oidc/enrolment/staff ───────────────────────────────────────
// Who is actually on Wren ID? Reconciles first, then answers.
router.get('/enrolment/staff', authenticate, requireRoostManager, async (req, res) => {
  const db = getPool();
  let sync = { ok: false, reason: 'not_run' };
  try {
    sync = await reconcileStaffInvites(db);
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    sync = { ok: false, reason: 'reconcile_failed' };
  }

  try {
    const { rows } = await db.query(
      `SELECT s.id, s.first_name, s.last_name, s.email, s.role, s.is_active,
              -- b306. Read through to_jsonb so the screen still works on a
              -- tenant that has not run migrations/2026-09-10-b306-*.sql: a
              -- missing key is NULL here, where a bare column reference would
              -- be a 42703 and blank the whole list.
              to_jsonb(s) ->> 'wren_id_provision_error' AS wren_id_error,
              g.last_login_at, g.login_count, g.revoked AS link_revoked,
              inv.status      AS invite_status,
              inv.created_at  AS invite_created_at,
              inv.expires_at  AS invite_expires_at,
              inv.sent_at     AS invite_sent_at,
              inv.send_error  AS invite_send_error,
              inv.opened_at, inv.enrolled_at
         FROM staff s
         LEFT JOIN staff_google_identities g
                ON g.provider = $1 AND g.staff_id = s.id
         LEFT JOIN LATERAL (
                SELECT status, created_at, expires_at, sent_at, send_error, opened_at, enrolled_at
                  FROM staff_enrolment_invites e
                 WHERE e.provider = $1 AND e.staff_id = s.id
                 ORDER BY e.created_at DESC, e.id DESC LIMIT 1
              ) inv ON true
        WHERE s.is_active = true
        ORDER BY lower(s.first_name), lower(s.last_name), s.id`,
      [PROVIDER]
    );

    // One call, not one per person: does each address have an account to enrol?
    let accounts = null;
    const cfg = ak.adminConfig();
    if (cfg.configured) {
      try { accounts = await ak.usersByEmail(); } catch (_) { accounts = null; }
    }

    const staff = rows.map((r) => {
      const email = String(r.email || '').toLowerCase().trim();
      const account = accounts && email ? accounts.get(email) || null : null;
      const state = staffState(r);
      const blocked = !email ? 'no_email'
        : accounts && !account ? 'no_wren_id_account'
          : account && account.is_active === false ? 'wren_id_account_inactive'
            : null;
      return {
        id: r.id,
        name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        email,
        role: r.role,
        state,
        // The whole point of the screen: Toby needs to see who is actually on it.
        invited_at: r.invite_created_at || null,
        expires_at: r.invite_expires_at || null,
        // sent_at null with a live invitation means the link was minted but the
        // email did not leave this instance (dev, or a Gmail failure). Said
        // plainly rather than shown as a successful invitation.
        email_left: !!r.invite_sent_at,
        send_error: r.invite_send_error || null,
        opened_at: r.opened_at || null,
        enrolled_at: r.enrolled_at || null,
        last_login_at: r.last_login_at || null,
        login_count: Number(r.login_count || 0),
        has_wren_id_account: accounts ? !!account : null,
        can_invite: !blocked,
        blocked_reason: blocked,
        // b306 — why the last attempt to open their account failed, in the words
        // the manager needs (it names the missing authentik permission when that
        // is what it was). Only shown while they still have no account: once one
        // exists, a stale note about a failed attempt is just noise.
        account_error: (blocked === 'no_wren_id_account' && r.wren_id_error) ? r.wren_id_error : null,
        // Whether this row's button can do anything. Creating an account needs
        // the admin API just as inviting does.
        can_create_account: blocked === 'no_wren_id_account',
      };
    });

    const counts = staff.reduce((a, s) => { a[s.state] = (a[s.state] || 0) + 1; return a; }, {});
    const oidc = core.providerConfig(PROVIDER);
    res.json({
      total: staff.length,
      counts,
      staff,
      provider_enabled: oidc.enabled,
      provider_reason: oidc.reason,
      admin_configured: cfg.configured,
      admin_reason: cfg.reason,
      // False means the states below are Wren's last known view, not authentik's
      // current one. Never presented as fresh when it is not.
      in_sync: !!sync.ok,
      sync_reason: sync.reason || null,
      sync_detail: sync.detail || null,     // 2026-09-23 — plain words when it is a permission, not a network fault
    });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/oidc/enrolment/staff/invite ───────────────────────────────
// Body: { staff_ids: [1,2,3] }  — one id for a single send, several for a bulk
// send over a selection. There is no "all staff" shortcut on purpose: a bulk
// send is a manager choosing people, not a button that mails everyone.
//
// Per staff member, in this order, stopping at the first failure:
//   1. the ladn.staff row must exist, be ACTIVE, and have an address
//   2. an authentik account must already exist for that address and be active
//      (this endpoint never creates one — scripts/b296-authentik-seed-staff.js
//      does that, deliberately separately)
//   3. any live invitation for them is DELETED first, so a re-send never leaves
//      two working links. The database refuses two live rows as well.
//   4. mint, store the non-secret handles, email the link
router.post('/enrolment/staff/invite', authenticate, requireRoostManager, async (req, res) => {
  const db = getPool();
  const raw = (req.body && Array.isArray(req.body.staff_ids)) ? req.body.staff_ids : [];
  const ids = [...new Set(raw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return res.status(400).json({ error: 'staff_ids[] required' });
  if (ids.length > 100) return res.status(400).json({ error: 'too many at once (max 100)' });

  const cfg = ak.adminConfig();
  if (!cfg.configured) {
    return res.status(503).json({
      error: 'authentik_admin_not_configured',
      reason: cfg.reason,
      message: cfg.reason === 'no_api_token'
        ? 'Wren has no authentik API token — set WREN_AUTHENTIK_API_TOKEN (or put it in the ops secrets file) before sending invitations.'
        : 'Wren does not know where authentik is — set WREN_OIDC_ISSUER or WREN_AUTHENTIK_BASE.',
    });
  }
  if (!ak.enrolBase()) {
    return res.status(400).json({
      error: 'enrolment_base_not_configured',
      message: 'Set WREN_OIDC_ISSUER (or WREN_OIDC_ENROL_BASE) first — without it the link has no host and would not work for anyone.',
    });
  }

  let staffRows;
  try {
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, email, is_active, role FROM staff WHERE id = ANY($1::int[])`, [ids]);
    staffRows = rows;
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    return res.status(500).json({ error: 'Internal server error' });
  }
  const byId = new Map(staffRows.map((r) => [Number(r.id), r]));

  // Wren only ever writes to a *_dev database on a dev box, and the Gmail
  // transport hard-disables itself there. Returning the link in that one case
  // is what makes the flow testable end to end without a second mail identity;
  // on production this stays false and no link is ever in a response body.
  const devEcho = /_dev$/i.test(process.env.PG_DB || '');

  const results = [];
  for (const id of ids) {
    const s = byId.get(id);
    const label = s ? `${s.first_name || ''} ${s.last_name || ''}`.trim() : `staff ${id}`;
    const email = String((s && s.email) || '').toLowerCase().trim();

    if (!s) { results.push({ staff_id: id, name: label, ok: false, reason: 'no_such_staff' }); continue; }
    if (s.is_active !== true) { results.push({ staff_id: id, name: label, ok: false, reason: 'staff_inactive' }); continue; }
    if (!email) { results.push({ staff_id: id, name: label, ok: false, reason: 'no_email' }); continue; }

    try {
      const account = await ak.findUserByEmail(email);
      if (!account) { results.push({ staff_id: id, name: label, ok: false, reason: 'no_wren_id_account' }); continue; }
      if (account.is_active === false) { results.push({ staff_id: id, name: label, ok: false, reason: 'wren_id_account_inactive' }); continue; }

      // 3. Kill whatever is outstanding BEFORE minting. If this throws we stop
      //    here for this person rather than adding a second live link.
      const { rows: liveRows } = await db.query(
        `SELECT id, invitation_name FROM staff_enrolment_invites
          WHERE provider = $1 AND staff_id = $2 AND status IN ('sent','opened')`,
        [PROVIDER, id]);
      for (const row of liveRows) {
        await revokeLiveInvite(db, row, { by: req.user.id, reason: 're-sent by a manager' });
      }

      const expires = new Date(Date.now() + STAFF_INVITE_TTL_MS);
      const name = inviteName(id);
      const inv = await ak.createStaffInvitation({ name, email, staffId: id, expires });

      const { rows: [stored] } = await db.query(
        `INSERT INTO staff_enrolment_invites
           (staff_id, staff_email, provider, invitation_name, token_hash, authentik_user_id,
            status, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'sent',$7,$8)
         RETURNING id`,
        [id, email, PROVIDER, inv.name, ak.invitationHash(inv.uuid), account.pk, req.user.id, expires]);

      const parts = composeInviteEmail({
        firstName: s.first_name,
        link: inv.link,
        expires,
        portalUrl: await staffPortalUrlFor(req, id, s.role),
        // Signed by whoever pressed the button. "Reply to this and I'll send a
        // fresh one" is only a real offer if it reaches a person who knows what
        // it is about, and a nursery is small enough that it always should.
        senderName: String(req.user.name || '').trim().split(/\s+/)[0] || 'the office',
      });
      const sent = await sendInviteEmail(email, parts);

      if (sent.sent) {
        await db.query('UPDATE staff_enrolment_invites SET sent_at = now() WHERE id = $1', [stored.id]);
      } else if (sent.disabled) {
        // Dev / MAIL_DISABLED. The invitation is real and stays live so the flow
        // can be walked; the row stays 'sent' (so the one-live-invitation rule
        // still holds and a re-send still invalidates it) but sent_at is NULL,
        // which is how the screen knows nothing actually left the building.
        await db.query('UPDATE staff_enrolment_invites SET send_error = $2 WHERE id = $1',
          [stored.id, 'mail disabled on this instance — nothing was sent']);
      } else {
        // A real send failure. A link nobody received is just an unnecessary
        // live credential, so it goes.
        try { await ak.deleteInvitationByName(inv.name); } catch (_) { /* best effort */ }
        await db.query(
          `UPDATE staff_enrolment_invites SET status = 'failed', send_error = $2 WHERE id = $1`,
          [stored.id, String(sent.error || 'send failed').slice(0, 300)]);
        results.push({ staff_id: id, name: label, ok: false, reason: 'email_failed', detail: sent.error });
        continue;
      }

      recordAudit({
        req, action: 'create', entity_type: 'staff', entity_id: id,
        meta: {
          change: 'wren_id_invitation_sent', provider: PROVIDER,
          invitation_name: inv.name, expires_at: expires.toISOString(),
          emailed: !!sent.sent, by: req.user.id,
        },
      });

      results.push({
        staff_id: id, name: label, ok: true,
        emailed: !!sent.sent,
        mail_disabled: !!sent.disabled,
        expires_at: expires,
        // Dev only, and only when the email genuinely did not leave.
        link: (devEcho && sent.disabled) ? inv.link : undefined,
      });
    } catch (e) {
      const reason = e instanceof ak.AuthentikError ? 'authentik_error' : 'internal_error';
      results.push({ staff_id: id, name: label, ok: false, reason, detail: e.message });
    }
  }

  const sentCount = results.filter((r) => r.ok && r.emailed).length;
  res.json({
    requested: ids.length,
    sent: sentCount,
    prepared: results.filter((r) => r.ok && !r.emailed).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
});

// ── POST /api/auth/oidc/enrolment/staff/:staff_id/revoke ─────────────────────
// Kill an outstanding invitation without sending a new one — someone left, or a
// link went to the wrong address. Does NOT touch an account that has already
// enrolled: revoking a Wren ID that is in use is DELETE /link/:staff_id above,
// which is a different decision with a different audit line.
router.post('/enrolment/staff/:staff_id/revoke', authenticate, requireRoostManager, async (req, res) => {
  const staffId = Number(req.params.staff_id);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'bad staff_id' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id, invitation_name FROM staff_enrolment_invites
        WHERE provider = $1 AND staff_id = $2 AND status IN ('sent','opened')`,
      [PROVIDER, staffId]);
    if (!rows.length) return res.status(404).json({ error: 'No outstanding invitation for this staff member' });

    const cfg = ak.adminConfig();
    if (!cfg.configured) {
      return res.status(503).json({ error: 'authentik_admin_not_configured', reason: cfg.reason });
    }
    for (const row of rows) {
      await revokeLiveInvite(db, row, {
        by: req.user.id,
        reason: (req.body && req.body.reason ? String(req.body.reason) : 'revoked by a manager').slice(0, 120),
      });
    }
    recordAudit({
      req, action: 'update', entity_type: 'staff', entity_id: staffId,
      meta: { change: 'wren_id_invitation_revoked', provider: PROVIDER, count: rows.length, by: req.user.id },
    });
    res.json({ ok: true, revoked: rows.length });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    if (e instanceof ak.AuthentikError) {
      return res.status(502).json({ error: 'authentik_error', message: e.message });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/oidc/enrolment/staff/:staff_id/account ────────────────────
// b306 — "Create their Wren ID".
//
// Toby, 2026-09-10: "And what exactly do you mean with she'll need the seed
// script run how do I do that."
//
// This is that question's answer, on the screen where the question gets asked.
// Approving a starter already does this automatically; this button exists for
// the two cases where the automatic attempt could not: authentik was down at the
// moment of approval, or the person predates the automatic attempt entirely
// (everyone the b296 seeder never reached).
//
// It calls the SAME function the approval does — no password, no email, no
// modification of an account that already exists. Pressing it for somebody who
// already has an account is a no-op that reports "they already had one", which
// is why it is safe to press twice.
router.post('/enrolment/staff/:staff_id/account', authenticate, requireRoostManager, async (req, res) => {
  const staffId = Number(req.params.staff_id);
  if (!Number.isInteger(staffId) || staffId <= 0) return res.status(400).json({ error: 'bad staff_id' });

  const cfg = ak.adminConfig();
  if (!cfg.configured) {
    return res.status(503).json({
      error: 'authentik_admin_not_configured',
      reason: cfg.reason,
      message: cfg.reason === 'no_api_token'
        ? 'Wren has no authentik API token — set WREN_AUTHENTIK_API_TOKEN (or put it in the ops secrets file) before creating accounts.'
        : 'Wren does not know where authentik is — set WREN_OIDC_ISSUER or WREN_AUTHENTIK_BASE.',
    });
  }

  const r = await provisionWrenId(getPool(), staffId, req);
  if (r.ok) return res.json(r);

  // A missing permission is a 502 with the permission NAMED. A bare 403 from
  // authentik cost an afternoon on 2026-09-10; nobody should have to guess
  // which of a dozen permissions the service account is short of.
  const status = r.reason === 'no_such_staff' ? 404
    : r.reason === 'staff_inactive' || r.reason === 'no_email' ? 409
      : 502;
  return res.status(status).json(r);
});

module.exports = router;
module.exports.resolveStaffForOidc = resolveStaffForOidc;
module.exports.resolveParentForOidc = resolveParentForOidc;
module.exports.STAFF_PORTALS = STAFF_PORTALS;
module.exports.staffPortalUrlFor = staffPortalUrlFor;
module.exports.STAFF_INVITE_TTL_MS = STAFF_INVITE_TTL_MS;
// b292 — exported so scripts/b292-verify.js drives the real reconciler and the
// real state machine rather than a copy of them. These must stay BELOW
// `module.exports = router`, which replaces the exports object wholesale.
module.exports.reconcileStaffInvites = reconcileStaffInvites;
module.exports.staffState = staffState;
