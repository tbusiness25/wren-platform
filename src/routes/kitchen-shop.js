'use strict';
/**
 * src/routes/kitchen-shop.js — b540 (2026-11-02)
 *
 * the chef's Sainsbury's list + her kitchen training progress.
 *
 * Mounted INSIDE src/routes/kitchen.js as router.use('/shop', …), after that
 * router's authenticate + kitchen-access gate, so every path here is
 * /api/kitchen/shop/* and is already limited to the cook/chef role or the
 * 'kitchen.access' capability (managers pass). The cook/chef allow-list in
 * server-unified.js admits the 'kitchen' prefix, so no change was needed there.
 *
 * Counts only: the list is built from menu text and the NUMBER of children
 * expected each day. No child name, allergy or diary row is read or returned.
 *
 *   GET    /list?week=YYYY-MM-DD   the list (week = a Monday; default: this order's week)
 *   GET    /list.txt?week=         the same, as plain text (Copy / share)
 *   POST   /tick                   { week, key, field:'have'|'in_basket', value }
 *   POST   /extra                  { week, name, qty?, aisle? }
 *   DELETE /extra/:id
 *   POST   /choice                 { key, name, text }  "my usual" (pasted link or search words)
 *   GET    /rules                  manager: portion rules
 *   PATCH  /rules/:id              manager: change per-child amount / pack size / on-off
 *   GET    /training               my own training progress
 *   POST   /training               { course, step, done, checklist }
 *   GET    /training/all           manager: everyone's kitchen-training progress
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const { hasRole } = require('../middleware/auth');
const K = require('../lib/kitchen-simple');
const SHOP = require('../lib/kitchen-shop');

router.use(express.json({ limit: '32kb' }));
router.use(async (req, res, next) => {
  try { await SHOP.ensureSchema(getPool()); next(); }
  catch (e) { console.error('[kitchen-shop] schema:', e.message); res.status(500).json({ error: 'The shopping tables are not ready.' }); }
});

const isManager = u => hasRole(u, ['manager', 'deputy_manager', 'admin']);
function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    const status = e.status || 500;
    if (status >= 500) console.error('[kitchen-shop]', req.method, req.path, e.message);
    res.status(status).json({ error: e.message });
  });
}
function weekOf(q) {
  const w = String(q || '').trim();
  if (K.validDate(w)) return K.mondayStr(w);
  return SHOP.defaultWeek(K.londonNow().date);
}

router.get('/list', wrap(async (req, res) => {
  const week = weekOf(req.query.week);
  const list = await SHOP.buildList(getPool(), week);
  const thisMon = K.mondayStr(K.londonNow().date);
  res.json(Object.assign(list, {
    this_week: thisMon, next_week: K.addDays(thisMon, 7), default_week: SHOP.defaultWeek(K.londonNow().date),
    text: SHOP.listText(list), can_edit_rules: isManager(req.user),
  }));
}));

router.get('/list.txt', wrap(async (req, res) => {
  const list = await SHOP.buildList(getPool(), weekOf(req.query.week));
  res.type('text/plain').send(SHOP.listText(list));
}));

router.post('/tick', wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await SHOP.setState(getPool(), { week: weekOf(b.week), key: b.key, field: b.field, value: b.value, user: req.user }));
}));

router.post('/extra', wrap(async (req, res) => {
  const b = req.body || {};
  res.status(201).json(await SHOP.addExtra(getPool(), { week: weekOf(b.week), name: b.name, qty: b.qty, aisle: b.aisle, user: req.user }));
}));

router.delete('/extra/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  res.json(await SHOP.removeExtra(getPool(), { id }));
}));

router.post('/choice', wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await SHOP.saveChoice(getPool(), { key: b.key, name: b.name, text: b.text, user: req.user }));
}));

router.get('/rules', wrap(async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  res.json({ rules: await SHOP.listRules(getPool()), aisles: SHOP.AISLES });
}));

router.patch('/rules/:id', wrap(async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  res.json(await SHOP.updateRule(getPool(), { id, body: req.body || {}, user: req.user }));
}));

// ── training progress (the kitchen course on /ey/kitchen-training) ──────────
const COURSES = new Set(['kitchen-basics']);
router.get('/training', wrap(async (req, res) => {
  const { rows } = await getPool().query(
    'SELECT course, step_reached, checklist, completed_at, updated_at FROM kitchen_training_progress WHERE staff_id = $1',
    [req.user.id]);
  res.json({ progress: rows });
}));

router.post('/training', wrap(async (req, res) => {
  const b = req.body || {};
  const course = String(b.course || 'kitchen-basics');
  if (!COURSES.has(course)) return res.status(400).json({ error: 'unknown course' });
  const step = Math.max(0, Math.min(200, parseInt(b.step, 10) || 0));
  const checklist = b.checklist && typeof b.checklist === 'object' ? JSON.stringify(b.checklist).slice(0, 4000) : null;
  const { rows } = await getPool().query(`
    INSERT INTO kitchen_training_progress (staff_id, course, step_reached, checklist, completed_at, updated_at)
    VALUES ($1, $2, $3, $4::jsonb, CASE WHEN $5 THEN now() END, now())
    ON CONFLICT (staff_id, course) DO UPDATE SET
      step_reached = GREATEST(kitchen_training_progress.step_reached, EXCLUDED.step_reached),
      checklist    = COALESCE(EXCLUDED.checklist, kitchen_training_progress.checklist),
      completed_at = COALESCE(kitchen_training_progress.completed_at, EXCLUDED.completed_at),
      updated_at   = now()
    RETURNING course, step_reached, completed_at`, [req.user.id, course, step, checklist, !!b.done]);
  res.json(rows[0]);
}));

router.get('/training/all', wrap(async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const { rows } = await getPool().query(`
    SELECT p.staff_id, s.first_name, p.course, p.step_reached, p.completed_at, p.updated_at
      FROM kitchen_training_progress p LEFT JOIN staff s ON s.id = p.staff_id ORDER BY p.updated_at DESC`);
  res.json({ progress: rows });
}));

module.exports = router;
