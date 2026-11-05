'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * observation-review-pdf.js — b536 (2026-10-29)
 *
 * The reviewer's two exports, one renderer: the NORMAL PDF (names, dates,
 * practitioners, optional photo thumbnails) and the ANONYMISED one (none of
 * those). Both come out of renderObservationPdf() so the layout cannot drift
 * between them, and the anonymised branch is decided from ONE flag that the
 * route owns — a client cannot ask for an anonymised document and get a named
 * one or the other way round.
 *
 * pdfkit, not Chromium: the app image is node:20-alpine (musl) and puppeteer's
 * bundled Chrome is a glibc binary, so it cannot run inside wren-ladn — see
 * reference_puppeteer_cannot_run_in_wren_image. DejaVu is registered rather
 * than using pdfkit's WinAnsi built-ins, exactly as plan-pdf.js does, so curly
 * quotes and en-dashes in a practitioner's prose come out as themselves.
 *
 * ── THE FOOTER TRAP ──────────────────────────────────────────────────────────
 * A running footer sits BELOW doc.page.margins.bottom, and pdfkit auto-paginates
 * whenever text is drawn past that margin — so switchToPage() + text(footer)
 * silently appends one blank page per footer. The margin is dropped to 0 for the
 * duration of the footer pass and restored afterwards. See
 * reference_pdfkit_footer_adds_blank_pages.
 *
 * ── PHOTOS ───────────────────────────────────────────────────────────────────
 * Thumbnails are read from the filesystem, never fetched over HTTP: an export
 * running inside the container has no session to authenticate /api/observations/
 * photo/... with, and node's fetch would not carry the Host header the portal
 * dispatch needs anyway. Both upload trees are searched (the multer target and
 * the host-writable one) because they are different directories, not two names
 * for one — see reference_two_observation_upload_trees. A file that is missing
 * or that pdfkit refuses is SKIPPED and counted, and the count is printed on the
 * cover, so a thin export says so rather than looking complete.
 *
 * An ANONYMISED export embeds no image under any circumstances. `photos` is not
 * consulted on that branch.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const PDFDoc = require('pdfkit');
const R = require('./observation-review-redact');

// ── page geometry (A4 portrait) ─────────────────────────────────────────────
const PW = 595.28, PH = 841.89;
const M = 40;
const CW = PW - M * 2;
const FOOT_H = 26;

// ── palette ─────────────────────────────────────────────────────────────────
// A PDF is not a themed web page: it has no CSS custom properties and the file
// is read on paper and in other people's viewers, so these are print inks, not
// UI tokens. They are the same inks plan-pdf.js and report-pdf.js already use,
// so the three documents look like one setting's paperwork.
const INK   = '#26332b';
const BODY  = '#3f4c44';
const MUTED = '#6f8177';
const LINE  = '#d7e2da';
const BRAND = '#4a9abf';
const ACCENT = '#e07820';
const CHIPBG = '#eef3f6';

// ── fonts ───────────────────────────────────────────────────────────────────
const DEJAVU_DIRS = ['/usr/share/fonts/dejavu', '/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/TTF'];
function findFont(file) {
  for (const d of DEJAVU_DIRS) {
    const p = path.join(d, file);
    try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* next */ }
  }
  return null;
}
const FONTS = { sans: findFont('DejaVuSans.ttf'), sansB: findFont('DejaVuSans-Bold.ttf'), sansI: findFont('DejaVuSans-Oblique.ttf') };
const HAS_TTF = !!(FONTS.sans && FONTS.sansB);
function registerFonts(doc) {
  if (HAS_TTF) {
    doc.registerFont('sans', FONTS.sans);
    doc.registerFont('sansB', FONTS.sansB);
    doc.registerFont('sansI', FONTS.sansI || FONTS.sans);
    return;
  }
  doc.registerFont('sans', 'Helvetica');
  doc.registerFont('sansB', 'Helvetica-Bold');
  doc.registerFont('sansI', 'Helvetica-Oblique');
}

/* Colour emoji exist in no embeddable TTF, and a practitioner pasting a 🎨 into
 * an observation is routine. Without DejaVu, fold back to WinAnsi as well. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu;
const NON_WINANSI = /[\u{0100}-\u{FFFF}]/gu;
function safe(v) {
  let s = String(v == null ? '' : v).replace(EMOJI, '');
  if (!HAS_TTF) {
    s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
         .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/×/g, 'x')
         .replace(NON_WINANSI, '');
  }
  return s;
}

// ── photo resolution ────────────────────────────────────────────────────────
/* The two trees, in the order observations.js's own resolveObsFile() searches
 * them. Re-implemented rather than imported because src/routes/observations.js
 * does not export it and this build must not edit that file (dev has an
 * unshipped staff-app change in it). */
function obsReadDirs() {
  const dataDir = process.env.DATA_DIR || null;
  return [
    dataDir ? path.join(dataDir, 'uploads', 'observations') : null,
    dataDir ? path.join(dataDir, '..', 'observations') : null,
    '/app/uploads/observations',
    path.join(__dirname, '../../data/ladn/uploads/observations'),
    path.join(__dirname, '../../data/ladn-dev/uploads/observations'),
  ].filter(Boolean).filter((d, i, a) => a.indexOf(d) === i);
}
const IMG_EXT = /\.(jpe?g|png)$/i;

/** '/api/observations/photo/obs_x.jpg' → an absolute path that exists, or null. */
function resolvePhoto(url) {
  const base = path.basename(String(url || '').split('?')[0]);
  // Path traversal cannot survive basename(), and anything that is not a still
  // image pdfkit cannot embed anyway (a .webm clip is in this column too).
  if (!base || base.includes('/') || !IMG_EXT.test(base)) return null;
  for (const d of obsReadDirs()) {
    const p = path.join(d, base);
    if (!p.startsWith(d)) continue;
    try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* next */ }
  }
  return null;
}

// ── small drawing helpers ───────────────────────────────────────────────────
function hr(doc, y, colour) {
  doc.save().moveTo(M, y).lineTo(PW - M, y).lineWidth(0.7).strokeColor(colour || LINE).stroke().restore();
}
function chips(doc, items, x, y, maxW) {
  let cx = x, cy = y;
  doc.font('sans').fontSize(7.6);
  for (const t of items) {
    const label = safe(t);
    const w = doc.widthOfString(label) + 12;
    if (cx + w > x + maxW) { cx = x; cy += 15; }
    doc.save().roundedRect(cx, cy - 1.5, w, 13, 6.5).fill(CHIPBG).restore();
    doc.fillColor(BODY).text(label, cx + 6, cy + 1, { lineBreak: false, width: w });
    cx += w + 4;
  }
  return cy + 16;
}
/* characterSpacing is a TEXT OPTION in this pdfkit, not a chainable setter:
 * doc.font(..).fontSize(..).fillColor(..).characterSpacing(0.7) threw
 * "characterSpacing is not a function" and 500'd the whole export. It goes in
 * the options object on .text(). */
function caps(doc, label, x, y, w) {
  doc.font('sansB').fontSize(6.8).fillColor(MUTED)
     .text(String(label).toUpperCase(), x, y, { width: w, characterSpacing: 0.7 });
}
function labelled(doc, label, text, y, opts) {
  const o = opts || {};
  const t = safe(text || '');
  if (!t && !o.showEmpty) return y;
  caps(doc, label, M + 2, y, CW - 4);
  let yy = doc.y + 1.5;
  doc.font(t ? 'sans' : 'sansI').fontSize(9.1).fillColor(t ? BODY : MUTED)
     .text(t || 'nothing recorded', M + 2, yy, { width: CW - 4, align: 'left', lineGap: 1.4 });
  return doc.y + 6;
}

/** Will `h` fit below the cursor? If not, start a new page. */
function room(doc, h) {
  if (doc.y + h > PH - M - FOOT_H) { doc.addPage(); doc.y = M; return true; }
  return false;
}

// ── the cover ───────────────────────────────────────────────────────────────
function cover(doc, meta) {
  const anon = meta.anonymised;
  doc.save().rect(0, 0, PW, 92).fill(anon ? '#34495e' : BRAND).restore();
  doc.font('sansB').fontSize(19).fillColor('#ffffff')
     .text(safe(anon ? 'Observations — anonymised sample' : 'Observation review'), M, 26, { width: CW });
  doc.font('sans').fontSize(9.4).fillColor('#ffffff')
     .text(safe(meta.settingName || 'Your Nursery'), M, 54, { width: CW });
  doc.font('sans').fontSize(8.4).fillColor('#ffffff')
     .text(safe(meta.windowLabel || ''), M, 69, { width: CW });

  doc.y = 110;
  doc.font('sansB').fontSize(10.5).fillColor(INK)
     .text(`${meta.count} observation${meta.count === 1 ? '' : 's'}`, M, doc.y, { width: CW });
  doc.moveDown(0.25);

  if (meta.filterLines && meta.filterLines.length) {
    caps(doc, 'Filters applied', M, doc.y + 4, CW);
    doc.font('sans').fontSize(8.6).fillColor(BODY);
    for (const l of meta.filterLines) doc.text('• ' + safe(l), M + 4, doc.y + 1.5, { width: CW - 8 });
  }

  if (anon) {
    const y0 = doc.y + 10;
    const note =
      'Names have been removed by matching this document against Wren’s own name lists '
      + '(children, staff, family contacts and the extra names held on a child record). Children are '
      + 'numbered within this document only, ages are given in months or years at the date of the '
      + 'observation, dates are shown as a month and year, practitioners are lettered, and there are no '
      + 'photographs and no Wren or EyLog record numbers.\n\n'
      + 'This is a name swap, not a guarantee. A capitalised word Wren could not match to any name list '
      + 'has been blanked to ' + R.UNKNOWN_LABEL + ' — there '
      + (meta.unknownCaps === 1 ? 'was 1' : 'were ' + (meta.unknownCaps || 0)) + ' in this document. '
      + 'A word at the START of a sentence is left alone, because a name there cannot be told apart from an '
      + 'ordinary word; and something identifying can be written with no name at all (a street, a birthday '
      + 'party, a sibling’s school). '
      + 'READ THIS DOCUMENT BEFORE YOU SHARE IT.';
    const h = doc.font('sans').fontSize(8.5).heightOfString(safe(note), { width: CW - 20, lineGap: 1.5 }) + 18;
    doc.save().roundedRect(M, y0, CW, h, 9).fillAndStroke('#fdf6ec', ACCENT).restore();
    doc.save().rect(M + 3, y0 + 4, 3, h - 8).fill(ACCENT).restore();
    doc.font('sans').fontSize(8.5).fillColor(INK).text(safe(note), M + 14, y0 + 9, { width: CW - 24, lineGap: 1.5 });
    doc.y = y0 + h + 8;
  } else if (meta.photoNote) {
    doc.font('sansI').fontSize(8.4).fillColor(MUTED).text(safe(meta.photoNote), M, doc.y + 8, { width: CW });
    doc.y = doc.y + 4;
  }

  if (meta.capped) {
    doc.font('sansB').fontSize(9).fillColor(ACCENT)
       .text(safe(`Only the first ${meta.count} observations are included — narrow the filters to export the rest.`),
             M, doc.y + 8, { width: CW });
  }
  hr(doc, doc.y + 10);
  doc.y = doc.y + 18;
}

// ── one observation ─────────────────────────────────────────────────────────
function card(doc, o, ctx) {
  const anon = ctx.anonymised;
  // Reserve enough space that a card does not start two lines before a page
  // break; the body is allowed to flow on if it is genuinely long.
  room(doc, 120);

  const top = doc.y;
  const who = anon ? ctx.red.labelForChild(o.child_id) : ctx.childName(o);
  const age = R.ageText(o.age_months);
  const when = anon ? R.monthYear(o.created_at) : R.fullDate(o.created_at);
  const author = anon
    ? ctx.red.labelForPractitioner(o.staff_id, o.author)
    : (o.author || 'Not recorded');

  doc.font('sansB').fontSize(11.2).fillColor(INK).text(safe(who), M + 2, top, { width: CW * 0.6, lineBreak: false });
  doc.font('sans').fontSize(8.4).fillColor(MUTED)
     .text(safe(`${age}  ·  ${when}  ·  ${author}`), M + 2, doc.y + 1, { width: CW - 4 });

  // the flags that change how an observation should be read
  const marks = [];
  if (o.observation_type && o.observation_type !== 'learning_story') marks.push(TYPE_LABELS[o.observation_type] || o.observation_type);
  if (o.baseline) marks.push('Baseline');
  if (o.termly_update) marks.push('Termly update');
  if (o.parental) marks.push('Parent observation');
  if (o.group_size > 1) marks.push(`Group of ${o.group_size}`);
  if (!anon) {
    if (o.shared_with_parents) marks.push('Shared with parents');
    if (o.review_status && o.review_status !== 'published') marks.push(REVIEW_LABELS[o.review_status] || o.review_status);
    if (o.from_eylog) marks.push('EyLog import');
  }

  const areas = (o.eyfs_areas || []).map(a => {
    const c = ctx.canonOf(a); return c ? c.label : String(a);
  }).filter(Boolean);
  const areaSet = [...new Set(areas)];

  let y = doc.y + 4;
  if (marks.length) y = chips(doc, marks, M + 2, y, CW - 6);
  if (areaSet.length) y = chips(doc, areaSet, M + 2, y, CW - 6);
  else y = chips(doc, ['no area of learning tagged'], M + 2, y, CW - 6);

  // statements — the aspect / age range / text the tracker holds
  const st = (o.statements || []).filter(s => s.statement_text || s.statement_code || s.coel_characteristic);
  if (st.length) {
    const lines = st.slice(0, 12).map(s => {
      const bits = [];
      if (s.coel_characteristic) bits.push('COEL: ' + s.coel_characteristic + (s.coel_level ? ' (' + s.coel_level + ')' : ''));
      else {
        if (s.aspect) bits.push(s.aspect);
        if (s.age_range) bits.push(s.age_range);
      }
      const head = bits.length ? bits.join(' · ') + ' — ' : '';
      return head + String(s.statement_text || s.statement_code || '').replace(/\s+/g, ' ').trim();
    });
    doc.y = y;
    caps(doc, 'Statements tagged', M + 2, doc.y, CW - 4);
    doc.font('sans').fontSize(8.3).fillColor(BODY);
    for (const l of lines) doc.text('• ' + safe(l), M + 6, doc.y + 1, { width: CW - 12, lineGap: 0.8 });
    y = doc.y + 6;
  }

  doc.y = y;
  // Anonymised text was produced ONCE, in the pre-pass (see renderObservationPdf):
  // calling field() again here would double the blanked-word count that the
  // cover has already printed.
  const prep = ctx.prepared && ctx.prepared.get(o.id);
  const F = f => (anon ? (prep ? prep[f] : '') : R.plain(o[f], false));
  doc.y = labelled(doc, 'Observation', F('observation_text'), doc.y, { showEmpty: true });
  doc.y = labelled(doc, 'What it shows', F('analysis'), doc.y, { showEmpty: true });
  doc.y = labelled(doc, 'Next steps', F('next_steps'), doc.y, { showEmpty: true });

  // photos — normal export only, and only when asked for
  if (!anon && ctx.photos && (o.photo_urls || []).length) {
    const thumbs = [];
    for (const u of o.photo_urls) {
      const p = resolvePhoto(u);
      if (p) thumbs.push(p); else ctx.stats.photosSkipped++;
      if (thumbs.length >= 4) break;
    }
    if (thumbs.length) {
      const tw = 112, th = 84;
      room(doc, th + 12);
      let x = M + 2;
      const y0 = doc.y + 2;
      for (const p of thumbs) {
        try {
          doc.image(p, x, y0, { fit: [tw, th], align: 'center', valign: 'center' });
          doc.save().roundedRect(x, y0, tw, th, 5).lineWidth(0.7).strokeColor(LINE).stroke().restore();
          ctx.stats.photosDrawn++;
          x += tw + 8;
        } catch (_) { ctx.stats.photosSkipped++; }
      }
      doc.y = y0 + th + 8;
    }
  }

  hr(doc, doc.y + 2);
  doc.y = doc.y + 12;
}

const TYPE_LABELS = {
  learning_story: 'Learning story', planned_activity: 'Planned activity',
  milestone: 'Milestone', note: 'Note', '2year_check': 'Two-year check', assessment: 'Assessment',
};
const REVIEW_LABELS = { pending_review: 'Awaiting review', returned: 'Returned to writer' };

// ── footers ─────────────────────────────────────────────────────────────────
function footers(doc, meta) {
  const range = doc.bufferedPageRange();
  const left = meta.anonymised
    ? 'Names removed by matching Wren’s name lists — read before sharing. No photographs.'
    : (meta.settingName || 'Your Nursery') + ' — observation review';
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // The one thing that must not be forgotten here: a footer is drawn BELOW the
    // bottom margin, and pdfkit auto-paginates past it, appending one blank page
    // per footer. Drop the margin for the pass.
    const bm = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    hr(doc, PH - M - 14);
    doc.font('sans').fontSize(7.4).fillColor(MUTED)
       .text(safe(left), M, PH - M - 10, { width: CW * 0.72, lineBreak: false });
    doc.font('sans').fontSize(7.4).fillColor(MUTED)
       .text(`Page ${i - range.start + 1} of ${range.count}`, M + CW * 0.72, PH - M - 10,
             { width: CW * 0.28, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bm;
  }
}

// ── the entry point ─────────────────────────────────────────────────────────
/**
 * Render one export and resolve to a Buffer.
 *
 * @param {object[]} rows      observation rows from observation-review-query.listRows
 * @param {object}   opts
 * @param {boolean}  opts.anonymised   the one switch; the route owns it
 * @param {boolean}  opts.photos       thumbnails — IGNORED when anonymised
 * @param {object}   opts.red          exportRedactor() instance (anonymised only)
 * @param {Function} opts.canonOf      raw area → { label } or null
 * @param {string}   opts.windowLabel  what the date filter was
 * @param {string[]} opts.filterLines  one plain-English line per active filter
 * @param {boolean}  opts.capped       the 500 cap was hit
 */
function renderObservationPdf(rows, opts) {
  const o = opts || {};
  const anon = !!o.anonymised;
  const stats = { photosDrawn: 0, photosSkipped: 0 };

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDoc({
        size: 'A4', margins: { top: M, bottom: M + FOOT_H, left: M, right: M },
        bufferPages: true,
        info: {
          Title: anon ? 'Observations — anonymised sample' : 'Observation review',
          Author: o.settingName || 'Your Nursery',
          // Deliberately no Subject/Keywords: the filter text can name a child,
          // and PDF metadata is the one part of a document nobody re-reads.
        },
      });
      registerFonts(doc);
      const bufs = [];
      doc.on('data', d => bufs.push(d));
      doc.on('end', () => resolve(Buffer.concat(bufs)));
      doc.on('error', reject);

      const ctx = {
        anonymised: anon,
        photos: anon ? false : !!o.photos,
        red: o.red,
        canonOf: o.canonOf || (() => null),
        childName: (r) => {
          const n = [r.child_first_name, r.child_last_name].filter(Boolean).join(' ').trim();
          return n || (r.child_preferred_name || 'Child not recorded');
        },
        stats,
      };

      /* ANONYMISED PRE-PASS. Two things make this a separate walk rather than
       * work done inside card():
       *   · the redactor numbers children and practitioners on FIRST
       *     appearance, so the numbering has to be assigned in print order;
       *   · the cover prints how many words were blanked to [name?], and that
       *     total cannot be known until every field has been through the
       *     anonymiser. Redacting twice would double it.
       * The result is cached per row and card() only reads it. */
      const prepared = new Map();
      let unknownCaps = 0;
      if (anon && o.red) {
        for (const r of rows) {
          o.red.labelForChild(r.child_id);
          o.red.labelForPractitioner(r.staff_id, r.author);
          prepared.set(r.id, {
            observation_text: o.red.field(r.observation_text, r.child_id),
            analysis:         o.red.field(r.analysis, r.child_id),
            next_steps:       o.red.field(r.next_steps, r.child_id),
          });
        }
        unknownCaps = o.red.unknownCapCount;
      }
      ctx.prepared = prepared;

      cover(doc, {
        anonymised: anon,
        count: rows.length,
        settingName: o.settingName,
        windowLabel: o.windowLabel,
        filterLines: o.filterLines,
        capped: o.capped,
        unknownCaps,
        photoNote: (!anon && o.photos) ? 'Photographs are included. This document holds images of children — treat it as a child record.'
          : (!anon ? 'Photographs are not included in this export.' : null),
      });

      for (const r of rows) card(doc, r, ctx);

      if (!rows.length) {
        doc.font('sansI').fontSize(10).fillColor(MUTED)
           .text('No observations matched these filters.', M, doc.y + 10, { width: CW });
      }
      if (!anon && o.photos && stats.photosSkipped) {
        room(doc, 30);
        doc.font('sansI').fontSize(8.4).fillColor(MUTED)
           .text(safe(`${stats.photosSkipped} image${stats.photosSkipped === 1 ? '' : 's'} could not be read from the upload store and were left out.`),
                 M, doc.y + 4, { width: CW });
      }

      footers(doc, { anonymised: anon, settingName: o.settingName });
      doc.end();
    } catch (e) { reject(e); }
  });
}

/** A filename that says what the document is without naming anybody. */
function pdfFilename(opts) {
  const o = opts || {};
  const d = new Date().toISOString().slice(0, 10);
  return `observations-${o.anonymised ? 'anonymised-' : ''}${d}.pdf`;
}

module.exports = { renderObservationPdf, pdfFilename, resolvePhoto, obsReadDirs, safe, TYPE_LABELS };
