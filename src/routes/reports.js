const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:4b';

// GET /
router.get('/', async (req, res) => {
  const { child_id } = req.query;
  try {
    const db = getPool();
    const params = child_id ? [child_id] : [];
    const { rows } = await db.query(`
      SELECT r.*, c.first_name || ' ' || c.last_name as child_name,
             s.first_name || ' ' || s.last_name as staff_name
      FROM reports r
      LEFT JOIN children c ON c.id = r.child_id
      LEFT JOIN staff s ON s.id = r.staff_id
      ${child_id ? 'WHERE r.child_id=$1' : ''}
      ORDER BY r.created_at DESC LIMIT 100
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /email-log — must be before /:id to avoid route shadowing
router.get('/email-log', authenticate, async (req, res) => {
  try {
    const db = getLadnPool();
    const { rows } = await db.query(`
      SELECT id, sender_name, sender_email, subject, email_body, body,
             draft_reply, sent_reply, decision_type as status,
             created_at, decided_at as decision_at
      FROM decision_log
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /:id
router.get('/:id', async (req, res) => {
  if (isNaN(Number(req.params.id))) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT r.*, c.first_name || ' ' || c.last_name as child_name
      FROM reports r LEFT JOIN children c ON c.id = r.child_id
      WHERE r.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /generate — AI-assisted report
router.post('/generate', async (req, res) => {
  const { child_id, report_type } = req.body;
  if (!child_id || !report_type) {
    return res.status(400).json({ error: 'child_id and report_type required' });
  }

  try {
    const db = getPool();
    // Gather child data
    const [childRes, obsRes, diaryRes, attendanceRes] = await Promise.all([
      db.query(`SELECT c.*, r.name as room_name,
        EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)) as age_months
        FROM children c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1`, [child_id]),
      db.query(`SELECT observation_text, eyfs_areas, created_at FROM observations
        WHERE child_id=$1 ORDER BY created_at DESC LIMIT 10`, [child_id]),
      db.query(`SELECT mood, meals, activities FROM daily_diary
        WHERE child_id=$1 AND date >= CURRENT_DATE - INTERVAL '14 days'
        ORDER BY date DESC LIMIT 7`, [child_id]),
      db.query(`SELECT COUNT(*) FILTER (WHERE NOT absent) as present,
        COUNT(*) FILTER (WHERE absent) as absent
        FROM attendance WHERE child_id=$1 AND date >= CURRENT_DATE - INTERVAL '30 days'`, [child_id])
    ]);

    if (!childRes.rows.length) return res.status(404).json({ error: 'Child not found' });
    const child = childRes.rows[0];
    const observations = obsRes.rows.map(o => o.observation_text).join('\n- ');
    const attendance = attendanceRes.rows[0];

    const prompt = `Write a ${report_type} report for ${child.first_name} ${child.last_name}, aged ${child.age_months} months, in ${child.room_name}.

Recent observations:
- ${observations || 'No recent observations'}

Attendance: ${attendance.present} days present, ${attendance.absent} days absent (last 30 days)

Write a professional, warm, Ofsted-ready report. Include: current stage of development, strengths, next steps. 3-4 paragraphs. Address to parents.`;

    const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false, think: false,
        options: { num_predict: 800 }
      }),
      signal: AbortSignal.timeout(60000)
    });

    let reportText = '';
    if (response.ok) {
      const data = await response.json();
      reportText = data.response || '';
    }

    // Save to DB
    const { rows } = await db.query(`
      INSERT INTO reports (child_id, staff_id, report_type, content, ai_generated)
      VALUES ($1,$2,$3,$4,true)
      RETURNING *
    `, [child_id, req.user.id, report_type, JSON.stringify({ text: reportText })]);

    res.status(201).json({ ...rows[0], generated_text: reportText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id/share
router.put('/:id/share', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE reports SET shared_with_parents=true WHERE id=$1 RETURNING *
    `, [req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Email / Messages inbox (reads from ladn_management decision_log) ──────────
const { Pool: LadnPool } = require('pg');

function getLadnPool() {
  if (!global._ladnPool) {
    global._ladnPool = new LadnPool({
      host: process.env.PG_HOST || 'localhost',
      port: 5433,
      database: 'ladn_management',
      user: process.env.LADN_PG_USER || 'ladn_user',
      password: process.env.LADN_PG_PASSWORD || '', // <redacted — set in .env, not committed>
    });
  }
  return global._ladnPool;
}

router.post('/send-reply', authenticate, async (req, res) => {
  const { id, use_draft, custom_text } = req.body;
  try {
    const db = getLadnPool();
    const { rows } = await db.query('SELECT * FROM decision_log WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const msg = rows[0];
    const replyText = custom_text || msg.draft_reply;
    if (!replyText) return res.status(400).json({ error: 'No reply text' });

    // Call n8n webhook to send the actual Gmail reply
    const n8nUrl = 'http://localhost:5678/webhook/send-email-reply';
    await fetch(n8nUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, reply_text: replyText, message_id: msg.message_id || msg.gmail_id })
    }).catch(() => {}); // fire and forget

    await db.query(
      'UPDATE decision_log SET decision_type=$1, sent_reply=$2, decided_at=NOW() WHERE id=$3',
      ['sent', replyText, id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/skip', authenticate, async (req, res) => {
  const { id } = req.body;
  try {
    const db = getLadnPool();
    await db.query('UPDATE decision_log SET decision_type=$1, decided_at=NOW() WHERE id=$2', ['skipped', id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
