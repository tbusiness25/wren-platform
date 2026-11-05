'use strict';
// b502 — Outstanding details. Staff-facing routes over src/lib/outstanding.js (the one engine).
//   GET  /api/outstanding/children       who is missing what (Roost → Children → Missing details). ?room_id= ?type= ?who=parent|us ?format=csv
//   GET  /api/outstanding/staff          staff gaps (managers)
//   GET  /api/outstanding/summary        counts (managers)
//   GET  /api/outstanding/checklist      this week's checklist for the caller's scope
//   GET/POST/PATCH /api/outstanding/campaigns[/:id]  reminder campaigns; /:id/preview, /start, /pause, /resume, /stop (managers; Start needs {confirm:true})
//   POST /api/outstanding/tasks/sync     {apply:false} previews, {apply:true,confirm:true} creates/refreshes/closes the accountable tasks
//   POST /api/outstanding/tasks/weekly   same for the Monday checklists
//   /nudge…, /inbox-search                the funding-week nudge and the inbox search (parentdetails-20261023, see the bottom of this file)
// Child data never goes to the HR portal (HR is an allow-list and this segment is NOT on it) and parents are refused outright.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const OUT = require('../lib/outstanding');
const CAMP = require('../lib/detail-campaigns');
const OT = require('../lib/outstanding-tasks');

router.use(authenticate);
router.use((req, res, next) => {
  if (req._portal === 'parents' || (req.user && req.user.role === 'parent')) return res.status(403).json({ error: 'Forbidden' });
  next();
});
const MGR = ['manager', 'deputy_manager', 'admin'];
const isMgr = req => MGR.includes(req.user && req.user.role);
const mgrOnly = (req, res, next) => (isMgr(req) ? next() : res.status(403).json({ error: 'Manager access required' }));

async function myRoom(db, req) {
  const { rows: [s] } = await db.query(`SELECT room_id FROM staff WHERE id=$1`, [Number(req.user.id)]);
  return s && s.room_id ? Number(s.room_id) : null;
}
const csvq = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const ago = d => (d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000)) : null);

router.get('/children', async (req, res) => {
  const db = getPool();
  try {
    let roomId = req.query.room_id ? parseInt(req.query.room_id, 10) : null;
    if (!isMgr(req)) {
      if (req.user.role !== 'room_leader') return res.status(403).json({ error: 'Manager or room leader access required' });
      roomId = await myRoom(db, req);                              // a room leader sees their own room, whatever they ask for
      if (!roomId) return res.json({ counts: { children: 0, items: 0, parent_to_do: 0, us_to_do: 0 }, children: [], rooms: [], types: Object.keys(OUT.TYPE_GROUPS) });
    }
    const who = ['parent', 'us'].includes(String(req.query.who)) ? String(req.query.who) : null;
    const type = req.query.type ? String(req.query.type) : null;
    const codes = type ? (OUT.TYPE_GROUPS[type] || (OUT.CODES[type] ? [type] : null)) : null;
    if (type && !codes) return res.status(400).json({ error: 'unknown type', types: Object.keys(OUT.TYPE_GROUPS) });
    const scoped = await OUT.forChildren(db, { roomId, includeComplete: true });
    await OUT.touch(db, 'child', scoped.filter(c => c.items.length), scoped.map(c => c.child_id));
    const kids = await OUT.forChildren(db, { roomId, codes: codes || undefined, who: who || undefined });
    const rows = kids.map(k => ({ ...k, items: k.items.map(i => ({ ...i, days: ago(i.since) })) }));
    const counts = rows.reduce((a, k) => { a.children++; for (const i of k.items) { a.items++; if (i.who === 'parent') a.parent_to_do++; else a.us_to_do++; } return a; }, { children: 0, items: 0, parent_to_do: 0, us_to_do: 0 });
    if (String(req.query.format) === 'csv') {
      const lines = [['Child ID', 'Name', 'Room', 'Missing', 'Who must supply', 'Outstanding since', 'Days', 'Reminders sent', 'Last reminded'].join(',')];
      for (const k of rows) for (const i of k.items) lines.push([k.child_id, k.name, k.room_name || '', i.label, i.who === 'parent' ? 'Parent' : 'Us', i.since ? new Date(i.since).toISOString().slice(0, 10) : '', i.days == null ? '' : i.days, k.reminders_sent, k.last_reminded ? new Date(k.last_reminded).toISOString().slice(0, 10) : ''].map(csvq).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="missing-details-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(lines.join('\n'));
    }
    const { rows: rooms } = await db.query(`SELECT id, name FROM rooms ORDER BY name`);
    res.json({ counts, children: rows, rooms: isMgr(req) ? rooms : rooms.filter(r => Number(r.id) === roomId), types: Object.keys(OUT.TYPE_GROUPS), codes: OUT.CODES });
  } catch (e) { console.error('[outstanding] children:', e.message); res.status(500).json({ error: 'DB error' }); }
});

router.get('/staff', mgrOnly, async (req, res) => {
  try {
    const staff = await OUT.forStaff(getPool());
    await OUT.touch(getPool(), 'staff', staff);
    res.json({ count: staff.length, staff, link: '/staff-records.html' });
  } catch (e) { console.error('[outstanding] staff:', e.message); res.status(500).json({ error: 'DB error' }); }
});

router.get('/summary', mgrOnly, async (req, res) => {
  try { res.json(await OUT.summary(getPool(), {})); }
  catch (e) { res.status(500).json({ error: 'DB error' }); }
});

router.get('/checklist', async (req, res) => {
  const db = getPool();
  try {
    let scope = {};
    if (!isMgr(req)) {
      if (req.user.role !== 'room_leader') return res.status(403).json({ error: 'Manager or room leader access required' });
      scope = { room_id: await myRoom(db, req) };
    }
    res.json(await OUT.checklist(db, scope));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ── campaigns ────────────────────────────────────────────────────────────────
router.get('/campaigns', mgrOnly, async (req, res) => {
  try { res.json({ campaigns: await CAMP.list(getPool()), parent_codes: Object.keys(OUT.CODES).filter(c => OUT.CODES[c].who === 'parent').map(c => ({ code: c, label: OUT.CODES[c].label })) }); }
  catch (e) { console.error('[outstanding] campaigns:', e.message); res.status(500).json({ error: 'DB error' }); }
});
router.post('/campaigns', mgrOnly, async (req, res) => {
  try { const r = await CAMP.create(getPool(), req.user, req.body); res.status(r.status).json(r.campaign ? r.campaign : r); }
  catch (e) { console.error('[outstanding] create:', e.message); res.status(500).json({ error: 'DB error' }); }
});
router.get('/campaigns/:id', mgrOnly, async (req, res) => {
  try { const d = await CAMP.detail(getPool(), parseInt(req.params.id, 10)); d ? res.json(d) : res.status(404).json({ error: 'Not found' }); }
  catch (e) { res.status(500).json({ error: 'DB error' }); }
});
router.patch('/campaigns/:id', mgrOnly, async (req, res) => {
  try { const r = await CAMP.update(getPool(), parseInt(req.params.id, 10), req.body); res.status(r.status).json(r.campaign ? r.campaign : r); }
  catch (e) { res.status(500).json({ error: 'DB error' }); }
});
router.get('/campaigns/:id/preview', mgrOnly, async (req, res) => {
  try { const p = await CAMP.preview(getPool(), parseInt(req.params.id, 10)); p ? res.json(p) : res.status(404).json({ error: 'Not found' }); }
  catch (e) { res.status(500).json({ error: 'DB error' }); }
});
router.post('/campaigns/:id/start', mgrOnly, async (req, res) => {
  // One press of Start is the human authorisation for the campaign's repeats: it must say so ({confirm:true}) after the preview.
  if (!(req.body && req.body.confirm === true)) return res.status(400).json({ error: 'confirm_required', message: 'Starting a campaign needs confirm:true, after the preview has been read.' });
  try { const r = await CAMP.launch(getPool(), req.user, parseInt(req.params.id, 10)); res.status(r.status).json(r.campaign ? { ...r.campaign, targets: r.targets } : r); }
  catch (e) { console.error('[outstanding] start:', e.message); res.status(500).json({ error: 'DB error' }); }
});
router.post('/campaigns/:id/pause', mgrOnly, async (req, res) => {
  try { const r = await CAMP.pause(getPool(), parseInt(req.params.id, 10)); r ? res.json(r) : res.status(409).json({ error: 'Only a running campaign can be paused' }); }
  catch (e) { res.status(500).json({ error: 'DB error' }); }
});
router.post('/campaigns/:id/resume', mgrOnly, async (req, res) => {
  try { const r = await CAMP.resume(getPool(), parseInt(req.params.id, 10)); res.status(r.status).json(r.campaign ? r.campaign : r); }
  catch (e) { res.status(500).json({ error: 'DB error' }); }
});
router.post('/campaigns/:id/stop', mgrOnly, async (req, res) => {
  try { const r = await CAMP.stop(getPool(), parseInt(req.params.id, 10)); r ? res.json(r) : res.status(409).json({ error: 'Already ended or stopped' }); }
  catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ── accountable tasks from the engine ────────────────────────────────────────
router.post('/tasks/sync', mgrOnly, async (req, res) => {
  const apply = req.body && req.body.apply === true;
  if (apply && req.body.confirm !== true) return res.status(400).json({ error: 'confirm_required' });
  try { res.json(await OT.sync(getPool(), { dryRun: !apply, actor: req.user })); }
  catch (e) { console.error('[outstanding] sync:', e.message); res.status(500).json({ error: 'DB error' }); }
});
router.post('/tasks/weekly', mgrOnly, async (req, res) => {
  const apply = req.body && req.body.apply === true;
  if (apply && req.body.confirm !== true) return res.status(400).json({ error: 'confirm_required' });
  try { res.json(await OT.weeklyChecklists(getPool(), { dryRun: !apply, actor: req.user })); }
  catch (e) { console.error('[outstanding] weekly:', e.message); res.status(500).json({ error: 'DB error' }); }
});

// ── parentdetails-20261023: the "funding week is coming" nudge + inbox search ──────────────────────────────────────────────
//   GET  /api/outstanding/nudge                    switches, the next claim window, and the last 50 log lines (managers)
//   GET  /api/outstanding/nudge/preview            exactly who would be messaged now, with what, and who is skipped and why
//   POST /api/outstanding/nudge/settings           {enabled?, dry_run?, inbox_search_enabled?, lead_days?, every_days?, max_per_day?,
//                                                   max_per_week?, codes?, manager_name?} — turning anything ON needs {confirm:true}
//   GET  /api/outstanding/nudge/child/:childId     the exact message a Nudge press would send this child's family
//   POST /api/outstanding/nudge/child/:childId     {confirm:true} sends it (bell + opted-in push, never email; caps still apply)
//   POST /api/outstanding/inbox-search             {child_id, code} → a proposal from the family's own emails (local model only)
const NUDGE = require('../lib/detail-nudge');
const notifyAsync = (...a) => require('../services/notification-dispatcher').notifyAsync(...a);

router.get('/nudge', mgrOnly, async (req, res) => {
  try {
    const db = getPool();
    const s = await NUDGE.settings(db);
    const p = await NUDGE.plan(db);
    res.json({ settings: s, window: p.window, due_now: p.due, families_with_gaps: p.families.length, log: await NUDGE.log(db, 50) });
  } catch (e) { console.error('[outstanding] nudge:', e.message); res.status(500).json({ error: 'DB error' }); }
});
router.get('/nudge/preview', mgrOnly, async (req, res) => {
  try { res.json(await NUDGE.preview(getPool())); }
  catch (e) { console.error('[outstanding] nudge preview:', e.message); res.status(500).json({ error: 'DB error' }); }
});
router.post('/nudge/settings', mgrOnly, async (req, res) => {
  try { const r = await NUDGE.setSettings(getPool(), req.user, req.body); res.status(r.status).json(r); }
  catch (e) { console.error('[outstanding] nudge settings:', e.message); res.status(500).json({ error: 'DB error' }); }
});
router.get('/nudge/child/:childId', mgrOnly, async (req, res) => {
  try { const r = await NUDGE.manual(getPool(), notifyAsync, req.user, parseInt(req.params.childId, 10), { confirm: false }); res.status(r.status).json(r); }
  catch (e) { console.error('[outstanding] nudge child preview:', e.message); res.status(500).json({ error: 'DB error' }); }
});
router.post('/nudge/child/:childId', mgrOnly, async (req, res) => {
  if (!(req.body && req.body.confirm === true)) return res.status(400).json({ error: 'confirm_required', message: 'A nudge needs confirm:true, after the message has been read.' });
  try { const r = await NUDGE.manual(getPool(), notifyAsync, req.user, parseInt(req.params.childId, 10), { confirm: true }); res.status(r.status).json(r); }
  catch (e) { console.error('[outstanding] nudge child:', e.message); res.status(500).json({ error: 'DB error' }); }
});
router.post('/inbox-search', mgrOnly, async (req, res) => {
  const b = req.body || {};
  try {
    const r = await require('../lib/detail-inbox-search').search(getPool(), { childId: b.child_id, code: String(b.code || ''), actor: { id: req.user.id, ip: req.ip } });
    res.status(r.status).json(r);
  } catch (e) { console.error('[outstanding] inbox search:', e.message); res.status(500).json({ error: 'Search failed' }); }
});

module.exports = router;
