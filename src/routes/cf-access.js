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

const CF_API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT = process.env.CF_ACCOUNT_ID || '';
const TOKEN = () => process.env.CF_API_TOKEN || '';

router.use(authenticate);
router.use((req, res, next) => {
  if (!['manager', 'deputy_manager'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});

async function cf(path, opts = {}) {
  const token = TOKEN();
  if (!token) return { ok: false, needs_token: true, error: 'CF_API_TOKEN not set' };
  try {
    const r = await fetch(CF_API + path, {
      method: opts.method || 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.success) {
      const msg = (j.errors && j.errors[0] && j.errors[0].message) || `HTTP ${r.status}`;
      const invalid = r.status === 401 || r.status === 403 || /invalid api token/i.test(msg);
      return { ok: false, needs_token: invalid, error: msg, status: r.status };
    }
    return { ok: true, result: j.result };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── token status ──────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  if (!TOKEN()) return res.json({ configured: false, valid: false, account: ACCOUNT });
  const v = await cf('/user/tokens/verify');
  res.json({ configured: true, valid: v.ok, account: ACCOUNT, error: v.ok ? null : v.error });
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
  // Fetch current policy to preserve name/decision.
  const cur = await cf(`/accounts/${ACCOUNT}/access/apps/${req.params.appId}/policies/${req.params.policyId}`);
  if (!cur.ok) return res.status(cur.needs_token ? 400 : 502).json(cur);
  const body = { name: cur.result.name, decision: cur.result.decision, include, exclude: cur.result.exclude || [], require: cur.result.require || [] };
  const upd = await cf(`/accounts/${ACCOUNT}/access/apps/${req.params.appId}/policies/${req.params.policyId}`, { method: 'PUT', body });
  if (!upd.ok) return res.status(upd.needs_token ? 400 : 502).json(upd);
  res.json({ ok: true, policy: upd.result.id });
});

module.exports = router;
