'use strict';
/**
 * grounding.js — b348: what the model is told about Wren itself, before it sees any numbers.
 *
 * Two sources, both about the SYSTEM and neither about a person:
 *   1. Documentation — passages of the Wren manuals, retrieved by Postgres full-text search from
 *      wren_chat_doc_chunks (filled by scripts/b348-ingest-docs.js). Each chunk was run through
 *      the redactor at ingest, and the outbound gate masks whatever is sent again.
 *   2. The live schema — table and column NAMES from information_schema (never a value), so it
 *      can explain where Wren keeps something. Only tables that match the question are spelled out.
 * The third source, live counts, is not here: it comes through the query layer, by function call.
 *
 * Deliberately NOT used: the wren-history / wren-brain / assistant-uploads vector stores. Those
 * hold row-level nursery records and stay on the on-site model.
 */

const { LIMITS } = require('./policy');

const STOP = new Set(('what which where when have does this that with from about there their they them then than into over under many much more most some ' +
  'were will would could should your yours also just like need show tell give please wren chat nursery children child staff how the and for are you can').split(/\s+/));

const words = (q) => [...new Set((String(q).toLowerCase().replace(/\[[a-z_]+\]/g, ' ').match(/[a-z][a-z_]{3,}/g) || []).filter((w) => !STOP.has(w)))].slice(0, 12);

async function retrieveDocs(db, redactedQuestion, { limit = 6 } = {}) {
  const ws = words(redactedQuestion);
  if (!ws.length) return [];
  let rows = [];
  try {
    const strict = await db.query(
      `SELECT source, title, body, ts_rank(tsv, q) AS rank FROM wren_chat_doc_chunks, websearch_to_tsquery('english', $1) q
        WHERE tsv @@ q ORDER BY rank DESC LIMIT $2`, [ws.join(' '), limit]);
    rows = strict.rows;
    if (rows.length < 2) {
      const loose = await db.query(
        `SELECT source, title, body, ts_rank(tsv, q) AS rank FROM wren_chat_doc_chunks, to_tsquery('english', $1) q
          WHERE tsv @@ q ORDER BY rank DESC LIMIT $2`, [ws.map((w) => w.replace(/[^a-z_]/g, '')).filter(Boolean).join(' | '), limit]);
      rows = loose.rows;
    }
  } catch (_) { return []; }          // no corpus yet (table empty / not migrated): answer without documentation
  const out = [];
  let used = 0;
  for (const r of rows) {
    const body = String(r.body).trim();
    if (used + body.length > LIMITS.maxDocChars) break;
    used += body.length;
    out.push({ source: r.source, title: r.title, body });
  }
  return out;
}

// ── schema ──────────────────────────────────────────────────────────────────
const SHORT = { 'character varying': 'text', 'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp', integer: 'int', bigint: 'bigint', boolean: 'bool', 'double precision': 'float', ARRAY: 'array', 'time without time zone': 'time' };
let cache = { at: 0, map: null };

async function loadSchema(db) {
  if (cache.map && Date.now() - cache.at < 10 * 60 * 1000) return cache.map;
  const { rows } = await db.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name NOT LIKE 'wren\\_chat\\_%'
      ORDER BY table_name, ordinal_position`);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, []);
    map.get(r.table_name).push(r.column_name + ':' + (SHORT[r.data_type] || r.data_type));
  }
  cache = { at: Date.now(), map };
  return map;
}

async function schemaDigest(db, redactedQuestion) {
  let map;
  try { map = await loadSchema(db); } catch (_) { return ''; }
  const ws = words(redactedQuestion);
  const scored = [];
  for (const [t, cols] of map) {
    let s = 0;
    for (const w of ws) { if (t.includes(w)) s += 3; for (const c of cols) if (c.startsWith(w) || c.includes('_' + w)) s += 1; }
    if (s > 0) scored.push([s, t]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const lines = [];
  let used = 0;
  for (const [, t] of scored.slice(0, 5)) {
    const line = t + '(' + map.get(t).slice(0, 28).join(', ') + ')';
    if (used + line.length > LIMITS.maxSchemaChars * 0.7) break;
    lines.push(line); used += line.length;
  }
  const all = [...map.keys()].join(', ');
  const room = LIMITS.maxSchemaChars - used;
  return (lines.length ? 'Tables that look relevant (column:type):\n' + lines.join('\n') + '\n\n' : '') +
         'All table names: ' + (all.length > room ? all.slice(0, Math.max(0, room)).replace(/,[^,]*$/, '') + ', …' : all);
}

module.exports = { retrieveDocs, schemaDigest, words };
