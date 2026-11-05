'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
 * plan-pdf.js — b293 (2026-09-08)
 *
 * Toby sends the planning out through EyLog, so it has to leave Wren as a file:
 * "colourful and parent-readable — theme, key books, songs, learning intentions
 * and the activities, laid out like something you would put on a wall, not a
 * database dump."
 *
 * WHY PDFKIT, AND WHY NOT THE OTHER TWO CANDIDATES
 * ────────────────────────────────────────────────────────────────────────────
 * The brief said to reuse the existing MD→PDF helper if it fits. Neither fits:
 *   · scripts/b108-md-to-html.js is Markdown → an HTML *fragment*. It produces
 *     no PDF at all.
 *   · The Fledge "Download PDF" button is an <a href> to a pre-built static
 *     file (public/docs/fledge-framework-v0.2.pdf). There is no renderer behind
 *     it to call.
 *
 * Headless Chromium was tried first and REJECTED on evidence, not taste:
 *   · the app image is node:20-alpine (musl). Puppeteer's bundled Chrome is a
 *     glibc binary, so it dies with `spawn …/chrome ENOENT` inside
 *     wren-ladn-dev even though the file is present and +x;
 *   · puppeteer is a devDependency and the image builds with
 *     `npm ci --only=production`, so a rebuilt container would not even have
 *     it. It works in scripts/ because those run on the host.
 *   Making it work would mean `apk add chromium` (~400MB) on a box already at
 *   73% disk, for a button someone presses a few times a term.
 *
 * So this uses pdfkit — already a dependency, already how every other Wren PDF
 * is made (invoice-pdf.js, report-pdf.js, owner-digest-pdf.js, keepsake).
 *
 * report-pdf.js has to strip every non-WinAnsi character because it uses
 * pdfkit's built-in fonts. This registers Alpine's DejaVu faces instead (the
 * image already installs font-dejavu for the b269 OCR path), so curly quotes,
 * en-dashes and arrows come out right. Colour emoji are still not a thing in
 * any embeddable TTF, so the decoration here is DRAWN — gradient bands, tinted
 * panels, coloured rules — which is what "wall poster" wanted anyway.
 *
 * DRAFTS (b290 gave term_plans a status of 'draft' | 'published')
 * ────────────────────────────────────────────────────────────────────────────
 * An unfinished plan must not be able to go out looking final, so a draft is
 * marked in FOUR independent places, because any one of them can be missed:
 *   1. a large rotated DRAFT watermark, drawn on every page as it is created,
 *      underneath the content;
 *   2. a DRAFT chip in the coloured band at the top of the half-term;
 *   3. the page footer;
 *   4. the filename (pdfFilename appends -DRAFT).
 * A published plan gets none of the four, and nothing else about the layout
 * moves, so the two are otherwise the same document.
 * ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const TPV = require('./term-plan-view');   // b302 — one reader for a term_plans row
const path = require('path');
const PDFDoc = require('pdfkit');

// ── page geometry (A4 portrait) ─────────────────────────────────────────────
const PW = 595.28, PH = 841.89;
const M = 38;
const CW = PW - M * 2;          // 519.28
const BOTTOM = PH - M - 22;     // leave room for the footer

// ── palette ─────────────────────────────────────────────────────────────────
// One colourway per half-term. A year of plans printed in one colour is a stack
// of identical pages; six colourways make "this is the Spring 1 one" a glance
// rather than a read. Hues follow the season; every pair was checked to carry
// white text on the band.
const COLOURWAYS = {
  'Autumn 1': { a: '#c2410c', b: '#ea8a3c', tint: '#fdf1e7', ink: '#7c2d12' },
  'Autumn 2': { a: '#6d28d9', b: '#a78bfa', tint: '#f4f0fe', ink: '#4c1d95' },
  'Spring 1': { a: '#15803d', b: '#5cbd7d', tint: '#ecf8f0', ink: '#14532d' },
  'Spring 2': { a: '#be185d', b: '#f472b6', tint: '#fdeff5', ink: '#831843' },
  'Summer 1': { a: '#0369a1', b: '#4a9abf', tint: '#eaf6fc', ink: '#0c4a6e' },
  'Summer 2': { a: '#a16207', b: '#eab308', tint: '#fdf8e6', ink: '#713f12' },
};
const HOUSE  = { a: '#2f5741', b: '#4a9abf', tint: '#eff6f1', ink: '#1d3a2a' };

// ── b521: Kat's activity-card palette ───────────────────────────────────────
// Toby: "I wanted it in that exact format ... quite pretty, A4, with light autumn
// colours." Sampled from the pre-school year sheet itself (/app/uploads/
// PS yearly.pdf, the Autumn 2 and Spring 2 card pages): a saturated header band
// over a much lighter body of the same hue, rotating card to card. `band` is the
// measured colour; `body` is the same hue lifted to roughly the scan's tint; `ink`
// is a dark version of the hue for the body-copy labels.
//
// Measured, not guessed: green rgb(125,172,80), peach rgb(225,172,131),
// slate-blue rgb(192,205,214), sand rgb(211,204,144), teal rgb(134,177,186).
const CARD_COLOURS = [
  { name: 'peach', band: '#e1ac83', body: '#fbf0e7', ink: '#8a4f21' },
  { name: 'green', band: '#7dac50', body: '#f0f6e9', ink: '#3f5c26' },
  { name: 'sand',  band: '#d3cc90', body: '#faf7e9', ink: '#6b6321' },
  { name: 'slate', band: '#c0cdd6', body: '#f1f5f8', ink: '#3c5261' },
  { name: 'teal',  band: '#86b1ba', body: '#eef6f7', ink: '#2f5c64' },
];
const CARD_BY_NAME = new Map(CARD_COLOURS.map(c => [c.name, c]));
// The four labelled lines, in the order Kat's sheet prints them. Order is the
// pedagogy — intent before implementation before impact — so it is not sorted.
const CARD_LINES = [
  ['intent',         'Intent:'],
  ['implementation', 'Implementation:'],
  ['impact',         'Impact:'],
  ['adult_role',     'Adult Role:'],
];
const INK    = '#26332b';
const BODY   = '#3f4c44';
const MUTED  = '#6f8177';
const LINE   = '#d7e2da';
const PAPER  = '#ffffff';
const BLUE   = '#4a9abf';
const ORANGE = '#e07820';
const RED    = '#c0392b';

const colourway = name => COLOURWAYS[String(name || '').trim()] || HOUSE;

// ── fonts ───────────────────────────────────────────────────────────────────
// DejaVu if the image has it (it does — font-dejavu, installed for b269 OCR);
// pdfkit's built-ins otherwise, so this still renders on a box without it.
const DEJAVU = [
  '/usr/share/fonts/dejavu',
  '/usr/share/fonts/truetype/dejavu',
  '/usr/share/fonts/TTF',
];
function findFont(file) {
  for (const d of DEJAVU) {
    const p = path.join(d, file);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}
const FONTS = {
  sans:   findFont('DejaVuSans.ttf'),
  sansB:  findFont('DejaVuSans-Bold.ttf'),
  sansI:  findFont('DejaVuSans-Oblique.ttf'),
  serif:  findFont('DejaVuSerif.ttf'),
  serifB: findFont('DejaVuSerif-Bold.ttf'),
};
const HAS_TTF = !!(FONTS.sans && FONTS.sansB);

function registerFonts(doc) {
  if (HAS_TTF) {
    doc.registerFont('sans',   FONTS.sans);
    doc.registerFont('sansB',  FONTS.sansB);
    doc.registerFont('sansI',  FONTS.sansI  || FONTS.sans);
    doc.registerFont('serif',  FONTS.serif  || FONTS.sans);
    doc.registerFont('serifB', FONTS.serifB || FONTS.sansB);
    return;
  }
  doc.registerFont('sans', 'Helvetica');
  doc.registerFont('sansB', 'Helvetica-Bold');
  doc.registerFont('sansI', 'Helvetica-Oblique');
  doc.registerFont('serif', 'Times-Roman');
  doc.registerFont('serifB', 'Times-Bold');
}

/* With the built-in fonts only WinAnsi survives; with DejaVu almost everything
 * does. Either way, strip characters no embeddable TTF can draw (colour emoji),
 * because a practitioner pasting a 🎨 into an activity title is routine. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}]/gu;
const NON_WINANSI = /[\u{0100}-\u{FFFF}]/gu;
function safe(v) {
  let s = String(v == null ? '' : v).replace(EMOJI, '');
  if (!HAS_TTF) {
    s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
         .replace(/[–—]/g, '-').replace(/…/g, '...')
         .replace(/×/g, 'x').replace(NON_WINANSI, '');
  }
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

// ── dates ───────────────────────────────────────────────────────────────────
/* pg hands DATE back as a local-midnight JS Date. Neither String() nor
 * toISOString() is safe (the pg DATE → ymd trap), so read the local parts. */
function ymd(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];
/* Split the string by hand rather than through Date, so a label can never slide
 * a day either side of midnight in a timezone. */
function longDate(v) {
  const s = ymd(v); if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
function shortDate(v) {
  const s = ymd(v); if (!s) return '';
  const [, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)}`;
}
function dateRange(a, b) {
  const s = shortDate(a), e = longDate(b);
  return s && e ? `${s} – ${e}` : (s || e);
}

// ── low-level drawing helpers ───────────────────────────────────────────────

function gradientBand(doc, x, y, w, h, c1, c2, r) {
  const g = doc.linearGradient(x, y, x + w, y + h);
  g.stop(0, c1).stop(1, c2);
  doc.roundedRect(x, y, w, h, r == null ? 9 : r).fill(g);
}

function panel(doc, x, y, w, h, opts) {
  const o = opts || {};
  doc.roundedRect(x, y, w, h, o.r == null ? 9 : o.r)
     .fillAndStroke(o.fill || PAPER, o.stroke || LINE);
  doc.lineWidth(1);
  if (o.accent) {                                    // left accent bar
    doc.save().rect(x, y + 3, 3.5, h - 6).fill(o.accent).restore();
  }
  if (o.topbar) {                                    // top accent bar
    doc.save().rect(x + 4, y, w - 8, 3).fill(o.topbar).restore();
  }
}

/* A small all-caps label. It WRAPS by default (a category like
 * "Small World/Role Play" does not fit a 100pt day column on one line, and with
 * lineBreak:false pdfkit drew the overflow on top of the line below it). Callers
 * that must have exactly one line pass one, and get an ellipsis instead. */
function tinyCaps(doc, text, x, y, w, colour, lines) {
  const o = { width: w, characterSpacing: 0.9 };
  if (lines) { o.height = tinyCapsH(doc, text, w, lines); o.ellipsis = true; }
  doc.font('sansB').fontSize(6.6).fillColor(colour)
     .text(safe(text).toUpperCase(), x, y, o);
  return doc.y - y;
}
function tinyCapsH(doc, text, w, maxLines) {
  doc.font('sansB').fontSize(6.6);
  const h = doc.heightOfString(safe(text).toUpperCase(), { width: w, characterSpacing: 0.9 });
  return maxLines ? Math.min(h, maxLines * 8.2) : h;
}

/* A rounded "chip" for a song title. Returns the width used. */
function chip(doc, text, x, y, maxW, fill, stroke, ink) {
  const t = safe(text);
  doc.font('sans').fontSize(8);
  const tw = Math.min(doc.widthOfString(t), maxW - 14);
  const w = tw + 14;
  doc.roundedRect(x, y, w, 15, 7.5).fillAndStroke(fill, stroke);
  doc.fillColor(ink).text(t, x + 7, y + 4, { width: tw, lineBreak: false, ellipsis: true });
  return w;
}

// ── the renderer ────────────────────────────────────────────────────────────

class Sheet {
  constructor(doc, draft) {
    this.doc = doc;
    this.draft = draft;
    this.y = M;
    this.cw = HOUSE;
  }
  get d() { return this.doc; }

  newPage() {
    this.doc.addPage();
    this.y = M;
  }
  /* Every block measures itself first and asks for room. Nothing relies on
     pdfkit's own auto-paging, which would silently desynchronise this.y. */
  need(h) {
    if (this.y + h > BOTTOM) this.newPage();
  }
  gap(h) { this.y += h; }

  // ── header band ───────────────────────────────────────────────────────────
  band(termName, sub) {
    const d = this.doc, cw = this.cw, h = 62;
    this.need(h + 8);
    gradientBand(d, M, this.y, CW, h, cw.a, cw.b, 11);

    d.font('serifB').fontSize(23).fillColor('#ffffff')
     .text(safe(termName), M + 20, this.y + 13, { width: CW - 150, lineBreak: false });
    d.font('sans').fontSize(9).fillColor('#ffffff').opacity(0.92)
     .text(safe(sub), M + 20, this.y + 41, { width: CW - 150, lineBreak: false });
    d.opacity(1);

    if (this.draft) {
      const cw2 = 74;
      d.roundedRect(M + CW - cw2 - 16, this.y + 21, cw2, 20, 5).fill('#ffffff');
      d.font('sansB').fontSize(9.5).fillColor(RED)
       .text('DRAFT', M + CW - cw2 - 16, this.y + 26,
             { width: cw2, align: 'center', characterSpacing: 1.5, lineBreak: false });
    }
    this.y += h + 12;
  }

  // ── theme ─────────────────────────────────────────────────────────────────
  theme(text, carry) {
    const d = this.doc, cw = this.cw;
    const innerW = CW - 44;
    d.font('serifB').fontSize(19);
    const th = d.heightOfString(safe(text), { width: innerW });
    let ch = 0;
    if (carry) { d.font('sans').fontSize(8.6); ch = d.heightOfString(safe(carry), { width: innerW }) + 5; }
    const h = 15 + th + ch + 15;

    this.need(h + 10);
    panel(d, M, this.y, CW, h, { fill: cw.tint, stroke: LINE, accent: cw.a, r: 9 });
    tinyCaps(d, 'Our theme', M + 20, this.y + 12, innerW, cw.a);
    d.font('serifB').fontSize(19).fillColor(cw.ink)
     .text(safe(text), M + 20, this.y + 22, { width: innerW });
    if (carry) {
      d.font('sansI').fontSize(8.6).fillColor(BODY)
       .text(safe(carry), M + 20, this.y + 22 + th + 4, { width: innerW });
    }
    this.y += h + 12;
  }

  // ── a titled box; body is drawn by the callback ───────────────────────────
  /* draw(x, y, w) must return the height it used. It is called twice: once with
     measure=true to size the box, once for real. Cheap, and it keeps a box from
     ever being the wrong height for its contents. */
  box(title, measure, draw) {
    const d = this.doc, cw = this.cw;
    const innerW = CW - 32;
    const bodyH = measure(innerW);
    const h = 24 + bodyH + 13;
    this.need(h + 8);
    panel(d, M, this.y, CW, h, { fill: PAPER, stroke: LINE });
    d.save().rect(M + 16, this.y + 14, 16, 2.5).fill(cw.a).restore();
    d.font('sansB').fontSize(10.5).fillColor(cw.a)
     .text(safe(title), M + 38, this.y + 10, { width: innerW - 22, lineBreak: false });
    draw(M + 16, this.y + 26, innerW);
    this.y += h + 10;
  }

  // ── free-standing sub-heading (used between week blocks) ──────────────────
  weekHeading(label, sub) {
    const d = this.doc, cw = this.cw;
    this.need(20);
    d.font('sansB').fontSize(9.5).fillColor(cw.a)
     .text(safe(label), M + 2, this.y, { width: 120, lineBreak: false });
    if (sub) {
      d.font('sans').fontSize(8).fillColor(MUTED)
       .text(safe(sub), M + 82, this.y + 1.2, { width: CW - 90, lineBreak: false });
    }
    d.save().moveTo(M + 2, this.y + 13).lineTo(M + CW - 2, this.y + 13)
      .lineWidth(1).stroke(cw.tint).restore();
    this.y += 19;
  }

  // ── b521: Kat's activity cards ────────────────────────────────────────────
  // One card = a coloured header band carrying the activity name, over a lighter
  // body of the same hue holding Intent / Implementation / Impact / Adult Role.
  // Measure-then-draw like box() above, so a card is never the wrong height, and
  // a card that will not fit starts a new page WHOLE rather than being split
  // across two — the sheet is read a card at a time.
  cards(list, opts) {
    const d = this.doc;
    const o = opts || {};
    const innerW = CW - 28;           // 14pt padding each side
    list.forEach((card, i) => {
      const pal = (card.colour && CARD_BY_NAME.get(card.colour))
               || CARD_COLOURS[i % CARD_COLOURS.length];
      const lines = CARD_LINES
        .map(([key, label]) => [label, String(card[key] == null ? '' : card[key]).trim()])
        .filter(([, v]) => v);
      if (!card.title && !lines.length) return;

      // measure
      d.font('sansB').fontSize(11.5);
      const headH = Math.max(20, d.heightOfString(safe(card.title), { width: innerW }) + 7);
      let bodyH = 0;
      const lineH = [];
      for (const [label, value] of lines) {
        d.font('sans').fontSize(8.9);
        // The label is bold and inline, so the whole line is measured as one
        // paragraph at the body size — close enough, and never short.
        const h = d.heightOfString(label + ' ' + safe(value), { width: innerW }) + 4.5;
        lineH.push(h); bodyH += h;
      }
      void bodyH;
      const h = headH + (lines.length ? bodyH + 9 : 4);
      this.need(h + 9);

      const top = this.y;
      // Body first, then the header band over the top of it, so the two share
      // one rounded outline rather than showing a seam between them.
      d.save();
      d.roundedRect(M, top, CW, h, 4).fill(pal.body);
      d.roundedRect(M, top, CW, headH, 4).fill(pal.band);
      d.rect(M, top + headH - 4, CW, 4).fill(pal.band);      // square off the band's lower corners
      d.roundedRect(M + 0.5, top + 0.5, CW - 1, h - 1, 4).lineWidth(0.7).stroke('#9aa79f');
      d.restore();

      d.font('sansB').fontSize(11.5).fillColor('#1f2a24')
       .text(safe(card.title), M + 14, top + 5, { width: innerW });

      let cy = top + headH + 5;
      lines.forEach(([label, value], li) => {
        // One flowing paragraph, label then value, via pdfkit's `continued`.
        // Drawing the value in its own column instead gave every wrapped line a
        // hanging indent under the label — Kat's sheet wraps back to the margin.
        d.font('sansB').fontSize(8.9).fillColor(pal.ink)
         .text(label + ' ', M + 14, cy, { width: innerW, continued: true });
        d.font('sans').fontSize(8.9).fillColor('#23312a')
         .text(safe(value), { width: innerW, continued: false });
        cy += lineH[li];
        if (li < lines.length - 1) {
          // The hairline between rows is what makes the scan read as a table of
          // four, rather than one paragraph with bold words in it.
          d.save().moveTo(M + 10, cy - 2.5).lineTo(M + CW - 10, cy - 2.5)
            .lineWidth(0.5).stroke('#ffffff').restore();
        }
      });
      this.y = top + h + 9;
    });
    if (o.note) {
      this.need(26);
      d.font('sansI').fontSize(8).fillColor(MUTED)
       .text(safe(o.note), M + 4, this.y, { width: CW - 8 });
      this.y = d.y + 8;
    }
  }

  footerAndWatermark(pageNo, total, footerText) {
    const d = this.doc;
    if (this.draft) {
      d.save();
      d.rotate(-32, { origin: [PW / 2, PH / 2] });
      d.font('sansB').fontSize(78).fillColor(RED).opacity(0.075)
       .text('DRAFT', 0, PH / 2 - 60, { width: PW, align: 'center', lineBreak: false });
      d.font('sansB').fontSize(15).fillColor(RED).opacity(0.075)
       .text('NOT YET PUBLISHED TO PARENTS', 0, PH / 2 + 32,
             { width: PW, align: 'center', characterSpacing: 2, lineBreak: false });
      d.opacity(1).restore();
    }
    /* The footer sits BELOW the bottom margin. pdfkit auto-paginates whenever
       text is drawn past that margin, so writing one here quietly appended a
       blank page per footer (a 4-page plan came out 12 pages). Drop the margin
       for the duration and put it back. */
    const bm = d.page.margins.bottom;
    d.page.margins.bottom = 0;
    d.save();
    d.font('sans').fontSize(7.4).fillColor(MUTED)
     .text(safe(footerText), M, PH - M + 2, { width: CW * 0.6, lineBreak: false });
    if (this.draft) {
      d.font('sansB').fontSize(7.4).fillColor(RED)
       .text('DRAFT — not yet published to parents', M, PH - M + 2,
             { width: CW, align: 'center', lineBreak: false });
    }
    d.font('sans').fontSize(7.4).fillColor(MUTED)
     .text(`${pageNo} / ${total}`, M, PH - M + 2, { width: CW, align: 'right', lineBreak: false });
    d.restore();
    d.page.margins.bottom = bm;
  }
}

// ── content blocks ──────────────────────────────────────────────────────────

function drawBullets(doc, items, x, y, w, colour, size, measureOnly) {
  let cy = y;
  doc.font('sans').fontSize(size);
  for (const it of items) {
    const t = safe(it);
    const h = doc.heightOfString(t, { width: w - 12 });
    if (!measureOnly) {
      doc.save().circle(x + 3, cy + size * 0.55, 2).fill(colour).restore();
      doc.font('sans').fontSize(size).fillColor(BODY).text(t, x + 12, cy, { width: w - 12 });
    }
    cy += h + 3.5;
  }
  return cy - y;
}

function chipRows(doc, items, x, y, w, cw, measureOnly) {
  let cx = x, cy = y, rows = 1;
  for (const it of items) {
    doc.font('sans').fontSize(8);
    const tw = Math.min(doc.widthOfString(safe(it)), w - 14);
    const need = tw + 14;
    if (cx > x && cx + need > x + w) { cx = x; cy += 19; rows++; }
    if (!measureOnly) chip(doc, it, cx, cy, w, '#ffffff', LINE, cw.ink);
    cx += need + 5;
  }
  return rows * 19 - 4;
}

/* Intentions live in two shapes and both are still in the table: the b181 jsonb
 * `intentions` keyed by area, and the older flat text[] `learning_intentions`.
 * Print whichever the plan has rather than teaching the page two layouts. */
function intentionItems(plan) {
  // b302 — parsed by the shared reader (src/lib/term-plan-view.js) rather than
  // by a fourth private copy. The PRECEDENCE here stays grouped-first, which is
  // a layout choice and not a disagreement: this page prints intentions under
  // their area headings when areas exist, and a plan that has both columns got
  // the flat one derived from the grouped one by PUT /termly/plan, so the two
  // orders resolve to the same sentences either way.
  const byArea = TPV.groupedIntentions(plan);
  const keys = Object.keys(byArea);
  if (keys.length) {
    return keys.map(area => ({
      area,
      lines: byArea[area].map(s => s.text || s.code || '').filter(Boolean),
    }));
  }
  const flat = TPV.intentionList(plan);
  return flat.length ? [{ area: null, lines: flat }] : [];
}

function drawIntentions(doc, groups, x, y, w, cw, measureOnly) {
  let cy = y;
  for (const g of groups) {
    if (g.area) {
      if (!measureOnly) tinyCaps(doc, g.area, x, cy, w, cw.a);
      cy += 10;
    }
    cy += drawBullets(doc, g.lines, x, cy, w, cw.b, 9, measureOnly) + 5;
  }
  return cy - y - 5;
}

/* The activities. Two rooms plan two different ways and both must print:
 *   · Baby Room  — termly_plan_days: a five-day named rhythm per week (b245)
 *   · Pre-school — termly_plan_weeks: cards + activities per week (b181)
 * A plan with neither says so rather than printing an empty box. */
/* b329 — the plans are written a fortnight at a time, so weeks 1 and 2 carry the
 * same activities. Print each pair once as "Weeks 1–2"; a pair whose two weeks
 * differ still prints as two weeks, and a lone week (an odd week at the end, or
 * half of a pair left empty) prints on its own. */
function fortnights(nos, sigOf) {
  const have = new Set(nos);
  const blocks = [...new Set(nos.map(n => Math.ceil(n / 2)))].sort((a, b) => a - b);
  const out = [];
  for (const b of blocks) {
    const pair = [2 * b - 1, 2 * b].filter(n => have.has(n));
    if (pair.length === 2 && sigOf(pair[0]) === sigOf(pair[1])) out.push(pair);
    else pair.forEach(n => out.push([n]));
  }
  return out;
}
function fridayOf(v) {
  const s = ymd(v); if (!s) return '';
  const d = new Date(s + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 4);
  return d.toISOString().slice(0, 10);
}
function unitHeading(unit, wcOf) {
  const first = unit[0], last = unit[unit.length - 1];
  const a = wcOf.get(first), b = wcOf.get(last);
  if (unit.length === 1) return [`Week ${first}`, a ? `week beginning ${shortDate(a)}` : ''];
  return [`Weeks ${first}–${last}`, a && b ? `${shortDate(a)} – ${shortDate(fridayOf(b))}` : ''];
}

function drawWeeks(sheet, t) {
  const doc = sheet.doc, cw = sheet.cw;
  const days = (t.days || []).filter(d => d.title || (d.activities || []).length || (d.resource_cards || []).length);
  const weeks = t.weeks || [];
  const wcOf = new Map(weeks.map(w => [w.week_no, w.week_commencing]));

  if (days.length) {
    const byWeek = new Map();
    for (const d of days) {
      if (!byWeek.has(d.week_no)) byWeek.set(d.week_no, []);
      byWeek.get(d.week_no).push(d);
    }
    const colW = (CW - 4 * 6) / 5;
    const daySig = no => JSON.stringify(byWeek.get(no)
      .slice().sort((a, b) => a.weekday - b.weekday)
      .map(d => [d.weekday, d.category, d.title,
                 (d.activities || []).map(a => a.name), (d.resource_cards || []).map(c => c.title)]));
    const units = fortnights([...byWeek.keys()], daySig);

    for (const unit of units) {
      const no = unit[0];
      const list = byWeek.get(no).sort((a, b) => a.weekday - b.weekday);
      // Tallest of the five cells decides the row height, so the boxes line up.
      let cellH = 46;
      for (const d of list) {
        const extras = [
          ...(d.activities || []).map(a => a.name).filter(n => n && n !== d.title),
          ...(d.resource_cards || []).map(c => '◇ ' + c.title),
        ];
        let h = 17 + tinyCapsH(doc, d.category || '', colW - 12) + 3;
        doc.font('sans').fontSize(7.6);
        h += doc.heightOfString(safe(d.title || ''), { width: colW - 12 });
        for (const e of extras) h += doc.heightOfString(safe(e), { width: colW - 12 }) + 2;
        cellH = Math.max(cellH, h + 9);
      }
      sheet.need(cellH + 24);
      sheet.weekHeading(...unitHeading(unit, wcOf));

      let cx = M;
      for (let i = 0; i < 5; i++) {
        const d = list.find(x => x.weekday === i + 1);
        panel(doc, cx, sheet.y, colW, cellH, { fill: PAPER, stroke: LINE, topbar: cw.b, r: 7 });
        if (d) {
          doc.font('sansB').fontSize(8).fillColor(INK)
             .text(safe(d.weekday_name || ''), cx + 6, sheet.y + 7, { width: colW - 12, lineBreak: false });
          const catH = tinyCaps(doc, d.category || '', cx + 6, sheet.y + 17, colW - 12, cw.a);
          let ty = sheet.y + 17 + catH + 3;
          doc.font('sans').fontSize(7.6).fillColor(BODY)
             .text(safe(d.title || ''), cx + 6, ty, { width: colW - 12 });
          ty = doc.y + 1;
          for (const a of (d.activities || [])) {
            if (!a.name || a.name === d.title) continue;
            doc.font('sans').fontSize(7.2).fillColor(MUTED)
               .text(safe(a.name), cx + 6, ty, { width: colW - 12 }); ty = doc.y + 1;
          }
          for (const c of (d.resource_cards || [])) {
            doc.font('sans').fontSize(7.2).fillColor(MUTED)
               .text('◇ ' + safe(c.title), cx + 6, ty, { width: colW - 12 }); ty = doc.y + 1;
          }
        } else {
          doc.font('sansI').fontSize(7.4).fillColor(LINE)
             .text('—', cx + 6, sheet.y + 20, { width: colW - 12, lineBreak: false });
        }
        cx += colW + 6;
      }
      sheet.y += cellH + 9;
    }
    return true;
  }

  const useful = weeks.filter(w => (w.activities || []).length || (w.resource_cards || []).length);
  if (!useful.length) return false;

  const colW = (CW - 8) / 2;
  const usefulByNo = new Map(useful.map(w => [w.week_no, w]));
  const weekSig = no => {
    const w = usefulByNo.get(no);
    const notes = w.notes && !/^Pre-filled from the setting/i.test(w.notes) ? w.notes : '';
    // b332 — the adult's role is part of what makes two weeks the same week. A
    // fortnight whose halves say different things about the adult is two weeks.
    return JSON.stringify([(w.activities || []).map(a => [a.name, a.description]),
                           (w.resource_cards || []).map(c => c.title || c.slug), notes,
                           w.role_of_adult || '']);
  };
  for (const unit of fortnights([...usefulByNo.keys()], weekSig)) {
    const w = usefulByNo.get(unit[0]);
    const cells = [
      ...(w.activities || []).map(a => ({ kind: null, name: a.name, desc: a.description })),
      ...(w.resource_cards || []).map(c => ({ kind: 'Always available', name: c.title || c.slug })),
    ].filter(c => c.name);
    if (!cells.length) continue;

    // Measure every cell, then take the row heights two at a time.
    const hs = cells.map(c => {
      doc.font('sansB').fontSize(8.8);
      let h = 10 + doc.heightOfString(safe(c.name), { width: colW - 16 });
      if (c.kind) h += 9;
      if (c.desc) {
        doc.font('sans').fontSize(7.6);
        h += doc.heightOfString(safe(String(c.desc).slice(0, 170)), { width: colW - 16 }) + 2;
      }
      return h + 9;
    });
    // Ask for the heading plus the first row only. Asking for the whole week
    // (`total`) pushes a nearly-full page over for a week that would have
    // straddled the break perfectly happily.
    sheet.need(24 + Math.max(hs[0], hs[1] || 0) + 5);
    sheet.weekHeading(...unitHeading(unit, wcOf));

    for (let i = 0; i < cells.length; i += 2) {
      const rowH = Math.max(hs[i], hs[i + 1] || 0);
      sheet.need(rowH + 5);
      for (let k = 0; k < 2; k++) {
        const c = cells[i + k]; if (!c) break;
        const cx = M + k * (colW + 8);
        const isCard = !!c.kind;
        panel(doc, cx, sheet.y, colW, rowH,
          { fill: isCard ? cw.tint : PAPER, stroke: LINE, accent: isCard ? cw.a : cw.b, r: 7 });
        let ty = sheet.y + 6;
        if (c.kind) { tinyCaps(doc, c.kind, cx + 12, ty, colW - 16, cw.a); ty += 9; }
        doc.font('sansB').fontSize(8.8).fillColor(INK)
           .text(safe(c.name), cx + 12, ty, { width: colW - 20 });
        if (c.desc) {
          doc.font('sans').fontSize(7.6).fillColor(MUTED)
             .text(safe(String(c.desc).slice(0, 170)), cx + 12, doc.y + 1, { width: colW - 20 });
        }
      }
      sheet.y += rowH + 5;
    }
    /* b332 — the adult's role, printed once per fortnight. The baby room has
       carried this per day since b245; this is the same thing for a room that
       plans in weeks, and it is the "how" the report says the pre-school plan
       was missing. Tinted so it reads as pedagogy rather than as another
       activity. */
    if (w.role_of_adult && String(w.role_of_adult).trim()) {
      const txt = safe(w.role_of_adult);
      doc.font('sans').fontSize(8);
      const th = doc.heightOfString(txt, { width: CW - 40 });
      const h = 12 + 9 + th + 10;
      sheet.need(h + 4);
      panel(doc, M, sheet.y, CW, h, { fill: cw.tint, stroke: LINE, accent: cw.a, r: 7 });
      tinyCaps(doc, 'Role of the adult', M + 16, sheet.y + 9, CW - 32, cw.a);
      doc.font('sans').fontSize(8).fillColor(BODY)
         .text(txt, M + 16, sheet.y + 20, { width: CW - 40 });
      sheet.y += h + 5;
    }
    if (w.notes && !/^Pre-filled from the setting/i.test(w.notes)) {
      doc.font('sansI').fontSize(7.8).fillColor(MUTED);
      const nh = doc.heightOfString(safe(w.notes), { width: CW - 6 });
      sheet.need(nh + 4);
      doc.text(safe(w.notes), M + 4, sheet.y, { width: CW - 6 });
      sheet.y += nh + 4;
    }
    sheet.y += 4;
  }
  return true;
}

// ── one half-term ───────────────────────────────────────────────────────────
function renderTerm(sheet, t, roomName) {
  const doc = sheet.doc;
  const plan = t.plan;
  sheet.cw = colourway(t.term && t.term.name);
  const cw = sheet.cw;

  sheet.band(t.term.name, `${dateRange(t.term.start_date, t.term.end_date)}  ·  ${roomName}`);

  if (!plan || !String(plan.theme || '').trim()) {
    sheet.need(40);
    doc.font('sansI').fontSize(10).fillColor(MUTED)
       .text('We have not written this half-term yet. It will appear here once the room team has planned it.',
             M + 4, sheet.y, { width: CW - 8 });
    sheet.y = doc.y + 14;
    return;
  }

  sheet.theme(plan.theme, plan.carry_forward);

  const books = (plan.key_books || []).filter(Boolean).map(safe);
  const songs = (plan.songs || []).filter(Boolean).map(safe);
  if (books.length) {
    sheet.box('Books we will share',
      w => drawBullets(doc, books, 0, 0, w, cw.a, 9.4, true),
      (x, y, w) => drawBullets(doc, books, x, y, w, cw.a, 9.4, false));
  }
  if (songs.length) {
    sheet.box('Songs and rhymes',
      w => chipRows(doc, songs, 0, 0, w, cw, true),
      (x, y, w) => chipRows(doc, songs, x, y, w, cw, false));
  }

  const groups = intentionItems(plan);
  if (groups.length) {
    sheet.box('What we are hoping the children will get from it',
      w => drawIntentions(doc, groups, 0, 0, w, cw, true),
      (x, y, w) => drawIntentions(doc, groups, x, y, w, cw, false));
  }

  const events = (t.events || []).filter(e => e.title);
  if (events.length) {
    const lines = events.map(e =>
      `${shortDate(e.event_date)}  —  ${e.title}${e.location ? ` (${e.location})` : ''}`);
    sheet.box('Dates in this half-term',
      w => drawBullets(doc, lines, 0, 0, w, ORANGE, 9, true),
      (x, y, w) => drawBullets(doc, lines, x, y, w, ORANGE, 9, false));
  }

  // ── b521: the planning sheet, in the format Kat wrote ────────────────────
  // Toby: "I wanted it in that exact format ... quite pretty, A4, with light
  // autumn colours." The cards come from the ONE reader (term-plan-view.js
  // focusSheet), either typed into term_plans.focus_activities or derived from
  // the provision grid, so the print and the screen can never disagree.
  // Printed BEFORE the week-by-week detail: this is the page that goes on the
  // wall, the weeks are the working detail behind it.
  const fs_ = TPV.focusSheet(plan);
  if (fs_.cards.length) {
    sheet.need(34);
    doc.save().rect(M, sheet.y + 4, 16, 2.5).fill(cw.a).restore();
    doc.font('sansB').fontSize(10.5).fillColor(cw.a)
       .text('Our activities this half-term', M + 22, sheet.y, { width: CW - 30, lineBreak: false });
    sheet.y += 18;
    sheet.cards(fs_.cards, {
      // Say where a card came from, so nobody mistakes the grid stand-in for
      // somebody's written intent.
      note: fs_.source === 'grid'
        ? 'These cards are read straight from the continuous-provision grid, so the Implementation line '
          + 'is the room\u2019s own plan text. Intent, Impact and Adult Role are blank because nobody has '
          + 'written them yet \u2014 add them on the Planning sheet and they will print here.'
        : null,
    });
  }

  // The weeks are the long part, so they are NOT wrapped in a measured box —
  // they flow, and each week block asks for its own room.
  sheet.need(34);
  doc.save().rect(M, sheet.y + 4, 16, 2.5).fill(cw.a).restore();
  doc.font('sansB').fontSize(10.5).fillColor(cw.a)
     .text('What we will be doing', M + 22, sheet.y, { width: CW - 30, lineBreak: false });
  sheet.y += 18;
  if (!drawWeeks(sheet, t)) {
    doc.font('sansI').fontSize(9).fillColor(MUTED)
       .text('The week-by-week detail for this half-term is still being written.',
             M + 4, sheet.y, { width: CW - 8 });
    sheet.y = doc.y + 8;
  }

  if (plan.evaluation) {
    sheet.box('Looking back',
      w => { doc.font('sans').fontSize(9); return doc.heightOfString(safe(plan.evaluation), { width: w }); },
      (x, y, w) => doc.font('sans').fontSize(9).fillColor(BODY)
                      .text(safe(plan.evaluation), x, y, { width: w }));
  }
}

// ── cover (year pack only) ──────────────────────────────────────────────────
function renderCover(sheet, doc0) {
  const doc = sheet.doc, d = doc0;
  let y = 150;
  doc.font('serifB').fontSize(31).fillColor(HOUSE.a)
     .text('Our year of planning', M, y, { width: CW, align: 'center' });
  y = doc.y + 10;
  doc.font('sansB').fontSize(14).fillColor(BLUE)
     .text(safe(d.academicYear), M, y, { width: CW, align: 'center', lineBreak: false });
  y += 20;
  doc.font('sansB').fontSize(12.5).fillColor(ORANGE)
     .text(safe(d.roomName), M, y, { width: CW, align: 'center', lineBreak: false });
  y += 40;

  const blurb = [
    'This is what we are planning for your child this year — the theme for each half-term, the books ' +
    'we will read together, the songs we will sing, what we are hoping the children will get from it, ' +
    'and the activities behind it.',
    'It is the same plan the room team works from. A plan is a starting point, not a timetable: we ' +
    "follow the children's interests, so what actually happens in the room will always include things " +
    'that are not on these pages.',
  ];
  doc.font('sans').fontSize(10.2).fillColor(BODY);
  for (const p of blurb) {
    doc.text(safe(p), M + 55, y, { width: CW - 110, align: 'left' });
    y = doc.y + 9;
  }

  // A swatch per half-term: the colour, the name, and the theme it holds.
  y += 22;
  const sw = (CW - 2 * 10) / 3, sh = 52;
  d.terms.forEach((t, i) => {
    const c = colourway(t.term.name);
    const cx = M + (i % 3) * (sw + 10);
    const cy = y + Math.floor(i / 3) * (sh + 10);
    gradientBand(doc, cx, cy, sw, sh, c.a, c.b, 8);
    doc.font('sansB').fontSize(10).fillColor('#ffffff')
       .text(safe(t.term.name), cx + 10, cy + 9, { width: sw - 20, lineBreak: false });
    doc.font('sans').fontSize(8).fillColor('#ffffff').opacity(0.95)
       .text(safe(t.plan && t.plan.theme ? t.plan.theme : 'still to be planned'),
             cx + 10, cy + 24, { width: sw - 20, height: 22 });
    doc.opacity(1);
  });
  y += Math.ceil(d.terms.length / 3) * (sh + 10) + 18;

  /* b332 — the curriculum intent, on the cover of the year pack.
   *
   * Only ever the PUBLISHED intent (the route passes nothing else), because the
   * moment this file is saved and forwarded it is out of our hands.
   *
   * It is measured against what is left of the cover rather than assumed to
   * fit: half a page of intent plus six swatches plus the draft box does not
   * always come to less than one side of A4, and a paragraph that runs off the
   * bottom of the cover is worse than one on the following page. */
  if (d.intent && (d.intent.intent || d.intent.sequence_rationale)) {
    const parts = [];
    if (d.intent.intent) parts.push(['What we want children to leave with', d.intent.intent]);
    if (d.intent.sequence_rationale) parts.push(['Why this order', d.intent.sequence_rationale]);

    const innerW = CW - 44;
    const measure = () => {
      let h = 14;
      for (const [label, body] of parts) {
        doc.font('sansB').fontSize(9);
        h += 12;
        doc.font('sans').fontSize(9.2);
        h += doc.heightOfString(safe(body), { width: innerW }) + 9;
      }
      return h + 4;
    };
    const panelH = measure();
    const draftBoxH = sheet.draft ? 56 : 0;
    if (y + panelH + draftBoxH > BOTTOM) {
      // Its own page, immediately after the cover and before the half-terms.
      sheet.newPage();
      y = M + 6;
      doc.font('serifB').fontSize(20).fillColor(HOUSE.a)
         .text('Our curriculum', M, y, { width: CW, align: 'center' });
      y = doc.y + 12;
    }
    panel(doc, M, y, CW, panelH, { fill: HOUSE.tint, stroke: LINE, accent: HOUSE.a, r: 9 });
    let ty = y + 12;
    for (const [label, body] of parts) {
      tinyCaps(doc, label, M + 22, ty, innerW, HOUSE.a);
      ty += 12;
      doc.font('sans').fontSize(9.2).fillColor(BODY).text(safe(body), M + 22, ty, { width: innerW });
      ty = doc.y + 9;
    }
    y += panelH + 16;
    sheet.y = y;
  }

  if (sheet.draft) {
    doc.roundedRect(M + 40, y, CW - 80, 46, 8).lineWidth(1.6).stroke(RED);
    doc.lineWidth(1);
    doc.font('sansB').fontSize(10).fillColor(RED)
       .text('DRAFT — not yet published to parents', M + 50, y + 11,
             { width: CW - 100, align: 'center', lineBreak: false });
    doc.font('sans').fontSize(8.2).fillColor(RED)
       .text('Some half-terms in this pack have not been published. Publish them in Wren before sending it out.',
             M + 50, y + 26, { width: CW - 100, align: 'center' });
  }
}

// ── document ────────────────────────────────────────────────────────────────
/**
 * doc = {
 *   roomName, academicYear, scope: 'term' | 'year', anyDraft,
 *   terms: [{ term:{name,start_date,end_date}, plan, weeks, days, events }],
 *   setting: { name, address, phone, email },
 * }
 */
function planPdf(input) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDoc({ size: 'A4', margin: M, bufferPages: true,
                               info: { Title: `${input.roomName} planning`, Author: 'Your Nursery' } });
      registerFonts(doc);
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const sheet = new Sheet(doc, !!input.anyDraft);

      if (input.scope === 'year') {
        renderCover(sheet, input);
        input.terms.forEach(t => { sheet.newPage(); renderTerm(sheet, t, input.roomName); });
      } else {
        input.terms.forEach((t, i) => { if (i) sheet.newPage(); renderTerm(sheet, t, input.roomName); });
      }

      // Closing block, on whatever page we finished on.
      const S = input.setting || {};
      sheet.need(52);
      doc.save().moveTo(M, sheet.y + 4).lineTo(M + CW, sheet.y + 4).lineWidth(1.4).stroke(LINE).restore();
      // b329 — measured and placed word by word. `continued` + align:'center'
      // centres each coloured run on its own, so the three words overprinted.
      const nameRuns = [['Little ', INK], ['Angels ', BLUE], ['Day Nursery', ORANGE]];
      doc.font('sansB').fontSize(9.5);
      const nameY = sheet.y + 14;
      const nameH = doc.currentLineHeight(true);
      let nameX = M + (CW - nameRuns.reduce((s, [txt]) => s + doc.widthOfString(txt), 0)) / 2;
      for (const [txt, colour] of nameRuns) {
        doc.fillColor(colour).text(txt, nameX, nameY, { lineBreak: false });
        nameX += doc.widthOfString(txt);
      }
      doc.font('sans').fontSize(8).fillColor(MUTED)
         .text(safe(`${S.address || '123 Example Lane, Your Town, AB1 2CD'}  ·  Monday to Friday, 8am – 6pm`),
               M, nameY + nameH + 3, { width: CW, align: 'center' })
         .text(safe(`${S.email || 'info@example-nursery.co.uk'}  ·  ${S.phone || '020 7946 0000'}`),
               M, doc.y + 2, { width: CW, align: 'center' });

      // Footers + watermarks last, over the buffered pages, so every page gets
      // one including the ones pdfkit added while text was flowing.
      const footText = input.scope === 'year'
        ? `${input.roomName} · ${input.academicYear}`
        : `${input.roomName} · ${input.terms[0] ? input.terms[0].term.name : ''} ${input.academicYear}`;
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        sheet.footerAndWatermark(i + 1, range.count, footText);
      }
      doc.flushPages();
      doc.end();
    } catch (e) { reject(e); }
  });
}

function pdfFilename(d) {
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const base = d.scope === 'year'
    ? `planning-${slug(d.roomName)}-${slug(d.academicYear)}`
    : `planning-${slug(d.roomName)}-${slug(d.terms[0] && d.terms[0].term.name)}-${slug(d.academicYear)}`;
  return `${base}${d.anyDraft ? '-DRAFT' : ''}.pdf`;
}

module.exports = { planPdf, pdfFilename, colourway, ymd, longDate, shortDate, HAS_TTF };
