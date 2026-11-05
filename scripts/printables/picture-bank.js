'use strict';
/* Wren Printables — picture bank (b386).
 *
 * Every picture is drawn by scripts/phonics/illustration-kit.js — the SAME
 * PROPS/CAST library and house style as the phonics books. This file does not
 * draw anything itself; it is the REGISTRY (which prop/cast draws "cat", what
 * word it's labelled, which graphemes it's the picture cue for, which themes
 * it belongs to) plus the standalone-icon renderer that crops a prop/character
 * to a small square for mats, cards and cut-outs (as opposed to
 * kit.renderScene's full 640x400 story-page canvas).
 *
 * Phonics data (graphemes/phase) is COMPUTED, never hand-typed: wordPhase()
 * below walks the Wren phase order and asks validate-decodable.js's own
 * segmenter + b380 phaseFlags whether the word is clean at that phase, so a
 * picture's claimed phase can never drift from the phonics content pack.
 */

const fs = require('fs');
const path = require('path');
const kit = require('../phonics/illustration-kit');
const { segmentWord, phaseFlags } = require('../phonics/validate-decodable');

const CONTENT = path.join(__dirname, '../../src/content/phonics');

// ---- phase order, derived from the content pack (same filter booklet.js uses:
// skip suffix_/prefix_ entries and the "_s" short/long split variants, which
// are a pedagogy distinction, not a second written grapheme). ------------------
const GRAPHEMES_BY_PHASE = {};
const GPC_ENTRIES_BY_PHASE = {}; // phase -> [{grapheme, example_words, position_in_phase}], in teaching order
// phase5b-alternatives-gpc.json matches the filename pattern but holds
// {alternative_pronunciations,alternative_spellings} objects, not a plain
// GPC array (b406, 2026-10-07) — its graphemes are already covered by the
// base phase2-6 files, so it's excluded here rather than parsed as one.
for (const f of fs.readdirSync(CONTENT).filter((x) => /^phase\d.*-gpc\.json$/.test(x) && !x.includes('alternatives'))) {
  for (const g of JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8'))) {
    if (!g.grapheme || /^(suffix|prefix)_|_s$/.test(g.grapheme)) continue;
    (GRAPHEMES_BY_PHASE[g.phase] = GRAPHEMES_BY_PHASE[g.phase] || new Set()).add(g.grapheme.toLowerCase());
    (GPC_ENTRIES_BY_PHASE[g.phase] = GPC_ENTRIES_BY_PHASE[g.phase] || []).push(g);
  }
}
for (const p of Object.keys(GPC_ENTRIES_BY_PHASE)) GPC_ENTRIES_BY_PHASE[p].sort((a, b) => (a.position_in_phase || 0) - (b.position_in_phase || 0));
const PHASES = Object.keys(GRAPHEMES_BY_PHASE).map(Number).sort((a, b) => a - b);
function cumulativeGpcs(upTo) {
  const s = new Set();
  for (const p of PHASES) if (p <= upTo) for (const g of GRAPHEMES_BY_PHASE[p]) s.add(g);
  return s;
}

// grapheme (written form, lowercase) -> the phase it's taught in.
const GRAPHEME_PHASE = {};
for (const p of PHASES) for (const g of GRAPHEMES_BY_PHASE[p]) if (!(g in GRAPHEME_PHASE)) GRAPHEME_PHASE[g] = p;

// The phase a single token needs. Segmenting against a RESTRICTED low-phase
// set first (the way validate-decodable.js checks a story someone has
// already written FOR that phase) silently mis-scores words here: e.g.
// "goat" has no 'oa' available at Phase 2, so the greedy matcher falls back
// to the single letters g+o+a+t, which are all individually Phase-2 — and
// the word reports as "Phase 2" even though no Phase-2 reader would decode
// a vowel team that way. So: segment against the FULL grapheme set first
// (greedy longest-match then correctly prefers 'oa' over 'o'+'a'), and the
// word's phase is the MAX teaching-phase of whichever graphemes that real
// segmentation actually used — then phaseFlags still runs at that phase to
// catch silent letters / irregular spellings no grapheme team explains.
function tokenPhase(word) {
  const lw = word.toLowerCase();
  const top = PHASES[PHASES.length - 1];
  const full = cumulativeGpcs(top);
  const seg = segmentWord(lw, full);
  if (!seg.ok) return { phase: null, graphemes: null };
  let phase = 2;
  for (const g of seg.used) phase = Math.max(phase, GRAPHEME_PHASE[g] || 2);
  // phaseFlags may still demand a later phase (irregular spelling, silent
  // letters) than any single grapheme implies — walk up until it's clean.
  for (const p of PHASES) {
    if (p < phase) continue;
    const gset = cumulativeGpcs(p);
    if (!phaseFlags(word, seg.used, { phase: p, gpcs_available: [...gset] }).length) return { phase: p, graphemes: seg.used };
  }
  return { phase: top, graphemes: seg.used };
}

// A picture's "word" may be two words ("christmas tree"). Phase is the worst
// (highest / null) across tokens; graphemes is every token's list concatenated.
function wordPhase(phrase) {
  const tokens = (phrase.match(/[A-Za-z']+/g) || []);
  if (!tokens.length) return { phase: null, graphemes: null };
  let phase = 0, graphemes = [], any = false;
  for (const t of tokens) {
    const r = tokenPhase(t);
    if (r.phase == null) { phase = null; continue; }
    any = true;
    if (phase !== null) phase = Math.max(phase, r.phase);
    graphemes = graphemes.concat(r.graphemes);
  }
  return { phase: any ? phase : null, graphemes: any ? graphemes : null };
}

// ---- icon framing ------------------------------------------------------------
// b386 guessed one of 5 preset boxes per prop by eye ('ground'/'tall'/...).
// That silently clipped several pictures (pig, dog, goat, a fishing net, a
// bee in flight...) whose real artwork didn't match the guessed preset, and
// left others swimming in wasted space inside an oversized box. b386b
// MEASURES instead: scripts/printables/measure-frames.js renders every
// picture-bank entry's actual SVG content in a real browser, reads back its
// true getBBox(), and writes frame-boxes.json keyed by PICTURE ID (not ref —
// two ids sharing a ref with different opts, e.g. 'mug' vs the smaller
// 'mug_w', genuinely render at different sizes). Re-run that script after
// adding a picture-bank entry; a missing id falls back to a generous
// symmetric box rather than clipping.
const FRAME_BOXES = JSON.parse(fs.readFileSync(path.join(__dirname, 'frame-boxes.json'), 'utf8'));
const FALLBACK_BOX = [-90, -110, 180, 180];
function frameForId(id) { return FRAME_BOXES[id] || FALLBACK_BOX; }

function escAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

// Render one picture-bank entry as a standalone square SVG icon.
// Props drawn in 'white'/'paper' fills (clouds, snow, eggshell) are meant to
// sit against a sky backdrop in a book scene — on bare cream paper those
// fills nearly vanish (paper #fffdf8 vs white #ffffff). These are the only
// icons that get an automatic contrast tile; everything else sits straight
// on the paper (b386b — a pale rect behind every picture read as a
// placeholder, not a design choice).
const PALE_REFS = new Set(['igloo', 'candle', 'egg', 'cloud', 'moon', 'snowman', 'menorah', 'diya']);

// ---- generated illustrations (2026-10-05) -------------------------------------
// The illustration pipeline (scripts/illustrations/, ComfyUI on the 3090) draws a real
// picture for each id; a human-reviewed pick is copied to wren-media/illustrations/
// printables/<id>.png by sync-picks.py, which also writes picks.json. An id is used ONLY if
// it is listed there — unreviewed art never reaches a sheet. Outline (colouring) sheets and
// opts.vector keep the line-art SVG below, which is what they need.
// Prefer the trimmed copies (scripts/illustrations/trim-picks.py, 2026-10-06): the raw
// picks are a subject on a large white square and printed too small.
const _RASTER_BASE = path.join(__dirname, '../../../wren-media/illustrations/printables');
const RASTER_DIR = process.env.WREN_ILLUSTRATIONS_DIR
  || (fs.existsSync(_RASTER_BASE + '-trimmed/picks.json') ? _RASTER_BASE + '-trimmed' : _RASTER_BASE);
const RASTER_PICKS = (() => {
  if (process.env.WREN_ILLUSTRATIONS === 'off') return {};
  try { return JSON.parse(fs.readFileSync(path.join(RASTER_DIR, 'picks.json'), 'utf8')); } catch (_) { return {}; }
})();
// b407b: the lesson-plan PDFs are pdfkit (not HTML), so they need a plain
// file path for doc.image() rather than the data: URI iconSvg() builds for
// HTML/SVG consumers — same reviewed raster pick, just handed over raw.
function rasterPngPath(id) {
  if (!RASTER_PICKS[id]) return null;
  const p = path.join(RASTER_DIR, `${id}.png`);
  return fs.existsSync(p) ? p : null;
}

const _rasterCache = new Map();
function rasterDataUri(id) {
  if (!RASTER_PICKS[id]) return null;
  if (_rasterCache.has(id)) return _rasterCache.get(id);
  let uri = null;
  try { uri = 'data:image/png;base64,' + fs.readFileSync(path.join(RASTER_DIR, `${id}.png`)).toString('base64'); } catch (_) {}
  _rasterCache.set(id, uri);
  return uri;
}

function iconSvg(id, opts = {}) {
  const pic = PICTURES_BY_ID[id];
  if (!pic) throw new Error(`picture-bank: unknown picture "${id}"`);
  const size = opts.size || 160;
  const raster = (opts.outline || opts.vector) ? null : rasterDataUri(id);
  if (raster) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" ` +
      `role="img" aria-label="${escAttr(pic.alt || pic.word)}" class="wp-icon wp-raster" data-picture="${id}">` +
      `<image href="${raster}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet"/></svg>`;
  }
  let inner;
  const box = frameForId(id);
  if (pic.kind === 'cast') {
    inner = kit.renderCharacter(pic.ref, pic.pose || 'happy');
  } else {
    const fn = kit.PROPS[pic.ref];
    if (!fn) throw new Error(`picture-bank: unknown prop "${pic.ref}" for picture "${id}"`);
    inner = fn(Object.assign({}, pic.opts));
  }
  // opts.outline (b389) — EAD colouring/decorate-it/collage sheets want pure
  // line art, no fills. Presentation attributes (fill="...") always lose to
  // ANY css rule, so one global class in layout.sheetCss() turns every fill
  // into an outline without touching a single path here — no new art.
  const wantsBg = !opts.transparent && !opts.outline && (opts.bg || PALE_REFS.has(pic.ref));
  const bg = wantsBg
    ? `<rect x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" rx="${Math.min(box[2], box[3]) * 0.1}" fill="${opts.bg || kit.c('sky')}"/>`
    : '';
  const cls = opts.outline ? 'wp-icon wp-outline' : 'wp-icon';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.join(' ')}" width="${size}" height="${size}" ` +
    `role="img" aria-label="${escAttr(pic.alt || pic.word)}" stroke-linecap="round" stroke-linejoin="round" class="${cls}" data-picture="${id}">` +
    bg + inner + '</svg>';
}

// ---- the registry -------------------------------------------------------------
// kind: 'prop' (illustration-kit PROPS[ref]) | 'cast' (illustration-kit CAST[ref])
// graphemeCue: graphemes (as taught in the Wren phase files) this picture is
//   the designated initial/key-sound cue for. cuePosition notes when the
//   sound isn't literally at the start of the word (e.g. 'ng' in "ring" is
//   the END sound) — always said on the page, per the b386 brief's own
//   "ng: ring (end sound — say so)" example.
const RAW = [
  // ---- Phase 2 CVC-ish set (>= 40 words, all existing or b386-added props) ----
  { id: 'cat', word: 'cat', ref: 'cat', graphemeCue: ['c'] },
  { id: 'dog', word: 'dog', ref: 'dog', graphemeCue: ['d'] },
  { id: 'pig', word: 'pig', ref: 'pig', graphemeCue: ['p'] },
  { id: 'hen', word: 'hen', ref: 'hen' },
  { id: 'fox', word: 'fox', ref: 'fox' },
  { id: 'duck', word: 'duck', ref: 'duck', graphemeCue: ['ck'], cuePosition: 'end sound' },
  { id: 'frog', word: 'frog', ref: 'frog' },
  { id: 'fish', word: 'fish', ref: 'fish' },
  { id: 'bug', word: 'bug', ref: 'beetle' },
  { id: 'bus', word: 'bus', ref: 'bus' },
  { id: 'bag', word: 'bag', ref: 'bag', graphemeCue: ['b'] },
  { id: 'pan', word: 'pan', ref: 'pan' },
  { id: 'pin', word: 'pin', ref: 'pin' },
  { id: 'bed', word: 'bed', ref: 'bed' },
  { id: 'mop', word: 'mop', ref: 'mop' },
  { id: 'pot', word: 'pot', ref: 'pot' },
  { id: 'nut', word: 'nut', ref: 'nut' },
  { id: 'jug', word: 'jug', ref: 'jug', graphemeCue: ['j'] },
  { id: 'map', word: 'map', ref: 'map' },
  { id: 'van', word: 'van', ref: 'van', graphemeCue: ['v'] },
  { id: 'fan', word: 'fan', ref: 'fan', graphemeCue: ['f'] },
  { id: 'web', word: 'web', ref: 'web', graphemeCue: ['w'] },
  { id: 'box', word: 'box', ref: 'box', graphemeCue: ['x'], cuePosition: 'end sound' },
  { id: 'net', word: 'net', ref: 'fishing_net', opts: { len: 70 } },
  { id: 'peg', word: 'peg', ref: 'peg' },
  { id: 'rug', word: 'rug', ref: 'rug', graphemeCue: ['r'] },
  { id: 'mug', word: 'mug', ref: 'mug', graphemeCue: ['m'] },
  { id: 'hat', word: 'hat', ref: 'sun_hat', graphemeCue: ['h'] },
  { id: 'cup', word: 'cup', ref: 'teacup' },
  { id: 'log', word: 'log', ref: 'log', opts: { w: 110 }, graphemeCue: ['l'] },
  { id: 'tin', word: 'tin', ref: 'tin', opts: { pose: 'up', w: 72, h: 80 }, graphemeCue: ['t'] },
  { id: 'sun', word: 'sun', ref: 'sun', graphemeCue: ['s'] },
  { id: 'wig', word: 'wig', ref: 'wig' },
  // 'nest_eggs' (b386b), not the bare 'nest' PROP — the empty nest read as a
  // loaf of bread at icon size; eggs inside make it unambiguous.
  { id: 'nest', word: 'nest', ref: 'nest_eggs', graphemeCue: ['n'] },
  { id: 'ant', word: 'ant', ref: 'ant' },
  { id: 'jam', word: 'jam', ref: 'jam_jar' },
  { id: 'fig', word: 'fig', ref: 'fig_fruit' },
  { id: 'mat', word: 'mat', ref: 'doormat' },
  { id: 'hut', word: 'hut', ref: 'shed', opts: { w: 90, h: 80 } },
  { id: 'crab', word: 'crab', ref: 'crab' },
  { id: 'kite', word: 'kite', ref: 'kite', graphemeCue: ['k', 'i-e'] },

  // ---- Grapheme initial/key-sound cues (Phase 2 + Phase 3) ----
  // Most reuse a picture already listed above — graphemeCue is added to it
  // further down. These are the ones with NO object above yet.
  { id: 'apple', word: 'apple', ref: 'apple', graphemeCue: ['a'] },
  // 'u' must START with /u/ — "bug" (b386) has /u/ as its MIDDLE sound.
  { id: 'umbrella', word: 'umbrella', ref: 'umbrella', graphemeCue: ['u'], themes: ['autumn'] },
  { id: 'igloo', word: 'igloo', ref: 'igloo', graphemeCue: ['i'] },
  { id: 'goat', word: 'goat', ref: 'goat', graphemeCue: ['g'] },
  { id: 'cliff', word: 'cliff', ref: 'rock', graphemeCue: ['ff'], cuePosition: 'end sound' },
  { id: 'bell', word: 'bell', ref: 'bell', graphemeCue: ['ll'], cuePosition: 'end sound' },
  { id: 'grass', word: 'grass', ref: 'grass_flat', graphemeCue: ['ss'], cuePosition: 'end sound' },
  { id: 'orange', word: 'orange', ref: 'orange_fruit', graphemeCue: ['o'] },
  { id: 'egg', word: 'egg', ref: 'egg', graphemeCue: ['e'] },
  { id: 'yoyo', word: 'yo-yo', ref: 'yo_yo', graphemeCue: ['y'] },
  // 'zip_fastener' (b386b) — the bare 'zip' PROP is an abstract red squiggle,
  // easily read as a lightning bolt; this one shows visible zip teeth.
  { id: 'zip', word: 'zip', ref: 'zip_fastener', graphemeCue: ['z'] },
  { id: 'buzz', word: 'buzz', ref: 'nell_bee', kind: 'cast', pose: 'hover', graphemeCue: ['zz'], cuePosition: 'end sound' },
  { id: 'quack', word: 'quack', ref: 'duck', graphemeCue: ['qu'] },
  { id: 'chair', word: 'chair', ref: 'chair', graphemeCue: ['ch'] },
  // Same picture, second id — "chair" genuinely starts with /ch/, not /air/
  // (b386 wrongly used one entry as the designated cue for both).
  { id: 'chair_air', word: 'chair', ref: 'chair', graphemeCue: ['air'], cuePosition: 'end sound' },
  { id: 'ship', word: 'ship', ref: 'boat', graphemeCue: ['sh'] },
  { id: 'thumb', word: 'thumb', ref: 'thumb', graphemeCue: ['th'] },
  { id: 'ring', word: 'ring', ref: 'ring', graphemeCue: ['ng'], cuePosition: 'end sound' },
  { id: 'rain', word: 'rain', ref: 'rain', opts: { count: 7, w: 130, h: 130 }, graphemeCue: ['ai'] },
  { id: 'tree', word: 'tree', ref: 'oak_tree', graphemeCue: ['ee'] },
  { id: 'light', word: 'light', ref: 'candle', graphemeCue: ['igh'], cuePosition: 'middle sound' },
  { id: 'boat', word: 'boat', ref: 'tug', graphemeCue: ['oa'] },
  { id: 'moon', word: 'moon', ref: 'moon', graphemeCue: ['oo'] },
  { id: 'book', word: 'book', ref: 'book_prop', graphemeCue: ['oo_s'] },
  { id: 'car', word: 'car', ref: 'car', graphemeCue: ['ar'] },
  { id: 'corn', word: 'corn', ref: 'corn_cob', graphemeCue: ['or'] },
  { id: 'fur', word: 'fur', ref: 'dog', graphemeCue: ['ur'], cuePosition: 'middle sound — feel how furry' },
  { id: 'cow', word: 'cow', ref: 'cow', graphemeCue: ['ow'] },
  { id: 'coin', word: 'coin', ref: 'coin', graphemeCue: ['oi'] },
  { id: 'ear', word: 'ear', ref: 'ear', graphemeCue: ['ear'] },
  { id: 'hammer', word: 'hammer', ref: 'hammer', graphemeCue: ['er'] },
  // 'ure' (sure/pure/cure/lure) has no concrete toddler-drawable referent —
  // deliberately not pictured; see NOTES.md.

  // ---- all-about-me ----
  { id: 'heart', word: 'heart', ref: 'heart', themes: ['all-about-me'] },
  // 'hand_mirror' (b386b) — the bare 'mirror' PROP's near-circular glass on
  // a stick reads as a lollipop at icon size; this one is a wide oval with a
  // glint, unmistakably a mirror.
  { id: 'mirror', word: 'mirror', ref: 'hand_mirror', themes: ['all-about-me'] },
  { id: 'balloon', word: 'balloon', ref: 'balloon', opts: { key: 'water' }, themes: ['all-about-me'] },
  { id: 'cake', word: 'cake', ref: 'cake', themes: ['all-about-me'], graphemeCue: ['a-e'] },
  { id: 'photo', word: 'photo', ref: 'photo_frame', themes: ['all-about-me'] },
  { id: 'flower', word: 'flower', ref: 'flower', themes: ['all-about-me', 'minibeasts'] },
  { id: 'footprint', word: 'footprint', ref: 'footprint', opts: { key: 'earth' }, themes: ['all-about-me'] },
  { id: 'home', word: 'home', ref: 'farmhouse', themes: ['all-about-me'] },
  { id: 'child_a', word: 'me', ref: 'child', opts: { pose: 'wave', skin: 'sand', hair: 'wood', shirt: 'water' }, themes: ['all-about-me'] },
  { id: 'child_b', word: 'friend', ref: 'child', opts: { pose: 'laugh', skin: 'earth', hair: 'hedgehog', shirt: 'sunflower' }, themes: ['all-about-me'] },
  { id: 'star_me', word: 'star', ref: 'star', themes: ['all-about-me', 'festivals-of-light', 'space'] },

  // ---- autumn ----
  { id: 'leaf', word: 'leaf', ref: 'leaf_single', themes: ['autumn'], graphemeCue: ['ea'] },
  { id: 'acorn_a', word: 'acorn', ref: 'acorn', themes: ['autumn'] },
  { id: 'conker_a', word: 'conker', ref: 'conker', themes: ['autumn'] },
  { id: 'pumpkin', word: 'pumpkin', ref: 'pumpkin', themes: ['autumn'] },
  { id: 'apple_a', word: 'apple', ref: 'apple', themes: ['autumn'] },
  { id: 'mushroom', word: 'mushroom', ref: 'mushroom', themes: ['autumn'] },
  { id: 'hedgehog', word: 'hedgehog', ref: 'moss_hedgehog', kind: 'cast', pose: 'curl', themes: ['autumn', 'minibeasts'] },
  { id: 'owl', word: 'owl', ref: 'olive_owl', kind: 'cast', pose: 'perch', themes: ['autumn'] },
  { id: 'spider', word: 'spider', ref: 'spider', themes: ['autumn', 'minibeasts'] },
  { id: 'web_a', word: 'web', ref: 'web', themes: ['autumn', 'minibeasts'] },
  { id: 'welly', word: 'welly boot', ref: 'welly_boot', themes: ['autumn'] },
  { id: 'rain_a', word: 'rain', ref: 'rain', opts: { count: 7, w: 130, h: 130 }, themes: ['autumn'] },
  { id: 'cloud_a', word: 'cloud', ref: 'cloud', themes: ['autumn', 'winter'], graphemeCue: ['ou'] },
  { id: 'squirrel_conker', word: 'conker', ref: 'conker', opts: { w: 60 }, themes: ['autumn'] },

  // ---- festivals-of-light ----
  { id: 'candle_f', word: 'candle', ref: 'candle', themes: ['festivals-of-light'] },
  { id: 'diya_f', word: 'diya lamp', ref: 'diya', themes: ['festivals-of-light'] },
  { id: 'menorah_f', word: 'menorah', ref: 'menorah', themes: ['festivals-of-light'] },
  { id: 'firework_f', word: 'firework', ref: 'firework', themes: ['festivals-of-light'] },
  { id: 'present_f', word: 'present', ref: 'present', themes: ['festivals-of-light'] },
  { id: 'tree_f', word: 'christmas tree', ref: 'christmas_tree', themes: ['festivals-of-light'] },
  { id: 'bunting_f', word: 'bunting', ref: 'bunting', themes: ['festivals-of-light'] },
  { id: 'moon_f', word: 'moon', ref: 'moon', themes: ['festivals-of-light', 'winter'] },

  // ---- winter ----
  { id: 'snowman_w', word: 'snowman', ref: 'snowman', themes: ['winter'] },
  { id: 'snowflake_w', word: 'snowflake', ref: 'snowflake', themes: ['winter'] },
  { id: 'mitten_w', word: 'mitten', ref: 'mitten', themes: ['winter'] },
  { id: 'scarf_w', word: 'scarf', ref: 'scarf', themes: ['winter'] },
  { id: 'polarbear_w', word: 'polar bear', ref: 'polar_bear', themes: ['winter'] },
  { id: 'penguin_w', word: 'penguin', ref: 'penguin', themes: ['winter'] },
  { id: 'igloo_w', word: 'igloo', ref: 'igloo', themes: ['winter'] },
  { id: 'mug_w', word: 'hot drink', ref: 'mug', opts: { w: 54 }, themes: ['winter'] },
  { id: 'star_w', word: 'star', ref: 'star', themes: ['winter'] },

  // ---- space ----
  { id: 'rocket_s', word: 'rocket', ref: 'rocket', themes: ['space'] },
  { id: 'planet_s', word: 'planet', ref: 'planet', opts: { key: 'leafy' }, themes: ['space'] },
  { id: 'planet_s2', word: 'planet', ref: 'planet', opts: { key: 'water' }, themes: ['space'] },
  { id: 'astronaut_s', word: 'astronaut', ref: 'astronaut', themes: ['space'], graphemeCue: ['au'] },
  { id: 'alien_s', word: 'alien', ref: 'alien', themes: ['space'] },
  { id: 'telescope_s', word: 'telescope', ref: 'telescope', themes: ['space'] },
  { id: 'moon_s', word: 'moon', ref: 'moon', themes: ['space'] },
  { id: 'star_s', word: 'star', ref: 'star', themes: ['space'] },

  // ---- minibeasts ----
  { id: 'ladybird_m', word: 'ladybird', ref: 'ladybird', themes: ['minibeasts'] },
  { id: 'beetle_m', word: 'beetle', ref: 'beetle', themes: ['minibeasts'] },
  { id: 'ant_m', word: 'ant', ref: 'ant', themes: ['minibeasts'] },
  { id: 'bee_m', word: 'bee', ref: 'nell_bee', kind: 'cast', pose: 'hover', themes: ['minibeasts'] },
  { id: 'butterfly_m', word: 'butterfly', ref: 'butterfly', themes: ['minibeasts'] },
  { id: 'snail_m', word: 'snail', ref: 'snail', themes: ['minibeasts'] },
  { id: 'worm_m', word: 'worm', ref: 'worm', themes: ['minibeasts'] },
  { id: 'caterpillar_m', word: 'caterpillar', ref: 'fig_caterpillar', kind: 'cast', pose: 'sit', themes: ['minibeasts'] },
  { id: 'wasp_m', word: 'wasp', ref: 'wasp', themes: ['minibeasts'] },

  // ---- the six Wren cast members, by proper name (b387) ----
  // Existing entries (hedgehog/owl/buzz/caterpillar_m) register the SAME
  // artwork under a generic common-noun word, for phonics vocab. These are
  // separate ids under the character's own name, for caption-writing work
  // (W06) where the point is "who is this and what are they doing", not a
  // sound to decode — PRONUNCIATION below marks all six phase:null so they
  // are never offered as a word to sound out or an I-spy first-sound target.
  { id: 'cast_pip', word: 'Pip', ref: 'pip_sparrow', kind: 'cast', pose: 'hop' },
  { id: 'cast_ned', word: 'Ned', ref: 'ned_duckling', kind: 'cast', pose: 'stand' },
  { id: 'cast_olive', word: 'Olive', ref: 'olive_owl', kind: 'cast', pose: 'perch' },
  { id: 'cast_moss', word: 'Moss', ref: 'moss_hedgehog', kind: 'cast', pose: 'curl' },
  { id: 'cast_fig', word: 'Fig', ref: 'fig_caterpillar', kind: 'cast', pose: 'sit' },
  { id: 'cast_nell', word: 'Nell', ref: 'nell_bee', kind: 'cast', pose: 'hover' },

  // ---- b389 (Printables PSED/C&L/UW/EAD/Display/Role-play) — generic
  // provision/role-play/self-care objects and life-cycle stages. No theme
  // tags: these are reached by direct id, not byTheme(), since they belong
  // to a provision area, a role-play setting or a life cycle, not a season.
  { id: 'bucket', word: 'bucket', ref: 'bucket' },
  { id: 'spade', word: 'spade', ref: 'spade' },
  { id: 'paintbrush', word: 'paintbrush', ref: 'paintbrush' },
  { id: 'scissors', word: 'scissors', ref: 'scissors' },
  { id: 'block', word: 'block', ref: 'block' },
  { id: 'toothbrush', word: 'toothbrush', ref: 'toothbrush' },
  { id: 'soap', word: 'soap', ref: 'soap_bar' },
  { id: 'toilet', word: 'toilet', ref: 'toilet' },
  { id: 'handprint', word: 'handprint', ref: 'handprint' },
  { id: 'envelope', word: 'envelope', ref: 'envelope' },
  { id: 'till', word: 'till', ref: 'till' },
  { id: 'medical_cross', word: 'medical kit', ref: 'medical_cross' },
  { id: 'magnifying_glass', word: 'magnifying glass', ref: 'magnifying_glass' },
  { id: 'watering_can', word: 'watering can', ref: 'watering_can' },
  { id: 'eye_icon', word: 'eye', ref: 'eye_prop' },
  { id: 'nose_icon', word: 'nose', ref: 'nose', graphemeCue: ['o-e'] },
  { id: 'mouth_icon', word: 'mouth', ref: 'mouth_icon' },

  // life-cycle stages — ordered sets live in scripts/printables/lifecycles.js
  { id: 'lc_egg_frog', word: 'frog egg', ref: 'egg', opts: { key: 'water' } },
  { id: 'lc_tadpole', word: 'tadpole', ref: 'tadpole' },
  { id: 'lc_froglet', word: 'froglet', ref: 'froglet' },
  { id: 'lc_frog_adult', word: 'frog', ref: 'frog' },
  { id: 'lc_egg_butterfly', word: 'tiny egg', ref: 'egg' },
  { id: 'lc_caterpillar', word: 'caterpillar', ref: 'fig_caterpillar', kind: 'cast', pose: 'sit' },
  { id: 'lc_chrysalis', word: 'chrysalis', ref: 'chrysalis' },
  { id: 'lc_butterfly_adult', word: 'butterfly', ref: 'butterfly' },
  { id: 'lc_egg_chick', word: 'egg', ref: 'egg' },
  { id: 'lc_chick', word: 'chick', ref: 'chick' },
  { id: 'lc_hen_adult', word: 'hen', ref: 'hen' },
  { id: 'lc_bean_seed', word: 'seed', ref: 'bean_seed' },
  { id: 'lc_seedling', word: 'seedling', ref: 'seedling' },
  { id: 'lc_plant_adult', word: 'flower', ref: 'flower' },

  // A few more provision/role-play nouns that already have a kit prop but
  // had no picture-bank entry yet.
  { id: 'spoon_icon', word: 'spoon', ref: 'spoon' },
  { id: 'bowl_icon', word: 'bowl', ref: 'bowl' },
  { id: 'boat_toy', word: 'boat', ref: 'tug' },
  { id: 'drum_icon', word: 'drum', ref: 'tin', opts: { pose: 'up' } },
  { id: 'dough_ball', word: 'dough', ref: 'dough_ball' },
  { id: 'sandwich', word: 'sandwich', ref: 'sandwich' },
  { id: 'book_closed', word: 'book', ref: 'book_closed' },

  // ---- UW/Display additions (b389 continuation) — weather + nature-walk
  // nouns with no bank entry yet. Not theme-tagged: reached by direct id.
  { id: 'rainbow_icon', word: 'rainbow', ref: 'rainbow' },
  { id: 'wind_icon', word: 'windy', ref: 'wind_lines' },
  { id: 'pebble_icon', word: 'pebble', ref: 'pebble', opts: { w: 60, h: 40 } },
  { id: 'twig_icon', word: 'twig', ref: 'twig' },
  { id: 'paddling_pool_icon', word: 'paddling pool', ref: 'paddling_pool' },
  { id: 'hive_icon', word: 'hive', ref: 'hive' },
  { id: 'brick_wall_icon', word: 'wall', ref: 'brick_wall' },
  { id: 'motion_arc_icon', word: 'falling', ref: 'motion_arc' },

  // ---- b390 — PSED self-care fix (C05: every step needs its own picture)
  // and a generic feelings-face set (C01: the feeling must show on the
  // FACE, not just the cast's 4 eye modes). feeling ids are picture-only —
  // PRONUNCIATION marks every one phase:null, never a decoding word.
  { id: 'feeling_happy', word: 'happy', ref: 'feelings_face', opts: { feeling: 'happy' } },
  { id: 'feeling_sad', word: 'sad', ref: 'feelings_face', opts: { feeling: 'sad' } },
  { id: 'feeling_cross', word: 'cross', ref: 'feelings_face', opts: { feeling: 'cross' } },
  { id: 'feeling_scared', word: 'scared', ref: 'feelings_face', opts: { feeling: 'scared' }, graphemeCue: ['are'] },
  { id: 'feeling_surprised', word: 'surprised', ref: 'feelings_face', opts: { feeling: 'surprised' } },
  { id: 'feeling_worried', word: 'worried', ref: 'feelings_face', opts: { feeling: 'worried' } },
  { id: 'feeling_calm', word: 'calm', ref: 'feelings_face', opts: { feeling: 'calm' } },
  { id: 'feeling_shy', word: 'shy', ref: 'feelings_face', opts: { feeling: 'shy' } },
  { id: 'feeling_excited', word: 'excited', ref: 'feelings_face', opts: { feeling: 'excited' } },
  { id: 'tap_running_icon', word: 'tap', ref: 'tap_running' },
  { id: 'hands_rubbing_sand', word: 'washing hands', ref: 'hands_rubbing', opts: { skin: 'sand' } },
  { id: 'hands_rubbing_earth', word: 'washing hands', ref: 'hands_rubbing', opts: { skin: 'earth' } },
  { id: 'hands_rinsing_icon', word: 'rinsing hands', ref: 'hands_rinsing', opts: { skin: 'wood' } },
  { id: 'towel_icon', word: 'towel', ref: 'towel' },
  { id: 'toothpaste_icon', word: 'toothpaste', ref: 'toothpaste_tube' },
  { id: 'smiling_teeth_icon', word: 'teeth', ref: 'smiling_teeth' },
  { id: 'timer_icon', word: 'timer', ref: 'timer_sand' },
  { id: 'toilet_roll_icon', word: 'toilet roll', ref: 'toilet_roll' },
  { id: 'flush_icon', word: 'flush', ref: 'flush_button' },

  // ---- b390 — full-year theme objects. Many themes reuse EXISTING entries
  // above (tagged via THEME_TAGS_EXTRA below, not re-listed here); these are
  // the ones that needed genuinely new artwork. opts.key variants reuse ONE
  // new illustration-kit PROP for 2-3 themed colourways, same pattern as
  // the existing balloon/planet entries.
  { id: 'dinosaur_a', word: 'dinosaur', ref: 'dinosaur', opts: { key: 'leafy' }, themes: ['dinosaurs'] },
  { id: 'dinosaur_b', word: 'dinosaur', ref: 'dinosaur', opts: { key: 'earth' }, themes: ['dinosaurs'] },
  { id: 'dinosaur_c', word: 'dinosaur', ref: 'dinosaur', opts: { key: 'berry' }, themes: ['dinosaurs'] },
  { id: 'lion_j', word: 'lion', ref: 'lion', themes: ['jungle-and-safari'] },
  { id: 'elephant_j', word: 'elephant', ref: 'elephant', themes: ['jungle-and-safari'], graphemeCue: ['ph'] },
  { id: 'monkey_j', word: 'monkey', ref: 'monkey', themes: ['jungle-and-safari'] },
  { id: 'pirate_ship_p', word: 'ship', ref: 'pirate_ship', themes: ['pirates-and-under-the-sea'] },
  { id: 'treasure_chest_p', word: 'treasure chest', ref: 'treasure_chest', themes: ['pirates-and-under-the-sea'] },
  { id: 'train_t', word: 'train', ref: 'train', themes: ['transport'] },
  { id: 'poppy_r', word: 'poppy', ref: 'poppy', themes: ['remembrance'] },
  { id: 'lantern_ly', word: 'lantern', ref: 'lantern', opts: { key: 'berry' }, themes: ['lunar-new-year'] },
  { id: 'lantern_re', word: 'lantern', ref: 'lantern', opts: { key: 'gold' }, themes: ['ramadan-and-eid'] },
  { id: 'sandcastle_s', word: 'sandcastle', ref: 'sandcastle', themes: ['seaside-summer'] },
  { id: 'beach_ball_s', word: 'beach ball', ref: 'beach_ball', themes: ['seaside-summer'] },
  { id: 'cape_sh', word: 'cape', ref: 'cape', themes: ['superheroes'] },
  { id: 'mask_sh', word: 'mask', ref: 'mask', themes: ['superheroes'] },
  { id: 'castle_tt', word: 'castle', ref: 'castle', themes: ['traditional-tales'] },
  { id: 'football_sp', word: 'football', ref: 'football', themes: ['sports'] },
  { id: 'wheat_sheaf_h', word: 'wheat', ref: 'wheat_sheaf', themes: ['harvest'] },
  { id: 'globe_aw', word: 'globe', ref: 'globe', themes: ['around-the-world'] },
  { id: 'flag_aw', word: 'flag', ref: 'flag', themes: ['around-the-world'] },
  { id: 'firefighter_helmet_pw', word: 'firefighter', ref: 'firefighter_helmet', themes: ['people-who-help-us'] },
  { id: 'police_hat_pw', word: 'police hat', ref: 'police_hat', themes: ['people-who-help-us'] },
  { id: 'rabbit_pt', word: 'rabbit', ref: 'rabbit', themes: ['pets', 'easter'] },
  { id: 'chick_e', word: 'chick', ref: 'chick', themes: ['easter'] },
  { id: 'pie_fc', word: 'pie', ref: 'pie', themes: ['food-and-cafe'], graphemeCue: ['ie'] },
  { id: 'bun_fc', word: 'bun', ref: 'jam_bun', themes: ['food-and-cafe'] },
  { id: 'crate_con', word: 'crate', ref: 'crate', themes: ['construction'] },

  // ---- b392 — "enough pictures for every theme": picture-heavy sheets
  // (I-spy, vocab sets, discs, matching...) were held back below 8 distinct
  // pictures per theme (publish.js MIN_PICS); this batch brings every theme
  // to >= 12. Grouped by the theme that needed the art first, in the
  // brief's calendar order. See illustration-kit.js for the new PROPS.

  // ---- pumpkins-and-halloween ----
  { id: 'bat', word: 'bat', ref: 'bat', themes: ['pumpkins-and-halloween'] },
  { id: 'ghost', word: 'ghost', ref: 'ghost', themes: ['pumpkins-and-halloween'] },
  { id: 'witch_hat', word: 'witch hat', ref: 'witch_hat', themes: ['pumpkins-and-halloween'] },
  { id: 'cauldron', word: 'cauldron', ref: 'cauldron', themes: ['pumpkins-and-halloween'] },
  { id: 'candy_corn', word: 'candy corn', ref: 'candy_corn', themes: ['pumpkins-and-halloween'] },
  { id: 'jack_lantern', word: 'jack-o-lantern', ref: 'jack_lantern', themes: ['pumpkins-and-halloween'] },

  // ---- bonfire-night ----
  { id: 'bonfire', word: 'bonfire', ref: 'bonfire', themes: ['bonfire-night'] },
  { id: 'sparkler', word: 'sparkler', ref: 'sparkler', themes: ['bonfire-night', 'diwali', 'lunar-new-year'] },
  { id: 'toffee_apple', word: 'toffee apple', ref: 'toffee_apple', themes: ['bonfire-night'] },
  { id: 'bobble_hat', word: 'bobble hat', ref: 'bobble_hat', themes: ['bonfire-night'] },

  // ---- diwali ----
  { id: 'rangoli', word: 'rangoli pattern', ref: 'rangoli', themes: ['diwali', 'festivals-of-light'] },
  { id: 'sweet_ladoo', word: 'ladoo sweet', ref: 'sweet_ladoo', themes: ['diwali'] },
  { id: 'marigold_garland', word: 'marigold garland', ref: 'marigold_garland', themes: ['diwali'] },
  { id: 'mandala_pattern', word: 'pattern', ref: 'mandala_pattern', themes: ['diwali', 'around-the-world'] },

  // ---- remembrance (gentle, no weapons/battle) ----
  { id: 'wreath', word: 'wreath', ref: 'wreath', themes: ['remembrance'] },
  { id: 'dove', word: 'dove', ref: 'dove', themes: ['remembrance'], graphemeCue: ['ve'], cuePosition: 'end sound' },
  { id: 'medal', word: 'medal', ref: 'medal', themes: ['remembrance', 'sports', 'superheroes'] },
  { id: 'bench', word: 'bench', ref: 'bench', themes: ['remembrance'] },
  { id: 'clock', word: 'clock', ref: 'clock', themes: ['remembrance', 'nursery-rhymes'] },

  // ---- hanukkah ----
  { id: 'dreidel', word: 'dreidel', ref: 'dreidel', themes: ['hanukkah', 'festivals-of-light'] },
  { id: 'star_of_david', word: 'star of david', ref: 'star_of_david', themes: ['hanukkah'] },
  { id: 'gelt_coin', word: 'gelt coin', ref: 'gelt_coin', themes: ['hanukkah'] },
  { id: 'latke', word: 'latke', ref: 'latke', themes: ['hanukkah'] },

  // ---- lunar new year ----
  { id: 'dragon', word: 'dragon', ref: 'dragon', themes: ['lunar-new-year'] },
  { id: 'dumpling', word: 'dumpling', ref: 'dumpling', themes: ['lunar-new-year'] },

  // ---- christmas / winter ----
  { id: 'robin', word: 'robin', ref: 'robin', themes: ['christmas', 'winter'] },
  { id: 'stocking', word: 'stocking', ref: 'stocking', themes: ['christmas'] },
  { id: 'holly', word: 'holly', ref: 'holly', themes: ['christmas'] },

  // ---- nursery rhymes ----
  { id: 'mouse', word: 'mouse', ref: 'mouse', themes: ['nursery-rhymes'] },
  { id: 'dish_icon', word: 'dish', ref: 'dish', themes: ['nursery-rhymes', 'food-and-cafe'] },

  // ---- dinosaurs (brief: at least 6 genuinely different species) ----
  { id: 'triceratops_a', word: 'dinosaur', ref: 'triceratops', opts: { key: 'earth' }, themes: ['dinosaurs'] },
  { id: 'triceratops_b', word: 'dinosaur', ref: 'triceratops', opts: { key: 'leafy' }, themes: ['dinosaurs'] },
  { id: 'stegosaurus_a', word: 'dinosaur', ref: 'stegosaurus', opts: { key: 'leafy' }, themes: ['dinosaurs'] },
  { id: 'stegosaurus_b', word: 'dinosaur', ref: 'stegosaurus', opts: { key: 'water' }, themes: ['dinosaurs'] },
  { id: 'trex_a', word: 'dinosaur', ref: 'trex', opts: { key: 'berry' }, themes: ['dinosaurs'] },
  { id: 'trex_b', word: 'dinosaur', ref: 'trex', opts: { key: 'earth' }, themes: ['dinosaurs'] },
  { id: 'pterosaur_a', word: 'dinosaur', ref: 'pterosaur', opts: { key: 'sand' }, themes: ['dinosaurs'] },
  { id: 'pterosaur_b', word: 'dinosaur', ref: 'pterosaur', opts: { key: 'sky' }, themes: ['dinosaurs'] },

  // ---- easter / spring / growing ----
  { id: 'easter_bonnet', word: 'easter bonnet', ref: 'easter_bonnet', themes: ['easter'] },
  { id: 'lamb', word: 'lamb', ref: 'lamb', themes: ['easter', 'spring', 'farm'] },
  { id: 'daffodil', word: 'daffodil', ref: 'daffodil', themes: ['easter', 'spring', 'growing'] },
  { id: 'garden_gate_icon', word: 'garden gate', ref: 'garden_gate', themes: ['growing', 'easter'] },
  { id: 'flowerpot_icon', word: 'flowerpot', ref: 'flowerpot', themes: ['growing', 'easter'] },
  { id: 'vegetable_patch_icon', word: 'vegetable patch', ref: 'vegetable_patch', themes: ['growing', 'harvest'] },
  { id: 'petal_single_icon', word: 'petal', ref: 'petal_single', themes: ['growing'] },
  { id: 'sunflower_icon', word: 'sunflower', ref: 'sunflower', themes: ['growing'] },

  // ---- settling-in / leavers-and-moving-on ----
  { id: 'teddy_bear', word: 'teddy bear', ref: 'teddy_bear', themes: ['settling-in', 'leavers-and-moving-on'] },

  // ---- pets ----
  { id: 'hamster', word: 'hamster', ref: 'hamster', themes: ['pets'] },
  { id: 'guinea_pig', word: 'guinea pig', ref: 'guinea_pig', themes: ['pets'] },
  { id: 'tortoise', word: 'tortoise', ref: 'tortoise', themes: ['pets'] },
  { id: 'bird_pet', word: 'bird', ref: 'pip_sparrow', kind: 'cast', pose: 'hop', themes: ['pets'], graphemeCue: ['ir'] },

  // ---- construction ----
  { id: 'digger', word: 'digger', ref: 'digger', themes: ['construction'] },
  { id: 'crane', word: 'crane', ref: 'crane', themes: ['construction'] },
  { id: 'traffic_cone', word: 'traffic cone', ref: 'traffic_cone', themes: ['construction', 'sports'] },
  { id: 'hard_hat', word: 'hard hat', ref: 'hard_hat', themes: ['construction'] },
  { id: 'wheelbarrow', word: 'wheelbarrow', ref: 'wheelbarrow', themes: ['construction'] },
  { id: 'nail', word: 'nail', ref: 'nail', themes: ['construction'] },
  { id: 'window_icon', word: 'window', ref: 'window', themes: ['construction'] },

  // ---- transport ----
  { id: 'plane', word: 'plane', ref: 'plane', themes: ['transport'] },
  { id: 'bicycle', word: 'bicycle', ref: 'bicycle', themes: ['transport'] },
  { id: 'helicopter', word: 'helicopter', ref: 'helicopter', themes: ['transport'] },
  { id: 'fire_engine', word: 'fire engine', ref: 'fire_engine', themes: ['transport', 'people-who-help-us'] },
  { id: 'scooter', word: 'scooter', ref: 'scooter', themes: ['transport'] },

  // ---- farm ----
  { id: 'sheep', word: 'sheep', ref: 'sheep', themes: ['farm'] },
  { id: 'horse', word: 'horse', ref: 'horse', themes: ['farm'] },
  { id: 'scarecrow', word: 'scarecrow', ref: 'scarecrow', themes: ['farm', 'harvest', 'traditional-tales'] },
  { id: 'barn_icon', word: 'barn', ref: 'barn', themes: ['farm', 'harvest'] },
  { id: 'farm_gate_icon', word: 'farm gate', ref: 'farm_gate', themes: ['farm'] },
  { id: 'hay_bales_icon', word: 'hay bales', ref: 'hay_bales', themes: ['farm', 'harvest', 'traditional-tales'] },
  { id: 'fence_icon', word: 'fence', ref: 'fence', themes: ['farm'] },

  // ---- jungle-and-safari (genuinely different species) ----
  { id: 'giraffe', word: 'giraffe', ref: 'giraffe', themes: ['jungle-and-safari'] },
  { id: 'zebra', word: 'zebra', ref: 'zebra', themes: ['jungle-and-safari'] },
  { id: 'snake', word: 'snake', ref: 'snake', themes: ['jungle-and-safari'] },
  { id: 'tiger', word: 'tiger', ref: 'tiger', themes: ['jungle-and-safari'] },
  { id: 'crocodile', word: 'crocodile', ref: 'crocodile', themes: ['jungle-and-safari', 'pirates-and-under-the-sea'] },
  { id: 'den_icon', word: 'den', ref: 'den', themes: ['jungle-and-safari'] },
  { id: 'claw_icon', word: 'claw', ref: 'claw', themes: ['jungle-and-safari'] },
  { id: 'paw_print_icon', word: 'paw print', ref: 'paw_print', themes: ['jungle-and-safari', 'pets'], graphemeCue: ['aw'] },
  { id: 'branch_icon', word: 'branch', ref: 'branch', themes: ['jungle-and-safari'] },

  // ---- seaside-summer / pirates-and-under-the-sea ----
  { id: 'shell', word: 'shell', ref: 'shell', themes: ['seaside-summer', 'pirates-and-under-the-sea'] },
  { id: 'starfish', word: 'starfish', ref: 'starfish', themes: ['seaside-summer', 'pirates-and-under-the-sea'] },
  { id: 'dune_icon', word: 'sand dune', ref: 'dune', themes: ['seaside-summer'] },
  { id: 'wave_icon', word: 'wave', ref: 'wave', themes: ['seaside-summer'] },
  { id: 'haul_net_icon', word: 'fishing net', ref: 'haul_net', themes: ['seaside-summer', 'pirates-and-under-the-sea'] },

  // ---- harvest / traditional-tales / easter / pets / food-and-cafe (shared) ----
  { id: 'basket', word: 'basket', ref: 'basket', themes: ['harvest', 'traditional-tales', 'easter', 'pets', 'food-and-cafe'] },
  { id: 'carrot', word: 'carrot', ref: 'carrot', themes: ['harvest', 'growing'] },
  { id: 'plum_icon', word: 'plum', ref: 'plum_fruit', themes: ['harvest'] },
  { id: 'pea_icon', word: 'pea', ref: 'pea', themes: ['harvest', 'growing'] },

  // ---- sports ----
  { id: 'whistle', word: 'whistle', ref: 'whistle', themes: ['sports'] },
  { id: 'skipping_rope', word: 'skipping rope', ref: 'skipping_rope', themes: ['sports'] },
  { id: 'beanbag', word: 'beanbag', ref: 'beanbag', themes: ['sports'] },

  // ---- around-the-world ----
  // hedgehog / wood_deep (b392): real contrast against child_a's 'sand' and
  // child_b's 'earth', which are near-identical hexes — see helper_person.
  { id: 'child_c', word: 'friend', ref: 'child', opts: { pose: 'wave', skin: 'hedgehog', hair: 'earth', shirt: 'sky' }, themes: ['around-the-world', 'sports', 'settling-in', 'leavers-and-moving-on', 'kindness-and-friendship'] },
  { id: 'child_d', word: 'friend', ref: 'child', opts: { pose: 'laugh', skin: 'wood_deep', skinStroke: 'ink', hair: 'sunflower', shirt: 'red' }, themes: ['around-the-world', 'sports'] },
  { id: 'flag_aw2', word: 'flag', ref: 'flag', opts: { key: 'red' }, themes: ['around-the-world'] },

  // ---- people-who-help-us (brief: varied skin tones, 8 distinct roles) ----
  // Three genuinely distinct skin tones (sand/earth/wood are near-identical
  // hexes — Claude review 2026-10-03): sand (light), hedgehog (mid), and
  // wood_deep with an ink stroke (deep) — spread across the 8 roles so the
  // set actually reads as varied, not just a role/colour difference.
  { id: 'helper_nurse', word: 'nurse', ref: 'helper_person', opts: { role: 'nurse', skin: 'sand' }, themes: ['people-who-help-us'] },
  { id: 'helper_doctor', word: 'doctor', ref: 'helper_person', opts: { role: 'doctor', skin: 'hedgehog' }, themes: ['people-who-help-us'] },
  { id: 'helper_vet', word: 'vet', ref: 'helper_person', opts: { role: 'vet', skin: 'wood_deep', skinStroke: 'ink' }, themes: ['people-who-help-us'] },
  { id: 'helper_postal', word: 'postal worker', ref: 'helper_person', opts: { role: 'postal', skin: 'hedgehog' }, themes: ['people-who-help-us'] },
  { id: 'helper_refuse', word: 'refuse collector', ref: 'helper_person', opts: { role: 'refuse', skin: 'sand' }, themes: ['people-who-help-us'] },
  { id: 'helper_lollipop', word: 'lollipop person', ref: 'helper_person', opts: { role: 'lollipop', skin: 'wood_deep', skinStroke: 'ink' }, themes: ['people-who-help-us'] },
  { id: 'helper_firefighter', word: 'firefighter', ref: 'helper_person', opts: { role: 'firefighter', skin: 'hedgehog' }, themes: ['people-who-help-us'] },
  { id: 'helper_police', word: 'police officer', ref: 'helper_person', opts: { role: 'police', skin: 'sand' }, themes: ['people-who-help-us'] },

  // ---- space ----
  { id: 'comet', word: 'comet', ref: 'comet', themes: ['space'] },
  { id: 'satellite', word: 'satellite', ref: 'satellite', themes: ['space'] },
  { id: 'planet_s3', word: 'planet', ref: 'planet', opts: { key: 'berry' }, themes: ['space'] },

  // ---- superheroes ----
  { id: 'lightning_bolt', word: 'lightning bolt', ref: 'lightning_bolt', themes: ['superheroes'] },
  { id: 'shield', word: 'shield', ref: 'shield', themes: ['superheroes'] },
  { id: 'cape_sh2', word: 'cape', ref: 'cape', opts: { key: 'sky' }, themes: ['superheroes'] },
  { id: 'mask_sh2', word: 'mask', ref: 'mask', opts: { key: 'sky' }, themes: ['superheroes'] },

  // ---- world-book-day / traditional-tales ----
  { id: 'wand', word: 'wand', ref: 'wand', themes: ['world-book-day', 'traditional-tales'] },
  { id: 'crown', word: 'crown', ref: 'crown', themes: ['world-book-day', 'traditional-tales'] },
  { id: 'glasses', word: 'glasses', ref: 'glasses', themes: ['world-book-day'] },
  { id: 'bookmark', word: 'bookmark', ref: 'bookmark', themes: ['world-book-day'] },
  { id: 'wolf', word: 'wolf', ref: 'wolf', themes: ['traditional-tales', 'world-book-day'] },
  { id: 'giant', word: 'giant', ref: 'giant', themes: ['traditional-tales', 'world-book-day'] },
  { id: 'bridge', word: 'bridge', ref: 'bridge', themes: ['traditional-tales'] },

  // ---- pancake-day / food-and-cafe ----
  { id: 'pancake', word: 'pancake', ref: 'pancake', themes: ['pancake-day'] },
  { id: 'lemon', word: 'lemon', ref: 'lemon', themes: ['pancake-day'] },
  { id: 'strawberry', word: 'strawberry', ref: 'strawberry', themes: ['pancake-day', 'food-and-cafe', 'growing'] },
  { id: 'stallholder_icon', word: 'market stall', ref: 'stallholder', themes: ['food-and-cafe'] },
  { id: 'stew_pot_icon', word: 'cooking pot', ref: 'stew_pot', themes: ['food-and-cafe'] },

  // ---- ramadan-and-eid ----
  { id: 'crescent_star', word: 'crescent and star', ref: 'crescent_star', themes: ['ramadan-and-eid'] },
  { id: 'dates_fruit', word: 'dates', ref: 'dates_fruit', themes: ['ramadan-and-eid'] },
  { id: 'mosque_dome', word: 'dome', ref: 'mosque_dome', themes: ['ramadan-and-eid'] },

  // ---- Phase 5 grapheme cues (ComfyUI, reviewed 2026-10-08) — raster pictures; the
  // ref is only a rough line-art stand-in for outline mode, and these carry no themes ----
  { id: 'hay', word: 'hay', ref: 'hay_bales', graphemeCue: ['ay'] },
  { id: 'whale', word: 'whale', ref: 'fish', graphemeCue: ['wh'] },
  { id: 'boy', word: 'boy', ref: 'child', graphemeCue: ['oy'] },
  { id: 'glue', word: 'glue', ref: 'pot', graphemeCue: ['ue'] },
  { id: 'stew', word: 'stew', ref: 'stew_pot', graphemeCue: ['ew'] },
  { id: 'toe', word: 'toe', ref: 'footprint', graphemeCue: ['oe'] },
  { id: 'centipede', word: 'centipede', ref: 'worm', graphemeCue: ['e-e'] },
  { id: 'ice_cube', word: 'ice cube', ref: 'pot', graphemeCue: ['u-e'] },

  // ---- b439 — weekend 2026-10-09 ComfyUI batch (120 reviewed raster pictures,
  // widening the decodable-word pool for the picture sheets). Same convention
  // as the Phase 5 block above: `ref` is only a rough line-art stand-in for
  // outline mode (the real picture is always the reviewed raster photo at
  // wren-media/illustrations/printables/<id>.png); these carry no themes.
  // Rejected by the reviewer (never used): beak, wag, field, snow.
  { id: 'belt', word: 'belt', ref: 'scarf' },
  { id: 'bite', word: 'bite', ref: 'apple' },
  { id: 'bone', word: 'bone', ref: 'twig' },
  { id: 'boot', word: 'boot', ref: 'welly_boot' },
  { id: 'boxes', word: 'boxes', ref: 'box' },
  { id: 'bread', word: 'bread', ref: 'sandwich' },
  { id: 'breakfast', word: 'breakfast', ref: 'teacup' },
  { id: 'brick', word: 'brick', ref: 'brick_wall' },
  { id: 'bull', word: 'bull', ref: 'cow' },
  { id: 'buses', word: 'buses', ref: 'bus' },
  { id: 'cage', word: 'cage', ref: 'basket' },
  { id: 'cap', word: 'cap', ref: 'sun_hat' },
  { id: 'cart', word: 'cart', ref: 'wheelbarrow' },
  { id: 'cats', word: 'cats', ref: 'cat' },
  { id: 'chef', word: 'chef', ref: 'helper_person' },
  { id: 'chin', word: 'chin', ref: 'child' },
  { id: 'chip', word: 'chip', ref: 'block' },
  { id: 'clap', word: 'clap', ref: 'child' },
  { id: 'coat', word: 'coat', ref: 'scarf' },
  { id: 'cone', word: 'cone', ref: 'party_hat' },
  { id: 'crawl', word: 'crawl', ref: 'child' },
  { id: 'dig', word: 'dig', ref: 'spade' },
  { id: 'dogs', word: 'dogs', ref: 'dog' },
  { id: 'dolphin', word: 'dolphin', ref: 'fish' },
  { id: 'door', word: 'door', ref: 'block' },
  { id: 'draw', word: 'draw', ref: 'paintbrush' },
  { id: 'drink', word: 'drink', ref: 'teacup' },
  { id: 'drop', word: 'drop', ref: 'splash' },
  { id: 'elf', word: 'elf', ref: 'child' },
  { id: 'family', word: 'family', ref: 'child' },
  { id: 'farm', word: 'farm', ref: 'farmhouse' },
  { id: 'fern', word: 'fern', ref: 'leaf_single' },
  { id: 'fly', word: 'fly', ref: 'beetle' },
  { id: 'foot', word: 'foot', ref: 'footprint' },
  { id: 'fork', word: 'fork', ref: 'block' },
  { id: 'gate', word: 'gate', ref: 'farm_gate' },
  { id: 'gem', word: 'gem', ref: 'block' },
  { id: 'girl', word: 'girl', ref: 'child' },
  { id: 'golf', word: 'golf', ref: 'block' },
  { id: 'hair', word: 'hair', ref: 'child' },
  { id: 'head', word: 'head', ref: 'child' },
  { id: 'hide', word: 'hide', ref: 'child' },
  { id: 'house', word: 'house', ref: 'farmhouse' },
  { id: 'ice', word: 'ice', ref: 'igloo' },
  { id: 'jet', word: 'jet', ref: 'plane' },
  { id: 'jumping', word: 'jumping', ref: 'child' },
  { id: 'kick', word: 'kick', ref: 'football' },
  { id: 'king', word: 'king', ref: 'crown' },
  { id: 'kites', word: 'kites', ref: 'kite' },
  { id: 'lake', word: 'lake', ref: 'puddle' },
  { id: 'leg', word: 'leg', ref: 'child' },
  { id: 'lid', word: 'lid', ref: 'pot' },
  { id: 'lunch', word: 'lunch', ref: 'sandwich' },
  { id: 'man', word: 'man', ref: 'helper_person' },
  { id: 'moth', word: 'moth', ref: 'butterfly' },
  { id: 'mud', word: 'mud', ref: 'mud' },
  { id: 'nap', word: 'nap', ref: 'bed' },
  { id: 'night', word: 'night', ref: 'moon' },
  { id: 'ox', word: 'ox', ref: 'cow' },
  { id: 'park', word: 'park', ref: 'bench' },
  { id: 'pat', word: 'pat', ref: 'child' },
  { id: 'paw', word: 'paw', ref: 'paw_print' },
  { id: 'pearl', word: 'pearl', ref: 'shell' },
  { id: 'peas', word: 'peas', ref: 'pea' },
  { id: 'pencil', word: 'pencil', ref: 'block' },
  { id: 'phone', word: 'phone', ref: 'phone' },
  { id: 'plate', word: 'plate', ref: 'dish' },
  { id: 'pond', word: 'pond', ref: 'puddle' },
  { id: 'pool', word: 'pool', ref: 'paddling_pool' },
  { id: 'pour', word: 'pour', ref: 'teacup' },
  { id: 'pull', word: 'pull', ref: 'wheelbarrow' },
  { id: 'push', word: 'push', ref: 'wheelbarrow' },
  { id: 'read', word: 'read', ref: 'book_closed' },
  { id: 'reindeer', word: 'reindeer', ref: 'deer' },
  { id: 'ride', word: 'ride', ref: 'bicycle' },
  { id: 'rip', word: 'rip', ref: 'block' },
  { id: 'river', word: 'river', ref: 'puddle' },
  { id: 'rock', word: 'rock', ref: 'rock' },
  { id: 'rope', word: 'rope', ref: 'block' },
  { id: 'rose', word: 'rose', ref: 'flower' },
  { id: 'run', word: 'run', ref: 'child' },
  { id: 'sand', word: 'sand', ref: 'sandcastle' },
  { id: 'saw', word: 'saw', ref: 'block' },
  { id: 'school', word: 'school', ref: 'block' },
  { id: 'sea', word: 'sea', ref: 'wave' },
  { id: 'seal', word: 'seal', ref: 'penguin' },
  { id: 'shed', word: 'shed', ref: 'shed' },
  { id: 'shelf', word: 'shelf', ref: 'block' },
  { id: 'shop', word: 'shop', ref: 'stallholder' },
  { id: 'shout', word: 'shout', ref: 'child' },
  { id: 'sink', word: 'sink', ref: 'tap_running' },
  { id: 'sit', word: 'sit', ref: 'child' },
  { id: 'skate', word: 'skate', ref: 'scooter' },
  { id: 'skip', word: 'skip', ref: 'skipping_rope' },
  { id: 'sled', word: 'sled', ref: 'block' },
  { id: 'sleigh', word: 'sleigh', ref: 'block' },
  { id: 'slide', word: 'slide', ref: 'block' },
  { id: 'smell', word: 'smell', ref: 'flower' },
  { id: 'smiling', word: 'smiling', ref: 'feelings_face' },
  { id: 'sock', word: 'sock', ref: 'mitten' },
  { id: 'soup', word: 'soup', ref: 'stew_pot' },
  { id: 'spin', word: 'spin', ref: 'block' },
  { id: 'stage', word: 'stage', ref: 'block' },
  { id: 'stir', word: 'stir', ref: 'stew_pot' },
  { id: 'straw', word: 'straw', ref: 'wheat_sheaf' },
  { id: 'swan', word: 'swan', ref: 'dove' },
  { id: 'swim', word: 'swim', ref: 'fish' },
  { id: 'tea', word: 'tea', ref: 'teacup' },
  { id: 'tent', word: 'tent', ref: 'tent' },
  { id: 'think', word: 'think', ref: 'child' },
  { id: 'tie', word: 'tie', ref: 'bow_tie' },
  { id: 'toes', word: 'toes', ref: 'footprint' },
  { id: 'toys', word: 'toys', ref: 'teddy_bear' },
  { id: 'tram', word: 'tram', ref: 'train' },
  { id: 'unicorn', word: 'unicorn', ref: 'horse' },
  { id: 'uniform', word: 'uniform', ref: 'helper_person' },
  { id: 'wash', word: 'wash', ref: 'hands_rubbing' },
  { id: 'yak', word: 'yak', ref: 'cow' },
  { id: 'yawn', word: 'yawn', ref: 'feelings_face' },
  { id: 'zigzag', word: 'zigzag', ref: 'lightning_bolt' },
];

// kind defaults to 'prop' unless set.
const PICTURES = RAW.map((p) => Object.assign({ kind: 'prop', themes: [], tags: [] }, p));
const PICTURES_BY_ID = Object.fromEntries(PICTURES.map((p) => [p.id, p]));

// b390 — the full-year theme batch mostly reuses EXISTING picture-bank
// entries rather than drawing new art (a pig is a pig whether the theme is
// "farm" or the Phase-2 CVC set). Same convention as PRONUNCIATION below: a
// small lookup table edited in one place, instead of touching ~60 RAW
// entries individually. byTheme(slug) is what every themed template reads
// its vocab from (see scripts/printables/templates/*.js), so an id missing
// here simply never appears on that theme's sheets — not a crash, just a
// thinner theme, so it is safe to be generous.
const THEME_TAGS_EXTRA = {
  pig: ['farm', 'traditional-tales'], hen: ['farm'], cow: ['farm', 'nursery-rhymes'], duck: ['farm'],
  cat: ['pets', 'pumpkins-and-halloween'], dog: ['pets'], fish: ['pets', 'pirates-and-under-the-sea'],
  bus: ['transport'], car: ['transport'], boat_toy: ['transport', 'pirates-and-under-the-sea'],
  pumpkin: ['pumpkins-and-halloween', 'harvest'], spider: ['pumpkins-and-halloween', 'nursery-rhymes'], web_a: ['pumpkins-and-halloween'],
  owl: ['pumpkins-and-halloween'],
  bucket: ['seaside-summer', 'nursery-rhymes', 'pirates-and-under-the-sea'], spade: ['seaside-summer', 'pirates-and-under-the-sea'], paddling_pool_icon: ['seaside-summer'],
  crab: ['seaside-summer', 'pirates-and-under-the-sea'],
  sandcastle_s: ['pirates-and-under-the-sea'],
  book_closed: ['world-book-day', 'traditional-tales', 'remembrance', 'settling-in', 'leavers-and-moving-on'], book: ['world-book-day'],
  heart: ['kindness-and-friendship', 'settling-in', 'leavers-and-moving-on', 'remembrance'],
  home: ['settling-in', 'around-the-world'],
  photo: ['settling-in', 'leavers-and-moving-on'],
  balloon: ['leavers-and-moving-on', 'kindness-and-friendship', 'settling-in'],
  child_a: ['kindness-and-friendship', 'around-the-world', 'world-book-day', 'sports', 'settling-in', 'leavers-and-moving-on', 'ramadan-and-eid'],
  child_b: ['kindness-and-friendship', 'around-the-world', 'world-book-day', 'sports', 'settling-in', 'leavers-and-moving-on', 'ramadan-and-eid'],
  moon: ['ramadan-and-eid', 'nursery-rhymes', 'pumpkins-and-halloween'],
  star_me: ['ramadan-and-eid', 'lunar-new-year', 'nursery-rhymes', 'sports', 'bonfire-night', 'leavers-and-moving-on', 'superheroes', 'diwali', 'hanukkah', 'remembrance', 'christmas', 'settling-in', 'kindness-and-friendship'],
  firework_f: ['bonfire-night', 'lunar-new-year', 'diwali'], mug_w: ['bonfire-night', 'hanukkah'], star_w: ['bonfire-night'],
  diya_f: ['diwali'], menorah_f: ['hanukkah'],
  tree_f: ['christmas'], present_f: ['christmas', 'ramadan-and-eid', 'diwali', 'hanukkah', 'leavers-and-moving-on', 'kindness-and-friendship'],
  candle_f: ['christmas', 'remembrance', 'nursery-rhymes', 'diwali', 'hanukkah'],
  bunting_f: ['christmas', 'diwali', 'lunar-new-year', 'hanukkah'], moon_f: ['christmas', 'diwali', 'hanukkah', 'bonfire-night'],
  envelope: ['lunar-new-year', 'ramadan-and-eid'],
  flower: ['growing', 'spring', 'kindness-and-friendship'], lc_bean_seed: ['growing', 'life-cycles', 'traditional-tales'], lc_seedling: ['growing', 'spring'], lc_plant_adult: ['growing'],
  watering_can: ['growing'], butterfly_m: ['spring', 'easter'], ladybird_m: ['spring'], egg: ['spring', 'easter', 'pancake-day'],
  lc_tadpole: ['life-cycles'], lc_frog_adult: ['life-cycles'], lc_caterpillar: ['life-cycles'],
  lc_butterfly_adult: ['life-cycles'], lc_chick: ['life-cycles', 'easter'], lc_hen_adult: ['life-cycles'],
  lc_egg_frog: ['life-cycles'], lc_froglet: ['life-cycles'], lc_egg_butterfly: ['life-cycles'],
  lc_chrysalis: ['life-cycles'], lc_egg_chick: ['life-cycles'],
  medical_cross: ['people-who-help-us', 'pets'], van: ['people-who-help-us', 'transport'],
  brick_wall_icon: ['construction', 'traditional-tales'], block: ['construction'], hammer: ['construction'], paintbrush: ['construction'],
  cup: ['food-and-cafe'], cake: ['food-and-cafe', 'pancake-day', 'leavers-and-moving-on'], sandwich: ['food-and-cafe', 'pancake-day'], jam: ['food-and-cafe', 'pancake-day'],
  pan: ['pancake-day'], apple_a: ['harvest'], mushroom: ['harvest'], corn: ['harvest'],
  bell: ['nursery-rhymes'], sun: ['seaside-summer'],
  beach_ball_s: ['sports'],
  // ---- b392 additions below (every new tag added to a PRE-EXISTING id;
  // brand-new ids carry their themes inline in RAW above instead) ----
  chick_e: ['spring'], umbrella: ['spring'], bee_m: ['spring'], rainbow_icon: ['kindness-and-friendship', 'spring'],
  jug: ['pancake-day'], bowl_icon: ['pancake-day', 'food-and-cafe', 'pets'], spoon_icon: ['pancake-day', 'food-and-cafe', 'nursery-rhymes'],
  dough_ball: ['pancake-day'], till: ['food-and-cafe'], boat: ['nursery-rhymes', 'transport'],
  handprint: ['kindness-and-friendship', 'leavers-and-moving-on', 'all-about-me'], footprint: ['leavers-and-moving-on'],
  fan: ['lunar-new-year'], orange: ['lunar-new-year'], coin: ['lunar-new-year'], drum_icon: ['lunar-new-year', 'around-the-world'],
  bun_fc: ['hanukkah', 'around-the-world'], lantern_ly: ['around-the-world'], lantern_re: ['festivals-of-light'],
  tree: ['remembrance'], flag_aw: ['remembrance'],
  snowman_w: ['christmas'], snowflake_w: ['christmas'], mitten_w: ['christmas', 'bonfire-night'], scarf_w: ['bonfire-night'],
  rocket_s: ['bonfire-night', 'superheroes', 'transport'], star_s: ['superheroes'], comet: ['superheroes'],
  cape_sh: ['world-book-day'], mask_sh: ['world-book-day'], castle_tt: ['world-book-day'],
  feeling_happy: ['kindness-and-friendship', 'settling-in'], feeling_sad: ['settling-in'], feeling_worried: ['settling-in'],
  feeling_calm: ['kindness-and-friendship'], feeling_excited: ['kindness-and-friendship', 'superheroes'],
  goat: ['traditional-tales'], log: ['traditional-tales'], nest: ['dinosaurs', 'easter', 'spring'],
  mandala_pattern: ['ramadan-and-eid'], sweet_ladoo: ['ramadan-and-eid'],
};
for (const [id, extra] of Object.entries(THEME_TAGS_EXTRA)) {
  const p = PICTURES_BY_ID[id];
  if (!p) throw new Error(`picture-bank: THEME_TAGS_EXTRA references unknown id "${id}"`);
  p.themes = [...new Set([...(p.themes || []), ...extra])];
}

// Compute graphemes/phase for every entry from its word — never hand-typed.
for (const p of PICTURES) {
  const wp = wordPhase(p.word);
  p.graphemes = wp.graphemes;
  p.phase = wp.phase;
}

// Claude review (2026-10-02): segmentation reads SPELLING, not SOUND, so a
// handful of picture words come out wrong — "orange" as or-a-ng-e (its first
// sound is short o), "heart" as h-ear-t (the ear says /ar/), "acorn"/"alien"
// as short-a words, "Christmas" as ch. Left alone, those words would be offered
// as decodable reading words or as I-spy first sounds. This table is the
// pronunciation truth for them: `phase: null` = picture only, never a word a
// child is asked to sound out; `first` = the real first phoneme (null = do not
// use this picture for a first-sound hunt). Any new irregular word goes here.
const PRONUNCIATION = {
  orange: { phase: null, first: 'o' },
  acorn: { phase: null, first: null },          // long a /ay/
  alien: { phase: null, first: null },          // long a /ay/
  apple: { phase: null, first: 'a' },           // -le ending
  umbrella: { phase: null, first: 'u' },
  igloo: { phase: null, first: 'i' },
  heart: { phase: null, first: 'h' },           // "ear" says /ar/
  mirror: { phase: null, first: 'm' },
  'christmas tree': { phase: null, first: null }, // ch says /k/
  hedgehog: { phase: null, first: 'h' },        // dge
  thumb: { phase: null, first: 'th' },          // silent b
  'yo-yo': { phase: null, first: 'y' },         // long o
  'polar bear': { phase: null, first: 'p' },    // long o
  penguin: { phase: null, first: 'p' },         // n-g-w, not ng-u
  worm: { phase: null, first: 'w' },            // "or" says /ur/
  wasp: { phase: null, first: 'w' },            // "a" says /o/
  firework: { phase: null, first: 'f' },
  snowman: { phase: null, first: null },        // sn blend; ow says /oa/
  snowflake: { phase: null, first: null },
  photo: { phase: null, first: null },          // ph (Phase 5), long o
  'diya lamp': { phase: null, first: 'd' },
  menorah: { phase: null, first: 'm' },
  friend: { phase: null, first: null },
  me: { phase: null, first: 'm' },              // e says /ee/ — a tricky word
  balloon: { phase: null, first: 'b' },         // unstressed first syllable
  // b392 additions — same rule: the segmenter reads SPELLING not SOUND, so
  // these go here rather than being offered as decodable or an I-spy target.
  ghost: { phase: null, first: 'g' },           // silent h; o says /oa/
  giant: { phase: null, first: 'j' },           // soft g (like giraffe/gem)
  giraffe: { phase: null, first: 'j' },         // soft g
  bicycle: { phase: null, first: 'b' },         // soft c before y
  wreath: { phase: null, first: 'r' },          // wr- the w is silent
  bridge: { phase: null, first: 'b' },          // dge says /j/ (as hedgehog)
  wolf: { phase: null, first: 'w' },            // o says /u/
  dove: { phase: null, first: 'd' },            // o says /u/ (like love, glove)
  wand: { phase: null, first: 'w' },            // wa- says /wo/ (like want)
  whistle: { phase: null, first: null },        // silent t
  window: { phase: null, first: 'w' },          // -ow says /oa/ (like snow)
  scarecrow: { phase: null, first: null },      // -crow says /oa/; sc blend
  wheelbarrow: { phase: null, first: null },    // -arrow says /oa/; wh digraph
  'guinea pig': { phase: null, first: 'g' },    // silent u; ui says /i/
  tortoise: { phase: null, first: 't' },        // oi says schwa, not /oi/
  dreidel: { phase: null, first: 'd' },         // foreign loanword, irregular
  latke: { phase: null, first: 'l' },           // foreign loanword
  'gelt coin': { phase: null, first: 'g' },     // foreign loanword
  'star of david': { phase: null, first: null }, // proper-noun phrase, not decoding content
  'easter bonnet': { phase: null, first: null }, // proper noun (Easter)
  'toffee apple': { phase: null, first: 't' },  // contains "apple" (-le ending)
  'police officer': { phase: null, first: 'p' }, // soft c in both words
  'vegetable patch': { phase: null, first: 'v' }, // soft g in vegetable
  'postal worker': { phase: null, first: 'p' },  // -work- says /er/ not /or/ (like firework)
  // Proper names (the six cast members) — never offered as a decoding word
  // or an I-spy first-sound target.
  pip: { phase: null, first: null },
  ned: { phase: null, first: null },
  olive: { phase: null, first: null },
  moss: { phase: null, first: null },
  fig: { phase: null, first: null },
  nell: { phase: null, first: null },
  // Claude review 2026-10-03 (b392 additions)
  eye: { phase: null, first: null },            // says /igh/
  excited: { phase: null, first: null },        // starts /ik/
  chrysalis: { phase: null, first: null },      // ch says /k/
  // b431 additions — found while building the phonics games' picture pool (which, like the
  // decodable-reading content, must only ever treat a picture's word as decodable when its
  // taught graphemes really do spell its real pronunciation).
  lion: { phase: null, first: 'l' },            // "ly-un" (/aɪ/ + schwa), not l+short-i+short-o+n
  calm: { phase: null, first: 'k' },            // silent l; the a says /ar/, not its short sound
};
for (const p of PICTURES) {
  const o = PRONUNCIATION[String(p.word || '').toLowerCase()];
  if (!o) continue;
  if ('phase' in o) p.phase = o.phase;
  if ('first' in o) p.first_sound = o.first;
  p.irregular = true;
}

// Grapheme -> picture id, built from graphemeCue tags (one designated cue per
// Wren-taught grapheme across Phase 2 + Phase 3).
const GRAPHEME_CUE = {};
for (const p of PICTURES) {
  for (const g of p.graphemeCue || []) GRAPHEME_CUE[g] = p.id;
}

function byTheme(slug) { return PICTURES.filter((p) => (p.themes || []).includes(slug)); }
function byIds(ids) { return ids.map((id) => { const p = PICTURES_BY_ID[id]; if (!p) throw new Error(`picture-bank: unknown id "${id}"`); return p; }); }

// tricky words taught AT this phase (not cumulative) — tricky-words-phaseN.json
const TRICKY_BY_PHASE = {};
for (const f of fs.readdirSync(CONTENT).filter((x) => /^tricky-words-phase\d+\.json$/.test(x))) {
  for (const w of JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8'))) {
    (TRICKY_BY_PHASE[w.phase] = TRICKY_BY_PHASE[w.phase] || []).push(w);
  }
}

// Phase-4 "adjacent consonants" (Letters & Sounds blending practice): TWO
// phonemes said together, not a single grapheme — the GPC files tag them
// sound_type:'grapheme' same as a single letter (no structural field
// distinguishes them), so this is a hand-kept list, same convention as the
// hand-set cuePosition tags above. A blend must never be offered as a first
// SOUND to hunt for (an I-spy target), only ever read as its real two sounds.
const CONSONANT_BLENDS = new Set([
  'bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl',
  'pr', 'sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'tr',
]);

// The single initial PHONEME a picture's word starts with, for I-spy-style
// "find the first sound" targets — distinct from wordPhase()'s whole-word
// phase (a word can be hard to fully decode, like "mirror", while its first
// sound is perfectly simple). Returns null if the first segment is a blend
// (two phonemes) or taught above maxPhase (default 3 — nursery/reception
// initial-sound range).
function firstSound(pic, maxPhase = 3) {
  if (pic.first_sound !== undefined) {               // pronunciation override wins
    const f = pic.first_sound;
    return f && (GRAPHEME_PHASE[f] || 99) <= maxPhase ? f : null;
  }
  const g = (pic.graphemes || [])[0];
  if (!g || CONSONANT_BLENDS.has(g)) return null;
  const phase = GRAPHEME_PHASE[g];
  if (phase == null || phase > maxPhase) return null;
  return g;
}

module.exports = {
  PICTURES, PICTURES_BY_ID, GRAPHEME_CUE, GRAPHEMES_BY_PHASE, GPC_ENTRIES_BY_PHASE,
  TRICKY_BY_PHASE, PHASES, GRAPHEME_PHASE, CONSONANT_BLENDS,
  iconSvg, rasterPngPath, wordPhase, byTheme, byIds, firstSound, PRONUNCIATION,
};
