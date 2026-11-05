'use strict';
/*
 * b218 (2026-08-24) — gathering next steps into area intentions.
 *
 * The point of this file: at the end of a half-term a practitioner who owns an
 * EYFS area should be HANDED a ranked, pre-written list of intentions drawn from
 * what has actually been observed across the setting — not sat in front of an
 * empty text box. So everything here is deterministic (no model call): the same
 * next steps always produce the same list, and every line can be traced back to
 * the rows it came from.
 *
 * Three jobs:
 *   1 · classify()  — which of the 7 areas (and which of the 17 sub-aspects) a
 *                     next step belongs to. Framework link first, then the
 *                     observation's own area tags, then the words themselves.
 *   2 · cluster()   — put the same next step, written six different ways by six
 *                     different people, into ONE row.
 *   3 · rank()      — order by how many children it would serve, then by how
 *                     often it recurs.
 *
 * ⚠️ Group observations (b183): rows sharing a group_uuid are ONE piece of
 * practice written about several children. Recurrence therefore counts distinct
 * occurrence keys (group_uuid, or the next-step id), while "children served"
 * counts distinct child_ids. Counting rows for both would multiply group work.
 */

// The canonical seven and their 2021 Development Matters sub-aspects. Mirrors
// public/js/resource-cards-filters.js — the SAME 17-term vocabulary the resource
// cards and the b211 sub-aspect picker use, so a gathered intention can be
// matched straight to provision.
const AREAS = [
  'Communication & Language',
  'Personal, Social & Emotional Development',
  'Physical Development',
  'Literacy',
  'Mathematics',
  'Understanding the World',
  'Expressive Arts & Design',
];

const ASPECTS_BY_AREA = {
  'Communication & Language': ['Listening, Attention & Understanding', 'Speaking'],
  'Personal, Social & Emotional Development': ['Self-Regulation', 'Managing Self', 'Building Relationships'],
  'Physical Development': ['Gross Motor Skills', 'Fine Motor Skills', 'Managing Self'],
  'Literacy': ['Comprehension', 'Word Reading', 'Writing'],
  'Mathematics': ['Number', 'Shape, Space & Measures'],
  'Understanding the World': ['Past & Present', 'People, Culture & Communities', 'The Natural World'],
  'Expressive Arts & Design': ['Creating with Materials', 'Being Imaginative & Expressive'],
};

// Area labels drift between sources: framework_statements and the resource cards
// spell the area out, observations.eyfs_areas and curriculum_activities store
// short codes. Same list as src/routes/next-steps.js AREA_ALIASES, extended with
// the spellings the EY observation form writes.
const AREA_ALIASES = {
  'CL': 'Communication & Language',
  'C&L': 'Communication & Language',
  'COMMUNICATION AND LANGUAGE': 'Communication & Language',
  'COMMUNICATION & LANGUAGE': 'Communication & Language',
  'PD': 'Physical Development',
  'PHYSICAL DEVELOPMENT': 'Physical Development',
  'PSED': 'Personal, Social & Emotional Development',
  'PSE': 'Personal, Social & Emotional Development',
  'PERSONAL, SOCIAL AND EMOTIONAL DEVELOPMENT': 'Personal, Social & Emotional Development',
  'PERSONAL, SOCIAL & EMOTIONAL DEVELOPMENT': 'Personal, Social & Emotional Development',
  'LIT': 'Literacy',
  'LITERACY': 'Literacy',
  'MATH': 'Mathematics', 'MATHS': 'Mathematics', 'M': 'Mathematics',
  'MATHEMATICS': 'Mathematics',
  'UW': 'Understanding the World',
  'UTW': 'Understanding the World',
  'UNDERSTANDING THE WORLD': 'Understanding the World',
  'EAD': 'Expressive Arts & Design',
  'EA&D': 'Expressive Arts & Design',
  'EXPRESSIVE ARTS AND DESIGN': 'Expressive Arts & Design',
  'EXPRESSIVE ARTS & DESIGN': 'Expressive Arts & Design',
};

/** Any spelling of an area → the canonical one, or null if unrecognised. */
function canonicalArea(a) {
  const s = String(a == null ? '' : a).trim();
  if (!s) return null;
  if (AREAS.includes(s)) return s;
  return AREA_ALIASES[s.toUpperCase()] || null;
}

// ── Keyword vocabulary ───────────────────────────────────────────────────────
// Used ONLY when a next step carries no framework link and no area tag — i.e.
// free text somebody typed on the floor. Phrases score higher than single words
// (a phrase match is far less likely to be a coincidence). Deliberately written
// in practitioner language, because that is what next steps are written in.
const SUB_AREA_KEYWORDS = {
  'Listening, Attention & Understanding': [
    'listen', 'listening', 'attention', 'attend to', 'concentrat', 'focus',
    'follow instruction', 'two-part instruction', 'understand', 'comprehend',
    'answer question', 'respond to', 'carpet time', 'group time',
  ],
  'Speaking': [
    'speak', 'speaking', 'talk about', 'talking', 'vocabulary', 'new words',
    'full sentence', 'sentences', 'conversation', 'describe', 'explain',
    'retell', 'ask questions', 'name objects', 'expressive language',
    'pronunciation', 'articulat', 'use language',
  ],
  'Self-Regulation': [
    'self-regulat', 'self regulat', 'regulate', 'calm', 'emotion', 'feelings',
    'frustrat', 'angry', 'upset', 'impulse', 'wait for', 'patience',
    'perseve', 'resilien', 'manage big feelings', 'strategies to calm',
  ],
  'Managing Self': [
    'independen', 'independently', 'own coat', 'put on their coat', 'zip',
    'button', 'dress', 'toilet', 'nappy', 'wash hands', 'handwashing',
    'self-care', 'self care', 'tidy up', 'look after', 'healthy choice',
    'brush teeth', 'feed themselves', 'own shoes', 'manage own',
  ],
  'Building Relationships': [
    'friend', 'friendship', 'share', 'sharing', 'take turns', 'turn-taking',
    'turn taking', 'play alongside', 'play with others', 'cooperat',
    'join in', 'peers', 'conflict', 'kindness', 'invite others', 'group play',
  ],
  'Gross Motor Skills': [
    'run', 'running', 'jump', 'climb', 'balanc', 'throw', 'catch', 'kick',
    'ride a', 'bike', 'scooter', 'hop', 'skip', 'crawl', 'obstacle course',
    'large muscle', 'gross motor', 'coordination', 'ball skills', 'core strength',
  ],
  'Fine Motor Skills': [
    'scissors', 'cutting', 'cut along', 'pencil grip', 'tripod', 'threading',
    'thread', 'tweezers', 'pincer', 'playdough', 'dough', 'fine motor',
    'small muscle', 'tongs', 'pegs', 'fasten', 'manipulat', 'hand strength',
  ],
  'Comprehension': [
    'story', 'stories', 'book', 'books', 'retell the', 'character',
    'sequence the', 'predict', 'favourite book', 'talk about the story',
    'story language', 'listen to stories', 'discuss the book',
  ],
  'Word Reading': [
    'phoneme', 'grapheme', 'blend', 'segment', 'phonics', 'decode',
    'initial sound', 'letter sound', 'rhyme', 'rhyming', 'alliteration',
    'recognise their name', 'name recognition', 'read simple', 'sound out',
  ],
  'Writing': [
    'write', 'writing', 'mark making', 'mark-making', 'write their name',
    'letter formation', 'form letters', 'emergent writing', 'label',
    'hold a pencil', 'draw and write', 'write a list',
  ],
  'Number': [
    'count', 'counting', 'number', 'numeral', 'subitis', 'subitiz',
    'one to one correspondence', '1:1 correspondence', 'more than', 'fewer',
    'add', 'take away', 'total', 'how many', 'quantity', 'amount',
  ],
  'Shape, Space & Measures': [
    'shape', 'pattern', 'repeating pattern', 'size', 'measur', 'length',
    'heavy', 'capacity', 'position', 'under', 'behind', 'sort by',
    'compar', '2d', '3d', 'weight', 'longer', 'shorter', 'spatial',
  ],
  'Past & Present': [
    'past', 'long ago', 'when they were a baby', 'then and now', 'history',
    'old and new', 'timeline', 'grew up', 'in the past',
  ],
  'People, Culture & Communities': [
    'community', 'culture', 'celebrat', 'festival', 'diwali', 'eid',
    'christmas', 'family', 'families', 'similarities and difference',
    'people who help us', 'occupation', 'tradition', 'religion', 'our local',
  ],
  'The Natural World': [
    'plant', 'growing', 'seed', 'minibeast', 'mini-beast', 'insect', 'animal',
    'weather', 'season', 'nature', 'garden', 'life cycle', 'float', 'sink',
    'magnet', 'ice', 'melt', 'forest school', 'outdoor area', 'natural material',
  ],
  'Creating with Materials': [
    'paint', 'painting', 'collage', 'junk model', 'clay', 'colour mixing',
    'mixing colours', 'glue', 'printing', 'texture', 'construct', 'building with',
    'sculpt', 'craft', 'malleable',
  ],
  'Being Imaginative & Expressive': [
    'role play', 'role-play', 'imaginat', 'imaginative', 'pretend', 'small world',
    'sing', 'song', 'music', 'instrument', 'danc', 'perform', 'puppet',
    'dressing up', 'dress up', 'storytelling', 'home corner',
  ],
};

const SUB_AREA_TO_AREA = (() => {
  const m = {};
  for (const [area, subs] of Object.entries(ASPECTS_BY_AREA)) {
    // 'Managing Self' lives under BOTH PSED and PD. PSED wins for a bare keyword
    // hit: self-care next steps are written about the child managing themselves,
    // and PD's Managing Self statements are the health/self-care overlap.
    for (const s of subs) if (!m[s]) m[s] = area;
  }
  return m;
})();

// ── Text handling ────────────────────────────────────────────────────────────

const STOPWORDS = new Set(('a an the and or but to of for with in on at by from is are was were be been being ' +
  'his her their they them he she it its this that these those will would can could should shall may might ' +
  'do does did done have has had having i we you your our my me us not no yes so as if then than when while ' +
  'more most some any all both each other another next step steps continue continues continuing needs need ' +
  'child children encourage encouraged encouraging support supporting supported help helping helped ' +
  'provide providing opportunities opportunity practise practice practising during using use used ' +
  'across further work working towards develop developing').split(/\s+/));

/** Crude English suffix stripper — enough to fold cutting/cut, counting/count. */
function stem(w) {
  if (w.length <= 4) return w;
  if (w.endsWith('ing') && w.length > 6) {
    let s = w.slice(0, -3);
    if (s.length > 3 && s[s.length - 1] === s[s.length - 2]) s = s.slice(0, -1);  // cutting -> cut
    return s;
  }
  if (w.endsWith('ed') && w.length > 5) {
    let s = w.slice(0, -2);
    if (s.length > 3 && s[s.length - 1] === s[s.length - 2]) s = s.slice(0, -1);
    return s;
  }
  if (w.endsWith('ies') && w.length > 5) return w.slice(0, -3) + 'y';
  if (w.endsWith('es')  && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('s')   && w.length > 4) return w.slice(0, -1);
  return w;
}

/**
 * Tokenise a next step for clustering. Child first names are dropped: the SAME
 * intention written about six children must land in one cluster, and the names
 * are carried separately anyway (and must not end up in the intention text).
 */
function tokenise(text, nameSet) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !STOPWORDS.has(w))
    .filter(w => !(nameSet && nameSet.has(w)))
    .map(stem)
    .filter(w => w.length > 2);
}

/**
 * Swap child names out of a phrase so a shared intention reads generically.
 *
 * Deleting the name outright leaves "Encourage to use scissors", so the name is
 * REPLACED — with 'children' for a group intention, 'the child' for a solo one.
 * Names must not survive into an intention text that a whole room will read.
 */
function depersonalise(text, nameSet, replacement) {
  const rep = replacement === undefined ? 'children' : replacement;
  let s = String(text || '').trim();
  if (nameSet && nameSet.size) {
    s = s.split(/\b/).map(tok => (nameSet.has(tok.toLowerCase()) ? rep : tok)).join('');
  }
  if (rep) {
    // "Amelia and Noah" both became the replacement — say it once.
    const r = rep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`\\b${r}(\\s*(,|and|&)\\s*${r})+\\b`, 'gi'), rep);
  }
  // Swapping a name for a plural subject breaks agreement — "Bailey needs more
  // practice" would read "Children needs more practice". Fix the handful of verbs
  // that actually turn up at the front of a next step.
  if (/children/i.test(rep)) {
    s = s.replace(/\bchildren\s+needs\b/gi, 'children need')
         .replace(/\bchildren\s+is\b/gi,    'children are')
         .replace(/\bchildren\s+has\b/gi,   'children have')
         .replace(/\bchildren\s+was\b/gi,   'children were')
         .replace(/\bchildren\s+does\b/gi,  'children do')
         .replace(/\bchildren\s+'s\b/gi,    "children's");
  }
  s = s.replace(/\s{2,}/g, ' ')
       .replace(/^\s*[-–—•*]+\s*/, '')
       .replace(/^\s*(to|for|with|and)\s+/i, '')
       .replace(/\s+([,.;:])/g, '$1')
       .replace(/^[,.;:\s]+/, '')
       .trim();
  if (!s) return String(text || '').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Which area/sub-aspect does this next step belong to?
 *
 * hints: { frameworkArea, frameworkSubArea, obsAreas: [] }
 * Returns { area, sub_area, via, score } — via records HOW we decided, and is
 * shown in the UI so a practitioner can see that a keyword guess is a guess.
 */
function classify(text, hints) {
  const h = hints || {};

  // 1 · the framework statement the next step was written from. Authoritative.
  const fwArea = canonicalArea(h.frameworkArea);
  if (fwArea) {
    return { area: fwArea, sub_area: h.frameworkSubArea || subAreaFromText(text, fwArea) || null,
             via: 'framework', score: 100 };
  }

  // 2 · the observation's own area tags. The practitioner ticked these at the time.
  const tagged = (h.obsAreas || []).map(canonicalArea).filter(Boolean);
  if (tagged.length) {
    // A single tag is a clean answer; several means the observation spanned areas,
    // so let the words break the tie between the tags the practitioner chose.
    const picked = tagged.length === 1 ? tagged[0] : (bestOfAreas(text, tagged) || tagged[0]);
    return { area: picked, sub_area: subAreaFromText(text, picked), via: 'observation_tag', score: 70 };
  }

  // 3 · the words themselves.
  const kw = keywordMatch(text);
  if (kw) return { area: kw.area, sub_area: kw.sub_area, via: 'keywords', score: kw.score };

  return { area: null, sub_area: null, via: 'unsorted', score: 0 };
}

// Keywords match at a WORD START, not anywhere in the string: plain
// String.includes made 'count' fire on "encounter" and 'sing' on "using", which
// filed next steps under the wrong practitioner. Stems still work — 'balanc'
// catches balance and balancing — because only the START is anchored.
const _kwRe = new Map();
function kwRegex(k) {
  let re = _kwRe.get(k);
  if (!re) { re = new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); _kwRe.set(k, re); }
  return re;
}

function scoreFor(lower, keys) {
  let score = 0;
  for (const k of keys) {
    if (!kwRegex(k).test(lower)) continue;
    // A multi-word phrase is much stronger evidence than a single stem.
    score += k.includes(' ') ? 3 : 1;
  }
  return score;
}

function keywordMatch(text) {
  const lower = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ') + ' ';
  let best = null;
  for (const [sub, keys] of Object.entries(SUB_AREA_KEYWORDS)) {
    const score = scoreFor(lower, keys);
    if (score > 0 && (!best || score > best.score)) {
      best = { sub_area: sub, area: SUB_AREA_TO_AREA[sub], score };
    }
  }
  return best;
}

/** Best sub-aspect for text WITHIN a known area (never leaves that area). */
function subAreaFromText(text, area) {
  const subs = ASPECTS_BY_AREA[area] || [];
  const lower = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ') + ' ';
  let best = null;
  for (const sub of subs) {
    const score = scoreFor(lower, SUB_AREA_KEYWORDS[sub] || []);
    if (score > 0 && (!best || score > best.score)) best = { sub, score };
  }
  return best ? best.sub : null;
}

/** Of the areas a practitioner tagged, which do the words point at? */
function bestOfAreas(text, areas) {
  let best = null;
  for (const area of areas) {
    const subs = ASPECTS_BY_AREA[area] || [];
    const lower = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ') + ' ';
    let score = 0;
    for (const sub of subs) score += scoreFor(lower, SUB_AREA_KEYWORDS[sub] || []);
    if (score > 0 && (!best || score > best.score)) best = { area, score };
  }
  return best ? best.area : null;
}

// ── Clustering ───────────────────────────────────────────────────────────────

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Group items that say the same thing.
 *
 * items: [{ key, text, child_id, occurrence_key, ... }]
 * Exact token-signature matches merge first (cheap and certain), then near
 * matches are merged greedily from the largest cluster down, so the dominant
 * phrasing of an intention wins rather than whichever row happened to be first.
 *
 * MIN_OVERLAP guards the small-set case: two 2-token next steps sharing one
 * token would otherwise score 0.33 and stay apart, while two sharing both are
 * genuinely the same step.
 */
const SIMILARITY = 0.5;
function bigrams(toks) {
  const out = new Set();
  for (let i = 0; i + 1 < toks.length; i++) out.add(toks[i] + ' ' + toks[i + 1]);
  return out;
}

function cluster(items, nameSet) {
  const prepared = items.map(it => {
    const toks = tokenise(it.text, nameSet);
    return Object.assign({}, it, {
      _tokens: new Set(toks), _bi: bigrams(toks), _sig: [...new Set(toks)].sort().join(' '),
    });
  });

  // Pass 1 — identical token signatures.
  const bySig = new Map();
  for (const it of prepared) {
    if (!it._sig) continue;                       // nothing but stopwords — skip, not clusterable
    if (!bySig.has(it._sig)) bySig.set(it._sig, { tokens: it._tokens, bi: new Set(it._bi), items: [] });
    const g = bySig.get(it._sig);
    for (const b of it._bi) g.bi.add(b);
    g.items.push(it);
  }

  // Pass 2 — near matches, largest first.
  const groups = [...bySig.values()].sort((a, b) => b.items.length - a.items.length);
  const clusters = [];
  for (const g of groups) {
    let merged = false;
    for (const c of clusters) {
      const sim = jaccard(g.tokens, c.tokens);
      let shared = 0;
      for (const t of g.tokens) if (c.tokens.has(t)) shared++;
      const smallest = Math.min(g.tokens.size, c.tokens.size);
      const enough = smallest <= 2 ? shared >= smallest : shared >= 2;
      // A shared two-word phrase is the strongest signal there is: "full sentenc"
      // in both of "use full sentences in conversation" and "use full sentences
      // when talking about their play" is one intention written twice, even
      // though only two tokens overlap and the Jaccard score is 0.33.
      let sharedBi = 0;
      for (const b of g.bi) if (c.bi.has(b)) sharedBi++;
      // Three content words in common IS the same next step, even when one side
      // is wordier and drags the Jaccard score below the threshold — "snip along
      // a straight line with scissors" vs "cutting with scissors along a line".
      if (shared >= 3 || (sharedBi >= 1 && shared >= 2) || (sim >= SIMILARITY && enough)) {
        c.items.push(...g.items);
        for (const t of g.tokens) c.tokens.add(t);
        for (const b of g.bi) c.bi.add(b);
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push({ tokens: new Set(g.tokens), bi: new Set(g.bi), items: [...g.items] });
  }
  return clusters;
}

/**
 * The pre-written intention for a cluster: the phrasing MOST people used, with
 * child names taken out. Ties break towards the longer text — the fuller version
 * of the same idea is the more useful thing to hand somebody.
 */
function intentionTextFor(clusterItems, nameSet, childCount) {
  const counts = new Map();
  for (const it of clusterItems) {
    const t = String(it.text || '').trim().replace(/\s+/g, ' ');
    if (!t) continue;
    const k = t.toLowerCase();
    const cur = counts.get(k) || { n: 0, text: t };
    cur.n++;
    if (t.length > cur.text.length) cur.text = t;
    counts.set(k, cur);
  }
  // "Bailey needs more practice cutting…" and "Give Bailey opportunities to cut…"
  // say the same thing, but only the second still reads as an instruction once the
  // name comes out. Where phrasings are equally common, prefer the one that opens
  // with a verb rather than a child's name.
  const opensWithName = t => {
    const first = String(t).trim().split(/\s+/)[0] || '';
    return nameSet ? nameSet.has(first.toLowerCase().replace(/[^a-z]/g, '')) : false;
  };
  const best = [...counts.values()].sort((a, b) =>
    b.n - a.n
    || (opensWithName(a.text) ? 1 : 0) - (opensWithName(b.text) ? 1 : 0)
    || b.text.length - a.text.length)[0];
  const rep = (childCount === undefined || childCount > 1) ? 'children' : 'the child';
  return best ? depersonalise(best.text, nameSet, rep) : '';
}

/** Stable id for a cluster, so ticking the same one twice cannot double-adopt. */
function clusterKey(area, tokens) {
  const sig = [...tokens].sort().join('-').slice(0, 160);
  return `${(area || 'unsorted').toLowerCase().replace(/[^a-z]+/g, '-')}:${sig}`;
}

module.exports = {
  AREAS, ASPECTS_BY_AREA, SUB_AREA_KEYWORDS, SUB_AREA_TO_AREA,
  canonicalArea, classify, subAreaFromText, keywordMatch,
  tokenise, stem, depersonalise, cluster, intentionTextFor, clusterKey, jaccard,
};
