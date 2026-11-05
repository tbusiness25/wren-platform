'use strict';
// b334 (2026-09-15) — The duties tracker API.
//
// Roost /admin/duties and EY /ey/duties both read this. Reads are cheap: the
// matrix is a straight SELECT off duty_status, which src/lib/duties/refresh.js
// recomputes every 15 minutes (below) — nothing here evaluates a duty live.
//
// Writes: POST /parent-chat and POST /staff-meeting are the two new "record it"
// forms the brief asked for where nothing existing could capture the duty.
// POST /refresh forces an immediate recompute (manager only — it is not
// expensive at this setting's size, ~85 children x 24 duties, but it is a
// deliberate action, not something a page load should trigger).
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = authenticate;
const { refreshAll } = require('../lib/duties/refresh');

router.use(authenticate);

const STATE_ORDER = { overdue: 0, due_soon: 1, done: 2, not_applicable: 3 };

async function subjectLabels(db, scope, roomId) {
  if (scope === 'child') {
    let sql = `SELECT c.id, c.first_name || ' ' || c.last_name AS name, c.room_id, r.name AS room_name
                 FROM children c LEFT JOIN rooms r ON r.id = c.room_id WHERE c.is_active = true`;
    const params = [];
    if (roomId) { params.push(roomId); sql += ` AND c.room_id = $${params.length}`; }
    sql += ` ORDER BY c.first_name, c.last_name`;
    return (await db.query(sql, params)).rows;
  }
  if (scope === 'room') {
    let sql = `SELECT id, name FROM rooms`;
    const params = [];
    if (roomId) { params.push(roomId); sql += ` WHERE id = $${params.length}`; }
    sql += ` ORDER BY name`;
    return (await db.query(sql, params)).rows;
  }
  if (scope === 'staff') {
    let sql = `SELECT s.id, s.first_name || ' ' || s.last_name AS name, s.room_id, s.role, r.name AS room_name
                 FROM staff s LEFT JOIN rooms r ON r.id = s.room_id WHERE s.is_active = true`;
    const params = [];
    if (roomId) { params.push(roomId); sql += ` AND s.room_id = $${params.length}`; }
    sql += ` ORDER BY s.first_name, s.last_name`;
    return (await db.query(sql, params)).rows;
  }
  // setting — one virtual subject
  return [{ id: 0, name: 'The setting' }];
}

// GET /api/duties/matrix?scope=child|room|staff|setting&room_id=&state=
router.get('/matrix', async (req, res) => {
  const db = getPool();
  const scope = ['child', 'room', 'staff', 'setting'].includes(req.query.scope) ? req.query.scope : null;
  const roomId = req.query.room_id ? Number(req.query.room_id) : null;
  const stateFilter = ['done', 'due_soon', 'overdue', 'not_applicable'].includes(req.query.state) ? req.query.state : null;
  try {
    const { rows: defs } = await db.query(
      `SELECT key, label, scope, cadence, grace_days, is_statutory, citation, owner_role, sort_order, notes
         FROM duty_definitions WHERE is_active = true ${scope ? 'AND scope = $1' : ''} ORDER BY sort_order`,
      scope ? [scope] : []);
    if (!defs.length) return res.json({ duties: [], subjects: [], cells: [] });

    const scopesNeeded = scope ? [scope] : [...new Set(defs.map(d => d.scope))];
    let subjects = [];
    for (const s of scopesNeeded) subjects = subjects.concat((await subjectLabels(db, s, roomId)).map(x => ({ ...x, _scope: s })));

    const dutyKeys = defs.map(d => d.key);
    const { rows: statusRows } = await db.query(
      `SELECT ds.duty_key, ds.subject_type, ds.subject_id, ds.state, ds.last_done_date, ds.next_due_date, ds.detail,
              st.first_name || ' ' || st.last_name AS last_done_by_name
         FROM duty_status ds LEFT JOIN staff st ON st.id = ds.last_done_by
        WHERE ds.duty_key = ANY($1::text[])`, [dutyKeys]);

    const bySubject = new Set(subjects.map(s => `${s._scope}:${s.id}`));
    let cells = statusRows.filter(r => bySubject.has(`${r.subject_type}:${r.subject_id}`));
    if (stateFilter) cells = cells.filter(c => c.state === stateFilter);

    res.json({ duties: defs, subjects, cells, computed_at: cells[0] ? cells[0].computed_at : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/duties/subject/:type/:id — every duty for one subject, with detail.
router.get('/subject/:type/:id', async (req, res) => {
  const db = getPool();
  const { type, id } = req.params;
  if (!['child', 'room', 'staff', 'setting'].includes(type)) return res.status(400).json({ error: 'bad scope' });
  try {
    const { rows } = await db.query(
      `SELECT dd.key, dd.label, dd.cadence, dd.grace_days, dd.is_statutory, dd.citation, dd.owner_role, dd.notes,
              ds.state, ds.last_done_date, ds.next_due_date, ds.detail,
              st.first_name || ' ' || st.last_name AS last_done_by_name
         FROM duty_definitions dd
         LEFT JOIN duty_status ds ON ds.duty_key = dd.key AND ds.subject_type = $1 AND ds.subject_id = $2
         LEFT JOIN staff st ON st.id = ds.last_done_by
        WHERE dd.scope = $1 AND dd.is_active = true ORDER BY dd.sort_order`,
      [type, Number(id)]);
    res.json({ subject_type: type, subject_id: Number(id), duties: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/duties/parent-chat — record a parent sit-down (b334 §3 new surface).
router.post('/parent-chat', async (req, res) => {
  const db = getPool();
  const { child_id, chat_date, topic, notes } = req.body || {};
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  try {
    const { rows: [row] } = await db.query(
      `INSERT INTO duty_parent_chats (child_id, staff_id, chat_date, topic, notes)
       VALUES ($1,$2,COALESCE($3,current_date),$4,$5) RETURNING *`,
      [child_id, req.user.id, chat_date || null, topic || null, notes || null]);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/duties/staff-meeting — RETIRED by b530 (2026-10-26).
//
// b334 built ladn.duty_staff_meetings as the whole-SETTING staff meeting, with
// this one manager-only write and NO read route at all — so a meeting recorded
// here could never be read back by anybody, and in fourteen months nobody
// recorded one (0 rows on prod and on wren_dev, 2026-10-26).
//
// Toby, 2026-10-26: "staff meetings are something that need to be organised and
// led by room leaders." b530 makes ladn.cpd_room_meetings THE meeting record —
// agenda, attendance with reasons, minutes, actions with owners and due dates,
// and a read confirmation — so keeping a second, write-only, manager-only
// minute box is exactly the duplicate Toby's one-place rule exists to stop.
//
// The table is KEPT (ABSOLUTE RULE 4 — nothing is dropped) and its duty is
// deactivated by the b530 migration. This answers 410 Gone naming where the
// record moved to, rather than disappearing: a caller that has not been updated
// is told, instead of silently succeeding into a table nobody reads.
router.post('/staff-meeting', requireRole('manager'), async (req, res) => {
  res.status(410).json({
    error: 'Staff meetings are recorded as ROOM meetings now, by the room leader.',
    moved_to: '/api/cpd-programme/room-meetings',
    page: '/room-meetings.html',
    why: 'b530 (2026-10-26) — one meeting record with an agenda, attendance, minutes, actions and a read confirmation, '
       + 'instead of a write-only minutes box nothing could read back.',
  });
});

// POST /api/duties/refresh — force an immediate recompute (manager only).
router.post('/refresh', requireRole('manager'), async (req, res) => {
  try {
    const summary = await refreshAll(getPool());
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Self-scheduled recompute, every 15 minutes ───────────────────────────────
// The brief: "cache a computed snapshot, refreshed by a job every 15 minutes —
// the matrix must not recompute on every page load." This mounts once per
// server process; touching cron/server-unified.js beyond the one require line
// isn't needed.
let _dutiesTimer = null;
function startDutiesRefreshLoop() {
  if (_dutiesTimer) return;
  const run = () => refreshAll(getPool()).then(
    (s) => console.log(`[duties] refreshed: ${s.computed} computed, ${s.failed} failed, ${s.duties} duties`),
    (e) => console.error('[duties] refresh failed:', e.message));
  setTimeout(run, 5000);
  _dutiesTimer = setInterval(run, 15 * 60 * 1000);
}
startDutiesRefreshLoop();

module.exports = router;
