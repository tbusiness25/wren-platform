'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * inset.js — inset-20261026 (2026-10-26) — mounted at /api/inset.
 *
 * The INSET-day agenda staff read in the HR app (/inset.html), and what they
 * send back: a comment under any section (optionally private — only Toby reads
 * it), a two-minute pre-INSET check-in, and "I've read it". Toby reads it all
 * on Roost → Look back → "Staff feedback on the INSET agenda".
 *
 * ── THE AGENDA IS A FILE ─────────────────────────────────────────────────────
 * src/content/inset/<key>.json, served verbatim. The wording was written for
 * Toby's approval, so nothing here rewrites it: the page renders the strings
 * (with **bold** / *italic* only, escaped first). The only thing this router
 * ADDS to the payload is a stable id per confidence item (`confidence_ids`),
 * derived from the item's own text, so a survey answer is keyed by something
 * that survives a re-read.
 *
 * ── GATING ────────────────────────────────────────────────────────────────────
 * Staff routes  — authenticate, then any role but 'parent'. A parent token is
 *                 also refused one layer up ('inset' is in PARENT_DENY), and the
 *                 HR portal only lets it through because 'inset' is on HR_ALLOW.
 * Manager routes — the Roost (admin) portal, a manager-equivalent role (the
 *                 same list lookback.js uses) AND the Roost person allow-list
 *                 (isRoostAllowed — on prod today [1,13,43]). 'inset' cannot go
 *                 on ROOST_ONLY_PREFIXES like 'lookback' does, because staff
 *                 must reach the agenda from HR, so the allow-list check lives
 *                 here instead.
 *
 * ── "PRIVATE — ONLY TOBY SEES IT" ─────────────────────────────────────────────
 * The tickbox makes a promise, so the server keeps it: a private comment's
 * body is returned ONLY to staff id 1. Anybody else on the Roost allow-list
 * (the office manager, say) sees that a private comment exists and who sent it, never what
 * it says.
 *
 * ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
 * New feedback / a survey notifies Toby (staff 1) in-app (bell, and web push if
 * he has subscribed) under category 'inset_feedback'. That category is named in
 * EMAIL_BLOCKED_CATEGORIES in notification-dispatcher.js, so it can never be
 * emailed: a staff comment can name a child. The notification text names the
 * sender and nothing they wrote. Batched: while Toby has an unread one from the
 * same person from the last 30 minutes, no second one is created.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const router  = express.Router();

const { getPool }      = require('../db/pool');
const authenticate     = require('../middleware/auth');
const { isRoostAllowed } = require('../lib/roost-allowlist');

const CONTENT_DIR   = path.join(__dirname, '..', 'content', 'inset');
const MANAGER_ROLES = ['manager', 'admin', 'owner', 'headteacher']; // same list as lookback.js
const OWNER_ID      = 1;

const MAX_COMMENT = 2000;
const MAX_FREE    = 1000;
const KEY_RE      = /^[a-z0-9][a-z0-9-]{0,63}$/;

router.use(express.json({ limit: '32kb' }));

// ── The agenda file ─────────────────────────────────────────────────────────
function slug(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const _cache = new Map(); // key → { mtimeMs, agenda }
function loadAgenda(key) {
  if (!KEY_RE.test(String(key || ''))) return null;
  const file = path.join(CONTENT_DIR, key + '.json');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = _cache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.agenda;
  let agenda;
  try { agenda = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    console.error('[inset] agenda parse failed:', key, e.message);
    return null;
  }
  const sv = agenda.survey || {};
  const ids = (sv.confidence_items || []).map((t, i) => slug(t) || ('item-' + (i + 1)));
  agenda._derived = {
    section_ids: (agenda.sections || []).map((s) => s.id),
    confidence_ids: ids,
    // 28 Oct: topics ranked by room (survey.topic_rooms) — any room's topic is valid, and a
    // whole list may be ranked; the order of `topics` IS the ranking.
    topic_ideas: Array.isArray(sv.topic_rooms) && sv.topic_rooms.length
      ? [...new Set(sv.topic_rooms.flatMap((r) => r.topics || []))] : (sv.topic_ideas || []),
    topic_rooms: Array.isArray(sv.topic_rooms) ? sv.topic_rooms.map((r) => ({ id: r.id, topics: r.topics || [] })) : [],
    pick_max: Array.isArray(sv.topic_rooms) && sv.topic_rooms.length
      ? Math.max(...sv.topic_rooms.map((r) => (r.topics || []).length)) : (Number(sv.pick_max) || 3),
    free_ids: (sv.free_text || []).map((f) => f.id),
    scale_max: Math.max(0, (sv.confidence_scale || []).length - 1) || 4,
  };
  _cache.set(key, { mtimeMs: st.mtimeMs, agenda });
  return agenda;
}

// 28 Oct: "the materials for the day" on the agenda page itself — the mandatory courses staff
// do on the day (HR → My CPD), this year's CPD topics (EY tablet → More → Deep dive), and the
// leadership-session notes for the leadership team and managers only (never practitioners).
const LEADERSHIP_ROLES = MANAGER_ROLES.concat(['room_leader', 'deputy', 'deputy_manager']);
async function materialsFor(key, user) {
  const db = getPool();
  const out = { courses: [], cpd_topics: [], leadership_html: null };
  try {
    const { rows } = await db.query(
      `SELECT id, name, duration_minutes FROM courses
        WHERE is_mandatory = true AND status = 'published' ORDER BY name`);
    out.courses = rows.map((r) => ({ id: r.id, name: r.name, minutes: r.duration_minutes || null }));
  } catch (e) { console.error('[inset] materials courses:', e.message); }
  try {
    const { rows } = await db.query(
      `SELECT t.title, t.term, t.half, count(a.id)::int AS articles
         FROM cpd_themes t LEFT JOIN cpd_theme_articles a ON a.theme_id = t.id
        WHERE t.active = true GROUP BY t.id ORDER BY t.sort_order, t.id`);
    out.cpd_topics = rows.map((r) => ({ title: r.title, when: [r.term, r.half ? 'half ' + r.half : ''].filter(Boolean).join(', '), articles: r.articles }));
  } catch (e) { console.error('[inset] materials cpd:', e.message); }
  const role = String((user && user.role) || '').toLowerCase();
  if (LEADERSHIP_ROLES.includes(role) && /^[a-z0-9-]+$/.test(key)) {
    try { out.leadership_html = fs.readFileSync(path.join(CONTENT_DIR, key + '-leadership.html'), 'utf8'); } catch { /* none for this agenda */ }
  }
  return out;
}

function publicAgenda(a) {
  const out = JSON.parse(JSON.stringify(a));
  delete out._derived;
  if (out.survey) out.survey.confidence_ids = a._derived.confidence_ids.slice();
  return out;
}

// ── Guards ──────────────────────────────────────────────────────────────────
function staffOnly(req, res, next) {
  const role = req.user && String(req.user.role || '').toLowerCase();
  if (!req.user || req.user.id == null || role === 'parent') {
    return res.status(403).json({ error: 'forbidden_role', message: 'The INSET agenda is for staff.' });
  }
  next();
}

async function managerRoostOnly(req, res, next) {
  if ((req._portal || null) !== 'admin') {
    return res.status(403).json({ error: 'forbidden_portal', message: 'INSET feedback is read on the Roost (admin) portal only.' });
  }
  const role = req.user && req.user.role;
  if (!req.user || !MANAGER_ROLES.includes(role)) {
    return res.status(403).json({ error: 'forbidden_role', message: 'Manager access only.' });
  }
  let ok = false;
  try { ok = await isRoostAllowed(req.user.id); } catch { ok = Number(req.user.id) === OWNER_ID; }
  if (!ok) return res.status(403).json({ error: 'roost_restricted', message: 'This data is restricted to Roost-authorised managers.' });
  next();
}

function withAgenda(req, res, next) {
  const a = loadAgenda(req.params.key);
  if (!a) return res.status(404).json({ error: 'agenda_not_found' });
  req.agenda = a;
  next();
}

// 27 Oct (Toby: "make sure right now they can't see anything that I haven't announced"):
// until an agenda is the active one, only Roost-authorised managers can open it by its key.
// 28 Oct (Toby: "put them live … but under permissions just keep it to me, the office manager and Callie
// for an hour or two while I check over it, then we can switch it on"): a named preview list.
// settings.inset_preview_agenda = the key; settings.inset_preview_staff_ids = JSON array of staff ids.
// While a preview list is set, ONLY those people can open a not-yet-active agenda (it replaces the
// Roost-allow-list fallback below), and HR Home shows them the card as if it were live.
async function previewFor(userId) {
  const { rows } = await getPool().query(
    "SELECT key, value FROM settings WHERE key IN ('inset_preview_agenda','inset_preview_staff_ids')");
  const m = {}; rows.forEach((r) => { m[r.key] = r.value; });
  let ids = [];
  try { ids = JSON.parse(m.inset_preview_staff_ids || '[]'); } catch { ids = []; }
  ids = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  const key = String(m.inset_preview_agenda || '').trim();
  return { key, listed: !!key && ids.length > 0, allowed: !!key && ids.includes(Number(userId)) };
}

async function activeKey() {
  const { rows } = await getPool().query("SELECT value FROM settings WHERE key='inset_active_agenda'");
  return (rows[0] && String(rows[0].value || '').trim()) || '';
}

async function liveOnly(req, res, next) {
  try {
    const active = await activeKey();
    if (active && active === req.params.key) return next();
    const pv = await previewFor(req.user.id);
    if (pv.allowed && pv.key === req.params.key) return next();
    if (pv.listed && pv.key === req.params.key) return res.status(404).json({ error: 'agenda_not_found' });
    let ok = false;
    try { ok = await isRoostAllowed(req.user.id); } catch { ok = Number(req.user.id) === OWNER_ID; }
    if (ok) return next();
  } catch (e) { console.error('[inset] liveOnly:', e.message); }
  return res.status(404).json({ error: 'agenda_not_found' });
}

const staffGuard   = [authenticate, staffOnly];
const managerGuard = [authenticate, managerRoostOnly];

function staffName(r) {
  if (!r) return 'A member of staff';
  const first = (r.preferred_name && String(r.preferred_name).trim()) || r.first_name || '';
  return [first, r.last_name].filter(Boolean).join(' ').trim() || ('Staff ' + r.id);
}

// ── Toby's bell ─────────────────────────────────────────────────────────────
async function notifyOwner(db, staffId, what) {
  try {
    const { rows } = await db.query('SELECT id, first_name, last_name, preferred_name FROM staff WHERE id=$1', [staffId]);
    const first = rows[0] ? ((rows[0].preferred_name && String(rows[0].preferred_name).trim()) || rows[0].first_name || 'A member of staff') : 'A member of staff';
    const title = 'INSET agenda: ' + first + ' ' + what;
    // Batch: one unread note per sender per 30 minutes is enough to bring Toby in.
    const dup = await db.query(
      `SELECT 1 FROM notifications
        WHERE recipient_type='staff' AND recipient_id=$1 AND category='inset_feedback'
          AND related_table='staff' AND related_id=$2
          AND read_at IS NULL AND dismissed_at IS NULL
          AND created_at > NOW() - INTERVAL '30 minutes'
        LIMIT 1`, [OWNER_ID, staffId]);
    if (dup.rows.length) return { batched: true };
    const admin = process.env.ADMIN_DOMAIN;
    const link = (admin ? 'https://' + admin : '') + '/lookback.html?tab=inset';
    const { notifyAsync } = require('../services/notification-dispatcher');
    const id = await notifyAsync('inset_feedback', 'staff', OWNER_ID, title,
      'Open Roost → Look back → Staff feedback on the INSET agenda.',
      { link, relatedTable: 'staff', relatedId: staffId, priority: 'low' });
    return { notification_id: id || null };
  } catch (e) {
    console.error('[inset] notify owner failed:', e.message);
    return { error: true };
  }
}

// ── Staff routes ─────────────────────────────────────────────────────────────

// GET /active — which agenda (if any) HR Home should advertise.
router.get('/active', staffGuard, async (req, res) => {
  try {
    let key = await activeKey();
    let preview = false;
    if (!key || !loadAgenda(key)) {
      const pv = await previewFor(req.user.id);
      key = pv.allowed ? pv.key : '';
      preview = !!key;
    }
    const a = key ? loadAgenda(key) : null;
    if (!a) return res.json({ key: null });
    const r = await getPool().query(
      "SELECT 1 FROM inset_feedback WHERE agenda_key=$1 AND staff_id=$2 AND kind='read' LIMIT 1", [key, req.user.id]);
    res.json({ key, title: a.title, subtitle: a.subtitle || null, read: !!r.rows.length, preview });
  } catch (e) {
    console.error('[inset] active:', e.message);
    res.json({ key: null });
  }
});

// GET /agenda/:key — the agenda + what I have already sent.
router.get('/agenda/:key', staffGuard, liveOnly, withAgenda, async (req, res) => {
  const key = req.params.key;
  try {
    const { rows } = await getPool().query(
      `SELECT id, kind, section_id, body, payload, created_at, handled_at
         FROM inset_feedback WHERE agenda_key=$1 AND staff_id=$2 ORDER BY created_at ASC, id ASC`,
      [key, req.user.id]);
    const comments = rows.filter((r) => r.kind === 'comment' || r.kind === 'private').map((r) => ({
      id: r.id, section_id: r.section_id, body: r.body, private: r.kind === 'private',
      created_at: r.created_at, handled: !!r.handled_at,
    }));
    const surveys = rows.filter((r) => r.kind === 'survey');
    const last = surveys[surveys.length - 1] || null;
    const read = rows.find((r) => r.kind === 'read') || null;
    const active = await activeKey();
    res.json({
      agenda: publicAgenda(req.agenda),
      preview: active !== key,
      materials: await materialsFor(key, req.user),
      mine: {
        comments,
        survey: last ? Object.assign({ submitted_at: last.created_at }, last.payload || {}) : null,
        read_at: read ? read.created_at : null,
      },
    });
  } catch (e) {
    console.error('[inset] agenda:', e.message);
    res.status(500).json({ error: 'Could not load the agenda' });
  }
});

// POST /agenda/:key/feedback {section_id, body, private?}
router.post('/agenda/:key/feedback', staffGuard, liveOnly, withAgenda, async (req, res) => {
  const b = req.body || {};
  const sectionId = String(b.section_id || '');
  if (!req.agenda._derived.section_ids.includes(sectionId)) return res.status(400).json({ error: 'unknown_section' });
  const body = typeof b.body === 'string' ? b.body.trim() : '';
  if (!body) return res.status(400).json({ error: 'empty', message: 'Write something first.' });
  if (body.length > MAX_COMMENT) return res.status(400).json({ error: 'too_long', message: 'Please keep it under ' + MAX_COMMENT + ' characters.' });
  const kind = b.private === true ? 'private' : 'comment';
  const db = getPool();
  try {
    const { rows } = await db.query(
      `INSERT INTO inset_feedback (agenda_key, staff_id, kind, section_id, body)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, section_id, body, created_at`,
      [req.params.key, req.user.id, kind, sectionId, body]);
    const sec = (req.agenda.sections || []).find((s) => s.id === sectionId);
    const note = await notifyOwner(db, req.user.id,
      (kind === 'private' ? 'sent you a private comment' : 'commented') + ' on “' + (sec ? sec.title : sectionId) + '”');
    const r = rows[0];
    res.status(201).json({ ok: true, comment: { id: r.id, section_id: r.section_id, body: r.body, private: r.kind === 'private', created_at: r.created_at }, notified: note });
  } catch (e) {
    console.error('[inset] feedback:', e.message);
    res.status(500).json({ error: 'Could not send that' });
  }
});

// POST /agenda/:key/survey {confidence:{id:0-4}, topics:[...<=pick_max], free:{room_weak, own_topic}}
router.post('/agenda/:key/survey', staffGuard, liveOnly, withAgenda, async (req, res) => {
  const D = req.agenda._derived;
  const b = req.body || {};
  const conf = {};
  const inConf = (b.confidence && typeof b.confidence === 'object' && !Array.isArray(b.confidence)) ? b.confidence : {};
  for (const [k, v] of Object.entries(inConf)) {
    if (!D.confidence_ids.includes(k)) return res.status(400).json({ error: 'unknown_item', item: k });
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > D.scale_max) return res.status(400).json({ error: 'bad_score', item: k });
    conf[k] = n;
  }
  const topics = Array.isArray(b.topics) ? b.topics.map(String) : [];
  if (topics.some((t) => !D.topic_ideas.includes(t))) return res.status(400).json({ error: 'unknown_topic' });
  const uniq = topics.filter((t, i) => topics.indexOf(t) === i);
  if (uniq.length > D.pick_max) return res.status(400).json({ error: 'too_many_topics', message: 'Pick up to ' + D.pick_max + '.' });
  const free = {};
  const inFree = (b.free && typeof b.free === 'object') ? b.free : {};
  for (const id of D.free_ids) {
    const v = typeof inFree[id] === 'string' ? inFree[id].trim() : '';
    if (v.length > MAX_FREE) return res.status(400).json({ error: 'too_long', field: id, message: 'Please keep it under ' + MAX_FREE + ' characters.' });
    if (v) free[id] = v;
  }
  if (!Object.keys(conf).length && !uniq.length && !Object.keys(free).length) {
    return res.status(400).json({ error: 'empty', message: 'Answer at least one question first.' });
  }
  let topicRoom = null;
  if (D.topic_rooms.length && uniq.length) {
    const room = D.topic_rooms.find((r) => r.id === String(b.topic_room || ''));
    if (!room) return res.status(400).json({ error: 'room_required', message: 'Choose your room first.' });
    if (uniq.some((t) => !room.topics.includes(t))) return res.status(400).json({ error: 'unknown_topic' });
    topicRoom = room.id;
  }
  const payload = { confidence: conf, topics: uniq, free };
  if (topicRoom) payload.topic_room = topicRoom;
  const db = getPool();
  try {
    const { rows } = await db.query(
      `INSERT INTO inset_feedback (agenda_key, staff_id, kind, payload)
       VALUES ($1,$2,'survey',$3::jsonb) RETURNING id, created_at`,
      [req.params.key, req.user.id, JSON.stringify(payload)]);
    const note = await notifyOwner(db, req.user.id, 'answered the pre-INSET check-in');
    res.status(201).json({ ok: true, survey: Object.assign({ id: rows[0].id, submitted_at: rows[0].created_at }, payload), notified: note });
  } catch (e) {
    console.error('[inset] survey:', e.message);
    res.status(500).json({ error: 'Could not save that' });
  }
});

// POST /agenda/:key/read — one row per person; a second tap is a no-op.
router.post('/agenda/:key/read', staffGuard, liveOnly, withAgenda, async (req, res) => {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO inset_feedback (agenda_key, staff_id, kind)
       VALUES ($1,$2,'read')
       ON CONFLICT (agenda_key, staff_id) WHERE kind = 'read' DO NOTHING`,
      [req.params.key, req.user.id]);
    const { rows } = await db.query(
      "SELECT created_at FROM inset_feedback WHERE agenda_key=$1 AND staff_id=$2 AND kind='read' LIMIT 1",
      [req.params.key, req.user.id]);
    res.json({ ok: true, read_at: rows[0] ? rows[0].created_at : null });
  } catch (e) {
    console.error('[inset] read:', e.message);
    res.status(500).json({ error: 'Could not save that' });
  }
});

// ── Manager routes ───────────────────────────────────────────────────────────

// GET /agendas — every agenda file, and which one HR Home is advertising.
router.get('/agendas', managerGuard, async (req, res) => {
  let files = [];
  try { files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.json')); } catch { files = []; }
  const agendas = files.map((f) => f.replace(/\.json$/, '')).map((k) => {
    const a = loadAgenda(k);
    return a ? { key: k, title: a.title || k } : null;
  }).filter(Boolean).sort((a, b) => (a.key < b.key ? 1 : -1));
  let active = null;
  try {
    const { rows } = await getPool().query("SELECT value FROM settings WHERE key='inset_active_agenda'");
    active = (rows[0] && String(rows[0].value || '').trim()) || null;
  } catch { active = null; }
  res.json({ agendas, active });
});

// GET /agenda/:key/responses — everything, for Toby's INSET screen.
router.get('/agenda/:key/responses', managerGuard, withAgenda, async (req, res) => {
  const key = req.params.key;
  const A = req.agenda, D = A._derived;
  const isOwner = Number(req.user.id) === OWNER_ID;
  const db = getPool();
  try {
    const [fb, people] = await Promise.all([
      db.query(
        `SELECT f.id, f.staff_id, f.kind, f.section_id, f.body, f.payload, f.created_at, f.handled_at, f.handled_by,
                s.first_name, s.last_name, s.preferred_name
           FROM inset_feedback f LEFT JOIN staff s ON s.id = f.staff_id
          WHERE f.agenda_key=$1 ORDER BY f.created_at ASC, f.id ASC`, [key]),
      // Who should read it: every active, real member of staff except Toby.
      // Demo fixtures, parents and the external accountant are not "the team".
      db.query(
        `SELECT id, first_name, last_name, preferred_name, role FROM staff
          WHERE is_active = true AND COALESCE(is_demo,false) = false
            AND id <> $1 AND COALESCE(role,'') NOT IN ('parent','accountant')
          ORDER BY first_name, last_name, id`, [OWNER_ID]),
    ]);

    // Comments, grouped per section in agenda order.
    const bySection = {};
    D.section_ids.forEach((id) => { bySection[id] = []; });
    fb.rows.filter((r) => r.kind === 'comment' || r.kind === 'private').forEach((r) => {
      const priv = r.kind === 'private';
      (bySection[r.section_id] || (bySection[r.section_id] = [])).push({
        id: r.id, staff_id: r.staff_id, staff_name: staffName(Object.assign({ id: r.staff_id }, r)),
        private: priv,
        body: priv && !isOwner ? null : r.body,
        redacted: priv && !isOwner,
        created_at: r.created_at, handled_at: r.handled_at, handled_by: r.handled_by,
      });
    });
    const sections = (A.sections || []).map((s) => ({
      id: s.id, title: s.title, ask: s.ask, comments: bySection[s.id] || [],
    }));

    // Survey — latest per person.
    const latest = new Map();
    fb.rows.filter((r) => r.kind === 'survey').forEach((r) => latest.set(r.staff_id, r)); // ASC order → last wins
    const surveys = Array.from(latest.values());
    const scale = (A.survey && A.survey.confidence_scale) || [];
    const items = D.confidence_ids.map((id, i) => {
      const dist = new Array(D.scale_max + 1).fill(0);
      let sum = 0, n = 0;
      surveys.forEach((r) => {
        const v = r.payload && r.payload.confidence ? r.payload.confidence[id] : undefined;
        if (Number.isInteger(v) && v >= 0 && v <= D.scale_max) { dist[v]++; sum += v; n++; }
      });
      return { id, label: A.survey.confidence_items[i], n, avg: n ? Math.round((sum / n) * 100) / 100 : null, dist };
    });
    const weakestFirst = items.slice().sort((a, b) => {
      if (a.avg == null && b.avg == null) return 0;
      if (a.avg == null) return 1;
      if (b.avg == null) return -1;
      return a.avg - b.avg;
    });
    const votes = {};
    D.topic_ideas.forEach((t) => { votes[t] = 0; });
    surveys.forEach((r) => ((r.payload && r.payload.topics) || []).forEach((t) => { if (t in votes) votes[t]++; }));
    const topics = Object.keys(votes).map((t) => ({ topic: t, votes: votes[t] }))
      .sort((a, b) => b.votes - a.votes || D.topic_ideas.indexOf(a.topic) - D.topic_ideas.indexOf(b.topic));
    const freeLabels = {};
    ((A.survey && A.survey.free_text) || []).forEach((f) => { freeLabels[f.id] = f.label; });
    const free = D.free_ids.map((fid) => ({
      id: fid, label: freeLabels[fid],
      answers: surveys.filter((r) => r.payload && r.payload.free && r.payload.free[fid]).map((r) => ({
        staff_id: r.staff_id, staff_name: staffName(Object.assign({ id: r.staff_id }, r)),
        text: r.payload.free[fid], created_at: r.created_at,
      })),
    }));

    // Read receipts.
    const readBy = new Map();
    fb.rows.filter((r) => r.kind === 'read').forEach((r) => readBy.set(r.staff_id, r.created_at));
    const expected = people.rows.map((p) => ({ id: p.id, name: staffName(p), role: p.role, read_at: readBy.get(p.id) || null }));

    res.json({
      key, title: A.title, viewer_is_owner: isOwner,
      read: {
        expected: expected.length,
        read: expected.filter((p) => p.read_at).length,
        not_read: expected.filter((p) => !p.read_at).map((p) => ({ id: p.id, name: p.name, role: p.role })),
        read_by: expected.filter((p) => p.read_at).map((p) => ({ id: p.id, name: p.name, read_at: p.read_at })),
      },
      sections,
      comment_count: sections.reduce((a, s) => a + s.comments.length, 0),
      unhandled_count: sections.reduce((a, s) => a + s.comments.filter((c) => !c.handled_at).length, 0),
      survey: {
        n: surveys.length,
        scale,
        scale_max: D.scale_max,
        items,
        weakest_first: weakestFirst.map((x) => x.id),
        topics, pick_max: D.pick_max,
        free,
      },
    });
  } catch (e) {
    console.error('[inset] responses:', e.message);
    res.status(500).json({ error: 'Could not load the responses' });
  }
});

// PATCH /feedback/:id/handled {handled?: boolean (default true)}
router.patch('/feedback/:id/handled', managerGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  const on = !(req.body && req.body.handled === false);
  try {
    const { rows } = await getPool().query(
      `UPDATE inset_feedback
          SET handled_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
              handled_by = CASE WHEN $2 THEN $3::int ELSE NULL END
        WHERE id=$1 AND kind IN ('comment','private')
        RETURNING id, handled_at, handled_by`, [id, on, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, feedback: rows[0] });
  } catch (e) {
    console.error('[inset] handled:', e.message);
    res.status(500).json({ error: 'Could not update that' });
  }
});

module.exports = router;
module.exports.__loadAgenda = loadAgenda;
module.exports.__slug = slug;
