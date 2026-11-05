'use strict';
// ============================================================================
// b517 — Website analytics for getwren.co.uk (2026-10-20). Manager only.
//
// Reads the per-day counts that scripts/site-analytics-ingest.js writes from the
// wren-landing web-server log. Nothing here touches child or family data, and
// nothing here holds an IP address — the tables are counts per day, and the
// salted visitor hashes the job uses are deleted as soon as a day closes.
//
// This is Wren-the-company's own marketing telemetry, exactly like
// src/routes/analytics.js, so it is single-instance by the same guard: a second
// copy accumulating in another tenant's schema would split the numbers silently.
// ============================================================================

const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { singleInstanceOnly } = require('../lib/tenant-guard');

router.use(singleInstanceOnly('site-analytics', 'getwren.co.uk web-server traffic counters'));
router.use(requireRole('manager'));

// Marketing hosts, in the order the page shows them.
const HOSTS = ['getwren.co.uk', 'phonics.getwren.co.uk'];

function range(q) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const to   = iso.test(String(q.to   || '')) ? q.to   : null;
  const from = iso.test(String(q.from || '')) ? q.from : null;
  if (from && to) return { from, to };
  const days = Math.min(730, Math.max(1, parseInt(q.days, 10) || 30));
  return { from: null, to: null, days };
}

// One WHERE clause and one parameter list, shared by every query below so the
// range, the host filter and the section filter can never drift apart.
function scope(r, q, extraCols) {
  const params = [];
  const where = [];
  if (r.from && r.to) {
    params.push(r.from, r.to);
    where.push(`day BETWEEN $1::date AND $2::date`);
  } else {
    params.push(r.days);
    where.push(`day > CURRENT_DATE - $1::int AND day <= CURRENT_DATE`);
  }
  const host = String(q.host || '').trim().toLowerCase();
  if (host && host !== 'all') { params.push(host); where.push(`host = $${params.length}`); }
  if (extraCols && extraCols.section) {
    const section = String(q.section || '').trim().toLowerCase();
    if (section && section !== 'all') { params.push(section); where.push(`section = $${params.length}`); }
  }
  return { where: where.join(' AND '), params };
}

const GRAIN = { day: 'day', week: "date_trunc('week', day)::date", month: "date_trunc('month', day)::date" };

// ── GET /api/site-analytics/summary ─────────────────────────────────────────
// Everything the Roost page needs, in one call. A missing table is never a 500:
// the page is readable before the first ingest run has happened.
router.get('/summary', async (req, res) => {
  try {
    const db = getPool();
    const r  = range(req.query);
    const s  = scope(r, req.query);
    const sp = scope(r, req.query, { section: true });
    const grain = GRAIN[String(req.query.grain || 'day')] || GRAIN.day;

    const exists = async (t) => !!(await db.query(`SELECT to_regclass($1) AS t`, [t])).rows[0].t;
    if (!await exists('site_hits_daily')) {
      return res.json({ ready: false, message: 'No website analytics yet — the ingest job has not run.' });
    }

    const one = async (sql, params) => (await db.query(sql, params)).rows;

    const totals = (await one(`
      SELECT COALESCE(sum(page_views),0)::int     AS page_views,
             COALESCE(sum(page_views_raw),0)::int AS page_views_raw,
             COALESCE(sum(visitors),0)::int       AS visitors,
             COALESCE(sum(visitors_raw),0)::int   AS visitors_raw,
             COALESCE(sum(downloads),0)::int      AS downloads,
             COALESCE(sum(downloads_raw),0)::int  AS downloads_raw,
             COALESCE(sum(bot_hits),0)::int       AS bot_hits,
             COALESCE(sum(scanner_hits),0)::int   AS scanner_hits,
             COALESCE(sum(preview_hits),0)::int   AS preview_hits,
             COALESCE(sum(total_requests),0)::int AS total_requests,
             count(DISTINCT day)::int             AS days_with_data
        FROM site_hits_daily WHERE ${s.where}`, s.params))[0];

    // Visitors are unique per day, so a week's "visitors" is the sum of its days:
    // somebody who came back on Tuesday is a second visit, not a second person.
    // Said plainly on the page rather than quietly presented as unique people.
    const series = await one(`
      SELECT ${grain} AS date,
             sum(page_views)::int   AS page_views,
             sum(visitors)::int     AS visitors,
             sum(downloads)::int    AS downloads,
             sum(bot_hits)::int     AS bot_hits,
             sum(preview_hits)::int AS preview_hits
        FROM site_hits_daily WHERE ${s.where}
       GROUP BY 1 ORDER BY 1`, s.params);

    const by_host = await one(`
      SELECT host, sum(page_views)::int AS page_views, sum(visitors)::int AS visitors,
             sum(downloads)::int AS downloads, sum(bot_hits + scanner_hits)::int AS robot_hits,
             sum(total_requests)::int AS total_requests
        FROM site_hits_daily WHERE ${s.where}
       GROUP BY host ORDER BY page_views DESC, total_requests DESC`, s.params);

    const by_section = await exists('site_page_daily') ? await one(`
      SELECT section,
             COALESCE(sum(views) FILTER (WHERE kind = 'page'),0)::int     AS views,
             COALESCE(sum(views) FILTER (WHERE kind = 'download'),0)::int AS downloads,
             COALESCE(sum(entries),0)::int                                AS entries,
             count(DISTINCT path) FILTER (WHERE views > 0)::int           AS pages_read
        FROM site_page_daily WHERE ${s.where}
       GROUP BY section ORDER BY views DESC, downloads DESC`, s.params) : [];

    const top_pages = await exists('site_page_daily') ? await one(`
      SELECT path, section, sum(views)::int AS views, sum(entries)::int AS entries,
             sum(bot_hits)::int AS bot_hits
        FROM site_page_daily WHERE ${sp.where} AND kind = 'page'
       GROUP BY path, section HAVING sum(views) > 0
       ORDER BY views DESC LIMIT 25`, sp.params) : [];

    const top_downloads = await exists('site_page_daily') ? await one(`
      SELECT path, section, sum(views)::int AS views
        FROM site_page_daily WHERE ${sp.where} AND kind = 'download'
       GROUP BY path, section HAVING sum(views) > 0
       ORDER BY views DESC LIMIT 25`, sp.params) : [];

    const entry_pages = await exists('site_page_daily') ? await one(`
      SELECT path, section, sum(entries)::int AS entries
        FROM site_page_daily WHERE ${sp.where}
       GROUP BY path, section HAVING sum(entries) > 0
       ORDER BY entries DESC LIMIT 15`, sp.params) : [];

    // Pages the crawlers read that no corroborated person did — useful for SEO
    // (it is what the robots think the site is about) and nothing else.
    const bot_only_pages = await exists('site_page_daily') ? await one(`
      SELECT path, section, sum(bot_hits)::int AS bot_hits
        FROM site_page_daily WHERE ${sp.where} AND kind = 'page'
       GROUP BY path, section HAVING sum(views) = 0 AND sum(bot_hits) > 0
       ORDER BY bot_hits DESC LIMIT 10`, sp.params) : [];

    const referrer_groups = await exists('site_ref_daily') ? await one(`
      SELECT ref_group AS "group", sum(hits)::int AS hits
        FROM site_ref_daily WHERE ${s.where}
       GROUP BY ref_group ORDER BY hits DESC`, s.params) : [];

    const referrer_domains = await exists('site_ref_daily') ? await one(`
      SELECT ref_domain AS domain, ref_group AS "group", sum(hits)::int AS hits
        FROM site_ref_daily WHERE ${s.where} AND ref_group NOT IN ('internal','direct')
       GROUP BY ref_domain, ref_group ORDER BY hits DESC LIMIT 20`, s.params) : [];

    const shares = await exists('site_share_daily') ? await one(`
      SELECT platform, sum(fetches)::int AS fetches, count(DISTINCT path)::int AS pages
        FROM site_share_daily WHERE ${s.where}
       GROUP BY platform ORDER BY fetches DESC`, s.params) : [];

    const shared_pages = await exists('site_share_daily') ? await one(`
      SELECT path, string_agg(DISTINCT platform, ', ' ORDER BY platform) AS platforms,
             sum(fetches)::int AS fetches
        FROM site_share_daily WHERE ${s.where}
       GROUP BY path ORDER BY fetches DESC LIMIT 15`, s.params) : [];

    const campaigns = await exists('site_campaign_daily') ? await one(`
      SELECT source, medium, campaign, sum(hits)::int AS hits
        FROM site_campaign_daily WHERE ${s.where}
       GROUP BY source, medium, campaign ORDER BY hits DESC LIMIT 20`, s.params) : [];

    const events = await exists('site_event_daily') ? await one(`
      SELECT event, label, sum(n)::int AS n
        FROM site_event_daily WHERE ${s.where}
       GROUP BY event, label ORDER BY n DESC LIMIT 40`, s.params) : [];

    const robots = await exists('site_bot_daily') ? await one(`
      SELECT bot, family, sum(hits)::int AS hits
        FROM site_bot_daily WHERE ${s.where}
       GROUP BY bot, family ORDER BY hits DESC LIMIT 25`, s.params) : [];

    const robot_families = await exists('site_bot_daily') ? await one(`
      SELECT family, sum(hits)::int AS hits
        FROM site_bot_daily WHERE ${s.where}
       GROUP BY family ORDER BY hits DESC`, s.params) : [];

    const countries = await exists('site_country_daily') ? await one(`
      SELECT country, sum(hits)::int AS hits, sum(visitors)::int AS visitors
        FROM site_country_daily WHERE ${s.where} AND country <> 'XX'
       GROUP BY country ORDER BY hits DESC LIMIT 20`, s.params) : [];

    const ingest = await exists('site_ingest_state') ? (await one(
      `SELECT k AS source, last_ts, last_run_at, lines_read, runs FROM site_ingest_state ORDER BY last_run_at DESC NULLS LAST`)) : [];

    // The web-server log only started carrying the hostname when b517's nginx
    // change landed. Before that, the host is inferred, which the page says.
    const first_exact_host = (await one(
      `SELECT min(day)::text AS d FROM site_hits_daily WHERE host <> '(unknown)' AND day >= '2026-10-20'`))[0];

    res.json({
      ready: true,
      range: { from: r.from, to: r.to, days: r.days || null, grain: String(req.query.grain || 'day') },
      filters: { host: req.query.host || 'all', section: req.query.section || 'all' },
      hosts: HOSTS,
      totals, series, by_host, by_section,
      top_pages, top_downloads, entry_pages, bot_only_pages,
      referrer_groups, referrer_domains,
      shares, shared_pages, campaigns, events,
      robots, robot_families,
      countries, country_available: countries.length > 0,
      ingest,
      host_field_from: (first_exact_host || {}).d || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/site-analytics/sections ────────────────────────────────────────
// The section list, so the page's filter is built from what is actually there.
router.get('/sections', async (req, res) => {
  try {
    const db = getPool();
    const t = (await db.query(`SELECT to_regclass('site_page_daily') AS t`)).rows[0].t;
    if (!t) return res.json({ sections: [] });
    const { rows } = await db.query(
      `SELECT section, sum(views)::int AS views FROM site_page_daily
        WHERE day > CURRENT_DATE - 365 GROUP BY section ORDER BY views DESC`);
    res.json({ sections: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
