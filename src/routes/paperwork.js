'use strict';
/*
 * b269 — The paperwork store.
 *
 * Everything the nursery holds on paper, readable on a tablet. Drag a folder of
 * scans onto the drop zone; each file is queued, OCR'd if it needs it, read by
 * the LOCAL model on the Ascent, and offered back as a PROPOSAL. Nothing is
 * filed until a person accepts it — getting a policy filed under the wrong
 * heading is worse than not filing it.
 *
 * ── Where this router is allowed to run ────────────────────────────────────
 *   admin    (Roost)   full management: upload, review, re-file, delete, receipts.
 *   learning (EY)      READ AND SEARCH ONLY, and only the categories marked
 *                      ey_visible — policies, curriculum, health & safety,
 *                      external guidance, children's records. Not staff files,
 *                      not finance. This is the "everything on a tablet" case.
 *   parents / hr       403. 'paperwork' is also on PARENT_DENY in
 *                      server-unified.js; this is the belt-and-braces layer.
 *
 * ── Two gates, not one ─────────────────────────────────────────────────────
 * The PORTAL gate above is policy: a room tablet never shows the DBS folder
 * however generous the permissions matrix is. The CAPABILITY gate below is the
 * matrix: one capability per top-level heading (paperwork.finance,
 * paperwork.staff-suitability, …) resolved through src/lib/capabilities.js.
 * Reading needs any level; changing what a document IS needs 'edit' or better.
 *
 * Note the level-aware calls throughout: hasCapability() ignores level, so a
 * bare 'view' grant would otherwise open every write path.
 */

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { CAPABILITY_LEVELS, roleKeyFor } = require('../lib/capabilities');
const pipeline = require('../services/paperwork-pipeline');
const ai = require('../lib/ai-models');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';

// Files live on disk under the existing uploads mount — a path, a sha256 and the
// extracted text go in the database, never the bytes.
const STORE_BASE = process.env.PAPERWORK_BASE
  || path.join(process.env.UPLOADS_DIR || '/app/uploads', 'paperwork');

const MAX_BYTES = parseInt(process.env.PAPERWORK_MAX_BYTES, 10) || 60 * 1024 * 1024; // 60MB — a 300dpi A4 scan set
const MAX_FILES = parseInt(process.env.PAPERWORK_MAX_FILES, 10) || 100;              // one folder-drag

const ALLOWED_EXT = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp',
  '.heic', '.heif', '.docx', '.txt', '.md', '.csv',
]);
const MIME_BY_EXT = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(STORE_BASE, 'incoming');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `pw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: MAX_FILES },
  fileFilter(req, file, cb) {
    cb(null, ALLOWED_EXT.has(path.extname(file.originalname).toLowerCase()));
  },
});

router.use(authenticate);

// ── Portal gate ─────────────────────────────────────────────────────────────

function portal(req) { return req._portal || 'admin'; }
const READ_ONLY_PORTALS = new Set(['learning']);

router.use((req, res, next) => {
  const p = portal(req);
  if (p !== 'admin' && p !== 'learning') {
    return res.status(403).json({ error: 'The paperwork store is not available on this portal' });
  }
  if (req.user && req.user.role === 'parent') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (READ_ONLY_PORTALS.has(p) && req.method !== 'GET') {
    return res.status(403).json({ error: 'The paperwork store is read-only on the EY portal' });
  }
  next();
});

// Numeric :id guard. Express 5 / path-to-regexp v8 dropped the inline `:id(\\d+)`
// form, so the constraint that keeps /receipts from being read as a document id
// lives here instead — same shape as src/routes/work-patterns.js.
router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'Not found' });
  next();
});

// ── Category access ─────────────────────────────────────────────────────────

let _catCache = null, _catCacheAt = 0;
async function allCategories(db) {
  if (_catCache && Date.now() - _catCacheAt < 60000) return _catCache;
  try {
    const { rows } = await db.query(
      `SELECT key, label, capability, ey_visible, description, sort_order
         FROM ${SCHEMA()}.paperwork_categories ORDER BY sort_order, key`);
    _catCache = rows; _catCacheAt = Date.now();
    return rows;
  } catch (e) {
    // This router is mounted on every edition, but the b269 migration has only
    // been applied where someone ran it. On a schema without the tables, return
    // NO headings rather than a 500: the screen then honestly says there is
    // nothing you can see, instead of showing a broken card. (42P01 =
    // undefined_table.) Any other error is a real fault and is re-thrown.
    if (e.code !== '42P01') throw e;
    _catCache = []; _catCacheAt = Date.now();
    return [];
  }
}

function rank(level) {
  const i = CAPABILITY_LEVELS.indexOf(String(level || '').trim());
  return i < 0 ? -1 : i;
}

/**
 * The caller's level on ALL TEN paperwork capabilities, in ONE query.
 *
 * capabilityLevel() takes one round trip per key, and this router asks about every
 * heading on nearly every request (search resolves the readable set before it can
 * build the WHERE clause) — ten round trips per search, twenty for a document read.
 * Same semantics, deliberately: manager / headteacher / Toby resolve to 'manage'
 * without a query, the role grant and the per-staff override are UNIONed and the
 * HIGHER wins, and a DB error fails CLOSED.
 *
 * @returns {Promise<Map<string,string>>} capability key → level, absent when none
 */
async function levelsFor(user, db, capKeys) {
  const out = new Map();
  if (!user || !capKeys.length) return out;
  if (Number(user.id) === 1 || hasRole(user, ['manager', 'admin']) || user.role === 'headteacher') {
    capKeys.forEach(k => out.set(k, 'manage'));
    return out;
  }
  try {
    const { rows } = await db.query(
      `SELECT c.key, rc.level
         FROM ${SCHEMA()}.capabilities c
         JOIN ${SCHEMA()}.role_capabilities rc ON rc.capability_id = c.id
         JOIN ${SCHEMA()}.roles r ON r.id = rc.role_id
        WHERE c.key = ANY($1) AND r.key = $2 AND rc.level IS NOT NULL AND rc.level <> ''
       UNION ALL
       SELECT c.key, sc.level
         FROM ${SCHEMA()}.capabilities c
         JOIN ${SCHEMA()}.staff_capabilities sc ON sc.capability_id = c.id
        WHERE c.key = ANY($1) AND sc.staff_id = $3 AND sc.level IS NOT NULL AND sc.level <> ''`,
      [capKeys, roleKeyFor(user), Number(user.id)]);
    for (const r of rows) {
      if (rank(r.level) > rank(out.get(r.key))) out.set(r.key, r.level);
    }
  } catch (e) {
    // Fail closed — a transient DB error must never widen access to the filing
    // cabinet. An empty map means "holds nothing".
    console.error('[paperwork] levelsFor:', e.message);
    return new Map();
  }
  return out;
}

/**
 * The categories this caller may READ, on THIS portal.
 * @returns {Promise<Map<string, {cat:object, level:string}>>}
 */
/** Every paperwork level this caller holds, resolved once and memoised per request. */
async function levels(req, db) {
  if (!req._pwLevels) {
    const cats = await allCategories(db);
    req._pwLevels = await levelsFor(req.user, db, cats.map(c => c.capability));
  }
  return req._pwLevels;
}

async function readableCategories(req, db) {
  const p = portal(req);
  const cats = await allCategories(db);
  const lv = await levels(req, db);
  const out = new Map();
  for (const c of cats) {
    // EY portal: policy narrows the set before the matrix is even consulted.
    if (p === 'learning' && !c.ey_visible) continue;
    const level = lv.get(c.capability);
    if (level) out.set(c.key, { cat: c, level });
  }
  return out;
}

/** Can this caller CHANGE what a document in `categoryKey` is? Needs edit or better. */
async function canWriteCategory(req, db, categoryKey) {
  if (READ_ONLY_PORTALS.has(portal(req))) return false;
  const cats = await allCategories(db);
  const c = cats.find(x => x.key === categoryKey);
  if (!c) return false;
  return rank((await levels(req, db)).get(c.capability)) >= rank('edit');
}

/** An uncategorised document (still in review) is governed by whoever may file at all. */
async function canFileAtAll(req, db) {
  if (READ_ONLY_PORTALS.has(portal(req))) return false;
  const cats = await allCategories(db);
  const lv = await levels(req, db);
  return cats.some(c => rank(lv.get(c.capability)) >= rank('edit'));
}

// ── Dates on the way out ────────────────────────────────────────────────────
// pg hands a DATE column back as a JS Date at LOCAL midnight, so res.json()'s
// toISOString() rolls it to the previous day for any positive UTC offset — a
// receipt dated 12 May reads as 11 May for the whole of British Summer Time.
// Convert with LOCAL getters, never String() and never toISOString().
// (Same trap as the 2026-08-26 date-format sweep; this is the same fix.)
function ymd(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Normalise the two DATE columns wherever a row leaves this router. */
function fixDates(row) {
  if (!row || typeof row !== 'object') return row;
  if ('document_date' in row) row.document_date = ymd(row.document_date);
  if ('receipt_date'  in row) row.receipt_date  = ymd(row.receipt_date);
  return row;
}

async function audit(db, documentId, action, staffId, detail) {
  try {
    await db.query(
      `INSERT INTO ${SCHEMA()}.paperwork_audit (document_id, action, staff_id, detail)
       VALUES ($1,$2,$3,$4)`,
      [documentId, action, staffId || null, detail ? JSON.stringify(detail) : null]);
  } catch (e) { console.error('[paperwork] audit:', e.message); }
}

/**
 * Load a document and decide whether the caller may see it.
 * A document still in review has no category yet, so it is visible to whoever
 * uploaded it and to anyone who may file at all — not to the whole setting.
 */
async function loadReadable(req, db, id) {
  const { rows: [doc] } = await db.query(
    `SELECT * FROM ${SCHEMA()}.paperwork_documents WHERE id=$1 AND deleted=false`, [id]);
  if (!doc) return { doc: null, allowed: false, reason: 404 };

  if (doc.category) {
    const readable = await readableCategories(req, db);
    if (!readable.has(doc.category)) return { doc, allowed: false, reason: 403 };
    return { doc, allowed: true };
  }
  const mine = Number(doc.uploaded_by) === Number(req.user.id);
  const filer = await canFileAtAll(req, db);
  return { doc, allowed: mine || filer, reason: 403 };
}

// ═══════════════════════════════════════════════════════════════════════════
// Reference data
// ═══════════════════════════════════════════════════════════════════════════

// GET /categories — the fixed top level, narrowed to what the caller may read,
// with a live count per heading so the UI can show an empty drawer as empty.
router.get('/categories', async (req, res) => {
  try {
    const db = getPool();
    const readable = await readableCategories(req, db);
    const keys = [...readable.keys()];
    if (!keys.length) return res.json({ categories: [], can_upload: false });

    const { rows: counts } = await db.query(
      `SELECT category, count(*)::int AS n
         FROM ${SCHEMA()}.paperwork_documents
        WHERE deleted=false AND status='filed' AND category = ANY($1)
        GROUP BY category`, [keys]);
    const byKey = Object.fromEntries(counts.map(r => [r.category, r.n]));

    const { rows: pinned } = await db.query(
      `SELECT category, subfolder, why, statutory
         FROM ${SCHEMA()}.paperwork_pinned_folders
        WHERE category = ANY($1) ORDER BY category, sort_order, subfolder`, [keys]);

    res.json({
      categories: keys.map(k => {
        const { cat, level } = readable.get(k);
        return {
          key: cat.key, label: cat.label, description: cat.description,
          ey_visible: cat.ey_visible, level,
          can_write: !READ_ONLY_PORTALS.has(portal(req)) && rank(level) >= rank('edit'),
          document_count: byKey[k] || 0,
          pinned_folders: pinned.filter(p => p.category === k),
        };
      }),
      can_upload: await canFileAtAll(req, db),
      read_only: READ_ONLY_PORTALS.has(portal(req)),
    });
  } catch (e) {
    console.error('[paperwork] categories:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /subfolders?category=policies — pinned folders first (with the statutory
// reason they exist), then whatever people have actually used.
router.get('/subfolders', async (req, res) => {
  try {
    const db = getPool();
    const cat = String(req.query.category || '');
    const readable = await readableCategories(req, db);
    if (!readable.has(cat)) return res.status(403).json({ error: 'Forbidden' });

    const { rows: pinned } = await db.query(
      `SELECT subfolder, why, statutory FROM ${SCHEMA()}.paperwork_pinned_folders
        WHERE category=$1 ORDER BY sort_order, subfolder`, [cat]);
    const { rows: used } = await db.query(
      `SELECT subfolder, count(*)::int AS n FROM ${SCHEMA()}.paperwork_documents
        WHERE category=$1 AND subfolder IS NOT NULL AND deleted=false
        GROUP BY subfolder ORDER BY subfolder`, [cat]);

    const pinnedNames = new Set(pinned.map(p => p.subfolder));
    res.json({
      pinned,
      used: used.filter(u => !pinnedNames.has(u.subfolder)),
    });
  } catch (e) {
    console.error('[paperwork] subfolders:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /health — is the pipeline actually able to work? Surfaced on the Roost
// page so "nothing is being OCR'd" has an answer other than a shrug.
router.get('/health', async (req, res) => {
  const db = getPool();
  const out = { ocr: false, ai: false, model: pipeline.aiModel(), host: pipeline.ollamaHost(), queue: null };
  try { out.ocr = await pipeline.ocrAvailable(); } catch (_) {}
  try {
    const r = await fetch(`${pipeline.ollamaHost()}/api/tags`, { signal: AbortSignal.timeout(6000) });
    out.ai = r.ok;
    if (r.ok) {
      const tags = await r.json();
      out.model_present = (tags.models || []).some(m => m.name === pipeline.aiModel());
    }
  } catch (e) { out.ai_error = e.message; }
  try {
    const { rows } = await db.query(
      `SELECT status, count(*)::int AS n FROM ${SCHEMA()}.paperwork_jobs GROUP BY status`);
    out.queue = Object.fromEntries(rows.map(r => [r.status, r.n]));
  } catch (_) {}
  res.json(out);
});

// ═══════════════════════════════════════════════════════════════════════════
// Upload
// ═══════════════════════════════════════════════════════════════════════════

// POST /upload — many files at once. Returns immediately (202): every file is a
// row in paperwork_jobs, so the browser is free and closing the tab loses nothing.
router.post('/upload', upload.array('files', MAX_FILES), async (req, res) => {
  const db = getPool();
  const staged = req.files || [];
  const cleanup = () => staged.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });

  try {
    if (!await canFileAtAll(req, db)) { cleanup(); return res.status(403).json({ error: 'Forbidden' }); }
    if (!staged.length) return res.status(400).json({ error: 'No files accepted (check the file types)' });

    const { rows: [batch] } = await db.query(
      `INSERT INTO ${SCHEMA()}.paperwork_batches (label, uploaded_by, file_count)
       VALUES ($1,$2,$3) RETURNING *`,
      [String(req.body.label || '').trim().slice(0, 200) || null, req.user.id, staged.length]);

    const results = [];
    for (const f of staged) {
      try {
        const sha = await pipeline.sha256File(f.path);

        // Dedupe on sha256 — Toby will scan the same document twice. The second
        // copy is not filed; the caller is told which row it already is.
        const { rows: [dupe] } = await db.query(
          `SELECT id, title, filename, category, status, deleted
             FROM ${SCHEMA()}.paperwork_documents WHERE sha256=$1`, [sha]);
        if (dupe) {
          try { fs.unlinkSync(f.path); } catch (_) {}
          results.push({ filename: f.originalname, duplicate: true, document_id: dupe.id,
            existing: { title: dupe.title, category: dupe.category, status: dupe.status, deleted: dupe.deleted } });
          continue;
        }

        // Content-addressed on disk: the sha is the filename, so the same bytes
        // can never occupy two paths.
        const ext = path.extname(f.originalname).toLowerCase() || '.bin';
        const now = new Date();
        const dir = path.join(STORE_BASE, String(now.getFullYear()),
          String(now.getMonth() + 1).padStart(2, '0'));
        fs.mkdirSync(dir, { recursive: true });
        const finalPath = path.join(dir, sha + ext);
        fs.renameSync(f.path, finalPath);

        const { rows: [doc] } = await db.query(
          `INSERT INTO ${SCHEMA()}.paperwork_documents
             (batch_id, sha256, filename, stored_path, mime, size_bytes, uploaded_by, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'queued') RETURNING id`,
          [batch.id, sha, f.originalname.slice(0, 300), finalPath,
           MIME_BY_EXT[ext] || f.mimetype || null, f.size, req.user.id]);

        await db.query(
          `INSERT INTO ${SCHEMA()}.paperwork_jobs (document_id, stage) VALUES ($1,'extract')`, [doc.id]);
        await audit(db, doc.id, 'uploaded', req.user.id, { filename: f.originalname, batch_id: batch.id });

        results.push({ filename: f.originalname, duplicate: false, document_id: doc.id });
      } catch (e) {
        try { fs.unlinkSync(f.path); } catch (_) {}
        results.push({ filename: f.originalname, error: e.message });
      }
    }

    const queued = results.filter(r => r.document_id && !r.duplicate).length;
    await db.query(`UPDATE ${SCHEMA()}.paperwork_batches SET file_count=$2 WHERE id=$1`,
      [batch.id, queued]);

    res.status(202).json({
      batch_id: batch.id, queued,
      duplicates: results.filter(r => r.duplicate).length,
      failed: results.filter(r => r.error).length,
      results,
    });
  } catch (e) {
    cleanup();
    console.error('[paperwork] upload:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /batches — recent drops, newest first.
router.get('/batches', async (req, res) => {
  try {
    const db = getPool();
    if (!await canFileAtAll(req, db)) return res.status(403).json({ error: 'Forbidden' });
    const { rows } = await db.query(
      `SELECT b.*, s.first_name || ' ' || s.last_name AS uploaded_by_name,
              (SELECT count(*)::int FROM ${SCHEMA()}.paperwork_documents d
                WHERE d.batch_id=b.id AND d.deleted=false) AS total,
              (SELECT count(*)::int FROM ${SCHEMA()}.paperwork_documents d
                WHERE d.batch_id=b.id AND d.deleted=false AND d.status IN ('queued','processing')) AS pending,
              (SELECT count(*)::int FROM ${SCHEMA()}.paperwork_documents d
                WHERE d.batch_id=b.id AND d.deleted=false AND d.status='review') AS in_review,
              (SELECT count(*)::int FROM ${SCHEMA()}.paperwork_documents d
                WHERE d.batch_id=b.id AND d.deleted=false AND d.status='filed') AS filed
         FROM ${SCHEMA()}.paperwork_batches b
         LEFT JOIN ${SCHEMA()}.staff s ON s.id = b.uploaded_by
        ORDER BY b.created_at DESC LIMIT 30`);
    res.json({ batches: rows });
  } catch (e) {
    console.error('[paperwork] batches:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /review — the review list: what the pipeline has proposed, awaiting a human.
router.get('/review', async (req, res) => {
  try {
    const db = getPool();
    if (!await canFileAtAll(req, db)) return res.status(403).json({ error: 'Forbidden' });

    const params = [];
    let where = `d.deleted=false AND d.status IN ('queued','processing','review','failed')`;
    if (req.query.batch_id) { params.push(Number(req.query.batch_id)); where += ` AND d.batch_id=$${params.length}`; }

    const { rows } = await db.query(
      `SELECT d.id, d.batch_id, d.filename, d.mime, d.size_bytes, d.page_count,
              d.extract_method, d.extract_chars, d.extract_error,
              d.ai_suggested, d.ai_model, d.ai_error, d.needs_ai, d.status,
              d.title, d.category, d.subfolder, d.document_date, d.summary, d.tags,
              d.uploaded_at,
              left(coalesce(d.extracted_text,''), 600) AS text_preview,
              r.supplier, r.receipt_date, r.total_amount, r.vat_amount, r.currency
         FROM ${SCHEMA()}.paperwork_documents d
         LEFT JOIN ${SCHEMA()}.paperwork_receipts r ON r.document_id = d.id
        WHERE ${where}
        ORDER BY d.uploaded_at DESC, d.id DESC
        LIMIT 300`, params);
    res.json({ documents: rows.map(fixDates) });
  } catch (e) {
    console.error('[paperwork] review:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Search
// ═══════════════════════════════════════════════════════════════════════════

// GET /search?q=&category=&subfolder=&from=&to=
// Postgres full-text over title / category / sub-folder / tags / summary / the
// extracted text. Scoped to the categories the caller may read, ALWAYS — a
// practitioner searching "invoice" must not learn that a finance document
// mentioning it exists.
router.get('/search', async (req, res) => {
  try {
    const db = getPool();
    const readable = await readableCategories(req, db);
    const keys = [...readable.keys()];
    if (!keys.length) return res.json({ results: [], total: 0, categories_searched: [] });

    const q = String(req.query.q || '').trim();
    const params = [keys];
    const clauses = [`d.deleted=false`, `d.category = ANY($1)`];

    // Only FILED documents are searchable: a proposal nobody has accepted is not
    // yet a fact about the setting.
    clauses.push(`d.status = 'filed'`);

    if (req.query.category) {
      if (!readable.has(String(req.query.category))) return res.status(403).json({ error: 'Forbidden' });
      params.push(String(req.query.category)); clauses.push(`d.category = $${params.length}`);
    }
    if (req.query.subfolder) { params.push(String(req.query.subfolder)); clauses.push(`d.subfolder = $${params.length}`); }
    if (req.query.from) { params.push(String(req.query.from)); clauses.push(`d.document_date >= $${params.length}::date`); }
    if (req.query.to)   { params.push(String(req.query.to));   clauses.push(`d.document_date <= $${params.length}::date`); }

    let rankSel = '0::float4 AS rank', order = 'd.document_date DESC NULLS LAST, d.id DESC';
    if (q) {
      params.push(q);
      const i = params.length;
      clauses.push(`d.search_tsv @@ websearch_to_tsquery('english', $${i})`);
      rankSel = `ts_rank_cd(d.search_tsv, websearch_to_tsquery('english', $${i}))::float4 AS rank`;
      order   = 'rank DESC, d.document_date DESC NULLS LAST';
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { rows } = await db.query(
      `SELECT d.id, d.title, d.category, d.subfolder, d.document_date, d.summary, d.tags,
              d.filename, d.mime, d.page_count, d.extract_method, d.uploaded_at,
              d.published_to_parents, ${rankSel},
              ${q ? `ts_headline('english', left(coalesce(d.extracted_text,''), 200000),
                       websearch_to_tsquery('english', $${params.length}),
                       'MaxFragments=2,MinWords=6,MaxWords=22,StartSel=<mark>,StopSel=</mark>')`
                  : `left(coalesce(d.summary, ''), 200)`} AS snippet
         FROM ${SCHEMA()}.paperwork_documents d
        WHERE ${clauses.join(' AND ')}
        ORDER BY ${order}
        LIMIT ${limit}`, params);

    res.json({ results: rows.map(fixDates), total: rows.length, query: q, categories_searched: keys });
  } catch (e) {
    console.error('[paperwork] search:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Accept — the human step. Nothing is filed without it.
// ═══════════════════════════════════════════════════════════════════════════

function cleanTags(v) {
  if (!Array.isArray(v)) return null;
  return v.map(t => String(t).toLowerCase().trim().slice(0, 40)).filter(Boolean).slice(0, 12);
}

/** Apply one accept. Shared by /:id/accept and /accept-bulk. */
async function acceptOne(req, db, id, patch) {
  const { rows: [doc] } = await db.query(
    `SELECT * FROM ${SCHEMA()}.paperwork_documents WHERE id=$1 AND deleted=false`, [id]);
  if (!doc) return { id, ok: false, error: 'Not found' };

  const sug = doc.ai_suggested || {};
  const category  = patch.category  !== undefined ? patch.category  : (doc.category  || sug.category  || null);
  if (!category) return { id, ok: false, error: 'A category is required' };
  if (!await canWriteCategory(req, db, category)) return { id, ok: false, error: 'Forbidden for that category' };
  // Re-filing OUT of a category needs the right to the category it is leaving too,
  // or a practitioner could quietly move a finance document into Policies.
  if (doc.category && doc.category !== category && !await canWriteCategory(req, db, doc.category)) {
    return { id, ok: false, error: 'Forbidden for its current category' };
  }

  const title     = patch.title     !== undefined ? patch.title     : (doc.title     || sug.title     || doc.filename);
  const subfolder = patch.subfolder !== undefined ? patch.subfolder : (doc.subfolder || sug.subfolder || null);
  // ymd() on the CURRENT value, not String(): pg hands document_date back as a JS
  // Date, and String(Date) is "Sat Mar 14 2026 00:00:00 GMT+0000…", which fails the
  // YYYY-MM-DD test below — so a re-file that did not resend the date silently
  // wiped it. Caught by scripts/b269-verify.js §6.
  const docDate   = patch.document_date !== undefined
    ? patch.document_date
    : (ymd(doc.document_date) || sug.document_date || null);
  const summary   = patch.summary   !== undefined ? patch.summary   : (doc.summary   || sug.summary   || null);
  const tags      = cleanTags(patch.tags) || (doc.tags && doc.tags.length ? doc.tags : cleanTags(sug.tags) || []);

  const { rows: [saved] } = await db.query(
    `UPDATE ${SCHEMA()}.paperwork_documents
        SET title=$2, category=$3, subfolder=$4, document_date=$5, summary=$6, tags=$7,
            notes = COALESCE($8, notes),
            status='filed', accepted_by=$9, accepted_at=now()
      WHERE id=$1 RETURNING id, title, category, subfolder, document_date, status`,
    [id, String(title || '').slice(0, 200) || doc.filename, category,
     subfolder ? String(subfolder).slice(0, 120) : null,
     docDate && /^\d{4}-\d{2}-\d{2}$/.test(String(docDate)) ? docDate : null,
     summary ? String(summary).slice(0, 4000) : null, tags,
     patch.notes !== undefined ? String(patch.notes || '').slice(0, 4000) || null : null,
     req.user.id]);

  fixDates(saved);
  await audit(db, id, doc.status === 'filed' ? 'refiled' : 'accepted', req.user.id, {
    from: { category: doc.category, subfolder: doc.subfolder },
    to:   { category: saved.category, subfolder: saved.subfolder },
    // Was the model right? Recorded so "should we trust the proposals?" is
    // answerable from data rather than from memory.
    ai_proposed: sug.category || null,
    accepted_ai_category: (sug.category || null) === saved.category,
  });
  return { id, ok: true, document: saved };
}

// POST /:id/accept — accept the proposal, with any edits the person made.
router.post('/:id/accept', async (req, res) => {
  try {
    const db = getPool();
    const out = await acceptOne(req, db, Number(req.params.id), req.body || {});
    if (!out.ok) return res.status(out.error === 'Not found' ? 404 : 403).json({ error: out.error });
    res.json(out.document);
  } catch (e) {
    console.error('[paperwork] accept:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /accept-bulk — the "looks right" button. Body: { ids: [1,2,3] } or
// { ids: [{id, category, title, ...}] } to accept with per-file edits.
// Each is checked on its own: a bulk accept that includes one document the
// caller may not file rejects THAT one and files the rest.
router.post('/accept-bulk', async (req, res) => {
  try {
    const db = getPool();
    const items = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    if (!items.length) return res.status(400).json({ error: 'ids required' });
    if (items.length > 300) return res.status(400).json({ error: 'Too many at once (max 300)' });

    const results = [];
    for (const it of items) {
      const id = Number(typeof it === 'object' ? it.id : it);
      if (!id) { results.push({ id: it, ok: false, error: 'Bad id' }); continue; }
      const patch = typeof it === 'object' ? { ...it } : {};
      delete patch.id;
      try { results.push(await acceptOne(req, db, id, patch)); }
      catch (e) { results.push({ id, ok: false, error: e.message }); }
    }
    res.json({ accepted: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
  } catch (e) {
    console.error('[paperwork] accept-bulk:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /receipts — the receipt ledger: what has been read off scans, what is
// confirmed, what is still nobody's.
router.get('/receipts', async (req, res) => {
  try {
    const db = getPool();
    const readable = await readableCategories(req, db);
    if (!readable.has('finance')) return res.status(403).json({ error: 'Forbidden' });
    const { rows } = await db.query(
      `SELECT r.*, d.title, d.filename, d.document_date, d.status
         FROM ${SCHEMA()}.paperwork_receipts r
         JOIN ${SCHEMA()}.paperwork_documents d ON d.id = r.document_id
        WHERE d.deleted=false
        ORDER BY COALESCE(r.receipt_date, d.document_date) DESC NULLS LAST, r.id DESC
        LIMIT 200`);
    res.json({ receipts: rows.map(fixDates) });
  } catch (e) {
    console.error('[paperwork] receipts:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// b290 — Deep Research
// ═══════════════════════════════════════════════════════════════════════════
// Toby: the reports and summaries written for him should be filed where he can
// read them at leisure. Same store, same capability gate, its own heading — and
// one thing the rest of the store does not do: it comes back in URGENCY order,
// with the evidence for that order attached to every row.
//
// GET /research  → { documents[], unread, folders[], scored_on }
//   documents[] carry urgency_score, urgency_reason and urgency_basis. The
//   basis is the sentence the score was read out of, so the ranking can be
//   argued with rather than merely disbelieved. Ordering is urgency first, then
//   the document's own date — never the other way round, which is the whole
//   point of the folder.
//
// POST /:id/read → mark it read for THIS person, which is what the Cockpit's
//   unread count counts. It is a per-person fact: Toby reading a report does not
//   make it read for the deputy.
//
// Registered BEFORE the /:id routes below, for the same reason GET /receipts is:
// the numeric router.param guard 404s a non-numeric id instead of calling
// next(), so '/research' declared after them would never run.

const RESEARCH_CATEGORY = 'deep-research';

router.get('/research', async (req, res) => {
  try {
    const db = getPool();
    const readable = await readableCategories(req, db);
    if (!readable.has(RESEARCH_CATEGORY)) {
      // A 403 with the reason, not a bare Forbidden: on the EY portal this is a
      // policy answer ("not on a room tablet"), everywhere else it is the matrix.
      return res.status(403).json({
        error: READ_ONLY_PORTALS.has(portal(req))
          ? 'Deep Research is not available on the room tablets'
          : 'You do not have permission to read Deep Research',
      });
    }

    const staffId = Number(req.user.id) || 0;
    const { rows } = await db.query(
      `SELECT d.id, d.title, d.filename, d.subfolder, d.document_date, d.summary,
              d.mime, d.size_bytes, d.tags, d.notes,
              d.urgency_score, d.urgency_reason, d.urgency_basis, d.urgency_deadline,
              d.urgency_scored_at, d.uploaded_at,
              (r.staff_id IS NOT NULL) AS read_by_me, r.read_at AS read_by_me_at
         FROM ${SCHEMA()}.paperwork_documents d
         LEFT JOIN ${SCHEMA()}.paperwork_document_reads r
                ON r.document_id = d.id AND r.staff_id = $1
        WHERE d.category = $2 AND d.deleted = false AND d.status = 'filed'
        -- URGENCY FIRST. NULLS LAST so a document filed by hand, which nobody
        -- has scored, sorts below everything that has a reason to be urgent
        -- rather than above it.
        ORDER BY d.urgency_score DESC NULLS LAST, d.document_date DESC NULLS LAST, d.id DESC
        LIMIT 500`, [staffId, RESEARCH_CATEGORY]);

    const documents = rows.map(r => {
      fixDates(r);
      if (r.urgency_deadline) r.urgency_deadline = ymd(r.urgency_deadline);
      return r;
    });

    const { rows: folders } = await db.query(
      `SELECT subfolder, count(*)::int AS n, max(urgency_score) AS top
         FROM ${SCHEMA()}.paperwork_documents
        WHERE category = $1 AND deleted = false AND status = 'filed'
        GROUP BY subfolder ORDER BY max(urgency_score) DESC NULLS LAST, subfolder`,
      [RESEARCH_CATEGORY]);

    res.json({
      documents,
      unread: documents.filter(d => !d.read_by_me).length,
      folders,
      can_write: await canWriteCategory(req, db, RESEARCH_CATEGORY),
      scored_on: documents.length && documents[0].urgency_basis
        ? documents[0].urgency_basis.scored_on || null : null,
    });
  } catch (e) {
    // 42703 = undefined_column: the b290 migration has not run on this schema.
    // Say that, rather than 500ing with a Postgres error code.
    if (e.code === '42703' || e.code === '42P01') {
      return res.json({ documents: [], unread: 0, folders: [], can_write: false,
        note: 'The Deep Research folder needs migrations/2026-09-08-b290-deep-research.sql' });
    }
    console.error('[paperwork] research:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /research/unread — just the number, for the Cockpit link. Deliberately
// tiny and deliberately silent about failure: a badge is never worth an error
// on somebody's dashboard.
router.get('/research/unread', async (req, res) => {
  try {
    const db = getPool();
    const readable = await readableCategories(req, db);
    if (!readable.has(RESEARCH_CATEGORY)) return res.json({ unread: 0, total: 0, visible: false });
    const { rows: [n] } = await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE r.staff_id IS NULL)::int AS unread,
              max(d.urgency_score) AS top
         FROM ${SCHEMA()}.paperwork_documents d
         LEFT JOIN ${SCHEMA()}.paperwork_document_reads r
                ON r.document_id = d.id AND r.staff_id = $1
        WHERE d.category = $2 AND d.deleted = false AND d.status = 'filed'`,
      [Number(req.user.id) || 0, RESEARCH_CATEGORY]);
    res.json({ unread: n.unread, total: n.total, top: n.top, visible: true });
  } catch (e) {
    res.json({ unread: 0, total: 0, visible: false });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// One document
// ═══════════════════════════════════════════════════════════════════════════
// GET /receipts must be registered BEFORE the /:id routes below. The numeric
// router.param guard 404s a non-numeric id rather than calling next(), so a
// /receipts declared after them would be swallowed by GET /:id and never run.

router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { doc, allowed, reason } = await loadReadable(req, db, Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!allowed) return res.status(reason || 403).json({ error: 'Forbidden' });

    const { rows: [receipt] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.paperwork_receipts WHERE document_id=$1`, [doc.id]);
    const { rows: history } = await db.query(
      `SELECT a.action, a.detail, a.created_at, s.first_name || ' ' || s.last_name AS staff_name
         FROM ${SCHEMA()}.paperwork_audit a
         LEFT JOIN ${SCHEMA()}.staff s ON s.id = a.staff_id
        WHERE a.document_id=$1 ORDER BY a.created_at DESC LIMIT 25`, [doc.id]);

    // The full extracted text is a separate call — a 200-page OCR has no place
    // in a list payload.
    const { extracted_text, ...rest } = doc;
    res.json({
      ...fixDates(rest),
      extract_chars: doc.extract_chars,
      receipt: fixDates(receipt) || null,
      history,
      can_write: doc.category ? await canWriteCategory(req, db, doc.category) : await canFileAtAll(req, db),
    });
  } catch (e) {
    console.error('[paperwork] get:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/text — the extracted text, for reading on a tablet without the scan.
router.get('/:id/text', async (req, res) => {
  try {
    const db = getPool();
    const { doc, allowed, reason } = await loadReadable(req, db, Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!allowed) return res.status(reason || 403).json({ error: 'Forbidden' });
    res.json({ id: doc.id, method: doc.extract_method, chars: doc.extract_chars,
      error: doc.extract_error, text: doc.extracted_text || '' });
  } catch (e) {
    console.error('[paperwork] text:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// b290 — POST /:id/read — this person has read it.
// PER PERSON, not per document: the Cockpit badge says "things YOU have not
// read", and a colleague opening a report must not clear it off your list. The
// primary key is (document_id, staff_id) so pressing it twice is a no-op and the
// FIRST read time is the one kept — when you read it, not when you last looked.
router.post('/:id/read', async (req, res) => {
  try {
    const db = getPool();
    const { doc, allowed, reason } = await loadReadable(req, db, Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!allowed) return res.status(reason || 403).json({ error: 'Forbidden' });
    const staffId = Number(req.user.id);
    if (!staffId) return res.status(400).json({ error: 'No staff id on this session' });
    const unread = String((req.body && req.body.unread) || '') === 'true' || (req.body && req.body.unread === true);
    if (unread) {
      await db.query(
        `DELETE FROM ${SCHEMA()}.paperwork_document_reads WHERE document_id=$1 AND staff_id=$2`,
        [doc.id, staffId]);
      return res.json({ id: doc.id, read: false });
    }
    await db.query(
      `INSERT INTO ${SCHEMA()}.paperwork_document_reads (document_id, staff_id)
       VALUES ($1,$2) ON CONFLICT (document_id, staff_id) DO NOTHING`, [doc.id, staffId]);
    res.json({ id: doc.id, read: true });
  } catch (e) {
    if (e.code === '42P01') return res.status(409).json({ error: 'Run migrations/2026-09-08-b290-deep-research.sql' });
    console.error('[paperwork] read:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/file — stream the original. Same scoping as everything else.
router.get('/:id/file', async (req, res) => {
  try {
    const db = getPool();
    const { doc, allowed, reason } = await loadReadable(req, db, Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!allowed) return res.status(reason || 403).json({ error: 'Forbidden' });
    if (!doc.stored_path || !fs.existsSync(doc.stored_path))
      return res.status(404).json({ error: 'File not on disk' });

    if (doc.mime) res.setHeader('Content-Type', doc.mime);
    const dl = String(req.query.download || '') === '1';
    res.setHeader('Content-Disposition',
      `${dl ? 'attachment' : 'inline'}; filename="${String(doc.filename || 'document').replace(/["\\]/g, '')}"`);
    fs.createReadStream(doc.stored_path).pipe(res);
  } catch (e) {
    console.error('[paperwork] file:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /:id — re-file. Same permission shape as accept: you need 'edit' on both
// the heading it is in and the heading it is going to.
router.patch('/:id', async (req, res) => {
  try {
    const db = getPool();
    const out = await acceptOne(req, db, Number(req.params.id), req.body || {});
    if (!out.ok) return res.status(out.error === 'Not found' ? 404 : 403).json({ error: out.error });

    if (req.body.published_to_parents !== undefined) {
      await db.query(
        `UPDATE ${SCHEMA()}.paperwork_documents SET published_to_parents=$2 WHERE id=$1`,
        [out.id, !!req.body.published_to_parents]);
    }
    res.json(out.document);
  } catch (e) {
    console.error('[paperwork] patch:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /:id — soft delete. The file stays on disk and the sha256 stays unique,
// so re-uploading the same scan surfaces this row rather than silently making a
// twin. Purging from disk is a data-governance job, not a button here.
router.delete('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [doc] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.paperwork_documents WHERE id=$1 AND deleted=false`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const ok = doc.category ? await canWriteCategory(req, db, doc.category) : await canFileAtAll(req, db);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });

    await db.query(
      `UPDATE ${SCHEMA()}.paperwork_documents SET deleted=true, deleted_at=now(), deleted_by=$2 WHERE id=$1`,
      [doc.id, req.user.id]);
    await audit(db, doc.id, 'deleted', req.user.id, { category: doc.category, title: doc.title });
    res.json({ ok: true });
  } catch (e) {
    console.error('[paperwork] delete:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/reprocess — run it through the pipeline again (the Ascent was down,
// or somebody has since installed a better language pack).
router.post('/:id/reprocess', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [doc] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.paperwork_documents WHERE id=$1 AND deleted=false`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!await canFileAtAll(req, db)) return res.status(403).json({ error: 'Forbidden' });

    const stage = String(req.body && req.body.stage) === 'ai' ? 'ai' : 'extract';
    await db.query(
      `INSERT INTO ${SCHEMA()}.paperwork_jobs (document_id, stage) VALUES ($1,$2)`, [doc.id, stage]);
    if (doc.status !== 'filed') {
      await db.query(`UPDATE ${SCHEMA()}.paperwork_documents SET status='queued' WHERE id=$1`, [doc.id]);
    }
    res.status(202).json({ ok: true, stage });
  } catch (e) {
    console.error('[paperwork] reprocess:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Receipts
// ═══════════════════════════════════════════════════════════════════════════

// PUT /:id/receipt — confirm or correct what the model read off the receipt.
// The raw text is untouched, so a corrected total can still be checked against
// the original scan.
router.put('/:id/receipt', async (req, res) => {
  try {
    const db = getPool();
    const id = Number(req.params.id);
    const { rows: [doc] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.paperwork_documents WHERE id=$1 AND deleted=false`, [id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!await canWriteCategory(req, db, doc.category || 'finance'))
      return res.status(403).json({ error: 'Forbidden' });

    const b = req.body || {};
    const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
    const { rows: [rec] } = await db.query(
      `INSERT INTO ${SCHEMA()}.paperwork_receipts
         (document_id, supplier, receipt_date, total_amount, vat_amount, currency,
          confirmed, confirmed_by, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'GBP'),true,$7,now())
       ON CONFLICT (document_id) DO UPDATE
         SET supplier=EXCLUDED.supplier, receipt_date=EXCLUDED.receipt_date,
             total_amount=EXCLUDED.total_amount, vat_amount=EXCLUDED.vat_amount,
             currency=EXCLUDED.currency, confirmed=true, confirmed_by=EXCLUDED.confirmed_by,
             confirmed_at=now(), updated_at=now()
       RETURNING *`,
      [id, b.supplier ? String(b.supplier).slice(0, 200) : null,
       /^\d{4}-\d{2}-\d{2}$/.test(String(b.receipt_date || '')) ? b.receipt_date : null,
       num(b.total_amount), num(b.vat_amount),
       b.currency ? String(b.currency).toUpperCase().slice(0, 3) : null, req.user.id]);

    await audit(db, id, 'receipt-confirmed', req.user.id,
      { supplier: rec.supplier, total: rec.total_amount, vat: rec.vat_amount });
    res.json(fixDates(rec));
  } catch (e) {
    console.error('[paperwork] receipt:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/receipt/attach — hang the receipt off a finance record.
// Deliberately just records the pointer: it does not write into invoices/payments.
// Nothing in b269 asks this build to move money.
router.post('/:id/receipt/attach', async (req, res) => {
  try {
    const db = getPool();
    const id = Number(req.params.id);
    const table = String((req.body && req.body.attached_table) || '').trim();
    const rowId = Number((req.body && req.body.attached_id) || 0);
    const ALLOWED = new Set(['invoices', 'payments', 'finance_transactions', 'payroll_runs', 'funding_submissions']);
    if (!ALLOWED.has(table) || !rowId) return res.status(400).json({ error: 'attached_table / attached_id required' });

    const { rows: [doc] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.paperwork_documents WHERE id=$1 AND deleted=false`, [id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!await canWriteCategory(req, db, doc.category || 'finance'))
      return res.status(403).json({ error: 'Forbidden' });

    const { rows: [rec] } = await db.query(
      `INSERT INTO ${SCHEMA()}.paperwork_receipts (document_id, attached_table, attached_id, attached_by, attached_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (document_id) DO UPDATE
         SET attached_table=EXCLUDED.attached_table, attached_id=EXCLUDED.attached_id,
             attached_by=EXCLUDED.attached_by, attached_at=now(), updated_at=now()
       RETURNING *`, [id, table, rowId, req.user.id]);
    await audit(db, id, 'receipt-attached', req.user.id, { table, row_id: rowId });
    res.json(fixDates(rec));
  } catch (e) {
    console.error('[paperwork] attach:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
