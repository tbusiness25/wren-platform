// Admin API routes for notification schedule preferences and queue status
// Mounted at /api/admin/notification-prefs (etc.) in server-unified.js
'use strict';

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

// All routes require manager role
const managerGuard = requireRole('manager', 'deputy_manager');

// GET /api/admin/notification-prefs — list all schedule prefs
router.get('/notification-prefs', ...managerGuard, async (req, res) => {
  try {
    const db = getPool();
    const r  = await db.query(
      `SELECT id, channel, event_type, enabled, respect_working_hours, respect_away_mode, updated_at
       FROM notification_schedule_prefs
       ORDER BY channel, event_type`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/notification-prefs — upsert a schedule pref
router.post('/notification-prefs', ...managerGuard, async (req, res) => {
  const { event_type, channel, enabled, respect_working_hours, respect_away_mode } = req.body;
  if (!event_type || !channel) return res.status(400).json({ error: 'event_type and channel required' });
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO notification_schedule_prefs
         (channel, event_type, enabled, respect_working_hours, respect_away_mode, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (channel, event_type) DO UPDATE SET
         enabled               = EXCLUDED.enabled,
         respect_working_hours = EXCLUDED.respect_working_hours,
         respect_away_mode     = EXCLUDED.respect_away_mode,
         updated_at            = now()`,
      [
        channel,
        event_type,
        enabled             !== undefined ? Boolean(enabled)               : true,
        respect_working_hours !== undefined ? Boolean(respect_working_hours) : false,
        respect_away_mode   !== undefined ? Boolean(respect_away_mode)     : false,
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/notification-queue-status — pending count + last summary
router.get('/notification-queue-status', ...managerGuard, async (req, res) => {
  try {
    const db = getPool();
    const [queueRes, summaryRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM notification_queue WHERE sent_at IS NULL AND suppressed_at IS NULL`),
      db.query(`SELECT sent_at, items_count FROM daily_summary_log ORDER BY sent_at DESC LIMIT 1`),
    ]);
    const pending     = parseInt(queueRes.rows[0].count, 10);
    const lastSummary = summaryRes.rows.length > 0
      ? new Date(summaryRes.rows[0].sent_at).toLocaleString('en-GB', { timeZone: 'Europe/London' })
      : 'Never';
    const lastSummaryItems = summaryRes.rows[0]?.items_count ?? null;
    res.json({ pending, last_summary: lastSummary, last_summary_items: lastSummaryItems });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/notification-drain-now — manually trigger queue drain (for testing)
router.post('/notification-drain-now', ...managerGuard, async (req, res) => {
  try {
    const { drainQueue } = require('../jobs/notification-queue-drain');
    await drainQueue();
    res.json({ ok: true, message: 'Queue drain triggered' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/notification-summary-now — manually trigger daily summary (for testing)
router.post('/notification-summary-now', ...managerGuard, async (req, res) => {
  try {
    const { sendDailySummary } = require('../jobs/daily-summary-email');
    const result = await sendDailySummary();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
