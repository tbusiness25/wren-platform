'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b320 — "View as": the one place a view-as session is recognised and refused.
//
// THE PROBLEM TOBY ASKED ABOUT
//   "Sometimes it will be showing on their account but not on ours." A manager
//   needs to see Finch (parents) or Seed (HR) exactly as that person sees it.
//   The two ways to do that are a master password, or this.
//
// WHY NOT A MASTER PASSWORD
//   One secret that opens every account. Shared by nature, unrevocable in
//   practice, and — the part that actually matters — invisible: every login
//   looks like the real person, so afterwards nobody can tell whether a parent
//   or the manager sent that message. A view-as session carries BOTH identities
//   in the token, so the audit trail never loses the second one.
//
// THE SHAPE
//   sub          = the person being viewed (id / role / scope / children — all
//                  theirs, unchanged, so their own permissions still apply and
//                  viewing as a practitioner reveals nothing a practitioner
//                  cannot already see)
//   vas          = the session id, matching a row in ladn.view_as_sessions
//   impersonated_by = the manager's staff id
//   30 minutes, no refresh, and every mutating method refused server-side.
//
// READ-ONLY IS ENFORCED HERE, NOT IN THE UI
//   `viewAsGuard` is mounted once, on /api, before every router in
//   editions/ladn/server-unified.js — so a route added tomorrow inherits it
//   without anyone remembering to. Hiding buttons is presentation; this is the
//   control. scripts/b320-view-as-sweep.js drives every POST/PUT/PATCH/DELETE
//   route in the app through it and asserts 403 on each.
//
// WHAT THIS DOES NOT TOUCH
//   Cloudflare Access. The manager still passes CF Access as themselves to
//   reach the origin at all; the Wren session inside is the subject's. The
//   2026-07-21 CF-JWT verification and the b239 parent resolver are unchanged —
//   this adds a cookie the resolver reads FIRST, and removes no check from it.
// ─────────────────────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getPool } = require('../db/pool');

// A cookie of its own rather than overwriting `wren_parent`. If a manager
// happens to be a parent here too, their real session survives the 30 minutes
// and is still there when they exit.
const VIEW_AS_COOKIE = 'wren_view_as';
const SESSION_MS   = 30 * 60 * 1000;  // the whole session. There is no refresh.
const HANDOFF_MS   = 2  * 60 * 1000;  // the one-time code that opens the tab.
const LIVE_TTL_MS  = 15 * 1000;       // cache of "is this session still live?"

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The only mutating endpoints a view-as session may call. Exiting must work
// from inside the session (that is the whole point of the Exit button), and
// redeeming happens on the target host where a previous session's cookie may
// still be sitting.
const ALLOWED_WHILE_VIEWING = new Set([
  '/api/view-as/exit',
  '/api/view-as/redeem',
]);

// GET endpoints that are not reads.
//
// /api/auth/cf-auto-login is deliberately NOT on this list, and the reason is
// worth writing down because blocking it was the obvious move and it was wrong.
// Six Finch pages — messages, community, documents, resources, learning-journey,
// home-activities — BOOT by calling it and mint a token they use for one call.
// Refusing it turned those six into "We couldn't find your child linked to this
// email", which is the exact kind of "shows on their account but not ours"
// confusion this build exists to remove. It is handled instead at the top of
// the route in src/routes/auth.js, which hands back the session's OWN token
// rather than minting anything: no new authority, no new expiry, no refresh
// cookie. Everything that actually mints — /login, /parent-login, /totp,
// /refresh, the SSO exchanges — is a POST and is refused by the rule below.
const DENIED_GETS = new Set([]);

// ── Reading the session off a request ────────────────────────────────────────
// Deliberately parses the Cookie header itself rather than depending on
// cookieParser: this guard is mounted before it, so that no router — including
// the public ones mounted early — sits in front of the gate.
function _cookie(req, name) {
  if (req.cookies && req.cookies[name]) return String(req.cookies[name]);
  const raw = req.headers && req.headers.cookie;
  if (!raw) return '';
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); }
      catch { return part.slice(i + 1).trim(); }
    }
  }
  return '';
}

function rawTokenOf(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const x = String(req.headers['x-wren-token'] || '').trim();
  if (x) return x;
  return _cookie(req, VIEW_AS_COOKIE);
}

/**
 * The view-as claims on this request, or null.
 *
 * The signature is checked; the audience deliberately is NOT. A view-as token
 * replayed on the wrong portal will be refused by that portal's own audience
 * check a few middlewares later — but it must be recognised as a view-as token
 * HERE first, or it would slip past the read-only gate on its way to that 401.
 */
function claimsOf(req) {
  // Cached on the request: the guard, the banner injector, the audit stamp and
  // cf-auto-login all ask, and this runs on EVERY request on every portal.
  // The cost when nobody is viewing as anybody is a cookie-header scan; when a
  // bearer token IS present it is one extra HMAC verify per request on top of
  // the one `authenticate` does. That is the price of a gate that cannot be
  // routed around, and it is paid once, here.
  if (req._viewAsClaims !== undefined) return req._viewAsClaims;
  let out = null;
  const raw = rawTokenOf(req);
  if (raw) {
    try {
      const d = jwt.verify(raw, process.env.JWT_SECRET);
      if (d && d.vas && d.impersonated_by != null) out = d;
    } catch { out = null; }
  }
  req._viewAsClaims = out;
  return out;
}

// ── Is the session still live? ───────────────────────────────────────────────
// The JWT expiry is the hard stop, but a manager can also end a session from
// Roost and the Exit button ends it for everyone — so the row is the authority.
// Cached briefly: a page load is several requests, and a revocation taking up
// to fifteen seconds is a fair trade for not querying on every one of them.
const _liveCache = new Map();
let _liveSweep = 0;

async function sessionRow(jti) {
  const now = Date.now();
  if (now - _liveSweep > 60000) {
    for (const [k, v] of _liveCache) if (now - v.at > LIVE_TTL_MS) _liveCache.delete(k);
    _liveSweep = now;
  }
  const hit = _liveCache.get(jti);
  if (hit && now - hit.at < LIVE_TTL_MS) return hit.row;
  let row = null;
  try {
    const { rows } = await getPool().query(
      `SELECT id, jti, actor_staff_id, actor_name, subject_kind, subject_staff_id,
              subject_email, subject_label, portal, started_at, expires_at, ended_at
         FROM view_as_sessions WHERE jti = $1`, [jti]);
    row = rows[0] || null;
  } catch {
    // Could not look is not the same as not there — but this gate only ever
    // *narrows* what a request may do, so a DB outage must not silently turn a
    // view-as session into a full one. Treat it as live.
    row = { unknown: true };
  }
  _liveCache.set(jti, { at: now, row });
  return row;
}

function invalidate(jti) {
  if (jti) _liveCache.delete(jti);
  else _liveCache.clear();
}

function isLive(row) {
  if (!row) return false;
  if (row.unknown) return true;
  if (row.ended_at) return false;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return false;
  return true;
}

// ── The guard ────────────────────────────────────────────────────────────────
/**
 * viewAsGuard — mounted once on /api, ahead of every router.
 *
 *   • no view-as token            → next(), nothing changes for anybody
 *   • session ended or expired    → 401, with a reason the banner can act on
 *   • GET / HEAD / OPTIONS        → next(), and the request is attributed
 *   • anything else               → 403 view_as_read_only
 */
async function viewAsGuard(req, res, next) {
  const c = claimsOf(req);
  if (!c) return next();

  const path0 = (req.originalUrl || req.url || '').split('?')[0];

  // The banner's own status call is answered whether the session is live or
  // over — it is how the bar learns to say "this session has ended" instead of
  // silently never appearing while the page behind it 401s on everything.
  const isStatus = path0 === '/api/view-as/session' && (req.method === 'GET' || req.method === 'HEAD');

  const row = await sessionRow(c.vas);
  if (!isLive(row) && !isStatus) {
    return res.status(401).json({
      error: 'view_as_ended',
      message: 'This view-as session has ended. Close the tab and start a new one from Roost.',
    });
  }

  req.viewAs = {
    jti: c.vas,
    session_id: row && row.id,
    by: c.impersonated_by,
    by_name: c.impersonated_by_name || null,
    subject_label: (row && row.subject_label) || c.name || null,
    portal: (row && row.portal) || null,
  };

  const path = path0;
  const method = (req.method || 'GET').toUpperCase();

  if (isStatus) return next();
  if (ALLOWED_WHILE_VIEWING.has(path)) return next();

  if (MUTATING.has(method) || DENIED_GETS.has(path)) {
    console.warn(`[view-as] refused ${method} ${path} — session ${c.vas} (staff ${c.impersonated_by} viewing ${row && row.subject_kind})`);
    logPageView(req, path, method, 403);
    return res.status(403).json({
      error: 'view_as_read_only',
      message: 'You are viewing this account as someone else. Nothing can be changed, sent or saved from here.',
    });
  }
  return next();
}

// ── Audit ────────────────────────────────────────────────────────────────────
/**
 * One row per page looked at AND per write refused. Both belong in the record:
 * "they opened the fees page" and "they tried to send a message and were
 * stopped" are the two things anyone reading this back will want to know.
 *
 * The session's `page_views` counter deliberately counts only the first kind,
 * so a sweep of two thousand refused writes does not read as two thousand pages
 * of someone's private diary. The refusals are still every one of them on the
 * detail list, marked blocked.
 *
 * Fire-and-forget; never blocks a request.
 */
function logPageView(req, path, method, status) {
  const v = req.viewAs;
  if (!v || !v.session_id) return;
  const p = String(path || '').slice(0, 500);
  const counts = !status || status < 400;
  getPool().query(
    `INSERT INTO view_as_page_views (session_id, method, path, status) VALUES ($1,$2,$3,$4)`,
    [v.session_id, String(method || 'GET').slice(0, 10), p, status || null]
  ).then(() => (counts
    ? getPool().query(`UPDATE view_as_sessions SET page_views = page_views + 1 WHERE id = $1`, [v.session_id])
    : null
  )).catch((e) => console.error('[view-as] page-view write failed:', e.message));
}

// ── Minting ──────────────────────────────────────────────────────────────────
function newJti()  { return crypto.randomBytes(24).toString('hex'); }
function newCode() { return crypto.randomBytes(32).toString('base64url'); }
function hashCode(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }

/**
 * mintToken — the session token. Same secret, same audience rules and the same
 * claim names as an ordinary session, plus the three that make it a view-as:
 * `vas`, `impersonated_by`, `read_only`.
 */
function mintToken(subjectClaims, { jti, portal, actorId, actorName }) {
  return jwt.sign(
    {
      ...subjectClaims,
      vas: jti,
      impersonated_by: Number(actorId),
      impersonated_by_name: actorName || null,
      read_only: true,
    },
    process.env.JWT_SECRET,
    { expiresIn: Math.floor(SESSION_MS / 1000), audience: portal }
  );
}

function setCookie(req, res, token) {
  res.cookie(VIEW_AS_COOKIE, token, {
    httpOnly: true,
    secure: req.secure === true,
    sameSite: 'Lax',
    maxAge: SESSION_MS,
    path: '/',
  });
}

function clearCookie(res) {
  res.clearCookie(VIEW_AS_COOKIE, { path: '/' });
}

// ── Who may never be viewed as ───────────────────────────────────────────────
// A manager viewing as another manager is one manager wearing another's
// authority with no second person in the room; and id 1 is the owner, whose
// account is never impersonable by anyone at all.
const PROTECTED_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'owner', 'headteacher']);

function refusalFor(staffRow) {
  if (!staffRow) return 'That staff record does not exist.';
  if (Number(staffRow.id) === 1) return 'The owner’s account can never be viewed as.';
  if (staffRow.is_active === false) return 'That staff member is not active.';
  if (PROTECTED_ROLES.has(String(staffRow.role || '').toLowerCase())) {
    return 'A manager cannot view as another manager.';
  }
  return null;
}

module.exports = {
  VIEW_AS_COOKIE, SESSION_MS, HANDOFF_MS, MUTATING,
  ALLOWED_WHILE_VIEWING, DENIED_GETS, PROTECTED_ROLES,
  claimsOf, rawTokenOf, viewAsGuard, sessionRow, isLive, invalidate,
  logPageView, mintToken, setCookie, clearCookie,
  newJti, newCode, hashCode, refusalFor,
};
