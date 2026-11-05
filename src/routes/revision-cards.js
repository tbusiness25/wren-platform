'use strict';
// b165 — Revision / flashcard cards for the DEMO primary & secondary editions.
// Sibling of b159's resource-cards.js but for KS1–KS4. File-backed, no DB.
// Each edition mounts this with its own content pack:
//   app.use('/api/revision-cards', require('.../revision-cards')('revision-cards-primary'));
//   app.use('/api/revision-cards', require('.../revision-cards')('revision-cards-secondary'));
//
// Cards live as one JSON file per card in src/content/<packDir>/<slug>.json
// GET /api/revision-cards       -> lightweight index (slug, title, key_stage, subject, strapline)
// GET /api/revision-cards/:slug -> one full card
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const authenticate = require('../middleware/auth');

const SLUG_RE      = /^[a-z0-9-]+$/;
const CACHE_TTL_MS = 60 * 1000;

module.exports = function makeRevisionCardsRouter(packDir) {
  if (!packDir || !/^[a-z0-9-]+$/.test(packDir)) {
    throw new Error(`revision-cards: invalid packDir "${packDir}"`);
  }
  const CARDS_DIR = path.join(__dirname, '../content', packDir);

  const router = express.Router();
  router.use(authenticate);

  let _cache = { at: 0, bySlug: null, index: null };

  function loadCards() {
    const now = Date.now();
    if (_cache.bySlug && (now - _cache.at) < CACHE_TTL_MS) return _cache;

    const bySlug = Object.create(null);
    const index  = [];
    let files = [];
    try {
      files = fs.readdirSync(CARDS_DIR).filter(f => f.endsWith('.json')).sort();
    } catch {
      files = []; // pack dir may not exist yet — content generated separately
    }

    for (const file of files) {
      let card;
      try {
        card = JSON.parse(fs.readFileSync(path.join(CARDS_DIR, file), 'utf8'));
      } catch {
        continue; // never 500 the whole index on one bad/mid-write file
      }
      if (!card || typeof card !== 'object') continue;
      const slug = typeof card.slug === 'string' && card.slug ? card.slug : file.replace(/\.json$/, '');
      bySlug[slug] = card;
      index.push({
        slug,
        title:     card.title || slug,
        key_stage: card.key_stage || null,
        subject:   card.subject || null,
        strapline: card.strapline || '',
      });
    }

    index.sort((a, b) =>
      String(a.subject).localeCompare(String(b.subject)) ||
      String(a.title).localeCompare(String(b.title)));
    _cache = { at: now, bySlug, index };
    return _cache;
  }

  // GET /api/revision-cards — card index
  router.get('/', (req, res) => {
    try {
      res.json(loadCards().index);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/revision-cards/:slug — one full card
  router.get('/:slug', (req, res) => {
    try {
      const slug = String(req.params.slug || '');
      if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
      const card = loadCards().bySlug[slug];
      if (!card) return res.status(404).json({ error: 'Not found' });
      res.json(card);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
