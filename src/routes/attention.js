'use strict';
/**
 * attention.js — b232 (2026-08-26)
 *
 * The "What needs me" board.
 *
 *   GET    /api/attention/summary     counts only — this is what the traffic
 *                                     lights on the landing page call, so it
 *                                     stays a single GROUP BY and nothing else
 *   GET    /api/attention/items       the board: start_here, three columns
 *   POST   /api/attention/items       add one by hand
 *   PATCH  /api/attention/items/:id   snooze / resolve / reopen
 *   POST   /api/attention/refresh     re-run the collectors
 *   GET    /api/attention/mylist           b504 — My list: countdown, Do now, Next, Claude, Waiting, Later, Parked, Close
 *   POST   /api/attention/mylist/capture   b504 — add a job by text
 *   POST   /api/attention/mylist/close     b504 — the CLOSE section: close the ticked, keep the rest, one call
 *   GET    /api/attention/mylist/stats     b504 — sends, taps, done this week, plan-hit rate
 *   GET/PATCH /api/attention/mylist/settings  b504 — the mylist_* keys (managers; no secrets in them)
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Manager role AND the admin (Roost) portal, both checked server-side, the same
 * shape as src/routes/finance-reports.js. The role check alone is not enough: a
 * manager signed in on the EY portal holds a token with audience 'learning' and
 * that token passes requireRole('manager') on every shared route. This board
 * aggregates safeguarding counts, money and unanswered parents. It belongs on
 * one portal, so the portal is checked.
 *
 * ── WHAT THE ITEMS DO NOT CONTAIN ───────────────────────────────────────────
 * No child, parent or staff row content — the collectors emit counts and ids
 * only, and nothing in this file goes back to the source table to enrich them.
 * A card says "3 parents waiting"; reading what they said means opening Comms,
 * where the access checks for that live.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const attention = require('../services/attention');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const mylist = require('../services/mylist/service');   // b504 — My list

// ── the guard ────────────────────────────────────────────────────────────────
function managerAdminOnly(req, res, next) {
  const portal = req._portal || null;
  if (portal !== 'admin') {
    return res.status(403).json({
      error: 'forbidden_portal',
      message: 'The attention board is available on the Roost (admin) portal only.',
    });
  }
  if (!req.user || !hasRole(req.user, ['manager', 'admin'])) {
    return res.status(403).json({
      error: 'forbidden_role',
      message: 'Manager access only — this board aggregates safeguarding, money and unanswered parents.',
    });
  }
  next();
}

const guard = [authenticate, managerAdminOnly];

const RAGS = ['red', 'amber', 'green'];

// ── GET /summary — counts only ──────────────────────────────────────────────
router.get('/summary', guard, async (req, res) => {
  try {
    res.json(await attention.summary());
  } catch (e) {
    console.error('[attention] summary:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /items — the board ──────────────────────────────────────────────────
router.get('/items', guard, async (req, res) => {
  try {
    const data = await attention.board({ include_snoozed: req.query.include_snoozed === '1', include_jobs: req.query.include_jobs === '1' });
    res.json(Object.assign({ ok: true }, data));
  } catch (e) {
    console.error('[attention] items:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /items — a manual add ──────────────────────────────────────────────
// Title, optional due date, optional effort. That is all it asks for, because a
// form with eight fields is a form that does not get filled in.
router.post('/items', guard, async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title_required' });
  if (title.length > 300) return res.status(400).json({ error: 'title_too_long' });

  const dueDate = req.body.due_date ? String(req.body.due_date).slice(0, 10) : null;
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'bad_due_date' });

  let effort = req.body.effort_minutes == null || req.body.effort_minutes === '' ? null : parseInt(req.body.effort_minutes, 10);
  if (effort != null && (!Number.isFinite(effort) || effort < 0 || effort > 10000)) effort = null;

  // classify() decides the colour, here as everywhere else.
  const { classify } = require('../services/attention/rag');
  const c = classify({ dueDate, blockedOnToby: true, informational: !dueDate });

  try {
    const { rows } = await getPool().query(`
      INSERT INTO attention_items
        (source, source_key, rag, severity, title, detail, why, category, due_date,
         blocked_on, effort_minutes, action_url, evidence, manual, sort_hint)
      VALUES ('manual', $1, $2, $2, $3, $4, $5, 'manual', $6, 'toby', $7, NULL, $8::jsonb, true, 0)
      RETURNING id, source, source_key, rag, title, detail, why, due_date, effort_minutes, manual`,
      [
        `toby-${Date.now()}`, c.rag, title,
        req.body.detail ? String(req.body.detail).slice(0, 2000) : null,
        c.why, dueDate, effort,
        JSON.stringify({ added_by_staff_id: req.user.id || null }),
      ]);
    res.status(201).json({ ok: true, item: rows[0] });
  } catch (e) {
    console.error('[attention] create:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /items/:id — snooze, resolve, reopen ──────────────────────────────
router.patch('/items/:id', guard, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });

  const action = String(req.body.action || '').toLowerCase();
  const db = getPool();

  try {
    // b504 — My-list actions (stage / park / drop / tomorrow / later / swap / use_buffer / tone /
    // focus / date / undo) live in the service; the existing four actions below are untouched.
    if (mylist.ACTIONS.has(action)) {
      return res.json({ ok: true, item: await mylist.patch(db, req.user, id, action, req.body || {}) });
    }
    // b504 — Done on a mirrored Kanban card / task ticks the source row first. If that
    // fails the item stays open and the error comes back (never a half-done tick).
    if (action === 'resolve' || action === 'done') {
      const wt = await mylist.writeThrough(db, id, req.user);
      if (!wt.ok) return res.status(wt.status || 500).json({ error: wt.error, message: wt.message });
    }
    let sql, params;
    if (action === 'snooze') {
      // 1 day or 1 week. Nothing else, because a snooze menu with six options is
      // a decision, and the point of snoozing is to avoid making one.
      const days = req.body.days === 7 || req.body.days === '7' ? 7 : 1;
      sql = `UPDATE attention_items
                SET snoozed_until = now() + ($2 || ' days')::interval
              WHERE id = $1 RETURNING id, snoozed_until, status`;
      params = [id, String(days)];
    } else if (action === 'resolve' || action === 'done') {
      sql = `UPDATE attention_items
                SET resolved_at = now(), resolved_by = $2
              WHERE id = $1 AND resolved_at IS NULL RETURNING id, resolved_at, status`;
      params = [id, req.user.id || null];
    } else if (action === 'reopen') {
      sql = `UPDATE attention_items
                SET resolved_at = NULL, resolved_by = NULL, snoozed_until = NULL, status = 'open'
              WHERE id = $1 RETURNING id, resolved_at, status`;
      params = [id];
    } else if (action === 'unsnooze') {
      sql = `UPDATE attention_items SET snoozed_until = NULL WHERE id = $1 RETURNING id, snoozed_until, status`;
      params = [id];
    } else {
      return res.status(400).json({ error: 'bad_action', message: 'action must be snooze, unsnooze, resolve, done or reopen (or a My-list action)' });
    }

    const { rows } = await db.query(sql, params);
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_no_change' });
    res.json({ ok: true, item: rows[0] });
  } catch (e) {
    if (e && e.status && e.status < 500) return res.status(e.status).json({ error: e.code || 'bad_request', message: e.message });
    console.error('[attention] patch:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /refresh — re-run the collectors ───────────────────────────────────
// Two of them (crons, migrations) need `crontab -l`, /app/build-logs and
// the production database, none of which exist inside the container. From here
// they report ok:false, which by design resolves nothing — their items simply
// stay as the host cron last left them. The response says which ones were blind
// rather than pretending the board is complete.
router.post('/refresh', guard, async (req, res) => {
  try {
    const report = await attention.refresh({ quiet: true });
    const blind = report.collectors.filter(c => !c.ok).map(c => c.name);
    res.json({
      ok: true,
      inserted: report.inserted,
      updated: report.updated,
      resolved: report.resolved,
      collectors: report.collectors,
      blind,
      note: blind.length
        ? `${blind.join(', ')} could not run in here — they need the host. The nightly \`scripts/attention-refresh.js\` covers them.`
        : null,
      summary: await attention.summary(),
    });
  } catch (e) {
    console.error('[attention] refresh:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══ b504 — MY LIST ═════════════════════════════════════════════════════════════
// One list, three jobs a day. Same guard as everything above (Roost portal + manager).
// A parent token fails on portal, a practitioner token fails on role: both 403.
// Nothing here emails, messages or deletes anything.

function mylistFail(res, e, tag) {
  if (e && e.status && e.status < 500) return res.status(e.status).json({ error: e.code || 'bad_request', message: e.message });
  console.error(`[attention] mylist ${tag}:`, e.message);
  return res.status(500).json({ error: e.message });
}

// GET /mylist — the whole view. Calls the picker lazily (idempotent), so opening the
// tab at 07:00 shows today's three.
router.get('/mylist', guard, async (req, res) => {
  try {
    res.json(await mylist.buildMyList(getPool(), req.user, undefined, {
      compact: req.query.compact === '1', nextAll: req.query.next_all === '1', claudeAll: req.query.claude_all === '1' }));
  }
  catch (e) { mylistFail(res, e, 'view'); }
});

// POST /mylist/capture — {text, via}
router.post('/mylist/capture', guard, async (req, res) => {
  try { res.status(201).json({ ok: true, item: await mylist.capture(getPool(), req.user, req.body || {}) }); }
  catch (e) { mylistFail(res, e, 'capture'); }
});

// POST /mylist/close — {close:[ids], keep:[ids]}: the CLOSE section, one tap.
router.post('/mylist/close', guard, async (req, res) => {
  try { res.json(Object.assign({ ok: true }, await mylist.closeBatch(getPool(), req.user, req.body || {}))); }
  catch (e) { mylistFail(res, e, 'close'); }
});

// GET /mylist/stats
router.get('/mylist/stats', guard, async (req, res) => {
  try { res.json(await mylist.stats(getPool(), req.user)); }
  catch (e) { mylistFail(res, e, 'stats'); }
});

// GET/PATCH /mylist/settings — the mylist_* keys. No token or secret is ever stored here.
router.get('/mylist/settings', guard, async (req, res) => {
  try { res.json({ ok: true, settings: await mylist.getSettings(getPool()) }); }
  catch (e) { mylistFail(res, e, 'settings'); }
});
router.patch('/mylist/settings', guard, async (req, res) => {
  try {
    const body = req.body || {};
    for (const [k, v] of Object.entries(body)) await mylist.setSetting(getPool(), k, v, req.user.id);
    res.json({ ok: true, settings: await mylist.getSettings(getPool()) });
  } catch (e) { mylistFail(res, e, 'settings-patch'); }
});

module.exports = router;
module.exports.RAGS = RAGS;
