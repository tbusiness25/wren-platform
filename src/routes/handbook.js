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
       .text(`Version ${version}  |  1A Example Lane, Ealing, London W13 9LU`, { align: 'center' });
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

module.exports = router;
