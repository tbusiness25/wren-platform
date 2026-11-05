'use strict';
// b353 — Morning Starters: file-backed slide content, same shape as b165's
// revision-cards.js (one JSON file per slide, no DB, generated separately by
// scripts/morning-starters/generate.js). Mounted ONLY in the demo eyfs and
// demo primary edition servers — deliberately never in editions/ladn, so LADN
// production gains nothing from this build (see the b353 brief).
//
//   app.use('/api/morning-starters', require('.../morning-starters')('morning-starters-eyfs'));
//   app.use('/api/morning-starters', require('.../morning-starters')('morning-starters-primary'));
//
// GET /api/morning-starters               -> index (slug, year_group, term, week, day, subject, type, title)
// GET /api/morning-starters/weeks         -> weeks summary (for the week-picker grid)
// GET /api/morning-starters/day/:t/:w/:d  -> all slides for one day, in order
// GET /api/morning-starters/:slug         -> one full slide
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const authenticate = require('../middleware/auth');

const SLUG_RE      = /^[a-z0-9-]+$/;
const CACHE_TTL_MS = 60 * 1000;
const DAY_ORDER     = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const dayRank = d => { const i = DAY_ORDER.indexOf(d); return i < 0 ? DAY_ORDER.length : i; };

module.exports = function makeMorningStartersRouter(packDir) {
  if (!packDir || !/^[a-z0-9-]+$/.test(packDir)) {
    throw new Error(`morning-starters: invalid packDir "${packDir}"`);
  }
  const SLIDES_DIR = path.join(__dirname, '../content', packDir);

  const router = express.Router();
  router.use(authenticate);

  let _cache = { at: 0, bySlug: null, index: null, weeks: null };

  function loadSlides() {
    const now = Date.now();
    if (_cache.bySlug && (now - _cache.at) < CACHE_TTL_MS) return _cache;

    const bySlug = Object.create(null);
    const index  = [];
    let files = [];
    try {
      files = fs.readdirSync(SLIDES_DIR).filter(f => f.endsWith('.json')).sort();
    } catch {
      files = []; // pack dir may not exist yet — content generated separately
    }

    for (const file of files) {
      let slide;
      try {
        slide = JSON.parse(fs.readFileSync(path.join(SLIDES_DIR, file), 'utf8'));
      } catch {
        continue; // never 500 the whole index on one bad/mid-write file
      }
      if (!slide || typeof slide !== 'object') continue;
      const slug = typeof slide.id === 'string' && slide.id ? slide.id : file.replace(/\.json$/, '');
      bySlug[slug] = slide;
      index.push({
        slug,
        year_group: slide.year_group || null,
        term:       slide.term || null,
        week:       slide.week || null,
        day:        slide.day || null,
        order:      slide.order || 1,
        subject:    slide.subject || null,
        type:       slide.type || null,
        title:      slide.title || slug,
      });
    }

    index.sort((a, b) =>
      (a.term - b.term) || (a.week - b.week) ||
      (dayRank(a.day) - dayRank(b.day)) || (a.order - b.order));

    // Weeks summary — one row per term/week, for the picker grid.
    const weekMap = new Map();
    for (const it of index) {
      const key = `${it.term}-${it.week}`;
      if (!weekMap.has(key)) {
        weekMap.set(key, { term: it.term, week: it.week, year_group: it.year_group, slide_count: 0, days: new Set() });
      }
      const w = weekMap.get(key);
      w.slide_count++;
      w.days.add(it.day);
    }
    const weeks = Array.from(weekMap.values())
      .map(w => ({ term: w.term, week: w.week, year_group: w.year_group, slide_count: w.slide_count, day_count: w.days.size }))
      .sort((a, b) => (a.term - b.term) || (a.week - b.week));

    _cache = { at: now, bySlug, index, weeks };
    return _cache;
  }

  router.get('/', (req, res) => {
    try { res.json(loadSlides().index); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/weeks', (req, res) => {
    try { res.json(loadSlides().weeks); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // MUST stay above /:slug — 'day' and numeric segments would otherwise never match.
  router.get('/day/:term/:week/:day', (req, res) => {
    try {
      const term = Number(req.params.term), week = Number(req.params.week);
      const day = String(req.params.day || '').slice(0, 10);
      if (!Number.isFinite(term) || !Number.isFinite(week)) return res.status(400).json({ error: 'Invalid term/week' });
      const { bySlug, index } = loadSlides();
      const slugs = index.filter(it => it.term === term && it.week === week && it.day === day).map(it => it.slug);
      res.json(slugs.map(s => bySlug[s]).filter(Boolean));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/:slug', (req, res) => {
    try {
      const slug = String(req.params.slug || '');
      if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
      const slide = loadSlides().bySlug[slug];
      if (!slide) return res.status(404).json({ error: 'Not found' });
      res.json(slide);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router._loadSlides = loadSlides;
  return router;
};
