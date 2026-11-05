'use strict';
/**
 * redraft.js — "Redraft" for long text boxes (Aimey-style), 2026-11-02.
 *
 * POST /api/redraft  { mode, text }  →  { result, mode, changed_pct, warnings[], model }
 *
 * WHY THIS ROUTE (and not ai-helper.js): ai-helper posts to ai.host() with no host
 * check. Practitioners type children's names, health and family detail into these
 * boxes, so the text may ONLY go to the local Ollama on the Ascent. This route calls
 * src/lib/sovereign-model.js, which refuses any non-private/non-Tailscale host before
 * every request — there is no cloud path here to fall back to.
 *
 * HOW MUCH TO CHANGE (the point of the build): the default mode is a LIGHT polish —
 * spelling, grammar, punctuation, clarity — keeping the practitioner's own facts,
 * order and voice. It must not add detail, names, numbers, EYFS areas, age bands,
 * judgements or next steps that were not written. Measured on synthetic notes, Polish
 * changes well under 20% of words (scripts/redraft-measure.js). The page never
 * auto-replaces: the client shows a before/after diff and the user Accepts or not.
 *
 * Logging is counts-only (lengths, %, ms) — never the text (GDPR rule 8 /
 * "counts only on every write path").
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const authenticate = require('../middleware/auth');
const sovereign = require('../lib/sovereign-model');
const ai = require('../lib/ai-models');

const router = express.Router();
const MAX_CHARS = 4000;

const RULES = `Rules you must follow:
- Use UK English spelling (e.g. colour, recognise, nappy, mum).
- Keep every fact exactly as written: who, what, when, how many, what was said. Keep quoted words exactly.
- Do NOT add anything that is not in the original: no new details, events, feelings, names, ages, numbers, times, EYFS areas of learning, age bands, assessments, judgements or next steps.
- Keep names exactly as written; never add a name or replace one. Do not add a greeting or sign-off unless there is one already.
- Keep the writer's point of view (I / we / the child's name) and the original order of events. If the original has no subject (e.g. "ate all lunch"), do not add one — never write a placeholder such as [Child's name].
- Return ONLY the rewritten text — no heading, no quotation marks around it, no notes, no explanation.`;

const MODES = {
  polish: {
    label: 'Polish',
    temperature: 0.1,
    prompt: (t) => `You are proofreading a note written by a nursery practitioner. Make a LIGHT edit only: correct spelling, grammar and punctuation, expand text-speak (e.g. "u" → "you", "w/" → "with"), and fix any sentence that is hard to follow. Leave everything else alone — keep the practitioner's own words, phrasing and length. If a sentence is already correct, copy it unchanged. Do not make it more formal or more flowery.\n\n${RULES}\n\nNote:\n<<<\n${t}\n>>>`,
  },
  warmer: {
    label: 'Warmer for parents',
    temperature: 0.4,
    prompt: (t) => `You are helping a nursery practitioner reword a note that a parent will read at home. Rewrite it so it sounds warm, friendly and personal — as if a caring key person were telling the parent about their child's day — in plain everyday language with no jargon. You may reword sentences, use friendlier verbs ("loved", "enjoyed", "had great fun") where the note shows enjoyment, and add a short warm phrase that does not state any new fact (e.g. "It was lovely to see…"). Correct any spelling and grammar. Keep it about the same length (at most one sentence longer).\n\n${RULES}\n\nNote:\n<<<\n${t}\n>>>`,
  },
  shorter: {
    label: 'Shorter',
    temperature: 0.2,
    prompt: (t) => `You are helping a nursery practitioner make a note shorter and clearer. Aim for about two-thirds of the original length: remove repetition, filler and unnecessary words, merge sentences, and correct spelling and grammar. Keep every fact and anything the child said word for word.\n\n${RULES}\n\nNote:\n<<<\n${t}\n>>>`,
  },
  expand: {
    label: 'Full sentences',
    temperature: 0.2,
    prompt: (t) => `You are helping a nursery practitioner turn brief notes into a clear, well-written observation in full sentences, in a professional early-years tone. Correct all spelling and grammar, expand abbreviations and note-style fragments (e.g. "slept 1hr 10" → "slept for an hour and ten minutes"), and join them into flowing sentences. Use ONLY the information in the notes and invent nothing — no learning areas, no interpretation of what it shows, no next steps. If the notes are short, the result should still be short.\n\n${RULES}\n\nNotes:\n<<<\n${t}\n>>>`,
  },
};

// ── word-level change measure (shared with scripts/redraft-measure.js) ─────────
function words(s) { return String(s || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || []; }
/** Word-level Levenshtein distance / longer length, as a percentage. */
function changedPct(a, b) {
  const x = words(a), y = words(b);
  const n = Math.max(x.length, y.length);
  if (!n) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.round((prev[y.length] / n) * 100);
}

/** Things a redraft should never introduce: new capitalised names or new numbers. */
const COMMON_CAPS = new Set(['i', 'mum', 'dad', 'eyfs', 'sen', 'send', 'senco', 'ok', 'today', 'monday', 'tuesday',
  'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'english', 'nursery', 'pre-school', 'baby', 'room']);
function guardWarnings(src, out) {
  const warnings = [];
  const inWords = new Set(words(src));
  // a capitalised word not at a sentence start and not in the original
  const caps = (out.match(/(?<![.!?]\s|^|\n)\b[A-Z][a-z]{2,}\b/g) || [])
    .filter((w) => !inWords.has(w.toLowerCase()) && !COMMON_CAPS.has(w.toLowerCase()));
  if (caps.length) warnings.push(`New capitalised word(s) not in your text: ${[...new Set(caps)].slice(0, 5).join(', ')} — check no name or detail was added.`);
  if (/\[[^\]]{2,40}\]/.test(out) && !/\[[^\]]{2,40}\]/.test(src)) warnings.push('The redraft contains a [placeholder] — fill it in or remove it.');
  const nums = (out.match(/\b\d+(?:[.:]\d+)?\b/g) || []).filter((d) => !src.includes(d));
  if (nums.length) warnings.push(`New number(s) not in your text: ${[...new Set(nums)].slice(0, 5).join(', ')} — check before accepting.`);
  return warnings;
}

function cleanOutput(raw) {
  let s = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  s = s.replace(/^<<<\s*|\s*>>>$/g, '').trim();
  s = s.replace(/^(?:here(?:'s| is) (?:the|your)[^:\n]*:\s*)/i, '').trim();
  if (/^["“].*["”]$/s.test(s)) s = s.slice(1, -1).trim();
  return s;
}

async function redraft(mode, text) {
  const m = MODES[mode];
  const words_in = words(text).length;
  const raw = await sovereign.generate({
    model: ai.model('default'),
    prompt: m.prompt(text),
    temperature: m.temperature,
    numPredict: Math.min(1200, Math.max(200, Math.round(words_in * (mode === 'expand' ? 3 : 2)) + 80)),
    timeoutMs: 60000,
  });
  return cleanOutput(raw);
}

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  keyGenerator: (req) => 'u' + String((req.user && (req.user.id || req.user.staff_id)) || req.ip || 'anon'),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many redrafts — please wait a minute.' },
});

router.use(authenticate);

router.get('/modes', (req, res) => {
  res.json({ default: 'polish', max_chars: MAX_CHARS,
    modes: Object.entries(MODES).map(([k, v]) => ({ mode: k, label: v.label })) });
});

router.post('/', limiter, async (req, res) => {
  if (req.user && req.user.role === 'parent') return res.status(403).json({ error: 'Not available' });
  const mode = String((req.body && req.body.mode) || 'polish');
  const text = String((req.body && req.body.text) || '');
  if (!MODES[mode]) return res.status(400).json({ error: 'Unknown mode' });
  if (words(text).length < 3) return res.status(400).json({ error: 'Write a little more first' });
  if (text.length > MAX_CHARS) return res.status(400).json({ error: `Too long to redraft (max ${MAX_CHARS} characters)` });

  const t0 = Date.now();
  try {
    const result = await redraft(mode, text);
    if (!result) return res.status(502).json({ error: 'The local model returned nothing — try again' });
    const pct = changedPct(text, result);
    const warnings = guardWarnings(text, result);
    // counts only — never the text
    console.log(`[redraft] staff=${(req.user && req.user.id) || '?'} mode=${mode} in=${text.length} out=${result.length} changed=${pct}% warn=${warnings.length} ms=${Date.now() - t0}`);
    res.json({ result, mode, changed_pct: pct, warnings, model: ai.model('default') });
  } catch (e) {
    console.error(`[redraft] mode=${mode} in=${text.length} failed: ${String(e.message).slice(0, 160)}`);
    const timeout = /timeout|aborted/i.test(e.message);
    res.status(timeout ? 504 : 503).json({ error: timeout ? 'The local AI took too long — try again' : 'The local AI is unavailable right now' });
  }
});

module.exports = router;
module.exports._internal = { MODES, changedPct, guardWarnings, cleanOutput, redraft, words };
