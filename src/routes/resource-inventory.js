'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Resource inventory (2026-07-15, Toby) — toys & equipment per room.
// - resource_items:    the inventory (what, where, how many, condition, last replaced)
// - resource_requests: broken-toy reports / replacement / "need more" / new-item asks
// - activity_resources: links items to planned activities, curriculum activities
//   and events, so plans can say exactly what to get out.
//
// Tables live in whichever tenant schema the pool points at (ladn on prod,
// wren_dev on dev, demo_* on demos) — created lazily & idempotently on first
// use, same pattern as onboarding_invites. Additive-only.
// Distinct from ladn.resources (parent-facing articles) and learning_resources
// (uploaded files) — different tables, different jobs.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

let _ensured = null;
function ensureTables() {
  if (_ensured) return _ensured;
  _ensured = getPool().query(`
    CREATE TABLE IF NOT EXISTS resource_items (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      category      TEXT NOT NULL DEFAULT 'toy',      -- toy|equipment|furniture|book|consumable|outdoor|other
      room_id       INTEGER,                          -- NULL = shared / whole nursery
      quantity      INTEGER NOT NULL DEFAULT 1,
      condition     TEXT NOT NULL DEFAULT 'good',     -- good|worn|broken|retired
      last_replaced DATE,
      need_more     BOOLEAN NOT NULL DEFAULT false,
      supplier      TEXT,
      unit_cost     NUMERIC(10,2),
      eyfs_areas    TEXT,                             -- free text, e.g. "PSED, Physical"
      notes         TEXT,
      is_active     BOOLEAN NOT NULL DEFAULT true,
      created_by    INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS resource_requests (
      id            SERIAL PRIMARY KEY,
      resource_id   INTEGER,                          -- NULL = brand-new item request
      kind          TEXT NOT NULL,                    -- broken|replacement|more|new
      details       TEXT,
      room_id       INTEGER,
      reported_by   INTEGER,
      status        TEXT NOT NULL DEFAULT 'open',     -- open|ordered|done|rejected
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at   TIMESTAMPTZ,
      resolved_by   INTEGER,
      resolution_notes TEXT
    );
    CREATE TABLE IF NOT EXISTS activity_resources (
      id            SERIAL PRIMARY KEY,
      resource_id   INTEGER NOT NULL,
      target_type   TEXT NOT NULL,                    -- planned_activity|curriculum_activity|event
      target_id     INTEGER NOT NULL,
      quantity      INTEGER,
      created_by    INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (resource_id, target_type, target_id)
    );
  `).then(() => true).catch(e => { _ensured = null; throw e; });
  return _ensured;
}
router.use((req, res, next) => { ensureTables().then(() => next()).catch(next); });

const CATEGORIES  = ['toy', 'equipment', 'furniture', 'book', 'consumable', 'outdoor', 'other'];
const CONDITIONS  = ['good', 'worn', 'broken', 'retired'];
const REQ_KINDS   = ['broken', 'replacement', 'more', 'new'];
const REQ_STATUS  = ['open', 'ordered', 'done', 'rejected'];
const LINK_TYPES  = ['planned_activity', 'curriculum_activity', 'event'];

const isManager = req => ['manager', 'deputy_manager', 'admin'].includes(req.user && req.user.role);

// ── Items ─────────────────────────────────────────────────────────────────────

// GET /api/resource-inventory?room_id=&category=&condition=&need_more=1&q=&include_retired=1
router.get('/', async (req, res) => {
  try {
    const where = ['1=1']; const args = [];
    if (!req.query.include_retired) where.push(`ri.is_active AND ri.condition != 'retired'`);
    if (req.query.room_id === 'shared') where.push('ri.room_id IS NULL');
    else if (req.query.room_id) { args.push(req.query.room_id); where.push(`ri.room_id = $${args.length}`); }
    if (req.query.category)  { args.push(req.query.category);  where.push(`ri.category = $${args.length}`); }
    if (req.query.condition) { args.push(req.query.condition); where.push(`ri.condition = $${args.length}`); }
    if (req.query.need_more) where.push('ri.need_more');
    if (req.query.q) { args.push('%' + req.query.q + '%'); where.push(`(ri.name ILIKE $${args.length} OR ri.notes ILIKE $${args.length})`); }
    const { rows } = await getPool().query(`
      SELECT ri.*, r.name AS room_name,
        (SELECT count(*)::int FROM resource_requests rq WHERE rq.resource_id = ri.id AND rq.status = 'open') AS open_requests
      FROM resource_items ri
      LEFT JOIN rooms r ON r.id = ri.room_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.name NULLS LAST, ri.category, ri.name`, args);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Summary for dashboards: counts by room + open requests
router.get('/summary', async (req, res) => {
  try {
    const { rows: [s] } = await getPool().query(`
      SELECT
        (SELECT count(*)::int FROM resource_items WHERE is_active AND condition != 'retired') AS items,
        (SELECT count(*)::int FROM resource_items WHERE is_active AND condition = 'broken')   AS broken,
        (SELECT count(*)::int FROM resource_items WHERE is_active AND need_more)              AS need_more,
        (SELECT count(*)::int FROM resource_requests WHERE status = 'open')                   AS open_requests`);
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/resource-inventory — any staff can add an item
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name required' });
    const category = CATEGORIES.includes(b.category) ? b.category : 'toy';
    const condition = CONDITIONS.includes(b.condition) ? b.condition : 'good';
    const { rows: [row] } = await getPool().query(`
      INSERT INTO resource_items (name, category, room_id, quantity, condition, last_replaced,
                                  need_more, supplier, unit_cost, eyfs_areas, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [String(b.name).trim(), category, b.room_id || null,
       Math.max(0, parseInt(b.quantity, 10) || 1), condition, b.last_replaced || null,
       !!b.need_more, b.supplier || null, b.unit_cost || null,
       b.eyfs_areas || null, b.notes || null, req.user.id]);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/resource-inventory/:id — edit (any staff; delete/retire is manager-only below)
router.put('/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = []; const args = [];
    const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
    if (b.name !== undefined) set('name', String(b.name).trim());
    if (b.category !== undefined && CATEGORIES.includes(b.category)) set('category', b.category);
    if (b.room_id !== undefined) set('room_id', b.room_id || null);
    if (b.quantity !== undefined) set('quantity', Math.max(0, parseInt(b.quantity, 10) || 0));
    if (b.condition !== undefined && CONDITIONS.includes(b.condition)) set('condition', b.condition);
    if (b.last_replaced !== undefined) set('last_replaced', b.last_replaced || null);
    if (b.need_more !== undefined) set('need_more', !!b.need_more);
    if (b.supplier !== undefined) set('supplier', b.supplier || null);
    if (b.unit_cost !== undefined) set('unit_cost', b.unit_cost || null);
    if (b.eyfs_areas !== undefined) set('eyfs_areas', b.eyfs_areas || null);
    if (b.notes !== undefined) set('notes', b.notes || null);
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    sets.push('updated_at = now()');
    args.push(req.params.id);
    const { rows: [row] } = await getPool().query(
      `UPDATE resource_items SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`, args);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/replaced — quick action: mark replaced today (resets condition + need_more)
router.post('/:id/replaced', async (req, res) => {
  try {
    const { rows: [row] } = await getPool().query(`
      UPDATE resource_items
      SET last_replaced = CURRENT_DATE, condition = 'good', need_more = false, updated_at = now()
      WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    // close any open broken/replacement requests for it
    await getPool().query(`
      UPDATE resource_requests SET status = 'done', resolved_at = now(), resolved_by = $2,
        resolution_notes = COALESCE(resolution_notes, 'Replaced')
      WHERE resource_id = $1 AND status IN ('open','ordered')`, [req.params.id, req.user.id]);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE — manager-only, soft (is_active=false) so history survives
router.delete('/:id', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const { rows: [row] } = await getPool().query(
      `UPDATE resource_items SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id`,
      [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Requests (broken toys, replacements, need-more, new items) ───────────────

// GET /requests?status=open&room_id=
router.get('/requests', async (req, res) => {
  try {
    const where = ['1=1']; const args = [];
    if (req.query.status && REQ_STATUS.includes(req.query.status)) { args.push(req.query.status); where.push(`rq.status = $${args.length}`); }
    if (req.query.room_id) { args.push(req.query.room_id); where.push(`rq.room_id = $${args.length}`); }
    const { rows } = await getPool().query(`
      SELECT rq.*, ri.name AS resource_name, ri.category AS resource_category,
             r.name AS room_name,
             s.first_name || ' ' || s.last_name AS reported_by_name,
             sr.first_name || ' ' || sr.last_name AS resolved_by_name
      FROM resource_requests rq
      LEFT JOIN resource_items ri ON ri.id = rq.resource_id
      LEFT JOIN rooms r ON r.id = rq.room_id
      LEFT JOIN staff s ON s.id = rq.reported_by
      LEFT JOIN staff sr ON sr.id = rq.resolved_by
      WHERE ${where.join(' AND ')}
      ORDER BY (rq.status = 'open') DESC, rq.created_at DESC
      LIMIT 200`, args);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /requests — any staff. Broken reports also flag the item itself.
router.post('/requests', async (req, res) => {
  try {
    const b = req.body || {};
    if (!REQ_KINDS.includes(b.kind)) return res.status(400).json({ error: 'kind must be one of ' + REQ_KINDS.join('/') });
    if (!b.resource_id && !(b.details && String(b.details).trim()))
      return res.status(400).json({ error: 'details required when no resource is selected' });
    const { rows: [row] } = await getPool().query(`
      INSERT INTO resource_requests (resource_id, kind, details, room_id, reported_by)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.resource_id || null, b.kind, (b.details || '').trim() || null, b.room_id || null, req.user.id]);
    if (b.resource_id && b.kind === 'broken') {
      await getPool().query(
        `UPDATE resource_items SET condition = 'broken', updated_at = now() WHERE id = $1`, [b.resource_id]);
    }
    if (b.resource_id && b.kind === 'more') {
      await getPool().query(
        `UPDATE resource_items SET need_more = true, updated_at = now() WHERE id = $1`, [b.resource_id]);
    }
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /requests/:id — manager updates status / resolution
router.put('/requests/:id', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const b = req.body || {};
    if (!REQ_STATUS.includes(b.status)) return res.status(400).json({ error: 'status must be one of ' + REQ_STATUS.join('/') });
    const done = ['done', 'rejected'].includes(b.status);
    const { rows: [row] } = await getPool().query(`
      UPDATE resource_requests
      SET status = $2, resolution_notes = COALESCE($3, resolution_notes),
          resolved_at = CASE WHEN $4 THEN now() ELSE NULL END,
          resolved_by = CASE WHEN $4 THEN $5 ELSE NULL END
      WHERE id = $1 RETURNING *`,
      [req.params.id, b.status, b.resolution_notes || null, done, req.user.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Activity / event links ────────────────────────────────────────────────────

// GET /links/:type/:id — resources attached to a planned activity / curriculum activity / event
router.get('/links/:type/:id', async (req, res) => {
  if (!LINK_TYPES.includes(req.params.type)) return res.status(400).json({ error: 'bad type' });
  try {
    const { rows } = await getPool().query(`
      SELECT ar.id AS link_id, ar.quantity AS link_quantity, ri.*
      FROM activity_resources ar
      JOIN resource_items ri ON ri.id = ar.resource_id
      WHERE ar.target_type = $1 AND ar.target_id = $2
      ORDER BY ri.name`, [req.params.type, req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /links {resource_id, target_type, target_id, quantity?}
router.post('/links', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.resource_id || !b.target_id || !LINK_TYPES.includes(b.target_type))
      return res.status(400).json({ error: 'resource_id, target_type, target_id required' });
    const { rows: [row] } = await getPool().query(`
      INSERT INTO activity_resources (resource_id, target_type, target_id, quantity, created_by)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (resource_id, target_type, target_id) DO UPDATE SET quantity = EXCLUDED.quantity
      RETURNING *`,
      [b.resource_id, b.target_type, b.target_id, b.quantity || null, req.user.id]);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/links/:linkId', async (req, res) => {
  try {
    await getPool().query(`DELETE FROM activity_resources WHERE id = $1`, [req.params.linkId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
