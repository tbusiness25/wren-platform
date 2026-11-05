// Nursery events + parent RSVP. Admin/staff-facing (authed). Parent RSVP lives
// inline in server-unified.js under /welcome/events/* (CF-Access email scoped).
// Tables: events, event_rsvps.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const MGR_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher',
  // b405 (2026-10-06, staff feedback) — "staff" (e.g. room leaders like the office manager)
  // need to be able to post a nursery event from the EY tablet, not just
  // managers/admin/HT. room_leader is the minimal broadening: it's the one
  // senior-practitioner role already on the roster one level below
  // deputy_manager; plain practitioner is deliberately left out — event
  // creation emails every parent, so it stays with room-leader+ for now.
  'room_leader'];
function requireManager(req, res) {
  if (!MGR_ROLES.includes(req.user && req.user.role)) {
    res.status(403).json({ error: 'Manager or deputy only' }); return false;
  }
  return true;
}

// GET /api/events?scope=upcoming|past|all  — events with a compact RSVP tally
router.get('/', async (req, res) => {
  const scope = ['upcoming', 'past', 'all'].includes(req.query.scope) ? req.query.scope : 'upcoming';
  const where = scope === 'upcoming' ? 'e.event_date >= CURRENT_DATE'
              : scope === 'past'     ? 'e.event_date <  CURRENT_DATE' : 'TRUE';
  const order = scope === 'past' ? 'e.event_date DESC' : 'e.event_date ASC';
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT e.*, r.name AS room_name,
             COALESCE(SUM(CASE WHEN v.response='yes' THEN 1 ELSE 0 END),0)::int AS yes_count,
             COALESCE(SUM(CASE WHEN v.response='no'  THEN 1 ELSE 0 END),0)::int AS no_count,
             COALESCE(SUM(CASE WHEN v.response='yes' THEN v.headcount ELSE 0 END),0)::int AS total_heads
      FROM events e
      LEFT JOIN rooms r ON r.id::text = e.audience
      LEFT JOIN event_rsvps v ON v.event_id = e.id
      WHERE ${where}
      GROUP BY e.id, r.name
      ORDER BY ${order}
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/events/:id/rsvps — full RSVP list for one event (who's coming)
router.get('/:id/rsvps', async (req, res) => {
  try {
    const db = getPool();
    const evId = parseInt(req.params.id, 10);
    const ev = await db.query('SELECT * FROM events WHERE id=$1', [evId]);
    if (!ev.rows.length) return res.status(404).json({ error: 'Event not found' });
    const { rows } = await db.query(`
      SELECT v.*, c.first_name, c.last_name, rm.name AS room_name
      FROM event_rsvps v
      JOIN children c ON c.id = v.child_id
      LEFT JOIN rooms rm ON rm.id = c.room_id
      WHERE v.event_id=$1
      ORDER BY v.response, c.first_name
    `, [evId]);
    res.json({ event: ev.rows[0], rsvps: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/events — create (manager/deputy)
router.post('/', async (req, res) => {
  if (!requireManager(req, res)) return;
  const b = req.body || {};
  if (!b.title || !b.title.trim()) return res.status(400).json({ error: 'title required' });
  if (!b.event_date || !/^\d{4}-\d{2}-\d{2}$/.test(b.event_date)) return res.status(400).json({ error: 'event_date (YYYY-MM-DD) required' });
  try {
    const db = getPool();
    // b184: staff_ids = who is expected to be there. Assigned staff automatically
    // get 24h/1h in-app reminders (src/lib/event-reminders.js, swept by the
    // notification dispatcher) — nothing else to call here. ensureSchema is
    // memoized and idempotent; it matters on editions that never start the
    // dispatcher (the demos), where the column would otherwise not exist.
    const staffIds = [...new Set((Array.isArray(b.staff_ids) ? b.staff_ids : [])
      .map(n => parseInt(n, 10)).filter(Number.isInteger))];
    let hasStaffCol = false;
    try { hasStaffCol = await require('../lib/event-reminders').ensureSchema(db); } catch (_) {}

    // b518: Events & Calendar reads ladn.events by `layer`. An event created through
    // this older API carries the layer its audience already implied, so it shows up on
    // the right layer instead of nowhere. Nothing else about this route changed.
    const _layer = String(b.audience || 'all').toLowerCase() === 'staff' ? 'nursery' : 'parents';
    const cols = ['title', 'description', 'event_date', 'start_time', 'end_time', 'location',
                  'audience', 'layer', 'rsvp_required', 'capacity', 'is_published', 'created_by'];
    const vals = [b.title.trim(), b.description || null, b.event_date, b.start_time || null,
                  b.end_time || null, b.location || null, (b.audience || 'all').toString(), _layer,
                  b.rsvp_required !== false, b.capacity ? parseInt(b.capacity, 10) : null,
                  b.is_published !== false, req.user.id];
    if (hasStaffCol) { cols.push('staff_ids'); vals.push(staffIds.length ? staffIds : null); }

    const { rows } = await db.query(
      `INSERT INTO events (${cols.join(', ')})
       VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, vals);
    const ev = rows[0];
    // Notify parents of a newly-published, parent-visible event (2026-07-30) — mirrors the
    // calendar audience flag: 'all'/'parents' → every current child; a room id → that room.
    // b518: the same code now serves Events & Calendar, so it lives in one place
    // (src/lib/event-notify.js). Behaviour is unchanged.
    await require('../lib/event-notify').notifyParentsOfEvent(db, ev);
    res.status(201).json(ev);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/events/:id — update (manager/deputy)
router.put('/:id', async (req, res) => {
  if (!requireManager(req, res)) return;
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  const push = (col, val) => { sets.push(`${col}=$${i++}`); vals.push(val); };
  if ('title' in b) push('title', String(b.title || '').trim());
  if ('description' in b) push('description', b.description || null);
  if ('event_date' in b) push('event_date', b.event_date);
  if ('start_time' in b) push('start_time', b.start_time || null);
  if ('end_time' in b) push('end_time', b.end_time || null);
  if ('location' in b) push('location', b.location || null);
  if ('audience' in b) push('audience', (b.audience || 'all').toString());
  if ('rsvp_required' in b) push('rsvp_required', !!b.rsvp_required);
  if ('capacity' in b) push('capacity', b.capacity ? parseInt(b.capacity, 10) : null);
  if ('is_published' in b) push('is_published', !!b.is_published);
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  push('updated_at', new Date().toISOString());
  vals.push(parseInt(req.params.id, 10));
  try {
    const db = getPool();
    const { rows } = await db.query(`UPDATE events SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/events/:id — unpublish (soft; keeps RSVPs). Manager/deputy.
router.delete('/:id', async (req, res) => {
  if (!requireManager(req, res)) return;
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE events SET is_published=false, updated_at=now() WHERE id=$1 RETURNING id', [parseInt(req.params.id, 10)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
