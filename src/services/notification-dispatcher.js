'use strict';
// Notification dispatcher — create notification rows, expand recipients,
// check per-staff preferences, queue delivery rows, poll and send.
// Runs in-process with wren-ladn and wren-ladn-admin.

const https = require('https');
const { getPool } = require('../db/pool');

// Web Push (VAPID). Guarded require so editions/containers WITHOUT the web-push
// package (e.g. demo images) don't crash on load — push simply no-ops there.
let webpush = null;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@littleangelsealing.co.uk',
      process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    console.log('[dispatcher] web push enabled');
  } else {
    webpush = null; // keys not configured → disable push channel
  }
} catch (e) { webpush = null; }

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const DEDUP_WINDOW_MS = 60 * 1000; // suppress same category+recipient within 60s

// ── Telegram send ─────────────────────────────────────────────────────────────

function sendTelegram(chatId, text) {
  const token = BOT_TOKEN();
  if (!token || !chatId || chatId === '000000000') return Promise.resolve(); // skip demo/unlinked
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
  return new Promise(resolve => {
    const req = https.request(
      { hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { res.resume(); resolve({ status: res.statusCode }); }
    );
    req.on('error', err => resolve({ error: err.message }));
    req.write(body);
    req.end();
  });
}

function formatTelegramMessage(category, title, body, link) {
  const titleCase = category.replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
  const truncBody = body ? (body.length > 400 ? body.slice(0, 397) + '…' : body) : '';
  let msg = `*Wren — ${titleCase}*\n${title}`;
  if (truncBody) msg += `\n${truncBody}`;
  if (link) msg += `\n${link}`;
  return msg;
}

// ── Core notify() — call from route handlers (fire-and-forget) ────────────────

async function _dispatchAsync(category, recipientType, recipientId, title, body, options) {
  const db = getPool();
  const { priority = 'normal', relatedTable, relatedId, link } = options || {};

  // 1. Insert notification row
  let notifId;
  try {
    const { rows } = await db.query(
      `INSERT INTO notifications
         (recipient_type, recipient_id, category, title, body, link,
          related_table, related_id, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [recipientType, recipientId || null, category, title, body || null,
       link || null, relatedTable || null, relatedId || null, priority]
    );
    notifId = rows[0].id;
  } catch (e) {
    console.error('[dispatcher] insert notification failed:', e.message);
    return;
  }

  // 2. Resolve recipient staff IDs
  let staffIds = [];
  try {
    if (recipientType === 'staff' && recipientId) {
      staffIds = [recipientId];
    } else if (recipientType === 'all-staff') {
      const { rows } = await db.query(`SELECT id FROM staff WHERE is_active=true AND role != 'parent'`);
      staffIds = rows.map(r => r.id);
    } else if (recipientType === 'all-managers') {
      const { rows } = await db.query(
        `SELECT id FROM staff WHERE is_active=true AND role IN ('manager','room_leader')`
      );
      staffIds = rows.map(r => r.id);
    }
    // parent recipient_type: inapp only, no telegram — skip staff expansion
    if (recipientType === 'parent') return;
  } catch (e) {
    console.error('[dispatcher] resolve recipients failed:', e.message);
    return;
  }

  // 3. For each staff member, check prefs and queue deliveries
  for (const sid of staffIds) {
    try {
      // Look up preference for this category
      const { rows: prefRows } = await db.query(
        `SELECT channels, enabled, scope FROM notification_preferences
         WHERE staff_id=$1 AND event_category=$2`,
        [sid, category]
      );

      // Default: inapp only if no pref set
      const pref = prefRows[0] || { channels: ['inapp'], enabled: true, scope: 'all' };
      if (!pref.enabled) continue;

      // Scope filtering: my_room / my_keychildren need related_id check
      if (pref.scope === 'my_room' && relatedId) {
        const { rows: roomRows } = await db.query(
          `SELECT room_id FROM staff WHERE id=$1`, [sid]
        );
        const staffRoomId = roomRows[0]?.room_id;
        if (staffRoomId) {
          // Check if related entity (child/staff) is in this room
          let inRoom = false;
          try {
            if (relatedTable === 'children') {
              const { rows: cr } = await db.query(`SELECT room_id FROM children WHERE id=$1`, [relatedId]);
              inRoom = cr[0]?.room_id === staffRoomId;
            } else if (relatedTable === 'staff') {
              const { rows: sr } = await db.query(`SELECT room_id FROM staff WHERE id=$1`, [relatedId]);
              inRoom = sr[0]?.room_id === staffRoomId;
            } else {
              inRoom = true; // can't filter, allow
            }
          } catch { inRoom = true; }
          if (!inRoom) continue;
        }
      }

      if (pref.scope === 'my_keychildren' && relatedId && relatedTable === 'children') {
        const { rows: kcRows } = await db.query(
          `SELECT id FROM children WHERE id=$1 AND key_person_id=$2`, [relatedId, sid]
        );
        if (!kcRows.length) continue;
      }

      // Queue delivery for each channel
      for (const channel of pref.channels) {
        if (channel === 'sms') continue; // out of scope

        // Dedup: skip if same recipient+category delivered within DEDUP_WINDOW_MS
        const dedup = await db.query(
          `SELECT nd.id FROM notification_deliveries nd
           JOIN notifications n ON n.id = nd.notification_id
           WHERE nd.recipient_id=$1 AND n.category=$2
             AND nd.channel=$3
             AND nd.attempted_at > NOW() - INTERVAL '${Math.floor(DEDUP_WINDOW_MS / 1000)} seconds'
           LIMIT 1`,
          [sid, category, channel]
        );
        if (dedup.rows.length) continue;

        await db.query(
          `INSERT INTO notification_deliveries
             (notification_id, recipient_id, channel, status, attempted_at)
           VALUES ($1,$2,$3,'queued',NOW())`,
          [notifId, sid, channel]
        );
      }

      // Web Push: if this staff has any active browser subscription, queue a webpush
      // delivery too — subscribing in the browser IS the opt-in (independent of
      // pref.channels). Respects the enabled/scope checks already applied above.
      if (webpush && !pref.channels.includes('webpush')) {
        try {
          const { rows: subRows } = await db.query(
            `SELECT 1 FROM push_subscriptions WHERE staff_id=$1 LIMIT 1`, [sid]);
          if (subRows.length) {
            const wdedup = await db.query(
              `SELECT nd.id FROM notification_deliveries nd
               JOIN notifications n ON n.id = nd.notification_id
               WHERE nd.recipient_id=$1 AND n.category=$2 AND nd.channel='webpush'
                 AND nd.attempted_at > NOW() - INTERVAL '${Math.floor(DEDUP_WINDOW_MS / 1000)} seconds'
               LIMIT 1`, [sid, category]);
            if (!wdedup.rows.length) {
              await db.query(
                `INSERT INTO notification_deliveries (notification_id, recipient_id, channel, status, attempted_at)
                 VALUES ($1,$2,'webpush','queued',NOW())`, [notifId, sid]);
            }
          }
        } catch (e) { console.error('[dispatcher] webpush queue failed:', e.message); }
      }
    } catch (e) {
      console.error(`[dispatcher] pref check failed for staff ${sid}:`, e.message);
    }
  }
}

// Public API: fire-and-forget from route handlers
function notify(category, recipientType, recipientId, title, body, options) {
  _dispatchAsync(category, recipientType, recipientId, title, body, options)
    .catch(e => console.error('[dispatcher] notify error:', e.message));
}

// ── Poller: every 30s, pick up queued deliveries and send ────────────────────

async function _processQueued() {
  const db = getPool();
  let rows = [];
  try {
    const result = await db.query(`
      SELECT nd.id, nd.notification_id, nd.recipient_id, nd.channel,
             n.category, n.title, n.body, n.link,
             s.telegram_chat_id, s.email
      FROM notification_deliveries nd
      JOIN notifications n ON n.id = nd.notification_id
      LEFT JOIN staff s ON s.id = nd.recipient_id
      WHERE nd.status = 'queued'
      ORDER BY nd.attempted_at ASC
      LIMIT 50
    `);
    rows = result.rows;
  } catch (e) {
    console.error('[dispatcher] poll query failed:', e.message);
    return;
  }

  for (const row of rows) {
    let success = false;
    let errMsg = null;

    try {
      if (row.channel === 'inapp') {
        // inapp: bell icon picks up via GET /api/notifications — nothing to send
        success = true;
      } else if (row.channel === 'telegram') {
        if (!row.telegram_chat_id || row.telegram_chat_id === '000000000') {
          // Not linked — skip silently, mark as skipped
          await db.query(
            `UPDATE notification_deliveries SET status='skipped', delivered_at=NOW() WHERE id=$1`,
            [row.id]
          );
          continue;
        }
        const text = formatTelegramMessage(row.category, row.title, row.body, row.link);
        const result = await sendTelegram(row.telegram_chat_id, text);
        success = !result?.error && result?.status < 400;
        if (!success) errMsg = result?.error || `HTTP ${result?.status}`;
      } else if (row.channel === 'email') {
        // Email: use SMTP if configured, else skip
        const sent = await _sendEmail(row);
        success = sent;
        if (!sent) errMsg = 'email not configured';
      } else if (row.channel === 'webpush') {
        if (!webpush) { success = false; errMsg = 'web push not configured'; }
        else {
          const { rows: subs } = await db.query(
            `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE staff_id=$1`,
            [row.recipient_id]);
          if (!subs.length) {
            await db.query(`UPDATE notification_deliveries SET status='skipped', delivered_at=NOW() WHERE id=$1`, [row.id]);
            continue;
          }
          const payload = JSON.stringify({
            title: row.title || 'Wren', body: row.body || '',
            url: row.link || '/ey/inbox', tag: 'wren-' + row.category });
          let anyOk = false;
          for (const sub of subs) {
            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
              anyOk = true;
            } catch (err) {
              if (err.statusCode === 404 || err.statusCode === 410) {
                await db.query(`DELETE FROM push_subscriptions WHERE id=$1`, [sub.id]).catch(() => {});
              }
            }
          }
          success = anyOk;
          if (!success) errMsg = 'all push endpoints failed/expired';
        }
      }

      await db.query(
        `UPDATE notification_deliveries
         SET status=$1, delivered_at=$2, error_message=$3
         WHERE id=$4`,
        [success ? 'sent' : 'failed', success ? new Date() : null, errMsg, row.id]
      );
    } catch (e) {
      await db.query(
        `UPDATE notification_deliveries SET status='failed', error_message=$1 WHERE id=$2`,
        [e.message, row.id]
      ).catch(() => {});
    }
  }
}

async function _sendEmail(row) {
  // Wired to src/utils/email.js (nodemailer). Returns false when no SMTP is
  // configured (sendEmail → {skipped:true}) so the delivery is marked failed,
  // not silently "sent".
  try {
    if (!row.email) return false;
    const { sendEmail } = require('../utils/email');
    const safe = String(row.body || row.title || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const html = `<p>${safe}</p>` + (row.link ? `<p><a href="${row.link}">Open in Wren</a></p>` : '');
    const result = await sendEmail({ to: row.email, subject: `Wren — ${row.title}`, html, text: row.body || row.title });
    return !(result && result.skipped);
  } catch (e) { return false; }
}

let _pollerStarted = false;

function startDispatcher() {
  if (_pollerStarted) return;
  _pollerStarted = true;
  // Immediate first pass
  _processQueued().catch(() => {});
  // Then every 30s
  setInterval(() => {
    _processQueued().catch(() => {});
  }, 30 * 1000);
  console.log('[dispatcher] notification poller started (30s interval)');
}

module.exports = { notify, startDispatcher };
