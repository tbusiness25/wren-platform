'use strict';
/**
 * manager-rag.js — b512 (2026-10-18) retrieval for the "when Toby's away" assistant.
 *
 * Grounds every answer in `ladn.manager_corpus` + a qdrant collection scoped to
 * the database (see collectionFor below: `ladn_manager_prod_v1` on prod,
 * `ladn_manager_v1` on wren_dev), both built by
 * scripts/b512-manager-corpus-ingest.js from
 * the Managers Bible, the business manual, the setting's policies, the staff
 * handbook, the CCTV pack, the T&Cs and the wren-docs research/decision trees.
 *
 * ── THE SHAPE, AND WHY IT IS THE APPRENTICE SHAPE ────────────────────────────
 * Same as src/lib/apprentice-rag.js: qdrant semantic search first (vocabulary
 * mismatch is the normal case here — a deputy types "the heating's off", the
 * Bible says "boiler", "gas safety certificate", "legionella"), Postgres FTS
 * as an always-available fallback so the runtime is never left ungrounded.
 * Two gotchas it inherits, both learned the hard way:
 *   · pgvector is NOT installed in wren-postgres — vector search is qdrant only.
 *   · qdrant-work sits on `qdrant-work_default`, not wren-net. wren-ladn is
 *     joined to it as external net `qdrant-net`. If that join is lost the chat
 *     degrades to FTS (still grounded, lower recall), it does not break.
 *
 * ── WHAT IS DIFFERENT FROM THE APPRENTICE ────────────────────────────────────
 * MODE. Each consultant mode has its own order of authority over the same
 * corpus (src/lib/away-modes.js). So a hit's score is multiplied by the weight
 * of its source_kind in the active mode: in HR mode a handbook passage beats a
 * Bible passage even on a slightly worse cosine, because the handbook is the
 * contractual document. A kind weighted 0 in a mode is filtered out entirely.
 *
 * ── WITHHELD ROWS ────────────────────────────────────────────────────────────
 * `WHERE NOT withheld` is on every query here, and the ingest never embeds a
 * withheld chunk, so there are two independent reasons a guarded document
 * cannot be retrieved. Do not remove either.
 */

const ai = require('./ai-models');
const modes = require('./away-modes');

const QDRANT_URL = process.env.MANAGER_QDRANT_URL || process.env.APPRENTICE_QDRANT_URL || 'http://qdrant-work:6333';
/**
 * The qdrant collection, SCOPED BY DATABASE (added in review, chain E2, 19 Oct).
 *
 * This matters because the vector path returns the PAYLOAD text verbatim
 * (chunkFromPayload below) rather than re-reading the row from manager_corpus,
 * and a point id is just manager_corpus.id. One qdrant runs for both databases,
 * so a single shared collection name means prod and wren_dev write ids 1..N into
 * the same space: whichever ingested last decides what the OTHER one's managers
 * read, and a citation id can resolve to different text than the answer was
 * grounded in. Every other RAG collection in Wren has this same property
 * (apprentice, wren_brain_v1, eyfs_brain_v1 …) — it is the house pattern and
 * fixing it everywhere is its own build — but b512 answers "what do I do while
 * The manager is away", so it does not get to inherit that.
 *
 * Prod gets its own name; wren_dev keeps 'ladn_manager_v1' and its existing
 * points, so nothing already built is thrown away.
 */
function collectionFor(db) {
  return String(db || '') === 'wren' ? 'ladn_manager_prod_v1' : 'ladn_manager_v1';
}
const COLLECTION = process.env.MANAGER_QDRANT_COLLECTION || collectionFor(process.env.PG_DB);
const USE_QDRANT = process.env.MANAGER_USE_QDRANT !== 'false';

// nomic-embed-text has a noisy baseline cosine (~0.50–0.59 for unrelated English),
// so one threshold is unreliable — the same two-level gate the apprentice uses.
//   FLOOR  minimum to be considered as grounding at all
//   STRONG high semantic confidence; counts as "in corpus" on its own
// A hit between the two must also pass a strict lexical AND check, which is what
// keeps "what's the capital of France" out of the corpus without keeping
// "the heating's off" out of it.
// FLOOR = 0.58, and that number is MEASURED, not guessed. Over the 49 eval
// questions the top cosine against this corpus came out as:
//     questions that SHOULD be answered   0.5893 … 0.6543   (n=40)
//     questions that should be DECLINED   0.4931, 0.5128, 0.5690
// so 0.58 separates them. The margin under the lowest keeper ("what checks do we
// need before a new starter works alone", 0.5893) is only 0.009, so this is a
// threshold to RE-MEASURE, not to trust, whenever the corpus changes materially:
// `node scripts/b512-evals.js` is the instrument, and the decline class is the
// half that moves first.
//
// One known miss that no threshold fixes: "how do I reset the password on the
// Ealing bowling club website" scores 0.6266 against Wren's own Authentik
// password decisions — it is genuinely semantically close. Retrieval cannot tell
// that apart; the mode prompt's "if the passages do not cover the question, say
// exactly that" is what handles it, and b512-evals --with-model is what checks
// that it does.
const SCORE_FLOOR  = parseFloat(process.env.MANAGER_SCORE_FLOOR  || '0.58');
const SCORE_STRONG = parseFloat(process.env.MANAGER_SCORE_STRONG || '0.62');
// The rank floor on the FTS OR-recall pass. See the comment in ftsSearch: an OR
// query over 3,800 passages matches nearly any English sentence without one.
const FTS_OR_FLOOR = parseFloat(process.env.MANAGER_FTS_OR_FLOOR || '0.05');

// ── THE FLOOR IS A FUNCTION OF AUTHORITY, NOT A CONSTANT ────────────────────
// A single floor treats a handbook paragraph and a Wren engineering decision
// record as equally deserving of the benefit of the doubt, and they are not.
// The evals showed both halves of that costing an answer:
//   · "what checks do we need before a new starter works alone" came back as a
//     2026 HR-parity DECISION RECORD and a CCTV pack. Policy 2.1 Employment and
//     3.1 Induction — which actually answer it — were below the flat floor and
//     so were never in the pool for `policy: 1.15` to promote.
//   · "what were last March's swimming lesson timetables" came back grounded on
//     a RESEARCH doc about screen time at 0.569 — over the flat floor, and
//     nothing in the pipeline cared that research is the weakest source there is.
// So: authority buys a lower bar, and the lack of it raises one.
//     floor(kind) = SCORE_FLOOR - (modeWeight(kind) - 1) * FLOOR_RELIEF
// In HR mode that is 0.553 for the handbook (1.45), 0.571 for a policy (1.15)
// and 0.589 for a decision record (0.85). Same instrument as everything else
// here: `node scripts/b512-evals.js`, and the decline class moves first.
const FLOOR_RELIEF = parseFloat(process.env.MANAGER_FLOOR_RELIEF || '0.06');
const FLOOR_MIN = 0.50, FLOOR_MAX = 0.66;

function floorFor(mode, sourceKind) {
  const w = modes.weightFor(mode, sourceKind);
  const f = SCORE_FLOOR - (w - 1) * FLOOR_RELIEF;
  return Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, f));
}

// Nursery-management vocabulary the corpus words differently from the way a
// person under pressure types it. Used by the FTS fallback only — qdrant does
// this itself, which is why qdrant is tried first.
const SYNONYMS = {
  'heating':      'boiler gas heating hot water radiator temperature',
  'boiler':       'boiler gas heating hot water plumber certificate',
  'no hot water': 'boiler gas hot water plumber',
  'ratio':        'ratio ratios staffing qualified EYFS adult child numbers off-ratio',
  'out of ratio': 'ratio staffing cover absence bank staff off-ratio EYFS',
  'sick':         'absence sickness Bradford cover rota sick pay SSP',
  'off sick':     'absence sickness cover rota SSP self-certification',
  'collect':      'collection uncollected late pick-up closing time parent',
  'not collected':'uncollected collection late closing policy social care',
  'late':         'late collection lateness fee closing time charge',
  'ofsted':       'Ofsted inspection registration URN notifiable EYFS grade',
  'inspection':   'Ofsted inspection readiness evidence self-evaluation EYFS',
  'payroll':      'payroll PayCheck wages salary PAYE HMRC pay run bureau',
  'wages':        'payroll wages salary pay run PayCheck',
  'funding':      'funding Ealing headcount return early years entitlement portal census',
  'fees':         'fees invoice billing rates increase review debt',
  'invoice':      'invoice billing fees reconcile Xero statement',
  'cash':         'cash flow cashflow bank balance overdraft Barclays',
  'cctv':         'CCTV camera footage retention DPIA recording disclosure NVR',
  'camera':       'CCTV camera footage recording retention Frigate NVR',
  'door':         'door entry door intercom doorbell fob intercom access',
  'fob':          'fob NFC Mifare clock-in Dahua door entry',
  'wren down':    'outage standby failover Tailscale Cloudflare docker-work paper register',
  'wren is down': 'outage standby failover runbook paper register resilience backup',
  'down':         'outage failover standby resilience backup paper',
  'backup':       'backup dump restore standby replica retention',
  'complaint':    'complaint complaints parent grievance policy Ofsted',
  'safeguarding': 'safeguarding child protection DSL disclosure LADO MASH referral welfare',
  'dsl':          'designated safeguarding lead DSL deputy safeguarding referral',
  'allegation':   'allegation LADO staff suitability disqualification safeguarding',
  'disciplinary': 'disciplinary ACAS investigation warning gross misconduct handbook',
  'grievance':    'grievance ACAS handbook procedure appeal',
  'holiday':      'annual leave holiday entitlement notice WTR accrual rota',
  'leave':        'annual leave holiday maternity paternity parental notice entitlement',
  'notice':       'notice period resignation termination handbook contract',
  'recruit':      'recruitment safer recruitment DBS references suitability SCR interview',
  'dbs':          'DBS safer recruitment suitability single central record references',
  'fire':         'fire risk assessment drill alarm extinguisher evacuation muster',
  'kitchen':      'kitchen SFBB food hygiene allergen fridge freezer temperature probe',
  'allergy':      'allergen allergy dietary EHCP medicine care plan food',
  'medicine':     'medicine medication consent administration record dose',
  'calpol':       'medicine medication paracetamol consent administration dose temperature',
  'paracetamol':  'medicine medication paracetamol consent administration dose',
  'teething':     'medicine medication consent administration dose comfort',
  'nappy':        'nappy changing intimate care toileting hygiene',
  'biting':       'behaviour biting self-regulation incident parents',
  'bruise':       'bruise injury accident existing injury body map safeguarding record',
  'resigned':     'resignation notice period termination handbook leaver',
  'resign':       'resignation notice period termination handbook leaver',
  'new starter':  'induction safer recruitment DBS references suitability single central record probation',
  'starter':      'induction safer recruitment DBS references suitability probation',
  'occupancy':    'occupancy places waiting list admissions rooms capacity',
  'waiting list': 'waiting list admissions enquiry occupancy places',
  'insurance':    'insurance Bishops Early Years Alliance claim cover liability',
  'gdpr':         'GDPR data protection subject access request retention privacy ICO',
  'sar':          'subject access request GDPR data protection ICO retention',
  'close':        'closure closed closing day fee notification Ofsted incident',
  'closed':       'closure closed day fee parents notify Ofsted',
  'supervision':  'supervision appraisal one-to-one CPD performance',
  'parent':       'parent communication newsletter app message complaint',
};

function expandQuery(q) {
  const lower = String(q || '').toLowerCase();
  const extra = [];
  for (const [k, v] of Object.entries(SYNONYMS)) if (lower.includes(k)) extra.push(v);
  return (q + (extra.length ? ' ' + extra.join(' ') : '')).slice(0, 600);
}

async function embed(text) {
  const resp = await fetch(`${ai.host()}/api/embeddings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ai.model('embed'), prompt: String(text).slice(0, 4000) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`embed ${resp.status}`);
  const j = await resp.json();
  if (!Array.isArray(j.embedding)) throw new Error('no embedding');
  return j.embedding;
}

function chunkFromPayload(p, score) {
  return {
    id: p.corpus_id || null,
    source_kind: p.source_kind || 'unknown',
    source_label: p.source_label || 'the record',
    open_url: p.open_url || null,
    title: p.title || null,
    section_path: p.section_path || null,
    text: p.text || '',
    doc_key: p.doc_key || null,
    raw_score: score,
    score,
  };
}

async function qdrantSearch(query, mode, k) {
  const vec = await embed(query);
  // Mode filter in qdrant as well as in the weighting: a kind weighted 0 must
  // not come back at all, not merely sort last.
  // ── WHY THE CANDIDATE POOL IS THIS BIG ──────────────────────────────────────
  // Mode weighting can only promote a passage that is IN the pool. The corpus is
  // badly unbalanced by volume — 1,033 decision + 1,453 research + 561 analysis
  // chunks against 96 handbook, 232 policy and 98 Bible — because the brief asks
  // for the wren-docs engineering trees as well as the authoritative documents.
  // With a pool of 24 the evals showed "what checks do we need before a new
  // starter works alone" coming back as a Wren ID decision record and a CCTV
  // pack, with the handbook never in the running: it was crowded out on raw
  // cosine before `handbook: 1.45` ever got to speak.
  //
  // So the pool is deliberately wide and the mode weights do the deciding. A
  // 768-d search over 3,863 points costs nothing; getting the order of authority
  // wrong costs an answer.
  const pool = Math.max(k * 10, 80);
  // Search at the LOWEST floor any kind could earn in this mode; applyModeWeights
  // then applies each kind's own floor. Searching at SCORE_FLOOR would discard the
  // relief before it could be granted.
  const body = {
    vector: vec, limit: pool, with_payload: true, score_threshold: FLOOR_MIN,
    filter: { must: [{ key: 'modes', match: { any: [mode] } }] },
  };
  const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`qdrant ${resp.status}`);
  const j = await resp.json();
  return (j.result || []).map(p => chunkFromPayload(p.payload || {}, p.score)).filter(c => c.text);
}

async function ftsSearch(pool, query, mode, k) {
  const base = `SELECT id, source_kind, source_label, open_url, title, section_path, content AS text, doc_key`;
  const live = `FROM manager_corpus WHERE NOT withheld AND content IS NOT NULL AND $2 = ANY(modes)`;

  // Pass 1: websearch (AND-ish) on the raw question — high precision.
  let { rows } = await pool.query(
    `${base}, ts_rank_cd(tsv, websearch_to_tsquery('english',$1)) AS score
       ${live} AND tsv @@ websearch_to_tsquery('english',$1)
      ORDER BY score DESC LIMIT $3`, [query, mode, Math.max(k * 10, 80)]);

  // Pass 2: OR of the expanded significant terms — high recall, which covers the
  // vocabulary mismatch the synonyms exist for.
  //
  // AN OR QUERY MATCHES ALMOST ANYTHING over 3,800 passages, so it carries a
  // RANK FLOOR. Without one, "the airspeed velocity of an unladen swallow" comes
  // back grounded on whatever document happens to contain "hour" — which is how
  // an assistant that must never invent a policy invents one. The floor is
  // deliberately on ts_rank_cd and not on a match count: a single strong hit on
  // one rare word ("legionella") is a real answer, and three weak hits on three
  // common ones are not.
  if (!rows.length) {
    const terms = significantTerms(query);
    if (!terms.length) return [];
    ({ rows } = await pool.query(
      `${base}, ts_rank_cd(tsv, to_tsquery('english',$1)) AS score
         ${live} AND tsv @@ to_tsquery('english',$1)
           AND ts_rank_cd(tsv, to_tsquery('english',$1)) >= $4
        ORDER BY score DESC LIMIT $3`,
      [terms.join(' | '), mode, Math.max(k * 10, 80), FTS_OR_FLOOR])
      .catch(() => ({ rows: [] })));
  }
  // ts_rank_cd and cosine are different scales. Normalise the top hit to 1 so
  // the mode weighting below means the same thing on either path.
  const top = rows.length ? Math.max(Number(rows[0].score) || 0, 1e-6) : 1;
  return rows.map(r => ({ ...r, raw_score: Number(r.score) || 0, score: (Number(r.score) || 0) / top }));
}

/**
 * The lexical backup for a semantic hit in the FLOOR..STRONG band.
 *
 * ── WHY THIS IS NOT A STRICT AND ────────────────────────────────────────────
 * It was, at first: `websearch_to_tsquery` on the raw question, which is AND-ish.
 * The evals showed what that costs. "the boiler's broken and the baby room is
 * cold" — the brief's own example — retrieved NOTHING, because no single passage
 * contains boiler AND broken AND baby AND room AND cold, so the backup failed
 * and a perfectly good semantic hit in the band was thrown away. Same for "can I
 * raise an invoice while The manager is away", "someone has resigned by text message"
 * and "what checks do we need before a new starter works alone". A person under
 * pressure types a sentence, not a search query.
 *
 * So the backup is: does any SIGNIFICANT term of the question (after synonym
 * expansion) hit a live passage at a real rank? That is still a lexical test —
 * it still rejects a question that shares no vocabulary with the corpus at all,
 * which is what the band gate is for — but it no longer demands that one
 * paragraph contain every word of the question.
 *
 * The rank floor is what keeps it from degenerating into "any English sentence
 * matches": see FTS_OR_FLOOR and the comment in ftsSearch.
 */
async function ftsAndHit(pool, query, mode) {
  try {
    // Strict first — a precise question should not pay for the loose pass.
    const { rows } = await pool.query(
      `SELECT 1 FROM manager_corpus
        WHERE NOT withheld AND $2 = ANY(modes) AND tsv @@ websearch_to_tsquery('english',$1) LIMIT 1`,
      [query, mode]);
    if (rows.length) return true;
  } catch { /* fall through to the loose pass */ }
  try {
    const terms = significantTerms(query);
    if (!terms.length) return false;
    const { rows } = await pool.query(
      `SELECT 1 FROM manager_corpus
        WHERE NOT withheld AND $2 = ANY(modes) AND tsv @@ to_tsquery('english',$1)
          AND ts_rank_cd(tsv, to_tsquery('english',$1)) >= $3 LIMIT 1`,
      [terms.join(' | '), mode, FTS_OR_FLOOR]);
    return rows.length > 0;
  } catch { return false; }
}

// Words that carry no retrieval signal. 'hour'/'time'/'thing' are in here because
// they are common enough in 3,800 passages to make an OR query match anything.
const STOPWORDS = new Set(['what','when','does','with','that','this','have','your','they','about','should',
  'would','could','from','there','where','which','whom','been','were','must','need','into','just','like',
  'make','over','than','then','them','some','only','very','much','many','doing','done','hour','hours',
  'time','today','thing','things','something','anything','know','tell','help','please','while','going',
  'here','away','what’s','whats','cant','dont','didnt']);

/** The question's retrieval-bearing words, after synonym expansion. */
function significantTerms(q) {
  return [...new Set(expandQuery(q).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w)))];
}

/**
 * Re-score by the mode's order of authority, drop what this mode may not read or
 * what has not cleared ITS OWN floor, and cut to k.
 *
 * `semantic` says whether `raw_score` is a cosine (qdrant) or a normalised
 * ts_rank (FTS). The per-kind floor is a cosine threshold, so it is only applied
 * on the semantic path — applying it to a rank would be comparing two different
 * scales, which is the kind of bug that looks like bad retrieval for a week.
 */
function applyModeWeights(chunks, mode, k, semantic = false) {
  const out = [];
  for (const c of chunks) {
    const w = modes.weightFor(mode, c.source_kind);
    if (w <= 0) continue;
    if (semantic && (c.raw_score || 0) < floorFor(mode, c.source_kind)) continue;
    out.push({ ...c, weight: w, floor: floorFor(mode, c.source_kind), score: (c.score || 0) * w });
  }
  out.sort((a, b) => b.score - a.score);
  // One passage per document section is plenty; a long Bible section that
  // chunked into five pieces must not fill the whole context on its own.
  const seen = new Map();
  const kept = [];
  for (const c of out) {
    const key = c.doc_key || c.source_label;
    const n = seen.get(key) || 0;
    if (n >= 3) continue;
    seen.set(key, n + 1);
    kept.push(c);
    if (kept.length >= k) break;
  }
  return kept;
}

/**
 * retrieve(pool, query, mode, k) → { chunks, mode: 'qdrant'|'fts'|'none', tried }
 * `chunks` is already mode-weighted and cut. An empty array means NOTHING in the
 * corpus covers the question — the caller must not call the model, must say so,
 * and must log a gap.
 */
async function retrieve(pool, query, modeKey = modes.DEFAULT_MODE, k = 8) {
  const mode = modes.getMode(modeKey).key;
  const tried = [];
  if (USE_QDRANT) {
    try {
      const hits = await qdrantSearch(query, mode, k);
      tried.push(`qdrant:${hits.length}`);
      const chunks = applyModeWeights(hits, mode, k, true);
      tried.push(`after-floors:${chunks.length}`);
      if (chunks.length) {
        // The band gate runs on what SURVIVED the per-kind floors, not on the raw
        // top hit — otherwise a strong research passage could vouch for a weak
        // handbook one it has nothing to do with.
        const top = chunks[0].raw_score || 0;
        if (top >= SCORE_STRONG || await ftsAndHit(pool, query, mode)) {
          return { chunks, mode: 'qdrant', tried };
        }
        tried.push('qdrant:below-strong-no-lexical');
      }
      // ── QDRANT IS AUTHORITATIVE WHEN IT ANSWERS. DO NOT FALL THROUGH HERE. ──
      // The first version of this did fall through to FTS, reasoning that the
      // collection might be stale. The probe caught what that actually costs:
      // "what is the airspeed velocity of an unladen swallow" came back GROUNDED,
      // because the FTS recall pass ORs the question's words together and three
      // hundred documents contain "hour" and "velocity" somewhere. Nothing was
      // then flagged as a gap and the model was handed irrelevant passages to
      // write a confident answer from.
      //
      // "It never invents a policy" is only true if DECLINING is reachable, and
      // declining is only reachable if one retrieval path gets the last word.
      // A stale collection is a visible problem (the status chips show the
      // embedded count, and re-running the ingest fixes it); a silently
      // ungroundable answer is not.
      return { chunks: [], mode: 'none', tried };
    } catch (e) {
      // qdrant ERRORED — unreachable, or the collection is missing. THAT is when
      // FTS takes over, so the feature degrades to keyword grounding rather than
      // to nothing. project_apprentice_nestling_rag: qdrant-work is on its own
      // docker network and a container recreate can lose the join.
      tried.push(`qdrant:error ${e.message}`);
      console.warn('[manager-rag] qdrant unavailable, falling back to FTS:', e.message);
    }
  }
  try {
    const hits = await ftsSearch(pool, query, mode, k);
    tried.push(`fts:${hits.length}`);
    const chunks = applyModeWeights(hits, mode, k);
    return { chunks, mode: chunks.length ? 'fts' : 'none', tried };
  } catch (e) {
    console.error('[manager-rag] FTS error:', e.message);
    tried.push(`fts:error ${e.message}`);
    return { chunks: [], mode: 'none', tried };
  }
}

/** The grounding block. Numbered so the model can cite [#n] and the UI can resolve it. */
function buildGroundingBlock(chunks) {
  if (!chunks.length) return '';
  const lines = chunks.map((c, i) => {
    const where = c.section_path || c.title || '';
    return `[#${i + 1} | ${c.source_label}${where ? ` — ${where}` : ''}]\n${String(c.text).slice(0, 1600)}`;
  });
  return `\n\nSOURCE PASSAGES — your ONLY permitted source of fact about this nursery. Do not use any knowledge about Your Nursery beyond these:\n\n${lines.join('\n\n')}`;
}

/** What the UI shows under an answer, and what goes in the log's citations column. */
function citations(chunks, max = 6) {
  const out = [];
  const seen = new Set();
  for (const c of chunks) {
    const key = `${c.source_label}|${c.section_path || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: c.id || null, kind: c.source_kind, label: c.source_label,
      section: c.section_path || c.title || null, open_url: c.open_url || null,
    });
    if (out.length >= max) break;
  }
  return out;
}

module.exports = {
  retrieve, buildGroundingBlock, citations, expandQuery, applyModeWeights,
  COLLECTION, collectionFor, SCORE_FLOOR, SCORE_STRONG, FTS_OR_FLOOR, FLOOR_RELIEF, SYNONYMS, significantTerms, floorFor,
};
