const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getPool } = require('../db/pool');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const EMBED_MODEL = process.env.BRAIN_EMBED_MODEL || 'nomic-embed-text:latest';
const QDRANT_URL = process.env.BRAIN_QDRANT_URL || 'http://qdrant-work:6333';
const COLLECTION = 'wren_brain_v1';

// Helper: embed text via Ollama
async function embed(text) {
  const resp = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: String(text).slice(0, 4000) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`embed ${resp.status}`);
  const j = await resp.json();
  if (!Array.isArray(j.embedding)) throw new Error('no embedding');
  return j.embedding;
}

async function qdrantSearch(query, k = 12) {
  const vec = await embed(query);
  const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector: vec, limit: k, with_payload: true }),
    signal: AbortSignal.timeout(6000),
  });
  if (!resp.ok) throw new Error(`qdrant ${resp.status}`);
  const j = await resp.json();
  return (j.result || []).map(p => ({
    source: p.payload?.source || 'brain',
    text: p.payload?.text || '',
    title: p.payload?.title || '',
  }));
}

async function answerWithOllama(systemPrompt, userPrompt) {
  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-oss:120b', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], stream: false }),
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
    const context = chunks.map((c, i) => `[#${i + 1}] ${c.title}\n${c.text}`).join('\n\n');
    const systemPrompt = `You are Wren Brain, a knowledge assistant for Little Angels Day Nursery. Use only the provided context passages to answer the question. Cite passages by their number in brackets, e.g., [#1].\n\nContext:\n${context}`;
    const answer = await answerWithOllama(systemPrompt, question);
    res.json({ answer, sources: chunks.map(c => c.source) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

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
      const answer = await answerWithOllama('You are drafting a SWOT quadrant for Little Angels Day Nursery. Respond concisely.', p);
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

module.exports = router;
