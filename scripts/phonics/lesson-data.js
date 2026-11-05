'use strict';
/* Wren Phonics — shared data loader for the lesson-plan / handbook / slide
 * generators (b407, 2026-10-07).
 *
 * Nothing here invents content. Every word, mnemonic, tip and sentence comes
 * from the b406 content pack + programme spine; this module only joins those
 * files together and re-derives sound buttons for strings (dictation
 * sentences, phrases) that the banks store as plain text. provenance: Wren
 * original, b407, 2026-10-07.
 */

const fs = require('fs');
const path = require('path');
const { segmentWord, wordDecodableAt, suffixDecompose, SUFFIX_TOKEN, splitClusters, wordMatchesStructure } = require('./validate-decodable');

const CONTENT = path.join(__dirname, '../../src/content/phonics');
const PROGRAMME = path.join(CONTENT, 'programme');
const BANKS_DIR = path.join(PROGRAMME, 'banks');

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ---- GPC catalog (phases 2-6), keyed by grapheme ----------------------------
const GPC_FILES = [
  ['phase2-learning-gpc.json', 2],
  ['phase3-learning-gpc.json', 3],
  ['phase4-learning-gpc.json', 4],
  ['phase5-school-readiness-gpc.json', 5],
  ['phase6-school-readiness-gpc.json', 6],
];
let _gpcByGrapheme;
function gpcCatalog() {
  if (_gpcByGrapheme) return _gpcByGrapheme;
  _gpcByGrapheme = new Map();
  for (const [file] of GPC_FILES) {
    for (const entry of readJSON(path.join(CONTENT, file))) {
      _gpcByGrapheme.set(entry.grapheme, entry);
    }
  }
  return _gpcByGrapheme;
}
function gpcEntry(grapheme) { return gpcCatalog().get(grapheme) || null; }

// ---- letter formation rhymes (b421) — single lowercase letters only --------
let _lettersByGrapheme;
function lettersCatalog() {
  if (!_lettersByGrapheme) {
    const data = readJSON(path.join(PROGRAMME, 'handwriting', 'letters.json'));
    _lettersByGrapheme = new Map(data.lowercase.map((l) => [l.grapheme, l]));
  }
  return _lettersByGrapheme;
}
function letterRhyme(grapheme) {
  if (String(grapheme).length !== 1) return null;
  const e = lettersCatalog().get(grapheme);
  return e ? e.rhyme : null;
}

// All phase 2-5 GPCs in catalog order (phase then position_in_phase) — used by
// the handbook's pronunciation guide. Phase 6 (suffixes/prefixes) and phase 5b
// (alternatives) are deliberately excluded; the brief asks for "every Phase
// 2-5 GPC" specifically.
function phase2to5GpcsInOrder() {
  const out = [];
  for (const [file, phase] of GPC_FILES) {
    if (phase > 5) continue;
    for (const entry of readJSON(path.join(CONTENT, file))) out.push(entry);
  }
  return out.sort((a, b) => (a.phase - b.phase) || (a.position_in_phase - b.position_in_phase));
}

// ---- Phase 5b alternatives, keyed the same way schedule.json's
// new_alternatives[].key / cumulative_alternatives[] entries are keyed:
// alternative_pronunciation -> "<grapheme>_<new_phoneme letters>"
// alternative_spelling      -> "<grapheme>" ----------------------------------
let _altByKey;
function altCatalog() {
  if (_altByKey) return _altByKey;
  _altByKey = new Map();
  const data = readJSON(path.join(CONTENT, 'phase5b-alternatives-gpc.json'));
  for (const entry of data.alternative_pronunciations || []) {
    const key = `${entry.grapheme}_${(entry.new_phoneme || '').replace(/[^a-z]/gi, '').toLowerCase()}`;
    _altByKey.set(key, entry);
  }
  for (const entry of data.alternative_spellings || []) {
    _altByKey.set(entry.grapheme, entry);
  }
  return _altByKey;
}
function altEntry(key) { return altCatalog().get(key) || null; }

// ---- Phase 4 word structures (Ealing review 2026-10-13) --------------------
// Phase 4 teaches no new GPCs; each teach week introduces one word structure
// (CVCC, CCVC, ...) — schedule.json new_structures[] keys into this catalog.
let _structByKey;
function structureCatalog() {
  if (!_structByKey) {
    _structByKey = new Map(readJSON(path.join(CONTENT, 'phase4-word-structures.json')).structures.map((x) => [x.key, x]));
  }
  return _structByKey;
}
function structureEntry(key) { return structureCatalog().get(key) || null; }

// ---- Tricky words (phase 2/3/4 + Year 1 + Year 2), keyed lowercase ----------
const TRICKY_FILES = [
  'tricky-words-phase2.json', 'tricky-words-phase3.json', 'tricky-words-phase4.json',
  'tricky-words-year1.json', 'tricky-words-year2.json',
];
let _trickyByWord;
function trickyCatalog() {
  if (_trickyByWord) return _trickyByWord;
  _trickyByWord = new Map();
  for (const file of TRICKY_FILES) {
    for (const entry of readJSON(path.join(CONTENT, file))) {
      _trickyByWord.set(entry.word.toLowerCase(), entry);
    }
  }
  return _trickyByWord;
}
function trickyEntry(word) { return trickyCatalog().get(String(word).toLowerCase()) || null; }

// ---- Story-cast proper nouns ------------------------------------------------
// Ealing review 2026-10-13: names are no longer exempt sight words. A name is
// usable only once it decodes with the sounds taught (Pip, Ned, Moss, Fig,
// Nell) or is a taught tricky word (Olive). castNames()/isCastName() remain
// for display (capital letters) and for "does this sentence showcase the
// sound" checks, never as a decodability pass.
let _castNames;
function castNames() {
  if (_castNames) return _castNames;
  const data = readJSON(path.join(CONTENT, 'characters.json'));
  _castNames = new Set(data.characters.map((c) => c.name));
  return _castNames;
}
function isCastName(word) { return castNames().has(String(word)); }

// ---- Phase 1 (Introduction) aspects, for the Reception settling week -------
function phase1Aspects() { return readJSON(path.join(CONTENT, 'phase1-introduction.json')); }

// ---- Schedule ----------------------------------------------------------------
function schedule() { return readJSON(path.join(PROGRAMME, 'schedule.json')); }

function halfTermSlug(name) { return name.toLowerCase().replace(/\s+/g, ''); }
function weekSlug(yearKey, halfTermName, weekNum) {
  return `${yearKey}-${halfTermSlug(halfTermName)}-w${weekNum}`;
}

// Every week across Reception + Year 1, flattened, each tagged with its
// yearKey ('reception'|'year1') and a resolvable slug.
function allWeeks() {
  const s = schedule();
  const out = [];
  for (const yearKey of ['reception', 'year1']) {
    for (const ht of s[yearKey].half_terms) {
      for (const w of ht.weeks) {
        out.push({ ...w, year_key: yearKey, year_name: s[yearKey].year, slug: weekSlug(yearKey, ht.name, w.week) });
      }
    }
  }
  return out;
}

// ---- Banks -------------------------------------------------------------------
let _bankCache = new Map();
function bankBySlug(slug) {
  if (_bankCache.has(slug)) return _bankCache.get(slug);
  const file = path.join(BANKS_DIR, `${slug}.json`);
  const bank = fs.existsSync(file) ? readJSON(file) : null;
  _bankCache.set(slug, bank);
  return bank;
}

// A "teach" week with new content has its own bank. Consolidation/review
// weeks and the Reception settling week don't (b406 design — see
// b406-phonics-spine.NOTES.md §3): resolve them to the UNION of whichever of
// that half-term's weeks 1-4 have banks, so every lesson still only ever uses
// already-validated words. Returns { real_words, nonsense_words,
// dictation_sentences, phrases } (deduplicated by word/sentence text).
function resolveBank(week, yearKey, halfTermName) {
  const own = bankBySlug(week.slug || weekSlug(yearKey, halfTermName, week.week));
  if (own) return own;
  const parts = [];
  for (let w = 1; w <= 4; w++) {
    const b = bankBySlug(weekSlug(yearKey, halfTermName, w));
    if (b) parts.push(b);
  }
  if (!parts.length) return null;
  const dedupe = (arr, keyFn) => { const seen = new Set(); return arr.filter((x) => { const k = keyFn(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  return {
    slug: `${weekSlug(yearKey, halfTermName, week.week)}--consolidated`,
    real_words: dedupe(parts.flatMap((p) => p.real_words || []), (x) => x.word),
    nonsense_words: dedupe(parts.flatMap((p) => p.nonsense_words || []), (x) => x.word),
    dictation_sentences: dedupe(parts.flatMap((p) => p.dictation_sentences || []), (x) => x),
    phrases: dedupe(parts.flatMap((p) => p.phrases || []), (x) => x),
  };
}

// ---- Book plan (which decodable book matches which week) -------------------
let _bookByGlobalWeek;
function bookPlan() { return readJSON(path.join(PROGRAMME, 'book-plan.json')); }
function bookForGlobalWeek(globalWeek) {
  if (!_bookByGlobalWeek) {
    _bookByGlobalWeek = new Map();
    const bp = bookPlan();
    for (const b of bp.existing_books) _bookByGlobalWeek.set(b.assigned_global_week, { title: b.title, status: 'shipped' });
    for (const s of bp.planned_slots) {
      if (!_bookByGlobalWeek.has(s.global_week)) {
        // No internal slot id on anything printed (b407b) — title is null
        // until a real book exists; printing code shows a plain fallback
        // line instead, which starts resolving to the real title
        // automatically once b412+ write the book and bookPlan gains it as
        // an existing_books entry.
        _bookByGlobalWeek.set(s.global_week, { title: null, status: 'planned', premise: s.premise });
      }
    }
  }
  return _bookByGlobalWeek.get(globalWeek) || null;
}

// ---- Day-plan parsing --------------------------------------------------------
// day_plan values are always one of: `New: "X". ...`, `Consolidate this
// week's...`, `Review day: ...` / `Review and assessment: ...`, or `No new
// content...`. Parsing the authored text (rather than re-deriving pacing
// from new_gpcs.length) keeps this generator faithful to whichever day the
// schedule actually put each item on.
const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
function parseDayPlan(week) {
  const days = [];
  for (const day of DAY_ORDER) {
    const text = (week.day_plan || {})[day] || '';
    const newMatch = /New:\s*"([^"]+)"/.exec(text);
    let kind;
    if (newMatch) kind = 'new';
    else if (/^Review/.test(text)) kind = 'review';
    else if (/^Consolidate/.test(text) || /^No new content/.test(text)) {
      // "No new content" covers both the Reception settling week (Phase 1,
      // no letters at all) and the Year 1 PSC-review block (letters already
      // known, revisiting less-common GPCs at speed) — same sentence, two
      // very different lessons, so disambiguate from the week's own flags
      // rather than the text.
      if (week.is_settling_week) kind = 'settle';
      else if (week.is_psc_review_block) kind = 'psc';
      else kind = 'consolidate';
    } else kind = 'consolidate';
    days.push({ day, text, kind, newItem: newMatch ? newMatch[1] : null });
  }
  return days;
}

// The week's new-content list in the order the "New:" days introduce them —
// a week only ever has new_gpcs OR new_alternatives populated, never both.
function newContentKeys(week) {
  if (week.new_structures && week.new_structures.length) return week.new_structures;
  return (week.new_gpcs && week.new_gpcs.length) ? week.new_gpcs : (week.new_alternatives || []).map((a) => a.key);
}

// Resolve a day's `newItem` (the literal grapheme string from day_plan, e.g.
// "o" which is ambiguous between o_oa/o_u) to the correct catalog entry by
// walking the week's ordered new-content list in lockstep with the ordered
// "New:" days — not by grapheme lookup alone.
function resolveNewContentForDays(week) {
  const days = parseDayPlan(week);
  const keys = newContentKeys(week);
  let ki = 0;
  for (const d of days) {
    if (d.kind !== 'new') continue;
    d.contentKey = keys[ki++] || d.newItem;
  }
  return days;
}

// ---- Sound buttons for arbitrary text (dictation sentences / phrases) ------
// Tricky words are shown as whole words (DfE Note 2: read-then-spell, not
// decoded), never sound-buttoned. Returns [{ word, segs: string[]|null }].
function soundButtonsForText(text, cumulativeGpcs) {
  const gpcSet = new Set((cumulativeGpcs || []).map((g) => g.toLowerCase()));
  const tokens = text.match(/[A-Za-z']+/g) || [];
  return tokens.map((tok) => {
    // A tricky word (including Olive's name before 've' is taught) is read as a
    // whole word with its tricky part — never sound-buttoned (DfE Note 2).
    if (trickyEntry(tok) && !(isCastName(tok) && segmentWord(tok.toLowerCase(), gpcSet).ok && gpcSet.has('ve'))) return { word: tok, segs: null, tricky: true, properNoun: isCastName(tok) };
    const r = segmentWord(tok.toLowerCase(), gpcSet);
    return { word: tok, segs: r.ok ? splitClusters(r.used) : null, tricky: false, properNoun: isCastName(tok) };
  });
}

// What was already cumulative BEFORE this week started (for "revisit" warm-up
// flashcards) — week.cumulative_gpcs is an end-of-week snapshot that already
// includes this week's own new content, which is the right set for deciding
// whether a model word is decodable, but the wrong set for "what to revisit
// before today's new sound".
let _cumBeforeByGlobalWeek;
function cumulativeGpcsBeforeWeek(week) {
  if (!_cumBeforeByGlobalWeek) {
    _cumBeforeByGlobalWeek = new Map();
    for (const w of allWeeks()) _cumBeforeByGlobalWeek.set(w.global_week, w.cumulative_gpcs || []);
  }
  return _cumBeforeByGlobalWeek.get(week.global_week - 1) || [];
}

// Sound buttons for a single word (lowercase comparison; returns null if the
// word can't be fully segmented against the given cumulative GPC set).
function segsForWord(word, cumulativeGpcs) {
  const gpcSet = new Set((cumulativeGpcs || []).map((g) => g.toLowerCase()));
  const r = segmentWord(String(word).toLowerCase(), gpcSet);
  return r.ok ? r.used : null;
}

// ---- b407b: per-DAY availability ------------------------------------------
// The b407 generator picked model words / word lists / captions from the
// WEEK's resolved bank regardless of which day within the week it was —
// Monday's "s" lesson could list "sat" and "tap" even though "a"/"t"/"p"
// aren't taught until Tue/Wed/Thu. These re-derive what's actually known as
// of a given day (not the week's end-state), the same "test consumers, not
// round trips" approach as check-programme.js's bank re-check, sharing its
// exact decodability gate (validate-decodable.js's wordDecodableAt).

let _cumAltBeforeByGlobalWeek;
function cumulativeAltKeysBeforeWeek(week) {
  if (!_cumAltBeforeByGlobalWeek) {
    _cumAltBeforeByGlobalWeek = new Map();
    for (const w of allWeeks()) _cumAltBeforeByGlobalWeek.set(w.global_week, w.cumulative_alternatives || []);
  }
  return _cumAltBeforeByGlobalWeek.get(week.global_week - 1) || [];
}

let _cumTrickyBeforeByGlobalWeek;
function cumulativeTrickyWordsBeforeWeek(week) {
  if (!_cumTrickyBeforeByGlobalWeek) {
    _cumTrickyBeforeByGlobalWeek = new Map();
    for (const w of allWeeks()) _cumTrickyBeforeByGlobalWeek.set(w.global_week, w.cumulative_tricky_words || []);
  }
  return _cumTrickyBeforeByGlobalWeek.get(week.global_week - 1) || [];
}

// Phase tag for a day-level (partial) GPC set, same purpose as
// check-programme.js's phaseTagFor but reusing the GPC catalog's own `phase`
// field already in memory here instead of rebuilding separate phase sets.
function phaseTagForGpcs(gpcs) {
  let max = 2;
  for (const g of gpcs) {
    const entry = gpcEntry(g);
    if (entry && entry.phase > max) max = entry.phase;
  }
  return max;
}

// Builds, for each day in `days` (the output of resolveNewContentForDays),
// what's available BEFORE that day starts (for warm-up/revisit — excludes
// today's own new content) and THROUGH that day (after today's teaching —
// what Have a go / Use it / model words may draw on). A week only ever
// teaches new_gpcs OR new_alternatives, never both — mirrors newContentKeys.
function dayAvailability(week, days) {
  const isAltWeek = (week.new_alternatives || []).length > 0;
  const gpcs = new Set(cumulativeGpcsBeforeWeek(week).map((g) => g.toLowerCase()));
  const alts = new Set(cumulativeAltKeysBeforeWeek(week));
  const tricky = new Set(cumulativeTrickyWordsBeforeWeek(week).map((w) => w.toLowerCase()));
  const weekTricky = (week.new_tricky_words || []).map((w) => w.toLowerCase());
  let trickyIntroduced = false;
  const out = [];
  for (const d of days) {
    const before = { gpcs: new Set(gpcs), alts: new Set(alts), tricky: new Set(tricky) };
    before.phase = phaseTagForGpcs(before.gpcs);
    if (d.kind === 'new' && d.contentKey) {
      // An "alternative_spelling" (eigh, ei, ey, ore, oor, our) is a brand-new
      // literal GRAPHEME for an already-taught sound — it has to go into
      // `gpcs` (segmentWord/soundCheck's GPC_BASE has a literal entry for
      // it) or it can never be matched in a real word's spelling at all
      // ("they" stays th-e-y forever). Only a true "alternative_pronunciation"
      // (the composite "ch_k"/"y_igh" keys, never a literal substring of any
      // word) belongs in `alts` (review 2026-10-08 — these were conflated,
      // which is why eigh/ei/ey/ore/oor/our never got model words either).
      const entry = altEntry(d.contentKey);
      const st = structureEntry(d.contentKey);
      if (st) { for (const g of st.unlocks || []) gpcs.add(g); }
      else if (isAltWeek && entry && entry.entry_type === 'alternative_spelling') gpcs.add(String(d.contentKey).toLowerCase());
      else if (isAltWeek) alts.add(d.contentKey);
      else gpcs.add(String(d.contentKey).toLowerCase());
    }
    // The week's tricky word(s) are introduced alongside its first content
    // day (same convention build-lessons.js's haveAGoFirstDay already uses
    // for the dedicated tricky_word card) — once taught, available for the
    // rest of the week's captions/dictation, not just that one card.
    if (d.kind === 'new' && !trickyIntroduced && weekTricky.length) {
      trickyIntroduced = true;
      for (const t of weekTricky) tricky.add(t);
    }
    const through = { gpcs: new Set(gpcs), alts: new Set(alts), tricky: new Set(tricky) };
    through.phase = phaseTagForGpcs(through.gpcs);
    out.push({ day: d.day, kind: d.kind, before, through });
  }
  return out;
}

// Is `word` genuinely usable (real word) at this point? Same gate
// check-programme.js re-checks banks with; trickySet/altSet/phase come from
// one side of a dayAvailability() entry (".before" or ".through").
function wordOkAt(word, avail) {
  return wordDecodableAt(String(word), avail.gpcs, avail.tricky, avail.phase, avail.alts);
}

// Sound buttons for a word AT this availability (re-segments against the
// day-level set — not the bank's own cached sound_buttons, which were
// computed against the whole week). Returns null if not decodable here.
function segsAt(word, avail) {
  const r = segmentWord(String(word).toLowerCase(), avail.gpcs);
  if (!r.ok) return null;
  return splitClusters(r.used);
}

// Does `word` use grapheme/affix `g` specifically? `g` is a raw catalog key
// (plain grapheme, or a "suffix_-ed"/"prefix_un-" code) — suffixes/prefixes
// never appear as a literal sound-button token (segmentWord only sees
// spelling), so they're matched by morphology/prefix text instead.
function wordUsesGraphemeOrAffix(word, g, avail) {
  const lw = String(word).toLowerCase();
  if (structureEntry(g)) return wordMatchesStructure(lw, g, avail.gpcs);
  if (/^suffix_-/.test(g)) {
    const suf = g.replace('suffix_-', '');
    const dec = suffixDecompose(lw);
    return !!(dec && SUFFIX_TOKEN[dec.suffix] === g && dec.suffix === suf);
  }
  if (/^prefix_/.test(g)) {
    const pre = g.replace('prefix_', '').replace(/-$/, '');
    return lw.startsWith(pre) && lw.length > pre.length;
  }
  // Raw segmentation, not segsAt: a Phase 4 cluster ("bl") is one catalog
  // token here, though it is shown as two sound buttons.
  const r = segmentWord(lw, avail.gpcs);
  return !!(r.ok && r.used.includes(g));
}

// Picks up to `limit` items from a bank word list (`[{word, ...}]`) that are
// genuinely decodable at `avail`, preferring ones that use grapheme/affix
// `requireGrapheme` (today's new content) when any do, re-deriving sound
// buttons fresh against `avail` rather than trusting the bank's own (whole-
// week) cached ones. Returns [] (never throws) when nothing fits — callers
// treat an empty Have a go / model-words list as "oral blending only today".
// `nonsense: true` skips the real-word gate (wordOkAt runs phaseFlags/
// soundCheck, which assume a real pronunciation) and just re-checks plain
// segmentability — the same bar check-programme.js holds nonsense words to.
// A tricky word passes wordOkAt but must never be shown with sound buttons
// ("out" came out as o·u·t in a Year 1 warm-up — review 2026-10-08).
const _NO_TRICKY = new Set();
function blendableAt(word, avail) {
  return wordDecodableAt(String(word), avail.gpcs, _NO_TRICKY, avail.phase, avail.alts);
}

function pickWordsAt(entries, avail, { requireGrapheme, limit, nonsense } = {}) {
  const ok = (entries || [])
    .filter((e) => nonsense || (wordOkAt(e.word, avail) && blendableAt(e.word, avail)))
    .map((e) => ({ word: e.word, sound_buttons: segsAt(e.word, avail) }))
    .filter((e) => e.sound_buttons);
  let pool = ok;
  if (requireGrapheme) {
    const withG = ok.filter((e) => wordUsesGraphemeOrAffix(e.word, requireGrapheme, avail));
    if (withG.length) pool = withG;
  }
  return limit ? pool.slice(0, limit) : pool;
}

// Strict variant for "model words" teaching a brand-new grapheme/affix: every
// result MUST use it (unlike pickWordsAt's requireGrapheme, which prefers but
// falls back to any decodable item) — there's no point modelling a new sound
// with words that don't contain it.
function pickModelWordsAt(entries, avail, grapheme, limit) {
  return (entries || [])
    .filter((e) => wordOkAt(e.word, avail) && blendableAt(e.word, avail) && wordUsesGraphemeOrAffix(e.word, grapheme, avail))
    .map((e) => ({ word: e.word, sound_buttons: segsAt(e.word, avail) }))
    .filter((e) => e.sound_buttons)
    .slice(0, limit);
}

// Every token in `text` is usable at `avail` — cast names included: a name
// must decode with what is taught, or be a taught tricky word (2026-10-13).
function sentenceOkAt(text, avail) {
  const tokens = text.match(/[A-Za-z']+/g) || [];
  if (!tokens.length) return false;
  return tokens.every((tok) => wordOkAt(tok, avail));
}

// Does `text` contain a token that uses grapheme/affix `g`?
function sentenceUsesGraphemeOrAffix(text, g, avail) {
  const tokens = text.match(/[A-Za-z']+/g) || [];
  return tokens.some((tok) => !isCastName(tok) && wordUsesGraphemeOrAffix(tok, g, avail));
}

// Does `text` contain a token matching one of `words` (case-insensitive) —
// used for alternative-pronunciation days, where "uses today's sound" means
// "uses one of the specific model words chosen to demonstrate it", since the
// grapheme itself was already taught (that's what makes it an alternative).
function sentenceUsesWord(text, words) {
  const set = new Set((words || []).map((w) => String(w).toLowerCase()));
  const tokens = text.match(/[A-Za-z']+/g) || [];
  return tokens.some((tok) => set.has(tok.toLowerCase()));
}

module.exports = {
  segsForWord, cumulativeGpcsBeforeWeek,
  cumulativeAltKeysBeforeWeek, cumulativeTrickyWordsBeforeWeek,
  phaseTagForGpcs, dayAvailability, wordOkAt, segsAt, wordUsesGraphemeOrAffix,
  pickWordsAt, pickModelWordsAt, sentenceOkAt, sentenceUsesGraphemeOrAffix, sentenceUsesWord,
  CONTENT, PROGRAMME, BANKS_DIR,
  gpcCatalog, gpcEntry, phase2to5GpcsInOrder,
  letterRhyme,
  altCatalog, altEntry,
  structureCatalog, structureEntry,
  trickyCatalog, trickyEntry,
  castNames, isCastName,
  phase1Aspects,
  schedule, allWeeks, weekSlug, halfTermSlug,
  bankBySlug, resolveBank,
  bookPlan, bookForGlobalWeek,
  parseDayPlan, newContentKeys, resolveNewContentForDays,
  soundButtonsForText,
  DAY_ORDER,
};
