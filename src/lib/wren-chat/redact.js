'use strict';
/**
 * redact.js — b348: the gate everything passes through on its way to a cloud model.
 *
 * WHAT IT DOES
 *   Builds a lexicon from the nursery's own records — every child's, parent's and member of
 *   staff's name, and every stored street address — and masks any of them wherever they appear
 *   in text, together with pattern-shaped identifiers (email, phone, postcode, NI / NHS number)
 *   and anything that looks like a credential. Masked text carries a typed placeholder
 *   ([child], [parent], [staff], [address], [email] …) so the model can still read a sentence.
 *
 * WHAT MAKES IT SAFE TO RELY ON
 *   • It FAILS CLOSED. If the lexicon cannot be built (database down, a query error), or is
 *     empty while children exist, redaction throws and the caller must not send. There is no
 *     "best effort" path.
 *   • It VERIFIES ITS OWN OUTPUT. After masking, the same detectors are run over the result;
 *     any residual hit throws. A bug in the replacement logic therefore blocks the call
 *     instead of leaking through it.
 *   • It works on the SERIALISED request (redactDeep walks every string in the body), not on
 *     "the user's question" — so a name arriving in a document chunk, a tool result or a
 *     history turn is masked the same way.
 *
 * WHAT IT CANNOT DO (said plainly; also in the NOTES)
 *   It matches names it KNOWS. A misspelling ("Zephyr" heard as "Zeffer" by speech-to-text), a
 *   nickname that is not in the records, or a description ("the little girl whose mum works at
 *   the bakery") is not caught. That is why the model never sees row-level data at all — this
 *   gate is the second wall, not the first.
 *
 * COMMON-WORD NAMES
 *   A child called Will, Hope or Rose would turn every "will" and "hope" into a placeholder.
 *   Tokens that are also ordinary English words are matched only when Capitalised or UPPER —
 *   the way a name is typed, and the way Whisper writes it. A name that is ALSO a plain word
 *   and typed in lower case slips through; that is the price of a usable sentence.
 */

const NAME_SOURCES = [
  // person: which placeholder it earns. cols are looked up in information_schema first, so a
  // schema that lacks one (dev vs prod drift) costs a column, not the whole lexicon.
  { table: 'children',     cols: [['first_name', 'child'], ['last_name', 'child'], ['middle_name', 'child'],
                                  ['preferred_name', 'child'], ['preferred_forename', 'child'], ['preferred_surname', 'child'],
                                  ['parent_1_name', 'parent'], ['parent_2_name', 'parent'],
                                  ['emergency_contact_1_name', 'parent'], ['emergency_contact_2_name', 'parent'],
                                  ['social_worker_name', 'parent'], ['gp_name', 'parent'],
                                  ['address_line1', 'address']] },
  { table: 'contacts',     cols: [['full_name', 'parent'], ['address_line1', 'address'], ['address_line2', 'address']] },
  { table: 'enquiries',    cols: [['child_first_name', 'child'], ['child_last_name', 'child'], ['parent_name', 'parent']] },
  { table: 'waiting_list', cols: [['child_first_name', 'child'], ['child_last_name', 'child'], ['parent_name', 'parent']] },
  { table: 'staff',        cols: [['first_name', 'staff'], ['last_name', 'staff'], ['preferred_name', 'staff'],
                                  ['address_line1', 'address']] },
];

// Words that are never treated as a person even when a record holds them as a "name"
// (the dev database has staff called "Manager" and "test"; a nursery has a "Baby Room").
const NEVER_A_NAME = new Set(('day nursery baby room rooms pre school preschool pre-school manager admin ' +
  'test demo wren roost nest egg hawk seed staff parent parents child children mum mummy dad daddy unknown none nil tbc tba ' +
  'n/a na office nursery key person practitioner apprentice cook chef deputy owner headteacher teacher mr mrs ms miss mx dr ' +
  'and the of for with at in on street road avenue lane close drive gardens court way place square terrace crescent grove ' +
  // Function words and everyday vocabulary. The name fields in an imported database hold junk ("Not known",
  // "One parent", "Contact office"), and a lexicon that masks "not" and "one" is a lexicon nobody can use.
  'be to a that have i it not he as you do this but his by from they we say her she or an my one all would there their what so up out ' +
  'if about who get which go me when make like time no just him know take people into year your good some could them see other ' +
  'than then now look only come its over think also back after use two how our work first well way even new want because any ' +
  'these give day most us is are was were has had been being am does did done more many much such very too here why where while ' +
  'during before between under again further once both each few own off down through above below until against among without ' +
  'within along across behind beyond near per via yes ok please thanks hello hi another others something anything nothing ' +
  'everything someone anyone everyone contact bar payroll yet still already always never often sometimes usually maybe perhaps ' +
  'however therefore though although unless whether either neither rather quite almost enough several various every same ' +
  'not-known see notes note mother father guardian grandma grandpa granny nana nan carer family friend neighbour sibling ' +
  'emergency provided details address phone email mobile home work tel telephone number name surname forename first last').split(/\s+/));

// Ordinary English words that are also given names or surnames: matched Capitalised/UPPER only.
const COMMON_WORDS = new Set(('can dev will may mark bill rose hope grace joy faith summer autumn april june august march amber ruby pearl ' +
  'jade holly ivy daisy lily poppy willow robin sky art pat ray rob jack jean dawn dot eve iris kit lark lee mac max nick pip rich rick ' +
  'sandy sunny brown white black green grey gray young king hill bell best wood baker miller field fisher hunter wright price ' +
  'long short little sharp fair hall house park lake bird fox wolf bear lamb swan drake stone rock bush burns banks bond ' +
  'cross dean ford gates grant hart hay holt hood lord marsh mills moore moss mount page pool rice ross rush sands shaw small ' +
  'snow sparks spring steel storm strong swift chance angel bay blue cliff dale dane earl east west north south fern flint ' +
  'frost gold heath hurst ivory jay kay love major mason noble oak penny pierce reed rowan sage sean stark temple might').split(/\s+/));

// Of those, the ones people also START SENTENCES with ("Can you…", "Will the…", "May I…"): matched only mid-sentence.
const SENT_START_EXEMPT = new Set('can will may mark hope might long little best fair page love'.split(' '));

const B_L = '(?<![\\p{L}\\p{N}_])';
const B_R = '(?![\\p{L}\\p{N}_])';

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '');
const normKey = (s) => fold(String(s)).toLowerCase().replace(/[’]/g, "'");
const phraseSource = (tok) => tok.split(/[\s-]+/).filter(Boolean).map((p) => escRe(p).replace(/'/g, "['’]")).join('[\\s-]+');

// ── pattern detectors (no lexicon needed) ───────────────────────────────────
const PATTERNS = [
  ['secret',    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['secret',    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['secret',    /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['secret',    /\b(?:sk|pk|rk|xox[bap])-[A-Za-z0-9_-]{16,}\b/g],
  ['secret',    /\b\d{8,10}:[A-Za-z0-9_-]{34,}\b/g],
  ['secret',    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi],
  ['secret',    /\b[A-Fa-f0-9]{40,}\b/g],
  ['email',     /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g],
  ['id_number', /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi],
  ['phone',     /(?<![\d])(?:\+\s?44[\s-]?\(?0?\)?[\s-]?|0)(?:\d[\s-]?){9,10}(?!\d)/g],
  ['phone',     /(?<![\d])\+\d{1,3}[\s-]?\d(?:[\s-]?\d){7,12}(?!\d)/g],
  ['id_number', /(?<!\d)\d{3}[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g],
  ['postcode',  /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi],
];

const PLACEHOLDER_RE = /\[(?:child|parent|staff|address|name|email|phone|postcode|id_number|secret)\]/g;

class RedactionError extends Error {
  constructor(code, message, detail) { super(message); this.name = 'RedactionError'; this.code = code; this.detail = detail || null; }
}

function tokensOf(value) {
  const raw = String(value || '').replace(/[’]/g, "'").trim();
  if (!raw) return [];
  const parts = raw.split(/[\s,;/&+()]+/).map((p) => p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '')).filter(Boolean);
  const out = new Set();
  for (const p of parts) {
    if (p.length < 2 || /^\d+$/.test(p)) continue;
    if (NEVER_A_NAME.has(normKey(p))) continue;
    out.add(p);
  }
  // the whole "Mary Jane O'Brien" phrase too, so it is masked as one thing
  if (parts.length > 1 && parts.length <= 5 && parts.every((p) => !NEVER_A_NAME.has(normKey(p)))) out.add(parts.join(' '));
  return [...out];
}

// A stored "address" can be just a town ("Ealing", "West London") — not identifying, and masking it
// would rewrite every sentence that names the nursery's own borough. Only street-shaped values count:
// a house number, or a street-type word. (Postcodes are caught by pattern regardless.)
const STREET_WORD = /\b(street|st|road|rd|avenue|ave|lane|ln|close|drive|dr|gardens|court|way|place|square|terrace|crescent|grove|mews|row|hill|park|walk|green|rise|view|villas|parade|gate|path)\b/i;
const looksLikeStreet = (p) => /\d/.test(p) || STREET_WORD.test(p);

function addressPhrases(value) {
  const raw = String(value || '').replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
  if (raw.length < 5 || !looksLikeStreet(raw)) return [];
  const out = new Set([raw]);
  const noNumber = raw.replace(/^\s*(?:flat\s+)?\d+[a-z]?\s*[,-]?\s*/i, '').trim(); // "12 Acacia Avenue" -> "Acacia Avenue"
  if (noNumber.length >= 5 && /\s/.test(noNumber) && STREET_WORD.test(noNumber)) out.add(noNumber);
  return [...out];
}

// ── ordinary vocabulary ─────────────────────────────────────────────────────────────────────────
// An imported database holds junk in its name fields (a staff record whose name is "Active"), and
// nursery children have word-names (Teddy, Storm, Ocean). Neither can be fixed with a list. So the
// lexicon is data-driven: any token that appears as a plain lowercase word in Wren's own prompt,
// tool text or manuals is matched only when Capitalised or UPPER — how a name is typed, and how
// Whisper writes it — instead of being masked wherever it occurs as a word. It is never DROPPED.
// The cost, stated plainly: a word-name typed entirely in lower case ("teddy") is not caught.
const STATIC_VOCAB = new Set();
const lowerWords = (text) => String(text || '').match(/(?<![A-Za-z])[a-z]{3,}(?![A-Za-z])/g) || [];
function registerVocabulary(text) { for (const w of lowerWords(text)) STATIC_VOCAB.add(w); }

class Lexicon {
  constructor(vocab) {
    this.vocab = vocab || STATIC_VOCAB;
    this.typeOf = new Map();         // normKey(token) -> 'child'|'parent'|'staff'|'address'|'name'
    this.spell = new Map();          // normKey(token) -> Set of spellings (as recorded, and accent-folded)
    this.stats = { tokens: 0, child: 0, parent: 0, staff: 0, address: 0, loadedAt: null };
    this._insens = null; this._caps = null; this._capsMid = null; this._built = false;
  }

  add(token, type) {
    const key = normKey(token);
    if (!key || key.length < 2) return;
    if (type !== 'address' && NEVER_A_NAME.has(key)) return;      // enforced here too, not only in tokensOf()
    if (!this.spell.has(key)) this.spell.set(key, new Set());
    this.spell.get(key).add(String(token).replace(/[’]/g, "'")).add(fold(String(token)).replace(/[’]/g, "'"));
    const seen = this.typeOf.get(key);
    if (seen && seen !== type) this.typeOf.set(key, seen === 'address' || type === 'address' ? 'address' : 'name');
    else if (!seen) { this.typeOf.set(key, type); this.stats[type] = (this.stats[type] || 0) + 1; }
    this._built = false;
  }

  _build() {
    const insens = []; const caps = []; const capsMid = [];
    for (const [key, set] of this.spell) {
      const type = this.typeOf.get(key);
      const single = !/[\s-]/.test(key);
      for (const sp of set) {
        if (single && type !== 'address' && (COMMON_WORDS.has(key) || this.vocab.has(key))) {
          const cap = sp.charAt(0).toUpperCase() + sp.slice(1);
          const forms = [escRe(cap).replace(/'/g, "['’]"), escRe(sp.toUpperCase()).replace(/'/g, "['’]")];
          (SENT_START_EXEMPT.has(key) ? capsMid : caps).push(...forms);
        } else {
          insens.push(phraseSource(sp));
        }
      }
    }
    const byLen = (a, b) => b.length - a.length;
    const mk = (alts, flags) => (alts.length ? new RegExp(B_L + '(?:' + [...new Set(alts)].sort(byLen).join('|') + ')' + B_R, flags) : null);
    this._insens = mk(insens, 'giu');
    this._caps = mk(caps, 'gu');
    // not at the start of the text or straight after . ! ? — "Can you show me…" is a question, not a person
    this._capsMid = capsMid.length ? new RegExp('(?<!(?:^|[.!?]\\s+))' + B_L + '(?:' + [...new Set(capsMid)].sort(byLen).join('|') + ')' + B_R, 'gu') : null;
    this._built = true;
  }

  _regexes() { if (!this._built) this._build(); return [this._insens, this._caps, this._capsMid].filter(Boolean); }

  placeholder(matched) {
    const k = normKey(matched).replace(/\s+/g, ' ');
    const t = this.typeOf.get(k) || this.typeOf.get(k.replace(/-/g, ' ')) || this.typeOf.get(k.replace(/ /g, '-')) || 'name';
    return '[' + t + ']';
  }

  /** every detector hit in `text`: [{type, index, length}] — used by redact() and verify() alike. */
  scan(text) {
    const hits = [];
    const s = String(text);
    for (const [type, re] of PATTERNS) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(s))) { hits.push({ type, index: m.index, length: m[0].length }); if (m[0].length === 0) re.lastIndex++; }
    }
    for (const re of this._regexes()) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(s))) { hits.push({ type: this.placeholder(m[0]).slice(1, -1), index: m.index, length: m[0].length }); if (m[0].length === 0) re.lastIndex++; }
    }
    return hits;
  }

  /** Mask `text`. Returns { text, counts, total }. Throws RedactionError if anything survives. */
  redact(text) {
    let s = String(text == null ? '' : text);
    const counts = {};
    const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
    for (const [type, re] of PATTERNS) s = s.replace(re, () => { bump(type); return '[' + type + ']'; });
    for (const re of this._regexes()) s = s.replace(re, (m) => { const ph = this.placeholder(m); bump(ph.slice(1, -1)); return ph; });
    const left = this.scan(s.replace(PLACEHOLDER_RE, ' '));
    if (left.length) {
      throw new RedactionError('residual_after_redaction', 'Redaction left ' + left.length + ' identifying item(s) in the payload — not sent.',
        { types: [...new Set(left.map((h) => h.type))] });
    }
    return { text: s, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  }

  /** [] when clean, otherwise the hit list (positions + types, never the matched text). */
  verify(text) { return this.scan(String(text).replace(PLACEHOLDER_RE, ' ')); }

  /**
   * redact every string leaf of a JSON-shaped value; keys are structure, not content.
   * `skipKeys` names keys whose VALUE is structure too (roles, function names, the static tool
   * declarations, Gemini's opaque thoughtSignature — which must go back byte-for-byte).
   */
  redactDeep(value, { skipKeys = [] } = {}) {
    const skip = new Set(skipKeys);
    const counts = {};
    const walk = (v) => {
      if (typeof v === 'string') {
        const r = this.redact(v);
        for (const [k, n] of Object.entries(r.counts)) counts[k] = (counts[k] || 0) + n;
        return r.text;
      }
      if (Array.isArray(v)) return v.map(walk);
      // { __static: true, text } is OUR OWN fixed instruction text: passed through untouched, marker removed.
      // Only server code builds request bodies, so nothing a person types can carry this marker.
      if (v && typeof v === 'object' && v.__static === true) { const o = Object.assign({}, v); delete o.__static; return o; }
      if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = skip.has(k) ? x : walk(x); return o; }
      return v;
    };
    const out = walk(value);
    return { value: out, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  }
}

/**
 * Build a lexicon from the tenant schema. `db` is anything with .query (a pool, or a client in
 * a transaction — the verify script uses the latter). `extra` = [{name, type}] adds names the
 * records do not hold (used to test the gate without reading a real child).
 */
async function loadLexicon(db, { extra = [] } = {}) {
  const vocab = new Set(STATIC_VOCAB);
  try {
    const d = await db.query("SELECT string_agg(body, ' ') AS t FROM wren_chat_doc_chunks");
    for (const w of lowerWords(d.rows[0] && d.rows[0].t)) vocab.add(w);
  } catch (_) { /* no docs table / no docs yet: the static vocabulary alone */ }
  const lex = new Lexicon(vocab);
  try {
    const schemaRow = await db.query('SELECT current_schema() AS s');
    const schema = schemaRow.rows[0].s;
    const cols = await db.query(
      'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2)',
      [schema, NAME_SOURCES.map((x) => x.table)]);
    const have = new Map();
    for (const r of cols.rows) { if (!have.has(r.table_name)) have.set(r.table_name, new Set()); have.get(r.table_name).add(r.column_name); }

    for (const src of NAME_SOURCES) {
      const present = have.get(src.table);
      if (!present) continue;
      const use = src.cols.filter(([c]) => present.has(c));
      if (!use.length) continue;
      const sql = use.map(([c, t]) => `SELECT '${t}' AS t, "${c}"::text AS v FROM "${src.table}" WHERE "${c}" IS NOT NULL`).join(' UNION ');
      const { rows } = await db.query(sql);
      for (const r of rows) {
        if (r.t === 'address') addressPhrases(r.v).forEach((p) => lex.add(p, 'address'));
        else tokensOf(r.v).forEach((tk) => lex.add(tk, r.t));
      }
    }

    if (have.size === 0 && !extra.length) {
      throw new RedactionError('lexicon_unavailable', 'None of the name tables exist in schema ' + schema + ' — refusing to send anything.');
    }
    if (have.has('children')) {
      const c = await db.query('SELECT count(*)::int AS n FROM "children"');
      if (c.rows[0].n > 0 && (lex.stats.child + lex.stats.parent) === 0 && !extra.length) {
        throw new RedactionError('lexicon_empty', 'Children exist but the name lexicon is empty — refusing to send anything.');
      }
    }
  } catch (e) {
    if (e instanceof RedactionError) throw e;
    throw new RedactionError('lexicon_unavailable', 'Could not build the redaction lexicon (' + (e && e.code || 'db error') + ') — nothing is sent while it is down.');
  }
  for (const x of extra) tokensOf(x.name).forEach((tk) => lex.add(tk, x.type || 'child'));
  lex.stats.tokens = lex.typeOf.size;
  lex.stats.loadedAt = new Date().toISOString();
  return lex;
}

// A short cache: new children are picked up within a minute, and the gate is not a database
// round-trip per model call. If a refresh fails the OLD lexicon is used only while it is
// younger than STALE_OK_MS; past that the gate stops.
const CACHE_MS = 30 * 1000;
const STALE_OK_MS = 5 * 60 * 1000;
let cache = { lex: null, at: 0, db: null };

async function getLexicon(db, opts) {
  if (opts && opts.extra && opts.extra.length) return loadLexicon(db, opts);   // never cache a test lexicon
  const now = Date.now();
  if (cache.lex && cache.db === db && now - cache.at < CACHE_MS) return cache.lex;
  try {
    const lex = await loadLexicon(db);
    cache = { lex, at: now, db };
    return lex;
  } catch (e) {
    if (cache.lex && cache.db === db && now - cache.at < STALE_OK_MS) return cache.lex;
    throw e;
  }
}

function resetLexiconCache() { cache = { lex: null, at: 0, db: null }; }

module.exports = { Lexicon, RedactionError, loadLexicon, getLexicon, resetLexiconCache, registerVocabulary, PATTERNS, NAME_SOURCES };
