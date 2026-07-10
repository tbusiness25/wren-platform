// Feedback / bug reports (2026-07-09) — the "staff are testing it" module.
// A floating widget on every portal (admin, EY, HR, parents) posts here:
// bug / idea / works / feedback, optional annotated screenshot (data URL).
// Every report auto-creates a card in Toby's cockpit kanban (col=backlog,
// source='feedback') so testing feedback lands straight on his to-do list.
'use strict';
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { getPool } = require('../db/pool');

const SHOT_DIR = process.env.FEEDBACK_SHOT_DIR || '/app/uploads/feedback';
const KINDS = ['bug', 'idea', 'works', 'feedback'];
const KIND_EMOJI = { bug: '🐞', idea: '💡', works: '✅', feedback: '💬' };

// Staff (any role, any portal audience) OR parent JWTs may submit.
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
  if (req.isParent || !['manager', 'deputy', 'deputy_manager', 'headteacher', 'admin'].includes(String(req.user.role || '').toLowerCase())) {
    return res.status(403).json({ error: 'Manager only' });
  }
  next();
};

// ── POST / — submit a report ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { kind, title, body, portal, page_path, screenshot } = req.body || {};
  if (!title || !KINDS.includes(kind || 'bug')) return res.status(400).json({ error: 'title and valid kind required' });
  const db = getPool();
  try {
    const name = req.user.name || (req.isParent ? 'Parent' : `staff #${req.user.id}`);
    const { rows } = await db.query(
      `INSERT INTO feedback_reports (portal, page_path, kind, title, body, submitted_by, submitted_by_name, submitted_by_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
      [String(portal || 'unknown').slice(0, 20), String(page_path || '').slice(0, 300), kind || 'bug',
       String(title).slice(0, 300), String(body || '').slice(0, 5000),
       req.isParent ? null : req.user.id, name, req.user.email || null]);
    const report = rows[0];

    // Screenshot: accept a (possibly annotated) PNG/JPEG data URL, max ~4MB decoded.
    let shotPath = null;
    if (screenshot && /^data:image\/(png|jpeg);base64,/.test(screenshot)) {
      const b64 = screenshot.split(',')[1] || '';
      if (b64.length < 6 * 1024 * 1024) {
        try {
          fs.mkdirSync(SHOT_DIR, { recursive: true });
          const ext = screenshot.startsWith('data:image/png') ? 'png' : 'jpg';
          shotPath = path.join(SHOT_DIR, `fb-${report.id}.${ext}`);
          fs.writeFileSync(shotPath, Buffer.from(b64, 'base64'));
          await db.query(`UPDATE feedback_reports SET screenshot_path=$1 WHERE id=$2`, [shotPath, report.id]);
        } catch (fsErr) {
          console.error('[feedback] screenshot save failed (report kept):', fsErr.message);
          shotPath = null;
        }
      }
    }

    // Straight onto Toby's cockpit kanban. works/feedback = medium, bugs = high.
    let cardId = null;
    try {
      const { rows: card } = await db.query(
        `INSERT INTO cockpit_cards (title, detail, col, priority, source, tags, created_by)
         VALUES ($1,$2,'backlog',$3,'feedback',$4,$5) RETURNING id`,
        [`${KIND_EMOJI[kind] || '💬'} [${portal || '?'}] ${String(title).slice(0, 180)}`,
         `From ${name} on ${page_path || 'unknown page'} (${kind}).\n\n${String(body || '').slice(0, 1500)}${shotPath ? '\n\n📎 Screenshot: /api/feedback/' + report.id + '/screenshot' : ''}`,
         kind === 'bug' ? 'high' : 'medium',
         ['feedback', kind, String(portal || 'unknown')],
         req.isParent ? null : req.user.id]);
      cardId = card[0].id;
      await db.query(`UPDATE feedback_reports SET cockpit_card_id=$1 WHERE id=$2`, [cardId, report.id]);
    } catch (cardErr) {
      console.error('[feedback] cockpit card failed (report kept):', cardErr.message);
    }

    res.status(201).json({ ok: true, id: report.id, cockpit_card_id: cardId, screenshot_saved: !!shotPath });
  } catch (e) {
    console.error('[feedback] submit error:', e.message);
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

// ── GET / — manager list ──────────────────────────────────────────────────────
router.get('/', managerOnly, async (req, res) => {
  try {
    const status = String(req.query.status || '');
    const { rows } = await getPool().query(
      `SELECT id, portal, page_path, kind, title, body, status, submitted_by_name,
              (screenshot_path IS NOT NULL) AS has_screenshot, cockpit_card_id, created_at
       FROM feedback_reports ${status ? 'WHERE status=$1' : ''} ORDER BY created_at DESC LIMIT 200`,
      status ? [status] : []);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /:id/screenshot ───────────────────────────────────────────────────────
router.get('/:id/screenshot', managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT screenshot_path FROM feedback_reports WHERE id=$1`, [req.params.id]);
    if (!rows.length || !rows[0].screenshot_path) return res.status(404).json({ error: 'No screenshot' });
    res.sendFile(rows[0].screenshot_path);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/status ──────────────────────────────────────────────────────────
router.post('/:id/status', managerOnly, async (req, res) => {
  const s = String((req.body || {}).status || '');
  if (!['new', 'triaged', 'in_progress', 'done', 'dismissed'].includes(s)) return res.status(400).json({ error: 'bad status' });
  try {
    const { rowCount } = await getPool().query(`UPDATE feedback_reports SET status=$1 WHERE id=$2`, [s, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
