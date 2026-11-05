'use strict';
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { getPool }     = require('../db/pool');
const authenticate    = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const { CATEGORIES, CATEGORY_KEYS, defaultPresetForRole,
        isComplianceLocked, defaultModeForCategory } = require('../services/notification-categories');
// b230 — ONE write path for preferences. This file used to write
// notification_preferences directly while PUT /my-settings wrote
// user_notification_prefs directly, so the two could disagree and the
// dispatcher (which reads both) obeyed whichever it consulted first.
const { savePreferences } = require('../services/notification-prefs-store');
const TAXONOMY = require('../services/notification-taxonomy');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const VALID_MODES = ['off', 'inapp', 'inapp_push', 'digest'];

// seed-gdpr-20261030: on Seed (the HR portal) the bell only carries staff-side categories;
// child, parent and inbox notifications stay on Nest. Appends to `params`, returns the SQL.
function seedClause(req, params, alias) {
  if (req._portal !== 'hr') return '';
  params.push(TAXONOMY.SEED_CATEGORIES);
  return ` AND ${alias}.category = ANY($${params.length}::varchar[])`;
}

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
      hasRole(user, ['manager','deputy_manager', 'admin']))                        return true;
  if (row.recipient_type === 'parent'     && row.recipient_id  === user.id)    return true;
  return false;
}

function recipientClause(user, alias = 'n') {
  const isManager = hasRole(user, ['manager','deputy_manager', 'admin']);
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
  // sec-20261026: this was open to ANY token, parents included — anyone could
  // put an "urgent" notification with an off-site link in front of all staff or
  // any family. No page calls it (server code uses notify() directly). Managers
  // only, and the link must be a same-site path.
  if (!req.user || !['manager', 'deputy_manager', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.body && req.body.link != null && req.body.link !== ''
      && !/^\/(?!\/)/.test(String(req.body.link))) {
    return res.status(400).json({ error: 'link must be a relative path' });
  }
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
    const params = [uid];
    const seed   = seedClause(req, params, 'n');

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM notifications n
       WHERE ${clause} AND n.read_at IS NULL AND n.dismissed_at IS NULL${seed}`,
      params
    );

    const { rows } = await db.query(
      `SELECT * FROM notifications n
       WHERE ${clause} AND n.read_at IS NULL AND n.dismissed_at IS NULL${seed}
       ORDER BY n.created_at DESC LIMIT 10`,
      params
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
    const params = [req.user.id];
    const seed   = seedClause(req, params, 'n');
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM notifications n
       WHERE ${clause} AND n.read_at IS NULL AND n.dismissed_at IS NULL${seed}`,
      params
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

    const params = [uid];
    let q = `SELECT * FROM notifications n WHERE ${clause} AND n.dismissed_at IS NULL`;
    q += seedClause(req, params, 'n');
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
    const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
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
    // seed-gdpr-20261030: "mark all read" on Seed must not clear Nest's unread child items unseen.
    const params = [uid];
    const seed   = seedClause(req, params, 'n');
    await db.query(
      `UPDATE notifications n SET read_at=NOW()
       WHERE ${clause} AND n.read_at IS NULL${seed}`,
      params
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/dismiss-all — b149 "Clear all" button
// b230: two changes, both driven by the notification-centre work.
//   1. Safeguarding is EXCLUDED by default. Clearing the bell is a housekeeping
//      gesture; wiping a safeguarding concern with it is not, and the response
//      reports how many were held back so the UI can ask before repeating the
//      call with include_safeguarding.
//   2. Optional `tab` scopes the clear to one category tab, so "Dismiss all" on
//      the Payments tab clears payments and nothing else.
// Body (all optional): { tab: '<taxonomy tab>', include_safeguarding: bool }
router.post('/dismiss-all', async (req, res) => {
  try {
    const db     = getPool();
    const uid    = req.user.id;
    const clause = recipientClause(req.user, 'n');
    const body   = req.body || {};
    const includeSafeguarding = body.include_safeguarding === true;

    const params = [uid];
    let sql = `UPDATE notifications n SET dismissed_at=NOW()
                WHERE ${clause} AND n.dismissed_at IS NULL`;
    sql += seedClause(req, params, 'n');

    const tabCats = TAXONOMY.categoriesForTab(body.tab);
    if (tabCats) { params.push(tabCats); sql += ` AND n.category = ANY($${params.length}::varchar[])`; }

    // Only fence off safeguarding when it is not the tab being cleared — asking
    // for the Safeguarding tab IS the explicit intent the fence exists to require.
    const fence = !includeSafeguarding && body.tab !== 'safeguarding';
    const sgCats = TAXONOMY.categoriesForTab('safeguarding') || [];
    if (fence && sgCats.length) {
      params.push(sgCats);
      sql += ` AND NOT (n.category = ANY($${params.length}::varchar[]))`;
    }
    sql += ` RETURNING n.id`;

    const { rows } = await db.query(sql, params);

    let heldBack = 0;
    if (fence && sgCats.length) {
      const hb = await db.query(
        `SELECT COUNT(*)::int AS c FROM notifications n
          WHERE ${clause} AND n.dismissed_at IS NULL AND n.category = ANY($2::varchar[])`,
        [uid, sgCats]);
      heldBack = hb.rows[0].c;
    }
    res.json({ ok: true, dismissed: rows.length, safeguarding_held_back: heldBack });
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
    const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
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
// b230: routed through savePreferences so a category disabled here is ALSO set
// to mode='off' in user_notification_prefs. Before this, disabling a category
// on the old screen left mode='inapp_push' behind and the notification still
// fired — the two-writable-systems bug that produced the b230 ticket.
router.put('/prefs', async (req, res) => {
  const { prefs } = req.body; // array of {event_category, channels, enabled, scope}
  if (!Array.isArray(prefs)) return res.status(400).json({ error: 'prefs array required' });
  try {
    const r = await savePreferences(getPool(), req.user.id, { categories: prefs });
    res.json({ ok: true, saved: r.saved, rejected: r.rejected });
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

// ── b149: self-service per-category mode + quiet hours ───────────────────────
// Distinct from the /prefs (channels/scope) system above — this is the simple
// Off/In-app/In-app+Push/Digest control the settings-page UI presents, backed
// by user_notification_prefs + user_notification_settings.

// GET /api/notifications/my-settings — own mode per category + quiet hours
router.get('/my-settings', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Not applicable to parent accounts' });
  try {
    const db = getPool();
    const [{ rows: modeRows }, { rows: qhRows }] = await Promise.all([
      db.query(`SELECT category, mode FROM user_notification_prefs WHERE staff_id=$1`, [req.user.id]),
      db.query(`SELECT quiet_hours_enabled, quiet_hours_start, quiet_hours_end
                 FROM user_notification_settings WHERE staff_id=$1`, [req.user.id]),
    ]);
    const modeMap = Object.fromEntries(modeRows.map(r => [r.category, r.mode]));
    const categories = CATEGORY_KEYS.map(k => ({
      category: k,
      label: CATEGORIES[k].label,
      urgent: CATEGORIES[k].urgent,
      locked: isComplianceLocked(k),
      mode: modeMap[k] || defaultModeForCategory(k),
    }));
    const qh = qhRows[0] || { quiet_hours_enabled: true, quiet_hours_start: '20:00:00', quiet_hours_end: '07:00:00' };
    res.json({
      categories,
      quiet_hours: {
        enabled: qh.quiet_hours_enabled,
        start: String(qh.quiet_hours_start).slice(0, 5),
        end: String(qh.quiet_hours_end).slice(0, 5),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/notifications/my-settings — update own mode(s) + quiet hours
router.put('/my-settings', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Not applicable to parent accounts' });
  const { categories, quiet_hours } = req.body || {};
  const db = getPool();
  try {
    // Pre-validate so a locked category still 400s with the same message the
    // settings UI has always shown, rather than silently landing in `rejected`.
    if (Array.isArray(categories)) {
      for (const c of categories) {
        if (!CATEGORY_KEYS.includes(c.category)) continue;
        if (!VALID_MODES.includes(c.mode)) continue;
        // 'digest' delays delivery to the next daily rollup (up to ~24h) — same
        // practical effect as 'off' for a compliance-critical category, so it's
        // blocked alongside 'off' (2026-07-23 q01: was only checking 'off').
        if (['off', 'digest'].includes(c.mode) && isComplianceLocked(c.category)) {
          return res.status(400).json({ error: `${CATEGORIES[c.category].label} cannot be set to ${c.mode === 'off' ? 'off' : 'digest'} — compliance-critical category requires immediate delivery` });
        }
      }
    }
    // b230 — one write path. Setting mode here now also flips `enabled` in
    // notification_preferences, so this screen and the matrix agree.
    await savePreferences(db, req.user.id, {
      categories: Array.isArray(categories)
        ? categories.filter(c => VALID_MODES.includes(c && c.mode))
        : [],
      quiet_hours,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Manager: view/edit any staff's prefs ─────────────────────────────────────

// GET /api/notifications/prefs/all-staff — summary for manager view
router.get('/prefs/all-staff', async (req, res) => {
  // 29 Oct: room leaders dropped — every colleague's Telegram link and notification settings.
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
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
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader']) &&
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
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader'])) {
    return res.status(403).json({ error: 'Manager only' });
  }
  const { prefs } = req.body;
  if (!Array.isArray(prefs)) return res.status(400).json({ error: 'prefs array required' });
  const sid = parseInt(req.params.staffId);
  if (!Number.isFinite(sid)) return res.status(400).json({ error: 'bad staffId' });
  try {
    // b230 — same single write path as /api/notification-matrix (see above).
    const r = await savePreferences(getPool(), sid, { categories: prefs });
    res.json({ ok: true, saved: r.saved, rejected: r.rejected });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/prefs/:staffId/reset — manager resets staff to role defaults
router.post('/prefs/:staffId/reset', async (req, res) => {
  // 29 Oct: room leaders dropped — they could reset any colleague's notification settings.
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
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
      `INSERT INTO push_subscriptions (staff_id, endpoint, p256dh, auth, user_agent, last_used_at, portal)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6)
       ON CONFLICT (endpoint) DO UPDATE
         SET staff_id=$1, p256dh=$3, auth=$4, user_agent=$5, last_used_at=NOW(), portal=$6`,
      // seed-gdpr-20261030: which app this device subscribed from — the dispatcher keeps
      // child/parent pushes off a Seed (HR) subscription. The shell re-syncs on every load.
      [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, (req.body.user_agent || '').slice(0, 300),
       req._portal || null]
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


// ─────────────────────────────────────────────────────────────────────────────
// b230 — the notification centre (EyLog-style categorised list)
//
// GET /api/notifications/centre?tab=&page=&q=
//   One call returns BOTH the tab bar (every tab with its live count) and the
//   page of rows for the selected tab, so the screen can never show a count
//   that disagrees with the list under it. Tabs and tones come from
//   services/notification-taxonomy — the same map the UI imports its labels
//   from, so a category can never be counted on one tab and listed on another.
//
// Scoped by the same recipientClause as the bell: staff see their own +
// all-staff (+ all-managers if they are one), parents see their child's.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/centre', async (req, res) => {
  try {
    const db     = getPool();
    const uid    = req.user.id;
    const clause = recipientClause(req.user, 'n');
    const tab    = TAXONOMY.TAB_KEYS.includes(req.query.tab) ? req.query.tab : 'all';
    const page   = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '40', 10) || 40));
    const q      = String(req.query.q || '').trim().slice(0, 80);

    // ── counts: one GROUP BY over the whole undismissed feed, folded into tabs
    const { rows: catRows } = await db.query(
      `SELECT n.category,
              COUNT(*)::int                                   AS total,
              COUNT(*) FILTER (WHERE n.read_at IS NULL)::int  AS unread
         FROM notifications n
        WHERE ${clause} AND n.dismissed_at IS NULL
        GROUP BY n.category`,
      [uid]
    );
    const counts = Object.fromEntries(TAXONOMY.TAB_KEYS.map(k => [k, { total: 0, unread: 0 }]));
    const unmapped = [];
    for (const r of catRows) {
      const t = TAXONOMY.tabForCategory(r.category);
      counts[t].total  += r.total;  counts[t].unread  += r.unread;
      counts.all.total += r.total;  counts.all.unread += r.unread;
      if (!TAXONOMY.CATEGORY_TAB[r.category]) unmapped.push(r.category);
    }

    // ── the page itself
    const params = [uid];
    let sql = `SELECT n.* FROM notifications n
                WHERE ${clause} AND n.dismissed_at IS NULL`;
    const tabCats = TAXONOMY.categoriesForTab(tab);
    if (tabCats) {
      // A tab must also carry categories that only match by PREFIX RULE, or a
      // future category would be counted on the tab but missing from its list.
      const extra = catRows.map(r => r.category)
        .filter(c => !TAXONOMY.CATEGORY_TAB[c] && TAXONOMY.tabForCategory(c) === tab);
      params.push(tabCats.concat(extra));
      sql += ` AND n.category = ANY($${params.length}::varchar[])`;
    }
    if (q) {
      params.push('%' + q + '%');
      sql += ` AND (n.title ILIKE $${params.length} OR n.body ILIKE $${params.length})`;
    }
    params.push(limit + 1, page * limit);
    sql += ` ORDER BY n.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await db.query(sql, params);
    const hasMore  = rows.length > limit;
    const items    = rows.slice(0, limit).map(n => ({
      ...n,
      tab:            TAXONOMY.tabForCategory(n.category),
      tone:           TAXONOMY.toneFor(n.category, n.priority),
      category_label: TAXONOMY.labelForCategory(n.category),
      protected:      TAXONOMY.needsDismissConfirm(n.category),
    }));

    res.json({
      tab, page, limit, has_more: hasMore, items,
      tabs: TAXONOMY.TABS.map(t => ({
        key: t.key, label: t.label, icon: t.icon, tone: t.tone,
        count: counts[t.key].total, unread: counts[t.key].unread,
      })),
      // Surfaced rather than swallowed: if a build starts emitting a category
      // nobody mapped, it lands on Warnings & System by prefix rule and shows
      // up here, instead of quietly going missing.
      unmapped_categories: [...new Set(unmapped)].sort(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications/centre/tabs — counts only, for the bell badge / polling
router.get('/centre/tabs', async (req, res) => {
  try {
    const db     = getPool();
    const clause = recipientClause(req.user, 'n');
    const { rows } = await db.query(
      `SELECT n.category, COUNT(*) FILTER (WHERE n.read_at IS NULL)::int AS unread
         FROM notifications n
        WHERE ${clause} AND n.dismissed_at IS NULL
        GROUP BY n.category`,
      [req.user.id]
    );
    const counts = Object.fromEntries(TAXONOMY.TAB_KEYS.map(k => [k, 0]));
    for (const r of rows) { counts[TAXONOMY.tabForCategory(r.category)] += r.unread; counts.all += r.unread; }
    res.json({ tabs: TAXONOMY.TABS.map(t => ({ key: t.key, label: t.label, icon: t.icon, unread: counts[t.key] })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// GET /api/notifications/channel-status — b230
// What can this member of staff ACTUALLY be reached on, right now? The matrix
// screen greys out and labels a channel from this rather than offering a toggle
// that silently does nothing (Toby, b230: "Grey out and label anything not
// wired"). Every field says WHY, so the UI never has to guess a reason.
router.get('/channel-status', async (req, res) => {
  try {
    const db = getPool();
    const [{ rows: st }, { rows: subs }] = await Promise.all([
      db.query(`SELECT telegram_chat_id, email FROM staff WHERE id=$1`, [req.user.id]),
      db.query(`SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE staff_id=$1`, [req.user.id]),
    ]);
    const me       = st[0] || {};
    const vapid    = !!process.env.VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY;
    const devices  = subs[0].n;
    const smtp     = !!process.env.SMTP_HOST;
    const tgLinked = !!(me.telegram_chat_id && me.telegram_chat_id !== '000000000');
    res.json({
      inapp:    { ready: true, reason: null },
      push:     { ready: vapid && devices > 0, devices, vapid,
                  reason: !vapid ? 'Web push is not configured on this server'
                        : devices === 0 ? 'No device has been enabled yet — use "Enable on this device"'
                        : null },
      telegram: { ready: tgLinked,
                  reason: tgLinked ? null : 'Telegram account not linked — link it in Notification settings' },
      email:    { ready: smtp && !!me.email, address: me.email || null,
                  reason: !smtp ? 'No SMTP server is configured on this server'
                        : !me.email ? 'No email address on this staff record'
                        : null },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
