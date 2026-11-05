'use strict';
// b155 — Generic "share this with a child's home learning" mechanism.
// Staff push a next-step / phonics / story-studio / activity-bank item (or a Play
// Plan) into the child's parent-portal "Home activities" card. One shared table,
// used by every share-with-child button rather than a bespoke flag per source table.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const MGR_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'business_manager']);
const ITEM_TYPES = new Set(['next_step', 'phonics', 'story_session', 'activity', 'play_plan', 'other']);

// item 6 (2026-07-29) — home-activity document attachments (resource cards, phonics
// sound sheets, …). Each attachment is a small {name,url} pointer to an existing doc/
// resource; we don't store files here. Kept defensive: cap count + string lengths so a
// malformed payload can't bloat the row. Returns a clean array (never throws).
function normAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const url = String(a.url || a.href || '').trim().slice(0, 1000);
    if (!url) continue;
    const name = String(a.name || a.title || url).trim().slice(0, 200);
    const kind = String(a.kind || a.type || 'document').trim().slice(0, 40);
    out.push({ name, url, kind });
    if (out.length >= 12) break;
  }
  return out;
}

// Staff scope: managers/SENCO share for any child; practitioners only their key children.
async function checkStaffAccess(req, childId) {
  if (MGR_ROLES.has(req.user.role)) return true;
  const db = getPool();
  const { rows: sencoRows } = await db.query('SELECT is_send_lead FROM staff WHERE id=$1', [req.user.id]);
  if (sencoRows[0] && sencoRows[0].is_send_lead) return true;
  const { rows } = await db.query('SELECT key_person_id FROM children WHERE id=$1', [childId]);
  return !!rows.length && Number(rows[0].key_person_id) === Number(req.user.id);
}

// Parent scope: trusts the signed JWT's child_ids, falls back to a DB lookup (person-documents.js pattern).
async function parentChildIds(req, db) {
  const ids = new Set();
  if (Array.isArray(req.user.child_ids)) req.user.child_ids.forEach(i => ids.add(Number(i)));
  if (req.user.child_id != null) ids.add(Number(req.user.child_id));
  if (ids.size) return ids;
  const email = (req.user.email || '').toLowerCase();
  if (email) {
    try {
      const { rows } = await db.query(
        `SELECT child_id FROM parent_portal_access WHERE lower(email)=$1 AND is_active=true AND child_id IS NOT NULL`, [email]);
      rows.forEach(r => ids.add(Number(r.child_id)));
    } catch (_) {}
  }
  return ids;
}

// POST / — staff shares an item to a child's home-learning view
router.post('/', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Forbidden' });
  const { child_id, item_type, item_id, title, description } = req.body;
  if (!child_id || !item_type || !title) return res.status(400).json({ error: 'child_id, item_type and title required' });
  if (!ITEM_TYPES.has(item_type)) return res.status(400).json({ error: 'Invalid item_type' });
  const attachments = normAttachments(req.body.attachments);
  try {
    if (!(await checkStaffAccess(req, child_id)))
      return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO shared_items (child_id, item_type, item_id, title, description, shared_by, attachments)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *
    `, [child_id, item_type, item_id || null, String(title).trim(), description || null, req.user.id, JSON.stringify(attachments)]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId — staff view of everything shared for a child
router.get('/child/:childId', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Forbidden' });
  const childId = parseInt(req.params.childId, 10);
  try {
    if (!(await checkStaffAccess(req, childId)))
      return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });
    const db = getPool();
    const { rows } = await db.query(`
      SELECT si.*, s.first_name || ' ' || s.last_name AS shared_by_name
      FROM shared_items si LEFT JOIN staff s ON s.id = si.shared_by
      WHERE si.child_id=$1 ORDER BY si.is_active DESC, si.shared_at DESC LIMIT 100
    `, [childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id — unshare (soft)
router.delete('/:id', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    const { rows: existing } = await db.query('SELECT child_id FROM shared_items WHERE id=$1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    if (!(await checkStaffAccess(req, existing[0].child_id)))
      return res.status(403).json({ error: "Forbidden — SENCO/manager or this child's key person only" });
    await db.query('UPDATE shared_items SET is_active=false, unshared_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /parent/mine — parent portal "Home activities" card, own child(ren) only
router.get('/parent/mine', async (req, res) => {
  if (req.user.role !== 'parent') return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    const ids = await parentChildIds(req, db);
    if (!ids.size) return res.json([]);
    const idArr = Array.from(ids);
    const { rows } = await db.query(`
      SELECT id, child_id, item_type, title, description, shared_at,
             COALESCE(attachments, '[]'::jsonb) AS attachments
      FROM shared_items WHERE child_id = ANY($1::int[]) AND is_active=true
      ORDER BY shared_at DESC LIMIT 50
    `, [idArr]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
