'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b292 — the small slice of Authentik's admin API that Wren actually uses.
//
// Implements wren-docs/decisions/2026-09-08-authentik-go-live.md option 2:
// Wren mints the enrolment invitation itself and posts the link through
// src/lib/gmail-sender.js, so Authentik never needs SMTP credentials and the
// nursery keeps ONE mail identity — b233's standing instruction.
//
// WHAT THIS MODULE IS ALLOWED TO DO, and nothing else:
//   • look a staff account up by address or by Wren staff id
//   • create / list / delete an enrolment invitation
//   • read two kinds of audit event back (invitation_used, password_set)
//   • b306: CREATE an account for a newly activated member of staff, and put it
//     in wren-staff — see ensureAccountForStaff() at the bottom of this file.
// There is still deliberately no set-password, no delete-user, and no MODIFYING
// an existing account. Wren does not administer people in Authentik; it opens an
// account for somebody who now works here and hands them one link to finish
// setting themselves up. Everything after that is theirs.
//
// WHY NOT THE OIDC CLIENT CREDENTIALS: those are for the sign-in exchange and
// carry no admin rights. This needs an API token, which is a different and much
// more powerful thing — hence the rules below.
//
// THE TOKEN
//   Read from WREN_AUTHENTIK_API_TOKEN, or, failing that, ONE grepped line of
//   /run/secrets/authentik.env (mounted read-only into the container).
//   It is never logged, never returned by any route, never put in a URL, and
//   never included in an error message — errors carry the HTTP status and the
//   first line of the body only. Toby should mint a dedicated Authentik service
//   account + token for this rather than leave it on the bootstrap token; the
//   env var exists so that is a config change, not a code change.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const crypto = require('crypto');

const SECRETS_FILE = process.env.WREN_AUTHENTIK_ENV_FILE || '/run/secrets/authentik.env';
const TOKEN_KEYS = ['WREN_AUTHENTIK_API_TOKEN', 'AUTHENTIK_BOOTSTRAP_TOKEN'];
const TIMEOUT_MS = 12000;

// Cached because the file is on a read-only mount and re-reading it on every
// request would be a syscall per staff row on the manager screen.
let _cachedToken;

/**
 * Grep ONE variable out of the secrets file. Never reads it into a log, never
 * returns the rest of the file, and treats a missing file as "not configured"
 * rather than as an error — most instances of Wren have no Authentik at all.
 */
function tokenFromFile() {
  try {
    const raw = fs.readFileSync(SECRETS_FILE, 'utf8');
    for (const key of TOKEN_KEYS) {
      const line = raw.split('\n').find((l) => l.startsWith(`${key}=`));
      if (line) {
        const v = line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
        if (v) return v;
      }
    }
  } catch (_) { /* absent or unreadable — not configured */ }
  return null;
}

function apiToken() {
  if (_cachedToken !== undefined) return _cachedToken;
  const fromEnv = (process.env.WREN_AUTHENTIK_API_TOKEN || '').trim();
  _cachedToken = fromEnv || tokenFromFile() || null;
  return _cachedToken;
}

function __resetTokenCache() { _cachedToken = undefined; }

/**
 * The issuer is `<base>/application/o/<slug>/`, so the base is what is left when
 * that tail is removed. Both the API host and the host that appears in the
 * emailed link default to it, and both can be overridden — they are not always
 * the same thing (the API may be loopback while the link must be public).
 */
function baseFromIssuer() {
  const issuer = (process.env.WREN_OIDC_ISSUER || '').trim();
  if (!issuer) return '';
  return issuer.replace(/\/+$/, '').replace(/\/application\/o\/[^/]+$/, '');
}

function adminBase() {
  return ((process.env.WREN_AUTHENTIK_BASE || '').trim() || baseFromIssuer()).replace(/\/+$/, '');
}

/** The host that goes in the email. Must be reachable from a phone, not from here. */
function enrolBase() {
  return ((process.env.WREN_OIDC_ENROL_BASE || '').trim() || baseFromIssuer()).replace(/\/+$/, '');
}

/**
 * Is the admin API usable? Separated from "is Wren ID switched on" because the
 * two fail for different reasons and a manager needs to be told which.
 */
function adminConfig() {
  const base = adminBase();
  const hasToken = !!apiToken();
  return {
    base,
    enrol_base: enrolBase(),
    configured: !!base && hasToken,
    reason: !base ? 'no_authentik_base' : !hasToken ? 'no_api_token' : null,
  };
}

class AuthentikError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AuthentikError';
    this.status = status || 0;
  }
}

async function api(method, path, body) {
  const cfg = adminConfig();
  if (!cfg.configured) throw new AuthentikError(`authentik admin API not configured (${cfg.reason})`, 0);
  const url = `${cfg.base}/api/v3${path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      signal: ac.signal,
      headers: Object.assign(
        { Authorization: `Bearer ${apiToken()}`, Accept: 'application/json' },
        body === undefined ? {} : { 'Content-Type': 'application/json' }
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new AuthentikError(`authentik unreachable: ${e.name === 'AbortError' ? 'timed out' : e.message}`, 0);
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  if (!resp.ok) {
    // First line of the body only. Authentik's errors are short and specific;
    // the full body can echo back what was sent, which for an invitation would
    // be somebody's address.
    const first = String(text || '').split('\n')[0].slice(0, 200);
    throw new AuthentikError(`${method} ${path} → HTTP ${resp.status}${first ? ` ${first}` : ''}`, resp.status);
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { return {}; }
}

// ── Identity lookups ─────────────────────────────────────────────────────────

/**
 * The Authentik account for an address, or null. Exact, case-insensitive match
 * on the address — never a fuzzy search, because the result decides who an
 * invitation is minted for.
 */
async function findUserByEmail(email) {
  const lower = String(email || '').toLowerCase().trim();
  if (!lower) return null;
  const res = await api('GET', `/core/users/?email=${encodeURIComponent(lower)}&page_size=50`);
  const hit = (res.results || []).find((u) => String(u.email || '').toLowerCase() === lower);
  return hit || null;
}

/**
 * Every account, keyed by lower-cased address. ONE call, not one per person —
 * the manager screen asks this question about every member of staff at once.
 *
 * Pages until authentik says there is no more, rather than trusting a single
 * large page_size: a setting with more accounts than fit in one page would
 * otherwise show "no Wren ID account yet" against real people, and the manager
 * would have no way to tell that from the truth.
 */
async function usersByEmail() {
  const map = new Map();
  for (let page = 1; page <= 20; page++) {
    const res = await api('GET', `/core/users/?page_size=200&page=${page}`);
    for (const u of res.results || []) {
      const e = String(u.email || '').toLowerCase();
      if (e) map.set(e, u);
    }
    const p = res.pagination || {};
    if (!p.next || p.next === page || page >= (p.total_pages || 1)) break;
  }
  return map;
}

// ── Invitations ──────────────────────────────────────────────────────────────

/**
 * sha256 of an invitation uuid, dashes stripped and lower-cased.
 *
 * Authentik reports the uuid two ways — dashed in the URL it accepts, and as
 * .hex in the invitation_used event — so both are normalised to the same thing
 * before hashing or the event would never match the row it belongs to.
 */
function invitationHash(uuid) {
  return crypto.createHash('sha256')
    .update(String(uuid || '').replace(/-/g, '').toLowerCase())
    .digest('hex');
}

/**
 * Mint ONE single-use, expiring invitation pinned to one flow and one person.
 *
 * Every one of those four words is load-bearing:
 *   single_use   authentik deletes it the moment it is redeemed, so a link that
 *                has been used cannot be used again — not by the holder, and
 *                not by anyone who later finds the email.
 *   expires      a link that is never opened stops working on its own.
 *   flow         it can only drive the staff enrolment flow. Pointed at any
 *                other flow it is simply not found.
 *   fixed_data   carries wren_staff_email + wren_staff_id, which the flow's
 *                policy checks against a real, active, wren-staff account. The
 *                person redeeming never types an address, so there is nothing
 *                for them to change.
 *
 * Returns { name, uuid, expires, link } — `uuid` and `link` are CREDENTIALS.
 * They are handed to the email composer and must never be stored or logged.
 */
async function createStaffInvitation({ name, email, staffId, expires, flowSlug = 'wren-staff-enrolment' }) {
  const flows = await api('GET', `/flows/instances/?slug=${encodeURIComponent(flowSlug)}`);
  const flow = (flows.results || []).find((f) => f.slug === flowSlug);
  if (!flow) throw new AuthentikError(`enrolment flow '${flowSlug}' does not exist — run bootstrap.sh`, 0);

  const created = await api('POST', '/stages/invitation/invitations/', {
    name,
    expires: new Date(expires).toISOString(),
    single_use: true,
    flow: flow.pk,
    fixed_data: {
      wren_staff_email: String(email).toLowerCase(),
      wren_staff_id: Number(staffId),
    },
  });
  const uuid = created.pk;
  return {
    name: created.name,
    uuid,
    expires: created.expires,
    link: `${enrolBase()}/if/flow/${flowSlug}/?itoken=${uuid}`,
  };
}

/** Every invitation still alive, keyed by name. Expired ones are already gone. */
async function listInvitationsByName() {
  const res = await api('GET', '/stages/invitation/invitations/?page_size=500');
  const map = new Map();
  for (const inv of res.results || []) map.set(inv.name, inv);
  return map;
}

/**
 * Delete an invitation by its slug name. Returns true if one went, false if
 * there was nothing there — which is not a failure: an invitation that has
 * already been redeemed or has expired is exactly as dead as one we deleted.
 */
async function deleteInvitationByName(name) {
  const res = await api('GET', `/stages/invitation/invitations/?name=${encodeURIComponent(name)}&page_size=10`);
  const hit = (res.results || []).find((i) => i.name === name);
  if (!hit) return false;
  await api('DELETE', `/stages/invitation/invitations/${hit.pk}/`);
  return true;
}

// ── Audit events — how Wren knows what actually happened ─────────────────────
//
// Authentik's own event log is the honest source for the two things Wren cannot
// see for itself. Wren knows it POSTED a link and it knows somebody signed IN;
// what happens in between happens on the other side of the exchange.

/**
 * invitation_used events, newest first, as a Map of hash → ISO timestamp.
 * Matched by hash so Wren never has to hold the uuid to recognise its own
 * invitations.
 */
async function inviteUsedByHash(limit = 200) {
  const res = await api('GET', `/events/events/?action=invitation_used&page_size=${limit}`);
  const map = new Map();
  for (const ev of res.results || []) {
    const uuid = ev.context && ev.context.invitation_uuid;
    if (!uuid) continue;
    const h = invitationHash(uuid);
    // Newest wins; the API already returns newest first.
    if (!map.has(h)) map.set(h, ev.created);
  }
  return map;
}

/** When did this account last set a password? null if it never has. */
async function passwordSetAt(username) {
  if (!username) return null;
  const res = await api('GET',
    `/events/events/?action=password_set&username=${encodeURIComponent(username)}&page_size=1`);
  const ev = (res.results || [])[0];
  return ev ? ev.created : null;
}

// ── b306 — creating the account, once, from wherever the starter arrives ─────
//
// Toby, 2026-09-10: "And what exactly do you mean with she'll need the seed
// script run how do I do that."
//
// That question is the bug. Onboarding a starter already does five things in one
// click; her identity account was a sixth that needed somebody to remember
// `node scripts/b296-authentik-seed-staff.js --apply` at a terminal. Nobody will.
//
// So the create-and-group logic that used to live inside that script lives HERE
// now, and the script and POST /approve/:id both call it. One function, so the
// two can never drift into producing subtly different accounts — same group,
// same wren_staff_id attribute, same everything.
//
// WHAT THIS DELIBERATELY STILL WILL NOT DO, and why the header above is still
// true in spirit:
//   • it never MODIFIES an existing account. A real person may have changed
//     their own name or password; finding one is a success, not a conflict.
//   • it never sets a password and never sends mail. A credential is a separate,
//     explicit act — POST /enrolment/staff/invite — done by a named manager.
//   • it never deletes anybody.
// The service account's authentik role is what actually enforces that (it holds
// add_user but NOT change_user, so a PATCH from here is refused by authentik
// itself, not merely by our own good intentions). This is belt AND braces.

/**
 * ACTIVATION, not creation, is the trigger for an account existing: somebody who
 * has a staff row but has never been activated does not work here yet.
 */
const STAFF_GROUP = 'wren-staff';

/**
 * Which authentik permission a 403 was actually about.
 *
 * A bare "HTTP 403" from authentik cost an afternoon on 2026-09-10, because the
 * body says nothing about which of a dozen permissions was missing. Every call
 * this module makes is listed here, so the manager's screen can name the exact
 * permission to grant the `wren-invitations` role instead of saying "forbidden".
 */
const PERMISSION_FOR = [
  [/^POST \/core\/users\/$/,               'authentik_core.add_user'],
  [/^POST \/core\/groups\/[^/]+\/add_user\/$/, 'authentik_core.add_user_to_group'],
  [/^GET \/core\/users\//,                 'authentik_core.view_user'],
  [/^GET \/core\/groups\//,                'authentik_core.view_group'],
  [/^GET \/flows\/instances\//,            'authentik_flows.view_flow'],
  [/^(POST|DELETE) \/stages\/invitation\//, 'authentik_stages_invitation.add_invitation / delete_invitation'],
];

/** null unless this really was a permissions refusal. */
function permissionFor(method, path) {
  const key = `${method} ${path}`;
  for (const [re, perm] of PERMISSION_FOR) if (re.test(key)) return perm;
  return null;
}

/**
 * The same call as api(), but a 403 comes back naming the permission rather than
 * as a bare status. Used only by the account-creation path — every other caller
 * in this file predates it and reads fine as-is.
 */
async function apiNamingPermission(method, path, body) {
  try {
    return await api(method, path, body);
  } catch (e) {
    if (e instanceof AuthentikError && e.status === 403) {
      const perm = permissionFor(method, path);
      if (perm) {
        const named = new AuthentikError(
          `authentik refused ${method} ${path} (HTTP 403). The Wren service account is missing the ` +
          `'${perm}' permission — grant it to the 'wren-invitations' role in authentik ` +
          `(Directory → Roles → wren-invitations → Permissions).`, 403);
        named.permission = perm;
        throw named;
      }
    }
    throw e;
  }
}

/**
 * An account already stamped with this Wren staff id, or null.
 *
 * MATCHED ON THE STAFF ID, NOT THE ADDRESS, and that ordering is load-bearing:
 * Toby is moving staff onto personal addresses (2026-09-08), and matching on
 * email alone would read a changed address as a new person and create a second
 * account for somebody who already has one. The staff id does not change.
 *
 * (Queried twice because an attribute written by an older run could be stored as
 * a string; two cheap GETs beat creating a duplicate account for a real person.)
 */
async function findUserByStaffId(staffId) {
  for (const v of [Number(staffId), String(staffId)]) {
    const q = encodeURIComponent(JSON.stringify({ wren_staff_id: v }));
    const res = await apiNamingPermission('GET', `/core/users/?attributes=${q}&page_size=10`);
    const hit = (res.results || []).find(
      (u) => u.attributes && String(u.attributes.wren_staff_id) === String(staffId));
    if (hit) return hit;
  }
  return null;
}

/**
 * A username authentik will accept and nobody else already holds.
 *
 * The local part of the address, as the seeder has always done — but a nursery
 * can genuinely employ two people whose addresses differ only after the @, and
 * authentik's username is unique. Colliding would fail the create with a 400 on
 * the day a starter joins, so the staff id is appended instead.
 */
async function freeUsername(email, staffId) {
  const base = String(email).split('@')[0].replace(/[^a-z0-9._-]/gi, '').toLowerCase() || `staff${staffId}`;
  for (const candidate of [base, `${base}-${staffId}`, `staff${staffId}`]) {
    const res = await apiNamingPermission('GET', `/core/users/?username=${encodeURIComponent(candidate)}&page_size=5`);
    const taken = (res.results || []).some((u) => String(u.username || '').toLowerCase() === candidate);
    if (!taken) return candidate;
  }
  return `staff${staffId}-${Date.now().toString(36)}`;
}

/**
 * Make sure this member of staff has a Wren ID account. Idempotent.
 *
 * @param {number} staffId
 * @param {object} [opts]
 * @param {object} [opts.db]        pg pool/client. Defaults to Wren's own pool —
 *                                  the seeder passes its own, because it runs on
 *                                  the host against a database this process has
 *                                  no configuration for.
 * @param {boolean} [opts.requireActive=true]  refuse somebody who is not active.
 *                                  Approval flips is_active BEFORE calling this,
 *                                  so an inactive row here means a mistake.
 * @param {boolean} [opts.apply=true]  false = report what would happen, write
 *                                  nothing. This is the seeder's dry run.
 *
 * Returns, and NEVER throws for an expected outcome:
 *   { ok, created, existed, grouped, pk, reason, permission, message }
 * `reason` is a machine word ('no_such_staff' | 'staff_inactive' | 'no_email' |
 * 'not_configured' | 'group_missing' | 'authentik_error'); `message` is the
 * sentence a manager reads. Nothing personal is in either.
 */
async function ensureAccountForStaff(staffId, opts = {}) {
  const id = Number(staffId);
  const apply = opts.apply !== false;
  const requireActive = opts.requireActive !== false;
  const out = { ok: false, created: false, existed: false, grouped: false, pk: null,
                reason: null, permission: null, message: null, staff_id: id };
  if (!Number.isInteger(id) || id <= 0) {
    return Object.assign(out, { reason: 'no_such_staff', message: 'No such staff record.' });
  }

  const cfg = adminConfig();
  if (!cfg.configured) {
    return Object.assign(out, {
      reason: 'not_configured', message: cfg.reason === 'no_api_token'
        ? 'Wren has no authentik API token, so it cannot create a Wren ID account.'
        : 'Wren does not know where authentik is, so it cannot create a Wren ID account.',
    });
  }

  const db = opts.db || require('../db/pool').getPool();
  let s;
  try {
    const { rows } = await db.query(
      'SELECT id, first_name, last_name, email, role, is_active FROM staff WHERE id = $1', [id]);
    s = rows[0];
  } catch (e) {
    return Object.assign(out, { reason: 'db_error', message: 'Could not read the staff record.' });
  }
  if (!s) return Object.assign(out, { reason: 'no_such_staff', message: 'No such staff record.' });
  if (requireActive && s.is_active !== true) {
    return Object.assign(out, { reason: 'staff_inactive',
      message: 'This staff record is not active, so no Wren ID account was created.' });
  }
  const email = String(s.email || '').toLowerCase().trim();
  if (!email) {
    return Object.assign(out, { reason: 'no_email',
      message: 'There is no email address on this staff record, so there is nothing to create an account against.' });
  }

  try {
    // 1. Already there? Then we are done, and we touch NOTHING.
    let user = await findUserByStaffId(id);
    if (!user) user = await findUserByEmail(email);
    if (user) {
      out.existed = true;
      out.pk = user.pk;
    } else if (!apply) {
      return Object.assign(out, { ok: true, created: true,
        message: 'Would create a Wren ID account (dry run — nothing was written).' });
    } else {
      const username = await freeUsername(email, id);
      user = await apiNamingPermission('POST', '/core/users/', {
        username,
        name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || username,
        email,
        is_active: true,
        type: 'internal',
        attributes: { wren_staff_id: id, wren_role: s.role },
      });
      out.created = true;
      out.pk = user.pk;
    }

    // 2. wren-staff membership. The enrolment flow's policy refuses an account
    //    that is not in it, so an account outside the group cannot be given a
    //    credential — which would look exactly like this build not working.
    const groups = await apiNamingPermission('GET', `/core/groups/?name=${encodeURIComponent(STAFF_GROUP)}&page_size=5`);
    const group = (groups.results || []).find((g) => g.name === STAFF_GROUP);
    if (!group) {
      return Object.assign(out, { ok: !!out.pk, reason: 'group_missing',
        message: `The '${STAFF_GROUP}' group does not exist in authentik — run bootstrap.sh. ` +
                 'The account exists but cannot be given a set-up link until it is in that group.' });
    }
    const already = (user.groups || []).some((g) => String(g) === String(group.pk));
    if (!already && apply) {
      await apiNamingPermission('POST', `/core/groups/${group.pk}/add_user/`, { pk: user.pk });
      out.grouped = true;
    }

    out.ok = true;
    out.message = out.created ? 'Wren ID account created.' : 'They already had a Wren ID account.';
    return out;
  } catch (e) {
    const permission = e && e.permission ? e.permission : null;
    return Object.assign(out, {
      // An account that was created before a later step failed is still an
      // account — say so, rather than reporting a clean failure and inviting a
      // retry that would look for a duplicate.
      ok: false,
      reason: e instanceof AuthentikError ? 'authentik_error' : 'internal_error',
      permission,
      message: e && e.message ? String(e.message).slice(0, 400) : 'Wren ID account creation failed.',
    });
  }
}

module.exports = {
  adminConfig,
  AuthentikError,
  api,
  findUserByEmail,
  usersByEmail,
  invitationHash,
  createStaffInvitation,
  listInvitationsByName,
  deleteInvitationByName,
  inviteUsedByHash,
  passwordSetAt,
  // b306 — one function, called by both the route and the seeder script.
  ensureAccountForStaff,
  findUserByStaffId,
  STAFF_GROUP,
  enrolBase,
  __resetTokenCache,
};
