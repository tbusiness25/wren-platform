'use strict';
/**
 * adapters.js — b348: one interface, two models.
 *
 * An adapter turns a provider-neutral conversation into that provider's request and back. The
 * conversation is held in Gemini's shape (contents[].parts[] with text / functionCall /
 * functionResponse) because that is the primary target; the Ascent adapter translates it.
 *
 *   {
 *     name, label,
 *     trust,             'external' — leaves the building: must pass the redaction gate, the
 *                                     terms attestation and the spend ceiling
 *                        'onsite'   — the nursery's own Ollama on the Ascent: logged, not priced
 *     endpointClass,     what the terms question is about, recorded on every call
 *     endpointHost(),    host only — never a URL that could carry a key
 *     modelName(cfg),
 *     available(db,cfg), { ok, code, message } — is it usable RIGHT NOW (key present, …)
 *     buildBody({ cfg, system, contents, tools, maxOutputTokens }),
 *     send(body, { cfg, keyInfo, signal }),   -> { ok, status, json }
 *     parse(json),       -> { parts, text, functionCalls, finishReason, usage, blocked? }
 *   }
 *
 * POINTING THIS AT HERMES LATER is register('hermes', {...}) and one settings value. Nothing
 * upstream of an adapter — the gate, the ledger, the query layer, the UI — knows which model is
 * on the other end. (hermes-work today is a Telegram gateway with no HTTP API, so there is no
 * adapter for it yet; the day it grows one, it is ~40 lines here.)
 */

const ai = require('../ai-models');
const settings = require('./settings');

const GEMINI_HOST = 'generativelanguage.googleapis.com';
const geminiBase = () => String(process.env.WREN_CHAT_GEMINI_BASE || ('https://' + GEMINI_HOST)).replace(/\/+$/, '');   // env only, for the verify script's fake

const lowerTypes = (schema) => {
  if (Array.isArray(schema)) return schema.map(lowerTypes);
  if (schema && typeof schema === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(schema)) o[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : lowerTypes(v);
    return o;
  }
  return schema;
};

// ── Gemini (Developer API, API-key auth) ────────────────────────────────────
const gemini = {
  name: 'gemini',
  label: 'Gemini',
  trust: 'external',
  endpointClass: 'gemini-developer-api',
  endpointHost() { try { return new URL(geminiBase()).host + (process.env.WREN_CHAT_GEMINI_BASE ? ' (test double)' : ''); } catch (_) { return GEMINI_HOST; } },
  modelName(cfg) { return cfg.gemini_model; },

  async available(db, cfg) {
    const keyInfo = await settings.resolveKey(db);
    if (!keyInfo.key) return { ok: false, code: 'not_configured', message: 'Gemini is not configured yet — there is no API key. Add GEMINI_API_KEY to the ops env file, or paste it into Settings on this page.' };
    const state = settings.attestationState(cfg, keyInfo);
    if (state === 'missing') return { ok: false, code: 'terms_not_confirmed', keyInfo, message: 'A key is present but nobody has confirmed it is on Google’s Paid tier yet. Confirm it in Settings before Gemini is used.' };
    if (state === 'key_changed') return { ok: false, code: 'terms_not_confirmed', keyInfo, message: 'The API key has changed since the Paid-tier confirmation was made. Confirm the new key in Settings.' };
    return { ok: true, keyInfo };
  },

  buildBody({ system, contents, tools, maxOutputTokens }) {
    // `system` is { static, dynamic }: the fixed instructions are marked so the redaction gate leaves them
    // alone; the retrieved manuals and schema (dynamic) are masked like everything else.
    const sysParts = typeof system === 'string' ? [{ text: system }]
      : [{ __static: true, text: system.static }].concat(system.dynamic ? [{ text: system.dynamic }] : []);
    const body = {
      systemInstruction: { parts: sysParts },
      contents,
      generationConfig: { temperature: 0.2, maxOutputTokens },
    };
    if (tools && tools.length) {
      body.tools = [{ functionDeclarations: tools }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    return body;
  },

  async send(body, { cfg, keyInfo, signal }) {
    const url = geminiBase() + '/v1beta/models/' + encodeURIComponent(cfg.gemini_model) + ':generateContent';
    const res = await fetch(url, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': keyInfo.key },   // header, never the URL
      body: JSON.stringify(body, (k, v) => (k === '__static' ? undefined : v)),      // belt and braces: the marker is never sent
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON error page */ }
    return { ok: res.ok, status: res.status, json };
  },

  parse(j) {
    if (j && j.promptFeedback && j.promptFeedback.blockReason) return { blocked: String(j.promptFeedback.blockReason), parts: [], text: '', functionCalls: [], usage: usageOf(j) };
    const cand = j && j.candidates && j.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    return {
      parts,
      text: parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim(),
      functionCalls: parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall.name, args: p.functionCall.args || {} })),
      finishReason: cand && cand.finishReason,
      usage: usageOf(j),
    };
  },
};
function usageOf(j) {
  const u = (j && j.usageMetadata) || {};
  return { promptTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0, thoughtTokens: u.thoughtsTokenCount || 0 };
}

// ── Ascent (the nursery's own Ollama) ───────────────────────────────────────
const ascent = {
  name: 'ascent',
  label: 'Ascent (on-site)',
  trust: 'onsite',
  endpointClass: 'local-ollama',
  endpointHost() { try { return new URL(ai.host()).host; } catch (_) { return 'ollama'; } },
  modelName() { return ai.model('default'); },

  async available() { return ai.host() ? { ok: true, keyInfo: {} } : { ok: false, code: 'not_configured', message: 'OLLAMA_HOST is not set.' }; },

  buildBody({ system, contents, tools, maxOutputTokens }) {
    const messages = [{ role: 'system', content: typeof system === 'string' ? system : system.static + (system.dynamic ? '\n\n' + system.dynamic : '') }];
    for (const c of contents) {
      const texts = c.parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n');
      const calls = c.parts.filter((p) => p.functionCall);
      const resps = c.parts.filter((p) => p.functionResponse);
      if (c.role === 'model') {
        const m = { role: 'assistant', content: texts };
        if (calls.length) m.tool_calls = calls.map((p) => ({ function: { name: p.functionCall.name, arguments: p.functionCall.args || {} } }));
        messages.push(m);
      } else if (resps.length) {
        for (const p of resps) messages.push({ role: 'tool', tool_name: p.functionResponse.name, content: JSON.stringify(p.functionResponse.response) });
      } else messages.push({ role: 'user', content: texts });
    }
    const body = { model: ai.model('default'), stream: false, think: false, messages, options: ai.options({ temperature: 0.2, num_predict: maxOutputTokens }) };
    if (tools && tools.length) {
      body.tools = tools.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: lowerTypes(d.parameters || { type: 'OBJECT', properties: {} }) } }));
    }
    return body;
  },

  async send(body, { signal }) {
    const res = await fetch(ai.host() + '/api/chat', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch (_) { /* */ }
    return { ok: res.ok, status: res.status, json };
  },

  parse(j) {
    const msg = (j && j.message) || {};
    const calls = (msg.tool_calls || []).map((t) => ({ name: t.function && t.function.name, args: (t.function && t.function.arguments) || {} })).filter((c) => c.name);
    const parts = [];
    if (msg.content && msg.content.trim()) parts.push({ text: msg.content });
    for (const c of calls) parts.push({ functionCall: { name: c.name, args: c.args } });
    return {
      parts, text: (msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), functionCalls: calls,
      finishReason: j && j.done_reason, usage: { promptTokens: (j && j.prompt_eval_count) || 0, outputTokens: (j && j.eval_count) || 0, thoughtTokens: 0 },
    };
  },
};

const ADAPTERS = { gemini, ascent };
const register = (name, adapter) => { ADAPTERS[name] = adapter; };
const get = (name) => ADAPTERS[name] || null;

/** GET /v1beta/models — proves the key works and lists usable Flash models. Sends the key and nothing else. */
async function listGeminiModels(keyInfo) {
  const res = await fetch(geminiBase() + '/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': keyInfo.key }, signal: AbortSignal.timeout(15000) });
  let json = null;
  try { json = await res.json(); } catch (_) { /* */ }
  if (!res.ok) return { ok: false, status: res.status, error: (json && json.error && json.error.status) || 'HTTP ' + res.status };
  const models = ((json && json.models) || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /flash/i.test(m.name))
    .map((m) => String(m.name).replace(/^models\//, ''))
    .sort();
  return { ok: true, models };
}

module.exports = { ADAPTERS, register, get, listGeminiModels, GEMINI_HOST };
