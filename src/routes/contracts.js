'use strict';
const express       = require('express');
const crypto        = require('crypto');
const path          = require('path');
const fs            = require('fs');
const nodemailer    = require('nodemailer');
const router        = express.Router();
const { getPool }   = require('../db/pool');
const authenticate  = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { generateContractPDF, generateSignedPDF } = require('../services/contract-generator');

const DATA_DIR    = process.env.CONTRACT_DATA_DIR || path.join(__dirname, '../../data/contracts');
const SCHEMA      = () => process.env.PG_SCHEMA || 'ladn';

// ─── Auth helpers ─────────────────────────────────────────────────────────────

const managerOnly = requireRole('manager', 'deputy_manager', 'admin');

async function logEvent(contractId, event, ip, ua, detail = {}) {
  const db = getPool();
  const s  = SCHEMA();
  await db.query(
    `INSERT INTO ${s}.contract_signature_log (contract_id, event, ip, user_agent, detail)
     VALUES ($1,$2,$3,$4,$5)`,
    [contractId, event, ip || null, ua || null, JSON.stringify(detail)]
  );
}

function mailer() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendTelegram(msg) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const https = require('https');
    const body  = JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' });
    await new Promise((res, rej) => {
      const req = https.request(
        `https://api.telegram.org/bot${token}/sendMessage`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
        r => r.resume().on('end', res)
      );
      req.on('error', rej);
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.warn('Telegram send failed:', e.message);
  }
}

// ─── GET /api/contracts/templates ────────────────────────────────────────────

router.get('/templates', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, name, template_type, doc_type, version, is_active, variables, updated_at
         FROM ${SCHEMA()}.contract_templates
        WHERE is_active = true
        ORDER BY name`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/contracts ───────────────────────────────────────────────────────

router.get('/', ...managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const s  = SCHEMA();
    const { status } = req.query;
    const params = [];
    let   where  = '';
    if (status) {
      params.push(status);
      where = `WHERE sc.status = $1`;
    }
    const { rows } = await db.query(`
      SELECT sc.id, sc.staff_id, sc.status, sc.job_title, sc.start_date, sc.end_date,
             sc.pay_rate_type, sc.pay_rate_pennies, sc.sent_at, sc.sent_to_email,
             sc.staff_signature_at, sc.employer_signature_at, sc.generated_pdf_path,
             sc.signed_pdf_path, sc.created_at, sc.updated_at,
             s.first_name || ' ' || s.last_name AS staff_name,
             s.email AS staff_email,
             ct.name AS template_name, ct.template_type
        FROM ${s}.staff_contracts sc
        LEFT JOIN ${s}.staff s   ON s.id  = sc.staff_id
        LEFT JOIN ${s}.contract_templates ct ON ct.id = sc.template_id
       ${where}
       ORDER BY sc.created_at DESC
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/contracts/:id ───────────────────────────────────────────────────

router.get('/:id', ...managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const s  = SCHEMA();
    const { rows: [row] } = await db.query(`
      SELECT sc.*,
             s.first_name, s.last_name, s.email AS staff_email,
             s.address_line1, s.address_line2, s.postcode, s.ni_number,
             ct.name AS template_name, ct.template_type, ct.content_md
        FROM ${s}.staff_contracts sc
        LEFT JOIN ${s}.staff s   ON s.id  = sc.staff_id
        LEFT JOIN ${s}.contract_templates ct ON ct.id = sc.template_id
       WHERE sc.id = $1
    `, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Don't send signature raw data in list view
    delete row.staff_signature_data;
    delete row.employer_signature_data;
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/contracts — create draft ──────────────────────────────────────

router.post('/', ...managerOnly, async (req, res) => {
  const db = getPool();
  const s  = SCHEMA();
  const {
    staff_id, template_id,
    start_date, job_title, department, employment_type, contracted_hours,
    pay_rate_type, pay_rate_pennies,
    working_pattern, holiday_entitlement_days,
    probation_period_weeks, notice_period_weeks,
    pension_eligible, pension_employer_contribution_pct, pension_employee_contribution_pct,
    overrides,
  } = req.body;

  if (!staff_id) return res.status(400).json({ error: 'staff_id required' });

  try {
    // Pull staff + template defaults
    const { rows: [staff] } = await db.query(
      `SELECT * FROM ${s}.staff WHERE id=$1`, [staff_id]
    );
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    let templateVars = {};
    if (template_id) {
      const { rows: [tmpl] } = await db.query(
        `SELECT variables FROM ${s}.contract_templates WHERE id=$1`, [template_id]
      );
      templateVars = tmpl?.variables || {};
    }

    // Merge: template defaults → staff record → explicit overrides
    const contractData = {
      ...templateVars,
      job_title:    job_title    || staff.role,
      start_date:   start_date   || staff.contract_start,
      handbook_version: overrides?.handbook_version || '1.0',
      ...overrides,
    };

    const { rows: [created] } = await db.query(`
      INSERT INTO ${s}.staff_contracts
        (staff_id, template_id, start_date, employment_type, job_title, department,
         contracted_hours, pay_rate_type, pay_rate_pennies, working_pattern,
         holiday_entitlement_days, probation_period_weeks, notice_period_weeks,
         pension_eligible, pension_employer_contribution_pct,
         pension_employee_contribution_pct,
         contract_data, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'draft')
      RETURNING id
    `, [
      staff_id, template_id || null,
      start_date || staff.contract_start || null,
      employment_type || staff.employment_type,
      job_title || staff.role,
      department || staff.department || null,
      contracted_hours || staff.contracted_hours,
      pay_rate_type || 'hourly',
      pay_rate_pennies || null,
      working_pattern ? JSON.stringify(working_pattern) : null,
      holiday_entitlement_days || staff.holiday_entitlement_days || 28,
      probation_period_weeks || 12,
      notice_period_weeks || 4,
      pension_eligible ?? staff.pension_eligible ?? true,
      pension_employer_contribution_pct || staff.pension_employer_contribution || 3,
      pension_employee_contribution_pct || staff.pension_employee_contribution || 5,
      JSON.stringify(contractData),
    ]);

    const contractId = created.id;

    // Auto-generate PDF for draft
    try {
      await generateContractPDF(contractId);
    } catch (pdfErr) {
      console.error('PDF generation failed (non-fatal):', pdfErr.message);
    }

    await logEvent(contractId, 'created', req.ip, req.headers['user-agent'], { by: req.user.id });
    recordAudit({ req, action: 'contract_create', entity_type: 'staff_contract', entity_id: contractId, meta: { staff_id } });

    res.json({ id: contractId });
  } catch (e) {
    console.error('POST /api/contracts:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/contracts/:id — edit before send ──────────────────────────────

router.patch('/:id', ...managerOnly, async (req, res) => {
  const db  = getPool();
  const s   = SCHEMA();
  const cid = parseInt(req.params.id);

  try {
    const { rows: [current] } = await db.query(
      `SELECT status FROM ${s}.staff_contracts WHERE id=$1`, [cid]
    );
    if (!current) return res.status(404).json({ error: 'Not found' });
    if (current.status === 'signed') {
      return res.status(409).json({ error: 'Cannot edit a signed contract' });
    }

    const allowed = [
      'template_id','start_date','end_date','employment_type','job_title','department',
      'contracted_hours','pay_rate_type','pay_rate_pennies','working_pattern',
      'holiday_entitlement_days','probation_period_weeks','notice_period_weeks',
      'pension_eligible','pension_employer_contribution_pct',
      'pension_employee_contribution_pct','contract_data',
    ];

    const sets = [];
    const vals = [];
    let   idx  = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const v = (key === 'working_pattern' || key === 'contract_data')
          ? JSON.stringify(req.body[key]) : req.body[key];
        sets.push(`${key}=$${idx++}`);
        vals.push(v);
      }
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    sets.push(`updated_at=now()`);
    vals.push(cid);
    await db.query(
      `UPDATE ${s}.staff_contracts SET ${sets.join(',')} WHERE id=$${idx}`,
      vals
    );

    await logEvent(cid, 'edited', req.ip, req.headers['user-agent'], { by: req.user.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/contracts/:id/generate-pdf ────────────────────────────────────

router.post('/:id/generate-pdf', ...managerOnly, async (req, res) => {
  const cid = parseInt(req.params.id);
  try {
    const outPath = await generateContractPDF(cid);
    await logEvent(cid, 'pdf_generated', req.ip, req.headers['user-agent'], { by: req.user.id });
    res.json({ ok: true, path: outPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/contracts/:id/pdf — stream PDF to browser ─────────────────────

router.get('/:id/pdf', ...managerOnly, async (req, res) => {
  const db  = getPool();
  const cid = parseInt(req.params.id);
  try {
    const { rows: [row] } = await db.query(
      `SELECT generated_pdf_path, signed_pdf_path, status FROM ${SCHEMA()}.staff_contracts WHERE id=$1`, [cid]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    const useSigned = req.query.signed === '1' && row.signed_pdf_path;
    const pdfPath   = useSigned ? row.signed_pdf_path : row.generated_pdf_path;

    if (!pdfPath || !fs.existsSync(pdfPath)) {
      // Try to generate on the fly
      await generateContractPDF(cid);
      const { rows: [refreshed] } = await db.query(
        `SELECT generated_pdf_path FROM ${SCHEMA()}.staff_contracts WHERE id=$1`, [cid]
      );
      if (!refreshed?.generated_pdf_path || !fs.existsSync(refreshed.generated_pdf_path)) {
        return res.status(404).json({ error: 'PDF not available' });
      }
      return res.setHeader('Content-Type', 'application/pdf').sendFile(refreshed.generated_pdf_path);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(pdfPath);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/contracts/:id/send ────────────────────────────────────────────

router.post('/:id/send', ...managerOnly, async (req, res) => {
  const db  = getPool();
  const s   = SCHEMA();
  const cid = parseInt(req.params.id);
  const { test_email } = req.body;  // optional override for testing

  try {
    const { rows: [row] } = await db.query(`
      SELECT sc.*, s.email AS staff_email, s.first_name, s.last_name, s.telegram_chat_id,
             ct.name AS template_name
        FROM ${s}.staff_contracts sc
        LEFT JOIN ${s}.staff s ON s.id = sc.staff_id
        LEFT JOIN ${s}.contract_templates ct ON ct.id = sc.template_id
       WHERE sc.id = $1
    `, [cid]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status === 'signed') return res.status(409).json({ error: 'Contract already signed' });

    // Ensure PDF exists
    if (!row.generated_pdf_path || !fs.existsSync(row.generated_pdf_path)) {
      await generateContractPDF(cid);
    }

    // Refresh after possible generation
    const { rows: [refreshed] } = await db.query(
      `SELECT generated_pdf_path FROM ${s}.staff_contracts WHERE id=$1`, [cid]
    );
    const pdfPath = refreshed.generated_pdf_path;

    // Generate sign token
    const signToken = crypto.randomBytes(32).toString('hex');

    // Resolve signing URL base
    const baseUrl = process.env.ADMIN_URL || 'https://admin.littleangelsealing.co.uk';
    const signUrl = `${baseUrl}/contract-sign.html?id=${cid}&token=${signToken}`;

    // Resolve current handbook
    const { rows: [hbRow] } = await db.query(
      `SELECT version, pdf_path FROM ${s}.staff_handbook_versions WHERE is_current=true LIMIT 1`
    );

    const toEmail = test_email || row.staff_email;
    if (!toEmail) return res.status(400).json({ error: 'No email address for staff member' });

    // Email — skip gracefully if SMTP is not configured
    let emailSent = false;
    let emailSkipReason = null;
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      emailSkipReason = 'SMTP credentials not configured';
      console.warn(`[contracts/send] Skipping email: ${emailSkipReason}. Sign URL: ${signUrl}`);
    } else {
      const transport = mailer();
      const attachments = [];
      if (pdfPath && fs.existsSync(pdfPath)) {
        attachments.push({
          filename: `Contract-${row.first_name}-${row.last_name}.pdf`,
          path: pdfPath,
        });
      }
      if (hbRow?.pdf_path && fs.existsSync(hbRow.pdf_path)) {
        attachments.push({
          filename: `Staff-Handbook-v${hbRow.version}.pdf`,
          path: hbRow.pdf_path,
        });
      }

      await transport.sendMail({
        from:    process.env.SMTP_FROM || 'Little Angels Day Nursery <admissions@littleangelsealing.co.uk>',
        to:      toEmail,
        subject: `Your Contract of Employment — Little Angels Day Nursery`,
        html: `
          <p>Dear ${row.first_name},</p>
          <p>Please find your contract of employment attached to this email${hbRow ? ', along with our Staff Handbook' : ''}.</p>
          <p>To sign your contract, please click the link below:</p>
          <p><a href="${signUrl}" style="background:#4a9abf;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">
            Review &amp; Sign My Contract
          </a></p>
          <p>If the button doesn't work, copy this link into your browser:<br>
          <small>${signUrl}</small></p>
          <p>If you have any questions, please contact us at ${process.env.SMTP_FROM || 'admissions@littleangelsealing.co.uk'} or call 020 8051 0349.</p>
          <p>Kind regards,<br>Toby Jones<br>Manager, Little Angels Day Nursery</p>
        `,
        attachments,
      });
      emailSent = true;
    }

    // Update DB
    await db.query(
      `UPDATE ${s}.staff_contracts
          SET status='sent', sent_at=now(), sent_to_email=$1, sign_token=$2,
              handbook_version_sent=$3, updated_at=now()
        WHERE id=$4`,
      [toEmail, signToken, hbRow?.version || null, cid]
    );

    await logEvent(cid, 'sent', req.ip, req.headers['user-agent'], {
      by: req.user.id, to: toEmail
    });

    // Telegram notification
    const tgMsg = `📄 <b>Contract sent</b>\n` +
      `Staff: ${row.first_name} ${row.last_name}\n` +
      `Email: ${toEmail}\n` +
      `Contract ID: ${cid}`;
    await sendTelegram(tgMsg);

    // Also notify staff via Telegram if linked
    if (row.telegram_chat_id) {
      await sendTelegramDirect(row.telegram_chat_id,
        `Hi ${row.first_name}! Your contract of employment from Little Angels Day Nursery has been sent to your email. Please check your inbox to review and sign.`
      );
    }

    res.json({ ok: true, sent_to: toEmail, email_sent: emailSent, email_skip: emailSkipReason, sign_url: signUrl });
  } catch (e) {
    console.error('POST /api/contracts/:id/send:', e);
    res.status(500).json({ error: e.message });
  }
});

async function sendTelegramDirect(chatId, msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    const https  = require('https');
    const body   = JSON.stringify({ chat_id: chatId, text: msg });
    await new Promise((res, rej) => {
      const req = https.request(
        `https://api.telegram.org/bot${token}/sendMessage`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
        r => r.resume().on('end', res)
      );
      req.on('error', rej);
      req.write(body);
      req.end();
    });
  } catch {}
}

// ─── GET /api/contracts/:id/sign — public token-gated signing page ───────────
// Returns contract data for the signing UI (no auth required, token required)

router.get('/:id/sign', async (req, res) => {
  const db  = getPool();
  const s   = SCHEMA();
  const cid = parseInt(req.params.id);
  const { token } = req.query;

  try {
    const { rows: [row] } = await db.query(
      `SELECT sc.id, sc.status, sc.sign_token, sc.generated_pdf_path,
              s.first_name, s.last_name
         FROM ${s}.staff_contracts sc
         JOIN ${s}.staff s ON s.id = sc.staff_id
        WHERE sc.id = $1`,
      [cid]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!token || row.sign_token !== token) {
      return res.status(403).json({ error: 'Invalid or missing signing token' });
    }
    if (row.status === 'signed') {
      return res.json({ ok: true, status: 'already_signed', name: `${row.first_name} ${row.last_name}` });
    }

    await logEvent(cid, 'opened', req.ip, req.headers['user-agent'], {});
    res.json({
      ok: true,
      id: cid,
      name: `${row.first_name} ${row.last_name}`,
      status: row.status,
      has_pdf: !!(row.generated_pdf_path && fs.existsSync(row.generated_pdf_path)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/contracts/:id/pdf-public — stream PDF with token (staff view) ──

router.get('/:id/pdf-public', async (req, res) => {
  const db  = getPool();
  const s   = SCHEMA();
  const cid = parseInt(req.params.id);
  const { token } = req.query;

  try {
    const { rows: [row] } = await db.query(
      `SELECT sign_token, generated_pdf_path FROM ${s}.staff_contracts WHERE id=$1`, [cid]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!token || row.sign_token !== token) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    if (!row.generated_pdf_path || !fs.existsSync(row.generated_pdf_path)) {
      return res.status(404).json({ error: 'PDF not available' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(row.generated_pdf_path);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/contracts/:id/sign — submit staff signature ───────────────────

router.post('/:id/sign', async (req, res) => {
  const db  = getPool();
  const s   = SCHEMA();
  const cid = parseInt(req.params.id);
  const { token, signature_data } = req.body;

  if (!token)          return res.status(400).json({ error: 'token required' });
  if (!signature_data) return res.status(400).json({ error: 'signature_data required' });
  if (!signature_data.startsWith('data:image/')) {
    return res.status(400).json({ error: 'signature_data must be a data URL' });
  }

  try {
    const { rows: [row] } = await db.query(
      `SELECT sign_token, status FROM ${s}.staff_contracts WHERE id=$1`, [cid]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.sign_token !== token) return res.status(403).json({ error: 'Invalid token' });
    if (row.status === 'signed') return res.json({ ok: true, status: 'already_signed' });

    await db.query(
      `UPDATE ${s}.staff_contracts
          SET staff_signature_data=$1, staff_signature_at=now(),
              staff_signature_ip=$2, status='countersigning', updated_at=now()
        WHERE id=$3`,
      [signature_data, req.ip, cid]
    );

    await logEvent(cid, 'signed_by_staff', req.ip, req.headers['user-agent'], {});

    // Notify manager
    await sendTelegram(
      `✍️ <b>Contract signed by staff</b>\n` +
      `Contract ID: ${cid}\nAwaiting countersignature.`
    );

    res.json({ ok: true, status: 'awaiting_countersign' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/contracts/:id/countersign — manager countersign ───────────────

router.post('/:id/countersign', ...managerOnly, async (req, res) => {
  const db  = getPool();
  const s   = SCHEMA();
  const cid = parseInt(req.params.id);
  const { signature_data } = req.body;

  if (!signature_data) return res.status(400).json({ error: 'signature_data required' });
  if (!signature_data.startsWith('data:image/')) {
    return res.status(400).json({ error: 'signature_data must be a data URL' });
  }

  try {
    const { rows: [row] } = await db.query(
      `SELECT status FROM ${s}.staff_contracts WHERE id=$1`, [cid]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status === 'signed') return res.json({ ok: true, status: 'already_signed' });

    await db.query(
      `UPDATE ${s}.staff_contracts
          SET employer_signature_data=$1, employer_signature_at=now(),
              employer_signature_by=$2, updated_at=now()
        WHERE id=$3`,
      [signature_data, req.user.id, cid]
    );

    // Generate final signed PDF
    let signedPath = null;
    try {
      signedPath = await generateSignedPDF(cid);
    } catch (pdfErr) {
      console.error('Signed PDF generation failed:', pdfErr.message);
    }

    await logEvent(cid, 'countersigned', req.ip, req.headers['user-agent'], { by: req.user.id });
    recordAudit({ req, action: 'contract_countersign', entity_type: 'staff_contract', entity_id: cid });

    await sendTelegram(
      `✅ <b>Contract fully signed</b>\n` +
      `Contract ID: ${cid}\nSigned PDF: ${signedPath ? 'saved' : 'generation failed'}`
    );

    res.json({ ok: true, status: 'signed', signed_pdf_path: signedPath });
  } catch (e) {
    console.error('POST /api/contracts/:id/countersign:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/contracts/:id/audit — event log ────────────────────────────────

router.get('/:id/audit', ...managerOnly, async (req, res) => {
  const db  = getPool();
  const cid = parseInt(req.params.id);
  try {
    const { rows } = await db.query(
      `SELECT id, event, event_at, ip, detail
         FROM ${SCHEMA()}.contract_signature_log
        WHERE contract_id=$1
        ORDER BY event_at`,
      [cid]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
