'use strict';
// Notification dispatcher — create notification rows, expand recipients,
// check per-staff preferences, queue delivery rows, poll and send.
// Runs in-process with wren-ladn and wren-ladn-admin.

const https = require('https');
const { getPool } = require('../db/pool');
const { defaultModeForCategory, isInAppOnly } = require('./notification-categories');

// Web Push (VAPID). Guarded require so editions/containers WITHOUT the web-push
// package (e.g. demo images) don't crash on load — push simply no-ops there.
let webpush = null;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@example-nursery.co.uk',
      process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    console.log('[dispatcher] web push enabled');
  } else {
    webpush = null; // keys not configured → disable push channel
  }
} catch (e) { webpush = null; }

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const DEDUP_WINDOW_MS = 60 * 1000; // suppress same category+recipient within 60s

// ── What may leave Wren by email, and what may not ───────────────────────────
// Toby, 2026-09-08: staff sign in with PERSONAL email addresses, operational
// notifications go out to those addresses, "and then the messaging will stay
// directly on Wren for safeguarding".
//
// A personal inbox is outside the setting's control: it is not covered by the
// nursery's retention, it is readable by whoever else holds that account, and it
// survives the person leaving. So the split cannot be a per-staff preference —
// one tick of "email" against parent messages and a child's name is in somebody's
// personal Gmail forever. It is enforced here instead, in the one place every
// channel decision passes through, and it fails CLOSED: a category nobody has
// classified does not get emailed.
//
// The test for the allowlist is not "is this useful in email" but "could this
// text ever name a child, a parent, or a concern". Operational facts about the
// STAFF MEMBER'S OWN working life pass. Anything about a child does not.
const EMAIL_ALLOWED_CATEGORIES = new Set([
  'absence_request', 'absence_approved', 'absence_declined', 'absence_reminder',
  'rota_published', 'rota_changed', 'shift_reminder', 'shift_swap',
  'staff_clock_forgot_in', 'staff_clock_forgot_out',
  // b501 (2026-10-17): task_reminder / task_due / task_overdue were removed from this list — Toby's Tasks v2 brief: "task
  // notifications stay in-app and push", because a task title can name a child (SMART tasks link to a child or room).
  'training_due', 'training_expiring', 'cpd_due',
  'supervision_due', 'probation_due', 'appraisal_due',
  'policy', 'policy_signature_due',
  'staff_celebration', 'system',
  // b503 (2026-10-17) — "your briefing is ready". Classified deliberately: src/lib/briefing-delivery.js builds this text from COUNTS ONLY ("2 urgent, 9 for this week").
  // The briefing itself names children and never leaves Wren; only this counts-and-link note can.
  'briefing_ready',
  // b295 (2026-09-09) — the staff newsletter assembled from ladn.staff_notices.
  // Classified deliberately, against the test above rather than against how
  // useful it is: a notice says what has changed about the way somebody does
  // their job — a new sign-in, where planning moved to, which emails will start
  // arriving. It is the staff member's own working life and nothing else.
  //
  // It is emailable only because it is ALSO enforced at the content level:
  // src/routes/staff-notices.js re-reads this allowlist before every send, and
  // then refuses to send at all if the assembled text contains a child's name
  // (children.first_name / preferred_name / last_name). A category on this list
  // is a statement that the text CANNOT name a child; for this one that is not
  // an assumption about who writes it, it is checked on the actual bytes.
  'staff_notice_newsletter',
]);

// Named so the reason is visible at the call site rather than inferred from
// absence. These are the ones that carry, or can carry, child- or parent-level
// content — messages above all, which is the case Toby called out by name.
const EMAIL_BLOCKED_CATEGORIES = new Set([
  'parent_message_received', 'message_received', 'message_reply',
  'safeguarding', 'safeguarding_concern', 'incident', 'accident',
  'medicine', 'medicine_due', 'allergy',
  'observation', 'observations', 'termly_update_due', 'reports',
  // b528 (2026-10-26): 'two_year_check_draft' named here, beside the parent-facing
  // 'two_year_check' it has always sat next to. It was already un-emailable (it is
  // absent from the allowlist above, which fails closed), but its title is literally
  // "2-year check ready to review — <child's name>" and its body describes that
  // child's development: it must not become emailable by somebody later tidying the
  // allowlist. Named, not omitted — the b311 rule a few lines down.
  'two_year_check', 'two_year_check_draft', 'sen', 'sen_review',
  'headcount_due', 'headcount_missed', 'doorbell_pressed',

  // ── b311 (2026-09-10) — every signal category, named rather than omitted ──
  // The allowlist above already fails closed, so leaving these out would have
  // blocked them too. They are listed HERE, explicitly, because "not emailed
  // because nobody classified it" and "not emailed because we decided it must
  // not be" are different promises, and only the second survives somebody
  // tidying the allowlist in six months.
  //
  // The decision: hard rule 1 of the b311 brief is that every output of the
  // signal system is an in-Wren notification to a member of staff, and there is
  // no transport in that build that can reach a family. Several signals also
  // count children (dates of birth missing, observation gaps, open safeguarding
  // concerns), which fails the allowlist's own test — "could this text ever
  // name a child, a parent, or a concern" — on its face.
  'signal_ratio_risk', 'signal_safeguarding_stale', 'signal_invoice_run',
  'signal_payroll_run', 'signal_funding_headcount', 'signal_website_stale',
  'signal_child_record_gap', 'signal_observation_gap', 'signal_occupancy_forecast',
  // b365 — the four money signals, named here for the same reason as the rest.
  // signal_debt_ageing is the one that most looks emailable and most is not: it
  // is about what families owe, and an email is a transport that can reach one.
  'signal_empty_space', 'signal_supplier_rise', 'signal_debt_ageing', 'signal_wage_ratio',
  'signal_muted_itself',

  // b335 (2026-09-15) — the manager daily digest names children by name
  // (duties overdue by child, pathway stages overdue by child). Telegram and
  // in-app stay inside Wren's own control; a staff member's personal email
  // does not, which is the exact line EMAIL_ALLOWED_CATEGORIES draws above.
  // Named explicitly rather than left off the allowlist, for the same reason
  // the b311 signals are named here rather than omitted.
  'manager_daily_digest',

  // b346 (2026-09-21) — the finance calendar's two reminders. Named rather than
  // omitted, for the same reason as the b311 signals above: "not emailed because
  // nobody classified it" and "not emailed because we decided" are different
  // promises. The decision: a company's tax and filing position stays in-app and
  // on Telegram — inside Wren's control — and never lands in a personal inbox.
  'finance_deadline', 'finance_deadline_red',

  // b364 (2026-09-29) — "an email landed in an urgent section". Blocked from the
  // email channel for a reason that is almost funny and entirely serious: Wren
  // emailing a manager about an email would put a summary of a parent's message
  // into a second, unwalled inbox, and it is the one category where an accidental
  // forward is indistinguishable from the feature working. In-app and Telegram
  // only, and even the Telegram text is name + section + one-line gist
  // (src/lib/inbox-alerts.js), never the body.
  'inbox_urgent_email',

  // b501 (2026-10-17) — Tasks v2. Named rather than left to the fail-closed default: a task title can name a child, so
  // task notifications are in-app and push only. task_assigned was never on the allowlist; the other five were removed above.
  'task_assigned', 'task_reminder', 'task_due', 'task_overdue', 'task_nudge', 'task_escalated',

  // inset-20261026 (2026-10-26) — the INSET-day agenda. Named rather than left to the fail-closed default:
  // inset_feedback tells Toby a colleague sent a comment, and a comment can name a child; inset_agenda is the
  // one-off "please read the agenda" note (scripts/inset-announce.js). Both are bell + push only, never email.
  'inset_feedback', 'inset_agenda',

  // b530 (2026-10-26) — room meetings. Named rather than left to the fail-closed
  // default, for the same reason as the b311 signals above: "not emailed because
  // nobody classified it" and "not emailed because we decided it must not be" are
  // different promises, and only the second survives somebody tidying the
  // allowlist. The brief is explicit — in-app nudges only, no email, no Telegram.
  // These three are also the staff member's own working life and would arguably
  // pass the allowlist's test; they are blocked anyway, because a nudge about
  // Wednesday's meeting in a personal Gmail is noise, not a service.
  'room_meeting_tomorrow', 'room_meeting_minutes_due', 'room_meeting_room_overdue',
]);

/**
 * May this category be delivered to a staff member's personal email?
 * Unknown categories return false: a new notification type is not emailed until
 * somebody has looked at it and said it is safe to.
 */
function emailAllowedForCategory(category) {
  const c = String(category || '');
  if (EMAIL_BLOCKED_CATEGORIES.has(c)) return false;
  return EMAIL_ALLOWED_CATEGORIES.has(c);
}


// ── Telegram send ─────────────────────────────────────────────────────────────

// login-20261023: through the one Telegram sender (src/lib/notifications.js), which carries the dev guard.
function sendTelegram(chatId, text) {
  if (!BOT_TOKEN() || !chatId || chatId === '000000000') return Promise.resolve(); // skip demo/unlinked
  // Keeps the { status } / { error } shape the delivery loop below records; a dev skip reads as delivered.
  return require('../lib/notifications').sendTelegramNow({ chat_id: chatId, text, parse_mode: 'Markdown' }, { token: BOT_TOKEN() })
    .then((r) => (r.error ? { error: r.error } : { status: r.status || (r.skipped ? 200 : 500) }));
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

// ── b149: per-user category mode (off / inapp / inapp_push / digest) ──────────
// Independent of the older notification_preferences table (channels/scope,
// still used below for telegram + room/keychildren scoping). This layer only
// decides: does anything happen at all, and does push fire.

async function _getUserCategoryMode(db, staffId, category) {
  try {
    const { rows } = await db.query(
      `SELECT mode FROM user_notification_prefs WHERE staff_id=$1 AND category=$2`,
      [staffId, category]
    );
    return rows[0]?.mode || defaultModeForCategory(category);
  } catch (e) {
    console.error('[dispatcher] mode lookup failed:', e.message);
    return defaultModeForCategory(category);
  }
}

// Stage a 'digest' category item instead of creating an immediate notification.
// scripts/notification-digest-rollup.js (daily 08:00 cron) rolls these up.
async function _stageDigest(db, staffId, category, title, body, options) {
  const { relatedTable, relatedId, link, priority = 'normal' } = options || {};
  try {
    await db.query(
      `INSERT INTO notification_digest_queue
         (staff_id, category, title, body, link, related_table, related_id, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [staffId, category, title, body || null, link || null,
       relatedTable || null, relatedId || null, priority]
    );
  } catch (e) {
    console.error('[dispatcher] digest stage failed:', e.message);
  }
}

function _londonHHMM(date) {
  // "HH:MM:SS" in Europe/London wall-clock time, DST-safe.
  return date.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour12: false });
}

function _toMinutes(hhmmss) {
  const [h, m] = hhmmss.split(':').map(Number);
  return h * 60 + m;
}

function _isWithinWindow(startStr, endStr, nowStr) {
  const startM = _toMinutes(startStr), endM = _toMinutes(endStr), nowM = _toMinutes(nowStr);
  if (startM === endM) return false; // zero-width window = disabled
  if (startM < endM) return nowM >= startM && nowM < endM;      // same-day window
  return nowM >= startM || nowM < endM;                          // overnight wrap (e.g. 20:00-07:00)
}

// Returns { quiet: bool, scheduledFor: Date|null } — scheduledFor is the next
// occurrence of quiet_hours_end (London time) if currently within the window.
async function _quietHoursCheck(db, staffId) {
  let start = '20:00:00', end = '07:00:00', enabled = true;
  try {
    const { rows } = await db.query(
      `SELECT quiet_hours_enabled, quiet_hours_start, quiet_hours_end
       FROM user_notification_settings WHERE staff_id=$1`, [staffId]);
    if (rows[0]) {
      enabled = rows[0].quiet_hours_enabled;
      start = rows[0].quiet_hours_start;
      end = rows[0].quiet_hours_end;
    }
  } catch (e) { /* fall through to defaults */ }

  if (!enabled) return { quiet: false, scheduledFor: null };

  const now = new Date();
  const nowStr = _londonHHMM(now);
  const quiet = _isWithinWindow(start, end, nowStr);
  if (!quiet) return { quiet: false, scheduledFor: null };

  // Compute the next wall-clock occurrence of `end` in Europe/London, expressed
  // as a real Date (UTC-backed) so it can be stored/compared in Postgres.
  const [endH, endM] = end.split(':').map(Number);
  const londonParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
  const nowM = _toMinutes(nowStr);
  const endMins = endH * 60 + endM;
  const dayOffset = nowM >= endMins ? 1 : 0; // end time already passed today → it's tomorrow's end
  const target = new Date(Date.UTC(
    Number(londonParts.year), Number(londonParts.month) - 1, Number(londonParts.day) + dayOffset,
    endH, endM, 0
  ));
  // target was built as if London==UTC; correct for the current UTC offset (BST/GMT).
  const londonNowMs = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' })).getTime();
  const utcNowMs = now.getTime();
  const tzDriftMs = utcNowMs - londonNowMs;
  const scheduledFor = new Date(target.getTime() + tzDriftMs);
  return { quiet: true, scheduledFor };
}

// ── Core notify() — call from route handlers (fire-and-forget) ────────────────

async function _dispatchAsync(category, recipientType, recipientId, title, body, options) {
  const db = getPool();
  const { priority = 'normal', relatedTable, relatedId, link, skipUserGate } = options || {};

  // 0. Resolve recipient staff IDs FIRST (moved ahead of the INSERT) so a
  // single-target 'staff' notification can be fully gated (muted/digested)
  // before any row is written at all — this is the "check before insert" b149
  // needs. Broadcast categories (all-staff/all-managers) keep the shared-row
  // behaviour below; per-recipient muting there only affects their deliveries,
  // not whether the shared row exists (documented limitation, see NOTES).
  let staffIds = [];
  try {
    if (recipientType === 'staff' && recipientId) {
      staffIds = [recipientId];
    } else if (recipientType === 'all-staff') {
      // b485 — a demo staff member (clock-in test fixture) is not a real colleague
      // and must never receive a broadcast meant for the whole team.
      const { rows } = await db.query(`SELECT id FROM staff WHERE is_active=true AND role != 'parent' AND COALESCE(is_demo, false) = false`);
      staffIds = rows.map(r => r.id);
    } else if (recipientType === 'all-managers') {
      const { rows } = await db.query(
        `SELECT id FROM staff WHERE is_active=true AND role IN ('manager','room_leader') AND COALESCE(is_demo, false) = false`
      );
      staffIds = rows.map(r => r.id);
    }
    // parent recipient_type: staffIds stays [] (no branch matches) — the row
    // still gets inserted below (parents read it directly via recipient_type=
    // 'parent'+recipient_id=child_id), the per-staff loop just runs 0 times.
  } catch (e) {
    console.error('[dispatcher] resolve recipients failed:', e.message);
    return;
  }

  if (recipientType === 'staff' && staffIds.length === 1 && !skipUserGate) {
    const mode = await _getUserCategoryMode(db, staffIds[0], category);
    if (mode === 'off') return; // fully muted, nothing created
    if (mode === 'digest') {
      await _stageDigest(db, staffIds[0], category, title, body, options);
      return; // rolled up later by notification-digest-rollup.js
    }
  }

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

  // 2. (staffIds already resolved in step 0 above)

  // 2b. b340: a parent-addressed notification is ALSO a nudge — for the parents who have chosen one
  // (push and/or a fixed "something is waiting" email) on the Notifications screen. The bell row above
  // is unchanged and always written. A parent with no explicit choice gets nothing more, and a category
  // nobody has classified is not nudged at all (fail closed). Never throws.
  if (recipientType === 'parent' && recipientId) {
    try {
      await require('./parent-notify').fanOutToParents(db, { notificationId: notifId, category, childId: recipientId });
    } catch (e) { console.error('[dispatcher] parent fan-out failed:', e.message); }
  }

  // 3. For each staff member, check prefs and queue deliveries
  for (const sid of staffIds) {
    try {
      // b149 per-user mode gate — applies to every recipient, including
      // broadcast categories where step 0's early-exit didn't run.
      const mode = skipUserGate ? 'inapp_push' : await _getUserCategoryMode(db, sid, category);
      if (mode === 'off') continue; // muted for this person only
      if (mode === 'digest' && recipientType !== 'staff') {
        // Rare broadcast+digest combo — stage instead of an immediate delivery
        // for this recipient (the shared notifications row still exists for
        // others reading it directly, per the documented limitation above).
        await _stageDigest(db, sid, category, title, body, options);
        continue;
      }

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

        // Email leaves Wren and lands somewhere the setting does not control.
        // Only categories about the staff member's own working life may go.
        if (channel === 'email' && !emailAllowedForCategory(category)) {
          console.warn(`[notify] email suppressed for category "${category}" — not on the allowlist`);
          continue;
        }

        // b530: an in-app-only category never reaches a phone, whatever this
        // preference row says. INAPP_ONLY_CATEGORIES used to be consulted only
        // when somebody pressed "reset to role defaults", so a row written
        // before a category joined the set still routed it to Telegram. These
        // are categories that are by definition not urgent and not personal to
        // the recipient's phone (notification-categories.js's own words), so
        // the bell is the whole promise and this is where it is kept.
        if (channel === 'telegram' && isInAppOnly(category)) {
          continue;
        }

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
      // b149: mode='inapp' suppresses push entirely for this category; quiet
      // hours defer (not drop) push, keyed off the user's own settings.
      if (webpush && !pref.channels.includes('webpush') && mode !== 'inapp') {
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
              const { quiet, scheduledFor } = await _quietHoursCheck(db, sid);
              if (quiet) {
                await db.query(
                  `INSERT INTO notification_deliveries (notification_id, recipient_id, channel, status, attempted_at, scheduled_for)
                   VALUES ($1,$2,'webpush','deferred',NOW(),$3)`, [notifId, sid, scheduledFor]);
              } else {
                await db.query(
                  `INSERT INTO notification_deliveries (notification_id, recipient_id, channel, status, attempted_at)
                   VALUES ($1,$2,'webpush','queued',NOW())`, [notifId, sid]);
              }
            }
          }
        } catch (e) { console.error('[dispatcher] webpush queue failed:', e.message); }
      }
    } catch (e) {
      console.error(`[dispatcher] pref check failed for staff ${sid}:`, e.message);
    }
  }

  // b184: hand the notifications row id back to awaiting callers (notifyAsync).
  // notify() ignores it, so nothing existing changes — but a caller that needs
  // to PROVE a notification landed (POST /api/waitlist/:id/book-viewing returns
  // its notification ids; event-reminders stamps the id on the reminder row)
  // no longer has to guess by re-querying the table.
  return notifId;
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
         OR (nd.status = 'deferred' AND nd.scheduled_for <= NOW())
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
          let { rows: subs } = await db.query(
            `SELECT id, endpoint, p256dh, auth, portal FROM push_subscriptions WHERE staff_id=$1`,
            [row.recipient_id]);
          // seed-gdpr-20261030: a phone subscribed from Seed (the HR app) gets staff-side
          // categories only — child/parent/inbox pushes stay on Nest. A subscription with no
          // recorded portal (made before this) is treated as Seed until the shell re-syncs it.
          const { seedAllows } = require('./notification-taxonomy');
          const subsAll = subs;
          subs = subsAll.filter(s => (s.portal && s.portal !== 'hr') || seedAllows(row.category));
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

// ── b184: calendar-event reminders ride the SAME poller ─────────────────────
// Deliberately NOT a new cron job / systemd timer: event reminders are just
// another thing this delivery job notices is due. src/lib/event-reminders.js
// schedules missing reminders for future events and fires the ones now due
// (24h / 1h before, lead times from settings). Guarded require + swallowed
// errors so an edition without the table never breaks normal notifications.
async function _sweepEventReminders() {
  try {
    const er = require('../lib/event-reminders');
    const { scheduled, fired } = await er.sweepEventReminders(getPool(), _dispatchAsync);
    if (scheduled || fired) {
      console.log(`[dispatcher] event reminders — scheduled ${scheduled}, fired ${fired}`);
    }
  } catch (e) {
    console.error('[dispatcher] event reminder sweep failed:', e.message);
  }
}

// ── b209: staff-task reminders ride the SAME poller ─────────────────────────
// Same reasoning as the b184 sweep above — a task reminder is just another
// thing this delivery job notices is due, so it needs no cron job of its own.
// src/lib/task-reminders.js schedules the lead reminders (24h/1h before, lead
// times from settings), fires the ones now due, escalates an overdue task to
// the manager ONCE, and rolls a completed repeating task forward to its next
// occurrence. Guarded require + swallowed errors so an edition without the
// b209 tables never breaks normal notifications.
async function _sweepTaskReminders() {
  try {
    const tr = require('../lib/task-reminders');
    const { scheduled, fired, nudged, escalated, spawned } =
      await tr.sweepTaskReminders(getPool(), _dispatchAsync);
    if (scheduled || fired || nudged || escalated || spawned) {
      console.log(`[dispatcher] task reminders — scheduled ${scheduled}, fired ${fired}, nudged ${nudged}, `
        + `escalated ${escalated}, recurrences ${spawned}`);
    }
  } catch (e) {
    console.error('[dispatcher] task reminder sweep failed:', e.message);
  }
}

// ── b346: finance-calendar reminders ride the SAME poller ───────────────────
// A tax or filing deadline is one more thing this job notices is due. The sweep
// throttles itself to hourly and only speaks 08:00–18:00 London, so calling it
// every 30s costs one clock check. Guarded require + swallowed errors, as above,
// so an edition without the b346 tables never breaks normal notifications.
async function _sweepFinanceCalendar() {
  try {
    const fc = require('../lib/finance-calendar-reminders');
    const { fired } = await fc.sweepFinanceCalendar(getPool(), _dispatchAsync);
    if (fired) console.log(`[dispatcher] finance calendar — ${fired} reminder(s) sent`);
  } catch (e) {
    console.error('[dispatcher] finance calendar sweep failed:', e.message);
  }
}

// ── b358: the Action Plan's own overdue notice rides the SAME poller ────────
// b209's sweep above already escalates an overdue task to the MANAGER once.
// This is the other half the b358 brief asks for: the ASSIGNEE is told their
// own action is overdue, once, never repeatedly. The "once" is guaranteed in
// src/lib/action-plan-tasks.js by stamping the row before anything is sent.
// Guarded require + swallowed errors, as above, so an edition without the b358
// columns never breaks normal notifications.
async function _sweepActionPlanOverdue() {
  // b501 (Tasks v2): Action Plans are tasks now, and every task — mirrored action items included — gets the daily nudge and
  // the escalation from src/lib/task-accountability.js. Running this one-shot notice as well would tell the same person twice.
  // Set ACTION_PLAN_OVERDUE_LEGACY=on to bring it back.
  if (process.env.ACTION_PLAN_OVERDUE_LEGACY !== 'on') return;
  try {
    const ap = require('../lib/action-plan-tasks');
    const told = await ap.sweepOverdue(getPool(), _dispatchAsync);
    if (told) console.log(`[dispatcher] action plan — ${told} overdue notice(s) sent to assignees`);
  } catch (e) {
    console.error('[dispatcher] action plan overdue sweep failed:', e.message);
  }
}

// ── b502: reminder campaigns a manager has STARTED ride the SAME poller ────────
// Only campaigns in status 'running' are touched (nothing starts automatically), only on prod (a dev container never reminds anyone), and the
// only thing sent is an in-app bell (+ push for a parent who opted in). Each family drops out of its campaign the moment its items are done.
async function _sweepDetailCampaigns() {
  try {
    if (require('../lib/notifications').isDevEnvironment()) return;
    const c = require('../lib/detail-campaigns');
    const r = await c.runDue(getPool(), _dispatchAsync);
    if (r.sent || r.ended) console.log(`[dispatcher] detail campaigns — sent ${r.sent}, completed ${r.completed}, ended ${r.ended}`);
  } catch (e) {
    console.error('[dispatcher] detail campaign sweep failed:', e.message);
  }
}

// ── parentdetails-20261023: the "funding week is coming" nudge rides the SAME poller ──────
// Does nothing unless a manager switched it on in Roost (detail_nudge_enabled, OFF by default) — and then only in dry run until
// dry run is switched off as well. Prod only, weekdays 09:00-17:00, bell + opted-in push only (src/lib/detail-nudge.js).
async function _sweepDetailNudges() {
  try {
    if (require('../lib/notifications').isDevEnvironment()) return;
    const r = await require('../lib/detail-nudge').runDue(getPool(), _dispatchAsync);
    if (r.logged) console.log(`[dispatcher] detail nudge — ${r.dry_run ? 'dry run, logged' : 'sent'} ${r.dry_run ? r.logged : r.sent} (${r.window})`);
  } catch (e) {
    console.error('[dispatcher] detail nudge sweep failed:', e.message);
  }
}

// ── b503: Monday-morning briefings ride the SAME poller ────────────────────────
// Monday from 07:00 London, only for a period a manager switched ON (briefing_week_enabled / _month_ / _term_), once per person, prod only.
async function _sweepBriefings() {
  try {
    if (require('../lib/notifications').isDevEnvironment()) return;
    const r = await require('../lib/briefing-delivery').deliverDue(getPool(), _dispatchAsync);
    if (r.sent) console.log(`[dispatcher] briefings — built ${r.built}, told ${r.sent} (${r.periods.join(', ')})`);
  } catch (e) {
    console.error('[dispatcher] briefing sweep failed:', e.message);
  }
}

// ── b530: the room-meeting rhythm rides the SAME poller ────────────────────────
// Keeps each room's next meeting in the diary and sends the three nudges: the
// leader the day before, the leader again if the minutes are more than two
// working days late, and the managers if a room has gone a fortnight without
// holding one. Throttled to hourly and 07:00-18:00 London inside the sweep, so
// calling it every 30s costs one clock check. Does nothing at all unless
// ladn.settings.room_meetings_enabled is 'true'. Guarded require + swallowed
// errors, as above, so a deploy where the b530 migration has not run yet never
// breaks normal notifications.
//
// NOT gated on isDevEnvironment(): every recipient is a member of staff and the
// only channel is the bell, so there is nothing here a dev container could send
// to a family. That gate exists on the sweeps that can reach a parent.
async function _sweepRoomMeetings() {
  try {
    const rm = require('../lib/room-meeting-rhythm');
    const r = await rm.sweepRoomMeetings(getPool(), _dispatchAsync);
    if (r && (r.tomorrow || r.minutes_due || r.room_overdue || (r.created && r.created.length))) {
      console.log(`[dispatcher] room meetings — planned ${r.created.length}, tomorrow ${r.tomorrow}, `
        + `minutes due ${r.minutes_due}, rooms overdue ${r.room_overdue}`);
    }
  } catch (e) {
    console.error('[dispatcher] room meeting sweep failed:', e.message);
  }
}

function startDispatcher() {
  if (_pollerStarted) return;
  _pollerStarted = true;
  // Immediate first pass
  _processQueued().catch(() => {});
  _sweepEventReminders().catch(() => {});
  _sweepTaskReminders().catch(() => {});
  _sweepFinanceCalendar().catch(() => {});
  _sweepActionPlanOverdue().catch(() => {});
  _sweepDetailCampaigns().catch(() => {});
  _sweepDetailNudges().catch(() => {});
  _sweepBriefings().catch(() => {});
  _sweepRoomMeetings().catch(() => {});
  // Then every 30s
  setInterval(() => {
    _processQueued().catch(() => {});
    _sweepEventReminders().catch(() => {});
    _sweepTaskReminders().catch(() => {});
    _sweepFinanceCalendar().catch(() => {});
    _sweepActionPlanOverdue().catch(() => {});
    _sweepDetailCampaigns().catch(() => {});
    _sweepDetailNudges().catch(() => {});
    _sweepBriefings().catch(() => {});
    _sweepRoomMeetings().catch(() => {});
  }, 30 * 1000);
  console.log('[dispatcher] notification poller started (30s interval, incl. event + task reminders)');
}

// notifyAsync — awaitable variant of notify() for short-lived scripts (e.g.
// scripts/report-engine-nightly.js) where fire-and-forget would race process.exit()
// and lose the queued deliveries. Identical behaviour, just returns the promise.
module.exports = { notify, notifyAsync: _dispatchAsync, startDispatcher };
module.exports.emailAllowedForCategory = emailAllowedForCategory;
// b340: the PARENT email allowlist is a separate list on purpose (see parent-notify.js) — the staff one above
// governs text that is sent as written; a parent's email is a fixed "something is waiting" note.
module.exports.parentEmailAllowedForCategory = require('./parent-notify').parentEmailAllowedForCategory;
