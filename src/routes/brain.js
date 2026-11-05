const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getPool } = require('../db/pool');

// b333: model names + host come from ai-models.js, resolved per call. Vectors stay
// role 'embed' (nomic, 768-d) — wren_brain_v1 was built with it.
const ai = require('../lib/ai-models');
const QDRANT_URL = process.env.BRAIN_QDRANT_URL || 'http://qdrant-work:6333';
const COLLECTION = 'wren_brain_v1';

// Helper: embed text via Ollama
async function embed(text) {
  const resp = await fetch(`${ai.host()}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ai.model('embed'), prompt: String(text).slice(0, 4000) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`embed ${resp.status}`);
  const j = await resp.json();
  if (!Array.isArray(j.embedding)) throw new Error('no embedding');
  return j.embedding;
}

// b201: `filter` lets a caller scope the search to the navigational corpus
// (source in tour/help/guide) for "where do I find X?" without a second store.
async function qdrantSearch(query, k = 12, filter = null) {
  const vec = await embed(query);
  const body = { vector: vec, limit: k, with_payload: true };
  if (filter) body.filter = filter;
  const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  if (!resp.ok) throw new Error(`qdrant ${resp.status}`);
  const j = await resp.json();
  return (j.result || []).map(p => ({
    source: p.payload?.source || 'brain',
    text: p.payload?.text || '',
    title: p.payload?.title || '',
    // b201 — carried through so an answer can be a link, not a paragraph.
    url: p.payload?.url || null,
    portal: p.payload?.portal || null,
    status: p.payload?.status || null,
    score: p.score,
  }));
}

// b201 — "where do I find X?"  Deterministic corpus match FIRST (it cannot be
// wrong about which page a feature is on), vector search over the tour/help/guide
// chunks second (it catches phrasings the keyword matcher misses). Reuses the
// existing wren_brain_v1 collection — no second vector store.
const NAV_SOURCES = ['tour', 'help', 'guide'];
async function whereIs(question, limit = 5) {
  let tourContent = null;
  try { tourContent = require('../../public/js/wren-tour-content.js'); } catch (e) { /* optional */ }

  const exact = tourContent ? tourContent.find(question, { limit }) : [];
  const results = exact.map(h => ({
    match: 'corpus',
    title: tourContent.strip(h.title),
    url: h.url,
    portal: h.portal,
    what: tourContent.strip(h.what),
    does: tourContent.strip(h.does),
    gotcha: tourContent.strip(h.gotcha),
    status: h.status,
    issue: h.issue ? tourContent.strip(h.issue) : null,
    score: h.score,
  }));

  let vector = [];
  try {
    const hits = await qdrantSearch(question, limit * 2, {
      must: [{ key: 'source', match: { any: NAV_SOURCES } }],
    });
    const seen = new Set(results.map(r => r.url));
    vector = hits
      .filter(h => h.url && !seen.has(h.url))
      .slice(0, limit)
      .map(h => ({
        match: 'vector', title: h.title, url: h.url, portal: h.portal,
        what: String(h.text).slice(0, 400), does: null, gotcha: null,
        status: h.status, issue: null, score: h.score,
      }));
  } catch (e) {
    // Vector half is best-effort — the corpus match still answers the question
    // when Ollama or qdrant are down, which is the point of having both.
    console.warn('[brain/where] vector search unavailable:', e.message);
  }
  return { results: results.concat(vector), vector_available: vector.length > 0 || !!results.length };
}

// size 'long' when the system prompt carries retrieved passages (/ask).
async function answerWithOllama(systemPrompt, userPrompt, size) {
  const response = await fetch(`${ai.host()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ai.model('heavy'), messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], stream: false, think: false, options: ai.options({}, size) }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Ollama chat ${response.status}`);
  const data = await response.json();
  return data.message?.content?.trim() || '';
}

router.use(authenticate);
router.use(require('../middleware/auth').requireRole('manager'));

// POST /ask {question}
router.post('/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });
  try {
    const chunks = await qdrantSearch(question);
    const context = chunks.map((c, i) =>
      `[#${i + 1}] ${c.title}${c.url ? ` (page: ${c.url})` : ''}\n${c.text}`).join('\n\n');
    const systemPrompt = `You are Wren Brain, a knowledge assistant for Your Nursery. Use only the provided context passages to answer the question. Cite passages by their number in brackets, e.g., [#1]. When a passage names a page (page: /some/path), and the question is about where to find something or how to do it, give that path as the answer's link.\n\nContext:\n${context}`;
    const answer = await answerWithOllama(systemPrompt, question, 'long');
    res.json({ answer, sources: chunks.map(c => c.source) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET|POST /where?q=  — b201: "where do I find X?" → page + deep link.
async function whereHandler(req, res) {
  const q = String((req.query && req.query.q) || (req.body && req.body.question) || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  const limit = Math.min(10, Math.max(1, parseInt((req.query && req.query.limit) || '5', 10) || 5));
  try {
    const out = await whereIs(q, limit);
    res.json(Object.assign({ query: q }, out));
  } catch (e) {
    console.error('[brain/where]', e.message);
    res.status(500).json({ error: e.message });
  }
}
router.get('/where', whereHandler);
router.post('/where', whereHandler);

// POST /swot-draft – no input, generates SWOT draft
router.post('/swot-draft', async (req, res) => {
  const prompts = {
    strengths: 'List strengths of the nursery based on internal data and observations.',
    weaknesses: 'List weaknesses or recurring problems.',
    opportunities: 'Identify opportunities for improvement or growth.',
    threats: 'Identify external threats or challenges.',
  };
  try {
    const results = {};
    for (const [key, p] of Object.entries(prompts)) {
      const answer = await answerWithOllama('You are drafting a SWOT quadrant for Your Nursery. Respond concisely.', p);
      results[key] = answer;
    }
    res.json({ swot: results, note: 'draft by Wren brain — review before keeping' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Exported additively (2026-07-10) so the chat assistant can ground answers in
// the same knowledge base without duplicating embed/search logic.
router._qdrantSearch = qdrantSearch;
router._whereIs = whereIs;

module.exports = router;
