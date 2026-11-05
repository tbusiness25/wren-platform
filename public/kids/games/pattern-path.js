/* pattern-path.js — Wren Kids (b507, 2026-10-18). EYFS · Mathematics · Numerical Patterns.
 *
 * WHY THIS GAME. "Spot and continue a pattern" is an ELG in its own right and the root of
 * algebraic thinking: the child has to find the unit of repeat, hold it, and apply it. Most
 * pattern apps only ever do AB. This one climbs AB → ABB → ABC → AABB → and then puts the gap in
 * the MIDDLE rather than at the end, which is much harder and much more revealing, because you
 * cannot get it by copying the last thing you saw.
 *
 * Colour is never the only difference: every element is a distinct SHAPE as well as a distinct
 * hue, so a colour-blind child plays exactly the same game.
 *
 * Levels: 1 AB, gap at the end · 2 ABB/AAB, gap at the end · 3 ABC, gap at the end ·
 *         4 AABB/ABB, gap in the middle · 5 ABCD or AABB, gap in the middle, longer run
 */
(function (W) {
  'use strict';
  var K = W.Kids, U = K.util;

  /* shape first, colour second — the shape alone identifies the element */
  var SHAPES = [
    { k: 'circle', label: 'circle', token: '--c-play-1' },
    { k: 'square', label: 'square', token: '--c-play-4' },
    { k: 'triangle', label: 'triangle', token: '--c-play-8' },
    { k: 'star', label: 'star', token: '--c-play-6' },
    { k: 'heart', label: 'heart', token: '--c-play-3' }
  ];

  function svgFor(s, size) {
    var px = size || 48;
    var fill = 'var(' + s.token + ')';
    var head = '<svg viewBox="0 0 48 48" width="' + px + '" height="' + px + '" aria-hidden="true">';
    var body = {
      circle: '<circle cx="24" cy="24" r="18" fill="' + fill + '"/>',
      square: '<rect x="7" y="7" width="34" height="34" rx="5" fill="' + fill + '"/>',
      triangle: '<path d="M24 5 L44 41 L4 41 Z" fill="' + fill + '"/>',
      star: '<path d="M24 4 L29.6 18.4 L45 19.4 L33.2 29.3 L37 44 L24 35.8 L11 44 L14.8 29.3 L3 19.4 L18.4 18.4 Z" fill="' + fill + '"/>',
      heart: '<path d="M24 42 C8 30 4 21 9 14 C13.5 8 21 9.5 24 15 C27 9.5 34.5 8 39 14 C44 21 40 30 24 42 Z" fill="' + fill + '"/>'
    }[s.k];
    return head + body + '</svg>';
  }

  var UNITS = {
    1: [[0, 1]],
    2: [[0, 1, 1], [0, 0, 1]],
    3: [[0, 1, 2]],
    4: [[0, 0, 1, 1], [0, 1, 1]],
    5: [[0, 1, 2, 3], [0, 0, 1, 1], [0, 1, 1, 2]]
  };

  K.game({
    slug: 'pattern-path',
    title: 'Pattern Path',
    short: 'Find the missing stepping stone.',
    emoji: '🔷',
    stage: 'eyfs',
    accent: '--c-play-3',
    levels: 5,
    roundLength: 10,
    howTo: 'Stepping stones go in a pattern. One is missing. Which shape goes in the gap?',
    curriculum: {
      framework: 'fledge',
      codes: ['MAT-B4-3', 'MAT-B5-3'],
      elgs: ['ELG12b'],
      plain: 'Copying, continuing and completing repeating patterns — AB, ABB, ABC and beyond (EYFS Mathematics: Numerical Patterns).',
      obs: 'Patterning is the root of algebraic thinking. Worth repeating with real things — a line of cups and spoons, claps and stamps, beads on a string — and asking the child to say the pattern out loud.'
    },

    turn: function (api) {
      var lvl = Math.min(5, api.level);
      var unit = U.pick(UNITS[lvl]);
      var kinds = U.shuffle(SHAPES).slice(0, Math.max.apply(null, unit) + 1);
      var reps = lvl <= 2 ? 3 : lvl === 3 ? 3 : lvl === 4 ? 3 : 3;
      var seq = [], r, i;
      for (r = 0; r < reps; r++) for (i = 0; i < unit.length; i++) seq.push(kinds[unit[i]]);
      /* one more element so the end of the run is never the unit boundary */
      seq.push(kinds[unit[0]]);

      /* where is the gap? end for levels 1-3, somewhere in the middle later */
      var gapAt = lvl <= 3 ? seq.length - 1
        : U.rint(unit.length, seq.length - 2);
      var answer = seq[gapAt];

      var path = U.el('div', 'k-path');
      path.setAttribute('role', 'img');
      path.setAttribute('aria-label', 'A pattern of shapes with one missing');
      seq.forEach(function (s, idx) {
        var step = U.el('div', 'k-step' + (idx === gapAt ? ' gap' : ''));
        if (idx === gapAt) step.innerHTML = '<span aria-hidden="true">?</span>';
        else step.innerHTML = svgFor(s, 44);
        path.appendChild(step);
      });
      api.el.appendChild(path);

      var tiles = U.el('div', 'k-tiles');
      api.el.appendChild(tiles);

      api.ask(gapAt === seq.length - 1 ? 'What comes next?' : 'Which shape is missing?');

      var wrongOnes = SHAPES.filter(function (s) { return s.k !== answer.k; });
      var choices = U.shuffle([answer].concat(U.shuffle(wrongOnes).slice(0, lvl <= 2 ? 2 : 3)));
      choices.forEach(function (s) {
        var t = api.tile('', function (node) {
          api.lock();
          tiles.querySelectorAll('.k-tile').forEach(function (b) { b.disabled = true; });
          var gap = path.querySelector('.k-step.gap');
          if (s.k === answer.k) {
            if (gap) { gap.classList.remove('gap'); gap.innerHTML = svgFor(answer, 44); }
            api.correct({ node: node });
          } else {
            var right = null;
            Array.prototype.forEach.call(tiles.querySelectorAll('.k-tile'), function (b) {
              if (b.dataset.shape === answer.k) right = b;
            });
            if (gap) { gap.classList.remove('gap'); gap.innerHTML = svgFor(answer, 44); }
            api.wrong({ node: node, reveal: right, hint: 'It was the ' + answer.label + '.' });
          }
        }, { cls: 'pic', html: svgFor(s, 76) + '<span class="k-tile-cap">' + s.label + '</span>', aria: s.label });
        t.dataset.shape = s.k;
        tiles.appendChild(t);
      });
    }
  });
})(window);
