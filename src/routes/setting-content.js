'use strict';
// b257 — SETTING CONTENT: this setting's own curriculum material, served from a
// read-only mount instead of from the image.
//
// Why this exists at all. The 302 resource cards in src/content/resource-cards/
// are Wren's shipped library: they are baked into every edition image and every
// new tenant inherits them. That is right for Wren's own content and wrong for
// two other kinds of thing:
//
//   1. Third-party material a particular setting is licensed to use. The
//      Aquafresh "Shine Bright" toothbrushing pack is Haleon copyright, supplied
//      free to schools. LADN may use it; Wren may not ship it to a customer.
//   2. Anything large. That pack is 1.6 GB of video. Putting it near
//      src/content/ would add it to five ~770 MB images.
//
// So: a store outside the repo, mounted read-only per container, with its own
// loader. Nothing here is in git, nothing is baked, nothing is inherited.
//
// Store layout (WREN_SETTING_CONTENT, default /app/setting-content):
//   resource-cards/<slug>.json   cards merged into the library by resource-cards.js
//   programmes/<slug>.json       a teaching programme (front door + lesson index)
//   media/**                     the actual files, served by GET /file below
//
// Routes (all staff-authenticated):
//   GET /api/setting-content/programmes          index
//   GET /api/setting-content/programmes/:slug    programme + its lessons resolved
//   GET /api/setting-content/lessons/:slug       one lesson, slide by slide
//   GET /api/setting-content/file?path=...       one file, with byte-range support
//
// The file route MUST honour Range: a 538 MB MP4 has to seek, not arrive whole.
// res.sendFile does that through `send` (acceptRanges is on by default), which
// is why this streams through sendFile rather than a hand-rolled pipe.
const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const authenticate = require('../middleware/auth');

// Resolved once. realpathSync so the containment check below compares like with
// like even when the mount sits behind a symlink.
const ROOT = (() => {
  const raw = process.env.WREN_SETTING_CONTENT || '/app/setting-content';
  try { return fs.realpathSync(raw); } catch { return path.resolve(raw); }
})();

const SLUG_RE = /^[a-z0-9-]+$/;
const CACHE_TTL_MS = 60 * 1000;

const MIME = {
  '.pdf':  'application/pdf',
  '.mp4':  'video/mp4',
  '.m4v':  'video/mp4',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
// Deny by default: only these can be fetched, whatever is on disk.
const SERVABLE = new Set(Object.keys(MIME));

// Resolve a store-relative path and refuse anything that escapes the store.
// Returns null rather than throwing so callers answer 400, not 500.
function resolveInStore(rel) {
  if (typeof rel !== 'string' || !rel) return null;
  if (rel.includes('\0') || rel.includes('\\')) return null;
  const clean = rel.replace(/^\/+/, '');
  if (clean.split('/').some(seg => seg === '..')) return null;
  const abs = path.resolve(ROOT, clean);
  // path.resolve alone is not enough — 'foo-evil' starts with 'foo'.
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

function readJson(abs) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return null; }
}

// ── Programme index ──────────────────────────────────────────────────────────
let _progCache = { at: 0, list: null };
function loadProgrammes() {
  const now = Date.now();
  if (_progCache.list && (now - _progCache.at) < CACHE_TTL_MS) return _progCache.list;
  const dir = path.join(ROOT, 'programmes');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { files = []; }
  const list = [];
  for (const f of files) {
    const p = readJson(path.join(dir, f));
    if (!p || typeof p !== 'object') continue;
    if (!p.slug) p.slug = f.replace(/\.json$/, '');
    list.push(p);
  }
  _progCache = { at: now, list };
  return list;
}

// ── Media tickets ────────────────────────────────────────────────────────────
// A native <video src> or <img src> cannot send an Authorization header, and
// blob-fetching a 538 MB file would throw away the byte-range streaming this
// route exists to provide. So the page asks for a ticket and puts that in the
// URL instead.
//
// The ticket is NOT the session token. It is a separate 30-minute JWT that
// carries scope:'setting-media' and nothing else, so a URL that leaks into an
// nginx access log or a referrer grants read access to this content store for
// half an hour — not a staff session. /file accepts either form; every other
// route here requires the real header.
const jwt = require('jsonwebtoken');
const TICKET_TTL_S = 30 * 60;

router.get('/media-ticket', authenticate, (req, res) => {
  try {
    const token = jwt.sign(
      { scope: 'setting-media', sub: String(req.user && req.user.id || '') },
      process.env.JWT_SECRET, { expiresIn: TICKET_TTL_S });
    res.json({ ticket: token, expires_in: TICKET_TTL_S });
  } catch (e) { res.status(500).json({ error: 'Could not issue ticket' }); }
});

function ticketOrAuth(req, res, next) {
  const t = req.query.t;
  if (t && !req.headers['authorization'] && !req.headers['x-wren-token']) {
    try {
      const dec = jwt.verify(String(t), process.env.JWT_SECRET);
      if (dec && dec.scope === 'setting-media') {
        req.user = { id: dec.sub, via: 'setting-media-ticket' };
        return next();
      }
    } catch { /* fall through to the normal check, which will 401 */ }
    return res.status(401).json({ error: 'Invalid or expired media ticket' });
  }
  return authenticate(req, res, next);
}

router.use((req, res, next) => {
  // /file has its own auth (ticket or header); everything else is header-only.
  if (req.path === '/file' || req.path === '/media-ticket') return next();
  return authenticate(req, res, next);
});

// GET /programmes — light index for a listing page.
router.get('/programmes', (req, res) => {
  try {
    res.json(loadProgrammes().map(p => ({
      slug: p.slug,
      title: p.title || p.slug,
      subtitle: p.subtitle || '',
      age_range: p.age_range || null,
      subjects: Array.isArray(p.subjects) ? p.subjects : [],
      attribution: p.attribution || null,
      lesson_count: Array.isArray(p.lessons) ? p.lessons.length : 0,
      front_door: p.front_door || null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /programmes/:slug — the programme with each lesson's headline data folded
// in, so the front-door page is one request rather than one-plus-N.
router.get('/programmes/:slug', (req, res) => {
  try {
    const slug = String(req.params.slug || '');
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
    const prog = loadProgrammes().find(p => p.slug === slug);
    if (!prog) return res.status(404).json({ error: 'Not found' });

    const lessons = (Array.isArray(prog.lessons) ? prog.lessons : []).map(l => {
      const abs = l.lesson_file ? resolveInStore(l.lesson_file) : null;
      const doc = abs ? readJson(abs) : null;
      if (!doc) return Object.assign({}, l, { available: false });
      return {
        n: doc.lesson_number || l.n,
        slug: doc.slug || l.slug,
        title: doc.title || l.title,
        subtitle: doc.subtitle || '',
        available: true,
        slide_count: Array.isArray(doc.slides) ? doc.slides.length : 0,
        notes_count: Array.isArray(doc.slides) ? doc.slides.filter(s => s.notes).length : 0,
        deck: doc.deck || null,
        videos_staff: doc.videos_staff || [],
        videos_class: doc.videos_class || [],
        media_base: path.posix.dirname(l.lesson_file || ''),
      };
    });
    res.json(Object.assign({}, prog, { lessons }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /lessons/:slug — the full lesson: every slide, its text, its speaker notes
// and the images that slide carries. This is what makes the plan readable in Wren
// without PowerPoint.
router.get('/lessons/:slug', (req, res) => {
  try {
    const slug = String(req.params.slug || '');
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
    // Find it through the programmes rather than guessing a path, so a lesson is
    // only reachable if a programme actually declares it.
    for (const prog of loadProgrammes()) {
      for (const l of (prog.lessons || [])) {
        if (l.slug !== slug) continue;
        const abs = resolveInStore(l.lesson_file || '');
        const doc = abs ? readJson(abs) : null;
        if (!doc) return res.status(404).json({ error: 'Lesson content not available' });
        doc.programme_slug   = prog.slug;
        doc.programme_title  = prog.title || prog.slug;
        doc.rewards          = prog.rewards || [];
        doc.media_base       = path.posix.dirname(l.lesson_file || '');
        doc.slides_base      = path.posix.join(path.posix.dirname(path.posix.dirname(l.lesson_file || '')),
                                               'slides', 'lesson-' + (doc.lesson_number || ''));
        return res.json(doc);
      }
    }
    res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /file?path=media/... — stream one file out of the store.
//
// Range matters here. Without it the browser gets one 538 MB response it cannot
// seek inside; with it, dragging the scrubber issues `Range: bytes=N-` and gets a
// 206 with just that slice. sendFile does the whole dance — 206, Content-Range,
// Accept-Ranges, and 416 on an unsatisfiable range — so do not replace it with a
// createReadStream().pipe() without reimplementing all of that.
router.get('/file', ticketOrAuth, (req, res) => {
  const rel = String(req.query.path || '');
  const abs = resolveInStore(rel);
  if (!abs) return res.status(400).json({ error: 'Invalid path' });
  const ext = path.extname(abs).toLowerCase();
  if (!SERVABLE.has(ext)) return res.status(415).json({ error: 'Unsupported file type' });

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return res.status(404).json({ error: 'Not found' });
    const name = path.basename(abs);
    res.setHeader('Content-Type', MIME[ext]);
    res.setHeader('Accept-Ranges', 'bytes');
    // Third-party licensed material — never let a shared cache hold it.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    // A ticket can ride in the query string, so make sure the URL never leaves
    // via a referrer header.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // ?download=1 for the .pptx a teacher wants on disk; inline for everything
    // the page renders or plays itself.
    const disp = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', disp + '; filename="' + name.replace(/["\\]/g, '') + '"');
    res.sendFile(abs, { acceptRanges: true, dotfiles: 'deny' }, (e) => {
      if (e && !res.headersSent) res.status(e.status || 500).end();
    });
  });
});

// Exposed for the parents-portal route in src/routes/parents.js, which serves the
// family-facing half of this store under its own parent auth. Same store, same
// containment check, one implementation.
router._resolveInStore = resolveInStore;
router._ROOT = ROOT;
router._MIME = MIME;
router._SERVABLE = SERVABLE;
router._loadProgrammes = loadProgrammes;

module.exports = router;
