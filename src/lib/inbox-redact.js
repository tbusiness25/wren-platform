'use strict';
/**
 * inbox-redact.js — b235 (2026-08-26)
 *
 * The one-way door between "data the local model may read" and "text that is
 * allowed to be written down".
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * b235 reads real correspondence. The local model may see all of it. Logs,
 * NOTES files, Telegram messages and anything under wren-docs may see NONE of
 * it — no names, no email addresses, no subject lines.
 *
 * This is not a new rule. `feedback_counts_only_every_write_path` records four
 * cron jobs that quietly leaked parent addresses and child names into
 * /app/build-logs for months, because the redaction lived at the "obvious"
 * write path and not at the others. So the discipline here is: every write path
 * goes through this file, including the ones that feel harmless.
 *
 *   safe(text)     scrub a free string for output
 *   ref(email)     the stable, non-identifying handle for a person
 *   hash(value)    the join key that never reverses to a name
 *
 * ── WHY A HASH AND NOT A NAME ───────────────────────────────────────────────
 * The analysis needs to know that thread A and thread B are the same person; it
 * never needs to know who that person is. sha256(lowercased address) gives the
 * first and denies the second, and `ref()` keeps the domain because "which
 * domain is emailing me" is a real, non-identifying signal (hmrc.gov.uk vs
 * gmail.com routes very differently).
 */

const crypto = require('crypto');

// Stable per-deployment so hashes join across runs; not a secret, and salting
// per-run would break exactly the linkage the analysis needs.
const SALT = process.env.B235_HASH_SALT || 'wren-b235';

/** sha256, truncated. Short enough to read in a log, long enough not to collide. */
function hash(value, len = 12) {
  return crypto.createHash('sha256')
    .update(SALT + '|' + String(value == null ? '' : value).trim().toLowerCase())
    .digest('hex').slice(0, len);
}

/** Everything after the last @, lowercased. '' if there isn't one. */
function domainOf(email) {
  const m = /@([^@\s>]+)$/.exec(String(email || '').trim().replace(/[>\s]+$/, ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * The loggable handle for a correspondent: `a1b2c3d4e5f6@gmail.com`.
 * Deterministic, joinable, and not a person.
 */
function ref(email) {
  const d = domainOf(email);
  return `${hash(email)}${d ? '@' + d : ''}`;
}

/** Pull the address out of `Some Name <a@b.c>` — the name is discarded, not returned. */
function addressOf(fromHeader) {
  const s = String(fromHeader || '');
  const angled = /<([^>]+)>/.exec(s);
  const raw = angled ? angled[1] : s;
  const m = /[^\s<>,;:"']+@[^\s<>,;:"']+/.exec(raw);
  return m ? m[0].toLowerCase() : '';
}

const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
// The lookarounds are load-bearing. Without them this matched the digit run
// inside a Gmail thread id (19eb22c8f0…) and inside a run id (b235-20260826…),
// and the audit reported 197 "phone numbers" that were nothing of the kind.
// A phone number is a standalone token, so it must not be flanked by other
// alphanumerics.
const PHONE_RE = /(?<![A-Za-z0-9])(?:\+44\s?|0)\d[\d\s-]{7,12}\d(?![A-Za-z0-9])/g;

/** A PHONE_RE match is only a phone number if it carries 10–13 actual digits. */
function looksLikePhone(m) {
  const digits = String(m).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 13;
}
// A capitalised pair is the shape of a person's name. It is also the shape of
// "Your Nursery", so an allowlist keeps the obvious org names readable — a
// scrub that mangles every proper noun gets switched off, and then nothing is
// scrubbed at all.
const NAME_RE = /\b([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,15})\b/g;
const NAME_ALLOW = new Set([
  'Your Nursery', 'Day Nursery', 'Companies House', 'Ealing Council',
  'Early Years', 'Bank Holiday', 'Direct Debit', 'Standing Order',
  'Local Authority', 'Working Tax', 'Tax Free', 'Free Childcare',
  'Data Protection', 'Information Commissioner', 'Google Workspace',
]);

/**
 * Scrub a free-text string so it is safe to print, log or paste into a doc.
 * Addresses become refs, phone numbers and name-shaped pairs become tokens.
 * Deliberately blunt: false positives cost readability, false negatives cost a
 * GDPR incident.
 * @param {string} text
 * @param {{max?:number}} [opts]
 */
function safe(text, opts = {}) {
  let s = String(text == null ? '' : text);
  s = s.replace(EMAIL_RE, (m) => `[${ref(m)}]`);
  s = s.replace(PHONE_RE, (m) => (looksLikePhone(m) ? '[phone]' : m));
  s = s.replace(NAME_RE, (m) => (NAME_ALLOW.has(m) ? m : '[name]'));
  const max = opts.max == null ? 300 : opts.max;
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

/**
 * safe() for AUDIT OUTPUT, where readability is worth nothing and a leak costs
 * everything.
 *
 * safe() strips capitalised PAIRS ("Firstname Lastname") because that is the
 * shape of a full name. It does not strip a lone given name, and the b235
 * spot-check proved why that matters: the local model writes actions of the form
 * "Reply to <given name> about the invoice", and three real first names reached
 * an audit transcript before this existed. A first name plus a nursery is
 * identifying.
 *
 * Worth recording how that was found, because it is the whole lesson of
 * `feedback_counts_only_every_write_path` repeating itself: two of those names
 * were then copied into a comment in THIS file as illustrative examples, and
 * survived until a grep of the source against the real names in the database
 * caught them. Illustrative examples must be invented, never borrowed.
 *
 * So this removes EVERY capitalised word that is not sentence-initial and not
 * allowlisted. It mangles prose, which is fine — nobody reads an audit line for
 * pleasure, and the alternative is a name in a transcript.
 *
 * Deliberately NOT applied to what is stored in inbox_router_verdicts: the
 * database is a legitimate store for this, and "Reply to [name]" would make the
 * queue useless to the one person entitled to read it.
 */
const WORD_ALLOW = new Set([
  'I', 'The', 'A', 'An', 'This', 'That', 'It', 'If', 'Add', 'Reply', 'Send', 'Check',
  'Log', 'File', 'Read', 'Ask', 'Call', 'Confirm', 'Chase', 'Book', 'No', 'Wait',
  'Little', 'Angels', 'Nursery', 'Wren', 'Roost', 'Ofsted', 'HMRC', 'DBS', 'EYFS',
  'Gmail', 'Google', 'Xero', 'Zoom', 'BrightHR', 'September', 'October', 'November',
  'December', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
]);
function safeStrict(text, opts = {}) {
  let s = safe(text, { max: opts.max == null ? 200 : opts.max });
  s = s.replace(/(^|[.!?]\s+)?\b([A-Z][a-z]{1,20})\b/g, (m, lead, word) => {
    if (lead) return m;                       // sentence-initial, leave it
    if (WORD_ALLOW.has(word)) return m;
    return '[name]';
  });
  return s;
}

/**
 * A console.log that cannot leak. Everything printed by the b235 scripts goes
 * through this — see the note above about the write paths people forget.
 */
function safeLog(...parts) {
  console.log(parts.map((p) => (typeof p === 'string' ? safe(p, { max: 400 }) : p)).join(' '));
}

/**
 * Assert a string carries nothing personal. Used by the acceptance check so
 * "we grepped the logs and found nothing" is a test, not a claim.
 *
 * `allowDomains` exists because the setting's OWN mailbox
 * (admin@example-nursery.co.uk) is not personal data — it is configuration,
 * and it appears legitimately as a default in several files. Filtering has to
 * happen HERE, where the full address is still in scope: the returned hit is
 * truncated to three characters precisely so the audit's own output cannot leak,
 * which also means a caller can no longer tell what domain it belonged to.
 *
 * @param {string} text
 * @param {{allowDomains?: RegExp}} [opts]
 * @returns {{clean:boolean, hits:string[]}}
 */
function auditText(text, opts = {}) {
  const s = String(text || '');
  const allow = opts.allowDomains || null;
  const hits = [];
  // A ref (hash@domain) is by construction fine, so exclude those before testing.
  const withoutRefs = s.replace(/\[?[0-9a-f]{12}@[A-Za-z0-9.\-]+\]?/g, '');
  for (const e of (withoutRefs.match(EMAIL_RE) || [])) {
    if (allow && allow.test(domainOf(e))) continue;
    hits.push(`email:${e.slice(0, 3)}…`);
  }
  for (const p of (withoutRefs.match(PHONE_RE) || [])) {
    if (!looksLikePhone(p)) continue;
    hits.push(`phone:${p.slice(0, 4)}…`);
  }
  return { clean: hits.length === 0, hits };
}

module.exports = { hash, ref, domainOf, addressOf, safe, safeStrict, safeLog, auditText, looksLikePhone, EMAIL_RE, PHONE_RE };
