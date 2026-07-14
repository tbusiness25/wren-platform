const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const gmail = require('../lib/gmail-sender');
const { sendEmail } = require('../lib/notifications');
const { isAllowedRecipient, isManagerRole, getAllowedEmails } = require('../lib/email-allowlist');

router.use(authenticate);

// GET /api/comms/validate-recipient?email=... — client-side recipient check.
// Non-blocking helper for the compose UI: returns whether THIS user may email the
// address. Managers always allowed. Never echoes any other parent's address.
router.get('/validate-recipient', async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email query param required' });
  try {
    const allowed = await isAllowedRecipient(email, req.user);
    res.json({ email, allowed, manager: isManagerRole(req.user) });
  } catch (e) {
    res.status(500).json({ error: 'validation failed' });
  }
});

// GET /api/comms/summary — dashboard card data + morning-briefing counts
router.get('/summary', async (req, res) => {
  const db = getPool();
  const result = {
    vapi_calls: [], emails: [], threads: [], enquiries: [], unread_count: 0,
    counts: { calls_unreviewed: 0, emails_pending: 0, emails_need_reply: 0,
              messages_unread: 0, enquiries_open: 0 },
  };

  try {
    const { rows } = await db.query(
      `SELECT id, started_at, duration_seconds, from_number, summary, urgency
       FROM vapi_calls WHERE reviewed_at IS NULL ORDER BY started_at DESC LIMIT 5`
    );
    result.vapi_calls = rows;
  } catch {}
  try {
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM vapi_calls WHERE reviewed_at IS NULL`);
    result.counts.calls_unreviewed = rows[0]?.n || 0;
  } catch {}

  try {
    const { rows } = await db.query(
      `SELECT id, from_email, from_name, subject, classification, category, importance,
              summary, suggested_action, suggested_draft, suggested_replies, direction, received_at
       FROM comms_email_queue
       WHERE status = 'pending' AND (direction = 'in' OR direction IS NULL)
       ORDER BY importance DESC NULLS LAST, received_at DESC LIMIT 10`
    );
    result.emails = rows;
  } catch {}
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS pending,
              COUNT(*) FILTER (WHERE direction='in' AND suggested_action IN ('reply-now','reply-soon'))::int AS need_reply
       FROM comms_email_queue WHERE status='pending'`
    );
    result.counts.emails_pending = rows[0]?.pending || 0;
    result.counts.emails_need_reply = rows[0]?.need_reply || 0;
  } catch {}

  // Website enquiries that still need a response (no reply logged, open stage).
  try {
    const { rows } = await db.query(
      `SELECT id, parent_name, parent_email, parent_phone, child_first_name, child_last_name,
              room_needed, preferred_room, message, notes, source, stage, status, ai_score,
              created_at, replied_at
       FROM enquiries
       WHERE replied_at IS NULL
         AND COALESCE(stage, status, 'new') NOT IN ('enrolled','lost','closed','declined')
       ORDER BY created_at DESC LIMIT 10`
    );
    result.enquiries = rows;
  } catch {}
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM enquiries
       WHERE replied_at IS NULL AND COALESCE(stage, status, 'new') NOT IN ('enrolled','lost','closed','declined')`
    );
    result.counts.enquiries_open = rows[0]?.n || 0;
  } catch {}

  try {
    const { rows } = await db.query(
      `SELECT mt.id, mt.subject,
              c.first_name || ' ' || c.last_name AS child_name,
              mt.last_message_at,
              (SELECT COUNT(*) FROM messages m
               WHERE m.thread_id = mt.id AND m.is_read = false AND m.sender_type = 'parent') AS unread
       FROM message_threads mt
       LEFT JOIN children c ON c.id = mt.child_id
       WHERE EXISTS (
         SELECT 1 FROM messages m
         WHERE m.thread_id = mt.id AND m.is_read = false AND m.sender_type = 'parent'
       )
       ORDER BY mt.last_message_at DESC LIMIT 3`
    );
    result.threads = rows;
    result.unread_count = rows.reduce((s, t) => s + parseInt(t.unread || 0), 0);
    result.counts.messages_unread = result.unread_count;
  } catch {}

  res.json(result);
});

// ── Enquiries (website / phone enquiries from enquiries) ──────────────────

// GET /api/comms/enquiries?status&page — unified into the comms stream
router.get('/enquiries', async (req, res) => {
  const db = getPool();
  try {
    const { status, page = 1 } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;
    const params = [];
    const conditions = [];

    if (status === 'open') {
      conditions.push(`(replied_at IS NULL AND COALESCE(stage, status, 'new') NOT IN ('enrolled','lost','closed','declined'))`);
    } else if (status === 'replied') {
      conditions.push(`replied_at IS NOT NULL`);
    } else if (status && status !== 'all') {
      params.push(status);
      conditions.push(`COALESCE(stage, status) = $${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit); params.push(offset);

    const { rows } = await db.query(
      `SELECT e.id, e.parent_name, e.parent_email, e.parent_phone,
              e.child_first_name, e.child_last_name, e.child_dob,
              e.room_needed, e.preferred_room, e.preferred_start_date, e.start_date_requested,
              e.message, e.notes, e.source, e.stage, e.status, e.ai_score, e.ai_score_reason,
              e.created_at, e.updated_at, e.replied_at,
              s.first_name || ' ' || s.last_name AS replied_by_name
       FROM enquiries e
       LEFT JOIN staff s ON s.id = e.replied_by
       ${where}
       ORDER BY e.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM enquiries e ${where}`, countParams
    );
    res.json({ enquiries: rows, total: parseInt(countRows[0].total), page: parseInt(page), limit });
  } catch (err) {
    console.error('comms enquiries error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/enquiries/:id/reply — send an email reply to an enquirer + log it
router.post('/enquiries/:id/reply', async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT * FROM enquiries WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const enq = rows[0];
    const recipient = (enq.parent_email || '').trim();
    if (!recipient) return res.status(400).json({ error: 'Enquiry has no email address' });

    // Staff email blocklist: non-managers may only email parents of enrolled children.
    if (!(await isAllowedRecipient(recipient, req.user))) {
      return res.status(403).json({ error: 'recipient_not_parent',
        message: 'Staff can only email parents of enrolled children' });
    }

    const subject = `Little Angels Day Nursery — your enquiry`;
    const html = `<div style="font-family:system-ui,Arial,sans-serif;line-height:1.6">${String(body).replace(/\n/g, '<br>')}</div>`;
    let sent = false, info = '';
    try {
      if (gmail.isConfigured()) {
        const r = await gmail.sendViaGmail({ to: recipient, subject, html, text: body });
        sent = !!(r && r.ok); info = r && r.messageId ? `gmail:${r.messageId}` : 'gmail';
      } else {
        sent = await sendEmail(recipient, subject, html, 'enquiry-reply'); info = 'sendEmail';
      }
    } catch (e) {
      return res.status(502).json({ error: 'Send failed: ' + e.message });
    }
    if (!sent) return res.status(502).json({ error: 'Send failed (no transport delivered the message)' });

    await db.query(
      `UPDATE enquiries SET replied_at=NOW(), replied_by=$2,
         stage = CASE WHEN COALESCE(stage,'new') = 'new' THEN 'contacted' ELSE stage END
       WHERE id=$1`,
      [enq.id, req.user.id]
    );
    res.json({ ok: true, sent_to: recipient, via: info });
  } catch (err) {
    console.error('comms enquiry reply error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Calls ─────────────────────────────────────────────────────────────────────

// GET /api/comms/calls?from&to&urgency&reviewed&page
router.get('/calls', async (req, res) => {
  const db = getPool();
  try {
    const { from, to, urgency, reviewed, page = 1 } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    const params = [];
    const conditions = [];

    if (from) {
      params.push(from);
      conditions.push(`vc.started_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`vc.started_at <= ($${params.length}::date + interval '1 day')`);
    }
    if (urgency) {
      params.push(urgency);
      conditions.push(`vc.urgency = $${params.length}`);
    }
    if (reviewed === 'yes') {
      conditions.push('vc.reviewed_at IS NOT NULL');
    } else if (reviewed === 'no') {
      conditions.push('vc.reviewed_at IS NULL');
    }

    const { safeguarding } = req.query;
    if (safeguarding === 'yes') conditions.push('vc.safeguarding_flagged = true');

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    params.push(limit);
    params.push(offset);
    const { rows } = await db.query(
      `SELECT vc.*,
              s.first_name || ' ' || s.last_name AS reviewed_by_name
       FROM vapi_calls vc
       LEFT JOIN staff s ON s.id = vc.reviewed_by
       ${where}
       ORDER BY vc.started_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM vapi_calls vc ${where}`,
      countParams
    );

    res.json({ calls: rows, total: parseInt(countRows[0].total), page: parseInt(page), limit });
  } catch (err) {
    console.error('comms calls error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/calls/:id/reviewed
router.post('/calls/:id/reviewed', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE vapi_calls SET reviewed_by=$1, reviewed_at=NOW() WHERE id=$2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('comms calls reviewed error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/calls/:id/follow-up — creates a tasks row
router.post('/calls/:id/follow-up', async (req, res) => {
  const { task_title, due_date } = req.body;
  if (!task_title) return res.status(400).json({ error: 'task_title required' });
  const db = getPool();
  try {
    const { rows: [task] } = await db.query(
      `INSERT INTO tasks (title, source, source_ref, linked_to, created_by, status, priority, due_date)
       VALUES ($1,'vapi_call',$2,'vapi_call',$3,'open','medium',$4) RETURNING *`,
      [task_title, req.params.id, req.user.id, due_date || null]
    );
    res.status(201).json(task);
  } catch (err) {
    console.error('comms follow-up error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Emails ────────────────────────────────────────────────────────────────────

// GET /api/comms/emails?from&status&direction&page
router.get('/emails', async (req, res) => {
  const db = getPool();
  try {
    const { from, status = 'pending', direction, page = 1 } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;
    const params = [];
    const conditions = [];

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (direction === 'in') {
      conditions.push(`(direction = 'in')`);
    } else if (direction === 'out') {
      conditions.push(`(direction = 'out' OR direction IS NULL)`);
    }
    if (from) {
      params.push(from);
      conditions.push(`received_at >= $${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit);
    params.push(offset);

    const { rows } = await db.query(
      `SELECT eq.*,
              s.first_name || ' ' || s.last_name AS handled_by_name
       FROM comms_email_queue eq
       LEFT JOIN staff s ON s.id = eq.handled_by
       ${where}
       ORDER BY eq.received_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM comms_email_queue ${where}`,
      countParams
    );

    res.json({ emails: rows, total: parseInt(countRows[0].total), page: parseInt(page), limit });
  } catch (err) {
    console.error('comms emails error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/emails/:id/send-draft
// Body (all optional): { reply_index: 0|1|2 } to pick an A/B/C suggested reply,
// or { draft_text } for explicit text. For INBOUND rows this ACTUALLY sends the
// chosen reply to the original sender via the Gmail API (threaded), then marks
// the row 'sent'. For outbound rows it sends to to_email. If the send fails the
// row is NOT marked sent (so it can be retried).
router.post('/emails/:id/send-draft', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT * FROM comms_email_queue WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];

    // Pick the body to send: explicit text > chosen A/B/C reply > stored draft.
    let bodyText = (req.body && req.body.draft_text) || null;
    const idx = req.body && req.body.reply_index;
    if (!bodyText && (idx === 0 || idx === 1 || idx === 2) && Array.isArray(row.suggested_replies) && row.suggested_replies[idx]) {
      bodyText = row.suggested_replies[idx].text;
    }
    if (!bodyText) bodyText = row.draft_text || row.suggested_draft || null;

    const isInbound = row.direction === 'in' || (!row.to_email && row.from_email);
    const recipient = (row.to_email || row.from_email || '').trim();

    if (!recipient) return res.status(400).json({ error: 'No recipient address on this email' });
    if (!bodyText)  return res.status(400).json({ error: 'No draft text to send' });

    // Staff email blocklist: non-managers may only email parents of enrolled children.
    if (!(await isAllowedRecipient(recipient, req.user))) {
      return res.status(403).json({ error: 'recipient_not_parent',
        message: 'Staff can only email parents of enrolled children' });
    }

    let subject = row.subject || 'Little Angels Day Nursery';
    if (isInbound && !/^re:/i.test(subject)) subject = 'Re: ' + subject;
    const html = `<div style="font-family:system-ui,Arial,sans-serif;line-height:1.6">${String(bodyText).replace(/\n/g, '<br>')}</div>`;

    // Send — prefer threaded Gmail API for inbound replies, else shared sendEmail.
    let sent = false, sendInfo = '';
    try {
      if (gmail.isConfigured()) {
        const wantThread = isInbound ? (row.thread_id || undefined) : undefined;
        let r;
        try {
          r = await gmail.sendViaGmail({ to: recipient, subject, html, text: bodyText, threadId: wantThread });
        } catch (te) {
          // A stale/invalid Gmail threadId must not block the reply — resend unthreaded.
          if (wantThread && /thread/i.test(te.message || '')) {
            r = await gmail.sendViaGmail({ to: recipient, subject, html, text: bodyText });
          } else { throw te; }
        }
        sent = !!(r && r.ok);
        sendInfo = r && r.messageId ? `gmail:${r.messageId}` : 'gmail';
      } else {
        sent = await sendEmail(recipient, subject, html, 'comms-reply');
        sendInfo = 'sendEmail';
      }
    } catch (e) {
      console.error('comms send-draft delivery error:', e.message);
      await db.query(
        `UPDATE comms_email_queue SET last_error=$2, send_attempts=COALESCE(send_attempts,0)+1 WHERE id=$1`,
        [row.id, e.message]
      ).catch(() => {});
      return res.status(502).json({ error: 'Send failed: ' + e.message });
    }

    if (!sent) {
      return res.status(502).json({ error: 'Send failed (no transport delivered the message)' });
    }

    // The email is already delivered — never let a post-send bookkeeping error
    // leave the row 'pending' (it would be re-sent). Mark sent; if the
    // handled_by FK fails (e.g. user not in staff), retry without it.
    let upd;
    try {
      ({ rows: upd } = await db.query(
        `UPDATE comms_email_queue
           SET status='sent', draft_text=$2, handled_at=NOW(), handled_by=$3, sent_at=NOW(),
               send_attempts=COALESCE(send_attempts,0)+1, last_error=NULL
         WHERE id=$1 RETURNING *`,
        [row.id, bodyText, req.user.id]
      ));
    } catch (ue) {
      ({ rows: upd } = await db.query(
        `UPDATE comms_email_queue
           SET status='sent', draft_text=$2, handled_at=NOW(), sent_at=NOW(),
               send_attempts=COALESCE(send_attempts,0)+1, last_error=NULL
         WHERE id=$1 RETURNING *`,
        [row.id, bodyText]
      ));
    }
    res.json({ ok: true, sent_to: recipient, via: sendInfo, email: upd[0] });
  } catch (err) {
    console.error('comms send-draft error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/emails/:id/edit-draft
router.post('/emails/:id/edit-draft', async (req, res) => {
  const { draft_text } = req.body;
  if (!draft_text) return res.status(400).json({ error: 'draft_text required' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE comms_email_queue SET draft_text=$1 WHERE id=$2 RETURNING *`,
      [draft_text, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('comms edit-draft error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/emails/:id/ignore
router.post('/emails/:id/ignore', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE comms_email_queue
       SET status='ignored', handled_at=NOW(), handled_by=$1
       WHERE id=$2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('comms ignore error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Messages ──────────────────────────────────────────────────────────────────

// GET /api/comms/messages?child_id&staff_id&search&page
router.get('/messages', async (req, res) => {
  const db = getPool();
  try {
    const { child_id, staff_id, search, page = 1 } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;
    const params = [];
    const conditions = ["(t.recipient_type != 'staff_group' OR t.recipient_type IS NULL)"];

    if (child_id) {
      params.push(parseInt(child_id));
      conditions.push(`t.child_id = $${params.length}`);
    }
    if (staff_id) {
      params.push(parseInt(staff_id));
      conditions.push(`t.recipient_staff_id = $${params.length}`);
    }
    if (search) {
      params.push('%' + search + '%');
      conditions.push(`(t.subject ILIKE $${params.length} OR c.first_name ILIKE $${params.length} OR c.last_name ILIKE $${params.length})`);
    }

    const where = 'WHERE ' + conditions.join(' AND ');
    params.push(limit);
    params.push(offset);

    const { rows } = await db.query(
      `SELECT t.id, t.subject, t.last_message_at, t.created_at, t.recipient_type,
              c.first_name || ' ' || c.last_name AS child_name, c.id AS child_id,
              s.first_name || ' ' || s.last_name AS assigned_staff,
              (SELECT COUNT(*) FROM messages m
               WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_type='parent') AS unread_count,
              (SELECT body FROM messages m2
               WHERE m2.thread_id=t.id ORDER BY m2.created_at DESC LIMIT 1) AS last_body,
              (SELECT sender_type FROM messages m3
               WHERE m3.thread_id=t.id ORDER BY m3.created_at DESC LIMIT 1) AS last_sender_type
       FROM message_threads t
       LEFT JOIN children c ON c.id = t.child_id
       LEFT JOIN staff s ON s.id = t.recipient_staff_id
       ${where}
       ORDER BY t.last_message_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total
       FROM message_threads t
       LEFT JOIN children c ON c.id = t.child_id
       ${where}`,
      countParams
    );

    res.json({ threads: rows, total: parseInt(countRows[0].total), page: parseInt(page), limit });
  } catch (err) {
    console.error('comms messages error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/comms/messages/:thread_id
router.get('/messages/:thread_id', async (req, res) => {
  const db = getPool();
  try {
    const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.thread_id]);
    if (!threads.length) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(
      `SELECT m.*, s.first_name || ' ' || s.last_name AS staff_name
       FROM messages m LEFT JOIN staff s ON s.id = m.sender_id
       WHERE m.thread_id=$1 ORDER BY m.created_at ASC`,
      [req.params.thread_id]
    );
    await db.query(
      `UPDATE messages SET is_read=true WHERE thread_id=$1 AND sender_type='parent'`,
      [req.params.thread_id]
    );
    res.json({ thread: threads[0], messages: rows });
  } catch (err) {
    console.error('comms thread error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/messages — create new outbound message thread
router.post('/messages', async (req, res) => {
  const { child_id, subject, body } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  const db = getPool();
  try {
    const { rows: threads } = await db.query(
      `INSERT INTO message_threads (child_id, subject, last_message_at)
       VALUES ($1, $2, NOW()) RETURNING *`,
      [child_id || null, subject || 'Message from nursery']
    );
    const thread = threads[0];
    const { rows: msgs } = await db.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body)
       VALUES ($1,'staff',$2,$3) RETURNING *`,
      [thread.id, req.user.id, body]
    );
    res.json({ thread, message: msgs[0] });
  } catch (err) {
    console.error('comms new message error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/messages/:thread_id/reply
router.post('/messages/:thread_id/reply', async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  const db = getPool();
  try {
    const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.thread_id]);
    if (!threads.length) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body)
       VALUES ($1,'staff',$2,$3) RETURNING *`,
      [req.params.thread_id, req.user.id, body]
    );
    await db.query('UPDATE message_threads SET last_message_at=NOW() WHERE id=$1', [req.params.thread_id]);
    res.json(rows[0]);
  } catch (err) {
    console.error('comms reply error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

module.exports = router;
