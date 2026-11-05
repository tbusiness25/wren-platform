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
// Mailbox Wren READS (inbox polling). Split from COMMS_MAILBOX so we can pull the
// shared business inbox (staff@) for comms/parent-replies WITHOUT changing the
// send-auth mailbox. Defaults to COMMS_MAILBOX when unset (backward compatible).
// (2026-08-04) admin@ is a toby@ alias = confidential; staff@ is the real shared inbox.
const INBOX_MAILBOX = process.env.INBOX_MAILBOX || COMMS_MAILBOX;

const SEND_SCOPE     = 'https://www.googleapis.com/auth/gmail.send';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SETTINGS_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic'; // OOO / vacation responder (add in Workspace DWD)
// b279 (2026-09-04): Toby added gmail.modify to the SA's domain-wide delegation,
// so a routing rule can label / archive / mark-read as well as read. Every write
// it enables is reversible from the Gmail UI (a label can be removed, an archived
// thread is still in All Mail) — nothing here deletes a message, and there is no
// code path to gmail.users.messages.delete or .trash on purpose.
const MODIFY_SCOPE   = 'https://www.googleapis.com/auth/gmail.modify';

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
function buildRaw({ from, to, bcc, replyTo, subject, html, text, inReplyTo, references, attachments }) {
  const toList = Array.isArray(to) ? to.join(', ') : to;
  const headers = [
    `From: ${from}`,
    `To: ${toList}`,
    `Subject: ${encodeHeader(subject || '')}`,
    'MIME-Version: 1.0',
  ];
  // Reply-To lets replies route somewhere other than the From (e.g. the parent
  // email-reply gateway's plus-addressed, token-bearing mailbox).
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  // Bcc keeps bulk recipients hidden from one another (Gmail strips the header on
  // delivery). Used by the newsletter audience send.
  const bccList = Array.isArray(bcc) ? bcc.join(', ') : bcc;
  if (bccList) headers.push(`Bcc: ${bccList}`);
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
async function sendViaGmail({ to, bcc, replyTo, subject, html, text, from, fromName, impersonate, inReplyTo, references, threadId, attachments } = {}) {
  const hasBcc = Array.isArray(bcc) ? bcc.length > 0 : !!bcc;
  if (!to && !hasBcc) throw new Error('sendViaGmail: missing recipient');
  // Hard no-send guard for non-prod/test (MAIL_DISABLED=true, set on wren-ladn-dev). Belt-and-
  // braces so NO email path — queue drain, notifications, direct sends — can reach real inboxes
  // from a test environment via the shared Gmail account.
  if (/_dev$/i.test(process.env.PG_DB || '') || String(process.env.MAIL_DISABLED || '').toLowerCase() === 'true') {
    console.warn(`[gmail-sender] dev/MAIL_DISABLED — not sending "${subject}" to ${to} (test env)`);
    return { id: 'mail-disabled', disabled: true };
  }
  // The From address shown to recipients (`from`) is decoupled from the mailbox we
  // AUTHENTICATE as (`impersonate`). info@ / admin@ are Google Groups, not user
  // mailboxes, so the SA can't impersonate them — but it CAN impersonate a real user
  // mailbox and still set From: to a same-domain group address (DKIM signs the whole
  // domain, so DMARC still aligns). Falls back to old behaviour when impersonate omitted.
  const DEFAULT_FROM = process.env.WREN_FROM_EMAIL || 'info@example-nursery.co.uk';
  const fromEmail = from || DEFAULT_FROM;                  // parent-facing From (info@ by default)
  // info@ is a Google Group (not impersonatable). When From is the default group address,
  // authenticate as COMMS_MAILBOX (admin@ — the SA CAN impersonate it); an explicit real
  // `from` still impersonates itself (back-compat); `impersonate` overrides everything.
  const mailbox = impersonate
    || (fromEmail.toLowerCase() === DEFAULT_FROM.toLowerCase() ? COMMS_MAILBOX : fromEmail);
  const fromHeader = `${fromName || 'Your Nursery'} <${fromEmail}>`;
  const auth = jwtClient([SEND_SCOPE], mailbox);
  const gmail = google.gmail({ version: 'v1', auth });

  // When Bcc-only (bulk newsletter), address the visible To to the sending mailbox
  // itself so the message is well-formed and recipients stay hidden.
  const toField = to || mailbox;
  const raw = buildRaw({ from: fromHeader, to: toField, bcc, replyTo, subject, html, text, inReplyTo, references, attachments });
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
// 2026-08-19: READ access is allowlisted. COMMS_MAILBOX (admin@) is the SENDING identity and
// also receives confidential owner correspondence — staff must never be able to read it through
// the in-app inbox. Previously nothing stopped a caller passing `mailbox: 'admin@...'`, and
// INBOX_MAILBOX silently fell back to COMMS_MAILBOX if the env var were ever unset. Both are now
// closed: only mailboxes on READABLE_MAILBOXES can be read, and an unknown one throws rather
// than quietly widening access.
const READABLE_MAILBOXES = (process.env.READABLE_MAILBOXES
  || process.env.INBOX_MAILBOX
  || 'staff@example-nursery.co.uk')
  .split(',').map(m => m.trim().toLowerCase()).filter(Boolean);

function assertReadableMailbox(mailbox) {
  const m = String(mailbox || '').trim().toLowerCase();
  if (!m) throw new Error('mailbox required');
  if (!READABLE_MAILBOXES.includes(m)) {
    throw new Error(`refusing to read mailbox ${m} — not in READABLE_MAILBOXES`);
  }
  return m;
}

// 2026-09-17: the SEND path has refused to run on dev since August. The READ path
// had no such guard, so wren-ladn-dev — same code, same mounted credentials — was
// polling the live staff@ mailbox into wren_dev every eight minutes; 1,089 real
// messages were found there. Same test, same flags: dev reads no real mailbox.
function readsDisabled() {
  return /_dev$/i.test(process.env.PG_DB || '')
    || String(process.env.MAIL_DISABLED || '').toLowerCase() === 'true';
}

async function listInbox({ maxResults = 25, query = 'in:inbox newer_than:14d', mailbox } = {}) {
  if (readsDisabled()) {
    console.warn('[gmail-sender] dev/MAIL_DISABLED — not reading any real mailbox (test env)');
    return [];
  }
  const target = assertReadableMailbox(mailbox || INBOX_MAILBOX);
  const auth = jwtClient([READONLY_SCOPE], target);
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

// b428 — date-only evidence (scripts/b424-backfill-enquiry-dates.js): the
// earliest message date matching `query`, without ever downloading a subject,
// body or attachment. `listInbox()` above calls messages.get(format:'full')
// per message — fine for a handful of inbox messages to act on, wrong for a
// bulk backfill scanning many families' email history just to read a
// timestamp. This lists ids only (messages.list), then fetches each with
// format:'minimal' (internalDate + labels only, no payload). Bounded by
// maxIds so one address can never balloon into hundreds of API calls.
const EARLIEST_DATE_MAX_IDS = 100;
// b429 — a sanity ceiling on the ID-LISTING loop, not a correctness bound:
// these queries are always scoped to one address, so 20 pages (≤1000 ids) is
// generously more than any real family's history, while still stopping a
// pathological mailbox from looping forever.
const EARLIEST_DATE_MAX_LIST_PAGES = 20;
async function earliestMessageDate({ mailbox, query, maxIds = EARLIEST_DATE_MAX_IDS } = {}) {
  if (readsDisabled()) {
    console.warn('[gmail-sender] dev/MAIL_DISABLED — not reading any real mailbox (test env)');
    return null;
  }
  const target = assertReadableMailbox(mailbox || INBOX_MAILBOX);
  const auth = jwtClient([READONLY_SCOPE], target);
  const gmail = google.gmail({ version: 'v1', auth });

  // b429 — list EVERY id first (ids only — messages.list never returns a
  // body). Gmail returns newest-first, so the old loop (stop paging once
  // ids.length reached maxIds) only ever SAW the newest `maxIds` messages —
  // for any thread with more history than that, the real earliest message
  // was never listed at all, let alone fetched.
  const ids = [];
  let pageToken;
  let pages = 0;
  do {
    const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 50, pageToken });
    (list.data.messages || []).forEach(m => ids.push(m.id));
    pageToken = list.data.nextPageToken;
    pages += 1;
  } while (pageToken && pages < EARLIEST_DATE_MAX_LIST_PAGES);

  // The oldest messages are at the END of this newest-first list — fetch
  // format:'minimal' (internalDate only, never a body/subject) for just that
  // tail, bounded by maxIds.
  const oldestIds = ids.slice(-maxIds);
  let earliest = null;
  for (const id of oldestIds) {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'minimal' });
      const t = msg.data.internalDate ? new Date(Number(msg.data.internalDate)) : null;
      if (t && (!earliest || t < earliest)) earliest = t;
    } catch (_) { /* skip individual failures, keep going */ }
  }
  return earliest;
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

// b279: attachment PARTS only — filename, mime, size and the id needed to fetch
// the bytes later. The bytes themselves are never pulled during a poll; a rule
// that files an attachment fetches it on demand via getAttachment().
function extractAttachments(payload) {
  const out = [];
  function walk(part) {
    if (!part) return;
    const filename = part.filename || '';
    const attachmentId = part.body?.attachmentId;
    // A part with a filename AND an attachmentId is a real attachment; inline
    // images carry a Content-ID and are skipped (they are body decoration, not
    // a document anyone wants filed).
    const isInline = (part.headers || []).some(h =>
      h.name?.toLowerCase() === 'content-disposition' && /^\s*inline/i.test(h.value || ''));
    if (filename && attachmentId && !isInline) {
      out.push({
        attachmentId,
        filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: Number(part.body?.size || 0),
      });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return out;
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
    to: headerVal(headers, 'To'),
    deliveredTo: headerVal(headers, 'Delivered-To'),
    xOriginalTo: headerVal(headers, 'X-Original-To'),
    cc: headerVal(headers, 'Cc'),
    subject: headerVal(headers, 'Subject'),
    snippet: data.snippet || '',
    bodyText: text,
    bodyHtml: html,
    receivedAt: internalDate ? internalDate.toISOString() : null,
    labelIds: data.labelIds || [],
    attachments: extractAttachments(data.payload),
  };
}

// ── b279: gmail.modify writes (label / archive / mark read) ─────────────────
// Same no-touch guard as sendViaGmail: on wren_dev (PG_DB ends _dev) or with
// MAIL_DISABLED=true these are logged and skipped. A dev container shares the
// real Google service account, so without this a test run would archive the
// nursery's actual inbox.
function _mailboxWritesDisabled() {
  return /_dev$/i.test(process.env.PG_DB || '')
      || String(process.env.MAIL_DISABLED || '').toLowerCase() === 'true';
}

/**
 * Add and/or remove labels on one message. Archiving is removeLabelIds:['INBOX'];
 * marking read is removeLabelIds:['UNREAD']. Both are reversible in Gmail.
 * @returns {Promise<{ok:boolean, disabled?:boolean, labelIds?:string[]}>}
 */
async function modifyMessage({ messageId, addLabelIds = [], removeLabelIds = [], mailbox } = {}) {
  if (!messageId) throw new Error('modifyMessage: messageId required');
  const target = assertReadableMailbox(mailbox || INBOX_MAILBOX);
  if (!addLabelIds.length && !removeLabelIds.length) return { ok: true, labelIds: [] };
  if (_mailboxWritesDisabled()) {
    console.warn(`[gmail-sender] dev/MAIL_DISABLED — not modifying message ${messageId} (+${addLabelIds.length}/-${removeLabelIds.length} labels)`);
    return { ok: true, disabled: true };
  }
  const auth = jwtClient([MODIFY_SCOPE], target);
  const gmail = google.gmail({ version: 'v1', auth });
  const r = await gmail.users.messages.modify({
    userId: 'me', id: messageId, requestBody: { addLabelIds, removeLabelIds },
  });
  return { ok: true, labelIds: r.data?.labelIds || [] };
}

/** Resolve a user label by name, creating it if it does not exist. Returns its id. */
async function ensureLabel({ name, mailbox } = {}) {
  const label = String(name || '').trim();
  if (!label) throw new Error('ensureLabel: name required');
  const target = assertReadableMailbox(mailbox || INBOX_MAILBOX);
  if (_mailboxWritesDisabled()) {
    console.warn(`[gmail-sender] dev/MAIL_DISABLED — not creating label "${label}"`);
    return { id: null, disabled: true };
  }
  const auth = jwtClient([MODIFY_SCOPE], target);
  const gmail = google.gmail({ version: 'v1', auth });
  const list = await gmail.users.labels.list({ userId: 'me' });
  const found = (list.data.labels || []).find(l => (l.name || '').toLowerCase() === label.toLowerCase());
  if (found) return { id: found.id };
  const made = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name: label, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  return { id: made.data.id, created: true };
}

/**
 * Fetch one attachment's bytes. READ-only — this is the gmail.readonly scope,
 * not modify. Returns a Buffer. Callers must not log the contents.
 */
async function getAttachment({ messageId, attachmentId, mailbox } = {}) {
  if (readsDisabled()) throw new Error('dev/MAIL_DISABLED — real mailbox attachments are not readable from a test environment');
  if (!messageId || !attachmentId) throw new Error('getAttachment: messageId and attachmentId required');
  const target = assertReadableMailbox(mailbox || INBOX_MAILBOX);
  const auth = jwtClient([READONLY_SCOPE], target);
  const gmail = google.gmail({ version: 'v1', auth });
  const r = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  const data = r.data?.data || '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Detect the "DWD not yet propagated" error so callers can skip cleanly.
function isAuthScopeError(err) {
  const msg = (err && (err.message || '')) + ' ' + JSON.stringify(err && err.response && err.response.data || '');
  return /unauthorized_client|access_denied|insufficient.*scope|403|invalid_grant|forbidden/i.test(msg);
}

// Set (or clear) a mailbox's out-of-office / vacation auto-reply. Requires the
// gmail.settings.basic DWD scope on the SA. `mailbox` is a REAL user mailbox (e.g.
// toby@example-nursery.co.uk) — Google Groups can't have a vacation responder.
/** Read a mailbox's current vacation-responder state. Added 2026-08-20: away-mode could
 *  SET a responder but nothing could ever check one, so an OOO left on by a direct DB edit
 *  (or a failed toggle) was invisible until a parent replied saying "you're on holiday?".
 *  Returns {enabled, subject, startTime, endTime}. */
async function getVacationResponder(mailbox) {
  if (!mailbox) throw new Error('mailbox required');
  const auth = jwtClient([SETTINGS_SCOPE], mailbox);
  const gmail = google.gmail({ version: 'v1', auth });
  const r = await gmail.users.settings.getVacation({ userId: 'me' });
  const d = r.data || {};
  return {
    enabled: d.enableAutoReply === true,
    subject: d.responseSubject || '',
    startTime: d.startTime || null,
    endTime: d.endTime || null,
  };
}

async function setVacationResponder({ mailbox, subject, html, text, enable, startTime, endTime } = {}) {
  if (!mailbox) throw new Error('mailbox required');
  const auth = jwtClient([SETTINGS_SCOPE], mailbox);
  const gmail = google.gmail({ version: 'v1', auth });
  const requestBody = enable
    ? {
        enableAutoReply: true,
        responseSubject: subject || 'Out of office',
        responseBodyHtml: html || undefined,
        responseBodyPlainText: text || undefined,
        restrictToDomain: false,   // reply to external senders too (parents/suppliers)
        restrictToContacts: false,
        ...(startTime ? { startTime: String(startTime) } : {}),
        ...(endTime ? { endTime: String(endTime) } : {}),
      }
    : { enableAutoReply: false };
  await gmail.users.settings.updateVacation({ userId: 'me', requestBody });
  return true;
}


/**
 * 2026-10-05 — the RFC Message-ID / References of a message in a mailbox we may read, so a reply
 * sent from a DIFFERENT mailbox (staff@ conversation answered via toby@'s info@ alias) still
 * threads at the recipient's end. Returns {} when unreadable — callers fall back gracefully.
 */
async function getThreadingHeaders(mailbox, gmailMessageId) {
  try {
    const target = assertReadableMailbox(mailbox);
    const auth = jwtClient([READONLY_SCOPE], target);
    const g = google.gmail({ version: 'v1', auth });
    const m = await g.users.messages.get({ userId: 'me', id: gmailMessageId, format: 'metadata',
      metadataHeaders: ['Message-ID', 'References', 'Subject'] });
    const h = (n) => headerVal(m.data.payload && m.data.payload.headers, n);
    const mid = h('Message-ID');
    return mid ? { inReplyTo: mid, references: [h('References'), mid].filter(Boolean).join(' ') } : {};
  } catch (_) { return {}; }
}

// 2026-10-09 (Toby: "I responded through Gmail since… set it so the inbox always has the
// latest data"). Metadata-only look at one Gmail thread — labels and dates, never content —
// so the Roost inbox can tell "someone already replied in Gmail" / "archived in Gmail" apart
// from "still waiting". Allowlisted separately from READABLE_MAILBOXES because it reads no
// message bodies: REPLY_CHECK_MAILBOXES (default staff@ + admin@, toby@'s alias).
const REPLY_CHECK_MAILBOXES = (process.env.REPLY_CHECK_MAILBOXES
  || 'staff@example-nursery.co.uk,admin@example-nursery.co.uk')
  .split(',').map(m => m.trim().toLowerCase()).filter(Boolean);
async function threadReplyState({ mailbox, threadId } = {}) {
  if (readsDisabled()) return null;
  const m = String(mailbox || '').trim().toLowerCase();
  if (!m || !threadId || !REPLY_CHECK_MAILBOXES.includes(m)) return null;
  const auth = jwtClient([READONLY_SCOPE], m);
  const g = google.gmail({ version: 'v1', auth });
  const r = await g.users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['Date'] });
  const msgs = (r.data && r.data.messages) || [];
  let lastSentAt = null, lastInboundAt = null, inInbox = false;
  for (const x of msgs) {
    const at = x.internalDate ? new Date(parseInt(x.internalDate, 10)) : null;
    const labels = x.labelIds || [];
    if (labels.includes('INBOX')) inInbox = true;
    if (labels.includes('SENT')) { if (at && (!lastSentAt || at > lastSentAt)) lastSentAt = at; }
    else if (at && (!lastInboundAt || at > lastInboundAt)) lastInboundAt = at;
  }
  return { lastSentAt, lastInboundAt, inInbox, messages: msgs.length };
}

module.exports = {
  threadReplyState,
  // 2026-10-08: shared with google-calendar.js, which required GOOGLE_SA_KEY's
  // (wrong) path directly and 500'd.
  loadKey,
  getThreadingHeaders,
  COMMS_MAILBOX,
  INBOX_MAILBOX,
  READABLE_MAILBOXES,
  assertReadableMailbox,
  isConfigured,
  sendViaGmail,
  setVacationResponder,
  getVacationResponder,
  listInbox,
  earliestMessageDate,
  isAuthScopeError,
  // b279 — routing-rule surface: attachment bytes on demand, and the reversible
  // gmail.modify writes (label / archive / mark read).
  getAttachment,
  modifyMessage,
  ensureLabel,
  extractAttachments,
};
