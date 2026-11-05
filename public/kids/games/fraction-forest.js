/* fraction-forest.js — Wren Kids (b507, 2026-10-18). KS2 · Mathematics · fractions.
 *
 * WHY THIS GAME. Fractions are where primary maths most often comes apart, and the reason is
 * almost always that the child met the symbols before the picture. 3/4 is a number, not two
 * numbers stacked up; 2/4 and 1/2 are the SAME number; "two thirds of 12" is a sharing action.
 * Every one of those is obvious with a bar in front of you and opaque without one.
 *
 * So every question here shows the bar first, and the symbol second, and the child moves between
 * them — concrete-pictorial-abstract, in the direction the research says works. Level 1 is purely
 * "which bar matches this fraction"; by level 5 the bar is gone and only the numbers are left,
 * which is exactly the journey the Year 3 to Year 6 programme of study describes.
 *
 * Levels: 1 name the shaded fraction (halves, quarters, thirds) · 2 match equivalent fractions
 *         with the bars shown · 3 equivalent fractions, symbols only · 4 fraction of an amount
 *         (1/4 of 20) · 5 compare and order, and add fractions with the same denominator
 */
(function (W) {
  'use strict';
  var K = W.Kids, U = K.util;

  function fracHtml(n, d) {
    return '<span class="k-frac"><span class="num">' + n + '</span><span class="den">' + d + '</span></span>';
  }
  function fracWords(n, d) {
    var names = { 2: 'half', 3: 'third', 4: 'quarter', 5: 'fifth', 6: 'sixth', 8: 'eighth', 10: 'tenth', 12: 'twelfth' };
    var one = names[d] || (d + 'th');
    return n + ' ' + one + (n > 1 ? (one === 'half' ? 'ves' : 's') : '');
  }
  function bar(n, d) {
    var b = U.el('div', 'k-fracbar');
    b.setAttribute('role', 'img');
    b.setAttribute('aria-label', fracWords(n, d) + ' shaded');
    for (var i = 0; i < d; i++) {
      var seg = U.el('i');
      if (i < n) seg.className = 'on';
      b.appendChild(seg);
    }
    return b;
  }
  function gcd(a, b) { return b ? gcd(b, a % b) : a; }

  var SIMPLE = [[1, 2], [1, 4], [3, 4], [1, 3], [2, 3], [2, 4], [1, 5], [2, 5], [3, 5], [4, 5]];
  var EQUIV = [
    [[1, 2], [2, 4], [3, 6], [4, 8], [5, 10], [6, 12]],
    [[1, 3], [2, 6], [3, 9], [4, 12]],
    [[1, 4], [2, 8], [3, 12]],
    [[2, 3], [4, 6], [6, 9], [8, 12]],
    [[3, 4], [6, 8], [9, 12]],
    [[1, 5], [2, 10]],
    [[2, 5], [4, 10]]
  ];

  K.game({
    slug: 'fraction-forest',
    title: 'Fraction Forest',
    short: 'Fractions, with the picture before the symbol.',
    emoji: '🍰',
    stage: 'ks2',
    accent: '--c-play-8',
    levels: 5,
    roundLength: 10,
    howTo: 'Every fraction has a picture. Match the picture to the fraction, find the ones that are worth the same, and work out fractions of an amount.',
    curriculum: {
      framework: null,
      codes: ['Y3-N-F-1', 'Y4-N-F-1', 'Y5-N-F-1', 'Y6-N-F-1'],
      nc: 'KS2 Mathematics — Year 3: recognise and show, using diagrams, equivalent fractions with small denominators; Year 4: recognise and show families of common equivalent fractions, find fractions of a quantity; Year 5: compare and order fractions; Year 6: add and subtract fractions with the same denominator.',
      plain: 'Naming fractions, equivalent fractions, fractions of an amount, and comparing fractions — picture first, symbol second (National Curriculum KS2 Mathematics: Fractions).',
      obs: 'Fractions go wrong when the symbol arrives before the picture. Worth checking the child can draw the bar for a fraction as well as read it.'
    },

    turn: function (api) {
      var lvl = Math.min(5, api.level);

      /* ── level 1: name the shaded fraction ───────────────────────────────── */
      if (lvl === 1) {
        var f = U.pick(SIMPLE.filter(function (p) { return p[1] <= 5; }));
        api.el.appendChild(bar(f[0], f[1]));
        api.ask('What fraction is shaded?');
        var tiles = U.el('div', 'k-tiles');
        api.el.appendChild(tiles);
        var opts = U.shuffle([f].concat(U.shuffle(SIMPLE.filter(function (p) {
          return !(p[0] === f[0] && p[1] === f[1]) && p[0] / p[1] !== f[0] / f[1];
        })).slice(0, 2)));
        opts.forEach(function (p) {
          var t = api.tile('', function (node) {
            api.lock();
            Array.prototype.forEach.call(tiles.querySelectorAll('.k-tile'), function (b) { b.disabled = true; });
            if (p[0] === f[0] && p[1] === f[1]) api.correct({ node: node });
            else api.wrong({ node: node, hint: 'It was ' + fracWords(f[0], f[1]) + '.' });
          }, { html: fracHtml(p[0], p[1]), aria: fracWords(p[0], p[1]) });
          tiles.appendChild(t);
        });
        return;
      }

      /* ── levels 2 and 3: equivalent fractions ────────────────────────────── */
      if (lvl === 2 || lvl === 3) {
        var fam = U.pick(EQUIV);
        var cue = fam[0];
        var match = U.pick(fam.slice(1));
        var card = U.el('div', 'k-focus-card');
        var cueBox = U.el('div');
        cueBox.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px';
        var h = U.el('span', 'k-sum-eq');
        h.innerHTML = fracHtml(cue[0], cue[1]);
        cueBox.appendChild(h);
        if (lvl === 2) cueBox.appendChild(bar(cue[0], cue[1]));
        card.appendChild(cueBox);
        api.el.appendChild(card);

        api.ask('Which one is worth the same as ' + fracWords(cue[0], cue[1]) + '?');

        var wrongPool = [];
        EQUIV.forEach(function (g) {
          if (g === fam) return;
          g.forEach(function (p) { if (p[1] !== 1) wrongPool.push(p); });
        });
        var picks = U.shuffle([match].concat(U.shuffle(wrongPool).slice(0, 2)));
        var t2 = U.el('div', 'k-tiles');
        api.el.appendChild(t2);
        picks.forEach(function (p) {
          var html = fracHtml(p[0], p[1]);
          var t = api.tile('', function (node) {
            api.lock();
            Array.prototype.forEach.call(t2.querySelectorAll('.k-tile'), function (b) { b.disabled = true; });
            if (p[0] === match[0] && p[1] === match[1]) api.correct({ node: node });
            else {
              var g = gcd(cue[0], cue[1]);
              api.wrong({
                node: node,
                hint: fracWords(match[0], match[1]) + ' is the same as ' + fracWords(cue[0], cue[1]) +
                      ' — both are ' + (cue[0] / g) + ' out of every ' + (cue[1] / g) + '.'
              });
            }
          }, { html: html, aria: fracWords(p[0], p[1]) });
          t2.appendChild(t);
        });
        return;
      }

      /* ── level 4: fraction of an amount ──────────────────────────────────── */
      if (lvl === 4) {
        var d = U.pick([2, 3, 4, 5]);
        var mult = U.rint(2, 6);
        var whole = d * mult;
        var n = U.rint(1, d - 1);
        var ans = (whole / d) * n;

        var c = U.el('div', 'k-focus-card');
        var q = U.el('span', 'k-sum-eq');
        q.innerHTML = fracHtml(n, d) + '&nbsp;of&nbsp;' + whole;
        c.appendChild(q);
        var box = U.el('div', 'k-answer-box', '?');
        c.appendChild(box);
        api.el.appendChild(c);
        api.el.appendChild(bar(n, d));

        api.ask('What is ' + fracWords(n, d) + ' of ' + whole + '?');
        var t4 = U.el('div', 'k-tiles');
        api.el.appendChild(t4);
        var o4 = U.shuffle([ans, whole / d, ans + whole / d, whole - ans]
          .filter(function (v, i, arr) { return v > 0 && arr.indexOf(v) === i; }).slice(0, 4));
        while (o4.length < 3) { var extra = ans + U.rint(1, 5); if (o4.indexOf(extra) < 0) o4.push(extra); }
        o4.forEach(function (v) {
          var t = api.tile(String(v), function (node) {
            api.lock();
            Array.prototype.forEach.call(t4.querySelectorAll('.k-tile'), function (b) { b.disabled = true; });
            box.textContent = String(v);
            if (v === ans) api.correct({ node: node });
            else {
              box.textContent = String(ans);
              api.wrong({
                node: node,
                hint: 'Share ' + whole + ' into ' + d + ' equal parts — that is ' + (whole / d) +
                      ' each — then take ' + n + ' of them: ' + ans + '.'
              });
            }
          }, { cls: 'big', aria: String(v) });
          t4.appendChild(t);
        });
        return;
      }

      /* ── level 5: compare, and add with the same denominator ─────────────── */
      var addMode = Math.random() < 0.5;
      if (addMode) {
        var den = U.pick([5, 6, 8, 10, 12]);
        var x = U.rint(1, den - 2), y = U.rint(1, den - x);
        var sum = x + y;
        var cc = U.el('div', 'k-focus-card');
        var qq = U.el('span', 'k-sum-eq');
        qq.innerHTML = fracHtml(x, den) + '&nbsp;+&nbsp;' + fracHtml(y, den) + '&nbsp;=';
        cc.appendChild(qq);
        api.el.appendChild(cc);
        api.ask('Add the two fractions.');
        var t5 = U.el('div', 'k-tiles');
        api.el.appendChild(t5);
        var wrongOnes = [[sum, den * 2], [x * y, den], [sum + 1, den]]
          .filter(function (p) { return !(p[0] === sum && p[1] === den); });
        U.shuffle([[sum, den]].concat(U.shuffle(wrongOnes).slice(0, 2))).forEach(function (p) {
          var t = api.tile('', function (node) {
            api.lock();
            Array.prototype.forEach.call(t5.querySelectorAll('.k-tile'), function (b) { b.disabled = true; });
            if (p[0] === sum && p[1] === den) api.correct({ node: node });
            else api.wrong({
              node: node,
              hint: 'The parts are the same size, so add the top numbers and keep the bottom one: ' +
                    x + ' and ' + y + ' is ' + sum + ', so ' + fracWords(sum, den) + '.'
            });
          }, { html: fracHtml(p[0], p[1]), aria: fracWords(p[0], p[1]) });
          t5.appendChild(t);
        });
        return;
      }

      var pool5 = SIMPLE.concat([[3, 8], [5, 8], [7, 10], [5, 6]]);
      var p1 = U.pick(pool5), p2 = U.pick(pool5.filter(function (p) { return p[0] / p[1] !== p1[0] / p1[1]; }));
      var bigger = (p1[0] / p1[1] > p2[0] / p2[1]) ? p1 : p2;
      var c5 = U.el('div', 'k-focus-card');
      c5.innerHTML = '<span class="k-sum-eq">' + fracHtml(p1[0], p1[1]) + '&nbsp;&nbsp;?&nbsp;&nbsp;' + fracHtml(p2[0], p2[1]) + '</span>';
      api.el.appendChild(c5);
      api.ask('Which fraction is bigger?');
      var t6 = U.el('div', 'k-tiles');
      api.el.appendChild(t6);
      [p1, p2].forEach(function (p) {
        var t = api.tile('', function (node) {
          api.lock();
          Array.prototype.forEach.call(t6.querySelectorAll('.k-tile'), function (b) { b.disabled = true; });
          /* show the bars — the explanation is the picture */
          var proof = U.el('div');
          proof.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:center;margin-top:10px';
          proof.appendChild(bar(p1[0], p1[1]));
          proof.appendChild(bar(p2[0], p2[1]));
          api.el.appendChild(proof);
          if (p === bigger) api.correct({ node: node });
          else api.wrong({ node: node, hint: fracWords(bigger[0], bigger[1]) + ' is more — look at the bars.' });
        }, { html: fracHtml(p[0], p[1]), aria: fracWords(p[0], p[1]) });
        t6.appendChild(t);
      });
    }
  });
})(window);
