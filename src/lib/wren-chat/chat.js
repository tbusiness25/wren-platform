'use strict';
/**
 * chat.js — b348: one turn of Wren Chat, start to finish.
 *
 *   input check → row-level ask? → is the model usable? → redaction lexicon → grounding
 *   (docs + schema) → ask() with the metric tools → answer + what was sent + the meter
 *
 * The route (src/routes/wren-chat.js) is only auth and plumbing around this. Everything that is
 * a rule lives in policy / redact / query-layer / spend / model, so it can be tested without HTTP
 * (scripts/b348-verify.js does exactly that).
 *
 * STATUS values a caller can get back, and what the screen does with each:
 *   ok             show the answer
 *   refused        a row-level ask (a list of children, a person's records) — answered locally, no model call
 *   not_configured no Gemini key yet — the screen says so plainly
 *   blocked        the gate stopped it (terms not confirmed, redaction unavailable/failed)
 *   capped         the monthly ceiling or the session cap — "not now"
 *   error          the model service failed
 */

const crypto = require('crypto');
const adapters = require('./adapters');
const settings = require('./settings');
const spend = require('./spend');
const grounding = require('./grounding');
const queryLayer = require('./query-layer');
const model = require('./model');
const { getLexicon, registerVocabulary } = require('./redact');
const { LIMITS } = require('./policy');

const SESSION_RE = /^[A-Za-z0-9-]{8,64}$/;

// A CONVENIENCE, not a control. The model has no row-level tool, so it cannot list children however
// it is asked; this just answers the obvious ones locally, instantly and for free, instead of paying
// a model to say no. Kept high-precision on purpose: a miss costs one polite refusal from the model.
const ROW_LEVEL = [
  /\bwhich (children|kids|child|parents|families)\b/i,
  /\b(list|name)\b[^.?!]{0,25}\b(the |all |every )?(children|kids|parents|families)\b(?![^.?!]{0,20}\b(by|per|in each|for each)\b)/i,
  /\b(show|read|give|tell|summari[sz]e)\b[^.?!]{0,40}\b(observations?|diary|diaries|incident reports?|medicine (records?|log)|safeguarding (notes?|concerns?|records?)|messages?)\b[^.?!]{0,25}\b(for|about|of)\b/i,
  /\bwhat('s| is)\b[^.?!]{0,10}\b(the )?(address|phone number|email|date of birth|dob|name)\b[^.?!]{0,15}\b(of|for)\b/i,
];
const classifyIntent = (text) => ({ rowLevel: ROW_LEVEL.some((re) => re.test(text)) });

function normalise(body) {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return { error: 'Type or say something first.' };
  if (message.length > LIMITS.maxQuestionChars) return { error: 'That is too long for a question (' + LIMITS.maxQuestionChars + ' characters at most). This chat is for questions, not for pasting records.' };
  const sessionId = String(body.session_id || '');
  if (!SESSION_RE.test(sessionId)) return { error: 'Missing or invalid session_id.' };
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string' && h.text.trim())
    .slice(-LIMITS.maxHistoryTurns)
    .map((h) => ({ role: h.role, text: h.text.slice(0, LIMITS.maxHistoryTurnChars) }));
  return { message, sessionId, history, voice: body.voice === true };
}

function systemPrompt({ voice, docs, schemaText }) {
  const parts = [
    'You are Wren Chat, the assistant inside Roost for the manager of Your Nursery in Ealing, West London (Baby Room and Pre-school; open Monday to Friday, 8am to 6pm).',
    '',
    'WHAT YOU CAN SEE',
    '- Passages from the Wren documentation (below, when relevant), the NAMES of Wren\'s database tables and columns, and — by calling the metric functions — live counts and totals. Nothing else.',
    '- You never see, and cannot ask for, an individual child, parent, member of staff, observation, diary entry, medicine record, safeguarding note or message. Names you see in the conversation have been masked as [child], [parent] or [staff]. If asked for anything about an individual or a list of people, say plainly that you only work with totals, and point to Roost (the child profile) or the on-site Wren AI for individual records.',
    '',
    'HOW TO ANSWER',
    '- Every number comes from a metric function. Never estimate, remember or invent a figure. If no metric fits the question, say so and say what you CAN count.',
    '- Say when the figure is from ("live, as of …") and which period it covers.',
    '- A value shown as "<3" or "<5" has been withheld to protect individuals. Say it is a small number; never guess it.',
    '- For "how do I…" and "where in Wren…" questions use the DOCUMENTATION passages. If they do not cover it, say you are not sure rather than guess.',
    '- You advise. You never say you have changed, sent, booked or recorded anything.',
    '- UK English. Be brief and practical.',
  ];
  if (voice) parts.push('- The answer will be READ ALOUD: one to three short spoken sentences, plain words, no lists, no markdown, no symbols; say units in words.');
  // static = our own fixed instructions (exempt from masking); dynamic = retrieved data (masked like everything else)
  const dyn = [];
  if (docs.length) {
    dyn.push('DOCUMENTATION (passages from the Wren manuals):');
    docs.forEach((d, i) => dyn.push('[' + (i + 1) + '] ' + d.source + (d.title ? ' — ' + d.title : '') + '\n' + d.body));
  }
  if (schemaText) dyn.push('', 'DATABASE SCHEMA (names only — you cannot query it directly; use the metric functions):', schemaText);
  return { static: parts.join('\n'), dynamic: dyn.join('\n') };
}

// The instructions and tool text are ours and static: their ordinary words must never be treated as a
// person's name, even if a record somewhere holds that word as one (see redact.js, "ordinary vocabulary").
registerVocabulary(systemPrompt({ voice: true, docs: [], schemaText: '' }).static + ' ' + JSON.stringify(queryLayer.functionDeclarations()) + ' ' +
  queryLayer.catalogue().map((m) => m.title + ' ' + m.description + ' ' + m.columns.map((c) => c.name + ' ' + (c.description || '')).join(' ')).join(' '));

async function meter(pool, cfg, adapter, sessionId) {
  return adapter.trust === 'external' ? spend.summary(pool, cfg, sessionId) : null;
}

/**
 * handleTurn(pool, body, who, { dryRun }) -> result object (see STATUS above). Never throws for a
 * refusal, a missing key or a cap — those are answers. It throws only for programmer errors.
 */
async function handleTurn(pool, body, who, { dryRun = false } = {}) {
  const inp = normalise(body || {});
  if (inp.error) return { status: 'bad_request', message: inp.error };

  const cfg = await settings.load(pool);
  const adapter = adapters.get(cfg.provider) || adapters.get('gemini');
  const turnId = crypto.randomUUID();
  const base = { staff_id: who.staffId, session_id: inp.sessionId, turn_id: turnId, provider: adapter.name, model: adapter.modelName(cfg),
                 endpoint: adapter.endpointHost(), endpoint_class: adapter.endpointClass };
  const done = async (status, reason, message, extra) => {
    if (!dryRun) await spend.insertCall(pool, Object.assign({}, base, { status, reason, data_classes: [] }));
    return Object.assign({ status, reason, message, turn_id: turnId, provider: adapter.name, model: base.model, spend: await meter(pool, cfg, adapter, inp.sessionId) }, extra || {});
  };

  if (classifyIntent(inp.message).rowLevel) {
    return done('refused', 'row_level_intent', queryLayer.REFUSAL_HELP, { answer: queryLayer.REFUSAL_HELP, refused_locally: true });
  }

  if (!dryRun) {
    const av = await adapter.available(pool, cfg);
    if (!av.ok) return done(av.code === 'not_configured' ? 'not_configured' : 'blocked', av.code, av.message);
  }

  let lexicon;
  try { lexicon = await getLexicon(pool); }
  catch (e) { return done('blocked', e.code || 'lexicon_unavailable', 'The redaction gate is unavailable (' + (e.code || 'error') + '), so nothing was sent.'); }

  let q;
  try { q = lexicon.redact(inp.message).text; }
  catch (e) { return done('blocked', e.code || 'redaction_failed', 'The redaction gate could not clear that message, so nothing was sent.'); }

  const docs = await grounding.retrieveDocs(pool, q);
  const schemaText = await grounding.schemaDigest(pool, q);
  const classes = ['system_prompt', 'user_question'].concat(inp.history.length ? ['history'] : [], docs.length ? ['docs'] : [], schemaText ? ['schema'] : []);

  const runTool = async (name, args) => {
    const r = await queryLayer.request(pool, { metric: String(name), params: args }, { lexicon });
    return r.ok ? { ok: true, forModel: queryLayer.forModel(r), rowCount: r.rows.length } : { ok: false, refused: r.refused, message: r.message };
  };

  const out = await model.ask(inp.message, {
    db: pool, cfg, adapter, lexicon, staffId: who.staffId, sessionId: inp.sessionId, turnId,
    system: systemPrompt({ voice: inp.voice, docs, schemaText }), history: inp.history,
    tools: queryLayer.functionDeclarations(), runTool, classes, dryRun,
  });

  const result = {
    status: out.ok ? (out.dryRun ? 'preview' : 'ok') : out.status, reason: out.reason, message: out.message,
    answer: out.text, turn_id: turnId, provider: adapter.name, model: base.model, endpoint_class: adapter.endpointClass, trust: adapter.trust,
    sources: docs.map((d) => ({ source: d.source, title: d.title })), tools: out.tools, trace: out.trace, usage: out.usage,
    spend: await meter(pool, cfg, adapter, inp.sessionId),
  };
  return result;
}

module.exports = { handleTurn, normalise, classifyIntent, systemPrompt, SESSION_RE };
