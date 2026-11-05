'use strict';
/* ===========================================================================
 * key-children.js (route) — 2026-10-01
 *
 * EY → More → Children → Key Children. One table per room: Child · Key person ·
 * Buddy. Toby: "Because the key person list changes so often, create a section
 * in the EY app … room leaders and above can edit their own rooms, and managers
 * both. Everyone else can view."
 *
 *   GET  /            every room, its children, who is key person and buddy
 *   PUT  /:childId    { key_person_id?, buddy_staff_id? } — null clears
 *   GET  /nudge       for the popup: the rooms I lead that still have gaps
 *
 * WHERE IT IS STORED
 *   key person  children.key_person_id — the same column the Roost child profile
 *               edits, so there is one answer to "who is X's key person".
 *   buddy       children.buddy_staff_id (migrations/2026-10-01-key-children-buddy.sql).
 *
 * WHO MAY EDIT
 *   manager / deputy_manager / admin / headteacher   every room
 *   room_leader                                      the room on their own staff record
 *   practitioner / senior_practitioner (2026-10-23)  children in the room on their own staff
 *                                                    record — how far, settings row
 *                                                    key_children_practitioner_scope:
 *                                                      'room' (default) any child in their room
 *                                                      'own'  their key children, their buddy
 *                                                             children, and any child in their
 *                                                             room with no key person yet
 *                                                      'off'  view only (the 2026-10-01 rule)
 *   everyone else (apprentices, cook, office …)      read only
 *   Toby, 2026-10-23: key persons managed by the staff who know the children. On prod only
 *   one of 19 staff had the room_leader role, so room-leader-only editing left 13 of 35
 *   children with no key person.
 *
 * AUDIT — every change (who, when, old → new) is an audit_log row: entity_type 'child',
 * diff { key_person_id|buddy_staff_id: { from, to } }. The Roost child profile (children.js
 * PUT) writes the same diff shape for key_person_id since 2026-10-23, so
 *   GET /history[?child_id=]   reads both, newest first, with names resolved
 * and each child in GET / carries last_change { at, by_name, via }.
 *
 * WHO IS NUDGED (the popup, and a weekday-morning bell notification)
 *   A room's leaders: staff with role room_leader in that room. A room with none
 *   falls back to the deputy attached to it — the same order lib/offratio.js uses
 *   to find a room's leader. The notification names no child, only counts, and
 *   its category (key_children) is not on the dispatcher's email allowlist, so it
 *   stays inside Wren.
 *
 * Child-data prefix: 'key-children' is already on server-unified.js's on-site,
 * off-site and HR-deny lists. Parents are refused here as well.
 * =========================================================================== */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { notify } = require('../services/notification-dispatcher');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const ALL_ROOMS_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher'];
const NOT_A_KEY_PERSON = ['cook', 'chef', 'parent'];
const PRACTITIONER_ROLES = ['practitioner', 'senior_practitioner'];
const SCOPES = ['room', 'own', 'off'];
const TZ = 'Europe/London';

router.use(authenticate);
router.use((req, res, next) => {
  if (req._portal === 'parents' || (req.user && req.user.role === 'parent')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    console.error('[key-children]', req.method, req.path, e.message);
    res.status(e.status || 500).json({ error: e.message });
  });
}

const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function hasBuddyColumn(db) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'children' AND column_name = 'buddy_staff_id'`, [SCHEMA()]);
  return rows.length > 0;
}

async function myStaff(db, userId) {
  const { rows } = await db.query(
    `SELECT id, role, room_id FROM ${SCHEMA()}.staff WHERE id = $1`, [userId]);
  return rows[0] || null;
}

/** Room ids this person may edit. 'all' for the managers. */
function editableRooms(user, me) {
  const role = (user && user.role) || (me && me.role);
  if (ALL_ROOMS_ROLES.includes(role)) return 'all';
  if (role === 'room_leader' && me && me.room_id) return [Number(me.room_id)];
  return [];
}
const canEditRoom = (editable, roomId) =>
  editable === 'all' || (roomId != null && editable.includes(Number(roomId)));

/** 2026-10-23 — settings.key_children_practitioner_scope, 'room' unless set. */
async function practitionerScope(db) {
  try {
    const { rows } = await db.query(
      `SELECT value FROM ${SCHEMA()}.settings WHERE key = 'key_children_practitioner_scope'`);
    const v = rows[0] ? String(rows[0].value || '').trim().toLowerCase() : '';
    return SCOPES.includes(v) ? v : 'room';
  } catch (_) { return 'room'; }
}

/**
 * Everything this person may change, as one object the GET and the PUT share:
 *   { all, rooms:[ids], practitioner:{ roomId, scope } | null, staffId }
 */
async function editRights(db, user, me) {
  const editable = editableRooms(user, me);
  const role = (user && user.role) || (me && me.role);
  let practitioner = null;
  if (editable !== 'all' && !editable.length && PRACTITIONER_ROLES.includes(role) && me && me.room_id) {
    const scope = await practitionerScope(db);
    if (scope !== 'off') practitioner = { roomId: Number(me.room_id), scope };
  }
  return { all: editable === 'all', rooms: editable === 'all' ? [] : editable, practitioner,
           staffId: Number(user && user.id) };
}
function canEditChild(rights, child) {
  if (rights.all) return true;
  if (child.room_id != null && rights.rooms.includes(Number(child.room_id))) return true;
  const p = rights.practitioner;
  if (!p || child.room_id == null || Number(child.room_id) !== p.roomId) return false;
  if (p.scope === 'room') return true;
  return !child.key_person_id
    || Number(child.key_person_id) === rights.staffId
    || Number(child.buddy_staff_id) === rights.staffId;
}
function describeRights(rights) {
  if (rights.all) return 'You can change every room.';
  if (rights.rooms.length) return 'You can change your own room.';
  if (rights.practitioner) {
    return rights.practitioner.scope === 'room'
      ? 'You can change any child in your own room.'
      : 'You can change your own key children and buddy children, and choose a key person for any child in your room who has none.';
  }
  return 'You can see every room. Ask your room leader or a manager to change something.';
}

/** Latest key person / buddy change per child — from either surface. */
async function lastChanges(db, childIds) {
  if (!childIds.length) return new Map();
  const { rows } = await db.query(`
    SELECT DISTINCT ON (a.entity_id) a.entity_id, a.occurred_at, a.meta->>'via' AS via,
           s.first_name AS by_first, s.last_name AS by_last
      FROM ${SCHEMA()}.audit_log a
      LEFT JOIN ${SCHEMA()}.staff s ON s.id = a.actor_id
     WHERE a.entity_type = 'child' AND a.entity_id = ANY($1::text[])
       AND (a.diff ? 'key_person_id' OR a.diff ? 'buddy_staff_id')
     ORDER BY a.entity_id, a.occurred_at DESC`, [childIds.map(String)]);
  return new Map(rows.map(r => [Number(r.entity_id), {
    at: r.occurred_at, via: r.via,
    by_name: `${r.by_first || ''} ${r.by_last || ''}`.trim() || 'Someone',
  }]));
}

const CHILD_IS_CURRENT = `c.is_active = true AND (c.leave_date IS NULL OR c.leave_date >= CURRENT_DATE)`;

/** Each room's leaders: room_leader role in the room, else the room's deputy. */
async function roomLeaders(db) {
  const { rows } = await db.query(`
    SELECT s.id, s.first_name, s.role, s.room_id
      FROM ${SCHEMA()}.staff s
     WHERE s.is_active = true AND s.room_id IS NOT NULL
       AND s.role IN ('room_leader', 'deputy_manager')
     ORDER BY s.id`);
  const byRoom = new Map();
  for (const r of rows) {
    const k = Number(r.room_id);
    if (!byRoom.has(k)) byRoom.set(k, { leaders: [], deputies: [] });
    byRoom.get(k)[r.role === 'room_leader' ? 'leaders' : 'deputies'].push(r);
  }
  const out = new Map();
  for (const [roomId, g] of byRoom) out.set(roomId, g.leaders.length ? g.leaders : g.deputies);
  return out;
}

/** Per room: how many current children, how many with no key person / no buddy. */
async function gapsByRoom(db) {
  const buddy = await hasBuddyColumn(db);
  const { rows } = await db.query(`
    SELECT r.id AS room_id, r.name AS room_name,
           count(c.id)::int AS total,
           count(c.id) FILTER (WHERE c.key_person_id IS NULL)::int AS missing_kp,
           ${buddy ? 'count(c.id) FILTER (WHERE c.buddy_staff_id IS NULL)::int' : '0'} AS missing_buddy
      FROM ${SCHEMA()}.rooms r
      LEFT JOIN ${SCHEMA()}.children c ON c.room_id = r.id AND ${CHILD_IS_CURRENT}
     GROUP BY r.id, r.name
     ORDER BY r.id`);
  return rows;
}

// ── GET / ───────────────────────────────────────────────────────────────────
router.get('/', wrap(async (req, res) => {
  const db = getPool();
  const me = await myStaff(db, req.user.id);
  const editable = editableRooms(req.user, me);
  const rights = await editRights(db, req.user, me);
  const buddy = await hasBuddyColumn(db);

  const [{ rows: rooms }, { rows: kids }, { rows: staff }] = await Promise.all([
    db.query(`SELECT id, name FROM ${SCHEMA()}.rooms ORDER BY id`),
    db.query(`
      SELECT c.id, c.first_name, c.last_name, c.preferred_name, c.date_of_birth, c.room_id,
             c.key_person_id, ${buddy ? 'c.buddy_staff_id' : 'NULL::int AS buddy_staff_id'}
        FROM ${SCHEMA()}.children c
       WHERE ${CHILD_IS_CURRENT}
       ORDER BY c.first_name, c.last_name`),
    db.query(`
      SELECT s.id, s.first_name, s.last_name, s.role, s.room_id, r.name AS room_name,
             COALESCE(s.is_demo, false) AS is_demo
        FROM ${SCHEMA()}.staff s
        LEFT JOIN ${SCHEMA()}.rooms r ON r.id = s.room_id
       WHERE s.is_active = true AND COALESCE(s.role, '') <> ALL($1::text[])
       ORDER BY s.first_name, s.last_name`, [NOT_A_KEY_PERSON]),
  ]);

  let changes = new Map();
  try { changes = await lastChanges(db, kids.map(c => c.id)); }
  catch (e) { console.error('[key-children] last changes:', e.message); }
  const shape = c => ({
    id: c.id,
    name: `${c.preferred_name || c.first_name || ''} ${c.last_name || ''}`.trim(),
    date_of_birth: c.date_of_birth,
    room_id: c.room_id,
    key_person_id: c.key_person_id,
    buddy_staff_id: c.buddy_staff_id,
    can_edit: canEditChild(rights, c),
    last_change: changes.get(Number(c.id)) || null,
  });
  const groups = rooms.map(r => {
    const children = kids.filter(c => Number(c.room_id) === Number(r.id)).map(shape);
    return {
      id: r.id, name: r.name, can_edit: canEditRoom(editable, r.id) || children.some(c => c.can_edit), children,
      missing_kp: children.filter(c => !c.key_person_id).length,
      missing_buddy: children.filter(c => !c.buddy_staff_id).length,
    };
  });
  const roomless = kids.filter(c => !c.room_id).map(shape);
  if (roomless.length) {
    groups.push({ id: null, name: 'No room set', can_edit: editable === 'all', children: roomless,
      missing_kp: roomless.filter(c => !c.key_person_id).length,
      missing_buddy: roomless.filter(c => !c.buddy_staff_id).length });
  }

  res.json({
    me: { id: Number(req.user.id), role: req.user.role, room_id: me ? me.room_id : null,
          edit_scope: rights.all ? 'all' : rights.rooms.length ? 'room_leader'
            : rights.practitioner ? 'practitioner_' + rights.practitioner.scope : 'view',
          edit_note: describeRights(rights) },
    can_edit_any: editable === 'all' || editable.length > 0 || groups.some(g => g.children.some(c => c.can_edit)),
    buddy_supported: buddy,
    rooms: groups,
    staff: staff.map(s => ({ id: s.id, name: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
                             role: s.role, room_id: s.room_id, room_name: s.room_name,
                             is_demo: s.is_demo })),
  });
}));

// ── PUT /:childId ───────────────────────────────────────────────────────────
router.put('/:childId', wrap(async (req, res) => {
  const db = getPool();
  const childId = Number(req.params.childId);
  if (!Number.isInteger(childId) || childId <= 0) return res.status(400).json({ error: 'Bad child id' });
  const b = req.body || {};
  const wantKp = Object.prototype.hasOwnProperty.call(b, 'key_person_id');
  const wantBuddy = Object.prototype.hasOwnProperty.call(b, 'buddy_staff_id');
  if (!wantKp && !wantBuddy) return res.status(400).json({ error: 'Nothing to change' });
  const buddyOk = await hasBuddyColumn(db);
  if (wantBuddy && !buddyOk) return res.status(400).json({ error: 'Buddy is not set up on this system yet' });

  const me = await myStaff(db, req.user.id);
  const rights = await editRights(db, req.user, me);
  const { rows: cr } = await db.query(`
    SELECT c.id, c.room_id, c.key_person_id, ${buddyOk ? 'c.buddy_staff_id' : 'NULL::int AS buddy_staff_id'}
      FROM ${SCHEMA()}.children c WHERE c.id = $1 AND ${CHILD_IS_CURRENT}`, [childId]);
  if (!cr.length) return res.status(404).json({ error: 'Child not found' });
  const child = cr[0];
  if (!canEditChild(rights, child)) {
    return res.status(403).json({ error: rights.all || rights.rooms.length || rights.practitioner
      ? (rights.practitioner && rights.practitioner.scope === 'own'
          ? 'You can change your own key children and buddy children, or a child in your room with no key person'
          : 'You can only change key children in your own room')
      : 'Only room staff, room leaders and managers can change key children' });
  }

  const norm = v => (v === null || v === '' || v === undefined) ? null : Number(v);
  const kp = wantKp ? norm(b.key_person_id) : child.key_person_id;
  const buddy = wantBuddy ? norm(b.buddy_staff_id) : child.buddy_staff_id;
  for (const [label, v] of [['key person', kp], ['buddy', buddy]]) {
    if (v === null) continue;
    if (!Number.isInteger(v) || v <= 0) return res.status(400).json({ error: `Bad ${label}` });
  }
  if (kp && buddy && Number(kp) === Number(buddy)) {
    return res.status(400).json({ error: 'The buddy has to be someone other than the key person' });
  }
  const ids = [kp, buddy].filter(v => v !== null);
  if (ids.length) {
    const { rows: ok } = await db.query(
      `SELECT id FROM ${SCHEMA()}.staff WHERE id = ANY($1::int[]) AND is_active = true
          AND COALESCE(role, '') <> ALL($2::text[])`, [ids, NOT_A_KEY_PERSON]);
    if (ok.length !== new Set(ids).size) return res.status(400).json({ error: 'That member of staff cannot be chosen' });
  }

  const sets = [], vals = [];
  if (wantKp) { vals.push(kp); sets.push(`key_person_id = $${vals.length}`); }
  if (wantBuddy) { vals.push(buddy); sets.push(`buddy_staff_id = $${vals.length}`); }
  vals.push(childId);
  const { rows } = await db.query(
    `UPDATE ${SCHEMA()}.children SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${vals.length}
      RETURNING id, key_person_id, ${buddyOk ? 'buddy_staff_id' : 'NULL::int AS buddy_staff_id'}`, vals);

  const diff = {};
  if (wantKp && kp !== child.key_person_id) diff.key_person_id = { from: child.key_person_id, to: kp };
  if (wantBuddy && buddy !== child.buddy_staff_id) diff.buddy_staff_id = { from: child.buddy_staff_id, to: buddy };
  if (Object.keys(diff).length) {
    await recordAudit({ req, action: 'update', entity_type: 'child', entity_id: childId, diff,
      meta: { via: 'ey-key-children', as: req.user.role,
              scope: rights.all ? 'all' : rights.rooms.length ? 'room_leader'
                : rights.practitioner ? 'practitioner_' + rights.practitioner.scope : null } }).catch(() => {});
  }
  res.json(rows[0]);
}));

// ── GET /history — who changed a key person or buddy, when, from → to ────────
// 2026-10-23. Everyone who can open this page can read it (it names staff and the
// children already on this page, nothing else). ?child_id= for one child.
router.get('/history', wrap(async (req, res) => {
  const db = getPool();
  const childId = req.query.child_id != null ? Number(req.query.child_id) : null;
  if (childId !== null && (!Number.isInteger(childId) || childId <= 0)) return res.status(400).json({ error: 'Bad child id' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 200);
  const vals = [];
  let where = `a.entity_type = 'child' AND (a.diff ? 'key_person_id' OR a.diff ? 'buddy_staff_id')`;
  if (childId) { vals.push(String(childId)); where += ` AND a.entity_id = $${vals.length}`; }
  vals.push(limit);
  const { rows } = await db.query(`
    SELECT a.id, a.occurred_at, a.entity_id, a.diff, a.meta->>'via' AS via,
           s.first_name AS by_first, s.last_name AS by_last,
           c.first_name AS c_first, c.preferred_name AS c_pref, c.last_name AS c_last
      FROM ${SCHEMA()}.audit_log a
      LEFT JOIN ${SCHEMA()}.staff s ON s.id = a.actor_id
      LEFT JOIN ${SCHEMA()}.children c ON c.id::text = a.entity_id
     WHERE ${where}
     ORDER BY a.occurred_at DESC
     LIMIT $${vals.length}`, vals);
  const ids = new Set();
  for (const r of rows) for (const f of ['key_person_id', 'buddy_staff_id']) {
    const d = r.diff && r.diff[f];
    if (d) { if (d.from) ids.add(Number(d.from)); if (d.to) ids.add(Number(d.to)); }
  }
  const names = new Map();
  if (ids.size) {
    const { rows: st } = await db.query(
      `SELECT id, first_name, last_name FROM ${SCHEMA()}.staff WHERE id = ANY($1::int[])`, [[...ids]]);
    for (const s of st) names.set(Number(s.id), `${s.first_name || ''} ${s.last_name || ''}`.trim());
  }
  const nm = id => id == null ? null : (names.get(Number(id)) || 'Former staff');
  const out = [];
  for (const r of rows) {
    for (const [f, label] of [['key_person_id', 'Key person'], ['buddy_staff_id', 'Buddy']]) {
      const d = r.diff && r.diff[f];
      if (!d) continue;
      out.push({
        at: r.occurred_at, child_id: Number(r.entity_id),
        child_name: `${r.c_pref || r.c_first || ''} ${r.c_last || ''}`.trim() || 'Former child',
        field: f, label, from: nm(d.from), to: nm(d.to),
        by: `${r.by_first || ''} ${r.by_last || ''}`.trim() || 'Someone',
        via: r.via === 'ey-key-children' ? 'Key Children' : (r.via || 'Child profile'),
      });
    }
  }
  res.json({ changes: out });
}));

// ── GET /nudge — for the EY popup ───────────────────────────────────────────
// Shown to a room's leaders (see the header), and only while their room has a
// child with no key person or no buddy.
router.get('/nudge', wrap(async (req, res) => {
  const db = getPool();
  const leaders = await roomLeaders(db);
  const myRooms = [...leaders.entries()]
    .filter(([, list]) => list.some(s => Number(s.id) === Number(req.user.id)))
    .map(([roomId]) => roomId);
  if (!myRooms.length) return res.json({ show: false, rooms: [] });
  const rooms = (await gapsByRoom(db))
    .filter(r => myRooms.includes(Number(r.room_id)) && r.total > 0 && (r.missing_kp > 0 || r.missing_buddy > 0));
  res.json({ show: rooms.length > 0, rooms });
}));

// ── The nudge itself: weekday mornings, in-process ──────────────────────────
// Same shape as the hr-warnings sweep: no host cron, a 15-minute tick that acts
// once per London day, at/after 08:00, Monday–Friday. The dev container reads its
// own database's settings row, so it never nudges prod staff. Switch off with
// settings.key_children_nudge = 'off'.
async function nudgeLeaders(db, { force = false, launch = false } = {}) {
  const today = londonToday();
  if (!force) {
    const { rows: s } = await db.query(
      `SELECT key, value FROM ${SCHEMA()}.settings WHERE key IN ('key_children_nudge','key_children_last_nudge')`);
    const v = Object.fromEntries(s.map(r => [r.key, r.value]));
    if (String(v.key_children_nudge || 'on') === 'off') return { sent: 0, reason: 'switched off' };
    if (v.key_children_last_nudge === today) return { sent: 0, reason: 'already ran today' };
  }
  await db.query(`INSERT INTO ${SCHEMA()}.settings (key, value) VALUES ('key_children_last_nudge', $1)
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [today]);

  const leaders = await roomLeaders(db);
  const gaps = await gapsByRoom(db);
  let sent = 0;
  for (const g of gaps) {
    const list = leaders.get(Number(g.room_id)) || [];
    if (!list.length || !g.total) continue;
    if (!launch && g.missing_kp === 0) continue;   // the daily bell is about key persons
    const plural = n => `${n} ${n === 1 ? 'child' : 'children'}`;
    const title = launch
      ? `New: Key Children — please fill in ${g.room_name}`
      : `${plural(g.missing_kp)} in ${g.room_name} ${g.missing_kp === 1 ? 'has' : 'have'} no key person`;
    const body = launch
      ? `Wren now keeps the key person list in one place: More → Children → Key Children. Please set a key person and a buddy for every child in ${g.room_name}. Right now ${plural(g.missing_kp)} ${g.missing_kp === 1 ? 'has' : 'have'} no key person and ${plural(g.missing_buddy)} ${g.missing_buddy === 1 ? 'has' : 'have'} no buddy. It changes often, so keep it up to date — My Morning reads from it.`
      : `Open Key Children and choose a key person for ${g.missing_kp === 1 ? 'them' : 'each of them'}. Until then they don't appear on anyone's My Morning.`;
    for (const s of list) {
      notify('key_children', 'staff', s.id, title, body,
        { priority: launch ? 'high' : 'normal', link: '/ey/key-children' });
      sent++;
    }
  }
  return { sent };
}

if (!global.__wrenKeyChildrenNudge) {
  global.__wrenKeyChildrenNudge = true;
  const tick = async () => {
    try {
      const now = new Date();
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(now).map(p => [p.type, p.value]));
      if (['Sat', 'Sun'].includes(parts.weekday) || Number(parts.hour) < 8) return;
      const out = await nudgeLeaders(getPool());
      if (out.sent) console.log(`[key-children] morning nudge: ${out.sent} notification(s)`);
    } catch (e) { console.error('[key-children] nudge failed:', e.message); }
  };
  setTimeout(tick, 90 * 1000).unref();
  setInterval(tick, 15 * 60 * 1000).unref();
}

module.exports = router;
module.exports.nudgeLeaders = nudgeLeaders;
