/* ten-town-train.js — Wren Kids (b507, 2026-10-18). EYFS · Mathematics · Number.
 *
 * WHY THIS GAME. The Reception ELG is "a deep understanding of numbers to 10, including the
 * composition of each number" — i.e. knowing that 7 is 5 and 2, and 6 and 1, and 4 and 3. That is
 * a different thing from counting, and it is the thing children arrive at school without.
 *
 * So the train shows a number of carriages, some already full, and asks how many more are needed
 * to fill the train. The answer is always visible as a picture before it is a number: the child
 * can SEE the empty carriages, count them if they must, and only then choose the numeral. That is
 * concrete-pictorial-abstract in one screen, and it is the same "how many more to make ten?" that
 * becomes number bonds in Year 1.
 *
 * Levels: 1 make 5 · 2 make 10 (with ten-frame spacing) · 3 make 10, bigger gaps ·
 *         4 make any number to 10 · 5 "how many were there before?" (the inverse)
 */
(function (W) {
  'use strict';
  var K = W.Kids, U = K.util;

  function train(total, full, api) {
    var row = U.el('div', 'k-train');
    var eng = U.el('span', 'k-engine', '🚂');
    eng.setAttribute('aria-hidden', 'true');
    row.appendChild(eng);
    for (var i = 0; i < total; i++) {
      var c = U.el('div', 'k-carriage' + (i < full ? ' full' : ''));
      c.setAttribute('aria-hidden', 'true');
      if (i === 5) c.style.marginLeft = '14px';     /* the five-and-a-bit break of a ten frame */
      row.appendChild(c);
    }
    row.setAttribute('role', 'img');
    row.setAttribute('aria-label', full + ' of ' + total + ' carriages are full');
    return row;
  }

  K.game({
    slug: 'ten-town-train',
    title: 'Ten Town Train',
    short: 'How many more to fill the train?',
    emoji: '🚂',
    stage: 'eyfs',
    accent: '--c-play-2',
    levels: 5,
    roundLength: 10,
    howTo: 'Some carriages are full and some are empty. How many more do we need to fill the train?',
    curriculum: {
      framework: 'fledge',
      codes: ['MAT-B4-1', 'MAT-B5-2', 'MAT-B5-4'],
      elgs: ['ELG11a', 'ELG11c'],
      plain: 'The composition of numbers to 10 — "how many more to make ten?" (EYFS Mathematics: Number; the start of number bonds in Year 1).',
      obs: 'This is the ELG "a deep understanding of number to 10, including the composition of each number". Worth asking the same question with real objects: five cups out, how many more for everyone?'
    },

    turn: function (api) {
      var lvl = api.level;
      var total = lvl === 1 ? 5 : lvl <= 3 ? 10 : U.rint(5, 10);
      var missing = U.rint(1, Math.min(total - 1, lvl <= 2 ? 4 : total - 1));
      var full = total - missing;
      var inverse = lvl >= 5 && Math.random() < 0.5;

      var focus = U.el('div', 'k-focus-card');
      focus.appendChild(train(total, inverse ? full : full, api));
      api.el.appendChild(focus);

      var answer, question;
      if (inverse) {
        /* the inverse: the train is full, how many were there to start with? */
        question = 'The train holds ' + total + '. ' + missing + ' more carriages were filled. How many were full before?';
        answer = full;
      } else {
        question = 'How many more carriages to fill the train?';
        answer = missing;
      }

      var tiles = U.el('div', 'k-tiles');
      api.el.appendChild(tiles);

      api.ask(question);

      var options = U.shuffle([answer].concat(U.near(answer, 3, 0, total)));
      options.forEach(function (v) {
        var t = api.tile(String(v), function (node) {
          api.lock();
          tiles.querySelectorAll('.k-tile').forEach(function (b) { b.disabled = true; });
          if (v === answer) {
            /* fill the train in front of them — the reward IS the maths */
            var empties = focus.querySelectorAll('.k-carriage:not(.full)');
            Array.prototype.forEach.call(empties, function (c, i) {
              setTimeout(function () { c.classList.add('full'); api.sfx('pop'); }, i * 110);
            });
            api.correct({ node: node });
          } else {
            var right = null;
            tiles.querySelectorAll('.k-tile').forEach(function (b) { if (b.textContent === String(answer)) right = b; });
            api.wrong({
              node: node, reveal: right,
              hint: inverse ? 'It was ' + answer + ' before.' : 'Count the empty ones: ' + answer + '.'
            });
          }
        }, { cls: 'big', aria: String(v) });
        tiles.appendChild(t);
      });
    }
  });
})(window);
