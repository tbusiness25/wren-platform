/* Wren — how SECURE a child is in the range they are tagged at (b291, 2026-09-08)
 * ────────────────────────────────────────────────────────────────────────────
 * Toby, 2026-09-08:
 *   "when we're tagging the ranges in Birth to Five or Development Matters or
 *    Fledge, we should also be tagging how secure they are in that range."
 *
 * We still tag the RANGE and never the individual statement — that is the b278
 * rule and this does not touch it. A range judgement simply now carries a second
 * value alongside it.
 *
 *   emerging    just beginning to show this
 *   developing  doing it with support or inconsistently
 *   secure      doing it independently and consistently
 *
 * ── THE THREE THINGS THIS FILE EXISTS TO GET RIGHT ─────────────────────────
 *
 * 1. NULL IS NOT A LOW RATING. Every judgement recorded before b291 has no
 *    rating. It renders as "not yet rated", in the colourless fourth state —
 *    never as Emerging. rank() sorts it apart from the three, it is never
 *    coerced, and nothing in here invents one.
 *
 * 2. COLOUR IS NEVER THE ONLY CARRIER. Every chip carries the word or its
 *    initial (E / D / S) and every chip carries a title. Photocopy the tracker
 *    grid in greyscale, or read it red-green colour blind, and the three are
 *    still told apart by the letter. The dot is decorative and aria-hidden.
 *
 * 3. THE HUES ARE FIXED, NOT THEMED. --c-sec-* are their own tokens in
 *    public/css/wren.css. They are deliberately NOT aliases of --c-orange and
 *    --c-blue: wren-theme.js sets both of those to the same user-chosen accent
 *    (see applyEY), so Emerging and Secure would become one colour the moment
 *    anybody picked a preset.
 *
 * Loaded by the range picker, the tracker grid and both child profiles.
 * No dependencies, no fetches, idempotent.
 */
(function () {
  'use strict';

  /* Runs in a browser <script> AND under `require()` from the Node report
   * renderers, so it must not assume `window` exists. */
  var root = (typeof window !== 'undefined') ? window
           : (typeof globalThis !== 'undefined') ? globalThis : {};
  if (root.WrenSecurity) {
    if (typeof module !== 'undefined' && module.exports) module.exports = root.WrenSecurity;
    return;
  }

  /* Toby's three terms, in Toby's order, with Toby's wording. These are the
   * standard EYFS words practitioners already say out loud — do not "improve"
   * them into Beginning / Consolidating / Embedded. */
  var VALUES = [
    { key: 'emerging',   label: 'Emerging',   initial: 'E',
      help: 'just beginning to show this' },
    { key: 'developing', label: 'Developing', initial: 'D',
      help: 'doing it with support or inconsistently' },
    { key: 'secure',     label: 'Secure',     initial: 'S',
      help: 'doing it independently and consistently' },
  ];
  var BY_KEY = {};
  VALUES.forEach(function (v) { BY_KEY[v.key] = v; });

  /* The fourth state. Not one of VALUES — nothing offers it as a choice, it is
   * only ever what an unrated judgement looks like. */
  var NONE = { key: null, label: 'Not yet rated', initial: '–',
               help: 'no security rating has been recorded for this range' };

  var CSS = [
    /* ── The chip ──────────────────────────────────────────────────────── */
    '.wsec{display:inline-flex;align-items:center;gap:5px;border-radius:999px;',
    '  border:1px solid var(--c-sec-none);background:var(--c-sec-none-tint);',
    '  color:var(--c-text);font-size:.7rem;font-weight:700;line-height:1;',
    '  padding:3px 8px;white-space:nowrap;vertical-align:middle}',
    '.wsec-dot{width:8px;height:8px;border-radius:50%;background:var(--c-sec-none);flex:0 0 auto}',
    '.wsec-i{font-weight:800;letter-spacing:.02em}',
    '.wsec[data-sec="emerging"]{border-color:var(--c-sec-emerging);background:var(--c-sec-emerging-tint)}',
    '.wsec[data-sec="emerging"] .wsec-dot{background:var(--c-sec-emerging)}',
    '.wsec[data-sec="developing"]{border-color:var(--c-sec-developing);background:var(--c-sec-developing-tint)}',
    '.wsec[data-sec="developing"] .wsec-dot{background:var(--c-sec-developing)}',
    '.wsec[data-sec="secure"]{border-color:var(--c-sec-secure);background:var(--c-sec-secure-tint)}',
    '.wsec[data-sec="secure"] .wsec-dot{background:var(--c-sec-secure)}',
    /* Unrated is stated in words, quietly, and is never mistaken for Emerging. */
    '.wsec.wsec-none{color:var(--c-muted);font-weight:600;font-style:italic}',
    /* The initial-only form, for a dense grid cell. Still a letter, not a swatch. */
    '.wsec-mini{display:inline-flex;align-items:center;justify-content:center;',
    '  width:16px;height:16px;border-radius:5px;font-size:.62rem;font-weight:800;',
    '  border:1px solid var(--c-sec-none);background:var(--c-sec-none-tint);color:var(--c-muted)}',
    '.wsec-mini[data-sec="emerging"]{border-color:var(--c-sec-emerging);background:var(--c-sec-emerging-tint);color:var(--c-text)}',
    '.wsec-mini[data-sec="developing"]{border-color:var(--c-sec-developing);background:var(--c-sec-developing-tint);color:var(--c-text)}',
    '.wsec-mini[data-sec="secure"]{border-color:var(--c-sec-secure);background:var(--c-sec-secure-tint);color:var(--c-text)}',

    /* ── The segmented picker ──────────────────────────────────────────── */
    '.wsec-seg{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
    '.wsec-btn{min-height:36px;padding:5px 11px;border-radius:9px;border:1px solid var(--c-border);',
    '  background:transparent;color:var(--c-muted);font-size:.76rem;font-weight:700;cursor:pointer;',
    '  font-family:inherit;display:inline-flex;align-items:center;gap:6px;line-height:1.2;',
    '  transition:border-color .15s,background .15s,color .15s}',
    '.wsec-btn:hover{color:var(--c-text)}',
    '.wsec-btn .wsec-dot{opacity:.55}',
    '.wsec-btn[data-sec="emerging"]:hover{border-color:var(--c-sec-emerging)}',
    '.wsec-btn[data-sec="developing"]:hover{border-color:var(--c-sec-developing)}',
    '.wsec-btn[data-sec="secure"]:hover{border-color:var(--c-sec-secure)}',
    '.wsec-btn[aria-pressed="true"]{color:var(--c-text)}',
    '.wsec-btn[aria-pressed="true"] .wsec-dot{opacity:1}',
    /* The selected state is a 2px border AND a tint AND the word — three
       carriers, so it is still obviously selected in greyscale. */
    '.wsec-btn[data-sec="emerging"][aria-pressed="true"]{border-color:var(--c-sec-emerging);',
    '  box-shadow:inset 0 0 0 1px var(--c-sec-emerging);background:var(--c-sec-emerging-tint)}',
    '.wsec-btn[data-sec="developing"][aria-pressed="true"]{border-color:var(--c-sec-developing);',
    '  box-shadow:inset 0 0 0 1px var(--c-sec-developing);background:var(--c-sec-developing-tint)}',
    '.wsec-btn[data-sec="secure"][aria-pressed="true"]{border-color:var(--c-sec-secure);',
    '  box-shadow:inset 0 0 0 1px var(--c-sec-secure);background:var(--c-sec-secure-tint)}',
    '.wsec-unrated{font-size:.7rem;color:var(--c-muted);font-style:italic}',

    /* ── The legend ────────────────────────────────────────────────────── */
    '.wsec-legend{display:flex;gap:12px;flex-wrap:wrap;align-items:center;',
    '  font-size:.72rem;color:var(--c-muted)}',
    '.wsec-legend .wsec{font-size:.66rem}'
  ].join('');

  function injectStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('wren-security-rating-css')) return;
    var st = document.createElement('style');
    st.id = 'wren-security-rating-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** The vocabulary entry for a stored value. An unknown string is treated the
   *  same as no value at all — it is not silently rounded to a rating. */
  function meta(value) {
    return (value && BY_KEY[value]) || NONE;
  }
  function label(value)   { return meta(value).label; }
  function initial(value) { return meta(value).initial; }

  /** Sort key. Unrated sorts BELOW emerging rather than with it, because
   *  "we have not judged this" is a different thing from "barely started". */
  function rank(value) {
    var i = 0;
    for (; i < VALUES.length; i++) if (VALUES[i].key === value) return i + 1;
    return 0;
  }

  /**
   * chip(value, opts) -> html
   *   opts.word    true (default) = show the word; false = initial only
   *   opts.mini    a 16px square carrying just the initial (dense grids)
   *   opts.prefix  text placed before the word, e.g. a range label
   *   opts.title   overrides the tooltip
   */
  function chip(value, opts) {
    opts = opts || {};
    var m = meta(value);
    var title = opts.title != null ? opts.title
      : (m.key ? m.label + ' — ' + m.help : m.label + ' — ' + m.help);
    if (opts.mini) {
      return '<span class="wsec-mini"' + (m.key ? ' data-sec="' + m.key + '"' : '') +
             ' title="' + esc(title) + '" aria-label="' + esc(m.label) + '">' +
             esc(m.initial) + '</span>';
    }
    var body = opts.word === false
      ? '<span class="wsec-i">' + esc(m.initial) + '</span>'
      : (opts.prefix ? esc(opts.prefix) + ' ' : '') + esc(m.label);
    return '<span class="wsec' + (m.key ? '' : ' wsec-none') + '"' +
           (m.key ? ' data-sec="' + m.key + '"' : '') +
           ' title="' + esc(title) + '">' +
           '<i class="wsec-dot" aria-hidden="true"></i>' + body + '</span>';
  }

  /**
   * segmented(selected, attrs) -> html for a three-button group.
   * `attrs` is sprayed onto every button as data-* so a host can identify which
   * row was clicked (e.g. { area: 'Literacy' }). Clicking the selected value
   * again is how a practitioner clears it back to "not yet rated" — the host
   * decides that; this only reports which button was pressed.
   */
  function segmented(selected, attrs) {
    var extra = '';
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        extra += ' data-' + k + '="' + esc(attrs[k]) + '"';
      });
    }
    var html = VALUES.map(function (v) {
      return '<button type="button" class="wsec-btn" data-sec="' + v.key + '"' + extra +
             ' aria-pressed="' + (selected === v.key ? 'true' : 'false') + '"' +
             ' title="' + esc(v.label + ' — ' + v.help) + '">' +
             '<i class="wsec-dot" aria-hidden="true"></i>' + esc(v.label) + '</button>';
    }).join('');
    if (!selected) html += '<span class="wsec-unrated">not yet rated</span>';
    return '<div class="wsec-seg" role="group" aria-label="How secure in this range">' +
           html + '</div>';
  }

  function legend() {
    return '<div class="wsec-legend"><span>How secure in the range:</span>' +
           VALUES.map(function (v) { return chip(v.key); }).join('') +
           chip(null) + '</div>';
  }

  injectStyles();

  root.WrenSecurity = {
    VERSION: 'b291',
    VALUES: VALUES,
    KEYS: VALUES.map(function (v) { return v.key; }),
    NONE: NONE,
    CSS: CSS,
    injectStyles: injectStyles,
    meta: meta, label: label, initial: initial, rank: rank,
    chip: chip, segmented: segmented, legend: legend,
    /** Server-side / defensive: is this a value we are allowed to store? */
    isValid: function (v) { return v == null || v === '' || !!BY_KEY[v]; },
    normalise: function (v) { return (v && BY_KEY[v]) ? v : null; },
  };

  /* Also usable from Node (the report renderers import the vocabulary rather
   * than re-typing the three words in four places). */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.WrenSecurity;
  }
})();
