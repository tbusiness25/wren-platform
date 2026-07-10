'use strict';
/**
 * apprentice-rag.js — retrieval for the apprentice ("Nestling") chatbot.
 *
 * Grounds answers ONLY in the approved corpus (apprentice_corpus + the qdrant
 * 'apprentice' collection, both built by scripts/apprentice-rag-ingest.js from
 * authored course modules + EYFS/Birth-to-5-Matters framework statements).
 *
 * Strategy: qdrant semantic search first (handles vocabulary mismatch, e.g.
 * "neurodivergent" → autism/SEND/atypical-development content); Postgres FTS
 * (with domain synonym expansion) as an always-available fallback so the runtime
 * is never left ungrounded. Returns chunks carrying a citable source_label.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const EMBED_MODEL = process.env.APPRENTICE_EMBED_MODEL || 'nomic-embed-text:latest';
// qdrant-work sits on its own docker network; wren-ladn must be joined to it for
// this hostname to resolve. If unreachable we transparently fall back to FTS.
const QDRANT_URL  = process.env.APPRENTICE_QDRANT_URL || 'http://qdrant-work:6333';
const COLLECTION  = 'apprentice';
const USE_QDRANT  = process.env.APPRENTICE_USE_QDRANT !== 'false'; // on by default; FTS fallback always covers

// Domain synonym expansion — maps apprentice-friendly vocabulary onto the words
// actually used in the authored corpus, so the FTS fallback recalls the right
// modules even when the learner's phrasing differs.
const SYNONYMS = {
  'neurodivergent': 'autism autistic adhd send atypical neurodevelopment special educational needs sensory',
  'neurodiverse':   'autism autistic adhd send atypical neurodevelopment special educational needs sensory',
  'neurodiversity': 'autism autistic adhd send atypical neurodevelopment special educational needs',
  'co-regulation':  'self-regulation regulation soothe calm emotional comfort attachment',
  'coregulation':   'self-regulation regulation soothe calm emotional comfort attachment',
  'attachment':     'attachment key person secure bond relationship emotional',
  'key person':     'key person attachment settling transition relationship',
  'tantrum':        'behaviour self-regulation emotion meltdown dysregulation',
  'meltdown':       'self-regulation emotion sensory dysregulation behaviour',
  'speech':         'communication language talking words vocabulary',
  'talking':        'communication language speech words vocabulary',
  'brain':          'developing brain neurodevelopment cognitive',
  'schema':         'schemas play effective learning exploration',
  'safeguarding':   'safeguarding child protection disclosure welfare designated lead',
};

function expandQuery(q) {
  const lower = String(q || '').toLowerCase();
  let extra = [];
  for (const [k, v] of Object.entries(SYNONYMS)) {
    if (lower.includes(k)) extra.push(v);
  }
  return (q + (extra.length ? ' ' + extra.join(' ') : '')).slice(0, 400);
}

async function embed(text) {
  const resp = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: String(text).slice(0, 4000) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`embed ${resp.status}`);
  const j = await resp.json();
  if (!Array.isArray(j.embedding)) throw new Error('no embedding');
  return j.embedding;
}

// nomic-embed-text has a noisy baseline cosine (~0.50-0.59 even for unrelated English
// text), so a single threshold is unreliable. We use two levels:
//   FLOOR  (0.56) — minimum to be considered as grounding context at all.
//   STRONG (0.62) — high semantic confidence; qualifies as "in corpus" on its own.
// A match in the FLOOR..STRONG band must also pass a strict lexical (AND) check to count
// as "in corpus" — this rejects baseline-noise hits like "capital of France"/"tax return"
// that share no real keyword overlap, while still answering genuine early-years questions.
const SCORE_FLOOR  = parseFloat(process.env.APPRENTICE_SCORE_FLOOR  || '0.56');
const SCORE_STRONG = parseFloat(process.env.APPRENTICE_SCORE_STRONG || '0.62');

async function qdrantSearch(query, k) {
  const vec = await embed(query);
  const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector: vec, limit: k, with_payload: true, score_threshold: SCORE_FLOOR }),
    signal: AbortSignal.timeout(6000),
  });
  if (!resp.ok) throw new Error(`qdrant ${resp.status}`);
  const j = await resp.json();
  return (j.result || []).map(p => ({
    source_label: p.payload?.source_label || 'approved corpus',
    category: p.payload?.category || null,
    title: p.payload?.title || null,
    text: p.payload?.text || '',
    score: p.score,
  })).filter(c => c.text);
}

async function ftsSearch(pool, query, k) {
  const expanded = expandQuery(query);
  // Pass 1: websearch (AND-ish) on the raw query — high precision.
  let { rows } = await pool.query(
    `SELECT source_label, category, title, content AS text,
            ts_rank_cd(tsv, websearch_to_tsquery('english',$1)) AS score
       FROM apprentice_corpus
      WHERE tsv @@ websearch_to_tsquery('english',$1)
      ORDER BY score DESC LIMIT $2`, [query, k]);
  if (rows.length) return rows;
  // Pass 2: OR of expanded significant terms — high recall (covers vocabulary mismatch).
  const terms = expanded.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !['what','when','does','with','that','this','have','your','they','about','child','should','would','could','from'].includes(w));
  if (!terms.length) return [];
  const orQuery = [...new Set(terms)].join(' | ');
  ({ rows } = await pool.query(
    `SELECT source_label, category, title, content AS text,
            ts_rank_cd(tsv, to_tsquery('english',$1)) AS score
       FROM apprentice_corpus
      WHERE tsv @@ to_tsquery('english',$1)
      ORDER BY score DESC LIMIT $2`, [orQuery, k]).catch(() => ({ rows: [] })));
  return rows;
}

// Strict lexical confirmation — does the raw query (AND semantics) match any corpus row?
// Used to back up moderate-confidence semantic hits and reject baseline-noise matches.
async function ftsAndHit(pool, query) {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM apprentice_corpus
        WHERE tsv @@ websearch_to_tsquery('english',$1) LIMIT 1`, [query]);
    return rows.length > 0;
  } catch { return false; }
}

/**
 * retrieve(pool, query, k) → { chunks: [{source_label,text,category,title,score}], mode }
 * mode: 'qdrant' | 'fts' | 'none'
 */
async function retrieve(pool, query, k = 6) {
  if (USE_QDRANT) {
    try {
      // qdrant is AUTHORITATIVE when reachable. Dual-signal "in corpus" gate:
      //   - top score >= STRONG → in corpus (high semantic confidence)
      //   - FLOOR <= top < STRONG → in corpus ONLY if strict lexical AND match confirms it
      //   - nothing above FLOOR → not in corpus → decline
      // We only fall back to FTS when qdrant ERRORS (network/embed), to stay grounded.
      const chunks = await qdrantSearch(query, k);
      if (!chunks.length) return { chunks: [], mode: 'none' };
      const top = chunks[0].score || 0;
      if (top >= SCORE_STRONG) return { chunks, mode: 'qdrant' };
      if (await ftsAndHit(pool, query)) return { chunks, mode: 'qdrant' };
      return { chunks: [], mode: 'none' };
    } catch (e) {
      console.warn('[apprentice-rag] qdrant unavailable, falling back to FTS:', e.message);
    }
  }
  try {
    const chunks = await ftsSearch(pool, query, k);
    return { chunks, mode: chunks.length ? 'fts' : 'none' };
  } catch (e) {
    console.error('[apprentice-rag] FTS error:', e.message);
    return { chunks: [], mode: 'none' };
  }
}

/** Build a compact, citable grounding block for the system prompt. */
function buildGroundingBlock(chunks) {
  if (!chunks.length) return '';
  const lines = chunks.map((c, i) =>
    `[#${i + 1} | ${c.source_label}]\n${String(c.text).slice(0, 900)}`);
  return `\n\nAPPROVED CORPUS PASSAGES (your ONLY permitted source of facts — do not use any knowledge beyond these):\n\n${lines.join('\n\n')}`;
}

/** Distinct source labels actually retrieved — used to append guaranteed citations. */
function sourceLabels(chunks, max = 3) {
  return [...new Set(chunks.map(c => c.source_label))].slice(0, max);
}

module.exports = { retrieve, buildGroundingBlock, sourceLabels, expandQuery };
