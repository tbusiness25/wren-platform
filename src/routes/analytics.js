'use strict';
// Lightweight first-party traffic analytics (2026-07-30). No cookies, no PII —
// a random per-tab session id + path + host, with dwell time (first→last beacon).
// The /beacon endpoint is PUBLIC + CORS-open (anonymous counts only) so both the
// parents app AND the getwren landing site can report; /summary is manager-only.
const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('./../middleware/auth');
const { requireRole } = require('./../middleware/auth');
const { singleInstanceOnly } = require('../lib/tenant-guard');

// ── b264: SINGLE-INSTANCE BY DESIGN ──────────────────────────────────────────
// page_hits and getwren_leads are Wren-the-company's own marketing telemetry for
// getwren.co.uk and the demo sites. They are NOT a per-setting feature: a nursery
// tenant has no use for them, and a second copy accumulating in another schema is
// worse than nothing because it splits the numbers silently.
//
// b264 de-qualified the SQL here (it used to write `ladn.page_hits` from whatever
// schema the process was on). De-qualification alone would have let a mount in
// wren-htps quietly start a parallel set of counters, so the module also refuses
// to serve unless PG_SCHEMA is the home instance.
router.use(singleInstanceOnly('analytics', 'getwren.co.uk traffic counters and product leads'));

// CORS preflight + headers for the public beacon (getwren is a different origin).
router.options('/beacon', (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.status(204).end();
});

// POST /beacon — record a page view + refresh dwell. Never errors (best-effort).
router.post('/beacon', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const b = req.body || {};
    const host = String(b.host || req.headers['host'] || '').slice(0, 120).toLowerCase();
    const path = String(b.path || '/').slice(0, 300);
    const sid  = String(b.sid || b.session_id || '').slice(0, 80);
    if (!host || !sid) return res.status(204).end();
    const db = getPool();
    await db.query(
      `INSERT INTO page_hits (host, path, session_id) VALUES ($1,$2,$3)
       ON CONFLICT (session_id, path, day)
       DO UPDATE SET last_seen = now(), hits = page_hits.hits + 1`,
      [host, path, sid]);
    res.status(204).end();
  } catch (_) { try { res.status(204).end(); } catch (__) {} }
});

// GET /summary?days=7 — traffic summary (manager/deputy). When mounted behind the
// staff auth middleware req.user is set; if reached anonymously it still refuses.
// b367 (2026-09-29): this route read req.user.role, but nothing on this router ever SET
// req.user — /beacon is public by design, so there is no router-level authenticate() here.
// req.user was therefore always undefined and the route answered 403 "Manager only" to
// everyone, including a manager: /traffic-stats.html could never load. authenticate is
// applied to this route only, leaving /beacon public.
router.get('/summary', authenticate, async (req, res) => {
  const role = req.user && req.user.role;
  if (!role || !['manager', 'deputy_manager', 'admin'].includes(role)) return res.status(403).json({ error: 'Manager only' });
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    const db = getPool();
    const { rows: by_host } = await db.query(
      `SELECT host,
              count(*)                                              AS page_views,
              count(DISTINCT session_id)                            AS visitors,
              round(avg(EXTRACT(EPOCH FROM (last_seen - first_seen)))::numeric, 0) AS avg_dwell_s
         FROM page_hits
        WHERE day >= CURRENT_DATE - ($1::int - 1)
        GROUP BY host ORDER BY page_views DESC`, [days]);
    const { rows: top_pages } = await db.query(
      `SELECT host, path, count(*) AS views, count(DISTINCT session_id) AS visitors
         FROM page_hits WHERE day >= CURRENT_DATE - ($1::int - 1)
        GROUP BY host, path ORDER BY views DESC LIMIT 25`, [days]);
    res.json({ days, by_host, top_pages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/analytics/getwren-summary?days=30 — marketing-site analytics for the
// Roost cockpit (manager/deputy only). Aggregates the traffic beacon (page_hits)
// with getwren leads (public.wren_leads — live form) + feedback/leads captured to
// getwren_leads. All non-child marketing data. Missing tables → empty, never 500.
router.get('/getwren-summary', requireRole('manager', 'deputy_manager'), async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const db = getPool();
    const MKT = `(host IN ('getwren.co.uk','www.getwren.co.uk'))`;
    const DEMO = `(host LIKE '%.getwren.co.uk' AND host NOT IN ('www.getwren.co.uk'))`;
    const WIN = `day >= CURRENT_DATE - ($1::int - 1)`;

    // Marketing traffic totals + daily series + top pages
    const totals = (await db.query(
      `SELECT COALESCE(sum(hits),0)::int AS page_views,
              count(DISTINCT session_id)::int AS visitors,
              round(avg(EXTRACT(EPOCH FROM (last_seen - first_seen)))::numeric,0) AS avg_dwell_s
         FROM page_hits WHERE ${MKT} AND ${WIN}`, [days])).rows[0];
    const daily = (await db.query(
      `SELECT day::text AS date, COALESCE(sum(hits),0)::int AS views,
              count(DISTINCT session_id)::int AS visitors
         FROM page_hits WHERE ${MKT} AND ${WIN}
        GROUP BY day ORDER BY day`, [days])).rows;
    const top_pages = (await db.query(
      `SELECT path, COALESCE(sum(hits),0)::int AS views, count(DISTINCT session_id)::int AS visitors
         FROM page_hits WHERE ${MKT} AND ${WIN}
        GROUP BY path ORDER BY views DESC LIMIT 12`, [days])).rows;
    const demo_visits = (await db.query(
      `SELECT host, COALESCE(sum(hits),0)::int AS views, count(DISTINCT session_id)::int AS visitors
         FROM page_hits WHERE ${DEMO} AND ${WIN}
        GROUP BY host ORDER BY views DESC LIMIT 12`, [days])).rows;

    // Leads (live form → public.wren_leads)
    let leads = { total: 0, window: 0, by_status: {} };
    if (await db.query(`SELECT to_regclass('public.wren_leads') t`).then(r => r.rows[0].t)) {
      const lr = (await db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE created_at >= now() - ($1::int || ' days')::interval)::int AS window
           FROM public.wren_leads`, [days])).rows[0];
      const st = (await db.query(`SELECT status, count(*)::int c FROM public.wren_leads GROUP BY status`)).rows;
      leads = { total: lr.total, window: lr.window, by_status: {} };
      st.forEach(r => { leads.by_status[r.status || 'new'] = r.c; });
    }

    // getwren_leads (feedback + any /api/public/lead captures) + UTM breakdown
    let feedback = { total: 0, window: 0, recent: [] };
    let gl_leads = { total: 0, window: 0 };
    let utm = [];
    if (await db.query(`SELECT to_regclass('getwren_leads') t`).then(r => r.rows[0].t)) {
      const fb = (await db.query(
        `SELECT count(*) FILTER (WHERE kind='feedback')::int AS fb_total,
                count(*) FILTER (WHERE kind='feedback' AND created_at >= now()-($1::int||' days')::interval)::int AS fb_window,
                count(*) FILTER (WHERE kind='lead')::int AS lead_total,
                count(*) FILTER (WHERE kind='lead' AND created_at >= now()-($1::int||' days')::interval)::int AS lead_window
           FROM getwren_leads`, [days])).rows[0];
      feedback.total = fb.fb_total; feedback.window = fb.fb_window;
      gl_leads = { total: fb.lead_total, window: fb.lead_window };
      feedback.recent = (await db.query(
        `SELECT id, name, edition_interest, left(message, 240) AS message, source_page, created_at
           FROM getwren_leads WHERE kind='feedback' ORDER BY created_at DESC LIMIT 8`)).rows;
      utm = (await db.query(
        `SELECT COALESCE(utm->>'source','(direct)') AS source, count(*)::int AS n
           FROM getwren_leads
          WHERE created_at >= now()-($1::int||' days')::interval
          GROUP BY 1 ORDER BY n DESC LIMIT 10`, [days])).rows;
    }

    const totalLeadsWindow = (leads.window || 0) + (gl_leads.window || 0);
    const conversion = totals.visitors > 0 ? +( (totalLeadsWindow / totals.visitors) * 100 ).toFixed(1) : 0;

    res.json({
      days,
      totals: { page_views: totals.page_views, visitors: totals.visitors, avg_dwell_s: Number(totals.avg_dwell_s) || 0 },
      daily, top_pages, demo_visits,
      leads: { total: leads.total + gl_leads.total, window: totalLeadsWindow, by_status: leads.by_status },
      feedback, utm,
      conversion_pct: conversion,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
