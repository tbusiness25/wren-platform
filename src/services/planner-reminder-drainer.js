'use strict';
/*
 * Planner Reminder Drainer (build 73e, 2026-07-09)
 *
 * Every 5 minutes: find confirmed planner_events whose reminder window has
 * opened (starts_at - reminder_minutes < now) and that haven't been reminded,
 * ping Toby on Telegram, and stamp reminded_at. Plus a 07:45 daily
 * "today at a glance" message built from the same data as /api/planner/today.
 *
 * EVERY Telegram send is gated behind PLANNER_TELEGRAM === 'on' — anywhere
 * else (the dev container especially) it logs "[planner-reminders] would
 * send: ..." instead, so dev can never ping the live bot.
 *
 * Usage (server-unified.js):
 *   require('../../src/services/planner-reminder-drainer').startPlannerReminderDrainer();
 */

const { getPool } = require('../db/pool');

const INTERVAL_MS = (parseInt(process.env.PLANNER_REMINDER_INTERVAL) || 300) * 1000; // 5 min
const LIVE = () => process.env.PLANNER_TELEGRAM === 'on';

async function sendTelegram(text) {
  if (!LIVE()) {
    console.log('[planner-reminders] would send:', text.replace(/\n/g, ' | '));
    return true;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('[planner-reminders] TELEGRAM_BOT_TOKEN/CHAT_ID not set — cannot send');
    return false;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch (e) {
    console.error('[planner-reminders] telegram send failed:', e.message);
    return false;
  }
}

async function drainReminders() {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id, title, starts_at, location, reminder_minutes FROM planner_events
       WHERE status='confirmed' AND reminded_at IS NULL
         AND starts_at - (reminder_minutes * interval '1 minute') < now()
         AND starts_at > now() - interval '2 hours'
       ORDER BY starts_at`);
    for (const ev of rows) {
      const mins = Math.max(0, Math.round((new Date(ev.starts_at) - Date.now()) / 60000));
      const when = new Date(ev.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
      const ok = await sendTelegram(`⏰ in ${mins} min: ${ev.title} (${when}${ev.location ? ', ' + ev.location : ''})`);
      if (ok) await db.query(`UPDATE planner_events SET reminded_at=now() WHERE id=$1`, [ev.id]);
    }
  } catch (e) {
    console.error('[planner-reminders] drain error:', e.message);
  }
}

let _lastGlanceDate = null;
async function dailyGlance() {
  // Fire once per day in the 07:45–07:59 London window.
  const now = new Date();
  const london = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const today = london.toISOString ? london.toISOString().split('T')[0] : String(london);
  if (_lastGlanceDate === today) return;
  if (london.getHours() !== 7 || london.getMinutes() < 45) return;
  _lastGlanceDate = today;

  const db = getPool();
  try {
    const [{ rows: events }, { rows: todos }] = await Promise.all([
      db.query(`SELECT title, starts_at, all_day, location FROM planner_events
                WHERE starts_at::date = CURRENT_DATE AND status IN ('confirmed','proposed') ORDER BY starts_at`),
      db.query(`SELECT title, due_date FROM planner_todos
                WHERE status='open' ORDER BY (due_date < CURRENT_DATE) DESC, priority, due_date NULLS LAST LIMIT 5`),
    ]);
    if (!events.length && !todos.length) return;
    const evLines = events.map(e => `• ${e.all_day ? 'all day' : new Date(e.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })} — ${e.title}${e.location ? ' (' + e.location + ')' : ''}`);
    const tdLines = todos.map(t => `☐ ${t.title}${t.due_date ? ' (due ' + new Date(t.due_date).toLocaleDateString('en-GB') + ')' : ''}`);
    await sendTelegram(`🗓️ Today at a glance\n${evLines.join('\n') || '(no events)'}\n\nTop todos:\n${tdLines.join('\n') || '(none)'}`);
  } catch (e) {
    console.error('[planner-reminders] glance error:', e.message);
  }
}

function startPlannerReminderDrainer() {
  if (process.env.PLANNER_REMINDER_DISABLED) {
    console.log('[planner-reminders] disabled by env');
    return;
  }
  console.log(`[planner-reminders] started (every ${INTERVAL_MS / 1000}s, telegram ${LIVE() ? 'LIVE' : 'dry-run'})`);
  setInterval(() => { drainReminders(); dailyGlance(); }, INTERVAL_MS);
  setTimeout(() => { drainReminders(); }, 20000); // first pass shortly after boot
}

module.exports = { startPlannerReminderDrainer };
