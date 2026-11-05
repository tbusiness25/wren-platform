'use strict';
/**
 * model.js — b348: ask(question, context), and the one gate every outbound call goes through.
 *
 * ask() is the whole conversation loop, and it is provider-neutral: build the turn, send it,
 * and if the model asks for a metric run that (through the query layer, never anything else)
 * and send the result back — up to LIMITS.maxToolRounds times, then one last call with tools
 * off so it has to answer. Which model is on the other end is an adapter (adapters.js).
 *
 * guardedSend() is where the promises are kept. For an EXTERNAL adapter, in this order:
 *   1. REDACT   every string in the request body is masked (redact.js); if that cannot be done,
 *               or leaves anything behind, the call is BLOCKED. Fail closed.
 *   2. READY?   a key is present and its Paid-tier confirmation is current — else 'not_configured'
 *               / 'blocked', and the person is told exactly what is missing.
 *   3. MONEY    worst-case cost is reserved against the monthly ceiling and the session cap
 *               (spend.js) — else 'capped', and no call is made.
 *   4. SEND     with a hard timeout.
 *   5. RECORD   one wren_chat_calls row per call, whatever happened: what class of data it
 *               held, what was masked, the exact post-redaction payload, tokens, cost.
 * The on-site (Ascent) adapter skips 1 and 3 — it never leaves the building — but is still logged.
 *
 * dryRun runs 1 and stops: it returns the exact bytes that WOULD be sent. That is how the
 * verify script shows the gate working with no key, and the UI's "what was sent" uses the same
 * shape.
 */

const crypto = require('crypto');
const spend = require('./spend');
const { LIMITS } = require('./policy');
const { RedactionError } = require('./redact');

// Values of these keys are structure, not content: roles, function names, the static tool
// declarations and settings, and Gemini's opaque thoughtSignature (must return byte-for-byte).
const SKIP_KEYS = ['tools', 'toolConfig', 'generationConfig', 'thoughtSignature', 'role', 'name'];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The payload as stored / shown: exactly what was sent, with the big static parts summarised. */
function shownBody(body) {
  return JSON.parse(JSON.stringify(body, (k, v) => {
    if (k === 'tools' && Array.isArray(v)) {
      const n = v[0] && v[0].functionDeclarations ? v[0].functionDeclarations.length : v.length;
      return '[' + n + ' function declarations — static]';
    }
    if (k === 'thoughtSignature') return '[opaque signature]';
    return v;
  }));
}

function cappedMessage(r) {
  const money = (n) => '$' + Number(n).toFixed(2);
  return r.reason === 'session_cap'
    ? 'Not now — this conversation has used its limit (' + money(r.session_usd) + ' of ' + money(r.session_cap_usd) + '). Start a new session, or raise the per-session cap in Settings.'
    : 'Not now — the monthly limit has been reached (' + money(r.month_usd) + ' of ' + money(r.monthly_ceiling_usd) + '). Nothing was sent. Raise the ceiling in Settings, or wait until next month.';
}

async function guardedSend(cx, adapter, body, meta) {
  const { db, cfg, lexicon, staffId, sessionId, turnId } = cx;
  const model = adapter.modelName(cfg);
  const base = { staff_id: staffId, session_id: sessionId, turn_id: turnId, provider: adapter.name, model,
                 endpoint: adapter.endpointHost(), endpoint_class: adapter.endpointClass, data_classes: meta.classes };
  const t0 = Date.now();
  const bad = async (status, reason, message, extra) => {
    if (!cx.dryRun) await spend.insertCall(db, Object.assign({}, base, { status, reason }, extra || {}));
    return { ok: false, status, reason, message, trace: { round: meta.round, provider: adapter.name, model, status, reason } };
  };

  // 1 ── REDACT
  let red = { value: body, counts: {}, total: 0 };
  if (adapter.trust === 'external') {
    if (!lexicon) return bad('blocked', 'redaction_unavailable', 'The redaction gate is not available, so nothing was sent.');
    try { red = lexicon.redactDeep(body, { skipKeys: SKIP_KEYS }); }
    catch (e) {
      const code = e instanceof RedactionError ? e.code : 'redaction_failed';
      return bad('blocked', code, 'The redaction gate stopped this call (' + code + '). Nothing was sent.');
    }
  }
  const wire = JSON.stringify(red.value);
  const shown = shownBody(red.value);
  const info = { redactions: red.counts, sent_bytes: Buffer.byteLength(wire), sent_sha256: sha256(wire), sent_text: JSON.stringify(shown) };
  const traceBase = { round: meta.round, provider: adapter.name, label: adapter.label, model, endpoint: base.endpoint, endpoint_class: adapter.endpointClass,
                      trust: adapter.trust, classes: meta.classes, redactions: red.counts, redacted_total: red.total, bytes: info.sent_bytes, sha256: info.sent_sha256, sent: shown };

  if (cx.dryRun) return { ok: true, dryRun: true, trace: Object.assign({ status: 'dry_run' }, traceBase) };

  // 2 ── READY?
  const av = await adapter.available(db, cfg);
  if (!av.ok) return bad(av.code === 'not_configured' ? 'not_configured' : 'blocked', av.code, av.message, info);

  // 3 ── MONEY
  const price = adapter.trust === 'external' ? spend.priceFor(cfg, model) : null;
  let callId;
  if (adapter.trust === 'external') {
    const worst = spend.worstCaseUsd(price, info.sent_bytes, cfg.max_output_tokens);
    const r = await spend.reserve(db, cfg, Object.assign({}, base, info), worst);
    if (!r.ok) return { ok: false, status: 'capped', reason: r.reason, message: cappedMessage(r), spend: r, trace: Object.assign({ status: 'capped', reason: r.reason }, traceBase) };
    callId = r.id;
  } else {
    callId = await spend.insertCall(db, Object.assign({}, base, info, { status: 'pending' }));
  }

  // 4 ── SEND
  const fin = async (status, reason, extra) => spend.updateCall(db, callId, Object.assign({ status, reason, cost_usd: 0, latency_ms: Date.now() - t0 }, extra || {}));
  let res;
  try {
    const left = cx.deadline ? Math.max(1000, cx.deadline - Date.now()) : LIMITS.callTimeoutMs;
    res = await adapter.send(red.value, { cfg, keyInfo: av.keyInfo, signal: AbortSignal.timeout(Math.min(LIMITS.callTimeoutMs, left)) });
  } catch (e) {
    const reason = e && e.name === 'TimeoutError' ? 'timeout' : 'network';
    await fin('error', reason);
    return { ok: false, status: 'error', reason, message: reason === 'timeout' ? 'The model took too long to answer.' : 'Could not reach the model.', trace: Object.assign({ status: 'error', reason }, traceBase) };
  }
  if (!res.ok) {
    const gerr = res.json && res.json.error;
    const reason = 'http_' + res.status + (gerr && gerr.status ? ':' + String(gerr.status).slice(0, 40) : '');
    await fin('error', reason);
    const msg = res.status === 429 ? 'The model is rate-limiting requests — try again in a moment.'
      : (res.status === 400 || res.status === 401 || res.status === 403) ? 'Google rejected the request (' + reason + '). Check the API key and model in Settings.'
      : 'The model service had a problem (' + reason + ').';
    return { ok: false, status: 'error', reason, message: msg, trace: Object.assign({ status: 'error', reason }, traceBase) };
  }

  // 5 ── RECORD
  const parsed = adapter.parse(res.json);
  const u = parsed.usage;
  const cost = price ? spend.costUsd(price, u.promptTokens, u.outputTokens + u.thoughtTokens) : 0;
  const empty = !parsed.text && !parsed.functionCalls.length;
  const status = parsed.blocked ? 'error' : 'ok';
  const reason = parsed.blocked ? 'model_blocked:' + parsed.blocked : (empty ? 'empty_answer:' + (parsed.finishReason || '?') : null);
  await fin(status, reason, { prompt_tokens: u.promptTokens, output_tokens: u.outputTokens, thought_tokens: u.thoughtTokens, cost_usd: cost });
  const trace = Object.assign({ status, reason, tokens: u, cost_usd: cost, latency_ms: Date.now() - t0, call_id: callId }, traceBase);
  if (parsed.blocked) return { ok: false, status: 'error', reason, message: 'The model declined to answer (' + parsed.blocked + ').', trace };
  return { ok: true, parsed, callId, cost, trace };
}

/**
 * ask(question, context) -> { ok, text, provider, model, trace[], tools[], usage }
 *   context: { db, cfg, adapter, lexicon, staffId, sessionId, turnId, system, history[], tools[],
 *              runTool(name,args)->{ok,forModel|refused,message}, classes[], dryRun }
 */
async function ask(question, context) {
  const { adapter, history = [], tools = [], runTool, system, cfg } = context;
  const contents = history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] }));
  contents.push({ role: 'user', parts: [{ text: question }] });

  const trace = [];
  const toolLog = [];
  const usage = { prompt_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 };
  context.deadline = Date.now() + LIMITS.turnDeadlineMs;

  for (let round = 0; round <= LIMITS.maxToolRounds; round++) {
    if (round > 0 && Date.now() > context.deadline - 3000) {
      return { ok: false, status: 'error', reason: 'turn_timeout', message: 'That took too long, so it was stopped before another call was made.', trace, tools: toolLog, usage };
    }
    const useTools = tools.length > 0 && round < LIMITS.maxToolRounds;
    const body = adapter.buildBody({ cfg, system, contents, tools: useTools ? tools : [], maxOutputTokens: cfg.max_output_tokens });
    const classes = context.classes.concat(toolLog.some((t) => t.ok) ? ['aggregate'] : []);
    const sent = await guardedSend(context, adapter, body, { round, classes });
    trace.push(sent.trace);
    if (!sent.ok) return { ok: false, status: sent.status, reason: sent.reason, message: sent.message, spend: sent.spend, trace, tools: toolLog, usage };
    if (sent.dryRun) return { ok: true, dryRun: true, trace, tools: toolLog, usage };

    usage.calls++; usage.prompt_tokens += sent.parsed.usage.promptTokens; usage.output_tokens += sent.parsed.usage.outputTokens + sent.parsed.usage.thoughtTokens; usage.cost_usd += sent.cost;
    const p = sent.parsed;

    if (p.functionCalls.length && useTools) {
      contents.push({ role: 'model', parts: p.parts });       // verbatim, incl. any thoughtSignature
      const responses = [];
      const thisRound = [];
      for (const fc of p.functionCalls.slice(0, 4)) {
        const r = await runTool(fc.name, fc.args);
        const entry = { name: String(fc.name).slice(0, 60), args: fc.args, ok: !!r.ok, refused: r.refused || null, rows: r.ok ? r.rowCount : 0 };
        thisRound.push(entry); toolLog.push(entry);
        responses.push({ functionResponse: { name: fc.name, response: r.ok ? r.forModel : { error: r.refused, message: r.message } } });
      }
      try { await spend.attachToolCalls(context.db, sent.callId, context.lexicon ? context.lexicon.redactDeep(thisRound).value : thisRound); } catch (_) { /* the log is best-effort here; the call row exists */ }
      contents.push({ role: 'user', parts: responses });
      continue;
    }

    if (!p.text) {
      const why = p.finishReason === 'MAX_TOKENS' ? 'The answer was cut off before it started — the output limit in Settings may be too low.' : 'The model returned no answer.';
      return { ok: false, status: 'error', reason: 'empty_answer', message: why, trace, tools: toolLog, usage };
    }
    return { ok: true, text: p.text, provider: adapter.name, model: adapter.modelName(cfg), trace, tools: toolLog, usage };
  }
  return { ok: false, status: 'error', reason: 'tool_loop', message: 'The model kept asking for data instead of answering.', trace, tools: toolLog, usage };
}

module.exports = { ask, guardedSend, shownBody, SKIP_KEYS, cappedMessage };
