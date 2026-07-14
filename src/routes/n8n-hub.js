'use strict';
// n8n-hub.js — proxy to main n8n instance for intelligence/research workflow management
const express      = require('express');
const router       = express.Router();
const authenticate = require('../middleware/auth');

const N8N_URL = process.env.N8N_HUB_URL || 'http://100.126.215.7:5678';
const N8N_KEY = process.env.N8N_HUB_API_KEY || 'n8n_api_b007762aa54cc675724a04b28b05bc0943b64a7ce38c4040';
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8082';

const MGRS = new Set(['manager', 'deputy_manager', 'admin']);

router.use(authenticate);

async function n8n(path, opts = {}) {
  const res = await fetch(`${N8N_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': N8N_KEY, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`n8n ${opts.method || 'GET'} ${path} → ${res.status}`), { status: res.status, body });
  }
  return res.json();
}

// ── GET /api/n8n-hub/workflows — list all (or filtered) workflows ─────────────
router.get('/workflows', async (req, res) => {
  if (!MGRS.has(req.user?.role)) return res.status(403).json({ error: 'Managers only' });
  try {
    const data = await n8n('/api/v1/workflows?limit=100');
    let workflows = (data.data || []).map(w => ({
      id: w.id, name: w.name, active: w.active,
      updatedAt: w.updatedAt,
      tags: (w.tags || []).map(t => t.name || t),
      triggerType: (w.nodes || []).find(n => n.type?.includes('scheduleTrigger') || n.type?.includes('Schedule'))?.type || null,
    }));
    const { filter } = req.query;
    if (filter === 'research') {
      const keywords = ['digest', 'research', 'brief', 'intel', 'eyfs', 'community', 'daily', 'news', 'summary', 'monitor'];
      workflows = workflows.filter(w => keywords.some(k => w.name.toLowerCase().includes(k)));
    }
    res.json(workflows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/n8n-hub/workflows/:id/toggle — activate or deactivate ─────────
router.patch('/workflows/:id/toggle', express.json(), async (req, res) => {
  if (!MGRS.has(req.user?.role)) return res.status(403).json({ error: 'Managers only' });
  const { active } = req.body;
  try {
    const endpoint = active ? `/api/v1/workflows/${req.params.id}/activate` : `/api/v1/workflows/${req.params.id}/deactivate`;
    const result = await n8n(endpoint, { method: 'POST', body: '{}' });
    res.json({ ok: true, active: result.active, id: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/n8n-hub/workflows/:id/executions — recent runs ──────────────────
router.get('/workflows/:id/executions', async (req, res) => {
  if (!MGRS.has(req.user?.role)) return res.status(403).json({ error: 'Managers only' });
  try {
    const data = await n8n(`/api/v1/executions?workflowId=${req.params.id}&limit=5`);
    res.json((data.data || []).map(e => ({
      id: e.id, status: e.status, mode: e.mode,
      startedAt: e.startedAt, stoppedAt: e.stoppedAt,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/n8n-hub/workflows/:id/run — manual trigger ─────────────────────
router.post('/workflows/:id/run', express.json(), async (req, res) => {
  if (!MGRS.has(req.user?.role)) return res.status(403).json({ error: 'Managers only' });
  try {
    const wf = await n8n(`/api/v1/workflows/${req.params.id}`);
    // Find a webhook trigger and call its PRODUCTION path (/webhook/<path>). The old
    // code hit /webhook-test/<id>, which only works while the n8n editor is "listening"
    // — so manual Run never worked. Production path works whenever the workflow is active.
    const webhookNode = (wf.nodes || []).find(n => /webhook/i.test(n.type || ''));
    const path = webhookNode?.parameters?.path || webhookNode?.webhookId;
    if (path) {
      if (!wf.active) {
        return res.json({ ok: false, message: 'Workflow is switched off — turn it on first, then Run.' });
      }
      const trigRes = await fetch(`${N8N_URL}/webhook/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'wren-hub', triggered_by: req.user?.id || null }),
        signal: AbortSignal.timeout(15000),
      });
      const txt = await trigRes.text().catch(() => '');
      return res.json({ ok: trigRes.ok, status: trigRes.status, response: txt.slice(0, 200) });
    }
    res.json({ ok: false, message: 'No manual trigger on this workflow — it runs on its schedule only.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/n8n-hub/health — n8n status ─────────────────────────────────────
router.get('/health', async (req, res) => {
  if (!MGRS.has(req.user?.role)) return res.status(403).json({ error: 'Managers only' });
  try {
    const [status, wfData] = await Promise.all([
      fetch(`${N8N_URL}/healthz`, { signal: AbortSignal.timeout(3000) }).then(r => ({ ok: r.ok, status: r.status })).catch(e => ({ ok: false, error: e.message })),
      n8n('/api/v1/workflows?limit=100').catch(() => ({ data: [] })),
    ]);
    const workflows = wfData.data || [];
    const searxOk = await fetch(`${SEARXNG_URL}/search?q=test&format=json`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok).catch(() => false);
    res.json({
      n8n: status,
      searxng: { ok: searxOk, url: SEARXNG_URL },
      workflows: { total: workflows.length, active: workflows.filter(w => w.active).length },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/n8n-hub/search — SearXNG proxy ──────────────────────────────────
router.get('/search', async (req, res) => {
  if (!MGRS.has(req.user?.role)) return res.status(403).json({ error: 'Managers only' });
  const { q, pageno = 1 } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(q)}&format=json&pageno=${pageno}`;
    const r = await fetch(url, { headers: { 'X-Forwarded-For': '127.0.0.1' }, signal: AbortSignal.timeout(15000) });
    const data = await r.json();
    res.json({
      results: (data.results || []).slice(0, 15).map(r => ({
        title: r.title, url: r.url, content: r.content, engine: r.engine,
      })),
      query: q,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
