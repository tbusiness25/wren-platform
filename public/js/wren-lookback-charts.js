/* ═══════════════════════════════════════════════════════════════════════════════
 * wren-lookback-charts.js — b523 (2026-10-20)
 *
 * The chart renderer for the Look back report. ONE renderer, used from two
 * places: the live Roost page loads it as a <script>, and the server-side slide
 * pack (src/lib/lookback-pack.js) requires() this same file. Two renderers
 * would drift, and the pack is the thing that goes on the projector, so a
 * difference between them would be a difference between what Toby reviewed and
 * what the staff see.
 *
 * It returns SVG/HTML STRINGS and touches no DOM, which is what lets it run in
 * Node. There is no dependency, no chart library and no network call.
 *
 * ── THE SERIES PALETTE, AND WHY THIS ORDER ───────────────────────────────────
 * Wren already ships a categorical palette per theme: --c-cat-1 … --c-cat-8 in
 * public/css/wren-tokens.css. Nothing new is invented here, and no hex literal
 * appears below — only var(--c-*).
 *
 * The ORDER is re-stepped, though, because the natural 1,2,3,4,… order fails on
 * adjacent-pair separation. Measured with the dataviz validator on 2026-10-20:
 *
 *   1,2,3,4,5,6,7 light  FAIL — cat-3 #a55a00 ↔ cat-4 #b91c1c: ΔE 11.3 normal
 *                               (below the 15 floor), 3.6 deutan. Brown next to
 *                               red is hard for anyone and impossible for some.
 *   1,2,3,7,6,8,5 light  ALL PASS (one WARN: cat-3 ↔ cat-2 ΔE 7.7 protan, which
 *                               is why every series is also directly labelled
 *                               and separated by a 2px surface gap — the
 *                               secondary encoding that WARN requires).
 *   1,2,3,7,6,8,5 dark   CVD, normal-vision and contrast all PASS. The lightness
 *                               band still fails, because Wren's dark cat tokens
 *                               are deliberately bright for a near-black page.
 *                               That is a repo-wide property of the theme, not
 *                               something this report should repaint in one file.
 *
 * cat-4 is DELIBERATELY NOT USED as a series colour: Wren binds it to the same
 * red as --c-danger, and a status colour must not double as "series four". An
 * eighth series is folded into "Other" rather than given a generated hue.
 * ═══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WrenLookbackCharts = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Re-stepped so every ADJACENT pair separates. See the header.
  var SERIES = ['var(--c-cat-1)', 'var(--c-cat-2)', 'var(--c-cat-3)', 'var(--c-cat-7)',
                'var(--c-cat-6)', 'var(--c-cat-8)', 'var(--c-cat-5)'];
  var MAX_SERIES = SERIES.length;

  // Colour follows the ENTITY, never its position in a filtered list: a key that
  // disappears must not repaint the ones that remain. So a known key gets a
  // fixed slot, and anything else is allocated in first-seen order and cached.
  var FIXED = {
    // next-step outcomes
    'achieved': 1, 'active': 0, 'retired': 2, 'superseded': 6, 'parked': 5, 'closed (no reason)': 4,
    // rooms
    'Baby Room': 0, 'Pre-school': 1, 'Outside room ages': 4,
    // observation quality signals
    'has_area': 0, 'has_analysis': 1, 'has_next_step': 2, 'has_stmt': 3,
    'has_photo': 4, 'shared': 5, 'by_key_person': 6,
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { return (v == null || isNaN(Number(v))) ? null : Number(v); }
  function fmt(v, unit) {
    var n = num(v);
    if (n == null) return '–';
    var s = (Math.abs(n) >= 100 || Number.isInteger(n)) ? String(Math.round(n * 10) / 10) : String(Math.round(n * 100) / 100);
    return unit === '%' ? s + '%' : (unit === '×' ? s + '×' : s);
  }

  /** A stable colour for a series key. `order` is the chart's own key list. */
  function colourFor(key, order) {
    if (Object.prototype.hasOwnProperty.call(FIXED, key)) return SERIES[FIXED[key] % MAX_SERIES];
    var i = order ? order.indexOf(key) : -1;
    if (i < 0) i = 0;
    return SERIES[i % MAX_SERIES];
  }

  // ── geometry ──────────────────────────────────────────────────────────────
  // One set of numbers, scaled. scale 1 = the page; scale ~1.9 = the projector.
  function geo(opts) {
    var o = opts || {};
    var sc = o.scale || 1;
    return {
      sc: sc,
      w: o.width || 980,
      h: o.height || (sc > 1.4 ? 520 : 300),
      // padT leaves a line for the axis label ABOVE the plot plus room for the
      // value printed over the tallest bar. It has to clear BOTH: at 14*sc the
      // axis label overprinted the topmost tick number, which only showed up in
      // a screenshot.
      padL: 62 * Math.min(sc, 1.5), padR: 18, padT: 30 * sc, padB: 56 * Math.min(sc, 1.5),
      font: Math.round(12 * sc), fontSmall: Math.round(10.5 * sc), fontBig: Math.round(14 * sc),
      gap: 2,                     // the surface gap between adjacent / stacked fills
      radius: 4,                  // rounded data-ends
    };
  }

  /** A rect with only its data-end rounded, anchored to the baseline. */
  function barPath(x, y, w, h, r) {
    if (h <= 0.5) return '';
    var rr = Math.min(r, w / 2, h);
    return 'M' + x + ',' + (y + h)
      + 'V' + (y + rr)
      + 'Q' + x + ',' + y + ' ' + (x + rr) + ',' + y
      + 'H' + (x + w - rr)
      + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + rr)
      + 'V' + (y + h) + 'Z';
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / mag;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  function axes(g, maxV, ticks, axisLabel, refLine) {
    var innerH = g.h - g.padT - g.padB;
    var out = '';
    var n = ticks || 4;
    for (var i = 0; i <= n; i++) {
      var v = (maxV / n) * i;
      var y = g.padT + innerH - (innerH * (v / (maxV || 1)));
      out += '<line x1="' + g.padL + '" y1="' + y.toFixed(1) + '" x2="' + (g.w - g.padR)
        + '" y2="' + y.toFixed(1) + '" stroke="var(--c-border)" stroke-width="1"'
        + (i === 0 ? '' : ' stroke-dasharray="2 4"') + '/>'
        + '<text x="' + (g.padL - 8) + '" y="' + (y + g.fontSmall * 0.35).toFixed(1)
        + '" text-anchor="end" font-size="' + g.fontSmall + '" fill="var(--c-muted)">'
        + esc(Math.round(v * 10) / 10) + '</text>';
    }
    if (refLine != null && refLine > 0 && refLine <= maxV) {
      var ry = g.padT + innerH - (innerH * (refLine / maxV));
      out += '<line x1="' + g.padL + '" y1="' + ry.toFixed(1) + '" x2="' + (g.w - g.padR) + '" y2="' + ry.toFixed(1)
        + '" stroke="var(--c-text)" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.55"/>'
        + '<text x="' + (g.w - g.padR) + '" y="' + (ry - 5).toFixed(1) + '" text-anchor="end" font-size="'
        + g.fontSmall + '" fill="var(--c-muted)">' + esc(refLine) + '</text>';
    }
    if (axisLabel) {
      // Anchored START at the very left of the viewBox, on its own line above
      // the plot. Anchored END at the gutter (the first draft) pushed anything
      // longer than ~60px off the left edge of the card — found by measuring
      // label rects in a real browser, not by reading the code.
      out += '<text x="2" y="' + (g.fontSmall + 1) + '" text-anchor="start" font-size="'
        + g.fontSmall + '" fill="var(--c-muted)">' + esc(axisLabel) + '</text>';
    }
    return out;
  }

  // The seven EYFS areas, in the short forms practitioners already say out loud.
  // A bar chart of areas puts 'Personal, Social and Emotional Development'
  // under a 90px band, and the full names simply printed over each other. The
  // full name stays in the tooltip, the legend and the numbers table.
  var AREA_SHORT = {
    'Personal, Social and Emotional Development': 'PSED',
    'Communication and Language': 'C&L',
    'Physical Development': 'PD',
    'Understanding The World': 'UW',
    'Understanding the World': 'UW',
    'Expressive Arts and Design': 'EAD',
    'Mathematics': 'Maths',
    'Literacy': 'Literacy',
    'Outside room ages': 'Outside',
  };

  /** Roughly how wide a string renders. Good enough to decide whether to
   *  shorten; the browser is the judge of the final layout. */
  function textW(str, fontPx) { return String(str).length * fontPx * 0.56; }

  function shortLabel(label, fontPx, maxW) {
    var s0 = AREA_SHORT[label] || label;
    if (textW(s0, fontPx) <= maxW) return s0;
    var keep = Math.max(3, Math.floor(maxW / (fontPx * 0.56)) - 1);
    return s0.slice(0, keep).replace(/[\s,]+$/, '') + '…';
  }

  function xLabels(g, pts, bandW, x0) {
    var y = g.h - g.padB + g.font + 4;
    // A collided axis is unreadable. Three things in order: the short form of a
    // known label, then every other label if the band is very narrow, then an
    // ellipsis. The hover band and the numbers table always carry the full one.
    var maxW = bandW - 4;
    var labels = pts.map(function (p) { return shortLabel(p.label, g.fontSmall, maxW); });
    var tooWide = labels.some(function (l) { return textW(l, g.fontSmall) > maxW; });
    var every = (tooWide || bandW < g.fontSmall * 2.6) ? 2 : 1;
    return pts.map(function (p, i) {
      if (i % every) return '';
      var cx = x0 + bandW * i + bandW / 2;
      var txt = shortLabel(p.label, g.fontSmall, every > 1 ? (bandW * 2 - 6) : maxW);
      return '<text x="' + cx.toFixed(1) + '" y="' + y + '" text-anchor="middle" font-size="' + g.fontSmall
        + '" fill="var(--c-muted)">' + esc(txt) + '<title>' + esc(p.full || p.label) + '</title></text>'
        + (p.partial ? '<text x="' + cx.toFixed(1) + '" y="' + (y + g.fontSmall * 1.45).toFixed(1) + '" text-anchor="middle" font-size="'
            + g.fontSmall + '" fill="var(--c-muted)">part yr</text>' : '');
    }).join('');
  }

  /** The hover layer: one transparent band per bucket, carrying the numbers the
   *  page's tooltip reads. A native <title> is the fallback, so the pack — which
   *  has no JavaScript at all — still shows a tooltip on the projector. */
  function hoverBands(g, pts, bandW, x0, describe) {
    return pts.map(function (p, i) {
      var t = describe(p);
      return '<g class="lb-hit" data-tip="' + esc(t) + '">'
        + '<rect x="' + (x0 + bandW * i).toFixed(1) + '" y="' + g.padT + '" width="' + bandW.toFixed(1)
        + '" height="' + (g.h - g.padT - g.padB) + '" fill="transparent"><title>' + esc(t) + '</title></rect></g>';
    }).join('');
  }

  function suppressedMark(g, x, bandW) {
    var innerH = g.h - g.padT - g.padB;
    return '<text x="' + (x + bandW / 2).toFixed(1) + '" y="' + (g.padT + innerH / 2).toFixed(1)
      + '" text-anchor="middle" font-size="' + g.fontSmall + '" fill="var(--c-muted)" opacity="0.8">n&lt;5</text>';
  }

  function svgOpen(g, title) {
    // No height attribute: height="auto" is not a valid SVG <length> and Chrome
    // logs 'Expected length, "auto"' for every chart. The aspect ratio comes
    // from the viewBox and the size from CSS (.lb-svg { width:100%; height:auto }).
    return '<svg class="lb-svg" viewBox="0 0 ' + g.w + ' ' + g.h + '" width="100%" role="img"'
      + ' preserveAspectRatio="xMidYMid meet" aria-label="' + esc(title || 'chart') + '"'
      + ' font-family="inherit">';
  }

  function legend(items, g) {
    // A legend is always present for two or more series; one series needs none,
    // because the title names it.
    if (!items || items.length < 2) return '';
    return '<div class="lb-legend">' + items.map(function (it) {
      return '<span class="lb-key"><i style="background:' + it.colour + '"></i>' + esc(it.label) + '</span>';
    }).join('') + '</div>';
  }

  // ── dist: a median with the middle half shaded ────────────────────────────
  function renderDist(chart, opts) {
    var g = geo(opts);
    var pts = (chart.data || []).slice();
    if (!pts.length) return note('Nothing to show for this window.');
    var vals = [];
    pts.forEach(function (p) {
      if (p.suppressed) return;
      [p.value, p.p75, p.max].forEach(function (v) { if (num(v) != null) vals.push(num(v)); });
    });
    var maxV = chart.max != null ? chart.max : niceMax(Math.max.apply(null, vals.length ? vals : [1]));
    var innerH = g.h - g.padT - g.padB;
    var x0 = g.padL, bandW = (g.w - g.padL - g.padR) / pts.length;
    var barW = Math.max(6, bandW - Math.max(g.gap * 2, bandW * 0.3));
    var yOf = function (v) { return g.padT + innerH - innerH * (Math.min(num(v) || 0, maxV) / maxV); };

    var body = '';
    pts.forEach(function (p, i) {
      var bx = x0 + bandW * i + (bandW - barW) / 2;
      if (p.suppressed) { body += suppressedMark(g, x0 + bandW * i, bandW); return; }
      if (num(p.value) == null) {
        body += '<text x="' + (x0 + bandW * i + bandW / 2).toFixed(1) + '" y="' + (g.padT + innerH / 2).toFixed(1)
          + '" text-anchor="middle" font-size="' + g.fontSmall + '" fill="var(--c-muted)" opacity="0.8">no data</text>';
        return;
      }
      // the middle half, as a soft band
      if (num(p.p25) != null && num(p.p75) != null && num(p.p75) > num(p.p25)) {
        var yT = yOf(p.p75), yB = yOf(p.p25);
        body += '<rect x="' + bx.toFixed(1) + '" y="' + yT.toFixed(1) + '" width="' + barW.toFixed(1)
          + '" height="' + Math.max(1, yB - yT).toFixed(1) + '" rx="3" fill="' + SERIES[0] + '" opacity="0.22"/>';
      }
      // the median, as a thin mark with a 2px surface ring so it reads on the band
      var ym = yOf(p.value);
      body += '<line x1="' + bx.toFixed(1) + '" y1="' + ym.toFixed(1) + '" x2="' + (bx + barW).toFixed(1)
        + '" y2="' + ym.toFixed(1) + '" stroke="var(--c-surface)" stroke-width="' + (4 + g.gap) + '" stroke-linecap="round"/>'
        + '<line x1="' + bx.toFixed(1) + '" y1="' + ym.toFixed(1) + '" x2="' + (bx + barW).toFixed(1)
        + '" y2="' + ym.toFixed(1) + '" stroke="' + SERIES[0] + '" stroke-width="4" stroke-linecap="round"/>'
        + '<text x="' + (bx + barW / 2).toFixed(1) + '" y="' + (ym - 7).toFixed(1) + '" text-anchor="middle" font-size="'
        + g.fontSmall + '" fill="var(--c-text)">' + esc(fmt(p.value, chart.unit)) + '</text>';
    });

    var describe = function (p) {
      if (p.suppressed) return (p.full || p.label) + ' — fewer than 5 children, suppressed';
      if (num(p.value) == null) return (p.full || p.label) + ' — no data (n=' + p.n + ')';
      return (p.full || p.label) + ': median ' + fmt(p.value, chart.unit)
        + (num(p.p25) != null ? ', middle half ' + fmt(p.p25, chart.unit) + ' to ' + fmt(p.p75, chart.unit) : '')
        + ' · ' + p.rows + (p.rows === 1 ? ' record' : ' records') + ', ' + p.n + ' children';
    };

    return svgOpen(g, chart.title)
      + axes(g, maxV, 4, chart.axis, chart.reference)
      + body + xLabels(g, pts, bandW, x0)
      + hoverBands(g, pts, bandW, x0, describe)
      + '</svg>'
      + '<div class="lb-legend lb-legend-note"><span class="lb-key"><i class="lb-med"></i>median</span>'
      + '<span class="lb-key"><i class="lb-band"></i>middle half (25th–75th)</span></div>'
      + areaKey(pts);
  }

  // ── bar: one value per bucket, with an optional comparison mark ───────────
  function renderBar(chart, opts) {
    var g = geo(opts);
    var pts = (chart.data || []).slice();
    if (!pts.length) return note('Nothing to show for this window.');
    var vals = pts.filter(function (p) { return !p.suppressed && num(p.value) != null; }).map(function (p) { return num(p.value); });
    if (chart.compareKey) pts.forEach(function (p) { if (num(p[chart.compareKey]) != null) vals.push(num(p[chart.compareKey])); });
    var maxV = chart.max != null ? chart.max : niceMax(Math.max.apply(null, vals.length ? vals : [1]));
    var innerH = g.h - g.padT - g.padB;
    var x0 = g.padL, bandW = (g.w - g.padL - g.padR) / pts.length;
    var barW = Math.max(6, bandW - Math.max(g.gap * 2, bandW * 0.34));
    var yOf = function (v) { return g.padT + innerH - innerH * (Math.min(num(v) || 0, maxV) / maxV); };

    var body = '';
    pts.forEach(function (p, i) {
      var bx = x0 + bandW * i + (bandW - barW) / 2;
      if (p.suppressed) { body += suppressedMark(g, x0 + bandW * i, bandW); return; }
      if (num(p.value) == null) { return; }
      var y = yOf(p.value);
      body += '<path d="' + barPath(bx, y, barW, (g.padT + innerH) - y, g.radius) + '" fill="' + SERIES[0] + '"/>'
        + '<text x="' + (bx + barW / 2).toFixed(1) + '" y="' + (y - 6).toFixed(1) + '" text-anchor="middle" font-size="'
        + g.fontSmall + '" fill="var(--c-text)">' + esc(fmt(p.value, chart.unit)) + '</text>';
      if (chart.compareKey && num(p[chart.compareKey]) != null) {
        var cy = yOf(p[chart.compareKey]);
        body += '<line x1="' + (bx - 2).toFixed(1) + '" y1="' + cy.toFixed(1) + '" x2="' + (bx + barW + 2).toFixed(1)
          + '" y2="' + cy.toFixed(1) + '" stroke="var(--c-surface)" stroke-width="5" stroke-linecap="round"/>'
          + '<line x1="' + (bx - 2).toFixed(1) + '" y1="' + cy.toFixed(1) + '" x2="' + (bx + barW + 2).toFixed(1)
          + '" y2="' + cy.toFixed(1) + '" stroke="' + SERIES[1] + '" stroke-width="2.5" stroke-linecap="round"/>';
      }
    });

    var describe = function (p) {
      if (p.suppressed) return (p.full || p.label) + ' — fewer than 5 children, suppressed';
      return (p.full || p.label) + ': ' + fmt(p.value, chart.unit)
        + (chart.compareKey && num(p[chart.compareKey]) != null ? ' · ' + chart.compareLabel + ': ' + fmt(p[chart.compareKey], chart.unit) : '')
        + (p.rows != null ? ' · ' + p.rows + ' records' : '') + ' · ' + p.n + ' children';
    };

    var keys = [{ label: chart.title, colour: SERIES[0] }];
    if (chart.compareKey) keys.push({ label: chart.compareLabel || 'comparison', colour: SERIES[1] });

    return svgOpen(g, chart.title)
      + axes(g, maxV, 4, chart.axis, chart.reference)
      + body + xLabels(g, pts, bandW, x0)
      + hoverBands(g, pts, bandW, x0, describe)
      + '</svg>' + legend(keys, g) + areaKey(pts);
  }

  // ── stacked: parts per bucket ─────────────────────────────────────────────
  function renderStacked(chart, opts) {
    var g = geo(opts);
    var pts = (chart.data || []).slice();
    if (!pts.length) return note('Nothing to show for this window.');
    // the key order: the chart's own list, else first-seen across the data
    var keys = (chart.keys || []).slice();
    if (!keys.length) {
      pts.forEach(function (p) { (p.parts || []).forEach(function (x) { if (keys.indexOf(x.key) < 0) keys.push(x.key); }); });
    }
    // An eighth series folds into "Other" rather than getting a generated hue.
    var used = keys.slice(0, MAX_SERIES), folded = keys.slice(MAX_SERIES);
    var totalOf = function (p) { return (p.parts || []).reduce(function (a, x) { return a + (num(x.rows) || 0); }, 0); };
    var maxV = niceMax(Math.max.apply(null, pts.filter(function (p) { return !p.suppressed; }).map(totalOf).concat([1])));
    var innerH = g.h - g.padT - g.padB;
    var x0 = g.padL, bandW = (g.w - g.padL - g.padR) / pts.length;
    var barW = Math.max(6, bandW - Math.max(g.gap * 2, bandW * 0.34));

    var body = '';
    pts.forEach(function (p, i) {
      var bx = x0 + bandW * i + (bandW - barW) / 2;
      if (p.suppressed) { body += suppressedMark(g, x0 + bandW * i, bandW); return; }
      var parts = p.parts || [];
      var acc = 0, segs = [];
      used.forEach(function (k) {
        var row = parts.filter(function (x) { return x.key === k; })[0];
        var v = row ? (num(row.rows) || 0) : 0;
        if (v > 0) segs.push({ k: k, v: v });
      });
      var othersV = folded.reduce(function (a, k) {
        var row = parts.filter(function (x) { return x.key === k; })[0];
        return a + (row ? (num(row.rows) || 0) : 0);
      }, 0);
      if (othersV > 0) segs.push({ k: 'Other', v: othersV });
      var total = segs.reduce(function (a, s) { return a + s.v; }, 0);
      segs.forEach(function (s, si) {
        var hFull = innerH * (s.v / maxV);
        var yTop = g.padT + innerH - innerH * ((acc + s.v) / maxV);
        // a 2px surface gap between segments, taken off the top of each
        var h = Math.max(1, hFull - (si === segs.length - 1 ? 0 : g.gap));
        var col = s.k === 'Other' ? 'var(--c-muted)' : colourFor(s.k, used);
        body += '<rect x="' + bx.toFixed(1) + '" y="' + (yTop + (si === segs.length - 1 ? 0 : g.gap)).toFixed(1)
          + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) + '"'
          + (si === segs.length - 1 ? ' rx="' + g.radius + '"' : '')
          + ' fill="' + col + '"/>';
        acc += s.v;
      });
      if (total > 0) {
        var yT2 = g.padT + innerH - innerH * (total / maxV);
        body += '<text x="' + (bx + barW / 2).toFixed(1) + '" y="' + (yT2 - 6).toFixed(1) + '" text-anchor="middle" font-size="'
          + g.fontSmall + '" fill="var(--c-text)">' + esc(total) + '</text>';
      }
    });

    var describe = function (p) {
      if (p.suppressed) return (p.full || p.label) + ' — fewer than 5 children, suppressed';
      var parts = (p.parts || []).filter(function (x) { return num(x.rows); });
      return (p.full || p.label) + ': ' + totalOf(p) + ' ' + (chart.unit || '')
        + (parts.length ? ' — ' + parts.map(function (x) { return x.key + ' ' + x.rows; }).join(', ') : '')
        + ' · ' + p.n + ' children';
    };

    var items = used.map(function (k) { return { label: labelOf(k), colour: colourFor(k, used) }; });
    if (folded.length) items.push({ label: 'Other', colour: 'var(--c-muted)' });

    return svgOpen(g, chart.title)
      + axes(g, maxV, 4, chart.axis || chart.unit, null)
      + body + xLabels(g, pts, bandW, x0)
      + hoverBands(g, pts, bandW, x0, describe)
      + '</svg>' + legend(items, g);
  }

  // ── line: one value per bucket over time ──────────────────────────────────
  function renderLine(chart, opts) {
    var g = geo(opts);
    var pts = (chart.data || []).slice();
    if (!pts.length) return note('Nothing to show for this window.');
    var vals = pts.filter(function (p) { return !p.suppressed && num(p.value) != null; }).map(function (p) { return num(p.value); });
    if (!vals.length) return note('Every group in this window is under five children, so nothing can be shown.');
    var maxV = chart.max != null ? chart.max : niceMax(Math.max.apply(null, vals));
    var innerH = g.h - g.padT - g.padB;
    var x0 = g.padL, bandW = (g.w - g.padL - g.padR) / pts.length;
    var cxOf = function (i) { return x0 + bandW * i + bandW / 2; };
    var yOf = function (v) { return g.padT + innerH - innerH * (Math.min(num(v), maxV) / maxV); };

    // Gaps are gaps: a suppressed or missing bucket breaks the line rather than
    // being interpolated through, because a drawn-through gap is a claim.
    var runs = [], cur = [];
    pts.forEach(function (p, i) {
      if (p.suppressed || num(p.value) == null) { if (cur.length) { runs.push(cur); cur = []; } return; }
      cur.push({ i: i, p: p });
    });
    if (cur.length) runs.push(cur);

    var body = runs.map(function (run) {
      if (run.length === 1) return '';
      return '<polyline points="' + run.map(function (r) { return cxOf(r.i).toFixed(1) + ',' + yOf(r.p.value).toFixed(1); }).join(' ')
        + '" fill="none" stroke="' + SERIES[0] + '" stroke-width="2" stroke-linejoin="round"/>';
    }).join('');

    pts.forEach(function (p, i) {
      if (p.suppressed) { body += suppressedMark(g, x0 + bandW * i, bandW); return; }
      if (num(p.value) == null) return;
      var cx = cxOf(i), cy = yOf(p.value);
      body += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="5" fill="' + SERIES[0]
        + '" stroke="var(--c-surface)" stroke-width="2"/>'
        + '<text x="' + cx.toFixed(1) + '" y="' + (cy - 11).toFixed(1) + '" text-anchor="middle" font-size="'
        + g.fontSmall + '" fill="var(--c-text)">' + esc(fmt(p.value, chart.unit)) + '</text>';
    });

    var describe = function (p) {
      if (p.suppressed) return (p.full || p.label) + ' — fewer than 5 children, suppressed';
      return (p.full || p.label) + ': ' + fmt(p.value, chart.unit) + ' · ' + p.n + ' children'
        + (p.partial ? ' · PART YEAR' : '');
    };

    return svgOpen(g, chart.title)
      + axes(g, maxV, 4, chart.axis || chart.unit, chart.reference)
      + body + xLabels(g, pts, bandW, x0)
      + hoverBands(g, pts, bandW, x0, describe)
      + '</svg>';
  }

  // ── multiline: several % series over the same buckets ─────────────────────
  function renderMultiline(chart, opts) {
    var g = geo(opts);
    var series = (chart.series || []).slice(0, MAX_SERIES);
    var folded = (chart.series || []).slice(MAX_SERIES);
    if (!series.length) return note('Nothing to show for this window.');
    var pts = series[0].series || [];
    if (!pts.length) return note('Nothing to show for this window.');
    var all = [];
    series.forEach(function (s) { (s.series || []).forEach(function (p) { if (!p.suppressed && num(p.value) != null) all.push(num(p.value)); }); });
    var maxV = chart.max != null ? chart.max : niceMax(Math.max.apply(null, all.length ? all : [1]));
    var innerH = g.h - g.padT - g.padB;
    var x0 = g.padL, bandW = (g.w - g.padL - g.padR) / pts.length;
    var cxOf = function (i) { return x0 + bandW * i + bandW / 2; };
    var yOf = function (v) { return g.padT + innerH - innerH * (Math.min(num(v), maxV) / maxV); };
    var order = series.map(function (s) { return s.key || s.label; });

    var body = '', endLabels = [];
    series.forEach(function (s) {
      var col = colourFor(s.key || s.label, order);
      var sp = s.series || [], runs = [], cur = [];
      sp.forEach(function (p, i) {
        if (p.suppressed || num(p.value) == null) { if (cur.length) { runs.push(cur); cur = []; } return; }
        cur.push({ i: i, p: p });
      });
      if (cur.length) runs.push(cur);
      runs.forEach(function (run) {
        if (run.length > 1) {
          body += '<polyline points="' + run.map(function (r) { return cxOf(r.i).toFixed(1) + ',' + yOf(r.p.value).toFixed(1); }).join(' ')
            + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round"/>';
        }
        run.forEach(function (r) {
          body += '<circle cx="' + cxOf(r.i).toFixed(1) + '" cy="' + yOf(r.p.value).toFixed(1)
            + '" r="4" fill="' + col + '" stroke="var(--c-surface)" stroke-width="2"/>';
        });
      });
      // One direct label at the end of each line — identity is never colour
      // alone, and this is also the secondary encoding the light-mode CVD WARN
      // requires. No number on every point. They are COLLECTED here and placed
      // after every series is drawn: on real data four of these lines finish on
      // 0% and the labels landed on top of each other and on the axis.
      var last = runs.length ? runs[runs.length - 1][runs[runs.length - 1].length - 1] : null;
      if (last) endLabels.push({ i: last.i, y: yOf(last.p.value), text: fmt(last.p.value, chart.unit) });
    });

    // Push coincident end labels apart. On real data four of these lines finish
    // on the same value, so without this they print on top of each other — and
    // a naive single downward pass then stacks them onto the baseline, where
    // they collide with the term labels underneath. Hence three passes: down,
    // then clamped to the plot, then UP from the bottom. Clamping alone is what
    // an earlier version did, and it simply re-collided everything it clamped.
    // 1.5em, not 1.25em: a text box is taller than its font-size (ascender plus
    // descender), so a 1.25em gap left adjacent labels overlapping by about a
    // pixel — invisible in a calculation, caught by measuring the real boxes.
    var minGap      = g.fontSmall * 1.5;
    var topLimit    = g.padT + g.fontSmall * 0.8;
    var bottomLimit = g.padT + innerH - g.fontSmall * 1.1;
    endLabels.sort(function (a, b) { return a.y - b.y; });
    for (var k = 1; k < endLabels.length; k++) {
      if (endLabels[k].y - endLabels[k - 1].y < minGap) endLabels[k].y = endLabels[k - 1].y + minGap;
    }
    if (endLabels.length && endLabels[endLabels.length - 1].y > bottomLimit) {
      endLabels[endLabels.length - 1].y = bottomLimit;
      for (var j = endLabels.length - 2; j >= 0; j--) {
        if (endLabels[j + 1].y - endLabels[j].y < minGap) endLabels[j].y = endLabels[j + 1].y - minGap;
      }
    }
    // If the stack is taller than the plot there is nothing left to do but let
    // the numbers table carry it, so the labels are clipped to the top rather
    // than printed over the title.
    endLabels.forEach(function (e) { e.y = Math.max(topLimit, e.y); });
    endLabels.forEach(function (e) {
      var lx = Math.min(cxOf(e.i) + 8, g.w - g.padR - 4);
      body += '<text x="' + lx.toFixed(1) + '" y="' + (e.y + g.fontSmall * 0.35).toFixed(1)
        + '" text-anchor="end" font-size="' + g.fontSmall + '" fill="var(--c-text)">'
        + esc(e.text) + '</text>';
    });

    var describe = function (p, i) {
      var lines = series.map(function (s) {
        var q = (s.series || [])[i];
        if (!q) return null;
        return s.label + ': ' + (q.suppressed ? 'n<5' : fmt(q.value, chart.unit));
      }).filter(Boolean);
      return (p.full || p.label) + ' — ' + lines.join(' · ');
    };
    var hover = pts.map(function (p, i) {
      var t = describe(p, i);
      return '<g class="lb-hit" data-tip="' + esc(t) + '"><rect x="' + (x0 + bandW * i).toFixed(1) + '" y="' + g.padT
        + '" width="' + bandW.toFixed(1) + '" height="' + innerH + '" fill="transparent"><title>' + esc(t) + '</title></rect></g>';
    }).join('');

    var items = series.map(function (s) { return { label: s.label, colour: colourFor(s.key || s.label, order) }; });
    if (folded.length) items.push({ label: folded.length + ' more (see the numbers)', colour: 'var(--c-muted)' });

    return svgOpen(g, chart.title)
      + axes(g, maxV, 4, chart.axis || chart.unit, chart.reference)
      + body + xLabels(g, pts, bandW, x0) + hover + '</svg>' + legend(items, g);
  }

  // ── table: the one form that is not a chart ───────────────────────────────
  function renderTable(chart) {
    var rows = chart.data || [];
    if (!rows.length) return note('Nothing to show for this window.');
    var cols = [];
    rows.forEach(function (r) { (r.metrics || []).forEach(function (m) { if (cols.indexOf(m.label) < 0) cols.push(m.label); }); });
    return '<div class="lb-tablewrap"><table class="lb-table"><thead><tr><th>Room</th><th class="n">Observations</th><th class="n">Children</th>'
      + cols.map(function (c) { return '<th class="n">' + esc(c) + '</th>'; }).join('')
      + '</tr></thead><tbody>'
      + rows.map(function (r) {
        if (r.suppressed) {
          return '<tr><th scope="row">' + esc(r.label) + '</th><td class="n" colspan="' + (cols.length + 2)
            + '"><span class="lb-sup">fewer than 5 children — suppressed</span></td></tr>';
        }
        return '<tr><th scope="row">' + esc(r.label) + '</th><td class="n">' + esc(r.value) + '</td><td class="n">' + esc(r.n) + '</td>'
          + cols.map(function (c) {
            var m = (r.metrics || []).filter(function (x) { return x.label === c; })[0];
            return '<td class="n">' + (m && m.value != null ? esc(m.value) + '%' : '–') + '</td>';
          }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function note(msg) { return '<p class="lb-note">' + esc(msg) + '</p>'; }

  var LABELS = {
    has_area: 'Names an EYFS area', has_analysis: 'Has analysis', has_next_step: 'Sets a next step',
    has_stmt: 'Linked to a statement', has_photo: 'Has a photo', shared: 'Shared with the family',
    by_key_person: 'By the key person',
  };
  // The abbreviations used on an axis, spelled out once under the chart, so
  // nobody has to know what EAD stands for.
  function areaKey(pts) {
    var used = (pts || []).map(function (p) { return p.full || p.label; })
      .filter(function (l) { return AREA_SHORT[l] && AREA_SHORT[l] !== l; });
    if (!used.length) return '';
    var seen = [];
    used.forEach(function (l) { if (seen.indexOf(l) < 0) seen.push(l); });
    return '<p class="lb-note" style="margin:.6em 0 0;font-size:.85em">'
      + seen.map(function (l) { return '<b>' + esc(AREA_SHORT[l]) + '</b> ' + esc(l); }).join(' · ') + '</p>';
  }
  function labelOf(k) { return LABELS[k] || k; }

  /** The numbers behind any chart, as a table. Always available — a chart that
   *  cannot be read by colour can always be read here. */
  function renderNumbers(chart) {
    if (chart.kind === 'table') return renderTable(chart);
    var rows = [];
    if (chart.kind === 'multiline') {
      (chart.series || []).forEach(function (s) {
        (s.series || []).forEach(function (p) { rows.push({ series: s.label, label: p.full || p.label, p: p }); });
      });
    } else {
      (chart.data || []).forEach(function (p) { rows.push({ series: '', label: p.full || p.label, p: p }); });
    }
    if (!rows.length) return '';
    var hasSeries = rows.some(function (r) { return r.series; });
    var hasSpread = rows.some(function (r) { return r.p.p25 != null; });
    return '<div class="lb-tablewrap"><table class="lb-table"><thead><tr>'
      + (hasSeries ? '<th>Series</th>' : '') + '<th>Bucket</th><th class="n">Value</th>'
      + (hasSpread ? '<th class="n">25th</th><th class="n">75th</th><th class="n">Records</th>' : '')
      + '<th class="n">Children</th></tr></thead><tbody>'
      + rows.map(function (r) {
        var p = r.p;
        return '<tr>' + (hasSeries ? '<td>' + esc(r.series) + '</td>' : '')
          + '<th scope="row">' + esc(r.label) + (p.partial ? ' <span class="lb-sup">part yr</span>' : '') + '</th>'
          + '<td class="n">' + (p.suppressed ? '<span class="lb-sup">n&lt;5</span>' : esc(fmt(p.value, chart.unit))) + '</td>'
          + (hasSpread ? '<td class="n">' + (p.p25 == null ? '–' : esc(p.p25)) + '</td><td class="n">'
              + (p.p75 == null ? '–' : esc(p.p75)) + '</td><td class="n">' + (p.rows == null ? '–' : esc(p.rows)) + '</td>' : '')
          + '<td class="n">' + esc(p.n) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /** Is there anything at all to draw? A chart where every bucket is suppressed
   *  or empty is an axis with nothing on it — on a projector that reads as a
   *  rendering fault rather than as the finding it actually is. */
  function hasAnything(chart) {
    if (chart.kind === 'table') return (chart.data || []).some(function (r) { return !r.suppressed; });
    if (chart.kind === 'multiline') {
      return (chart.series || []).some(function (s) {
        return (s.series || []).some(function (p) { return !p.suppressed && num(p.value) != null; });
      });
    }
    return (chart.data || []).some(function (p) {
      if (p.suppressed) return false;
      if (num(p.value) != null) return true;
      return !!(p.parts && p.parts.some(function (x) { return num(x.rows); }));
    });
  }

  function nothingToDraw(chart) {
    var pts = chart.kind === 'multiline'
      ? ((chart.series || [])[0] || {}).series || []
      : (chart.data || []);
    var sup = pts.filter(function (p) { return p && p.suppressed; }).length;
    if (!pts.length) return note('No data in this window for ' + (chart.title || 'this chart') + '.');
    if (sup === pts.length) {
      return note('Every group here is under five children, so every one is suppressed and nothing can be drawn. '
        + 'That is the finding: there is not yet enough of this to measure, and the numbers below say how little.');
    }
    return note('There is nothing to plot here yet — the groups that are big enough to show have no value to report.');
  }

  /** Render any chart the engine produces. */
  function render(chart, opts) {
    if (!chart) return '';
    if (chart.empty || chart.kind === 'none') return note(chart.why || 'Not available.');
    if (!hasAnything(chart)) return nothingToDraw(chart);
    switch (chart.kind) {
      case 'dist':      return renderDist(chart, opts);
      case 'bar':       return renderBar(chart, opts);
      case 'stacked':   return renderStacked(chart, opts);
      case 'line':      return renderLine(chart, opts);
      case 'multiline': return renderMultiline(chart, opts);
      case 'table':     return renderTable(chart, opts);
      default:          return note('Unknown chart type: ' + chart.kind);
    }
  }

  return {
    render: render, renderNumbers: renderNumbers, esc: esc, fmt: fmt,
    SERIES: SERIES, MAX_SERIES: MAX_SERIES, colourFor: colourFor, labelOf: labelOf,
  };
}));
