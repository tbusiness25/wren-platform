// Toby's planner (build 73, rebuilt 2026-07-09) — ADHD-first personal planner for
// the manager. Backed by ladn.planner_events + ladn.planner_todos (NOT the
// parent-facing `events` table and NOT the task-reminder `tasks` table — the
// first draft of this route wrote to both by mistake).
'use strict';
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { getPool } = require('../db/pool');

const OLLAMA_URL = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://ollama:11434';
const MODEL_FAST = process.env.AI_MODEL_FAST || 'qwen3.6:35b-a3b';

// Manager-level only — this is the manager's personal planner.
router.use((req, res, next) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-wren-token'] || '';
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  const role = String(req.user.role || '').toLowerCase();
  if (!['manager', 'deputy', 'deputy_manager', 'headteacher', 'admin'].includes(role)) {
    return res.status(403).json({ error: 'Manager only' });
  }
  next();
});

async function ollamaGenerate(prompt, timeoutMs = 60000) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL_FAST, prompt, stream: false, think: false, options: { temperature: 0.2 } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return String(data.response || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// The AI returns naive local timestamps ("2026-07-14T16:00:00"). Stored as-is a
// timestamptz column reads them as UTC and "4pm" renders as 5pm in London.
// Append the current Europe/London offset when none is present.
function londonize(ts) {
  if (!ts || /Z$|[+-]\d{2}:?\d{2}$/.test(ts)) return ts;
  const jan = new Date(new Date().getFullYear(), 0, 1).getTimezoneOffset();
  const isBST = (d => {
    const utc = new Date(d + 'Z');
    return new Date(utc.toLocaleString('en-US', { timeZone: 'Europe/London' })).getTime() - utc.getTime() > 30 * 60000;
  })(ts);
  return ts + (isBST ? '+01:00' : '+00:00');
}

const EVENT_STATUSES = ['proposed', 'confirmed', 'cancelled', 'done'];
const TODO_STATUSES = ['open', 'done', 'dropped'];

// ── Events CRUD ───────────────────────────────────────────────────────────────
router.get('/events', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM planner_events
       WHERE status <> 'cancelled' AND starts_at >= now() - interval '7 days'
       ORDER BY starts_at LIMIT 200`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/events', async (req, res) => {
  const { title, starts_at, ends_at, all_day, location, notes, status, reminder_minutes } = req.body || {};
  if (!title || !starts_at) return res.status(400).json({ error: 'title and starts_at required' });
  if (status && !EVENT_STATUSES.includes(status)) return res.status(400).json({ error: 'bad status' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO planner_events (title, starts_at, ends_at, all_day, location, notes, status, reminder_minutes, source)
       VALUES ($1,$2,$3,coalesce($4,false),$5,$6,coalesce($7,'confirmed'),coalesce($8,60),'manual') RETURNING *`,
      [title, starts_at, ends_at || null, all_day, location || null, notes || null, status, reminder_minutes]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/events/:id', async (req, res) => {
  const allowed = ['title', 'starts_at', 'ends_at', 'all_day', 'location', 'notes', 'status', 'reminder_minutes'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (k in (req.body || {})) {
      if (k === 'status' && !EVENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'bad status' });
      vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  try {
    const { rows } = await getPool().query(
      `UPDATE planner_events SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/events/:id', async (req, res) => {
  try {
    const { rowCount } = await getPool().query(`DELETE FROM planner_events WHERE id=$1`, [req.params.id]);
    res.json({ ok: rowCount > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Todos CRUD ────────────────────────────────────────────────────────────────
router.get('/todos', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM planner_todos WHERE status='open' ORDER BY priority, due_date NULLS LAST, id LIMIT 200`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/todos', async (req, res) => {
  const { title, due_date, priority, notes } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO planner_todos (title, due_date, priority, notes, source)
       VALUES ($1,$2,coalesce($3,3),$4,'manual') RETURNING *`,
      [title, due_date || null, priority, notes || null]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/todos/:id', async (req, res) => {
  const allowed = ['title', 'due_date', 'priority', 'notes', 'status'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (k in (req.body || {})) {
      if (k === 'status' && !TODO_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'bad status' });
      vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  try {
    const { rows } = await getPool().query(
      `UPDATE planner_todos SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/todos/:id', async (req, res) => {
  try {
    const { rowCount } = await getPool().query(`DELETE FROM planner_todos WHERE id=$1`, [req.params.id]);
    res.json({ ok: rowCount > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /week?start=YYYY-MM-DD ────────────────────────────────────────────────
router.get('/week', async (req, res) => {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.start || '')) ? req.query.start : null;
  try {
    const db = getPool();
    const { rows: anchor } = await db.query(
      `SELECT date_trunc('week', coalesce($1::date, CURRENT_DATE))::date AS monday`, [start]);
    const monday = anchor[0].monday;
    const [events, todos, overdue] = await Promise.all([
      db.query(
        `SELECT * FROM planner_events
         WHERE starts_at >= $1::date AND starts_at < $1::date + interval '7 days' AND status <> 'cancelled'
         ORDER BY starts_at`, [monday]),
      db.query(
        `SELECT * FROM planner_todos
         WHERE status='open' AND due_date >= $1::date AND due_date < $1::date + interval '7 days'
         ORDER BY due_date, priority`, [monday]),
      db.query(
        `SELECT * FROM planner_todos WHERE status='open' AND due_date < CURRENT_DATE ORDER BY due_date`),
    ]);
    res.json({ week_start: monday, events: events.rows, todos: todos.rows, overdue: overdue.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /reminders/pending — used by the reminder drainer ─────────────────────
router.get('/reminders/pending', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, title, starts_at, location, reminder_minutes FROM planner_events
       WHERE status='confirmed' AND reminded_at IS NULL
         AND starts_at - (reminder_minutes * interval '1 minute') < now()
         AND starts_at > now() - interval '2 hours'
       ORDER BY starts_at`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /quick-add {text} — natural language → event or todo ────────────────
router.post('/quick-add', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const db = getPool();
  const today = new Date().toISOString().split('T')[0];
  let parsed = null;
  try {
    const resp = await ollamaGenerate(
`Parse this into planner JSON. Today is ${today} (Europe/London). If it has a date or time it is an "event", otherwise a "todo".
Return ONLY JSON, one of:
{"type":"event","title":"...","starts_at":"YYYY-MM-DDTHH:MM:00","ends_at":null,"all_day":false,"location":null}
{"type":"todo","title":"...","due_date":"YYYY-MM-DD or null","priority":3}
Text: "${String(text).slice(0, 300)}"`);
    const m = resp.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch (e) {
    console.error('[planner/quick-add] AI parse failed, falling back to todo:', e.message);
  }
  try {
    if (parsed && parsed.type === 'event' && parsed.starts_at) {
      const { rows } = await db.query(
        `INSERT INTO planner_events (title, starts_at, ends_at, all_day, location, source, status)
         VALUES ($1,$2,$3,coalesce($4,false),$5,'ai','confirmed') RETURNING *`,
        [parsed.title || text, londonize(parsed.starts_at), londonize(parsed.ends_at) || null, parsed.all_day, parsed.location || null]);
      return res.status(201).json({ ok: true, kind: 'event', item: rows[0] });
    }
    const { rows } = await db.query(
      `INSERT INTO planner_todos (title, due_date, priority, source)
       VALUES ($1,$2,coalesce($3,3),'ai') RETURNING *`,
      [(parsed && parsed.title) || text, (parsed && parsed.due_date) || null, parsed && parsed.priority]);
    return res.status(201).json({ ok: true, kind: 'todo', item: rows[0] });
  } catch (e) {
    console.error('[planner/quick-add]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /today — today's events + top todos + AI plan (15-min cache) ─────────
let todayCache = { ts: 0, data: null };
router.get('/today', async (req, res) => {
  const db = getPool();
  try {
    const [{ rows: events }, { rows: todos }] = await Promise.all([
      db.query(`SELECT id, title, starts_at, ends_at, all_day, location FROM planner_events
                WHERE starts_at::date = CURRENT_DATE AND status IN ('confirmed','proposed') ORDER BY starts_at`),
      db.query(`SELECT id, title, due_date, priority FROM planner_todos
                WHERE status='open' ORDER BY (due_date < CURRENT_DATE) DESC, priority, due_date NULLS LAST LIMIT 5`),
    ]);
    let plan = todayCache.data;
    if (Date.now() - todayCache.ts > 15 * 60 * 1000) {
      try {
        plan = await ollamaGenerate(
`You are helping a busy, ADHD nursery manager plan today. Be brief and concrete — a short ordered list with times, nothing else. No preamble.
Today's events: ${JSON.stringify(events)}
Top todos: ${JSON.stringify(todos)}`);
        todayCache = { ts: Date.now(), data: plan };
      } catch (aiErr) {
        plan = null; // page still renders events/todos without the AI plan
      }
    }
    res.json({ date: new Date().toISOString().split('T')[0], events, todos, plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /extract-from-emails — propose events from the triaged inbox ─────────
router.post('/extract-from-emails', async (req, res) => {
  const db = getPool();
  try {
    const { rows: emails } = await db.query(
      `SELECT id, subject, coalesce(nullif(summary,''), body_preview, '') AS gist
       FROM email_triage
       WHERE received_at >= CURRENT_DATE - interval '14 days'
         AND coalesce(importance,0) >= 3
         AND coalesce(category,'') NOT IN ('spam','newsletter','transactional')
       ORDER BY received_at DESC LIMIT 25`);
    if (!emails.length) return res.json({ ok: true, extracted: [] });
    const resp = await ollamaGenerate(
`Extract calendar events (visits, deadlines, meetings, deliveries with a date) from these email snippets. Today is ${new Date().toISOString().split('T')[0]}.
Return ONLY a JSON array (may be empty): [{"email_id":123,"title":"...","starts_at":"YYYY-MM-DDTHH:MM:00","location":null}]
Only include items with a real, future date. Emails:
${emails.map(e => `#${e.id} ${e.subject}: ${e.gist.slice(0, 200)}`).join('\n')}`, 120000);
    let candidates = [];
    try { const m = resp.match(/\[[\s\S]*\]/); candidates = m ? JSON.parse(m[0]) : []; } catch { candidates = []; }
    const inserted = [];
    for (const ev of candidates) {
      if (!ev.title || !ev.starts_at) continue;
      const ref = `email-${ev.email_id || 'x'}`;
      // Dedupe on source_ref so re-running extraction doesn't duplicate proposals.
      const { rows: dup } = await db.query(
        `SELECT 1 FROM planner_events WHERE source='email' AND source_ref=$1 AND title=$2`, [ref, ev.title]);
      if (dup.length) continue;
      const { rows } = await db.query(
        `INSERT INTO planner_events (title, starts_at, location, source, source_ref, status)
         VALUES ($1,$2,$3,'email',$4,'proposed') RETURNING *`,
        [ev.title, londonize(ev.starts_at), ev.location || null, ref]);
      inserted.push(rows[0]);
    }
    res.json({ ok: true, extracted: inserted });
  } catch (e) {
    console.error('[planner/extract]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
