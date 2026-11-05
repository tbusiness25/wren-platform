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
// b310 — the missing-tap sweep runs here as well as on page load, so a question
// is waiting the next morning whether or not anybody opened a screen overnight.
const CLOCKDAY = require('../lib/clock-day');

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
    // b310 — this was a re-entrancy guard that never released: `_started` was set
    // on the first pass and never cleared, so every setInterval tick after the
    // first returned immediately and the driver ran exactly ONCE per restart. The
    // flag is now released in a finally, which is what it was always meant to do.
    if (_started) return;
    _started = true;
    try {
      await drainBody();
    } finally {
      _started = false;
    }
  }

  async function drainBody() {
    const db = getPool();
    try {
      // b310 — raise the missing-tap questions before nudging anybody, so the
      // nudge and the question agree with each other. Idempotent; it is also run
      // on page load, and running it twice raises nothing twice.
      try { await CLOCKDAY.sweepQueries(db, {}); }
      catch (e) { console.error('[staff-clock-reminder] sweep:', e.message); }

      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const currentTime = now.toTimeString().split(' ')[0]; // HH:MM:SS

      // Get staff with work patterns for today
      // sec-20261026: work_pattern_days.day_of_week is 0=Mon..6=Sun (see
      // src/routes/work-patterns.js — "0=Mon..4=Fri"; prod rows are 0–4 plus two
      // 5s). getDay() is 0=Sun, so every day read the NEXT day's pattern: on
      // Sunday 25 Oct 13 staff were told "Did you forget to sign in?" from
      // Monday's pattern, and each weekday used the following day's start times.
      const dow = (now.getDay() + 6) % 7; // 0=Mon
      const { rows: expected } = await db.query(`
        SELECT s.id, s.first_name, s.last_name,
          wpd.shift_start as start_time, wpd.shift_end as end_time,
          sa.clock_in_time AS clock_in, sa.clock_out_time AS clock_out
        FROM staff s
        INNER JOIN work_patterns wp ON wp.staff_id = s.id
        INNER JOIN work_pattern_days wpd ON wpd.work_pattern_id = wp.id AND wpd.day_of_week = $1
        -- b310 — read the DERIVED day, not ladn.staff_attendance.
        -- staff_attendance is a separate legacy table that clock-in has never
        -- written to (5 rows on dev, written only by /api/attendance, /api/admin
        -- and outings). So "you haven't signed out" could not fire for a fob or
        -- PIN clock-in at all: sa.clock_in was always NULL, which also made the
        -- "did you forget to sign IN?" branch fire at everybody, every day,
        -- regardless of whether they had tapped. ladn.staff_shifts is now derived
        -- from ladn.staff_clock_events by src/lib/clock-day.js and is the same
        -- number every other screen shows.
        LEFT JOIN staff_shifts sa ON sa.staff_id = s.id AND sa.shift_date = CURRENT_DATE
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
              // b310 — gentle, and it says what happens if they cannot: the tap is
              // not lost, they are asked the time and their answer is recorded as
              // self-reported. Nothing is ever assumed on their behalf.
              const title = "You haven't tapped out";
              const body = `Your shift ended at ${e.end_time}. Tap out on the office reader if you're still here. `
                + `If you've already left, you'll be asked what time you went — nothing is recorded until you say.`;
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
