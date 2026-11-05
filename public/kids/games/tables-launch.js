/* tables-launch.js — Wren Kids (b507, 2026-10-18). KS2 · Mathematics · multiplication and division.
 *
 * WHY THIS GAME. The national curriculum requires that by the end of Year 4 a child can "recall
 * multiplication and division facts for multiplication tables up to 12 x 12", and the statutory
 * Multiplication Tables Check tests exactly that — 25 questions, a fixed few seconds each, with
 * the harder tables weighted far more heavily than the 2s, 5s and 10s.
 *
 * Most tables apps drill 1x1 to 12x12 uniformly. That wastes most of a child's practice on facts
 * they already know. This one does three things instead:
 *   1. It weights the question pool the way the official check does (6, 7, 8, 9 and 12 heavily;
 *      2, 5 and 10 lightly), so practice lands where the gap is.
 *   2. It keeps a per-fact record on the device — wrong or slow facts come back sooner, correct
 *      ones drop out of rotation for longer. That is spaced retrieval, and it is what actually
 *      moves a fact into recall.
 *   3. "Check mode" at level 5 runs the real MTC shape (6 seconds a question, typed on a keypad,
 *      no multiple choice) so the format itself is familiar before it matters. Levels 1 to 4 have
 *      NO timer at all — the timer is a format to rehearse, not a way to make a nine-year-old
 *      anxious every single evening.
 *
 * Levels: 1 the 2, 5 and 10 times tables · 2 adds 3, 4 and 8 · 3 adds 6, 7, 9, 11, 12 ·
 *         4 division facts (42 ÷ 6) · 5 Check mode: the real MTC format, keypad, 6 seconds
 */
(function (W) {
  'use strict';
  var K = W.Kids, U = K.util;

  /* the MTC's own weighting: the 6s, 7s, 8s, 9s and 12s dominate; the 2s, 5s and 10s barely
   * appear, and 1, 10 and 11 are deliberately light. */
  var MTC_WEIGHT = { 2: 1, 3: 2, 4: 3, 5: 1, 6: 5, 7: 5, 8: 5, 9: 5, 11: 2, 12: 5, 10: 1, 1: 0 };

  function weightedTable(allowed) {
    var bag = [], t;
    for (var i = 0; i < allowed.length; i++) {
      t = allowed[i];
      var n = MTC_WEIGHT[t] == null ? 2 : MTC_WEIGHT[t];
      for (var j = 0; j < n; j++) bag.push(t);
    }
    return bag.length ? U.pick(bag) : U.pick(allowed);
  }

  var TABLES = {
    1: [2, 5, 10],
    2: [2, 3, 4, 5, 8, 10],
    3: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    4: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    5: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  };

  function hard(slug) {
    var g = K.progress.forGame(slug);
    if (!Array.isArray(g.hardFacts)) g.hardFacts = [];
    return g.hardFacts;
  }
  function mark(slug, k, wrong) {
    var h = hard(slug), i = h.indexOf(k);
    if (wrong) { if (i >= 0) h.splice(i, 1); h.unshift(k); if (h.length > 30) h.length = 30; }
    else if (i >= 0) h.splice(i, 1);
  }

  function keypad(api, onDigit, onClear, onEnter) {
    var pad = U.el('div', 'k-pad');
    [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(function (d) {
      pad.appendChild(api.tile(String(d), function () { onDigit(d); }, { aria: String(d) }));
    });
    pad.appendChild(api.tile('←', function () { onClear(); }, { aria: 'Delete' }));
    pad.appendChild(api.tile('0', function () { onDigit(0); }, { aria: 'Zero' }));
    var go = api.tile('✓', function () { onEnter(); }, { aria: 'Enter' });
    pad.appendChild(go);
    return pad;
  }

  K.game({
    slug: 'tables-launch',
    title: 'Tables Launch',
    short: 'Times tables to 12 × 12, weighted the way the Year 4 check is.',
    emoji: '🚀',
    stage: 'ks2',
    accent: '--c-play-7',
    levels: 5,
    roundLength: 12,
    howTo: 'Times tables, with the tricky ones coming round more often. Levels 1 to 4 have no timer. Level 5 is Check mode: six seconds a question, just like the real Year 4 check.',
    curriculum: {
      framework: null,
      codes: ['Y2-N-MD-1', 'Y3-N-MD-1', 'Y4-N-MD-1'],
      nc: 'KS2 Mathematics — Year 4: recall multiplication and division facts for multiplication tables up to 12 x 12. Year 2: the 2, 5 and 10 tables. Year 3: the 3, 4 and 8 tables. Rehearses the statutory Multiplication Tables Check format.',
      plain: 'Multiplication and division facts to 12 × 12, weighted like the statutory Year 4 Multiplication Tables Check (National Curriculum KS2 Mathematics).',
      obs: 'Tables become recall through short, frequent, spaced practice, not long sessions. Level 5 rehearses the real check format (6 seconds a question) so the format is not the thing that catches them out.'
    },

    turn: function (api) {
      var lvl = Math.min(5, api.level);
      var allowed = TABLES[lvl];
      var h = hard(api.slug);
      var a, b, key;

      if (h.length && Math.random() < 0.35) {
        key = U.pick(h.slice(0, 10));
        a = +key.split('x')[0]; b = +key.split('x')[1];
      } else {
        a = weightedTable(allowed);
        b = U.rint(2, 12);
        key = a + 'x' + b;
      }
      var product = a * b;
      var division = lvl === 4;
      var answer = division ? b : product;

      var focus = U.el('div', 'k-focus-card');
      var eq = U.el('span', 'k-sum-eq', division ? (product + ' ÷ ' + a + ' =') : (a + ' × ' + b + ' ='));
      focus.appendChild(eq);
      var box = U.el('div', 'k-answer-box', '?');
      focus.appendChild(box);
      api.el.appendChild(focus);

      api.ask(division ? ('What is ' + product + ' divided by ' + a + '?') : ('What is ' + a + ' times ' + b + '?'));

      function finish(given, node, timedOut) {
        api.lock();
        box.textContent = timedOut ? String(answer) : String(given);
        if (!timedOut && given === answer) {
          mark(api.slug, key, false);
          api.correct({ node: node });
        } else {
          mark(api.slug, key, true);
          box.textContent = String(answer);
          api.wrong({
            node: node,
            hint: timedOut ? 'Time is up — ' + (division ? product + ' ÷ ' + a : a + ' × ' + b) + ' is ' + answer + '.'
                           : (division ? product + ' ÷ ' + a : a + ' × ' + b) + ' is ' + answer + '.'
          });
        }
      }

      if (lvl === 5) {
        /* Check mode: typed, six seconds — the official MTC format */
        var typed = '';
        var timer = U.el('div', 'k-bar');
        timer.style.width = '200px';
        var fill = U.el('i');
        fill.style.width = '100%';
        fill.style.transition = 'width 6s linear';
        fill.style.background = 'var(--c-accent)';
        timer.appendChild(fill);
        api.el.appendChild(timer);

        var pad = keypad(api,
          function (d) { if (typed.length < 3) { typed += d; box.textContent = typed; api.sfx('tick'); } },
          function () { typed = typed.slice(0, -1); box.textContent = typed || '?'; api.sfx('tick'); },
          function () { if (!typed) return; clearTimeout(to); finish(parseInt(typed, 10), null, false); });
        api.el.appendChild(pad);

        setTimeout(function () { fill.style.width = '0%'; }, 30);
        var to = setTimeout(function () { finish(null, null, true); }, 6000);
        return;
      }

      var tiles = U.el('div', 'k-tiles');
      api.el.appendChild(tiles);
      var options = U.shuffle([answer].concat(division
        ? U.near(answer, 3, 1, 12)
        : [answer + a, answer - a, a * (b + 1) + U.rint(1, 2)].filter(function (v, i, arr) {
            return v > 0 && v !== answer && arr.indexOf(v) === i;
          }).slice(0, 3)));
      while (options.length < 4) { var f = answer + U.rint(1, 9); if (options.indexOf(f) < 0) options.push(f); }
      options = U.shuffle(options);

      options.forEach(function (v) {
        var t = api.tile(String(v), function (node) {
          Array.prototype.forEach.call(tiles.querySelectorAll('.k-tile'), function (b2) { b2.disabled = true; });
          finish(v, node, false);
        }, { cls: 'big', aria: String(v) });
        tiles.appendChild(t);
      });
    }
  });
})(window);
