'use strict';
/**
 * staff-voice.js — b345 (2026-09-21). Mounted at /api/staff-voice.
 *
 * What a practitioner is good at, what they can help others with, what they need, what they'd
 * change — plus a box for saying something to management with no name on it.
 *
 *   ── a practitioner (any member of staff), about THEMSELVES — named ─────────────────────────
 *   GET    /mine                     my entries by kind, my soft-deleted ones, rooms, my room
 *   GET    /mine/history             my own create / edit / delete trail (owner only)
 *   GET    /tags                     suggestions for the tag box — from what the setting recognises
 *   POST   /entries                  { kind, body, tags[], for_supervision, from_room_id, about_room_id }
 *   PUT    /entries/:id              edit MY entry (kind never changes)
 *   DELETE /entries/:id              soft delete MY entry;  ?forever=1 only on one already deleted
 *   POST   /entries/:id/restore      undo my own delete
 *
 *   ── anyone signed in, ANONYMOUS ────────────────────────────────────────────────────────────
 *   POST   /speak-up                 { body } — see the block below; nothing that identifies the writer
 *
 *   ── management (a manager-tier role AND the Roost person allowlist — see managerOnly) ──────
 *   GET    /inbox                    the anonymous comments (body + week received, nothing else)
 *   PUT    /inbox/:id/status         new | read | actioned
 *   GET    /named                    named entries across staff, filterable — the Roost list
 *   GET    /staff/:id                one member of staff's entries — the read-only Roost profile card
 *
 * ── A MANAGER CANNOT EDIT WHAT A PRACTITIONER WROTE ─────────────────────────────────────────
 * Every write path above takes the owner from the LOGIN TOKEN (req.user.id). None has a staff_id
 * parameter, and every UPDATE / DELETE is `WHERE id = $1 AND staff_id = <token owner>`, so a
 * manager who PUTs somebody else's entry id gets a 404, exactly as if it did not exist. The
 * management endpoints are all GET (plus the inbox status flag, which touches no writing).
 * A "view as" token is refused every write upstream in middleware/auth.js.
 *
 * ── ANONYMOUS MEANS ANONYMOUS ───────────────────────────────────────────────────────────────
 * The obvious way to build this — a table with a nullable staff_id and a "hide it" flag — is not
 * anonymous, it is confidential, and a small team knows the difference. What is done instead:
 *
 *   1. The table (staff_voice_anonymous) has four columns: id (random uuid), body, received_week
 *      (the MONDAY of the week — never a timestamp), status. No staff_id, no hash of one, no ip,
 *      no user agent, no session key, no device. scripts/b345-verify.js asserts exactly that.
 *   2. The route is authenticated (only staff may post; an open endpoint would be a spam hose)
 *      but its handler NEVER READS req.user. It reads req.headers.authorization exactly once, to
 *      derive an in-memory rate-limit key, and nothing else.
 *   3. THREE things elsewhere in the platform would have written the caller's staff id next to
 *      this request, and each is switched off for this path and this path only:
 *        • src/utils/request-audit.js — every authenticated request lands in audit_log with
 *          actor_id, ip, user agent and a millisecond timestamp. /api/staff-voice/speak-up is on
 *          its SKIP list. (The manager's reads of /inbox are NOT skipped — a manager reading is
 *          not what needs protecting, and "who read the comments" is a fair question to be able
 *          to answer.)
 *        • the client click beacon (wren-core.js / wren-shell-v2.js → POST /api/audit/beacon)
 *          records the LABEL of every button pressed against the signed-in person. The anonymous
 *          card carries data-no-audit and both beacons honour it.
 *        • the EY device gate, which would otherwise demand a device token (an identity) before
 *          letting the request reach this file. Exempted in server-unified.js.
 *      What the audit trail DOES get is the brief's "that a submission happened, and when": one
 *      row written by this handler itself — actor_type 'anonymous', no actor, no ip, no user
 *      agent — stamped to the DAY, not the millisecond. A millisecond timestamp next to the
 *      writer's other requests is exactly the join that un-anonymises; a date is not.
 *      (Residual: audit_log.id is a serial, so somebody with raw database access can still see
 *      which rows were written around it. That is the same class of access as reading the
 *      table directly, and is called out in the NOTES rather than pretended away.)
 *   4. Rate-limited by SESSION, not by identity: an HMAC of the bearer token under a key that is
 *      generated at boot, held only in memory, and never written anywhere. Nothing persisted can
 *      be turned back into a person. The price, accepted in the brief: a determined person can log
 *      in again and post again, and a restart clears the counters.
 *   5. The 201 answers { ok: true } and nothing else — no id, so there is nothing to link back to,
 *      nothing to edit later and nothing to be asked for.
 *
 * What this cannot do, and the screen says so: it cannot stop somebody being recognised by WHAT they
 * write, and edge logs outside this app (nginx access logs, Cloudflare) are not this file's to
 * control — see the NOTES for the one-line nginx change that closes the first of those.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { isRoostAllowed } = require('../lib/roost-allowlist');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

// A parent token cannot reach this on the parents portal (PARENT_DENY) and its audience is wrong
// everywhere else, but the router says so itself: an opinion about how the nursery is run is staff's.
router.use((req, res, next) =>
  req.user && req.user.role === 'parent' ? res.status(403).json({ error: 'Staff only' }) : next());

// Who may READ what staff wrote — a manager-tier role AND the Roost person allowlist.
//
// Role alone is not enough here. Toby's b126 decision (2026-07-21) was that Roost is a PERSON
// allowlist (ladn.settings 'roost_admin_staff_ids', today Toby and the office manager) precisely because a role
// check treats every deputy_manager as manager-equivalent everywhere — and the anonymous box is the
// one place where that matters most: a comment about the deputy must not be readable by the deputy
// by calling the API directly when the Roost screen for it is closed to them. The role test stays
// as well, because isRoostAllowed() fails OPEN on a schema that has no such setting (the demo and
// school editions), and on those it would otherwise let a practitioner in.
// (Same role list, and for the same reason, as src/routes/consultation.js.)
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher'];
const isManager = req => Number(req.user.id) === 1 || hasRole(req.user, MANAGER_ROLES);
const managerOnly = async (req, res, next) => {
  const no = () => res.status(403).json({ error: 'Management access required' });
  if (!isManager(req)) return no();
  let ok;
  try { ok = await isRoostAllowed(req.user.id); } catch { ok = Number(req.user.id) === 1; }
  return ok ? next() : no();
};

const KINDS = ['strength', 'can_help', 'needs_support', 'would_change'];
const BODY_MAX = 2000;
const ANON_MAX = 4000;
const TAG_MAX = 40;
const TAGS_MAX = 8;

// A migration that has not been applied reads as "not applied", not as a 500.
const schemaMissing = e => e && (e.code === '42P01' || e.code === '42703');
function notApplied(res) {
  return res.status(503).json({
    error: 'schema_not_applied',
    message: 'The staff voice tables are not present. Apply migrations/2026-09-21-b345-staff-voice.sql.',
  });
}
function fail(res, e, what) {
  if (schemaMissing(e)) return notApplied(res);
  // Only the code — never e.message. A constraint violation's message quotes the failing row.
  console.error(`[staff-voice] ${what} failed:`, e && (e.code || 'error'));
  return res.status(500).json({ error: 'Something went wrong.' });
}

// ── input cleaning ───────────────────────────────────────────────────────────
function cleanText(s, max) {
  if (s == null) return { text: '' };
  const text = String(s).replace(/ /g, '').replace(/\r\n?/g, '\n').trim();
  return text.length > max ? { text, tooLong: true } : { text };
}
function cleanTags(input) {
  const arr = Array.isArray(input) ? input : [];
  const seen = new Set(); const out = [];
  for (const raw of arr) {
    const t = String(raw == null ? '' : raw).replace(/ /g, '').replace(/\s+/g, ' ').trim().slice(0, TAG_MAX);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
  }
  return out;
}
const roomIdOrNull = v => (v === '' || v == null ? null : (Number.isInteger(Number(v)) ? Number(v) : NaN));

/** Validate an entry payload against its kind. Returns { error } or the normalised fields. */
async function normaliseEntry(db, kind, b) {
  const { text, tooLong } = cleanText(b.body, BODY_MAX);
  if (!text) return { error: 'empty', message: 'Write something first.' };
  if (tooLong) return { error: 'too_long', message: `That is over ${BODY_MAX} characters — please shorten it.` };
  const tags = cleanTags(b.tags);
  if (tags.length > TAGS_MAX) return { error: 'too_many_tags', message: `Up to ${TAGS_MAX} tags, please.` };
  const f = { body: text, tags, for_supervision: false, from_room_id: null, about_room_id: null };
  if (kind === 'needs_support') f.for_supervision = b.for_supervision === true || b.for_supervision === 'true';
  if (kind === 'would_change') {
    f.from_room_id = roomIdOrNull(b.from_room_id);
    f.about_room_id = roomIdOrNull(b.about_room_id);
    for (const id of [f.from_room_id, f.about_room_id]) {
      if (id === null) continue;
      if (Number.isNaN(id)) return { error: 'bad_room', message: 'That room is not on the list.' };
      const { rows } = await db.query('SELECT 1 FROM rooms WHERE id = $1', [id]);
      if (!rows.length) return { error: 'bad_room', message: 'That room is not on the list.' };
    }
  }
  return f;
}

const ENTRY_COLS = `id, kind, body, tags, for_supervision, from_room_id, about_room_id,
                    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
                    to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`;

// ═════════════════════════════════════════════════════════════════════════════
//  A practitioner, about themselves — NAMED
// ═════════════════════════════════════════════════════════════════════════════

// GET /mine — everything the HR profile section needs, in one call.
router.get('/mine', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT ${ENTRY_COLS} FROM staff_voice_entries
        WHERE staff_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`, [req.user.id]);
    const { rows: gone } = await db.query(
      `SELECT ${ENTRY_COLS}, to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS deleted_at
         FROM staff_voice_entries WHERE staff_id = $1 AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC LIMIT 30`, [req.user.id]);
    const { rows: rooms } = await db.query('SELECT id, name FROM rooms ORDER BY id');
    const { rows: me } = await db.query('SELECT room_id FROM staff WHERE id = $1', [req.user.id]);
    const entries = Object.fromEntries(KINDS.map(k => [k, []]));
    for (const r of rows) entries[r.kind].push(r);
    res.json({ entries, deleted: gone, rooms, my_room_id: me[0] ? me[0].room_id : null });
  } catch (e) { fail(res, e, 'mine'); }
});

// GET /mine/history — the owner's own trail. No manager endpoint reads this table.
router.get('/mine/history', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id, entry_id, kind, action, body_before, body_after,
              to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
         FROM staff_voice_history WHERE staff_id = $1 ORDER BY at DESC, id DESC LIMIT 60`, [req.user.id]);
    res.json({ history: rows });
  } catch (e) { fail(res, e, 'history'); }
});

// GET /tags — suggestions only, from what the setting already recognises. Deliberately NOT built
// from what other staff typed: a rare tag would point straight at its author.
const EYFS_AREAS = ['Communication & Language', 'Personal, Social & Emotional Development', 'Physical Development',
  'Literacy', 'Mathematics', 'Understanding the World', 'Expressive Arts & Design'];
const COURSE_LABELS = { send: 'SEND', 'family-engagement': 'Family engagement', pedagogy: 'Pedagogy',
  safeguarding: 'Safeguarding', welfare: 'Welfare', leadership: 'Leadership', development: 'Professional development' };
router.get('/tags', async (req, res) => {
  const db = getPool();
  const groups = [];
  const add = (label, tags) => { const t = [...new Set(tags.filter(Boolean))]; if (t.length) groups.push({ label, tags: t }); };
  try {
    const topics = await db.query('SELECT label FROM knowledge_topics WHERE active ORDER BY sort_order, label').catch(() => ({ rows: [] }));
    add('Knowledge areas', topics.rows.map(r => r.label));
    add('Areas of learning', EYFS_AREAS);
    const cats = await db.query(
      `SELECT DISTINCT category FROM courses WHERE category = ANY($1) ORDER BY category`,
      [Object.keys(COURSE_LABELS)]).catch(() => ({ rows: [] }));
    add('Training themes', cats.rows.map(r => COURSE_LABELS[r.category]));
    const rooms = await db.query('SELECT name FROM rooms ORDER BY id').catch(() => ({ rows: [] }));
    add('Rooms', rooms.rows.map(r => r.name));
    res.json({ groups });
  } catch (e) { fail(res, e, 'tags'); }
});

// POST /entries
router.post('/entries', async (req, res) => {
  const db = getPool();
  const kind = req.body && req.body.kind;
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'bad_kind', message: 'Unknown section.' });
  try {
    const f = await normaliseEntry(db, kind, req.body);
    if (f.error) return res.status(400).json(f);
    const { rows } = await db.query(
      `WITH e AS (
         INSERT INTO staff_voice_entries (staff_id, kind, body, tags, for_supervision, from_room_id, about_room_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *),
       h AS (
         INSERT INTO staff_voice_history (staff_id, entry_id, kind, action, body_after)
         SELECT staff_id, id, kind, 'created', body FROM e)
       SELECT ${ENTRY_COLS} FROM e`,
      [req.user.id, kind, f.body, f.tags, f.for_supervision, f.from_room_id, f.about_room_id]);
    res.status(201).json({ entry: rows[0] });
  } catch (e) { fail(res, e, 'create'); }
});

// PUT /entries/:id — mine only; a manager gets the same 404 as for an id that does not exist.
router.put('/entries/:id', async (req, res) => {
  const db = getPool();
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  try {
    const { rows: cur } = await db.query(
      `SELECT * FROM staff_voice_entries WHERE id = $1 AND staff_id = $2 AND deleted_at IS NULL`, [id, req.user.id]);
    if (!cur.length) return res.status(404).json({ error: 'not_found' });
    const old = cur[0];
    const f = await normaliseEntry(db, old.kind, req.body || {});
    if (f.error) return res.status(400).json(f);
    const same = f.body === old.body && f.for_supervision === old.for_supervision
      && f.from_room_id === old.from_room_id && f.about_room_id === old.about_room_id
      && JSON.stringify(f.tags) === JSON.stringify(old.tags);
    if (same) return res.json({ entry: (await db.query(`SELECT ${ENTRY_COLS} FROM staff_voice_entries WHERE id = $1`, [id])).rows[0], changed: false });
    const { rows } = await db.query(
      `WITH upd AS (
         UPDATE staff_voice_entries SET body=$3, tags=$4, for_supervision=$5, from_room_id=$6, about_room_id=$7, updated_at=now()
          WHERE id=$1 AND staff_id=$2 AND deleted_at IS NULL RETURNING *),
       h AS (
         INSERT INTO staff_voice_history (staff_id, entry_id, kind, action, body_before, body_after)
         SELECT staff_id, id, kind, 'edited', $8, body FROM upd)
       SELECT ${ENTRY_COLS} FROM upd`,
      [id, req.user.id, f.body, f.tags, f.for_supervision, f.from_room_id, f.about_room_id, old.body]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ entry: rows[0], changed: true });
  } catch (e) { fail(res, e, 'edit'); }
});

// DELETE /entries/:id — soft. ?forever=1 is allowed only on an entry that is already deleted, so
// erasing anything takes two deliberate steps and can never be an accident of one tap.
router.delete('/entries/:id', async (req, res) => {
  const db = getPool();
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  try {
    if (req.query.forever === '1') {
      const { rows } = await db.query(
        `WITH d AS (DELETE FROM staff_voice_entries WHERE id=$1 AND staff_id=$2 AND deleted_at IS NOT NULL RETURNING id, staff_id, kind),
              s AS (UPDATE staff_voice_history SET body_before = NULL, body_after = NULL
                     WHERE staff_id = $2 AND entry_id IN (SELECT id FROM d)),
              h AS (INSERT INTO staff_voice_history (staff_id, entry_id, kind, action) SELECT staff_id, id, kind, 'erased' FROM d)
         SELECT id FROM d`, [id, req.user.id]);
      if (!rows.length) return res.status(404).json({ error: 'not_found', message: 'Only something you have already deleted can be erased for good.' });
      return res.json({ ok: true, erased: true });
    }
    const { rows } = await db.query(
      `WITH d AS (UPDATE staff_voice_entries SET deleted_at = now() WHERE id=$1 AND staff_id=$2 AND deleted_at IS NULL RETURNING *),
            h AS (INSERT INTO staff_voice_history (staff_id, entry_id, kind, action, body_before) SELECT staff_id, id, kind, 'deleted', body FROM d)
       SELECT id FROM d`, [id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'delete'); }
});

// POST /entries/:id/restore
router.post('/entries/:id/restore', async (req, res) => {
  const db = getPool();
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  try {
    const { rows } = await db.query(
      `WITH r AS (UPDATE staff_voice_entries SET deleted_at = NULL, updated_at = now() WHERE id=$1 AND staff_id=$2 AND deleted_at IS NOT NULL RETURNING *),
            h AS (INSERT INTO staff_voice_history (staff_id, entry_id, kind, action, body_after) SELECT staff_id, id, kind, 'restored', body FROM r)
       SELECT ${ENTRY_COLS} FROM r`, [id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ entry: rows[0] });
  } catch (e) { fail(res, e, 'restore'); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Anonymous — POST /speak-up
//  The handler below must never read req.user. Read the header comment before changing it.
// ═════════════════════════════════════════════════════════════════════════════
const SPEAKUP_PER_SESSION = 3;            // per rolling 24h, per login session
const SPEAKUP_MIN_GAP_MS = 20 * 1000;     // between two from one session
const SPEAKUP_GLOBAL_PER_HOUR = 40;       // across everybody — a hose guard, not a fairness rule
const DAY_MS = 24 * 3600 * 1000;

// Generated at boot, never written anywhere, gone on restart. A key that exists only in memory
// cannot be used to turn a stored value back into a person — and there is no stored value anyway.
const _boot = crypto.randomBytes(32);
const _sessions = new Map();              // HMAC(token) -> [epoch ms, …]
let _global = [];
let _lastSweep = 0;

function sessionKey(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-wren-token'] || '');
  return crypto.createHmac('sha256', _boot).update(String(tok)).digest('base64url');
}
function sweep(now) {
  if (now - _lastSweep < 60 * 1000) return;
  _lastSweep = now;
  for (const [k, list] of _sessions) {
    const live = list.filter(t => now - t < DAY_MS);
    if (live.length) _sessions.set(k, live); else _sessions.delete(k);
  }
  _global = _global.filter(t => now - t < 3600 * 1000);
}
function speakUpGate(key, now) {
  sweep(now);
  const mine = (_sessions.get(key) || []).filter(t => now - t < DAY_MS);
  if (_global.filter(t => now - t < 3600 * 1000).length >= SPEAKUP_GLOBAL_PER_HOUR)
    return { ok: false, message: 'Lots of comments are arriving at once — please try again in a little while.' };
  if (mine.length && now - mine[mine.length - 1] < SPEAKUP_MIN_GAP_MS)
    return { ok: false, message: 'That one has just gone — give it a minute before sending another.' };
  if (mine.length >= SPEAKUP_PER_SESSION)
    return { ok: false, message: `You have sent ${SPEAKUP_PER_SESSION} today. If there is more to say, sign in again tomorrow, or talk to a manager.` };
  return { ok: true };
}
function speakUpRecord(key, now) {
  const list = _sessions.get(key) || [];
  list.push(now); _sessions.set(key, list); _global.push(now);
}

router.post('/speak-up', async (req, res) => {
  const { text, tooLong } = cleanText(req.body && req.body.body, ANON_MAX);
  if (!text) return res.status(400).json({ error: 'empty', message: 'Write something first.' });
  if (tooLong) return res.status(400).json({ error: 'too_long', message: `That is over ${ANON_MAX} characters — please shorten it.` });
  const key = sessionKey(req);
  const now = Date.now();
  const gate = speakUpGate(key, now);
  if (!gate.ok) return res.status(429).json({ error: 'slow_down', message: gate.message });
  try {
    await getPool().query(
      `INSERT INTO staff_voice_anonymous (body, received_week)
       VALUES ($1, date_trunc('week', now() AT TIME ZONE 'Europe/London')::date)`, [text]);
    speakUpRecord(key, now);     // counted only once it has really been stored
    // The audit trail: that it happened, and the DAY it happened. No actor, no ip, no user agent.
    // Written here rather than by src/utils/audit.js's recordAudit, which would stamp the caller.
    getPool().query(
      `INSERT INTO audit_log (occurred_at, actor_type, action, entity_type, meta)
       VALUES (date_trunc('day', now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London',
               'anonymous', 'create', 'staff_voice_anonymous', '{"note":"anonymous comment received"}'::jsonb)`
    ).catch(() => { /* the comment is what matters; a missing audit line must not lose it */ });
    res.status(201).json({ ok: true });
  } catch (e) { fail(res, e, 'speak-up'); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Management
// ═════════════════════════════════════════════════════════════════════════════
const STATUSES = ['new', 'read', 'actioned'];
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /inbox — body and the week it arrived. That is the whole row, and the row is all there is.
router.get('/inbox', managerOnly, async (req, res) => {
  const db = getPool();
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  try {
    // Ordered by week, then by a hash of the id — never by anything that reflects arrival order.
    const { rows } = await db.query(
      `SELECT id, body, to_char(received_week, 'YYYY-MM-DD') AS received_week, status
         FROM staff_voice_anonymous WHERE ($1::text IS NULL OR status = $1)
        ORDER BY received_week DESC, md5(id::text) LIMIT 200`, [status]);
    const { rows: c } = await db.query(`SELECT status, count(*)::int AS n FROM staff_voice_anonymous GROUP BY status`);
    const counts = { new: 0, read: 0, actioned: 0 };
    for (const r of c) counts[r.status] = r.n;
    res.json({ items: rows, counts });
  } catch (e) { fail(res, e, 'inbox'); }
});

// PUT /inbox/:id/status — the manager's bookkeeping. Touches nothing the writer wrote.
router.put('/inbox/:id/status', managerOnly, async (req, res) => {
  const status = req.body && req.body.status;
  if (!UUID_RX.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'bad_status' });
  try {
    const { rows } = await getPool().query(
      `UPDATE staff_voice_anonymous SET status = $2 WHERE id = $1 RETURNING id, status`, [req.params.id, status]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { fail(res, e, 'inbox status'); }
});

const NAMED_SELECT = `
  SELECT e.id, e.staff_id, btrim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) AS staff_name,
         e.kind, e.body, e.tags, e.for_supervision,
         e.from_room_id, fr.name AS from_room, e.about_room_id, ar.name AS about_room,
         to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
    FROM staff_voice_entries e
    JOIN staff s ON s.id = e.staff_id
    LEFT JOIN rooms fr ON fr.id = e.from_room_id
    LEFT JOIN rooms ar ON ar.id = e.about_room_id
   WHERE e.deleted_at IS NULL AND s.is_active IS NOT FALSE`;

// GET /named?kind=&room=&q= — the Roost "Staff voice" list. Named by design, and the writers were told.
router.get('/named', managerOnly, async (req, res) => {
  const db = getPool();
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const q = String(req.query.q || '').trim().slice(0, 80);
  try {
    const { rows } = await db.query(
      `${NAMED_SELECT}
         AND ($1::text IS NULL OR e.kind = $1)
         AND ($2::text = '' OR e.body ILIKE '%' || $2 || '%' OR EXISTS (SELECT 1 FROM unnest(e.tags) t WHERE t ILIKE '%' || $2 || '%'))
       ORDER BY e.for_supervision DESC, e.updated_at DESC LIMIT 400`, [kind, q]);
    const { rows: rooms } = await db.query('SELECT id, name FROM rooms ORDER BY id');
    res.json({ items: rows, rooms });
  } catch (e) { fail(res, e, 'named'); }
});

// GET /staff/:id — one person's entries, for the read-only card on the Roost staff profile.
router.get('/staff/:id', managerOnly, async (req, res) => {
  const db = getPool();
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  try {
    const { rows } = await db.query(`${NAMED_SELECT} AND e.staff_id = $1 ORDER BY e.created_at, e.id`, [id]);
    const entries = Object.fromEntries(KINDS.map(k => [k, []]));
    for (const r of rows) entries[r.kind].push(r);
    res.json({ staff_id: id, entries, total: rows.length });
  } catch (e) { fail(res, e, 'staff summary'); }
});

module.exports = router;
