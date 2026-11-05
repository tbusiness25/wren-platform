// Notification queue drain — processes queued notifications whose scheduled_for <= now()
// Runs every 5 minutes via setInterval in server-unified.js
'use strict';

const { getPool }         = require('../db/pool');
const { sendTelegramNow, isAwayModeActive } = require('../lib/notifications');

async function drainQueue() {
  const db = getPool();
  let rows = [];
  try {
    const result = await db.query(
      `SELECT id, channel, event_type, payload, scheduled_for
       FROM notification_queue
       WHERE sent_at IS NULL AND suppressed_at IS NULL AND scheduled_for <= now()
       ORDER BY scheduled_for ASC
       LIMIT 50`
    );
    rows = result.rows;
  } catch (e) {
    console.error('[queue-drain] query failed:', e.message);
    return;
  }

  if (rows.length === 0) return;
  console.log(`[queue-drain] processing ${rows.length} queued notification(s)`);

  // Check away mode once for the whole batch
  const away = await isAwayModeActive();

  for (const row of rows) {
    try {
      if (away && row.channel === 'telegram') {
        // Suppress — away mode is on, mark as suppressed
        await db.query(
          'UPDATE notification_queue SET suppressed_at=now() WHERE id=$1',
          [row.id]
        );
        console.log(`[queue-drain] suppressed id=${row.id} (away mode)`);
        continue;
      }

      if (row.channel === 'telegram') {
        const payload = typeof row.payload === 'object' ? row.payload : JSON.parse(row.payload);
        await sendTelegramNow(payload);
        await db.query(
          'UPDATE notification_queue SET sent_at=now() WHERE id=$1',
          [row.id]
        );
        console.log(`[queue-drain] sent id=${row.id} (telegram/${row.event_type})`);
      } else {
        // Unknown channel — mark as suppressed to avoid repeated attempts
        await db.query(
          'UPDATE notification_queue SET suppressed_at=now() WHERE id=$1',
          [row.id]
        );
      }
    } catch (e) {
      console.error(`[queue-drain] failed id=${row.id}:`, e.message);
    }
  }
}

// Called from server — runs every 5 minutes
function startQueueDrain() {
  drainQueue().catch(e => console.error('[queue-drain] initial run:', e.message));
  setInterval(() => {
    drainQueue().catch(e => console.error('[queue-drain] interval:', e.message));
  }, 5 * 60 * 1000); // 5 minutes
  console.log('[queue-drain] notification queue drain started (5min interval)');
}

module.exports = { drainQueue, startQueueDrain };
