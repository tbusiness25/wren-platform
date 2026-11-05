'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * observation-review-redact.js — b536 (2026-10-29)
 *
 * The anonymiser behind the reviewer's "Anonymised PDF" button. It is the
 * one-off INSET script of 29 October (ladn-ready/b536-reference-obs-sample.js)
 * turned into something permanent, with the five things that script learnt the
 * hard way kept intact:
 *
 *   1. src/lib/name-redact.js's loadNameSets() reads children, staff and
 *      contacts — but NOT the extra names a child record carries
 *      (middle_name, preferred_forename, preferred_surname, parent_1_name,
 *      parent_2_name, emergency_contact_1/2_name). A sibling's name, a
 *      double-barrelled surname and a parent's first name all turn up in
 *      practitioner prose, so loadExtendedSets() adds them.
 *   2. The subject child is matched on EVERY name they are known by, which
 *      means passing a composed subject to fromSets() rather than letting it
 *      pick the plain children row.
 *   3. The placeholder labels must come OUT of the text before leaks() runs.
 *      One child on prod has a name part that is literally the word "child"
 *      (name-redact's own ALSO_WORDS header tells the same story from the
 *      b359 side), so scanning "[another child]" for the word it replaced finds
 *      a leak that is not one and fails the whole export closed.
 *   4. A capitalised word that matches NO name list is not safe just because
 *      Wren does not know it — a sibling, a nickname, a childminder. Those are
 *      blanked to "[name?]" rather than left in, and counted so the footer can
 *      say how many there were.
 *   5. Age goes in as months/years AT THE DATE OF THE OBSERVATION. A date of
 *      birth never appears, and neither does a full date — month and year only.
 *
 * NOTHING HERE IS A GUARANTEE, and the PDF says so on every anonymised export.
 * This is a word-boundary name swap over Wren's own name lists plus a
 * capitalised-word sweep; "the twins' party at the house on Example Lane" is
 * still identifying and no list will catch it. That is why the footer tells the
 * reader to read the document before sharing it, and why the route refuses
 * (409) when leaks() finds anything at all.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const NR = require('./name-redact');

// ── the printable labels ─────────────────────────────────────────────────────
const OTHER_LABEL = '[another child]';
const ADULT_LABEL = '[adult]';
const UNKNOWN_LABEL = '[name?]';
const childLabel = n => `Child ${n}`;
const practitionerLabel = (n) => {
  // A, B … Z, then AA, AB … — stable, ordered, and never a real initial pair
  // that could be read as a name.
  let s = '', i = Number(n);
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return 'Practitioner ' + (s || 'A');
};

/* Everything a label is made of, so leaks() never scans its own replacement.
 * `Child 12` and `Practitioner AB` are matched by shape, not by enumeration. */
const LABEL_RE = new RegExp(
  '\\[another child\\]|\\[adult\\]|\\[name\\?\\]|\\[child\\]|\\[email\\]|\\[number\\]|\\[link\\]|\\[date\\]'
  + '|\\bChild\\s+\\d+\\b|\\bPractitioner\\s+[A-Z]{1,3}\\b', 'g');

// ── HTML / PII scrubbing ─────────────────────────────────────────────────────
/* ⚠ LENGTH IS A SECURITY AND A PERFORMANCE PROPERTY HERE, NOT A COSMETIC ONE.
 *
 * Measured on wren_dev, 2026-10-29, while this build's own export OOM-killed the
 * container: ONE real observation row holds 204,830 characters of
 * observation_text containing FIVE space characters. It is a pasted blob (a data
 * URI or a base64 attachment), not prose. Two consequences, both fixed here:
 *
 *   1. `/[\w.+-]+@[\w-]+\.[\w.]+/` over a 200k run of word characters is
 *      quadratic — it took 34 SECONDS on that one field, which is where "500
 *      rows takes six minutes" came from. Every unbounded quantifier in this
 *      function is now bounded, so no single field can cost more than a bounded
 *      amount of work however pathological it is.
 *   2. A 200k-character card cannot be laid out by pdfkit (that is the other
 *      half of the 4 GB heap) and nobody could read it. The field is capped.
 *
 * The cap is applied TWICE on purpose: a cheap slice of the raw input before the
 * regexes run (so a pathological field cannot cost anything at all), and the
 * real cap on the cleaned output. A truncated field says so in the text, so a
 * reader is never shown a sentence that stops mid-word with no explanation.
 *
 * A data: URI is replaced outright rather than truncated: it can BE a photograph,
 * and a photograph must never reach an anonymised export by the side door. */
/* 6,000 characters is about two and a half A4 pages for ONE observation card,
 * which is already more than any review needs. Measured on the same wren_dev
 * sample: the MEDIAN observation_text is 67 characters and the 95th percentile
 * is 67 — the cap exists for the two outliers, not for the corpus. */
const MAX_FIELD_CHARS = 6000;
const RAW_SLICE = 60000;
/* ⚠ AND THE SECOND HALF OF THE SAME 204k ROW.
 * Capping the length was not enough. pdfkit's line breaker has to MEASURE EVERY
 * PREFIX of an unbreakable run (PDF has no overflow-wrap), so a single
 * 20,000-character "word" is quadratic in glyph measurement. Measured: 498
 * ordinary rows render in 767 ms and 48 MB; the TWO blob rows alone took
 * 10.4 SECONDS and 1.1 GB, which is the whole of this build's memory problem in
 * two records.
 *
 * So a run of non-space characters is dealt with before it ever reaches pdfkit:
 *   · 200+ characters with no space in it is not a word in any language. It is
 *     base64, a token or a minified blob. It is replaced, and the card says so.
 *   · 80–199 characters is a long filename or a path. It is hard-wrapped so the
 *     line breaker has somewhere to break.
 * Both run on the NORMAL branch too — a 204k string in a JSON list response is
 * no better for the browser than it is for pdfkit. */
const BLOB_NOTE = '[unreadable block of text removed]';
function breakLongRuns(t) {
  return String(t)
    .replace(/\S{200,}/g, BLOB_NOTE)
    .replace(/\S{80,199}/g, m => m.replace(/(.{60})/g, '$1\n'));
}
const TRUNC_NOTE = '\n\n[… this entry is longer than this view shows and has been cut off here.]';

/**
 * Observation text is stored as HTML fragments by some writers and plain text
 * by others. This flattens it and takes out the four things that are identifying
 * whatever the name lists do: links, email addresses, long digit runs (phone
 * numbers, NHS/NI numbers, EyLog URNs) and anything shaped like a full date.
 *
 * `anonymised` is a parameter rather than two functions because the NORMAL
 * export wants the HTML flattened too — just without the scrubbing, since a
 * manager reading their own setting's observations is entitled to the date in
 * the sentence.
 */
function plain(s, anonymised, maxChars) {
  const cap = Number(maxChars) > 0 ? Number(maxChars) : MAX_FIELD_CHARS;
  const src = String(s == null ? '' : s);
  // (a) a data: URI is dropped whole — it can be an image. Bounded quantifier.
  // (b) the raw slice: the regexes below never see more than RAW_SLICE chars.
  let t = src
    .replace(/data:[a-z0-9.+-]{1,60}\/[a-z0-9.+-]{1,60};?[a-z0-9=;,-]{0,40}[A-Za-z0-9+/=]{40,}/gi, '[embedded file]')
    .slice(0, RAW_SLICE)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]{0,400}>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&[a-z]{1,10};/gi, ' ');
  if (anonymised) {
    t = t
      // Every quantifier bounded. RFC-wise a 64-char local part and 63-char
      // labels are the real limits, so nothing legitimate is missed.
      .replace(/https?:\/\/\S{1,500}/gi, '[link]')
      .replace(/[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}/g, '[email]')
      // a full date in any of the shapes practitioners actually write
      .replace(/\b\d{1,2}\s{0,2}[/.\-]\s{0,2}\d{1,2}\s{0,2}[/.\-]\s{0,2}\d{2,4}\b/g, '[date]')
      .replace(/\b\d{4}\s{0,2}[/.\-]\s{0,2}\d{1,2}\s{0,2}[/.\-]\s{0,2}\d{1,2}\b/g, '[date]')
      .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s{1,3}(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,8}\.?\s{1,3}\d{2,4}\b/gi, '[date]')
      .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,8}\.?\s{1,3}\d{1,2}(?:st|nd|rd|th)?,?\s{1,3}\d{2,4}\b/gi, '[date]')
      // 9+ digits in a row is never a sentence: phone, NI, NHS, URN
      .replace(/\+?\d[\d\s()-]{8,30}\d/g, '[number]');
  }
  t = breakLongRuns(t)
    .replace(/[ \t]{1,200}/g, ' ')
    .replace(/\n[ \t]{0,200}/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > cap) t = t.slice(0, cap).replace(/\s\S{0,40}$/, '') + TRUNC_NOTE;
  return t;
}

// ── the capitalised-word sweep ───────────────────────────────────────────────
/* Capitalised words that are NOT names. Lifted from the reference script, which
 * built it by reading a real anonymised sample: days, months, festivals,
 * languages, nursery vocabulary, the EYFS vocabulary, nursery-rhyme words and
 * the toy brands that appear in half the observations in the setting. A word
 * that is on this list is left alone; a word that is not is blanked. */
const OK_CAPS = new Set((
  'I A An The And But Or So Then Now Today Yesterday Tomorrow Morning Afternoon Evening ' +
  'Mummy Mum Mama Mommy Daddy Dad Papa Nanny Nan Nana Granny Grandma Grandad Grandpa Grandad Auntie Aunty Uncle ' +
  'Monday Tuesday Wednesday Thursday Friday Saturday Sunday ' +
  'January February March April May June July August September October November December ' +
  'Christmas Easter Diwali Eid Ramadan Halloween Bonfire Hanukkah Chinese New Year Pancake Harvest Advent Nativity ' +
  'Spring Summer Autumn Winter Term Half Week Day Session Snack Lunch Tea Breakfast Dinner Circle Story Song Rhyme ' +
  'English Spanish French German Arabic Polish Urdu Somali Bengali Tamil Hindi Punjabi Portuguese Italian Romanian ' +
  'Turkish Farsi Pashto Gujarati Albanian Russian Ukrainian Lithuanian Latvian Czech Slovak Hungarian Greek ' +
  'EYFS PSED SEN SENCO SEND COEL CL PD UW UTW EAD ELG ELGs DSL EAL EYPP IEP TAF CAF Ofsted ' +
  'Characteristics Effective Learning Playing Exploring Active Creating Thinking Critically ' +
  'Communication Language Physical Development Personal Social Emotional Literacy Mathematics ' +
  'Understanding World Expressive Arts Design Matters Birth Five Makaton Montessori Froebel Reggio ' +
  'Baby Room Pre School Preschool Toddler Garden Nursery Your Nursery Ealing London Example Lane Hall Office Kitchen ' +
  'Lego Duplo Playdough Play Doh Mega Blocks Hama Stickle Bricks Numicon Tuff Tray Mud Water Sand Role Play ' +
  'Peppa Pig Gruffalo Hungry Caterpillar Bear Hunt Dear Zoo Elmer Rainbow Fish Tiger Came Tea Snail Whale ' +
  'Twinkle Star Humpty Dumpty Wheels Bus Old Macdonald MacDonald Row Boat Baa Black Sheep Incy Wincy Spider ' +
  'Head Shoulders Knees Toes Five Little Ducks Speckled Frogs Monkeys Jumping Bed Sleeping Bunnies ' +
  'Child Children Another Adult Practitioner Staff Key Person What Next Steps Observation Obs Note Milestone ' +
  'TV iPad iPhone YouTube CBeebies Wi Fi UK NHS GP ' +
  'Mr Mrs Miss Ms Dr'
).split(/\s+/).filter(Boolean));

/* Blank every capitalised word that is not a sentence start and not on OK_CAPS.
 * Returns [text, count]. Deliberately conservative about what counts as a
 * capitalised word: at least three letters, so "I", "Hi" and initials are left
 * alone, and a word that is ALL CAPS is left alone too (an acronym, not a name).
 *
 * The label text must already be in place — the regex demands a lower-case
 * tail, so "[adult]" and "Child 3" cannot match.
 *
 * ── TWO THINGS THE REFERENCE SCRIPT'S VERSION GOT WRONG FOR THIS USE ─────────
 * The INSET script used `(^|[^.!?\n]\s|\n)` and only HIGHLIGHTED the matches, so
 * both of these were harmless there. They are not harmless when the match is
 * replaced:
 *
 *   1. `^` matches the START OF THE STRING, which is a sentence start, not a
 *      mid-sentence capital. Caught by reading the first real anonymised export:
 *      "Offer [child] a story map" came out as "[name?] [child] a story map" —
 *      the ordinary verb "Offer" blanked for beginning the field.
 *   2. CONSUMING the preceding character meant two capitals in a row only ever
 *      had the first blanked ("Mary Poppins" → "[name?] Poppins"), because the
 *      second had no unconsumed character in front of it.
 *
 * A lookbehind fixes both: it ASSERTS "an ordinary character then a space"
 * without eating either, so the start of the field, the start of a line and the
 * word after a full stop are all left alone, and consecutive capitals are each
 * judged on their own. */
function blankUnknownCaps(text) {
  let n = 0;
  const out = String(text == null ? '' : text).replace(
    /(?<=[^.!?\n][ \t])([A-Z][a-z]{2,})(?=[\s,.'’!?;:)–—-]|$)/g,
    (w) => { if (OK_CAPS.has(w)) return w; n++; return UNKNOWN_LABEL; });
  return [out, n];
}

/* ── EXTRA "also words" FOR THIS BUILD ONLY (b536) ───────────────────────────
 * name-redact's ALSO_WORDS covers month names, flower names and the vocabulary
 * seeded test rows are made of. It does not cover NUMBER WORDS, and this build
 * found out why that matters: wren_dev holds a contact whose name contains
 * "Three", so "the story of the three bears" came out of the anonymiser as "the
 * story of the [adult] bears". Over an INSET sample of 500 observations — where
 * counting, sharing and turn-taking are most of what gets written down — that is
 * not a blemish, it is the document.
 *
 * Number words only, plus the few counting words that go with them. The trade is
 * explicit and is the same trade ALSO_WORDS has always made: a person whose name
 * is on this list is NOT redacted when they are mentioned in someone else's
 * observation. A child genuinely called "Seven" is still redacted in their OWN
 * entries, because name-redact never filters the subject's own words.
 *
 * Passed through `sets.extraAlsoWords`, which name-redact ignores unless it is
 * present — b359's termly drafts are untouched. */
const EXTRA_ALSO_WORDS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'hundred',
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth',
  'ninth', 'tenth', 'half', 'both', 'many', 'few', 'more', 'most', 'all', 'none',
]);

// ── the name sets ────────────────────────────────────────────────────────────
/**
 * loadNameSets() plus the names it does not read.
 *
 * Returns the bundle fromSets() takes, with two extras the caller needs:
 *   `subjectOf(childId)` — the composed subject (every name the child is known
 *                          by), because fromSets() would otherwise match only
 *                          first_name / last_name / preferred_name.
 *   `childCount`         — how many children the lists cover, for the NOTES.
 *
 * NAMES ONLY. No date of birth, no email, no phone number, no address is read
 * by this function, and nothing it returns is logged anywhere.
 */
async function loadExtendedSets(db) {
  const sets = await NR.loadNameSets(db);

  let fam = [];
  try {
    const { rows } = await db.query(`
      SELECT id, first_name, last_name, preferred_name,
             middle_name, preferred_forename, preferred_surname,
             parent_1_name, parent_2_name,
             emergency_contact_1_name, emergency_contact_2_name
        FROM children`);
    fam = rows;
  } catch (_) {
    // A schema without the extra columns still anonymises on the core lists.
    try { const { rows } = await db.query(`SELECT id, first_name, last_name, preferred_name FROM children`); fam = rows; }
    catch (__) { fam = []; }
  }

  const extraAdults = fam.flatMap(r => [
    r.parent_1_name, r.parent_2_name, r.emergency_contact_1_name, r.emergency_contact_2_name,
  ]).filter(Boolean);

  // Every name a child is known by, as EXTRA ROWS under the same id. fromSets()
  // drops the subject's own id from "others", so adding rows rather than
  // merging strings keeps a sibling's middle name out of the subject's own set.
  const kidRows = [
    ...sets.children,
    ...fam.filter(r => r.middle_name || r.preferred_forename || r.preferred_surname).map(r => ({
      id: r.id,
      first_name: r.preferred_forename || null,
      last_name: [r.middle_name, r.preferred_surname].filter(Boolean).join(' ') || null,
      preferred_name: null,
    })),
  ];

  const byId = new Map(fam.map(r => [Number(r.id), r]));
  const subjectOf = (id) => {
    const r = byId.get(Number(id)) || {};
    return {
      first_name: [r.first_name, r.preferred_forename].filter(Boolean).join(' ') || null,
      last_name: [r.last_name, r.middle_name, r.preferred_surname].filter(Boolean).join(' ') || null,
      preferred_name: r.preferred_name || null,
    };
  };

  return {
    children: kidRows,
    staffNames: [...(sets.staffNames || []), ...extraAdults],
    contactNames: sets.contactNames || [],
    extraAlsoWords: EXTRA_ALSO_WORDS,
    subjectOf,
    childCount: fam.length,
  };
}

// ── a leak scan that can run 500 times ───────────────────────────────────────
/**
 * name-redact's own leaks() is correct and is the right shape for b359, which
 * scans ONE prompt per child. It is the wrong shape for a 500-row export:
 *
 *     for (const w of [...subjectWords, ...otherWords, ...staffWords])
 *       if (new RegExp(`\\b${esc(w)}\\b`, 'i').test(s)) found.push(w);
 *
 * On wren_dev that list is ~1,000 words, so one call compiles a thousand regular
 * expressions and makes a thousand passes over the text. Three fields per
 * observation is 3,000 compiles per row. MEASURED, not guessed: 50 rows took
 * 34 seconds and 500 rows exhausted a 4 GB heap and killed the container.
 *
 * Same answer, one pass: build a SINGLE alternation once per redactor, longest
 * word first (so "amelia-rose" is consumed before "amelia"), and match the whole
 * text against it. The word set never changes for the life of a redactor, so the
 * regex is cached on it.
 *
 * Word-boundary semantics are identical — \b(a|b|c)\b matches exactly what
 * \ba\b, \bb\b, \bc\b match between them — and the result is deduplicated and
 * lower-cased so it compares to name-redact's own output word for word. The
 * regression test for that equivalence is in scripts/b536-verify.js.
 */
const _leakRe = new WeakMap();
function fastLeaks(red, text) {
  let re = _leakRe.get(red);
  if (re === undefined) {
    const words = [...new Set([...(red.subjectWords || []), ...(red.otherWords || []), ...(red.staffWords || [])])]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    re = words.length ? new RegExp('\\b(' + words.join('|') + ')\\b', 'gi') : null;
    _leakRe.set(red, re);
  }
  if (!re) return [];
  re.lastIndex = 0;
  const hits = String(text == null ? '' : text).match(re);
  return hits ? [...new Set(hits.map(h => h.toLowerCase()))] : [];
}

// ── the export-scoped anonymiser ─────────────────────────────────────────────
/**
 * One anonymiser for one export. Call `prepare(row)` per observation in the
 * order they will be printed; the Child / Practitioner numbering is assigned on
 * first appearance, so it is stable within the document and means nothing
 * outside it.
 *
 * @param {object} sets  loadExtendedSets() output
 */
function exportRedactor(sets) {
  const childNo = new Map();     // child_id -> 1..n
  const practNo = new Map();     // author key -> 1..n
  const redactors = new Map();   // child_id -> name-redact instance
  let leakWords = new Set();
  let unknownCaps = 0;

  const redactorFor = (childId) => {
    const k = Number(childId);
    if (!redactors.has(k)) redactors.set(k, NR.fromSets(sets, k, sets.subjectOf(k)));
    return redactors.get(k);
  };

  const numberFor = (map, key, start) => {
    const k = String(key == null ? '∅' : key);
    if (!map.has(k)) map.set(k, map.size + (start || 1));
    return map.get(k);
  };

  /** Child label for an id, assigning the next number if it is new. */
  function labelForChild(childId) { return childLabel(numberFor(childNo, childId, 1)); }
  /** Practitioner label for a staff id or recorded author name. */
  function labelForPractitioner(staffId, authorName) {
    return practitionerLabel(numberFor(practNo, staffId != null ? 's' + staffId : 'n' + (authorName || ''), 1));
  }

  /**
   * One field of one observation: HTML flattened, PII scrubbed, every known name
   * replaced, unmatched capitals blanked. Also accumulates the leak scan.
   */
  function field(text, childId) {
    const red = redactorFor(childId);
    const kid = labelForChild(childId);
    let t = red.redact(plain(text, true))
      .split(NR.CHILD_TOKEN).join(kid)
      .split(NR.OTHER_TOKEN).join(OTHER_LABEL)
      .split(NR.STAFF_TOKEN).join(ADULT_LABEL);
    const [blanked, n] = blankUnknownCaps(t);
    unknownCaps += n;
    // The leak scan runs on the text with every LABEL removed — see note 3 in
    // the header. Scanning a replacement for what it replaced is circular.
    for (const w of fastLeaks(red, blanked.replace(LABEL_RE, ' '))) leakWords.add(w);
    return blanked;
  }

  return {
    field,
    labelForChild,
    labelForPractitioner,
    /** The words that survived, as a COUNT and a length histogram — never the words. */
    get leakCount() { return leakWords.size; },
    get leakWords() { return [...leakWords]; },      // for an in-process assertion only
    get unknownCapCount() { return unknownCaps; },
    get childCount() { return childNo.size; },
    get practitionerCount() { return practNo.size; },
  };
}

// ── age / date formatting (anonymised) ───────────────────────────────────────
function ageText(months) {
  if (months == null || !Number.isFinite(Number(months))) return 'age not recorded';
  const m = Number(months);
  if (m < 24) return `${m} months`;
  return `${Math.floor(m / 12)}y ${m % 12}m`;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];
/** 'October 2026' — month and year, never a day. */
function monthYear(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return '';
  // Europe/London parts, so an observation saved at 23:40 BST is not filed a
  // month early in December.
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', month: 'long', year: 'numeric' });
  return p.format(d);
}
/** '12 October 2026' — the NORMAL export only. */
function fullDate(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric',
  }).formatToParts(d);
  const g = t => (parts.find(p => p.type === t) || {}).value || '';
  return `${g('day')} ${g('month')} ${g('year')}`;
}

module.exports = {
  plain, blankUnknownCaps, fastLeaks, breakLongRuns, EXTRA_ALSO_WORDS,
  MAX_FIELD_CHARS, RAW_SLICE, TRUNC_NOTE, BLOB_NOTE, OK_CAPS, LABEL_RE, UNKNOWN_LABEL, OTHER_LABEL, ADULT_LABEL,
  childLabel, practitionerLabel,
  loadExtendedSets, exportRedactor,
  ageText, monthYear, fullDate, MONTHS,
};
