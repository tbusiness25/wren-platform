/* colour-ok-file: WCAG maths and the sample colours it is tested against — this file IS the contrast gate.
 *
 * wren-contrast.js (b351) — one implementation of "is this palette readable?", shared by
 * the browser editor (public/js/wren-theme.js) and the server (src/routes/appearance.js),
 * so the check the person sees and the check that actually refuses the save cannot drift.
 * UMD: <script src="/js/wren-contrast.js"> gives window.WrenContrast; require() gives the same.
 *
 * A palette is a flat map  { '--c-bg': '#0b1220', '--c-surface': 'rgba(15,26,52,.75)', … }.
 * Values may be hex (#rgb #rgba #rrggbb #rrggbbaa) or rgb()/rgba(). A translucent surface is
 * composited over the page background before it is measured — the colour a reader actually sees
 * is in no single token.
 *
 * The pairs below are the ones that decide whether Roost can be read. WCAG 2.x AA: 4.5:1 for
 * text, 3:1 for the focus ring. Nothing under AA can be saved.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WrenContrast = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp255(n) { return Math.max(0, Math.min(255, n)); }

  /** '#abc' | '#aabbcc' | '#aabbccdd' | 'rgb(...)' | 'rgba(...)' | 'color(srgb r g b / a)' → {r,g,b,a} or null */
  function parse(str) {
    if (str == null) return null;
    var s = String(str).trim().toLowerCase();
    var m;
    if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
               a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    if ((m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s))) {
      var a = m[4] == null ? 1 : (/%$/.test(m[4]) ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      return { r: clamp255(+m[1]), g: clamp255(+m[2]), b: clamp255(+m[3]), a: Math.max(0, Math.min(1, a)) };
    }
    if ((m = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(s))) {
      return { r: clamp255(+m[1] * 255), g: clamp255(+m[2] * 255), b: clamp255(+m[3] * 255), a: m[4] == null ? 1 : +m[4] };
    }
    return null;
  }

  /** fg painted over an opaque bg → opaque colour */
  function over(fg, bg) {
    var a = fg.a == null ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }

  function lin(c) { c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function luminance(c) { return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b); }
  function ratioOpaque(a, b) {
    var la = luminance(a), lb = luminance(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  function hex(c) {
    return '#' + [c.r, c.g, c.b].map(function (v) { var s = Math.round(clamp255(v)).toString(16); return s.length < 2 ? '0' + s : s; }).join('');
  }

  /* [id, foreground token, background token, minimum ratio, what it means to a person] */
  var PAIRS = [
    ['text-page',      '--c-text',     '--c-bg',        4.5, 'Body text on the page'],
    ['text-card',      '--c-text',     '--c-surface',   4.5, 'Body text on a card'],
    ['text-raised',    '--c-text',     '--c-surface-2', 4.5, 'Body text on a raised panel'],
    ['muted-page',     '--c-muted',    '--c-bg',        4.5, 'Secondary text on the page'],
    ['muted-card',     '--c-muted',    '--c-surface',   4.5, 'Secondary text on a card'],
    ['on-blue',        '--c-on-blue',  '--c-blue',      4.5, 'Text on a blue button'],
    ['on-orange',      '--c-on-orange','--c-orange',    4.5, 'Text on an orange button'],
    ['blue-card',      '--c-blue',     '--c-surface',   4.5, 'Links and blue text on a card'],
    ['orange-card',    '--c-orange',   '--c-surface',   4.5, 'Orange text on a card'],
    ['ok-card',        '--c-ok',       '--c-surface',   4.5, '“OK” green text on a card'],
    ['warn-card',      '--c-warn',     '--c-surface',   4.5, 'Warning amber text on a card'],
    ['danger-card',    '--c-danger',   '--c-surface',   4.5, 'Error red text on a card'],
    ['bar',            '--c-on-bar',   '--c-bar',       4.5, 'Text on the top bar'],
    ['focus',          '--c-focus',    '--c-bg',        3.0, 'The keyboard focus ring against the page']
  ];

  /** Colour a token resolves to as painted, or null. Translucent values are composited over `base`. */
  function paint(tokens, name, base) {
    var c = parse(tokens[name]);
    if (!c) return null;
    return c.a < 1 ? over(c, base) : c;
  }

  /**
   * check(tokens) → { ok, results:[{id,label,fg,bg,ratio,min,ok,fgHex,bgHex}], failures:[…], missing:[…] }
   * A pair whose tokens are absent is reported in `missing` and does not fail the palette: a partial
   * override map is checked against the base palette it is layered on (the caller merges first).
   */
  function check(tokens) {
    var results = [], failures = [], missing = [];
    var pageC = parse(tokens['--c-bg']);
    if (!pageC) return { ok: false, results: results, failures: [{ id: 'no-bg', label: 'The page background is not a colour', ratio: 0, min: 0 }], missing: ['--c-bg'] };
    var page = pageC.a < 1 ? over(pageC, { r: 255, g: 255, b: 255 }) : pageC;
    PAIRS.forEach(function (p) {
      var id = p[0], fgT = p[1], bgT = p[2], min = p[3], label = p[4];
      var bgBase = paint(tokens, bgT, page);
      var fgC = bgBase ? paint(tokens, fgT, bgBase) : null;
      if (!fgC || !bgBase) { missing.push(id); return; }
      var r = ratioOpaque(fgC, bgBase);
      var rec = { id: id, label: label, fg: fgT, bg: bgT, ratio: Math.round(r * 100) / 100, min: min, ok: r + 1e-9 >= min, fgHex: hex(fgC), bgHex: hex(bgBase) };
      results.push(rec);
      if (!rec.ok) failures.push(rec);
    });
    return { ok: failures.length === 0, results: results, failures: failures, missing: missing };
  }

  /** One plain sentence for a failed pair — what somebody reading it can act on. */
  function explain(f) {
    return f.label + ' is ' + f.ratio.toFixed(1) + ' to 1 (' + f.fgHex + ' on ' + f.bgHex + '); it needs at least ' + f.min.toFixed(1) + ' to 1 to be readable.';
  }

  return { parse: parse, over: over, luminance: luminance, ratio: ratioOpaque, hex: hex, PAIRS: PAIRS, check: check, explain: explain };
});
