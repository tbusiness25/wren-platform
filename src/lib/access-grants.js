'use strict';
/**
 * access-grants.js  (2026-07-16)
 *
 * Shared grant helpers used by:
 *   - src/routes/access-requests.js  (Feature A: staff access request → manager authorise)
 *   - src/routes/enquiry-portal.js   (Feature B: parents-portal access from an enquiry)
 *
 * Two grant paths:
 *   grantCfAllowlist(email)  — add an email to the Cloudflare Access "LADN Parents
 *                              Allowlist" reusable policy (so the parent passes CF Access).
 *   grantGroupMember(email)  — add an email to the Google Workspace parents@ group
 *                              via the Directory API (service account, DWD).
 *
 * BOTH degrade gracefully. The CF API token is periodically rotated by the owner and
 * may be stale/absent; the Google Directory DWD scopes may not be granted yet. In
 * either case these helpers NEVER throw — they return { ok:false, needs_token, queued,
 * error } so the caller can record the request as approved + the grant as queued, and
 * surface a clear message, rather than crashing the approve flow.
 *
 * Return shape (both helpers):
 *   { ok:true,  changed:bool, already:bool }              — grant applied (or already present)
 *   { ok:false, needs_token:true,  queued:true, error }   — token/scope invalid → queue it
 *   { ok:false, needs_token:false, queued:true, error }   — transient/other error → queue it
 *
 * PRIVACY: never logs the email at info level with any child/parent context; callers
 * store only counts/ids in audit rows. This module is grant-plumbing only.
 */

const fs = require('fs');

// ── Cloudflare Access reusable policy (the parents list src/lib/cf-allowlist.js syncs) ──
const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_ACCOUNT = () => process.env.CF_ACCOUNT_ID || 'c5938349df9631350005df526c70c6b5';
const CF_POLICY_ID = () => process.env.CF_PARENTS_POLICY_ID || 'c65482da-5644-4cac-a48a-12df42f3d123';
// login-20261023: the shared Cloudflare client (src/lib/cf-allowlist.js). This file had its own,
// reading CF_API_TOKEN only — invalid since September — so every grant here has been "queued".
async function cf(path, opts = {}) { return require('./cf-allowlist').cfApi(path, opts); }
/**
 * Add `email` to the CF Access parents allowlist policy (append, preserving the
 * existing include list). Graceful-degrades on invalid/absent token.
 */
async function grantCfAllowlist(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email) return { ok: false, needs_token: false, queued: false, error: 'no email' };
  // 2026-10-29 — parents sign in with a Wren email code, not Cloudflare; nothing to grant there
  // (see parentsCfSyncOn in src/lib/cf-allowlist.js). Their Wren access is the DB row alone.
  if (!require('./cf-allowlist').parentsCfSyncOn()) return { ok: true, changed: false, already: false, skipped: 'wren_email_code' };

  const acct = CF_ACCOUNT();
  const pol = CF_POLICY_ID();

  // Fetch the current policy so we APPEND (never clobber the existing allowlist).
  const cur = await cf(`/accounts/${acct}/access/policies/${pol}`);
  if (!cur.ok) {
    return { ok: false, needs_token: !!cur.needs_token, queued: true, error: cur.error };
  }
  const include = Array.isArray(cur.result.include) ? cur.result.include.slice() : [];
  const present = include.some(r => r && r.email && String(r.email.email || '').toLowerCase() === email);
  if (present) return { ok: true, changed: false, already: true };

  include.push({ email: { email } });
  const body = {
    name: cur.result.name || 'LADN Parents Allowlist',
    decision: cur.result.decision || 'allow',
    include,
    exclude: cur.result.exclude || [],
    require: cur.result.require || [],
  };
  const upd = await cf(`/accounts/${acct}/access/policies/${pol}`, { method: 'PUT', body });
  if (!upd.ok) {
    return { ok: false, needs_token: !!upd.needs_token, queued: true, error: upd.error };
  }
  return { ok: true, changed: true, already: false };
}

// ── Google Workspace group member (mirrors scripts/sync-gmail-allowlist.js) ───────
const GROUP_EMAIL = () => process.env.PARENTS_GROUP_EMAIL || 'parents@example-nursery.co.uk';
const ADMIN_SUBJECT = () => process.env.WORKSPACE_ADMIN || 'toby@example-nursery.co.uk';
const DIRECTORY_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.group',
  'https://www.googleapis.com/auth/admin.directory.group.member',
];

function loadKey() {
  const raw = process.env.GOOGLE_SA_KEY;
  if (raw && raw.trim().startsWith('{')) return JSON.parse(raw);
  const candidates = [
    process.env.GOOGLE_SA_KEY_PATH,
    raw,
    '/run/secrets/google-service-account.json',
    '/app/secrets/google-service-account.json',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  }
  throw new Error('Google SA key not found');
}

function isScopeError(err) {
  const msg = (err && (err.message || '')) + ' ' +
    JSON.stringify((err && err.response && err.response.data) || '');
  return /unauthorized_client|access_denied|insufficient.*scope|forbidden|invalid_grant|not authorized|\b403\b|\b401\b/i.test(msg);
}

/**
 * Add `email` as a MEMBER of the parents@ Google Group. Graceful-degrades when the
 * SA key is missing or the Directory DWD scopes are not yet authorised (both current
 * on dev / until Toby adds the scopes).
 */
async function grantGroupMember(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email) return { ok: false, needs_token: false, queued: false, error: 'no email' };

  let google, key;
  try {
    ({ google } = require('googleapis'));
    key = loadKey();
  } catch (e) {
    // No googleapis dep or no SA key → can't grant; queue it.
    return { ok: false, needs_token: true, queued: true, error: e.message };
  }

  try {
    const auth = new google.auth.JWT({
      email: key.client_email, key: key.private_key,
      scopes: DIRECTORY_SCOPES, subject: ADMIN_SUBJECT(),
    });
    const dir = google.admin({ version: 'directory_v1', auth });
    try {
      await dir.members.insert({ groupKey: GROUP_EMAIL(), requestBody: { email, role: 'MEMBER' } });
      return { ok: true, changed: true, already: false };
    } catch (e) {
      if (e.code === 409 || /duplicate|already exists|memberKey.*exists/i.test(e.message || '')) {
        return { ok: true, changed: false, already: true };
      }
      throw e;
    }
  } catch (e) {
    return { ok: false, needs_token: isScopeError(e), queued: true, error: e.message };
  }
}

module.exports = { grantCfAllowlist, grantGroupMember, GROUP_EMAIL };
