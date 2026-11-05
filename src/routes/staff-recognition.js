'use strict';
/**
 * staff-recognition.js — b356 (2026-09-24). Mounted at /api/staff-recognition.
 *
 * "Say thank you to the team" — a parent names a staff member and says what they did.
 * NEVER anonymous to management: every row carries a staff_id and (where available) a
 * child_id, so the review queue always shows who said what about whom. Goes to management
 * first (status='pending'); once released it counts toward the staff member's own total and
 * feeds their HR profile + supervision evidence.
 *
 * ⛔ NO PAYMENT MECHANISM. This file has no route, column or query that turns a count into an
 * amount. See wren-docs/analysis/2026-09-24-staff-recognition-and-bonuses.md before that is
 * ever considered — Toby asked for that research explicitly before any money is wired.
 *
 *   ── a parent (parents portal) ──────────────────────────────────────────────────────────────
 *   GET  /prompts                    the suggested prompts for the composer
 *   POST /                           { staff_id, prompt_key, body } — creates a 'pending' row
 *
 *   ── a member of staff, about THEMSELVES ────────────────────────────────────────────────────
 *   GET  /mine                       my released recognitions + my count this term/all-time
 *
 *   ── management (a manager-tier role AND the Roost person allowlist — see managerOnly) ──────
 *   GET  /inbox                      pending recognitions awaiting review
 *   PUT  /inbox/:id/status           release | decline
 *   GET  /staff/:id                  one member of staff's released recognitions + count — for
 *                                    the Roost profile card and supervision evidence
 *   GET  /staff/:id/evidence         compact summary for supervisions.js to pull in (count since
 *                                    a given date + up to 3 recent quotes) — read-only, no write
 */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { isRoostAllowed } = require('../lib/roost-allowlist');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const BODY_MAX = 1500;
const STATUSES = ['pending', 'released', 'declined'];
const PROMPTS = [
  { key: 'went_out_of_way', label: 'Did someone go out of their way this week?' },
  { key: 'settled_child',   label: 'Did someone help your child settle or feel safe?' },
  { key: 'made_you_smile',  label: 'Did someone do something small that made your day?' },
  { key: 'other',           label: 'Something else you want to say' },
];

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher'];
const isManager = req => Number(req.user.id) === 1 || hasRole(req.user, MANAGER_ROLES);
const managerOnly = async (req, res, next) => {
  const no = () => res.status(403).json({ error: 'Management access required' });
  if (!isManager(req)) return no();
  let ok;
  try { ok = await isRoostAllowed(req.user.id); } catch { ok = Number(req.user.id) === 1; }
  return ok ? next() : no();
};

// A migration that has not been applied reads as "not applied", not as a 500.
const schemaMissing = e => e && (e.code === '42P01' || e.code === '42703');
function notApplied(res) {
  return res.status(503).json({
    error: 'schema_not_applied',
    message: 'The staff recognition table is not present. Apply migrations/2026-09-24b-b356-recognition-inspection-parent-voice.sql.',
  });
}
function fail(res, e, what) {
  if (schemaMissing(e)) return notApplied(res);
  console.error(`[staff-recognition] ${what} failed:`, e && (e.code || 'error'));
  return res.status(500).json({ error: 'Something went wrong.' });
}

function cleanBody(s) {
  const text = String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim();
  return text;
}

// GET /prompts — the composer's suggested prompts. A blank box gets nothing (Toby's brief).
router.get('/prompts', (req, res) => res.json({ prompts: PROMPTS }));

// GET /staff-list — the composer's "who do you want to thank" picker. Deliberately minimal
// (id, first name, last initial, room) — no email, DOB, role detail or anything else a parent
// has no reason to see.
//
// b405 (2026-10-06): every active member of staff still appears (a parent may reasonably want
// to thank the cook, or someone outside their child's room) — but the child's own key person,
// then their room, are sorted to the top rather than leaving a flat alphabetical list the
// parent has to hunt through, matching the room-scoping already used by GET
// /child/:childId/meet-the-team. req.user.child_id comes from the parent JWT (same claim
// childGuard elsewhere trusts); falls back to a plain alphabetical list if it's absent.
router.get('/staff-list', async (req, res) => {
  try {
    const childId = Number(req.user && req.user.child_id) || null;
    const { rows } = await getPool().query(`
      SELECT s.id, s.first_name, left(coalesce(s.last_name,''), 1) AS last_initial, r.name AS room_name
        FROM staff s
        LEFT JOIN rooms r ON r.id = s.room_id
        LEFT JOIN children c ON c.id = $1
       WHERE s.is_active IS NOT FALSE
       ORDER BY (s.id = c.key_person_id) DESC, (s.room_id = c.room_id) DESC, s.first_name`,
      [childId]);
    res.json({ staff: rows });
  } catch (e) { fail(res, e, 'staff-list'); }
});

// POST / — a parent thanks a named staff member. Not anonymous: child_id (from the parent's own
// token) travels with the row so management always knows which family said it.
router.post('/', async (req, res) => {
  if (req.user.role !== 'parent') return res.status(403).json({ error: 'Parents only' });
  const db = getPool();
  const staffId = Number(req.body && req.body.staff_id);
  const promptKey = PROMPTS.some(p => p.key === (req.body && req.body.prompt_key)) ? req.body.prompt_key : null;
  const body = cleanBody(req.body && req.body.body);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'bad_staff', message: 'Choose who you want to thank.' });
  if (!body) return res.status(400).json({ error: 'empty', message: 'Say a little about what they did.' });
  if (body.length > BODY_MAX) return res.status(400).json({ error: 'too_long', message: `That is over ${BODY_MAX} characters — please shorten it.` });
  try {
    const { rows: st } = await db.query('SELECT id FROM staff WHERE id = $1 AND is_active IS NOT FALSE', [staffId]);
    if (!st.length) return res.status(404).json({ error: 'not_found', message: 'That person is not on the current staff list.' });
    const ownChildIds = Array.isArray(req.user.child_ids) && req.user.child_ids.length ? req.user.child_ids
      : (req.user.child_id != null ? [req.user.child_id] : []);
    const childId = ownChildIds.length ? ownChildIds[0] : null;
    const { rows } = await db.query(
      `INSERT INTO staff_recognition (staff_id, child_id, prompt_key, body)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [staffId, childId, promptKey, body]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { fail(res, e, 'create'); }
});

// GET /mine — a member of staff's own released recognitions + their count.
router.get('/mine', async (req, res) => {
  if (req.user.role === 'parent') return res.status(403).json({ error: 'Staff only' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id, prompt_key, body, to_char(created_at, 'YYYY-MM-DD') AS created_at
         FROM staff_recognition WHERE staff_id = $1 AND status = 'released'
        ORDER BY created_at DESC LIMIT 100`, [req.user.id]);
    res.json({ count: rows.length, items: rows });
  } catch (e) { fail(res, e, 'mine'); }
});

// GET /inbox — pending recognitions awaiting review.
router.get('/inbox', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT r.id, r.staff_id, btrim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) AS staff_name,
              r.prompt_key, r.body, r.child_id,
              btrim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) AS child_name,
              to_char(r.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
         FROM staff_recognition r
         JOIN staff s ON s.id = r.staff_id
         LEFT JOIN children c ON c.id = r.child_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at LIMIT 200`);
    res.json({ items: rows });
  } catch (e) { fail(res, e, 'inbox'); }
});

// PUT /inbox/:id/status — release or decline. Never edits the parent's words.
router.put('/inbox/:id/status', managerOnly, async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body && req.body.status;
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  if (!['released', 'declined'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  try {
    const { rows } = await getPool().query(
      `UPDATE staff_recognition SET status = $2, reviewed_by = $3, reviewed_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING id, status`,
      [id, status, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { fail(res, e, 'review'); }
});

// GET /staff/:id — one person's released recognitions, for the Roost profile card.
router.get('/staff/:id', managerOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  try {
    const { rows } = await getPool().query(
      `SELECT id, prompt_key, body, to_char(created_at, 'YYYY-MM-DD') AS created_at
         FROM staff_recognition WHERE staff_id = $1 AND status = 'released'
        ORDER BY created_at DESC LIMIT 200`, [id]);
    res.json({ staff_id: id, count: rows.length, items: rows });
  } catch (e) { fail(res, e, 'staff summary'); }
});

// GET /staff/:id/evidence?since=YYYY-MM-DD — compact card for supervisions.js to pull in.
// Read-only; supervisions.js is not modified by this build — this endpoint is ready for it to
// call, documented in the b356 NOTES as a follow-up wire-up rather than done in this pass.
router.get('/staff/:id/evidence', managerOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || '') ? req.query.since : '1900-01-01';
  try {
    const { rows } = await getPool().query(
      `SELECT id, body, to_char(created_at, 'YYYY-MM-DD') AS created_at
         FROM staff_recognition
        WHERE staff_id = $1 AND status = 'released' AND created_at >= $2::date
        ORDER BY created_at DESC LIMIT 3`, [id, since]);
    const { rows: c } = await getPool().query(
      `SELECT count(*)::int AS n FROM staff_recognition WHERE staff_id = $1 AND status = 'released' AND created_at >= $2::date`,
      [id, since]);
    res.json({ staff_id: id, since, count: c[0].n, recent_quotes: rows.map(r => ({ body: r.body, date: r.created_at })) });
  } catch (e) { fail(res, e, 'evidence'); }
});

module.exports = router;
