'use strict';
/**
 * ai-models.js — b333 (2026-09-15): which local model answers, decided in one place.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * Until b333 every AI call site carried its own env var and its own hard-coded
 * default — about forty of them. When a model came off the Ascent, each path
 * broke separately with an Ollama 404. The 2026-09-15 capacity audit found ~20
 * still asking for gpt-oss:120b, qwen3.5:122b-a10b, qwen3.5:27b, qwen3.6:27b,
 * qwen2.5:4b and qwen2.5-coder:27b, none of which is installed.
 * Toby (2026-09-15): "qwen3.8:27b is good enough for Wren — it does vision and
 * everything else, it's small, and it doesn't need to be super speedy."
 *
 * ── ROLES ───────────────────────────────────────────────────────────────────
 * A call site names what it needs, never a model:
 *   default  general prose — helpers, summaries, suggestions
 *   heavy    careful long-form — reports, policies, narratives, analysis
 *   fast     short and latency-sensitive — classification, one-liners
 *   vision   any request that sends `images`
 *   batch    nightly / background jobs — the only role the 3090 may answer
 *            (see ollama-pick.js)
 *   embed    RAG vectors. Must stay the model that built the qdrant
 *            collections (768-d nomic) or retrieval silently degrades.
 * Every generation role is qwen3.8:27b today. The roles exist so one of them
 * can move later without touching a call site.
 *
 * ── PRECEDENCE (per role) ───────────────────────────────────────────────────
 *   1. settings row `ai_model_overrides` (JSON, in this tenant's schema)
 *   2. env WREN_AI_MODEL_<ROLE>, then WREN_AI_MODEL (every generation role)
 *   3. DEFAULTS below
 * The legacy variables are deliberately NOT read. Prod's container still sets
 * OLLAMA_MODEL=qwen3.5:4b and OLLAMA_MODEL_BATCH=qwen3.6:27b (the second is not
 * installed anywhere); honouring them would keep prod on the old models until
 * the container is recreated, which is the thing the settings row avoids.
 *
 *   ai_model_overrides examples:
 *     {"fast":"qwen3.5:4b"}                         one role moves
 *     {"num_ctx":{"default":8192,"long":32768}}     split the context sizes
 *
 * A settings row can name a MODEL, never a HOST. Hosts come from env only
 * (OLLAMA_HOST, OLLAMA_HOST_BATCH), so no row written from Roost can point
 * nursery data at another machine.
 *
 * ── CONTEXT SIZE ────────────────────────────────────────────────────────────
 * Send num_ctx on every request — options() does it. Measured on the Ascent
 * 2026-09-15 (Ollama 0.32.14, qwen3.8:27b):
 *   · no num_ctx → Ollama loads the model at its Modelfile's 65536, and
 *     qwen3.6:35b-a3b (hermes) dropped out of /api/ps at the same moment;
 *   · a num_ctx different from the resident one reloads the model:
 *     6.7–7.6 s per switch between 8192 and 32768.
 * So 'default' and 'long' both default to 32768: one resident copy, no reload
 * thrash, and long documents are not silently truncated. They stay separate
 * knobs so splitting them is a settings change, not a deploy.
 *
 * ── SCRIPTS ─────────────────────────────────────────────────────────────────
 * The settings row is read through the process's existing pg pool (peekPool),
 * never a new one — a short script that never touched the DB is not kept alive
 * by a settings read. Scripts with their own client can `await ready(client)`.
 * `node src/lib/ai-models.js <role>` prints the env/default answer for Python
 * callers (scripts/ai_models.py).
 */

const ROLES = Object.freeze(['default', 'heavy', 'fast', 'vision', 'batch', 'embed']);

const DEFAULTS = Object.freeze({
  default: 'qwen3.8:27b',
  heavy:   'qwen3.8:27b',
  fast:    'qwen3.8:27b',
  vision:  'qwen3.8:27b',
  batch:   'qwen3.8:27b',
  embed:   'nomic-embed-text',
});

const NUM_CTX_DEFAULTS = Object.freeze({ default: 32768, long: 32768 });
const NUM_CTX_MIN = 2048;
const NUM_CTX_MAX = 131072;

const ASCENT = 'http://127.0.0.1:11434';
const SETTINGS_KEY = 'ai_model_overrides';
const TTL_MS = 60 * 1000;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

let overrides = { models: {}, numCtx: {} };
let loadedAt = 0;
let inflight = null;
let lastError = null;

function assertRole(role) {
  if (!ROLES.includes(role)) {
    throw new Error(`ai-models: unknown role "${role}" — use one of ${ROLES.join(', ')}`);
  }
}

function envModel(role) {
  const own = String(process.env[`WREN_AI_MODEL_${role.toUpperCase()}`] || '').trim();
  if (own) return own;
  const all = String(process.env.WREN_AI_MODEL || '').trim();
  return role !== 'embed' && all ? all : null;
}

function clampCtx(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.min(NUM_CTX_MAX, Math.max(NUM_CTX_MIN, v));
}

function resolveModel(role) {
  return overrides.models[role] || envModel(role) || DEFAULTS[role];
}

function resolveCtx(key) {
  const env = clampCtx(process.env[key === 'long' ? 'WREN_AI_NUM_CTX_LONG' : 'WREN_AI_NUM_CTX']);
  return overrides.numCtx[key] || env || NUM_CTX_DEFAULTS[key];
}

/** The model name for a role. Synchronous; the settings row is refreshed in the background. */
function model(role = 'default') {
  assertRole(role);
  maybeRefresh();
  return resolveModel(role);
}

/** num_ctx for 'default' or 'long' requests. */
function numCtx(size = 'default') {
  maybeRefresh();
  return resolveCtx(size === 'long' ? 'long' : 'default');
}

/**
 * Ollama `options` with num_ctx filled in. The resolver's num_ctx wins over one
 * in `extra` on purpose: a per-call size different from the resident one is a
 * model reload (see CONTEXT SIZE above).
 */
function options(extra, size) {
  return Object.assign({}, extra || {}, { num_ctx: numCtx(size) });
}

/** The interactive Ollama origin — the Ascent. Batch work goes through ollama-pick.js. */
function host() {
  return String(process.env.OLLAMA_HOST || process.env.OLLAMA_URL || ASCENT).replace(/\/+$/, '');
}

/** Ollama treats "name" and "name:latest" as the same model; /api/tags always prints the tag. */
function canonical(name) {
  const s = String(name || '').trim();
  return s && !s.includes(':') ? `${s}:latest` : s;
}

function parseOverrides(raw) {
  const out = { models: {}, numCtx: {} };
  if (raw == null || String(raw).trim() === '') return { value: out, error: null };
  let j;
  try { j = JSON.parse(raw); } catch (_) {
    return { value: out, error: `${SETTINGS_KEY} is not valid JSON — ignored` };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return { value: out, error: `${SETTINGS_KEY} must be a JSON object — ignored` };
  }
  const ignored = [];
  for (const [k, v] of Object.entries(j)) {
    if (k === 'num_ctx') continue;
    if (ROLES.includes(k) && typeof v === 'string' && MODEL_NAME.test(v.trim())) out.models[k] = v.trim();
    else ignored.push(k);
  }
  if (j.num_ctx != null) {
    if (typeof j.num_ctx === 'object') {
      const d = clampCtx(j.num_ctx.default);
      const l = clampCtx(j.num_ctx.long);
      if (d) out.numCtx.default = d;
      if (l) out.numCtx.long = l;
    } else {
      const both = clampCtx(j.num_ctx);
      if (both) { out.numCtx.default = both; out.numCtx.long = both; }
    }
  }
  return { value: out, error: ignored.length ? `${SETTINGS_KEY}: ignored ${ignored.join(', ')}` : null };
}

function existingPool() {
  try { return require('../db/pool').peekPool(); } catch (_) { return null; }
}

/** Re-read the settings row now. `db` is any object with pg's query(); defaults to the existing pool. */
async function refresh(db) {
  const q = db || existingPool();
  if (!q) return describe();
  try {
    const { rows } = await q.query(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEY]);
    const parsed = parseOverrides(rows[0] ? rows[0].value : null);
    if (parsed.error && parsed.error !== lastError) console.warn(`[ai-models] ${parsed.error}`);
    overrides = parsed.value;
    lastError = parsed.error;
  } catch (e) {
    lastError = `settings unreadable (${e.message}) — kept the previous overrides`;
  }
  loadedAt = Date.now();
  return describe();
}

/** refresh() unless the last read is still fresh. For scripts and async paths that want the row applied. */
async function ready(db) {
  if (db || !loadedAt || Date.now() - loadedAt >= TTL_MS) return refresh(db);
  return describe();
}

function maybeRefresh() {
  if (inflight || (loadedAt && Date.now() - loadedAt < TTL_MS)) return;
  const pool = existingPool();
  if (!pool) return;
  inflight = refresh(pool).catch(() => {}).finally(() => { inflight = null; });
}

/** What every role resolves to right now and why — for logs, NOTES and support. */
function describe() {
  const roles = {};
  for (const r of ROLES) {
    const from = overrides.models[r] ? 'settings' : envModel(r) ? 'env' : 'default';
    roles[r] = { model: resolveModel(r), from };
  }
  return {
    roles,
    num_ctx: { default: resolveCtx('default'), long: resolveCtx('long') },
    host: host(),
    batch_host: process.env.OLLAMA_HOST_BATCH || null,
    settings_key: SETTINGS_KEY,
    loaded_at: loadedAt ? new Date(loadedAt).toISOString() : null,
    error: lastError,
  };
}

module.exports = {
  ROLES, DEFAULTS, NUM_CTX_DEFAULTS, SETTINGS_KEY,
  model, numCtx, options, host, canonical,
  refresh, ready, describe, parseOverrides,
};

if (require.main === module) {
  const [arg, extra] = process.argv.slice(2);
  if (arg === '--num-ctx') console.log(numCtx(extra || 'default'));
  else if (arg === '--describe') console.log(JSON.stringify(describe(), null, 2));
  else console.log(model(arg || 'default'));
}
