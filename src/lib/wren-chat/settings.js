'use strict';
/**
 * settings.js — b348: Wren Chat's configuration, and where the Gemini key comes from.
 *
 * KEY LOOKUP, at call time, in this order (first hit wins; nothing is cached longer than 30 s,
 * so Toby adding the key to the ops env file takes effect without a restart):
 *   1. process.env.GEMINI_API_KEY / GOOGLE_AI_API_KEY   (compose env)
 *   2. the ops env file — /run/secrets/ladn-ops.env, mounted into the container. Only the
 *      one variable is read; the file is never logged or returned.
 *   3. wren_chat_settings.secret_enc                     (AES-256-GCM, WREN_ENCRYPTION_KEY)
 * GOOGLE_API_KEY is deliberately NOT read: that name is what Maps / other Google APIs use, and
 * this build should never send a key meant for another service to the Gemini endpoint.
 *
 * The key is never returned by any endpoint, never written to a log, and never put in a URL
 * (the adapter sends it in the x-goog-api-key header).
 *
 * THE TERMS ATTESTATION
 *   Google's Gemini API terms treat a key differently by tier (see NOTES): on the free tier
 *   prompts and responses may be used to improve Google's products and read by human reviewers
 *   ("do not submit sensitive, confidential, or personal information"); on the paid tier they are
 *   not. Nothing in a key tells us which tier it is on. So the chat will not call Gemini until a
 *   manager has recorded — by name and time — that this key belongs to a billing-enabled project.
 *   The attestation carries a fingerprint of the key, so replacing the key voids it.
 */

const fs = require('fs');
const crypto = require('crypto');
const { encrypt, decrypt } = require('../../utils/token-encrypt');

const OPS_ENV_FILE = process.env.WREN_CHAT_KEY_FILE || '/run/secrets/ladn-ops.env';
const KEY_VARS = ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY'];
const KEY_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;

const DEFAULTS = Object.freeze({
  provider: 'gemini',
  gemini_model: 'gemini-3.5-flash-lite',
  monthly_ceiling_usd: 5,
  session_cap_usd: 0.5,
  max_output_tokens: 2048,
  price_in_per_mtok: null,      // null = use the price table in spend.js for the chosen model
  price_out_per_mtok: null,
  terms_attestation: null,      // { tier, confirmed_by, confirmed_by_name, confirmed_at, key_fingerprint }
});

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{2,60}$/;
const PROVIDERS = ['gemini', 'ascent'];

const fingerprint = (key) => crypto.createHash('sha256').update('wren-chat:' + key).digest('hex').slice(0, 12);

// ── the key ─────────────────────────────────────────────────────────────────
let fileCache = { at: 0, key: null };
function keyFromOpsFile() {
  const now = Date.now();
  if (now - fileCache.at < 30000) return fileCache.key;
  let key = null;
  try {
    const text = fs.readFileSync(OPS_ENV_FILE, 'utf8');
    for (const name of KEY_VARS) {
      const m = new RegExp('^\\s*(?:export\\s+)?' + name + '\\s*=\\s*(.*?)\\s*$', 'm').exec(text);
      if (m) { const v = m[1].replace(/^['"]|['"]$/g, ''); if (KEY_SHAPE.test(v)) { key = v; break; } }
    }
  } catch (_) { key = null; }          // absent / unreadable = not configured, not an error
  fileCache = { at: now, key };
  return key;
}

async function readRows(db) {
  const { rows } = await db.query('SELECT key, value_json, secret_enc, updated_by, updated_at FROM wren_chat_settings');
  return rows;
}

/** { key, source } — source is 'env' | 'ops-env-file' | 'settings' | null. Never logs the key. */
async function resolveKey(db) {
  for (const name of KEY_VARS) {
    const v = String(process.env[name] || '').trim();
    if (KEY_SHAPE.test(v)) return { key: v, source: 'env' };
  }
  const f = keyFromOpsFile();
  if (f) return { key: f, source: 'ops-env-file' };
  try {
    const { rows } = await db.query("SELECT secret_enc FROM wren_chat_settings WHERE key = 'gemini_api_key'");
    if (rows[0] && rows[0].secret_enc) { const v = decrypt(rows[0].secret_enc); if (v && KEY_SHAPE.test(v)) return { key: v, source: 'settings' }; }
  } catch (_) { /* undecryptable (encryption key rotated) or table missing = not configured */ }
  return { key: null, source: null };
}

// ── the rest ────────────────────────────────────────────────────────────────
async function load(db) {
  const cfg = Object.assign({}, DEFAULTS);
  let updated = {};
  try {
    for (const r of await readRows(db)) {
      if (r.key === 'gemini_api_key') continue;
      if (r.value_json !== null && r.key in DEFAULTS) cfg[r.key] = r.value_json;
      updated[r.key] = { at: r.updated_at, by: r.updated_by };
    }
  } catch (_) { /* table not migrated yet: defaults, and the status endpoint says so */ }
  cfg._updated = updated;
  return cfg;
}

async function put(db, key, value, staffId) {
  await db.query(
    `INSERT INTO wren_chat_settings (key, value_json, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value_json = $2::jsonb, updated_by = $3, updated_at = now()`,
    [key, JSON.stringify(value), staffId || null]);
}

/** Validate a partial settings update. Returns { ok, values } or { ok:false, error }. */
function validate(input) {
  const out = {};
  const num = (k, min, max) => {
    const v = Number(input[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(k + ' must be a number between ' + min + ' and ' + max);
    return v;
  };
  try {
    if ('provider' in input) { if (!PROVIDERS.includes(input.provider)) throw new Error('provider must be one of ' + PROVIDERS.join(', ')); out.provider = input.provider; }
    if ('gemini_model' in input) { if (!MODEL_ID.test(String(input.gemini_model))) throw new Error('gemini_model is not a valid model id'); out.gemini_model = String(input.gemini_model); }
    if ('monthly_ceiling_usd' in input) out.monthly_ceiling_usd = num('monthly_ceiling_usd', 0, 200);
    if ('session_cap_usd' in input) out.session_cap_usd = num('session_cap_usd', 0, 50);
    if ('max_output_tokens' in input) out.max_output_tokens = Math.round(num('max_output_tokens', 128, 8192));
    for (const k of ['price_in_per_mtok', 'price_out_per_mtok']) {
      if (k in input) out[k] = input[k] === null || input[k] === '' ? null : num(k, 0, 100);
    }
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, values: out };
}

async function setKey(db, plain, staffId) {
  const v = String(plain || '').trim();
  if (!KEY_SHAPE.test(v)) throw new Error('That does not look like an API key.');
  await db.query(
    `INSERT INTO wren_chat_settings (key, secret_enc, updated_by, updated_at) VALUES ('gemini_api_key', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET secret_enc = $1, updated_by = $2, updated_at = now()`,
    [encrypt(v), staffId || null]);
}
async function clearKey(db) { await db.query("UPDATE wren_chat_settings SET secret_enc = NULL, updated_at = now() WHERE key = 'gemini_api_key'"); }

async function attest(db, { confirmed, staffId, staffName }, keyInfo) {
  if (!confirmed) { await put(db, 'terms_attestation', null, staffId); return null; }
  if (!keyInfo.key) throw new Error('Add the API key first — the confirmation is tied to that key.');
  const a = { tier: 'paid', confirmed_by: staffId, confirmed_by_name: staffName || null, confirmed_at: new Date().toISOString(), key_fingerprint: fingerprint(keyInfo.key) };
  await put(db, 'terms_attestation', a, staffId);
  return a;
}

/** 'ok' | 'missing' | 'key_changed' */
function attestationState(cfg, keyInfo) {
  const a = cfg.terms_attestation;
  if (!a || !a.confirmed_at) return 'missing';
  if (!keyInfo.key || a.key_fingerprint !== fingerprint(keyInfo.key)) return 'key_changed';
  return 'ok';
}

module.exports = { DEFAULTS, PROVIDERS, MODEL_ID, OPS_ENV_FILE, fingerprint, resolveKey, load, put, validate, setKey, clearKey, attest, attestationState };
