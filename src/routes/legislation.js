// ─────────────────────────────────────────────────────────────────────────────
// Legislation watch — surface DfE/Ofsted changes + policies they affect.  (2026-07-07)
// Read-only over the shared public.legislation_watch (populated by the cron
// scripts/legislation-watch.js). Per-tenant "affected policies" is computed live
// against THIS schema's policies. Manager-gated.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);
const MGR = new Set(['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager']);
router.use((req, res, next) => MGR.has(req.user?.role) ? next() : res.status(403).json({ error: 'Manager access required' }));

// GET /api/legislation — watchlist + last change (most-recently-changed first)
router.get('/', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, slug, title, publisher, url, watch, last_checked_at, last_changed_at, last_change_summary
       FROM public.legislation_watch ORDER BY last_changed_at DESC NULLS LAST, title`);
    res.json({ sources: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/legislation/:slug/affected — policies in THIS schema the source touches
router.get('/:slug/affected', async (req, res) => {
  try {
    const db = getPool();
    const { rows: s } = await db.query(`SELECT keywords, title FROM public.legislation_watch WHERE slug=$1`, [req.params.slug]);
    if (!s.length) return res.status(404).json({ error: 'Unknown source' });
    const kw = s[0].keywords || [];
    if (!kw.length) return res.json({ source: s[0].title, policies: [] });
    // Scored, word-boundary matching: a title hit is a strong signal (×3), each
    // distinct keyword found in the body counts 1. Flag only score ≥ 2 — i.e. a
    // title match OR at least two distinct distinctive keywords in the body. This
    // cuts the noise from generic words appearing once in every policy.
    const { rows } = await db.query(
      `SELECT id, title, category, score FROM (
         SELECT p.id, p.title, p.category,
           (SELECT count(*) FROM unnest($1::text[]) k WHERE p.title   ~* ('\\y'||k||'\\y'))*3
         + (SELECT count(*) FROM unnest($1::text[]) k WHERE p.content ~* ('\\y'||k||'\\y'))   AS score
         FROM policies p WHERE p.is_active = true
       ) x WHERE score >= 2 ORDER BY score DESC, title LIMIT 25`, [kw]);
    res.json({ source: s[0].title, keywords: kw, policies: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
