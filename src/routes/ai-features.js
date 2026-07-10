const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getPool } = require('../db/pool');

const OLLAMA_URL = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL_BIG  = process.env.AI_MODEL_BIG  || 'qwen3.5:27b';
const MODEL_FAST = process.env.AI_MODEL_FAST || 'qwen3.5:4b';

async function streamOllama(res, model, prompt) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');

  const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: true }),
    signal: AbortSignal.timeout(120000),
  });

  if (!ollamaRes.ok) {
    res.status(502).end(`Ollama error: ${ollamaRes.status}`);
    return;
  }

  const reader = ollamaRes.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = dec.decode(value).split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.response) res.write(obj.response);
        if (obj.done) { res.end(); return; }
      } catch {}
    }
  }
  res.end();
}

router.use(authenticate);

// POST /waiting-list
router.post('/waiting-list', async (req, res) => {
  const { action, enquiry_id } = req.body;
  const db = getPool();
  let enq;
  try {
    const { rows } = await db.query(
      `SELECT e.*, c.first_name as child_first_name, c.last_name as child_last_name,
              c.date_of_birth, e.notes, e.source
       FROM enquiries e
       LEFT JOIN children c ON c.id=e.child_id
       WHERE e.id=$1`, [enquiry_id]);
    enq = rows[0];
  } catch { enq = { id: enquiry_id }; }

  const ctx = JSON.stringify(enq || {});
  let prompt = '';
  if (action === 'score') {
    prompt = `You are an admissions assistant for a nursery. Score this enquiry 0-100 for priority/likelihood to convert, based on urgency, completeness and engagement. Give a score and brief rationale.\n\nEnquiry data: ${ctx}\n\nRespond with: Score: X/100\nRationale: <2-3 sentences>`;
  } else if (action === 'email') {
    prompt = `Draft a warm, professional follow-up email to the parent for this nursery waiting list enquiry. Keep it under 200 words, include a call to action to book a visit.\n\nEnquiry: ${ctx}`;
  } else if (action === 'notes') {
    prompt = `Summarise the key facts and any concerns from this nursery enquiry in bullet points.\n\nEnquiry: ${ctx}`;
  } else if (action === 'priority') {
    prompt = `Based on this enquiry, explain in 2-3 sentences why it should be prioritised or deprioritised on the waiting list.\n\nEnquiry: ${ctx}`;
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }

  try {
    await streamOllama(res, MODEL_FAST, prompt);
    // Save score to DB if action was score
    if (action === 'score' && enq) {
      // Score extraction happens client-side
    }
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// POST /absence-insights
router.post('/absence-insights', async (req, res) => {
  const { prompt, context } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const sysCtx = context ? `\n\nContext: ${JSON.stringify(context)}` : '';
  const fullPrompt = `You are an HR assistant at a nursery. Answer the following about staff absences concisely and professionally.${sysCtx}\n\nQuestion: ${prompt}`;

  try {
    await streamOllama(res, MODEL_FAST, fullPrompt);
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// POST /cpd-creator
router.post('/cpd-creator', async (req, res) => {
  const { topic, role, duration, format, sections, context } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });

  const sectionList = (sections || []).join(', ');
  const prompt = `You are an expert early years / primary school CPD designer. Create a ${format} for the topic "${topic}" for a ${role} at a UK nursery/school. Duration: ${duration}. Include these sections: ${sectionList}.${context ? ' Additional context: ' + context : ''}\n\nFormat the output clearly with section headers. Be practical and specific to UK early years / primary education.`;

  try {
    await streamOllama(res, MODEL_BIG, prompt);
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

module.exports = router;
