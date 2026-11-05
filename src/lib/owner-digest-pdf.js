'use strict';
/**
 * owner-digest-pdf.js — b185 (2026-08-19)
 *
 * Renders the owner monthly digest (src/lib/owner-digest.js) to:
 *   • a PDF, via pdfkit — the same stack every other Wren report PDF uses
 *     (src/routes/data-governance.js, parent-reports.js, rota.js, keepsake.js);
 *   • an HTML + plain-text email body carrying the headline numbers, so the
 *     email is useful on a phone without opening the attachment.
 *
 * GDPR: it renders whatever owner-digest.js produced and adds nothing. That
 * module is where the counts-only rule is enforced.
 */

const fs = require('fs');
const path = require('path');
const PDFDoc = require('pdfkit');

const INK      = '#0f172a';
const MUTED    = '#64748b';
const RULE     = '#e2e8f0';
const BRAND    = '#4a9abf';
const GOOD     = '#15803d';
const BAD      = '#b91c1c';
const NEUTRAL  = '#475569';

const { isGood } = require(path.join(__dirname, 'owner-digest'));

/**
 * pdfkit's built-in fonts are WinAnsi-encoded: emoji, arrows and geometric shapes
 * come out as mojibake ("\u00d8<\u00df\u00e0" for a house, "%\u00b2" for an up-arrow).
 * Everything written to the PDF goes through here \u2014 known symbols are spelled out,
 * the rest are dropped rather than drawn as noise. The HTML email keeps the
 * originals; mail clients render Unicode perfectly well.
 */
const GLYPH_MAP = { '\u25B2': 'up', '\u25BC': 'down', '\u2248': 'about ', '\u2192': ' > ', '\uFE0F': '' };
const UNRENDERABLE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}]/gu;

function pdfSafe(v) {
  let s = String(v == null ? '' : v);
  for (const k of Object.keys(GLYPH_MAP)) s = s.split(k).join(GLYPH_MAP[k]);
  return s.replace(UNRENDERABLE, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/** A direction-of-travel marker drawn as vector art, so no font has to have it. */
function drawTrend(doc, x, y, direction, colour) {
  if (!direction) { doc.fillColor(colour).fontSize(9).font('Helvetica').text('-', x, y, { lineBreak: false }); return; }
  doc.save().fillColor(colour);
  if (direction === 'up')        doc.moveTo(x, y + 7).lineTo(x + 4.5, y).lineTo(x + 9, y + 7).fill();
  else if (direction === 'down') doc.moveTo(x, y).lineTo(x + 9, y).lineTo(x + 4.5, y + 7).fill();
  else                           doc.rect(x, y + 3, 9, 2).fill();
  doc.restore();
}

function trendColour(m) {
  const g = isGood(m);
  if (g === true)  return GOOD;
  if (g === false) return BAD;
  return NEUTRAL;
}

/* ══════════ PDF ═══════════════════════════════════════════════════════════ */

/**
 * @param {object} digest  from buildOwnerDigest()
 * @param {string} outPath absolute path to write
 * @returns {Promise<{path:string, bytes:number}>}
 */
function renderDigestPdf(digest, outPath) {
  return new Promise((resolve, reject) => {
    try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); } catch (_) { /* exists */ }

    const doc = new PDFDoc({ size: 'A4', margins: { top: 56, bottom: 60, left: 56, right: 56 },
                             autoFirstPage: false, info: {
                               Title: `Owner monthly digest — ${digest.month_label}`,
                               Author: 'Wren', Subject: digest.setting_name } });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    const W = () => doc.page.width - 112;   // usable width inside the margins
    const footer = () => {
      doc.fontSize(7.5).font('Helvetica').fillColor(MUTED).text(
        pdfSafe(`${digest.setting_name} \u00b7 Owner monthly digest \u00b7 ${digest.month_label} \u00b7 `
        + `generated ${digest.generated_at.slice(0, 10)} \u00b7 aggregate figures only \u2014 no child or parent is named`),
        56, doc.page.height - 46, { align: 'center', width: W() });
    };
    const need = h => { if (doc.y > doc.page.height - 60 - h) { footer(); doc.addPage(); doc.y = 56; } };

    /* ── cover ─────────────────────────────────────────────────────────── */
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 185).fill('#0f172a');
    doc.fillColor(BRAND).fontSize(26).font('Helvetica-Bold').text('Wren', 56, 46);
    doc.fillColor('#f1f5f9').fontSize(21).font('Helvetica-Bold')
       .text('Owner monthly digest', 56, 82, { width: W() });
    doc.fillColor('#e2e8f0').fontSize(15).font('Helvetica').text(pdfSafe(digest.month_label), 56, 112);
    doc.fillColor('#94a3b8').fontSize(10)
       .text(pdfSafe(`${digest.setting_name} \u00b7 compared with ${digest.prev_month_label}`), 56, 136)
       .text(pdfSafe(`${digest.period.start} to ${digest.period.end} \u00b7 ${digest.period.weekdays} weekdays`), 56, 152);

    doc.y = 210;
    doc.fillColor(INK).fontSize(13).font('Helvetica-Bold').text('At a glance', 56, doc.y);
    doc.moveDown(0.4);

    // headline grid — 2 columns of cards
    const cardW = (W() - 14) / 2, cardH = 56;
    let cx = 56, cy = doc.y;
    for (const h of digest.headlines) {
      if (cy > doc.page.height - 120) break;
      doc.roundedRect(cx, cy, cardW, cardH, 5).fill('#f8fafc');
      doc.fillColor(MUTED).fontSize(7.5).font('Helvetica')
         .text(pdfSafe(`${h.section.toUpperCase()} \u2014 ${h.label}`), cx + 10, cy + 8, { width: cardW - 20 });
      doc.fillColor(h.value == null ? MUTED : INK).fontSize(16).font('Helvetica-Bold')
         .text(pdfSafe(h.display), cx + 10, cy + 22, { width: cardW - 20, lineBreak: false });
      const col = trendColour(h);
      if (h.direction) drawTrend(doc, cx + 10, cy + 44, h.direction, col);
      const trend = h.direction
        ? `${h.prev_display} in ${digest.prev_month_label.split(' ')[0]}`
        : (h.prev == null ? 'no comparison available' : '');
      doc.fillColor(col).fontSize(7.5).font('Helvetica')
         .text(pdfSafe(trend), cx + (h.direction ? 23 : 10), cy + 43, { width: cardW - 33, lineBreak: false });
      if (cx === 56) { cx = 56 + cardW + 14; } else { cx = 56; cy += cardH + 8; }
    }
    doc.y = (cx === 56 ? cy : cy + cardH + 8) + 10;

    need(70);
    doc.roundedRect(56, doc.y, W(), 54, 5).fill('#e0f2fe');
    doc.fillColor('#0c4a6e').fontSize(8.5).font('Helvetica').text(
      'Every figure below is read from the records this setting actually holds. Where a source has '
      + 'never been used, the figure reads "no data" rather than 0 — a blank and a measured zero are '
      + 'not the same thing and are never merged. Safeguarding and incident figures are COUNTS ONLY: '
      + 'no child is named anywhere in this document.',
      68, doc.y + 9, { width: W() - 24 });
    doc.y += 66;

    /* ── sections ───────────────────────────────────────────────────────── */
    for (const sec of digest.sections) {
      footer(); doc.addPage(); doc.y = 56;

      doc.fillColor(INK).fontSize(17).font('Helvetica-Bold')
         .text(pdfSafe(sec.title), 56, doc.y);
      doc.moveDown(0.2);
      doc.moveTo(56, doc.y).lineTo(doc.page.width - 56, doc.y).lineWidth(1).stroke(RULE);
      doc.moveDown(0.6);

      if (sec.no_data) {
        doc.fillColor(BAD).fontSize(10).font('Helvetica-Bold')
           .text('No data for this section this month.', 56, doc.y);
        doc.moveDown(0.4);
      }

      // metrics table: label | this month | last month | move
      if (sec.metrics.length) {
        const colX = [56, 56 + W() * 0.50, 56 + W() * 0.70, 56 + W() * 0.88];
        doc.fillColor(MUTED).fontSize(7.5).font('Helvetica-Bold')
           .text('MEASURE', colX[0], doc.y, { width: W() * 0.48, continued: false });
        const hy = doc.y - 9;
        doc.text(pdfSafe(digest.month_label), colX[1], hy, { width: W() * 0.19 });
        doc.text(pdfSafe(digest.prev_month_label), colX[2], hy, { width: W() * 0.17 });
        doc.text('MOVE', colX[3], hy, { width: W() * 0.11 });
        doc.moveDown(0.3);
        doc.moveTo(56, doc.y).lineTo(doc.page.width - 56, doc.y).lineWidth(0.5).stroke(RULE);
        doc.moveDown(0.4);

        for (const m of sec.metrics) {
          need(34);
          const y0 = doc.y;
          doc.fillColor(INK).fontSize(9).font('Helvetica').text(pdfSafe(m.label), colX[0], y0, { width: W() * 0.47 });
          const labelBottom = doc.y;
          doc.fillColor(m.value == null ? MUTED : INK).fontSize(9.5).font('Helvetica-Bold')
             .text(pdfSafe(m.display), colX[1], y0, { width: W() * 0.19, lineBreak: false });
          doc.fillColor(MUTED).fontSize(9).font('Helvetica')
             .text(pdfSafe(m.prev_display), colX[2], y0, { width: W() * 0.17, lineBreak: false });
          drawTrend(doc, colX[3], y0 + 2, m.direction, trendColour(m));
          doc.y = Math.max(labelBottom, y0 + 12);
          if (m.note) {
            doc.fillColor(MUTED).fontSize(7.5).font('Helvetica-Oblique')
               .text(pdfSafe(m.note), colX[0], doc.y, { width: W() * 0.47 });
          }
          doc.moveDown(0.45);
        }
        doc.moveDown(0.3);
      }

      // tables
      for (const t of sec.tables) {
        need(80);
        doc.fillColor(INK).fontSize(10.5).font('Helvetica-Bold').text(pdfSafe(t.title), 56, doc.y);
        doc.moveDown(0.3);
        const n = t.columns.length;
        const colW = W() / n;
        doc.fillColor(MUTED).fontSize(7.5).font('Helvetica-Bold');
        const hy = doc.y;
        t.columns.forEach((c, i) => doc.text(pdfSafe(String(c).toUpperCase()), 56 + i * colW, hy,
          { width: colW - 4, lineBreak: false }));
        doc.y = hy + 11;
        doc.moveTo(56, doc.y).lineTo(doc.page.width - 56, doc.y).lineWidth(0.5).stroke(RULE);
        doc.y += 3;
        for (const row of t.rows) {
          need(20);
          const ry = doc.y;
          doc.fillColor(INK).fontSize(8.5).font('Helvetica');
          row.forEach((cell, i) => doc.text(pdfSafe(cell), 56 + i * colW, ry,
            { width: colW - 4, lineBreak: false }));
          doc.y = ry + 13;
        }
        if (t.note) {
          doc.moveDown(0.2);
          doc.fillColor(MUTED).fontSize(7.5).font('Helvetica-Oblique').text(pdfSafe(t.note), 56, doc.y, { width: W() });
        }
        doc.moveDown(0.7);
      }

      // bullets
      if (sec.bullets.length) {
        need(30);
        for (const b of sec.bullets) {
          need(20);
          doc.fillColor(INK).fontSize(9).font('Helvetica').text(pdfSafe(`\u2022  ${b}`), 56, doc.y, { width: W() });
          doc.moveDown(0.25);
        }
        doc.moveDown(0.3);
      }

      // honesty notes
      if (sec.notes.length) {
        need(28 + sec.notes.length * 12);
        const boxTop = doc.y;
        doc.fillColor(MUTED).fontSize(7.5).font('Helvetica-Bold').text('ABOUT THESE FIGURES', 68, boxTop + 8, { width: W() - 24 });
        let ny = doc.y + 2;
        for (const nte of sec.notes) {
          doc.fillColor(NEUTRAL).fontSize(7.5).font('Helvetica').text(pdfSafe(`\u2014 ${nte}`), 68, ny, { width: W() - 24 });
          ny = doc.y + 2;
        }
        const boxH = (ny - boxTop) + 6;
        doc.save().roundedRect(56, boxTop, W(), boxH, 4).lineWidth(0.5).stroke(RULE).restore();
        doc.y = boxTop + boxH + 8;
      }

      if (sec.link) {
        doc.fillColor(BRAND).fontSize(8).font('Helvetica').text(pdfSafe(`Roost: ${sec.link}`), 56, doc.y, { width: W() });
      }
    }

    footer();
    doc.end();

    stream.on('finish', () => {
      let bytes = 0;
      try { bytes = fs.statSync(outPath).size; } catch (_) { /* reported as 0 */ }
      resolve({ path: outPath, bytes });
    });
    stream.on('error', reject);
    doc.on('error', reject);
  });
}

/* ══════════ EMAIL BODY ════════════════════════════════════════════════════ */

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Headline numbers in the body so the email is useful on a phone.
 * @returns {{subject:string, html:string, text:string}}
 */
function renderDigestEmail(digest, opts = {}) {
  const base = opts.baseUrl || 'https://admin.example-nursery.co.uk';
  const subject = `Wren monthly digest — ${digest.month_label}`;

  const cards = digest.headlines.map(h => {
    const col = h.value == null ? MUTED : trendColour(h);
    const trend = h.direction
      ? `${h.arrow} ${esc(h.prev_display)} in ${esc(digest.prev_month_label)}`
      : (h.prev == null ? 'no comparison' : '');
    return `<td style="padding:0 8px 12px 0;width:50%;vertical-align:top">
      <div style="border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;background:#f8fafc">
        <div style="font:600 10px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#64748b;text-transform:uppercase;letter-spacing:.4px">${esc(h.section)} — ${esc(h.label)}</div>
        <div style="font:700 20px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${h.value == null ? MUTED : INK};margin-top:3px">${esc(h.display)}</div>
        <div style="font:400 11px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${col};margin-top:2px">${trend}</div>
      </div></td>`;
  });
  const rows = [];
  for (let i = 0; i < cards.length; i += 2) {
    rows.push(`<tr>${cards[i]}${cards[i + 1] || '<td style="width:50%"></td>'}</tr>`);
  }

  const secLines = digest.sections.map(s => {
    const state = s.no_data ? '<span style="color:#b91c1c">no data this month</span>'
      : `${s.metrics.filter(m => m.value != null).length} figure(s)`;
    return `<li style="margin:2px 0">${esc(s.icon || '')} <strong>${esc(s.title)}</strong> — ${state}</li>`;
  }).join('');

  const html = `<div style="font:400 14px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;max-width:640px">
  <div style="background:#0f172a;color:#f1f5f9;padding:18px 20px;border-radius:8px 8px 0 0">
    <div style="font:700 15px/1.2 inherit;color:${BRAND}">Wren</div>
    <div style="font:700 20px/1.3 inherit;margin-top:4px">Owner monthly digest — ${esc(digest.month_label)}</div>
    <div style="font:400 12px/1.4 inherit;color:#94a3b8;margin-top:4px">${esc(digest.setting_name)} · compared with ${esc(digest.prev_month_label)} · ${esc(digest.period.start)} to ${esc(digest.period.end)}</div>
  </div>
  <div style="border:1px solid #e2e8f0;border-top:0;border-radius:0 0 8px 8px;padding:18px 20px">
    <p style="margin:0 0 12px">The full report is attached as a PDF. The headline numbers are here so you don't have to open it.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${rows.join('')}</table>
    <p style="margin:14px 0 6px;font-weight:600">What's in the attachment</p>
    <ul style="margin:0 0 14px;padding-left:20px;font-size:13px">${secLines}</ul>
    <p style="margin:0 0 14px"><a href="${esc(base)}/report-card.html" style="color:${BRAND}">Open Roost</a></p>
    <p style="margin:0;font-size:11px;color:#64748b">Aggregate figures only. Accident and safeguarding numbers are counts —
    no child or parent is named in this email or the attachment, and no detail of any concern is included.
    "No data" means the record was never made; it is never shown as a zero.</p>
  </div>
</div>`;

  const text = [
    `WREN — OWNER MONTHLY DIGEST — ${digest.month_label}`,
    `${digest.setting_name} · compared with ${digest.prev_month_label}`,
    `${digest.period.start} to ${digest.period.end}`,
    '',
    'AT A GLANCE',
    ...digest.headlines.map(h => `  ${h.section} — ${h.label}: ${h.display}`
      + (h.direction ? `  (${h.arrow} ${h.prev_display} in ${digest.prev_month_label})` : '')),
    '',
    'SECTIONS',
    ...digest.sections.map(s => `  ${s.title}: ${s.no_data ? 'NO DATA this month'
      : `${s.metrics.filter(m => m.value != null).length} figure(s)`}`),
    '',
    'Full report attached as a PDF.',
    '',
    'Aggregate figures only. Accident and safeguarding numbers are counts — no child or',
    'parent is named, and no detail of any concern is included. "No data" means the record',
    'was never made; it is never shown as a zero.',
  ].join('\n');

  return { subject, html, text };
}

module.exports = { renderDigestPdf, renderDigestEmail, pdfSafe };
