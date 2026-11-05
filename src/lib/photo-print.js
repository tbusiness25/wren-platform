'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b321 — the printing half. A photo a family sent us is no use sitting in a
// database; the brief is "staff can download and print".
//
// TWO LAYOUTS, because they are two different jobs:
//
//   a4Photo()   ONE family picture, fitted to a sheet of A4 for the room
//               display. Fitted, not stretched: a portrait phone photo on a
//               landscape frame must letterbox, never distort. A child looking
//               at a squashed picture of their own family is the failure here.
//
//   pegSheet()  MANY peg portraits on one sheet, each at the physical size the
//               brief asks for (about 45 × 55 mm — a little bigger than a
//               passport photo), with the child's FIRST NAME under it and a cut
//               line round it. Nine to a page. The point is that a room leader
//               prints one sheet, cuts it up, and has every peg labelled.
//
// WHY pdfkit AND NOT A BROWSER
//
// Puppeteer cannot run in the Wren image (Alpine/musl, and it is a
// devDependency), so no runtime route can render HTML to PDF. pdfkit is already
// a dependency and is what b293 used for the planning PDF. It embeds JPEG and
// PNG directly — which is why child-documents.js refuses WebP for the two photo
// categories: an unprintable photo is not a photo, for this purpose.
//
// THE MARGIN IS ZERO AND EVERY POSITION IS COMPUTED
//
// pdfkit auto-paginates the moment flowed text crosses the bottom margin, which
// is how a footer ends up adding a blank page (the b293 note). Nothing here
// flows: the document is created with margin 0, every draw call is given an
// explicit x/y/width/height, and pages are added by hand. A peg sheet that
// prints a tenth blank page wastes a sheet of card every time.
//
// PHYSICAL SIZE IS THE WHOLE POINT
// A peg label has to be 45 mm wide when it comes out of the printer, so the
// geometry is written in millimetres and converted once. Points = mm × 72/25.4.
// ─────────────────────────────────────────────────────────────────────────────

const PDFDocument = require('pdfkit');

const MM = 72 / 25.4;                 // 1 mm in PDF points
const A4 = { w: 210 * MM, h: 297 * MM };

/**
 * Collect a pdfkit stream into one Buffer.
 *
 * It attaches the listeners and returns a promise; it does NOT call doc.end().
 * That distinction is the whole of it: end() writes the xref table and the
 * trailer, so anything drawn afterwards is appended past %%EOF and the file
 * reads as "bad XRef entry" in every real PDF parser while still looking
 * plausible to a regex. Call collect() first, draw, then finish().
 */
function collect(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
function finish(doc, promise) { doc.end(); return promise; }

/** Contain-fit: the largest w×h that fits the box without changing the aspect. */
function fit(srcW, srcH, boxW, boxH) {
  if (!srcW || !srcH) return { w: boxW, h: boxH, x: 0, y: 0 };
  const s = Math.min(boxW / srcW, boxH / srcH);
  const w = srcW * s, h = srcH * s;
  return { w, h, x: (boxW - w) / 2, y: (boxH - h) / 2 };
}

/**
 * One family photo on one sheet of A4.
 *
 * @param {Buffer} image     JPEG or PNG bytes (already EXIF-stripped upstream)
 * @param {object} opts      { caption, subtitle, width, height }
 */
async function a4Photo(image, opts = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: opts.caption || 'Family photo' } });
  const out = collect(doc);

  const pad = 12 * MM;
  const capH = opts.caption ? 20 * MM : 0;
  const boxW = A4.w - pad * 2;
  const boxH = A4.h - pad * 2 - capH;

  // pdfkit's own `fit` option does the same arithmetic, but doing it here means
  // the frame can be drawn around the IMAGE rather than around the box, so a
  // portrait photo gets a portrait frame instead of a thin line in white space.
  const f = fit(opts.width, opts.height, boxW, boxH);

  // The photo and its name are ONE block, centred together. Centring the image
  // in the page and pinning the caption to the bottom margin puts 80mm of white
  // between a landscape photo and the name under it, which reads as a printing
  // error rather than a mount.
  const blockH = f.h + capH;
  const x = pad + f.x;
  const y = pad + Math.max(0, (A4.h - pad * 2 - blockH) / 2);

  doc.save()
     .rect(x - 2, y - 2, f.w + 4, f.h + 4)
     .lineWidth(1).strokeColor('#d8d0c0').stroke()
     .restore();
  doc.image(image, x, y, { width: f.w, height: f.h });

  if (opts.caption) {
    // Explicit width AND height, so nothing can flow onto a second page.
    const capY = y + f.h + 7 * MM;
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#2a2a2a')
       .text(opts.caption, pad, capY, { width: boxW, height: 10 * MM, align: 'center', lineBreak: false });
    if (opts.subtitle) {
      doc.font('Helvetica').fontSize(11).fillColor('#5a5a5a')
         .text(opts.subtitle, pad, capY + 9 * MM,
               { width: boxW, height: 6 * MM, align: 'center', lineBreak: false });
    }
  }
  return finish(doc, out);
}

// ── Peg sheet geometry ───────────────────────────────────────────────────────
// 45 × 55 mm photo (the brief), a 12 mm name band under it, and 3 mm of white
// inside the cut line so the scissors do not clip the print.
const PEG = {
  photoW: 45, photoH: 55,
  nameH: 12,
  inset: 3,
  get cellW() { return this.photoW + this.inset * 2; },          // 51 mm
  get cellH() { return this.photoH + this.nameH + this.inset * 2; }, // 73 mm
};
const SHEET_MARGIN = 10;               // mm
const GUTTER = 4;                      // mm between cut lines

// 3 across (3×51 + 2×4 = 161 ≤ 190) and 3 down (3×73 + 2×4 = 227 ≤ 277) — nine
// per sheet, comfortably over the six the brief asks for, at the real size.
const COLS = Math.floor((210 - SHEET_MARGIN * 2 + GUTTER) / (PEG.cellW + GUTTER));
const ROWS = Math.floor((297 - SHEET_MARGIN * 2 + GUTTER) / (PEG.cellH + GUTTER));
const PER_PAGE = COLS * ROWS;

/**
 * Peg labels, many to a page.
 *
 * @param {Array} entries  [{ name, image?, width?, height?, note? }]
 *                         `image` absent → a placeholder cell that still prints
 *                         the name, because a peg with no photo yet still needs
 *                         a label and the gap is the prompt to chase the family.
 * @param {object} opts    { heading }
 */
async function pegSheet(entries, opts = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: opts.heading || 'Peg labels' } });
  const out = collect(doc);

  // Centre the block of labels on the sheet, horizontally AND vertically. Three
  // rows of 73mm leave ~55mm spare on an A4, and a grid pinned to the top with
  // all of it below looks like a printing mistake rather than a layout.
  const gridW = COLS * PEG.cellW + (COLS - 1) * GUTTER;
  const gridH = ROWS * PEG.cellH + (ROWS - 1) * GUTTER;
  const headH = opts.heading ? 8 : 0;
  const originX = (210 - gridW) * 0.5;
  const originY = headH + SHEET_MARGIN + Math.max(0, (297 - SHEET_MARGIN * 2 - headH - gridH) * 0.5);

  entries.forEach((e, i) => {
    const onPage = i % PER_PAGE;
    if (i && onPage === 0) doc.addPage({ size: 'A4', margin: 0 });

    if (onPage === 0 && opts.heading) {
      doc.font('Helvetica').fontSize(9).fillColor('#8a8a8a')
         .text(opts.heading, SHEET_MARGIN * MM, (SHEET_MARGIN - 4) * MM,
               { width: (210 - SHEET_MARGIN * 2) * MM, height: 6 * MM, align: 'left', lineBreak: false });
    }

    const col = onPage % COLS, row = Math.floor(onPage / COLS);
    const cx = (originX + col * (PEG.cellW + GUTTER)) * MM;
    const cy = (originY + row * (PEG.cellH + GUTTER)) * MM;

    // The cut line. Dashed, thin and grey: it has to be visible to scissors and
    // invisible from across the cloakroom.
    doc.save()
       .lineWidth(0.5).strokeColor('#b9b9b9').dash(2, { space: 2 })
       .rect(cx, cy, PEG.cellW * MM, PEG.cellH * MM).stroke()
       .undash().restore();

    const px = cx + PEG.inset * MM, py = cy + PEG.inset * MM;
    const pw = PEG.photoW * MM, ph = PEG.photoH * MM;

    if (e.image) {
      // COVER, not contain — a peg label is a fixed physical rectangle and a
      // letterboxed portrait would leave white bars on a 45×55 card. Overflow is
      // clipped to the frame, so the face stays centred and fills the label.
      const s = Math.max(pw / (e.width || pw), ph / (e.height || ph));
      const dw = (e.width || pw) * s, dh = (e.height || ph) * s;
      doc.save().rect(px, py, pw, ph).clip()
         .image(e.image, px + (pw - dw) / 2, py + (ph - dh) / 2, { width: dw, height: dh })
         .restore();
    } else {
      doc.save().rect(px, py, pw, ph).fillColor('#f2efe8').fill()
         .rect(px, py, pw, ph).lineWidth(0.5).strokeColor('#ddd6c8').stroke().restore();
      doc.font('Helvetica').fontSize(7).fillColor('#a09888')
         .text('no photo yet', px, py + ph / 2 - 4, { width: pw, height: 10, align: 'center', lineBreak: false });
    }
    doc.save().rect(px, py, pw, ph).lineWidth(0.5).strokeColor('#cfc8ba').stroke().restore();

    // The name. One line, never wrapped, shrunk to fit rather than truncated —
    // a label reading "Christoph" is worse than a slightly smaller "Christopher".
    const ny = py + ph + 2.5 * MM;
    let size = 15;
    doc.font('Helvetica-Bold');
    while (size > 7 && doc.fontSize(size).widthOfString(e.name || '') > pw - 4) size -= 0.5;
    doc.fontSize(size).fillColor('#2a2a2a')
       .text(e.name || '', px, ny, { width: pw, height: PEG.nameH * MM, align: 'center', lineBreak: false });

    if (e.note) {
      doc.font('Helvetica').fontSize(6.5).fillColor('#8a8a8a')
         .text(e.note, px, ny + size + 2, { width: pw, height: 8, align: 'center', lineBreak: false });
    }
  });

  if (!entries.length) {
    doc.font('Helvetica').fontSize(12).fillColor('#5a5a5a')
       .text('No peg photos have been uploaded yet.', 20 * MM, 40 * MM,
             { width: 170 * MM, height: 20 * MM, align: 'center', lineBreak: false });
  }
  return finish(doc, out);
}

module.exports = { a4Photo, pegSheet, MM, A4, PEG, COLS, ROWS, PER_PAGE };
