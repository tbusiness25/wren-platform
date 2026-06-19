'use strict';
// Generates a PDF contract from a contract row, template, and staff data.
// Called by: src/routes/contracts.js

const PDFDocument = require('pdfkit');
const fs          = require('fs');
const path        = require('path');
const { getPool } = require('../db/pool');

const DATA_DIR       = process.env.CONTRACT_DATA_DIR || path.join(__dirname, '../../data/contracts');
const LOGO_PATH      = '/app/little-angels-logo.png';
const NURSERY_NAME   = 'Your Nursery';
const NURSERY_ADDR   = '1A Example Lane, Ealing, London W13 9LU';
const NURSERY_TEL    = '01234 567890';
const NURSERY_EMAIL  = 'admissions@example.com';

// ─── Variable substitution ───────────────────────────────────────────────────

function fillTemplate(md, vars) {
  return md.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v !== undefined && v !== null ? String(v) : `[${key}]`;
  });
}

function formatPennies(pennies, type) {
  if (!pennies) return '[rate not set]';
  const pounds = (pennies / 100).toFixed(2);
  return type === 'hourly' ? `£${pounds} per hour` : `£${pounds} per annum`;
}

function formatWorkingPattern(pattern) {
  if (!pattern) return 'To be confirmed';
  const days = ['mon','tue','wed','thu','fri','sat','sun'];
  const labels = { mon:'Monday', tue:'Tuesday', wed:'Wednesday', thu:'Thursday',
                   fri:'Friday', sat:'Saturday', sun:'Sunday' };
  return days
    .filter(d => pattern[d] && (pattern[d].start || pattern[d].hours))
    .map(d => {
      const p = pattern[d];
      if (p.start && p.end) return `${labels[d]}: ${p.start}–${p.end}${p.hours ? ` (${p.hours}h)` : ''}`;
      if (p.hours) return `${labels[d]}: ${p.hours} hours`;
      return `${labels[d]}: working`;
    })
    .join('\n') || 'To be confirmed';
}

// ─── Build variable map from contract + staff + template ─────────────────────

function buildVars(contract, staff, template) {
  const cd = contract.contract_data || {};

  const addr = [
    staff.address_line1, staff.address_line2, staff.postcode,
  ].filter(Boolean).join(', ') || '[address not recorded]';

  const payDisplay = formatPennies(
    contract.pay_rate_pennies || cd.pay_rate_pennies,
    contract.pay_rate_type    || cd.pay_rate_type || 'hourly'
  );

  const payLabel = (contract.pay_rate_type || cd.pay_rate_type || 'hourly') === 'salary'
    ? 'annual salary' : 'hourly rate';

  const workPattern = formatWorkingPattern(
    contract.working_pattern || cd.working_pattern
  );

  return {
    first_name:                     staff.first_name || '',
    last_name:                      staff.last_name || '',
    employee_address:               addr,
    ni_number:                      staff.ni_number || '[NI not recorded]',
    job_title:                      contract.job_title || cd.job_title || staff.role || '',
    start_date:                     fmtDate(contract.start_date || cd.start_date),
    contracted_hours:               contract.contracted_hours || cd.contracted_hours || '',
    pay_rate_label:                 payLabel,
    pay_rate_display:               payDisplay,
    working_pattern_formatted:      workPattern,
    holiday_entitlement_days:       contract.holiday_entitlement_days || cd.holiday_entitlement_days || '28',
    probation_period_weeks:         contract.probation_period_weeks   || cd.probation_period_weeks   || '12',
    notice_period_weeks:            contract.notice_period_weeks      || cd.notice_period_weeks      || '4',
    pension_eligible:               String(contract.pension_eligible  ?? cd.pension_eligible ?? true),
    pension_employer_contribution_pct: contract.pension_employer_contribution_pct || cd.pension_employer_contribution_pct || '3',
    pension_employee_contribution_pct: contract.pension_employee_contribution_pct || cd.pension_employee_contribution_pct || '5',
    handbook_version:               contract.handbook_version_sent || cd.handbook_version || '1.0',
    training_provider_name:         cd.training_provider_name || '[Training Provider TBC]',
    apprenticeship_duration_months: cd.apprenticeship_duration_months || '18',
    qualification_name:             cd.qualification_name || 'Level 3 Early Years Educator',
  };
}

function fmtDate(d) {
  if (!d) return '[date not set]';
  return new Date(d).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

// ─── PDF rendering ────────────────────────────────────────────────────────────

function renderPDF(outPath, filledMd, contract, staffName, templateName, opts = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      bufferPages: true,
      info: {
        Title:    `Contract of Employment — ${staffName}`,
        Author:   NURSERY_NAME,
        Subject:  templateName,
        Creator:  'Wren by Your Nursery',
      },
    });

    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    // Track page numbers
    let pageNum = 1;

    // ── Header ─────────────────────────────────────────────────────────────
    function drawHeader() {
      const top = 20;
      // Logo (white bg strip)
      doc.save();
      doc.rect(doc.page.margins.left, top, 120, 50).fill('#ffffff');
      if (fs.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, doc.page.margins.left, top, { width: 120 });
      } else {
        doc.fillColor('#4a9abf').fontSize(14).font('Helvetica-Bold')
           .text('Your Nursery', doc.page.margins.left, top + 8);
      }
      doc.restore();

      // Nursery details right-aligned
      const rightX = doc.page.width - doc.page.margins.right - 200;
      doc.fillColor('#0f172a').fontSize(8).font('Helvetica')
         .text(NURSERY_NAME, rightX, top, { width: 200, align: 'right' })
         .text(NURSERY_ADDR, rightX, doc.y, { width: 200, align: 'right' })
         .text(`Tel: ${NURSERY_TEL}`, rightX, doc.y, { width: 200, align: 'right' })
         .text(NURSERY_EMAIL, rightX, doc.y, { width: 200, align: 'right' });

      doc.moveDown(2);
      doc.moveTo(doc.page.margins.left, doc.y)
         .lineTo(doc.page.width - doc.page.margins.right, doc.y)
         .strokeColor('#4a9abf').lineWidth(1.5).stroke();
      doc.moveDown(1);
    }

    // ── Footer ──────────────────────────────────────────────────────────────
    function drawFooters() {
      const range = doc.bufferedPageRange();
      const total = range.count;
      for (let i = 0; i < total; i++) {
        doc.switchToPage(range.start + i);
        const y = doc.page.height - 40;
        const leftX = doc.page.margins.left;
        const rightX = doc.page.width - doc.page.margins.right;

        doc.moveTo(leftX, y - 6)
           .lineTo(rightX, y - 6)
           .strokeColor('#94a3b8').lineWidth(0.5).stroke();

        doc.fillColor('#94a3b8').fontSize(7).font('Helvetica')
           .text(`Contract ID: ${contract.id}  |  Version: ${contract.version || 1}  |  Generated: ${new Date().toLocaleDateString('en-GB')}`, leftX, y, { width: rightX - leftX, align: 'left' })
           .text(`Page ${i + 1} of ${total}`, leftX, y, { width: rightX - leftX, align: 'right' });
      }
    }

    // ── Render markdown sections ────────────────────────────────────────────
    drawHeader();

    const lines = filledMd.split('\n');
    let inSigBlock = false;

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();

      // H1
      if (line.startsWith('# ')) {
        doc.fillColor('#0f172a').fontSize(16).font('Helvetica-Bold')
           .text(line.slice(2).trim(), { align: 'center' });
        doc.moveDown(0.5);
        continue;
      }
      // H2
      if (line.startsWith('## ')) {
        doc.moveDown(0.5);
        doc.fillColor('#4a9abf').fontSize(11).font('Helvetica-Bold')
           .text(line.slice(3).trim());
        doc.moveDown(0.3);
        continue;
      }
      // HR
      if (line.match(/^---+$/)) {
        doc.moveDown(0.3);
        doc.moveTo(doc.page.margins.left, doc.y)
           .lineTo(doc.page.width - doc.page.margins.right, doc.y)
           .strokeColor('#2d3748').lineWidth(0.5).stroke();
        doc.moveDown(0.5);
        continue;
      }
      // Bold label lines (**Label:** value)
      const boldLabel = line.match(/^\*\*(.+?):\*\*\s*(.*)/);
      if (boldLabel) {
        doc.fillColor('#0f172a').fontSize(9)
           .font('Helvetica-Bold').text(boldLabel[1] + ': ', { continued: true })
           .font('Helvetica').text(boldLabel[2] || ' ');
        doc.moveDown(0.2);
        continue;
      }
      // Signature placeholder lines (Signed: ___ or Date: ___)
      if (line.match(/^(Signed|Date|Name|Title):\s*_{3,}/)) {
        const label = line.split(':')[0];
        inSigBlock = true;
        doc.fillColor('#0f172a').fontSize(9).font('Helvetica')
           .text(`${label}: `, { continued: true });
        doc.fillColor('#94a3b8').text('_'.repeat(40));
        doc.moveDown(0.4);
        continue;
      }
      // Signature image slot if signature data is provided
      if (line.match(/^Signed:\s*___/) && opts.staffSigData && !opts.employerSigBlock) {
        renderSigImage(doc, opts.staffSigData);
        continue;
      }
      if (line.match(/^Signed:\s*___/) && opts.employerSigData && opts.employerSigBlock) {
        renderSigImage(doc, opts.employerSigData);
        continue;
      }
      // Bullet list
      if (line.startsWith('- ')) {
        doc.fillColor('#0f172a').fontSize(9).font('Helvetica')
           .text('•  ' + line.slice(2).trim(), {
             indent: 12,
             lineGap: 2,
           });
        continue;
      }
      // Empty line
      if (line === '') {
        doc.moveDown(0.3);
        inSigBlock = false;
        continue;
      }
      // Normal paragraph text
      const cleaned = line.replace(/\*\*(.+?)\*\*/g, '$1'); // strip bold markers in body
      doc.fillColor('#0f172a').fontSize(9).font('Helvetica')
         .text(cleaned, { lineGap: 3 });
    }

    // ── Signature blocks (drawn at end if signatures exist) ─────────────────
    if (opts.staffSigData || opts.employerSigData) {
      doc.addPage();
      drawHeader();
      doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold')
         .text('SIGNATURES', { align: 'center' });
      doc.moveDown(1);

      drawSigBox(doc, 'EMPLOYER',
        'Nursery Manager', 'Manager',
        opts.employerSigData,
        contract.employer_signature_at ? fmtDate(contract.employer_signature_at) : null
      );
      doc.moveDown(2);
      drawSigBox(doc, 'EMPLOYEE',
        opts.staffName || staffName, 'Employee',
        opts.staffSigData,
        contract.staff_signature_at ? fmtDate(contract.staff_signature_at) : null
      );
    }

    doc.flushPages();
    drawFooters();
    doc.end();

    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function renderSigImage(doc, dataUrl) {
  try {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 500) { doc.text('[signature]'); doc.moveDown(0.4); return; }
    doc.image(buf, { width: 160, height: 50 });
  } catch {
    doc.text('[signature]');
  }
  doc.moveDown(0.4);
}

function drawSigBox(doc, title, name, role, sigData, dateStr) {
  const left = doc.page.margins.left;
  const width = (doc.page.width - doc.page.margins.left - doc.page.margins.right) * 0.45;

  doc.fillColor('#4a9abf').fontSize(10).font('Helvetica-Bold').text(title);
  doc.moveDown(0.3);

  if (sigData) {
    try {
      const base64 = sigData.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(base64, 'base64');
      if (buf.length < 500) throw new Error('sig too small');
      doc.image(buf, left, doc.y, { width: 180, height: 55 });
    } catch {
      doc.rect(left, doc.y, 180, 55).dash(4, { space: 3 }).stroke('#94a3b8').undash();
      doc.fillColor('#0f172a').fontSize(8).font('Helvetica')
         .text('[signed]', left + 6, doc.y - 40);
    }
  } else {
    doc.rect(left, doc.y, 180, 55).dash(4, { space: 3 }).stroke('#94a3b8').undash();
    doc.fillColor('#94a3b8').fontSize(8).font('Helvetica')
       .text('Awaiting signature', left + 6, doc.y - 40);
  }

  doc.moveDown(1);
  doc.fillColor('#0f172a').fontSize(9).font('Helvetica-Bold')
     .text(name, { continued: true })
     .font('Helvetica').text('  —  ' + role);
  doc.fontSize(8).fillColor('#94a3b8')
     .text(dateStr ? `Signed: ${dateStr}` : 'Not yet signed');
  doc.moveDown(0.8);
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function generateContractPDF(contractId, opts = {}) {
  const db = getPool();
  const schema = process.env.PG_SCHEMA || 'ladn';

  const { rows: [contract] } = await db.query(
    `SELECT c.*, ct.content_md, ct.name AS template_name, ct.version AS template_version
       FROM ${schema}.staff_contracts c
       LEFT JOIN ${schema}.contract_templates ct ON ct.id = c.template_id
      WHERE c.id = $1`,
    [contractId]
  );
  if (!contract) throw new Error(`Contract ${contractId} not found`);

  const { rows: [staff] } = await db.query(
    `SELECT first_name, last_name, email, address_line1, address_line2, postcode, ni_number, role
       FROM ${schema}.staff WHERE id = $1`,
    [contract.staff_id]
  );
  if (!staff) throw new Error(`Staff ${contract.staff_id} not found`);

  const vars = buildVars(contract, staff, contract);
  const filledMd = fillTemplate(contract.content_md || '', vars);

  const outPath = path.join(DATA_DIR, `${contractId}.pdf`);
  const staffName = `${staff.first_name} ${staff.last_name}`;

  await renderPDF(outPath, filledMd, contract, staffName, contract.template_name || 'Contract', {
    staffSigData:    opts.staffSigData    || contract.staff_signature_data    || null,
    employerSigData: opts.employerSigData || contract.employer_signature_data || null,
    staffName,
  });

  // Update generated_pdf_path
  await db.query(
    `UPDATE ${schema}.staff_contracts SET generated_pdf_path=$1, updated_at=now() WHERE id=$2`,
    [outPath, contractId]
  );

  return outPath;
}

async function generateSignedPDF(contractId) {
  const db = getPool();
  const schema = process.env.PG_SCHEMA || 'ladn';

  const { rows: [contract] } = await db.query(
    `SELECT c.*, ct.content_md, ct.name AS template_name
       FROM ${schema}.staff_contracts c
       LEFT JOIN ${schema}.contract_templates ct ON ct.id = c.template_id
      WHERE c.id = $1`,
    [contractId]
  );
  if (!contract) throw new Error(`Contract ${contractId} not found`);

  const { rows: [staff] } = await db.query(
    `SELECT first_name, last_name, email, address_line1, address_line2, postcode, ni_number, role
       FROM ${schema}.staff WHERE id = $1`,
    [contract.staff_id]
  );

  const vars = buildVars(contract, staff, contract);
  const filledMd = fillTemplate(contract.content_md || '', vars);

  const outPath = path.join(DATA_DIR, `${contractId}-signed.pdf`);
  const staffName = `${staff.first_name} ${staff.last_name}`;

  await renderPDF(outPath, filledMd, contract, staffName, contract.template_name || 'Contract', {
    staffSigData:    contract.staff_signature_data    || null,
    employerSigData: contract.employer_signature_data || null,
    staffName,
  });

  await db.query(
    `UPDATE ${schema}.staff_contracts SET signed_pdf_path=$1, status='signed', updated_at=now() WHERE id=$2`,
    [outPath, contractId]
  );

  return outPath;
}

module.exports = { generateContractPDF, generateSignedPDF, fillTemplate, formatWorkingPattern };
