'use strict';
/* Wren Phonics — shared assessment logic (b408, 2026-10-08).
 *
 * Required by BOTH the printable assessment generator (build-assessment.js)
 * and the app's assessment API (src/routes/phonics.js, via a relative require
 * — scripts/ is bind-mounted read-only into wren-ladn-dev next to src/, same
 * as editions/ and public/). Pure data/logic, no DB access, nothing invented:
 * every GPC/word/sentence comes from the b406 programme spine
 * (schedule.json + programme/banks/*.json), same as lesson-data.js.
 * provenance: Wren original, b408, 2026-10-08.
 */

const path = require('path');
const ld = require('./lesson-data');
const vd = require('./validate-decodable');
const { wordMatchesStructure } = vd;

// All GPCs a child's heatmap/placement can be tested against: the 102 Phase
// 2-6 catalog entries (phase2to5GpcsInOrder() in lesson-data.js deliberately
// stops at Phase 5 for the handbook's pronunciation guide; a heatmap needs
// Phase 6 suffixes/prefixes too) PLUS the 6 Phase 5b "alternative spelling"
// graphemes (eigh, ei, ey, ore, oor, our) — genuinely new graphemes that
// schedule.json's cumulative_gpcs already counts (see b406b's fix) but which
// live only in phase5b-alternatives-gpc.json, never in the phase2-6 GPC
// files. Without merging these in, computeStartingWeek() below silently
// stalls at Year 1 Spring 2 Week 3 for a child secure on everything, because
// no week past global_week 57 is ever satisfiable.
// A catalog code like "suffix_-ing"/"prefix_un-" is how schedule.json and the
// GPC catalog key a Phase 6 affix (so it matches segmentWord/schedule
// unambiguously) — never what a human should read. Same translation b407's
// build-lessons.js uses (displayGrapheme), reused here so every printable and
// the app's own chips show "-ing"/"un-", not the raw catalog key.
function displayGrapheme(g) {
  // 'oo_s' is an internal id (short /ʊ/ 'oo', as in 'book', vs the long 'oo' id)
  // — never print it raw (review 2026-10-08, b409 #2 / b410 #4/#20).
  if (g === 'oo_s') return 'oo (short, as in book)';
  if (String(g).includes('_') && !/^(suffix|prefix)_/.test(g)) {
    const e = (typeof ld !== 'undefined' ? ld.altEntry(g) : null);
    if (e && e.entry_type === 'alternative_spelling') return `${e.grapheme} (new way to spell ${e.target_phoneme})`;
    if (e) return `${e.grapheme} also says ${e.new_phoneme}`;
  }
  return String(g).replace(/^suffix_/, '').replace(/^prefix_/, '');
}

const ALT_SPELLING_RANK = 5.5;
let _ordered;
function gpcsOrdered() {
  if (_ordered) return _ordered;
  const base = Array.from(ld.gpcCatalog().values()).map((g) => ({ ...g, _rank: g.phase }));
  const altData = require(path.join(ld.CONTENT, 'phase5b-alternatives-gpc.json'));
  const extraSpellings = (altData.alternative_spellings || []).map((a, i) => ({
    grapheme: a.grapheme, phase: '5b', _rank: ALT_SPELLING_RANK, position_in_phase: i + 1,
    sound_type: a.sound_type, ipa: a.ipa, pronunciation_note: a.teaching_note,
    example_words: a.example_words, kind: 'alternative_spelling',
  }));
  _ordered = base.concat(extraSpellings)
    .sort((a, b) => (a._rank - b._rank) || ((a.position_in_phase || 0) - (b.position_in_phase || 0)))
    .map((g) => ({ ...g, display: displayGrapheme(g.grapheme) }));
  return _ordered;
}

// ---- b408b: PSC-quality nonsense words -------------------------------------
// Shared by the half-term assessments (below) AND the PSC-style practice
// checks (build-assessment.js) — b408's first pass sourced nonsense words
// straight from the teaching banks (programme/banks/*.json), which turned out
// to contain words like "zearh" (ends in the bare letter h — /h/ cannot
// close an English syllable), "weight"/"corer"/"bro" (real English words,
// just absent from the small hand-curated word list the bank generator
// checked against) and "bloo"/"laim" (not real SPELLINGS, but exact
// homophones of "blue"/"lame"). Fixing the shared bank generator itself was
// considered and rejected: the SAME nonsense words already flow into the
// (separately reviewed, already-accepted) b407 lesson/slide PDFs via
// lesson-data.js, so changing them here would silently desync paper already
// signed off — out of scope for "fix only the assessments". This generator
// is therefore assessment-only and never touches programme/banks/*.json.
//
// Deterministic by design, not just by convention: halfTermAssessmentContent
// below is called BOTH by the build script (to write the static JSON/PDF)
// AND live by the app route (GET /assessment/half-terms/:slug) — if the two
// ever produced different nonsense words, a practitioner ticking the app
// against a printed paper copy would be ticking against the wrong list. Every
// caller passes a `rand` from seededRandom(), keyed on something stable
// (half-term name, version number), never Math.random().
function seededRandom(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function rand() {
    h = Math.imul(h ^ (h >>> 16), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const PSC_CAST = ['Pip', 'Ned', 'Olive', 'Moss', 'Fig', 'Nell'];
// Onset/coda/vowel pools, same spirit as build-banks.js's own nonsense-word
// generator, but NOT shared code with it (see note above) and with the
// b408b-only fix applied directly: 'h' dropped from the coda pool. /h/, /v/,
// /j/, /w/ do not occur in English syllable codas and 'q' never appears
// without 'u' — none of the latter three were ever in this pool, only 'h'
// was (as a plain Phase 2 single-letter coda), which is exactly how "zearh"
// happened. ss/ll/ff/zz stay allowed — the four doubled letters actually
// TAUGHT as one grapheme — since a coda is always drawn as ONE whole
// grapheme from this pool, never synthesised by doubling, nothing else can
// ever double.
const PSC_ONSET = new Set(['s', 't', 'p', 'n', 'm', 'd', 'g', 'c', 'k', 'h', 'b', 'f', 'l', 'r', 'j', 'v', 'w', 'y', 'z', 'qu', 'ch', 'sh', 'th']);
const PSC_ONSET_CLUSTERS = new Set(['bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'tr']);
const PSC_CODA = new Set(['s', 't', 'p', 'n', 'm', 'd', 'g', 'k', 'ck', 'b', 'f', 'ff', 'l', 'll', 'r', 'x', 'z', 'zz', 'ch', 'sh', 'th', 'ng', 'ss']);
const PSC_CODA_CLUSTERS = new Set(['nd', 'nt', 'nk', 'ft', 'lt', 'lf']);
// Review 2026-10-08: only the vowel spellings the real check's content domain lists
// (research §3) — no eigh/ei/ey/ore/oor/our/ure/ear/oe ("geighf", "zeighz").
const PSC_VOWEL_FULL = new Set(['a', 'e', 'i', 'o', 'u', 'ai', 'ee', 'igh', 'oa', 'oo', 'ar', 'or', 'ur', 'ow', 'oi', 'air', 'er', 'ay', 'ou', 'ie', 'ea', 'oy', 'ir', 'ue', 'ew', 'au', 'aw']);
// Section 1 of the real check uses single letters plus these only (research §3).
const PSC_SECTION1_GPCS = new Set('abcdefghijklmnoprstuvwxyz'.split('').concat(['ar', 'ch', 'ck', 'ee', 'ff', 'll', 'ng', 'oi', 'oo', 'or', 'qu', 'sh', 'ss', 'th', 'zz']));
// "Clean" = simple CV/CVC only, no clusters, no exotic vowel digraphs/
// trigraphs — used for the chunks a 2-syllable word is built from (section 2
// of the PSC-style practice check) so the join reads as two plain syllables,
// never a consonant pile-up or an awkward vowel-vowel boundary.
const PSC_VOWEL_CLEAN = new Set(['a', 'e', 'i', 'o', 'u', 'ai', 'ee', 'oa', 'oo', 'ar', 'or', 'ur', 'ow', 'oi']);
const PSC_VOWEL_SAFE_WITH_CLUSTER = new Set(['a', 'e', 'i', 'o', 'u', 'ai', 'ee', 'oa', 'oo', 'ar', 'or', 'ur', 'ow', 'oi', 'ea', 'ir']);

function splitPscPools(gpcSet, clean) {
  const vowels = [], onset = [], coda = [], onsetCl = [], codaCl = [];
  const vowelSet = clean ? PSC_VOWEL_CLEAN : PSC_VOWEL_FULL;
  for (const g of gpcSet) {
    const lg = String(g).toLowerCase();
    if (vowelSet.has(lg)) vowels.push(lg);
    if (PSC_ONSET.has(lg)) onset.push(lg);
    if (PSC_CODA.has(lg)) coda.push(lg);
    if (!clean && PSC_ONSET_CLUSTERS.has(lg)) onsetCl.push(lg);
    if (!clean && PSC_CODA_CLUSTERS.has(lg)) codaCl.push(lg);
  }
  return { vowels, onset, coda, onsetCl, codaCl };
}

// "Common word" source for the near-miss ("one letter off") check: every
// real_word actually taught across the whole programme (reception + year1
// banks) — already loaded by lesson-data.js for other purposes, so this adds
// no new file reads. Deliberately NOT the full ~130k-word cmudict: almost any
// short CVC shape is one letter from SOME obscure dictionary entry, which
// would make generation impossibly strict; "common" here means "a word this
// programme actually teaches a 5-6-year-old", which is the one a near-miss
// could genuinely be confused with.
let _commonWords, _commonByLen;
function commonWordSet() {
  if (_commonWords) return { words: _commonWords, byLen: _commonByLen };
  _commonWords = new Set();
  for (const w of ld.allWeeks()) {
    if (w.role === 'review') continue;
    const bank = ld.bankBySlug(w.slug);
    if (!bank) continue;
    for (const item of (bank.real_words || [])) {
      const word = (typeof item === 'string' ? item : item.word || '').toLowerCase();
      if (word) _commonWords.add(word);
    }
  }
  _commonByLen = new Map();
  for (const word of _commonWords) {
    if (!_commonByLen.has(word.length)) _commonByLen.set(word.length, []);
    _commonByLen.get(word.length).push(word);
  }
  return { words: _commonWords, byLen: _commonByLen };
}
function editDistanceAtMost1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length === l.length) {
    let diff = 0;
    for (let i = 0; i < s.length; i++) if (s[i] !== l[i]) diff++;
    return diff <= 1;
  }
  let i = 0, j = 0, diffs = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; } else { diffs++; j++; if (diffs > 1) return false; }
  }
  return true;
}
function nearCommonWord(word) {
  const { byLen } = commonWordSet();
  for (const len of [word.length - 1, word.length, word.length + 1]) {
    for (const w of byLen.get(len) || []) if (editDistanceAtMost1(word, w)) return true;
  }
  return false;
}

// A candidate word (already segmented) is a valid PSC-style nonsense word
// only once it clears every rule in the brief: pronounceable (the caller's
// segmentWord already established this), not a real word (cmudict), not a
// homophone of one (soundsLikeRealWord), not one letter off a taught word,
// and not one of the six cast names.
function isValidPscNonsenseWord(word, seg) {
  if (!seg || !seg.ok) return false;
  if (PSC_CAST.some((c) => c.toLowerCase() === word)) return false;
  if (vd.pronunciationsFor(word).length) return false;
  if (commonWordSet().words.has(word)) return false;
  if (nearCommonWord(word)) return false;
  if (vd.soundsLikeRealWord(seg.used)) return false;
  // English only doubles ff/ll/ss/zz (and uses ck) straight after a short single
  // vowel letter — "lurss", "pewss", "yieff" are not spellings (review 2026-10-08).
  const u = seg.used;
  if (u.length >= 2 && SHORT_VOWEL_ONLY_CODA.has(u[u.length - 1]) && !/^[aeiou]$/.test(u[u.length - 2])) return false;
  return true;
}
const SHORT_VOWEL_ONLY_CODA = new Set(['ff', 'll', 'ss', 'zz', 'ck']);

// One PSC-style nonsense word from the given cumulative GPC set. `clean`
// restricts to simple CV/CVC shapes (see PSC_VOWEL_CLEAN above); `rand` is a
// seededRandom() generator (never Math.random — see the determinism note
// above); `used` is a Set this call both reads (to avoid a repeat) and
// mutates (to record its pick) — the same Set threaded across every word in
// one document, exactly as build-banks.js's own generator does.
function generatePscNonsenseWord(gpcSet, { clean, rand, used }) {
  const { vowels, onset, coda, onsetCl, codaCl } = splitPscPools(gpcSet, clean);
  if (!vowels.length || !onset.length) return null;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let guard = 0; guard < 500; guard++) {
    const useOnsetCluster = !clean && onsetCl.length && guard % 5 === 0;
    const useCodaCluster = !clean && codaCl.length && guard % 7 === 0 && !useOnsetCluster;
    const vowelPool = (useOnsetCluster || useCodaCluster) ? vowels.filter((v) => PSC_VOWEL_SAFE_WITH_CLUSTER.has(v)) : vowels;
    if (!vowelPool.length) continue;
    const onsetG = useOnsetCluster ? pick(onsetCl) : pick(onset);
    const nucleus = pick(vowelPool);
    const wantsCoda = clean ? guard % 2 === 0 : (guard % 3 !== 2 || useCodaCluster);
    const codaG = useCodaCluster ? pick(codaCl) : (coda.length ? pick(coda) : null);
    if (codaG && nucleus.endsWith(codaG)) continue; // e.g. "ar" + "r" -> "arr"
    const graphemes = (!wantsCoda || !codaG) ? [onsetG, nucleus] : [onsetG, nucleus, codaG];
    const word = graphemes.join('');
    if (word.length < 3 || word.length > 7) continue;
    const seg = vd.segmentWord(word, gpcSet);
    if (!seg.ok) continue;
    if (used.has(word)) continue;
    if (!isValidPscNonsenseWord(word, seg)) continue;
    used.add(word);
    return { word, sound_buttons: seg.used };
  }
  return null;
}
function generatePscNonsenseWords(gpcSet, count, opts) {
  const out = [];
  for (let i = 0; i < count * 25 && out.length < count; i++) {
    const w = generatePscNonsenseWord(gpcSet, opts);
    if (w) out.push(w);
  }
  return out;
}

// The 12 half-terms (6 Reception + 6 Year 1) in teaching order, each tagged
// with its own review week (where a half-term assessment is taken) and that
// week's end-of-half-term cumulative GPC/tricky-word sets.
function halfTerms() {
  const s = ld.schedule();
  const out = [];
  for (const yearKey of ['reception', 'year1']) {
    for (const ht of s[yearKey].half_terms) {
      const reviewWeek = ht.weeks.find((w) => w.role === 'review') || ht.weeks[ht.weeks.length - 1];
      out.push({
        year_key: yearKey,
        year_name: s[yearKey].year,
        half_term: ht.name,
        slug: `${yearKey}-${ld.halfTermSlug(ht.name)}`,
        review_week: reviewWeek.week,
        review_global_week: reviewWeek.global_week,
        is_psc_review_block: !!reviewWeek.is_psc_review_block,
        cumulative_gpcs: reviewWeek.cumulative_gpcs || [],
        cumulative_alternatives: reviewWeek.cumulative_alternatives || [],
        cumulative_tricky_words: reviewWeek.cumulative_tricky_words || [],
      });
    }
  }
  return out;
}
function halfTermBySlug(slug) { return halfTerms().find((h) => h.slug === slug) || null; }

// Every tricky word (Phase 2/3/4 + Year 1 + Year 2), in catalog order — the
// Map lesson-data.js builds preserves insertion order (file order, which is
// already teaching order), so no re-sort is needed.
function trickyWordsOrdered() { return Array.from(ld.trickyCatalog().values()); }

// What's actually NEW in a half term — its own teaching weeks (1-5), not the
// review week — which is what a half-term assessment should test, not the
// whole cumulative list (that's every earlier half-term's job already).
function halfTermNewContent(yearKey, halfTermName) {
  const s = ld.schedule();
  const ht = s[yearKey].half_terms.find((h) => h.name === halfTermName);
  if (!ht) return { gpcs: [], alternatives: [], tricky_words: [] };
  const gpcs = [], alts = [], tricky = [];
  const seenG = new Set(), seenA = new Set(), seenT = new Set();
  for (const w of ht.weeks) {
    if (w.role === 'review') continue;
    for (const g of (w.new_gpcs || [])) if (!seenG.has(g)) { seenG.add(g); gpcs.push(g); }
    for (const a of (w.new_alternatives || [])) if (!seenA.has(a.key)) { seenA.add(a.key); alts.push(a.key); }
    for (const t of (w.new_tricky_words || [])) if (!seenT.has(t)) { seenT.add(t); tricky.push(t); }
  }
  return { gpcs, alternatives: alts, tricky_words: tricky };
}

// The words/nonsense-words/tricky-words/sentence a half-term assessment uses —
// pulled straight from that half-term's own banks (resolveBank() on the review
// week already resolves to the UNION of its weeks 1-4 banks — see
// lesson-data.js), every one already machine-validated by
// build-banks.js/check-programme.js. Nothing here is newly generated.
function halfTermAssessmentContent(yearKey, halfTermName) {
  const weeks = ld.allWeeks().filter((w) => w.year_key === yearKey && w.half_term === halfTermName);
  const reviewWeek = weeks.find((w) => w.role === 'review') || weeks[weeks.length - 1];
  const bank = ld.resolveBank(reviewWeek, yearKey, halfTermName)
    || { real_words: [], nonsense_words: [], dictation_sentences: [], phrases: [] };
  const newContent = halfTermNewContent(yearKey, halfTermName);
  const newSet = new Set([...newContent.gpcs, ...newContent.alternatives]);
  // Phase 4 half-terms (2026-10-13): no new GPCs — favour words with the half-term's word shapes.
  const shapes = weeks.flatMap((w) => w.new_structures || []);
  const htGpcs = new Set((reviewWeek.cumulative_gpcs || []).map((g) => g.toLowerCase()));
  const usesNew = (w) => (w.sound_buttons || []).some((s) => newSet.has(s)) || shapes.some((k) => wordMatchesStructure(w.word, k, htGpcs));
  const realWords = bank.real_words || [];
  const newWords = realWords.filter(usesNew).map((w) => w.word);
  const prioritised = realWords.filter(usesNew).concat(realWords.filter((w) => !usesNew(w)));
  const words = prioritised.slice(0, 12).map((w) => w.word);
  // Nonsense words are only non-empty from Year 1 Spring 1 onward — same
  // gating build-banks.js's own generator uses (settled on the content, not
  // re-decided here). b408b: generated FRESH here (never read from
  // bank.nonsense_words — see the generator's own note above) so a half-term
  // assessment tests genuinely unseen pseudo-words, not ones a child may
  // already have met on a flashcard — closer to how the real PSC works, and
  // the reason this was changed, not just a quality fix in passing.
  const wantsNonsense = yearKey === 'year1' && ['Spring 1', 'Spring 2', 'Summer 1', 'Summer 2'].includes(halfTermName);
  const nonsenseWords = wantsNonsense
    ? generatePscNonsenseWords(new Set((reviewWeek.cumulative_gpcs || []).map((g) => g.toLowerCase())), 6, {
      clean: false, rand: seededRandom(`half-term-${yearKey}-${halfTermName}`), used: new Set(),
    }).map((w) => w.word)
    : [];
  const trickyWords = [...newContent.tricky_words];
  if (trickyWords.length < 3) {
    const known = (reviewWeek.cumulative_tricky_words || []).filter((w) => !trickyWords.includes(w));
    trickyWords.push(...known.slice(0, 3 - trickyWords.length));
  }
  // Prefer a sentence that actually exercises one of THIS half-term's own
  // NEW-content words (newWords, length >= 3 so "a"/"at"/"is" don't trivially
  // match nearly every sentence) — a bare "first sentence with a space"
  // picked whichever review/consolidation week happened to be unioned in
  // first, which for some half-terms (e.g. Year 1 Summer 2 weeks 1/3) is
  // every one of its own trivial early-Reception review sentences, with the
  // real suffix-rich sentences only in weeks 2/4 — caught on the PDF review
  // (first fix attempt matched on "a" and still picked "A cat sat.").
  const sentences = (bank.dictation_sentences || []).filter((s) => s.trim().includes(' '));
  const matchWords = newWords.filter((w) => w.length >= 3);
  const sentence = sentences.find((s) => matchWords.some((w) => new RegExp('\\b' + w + '\\b', 'i').test(s)))
    || sentences.find((s) => words.some((w) => w.length >= 3 && new RegExp('\\b' + w + '\\b', 'i').test(s)))
    || sentences[0] || (bank.dictation_sentences || [])[0] || null;
  return {
    gpcs: newContent.gpcs, alternatives: newContent.alternatives,
    words, nonsense_words: nonsenseWords, tricky_words: trickyWords, sentence,
    review_global_week: reviewWeek.global_week,
  };
}

// Placement result: given the grapheme codes a child can securely read,
// find the right global_week to start teaching at — the week right after the
// last one whose ENTIRE cumulative_gpcs requirement the child already covers.
// cumulative_gpcs only ever grows week to week, so walking forward and taking
// the last satisfied week is sufficient (no need to re-check earlier weeks).
function computeStartingWeek(secureGpcSet) {
  const weeks = ld.allWeeks();
  let last = null;
  for (const w of weeks) {
    const need = w.cumulative_gpcs || [];
    if (need.length && need.every((g) => secureGpcSet.has(g))) last = w;
  }
  if (!last) {
    const first = weeks[0];
    return {
      year_key: first.year_key, half_term: first.half_term, week: first.week,
      global_week: first.global_week, label: `${first.year_name} ${first.half_term} Week ${first.week}`,
    };
  }
  const idx = weeks.findIndex((w) => w.global_week === last.global_week);
  const next = weeks[idx + 1];
  if (!next) {
    return {
      year_key: null, half_term: null, week: null, global_week: null,
      label: 'Ready for Year 2 — secure on every GPC this programme teaches.',
    };
  }
  return {
    year_key: next.year_key, half_term: next.half_term, week: next.week,
    global_week: next.global_week, label: `${next.year_name} ${next.half_term} Week ${next.week}`,
  };
}

// Matching-grid rule (half-term assessment): a GPC tested more than once in
// its half-term keeps its best-known result; one rule, used identically on
// the printable matching grid and the app's own scoring. Not DfE wording —
// Wren's own.
const MATCH_RULE = [
  ['secure', 'Read it straightaway, no hesitation, in at least one of the places it was tested this half term.'],
  ['keep_up', 'Got there with a pause, a self-correct, or needed a second try — practise daily in Same-day boost, do not re-teach from scratch.'],
  ['re_teach', 'Could not read it, or said a different sound, every time it was tested this half term — plan it back into direct teaching.'],
];

// The taught set narrowed to what section 1 of the real check uses (clusters kept).
function pscSection1Set(gpcSet) {
  return new Set([...gpcSet].filter((g) => PSC_SECTION1_GPCS.has(g) || PSC_ONSET_CLUSTERS.has(g) || PSC_CODA_CLUSTERS.has(g)));
}

module.exports = {
  pscSection1Set,
  gpcsOrdered, trickyWordsOrdered, halfTerms, halfTermBySlug, halfTermNewContent,
  halfTermAssessmentContent, computeStartingWeek, MATCH_RULE, displayGrapheme,
  seededRandom, generatePscNonsenseWords, isValidPscNonsenseWord, commonWordSet,
};
