'use strict';
/**
 * b311 — phrasing. The ONLY place a model touches this build.
 *
 *     signal (SQL, deterministic) → threshold → phrasing (local model) → one notification
 *
 * The model is handed a sentence that is already true and asked to say the same
 * thing more naturally. It never sees the question, never sees the threshold and
 * never returns a verdict. If it is unreachable, slow, or says something the
 * facts do not support, the deterministic sentence goes out unchanged and the
 * event records `phrasing_source = 'deterministic'`.
 *
 * ── WHY THE FIDELITY CHECK IS ARITHMETIC ────────────────────────────────────
 * "Do not invent anything" is not enforceable by asking. What IS enforceable:
 * a rephrasing of a sentence about numbers must carry the same figures as the
 * original — none dropped, none added. checkFidelity() compares the two sets of
 * figures and rejects on any difference. That one rule catches the failure that
 * actually matters here: a model rounding "3 children" to "a few", or helpfully
 * adding "(down from 5 last month)" out of nowhere.
 *
 * ── WHERE IT RUNS ───────────────────────────────────────────────────────────
 * The brief asked to reuse hermes-work (container, :8642) for phrasing. Probed
 * 2026-09-10: that port accepts no HTTP — hermes-work is a Telegram gateway
 * process, not an HTTP service, and every path tried returned a connection
 * error. So this calls the SAME model on the SAME box by the path Wren already
 * uses everywhere else: src/lib/sovereign-model.js against the Ascent's Ollama.
 * That module refuses at parse time to construct a URL for anything that is not
 * a private / Tailscale / loopback IP, so GDPR wall 2 ("child data goes to the
 * local model only") is enforced by the URL parser rather than by this comment.
 */

const sovereign = require('../sovereign-model');
const ai = require('../ai-models');

// The model when settings.signals_model is empty: ai-models.js role 'heavy',
// resolved per call (b333) so a settings row can move it without a deploy.
function defaultModel() { return ai.model('heavy'); }
const MAX_CHARS = 320;
const PROBE_CACHE_MS = 5 * 60 * 1000;

let _probe = { at: 0, ok: null, note: '' };

const SYSTEM = [
  'You rewrite one short factual sentence for the manager of a UK day nursery.',
  'You are not an assistant and you are not being asked a question.',
  'Rules, in order of importance:',
  '1. Change no fact. Every number in the input must appear in your output, and you must add no number that is not in the input.',
  '2. Write every figure as digits — 4, not "four". A rewrite that spells a figure out will be rejected.',
  '3. Do not add advice, reassurance, greetings, sign-offs or emoji.',
  '4. Do not name any person.',
  '5. British English. One or two short sentences. Under 300 characters.',
  'Reply with the rewritten sentence only.',
].join('\n');

// Number words 0–20 and the tens, so a model that writes "Four children" for
// "4 children" is understood to have KEPT the figure rather than dropped it.
// Used one way only — see checkFidelity.
const WORD_NUMBERS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40',
  fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
};

/** The digit values a piece of text spells out in words. */
function spelledNumbersIn(text) {
  const out = [];
  const words = String(text || '').toLowerCase().match(/[a-z]+/g) || [];
  for (const w of words) if (WORD_NUMBERS[w]) out.push(WORD_NUMBERS[w]);
  return out;
}

/** Every number in a string, as a multiset key. "3 children by 25 Sep" → ['3','25']. */
function numbersIn(text) {
  const found = String(text || '').match(/\d+(?:[.,]\d+)*/g) || [];
  return found.map(n => n.replace(/,/g, ''));
}

function _multiset(arr) {
  return arr.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {});
}

/**
 * Does `candidate` say the same numbers as `headline`?
 *
 * DISTINCT figures, compared both ways: nothing invented, nothing lost. It is
 * deliberately not a multiset comparison — "2 of 2 open concerns" rewritten as
 * "both of the 2 open concerns" drops a repeat of a figure that is still there,
 * which is a fluent rewrite rather than a fidelity failure, and rejecting it
 * every time would leave the phrasing layer switched on but never used
 * (observed on the first dev run, 2026-09-10).
 *
 * The residual risk this accepts is a transposition — "3 of 2" for "2 of 3".
 * It is accepted knowingly: the temperature is 0.2 on a rewrite task, and the
 * deterministic sentence is stored beside the sent one on every signal_events
 * row, so any such case is visible rather than lost.
 *
 * Number WORDS are counted one way only. A spelled-out figure can satisfy a
 * figure the headline asked for ("Four children" keeps the 4), but is never
 * read as an invented one — otherwise the ordinary English "one of them" would
 * be accused of adding a 1, and the check would reject its way to uselessness.
 *
 * @returns {{ok:boolean, reason:string}}
 */
function checkFidelity(headline, candidate) {
  const want = _multiset(numbersIn(headline));
  const got = _multiset(numbersIn(candidate).concat(spelledNumbersIn(candidate)));
  const gotDigits = _multiset(numbersIn(candidate));
  for (const k of Object.keys(want)) {
    if (!got[k]) return { ok: false, reason: `dropped the figure ${k}` };
  }
  for (const k of Object.keys(gotDigits)) {
    if (!want[k]) return { ok: false, reason: `invented the figure ${k}` };
  }
  return { ok: true, reason: '' };
}

/** Strip the things a chat model adds by habit and a notification must not carry. */
function tidy(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```[a-z]*\s*|\s*```$/gi, '').trim();
  s = s.replace(/^["'“‘]|["'”’]$/g, '').trim();
  // Some local models still emit a <think> block even with think:false.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Is the local model reachable, with the configured model installed?
 * Cached for five minutes so a dead Ascent costs one probe an hour, not one
 * probe per signal per run.
 */
async function probe(model) {
  const now = Date.now();
  if (_probe.ok !== null && (now - _probe.at) < PROBE_CACHE_MS) return _probe;
  let ok = false, note = '';
  try {
    await sovereign.assertSovereign(model || defaultModel());
    ok = true;
  } catch (e) {
    note = e.message;
  }
  _probe = { at: now, ok, note };
  return _probe;
}

/**
 * Rephrase `headline`, or return it untouched.
 *
 * @param {object} opts
 * @param {string} opts.headline    the deterministic claim of record
 * @param {object} opts.facts       counts/ids/dates — included so the model has
 *                                  context, never so it can add to the sentence
 * @param {boolean} opts.enabled    settings.signals_phrasing
 * @param {string} opts.model
 * @param {number} opts.timeoutMs
 * @param {function} [opts.veto]    async (text) => string|null — a reason to
 *                                  reject this candidate (the child-name guard)
 * @returns {Promise<{text:string, source:'deterministic'|'local_model', note:string}>}
 */
async function phrase(opts = {}) {
  const headline = String(opts.headline || '').trim();
  const det = { text: headline, source: 'deterministic', note: '' };
  if (!headline) return det;
  if (opts.enabled === false) return Object.assign({}, det, { note: 'phrasing off' });

  const model = opts.model || defaultModel();
  const p = await probe(model);
  if (!p.ok) return Object.assign({}, det, { note: `local model unavailable: ${p.note}`.slice(0, 300) });

  let raw;
  try {
    raw = await sovereign.generate({
      model,
      system: SYSTEM,
      prompt: [
        'Rewrite this sentence for a nursery manager. Keep every figure exactly as given.',
        '',
        `SENTENCE: ${headline}`,
        '',
        `FIGURES (for context only — do not add any that are not already in the sentence): ${JSON.stringify(opts.facts || {})}`,
      ].join('\n'),
      think: false,
      temperature: 0.2,
      numPredict: 160,
      timeoutMs: opts.timeoutMs || 25000,
    });
  } catch (e) {
    return Object.assign({}, det, { note: `local model error: ${e.message}`.slice(0, 300) });
  }

  const cand = tidy(raw);
  if (!cand) return Object.assign({}, det, { note: 'local model returned nothing' });
  if (cand.length > MAX_CHARS) {
    return Object.assign({}, det, { note: `local model wrote ${cand.length} chars` });
  }
  const fid = checkFidelity(headline, cand);
  if (!fid.ok) return Object.assign({}, det, { note: `rejected: ${fid.reason}` });

  if (typeof opts.veto === 'function') {
    const why = await opts.veto(cand);
    if (why) return Object.assign({}, det, { note: `rejected: ${why}` });
  }

  return { text: cand, source: 'local_model', note: '' };
}

/** Test hook — force the next probe to run for real. */
function _reset() { _probe = { at: 0, ok: null, note: '' }; }

module.exports = {
  phrase, checkFidelity, numbersIn, spelledNumbersIn, tidy, probe, _reset,
  defaultModel, MAX_CHARS, SYSTEM, WORD_NUMBERS,
};
