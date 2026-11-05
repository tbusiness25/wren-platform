/* rhyme-time.js — Wren Kids (b507, 2026-10-18). EYFS · Literacy / Communication and Language.
 *
 * WHY THIS GAME, AND WHY IT IS NOT A PHONICS GAME. Wren already has a complete phonics programme
 * and its own app (phonics.getwren.co.uk) — this does not duplicate a single thing in it, and the
 * hub links straight there when a child is ready for graphemes. What this game does is the step
 * BEFORE phonics: phonological awareness. Hearing that "cat" and "hat" end the same, and that
 * "sun" and "sock" start the same, is oral, it needs no letters at all, and it is the strongest
 * early predictor of how smoothly systematic synthetic phonics will go later.
 *
 * So: no letters are shown at level 1-3. The child hears a word, sees pictures, and chooses. The
 * picture IS the content (a pre-reader cannot read the label), which is why this is the one game
 * that genuinely needs illustrations rather than shapes — they come from Wren's own reviewed
 * clipart library.
 *
 * Levels: 1 rhyme, 2 pictures · 2 rhyme, 3 pictures · 3 odd-one-out of 3 ·
 *         4 initial sound (alliteration), 3 pictures · 5 odd-one-out of 4, mixed rhyme/initial
 */
(function (W) {
  'use strict';
  var K = W.Kids, U = K.util;

  /* how to say a word aloud when it is read out — the rest are said as written */
  var SAY = { dish: 'dish', jet: 'jet', wig: 'wig', mat: 'mat' };
  function speakable(w) { return SAY[w] || w; }
  function firstSound(w) {
    /* the SOUND the word starts with, not the letter — "shell" starts with /sh/, "frog" with /f/ */
    if (/^(sh|ch|th)/.test(w)) return w.slice(0, 2);
    return w[0];
  }

  function picTile(api, word, onPick) {
    var holder = document.createElement('span');
    holder.appendChild(K.art.img(word, word));
    var t = api.tile('', onPick, {
      cls: 'pic',
      html: '',
      aria: word
    });
    t.appendChild(holder.firstChild);
    var cap = U.el('span', 'k-tile-cap', word);
    t.appendChild(cap);
    t.dataset.word = word;
    return t;
  }

  K.game({
    slug: 'rhyme-time',
    title: 'Rhyme Time',
    short: 'Which words sound the same?',
    emoji: '🎵',
    stage: 'eyfs',
    accent: '--c-play-4',
    levels: 5,
    roundLength: 10,
    howTo: 'Listen to the word. Then tap the picture that rhymes with it — the one that sounds the same at the end.',
    curriculum: {
      framework: 'fledge',
      codes: ['LIT-B3-4', 'LIT-B4-2', 'CL-B4-4'],
      elgs: ['ELG08c'],
      plain: 'Hearing rhyme and initial sounds — the oral listening skills that come BEFORE phonics (EYFS Literacy: Word Reading; Communication and Language).',
      obs: 'This is phonological awareness, not phonics: it is all oral. Worth doing away from the screen too — silly rhyming pairs at nappy time, "I spy" with sounds not letters, and the setting\'s rhyme-a-week.'
    },

    start: function () { K.art.ready(); },

    turn: function (api) {
      var fams = K.art.families();
      var keys = Object.keys(fams).filter(function (k) { return fams[k].length >= 2; });
      if (!keys.length) {
        /* no pictures published: say so rather than show a broken screen */
        api.ask('The pictures are still loading. Try again in a moment.');
        setTimeout(function () { api.wrong({ silent: true }); }, 900);
        return;
      }
      var lvl = Math.min(5, api.level);
      var mode = lvl === 4 ? 'initial' : (lvl === 5 && Math.random() < 0.4) ? 'initial' : 'rhyme';
      var oddOneOut = lvl === 3 || lvl === 5;
      var choices = lvl === 1 ? 2 : lvl === 2 ? 3 : lvl === 3 ? 3 : lvl === 4 ? 3 : 4;

      var fam = U.pick(keys);
      var pair = U.shuffle(fams[fam]);
      var cue = pair[0], answer = pair[1];

      /* distractors: words from OTHER families, so they neither rhyme nor (usually) alliterate */
      var pool = [];
      keys.forEach(function (k) { if (k !== fam) pool = pool.concat(fams[k]); });

      if (mode === 'initial') {
        /* find a word that STARTS with the same sound as the cue but does not rhyme with it */
        var fs = firstSound(cue);
        var sameStart = pool.filter(function (w) { return firstSound(w) === fs; });
        if (!sameStart.length) { mode = 'rhyme'; }
        else { answer = U.pick(sameStart); }
      }

      var wrongs = U.shuffle(pool.filter(function (w) {
        if (w === answer || w === cue) return false;
        if (mode === 'rhyme') return fams[fam].indexOf(w) === -1;
        return firstSound(w) !== firstSound(cue);
      })).slice(0, choices - 1);
      if (wrongs.length < choices - 1) return api.wrong({ silent: true });

      /* the cue */
      var focus = U.el('div', 'k-focus');
      var cuePic = U.el('div', 'k-focus-card');
      var ci = K.art.img(cue, cue);
      ci.className = 'k-focus-pic';
      cuePic.appendChild(ci);
      var cw = U.el('span', 'k-rhyme-word', cue);
      if (lvl >= 4) cuePic.appendChild(cw);      /* the written word only once they are readier */
      focus.appendChild(cuePic);
      api.el.appendChild(focus);

      var tiles = U.el('div', 'k-tiles cols-' + Math.min(3, choices));
      api.el.appendChild(tiles);

      var question = oddOneOut
        ? (mode === 'rhyme'
            ? 'Which one does NOT rhyme with ' + speakable(cue) + '?'
            : 'Which one does NOT start like ' + speakable(cue) + '?')
        : (mode === 'rhyme'
            ? 'Which one rhymes with ' + speakable(cue) + '?'
            : 'Which one starts with the same sound as ' + speakable(cue) + '?');

      var correctWord = answer;
      var options;
      if (oddOneOut) {
        /* three that belong, one that does not — the odd one is the answer */
        var belong = mode === 'rhyme'
          ? U.shuffle(fams[fam]).slice(0, choices - 1)
          : U.shuffle(pool.filter(function (w) { return firstSound(w) === firstSound(cue); })).slice(0, choices - 1);
        if (belong.length < choices - 1) { oddOneOut = false; }
        else {
          correctWord = wrongs[0];
          options = U.shuffle(belong.concat([correctWord]));
        }
      }
      if (!options) options = U.shuffle([answer].concat(wrongs));

      api.ask(question);
      setTimeout(function () { api.say(speakable(cue) + '.', { rate: 0.8 }); }, 1400);

      options.forEach(function (w) {
        var t = picTile(api, w, function (node) {
          api.lock();
          Array.prototype.forEach.call(tiles.querySelectorAll('.k-tile'), function (b) { b.disabled = true; });
          api.say(speakable(w), { rate: 0.85 });
          if (w === correctWord) {
            api.correct({ node: node });
          } else {
            var right = null;
            Array.prototype.forEach.call(tiles.querySelectorAll('.k-tile'), function (b) {
              if (b.dataset.word === correctWord) right = b;
            });
            api.wrong({
              node: node, reveal: right,
              hint: mode === 'rhyme'
                ? speakable(cue) + ' … ' + speakable(correctWord) + '. They sound the same at the end.'
                : speakable(cue) + ' … ' + speakable(correctWord) + '. They start the same.'
            });
          }
        });
        tiles.appendChild(t);
      });
    }
  });
})(window);
