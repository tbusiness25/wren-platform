const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const https   = require('https');
const { getPool } = require('../db/pool');
const jwt = require('jsonwebtoken');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
// A parent may have several children (siblings). Their token carries child_ids;
// fall back to the single child_id for older tokens.
const ownIds = u => (u && u.child_ids && u.child_ids.length) ? u.child_ids : (u && u.child_id != null ? [u.child_id] : []);

// ── Upload config ─────────────────────────────────────────────────────────────
const MSG_UPLOAD_BASE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'messages')
  : path.join(__dirname, '../../data/ladn/uploads/messages');

const ATTACH_EXT = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};
const msgStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(MSG_UPLOAD_BASE, String(req.params.id || 'tmp'));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    // sec-20261026: extension from the (filtered) mimetype, never from the
    // client's filename — `x.html` declared as application/pdf was stored and
    // later served as `.html`.
    const ext = Object.assign({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
                   'image/gif': '.gif' }, ATTACH_EXT)[file.mimetype] || '.jpg';
    cb(null, `attach_${Date.now()}${ext}`);
  },
});
// sec-20261026: `:id` is URL-decoded by express and was joined straight onto
// MSG_UPLOAD_BASE by the destination above, so /thread/..%2F..%2F…/reply-photo
// created a directory and wrote the upload anywhere on disk (as root), before
// the thread-ownership check ran. Thread ids are integers; refuse anything else
// before multer is reached.
function _numericThreadId(req, res, next) {
  if (!/^\d+$/.test(String(req.params.id || ''))) return res.status(400).json({ error: 'Invalid thread id' });
  next();
}
const msgUpload = multer({
  storage: msgStorage,
  limits: { fileSize: 10 * 1024 * 1024 },   // 10MB — images + PDFs
  fileFilter(req, file, cb) {
    // 2026-10-28 (Toby): documents as well as images — PDF, Word, Excel.
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) || !!ATTACH_EXT[file.mimetype]);
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

// login-20261023: through the one Telegram sender (src/lib/notifications.js), which carries the dev guard.
async function sendTelegramMsg(text) { await require('../lib/notifications').sendTelegramNow({ text, parse_mode: 'Markdown' }); }

async function isBlocked(db, parentEmail) {
  if (!parentEmail) return false;
  const { rows } = await db.query('SELECT id FROM parent_message_blocks WHERE parent_email=$1', [parentEmail]);
  return rows.length > 0;
}

// ── Full audit trail (send / edit / read / block / review) ────────────────────
// message_audit is enriched additively with action/actor_type/thread_id/detail
// columns. The ensure runs lazily & idempotently (ADD COLUMN IF NOT EXISTS) so
// this deploys cleanly to any environment without a separate migration step.
let _auditSchemaReady = false;
async function ensureAuditSchema(db) {
  if (_auditSchemaReady) return true;
  try {
    await db.query(`
      ALTER TABLE message_audit ADD COLUMN IF NOT EXISTS action     text;
      ALTER TABLE message_audit ADD COLUMN IF NOT EXISTS actor_type text;
      ALTER TABLE message_audit ADD COLUMN IF NOT EXISTS thread_id  integer;
      ALTER TABLE message_audit ADD COLUMN IF NOT EXISTS detail     text;
      ALTER TABLE message_audit ADD COLUMN IF NOT EXISTS archived_at timestamptz; -- 2026-07-24: archive log entries
    `);
    _auditSchemaReady = true;
    return true;
  } catch (_) { return false; }
}

// ── Per-user thread archive (b107) ────────────────────────────────────────────
// Archiving hides a thread for THAT user only — never deletes. Keyed per
// participant: staff → (user_kind='staff', user_id=staff.id); a child's parents
// share (user_kind='parent', user_id=thread.child_id) since a thread has exactly
// one child. Table self-creates idempotently (mirrors ensureAuditSchema) so it
// deploys with no separate migration step.
let _archiveSchemaReady = false;
async function ensureArchiveSchema(db) {
  if (_archiveSchemaReady) return true;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS message_archive (
        thread_id   integer NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
        user_kind   text    NOT NULL,
        user_id     integer NOT NULL,
        archived_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (thread_id, user_kind, user_id)
      );
      CREATE INDEX IF NOT EXISTS message_archive_user_idx ON message_archive(user_kind, user_id);
    `);
    _archiveSchemaReady = true;
    return true;
  } catch (_) { return false; }
}

// Resolve the archive key (kind + id) for the current user on a given thread.
// Returns null when the user has no valid participant key (defensive).
function _archiveKey(thread, user) {
  if (user.role === 'parent') {
    return thread && thread.child_id != null ? { kind: 'parent', id: thread.child_id } : null;
  }
  return user.id != null ? { kind: 'staff', id: user.id } : null;
}

// Auto-unarchive a thread for its RECIPIENTS when a new message lands on it
// (standard email behaviour) — the sender's own archive row is left untouched.
async function _autoUnarchive(db, threadId, sender) {
  if (!sender) return;
  try {
    await ensureArchiveSchema(db);
    await db.query(
      `DELETE FROM message_archive WHERE thread_id=$1 AND NOT (user_kind=$2 AND user_id=$3)`,
      [threadId, sender.kind, sender.id == null ? -1 : sender.id]
    );
  } catch (_) {}
}

// Central audit writer. Records ANY messaging action. message_id may be null
// (e.g. block/unblock events that aren't tied to a single message).
async function logAudit(db, {
  action, messageId = null, threadId = null, staffId = null,
  actorType = 'staff', preview = '', hasAttachment = false, detail = null,
}) {
  const ok = await ensureAuditSchema(db);
  const prev = (preview || '').slice(0, 200);
  try {
    if (ok) {
      await db.query(
        `INSERT INTO message_audit
           (message_id, staff_id, preview, has_attachment, action, actor_type, thread_id, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [messageId, staffId, prev, hasAttachment, action, actorType, threadId, detail]
      );
    } else {
      // Legacy fallback (columns not yet migrated) — never lose the core record.
      await db.query(
        `INSERT INTO message_audit (message_id,staff_id,preview,has_attachment) VALUES ($1,$2,$3,$4)`,
        [messageId, staffId, prev, hasAttachment]
      );
    }
  } catch (_) {}
}

// Back-compat shim — existing call sites keep working, now enriched as 'send'.
async function writeAudit(db, messageId, staffId, messageBody, hasAttachment, threadId) {
  await logAudit(db, {
    action: 'send', messageId, threadId, staffId,
    actorType: 'staff', preview: messageBody, hasAttachment,
  });
}

// ── AI draft (LOCAL Ollama only — GDPR: never leaves the sovereign box) ───────
const ai = require('../lib/ai-models');
const OLLAMA_HOST     = ai.host();
// Drafting a parent-message reply → ai-models.js role 'heavy', resolved per call.
// (b333: was AI_DRAFT_MODEL / gpt-oss:120b, no longer installed.)
const AI_DRAFT_MODEL  = () => ai.model('heavy');
function callOllamaChat(messages, model, timeoutMs) {
  const url = new URL('/v1/chat/completions', OLLAMA_HOST);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || AI_DRAFT_MODEL(), messages, temperature: 0.2, max_tokens: 700 }),
    signal: AbortSignal.timeout(timeoutMs || 60000),
  }).then(r => {
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    return r.json();
  });
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

// GET /attachment/:threadId/:filename is exempted (bughunt 2026-07-21) — every real
// caller renders it as a plain <img src>/<a href>, which browsers never attach an
// Authorization header to, so it always 401'd. It gets its own header-or-?token=
// check further down, right next to the thread-ownership check it already has.
router.use((req, res, next) => {
  if (req.method === 'GET' && /^\/attachment\//.test(req.path)) return next();
  return flexAuth(req, res, next);
});

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
    /^\/staff-thread$/.test(p) || /^\/staff-dm$/.test(p) || /^\/broadcast$/.test(p) ||
    /^\/draft$/.test(p) || /^\/draft\/\d+\/confirm-send$/.test(p);
  if (!isSendPath) return next();
  const role = req.user.role;
  if (role === 'parent') return next();                                  // recipient rules + blocklist apply
  if (['manager', 'deputy_manager', 'admin'].includes(role)) return next();       // management unrestricted
  const perms = await _msgPerms(getPool());
  if (role === 'apprentice' && !perms.apprentice_can_message) {
    return res.status(403).json({ error: 'Apprentices cannot send messages — please ask your room leader or a manager.' });
  }
  // staff-thread (group) and staff-dm (1:1 colleague DM) are both staff-facing.
  const staffFacing = /^\/staff-thread$/.test(p) || /^\/staff-dm$/.test(p);
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

// Parent email-reply gateway (2026-08-04): in addition to the in-app notification
// above, email the parent a copy IF their delivery preference is 'email'/'both'.
// The email carries a token-bearing Reply-To so a plain reply routes back onto this
// thread (see scripts/parent-email-reply-poll.js). Best-effort; never throws.
// Dark-launch gated by PARENT_EMAIL_REPLIES=on.
async function _emailParentOfThread(threadId, childId, body) {
  if (process.env.PARENT_EMAIL_REPLIES !== 'on' || !threadId || !childId) return;
  try {
    const mailer = require('../lib/gmail-sender');
    if (!mailer.isConfigured || !mailer.isConfigured()) return;
    const { makeToken, replyToAddress } = require('../lib/parent-reply-token');
    const db = getPool();
    const { rows } = await db.query(
      `SELECT c.first_name,
              lower(nullif(c.parent_1_email,''))       AS e1,
              lower(nullif(c.parent_2_email,''))       AS e2,
              lower(nullif(c.primary_contact_email,'')) AS e3
         FROM children c WHERE c.id=$1`, [childId]);
    if (!rows.length) return;
    const first = rows[0].first_name || 'your child';
    const emails = [...new Set([rows[0].e1, rows[0].e2, rows[0].e3].filter(Boolean))];
    if (!emails.length) return;
    // Which of these parents opted into email? Default 'app' => no email.
    const { rows: prefs } = await db.query(
      `SELECT parent_email, delivery_mode FROM parent_comms_prefs WHERE parent_email = ANY($1)`, [emails]);
    const modeOf = new Map(prefs.map(p => [p.parent_email, p.delivery_mode]));
    const wantEmail = emails.filter(e => ['email', 'both'].includes(modeOf.get(e) || 'app'));
    if (!wantEmail.length) return;

    const token   = makeToken(threadId, childId);
    const replyTo = `Your Nursery <${replyToAddress(token)}>`;
    const portal  = 'https://parents.example-nursery.co.uk/messages.html';
    const safe    = String(body || '').replace(/[<>&]/g, s => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[s]));
    const html = `<p>You have a new message from Your Nursery about <strong>${first}</strong>:</p>`
      + `<blockquote style="border-left:3px solid #4a9abf;margin:0;padding:6px 14px;color:#334155">${safe.replace(/\n/g, '<br>')}</blockquote>`
      + `<p><strong>Just reply to this email</strong> and your response will appear in your Your Nursery app — the staff will see it there. `
      + `You can also <a href="${portal}">open the app</a>.</p>`
      + `<p style="font-size:12px;color:#94a3b8">This mailbox is monitored during nursery hours. Please don't include anything you'd want kept out of your child's record.</p>`;
    const text = `New message from Your Nursery about ${first}:\n\n${body}\n\n`
      + `Just reply to this email and your response will appear in your Your Nursery app. Or open ${portal}`;
    for (const to of wantEmail) {
      await mailer.sendViaGmail({
        to, replyTo, subject: `Your Nursery — new message about ${first}`,
        html, text, fromName: 'Your Nursery',
      }).catch(e => console.error('[parent-email] send failed', to, e.message));
    }
  } catch (e) { console.error('[parent-email] _emailParentOfThread error:', e.message); }
}

// GET /threads — parent sees their child's threads; staff sees parent threads (filtered by role)
// ── Undo send, and delivery receipts (2026-09-23) ─────────────────────────────
// Toby: "similar to how Gmail has it where you can undo the send for 5 seconds, as sometimes
// I need that because I make mistakes."
//
// The message is WRITTEN straight away — losing it to a closed tab would be worse than
// sending it — but it is invisible to the recipient until held_until passes. Retracting
// inside the window sets retracted_at and it is never delivered. After the window it cannot
// be retracted, because by then someone may have read it, and un-saying a read message is a
// promise software cannot keep.
//
// Only a human's own message is held. A system or automated insert goes straight out.
async function undoSeconds(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'message_undo_seconds'`);
    const n = parseInt(rows[0] && rows[0].value, 10);
    return Number.isFinite(n) && n >= 0 && n <= 120 ? n : 5;
  } catch (_) { return 5; }
}
/** A recipient sees a message only once the hold has passed and it was not retracted. */
// 2026-10-28: a draft (ai_draft) or a message waiting for a manager's OK (pending_review +
// review_decision 'pending') is visible to its own sender only — before this a parent saw both.
const VISIBLE_SQL = `(m.retracted_at IS NULL AND (m.held_until IS NULL OR m.held_until <= now())
  AND COALESCE(m.ai_draft, false) = false
  AND NOT (COALESCE(m.pending_review, false) AND COALESCE(m.review_decision, '') = 'pending'))`;

router.get('/threads', async (req, res) => {
  try {
    const db = getPool();
    await ensureArchiveSchema(db);
    // ?archived=1 shows the archived list; default hides archived threads.
    const showArchived = /^(1|true)$/i.test(String(req.query.archived || ''));
    const archCond = showArchived ? 'ar.thread_id IS NOT NULL' : 'ar.thread_id IS NULL';
    if (req.user.role === 'parent') {
      const { rows } = await db.query(`
        SELECT t.id, t.subject, t.last_message_at, t.created_at,
          c.first_name || ' ' || c.last_name as child_name,
          (ar.thread_id IS NOT NULL) AS archived,
          (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_type='staff') as unread_count,
          (SELECT body FROM messages m2 WHERE m2.thread_id=t.id ORDER BY m2.created_at DESC LIMIT 1) as last_message
        FROM message_threads t
        JOIN children c ON c.id = t.child_id
        LEFT JOIN message_archive ar ON ar.thread_id=t.id AND ar.user_kind='parent' AND ar.user_id=t.child_id
        WHERE t.child_id = ANY($1) AND (t.recipient_type IS NULL OR t.recipient_type != 'staff_group')
          AND ${archCond}
        ORDER BY t.last_message_at DESC
      `, [ownIds(req.user)]);
      return res.json(rows);
    }
    // Staff: manager sees all, others see nursery + directly addressed threads
    const isManager = hasRole(req.user, ['manager', 'deputy_manager', 'admin']);
    let query, params;
    if (isManager) {
      query = `
        SELECT t.id, t.subject, t.last_message_at, t.created_at,
          c.first_name || ' ' || c.last_name as child_name, c.id as child_id,
          t.recipient_type,
          (ar.thread_id IS NOT NULL) AS archived,
          (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_type='parent') as unread_count,
          (SELECT body FROM messages m2 WHERE m2.thread_id=t.id ORDER BY m2.created_at DESC LIMIT 1) as last_message
        FROM message_threads t
        JOIN children c ON c.id = t.child_id
        LEFT JOIN message_archive ar ON ar.thread_id=t.id AND ar.user_kind='staff' AND ar.user_id=$1
        WHERE (t.recipient_type != 'staff_group' OR t.recipient_type IS NULL)
          AND ${archCond}
        ORDER BY t.last_message_at DESC
      `;
      params = [req.user.id];
    } else {
      // Non-manager: only their assigned threads or threads for children in their room
      if (req.user.room_id) {
        query = `
          SELECT t.id, t.subject, t.last_message_at, t.created_at,
            c.first_name || ' ' || c.last_name as child_name, c.id as child_id,
            t.recipient_type,
            (ar.thread_id IS NOT NULL) AS archived,
            (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_type='parent') as unread_count,
            (SELECT body FROM messages m2 WHERE m2.thread_id=t.id ORDER BY m2.created_at DESC LIMIT 1) as last_message
          FROM message_threads t
          JOIN children c ON c.id = t.child_id
          LEFT JOIN message_archive ar ON ar.thread_id=t.id AND ar.user_kind='staff' AND ar.user_id=$1
          WHERE (t.recipient_staff_id=$1 OR (c.room_id=$2 AND (t.recipient_type IS NULL OR t.recipient_type NOT IN ('management','manager'))) OR t.id IN (SELECT thread_id FROM message_thread_participants WHERE staff_id=$1))
            AND (t.recipient_type != 'staff_group' OR t.recipient_type IS NULL)
            AND ${archCond}
          ORDER BY t.last_message_at DESC
        `;
        params = [req.user.id, req.user.room_id];
      } else {
        query = `
          SELECT t.id, t.subject, t.last_message_at, t.created_at,
            c.first_name || ' ' || c.last_name as child_name, c.id as child_id,
            t.recipient_type,
            (ar.thread_id IS NOT NULL) AS archived,
            (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_type='parent') as unread_count,
            (SELECT body FROM messages m2 WHERE m2.thread_id=t.id ORDER BY m2.created_at DESC LIMIT 1) as last_message
          FROM message_threads t
          JOIN children c ON c.id = t.child_id
          LEFT JOIN message_archive ar ON ar.thread_id=t.id AND ar.user_kind='staff' AND ar.user_id=$1
          WHERE (t.recipient_staff_id=$1 OR t.id IN (SELECT thread_id FROM message_thread_participants WHERE staff_id=$1))
            AND (t.recipient_type != 'staff_group' OR t.recipient_type IS NULL)
            AND ${archCond}
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
    await ensureArchiveSchema(db);
    const showArchived = /^(1|true)$/i.test(String(req.query.archived || ''));
    const archCond = showArchived ? 'ar.thread_id IS NOT NULL' : 'ar.thread_id IS NULL';
    const isManager = hasRole(req.user, ['manager', 'deputy_manager', 'admin']);
    // Returns BOTH shared staff_group threads and the current user's 1:1
    // staff_direct DMs (they/re a participant). For a DM the display subject is
    // the OTHER participant's name so it reads like a person-to-person chat. A
    // DM is private to its two participants — a manager who is not a participant
    // does NOT see it here (unlike group threads, which managers see all of).
    const { rows } = await db.query(`
      SELECT t.id,
        CASE WHEN t.recipient_type='staff_direct' THEN
          COALESCE((SELECT s.first_name||' '||s.last_name
                      FROM message_thread_participants p
                      JOIN staff s ON s.id=p.staff_id
                     WHERE p.thread_id=t.id AND p.staff_id<>$1
                     ORDER BY p.added_at LIMIT 1), t.subject, 'Direct message')
        ELSE t.subject END AS subject,
        t.recipient_type,
        t.last_message_at, t.created_at,
        (ar.thread_id IS NOT NULL) AS archived,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_id IS DISTINCT FROM $1) as unread_count,
        (SELECT body FROM messages m2 WHERE m2.thread_id=t.id ORDER BY m2.created_at DESC LIMIT 1) as last_message
      FROM message_threads t
      LEFT JOIN message_archive ar ON ar.thread_id=t.id AND ar.user_kind='staff' AND ar.user_id=$1
      WHERE (
          (t.recipient_type='staff_group'
            AND (t.recipient_staff_id IS NULL OR t.recipient_staff_id=$1 OR $2))
          OR (t.recipient_type='staff_direct'
            AND t.id IN (SELECT thread_id FROM message_thread_participants WHERE staff_id=$1))
        )
        AND ${archCond}
      ORDER BY t.last_message_at DESC
    `, [req.user.id, isManager]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /staff-thread/:id — get a staff group thread with messages (staff/manager)
// Directly-addressed threads (recipient_staff_id set, e.g. an email-gateway reply)
// are only visible to that staff member or a manager — everyone else gets 404,
// same as an unaddressed (broadcast) staff_group thread stays open to all staff.
router.get('/staff-thread/:id', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Staff only' });
  try {
    const db = getPool();
    const { rows: threads } = await db.query(
      "SELECT * FROM message_threads WHERE id=$1 AND recipient_type IN ('staff_group','staff_direct')",
      [req.params.id]);
    if (!threads.length) return res.status(404).json({ error: 'Not found' });
    const isManager = hasRole(req.user, ['manager', 'deputy_manager', 'admin']);
    if (threads[0].recipient_type === 'staff_direct') {
      // A 1:1 DM is visible ONLY to its two participants — not even to a
      // non-participant manager (private colleague conversation).
      const { rows: pp } = await db.query(
        'SELECT 1 FROM message_thread_participants WHERE thread_id=$1 AND staff_id=$2',
        [req.params.id, req.user.id]);
      if (!pp.length) return res.status(404).json({ error: 'Not found' });
    } else if (threads[0].recipient_staff_id != null && threads[0].recipient_staff_id !== req.user.id && !isManager) {
      return res.status(404).json({ error: 'Not found' });
    }
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

// POST /staff-dm — true 1:1 staff-to-staff direct message (2026-08-04).
// Creates (or reuses) a recipient_type='staff_direct' thread with BOTH the
// sender and the recipient recorded in message_thread_participants, so each
// sees it in GET /staff-threads and can reply via POST /thread/:id/reply.
// Body: { recipient_staff_id, subject?, body }. child_id stays NULL.
router.post('/staff-dm', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Staff only' });
  const recipientId = parseInt(req.body && req.body.recipient_staff_id, 10);
  const body    = String((req.body && req.body.body) || '').trim();
  const subject = String((req.body && req.body.subject) || '').trim();
  if (!recipientId || !body) return res.status(400).json({ error: 'recipient_staff_id and body required' });
  if (recipientId === req.user.id) return res.status(400).json({ error: 'Cannot message yourself' });
  try {
    const db = getPool();
    const { rows: rc } = await db.query(
      `SELECT id, first_name, last_name FROM staff WHERE id=$1 AND is_active=true`, [recipientId]);
    if (!rc.length) return res.status(404).json({ error: 'Recipient not found' });

    // Reuse an existing 1:1 thread between exactly these two staff (avoids dupes).
    const { rows: existing } = await db.query(`
      SELECT t.id FROM message_threads t
      WHERE t.recipient_type='staff_direct'
        AND (SELECT COUNT(*) FROM message_thread_participants p WHERE p.thread_id=t.id)=2
        AND EXISTS (SELECT 1 FROM message_thread_participants p WHERE p.thread_id=t.id AND p.staff_id=$1)
        AND EXISTS (SELECT 1 FROM message_thread_participants p WHERE p.thread_id=t.id AND p.staff_id=$2)
      ORDER BY t.id LIMIT 1
    `, [req.user.id, recipientId]);

    let threadId;
    if (existing.length) {
      threadId = existing[0].id;
    } else {
      const { rows: [thread] } = await db.query(`
        INSERT INTO message_threads (subject, recipient_type, recipient_staff_id, last_message_at)
        VALUES ($1,'staff_direct',$2,NOW()) RETURNING id
      `, [subject || 'Direct message', recipientId]);
      threadId = thread.id;
      await db.query(`
        INSERT INTO message_thread_participants (thread_id, staff_id, added_by)
        VALUES ($1,$2,$2),($1,$3,$2)
        ON CONFLICT (thread_id, staff_id) DO NOTHING
      `, [threadId, req.user.id, recipientId]);
    }

    const { rows: [msg] } = await db.query(`
      INSERT INTO messages (thread_id, sender_type, sender_id, body)
      VALUES ($1,'staff',$2,$3) RETURNING *
    `, [threadId, req.user.id, body]);
    await db.query('UPDATE message_threads SET last_message_at=NOW() WHERE id=$1', [threadId]);
    await writeAudit(db, msg.id, req.user.id, body, false, threadId);
    // New message → auto-unarchive for the recipient (never the sender).
    _autoUnarchive(db, threadId, { kind: 'staff', id: req.user.id }).catch(() => {});

    // Notify the recipient (in-app bell in every portal + push/telegram per prefs).
    try {
      const { notify: _notify } = require('../services/notification-dispatcher');
      const { rows: me } = await db.query(
        `SELECT first_name||' '||last_name AS name FROM staff WHERE id=$1`, [req.user.id]);
      const senderName = (me[0] && me[0].name) || 'A colleague';
      _notify('message_received', 'staff', recipientId,
        `New message from ${senderName}`, body.slice(0, 200),
        { relatedTable: 'staff', relatedId: req.user.id, link: '/messages.html' });
    } catch (_) { /* notifications optional */ }

    res.json({ thread_id: threadId, message: msg, reused: existing.length > 0 });
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
    if (req.user.role === 'parent' && !ownIds(req.user).includes(thread.child_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // 29 Oct: a 1:1 staff DM is its two participants' only — the /staff-thread/:id rule — but here
    // a manager could read any private colleague conversation.
    if (thread.recipient_type === 'staff_direct'
        && !(await db.query('SELECT 1 FROM message_thread_participants WHERE thread_id=$1 AND staff_id=$2', [thread.id, req.user.id])).rows.length) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Non-manager staff: only threads assigned to them or for children in their room
    if (req.user.role !== 'parent' && !hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
      const isDirectlyAssigned = thread.recipient_staff_id === req.user.id;
      // 29 Oct: a staff_group thread ADDRESSED to one person (the inbox poller files replies to a
      // colleague's outgoing email this way) is theirs, not the whole team's.
      const isStaffGroup = thread.recipient_type === 'staff_group' && !thread.recipient_staff_id;
      // Threads a parent deliberately routed to management (2026-07-16 rule) are
      // NOT visible via the room fallback below — only to the assigned manager
      // or an actual manager/deputy_manager (handled above).
      const isManagementRouted = ['management','manager'].includes(thread.recipient_type);
      // A staff member explicitly added to the thread (secondary staff) can always see it.
      const _pr = await db.query('SELECT 1 FROM message_thread_participants WHERE thread_id=$1 AND staff_id=$2', [req.params.id, req.user.id]);
      const isParticipant = _pr.rows.length > 0;
      if (!isDirectlyAssigned && !isStaffGroup && !isParticipant) {
        if (isManagementRouted) {
          return res.status(403).json({ error: 'Forbidden' });
        }
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
    // A sender always sees their own message, including while it is held — otherwise it looks
    // like it failed to send. Everyone else sees it only once the hold has passed.
    const _meStaff = req.user.role === 'parent' ? null : req.user.id;
    const { rows } = await db.query(`
      SELECT m.*, s.first_name || ' ' || s.last_name as staff_name
      FROM messages m
      LEFT JOIN staff s ON s.id = m.sender_id
      WHERE m.thread_id=$1
        AND (${VISIBLE_SQL} OR ($2::int IS NOT NULL AND m.sender_id = $2 AND m.retracted_at IS NULL))
      ORDER BY m.created_at ASC
    `, [req.params.id, _meStaff]);

    // Delivery receipt: the recipient has now actually received these. Not the sender's own,
    // and never re-stamped, so "received" keeps meaning the first time it reached them.
    db.query(`
      UPDATE messages SET delivered_at = now()
       WHERE thread_id = $1 AND delivered_at IS NULL AND retracted_at IS NULL
         AND (held_until IS NULL OR held_until <= now())
         AND sender_type <> $2`,
      [req.params.id, req.user.role === 'parent' ? 'parent' : 'staff']).catch(() => {});

    res.json({ thread, messages: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /thread/:id/add-staff — add a secondary staff member to a parent thread (2026-07-30).
// Managers, or staff already on the thread (assigned/participant), can add a colleague.
// Additive: only GRANTS the added staff visibility — never changes the primary recipient.
router.post('/thread/:id/add-staff', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Staff only' });
  const staffId = parseInt(req.body && req.body.staff_id, 10);
  if (!staffId) return res.status(400).json({ error: 'staff_id required' });
  try {
    const db = getPool();
    const { rows: th } = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.id]);
    if (!th.length) return res.status(404).json({ error: 'Not found' });
    const thread = th[0];
    const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
    const _p = await db.query('SELECT 1 FROM message_thread_participants WHERE thread_id=$1 AND staff_id=$2', [req.params.id, req.user.id]);
    if (!(isManager || thread.recipient_staff_id === req.user.id || _p.rows.length > 0)) {
      return res.status(403).json({ error: 'Not allowed to add staff to this thread' });
    }
    await db.query(
      `INSERT INTO message_thread_participants (thread_id, staff_id, added_by) VALUES ($1,$2,$3)
       ON CONFLICT (thread_id, staff_id) DO NOTHING`, [req.params.id, staffId, req.user.id]);
    try {
      await db.query(
        `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, priority)
         VALUES ('staff',$1,'message','Added to a conversation',$2,'normal')`,
        [staffId, `You've been added to the message thread "${thread.subject || 'Parent conversation'}".`]);
    } catch (_) { /* notifications optional */ }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /thread/:id/participants — staff currently on a thread
router.get('/thread/:id/participants', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Staff only' });
  try {
    const db = getPool();
    // 29 Oct: had no thread check — anyone could list who is in whose private conversation.
    const { rows: [thread] } = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.id]);
    if (!(await _canAccessThread(db, thread, req.user))) return res.status(403).json({ error: 'Forbidden' });
    const { rows } = await db.query(
      `SELECT p.staff_id, s.first_name||' '||s.last_name AS name, p.added_at
         FROM message_thread_participants p LEFT JOIN staff s ON s.id=p.staff_id
        WHERE p.thread_id=$1 ORDER BY p.added_at`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /thread — create new thread
router.post('/thread', async (req, res) => {
  const { child_id, subject, body, recipient_type } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  // Parents may target ANY of their own children (siblings) via child_id; validated
  // against their token's child_ids. Defaults to the primary child.
  const _myIds = ownIds(req.user);
  const effectiveChildId = req.user.role === 'parent'
    ? (child_id != null && _myIds.includes(Number(child_id)) ? Number(child_id) : req.user.child_id)
    : child_id;
  if (!effectiveChildId) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();

    // Resolve recipient
    let recipientType = recipient_type || 'room_leader';
    let recipientStaffId = null;
    if (req.user.role === 'parent') {
      // Parents may address their child's ROOM LEADER, their KEY PERSON, or MANAGEMENT
      // (2026-07-16 rules) — and not while blocked. Legacy nursery/manager map onto these.
      if (recipientType === 'nursery') recipientType = 'room_leader';
      if (recipientType === 'manager') recipientType = 'management';
      if (!['room_leader', 'key_person', 'management'].includes(recipientType)) recipientType = 'room_leader';
      if (await isBlocked(db, req.user.name)) {
        return res.status(403).json({ error: 'Messaging is not available' });
      }
      if (recipientType === 'key_person') {
        const { rows } = await db.query('SELECT key_person_id FROM children WHERE id=$1', [effectiveChildId]);
        if (rows.length && rows[0].key_person_id) recipientStaffId = rows[0].key_person_id;
      } else if (recipientType === 'room_leader') {
        // Route to the leader of the CHILD'S room (Baby Room → the deputy, Pre-school → the room leader).
        const { rows } = await db.query(
          `SELECT s.id FROM staff s JOIN children c ON c.room_id = s.room_id
           WHERE c.id=$1 AND s.role='deputy_manager' AND s.is_active=true
           ORDER BY s.id LIMIT 1`, [effectiveChildId]);
        if (rows.length) recipientStaffId = rows[0].id;
      } else if (recipientType === 'management') {
        // the office manager + Toby (managers). Address one; all managers are notified below anyway.
        const { rows } = await db.query(
          `SELECT id FROM staff WHERE role='manager' AND is_active=true
           AND lower(first_name) IN ('toby','clare') ORDER BY id LIMIT 1`);
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
      await logAudit(db, { action: 'send', messageId: msgRows[0].id, threadId: thread.id,
        staffId: null, actorType: 'parent', preview: body });
    } else {
      await writeAudit(db, msgRows[0].id, req.user.id, body, false, thread.id);
      _notifyParentOfChild(effectiveChildId, `New message from Your Nursery`, body);
      _emailParentOfThread(thread.id, effectiveChildId, body).catch(() => {});
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
    if (req.user.role === 'parent' && !ownIds(req.user).includes(thread.child_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // A 1:1 staff DM (staff_direct) is repliable ONLY by its two participants —
    // prevents replying into someone else's private DM by guessing the id.
    if (thread.recipient_type === 'staff_direct') {
      if (req.user.role === 'parent') return res.status(403).json({ error: 'Forbidden' });
      const { rows: _pp } = await db.query(
        'SELECT 1 FROM message_thread_participants WHERE thread_id=$1 AND staff_id=$2',
        [req.params.id, req.user.id]);
      if (!_pp.length) return res.status(403).json({ error: 'Forbidden' });
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

    const _hold = await undoSeconds(db);
    const { rows } = await db.query(`
      INSERT INTO messages (thread_id, sender_type, sender_id, parent_email, body, held_until)
      VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int > 0 THEN now() + ($6 || ' seconds')::interval END)
      RETURNING *
    `, [req.params.id, senderType, senderId, parentEmail, body, _hold]);
    const msg = rows[0];
    msg.undo_seconds = _hold;   // the UI shows "Undo" for this long
    await db.query('UPDATE message_threads SET last_message_at=NOW() WHERE id=$1', [req.params.id]);

    // New message → auto-unarchive for the recipients (standard email behaviour)
    _autoUnarchive(db, parseInt(req.params.id, 10),
      isParent ? { kind: 'parent', id: thread.child_id } : { kind: 'staff', id: req.user.id }).catch(() => {});

    // Notify any secondary staff added to this thread (message_thread_participants) — 2026-07-30.
    // Runs for both parent and staff messages; never notifies the staff member who just sent it.
    // For a pure staff thread (staff_direct / staff_group DM — no child_id) this IS the 1:1
    // colleague notification: use the 'message_received' category + a person-to-person title.
    try {
      const { notify: _notifyP } = require('../services/notification-dispatcher');
      const { rows: _parts } = await db.query('SELECT staff_id FROM message_thread_participants WHERE thread_id=$1', [req.params.id]);
      const _isStaffThread = !thread.child_id;
      let _senderName = null;
      if (_isStaffThread && !isParent) {
        const { rows: _me } = await db.query(`SELECT first_name||' '||last_name AS name FROM staff WHERE id=$1`, [req.user.id]).catch(() => ({ rows: [] }));
        _senderName = (_me[0] && _me[0].name) || 'A colleague';
      }
      for (const _pp of _parts) {
        if (!isParent && _pp.staff_id === req.user.id) continue;
        if (_isStaffThread) {
          _notifyP('message_received', 'staff', _pp.staff_id,
            _senderName ? `New message from ${_senderName}` : `New message: ${thread.subject || 'Conversation'}`,
            (body || '').slice(0, 200),
            { relatedTable: 'staff', relatedId: req.user.id, link: '/messages.html' });
        } else {
          _notifyP('parent_message_received', 'staff', _pp.staff_id,
            `New message: ${thread.subject || 'Conversation'}`, (body || '').slice(0, 200),
            { relatedTable: 'children', relatedId: thread.child_id, link: '/messages.html' });
        }
      }
    } catch (_) { /* participants optional */ }

    // Audit all outbound messages (staff and parent)
    if (!isParent) await writeAudit(db, msg.id, req.user.id, body, false, req.params.id);
    else await logAudit(db, { action: 'send', messageId: msg.id, threadId: req.params.id,
      staffId: null, actorType: 'parent', preview: body });

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

    // Staff reply → in-app notification for the child's parent(s) + optional email copy
    if (!isParent && thread.child_id) {
      _notifyParentOfChild(thread.child_id, `New message from Your Nursery`, body);
      _emailParentOfThread(thread.id, thread.child_id, body).catch(() => {});
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
router.post('/thread/:id/reply-photo', _numericThreadId, msgUpload.single('photo'), async (req, res) => {
  try {
    const db = getPool();
    const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.id]);
    if (!threads.length) return res.status(404).json({ error: 'Not found' });
    const thread = threads[0];
    if (req.user.role === 'parent' && !ownIds(req.user).includes(thread.child_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // 29 Oct: the plain reply route checks the caller may be in this thread; this one didn't.
    if (req.user.role !== 'parent' && !(await _canAccessThread(db, thread, req.user))
        && !(await db.query('SELECT 1 FROM message_thread_participants WHERE thread_id=$1 AND staff_id=$2', [thread.id, req.user.id])).rows.length) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const isParent  = req.user.role === 'parent';
    const parentEmail = isParent ? req.user.name : null;

    if (isParent && await isBlocked(db, parentEmail)) {
      return res.status(403).json({ error: 'Messaging is not available' });
    }

    const body    = (req.body && req.body.body) || '';
    // 2026-10-28: a file the filter refused (e.g. an .exe) used to post an empty message.
    if (!req.file && !String(body).trim()) {
      return res.status(400).json({ error: 'unsupported_file', message: 'Only photos, PDF, Word or Excel files can be attached (up to 10MB).' });
    }
    // Served by the authed GET /attachment/:threadId/:filename route below.
    const photoPath = req.file
      ? `/api/messages/attachment/${req.params.id}/${req.file.filename}`
      : null;
    const photoMime = req.file ? req.file.mimetype : null;

    // Staff photos with attachments go into pending_review queue
    // 2026-10-28: a manager's own attachment is not held for a manager's review.
    const needsReview = !isParent && !!photoPath && !hasRole(req.user, ['manager', 'deputy_manager', 'admin']);

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

    // New message → auto-unarchive for the recipients (standard email behaviour)
    _autoUnarchive(db, parseInt(req.params.id, 10),
      isParent ? { kind: 'parent', id: thread.child_id } : { kind: 'staff', id: req.user.id }).catch(() => {});

    // Audit entry (staff and parent) — attachment send
    await logAudit(db, {
      action: 'send', messageId: msg.id, threadId: thread.id,
      staffId: isParent ? null : req.user.id, actorType: isParent ? 'parent' : 'staff',
      preview: body, hasAttachment: !!photoPath,
      detail: photoMime ? `attachment:${photoMime}` : null,
    });

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
// ── POST /message/:id/undo — take it back, if you are quick ───────────────────
// Only the sender, only inside the window, only their own message. After the window it is
// refused and says why: it may already have been read, and unsending a read message is a
// promise that cannot be kept.
router.post('/message/:id/undo', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [m] } = await db.query(`SELECT * FROM messages WHERE id = $1`, [parseInt(req.params.id, 10) || 0]);
    if (!m) return res.status(404).json({ error: 'Not found' });

    const mine = req.user.role === 'parent'
      ? (m.sender_type === 'parent' && String(m.parent_email || '').toLowerCase() === String(req.user.name || '').toLowerCase())
      : (m.sender_id === req.user.id);
    if (!mine) return res.status(403).json({ error: 'You can only undo your own message.' });
    if (m.retracted_at) return res.json({ ok: true, already: true });

    if (!m.held_until || new Date(m.held_until) <= new Date()) {
      return res.status(409).json({
        error: 'too_late',
        message: 'That has already gone. It can no longer be taken back — it may have been read.',
      });
    }
    await db.query(`UPDATE messages SET retracted_at = now(), retracted_by = $2 WHERE id = $1`,
      [m.id, req.user.role === 'parent' ? null : req.user.id]);
    // messages.js has its own audit helper; recordAudit is not imported here.
    writeAudit(db, m.id, req.user.role === 'parent' ? null : req.user.id,
               '[undone by sender within the send window]', false, m.thread_id).catch(() => {});
    res.json({ ok: true, undone: m.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /message/:id/receipts — received and opened, for the sender ───────────
router.get('/message/:id/receipts', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [m] } = await db.query(
      `SELECT id, thread_id, sender_type, sender_id, parent_email,
              to_char(created_at,   'YYYY-MM-DD"T"HH24:MI:SSOF') AS sent_at,
              to_char(held_until,   'YYYY-MM-DD"T"HH24:MI:SSOF') AS held_until,
              to_char(delivered_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS received_at,
              to_char(read_at,      'YYYY-MM-DD"T"HH24:MI:SSOF') AS opened_at,
              retracted_at IS NOT NULL AS retracted
         FROM messages WHERE id = $1`, [parseInt(req.params.id, 10) || 0]);
    if (!m) return res.status(404).json({ error: 'Not found' });
    const mine = req.user.role === 'parent'
      ? (m.sender_type === 'parent' && String(m.parent_email || '').toLowerCase() === String(req.user.name || '').toLowerCase())
      : (m.sender_id === req.user.id || hasRole(req.user, ['manager','deputy_manager','admin']));
    if (!mine) return res.status(403).json({ error: 'Forbidden' });
    res.json({
      message_id: m.id,
      sent_at: m.sent_at,
      received_at: m.received_at,
      opened_at: m.opened_at,
      retracted: m.retracted,
      status: m.retracted ? 'taken back'
            : m.opened_at ? 'opened'
            : m.received_at ? 'received, not opened yet'
            : (m.held_until && new Date(m.held_until) > new Date()) ? 'still sending'
            : 'sent, not received yet',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/thread/:id/read', async (req, res) => {
  try {
    const db = getPool();
    const threads = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.id]);
    if (!threads.rows.length) return res.status(404).json({ error: 'Not found' });
    const thread = threads.rows[0];
    if (req.user.role === 'parent' && !ownIds(req.user).includes(thread.child_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // 29 Oct: staff could mark anyone's private conversation as read.
    if (req.user.role !== 'parent' && !(await _canAccessThread(db, thread, req.user))
        && !(await db.query('SELECT 1 FROM message_thread_participants WHERE thread_id=$1 AND staff_id=$2', [thread.id, req.user.id])).rows.length) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const isStaffThread = ['staff_group', 'staff_direct'].includes(thread.recipient_type);
    let upd;
    if (isStaffThread) {
      // Staff↔staff thread: both sides are sender_type='staff', so mark read by
      // sender_id (everything not sent by me), not by sender_type.
      upd = await db.query(`
        UPDATE messages SET is_read=true
        WHERE thread_id=$1 AND is_read=false AND sender_id IS DISTINCT FROM $2
      `, [req.params.id, req.user.id]);
    } else {
      // Parent/staff thread: mark as read the messages from the other side.
      const senderType = req.user.role === 'parent' ? 'staff' : 'parent';
      upd = await db.query(`
        UPDATE messages SET is_read=true WHERE thread_id=$1 AND sender_type=$2 AND is_read=false
      `, [req.params.id, senderType]);
    }
    if (upd.rowCount > 0) {
      const isParent = req.user.role === 'parent';
      await logAudit(db, { action: 'read', threadId: parseInt(req.params.id, 10),
        staffId: isParent ? null : req.user.id, actorType: isParent ? 'parent' : 'staff',
        detail: `read ${upd.rowCount} message(s)` });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Per-user archive (b107): hide/show a thread for the CURRENT user only ─────
// Never deletes messages. Access mirrors the thread-list rules (parents see own
// children incl. siblings; non-manager staff see assigned / same-room threads).
async function _archiveAccessOk(db, thread, user) {
  if (!thread) return false;
  if (user.role === 'parent') return ownIds(user).includes(thread.child_id);
  if (hasRole(user, ['manager', 'deputy_manager', 'admin'])) return true;
  if (thread.recipient_staff_id === user.id) return true;
  // 29 Oct: an addressed staff_group thread is its addressee's (and its participants'), not everyone's.
  if (thread.recipient_type === 'staff_group' && !thread.recipient_staff_id) return true;
  if (thread.recipient_type === 'staff_group') {
    const { rows } = await db.query('SELECT 1 FROM message_thread_participants WHERE thread_id=$1 AND staff_id=$2', [thread.id, user.id]);
    return rows.length > 0;
  }
  if (['management', 'manager'].includes(thread.recipient_type)) return false;
  if (thread.child_id && user.room_id) {
    const { rows } = await db.query('SELECT room_id FROM children WHERE id=$1', [thread.child_id]);
    return rows[0]?.room_id === user.room_id;
  }
  return false;
}

function _archiveHandler(archive) {
  return async (req, res) => {
    try {
      const db = getPool();
      await ensureArchiveSchema(db);
      const { rows } = await db.query('SELECT * FROM message_threads WHERE id=$1', [parseInt(req.params.id, 10)]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const thread = rows[0];
      if (!(await _archiveAccessOk(db, thread, req.user))) return res.status(403).json({ error: 'Forbidden' });
      const key = _archiveKey(thread, req.user);
      if (!key) return res.status(400).json({ error: 'Cannot archive this thread' });
      if (archive) {
        await db.query(
          `INSERT INTO message_archive (thread_id, user_kind, user_id) VALUES ($1,$2,$3)
           ON CONFLICT (thread_id, user_kind, user_id) DO NOTHING`,
          [thread.id, key.kind, key.id]
        );
      } else {
        await db.query(
          `DELETE FROM message_archive WHERE thread_id=$1 AND user_kind=$2 AND user_id=$3`,
          [thread.id, key.kind, key.id]
        );
      }
      await logAudit(db, {
        action: archive ? 'archive' : 'unarchive', threadId: thread.id,
        staffId: req.user.role === 'parent' ? null : req.user.id,
        actorType: req.user.role === 'parent' ? 'parent' : 'staff',
      });
      res.json({ ok: true, archived: archive });
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
}
// Conventional (/thread/:id/…) + spec (/:thread/…) forms both mount the handler.
router.post('/thread/:id/archive',   _archiveHandler(true));
router.post('/thread/:id/unarchive', _archiveHandler(false));
router.post('/:id/archive',          _archiveHandler(true));
router.post('/:id/unarchive',        _archiveHandler(false));

// GET /all-threads — manager sees ALL parent threads (no child filter)
router.get('/all-threads', async (req, res) => {
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  try {
    const db = getPool();
    await ensureArchiveSchema(db);
    const showArchived = /^(1|true)$/i.test(String(req.query.archived || ''));
    const archCond = showArchived ? 'ar.thread_id IS NOT NULL' : 'ar.thread_id IS NULL';
    const { rows } = await db.query(`
      SELECT t.id, t.subject, t.last_message_at, t.created_at, t.recipient_type,
        c.first_name||' '||c.last_name as child_name, c.id as child_id,
        s.first_name||' '||s.last_name as assigned_staff,
        (ar.thread_id IS NOT NULL) AS archived,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_type='parent') as unread_count,
        (SELECT body FROM messages m2 WHERE m2.thread_id=t.id ORDER BY m2.created_at DESC LIMIT 1) as last_body,
        (SELECT sender_type FROM messages m3 WHERE m3.thread_id=t.id ORDER BY m3.created_at DESC LIMIT 1) as last_sender_type,
        (SELECT first_name||' '||last_name FROM staff st WHERE st.id=(SELECT sender_id FROM messages m4 WHERE m4.thread_id=t.id AND m4.sender_type='staff' ORDER BY m4.created_at DESC LIMIT 1)) as last_staff_reply
      FROM message_threads t
      LEFT JOIN children c ON c.id=t.child_id
      LEFT JOIN staff s ON s.id=t.recipient_staff_id
      LEFT JOIN message_archive ar ON ar.thread_id=t.id AND ar.user_kind='staff' AND ar.user_id=$1
      WHERE (t.recipient_type != 'staff_group' OR t.recipient_type IS NULL)
        AND ${archCond}
      ORDER BY t.last_message_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /broadcast — send message to all-parents or all-staff (creates thread per recipient)
router.post('/broadcast', async (req, res) => {
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  const { subject, body, target } = req.body; // target: 'all_parents' | 'all_staff'
  if (!subject || !body || !target) return res.status(400).json({ error: 'subject, body, target required' });
  try {
    const db = getPool();
    let created = 0;
    if (target === 'all_parents') {
      const { rows: children } = await db.query(`SELECT DISTINCT child_id FROM parents WHERE is_active=true`).catch(async () => {
        // Fall back to children table if parents table doesn't exist
        const r = await db.query(`SELECT id as child_id FROM children WHERE is_active=true AND is_demo=false`);
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
    // 29 Oct: the HR portal (staff's own phones) only messages colleagues — editions/hr/public/
    // messages.html reads d.staff alone — but every child's name and parent's email rode along.
    const { rows: children } = req._portal === 'hr' ? { rows: [] } : await db.query(`
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
    const db = getPool();
    const { rows: [msg] } = await db.query('SELECT * FROM messages WHERE id=$1', [req.params.msgId]);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    const { rows: [thread] } = await db.query('SELECT * FROM message_threads WHERE id=$1', [msg.thread_id]);
    if (!(await _canAccessThread(db, thread, req.user))) return res.status(403).json({ error: 'Forbidden' });
    await db.query(
      `UPDATE messages SET read_at=NOW() WHERE id=$1 AND read_at IS NULL RETURNING id`,
      [req.params.msgId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /pending-photos — manager: list messages pending photo review
router.get('/pending-photos', async (req, res) => {
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
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
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
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

    // Update audit row + log the review action explicitly
    await db.query(
      `UPDATE message_audit SET manager_reviewed=true, reviewed_at=NOW(),
        reviewed_by_staff_id=$1, reviewed_decision=$2
       WHERE message_id=$3`,
      [req.user.id, decision, msg.id]
    );
    await logAudit(db, { action: 'review', messageId: msg.id, threadId: msg.thread_id,
      staffId: req.user.id, actorType: 'staff', detail: `decision:${decision}${reason ? ' — ' + reason : ''}` });

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
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
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
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
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
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  const { parent_email, reason } = req.body;
  if (!parent_email) return res.status(400).json({ error: 'parent_email required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO parent_message_blocks (parent_email, blocked_by_staff_id, reason)
       VALUES ($1,$2,$3) ON CONFLICT (parent_email) DO UPDATE SET reason=$3 RETURNING *`,
      [parent_email.toLowerCase().trim(), req.user.id, reason || null]
    );
    await logAudit(db, { action: 'block', staffId: req.user.id, actorType: 'staff',
      detail: `blocked ${parent_email.toLowerCase().trim()}${reason ? ' — ' + reason : ''}` });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/blocks/:id', async (req, res) => {
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  try {
    const db = getPool();
    const { rows } = await db.query('DELETE FROM parent_message_blocks WHERE id=$1 RETURNING parent_email', [req.params.id]);
    await logAudit(db, { action: 'unblock', staffId: req.user.id, actorType: 'staff',
      detail: `unblocked ${rows[0]?.parent_email || 'contact #' + req.params.id}` });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI Draft / Confirm-send (P4 Actions B) ───────────────────────
// POST /draft — store a message as a draft (ai_draft=true, no send trigger)
// Staff review then confirm-send to actually dispatch.
// 2026-10-28 (Toby: "we don't have a draft feature but we should … if staff want me to see a
// message before sending it they could press Send to Toby, and when I click OK it sends on their
// behalf"). kind: 'draft' = saved for the writer only, sent when THEY press Send;
// 'approval' = held for a manager, who approves it and it goes out as the writer's message.
// No kind = 'approval' (the original AI-draft behaviour, unchanged).
router.post('/draft', async (req, res) => {
  const { thread_id, body, attachment_json } = req.body;
  const kind = req.body && req.body.kind === 'draft' ? 'draft' : 'approval';
  if (!thread_id || !body) return res.status(400).json({ error: 'thread_id and body required' });
  try {
    const db = getPool();
    const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1', [thread_id]);
    if (!threads.length) return res.status(404).json({ error: 'Thread not found' });
    const thread = threads[0];

    // Staff can draft for their threads; parents can draft for their child's threads
    if (req.user.role === 'parent' && !ownIds(req.user).includes(thread.child_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role !== 'parent' && !hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
      const isAssigned = thread.recipient_staff_id === req.user.id;
      const isStaffGroup = thread.recipient_type === 'staff_group';
      const isManagementRouted = ['management', 'manager'].includes(thread.recipient_type);
      if (!isAssigned && !isStaffGroup) {
        if (isManagementRouted) return res.status(403).json({ error: 'Forbidden' });
        if (thread.child_id) {
          const childRoom = (await db.query('SELECT room_id FROM children WHERE id=$1', [thread.child_id])).rows[0]?.room_id;
          if (childRoom !== req.user.room_id) return res.status(403).json({ error: 'Forbidden' });
        }
      }
    }

    const senderType = req.user.role === 'parent' ? 'parent' : 'staff';
    const senderId = req.user.role === 'parent' ? null : req.user.id;
    const parentEmail = req.user.role === 'parent' ? req.user.name : null;

    await _ensureDraftSchema(db);
    const forApproval = kind === 'approval';
    const { rows } = await db.query(`
      INSERT INTO messages (thread_id, sender_type, sender_id, parent_email, body,
        ai_draft, pending_review, review_decision, draft_kind)
      VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8) RETURNING *
    `, [thread_id, senderType, senderId, parentEmail, body.slice(0, 10000),
        forApproval, forApproval ? 'pending' : null, kind]);
    const draft = rows[0];

    // A plain draft is the writer's own business — nobody is told.
    if (!forApproval) return res.status(201).json({ ...draft, status: 'draft' });

    // Notify staff that a draft needs review
    if (req.user.role !== 'parent' && req.body && req.body.kind === 'approval') {
      try {
        const { notifyAsync } = require('../services/notification-dispatcher');
        const { rows: [c] } = await db.query('SELECT first_name FROM children WHERE id=$1', [thread.child_id]).catch(() => ({ rows: [] }));
        await notifyAsync('message', 'staff', 1,
          `${req.user.first_name || req.user.name || 'A member of staff'} wants you to check a message`,
          `To ${c && c.first_name ? c.first_name + "'s family" : 'a family'}: "${body.slice(0, 120)}" — open Messages to OK it.`,
          { link: '/messages.html?approvals=1', relatedTable: 'messages', relatedId: draft.id, priority: 'normal' });
      } catch (e) { console.error('[messages] approval notify:', e.message); }
    } else if (req.user.role !== 'parent') {
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
      SELECT m.*, t.subject, t.child_id, t.recipient_staff_id, t.recipient_type
      FROM messages m JOIN message_threads t ON t.id=m.thread_id
      WHERE m.id=$1 AND m.ai_draft=true
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Draft not found or already sent' });
    const msg = rows[0];
    const thread = { id: msg.thread_id, child_id: msg.child_id,
      recipient_staff_id: msg.recipient_staff_id, recipient_type: msg.recipient_type };

    // Auth check: same rules as reply
    if (req.user.role === 'parent' && !ownIds(req.user).includes(thread.child_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role !== 'parent' && !hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
      const isAssigned = thread.recipient_staff_id === req.user.id;
      const isStaffGroup = thread.recipient_type === 'staff_group';
      const isManagementRouted = ['management', 'manager'].includes(thread.recipient_type);
      if (!isAssigned && !isStaffGroup) {
        if (isManagementRouted) return res.status(403).json({ error: 'Forbidden' });
        if (thread.child_id) {
          const childRoom = (await db.query('SELECT room_id FROM children WHERE id=$1', [thread.child_id])).rows[0]?.room_id;
          if (childRoom !== req.user.room_id) return res.status(403).json({ error: 'Forbidden' });
        } else {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
    }

    // 2026-10-28: a message sent to Toby for approval goes out only on a manager's OK.
    const isMgr = hasRole(req.user, ['manager', 'deputy_manager', 'admin']);
    if (msg.draft_kind === 'approval' && req.user.role !== 'parent' && !isMgr) {
      return res.status(403).json({ error: 'needs_approval', message: 'Toby needs to OK this one before it goes.' });
    }
    if (msg.draft_kind === 'draft' && req.user.role !== 'parent' && !isMgr && msg.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.body && typeof req.body.body === 'string' && req.body.body.trim()) {
      await db.query('UPDATE messages SET body=$2 WHERE id=$1', [req.params.id, req.body.body.trim().slice(0, 10000)]);
    }

    // Mark as sent, remove draft flags
    const { rows: sent } = await db.query(`
      UPDATE messages SET ai_draft=false, pending_review=false, review_decision='approved',
        body=body, created_at=NOW(), delivered_at=NULL
      WHERE id=$1 RETURNING *
    `, [req.params.id]);
    if (msg.draft_kind === 'approval' && msg.sender_id && msg.sender_id !== req.user.id) {
      try {
        const { notifyAsync } = require('../services/notification-dispatcher');
        await notifyAsync('message', 'staff', msg.sender_id, 'Your message was approved and sent',
          `"${String(sent[0].body || '').slice(0, 120)}"`, { link: '/ey/messages?thread=' + msg.thread_id, priority: 'low' });
      } catch (_) {}
    }

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

    // New message → auto-unarchive for the recipients (standard email behaviour)
    _autoUnarchive(db, thread.id,
      isParent ? { kind: 'parent', id: thread.child_id } : { kind: 'staff', id: req.user.id }).catch(() => {});

    res.json({ ...sent[0], status: 'sent' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /draft/:id {body} — edit a draft (its writer, or a manager)
router.put('/draft/:id', async (req, res) => {
  try {
    const db = getPool();
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'body required' });
    const { rows: [m] } = await db.query('SELECT id, sender_id FROM messages WHERE id=$1 AND ai_draft=true AND retracted_at IS NULL', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Draft not found' });
    if (req.user.role === 'parent' || (m.sender_id !== req.user.id && !hasRole(req.user, ['manager', 'deputy_manager', 'admin']))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await db.query('UPDATE messages SET body=$2 WHERE id=$1 RETURNING *', [m.id, body.slice(0, 10000)]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /draft/:id — throw a draft away (kept, retracted, for the audit trail)
router.delete('/draft/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [m] } = await db.query('SELECT id, sender_id FROM messages WHERE id=$1 AND ai_draft=true AND retracted_at IS NULL', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Draft not found' });
    if (req.user.role === 'parent' || (m.sender_id !== req.user.id && !hasRole(req.user, ['manager', 'deputy_manager', 'admin']))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await db.query(`UPDATE messages SET retracted_at=now(), review_decision=CASE WHEN pending_review THEN 'rejected' ELSE review_decision END,
                       pending_review=false WHERE id=$1`, [m.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function _ensureDraftSchema(db) {
  if (_ensureDraftSchema.done) return;
  await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS draft_kind text').catch(() => {});
  _ensureDraftSchema.done = true;
}

// GET /drafts — list pending drafts for this user (?thread_id= narrows to one conversation)
router.get('/drafts', async (req, res) => {
  try {
    const db = getPool();
    await _ensureDraftSchema(db);
    const _tid = parseInt(req.query.thread_id, 10);
    const _tfilter = Number.isInteger(_tid) ? ` AND m.thread_id = ${_tid}` : '';
    let query, params;
    if (req.user.role === 'parent') {
      query = `
        SELECT m.*, t.subject, c.first_name||' '||c.last_name as child_name
        FROM messages m
        JOIN message_threads t ON t.id=m.thread_id
        JOIN children c ON c.id=t.child_id
        WHERE m.ai_draft=true AND m.retracted_at IS NULL AND m.sender_type='parent'
          AND t.child_id=$1${_tfilter}
        ORDER BY m.created_at DESC
      `;
      params = [req.user.child_id];
    } else if (hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
      query = `
        SELECT m.*, t.subject, t.child_id, c.first_name||' '||c.last_name as child_name,
          s.first_name||' '||s.last_name as sender_name
        FROM messages m
        JOIN message_threads t ON t.id=m.thread_id
        LEFT JOIN children c ON c.id=t.child_id
        LEFT JOIN staff s ON s.id=m.sender_id
        WHERE m.ai_draft=true AND m.retracted_at IS NULL${_tfilter}
          AND (COALESCE(m.draft_kind,'approval') = 'approval' OR m.sender_id = $1)
        ORDER BY m.created_at DESC
      `;
      params = [req.user.id];
    } else {
      query = `
        SELECT m.*, t.subject, t.child_id
        FROM messages m
        JOIN message_threads t ON t.id=m.thread_id
        WHERE m.ai_draft=true AND m.retracted_at IS NULL${_tfilter}
          AND m.sender_id=$1
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

// ── Shared thread-access check (mirrors the inline rules used elsewhere) ──────
async function _canAccessThread(db, thread, user) {
  if (!thread) return false;
  if (user.role === 'parent') {
    // Sibling fix 2026-07-21: must check the full child_ids array (multi-child
    // families), not just the single primary child_id — otherwise a parent is
    // wrongly locked out of message threads about their own non-primary child.
    const owned = (user.child_ids && user.child_ids.length) ? user.child_ids : [user.child_id];
    return owned.includes(thread.child_id);
  }
  if (hasRole(user, ['manager', 'deputy_manager', 'admin'])) return true;
  if (thread.recipient_staff_id === user.id) return true;
  // 29 Oct: an addressed staff_group thread is its addressee's (and its participants'), not everyone's.
  if (thread.recipient_type === 'staff_group' && !thread.recipient_staff_id) return true;
  if (thread.recipient_type === 'staff_group') {
    const { rows } = await db.query('SELECT 1 FROM message_thread_participants WHERE thread_id=$1 AND staff_id=$2', [thread.id, user.id]);
    return rows.length > 0;
  }
  if (['management', 'manager'].includes(thread.recipient_type)) return false;
  if (thread.child_id && user.room_id) {
    const { rows } = await db.query('SELECT room_id FROM children WHERE id=$1', [thread.child_id]);
    return rows[0]?.room_id === user.room_id;
  }
  return false;
}

// ── GET /attachment/:threadId/:filename — authed serve of message attachments ──
// Mirrors the observation-photo serve pattern, but gated by thread access so a
// parent can only fetch attachments on their own child's threads. Not behind
// router.use(flexAuth) (see the exemption above) — accepts ?token= as well as the
// usual header since every caller renders this as a plain <img src>/<a href>
// (bughunt 2026-07-21). b491 (2026-10-12): ?token= used to accept the same
// long-lived session JWT as the header path (release CHECK.md F1) — now a
// short-lived (≤10min) token signed with MEDIA_URL_KEY instead
// (src/lib/media-url.js), same claim shape so _canAccessThread below is unchanged.
router.get('/attachment/:threadId/:filename', async (req, res) => {
  try {
    const header = req.headers['authorization'] || '';
    const headerTok = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-wren-token'] || '');
    let user;
    if (headerTok) {
      try {
        user = jwt.verify(headerTok, process.env.JWT_SECRET);
        if (!user.aud || user.aud !== (req._portal || 'learning')) {
          return res.status(401).json({ error: 'Invalid token audience' });
        }
      } catch { return res.status(401).json({ error: 'Invalid token' }); }
    } else if (req.query.token) {
      user = require('../lib/media-url').verifySessionToken(req.query.token, req._portal || 'learning');
      if (!user) return res.status(403).json({ error: 'invalid_or_expired_media_url' });
      if ((req._portal || 'learning') === 'learning' && !(await require('../lib/device-token').isAllowed(req))) {
        return res.status(403).json({ error: 'device_required' });
      }
    } else {
      return res.status(401).json({ error: 'Unauthorised' });
    }

    const db = getPool();
    const { rows } = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.threadId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (!(await _canAccessThread(db, rows[0], user))) return res.status(403).json({ error: 'Forbidden' });
    const name = path.basename(req.params.filename);              // strip path traversal
    if (user.role === 'parent') {
      const { rows: held } = await db.query(
        `SELECT 1 FROM messages WHERE thread_id=$1 AND attachment_path LIKE '%/' || $2
           AND NOT ${VISIBLE_SQL.replace(/m\./g, '')} LIMIT 1`, [req.params.threadId, name]);
      if (held.length) return res.status(404).json({ error: 'Not found' });
    }
    const full = path.join(MSG_UPLOAD_BASE, String(parseInt(req.params.threadId, 10)), name);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
    res.sendFile(full);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /thread/:id/ai-draft — draft/polish a reply with the LOCAL model ─────
// GDPR: uses the sovereign Ollama box only (OLLAMA_HOST). Never auto-sends —
// returns text for a human to edit and then send. Staff/managers only.
router.post('/thread/:id/ai-draft', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Staff only' });
  try {
    const db = getPool();
    const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.id]);
    if (!threads.length) return res.status(404).json({ error: 'Not found' });
    const thread = threads[0];
    if (!(await _canAccessThread(db, thread, req.user))) return res.status(403).json({ error: 'Forbidden' });

    // Thread context — last 12 messages, oldest→newest.
    const { rows: msgs } = await db.query(`
      SELECT m.sender_type, m.body, m.created_at,
             s.first_name AS staff_first
      FROM messages m LEFT JOIN staff s ON s.id=m.sender_id
      WHERE m.thread_id=$1 AND COALESCE(m.ai_draft,false)=false
      ORDER BY m.created_at DESC LIMIT 12
    `, [req.params.id]);
    msgs.reverse();

    let childName = 'the child';
    if (thread.child_id) {
      const { rows: c } = await db.query('SELECT first_name FROM children WHERE id=$1', [thread.child_id]);
      if (c[0]?.first_name) childName = c[0].first_name;
    }

    const instruction = (req.body && String(req.body.instruction || '').slice(0, 400)) || '';
    const transcript = msgs.map(m =>
      `${m.sender_type === 'parent' ? 'Parent' : (m.staff_first || 'Nursery')}: ${(m.body || '').slice(0, 800)}`
    ).join('\n') || '(no messages yet)';

    const system = [
      'You are a warm, professional early-years practitioner at Your Nursery in Ealing, London.',
      'Draft a reply from the NURSERY to the parent in this message thread.',
      'Rules: British English; warm but professional; concise (2-4 short sentences unless more is clearly needed);',
      'never invent facts, times, incidents, or medical/safeguarding details not present in the thread;',
      `refer to the child as "${childName}"; do not add a signature or subject line; output ONLY the reply text.`,
    ].join(' ');
    const user = `Thread subject: ${thread.subject || 'Message'}\n\nConversation so far:\n${transcript}\n\n`
      + (instruction ? `Extra instruction from staff: ${instruction}\n\n` : '')
      + 'Write the nursery\'s next reply:';

    let draft = '';
    const draftModel = AI_DRAFT_MODEL();
    try {
      const out = await callOllamaChat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        draftModel, 60000
      );
      draft = (out && out.choices && out.choices[0] && out.choices[0].message
                && out.choices[0].message.content || '').trim();
    } catch (e) {
      return res.status(502).json({ error: 'AI draft unavailable: ' + e.message });
    }
    if (!draft) return res.status(502).json({ error: 'AI returned an empty draft' });

    await logAudit(db, { action: 'ai_draft', threadId: parseInt(req.params.id, 10),
      staffId: req.user.id, actorType: 'staff', preview: draft, detail: `model:${draftModel}` });
    res.json({ draft, model: draftModel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /message-log — manager-only full audit trail with filters ─────────────
// Filters: action, staff_id, thread_id, from (date), to (date), page.
router.get('/message-log', async (req, res) => {
  const isManager = hasRole(req.user, ['manager', 'deputy_manager', 'admin']);
  if (!isManager) return res.status(403).json({ error: 'Manager access required' });
  try {
    const db = getPool();
    await ensureAuditSchema(db);
    const page = Math.max(0, parseInt(req.query.page || '0', 10));
    const params = [];
    const conds = [];
    if (req.query.action)    { params.push(req.query.action); conds.push(`a.action = $${params.length}`); }
    if (req.query.staff_id)  { params.push(parseInt(req.query.staff_id, 10)); conds.push(`a.staff_id = $${params.length}`); }
    if (req.query.thread_id) { params.push(parseInt(req.query.thread_id, 10)); conds.push(`COALESCE(a.thread_id, m.thread_id) = $${params.length}`); }
    if (req.query.from)      { params.push(req.query.from); conds.push(`a.created_at >= $${params.length}`); }
    if (req.query.to)        { params.push(req.query.to);   conds.push(`a.created_at <= ($${params.length}::date + interval '1 day')`); }
    // Archive view: default hides archived entries; ?archived=1 shows only archived (2026-07-24).
    conds.push(req.query.archived === '1' ? 'a.archived_at IS NOT NULL' : 'a.archived_at IS NULL');
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    params.push(page * 50);
    const { rows } = await db.query(`
      SELECT a.id, a.created_at, a.action, a.actor_type, a.has_attachment, a.detail,
             a.preview, a.manager_reviewed, a.reviewed_decision, a.reviewed_at,
             COALESCE(a.thread_id, m.thread_id) AS thread_id,
             a.message_id,
             s.first_name || ' ' || s.last_name AS staff_name,
             rs.first_name || ' ' || rs.last_name AS reviewed_by_name,
             t.subject AS thread_subject,
             c.first_name || ' ' || c.last_name AS child_name
      FROM message_audit a
      LEFT JOIN messages m         ON m.id = a.message_id
      LEFT JOIN message_threads t  ON t.id = COALESCE(a.thread_id, m.thread_id)
      LEFT JOIN children c         ON c.id = t.child_id
      LEFT JOIN staff s            ON s.id = a.staff_id
      LEFT JOIN staff rs           ON rs.id = a.reviewed_by_staff_id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT 50 OFFSET $${params.length}
    `, params);
    const countParams = params.slice(0, params.length - 1);
    const { rows: cnt } = await db.query(
      `SELECT COUNT(*) AS total FROM message_audit a LEFT JOIN messages m ON m.id=a.message_id ${where}`,
      countParams
    );
    res.json({ log: rows, total: parseInt(cnt[0].total, 10), page });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /message-log/:id/archive  &  /unarchive — hide/restore a Message Log entry
// (2026-07-24). Manager-only, additive: sets/clears message_audit.archived_at. The
// audit ROW is never deleted — archiving only hides it from the default log view.
function _logArchiveHandler(archive) {
  return async (req, res) => {
    if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
      return res.status(403).json({ error: 'Manager access required' });
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    try {
      const db = getPool();
      await ensureAuditSchema(db);
      const { rowCount } = await db.query(
        `UPDATE message_audit SET archived_at = ${archive ? 'now()' : 'NULL'} WHERE id = $1`, [id]
      );
      if (!rowCount) return res.status(404).json({ error: 'Log entry not found' });
      res.json({ ok: true, id, archived: archive });
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
}
router.post('/message-log/:id/archive',   _logArchiveHandler(true));
router.post('/message-log/:id/unarchive', _logArchiveHandler(false));

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

// ── Inbound parent email-reply ingestion (2026-08-04) ────────────────────────
// Called by scripts/parent-email-reply-poll.js after it has verified the reply
// token AND that the sender is a parent of this child. Inserts the email body as
// a normal 'parent' message on the thread and fires the SAME staff notifications
// a portal reply would. Returns { ok, messageId } or { ok:false, reason }.
async function ingestParentReply({ threadId, childId, parentEmail, body }) {
  const db = getPool();
  const clean = (body || '').trim();
  if (!clean) return { ok: false, reason: 'empty-body' };
  const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1', [threadId]);
  if (!threads.length) return { ok: false, reason: 'thread-gone' };
  const thread = threads[0];
  if (thread.child_id !== childId) return { ok: false, reason: 'child-mismatch' };
  if (thread.recipient_type === 'staff_direct' || thread.recipient_type === 'staff_group') {
    return { ok: false, reason: 'not-a-parent-thread' };
  }
  if (await isBlocked(db, parentEmail)) return { ok: false, reason: 'blocked' };

  const { rows } = await db.query(
    `INSERT INTO messages (thread_id, sender_type, sender_id, parent_email, body)
     VALUES ($1,'parent',NULL,$2,$3) RETURNING *`, [threadId, parentEmail, clean]);
  const msg = rows[0];
  await db.query('UPDATE message_threads SET last_message_at=NOW() WHERE id=$1', [threadId]);
  _autoUnarchive(db, threadId, { kind: 'parent', id: childId }).catch(() => {});

  try {
    const { notify: _notify } = require('../services/notification-dispatcher');
    _notify('parent_message_received', 'all-managers', null,
      `New parent message (by email): ${thread.subject || 'Message'}`, clean.slice(0, 200),
      { relatedTable: 'children', relatedId: childId, link: '/messages.html' });
    const { rows: kp } = await db.query('SELECT key_person_id FROM children WHERE id=$1', [childId]).catch(() => ({ rows: [] }));
    if (kp[0]?.key_person_id) {
      _notify('parent_message_received', 'staff', kp[0].key_person_id,
        `New parent message (by email): ${thread.subject || 'Message'}`, clean.slice(0, 200),
        { relatedTable: 'children', relatedId: childId, link: '/messages.html' });
    }
  } catch (_) {}
  if (!isOutOfHours()) {
    await sendTelegramMsg(`📧 *Parent replied by email* — thread: ${thread.subject || 'Message'}\nFrom: ${parentEmail || 'parent'}`).catch(() => {});
  }
  await logAudit(db, { action: 'send', messageId: msg.id, threadId, staffId: null,
    actorType: 'parent', preview: clean, meta: { channel: 'email' } }).catch(() => {});
  return { ok: true, messageId: msg.id };
}
router.ingestParentReply = ingestParentReply;
router._emailParentOfThread = _emailParentOfThread; // exported for tests

module.exports = router;
