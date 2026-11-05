'use strict';
/**
 * ollama-pick.js — b147 (2026-07-22): batch/background Ollama host selection.
 *
 * The 3090/Z420 (your-ollama-host) rejoined the fleet and now takes BATCH/background AI
 * (report-engine-nightly, email-triage poller, competitor-intel, legislation-watch, RAG
 * ingest scripts) so the ASUS Ascent (your-ollama-host) stays free for INTERACTIVE use
 * (assistant, story studio, aria). The Z420 has a history of going offline — nothing may
 * hard-depend on it, so every batch call probes it first and falls back to Ascent.
 *
 * Interactive routes are UNCHANGED — they keep reading process.env.OLLAMA_HOST directly
 * and must never require() this file.
 *
 * b333 (2026-09-15): the 3090 answers only when its /api/tags lists the model being asked
 * for. Before, a reachable 3090 always won — and the batch default (qwen3.6:27b) had never
 * been pulled there, so batch calls 404'd while the box looked healthy. Model names now
 * come from ai-models.js (role 'batch'); both boxes carry qwen3.8:27b.
 *
 * Usage:
 *   const { pickBatchOllama } = require('../lib/ollama-pick'); // path from src/routes|jobs|services
 *   const { host, model, numCtx, keepAlive } = await pickBatchOllama();          // chat/generate
 *   const { host, model } = await pickBatchOllama({ model: ai.model('embed') }); // embeddings
 *   const r = await fetch(`${host}/api/generate`, { method: 'POST', body: JSON.stringify({
 *     model, think: false, keep_alive: keepAlive, options: { num_ctx: numCtx }, ... }) });
 */

const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', 'editions', 'ladn', '.env'), override: false });
} catch (_) { /* fine if dotenv isn't installed in this context — env may already be set */ }

const ai = require('./ai-models');

const BATCH_HOST = process.env.OLLAMA_HOST_BATCH || null; // 3090 — may be unset or offline
const ASCENT_HOST = ai.host();

const PROBE_TIMEOUT_MS = 5000;
const PROBE_CACHE_MS = 30000; // don't re-probe a flaky box on every embed call within one job run

// The 3090 has slow disk I/O — a cold model load measured ~153s for a 27b model (2026-07-22).
// Batch jobs that run on a tight interval (e.g. an 8-min poller) should ask Ollama to keep the
// model resident between calls rather than eating that cold-load cost every time; callers pass
// this back as `keep_alive` in their request body. Not applied on the Ascent fallback path —
// Ascent already serves interactive traffic and shouldn't be asked to pin a batch model in VRAM.
const BATCH_KEEP_ALIVE = process.env.OLLAMA_BATCH_KEEP_ALIVE || '20m';

let lastProbe = { at: 0, ok: null, models: new Set() };

/**
 * GET /api/tags on the 3090 — reachability AND what is installed there, in one call that
 * loads no model, so it stays fast even if the box is cold. Cached for PROBE_CACHE_MS.
 */
async function probeBatchHost() {
  if (!BATCH_HOST) return false;
  const now = Date.now();
  if (lastProbe.ok !== null && (now - lastProbe.at) < PROBE_CACHE_MS) return lastProbe.ok;
  let ok = false;
  const models = new Set();
  try {
    const r = await fetch(`${BATCH_HOST}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    ok = !!r.ok;
    if (ok) {
      const j = await r.json();
      for (const m of (j.models || [])) models.add(ai.canonical(m.name));
    }
  } catch (_) { ok = false; }
  lastProbe = { at: now, ok, models };
  return ok;
}

/** True only when the 3090 is up AND has `model` pulled. */
async function batchHostHas(model) {
  if (!(await probeBatchHost())) return false;
  return lastProbe.models.has(ai.canonical(model));
}

/**
 * Resolve which host a batch job should use this call.
 * opts.model — the model to run, e.g. ai.model('embed'); defaults to ai.model('batch').
 *              The same name is used on whichever box answers.
 * opts.size  — 'long' for the long-document num_ctx (see ai-models.js).
 * opts.batchModel / opts.fallbackModel — the pre-b333 per-host names, still honoured.
 */
async function pickBatchOllama(opts = {}) {
  await ai.ready().catch(() => {});
  const batchModel = opts.model || opts.batchModel || ai.model('batch');
  const fallbackModel = opts.model || opts.fallbackModel || ai.model('batch');
  const reachable = await probeBatchHost();
  const on3090 = reachable && lastProbe.models.has(ai.canonical(batchModel));
  let reason = null;
  if (!on3090) reason = !BATCH_HOST ? 'no batch host set' : !reachable ? '3090 unreachable' : `3090 has no ${batchModel}`;
  return {
    host: on3090 ? BATCH_HOST : ASCENT_HOST,
    model: on3090 ? batchModel : fallbackModel,
    source: on3090 ? '3090' : 'ascent-fallback',
    reason,
    keepAlive: on3090 ? BATCH_KEEP_ALIVE : undefined, // let Ascent use its own default
    numCtx: ai.numCtx(opts.size),
  };
}

module.exports = { pickBatchOllama, probeBatchHost, batchHostHas, BATCH_HOST, ASCENT_HOST };
