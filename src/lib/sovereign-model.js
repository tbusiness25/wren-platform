'use strict';
/**
 * sovereign-model.js — b235 (2026-08-26)
 *
 * The local-only model client. Every AI call in the inbox-intelligence build
 * goes through here and nowhere else.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * b235 reads the nursery's actual correspondence: parents, staff, safeguarding
 * statements, HMRC, the lot. That is special-category personal data about
 * children. The 2026-05-14 decision ("LADN production stays local") is not a
 * preference here, it is the only thing that makes the build lawful.
 *
 * `scripts/b231-policy-check.js` established the pattern: probe /api/tags, fail
 * loudly if the local model is not there, never fall back. This file goes one
 * step further, because "we chose not to write a fallback" is a weaker promise
 * than "a fallback cannot be reached".
 *
 * ── THE GUARD ───────────────────────────────────────────────────────────────
 * assertLocalHost() parses the configured endpoint and refuses anything that is
 * not a literal IP address on a private / Tailscale-CGNAT / loopback range, or
 * localhost. It runs at module load AND again immediately before every single
 * fetch, so:
 *
 *   OLLAMA_HOST=https://api.openai.com/v1     → throws, no request made
 *   OLLAMA_HOST=https://api.anthropic.com     → throws, no request made
 *   OLLAMA_HOST=http://some.host.example.com  → throws (not an IP literal)
 *   OLLAMA_HOST=http://127.0.0.1:11434  → allowed (Tailscale CGNAT)
 *
 * There is no provider abstraction, no `if (!local) use(cloud)`, no API-key
 * read anywhere in this module. The only outbound URL this file can construct
 * is `${OLLAMA}/api/...` where OLLAMA has passed assertLocalHost(). That is the
 * code path that makes a cloud fallback impossible — not a policy, a parser.
 *
 * ── MODEL ───────────────────────────────────────────────────────────────────
 * b235 shipped on qwen3.5:122b-a10b ("122b local"). That model has since come
 * off the Ascent, and every modelled section then failed with a 404.
 * b333 (2026-09-15): the model is ai-models.js role 'heavy' (qwen3.8:27b),
 * resolved per call, so a settings row can move it without a deploy. Only the
 * NAME comes from there — the host is still OLLAMA_HOST, still checked by
 * assertLocalHost() before every request.
 */

const { URL } = require('url');
const ai = require('./ai-models');

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const ROLE = 'heavy';

// A long generate on a 122b model is not fast. These are deliberately generous;
// a timeout here means "the box is busy", not "give up and use something else".
const GENERATE_TIMEOUT_MS = parseInt(process.env.B235_TIMEOUT_MS || '180000', 10);
const PROBE_TIMEOUT_MS = 15000;

/**
 * True for an IPv4 literal inside a range that cannot route to the public
 * internet, or that is Tailscale's CGNAT range (100.64.0.0/10) which is where
 * the Ascent lives.
 */
function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  if (o[0] === 10) return true;                                   // 10.0.0.0/8
  if (o[0] === 127) return true;                                  // loopback
  if (o[0] === 192 && o[1] === 168) return true;                  // 192.168.0.0/16
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;      // 172.16.0.0/12
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;     // 100.64.0.0/10 — Tailscale
  if (o[0] === 169 && o[1] === 254) return true;                  // link-local
  return false;
}

/**
 * Throws unless `endpoint` points at a machine on our own network. Called at
 * load and again before every request — a later mutation of process.env cannot
 * sneak a public host past a check that only ran once.
 * @param {string} endpoint
 * @returns {string} the validated origin
 */
function assertLocalHost(endpoint) {
  let u;
  try {
    u = new URL(endpoint);
  } catch (e) {
    throw new Error(`sovereign-model: OLLAMA_HOST is not a URL (${endpoint}) — refusing to send nursery data anywhere.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`sovereign-model: refusing protocol ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ok = host === 'localhost' || host === '::1' || isPrivateIPv4(host);
  if (!ok) {
    throw new Error(
      `sovereign-model: REFUSED — "${host}" is not a private/Tailscale address. ` +
      'b235 reads children\'s and parents\' correspondence; it may only talk to the local ' +
      'Ollama. There is no cloud fallback and this is not overridable.'
    );
  }
  return u.origin;
}

// Fail at require() time, not halfway through a sweep.
assertLocalHost(OLLAMA);

/**
 * Confirm the local box is up and the model is actually installed.
 * @returns {Promise<{host:string, model:string, available:string[]}>}
 * @throws if unreachable or the model is missing — never returns a substitute.
 */
async function assertSovereign(model = ai.model(ROLE)) {
  const origin = assertLocalHost(OLLAMA);
  let res;
  try {
    res = await fetch(`${origin}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(
      `sovereign-model: local Ollama at ${origin} is unreachable (${e.message}). ` +
      'Nursery correspondence is never sent to a cloud model, so there is no fallback — stopping.'
    );
  }
  if (!res.ok) throw new Error(`sovereign-model: /api/tags returned HTTP ${res.status}`);
  const body = await res.json();
  const available = (body.models || []).map((m) => m.name);
  if (!available.includes(model)) {
    throw new Error(
      `sovereign-model: model "${model}" is not installed on ${origin}. ` +
      `Available: ${available.join(', ')}. Set settings.ai_model_overrides "${ROLE}" to one of these — nothing is substituted automatically.`
    );
  }
  return { host: origin, model, available };
}

/**
 * One completion from the local model.
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.system]
 * @param {string} [opts.model]
 * @param {boolean} [opts.json]        ask Ollama to constrain output to JSON
 * @param {number} [opts.temperature]
 * @param {number} [opts.numPredict]
 * @param {boolean} [opts.long]        a long document — asks for the long num_ctx
 * @returns {Promise<string>}
 */
async function generate(opts = {}) {
  const origin = assertLocalHost(OLLAMA); // re-checked per call, deliberately
  const model = opts.model || ai.model(ROLE);
  const body = {
    model,
    prompt: opts.prompt,
    stream: false,
    // A THINKING model — the 122b was, and qwen3.8:27b is. Left to itself,
    // Ollama returned the 122b's answer in `thinking` and left `response` an
    // empty string — which parses as "no JSON", falls back to the rule
    // classifier, and produces a build that looks like it is using the model
    // while never once using it. Verified 2026-08-26: with think:false the same
    // prompt answers in `response`. It is also markedly faster, since none of
    // the token budget is spent reasoning about a classification this small.
    think: opts.think === true,
    options: ai.options({
      temperature: opts.temperature == null ? 0 : opts.temperature,
      num_predict: opts.numPredict == null ? 700 : opts.numPredict,
    }, opts.long ? 'long' : 'default'),
  };
  if (opts.system) body.system = opts.system;
  if (opts.json) body.format = 'json';

  const res = await fetch(`${origin}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs || GENERATE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`sovereign-model: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  // Belt and braces for any model where thinking cannot be turned off: if
  // `response` came back empty but `thinking` has content, the answer is in
  // there. Silently returning '' is the failure mode that hid the bug above.
  const out = String(j.response || '');
  return out.trim() ? out : String(j.thinking || '');
}

/**
 * generate() plus JSON parsing, one retry, and a hard stop. Callers decide what
 * to do on failure — this never invents a verdict.
 * @returns {Promise<{ok:true, value:object}|{ok:false, error:string}>}
 */
async function generateJSON(opts = {}) {
  let lastErr = 'no attempt';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await generate(Object.assign({}, opts, {
        json: true,
        // The retry says so out loud — a model that produced prose the first
        // time usually complies when told what it did wrong.
        prompt: attempt === 0
          ? opts.prompt
          : `${opts.prompt}\n\nYour previous answer was not valid JSON. Reply with a single JSON object and nothing else — no prose, no markdown fence.`,
      }));
      const value = parseLooseJSON(raw);
      if (value && typeof value === 'object') return { ok: true, value, attempts: attempt + 1 };
      lastErr = 'parsed value was not an object';
    } catch (e) {
      lastErr = e.message;
      // A refused-host or unreachable-host error is not worth retrying, and
      // must not be swallowed into a soft failure.
      if (/REFUSED|unreachable|not installed/.test(e.message)) throw e;
    }
  }
  return { ok: false, error: lastErr };
}

/** Tolerate a fenced or prose-wrapped object without accepting nonsense. */
function parseLooseJSON(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { /* fall through */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch (_) { /* fall through */ } }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first > -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch (_) { /* fall through */ }
  }
  return null;
}

module.exports = {
  OLLAMA,
  assertLocalHost, assertSovereign, generate, generateJSON, parseLooseJSON,
  isPrivateIPv4,
};
// inbox-intel and inbox-router record MODEL as "the model that answered" — a
// getter, so it reports what resolves now rather than what did at require time.
Object.defineProperty(module.exports, 'MODEL', { enumerable: true, get: () => ai.model(ROLE) });
