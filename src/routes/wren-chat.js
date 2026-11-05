'use strict';
/**
 * wren-chat.js — b348 (2026-09-21). "Wren Chat": a chat that knows Wren, on Gemini, grounded on
 * Wren's own documentation, schema and COUNTS — never on a child's, a parent's or a record's
 * content. Roost only, manager-level, audited.
 *
 *   GET    /api/wren-chat/status            readiness, key source (never the key), terms state, spend, docs, metrics
 *   GET    /api/wren-chat/catalogue         the allow-listed metrics
 *   POST   /api/wren-chat/ask               one turn  {message, history[], session_id, voice}
 *   POST   /api/wren-chat/preview           the same, stopping before the network: returns the exact bytes that WOULD be sent
 *   POST   /api/wren-chat/query             run a metric by hand, or watch the query layer refuse a row-level ask
 *   POST   /api/wren-chat/transcribe        audio → local whisper → text. Stores nothing.
 *   GET    /api/wren-chat/calls             the outbound-call log (no payload text)
 *   GET    /api/wren-chat/calls/:id         one call, with the exact post-redaction payload
 *   PUT    /api/wren-chat/settings          model, ceilings, prices
 *   PUT    /api/wren-chat/settings/key      the Gemini key (write-only, stored encrypted)
 *   DELETE /api/wren-chat/settings/key
 *   PUT    /api/wren-chat/settings/attestation   "this key is on Google's Paid tier" (named, timed, tied to the key)
 *   GET    /api/wren-chat/models            Flash models the key can use (sends the key only)
 *
 * The rules are not here. They are in src/lib/wren-chat/ (policy, redact, sql-guard, query-layer,
 * spend, model); this file authenticates, rate-limits and translates. The question travels in a
 * POST body only — the automatic request audit (b164) records method/path/status, never a body,
 * so a raw question is not written to audit_log.
 */

const express = require('express');
const multer = require('multer');
const { getPool } = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { getRoostAllowlist } = require('../lib/roost-allowlist');
const chat = require('../lib/wren-chat/chat');
const settings = require('../lib/wren-chat/settings');
const spend = require('../lib/wren-chat/spend');
const adapters = require('../lib/wren-chat/adapters');
const queryLayer = require('../lib/wren-chat/query-layer');
const { getLexicon } = require('../lib/wren-chat/redact');
const { CURRENCY_NOTE } = require('../lib/wren-chat/policy');

const router = express.Router();
const WHISPER_URL = process.env.WHISPER_URL || 'http://wren-whisper:9876';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const TERMS_URL = 'https://ai.google.dev/gemini-api/terms';

// ── who may use it: Roost (admin portal), a manager, and on the Roost allowlist ─────────────────
// Unlike isRoostAllowed() this FAILS CLOSED: an unset allowlist means the owner (staff id 1) only.
// The chat spends money and holds the API key, so "everybody" is never the default.
async function mayUse(req) {
  const u = req.user;
  if (!u || req._portal !== 'admin') return false;
  if (process.env.WREN_EDITION && process.env.WREN_EDITION !== 'ladn') return false;
  const id = Number(u.id);
  if (id === 1) return true;
  const { ids, configured } = await getRoostAllowlist();
  return configured === true && Array.isArray(ids) && ids.includes(id);
}

router.use(requireRole('manager'));
router.use(async (req, res, next) => {
  try {
    if (await mayUse(req)) return next();
    return res.status(403).json({ error: 'not_allowed', message: 'Wren Chat is limited to Roost-authorised managers.' });
  } catch (e) {
    console.error('[wren-chat] gate failed:', e.message);
    return res.status(500).json({ error: 'gate_failed' });
  }
});

// A cost and abuse brake independent of the money ceiling: 20 questions a minute per person.
const buckets = new Map();
function withinRate(staffId, limit = 20) {
  const now = Date.now();
  const b = buckets.get(staffId) || { n: 0, reset: now + 60000 };
  if (now > b.reset) { b.n = 0; b.reset = now + 60000; }
  b.n++; buckets.set(staffId, b);
  return b.n <= limit;
}

const who = (req) => ({ staffId: Number(req.user.id), name: String(req.user.name || req.user.first_name || '').slice(0, 80) });
const audit = (req, action, meta) => recordAudit({ req, action, entity_type: 'wren_chat', entity_id: null, meta });
const statusCodeFor = (r) => ({ ok: 200, refused: 200, not_configured: 200, blocked: 200, capped: 200, error: 502, bad_request: 400 }[r.status] || 200);

// ── status ─────────────────────────────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  const db = getPool();
  try {
    const cfg = await settings.load(db);
    const keyInfo = await settings.resolveKey(db);
    const att = settings.attestationState(cfg, keyInfo);
    const adapter = adapters.get(cfg.provider) || adapters.get('gemini');
    const av = await adapter.available(db, cfg);
    const sessionId = chat.SESSION_RE.test(String(req.query.session_id || '')) ? String(req.query.session_id) : '';

    let docs = { chunks: 0, sources: 0 };
    try { const r = await db.query('SELECT count(*)::int AS chunks, count(DISTINCT source)::int AS sources FROM wren_chat_doc_chunks'); docs = r.rows[0]; } catch (_) { docs.error = 'table_missing'; }
    let migrated = true;
    try { await db.query('SELECT 1 FROM wren_chat_calls LIMIT 1'); } catch (_) { migrated = false; }

    let lexicon = null;
    try { const l = await getLexicon(db); lexicon = { ok: true, tokens: l.stats.tokens, children: l.stats.child, parents: l.stats.parent, staff: l.stats.staff, addresses: l.stats.address, loaded_at: l.stats.loadedAt }; }
    catch (e) { lexicon = { ok: false, code: e.code || 'error' }; }

    const reg = queryLayer.registryStatus();
    let whisper = false;
    try { whisper = (await fetch(WHISPER_URL + '/health', { signal: AbortSignal.timeout(2500) })).ok; } catch (_) { /* down */ }

    const att0 = cfg.terms_attestation;
    res.json({
      migrated,
      provider: cfg.provider,
      ready: av.ok && lexicon.ok && migrated,
      not_ready: av.ok ? (lexicon.ok ? (migrated ? null : { code: 'not_migrated', message: 'The Wren Chat tables have not been created on this database yet.' }) : { code: lexicon.code, message: 'The redaction gate cannot load, so nothing can be sent.' }) : { code: av.code, message: av.message },
      adapters: Object.values(adapters.ADAPTERS).map((a) => ({ name: a.name, label: a.label, trust: a.trust, endpoint_class: a.endpointClass })),
      gemini: {
        key_configured: !!keyInfo.key, key_source: keyInfo.source, model: cfg.gemini_model, endpoint: adapters.ADAPTERS.gemini.endpointHost(),
        endpoint_class: adapters.ADAPTERS.gemini.endpointClass,
        terms: { state: att, attested_by: att0 && att0.confirmed_by_name, attested_at: att0 && att0.confirmed_at, url: TERMS_URL },
      },
      settings: { monthly_ceiling_usd: cfg.monthly_ceiling_usd, session_cap_usd: cfg.session_cap_usd, max_output_tokens: cfg.max_output_tokens,
                  price_in_per_mtok: cfg.price_in_per_mtok, price_out_per_mtok: cfg.price_out_per_mtok },
      spend: await spend.summary(db, cfg, sessionId), currency_note: CURRENCY_NOTE,
      docs, lexicon,
      metrics: { total: reg.length, enabled: reg.filter((m) => m.ok).length, disabled: reg.filter((m) => !m.ok).map((m) => ({ id: m.id, code: m.code })) },
      voice: { whisper },
    });
  } catch (e) {
    console.error('[wren-chat] status:', e.message);
    res.status(500).json({ error: 'status_failed' });
  }
});

router.get('/catalogue', (req, res) => res.json({ metrics: queryLayer.catalogue() }));

// ── a turn ─────────────────────────────────────────────────────────────────────────────────────
router.post('/ask', async (req, res) => {
  if (!withinRate(Number(req.user.id))) return res.status(429).json({ status: 'error', reason: 'rate_limited', message: 'Slow down a little — too many questions this minute.' });
  try {
    const r = await chat.handleTurn(getPool(), req.body, who(req));
    audit(req, 'create', { turn_id: r.turn_id, status: r.status, reason: r.reason || null, provider: r.provider, model: r.model,
      tools: (r.tools || []).map((t) => t.name), redacted: (r.trace || []).reduce((n, t) => n + (t.redacted_total || 0), 0),
      cost_usd: r.usage ? r.usage.cost_usd : 0 });
    res.status(statusCodeFor(r)).json(r);
  } catch (e) {
    console.error('[wren-chat] ask:', e.message);
    res.status(500).json({ status: 'error', reason: 'internal', message: 'Something went wrong on our side. Nothing was sent.' });
  }
});

router.post('/preview', async (req, res) => {
  try {
    const r = await chat.handleTurn(getPool(), req.body, who(req), { dryRun: true });
    res.status(r.status === 'bad_request' ? 400 : 200).json(r);
  } catch (e) {
    console.error('[wren-chat] preview:', e.message);
    res.status(500).json({ status: 'error', reason: 'internal', message: 'Could not build the preview.' });
  }
});

// ── the query layer, directly ──────────────────────────────────────────────────────────────────
router.post('/query', async (req, res) => {
  const db = getPool();
  let lexicon;
  try { lexicon = await getLexicon(db); } catch (e) { return res.status(503).json({ ok: false, refused: e.code || 'lexicon_unavailable', message: 'The redaction lexicon is unavailable, so no result is released.' }); }
  const r = await queryLayer.request(db, req.body, { lexicon });
  audit(req, 'view', { metric: req.body && req.body.metric ? String(req.body.metric).slice(0, 60) : null, ok: !!r.ok, refused: r.refused || null, raw_sql_attempt: !!(req.body && req.body.sql != null) });
  if (r.ok) return res.json({ ok: true, metric: r.metric, title: r.title, as_of: r.as_of, columns: r.columns.map((c) => c.name), rows: r.rows, withheld: r.withheld, min_cell: r.min_cell });
  const code = { unknown_param: 400, bad_param: 400, param_out_of_range: 400, bad_request: 400, not_allowlisted: 404, query_failed: 502 }[r.refused] || 403;
  res.status(code).json(r);
});

// ── voice: local whisper, nothing stored ───────────────────────────────────────────────────────
// The existing /api/transcribe writes every transcript to ladn.transcriptions. This does not: the
// text goes back to the browser and nowhere else, so a spoken name is not kept anywhere new.
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio' });
  if (!withinRate(Number(req.user.id) + ':stt', 40)) return res.status(429).json({ error: 'Too many recordings this minute' });
  try {
    const fd = new FormData();
    const type = req.file.mimetype || 'audio/wav';
    fd.append('file', new Blob([req.file.buffer], { type }), type.includes('wav') ? 'speech.wav' : type.includes('ogg') ? 'speech.ogg' : 'speech.webm');
    const w = await fetch(WHISPER_URL + '/transcribe', { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
    if (!w.ok) return res.status(502).json({ error: 'Speech-to-text failed' });
    const data = await w.json();
    res.json({ text: String(data.text || '').trim(), duration: data.duration || null, engine: 'whisper (on-site)' });
  } catch (e) {
    console.error('[wren-chat] transcribe:', e.message);
    res.status(502).json({ error: 'Speech-to-text is unavailable' });
  }
});

// ── the call log ───────────────────────────────────────────────────────────────────────────────
router.get('/calls', async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 30));
  try {
    const { rows } = await getPool().query(
      `SELECT id, created_at, session_id, provider, model, endpoint, endpoint_class, status, reason, data_classes, redactions, tool_calls,
              sent_bytes, sent_sha256, prompt_tokens, output_tokens, thought_tokens, cost_usd::float AS cost_usd, latency_ms
         FROM wren_chat_calls ORDER BY id DESC LIMIT $1`, [limit]);
    res.json({ calls: rows });
  } catch (e) { res.status(500).json({ error: 'calls_failed' }); }
});
router.get('/calls/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const { rows } = await getPool().query('SELECT * FROM wren_chat_calls WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    audit(req, 'view', { call_id: id });
    res.json({ call: rows[0] });
  } catch (e) { res.status(500).json({ error: 'call_failed' }); }
});

// ── settings ───────────────────────────────────────────────────────────────────────────────────
router.put('/settings', async (req, res) => {
  const v = settings.validate(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  const cfg = await settings.load(getPool());
  const next = Object.assign({}, cfg, v.values);
  if (next.session_cap_usd > next.monthly_ceiling_usd) return res.status(400).json({ error: 'The session cap cannot be more than the monthly ceiling.' });
  try {
    for (const [k, val] of Object.entries(v.values)) await settings.put(getPool(), k, val, Number(req.user.id));
    audit(req, 'update', { changed: Object.keys(v.values), values: v.values });
    res.json({ ok: true, changed: Object.keys(v.values) });
  } catch (e) { console.error('[wren-chat] settings:', e.message); res.status(500).json({ error: 'save_failed' }); }
});

router.put('/settings/key', async (req, res) => {
  try {
    await settings.setKey(getPool(), req.body && req.body.key, Number(req.user.id));
    audit(req, 'update', { changed: ['gemini_api_key'], value: 'not recorded' });       // the value is never logged
    res.json({ ok: true, note: 'Stored encrypted. The Paid-tier confirmation must be made again for a new key.' });
  } catch (e) { res.status(400).json({ error: e.message === 'That does not look like an API key.' ? e.message : 'Could not store the key.' }); }
});
router.delete('/settings/key', async (req, res) => {
  await settings.clearKey(getPool());
  audit(req, 'delete', { changed: ['gemini_api_key'] });
  res.json({ ok: true, note: 'The stored key is removed. A key in the ops env file, if there is one, still applies.' });
});

router.put('/settings/attestation', async (req, res) => {
  try {
    const db = getPool();
    const keyInfo = await settings.resolveKey(db);
    const a = await settings.attest(db, { confirmed: req.body && req.body.confirmed === true, staffId: Number(req.user.id), staffName: who(req).name }, keyInfo);
    audit(req, 'update', { changed: ['terms_attestation'], confirmed: !!a, key_source: keyInfo.source });
    res.json({ ok: true, attested: !!a });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/models', async (req, res) => {
  const keyInfo = await settings.resolveKey(getPool());
  if (!keyInfo.key) return res.status(409).json({ error: 'not_configured', message: 'There is no API key to check.' });
  try {
    const r = await adapters.listGeminiModels(keyInfo);
    if (!r.ok) return res.status(502).json({ error: 'google_rejected', message: 'Google did not accept the key (' + r.error + ').' });
    res.json({ models: r.models });
  } catch (e) { res.status(502).json({ error: 'unreachable', message: 'Could not reach Google.' }); }
});

module.exports = router;
