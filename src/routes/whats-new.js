'use strict';
// whats-new.js — the "What's new" popup on every portal (2026-10-09).
//
// Toby: "start doing changelog popups". ONE store: ladn.wren_updates, the same rows the Roost
// "What's new in Wren" page lists (src/routes/wren-updates.js), plus two columns —
// `audiences` (admin | staff | parents) and `popup`. Each portal asks for the newest popup
// meant for it that this person hasn't dismissed yet; "Got it" records that once
// (wren_update_popups_seen). Nothing here sends anything anywhere.
//
//   /api/whats-new               staff portals (Roost = admin, EY/HR = staff), staff JWT
//   /welcome/whats-new/api       Parents app, behind the verified parent session
//
// Bodies use the wren-update-render conventions (## heading {live|soon}, "- " bullets,
// **bold**), rendered server-side, so nothing typed can inject markup.
const express = require('express');
const crypto  = require('crypto');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { renderUpdate } = require('../lib/wren-update-render');
const { parentEmailOf } = require('../lib/parent-identity');

const WINDOW_DAYS = 45;   // an update older than this never pops up for someone new

// b488 (L11) — audiences is now matched by OVERLAP against a list, not
// equality against one tag. HR and EY used to both resolve to the single
// 'staff' tag (see staffAudience below), so a tablet-only announcement (EyLog
// diary, phonics lessons) popped up on HR same as EY. audiences param is now
// an array of tags this reader's portal accepts.
async function latestFor(db, audiences, readerKey) {
  const { rows } = await db.query(`
    SELECT u.id, u.title, u.summary, u.body, u.published_at
      FROM wren_updates u
     WHERE COALESCE(u.popup, false) AND u.archived_at IS NULL
       AND u.published_at IS NOT NULL AND u.published_at <= now()
       AND u.published_at > now() - make_interval(days => $3)
       AND COALESCE(u.audiences, '{admin}'::text[]) && $1::text[]
       AND NOT EXISTS (SELECT 1 FROM wren_update_popups_seen s
                        WHERE s.update_id = u.id AND s.reader_key = $2)
     ORDER BY u.published_at DESC, u.id DESC
     LIMIT 1`, [audiences, readerKey, WINDOW_DAYS]);
  const u = rows[0];
  if (!u) return null;
  return { id: u.id, title: u.title, summary: u.summary || '', html: renderUpdate(u.body || ''), published_at: u.published_at };
}

async function markSeen(db, id, readerKey) {
  await db.query(
    `INSERT INTO wren_update_popups_seen (update_id, reader_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, readerKey]);
}

// ── staff portals ─────────────────────────────────────────────────────────────
const staffRouter = express.Router();
staffRouter.use(authenticate);
// b488 (L11) — was a single tag ('admin' vs 'staff'), which put HR and the EY
// tablet in the exact same bucket. Each portal now accepts the generic
// 'staff' tag (so nothing published before this fix stops showing anywhere)
// PLUS a tag of its own, so a new update can be scoped to just one of them.
const staffAudience = req => (
  req._portal === 'admin' ? ['admin'] :
  req._portal === 'hr'    ? ['staff', 'hr'] :
                             ['staff', 'tablet']
);
const staffKey = req => `staff:${Number(req.user && req.user.id) || 0}`;

staffRouter.get('/popup', async (req, res) => {
  try {
    if (!req.user || !req.user.id) return res.json({ update: null });
    res.json({ update: await latestFor(getPool(), staffAudience(req), staffKey(req)), audience: staffAudience(req) });
  } catch (e) {
    // A table that isn't migrated yet is "nothing to show", not an error screen.
    if (e.code === '42P01' || e.code === '42703') return res.json({ update: null });
    console.error('[whats-new] popup:', e.message); res.status(500).json({ error: 'Internal error' });
  }
});
staffRouter.post('/:id/seen', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || !req.user || !req.user.id) return res.status(400).json({ error: 'Bad request' });
  try { await markSeen(getPool(), id, staffKey(req)); res.json({ ok: true }); }
  catch (e) { console.error('[whats-new] seen:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// ── Parents app ───────────────────────────────────────────────────────────────
// Mounted under /welcome/whats-new/api, where the verified parent session has already run.
// The reader is keyed by a hash of the parent's email — the address itself is never stored here.
const parentRouter = express.Router();
parentRouter.use(express.json({ limit: '2kb' }));
parentRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const parentKey = req => {
  const email = String(parentEmailOf(req) || '').trim().toLowerCase();
  return email ? 'parent:' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 32) : null;
};
parentRouter.get('/popup', async (req, res) => {
  const key = parentKey(req);
  if (!key) return res.json({ update: null });
  try { res.json({ update: await latestFor(getPool(), ['parents'], key) }); }
  catch (e) {
    if (e.code === '42P01' || e.code === '42703') return res.json({ update: null });
    console.error('[whats-new] parent popup:', e.message); res.status(500).json({ error: 'Internal error' });
  }
});
parentRouter.post('/:id/seen', async (req, res) => {
  const key = parentKey(req);
  const id = parseInt(req.params.id, 10);
  if (!key || !id) return res.status(400).json({ error: 'Bad request' });
  try { await markSeen(getPool(), id, key); res.json({ ok: true }); }
  catch (e) { console.error('[whats-new] parent seen:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

module.exports = { staffRouter, parentRouter };
