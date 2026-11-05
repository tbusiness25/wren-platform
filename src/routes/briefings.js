'use strict';
// b503 — management briefings. /api/briefings
//   GET  /                the archive for the caller's own briefing (managers: whole setting; deputy: whole setting minus money; room leader: their room)
//   GET  /:id             one briefing. On the HR portal the child-data sections are removed SERVER-SIDE (child data never goes on HR).
//   POST /generate        {period, as_of?} build + store the caller's briefing now (no notification)
//   POST /send-now        {period}  "Send me this week's now": build + store + an in-app notification to the CALLER only (counts only)
//   GET|PATCH /settings   a toggle per period (managers)
// Never messages a parent. Parent tokens are refused outright.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const B = require('../lib/briefings');
const D = require('../lib/briefing-delivery');
const { notifyAsync } = require('../services/notification-dispatcher');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);
router.use((req, res, next) => {
  if (req._portal === 'parents' || (req.user && req.user.role === 'parent')) return res.status(403).json({ error: 'Forbidden' });
  next();
});
const MGR = ['manager', 'admin', 'deputy_manager', 'headteacher'];

async function who(db, req) {
  const { rows: [s] } = await db.query(`SELECT id, role, room_id FROM staff WHERE id=$1 AND is_active = true`, [Number(req.user.id)]);
  // The token's role is what the portals trust; the room comes from the record so a room leader cannot name another room.
  const staff = s ? { id: s.id, role: req.user.role || s.role, room_id: s.room_id } : null;
  return staff;
}
async function scopeFor(db, req) {
  const s = await who(db, req); if (!s) return null;
  const scope = B.scopeForStaff(s); if (!scope) return null;
  return { staff: s, scope, key: B.scopeKeyOf(scope) };
}
const PERIODS = ['week', 'month', 'term'];

router.get('/settings', async (req, res) => {
  if (!hasRole(req.user, ['manager', 'admin', 'headteacher'])) return res.status(403).json({ error: 'Manager access required' });
  const { rows } = await getPool().query(`SELECT key, value FROM settings WHERE key IN ('briefing_week_enabled','briefing_month_enabled','briefing_term_enabled')`);
  const o = {}; rows.forEach(r => { o[r.key] = r.value === 'true'; });
  res.json({ week: !!o.briefing_week_enabled, month: !!o.briefing_month_enabled, term: !!o.briefing_term_enabled });
});
router.patch('/settings', async (req, res) => {
  if (!hasRole(req.user, ['manager', 'admin', 'headteacher'])) return res.status(403).json({ error: 'Manager access required' });
  const db = getPool();
  for (const p of PERIODS) if (req.body && typeof req.body[p] === 'boolean')
    await db.query(`INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=now()`, [`briefing_${p}_enabled`, String(req.body[p]), Number(req.user.id)]);
  const { rows } = await db.query(`SELECT key, value FROM settings WHERE key IN ('briefing_week_enabled','briefing_month_enabled','briefing_term_enabled')`);
  const o = {}; rows.forEach(r => { o[r.key] = r.value === 'true'; });
  res.json({ week: !!o.briefing_week_enabled, month: !!o.briefing_month_enabled, term: !!o.briefing_term_enabled });
});

router.get('/', async (req, res) => {
  const db = getPool();
  try {
    const sc = await scopeFor(db, req);
    if (!sc) return res.status(403).json({ error: 'Briefings are for managers, the deputy and room leaders.' });
    const period = PERIODS.includes(String(req.query.period)) ? String(req.query.period) : null;
    const { rows } = await db.query(`SELECT id, period, as_of::text AS as_of, created_at, json->>'title' AS title, json->'counts' AS counts FROM briefings WHERE scope_key=$1 ${period ? 'AND period=$2' : ''} ORDER BY as_of DESC, id DESC LIMIT 60`, period ? [sc.key, period] : [sc.key]);
    res.json({ scope: sc.key, briefings: rows });
  } catch (e) { console.error('[briefings] list:', e.message); res.status(500).json({ error: 'DB error' }); }
});

router.post('/generate', async (req, res) => {
  const db = getPool();
  try {
    const sc = await scopeFor(db, req);
    if (!sc) return res.status(403).json({ error: 'Briefings are for managers, the deputy and room leaders.' });
    const period = String((req.body && req.body.period) || 'week');
    if (!PERIODS.includes(period)) return res.status(400).json({ error: 'period must be week, month or term' });
    const b = await B.build(db, period, sc.scope, req.body && req.body.as_of);
    const saved = await B.save(db, b);
    res.status(201).json({ id: saved.id, briefing: req._portal === 'hr' ? B.forHr(b) : b });
  } catch (e) { console.error('[briefings] generate:', e.message); res.status(500).json({ error: 'DB error' }); }
});

router.post('/send-now', async (req, res) => {
  const db = getPool();
  try {
    const sc = await scopeFor(db, req);
    if (!sc) return res.status(403).json({ error: 'Briefings are for managers, the deputy and room leaders.' });
    const period = String((req.body && req.body.period) || 'week');
    if (!PERIODS.includes(period)) return res.status(400).json({ error: 'period must be week, month or term' });
    const b = await B.build(db, period, sc.scope);
    const saved = await B.save(db, b);
    const t = D.notificationText(b);
    // To the person who asked, and only them. Counts only; the briefing itself is read in Wren.
    await notifyAsync('briefing_ready', 'staff', sc.staff.id, t.title, t.body, { relatedTable: 'briefings', relatedId: saved.id, link: `/briefing-link?id=${saved.id}`, priority: 'normal' });
    res.status(201).json({ id: saved.id, notified: true, text: t });
  } catch (e) { console.error('[briefings] send-now:', e.message); res.status(500).json({ error: 'DB error' }); }
});

router.get('/:id', async (req, res) => {
  const db = getPool();
  try {
    const id = parseInt(req.params.id, 10); if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const sc = await scopeFor(db, req);
    if (!sc) return res.status(403).json({ error: 'Briefings are for managers, the deputy and room leaders.' });
    const { rows: [r] } = await db.query(`SELECT id, scope_key, json, created_at FROM briefings WHERE id=$1`, [id]);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (r.scope_key !== sc.key) return res.status(403).json({ error: 'That briefing is not yours.' });
    res.json({ id: r.id, created_at: r.created_at, briefing: req._portal === 'hr' ? B.forHr(r.json) : r.json });
  } catch (e) { console.error('[briefings] get:', e.message); res.status(500).json({ error: 'DB error' }); }
});

module.exports = router;
