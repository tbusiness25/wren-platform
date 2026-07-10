'use strict';
// n8n bridge — lets Wren routes trigger workflows, list status, audit

const N8N_BASE = process.env.WREN_N8N_URL || 'http://wren-n8n:5679';
const N8N_API_KEY = process.env.WREN_N8N_API_KEY || '';

const HEADERS = () => ({
  'Content-Type': 'application/json',
  ...(N8N_API_KEY ? { 'X-N8N-API-KEY': N8N_API_KEY } : {}),
});

async function _fetch(path, opts = {}) {
  const url = N8N_BASE + path;
  const res = await fetch(url, { ...opts, headers: { ...HEADERS(), ...(opts.headers || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`n8n ${opts.method || 'GET'} ${path} → ${res.status}: ${body.substring(0, 200)}`);
  }
  return res.json();
}

async function listWorkflows() {
  try {
    const data = await _fetch('/api/v1/workflows');
    return (data.data || []).map(w => ({
      id: w.id, name: w.name, active: w.active,
      updatedAt: w.updatedAt, tags: (w.tags || []).map(t => t.name),
    }));
  } catch {
    return [];
  }
}

async function getWorkflow(id) {
  return _fetch(`/api/v1/workflows/${id}`);
}

async function triggerWebhook(webhookPath, payload = {}) {
  const url = `${N8N_BASE}/webhook/${webhookPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status };
}

async function triggerWorkflow(workflowId, payload = {}) {
  return _fetch(`/api/v1/workflows/${workflowId}/activate`, { method: 'POST', body: JSON.stringify(payload) });
}

async function listExecutions(workflowId, limit = 20) {
  try {
    const qs = new URLSearchParams({ limit, ...(workflowId ? { workflowId } : {}) });
    const data = await _fetch(`/api/v1/executions?${qs}`);
    return (data.data || []).map(e => ({
      id: e.id, workflowId: e.workflowId, finished: e.finished,
      mode: e.mode, status: e.status,
      startedAt: e.startedAt, stoppedAt: e.stoppedAt,
    }));
  } catch {
    return [];
  }
}

async function importWorkflow(workflowJson) {
  return _fetch('/api/v1/workflows', {
    method: 'POST',
    body: JSON.stringify(workflowJson),
  });
}

async function healthCheck() {
  try {
    await fetch(`${N8N_BASE}/healthz`, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

module.exports = { listWorkflows, getWorkflow, triggerWebhook, triggerWorkflow, listExecutions, importWorkflow, healthCheck };
