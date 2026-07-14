'use strict';
// Website Builder (2026-07-12) — Wix-style GrapesJS editor for the PUBLIC nursery
// marketing site (littleangelsealing.co.uk, served by the `nursery-website` nginx
// container from host dir /opt/site-manager/data/sites/www, bind-mounted into this
// container at /app/website-live).
//
// Safety posture for publish:
//   * staged write: always write to a hidden staging file first,
//   * verify the staging file serves HTTP 200 through the real nursery-website
//     container before it can go live,
//   * timestamped .bak of any file being replaced,
//   * atomic rename into place,
//   * NEVER deletes an existing site file; overwriting an existing file requires
//     an explicit overwrite:true confirm from the UI.
//
// Manager/deputy-only (same gate as competitor-intel).

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const LIVE_DIR = process.env.WEBSITE_LIVE_DIR || '/app/website-live';
const MEDIA_SUBDIR = 'assets/wren-media';
// Public origin of the live site — used for media URLs (absolute so images work
// both inside the GrapesJS editor iframe on the admin portal AND on the published
// public page) and for verifying staged publishes through the real nginx container.
const SITE_ORIGIN = process.env.WEBSITE_PUBLIC_ORIGIN || 'https://littleangelsealing.co.uk';
const CHECK_ORIGIN = process.env.WEBSITE_CHECK_ORIGIN || 'http://100.126.215.7:8086';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://100.109.248.102:11434';
const AI_MODEL = process.env.WEBSITE_AI_MODEL || 'gpt-oss:120b';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

router.use(authenticate);
router.use((req, res, next) => {
  if (!['manager', 'deputy_manager'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});

function liveDirReady() {
  try { return fs.statSync(LIVE_DIR).isDirectory(); } catch { return false; }
}
function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ── Pages CRUD ────────────────────────────────────────────────────────────────

// GET / — list pages (no heavy fields)
router.get('/', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT p.id, p.slug, p.title, p.status, p.created_at, p.updated_at, p.published_at,
              s.first_name || ' ' || s.last_name AS updated_by_name
       FROM website_pages p LEFT JOIN staff s ON s.id = p.updated_by
       ORDER BY p.updated_at DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /live-files — what actually exists in the live site dir (read-only info)
router.get('/live-files', async (req, res) => {
  if (!liveDirReady()) return res.status(503).json({ error: 'live_dir_not_mounted', dir: LIVE_DIR });
  try {
    const files = fs.readdirSync(LIVE_DIR)
      .filter(f => f.endsWith('.html') && !f.startsWith('.'))
      .map(f => ({ file: f, size: fs.statSync(path.join(LIVE_DIR, f)).size }));
    res.json({ dir: LIVE_DIR, files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id — full page incl. editor state
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT * FROM website_pages WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — create a page {slug, title}
router.post('/', async (req, res) => {
  const slug = String(req.body.slug || '').trim().toLowerCase();
  const title = String(req.body.title || '').trim();
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: 'Slug must be lowercase letters/numbers/hyphens (max 61 chars)' });
  }
  try {
    const { rows } = await getPool().query(
      `INSERT INTO website_pages (slug, title, updated_by) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO NOTHING RETURNING *`,
      [slug, title || slug, req.user.id || null]);
    if (!rows.length) return res.status(409).json({ error: 'A page with that slug already exists' });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id — save editor state {grapes_json, published_html, title?}
router.put('/:id', async (req, res) => {
  const { grapes_json, published_html, title } = req.body || {};
  try {
    const { rows } = await getPool().query(
      `UPDATE website_pages SET
         grapes_json    = COALESCE($2, grapes_json),
         published_html = COALESCE($3, published_html),
         title          = COALESCE($4, title),
         updated_by     = $5,
         updated_at     = NOW()
       WHERE id=$1 RETURNING id, slug, title, status, updated_at`,
      [req.params.id,
       grapes_json ? JSON.stringify(grapes_json) : null,
       published_html || null,
       title || null,
       req.user.id || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id — remove the DB record only. NEVER touches files on the live site.
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await getPool().query('DELETE FROM website_pages WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true, note: 'DB record removed; any published file on the live site is left in place.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/preview — rendered HTML for the editor's preview iframe
router.get('/:id/preview', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT published_html FROM website_pages WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(rows[0].published_html || '<p style="font-family:sans-serif">Nothing saved yet.</p>');
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Media upload ──────────────────────────────────────────────────────────────
// Files land directly in the live site's assets dir (they are public marketing
// media). URLs are absolute to the public site so they resolve in the editor too.
const _mediaUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      if (!liveDirReady()) return cb(new Error('live_dir_not_mounted'));
      const dir = path.join(LIVE_DIR, MEDIA_SUBDIR);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const base = path.basename(file.originalname).toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'file';
      cb(null, Date.now() + '-' + base);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) { cb(null, /^image\/(jpeg|png|webp|gif|svg\+xml)$/.test(file.mimetype)); },
});

router.post('/media', (req, res) => {
  _mediaUpload.array('files', 10)(req, res, async (err) => {
    if (err) return res.status(err.message === 'live_dir_not_mounted' ? 503 : 400).json({ error: err.message });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No image files uploaded (jpeg/png/webp/gif/svg, max 15MB)' });
    const out = [];
    try {
      for (const f of files) {
        try { fs.chownSync(f.path, 1000, 1000); fs.chownSync(path.dirname(f.path), 1000, 1000); } catch { /* non-root */ }
        const urlPath = '/' + MEDIA_SUBDIR + '/' + f.filename;
        const { rows } = await getPool().query(
          `INSERT INTO website_media (filename, path, mime, size, uploaded_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [f.filename, urlPath, f.mimetype, f.size, req.user.id || null]);
        out.push({ id: rows[0].id, src: SITE_ORIGIN + urlPath, name: f.filename, size: f.size });
      }
      // GrapesJS AssetManager expects { data: [...] }
      res.json({ data: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// GET /media — list uploaded media for the asset manager
router.get('/media/list', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT id, filename, path, mime, size, created_at FROM website_media ORDER BY created_at DESC LIMIT 500');
    res.json({ data: rows.map(r => ({ ...r, src: SITE_ORIGIN + r.path, name: r.filename })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Publish ───────────────────────────────────────────────────────────────────
// POST /:id/publish  body: { overwrite: true }  (overwrite only needed when the
// target file already exists on the live site — e.g. republishing).
router.post('/:id/publish', async (req, res) => {
  if (!liveDirReady()) return res.status(503).json({ error: 'live_dir_not_mounted', dir: LIVE_DIR });
  let page;
  try {
    const { rows } = await getPool().query('SELECT * FROM website_pages WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    page = rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }

  if (!SLUG_RE.test(page.slug)) return res.status(400).json({ error: 'Invalid slug on record' });
  if (!page.published_html || page.published_html.length < 50) {
    return res.status(400).json({ error: 'Nothing to publish — save the page first' });
  }

  const targetName = page.slug + '.html';
  const targetPath = path.join(LIVE_DIR, targetName);
  const exists = fs.existsSync(targetPath);
  if (exists && req.body.overwrite !== true) {
    return res.status(409).json({ error: 'target_exists', file: targetName,
      message: `${targetName} already exists on the live site — confirm overwrite (a timestamped backup will be kept).` });
  }

  const stagingName = '.wren-staging-' + page.slug + '-' + Date.now() + '.html';
  const stagingPath = path.join(LIVE_DIR, stagingName);
  const cleanup = () => { try { fs.unlinkSync(stagingPath); } catch { /* already gone */ } };

  try {
    // 1. staged write
    fs.writeFileSync(stagingPath, page.published_html, 'utf8');
    try { fs.chownSync(stagingPath, 1000, 1000); } catch { /* non-root or same owner */ }

    // 2. verify the staging file serves 200 through the real nursery-website nginx
    let verified = false;
    try {
      const r = await fetch(CHECK_ORIGIN + '/' + stagingName, { signal: AbortSignal.timeout(8000) });
      const body = await r.text();
      verified = r.status === 200 && body.length === Buffer.byteLength(page.published_html, 'utf8');
    } catch { verified = false; }
    if (!verified) {
      cleanup();
      return res.status(502).json({ error: 'verify_failed',
        message: 'Staged file did not serve 200 through the nursery-website container — nothing was changed on the live site.' });
    }

    // 3. timestamped backup of anything being replaced (never delete)
    let backup = null;
    if (exists) {
      backup = targetName + '.bak-wrenbuilder-' + tsStamp();
      fs.copyFileSync(targetPath, path.join(LIVE_DIR, backup));
    }

    // 4. atomic move into place (same filesystem)
    fs.renameSync(stagingPath, targetPath);

    await getPool().query(
      `UPDATE website_pages SET status='published', published_at=NOW(), updated_at=NOW(), updated_by=$2 WHERE id=$1`,
      [page.id, req.user.id || null]);

    res.json({ published: true, url: SITE_ORIGIN + '/' + targetName, file: targetName, backup });
  } catch (e) {
    cleanup();
    res.status(500).json({ error: e.message });
  }
});

// ── AI section assist ─────────────────────────────────────────────────────────
// POST /ai-section {prompt} → one self-contained HTML section (inline styles) to
// drop into the canvas. Local Ollama on Ascent; graceful 503 when it's down.
router.post('/ai-section', async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const sys = 'You write HTML sections for the public website of Little Angels Day Nursery, ' +
    'a warm, friendly children\'s day nursery in Ealing, West London. Return ONE self-contained ' +
    '<section> element with INLINE styles only (no <html>, <head>, <script>, external CSS or JS). ' +
    'Soft rounded corners, gentle colours (creams, soft greens/blues), generous padding, mobile-friendly ' +
    '(max-width + margin auto, flexible layout). Return ONLY the raw HTML, no markdown fences, no commentary.';
  try {
    const r = await fetch(OLLAMA_HOST + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AI_MODEL, system: sys, prompt,
        stream: false, think: false,           // reasoning models return empty without think:false
        options: { temperature: 0.7, num_predict: 2500 },
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) return res.status(503).json({ error: 'AI unavailable (Ollama returned ' + r.status + ')' });
    const j = await r.json();
    let html = (j.response || '').trim()
      .replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();
    if (!html || !/</.test(html)) return res.status(502).json({ error: 'AI returned no usable HTML' });
    // Strip any scripts the model sneaked in
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    res.json({ html });
  } catch (e) {
    res.status(503).json({ error: 'AI unavailable: ' + (e.name === 'TimeoutError' ? 'timed out' : e.message) });
  }
});

module.exports = router;
