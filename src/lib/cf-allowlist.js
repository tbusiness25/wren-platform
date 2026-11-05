'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// cf-allowlist.js — the parents' Cloudflare Access allowlist, b342 (2026-09-21).
//
// SUPERSEDES scripts/sync-cf-allowlist.js FOR THE TWO CALLERS IN src/ (children.js, admin.js).
// b342 left the script alone because /app/scripts in prod is bind-mounted from the dev checkout
// (/app/scripts), so an edit there reaches prod unreviewed. login-20261023 replaces it,
// on its branch, with a thin wrapper over this module, and moves the daily push into the prod
// container (src/jobs/access-list-sync.js). Ship note: merge to dev AND remove the 07:17 crontab line.
//
// WHAT CHANGED, AND WHY
//   Cloudflare Access is what actually admits a parent, and the policy behind it is REPLACED wholesale
//   from a list built from children.parent_1_email / parent_2_email. So the moment a family changes the
//   address they sign in with, the next sync (any child edit triggers one) drops the OLD address at the
//   edge — before the new one has been used, and whether or not it works. That defeats "keep the old
//   access until the new address has been used" however carefully the database rows are kept.
//   This builder adds one thing: while a sign-in switch is pending (parent_portal_access.replaces_email),
//   BOTH addresses are in the list. When the switch settles, the next sync drops the old one.
//   Everything else in the list is byte-for-byte what the script produced.
//
// TWO SAFETY CHANGES the script did not have:
//   · No CF_API_TOKEN → refuse before any network call (the script sent "Bearer undefined").
//   · An EMPTY list is never pushed. Replacing the policy with nobody in it locks every parent out.
// ─────────────────────────────────────────────────────────────────────────────
const https = require('https');
const { getPool } = require('../db/pool');

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID || 'c5938349df9631350005df526c70c6b5';
const CF_POLICY_ID = 'c65482da-5644-4cac-a48a-12df42f3d123';
const EMAIL_RE = /^[^@]+@[^@]+\.[^@]+$/;

/** The addresses the policy should hold. Pure DB — safe to call from a test. */
async function buildAllowlist(db = getPool()) {
  const { rows } = await db.query(`
    SELECT DISTINCT lower(trim(email)) AS email FROM (
      SELECT parent_1_email AS email FROM children WHERE is_active = true AND parent_1_email IS NOT NULL AND parent_1_email != ''
      UNION
      SELECT parent_2_email FROM children WHERE is_active = true AND parent_2_email IS NOT NULL AND parent_2_email != ''
    ) e WHERE lower(trim(email)) ~ '^[^@]+@[^@]+\\.[^@]+$'`);
  const emails = new Set(rows.map(r => r.email));

  // A pending sign-in switch keeps BOTH ends admitted. A database that has not been migrated has no such
  // column; that is not an error, it just means there is nothing pending.
  let pending = [];
  try {
    const r = await db.query(`
      SELECT lower(trim(pa.email)) AS email FROM parent_portal_access pa JOIN children c ON c.id = pa.child_id
       WHERE pa.is_active = true AND pa.replaces_email IS NOT NULL AND c.is_active = true
      UNION
      SELECT lower(trim(pa.replaces_email)) FROM parent_portal_access pa JOIN children c ON c.id = pa.child_id
       WHERE pa.is_active = true AND pa.replaces_email IS NOT NULL AND c.is_active = true`);
    pending = r.rows.map(x => x.email);
  } catch (e) {
    if (e.code !== '42703') console.error('[cf-allowlist] pending-switch lookup failed:', e.message);
  }
  for (const e of pending) if (e && EMAIL_RE.test(e)) emails.add(e);

  // b399 (2026-10-06) — "enquiry mode": a family on the pipeline but not yet
  // enrolled signs in with an active parent_portal_access row whose child is
  // a PROVISIONAL one (is_active=false, status='enquiry'), so the ACTIVE-
  // children union above never reaches them. Without this they are admitted
  // once (the manual grant / the acknowledgement-email flow) and then wiped
  // out at the very next 07:17 sync.
  let enquiryEmails = [];
  try {
    const r = await db.query(`
      SELECT lower(trim(pa.email)) AS email FROM parent_portal_access pa
        JOIN children c ON c.id = pa.child_id
       WHERE pa.is_active = true AND pa.access_level = 'enquiry' AND c.status = 'enquiry'`);
    enquiryEmails = r.rows.map(x => x.email);
  } catch (e) {
    console.error('[cf-allowlist] enquiry-mode lookup failed:', e.message);
  }
  for (const e of enquiryEmails) if (e && EMAIL_RE.test(e)) emails.add(e);

  // 2026-10-08 — two families were being turned away at Cloudflare:
  //  • a current family whose sign-in address is only on parent_portal_access (not on
  //    parent_1/2_email) — the app admits them, the edge didn't;
  //  • LEAVERS with a live memory book. The 07:17 script admitted parent_1/2 only, and this
  //    library (run on every child edit) admitted no leavers at all — so a family emailed the
  //    keepsake at their billing address, or at an address typed in on Send, clicked the link
  //    and was blocked. Keep EVERY address the family uses for as long as the book is live:
  //    parent_1/2, billing, portal sign-ins, the address it was sent to, and any address a
  //    manager added with "Restore access" (leavers_gift_packages.extra_emails).
  //  (login-20261023: the script now calls this module — there is no second copy to keep in step.)
  const more = [
    `SELECT lower(trim(pa.email)) AS email FROM parent_portal_access pa JOIN children c ON c.id = pa.child_id
      WHERE c.is_active = true AND pa.is_active = true AND COALESCE(pa.access_level, 'full') <> 'enquiry'`,
    `SELECT lower(trim(e)) AS email FROM leavers_gift_packages g JOIN children c ON c.id = g.child_id,
            unnest(ARRAY[c.parent_1_email, c.parent_2_email, c.primary_contact_email, g.sent_to]) AS e
      WHERE g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > now())`,
    `SELECT lower(trim(pa.email)) AS email FROM parent_portal_access pa JOIN leavers_gift_packages g ON g.child_id = pa.child_id
      WHERE g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > now()) AND pa.email NOT LIKE 'erased-%'`,
    `SELECT lower(trim(e)) AS email FROM leavers_gift_packages g, unnest(COALESCE(g.extra_emails, '{}'::text[])) AS e
      WHERE g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > now())`,
  ];
  for (const sql of more) {
    try {
      const r = await db.query(sql);
      for (const x of r.rows) if (x.email && EMAIL_RE.test(x.email)) emails.add(x.email);
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') console.error('[cf-allowlist] lookup failed:', e.message);
    }
  }

  return [...emails].sort();
}

// The Access policy is LADN production's. Only that instance may push it: the dev container
// has the same secrets mount and would otherwise replace every real parent with synthetic
// addresses, and a demo would push its own families. (2026-10-08)
function assertLadnProd() {
  const db = process.env.PG_DB || 'wren';
  let sch = process.env.PG_SCHEMA || 'ladn';
  try { sch = require('../db/connection').schema() || sch; } catch (_) { /* env value stands */ }
  if (db !== 'wren' || sch !== 'ladn' || (process.env.WREN_EDITION && process.env.WREN_EDITION !== 'ladn')) {
    throw new Error(`CF allowlist push refused — only LADN production pushes it (db=${db}, schema=${sch})`);
  }
}

// Prefer the API token, but verify it: it has been invalid since September, which made every
// in-app push fail (new families waited for the 07:17 cron). Fall back to the legacy key pair —
// from env, else from the read-only secrets mount. Never logs a credential.
let _cfAuth = null;
async function cfAuthHeaders() {
  if (_cfAuth) return _cfAuth;
  const token = process.env.CF_API_TOKEN;
  if (token) {
    try {
      const r = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      if (j && j.success) return (_cfAuth = { Authorization: `Bearer ${token}` });
    } catch (_) { /* fall through */ }
  }
  let email = process.env.CF_API_EMAIL, key = process.env.CF_API_KEY;
  if (!(email && key)) {
    try {
      const txt = require('fs').readFileSync(process.env.LADN_OPS_ENV || '/run/secrets/ladn-ops.env', 'utf8');
      const get = (k) => { const m = txt.match(new RegExp(`^(?:export\\s+)?${k}=["']?([^"'\\n]+)`, 'm')); return m ? m[1].trim() : ''; };
      email = email || get('CF_API_EMAIL'); key = key || get('CF_API_KEY');
    } catch (_) { /* no mount */ }
  }
  if (email && key) return (_cfAuth = { 'X-Auth-Email': email, 'X-Auth-Key': key });
  throw new Error('no working Cloudflare credentials (CF_API_TOKEN invalid and no CF_API_EMAIL/CF_API_KEY)');
}

// 2026-10-29 — parents no longer sign in through Cloudflare Access: Wren emails them a code
// (src/routes/auth.js /parent-code/*), the parents app in Cloudflare now lets everyone through,
// and Wren's own gate (server-unified.js, "Parents host") does the refusing. Pushing this list
// would do nothing useful, so the parents half of every sync stops here unless it is switched
// back on — WREN_PARENTS_CF_SYNC=on, part of the rollback in
// wren-docs/decisions/2026-10-29-parent-email-code-login.md. The HR and Roost lists are untouched.
function parentsCfSyncOn() { return String(process.env.WREN_PARENTS_CF_SYNC || '').toLowerCase() === 'on'; }

/** Push the list to Cloudflare. Resolves to the number of addresses in the policy. */
async function syncCFAllowlist() {
  if (!parentsCfSyncOn()) {
    console.log('[cf-allowlist] parents list not pushed — parents sign in with a Wren email code (WREN_PARENTS_CF_SYNC is off)');
    return 0;
  }
  assertLadnProd();
  const auth = await cfAuthHeaders();
  const emails = await buildAllowlist();
  if (!emails.length) throw new Error('refusing to push an empty allowlist — it would lock every parent out');

  const payload = JSON.stringify({
    name: 'LADN Parents Allowlist', decision: 'allow',
    include: emails.map(e => ({ email: { email: e } })), exclude: [], require: [],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4/accounts/${CF_ACCOUNT}/access/policies/${CF_POLICY_ID}`,
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.success) { console.log(`CF allowlist synced: ${emails.length} emails`); resolve(emails.length); }
          else reject(new Error(JSON.stringify(result.errors)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// b480 (2026-10-12) — the ROOST (admin) staff allowlist. Separate from
// buildAllowlist()/syncCFAllowlist() above, which are the PARENTS policy —
// different policy, different audience, never to be confused.
//
// Roost is currently CF Access "toby only", maintained by hand in the CF
// dashboard — nothing in this codebase has ever synced it. Nathan's
// 'accountant' role (b480) is the first staff role that needs to reach Roost
// without being Toby and without sharing Toby's login, so this adds exactly
// that: active accountant-role staff emails, to be included in the Roost
// Access policy by a sync that would run alongside the existing 07:17 parents
// sync. It does NOT widen who can reach Roost at the app layer — that is the
// accountant-scope gate in server-unified.js; this only has to agree with it
// at the edge, or Nathan reaches the login page and gets 403'd by the app
// layer instead of by Cloudflare, which is a worse failure mode, not a safer
// one.
//
// login-20261023: superseded — the Roost list is now synced from Wren's Roost allowlist (below).
// ─────────────────────────────────────────────────────────────────────────────

// login-20261023 — Toby: "create a sync list from Cloudflare for the staff records just like the
// parents list" and Roost "can just be for me and the office manager and the admissions lead" (+ Nathan, a director).
//
// Until now the HR list ("staff-personal-emails", 18 addresses from an old stafflist.csv) and the
// Roost list ("Office managers — the office manager & the admissions lead") were kept by hand in the Cloudflare dashboard. On
// 23 Oct the HR list still admitted two leavers and an address on no staff record, and missed four
// current staff; the office manager and the admissions lead each had a second hand-made rule on HR. From here on Wren is the
// one source and both lists are replaced from it, exactly like the parents list:
//
//   HR    (hr.)    — every ACTIVE staff record with a real email.
//   Roost (admin.) — the people on Wren's Roost allowlist (settings.roost_admin_staff_ids) plus
//                    accountant-role staff (b480). Wren's allowlist is still the real gate; this
//                    only makes the edge agree with it, so nobody reaches a login page that will
//                    refuse them.
//
// Toby's own policies ("toby", "Toby work email", the tablets' service token, the nursery-IP
// bypass) are never touched: they are his way back in if a sync ever went wrong.
//
// Safety, on top of the parents push's: the current list is read first, and a push that would
// REMOVE more than max(3, 25%) of it is refused unless forced — a bad query must not empty the
// staff list the morning after a deploy.

const HR_POLICY_ID   = process.env.CF_HR_POLICY_ID   || '49f963ef-005a-4c27-80b1-511953f9213e'; // reusable, on the HR app
const ADMIN_APP_ID   = process.env.CF_ADMIN_APP_ID   || '27d5573b-e790-445c-b32a-53538afbb430';
const ROOST_POLICY_ID = process.env.CF_ROOST_POLICY_ID || 'e0c051dd-7782-4d34-8256-2721a5fe5a09'; // app-scoped, on the admin app
// Addresses that can never receive a code: fixtures, examples. Kept out of every staff list.
const NOT_DELIVERABLE = /(\.invalid|\.test|\.example|\.localhost|@example\.(com|org|net))$/i;

/** Every active, real (not is_demo) member of staff with a deliverable email — the HR list. */
async function buildStaffAllowlist(db = getPool()) {
  const { rows } = await db.query(`
    SELECT DISTINCT lower(trim(email)) AS email FROM staff
     WHERE is_active = true AND NOT COALESCE(is_demo, false) AND email IS NOT NULL AND trim(email) <> ''`);
  return rows.map(r => r.email).filter(e => EMAIL_RE.test(e) && !NOT_DELIVERABLE.test(e)).sort();
}

/** The Roost list: Wren's Roost allowlist (ids) + accountant-role staff. Active only. */
async function buildRoostAllowlist(db = getPool()) {
  // The one reader of settings.roost_admin_staff_ids (it always includes the owner, id 1).
  const { ids: allow } = await require('./roost-allowlist').getRoostAllowlist();
  const ids = allow && allow.length ? allow : [1];
  const { rows } = await db.query(`
    SELECT DISTINCT lower(trim(email)) AS email FROM staff
     WHERE is_active = true AND NOT COALESCE(is_demo, false) AND email IS NOT NULL AND trim(email) <> ''
       AND (id = ANY($1::int[]) OR role = 'accountant')`, [ids]);
  return rows.map(r => r.email).filter(e => EMAIL_RE.test(e) && !NOT_DELIVERABLE.test(e)).sort();
}

function cfRequest(method, path, body) {
  return cfAuthHeaders().then(auth => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.cloudflare.com', path: `/client/v4/accounts/${CF_ACCOUNT}${path}`, method,
      headers: { ...auth, 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.success) resolve(j.result);
          else reject(new Error(JSON.stringify(j.errors)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  }));
}

/**
 * Replace one Access policy's email list with `emails`, keeping its name, decision and precedence.
 * { dryRun } reports the change without pushing. Returns { count, added, removed, pushed }.
 * Counts only — never logs an address.
 */
async function pushEmailPolicy({ path, name, emails, force = false, dryRun = false, label }) {
  if (!emails.length) throw new Error(`${label}: refusing to push an empty list`);
  const current = await cfRequest('GET', path);
  const before = new Set((current.include || []).filter(r => r.email).map(r => String(r.email.email).toLowerCase()));
  const after = new Set(emails);
  const added = [...after].filter(e => !before.has(e)).length;
  const removed = [...before].filter(e => !after.has(e)).length;
  const limit = Math.max(3, Math.ceil(before.size * 0.25));
  if (removed > limit && !force) {
    throw new Error(`${label}: refusing — this would remove ${removed} of ${before.size} addresses (limit ${limit}). Check Wren's staff records, or force it.`);
  }
  if (dryRun) return { count: after.size, added, removed, pushed: false };
  const body = { name, decision: current.decision || 'allow', include: emails.map(e => ({ email: { email: e } })), exclude: [], require: [] };
  if (current.precedence != null && /\/apps\//.test(path)) body.precedence = current.precedence;
  await cfRequest('PUT', path, body);
  console.log(`[cf-allowlist] ${label} synced: ${after.size} addresses (+${added} / -${removed})`);
  return { count: after.size, added, removed, pushed: true };
}

/** HR list from active staff. */
async function syncStaffAllowlist(opts = {}) {
  assertLadnProd();
  return pushEmailPolicy({ ...opts, label: 'HR staff list', name: 'LADN Staff (synced from Wren)',
    path: `/access/policies/${HR_POLICY_ID}`, emails: await buildStaffAllowlist() });
}

/** Roost list from Wren's Roost allowlist. Replaces the b480 accountant-only version, which needed an env id. */
async function syncRoostAllowlist(opts = {}) {
  assertLadnProd();
  return pushEmailPolicy({ ...opts, label: 'Roost list', name: 'Roost — managers & office (synced from Wren)',
    path: `/access/apps/${ADMIN_APP_ID}/policies/${ROOST_POLICY_ID}`, emails: await buildRoostAllowlist() });
}

/**
 * login-20261023 — the ONE Cloudflare client for every caller in Wren (Roost's Access Control
 * page, access-grants, Login health, the syncs). They each had their own fetch wrapper reading
 * CF_API_TOKEN alone, which has been invalid since September — so the Access Control page and
 * the enquiry/access-request grants have been failing quietly. This uses the same verified
 * credential fallback as the syncs. Never throws; returns { ok, result } or
 * { ok:false, needs_token, error, status } — the shape those callers already expect.
 */
async function cfApi(path, { method = 'GET', body } = {}) {
  let auth;
  try { auth = await cfAuthHeaders(); }
  catch (e) { return { ok: false, needs_token: true, error: e.message }; }
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4' + path, {
      method, headers: { ...auth, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.success) {
      const msg = (j.errors && j.errors[0] && j.errors[0].message) || `HTTP ${r.status}`;
      return { ok: false, needs_token: r.status === 401 || r.status === 403, error: msg, status: r.status };
    }
    return { ok: true, result: j.result };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Policies Wren replaces wholesale every morning — a hand edit to one would be undone at 07:17. */
const SYNCED_POLICY_IDS = new Set([CF_POLICY_ID, HR_POLICY_ID, ROOST_POLICY_ID]);

/** All three lists, one after another; one failing does not stop the others. */
async function syncAllAccessLists(opts = {}) {
  const out = {};
  for (const [k, fn] of [['parents', () => syncCFAllowlist().then(n => ({ count: n, pushed: true }))],
                         ['staff', () => syncStaffAllowlist(opts)], ['roost', () => syncRoostAllowlist(opts)]]) {
    if (k === 'parents' && opts.dryRun) { out[k] = { skipped: 'dry run' }; continue; }
    if (k === 'parents' && !parentsCfSyncOn()) { out[k] = { skipped: 'parents sign in with a Wren email code' }; continue; }
    try { out[k] = await fn(); } catch (e) { out[k] = { error: e.message }; console.error(`[cf-allowlist] ${k}:`, e.message); }
  }
  return out;
}

// A staff record changed (new starter, leaver, email edit): push the staff lists shortly after.
// Debounced so a bulk edit is one push. LADN production only, like every push here.
let _staffTimer = null;
function scheduleStaffSync(delayMs = 15000) {
  try { assertLadnProd(); } catch (_) { return; }
  clearTimeout(_staffTimer);
  _staffTimer = setTimeout(() => {
    syncStaffAllowlist().catch(e => console.error('[cf-allowlist] staff (after edit):', e.message));
    syncRoostAllowlist().catch(e => console.error('[cf-allowlist] roost (after edit):', e.message));
  }, delayMs);
  if (_staffTimer.unref) _staffTimer.unref();
}

// login-20261023: cfAuthHeaders exported (additive) so src/lib/login-health.js can READ the Access
// policies with the same verified-credential fallback. It never writes with it.
module.exports = { buildAllowlist, syncCFAllowlist, buildRoostAllowlist, syncRoostAllowlist, cfAuthHeaders, CF_ACCOUNT,
  buildStaffAllowlist, syncStaffAllowlist, syncAllAccessLists, scheduleStaffSync, cfApi, SYNCED_POLICY_IDS, parentsCfSyncOn };
