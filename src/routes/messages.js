const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const https   = require('https');
const { getPool } = require('../db/pool');
const jwt = require('jsonwebtoken');

// ── Upload config ─────────────────────────────────────────────────────────────
const MSG_UPLOAD_BASE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'messages')
  : path.join(__dirname, '../../data/ladn/uploads/messages');

const msgStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(MSG_UPLOAD_BASE, String(req.params.id || 'tmp'));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `attach_${Date.now()}${ext}`);
  },
});
const msgUpload = multer({
  storage: msgStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, /^image\/(jpeg|png)$/.test(file.mimetype));
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function isOutOfHours() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun 6=Sat
  if (day === 0 || day === 6) return true;
  const h = now.getHours();
  return h < 8 || h >= 18;
}

async function sendTelegramMsg(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
  return new Promise(resolve => {
    const req = https.request(
      { hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { res.resume(); resolve(); }
    );
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

async function isBlocked(db, parentEmail) {
  if (!parentEmail) return false;
  const { rows } = await db.query('SELECT id FROM parent_message_blocks WHERE parent_email=$1', [parentEmail]);
  return rows.length > 0;
}

async function writeAudit(db, messageId, staffId, messageBody, hasAttachment) {
  try {
    await db.query(
      `INSERT INTO message_audit (message_id,staff_id,preview,has_attachment) VALUES ($1,$2,$3,$4)`,
      [messageId, staffId, (messageBody||'').slice(0,200), hasAttachment]
    );
  } catch {}
}

// Flexible auth: staff JWT or parent JWT — strict audience check per portal
const flexAuth = (req, res, next) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-wren-token'] || '';
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const expectedAud = req._portal || 'learning';
    if (!decoded.aud || decoded.aud !== expectedAud) {
      return res.status(401).json({ error: 'Invalid token audience' });
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

router.use(flexAuth);

// ── Messaging permission matrix (2026-07-03, Toby item 9) ────────────────────
// Defaults: apprentices cannot send anything; other staff can message both staff
// and parents; managers/deputies unrestricted; parents governed by their
// recipient options (management / key person) + the blocklist. Overridable via
// settings key 'messaging_permissions' (JSON), e.g.
//   {"apprentice_can_message": true, "staff_can_message_parents": false}
let _msgPermCache = { at: 0, val: null };
async function _msgPerms(db) {
  if (_msgPermCache.val && Date.now() - _msgPermCache.at < 60000) return _msgPermCache.val;
  const defaults = {
    apprentice_can_message: false,
    staff_can_message_parents: true,
    staff_can_message_staff: true,
  };
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='messaging_permissions'`);
    const overrides = rows.length ? JSON.parse(rows[0].value) : {};
    _msgPermCache = { at: Date.now(), val: Object.assign({}, defaults, overrides) };
  } catch (_) {
    _msgPermCache = { at: Date.now(), val: defaults };
  }
  return _msgPermCache.val;
}

router.use(async (req, res, next) => {
  if (req.method !== 'POST') return next();
  const p = req.path;
  const isSendPath =
    /^\/thread$/.test(p) || /^\/thread\/\d+\/reply(-photo)?$/.test(p) ||
    /^\/staff-thread$/.test(p) || /^\/broadcast$/.test(p) ||
    /^\/draft$/.test(p) || /^\/draft\/\d+\/confirm-send$/.test(p);
  if (!isSendPath) return next();
  const role = req.user.role;
  if (role === 'parent') return next();                                  // recipient rules + blocklist apply
  if (['manager', 'deputy_manager'].includes(role)) return next();       // management unrestricted
  const perms = await _msgPerms(getPool());
  if (role === 'apprentice' && !perms.apprentice_can_message) {
    return res.status(403).json({ error: 'Apprentices cannot send messages — please ask your room leader or a manager.' });
  }
  const staffFacing = /^\/staff-thread$/.test(p);
  if (staffFacing ? !perms.staff_can_message_staff : !perms.staff_can_message_parents) {
    return res.status(403).json({ error: 'Messaging is disabled for your role — please see a manager.' });
  }
  next();
});

// Notify the parent(s) of a child about a new staff message. Parent in-app
// notifications are keyed by CHILD id (parents authenticate per-child with
// JWT id=0, so recipient_id must be the child, not the user id).
function _notifyParentOfChild(childId, title, body) {
  if (!childId) return;
  try {
    const { notify: _notify } = require('../services/notification-dispatcher');
    _notify('message_received', 'parent', childId, title, (body || '').slice(0, 200),
      { relatedTable: 'children', relatedId: childId, link: '/messages.html' });
  } catch (_) {}
}

// GET /threads — parent sees their child's threads; staff sees parent threads (filtered by role)
router.get('/threads', async (req, res) => {
  try {
    const db = getPool();
    if (req.user.role === 'parent') {
      const { rows } = await db.query(`
        SELECT t.id, t.subject, t.last_message_at, t.created_at,
          c.first_name || ' ' || c.last_name as child_name,
          (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_type='staff') as unread_count
        FROM message_threads t
        JOIN children c ON c.id = t.child_id
        WHERE t.child_id=$1 AND (t.recipient_type IS NULL OR t.recipient_type != 'staff_group')
        ORDER BY t.last_message_at DESC
      `, [req.user.child_id]);
      return res.json(rows);
    }
    // Staff: manager sees all, others see nursery + directly addressed threads
    const isManager = ['manager', 'deputy_manager'].includes(req.user.role);
    let query, params;
    if (isManager) {
      query = `
        SELECT t.id, t.subject, t.last_message_at, t.created_at,
          c.first_name || ' ' || c.last_name as child_name, c.id as child_id,
          t.recipient_type,
          (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_type='parent') as unread_count
        FROM message_threads t
        JOIN children c ON c.id = t.child_id
        WHERE t.recipient_type != 'staff_group' OR t.recipient_type IS NULL
        ORDER BY t.last_message_at DESC
      `;
      params = [];
    } else {
      // Non-manager: only their assigned threads or threads for children in their room
      if (req.user.room_id) {
        query = `
          SELECT t.id, t.subject, t.last_message_at, t.created_at,
            c.first_name || ' ' || c.last_name as child_name, c.id as child_id,
            t.recipient_type,
            (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_type='parent') as unread_count
          FROM message_threads t
          JOIN children c ON c.id = t.child_id
          WHERE (t.recipient_staff_id=$1 OR c.room_id=$2)
            AND (t.recipient_type != 'staff_group' OR t.recipient_type IS NULL)
          ORDER BY t.last_message_at DESC
        `;
        params = [req.user.id, req.user.room_id];
      } else {
        query = `
          SELECT t.id, t.subject, t.last_message_at, t.created_at,
            c.first_name || ' ' || c.last_name as child_name, c.id as child_id,
            t.recipient_type,
            (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_type='parent') as unread_count
          FROM message_threads t
          JOIN children c ON c.id = t.child_id
          WHERE t.recipient_staff_id=$1
            AND (t.recipient_type != 'staff_group' OR t.recipient_type IS NULL)
          ORDER BY t.last_message_at DESC
        `;
        params = [req.user.id];
      }
    }
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /staff-threads — staff group chat threads
router.get('/staff-threads', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Staff only' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT t.id, t.subject, t.last_message_at, t.created_at,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_id != $1) as unread_count,
        (SELECT body FROM messages m2 WHERE m2.thread_id=t.id ORDER BY m2.created_at DESC LIMIT 1) as last_message
      FROM message_threads t
      WHERE t.recipient_type='staff_group'
      ORDER BY t.last_message_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /staff-thread/:id — get a staff group thread with messages (staff/manager)
router.get('/staff-thread/:id', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Staff only' });
  try {
    const db = getPool();
    const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1 AND recipient_type=\'staff_group\'', [req.params.id]);
    if (!threads.length) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(`
      SELECT m.*, s.first_name||' '||s.last_name as staff_name
      FROM messages m LEFT JOIN staff s ON s.id=m.sender_id
      WHERE m.thread_id=$1 ORDER BY m.created_at ASC
    `, [req.params.id]);
    res.json({ thread: threads[0], messages: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /staff-thread — create a new staff group chat topic
router.post('/staff-thread', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Staff only' });
  const { subject, body } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });
  try {
    const db = getPool();
    const { rows: [thread] } = await db.query(`
      INSERT INTO message_threads (subject, recipient_type, last_message_at)
      VALUES ($1,'staff_group',NOW()) RETURNING *
    `, [subject]);
    await db.query(`
      INSERT INTO messages (thread_id, sender_type, sender_id, body)
      VALUES ($1,'staff',$2,$3)
    `, [thread.id, req.user.id, body]);
    res.json(thread);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /thread/:id
router.get('/thread/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.id]);
    if (!threads.length) return res.status(404).json({ error: 'Not found' });
    const thread = threads[0];
    // Access check: parent can only see their child's threads
    if (req.user.role === 'parent' && thread.child_id !== req.user.child_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Non-manager staff: only threads assigned to them or for children in their room
    if (req.user.role !== 'parent' && !['manager','deputy_manager'].includes(req.user.role)) {
      const isDirectlyAssigned = thread.recipient_staff_id === req.user.id;
      const isStaffGroup = thread.recipient_type === 'staff_group';
      if (!isDirectlyAssigned && !isStaffGroup) {
        if (thread.child_id && req.user.room_id) {
          const childCheck = await db.query('SELECT room_id FROM children WHERE id=$1', [thread.child_id]);
          if (childCheck.rows[0]?.room_id !== req.user.room_id) {
            return res.status(403).json({ error: 'Forbidden' });
          }
        } else {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
    }
    const { rows } = await db.query(`
      SELECT m.*, s.first_name || ' ' || s.last_name as staff_name
      FROM messages m
      LEFT JOIN staff s ON s.id = m.sender_id
      WHERE m.thread_id=$1
      ORDER BY m.created_at ASC
    `, [req.params.id]);
    res.json({ thread, messages: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /thread — create new thread
router.post('/thread', async (req, res) => {
  const { child_id, subject, body, recipient_type } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  const effectiveChildId = req.user.role === 'parent' ? req.user.child_id : child_id;
  if (!effectiveChildId) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();

    // Resolve recipient
    let recipientType = recipient_type || 'nursery';
    let recipientStaffId = null;
    if (req.user.role === 'parent') {
      // Parents may only address the management team, their child's key person,
      // or the general nursery inbox (2026-07-03 rules) — and not while blocked.
      if (!['nursery', 'key_person', 'manager'].includes(recipientType)) recipientType = 'nursery';
      if (await isBlocked(db, req.user.name)) {
        return res.status(403).json({ error: 'Messaging is not available' });
      }
      if (recipientType === 'key_person') {
        const { rows } = await db.query('SELECT key_person_id FROM children WHERE id=$1', [effectiveChildId]);
        if (rows.length && rows[0].key_person_id) recipientStaffId = rows[0].key_person_id;
      } else if (recipientType === 'manager') {
        const { rows } = await db.query(`SELECT id FROM staff WHERE role='manager' AND is_active=true LIMIT 1`);
        if (rows.length) recipientStaffId = rows[0].id;
      }
    }

    const { rows: threadRows } = await db.query(`
      INSERT INTO message_threads (child_id, subject, recipient_type, recipient_staff_id, last_message_at)
      VALUES ($1,$2,$3,$4,NOW()) RETURNING *
    `, [effectiveChildId, subject || 'Message', recipientType, recipientStaffId]);
    const thread = threadRows[0];
    const senderType = req.user.role === 'parent' ? 'parent' : 'staff';
    const senderId = req.user.role === 'parent' ? null : req.user.id;
    const parentEmail = req.user.role === 'parent' ? req.user.name : null;
    const { rows: msgRows } = await db.query(`
      INSERT INTO messages (thread_id, sender_type, sender_id, parent_email, body)
      VALUES ($1,$2,$3,$4,$5) RETURNING id
    `, [thread.id, senderType, senderId, parentEmail, body]);

    // Notifications + audit on NEW threads (previously only replies notified)
    if (senderType === 'parent') {
      const { notify: _notify } = require('../services/notification-dispatcher');
      _notify('parent_message_received', 'all-managers', null,
        `New parent message: ${subject || 'Message'}`, body.slice(0, 200),
        { relatedTable: 'children', relatedId: effectiveChildId, link: `/messages.html` });
      if (recipientStaffId) {
        _notify('parent_message_received', 'staff', recipientStaffId,
          `New parent message: ${subject || 'Message'}`, body.slice(0, 200),
          { relatedTable: 'children', relatedId: effectiveChildId, link: `/messages.html` });
      }
      if (!isOutOfHours()) {
        await sendTelegramMsg(`💬 *New parent message*: ${subject || 'Message'}\nFrom: ${parentEmail || 'parent'}`).catch(() => {});
      }
    } else {
      await writeAudit(db, msgRows[0].id, req.user.id, body, false);
      _notifyParentOfChild(effectiveChildId, `New message from Little Angels`, body);
    }

    res.json(thread);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /thread/:id/reply — text only (JSON body)
router.post('/thread/:id/reply', async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  try {
    const db = getPool();
    const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.id]);
    if (!threads.length) return res.status(404).json({ error: 'Not found' });
    const thread = threads[0];
    if (req.user.role === 'parent' && thread.child_id !== req.user.child_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const isParent  = req.user.role === 'parent';
    const senderType  = isParent ? 'parent' : 'staff';
    const senderId    = isParent ? null : req.user.id;
    const parentEmail = isParent ? req.user.name : null;

    // Block list check
    if (isParent && await isBlocked(db, parentEmail)) {
      return res.status(403).json({ error: 'Messaging is not available' });
    }
    if (!isParent) {
      // Check if parent email associated with thread is blocked
      const { rows: thr } = await db.query(
        `SELECT COALESCE(c.parent_1_email,'') AS pemail FROM children c WHERE c.id=$1`, [thread.child_id]
      );
      if (thr.length && await isBlocked(db, thr[0].pemail)) {
        return res.status(403).json({ error: 'Messaging is blocked for this contact' });
      }
    }

    const { rows } = await db.query(`
      INSERT INTO messages (thread_id, sender_type, sender_id, parent_email, body)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [req.params.id, senderType, senderId, parentEmail, body]);
    const msg = rows[0];
    await db.query('UPDATE message_threads SET last_message_at=NOW() WHERE id=$1', [req.params.id]);

    // Audit all staff outbound messages
    if (!isParent) await writeAudit(db, msg.id, req.user.id, body, false);

    // Telegram notification — suppress out-of-hours
    if (isParent && !isOutOfHours()) {
      await sendTelegramMsg(`💬 *New parent message* in thread: ${thread.subject || 'Message'}\nFrom: ${parentEmail || 'parent'}`);
    }

    // Per-staff notification: parent_message_received → key person + managers
    if (isParent && thread.child_id) {
      const { notify: _notify } = require('../services/notification-dispatcher');
      _notify('parent_message_received', 'all-managers', null,
        `New parent message: ${thread.subject || 'Message'}`,
        body.slice(0, 200),
        { relatedTable: 'children', relatedId: thread.child_id,
          link: `/messages.html` }
      );
      // Also notify key person if assigned and not already a manager
      const { rows: kp } = await db.query(
        `SELECT key_person_id FROM children WHERE id=$1`, [thread.child_id]
      ).catch(() => ({ rows: [] }));
      if (kp[0]?.key_person_id) {
        _notify('parent_message_received', 'staff', kp[0].key_person_id,
          `New parent message: ${thread.subject || 'Message'}`,
          body.slice(0, 200),
          { relatedTable: 'children', relatedId: thread.child_id, link: `/messages.html` }
        );
      }
    }

    // Staff reply → in-app notification for the child's parent(s)
    if (!isParent && thread.child_id) {
      _notifyParentOfChild(thread.child_id, `New message from Little Angels`, body);
    }

    res.json(msg);
    // Dual-write to unified comms (fire-and-forget)
    _dualWriteMessage(db, {
      senderEmail: parentEmail, body, direction: isParent ? 'in' : 'out',
      staffId: isParent ? null : req.user.id,
    }).catch(() => {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /thread/:id/reply-photo — multipart upload (staff or parent can attach photo)
router.post('/thread/:id/reply-photo', msgUpload.single('photo'), async (req, res) => {
  try {
    const db = getPool();
    const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.id]);
    if (!threads.length) return res.status(404).json({ error: 'Not found' });
    const thread = threads[0];
    if (req.user.role === 'parent' && thread.child_id !== req.user.child_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const isParent  = req.user.role === 'parent';
    const parentEmail = isParent ? req.user.name : null;

    if (isParent && await isBlocked(db, parentEmail)) {
      return res.status(403).json({ error: 'Messaging is not available' });
    }

    const body    = (req.body && req.body.body) || '';
    const photoPath = req.file
      ? `/data/messages/${req.params.id}/${req.file.filename}`
      : null;
    const photoMime = req.file ? req.file.mimetype : null;

    // Staff photos with attachments go into pending_review queue
    const needsReview = !isParent && !!photoPath;

    const { rows } = await db.query(`
      INSERT INTO messages (thread_id, sender_type, sender_id, parent_email, body,
        attachment_path, attachment_mime, pending_review, review_decision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [
      req.params.id,
      isParent ? 'parent' : 'staff',
      isParent ? null : req.user.id,
      parentEmail,
      body,
      photoPath,
      photoMime,
      needsReview,
      needsReview ? 'pending' : null,
    ]);
    const msg = rows[0];
    await db.query('UPDATE message_threads SET last_message_at=NOW() WHERE id=$1', [req.params.id]);

    // Audit entry for staff
    if (!isParent) await writeAudit(db, msg.id, req.user.id, body, !!photoPath);

    if (needsReview) {
      // Notify manager of pending photo review
      try {
        await db.query(
          `INSERT INTO notifications (recipient_type,category,title,body,link,related_table,related_id,priority)
           VALUES ('all-managers','message','Staff photo pending review',
             $1,'/message-review.html','messages',$2,'high')`,
          [`${req.user.name||'Staff'} sent a photo in a parent thread — review required`, msg.id]
        );
      } catch {}
      return res.json({ ...msg, status: 'pending_review' });
    }

    // Parent photo — send immediately (no Telegram out-of-hours)
    if (isParent && !isOutOfHours()) {
      await sendTelegramMsg(`💬 *Parent sent a photo* in thread: ${thread.subject || 'Message'}`);
    }

    res.json(msg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /thread/:id/read
router.post('/thread/:id/read', async (req, res) => {
  try {
    const db = getPool();
    const threads = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.id]);
    if (!threads.rows.length) return res.status(404).json({ error: 'Not found' });
    const thread = threads.rows[0];
    if (req.user.role === 'parent' && thread.child_id !== req.user.child_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Mark as read messages from the other side
    const senderType = req.user.role === 'parent' ? 'staff' : 'parent';
    await db.query(`
      UPDATE messages SET is_read=true WHERE thread_id=$1 AND sender_type=$2
    `, [req.params.id, senderType]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /all-threads — manager sees ALL parent threads (no child filter)
router.get('/all-threads', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT t.id, t.subject, t.last_message_at, t.created_at, t.recipient_type,
        c.first_name||' '||c.last_name as child_name, c.id as child_id,
        s.first_name||' '||s.last_name as assigned_staff,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_type='parent') as unread_count,
        (SELECT body FROM messages m2 WHERE m2.thread_id=t.id ORDER BY m2.created_at DESC LIMIT 1) as last_body,
        (SELECT sender_type FROM messages m3 WHERE m3.thread_id=t.id ORDER BY m3.created_at DESC LIMIT 1) as last_sender_type,
        (SELECT first_name||' '||last_name FROM staff st WHERE st.id=(SELECT sender_id FROM messages m4 WHERE m4.thread_id=t.id AND m4.sender_type='staff' ORDER BY m4.created_at DESC LIMIT 1)) as last_staff_reply
      FROM message_threads t
      LEFT JOIN children c ON c.id=t.child_id
      LEFT JOIN staff s ON s.id=t.recipient_staff_id
      WHERE t.recipient_type != 'staff_group' OR t.recipient_type IS NULL
      ORDER BY t.last_message_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /broadcast — send message to all-parents or all-staff (creates thread per recipient)
router.post('/broadcast', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  const { subject, body, target } = req.body; // target: 'all_parents' | 'all_staff'
  if (!subject || !body || !target) return res.status(400).json({ error: 'subject, body, target required' });
  try {
    const db = getPool();
    let created = 0;
    if (target === 'all_parents') {
      const { rows: children } = await db.query(`SELECT DISTINCT child_id FROM parents WHERE is_active=true`).catch(async () => {
        // Fall back to children table if parents table doesn't exist
        const r = await db.query(`SELECT id as child_id FROM children WHERE is_active=true`);
        return r;
      });
      for (const c of children) {
        const { rows: [thread] } = await db.query(`
          INSERT INTO message_threads (child_id, subject, recipient_type, last_message_at)
          VALUES ($1,$2,'nursery',NOW()) RETURNING id
        `, [c.child_id, subject]);
        await db.query(`INSERT INTO messages (thread_id, sender_type, sender_id, body) VALUES ($1,'staff',$2,$3)`,
          [thread.id, req.user.id, body]);
        created++;
      }
    } else if (target === 'all_staff') {
      // Create a single staff_group broadcast thread
      const { rows: [thread] } = await db.query(`
        INSERT INTO message_threads (subject, recipient_type, last_message_at)
        VALUES ($1,'staff_group',NOW()) RETURNING id
      `, [subject]);
      await db.query(`INSERT INTO messages (thread_id, sender_type, sender_id, body) VALUES ($1,'staff',$2,$3)`,
        [thread.id, req.user.id, body]);
      created = 1;
    }
    res.json({ ok: true, created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /recipients — returns all parents (one per child) and all staff for compose dropdowns
router.get('/recipients', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Staff only' });
  try {
    const db = getPool();
    const { rows: children } = await db.query(`
      SELECT c.id as child_id,
        c.first_name || ' ' || c.last_name as child_name,
        COALESCE(c.parent_1_name, 'Parent') as parent_name,
        COALESCE(c.parent_1_email, '') as parent_email
      FROM children c
      WHERE c.is_active=true
        AND (c.parent_1_email IS NOT NULL AND c.parent_1_email != '')
      ORDER BY c.first_name, c.last_name
    `);
    const { rows: staff } = await db.query(`
      SELECT s.id, s.first_name || ' ' || s.last_name as name, s.role
      FROM staff s
      WHERE s.is_active=true
      ORDER BY s.first_name
    `);
    res.json({ parents: children, staff });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /thread/:id/message-read — mark a specific message as read
router.post('/message/:msgId/read', async (req, res) => {
  try {
    await getPool().query(
      `UPDATE messages SET read_at=NOW() WHERE id=$1 AND read_at IS NULL RETURNING id`,
      [req.params.msgId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /pending-photos — manager: list messages pending photo review
router.get('/pending-photos', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  try {
    const { rows } = await getPool().query(`
      SELECT m.*, t.subject, t.child_id,
        s.first_name||' '||s.last_name AS staff_name,
        c.first_name||' '||c.last_name AS child_name
      FROM messages m
      JOIN message_threads t ON t.id=m.thread_id
      LEFT JOIN staff s ON s.id=m.sender_id
      LEFT JOIN children c ON c.id=t.child_id
      WHERE m.pending_review=true AND m.review_decision='pending'
      ORDER BY m.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /message/:msgId/review — manager: approve or reject a pending photo message
router.post('/message/:msgId/review', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  const { decision, reason } = req.body;
  if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE messages SET review_decision=$1, pending_review=false WHERE id=$2 RETURNING *`,
      [decision, req.params.msgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const msg = rows[0];

    // Update audit row
    await db.query(
      `UPDATE message_audit SET manager_reviewed=true, reviewed_at=NOW(),
        reviewed_by_staff_id=$1, reviewed_decision=$2
       WHERE message_id=$3`,
      [req.user.id, decision, msg.id]
    );

    if (decision === 'rejected') {
      // Notify original sender
      await db.query(
        `INSERT INTO notifications (recipient_type,recipient_id,category,title,body,link,priority)
         VALUES ('staff',$1,'message','Photo message rejected',
           $2,'/messages.html','normal')`,
        [msg.sender_id, reason ? `Reason: ${reason}` : 'Your photo was not approved for delivery']
      );
    }
    res.json({ ok: true, decision });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /audit — manager: paginated audit log
router.get('/audit', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  try {
    const page = Math.max(0, parseInt(req.query.page || '0', 10));
    const { rows } = await getPool().query(`
      SELECT a.*,
        s.first_name||' '||s.last_name AS staff_name,
        m.body, m.attachment_path, m.created_at AS sent_at,
        t.subject AS thread_subject
      FROM message_audit a
      JOIN messages m ON m.id=a.message_id
      JOIN message_threads t ON t.id=m.thread_id
      LEFT JOIN staff s ON s.id=a.staff_id
      ORDER BY a.created_at DESC
      LIMIT 50 OFFSET $1
    `, [page * 50]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Block list management ────────────────────────────────────────────────────
router.get('/blocks', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  try {
    const { rows } = await getPool().query(
      `SELECT b.*,s.first_name||' '||s.last_name AS blocked_by_name
       FROM parent_message_blocks b
       LEFT JOIN staff s ON s.id=b.blocked_by_staff_id
       ORDER BY b.blocked_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/blocks', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  const { parent_email, reason } = req.body;
  if (!parent_email) return res.status(400).json({ error: 'parent_email required' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO parent_message_blocks (parent_email, blocked_by_staff_id, reason)
       VALUES ($1,$2,$3) ON CONFLICT (parent_email) DO UPDATE SET reason=$3 RETURNING *`,
      [parent_email.toLowerCase().trim(), req.user.id, reason || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/blocks/:id', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  try {
    await getPool().query('DELETE FROM parent_message_blocks WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI Draft / Confirm-send (P4 Actions B) ───────────────────────
// POST /draft — store a message as a draft (ai_draft=true, no send trigger)
// Staff review then confirm-send to actually dispatch.
router.post('/draft', async (req, res) => {
  const { thread_id, body, attachment_json } = req.body;
  if (!thread_id || !body) return res.status(400).json({ error: 'thread_id and body required' });
  try {
    const db = getPool();
    const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1', [thread_id]);
    if (!threads.length) return res.status(404).json({ error: 'Thread not found' });
    const thread = threads[0];

    // Staff can draft for their threads; parents can draft for their child's threads
    if (req.user.role === 'parent' && thread.child_id !== req.user.child_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role !== 'parent' && !['manager', 'deputy_manager'].includes(req.user.role)) {
      const isAssigned = thread.recipient_staff_id === req.user.id;
      const isStaffGroup = thread.recipient_type === 'staff_group';
      if (!isAssigned && !isStaffGroup && thread.child_id) {
        const childRoom = (await db.query('SELECT room_id FROM children WHERE id=$1', [thread.child_id])).rows[0]?.room_id;
        if (childRoom !== req.user.room_id) return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const senderType = req.user.role === 'parent' ? 'parent' : 'staff';
    const senderId = req.user.role === 'parent' ? null : req.user.id;
    const parentEmail = req.user.role === 'parent' ? req.user.name : null;

    const { rows } = await db.query(`
      INSERT INTO messages (thread_id, sender_type, sender_id, parent_email, body,
        ai_draft, pending_review, review_decision)
      VALUES ($1,$2,$3,$4,$5,true,true,'pending') RETURNING *
    `, [thread_id, senderType, senderId, parentEmail, body.slice(0, 10000)]);
    const draft = rows[0];

    // Notify staff that a draft needs review
    if (req.user.role !== 'parent') {
      const targetId = thread.recipient_staff_id || 1;
      await db.query(
        `INSERT INTO notifications (recipient_type,recipient_id,category,title,body,link,priority)
         VALUES ('all-managers',$1,'system','AI draft pending review',
           $2,'/messages.html','normal')`,
        [targetId, `Draft message in thread #${thread_id} — "${body.slice(0, 100)}"`]
      );
    }

    res.status(201).json({ ...draft, status: 'draft' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /draft/:id/confirm-send — staff confirms draft → actually send
router.post('/draft/:id/confirm-send', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT m.*, t.subject, t.child_id
      FROM messages m JOIN message_threads t ON t.id=m.thread_id
      WHERE m.id=$1 AND m.ai_draft=true
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Draft not found or already sent' });
    const msg = rows[0];
    const thread = { id: msg.thread_id, child_id: msg.child_id };

    // Auth check: same rules as reply
    if (req.user.role === 'parent' && thread.child_id !== req.user.child_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role !== 'parent' && !['manager', 'deputy_manager'].includes(req.user.role)) {
      const isAssigned = thread.recipient_staff_id === req.user.id;
      const isStaffGroup = thread.recipient_type === 'staff_group';
      if (!isAssigned && !isStaffGroup) {
        if (thread.child_id) {
          const childRoom = (await db.query('SELECT room_id FROM children WHERE id=$1', [thread.child_id])).rows[0]?.room_id;
          if (childRoom !== req.user.room_id) return res.status(403).json({ error: 'Forbidden' });
        } else {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
    }

    // Mark as sent, remove draft flags
    const { rows: sent } = await db.query(`
      UPDATE messages SET ai_draft=false, pending_review=false, review_decision='approved',
        body=body, created_at=NOW()
      WHERE id=$1 RETURNING *
    `, [req.params.id]);

    // Audit
    if (req.user.role !== 'parent') {
      await db.query(
        `INSERT INTO message_audit (message_id,staff_id,preview,has_attachment) VALUES ($1,$2,$3,$4)`,
        [sent[0].id, req.user.id, (sent[0].body || '').slice(0, 200), false]
      );
    }

    // Telegram notification (skip out-of-hours for parent-originated drafts)
    const isParent = req.user.role === 'parent';
    const isOOH = (() => {
      const now = new Date(); const day = now.getDay();
      if (day === 0 || day === 6) return true;
      return now.getHours() < 8 || now.getHours() >= 18;
    })();
    if (isParent && !isOOH) {
      await sendTelegramMsg(`✅ *Draft sent* — Parent message: ${thread.subject || ''}`);
    }

    // Notify key person + managers
    if (isParent && thread.child_id) {
      const { notify: _notify } = require('../services/notification-dispatcher');
      _notify('parent_message_received', 'all-managers', null,
        `Parent message sent: ${thread.subject || ''}`,
        (sent[0].body || '').slice(0, 200),
        { relatedTable: 'children', relatedId: thread.child_id, link: '/messages.html' }
      );
      const { rows: kp } = await db.query(`SELECT key_person_id FROM children WHERE id=$1`, [thread.child_id]).catch(() => ({ rows: [] }));
      if (kp[0]?.key_person_id) {
        _notify('parent_message_received', 'staff', kp[0].key_person_id,
          `Parent message sent: ${thread.subject || ''}`,
          (sent[0].body || '').slice(0, 200),
          { relatedTable: 'children', relatedId: thread.child_id, link: '/messages.html' }
        );
      }
    }

    // Update thread last_message_at
    await db.query('UPDATE message_threads SET last_message_at=NOW() WHERE id=$1', [thread.id]);

    res.json({ ...sent[0], status: 'sent' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /drafts — list pending drafts for this user
router.get('/drafts', async (req, res) => {
  try {
    const db = getPool();
    let query, params;
    if (req.user.role === 'parent') {
      query = `
        SELECT m.*, t.subject, c.first_name||' '||c.last_name as child_name
        FROM messages m
        JOIN message_threads t ON t.id=m.thread_id
        JOIN children c ON c.id=t.child_id
        WHERE m.ai_draft=true
          AND t.child_id=$1
        ORDER BY m.created_at DESC
      `;
      params = [req.user.child_id];
    } else if (['manager', 'deputy_manager'].includes(req.user.role)) {
      query = `
        SELECT m.*, t.subject, t.child_id, c.first_name||' '||c.last_name as child_name,
          s.first_name||' '||s.last_name as sender_name
        FROM messages m
        JOIN message_threads t ON t.id=m.thread_id
        LEFT JOIN children c ON c.id=t.child_id
        LEFT JOIN staff s ON s.id=m.sender_id
        WHERE m.ai_draft=true
        ORDER BY m.created_at DESC
      `;
      params = [];
    } else {
      query = `
        SELECT m.*, t.subject, t.child_id
        FROM messages m
        JOIN message_threads t ON t.id=m.thread_id
        WHERE m.ai_draft=true
          AND (m.sender_id=$1 OR t.recipient_staff_id=$1)
        ORDER BY m.created_at DESC
      `;
      params = [req.user.id];
    }
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function _dualWriteMessage(db, { senderEmail, body, direction, staffId }) {
  if (!senderEmail) return;
  const { upsertContact, upsertThread, insertThreadMessage } = require('./contacts');
  const contactId = await upsertContact(db, {
    email: senderEmail, phone: null, name: null, status: 'enrolled',
  });
  const threadId = await upsertThread(db, contactId, 'Parent messages');
  await insertThreadMessage(db, {
    threadId, direction, source: 'parents_portal',
    bodyText: body, senderEmail,
    staffId: staffId || null,
  });
}

module.exports = router;
