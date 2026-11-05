'use strict';
// b104 — Documents on staff & child profiles (Roost / Nest / Egg).
// One shared router, mounted at /api/person-documents. Portal-aware via req._portal:
//   admin    (Roost)  → managers: full access to every staff/child document.
//   learning (Nest)   → staff: own staff docs (any visibility) + child docs (staff /
//                       staff_and_parents). Upload to self + any child. Managers see all.
//   hr                → staff self docs only (no child data on the HR portal).
//   parents  (Egg)    → strictly scoped to the parent's linked child(ren); docs with
//                       visibility parents / staff_and_parents. Uploads land as 'staff'
//                       and notify the key person + managers.
//
// Files stored on disk under /app/data/person-documents/<subject_type>/<subject_id>/
// following the document-workspaces multer pattern (tmp dir → rename to final).

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
// b321 — the family photo / peg portrait / allergy / medicine upload types, the
// retention class each one runs on, the content-sniff-and-EXIF-strip pipeline,
// and the "an allergy document must not be a dead end" rule.
const CD = require('../lib/child-documents');
const IMG = require('../lib/image-safety');
const PRINT = require('../lib/photo-print');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
// In container: /app/data → drop the ../../ up to /app, then data/…
const STORE_BASE = process.env.PERSON_DOC_BASE
  || path.join(__dirname, '../../data/person-documents');

// ── Upload constraints ────────────────────────────────────────────────────────
const MAX_BYTES = 30 * 1024 * 1024; // 30MB (short mp4 ceiling)
const ALLOWED_EXT = {
  '.pdf':  'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.heic': 'image/heic',
  '.webp': 'image/webp',   // b321 — phones and scanners produce these
  '.mp4':  'video/mp4',
};
// b155 added 'ehcp'. b321 added the five child-document types — every earlier
// category is preserved; this list is only ever appended to, because a category
// that disappears leaves existing rows failing the CHECK constraint.
const CATEGORIES  = ['certificate','contract','report','medical','photo_consent','ehcp','other']
  .concat(Object.keys(CD.DOC_TYPES));
const VISIBILITIES = ['confidential','staff','parents','staff_and_parents'];

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(STORE_BASE, 'tmp');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT[ext]) return cb(null, true);
    cb(new Error(`Unsupported file type "${ext}". Accepted: ${Object.keys(ALLOWED_EXT).join(', ')}`));
  },
});

router.use(authenticate);

// ── Role / scope helpers ──────────────────────────────────────────────────────
function isManager(req) {
  return ['manager', 'deputy_manager', 'admin'].includes(req.user && req.user.role);
}
function portal(req) { return req._portal || 'learning'; }

// The set of child ids a parent token is linked to (siblings). Trust the signed
// token's child_ids/child_id; fall back to a DB lookup by email for older tokens.
async function parentChildIds(req, db) {
  const ids = new Set();
  if (Array.isArray(req.user.child_ids)) req.user.child_ids.forEach(i => ids.add(Number(i)));
  if (req.user.child_id != null) ids.add(Number(req.user.child_id));
  if (ids.size) return ids;
  const email = (req.user.email || req.user.name || '').toLowerCase();
  if (email) {
    try {
      const { rows } = await db.query(
        `SELECT child_id FROM ${SCHEMA()}.parent_portal_access
         WHERE lower(email)=$1 AND is_active=true AND child_id IS NOT NULL`, [email]);
      rows.forEach(r => ids.add(Number(r.child_id)));
    } catch (_) {}
  }
  return ids;
}

async function audit(db, docId, action, req, detail) {
  const kind = portal(req) === 'parents' ? 'parent' : 'staff';
  try {
    await db.query(
      `INSERT INTO ${SCHEMA()}.person_document_audit(doc_id, action, actor_kind, actor_id, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [docId, action, kind, req.user.id || 0, detail ? String(detail).slice(0, 500) : null]);
  } catch (e) { console.error('[person-documents] audit failed:', e.message); }
}

// Can the current requester READ this document row? (used by list + file serve)
async function canRead(req, db, doc) {
  const p = portal(req);
  if (p === 'admin') return isManager(req);           // Roost = managers only
  if (p === 'hr') {                                    // HR: own staff docs only
    if (doc.subject_type !== 'staff') return false;
    if (isManager(req)) return true;
    return Number(doc.subject_id) === Number(req.user.id);
  }
  if (p === 'parents') {
    if (doc.subject_type !== 'child') return false;
    const ids = await parentChildIds(req, db);
    if (!ids.has(Number(doc.subject_id))) return false;
    if (['parents', 'staff_and_parents'].includes(doc.visibility)) return true;
    // b321 — a family can see what THEY sent us.
    //
    // A parent upload lands as visibility='staff' (b104, deliberately: a file a
    // parent sends is for the nursery, not for publication). The side effect was
    // that a family who uploaded a peg photo then saw "No documents yet" on the
    // very page they uploaded it from, with no way to tell whether it had
    // arrived — which produces the email to the office this build exists to
    // remove. Their own file is not someone else's data.
    //
    // 'confidential' still wins: a manager moving a parent's upload there is a
    // deliberate act, usually because it turned out to hold something about
    // another family or a safeguarding matter.
    if (doc.visibility !== 'confidential'
        && ['parent', 'registration'].includes(doc.uploaded_by_kind)) return true;
    return false;
  }
  // learning (Nest / EY staff)
  // 2026-10-05: staff documents are HR-only — the EY portal is the shared room tablets.
  if (doc.subject_type === 'staff') return false;
  if (isManager(req)) return true;                     // managers see all
  if (doc.subject_type === 'staff') {
    return Number(doc.subject_id) === Number(req.user.id); // own staff docs, any visibility
  }
  // child docs → staff / staff_and_parents (never confidential / parents-only)
  return ['staff', 'staff_and_parents'].includes(doc.visibility);
}

// Build the WHERE/visibility clause for the LIST endpoint (portal-scoped).
async function listRows(req, db, subjectType, subjectId) {
  const p = portal(req);
  const base = `SELECT * FROM ${SCHEMA()}.person_documents
                WHERE deleted=false AND subject_type=$1 AND subject_id=$2`;
  const { rows } = await db.query(`${base} ORDER BY uploaded_at DESC`, [subjectType, subjectId]);
  const out = [];
  for (const r of rows) { if (await canRead(req, db, r)) out.push(r); }
  return out;
}

function pub(r) {
  return {
    id: r.id, subject_type: r.subject_type, subject_id: r.subject_id,
    title: r.title, category: r.category, visibility: r.visibility,
    filename: r.filename, mime: r.mime, size_bytes: r.size_bytes != null ? Number(r.size_bytes) : null,
    uploaded_by_kind: r.uploaded_by_kind, uploaded_by_id: r.uploaded_by_id,
    uploaded_at: r.uploaded_at, notes: r.notes,
    // b321 — the class is shown, not just stored. A manager looking at a list of
    // uploads should be able to see that the health care plan is the one with a
    // 25-year clock on it without going to read the retention policy.
    retention_class: r.retention_class || null,
    retention_note: r.retention_class ? (CD.CLASS_NOTE[r.retention_class] || null) : null,
    exif_stripped: r.exif_stripped == null ? null : !!r.exif_stripped,
    image_width: r.image_width != null ? Number(r.image_width) : null,
    image_height: r.image_height != null ? Number(r.image_height) : null,
    is_photo: CD.PHOTO_CATEGORIES.includes(r.category),
    from_family: ['parent', 'registration'].includes(r.uploaded_by_kind),
    file_url: r.stored_path ? `/api/person-documents/${r.id}/file` : null,
    print_url: (r.category === 'family_photo' && r.stored_path)
      ? `/api/person-documents/${r.id}/print/a4` : null,
  };
}

// ── GET /  — list documents for a subject ─────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const subjectType = String(req.query.subject_type || '');
    const subjectId   = parseInt(req.query.subject_id, 10);
    if (!['staff', 'child'].includes(subjectType) || !Number.isInteger(subjectId))
      return res.status(400).json({ error: 'subject_type (staff|child) and subject_id required' });

    const p = portal(req);
    if (p === 'admin' && !isManager(req)) return res.status(403).json({ error: 'Manager access required' });
    if (p === 'hr' && subjectType !== 'staff')
      return res.status(403).json({ error: 'Child documents are not available on the HR portal' });
    if (p === 'learning' && subjectType === 'staff')   // 2026-10-05: HR portal only
      return res.status(403).json({ error: 'Staff documents are not available on the EY portal' });
    if (p === 'parents') {
      if (subjectType !== 'child') return res.status(403).json({ error: 'Forbidden' });
      const ids = await parentChildIds(req, getPool());
      if (!ids.has(subjectId)) return res.status(403).json({ error: 'Forbidden' });
    }
    const rows = await listRows(req, getPool(), subjectType, subjectId);
    res.json(rows.map(pub));
  } catch (e) {
    console.error('[person-documents] list:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /  — upload (multipart) ──────────────────────────────────────────────
router.post('/', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const tmpPath = req.file && req.file.path;
    const cleanup = () => { if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} } };
    try {
      const db = getPool();
      const p  = portal(req);
      const subjectType = String(req.body.subject_type || '');
      const subjectId   = parseInt(req.body.subject_id, 10);
      let   title       = (req.body.title || '').trim();
      let   category    = String(req.body.category || 'other');
      let   visibility  = String(req.body.visibility || '');
      const notes       = (req.body.notes || '').trim() || null;

      if (!req.file) { return res.status(400).json({ error: 'file is required' }); }
      if (!['staff', 'child'].includes(subjectType) || !Number.isInteger(subjectId)) {
        cleanup(); return res.status(400).json({ error: 'subject_type and subject_id required' });
      }
      if (!CATEGORIES.includes(category)) category = 'other';
      if (!title) title = req.file.originalname;

      // ── Authorisation + visibility defaulting per portal ───────────────────
      let uploaderKind = 'staff';
      if (p === 'admin') {
        if (!isManager(req)) { cleanup(); return res.status(403).json({ error: 'Manager access required' }); }
        if (!VISIBILITIES.includes(visibility)) visibility = 'confidential';
      } else if (p === 'hr') {
        if (subjectType !== 'staff') { cleanup(); return res.status(403).json({ error: 'Child documents are not available on the HR portal' }); }
        if (!isManager(req) && subjectId !== Number(req.user.id)) { cleanup(); return res.status(403).json({ error: 'Forbidden' }); }
        if (!VISIBILITIES.includes(visibility)) visibility = 'staff';
      } else if (p === 'parents') {
        if (subjectType !== 'child') { cleanup(); return res.status(403).json({ error: 'Parents can only upload child documents' }); }
        const ids = await parentChildIds(req, db);
        if (!ids.has(subjectId)) { cleanup(); return res.status(403).json({ error: 'Forbidden' }); }
        visibility   = 'staff';       // parent uploads always land as staff-visible
        uploaderKind = 'parent';
        category     = CATEGORIES.includes(category) ? category : 'other';
      } else { // learning (Nest / EY staff)
        if (subjectType === 'staff') { cleanup(); return res.status(403).json({ error: 'Staff documents are not available on the EY portal' }); }
        if (subjectType === 'staff' && !isManager(req) && subjectId !== Number(req.user.id)) {
          cleanup(); return res.status(403).json({ error: 'Staff can only upload to their own file' });
        }
        if (!VISIBILITIES.includes(visibility)) visibility = 'staff';
      }
      // 'parents' visibility is invalid for staff subjects
      if (subjectType === 'staff' && visibility === 'parents') visibility = 'staff';

      // ── b321: what it IS, and what it carries ──────────────────────────────
      // Everything the extension said up to here was a claim. Read the bytes.
      //
      // The strict pipeline runs for the b321 child-document types only. The
      // b104 categories still accept .docx/.xlsx/.mp4, which the sniffer does
      // not (and should not) recognise — putting them through it would break
      // staff document uploads that have worked for a year. But an IMAGE gets
      // its metadata stripped whatever category it was filed under, because a
      // phone photo filed as "other" has exactly the same GPS in it.
      const ext = path.extname(req.file.originalname).toLowerCase();
      let bytes = fs.readFileSync(req.file.path);
      let mime = ALLOWED_EXT[ext] || req.file.mimetype;
      let sniffed = null, exifStripped = null, dim = null, sha = null;

      if (CD.DOC_TYPES[category]) {
        const chk = CD.inspectAndClean(bytes, category);
        if (!chk.ok) { cleanup(); return res.status(400).json({ error: chk.error }); }
        bytes = chk.buffer; mime = chk.mime; sniffed = chk.mime;
        exifStripped = chk.exifStripped; sha = chk.sha256;
        dim = { width: chk.width, height: chk.height };
      } else {
        const seen = IMG.sniff(bytes);
        if (seen) sniffed = seen.mime;
        if (seen && seen.kind === 'image') {
          const r = IMG.strip(bytes, seen.mime);
          if (r.stripped) { bytes = r.buffer; exifStripped = true; }
          dim = IMG.dimensions(bytes, seen.mime);
        }
      }
      const retentionClass = CD.classFor(category);

      // ── Move file into place ───────────────────────────────────────────────
      // The stored extension comes from what the file IS where we could tell,
      // not from what it was called: the serve route echoes the stored mime into
      // Content-Type, so an uploader who could pick the extension could pick
      // what the browser does with the bytes.
      const finalDir = path.join(STORE_BASE, subjectType, String(subjectId));
      fs.mkdirSync(finalDir, { recursive: true });
      const storedExt = (CD.DOC_TYPES[category] && sniffed)
        ? { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' }[sniffed] || ext
        : ext;
      const finalName = req.file.filename.replace(/\.[^.]*$/, '') + storedExt;
      const finalPath = path.join(finalDir, finalName);
      fs.writeFileSync(finalPath, bytes);
      try { fs.unlinkSync(req.file.path); } catch (_) {}

      const { rows: [doc] } = await db.query(
        `INSERT INTO ${SCHEMA()}.person_documents
           (subject_type, subject_id, title, category, filename, stored_path, mime, size_bytes,
            visibility, uploaded_by_kind, uploaded_by_id, notes,
            retention_class, exif_stripped, sniffed_mime, image_width, image_height, sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [subjectType, subjectId, title, category, req.file.originalname, finalPath,
         mime, bytes.length, visibility,
         uploaderKind, req.user.id || 0, notes,
         retentionClass, exifStripped, sniffed,
         dim && dim.width ? dim.width : null, dim && dim.height ? dim.height : null, sha]);

      // b321 — an allergy document that leaves the allergy field empty never
      // reaches the chef's day sheet. Raise the task now, while someone is
      // looking at this child. No-ops for every other category.
      if (subjectType === 'child') await CD.ensureAllergyTask(db, subjectId, doc.id, category);

      await audit(db, doc.id, 'upload', req, `${subjectType}#${subjectId} vis=${visibility}`);

      // Parent upload → notify key person + managers
      if (uploaderKind === 'parent') {
        try {
          const { rows: [ch] } = await db.query(
            `SELECT first_name, last_name, key_person_id FROM ${SCHEMA()}.children WHERE id=$1`, [subjectId]);
          const childName = ch ? `${ch.first_name} ${ch.last_name}`.trim() : `child #${subjectId}`;
          const t = `New document from a parent`;
          const b = `A parent uploaded "${title}" to ${childName}'s file.`;
          const link = `/child-profile.html?id=${subjectId}`;
          if (ch && ch.key_person_id) {
            await db.query(
              `INSERT INTO ${SCHEMA()}.notifications
                 (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
               VALUES ('staff',$1,'parent_upload',$2,$3,$4,'person_documents',$5,'normal')`,
              [ch.key_person_id, t, b, link, doc.id]);
          }
          await db.query(
            `INSERT INTO ${SCHEMA()}.notifications
               (recipient_type, category, title, body, link, related_table, related_id, priority)
             VALUES ('all-managers','parent_upload',$1,$2,$3,'person_documents',$4,'normal')`,
            [t, b, link, doc.id]);
        } catch (e) { console.error('[person-documents] notify failed:', e.message); }
      }

      res.status(201).json(pub(doc));
    } catch (e) {
      cleanup();
      console.error('[person-documents] upload:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// b321 — PRINTING. "Staff can download and print" is the whole reason a family
// sends us these photos, so the printable artefact is a route, not a suggestion
// that someone open the JPEG and fight with a printer dialogue.
//
// Registered BEFORE /:id/file. Neither /print/peg-sheet nor /:id/print/a4 can
// collide with it (the second segment is never the literal "file"), but reading
// order matters more than the router's matching rules when someone adds the
// next route here.
//
// WHO MAY PRINT: staff on Roost and Nest. Not the HR portal — it holds no child
// data by design — and not parents: a family may see their own child's file,
// but a printable sheet of other children's faces is a different object
// entirely, and the peg sheet is by definition a whole room.
// ─────────────────────────────────────────────────────────────────────────────
function canPrint(req) {
  const p = portal(req);
  if (p === 'admin') return isManager(req);
  return p === 'learning';                 // any practitioner in the room
}

function displayName(c) {
  return String(c.preferred_name || c.first_name || '').trim() || `#${c.id}`;
}

/** Read a stored document off disk, but only if it is really there. */
function readStored(doc) {
  try {
    if (!doc || !doc.stored_path || !fs.existsSync(doc.stored_path)) return null;
    return fs.readFileSync(doc.stored_path);
  } catch (_) { return null; }
}

// ── GET /:id/print/a4 — one family photo, fitted to a sheet of A4 ────────────
router.get('/:id/print/a4', async (req, res) => {
  if (!canPrint(req)) return res.status(403).json({ error: 'Staff access required' });
  // A non-numeric id must be a 404, not a 500: postgres raises "invalid input
  // syntax for type integer" on the parameter and the handler turns that into a
  // server error, which reads to whoever is looking as though the print engine
  // broke rather than as though the link was wrong.
  if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const { rows: [doc] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.person_documents WHERE id=$1 AND deleted=false`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!(await canRead(req, db, doc))) return res.status(403).json({ error: 'Forbidden' });
    if (!CD.PHOTO_CATEGORIES.includes(doc.category)) {
      return res.status(400).json({ error: 'Only a family photo or peg portrait can be laid out on A4.' });
    }
    const bytes = readStored(doc);
    if (!bytes) return res.status(404).json({ error: 'File not on disk' });

    let caption = null, subtitle = null;
    if (doc.subject_type === 'child' && String(req.query.caption || '1') !== '0') {
      const { rows: [c] } = await db.query(
        `SELECT id, first_name, preferred_name, room FROM ${SCHEMA()}.children WHERE id=$1`,
        [doc.subject_id]);
      // FIRST NAME ONLY on a wall display, and that is a rule, not a default:
      // a full name pinned up in a room is readable by every visitor, delivery
      // driver and contractor who walks through it.
      if (c) { caption = displayName(c); subtitle = c.room || null; }
    }

    const pdf = await PRINT.a4Photo(bytes, {
      caption, subtitle,
      width: doc.image_width, height: doc.image_height,
    });
    await audit(db, doc.id, 'print', req, 'a4');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="family-photo-a4-${doc.id}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('[person-documents] print a4:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /print/peg-sheet — many peg labels on one sheet ──────────────────────
// ?room=Pre-school | ?room_id=2 | ?child_ids=1,2,3 | (nothing) = every enrolled
// child. `include_missing=1` prints a blank label for a child with no photo yet,
// which is how a room leader sees WHO still owes us one.
router.get('/print/peg-sheet', async (req, res) => {
  if (!canPrint(req)) return res.status(403).json({ error: 'Staff access required' });
  try {
    const db = getPool();
    const where = [`c.is_active = true`, `COALESCE(c.status,'active') <> 'pending'`];
    const vals = [];
    if (req.query.child_ids) {
      const ids = String(req.query.child_ids).split(',')
        .map(n => parseInt(n, 10)).filter(Number.isInteger).slice(0, 300);
      if (!ids.length) return res.status(400).json({ error: 'child_ids had no valid ids' });
      vals.push(ids); where.push(`c.id = ANY($${vals.length}::int[])`);
    } else if (req.query.room_id) {
      vals.push(parseInt(req.query.room_id, 10)); where.push(`c.room_id = $${vals.length}`);
    } else if (req.query.room) {
      vals.push(String(req.query.room)); where.push(`c.room = $${vals.length}`);
    }

    // The photo is picked with DISTINCT ON … ORDER BY uploaded_at DESC: a family
    // who sends a better picture in the spring should get the spring one on the
    // peg, without anyone having to delete the old one first.
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.preferred_name, c.room,
             d.id AS doc_id, d.stored_path, d.image_width, d.image_height, d.mime
        FROM ${SCHEMA()}.children c
        LEFT JOIN LATERAL (
          SELECT id, stored_path, image_width, image_height, mime
            FROM ${SCHEMA()}.person_documents
           WHERE subject_type='child' AND subject_id=c.id
             AND category='peg_portrait' AND deleted=false AND stored_path IS NOT NULL
           ORDER BY uploaded_at DESC LIMIT 1
        ) d ON true
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(NULLIF(c.preferred_name,''), c.first_name), c.id`, vals);

    const includeMissing = String(req.query.include_missing || '0') === '1';
    const entries = [];
    for (const r of rows) {
      const bytes = r.doc_id ? readStored(r) : null;
      if (!bytes && !includeMissing) continue;
      entries.push({
        name: displayName(r),
        image: bytes || null,
        width: r.image_width, height: r.image_height,
        note: bytes ? null : 'photo needed',
      });
    }

    const scope = req.query.room ? String(req.query.room)
      : (rows.length && rows[0].room ? rows[0].room : 'All rooms');
    const pdf = await PRINT.pegSheet(entries, {
      heading: `Peg labels · ${scope} · cut along the dotted lines`,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="peg-labels.pdf"');
    res.send(pdf);
  } catch (e) {
    console.error('[person-documents] peg sheet:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /child-summary?child_id= — what this child has, and what is missing ──
// Drives the Roost panel's "still to come" line. Counts and categories only.
router.get('/child-summary', async (req, res) => {
  const childId = parseInt(req.query.child_id, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'child_id required' });
  const p = portal(req);
  if (p === 'admin' && !isManager(req)) return res.status(403).json({ error: 'Manager access required' });
  if (p === 'hr') return res.status(403).json({ error: 'Not available on the HR portal' });
  try {
    const db = getPool();
    if (p === 'parents') {
      const ids = await parentChildIds(req, db);
      if (!ids.has(childId)) return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await db.query(
      `SELECT category, count(*)::int AS n, max(uploaded_at) AS latest
         FROM ${SCHEMA()}.person_documents
        WHERE subject_type='child' AND subject_id=$1 AND deleted=false
        GROUP BY category`, [childId]);
    const have = {}; rows.forEach(r => { have[r.category] = { count: r.n, latest: r.latest }; });
    const types = Object.keys(CD.DOC_TYPES).map(k => ({
      key: k, label: CD.DOC_TYPES[k].label, icon: CD.DOC_TYPES[k].icon,
      retention: CD.DOC_TYPES[k].retention,
      count: have[k] ? have[k].count : 0,
      latest: have[k] ? have[k].latest : null,
    }));
    // The allergy dead-end, surfaced where a manager is already looking.
    const allergyRecorded = await CD.hasStructuredAllergy(db, childId);
    res.json({
      child_id: childId, types,
      allergy_documents: (have.allergy_doc ? have.allergy_doc.count : 0)
                       + (have.health_care_plan ? have.health_care_plan.count : 0),
      allergy_recorded: allergyRecorded,
    });
  } catch (e) {
    console.error('[person-documents] child-summary:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id/file  — stream the file (scoped) ─────────────────────────────────
router.get('/:id/file', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [doc] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.person_documents WHERE id=$1 AND deleted=false`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!(await canRead(req, db, doc))) return res.status(403).json({ error: 'Forbidden' });
    if (!doc.stored_path || !fs.existsSync(doc.stored_path))
      return res.status(404).json({ error: 'File not on disk' });
    if (doc.mime) res.setHeader('Content-Type', doc.mime);
    const dl = String(req.query.download || '') === '1';
    res.setHeader('Content-Disposition',
      `${dl ? 'attachment' : 'inline'}; filename="${(doc.filename || 'document').replace(/["\\]/g, '')}"`);
    fs.createReadStream(doc.stored_path).pipe(res);
  } catch (e) {
    console.error('[person-documents] file:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /:id  — edit visibility / title / category / notes ──────────────────
router.patch('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [doc] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.person_documents WHERE id=$1 AND deleted=false`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const p = portal(req);
    if (p === 'learning' && doc.subject_type === 'staff') return res.status(403).json({ error: 'Forbidden' }); // 2026-10-05: HR only
    const manager = (p === 'admin' || p === 'learning' || p === 'hr') && isManager(req);
    let owner   = doc.uploaded_by_kind === (p === 'parents' ? 'parent' : 'staff')
                    && Number(doc.uploaded_by_id) === Number(req.user.id);
    // Every parent JWT shares uploaded_by_id=0, so the check above is vacuously true for
    // ANY parent on ANY parent-uploaded doc — scope it to the caller's own child(ren) too.
    if (owner && p === 'parents') {
      const ids = await parentChildIds(req, db);
      owner = ids.has(Number(doc.subject_id));
    }
    if (!manager && !owner) return res.status(403).json({ error: 'Forbidden' });
    if (p === 'admin' && !isManager(req)) return res.status(403).json({ error: 'Manager access required' });

    const sets = [], vals = []; let i = 1;
    if (req.body.title != null)    { sets.push(`title=$${i++}`);    vals.push(String(req.body.title).trim()); }
    if (req.body.notes != null)    { sets.push(`notes=$${i++}`);    vals.push(String(req.body.notes).trim() || null); }
    if (req.body.category != null && CATEGORIES.includes(req.body.category)) {
      sets.push(`category=$${i++}`); vals.push(req.body.category);
    }
    if (req.body.visibility != null) {
      if (!manager) return res.status(403).json({ error: 'Only managers can change visibility' });
      let v = String(req.body.visibility);
      if (!VISIBILITIES.includes(v)) return res.status(400).json({ error: 'Invalid visibility' });
      if (doc.subject_type === 'staff' && v === 'parents')
        return res.status(400).json({ error: "'parents' visibility is not valid for staff documents" });
      sets.push(`visibility=$${i++}`); vals.push(v);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(doc.id);
    const { rows: [updated] } = await db.query(
      `UPDATE ${SCHEMA()}.person_documents SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    // Audit the field names changed (not the "$N" placeholders).
    await audit(db, doc.id, 'edit', req, sets.map(s => s.split('=')[0]).join(','));
    res.json(pub(updated));
  } catch (e) {
    console.error('[person-documents] patch:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:id  — soft delete (keep file) ────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [doc] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.person_documents WHERE id=$1 AND deleted=false`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const p = portal(req);
    if (p === 'learning' && doc.subject_type === 'staff') return res.status(403).json({ error: 'Forbidden' }); // 2026-10-05: HR only
    const manager = (p === 'admin' || p === 'learning' || p === 'hr') && isManager(req);
    let owner   = doc.uploaded_by_kind === (p === 'parents' ? 'parent' : 'staff')
                    && Number(doc.uploaded_by_id) === Number(req.user.id);
    // Every parent JWT shares uploaded_by_id=0 — scope to the caller's own child(ren) too.
    if (owner && p === 'parents') {
      const ids = await parentChildIds(req, db);
      owner = ids.has(Number(doc.subject_id));
    }
    if (!manager && !owner) return res.status(403).json({ error: 'Forbidden' });

    await db.query(
      `UPDATE ${SCHEMA()}.person_documents
         SET deleted=true, deleted_at=now(), deleted_by_id=$2 WHERE id=$1`,
      [doc.id, req.user.id || 0]);
    await audit(db, doc.id, 'delete', req, null);
    res.json({ ok: true });
  } catch (e) {
    console.error('[person-documents] delete:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
