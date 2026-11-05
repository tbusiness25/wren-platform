'use strict';
/**
 * report-pdf.js — b238 (2026-08-27)
 *
 * Spec: wren-docs/ey-portal-restructure-2026-08-27.md §9
 *   "Reports that Wren generates must be generated as PDFs."
 *   "Nothing kept on the website. No report content living as a web page."
 *
 * A report leaves Wren as a document, not as a page. This renders one
 * ladn.reports row to A4 PDF and hands back a buffer; src/routes/reports.js
 * writes it to /app/uploads/reports and streams it. The web UI links to the
 * file — it never renders the report body into HTML again.
 *
 * pdfkit, the same stack every other Wren PDF uses (invoice-pdf.js,
 * owner-digest-pdf.js, keepsake.js) — no new dependency, same look.
 */

const PDFDoc = require('pdfkit');

const INK   = '#0f172a';
const MUTED = '#64748b';
const RULE  = '#e2e8f0';
const BRAND = '#4a9abf';

const M = 50;                     // page margin
const PAGE_W = 595.28;            // A4 portrait
const CONTENT_W = PAGE_W - M * 2;

/**
 * pdfkit's built-in fonts are WinAnsi-encoded: £ and en-dashes are fine, emoji
 * and arrows come out as mojibake. Same rule as invoice-pdf.js — spell out what
 * we can, drop what we cannot. An observation title with a 🎨 in it is common.
 */
const UNRENDERABLE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}]/gu;

function safe(v) {
  return String(v == null ? '' : v)
    .replace(/×/g, 'x')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(UNRENDERABLE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function longDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function titleCase(v) {
  return safe(v).replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * reports.content is jsonb and has grown several shapes over the years:
 *   { text: "…" }                     — the AI generator (routes/reports.js)
 *   { sections: [{ heading, body }] }  — the summative/transition builder
 *   "a bare string"                    — older imports
 * Flatten all of them to [{heading, body}] rather than teaching the renderer
 * three layouts.
 */
function sectionsFrom(content) {
  if (!content) return [];
  if (typeof content === 'string') return [{ heading: null, body: content }];

  if (Array.isArray(content.sections) && content.sections.length) {
    return content.sections
      .map(s => ({
        heading: s && (s.heading || s.title || s.label) || null,
        body: s && (s.body || s.text || s.content) || '',
      }))
      .filter(s => safe(s.body) || safe(s.heading));
  }

  if (typeof content.text === 'string' && content.text.trim()) {
    return [{ heading: null, body: content.text }];
  }

  // Last resort: any string-valued key becomes its own section, so an unknown
  // shape still prints something readable instead of an empty page.
  const out = [];
  for (const [k, v] of Object.entries(content)) {
    if (typeof v === 'string' && v.trim()) out.push({ heading: titleCase(k), body: v });
  }
  return out;
}

function header(doc, report, setting) {
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(16)
    .text(safe(setting.name || 'Your Nursery'), M, M);
  if (setting.address) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(9)
      .text(safe(setting.address), M, doc.y + 1);
  }
  doc.moveDown(1);

  // b243: report_type is a database key, and titleCase() of it is what a parent
  // would read at the top of the page — "Two Year Check" for a document the EYFS
  // calls the Progress Check at Age Two. A caller may pass display_title to print
  // the real name instead. Existing callers pass nothing and are unaffected.
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20)
    .text(safe(report.display_title) || titleCase(report.report_type || 'Report'), M, doc.y);

  const meta = [
    report.child_name ? safe(report.child_name) : null,
    report.room_name ? safe(report.room_name) : null,
    longDate(report.created_at),
  ].filter(Boolean).join('  ·  ');

  doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(meta, M, doc.y + 3);

  doc.moveTo(M, doc.y + 10).lineTo(PAGE_W - M, doc.y + 10)
    .strokeColor(RULE).lineWidth(1).stroke();
  doc.y += 22;
}

function body(doc, sections) {
  if (!sections.length) {
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(11)
      .text('This report has no written content yet.', M, doc.y, { width: CONTENT_W });
    return;
  }
  for (const s of sections) {
    if (doc.y > FOOTER_RULE_Y - 60) doc.addPage();
    if (s.heading) {
      doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(12)
        .text(safe(s.heading), M, doc.y, { width: CONTENT_W });
      doc.y += 3;
    }
    const text = safe(s.body);
    if (text) {
      doc.fillColor(INK).font('Helvetica').fontSize(11)
        .text(text, M, doc.y, { width: CONTENT_W, align: 'left', lineGap: 3 });
      // pdfkit pages automatically mid-paragraph, which is right — but the new
      // page's cursor must clear the header band, not start under it.
    }
    doc.y += 14;
  }
}

/**
 * A4 is 841.89pt tall, so with a 50pt margin the last line pdfkit will accept
 * without starting a NEW PAGE ends at 791.89. The first cut of this drew the
 * footer at y=800: every report came out two pages, the second one blank apart
 * from the footer. Keep the whole strip inside the printable area, and pass
 * lineBreak:false so a long setting name wraps into nothing rather than paging.
 */
const FOOTER_RULE_Y = 762;

function footer(doc, report, setting) {
  doc.moveTo(M, FOOTER_RULE_Y).lineTo(PAGE_W - M, FOOTER_RULE_Y)
    .strokeColor(RULE).lineWidth(1).stroke();
  const bits = [
    safe(setting.name || 'Your Nursery'),
    report.author_name ? 'Written by ' + safe(report.author_name) : null,
    report.ai_generated ? 'AI-assisted draft, reviewed by staff' : null,
    'Report #' + report.id,
  ].filter(Boolean);
  doc.fillColor(MUTED).font('Helvetica').fontSize(8)
    .text(bits.join('  ·  '), M, FOOTER_RULE_Y + 7, {
      width: CONTENT_W, lineBreak: false, ellipsis: true,
    });
}

/**
 * Render one report to a PDF buffer.
 * @param {object} report  a ladn.reports row, plus optional child_name / room_name / author_name
 * @param {object} setting { name, address }
 * @returns {Promise<Buffer>}
 */
function renderReportPdf(report, setting) {
  const s = setting || {};
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDoc({ size: 'A4', margin: M, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Same display_title override as the printed heading, so the document's
      // internal metadata (what a PDF reader shows in its title bar) does not
      // disagree with the words on page one.
      doc.info.Title = `${safe(report.display_title) || titleCase(report.report_type || 'Report')}${report.child_name ? ' — ' + safe(report.child_name) : ''}`;
      doc.info.Author = safe(s.name || 'Your Nursery');

      header(doc, report, s);
      body(doc, sectionsFrom(report.content));

      // Footer on every page, drawn once the page count is known.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        footer(doc, report, s);
      }

      doc.end();
    } catch (e) { reject(e); }
  });
}

/** A filename a parent can recognise in their downloads folder. */
function reportFilename(report) {
  const child = safe(report.child_name || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const type = safe(report.display_title || report.report_type || 'report')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // pg hands back timestamptz as a JS Date, so String(...).slice(0,10) produced
  // "Fri Aug 28" — a weekday and a space in the filename of a document a parent
  // saves for a health appointment. Format it properly, from LOCAL getters (a
  // UTC conversion moves a late-evening BST report to the previous day).
  const d = report.created_at ? new Date(report.created_at) : null;
  const date = (d && !isNaN(d))
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : 'undated';
  return [type || 'report', child, date].filter(Boolean).join('-').toLowerCase() + '.pdf';
}

module.exports = { renderReportPdf, reportFilename, sectionsFrom, safe };
