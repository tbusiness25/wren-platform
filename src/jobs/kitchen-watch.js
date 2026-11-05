'use strict';
/**
 * src/jobs/kitchen-watch.js — b331 (2026-09-15)
 *
 * Every 5 minutes, inside the Wren app:
 *   1. refresh the 'kitchen' collector on Toby's "What needs me" board
 *      (missed checks, probe problems, problems in today's checks, shopping);
 *   2. send Toby ONE staff notification per new alert — morning checks not done
 *      by 10:00, end-of-day checks not done by 17:30 (weekdays), a probe too warm
 *      for over an hour or silent for two. Never to parents, never to anyone
 *      else: the recipient is settings.kitchen_alert_staff_id (default 1, Toby),
 *      and it goes through the normal dispatcher so his own notification
 *      preferences decide the channel.
 *
 * Each alert is recorded in kitchen_events (kind 'alert_sent', unique ref) before
 * it is sent, so a restart or a second tick can never send it twice.
 *
 * On the dev database (PG_DB=wren_dev) the notification is NOT dispatched — it is
 * logged as a dry run — so testing on :3015 never pings Toby's phone. Set
 * KITCHEN_WATCH_NOTIFY_DEV=1 to override.
 *
 * Wired (one appended line) in editions/ladn/server-unified.js.
 */

const { getPool } = require('../db/pool');

const INTERVAL_MS = 5 * 60 * 1000;
let _timer = null;
let _running = false;

function isDevDb() {
  return /(^|_)dev$/i.test(String(process.env.PG_DB || '')) || String(process.env.PG_DB || '') === 'wren_dev';
}

// b335 (2026-09-15) — 'kitchen_check_missed' (a routine SFBB check not yet
// done) is now covered by the duties tracker (b334's kitchen_checks duty,
// setting-scope) and the manager daily digest that reads it
// (scripts/b335-manager-digest.js). Per-event pings for it are the exact
// kind of stream Toby asked to reduce, so they stop here. 'kitchen_sensor_problem'
// (a live fridge/freezer fault, not a missed cadence) is untouched — that
// stays immediate, same as before.
const DIGESTED_CATEGORIES = new Set(['kitchen_check_missed']);

async function notifyNewAlerts(db, K) {
  const alerts = await K.currentAlerts(db);
  const sent = [];
  for (const a of alerts) {
    const dry = isDevDb() && process.env.KITCHEN_WATCH_NOTIFY_DEV !== '1';
    const { rows } = await db.query(
      `INSERT INTO kitchen_events (date, kind, ref, detail)
       VALUES ($1::date, 'alert_sent', $2, $3::jsonb)
       ON CONFLICT (ref) WHERE kind = 'alert_sent' DO NOTHING RETURNING id`,
      [a.date, a.key, JSON.stringify({ title: a.title, category: a.category, dry_run: dry })]);
    if (!rows.length) continue;   // already told Toby about this one
    if (DIGESTED_CATEGORIES.has(a.category)) {
      sent.push({ key: a.key, digested: true });
      continue; // recorded above (so it never re-alerts either way) — just not dispatched
    }
    if (dry) {
      console.log(`[kitchen-watch] dev — not dispatched: ${a.key} "${a.title}"`);
      sent.push({ key: a.key, dry_run: true });
      continue;
    }
    try {
      const staffId = await K.alertStaffId(db);
      require('../services/notification-dispatcher').notify(a.category, 'staff', staffId, a.title, a.body,
        { priority: 'high', link: a.link });
      sent.push({ key: a.key, dry_run: false });
    } catch (e) { console.error('[kitchen-watch] notify:', e.message); }
  }
  return sent;
}

async function tick() {
  if (_running) return { skipped: true };
  _running = true;
  try {
    const K = require('../lib/kitchen-simple');
    const db = getPool();
    await K.ensureSchema(db);
    const report = await require('../services/attention').refresh({ only: ['kitchen'], quiet: true });
    const sent = await notifyNewAlerts(db, K);
    return { report, sent };
  } catch (e) {
    console.error('[kitchen-watch]', e.message);
    return { error: e.message };
  } finally {
    _running = false;
  }
}

function startKitchenWatch() {
  if (_timer) return;
  global.__wrenKitchenWatch = true;   // lets the 'kitchen' attention collector run in this process
  const first = setTimeout(tick, 60 * 1000);
  if (first.unref) first.unref();
  _timer = setInterval(tick, INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  console.log('[kitchen-watch] started (every 5 min)');
}

module.exports = { startKitchenWatch, tick, isDevDb };
