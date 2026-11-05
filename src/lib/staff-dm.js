'use strict';
// ===========================================================================
// staff-dm.js — b358 (2026-09-29). Send a staff-to-staff message from server
// code, without going back through HTTP.
//
// WHY THIS EXISTS. The brief asks that an assignee gets "an in-app notification
// + an EY/HR message" when work is put on them. The notification half is the
// dispatcher's job. The message half already exists as POST /api/messages
// /staff-dm — but that is a route handler, and the Action Plan bridge is server
// code, so it cannot call it without making an HTTP request to itself.
//
// WHY IT IS NOT A REFACTOR OF messages.js. The obvious move would be to lift
// the body of that route into a shared helper and have both call it. That would
// mean rewriting a live 1400-line route file that carries the parent messaging
// rules, the blocklist and the audit trail — exactly the kind of edit the house
// rules forbid. So this file is additive and messages.js is untouched: the two
// write the same rows, in the same shape, and this one is deliberately the
// smaller of the two (no attachments, no parent recipients, no blocklist —
// it can only ever address one member of staff).
//
// AUDIT. messages.js writes its audit row through a logAudit() helper that is
// defined INSIDE that file and is therefore not importable. This writes the
// same ladn.message_audit columns directly (action/actor_type/thread_id/
// preview), so a message sent by the bridge is as auditable as one typed by a
// person. If message_audit is missing or shaped differently in some edition the
// insert is swallowed — a failed audit row must never lose the message itself.
// ===========================================================================

const PREVIEW_MAX = 500;

/**
 * Send a 1:1 staff message, reusing the existing thread between these two
 * people if there is one (the same de-duplication rule as POST /staff-dm, so
 * the bridge does not spawn a second thread beside a human conversation).
 *
 * Returns { thread_id, message_id } or null when it could not be sent. Never
 * throws: a message is a courtesy on top of the notification, and failing to
 * send one must not fail the assignment that triggered it.
 */
async function sendStaffDm(db, fromStaffId, toStaffId, subject, body) {
  // `Number(null)` is 0, not NaN — so a naive Number(fromStaffId) turns a
  // system-sent message (no human actor, which is exactly what the overdue
  // sweep passes) into sender_id = 0 and violates messages_sender_id_fkey.
  // Normalise to a real positive id or NULL, and never to 0.
  const rawFrom = fromStaffId == null || fromStaffId === '' ? null : Number(fromStaffId);
  const from = Number.isInteger(rawFrom) && rawFrom > 0 ? rawFrom : null;
  const to   = Number(toStaffId);
  const text = String(body == null ? '' : body).trim();
  if (!Number.isInteger(to) || to <= 0 || !text) return null;
  if (from !== null && from === to) return null;   // never message yourself

  try {
    // The recipient has to be a real, active member of staff.
    const { rows: rc } = await db.query(
      'SELECT id FROM staff WHERE id = $1 AND is_active = true', [to]);
    if (!rc.length) return null;

    let threadId = null;

    // Reuse an existing 1:1 thread between exactly these two, when we know who
    // the sender is. A system-sent message with no human sender gets its own
    // thread addressed to the recipient instead.
    if (from !== null) {
      const { rows: existing } = await db.query(`
        SELECT t.id FROM message_threads t
         WHERE t.recipient_type = 'staff_direct'
           AND (SELECT COUNT(*) FROM message_thread_participants p WHERE p.thread_id = t.id) = 2
           AND EXISTS (SELECT 1 FROM message_thread_participants p WHERE p.thread_id = t.id AND p.staff_id = $1)
           AND EXISTS (SELECT 1 FROM message_thread_participants p WHERE p.thread_id = t.id AND p.staff_id = $2)
         ORDER BY t.id LIMIT 1`, [from, to]);
      if (existing.length) threadId = existing[0].id;
    }

    if (!threadId) {
      const { rows: [thread] } = await db.query(`
        INSERT INTO message_threads (subject, recipient_type, recipient_staff_id, last_message_at)
        VALUES ($1, 'staff_direct', $2, NOW()) RETURNING id`,
        [String(subject || 'Action Plan').slice(0, 200), to]);
      threadId = thread.id;
      // Both people are participants, so it appears in each of their
      // GET /staff-threads lists and either can reply on the normal route.
      if (from !== null) {
        await db.query(`
          INSERT INTO message_thread_participants (thread_id, staff_id, added_by)
          VALUES ($1,$2,$2),($1,$3,$2)
          ON CONFLICT (thread_id, staff_id) DO NOTHING`, [threadId, from, to]);
      } else {
        await db.query(`
          INSERT INTO message_thread_participants (thread_id, staff_id, added_by)
          VALUES ($1,$2,NULL)
          ON CONFLICT (thread_id, staff_id) DO NOTHING`, [threadId, to]);
      }
    }

    const { rows: [msg] } = await db.query(`
      INSERT INTO messages (thread_id, sender_type, sender_id, body)
      VALUES ($1,'staff',$2,$3) RETURNING id`,
      [threadId, from, text]);
    await db.query('UPDATE message_threads SET last_message_at = NOW() WHERE id = $1', [threadId]);

    // Same columns messages.js's logAudit writes. Best effort by design.
    try {
      await db.query(`
        INSERT INTO message_audit (message_id, thread_id, staff_id, actor_type, action, preview, has_attachment)
        VALUES ($1,$2,$3,'staff','send',$4,false)`,
        [msg.id, threadId, from, text.slice(0, PREVIEW_MAX)]);
    } catch (e) {
      console.error('[staff-dm] audit row failed (message still sent):', e.message);
    }

    return { thread_id: threadId, message_id: msg.id };
  } catch (e) {
    console.error('[staff-dm] send failed:', e.message);
    return null;
  }
}

module.exports = { sendStaffDm };
