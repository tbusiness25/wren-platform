/* subitise-snap.js — Wren Kids (b507, 2026-10-18). EYFS · Mathematics · Number.
 *
 * WHY THIS GAME. Subitising — knowing "that's three" without counting — is the single biggest
 * predictor of early number fluency, and it is the one thing a screen can practise better than a
 * table of counters, because it needs the dots to appear and DISAPPEAR. A child who has to count
 * has not subitised, so the plate is shown for well under a second and then covered. That is the
 * whole mechanic, and it is the opposite of a counting worksheet.
 *
 * It uses the arrangements children actually meet — dice faces, ten-frames, dominoes, then random
 * scatters — so what they practise here transfers to the dice, the Numicon and the fingers in the
 * room (concrete-pictorial-abstract: this is the pictorial step, and it names the abstract).
 *
 * Levels: 1 dice/domino to 3 · 2 dice/domino to 5 · 3 ten-frame to 6 · 4 scatter to 6 ·
 *         5 scatter to 10 (two groups, so "4 and 2 is 6" is visible)
 */
(function (W) {
  'use strict';
  var K = W.Kids, U = K.util;

  /* dot arrangements, in the layouts a child meets in the real world. Coordinates are percentages
   * of the plate, so everything scales with the tablet. */
  var DICE = {
    1: [[50, 50]],
    2: [[28, 28], [72, 72]],
    3: [[26, 26], [50, 50], [74, 74]],
    4: [[28, 28], [72, 28], [28, 72], [72, 72]],
    5: [[26, 26], [74, 26], [50, 50], [26, 74], [74, 74]],
    6: [[28, 22], [28, 50], [28, 78], [72, 22], [72, 50], [72, 78]]
  };
  function tenFrame(n) {
    var pts = [], i;
    for (i = 0; i < n; i++) {
      var col = i % 5, row = i < 5 ? 0 : 1;
      pts.push([16 + col * 17, 36 + row * 28]);
    }
    return pts;
  }
  function scatter(n) {
    var pts = [], guard = 0;
    while (pts.length < n && guard++ < 400) {
      var p = [U.rint(18, 82), U.rint(18, 82)], ok = true;
      for (var i = 0; i < pts.length; i++) {
        var dx = pts[i][0] - p[0], dy = pts[i][1] - p[1];
        if (dx * dx + dy * dy < 460) { ok = false; break; }
      }
      if (ok) pts.push(p);
    }
    return pts;
  }
  /* two clearly separated groups, so 6 reads as "4 and 2" — the composition idea behind ELG11a */
  function twoGroups(n) {
    var a = U.rint(Math.max(1, n - 5), Math.min(5, n - 1)), b = n - a, pts = [], i;
    for (i = 0; i < a; i++) pts.push([20 + (i % 3) * 14, 30 + Math.floor(i / 3) * 22]);
    for (i = 0; i < b; i++) pts.push([62 + (i % 3) * 14, 30 + Math.floor(i / 3) * 22]);
    return pts;
  }

  var LEVELS = [
    { max: 3, how: 'dice',  show: 1100 },
    { max: 5, how: 'dice',  show: 950 },
    { max: 6, how: 'frame', show: 850 },
    { max: 6, how: 'free',  show: 700 },
    { max: 10, how: 'group', show: 850 }
  ];

  K.game({
    slug: 'subitise-snap',
    title: 'Snap Count',
    short: 'See how many without counting.',
    emoji: '🎲',
    stage: 'eyfs',
    accent: '--c-play-1',
    levels: 5,
    roundLength: 10,
    howTo: 'Spots flash up and then hide. Do not count them — just look, and say how many.',
    curriculum: {
      framework: 'fledge',
      codes: ['MAT-B4-2', 'MAT-B5-2'],
      elgs: ['ELG11b', 'ELG11a'],
      plain: 'Subitising — recognising how many without counting — to 5, then to 10 in two groups (EYFS Mathematics: Number).',
      obs: 'Subitising is the ELG "subitise (recognise quantities without counting) up to 5", so this is worth watching for in the room too — at snack, with dice, on fingers.'
    },

    turn: function (api) {
      var L = LEVELS[Math.min(LEVELS.length, api.level) - 1];
      var n = U.rint(1, L.max);
      var pts = L.how === 'dice' ? (DICE[n] || scatter(n))
              : L.how === 'frame' ? tenFrame(n)
              : L.how === 'group' ? twoGroups(n)
              : scatter(n);

      var plate = U.el('div', 'k-plate flash');
      plate.setAttribute('role', 'img');
      plate.setAttribute('aria-label', n + ' spots');
      if (L.how === 'frame') {
        /* draw the ten-frame itself — the frame is half the point */
        var f = U.el('div');
        f.style.cssText = 'position:absolute;left:8%;top:28%;width:84%;height:44%;' +
          'border:3px solid var(--c-border-strong);border-radius:8px;display:grid;' +
          'grid-template-columns:repeat(5,1fr);grid-template-rows:repeat(2,1fr)';
        for (var c = 0; c < 10; c++) {
          var cell = U.el('i');
          cell.style.cssText = 'border-right:2px solid var(--c-border);border-bottom:2px solid var(--c-border)';
          f.appendChild(cell);
        }
        plate.appendChild(f);
      }
      pts.forEach(function (p, i) {
        var d = U.el('span', 'k-spot');
        var size = L.how === 'frame' ? 13 : 15;
        d.style.left = (p[0] - size / 2) + '%';
        d.style.top = (p[1] - size / 2) + '%';
        d.style.width = size + '%';
        d.style.height = size + '%';
        d.style.animation = 'k-pop .3s ease both';
        d.style.animationDelay = (i * 0.012) + 's';
        plate.appendChild(d);
      });

      var focus = U.el('div', 'k-focus');
      focus.appendChild(plate);
      api.el.appendChild(focus);

      var tiles = U.el('div', 'k-tiles');
      api.el.appendChild(tiles);

      api.ask('Look!');
      api.sfx('listen');
      api.lock();

      /* flash, then cover and ask */
      setTimeout(function () {
        plate.classList.add('hidden-plate');
        var q = U.el('div', 'k-plate-q', '?');
        plate.appendChild(q);
        plate.setAttribute('aria-label', 'Hidden');
        api.sfx('whoosh');
        api.ask('How many spots?');

        var options = U.shuffle([n].concat(U.near(n, L.max <= 3 ? 2 : 3, 1, Math.max(6, L.max))));
        options.forEach(function (v) {
          var t = api.tile(String(v), function (node) {
            api.lock();
            tiles.querySelectorAll('.k-tile').forEach(function (b) { b.disabled = true; });
            if (v === n) {
              plate.classList.remove('hidden-plate');
              if (q.parentNode) q.parentNode.removeChild(q);
              api.correct({ node: node });
            } else {
              plate.classList.remove('hidden-plate');
              if (q.parentNode) q.parentNode.removeChild(q);
              var right = null;
              tiles.querySelectorAll('.k-tile').forEach(function (b) { if (b.textContent === String(n)) right = b; });
              api.wrong({ node: node, reveal: right, hint: 'There were ' + n + '. Look again.' });
            }
          }, { cls: 'big', aria: String(v) });
          tiles.appendChild(t);
        });
        api.unlock();
      }, L.show);
    }
  });
})(window);
