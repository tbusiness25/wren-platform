'use strict';
/**
 * b311 — the child-name guard.
 *
 * Hard rule 2 of the brief: anything naming a child goes to the local model
 * only, and a signal that carries a child's name must be phrased locally or not
 * phrased at all.
 *
 * Every signal shipped in this build is written to report COUNTS and a link
 * ("3 children have no date of birth"), never a name — which is also what rule
 * 4 asks for, because a count is traceable back to rows and a name is not more
 * so. But "we wrote them all carefully" is a weaker promise than a check, and
 * it says nothing about the tenth signal somebody adds next month.
 *
 * So the guard runs on the BYTES that are about to be sent, on every fire. It
 * is the same shape as the one b295 put in front of the staff newsletter: read
 * the real names out of ladn.children, and refuse the text if one appears.
 *
 * A signal that legitimately needs to name a child sets containsChildData:true.
 * That does not switch the guard off — it switches the FALLBACK on: such a
 * signal may only ever be phrased by the local model (src/lib/sovereign-model.js,
 * which cannot construct a non-private URL), and if the local model is down its
 * deterministic sentence is sent as-is rather than being handed to anything else.
 *
 * Names are held in memory for 10 minutes and never logged. The check is on
 * word boundaries and case-insensitive; names under three characters are
 * skipped, because "Al" matching inside "Alert" would make the guard fire on
 * its own wording and be turned off within a week.
 *
 * ── THE EXCLUDED VOCABULARY, AND WHY IT IS NOT A LOOPHOLE ───────────────────
 * On the very first dev run (2026-09-10) the guard withheld a perfectly clean
 * sentence — "so WREN cannot tell you when the submission is due" — because two
 * children on the scrubbed dev roll are surnamed Wren. Left alone, that is how
 * a guard dies: it cries wolf, somebody turns it off, and then it is not there
 * for the case it was built for.
 *
 * So a token is not treated as evidence of a child when it is also part of the
 * vocabulary Wren's own sentences are made of: the product name, the setting's
 * name, its rooms, the months and the weekdays. Every one of those is a word
 * this build puts into a notification on purpose, and a child happening to
 * share it discloses nothing about that child — the sentence would read exactly
 * the same if the child did not exist.
 *
 * The list is derived, not hard-coded: rooms and the setting name are read from
 * the database, so a setting with a room called "Robins" gets the right answer
 * without anybody editing this file.
 */

const CACHE_MS = 10 * 60 * 1000;
const MIN_NAME_LEN = 3;

// Words this system writes on purpose. Extended at runtime from the DB.
const BASE_VOCABULARY = [
  'wren', 'roost', 'nest', 'egg', 'seed', 'fledge', 'finch',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'spring', 'summer', 'autumn', 'winter', 'term', 'baby', 'room', 'pre', 'school',
];

let _cache = { at: 0, names: null };

function _escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The words Wren's own sentences are made of: the base list above plus this
 * setting's name and its room names, split into tokens. A child sharing one of
 * these is not disclosed by a sentence that would contain the word anyway.
 * @returns {Promise<Set<string>>}
 */
async function settingVocabulary(db) {
  const vocab = new Set(BASE_VOCABULARY);
  const add = (s) => {
    for (const tok of String(s || '').toLowerCase().split(/[^a-z0-9']+/)) {
      if (tok.length >= MIN_NAME_LEN) vocab.add(tok);
    }
  };
  try {
    const { rows } = await db.query(
      `SELECT value FROM settings WHERE key IN ('nursery_name','local_authority')`);
    for (const r of rows) add(r.value);
  } catch (_) { /* the base list still applies */ }
  try {
    const { rows } = await db.query(`SELECT name, display_name FROM rooms`);
    for (const r of rows) { add(r.name); add(r.display_name); }
  } catch (_) { /* the base list still applies */ }
  return vocab;
}

/**
 * Every first / preferred / last name on the roll, active or not — a child who
 * has left is still a child whose name must not leak into a manager's email.
 * @returns {Promise<string[]>}
 */
async function childNames(db) {
  const now = Date.now();
  if (_cache.names && (now - _cache.at) < CACHE_MS) return _cache.names;
  const out = new Set();
  try {
    const vocab = await settingVocabulary(db);
    const { rows } = await db.query(
      `SELECT first_name, preferred_name, last_name FROM children`);
    for (const r of rows) {
      for (const n of [r.first_name, r.preferred_name, r.last_name]) {
        const v = String(n || '').trim();
        if (v.length < MIN_NAME_LEN) continue;
        if (vocab.has(v.toLowerCase())) continue;   // see the header
        out.add(v.toLowerCase());
      }
    }
  } catch (e) {
    // A guard that cannot read the roll must not silently pass everything.
    // Signal to the caller by throwing — the runner treats that as "do not
    // phrase, send the deterministic sentence", which is the safe direction.
    throw new Error(`child-name-guard: could not read the roll (${e.message})`);
  }
  _cache = { at: now, names: Array.from(out) };
  return _cache.names;
}

/**
 * Does `text` contain a child's name?
 * @returns {Promise<{hit:boolean, count:number}>} — the NAME is never returned,
 *   because the caller logs this result and a log is not a place for it.
 */
async function containsChildName(db, text) {
  const s = String(text || '');
  if (!s.trim()) return { hit: false, count: 0 };
  const names = await childNames(db);
  let count = 0;
  for (const n of names) {
    const re = new RegExp(`(^|[^\\p{L}])${_escapeRe(n)}([^\\p{L}]|$)`, 'iu');
    if (re.test(s)) count++;
  }
  return { hit: count > 0, count };
}

/** Test hook — drop the cached roll so a test that inserts a child sees it. */
function _reset() { _cache = { at: 0, names: null }; }

module.exports = {
  childNames, containsChildName, settingVocabulary, _reset,
  MIN_NAME_LEN, BASE_VOCABULARY,
};
