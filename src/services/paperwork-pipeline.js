'use strict';
/*
 * b269 — Paperwork store pipeline: extract → OCR if needed → summarise → propose.
 *
 * Two halves, deliberately separate so the second can fail without losing the
 * first:
 *
 *   extractText()   — gets words out of a file. Pure local tooling, no network.
 *   proposeFiling() — asks the model on the Ascent where it should be filed.
 *
 * If the Ascent is unreachable the document is STILL stored, STILL has its text,
 * and is STILL searchable; it is marked needs_ai and a person categorises it by
 * hand. It is never sent to a cloud model and it is never dropped. Scanned
 * nursery paperwork carries child and staff personal data — that rule is the
 * whole reason this file talks to one host and no other.
 *
 * ── OCR lives in the IMAGE, not on the host ────────────────────────────────
 * tesseract + poppler-utils are installed by docker/Dockerfile (b269), so OCR
 * runs wherever the image runs — including on a customer's box, where nobody
 * is going to be given a root shell to apk-add anything. There is no ffmpeg and
 * no libreoffice on this box or in the image; nothing here shells out to them.
 *
 * ── Only scans take the expensive path ─────────────────────────────────────
 * A PDF with a text layer goes through pdf-parse (already a dependency, already
 * used by src/services/document-parser.js), then pdftotext if pdf-parse choked,
 * and never touches tesseract. Under ~50 characters of text across the whole
 * document means it is a scan: that is the same threshold document-parser.js has
 * used since it shipped.
 */

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const crypto  = require('crypto');
const { execFile } = require('child_process');
const ai      = require('../lib/ai-models');

// ── Tunables ────────────────────────────────────────────────────────────────
// b333: host and model come from ai-models.js, resolved per call. The model is
// role 'heavy', never 'fast': a small model reading a scanned insurance
// schedule proposes nonsense. It moves with settings.ai_model_overrides.
const ollamaHost = () => ai.host();
const aiModel    = () => ai.model('heavy');
const AI_TIMEOUT   = parseInt(process.env.PAPERWORK_AI_TIMEOUT_MS, 10) || 180000;

// Under this many characters across the whole document → it is a scan, OCR it.
const SCAN_THRESHOLD = 50;
// OCR is minutes-per-document on a CPU detector. A 200-page manual is not worth
// 40 minutes of the queue: the first pages carry the title, the date and the
// issuer, which is what the filing decision actually needs.
const OCR_MAX_PAGES  = parseInt(process.env.PAPERWORK_OCR_MAX_PAGES, 10) || 12;
const OCR_DPI        = parseInt(process.env.PAPERWORK_OCR_DPI, 10) || 200;
const OCR_TIMEOUT    = parseInt(process.env.PAPERWORK_OCR_TIMEOUT_MS, 10) || 120000;

// How much extracted text the model is shown. Enough for the front matter of a
// long document plus a whole short one; short enough that a 120b answers inside
// the timeout.
const AI_TEXT_CHARS  = 8000;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp', '.pnm']);

// ── Small helpers ───────────────────────────────────────────────────────────

function run(cmd, args, { timeout = 60000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

/** SHA-256 of a file, streamed — the dedupe key. Toby will scan the same page twice. */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function tidy(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Is the OCR toolchain actually present? Reported by the health endpoint. */
async function ocrAvailable() {
  try {
    await run('tesseract', ['--version'], { timeout: 8000 });
    await run('pdftoppm', ['-v'], { timeout: 8000 });
    return true;
  } catch (_) {
    // pdftoppm -v exits non-zero on some builds while still printing a version.
    try { await run('tesseract', ['--version'], { timeout: 8000 }); return true; }
    catch (_e) { return false; }
  }
}

// ── OCR ─────────────────────────────────────────────────────────────────────

/** OCR a single image file. Returns '' rather than throwing on a page that fails. */
async function ocrImage(imagePath) {
  try {
    const { stdout } = await run(
      'tesseract', [imagePath, 'stdout', '-l', 'eng', '--psm', '3'],
      { timeout: OCR_TIMEOUT }
    );
    return stdout || '';
  } catch (e) {
    return '';
  }
}

/**
 * Render the first OCR_MAX_PAGES of a PDF to PNG and OCR each. Uses pdftoppm
 * (poppler-utils) — not a Node PDF rasteriser, because there isn't one in the
 * dependency list and adding a native one to an alpine image is a bad trade
 * against two apk packages.
 */
async function ocrPdf(pdfPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ocr-'));
  try {
    const prefix = path.join(dir, 'page');
    await run('pdftoppm', [
      '-r', String(OCR_DPI), '-png',
      '-f', '1', '-l', String(OCR_MAX_PAGES),
      pdfPath, prefix,
    ], { timeout: OCR_TIMEOUT * 2 });

    const pages = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
    const out = [];
    for (const p of pages) {
      const t = await ocrImage(path.join(dir, p));
      if (t.trim()) out.push(t);
    }
    return { text: tidy(out.join('\n\n')), pagesOcrd: pages.length };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── Text extraction ─────────────────────────────────────────────────────────

/**
 * Get the words out of one file.
 * @returns {Promise<{text:string, method:string, pageCount:number|null, error:string|null}>}
 *   method ∈ 'text-layer' | 'ocr' | 'docx' | 'plain' | 'none'
 */
async function extractText(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();

  try {
    if (ext === '.pdf') {
      let parsed = null;
      try {
        const pdfParse = require('pdf-parse');
        parsed = await pdfParse(fs.readFileSync(filePath));
      } catch (e) {
        // A malformed or encrypted PDF still deserves the attempts below.
        parsed = null;
      }
      let layerText = tidy(parsed && parsed.text);
      let pageCount = (parsed && parsed.numpages) || null;
      if (!pageCount) {
        // pdf-parse is where the page count normally comes from; when it threw,
        // pdfinfo still knows.
        try {
          const { stdout } = await run('pdfinfo', [filePath], { timeout: 15000 });
          const m = stdout.match(/^Pages:\s+(\d+)/m);
          if (m) pageCount = Number(m[1]);
        } catch (_) { /* a page count is nice to have, not required */ }
      }

      // pdf-parse is a very old pdf.js and it gives up on PDFs poppler reads
      // without complaint — "bad XRef entry" on perfectly ordinary output, which
      // is exactly what a scanner's "searchable PDF" tends to look like. So
      // before concluding "no text layer, OCR it", ask pdftotext. It is already
      // in the image for pdftoppm's sake, it costs milliseconds, and getting
      // this wrong means paying minutes of tesseract for a document whose words
      // were sitting right there.
      if (layerText.length < SCAN_THRESHOLD) {
        try {
          const { stdout } = await run('pdftotext', ['-layout', '-q', filePath, '-'], { timeout: 30000 });
          const t = tidy(stdout);
          if (t.length > layerText.length) layerText = t;
        } catch (_) { /* fall through to OCR */ }
      }

      if (layerText.length >= SCAN_THRESHOLD) {
        return { text: layerText, method: 'text-layer', pageCount, error: null };
      }
      // Under ~50 chars across the whole document → it is a scan. Only now do we
      // pay for tesseract.
      const { text } = await ocrPdf(filePath);
      if (text.length) return { text, method: 'ocr', pageCount, error: null };
      return {
        text: layerText, method: layerText ? 'text-layer' : 'none', pageCount,
        error: 'No text layer and OCR returned nothing',
      };
    }

    if (IMAGE_EXT.has(ext)) {
      const text = tidy(await ocrImage(filePath));
      if (text.length) return { text, method: 'ocr', pageCount: 1, error: null };
      return { text: '', method: 'none', pageCount: 1, error: 'OCR returned nothing' };
    }

    if (ext === '.heic' || ext === '.heif') {
      // tesseract's leptonica build has no HEIC decoder and there is no ffmpeg or
      // libreoffice here to convert with. Store it, say so honestly, let a person
      // title it. Do NOT pretend it was read.
      return { text: '', method: 'none', pageCount: 1,
        error: 'HEIC is not readable by the on-box OCR — file it by hand, or re-export as JPG/PDF' };
    }

    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const r = await mammoth.convertToMarkdown({ path: filePath });
      return { text: tidy(r.value), method: 'docx', pageCount: null, error: null };
    }

    if (ext === '.txt' || ext === '.md' || ext === '.csv') {
      return { text: tidy(fs.readFileSync(filePath, 'utf8')), method: 'plain', pageCount: null, error: null };
    }

    return { text: '', method: 'none', pageCount: null, error: `No text extractor for "${ext}"` };
  } catch (e) {
    return { text: '', method: 'none', pageCount: null, error: e.message };
  }
}

// ── The model (Ascent only) ─────────────────────────────────────────────────
// Same shape as src/routes/sen.js aiCall(): /api/generate, stream:false,
// think:false, <think> stripped. Ollama-only by construction — there is no
// provider switch here and there must never be one.

async function aiCall(prompt, systemPrompt, maxTokens) {
  const r = await fetch(`${ollamaHost()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: aiModel(), system: systemPrompt || '', prompt,
      stream: false, think: false,
      options: ai.options({ num_predict: maxTokens || 700, temperature: 0.2 }, 'long'),
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  const data = await r.json();
  const text = (data.response || '').trim();
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function parseJSON(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in AI response');
  return JSON.parse(m[0]);
}

const FILING_SYSTEM = [
  'You are a filing clerk for an English early-years nursery.',
  'You read scanned paperwork and say where it belongs.',
  'You answer with JSON only — no prose, no markdown fences.',
  'You never invent a date: if the document does not state one, return null.',
].join(' ');

/**
 * Propose a category, sub-folder, title, document date, one-line summary and
 * tags for a document. A PROPOSAL — nothing is filed until a person accepts it.
 *
 * @param {object} opts
 * @param {string} opts.text        extracted text (truncated here)
 * @param {string} opts.filename    original filename — often the best clue there is
 * @param {Array}  opts.categories  [{key,label,description}] the fixed top level
 * @param {Array}  opts.pinned      [{category,subfolder}] the statutory folders
 */
async function proposeFiling({ text, filename, categories, pinned }) {
  const catLines = categories
    .map(c => `- ${c.key}: ${c.label}${c.description ? ' — ' + c.description : ''}`)
    .join('\n');
  const pinnedLines = (pinned || [])
    .map(p => `- ${p.category} / ${p.subfolder}`)
    .join('\n');

  const body = String(text || '').slice(0, AI_TEXT_CHARS);

  const prompt = [
    `FILE NAME: ${filename}`,
    '',
    'CATEGORIES (choose exactly one key from this list — no other value is valid):',
    catLines,
    '',
    pinnedLines ? 'SUB-FOLDERS THAT ALREADY EXIST (prefer one of these if it fits):\n' + pinnedLines + '\n' : '',
    'DOCUMENT TEXT:',
    '"""',
    body || '(no text could be extracted from this file)',
    '"""',
    '',
    'Reply with JSON exactly of this shape:',
    '{',
    '  "category": "<one key from the list above>",',
    '  "subfolder": "<short sub-folder name, or null>",',
    '  "title": "<a short human title, max 90 chars>",',
    '  "document_date": "<YYYY-MM-DD the DOCUMENT is dated, or null>",',
    '  "summary": "<one or two sentences: what this document is>",',
    '  "tags": ["<up to 5 short lowercase tags>"],',
    '  "is_receipt": <true if this is a receipt, invoice or till slip>,',
    '  "confidence": <0.0 to 1.0>',
    '}',
  ].filter(Boolean).join('\n');

  const raw = await aiCall(prompt, FILING_SYSTEM, 600);
  const out = parseJSON(raw);

  // Never let the model invent a category key. An unknown value means "the human
  // decides", not "file it somewhere plausible".
  const valid = new Set(categories.map(c => c.key));
  if (!valid.has(out.category)) out.category = null;

  if (out.document_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(out.document_date))) out.document_date = null;
  if (!Array.isArray(out.tags)) out.tags = [];
  out.tags = out.tags.map(t => String(t).toLowerCase().trim().slice(0, 40)).filter(Boolean).slice(0, 5);
  if (out.title) out.title = String(out.title).trim().slice(0, 200);
  if (out.subfolder) out.subfolder = String(out.subfolder).trim().slice(0, 120);
  if (out.summary) out.summary = String(out.summary).trim().slice(0, 1000);
  out.model = aiModel();
  return out;
}

const RECEIPT_SYSTEM = [
  'You read UK receipts and invoices and pull out the figures.',
  'You answer with JSON only.',
  'Amounts are numbers, not strings, and never carry a currency symbol.',
  'If a field is not printed on the receipt, return null. Never estimate a total or a VAT figure.',
].join(' ');

/**
 * Pull supplier / date / total / VAT off a receipt. Whatever comes back is kept
 * verbatim in paperwork_receipts.ai_raw next to the parsed columns AND the raw
 * OCR text stays on the document, so a wrong number can always be checked
 * against the original scan.
 */
async function extractReceipt({ text, filename }) {
  const prompt = [
    `FILE NAME: ${filename}`,
    '',
    'RECEIPT TEXT:',
    '"""',
    String(text || '').slice(0, AI_TEXT_CHARS),
    '"""',
    '',
    'Reply with JSON exactly of this shape:',
    '{',
    '  "supplier": "<trading name of who was paid, or null>",',
    '  "receipt_date": "<YYYY-MM-DD, or null>",',
    '  "total_amount": <number, the gross total paid, or null>,',
    '  "vat_amount": <number, the VAT element, or null>,',
    '  "currency": "<ISO code, GBP unless stated otherwise>",',
    '  "reference": "<invoice/receipt number, or null>"',
    '}',
  ].join('\n');

  const out = parseJSON(await aiCall(prompt, RECEIPT_SYSTEM, 400));

  const num = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  return {
    supplier:     out.supplier ? String(out.supplier).trim().slice(0, 200) : null,
    receipt_date: /^\d{4}-\d{2}-\d{2}$/.test(String(out.receipt_date || '')) ? out.receipt_date : null,
    total_amount: num(out.total_amount),
    vat_amount:   num(out.vat_amount),
    currency:     (out.currency ? String(out.currency).toUpperCase().slice(0, 3) : 'GBP'),
    reference:    out.reference ? String(out.reference).trim().slice(0, 100) : null,
    raw:          out,
    model:        aiModel(),
  };
}

module.exports = {
  sha256File,
  extractText,
  ocrAvailable,
  proposeFiling,
  extractReceipt,
  aiModel,
  ollamaHost,
  SCAN_THRESHOLD,
};
