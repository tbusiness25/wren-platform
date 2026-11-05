'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// hmrc-starter-pdf.js — the new starter's payroll answers, as one sheet (2026-09-18)
//
// Toby, 2026-09-18: "they can just fill out the details required and then the
// details get put onto the new starter checklist and sent to us as the PDF we
// can pass on to payroll and then her details just go into the system."
//
// WHAT THIS IS, AND WHAT IT IS NOT — the same three rules as src/lib/hmrc-starter.js:
//   1. It is the EMPLOYER's record of what the starter answered, so that payroll
//      can be set up. It is not a submission to HMRC, and Wren files nothing.
//   2. It is not a facsimile of HMRC's form. No crown, no HMRC logo, no form
//      number, no imitation of the layout. It is a Your Nursery document that
//      happens to carry HMRC's questions, in HMRC's own words, and says so.
//   3. Anyone who would rather use the official GOV.UK starter checklist still
//      can — that link is still in the document pack.
//
// The words come from src/lib/hmrc-starter.js, so the form the starter filled in,
// the screen a manager reads and this sheet cannot drift apart.
//
// HANDLING: this file is the ONE place payroll data is allowed to leave the
// staff row, and only as an attachment to a nursery mailbox. Nothing here is
// logged, and the caller is responsible for not putting any of it in an email
// body (see src/routes/hmrc-starter.js).
// ─────────────────────────────────────────────────────────────────────────────

const PDFDocument = require('pdfkit');
const hmrc = require('./hmrc-starter');

const INK = '#1c2b3a';
const MUTED = '#5b6b7c';
const LINE = '#d7dee6';

const ukDate = d => d
  ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  : null;

function fullName(s) {
  return [s.first_name, s.last_name].filter(Boolean).join(' ').trim() || 'New starter';
}

/** Renders the sheet and resolves to a Buffer. */
function renderStarterPdf(staff) {
  const p = hmrc.describe(staff);
  const doc = new PDFDocument({ size: 'A4', margin: 54, info: {
    Title: `New starter payroll details — ${fullName(staff)}`,
    Author: 'Your Nursery',
  } });

  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right;

  // ── Header ────────────────────────────────────────────────────────────────
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(17)
     .text('New starter — payroll details', L, doc.y);
  doc.moveDown(0.25);
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
     .text('Your Nursery · 123 Example Lane, Northfields, Ealing, AB1 2CD');
  doc.moveDown(0.8);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
     .text(hmrc.PURPOSE_LINE, { width: R - L });
  doc.moveDown(0.5);
  doc.moveTo(L, doc.y).lineTo(R, doc.y).lineWidth(0.8).strokeColor(LINE).stroke();
  doc.moveDown(0.9);

  const section = title => {
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(title, L);
    doc.moveDown(0.35);
  };

  const row = (label, value) => {
    const y = doc.y;
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(label, L, y, { width: 175 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
       .text(value == null || value === '' ? 'Not given' : String(value), L + 180, y, { width: R - L - 180 });
    doc.moveDown(0.45);
  };

  // ── Who ───────────────────────────────────────────────────────────────────
  section('The employee');
  row('Name', fullName(staff));
  if (staff.preferred_name) row('Known as', staff.preferred_name);
  row('Date of birth', ukDate(staff.date_of_birth));
  row('Address', [staff.address_line1, staff.address_line2, staff.postcode].filter(Boolean).join(', ') || null);
  row('Job start date', ukDate(staff.contract_start));
  row('Employment type', staff.employment_type);
  row('Contracted hours a week', staff.contracted_hours);

  // ── Payroll ───────────────────────────────────────────────────────────────
  section('Payroll');
  row('National Insurance number', p.ni_number);
  row('Tax code held', p.tax_code);
  row('P45 from a job left this tax year', p.p45_provided ? 'Yes — being brought in' : 'Not stated');

  // ── The employee statement ────────────────────────────────────────────────
  section('Employee statement');
  if (p.declaration) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(`Statement ${p.declaration}`, L);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
       .text(p.declaration_statement, L, doc.y, { width: R - L });
    doc.moveDown(0.3);
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED)
       .text("HMRC's own wording, as shown to the employee when they answered.", L, doc.y, { width: R - L });
  } else if (p.p45_provided) {
    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
       .text('None chosen — a P45 is being provided instead.', L, doc.y, { width: R - L });
  } else {
    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
       .text('Not answered yet.', L, doc.y, { width: R - L });
  }
  doc.moveDown(0.8);

  // ── Student loans ─────────────────────────────────────────────────────────
  section('Student loans');
  row('Plan', p.student_loan_label || (p.student_loan_plan === 'none' ? 'No student loan' : null));
  row('Postgraduate loan', p.postgrad_loan ? 'Yes' : (p.student_loan_plan ? 'No' : 'Not stated'));

  // ── What payroll is still waiting for ─────────────────────────────────────
  if (p.missing.length) {
    doc.moveDown(0.6);
    const boxTop = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
       .text('Still needed before the first payslip', L + 12, boxTop + 10, { width: R - L - 24 });
    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
       .text(p.missing.join(' · '), L + 12, doc.y + 2, { width: R - L - 24 });
    const boxBottom = doc.y + 10;
    doc.rect(L, boxTop, R - L, boxBottom - boxTop).lineWidth(0.8).strokeColor('#e0a33e').stroke();
    doc.y = boxBottom;
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  doc.moveDown(1.2);
  doc.moveTo(L, doc.y).lineTo(R, doc.y).lineWidth(0.8).strokeColor(LINE).stroke();
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(
    `Completed by the employee in Wren and printed on ${ukDate(new Date())}. ` +
    'This sheet is the nursery\'s record of the answers, for setting up PAYE. It is not an HMRC ' +
    'form and nothing here has been filed with HMRC. An employee who would rather use the ' +
    'official starter checklist can still do so at gov.uk.',
    L, doc.y, { width: R - L });

  doc.end();
  return done;
}

/** A safe, recognisable filename: no spaces, no punctuation from a typed name. */
function starterPdfFilename(staff) {
  const who = fullName(staff).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'starter';
  return `new-starter-payroll-${who}.pdf`;
}

module.exports = { renderStarterPdf, starterPdfFilename };
