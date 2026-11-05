'use strict';
/**
 * inbox-alerts.js — b364 (2026-09-29)
 *
 * "Alerts: a notification (in-app + Telegram) for emails in sections Toby marks
 * urgent (default: Parents, Ealing, Finance) — name + section + one-line gist
 * only, never the email body in Telegram."
 *
 * ── WHY THE GIST IS SHORT, AND WHY THAT IS THE POINT ────────────────────────
 * A Telegram message leaves the building. It goes to Telegram's servers, then to
 * a phone that may be on anybody's network, and it sits in a chat history that is
 * not ours. So the alert carries three things and no more: who it is from, which
 * section it landed in, and a one-line gist. Not the body, not an attachment
 * name, not a child's name, not a figure.
 *
 * The dispatcher builds the Telegram text from the notification's title, body and
 * link and nothing else (src/services/notification-dispatcher.js,
 * formatTelegramMessage), so controlling those two strings IS controlling what
 * goes out. That is why the trimming happens here rather than being left to the
 * channel.
 *
 * `inbox_urgent_email` is on EMAIL_BLOCKED_CATEGORIES in the dispatcher, so this
 * alert can never itself become an outbound email — which would be Wren emailing
 * about an email.
 *
 * ── WHO IS TOLD ─────────────────────────────────────────────────────────────
 * The people who may read email: whoever is on settings.comms_manager_staff_ids
 * AND has a grant for THAT mailbox. Not "all managers". A deputy who cannot open
 * the mailbox is not told that something arrived in it.
 */

const access = require('./inbox-access');
const sections = require('./inbox-sections');

const CATEGORY = 'inbox_urgent_email';

/** A gist that is safe to put in a chat history: one line, no body. */
function gist(email, card) {
  // The card's context is the model's summary of the facts, which is a better
  // gist than the subject — but it can name a child, so it is NOT used here.
  // The subject line is what the sender chose to put in a header, and the
  // classifier's own summary is a one-liner about the request, not its contents.
  const s = String(email.summary || email.subject || '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 120) : 'No subject.';
}

/** Just the display name, or the local part of the address — never both. */
function senderLabel(email) {
  const name = String(email.from_name || '').trim();
  if (name && !/@/.test(name)) return name.slice(0, 60);
  const addr = String(email.from_email || '').trim();
  if (!addr) return 'an unknown sender';
  const at = addr.indexOf('@');
  return at > 0 ? `${addr.slice(0, at)}@…` : addr.slice(0, 40);
}

/**
 * Raise the alert for one email, if its section is one of the urgent ones.
 *
 * Best-effort by contract: it never throws into the poll loop, and a failure to
 * notify must never stop an email being stored.
 *
 * @returns {Promise<{alerted:boolean, reason?:string, recipients?:number}>}
 */
async function alertFor(db, email, card) {
  try {
    if (!email || !email.section) return { alerted: false, reason: 'no_section' };
    const urgent = await sections.urgentSections(db);
    if (!urgent.includes(email.section)) return { alerted: false, reason: 'section_not_urgent' };

    const ids = await access.commsManagerIds(db);
    if (!ids.length) return { alerted: false, reason: 'no_recipients' };

    // Only the people who may open THAT mailbox.
    const eligible = [];
    for (const id of ids) {
      const boxes = await access.allowedMailboxes(db, id);
      if (!email.mailbox || boxes.includes(email.mailbox)) eligible.push(id);
    }
    if (!eligible.length) return { alerted: false, reason: 'no_mailbox_grants' };

    let sectionLabel = email.section;
    try {
      const list = await sections.sectionList(db);
      const hit = list.find(s => s.key === email.section);
      if (hit) sectionLabel = hit.label;
    } catch (_) {}

    const { notify } = require('../services/notification-dispatcher');
    const title = `📧 ${sectionLabel} — ${senderLabel(email)}`;
    const body  = gist(email, card);
    for (const staffId of eligible) {
      notify(CATEGORY, 'staff', staffId, title, body, {
        relatedTable: 'comms_email_queue',
        relatedId: email.id,
        link: `/hermes-inbox.html?email=${email.id}`,
        priority: email.section === 'parents' ? 'high' : 'normal',
      });
    }
    return { alerted: true, recipients: eligible.length, section: email.section };
  } catch (e) {
    console.error('[inbox-alerts] alert failed:', e.message);
    return { alerted: false, reason: e.message };
  }
}

module.exports = { CATEGORY, alertFor, gist, senderLabel };
