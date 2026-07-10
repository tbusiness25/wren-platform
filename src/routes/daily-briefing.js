const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
let cache = { bullets: [], priority: '', timestamp: 0 };

async function buildContext() {
  const db = getPool();
  const today = new Date().toISOString().split('T')[0];
  let ctx = `Today is ${today} (UK nursery: Your Nursery, Ealing).\n\n`;

  try {
    const { rows } = await db.query(
      `SELECT title, priority FROM tasks
       WHERE status IN ('open','in_progress') AND due_date <= $1
       ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END
       LIMIT 5`, [today]
    );
    if (rows.length) ctx += `TASKS DUE TODAY OR OVERDUE:\n${rows.map(r => `- ${r.title} [${r.priority}]`).join('\n')}\n\n`;
  } catch {}

  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM messages
       WHERE is_read = false AND sender_type = 'parent' AND created_at > now() - interval '24h'`
    );
    if (rows[0]?.n > 0) ctx += `UNREAD PARENT MESSAGES (last 24h): ${rows[0].n}\n\n`;
  } catch {}

  try {
    const { rows } = await db.query(
      `SELECT title, next_due FROM compliance_events
       WHERE is_active = true AND next_due <= CURRENT_DATE + interval '7 days'
       ORDER BY next_due ASC LIMIT 3`
    );
    if (rows.length) ctx += `COMPLIANCE DUE THIS WEEK:\n${rows.map(r => `- ${r.title}: ${r.next_due}`).join('\n')}\n\n`;
  } catch {}

  try {
    const { rows } = await db.query(
      `SELECT COUNT(DISTINCT staff_id) AS n FROM staff_clock_events WHERE DATE(clock_in) = $1`, [today]
    );
    ctx += `STAFF CLOCKED IN TODAY: ${rows[0]?.n || 0}\n`;
  } catch {}

  return ctx;
}

async function generateBriefing() {
  const OLLAMA_HOST  = process.env.OLLAMA_HOST  || 'http://localhost:11434';
  const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:4b';

  const context = await buildContext();
  const prompt = `You are a helpful assistant for a nursery manager. Summarise this morning's situation concisely.

${context}

Respond ONLY with valid JSON in this exact format (no other text):
{"bullets":["bullet1","bullet2","bullet3","bullet4","bullet5"],"priority":"one sentence on what to focus on first"}

Rules: 5 bullets, UK English, direct, practical. No preamble. No markdown.`;

  const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false, think: false,
      options: { temperature: 0.3, num_predict: 500 },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
  const data = await resp.json();
  const raw = data.message?.content || '';

  // Strip <think>…</think> tags (qwen3 chain-of-thought)
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) return JSON.parse(jsonMatch[0]);

  // Fallback: extract bullet lines
  const lines = cleaned.split('\n').filter(l => /^[-•*\d]/.test(l.trim()));
  return {
    bullets: lines.slice(0, 5).map(l => l.replace(/^[-•*\d.\s]+/, '').trim()).filter(Boolean),
    priority: 'Review today\'s tasks and any pending communications.',
  };
}

// GET /api/daily-briefing
router.get('/', async (req, res) => {
  const refresh = req.query.refresh === '1';
  const now = Date.now();
  if (!refresh && cache.bullets.length && (now - cache.timestamp) < CACHE_TTL) {
    return res.json({ ...cache, cached: true });
  }
  try {
    const result = await generateBriefing();
    cache = { bullets: result.bullets || [], priority: result.priority || '', timestamp: now };
    res.json({ ...cache, cached: false });
  } catch (err) {
    console.error('daily briefing error:', err.message);
    if (cache.bullets.length) return res.json({ ...cache, cached: true, stale: true });
    res.status(503).json({ error: 'AI unavailable', bullets: [], priority: '' });
  }
});

module.exports = router;
