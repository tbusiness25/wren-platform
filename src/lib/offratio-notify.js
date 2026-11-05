'use strict';
/**
 * offratio-notify.js — b189 (2026-08-19).
 *
 * Turns the off-ratio entries that logSurplusDay() wrote into (a) a TASK owned by
 * the room leader and (b) a NOTIFICATION, using the machinery that already exists:
 * ladn.tasks and services/notification-dispatcher. NO new cron and no new delivery
 * channel — the nightly report engine calls this, and the dispatcher's own 30s
 * poller does the sending.
 *
 * Addressing: the room leader resolved by offratio.resolveRoomLeader(). Where a room
 * has nobody attached the entry escalates to all-managers rather than being dropped —
 * an unanswerable question is still better than a silent one.
 *
 * Idempotent: offratio_log.notified_at is stamped on success and rows already stamped
 * are skipped, so a re-run of the nightly job does not re-nag anyone.
 */

const offratio = require('./offratio');

let _notifyAsync = null;
try { _notifyAsync = require('../services/notification-dispatcher').notifyAsync; } catch (e) { _notifyAsync = null; }

const CATEGORY = 'offratio_account_due';
const LINK = '/rota.html#offratio';

function bodyFor(entry, detail) {
  const lines = [
    `${entry.prompt}.`,
    '',
    'That is time when the room had more staff than the booked children required.',
    'It is usually deliberate and usually good — settling a new child, SEND support,',
    'planning, supervision, deep-cleaning, a student on top of the count.',
    '',
    'Please record which, in a sentence. The entry stays outstanding until you do —',
    'not as a criticism, but so the setting can answer the question at all.',
  ];
  if (detail && Array.isArray(detail.slots) && detail.slots.length) {
    const worst = detail.slots.slice().sort((a, b) => b.delta - a.delta)[0];
    if (worst) {
      lines.push('', `Busiest surplus slot: ${worst.slot} — ${worst.staff} staff for `
        + `${worst.children} children (${worst.required} required).`);
    }
  }
  if (detail && detail.deficit_minutes) {
    lines.push('', `Note: the same day also had ${offratio.humanMinutes(detail.deficit_minutes)} `
      + 'BELOW ratio in this room. Surplus and shortfall are reported separately and never '
      + 'netted off against each other.');
  }
  return lines.join('\n');
}

/**
 * @param db     pg pool
 * @param result the object returned by offratio.logSurplusDay()
 * @returns      [{ offratio_id, staff_id, task_id, notified }]
 */
async function notifyOffRatio(db, result) {
  const created = (result && result.created) || [];
  const out = [];

  for (const c of created) {
    // Skip anything already notified — makes a nightly re-run safe.
    const { rows: existing } = await db.query(
      'SELECT id, notified_at, account, detail, surplus_minutes, room_id, date FROM offratio_log WHERE id = $1',
      [c.id]);
    if (!existing.length || existing[0].notified_at || existing[0].account) continue;

    const entry = {
      prompt: offratio.promptLine(result.date, c.room_name || `Room ${c.room_id}`, c.surplus_minutes),
    };
    const title = `Off-ratio time to account for — ${entry.prompt}`;
    const body = bodyFor(entry, existing[0].detail);

    // ── Task (existing tasks machinery) ──────────────────────────────────────
    // due the next morning, source_ref keys back to the log row so it is not
    // duplicated if this runs twice.
    let taskId = null;
    try {
      const ref = `offratio:${c.id}`;
      const { rows: dupe } = await db.query(
        "SELECT id FROM tasks WHERE source = 'offratio' AND source_ref = $1", [ref]);
      if (dupe.length) {
        taskId = dupe[0].id;
      } else {
        const { rows: t } = await db.query(
          `INSERT INTO tasks (title, description, status, priority, due_date, owner_staff_id,
                              created_by, source, source_ref, linked_to, linked_id, time_of_day)
           VALUES ($1, $2, 'open', 'medium', $3::date, $4, NULL, 'offratio', $5, 'offratio_log', $6, 'morning')
           RETURNING id`,
          [title, body, result.date, c.room_leader_id || null, ref, c.id]);
        taskId = t[0].id;
      }
    } catch (e) {
      console.error('[offratio-notify] task insert failed:', e.message);
    }

    // ── Notification (existing dispatcher) ───────────────────────────────────
    let notified = false;
    try {
      if (_notifyAsync) {
        await _notifyAsync(
          CATEGORY,
          c.room_leader_id ? 'staff' : 'all-managers',
          c.room_leader_id || null,
          title, body,
          { relatedTable: 'offratio_log', relatedId: c.id, link: LINK, priority: 'normal' });
      } else {
        await db.query(
          `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link,
                                      related_table, related_id, priority)
           VALUES ($1, $2, $3, $4, $5, $6, 'offratio_log', $7, 'normal')`,
          [c.room_leader_id ? 'staff' : 'all-managers', c.room_leader_id || null,
           CATEGORY, title, body, LINK, c.id]);
      }
      notified = true;
      await db.query('UPDATE offratio_log SET notified_at = now() WHERE id = $1', [c.id]);
    } catch (e) {
      console.error('[offratio-notify] notify failed:', e.message);
    }

    out.push({ offratio_id: c.id, room_id: c.room_id, staff_id: c.room_leader_id || null,
               task_id: taskId, notified });
  }
  return out;
}

module.exports = { notifyOffRatio, CATEGORY, LINK, bodyFor };
