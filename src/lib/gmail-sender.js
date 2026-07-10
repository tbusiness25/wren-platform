// Gmail-API sender + reader via the LADN Google service account (domain-wide
// delegation). NO Brevo, NO n8n dependency — this is the preferred outbound path
// and the inbound poll source for the comms hub.
//
// Auth model: a single service account (client_id 113082589617878840904,
// gmail090426@your-project.iam.gserviceaccount.com) is authorised in Google
// Workspace Admin → Domain-wide delegation for scopes gmail.send (live) and
// gmail.readonly (Toby is adding this). We impersonate a real Workspace mailbox
// (COMMS_MAILBOX, default admin@example-nursery.co.uk) via JWT `subject`.
//
// If a call returns 403 / unauthorized_client the DWD scope has not propagated —
// callers should LOG that clearly and NOT fall back to a fake transport.
'use strict';

const fs = require('fs');
const { google } = require('googleapis');

// Mailbox we send from / read. Configurable so a different parent-facing inbox
// can be used without code changes.
const COMMS_MAILBOX = process.env.COMMS_MAILBOX || 'admin@example-nursery.co.uk';

const SEND_SCOPE     = 'https://www.googleapis.com/auth/gmail.send';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

// Resolve the SA key from a number of candidate locations. The ladn/.env sets
// GOOGLE_SA_KEY=/app/secrets/google-service-account.json, but the secrets dir is
// actually bind-mounted at /run/secrets inside the container — so the env
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
    '/run/secrets/google-service-account.json',
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
  throw new Error('Google SA key not found (checked GOOGLE_SA_KEY/_PATH + /run/secrets + /app/secrets)');
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

// Build an RFC822 MIME message and base64url-encode it for gmail.users.messages.send.
function buildRaw({ from, to, subject, html, text, inReplyTo, references }) {
  const toList = Array.isArray(to) ? to.join(', ') : to;
  const boundary = 'wren_' + Buffer.from(String(subject || '') + toList).toString('hex').slice(0, 16);
  const headers = [
    `From: ${from}`,
    `To: ${toList}`,
    `Subject: ${encodeHeader(subject || '')}`,
    'MIME-Version: 1.0',
  ];
  if (inReplyTo)  headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  let body;
  if (html && text) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit', '',
      text, '',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit', '',
      html, '',
      `--${boundary}--`,
    ].join('\r\n');
  } else if (html) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: 8bit');
    body = html;
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: 8bit');
    body = text || '';
  }

  const mime = headers.join('\r\n') + '\r\n\r\n' + body;
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
async function sendViaGmail({ to, subject, html, text, from, inReplyTo, references, threadId } = {}) {
  if (!to) throw new Error('sendViaGmail: missing recipient');
  const mailbox = from || COMMS_MAILBOX;
  const fromHeader = `Your Nursery <${mailbox}>`;
  const auth = jwtClient([SEND_SCOPE], mailbox);
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = buildRaw({ from: fromHeader, to, subject, html, text, inReplyTo, references });
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
