// Parent email-reply gateway — stateless reply tokens + address + quote stripping.
// (2026-08-04) See wren-docs/decisions/2026-08-04-parent-email-reply-gateway.md
//
// A reply token binds an outbound parent email to its (thread, child) so a plain
// email reply can be routed back onto the right Wren thread — WITHOUT a lookup
// table. It is an HMAC over "<threadId>.<childId>" keyed by JWT_SECRET, so it
// cannot be forged and needs no storage. The token is embedded in a plus-address
// Reply-To on the mailbox Wren already polls (COMMS_MAILBOX, default admin@).
'use strict';
const crypto = require('crypto');

const COMMS_MAILBOX = process.env.COMMS_MAILBOX || 'admin@example-nursery.co.uk';
// Reply-To must land in the SAME mailbox the poller reads (INBOX_MAILBOX). Explicit
// PARENT_REPLY_MAILBOX overrides; else follow the inbox; else COMMS_MAILBOX.
const REPLY_BASE = process.env.PARENT_REPLY_MAILBOX || process.env.INBOX_MAILBOX || COMMS_MAILBOX;

function _secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set — cannot sign parent reply tokens');
  return s;
}

function _sig(payload) {
  return crypto.createHmac('sha256', _secret()).update(payload).digest('hex').slice(0, 12);
}

// rt<threadId>c<childId>s<sig12> — all plus-address-safe chars.
function makeToken(threadId, childId) {
  const tid = parseInt(threadId, 10), cid = parseInt(childId, 10);
  if (!Number.isInteger(tid) || !Number.isInteger(cid)) return null;
  const payload = `${tid}.${cid}`;
  return `rt${tid}c${cid}s${_sig(payload)}`;
}

const TOKEN_RE = /rt(\d+)c(\d+)s([0-9a-f]{12})/i;

// Returns { threadId, childId } if the token is present AND the HMAC verifies, else null.
function verifyToken(str) {
  if (!str) return null;
  const m = String(str).match(TOKEN_RE);
  if (!m) return null;
  const threadId = parseInt(m[1], 10), childId = parseInt(m[2], 10), sig = m[3].toLowerCase();
  const expect = _sig(`${threadId}.${childId}`);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { threadId, childId };
}

// Reply-To address carrying the token as a plus-tag on the polled mailbox.
function replyToAddress(token) {
  const at = REPLY_BASE.indexOf('@');
  if (at < 0) return REPLY_BASE;
  const local = REPLY_BASE.slice(0, at), domain = REPLY_BASE.slice(at + 1);
  return `${local}+${token}@${domain}`;
}

// Strip quoted history + common signatures from an email reply, keeping only what
// the parent actually typed. Conservative: cut at the FIRST recognised boundary.
function stripQuoted(raw) {
  if (!raw) return '';
  let text = String(raw).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const boundaries = [
    /^\s*On .+wrote:\s*$/i,                 // Gmail/Apple "On <date>, <name> wrote:"
    /^\s*-----\s*Original Message\s*-----/i,// Outlook
    /^\s*_{5,}\s*$/,                        // Outlook underscore rule
    /^\s*From:\s.+/i,                       // forwarded/quoted header block
    /^\s*>{1,}/,                            // quoted lines
    /^\s*Sent from my /i,                   // mobile signatures
    /^\s*Get Outlook for /i,
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (boundaries.some(re => re.test(lines[i]))) { cut = i; break; }
  }
  let body = lines.slice(0, cut).join('\n');
  // Trim a trailing "--" signature delimiter block too.
  body = body.replace(/\n--\s*\n[\s\S]*$/, '');
  return body.trim();
}

module.exports = { makeToken, verifyToken, replyToAddress, stripQuoted, COMMS_MAILBOX, REPLY_BASE, TOKEN_RE };
