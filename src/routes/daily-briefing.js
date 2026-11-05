const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { getUpcomingEvents } = require('../services/staff-celebrations');
const ai = require('../lib/ai-models');

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
      // b310 — this said DATE(clock_in). There is no clock_in column on
      // staff_clock_events (it has event_type + event_time), so the query threw
      // every morning and the swallowing `catch {}` above meant the line simply
      // never appeared in the briefing. Now it counts today's live clock-INs.
      `SELECT COUNT(DISTINCT staff_id)::int AS n
         FROM staff_clock_events_current
        WHERE event_type = 'clock_in'
          AND (event_time AT TIME ZONE 'Europe/London')::date = $1::date`, [today]
    );
    ctx += `STAFF CLOCKED IN TODAY: ${rows[0]?.n || 0}\n`;
  } catch {}

  try {
    const events = await getUpcomingEvents(7);
    if (events.length) {
      ctx += `\nUPCOMING STAFF OCCASIONS (next 7 days):\n${events.map(e =>
        `- ${e.title} — ${e.date}${e.voucher_amount != null ? ` (£${e.voucher_amount} voucher)` : ''}`
      ).join('\n')}\n`;
    }
  } catch {}

  return ctx;
}

async function generateBriefing() {
  // b333: model + host from ai-models.js (role 'fast' — five short bullets).
  const context = await buildContext();
  const prompt = `You are a helpful assistant for a nursery manager. Summarise this morning's situation concisely.

${context}

Respond ONLY with valid JSON in this exact format (no other text):
{"bullets":["bullet1","bullet2","bullet3","bullet4","bullet5"],"priority":"one sentence on what to focus on first"}

Rules: 5 bullets, UK English, direct, practical. No preamble. No markdown.`;

  const resp = await fetch(`${ai.host()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ai.model('fast'),
      messages: [{ role: 'user', content: prompt }],
      stream: false, think: false,
      options: ai.options({ temperature: 0.3, num_predict: 500 }),
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
