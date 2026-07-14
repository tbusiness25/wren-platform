const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
  if (!transporter && process.env.SMTP_HOST && process.env.SMTP_USER) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }
  return transporter;
}

async function sendEmail({ to, subject, html, text }) {
  // PREFERRED: Gmail API via the Google service account (domain-wide delegation).
  try {
    const gmail = require('../lib/gmail-sender');
    if (gmail.isConfigured()) {
      const r = await gmail.sendViaGmail({ to, subject, html, text });
      if (r && r.ok) {
        console.log(`[email] sent via Gmail API to ${to}: ${subject} (id ${r.messageId})`);
        return { messageId: r.messageId, via: 'gmail_api' };
      }
    }
  } catch (gerr) {
    console.error('[email] Gmail API send failed, falling back to SMTP:', gerr.message);
  }

  const t = getTransporter();
  if (!t) {
    console.log(`[email] No SMTP config — would send to ${to}: ${subject}`);
    return { skipped: true };
  }
  return t.sendMail({
    from: process.env.SMTP_FROM || 'admin@littleangelsealing.co.uk',
    to,
    subject,
    html,
    text
  });
}

module.exports = { sendEmail };
