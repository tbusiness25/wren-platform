'use strict';
/**
 * invoice-pdf.js — b216 (2026-08-24)
 *
 * The invoice as a PDF, laid out the way EyLog laid it out, because that is the
 * bill this nursery's families have been reading for years:
 *
 *   nursery header · child + bill payer · period · itemised lines ·
 *   funded hours as their own £0.00 row · totals · payment terms · payments
 *
 * It renders what src/lib/eyman-invoice-model.js already built. No arithmetic
 * happens in here at all: the total printed is invoices.amount_pence, and every
 * line comes from the stored line_items. A renderer that recomputes is a second
 * source of truth, and the second one is always the one that is wrong.
 *
 * pdfkit, the same stack the rest of Wren's PDFs use (owner-digest-pdf.js,
 * keepsake.js, data-governance.js) — no new dependency.
 */

const PDFDoc = require('pdfkit');

// 2026-09-28 — pastel, and matched to the parent letter so a bill and a letter look like they
// came from the same nursery. INK/MUTED went slightly warm; the two wash tints are what a
// parent actually notices.
const INK    = '#20303d';
const MUTED  = '#6b7f8f';
const RULE   = '#dce7ee';
const BRAND  = '#4a9abf';
const GOOD   = '#15803d';
const SKY    = '#eef7fb';   // pale blue wash — header band, totals
const CREAM  = '#fdf4e9';   // pale cream wash — the how-to-pay block
const ACCENT = '#e07820';   // the letter's orange, used once

const PARENT_PORTAL_INVOICES = process.env.PARENT_PORTAL_INVOICES_URL
  || 'https://parents.example-nursery.co.uk/welcome/payments';

const M = 50;                     // page margin
const PAGE_W = 595.28;            // A4 portrait
const CONTENT_W = PAGE_W - M * 2;

/**
 * pdfkit's built-in fonts are WinAnsi-encoded, so an en-dash or a £ inside a
 * name renders fine but emoji and arrows come out as mojibake. Same rule as
 * owner-digest-pdf.js: spell out what we can, drop what we cannot.
 */
const UNRENDERABLE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}]/gu;

function safe(v) {
  return safeInline(v).trim();
}

/**
 * safe(), but WITHOUT the trim — for a fragment being printed mid-line.
 * Trimming each fragment of a continued run eats the space before the URL, so
 * "Term dates and closures: https://…" prints as "…closures:https://…".
 */
function safeInline(v) {
  return String(v == null ? '' : v)
    .replace(/×/g, 'x')
    .replace(UNRENDERABLE, '')
    .replace(/[ \t]{2,}/g, ' ');
}

function money(pence) {
  const n = Math.round(Number(pence) || 0);
  const neg = n < 0;
  const s = (Math.abs(n) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (neg ? '-£' : '£') + s;
}

function longDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* ── small drawing helpers ────────────────────────────────────────────────── */

function rule(doc, y, colour = RULE, width = 1) {
  doc.save().strokeColor(colour).lineWidth(width)
     .moveTo(M, y).lineTo(PAGE_W - M, y).stroke().restore();
}

function label(doc, text, x, y, w, opts = {}) {
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
     .text(safe(text).toUpperCase(), x, y,
           { width: w, characterSpacing: 0.4, align: opts.align || 'left' });
}

function value(doc, text, x, y, w, opts = {}) {
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 9.5)
     .fillColor(opts.colour || INK)
     .text(safe(text), x, y, { width: w, align: opts.align || 'left' });
}

/** Start a new page when the next block will not fit, keeping the same margins. */
function ensure(doc, needed) {
  if (doc.y + needed > doc.page.height - 64) { doc.addPage(); doc.y = M; }
  return doc.y;
}

/* ── sections ─────────────────────────────────────────────────────────────── */

// Resolved relative to this file so it works in the container (/app/public) and on the host
// alike — the first attempt hard-coded the host path and silently rendered no logo at all.
const LOGO_PATH = process.env.INVOICE_LOGO_PATH
  || require('path').join(__dirname, '..', '..', 'public', 'little-angels-logo.png');

function header(doc, st, nursery) {
  // A pale band behind the masthead. Drawn first so everything else sits on top.
  doc.save().fillColor(SKY).rect(0, 0, PAGE_W, 112).fill().restore();

  let y = M;
  // The logo, if it is where we expect it. Never fatal — an invoice without a logo is still
  // an invoice, an invoice that failed to render is not.
  let textX = M;
  try {
    if (require('fs').existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, M, y - 6, { fit: [86, 34] });
      textX = M + 96;
    }
  } catch (e) { /* no logo, carry on */ }

  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK)
     .text(safe(nursery.name), textX, y, { width: CONTENT_W * 0.62 - (textX - M) });
  y = doc.y + 2;
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
     .text(safe(nursery.address), textX, y, { width: CONTENT_W * 0.62 - (textX - M) });
  const contact = [nursery.phone, nursery.email].filter(Boolean).join('  ·  ');
  if (contact) doc.text(safe(contact), textX, doc.y + 1, { width: CONTENT_W * 0.62 - (textX - M) });
  // b299 — the two registrations EyLog carries. A parent claiming funding needs
  // the Ofsted number to hand, and the company number is what makes this a UK
  // invoice rather than a receipt.
  const regs = [
    nursery.company_registration ? `UK Company Registration ${nursery.company_registration}` : null,
    nursery.ofsted_registration ? `Ofsted Registration ${nursery.ofsted_registration}` : null,
  ].filter(Boolean).join('  ·  ');
  if (regs) doc.font('Helvetica').fontSize(7.6).fillColor(MUTED)
               .text(safe(regs), textX, doc.y + 2, { width: CONTENT_W * 0.62 - (textX - M) });
  const leftBottom = doc.y;

  // Right-hand identity block: what this document is, and which one it is.
  const rx = M + CONTENT_W * 0.62, rw = CONTENT_W * 0.38;
  doc.font('Helvetica-Bold').fontSize(19).fillColor(BRAND)
     .text('INVOICE', rx, M, { width: rw, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
     .text(safe(st.invoice_number), rx, doc.y + 1, { width: rw, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
     .text(safe(st.payment_status) + (st.invoice_status ? '  ·  ' + safe(st.invoice_status) : ''),
           rx, doc.y + 2, { width: rw, align: 'right' });

  doc.y = Math.max(leftBottom, doc.y) + 12;
  rule(doc, doc.y, BRAND, 2);
  doc.y += 14;
}

function parties(doc, st) {
  const y0 = doc.y;
  const colW = CONTENT_W / 2 - 10;

  label(doc, 'Invoice for', M, y0, colW);
  value(doc, st.child_name || '—', M, doc.y + 1, colW, { bold: true, size: 11 });
  const sub = [st.room, st.child_urn ? 'URN ' + st.child_urn : null].filter(Boolean).join('  ·  ');
  if (sub) value(doc, sub, M, doc.y + 1, colW, { colour: MUTED, size: 8.5 });
  const leftBottom = doc.y;

  const rx = M + CONTENT_W / 2 + 10;
  // b299 — EyLog addresses the bill to BOTH parents, each above the family
  // address. Wren holds one address, so it is printed once under the names
  // rather than repeated — repeating it reads as two different households.
  const parents = (st.parents || []).filter(p => p.name);
  if (parents.length) {
    label(doc, parents.length > 1 ? 'Bill payers' : 'Bill payer', rx, y0, colW);
    let py = doc.y + 1;
    for (const p of parents) {
      value(doc, p.name, rx, py, colW, { bold: true, size: 10 });
      py = doc.y + 1;
    }
    const addr = (parents[0].address || []).filter(Boolean);
    for (const line of addr) {
      value(doc, line, rx, py, colW, { colour: MUTED, size: 8.5 });
      py = doc.y + 1;
    }
    doc.y = py;
  } else {
    label(doc, 'Bill payer', rx, y0, colW);
    value(doc, st.bill_payer_name || st.bill_payer_email || '—', rx, doc.y + 1, colW, { bold: true, size: 10 });
    if (st.bill_payer_name && st.bill_payer_email) {
      value(doc, st.bill_payer_email, rx, doc.y + 1, colW, { colour: MUTED, size: 8.5 });
    }
  }

  doc.y = Math.max(leftBottom, doc.y) + 14;
}

// b299 — a BOXED panel, the way EyLog prints it: the invoice number sits inside
// the box with the three dates rather than only up in the letterhead, so the four
// facts a parent quotes on the phone are one block.
function dateStrip(doc, st) {
  const d = st.dates || {};
  const cells = [
    ['Invoice number', st.invoice_number || '—'],
    ['Invoice date', longDate(d.invoice_date)],
    ['Due date', longDate(d.due_date)],
    ['Period', d.from_date && d.to_date
      ? `${longDate(d.from_date)} – ${longDate(d.to_date)}`
      : (st.period_label || '—')],
  ];
  if (st.reference && st.reference !== st.invoice_number) cells.push(['Reference', st.reference]);

  const y0 = doc.y;
  const H = 36;
  const w = CONTENT_W / cells.length;
  doc.save()
     .fillColor('#f8fafc').rect(M, y0 - 4, CONTENT_W, H).fill()
     .strokeColor('#cbd5e1').lineWidth(0.8).rect(M, y0 - 4, CONTENT_W, H).stroke()
     .restore();
  cells.forEach((c, i) => {
    const x = M + i * w + 7;
    if (i) {
      doc.save().strokeColor('#e2e8f0').lineWidth(0.6)
         .moveTo(M + i * w, y0 - 4).lineTo(M + i * w, y0 - 4 + H).stroke().restore();
    }
    label(doc, c[0], x, y0 + 1, w - 12);
    value(doc, c[1], x, y0 + 11, w - 12, { size: 8.4, bold: true });
  });
  doc.y = y0 + H + 8;
}

function itemsTable(doc, st) {
  const cols = [
    { key: 'item',        title: 'Item',        w: CONTENT_W * 0.26 },
    { key: 'description', title: 'Description', w: CONTENT_W * 0.40 },
    { key: 'quantity',    title: 'Quantity',    w: CONTENT_W * 0.16 },
    { key: 'amount',      title: 'Amount',      w: CONTENT_W * 0.18, align: 'right' },
  ];

  const head = () => {
    const y = doc.y;
    let x = M;
    for (const c of cols) { label(doc, c.title, x, y, c.w - 6); x += c.w; }
    doc.y = y + 12;
    rule(doc, doc.y, '#cbd5e1', 1);
    doc.y += 6;
  };

  ensure(doc, 60);
  head();

  if (!st.items || !st.items.length) {
    value(doc, 'This invoice has no stored breakdown — it predates itemised billing, or was imported. '
             + 'The total below is the invoice\'s own figure.', M, doc.y, CONTENT_W, { colour: MUTED, size: 8.5 });
    doc.y += 24;
    return;
  }

  for (const it of st.items) {
    const funded = it.kind === 'funded';
    // b225 — a discount is a reduction, so it is set apart from the charges the
    // same way the funded row is. money() already prints it as -£x.xx.
    const discount = it.kind === 'discount';
    const rowTop = doc.y;
    let x = M;
    const cells = [
      { text: it.item || '', bold: funded || discount },
      { text: it.description || '', size: 8.3, colour: MUTED },
      { text: it.quantity || '-', size: 8.8 },
      { text: money(it.amount_pence), align: 'right', bold: true,
        colour: funded ? GOOD : (discount ? BRAND : INK) },
    ];
    // Measure first so a wrapped description cannot overlap the row beneath it.
    let tallest = 0;
    cells.forEach((c, i) => {
      const h = doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(c.size || 9.3)
                   .heightOfString(safe(c.text), { width: cols[i].w - 8 });
      if (h > tallest) tallest = h;
    });
    if (rowTop + tallest + 10 > doc.page.height - 90) { doc.addPage(); doc.y = M; head(); }

    const y = doc.y;
    cells.forEach((c, i) => {
      value(doc, c.text, x, y, cols[i].w - 8,
            { size: c.size || 9.3, bold: c.bold, colour: c.colour, align: cols[i].align });
      x += cols[i].w;
    });
    doc.y = y + tallest + 7;
    rule(doc, doc.y - 3, '#f1f5f9', 0.5);
  }

  // The funded line is the point of the whole layout: hours at £0.00, with the
  // value the government paid stated beside it rather than shown as a minus.
  const funded = (st.items || []).find(i => i.kind === 'funded');
  if (funded && funded.funding_value_pence > 0) {
    doc.y += 4;
    doc.save().fillColor('#f0fdf4').rect(M, doc.y - 3, CONTENT_W, 26).fill().restore();
    value(doc, `Funded hours are free and are shown at £0.00. Government funding covered `
             + `${money(funded.funding_value_pence)} of this month's childcare.`,
          M + 8, doc.y + 3, CONTENT_W - 16, { size: 8.5, colour: GOOD });
    doc.y += 28;
  }

  // b225 — say what the discount came off. A percentage with nothing to
  // multiply is the kind of line that generates a phone call.
  const discounts = (st.discounts && st.discounts.lines) || [];
  if (discounts.length) {
    doc.y += 4;
    const text = discounts.map(d => `${d.item}: ${money(Math.abs(d.amount_pence))} off`
      + (d.basis_pence != null
          ? ` ${d.applies_to === 'invoice_total' ? 'the invoice total' : 'the billable fees'}`
            + ` of ${money(d.basis_pence)}`
          : '')
      + '.').join(' ')
      + (discounts.some(d => d.applies_to !== 'invoice_total')
          ? ' Government-funded hours are never discounted.' : '');
    doc.save().fillColor('#eff6ff').rect(M, doc.y - 3, CONTENT_W, 26).fill().restore();
    value(doc, text, M + 8, doc.y + 3, CONTENT_W - 16, { size: 8.5, colour: BRAND });
    doc.y += 28;
  }
}

/* ── b299: EyLog's two body layouts ───────────────────────────────────────────
 *
 * A private child gets a week-by-week breakdown; a funded child gets a monthly
 * summary and the calculation appendix underneath it. Both are drawn from the
 * blocks src/lib/eyman-invoice-model.js already built — nothing is computed in
 * here, exactly as with itemsTable() above.
 */

// The five numeric columns take 70% between them, which leaves the stub wide
// enough for "Mon - 08:00-18:00" on ONE line. At 85% it wrapped after "Mon -",
// putting each booked day on two lines and the times under the wrong heading.
const HOURS_COLS = () => [
  { key: 'attended',   title: 'Attended hrs',   w: CONTENT_W * 0.14, align: 'right' },
  { key: 'funded',     title: 'Funded hrs',     w: CONTENT_W * 0.13, align: 'right' },
  { key: 'chargeable', title: 'Chargeable hrs', w: CONTENT_W * 0.15, align: 'right' },
  { key: 'unit',       title: 'Unit price',     w: CONTENT_W * 0.13, align: 'right' },
  { key: 'amount',     title: 'Amount',         w: CONTENT_W * 0.15, align: 'right' },
];

/** The five numeric column headings, drawn under a 'Days booked' stub. */
function hoursHead(doc, stubTitle) {
  const cols = HOURS_COLS();
  const stubW = CONTENT_W - cols.reduce((a, c) => a + c.w, 0);
  const y = doc.y;
  label(doc, stubTitle, M, y, stubW - 6);
  let x = M + stubW;
  for (const c of cols) { label(doc, c.title, x, y, c.w - 6, { align: c.align }); x += c.w; }
  doc.y = y + 12;
  rule(doc, doc.y, '#cbd5e1', 1);
  doc.y += 5;
  return { cols, stubW };
}

function weeklyBreakdown(doc, st) {
  const wb = st.weekly_breakdown;
  if (!wb || !wb.weeks || !wb.weeks.length) return false;

  ensure(doc, 80);
  label(doc, 'Weeks in this period', M, doc.y, CONTENT_W);
  doc.y += 13;
  const { cols, stubW } = hoursHead(doc, 'Days booked');

  for (const w of wb.weeks) {
    // A week block is drawn as a unit — its label, its days and its numbers must
    // not be split across a page, or the amount lands under the wrong week.
    const blockH = 16 + w.days.length * 10 + 22;
    if (doc.y + blockH > doc.page.height - 90) {
      doc.addPage(); doc.y = M;
      hoursHead(doc, 'Days booked');
    }

    // Week label band.
    const bandY = doc.y;
    doc.save().fillColor('#f1f5f9').rect(M, bandY - 2, CONTENT_W, 14).fill().restore();
    value(doc, w.label + (w.partial ? '  (part week)' : ''), M + 6, bandY + 1, CONTENT_W - 12,
          { size: 8.4, bold: true });
    doc.y = bandY + 15;

    const rowTop = doc.y;
    // Left stub: the days and their times, one per line.
    let dy = rowTop;
    for (const d of w.days) {
      value(doc, d.label, M + 6, dy, stubW - 12, { size: 8.2, colour: MUTED });
      dy = doc.y + 1;
    }

    // Right: the five figures, on the first line of the block.
    const nums = [
      w.attended_hours.toFixed(2),
      w.funded_hours ? w.funded_hours.toFixed(2) : '—',
      w.chargeable_hours.toFixed(2),
      w.unit_price_label,
      money(w.amount_pence),
    ];
    let x = M + stubW;
    nums.forEach((n, i) => {
      value(doc, n, x, rowTop, cols[i].w - 6,
            { size: 8.6, align: 'right', bold: i === nums.length - 1 });
      x += cols[i].w;
    });

    doc.y = Math.max(dy, rowTop + 12) + 2;
    // Week Total, right-aligned under the Amount column.
    const totalY = doc.y;
    value(doc, 'Week Total', M + stubW, totalY, CONTENT_W - stubW - cols[4].w - 6,
          { size: 8.4, colour: MUTED, align: 'right' });
    value(doc, money(w.amount_pence), PAGE_W - M - cols[4].w + 6, totalY, cols[4].w - 6,
          { size: 9, bold: true, align: 'right' });
    doc.y = totalY + 14;
    rule(doc, doc.y - 4, '#e2e8f0', 0.6);
  }

  // Totals across the weeks, then — only when it differs — the stored total and
  // the reason. A bill whose rows do not add up to its total is the one thing
  // most likely to generate a phone call, so it gets said out loud.
  doc.y += 2;
  const cols2 = HOURS_COLS();
  const stubW2 = CONTENT_W - cols2.reduce((a, c) => a + c.w, 0);
  const ty = doc.y;
  value(doc, 'Total for the weeks shown', M + 6, ty, stubW2 - 12, { size: 8.6, bold: true });
  const totals = [
    wb.total_attended_hours.toFixed(2),
    wb.total_funded_hours ? wb.total_funded_hours.toFixed(2) : '—',
    wb.total_chargeable_hours.toFixed(2),
    wb.unit_price_label,
    money(wb.weeks_total_pence),
  ];
  let x2 = M + stubW2;
  totals.forEach((n, i) => {
    value(doc, n, x2, ty, cols2[i].w - 6, { size: 8.6, align: 'right', bold: i === totals.length - 1 });
    x2 += cols2[i].w;
  });
  doc.y = ty + 16;

  if (st.weekly_reconciles === false) {
    const stored = (st.totals || {}).invoice_total_pence || 0;
    doc.save().fillColor('#f8fafc').rect(M, doc.y - 3, CONTENT_W, 28).fill().restore();
    value(doc,
      `The weeks above are what was delivered. This invoice charges ${money(stored)} — `
      + `${st.averaging_explanation || 'the yearly fee spread evenly across the twelve months'} `
      + `— so a month holding more or fewer weeks than the average still costs the same.`,
      M + 8, doc.y + 3, CONTENT_W - 16, { size: 8.2, colour: MUTED });
    doc.y += 32;
  }
  return true;
}

function monthlySummary(doc, st) {
  const rows = st.monthly_summary;
  if (!rows || !rows.length) return false;

  const cols = [
    { key: 'item',        title: 'Item',        w: CONTENT_W * 0.27 },
    { key: 'description', title: 'Description', w: CONTENT_W * 0.31 },
    { key: 'quantity',    title: 'Quantity',    w: CONTENT_W * 0.14, align: 'right' },
    { key: 'unit',        title: 'Unit price',  w: CONTENT_W * 0.13, align: 'right' },
    { key: 'amount',      title: 'Amount',      w: CONTENT_W * 0.15, align: 'right' },
  ];
  const head = () => {
    const y = doc.y;
    let x = M;
    for (const c of cols) { label(doc, c.title, x, y, c.w - 6, { align: c.align }); x += c.w; }
    doc.y = y + 12;
    rule(doc, doc.y, '#cbd5e1', 1);
    doc.y += 6;
  };

  ensure(doc, 70);
  head();

  for (const r of rows) {
    const funded = r.kind === 'funded';
    const discount = r.kind === 'discount';
    const cells = [
      { text: r.item || '', bold: funded || r.kind === 'charged' },
      { text: r.description || '', size: 8.3, colour: MUTED },
      { text: r.quantity || '-', size: 8.8, align: 'right' },
      { text: r.unit_price_label || '', size: 8.5, colour: MUTED, align: 'right' },
      { text: money(r.amount_pence), align: 'right', bold: true,
        colour: funded ? GOOD : (discount ? BRAND : INK) },
    ];
    let tallest = 0;
    cells.forEach((c, i) => {
      const h = doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(c.size || 9.3)
                   .heightOfString(safe(c.text), { width: cols[i].w - 8 });
      if (h > tallest) tallest = h;
    });
    if (doc.y + tallest + 10 > doc.page.height - 90) { doc.addPage(); doc.y = M; head(); }

    const y = doc.y;
    let x = M;
    cells.forEach((c, i) => {
      value(doc, c.text, x, y, cols[i].w - 8,
            { size: c.size || 9.3, bold: c.bold, colour: c.colour, align: c.align || cols[i].align });
      x += cols[i].w;
    });
    doc.y = y + tallest + 7;
    rule(doc, doc.y - 3, '#f1f5f9', 0.5);
  }
  doc.y += 4;
  return true;
}

/** URLs in free text, so a footer's links survive into the PDF as links. */
const URL_SPLIT = /(https?:\/\/[^\s<>"')]+)/g;
const IS_URL = /^https?:\/\//;          // deliberately NOT global — see below

/**
 * Draw one line of free text, turning any URL in it into a clickable link, and
 * leave doc.y on the line below.
 *
 * Two things here are easy to get wrong and were:
 *   * the LAST part of the run must be `continued: false`. Ending the chain with
 *     a separate empty text() call instead leaves doc.y where it started, so the
 *     next line paints on top of this one — three footer lines came out as one
 *     unreadable overlap.
 *   * IS_URL has no /g flag. A global regex carries lastIndex between calls, so
 *     `URL_SPLIT.test(part)` answers about the wrong position on alternate calls
 *     and links land on the label instead of the address.
 */
function textWithLinks(doc, line, x, y, w, opts = {}) {
  const parts = String(line).split(URL_SPLIT).filter(p => p !== '');
  if (parts.length <= 1) {
    value(doc, line, x, y, w, opts);
    return;
  }
  doc.font('Helvetica').fontSize(opts.size || 8.2);
  parts.forEach((part, i) => {
    const isUrl = IS_URL.test(part);
    const o = { width: w, continued: i < parts.length - 1,
                link: isUrl ? part : null, underline: isUrl };
    doc.fillColor(isUrl ? BRAND : (opts.colour || MUTED));
    if (i === 0) doc.text(safeInline(part), x, y, o);
    else doc.text(safeInline(part), o);
  });
}

function calculationAppendix(doc, st) {
  const a = st.calculation_appendix;
  if (!a) return false;

  ensure(doc, 150);
  rule(doc, doc.y, RULE);
  doc.y += 8;
  label(doc, 'Sample week for invoice calculation', M, doc.y, CONTENT_W);
  doc.y += 13;
  value(doc, a.sample_week_label, M, doc.y, CONTENT_W, { size: 8.6 });
  doc.y += 6;

  // Sample Week Booking Schedule — every weekday, so "not booked" is visible
  // rather than inferred from a gap.
  label(doc, 'Sample week booking schedule', M, doc.y, CONTENT_W);
  doc.y += 12;
  const colW = CONTENT_W / 5;
  const sy = doc.y;
  a.schedule.forEach((d, i) => {
    const x = M + i * colW;
    value(doc, d.short, x, sy, colW - 6, { size: 8.4, bold: true, colour: d.booked ? INK : MUTED });
    value(doc, d.booked ? `${st.session_window ? st.session_window.start : '08:00'}-`
                        + `${st.session_window ? st.session_window.end : '18:00'}`
                        : 'Not booked',
          x, sy + 11, colW - 6, { size: 7.8, colour: MUTED });
  });
  doc.y = sy + 26;

  const bits = [
    ['Sample week attended hours', a.sample_week_attended_hours != null ? a.sample_week_attended_hours.toFixed(2) + ' hrs' : '—'],
    ['Sample week charged hours',  a.sample_week_charged_hours  != null ? a.sample_week_charged_hours.toFixed(2)  + ' hrs' : '—'],
    ['Sample week funded hours',   a.sample_week_funded_hours   != null ? a.sample_week_funded_hours.toFixed(2)   + ' hrs' : '—'],
    ['Unit price', a.unit_price_label || '—'],
    ['Invoice calculation factor', a.invoice_calculation_factor],
    ['Funding calculation factor', a.funding_calculation_factor],
  ];
  const pairW = CONTENT_W / 2 - 8;
  let y = doc.y;
  for (let i = 0; i < bits.length; i += 2) {
    const pair = bits.slice(i, i + 2);
    let rowH = 0;
    pair.forEach((b, j) => {
      const x = M + j * (pairW + 16);
      value(doc, b[0], x, y, pairW * 0.58, { size: 8.4, colour: MUTED });
      const lh = doc.y - y;
      value(doc, b[1], x + pairW * 0.58, y, pairW * 0.42, { size: 8.6, bold: true, align: 'right' });
      rowH = Math.max(rowH, lh, doc.y - y);
    });
    y += Math.max(rowH, 12) + 3;
  }
  doc.y = y + 8;
  return true;
}

/**
 * The rows a weekly breakdown does not already show — meals, consumables, a
 * discount. The childcare and funded rows are deliberately skipped: the week
 * blocks above ARE those rows, and printing them twice makes the invoice look
 * like it is charging for the same thing again.
 */
function extrasTable(doc, st) {
  const rows = (st.items || []).filter(i => i.kind !== 'childcare' && i.kind !== 'funded');
  if (!rows.length) return false;

  ensure(doc, 60);
  doc.y += 4;
  label(doc, 'Also on this invoice', M, doc.y, CONTENT_W);
  doc.y += 13;

  const cols = [CONTENT_W * 0.30, CONTENT_W * 0.38, CONTENT_W * 0.14, CONTENT_W * 0.18];
  for (const r of rows) {
    ensure(doc, 20);
    const y = doc.y;
    const cells = [
      { text: r.item || '', bold: r.kind === 'discount' },
      { text: r.description || '', size: 8.3, colour: MUTED },
      { text: r.quantity || '-', size: 8.6, align: 'right' },
      { text: money(r.amount_pence), align: 'right', bold: true,
        colour: r.kind === 'discount' ? BRAND : INK },
    ];
    let tallest = 0;
    cells.forEach((c, i) => {
      const h = doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(c.size || 9.2)
                   .heightOfString(safe(c.text), { width: cols[i] - 8 });
      if (h > tallest) tallest = h;
    });
    let x = M;
    cells.forEach((c, i) => {
      value(doc, c.text, x, y, cols[i] - 8,
            { size: c.size || 9.2, bold: c.bold, colour: c.colour, align: c.align });
      x += cols[i];
    });
    doc.y = y + tallest + 6;
    rule(doc, doc.y - 2, '#f1f5f9', 0.5);
  }
  doc.y += 4;
  return true;
}

function totals(doc, st) {
  const t = st.totals || {};
  ensure(doc, 110);
  const w = 250, x = PAGE_W - M - w;
  doc.y += 8;

  const row = (lbl, val, opts = {}) => {
    const y = doc.y;
    value(doc, lbl, x, y, w - 100, { size: opts.big ? 10.5 : 9.2, bold: !!opts.big, colour: opts.colour || (opts.big ? INK : MUTED) });
    value(doc, val, x + w - 100, y, 100, { size: opts.big ? 11.5 : 9.2, bold: true, align: 'right', colour: opts.colour || INK });
    doc.y = y + (opts.big ? 17 : 14);
    if (!opts.last) rule(doc, doc.y - 4, '#f1f5f9', 0.5);
  };

  // 2026-09-28 — say plainly which part is this month and which part is late. "Balance before
  // this invoice" told a parent a number without telling them it was overdue.
  if (t.prior_balance_pence > 0) {
    row('Overdue from earlier invoices', money(t.prior_balance_pence), { colour: '#b45309' });
  } else if (t.prior_balance_pence < 0) {
    // invpdf-20261028 — credit on the account is shown, and comes off the total below.
    row('Credit on your account', '-' + money(-t.prior_balance_pence), { colour: '#15803d' });
  }
  row('Invoice total', money(t.invoice_total_pence));
  row('Payments received', t.payments_pence ? '-' + money(t.payments_pence) : money(0));
  doc.save().strokeColor(INK).lineWidth(1.2).moveTo(x, doc.y - 2).lineTo(PAGE_W - M, doc.y - 2).stroke().restore();
  doc.y += 4;
  row('Total due', money(t.total_due_pence), { big: true, last: !(t.credit_remaining_pence > 0) });
  if (t.credit_remaining_pence > 0) {
    row('Credit left on your account', money(t.credit_remaining_pence), { colour: '#15803d', last: true });
  }

  // "View and pay this invoice" — a real clickable annotation, not a picture of a button.
  // Every payment route needs the parent signed in, so this lands on the portal rather than
  // pretending to take a card from a PDF.
  if ((t.total_due_pence || 0) > 0) {
    const bw = 190, bh = 30, bx = PAGE_W - M - bw, by = doc.y + 6;
    doc.save()
       .fillColor(ACCENT).roundedRect(bx, by, bw, bh, 15).fill()
       .fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
       .text('View and pay this invoice', bx, by + 9, { width: bw, align: 'center' })
       .restore();
    doc.link(bx, by, bw, bh, PARENT_PORTAL_INVOICES);
    doc.y = by + bh + 8;
  }

  if (t.settled_without_payment_record) {
    doc.y += 4;
    value(doc, `Marked settled, but only ${money(t.payments_pence)} of ${money(t.invoice_total_pence)} `
             + `is backed by a payment record. Nothing is owed — the payment was not logged against this invoice.`,
          M, doc.y, CONTENT_W, { size: 8, colour: MUTED });
    doc.y += 22;
  }
  doc.y += 6;
}

function workingBlock(doc, st) {
  const w = st.working;
  if (!w) return;
  ensure(doc, 90);
  rule(doc, doc.y, RULE);
  doc.y += 8;
  label(doc, 'How this was worked out', M, doc.y, CONTENT_W);
  doc.y += 12;

  const bits = [
    ['Booked days a week', String(w.days_per_week)],
    ['Booked hours a week', w.booked_hours != null ? w.booked_hours.toFixed(2) + ' hrs' : '—'],
    ['Day rate', money(w.day_rate_pence)],
    ['Funded hours a week', w.funded_weekly_hours != null ? w.funded_weekly_hours.toFixed(2) + ' hrs' : '—'],
    ['Funded hours this month', w.funded_month_hours != null ? w.funded_month_hours.toFixed(2) + ' hrs' : '—'],
    ['Calculation factor', w.eyman_factor_label || ''],
    ['Charge basis', w.charge_basis || ''],
  ];
  // Two columns, advanced by the TALLER of the pair. A fixed row step let a value
  // that wrapped ("52.00 weeks / 12.00 months") run straight into the label
  // beneath it, printing "monthsCharge basis" on a bill.
  const colW = CONTENT_W / 2 - 8;
  let y = doc.y;
  for (let i = 0; i < bits.length; i += 2) {
    const pair = bits.slice(i, i + 2);
    let rowH = 0;
    pair.forEach((b, j) => {
      const x = M + j * (colW + 16);
      value(doc, b[0], x, y, colW * 0.58, { size: 8.4, colour: MUTED });
      const lh = doc.y - y;
      value(doc, b[1], x + colW * 0.58, y, colW * 0.42, { size: 8.6, bold: true, align: 'right' });
      rowH = Math.max(rowH, lh, doc.y - y);
    });
    y += Math.max(rowH, 12) + 3;
  }
  doc.y = y + 8;

  if (st.averaging_explanation) {
    value(doc, st.averaging_explanation, M, doc.y, CONTENT_W, { size: 8.3, colour: MUTED });
    doc.y += 8;
  }
}

function paymentsBlock(doc, st) {
  if (!st.payments || !st.payments.length) return;
  ensure(doc, 70);
  rule(doc, doc.y, RULE);
  doc.y += 8;
  label(doc, 'Payments received', M, doc.y, CONTENT_W);
  doc.y += 14;

  const cols = [CONTENT_W * 0.20, CONTENT_W * 0.18, CONTENT_W * 0.22, CONTENT_W * 0.26, CONTENT_W * 0.14];
  const titles = ['Date', 'Amount', 'Method', 'Reference', 'Status'];
  let x = M;
  titles.forEach((t, i) => { label(doc, t, x, doc.y, cols[i] - 6); x += cols[i]; });
  doc.y += 11;
  rule(doc, doc.y, '#e2e8f0', 0.6);
  doc.y += 5;

  for (const p of st.payments) {
    ensure(doc, 18);
    const y = doc.y;
    const vals = [longDate(p.date), money(p.amount_pence), p.method || '—', p.reference || '—', p.status || '—'];
    x = M;
    vals.forEach((v, i) => { value(doc, v, x, y, cols[i] - 6, { size: 8.5 }); x += cols[i]; });
    doc.y = y + 14;
  }
  doc.y += 4;
}

/**
 * b325 — How to pay.
 *
 * The whole point of the family payment reference is that it is on the bill. A
 * reference a parent has to go and look up is one they will not quote, and a
 * payment with no reference is one somebody reconciles by hand.
 *
 * Drawn ABOVE the payment terms and the footer note, because it is the thing a
 * parent is looking for when they open the PDF. If no bank details have been
 * entered yet the block does not draw at all — an invoice showing an empty sort
 * code is worse than one showing none.
 */
function howToPay(doc, st, nursery) {
  const bank = nursery.bank || {};
  const hasBank = !!(bank.sort_code || bank.account_number);
  const ref = st.family_payment_ref;
  if (!hasBank && !ref) return;

  ensure(doc, 92);
  doc.y += 6;
  rule(doc, doc.y, RULE);
  doc.y += 8;
  label(doc, 'How to pay', M, doc.y, CONTENT_W);
  doc.y += 13;

  if (ref) {
    // The reference is the loudest thing in the block on purpose.
    value(doc, 'Please quote this reference with every payment:', M, doc.y, CONTENT_W,
          { size: 8.6, colour: MUTED });
    doc.y += 2;
    value(doc, safeInline(ref), M, doc.y, CONTENT_W, { size: 14, bold: true, colour: BRAND });
    doc.y += 4;
    value(doc, 'It is the same reference for every child in your family, and it does not change.',
          M, doc.y, CONTENT_W, { size: 8.2, colour: MUTED });
    doc.y += 6;
  }

  if (hasBank) {
    const rows = [
      ['Account name', bank.account_name || nursery.name],
      ['Sort code', bank.sort_code],
      ['Account number', bank.account_number],
      ['Bank', bank.name],
    ].filter(r => r[1]);
    const colW = CONTENT_W / 2 - 8;
    let y = doc.y;
    for (let i = 0; i < rows.length; i += 2) {
      const pair = rows.slice(i, i + 2);
      let rowH = 0;
      pair.forEach((b, j) => {
        const x = M + j * (colW + 16);
        value(doc, b[0], x, y, colW * 0.5, { size: 8.4, colour: MUTED });
        const lh = doc.y - y;
        value(doc, safeInline(b[1]), x + colW * 0.5, y, colW * 0.5,
              { size: 8.8, bold: true, align: 'right' });
        rowH = Math.max(rowH, lh, doc.y - y);
      });
      y += Math.max(rowH, 12) + 3;
    }
    doc.y = y + 4;
  }

  // The Tax-Free Childcare line only appears for a family we know uses it.
  if (st.tfc_payment_reference) {
    value(doc, 'Paying through Tax-Free Childcare? Your childcare reference with HMRC is '
             + `${safeInline(st.tfc_payment_reference)} — HMRC sends it with the payment, `
             + 'so there is nothing else for you to do.',
          M, doc.y, CONTENT_W, { size: 8.2, colour: MUTED });
    doc.y += 6;
  }
}

function footer(doc, st, nursery) {
  ensure(doc, 70);
  doc.y += 6;
  rule(doc, doc.y, RULE);
  doc.y += 8;
  if (nursery.payment_terms) {
    label(doc, 'Payment terms', M, doc.y, CONTENT_W);
    doc.y += 11;
    value(doc, nursery.payment_terms, M, doc.y, CONTENT_W, { size: 8.6 });
    doc.y += 6;
  }
  // b299 — the free-text footer from Settings, printed AS ENTERED: blank lines
  // kept, every line its own line, URLs clickable. The EyLog footer this replaces
  // is a set of app instructions and two group links; reflowing it into one
  // paragraph would make the instructions unreadable and the links unusable.
  if (nursery.footer_note) {
    for (const line of String(nursery.footer_note).split(/\r?\n/)) {
      if (!line.trim()) { doc.y += 7; continue; }        // a blank line stays blank
      ensure(doc, 18);
      // textWithLinks / value both leave doc.y on the next line, so nothing here
      // sets it — passing a y that had already been consumed is what overlapped.
      textWithLinks(doc, line, M, doc.y, CONTENT_W, { size: 8.2, colour: MUTED });
      doc.y += 1.5;
    }
    doc.y += 6;
  }
  const contact = [nursery.phone, nursery.email].filter(Boolean).join('  ·  ');
  if (contact) {
    value(doc, 'Questions about this invoice? ' + contact, M, doc.y, CONTENT_W, { size: 8.2, colour: MUTED });
  }
}

/* ── entry point ──────────────────────────────────────────────────────────── */

/**
 * @param statement  the object GET /api/finance/invoices/:id/statement returns
 *                   (src/lib/eyman-invoice-model.js buildStatement)
 * @param nursery    { name, address, phone, email, payment_terms, footer_note }
 * @returns {Promise<Buffer>} the PDF
 */
function renderInvoicePdf(statement, nursery = {}) {
  return new Promise((resolve, reject) => {
    try {
      const n = {
        name: nursery.name || 'Your Nursery',
        address: nursery.address || '',
        phone: nursery.phone || '',
        email: nursery.email || '',
        payment_terms: nursery.payment_terms || '',
        footer_note: nursery.footer_note || '',
        company_registration: nursery.company_registration || '',
        ofsted_registration: nursery.ofsted_registration || '',
        // b325 — the account to pay into. Absent for any caller that has not
        // loaded it, and the How to pay block simply does not draw.
        bank: nursery.bank || {},
      };
      const doc = new PDFDoc({
        size: 'A4', margins: { top: M, bottom: 56, left: M, right: M },
        info: {
          Title: `Invoice ${safe(statement.invoice_number)} — ${safe(statement.child_name || '')}`,
          Author: n.name, Subject: safe(statement.period_label || ''),
        },
      });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.y = M;
      header(doc, statement, n);
      parties(doc, statement);
      dateStrip(doc, statement);

      // b299 — EyLog's two layouts. A funded child gets the monthly summary and
      // the calculation appendix; a private child gets the weekly breakdown.
      // Either can decline to draw (no booking pattern, no day rate, an imported
      // invoice with no stored detail), and then the original items table runs —
      // which is also what every pre-b299 invoice keeps getting.
      const drewWeekly  = statement.layout === 'weekly'  && weeklyBreakdown(doc, statement);
      const drewMonthly = statement.layout === 'monthly' && monthlySummary(doc, statement);
      if (drewWeekly) extrasTable(doc, statement);
      else if (!drewMonthly) itemsTable(doc, statement);

      totals(doc, statement);
      if (drewMonthly) calculationAppendix(doc, statement);
      // The old working panel says the same things the appendix does, so it runs
      // only when neither new layout drew — never both.
      if (!drewWeekly && !drewMonthly) workingBlock(doc, statement);
      paymentsBlock(doc, statement);
      howToPay(doc, statement, n);      // b325 — the reference, on the bill
      footer(doc, statement, n);

      doc.end();
    } catch (e) { reject(e); }
  });
}

/** A filename a parent can recognise in their downloads folder. */
function invoiceFilename(statement) {
  const child = safe(statement.child_name || 'invoice').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const num = safe(statement.invoice_number || statement.invoice_id).replace(/[^A-Za-z0-9-]+/g, '');
  return `${num || 'invoice'}-${child || 'child'}.pdf`;
}

module.exports = { renderInvoicePdf, invoiceFilename, money, safe };
