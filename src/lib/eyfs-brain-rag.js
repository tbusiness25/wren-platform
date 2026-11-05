'use strict';
/**
 * eyfs-brain-rag.js — retrieval for b156 "EYFS Brain": grounds the staff chat assistant
 * (POST /api/ai/chat, eyfs/admin/hr personas) in a licence-clean EYFS practice corpus —
 * statutory framework, Development Matters, SEND Code of Practice, DfE CPD guidance,
 * Wren's own Fledge framework, Your Nursery' own policies, and the Wren Phonics pack.
 * Built by scripts/eyfs-brain-ingest.js — see /app-docs/eyfs-brain/corpus-manifest.md
 * for the full source registry (what's in, what's deliberately excluded and why).
 *
 * Retrieval is HYBRID, not qdrant-first-FTS-on-error-only like the sibling apprentice-rag.js/
 * history-rag.js. Verified 2026-07-23: this corpus mixes a large majority of narrative DfE/
 * gov-corpus prose with a small but important minority of dense, statement-coded content
 * (Wren's own Fledge framework, Wren Phonics GPC lists) — nomic-embed-text's cosine ranking
 * consistently buries the dense minority below page after page of generically-similar prose
 * (a literal "Wren Fledge curriculum" query didn't surface a single Fledge chunk in the raw
 * top 50 of 1613 points). Running Postgres FTS in parallel and merging guarantees an exact
 * keyword hit (e.g. "Fledge", "Fledge Framework v0.2") always reaches the rerank stage
 * instead of depending entirely on embedding-space luck.
 */

// b333: embedding host and model from ai-models.js, per call (role 'embed' — the nomic
// model eyfs_brain_v1 was built with).
const ai = require('./ai-models');
const QDRANT_URL  = process.env.EYFS_BRAIN_QDRANT_URL || 'http://qdrant-work:6333';
const COLLECTION  = 'eyfs_brain_v1';
const USE_QDRANT  = process.env.EYFS_BRAIN_USE_QDRANT !== 'false';

// nomic-embed-text has a noisy baseline cosine (~0.50-0.59 even for unrelated text) — same
// two-tier gate as apprentice-rag.js: FLOOR to be considered at all, STRONG to trust alone.
const SCORE_FLOOR  = parseFloat(process.env.EYFS_BRAIN_SCORE_FLOOR  || '0.55');
const SCORE_STRONG = parseFloat(process.env.EYFS_BRAIN_SCORE_STRONG || '0.62');

// Domain synonym expansion for the FTS fallback — maps everyday nursery phrasing onto the
// vocabulary actually used in statutory/DfE text, so recall doesn't depend on jargon match.
const SYNONYMS = {
  'tummy time':      'physical development gross motor prone floor-based movement',
  'key worker':       'key person attachment settling relationship',
  'settling in':      'key person transition attachment separation anxiety',
  'tantrum':          'behaviour self-regulation emotion dysregulation',
  'meltdown':         'self-regulation emotion sensory dysregulation behaviour',
  'fussy eater':      'nutrition food refusal sensory food education healthy eating',
  'weaning':          'nutrition food safety infant feeding',
  'send':             'special educational needs disability inclusion send code of practice',
  'ehcp':             'education health and care plan send',
  'two year check':   'progress check integrated review two-year-old',
  'ratios':           'staff child ratios statutory framework qualifications',
  'ofsted':           'inspection statutory framework registration',
  'funded hours':     'funded early education entitlement statutory guidance local authorities',
  'stretched funding': 'funded early education entitlement statutory guidance local authorities',
  'phonics':          'phonics grapheme phoneme literacy communication language',
  'school readiness': 'literacy communication language physical development independence',
};

// q03 (2026-07-24) factuality stress test — hand-curated, guaranteed-recall "quick facts" for
// the small set of precise numeric statutory figures where the generic hybrid retrieval
// demonstrably failed: instrumenting retrieve() directly showed that for plain-language ratio/
// floor-space questions, the ~3000-char native gov-corpus chunks either (a) didn't surface the
// right paragraph in the top-6 candidates at all (e.g. "is it 1:4 or 1:5 for 2yo" pulled funding
// and infant-class-size chunks instead of EYFS Statutory Framework para 3.48), or (b) surfaced
// the right chunk but buildGroundingBlock()'s old 900-char-per-chunk slice cut off before
// reaching the actual number (verified: "three children" for under-2s sits at char 1797 of a
// 3199-char chunk; "every eight children" for 3-4s-without-QTS sits at char 1904). The model's
// documented response to a truncated/absent number is to decline (safe) — but one live run also
// showed it substitute a DIFFERENT nearby ratio (1:13, from the wrong provision) instead of
// declining, which is the dangerous direction. A prompt instruction alone can't fix a retrieval
// recall/truncation gap — these entries bypass both problems by being short, exact, and always
// promoted (same guaranteed-inclusion pattern as namedEntityCandidates below), independent of
// embedding noise or chunk-size truncation.
// ALSO SURFACED: Your Nursery' own ingested "5.1 Staffing" policy (real doc, last reviewed by
// the office manager Dec 2023) states the PRE-2024 two-year-old ratio (1 adult : 4 children) —
// this is now stale against the current EYFS Statutory Framework 2024 (1:5, para 3.48), and nothing
// stops the RAG confidently citing the stale internal policy as if it were the correct statutory
// figure. The quick-fact text below calls this discrepancy out explicitly rather than silently
// picking a side, and Toby has been flagged separately to get the real policy document updated
// (see wren-docs/qa/q03-brain-factuality-2026-07-24.md) — this code change cannot fix a paper
// policy, only stop the assistant from repeating it uncritically.
const STATUTORY_FRAMEWORK_URL = 'https://assets.publishing.service.gov.uk/media/68c024cb8c6d992f23edd79c/Early_years_foundation_stage_statutory_framework_-_for_group_and_school-based_providers.pdf.pdf';
const QUICK_FACTS = [
  {
    keys: ['ratio', 'ratios', '1:3', '1:4', '1:5', '1:8', '1:13', 'staff:child', 'staff to child', 'children per staff', 'per member of staff', 'child:staff'],
    source_label: 'Wren Verified Quick-Facts — EYFS statutory staff:child ratios',
    source_url: STATUTORY_FRAMEWORK_URL,
    licence: 'ogl_v3',
    category: 'statutory',
    title: 'EYFS Statutory Framework 2024 — staff:child ratios (paras 3.47-3.52), verbatim',
    text: `Verbatim staff:child ratios from the EYFS Statutory Framework 2024 (paras 3.47-3.50), for registered early years providers such as Your Nursery (NOT the separate school-only figures in paras 3.51-3.53):
- Children under 2: at least 1 member of staff for every 3 children (para 3.47). At least one staff member holding an approved level 3 qualification, suitably experienced with under-twos.
- Children aged 2: at least 1 member of staff for every 5 children (para 3.48).
- Children aged 3+, where NO person with QTS/EYPS/EYTS is working directly with the children: at least 1 member of staff for every 8 children (para 3.50).
- Children aged 3+, where a person WITH QTS/EYPS/EYTS IS working directly with the children: at least 1 member of staff for every 13 children (para 3.49) — this figure applies to registered early years provision generally, not only schools.
- Ofsted may require a higher (lower child-per-staff) ratio than these statutory minimums where necessary for safety and welfare (footnote 36).
IMPORTANT DISCREPANCY TO FLAG, DO NOT SILENTLY PICK A SIDE: Your Nursery' own ingested "5.1 Staffing" policy document (last reviewed by the office manager, Dec 2023) states the PRE-2024 two-year-old ratio of 1 adult : 4 children. This predates the current EYFS Statutory Framework 2024 change to 1:5 for two-year-olds and has not been updated. If asked about the setting's own policy ratio versus the current legal minimum, say both numbers and flag that the internal policy document looks out of date rather than presenting either one as the single correct answer.`,
  },
  {
    keys: ['floor space', 'indoor space', 'square met', 'sq m', 'sqm', 'm2 per child', 'space per child', 'space requirement'],
    source_label: 'Wren Verified Quick-Facts — EYFS statutory indoor space requirements',
    source_url: STATUTORY_FRAMEWORK_URL,
    licence: 'ogl_v3',
    category: 'statutory',
    title: 'EYFS Statutory Framework 2024 — indoor space requirements (para 3.81), verbatim',
    text: `Verbatim indoor space requirements from the EYFS Statutory Framework 2024, para 3.81 (useable room area, excludes storage/thoroughfares/staff areas/cloakrooms/utility rooms/kitchens/toilets):
- Children under 2 years: 3.5 square metres per child.
- Two-year-olds: 2.5 square metres per child.
- Children aged 3 to 5 years: 2.3 square metres per child.
Where these space standards are applied, providers cannot increase the number of children on roll by additionally using an outside area (para 3.82).`,
  },
  {
    // requireAll, not keys (OR) — "literacy" alone is far too common a word in this corpus to
    // safely trigger a Literacy-specific fact block; needs the ELG angle too. Verified 2026-07-24:
    // raising the general truncation slice surfaced enough noisy near-matches that a plain-language
    // "list the ELGs for Literacy" question got a confident but non-verbatim paraphrase ("Reading" /
    // "Writing") instead of the real three goals (Comprehension / Word Reading / Writing) — this is
    // the exact verbatim text from the EYFS Statutory Framework 2024 chunk that already contains it.
    requireAll: ['literacy', ['elg', 'early learning goal']],
    source_label: 'Wren Verified Quick-Facts — EYFS Literacy Early Learning Goals',
    source_url: STATUTORY_FRAMEWORK_URL,
    licence: 'ogl_v3',
    category: 'statutory',
    title: 'EYFS Statutory Framework 2024 — Literacy Early Learning Goals, verbatim',
    text: `Verbatim from the EYFS Statutory Framework 2024, Early Learning Goals — Literacy:
ELG: Comprehension. Children at the expected level of development will:
- Demonstrate understanding of what has been read to them by retelling stories and narratives using their own words and recently introduced vocabulary.
- Anticipate — where appropriate — key events in stories.
- Use and understand recently introduced vocabulary during discussions about stories, non-fiction, rhymes and poems and during role-play.
ELG: Word Reading. Children at the expected level of development will:
- Say a sound for each letter in the alphabet and at least 10 digraphs.
- Read words consistent with their phonic knowledge by sound-blending.
- Read aloud simple sentences and books that are consistent with their phonic knowledge, including some common exception words.
ELG: Writing. Children at the expected level of development will:
- Write recognisable letters, most of which are correctly formed.
- Spell words by identifying sounds in them and representing the sounds with a letter or letters.
- Write simple phrases and sentences that can be read by others.`,
  },
];

/** Any quick-fact entries whose trigger keys appear in the query — a guaranteed, untruncated,
 * exact-figure candidate, independent of embedding noise or the generic chunker's chunk size. */
function quickFactCandidates(query) {
  const lower = String(query || '').toLowerCase();
  return QUICK_FACTS
    .filter(f => {
      if (f.requireAll) return f.requireAll.every(g => Array.isArray(g) ? g.some(k => lower.includes(k)) : lower.includes(g));
      return f.keys.some(k => lower.includes(k));
    })
    .map(f => ({ source_label: f.source_label, category: f.category, title: f.title, source_url: f.source_url, licence: f.licence, text: f.text, score: 0.75 }));
}

// Sources deliberately NOT in this corpus (licence reasons — see corpus-manifest.md). Verified
// 2026-07-23: asking about one of these by name still returned a confident, fully-fabricated
// answer (plausible-sounding "Birth to 5 Matters Range 3 PSED milestones" invented from the
// model's own training data, cited against four totally unrelated retrieved passages) — the
// generic "ground your answer in the passages" instruction was not enough to stop it, because
// the base persona prompt (ai.js PERSONA_PROMPTS.eyfs) separately claims "expert knowledge of
// ... Birth to 5 Matters", which the model falls back on. This needs a direct, code-driven
// check (like SAFEGUARD_RE's belt-and-braces pattern), not just a softer prompt request.
const EXCLUDED_SOURCES = {
  'birth to 5 matters': 'Birth to 5 Matters', 'birth to five matters': 'Birth to 5 Matters',
  'eef': 'the EEF (Education Endowment Foundation) Toolkit/guidance reports',
  'education endowment foundation': 'the EEF (Education Endowment Foundation) Toolkit/guidance reports',
};

/** Did the query name a source this corpus deliberately excludes? Returns its display name or null. */
function detectExcludedSource(query) {
  const lower = String(query || '').toLowerCase();
  for (const [needle, label] of Object.entries(EXCLUDED_SOURCES)) {
    if (lower.includes(needle)) return label;
  }
  return null;
}

// q03 (2026-07-24) — CRITICAL finding, code-enforced (belt-and-braces, same pattern as
// EXCLUDED_SOURCES above): asking "Who is our Designated Safeguarding Lead?" three times, with
// IDENTICAL retrieved passages each time, produced three different answers — one flatly wrong
// (claimed "the deputy" is DSL when the actually-retrieved "Safeguarding Policy 2026 Update" passage
// literally states "The DSL is Nursery Manager (Manager). The Deputy DSL is the deputy"), one that denied
// the name was present at all (it was, verbatim, in the same passage), and one that misattributed
// an unrelated cited source's "Data Protection Lead: Nursery Manager" line to the deputy instead. This is a
// genuine underlying data problem, not just a model quirk: Your Nursery' own ingested policies
// disagree with each other — "Safeguarding Policy 2026 Update" (v2.4) names Toby as DSL/the deputy as
// deputy, while "1.2 Safeguarding" and "Policy Statement Safeguarding" instead list a 4-person DSL
// rota (Demo Deputy, the office manager, a practitioner, a room leader) that omits Toby entirely.
// No amount of retrieval/prompt tuning can resolve which internal document is current — only Toby
// can — so rather than let the model confidently (and, as demonstrated, inconsistently) pick a
// name, this is code-enforced to always give the same honest, fully-sourced, actionable answer.
// Loose gap (up to 40 chars) between "who is/who's" and the DSL mention — verified the tight
// version missed "Who is our nursery's Designated Safeguarding Lead?" because "our nursery's"
// sits between "who is" and the title.
const DSL_IDENTITY_RE = /\bwho(?:'s|\s+(?:is|are))\b[\s\S]{0,40}\b(?:designated safeguarding lead|dsl)\b|\b(?:name|names)\s+of\s+(?:our|the)\s+(?:designated safeguarding lead|dsl)\b/i;

/** Is this a "who holds the DSL role" identity lookup? (Not a live-concern/disclosure question —
 * those correctly stay on the existing SAFEGUARD_RE "go to the deputy now" action path.) */
function detectDslIdentityQuery(query) {
  return DSL_IDENTITY_RE.test(String(query || ''));
}

/** Fixed, honest, fully-sourced answer for a DSL-identity lookup — see DSL_IDENTITY_RE comment
 * above for why this is code-enforced rather than left to the model to synthesise. */
function dslIdentityOverrideReply() {
  return `Our internal policy documents currently disagree on this, so I don't want to guess:

- "Safeguarding Policy 2026 Update" (v2.4) names **Nursery Manager (Manager)** as Designated Safeguarding Lead (DSL) and **the deputy (Deputy Manager)** as Deputy DSL.
- Two other policy documents ("1.2 Safeguarding" and "Policy Statement Safeguarding") instead list a rota of DSLs — **Demo Deputy, the office manager, a practitioner, a room leader** — so that one is always on the premises, and don't mention Toby in that role.

These need reconciling — please check with Toby which is current. In the meantime, for anything urgent, **the deputy (Deputy Manager)** is named in every version and is a safe first point of contact.`;
}

function expandQuery(q) {
  const lower = String(q || '').toLowerCase();
  let extra = [];
  for (const [k, v] of Object.entries(SYNONYMS)) if (lower.includes(k)) extra.push(v);
  return (q + (extra.length ? ' ' + extra.join(' ') : '')).slice(0, 400);
}

async function embed(text) {
  const resp = await fetch(`${ai.host()}/api/embeddings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ai.model('embed'), prompt: String(text).slice(0, 4000) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`embed ${resp.status}`);
  const j = await resp.json();
  if (!Array.isArray(j.embedding)) throw new Error('no embedding');
  return j.embedding;
}

// nomic-embed-text's cosine ranking is noisy on this corpus (1600+ chunks spanning very
// different documents) — a chunk that's clearly on-topic can score lower than a generic
// chunk from an unrelated document (verified 2026-07-23: a highly relevant Development
// Matters passage on 2-year-old communication didn't make the raw top-10 for exactly that
// question). Pull a wider semantic candidate pool, then rerank by blending cosine with a
// cheap lexical-overlap score against the query — this reliably promotes chunks that
// actually contain the query's keywords back to the top without another network call.
const CANDIDATE_MULTIPLIER = 4;
const RERANK_MIN_CANDIDATES = 20;

function lexicalOverlap(query, text) {
  const qTerms = [...new Set(String(query).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 3))];
  if (!qTerms.length) return 0;
  const t = String(text).toLowerCase();
  let hits = 0;
  for (const term of qTerms) if (t.includes(term)) hits++;
  return hits / qTerms.length;
}

async function qdrantCandidates(query, limit) {
  const vec = await embed(query);
  const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector: vec, limit, with_payload: true, score_threshold: SCORE_FLOOR }),
    signal: AbortSignal.timeout(6000),
  });
  if (!resp.ok) throw new Error(`qdrant ${resp.status}`);
  const j = await resp.json();
  return (j.result || []).map(p => ({
    source_label: p.payload?.source_label || 'EYFS brain corpus',
    category: p.payload?.category || null,
    title: p.payload?.title || null,
    source_url: p.payload?.source_url || null,
    licence: p.payload?.licence || null,
    text: p.payload?.text || '',
    score: p.score,
  })).filter(c => c.text);
}

const FTS_SYNTHETIC_SCORE = 0.60; // an exact/lexical FTS hit is treated as this confident before the lexical-overlap blend on top

const keyOf = (c) => `${c.source_label}::${String(c.text).slice(0, 60)}`;

function rerank(query, candidates) {
  return candidates
    .map(c => ({ ...c, _blended: c.score * 0.55 + lexicalOverlap(query, c.text) * 0.45 }))
    .sort((a, b) => b._blended - a._blended);
}

// entityHits are a GUARANTEE, not just a scoring nudge: a semantically-generic-but-verbose
// chunk (e.g. a full DfE guidance page) can out-blend a short, dense, exact-name Fledge/
// phonics chunk on score alone (verified 2026-07-23) — so the top 2 named-entity hits are
// promoted to the front after the normal semantic+lexical rerank, not left to compete in it.
// q03 (2026-07-24): quickFactHits get their OWN guaranteed slots, separate from entityHits —
// verified that concatenating them into the same pool let a broad named-entity match (e.g. up
// to 25 generic 'early learning goal' hits) crowd a hand-verified quick-fact out of the shared
// top-3 window on lexical-overlap alone. A hand-verified exact figure must never lose that
// contest, so it gets promoted unconditionally rather than competing for a shared slot.
function mergeAndRerank(query, qdrantHits, ftsHits, entityHits, quickFactHits, k) {
  const seen = new Map(); // qdrant hits win on dupe — they carry a real cosine score
  for (const c of qdrantHits) seen.set(keyOf(c), c);
  for (const c of ftsHits) { const key = keyOf(c); if (!seen.has(key)) seen.set(key, { ...c, score: FTS_SYNTHETIC_SCORE }); }
  const ranked = rerank(query, [...seen.values()]);

  // top 3 not top 1-2: entity content is short/bullet-style (e.g. one Fledge area per chunk),
  // so lexical-overlap ranking among several same-named-framework chunks is noisier than
  // ranking prose — a wider promotion window means the actually-relevant area (e.g. "Physical
  // Development" specifically, not just any Fledge chunk) still reaches the model's context
  // even when it's not the single top lexical scorer.
  const entityGuaranteed = rerank(query, entityHits).slice(0, 3);
  const guaranteed = [...quickFactHits, ...entityGuaranteed];
  const guaranteedKeys = new Set(guaranteed.map(keyOf));
  const rest = ranked.filter(c => !guaranteedKeys.has(keyOf(c)));
  return [...guaranteed, ...rest].slice(0, k);
}

// Named-entity rescue: naive OR-ranked FTS dilutes a rare specific term (e.g. "Fledge") behind
// chunks that merely match MORE of the common words in a long question (verified 2026-07-23 —
// not one Fledge chunk reached the top 15 of an 11-term OR query, despite literally containing
// "Fledge"). For the small set of proper-noun corpus/framework names a practitioner might name
// directly, run a direct ILIKE as a guaranteed-inclusion candidate source in the merge.
// q03 (2026-07-24): added 'elg'/'early learning goal(s)' — verified "List the ELGs for Literacy"
// didn't surface the exact ELG passage (it's real, verbatim, in the corpus — EYFS Statutory
// Framework chunk with "ELG: Comprehension / ELG: Word Reading / ELG: Writing") in the raw
// hybrid top-6; the model correctly declined rather than inventing goals, but a guaranteed
// named-entity hit closes the recall gap the same way it already does for Fledge/KCSIE/etc.
const NAMED_ENTITIES = ['fledge', 'wren phonics', 'development matters', 'send code of practice',
  'kcsie', 'keeping children safe in education', 'eyfs statutory framework', 'statutory framework',
  'funded early education entitlement', 'birth to 5 matters', 'birth to five matters', 'eef',
  'education endowment foundation', 'elg', 'early learning goal', 'early learning goals'];

async function namedEntityCandidates(pool, query, k) {
  const lower = String(query || '').toLowerCase();
  const hit = NAMED_ENTITIES.find(e => lower.includes(e));
  if (!hit) return [];
  try {
    // Fetch a wide pool here (not just k) — e.g. "fledge" alone matches 8 different curriculum
    // areas, and without this the arbitrary DB row order could cut off before the area the
    // question actually asked about (e.g. Physical Development). retrieve()'s rerank picks the
    // best 1-2 from this pool by lexical overlap with the full query, not DB return order.
    const { rows } = await pool.query(
      `SELECT source_label, category, title, source_url, licence, content AS text
         FROM public.eyfs_brain_chunks
        WHERE content ILIKE $1 OR title ILIKE $1
        LIMIT 25`, [`%${hit}%`]);
    return rows.map(r => ({ ...r, score: 0.66 }));
  } catch { return []; }
}

async function ftsSearch(pool, query, k) {
  const expanded = expandQuery(query);
  let { rows } = await pool.query(
    `SELECT source_label, category, title, source_url, licence, content AS text,
            ts_rank_cd(tsv, websearch_to_tsquery('english',$1)) AS score
       FROM public.eyfs_brain_chunks
      WHERE tsv @@ websearch_to_tsquery('english',$1)
      ORDER BY score DESC LIMIT $2`, [query, k]).catch(() => ({ rows: [] }));
  if (rows.length) return rows;
  const terms = expanded.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !['what', 'when', 'does', 'with', 'that', 'this', 'have', 'your', 'they', 'about', 'child', 'should', 'would', 'could', 'from'].includes(w));
  if (!terms.length) return [];
  const orQuery = [...new Set(terms)].join(' | ');
  ({ rows } = await pool.query(
    `SELECT source_label, category, title, source_url, licence, content AS text,
            ts_rank_cd(tsv, to_tsquery('english',$1)) AS score
       FROM public.eyfs_brain_chunks
      WHERE tsv @@ to_tsquery('english',$1)
      ORDER BY score DESC LIMIT $2`, [orQuery, k]).catch(() => ({ rows: [] })));
  return rows;
}

/**
 * retrieve(pool, query, k=6) → { chunks:[{source_label,category,title,source_url,licence,text,score}], mode }
 * mode: 'hybrid' | 'none'. Both qdrant and Postgres FTS are queried in parallel (best-effort —
 * either can fail without aborting the other) and merged before the confidence gate, so an
 * exact keyword hit and a semantic-paraphrase hit both get a fair shot at the top-k.
 */
async function retrieve(pool, query, k = 6) {
  const candidateLimit = Math.max(k * CANDIDATE_MULTIPLIER, RERANK_MIN_CANDIDATES);
  const [qdrantRes, ftsRes, entityRes] = await Promise.allSettled([
    USE_QDRANT ? qdrantCandidates(query, candidateLimit) : Promise.resolve([]),
    ftsSearch(pool, query, candidateLimit),
    namedEntityCandidates(pool, query, k),
  ]);
  if (qdrantRes.status === 'rejected') console.warn('[eyfs-brain-rag] qdrant unavailable:', qdrantRes.reason?.message);
  if (ftsRes.status === 'rejected') console.warn('[eyfs-brain-rag] FTS unavailable:', ftsRes.reason?.message);
  let qdrantHits = qdrantRes.status === 'fulfilled' ? qdrantRes.value : [];
  let ftsHits = ftsRes.status === 'fulfilled' ? ftsRes.value : [];
  let entityHits = entityRes.status === 'fulfilled' ? entityRes.value : [];
  // fledge-off (2026-10-26): while Fledge is off (src/lib/fledge-switch.js) no Fledge
  // passage is put in front of the model, so an answer cannot quote or name it.
  if (!(await require('./fledge-switch').isFledgeEnabled(pool))) {
    const notFledge = c => !/fledge/i.test(String((c && c.source_label) || '') + ' ' + String((c && c.text) || ''));
    qdrantHits = qdrantHits.filter(notFledge); ftsHits = ftsHits.filter(notFledge); entityHits = entityHits.filter(notFledge);
  }
  // q03 (2026-07-24): quick-facts get their own always-included guaranteed slots (see
  // mergeAndRerank comment) — not merged into entityHits, which can be a large, noisy pool.
  const quickFactHits = quickFactCandidates(query);

  const chunks = mergeAndRerank(query, qdrantHits, ftsHits, entityHits, quickFactHits, k);
  if (!chunks.length) return { chunks: [], mode: 'none' };

  // Confidence gate: a named-entity match (or a hand-verified quick-fact) is itself the strongest
  // possible "in corpus" signal, so it passes on its own. Otherwise require a strong blended score
  // or a clear lexical match on the top candidate — decline rather than risk grounding on noise.
  const top = chunks[0];
  if (entityHits.length || quickFactHits.length || top._blended >= SCORE_STRONG || lexicalOverlap(query, top.text) >= 0.5) {
    return { chunks, mode: 'hybrid' };
  }
  return { chunks: [], mode: 'none' };
}

/** Build a compact, citable grounding block for the system prompt. */
function buildGroundingBlock(chunks) {
  if (!chunks.length) return '';
  // q03 (2026-07-24): raised from 900 — instrumenting retrieve() directly showed the correct
  // ratio paragraph was sometimes retrieved but truncated before the number (native gov-corpus
  // chunks run ~3000 chars; e.g. "every eight children" sat at char 1904 of a 3199-char chunk).
  // First raised to 1600 (fixed ratios/floor-space), then to 2800 after the same pattern showed
  // up again for Literacy ELGs (verbatim "ELG: Comprehension" sits at char 2388) — 2800 covers
  // the large majority of this corpus's native chunks (95th percentile chunk length is 3200)
  // without an unbounded prompt; model's context_length is 262144 so headroom isn't the concern.
  const lines = chunks.map((c, i) => `[#${i + 1} | ${c.source_label}]\n${String(c.text).slice(0, 2800)}`);
  return `\n\nEYFS BRAIN PASSAGES (retrieved for this question — ground your answer in these, cite the source name):\n\n${lines.join('\n\n')}\n\nIMPORTANT: do not state a specific number, ratio, date, or named requirement unless it literally appears in the passages above — retrieval for a large corpus can surface adjacent-but-not-exact passages, and a wrong statutory figure is worse than admitting the passages here don't give the precise number. If the passages don't actually answer the question, say so honestly instead of guessing.`;
}

/** Distinct source labels actually retrieved — for a guaranteed inline citation line. */
function sourceLabels(chunks, max = 4) {
  return [...new Set(chunks.map(c => c.source_label))].slice(0, max);
}

/** Richer citation objects for UI footnote rendering: {label, url}. */
function citationDetails(chunks, max = 4) {
  const seen = new Set();
  const out = [];
  for (const c of chunks) {
    if (seen.has(c.source_label)) continue;
    seen.add(c.source_label);
    out.push({ label: c.source_label, url: c.source_url || null });
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { retrieve, buildGroundingBlock, sourceLabels, citationDetails, expandQuery, detectExcludedSource, detectDslIdentityQuery, dslIdentityOverrideReply, COLLECTION };
