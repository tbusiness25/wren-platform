'use strict';
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { getPool }     = require('../db/pool');
const authenticate    = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const { CATEGORIES, CATEGORY_KEYS, defaultPresetForRole } = require('../services/notification-categories');

// POST /api/notifications/telegram/link — n8n webhook when bot receives /link CODE
// Registered BEFORE authenticate so the bot can call it without a staff JWT
router.post('/telegram/link', async (req, res) => {
  const { code, chat_id, telegram_name } = req.body;
  if (!code || !chat_id) return res.status(400).json({ error: 'code and chat_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, first_name, last_name FROM staff
       WHERE telegram_link_code=$1
         AND telegram_link_code_expires > NOW()`,
      [code.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invalid or expired code' });
    const staff = rows[0];
    await db.query(
      `UPDATE staff SET
         telegram_chat_id=$1,
         telegram_linked_at=NOW(),
         telegram_link_code=NULL,
         telegram_link_code_expires=NULL
       WHERE id=$2`,
      [String(chat_id), staff.id]
    );
    res.json({
      ok: true,
      staff_name: `${staff.first_name} ${staff.last_name}`,
      reply: `✅ Linked to Wren as ${staff.first_name} ${staff.last_name}. You'll now receive notifications here.`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.use(authenticate);

// Resolve current user's identity for recipient matching
function userMatches(row, user) {
  if (row.recipient_type === 'staff'      && row.recipient_id  === user.id)    return true;
  if (row.recipient_type === 'all-staff'  && user.role !== 'parent')           return true;
  if (row.recipient_type === 'all-managers' &&
      ['manager','deputy_manager'].includes(user.role))                        return true;
  if (row.recipient_type === 'parent'     && row.recipient_id  === user.id)    return true;
  return false;
}

function recipientClause(user, alias = 'n') {
  const isManager = ['manager','deputy_manager'].includes(user.role);
  const isParent  = user.role === 'parent';
  if (isParent) {
    // Parent JWTs all carry id=0 (they authenticate per CHILD, child_id in the
    // token) — so parent notifications are keyed by child id, NOT user id.
    // child_id comes from our own signed JWT; inline as a checked integer and
    // keep $1 referenced so call sites' [uid] param stays valid.
    const cid = Number(user.child_id) || -1;
    return `(${alias}.recipient_type='parent' AND ${alias}.recipient_id=${cid} AND $1::int IS NOT NULL)`;
  }
  if (isManager) {
    return `(${alias}.recipient_type='all-managers'
      OR (${alias}.recipient_type='all-staff')
      OR (${alias}.recipient_type='staff' AND ${alias}.recipient_id=$1))`;
  }
  return `(${alias}.recipient_type='all-staff'
    OR (${alias}.recipient_type='staff' AND ${alias}.recipient_id=$1))`;
}

// POST /api/notifications — internal: any server-side code can POST here to create a notification
// Also exposed so admin can trigger test notifications
router.post('/', async (req, res) => {
  try {
    const { recipient_type, recipient_id, category, title, body, link, priority,
            related_table, related_id } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const { rows } = await getPool().query(
      `INSERT INTO notifications (recipient_type,recipient_id,category,title,body,link,related_table,related_id,priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [recipient_type || 'all-staff', recipient_id || null, category || 'system',
       title, body || null, link || null, related_table || null, related_id || null,
       priority || 'normal']
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications/unread — current user's unread count + last 10
router.get('/unread', async (req, res) => {
  try {
    const db   = getPool();
    const uid  = req.user.id;
    const clause = recipientClause(req.user, 'n');

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM notifications n
       WHERE ${clause} AND n.read_at IS NULL AND n.dismissed_at IS NULL`,
      [uid]
    );

    const { rows } = await db.query(
      `SELECT * FROM notifications n
       WHERE ${clause} AND n.read_at IS NULL AND n.dismissed_at IS NULL
       ORDER BY n.created_at DESC LIMIT 10`,
      [uid]
    );

    res.json({ count: parseInt(countRows[0].cnt, 10), items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications/unread-count — lightweight count only.
// Alias for callers that only need the badge number (wren-app-shell.js + EY/learning pages,
// which previously hit this path and 404'd because only /unread existed).
router.get('/unread-count', async (req, res) => {
  try {
    const db = getPool();
    const clause = recipientClause(req.user, 'n');
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM notifications n
       WHERE ${clause} AND n.read_at IS NULL AND n.dismissed_at IS NULL`,
      [req.user.id]
    );
    res.json({ count: parseInt(rows[0].cnt, 10) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications — paginated full feed
router.get('/', async (req, res) => {
  try {
    const db      = getPool();
    const uid     = req.user.id;
    const clause  = recipientClause(req.user, 'n');
    const page    = Math.max(0, parseInt(req.query.page || '0', 10));
    const limit   = 40;
    const offset  = page * limit;
    const { category } = req.query;

    let q = `SELECT * FROM notifications n WHERE ${clause} AND n.dismissed_at IS NULL`;
    const params = [uid];
    if (category) { params.push(category); q += ` AND n.category=$${params.length}`; }
    q += ` ORDER BY n.created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/:id/read (IDOR guard: recipient only)
router.post('/:id/read', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT recipient_type, recipient_id FROM notifications WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const n = rows[0];
    // Check: notification is targeted at this user
    const isManager = ['manager','deputy_manager'].includes(req.user.role);
    const isParent = req.user.role === 'parent';
    let allowed = false;
    if (n.recipient_type === 'staff' && Number(n.recipient_id) === Number(req.user.id)) allowed = true;
    // Parent notifications are keyed by child id (parent JWTs all carry id=0)
    if (n.recipient_type === 'parent' && isParent && Number(n.recipient_id) === Number(req.user.child_id)) allowed = true;
    if ((n.recipient_type === 'all-staff' || n.recipient_type === 'all-managers') && !isParent) allowed = true;
    if (!allowed) return res.status(403).json({ error: 'Forbidden — not your notification' });

    const { rows: updated } = await db.query(
      `UPDATE notifications SET read_at=NOW() WHERE id=$1 AND read_at IS NULL RETURNING id`,
      [req.params.id]
    );
    res.json({ ok: true, updated: updated.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  try {
    const db     = getPool();
    const uid    = req.user.id;
    const clause = recipientClause(req.user, 'n');
    await db.query(
      `UPDATE notifications n SET read_at=NOW()
       WHERE ${clause} AND n.read_at IS NULL`,
      [uid]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/:id/dismiss (IDOR guard: recipient only)
router.post('/:id/dismiss', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT recipient_type, recipient_id FROM notifications WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const n = rows[0];
    // Check: notification is targeted at this user
    const isManager = ['manager','deputy_manager'].includes(req.user.role);
    const isParent = req.user.role === 'parent';
    let allowed = false;
    if (n.recipient_type === 'staff' && Number(n.recipient_id) === Number(req.user.id)) allowed = true;
    // Parent notifications are keyed by child id (parent JWTs all carry id=0)
    if (n.recipient_type === 'parent' && isParent && Number(n.recipient_id) === Number(req.user.child_id)) allowed = true;
    if ((n.recipient_type === 'all-staff' || n.recipient_type === 'all-managers') && !isParent) allowed = true;
    if (!allowed) return res.status(403).json({ error: 'Forbidden — not your notification' });

    await db.query(
      `UPDATE notifications SET dismissed_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Notification preferences ──────────────────────────────────────────────────

// GET /api/notifications/prefs — own preferences
router.get('/prefs', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT event_category, channels, enabled, scope
       FROM notification_preferences WHERE staff_id=$1 ORDER BY event_category`,
      [req.user.id]
    );
    // Return full category list with pref merged in
    const prefsMap = Object.fromEntries(rows.map(r => [r.event_category, r]));
    const result = CATEGORY_KEYS.map(k => ({
      event_category: k,
      label: CATEGORIES[k].label,
      urgent: CATEGORIES[k].urgent,
      managerOnly: CATEGORIES[k].managerOnly,
      ...(prefsMap[k] || { channels: ['inapp'], enabled: false, scope: 'all' }),
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/notifications/prefs — update own preferences (bulk upsert)
router.put('/prefs', async (req, res) => {
  const { prefs } = req.body; // array of {event_category, channels, enabled, scope}
  if (!Array.isArray(prefs)) return res.status(400).json({ error: 'prefs array required' });
  const db = getPool();
  try {
    for (const p of prefs) {
      if (!CATEGORY_KEYS.includes(p.event_category)) continue;
      const chans = (p.channels || ['inapp']).filter(c => ['inapp','telegram','email','webpush'].includes(c));
      await db.query(
        `INSERT INTO notification_preferences (staff_id, event_category, channels, enabled, scope, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (staff_id, event_category) DO UPDATE
           SET channels=$3, enabled=$4, scope=$5, updated_at=NOW()`,
        [req.user.id, p.event_category, chans, p.enabled !== false, p.scope || 'all']
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/prefs/reset — reset own prefs to role defaults
router.post('/prefs/reset', async (req, res) => {
  const db = getPool();
  try {
    const { rows: staffRows } = await db.query(`SELECT role FROM staff WHERE id=$1`, [req.user.id]);
    const role = staffRows[0]?.role || 'practitioner';
    const defaults = defaultPresetForRole(role);
    for (const p of defaults) {
      await db.query(
        `INSERT INTO notification_preferences (staff_id, event_category, channels, enabled, scope, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (staff_id, event_category) DO UPDATE
           SET channels=$3, enabled=$4, scope=$5, updated_at=NOW()`,
        [req.user.id, p.event_category, p.channels, p.enabled, p.scope]
      );
    }
    res.json({ ok: true, reset: defaults.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Manager: view/edit any staff's prefs ─────────────────────────────────────

// GET /api/notifications/prefs/all-staff — summary for manager view
router.get('/prefs/all-staff', async (req, res) => {
  if (!['manager','room_leader'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager only' });
  }
  try {
    const { rows } = await getPool().query(`
      SELECT s.id, s.first_name, s.last_name, s.role,
        s.telegram_chat_id IS NOT NULL AND s.telegram_chat_id != '' as telegram_linked,
        s.telegram_linked_at,
        COUNT(np.id) as prefs_count,
        COUNT(np.id) FILTER (WHERE 'telegram'=ANY(np.channels) AND np.enabled) as telegram_prefs
      FROM staff s
      LEFT JOIN notification_preferences np ON np.staff_id = s.id
      WHERE s.is_active = true
      GROUP BY s.id, s.first_name, s.last_name, s.role,
               s.telegram_chat_id, s.telegram_linked_at
      ORDER BY s.last_name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications/prefs/:staffId — manager reads specific staff's prefs
router.get('/prefs/:staffId', async (req, res) => {
  if (!['manager','room_leader'].includes(req.user.role) &&
      req.user.id !== parseInt(req.params.staffId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const sid = parseInt(req.params.staffId);
    const { rows } = await db.query(
      `SELECT event_category, channels, enabled, scope
       FROM notification_preferences WHERE staff_id=$1 ORDER BY event_category`,
      [sid]
    );
    const prefsMap = Object.fromEntries(rows.map(r => [r.event_category, r]));
    const result = CATEGORY_KEYS.map(k => ({
      event_category: k,
      label: CATEGORIES[k].label,
      urgent: CATEGORIES[k].urgent,
      ...(prefsMap[k] || { channels: ['inapp'], enabled: false, scope: 'all' }),
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/notifications/prefs/:staffId — manager updates specific staff's prefs
router.put('/prefs/:staffId', async (req, res) => {
  if (!['manager','room_leader'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager only' });
  }
  const { prefs } = req.body;
  if (!Array.isArray(prefs)) return res.status(400).json({ error: 'prefs array required' });
  const db = getPool();
  const sid = parseInt(req.params.staffId);
  try {
    for (const p of prefs) {
      if (!CATEGORY_KEYS.includes(p.event_category)) continue;
      const chans = (p.channels || ['inapp']).filter(c => ['inapp','telegram','email','webpush'].includes(c));
      await db.query(
        `INSERT INTO notification_preferences (staff_id, event_category, channels, enabled, scope, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (staff_id, event_category) DO UPDATE
           SET channels=$3, enabled=$4, scope=$5, updated_at=NOW()`,
        [sid, p.event_category, chans, p.enabled !== false, p.scope || 'all']
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/prefs/:staffId/reset — manager resets staff to role defaults
router.post('/prefs/:staffId/reset', async (req, res) => {
  if (!['manager','room_leader'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager only' });
  }
  const db = getPool();
  const sid = parseInt(req.params.staffId);
  try {
    const { rows: staffRows } = await db.query(`SELECT role FROM staff WHERE id=$1`, [sid]);
    const role = staffRows[0]?.role || 'practitioner';
    const defaults = defaultPresetForRole(role);
    for (const p of defaults) {
      await db.query(
        `INSERT INTO notification_preferences (staff_id, event_category, channels, enabled, scope, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (staff_id, event_category) DO UPDATE
           SET channels=$3, enabled=$4, scope=$5, updated_at=NOW()`,
        [sid, p.event_category, p.channels, p.enabled, p.scope]
      );
    }
    res.json({ ok: true, reset: defaults.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Telegram linking ───────────────────────────────────────────────────────────

// POST /api/notifications/telegram/generate-link — staff generates one-time code
router.post('/telegram/generate-link', async (req, res) => {
  try {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8-char hex
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
    await getPool().query(
      `UPDATE staff SET telegram_link_code=$1, telegram_link_code_expires=$2 WHERE id=$3`,
      [code, expires, req.user.id]
    );
    res.json({
      code,
      expires_at: expires.toISOString(),
      instructions: `Open the nursery Telegram bot and send:\n/link ${code}\n\nCode expires in 15 minutes.`,
      bot_url: 'https://t.me/your_wren_bot', // staff can find via admin
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications/telegram/status
router.get('/telegram/status', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT telegram_chat_id, telegram_linked_at FROM staff WHERE id=$1`, [req.user.id]
    );
    const s = rows[0] || {};
    res.json({
      linked: !!(s.telegram_chat_id),
      chat_id_partial: s.telegram_chat_id
        ? '…' + String(s.telegram_chat_id).slice(-4)
        : null,
      linked_at: s.telegram_linked_at || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/telegram/unlink
router.post('/telegram/unlink', async (req, res) => {
  try {
    await getPool().query(
      `UPDATE staff SET telegram_chat_id=NULL, telegram_linked_at=NULL,
         telegram_link_code=NULL, telegram_link_code_expires=NULL
       WHERE id=$1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/test — send a test notification to own channels
router.post('/test', async (req, res) => {
  const { notify } = require('../services/notification-dispatcher');
  try {
    notify(
      'system_critical',
      'staff', req.user.id,
      'Test notification',
      `This is a test notification sent at ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}.`,
      { priority: 'normal' }
    );
    res.json({ ok: true, message: 'Test queued — check your bell icon and Telegram (if linked).' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Web Push (browser push notifications) ────────────────────────────────────

// GET /api/notifications/vapid-public-key — client needs this to subscribe
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY || null;
  res.json({ key, enabled: !!key });
});

// POST /api/notifications/push-subscribe — save/refresh this device's subscription
router.post('/push-subscribe', async (req, res) => {
  try {
    const sub = req.body.subscription || req.body;
    if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ error: 'subscription required' });
    await getPool().query(
      `INSERT INTO push_subscriptions (staff_id, endpoint, p256dh, auth, user_agent, last_used_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (endpoint) DO UPDATE
         SET staff_id=$1, p256dh=$3, auth=$4, user_agent=$5, last_used_at=NOW()`,
      [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, (req.body.user_agent || '').slice(0, 300)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/push-unsubscribe — remove this device's subscription
router.post('/push-unsubscribe', async (req, res) => {
  try {
    const endpoint = (req.body.subscription && req.body.subscription.endpoint) || req.body.endpoint;
    if (endpoint) await getPool().query(`DELETE FROM push_subscriptions WHERE endpoint=$1`, [endpoint]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications/push-status — does this user have any active subscription?
router.get('/push-status', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE staff_id=$1`, [req.user.id]);
    res.json({ subscribed: rows[0].n > 0, count: rows[0].n, vapid: !!process.env.VAPID_PUBLIC_KEY });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
