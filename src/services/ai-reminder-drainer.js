'use strict';
/*
 * AI Reminder Drainer (b151) — mirrors task-reminder-drainer.js's in-process
 * setInterval pattern, but for ladn.ai_reminders (chat "remind me to..."):
 * fires ONCE at due_at (not a repeated nag), then either marks it fired or
 * rolls due_at forward to the next occurrence if recurring.
 *
 * Usage:
 *   const { startAiReminderDrainer } = require('./services/ai-reminder-drainer');
 *   startAiReminderDrainer();   // default interval=30s
 *
 * Envs (optional):
 *   AI_REMINDER_INTERVAL  — interval in seconds (default 30)
 *   AI_REMINDER_DISABLED  — truthy to skip starting at all
 */

const { getPool } = require('../db/pool');
const { notifyAsync } = require('./notification-dispatcher');
const { nextOccurrence } = require('../lib/reminder-nlp');

function startAiReminderDrainer({ interval = 30 } = {}) {
  const INTERVAL = (parseInt(process.env.AI_REMINDER_INTERVAL) || interval) * 1000;

  if (process.env.AI_REMINDER_DISABLED) {
    console.log('[ai-reminder] disabled by env');
    return;
  }

  let _running = false;

  async function drainOnce() {
    if (_running) return;
    _running = true;
    const db = getPool();
    try {
      const { rows: due } = await db.query(`
        SELECT id, staff_id, task_text, due_at, recurrence
        FROM ai_reminders
        WHERE status='pending' AND due_at <= NOW()
        ORDER BY due_at ASC
        LIMIT 50
      `);
      if (!due.length) return;

      for (const r of due) {
        const title = `Reminder: ${r.task_text}`;
        const body = `You asked Wren to remind you: "${r.task_text}"`;
        try {
          await notifyAsync('ai_reminder', 'staff', r.staff_id, title, body, {
            priority: 'normal', relatedTable: 'ai_reminders', relatedId: r.id,
          });
        } catch (e) {
          console.error(`[ai-reminder] notify failed for #${r.id}:`, e.message);
        }

        const firedAt = new Date();
        if (r.recurrence && r.recurrence !== 'none') {
          const next = nextOccurrence(firedAt, r.recurrence);
          await db.query(
            `UPDATE ai_reminders SET due_at=$2, last_fired_at=$3, updated_at=NOW() WHERE id=$1`,
            [r.id, next, firedAt]
          ).catch(e => console.error(`[ai-reminder] reschedule failed for #${r.id}:`, e.message));
          console.log(`[ai-reminder] fired #${r.id} "${r.task_text}" → staff=${r.staff_id}, rescheduled ${r.recurrence} → ${next.toISOString()}`);
        } else {
          await db.query(
            `UPDATE ai_reminders SET status='fired', last_fired_at=$2, updated_at=NOW() WHERE id=$1`,
            [r.id, firedAt]
          ).catch(e => console.error(`[ai-reminder] mark-fired failed for #${r.id}:`, e.message));
          console.log(`[ai-reminder] fired #${r.id} "${r.task_text}" → staff=${r.staff_id}, done`);
        }
      }
    } catch (err) {
      console.error('[ai-reminder] drain error:', err.message);
    } finally {
      _running = false;
    }
  }

  drainOnce().catch(e => console.error('[ai-reminder] first pass failed:', e.message));
  setInterval(() => drainOnce().catch(e => console.error('[ai-reminder] drain error:', e.message)), INTERVAL);
  console.log(`[ai-reminder] drainer started (interval=${INTERVAL / 1000}s)`);
}

module.exports = { startAiReminderDrainer };
