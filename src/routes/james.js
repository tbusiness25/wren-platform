'use strict';

// James front‑desk module – summarises voicemails, missed calls, emails and enquiries.
// Mounted at /api/james (append‑only mount in editions/ladn/server‑unified.js).

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
router.use(authenticate);

// manager/room_leader only – copy pattern from admissions‑engine
const managerOnly = (req, res, next) => {
  if (!['manager', 'room_leader'].includes(req.user.role)) return res.status(403).json({ error: 'Manager access required' });
  next();
};

// Helper to run a query safely
async function query(sql, params = []) {
  const db = getPool();
  const { rows } = await db.query(sql, params);
  return rows;
}

// ---------------------------------------------------------------------------
// POST /sync – ingest recent items (idempotent)
// ---------------------------------------------------------------------------
router.post('/sync', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);

    // 1️⃣ Voicemails / missed calls from vapi_calls (outcome)
    const vapiRows = await db.query(
      `SELECT id, outcome, created_at, contact, transcript, summary, urgency
       FROM vapi_calls
       WHERE outcome IN ('voicemail','missed') AND created_at >= $1`,
      [thirtyDaysAgo]
    );
    for (const r of vapiRows.rows) {
      await db.query(
        `INSERT INTO ladn.frontdesk_items (kind, source_ref, happened_at, who, contact, gist, payload)
         VALUES ('voicemail', $1, $2, $3, $4, $5, $6)
         ON CONFLICT (kind, source_ref) DO NOTHING`,
        [r.id, r.created_at, r.contact, r.contact, r.summary || r.transcript, JSON.stringify({urgency: r.urgency})]
      );
    }

    // 2️⃣ Emails from email_triage (importance >=4, category='parent')
    const emailRows = await db.query(
      `SELECT id, who, contact, summary, importance, category, created_at
       FROM ladn.email_triage
       WHERE importance >= 4 AND category = 'parent' AND created_at >= $1`,
      [fourteenDaysAgo]
    );
    for (const r of emailRows.rows) {
      await db.query(
        `INSERT INTO ladn.frontdesk_items (kind, source_ref, happened_at, who, contact, gist)
         VALUES ('email', $1, $2, $3, $4, $5)
         ON CONFLICT (kind, source_ref) DO NOTHING`,
        [r.id, r.created_at, r.who, r.contact, r.summary]
      );
    }

    // 3️⃣ Enquiries (stage='new')
    const enquRows = await db.query(
      `SELECT id, who, contact, summary, created_at
       FROM ladn.enquiries
       WHERE stage = 'new' AND created_at >= $1`,
      [thirtyDaysAgo]
    );
    for (const r of enquRows.rows) {
      await db.query(
        `INSERT INTO ladn.frontdesk_items (kind, source_ref, happened_at, who, contact, gist)
         VALUES ('enquiry', $1, $2, $3, $4, $5)
         ON CONFLICT (kind, source_ref) DO NOTHING`,
        [r.id, r.created_at, r.who, r.contact, r.summary]
      );
    }

    const counts = await db.query(
      `SELECT kind, COUNT(*) AS cnt FROM ladn.frontdesk_items GROUP BY kind`
    );
    res.json({ inserted: true, counts: counts.rows });
  } catch (e) {
    console.error('[james/sync]', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /items – list items (filter by status)
// ---------------------------------------------------------------------------
router.get('/items', managerOnly, async (req, res) => {
  const status = req.query.status || 'open';
  const rows = await query(
    `SELECT * FROM ladn.frontdesk_items WHERE status = $1 ORDER BY happened_at DESC LIMIT 100`,
    [status]
  );
  const openCount = await query(`SELECT COUNT(*) FROM ladn.frontdesk_items WHERE status = 'open'`);
  const oldest = await query(`SELECT MIN(happened_at) AS oldest FROM ladn.frontdesk_items WHERE status = 'open'`);
  const oldestDays = oldest[0] && oldest[0].oldest ? Math.floor((new Date() - new Date(oldest[0].oldest)) / (1000 * 60 * 60 * 24)) : null;
  res.json({ items: rows, open_count: openCount[0].count, oldest_open_days: oldestDays });
});

// ---------------------------------------------------------------------------
// POST /items/:id/status – disposition
// ---------------------------------------------------------------------------
router.post('/items/:id/status', managerOnly, async (req, res) => {
  const { id } = req.params;
  const { status, snooze_until } = req.body;
  if (!['open','done','snoozed','ignored'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const sql = `UPDATE ladn.frontdesk_items SET status = $1, snooze_until = $2 WHERE id = $3 RETURNING *`;
  const rows = await query(sql, [status, snooze_until || null, id]);
  res.json(rows[0] || { error: 'Not found' });
});

// ---------------------------------------------------------------------------
// GET /briefing – generate James briefing (cached 30 min unless refresh=1)
// ---------------------------------------------------------------------------
let cachedBriefing = null;
let cachedAt = 0;

// Helper to run sync logic (same as POST /sync)
async function runSync() {
  try {
    const db = getPool();
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);
    // Voicemails / missed calls
    const vapiRows = await db.query(
      `SELECT id, outcome, created_at, contact, transcript, summary, urgency
       FROM vapi_calls
       WHERE outcome IN ('voicemail','missed') AND created_at >= $1`,
      [thirtyDaysAgo]
    );
    for (const r of vapiRows.rows) {
      await db.query(
        `INSERT INTO ladn.frontdesk_items (kind, source_ref, happened_at, who, contact, gist, payload)
         VALUES ('voicemail', $1, $2, $3, $4, $5, $6)
         ON CONFLICT (kind, source_ref) DO NOTHING`,
        [r.id, r.created_at, r.contact, r.contact, r.summary || r.transcript, JSON.stringify({ urgency: r.urgency })]
      );
    }
    // Emails
    const emailRows = await db.query(
      `SELECT id, who, contact, summary, importance, category, created_at
       FROM ladn.email_triage
       WHERE importance >= 4 AND category = 'parent' AND created_at >= $1`,
      [fourteenDaysAgo]
    );
    for (const r of emailRows.rows) {
      await db.query(
        `INSERT INTO ladn.frontdesk_items (kind, source_ref, happened_at, who, contact, gist)
         VALUES ('email', $1, $2, $3, $4, $5)
         ON CONFLICT (kind, source_ref) DO NOTHING`,
        [r.id, r.created_at, r.who, r.contact, r.summary]
      );
    }
    // Enquiries
    const enquRows = await db.query(
      `SELECT id, who, contact, summary, created_at
       FROM ladn.enquiries
       WHERE stage = 'new' AND created_at >= $1`,
      [thirtyDaysAgo]
    );
    for (const r of enquRows.rows) {
      await db.query(
        `INSERT INTO ladn.frontdesk_items (kind, source_ref, happened_at, who, contact, gist)
         VALUES ('enquiry', $1, $2, $3, $4, $5)
         ON CONFLICT (kind, source_ref) DO NOTHING`,
        [r.id, r.created_at, r.who, r.contact, r.summary]
      );
    }
    return true;
  } catch (e) {
    console.error('[james/runSync]', e);
    return false;
  }
}

router.get('/briefing', managerOnly, async (req, res) => {
  const refresh = req.query.refresh === '1';
  const now = Date.now();
  if (!refresh && cachedBriefing && now - cachedAt < 30 * 60 * 1000) {
    return res.json(cachedBriefing);
  }
  // If refresh requested, run sync ingestion first
  if (refresh) {
    const ok = await runSync();
    if (!ok) return res.status(500).json({ error: 'Sync failed' });
  }
  // Load up to 20 open items
  const items = await query(
    `SELECT * FROM ladn.frontdesk_items WHERE status = 'open' ORDER BY happened_at ASC LIMIT 20`
  );
  // Enrich with waitlist‑fit info where possible
  const enriched = [];
  for (const it of items) {
    let waitInfo = null;
    if (it.kind === 'voicemail' || it.kind === 'missed_call') {
      try {
        const resp = await fetch(`http://127.0.0.1:3015/api/waitlist-board/suggestions?contact=${encodeURIComponent(it.contact)}`);
        const data = await resp.json();
        if (data && data.matches && data.matches.length) waitInfo = data.matches[0];
      } catch (_) {}
    }
    enriched.push({ ...it, waitInfo });
  }
  // Build prompt for Ollama
  const prompt = `You are James, the calm front‑of‑house manager at Little Angels. Summarise for Toby in first person, warm, brief, zero corporate speak. For each item give one sentence of what it is, one concrete suggested next step, and where a reply makes sense, a ready‑to‑send draft (SMS‑length for calls, email tone for emails). If a caller looks like a waiting‑list fit, say so and why. Never invent facts not in the data. Items:\n${JSON.stringify(enriched, null, 2)}`;
  const ollamaRes = await fetch(process.env.OLLAMA_URL + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3.6:35b-a3b', prompt, stream: false, think: false })
  });
  const ollamaJson = await ollamaRes.json();
  let spoken = '';
  let parsedItems = [];
  try {
    const parsed = JSON.parse(ollamaJson.response);
    spoken = parsed.spoken?.trim() || '';
    parsedItems = parsed.items || [];
  } catch (_) {
    spoken = ollamaJson.response?.trim() || '';
    parsedItems = [];
  }
  // Persist suggestions/drafts back to DB for each parsed item
  for (const it of parsedItems) {
    if (!it.id) continue;
    await query(
      `UPDATE ladn.frontdesk_items SET suggestion = $1, draft_reply = $2 WHERE id = $3`,
      [it.suggest || null, it.draft_reply || null, it.id]
    );
  }
  const result = { spoken, items: parsedItems.length ? parsedItems : enriched };
  cachedBriefing = result;
  cachedAt = now;
  res.json(result);
});

// ---------------------------------------------------------------------------
// GET /stats – simple counts for cockpit card
// ---------------------------------------------------------------------------
router.get('/stats', managerOnly, async (req, res) => {
  const rows = await query(`SELECT kind, status, COUNT(*) AS cnt FROM ladn.frontdesk_items GROUP BY kind, status`);
  res.json({ stats: rows });
});

module.exports = router;
