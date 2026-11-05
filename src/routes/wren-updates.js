'use strict';
// wren-updates.js — What's new in Wren (2026-09-17)
//
// Toby: "just create a separate page on Wren for updates and latest bits …
// so they're filled in as much as possible with what we've been doing".
//
// How Wren itself has changed, written for the people who run the nursery.
// Not "Tell the staff" (src/routes/staff-notices.js): that list is what the
// room teams need told and it drafts the staff newsletter. Manager-only, no
// send path here, nothing parent-facing.

const express = require('express');
const router  = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { renderUpdate } = require('../lib/wren-update-render');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

const MGR_ROLES = ['manager', 'deputy_manager', 'admin'];
const managerOnly = (req, res, next) => {
  if (!req.user || !(hasRole(req.user, MGR_ROLES) || Number(req.user.id) === 1))
    return res.status(403).json({ error: 'Manager only' });
  next();
};

const clean = (v, max) => {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
};

router.use(authenticate, managerOnly);

// GET / — every update that isn't archived, newest first, with who has read it.
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT u.id, u.title, u.summary, u.body, u.published_at, u.updated_at,
             COALESCE(NULLIF(s.preferred_name, ''), s.first_name) AS created_by_name,
             COALESCE((
               SELECT json_agg(json_build_object(
                        'staff_id', r.staff_id,
                        'name', COALESCE(NULLIF(rs.preferred_name, ''), rs.first_name),
                        'read_at', r.read_at) ORDER BY r.read_at)
                 FROM wren_update_reads r
                 JOIN staff rs ON rs.id = r.staff_id
                WHERE r.update_id = u.id), '[]') AS reads
        FROM wren_updates u
        LEFT JOIN staff s ON s.id = u.created_by
       WHERE u.archived_at IS NULL
       ORDER BY u.published_at DESC, u.id DESC`);
    res.json({
      me: Number(req.user.id),
      updates: rows.map(r => ({ ...r, html: renderUpdate(r.body) })),
    });
  } catch (e) {
    console.error('[wren-updates] list failed:', e.message);
    res.status(500).json({ error: 'Could not load the updates' });
  }
});

// POST / — write a new update.
router.post('/', async (req, res) => {
  const title   = clean(req.body && req.body.title, 200);
  const summary = clean(req.body && req.body.summary, 400);
  const body    = clean(req.body && req.body.body, 30000);
  if (!title) return res.status(400).json({ error: 'Give the update a title' });
  if (!body)  return res.status(400).json({ error: 'The update has nothing in it yet' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO wren_updates (title, summary, body, created_by)
       VALUES ($1, NULLIF($2, ''), $3, $4) RETURNING id`,
      [title, summary, body, req.user.id]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error('[wren-updates] create failed:', e.message);
    res.status(500).json({ error: 'Could not save the update' });
  }
});

// PUT /:id — correct an update.
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const title   = clean(req.body && req.body.title, 200);
  const summary = clean(req.body && req.body.summary, 400);
  const body    = clean(req.body && req.body.body, 30000);
  if (!id) return res.status(400).json({ error: 'Which update?' });
  if (!title || !body) return res.status(400).json({ error: 'An update needs a title and some words' });
  try {
    const { rowCount } = await getPool().query(
      `UPDATE wren_updates SET title = $1, summary = NULLIF($2, ''), body = $3, updated_at = now()
        WHERE id = $4 AND archived_at IS NULL`, [title, summary, body, id]);
    if (!rowCount) return res.status(404).json({ error: 'That update no longer exists' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[wren-updates] edit failed:', e.message);
    res.status(500).json({ error: 'Could not save the change' });
  }
});

// POST /:id/read — the first time someone opens an update.
router.post('/:id/read', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Which update?' });
  try {
    await getPool().query(
      `INSERT INTO wren_update_reads (update_id, staff_id)
       SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM wren_updates WHERE id = $1)
       ON CONFLICT DO NOTHING`, [id, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[wren-updates] read failed:', e.message);
    res.status(500).json({ error: 'Could not record that' });
  }
});

// POST /:id/archive — take an update off the page. Kept, never deleted.
router.post('/:id/archive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Which update?' });
  try {
    await getPool().query(
      `UPDATE wren_updates SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[wren-updates] archive failed:', e.message);
    res.status(500).json({ error: 'Could not archive it' });
  }
});

module.exports = router;
