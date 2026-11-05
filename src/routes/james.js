'use strict';

// James front‑desk module – summarises voicemails, missed calls, emails and enquiries.
// Mounted at /api/james (append‑only mount in editions/ladn/server‑unified.js).

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const ai = require('../lib/ai-models');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// ── b264: per-tenant, not LADN-only ──────────────────────────────────────────
// This module used to write `ladn.frontdesk_items` from whatever schema the process was
// connected to, so mounting it in any other edition would have read and written
// Your Nursery' production rows. The SQL is now unqualified and follows the pool's
// search_path (src/db/pool.js ← PG_SCHEMA), which is correct: the front-desk triage queue are
// a per-setting feature, not a shared one.
//
// `frontdesk_items` currently exists only in the ladn schema, because that is the only
// edition where this feature has been rolled out. Mounted elsewhere these routes
// will now 500 on a missing relation — which is the intended outcome. A loud error
// is the correct answer to "this edition has not got this feature yet"; silently
// serving another nursery's rows is not. To roll it out, add the table to that
// schema; do NOT re-qualify the SQL.
router.use(authenticate);

// manager/room_leader only – copy pattern from admissions‑engine
const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'admin', 'room_leader'])) return res.status(403).json({ error: 'Manager access required' });
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
        `INSERT INTO frontdesk_items (kind, source_ref, happened_at, who, contact, gist, payload)
         VALUES ('voicemail', $1, $2, $3, $4, $5, $6)
         ON CONFLICT (kind, source_ref) DO NOTHING`,
        [r.id, r.created_at, r.contact, r.contact, r.summary || r.transcript, JSON.stringify({urgency: r.urgency})]
      );
    }

    // 2️⃣ Emails from comms_email_queue (importance >=4, category='parent')
    // b338 (2026-09-17, decision 4): moved off the legacy email_triage table.
    // from_name/from_email/received_at stand in for who/contact/created_at —
    // there is no separate "who" field on the live table.
    // b486c (2026-10-13, CHECK.md defect 9): ALLOW-list, not a deny-list — see
    // src/lib/inbox-access.js's nonConfidentialMailboxAddresses() header comment.
    const _allowBoxes = await require('../lib/inbox-access').nonConfidentialMailboxAddresses(db);
    const emailRows = await db.query(
      `SELECT id, from_name AS who, from_email AS contact, summary, importance, category, received_at AS created_at
       FROM comms_email_queue
       WHERE importance >= 4 AND category = 'parent' AND received_at >= $1
         AND (mailbox IS NULL OR mailbox = ANY($2))`,
      [fourteenDaysAgo, _allowBoxes]
    );
    for (const r of emailRows.rows) {
      await db.query(
        `INSERT INTO frontdesk_items (kind, source_ref, happened_at, who, contact, gist)
         VALUES ('email', $1, $2, $3, $4, $5)
         ON CONFLICT (kind, source_ref) DO NOTHING`,
        [r.id, r.created_at, r.who, r.contact, r.summary]
      );
    }

    // 3️⃣ Enquiries (stage='new')
    const enquRows = await db.query(
      `SELECT id, who, contact, summary, created_at
       FROM enquiries
       WHERE stage = 'new' AND created_at >= $1`,
      [thirtyDaysAgo]
    );
    for (const r of enquRows.rows) {
      await db.query(
        `INSERT INTO frontdesk_items (kind, source_ref, happened_at, who, contact, gist)
         VALUES ('enquiry', $1, $2, $3, $4, $5)
         ON CONFLICT (kind, source_ref) DO NOTHING`,
        [r.id, r.created_at, r.who, r.contact, r.summary]
      );
    }

    const counts = await db.query(
      `SELECT kind, COUNT(*) AS cnt FROM frontdesk_items GROUP BY kind`
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
    `SELECT * FROM frontdesk_items WHERE status = $1 ORDER BY happened_at DESC LIMIT 100`,
    [status]
  );
  const openCount = await query(`SELECT COUNT(*) FROM frontdesk_items WHERE status = 'open'`);
  const oldest = await query(`SELECT MIN(happened_at) AS oldest FROM frontdesk_items WHERE status = 'open'`);
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
  const sql = `UPDATE frontdesk_items SET status = $1, snooze_until = $2 WHERE id = $3 RETURNING *`;
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
        `INSERT INTO frontdesk_items (kind, source_ref, happened_at, who, contact, gist, payload)
         VALUES ('voicemail', $1, $2, $3, $4, $5, $6)
         ON CONFLICT (kind, source_ref) DO NOTHING`,
        [r.id, r.created_at, r.contact, r.contact, r.summary || r.transcript, JSON.stringify({ urgency: r.urgency })]
      );
    }
    // Emails — b338 (2026-09-17, decision 4): moved off legacy email_triage.
    // b486c (2026-10-13, defect 9): ALLOW-list, not a deny-list — see
    // src/lib/inbox-access.js's nonConfidentialMailboxAddresses() header comment.
    const _allowBoxes = await require('../lib/inbox-access').nonConfidentialMailboxAddresses(db);
    const emailRows = await db.query(
      `SELECT id, from_name AS who, from_email AS contact, summary, importance, category, received_at AS created_at
       FROM comms_email_queue
       WHERE importance >= 4 AND category = 'parent' AND received_at >= $1
         AND (mailbox IS NULL OR mailbox = ANY($2))`,
      [fourteenDaysAgo, _allowBoxes]
    );
    for (const r of emailRows.rows) {
      await db.query(
        `INSERT INTO frontdesk_items (kind, source_ref, happened_at, who, contact, gist)
         VALUES ('email', $1, $2, $3, $4, $5)
         ON CONFLICT (kind, source_ref) DO NOTHING`,
        [r.id, r.created_at, r.who, r.contact, r.summary]
      );
    }
    // Enquiries
    const enquRows = await db.query(
      `SELECT id, who, contact, summary, created_at
       FROM enquiries
       WHERE stage = 'new' AND created_at >= $1`,
      [thirtyDaysAgo]
    );
    for (const r of enquRows.rows) {
      await db.query(
        `INSERT INTO frontdesk_items (kind, source_ref, happened_at, who, contact, gist)
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
    `SELECT * FROM frontdesk_items WHERE status = 'open' ORDER BY happened_at ASC LIMIT 20`
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
  const prompt = `You are James, the calm front‑of‑house manager at Your Nursery. Summarise for Toby in first person, warm, brief, zero corporate speak. For each item give one sentence of what it is, one concrete suggested next step, and where a reply makes sense, a ready‑to‑send draft (SMS‑length for calls, email tone for emails). If a caller looks like a waiting‑list fit, say so and why. Never invent facts not in the data. Items:\n${JSON.stringify(enriched, null, 2)}`;
  // Summarising the front-desk queue → ai-models.js role 'heavy', resolved per call.
  // (b333: was a hard-coded qwen3.6:35b-a3b, no longer installed.)
  const ollamaRes = await fetch(ai.host() + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ai.model('heavy'), prompt, stream: false, think: false })
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
      `UPDATE frontdesk_items SET suggestion = $1, draft_reply = $2 WHERE id = $3`,
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
  const rows = await query(`SELECT kind, status, COUNT(*) AS cnt FROM frontdesk_items GROUP BY kind, status`);
  res.json({ stats: rows });
});

module.exports = router;
