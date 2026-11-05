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

// ── b360 (2026-09-29) — more than one screenshot, and which part of Wren ─────
// Toby: "They can submit screenshots. Maybe add a screenshot button."
//
// The single `screenshot` field above is UNCHANGED and still the first shot, so
// ladn.reports_inbox.has_screenshot, the bugs board and every report ever filed
// keep working exactly as they did. Shots 2..n go to ladn.feedback_report_shots.
// Nothing else about this router's contract moves: a bug is still one row in
// ladn.feedback_reports, which is still the b197 'staff-app' source. There is no
// second bug store here and there must never be one.
const SHOTS_MAX = 4;                  // per report
const SHOT_BYTES_MAX = 6 * 1024 * 1024;  // per shot, DECODED
const SHOT_ORIGINS = ['upload', 'capture'];
// nginx gives the EY portal 16m (docker/nginx/default.conf, port 84) and the
// global express.json limit is 20mb, so four 6MB shots would be refused by the
// edge before this file ever saw them. The client caps itself at 4; this is the
// server saying the same thing rather than trusting it.

// One data URL -> a file next to the report. Returns the row to insert, or null
// if it is not an image we accept or it is too big. Never throws: a screenshot
// that cannot be written must never lose the words somebody typed.
function writeShot(dataUrl, reportId, idx) {
  const m = /^data:image\/(png|jpeg|webp);base64,/.exec(String(dataUrl || ''));
  if (!m) return null;
  const b64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
  // 4 base64 chars per 3 bytes — decode size without allocating the buffer first.
  if (!b64 || (b64.length * 3) / 4 > SHOT_BYTES_MAX) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return null;
    const file = path.join(SHOT_DIR, `fb-${reportId}-${idx}.${ext}`);
    fs.writeFileSync(file, buf);
    return { file_path: file, mime: 'image/' + m[1], bytes: buf.length };
  } catch (e) {
    console.error('[feedback] shot %d save failed (report kept):', idx, e.message);
    return null;
  }
}

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
  if (req.isParent || !['manager', 'deputy_manager', 'headteacher', 'admin'].includes(String(req.user.role || '').toLowerCase())) {
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
    // b360 — wren_area is the finer-grained "which part of Wren" than the b197
    // view's portal-level `area`. Optional, so every existing caller (the 🐞
    // widget on four portals) posts exactly what it always did and gets NULL.
    const wrenArea = req.body && req.body.wren_area
      ? String(req.body.wren_area).slice(0, 60) : null;
    // b395 — diagnostics for the weekly fixer: device/browser, what the page
    // looked like, and what the console already knew was wrong. Never form
    // field values — console_errors is window.onerror/console.error lines only.
    const userAgent = String(req.body && req.body.user_agent || req.headers['user-agent'] || '').slice(0, 300) || null;
    const viewport = req.body && req.body.viewport ? String(req.body.viewport).slice(0, 40) : null;
    const appBuild = req.body && req.body.app_build ? String(req.body.app_build).slice(0, 80) : null;
    const consoleErrors = Array.isArray(req.body && req.body.console_errors)
      ? JSON.stringify(req.body.console_errors.map(e => String(e).slice(0, 500)).slice(0, 20)) : null;
    const { rows } = await db.query(
      `INSERT INTO feedback_reports (portal, page_path, kind, title, body, submitted_by, submitted_by_name, submitted_by_email, wren_area, user_agent, viewport, app_build, console_errors)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, created_at`,
      [String(portal || 'unknown').slice(0, 20), String(page_path || '').slice(0, 300), kind || 'bug',
       String(title).slice(0, 300), String(body || '').slice(0, 5000),
       req.isParent ? null : req.user.id, name, req.user.email || null, wrenArea,
       userAgent, viewport, appBuild, consoleErrors]);
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

    // b360 — screenshots[] : the Staff Feedback page sends an ARRAY, and the 🐞
    // widget now does too when somebody attaches more than one. Each is written
    // as its own file and its own ladn.feedback_report_shots row.
    //
    // If the caller sent no legacy `screenshot`, the FIRST of these is also
    // promoted to feedback_reports.screenshot_path — so the bugs board's
    // has_screenshot is true and GET /:id/screenshot answers, exactly as for a
    // report filed by the old widget. Without that promotion a report with four
    // pictures would show on the board as having none.
    //
    // A failed shot never fails the report: somebody typed those words on a
    // tablet in a room, and losing them because a disk write failed would be the
    // worst possible trade.
    let extraShots = 0;
    const shotsIn = Array.isArray(req.body && req.body.screenshots)
      ? req.body.screenshots.slice(0, SHOTS_MAX) : [];
    const originsIn = Array.isArray(req.body && req.body.screenshot_origins)
      ? req.body.screenshot_origins : [];
    for (let i = 0; i < shotsIn.length; i++) {
      const w = writeShot(shotsIn[i], report.id, i + 1);
      if (!w) continue;
      const origin = SHOT_ORIGINS.indexOf(String(originsIn[i])) !== -1 ? String(originsIn[i]) : 'upload';
      try {
        await db.query(
          `INSERT INTO feedback_report_shots (report_id, file_path, mime, bytes, origin, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [report.id, w.file_path, w.mime, w.bytes, origin, i + 1]);
        extraShots++;
        if (!shotPath) {
          shotPath = w.file_path;
          await db.query(`UPDATE feedback_reports SET screenshot_path=$1 WHERE id=$2`, [shotPath, report.id]);
        }
      } catch (e) {
        console.error('[feedback] shot row failed (report kept):', e.message);
      }
    }

    // Straight onto Toby's cockpit kanban. works/feedback = medium, bugs = high.
    let cardId = null;
    try {
      const { rows: card } = await db.query(
        `INSERT INTO cockpit_cards (title, detail, col, priority, source, tags, created_by)
         VALUES ($1,$2,'backlog',$3,'feedback',$4,$5) RETURNING id`,
        [`${KIND_EMOJI[kind] || '💬'} [${portal || '?'}] ${String(title).slice(0, 180)}`,
         `From ${name} on ${page_path || 'unknown page'} (${kind}${wrenArea ? ', ' + wrenArea : ''}).\n\n${String(body || '').slice(0, 1500)}${shotPath ? '\n\n📎 Screenshot: /api/feedback/' + report.id + '/screenshot' : ''}${extraShots > 1 ? '\n📎 ' + extraShots + ' screenshots: /api/feedback/' + report.id + '/shots' : ''}`,
         kind === 'bug' ? 'high' : 'medium',
         ['feedback', kind, String(portal || 'unknown')],
         req.isParent ? null : req.user.id]);
      cardId = card[0].id;
      await db.query(`UPDATE feedback_reports SET cockpit_card_id=$1 WHERE id=$2`, [cardId, report.id]);
    } catch (cardErr) {
      console.error('[feedback] cockpit card failed (report kept):', cardErr.message);
    }

    res.status(201).json({ ok: true, id: report.id, cockpit_card_id: cardId,
      screenshot_saved: !!shotPath, shots_saved: extraShots });
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

// ── b395: GET /mine — a PARENT's own "Report a bug" submissions only ─────────
// The parents app has two feedback stores (see parent-app-feedback.js for the
// "Tell us what to change" one); this is the other one — reports filed through
// the 🐞 widget with portal='parents'. Scoped by email off the token, same
// pattern as GET /api/staff-feedback/mine: there is no parameter that could
// widen it. Joined against reports_triage (b197) so a parent can see "fixed"
// (and when) without any staff-only table being exposed directly. (b395's join to
// wren_updates.fixed_report_keys is NOT ported — D13, the second What's-new, was killed.)
const parentOnly = (req, res, next) => (req.isParent ? next() : res.status(403).json({ error: 'Parents only' }));
router.get('/mine', parentOnly, async (req, res) => {
  const email = String(req.user.email || '').toLowerCase().trim();
  if (!email) return res.json([]);
  try {
    const { rows } = await getPool().query(
      `SELECT f.id, f.kind, f.title, f.body, f.page_path, f.created_at,
              COALESCE(t.status, CASE f.status
                WHEN 'new' THEN 'new' WHEN 'triaged' THEN 'triaged'
                WHEN 'in_progress' THEN 'in_progress' WHEN 'done' THEN 'fixed'
                WHEN 'dismissed' THEN 'wont_fix' ELSE 'new' END) AS status,
              t.fixed_at
         FROM feedback_reports f
         LEFT JOIN reports_triage t ON t.source = 'staff-app' AND t.source_id = f.id
        WHERE f.portal = 'parents' AND lower(f.submitted_by_email) = $1
        ORDER BY f.created_at DESC LIMIT 50`, [email]);
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

// ── b360: GET /:id/shots — every screenshot on one report ────────────────────
// Manager-only, exactly like /:id/screenshot above: a screenshot of a Wren page
// can show a child's name, so this is not a list a practitioner may read.
// The primary shot (feedback_reports.screenshot_path) is listed FIRST with
// id 0, so a caller has one list rather than "the one" plus "the others".
router.get('/:id/shots', managerOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
  try {
    const db = getPool();
    const { rows: rep } = await db.query(
      `SELECT screenshot_path FROM feedback_reports WHERE id=$1`, [id]);
    if (!rep.length) return res.status(404).json({ error: 'not found' });
    const out = [];
    if (rep[0].screenshot_path) {
      out.push({ id: 0, url: `/api/feedback/${id}/screenshot`, origin: 'upload', primary: true });
    }
    const { rows } = await db.query(
      `SELECT id, mime, bytes, origin, file_path FROM feedback_report_shots
        WHERE report_id=$1 ORDER BY sort_order, id`, [id]);
    rows.forEach(r => {
      // The one promoted to screenshot_path is already in the list — do not
      // offer the same picture twice.
      if (rep[0].screenshot_path && r.file_path === rep[0].screenshot_path) return;
      out.push({ id: r.id, url: `/api/feedback/${id}/shots/${r.id}`,
                 mime: r.mime, bytes: r.bytes, origin: r.origin, primary: false });
    });
    res.json({ report_id: id, shots: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── b360: GET /:id/shots/:shotId — one of them ───────────────────────────────
// The shot id is checked AGAINST the report id, so a valid shot id belonging to
// a different report cannot be fetched by guessing a report number.
router.get('/:id/shots/:shotId', managerOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const shotId = parseInt(req.params.shotId, 10);
  if (!Number.isInteger(id) || !Number.isInteger(shotId)) return res.status(400).json({ error: 'bad id' });
  try {
    const { rows } = await getPool().query(
      `SELECT file_path, mime FROM feedback_report_shots WHERE id=$1 AND report_id=$2`, [shotId, id]);
    if (!rows.length) return res.status(404).json({ error: 'No screenshot' });
    res.type(rows[0].mime || 'image/png');
    res.sendFile(rows[0].file_path);
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
