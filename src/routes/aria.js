const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const VAPI_KEY = process.env.VAPI_API_KEY;
const VAPI_BASE = 'https://api.vapi.ai';
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

// 30s in-memory cache
let callsCache = null;
let cacheAt = 0;

async function vapiGet(path) {
  if (!VAPI_KEY) return null;
  try {
    const r = await fetch(`${VAPI_BASE}${path}`, {
      headers: { Authorization: `Bearer ${VAPI_KEY}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return null;
    return r.json();
  } catch(e) {
    console.error('vapi API error:', e.message);
    return null;
  }
}

function mapVapiCall(c) {
  let outcome = 'completed';
  const reason = c.endedReason || '';
  if (reason.includes('transfer')) outcome = 'transferred';
  else if (reason.includes('voicemail') || reason.includes('vm')) outcome = 'voicemail';
  else if (reason.includes('silence') || reason.includes('abandon') || reason.includes('hang') || reason.includes('no-answer')) outcome = 'missed';
  else if (reason.includes('error')) outcome = 'error';

  const dur = c.duration || (c.endedAt && c.startedAt
    ? Math.round((new Date(c.endedAt) - new Date(c.startedAt)) / 1000)
    : 0);

  return {
    id: c.id,
    started_at: c.startedAt || c.createdAt,
    ended_at: c.endedAt || null,
    duration_seconds: dur,
    from_number: c.customer?.number || null,
    to_number: c.phoneNumber?.number || null,
    outcome,
    ended_reason: c.endedReason || null,
    transcript: c.transcript || null,
    summary: c.analysis?.summary || null,
    urgency: c.analysis?.structuredData?.urgency || null,
    recording_url: c.recordingUrl || null,
    source: 'vapi'
  };
}

router.use(authenticate);

// GET /api/aria/stats
router.get('/stats', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE started_at >= CURRENT_DATE) AS today,
        COUNT(*) FILTER (WHERE started_at >= date_trunc('week', CURRENT_DATE)) AS this_week,
        COUNT(*) FILTER (WHERE started_at >= date_trunc('month', CURRENT_DATE)) AS this_month,
        COALESCE(ROUND(AVG(duration_seconds) FILTER (
          WHERE duration_seconds > 0 AND started_at >= CURRENT_DATE - INTERVAL '30 days'
        )), 0) AS avg_duration_secs,
        COUNT(*) FILTER (WHERE outcome = 'transferred' AND started_at >= date_trunc('week', CURRENT_DATE)) AS transferred_week,
        COUNT(*) FILTER (WHERE outcome != 'error' AND started_at >= date_trunc('week', CURRENT_DATE)) AS total_week
      FROM ladn.vapi_calls
    `);
    const r = rows[0];
    res.json({
      today: parseInt(r.today) || 0,
      this_week: parseInt(r.this_week) || 0,
      this_month: parseInt(r.this_month) || 0,
      avg_duration_secs: parseInt(r.avg_duration_secs) || 0,
      transfer_rate: parseInt(r.total_week) > 0
        ? Math.round((parseInt(r.transferred_week) / parseInt(r.total_week)) * 100)
        : 0
    });
  } catch (err) {
    console.error('aria stats error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/aria/calls?limit=50
router.get('/calls', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const now = Date.now();

  if (callsCache && (now - cacheAt) < 30000) {
    return res.json(callsCache.slice(0, limit));
  }

  const db = getPool();
  try {
    let mapped = null;

    if (VAPI_KEY) {
      const qs = VAPI_ASSISTANT_ID
        ? `/call?limit=${limit}&assistantId=${VAPI_ASSISTANT_ID}`
        : `/call?limit=${limit}`;
      const calls = await vapiGet(qs);
      if (calls && Array.isArray(calls)) {
        mapped = calls.map(mapVapiCall);
      }
    }

    if (mapped) {
      callsCache = mapped;
      cacheAt = now;
      return res.json(mapped);
    }

    // Fall back to local DB
    const { rows } = await db.query(
      `SELECT id, started_at, ended_at, duration_seconds, from_number, to_number,
              outcome, ended_reason, summary, urgency, reviewed_at,
              'local' AS source
       FROM ladn.vapi_calls
       ORDER BY started_at DESC LIMIT $1`,
      [limit]
    );
    callsCache = rows;
    cacheAt = now;
    res.json(rows);
  } catch (err) {
    console.error('aria calls error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/aria/call/:id
router.get('/call/:id', async (req, res) => {
  const id = req.params.id;

  if (VAPI_KEY) {
    const call = await vapiGet(`/call/${encodeURIComponent(id)}`);
    if (call) return res.json(mapVapiCall(call));
  }

  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT vc.*, s.first_name || ' ' || s.last_name AS reviewed_by_name
       FROM ladn.vapi_calls vc LEFT JOIN ladn.staff s ON s.id = vc.reviewed_by
       WHERE vc.id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ...rows[0], source: 'local' });
  } catch (err) {
    console.error('aria call error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/aria/call/:id/recording — redirects to signed recording URL
router.get('/call/:id/recording', async (req, res) => {
  const id = req.params.id;

  if (VAPI_KEY) {
    const call = await vapiGet(`/call/${encodeURIComponent(id)}`);
    if (call?.recordingUrl) return res.redirect(call.recordingUrl);
  }

  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT raw FROM ladn.vapi_calls WHERE id = $1`, [id]);
    const url = rows[0]?.raw?.recordingUrl
      || rows[0]?.raw?.message?.call?.recordingUrl
      || rows[0]?.raw?.artifact?.recordingUrl;
    if (url) return res.redirect(url);
  } catch(e) {}

  res.status(404).json({ error: 'Recording not available' });
});

module.exports = router;
