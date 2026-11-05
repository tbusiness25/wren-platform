'use strict';
/**
 * calendar-hub.js — b518 (2026-10-20) — "Events & Calendar"
 *
 * One calendar for the setting, in three layers (src/lib/calendar-layers.js), with
 * the weekly planning merged in as an overlay and a managers' message thread per
 * event. It REPLACES the separate calendar and planning ENTRY POINTS; it replaces
 * no data and no editor. Term dates stay in ladn.school_terms, the planning editor
 * stays where it is, parent events keep going through the same notify path they
 * always did (src/lib/event-notify.js, extracted from src/routes/events.js so there
 * is one copy), and /api/events still answers exactly as before.
 *
 *   GET    /meta                       who I am, what I may do, the categories, the rooms
 *   GET    /items?from&to&layers       the unified list
 *   POST   /items                      create (layer-aware)
 *   PUT    /items/:id                  edit
 *   DELETE /items/:id                  unpublish (soft — RSVPs and threads survive)
 *   GET    /messages?thread=           managers' hub: general channel or one event's thread
 *   POST   /messages                   post
 *   PATCH  /messages/:id               edit own
 *   DELETE /messages/:id               withdraw own (soft)
 *   POST   /messages/read              mark a thread read
 *   GET    /notes  POST /notes  PATCH /notes/:id  DELETE /notes/:id   managers' notes
 *   GET    /feeds                      my iCal subscription URLs (per layer)
 *   POST   /feeds/regenerate           new token for one layer
 *
 * AUDIENCE: the managers layer, the hub messages and the notes are refused to
 * anyone outside the hub on EVERY portal, and to a parent token everywhere.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const CL = require('../lib/calendar-layers');
const { notifyParentsOfEvent } = require('../lib/event-notify');
const { recordAudit } = require('../utils/audit');

router.use(authenticate);

// A parent token never reaches this router — the parents portal is served by
// parentRouter() at the foot of this file instead.
router.use((req, res, next) => {
  if (req.user && req.user.role === 'parent') return res.status(403).json({ error: 'Not available' });
  next();
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const bad = (res, msg) => res.status(400).json({ error: msg });

function range(req) {
  const from = DATE.test(String(req.query.from || '')) ? req.query.from : CL.ymd(new Date());
  let to = DATE.test(String(req.query.to || '')) ? req.query.to : null;
  if (!to) { const d = new Date(from + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 42); to = d.toISOString().slice(0, 10); }
  return { from, to };
}

async function hubGate(req, res) {
  const db = getPool();
  if (!(await CL.inManagersHub(db, req.user))) {
    res.status(403).json({ error: 'managers_only', message: 'The managers’ hub is Toby, the office manager and the admissions lead.' });
    return false;
  }
  return true;
}

// ── GET /meta ────────────────────────────────────────────────────────────────
router.get('/meta', async (req, res) => {
  try {
    const db = getPool();
    const hub = await CL.managersHubIds(db);
    const inHub = hub.includes(Number(req.user.id));
    let rooms = [];
    try { ({ rows: rooms } = await db.query('SELECT id, name FROM rooms ORDER BY id')); } catch (_) {}
    let pippin = { configured: false, enabled: false };
    try {
      const PB = require('../lib/pippin-bridge');
      const { rows } = await db.query(`SELECT value FROM settings WHERE key='pippin_send_enabled'`);
      pippin = { configured: PB.isConfigured(), enabled: !rows.length || rows[0].value !== 'false' };
    } catch (_) {}
    res.json({
      layers: await CL.readableLayers(db, req.user, req._portal),
      categories: {
        nursery: CL.categoriesFor('nursery'),
        parents: CL.categoriesFor('parents'),
        managers: CL.categoriesFor('managers'),
      },
      can: {
        nursery: CL.canEditNursery(req.user),
        parents: CL.canEditParents(req.user),
        managers: inHub,
      },
      in_managers_hub: inHub,
      managers_hub_size: hub.length,
      rooms,
      pippin,
      me: { id: req.user.id, role: req.user.role },
      planning_editor: '/admin/curriculum/planning',
      term_dates_editor: '/term-dates.html',
    });
  } catch (e) { console.error('[calendar-hub] meta:', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /items ───────────────────────────────────────────────────────────────
router.get('/items', async (req, res) => {
  try {
    const db = getPool();
    const { from, to } = range(req);
    const layers = String(req.query.layers || '').split(',').map(s => s.trim()).filter(l => CL.LAYERS.includes(l));
    const items = await CL.collect(db, {
      from, to, layers, user: req.user, portal: req._portal,
      includePlanning: String(req.query.planning || '') !== '0',
      roomId: req.query.room_id || null,
    });
    res.json({ from, to, items, count: items.length });
  } catch (e) { console.error('[calendar-hub] items:', e.message); res.status(500).json({ error: e.message }); }
});

// ── POST /items ──────────────────────────────────────────────────────────────
router.post('/items', async (req, res) => {
  const b = req.body || {};
  const db = getPool();
  const layer = CL.LAYERS.includes(b.layer) ? b.layer : 'parents';
  try {
    if (layer === 'managers') { if (!(await hubGate(req, res))) return; }
    else if (layer === 'nursery') { if (!CL.canEditNursery(req.user)) return res.status(403).json({ error: 'Managers and deputies only' }); }
    else if (!CL.canEditParents(req.user)) return res.status(403).json({ error: 'Managers, deputies and room leaders only' });

    const title = String(b.title || '').trim();
    if (!title) return bad(res, 'title required');
    if (!DATE.test(String(b.event_date || ''))) return bad(res, 'event_date (YYYY-MM-DD) required');
    if (b.end_date && !DATE.test(String(b.end_date))) return bad(res, 'end_date must be YYYY-MM-DD');
    if (b.end_date && String(b.end_date) < String(b.event_date)) return bad(res, 'end_date is before event_date');
    for (const k of ['start_time', 'end_time']) if (b[k] && !TIME.test(String(b[k]))) return bad(res, k + ' must be HH:MM');
    const category = b.category && CL.CATEGORIES[b.category] ? b.category : (layer === 'managers' ? 'manager' : layer === 'nursery' ? 'appointment' : 'event');

    // audience stays the field the rest of Wren already reads: 'staff' means not
    // for parents, a room id means that room, 'all' means everyone.
    const audience = layer === 'parents'
      ? (b.audience ? String(b.audience) : 'all')
      : 'staff';
    const staffIds = [...new Set((Array.isArray(b.staff_ids) ? b.staff_ids : []).map(n => parseInt(n, 10)).filter(Number.isInteger))];
    let hasStaffCol = false;
    try { hasStaffCol = await require('../lib/event-reminders').ensureSchema(db); } catch (_) {}

    const cols = ['title', 'description', 'event_date', 'end_date', 'start_time', 'end_time', 'location',
                  'audience', 'layer', 'category', 'all_day', 'rsvp_required', 'capacity', 'is_published', 'created_by'];
    const vals = [title, b.description || null, b.event_date, b.end_date || null,
                  b.start_time || null, b.end_time || null, b.location || null,
                  audience, layer, category, b.all_day === true || (!b.start_time && !b.end_time),
                  layer === 'parents' ? b.rsvp_required === true : false,
                  b.capacity ? parseInt(b.capacity, 10) : null,
                  b.is_published !== false, req.user.id];
    if (hasStaffCol) { cols.push('staff_ids'); vals.push(staffIds.length ? staffIds : null); }

    const { rows } = await db.query(
      `INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, vals);
    const ev = rows[0];

    // Parent-visible and published → the SAME in-app notification parents already get.
    if (layer === 'parents') await notifyParentsOfEvent(db, ev);

    recordAudit({ req, action: 'create', entity_type: 'calendar_event', entity_id: ev.id,
      meta: { layer, category, title } }).catch(() => {});
    res.status(201).json(CL.eventItem(ev));
  } catch (e) { console.error('[calendar-hub] create:', e.message); res.status(500).json({ error: e.message }); }
});

// ── PUT /items/:id ───────────────────────────────────────────────────────────
router.put('/items/:id', async (req, res) => {
  const b = req.body || {};
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return bad(res, 'bad id');
  try {
    const db = getPool();
    const { rows: cur } = await db.query('SELECT * FROM events WHERE id=$1', [id]);
    if (!cur.length) return res.status(404).json({ error: 'Event not found' });
    const before = cur[0];
    const fromLayer = before.layer || 'parents';
    if (fromLayer === 'managers' && !(await hubGate(req, res))) return;
    if (fromLayer === 'nursery' && !CL.canEditNursery(req.user)) return res.status(403).json({ error: 'Managers and deputies only' });
    if (fromLayer === 'parents' && !CL.canEditParents(req.user)) return res.status(403).json({ error: 'Managers, deputies and room leaders only' });

    const toLayer = CL.LAYERS.includes(b.layer) ? b.layer : fromLayer;
    if (toLayer === 'managers' && toLayer !== fromLayer && !(await hubGate(req, res))) return;

    const sets = [], vals = []; let i = 1;
    const push = (col, val) => { sets.push(`${col}=$${i++}`); vals.push(val); };
    if ('title' in b) { const t = String(b.title || '').trim(); if (!t) return bad(res, 'title required'); push('title', t); }
    if ('description' in b) push('description', b.description || null);
    if ('event_date' in b) { if (!DATE.test(String(b.event_date))) return bad(res, 'event_date must be YYYY-MM-DD'); push('event_date', b.event_date); }
    if ('end_date' in b) { if (b.end_date && !DATE.test(String(b.end_date))) return bad(res, 'end_date must be YYYY-MM-DD'); push('end_date', b.end_date || null); }
    for (const k of ['start_time', 'end_time']) if (k in b) { if (b[k] && !TIME.test(String(b[k]))) return bad(res, k + ' must be HH:MM'); push(k, b[k] || null); }
    if ('location' in b) push('location', b.location || null);
    if ('category' in b && CL.CATEGORIES[b.category]) push('category', b.category);
    if ('all_day' in b) push('all_day', !!b.all_day);
    if ('rsvp_required' in b) push('rsvp_required', !!b.rsvp_required);
    if ('capacity' in b) push('capacity', b.capacity ? parseInt(b.capacity, 10) : null);
    if ('is_published' in b) push('is_published', !!b.is_published);
    if ('audience' in b && toLayer === 'parents') push('audience', String(b.audience || 'all'));
    if (toLayer !== fromLayer) {
      push('layer', toLayer);
      push('audience', toLayer === 'parents' ? String(b.audience || 'all') : 'staff');
    }
    if (!sets.length) return bad(res, 'No fields to update');
    push('updated_at', new Date().toISOString());
    push('updated_by', req.user.id);
    vals.push(id);
    const { rows } = await db.query(`UPDATE events SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    const ev = rows[0];

    // Newly parent-visible (moved onto the parents layer, or published for the
    // first time) → notify once, the same way a new parent event does.
    const becameVisible = ev.layer === 'parents' && ev.is_published
      && (fromLayer !== 'parents' || before.is_published === false);
    if (becameVisible) await notifyParentsOfEvent(db, ev);

    recordAudit({ req, action: 'update', entity_type: 'calendar_event', entity_id: id,
      meta: { from_layer: fromLayer, to_layer: ev.layer, fields: sets.length } }).catch(() => {});
    res.json(CL.eventItem(ev));
  } catch (e) { console.error('[calendar-hub] update:', e.message); res.status(500).json({ error: e.message }); }
});

// ── DELETE /items/:id — unpublish. Soft on purpose: RSVPs and the thread stay. ─
router.delete('/items/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return bad(res, 'bad id');
  try {
    const db = getPool();
    const { rows: cur } = await db.query('SELECT layer FROM events WHERE id=$1', [id]);
    if (!cur.length) return res.status(404).json({ error: 'Event not found' });
    const layer = cur[0].layer || 'parents';
    if (layer === 'managers' && !(await hubGate(req, res))) return;
    if (layer === 'nursery' && !CL.canEditNursery(req.user)) return res.status(403).json({ error: 'Managers and deputies only' });
    if (layer === 'parents' && !CL.canEditParents(req.user)) return res.status(403).json({ error: 'Managers, deputies and room leaders only' });
    await db.query('UPDATE events SET is_published=false, updated_at=now(), updated_by=$2 WHERE id=$1', [id, req.user.id]);
    recordAudit({ req, action: 'delete', entity_type: 'calendar_event', entity_id: id, meta: { layer, soft: true } }).catch(() => {});
    res.json({ ok: true, id, unpublished: true });
  } catch (e) { console.error('[calendar-hub] delete:', e.message); res.status(500).json({ error: e.message }); }
});

// ── Managers' hub: messages ──────────────────────────────────────────────────
function threadKey(q) {
  const t = String(q || 'general').trim();
  if (t === 'general') return { key: 'general', eventId: null };
  const m = /^event:(\d+)$/.exec(t);
  if (m) return { key: 'event:' + m[1], eventId: parseInt(m[1], 10) };
  return null;
}

router.get('/messages', async (req, res) => {
  if (!(await hubGate(req, res))) return;
  const t = threadKey(req.query.thread);
  if (!t) return bad(res, 'thread must be "general" or "event:<id>"');
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT m.id, m.thread_key, m.event_id, m.staff_id, m.body, m.created_at, m.edited_at,
              COALESCE(s.preferred_name, s.first_name) AS author
         FROM manager_hub_messages m LEFT JOIN staff s ON s.id = m.staff_id
        WHERE m.thread_key = $1 AND m.deleted_at IS NULL
        ORDER BY m.created_at`, [t.key]);
    const { rows: r } = await db.query(
      `SELECT last_read_at FROM manager_hub_reads WHERE staff_id=$1 AND thread_key=$2`, [req.user.id, t.key]);
    res.json({ thread: t.key, messages: rows, last_read_at: r.length ? r[0].last_read_at : null, me: req.user.id });
  } catch (e) {
    if (e.code === '42P01') return res.json({ thread: t.key, messages: [], note: 'b518 migration not applied' });
    console.error('[calendar-hub] messages:', e.message); res.status(500).json({ error: e.message });
  }
});

router.get('/messages/unread', async (req, res) => {
  if (!(await hubGate(req, res))) return;
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT m.thread_key, count(*)::int AS n
         FROM manager_hub_messages m
         LEFT JOIN manager_hub_reads r ON r.thread_key = m.thread_key AND r.staff_id = $1
        WHERE m.deleted_at IS NULL AND m.staff_id <> $1
          AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
        GROUP BY m.thread_key`, [req.user.id]);
    const total = rows.reduce((a, r) => a + r.n, 0);
    res.json({ total, threads: rows });
  } catch (e) {
    if (e.code === '42P01') return res.json({ total: 0, threads: [] });
    res.status(500).json({ error: e.message });
  }
});

router.post('/messages', async (req, res) => {
  if (!(await hubGate(req, res))) return;
  const t = threadKey((req.body || {}).thread);
  if (!t) return bad(res, 'thread must be "general" or "event:<id>"');
  const body = String((req.body || {}).body || '').trim();
  if (!body) return bad(res, 'body required');
  if (body.length > 4000) return bad(res, 'body is too long (4000 characters)');
  try {
    const db = getPool();
    if (t.eventId) {
      const { rows } = await db.query('SELECT 1 FROM events WHERE id=$1', [t.eventId]);
      if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    }
    const { rows } = await db.query(
      `INSERT INTO manager_hub_messages (thread_key, event_id, staff_id, body)
       VALUES ($1,$2,$3,$4) RETURNING *`, [t.key, t.eventId, req.user.id, body]);
    recordAudit({ req, action: 'create', entity_type: 'manager_hub_message', entity_id: rows[0].id,
      meta: { thread: t.key } }).catch(() => {});
    res.status(201).json(rows[0]);
  } catch (e) { console.error('[calendar-hub] post message:', e.message); res.status(500).json({ error: e.message }); }
});

router.patch('/messages/:id', async (req, res) => {
  if (!(await hubGate(req, res))) return;
  const id = parseInt(req.params.id, 10);
  const body = String((req.body || {}).body || '').trim();
  if (!body) return bad(res, 'body required');
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE manager_hub_messages SET body=$1, edited_at=now()
        WHERE id=$2 AND staff_id=$3 AND deleted_at IS NULL RETURNING *`, [body, id, req.user.id]);
    if (!rows.length) return res.status(403).json({ error: 'You can only edit your own message' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/messages/:id', async (req, res) => {
  if (!(await hubGate(req, res))) return;
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE manager_hub_messages SET deleted_at=now()
        WHERE id=$1 AND staff_id=$2 AND deleted_at IS NULL RETURNING id`, [id, req.user.id]);
    if (!rows.length) return res.status(403).json({ error: 'You can only withdraw your own message' });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/messages/read', async (req, res) => {
  if (!(await hubGate(req, res))) return;
  const t = threadKey((req.body || {}).thread);
  if (!t) return bad(res, 'thread must be "general" or "event:<id>"');
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO manager_hub_reads (staff_id, thread_key, last_read_at) VALUES ($1,$2,now())
       ON CONFLICT (staff_id, thread_key) DO UPDATE SET last_read_at = now()`, [req.user.id, t.key]);
    res.json({ ok: true, thread: t.key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Managers' hub: notes (the third thing Send to Pippin can send) ───────────
router.get('/notes', async (req, res) => {
  if (!(await hubGate(req, res))) return;
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT n.*, COALESCE(s.preferred_name, s.first_name) AS author
         FROM manager_hub_notes n LEFT JOIN staff s ON s.id = n.staff_id
        WHERE n.deleted_at IS NULL ORDER BY n.pinned DESC, n.created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/notes', async (req, res) => {
  if (!(await hubGate(req, res))) return;
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return bad(res, 'title required');
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO manager_hub_notes (title, body, staff_id, pinned) VALUES ($1,$2,$3,$4) RETURNING *`,
      [title.slice(0, 200), b.body || null, req.user.id, b.pinned === true]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/notes/:id', async (req, res) => {
  if (!(await hubGate(req, res))) return;
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  if ('title' in b) { const t = String(b.title || '').trim(); if (!t) return bad(res, 'title required'); sets.push(`title=$${i++}`); vals.push(t.slice(0, 200)); }
  if ('body' in b) { sets.push(`body=$${i++}`); vals.push(b.body || null); }
  if ('pinned' in b) { sets.push(`pinned=$${i++}`); vals.push(!!b.pinned); }
  if (!sets.length) return bad(res, 'No fields to update');
  sets.push('updated_at=now()');
  vals.push(id);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE manager_hub_notes SET ${sets.join(', ')} WHERE id=$${i} AND deleted_at IS NULL RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Note not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/notes/:id', async (req, res) => {
  if (!(await hubGate(req, res))) return;
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE manager_hub_notes SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Note not found' });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── iCal subscription tokens, one per layer ──────────────────────────────────
// Reuses ladn.calendar_feed_tokens (entity_type='staff'), scopes 'cal-<layer>'.
const FEED_SCOPE = { nursery: 'cal-nursery', parents: 'cal-parents', managers: 'cal-managers' };
const newToken = () => crypto.randomBytes(24).toString('base64url');

async function myFeeds(db, req) {
  const allowed = await CL.readableLayers(db, req.user, req._portal);
  const out = [];
  for (const layer of allowed) {
    const scope = FEED_SCOPE[layer];
    const { rows } = await db.query(
      `SELECT token, regenerated_at FROM calendar_feed_tokens
        WHERE entity_type='staff' AND entity_id=$1 AND scope=$2 LIMIT 1`, [req.user.id, scope]);
    let token = rows.length ? rows[0].token : null;
    if (!token) {
      token = newToken();
      await db.query(
        `INSERT INTO calendar_feed_tokens (token, scope, entity_type, entity_id)
         VALUES ($1,$2,'staff',$3) ON CONFLICT (token) DO NOTHING`, [token, scope, req.user.id]);
    }
    out.push({
      layer,
      label: layer === 'nursery' ? 'Nursery (internal)' : layer === 'parents' ? 'Parents' : 'Managers',
      path: `/api/public/calendar/${token}.ics`,
      regenerated_at: rows.length ? rows[0].regenerated_at : null,
    });
  }
  return out;
}

router.get('/feeds', async (req, res) => {
  try { res.json({ feeds: await myFeeds(getPool(), req) }); }
  catch (e) { console.error('[calendar-hub] feeds:', e.message); res.status(500).json({ error: e.message }); }
});

router.post('/feeds/regenerate', async (req, res) => {
  const layer = String((req.body || {}).layer || '');
  if (!FEED_SCOPE[layer]) return bad(res, 'layer must be nursery, parents or managers');
  try {
    const db = getPool();
    const allowed = await CL.readableLayers(db, req.user, req._portal);
    if (!allowed.includes(layer)) return res.status(403).json({ error: 'Not your layer' });
    await db.query(
      `DELETE FROM calendar_feed_tokens WHERE entity_type='staff' AND entity_id=$1 AND scope=$2`,
      [req.user.id, FEED_SCOPE[layer]]);
    const token = newToken();
    await db.query(
      `INSERT INTO calendar_feed_tokens (token, scope, entity_type, entity_id, regenerated_at)
       VALUES ($1,$2,'staff',$3, now())`, [token, FEED_SCOPE[layer], req.user.id]);
    recordAudit({ req, action: 'update', entity_type: 'calendar_feed_token', entity_id: layer }).catch(() => {});
    res.json({ layer, path: `/api/public/calendar/${token}.ics` });
  } catch (e) { console.error('[calendar-hub] regenerate:', e.message); res.status(500).json({ error: e.message }); }
});

/**
 * parentRouter — the parents portal's read-only view of the PARENTS layer only.
 * Mounted by server-unified.js under /welcome/whats-on/api. Identity comes from
 * the portal's own Cloudflare-Access resolver, and the answer is the same list
 * every family sees: nothing individual, no child's name, published only.
 */
const parentApi = express.Router();
parentApi.get('/items', async (req, res) => {
  try {
    const db = getPool();
    const from = DATE.test(String(req.query.from || '')) ? req.query.from : CL.ymd(new Date());
    let to = DATE.test(String(req.query.to || '')) ? req.query.to : null;
    if (!to) { const d = new Date(from + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 70); to = d.toISOString().slice(0, 10); }
    const items = await CL.collect(db, { from, to, layers: ['parents'], portal: 'parents',
      user: { role: 'parent' }, publicView: true });
    res.json({ from, to, items, count: items.length });
  } catch (e) { console.error('[calendar-hub] parent items:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

module.exports = router;
module.exports.parentApi = parentApi;
