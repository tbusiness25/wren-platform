/* Wren Resource-Cards — shared search + filter vocabulary and matcher.
 * (b-resource-lib, 2026-08-03)
 *
 * Self-contained, no dependencies. Both the Roost (admin) and EY resource-card
 * pages import this so the age-band / area / sub-aspect vocabulary and the
 * Development-Matters <-> Birth-to-5-Matters relabelling live in ONE place.
 *
 *   WrenRCFilters.AGE_BANDS          -> [{key,label,short}]
 *   WrenRCFilters.AREAS              -> canonical 7 EYFS area names (card `areas`)
 *   WrenRCFilters.ASPECTS_BY_AREA    -> { area: [aspect,...] }  (2021 DM vocabulary)
 *   WrenRCFilters.labelArea(area, fw)          -> display string for framework fw
 *   WrenRCFilters.labelAspect(area, aspect, fw)-> display string for framework fw
 *   WrenRCFilters.apply(index, state)          -> filtered index array (AND logic)
 *
 * fw is 'dm' (Development Matters, default/canonical) or 'b25' (Birth to 5 Matters).
 * The stored card vocabulary is always DM; b25 is a display relabel and is
 * APPROXIMATE where the two frameworks split aspects differently (noted below).
 */
(function (global) {
  'use strict';

  var AGE_BANDS = [
    { key: 'baby',      label: 'Babies (0–18m)',       short: 'Babies' },
    { key: 'toddler',   label: 'Toddlers (18–36m)',    short: 'Toddlers' },
    { key: 'preschool', label: 'Pre-schoolers (36m+)', short: 'Pre-school' },
  ];

  var AREAS = [
    'Communication & Language',
    'Personal, Social & Emotional Development',
    'Physical Development',
    'Literacy',
    'Mathematics',
    'Understanding the World',
    'Expressive Arts & Design',
  ];

  // 2021 Development Matters sub-aspects — MUST match reband-resource-cards.py.
  var ASPECTS_BY_AREA = {
    'Communication & Language': ['Listening, Attention & Understanding', 'Speaking'],
    'Personal, Social & Emotional Development': ['Self-Regulation', 'Managing Self', 'Building Relationships'],
    'Physical Development': ['Gross Motor Skills', 'Fine Motor Skills'],
    'Literacy': ['Comprehension', 'Word Reading', 'Writing'],
    'Mathematics': ['Number', 'Shape, Space & Measures'],
    'Understanding the World': ['Past & Present', 'People, Culture & Communities', 'The Natural World'],
    'Expressive Arts & Design': ['Creating with Materials', 'Being Imaginative & Expressive'],
  };

  // Birth to 5 Matters relabelling. The seven areas are the same; B25 spells "and"
  // where DM uses "&". A few aspects are split differently — those relabels are
  // APPROXIMATE (marked). Where two DM aspects collapse onto one B25 label the
  // chips simply show the same B25 wording.
  var B25_AREA = {
    'Communication & Language': 'Communication and Language',
    'Personal, Social & Emotional Development': 'Personal, Social and Emotional Development',
    'Physical Development': 'Physical Development',
    'Literacy': 'Literacy',
    'Mathematics': 'Mathematics',
    'Understanding the World': 'Understanding the World',
    'Expressive Arts & Design': 'Expressive Arts and Design',
  };
  var B25_ASPECT = {
    // CL — B25 keeps Listening/Attention and Understanding separate; we fold them (approx)
    'Listening, Attention & Understanding': 'Listening and Attention',
    'Speaking': 'Speaking',
    // PSED — DM Self-Regulation/Managing Self/Building Relationships -> B25 terms
    'Self-Regulation': 'Understanding Emotions',
    'Managing Self': 'Sense of Self',
    'Building Relationships': 'Making Relationships',
    // PD — B25 folds fine+gross under Moving and Handling (approx collision)
    'Gross Motor Skills': 'Moving and Handling',
    'Fine Motor Skills': 'Moving and Handling',
    // Literacy — B25 has Reading (comprehension+word reading) + Writing (approx)
    'Comprehension': 'Reading',
    'Word Reading': 'Reading',
    'Writing': 'Writing',
    // Maths
    'Number': 'Number',
    'Shape, Space & Measures': 'Shape, Space and Measures',
    // UtW
    'Past & Present': 'Past and Present',
    'People, Culture & Communities': 'People, Culture and Communities',
    'The Natural World': 'The Natural World',
    // EAD
    'Creating with Materials': 'Creating with Materials',
    'Being Imaginative & Expressive': 'Being Imaginative and Expressive',
  };

  function labelArea(area, fw) {
    if (fw === 'b25') return B25_AREA[area] || area;
    return area;
  }
  function labelAspect(area, aspect, fw) {
    if (fw === 'b25') return B25_ASPECT[aspect] || aspect;
    return aspect;
  }

  // AND across every active facet. state = { q, band, area, aspect, cat }.
  function apply(index, state) {
    state = state || {};
    var q = (state.q || '').trim().toLowerCase();
    return (index || []).filter(function (e) {
      if (state.cat && e.category !== state.cat) return false;
      if (state.band && (e.age_bands || []).indexOf(state.band) === -1) return false;
      if (state.area && (e.areas || []).indexOf(state.area) === -1) return false;
      if (state.aspect && (e.aspects || []).indexOf(state.aspect) === -1) return false;
      if (q) {
        var hay = e.search || ((e.title || '') + ' ' + (e.strapline || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  // ── b211 — pick by sub-aspect, not by scrolling ────────────────────────────
  // The tick list is built from the DATA, never from a hard-coded list, so a card
  // tagged with a brand-new aspect tomorrow shows up on its own. ASPECTS_BY_AREA is
  // used only to decide which heading an aspect sits under; anything it has never
  // heard of is grouped under "Other" rather than dropped.

  var AREA_OF_ASPECT = (function () {
    var m = {};
    Object.keys(ASPECTS_BY_AREA).forEach(function (area) {
      ASPECTS_BY_AREA[area].forEach(function (asp) { m[asp] = area; });
    });
    return m;
  })();

  // Short area codes as stored in ladn.curriculum_activities.eyfs_areas — the
  // activity bank tags by AREA only, so a sub-aspect tick has to widen to its
  // parent area there. Mirrors AREA_ALIASES in src/routes/next-steps.js.
  var AREA_CODES = {
    'Communication & Language':                 ['CL', 'C&L', 'Communication and Language'],
    'Personal, Social & Emotional Development': ['PSED', 'PSE', 'Personal Social Emotional Development'],
    'Physical Development':                     ['PD'],
    'Literacy':                                 ['LIT'],
    'Mathematics':                              ['MATH', 'MATHS'],
    'Understanding the World':                  ['UW'],
    'Expressive Arts & Design':                 ['EAD', 'EA&D', 'Expressive Arts and Design'],
  };

  function areaOfAspect(aspect) { return AREA_OF_ASPECT[aspect] || null; }

  // Every spelling of `area` that might appear in a tagged record, upper-cased.
  function areaMatchSet(areas) {
    var out = {};
    (areas || []).forEach(function (a) {
      out[String(a).toUpperCase()] = 1;
      (AREA_CODES[a] || []).forEach(function (c) { out[String(c).toUpperCase()] = 1; });
    });
    return out;
  }

  // aspectGroups(index, opts) -> [{ area, aspects:[{aspect,label,count}] }]
  //   index    any array of records carrying an `aspects` array
  //   opts.fw  'dm' | 'b25' — display relabelling only
  //   opts.of  optional accessor, default r.aspects
  // Groups appear in AREAS order, with unknown aspects last under "Other".
  function aspectGroups(index, opts) {
    opts = opts || {};
    var of = opts.of || function (r) { return r.aspects || []; };
    var counts = {};
    (index || []).forEach(function (r) {
      var seen = {};
      (of(r) || []).forEach(function (a) {
        if (!a || seen[a]) return;           // a card tagged twice still counts once
        seen[a] = 1;
        counts[a] = (counts[a] || 0) + 1;
      });
    });
    var byArea = {};
    Object.keys(counts).forEach(function (a) {
      var area = AREA_OF_ASPECT[a] || 'Other';
      (byArea[area] = byArea[area] || []).push({
        aspect: a,
        label:  labelAspect(area, a, opts.fw),
        count:  counts[a],
      });
    });
    var order = AREAS.filter(function (a) { return byArea[a]; });
    Object.keys(byArea).forEach(function (a) { if (order.indexOf(a) === -1) order.push(a); });
    return order.map(function (area) {
      var list = byArea[area].sort(function (x, y) {
        var i = (ASPECTS_BY_AREA[area] || []).indexOf(x.aspect);
        var j = (ASPECTS_BY_AREA[area] || []).indexOf(y.aspect);
        if (i === -1 && j === -1) return x.aspect.localeCompare(y.aspect);
        if (i === -1) return 1;
        if (j === -1) return -1;
        return i - j;
      });
      return { area: area, label: area === 'Other' ? 'Other' : labelArea(area, opts.fw), aspects: list };
    });
  }

  // ── b219 — themes: the facet that actually narrows ─────────────────────────
  // Sub-aspects can't narrow much on their own — the median card carries eight of
  // them, so ticking "Managing Self" still returns 181 of 284 cards. A theme is
  // what a nursery plans by ("we're doing People Who Help Us this half-term") and
  // a card carries at most two, so one tick cuts the library to ~20 cards.
  //
  // The list is derived from the CARDS, exactly like aspectGroups — nothing here
  // knows the name of any theme, so adding one to the JSONs is enough to make it
  // appear. Labels come from the slug rather than a parallel lookup table that
  // could drift out of sync with the content.

  var THEME_MINOR = { and: 1, the: 1, of: 1, or: 1, a: 1, an: 1, in: 1, on: 1, at: 1,
                      to: 1, for: 1, with: 1, from: 1 };

  // 'people-who-help-us' -> 'People Who Help Us'; 'water-and-the-seaside' -> 'Water and the Seaside'
  function themeLabel(key) {
    return String(key || '').split('-').map(function (w, i) {
      if (!w) return w;
      if (i > 0 && THEME_MINOR[w]) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  // themeOptions(index, opts) -> [{ key, label, count }] in label order.
  //   opts.of  optional accessor, default r.themes
  // Cards with no theme are simply absent — an untagged card is not a theme.
  function themeOptions(index, opts) {
    opts = opts || {};
    var of = opts.of || function (r) { return r.themes || []; };
    var counts = {};
    (index || []).forEach(function (r) {
      var seen = {};
      (of(r) || []).forEach(function (t) {
        if (!t || seen[t]) return;          // a card tagged twice still counts once
        seen[t] = 1;
        counts[t] = (counts[t] || 0) + 1;
      });
    });
    return Object.keys(counts).map(function (k) {
      return { key: k, label: themeLabel(k), count: counts[k] };
    }).sort(function (a, b) { return a.label.localeCompare(b.label); });
  }

  // Multi-select matcher. OR *within* a facet, AND *across* facets — tick two
  // sub-aspects and you get cards covering either; add a keyword and both must hold.
  //   state = { q, aspects:[], bands:[], areas:[], themes:[], cat }
  function applyMulti(index, state) {
    state = state || {};
    var q       = (state.q || '').trim().toLowerCase();
    var aspects = state.aspects || [];
    var bands   = state.bands || [];
    var areas   = state.areas || [];
    var themes  = state.themes || [];
    return (index || []).filter(function (e) {
      if (state.cat && e.category !== state.cat) return false;
      if (bands.length && !bands.some(function (b) { return (e.age_bands || []).indexOf(b) >= 0; })) return false;
      if (areas.length && !areas.some(function (a) { return (e.areas || []).indexOf(a) >= 0; })) return false;
      if (themes.length && !themes.some(function (t) { return (e.themes || []).indexOf(t) >= 0; })) return false;
      if (aspects.length && !aspects.some(function (a) { return (e.aspects || []).indexOf(a) >= 0; })) return false;
      if (q) {
        var hay = e.search || ((e.title || '') + ' ' + (e.strapline || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  global.WrenRCFilters = {
    AGE_BANDS: AGE_BANDS,
    AREAS: AREAS,
    ASPECTS_BY_AREA: ASPECTS_BY_AREA,
    labelArea: labelArea,
    labelAspect: labelAspect,
    apply: apply,
    AREA_CODES: AREA_CODES,
    areaOfAspect: areaOfAspect,
    areaMatchSet: areaMatchSet,
    aspectGroups: aspectGroups,
    themeLabel: themeLabel,
    themeOptions: themeOptions,
    applyMulti: applyMulti,
  };
})(window);
