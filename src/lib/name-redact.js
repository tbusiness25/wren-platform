'use strict';
/**
 * name-redact.js — b359 (2026-09-29)
 *
 * Take every child's (and staff member's) name out of a prompt before it is
 * sent, and put the subject's name back into the answer afterwards.
 *
 * ── WHY THIS EXISTS WHEN b246 ALREADY DRAFTS TERMLY UPDATES ─────────────────
 * b246 sends the child's first name to the Ascent, and that is defensible: the
 * Ascent is ours, in the building, and sovereign-model.js refuses to talk to
 * anything that is not a private IP literal. Toby's b359 brief nonetheless asks
 * for the name to be stripped before the prompt and re-inserted afterwards.
 *
 * That is a stronger posture than b246's, not a contradiction of it, and it is
 * worth having for a reason that has nothing to do with which host answers:
 * a PROMPT IS A THING THAT GETS LOGGED. Ollama logs, a crash dump, a debug
 * `console.log` someone adds in six months, the raw_response column on a failed
 * run — all of them are places a prompt ends up that the careful reasoning about
 * OLLAMA_HOST never covered. Redacting at the boundary makes every one of those
 * places safe by construction instead of by argument.
 *
 * So: b246's own per-child path is UNCHANGED (this file is opt-in), and b359's
 * bulk per-key-person path runs through here.
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────
 * Two-sided, and the two sides must agree or the output reads like a mail-merge
 * that went wrong:
 *
 *   redact(text)    "Amelia enjoyed the sand"      → "⟪CHILD⟫ enjoyed the sand"
 *   rehydrate(text) "⟪CHILD⟫ enjoyed the sand"     → "Amelia enjoyed the sand"
 *
 * The subject child gets ⟪CHILD⟫. Any OTHER child named in the records gets
 * ⟪ANOTHER CHILD⟫ and is NEVER rehydrated — a termly update that names another
 * family's child is a disclosure, and b359 must not be the first thing in Wren
 * to do it. Staff get ⟪STAFF⟫, rehydrated to nothing useful either: the draft
 * says "their key person", which is what a parent-facing document should say.
 *
 * The token shape (⟪ … ⟫, U+27EA/U+27EB) is deliberate. A model shown [CHILD]
 * reaches for the bracket format b246's checkCitations() polices and produces
 * "[CHILD-1]"; a model shown {{child}} produces JSON. Mathematical angle
 * brackets appear in no training-data template anyone has met, they survive a
 * round trip through JSON, and they are trivially greppable when verifying that
 * nothing leaked.
 *
 * ── WHAT IS NOT CLAIMED ─────────────────────────────────────────────────────
 * This is a WORD-BOUNDARY name swap, not an anonymiser. A practitioner who
 * writes "the twins' birthday party at the house on Example Lane" has written
 * something identifying that no name list will catch. That is why this file is
 * a defence in depth on a LOCAL model and not a licence to send anything
 * anywhere else: the sovereignty rule is still the rule. leaks() exists so a
 * caller can assert the names it knows about really are gone, and the b359 run
 * stores both the redacted prompt and the leak scan on the row.
 */

const CHILD_TOKEN   = '⟪CHILD⟫';
const OTHER_TOKEN   = '⟪ANOTHER CHILD⟫';
const STAFF_TOKEN   = '⟪STAFF⟫';

// Names shorter than this are not redacted: "Al", "Bo" and "Jo" are also words,
// abbreviations and initials, and swapping every one of them out of a prompt
// mangles more text than it protects. Three characters is where real first names
// start to stop colliding with ordinary English ("Ada", "Ivy" and "Rex" are all
// names AND none of them are common words; "An", "Be", "In" are the opposite).
const MIN_NAME_LEN = 3;

// Words that are also names. Redacting these turns "May" into ⟪ANOTHER CHILD⟫
// in "we may try again", which is worse than leaving a name that is also a
// month. The subject child's OWN name is never filtered by this list — if a
// child is called May, their name is still taken out of their own prompt.
//
// The second group is NOT a judgement call: those words are the vocabulary the
// placeholder tokens themselves are made of, plus the words seeded test rows are
// named after. Found the hard way — wren_dev has a child recorded as "Demo Child
// 2", which put the ordinary English word "child" into the name list, which
// rewrote "A child aged 40 months" in every prompt to "A ⟪ANOTHER CHILD⟫ aged 40
// months" AND then made leaks() find "child" inside ⟪ANOTHER CHILD⟫ and refuse to
// send anything at all. Three sections of a real draft failed closed for it. The
// leaks() fix below is the important half; this list is the other half, and it
// costs nothing: a setting whose child is genuinely called "Baby" still has that
// name redacted when they are the SUBJECT, because subjectWords skips this list.
const ALSO_WORDS = new Set([
  'may', 'june', 'april', 'august', 'summer', 'autumn', 'winter', 'spring',
  'art', 'rose', 'ivy', 'daisy', 'sky', 'star', 'river', 'brook', 'reed',
  'grace', 'hope', 'joy', 'faith', 'sunny', 'story', 'song', 'bear', 'wren',
  'will', 'mark', 'rich', 'frank', 'bill', 'drew', 'sand', 'ray', 'dawn',
  // the token vocabulary + placeholder-row words
  'child', 'children', 'childs', 'another', 'staff', 'baby', 'babies',
  'test', 'tests', 'demo', 'sample', 'seed', 'dev', 'example', 'person',
  'parent', 'parents', 'family', 'name', 'room', 'nursery', 'unknown',
]);

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Split a full name into the usable parts, lowercased. */
function parts(...names) {
  const out = [];
  for (const n of names) {
    for (const bit of String(n || '').split(/[\s'’\-]+/)) {
      const w = bit.trim().toLowerCase().replace(/[^a-z]/g, '');
      if (w.length >= MIN_NAME_LEN) out.push(w);
    }
  }
  return out;
}

/**
 * Build a redactor for ONE subject child.
 *
 * @param {object} subject         { first_name, last_name, preferred_name, known_as }
 * @param {string[]} otherChildren every other child's name in the setting
 * @param {string[]} staffNames    staff names that appear in the records
 * @returns {{redact:Function, rehydrate:Function, leaks:Function, subjectWords:string[], tokens:object}}
 */
/**
 * b536 (2026-10-29) — ADDITIVE 4th parameter, `extraAlso`.
 *
 * ALSO_WORDS above exists because a word that is also a name mangles more text
 * than it protects. b536's bulk observation export found the same problem with a
 * class of word that list does not cover: wren_dev holds a contact whose name
 * contains "Three", so EVERY observation that said "the story of the three
 * bears" came out of the anonymiser as "the story of the ⟪STAFF⟫ bears". Over a
 * 500-observation INSET sample that is not a blemish, it is the document.
 *
 * Rather than widen ALSO_WORDS for every caller (b359's termly drafts included),
 * a caller may now pass its own extra set. Existing callers pass nothing and
 * behave EXACTLY as before — the default is an empty set and the filter below is
 * unchanged for them.
 *
 * The subject's own name is still never filtered by either list: a child
 * genuinely called "Three" still has their own name taken out of their own
 * document. Only OTHER people's names are affected, which is the trade this
 * mechanism has always made.
 */
function forChild(subject, otherChildren = [], staffNames = [], extraAlso = null) {
  const subjectWords = [...new Set(parts(
    subject && subject.first_name, subject && subject.last_name,
    subject && subject.preferred_name, subject && subject.known_as))];

  const alsoExtra = extraAlso instanceof Set ? extraAlso
    : (Array.isArray(extraAlso) ? new Set(extraAlso) : null);
  const isAlso = w => ALSO_WORDS.has(w) || (alsoExtra ? alsoExtra.has(w) : false);

  // A word that is the subject's own is never ALSO treated as another child's —
  // otherwise a room with two Amelias redacts the subject to ⟪ANOTHER CHILD⟫
  // half the time and the draft comes back about the wrong person.
  const subjectSet = new Set(subjectWords);
  const otherWords = [...new Set(parts(...otherChildren))]
    .filter(w => !subjectSet.has(w) && !isAlso(w));
  const staffWords = [...new Set(parts(...staffNames))]
    .filter(w => !subjectSet.has(w) && !isAlso(w));

  // Longest first, so "Amelia-Rose" is consumed before "Amelia".
  const byLen = (a, b) => b.length - a.length;
  const build = (words) => words.length
    ? new RegExp(`\\b(${words.slice().sort(byLen).map(esc).join('|')})\\b`, 'gi')
    : null;

  const reSubject = build(subjectWords);
  const reOther   = build(otherWords);
  const reStaff   = build(staffWords);

  /** Names out. Order matters: the subject wins every collision. */
  function redact(text) {
    let s = String(text == null ? '' : text);
    if (reSubject) s = s.replace(reSubject, CHILD_TOKEN);
    if (reOther)   s = s.replace(reOther, OTHER_TOKEN);
    if (reStaff)   s = s.replace(reStaff, STAFF_TOKEN);
    // A possessive on a token reads as "⟪CHILD⟫'s", which is what we want, but
    // "⟪CHILD⟫ ⟪CHILD⟫" (first name + surname, both swapped) does not — say it once.
    // Only the tokens and the whitespace BETWEEN them are consumed — a trailing
    // `\s*` would also eat the space before the next real word and produce
    // "Ameliaand" once the name goes back in.
    const collapse = (t) => new RegExp(`(?:${esc(t)}[ \t]*)+${esc(t)}`, 'g');
    s = s.replace(collapse(CHILD_TOKEN), CHILD_TOKEN)
         .replace(collapse(OTHER_TOKEN), OTHER_TOKEN)
         .replace(collapse(STAFF_TOKEN), STAFF_TOKEN);
    return s;
  }

  /**
   * Name back in — server-side, after the model has answered.
   *
   * Only the SUBJECT is restored. ⟪ANOTHER CHILD⟫ becomes "another child" and
   * ⟪STAFF⟫ becomes "their key person": a parent-facing document must not name
   * someone else's child, and naming an individual member of staff in a document
   * a family keeps is a decision for the practitioner, not the model.
   */
  function rehydrate(text, displayName) {
    const name = String(displayName || subject && (subject.known_as || subject.preferred_name || subject.first_name) || 'your child').trim();
    let s = String(text == null ? '' : text);
    s = s.split(CHILD_TOKEN).join(name)
         .split(OTHER_TOKEN).join('another child')
         .split(STAFF_TOKEN).join('their key person');
    // "⟪CHILD⟫'s" → "Amelia's" is already right; this catches the model writing
    // "the ⟪CHILD⟫" → "the Amelia".
    s = s.replace(new RegExp(`\\bthe ${esc(name)}\\b`, 'g'), name);
    return s;
  }

  /**
   * Which of the names we know about are STILL in this text. Must be [] for a
   * prompt that is about to be sent. Returns the offending words, not the text,
   * so a caller can log the finding without logging the child data.
   */
  function leaks(text) {
    // The tokens come OUT before the scan. ⟪ANOTHER CHILD⟫ contains the words
    // "another", "child" and (in ⟪STAFF⟫) "staff"; a setting with a child or a
    // staff member whose name contained any of them would have every single
    // draft refuse to send, for a name that had in fact been redacted
    // successfully. Scanning the replacement for the thing it replaced is
    // circular, and this is where that circle is cut.
    const s = String(text == null ? '' : text)
      .split(CHILD_TOKEN).join(' ')
      .split(OTHER_TOKEN).join(' ')
      .split(STAFF_TOKEN).join(' ');
    const found = [];
    for (const w of [...subjectWords, ...otherWords, ...staffWords]) {
      if (new RegExp(`\\b${esc(w)}\\b`, 'i').test(s)) found.push(w);
    }
    return [...new Set(found)];
  }

  return {
    redact, rehydrate, leaks,
    subjectWords, otherWords, staffWords,
    tokens: { child: CHILD_TOKEN, other: OTHER_TOKEN, staff: STAFF_TOKEN },
  };
}

/**
 * The name lists a redactor needs, read once per run rather than per child.
 * NAMES ONLY — no dates of birth, no emails, no phone numbers, no addresses.
 *
 * `children` is deliberately UNFILTERED: a child who left last year is still
 * named in the observations of the children who were there with them, and their
 * name must still come out.
 *
 * `contacts.full_name` is in here for a reason found while reading a real
 * redacted prompt: an observation said "wanted the red car Milo had", and Milo
 * survived — because Milo was not in `children`. A peer who has left, a sibling
 * brought at pick-up, a cousin at a party: all of them turn up in practitioner
 * prose and none of them are on the roll. `contacts` catches the family half of
 * that. It does NOT catch everyone, and this file does not pretend to — see the
 * header. It is defence in depth on a model that never leaves the building.
 */
async function loadNameSets(db) {
  const [kids, staff, contacts] = await Promise.all([
    db.query(`SELECT id, first_name, last_name, preferred_name FROM children`),
    db.query(`SELECT first_name, last_name FROM staff`).catch(() => ({ rows: [] })),
    db.query(`SELECT full_name FROM contacts WHERE full_name IS NOT NULL`).catch(() => ({ rows: [] })),
  ]);
  return {
    children: kids.rows,
    staffNames: staff.rows.flatMap(r => [r.first_name, r.last_name]).filter(Boolean),
    contactNames: contacts.rows.map(r => r.full_name).filter(Boolean),
  };
}

/** forChild(), but given the loadNameSets() bundle and a child id. */
function fromSets(sets, childId, subjectOverride) {
  const subject = subjectOverride
    || (sets.children || []).find(c => Number(c.id) === Number(childId))
    || {};
  const others = (sets.children || [])
    .filter(c => Number(c.id) !== Number(childId))
    .flatMap(c => [c.first_name, c.last_name, c.preferred_name])
    .filter(Boolean);
  // Contacts ride with staff: both are "a person who is not this child", both
  // are replaced by a role word rather than a name, and neither is ever
  // rehydrated. ⟪STAFF⟫ reading as "their key person" is the right answer for a
  // practitioner and a harmless one for a parent's name, which should not be in
  // a termly update about their child in the first place.
  // b536: `sets.extraAlsoWords` is optional and absent for every pre-b536 caller,
  // so this is the same call it has always been unless a caller opts in.
  return forChild(subject, others, [...(sets.staffNames || []), ...(sets.contactNames || [])],
    sets.extraAlsoWords || null);
}

module.exports = {
  CHILD_TOKEN, OTHER_TOKEN, STAFF_TOKEN, MIN_NAME_LEN, ALSO_WORDS,
  forChild, fromSets, loadNameSets, parts,
};
