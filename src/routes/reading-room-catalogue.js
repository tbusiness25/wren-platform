'use strict';
// b425 — The Reading Room. Mounted at /api/library (see src/lib/reading-room-catalogue.js
// for why the path says "library" rather than "reading-room" — that string is already
// taken by b352's unrelated manager decision-log).
//
// Audience is FORCED from the caller's portal/role, never trusted from the query string:
// a parent token can only ever get audience='parents', EY/HR staff get 'staff', Roost
// managers get 'admin' (everything, including the needs-review queue). This mirrors the
// same rule person-documents.js and staff-reading.js already enforce.
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const { requireParentIdentity } = require('../lib/parent-identity');
const catalogue = require('../lib/reading-room-catalogue');
const { recordAudit } = require('../utils/audit');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const STORE_BASE = process.env.READING_DOC_BASE || path.join(__dirname, '../../data/reading-documents');

// The parents portal front-end sends no bearer token — it authenticates purely
// with the wren_parent cookie (see reference_parents_portal_sends_no_bearer_token /
// src/lib/parent-identity.js). The generic `authenticate` below only ever reads an
// Authorization/X-Wren-Token header, so a plain `router.use(authenticate)` here
// would 401 every real parent request. Branch on portal instead; nothing past
// this point reads req.user for a parents-portal request (audienceFor() returns
// 'parents' straight from req._portal, and every Roost-only route is already
// blocked on portal before role is even checked).
router.use((req, res, next) => {
  if (req._portal === 'parents') return requireParentIdentity(req, res, next);
  return authenticate(req, res, next);
});

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
const managerOnly = requireRole('manager', 'deputy_manager', 'admin');
function isManager(req) { return MANAGER_ROLES.includes(req.user && req.user.role); }

// Needs review / upload / meta / publish are Roost-only surfaces (per the spec: "an
// admin 'Needs review' tab and upload" on Roost specifically). requireRole() alone
// checks ROLE, not PORTAL — a manager's token is still 'manager' when it's being used
// on the EY or HR hostname, so without this a manager on a shared EY room tablet could
// hit these same endpoints directly (not through any UI — the EY/HR pages never render
// these controls — but the API would still accept them). This closes that gap.
const roostManagerOnly = [...managerOnly, (req, res, next) => {
  if (req._portal !== 'admin') return res.status(403).json({ error: 'Roost only' });
  next();
}];

// Roost = admin audience (everything). Parents portal = 'parents'. Everything else
// (EY 'learning', HR 'hr') = 'staff'. A manager browsing from EY/HR still only gets
// the staff view here — "Needs review" and upload are Roost-only surfaces, same as
// every other manager-only tool that nonetheless lives behind a staff-portal login.
function audienceFor(req) {
  const p = req._portal || 'learning';
  if (p === 'admin') return isManager(req) ? 'admin' : 'staff';
  if (p === 'parents') return 'parents';
  return 'staff';
}

// ── Upload store ─────────────────────────────────────────────────────────────
// Same allowlist person-documents.js (b321) uses. There is no per-file virus scan
// here or there — no ClamAV client exists inside the Wren containers. The real
// defence is the extension/mime allowlist below plus the host's nightly ClamAV
// sweep (Sentinel) over the mounted data volumes. Documented plainly rather than
// claiming a scan step that doesn't exist.
const MAX_BYTES = 30 * 1024 * 1024;
const ALLOWED_EXT = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(STORE_BASE, 'tmp');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      cb(null, dir);
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.bin';
      cb(null, `rd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: MAX_BYTES },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT[ext]) return cb(null, true);
    cb(new Error(`Unsupported file type "${ext}". Accepted: ${Object.keys(ALLOWED_EXT).join(', ')}`));
  },
});

// ── GET / — the catalogue, audience-scoped ────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const audience = audienceFor(req);
    const { area, type, q, sort, from, to } = req.query;
    const items = await catalogue.listItems({ audience, portal: req._portal, area: area || null, type: type || null, q: q || null, sort: sort || 'newest', from: from || null, to: to || null });
    res.json({ audience, items });
  } catch (e) {
    console.error('[library] GET /', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/areas', async (req, res) => {
  try {
    const audience = audienceFor(req);
    res.json(await catalogue.areaCounts(audience));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manager-only: everything currently sitting unreviewed/unpublished.
// b426: ?area= / ?folder= narrow the queue — folder only ever matches a
// Drive-imported reading_document (every other source has no folder).
router.get('/needs-review', roostManagerOnly, async (req, res) => {
  try {
    res.json(await catalogue.needsReviewQueue({ area: req.query.area || null, folder: req.query.folder || null }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// b482 — these three MUST be registered before the generic '/:source/:id'
// below: Express matches top-to-bottom and 'books' as a literal :source value
// would otherwise hit that catch-all first (SOURCE_ADAPTERS has no 'books'
// key, so it would 400 before ever reaching these).
router.get('/books', async (req, res) => {
  try {
    const audience = audienceFor(req);
    const { area, persona, source, sort, q, date } = req.query;
    const unread = req.query.unread === '1' || req.query.unread === 'true';
    // b519 — ?archived=1 shows the archived shelf instead of the live one. Anything else
    // (including nothing at all) is the default view, which hides archived items.
    const archived = (req.query.archived === '1' || req.query.archived === 'true') ? 'only' : null;
    const data = await catalogue.booksFor({
      audience, portal: req._portal,
      area: area || null, persona: persona || null, source: source || null, unread,
      sort: sort || 'newest', q: q || null, date: date || null, viewer: viewerFor(req),
      archived,
    });
    res.json({ audience, ...data });
  } catch (e) {
    console.error('[library] GET /books', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/books/:key', async (req, res) => {
  try {
    const audience = audienceFor(req);
    const archived = (req.query.archived === '1' || req.query.archived === 'true') ? 'only' : null;
    const book = await catalogue.bookDetail(req.params.key, { audience, portal: req._portal, viewer: viewerFor(req), archived });
    if (!book) return res.status(404).json({ error: 'Not found' });
    if (audience !== 'admin') {
      // Same audience/needs-review cut listItems() already applies per item —
      // a book a non-admin can reach by key but has no visible chapters in is
      // effectively not theirs to see.
      book.chapters = book.chapters.filter(c => !c.needs_review && (c.audiences || []).includes(audience));
      if (!book.chapters.length) return res.status(404).json({ error: 'Not found' });
      book.chapter_count = book.chapters.length;
    }
    res.json(book);
  } catch (e) {
    console.error('[library] GET /books/:key', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/books/:key/chapter/:source/:id', async (req, res) => {
  try {
    if (!catalogue.SOURCE_ADAPTERS[req.params.source]) return res.status(400).json({ error: 'Unknown source' });
    const audience = audienceFor(req);
    const item = await catalogue.findItem(req.params.source, req.params.id, req._portal);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (audience !== 'admin' && (item.needs_review || !item.audiences.includes(audience))) {
      return res.status(404).json({ error: 'Not found' });
    }
    const body = await catalogue.chapterBody(req.params.source, req.params.id);
    // b519 — provenance / extent / "what it means for us" travel with the chapter, so a
    // client that opens a chapter directly (not via the book) still knows where the thing
    // came from and whether it is the whole thing. `path` is admin-only, same rule as
    // listItems() applies (b425b fix #7).
    const provenance = item.provenance
      ? (audience === 'admin' ? item.provenance : { ...item.provenance, path: null })
      : null;
    res.json({
      item: {
        title: item.title, summary: item.summary, href: item.href, type: item.type,
        updated_at: item.updated_at, provenance, extent: item.extent || null,
        so_what: item.so_what || null, archived_at: item.archived_at || null,
      },
      body,
    });
  } catch (e) {
    console.error('[library] GET /books/:key/chapter', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── b519: archive, delete, restore ───────────────────────────────────────────
// Registered BEFORE the generic '/:source/:id' below for the same reason the three /books
// routes are (Express matches top to bottom; 'deletions' is not a source key, and would
// 400 on the catch-all first). All four are Roost-manager-only: archiving or deleting is a
// decision about the whole setting's reading room, not a personal bookmark.

/** The archived shelf as a flat list — what the Archived view counts, without the grouping. */
router.get('/archived', roostManagerOnly, async (req, res) => {
  try {
    const items = await catalogue.listItems({ audience: 'admin', portal: req._portal, archived: 'only' });
    res.json({ count: items.length, items });
  } catch (e) {
    console.error('[library] GET /archived', e.message);
    res.status(500).json({ error: e.message });
  }
});

/** Everything deleted from the reading room, newest first, with any file request's outcome. */
router.get('/deletions', roostManagerOnly, async (req, res) => {
  try {
    const includeRestored = req.query.all === '1';
    res.json(await catalogue.listDeletions({ includeRestored }));
  } catch (e) {
    console.error('[library] GET /deletions', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/deletions/:id/restore', roostManagerOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Not found' });
    const row = await catalogue.restoreDeletion(id, req.user);
    if (!row) return res.status(404).json({ error: 'Not found, or already restored' });
    await recordAudit({
      req, action: 'update', entity_type: 'reading_room_item', entity_id: `${row.source}:${row.source_id}`,
      meta: { b519: 'restored to the reading room', title: row.title, fingerprint: row.fingerprint },
    });
    // Restoring the ITEM never un-deletes a FILE — if the file was moved to _deleted/ it is
    // still there, and saying so beats implying it came back.
    res.json({ ...row, note: row.file_requested ? 'The item is back in the reading room. If the file was moved to wren-docs/_deleted/, it is still there.' : null });
  } catch (e) {
    console.error('[library] POST /deletions/:id/restore', e.message);
    res.status(500).json({ error: e.message });
  }
});

/** "Archive all read" — bulk, and it reports the number it actually archived. */
router.post('/archive-read', roostManagerOnly, async (req, res) => {
  try {
    const out = await catalogue.archiveAllRead({
      audience: 'admin', portal: req._portal, viewer: viewerFor(req), actor: req.user,
    });
    res.json(out);
  } catch (e) {
    console.error('[library] POST /archive-read', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/:source/:id/archive', roostManagerOnly, async (req, res) => {
  try {
    if (!catalogue.SOURCE_ADAPTERS[req.params.source]) return res.status(400).json({ error: 'Unknown source' });
    const body = req.body || {};
    if (typeof body.archived !== 'boolean') return res.status(400).json({ error: 'archived must be true or false' });
    // Must be a real catalogued item — but look among the archived ones too, or un-archiving
    // would 404 on exactly the items you can un-archive.
    const all = await catalogue.listItems({ audience: 'admin', portal: req._portal, archived: 'all' });
    const item = all.find(i => i.source === req.params.source && String(i.source_id) === String(req.params.id));
    if (!item) return res.status(404).json({ error: 'Not found' });
    const out = await catalogue.setArchived(req.params.source, req.params.id, body.archived, req.user);
    res.json({ ...out, title: item.title });
  } catch (e) {
    console.error('[library] POST archive', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Delete an item from the reading room. Two separate decisions, deliberately:
 *   { confirm: true }                      — the catalogue row only (reversible from Deleted)
 *   { confirm: true, also_delete_file: true } — plus a request to move the wren-docs file
 * The second is refused unless the item really is backed by a wren-docs file that is not in
 * a protected folder, and even then nothing is unlinked: the host script moves it to
 * wren-docs/_deleted/<date>/ and wren-docs is inside the /app git repo, so there are
 * two ways back.
 */
router.post('/:source/:id/delete', roostManagerOnly, async (req, res) => {
  try {
    if (!catalogue.SOURCE_ADAPTERS[req.params.source]) return res.status(400).json({ error: 'Unknown source' });
    const body = req.body || {};
    if (body.confirm !== true) return res.status(400).json({ error: 'confirm must be true' });
    const all = await catalogue.listItems({ audience: 'admin', portal: req._portal, archived: 'all' });
    const item = all.find(i => i.source === req.params.source && String(i.source_id) === String(req.params.id));
    if (!item) return res.status(404).json({ error: 'Not found' });

    let fileRequest = null, fileRefused = null;
    if (body.also_delete_file === true) {
      const relPath = item.provenance && item.provenance.path;
      const check = catalogue.fileDeletable(relPath);
      if (!check.ok) {
        // Refuse the FILE, not the whole call — and say so in the answer, rather than
        // deleting the item and quietly ignoring half of what was asked for.
        fileRefused = check.reason;
      } else {
        fileRequest = await catalogue.requestFileDeletion(check.rel, item, req.user);
      }
    }
    const row = await catalogue.deleteItem(item, req.user, { fileRequested: !!fileRequest });
    await recordAudit({
      req, action: 'delete', entity_type: 'reading_room_item', entity_id: `${item.source}:${item.source_id}`,
      meta: {
        b519: 'deleted from the reading room', title: item.title, fingerprint: row.fingerprint,
        also_delete_file: body.also_delete_file === true,
        file_rel_path: fileRequest ? fileRequest.rel_path : null,
        file_refused: fileRefused,
      },
    });
    res.json({
      deleted: true, deletion_id: row.id, source: item.source, source_id: String(item.source_id),
      title: item.title, fingerprint: row.fingerprint,
      file: fileRequest
        ? { queued: true, rel_path: fileRequest.rel_path, note: 'The file is moved to wren-docs/_deleted/ by the next run of scripts/b519-apply-file-deletions.js on the host — wren-docs is not mounted into Wren, so nothing in here can move it.' }
        : (fileRefused ? { queued: false, refused: fileRefused } : null),
    });
  } catch (e) {
    console.error('[library] POST delete', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:source/:id', async (req, res) => {
  try {
    if (!catalogue.SOURCE_ADAPTERS[req.params.source]) return res.status(400).json({ error: 'Unknown source' });
    const audience = audienceFor(req);
    const item = await catalogue.findItem(req.params.source, req.params.id, req._portal);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (audience !== 'admin' && (item.needs_review || !item.audiences.includes(audience))) {
      return res.status(404).json({ error: 'Not found' });
    }
    // b425b fix #7 — same Drive-provenance cut listItems() applies; this single-item
    // lookup bypasses listItems() entirely, so it needs its own.
    if (audience !== 'admin' && item.source === 'reading_document') {
      delete item.drive_path; delete item.drive_folder; delete item.drive_modified_at;
      delete item.proposed_audiences; delete item.origin;
      delete item.drive_file_id;
    }
    // b519 — and the internal file path inside provenance, for every source.
    if (audience !== 'admin' && item.provenance && item.provenance.path) {
      item.provenance = { ...item.provenance, path: null };
    }
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manager-only: set areas/audiences/review_date/pinned/needs_review on any catalogued item.
router.patch('/:source/:id/meta', roostManagerOnly, async (req, res) => {
  try {
    if (!catalogue.SOURCE_ADAPTERS[req.params.source]) return res.status(400).json({ error: 'Unknown source' });
    // b425b fix #9 — reading_item_meta is never read back for reading_document rows
    // (their areas/audiences live on the row itself); upsertMeta() would silently
    // write meta nothing ever displayed.
    if (req.params.source === 'reading_document') {
      const updated = await catalogue.updateDocumentMeta(req.params.id, req.body || {}, req.user);
      if (!updated) return res.status(404).json({ error: 'Not found' });
    } else {
      await catalogue.upsertMeta(req.params.source, req.params.id, req.body || {}, req.user);
    }
    const item = await catalogue.findItem(req.params.source, req.params.id, req._portal);
    res.json(item);
  } catch (e) {
    console.error('[library] PATCH meta', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Uploaded documents (reading_documents) ────────────────────────────────────
router.post('/documents', roostManagerOnly, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const tmpPath = req.file && req.file.path;
    const cleanup = () => { if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} } };
    try {
      if (!req.file) { cleanup(); return res.status(400).json({ error: 'file required' }); }
      const db = getPool();
      const title = (req.body.title || req.file.originalname || 'Untitled').trim();
      // b425b fix #10 — doc_key became a directory name on disk (path.join(STORE_BASE,
      // docKey)) with no sanitising at all; a doc_key of "../../something" would have
      // written outside STORE_BASE entirely. Whitelist to [a-z0-9-], then resolve and
      // verify the result is still inside STORE_BASE as a second, independent check.
      const rawDocKey = (req.body.doc_key || `upload-${Date.now()}`).trim();
      const docKey = rawDocKey.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120)
        || `upload-${Date.now()}`;
      const docType = String(req.body.doc_type || 'document');
      const areas = req.body.areas ? [].concat(JSON.parse(req.body.areas)) : [];
      const summary = (req.body.summary || '').trim() || null;

      const finalDir = path.join(STORE_BASE, docKey);
      const resolvedBase = path.resolve(STORE_BASE) + path.sep;
      if (!path.resolve(finalDir).startsWith(resolvedBase)) {
        cleanup();
        return res.status(400).json({ error: 'Invalid doc_key' });
      }

      // New version of an existing doc_key? Mark previous current row superseded.
      await db.query(`UPDATE ${SCHEMA()}.reading_documents SET is_current = false WHERE doc_key = $1 AND is_current = true`, [docKey]);
      const { rows: prevRows } = await db.query(
        `SELECT COALESCE(MAX(version), 0) AS v FROM ${SCHEMA()}.reading_documents WHERE doc_key = $1`, [docKey]);
      const nextVersion = Number(prevRows[0].v) + 1;

      fs.mkdirSync(finalDir, { recursive: true });
      const finalPath = path.join(finalDir, `v${nextVersion}${path.extname(req.file.filename)}`);
      fs.renameSync(tmpPath, finalPath);

      const { rows } = await db.query(`
        INSERT INTO ${SCHEMA()}.reading_documents
          (doc_key, version, is_current, title, summary, doc_type, areas, audiences, status, filename, mime, size_bytes, stored_path, uploaded_by, uploaded_by_name)
        VALUES ($1,$2, true, $3,$4,$5,$6, '{}', 'needs_review', $7,$8,$9,$10, $11,$12)
        RETURNING id, doc_key, version`,
        [docKey, nextVersion, title, summary, docType, areas, req.file.originalname,
         ALLOWED_EXT[path.extname(req.file.originalname).toLowerCase()] || req.file.mimetype,
         req.file.size, finalPath, req.user.id, req.user.name || req.user.email || null]);
      res.status(201).json(rows[0]);
    } catch (e) {
      cleanup();
      console.error('[library] upload', e.message);
      res.status(500).json({ error: e.message });
    }
  });
});

router.get('/documents/:id/file', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM ${SCHEMA()}.reading_documents WHERE id = $1`, [req.params.id]);
    const doc = rows[0];
    if (!doc || !doc.stored_path) return res.status(404).end();
    const audience = audienceFor(req);
    // b425b fix #11 — a superseded version (is_current=false) kept whatever
    // status/audiences it had when it WAS current, so its numeric id alone (never
    // linked from the catalogue, which only lists is_current=true rows, but still a
    // guessable/historic URL) stayed downloadable by anyone it used to be published
    // to. Only a manager can reach back into version history now.
    if (audience !== 'admin' && (!doc.is_current || doc.status !== 'published' || !(doc.audiences || []).includes(audience))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
    // b425b fix #8 — a raw filename with a curly quote, an en-dash or anything else
    // outside Latin-1 made Node's http module throw ("Invalid character in header
    // content") the moment this header was set, 500ing the whole request. RFC 5987
    // filename* carries the real name for browsers that support it; the ASCII
    // fallback filename= (also missing a backslash escape before) is for the ones
    // that don't.
    const rawName = doc.filename || 'document';
    const asciiName = rawName.replace(/[\\"]/g, '_').replace(/[^\x20-\x7E]/g, '_');
    const utf8Name = encodeURIComponent(rawName).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    res.setHeader('Content-Disposition', `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`);
    // b427: an unhandled 'error' on a ReadStream is an unhandled 'error' EVENT, which Node
    // treats as fatal and crashes the whole process — found this taking down wren-ladn-dev
    // (all four portals, not just this route) the moment a stored_path pointed at a file that
    // didn't actually exist. A 404 here if nothing has been sent yet; otherwise just stop.
    fs.createReadStream(doc.stored_path)
      .on('error', (err) => {
        console.error('[library] file stream', doc.id, err.message);
        if (!res.headersSent) res.status(404).json({ error: 'File missing on disk' });
        else res.end();
      })
      .pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/documents/:id/publish', roostManagerOnly, async (req, res) => {
  try {
    const db = getPool();
    const audiences = Array.isArray(req.body.audiences) ? req.body.audiences : [];
    const { rows } = await db.query(
      `UPDATE ${SCHEMA()}.reading_documents SET status = 'published', audiences = $2 WHERE id = $1 RETURNING id`,
      [req.params.id, audiences]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// b426: bulk action for the Needs-review queue — accept/set area+type+audiences
// and optionally publish, or discard, a batch of reading_documents rows in one
// call. Body: { ids: [...], areas?, doc_type?, audiences?, publish?, discard? }.
// Never touches the other eight unioned sources — those keep their own editors.
router.post('/documents/bulk', roostManagerOnly, async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    if (ids.length > 200) return res.status(400).json({ error: 'At most 200 at a time.' });
    const { areas, doc_type, audiences, publish, discard } = req.body || {};
    const result = await catalogue.bulkUpdateDocuments(ids, { areas, doc_type, audiences, publish, discard }, req.user);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[library] bulk', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/documents/:id/unpublish', roostManagerOnly, async (req, res) => {
  try {
    const db = getPool();
    await db.query(`UPDATE ${SCHEMA()}.reading_documents SET status = 'needs_review' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── b427: "What's in the Reading Room" — Roost-only overview tab ─────────────────────────────
router.get('/overview', roostManagerOnly, async (req, res) => {
  try {
    res.json(await catalogue.overview());
  } catch (e) {
    console.error('[library] overview', e.message);
    res.status(500).json({ error: e.message });
  }
});

// The paperless checklist — a manager ticks status/notes; never writes anywhere else.
router.patch('/checklist/:id', roostManagerOnly, async (req, res) => {
  try {
    const row = await catalogue.updateChecklistItem(req.params.id, req.body || {}, req.user);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    console.error('[library] checklist patch', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── b482: the bookshelf ───────────────────────────────────────────────────────
// `viewer` identifies the current reader for progress/relevance — a staff id on
// the bearer portals, a parent's email on the cookie-authenticated one (same
// identity parent-identity.js already uses everywhere else for a parent).
function viewerFor(req) {
  if (req._portal === 'parents') {
    return { kind: 'parent', readerId: (req.parent && req.parent.email) || null, role: null, staffId: null, portal: 'parents' };
  }
  return { kind: 'staff', readerId: req.user ? String(req.user.id) : null, role: req.user && req.user.role, staffId: req.user && req.user.id, portal: req._portal };
}

router.patch('/books/:key', roostManagerOnly, async (req, res) => {
  try {
    const { title, subtitle, icon } = req.body || {};
    const row = await catalogue.renameBook(req.params.key, { title, subtitle, icon }, req.user);
    res.json(row);
  } catch (e) {
    console.error('[library] PATCH /books/:key', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Combine an item into a book (or create a new one — any book_key not already
// in use just becomes a fresh 1-chapter book the moment it's assigned).
router.post('/books/move', roostManagerOnly, async (req, res) => {
  try {
    const { source, source_id, book_key, chapter_title } = req.body || {};
    if (!source || !source_id || !book_key) return res.status(400).json({ error: 'source, source_id, book_key required' });
    if (!catalogue.SOURCE_ADAPTERS[source]) return res.status(400).json({ error: 'Unknown source' });
    const row = await catalogue.moveToBook(source, source_id, book_key, chapter_title, req.user);
    res.json(row);
  } catch (e) {
    console.error('[library] POST /books/move', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/books/split', roostManagerOnly, async (req, res) => {
  try {
    const { source, source_id } = req.body || {};
    if (!source || !source_id) return res.status(400).json({ error: 'source, source_id required' });
    if (!catalogue.SOURCE_ADAPTERS[source]) return res.status(400).json({ error: 'Unknown source' });
    const row = await catalogue.splitFromBook(source, source_id, req.user);
    res.json(row);
  } catch (e) {
    console.error('[library] POST /books/split', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Any authenticated viewer (staff on any portal, or a parent) can mark their
// own reading progress — this never touches another reader's row (reader
// identity always comes from the session, never from the request body).
router.post('/progress', async (req, res) => {
  try {
    const viewer = viewerFor(req);
    if (!viewer.readerId) return res.status(401).json({ error: 'No reader identity' });
    const { source, source_id, book_key, read } = req.body || {};
    if (!source || !source_id) return res.status(400).json({ error: 'source, source_id required' });
    if (!catalogue.SOURCE_ADAPTERS[source]) return res.status(400).json({ error: 'Unknown source' });
    // b482b fix F12 — this never checked the reader could actually see the
    // item before writing a progress row for it; same visibility cut as every
    // other per-item route below.
    const audience = audienceFor(req);
    const item = await catalogue.findItem(source, source_id, req._portal);
    if (!item || (audience !== 'admin' && (item.needs_review || !item.audiences.includes(audience)))) {
      return res.status(404).json({ error: 'Not found' });
    }
    await catalogue.markRead(viewer.kind, viewer.readerId, source, source_id, book_key || null, read !== false);
    res.json({ ok: true });
  } catch (e) {
    console.error('[library] POST /progress', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Persona list for the "For" facet — labels only, no PII, safe on every portal.
// b482b fix F3 — scoped the same way the /books facet itself now is: Parents
// get none, EY/HR get the staff ones (not Roost's "preview as Parents"),
// Roost gets everything.
router.get('/personas', async (req, res) => {
  try {
    const audience = audienceFor(req);
    res.json(catalogue.personasVisibleTo(await catalogue.listPersonas(), audience, viewerFor(req)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/personas/:key', roostManagerOnly, async (req, res) => {
  try {
    const row = await catalogue.updatePersona(req.params.key, req.body || {}, req.user);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    console.error('[library] PATCH /personas/:key', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
