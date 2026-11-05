'use strict';
// b201 — Guided tour: per-staff progress + a deterministic "where do I find X?"
// lookup over the tour corpus.
//
// The corpus itself (public/js/wren-tour-content.js) is require()-able from Node,
// so the browser engine, this API and the RAG ingest all read ONE source of truth.
//
// Multi-tenant note: table names are deliberately UNQUALIFIED so they resolve
// through the pool's search_path (PG_SCHEMA) — a hard-coded `ladn.` here would
// send demo/school-edition writes at production, which has bitten this codebase
// before (see the 2026-07-04 phonics_tracker fix).
const express = require('express');
const path = require('path');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const CONTENT = require(path.join(__dirname, '..', '..', 'public', 'js', 'wren-tour-content.js'));

// ── Self-healing table (additive, idempotent) ───────────────────────────────
let _initPromise = null;
function ensureTable() {
  if (_initPromise) return _initPromise;
  const pool = getPool();
  _initPromise = pool.query(`
    CREATE TABLE IF NOT EXISTS tour_progress (
      id              bigserial PRIMARY KEY,
      staff_id        integer     NOT NULL,
      portal          text        NOT NULL,
      track           text        NOT NULL DEFAULT 'everything',
      step_id         text,
      completed_steps jsonb       NOT NULL DEFAULT '[]'::jsonb,
      completed       boolean     NOT NULL DEFAULT false,
      started_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tour_progress_uq UNIQUE (staff_id, portal, track)
    )
  `)
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS tour_progress_staff_idx ON tour_progress (staff_id)`))
    .catch(e => {
      console.error('[tour] table init failed:', e.message);
      _initPromise = null;               // let the next request retry
      throw e;
    });
  return _initPromise;
}

const VALID_PORTALS = new Set(Object.keys(CONTENT.portals));
function normPortal(p) {
  p = String(p || '').trim().toLowerCase();
  if (!VALID_PORTALS.has(p)) return null;
  const resolved = CONTENT.portalOf(p);
  return resolved ? resolved.key : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC (pre-auth) — the corpus and the lookup carry no personal data at all.
// They are how the assistant, the in-app help and the parents portal (which has
// no staff session) answer "where do I find X?".
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/tour/content?portal=roost — steps + tracks
router.get('/content', (req, res) => {
  const portal = req.query.portal ? normPortal(req.query.portal) : null;
  if (req.query.portal && !portal) return res.status(400).json({ error: 'unknown portal' });
  const portals = portal ? [portal] : Object.keys(CONTENT.portals).filter(k => !CONTENT.portals[k].aliasOf);
  res.json({
    version: CONTENT.version,
    portals: portals.map(k => {
      const p = CONTENT.portalOf(k);
      return {
        key: p.key, label: p.label, subtitle: p.subtitle,
        tracks: p.tracks,
        steps: p.steps.map(s => ({
          id: s.id, url: s.url, title: s.title, what: s.what, does: s.does,
          gotcha: s.gotcha, tracks: s.tracks, tags: s.tags,
          status: s.status, issue: s.issue || null,
        })),
      };
    }),
  });
});

// GET /api/tour/find?q=how do I add a child&portal=&limit=
// The deterministic half of "where do I find X?" — no model, no embeddings, so it
// works when Ollama or qdrant are down.
router.get('/find', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  const portal = req.query.portal ? normPortal(req.query.portal) : null;
  const limit = Math.min(10, Math.max(1, parseInt(req.query.limit || '5', 10) || 5));
  const hits = CONTENT.find(q, { portal: portal || undefined, limit });
  res.json({
    query: q,
    results: hits.map(h => ({
      id: h.id, portal: h.portal, title: h.title, url: h.url,
      link: portalLink(h.portal, h.url),
      what: CONTENT.strip(h.what), does: CONTENT.strip(h.does), gotcha: CONTENT.strip(h.gotcha),
      status: h.status, issue: h.issue ? CONTENT.strip(h.issue) : null,
      score: h.score,
    })),
  });
});

// GET /api/tour/page?path=/admin/finance/funding&portal=roost — contextual help
router.get('/page', (req, res) => {
  const portal = normPortal(req.query.portal || 'roost');
  if (!portal) return res.status(400).json({ error: 'unknown portal' });
  const step = CONTENT.forUrl(portal, req.query.path || '/');
  if (!step) return res.status(404).json({ error: 'no step for that page' });
  res.json({
    id: step.id, portal: step.portal, title: step.title, url: step.url,
    link: portalLink(step.portal, step.url),
    what: CONTENT.strip(step.what), does: CONTENT.strip(step.does), gotcha: CONTENT.strip(step.gotcha),
    status: step.status, issue: step.issue ? CONTENT.strip(step.issue) : null,
  });
});

// Absolute link for a step, so an answer in the assistant is clickable from any
// portal. Hosts come from env where set; otherwise a relative path (correct when
// you are already on the right portal).
const HOSTS = {
  roost:   process.env.TOUR_HOST_ADMIN   || process.env.ADMIN_PORTAL_URL   || '',
  ey:      process.env.TOUR_HOST_EY      || process.env.EY_PORTAL_URL      || '',
  parents: process.env.TOUR_HOST_PARENTS || process.env.PARENTS_PORTAL_URL || '',
  hr:      process.env.TOUR_HOST_HR      || process.env.HR_PORTAL_URL      || '',
};
function portalLink(portal, url) {
  const base = (HOSTS[portal] || '').replace(/\/+$/, '');
  return base ? base + url : url;
}
router._portalLink = portalLink;

// ══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED — per-staff progress
// ══════════════════════════════════════════════════════════════════════════════
router.use(authenticate);

function staffId(req) {
  const id = req.user && (req.user.id || req.user.staff_id);
  return Number.isFinite(Number(id)) ? Number(id) : null;
}

// GET /api/tour/progress — every track this staff member has started
router.get('/progress', async (req, res) => {
  const sid = staffId(req);
  if (!sid) return res.status(401).json({ error: 'no staff id on token' });
  try {
    await ensureTable();
    const { rows } = await getPool().query(
      `SELECT portal, track, step_id, completed_steps, completed, started_at, updated_at
         FROM tour_progress WHERE staff_id = $1 ORDER BY updated_at DESC`, [sid]);
    res.json({
      staff_id: sid,
      version: CONTENT.version,
      entries: rows.map(r => {
        const total = CONTENT.stepsFor(r.portal, r.track).length;
        const done = Array.isArray(r.completed_steps) ? r.completed_steps.length : 0;
        return Object.assign({}, r, {
          total_steps: total,
          percent: total ? Math.min(100, Math.round((done / total) * 100)) : 0,
        });
      }),
    });
  } catch (e) {
    console.error('[tour] progress read failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tour/progress { portal, track, step_id?, completed_step?, completed? }
router.post('/progress', async (req, res) => {
  const sid = staffId(req);
  if (!sid) return res.status(401).json({ error: 'no staff id on token' });
  const portal = normPortal(req.body && req.body.portal);
  if (!portal) return res.status(400).json({ error: 'portal required' });
  const track = String((req.body && req.body.track) || 'everything').slice(0, 64);
  const stepId = req.body && req.body.step_id ? String(req.body.step_id).slice(0, 128) : null;
  const completedStep = req.body && req.body.completed_step ? String(req.body.completed_step).slice(0, 128) : null;
  const completed = !!(req.body && req.body.completed);
  // Reject step ids that are not in the corpus — stops junk accumulating in the
  // jsonb array and keeps the percentages meaningful.
  if (stepId && !CONTENT.stepById(stepId)) return res.status(400).json({ error: 'unknown step_id' });
  if (completedStep && !CONTENT.stepById(completedStep)) return res.status(400).json({ error: 'unknown completed_step' });

  try {
    await ensureTable();
    const { rows } = await getPool().query(
      `INSERT INTO tour_progress (staff_id, portal, track, step_id, completed_steps, completed)
            VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '[]'::jsonb), $6)
       ON CONFLICT (staff_id, portal, track) DO UPDATE
            SET step_id   = COALESCE(EXCLUDED.step_id, tour_progress.step_id),
                completed = tour_progress.completed OR EXCLUDED.completed,
                completed_steps = CASE
                  WHEN $7::text IS NULL THEN tour_progress.completed_steps
                  WHEN tour_progress.completed_steps @> to_jsonb(ARRAY[$7::text]) THEN tour_progress.completed_steps
                  ELSE tour_progress.completed_steps || to_jsonb(ARRAY[$7::text])
                END,
                updated_at = now()
       RETURNING portal, track, step_id, completed_steps, completed, started_at, updated_at`,
      [sid, portal, track, stepId, completedStep ? JSON.stringify([completedStep]) : null, completed, completedStep]);
    const r = rows[0];
    const total = CONTENT.stepsFor(r.portal, r.track).length;
    const done = Array.isArray(r.completed_steps) ? r.completed_steps.length : 0;
    res.json({
      ok: true,
      entry: Object.assign({}, r, {
        total_steps: total,
        percent: total ? Math.min(100, Math.round((done / total) * 100)) : 0,
      }),
    });
  } catch (e) {
    console.error('[tour] progress write failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tour/progress?portal=&track=  — start a track again from scratch
router.delete('/progress', async (req, res) => {
  const sid = staffId(req);
  if (!sid) return res.status(401).json({ error: 'no staff id on token' });
  const portal = req.query.portal ? normPortal(req.query.portal) : null;
  const track = req.query.track ? String(req.query.track).slice(0, 64) : null;
  try {
    await ensureTable();
    const params = [sid];
    let sql = 'DELETE FROM tour_progress WHERE staff_id = $1';
    if (portal) { params.push(portal); sql += ` AND portal = $${params.length}`; }
    if (track) { params.push(track); sql += ` AND track = $${params.length}`; }
    const r = await getPool().query(sql, params);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error('[tour] progress delete failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tour/team — manager view: who has done what (names only, no content)
router.get('/team', async (req, res) => {
  const role = (req.user && req.user.role) || '';
  if (!['manager', 'deputy_manager', 'admin'].includes(role)) {
    return res.status(403).json({ error: 'manager only' });
  }
  try {
    await ensureTable();
    const { rows } = await getPool().query(
      `SELECT tp.staff_id, s.first_name, s.last_name, tp.portal, tp.track,
              tp.completed, tp.updated_at,
              jsonb_array_length(tp.completed_steps) AS steps_done
         FROM tour_progress tp
         LEFT JOIN staff s ON s.id = tp.staff_id
        ORDER BY tp.updated_at DESC LIMIT 500`);
    res.json({
      entries: rows.map(r => Object.assign({}, r, {
        total_steps: CONTENT.stepsFor(r.portal, r.track).length,
      })),
    });
  } catch (e) {
    console.error('[tour] team read failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
