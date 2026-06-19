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
  const t = getTransporter();
  if (!t) {
    console.log(`[email] No SMTP config — would send to ${to}: ${subject}`);
    return { skipped: true };
  }
  return t.sendMail({
    from: process.env.SMTP_FROM || 'wren@yoursetting.co.uk',
    to,
    subject,
    html,
    text
  });
}

module.exports = { sendEmail };
