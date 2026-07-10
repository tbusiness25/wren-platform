'use strict';
/*
 * Staff Clock Reminder Drainer — c04
 *
 * Every N minutes, check active staff against their expected shifts:
 *  - If past expected start and not clocked in → remind "did you forget to sign in?"
 *  - If past expected end and still clocked in → remind "you haven't signed out"
 *
 * Reminders fire as in-app notifications (ladn.notifications).
 * Telegram/SMS gating behind STAFF_CLOCK_TELEGRAM_ENABLED env flag.
 *
 * Usage:
 *   const { startStaffClockReminderDrainer } = require('./services/staff-clock-reminder-drainer');
 *   startStaffClockReminderDrainer();   // defaults: interval=15min, cooldown=1h
 *
 * Envs:
 *   STAFF_CLOCK_REMINDER_INTERVAL  — interval in minutes (default 15)
 *   STAFF_CLOCK_REMINDER_COOLDOWN  — minutes between reminders per staff (default 60)
 *   STAFF_CLOCK_REMINDER_DISABLED  — truthy to skip starting
 *   STAFF_CLOCK_TELEGRAM_ENABLED   — truthy to send Telegram (default: false, in-app only)
 */

const { getPool } = require('../db/pool');
const { notify } = require('./notification-dispatcher');

function startStaffClockReminderDrainer({ interval = 15, cooldown = 60 } = {}) {
  const INTERVAL = (parseInt(process.env.STAFF_CLOCK_REMINDER_INTERVAL) || interval) * 60 * 1000;
  const COOLDOWN = (parseInt(process.env.STAFF_CLOCK_REMINDER_COOLDOWN) || cooldown) * 60 * 1000;
  const TELEGRAM_ENABLED = !!process.env.STAFF_CLOCK_TELEGRAM_ENABLED;

  if (process.env.STAFF_CLOCK_REMINDER_DISABLED) {
    console.log('[staff-clock-reminder] disabled by env');
    return;
  }

  let _started = false;

  async function drainOnce() {
    if (_started) return;
    _started = true;

    const db = getPool();
    try {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const currentTime = now.toTimeString().split(' ')[0]; // HH:MM:SS

      // Get staff with work patterns for today
      const dow = now.getDay(); // 0=Sun
      const { rows: expected } = await db.query(`
        SELECT s.id, s.first_name, s.last_name,
          wpd.shift_start as start_time, wpd.shift_end as end_time,
          sa.clock_in, sa.clock_out
        FROM staff s
        INNER JOIN work_patterns wp ON wp.staff_id = s.id
        INNER JOIN work_pattern_days wpd ON wpd.work_pattern_id = wp.id AND wpd.day_of_week = $1
        LEFT JOIN staff_attendance sa ON sa.staff_id = s.id AND sa.date = CURRENT_DATE
        WHERE s.is_active = true
          AND wpd.shift_start IS NOT NULL
          AND wpd.is_off = false
        ORDER BY s.id
      `, [dow]);

      if (!expected.length) {
        // No staff expected today, nothing to remind
        return;
      }

      // Check last reminders to enforce cooldown
      const staffIds = expected.map(e => e.id);
      const { rows: lastReminders } = await db.query(`
        SELECT recipient_id AS staff_id, category, MAX(created_at) AS last_reminder
        FROM notifications
        WHERE recipient_type = 'staff'
          AND recipient_id = ANY($1::integer[])
          AND category IN ('staff_clock_forgot_in', 'staff_clock_forgot_out')
        GROUP BY recipient_id, category
      `, [staffIds]);

      const cooldownMap = {}; // staffId -> { forgot_in: timestamp, forgot_out: timestamp }
      for (const r of lastReminders) {
        if (!cooldownMap[r.staff_id]) cooldownMap[r.staff_id] = {};
        cooldownMap[r.staff_id][r.category] = new Date(r.last_reminder);
      }

      let remindedCount = 0;

      for (const e of expected) {
        const staffId = e.id;
        const staffName = `${e.first_name} ${e.last_name}`;

        // Check "forgot to sign in" — past start_time + grace period (15 min), no clock_in
        if (e.start_time && !e.clock_in) {
          const [sh, sm] = e.start_time.split(':').map(Number);
          const startMs = (sh * 3600 + sm * 60) * 1000;
          const [ch, cm, cs] = currentTime.split(':').map(Number);
          const nowMs = (ch * 3600 + cm * 60 + cs) * 1000;
          const gracePeriod = 15 * 60 * 1000; // 15 minutes

          if (nowMs > startMs + gracePeriod) {
            // Past start + grace, not clocked in
            const lastRem = cooldownMap[staffId]?.staff_clock_forgot_in;
            if (!lastRem || (now - lastRem) >= COOLDOWN) {
              // Fire reminder
              const title = 'Did you forget to sign in?';
              const body = `Your shift started at ${e.start_time}. Please sign in if you're on site.`;
              notify('staff_clock_forgot_in', 'staff', staffId, title, body, {
                priority: 'normal',
                relatedTable: 'staff_attendance',
                relatedId: staffId,
                channels: TELEGRAM_ENABLED ? ['in-app', 'telegram'] : ['in-app'],
              });
              remindedCount++;
              console.log(`[staff-clock-reminder] forgot sign-in: ${staffName} (id=${staffId})`);
            }
          }
        }

        // Check "forgot to sign out" — past end_time + grace (30 min), still clocked in
        if (e.end_time && e.clock_in && !e.clock_out) {
          const [eh, em] = e.end_time.split(':').map(Number);
          const endMs = (eh * 3600 + em * 60) * 1000;
          const [ch, cm, cs] = currentTime.split(':').map(Number);
          const nowMs = (ch * 3600 + cm * 60 + cs) * 1000;
          const gracePeriod = 30 * 60 * 1000; // 30 minutes

          if (nowMs > endMs + gracePeriod) {
            // Past end + grace, still clocked in
            const lastRem = cooldownMap[staffId]?.staff_clock_forgot_out;
            if (!lastRem || (now - lastRem) >= COOLDOWN) {
              // Fire reminder
              const title = "You haven't signed out";
              const body = `Your shift ended at ${e.end_time}. Please sign out if you've finished.`;
              notify('staff_clock_forgot_out', 'staff', staffId, title, body, {
                priority: 'normal',
                relatedTable: 'staff_attendance',
                relatedId: staffId,
                channels: TELEGRAM_ENABLED ? ['in-app', 'telegram'] : ['in-app'],
              });
              remindedCount++;
              console.log(`[staff-clock-reminder] forgot sign-out: ${staffName} (id=${staffId})`);
            }
          }
        }
      }

      if (remindedCount) {
        console.log(`[staff-clock-reminder] fired ${remindedCount} reminder(s)`);
      }

    } catch (err) {
      console.error('[staff-clock-reminder] drain error:', err.message);
    }
  }

  // Start: immediate first pass, then interval
  drainOnce().catch(e => console.error('[staff-clock-reminder] first pass failed:', e.message));
  setInterval(drainOnce, INTERVAL);
  console.log(`[staff-clock-reminder] driver started (interval=${interval}m, cooldown=${cooldown}m, telegram=${TELEGRAM_ENABLED})`);
}

module.exports = { startStaffClockReminderDrainer };
