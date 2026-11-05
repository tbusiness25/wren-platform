'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// hmrc-starter.js — the new starter's payroll sheet: download it, or send it (2026-09-18)
//
// Toby, 2026-09-18: "they can just fill out the details required and then the
// details get put onto the new starter checklist and sent to us as the PDF we
// can pass on to payroll and then her details just go into the system."
//
// The answers already land on ladn.staff (b303, on the onboarding form). This
// turns them into one sheet a payroll bureau can read, and emails it to the
// nursery's own mailbox — never to a personal address, and never as text in the
// body. The email says a sheet is attached and nothing else; every figure is
// inside the PDF.
//
// ACCESS: manager-only AND gated on view_staff_salaries, the same permission
// that hides tax_code and these four columns everywhere else (see
// src/lib/capabilities.js). A deputy without that permission gets a 403, not a
// redacted sheet.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { renderStarterPdf, starterPdfFilename } = require('../lib/hmrc-starter-pdf');
const { sendViaGmail } = require('../lib/gmail-sender');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

const MGR_ROLES = ['manager', 'deputy_manager', 'admin'];

// Where the sheet is allowed to go: a nursery Workspace mailbox, never a
// personal address, and never one named in the request.
const PAYROLL_MAILBOX = process.env.PAYROLL_MAILBOX || 'toby@example-nursery.co.uk';

const STAFF_COLS = `id, first_name, last_name, preferred_name, date_of_birth,
                    address_line1, address_line2, postcode, contract_start,
                    employment_type, contracted_hours, ni_number, tax_code,
                    starter_declaration, student_loan_plan, postgrad_loan, p45_provided`;

// canViewSalaries is the same check that hides tax_code and these four columns
// everywhere else: Toby, the manager-level roles, or anyone the permissions
// matrix has granted view_staff_salaries. The role check in front of it keeps a
// practitioner out even on an edition where the matrix has been opened up.
async function canReadSalaries(req) {
  if (!req.user || !hasRole(req.user, MGR_ROLES)) return false;
  const { canViewSalaries } = require('../lib/capabilities');
  return canViewSalaries(req.user);
}

async function loadStaff(id) {
  const { rows } = await getPool().query(
    `SELECT ${STAFF_COLS} FROM staff WHERE id = $1`, [id]);
  return rows[0] || null;
}

router.use(authenticate);

// GET /:id/pdf — download the sheet.
router.get('/:id/pdf', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Which member of staff?' });
  if (!(await canReadSalaries(req))) return res.status(403).json({ error: 'Payroll details are manager-only' });
  try {
    const staff = await loadStaff(id);
    if (!staff) return res.status(404).json({ error: 'No such member of staff' });
    const pdf = await renderStarterPdf(staff);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${starterPdfFilename(staff)}"`);
    res.send(pdf);
  } catch (e) {
    console.error('[hmrc-starter] pdf failed:', e.message);
    res.status(500).json({ error: 'Could not build the sheet' });
  }
});

// POST /:id/email — send the sheet to the nursery mailbox, to pass to payroll.
router.post('/:id/email', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Which member of staff?' });
  if (!(await canReadSalaries(req))) return res.status(403).json({ error: 'Payroll details are manager-only' });
  try {
    const staff = await loadStaff(id);
    if (!staff) return res.status(404).json({ error: 'No such member of staff' });
    const r = await emailStarterSheet(staff);
    res.json({ ok: true, to: PAYROLL_MAILBOX, sent: !(r && r.disabled) });
  } catch (e) {
    console.error('[hmrc-starter] email failed:', e.message);
    res.status(500).json({ error: 'Could not send the sheet' });
  }
});

/**
 * Emails the sheet to the nursery mailbox. Exported so the onboarding form can
 * call it the moment a starter submits, which is the whole point: nobody has to
 * remember to fetch it.
 *
 * The body carries a name and nothing else — no NI number, no statement, no
 * loan plan. All of that is in the attachment.
 */
async function emailStarterSheet(staff) {
  const pdf = await renderStarterPdf(staff);
  const who = [staff.first_name, staff.last_name].filter(Boolean).join(' ').trim() || 'A new starter';
  return sendViaGmail({
    to: PAYROLL_MAILBOX,
    from: 'wren@example-nursery.co.uk', fromName: 'Wren',
    subject: `New starter payroll details — ${who}`,
    text: `${who} has filled in their payroll details in Wren. The sheet is attached, ready to pass to payroll.\n\n` +
          'Nothing has been filed with HMRC — this is the nursery\'s own record of what they answered.\n',
    html: `<p>${who.replace(/[&<>]/g, '')} has filled in their payroll details in Wren. ` +
          'The sheet is attached, ready to pass to payroll.</p>' +
          '<p style="color:#5b6b7c;font-size:13px">Nothing has been filed with HMRC — this is the ' +
          'nursery\'s own record of what they answered.</p>',
    attachments: [{
      filename: starterPdfFilename(staff),
      content: pdf,
      contentType: 'application/pdf',
    }],
  });
}

module.exports = router;
module.exports.emailStarterSheet = emailStarterSheet;
module.exports.PAYROLL_MAILBOX = PAYROLL_MAILBOX;
