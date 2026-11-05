'use strict';
// b159 — Resource Curriculum Cards (file-backed, no DB)
// Cards live as one JSON file per card in src/content/resource-cards/<slug>.json
// GET /api/resource-cards       -> lightweight index (slug, title, category, age_range, strapline, areas)
// GET /api/resource-cards/:slug -> one full card
const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const CARDS_DIR = path.join(__dirname, '../content/resource-cards');
// b257 — a SECOND card directory: this setting's own cards, from the read-only
// setting-content mount (see src/routes/setting-content.js for why the store
// exists). CARDS_DIR is Wren's shipped library, baked into every image and
// inherited by every tenant; this one is not in git, not in the image, and
// belongs only to the setting that mounted it. Cards from it are tagged
// source:'setting' so a page can say whose material it is. Absent mount = zero
// files = the library behaves exactly as it did before.
const SETTING_CARDS_DIR = path.join(
  process.env.WREN_SETTING_CONTENT || '/app/setting-content', 'resource-cards');
const CARD_ART_DIR = path.join(__dirname, '../../public/card-art');
const SLUG_RE   = /^[a-z0-9-]+$/;
const CACHE_TTL_MS = 60 * 1000;

let _cache = { at: 0, bySlug: null, index: null };

function loadCards() {
  const now = Date.now();
  if (_cache.bySlug && (now - _cache.at) < CACHE_TTL_MS) return _cache;

  const bySlug = Object.create(null);
  const index  = [];
  let cardArt;
  try { cardArt = new Set(fs.readdirSync(CARD_ART_DIR).filter(f => f.endsWith('.jpg')).map(f => f.slice(0, -4))); }
  catch { cardArt = new Set(); }
  // Shipped library first, then the setting's own — so a setting can override a
  // shipped card by slug, and never the other way round.
  const files = [];
  for (const [dir, source] of [[CARDS_DIR, 'wren'], [SETTING_CARDS_DIR, 'setting']]) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    } catch {
      names = []; // directory may not exist yet — content is generated separately
    }
    for (const name of names) files.push({ dir, name, source });
  }

  for (const file of files) {
    let card;
    try {
      card = JSON.parse(fs.readFileSync(path.join(file.dir, file.name), 'utf8'));
    } catch {
      continue; // skip unparseable / mid-write files, never 500 the whole index
    }
    if (!card || typeof card !== 'object') continue;
    card.source = file.source;
    const slug = typeof card.slug === 'string' && card.slug ? card.slug : file.name.replace(/\.json$/, '');
    // 2026-10-08 — the reviewed ComfyUI picture (public/card-art/<slug>.jpg), which
    // resource-cards-render.js shows in place of the Mulberry symbol. Shipped cards only.
    if (file.source === 'wren' && !card.hero_url && cardArt.has(slug)) card.hero_url = '/card-art/' + slug + '.jpg';
    bySlug[slug] = card;
    // Pre-built lowercase haystack so the page can search title/strapline/intent
    // entirely client-side over the index (fast, no per-card fetch).
    const intent = Array.isArray(card.intent) ? card.intent.join(' ') : '';
    // b211 — key questions are what practitioners actually remember a card by
    // ("how will we get past this?"), so the keyword box has to reach them.
    const questions = Array.isArray(card.key_questions) ? card.key_questions.join(' ') : '';
    // b219 — themes are what a nursery actually plans by ("we're doing People Who
    // Help Us this half-term"), so the keyword box has to reach them too. Stored
    // as slugs on the card; the hyphens are flattened so "people who help us"
    // typed into the search box still hits.
    const themes = Array.isArray(card.themes) ? card.themes : [];
    const search = [
      card.title, card.strapline, intent, questions,
      Array.isArray(card.areas) ? card.areas.join(' ') : '',
      Array.isArray(card.aspects) ? card.aspects.join(' ') : '',
      themes.join(' ').replace(/-/g, ' '),
      card.category,
    ].filter(Boolean).join(' ').toLowerCase();
    index.push({
      slug,
      title:     card.title || slug,
      category:  card.category || null,
      age_range: card.age_range || null,
      // b-resource-lib (2026-08-03) — finer age bands + framework sub-aspects for
      // client-side search/filter. Back-compat: age_range/areas still present.
      age_bands: Array.isArray(card.age_bands) ? card.age_bands : [],
      aspects:   Array.isArray(card.aspects) ? card.aspects : [],
      // b219 — planning theme(s). Deliberately 0-2 per card: a card tagged with
      // everything narrows nothing, which is the trap `aspects` already falls into.
      themes:    themes,
      strapline: card.strapline || '',
      areas:     Array.isArray(card.areas) ? card.areas : [],
      // b257 — where the card came from, and (for setting cards) the printables
      // it carries. The library page shows a download count and an attribution
      // line; without these in the INDEX it would need a per-card fetch to know.
      source:    card.source || 'wren',
      attribution: card.attribution || null,
      downloads: Array.isArray(card.downloads) ? card.downloads : [],
      hero_url:  card.hero_url || null,
      search,
    });
  }

  index.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  _cache = { at: now, bySlug, index };
  return _cache;
}

// GET /api/resource-cards — card index
router.get('/', (req, res) => {
  try {
    res.json(loadCards().index);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/resource-cards/bulk?slugs=a,b,c — several FULL cards in one call.
// b211: the planning picker shows whole cards (intent / implementation / impact)
// for the sub-aspects you tick, not truncated rows. Without this it would fire one
// request per visible card. MUST stay above /:slug — 'bulk' matches SLUG_RE.
const BULK_MAX = 60;
router.get('/bulk', (req, res) => {
  try {
    const slugs = String(req.query.slugs || '')
      .split(',').map(s => s.trim()).filter(s => SLUG_RE.test(s));
    if (!slugs.length) return res.json([]);
    const bySlug = loadCards().bySlug;
    const out = [];
    for (const slug of slugs.slice(0, BULK_MAX)) {
      if (bySlug[slug]) out.push(bySlug[slug]);
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/resource-cards/:slug — one full card
router.get('/:slug', (req, res) => {
  try {
    const slug = String(req.params.slug || '');
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
    const card = loadCards().bySlug[slug];
    if (!card) return res.status(404).json({ error: 'Not found' });
    res.json(card);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// b167 — expose the card loader so the reflections hub can list "provision not
// yet observed" for a practitioner's key children without duplicating file IO.
router._loadCards = loadCards;

module.exports = router;
