'use strict';
/**
 * gov-corpus.js — API routes for the statutory document library
 *
 * Auth levels:
 *   - document list, search, view:  any logged-in user (staff or parent)
 *   - /rag-context:                 staff only (role check)
 *
 * OGL attribution: every response includes ogl_notice field.
 * Raw source files served inline so browser PDF viewer can display them.
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const router = express.Router();

const CORPUS_BASE = path.join(__dirname, '..', '..', 'data', 'gov-corpus');
const OGL_NOTICE  = 'Contains public sector information licensed under the Open Government Licence v3.0. https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/';

// All gov-corpus routes require authentication
router.use(authenticate);

// ── Helper: is the user staff (not parent-only)? ──────────────────────────────

function isStaff(req) {
  const role = req.user?.role || req.user?.edition || '';
  // Parents portal sets role='parent'; all others are staff
  return role !== 'parent';
}

// ── GET /api/gov-corpus/documents ─────────────────────────────────────────────
// List all current documents
// Query: ?category=safeguarding&audience=both

router.get('/documents', async (req, res) => {
  const pool = getPool();
  const { category, audience } = req.query;
  const conditions = ['d.is_current = true'];
  const params = [];

  // Parents can only see docs with audience in ('parents','both')
  if (!isStaff(req)) {
    conditions.push(`d.audience IN ('parents','both')`);
  }
  if (category) {
    params.push(category);
    conditions.push(`d.category = $${params.length}`);
  }
  if (audience) {
    params.push(audience);
    conditions.push(`d.audience = $${params.length}`);
  }

  const where = conditions.join(' AND ');
  const sql = `
    SELECT
      d.slug, d.title, d.publisher, d.category, d.audience,
      d.current_version_date, d.page_count, d.word_count,
      d.source_url, d.ogl_status,
      (SELECT COUNT(*) FROM public.gov_corpus_chunks c WHERE c.document_id = d.id) AS chunk_count
    FROM public.gov_corpus_documents d
    WHERE ${where}
    ORDER BY d.category, d.title
  `;
  try {
    const { rows } = await pool.query(sql, params);
    res.json({ documents: rows, ogl_notice: OGL_NOTICE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/gov-corpus/documents/:slug ───────────────────────────────────────
// Single doc metadata + first 2000 chars of text preview

router.get('/documents/:slug', async (req, res) => {
  const pool = getPool();
  const { slug } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM public.gov_corpus_documents WHERE slug = $1 AND is_current = true`,
      [slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Document not found' });
    const doc = rows[0];

    // Parent access control
    if (!isStaff(req) && !['parents','both'].includes(doc.audience)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Text preview
    let preview = null;
    if (doc.text_path) {
      const fullPath = path.join(__dirname, '..', '..', doc.text_path);
      if (fs.existsSync(fullPath)) {
        const raw = fs.readFileSync(fullPath, 'utf8');
        preview = raw.slice(0, 2000);
      }
    }

    res.json({ document: doc, preview, ogl_notice: OGL_NOTICE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/gov-corpus/documents/:slug/full ──────────────────────────────────
// Full parsed text as markdown

router.get('/documents/:slug/full', async (req, res) => {
  const pool = getPool();
  const { slug } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT audience, text_path, title FROM public.gov_corpus_documents WHERE slug = $1 AND is_current = true`,
      [slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Document not found' });
    const doc = rows[0];

    if (!isStaff(req) && !['parents','both'].includes(doc.audience)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!doc.text_path) return res.status(404).json({ error: 'Text not yet indexed' });
    const fullPath = path.join(__dirname, '..', '..', doc.text_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Text file not found' });

    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', `inline; filename="${slug}.md"`);
    res.sendFile(fullPath);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/gov-corpus/documents/:slug/source ────────────────────────────────
// Original PDF/HTML — served inline

router.get('/documents/:slug/source', async (req, res) => {
  const pool = getPool();
  const { slug } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT audience, source_path, title FROM public.gov_corpus_documents WHERE slug = $1 AND is_current = true`,
      [slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Document not found' });
    const doc = rows[0];

    if (!isStaff(req) && !['parents','both'].includes(doc.audience)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!doc.source_path) return res.status(404).json({ error: 'Source not yet downloaded' });
    const fullPath = path.join(__dirname, '..', '..', doc.source_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Source file not found' });

    const ext = path.extname(fullPath).toLowerCase();
    const mimeMap = { '.pdf': 'application/pdf', '.html': 'text/html', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const mime = mimeMap[ext] || 'application/octet-stream';

    res.set('Content-Type', mime);
    res.set('Content-Disposition', `inline; filename="${slug}${ext}"`);
    res.sendFile(fullPath);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/gov-corpus/search ────────────────────────────────────────────────
// Full-text search across all current chunks
// Query: ?q=<text>&category=<opt>&audience=<opt>&limit=10

router.get('/search', async (req, res) => {
  const pool = getPool();
  const { q, category, audience, limit = 10 } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Query too short' });

  const conditions = ['d.is_current = true', `c.search_vector @@ plainto_tsquery('english', $1)`];
  const params = [q.trim()];

  if (!isStaff(req)) {
    conditions.push(`d.audience IN ('parents','both')`);
  }
  if (category) { params.push(category); conditions.push(`d.category = $${params.length}`); }
  if (audience) { params.push(audience); conditions.push(`d.audience = $${params.length}`); }

  params.push(Math.min(parseInt(limit, 10) || 10, 50));
  const lim = `$${params.length}`;

  const sql = `
    SELECT
      d.slug        AS document_slug,
      d.title       AS document_title,
      d.publisher,
      d.category,
      c.chapter,
      c.page_start,
      c.page_end,
      ts_headline('english', c.content_text, plainto_tsquery('english', $1),
        'MaxWords=30, MinWords=15, ShortWord=3, HighlightAll=false') AS chunk_excerpt,
      ts_rank(c.search_vector, plainto_tsquery('english', $1))       AS rank
    FROM public.gov_corpus_chunks c
    JOIN public.gov_corpus_documents d ON d.id = c.document_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY rank DESC
    LIMIT ${lim}
  `;
  try {
    const { rows } = await pool.query(sql, params);
    res.json({ results: rows, query: q, ogl_notice: OGL_NOTICE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/gov-corpus/rag-context ───────────────────────────────────────────
// Internal endpoint — staff only. Returns chunks for AI grounding.
// Query: ?topic=<text>&max_chunks=5

router.get('/rag-context', async (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Staff access only' });

  const pool = getPool();
  const { topic, max_chunks = 5 } = req.query;
  if (!topic || topic.trim().length < 3) return res.status(400).json({ error: 'topic required' });

  const maxC = Math.min(parseInt(max_chunks, 10) || 5, 20);
  const sql = `
    SELECT
      d.title       AS document_title,
      d.slug,
      d.current_version_date AS version_date,
      d.source_url,
      d.publisher,
      c.content_text AS chunk_text,
      c.chapter,
      c.page_start   AS page,
      ts_rank(c.search_vector, plainto_tsquery('english', $1)) AS rank
    FROM public.gov_corpus_chunks c
    JOIN public.gov_corpus_documents d ON d.id = c.document_id
    WHERE c.search_vector @@ plainto_tsquery('english', $1)
      AND d.is_current = true
    ORDER BY rank DESC
    LIMIT $2
  `;
  try {
    const { rows } = await pool.query(sql, [topic.trim(), maxC]);
    res.json({
      topic,
      chunks: rows,
      ogl_notice: OGL_NOTICE,
      instructions: 'When citing these sources, include document_title, version_date, and source_url. Always show the OGL attribution.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/gov-corpus/categories ───────────────────────────────────────────
// Category list with counts — used by the sidebar in the doc browser

router.get('/categories', async (req, res) => {
  const pool = getPool();
  const audienceFilter = isStaff(req) ? '' : `AND audience IN ('parents','both')`;
  try {
    const { rows } = await pool.query(`
      SELECT category, COUNT(*) AS count
      FROM public.gov_corpus_documents
      WHERE is_current = true ${audienceFilter}
      GROUP BY category
      ORDER BY category
    `);
    res.json({ categories: rows, ogl_notice: OGL_NOTICE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
