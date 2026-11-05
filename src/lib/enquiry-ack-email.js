'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// enquiry-ack-email.js — b399 (2026-10-06).
//
// Toby's ONE approved automatic parent email: a thank-you the moment a family
// submits a public enquiry form, behind a Settings off switch
// (enquiry_ack_email_enabled). Every other parent email still needs a person
// to press Send — see memory feedback_no_auto_email_to_parents.md.
//
// Idempotent per enquiry (enquiries.ack_sent_at) and rate-limited per address
// (one ack per email / 24h across ALL enquiries) so a bot resubmitting the
// public form cannot turn it into a spam cannon. Never throws into the
// caller — a failed/skipped ack must never fail the enquiry submission.
// ─────────────────────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function _settingBool(db, key, defaultValue) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key=$1`, [key]);
    if (!rows.length) return defaultValue;
    return rows[0].value === 'true';
  } catch { return defaultValue; }
}

// room_needed is often a day pattern ("Day/FT : M , Tu , Th , F"), not a room — only name a
// room we actually have. ISO dates are said the British way ("1 December 2026").
function _roomName(v) {
  const s = String(v || '').toLowerCase();
  if (/baby/.test(s)) return 'Baby Room';
  if (/pre-?\s?school|preschool|toddler/.test(s)) return 'Pre-school';
  return null;
}
function _niceDate(v) {
  if (!v) return null;
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s.length <= 40 ? s : null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function _renderAck({ parentName, childFirst, room, startReq, enquiryMode, waitDays }) {
  const greet = parentName ? `Hello ${esc(parentName)},` : 'Hello,';
  const childLabel = childFirst ? esc(childFirst) : 'your child';
  const roomLine = room ? ` in the ${esc(room)}` : '';
  const startLine = startReq ? `, starting ${esc(startReq)}` : '';
  const waitLine = waitDays
    ? `<p>Typical wait for a place at the moment is around ${esc(waitDays)}.</p>` : '';
  const appParagraph = enquiryMode ? `
    <p>While we look into a space for ${childLabel}, you're welcome to use our parents app at
    <a href="https://parents.example-nursery.co.uk">parents.example-nursery.co.uk</a> —
    sign in with this email address to message us directly and keep a log of sleeps, food and
    anything else you'd like us to know before ${childLabel} starts with us.</p>` : '';
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#2a2a2a;line-height:1.6;max-width:560px">
<p>${greet}</p>
<p>Thank you for your enquiry about a place for ${childLabel}${roomLine}${startLine}, at Your Nursery.</p>
<p>We've received your details and will be in touch to arrange a visit and talk you through next steps.</p>
${waitLine}
${appParagraph}
<p>If you need us in the meantime, call <a href="tel:02079460000">020 7946 0000</a> or reply to this email.</p>
<p>Your Nursery<br>123 Example Lane, Your Town, AB1 2CD</p>
</div>`;
  return { subject: `Thanks for your enquiry — Your Nursery`, html };
}

/**
 * Send the acknowledgement for enquiry `enquiryId`, if the setting is on, the
 * enquiry has an email, it hasn't already been sent, and the address hasn't
 * had one in the last 24h. `enquiryModeOn` controls whether the parents-app
 * invitation paragraph is included (it is a paragraph of this email, never a
 * second one).
 *
 * @returns {Promise<{sent:boolean, reason?:string, rendered?:{subject,html}}>}
 */
async function sendEnquiryAcknowledgement(db, enquiryId, { enquiryModeOn } = {}) {
  try {
    const enabled = await _settingBool(db, 'enquiry_ack_email_enabled', true);
    if (!enabled) return { sent: false, reason: 'disabled in settings' };

    const { rows } = await db.query(
      `SELECT id, parent_name, parent_email, child_first_name, preferred_room, room_needed,
              start_date_requested, preferred_start_date, ack_sent_at
         FROM enquiries WHERE id=$1`, [enquiryId]);
    if (!rows.length) return { sent: false, reason: 'enquiry not found' };
    const e = rows[0];
    const email = String(e.parent_email || '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) return { sent: false, reason: 'no valid email' };
    if (e.ack_sent_at) return { sent: false, reason: 'already sent for this enquiry' };

    const { rows: recent } = await db.query(
      `SELECT 1 FROM enquiries WHERE lower(parent_email)=$1 AND ack_sent_at > now() - interval '24 hours' LIMIT 1`,
      [email]);
    if (recent.length) return { sent: false, reason: 'rate-limited — an ack went to this address in the last 24h' };
    // 2026-10-06 (review) — and a ceiling across ALL addresses. The per-address limit alone
    // still lets a bot posting many different addresses send our email to each of them;
    // LADN gets a handful of enquiries a week, so 6 an hour / 20 a day is never reached
    // by real families.
    const { rows: [vol] } = await db.query(
      `SELECT count(*) FILTER (WHERE ack_sent_at > now() - interval '1 hour')::int AS hour,
              count(*) FILTER (WHERE ack_sent_at > now() - interval '24 hours')::int AS day
         FROM enquiries WHERE ack_sent_at > now() - interval '24 hours'`);
    if (vol && (vol.hour >= 6 || vol.day >= 20)) {
      console.warn('[enquiry-ack-email] nursery-wide ceiling reached — not sending', vol);
      return { sent: false, reason: 'rate-limited — nursery-wide ceiling' };
    }

    let waitDays = null;
    try {
      const s = await db.query(`SELECT value FROM settings WHERE key='enquiry_typical_wait'`);
      waitDays = s.rows[0]?.value || null;
    } catch { /* optional, never blocks */ }

    const rendered = _renderAck({
      parentName: e.parent_name, childFirst: e.child_first_name,
      room: _roomName(e.preferred_room) || _roomName(e.room_needed),
      startReq: _niceDate(e.start_date_requested || e.preferred_start_date),
      enquiryMode: !!enquiryModeOn, waitDays,
    });

    const { sendViaGmail } = require('./gmail-sender');
    await sendViaGmail({ to: email, subject: rendered.subject, html: rendered.html });
    await db.query(`UPDATE enquiries SET ack_sent_at=now() WHERE id=$1`, [enquiryId]);
    return { sent: true, rendered };
  } catch (e) {
    console.error('[enquiry-ack-email]', e.message);
    return { sent: false, reason: 'error: ' + e.message };
  }
}

module.exports = { sendEnquiryAcknowledgement, _renderAck };
