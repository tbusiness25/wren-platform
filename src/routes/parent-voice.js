'use strict';
/**
 * parent-voice.js — b356 (2026-09-24). Mounted at /api/parent-voice.
 *
 * Three parent-facing surfaces plus their management side. The public (unauthenticated) half —
 * asking a question from the website, and reading approved testimonials — lives in
 * public-voice.js instead, mounted pre-auth like public-availability.js.
 *
 *   ── ANONYMOUS FEEDBACK — genuinely anonymous, not the same guarantee as the existing
 *      parent_app_feedback (b129, "only we see it" but attributed by parent_email). This is the
 *      staff_voice_anonymous recipe (see src/routes/staff-voice.js header) applied to parents:
 *      the handler never reads req.user, the table has no identity column at all. ────────────
 *   POST /feedback                   { category?, body } — anonymous, rate-limited by session
 *
 *   ── THE QUESTION BOARD, current-parent side — also anonymous, same recipe ─────────────────
 *   GET  /questions                  open questions, ordered so arrival order can't be inferred
 *   POST /questions/:id/answer       { body } — anonymous; the handler never reads req.user
 *
 *   ── TESTIMONIALS — the opposite of anonymous: a family's own words, named ──────────────────
 *   GET  /testimonials/mine          my own submissions + status
 *   POST /testimonials               { display_name, body }
 *   PUT  /testimonials/:id/withdraw  take my own testimonial down (mine only)
 *
 *   ── COMMUNITY LINKS — WhatsApp group invites Toby sends by hand ────────────────────────────
 *   GET  /community-links            { baby_room_url, preschool_url } (settings-backed)
 *
 *   ── MANAGEMENT (a manager-tier role AND the Roost person allowlist) ────────────────────────
 *   GET  /inbox                      anonymous feedback queue
 *   PUT  /inbox/:id/status           new | read | actioned
 *   GET  /questions/admin            every question + its answers (text only — no author, ever)
 *   PUT  /questions/:id/status       open | hidden
 *   PUT  /answers/:id/status         visible | hidden
 *   GET  /testimonials/admin         every testimonial, any status
 *   PUT  /testimonials/:id/status    approved | declined
 *   PUT  /community-links            { baby_room_url?, preschool_url? }
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { isRoostAllowed } = require('../lib/roost-allowlist');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher'];
const isManager = req => Number(req.user.id) === 1 || hasRole(req.user, MANAGER_ROLES);
const managerOnly = async (req, res, next) => {
  const no = () => res.status(403).json({ error: 'Management access required' });
  if (!isManager(req)) return no();
  let ok;
  try { ok = await isRoostAllowed(req.user.id); } catch { ok = Number(req.user.id) === 1; }
  return ok ? next() : no();
};
const parentOnly = (req, res, next) =>
  (req.user && (req.user.role === 'parent' || req.user.aud === 'parents')) ? next() : res.status(403).json({ error: 'Parents only' });

const schemaMissing = e => e && (e.code === '42P01' || e.code === '42703');
function notApplied(res) {
  return res.status(503).json({ error: 'schema_not_applied', message: 'Apply migrations/2026-09-24b-b356-recognition-inspection-parent-voice.sql.' });
}
function fail(res, e, what) {
  if (schemaMissing(e)) return notApplied(res);
  console.error(`[parent-voice] ${what} failed:`, e && (e.code || 'error'));
  return res.status(500).json({ error: 'Something went wrong.' });
}
function cleanText(s, max) {
  const text = String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim();
  return { text, tooLong: text.length > max };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Anonymous feedback — the handler below must never read req.user. See staff-voice.js's
//  header comment for the full recipe this copies (session-HMAC rate limit, week-only
//  timestamp, actor-less audit row, response carries nothing back).
// ═════════════════════════════════════════════════════════════════════════════
const FEEDBACK_MAX = 4000;
const PER_SESSION = 3;
const MIN_GAP_MS = 20 * 1000;
const GLOBAL_PER_HOUR = 60;
const DAY_MS = 24 * 3600 * 1000;
const CATEGORIES = ['general', 'staff', 'facilities', 'food', 'communication'];

const _boot = crypto.randomBytes(32);
const _sessions = new Map();
let _global = [];
let _lastSweep = 0;
function sessionKey(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-wren-token'] || '');
  return crypto.createHmac('sha256', _boot).update(String(tok)).digest('base64url');
}
function sweep(now) {
  if (now - _lastSweep < 60000) return;
  _lastSweep = now;
  for (const [k, list] of _sessions) {
    const live = list.filter(t => now - t < DAY_MS);
    if (live.length) _sessions.set(k, live); else _sessions.delete(k);
  }
  _global = _global.filter(t => now - t < 3600000);
}
function gate(now) {
  sweep(now);
  if (_global.filter(t => now - t < 3600000).length >= GLOBAL_PER_HOUR)
    return { ok: false, message: 'Lots of messages are arriving at once — please try again shortly.' };
  return { ok: true };
}
function withinSession(key, now) {
  const mine = (_sessions.get(key) || []).filter(t => now - t < DAY_MS);
  if (mine.length && now - mine[mine.length - 1] < MIN_GAP_MS) return { ok: false, message: 'That has just gone — give it a minute before sending another.' };
  if (mine.length >= PER_SESSION) return { ok: false, message: `You have sent ${PER_SESSION} today. There is more to say? Sign in again tomorrow.` };
  return { ok: true };
}
function record(key, now) { const l = _sessions.get(key) || []; l.push(now); _sessions.set(key, l); _global.push(now); }

router.post('/feedback', parentOnly, async (req, res) => {
  const { text, tooLong } = cleanText(req.body && req.body.body, FEEDBACK_MAX);
  if (!text) return res.status(400).json({ error: 'empty', message: 'Write something first.' });
  if (tooLong) return res.status(400).json({ error: 'too_long', message: `That is over ${FEEDBACK_MAX} characters — please shorten it.` });
  const category = CATEGORIES.includes(req.body && req.body.category) ? req.body.category : null;
  const key = sessionKey(req);
  const now = Date.now();
  const g = gate(now); if (!g.ok) return res.status(429).json({ error: 'slow_down', message: g.message });
  const s = withinSession(key, now); if (!s.ok) return res.status(429).json({ error: 'slow_down', message: s.message });
  try {
    await getPool().query(
      `INSERT INTO parent_anonymous_feedback (category, body, received_week)
       VALUES ($1, $2, date_trunc('week', now() AT TIME ZONE 'Europe/London')::date)`, [category, text]);
    record(key, now);
    getPool().query(
      `INSERT INTO audit_log (occurred_at, actor_type, action, entity_type, meta)
       VALUES (date_trunc('day', now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London',
               'anonymous', 'create', 'parent_anonymous_feedback', '{"note":"anonymous parent feedback received"}'::jsonb)`
    ).catch(() => {});
    res.status(201).json({ ok: true });
  } catch (e) { fail(res, e, 'feedback'); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Question board, current-parent side — same anonymity recipe. POST /questions/:id/answer
//  must never read req.user.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/questions', parentOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT q.id, q.body, to_char(q.asked_week, 'YYYY-MM-DD') AS asked_week,
              (SELECT count(*)::int FROM parent_question_answers a WHERE a.question_id = q.id AND a.status = 'visible') AS answers
         FROM parent_questions q WHERE q.status IN ('open','answered')
        ORDER BY q.asked_week DESC, md5(q.id::text) LIMIT 100`);
    const { rows: answers } = await getPool().query(
      `SELECT question_id, body, to_char(answered_week,'YYYY-MM-DD') AS answered_week
         FROM parent_question_answers WHERE status = 'visible' AND question_id = ANY($1)
        ORDER BY md5(id::text)`, [rows.map(r => r.id)]);
    const byQ = new Map();
    for (const a of answers) { const l = byQ.get(a.question_id) || []; l.push(a); byQ.set(a.question_id, l); }
    res.json({ questions: rows.map(r => ({ ...r, answers: byQ.get(r.id) || [] })) });
  } catch (e) { fail(res, e, 'questions'); }
});

router.post('/questions/:id/answer', parentOnly, async (req, res) => {
  const qid = req.params.id;
  const { text, tooLong } = cleanText(req.body && req.body.body, 2000);
  if (!text) return res.status(400).json({ error: 'empty', message: 'Write an answer first.' });
  if (tooLong) return res.status(400).json({ error: 'too_long', message: 'That is over 2000 characters — please shorten it.' });
  try {
    const { rows: q } = await getPool().query(`SELECT id FROM parent_questions WHERE id = $1 AND status IN ('open','answered')`, [qid]);
    if (!q.length) return res.status(404).json({ error: 'not_found' });
    await getPool().query(
      `INSERT INTO parent_question_answers (question_id, body, answered_week)
       VALUES ($1, $2, date_trunc('week', now() AT TIME ZONE 'Europe/London')::date)`, [qid, text]);
    await getPool().query(`UPDATE parent_questions SET status = 'answered' WHERE id = $1 AND status = 'open'`, [qid]);
    res.status(201).json({ ok: true });
  } catch (e) { fail(res, e, 'answer'); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Testimonials — named, on purpose.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/testimonials/mine', parentOnly, async (req, res) => {
  const email = String(req.user.email || '').toLowerCase().trim();
  if (!email) return res.json({ items: [] });
  try {
    const { rows } = await getPool().query(
      `SELECT id, display_name, body, status, to_char(submitted_at,'YYYY-MM-DD') AS submitted_at
         FROM website_testimonials WHERE lower(parent_email) = $1 ORDER BY submitted_at DESC`, [email]);
    res.json({ items: rows });
  } catch (e) { fail(res, e, 'testimonials mine'); }
});

router.post('/testimonials', parentOnly, async (req, res) => {
  const { text: body, tooLong } = cleanText(req.body && req.body.body, 1500);
  const displayName = String((req.body && req.body.display_name) || '').trim().slice(0, 120);
  if (!displayName) return res.status(400).json({ error: 'bad_name', message: 'Add a name to show with your words (e.g. "Sarah, mum of Theo").' });
  if (!body) return res.status(400).json({ error: 'empty', message: 'Write something first.' });
  if (tooLong) return res.status(400).json({ error: 'too_long', message: 'That is over 1500 characters — please shorten it.' });
  const ownChildIds = Array.isArray(req.user.child_ids) && req.user.child_ids.length ? req.user.child_ids
    : (req.user.child_id != null ? [req.user.child_id] : []);
  const email = String(req.user.email || '').toLowerCase().trim() || null;
  try {
    const { rows } = await getPool().query(
      `INSERT INTO website_testimonials (child_id, parent_email, display_name, body)
       VALUES ($1,$2,$3,$4) RETURNING id, status`, [ownChildIds[0] || null, email, displayName, body]);
    res.status(201).json({ ok: true, id: rows[0].id, status: rows[0].status });
  } catch (e) { fail(res, e, 'testimonial create'); }
});

router.put('/testimonials/:id/withdraw', parentOnly, async (req, res) => {
  const id = Number(req.params.id);
  const email = String(req.user.email || '').toLowerCase().trim();
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  try {
    const { rows } = await getPool().query(
      `UPDATE website_testimonials SET status = 'withdrawn' WHERE id = $1 AND lower(parent_email) = $2 RETURNING id`,
      [id, email]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'withdraw'); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Community links — WhatsApp invites Toby sends by hand, shown in the parents app.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/community-links', parentOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT key, value FROM settings WHERE key IN ('parent_whatsapp_baby_room_url','parent_whatsapp_preschool_url')`);
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({
      baby_room_url: m.parent_whatsapp_baby_room_url || null,
      preschool_url: m.parent_whatsapp_preschool_url || null,
    });
  } catch (e) { fail(res, e, 'community links'); }
});

router.put('/community-links', managerOnly, async (req, res) => {
  const { baby_room_url, preschool_url } = req.body || {};
  const set = async (key, val) => getPool().query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
    [key, val == null ? null : String(val).slice(0, 500), req.user.id]);
  try {
    if (baby_room_url !== undefined) await set('parent_whatsapp_baby_room_url', baby_room_url);
    if (preschool_url !== undefined) await set('parent_whatsapp_preschool_url', preschool_url);
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'community links save'); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Management
// ═════════════════════════════════════════════════════════════════════════════
router.get('/inbox', managerOnly, async (req, res) => {
  const status = ['new', 'read', 'actioned'].includes(req.query.status) ? req.query.status : null;
  try {
    const { rows } = await getPool().query(
      `SELECT id, category, body, to_char(received_week,'YYYY-MM-DD') AS received_week, status
         FROM parent_anonymous_feedback WHERE ($1::text IS NULL OR status = $1)
        ORDER BY received_week DESC, md5(id::text) LIMIT 200`, [status]);
    res.json({ items: rows });
  } catch (e) { fail(res, e, 'inbox'); }
});
router.put('/inbox/:id/status', managerOnly, async (req, res) => {
  const status = req.body && req.body.status;
  if (!['new', 'read', 'actioned'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  try {
    const { rows } = await getPool().query(`UPDATE parent_anonymous_feedback SET status = $2 WHERE id = $1 RETURNING id, status`, [req.params.id, status]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { fail(res, e, 'inbox status'); }
});

// GET /questions/admin — text only, on both sides. There is no author column to select even by
// mistake — the moderator sees exactly what a family would see, plus the hidden ones.
router.get('/questions/admin', managerOnly, async (req, res) => {
  try {
    const { rows: qs } = await getPool().query(
      `SELECT id, body, status, to_char(asked_week,'YYYY-MM-DD') AS asked_week FROM parent_questions ORDER BY asked_week DESC`);
    const { rows: ans } = await getPool().query(
      `SELECT id, question_id, body, status, to_char(answered_week,'YYYY-MM-DD') AS answered_week FROM parent_question_answers ORDER BY answered_week DESC`);
    const byQ = new Map();
    for (const a of ans) { const l = byQ.get(a.question_id) || []; l.push(a); byQ.set(a.question_id, l); }
    res.json({ questions: qs.map(q => ({ ...q, answers: byQ.get(q.id) || [] })) });
  } catch (e) { fail(res, e, 'questions admin'); }
});
router.put('/questions/:id/status', managerOnly, async (req, res) => {
  const status = req.body && req.body.status;
  if (!['open', 'hidden'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  try {
    const { rows } = await getPool().query(`UPDATE parent_questions SET status = $2 WHERE id = $1 RETURNING id, status`, [req.params.id, status]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { fail(res, e, 'question status'); }
});
router.put('/answers/:id/status', managerOnly, async (req, res) => {
  const status = req.body && req.body.status;
  if (!['visible', 'hidden'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  try {
    const { rows } = await getPool().query(`UPDATE parent_question_answers SET status = $2 WHERE id = $1 RETURNING id, status`, [req.params.id, status]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { fail(res, e, 'answer status'); }
});

router.get('/testimonials/admin', managerOnly, async (req, res) => {
  const status = ['pending', 'approved', 'withdrawn', 'declined'].includes(req.query.status) ? req.query.status : null;
  try {
    const { rows } = await getPool().query(
      `SELECT id, display_name, body, status, to_char(submitted_at,'YYYY-MM-DD') AS submitted_at
         FROM website_testimonials WHERE ($1::text IS NULL OR status = $1)
        ORDER BY submitted_at DESC LIMIT 300`, [status]);
    res.json({ items: rows });
  } catch (e) { fail(res, e, 'testimonials admin'); }
});
router.put('/testimonials/:id/status', managerOnly, async (req, res) => {
  const status = req.body && req.body.status;
  if (!['approved', 'declined'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  try {
    const { rows } = await getPool().query(
      `UPDATE website_testimonials SET status = $2, approved_by = $3, approved_at = now() WHERE id = $1 RETURNING id, status`,
      [req.params.id, status, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { fail(res, e, 'testimonial status'); }
});

module.exports = router;
