'use strict';
// b163 — Staff self-reflection hub (EY portal, staff-private).
// Everything is scoped to the logged-in staff member (req.user.id). A per-entry
// `shared` flag exposes a reflection's NARRATIVE (title + body) to the team; the
// structured `data` blob and any linked-observation child details are NEVER shown
// to anyone but the owner (GDPR posture). Managers get no special read access to
// other staff's private reflections — this is a private space by design.
const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
// b167 — performance & coaching grounding. eyfs_brain corpus (licence-clean EYFS
// practice) + wren_brain_v1 (nursery docs). Both are queried and fed ONLY to the
// local sovereign model on Ascent — never a cloud model (GDPR posture).
const eyfsBrainRag = require('../lib/eyfs-brain-rag');
// b170 — termly knowledge checks + safeguarding-CPD nudges reuse the shared
// notification dispatcher (same pattern as cpd.js).
const { notify } = require('../services/notification-dispatcher');

// b333: host + model from the one resolver (src/lib/ai-models.js). Interactive
// coaching is the 'default' role, resolved per call — move it with the
// settings.ai_model_overrides row, not an env var.
const ai = require('../lib/ai-models');
const OLLAMA_HOST  = ai.host();
const REFLECT_MODEL = () => ai.model('default');
const SEARXNG_URL   = process.env.SEARXNG_URL || 'http://your-server:8082';

router.use(authenticate);

// Reflection kinds accepted from the client (structured guided documents + open).
const KINDS = new Set(['open','observation','joint_observation','key_children_gap','teamwork','ask_wren']);

// Canonical EYFS areas + a tolerant normaliser (obs data has mixed casing:
// "Expressive arts and design" vs "Expressive Arts and Design" etc.)
const EYFS_AREAS = [
  { key:'psed',  name:'Personal, Social & Emotional Development', prime:true  },
  { key:'cl',    name:'Communication & Language',                 prime:true  },
  { key:'pd',    name:'Physical Development',                     prime:true  },
  { key:'lit',   name:'Literacy',                                 prime:false },
  { key:'maths', name:'Mathematics',                              prime:false },
  { key:'utw',   name:'Understanding the World',                  prime:false },
  { key:'ead',   name:'Expressive Arts & Design',                 prime:false },
];
const AREA_BY_KEY = Object.fromEntries(EYFS_AREAS.map(a => [a.key, a]));
function normArea(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('personal') || s.includes('psed') || s.includes('emotional')) return 'psed';
  if (s.includes('communication') || s.includes('language')) return 'cl';
  if (s.includes('physical')) return 'pd';
  if (s.includes('litera')) return 'lit';
  if (s.includes('math')) return 'maths';
  if (s.includes('understanding') || s.includes('world')) return 'utw';
  if (s.includes('expressive') || s.includes('arts')) return 'ead';
  return null;
}

// Only expose child-identifying endpoints on the EY (learning) portal — never HR.
function learningOnly(req, res, next) {
  if (req._portal && req._portal !== 'learning') {
    return res.status(403).json({ error: 'Available on the EY portal only' });
  }
  next();
}

// ── Local model (Ascent Ollama) — reflective-practice coach. Sovereign; no cloud. ──
// b333: `model` lets a caller that records the model name pass the one it resolved.
async function ollamaChat(system, messages, { timeout = 45000, num_predict = 700, temperature = 0.5, model = REFLECT_MODEL() } = {}) {
  const msgs = [{ role: 'system', content: system }, ...messages];
  const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages: msgs, stream: false, think: false,
      options: ai.options({ temperature, num_predict }),
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) throw new Error(`ollama ${resp.status}`);
  const data = await resp.json();
  let out = (data.message?.content || '').trim();
  out = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();   // strip qwen3 CoT
  return out;
}

const COACH_SYSTEM = [
  'You are Wren, a warm, experienced reflective-practice coach for early years practitioners',
  'in an English day nursery. You help staff think about their own practice using the EYFS',
  // fledge-off (2026-10-26): was 'the setting\'s own "Fledge" curriculum framework'. Fledge is
  // not launched (src/lib/fledge-switch.js), so the coach names no framework of its own.
  'and the setting\'s own curriculum framework, the Characteristics of Effective',
  'Learning, and the key-person approach.',
  'Coach, do not lecture: ask open, curious questions ("What made you notice that?", "What',
  'might you try differently next time?"), reflect their words back, and suggest small,',
  'achievable next steps. Be encouraging and non-judgemental.',
  'Keep replies short (2-4 short paragraphs max). Never invent statutory facts, policy,',
  'ratios or law you are unsure of — if unsure, say so and suggest checking the setting\'s',
  'policies or manager. Never ask for or use children\'s full names.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────────────
// Reflections CRUD (owner-scoped)
// ─────────────────────────────────────────────────────────────────────────────

// GET /mine?kind= — my reflections (private + my own shared). Owner view: may
// include the linked observation's title for context.
router.get('/mine', async (req, res) => {
  try {
    const params = [req.user.id];
    let sql = `
      SELECT r.id, r.kind, r.title, r.body, r.data, r.linked_observation_id,
             r.shared, r.created_at, r.updated_at, o.title AS linked_observation_title
      FROM staff_reflections r
      LEFT JOIN observations o ON o.id = r.linked_observation_id
      WHERE r.staff_id = $1`;
    if (req.query.kind) { params.push(req.query.kind); sql += ` AND r.kind = $${params.length}`; }
    sql += ` ORDER BY r.created_at DESC LIMIT 300`;
    const { rows } = await getPool().query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /shared — team view: every practitioner's SHARED reflections. Narrative only
// (title + body + author) — never the structured `data` or linked-obs child details.
router.get('/shared', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT r.id, r.staff_id, r.kind, r.title, r.body, r.created_at,
             COALESCE(s.first_name || ' ' || s.last_name, 'A colleague') AS author_name,
             (r.staff_id = $1) AS mine
      FROM staff_reflections r
      LEFT JOIN staff s ON s.id = r.staff_id
      WHERE r.shared = true
      ORDER BY r.created_at DESC LIMIT 200`, [req.user.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — create a reflection
router.post('/', async (req, res) => {
  let { kind = 'open', title, body, data, linked_observation_id, shared = false } = req.body || {};
  if (!KINDS.has(kind)) kind = 'open';
  if ((!title || !String(title).trim()) && (!body || !String(body).trim()) && !data) {
    return res.status(400).json({ error: 'A title, some text or form data is required' });
  }
  const linkedId = linked_observation_id != null && /^\d+$/.test(String(linked_observation_id))
    ? parseInt(linked_observation_id, 10) : null;
  try {
    const { rows } = await getPool().query(`
      INSERT INTO staff_reflections (staff_id, kind, title, body, data, linked_observation_id, shared)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, kind, title || null, body || null,
       data ? JSON.stringify(data) : null, linkedId, !!shared]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id — update own reflection
router.patch('/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  const sets = [], params = [];
  for (const f of ['title', 'body']) {
    if (f in (req.body || {})) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
  }
  if ('data' in (req.body || {})) { params.push(req.body.data ? JSON.stringify(req.body.data) : null); sets.push(`data = $${params.length}`); }
  if ('shared' in (req.body || {})) { params.push(!!req.body.shared); sets.push(`shared = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push('updated_at = now()');
  params.push(req.params.id, req.user.id);
  try {
    const { rows } = await getPool().query(
      `UPDATE staff_reflections SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND staff_id = $${params.length} RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ error: 'Not found or not yours' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id — delete own reflection
router.delete('/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rowCount } = await getPool().query(
      `DELETE FROM staff_reflections WHERE id = $1 AND staff_id = $2`, [req.params.id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found or not yours' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// My practice: recent observations + key-children gap analysis (child data → EY only)
// ─────────────────────────────────────────────────────────────────────────────

// GET /my-observations?limit= — observations I authored (staff_id = me)
router.get('/my-observations', learningOnly, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 60);
  try {
    const { rows } = await getPool().query(`
      SELECT o.id, o.title, o.observation_type, o.eyfs_areas, o.created_at,
             c.first_name AS child_first_name
      FROM observations o
      LEFT JOIN children c ON c.id = o.child_id
      WHERE o.staff_id = $1
      ORDER BY o.created_at DESC LIMIT $2`, [req.user.id, limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /key-children-gaps?weeks= — auto "gap analysis of my key children".
// Per-area coverage across my key children over the window, plus per-child totals
// and a deterministic narrative summary (generated, not hand-typed).
router.get('/key-children-gaps', learningOnly, async (req, res) => {
  const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 12, 1), 52);
  const db = getPool();
  try {
    const kids = (await db.query(`
      SELECT id, first_name, last_name FROM children
      WHERE key_person_id = $1 AND is_active = true
      ORDER BY first_name`, [req.user.id])).rows;
    if (!kids.length) {
      return res.json({ weeks, children: [], area_totals: [], gaps: [], summary:
        'You have no key children assigned yet, so there is no coverage to analyse. If this looks wrong, check with your manager.' });
    }
    const kidIds = kids.map(k => k.id);
    const since = new Date(); since.setDate(since.getDate() - weeks * 7);
    const obs = (await db.query(`
      SELECT child_id, eyfs_areas, created_at FROM observations
      WHERE child_id = ANY($1::int[]) AND created_at >= $2`, [kidIds, since.toISOString()])).rows;

    // Per-child + per-area tallies
    const perChild = Object.fromEntries(kids.map(k => [k.id,
      { child_id: k.id, name: k.first_name, obs_count: 0, areas: {} }]));
    const areaTotals = Object.fromEntries(EYFS_AREAS.map(a => [a.key, 0]));
    for (const o of obs) {
      const pc = perChild[o.child_id]; if (!pc) continue;
      pc.obs_count++;
      const seen = new Set();
      for (const raw of (o.eyfs_areas || [])) {
        const k = normArea(raw); if (!k || seen.has(k)) continue; seen.add(k);
        pc.areas[k] = (pc.areas[k] || 0) + 1;
        areaTotals[k]++;
      }
    }
    const area_totals = EYFS_AREAS.map(a => ({ key: a.key, name: a.name, prime: a.prime, count: areaTotals[a.key] }));
    // A "gap" = an area with no observations across ALL my key children in the window.
    const gaps = area_totals.filter(a => a.count === 0).map(a => a.name);
    // Per-child gaps (prime areas with zero evidence — the ones that matter most)
    const children = kids.map(k => {
      const pc = perChild[k.id];
      const missingPrime = EYFS_AREAS.filter(a => a.prime && !(pc.areas[a.key] > 0)).map(a => a.name);
      return { child_id: k.id, name: k.first_name, obs_count: pc.obs_count,
               areas: EYFS_AREAS.map(a => ({ key: a.key, count: pc.areas[a.key] || 0 })),
               missing_prime: missingPrime };
    });

    // Deterministic narrative
    const totalObs = obs.length;
    const quietKids = children.filter(c => c.obs_count === 0).map(c => c.name);
    const thinKids  = children.filter(c => c.obs_count > 0 && c.obs_count < 3).map(c => c.name);
    const strongest = [...area_totals].sort((a,b)=>b.count-a.count)[0];
    let summary = `Across your ${kids.length} key ${kids.length===1?'child':'children'} you recorded ${totalObs} observation${totalObs===1?'':'s'} in the last ${weeks} weeks. `;
    summary += strongest && strongest.count ? `Your strongest area is ${strongest.name}. ` : '';
    if (gaps.length) summary += `No observations touched ${gaps.join(', ')} this period — worth planning something. `;
    else summary += `All seven areas of learning have at least some evidence. `;
    if (quietKids.length) summary += `${quietKids.join(', ')} ${quietKids.length===1?'has':'have'} no observations yet — a good focus for the coming weeks. `;
    else if (thinKids.length) summary += `${thinKids.join(', ')} could do with a little more evidence. `;
    summary += 'Use the reflection box below to note what you will do next.';

    res.json({ weeks, generated_at: new Date().toISOString(), children, area_totals, gaps, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ask Wren (reflective coach) + suggest-a-reflection
// ─────────────────────────────────────────────────────────────────────────────

// POST /ask { messages:[{role,content}] } — reflective coaching chat
router.post('/ask', async (req, res) => {
  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!incoming || !incoming.length) return res.status(400).json({ error: 'messages required' });
  const messages = incoming
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'last message must be from the user' });
  }
  try {
    const model = REFLECT_MODEL();
    const reply = await ollamaChat(COACH_SYSTEM, messages, { timeout: 55000, num_predict: 700, model });
    if (!reply) throw new Error('empty reply');
    res.json({ reply, model });
  } catch (e) {
    res.status(503).json({ error: 'coach_unavailable',
      message: 'Wren is having a quiet moment and could not answer just now. Please try again shortly.' });
  }
});

const FALLBACK_PROMPTS = [
  'Think of a moment this week a child surprised you. What did it tell you about how they learn?',
  'Which area of learning have you found hardest to evidence lately, and what one thing could you try?',
  'How well do you feel you and your room team shared information this week? What worked?',
];

// POST /suggest — 2-3 tailored reflection prompts from my recent obs TITLES + areas
// (no child_name field is sent to the model — GDPR posture; local sovereign model only).
router.post('/suggest', learningOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT title, eyfs_areas FROM observations
      WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 15`, [req.user.id]);
    const lines = rows
      .map(r => {
        const areas = [...new Set((r.eyfs_areas || []).map(normArea).filter(Boolean).map(k => AREA_BY_KEY[k].name))];
        const t = (r.title || '').trim();
        return t ? `- ${t}${areas.length ? ' [' + areas.join(', ') + ']' : ''}` : null;
      })
      .filter(Boolean).slice(0, 12);
    if (!lines.length) return res.json({ prompts: FALLBACK_PROMPTS, source: 'fallback' });

    const system = 'You are a reflective-practice coach for early years practitioners. From a list ' +
      'of a practitioner\'s recent observation titles and the areas of learning they touched, write ' +
      'exactly 3 short, open self-reflection prompts (one sentence each) that would help them think ' +
      'about their own practice and spot gaps. Do not mention any child by name. Return only the 3 ' +
      'prompts, each on its own line, no numbering, no preamble.';
    const user = 'Recent observations:\n' + lines.join('\n');
    let out;
    try { out = await ollamaChat(system, [{ role: 'user', content: user }], { timeout: 40000, num_predict: 300, temperature: 0.6 }); }
    catch { return res.json({ prompts: FALLBACK_PROMPTS, source: 'fallback' }); }
    const prompts = out.split('\n').map(l => l.replace(/^[\s\-\*\d\.\)]+/, '').trim())
      .filter(l => l.length > 8).slice(0, 3);
    res.json({ prompts: prompts.length ? prompts : FALLBACK_PROMPTS, source: prompts.length ? 'ai' : 'fallback' });
  } catch (e) { res.json({ prompts: FALLBACK_PROMPTS, source: 'fallback' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Daily micro-CPD / safeguarding quiz
// ─────────────────────────────────────────────────────────────────────────────

function dayNumber() { return Math.floor(Date.now() / 86400000); }

// GET /quiz/today — one question per day (stable through the day), preferring
// questions this staff member hasn't attempted yet. Never returns correct/explain.
router.get('/quiz/today', async (req, res) => {
  const db = getPool();
  try {
    const bank = (await db.query(
      `SELECT quiz_key, topic, question, options FROM reflection_quiz_bank WHERE active = true ORDER BY quiz_key`)).rows;
    if (!bank.length) return res.json({ quiz: null });
    const attempted = new Set((await db.query(
      `SELECT DISTINCT quiz_key FROM reflection_quiz_attempts WHERE staff_id = $1`, [req.user.id])).rows.map(r => r.quiz_key));
    const doneToday = (await db.query(
      `SELECT quiz_key FROM reflection_quiz_attempts
       WHERE staff_id = $1 AND taken_at::date = CURRENT_DATE ORDER BY taken_at DESC LIMIT 1`, [req.user.id])).rows[0];

    const pool = bank.filter(q => !attempted.has(q.quiz_key));
    const chooseFrom = pool.length ? pool : bank;
    // Deterministic per-day pick, varied per staff so a room doesn't all get the same card.
    const idx = (dayNumber() + Number(req.user.id || 0)) % chooseFrom.length;
    const q = chooseFrom[idx];
    res.json({
      quiz: { quiz_key: q.quiz_key, topic: q.topic, question: q.question, options: q.options },
      done_today: !!doneToday,
      remaining_new: pool.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /quiz/:quiz_key/attempt { choice } — grade + record + reveal answer
router.post('/quiz/:quiz_key/attempt', async (req, res) => {
  const choice = parseInt(req.body?.choice, 10);
  const db = getPool();
  try {
    const q = (await db.query(
      `SELECT quiz_key, topic, options, correct, explain FROM reflection_quiz_bank WHERE quiz_key = $1 AND active = true`,
      [req.params.quiz_key])).rows[0];
    if (!q) return res.status(404).json({ error: 'Unknown question' });
    const nOpts = Array.isArray(q.options) ? q.options.length : 0;
    if (!Number.isInteger(choice) || choice < 0 || choice >= nOpts) {
      return res.status(400).json({ error: 'Invalid choice' });
    }
    const correct = choice === q.correct;
    await db.query(
      `INSERT INTO reflection_quiz_attempts (staff_id, quiz_key, score, total, answers)
       VALUES ($1,$2,$3,1,$4)`,
      [req.user.id, q.quiz_key, correct ? 1 : 0, JSON.stringify({ choice, correct })]);
    res.json({ correct, correct_index: q.correct, explain: q.explain, topic: q.topic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /quiz/history — my attempts + simple stats
router.get('/quiz/history', async (req, res) => {
  try {
    const rows = (await getPool().query(`
      SELECT a.quiz_key, a.score, a.total, a.taken_at, b.topic, b.question
      FROM reflection_quiz_attempts a
      LEFT JOIN reflection_quiz_bank b ON b.quiz_key = a.quiz_key
      WHERE a.staff_id = $1 ORDER BY a.taken_at DESC LIMIT 60`, [req.user.id])).rows;
    const total = rows.length;
    const correct = rows.reduce((n, r) => n + (r.score || 0), 0);
    res.json({ attempts: rows, total, correct, pct: total ? Math.round(correct / total * 100) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Weekly cadence nudge (~10 observations + 2 reflections per week)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/cadence', async (req, res) => {
  const db = getPool();
  try {
    const obs = (await db.query(
      `SELECT count(*)::int AS n FROM observations
       WHERE staff_id = $1 AND created_at >= date_trunc('week', now())`, [req.user.id])).rows[0].n;
    const refl = (await db.query(
      `SELECT count(*)::int AS n FROM staff_reflections
       WHERE staff_id = $1 AND created_at >= date_trunc('week', now())`, [req.user.id])).rows[0].n;
    res.json({
      week_start: new Date(Date.now() - ((new Date().getDay() + 6) % 7) * 86400000).toISOString().slice(0, 10),
      obs_count: obs, obs_target: 10,
      reflections_count: refl, reflections_target: 2,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Sector watch ("this week in early years") — SearXNG + local model, cached daily.
// Optional/best-effort: if anything is flaky it returns { available:false }.
// ─────────────────────────────────────────────────────────────────────────────
async function searxng(query, timeout = 7000) {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=general&time_range=month`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error(`searxng ${resp.status}`);
  const j = await resp.json();
  return (j.results || []).slice(0, 8).map(r => ({ title: r.title, url: r.url, snippet: (r.content || '').slice(0, 300) }));
}

router.get('/sector-watch', async (req, res) => {
  const db = getPool();
  try {
    const cached = (await db.query(
      `SELECT summary, items, generated_at FROM reflection_sector_watch WHERE fetched_on = CURRENT_DATE`)).rows[0];
    if (cached) return res.json({ available: true, cached: true, ...cached });

    // Build fresh (best-effort)
    let results = [];
    try {
      const queries = [
        'early years EYFS practice update news UK',
        'nursery early years foundation stage safeguarding guidance update',
      ];
      for (const q of queries) {
        try { results = results.concat(await searxng(q)); } catch { /* skip */ }
      }
    } catch { /* skip */ }
    // De-dup by url
    const seen = new Set();
    results = results.filter(r => r.url && !seen.has(r.url) && seen.add(r.url)).slice(0, 8);
    if (!results.length) return res.json({ available: false, reason: 'no_results' });

    let summary = '';
    try {
      const system = 'You are briefing an early years practitioner. From these recent public search results, ' +
        'write a short, friendly "This week in early years" digest (3-5 bullet points) of themes, updates or ' +
        'ideas relevant to nursery practice in England. Be factual and cautious; if something is uncertain, ' +
        'say so. Do not invent statutory changes. Return only the bullet points.';
      const user = results.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join('\n');
      summary = await ollamaChat(system, [{ role: 'user', content: user }], { timeout: 50000, num_predict: 500, temperature: 0.4 });
    } catch { /* summary optional */ }

    // Cache (one row per day; ignore races)
    try {
      await db.query(
        `INSERT INTO reflection_sector_watch (fetched_on, summary, items)
         VALUES (CURRENT_DATE, $1, $2) ON CONFLICT (fetched_on) DO NOTHING`,
        [summary || null, JSON.stringify(results)]);
    } catch { /* non-fatal */ }
    res.json({ available: true, cached: false, summary: summary || null, items: results, generated_at: new Date().toISOString() });
  } catch (e) {
    res.json({ available: false, reason: 'error' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// b167 — Practitioner performance & coaching (extends the b163 hub).
// Each practitioner sees their OWN data. Managers + deputy managers may view any
// staff member's view via ?staff_id= (respecting the existing learning-portal
// gate; nothing here is exposed on HR/parents). Obs text only ever reaches the
// LOCAL sovereign model on Ascent, never a cloud model, and is never logged.
// ═════════════════════════════════════════════════════════════════════════════

const HALF_TERM_DAYS = 49;            // ~7 weeks — "the last half-term"
const MANAGER_ROLES = new Set(['manager', 'deputy_manager', 'admin']);

// Resolve whose performance is being requested. Default = the caller. A
// ?staff_id= that differs from the caller is only honoured for managers/deputies.
function resolveTarget(req) {
  const me = Number(req.user.id);
  const q = req.query.staff_id;
  if (q == null || q === '' || Number(q) === me) return { ok: true, id: me, self: true };
  if (!MANAGER_ROLES.has(String(req.user.role || '').toLowerCase())) {
    return { ok: false, code: 403, error: 'Only managers can view another practitioner’s performance' };
  }
  const sid = parseInt(q, 10);
  if (!Number.isInteger(sid) || sid < 1) return { ok: false, code: 400, error: 'Invalid staff_id' };
  return { ok: true, id: sid, self: false };
}

// ── Internal: headline observation stats for a staff member over a window ──────
async function computeObsStats(db, staffId, sinceIso) {
  const { rows } = await db.query(`
    SELECT
      count(*)::int AS total,
      COALESCE(round(avg(NULLIF(wc,0)))::int, 0) AS avg_words,
      count(*) FILTER (WHERE wc > 0 AND wc < 25)::int AS under25,
      count(*) FILTER (WHERE has_photo)::int AS with_photo,
      count(*) FILTER (WHERE has_fw)::int    AS with_fw,
      count(*) FILTER (WHERE has_ns)::int    AS with_ns
    FROM (
      SELECT
        CASE WHEN COALESCE(btrim(observation_text),'') = '' THEN 0
             ELSE cardinality(regexp_split_to_array(btrim(observation_text), E'\\s+')) END AS wc,
        (array_length(photo_urls,1) > 0)          AS has_photo,
        (array_length(linked_framework_ids,1) > 0) AS has_fw,
        (COALESCE(btrim(next_steps),'') <> '')     AS has_ns
      FROM observations
      WHERE staff_id = $1 AND created_at >= $2
    ) x`, [staffId, sinceIso]);
  const r = rows[0] || { total: 0, avg_words: 0, under25: 0, with_photo: 0, with_fw: 0, with_ns: 0 };
  const pct = (n) => (r.total ? Math.round((n / r.total) * 100) : 0);
  return {
    total: r.total, avg_words: r.avg_words,
    pct_under_25: pct(r.under25),
    photo_pct: pct(r.with_photo),
    framework_pct: pct(r.with_fw),
    nextstep_pct: pct(r.with_ns),
  };
}

// ── Internal: per-key-child coverage matrix + longest gaps over `weeks` ────────
async function computeKeyChildren(db, staffId, weeks) {
  const kids = (await db.query(`
    SELECT id, first_name FROM children
    WHERE key_person_id = $1 AND is_active = true ORDER BY first_name`, [staffId])).rows;
  if (!kids.length) return { children: [], area_totals: [], thin_areas: [], quiet_recent_count: 0 };

  const kidIds = kids.map(k => k.id);
  const since = new Date(); since.setDate(since.getDate() - weeks * 7);
  const recentCut = new Date(); recentCut.setDate(recentCut.getDate() - HALF_TERM_DAYS);
  // Coverage of the key child by ANY author — key-person responsibility is that the
  // child is observed, not only by the key person. Headline stats above are the
  // practitioner's own authored output; this matrix is the child's coverage.
  const obs = (await db.query(`
    SELECT child_id, eyfs_areas, created_at
    FROM observations
    WHERE child_id = ANY($1::int[]) AND created_at >= $2
    ORDER BY child_id, created_at`, [kidIds, since.toISOString()])).rows;

  const per = Object.fromEntries(kids.map(k => [k.id, {
    child_id: k.id, name: k.first_name, obs_count: 0,
    areas: {}, recent_areas: {}, dates: [],
  }]));
  const areaTotals = Object.fromEntries(EYFS_AREAS.map(a => [a.key, 0]));
  for (const o of obs) {
    const pc = per[o.child_id]; if (!pc) continue;
    pc.obs_count++;
    pc.dates.push(new Date(o.created_at));
    const recent = new Date(o.created_at) >= recentCut;
    const seen = new Set();
    for (const raw of (o.eyfs_areas || [])) {
      const k = normArea(raw); if (!k || seen.has(k)) continue; seen.add(k);
      pc.areas[k] = (pc.areas[k] || 0) + 1;
      areaTotals[k]++;
      if (recent) pc.recent_areas[k] = (pc.recent_areas[k] || 0) + 1;
    }
  }
  const now = Date.now();
  const children = kids.map(k => {
    const pc = per[k.id];
    // Longest gap between consecutive observations of this child, in days.
    let maxGap = 0, lastDate = null;
    for (let i = 1; i < pc.dates.length; i++) {
      const g = Math.round((pc.dates[i] - pc.dates[i - 1]) / 86400000);
      if (g > maxGap) maxGap = g;
    }
    if (pc.dates.length) lastDate = pc.dates[pc.dates.length - 1];
    const daysSinceLast = lastDate ? Math.round((now - lastDate) / 86400000) : null;
    const recentTotal = Object.values(pc.recent_areas).reduce((a, b) => a + b, 0);
    return {
      child_id: k.id, name: k.first_name, obs_count: pc.obs_count,
      areas: EYFS_AREAS.map(a => ({
        key: a.key, count: pc.areas[a.key] || 0,
        recent: (pc.recent_areas[a.key] || 0) > 0,   // observed this half-term?
      })),
      recent_obs_count: recentTotal,
      max_gap_days: maxGap,
      days_since_last: daysSinceLast,
      last_obs_date: lastDate ? lastDate.toISOString().slice(0, 10) : null,
    };
  });
  const area_totals = EYFS_AREAS.map(a => ({ key: a.key, name: a.name, prime: a.prime, count: areaTotals[a.key] }));
  // "Thin" = area with the least evidence across all key children (bottom third, count small).
  const thin_areas = [...area_totals].filter(a => a.count <= 1).sort((x, y) => x.count - y.count).map(a => a.name);
  const quiet_recent_count = children.filter(c => c.recent_obs_count === 0).length;
  return { children, area_totals, thin_areas, quiet_recent_count };
}

// GET /viewable-staff — who can this caller view? (managers/deputies get the roster)
router.get('/viewable-staff', learningOnly, async (req, res) => {
  const canViewOthers = MANAGER_ROLES.has(String(req.user.role || '').toLowerCase());
  if (!canViewOthers) return res.json({ can_view_others: false, staff: [] });
  try {
    const { rows } = await getPool().query(`
      SELECT id, COALESCE(NULLIF(btrim(first_name || ' ' || COALESCE(last_name,'')), ''), 'Staff #' || id) AS name, role
      FROM staff
      WHERE is_active = true AND role IN ('practitioner','deputy_manager','manager','apprentice')
      ORDER BY name`);
    res.json({ can_view_others: true, staff: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /my-stats?weeks=&staff_id= — observations dashboard + key-children matrix
router.get('/my-stats', learningOnly, async (req, res) => {
  const t = resolveTarget(req); if (!t.ok) return res.status(t.code).json({ error: t.error });
  const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 26, 1), 52);
  const db = getPool();
  try {
    const twelveMoAgo = new Date(); twelveMoAgo.setMonth(twelveMoAgo.getMonth() - 12);
    const [stats, monthlyRows, keyed] = await Promise.all([
      computeObsStats(db, t.id, twelveMoAgo.toISOString()),
      db.query(`
        SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS m, count(*)::int AS n
        FROM observations
        WHERE staff_id = $1 AND created_at >= date_trunc('month', now()) - interval '11 months'
        GROUP BY 1 ORDER BY 1`, [t.id]),
      computeKeyChildren(db, t.id, weeks),
    ]);
    // Fill a continuous 12-month series so the chart has no holes.
    const byMonth = Object.fromEntries(monthlyRows.rows.map(r => [r.m, r.n]));
    const months = [];
    const d = new Date(); d.setDate(1);
    for (let i = 11; i >= 0; i--) {
      const dd = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const key = dd.toISOString().slice(0, 7);
      months.push({ month: key, label: dd.toLocaleDateString('en-GB', { month: 'short' }), count: byMonth[key] || 0 });
    }
    let subject = null;
    if (!t.self) {
      const s = (await db.query(`SELECT first_name, last_name FROM staff WHERE id = $1`, [t.id])).rows[0];
      subject = s ? { id: t.id, name: [s.first_name, s.last_name].filter(Boolean).join(' ') } : { id: t.id, name: 'Staff #' + t.id };
    }
    res.json({
      staff_id: t.id, self: t.self, subject, weeks,
      stats, months, areas: EYFS_AREAS.map(a => ({ key: a.key, name: a.name, prime: a.prime })),
      children: keyed.children, area_totals: keyed.area_totals,
      thin_areas: keyed.thin_areas, quiet_recent_count: keyed.quiet_recent_count,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /focus?weeks=&staff_id= — per-key-child "what they've learnt / focus next"
router.get('/focus', learningOnly, async (req, res) => {
  const t = resolveTarget(req); if (!t.ok) return res.status(t.code).json({ error: t.error });
  const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 26, 1), 52);
  const db = getPool();
  try {
    const keyed = await computeKeyChildren(db, t.id, weeks);
    if (!keyed.children.length) return res.json({ children: [] });
    const kidIds = keyed.children.map(c => c.child_id);
    const ns = (await db.query(`
      SELECT child_id,
        count(*) FILTER (WHERE completed_observation_id IS NULL
          AND (status IS NULL OR lower(status) IN ('pending','open','in_progress')))::int AS open,
        count(*) FILTER (WHERE completed_observation_id IS NOT NULL
          OR lower(status) IN ('done','complete','completed','achieved','met'))::int AS done
      FROM next_steps WHERE child_id = ANY($1::int[]) GROUP BY child_id`, [kidIds])).rows;
    const nsBy = Object.fromEntries(ns.map(r => [r.child_id, r]));
    const nameByKey = Object.fromEntries(EYFS_AREAS.map(a => [a.key, a.name]));
    const children = keyed.children.map(c => {
      const ranked = [...c.areas].sort((a, b) => b.count - a.count);
      const strong = ranked.filter(a => a.count > 0).slice(0, 3).map(a => nameByKey[a.key]);
      const thin = ranked.filter(a => a.count === 0).map(a => nameByKey[a.key]);
      const n = nsBy[c.child_id] || { open: 0, done: 0 };
      return {
        child_id: c.child_id, name: c.name, obs_count: c.obs_count,
        strong_areas: strong, thin_areas: thin,
        next_steps_open: n.open, next_steps_done: n.done,
        days_since_last: c.days_since_last,
      };
    });
    res.json({ weeks, children });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Provision / resource angle ────────────────────────────────────────────────
const STOPWORDS = new Set(['and','the','with','play','area','time','set','box','tray','corner',
  'small','world','role','game','games','kids','baby','babies','fun','our','for','you','your']);

// GET /provision-gaps?weeks=&staff_id= — resource cards the key children have not
// (apparently) been observed engaging with. Matching is done entirely server-side
// against the setting's own DB (obs titles + areas); nothing leaves the box.
router.get('/provision-gaps', learningOnly, async (req, res) => {
  const t = resolveTarget(req); if (!t.ok) return res.status(t.code).json({ error: t.error });
  const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 26, 1), 52);
  const db = getPool();
  try {
    let cards = [];
    try { cards = require('./resource-cards')._loadCards().index || []; } catch { cards = []; }
    const kids = (await db.query(
      `SELECT id FROM children WHERE key_person_id = $1 AND is_active = true`, [t.id])).rows;
    if (!kids.length || !cards.length) {
      return res.json({ cards: [], total_cards: cards.length, seen: 0, not_seen: [],
        message: kids.length ? 'No resource cards available yet.' : 'You have no key children assigned yet.' });
    }
    const kidIds = kids.map(k => k.id);
    const since = new Date(); since.setDate(since.getDate() - weeks * 7);
    // Build a lowercase haystack per child's recent observations (title + areas +
    // a short slice of text). Stays in Node memory on the local box only.
    const obs = (await db.query(`
      SELECT title, observation_text, eyfs_areas, subject_areas
      FROM observations
      WHERE child_id = ANY($1::int[]) AND created_at >= $2
      ORDER BY created_at DESC LIMIT 500`, [kidIds, since.toISOString()])).rows;
    const haystacks = obs.map(o => {
      const parts = [o.title || '', (o.eyfs_areas || []).join(' '), (o.subject_areas || []).join(' '),
        String(o.observation_text || '').slice(0, 240)];
      return ' ' + parts.join(' ').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ') + ' ';
    });
    // Which "gap" areas (little evidence) should we prioritise surfacing cards for?
    const keyed = await computeKeyChildren(db, t.id, weeks);
    const thinSet = new Set(keyed.thin_areas);

    function cardTerms(card) {
      const words = (String(card.slug || '').split('-').concat(String(card.title || '').toLowerCase().split(/\s+/)));
      return [...new Set(words.map(w => w.replace(/[^a-z0-9]/g, '')).filter(w => w.length >= 4 && !STOPWORDS.has(w)))];
    }
    const notSeen = [];
    let seenCount = 0;
    for (const card of cards) {
      const terms = cardTerms(card);
      if (!terms.length) continue;
      const re = new RegExp('\\b(' + terms.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b');
      const seen = haystacks.some(h => re.test(h));
      if (seen) { seenCount++; continue; }
      const areas = Array.isArray(card.areas) ? card.areas : [];
      const fillsGap = areas.some(a => thinSet.has(a));
      notSeen.push({ slug: card.slug, title: card.title, category: card.category, areas, fills_gap: fillsGap });
    }
    // Gap-filling cards first, then the rest — cap the list so it stays a nudge.
    notSeen.sort((a, b) => (b.fills_gap - a.fills_gap));
    res.json({
      total_cards: cards.length, seen: seenCount,
      not_seen: notSeen.slice(0, 12), weeks,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI coaching card ("Wren suggests") — local model + RAG, cached weekly ──────
const COACHING_SYSTEM = [
  'You are Wren, a warm, experienced early years practice coach. You are given ONE',
  'practitioner\'s own observation statistics, a few of their recent observation texts,',
  'and some grounded EYFS good-practice passages. Write 3 to 5 short, specific, kind,',
  'ACTIONABLE coaching suggestions to help them strengthen their observation and',
  'assessment practice. Each suggestion is one or two sentences, concrete and doable',
  'this week, encouraging and never judgemental. Base them on THIS practitioner\'s',
  'actual numbers and writing — name the pattern you noticed (short observations, few',
  'next steps, an under-evidenced area of learning, a long gap for a child). Ground any',
  'pedagogy point in the passages when relevant. NEVER mention staffing levels,',
  'colleagues, absence, ratios, payroll or other staff. NEVER use a child\'s full name.',
  'Do not invent statutory facts, figures or citations. Output ONLY the suggestions,',
  'each on its own line starting with "SUGGESTION: ".',
].join(' ');

// Deterministic, genuinely-useful fallback tips derived from the stats alone
// (used when the local model is unavailable) — the card is valuable without AI.
function fallbackSuggestions(stats, keyed) {
  const out = [];
  if (stats.total === 0) {
    out.push('You have no recent observations recorded — even one short note about a child’s play this week is a great place to start.');
  }
  if (stats.pct_under_25 >= 40) {
    out.push(`About ${stats.pct_under_25}% of your observations are under 25 words — try adding a line on what the child said or did next; a short quote brings an observation to life.`);
  }
  if (stats.framework_pct < 25) {
    out.push(`Only ${stats.framework_pct}% of your observations link to a framework statement — linking one helps show a child’s progress over time.`);
  }
  if (stats.nextstep_pct < 30) {
    out.push(`Just ${stats.nextstep_pct}% of your observations note a next step — jotting “what next?” turns an observation into a plan.`);
  }
  if (stats.photo_pct < 40) {
    out.push(`${stats.photo_pct}% of your observations include a photo — the odd snapshot of a highlight helps parents picture the moment.`);
  }
  if (keyed && keyed.thin_areas && keyed.thin_areas.length) {
    out.push(`You’ve evidenced ${keyed.thin_areas[0]} less lately — planning one focused activity would round out your key children’s coverage.`);
  }
  if (keyed && keyed.quiet_recent_count > 0) {
    out.push(`${keyed.quiet_recent_count} of your key children have no observation this half-term — a quick note on each would keep their journey up to date.`);
  }
  if (out.length < 2) {
    out.push('Your observations are ticking along nicely — this week, try picking one child and following a single interest in depth.');
    out.push('When you next observe, pause on the Characteristics of Effective Learning — how a child learns is as tellable as what they did.');
  }
  return out.slice(0, 5).map(text => ({ text }));
}

async function generateCoaching(db, staffId, keyed, stats) {
  // Grounding query built from the practitioner's thin areas + generic pedagogy —
  // deliberately NOT their name or any staffing term, so retrieval favours practice
  // content, not whole-setting HR data.
  const gq = ('quality early years observations next steps characteristics of effective learning '
    + 'evidencing areas of learning ' + (keyed.thin_areas || []).slice(0, 3).join(' ')).trim();
  let groundBlock = '', sources = [];
  try {
    const { chunks } = await eyfsBrainRag.retrieve(db, gq, 4);
    if (chunks && chunks.length) {
      groundBlock += chunks.map(c => `• [${c.source_label}] ${String(c.text).slice(0, 320)}`).join('\n');
      sources = sources.concat(eyfsBrainRag.citationDetails(chunks, 3));
    }
  } catch { /* non-fatal */ }
  try {
    const brainSearch = require('./brain')._qdrantSearch;
    if (brainSearch) {
      const hits = await brainSearch(gq, 5);
      // Belt-and-braces: drop any whole-setting HR/staffing/absence/finance chunk —
      // this card is a practitioner's, and none of that belongs in it.
      const EXCLUDE = /(staffing|absence|payroll|salar|wage|roster|rota|overstaff|understaff|disciplin|grievance|redundan|contract of employ|sickness)/i;
      const kept = (hits || []).filter(h => !EXCLUDE.test(String(h.title || '') + ' ' + String(h.text || '')));
      if (kept.length) {
        groundBlock += (groundBlock ? '\n' : '') + kept.slice(0, 3)
          .map(h => `• [${h.source}${h.title ? ' — ' + h.title : ''}] ${String(h.text).slice(0, 300)}`).join('\n');
        for (const h of kept.slice(0, 3)) sources.push({ label: (h.title || h.source || 'Nursery document'), url: null });
      }
    }
  } catch { /* non-fatal */ }

  // A sample of their OWN recent observation texts — local model only, never logged.
  const samples = (await db.query(`
    SELECT title, observation_text FROM observations
    WHERE staff_id = $1 AND COALESCE(btrim(observation_text),'') <> ''
    ORDER BY created_at DESC LIMIT 8`, [staffId])).rows
    .map(o => `• ${(o.title || 'Observation').slice(0, 80)}: ${String(o.observation_text).replace(/\s+/g, ' ').slice(0, 320)}`)
    .join('\n');

  const userLines = [
    'YOUR OBSERVATION STATS (last 12 months):',
    `- Observations written: ${stats.total}`,
    `- Average length: ${stats.avg_words} words (${stats.pct_under_25}% are under 25 words)`,
    `- Include a photo: ${stats.photo_pct}%`,
    `- Linked to a framework statement: ${stats.framework_pct}%`,
    `- Include a next step: ${stats.nextstep_pct}%`,
    `- Key children: ${keyed.children.length} (${keyed.quiet_recent_count} have no observation in the last half-term)`,
    `- Areas of learning with little recent evidence across your key children: ${(keyed.thin_areas && keyed.thin_areas.length) ? keyed.thin_areas.join(', ') : 'none — good spread'}`,
  ];
  if (samples) userLines.push('', 'A FEW OF YOUR RECENT OBSERVATIONS (your own words):', samples);
  if (groundBlock) userLines.push('', 'EYFS GOOD-PRACTICE PASSAGES (ground pedagogy points in these; name the source if you use one):', groundBlock);

  const out = await ollamaChat(COACHING_SYSTEM, [{ role: 'user', content: userLines.join('\n') }],
    { timeout: 60000, num_predict: 600, temperature: 0.5 });
  // Prefer explicit SUGGESTION: lines; fall back to any substantive line.
  let lines = out.split('\n').map(l => l.trim())
    .filter(l => /^suggestion\s*:/i.test(l)).map(l => l.replace(/^suggestion\s*:/i, '').trim());
  if (!lines.length) {
    lines = out.split('\n').map(l => l.replace(/^[\s\-\*\d\.\)]+/, '').trim()).filter(l => l.length > 15);
  }
  const suggestions = lines.filter(l => l.length > 12).slice(0, 5).map(text => ({ text }));
  // De-dup sources by label
  const seenSrc = new Set();
  const cleanSources = sources.filter(s => s && s.label && !seenSrc.has(s.label) && seenSrc.add(s.label)).slice(0, 5);
  return { suggestions, sources: cleanSources };
}

// GET /coaching?staff_id= — the weekly "Wren suggests" card (cached per ISO week)
router.get('/coaching', learningOnly, async (req, res) => {
  const t = resolveTarget(req); if (!t.ok) return res.status(t.code).json({ error: t.error });
  const db = getPool();
  try {
    const weekRow = (await db.query(`SELECT date_trunc('week', now())::date AS ws`)).rows[0];
    const weekStart = weekRow.ws;
    const cached = (await db.query(
      `SELECT suggestions, stats, sources, model, feedback, week_start, created_at
       FROM reflection_coaching WHERE staff_id = $1 AND week_start = $2`, [t.id, weekStart])).rows[0];
    if (cached && Array.isArray(cached.suggestions) && cached.suggestions.length) {
      return res.json({ cached: true, week_start: cached.week_start, model: cached.model,
        suggestions: cached.suggestions, stats: cached.stats, sources: cached.sources || [],
        feedback: cached.feedback, self: t.self });
    }

    const twelveMoAgo = new Date(); twelveMoAgo.setMonth(twelveMoAgo.getMonth() - 12);
    const [stats, keyed] = await Promise.all([
      computeObsStats(db, t.id, twelveMoAgo.toISOString()),
      computeKeyChildren(db, t.id, 26),
    ]);

    let suggestions = [], sources = [], model = 'fallback';
    try {
      const gen = await generateCoaching(db, t.id, keyed, stats);
      if (gen.suggestions && gen.suggestions.length >= 2) {
        suggestions = gen.suggestions; sources = gen.sources || []; model = REFLECT_MODEL;
      }
    } catch { /* fall through to deterministic */ }
    if (!suggestions.length) suggestions = fallbackSuggestions(stats, keyed);

    const statsSnap = { ...stats, key_children: keyed.children.length,
      thin_areas: keyed.thin_areas, quiet_recent_count: keyed.quiet_recent_count };

    // Only cache a real AI card — let fallback cards retry next load (the model may
    // just have been momentarily down).
    if (model !== 'fallback') {
      try {
        await db.query(`
          INSERT INTO reflection_coaching (staff_id, week_start, suggestions, stats, sources, model)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (staff_id, week_start) DO UPDATE
            SET suggestions = EXCLUDED.suggestions, stats = EXCLUDED.stats,
                sources = EXCLUDED.sources, model = EXCLUDED.model, updated_at = now()`,
          [t.id, weekStart, JSON.stringify(suggestions), JSON.stringify(statsSnap),
           JSON.stringify(sources), model]);
      } catch (e) { /* cache write is best-effort */ }
    }
    res.json({ cached: false, week_start: weekStart, model, suggestions, stats: statsSnap,
      sources, feedback: null, self: t.self });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /coaching/feedback { useful:bool, week_start? } — thumbs up/down (for tuning)
router.post('/coaching/feedback', learningOnly, async (req, res) => {
  const t = resolveTarget(req); if (!t.ok) return res.status(t.code).json({ error: t.error });
  if (typeof req.body?.useful !== 'boolean') return res.status(400).json({ error: 'useful (boolean) required' });
  const db = getPool();
  try {
    const ws = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.week_start || ''))
      ? req.body.week_start
      : (await db.query(`SELECT date_trunc('week', now())::date AS ws`)).rows[0].ws;
    const fb = req.body.useful ? 1 : -1;
    await db.query(`
      INSERT INTO reflection_coaching (staff_id, week_start, suggestions, feedback, feedback_at)
      VALUES ($1,$2,'[]'::jsonb,$3, now())
      ON CONFLICT (staff_id, week_start) DO UPDATE
        SET feedback = EXCLUDED.feedback, feedback_at = now()`, [t.id, ws, fb]);
    res.json({ ok: true, feedback: fb });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// b170 — Always-on staff knowledge: termly, spaced/rotating knowledge checks.
// Distinct from the pre-existing daily micro-CPD nudge above (which is a single
// dismissible banner pulling from the same reflection_quiz_bank). This layer
// assigns a small rotating SET of questions per staff member per term (topic
// registry: knowledge_topics), tracks per-topic mastery (staff_topic_mastery),
// and lets managers assign specific topics/questions and see gaps
// (knowledge_check_assignments). Surfaced as a real pop-up modal on EY login
// (editions/ladn/public/ey/home.html) and a Roost management page
// (editions/admin/public/staff-knowledge.html).
// ═════════════════════════════════════════════════════════════════════════════

// UK academic term for a date — used as the rotation/assignment period key.
function currentTermKey(d = new Date()) {
  const m = d.getMonth() + 1; // 1-12
  const y = d.getFullYear();
  if (m >= 9) return `${y}-Autumn`;
  if (m <= 4) return `${y}-Spring`;
  return `${y}-Summer`;
}

// Small deterministic string hash — used to vary which question in a topic a
// given staff member gets on a given day, without needing real randomness.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Pick a quiz_key for a topic for this staff member — prefers a question they
// haven't been asked recently (across EITHER the daily nudge or a termly
// check; both draw from the same reflection_quiz_bank), varied per staff so a
// room doesn't all get the same question.
async function pickQuizForTopic(db, staffId, topic) {
  const bank = (await db.query(
    `SELECT quiz_key FROM reflection_quiz_bank WHERE topic = $1 AND active = true ORDER BY quiz_key`,
    [topic])).rows.map(r => r.quiz_key);
  if (!bank.length) return null;
  const recent = new Set((await db.query(`
    SELECT b.quiz_key FROM reflection_quiz_attempts a
    JOIN reflection_quiz_bank b ON b.quiz_key = a.quiz_key
    WHERE a.staff_id = $1 AND b.topic = $2
    ORDER BY a.taken_at DESC LIMIT 6`, [staffId, topic])).rows.map(r => r.quiz_key));
  const pool = bank.filter(k => !recent.has(k));
  const chooseFrom = pool.length ? pool : bank;
  const idx = hashStr(`${staffId}-${topic}-${dayNumber()}`) % chooseFrom.length;
  return chooseFrom[idx];
}

// Ensure this staff member has a rotating set of assignments for the current
// term. Idempotent — does nothing if any assignment already exists for the
// term (manager-assigned or auto-generated). Always includes topics flagged
// always_include (safeguarding); fills remaining slots prioritising topics
// never attempted, then lowest mastery, then longest since last attempt.
const TERM_ROTATION_SIZE = 4;
async function ensureTermAssignments(db, staffId) {
  const term = currentTermKey();
  // The auto-batch itself is idempotent per term (flagged by its own reason) —
  // it still tops up around any manager-assigned topics for the same term
  // rather than backing off entirely just because one exists.
  const already = (await db.query(
    `SELECT count(*)::int AS n FROM knowledge_check_assignments
     WHERE staff_id = $1 AND term_key = $2 AND assigned_reason = 'termly_auto'`,
    [staffId, term])).rows[0].n;
  if (already > 0) return term;

  const topics = (await db.query(
    `SELECT topic_key, always_include FROM knowledge_topics WHERE active = true ORDER BY sort_order`)).rows;
  if (!topics.length) return term;
  const mastery = (await db.query(
    `SELECT topic, mastery_score, last_attempt_at FROM staff_topic_mastery WHERE staff_id = $1`,
    [staffId])).rows;
  const masteryByTopic = Object.fromEntries(mastery.map(m => [m.topic, m]));

  const forced = topics.filter(t => t.always_include).map(t => t.topic_key);
  const rest = topics.filter(t => !t.always_include).slice();
  rest.sort((a, b) => {
    const ma = masteryByTopic[a.topic_key], mb = masteryByTopic[b.topic_key];
    const sa = ma && ma.mastery_score != null ? Number(ma.mastery_score) : -1; // never-attempted first
    const sb = mb && mb.mastery_score != null ? Number(mb.mastery_score) : -1;
    if (sa !== sb) return sa - sb;
    const la = ma && ma.last_attempt_at ? new Date(ma.last_attempt_at).getTime() : 0;
    const lb = mb && mb.last_attempt_at ? new Date(mb.last_attempt_at).getTime() : 0;
    return la - lb;
  });
  const selected = [...forced];
  for (const t of rest) {
    if (selected.length >= TERM_ROTATION_SIZE) break;
    if (!selected.includes(t.topic_key)) selected.push(t.topic_key);
  }

  const dueDate = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  for (const topic of selected) {
    const quizKey = await pickQuizForTopic(db, staffId, topic);
    if (!quizKey) continue;
    await db.query(`
      INSERT INTO knowledge_check_assignments (staff_id, term_key, topic, quiz_key, assigned_reason, status, due_date)
      VALUES ($1,$2,$3,$4,'termly_auto','pending',$5)
      ON CONFLICT (staff_id, term_key, topic) DO NOTHING`,
      [staffId, term, topic, quizKey, dueDate]);
  }
  return term;
}

// Upsert rolling per-staff per-topic mastery after a graded attempt.
async function updateMastery(db, staffId, topic, correct, term) {
  const inc = correct ? 1 : 0;
  await db.query(`
    INSERT INTO staff_topic_mastery (staff_id, topic, attempts_count, correct_count, mastery_score, last_attempt_at, last_correct, last_term_seen, needs_review)
    VALUES ($1,$2,1,$3,$4,now(),$5,$6,$7)
    ON CONFLICT (staff_id, topic) DO UPDATE SET
      attempts_count  = staff_topic_mastery.attempts_count + 1,
      correct_count   = staff_topic_mastery.correct_count + $3,
      mastery_score   = round((staff_topic_mastery.correct_count + $3)::numeric / (staff_topic_mastery.attempts_count + 1) * 100, 2),
      last_attempt_at = now(),
      last_correct    = $5,
      last_term_seen  = $6,
      needs_review    = (round((staff_topic_mastery.correct_count + $3)::numeric / (staff_topic_mastery.attempts_count + 1) * 100, 2) < 75),
      updated_at      = now()
  `, [staffId, topic, inc, correct ? 100 : 0, correct, term, !correct]);
}

// GET /knowledge/topics — the topic registry (used by both the pop-up's topic
// label and the manager's assign dropdown).
router.get('/knowledge/topics', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT topic_key, label, description, category, sort_order, always_include
      FROM knowledge_topics WHERE active = true ORDER BY sort_order`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /knowledge/next — the ONE pending question to pop up right now (or
// null). Generates this term's rotation on first call if none exists yet.
router.get('/knowledge/next', async (req, res) => {
  const db = getPool();
  try {
    const term = await ensureTermAssignments(db, req.user.id);
    const row = (await db.query(`
      SELECT a.id, a.topic, kt.label AS topic_label, a.quiz_key, a.due_date, b.question, b.options
      FROM knowledge_check_assignments a
      JOIN knowledge_topics kt      ON kt.topic_key = a.topic
      JOIN reflection_quiz_bank b   ON b.quiz_key = a.quiz_key
      WHERE a.staff_id = $1 AND a.status = 'pending'
      ORDER BY a.id ASC LIMIT 1`, [req.user.id])).rows[0];
    const pendingCount = (await db.query(
      `SELECT count(*)::int AS n FROM knowledge_check_assignments WHERE staff_id = $1 AND status = 'pending'`,
      [req.user.id])).rows[0].n;
    if (!row) return res.json({ term_key: term, assignment: null, pending_count: 0 });
    res.json({
      term_key: term, pending_count: pendingCount,
      assignment: {
        id: row.id, topic: row.topic, topic_label: row.topic_label, quiz_key: row.quiz_key,
        question: row.question, options: row.options, due_date: row.due_date,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /knowledge/:id/attempt { choice } — grade, record, update mastery.
router.post('/knowledge/:id/attempt', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  const choice = parseInt(req.body?.choice, 10);
  const db = getPool();
  try {
    const a = (await db.query(`
      SELECT a.id, a.status, a.term_key, a.quiz_key, b.options, b.correct, b.explain, a.topic
      FROM knowledge_check_assignments a
      JOIN reflection_quiz_bank b ON b.quiz_key = a.quiz_key
      WHERE a.id = $1 AND a.staff_id = $2`, [req.params.id, req.user.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status === 'completed') {
      return res.status(409).json({ error: 'Already completed', correct_index: a.correct, explain: a.explain });
    }
    const nOpts = Array.isArray(a.options) ? a.options.length : 0;
    if (!Number.isInteger(choice) || choice < 0 || choice >= nOpts) {
      return res.status(400).json({ error: 'Invalid choice' });
    }
    const correct = choice === a.correct;
    const attempt = (await db.query(`
      INSERT INTO reflection_quiz_attempts (staff_id, quiz_key, score, total, answers, assignment_id)
      VALUES ($1,$2,$3,1,$4,$5) RETURNING id`,
      [req.user.id, a.quiz_key, correct ? 1 : 0, JSON.stringify({ choice, correct }), a.id])).rows[0];
    await db.query(
      `UPDATE knowledge_check_assignments SET status = 'completed', completed_at = now(), attempt_id = $1 WHERE id = $2`,
      [attempt.id, a.id]);
    await updateMastery(db, req.user.id, a.topic, correct, a.term_key);
    res.json({ correct, correct_index: a.correct, explain: a.explain, topic: a.topic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /knowledge/mastery?staff_id= — per-topic mastery (self, or a manager
// viewing anyone — reuses the resolveTarget gate defined above for b167).
router.get('/knowledge/mastery', learningOnly, async (req, res) => {
  const t = resolveTarget(req); if (!t.ok) return res.status(t.code).json({ error: t.error });
  try {
    const rows = (await getPool().query(`
      SELECT kt.topic_key AS topic, kt.label, kt.category, m.attempts_count, m.correct_count,
             m.mastery_score, m.last_attempt_at, m.last_correct, m.needs_review
      FROM knowledge_topics kt
      LEFT JOIN staff_topic_mastery m ON m.topic = kt.topic_key AND m.staff_id = $1
      WHERE kt.active = true ORDER BY kt.sort_order`, [t.id])).rows;
    res.json({ staff_id: t.id, self: t.self, topics: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /knowledge/my-progress — my current-term rotation + full mastery table.
router.get('/knowledge/my-progress', async (req, res) => {
  const db = getPool();
  try {
    const term = await ensureTermAssignments(db, req.user.id);
    const current = (await db.query(`
      SELECT a.id, a.topic, kt.label AS topic_label, a.status, a.due_date, a.completed_at
      FROM knowledge_check_assignments a JOIN knowledge_topics kt ON kt.topic_key = a.topic
      WHERE a.staff_id = $1 AND a.term_key = $2 ORDER BY kt.sort_order`, [req.user.id, term])).rows;
    const mastery = (await db.query(`
      SELECT m.topic, kt.label, m.attempts_count, m.correct_count, m.mastery_score, m.needs_review
      FROM staff_topic_mastery m JOIN knowledge_topics kt ON kt.topic_key = m.topic
      WHERE m.staff_id = $1 ORDER BY m.mastery_score ASC NULLS FIRST`, [req.user.id])).rows;
    res.json({ term_key: term, current_term: current, mastery });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /knowledge/roster — manager: every staff member's knowledge status at a
// glance (for the Roost management page staff list).
router.get('/knowledge/roster', async (req, res) => {
  if (!MANAGER_ROLES.has(String(req.user.role || '').toLowerCase())) {
    return res.status(403).json({ error: 'Managers only' });
  }
  const db = getPool();
  try {
    const staffRows = (await db.query(`
      SELECT id, COALESCE(NULLIF(btrim(first_name || ' ' || COALESCE(last_name,'')), ''), 'Staff #' || id) AS name, role
      FROM staff WHERE is_active = true AND role IN ('practitioner','deputy_manager','manager','apprentice')
      ORDER BY name`)).rows;
    const topicsTotal = (await db.query(`SELECT count(*)::int AS n FROM knowledge_topics WHERE active = true`)).rows[0].n;
    const masteryAgg = (await db.query(`
      SELECT staff_id, round(avg(mastery_score) FILTER (WHERE mastery_score IS NOT NULL), 1) AS avg_mastery,
        count(*) FILTER (WHERE attempts_count > 0) AS topics_attempted,
        count(*) FILTER (WHERE needs_review AND attempts_count > 0) AS topics_needing_review
      FROM staff_topic_mastery GROUP BY staff_id`)).rows;
    const weakestRows = (await db.query(`
      SELECT DISTINCT ON (m.staff_id) m.staff_id, kt.label AS weakest_topic, m.mastery_score
      FROM staff_topic_mastery m JOIN knowledge_topics kt ON kt.topic_key = m.topic
      WHERE m.attempts_count > 0
      ORDER BY m.staff_id, m.mastery_score ASC NULLS LAST, m.attempts_count ASC`)).rows;
    const assignAgg = (await db.query(`
      SELECT staff_id,
        count(*) FILTER (WHERE status = 'pending') AS pending_count,
        count(*) FILTER (WHERE status = 'pending' AND due_date < CURRENT_DATE) AS overdue_count,
        count(*) FILTER (WHERE status = 'completed') AS completed_count
      FROM knowledge_check_assignments GROUP BY staff_id`)).rows;
    const mBy = Object.fromEntries(masteryAgg.map(r => [r.staff_id, r]));
    const wBy = Object.fromEntries(weakestRows.map(r => [r.staff_id, r]));
    const aBy = Object.fromEntries(assignAgg.map(r => [r.staff_id, r]));
    const staff = staffRows.map(s => {
      const m = mBy[s.id] || {}, w = wBy[s.id] || {}, a = aBy[s.id] || {};
      return {
        staff_id: s.id, name: s.name, role: s.role,
        topics_attempted: m.topics_attempted || 0, topics_total: topicsTotal,
        avg_mastery: m.avg_mastery != null ? Number(m.avg_mastery) : null,
        topics_needing_review: m.topics_needing_review || 0,
        weakest_topic: w.weakest_topic || null,
        pending_count: a.pending_count || 0, overdue_count: a.overdue_count || 0,
        completed_count: a.completed_count || 0,
      };
    });
    res.json({ topics_total: topicsTotal, staff });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /knowledge/staff/:staff_id/summary[?format=text] — full breakdown for
// one staff member (manager, or the staff member themself) — used by the
// management-page drawer and for a supervision-ready copy/print summary.
router.get('/knowledge/staff/:staff_id/summary', async (req, res) => {
  const sid = parseInt(req.params.staff_id, 10);
  if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid staff_id' });
  const isSelf = sid === Number(req.user.id);
  const isMgr = MANAGER_ROLES.has(String(req.user.role || '').toLowerCase());
  if (!isSelf && !isMgr) return res.status(403).json({ error: 'Managers only' });
  const db = getPool();
  try {
    const staff = (await db.query(`SELECT id, first_name, last_name, role FROM staff WHERE id = $1`, [sid])).rows[0];
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    const topics = (await db.query(`
      SELECT kt.topic_key AS topic, kt.label, kt.category, m.attempts_count, m.correct_count,
             m.mastery_score, m.last_attempt_at, m.needs_review
      FROM knowledge_topics kt LEFT JOIN staff_topic_mastery m ON m.topic = kt.topic_key AND m.staff_id = $1
      WHERE kt.active = true ORDER BY kt.sort_order`, [sid])).rows;
    const assignments = (await db.query(`
      SELECT a.id, a.term_key, a.topic, kt.label AS topic_label, a.status, a.assigned_reason, a.due_date, a.completed_at
      FROM knowledge_check_assignments a JOIN knowledge_topics kt ON kt.topic_key = a.topic
      WHERE a.staff_id = $1 ORDER BY a.created_at DESC LIMIT 60`, [sid])).rows;
    const name = [staff.first_name, staff.last_name].filter(Boolean).join(' ') || ('Staff #' + sid);

    if (req.query.format === 'text') {
      const lines = [`Knowledge summary — ${name} (${staff.role || ''})`,
        `Generated ${new Date().toLocaleDateString('en-GB')}`, ''];
      topics.forEach(t => lines.push(
        `${t.label}: ${t.mastery_score != null ? t.mastery_score + '%' : 'not yet attempted'}` +
        (t.needs_review ? ' — needs review' : '')));
      lines.push('', 'Recent knowledge checks:');
      assignments.slice(0, 15).forEach(a => lines.push(
        `- [${a.term_key}] ${a.topic_label}: ${a.status}` +
        (a.completed_at ? ' (' + new Date(a.completed_at).toLocaleDateString('en-GB') + ')' : '')));
      return res.type('text/plain').send(lines.join('\n'));
    }
    res.json({ staff: { id: sid, name, role: staff.role }, topics, assignments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /knowledge/assign — manager: assign a topic (system picks the
// question) or a specific quiz_key, to chosen staff / a room / everyone.
router.post('/knowledge/assign', async (req, res) => {
  if (!MANAGER_ROLES.has(String(req.user.role || '').toLowerCase())) {
    return res.status(403).json({ error: 'Managers only' });
  }
  const b = req.body || {};
  const topic = String(b.topic || '').trim();
  if (!topic) return res.status(400).json({ error: 'topic required' });
  const db = getPool();
  try {
    const topicRow = (await db.query(
      `SELECT topic_key, label FROM knowledge_topics WHERE topic_key = $1 AND active = true`, [topic])).rows[0];
    if (!topicRow) return res.status(400).json({ error: 'Unknown topic' });

    let quizKey = b.quiz_key ? String(b.quiz_key) : null;
    if (quizKey) {
      const qr = (await db.query(
        `SELECT 1 FROM reflection_quiz_bank WHERE quiz_key = $1 AND topic = $2 AND active = true`,
        [quizKey, topic])).rows[0];
      if (!qr) return res.status(400).json({ error: 'quiz_key does not belong to that topic, or is inactive' });
    }

    let targets = [];
    if (Array.isArray(b.staff_ids) && b.staff_ids.length) targets = b.staff_ids.map(Number).filter(Boolean);
    else if (b.all === true) {
      targets = (await db.query(`SELECT id FROM staff WHERE is_active = true`)).rows.map(r => r.id);
    } else if (b.room_id) {
      targets = (await db.query(`SELECT id FROM staff WHERE is_active = true AND room_id = $1`,
        [parseInt(b.room_id, 10)])).rows.map(r => r.id);
    }
    targets = [...new Set(targets)];
    if (!targets.length) return res.status(400).json({ error: 'No target staff (provide staff_ids, room_id, or all:true)' });

    const term = /^\d{4}-(Autumn|Spring|Summer)$/.test(b.term_key || '') ? b.term_key : currentTermKey();
    const due = b.due_date || null;
    let assigned = 0;
    for (const sid of targets) {
      const qk = quizKey || await pickQuizForTopic(db, sid, topic);
      if (!qk) continue;
      await db.query(`
        INSERT INTO knowledge_check_assignments (staff_id, term_key, topic, quiz_key, assigned_by, assigned_reason, status, due_date)
        VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
        ON CONFLICT (staff_id, term_key, topic) DO UPDATE SET
          quiz_key        = CASE WHEN knowledge_check_assignments.status = 'completed' THEN knowledge_check_assignments.quiz_key ELSE EXCLUDED.quiz_key END,
          assigned_by     = EXCLUDED.assigned_by,
          assigned_reason = EXCLUDED.assigned_reason,
          due_date        = COALESCE(EXCLUDED.due_date, knowledge_check_assignments.due_date),
          status          = CASE WHEN knowledge_check_assignments.status = 'completed' THEN 'completed' ELSE 'pending' END
      `, [sid, term, topic, qk, req.user.id, quizKey ? 'manager_question' : 'manager_topic', due]);
      assigned++;
      try {
        notify('knowledge_check_due', 'staff', sid, 'New knowledge check assigned',
          `Topic: ${topicRow.label}`, { relatedTable: 'knowledge_check_assignments' });
      } catch { /* non-fatal */ }
    }
    res.json({ ok: true, topic, topic_label: topicRow.label, term_key: term, assigned, staff_ids: targets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
