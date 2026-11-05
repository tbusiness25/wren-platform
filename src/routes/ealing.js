'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Ealing EY Hub — authenticated API. Build b196, 2026-08-19.
//
// Mounted at /api/ealing. Every route below sits behind requireEalingUser, which
// derives { userId, orgId, role } from a verified hub JWT and nothing else.
//
// THE SCOPE RULE (the one that matters):
//   ealing.org_reports is per-setting data. Every read of it is filtered by
//   `org_id = $req.ealing.orgId` in SQL — server-side, not in the UI, and never
//   from a client-supplied org id. A setting asking for another setting's report
//   by id gets 404, not 403, so ids can't be enumerated either.
//
// Nothing here touches ladn.* — this router only ever uses the ealing pool,
// whose search_path excludes the ladn schema. See src/lib/ealing-db.js.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

const { getEalingPool, ensureEalingSchema, audit } = require('../lib/ealing-db');
const A = require('../lib/ealing-auth');

const router = express.Router();

// Mounted before the server-level body parser, so parse our own.
router.use(express.json({ limit: '64kb' }));

router.use(async (req, res, next) => {
  try { await ensureEalingSchema(); next(); }
  catch (e) { console.error('[ealing] schema init failed:', e.message); res.status(503).json({ error: 'unavailable' }); }
});
router.use(A.requireEalingUser);

const db    = () => getEalingPool();
const clean = (v, n = 500) => (v == null ? null : String(v).trim().slice(0, n) || null);
const ipOf  = (req) => (req.ip || req.socket?.remoteAddress || '').slice(0, 60);
const REPORT_DIR = process.env.EALING_REPORT_DIR || '/app/data/ealing/reports';

// ── Who am I ─────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const { rows } = await db().query(
      `SELECT u.id, u.full_name, u.email, u.job_title, u.role, u.last_login_at,
              o.id AS org_id, o.name AS org_name, o.urn, o.setting_type, o.postcode
         FROM ealing.users u JOIN ealing.orgs o ON o.id = u.org_id
        WHERE u.id = $1 AND u.org_id = $2`,
      [req.ealing.userId, req.ealing.orgId]);
    if (!rows.length) return res.status(401).json({ error: 'not_authenticated' });
    res.json(rows[0]);
  } catch (e) { console.error('[ealing] me:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.post('/account/password', async (req, res) => {
  const current = req.body?.current_password;
  const next_   = req.body?.new_password;
  const problem = A.passwordProblem(next_);
  if (problem) return res.status(400).json({ error: 'weak_password', message: problem });
  try {
    const { rows } = await db().query(`SELECT password_hash FROM ealing.users WHERE id = $1`, [req.ealing.userId]);
    if (!rows.length) return res.status(401).json({ error: 'not_authenticated' });
    if (rows[0].password_hash && !(await A.verifyPassword(current, rows[0].password_hash))) {
      return res.status(403).json({ error: 'bad_password', message: 'Your current password is not correct.' });
    }
    await db().query(`UPDATE ealing.users SET password_hash = $2 WHERE id = $1`,
      [req.ealing.userId, await A.hashPassword(next_)]);
    await audit(db(), { action: 'password_changed', userId: req.ealing.userId, orgId: req.ealing.orgId,
                        actorEmail: req.ealing.email, ip: ipOf(req) });
    res.json({ ok: true });
  } catch (e) { console.error('[ealing] password:', e.message); res.status(500).json({ error: 'server_error' }); }
});

// ── EGFL links + named contacts ──────────────────────────────────────────────
router.get('/resources', async (req, res) => {
  const category = clean(req.query.category, 60);
  const kind     = clean(req.query.kind, 20);
  const q        = clean(req.query.q, 120);
  const params = [];
  const where = ['is_active'];
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  if (kind)     { params.push(kind);     where.push(`kind = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length}
                 OR contact_name ILIKE $${params.length} OR category ILIKE $${params.length})`);
  }
  try {
    const { rows } = await db().query(
      `SELECT id, slug, kind, category, title, description, url,
              contact_name, contact_email, contact_phone, source, verified_on, confirmed
         FROM ealing.resources
        WHERE ${where.join(' AND ')}
        ORDER BY category, sort_order, title`, params);
    res.json({ resources: rows, categories: [...new Set(rows.map(r => r.category))] });
  } catch (e) { console.error('[ealing] resources:', e.message); res.status(500).json({ error: 'server_error' }); }
});

// ── LA documents (Yellow Book etc) ───────────────────────────────────────────
router.get('/documents', async (req, res) => {
  const category = clean(req.query.category, 60);
  const q        = clean(req.query.q, 120);
  const params = [];
  const where = ['is_active'];
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`); }
  try {
    const { rows } = await db().query(
      `SELECT id, slug, title, description, category, doc_type, url,
              CASE WHEN file_path IS NOT NULL THEN true ELSE false END AS has_local_copy,
              published_label, source, verified_on, confirmed
         FROM ealing.documents
        WHERE ${where.join(' AND ')}
        ORDER BY category, sort_order, title`, params);
    res.json({ documents: rows, categories: [...new Set(rows.map(r => r.category))] });
  } catch (e) { console.error('[ealing] documents:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.get('/documents/:id/file', async (req, res) => {
  try {
    const { rows } = await db().query(
      `SELECT file_path, file_name, mime_type, url FROM ealing.documents WHERE id = $1 AND is_active`,
      [Number(req.params.id) || 0]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const d = rows[0];
    if (!d.file_path) {
      if (d.url) return res.redirect(302, d.url);
      return res.status(404).json({ error: 'no_file' });
    }
    if (!fs.existsSync(d.file_path)) return res.status(404).json({ error: 'file_missing' });
    res.setHeader('Content-Type', d.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(d.file_name || 'document').replace(/"/g, '')}"`);
    fs.createReadStream(d.file_path).pipe(res);
  } catch (e) { console.error('[ealing] document file:', e.message); res.status(500).json({ error: 'server_error' }); }
});

// ── Portal timetable ─────────────────────────────────────────────────────────
router.get('/portal-dates', async (req, res) => {
  const cycle = clean(req.query.cycle, 30);
  const from  = clean(req.query.from, 20);
  const to    = clean(req.query.to, 20);
  const params = [];
  const where = [];
  if (cycle) { params.push(cycle); where.push(`cycle = $${params.length}`); }
  if (from)  { params.push(from);  where.push(`event_date >= $${params.length}::date`); }
  if (to)    { params.push(to);    where.push(`event_date <= $${params.length}::date`); }
  try {
    const { rows } = await db().query(
      `SELECT id, cycle, period_label, date_type, event_date, title, notes, source, source_url, confirmed
         FROM ealing.portal_dates
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY event_date, cycle, date_type`, params);
    res.json({ dates: rows });
  } catch (e) { console.error('[ealing] portal-dates:', e.message); res.status(500).json({ error: 'server_error' }); }
});

// ── Reminders (in-app; derived from portal dates + events) ───────────────────
async function loadPrefs(userId) {
  const { rows } = await db().query(
    `INSERT INTO ealing.reminder_prefs (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING lead_days, portal_dates, events`, [userId]);
  return rows[0];
}

router.get('/reminder-prefs', async (req, res) => {
  try { res.json(await loadPrefs(req.ealing.userId)); }
  catch (e) { console.error('[ealing] prefs:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.put('/reminder-prefs', async (req, res) => {
  const lead = Math.min(60, Math.max(1, parseInt(req.body?.lead_days, 10) || 7));
  try {
    const { rows } = await db().query(
      `INSERT INTO ealing.reminder_prefs (user_id, lead_days, portal_dates, events)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE
         SET lead_days = EXCLUDED.lead_days, portal_dates = EXCLUDED.portal_dates,
             events = EXCLUDED.events, updated_at = now()
       RETURNING lead_days, portal_dates, events`,
      [req.ealing.userId, lead, req.body?.portal_dates !== false, req.body?.events !== false]);
    res.json(rows[0]);
  } catch (e) { console.error('[ealing] prefs save:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.get('/reminders', async (req, res) => {
  try {
    const prefs = await loadPrefs(req.ealing.userId);
    const out = [];

    if (prefs.portal_dates) {
      const { rows } = await db().query(
        `SELECT p.id, p.title, p.event_date, p.cycle, p.period_label, p.date_type, p.notes
           FROM ealing.portal_dates p
          WHERE p.event_date >= current_date
            AND p.event_date <= current_date + ($2::int || ' days')::interval
            AND NOT EXISTS (SELECT 1 FROM ealing.reminder_dismissals d
                             WHERE d.user_id = $1 AND d.ref_type = 'portal_date' AND d.ref_id = p.id)
          ORDER BY p.event_date`, [req.ealing.userId, prefs.lead_days]);
      for (const r of rows) {
        out.push({
          ref_type: 'portal_date', ref_id: r.id, date: r.event_date, title: r.title,
          detail: `${r.period_label} · ${r.cycle}`, notes: r.notes,
          urgency: r.date_type === 'close' ? 'high' : 'normal',
        });
      }
    }

    if (prefs.events) {
      const { rows } = await db().query(
        `SELECT e.id, e.title, e.starts_at, e.location, e.kind
           FROM ealing.events e
          WHERE e.is_published AND e.cancelled_at IS NULL
            AND e.starts_at >= now()
            AND e.starts_at <= now() + ($2::int || ' days')::interval
            AND NOT EXISTS (SELECT 1 FROM ealing.reminder_dismissals d
                             WHERE d.user_id = $1 AND d.ref_type = 'event' AND d.ref_id = e.id)
          ORDER BY e.starts_at`, [req.ealing.userId, prefs.lead_days]);
      for (const r of rows) {
        out.push({
          ref_type: 'event', ref_id: r.id, date: r.starts_at, title: r.title,
          detail: r.location || (r.kind === 'meetup' ? 'Meet-up' : 'Event'), urgency: 'normal',
        });
      }
    }

    out.sort((a, b) => new Date(a.date) - new Date(b.date));
    res.json({ reminders: out, lead_days: prefs.lead_days });
  } catch (e) { console.error('[ealing] reminders:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.post('/reminders/dismiss', async (req, res) => {
  const refType = clean(req.body?.ref_type, 20);
  const refId   = Number(req.body?.ref_id) || 0;
  if (!['portal_date', 'event'].includes(refType) || !refId) return res.status(400).json({ error: 'bad_request' });
  try {
    await db().query(
      `INSERT INTO ealing.reminder_dismissals (user_id, ref_type, ref_id) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, ref_type, ref_id) DO NOTHING`, [req.ealing.userId, refType, refId]);
    res.json({ ok: true });
  } catch (e) { console.error('[ealing] dismiss:', e.message); res.status(500).json({ error: 'server_error' }); }
});

// ── Events + RSVP + meet-ups ─────────────────────────────────────────────────
router.get('/events', async (req, res) => {
  const from = clean(req.query.from, 20);
  const to   = clean(req.query.to, 20);
  const params = [req.ealing.userId];
  const where = ['e.is_published'];
  if (from) { params.push(from); where.push(`e.starts_at >= $${params.length}::date`); }
  else where.push(`e.starts_at >= now() - interval '1 day'`);
  if (to) { params.push(to); where.push(`e.starts_at <= $${params.length}::date + interval '1 day'`); }
  try {
    const { rows } = await db().query(
      `SELECT e.id, e.title, e.description, e.kind, e.starts_at, e.ends_at, e.location,
              e.online_url, e.capacity, e.cancelled_at, e.created_by_org_id,
              o.name AS organiser,
              (SELECT count(*) FROM ealing.event_rsvps r WHERE r.event_id = e.id AND r.status = 'going') AS going_count,
              (SELECT coalesce(sum(r.attendees),0) FROM ealing.event_rsvps r WHERE r.event_id = e.id AND r.status = 'going') AS going_people,
              (SELECT r.status FROM ealing.event_rsvps r WHERE r.event_id = e.id AND r.user_id = $1) AS my_status
         FROM ealing.events e
         LEFT JOIN ealing.orgs o ON o.id = e.created_by_org_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.starts_at
        LIMIT 200`, params);
    res.json({ events: rows });
  } catch (e) { console.error('[ealing] events:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.get('/events/:id', async (req, res) => {
  try {
    const { rows } = await db().query(
      `SELECT e.*, o.name AS organiser FROM ealing.events e
         LEFT JOIN ealing.orgs o ON o.id = e.created_by_org_id
        WHERE e.id = $1 AND e.is_published`, [Number(req.params.id) || 0]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    // Attendee list shows SETTING names (who else is coming) — no personal data
    // beyond the name of the person who RSVP'd on that setting's behalf.
    const { rows: rsvps } = await db().query(
      `SELECT r.status, r.attendees, r.note, o.name AS setting_name, u.full_name
         FROM ealing.event_rsvps r
         JOIN ealing.orgs o ON o.id = r.org_id
         JOIN ealing.users u ON u.id = r.user_id
        WHERE r.event_id = $1 AND r.status <> 'declined'
        ORDER BY o.name`, [rows[0].id]);
    res.json({ event: rows[0], rsvps });
  } catch (e) { console.error('[ealing] event:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.post('/events', async (req, res) => {
  const b = req.body || {};
  const title = clean(b.title, 200);
  const starts = clean(b.starts_at, 40);
  let kind = clean(b.kind, 20) || 'meetup';
  if (!title || !starts) return res.status(400).json({ error: 'missing_fields', message: 'Title and start time are required.' });
  if (!['la_event', 'training', 'meetup', 'network'].includes(kind)) kind = 'meetup';
  // Only the LA team can publish official LA events/training; any setting can
  // arrange a meet-up or a network get-together.
  if (['la_event', 'training'].includes(kind) && req.ealing.role !== 'la_admin') kind = 'meetup';
  try {
    const { rows } = await db().query(
      `INSERT INTO ealing.events
         (title, description, kind, starts_at, ends_at, location, online_url, capacity,
          created_by_user_id, created_by_org_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [title, clean(b.description, 4000), kind, starts, clean(b.ends_at, 40),
       clean(b.location, 300), clean(b.online_url, 500),
       b.capacity ? Number(b.capacity) : null, req.ealing.userId, req.ealing.orgId]);
    // Whoever arranges it is coming — otherwise a brand-new meet-up reads
    // "0 coming" to everyone including the person who set it up.
    await db().query(
      `INSERT INTO ealing.event_rsvps (event_id, user_id, org_id, status)
       VALUES ($1,$2,$3,'going') ON CONFLICT (event_id, user_id) DO NOTHING`,
      [rows[0].id, req.ealing.userId, req.ealing.orgId]);
    await audit(db(), { action: 'event_created', userId: req.ealing.userId, orgId: req.ealing.orgId,
                        actorEmail: req.ealing.email, refType: 'event', refId: rows[0].id, detail: title, ip: ipOf(req) });
    res.status(201).json(rows[0]);
  } catch (e) { console.error('[ealing] create event:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.post('/events/:id/rsvp', async (req, res) => {
  const id = Number(req.params.id) || 0;
  let status = clean(req.body?.status, 20) || 'going';
  if (!['going', 'maybe', 'declined'].includes(status)) status = 'going';
  const attendees = Math.min(20, Math.max(1, parseInt(req.body?.attendees, 10) || 1));
  try {
    const { rows: ev } = await db().query(
      `SELECT id, capacity, cancelled_at FROM ealing.events WHERE id = $1 AND is_published`, [id]);
    if (!ev.length) return res.status(404).json({ error: 'not_found' });
    if (ev[0].cancelled_at) return res.status(409).json({ error: 'cancelled', message: 'This event has been cancelled.' });

    if (status === 'going' && ev[0].capacity) {
      const { rows: c } = await db().query(
        `SELECT coalesce(sum(attendees),0)::int AS taken FROM ealing.event_rsvps
          WHERE event_id = $1 AND status = 'going' AND user_id <> $2`, [id, req.ealing.userId]);
      if (c[0].taken + attendees > ev[0].capacity) {
        return res.status(409).json({ error: 'full', message: `Sorry — only ${ev[0].capacity - c[0].taken} place(s) left.` });
      }
    }
    const { rows } = await db().query(
      `INSERT INTO ealing.event_rsvps (event_id, user_id, org_id, status, attendees, note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (event_id, user_id) DO UPDATE
         SET status = EXCLUDED.status, attendees = EXCLUDED.attendees,
             note = EXCLUDED.note, updated_at = now()
       RETURNING *`,
      [id, req.ealing.userId, req.ealing.orgId, status, attendees, clean(req.body?.note, 300)]);
    await audit(db(), { action: 'event_rsvp', userId: req.ealing.userId, orgId: req.ealing.orgId,
                        actorEmail: req.ealing.email, refType: 'event', refId: id, detail: status, ip: ipOf(req) });
    res.json(rows[0]);
  } catch (e) { console.error('[ealing] rsvp:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.post('/events/:id/cancel', async (req, res) => {
  const id = Number(req.params.id) || 0;
  try {
    const { rows } = await db().query(
      `UPDATE ealing.events SET cancelled_at = now()
        WHERE id = $1 AND (created_by_user_id = $2 OR $3 = 'la_admin')
        RETURNING id`, [id, req.ealing.userId, req.ealing.role]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    await audit(db(), { action: 'event_cancelled', userId: req.ealing.userId, orgId: req.ealing.orgId,
                        actorEmail: req.ealing.email, refType: 'event', refId: id, ip: ipOf(req) });
    res.json({ ok: true });
  } catch (e) { console.error('[ealing] cancel event:', e.message); res.status(500).json({ error: 'server_error' }); }
});

// ── Managers' forum ──────────────────────────────────────────────────────────
router.get('/forum/topics', async (req, res) => {
  try {
    const { rows } = await db().query(
      `SELECT t.id, t.slug, t.name, t.description, t.is_general,
              (SELECT count(*) FROM ealing.forum_threads th
                WHERE th.topic_id = t.id AND th.deleted_at IS NULL AND th.hidden_at IS NULL) AS thread_count,
              (SELECT max(th.last_post_at) FROM ealing.forum_threads th
                WHERE th.topic_id = t.id AND th.deleted_at IS NULL AND th.hidden_at IS NULL) AS last_activity
         FROM ealing.forum_topics t
        WHERE t.is_active
        ORDER BY t.is_general DESC, t.sort_order, t.name`);
    res.json({ topics: rows });
  } catch (e) { console.error('[ealing] topics:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.get('/forum/topics/:slug/threads', async (req, res) => {
  try {
    const { rows } = await db().query(
      `SELECT th.id, th.title, th.author_name, th.setting_name, th.created_at, th.last_post_at, th.is_locked,
              (SELECT count(*) FROM ealing.forum_posts p
                WHERE p.thread_id = th.id AND p.deleted_at IS NULL AND p.hidden_at IS NULL) AS post_count
         FROM ealing.forum_threads th
         JOIN ealing.forum_topics t ON t.id = th.topic_id
        WHERE t.slug = $1 AND th.deleted_at IS NULL AND th.hidden_at IS NULL
        ORDER BY th.last_post_at DESC
        LIMIT 100`, [clean(req.params.slug, 80)]);
    res.json({ threads: rows });
  } catch (e) { console.error('[ealing] threads:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.post('/forum/topics/:slug/threads', async (req, res) => {
  const title = clean(req.body?.title, 200);
  const body  = clean(req.body?.body, 8000);
  if (!title || !body) return res.status(400).json({ error: 'missing_fields', message: 'A title and a message are required.' });
  const conn = await db().connect();
  try {
    await conn.query('BEGIN');
    const { rows: t } = await conn.query(
      `SELECT id FROM ealing.forum_topics WHERE slug = $1 AND is_active`, [clean(req.params.slug, 80)]);
    if (!t.length) { await conn.query('ROLLBACK'); return res.status(404).json({ error: 'topic_not_found' }); }
    const { rows: th } = await conn.query(
      `INSERT INTO ealing.forum_threads (topic_id, title, user_id, org_id, author_name, setting_name)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [t[0].id, title, req.ealing.userId, req.ealing.orgId, req.ealing.name, req.ealing.orgName]);
    await conn.query(
      `INSERT INTO ealing.forum_posts (thread_id, user_id, org_id, author_name, setting_name, body)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [th[0].id, req.ealing.userId, req.ealing.orgId, req.ealing.name, req.ealing.orgName, body]);
    await conn.query('COMMIT');
    await audit(db(), { action: 'forum_thread_created', userId: req.ealing.userId, orgId: req.ealing.orgId,
                        actorEmail: req.ealing.email, refType: 'forum_thread', refId: th[0].id, detail: title, ip: ipOf(req) });
    res.status(201).json(th[0]);
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[ealing] create thread:', e.message);
    res.status(500).json({ error: 'server_error' });
  } finally { conn.release(); }
});

router.get('/forum/threads/:id', async (req, res) => {
  const id = Number(req.params.id) || 0;
  try {
    const { rows: th } = await db().query(
      `SELECT th.*, t.slug AS topic_slug, t.name AS topic_name
         FROM ealing.forum_threads th JOIN ealing.forum_topics t ON t.id = th.topic_id
        WHERE th.id = $1 AND th.deleted_at IS NULL AND th.hidden_at IS NULL`, [id]);
    if (!th.length) return res.status(404).json({ error: 'not_found' });
    const { rows: posts } = await db().query(
      `SELECT id, author_name, setting_name, body, created_at, edited_at, user_id
         FROM ealing.forum_posts
        WHERE thread_id = $1 AND deleted_at IS NULL AND hidden_at IS NULL
        ORDER BY created_at`, [id]);
    res.json({
      thread: th[0],
      posts: posts.map(p => ({ ...p, is_mine: p.user_id === req.ealing.userId })),
    });
  } catch (e) { console.error('[ealing] thread:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.post('/forum/threads/:id/posts', async (req, res) => {
  const id = Number(req.params.id) || 0;
  const body = clean(req.body?.body, 8000);
  if (!body) return res.status(400).json({ error: 'missing_fields', message: 'Write something first.' });
  try {
    const { rows: th } = await db().query(
      `SELECT id, is_locked FROM ealing.forum_threads
        WHERE id = $1 AND deleted_at IS NULL AND hidden_at IS NULL`, [id]);
    if (!th.length) return res.status(404).json({ error: 'not_found' });
    if (th[0].is_locked) return res.status(409).json({ error: 'locked', message: 'This thread is closed for replies.' });
    const { rows } = await db().query(
      `INSERT INTO ealing.forum_posts (thread_id, user_id, org_id, author_name, setting_name, body)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, req.ealing.userId, req.ealing.orgId, req.ealing.name, req.ealing.orgName, body]);
    await db().query(`UPDATE ealing.forum_threads SET last_post_at = now() WHERE id = $1`, [id]);
    await audit(db(), { action: 'forum_reply', userId: req.ealing.userId, orgId: req.ealing.orgId,
                        actorEmail: req.ealing.email, refType: 'forum_post', refId: rows[0].id, ip: ipOf(req) });
    res.status(201).json(rows[0]);
  } catch (e) { console.error('[ealing] reply:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.patch('/forum/posts/:id', async (req, res) => {
  const id = Number(req.params.id) || 0;
  const body = clean(req.body?.body, 8000);
  if (!body) return res.status(400).json({ error: 'missing_fields' });
  try {
    const { rows } = await db().query(
      `UPDATE ealing.forum_posts SET body = $3, edited_at = now()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING *`,
      [id, req.ealing.userId, body]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { console.error('[ealing] edit post:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.delete('/forum/posts/:id', async (req, res) => {
  const id = Number(req.params.id) || 0;
  try {
    // Own post => soft delete. LA admin => moderation hide (row kept, auditable).
    const isLa = req.ealing.role === 'la_admin';
    const { rows } = isLa
      ? await db().query(
          `UPDATE ealing.forum_posts SET hidden_at = now(), hidden_reason = $2
            WHERE id = $1 AND hidden_at IS NULL AND deleted_at IS NULL RETURNING id`,
          [id, clean(req.body?.reason, 200) || 'Moderated by the Ealing EY team'])
      : await db().query(
          `UPDATE ealing.forum_posts SET deleted_at = now()
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
          [id, req.ealing.userId]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    await audit(db(), { action: req.ealing.role === 'la_admin' ? 'forum_post_hidden' : 'forum_post_deleted',
                        userId: req.ealing.userId, orgId: req.ealing.orgId, actorEmail: req.ealing.email,
                        refType: 'forum_post', refId: id, ip: ipOf(req) });
    res.json({ ok: true });
  } catch (e) { console.error('[ealing] delete post:', e.message); res.status(500).json({ error: 'server_error' }); }
});

// ── PER-SETTING REPORTS — the hard scope filter ──────────────────────────────
// req.ealing.orgId comes from the verified JWT. There is no code path in which a
// client-supplied org id reaches these queries.
router.get('/reports', async (req, res) => {
  try {
    const { rows } = await db().query(
      `SELECT id, report_type, title, report_date, overall_judgement, summary, url,
              CASE WHEN file_path IS NOT NULL THEN true ELSE false END AS has_file,
              file_name, created_at
         FROM ealing.org_reports
        WHERE org_id = $1 AND is_active
        ORDER BY report_date DESC NULLS LAST, id DESC`,
      [req.ealing.orgId]);
    res.json({ reports: rows, org_id: req.ealing.orgId, org_name: req.ealing.orgName });
  } catch (e) { console.error('[ealing] reports:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.get('/reports/:id', async (req, res) => {
  try {
    // 404 (not 403) on someone else's report — ids stay unenumerable.
    const { rows } = await db().query(
      `SELECT id, report_type, title, report_date, overall_judgement, summary, url,
              CASE WHEN file_path IS NOT NULL THEN true ELSE false END AS has_file, file_name, created_at
         FROM ealing.org_reports
        WHERE id = $1 AND org_id = $2 AND is_active`,
      [Number(req.params.id) || 0, req.ealing.orgId]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { console.error('[ealing] report:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.get('/reports/:id/file', async (req, res) => {
  try {
    const { rows } = await db().query(
      `SELECT file_path, file_name, mime_type, url FROM ealing.org_reports
        WHERE id = $1 AND org_id = $2 AND is_active`,
      [Number(req.params.id) || 0, req.ealing.orgId]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const r = rows[0];
    await audit(db(), { action: 'report_downloaded', userId: req.ealing.userId, orgId: req.ealing.orgId,
                        actorEmail: req.ealing.email, refType: 'org_report', refId: Number(req.params.id), ip: ipOf(req) });
    if (!r.file_path) {
      if (r.url) return res.redirect(302, r.url);
      return res.status(404).json({ error: 'no_file' });
    }
    if (!fs.existsSync(r.file_path)) return res.status(404).json({ error: 'file_missing' });
    res.setHeader('Content-Type', r.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(r.file_name || 'report').replace(/"/g, '')}"`);
    fs.createReadStream(r.file_path).pipe(res);
  } catch (e) { console.error('[ealing] report file:', e.message); res.status(500).json({ error: 'server_error' }); }
});

// ── LA-team administration ───────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try { fs.mkdirSync(REPORT_DIR, { recursive: true }); cb(null, REPORT_DIR); }
      catch (e) { cb(e); }
    },
    filename: (req, file, cb) => {
      const safe = (file.originalname || 'report').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf', 'image/png', 'image/jpeg',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, ok.includes(file.mimetype));
  },
});

router.get('/admin/orgs', A.requireLaAdmin, async (req, res) => {
  try {
    const { rows } = await db().query(
      `SELECT o.id, o.name, o.urn, o.setting_type, o.contact_email, o.is_active, o.is_demo,
              (SELECT count(*) FROM ealing.users u WHERE u.org_id = o.id AND u.is_active) AS user_count,
              (SELECT count(*) FROM ealing.org_reports r WHERE r.org_id = o.id AND r.is_active) AS report_count
         FROM ealing.orgs o ORDER BY o.name`);
    res.json({ orgs: rows });
  } catch (e) { console.error('[ealing] admin orgs:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.post('/admin/reports', A.requireLaAdmin, upload.single('file'), async (req, res) => {
  const orgId = Number(req.body?.org_id) || 0;
  const title = clean(req.body?.title, 200);
  let type = clean(req.body?.report_type, 30) || 'ealing_visit';
  if (!['ofsted', 'ealing_visit', 'other'].includes(type)) type = 'other';
  if (!orgId || !title) return res.status(400).json({ error: 'missing_fields', message: 'Setting and title are required.' });
  try {
    const { rows: o } = await db().query(`SELECT id FROM ealing.orgs WHERE id = $1`, [orgId]);
    if (!o.length) return res.status(404).json({ error: 'org_not_found' });
    const f = req.file;
    const { rows } = await db().query(
      `INSERT INTO ealing.org_reports
         (org_id, report_type, title, report_date, overall_judgement, summary, url,
          file_path, file_name, mime_type, uploaded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [orgId, type, title, clean(req.body?.report_date, 20), clean(req.body?.overall_judgement, 80),
       clean(req.body?.summary, 4000), clean(req.body?.url, 500),
       f ? f.path : null, f ? f.originalname : null, f ? f.mimetype : null, req.ealing.userId]);
    await audit(db(), { action: 'report_uploaded', userId: req.ealing.userId, orgId: req.ealing.orgId,
                        actorEmail: req.ealing.email, refType: 'org_report', refId: rows[0].id,
                        detail: `org ${orgId}: ${title}`, ip: ipOf(req) });
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { console.error('[ealing] upload report:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.get('/admin/access-requests', A.requireLaAdmin, async (req, res) => {
  try {
    const { rows } = await db().query(
      `SELECT * FROM ealing.access_requests
        WHERE status = coalesce($1, status) ORDER BY created_at DESC LIMIT 200`,
      [clean(req.query.status, 20)]);
    res.json({ requests: rows });
  } catch (e) { console.error('[ealing] access reqs:', e.message); res.status(500).json({ error: 'server_error' }); }
});

router.post('/admin/access-requests/:id/approve', A.requireLaAdmin, async (req, res) => {
  const id = Number(req.params.id) || 0;
  const tempPassword = clean(req.body?.temp_password, 100);
  const problem = A.passwordProblem(tempPassword);
  if (problem) return res.status(400).json({ error: 'weak_password', message: problem });
  const conn = await db().connect();
  try {
    await conn.query('BEGIN');
    const { rows: reqRows } = await conn.query(
      `SELECT * FROM ealing.access_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id]);
    if (!reqRows.length) { await conn.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
    const ar = reqRows[0];

    const { rows: orgRows } = await conn.query(
      `INSERT INTO ealing.orgs (name, urn, setting_type, contact_email)
       VALUES ($1,$2,coalesce($3,'pvi'),$4)
       ON CONFLICT (lower(name)) DO UPDATE SET contact_email = coalesce(orgs.contact_email, EXCLUDED.contact_email)
       RETURNING id`, [ar.setting_name, ar.urn, ar.setting_type, ar.email]);
    const orgId = orgRows[0].id;

    const { rows: userRows } = await conn.query(
      `INSERT INTO ealing.users (org_id, email, full_name, job_title, role, password_hash, approved_at)
       VALUES ($1,$2,$3,$4,'setting',$5,now())
       ON CONFLICT (lower(email)) DO UPDATE
         SET org_id = EXCLUDED.org_id, approved_at = now(), is_active = true,
             password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [orgId, ar.email, ar.full_name, ar.job_title, await A.hashPassword(tempPassword)]);

    await conn.query(
      `UPDATE ealing.access_requests
          SET status = 'approved', decided_at = now(), decided_by = $2, created_org_id = $3
        WHERE id = $1`, [id, req.ealing.userId, orgId]);
    await conn.query('COMMIT');
    await audit(db(), { action: 'access_approved', userId: req.ealing.userId, orgId,
                        actorEmail: req.ealing.email, refType: 'access_request', refId: id,
                        detail: ar.setting_name, ip: ipOf(req) });
    res.json({ ok: true, org_id: orgId, user_id: userRows[0].id });
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[ealing] approve:', e.message);
    res.status(500).json({ error: 'server_error' });
  } finally { conn.release(); }
});

router.post('/admin/access-requests/:id/reject', A.requireLaAdmin, async (req, res) => {
  try {
    const { rows } = await db().query(
      `UPDATE ealing.access_requests SET status = 'rejected', decided_at = now(), decided_by = $2
        WHERE id = $1 AND status = 'pending' RETURNING id`, [Number(req.params.id) || 0, req.ealing.userId]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { console.error('[ealing] reject:', e.message); res.status(500).json({ error: 'server_error' }); }
});

// ── "TO CONFIRM" — anything seeded that has not been verified from a source ──
router.get('/to-confirm', async (req, res) => {
  try {
    const [r, d, p] = await Promise.all([
      db().query(`SELECT 'resource' AS kind, id, title, category, source FROM ealing.resources WHERE NOT confirmed AND is_active`),
      db().query(`SELECT 'document' AS kind, id, title, category, source FROM ealing.documents WHERE NOT confirmed AND is_active`),
      db().query(`SELECT 'portal_date' AS kind, id, title, cycle AS category, source FROM ealing.portal_dates WHERE NOT confirmed`),
    ]);
    res.json({ items: [...r.rows, ...d.rows, ...p.rows] });
  } catch (e) { console.error('[ealing] to-confirm:', e.message); res.status(500).json({ error: 'server_error' }); }
});

// ── Global search across links, documents and forum threads ──────────────────
router.get('/search', async (req, res) => {
  const q = clean(req.query.q, 120);
  if (!q || q.length < 2) return res.json({ results: [] });
  const like = `%${q}%`;
  try {
    const [r, d, t] = await Promise.all([
      db().query(`SELECT 'link' AS kind, id, title, category, description AS detail, url
                    FROM ealing.resources WHERE is_active AND (title ILIKE $1 OR description ILIKE $1 OR contact_name ILIKE $1)
                    LIMIT 20`, [like]),
      db().query(`SELECT 'document' AS kind, id, title, category, description AS detail, url
                    FROM ealing.documents WHERE is_active AND (title ILIKE $1 OR description ILIKE $1) LIMIT 20`, [like]),
      db().query(`SELECT 'thread' AS kind, th.id, th.title, tp.name AS category,
                         th.setting_name AS detail, NULL::text AS url
                    FROM ealing.forum_threads th JOIN ealing.forum_topics tp ON tp.id = th.topic_id
                   WHERE th.deleted_at IS NULL AND th.hidden_at IS NULL AND th.title ILIKE $1 LIMIT 20`, [like]),
    ]);
    res.json({ results: [...r.rows, ...d.rows, ...t.rows] });
  } catch (e) { console.error('[ealing] search:', e.message); res.status(500).json({ error: 'server_error' }); }
});

module.exports = router;
