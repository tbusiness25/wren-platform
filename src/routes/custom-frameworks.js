'use strict';
// Custom curriculum frameworks — list/create/edit/delete manager-defined framework
// statement sets, plus a RAG chat assistant grounded in the gov-corpus.
// Repaired + finished 2026-07-14 (b91 local-model fragment from 2026-07-13):
//  - unqualified table names so demo/HT editions resolve their own schema via
//    search_path (the hard-coded ladn.* would have made demo writes hit prod)
//  - real transactions on a single client (pool.query BEGIN/COMMIT spans
//    different pool connections and protects nothing)
//  - global fetch (node 20), self-call uses the request's own host/port
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getPool } = require('../db/pool');

// A framework slug is custom iff it carries the custom marker; the standard
// sets (eyfs, birth-to-5 etc.) can never be edited or deleted through here.
function isCustom(framework) {
  return typeof framework === 'string' && framework.includes('custom');
}

router.use(authenticate);
router.use(authenticate.requireRole('manager'));

// GET / — list frameworks with statement counts and custom flag
router.get('/', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT framework, COUNT(*) AS statement_count
      FROM framework_statements
      GROUP BY framework
      ORDER BY framework`);
    res.json({
      frameworks: rows.map(r => ({
        framework: r.framework,
        statement_count: parseInt(r.statement_count, 10),
        custom: isCustom(r.framework),
      })),
    });
  } catch (e) {
    console.error('[custom-frameworks] list:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function insertAreas(client, slug, areas) {
  let ordinal = 1;
  for (const areaObj of areas) {
    const { area, aspect, age_band, statements } = areaObj || {};
    if (!area || !Array.isArray(statements) || !statements.length) continue;
    for (const stmt of statements) {
      await client.query(
        `INSERT INTO framework_statements (framework, area, aspect, age_range, statement_text, ordinal)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [slug, area, aspect || null, age_band || null, stmt, ordinal]
      );
      ordinal++;
    }
  }
  return ordinal - 1;
}

// POST / — create a custom framework
router.post('/', async (req, res) => {
  const { name, slug, areas } = req.body || {};
  if (!name || !slug || !Array.isArray(areas) || !areas.length) {
    return res.status(400).json({ error: 'name, slug, and areas required' });
  }
  if (!isCustom(slug)) {
    return res.status(400).json({ error: 'slug must indicate custom framework (include "custom")' });
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: exist } = await client.query(
      'SELECT 1 FROM framework_statements WHERE framework=$1 LIMIT 1', [slug]);
    if (exist.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Framework slug already exists' });
    }
    const count = await insertAreas(client, slug, areas);
    if (!count) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No valid statements supplied' });
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, framework: slug, statements: count });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[custom-frameworks] create:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// PUT /:slug — edit a custom framework (replace statements)
router.put('/:slug', async (req, res) => {
  const { slug } = req.params;
  const { areas } = req.body || {};
  if (!isCustom(slug)) return res.status(400).json({ error: 'Can only edit custom frameworks' });
  if (!Array.isArray(areas) || !areas.length) return res.status(400).json({ error: 'areas required' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM framework_statements WHERE framework=$1', [slug]);
    const count = await insertAreas(client, slug, areas);
    if (!count) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No valid statements supplied — framework left unchanged' });
    }
    await client.query('COMMIT');
    res.json({ ok: true, framework: slug, statements: count });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[custom-frameworks] update:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// DELETE /:slug — remove a custom framework
router.delete('/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!isCustom(slug)) return res.status(400).json({ error: 'Can only delete custom frameworks' });
  try {
    const r = await getPool().query('DELETE FROM framework_statements WHERE framework=$1', [slug]);
    res.json({ ok: true, framework: slug, deleted: r.rowCount });
  } catch (e) {
    console.error('[custom-frameworks] delete:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Helper: Ollama chat (Ascent in prod via OLLAMA_HOST)
async function answerWithOllama(systemPrompt, userPrompt) {
  const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const model = process.env.CUSTOM_FRAMEWORKS_MODEL || process.env.OLLAMA_MODEL || 'gpt-oss:120b';
  const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) throw new Error(`Ollama chat ${resp.status}`);
  const data = await resp.json();
  return data.message?.content?.trim() || '';
}

// POST /chat — curriculum-design chat grounded in gov-corpus RAG context.
// Queries the corpus directly (same SQL as /api/gov-corpus/rag-context) instead
// of the b91 fragment's HTTP self-call to localhost:3015, which only ever worked
// on the dev container and broke on portal-audience mismatches.
router.post('/chat', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages array required' });
  const userMsg = messages[messages.length - 1];
  if (!userMsg || !userMsg.content) return res.status(400).json({ error: 'last message must have content' });
  try {
    const RAG_SQL = (tsfn) => `
      SELECT d.title, d.source_url AS source, c.content_text AS chunk_text
      FROM public.gov_corpus_chunks c
      JOIN public.gov_corpus_documents d ON d.id = c.document_id
      WHERE c.search_vector @@ ${tsfn}
        AND d.is_current = true
      ORDER BY ts_rank(c.search_vector, ${tsfn}) DESC
      LIMIT 8`;
    // Strict AND match first; a full question rarely matches every word, so fall
    // back to OR-ing the same lexemes when nothing is found.
    let { rows: chunks } = await getPool().query(RAG_SQL(`plainto_tsquery('english', $1)`), [userMsg.content.trim()]);
    if (!chunks.length) {
      ({ rows: chunks } = await getPool().query(
        RAG_SQL(`to_tsquery('english', regexp_replace(plainto_tsquery('english', $1)::text, '&', '|', 'g'))`),
        [userMsg.content.trim()]));
    }
    const context = chunks.map((c, i) => `[#${i + 1}] ${c.title}\n${c.chunk_text}`).join('\n\n');
    const systemPrompt = `You are a curriculum design assistant for a UK early-years setting. Use only the provided context passages to answer the manager's question. Cite passages by their number in brackets, e.g., [#1].\n\nContext:\n${context}`;
    const answer = await answerWithOllama(systemPrompt, userMsg.content);
    res.json({ answer, sources: chunks.map(c => ({ document: c.title, url: c.source })) });
  } catch (e) {
    console.error('[custom-frameworks] chat:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
