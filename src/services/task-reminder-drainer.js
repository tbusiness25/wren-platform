'use strict';
/*
 * Task Reminder Drainer — P4 Actions (a)
 *
 * Every N seconds, scan tasks for due/in-progress items and fire a
 * reminder via the notification-dispatcher.
 *
 * A reminder fires once per task: only when (due_date, time_of_day) <= now()
 * AND the task has not been reminded for at least COOLDOWN_SECONDS.
 *
 * Usage:
 *   const { startTaskReminderDrainer } = require('./services/task-reminder-drainer');
 *   startTaskReminderDrainer();   // defaults: interval=30s, cooldown=600s
 *
 * Envs (all optional):
 *   TASK_REMINDER_INTERVAL  — interval in seconds (default 30)
 *   TASK_REMINDER_COOLDOWN  — seconds between reminders for the same task (default 600 = 10 min)
 *   TASK_REMINDER_DISABLED  — truthy to skip starting at all
 */

const { getPool } = require('../db/pool');
const { notify } = require('./notification-dispatcher');

function startTaskReminderDrainer({ interval = 30, cooldown = 600 } = {}) {
  const INTERVAL = (parseInt(process.env.TASK_REMINDER_INTERVAL) || interval) * 1000;
  const COOLDOWN = (parseInt(process.env.TASK_REMINDER_COOLDOWN) || cooldown) * 1000;

  if (process.env.TASK_REMINDER_DISABLED) {
    console.log('[task-reminder] disabled by env');
    return;
  }

  let _started = false;

  async function drainOnce() {
    if (_started) return;
    _started = true; // prevent double-start within this process

    const db = getPool();
    try {
      // Find tasks that are due/in-progress and eligible for a reminder
      const { rows: dueTasks } = await db.query(`
        SELECT t.id, t.title, t.due_date, t.time_of_day,
               t.owner_staff_id, t.created_by, t.source
        FROM tasks t
        WHERE t.status IN ('open','in_progress')
          AND t.due_date IS NOT NULL
          AND (
            -- time_of_day not set → remind all day from due_date
            (t.time_of_day IS NULL AND t.due_date::date <= CURRENT_DATE)
            OR
            -- time_of_day set → only remind at or after that time
            (t.time_of_day IS NOT NULL
             AND (t.due_date::date < CURRENT_DATE
                  OR (t.due_date::date = CURRENT_DATE AND NOW()::time >= t.time_of_day::time)))
          )
        ORDER BY
          CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
          t.due_date ASC
        LIMIT 50
      `);

      if (!dueTasks.length) return;

      // For each, check last reminder latency via notifications table (notify() writes there)
      const ids = dueTasks.map(t => t.id);
      const { rows: lastReminders } = await db.query(`
        SELECT related_id::integer AS tid, MAX(created_at) AS last_reminder
        FROM notifications
        WHERE category = 'task_reminder'
          AND (related_id::integer) = ANY($1::integer[])
        GROUP BY related_id
      `, [ids]);

      const latencyByTask = {};
      for (const r of lastReminders) {
        latencyByTask[r.tid] = r.last_reminder;
      }

      let decidedLogRows = [];
      for (const task of dueTasks) {
        const lastRem = latencyByTask[String(task.id)];
        if (lastRem && (new Date() - new Date(lastRem)) < COOLDOWN) {
          // Too soon to remind again
          continue;
        }

        const title = `Reminder: ${task.title}`;
        const summary = `Task "${task.title}" is due ${task.due_date}${task.time_of_day ? ` at ${task.time_of_day}` : ''}`;
        const body = `${summary}\n\nClick to open in Wren: /tasks`;

        // Fire reminder notification to the owner
        if (task.owner_staff_id) {
          notify('task_reminder', 'staff', task.owner_staff_id, title, body, {
            priority: task.priority === 'urgent' ? 'high' : 'normal',
            relatedTable: 'tasks',
            relatedId: task.id,
          });
        }

        // Also log to decision_log for audit trail
        try {
          const logRows = await db.query(`
            INSERT INTO decision_log
              (category, decided_by_staff_id, decision_made, input_context, source_table, source_id, decided_at)
            VALUES ('task_action', $1, $2::jsonb, $3::jsonb, 'tasks', $4, NOW())
            RETURNING id`,
            [task.created_by || task.owner_staff_id || 1,
             JSON.stringify({ task_id: task.id, title: task.title, action: 'reminder_fired', time_of_day: task.time_of_day }),
             JSON.stringify({ portal: 'system', auto: true }),
             task.id]
          );
          decidedLogRows.push(...logRows.rows);
        } catch (logErr) {
          console.error('[task-reminder] decision_log insert failed:', logErr.message);
        }

        console.log(`[task-reminder] fired: task=${task.id} "${task.title}" → staff=${task.owner_staff_id}`);
      }

      if (decidedLogRows.length) {
        console.log(`[task-reminder] logged ${decidedLogRows.length} events to decision_log`);
      }

    } catch (err) {
      console.error('[task-reminder] drain error:', err.message);
    }
  }

  // Start: immediate first pass, then interval
  drainOnce().catch(e => console.error('[task-reminder] first pass failed:', e.message));
  setInterval(drainOnce, INTERVAL);
  console.log(`[task-reminder] driver started (interval=${INTERVAL/1000}s, cooldown=${cooldown}s)`);
}

module.exports = { startTaskReminderDrainer };
