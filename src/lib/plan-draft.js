'use strict';
/*
 * plan-draft.js — b223 (2026-08-24)
 * "Ascent drafts next half-term's plan; staff edit and sign it off."
 *
 * This file is the DRAFTING ENGINE and nothing else: it has no database and no
 * express in it. It is handed the already-gathered evidence (b218) and the card
 * / activity libraries, it builds a prompt, it calls the LOCAL model on Ascent,
 * and it validates what comes back against the things that actually exist.
 *
 * The three rules that shape every decision in here:
 *
 *  1 · The model may only CHOOSE and ARRANGE what it is given. It never supplies
 *      a fact. Intentions are cited by an evidence CODE ("C3") that the server
 *      minted moments earlier; the server — not the model — turns that code back
 *      into real next_step ids, child counts and rooms. A model that hallucinates
 *      a code produces a dropped suggestion, not a wrong citation.
 *
 *  2 · No child data leaves the building, and the model is sent as little as
 *      will do the job: next-step TEXT and counts. No names, no dates of birth,
 *      no ids. Free-text variants are run through area-gather's depersonaliser
 *      before they are quoted, because practitioners write "Bailey needs more
 *      practice cutting" and that string must never reach a prompt intact.
 *
 *  3 · Everything the model returns is validated against the real libraries.
 *      An unknown card slug, an unknown activity id, an unknown evidence code or
 *      an invented next-step id is DROPPED and reported, never quietly kept.
 */

const G = require('./area-gather');

// ── Model / host ─────────────────────────────────────────────────────────────
// Interactive path, so the Ascent (ai-models.js host()) directly — the same
// convention the assistant, sen and termly-reviews routes follow. Never Groq,
// never Anthropic: this prompt is built from real children's next steps.
// b333: the model is ai-models.js role 'heavy', resolved per call.
const ai = require('./ai-models');
const OLLAMA_HOST = () => ai.host();
const OLLAMA_MODEL = () => ai.model('heavy');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.PLAN_DRAFT_TIMEOUT_MS || '180000', 10);

// Caps. A plan is not better for being longer, and a bigger prompt is a slower
// draft: a half-term genuinely carries 1–3 intentions per area.
const MAX_INTENTIONS   = 3;
const MAX_CANDIDATES   = 14;   // gathered clusters offered as evidence
const MAX_CARDS        = 45;   // resource cards offered per draft
const MAX_ACTIVITIES   = 25;
const MAX_CARDS_PER_INTENTION = 4;
const MAX_ACTS_PER_INTENTION  = 3;
const MAX_EXAMPLES     = 6;    // few-shot: the setting's own signed-off intentions
const MAX_TEXT_LEN     = 240;
const MIN_TEXT_LEN     = 12;

// ── Evidence ─────────────────────────────────────────────────────────────────

/**
 * Turn b218 gathered intentions into the redacted evidence list the model sees.
 * Returns { evidence: [...], byRef: Map, dropped: [] }.
 *
 * `evidence` carries ONLY: a code, the already-depersonalised cluster text, a
 * child COUNT, how often it recurred, the sub-aspect, and up to two scrubbed
 * paraphrases. The real ids stay on the server side of the Map.
 */
function buildEvidence(candidates, nameSet, limit) {
  const cap = Number.isInteger(limit) ? limit : MAX_CANDIDATES;
  const byRef = new Map();
  const evidence = [];
  const list = (candidates || []).slice(0, cap);
  list.forEach((c, i) => {
    const ref = 'C' + (i + 1);
    const text = G.depersonalise(c.intention_text, nameSet, 'children');
    // The variants are RAW practitioner text and routinely contain first names.
    const variants = [...new Set((c.variants || [])
      .map(v => G.depersonalise(v, nameSet, 'a child'))
      .map(v => v.trim())
      .filter(v => v && v.toLowerCase() !== text.toLowerCase()))].slice(0, 2);
    byRef.set(ref, c);
    evidence.push({
      ref,
      text,
      child_count: c.child_count || 0,
      recurrence: c.recurrence || 0,
      sub_area: c.sub_area || null,
      variants,
      already_adopted: !!c.already_adopted,
    });
  });
  return { evidence, byRef, offered: evidence.length, total: (candidates || []).length };
}

// ── Libraries ────────────────────────────────────────────────────────────────

/** Age bands a room's children fall in, used to keep baby-room drafts sensible. */
function bandsForRoom(room) {
  if (!room) return [];
  const min = Number(room.min_age_months);
  const max = Number(room.max_age_months);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const out = [];
  if (min < 18) out.push('baby');
  if (max > 12 && min < 42) out.push('toddler');
  if (max > 30) out.push('preschool');
  return out;
}

/**
 * The resource cards offered for this draft: the area's cards, preferring the
 * sub-aspects the evidence actually asked about and the room's age bands.
 * Never the whole 284 — a catalogue the model cannot hold is a catalogue it
 * starts inventing from.
 */
function buildCardPool(cardIndex, opts) {
  const area = opts.area;
  const wantSubs = new Set((opts.subAreas || []).filter(Boolean));
  const bands = new Set(opts.bands || []);
  const limit = Number.isInteger(opts.limit) ? opts.limit : MAX_CARDS;

  const scored = (cardIndex || [])
    .filter(c => Array.isArray(c.areas) && c.areas.includes(area))
    .map(c => {
      const aspects = Array.isArray(c.aspects) ? c.aspects : [];
      const subHits = aspects.filter(a => wantSubs.has(a)).length;
      const bandHit = !bands.size || !Array.isArray(c.age_bands) || !c.age_bands.length
        ? 0.5
        : (c.age_bands.some(b => bands.has(b)) ? 1 : 0);
      // A card tagged with half the framework matches everything and narrows
      // nothing — mild penalty so specific cards float up.
      const spread = aspects.length > 6 ? -0.4 : 0;
      return { card: c, score: subHits * 2 + bandHit + spread };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || String(a.card.title).localeCompare(String(b.card.title)));

  return scored.slice(0, limit).map(x => ({
    slug: x.card.slug,
    title: x.card.title,
    aspects: (x.card.aspects || []).filter(a => wantSubs.has(a) || wantSubs.size === 0).slice(0, 3),
    age_range: x.card.age_range || null,
    strapline: String(x.card.strapline || '').slice(0, 110),
  }));
}

/** curriculum_activities rows already filtered to the area by the caller. */
function buildActivityPool(rows, limit) {
  const cap = Number.isInteger(limit) ? limit : MAX_ACTIVITIES;
  return (rows || []).slice(0, cap).map(r => ({
    id: r.id,
    name: r.name,
    age_range: r.age_range || null,
  }));
}

// ── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM = [
  'You are an experienced early years practitioner in an English day nursery, drafting the',
  'next half-term\'s medium-term plan for ONE area of learning so a colleague can check it.',
  'You are drafting, not deciding: a human will edit and sign off everything you write.',
  '',
  'You must plan ONLY from the evidence, cards and activities you are given.',
  'You must never invent an evidence code, a card slug, an activity number, a child, or a',
  'next step that is not in the lists. You must never write a child\'s name.',
  'Reply with JSON only — no prose before or after it, no markdown fence.',
].join('\n');

function fmtDate(d) {
  if (!d) return '';
  const s = typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
  const dt = new Date(s + 'T00:00:00Z');
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function buildPrompt(ctx) {
  const L = [];
  const p = ctx.period || {};
  L.push(`HALF-TERM BEING PLANNED: ${p.name || 'next half-term'}${p.academic_year ? ' ' + p.academic_year : ''}` +
         (p.start_date ? ` (${fmtDate(p.start_date)} – ${fmtDate(p.end_date)}` +
                          (ctx.weeks ? `, ${ctx.weeks} teaching weeks)` : ')') : ''));
  if (ctx.room) L.push(`ROOM: ${ctx.room.name} (ages ${Math.round((ctx.room.min_age_months || 0) / 12 * 10) / 10}–${Math.round((ctx.room.max_age_months || 0) / 12 * 10) / 10} years)`);
  L.push(`AREA OF LEARNING: ${ctx.area}`);
  if (ctx.subAreas && ctx.subAreas.length) L.push(`SUB-ASPECTS IN THIS AREA: ${ctx.subAreas.join(', ')}`);
  if (ctx.theme) L.push(`THEME ALREADY CHOSEN FOR THE HALF-TERM: ${ctx.theme}`);
  L.push('');

  L.push('EVIDENCE — every current next step across the children, grouped by Wren.');
  L.push('This is the ONLY thing you may plan from. Cite groups by their code.');
  for (const e of ctx.evidence) {
    const bits = [`${e.child_count} ${e.child_count === 1 ? 'child' : 'children'}`,
                  `seen ${e.recurrence}×`];
    if (e.sub_area) bits.push(e.sub_area);
    L.push(`[${e.ref}] (${bits.join(', ')}) ${e.text}`);
    if (e.variants.length) L.push(`      also written as: ${e.variants.map(v => `"${v}"`).join('; ')}`);
  }
  L.push('');

  if (ctx.cards.length) {
    L.push('RESOURCE CARDS — this setting\'s own provision cards. Use the slug in [] exactly.');
    for (const c of ctx.cards) {
      L.push(`[${c.slug}] ${c.title}${c.age_range ? ` (${c.age_range})` : ''}` +
             `${c.aspects.length ? ` — ${c.aspects.join('; ')}` : ''}`);
    }
    L.push('');
  }
  if (ctx.activities.length) {
    L.push('ACTIVITY BANK — this setting\'s own activities. Use the number in [] exactly.');
    for (const a of ctx.activities) {
      L.push(`[${a.id}] ${a.name}${a.age_range ? ` (${a.age_range})` : ''}`);
    }
    L.push('');
  }
  if (ctx.examples && ctx.examples.length) {
    L.push('HOW THIS SETTING WRITES ITS INTENTIONS — real intentions its staff wrote and');
    L.push('signed off in previous half-terms. Match this VOICE and level of detail.');
    L.push('They are examples of style, not content: do not copy them, and do not plan');
    L.push('from them. The evidence above is the only thing you plan from.');
    for (const ex of ctx.examples) L.push(`- ${ex.text}`);
    L.push('');
  }

  L.push('TASK');
  L.push(`Draft between 1 and ${MAX_INTENTIONS} learning intentions for ${ctx.area} for this half-term.`);
  L.push('Fewer, well-evidenced intentions are better than a padded list.');
  L.push('Group evidence that belongs together — one intention may cite several codes.');
  L.push('Lead with what serves the most children.');
  L.push('');
  L.push('RULES');
  L.push('- Every intention MUST cite at least one evidence code from the list above.');
  L.push('- Only use codes, card slugs and activity numbers that appear above. Nothing else exists.');
  L.push('- Never name a child. Write about "children" or "the children who…".');
  L.push('- One sentence per intention, written as something a practitioner will do or provide.');
  L.push(`- At most ${MAX_CARDS_PER_INTENTION} cards and ${MAX_ACTS_PER_INTENTION} activities per intention.`);
  L.push('- "why" is one short sentence saying what in the evidence made you suggest it.');
  L.push('');
  L.push('Reply with JSON in exactly this shape and nothing else:');
  L.push('{"intentions":[{"evidence":["C1","C2"],"intention":"…","why":"…","cards":["card-slug"],"activities":[12]}]}');
  return L.join('\n');
}

// ── Model call ───────────────────────────────────────────────────────────────

/** Reachability probe — GET /api/tags, no model load, so a dead box fails fast. */
async function probe(timeoutMs) {
  try {
    const r = await fetch(`${OLLAMA_HOST()}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs || 6000),
    });
    return !!r.ok;
  } catch (_) { return false; }
}

async function callModel(prompt, opts) {
  const o = opts || {};
  const host = o.host || OLLAMA_HOST();
  const model = o.model || OLLAMA_MODEL();
  const started = Date.now();
  const r = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      system: o.system || SYSTEM,
      prompt,
      stream: false,
      think: false,
      // format:json makes Ollama constrain the decode to valid JSON, which
      // removes the commonest failure (a chatty preamble around the object).
      format: 'json',
      options: ai.options({ temperature: 0.3, num_predict: o.maxTokens || 1400 }, 'long'),
    }),
    signal: AbortSignal.timeout(o.timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Ollama ${r.status}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  const data = await r.json();
  const text = String(data.response || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return { text, ms: Date.now() - started, model, host };
}

function parseModelJson(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('empty response');
  try { return JSON.parse(s); } catch (_) { /* fall through to extraction */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in response');
  return JSON.parse(m[0]);
}

// ── Validation ───────────────────────────────────────────────────────────────

function asArray(v) { return Array.isArray(v) ? v : []; }
function asStr(v) { return String(v == null ? '' : v).trim(); }

/**
 * Check everything the model returned against what really exists.
 *
 * ctx: { byRef, cardBySlug, activityById, nameSet, area, cardPoolSlugs, validNextStepIds }
 * Returns { items, dropped } — `dropped` is shown to the practitioner verbatim,
 * because a validator that silently swallows nonsense is indistinguishable from
 * a model that never produced any.
 */
function validate(parsed, ctx) {
  const dropped = [];
  const items = [];
  const seenClusterSets = new Set();

  const raw = asArray(parsed && (parsed.intentions || parsed.plan || parsed.items));
  if (!raw.length) {
    dropped.push({ kind: 'response', reason: 'no intentions in the model\'s reply' });
    return { items, dropped };
  }

  for (const [i, r] of raw.entries()) {
    const where = `intention ${i + 1}`;
    if (!r || typeof r !== 'object') { dropped.push({ kind: 'intention', where, reason: 'not an object' }); continue; }

    // ── evidence codes → real clusters ──────────────────────────────────────
    const refsIn = asArray(r.evidence)
      .concat(asArray(r.evidence_codes), asArray(r.refs))
      .map(x => asStr(x).toUpperCase());
    const refs = [];
    for (const ref of [...new Set(refsIn)]) {
      if (ctx.byRef.has(ref)) refs.push(ref);
      else dropped.push({ kind: 'evidence_code', where, value: ref, reason: 'no such evidence code — invented' });
    }
    if (!refs.length) {
      dropped.push({ kind: 'intention', where, value: asStr(r.intention).slice(0, 120),
                     reason: 'cited no real evidence, so nothing traces back to an observation' });
      continue;
    }

    // ── text ────────────────────────────────────────────────────────────────
    let text = asStr(r.intention || r.text || r.title);
    if (text.length < MIN_TEXT_LEN) {
      dropped.push({ kind: 'intention', where, value: text, reason: 'intention text too short to act on' });
      continue;
    }
    if (text.length > MAX_TEXT_LEN) text = text.slice(0, MAX_TEXT_LEN).replace(/\s+\S*$/, '') + '…';
    // Belt and braces: the prompt forbids names, so this should be a no-op —
    // when it is not, the practitioner is told it fired.
    const scrubbed = G.depersonalise(text, ctx.nameSet, 'children');
    if (scrubbed.toLowerCase() !== text.toLowerCase()) {
      dropped.push({ kind: 'child_name', where, value: text,
                     reason: 'a child\'s name appeared in the drafted text — removed' });
      text = scrubbed;
    }

    // ── cards ───────────────────────────────────────────────────────────────
    const cards = [];
    for (const s of [...new Set(asArray(r.cards).concat(asArray(r.resource_cards)).map(asStr))]) {
      if (!s) continue;
      const slug = s.replace(/^\[|\]$/g, '');
      if (!ctx.cardBySlug[slug]) {
        dropped.push({ kind: 'card', where, value: slug, reason: 'no such resource card — invented' });
        continue;
      }
      if (ctx.cardPoolSlugs && !ctx.cardPoolSlugs.has(slug)) {
        dropped.push({ kind: 'card', where, value: slug,
                       reason: 'real card, but not one offered for this area — dropped' });
        continue;
      }
      if (cards.length < MAX_CARDS_PER_INTENTION) cards.push(slug);
    }

    // ── activities ──────────────────────────────────────────────────────────
    const acts = [];
    for (const a of [...new Set(asArray(r.activities).concat(asArray(r.activity_ids)))]) {
      const id = parseInt(typeof a === 'object' && a ? a.id : a, 10);
      if (!Number.isInteger(id)) continue;
      if (!ctx.activityById.has(id)) {
        dropped.push({ kind: 'activity', where, value: id, reason: 'no such activity in the bank — invented' });
        continue;
      }
      if (acts.length < MAX_ACTS_PER_INTENTION) acts.push(id);
    }

    // ── volunteered next-step ids ───────────────────────────────────────────
    // The model is never SHOWN a next-step id — the server derives them from the
    // cited clusters. If a model volunteers one anyway it is checked against the
    // real table and against the clusters it cited, and dropped if it is neither.
    const citedIds = new Set();
    for (const ref of refs) {
      for (const s of (ctx.byRef.get(ref).sources || [])) {
        if (s.next_step_id) citedIds.add(s.next_step_id);
      }
    }
    for (const n of [...new Set(asArray(r.next_step_ids).concat(asArray(r.next_steps)))]) {
      const id = parseInt(typeof n === 'object' && n ? n.id : n, 10);
      if (!Number.isInteger(id)) continue;
      if (!ctx.validNextStepIds || !ctx.validNextStepIds.has(id)) {
        dropped.push({ kind: 'next_step_id', where, value: id, reason: 'no such next step in the database — invented' });
      } else if (!citedIds.has(id)) {
        dropped.push({ kind: 'next_step_id', where, value: id,
                       reason: 'real next step, but not one of the cited groups — dropped' });
      }
    }

    // ── de-duplicate ────────────────────────────────────────────────────────
    const key = refs.slice().sort().join('|');
    if (seenClusterSets.has(key)) {
      dropped.push({ kind: 'intention', where, value: text, reason: 'duplicate of an earlier suggestion (same evidence)' });
      continue;
    }
    seenClusterSets.add(key);

    // ── build the item from the SERVER's copy of the evidence ───────────────
    const clusters = refs.map(ref => ctx.byRef.get(ref));
    const childIds = new Set();
    const nextStepIds = new Set();
    const obsIds = new Set();
    const subCount = new Map();
    let recurrence = 0;
    for (const c of clusters) {
      (c.children || []).forEach(ch => childIds.add(ch.child_id));
      (c.sources || []).forEach(s => {
        if (s.next_step_id) nextStepIds.add(s.next_step_id);
        if (s.observation_id) obsIds.add(s.observation_id);
      });
      recurrence += c.recurrence || 0;
      if (c.sub_area) subCount.set(c.sub_area, (subCount.get(c.sub_area) || 0) + (c.child_count || 1));
    }
    const subArea = [...subCount.entries()].sort((a, b) => b[1] - a[1])[0];

    items.push({
      area: ctx.area,
      sub_area: subArea ? subArea[0] : null,
      intention_text: text,
      why: asStr(r.why || r.rationale || r.reason).slice(0, 400) || null,
      // Wren's own count-based rationale, in the same wording b218 uses, so the
      // number a practitioner sees never depends on what the model said.
      rationale: `${childIds.size} ${childIds.size === 1 ? 'child' : 'children'} · ` +
                 `${nextStepIds.size + obsIds.size} next step${nextStepIds.size + obsIds.size === 1 ? '' : 's'} · ` +
                 `from ${refs.length} gathered group${refs.length === 1 ? '' : 's'}`,
      refs,
      cluster_keys: clusters.map(c => c.cluster_key),
      next_step_ids: [...nextStepIds],
      observation_ids: [...obsIds],
      child_count: childIds.size,
      recurrence,
      card_slugs: cards,
      activity_ids: acts,
    });
    if (items.length >= MAX_INTENTIONS) {
      if (i + 1 < raw.length) {
        dropped.push({ kind: 'intention', where: `intentions ${i + 2}–${raw.length}`,
                       reason: `over the ${MAX_INTENTIONS}-per-area cap` });
      }
      break;
    }
  }

  items.sort((a, b) => b.child_count - a.child_count || b.recurrence - a.recurrence);
  return { items, dropped };
}

module.exports = {
  MAX_INTENTIONS, MAX_CANDIDATES, MAX_CARDS, MAX_ACTIVITIES, MAX_EXAMPLES,
  MAX_CARDS_PER_INTENTION, MAX_ACTS_PER_INTENTION,
  SYSTEM,
  OLLAMA_HOST, OLLAMA_MODEL, DEFAULT_TIMEOUT_MS,
  bandsForRoom, buildEvidence, buildCardPool, buildActivityPool,
  buildPrompt, probe, callModel, parseModelJson, validate,
};
