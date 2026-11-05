'use strict';
/*
 * Room Headcount Reminder Drainer — b125
 *
 * Every N minutes:
 *  - Ensure today's scheduled headcount slots exist for every room (idempotent).
 *  - Notify a room's on-shift practitioners once their slot is due (in-app +
 *    telegram/push per prefs, via the shared notification-dispatcher).
 *  - Flip any slot not completed within the grace window to 'missed' and
 *    escalate to managers.
 *
 * Mirrors staff-clock-reminder-drainer.js's in-process setInterval pattern.
 *
 * Usage:
 *   require('./services/room-headcount-reminder-drainer').startRoomHeadcountReminderDrainer();
 *
 * Envs:
 *   HEADCOUNT_REMINDER_INTERVAL — interval in minutes (default 5)
 *   HEADCOUNT_REMINDER_WINDOW   — minutes past due before we stop reminding for a slot (default 20)
 *   HEADCOUNT_MISSED_GRACE      — minutes past due before an uncompleted slot is marked missed (default 30)
 *   HEADCOUNT_REMINDER_DISABLED — truthy to skip starting
 */

const { getPool } = require('../db/pool');
const { ymd } = (() => {
  return { ymd: d => new Date(d).toISOString().slice(0, 10) };
})();

function startRoomHeadcountReminderDrainer({ interval = 5, dueWindow = 20, missedGrace = 30 } = {}) {
  if (process.env.HEADCOUNT_REMINDER_DISABLED) {
    console.log('[room-headcount-reminder] disabled by env');
    return;
  }
  const INTERVAL = (parseInt(process.env.HEADCOUNT_REMINDER_INTERVAL) || interval) * 60 * 1000;
  const DUE_WINDOW = parseInt(process.env.HEADCOUNT_REMINDER_WINDOW) || dueWindow;
  const MISSED_GRACE = parseInt(process.env.HEADCOUNT_MISSED_GRACE) || missedGrace;

  let running = false;
  async function drainOnce() {
    if (running) return;
    running = true;
    const db = getPool();
    try {
      // Lazy-require: room-headcounts.js requires notification-dispatcher, which is
      // already loaded by the time drainers start, but requiring here (not at module
      // top) avoids any load-order coupling with server-unified.js's mount order.
      const { generateSlotsForDate, sweepDueReminders, sweepMissed } = require('../routes/room-headcounts').internals;
      await generateSlotsForDate(db, ymd(new Date()));
      const notified = await sweepDueReminders(db, DUE_WINDOW);
      const missed = await sweepMissed(db, MISSED_GRACE);
      if (notified || missed) console.log(`[room-headcount-reminder] notified=${notified} missed=${missed}`);
    } catch (e) {
      console.error('[room-headcount-reminder] drain error:', e.message);
    } finally {
      running = false;
    }
  }

  drainOnce().catch(e => console.error('[room-headcount-reminder] first pass failed:', e.message));
  setInterval(drainOnce, INTERVAL);
  console.log(`[room-headcount-reminder] driver started (interval=${interval}m, dueWindow=${DUE_WINDOW}m, missedGrace=${MISSED_GRACE}m)`);
}

module.exports = { startRoomHeadcountReminderDrainer };
