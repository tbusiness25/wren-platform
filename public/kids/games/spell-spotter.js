/* spell-spotter.js — Wren Kids (b507, 2026-10-18). KS1 · English · spelling (the NC Appendix 1 work).
 *
 * WHY THIS GAME. By the end of Year 2 a child is expected to spell the statutory common exception
 * words and apply a named set of spelling rules (-tch, -dge, adding -ing/-ed with doubling or
 * dropping the e, -le/-el/-al endings, plurals with -s and -es, contractions). These are the words
 * that cannot be sounded out and the rules that have to be known. They are, bluntly, learned by
 * being met again and again.
 *
 * The mechanic is recognition-then-production-adjacent: the child reads a real sentence with the
 * word missing, hears it read aloud, and picks the correct spelling from near-misses that are the
 * errors children actually make (writen / writting, catch / cach, becuase / because). Every
 * distractor below is hand-written for that reason — a randomly mangled word teaches nothing,
 * because no child would ever have written it.
 *
 * Every item also carries a one-line RULE, shown after a wrong answer. Being told "catch needs
 * -tch after a short vowel" is the part that transfers; being told "wrong" is not.
 *
 * Levels: 1 Year 1 common exception words · 2 Year 2 common exception words ·
 *         3 -tch / -dge / -ck after a short vowel · 4 adding -ing and -ed (doubling, drop the e) ·
 *         5 plurals, -le/-el endings and contractions
 */
(function (W) {
  'use strict';
  var K = W.Kids, U = K.util;

  /* [correct, [wrong, ...], sentence with ___ , rule] */
  var BANK = {
    1: [
      ['said', ['sed', 'sayed'], 'Mum ___ it was time for tea.', '"said" is a word we just have to know — it is not spelled the way it sounds.'],
      ['they', ['thay', 'thei'], '___ are playing outside.', '"they" uses -ey, like "grey".'],
      ['was', ['woz', 'wos'], 'It ___ a sunny day.', '"was" is spelled with an a, even though it sounds like an o.'],
      ['there', ['thier', 'thare'], 'Put it over ___.', '"there" means a place — it has "here" inside it.'],
      ['friend', ['frend', 'freind'], 'My best ___ came round.', '"friend" has an i you cannot hear: fri-end.'],
      ['because', ['becuase', 'becos'], 'I am tired ___ it is late.', '"because" — big elephants can always understand small elephants.'],
      ['school', ['scool', 'skool'], 'We walk to ___.', '"school" has a silent h after the c.'],
      ['once', ['wonce', 'wunce'], '___ upon a time.', '"once" starts with o but sounds like w.'],
      ['people', ['peeple', 'peopel'], 'Lots of ___ came.', '"people" ends -ple, like "apple".'],
      ['house', ['howse', 'hous'], 'We live in that ___.', '"house" uses ou for the /ow/ sound.'],
      ['come', ['cum', 'coam'], 'Please ___ here.', '"come" has a magic e that does not make the o long.'],
      ['one', ['won', 'wun'], 'I only have ___ left.', 'The number "one" starts with o, even though it sounds like w.']
    ],
    2: [
      ['beautiful', ['butiful', 'beatiful'], 'What a ___ day.', '"beautiful" starts b-e-a-u — "be-a-you-tiful".'],
      ['children', ['childen', 'childern'], 'The ___ are in the hall.', '"children" is "child" with -ren on the end: child-ren.'],
      ['climb', ['clime', 'climm'], 'I can ___ the tree.', '"climb" has a silent b at the end, like "thumb" and "lamb".'],
      ['could', ['cud', 'coud'], 'I ___ not find it.', 'could, should, would — all end -ould.'],
      ['every', ['evry', 'everey'], 'I go ___ day.', '"every" has three syllables hiding in it: ev-er-y.'],
      ['great', ['grate', 'graet'], 'That was a ___ idea.', '"great" uses ea for the /ay/ sound, like "break" and "steak".'],
      ['money', ['munny', 'monney'], 'I saved my ___.', '"money" ends -ey, like "donkey" and "honey".'],
      ['water', ['watter', 'wota'], 'Can I have some ___?', '"water" has one t, and the a says /or/.'],
      ['busy', ['bizzy', 'buzy'], 'Mum is very ___.', '"busy" is spelled with a u but says /i/.'],
      ['again', ['agen', 'agian'], 'Can we play ___?', '"again" ends -ain, like "rain" and "plain".'],
      ['whole', ['hole', 'wole'], 'I ate the ___ apple.', '"whole" means all of it — a "hole" is a gap. This one has a w.'],
      ['pretty', ['prety', 'pritty'], 'That is a ___ picture.', '"pretty" has a double t, and the e says /i/.']
    ],
    3: [
      ['catch', ['cach', 'catsh'], 'Can you ___ the ball?', 'After a short vowel sound, /ch/ is spelled -tch: catch, fetch, kitchen.'],
      ['rich', ['ritch', 'rish'], 'The king was very ___.', 'But NOT after a consonant — rich, much, such and which have no t.'],
      ['bridge', ['brige', 'bridg'], 'We walked over the ___.', 'After a short vowel, /j/ at the end is -dge: bridge, badge, fudge.'],
      ['large', ['larj', 'lardge'], 'That is a ___ dog.', 'After a long sound or another consonant it is -ge: large, change, huge.'],
      ['duck', ['duk', 'ducc'], 'The ___ went quack.', 'After a short vowel, /k/ at the end is -ck: duck, back, lock.'],
      ['think', ['thinck', 'thinc'], 'I ___ it is here.', 'After a consonant it is just k: think, milk, bank.'],
      ['fetch', ['fech', 'fetsh'], 'Please ___ my coat.', 'Short vowel, then -tch: fetch, match, stitch.'],
      ['badge', ['baje', 'badg'], 'She wore a gold ___.', 'Short vowel, then -dge: badge, hedge, dodge.'],
      ['which', ['whitch', 'wich'], '___ one do you want?', 'which, rich, much, such — no t in any of them.'],
      ['kick', ['kik', 'kicc'], 'Do not ___ the chair.', 'One short vowel, so -ck at the end.']
    ],
    4: [
      ['running', ['runing', 'runnning'], 'He is ___ fast.', 'One short vowel + one consonant, so double it before -ing: run → running.'],
      ['hoping', ['hopping', 'hopeing'], 'I am ___ it does not rain.', '"hope" drops its e before -ing: hoping. (Hopping is from "hop"!)'],
      ['hopped', ['hoped', 'hopd'], 'The rabbit ___ away.', '"hop" doubles the p: hopped. "hoped" comes from "hope".'],
      ['smiled', ['smilled', 'smileed'], 'She ___ at me.', '"smile" already ends in e, so just add -d: smiled.'],
      ['carried', ['carryed', 'carrid'], 'He ___ the box.', 'A word ending in a consonant + y swaps the y for i: carry → carried.'],
      ['playing', ['plaing', 'playying'], 'We are ___ out.', 'A vowel before the y, so the y stays: play → playing.'],
      ['stopped', ['stoped', 'stoppd'], 'The bus ___ here.', 'Short vowel + one consonant, so double it: stop → stopped.'],
      ['jumped', ['jumpt', 'jumpd'], 'He ___ over it.', 'Two consonants already, so just add -ed: jumped. The /t/ sound is still -ed.'],
      ['making', ['makeing', 'makking'], 'I am ___ a cake.', '"make" drops the e before -ing: making.'],
      ['biggest', ['bigest', 'biggiest'], 'That is the ___ one.', 'Short vowel + one consonant doubles before -est too: big → biggest.']
    ],
    5: [
      ['boxes', ['boxs', 'boxies'], 'There are three ___.', 'A word ending in x, s, ch, sh or z adds -es: boxes, buses, wishes.'],
      ['babies', ['babys', 'babyes'], 'The ___ are asleep.', 'Consonant + y becomes -ies: baby → babies.'],
      ['keys', ['kies', 'keyes'], 'I lost my ___.', 'Vowel + y just adds -s: key → keys.'],
      ['little', ['littel', 'litle'], 'It is a ___ one.', 'The /l/ sound at the end is usually -le: little, apple, table.'],
      ['travel', ['travle', 'travell'], 'We ___ by train.', 'Some words use -el instead: travel, tunnel, camel.'],
      ['didn’t', ['did’nt', 'didnt'], 'I ___ see it.', 'The apostrophe goes where the letter is missing: did not → didn’t.'],
      ['can’t', ['ca’nt', 'cant'], 'I ___ reach.', 'cannot → can’t. The apostrophe replaces the "no".'],
      ['metal', ['mettal', 'metle'], 'The gate is made of ___.', 'And some use -al: metal, pedal, capital.'],
      ['wishes', ['wishs', 'wishies'], 'She made three ___.', 'Ends in sh, so add -es: wishes.'],
      ['it’s', ['its’', 'its'], '___ a lovely day.', '"it’s" with an apostrophe means "it is". "its" without one means belonging to it.']
    ]
  };

  K.game({
    slug: 'spell-spotter',
    title: 'Spell Spotter',
    short: 'Spot the right spelling — and learn the rule.',
    emoji: '🔎',
    stage: 'ks1',
    accent: '--c-play-6',
    levels: 5,
    roundLength: 10,
    howTo: 'A word is missing from the sentence. Three spellings are offered — only one is right. Get it wrong and you are told the rule.',
    curriculum: {
      framework: null,
      codes: ['Y1-EN-SP-1', 'Y2-EN-SP-1'],
      nc: 'KS1 English Appendix 1 (Spelling) — Year 1 and Year 2 common exception words; -tch, -dge and -ck after a short vowel; adding -ing, -ed, -er and -est; plurals with -s and -es; contractions.',
      plain: 'Year 1 and Year 2 statutory spelling — the common exception words and the named spelling rules (National Curriculum KS1 English, Appendix 1).',
      obs: 'Spelling rules transfer when the rule is said, not just the correction. Worth asking the child to tell YOU the rule back.'
    },

    turn: function (api) {
      var lvl = Math.min(5, api.level);
      var item = U.pick(BANK[lvl]);
      var right = item[0], wrongs = item[1], sentence = item[2], rule = item[3];
      var choices = lvl === 1 && api.level === 1 ? 2 : 3;

      var s = U.el('p', 'k-sentence');
      var parts = sentence.split('___');
      s.appendChild(document.createTextNode(parts[0]));
      var blank = U.el('span', 'blank');
      blank.textContent = ' ';
      s.appendChild(blank);
      s.appendChild(document.createTextNode(parts[1] || ''));
      var card = U.el('div', 'k-focus-card');
      card.appendChild(s);
      api.el.appendChild(card);

      var tiles = U.el('div', 'k-tiles');
      api.el.appendChild(tiles);

      api.ask('Which spelling is right?');
      setTimeout(function () { api.say(sentence.replace('___', right), { rate: 0.85 }); }, 1200);

      var options = U.shuffle([right].concat(U.shuffle(wrongs).slice(0, choices - 1)));
      options.forEach(function (w) {
        var t = api.tile(w, function (node) {
          api.lock();
          Array.prototype.forEach.call(tiles.querySelectorAll('.k-tile'), function (b) { b.disabled = true; });
          blank.textContent = w;
          if (w === right) {
            api.correct({ node: node });
          } else {
            blank.textContent = right;
            var ok = null;
            Array.prototype.forEach.call(tiles.querySelectorAll('.k-tile'), function (b) {
              if (b.textContent === right) ok = b;
            });
            api.wrong({ node: node, reveal: ok, hint: rule });
          }
        }, { cls: 'word', aria: w.split('').join(' ') });
        tiles.appendChild(t);
      });
    }
  });
})(window);
