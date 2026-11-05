#!/usr/bin/env node
'use strict';
/* Wren Phonics — decodability validator (b157).
 *
 * Toby's brief: stories must be STRICTLY decodable at their teaching point —
 * "validate programmatically, don't eyeball". This checks every word in a
 * story against exactly three allowed categories:
 *   1. tricky_words_available (case-insensitive exact match)
 *   2. proper_nouns_allowed — cast character names. Ealing review
 *      (2026-10-13): names are NOT exempt any more. DfE validation Note 1
 *      rules out words learned "by sight" and Note 6 allows only a few taught
 *      common-exception words, so a name must either decode with the GPCs
 *      taught so far (Pip, Ned, Moss, Fig, Nell, Dot) or be a taught tricky
 *      word (Olive, until 've' is taught in Year 1).
 *   3. fully segmentable into gpcs_available using greedy longest-match
 *      (tries trigraphs, then digraphs, then single letters, left to right)
 *
 * Usage:
 *   node validate-decodable.js <story.json>        validate one story
 *   node validate-decodable.js --all                validate every file in ../../content/phonics/stories/
 *
 * Exit code 0 = all stories pass, 1 = at least one word failed somewhere.
 */

const fs = require('fs');
const path = require('path');

// ---- b406: Phase 5b alternative-pronunciation awareness --------------------
// segmentWord() only sees spelling, not sound — "snow" and "cow" both segment
// fine once 'ow' is in gpcs_available, even though they use different phonemes.
// This builds a lookup of specific words that are known to rely on an
// ALTERNATIVE (non-primary) reading of a grapheme, sourced from the worked
// examples in phase5b-alternatives-gpc.json, so a story using one of them must
// declare that alternative taught (story.alternatives_available) or it fails.
// altKey format: "<grapheme>_<new_phoneme letters>", e.g. "ow_oa", "y_igh".
let _altWordMap;
function altWordMap() {
  if (_altWordMap) return _altWordMap;
  _altWordMap = new Map();
  try {
    const file = path.join(__dirname, '../../src/content/phonics/phase5b-alternatives-gpc.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of data.alternative_pronunciations || []) {
      const altKey = `${entry.grapheme}_${(entry.new_phoneme || '').replace(/[^a-z]/gi, '').toLowerCase()}`;
      for (const w of entry.example_words || []) _altWordMap.set(w.toLowerCase(), altKey);
    }
  } catch (e) { /* file not present yet — no alternative-reading checks */ }
  return _altWordMap;
}

// ---- b406: untaught-multigraph guard ---------------------------------------
// The original LATER_SPELLING regex below (b380) only lists the specific
// later-phase spellings someone had actually hit a bug with. Building the
// programme's word banks by searching combinatorially (not hand-picking)
// exposed the same class of bug for ANY multi-letter grapheme: e.g. "bee"
// or "moon" segment just fine as four single letters (b-e-e, m-o-o-n) before
// 'ee'/'oo' are taught, each single letter being individually valid — but
// read that way they don't sound like the word at all. This checks every
// contiguous multi-letter grapheme from Phases 3-6 (plus the Phase 5b new
// spellings): if it appears in the word's letters but was NOT the unit
// segmentWord actually matched there (because it isn't taught yet, so
// segmentWord fell back to single letters), that's the same bug. Split
// digraphs (a-e, e-e, i-e, o-e, u-e) aren't contiguous letter sequences so
// they can't be found this way — LATER_SPELLING's silent-e pattern below
// still catches those.
let _allMultigraphs;
function allMultigraphs() {
  if (_allMultigraphs) return _allMultigraphs;
  _allMultigraphs = [];
  try {
    const dir = path.join(__dirname, '../../src/content/phonics');
    // Deliberately NOT phase4: those 26 entries are consonant CLUSTERS (bl, st,
    // nd…), already governed by the separate adjacent-consonants-are-Phase4
    // check below — once a story is Phase 4+, ANY cluster is fair game, not
    // just the specific ones catalogued (that catalogue is a teaching-emphasis
    // order, not a per-cluster gate). This check is only for genuine phonemic
    // multigraphs (vowel/consonant digraphs and trigraphs), which DO gate hard.
    for (const f of ['phase3-learning-gpc.json', 'phase5-school-readiness-gpc.json', 'phase6-school-readiness-gpc.json']) {
      for (const g of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) {
        if (g.grapheme.length > 1 && !g.grapheme.includes('-') && !g.grapheme.includes('_')) _allMultigraphs.push(g.grapheme.toLowerCase());
      }
    }
    const alt = JSON.parse(fs.readFileSync(path.join(dir, 'phase5b-alternatives-gpc.json'), 'utf8'));
    for (const e of alt.alternative_spellings || []) if (!e.grapheme.includes('-')) _allMultigraphs.push(e.grapheme.toLowerCase());
  } catch (e) { /* content pack incomplete — no multigraph guard yet */ }
  // Longest first, so a trigraph check isn't shadowed by a shorter digraph substring.
  _allMultigraphs.sort((a, b) => b.length - a.length);
  return _allMultigraphs;
}
function untaughtMultigraphFlag(word, segUsed, gpcSet) {
  const lw = word.toLowerCase();
  // Intervals actually consumed by a multi-letter grapheme match, e.g. "air"
  // in "fair" covers [1,4) — a shorter untaught grapheme that happens to be a
  // substring of it ("ir" at [2,4)) is NOT a separate bug, just shadowing.
  const usedIntervals = [];
  let pos = 0;
  // A split-digraph token ("a-e") is a 3-character STRING but represents only
  // 2 real letters of the word (the vowel and the silent e — the consonant
  // between them is its own separate token right after), so position
  // tracking must use its real letter span, not its string length.
  for (const g of segUsed) { const span = g.includes('-') ? 2 : g.length; if (g.length > 1) usedIntervals.push([pos, pos + span]); pos += span; }
  const containedInUsed = (start, end) => usedIntervals.some(([s, e]) => s <= start && end <= e);
  const usedSplit = segUsed.some((t) => t.includes('-'));
  for (const g of allMultigraphs()) {
    if (gpcSet.has(g)) continue; // taught — any position using it was already allowed above
    // 've' after a split digraph (five, drive, wave) is the split digraph's own
    // silent e, not the 've' spelling — never an untaught 've' (2026-10-13).
    if (g === 've' && usedSplit) continue;
    let idx = lw.indexOf(g);
    while (idx !== -1) {
      if (positionOk(g, lw.slice(idx)) && !containedInUsed(idx, idx + g.length)) return g;
      idx = lw.indexOf(g, idx + 1);
    }
  }
  return null;
}

// ---- b406b: suffix (-ed/-ing/-er/-est) morphology guard --------------------
// segmentWord() sees "napped" as n-a-pp-e-d — every letter a taught Phase 2
// grapheme, so it passes — but "-ed" here is not the SOUND e+d, it's the
// Phase 6 past-tense ending (/t/, /d/ or /ɪd/ depending on the root). A word
// is only decodable as a suffixed form once that specific suffix is taught
// (gpcs_available contains the matching "suffix_-ed"/"suffix_-ing"/
// "suffix_-er"/"suffix_-est" catalog token — see schedule.json Year 1 Summer
// 2 / phase6-school-readiness-gpc.json). Most words that merely END in those
// letters are NOT suffixed forms (bed, red, shed, sing, king, her, sister,
// mother, better, butter, water, weather, corner, under, over...) — splitting
// them apart would wrongly gate them. Rather than guess from spelling alone
// (English is littered with coincidental short-root matches: "water"->"wat",
// "mother"->"moth", "better"->"bet", "butter"->"but" — all real words in a
// general dictionary, none of them the actual root), this only recognises a
// suffix when the root, after reversing the standard spelling change, is in
// a small CURATED set of verbs (for -ed/-ing) or adjectives (for -er/-est)
// that Wren's own content actually inflects. Two separate lists (not one
// shared root set) so a verb root like "rub" can't falsely turn the noun
// "rubber" into "rub+er" — only adjective roots are tried against -er/-est.
const SUFFIXABLE_VERB_ROOTS = new Set([
  'jump', 'play', 'stop', 'splash', 'land', 'look', 'rest', 'roll', 'pull', 'push',
  'nap', 'hop', 'run', 'smile', 'cry', 'help', 'want', 'fill', 'melt', 'rush',
  'climb', 'swim', 'hunt', 'paint', 'clean', 'cook', 'plant', 'visit', 'pack',
  'watch', 'wash', 'fix', 'mend', 'kick', 'pick', 'pass', 'miss', 'wish', 'catch',
  'cheer', 'shout', 'laugh', 'learn', 'open', 'close', 'start', 'finish', 'listen',
  'talk', 'walk', 'point', 'pour', 'mix', 'bake', 'boil', 'heat', 'fold', 'tie',
  'wrap', 'carry', 'hurry', 'worry', 'study', 'copy', 'reply', 'enjoy', 'plan',
  'drop', 'grab', 'chat', 'snap', 'slip', 'trip', 'flip', 'skip', 'trap', 'spin',
  'grin', 'pin', 'win', 'dig', 'beg', 'tug', 'hug', 'rob', 'drag', 'nag', 'tap',
  'pat', 'sit', 'dip', 'hit', 'nod', 'mop', 'rub', 'sob', 'jog', 'peck', 'peep',
  'creep', 'sleep', 'weep', 'scream', 'dream', 'roar', 'float', 'wave', 'lick',
  'camp', 'ask', 'rain', 'snow', 'blow', 'glow', 'row', 'tow', 'flow', 'show',
  'fish', 'wish', 'brush', 'crash', 'crush', 'rush', 'dust', 'lift', 'drift',
  'end', 'bend', 'mend', 'spend', 'melt', 'knit', 'spill', 'spell', 'smell',
  'yell', 'fill', 'chill', 'grill', 'drill', 'thrill', 'sail', 'wait', 'chase',
  'race', 'hide', 'ride', 'slide', 'joke', 'poke', 'bake', 'rake', 'shake',
  'wake', 'like', 'hike', 'bike', 'smile', 'pile', 'file', 'dive', 'drive',
  'squawk', 'stay', 'flap', 'drip', 'soak',
]);
const SUFFIXABLE_ADJ_ROOTS = new Set([
  'big', 'small', 'fast', 'slow', 'tall', 'short', 'long', 'high', 'low', 'warm',
  'cold', 'hot', 'cool', 'wet', 'dry', 'soft', 'hard', 'loud', 'quiet', 'thick',
  'thin', 'wide', 'deep', 'strong', 'weak', 'happy', 'sad', 'funny', 'silly',
  'easy', 'busy', 'tidy', 'lucky', 'lazy', 'heavy', 'young', 'new', 'nice',
  'fine', 'sharp', 'flat', 'neat', 'kind', 'rich', 'safe', 'sweet', 'bright',
  'cheap', 'rare', 'rude', 'wild', 'bold', 'dull', 'odd', 'plain', 'dark',
  'light', 'old', 'clean', 'late', 'close', 'calm', 'proud', 'brave', 'fit',
  'grand', 'firm', 'keen', 'ripe', 'pale', 'full', 'glad', 'sore', 'tame',
  'round', 'bare',
]);
const SUFFIX_TOKEN = { ing: 'suffix_-ing', ed: 'suffix_-ed', er: 'suffix_-er', est: 'suffix_-est' };
const VOWEL_LETTERS = new Set(['a', 'e', 'i', 'o', 'u']);
function suffixDecompose(word) {
  const lw = word.toLowerCase();
  const tryStrip = (suffix, rootSet) => {
    if (!lw.endsWith(suffix) || lw.length <= suffix.length) return null;
    const base = lw.slice(0, -suffix.length);
    // happy->happi(er): reverse the y->i spelling change before the suffix.
    if (base.endsWith('i') && base.length >= 2 && rootSet.has(base.slice(0, -1) + 'y')) {
      return { root: base.slice(0, -1) + 'y', suffix };
    }
    // nap->napp(ed), run->runn(ing): doubled final consonant, short-vowel root.
    if (base.length >= 3) {
      const last = base[base.length - 1], prev = base[base.length - 2];
      if (last === prev && !VOWEL_LETTERS.has(last) && rootSet.has(base.slice(0, -1))) {
        return { root: base.slice(0, -1), suffix };
      }
    }
    // smile->smil(ing): dropped silent e, only after a vowel+consonant ending
    // (never two consonants — that's what stopped "th"+"ing" misreading as "the").
    if (base.length >= 2) {
      const last = base[base.length - 1], prev = base[base.length - 2];
      if (VOWEL_LETTERS.has(prev) && !VOWEL_LETTERS.has(last) && rootSet.has(base + 'e')) {
        return { root: base + 'e', suffix };
      }
    }
    // jump->jump(ed): plain concatenation, no spelling change.
    if (rootSet.has(base)) return { root: base, suffix };
    return null;
  };
  for (const suf of ['ing', 'ed']) { const hit = tryStrip(suf, SUFFIXABLE_VERB_ROOTS); if (hit) return hit; }
  for (const suf of ['est', 'er']) { const hit = tryStrip(suf, SUFFIXABLE_ADJ_ROOTS); if (hit) return hit; }
  return null;
}

// ---- review 2026-10-08: split-digraph segmentation (a-e, e-e, i-e, o-e, u-e)
// segmentWord() below only ever found CONTIGUOUS graphemes, so a split
// digraph ("made" = m-a-d-e, vowel...consonant...silent e) was always read as
// four single letters even once a-e was taught — every downstream "does this
// word use today's new grapheme" check (lesson-data.js's wordUsesGrapheme,
// build-banks.js's candidate search...) tests seg.used.includes(key), which
// can never be true for a token segmentWord could never produce. Result: "no
// model word exists yet" on every split-digraph day (b410 review). This
// recognises VOWEL + one taught consonant (a single letter, or one of the
// taught consonant digraphs) + a final silent 'e', and returns the vowel+e as
// ONE token with the consonant placed right after it: made -> ["m","a-e","d"]
// (the final 'e' itself gets no token of its own — a silent letter, same as
// "a silent final e gets no button" in the SEND review). This also naturally
// covers a split digraph before a plural/3rd-person -s ("makes" -> "m","a-e",
// "k","s", since the loop just continues normally from the letter after 'e')
// and before a dropped-e suffix root read in isolation ("smiling"'s root
// "smile" -> "s","m","i-e","l", via the existing suffix-aware recursion in
// reachablePhoneEnds/wordSoundsLike, which calls segmentWord on the bare root).
// A fixed exception list: these words are genuinely irregular — their real
// sound is NOT the split-digraph reading (come/love/have/give/done/gone/one
// are /ʌ/ or /ɒ/, not the long vowel; "are" is just a tricky word) — so
// segmentWord must never offer that reading even though the spelling fits
// the pattern. soundCheck would reject the wrong reading anyway, but a
// tricky/irregular word must never even surface a (wrong) sound button.
// 2026-10-13: + olive/live/gives/lives — with 've' taught (Year 1) these are i + ve, not the i-e split.
const SPLIT_DIGRAPH_WORD_EXCEPTIONS = new Set(['come', 'some', 'love', 'have', 'give', 'are', 'done', 'gone', 'one', 'there', 'where', 'were', 'here', 'olive', 'olives', 'live', 'lives', 'gives', 'loves']);
const SPLIT_DIGRAPH_CONSONANT_DIGRAPHS = ['ch', 'sh', 'th', 'ck', 'ph', 'wh', 'ff', 'll', 'ss', 'zz', 'ng'];
const SPLIT_DIGRAPH_VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
function trySplitDigraph(word, i, gpcSet) {
  const v = word[i];
  if (!SPLIT_DIGRAPH_VOWELS.has(v) || SPLIT_DIGRAPH_WORD_EXCEPTIONS.has(word)) return null;
  const sdKey = `${v}-e`;
  if (!gpcSet.has(sdKey)) return null;
  for (const clen of [2, 1]) {
    const c = word.slice(i + 1, i + 1 + clen);
    if (c.length !== clen || word[i + 1 + clen] !== 'e') continue;
    if (clen === 2 ? !SPLIT_DIGRAPH_CONSONANT_DIGRAPHS.includes(c) : SPLIT_DIGRAPH_VOWELS.has(c)) continue;
    if (!gpcSet.has(c)) continue;
    return { consumed: clen + 2, tokens: [sdKey, c] };
  }
  return null;
}

// Ealing review 2026-10-13: 've' (give, sleeve) and 'are' (care, share) are
// word-final spellings. Matched anywhere, greedy segmentation would read
// "vet" as ve·t and "parent" as p·are·nt. They only count at the end of a word,
// optionally followed by a plural/past ending (gives, shared).
const POSITIONAL_GRAPHEMES = { ve: /^ve[sd]?$/, are: /^are[sd]?$/ };
function positionOk(chunk, rest) {
  const re = POSITIONAL_GRAPHEMES[chunk];
  return !re || re.test(rest);
}

function segmentWord(word, gpcSet) {
  // gpcSet: Set of lowercase graphemes available, e.g. {'s','a','t','ch','igh'}
  const maxLen = Math.max(...Array.from(gpcSet, g => g.length), 1);
  let i = 0;
  const used = [];
  while (i < word.length) {
    let matched = null;
    for (let len = Math.min(maxLen, word.length - i); len >= 1; len--) {
      const chunk = word.slice(i, i + len);
      if (gpcSet.has(chunk) && positionOk(chunk, word.slice(i))) { matched = chunk; break; }
    }
    // Only fall back to the split-digraph reading when it covers MORE letters
    // than the ordinary contiguous match at this position — otherwise a word
    // like "more"/"store" (a contiguous "ore" trigraph, 3 letters) loses to
    // the split-digraph "o-e"+"r" reading (also 3 letters, but the wrong one:
    // "ore" is its own taught grapheme, not an o-e split) on a pure letter
    // count tie. A genuine split digraph ("these" = e-e+s, 3 letters) always
    // beats the single-letter contiguous match ("e" alone, 1 letter) it's
    // competing with, since there's no contiguous multi-letter alternative.
    const sd = trySplitDigraph(word, i, gpcSet);
    if (sd && (!matched || sd.consumed > matched.length)) {
      used.push(...sd.tokens); i += sd.consumed; continue;
    }
    if (!matched) return { ok: false, at: i, used };
    used.push(matched);
    i += matched.length;
  }
  return { ok: true, used };
}

function tokenizeStoryText(text) {
  // Words only — strips punctuation, keeps apostrophes inside a word (contractions)
  // as a single token so they surface as an explicit fail (Wren phase2/3 stories
  // shouldn't use contractions yet; this makes that visible rather than silently
  // stripping the apostrophe and passing).
  return (text.match(/[A-Za-z']+/g) || []);
}

// ---- b380: phase-placement checks -------------------------------------------
// Letter-by-letter segmentation cannot see two classes of error, both of which
// shipped (Bramble, 2026-08; fast/glad/pond/calm/say/time/by/won, 2026-10):
//   1. ADJACENT CONSONANTS (st, gr, nd, br…) are Phase 4. Every letter is a
//      Phase 2/3 grapheme, so the segmenter passes them — but a Phase 2–3 reader
//      has not been taught to blend them.
//   2. LATER-PHASE SPELLINGS read letter by letter: "say" (ay, Phase 5), "time"
//      (i-e), "by" (y as /igh/), silent letters ("calm"), irregular vowels ("won").
// Allowed in Phase 2–3: the -s suffix (cats, digs), double letters (ss/ll/ff/zz),
// two-syllable CVC compounds (sunset, zigzag), and Letters & Sounds Phase 2
// high-frequency words that are taught as decodable (and, his, of, put, off…).
const VOWEL_GPCS = new Set(['a', 'e', 'i', 'o', 'u', 'ai', 'ee', 'igh', 'oa', 'oo', 'ar', 'or', 'ur', 'ow', 'oi', 'ear', 'air', 'ure', 'er']);
// Ealing review 2026-10-13: is/his/has/as/of/put are now scheduled Reception
// TRICKY words (taught with their tricky part, the week they are first used),
// so they no longer need this whole-word pass. Only 'and' stays: it decodes
// a-n-d with taught sounds, but its final n-d pair would otherwise be held
// back to Phase 4 — Letters and Sounds (2007) lists it as a Phase 2 decodable word.
const EARLY_HFW_OK = new Set(['and']);
const SYLLABLE_COMPOUNDS_OK = new Set(['zigzag', 'sunset', 'catkin', 'pocket', 'rabbit', 'carpet', 'picnic', 'laptop', 'tiptop', 'bedbug', 'hotdog', 'pigpen', 'humbug', 'tomcat', 'cobweb', 'sunhat', 'windmill', 'hilltop', 'desktop', 'chicken', 'kitten', 'mitten', 'bucket', 'jacket', 'rocket', 'locket', 'puppet', 'magnet', 'goblin']);
const NEVER_DECODABLE_EARLY = new Set(['calm', 'won', 'son', 'ton', 'half', 'walk', 'talk', 'palm', 'two', 'one', 'once', 'who', 'what', 'was', 'want', 'wash', 'swan', 'any', 'many', 'eye', 'eyes']);
const LATER_SPELLING = /(ay|ou|ie|ea|oy|ir|ue|aw|wh|ph|ew|oe|au|ey|[aeiou][bcdfgklmnprstvz]e$|[^aeiouy]y$|[^aeiou]le$)/;

function phaseFlags(word, segUsed, story) {
  const phase = story.phase || 0;
  const lw = word.toLowerCase();
  const gpcs = new Set((story.gpcs_available || []).map((g) => g.toLowerCase()));
  const out = [];
  if (phase >= 2 && phase <= 4 && NEVER_DECODABLE_EARLY.has(lw)) out.push('not decodable with any Phase 2–4 code (irregular/silent letter)');
  if (phase >= 2 && phase <= 4 && !gpcs.has('ay')) {
    const m = lw.match(LATER_SPELLING);
    // ear/air/ure are Phase 3 graphemes; only flag if the matched spelling is not
    // explained by a grapheme the book actually teaches. A hyphenated token
    // means segmentWord already recognised a taught split digraph here, so
    // the "silent-e" branch of this regex is explained too (split digraphs
    // are Phase 5+ content, so this guard rarely fires for them in practice —
    // kept for defensive consistency since this check isn't phase-scoped to
    // exclude them).
    if (m && !segUsed.some((g) => g.includes('-')) && !segUsed.some((g) => g.length > 1 && g.includes(m[0].replace(/[^a-z]/g, '').slice(0, 2)))) {
      out.push(`uses a later-phase spelling ("${m[0]}") read letter by letter`);
    }
  }
  if (!EARLY_HFW_OK.has(lw)) {
    const untaught = untaughtMultigraphFlag(lw, segUsed, gpcs);
    if (untaught) out.push(`contains the untaught spelling "${untaught}" read as separate letters`);
  }
  // Suffix check applies at every phase, not just 2-4 — a Phase 5 book is just
  // as premature as a Phase 2 one if it uses "-ed"/"-ing"/"-er"/"-est" before
  // that suffix is taught (Year 1 Summer 2 in our schedule).
  const suffixed = suffixDecompose(lw);
  if (suffixed && !gpcs.has(SUFFIX_TOKEN[suffixed.suffix])) {
    out.push(`uses the "-${suffixed.suffix}" ending (root "${suffixed.root}") before "${SUFFIX_TOKEN[suffixed.suffix]}" is taught`);
  }
  if (phase >= 2 && phase <= 3 && !EARLY_HFW_OK.has(lw) && !SYLLABLE_COMPOUNDS_OK.has(lw)) {
    let u = segUsed.slice();
    if (u.length > 2 && u[u.length - 1] === 's' && !VOWEL_GPCS.has(u[u.length - 2])) u = u.slice(0, -1);
    for (let i = 0; i < u.length - 1; i++) {
      // 2026-10-13: a consonant DIGRAPH next to another consonant (lunch n+ch, shrink sh+r, three th+r) is
      // an adjacent-consonant word too — it used to slip through because only single letters were compared.
      if (!VOWEL_GPCS.has(u[i]) && !VOWEL_GPCS.has(u[i + 1]) && u[i] !== u[i + 1] && u[i].length <= 2 && u[i + 1].length <= 2 && !u[i].includes('-') && !u[i + 1].includes('-')) {
        out.push(`adjacent consonants "${u[i]}${u[i + 1]}" are Phase 4`); break;
      }
    }
  }
  return out;
}

// ---- b406c: sound check (pronouncing-dictionary alignment) -----------------
// Everything above segments a word into taught GRAPHEMES — it never checks
// that reading those graphemes with their taught SOUNDS actually produces
// the word's real pronunciation. "knot" (silent k), "sure" (s=/sh/), "radio"
// (a=/ai/, i=/ee/), "door" (oo=/or/, before 'oor' is taught), "sugar", "two",
// "eye", "busy" all segment fine letter-by-letter but don't sound like the
// word. soundCheck() closes this: it looks up the word's real pronunciation(s)
// in the CMU Pronouncing Dictionary (cmudict.dict, American English) and asks
// whether SOME reading of the word using only taught graphemes and their
// taught sounds (base + any taught alternative) produces that pronunciation.
//
// GPC_BASE: grapheme -> array of allowed ARPAbet phone sequences (stress
// digits stripped before comparison — CMU marks stress, our catalog doesn't
// distinguish it). Multiple entries per grapheme are "American-dictionary
// tolerance": the same taught British-English phoneme sometimes shows up as
// a different ARPAbet symbol in a US dictionary (a/bath,fast -> AE or AA;
// o/hot,dog -> AA or AO) — this is accent transcription variance for ONE
// sound, not a new sound to teach, so it's never gated. It deliberately does
// NOT include "o -> AH" (son, mother, come) — that's the taught o_u
// ALTERNATIVE pronunciation below (new vowel quality /ʌ/, not an accent
// variant of /ɒ/), and folding it into the base table would silently make
// "son"/"mother"/"love" decodable before that alternative is ever taught,
// reopening exactly the hole this build closes.
const GPC_BASE = {
  // Phase 2
  s: [['S']], a: [['AE'], ['AA']], t: [['T']], p: [['P']], i: [['IH']], n: [['N']], m: [['M']],
  d: [['D']], g: [['G']], o: [['AA'], ['AO']], c: [['K']], k: [['K']], ck: [['K']], e: [['EH']],
  u: [['AH']], r: [['R']], h: [['HH']], b: [['B']], f: [['F']], ff: [['F']], l: [['L']], ll: [['L']], ss: [['S']],
  // Phase 3
  j: [['JH']], v: [['V']], w: [['W']], x: [['K', 'S']], y: [['Y']], z: [['Z']], zz: [['Z']],
  qu: [['K', 'W']], ch: [['CH']], sh: [['SH']], th: [['TH'], ['DH']], ng: [['NG']],
  // 'ee' immediately before 'r' ("deer", "cheer", "beer", "steer") is the
  // same near-merger vowel as 'ear' (IH R), never the plain long /iː/ —
  // true for every cmudict 'ee'+r word, not a one-off.
  ai: [['EY']], ee: [['IY'], ['IH']], igh: [['AY']], oa: [['OW']], oo: [['UW']],
  ar: [['AA', 'R'], ['AA']], or: [['AO', 'R'], ['AO']], ur: [['ER']], ow: [['AW']], oi: [['OY']],
  ear: [['IH', 'R']], air: [['EH', 'R']],
  ure: [['UH', 'R'], ['Y', 'UH', 'R'], ['ER'], ['Y', 'ER'], ['AO', 'R'], ['Y', 'AO', 'R']],
  er: [['ER']],
  // Phase 4 — adjacent consonants (b406b: two sounds blended, never taught as
  // a single new fused sound — this table reflects that, each is 2 phones).
  bl: [['B', 'L']], br: [['B', 'R']], cl: [['K', 'L']], cr: [['K', 'R']], dr: [['D', 'R']],
  fl: [['F', 'L']], fr: [['F', 'R']], gl: [['G', 'L']], gr: [['G', 'R']], pl: [['P', 'L']], pr: [['P', 'R']],
  sc: [['S', 'K']], sk: [['S', 'K']], sl: [['S', 'L']], sm: [['S', 'M']], sn: [['S', 'N']], sp: [['S', 'P']],
  st: [['S', 'T']], sw: [['S', 'W']], tr: [['T', 'R']],
  nd: [['N', 'D']], nt: [['N', 'T']], nk: [['NG', 'K']], ft: [['F', 'T']], lt: [['L', 'T']], lf: [['L', 'F']],
  // Phase 5
  // 'ue' keeps the /j/ glide after some consonants ("rescue", "argue") but
  // not others ("blue", "glue") — same split as 'ew'/'u-e', above.
  ay: [['EY']], ou: [['AW']], ie: [['AY']], ea: [['IY']], oy: [['OY']], ir: [['ER']], ue: [['UW'], ['Y', 'UW']],
  // 'wh' is usually just /w/ in modern speech ("white"/"while" both have a
  // cmudict entry without the H), some speakers keep the historical /hw/,
  // and in "whole"/"who" it's just /h/ (the w is fully silent) — all three
  // are the same taught grapheme, so all three are allowed.
  // aw/au ↔ AO, with the same cot-caught AA tolerance as or/ore/oor/our
  // ("raw" -> cmudict's R AA1, no separate AO entry for some speakers).
  // 'ew' usually keeps the /j/ glide after certain consonants ("few", "new")
  // but not others ("chew", "blew") — both are the one taught sound.
  aw: [['AO'], ['AA']], wh: [['W'], ['HH', 'W'], ['HH']], ph: [['F']], ew: [['UW'], ['Y', 'UW']], oe: [['OW']], au: [['AO'], ['AA']],
  // Split digraphs (a-e, e-e, i-e, o-e, u-e) — never a literal substring of
  // any word (the final 'e' is silent and non-adjacent to the vowel letter),
  // so they can never be reached via the plain segmentation loop below; they
  // exist here only so taughtGPCs membership can be tested, and are matched
  // via the dedicated split-digraph path in wordSoundsLike().
  // 'u-e' keeps the /j/ glide after some consonants ("cute") but not others
  // ("rule", "tune") — same split as plain 'u' (u_yoo) vs 'ew', above.
  // a-e before 'r' ("bare", "care", "share") is EH not EY — the same
  // r-coloured exception as "are" itself; only ever reachable when the
  // following consonant actually is 'r', since nothing else in real content
  // has an EH target in this position.
  'a-e': [['EY'], ['EH']], 'e-e': [['IY']], 'i-e': [['AY']], 'o-e': [['OW']], 'u-e': [['Y', 'UW'], ['UW']],
  // Phase 5b alternative SPELLINGS — new graphemes for an already-taught
  // sound. build-schedule.js adds these straight into gpcs_available (not
  // alternatives_available), so they're gated exactly like any base grapheme
  // above. "poor" realises as UW R in American dictionaries (cot/pour merger
  // varies by speaker) alongside the expected AO R, hence the extra tolerance.
  eigh: [['EY']], ei: [['EY']], ey: [['EY']],
  // Ealing review 2026-10-13 — NC Appendix 1 Year 1 spellings that were
  // missing: -tch (catch), the /v/ at the end of words (give, live), 'are'
  // for /air/ (care, share). 've' and 'are' are only ever word-final (plus a
  // plural/past -s/-d): see POSITIONAL_GRAPHEMES below.
  tch: [['CH']], ve: [['V']], are: [['EH', 'R']],
  ore: [['AO', 'R'], ['AO'], ['UW', 'R'], ['UH', 'R']],
  oor: [['AO', 'R'], ['AO'], ['UW', 'R'], ['UH', 'R']],
  our: [['AO', 'R'], ['AO'], ['UW', 'R'], ['UH', 'R']],
};
// 'oo' makes two sounds taught as two catalog steps under the one grapheme
// (phase3-learning-gpc.json: "oo" then "oo_s") — the long /uː/ is always
// available once 'oo' is taught; the short /ʊ/ only once 'oo_s' is ALSO
// taught. 'oo_s' is never itself a literal grapheme in a word (segmentWord
// never matches it), so it's handled here, not in GPC_BASE.
const OO_SHORT = [['UH']];

// Phase 5b alternative PRONUNCIATIONS — a NEW sound for an already-taught
// grapheme, gated by alternatives_available (same altKey format altWordMap()
// builds above: "<grapheme>_<new_phoneme letters>"). Calibrated against real
// cmudict.dict entries (e.g. a_o covers "what" -> AH1 as well as "was"/
// "want"/"wash"/"wasp" -> AA1/AO1).
const ALT_PATTERNS = {
  y_igh: [['AY']], y_ee: [['IY']],
  a_o: [['AA'], ['AO'], ['AH']],
  e_ee: [['IY']],
  i_igh: [['AY']],
  o_oa: [['OW']], o_u: [['AH']],
  u_oo: [['UH']], u_yoo: [['Y', 'UW']],
  c_s: [['S']], g_j: [['JH']],
  ch_k: [['K']], ch_sh: [['SH']],
  ow_oa: [['OW']],
  ie_ee: [['IY']],
  ea_e: [['EH']],
  ou_oo: [['UW']], ou_u: [['AH']],
  ear_er: [['ER']], or_er: [['ER']],
  ear_air: [['EH', 'R']],
};
const ALT_BY_GRAPHEME = {};
for (const [altKey, patterns] of Object.entries(ALT_PATTERNS)) {
  const g = altKey.slice(0, altKey.lastIndexOf('_'));
  (ALT_BY_GRAPHEME[g] = ALT_BY_GRAPHEME[g] || []).push([altKey, patterns]);
}

// Graphemes segmentWord-style position matching can actually try as a literal
// substring (excludes split digraphes, which contain '-').
const SEGMENTABLE_GRAPHEMES = Object.keys(GPC_BASE).filter((g) => !g.includes('-'));
const MAX_GPC_LEN = Math.max(...SEGMENTABLE_GRAPHEMES.map((g) => g.length));
const SINGLE_VOWEL_LETTERS = new Set(['a', 'e', 'i', 'o', 'u']);

function patternsFor(g, taughtSet, altSet) {
  const out = (GPC_BASE[g] || []).slice();
  if (g === 'oo' && taughtSet.has('oo_s')) out.push(...OO_SHORT);
  for (const [altKey, patterns] of (ALT_BY_GRAPHEME[g] || [])) if (altSet.has(altKey)) out.push(...patterns);
  return out;
}
function phoneBase(p) { return p.replace(/\d$/, ''); }
function phoneStress(p) { const m = p.match(/(\d)$/); return m ? m[1] : null; }
function syllableCount(pron) { return pron.filter((p) => /\d$/.test(p)).length; }

// Fully consumes `word`'s letters (a plain lowercase string — no suffix/
// silent-e morphology) via taught graphemes and taught sounds, returning the
// SET of phoneme-index positions reached in `pron`. Used directly for a
// whole-word check (does it reach pron.length?) and as a building block for
// the suffix-aware and split-digraph-aware checks below, which need to know
// where a ROOT or PREFIX's reading ends so they can check the remainder.
function reachablePhoneEnds(word, pron, taughtSet, altSet, phase) {
  const n = word.length;
  const totalSyll = syllableCount(pron);
  // Once the general concept of "a final e can be silent" has been taught
  // (any one split digraph), a taught DIGRAPH (not just a single vowel
  // letter) followed by a consonant and a silent 'e' is common and doesn't
  // change the digraph's own sound ("cause"/"pause" -> au; "noise" -> oi;
  // "house" -> ou) — unlike the single-letter-vowel case below, which
  // changes short to long, so is handled separately via sdKey patterns.
  const silentETaught = ['a-e', 'e-e', 'i-e', 'o-e', 'u-e'].some((k) => taughtSet.has(k));
  const memo = new Map();
  function rec(pos, phonePos) {
    if (pos === n) return [phonePos];
    const key = pos + ',' + phonePos;
    if (memo.has(key)) return memo.get(key);
    const results = [];
    // A trailing 'e' is "effectively word-final" for the plural/3rd-person
    // -s voicing tolerance below whether it's the literal last letter, or
    // one silent 'e' away from it ("cause", "rose") — same voicing rule
    // either way.
    const wordFinalish = (afterLen) => pos + afterLen === n || (pos + afterLen === n - 1 && word[n - 1] === 'e' && silentETaught);
    const maxLen = Math.min(MAX_GPC_LEN, n - pos);
    for (let len = maxLen; len >= 1; len--) {
      const chunk = word.slice(pos, pos + len);
      if (!taughtSet.has(chunk) || !GPC_BASE[chunk]) continue;
      if (!positionOk(chunk, word.slice(pos))) continue;
      const patterns = patternsFor(chunk, taughtSet, altSet);
      // Plural/3rd-person -s regularly voices to /z/ after a voiced sound
      // ("dogs", "runs", "legs", "hers", "rose", "cause") — productive
      // English morphology, not a new taught sound, so never gated.
      // Restricted to a final 's' in a word of 4+ letters: every 3-letter
      // word in this catalog's content ending in a plain 's' ("was", "is",
      // "his", "as"...) is a genuinely irregular/tricky word in its OWN
      // right (handled via EARLY_HFW_OK or tricky_words_available, never via
      // this tolerance) — letting a bare 3-letter word through here would
      // wrongly validate "was" as /wʌz/.
      if (chunk === 's' && wordFinalish(1) && n >= 4) patterns.push(['Z']);
      // Unstressed vowels commonly reduce to schwa regardless of their own
      // spelling ("rocket" -> R AA1 K AH0 T — the 'e' is read /ə/, not /ɛ/).
      // Scoped to single-letter vowel graphemes, Phase 4+, 2+ syllable words
      // only — never in Phase 2-3 CVC work, per the brief.
      if (SINGLE_VOWEL_LETTERS.has(chunk) && phase >= 4 && totalSyll >= 2 && phonePos < pron.length) {
        const base = phoneBase(pron[phonePos]);
        if (phoneStress(pron[phonePos]) === '0' && (base === 'AH' || base === 'IH' || base === 'ER')) patterns.push([base]);
      }
      for (const patt of patterns) {
        if (phonePos + patt.length > pron.length) continue;
        let ok = true;
        for (let k = 0; k < patt.length; k++) if (phoneBase(pron[phonePos + k]) !== patt[k]) { ok = false; break; }
        if (ok) results.push(...rec(pos + len, phonePos + patt.length));
      }
    }
    // A taught digraph/cluster directly followed by a silent final 'e'
    // ("cause", "pause", "noise", "house") — the digraph's own sound is
    // unchanged, the 'e' just doesn't count. (The single-vowel-LETTER case,
    // where the silent e retroactively changes a short vowel to long, is
    // the sdKey branch below, not this one.)
    if (silentETaught && pos === n - 1 && word[pos] === 'e') results.push(...rec(n, phonePos));
    // Split digraph (a-e/e-e/i-e/o-e/u-e): vowel + single consonant + silent
    // 'e', optionally with a plural/3rd-person 's' tacked on ("takes") — the
    // 'e' is still silent, the trailing 's' still follows the ordinary
    // word-final voicing tolerance. Checked here (inside the recursion, not
    // just at the top level) so it also fires for a suffix ROOT read in
    // isolation — "smile" inside "smiling" — not only for a whole top-level
    // word.
    const tail = word.slice(pos);
    const m3 = tail.match(/^([aeiou])([bcdfgklmnprstvz])e(s)?$/);
    if (m3) {
      const sdKey = `${m3[1]}-e`;
      const consLetter = m3[2];
      const hasS = !!m3[3];
      if (taughtSet.has(sdKey) && taughtSet.has(consLetter)) {
        for (const vp of patternsFor(sdKey, taughtSet, altSet)) {
          if (phonePos + vp.length > pron.length || !vp.every((b, i) => phoneBase(pron[phonePos + i]) === b)) continue;
          const afterV = phonePos + vp.length;
          // consLetter is immediately before the silent 'e' — "effectively
          // word-final" for the same plural-voicing reason as above
          // ("rose", "nose" — the single-vowel-letter sibling of "cause").
          const consPatterns = patternsFor(consLetter, taughtSet, altSet).slice();
          if (consLetter === 's' && n >= 4) consPatterns.push(['Z']);
          for (const cp of consPatterns) {
            if (afterV + cp.length > pron.length || !cp.every((b, i) => phoneBase(pron[afterV + i]) === b)) continue;
            const afterC = afterV + cp.length;
            if (!hasS) { results.push(...rec(n, afterC)); continue; }
            const sPatterns = [['S']];
            if (n >= 4) sPatterns.push(['Z']);
            for (const sp of sPatterns) {
              if (afterC + sp.length <= pron.length && sp.every((b, i) => phoneBase(pron[afterC + i]) === b)) results.push(...rec(n, afterC + sp.length));
            }
          }
        }
      }
    }
    memo.set(key, results);
    return results;
  }
  return new Set(rec(0, 0));
}

// -ed/-ing/-er/-est tails, calibrated against real cmudict.dict inflected
// forms (jumped/napped -> T; smiled/moved -> D; wanted/painted -> IH D;
// landed/rested -> AH D; jumping/napping -> IH NG; bigger/faster -> ER;
// biggest/fastest/happiest -> AH S T).
const SUFFIX_TAIL_OPTIONS = {
  ed: [['T'], ['D'], ['IH', 'D'], ['AH', 'D']],
  ing: [['IH', 'NG']],
  er: [['ER']],
  est: [['AH', 'S', 'T'], ['IH', 'S', 'T']],
};
function tailMatches(suffix, tailPhones, root) {
  const bases = tailPhones.map(phoneBase);
  let options = SUFFIX_TAIL_OPTIONS[suffix] || [];
  // "long"/"strong"/"young" + -er/-est insert an intrusive /g/ not present in
  // the root alone (longer/longest, stronger/strongest) — a regular feature
  // of -ng adjectives, not a one-off irregularity.
  if ((suffix === 'er' || suffix === 'est') && /ng$/.test(root || '')) {
    options = options.concat(options.map((opt) => ['G', ...opt]));
  }
  return options.some((opt) => opt.length === bases.length && opt.every((b, i) => b === bases[i]));
}

// (Split-digraph handling — a-e/e-e/i-e/o-e/u-e, "cake"/"smile" — lives
// inside reachablePhoneEnds() itself above, not here, so it also applies
// when a suffix ROOT is read in isolation below.)

function wordSoundsLike(lw, pron, taughtSet, altSet, phase) {
  if (reachablePhoneEnds(lw, pron, taughtSet, altSet, phase).has(pron.length)) return true;

  const sfx = suffixDecompose(lw);
  if (sfx && taughtSet.has(SUFFIX_TOKEN[sfx.suffix])) {
    for (const k of reachablePhoneEnds(sfx.root, pron, taughtSet, altSet, phase)) {
      if (tailMatches(sfx.suffix, pron.slice(k), sfx.root)) return true;
    }
  }
  return false;
}

let _cmuDict;
function loadCmuDict() {
  if (_cmuDict) return _cmuDict;
  _cmuDict = new Map();
  const text = fs.readFileSync(path.join(__dirname, 'data/cmudict.dict'), 'utf8');
  for (const line of text.split('\n')) {
    if (!line || line.startsWith(';;;')) continue;
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    let word = line.slice(0, sp);
    const phones = line.slice(sp + 1).trim().split(/\s+/);
    const variant = word.match(/^(.*)\(\d+\)$/);
    if (variant) word = variant[1];
    word = word.toLowerCase();
    if (!_cmuDict.has(word)) _cmuDict.set(word, []);
    _cmuDict.get(word).push(phones);
  }
  return _cmuDict;
}
let _extraPron;
function loadExtraPron() {
  if (_extraPron) return _extraPron;
  _extraPron = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/extra-pronunciations.json'), 'utf8'));
    for (const [word, prons] of Object.entries(data.words || {})) {
      _extraPron.set(word.toLowerCase(), prons.map((p) => p.split(/\s+/)));
    }
  } catch (e) { /* file missing — no overrides */ }
  return _extraPron;
}
function pronunciationsFor(word) {
  const extra = loadExtraPron();
  if (extra.has(word)) return extra.get(word);
  return loadCmuDict().get(word) || [];
}

// ---- b408b: true-homophone guard for generated nonsense words -------------
// A generated pseudo-word can dodge both the plain "is this spelling in the
// dictionary" check (pronunciationsFor) and a spelling edit-distance check
// while still SOUNDING exactly like a real word, because English spelling
// and pronunciation diverge ("bloo" sounds exactly like "blue", "laim"
// exactly like "lame") — caught reviewing b408's PSC-practice output. This
// reads the taught graphemes with their PRIMARY taught sound only (nonsense-
// word generation never reaches for an alternative reading) and checks the
// resulting phone sequence against every pronunciation in cmudict.dict,
// stress-stripped so e.g. "EY1" and "EY0" still match.
let _cmuPhoneIndex;
function cmuPhoneIndex() {
  if (_cmuPhoneIndex) return _cmuPhoneIndex;
  _cmuPhoneIndex = new Set();
  for (const prons of loadCmuDict().values()) {
    for (const pron of prons) _cmuPhoneIndex.add(pron.map(phoneBase).join(' '));
  }
  return _cmuPhoneIndex;
}
function primaryPhonesFor(graphemesUsed) {
  const out = [];
  for (const g of graphemesUsed) {
    const patterns = GPC_BASE[g.toLowerCase()];
    if (!patterns || !patterns.length) return null;
    out.push(...patterns[0]);
  }
  return out;
}
function soundsLikeRealWord(graphemesUsed) {
  const phones = primaryPhonesFor(graphemesUsed);
  if (!phones || !phones.length) return false;
  return cmuPhoneIndex().has(phones.map(phoneBase).join(' '));
}

// soundCheck(word, taughtGPCs, taughtAlternatives, phase?) — true if SOME
// segmentation of `word` into taught graphemes, read with their taught
// sounds (base, or a taught alternative), produces ANY of the word's real
// CMU pronunciations. `phase` (default 0) gates the Phase-4+ unstressed-vowel
// tolerance inside reachablePhoneEnds — omit it (or pass 0) to disable that
// tolerance entirely, e.g. for an isolated check with no phase context.
// Words absent from both cmudict.dict and extra-pronunciations.json fail —
// tricky words and proper nouns must be exempted by the CALLER (as
// validateStory already does) before reaching this function.
// British-accent (trap-bath split) words: CMU's dictionary is American and
// gives these a short /æ/ ("fast" like "cat" + "st"), but Southern British
// English — where this programme is actually used (Ealing) — says a long
// /ɑː/ instead ("fast" rhymes with "last" said "larst", not with "cat"). Not
// a blanket ban (the 43 published story books use several of these in
// context and read fine — a story isn't an isolated sound-drill), so this is
// NOT applied inside soundCheck itself; callers that pick a word to hold up
// in isolation as a MODEL for blending (boost plans, SEND grids, Fast Track
// dictation, bank model words) check this set themselves and skip these
// words (review 2026-10-08, b410 #12; the b411 follow-up asked for the list).
const BATH_TRAP_WORDS = new Set(['fast', 'last', 'past', 'grass', 'class', 'glass', 'path', 'bath', 'after', 'craft', 'graph', 'grasp', 'gasp', 'mask', 'task', 'cast', 'master', 'plaster', 'rather', 'branch', 'ask', 'chance', 'dance', 'blast', 'basket']);
function soundCheck(word, taughtGPCs, taughtAlternatives, phase) {
  const lw = word.toLowerCase();
  const taughtSet = taughtGPCs instanceof Set ? taughtGPCs : new Set(Array.from(taughtGPCs || [], (g) => g.toLowerCase()));
  const altSet = taughtAlternatives instanceof Set ? taughtAlternatives : new Set(taughtAlternatives || []);
  const prons = pronunciationsFor(lw);
  if (!prons.length) return false;
  return prons.some((pron) => wordSoundsLike(lw, pron, taughtSet, altSet, phase || 0));
}

function validateStory(story) {
  const gpcSet = new Set((story.gpcs_available || []).map(g => g.toLowerCase()));
  const trickySet = new Set((story.tricky_words_available || []).map(w => w.toLowerCase()));
  const properNouns = new Set(story.proper_nouns_allowed || []);
  const failures = [];
  const pages = story.pages || [];

  pages.forEach((page, pageIdx) => {
    const words = tokenizeStoryText(page.text || '');
    words.forEach(word => {
      const lower = word.toLowerCase();
      if (trickySet.has(lower)) return;
      // Ealing review 2026-10-13: a cast name is no longer skipped — it must
      // decode with this book's GPCs like any other word, or be one of its
      // tricky words (Olive, before 've' is taught). properNouns is kept only
      // so the failure message can say it is a name.
      if (/'/.test(word)) { failures.push({ page: pageIdx + 1, word, reason: 'contraction/apostrophe not allowed' }); return; }
      const seg = segmentWord(lower, gpcSet);
      if (!seg.ok) {
        failures.push({ page: pageIdx + 1, word, reason: `${properNouns.has(word) ? 'character name — ' : ''}cannot decode from position ${seg.at} ("${lower.slice(seg.at)}")` });
        return;
      }
      for (const why of phaseFlags(word, seg.used, story)) failures.push({ page: pageIdx + 1, word, reason: why });
      // Alternative-reading tracking applies at every phase — "he"/"she"/"we"
      // (e said as /ee/) are exactly as premature in a Phase 2 story as in a
      // Phase 5 one. The one exemption is EARLY_HFW_OK: words the Reception
      // phase2-4 checks above already deliberately treat as whole-word
      // exceptions taught early (e.g. "put"), so they are not double-flagged.
      const altKey = EARLY_HFW_OK.has(lower) ? null : altWordMap().get(lower);
      if (altKey) {
        const taught = new Set((story.alternatives_available || []).map(a => a.toLowerCase()));
        if (!taught.has(altKey)) failures.push({ page: pageIdx + 1, word, reason: `uses an alternative reading ("${altKey}") not yet taught — add it to alternatives_available once taught` });
      }
      // b406c: the checks above only confirm the word SEGMENTS into taught
      // graphemes — not that reading them with their taught sounds actually
      // makes the word ("knot", "sure", "radio", "door" before 'oor'...).
      // EARLY_HFW_OK words are already whole-word taught exceptions (see its
      // definition above) exempted from the other letter-level checks in
      // this same function — soundCheck gets the same exemption for the same
      // reason ("is"/"his"/"has"/"as" are taught early with their spelling's
      // final 's' voiced, which is otherwise only tolerated in longer words;
      // "of"/"put" are genuinely irregular).
      if (!EARLY_HFW_OK.has(lower)) {
        const altsAvailable = new Set((story.alternatives_available || []).map(a => a.toLowerCase()));
        if (!soundCheck(word, gpcSet, altsAvailable, story.phase || 0)) {
          failures.push({ page: pageIdx + 1, word, reason: 'segments into taught graphemes but does not actually sound like the word at this phase (sound check failed)' });
        }
      }
    });
  });

  return { slug: story.slug, title: story.title, wordCount: pages.reduce((n, p) => n + tokenizeStoryText(p.text || '').length, 0), failures };
}

function main() {
  const args = process.argv.slice(2);
  const storiesDir = path.join(__dirname, '../../src/content/phonics/stories');
  let files;
  if (args[0] === '--all') {
    files = fs.readdirSync(storiesDir).filter(f => f.endsWith('.json')).map(f => path.join(storiesDir, f));
  } else if (args[0]) {
    files = [path.resolve(args[0])];
  } else {
    console.error('Usage: node validate-decodable.js <story.json> | --all');
    process.exit(2);
  }

  let anyFail = false;
  for (const file of files) {
    const story = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Phase 1 listening books are read TO the child — never meant to be decoded.
    if (story.read_aloud) { console.log(`· ${path.basename(file)} — ${story.title} — read-aloud (Phase 1), not checked`); continue; }
    const result = validateStory(story);
    if (result.failures.length) {
      anyFail = true;
      console.log(`✗ ${path.basename(file)} — ${result.title} (${result.wordCount} words) — ${result.failures.length} FAIL`);
      result.failures.forEach(f => console.log(`    page ${f.page}: "${f.word}" — ${f.reason}`));
    } else {
      console.log(`✓ ${path.basename(file)} — ${result.title} (${result.wordCount} words) — strictly decodable`);
    }
  }
  process.exit(anyFail ? 1 : 0);
}

// ---- b407b: shared "is this word genuinely usable at this point" gate -----
// Moved here (from check-programme.js, which re-derived it for banks) so the
// per-DAY lesson checks (lesson-data.js) and the per-WEEK bank checks share
// one definition instead of two copies drifting apart. gpcSet/altSet/
// trickySet are plain Sets of lowercase strings/keys; phase is a number.
// ---- Ealing review 2026-10-13: Phase 4 by word structure ------------------
// Phase 4 teaches no new GPCs: children blend adjacent consonants made of
// sounds they already know (DfE Note 1: /s/+/p/+/l/, not /spl/). The schedule
// orders it by word structure, as Letters and Sounds (2007) does: CVCC first
// (two consonants at the END: tent, milk), then CCVC (two at the START: stop,
// frog), then CCVCC and longer words. The structure is "unlocked" by the
// schedule adding the matching adjacent-consonant tokens to the taught set:
// any word-final pair (nd, nt...) => CVCC, any word-initial pair (st, bl...) =>
// CCVC. Before both are in, a word needing the missing one is not yet
// decodable — so "spot" can no longer turn up in the CVCC week.
const ONSET_PAIRS = new Set(['bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'tr']);
const CODA_PAIRS = new Set(['nd', 'nt', 'nk', 'ft', 'lt', 'lf']);
const isVowelToken = (t) => VOWEL_GPCS.has(t) || t.includes('-') || /^(ay|ou|ie|ea|oy|ir|ue|aw|ew|oe|au|eigh|ei|ey|ore|oor|our|are)$/.test(t);
function consonantRuns(used) {
  const toks = splitClusters(used || []);
  const isV = isVowelToken;
  let start = 0; while (start < toks.length && !isV(toks[start])) start++;
  let end = 0; let j = toks.length - 1;
  // a final plural/verb -s after a consonant is the -s ending, not a cluster (cats, digs)
  if (toks.length > 2 && toks[j] === 's' && !isV(toks[j - 1])) j--;
  while (j >= 0 && !isV(toks[j])) { end++; j--; }
  let vowels = 0, run = 0, internalMax = 0;
  for (let k = start; k < toks.length - end; k++) {
    if (isV(toks[k])) { vowels++; internalMax = Math.max(internalMax, run); run = 0; } else run++;
  }
  return { initial: start, final: end, toks, vowels, internalMax };
}
// Does a word show this week's Phase 4 word structure? (model words, bank quota)
const CONSONANT_DIGRAPH_TOKENS = new Set(['sh', 'ch', 'th', 'ng', 'ck']);
const LONG_VOWEL_TOKENS = new Set(['ai', 'ee', 'igh', 'oa', 'oo', 'ar', 'or', 'ur', 'ow', 'oi', 'ear', 'air', 'ure', 'er']);
function wordMatchesStructure(word, key, gpcSet) {
  const seg = segmentWord(String(word).toLowerCase(), gpcSet);
  if (!seg.ok) return false;
  const r = consonantRuns(seg.used);
  const adjacent = r.initial >= 2 || r.final >= 2 || r.internalMax >= 2;
  switch (key) {
    case 'cvcc': return r.vowels === 1 && r.initial <= 1 && r.final >= 2;
    case 'ccvc': return r.vowels === 1 && r.initial >= 2 && r.final <= 1;
    case 'ccvcc': return r.vowels === 1 && r.initial >= 2 && r.final >= 2;
    case 'two_syllables': return r.vowels >= 2 && adjacent;
    case 'with_digraphs': return adjacent && r.toks.some((t) => CONSONANT_DIGRAPH_TOKENS.has(t));
    case 'with_long_vowels': return adjacent && r.toks.some((t) => LONG_VOWEL_TOKENS.has(t));
    case 'three_consonants': return r.initial >= 3 || r.final >= 3;
    case 'longer_words': return r.vowels >= 2;
    default: return false;
  }
}
function structureFlag(word, used, gpcSet) {
  const lw = word.toLowerCase();
  if (EARLY_HFW_OK.has(lw)) return null;
  const hasOnset = [...gpcSet].some((g) => ONSET_PAIRS.has(g));
  const hasCoda = [...gpcSet].some((g) => CODA_PAIRS.has(g));
  if (hasOnset && hasCoda) return null;
  const r = consonantRuns(used);
  if (r.initial >= 2 && !hasOnset) return 'starts with two consonant sounds (CCVC) before that word shape is taught';
  if (r.final >= 2 && !hasCoda) return 'ends with two consonant sounds (CVCC) before that word shape is taught';
  return null;
}

function wordDecodableAt(word, gpcSet, trickySet, phase, altSet) {
  const lw = word.toLowerCase();
  if (trickySet.has(lw)) return true;
  const seg = segmentWord(lw, gpcSet);
  if (!seg.ok) return false;
  if (phaseFlags(word, seg.used, { phase, gpcs_available: Array.from(gpcSet) }).length) return false;
  if (phase === 4 && structureFlag(word, seg.used, gpcSet)) return false;
  const altKey = EARLY_HFW_OK.has(lw) ? null : altWordMap().get(lw);
  if (altKey && !altSet.has(altKey)) return false;
  if (!EARLY_HFW_OK.has(lw) && !soundCheck(word, gpcSet, altSet, phase)) return false;
  return true;
}

// Sound buttons for display: a Phase 4 adjacent-consonant cluster ("bl", "nd")
// is TWO sounds, so two buttons — s·a·n·d, never s·a·nd (review 2026-10-08).
// segmentWord keeps clusters as one token because the GPC catalog lists them.
let _clusters = null;
function splitClusters(used) {
  if (!_clusters) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/content/phonics/phase4-learning-gpc.json'), 'utf8'));
      const rows = Array.isArray(raw) ? raw : Object.values(raw).filter(Array.isArray).flat();
      _clusters = new Set(rows.map((r) => r.grapheme));
    } catch (_) { _clusters = new Set(); }
  }
  return (used || []).flatMap((t) => (_clusters.has(t) ? t.split('') : [t]));
}

// ---- review 2026-10-08: force the TARGET grapheme to win a display tie ----
// segmentWord() is a pure leftmost-longest matcher — for a word where the
// grapheme being taught today happens to overlap with an unrelated but also-
// taught grapheme at the same position ("school", teaching ch->/k/: "sc" is
// also a taught Phase 4 cluster starting at the very same letter, and wins
// the ambiguity, splitting into s·c·h instead of s·ch), plain segmentWord
// has no way to know which reading is the one actually being taught. This
// forces `preferred` (a literal grapheme, e.g. "ch") to match at its first
// occurrence, segmenting the letters before and after it normally, and
// falls back to plain segmentWord if that isn't possible (preferred isn't
// taught, isn't in the word, or the remainder doesn't segment).
function segmentPreferring(word, gpcSet, preferred) {
  const lw = String(word).toLowerCase();
  if (preferred && gpcSet.has(preferred)) {
    const idx = lw.indexOf(preferred);
    if (idx !== -1) {
      const before = segmentWord(lw.slice(0, idx), gpcSet);
      const after = segmentWord(lw.slice(idx + preferred.length), gpcSet);
      if (before.ok && after.ok) return { ok: true, used: [...before.used, preferred, ...after.used] };
    }
  }
  return segmentWord(lw, gpcSet);
}

if (require.main === module) main();
module.exports = { structureFlag, consonantRuns, wordMatchesStructure, ONSET_PAIRS, CODA_PAIRS, splitClusters, segmentWord, segmentPreferring, tokenizeStoryText, validateStory, phaseFlags, altWordMap, EARLY_HFW_OK, BATH_TRAP_WORDS, suffixDecompose, SUFFIX_TOKEN, SUFFIXABLE_VERB_ROOTS, SUFFIXABLE_ADJ_ROOTS, soundCheck, pronunciationsFor, wordDecodableAt, soundsLikeRealWord, GPC_BASE, primaryPhonesFor, phoneBase };
