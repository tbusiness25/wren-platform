'use strict';
const express       = require('express');
const path          = require('path');
const fs            = require('fs');
const multer        = require('multer');
const mammoth       = require('mammoth');
const PDFDocument   = require('pdfkit');
const router        = express.Router();
const { getPool }       = require('../db/pool');
const authenticate      = require('../middleware/auth');
const { requireRole }   = require('../middleware/auth');
const { recordAudit }   = require('../utils/audit');

const SCHEMA    = () => process.env.PG_SCHEMA || 'ladn';
const DATA_DIR  = process.env.CONTRACT_DATA_DIR || path.join(__dirname, '../../data/contracts');
const HB_DIR    = path.join(DATA_DIR, '../handbooks');

fs.mkdirSync(HB_DIR, { recursive: true });

const managerOnly = requireRole('manager', 'deputy_manager', 'admin');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(HB_DIR, { recursive: true });
      cb(null, HB_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `handbook-upload-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.docx', '.pdf', '.md', '.txt'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only .docx, .pdf, .md, .txt allowed'), ok);
  },
});

// ─── GET /api/handbook ───────────────────────────────────────────────────────

router.get('/', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT h.id, h.version, h.title, h.is_current, h.effective_date,
             h.pdf_path, h.changes_summary, h.published_at, h.created_at,
             s.first_name || ' ' || s.last_name AS approved_by_name
        FROM ${SCHEMA()}.staff_handbook_versions h
        LEFT JOIN ${SCHEMA()}.staff s ON s.id = h.approved_by
       ORDER BY h.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/handbook/current ───────────────────────────────────────────────

router.get('/current', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [row] } = await db.query(
      `SELECT id, version, title, is_current, effective_date, pdf_path, changes_summary
         FROM ${SCHEMA()}.staff_handbook_versions WHERE is_current=true LIMIT 1`
    );
    res.json(row || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/handbook/:id/pdf ───────────────────────────────────────────────

router.get('/:id/pdf', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [row] } = await db.query(
      `SELECT pdf_path FROM ${SCHEMA()}.staff_handbook_versions WHERE id=$1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!row.pdf_path || !fs.existsSync(row.pdf_path)) {
      return res.status(404).json({ error: 'PDF not generated yet' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(row.pdf_path);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/handbook — create new version ─────────────────────────────────

router.post('/', ...managerOnly, upload.single('file'), async (req, res) => {
  const db = getPool();
  const { version, title, effective_date, changes_summary } = req.body;

  if (!version) return res.status(400).json({ error: 'version required' });

  try {
    let contentMd = req.body.content_md || '';
    let sourceDocPath = null;

    // Parse uploaded file
    if (req.file) {
      sourceDocPath = req.file.path;
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: req.file.path });
        contentMd = result.value;
      } else if (ext === '.md' || ext === '.txt') {
        contentMd = fs.readFileSync(req.file.path, 'utf8');
      } else if (ext === '.pdf') {
        contentMd = '(PDF uploaded — content stored as source document)';
      }
    }

    // Generate PDF from markdown content
    const pdfOutPath = path.join(HB_DIR, `handbook-v${version.replace(/[^a-z0-9.-]/gi, '_')}.pdf`);
    await generateHandbookPDF(pdfOutPath, contentMd, version, title || 'Staff Handbook');

    const { rows: [created] } = await db.query(`
      INSERT INTO ${SCHEMA()}.staff_handbook_versions
        (version, title, content_md, pdf_path, source_doc_path, effective_date,
         changes_summary, approved_by, is_current, published_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,now())
      ON CONFLICT (version) DO UPDATE
        SET title=$2, content_md=$3, pdf_path=$4, source_doc_path=$5,
            effective_date=$6, changes_summary=$7, approved_by=$8, published_at=now()
      RETURNING id
    `, [
      version,
      title || 'Staff Handbook',
      contentMd,
      pdfOutPath,
      sourceDocPath,
      effective_date || null,
      changes_summary || null,
      req.user.id,
    ]);

    recordAudit({ req, action: 'handbook_upload', entity_type: 'staff_handbook', entity_id: created.id, meta: { version } });

    res.json({ id: created.id, version, pdf_path: pdfOutPath });
  } catch (e) {
    console.error('POST /api/handbook:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/handbook/:id/set-current ─────────────────────────────────────

router.patch('/:id/set-current', ...managerOnly, async (req, res) => {
  const db  = getPool();
  const hid = parseInt(req.params.id);

  try {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Unset all current
      await client.query(
        `UPDATE ${SCHEMA()}.staff_handbook_versions SET is_current=false`
      );
      // Set this one
      const { rows: [row] } = await client.query(
        `UPDATE ${SCHEMA()}.staff_handbook_versions SET is_current=true WHERE id=$1 RETURNING version`,
        [hid]
      );
      if (!row) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
      await client.query('COMMIT');

      recordAudit({ req, action: 'handbook_set_current', entity_type: 'staff_handbook', entity_id: hid, meta: { version: row.version } });

      res.json({ ok: true, version: row.version });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Simple PDF generator for handbook content ───────────────────────────────

async function generateHandbookPDF(outPath, contentMd, version, title) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      bufferPages: true,
    });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    // Cover-style header
    doc.fillColor('#4a9abf').fontSize(18).font('Helvetica-Bold')
       .text('Your Nursery', { align: 'center' });
    doc.fillColor('#e07820').fontSize(14).font('Helvetica-Bold')
       .text(title, { align: 'center' });
    doc.fillColor('#94a3b8').fontSize(10).font('Helvetica')
       .text(`Version ${version}  |  123 Example Lane, Your Town, AB1 2CD`, { align: 'center' });
    doc.moveDown(2);

    const lines = contentMd.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line.startsWith('# ')) {
        doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text(line.slice(2));
        doc.moveDown(0.5);
      } else if (line.startsWith('## ')) {
        doc.fillColor('#4a9abf').fontSize(11).font('Helvetica-Bold').text(line.slice(3));
        doc.moveDown(0.3);
      } else if (line.startsWith('- ')) {
        doc.fillColor('#0f172a').fontSize(9).font('Helvetica')
           .text('•  ' + line.slice(2), { indent: 12, lineGap: 2 });
      } else if (line === '') {
        doc.moveDown(0.3);
      } else {
        const cleaned = line.replace(/\*\*(.+?)\*\*/g, '$1');
        doc.fillColor('#0f172a').fontSize(9).font('Helvetica').text(cleaned, { lineGap: 3 });
      }
    }

    // Page footers
    doc.flushPages();
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const y = doc.page.height - 35;
      doc.fillColor('#94a3b8').fontSize(7).font('Helvetica')
         .text(`${title} v${version}  |  Page ${i + 1} of ${range.count}`,
           doc.page.margins.left, y,
           { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center' }
         );
    }
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// b318 (2026-09-11) — THE EMPLOYEE HANDBOOK, ON THE HR PORTAL
//
// Toby: "the whole employee handbook should really be on the HR portal anyway
// … people need to be clear about what the rules are."
//
// APPENDED, not rewritten. Everything above this line is the older uploaded-
// document flow (staff_handbook_versions + a generated PDF) and is untouched:
// its routes still resolve, its table is the same table. What b318 adds is the
// LIVE handbook — one copy, in ladn.starter_pack_documents.body_html, where it
// is already edited — rendered as addressable sections so that:
//
//   * every rule check can link to the paragraph it comes from,
//   * a reader can search it,
//   * an edit makes a new VERSION and acknowledgements reset,
//   * and Roost can see who has read which version.
//
// THERE IS NO SECOND COPY OF THE TEXT. starter_pack_documents holds the live
// document; staff_handbook_versions holds dated snapshots of it. Editing the
// snapshot would be editing history, so nothing here writes to body_html.
// ═══════════════════════════════════════════════════════════════════════════

const ER318  = require('../lib/employment-rules');
const svc318 = require('../services/employment-rules-service');
const crypto318 = require('crypto');

const MANAGER_ROLES_318 = ['manager', 'deputy_manager', 'admin'];
const isManager318 = req => MANAGER_ROLES_318.includes(req.user && req.user.role);

// ── GET /api/handbook/document ──────────────────────────────────────────────
// The whole thing: contents tree, sections, the flags against it, the current
// version, and whether YOU have acknowledged it. Every member of staff.
//
// ?section=<slug> returns one section only — what a rule's "read the rule"
// link opens, so a phone does not have to download 70KB to show one paragraph.
router.get('/document', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const live = await svc318.liveHandbook(db);
    if (!live) return res.status(404).json({ error: 'No handbook document is on file.' });

    const sections = ER318.handbookSections(live.body_html);
    const current = await svc318.currentVersion(db);

    if (req.query.section) {
      const one = sections.find(s => s.slug === req.query.section);
      if (!one) return res.status(404).json({ error: 'No such section' });
      const flags = (await svc318.handbookFlags(db))
        .filter(f => !f.resolved_at && (f.anchor === one.slug || f.anchor === one.parent_slug));
      return res.json({ section: one, flags, version: current ? current.version : null });
    }

    let myAck = null;
    if (current) {
      const { rows } = await db.query(
        `SELECT acknowledged_at FROM ${SCHEMA()}.handbook_acknowledgements
          WHERE version_id=$1 AND staff_id=$2`, [current.id, req.user.id]);
      myAck = rows[0] ? rows[0].acknowledged_at : null;
    }

    // Has the live document moved on since the last version was published?
    // Managers see that as an action; everybody else just reads the live text.
    const drifted = !!(current && current.content_hash !== live.content_hash);

    res.json({
      title: live.title,
      slug: live.slug,
      updated_at: live.updated_at,
      contents: ER318.handbookContents(sections),
      sections,
      section_count: sections.length,
      flags: (await svc318.handbookFlags(db)).filter(f => !f.resolved_at),
      version: current,
      unversioned: !current,
      drifted,
      my_acknowledgement: myAck,
      needs_my_acknowledgement: !!(current && current.requires_ack !== false && !myAck),
      can_publish: isManager318(req),
    });
  } catch (e) {
    console.error('[handbook/document]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/handbook/document/search?q= ────────────────────────────────────
// Plain substring search over the section text, because that is what people
// actually do with a handbook: they remember three words and want the
// paragraph. Returns a snippet around each hit with the section it is in.
router.get('/document/search', authenticate, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ q, hits: [] });
  try {
    const db = getPool();
    const live = await svc318.liveHandbook(db);
    if (!live) return res.json({ q, hits: [] });
    const needle = q.toLowerCase();
    const hits = [];
    for (const s of ER318.handbookSections(live.body_html)) {
      const hay = s.text.toLowerCase();
      let at = hay.indexOf(needle);
      if (at === -1 && s.title.toLowerCase().indexOf(needle) === -1) continue;
      if (at === -1) at = 0;
      hits.push({
        slug: s.slug, title: s.title, parent_title: s.parent_title, level: s.level,
        snippet: (at > 60 ? '…' : '') + s.text.slice(Math.max(0, at - 60), at + 180) + (s.text.length > at + 180 ? '…' : ''),
      });
      if (hits.length >= 40) break;
    }
    res.json({ q, hits, count: hits.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/handbook/document/publish — cut a new version ─────────────────
// Manager-only. A no-op when the text has not changed: asking twenty-eight
// people to re-read an unchanged document is how you teach them to click
// "I have read this" without reading it.
router.post('/document/publish', ...managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const out = await svc318.publishVersion(db, {
      published_by: req.user.id,
      effective_date: (req.body || {}).effective_date,
      changes_summary: (req.body || {}).changes_summary,
      force: (req.body || {}).force === true,
    });
    if (out.published) {
      await recordAudit({ req, action: 'create', entity_type: 'handbook_version', entity_id: out.version.id,
        meta: { version: out.version.version, sections: out.version.section_count } }).catch(() => {});
    }
    res.status(out.published ? 201 : 200).json(out);
  } catch (e) {
    console.error('[handbook/publish]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/handbook/document/versions ─────────────────────────────────────
router.get('/document/versions', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT v.id, v.version, v.title, v.is_current, v.effective_date, v.published_at,
             v.section_count, v.changes_summary, v.requires_ack,
             s.first_name || ' ' || s.last_name AS published_by_name,
             (SELECT count(*) FROM ${SCHEMA()}.handbook_acknowledgements a WHERE a.version_id = v.id)::int AS acknowledgements
        FROM ${SCHEMA()}.staff_handbook_versions v
        LEFT JOIN ${SCHEMA()}.staff s ON s.id = v.published_by
       WHERE v.source_slug IS NOT NULL
       ORDER BY v.version DESC`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/handbook/document/acknowledge ─────────────────────────────────
// "I have read this", against a specific version. Idempotent: the unique index
// is on (version_id, staff_id), so a double-tap is not a second receipt.
router.post('/document/acknowledge', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const current = await svc318.currentVersion(db);
    if (!current) {
      return res.status(409).json({ error: 'No version of the handbook has been published yet, so there is nothing to acknowledge.' });
    }
    const ip = req.headers['cf-connecting-ip']
      || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.ip || '';
    const { rows } = await db.query(`
      INSERT INTO ${SCHEMA()}.handbook_acknowledgements (version_id, staff_id, ip_hash, user_agent, note)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (version_id, staff_id) DO UPDATE SET note = COALESCE(EXCLUDED.note, ${SCHEMA()}.handbook_acknowledgements.note)
      RETURNING id, version_id, staff_id, acknowledged_at`,
      [current.id, req.user.id,
       ip ? crypto318.createHash('sha256').update(ip).digest('hex') : null,
       (req.headers['user-agent'] || '').slice(0, 300) || null,
       (req.body || {}).note || null]);
    res.status(201).json({ ...rows[0], version: current.version });
  } catch (e) {
    console.error('[handbook/acknowledge]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/handbook/document/acknowledgements — who has read which ────────
router.get('/document/acknowledgements', ...managerOnly, async (req, res) => {
  try {
    const db = getPool();
    let versionId = Number(req.query.version_id) || null;
    if (!versionId) {
      const current = await svc318.currentVersion(db);
      if (!current) return res.json({ version_id: null, total: 0, acknowledged: 0, outstanding: 0, staff: [] });
      versionId = current.id;
    }
    const state = await svc318.acknowledgementState(db, versionId);
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/handbook/document/flags — where our handbook is behind the law ─
router.get('/document/flags', authenticate, async (req, res) => {
  try {
    res.json(await svc318.handbookFlags(getPool()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/handbook/document/flags/:id/resolve ────────────────────────────
// Marks a flag dealt with once Toby has updated the handbook text himself.
// It does NOT touch body_html: the handbook is his contractual document and
// nothing in Wren rewrites it.
router.put('/document/flags/:id/resolve', ...managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const reopen = (req.body || {}).reopen === true;
    const { rows } = await db.query(`
      UPDATE ${SCHEMA()}.handbook_flags
         SET resolved_at     = CASE WHEN $2::boolean THEN NULL ELSE now() END,
             resolved_by     = CASE WHEN $2::boolean THEN NULL ELSE $3::int END,
             resolution_note = COALESCE($4, resolution_note)
       WHERE id = $1 RETURNING *`,
      [Number(req.params.id), reopen, req.user.id, (req.body || {}).note || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
