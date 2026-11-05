'use strict';
// Document ingestion service — converts .docx / .pdf / .md / .txt to markdown text.
// Used by document-workspaces route. Returns { content_md, metadata }.

const fs   = require('fs');
const path = require('path');

async function ingestDocument(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const ext  = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);

  if (ext === '.docx') return ingestDocx(filePath, stat);
  if (ext === '.pdf')  return ingestPdf(filePath, stat);
  if (ext === '.md' || ext === '.txt') return ingestText(filePath, stat, ext);

  throw new Error(`Unsupported file format "${ext}". Supported: .docx, .pdf, .md, .txt`);
}

// ── .docx via mammoth ─────────────────────────────────────────────────────────

async function ingestDocx(filePath, stat) {
  const mammoth = require('mammoth');
  const result  = await mammoth.convertToMarkdown({ path: filePath });

  const content_md = result.value.trim();
  const warnings   = result.messages.filter(m => m.type === 'warning').map(m => m.message);

  return {
    content_md,
    metadata: {
      format:     'docx',
      word_count: countWords(content_md),
      file_size:  stat.size,
      warnings:   warnings.length ? warnings : undefined,
    },
  };
}

// ── .pdf via pdf-parse ────────────────────────────────────────────────────────

async function ingestPdf(filePath, stat) {
  const pdfParse = require('pdf-parse');
  const buffer   = fs.readFileSync(filePath);
  let data;

  try {
    data = await pdfParse(buffer);
  } catch (err) {
    throw new Error(`PDF parse failed: ${err.message}`);
  }

  // Detect image-only / scanned PDFs: no text extracted despite having pages
  if (!data.text || data.text.trim().length < 50) {
    throw new Error(
      'This PDF appears to be a scanned/image-only document. ' +
      'OCR is not supported — please export or re-save as a text-based PDF or .docx.'
    );
  }

  // Convert raw PDF text to rough markdown (preserve paragraph breaks)
  const content_md = data.text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    content_md,
    metadata: {
      format:     'pdf',
      pages:      data.numpages,
      word_count: countWords(content_md),
      file_size:  stat.size,
      pdf_info:   data.info ? {
        title:    data.info.Title   || undefined,
        author:   data.info.Author  || undefined,
        creator:  data.info.Creator || undefined,
      } : undefined,
    },
  };
}

// ── .md / .txt — read as-is ───────────────────────────────────────────────────

async function ingestText(filePath, stat, ext) {
  const content = fs.readFileSync(filePath, 'utf8');
  return {
    content_md: content.trim(),
    metadata: {
      format:     ext.replace('.', ''),
      word_count: countWords(content),
      file_size:  stat.size,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

module.exports = { ingestDocument };
