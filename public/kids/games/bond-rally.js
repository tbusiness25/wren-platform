/* bond-rally.js — Wren Kids (b507, 2026-10-18). KS1 · Mathematics · Number: addition and subtraction.
 *
 * WHY THIS GAME. The national curriculum asks Year 1 to "represent and use number bonds and
 * related subtraction facts within 20" and Year 2 to "recall and use addition and subtraction
 * facts to 20 fluently". FLUENTLY is the word that matters: a child who works out 7 + 6 by
 * counting on their fingers every time has no working memory left for the actual problem. Bonds
 * have to become recall, and recall is built by RETRIEVAL PRACTICE — being asked, trying to
 * remember, and finding out — spaced over time, not by more worked examples.
 *
 * So this is deliberately a fluency game, and it does three things most fact-drill apps do not:
 *   1. It tracks the individual facts this child gets wrong or slow, and brings those back sooner
 *      (a simple Leitner-style queue, held only on the device).
 *   2. It shows the bond as a part-whole bar FIRST at level 1-2, so the fact has a picture behind
 *      it before it is asked for cold — concrete-pictorial-abstract, not abstract from the start.
 *   3. It never uses a countdown clock. Timing pressure is what makes fluency practice
 *      frightening for exactly the children who most need it; the game adapts by difficulty, not
 *      by stopwatch.
 *
 * Levels: 1 bonds to 10 with the bar · 2 bonds to 10, no bar · 3 bonds to 20 · 4 subtraction
 *         within 20 · 5 missing-number in any position (7 + ? = 15)
 */
(function (W) {
  'use strict';
  var K = W.Kids, U = K.util;

  /* facts this child found hard, kept on the device only, newest first */
  var HARD_KEY = 'hard';
  function hardList(slug) {
    var g = K.progress.forGame(slug);
    if (!Array.isArray(g[HARD_KEY])) g[HARD_KEY] = [];
    return g[HARD_KEY];
  }
  function markHard(slug, key) {
    var h = hardList(slug);
    var i = h.indexOf(key);
    if (i >= 0) h.splice(i, 1);
    h.unshift(key);
    if (h.length > 24) h.length = 24;
  }
  function clearHard(slug, key) {
    var h = hardList(slug), i = h.indexOf(key);
    if (i >= 0) h.splice(i, 1);
  }

  function bar(whole, part, api) {
    var b = U.el('div', 'k-fracbar');
    b.setAttribute('role', 'img');
    b.setAttribute('aria-label', part + ' of ' + whole);
    for (var i = 0; i < whole; i++) {
      var seg = U.el('i');
      if (i < part) seg.className = 'on';
      b.appendChild(seg);
    }
    return b;
  }

  function makeFact(lvl) {
    var a, b, total, missing;
    if (lvl <= 2) { total = 10; a = U.rint(1, 9); b = total - a; return { kind: 'add', a: a, b: b, ans: total, show: total }; }
    if (lvl === 3) { total = U.rint(11, 20); a = U.rint(2, total - 2); b = total - a; return { kind: 'add', a: a, b: b, ans: total, show: total }; }
    if (lvl === 4) { total = U.rint(11, 20); a = U.rint(2, total - 2); return { kind: 'sub', a: total, b: a, ans: total - a, show: total }; }
    total = U.rint(11, 20); a = U.rint(2, total - 2);
    return { kind: 'missing', a: a, b: total - a, ans: total - a, show: total };
  }
  function factKey(f) {
    return f.kind + ':' + f.a + ':' + f.b;
  }
  function factFromKey(k) {
    var p = k.split(':');
    var f = { kind: p[0], a: +p[1], b: +p[2] };
    f.ans = f.kind === 'add' ? f.a + f.b : f.kind === 'sub' ? f.a - f.b : f.b;
    f.show = f.kind === 'add' ? f.a + f.b : f.a;
    return f;
  }

  K.game({
    slug: 'bond-rally',
    title: 'Bond Rally',
    short: 'Number bonds and facts to 20, until they are automatic.',
    emoji: '🎈',
    stage: 'ks1',
    accent: '--c-play-5',
    levels: 5,
    roundLength: 12,
    howTo: 'Quick number facts. The ones you find hard come back round again — that is how they stick. There is no clock, so take the time you need.',
    curriculum: {
      framework: null,
      codes: ['Y1-N-AS-1', 'Y2-N-AS-1'],
      nc: 'KS1 Mathematics — Year 1: represent and use number bonds and related subtraction facts within 20. Year 2: recall and use addition and subtraction facts to 20 fluently, and derive and use related facts up to 100.',
      plain: 'Number bonds and addition/subtraction facts to 20, practised for recall (National Curriculum KS1 Mathematics: Number — addition and subtraction).',
      obs: 'Fluent recall of bonds to 20 frees up working memory for everything else in maths. Worth a minute a day out loud rather than a long session once a week.'
    },

    turn: function (api) {
      var lvl = Math.min(5, api.level);
      /* a third of turns bring back a fact this child got wrong before (spaced retrieval) */
      var hard = hardList(api.slug);
      var f = (hard.length && Math.random() < 0.34) ? factFromKey(U.pick(hard.slice(0, 8))) : makeFact(lvl);
      var key = factKey(f);

      var focus = U.el('div', 'k-focus-card');
      var eq = U.el('span', 'k-sum-eq');
      if (f.kind === 'add') eq.textContent = f.a + ' + ' + f.b + ' =';
      else if (f.kind === 'sub') eq.textContent = f.a + ' − ' + f.b + ' =';
      else eq.textContent = f.a + ' + ? = ' + (f.a + f.b);
      focus.appendChild(eq);
      var box = U.el('div', 'k-answer-box', '?');
      focus.appendChild(box);
      api.el.appendChild(focus);

      if (lvl === 1) {
        var picture = U.el('div');
        picture.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px';
        picture.appendChild(bar(f.a + f.b, f.a, api));
        var cap = U.el('span', 'k-tile-cap', f.a + ' and ' + f.b);
        cap.style.color = 'var(--c-muted)';
        picture.appendChild(cap);
        api.el.appendChild(picture);
      }

      var tiles = U.el('div', 'k-tiles');
      api.el.appendChild(tiles);

      api.ask(f.kind === 'sub' ? 'What is ' + f.a + ' take away ' + f.b + '?'
            : f.kind === 'missing' ? f.a + ' add what makes ' + (f.a + f.b) + '?'
            : 'What is ' + f.a + ' add ' + f.b + '?');

      var options = U.shuffle([f.ans].concat(U.near(f.ans, 3, 0, 20)));
      options.forEach(function (v) {
        var t = api.tile(String(v), function (node) {
          api.lock();
          Array.prototype.forEach.call(tiles.querySelectorAll('.k-tile'), function (b) { b.disabled = true; });
          box.textContent = String(v);
          if (v === f.ans) {
            clearHard(api.slug, key);
            api.correct({ node: node });
          } else {
            markHard(api.slug, key);
            box.textContent = String(f.ans);
            var right = null;
            Array.prototype.forEach.call(tiles.querySelectorAll('.k-tile'), function (b) {
              if (b.textContent === String(f.ans)) right = b;
            });
            api.wrong({
              node: node, reveal: right,
              hint: (f.kind === 'sub' ? f.a + ' take away ' + f.b : f.a + ' and ' + f.b) + ' is ' + f.ans + '.'
            });
          }
        }, { cls: 'big', aria: String(v) });
        tiles.appendChild(t);
      });
    }
  });
})(window);
