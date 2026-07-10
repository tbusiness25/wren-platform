'use strict';
/**
 * history-rag.js — retrieval over the operational-history RAG (Prompt 39, 2026-06-30).
 *
 * Grounds answers in the local history corpus built by scripts/wren-history-rag-ingest.js
 * from ~/rag-source/{eylog,eyman,brighthr,wren}/ (EyLog register/diary, EyMan funding,
 * BrightHR absence history 2018→, Wren attendance/observations/invoices + the computed
 * staffing-effectiveness metrics).
 *
 * Two indexes, mirroring the apprentice pattern:
 *   1. qdrant 'wren-history' collection (nomic-embed-text vectors) — semantic, primary.
 *   2. wren_history_corpus (Postgres FTS) — always-available fallback.
 * Both carry a citable source_label. All sovereign/local — no cloud.
 *
 * This is consumed by /api/staff-analytics/ask and (prompt 40) the staffing chat module.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const EMBED_MODEL = process.env.HISTORY_EMBED_MODEL || process.env.APPRENTICE_EMBED_MODEL || 'nomic-embed-text:latest';
// qdrant-work sits on its own docker network; wren-ladn is joined to it (qdrant-work_default).
const QDRANT_URL  = process.env.HISTORY_QDRANT_URL || process.env.APPRENTICE_QDRANT_URL || 'http://qdrant-work:6333';
const COLLECTION  = 'wren-history';
const USE_QDRANT  = process.env.HISTORY_USE_QDRANT !== 'false';

// nomic-embed-text has a noisy baseline cosine — keep a floor so unrelated text is dropped.
const SCORE_FLOOR = parseFloat(process.env.HISTORY_SCORE_FLOOR || '0.5');

async function embed(text) {
  const resp = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: String(text).slice(0, 4000) }),
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error(`embed ${resp.status}`);
  const j = await resp.json();
  if (!Array.isArray(j.embedding)) throw new Error('no embedding');
  return j.embedding;
}

async function qdrantSearch(query, k) {
  const vec = await embed(query);
  const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector: vec, limit: k, with_payload: true, score_threshold: SCORE_FLOOR }),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`qdrant ${resp.status}`);
  const j = await resp.json();
  return (j.result || []).map(p => ({
    source_label: p.payload?.source_label || 'history corpus',
    category: p.payload?.category || null,
    title: p.payload?.title || null,
    text: p.payload?.text || '',
    score: p.score,
  })).filter(c => c.text);
}

async function ftsSearch(pool, query, k) {
  // Pass 1: websearch (AND-ish) — high precision.
  let { rows } = await pool.query(
    `SELECT source_label, category, title, content AS text,
            ts_rank_cd(tsv, websearch_to_tsquery('english',$1)) AS score
       FROM wren_history_corpus
      WHERE tsv @@ websearch_to_tsquery('english',$1)
      ORDER BY score DESC LIMIT $2`, [query, k]).catch(() => ({ rows: [] }));
  if (rows.length) return rows;
  // Pass 2: OR of significant terms — high recall.
  const terms = String(query || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !['what', 'when', 'does', 'with', 'that', 'this', 'have', 'your', 'they', 'about', 'were', 'often', 'many', 'much', 'staff', 'from'].includes(w));
  if (!terms.length) return [];
  const orQuery = [...new Set(terms)].join(' | ');
  ({ rows } = await pool.query(
    `SELECT source_label, category, title, content AS text,
            ts_rank_cd(tsv, to_tsquery('english',$1)) AS score
       FROM wren_history_corpus
      WHERE tsv @@ to_tsquery('english',$1)
      ORDER BY score DESC LIMIT $2`, [orQuery, k]).catch(() => ({ rows: [] })));
  return rows;
}

/**
 * retrieve(pool, query, k) → { chunks:[{source_label,text,category,title,score}], mode }
 * mode: 'qdrant' | 'fts' | 'none'. Always falls back to FTS so the runtime stays grounded.
 */
async function retrieve(pool, query, k = 8) {
  if (USE_QDRANT) {
    try {
      const chunks = await qdrantSearch(query, k);
      if (chunks.length) return { chunks, mode: 'qdrant' };
      // qdrant reachable but nothing above floor → try FTS before giving up.
    } catch (e) {
      console.warn('[history-rag] qdrant unavailable, falling back to FTS:', e.message);
    }
  }
  try {
    const chunks = await ftsSearch(pool, query, k);
    return { chunks, mode: chunks.length ? 'fts' : 'none' };
  } catch (e) {
    console.error('[history-rag] FTS error:', e.message);
    return { chunks: [], mode: 'none' };
  }
}

function buildGroundingBlock(chunks) {
  if (!chunks.length) return '';
  // chunks are already bounded (~1800 chars at ingest; payload sliced to 2000) — pass them
  // whole so tail-of-chunk tables (e.g. the by-month seasonality table) reach the model.
  const lines = chunks.map((c, i) => `[#${i + 1} | ${c.source_label}]\n${String(c.text).slice(0, 2000)}`);
  return `\n\nRETRIEVED HISTORY PASSAGES (your factual source — prefer these numbers over any assumption):\n\n${lines.join('\n\n')}`;
}

function sourceLabels(chunks, max = 5) {
  return [...new Set(chunks.map(c => c.source_label))].slice(0, max);
}

module.exports = { retrieve, buildGroundingBlock, sourceLabels, COLLECTION };
