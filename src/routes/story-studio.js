'use strict';
/**
 * Story Studio (b110, extended b140) — original shared-story → rich-vocabulary →
 * children draw & mark-make → adult scribes pedagogy. Generic early-years/KS1
 * practice implemented as our own feature. No third-party pack text/format/brand
 * names are used or stored; all generated content is original, fresh per request.
 *
 * Two modes:
 *  - SINGLE SESSION (b110): one story, one sitting.
 *  - WEEK ARC (b140): a story runs for a week — day 1 draw the character, day 2
 *    draw the setting/world, days 3-5 are original "what happens next?" twist days.
 *    A week shares one ~8-word vocabulary bank (spread fresh across the days) and
 *    a small original "Story Codes" bank (number/letter codes children add to their
 *    drawings that do something in the picture's world).
 *
 * Schema-agnostic: uses unqualified table names, relying on the pool's search_path
 * (PG_SCHEMA) — this lets the SAME route serve LADN (schema `ladn`) and the primary
 * demo (schema `demo_primary`) without any hard-coded schema prefix.
 *
 * Model provider: follows the same AI_PROVIDER convention as src/routes/ai.js —
 * Groq for demo editions (AI_PROVIDER=groq), local Ollama for LADN production.
 *
 * Routes (mounted at /api/story-studio):
 *   GET   /tales                      built-in public-domain tale list
 *   GET   /rooms                      this edition's rooms (for the room/age-band picker)
 *   POST  /plan                       generate an original, editable SINGLE session pack
 *   GET   /                           list saved single sessions (?room_id=&limit=) — week days excluded
 *   GET   /vocab-history              distinct treasure words already used (?room_id=) — avoid repeats
 *   GET   /:id                        one saved session (single or a week's day row)
 *   POST  /                           save a single session (create)
 *   PATCH /:id                        update a saved session
 *   POST  /:id/capture                capture a child's drawing as an observation
 *   DELETE /:id                       delete a saved session
 *
 *   POST  /plan-week                  generate an original, editable WEEK pack (5 days)
 *   GET   /weeks                      list saved weeks (?room_id=)
 *   GET   /weeks/:id                  one week + its 5 day rows
 *   PATCH /weeks/:id                  update week-level fields (vocab bank, codes bank, briefs, notes)
 *   PATCH /weeks/:id/days/:day_no     update one day's pack
 *   DELETE /weeks/:id                 delete a week + its day rows
 *   POST  /weeks/:id/add-to-plan      drop the week's 5 days into planned-activities
 */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireCapabilityLevel } = require('../lib/capabilities');
const ai = require('../lib/ai-models');

router.use(authenticate);

// ── Model provider (mirrors src/routes/ai.js's AI_PROVIDER convention) ─────────
const OLLAMA_URL = ai.host();
// Creative, structured drafting → ai-models.js role 'heavy', resolved per call.
// (b333: was OLLAMA_STORY_MODEL / qwen3.6:35b-a3b. That override existed because the
// 4b default could not co-load beside a pinned 35b; every role now resolves in one
// place, so there is no small model to steer around.)
const OLLAMA_MODEL = () => ai.model('heavy');
const AI_PROVIDER = process.env.AI_PROVIDER || 'ollama';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_STORY_MODEL || 'llama-3.3-70b-versatile';

function stripThink(s) {
  return String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Extract the first balanced {...} JSON object from a model response.
function extractJson(text) {
  const t = stripThink(text);
  // Prefer a fenced ```json block if present.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : t;
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(candidate.slice(start, i + 1)); } catch { return null; } } }
    }
  }
  return null;
}

async function callOllamaJSON(prompt, { numPredict = 900, timeoutMs = 45000, model = OLLAMA_MODEL() } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false, think: false,
        format: 'json',
        options: ai.options({ temperature: 0.8, num_predict: numPredict }),
      }),
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    const data = await r.json();
    return data.response;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGroqJSON(prompt, { maxTokens = 1500, timeoutMs = 45000 } = {}) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: 'You return ONLY a single minified JSON object. No commentary, no markdown fences.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens, temperature: 0.8,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Groq ${r.status}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || '';
}

// Universal generator — provider from env, returns { text, model }
async function generateJSON(prompt, opts) {
  if (AI_PROVIDER === 'groq' && GROQ_API_KEY) {
    return { text: await callGroqJSON(prompt, opts), model: GROQ_MODEL };
  }
  const model = OLLAMA_MODEL();   // resolved once: the model asked is the model reported
  return { text: await callOllamaJSON(prompt, { ...opts, model }), model };
}

// ── Built-in public-domain tales (all long out of copyright — titles only; we never
//    reproduce any book's text, we generate original material around the theme) ──────
const BUILTIN_TALES = [
  { id: 'three-little-pigs',      title: 'The Three Little Pigs',            blurb: 'Straw, sticks and bricks — and a huffing, puffing wolf.' },
  { id: 'gingerbread-man',        title: 'The Gingerbread Man',              blurb: 'A freshly-baked runaway nobody can catch.' },
  { id: 'billy-goats-gruff',      title: 'The Three Billy Goats Gruff',      blurb: 'Trip-trapping over the bridge past a grumpy troll.' },
  { id: 'little-red-hen',         title: 'The Little Red Hen',               blurb: '"Who will help me plant the wheat?" — and who will help eat the bread.' },
  { id: 'enormous-turnip',        title: 'The Enormous Turnip',              blurb: 'Everyone pulls together for one giant vegetable.' },
  { id: 'goldilocks',             title: 'Goldilocks and the Three Bears',   blurb: 'Too hot, too cold, too big, too small — and just right.' },
  { id: 'jack-beanstalk',         title: 'Jack and the Beanstalk',           blurb: 'Magic beans, a towering vine and a giant in the clouds.' },
  { id: 'town-country-mouse',     title: 'The Town Mouse and the Country Mouse', blurb: 'Two mice discover home is where you feel safe.' },
  { id: 'ugly-duckling',          title: 'The Ugly Duckling',                blurb: 'A little bird grows into exactly who they were meant to be.' },
  { id: 'stone-soup',             title: 'Stone Soup',                       blurb: 'A pot, a stone and a village that shares.' },
  { id: 'red-riding-hood',        title: 'Little Red Riding Hood',           blurb: 'Through the woods to Grandma\'s house.' },
  { id: 'three-bears-picnic',     title: 'The Bears\' Picnic',               blurb: 'Packing a basket and setting off into the woods.' },
  { id: 'hare-tortoise',          title: 'The Hare and the Tortoise',        blurb: 'Slow and steady wins the race.' },
  { id: 'ant-grasshopper',        title: 'The Ant and the Grasshopper',      blurb: 'Working hard in summer for the winter ahead.' },
  { id: 'city-mouse-cheese',      title: 'The Lion and the Mouse',           blurb: 'Even the smallest friend can help the mightiest.' },
  { id: 'chicken-licken',         title: 'Chicken Licken',                   blurb: '"The sky is falling!" — a worried hen and her friends.' },
  { id: 'elves-shoemaker',        title: 'The Elves and the Shoemaker',      blurb: 'Little helpers who work through the night.' },
  { id: 'princess-pea',           title: 'The Princess and the Pea',         blurb: 'One tiny pea under a very tall pile of mattresses.' },
  { id: 'thumbelina',             title: 'Thumbelina',                       blurb: 'A tiny girl\'s big adventure among the flowers.' },
  { id: 'frog-prince',            title: 'The Frog Prince',                  blurb: 'A golden ball, a wish and a frog by the well.' },
  { id: 'wild-swans',             title: 'The Wild Swans',                   blurb: 'A brave sister and her swan brothers.' },
  { id: 'magic-porridge-pot',     title: 'The Magic Porridge Pot',           blurb: 'A little pot that will not stop cooking.' },
  { id: 'sun-and-wind',           title: 'The North Wind and the Sun',       blurb: 'Who is stronger — a fierce gust or a warm glow?' },
  { id: 'seasons-tree',           title: 'The Great Big Tree Through the Seasons', blurb: 'One tree watched across spring, summer, autumn and winter.' },
  { id: 'owl-babies',             title: 'Three Little Owls Wait for Mummy', blurb: 'Waiting on a branch in the dark for someone you love.' },
];

// ── Age-band helpers ──────────────────────────────────────────────────────────
// Bands: baby (LADN Baby Room, single-session only) · preschool (LADN Pre-school)
// · reception / ks1 (primary — Reception & Year 1-2's natural home for this feature).
function bandFromRoom(roomId) {
  return Number(roomId) === 1 ? 'baby' : 'preschool';
}
function bandFromRoomName(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('baby')) return 'baby';
  if (n.includes('pre-school') || n.includes('preschool')) return 'preschool';
  if (n.includes('reception')) return 'reception';
  return 'ks1'; // Year 1 and up
}
const BAND_LABEL = {
  baby:      'Baby Room (6m–2yr) — pre-verbal / early talkers',
  preschool: 'Pre-school (3–5yr)',
  reception: 'Reception (4–5yr, EYFS)',
  ks1:       'Year 1–2 (5–7yr, KS1)',
};

// ── IP guardrail: never let generated content use a commercial pack's terms ────
const BANNED_TERMS_GUARD =
  'Never use the phrases "Drawing Club", "Message Centre", "Adventure Island", ' +
  '"Location Spells" or "Mini Moments" anywhere in your response, and never reproduce ' +
  'any commercial practitioner pack\'s text, vocabulary lists or prompts — every word ' +
  'must be your own original invention.';

// A blank, editable skeleton returned when the model is offline so the adult
// can still fill the cards in by hand and save/print the session.
function blankPack(title, band) {
  const baby = band === 'baby';
  return {
    vocab: [
      { word: '', definition: '', action: '' },
      { word: '', definition: '', action: '' },
      { word: '', definition: '', action: '' },
    ],
    invitation: '',
    adventure_prompt: '',
    secret_code: '',
    stretch_questions: baby ? [] : ['', ''],
    source_title: title || '',
    baby_variant: baby,
  };
}

function buildPrompt({ source_type, source_title, theme, band }) {
  const bandLabel = BAND_LABEL[band] || BAND_LABEL.preschool;
  const baby = band === 'baby';
  let anchor;
  if (source_type === 'book') {
    anchor = `The adult will share a picture book the setting already owns, titled "${source_title}". Do NOT reproduce or quote that book's text — work only from its likely THEME and mood.`;
  } else if (source_type === 'animation') {
    anchor = `The adult will share a short animation on the theme "${source_title || theme}". Work from the THEME only; invent everything original.`;
  } else {
    anchor = `The adult will share the well-known public-domain tale "${source_title}". Use it only as a familiar springboard — invent original words, prompts and ideas.`;
  }

  let bandGuidance;
  if (baby) {
    bandGuidance = `This is the BABY / early-talker variant: make it SENSORY and sound-led. The three "treasure words" should be simple, concrete and highly repeatable (single words or story-sounds like "splash", "stomp", "knock"). Definitions must be one short sentence a baby-room practitioner would say aloud. Each action should be a big gross-motor or sensory action / sound to make together. The invitation is a warm sing-song sensory welcome. The adventure prompt is a mark-making / sensory-tray invitation (chunky crayons, gloop, fingers), not a "what happens next" story twist. Use an EMPTY stretch_questions array [] — babies don't need them.`;
  } else if (band === 'reception' || band === 'ks1') {
    const ks1Extra = band === 'ks1' ? ' Children at this age are beginning to read and write independently, so the adult-facing language can be a touch more sophisticated, but the child-facing invitation and prompt stay warm, playful and spoken aloud — this is still talk-and-draw, never a worksheet.' : '';
    bandGuidance = `This is the ${band === 'ks1' ? 'YEAR 1-2 (KS1)' : 'RECEPTION'} variant. The three "treasure words" should be genuinely ambitious vocabulary (Tier-2, and for KS1 a little Tier-3) the children may not yet know, each with a child-friendly one-sentence definition and a memorable physical action to "catch" the word.${ks1Extra} The invitation warmly draws children together. The adventure prompt is an open "what happens next…?" style drawing twist that invites children to draw AND mark-make their own ideas (the adult scribes what each child says, or the child writes a word or two themselves if ready). Include exactly two stretch questions that deepen thinking.`;
  } else {
    bandGuidance = `This is the PRE-SCHOOL variant. The three "treasure words" should be juicy, ambitious vocabulary the children may not yet know (Tier-2 words), each with a child-friendly one-sentence definition and a memorable physical action to "catch" the word. The invitation warmly draws children to the carpet. The adventure prompt is an open "what happens next…?" style drawing twist that invites children to draw AND mark-make their own ideas (the adult scribes what each child says). Include exactly two stretch questions that deepen thinking.`;
  }

  return `You are an experienced UK early-years/KS1 teacher planning a short adult-led "shared story then draw" session for ${bandLabel}.
${anchor}
${bandGuidance}

Also invent a simple "secret code" mark or symbol idea the children can draw (e.g. a wiggly line = the wind, three dots = footprints) to spark mark-making.

${BANNED_TERMS_GUARD}

Return ONLY a single minified JSON object, no commentary, with EXACTLY these keys:
{
  "vocab": [ {"word": "...", "definition": "...", "action": "..."}, {...}, {...} ],
  "invitation": "2-3 warm sentences the adult reads/says to gather the children",
  "adventure_prompt": "the drawing adventure invitation",
  "secret_code": "a one-line secret mark/symbol idea for mark-making",
  "stretch_questions": ${baby ? '[]' : '["question one", "question two"]'}
}
All content must be original and age-appropriate for ${bandLabel}. British English. Exactly 3 vocab items.`;
}

// ── GET /tales — built-in public-domain tale list ─────────────────────────────
router.get('/tales', (req, res) => {
  res.json(BUILTIN_TALES);
});

// ── GET /rooms — this edition's rooms, so the same UI works for LADN + primary ─
router.get('/rooms', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT id, name FROM rooms ORDER BY id');
    res.json(rows.map(r => ({ id: r.id, name: r.name, age_band: bandFromRoomName(r.name) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /plan — generate an original SINGLE session pack via the model ────────
router.post('/plan', async (req, res) => {
  const { source_type = 'tale', source_title = '', theme = '', room_id } = req.body || {};
  const band = (req.body && req.body.age_band) || bandFromRoom(room_id);
  const title = source_title || theme;
  if (!title) return res.status(400).json({ error: 'A tale, book title or animation theme is required' });

  const prompt = buildPrompt({ source_type, source_title, theme, band });

  try {
    const { text, model } = await generateJSON(prompt, { numPredict: 900, maxTokens: 900 });
    const parsed = extractJson(text);
    if (!parsed || !Array.isArray(parsed.vocab)) throw new Error('Model returned unparseable content');

    // Normalise to exactly-3 vocab + string fields.
    const vocab = (parsed.vocab || []).slice(0, 3).map(v => ({
      word: String(v.word || '').trim(),
      definition: String(v.definition || '').trim(),
      action: String(v.action || '').trim(),
    }));
    while (vocab.length < 3) vocab.push({ word: '', definition: '', action: '' });

    const pack = {
      vocab,
      invitation: String(parsed.invitation || '').trim(),
      adventure_prompt: String(parsed.adventure_prompt || '').trim(),
      secret_code: String(parsed.secret_code || '').trim(),
      stretch_questions: band === 'baby'
        ? []
        : (Array.isArray(parsed.stretch_questions) ? parsed.stretch_questions : []).map(q => String(q).trim()).filter(Boolean).slice(0, 2),
      source_title: title,
      baby_variant: band === 'baby',
    };
    res.json({ ok: true, ai_available: true, model, band, pack });
  } catch (e) {
    // Graceful offline fallback — return a blank editable skeleton so the session
    // can still be built and printed by hand.
    const msg = e.name === 'AbortError'
      ? 'The model timed out. The cards are blank — fill them in and save.'
      : 'The model is offline right now. The cards are blank — fill them in by hand and save.';
    res.json({ ok: true, ai_available: false, model: OLLAMA_MODEL(), band, message: msg, pack: blankPack(title, band) });
  }
});

// ── GET / — list saved SINGLE sessions (week days excluded) ───────────────────
router.get('/', async (req, res) => {
  const { room_id, limit = 60 } = req.query;
  const db = getPool();
  const params = [];
  let sql = `SELECT ss.*, r.name AS room_name,
               s.first_name || ' ' || s.last_name AS created_by_name
             FROM story_sessions ss
             LEFT JOIN rooms r ON r.id = ss.room_id
             LEFT JOIN staff s ON s.id = ss.created_by
             WHERE ss.week_id IS NULL`;
  if (room_id) { params.push(room_id); sql += ` AND ss.room_id = $${params.length}`; }
  params.push(Math.min(parseInt(limit) || 60, 200));
  sql += ` ORDER BY ss.created_at DESC LIMIT $${params.length}`;
  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /vocab-history — treasure words already used (avoid repeats) ───────────
router.get('/vocab-history', async (req, res) => {
  const { room_id } = req.query;
  const db = getPool();
  const params = [];
  let sql = `SELECT lower(trim(v->>'word')) AS word,
                    max(ss.created_at) AS last_used,
                    count(*) AS times
             FROM story_sessions ss,
                  jsonb_array_elements(ss.vocab) v
             WHERE coalesce(trim(v->>'word'),'') <> ''`;
  if (room_id) { params.push(room_id); sql += ` AND ss.room_id = $${params.length}`; }
  sql += ` GROUP BY 1 ORDER BY last_used DESC`;
  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WEEK ARC (b140) ────────────────────────────────────────────────────────────

const DAY_FOCUS_SEQUENCE = ['character', 'setting', 'twist', 'twist', 'twist'];
const VOCAB_SPLIT = [2, 2, 2, 1, 1]; // 8 words across 5 days

function buildWeekPrompt({ source_type, source_title, theme, band }) {
  const bandLabel = BAND_LABEL[band] || BAND_LABEL.preschool;
  let anchor;
  if (source_type === 'book') {
    anchor = `The adult owns a picture book titled "${source_title}". Do NOT reproduce or quote that book's text — work only from its likely THEME, characters and mood.`;
  } else if (source_type === 'animation') {
    anchor = `The class will watch a short animation on the theme "${source_title || theme}". Work from the THEME only; invent everything original.`;
  } else {
    anchor = `The class will share the well-known public-domain tale "${source_title}". Use it only as a familiar springboard — invent original characters, words, prompts and twists; never reuse the tale's actual plot beats.`;
  }
  const richer = (band === 'ks1')
    ? 'ambitious Tier-2 and some Tier-3 vocabulary suited to Year 1-2 children who are beginning to read and write independently'
    : (band === 'reception')
      ? 'ambitious Tier-2 vocabulary suited to the final year of EYFS — a little richer than a typical pre-school session'
      : 'ambitious Tier-2 vocabulary the children may not yet know';

  return `You are an experienced UK early-years/KS1 teacher planning a WEEK-LONG story arc for ${bandLabel}. A story runs across 5 days, all adult-led "share, model, then draw and talk" sessions:
- Day 1: the children draw the CHARACTER.
- Day 2: the children draw the SETTING / world.
- Days 3-5: three ORIGINAL "what happens next?" twist days — invented adventures the source story never contains (for example: invent a way for the hero to travel somewhere safely; invent a machine that solves their problem; a villain returns in disguise — what disguise?). Invent three DIFFERENT twists in that spirit, each distinct from the source and from each other.

${anchor}

Every day shares the same 4-beat shape, which you must write for EACH day:
1. Ambitious vocabulary (drawn from one shared 8-word bank for the whole week — you invent the bank once, ${richer}, each word with a child-friendly one-sentence definition and a memorable physical action to "catch" the word).
2. Story sharing (mainly days 1-2 — a warm 2-3 sentence invitation the adult says to gather the children, which for days 3-5 recaps the story so far before revealing that day's twist).
3. The adult models drawing while thinking aloud — write a short first-person script (2-4 sentences) the adult can say while sketching, ending with the JOY RULE: the talk is the point, the drawing is the vehicle, so the adult should be inviting the children's own ideas rather than teaching a technique.
4. The children's turn — an open drawing/mark-making prompt inviting the children to draw AND talk about their own ideas while the adult scribes their words. No worksheets, no templates, never "copy my drawing".

Also invent a small bank of 4 original "Story Codes" — number/letter marks children can add to their drawings that DO something in the picture's world (for example a shield code that protects, a grow code, an open-sesame code, a transform code). For each: the code itself (a short symbol like "★3" or a letter+number), what it does in the story world, and a one-line note on how a child might use it.

${BANNED_TERMS_GUARD}

Return ONLY a single minified JSON object, no commentary, with EXACTLY this shape:
{
  "character_brief": "1-2 sentences: who/what the character is, for the day-1 drawing invitation",
  "setting_brief": "1-2 sentences: the world/setting, for the day-2 drawing invitation",
  "vocab_bank": [ {"word":"...","definition":"...","action":"..."} — exactly 8 of these, original and age-appropriate ],
  "codes_bank": [ {"code":"...","effect":"...","how_to_use":"..."} — exactly 4 of these ],
  "days": [
    {"day_no":1,"day_focus":"character","invitation":"...","adventure_prompt":"...","adult_model_text":"...","stretch_questions":${band === 'baby' ? '[]' : '["...","..."]'}},
    {"day_no":2,"day_focus":"setting","invitation":"...","adventure_prompt":"...","adult_model_text":"...","stretch_questions":${band === 'baby' ? '[]' : '["...","..."]'}},
    {"day_no":3,"day_focus":"twist","invitation":"...","adventure_prompt":"...(twist 1)...","adult_model_text":"...","stretch_questions":${band === 'baby' ? '[]' : '["...","..."]'}},
    {"day_no":4,"day_focus":"twist","invitation":"...","adventure_prompt":"...(twist 2, different from twist 1)...","adult_model_text":"...","stretch_questions":${band === 'baby' ? '[]' : '["...","..."]'}},
    {"day_no":5,"day_focus":"twist","invitation":"...","adventure_prompt":"...(twist 3, different from twists 1 and 2)...","adult_model_text":"...","stretch_questions":${band === 'baby' ? '[]' : '["...","..."]'}}
  ]
}
All content original and age-appropriate for ${bandLabel}. British English. Exactly 8 vocab_bank items, exactly 4 codes_bank items, exactly 5 days.`;
}

function blankWeekPack(title, band) {
  const day = (day_no, day_focus) => ({
    day_no, day_focus, invitation: '', adventure_prompt: '', adult_model_text: '',
    stretch_questions: band === 'baby' ? [] : ['', ''],
    vocab: [], secret_code: '',
  });
  return {
    source_title: title || '',
    character_brief: '',
    setting_brief: '',
    vocab_bank: Array.from({ length: 8 }, () => ({ word: '', definition: '', action: '' })),
    codes_bank: Array.from({ length: 4 }, () => ({ code: '', effect: '', how_to_use: '' })),
    days: DAY_FOCUS_SEQUENCE.map((f, i) => day(i + 1, f)),
  };
}

// Deterministic (server-side, not model) distribution of the week's vocab bank and
// Story Codes across the 5 days — keeps the model's JSON small/reliable and keeps
// the "purposeful" spread consistent regardless of what the model returns.
function distributeWeek(weekPack) {
  const bank = (weekPack.vocab_bank || []).slice(0, 8);
  while (bank.length < 8) bank.push({ word: '', definition: '', action: '' });
  const codes = (weekPack.codes_bank || []).slice(0, 4);
  while (codes.length < 4) codes.push({ code: '', effect: '', how_to_use: '' });

  let cursor = 0;
  const days = DAY_FOCUS_SEQUENCE.map((focus, i) => {
    const dayIn = (weekPack.days || []).find(d => Number(d.day_no) === i + 1) || {};
    const count = VOCAB_SPLIT[i];
    const vocab = bank.slice(cursor, cursor + count).map(v => ({
      word: String(v.word || '').trim(),
      definition: String(v.definition || '').trim(),
      action: String(v.action || '').trim(),
    }));
    cursor += count;
    const focusCode = codes[i % codes.length] || {};
    const secret_code = focusCode.code
      ? `${focusCode.code} — ${focusCode.effect}${focusCode.how_to_use ? ` (${focusCode.how_to_use})` : ''}`
      : '';
    return {
      day_no: i + 1,
      day_focus: focus,
      vocab,
      invitation: String(dayIn.invitation || '').trim(),
      adventure_prompt: String(dayIn.adventure_prompt || '').trim(),
      adult_model_text: String(dayIn.adult_model_text || '').trim(),
      secret_code,
      stretch_questions: (Array.isArray(dayIn.stretch_questions) ? dayIn.stretch_questions : [])
        .map(q => String(q).trim()).filter(Boolean).slice(0, 2),
    };
  });

  return {
    character_brief: String(weekPack.character_brief || '').trim(),
    setting_brief: String(weekPack.setting_brief || '').trim(),
    vocab_bank: bank,
    codes_bank: codes,
    days,
  };
}

// ── POST /plan-week — generate an original WEEK pack via the model ────────────
router.post('/plan-week', async (req, res) => {
  const { source_type = 'tale', source_title = '', theme = '', room_id } = req.body || {};
  const band = (req.body && req.body.age_band) || bandFromRoom(room_id);
  const title = source_title || theme;
  if (!title) return res.status(400).json({ error: 'A tale, book title or animation theme is required' });
  if (band === 'baby') return res.status(400).json({ error: 'Week Arc mode is for pre-school, Reception and KS1 children — the Baby Room uses single sensory sessions.' });

  const prompt = buildWeekPrompt({ source_type, source_title, theme, band });

  try {
    const { text, model } = await generateJSON(prompt, { numPredict: 2400, maxTokens: 2500, timeoutMs: 75000 });
    const parsed = extractJson(text);
    if (!parsed || !Array.isArray(parsed.days) || !Array.isArray(parsed.vocab_bank)) throw new Error('Model returned unparseable content');
    const distributed = distributeWeek(parsed);
    const weekPack = { source_title: title, band, ...distributed };
    res.json({ ok: true, ai_available: true, model, band, weekPack });
  } catch (e) {
    const msg = e.name === 'AbortError' || /aborted/i.test(e.message || '')
      ? 'The model timed out planning the week. The cards are blank — fill them in and save.'
      : 'The model is offline right now. The cards are blank — fill them in by hand and save.';
    res.json({ ok: true, ai_available: false, model: OLLAMA_MODEL(), band, message: msg, weekPack: blankWeekPack(title, band) });
  }
});

const WEEK_SELECT = `SELECT sw.*, r.name AS room_name, s.first_name || ' ' || s.last_name AS created_by_name
                      FROM story_weeks sw
                      LEFT JOIN rooms r ON r.id = sw.room_id
                      LEFT JOIN staff s ON s.id = sw.created_by
                      WHERE 1=1`;

// ── GET /weeks — list saved weeks ──────────────────────────────────────────────
router.get('/weeks', async (req, res) => {
  const { room_id } = req.query;
  const db = getPool();
  const params = [];
  let sql = WEEK_SELECT;
  if (room_id) { params.push(room_id); sql += ` AND sw.room_id = $${params.length}`; }
  sql += ` ORDER BY sw.created_at DESC LIMIT 100`;
  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /weeks/:id — one week + its 5 day rows ────────────────────────────────
router.get('/weeks/:id', async (req, res) => {
  const db = getPool();
  try {
    const wr = await db.query(WEEK_SELECT + ' AND sw.id=$1', [req.params.id]);
    if (!wr.rows.length) return res.status(404).json({ error: 'Not found' });
    const dr = await db.query('SELECT * FROM story_sessions WHERE week_id=$1 ORDER BY day_no ASC', [req.params.id]);
    res.json({ week: wr.rows[0], days: dr.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /weeks — save a full week (creates story_weeks + 5 story_sessions rows) ─
router.post('/weeks', async (req, res) => {
  const b = req.body || {};
  const source_title = (b.source_title || b.theme || '').trim();
  if (!source_title) return res.status(400).json({ error: 'source_title required' });
  const days = Array.isArray(b.days) ? b.days : [];
  if (days.length !== 5) return res.status(400).json({ error: 'A week must have exactly 5 days' });

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const wr = await client.query(`
      INSERT INTO story_weeks
        (room_id, age_band, source_type, source_title, theme, character_brief, setting_brief,
         vocab_bank, codes_bank, status, model, notes, created_by, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,NOW(),NOW())
      RETURNING *`,
      [ b.room_id || null, b.age_band || bandFromRoom(b.room_id), b.source_type || 'tale',
        source_title, b.theme || null, b.character_brief || null, b.setting_brief || null,
        JSON.stringify(b.vocab_bank || []), JSON.stringify(b.codes_bank || []),
        b.status || 'saved', b.model || null, b.notes || null, req.user.id ]);
    const week = wr.rows[0];

    const dayRows = [];
    for (const d of days) {
      const dr = await client.query(`
        INSERT INTO story_sessions
          (room_id, age_band, source_type, source_title, theme, vocab, invitation,
           adventure_prompt, secret_code, stretch_questions, status, model, session_date,
           notes, created_by, week_id, day_no, day_focus, adult_model_text, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW())
        RETURNING *`,
        [ b.room_id || null, b.age_band || bandFromRoom(b.room_id), b.source_type || 'tale',
          source_title, b.theme || null, JSON.stringify(Array.isArray(d.vocab) ? d.vocab : []),
          d.invitation || null, d.adventure_prompt || null, d.secret_code || null,
          JSON.stringify(Array.isArray(d.stretch_questions) ? d.stretch_questions : []),
          'saved', b.model || null, d.session_date || null, d.notes || null, req.user.id,
          week.id, d.day_no, d.day_focus || null, d.adult_model_text || null ]);
      dayRows.push(dr.rows[0]);
    }

    await client.query('COMMIT');
    dayRows.sort((a, c) => a.day_no - c.day_no);
    res.status(201).json({ week, days: dayRows });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PATCH /weeks/:id — update week-level fields ───────────────────────────────
router.patch('/weeks/:id', async (req, res) => {
  const b = req.body || {};
  const vocabBank = b.vocab_bank !== undefined ? JSON.stringify(Array.isArray(b.vocab_bank) ? b.vocab_bank : []) : null;
  const codesBank = b.codes_bank !== undefined ? JSON.stringify(Array.isArray(b.codes_bank) ? b.codes_bank : []) : null;
  try {
    const { rows } = await getPool().query(`
      UPDATE story_weeks SET
        source_title    = COALESCE($1, source_title),
        theme           = COALESCE($2, theme),
        character_brief = COALESCE($3, character_brief),
        setting_brief   = COALESCE($4, setting_brief),
        vocab_bank      = COALESCE($5::jsonb, vocab_bank),
        codes_bank      = COALESCE($6::jsonb, codes_bank),
        status          = COALESCE($7, status),
        notes           = COALESCE($8, notes),
        updated_at      = NOW()
      WHERE id=$9 RETURNING *`,
      [ b.source_title || null, b.theme || null, b.character_brief ?? null, b.setting_brief ?? null,
        vocabBank, codesBank, b.status || null, b.notes ?? null, req.params.id ]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /weeks/:id/days/:day_no — update one day's pack ─────────────────────
router.patch('/weeks/:id/days/:day_no', async (req, res) => {
  const b = req.body || {};
  const vocab = b.vocab !== undefined ? JSON.stringify(Array.isArray(b.vocab) ? b.vocab : []) : null;
  const stretch = b.stretch_questions !== undefined ? JSON.stringify(Array.isArray(b.stretch_questions) ? b.stretch_questions : []) : null;
  try {
    const { rows } = await getPool().query(`
      UPDATE story_sessions SET
        vocab             = COALESCE($1::jsonb, vocab),
        invitation        = COALESCE($2, invitation),
        adventure_prompt  = COALESCE($3, adventure_prompt),
        adult_model_text  = COALESCE($4, adult_model_text),
        secret_code       = COALESCE($5, secret_code),
        stretch_questions = COALESCE($6::jsonb, stretch_questions),
        notes             = COALESCE($7, notes),
        updated_at        = NOW()
      WHERE week_id=$8 AND day_no=$9 RETURNING *`,
      [ vocab, b.invitation ?? null, b.adventure_prompt ?? null, b.adult_model_text ?? null,
        b.secret_code ?? null, stretch, b.notes ?? null, req.params.id, req.params.day_no ]);
    if (!rows.length) return res.status(404).json({ error: 'Day not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /weeks/:id — delete a week + its day rows ──────────────────────────
router.delete('/weeks/:id', async (req, res) => {
  const db = getPool();
  try {
    await db.query('DELETE FROM story_sessions WHERE week_id=$1', [req.params.id]);
    const { rowCount } = await db.query('DELETE FROM story_weeks WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /weeks/:id/add-to-plan — drop the week's 5 days into planned-activities ─
router.post('/weeks/:id/add-to-plan', async (req, res) => {
  const { plan_start_date, slot = 'morning' } = req.body || {};
  if (!plan_start_date) return res.status(400).json({ error: 'plan_start_date required (the Monday of the target week)' });
  const db = getPool();
  try {
    const wr = await db.query('SELECT * FROM story_weeks WHERE id=$1', [req.params.id]);
    if (!wr.rows.length) return res.status(404).json({ error: 'Week not found' });
    const week = wr.rows[0];
    const dr = await db.query('SELECT * FROM story_sessions WHERE week_id=$1 ORDER BY day_no ASC', [req.params.id]);

    const start = new Date(plan_start_date + 'T00:00:00Z');
    const created = [];
    for (const day of dr.rows) {
      const planDate = new Date(start);
      planDate.setUTCDate(start.getUTCDate() + (day.day_no - 1));
      const vocabLine = (day.vocab || []).map(v => v.word).filter(Boolean).join(', ');
      const desc = [
        day.invitation,
        day.adventure_prompt,
        vocabLine ? `Treasure words: ${vocabLine}.` : '',
        day.secret_code ? `Story code: ${day.secret_code}` : '',
      ].filter(Boolean).join('\n\n');
      const label = day.day_focus === 'character' ? 'Draw the character'
        : day.day_focus === 'setting' ? 'Draw the setting'
        : `Twist day ${day.day_no - 2}`;
      const { rows } = await db.query(`
        INSERT INTO planned_activities
          (scope, room_id, plan_date, slot, led_by, title, description, status, created_at)
        VALUES ('group',$1,$2,$3,$4,$5,$6,'planned',NOW())
        RETURNING id`,
        [ week.room_id, planDate.toISOString().slice(0, 10), slot, req.user.id,
          `Story Studio Week: ${week.source_title} — Day ${day.day_no} (${label})`, desc ]);
      created.push(rows[0].id);
    }
    res.status(201).json({ ok: true, planned_activity_ids: created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /:id — one saved session (single or a week's day row) ─────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT ss.*, r.name AS room_name FROM story_sessions ss
       LEFT JOIN rooms r ON r.id = ss.room_id WHERE ss.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST / — save a single session ────────────────────────────────────────────
router.post('/', async (req, res) => {
  const b = req.body || {};
  const source_title = (b.source_title || b.theme || '').trim();
  if (!source_title) return res.status(400).json({ error: 'source_title required' });
  const vocab = Array.isArray(b.vocab) ? b.vocab : [];
  const stretch = Array.isArray(b.stretch_questions) ? b.stretch_questions : [];
  try {
    const { rows } = await getPool().query(`
      INSERT INTO story_sessions
        (room_id, age_band, source_type, source_title, theme, vocab, invitation,
         adventure_prompt, secret_code, stretch_questions, status, model, session_date,
         notes, created_by, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,NOW(),NOW())
      RETURNING *`,
      [ b.room_id || null, b.age_band || bandFromRoom(b.room_id),
        b.source_type || 'tale', source_title, b.theme || null,
        JSON.stringify(vocab), b.invitation || null, b.adventure_prompt || null,
        b.secret_code || null, JSON.stringify(stretch), b.status || 'saved',
        b.model || null, b.session_date || null, b.notes || null, req.user.id ]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /:id — update a saved session ───────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const b = req.body || {};
  const vocab = b.vocab !== undefined ? JSON.stringify(Array.isArray(b.vocab) ? b.vocab : []) : null;
  const stretch = b.stretch_questions !== undefined ? JSON.stringify(Array.isArray(b.stretch_questions) ? b.stretch_questions : []) : null;
  try {
    const { rows } = await getPool().query(`
      UPDATE story_sessions SET
        room_id          = COALESCE($1, room_id),
        age_band         = COALESCE($2, age_band),
        source_title     = COALESCE($3, source_title),
        theme            = COALESCE($4, theme),
        vocab            = COALESCE($5::jsonb, vocab),
        invitation       = COALESCE($6, invitation),
        adventure_prompt = COALESCE($7, adventure_prompt),
        secret_code      = COALESCE($8, secret_code),
        stretch_questions= COALESCE($9::jsonb, stretch_questions),
        status           = COALESCE($10, status),
        session_date     = COALESCE($11, session_date),
        notes            = COALESCE($12, notes),
        updated_at       = NOW()
      WHERE id=$13 RETURNING *`,
      [ b.room_id || null, b.age_band || null, b.source_title || null, b.theme || null,
        vocab, b.invitation ?? null, b.adventure_prompt ?? null, b.secret_code ?? null,
        stretch, b.status || null, b.session_date || null, b.notes ?? null, req.params.id ]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/capture — capture a child's drawing as an observation ───────────
// Photos are uploaded first via the existing POST /api/observations/upload, then
// their URLs are passed here. We create the observation ourselves (pre-tagged
// C&L / Literacy / EA&D, with the session's treasure words in the note) and link
// it back to the session — reusing the observation record + photo pipeline without
// modifying observations.js. Works for a single session OR one day of a week.
// login-20261023: same gate as POST /api/observations — this also creates observations, and apprentices (Toby: no observations until they are signed off as ready) got through it.
router.post('/:id/capture', requireCapabilityLevel('observations.create', 'edit'), async (req, res) => {
  const { child_id, photo_urls, note, shared_with_parents } = req.body || {};
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  const db = getPool();
  try {
    const sr = await db.query('SELECT * FROM story_sessions WHERE id=$1', [req.params.id]);
    if (!sr.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sr.rows[0];

    const words = (Array.isArray(session.vocab) ? session.vocab : [])
      .map(v => v && v.word).filter(Boolean);
    const vocabLine = words.length ? `Treasure words: ${words.join(', ')}.` : '';
    const text = [
      note && String(note).trim(),
      `Story Studio drawing — "${session.source_title}".`,
      vocabLine,
    ].filter(Boolean).join('\n');

    // observation_type is constrained to a fixed set; use 'learning_story' (the semantic
    // fit) and mark Story Studio provenance via the obs_tags array + story_session_id link.
    const { rows } = await db.query(`
      INSERT INTO observations
        (child_id, staff_id, title, observation_text, observation_type,
         eyfs_areas, photo_urls, shared_with_parents, story_session_id,
         obs_tags, created_at, updated_at)
      VALUES ($1,$2,$3,$4,'learning_story',
         $5,$6,$7,$8,$9,NOW(),NOW())
      RETURNING id`,
      [ child_id, req.user.id, `Story Studio: ${session.source_title}`, text,
        ['Communication and Language', 'Literacy', 'Expressive Arts and Design'],
        Array.isArray(photo_urls) ? photo_urls : [],
        shared_with_parents || false, session.id,
        ['story_studio'] ]);

    const obsId = rows[0].id;
    await db.query(
      `UPDATE story_sessions
         SET captured_observation_ids = array_append(captured_observation_ids, $1),
             updated_at = NOW()
       WHERE id=$2`, [obsId, session.id]);

    res.status(201).json({ ok: true, observation_id: obsId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /:id — delete a saved session ──────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await getPool().query('DELETE FROM story_sessions WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
