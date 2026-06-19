const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET /api/comms/summary — dashboard card data
router.get('/summary', async (req, res) => {
  const db = getPool();
  const result = { vapi_calls: [], emails: [], threads: [], unread_count: 0 };

  try {
    const { rows } = await db.query(
      `SELECT id, started_at, duration_seconds, from_number, summary, urgency
       FROM vapi_calls WHERE reviewed_at IS NULL ORDER BY started_at DESC LIMIT 5`
    );
    result.vapi_calls = rows;
  } catch {}

  try {
    const { rows } = await db.query(
      `SELECT id, from_email, from_name, subject, classification, suggested_draft, received_at
       FROM comms_email_queue
       WHERE status = 'pending'
       ORDER BY received_at DESC LIMIT 5`
    );
    result.emails = rows;
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
  } catch {}

  res.json(result);
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

// POST /api/comms/calls/:id/follow-up — creates a ladn.tasks row
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

// GET /api/comms/emails?from&status&page
router.get('/emails', async (req, res) => {
  const db = getPool();
  try {
    const { from, status = 'pending', page = 1 } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;
    const params = [];
    const conditions = [];

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
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
router.post('/emails/:id/send-draft', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE comms_email_queue
       SET status='sent', handled_at=NOW(), handled_by=$1
       WHERE id=$2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, email: rows[0] });
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
