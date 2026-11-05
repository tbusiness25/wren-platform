// ─────────────────────────────────────────────────────────────────────────────
// b197 (2026-08-19) — the unified reports inbox behind bugs.example-nursery.co.uk
//
// One board over everything anyone reports about Wren. It does NOT own the
// reports: ladn.feedback_reports (staff widget) and ladn.parent_app_feedback
// (b129 parent widget) keep their own tables, schemas and lifecycles untouched.
// This router reads ladn.reports_inbox — a view that unions those two plus the
// getwren.co.uk feedback form and ladn.bug_reports_manual (manual/PWA quick-add)
// — and writes triage state to ladn.reports_triage, keyed by (source, source_id).
//
// PERSONAL DATA. Parent-submitted bodies can name a child. Every route here is
// staff-authenticated, nothing is exposed publicly, and the view deliberately
// does not join ladn.children. See scripts/b197-bugs-inbox-schema.sql.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');
const { getPool } = require('../db/pool');

const SHOT_DIR   = process.env.FEEDBACK_SHOT_DIR || '/app/uploads/feedback';
const SOURCES    = ['staff-app', 'parent-app', 'getwren', 'manual'];
const STATUSES   = ['new', 'triaged', 'in_progress', 'fixed', 'wont_fix'];
const TYPES      = ['bug', 'feature', 'question', 'praise'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const AREAS      = ['ey', 'parents', 'roost', 'hr', 'landing', 'other'];
const MGR_ROLES  = ['manager', 'deputy_manager', 'headteacher', 'admin'];

// ── Auth ─────────────────────────────────────────────────────────────────────
// Staff only. Signature is verified but the audience is not pinned, so the same
// board works from the bugs host (aud='bugs'), from Roost, or from EY. Parent
// tokens are refused outright — parents report through their own in-app widget
// and must never see other families' reports.
router.use((req, res, next) => {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-wren-token'] || '');
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  let dec;
  try { dec = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
  if (dec.aud === 'parents' || dec.role === 'parent' || dec.id == null) {
    return res.status(403).json({ error: 'Staff only' });
  }
  req.user = dec;
  req.isManager = MGR_ROLES.includes(String(dec.role || '').toLowerCase());
  next();
});
const managerOnly = (req, res, next) =>
  req.isManager ? next() : res.status(403).json({ error: 'Manager only' });

// ── Helpers ──────────────────────────────────────────────────────────────────
// '<source>:<id>' → {source, id}. Rejects anything that is not a known source
// with a positive integer id, so the key can never reach SQL unvalidated.
function parseKey(key) {
  const raw = String(key || '');
  const i = raw.lastIndexOf(':');
  if (i < 1) return null;
  const source = raw.slice(0, i);
  const id = Number(raw.slice(i + 1));
  if (!SOURCES.includes(source)) return null;
  if (!Number.isInteger(id) || id <= 0) return null;
  return { source, id };
}
const oneOf = (v, list) => (list.includes(String(v)) ? String(v) : null);

// The view is created by scripts/b197-bugs-inbox-schema.sql. On an edition where
// that has not been applied (the demo schemas), say so plainly instead of 500ing.
async function inboxReady(db) {
  const { rows } = await db.query(`SELECT to_regclass(current_schema() || '.reports_inbox') AS t`);
  return !!rows[0].t;
}

// ── GET /meta — filter vocabulary, per-status counts, assignable staff ───────
router.get('/meta', async (req, res) => {
  const db = getPool();
  try {
    if (!await inboxReady(db)) {
      return res.json({ ready: false, sources: SOURCES, statuses: STATUSES, types: TYPES,
        severities: SEVERITIES, areas: AREAS, counts: {}, staff: [] });
    }
    const counts = {};
    (await db.query(`SELECT status, count(*)::int c FROM reports_inbox GROUP BY status`))
      .rows.forEach(r => { counts[r.status] = r.c; });
    const bySource = {};
    (await db.query(`SELECT source, count(*)::int c FROM reports_inbox GROUP BY source`))
      .rows.forEach(r => { bySource[r.source] = r.c; });
    const { rows: staff } = await db.query(
      `SELECT id, first_name || ' ' || last_name AS name FROM staff
        WHERE is_active = true ORDER BY first_name, last_name`);
    res.json({ ready: true, sources: SOURCES, statuses: STATUSES, types: TYPES,
      severities: SEVERITIES, areas: AREAS, counts, by_source: bySource, staff,
      me: { id: req.user.id, name: req.user.name, is_manager: req.isManager } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /inbox — the board's data. Every filter is optional. ─────────────────
// Returns a flat list; the client groups it into the kanban columns so a filter
// change never needs five round-trips.
router.get('/inbox', async (req, res) => {
  const db = getPool();
  try {
    if (!await inboxReady(db)) return res.json({ ready: false, reports: [] });
    const where = [];
    const params = [];
    // Every predicate is written against the view alias `i` up front — no
    // after-the-fact string rewriting, so nothing can go ambiguous against the
    // joined staff table.
    const eq = (col, val, list) => {
      const v = oneOf(val, list);
      if (v) { params.push(v); where.push(`i.${col} = $${params.length}`); }
    };
    eq('status', req.query.status, STATUSES);
    eq('source', req.query.source, SOURCES);
    eq('report_type', req.query.type, TYPES);
    eq('severity', req.query.severity, SEVERITIES);
    eq('area', req.query.area, AREAS);
    if (req.query.assignee === 'me') {
      params.push(req.user.id); where.push(`i.assignee_staff_id = $${params.length}`);
    } else if (req.query.assignee === 'none') {
      where.push(`i.assignee_staff_id IS NULL`);
    } else if (req.query.assignee) {
      const a = parseInt(req.query.assignee, 10);
      if (Number.isInteger(a)) { params.push(a); where.push(`i.assignee_staff_id = $${params.length}`); }
    }
    if (req.query.q && String(req.query.q).trim()) {
      params.push('%' + String(req.query.q).trim() + '%');
      where.push(`(i.title ILIKE $${params.length} OR i.body ILIKE $${params.length})`);
    }
    const days = parseInt(req.query.days, 10);
    if (Number.isInteger(days) && days > 0) {
      params.push(days); where.push(`i.created_at >= now() - ($${params.length}::int || ' days')::interval`);
    }
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 300));
    params.push(limit);

    const { rows } = await db.query(
      `SELECT i.*, s.first_name || ' ' || s.last_name AS assignee_name
         FROM reports_inbox i
         LEFT JOIN staff s ON s.id = i.assignee_staff_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY i.created_at DESC
        LIMIT $${params.length}`, params);
    res.json({ ready: true, count: rows.length, reports: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /:key — one report ───────────────────────────────────────────────────
router.get('/:key', async (req, res) => {
  const k = parseKey(req.params.key);
  if (!k) return res.status(400).json({ error: 'bad key' });
  const db = getPool();
  try {
    if (!await inboxReady(db)) return res.status(503).json({ error: 'reports_inbox not installed' });
    const { rows } = await db.query(
      `SELECT i.*, s.first_name || ' ' || s.last_name AS assignee_name
         FROM reports_inbox i LEFT JOIN staff s ON s.id = i.assignee_staff_id
        WHERE i.source = $1 AND i.source_id = $2`, [k.source, k.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /:key — triage. Upserts ladn.reports_triage, never the source table. ─
// Moving to 'fixed' stamps fixed_at, which is what the close-the-loop notify
// (POST /:key/notify) and the "time to fix" stat both read.
router.patch('/:key', async (req, res) => {
  const k = parseKey(req.params.key);
  if (!k) return res.status(400).json({ error: 'bad key' });
  const b = req.body || {};
  const sets = { status: null, report_type: null, severity: null, area: null,
                 assignee_staff_id: undefined, notes: undefined };

  if (b.status !== undefined) {
    sets.status = oneOf(b.status, STATUSES);
    if (!sets.status) return res.status(400).json({ error: 'bad status' });
  }
  if (b.type !== undefined || b.report_type !== undefined) {
    sets.report_type = oneOf(b.type !== undefined ? b.type : b.report_type, TYPES);
    if (!sets.report_type) return res.status(400).json({ error: 'bad type' });
  }
  if (b.severity !== undefined) {
    if (b.severity === null || b.severity === '') sets.severity = null;
    else { sets.severity = oneOf(b.severity, SEVERITIES);
           if (!sets.severity) return res.status(400).json({ error: 'bad severity' }); }
  }
  if (b.area !== undefined) {
    sets.area = oneOf(b.area, AREAS);
    if (!sets.area) return res.status(400).json({ error: 'bad area' });
  }
  if (b.assignee_staff_id !== undefined) {
    if (b.assignee_staff_id === null || b.assignee_staff_id === '') sets.assignee_staff_id = null;
    else {
      const a = parseInt(b.assignee_staff_id, 10);
      if (!Number.isInteger(a)) return res.status(400).json({ error: 'bad assignee' });
      sets.assignee_staff_id = a;
    }
  }
  if (b.notes !== undefined) sets.notes = String(b.notes || '').slice(0, 4000);

  const db = getPool();
  try {
    // The report must actually exist in one of the source tables — otherwise a
    // typo'd key would silently create an orphan triage row.
    const { rows: found } = await db.query(
      `SELECT status FROM reports_inbox WHERE source = $1 AND source_id = $2`, [k.source, k.id]);
    if (!found.length) return res.status(404).json({ error: 'not found' });

    // COALESCE keeps every column the caller did not send. status is the one
    // NOT NULL column, so it falls back to whatever the view currently derives.
    const { rows } = await db.query(
      `INSERT INTO reports_triage
         (source, source_id, status, report_type, severity, area, assignee_staff_id, notes,
          fixed_at, updated_at, updated_by)
       VALUES ($1,$2, COALESCE($3,$9), $4, $5, $6, $7, $8,
               CASE WHEN COALESCE($3,$9) = 'fixed' THEN now() END, now(), $10)
       ON CONFLICT (source, source_id) DO UPDATE SET
         status            = COALESCE($3, reports_triage.status),
         report_type       = COALESCE($4, reports_triage.report_type),
         severity          = CASE WHEN $11 THEN $5 ELSE reports_triage.severity END,
         area              = COALESCE($6, reports_triage.area),
         assignee_staff_id = CASE WHEN $12 THEN $7 ELSE reports_triage.assignee_staff_id END,
         notes             = CASE WHEN $13 THEN $8 ELSE reports_triage.notes END,
         fixed_at          = CASE WHEN COALESCE($3, reports_triage.status) = 'fixed'
                                  THEN COALESCE(reports_triage.fixed_at, now()) ELSE NULL END,
         updated_at        = now(),
         updated_by        = $10
       RETURNING *`,
      [k.source, k.id, sets.status, sets.report_type, sets.severity, sets.area,
       sets.assignee_staff_id === undefined ? null : sets.assignee_staff_id,
       sets.notes === undefined ? null : sets.notes,
       found[0].status, req.user.id,
       b.severity !== undefined, b.assignee_staff_id !== undefined, b.notes !== undefined]);
    res.json({ ok: true, triage: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST / — quick-add (the PWA's main job) ──────────────────────────────────
// Lands in ladn.bug_reports_manual, i.e. source='manual'. Optional screenshot is
// a data URL, saved next to the staff widget's shots and served back through
// GET /:key/screenshot (never from a static path — these are staff-only).
router.post('/', async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  const report_type = oneOf(b.type || b.report_type || 'bug', TYPES);
  if (!report_type) return res.status(400).json({ error: 'bad type' });
  const severity = b.severity ? oneOf(b.severity, SEVERITIES) : null;
  if (b.severity && !severity) return res.status(400).json({ error: 'bad severity' });
  const area = b.area ? oneOf(b.area, AREAS) : null;
  if (b.area && !area) return res.status(400).json({ error: 'bad area' });

  const db = getPool();
  try {
    const { rows } = await db.query(
      `INSERT INTO bug_reports_manual
         (title, body, report_type, severity, area, page_path,
          reporter_name, reporter_email, reporter_staff_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id, created_at`,
      [title.slice(0, 300), String(b.body || '').slice(0, 5000), report_type, severity, area,
       String(b.page_path || '').slice(0, 300),
       // A manager can log something on another person's behalf; default is self.
       String(b.reporter_name || req.user.name || '').slice(0, 120) || null,
       String(b.reporter_email || req.user.email || '').slice(0, 200) || null,
       req.user.id]);
    const row = rows[0];

    let has_screenshot = false;
    if (b.screenshot && /^data:image\/(png|jpeg);base64,/.test(b.screenshot)) {
      const b64 = b.screenshot.split(',')[1] || '';
      if (b64.length < 6 * 1024 * 1024) {
        try {
          fs.mkdirSync(SHOT_DIR, { recursive: true });
          const ext = b.screenshot.startsWith('data:image/png') ? 'png' : 'jpg';
          const p = path.join(SHOT_DIR, `manual-${row.id}.${ext}`);
          fs.writeFileSync(p, Buffer.from(b64, 'base64'));
          await db.query(`UPDATE bug_reports_manual SET screenshot_path=$1 WHERE id=$2`, [p, row.id]);
          has_screenshot = true;
        } catch (fsErr) {
          // Never lose the report because the image could not be written.
          console.error('[bugs] screenshot save failed (report kept):', fsErr.message);
        }
      }
    }

    // Same in-app pipeline the other two reporters already use, so a report
    // filed here still reaches Toby without anyone opening the board.
    try {
      await db.query(
        `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
         VALUES ('staff', 1, 'bug_report', $1, $2, '/board', 'bug_reports_manual', $3, $4)`,
        [`New ${report_type} report: ${title.slice(0, 120)}`,
         String(b.body || '').slice(0, 500), row.id,
         severity === 'critical' ? 'urgent' : (report_type === 'bug' ? 'high' : 'normal')]);
    } catch (nErr) { console.error('[bugs] notification failed (report kept):', nErr.message); }

    res.status(201).json({ ok: true, key: `manual:${row.id}`, id: row.id,
      created_at: row.created_at, has_screenshot });
  } catch (e) {
    console.error('[bugs] quick-add error:', e.message);
    res.status(500).json({ error: 'Could not save report' });
  }
});

// ── GET /:key/screenshot — staff-only image bytes ───────────────────────────
// Only the two sources that store an image have one; the rest 404 cleanly.
router.get('/:key/screenshot', async (req, res) => {
  const k = parseKey(req.params.key);
  if (!k) return res.status(400).json({ error: 'bad key' });
  const table = k.source === 'staff-app' ? 'feedback_reports'
              : k.source === 'manual'    ? 'bug_reports_manual' : null;
  if (!table) return res.status(404).json({ error: 'no screenshot for this source' });
  try {
    const { rows } = await getPool().query(
      `SELECT screenshot_path FROM ${table} WHERE id = $1`, [k.id]);
    const p = rows[0] && rows[0].screenshot_path;
    if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'no screenshot' });
    res.type(p.endsWith('.png') ? 'image/png' : 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(p).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:key/notify — close the loop ───────────────────────────────────────
// Optional, manager-only, and only once a report is actually fixed. Writes an
// in-app notification to the ORIGINAL reporter using each source's own identity:
//   staff-app / manual → recipient_type='staff', the submitting staff id
//   parent-app         → recipient_type='parent', keyed on child_id (the
//                        convention the parents portal reads notifications by)
// getwren reports came from a web form with no account, so there is nobody to
// notify in-app — that returns a clear 'no_in_app_recipient' rather than pretending.
router.post('/:key/notify', managerOnly, async (req, res) => {
  const k = parseKey(req.params.key);
  if (!k) return res.status(400).json({ error: 'bad key' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT * FROM reports_inbox WHERE source = $1 AND source_id = $2`, [k.source, k.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const r = rows[0];
    if (r.status !== 'fixed') {
      return res.status(400).json({ error: 'not_fixed', message: 'Only a fixed report can close the loop.' });
    }

    let recipient_type = null, recipient_id = null, link = null;
    if (r.source === 'parent-app') {
      if (r.reporter_child_id != null) {
        recipient_type = 'parent'; recipient_id = r.reporter_child_id; link = '/welcome';
      }
    } else if (r.reporter_staff_id != null) {
      recipient_type = 'staff'; recipient_id = r.reporter_staff_id; link = '/board';
    }
    if (!recipient_type) {
      return res.status(422).json({ error: 'no_in_app_recipient',
        message: r.source === 'getwren'
          ? 'This came from the public getwren.co.uk form — there is no in-app account to notify.'
          : 'This report has no linked account to notify in-app.' });
    }

    const note = String((req.body || {}).message || '').slice(0, 500);
    await db.query(
      `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
       VALUES ($1,$2,'report_fixed',$3,$4,$5,'reports_inbox',$6,'normal')`,
      [recipient_type, recipient_id,
       'Thanks — the thing you reported is fixed',
       note || `"${String(r.title || '').slice(0, 120)}" has been fixed. Thank you for reporting it.`,
       link, k.id]);
    await db.query(
      `INSERT INTO reports_triage (source, source_id, status, reporter_notified_at, updated_at, updated_by)
       VALUES ($1,$2,'fixed',now(),now(),$3)
       ON CONFLICT (source, source_id) DO UPDATE
         SET reporter_notified_at = now(), updated_at = now(), updated_by = $3`,
      [k.source, k.id, req.user.id]);
    res.json({ ok: true, notified: `${recipient_type}:${recipient_id}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /app-ping — install / launch telemetry ─────────────────────────────
// The traffic beacon cannot distinguish an installed PWA from a browser tab, so
// the app tells us directly: display_mode 'standalone' (or the appinstalled
// event) means it is installed on that device. install_id is a random per-device
// string generated client-side — no device fingerprinting, no PII.
router.post('/app-ping', async (req, res) => {
  const b = req.body || {};
  const app = String(b.app || 'bugs').slice(0, 40);
  const install_id = String(b.install_id || '').slice(0, 80);
  if (!install_id) return res.status(204).end();
  const display_mode = String(b.display_mode || '').slice(0, 30) || null;
  const installed = b.installed === true || display_mode === 'standalone';
  try {
    await getPool().query(
      `INSERT INTO app_installs (app, install_id, display_mode, installed, staff_id, user_agent, platform)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (app, install_id) DO UPDATE SET
         last_seen    = now(),
         launches     = app_installs.launches + 1,
         display_mode = COALESCE(EXCLUDED.display_mode, app_installs.display_mode),
         -- once installed, stays installed: a later browser-tab visit from the
         -- same device must not un-count the install
         installed    = app_installs.installed OR EXCLUDED.installed,
         staff_id     = COALESCE(EXCLUDED.staff_id, app_installs.staff_id)`,
      [app, install_id, display_mode, installed, req.user.id,
       String(req.headers['user-agent'] || '').slice(0, 300),
       String(b.platform || '').slice(0, 60) || null]);
    res.status(204).end();
  } catch (e) {
    console.error('[bugs] app-ping failed:', e.message);
    res.status(204).end();   // telemetry must never surface an error to the app
  }
});

// ── GitHub stats ─────────────────────────────────────────────────────────────
// Public-repo counters only (stars/forks/watchers/issues) — these need no token.
// Clone and view counts live behind /traffic, which REQUIRES a push-scoped token;
// with no token configured we report them as unavailable instead of guessing.
const GH_REPO  = process.env.WREN_GITHUB_REPO || 'tbusiness25/wren-platform';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.WREN_GITHUB_TOKEN || '';
let _ghCache = { at: 0, data: null };

async function githubStats() {
  if (_ghCache.data && Date.now() - _ghCache.at < 30 * 60 * 1000) return _ghCache.data;
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'wren-bugs-board' };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;
  const out = { repo: GH_REPO, available: false, reason: null };
  try {
    const ctl = AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined;
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}`, { headers, signal: ctl });
    if (r.status === 404) { out.reason = 'no public repo found at ' + GH_REPO; }
    else if (!r.ok)       { out.reason = `GitHub API returned ${r.status}`; }
    else {
      const j = await r.json();
      if (j.private) { out.reason = 'repo exists but is private'; }
      else {
        out.available = true;
        out.html_url    = j.html_url;
        out.stars       = j.stargazers_count;
        out.forks       = j.forks_count;
        out.watchers    = j.subscribers_count;
        out.open_issues = j.open_issues_count;
        out.pushed_at   = j.pushed_at;
        out.created_at  = j.created_at;
        out.language    = j.language;
        // Traffic (clones/unique cloners) — token-gated by GitHub itself.
        if (GH_TOKEN) {
          try {
            const [c, v] = await Promise.all([
              fetch(`https://api.github.com/repos/${GH_REPO}/traffic/clones`, { headers }),
              fetch(`https://api.github.com/repos/${GH_REPO}/traffic/views`,  { headers }),
            ]);
            if (c.ok) { const cj = await c.json(); out.clones = cj.count; out.unique_cloners = cj.uniques; }
            if (v.ok) { const vj = await v.json(); out.views  = vj.count; out.unique_visitors = vj.uniques; }
          } catch (_) { /* counters above still stand */ }
        }
        if (out.clones === undefined) {
          out.clones_note = GH_TOKEN
            ? 'GitHub declined the traffic API for this token (needs push access)'
            : 'no data — clone counts need a GitHub token with push access (set GITHUB_TOKEN)';
        }
      }
    }
  } catch (e) {
    out.reason = 'could not reach the GitHub API: ' + e.message;
  }
  _ghCache = { at: Date.now(), data: out };
  return out;
}

// ── GET /stats/adoption — the adoption dashboard's single call ──────────────
// Everything here is a real query against real rows. Anything with no source of
// truth is returned as an explicit {available:false, reason} so the page can
// print "no data" rather than a plausible-looking zero.
router.get('/stats/adoption', async (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const db = getPool();
  const out = { days, generated_at: new Date().toISOString() };
  try {
    // ── Who has left comments ────────────────────────────────────────────────
    if (await inboxReady(db)) {
      out.reports = { available: true };
      out.reports.totals = (await db.query(
        `SELECT count(*)::int AS all_time,
                count(*) FILTER (WHERE created_at >= now() - ($1::int || ' days')::interval)::int AS window
           FROM reports_inbox`, [days])).rows[0];
      out.reports.by_source = (await db.query(
        `SELECT source, count(*)::int AS reports,
                count(DISTINCT COALESCE(reporter_email, reporter_name,
                                        'sid:' || reporter_staff_id))::int AS people
           FROM reports_inbox GROUP BY source ORDER BY reports DESC`)).rows;
      out.reports.by_status = (await db.query(
        `SELECT status, count(*)::int AS c FROM reports_inbox GROUP BY status`)).rows;
      out.reports.by_type = (await db.query(
        `SELECT report_type, count(*)::int AS c FROM reports_inbox GROUP BY report_type ORDER BY c DESC`)).rows;
      // Named contributors — staff by name, everyone else by the identity their
      // source recorded. Staff-auth only; never rendered on a public page.
      out.reports.top_reporters = (await db.query(
        `SELECT COALESCE(NULLIF(reporter_name,''), reporter_email, 'anonymous') AS who,
                source, count(*)::int AS reports, max(created_at) AS last_report
           FROM reports_inbox
          GROUP BY 1, 2 ORDER BY reports DESC, last_report DESC LIMIT 15`)).rows;
      out.reports.over_time = (await db.query(
        `SELECT date_trunc('day', created_at)::date::text AS date, source, count(*)::int AS c
           FROM reports_inbox
          WHERE created_at >= now() - ($1::int || ' days')::interval
          GROUP BY 1, 2 ORDER BY 1`, [days])).rows;
      out.reports.fix_stats = (await db.query(
        `SELECT count(*) FILTER (WHERE status = 'fixed')::int AS fixed,
                count(*) FILTER (WHERE reporter_notified_at IS NOT NULL)::int AS loop_closed
           FROM reports_inbox`)).rows[0];
    } else {
      out.reports = { available: false, reason: 'reports_inbox view not installed on this edition' };
    }

    // ── Traffic / engagement (first-party beacon) ────────────────────────────
    const hasHits = (await db.query(
      `SELECT to_regclass(current_schema() || '.page_hits') AS t`)).rows[0].t;
    if (hasHits) {
      const by_host = (await db.query(
        `SELECT host, COALESCE(sum(hits),0)::int AS views,
                count(DISTINCT session_id)::int AS visitors,
                round(avg(EXTRACT(EPOCH FROM (last_seen - first_seen)))::numeric, 0)::int AS avg_dwell_s,
                max(day)::text AS last_seen_day
           FROM page_hits WHERE day >= CURRENT_DATE - ($1::int - 1)
          GROUP BY host ORDER BY views DESC`, [days])).rows;
      const over_time = (await db.query(
        `SELECT day::text AS date, COALESCE(sum(hits),0)::int AS views,
                count(DISTINCT session_id)::int AS visitors
           FROM page_hits WHERE day >= CURRENT_DATE - ($1::int - 1)
          GROUP BY day ORDER BY day`, [days])).rows;
      const all_time = (await db.query(
        `SELECT COALESCE(sum(hits),0)::int AS views, count(DISTINCT session_id)::int AS visitors,
                min(day)::text AS since FROM page_hits`)).rows[0];
      out.traffic = by_host.length || all_time.views
        ? { available: true, by_host, over_time, all_time }
        : { available: false, reason: 'the traffic beacon has recorded no page views yet' };
    } else {
      out.traffic = { available: false, reason: 'page_hits not present on this edition' };
    }

    // ── Installs (PWA) ───────────────────────────────────────────────────────
    const hasInstalls = (await db.query(
      `SELECT to_regclass(current_schema() || '.app_installs') AS t`)).rows[0].t;
    if (hasInstalls) {
      const by_app = (await db.query(
        `SELECT app,
                count(*)::int AS devices,
                count(*) FILTER (WHERE installed)::int AS installed_devices,
                count(DISTINCT staff_id) FILTER (WHERE staff_id IS NOT NULL)::int AS people,
                COALESCE(sum(launches),0)::int AS launches,
                max(last_seen) AS last_launch
           FROM app_installs GROUP BY app ORDER BY installed_devices DESC, devices DESC`)).rows;
      out.installs = by_app.length
        ? { available: true, by_app,
            note: 'Only apps that send /api/bugs/app-ping appear here. The bugs PWA reports; the EY, Roost, HR and parents apps are not yet instrumented, so their installs are unknown rather than zero.' }
        : { available: false, reason: 'no app has reported an install or launch yet' };
    } else {
      out.installs = { available: false, reason: 'app_installs not present on this edition' };
    }

    // ── GitHub ───────────────────────────────────────────────────────────────
    out.github = await githubStats();

    res.json(out);
  } catch (e) {
    console.error('[bugs] adoption stats error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
