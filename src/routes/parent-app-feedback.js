// Parent app feedback (b129, 2026-07-21) — the newsletter promised "a feedback
// button right inside the app soon". Parents submit like/change/idea/bug/other
// with free text + optional screen context. Every submission auto-creates a
// card on Toby's cockpit kanban (source='parent-app-feedback', col=backlog)
// and a notification — same reuse-the-pattern approach as feedback.js (the
// staff bug-tracker widget), but its own table since the category taxonomy,
// status lifecycle and per-parent ownership scoping are all different.
'use strict';
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { getPool } = require('../db/pool');

const CATEGORIES = ['like', 'change', 'idea', 'bug', 'other'];
const CATEGORY_EMOJI = { like: '💚', change: '🔧', idea: '💡', bug: '🐞', other: '💬' };
const STATUSES = ['new', 'reviewed', 'actioned', 'dismissed'];
const MGR_ROLES = ['manager', 'deputy_manager', 'headteacher', 'admin'];

// Both parents and managers (Roost triage) hit this router — resolve identity first.
router.use((req, res, next) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-wren-token'] || '';
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    req.isParent = req.user.aud === 'parents' || req.user.role === 'parent';
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

const managerOnly = (req, res, next) => {
  if (req.isParent || !MGR_ROLES.includes(String(req.user.role || '').toLowerCase())) {
    return res.status(403).json({ error: 'Manager only' });
  }
  next();
};
const parentOnly = (req, res, next) => {
  if (!req.isParent) return res.status(403).json({ error: 'Parents only' });
  next();
};

// ── POST / — a parent submits feedback ────────────────────────────────────────
router.post('/', parentOnly, async (req, res) => {
  const { category, body, page_context, child_id } = req.body || {};
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'valid category required' });
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'body required' });

  // child_id is optional context (this is app feedback, not child data) — if given,
  // it must be one of THIS parent's own children (child_ids on the JWT covers siblings).
  const ownChildIds = Array.isArray(req.user.child_ids) ? req.user.child_ids
    : (req.user.child_id != null ? [req.user.child_id] : []);
  let scopedChildId = null;
  if (child_id != null) {
    const cid = parseInt(child_id, 10);
    if (ownChildIds.includes(cid)) scopedChildId = cid;
  }

  const email = String(req.user.email || '').toLowerCase().trim() || null;
  const db = getPool();
  try {
    let fb;
    try {
      const { rows } = await db.query(
        `INSERT INTO parent_app_feedback (parent_email, child_id, category, body, page_context)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
        [email, scopedChildId, category, String(body).slice(0, 5000), String(page_context || '').slice(0, 200)]);
      fb = rows[0];
    } catch (insertErr) {
      // A child_id can be valid-on-the-JWT but no longer exist (e.g. a stale/leaver
      // token) — never let that lose the parent's feedback, just drop the linkage.
      if (scopedChildId != null && insertErr.code === '23503') {
        const { rows } = await db.query(
          `INSERT INTO parent_app_feedback (parent_email, child_id, category, body, page_context)
           VALUES ($1,NULL,$2,$3,$4) RETURNING id, created_at`,
          [email, category, String(body).slice(0, 5000), String(page_context || '').slice(0, 200)]);
        fb = rows[0];
      } else {
        throw insertErr;
      }
    }

    // Straight onto Toby's cockpit kanban, same as the staff feedback widget.
    let cardId = null;
    try {
      const { rows: card } = await db.query(
        `INSERT INTO cockpit_cards (title, detail, col, priority, source, tags)
         VALUES ($1,$2,'backlog','medium','parent-app-feedback',$3) RETURNING id`,
        [`${CATEGORY_EMOJI[category] || '💬'} Parent app feedback (${category})`,
         `From a parent on ${page_context || 'the app'}.\n\n${String(body).slice(0, 1500)}`,
         ['parent-app-feedback', category]]);
      cardId = card[0].id;
      await db.query(`UPDATE parent_app_feedback SET cockpit_card_id=$1 WHERE id=$2`, [cardId, fb.id]);
    } catch (cardErr) {
      console.error('[parent-app-feedback] cockpit card failed (feedback kept):', cardErr.message);
    }

    // Notify Toby via the existing in-app notifications pipeline.
    try {
      await db.query(
        `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
         VALUES ('staff', 1, 'parent_app_feedback', $1, $2, '/parent-app-feedback.html', 'parent_app_feedback', $3, 'normal')`,
        [`Parent app feedback: ${category}`, String(body).slice(0, 500), fb.id]);
    } catch (notifErr) {
      console.error('[parent-app-feedback] notification failed (feedback kept):', notifErr.message);
    }

    res.status(201).json({ ok: true, id: fb.id, cockpit_card_id: cardId });
  } catch (e) {
    console.error('[parent-app-feedback] submit error:', e.message);
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

// ── GET /mine — a parent's OWN submissions only (across siblings, by email) ──
// b395 — triage_status/fixed_at are additive: joined against b197's reports_triage
// so "fixed" (and when) shows up without a second lookup table; a report never
// triaged simply gets nulls, same contract as before this join existed.
router.get('/mine', parentOnly, async (req, res) => {
  const email = String(req.user.email || '').toLowerCase().trim();
  if (!email) return res.json([]);
  try {
    const { rows } = await getPool().query(
      `SELECT f.id, f.category, f.body, f.page_context, f.status, f.created_at,
              COALESCE(t.status, CASE f.status
                WHEN 'new' THEN 'new' WHEN 'reviewed' THEN 'triaged'
                WHEN 'actioned' THEN 'fixed' WHEN 'dismissed' THEN 'wont_fix' ELSE 'new' END) AS triage_status,
              t.fixed_at
         FROM parent_app_feedback f
         LEFT JOIN reports_triage t ON t.source = 'parent-app' AND t.source_id = f.id
        WHERE f.parent_email = $1 ORDER BY f.created_at DESC LIMIT 50`,
      [email]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET / — manager triage list ────────────────────────────────────────────────
router.get('/', managerOnly, async (req, res) => {
  try {
    const status = String(req.query.status || '');
    const { rows } = await getPool().query(
      `SELECT f.id, f.parent_email, f.child_id, f.category, f.body, f.page_context, f.status,
              f.cockpit_card_id, f.created_at,
              c.first_name || ' ' || c.last_name AS child_name
       FROM parent_app_feedback f LEFT JOIN children c ON c.id = f.child_id
       ${status ? 'WHERE f.status=$1' : ''} ORDER BY f.created_at DESC LIMIT 200`,
      status ? [status] : []);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/status — manager marks reviewed/actioned/dismissed ─────────────
router.post('/:id/status', managerOnly, async (req, res) => {
  const s = String((req.body || {}).status || '');
  if (!STATUSES.includes(s)) return res.status(400).json({ error: 'bad status' });
  try {
    const { rowCount } = await getPool().query(
      `UPDATE parent_app_feedback SET status=$1 WHERE id=$2`, [s, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
