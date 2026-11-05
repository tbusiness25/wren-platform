'use strict';
// Cloudflare Access management panel (Roost, manager-only).
// View apps + policies + service tokens, edit a policy's allow-list, rotate a service
// token — directly from admin. Talks to the Cloudflare API with CF_API_TOKEN.
//
// REQUIRES a Cloudflare API token in env CF_API_TOKEN with:
//   Account · Access: Apps and Policies · Edit
//   Account · Access: Service Tokens · Edit
// (Account-scoped, account = CF_ACCOUNT_ID). Without a valid token every call returns
// a clear {error, needs_token:true} so the UI can prompt for one.

const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');

// login-20261023: one Cloudflare client for all of Wren (src/lib/cf-allowlist.js cfApi). This file
// had its own, reading CF_API_TOKEN only — invalid since September, so this page has shown
// "needs token" for weeks while the syncs worked through the fallback credential.
const { cfApi: cf, CF_ACCOUNT, SYNCED_POLICY_IDS } = require('../lib/cf-allowlist');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const ACCOUNT = CF_ACCOUNT;

router.use(authenticate);
router.use((req, res, next) => {
  // login-20261023: Roost only. This edits who Cloudflare lets in; it was reachable with a deputy's
  // EY or HR token. Roost's own allowlist then limits it to Toby, the office manager, the admissions lead and Nathan.
  if ((req._portal || 'learning') !== 'admin') return res.status(404).json({ error: 'Not found' });
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});

// ── token status ──────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  // A cheap authenticated read proves whichever credential the shared client chose works.
  const v = await cf(`/accounts/${ACCOUNT}/access/apps?per_page=1`);
  res.json({ configured: !v.needs_token, valid: v.ok, account: ACCOUNT, error: v.ok ? null : v.error });
});

// ── overview: apps + policies + service tokens ────────────────────────────────
router.get('/overview', async (req, res) => {
  const [apps, tokens] = await Promise.all([
    cf(`/accounts/${ACCOUNT}/access/apps`),
    cf(`/accounts/${ACCOUNT}/access/service_tokens`),
  ]);
  if (!apps.ok) return res.status(apps.needs_token ? 400 : 502).json(apps);

  // Fetch policies per app (Access apps carry their policies inline on newer API,
  // else fetch separately).
  const enriched = [];
  for (const a of apps.result) {
    let policies = a.policies || [];
    if (!policies.length) {
      const p = await cf(`/accounts/${ACCOUNT}/access/apps/${a.id}/policies`);
      if (p.ok) policies = p.result;
    }
    enriched.push({
      id: a.id, name: a.name, domain: a.domain, aud: a.aud,
      session_duration: a.session_duration,
      policies: (policies || []).map(pol => ({
        id: pol.id, name: pol.name, decision: pol.decision,
        include: summarise(pol.include), exclude: summarise(pol.exclude), require: summarise(pol.require),
        raw_include: pol.include,
      })),
    });
  }
  res.json({
    account: ACCOUNT,
    apps: enriched,
    service_tokens: (tokens.ok ? tokens.result : []).map(t => ({
      id: t.id, name: t.name, client_id: t.client_id,
      created_at: t.created_at, expires_at: t.expires_at, duration: t.duration,
    })),
    service_tokens_error: tokens.ok ? null : tokens.error,
  });
});

// Human-readable summary of a CF include/exclude/require rule array.
function summarise(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map(r => {
    if (r.email) return { type: 'email', value: r.email.email };
    if (r.email_domain) return { type: 'domain', value: r.email_domain.domain };
    if (r.group) return { type: 'group', value: r.group.id };
    if (r.service_token) return { type: 'service_token', value: r.service_token.token_id };
    if (r.any_valid_service_token !== undefined) return { type: 'any_valid_service_token', value: '⚠ ANY service token', warn: true };
    if (r.everyone !== undefined) return { type: 'everyone', value: 'EVERYONE', warn: true };
    if (r.ip) return { type: 'ip', value: r.ip.ip };
    return { type: Object.keys(r)[0] || 'unknown', value: JSON.stringify(r).slice(0, 60) };
  });
}

// ── rotate a service token ────────────────────────────────────────────────────
router.post('/service-tokens/:id/rotate', async (req, res) => {
  const r = await cf(`/accounts/${ACCOUNT}/access/service_tokens/${req.params.id}/rotate`, { method: 'POST' });
  if (!r.ok) return res.status(r.needs_token ? 400 : 502).json(r);
  // client_secret is returned ONCE on rotate — surface it so Toby can update the device.
  res.json({ ok: true, client_id: r.result.client_id, client_secret: r.result.client_secret, name: r.result.name });
});

// ── replace a policy's email allow-list ───────────────────────────────────────
// body: { include: [{email:'a@b.com'}, ...] } OR { emails: ['a@b.com', ...] }
router.put('/apps/:appId/policies/:policyId', express.json(), async (req, res) => {
  let include = req.body?.include;
  if (!include && Array.isArray(req.body?.emails)) include = req.body.emails.map(e => ({ email: { email: String(e).trim().toLowerCase() } }));
  if (!Array.isArray(include)) return res.status(400).json({ error: 'include[] or emails[] required' });
  // login-20261023: the parents, staff and Roost lists are rebuilt from Wren every morning, so a
  // hand edit here would silently vanish at 07:17. Change the record in Wren instead.
  if (SYNCED_POLICY_IDS.has(req.params.policyId)) {
    return res.status(409).json({ error: 'synced_from_wren',
      message: 'This list is kept in step with Wren every morning. Change the staff or child record in Wren instead.' });
  }
  // Fetch current policy to preserve name/decision.
  const cur = await cf(`/accounts/${ACCOUNT}/access/apps/${req.params.appId}/policies/${req.params.policyId}`);
  if (!cur.ok) return res.status(cur.needs_token ? 400 : 502).json(cur);
  const body = { name: cur.result.name, decision: cur.result.decision, include, exclude: cur.result.exclude || [], require: cur.result.require || [] };
  const upd = await cf(`/accounts/${ACCOUNT}/access/apps/${req.params.appId}/policies/${req.params.policyId}`, { method: 'PUT', body });
  if (!upd.ok) return res.status(upd.needs_token ? 400 : 502).json(upd);
  res.json({ ok: true, policy: upd.result.id });
});

module.exports = router;
