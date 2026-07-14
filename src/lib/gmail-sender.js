// Gmail-API sender + reader via the LADN Google service account (domain-wide
// delegation). NO Brevo, NO n8n dependency — this is the preferred outbound path
// and the inbound poll source for the comms hub.
//
// Auth model: a single service account (client_id 113082589617878840904,
// gmail090426@ladn-local-system.iam.gserviceaccount.com) is authorised in Google
// Workspace Admin → Domain-wide delegation for scopes gmail.send (live) and
// gmail.readonly (Toby is adding this). We impersonate a real Workspace mailbox
// (COMMS_MAILBOX, default admin@littleangelsealing.co.uk) via JWT `subject`.
//
// If a call returns 403 / unauthorized_client the DWD scope has not propagated —
// callers should LOG that clearly and NOT fall back to a fake transport.
'use strict';

const fs = require('fs');
const { google } = require('googleapis');

// Mailbox we send from / read. Configurable so a different parent-facing inbox
// can be used without code changes.
const COMMS_MAILBOX = process.env.COMMS_MAILBOX || 'admin@littleangelsealing.co.uk';

const SEND_SCOPE     = 'https://www.googleapis.com/auth/gmail.send';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

// Resolve the SA key from a number of candidate locations. The ladn/.env sets
// GOOGLE_SA_KEY=/app/secrets/google-service-account.json, but the secrets dir is
// actually bind-mounted at /home/toby/secrets inside the container — so the env
// path is wrong. Try inline JSON, the env path(s), then the real mount points.
let _cachedKey = null;
function loadKey() {
  if (_cachedKey) return _cachedKey;

  const raw = process.env.GOOGLE_SA_KEY;
  // Inline JSON support (some deployments stuff the JSON straight into the env var).
  if (raw && raw.trim().startsWith('{')) {
    _cachedKey = JSON.parse(raw);
    return _cachedKey;
  }

  const candidates = [
    process.env.GOOGLE_SA_KEY_PATH,
    raw, // env value, if it's a path
    '/home/toby/secrets/google-service-account.json',
    '/app/secrets/google-service-account.json',
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        _cachedKey = JSON.parse(fs.readFileSync(p, 'utf8'));
        return _cachedKey;
      }
    } catch (_) { /* try next */ }
  }
  throw new Error('Google SA key not found (checked GOOGLE_SA_KEY/_PATH + /home/toby/secrets + /app/secrets)');
}

function isConfigured() {
  try { loadKey(); return true; } catch { return false; }
}

function jwtClient(scopes, subject) {
  const key = loadKey();
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes,
    subject: subject || COMMS_MAILBOX,
  });
}

const crypto = require('crypto');

// The body part (text / html / multipart-alternative) as { headerLines, content }.
function _bodyPart(html, text) {
  if (html && text) {
    const alt = 'alt_' + crypto.randomBytes(8).toString('hex');
    return {
      headerLines: [`Content-Type: multipart/alternative; boundary="${alt}"`],
      content: [
        `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', text, '',
        `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', html, '',
        `--${alt}--`,
      ].join('\r\n'),
    };
  }
  if (html) return { headerLines: ['Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit'], content: html };
  return { headerLines: ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit'], content: text || '' };
}

// Build an RFC822 MIME message and base64url-encode it for gmail.users.messages.send.
// attachments: [{ filename, content: Buffer|base64-string, contentType }].
function buildRaw({ from, to, subject, html, text, inReplyTo, references, attachments }) {
  const toList = Array.isArray(to) ? to.join(', ') : to;
  const headers = [
    `From: ${from}`,
    `To: ${toList}`,
    `Subject: ${encodeHeader(subject || '')}`,
    'MIME-Version: 1.0',
  ];
  if (inReplyTo)  headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const bp = _bodyPart(html, text);
  const hasAtt = Array.isArray(attachments) && attachments.length > 0;

  let mime;
  if (!hasAtt) {
    mime = headers.concat(bp.headerLines).join('\r\n') + '\r\n\r\n' + bp.content;
  } else {
    const mixed = 'mixed_' + crypto.randomBytes(8).toString('hex');
    headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
    const parts = [];
    // 1) the message body
    parts.push(`--${mixed}`, ...bp.headerLines, '', bp.content);
    // 2) each attachment, base64 in 76-char lines
    for (const a of attachments) {
      const b64 = Buffer.isBuffer(a.content)
        ? a.content.toString('base64')
        : (a.encoding === 'base64' ? String(a.content) : Buffer.from(String(a.content)).toString('base64'));
      const fname = (a.filename || 'attachment').replace(/"/g, '');
      parts.push(
        `--${mixed}`,
        `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${fname}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${fname}"`,
        '',
        (b64.match(/.{1,76}/g) || []).join('\r\n'),
      );
    }
    parts.push(`--${mixed}--`);
    mime = headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
  }
  return Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC2047 encode a header value if it contains non-ASCII (keeps subjects with
// emoji / accented chars valid).
function encodeHeader(s) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

/**
 * Send an email via the Gmail API as COMMS_MAILBOX (or opts.from mailbox).
 * Returns { ok:true, messageId, threadId } on success. Throws on failure
 * (including 403/unauthorized_client when DWD has not propagated).
 */
async function sendViaGmail({ to, subject, html, text, from, inReplyTo, references, threadId, attachments } = {}) {
  if (!to) throw new Error('sendViaGmail: missing recipient');
  const mailbox = from || COMMS_MAILBOX;
  const fromHeader = `Little Angels Day Nursery <${mailbox}>`;
  const auth = jwtClient([SEND_SCOPE], mailbox);
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = buildRaw({ from: fromHeader, to, subject, html, text, inReplyTo, references, attachments });
  const requestBody = { raw };
  if (threadId) requestBody.threadId = threadId;

  const resp = await gmail.users.messages.send({ userId: 'me', requestBody });
  return { ok: true, messageId: resp.data.id, threadId: resp.data.threadId };
}

/**
 * List recent inbox messages and fetch their content.
 * Returns an array of { messageId, threadId, from, fromEmail, fromName, subject,
 * snippet, bodyText, bodyHtml, receivedAt }.
 * Throws on 403/unauthorized_client (readonly DWD not yet propagated) — caller
 * must detect this and skip cleanly without faking rows.
 */
async function listInbox({ maxResults = 25, query = 'in:inbox newer_than:14d' } = {}) {
  const auth = jwtClient([READONLY_SCOPE], COMMS_MAILBOX);
  const gmail = google.gmail({ version: 'v1', auth });

  const list = await gmail.users.messages.list({ userId: 'me', maxResults, q: query });
  const ids = (list.data.messages || []).map(m => m.id);
  const out = [];
  for (const id of ids) {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      out.push(parseMessage(msg.data));
    } catch (e) {
      // skip individual failures, keep going
      console.error('[gmail-sender] get message failed', id, e.message);
    }
  }
  return out;
}

function headerVal(headers, name) {
  const h = (headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function decodeB64Url(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractBody(payload) {
  let text = '', html = '';
  function walk(part) {
    if (!part) return;
    const mt = part.mimeType || '';
    if (mt === 'text/plain' && part.body?.data) text += decodeB64Url(part.body.data);
    else if (mt === 'text/html' && part.body?.data) html += decodeB64Url(part.body.data);
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return { text, html };
}

function parseMessage(data) {
  const headers = data.payload?.headers || [];
  const fromRaw = headerVal(headers, 'From');
  const m = fromRaw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/) || [];
  const fromName  = (m[1] || '').trim();
  const fromEmail = (m[2] || fromRaw).trim().toLowerCase();
  const { text, html } = extractBody(data.payload);
  const internalDate = data.internalDate ? new Date(parseInt(data.internalDate, 10)) : null;
  return {
    messageId: data.id,
    threadId:  data.threadId,
    rfcMessageId: headerVal(headers, 'Message-ID'),
    from: fromRaw,
    fromEmail,
    fromName: fromName || fromEmail,
    subject: headerVal(headers, 'Subject'),
    snippet: data.snippet || '',
    bodyText: text,
    bodyHtml: html,
    receivedAt: internalDate ? internalDate.toISOString() : null,
    labelIds: data.labelIds || [],
  };
}

// Detect the "DWD not yet propagated" error so callers can skip cleanly.
function isAuthScopeError(err) {
  const msg = (err && (err.message || '')) + ' ' + JSON.stringify(err && err.response && err.response.data || '');
  return /unauthorized_client|access_denied|insufficient.*scope|403|invalid_grant|forbidden/i.test(msg);
}

module.exports = {
  COMMS_MAILBOX,
  isConfigured,
  sendViaGmail,
  listInbox,
  isAuthScopeError,
};
