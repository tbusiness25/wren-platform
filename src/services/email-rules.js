// ═══════════════════════════════════════════════════════════════════════════
// b279 — email routing rules engine (2026-09-04)
//
// Replaces the hard-coded auto-forwarder that used to live in
// src/jobs/gmail-inbox-poller.js. A rule is TRIGGERS + ACTIONS + an on/off
// switch + a priority, all editable by a manager in Roost. Rules evaluate on
// the EXISTING poll — there is no second poller, no second Gmail connection.
//
// ── GDPR, which is the whole reason this file is shaped the way it is ──────
// Email bodies contain real parent and child personal data.
//
//   1. AI evaluation runs ONLY on the local Ollama. assertLocalOllama() refuses
//      any host that is not a private/Tailscale address, so misconfiguring the
//      setting to a cloud endpoint fails closed instead of posting a parent's
//      email to it. There is no cloud provider branch in this file to fall
//      back to.
//   2. Nothing here logs an email body, a subject line or an address. The log
//      line is rule id + message id + decision. `redact()` exists so a future
//      edit that reaches for a subject has to go around something.
//   3. email_rule_runs has no column that can hold email content (see the
//      migration) — the promise is enforced by the schema, not by discipline.
//
// ── Failure model ─────────────────────────────────────────────────────────
// An unreachable Ollama must NOT read as "the criterion didn't match" — that is
// a silent failure that looks identical to a working rule with nothing to do.
// evaluateAi() throws AiUnavailableError, which aborts the rule, records
// decision='ai_unavailable' with the error on the rule row, and takes NO action.
// Fail closed and fail visibly.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getPool } = require('../db/pool');
const gmail = require('../lib/gmail-sender');
const ai = require('../lib/ai-models');

// ── Settings ───────────────────────────────────────────────────────────────
// Read from ladn.settings with an env fallback, cached briefly so a poll cycle
// does not re-query for every rule.
let _settingsCache = null, _settingsAt = 0;
const SETTINGS_TTL_MS = 60 * 1000;

const SETTING_DEFAULTS = {
  email_rules_enabled: 'true',
  email_rules_ollama_host: process.env.EMAIL_RULES_OLLAMA_HOST
    || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  // b333: default is ai-models.js role 'fast', resolved once here — this key is
  // still readable/overridable via the settings row like every other value here.
  email_rules_ollama_model: process.env.EMAIL_RULES_OLLAMA_MODEL || ai.model('fast'),
  email_rules_ai_timeout_ms: '45000',
  email_rules_run_retention_days: '180',
};

async function settings(db) {
  if (_settingsCache && Date.now() - _settingsAt < SETTINGS_TTL_MS) return _settingsCache;
  const out = { ...SETTING_DEFAULTS };
  try {
    const { rows } = await (db || getPool()).query(
      `SELECT key, value FROM settings WHERE key LIKE 'email_rules_%'`);
    for (const r of rows) if (r.value !== null && r.value !== '') out[r.key] = r.value;
  } catch (_) { /* defaults are fine — a missing settings row must not stop the engine */ }
  _settingsCache = out; _settingsAt = Date.now();
  return out;
}
function _clearSettingsCache() { _settingsCache = null; _settingsAt = 0; }

// ── The local-AI wall ──────────────────────────────────────────────────────
// The single guarantee this build makes about personal data. A host is
// acceptable only if it resolves to a private address space:
//   127.0.0.0/8, 10/8, 172.16/12, 192.168/16, and 100.64/10 — the CGNAT range
//   Tailscale allocates from, which is where the Ascent (your-ollama-host) and
//   the 3090 (your-ollama-host) live.
// Anything else — a public IP, any hostname that is not localhost — is refused.
// A hostname is refused rather than resolved because DNS can change under us,
// and "we looked it up once and it was private" is not a wall.
class NotLocalHostError extends Error {
  constructor(host) {
    super(`refusing to send email content to ${host} — not a local/Tailscale host`);
    this.name = 'NotLocalHostError';
    this.code = 'not_local_host';
  }
}
class AiUnavailableError extends Error {
  constructor(msg) { super(msg); this.name = 'AiUnavailableError'; this.code = 'ai_unavailable'; }
}

function isLocalHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  // Docker-internal service names on the wren network (single label, no dots) are
  // in-building by construction — they cannot resolve outside the compose network.
  if (/^[a-z0-9][a-z0-9_-]*$/.test(h) && !h.includes('.')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some(n => n > 255)) return false;
  if (a === 127) return true;                       // loopback
  if (a === 10) return true;                        // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true;          // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT — Tailscale
  return false;
}

/** Throws NotLocalHostError unless `url` points somewhere inside the building. */
function assertLocalOllama(url) {
  let u;
  try { u = new URL(String(url)); } catch (_) { throw new NotLocalHostError(String(url)); }
  if (!isLocalHostname(u.hostname)) throw new NotLocalHostError(u.hostname);
  return u.origin;
}

// ── Redaction ──────────────────────────────────────────────────────────────
// Everything that leaves this module for a log, an error string or a run row
// goes through here. It is deliberately blunt: an address becomes <email>, a
// long free-text run becomes its length. If it looks like content, it goes.
function redact(s) {
  return String(s == null ? '' : s)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .slice(0, 300);
}

// ═══════════════════════════════════════════════════════════════════════════
// Conditions
// ═══════════════════════════════════════════════════════════════════════════

const CONDITION_TYPES = {
  from:            { label: 'Sender',              ops: ['contains', 'equals', 'domain', 'not_contains'] },
  subject:         { label: 'Subject',             ops: ['contains', 'not_contains', 'equals'] },
  body:            { label: 'Body',                ops: ['contains', 'not_contains'] },
  any_text:        { label: 'Subject or body',     ops: ['contains', 'not_contains'] },
  has_attachment:  { label: 'Has an attachment',   ops: ['is'] },
  attachment_name: { label: 'Attachment filename', ops: ['contains', 'ext'] },
  contact:         { label: 'Who the sender is',   ops: ['is_parent', 'is_staff', 'is_known', 'is_unknown'] },
  ai:              { label: 'AI criterion (plain English)', ops: ['matches'] },
};

const norm = s => String(s == null ? '' : s).toLowerCase();

function haystackFor(type, msg) {
  switch (type) {
    case 'from':     return norm(msg.fromEmail) + ' ' + norm(msg.fromName);
    case 'subject':  return norm(msg.subject);
    case 'body':     return norm(msg.bodyText || msg.snippet);
    case 'any_text': return norm(msg.subject) + ' ' + norm(msg.bodyText || msg.snippet);
    default:         return '';
  }
}

/** Sender classification against Wren's own records. No AI, no email content. */
async function classifySender(db, email) {
  const e = norm(email);
  if (!e) return { is_parent: false, is_staff: false, is_known: false };
  const out = { is_parent: false, is_staff: false, is_known: false };
  try {
    const { rows } = await db.query(
      `SELECT
         EXISTS (SELECT 1 FROM parent_portal_access WHERE lower(email)=$1 AND is_active IS NOT false) AS is_parent,
         EXISTS (SELECT 1 FROM staff WHERE lower(email)=$1 AND is_active=true)                        AS is_staff,
         EXISTS (SELECT 1 FROM contacts WHERE lower(primary_email)=$1 AND archived_at IS NULL)        AS is_contact`,
      [e]);
    if (rows.length) {
      out.is_parent = rows[0].is_parent === true;
      out.is_staff  = rows[0].is_staff === true;
      out.is_known  = out.is_parent || out.is_staff || rows[0].is_contact === true;
    }
  } catch (_) { /* an unknown sender is the safe default */ }
  return out;
}

/**
 * Evaluate one non-AI condition. Returns boolean.
 * Never throws for a malformed condition — an unrecognised type is `false`, so a
 * typo in the rule editor cannot make a rule match everything.
 */
async function evaluateCondition(db, cond, msg, ctx) {
  const type = String(cond?.type || '');
  const op   = String(cond?.op || 'contains');
  const val  = cond?.value;

  if (type === 'has_attachment') {
    const want = val !== false && val !== 'false';
    const has = Array.isArray(msg.attachments) && msg.attachments.length > 0;
    return want ? has : !has;
  }

  if (type === 'attachment_name') {
    const names = (msg.attachments || []).map(a => norm(a.filename));
    const needle = norm(val);
    if (!needle) return false;
    if (op === 'ext') return names.some(n => n.endsWith(needle.startsWith('.') ? needle : '.' + needle));
    return names.some(n => n.includes(needle));
  }

  if (type === 'contact') {
    ctx.sender = ctx.sender || await classifySender(db, msg.fromEmail);
    if (op === 'is_parent')  return ctx.sender.is_parent;
    if (op === 'is_staff')   return ctx.sender.is_staff;
    if (op === 'is_known')   return ctx.sender.is_known;
    if (op === 'is_unknown') return !ctx.sender.is_known;
    return false;
  }

  if (type === 'from' || type === 'subject' || type === 'body' || type === 'any_text') {
    const hay = haystackFor(type, msg);
    const needle = norm(val);
    if (!needle) return false;
    switch (op) {
      case 'equals':       return type === 'from' ? norm(msg.fromEmail) === needle : hay.trim() === needle;
      case 'domain':       return norm(msg.fromEmail).endsWith('@' + needle.replace(/^@/, ''));
      case 'not_contains': return !hay.includes(needle);
      case 'contains':
      default:             return hay.includes(needle);
    }
  }

  return false; // unknown type — never a match
}

// ── The AI criterion ───────────────────────────────────────────────────────
// Runs on the local Ollama and nowhere else. The prompt carries the sender name,
// subject and a truncated body because that is what "anything from a parent
// about fees" needs to be judged on — which is exactly why the host wall above
// is absolute rather than a default.
async function evaluateAi(db, criterion, msg, ctx) {
  const cfg = await settings(db);
  const host = assertLocalOllama(cfg.email_rules_ollama_host); // throws NotLocalHostError
  const model = cfg.email_rules_ollama_model;
  const timeout = parseInt(cfg.email_rules_ai_timeout_ms, 10) || 45000;
  ctx.aiHost = host;
  ctx.aiUsed = true;

  const body = String(msg.bodyText || msg.snippet || '').replace(/\s+/g, ' ').slice(0, 1500);
  const prompt = `You are filtering the inbox of Your Nursery in Ealing. Decide whether ONE email meets a criterion set by the manager.

CRITERION: ${String(criterion || '').slice(0, 500)}

EMAIL
From: ${msg.fromName || ''} <${msg.fromEmail || ''}>
Subject: ${msg.subject || '(no subject)'}
Body: ${body}

Answer ONLY with JSON, no prose and no markdown:
{"match": true or false, "confidence": 0.0 to 1.0, "why": "at most eight words"}

Judge only the criterion as written. If the email does not clearly meet it, answer false.`;

  let resp;
  try {
    resp = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, prompt, stream: false, think: false,
        options: ai.options({ temperature: 0, num_predict: 120 }),
      }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    // Unreachable, DNS failure, timeout. NOT a no-match.
    throw new AiUnavailableError(`local Ollama unreachable at ${host}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
  }
  if (!resp.ok) throw new AiUnavailableError(`local Ollama returned ${resp.status} at ${host}`);

  let data;
  try { data = await resp.json(); }
  catch (_) { throw new AiUnavailableError(`local Ollama returned unreadable JSON at ${host}`); }

  const raw = String(data.response || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new AiUnavailableError('local Ollama returned no JSON verdict');
  let parsed;
  try { parsed = JSON.parse(m[0]); }
  catch (_) { throw new AiUnavailableError('local Ollama returned malformed JSON verdict'); }

  // `why` is model-generated prose about a real email — it is NOT stored or
  // logged anywhere. Only the boolean crosses this line.
  return parsed.match === true || parsed.match === 'true';
}

// ═══════════════════════════════════════════════════════════════════════════
// Rule evaluation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Does this rule match this message?
 * @returns {Promise<{matched:boolean, matchedConditions:number[], aiUsed:boolean, aiHost:string|null}>}
 * @throws  AiUnavailableError | NotLocalHostError — never swallowed into "no match".
 */
async function evaluateRule(db, rule, msg) {
  const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
  const ctx = { aiUsed: false, aiHost: null };
  const matchedConditions = [];

  // A rule with no conditions matches nothing. The alternative — matching
  // everything — would forward the whole mailbox the moment someone saved a
  // half-finished rule.
  if (!conds.length) return { matched: false, matchedConditions, aiUsed: false, aiHost: null };

  const mode = rule.match_mode === 'any' ? 'any' : 'all';
  let anyTrue = false, allTrue = true;

  for (let i = 0; i < conds.length; i++) {
    const c = conds[i];
    let ok;
    if (String(c?.type) === 'ai') {
      ok = await evaluateAi(db, c.value, msg, ctx);   // may throw — deliberate
    } else {
      ok = await evaluateCondition(db, c, msg, ctx);
    }
    if (ok) { anyTrue = true; matchedConditions.push(i); }
    else { allTrue = false; if (mode === 'all') break; } // short-circuit: 'all' is already lost
  }

  return {
    matched: mode === 'any' ? anyTrue : allTrue,
    matchedConditions,
    aiUsed: ctx.aiUsed,
    aiHost: ctx.aiHost,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════════════════

const ACTION_TYPES = {
  forward:         { label: 'Forward to a person',          fields: ['to', 'staff_id'] },
  notify:          { label: 'Notify in Wren',               fields: ['staff_ids', 'role'] },
  tag:             { label: 'Tag the email',                fields: ['tag'] },
  set_topic:       { label: 'File in a topic folder',        fields: ['topic'] },
  gmail_label:     { label: 'Label it in Gmail',            fields: ['label'] },
  mark_read:       { label: 'Mark read in Gmail',           fields: [] },
  archive:         { label: 'Archive in Gmail',             fields: [] },
  file_attachment: { label: 'File attachments in Paperwork', fields: ['category', 'subfolder'] },
};

// b338 (2026-09-17): the topic-folder enum. Kept in sync by hand with
// src/jobs/gmail-inbox-poller.js's TOPIC_VALUES — both are small, human-edited
// lists (the "curriculum" / "cpd" / etc. folders Toby asked for), not worth a
// shared module for six lines.
const TOPIC_VALUES = ['new_enquiry', 'utilities', 'bills', 'ofsted', 'ealing', 'cpd', 'apprenticeships', 'curriculum', 'general'];

const PAPERWORK_BASE = () => process.env.PAPERWORK_BASE
  || path.join(process.env.UPLOADS_DIR || '/app/uploads', 'paperwork');

// Same allowlist as src/routes/paperwork.js — an email attachment is not a
// wider trust boundary than a manager's own upload, so it is not a wider one here.
const FILEABLE_EXT = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp',
  '.heic', '.heif', '.docx', '.txt', '.md', '.csv',
]);

/** Resolve a forward destination to a bare address. staff_id wins over `to`. */
async function resolveForwardTarget(db, action) {
  if (action.staff_id) {
    const { rows } = await db.query(
      `SELECT email FROM staff WHERE id=$1 AND is_active=true`, [Number(action.staff_id)]);
    if (rows.length && rows[0].email) return rows[0].email;
    throw new Error(`staff ${action.staff_id} has no active email address`);
  }
  const to = String(action.to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('forward target is not an email address');
  return to;
}

async function doForward(db, action, msg, rule) {
  const to = await resolveForwardTarget(db, action);
  const esc = s => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const bodyText = String(msg.bodyText || msg.snippet || '').slice(0, 20000);
  const html =
      `<p style="color:#7c2d12"><strong>Forwarded by the Wren rule “${esc(rule.name)}”</strong></p>`
    + `<p><strong>From:</strong> ${esc(msg.fromName || '')} &lt;${esc(msg.fromEmail || '')}&gt;<br>`
    + `<strong>Subject:</strong> ${esc(msg.subject || '(no subject)')}<br>`
    + `<strong>Received:</strong> ${esc(msg.receivedAt || '')}</p><hr>`
    + `<div>${esc(bodyText).replace(/\n/g, '<br>')}</div>`
    + `<hr><p style="font-size:12px;color:#94a3b8">Sent by an email routing rule in Wren. `
    + `Turn it off under Roost → Communications → Rules. Reply from your nursery mailbox.</p>`;
  const text = `Forwarded by the Wren rule "${rule.name}"\n\n`
    + `From: ${msg.fromName || ''} <${msg.fromEmail || ''}>\nSubject: ${msg.subject || ''}\n`
    + `Received: ${msg.receivedAt || ''}\n\n${bodyText}`;

  const r = await gmail.sendViaGmail({
    to,
    replyTo: msg.fromEmail || undefined,
    subject: `[Wren · ${rule.name}] ${msg.subject || '(no subject)'}`,
    html, text, fromName: 'Your Nursery Inbox Rules',
  });
  // detail carries NO address — the rule id already identifies the destination.
  return { dry_run: r && r.disabled === true };
}

async function doNotify(db, action, msg, rule) {
  const { notify } = require('./notification-dispatcher');
  let ids = [];
  if (Array.isArray(action.staff_ids) && action.staff_ids.length) {
    ids = action.staff_ids.map(Number).filter(Boolean);
  } else {
    const role = String(action.role || 'manager');
    const { rows } = await db.query(
      `SELECT id FROM staff WHERE is_active=true AND lower(role) = ANY($1)`,
      [role === 'manager'
        ? ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher']
        : [role.toLowerCase()]]);
    ids = rows.map(r => r.id);
  }
  // The notification says WHICH RULE fired and links to the inbox. It does not
  // carry the subject or the sender: a notification can be delivered by push or
  // email, which would take the content back out of the building.
  for (const id of ids) {
    notify('parent_message_received', 'staff', id,
      `📧 Email rule — ${rule.name}`,
      'An email matched this rule. Open the Nursery Inbox to read it.',
      { relatedTable: 'email_rules', relatedId: rule.id, link: '/ey/nursery-inbox.html' });
  }
  return { recipients: ids.length };
}

async function doTag(db, action, msg) {
  const tag = String(action.tag || '').trim().slice(0, 60);
  if (!tag) throw new Error('tag action has no tag');
  if (!msg.messageId) throw new Error('tag action needs a message id');
  const { rowCount } = await db.query(
    `UPDATE comms_email_queue
        SET rule_tags = (SELECT array_agg(DISTINCT t) FROM unnest(rule_tags || $2::text[]) AS t)
      WHERE message_id = $1`,
    [msg.messageId, [tag]]);
  return { tag, rows: rowCount };
}

// b338: set the topic folder (comms_email_queue.topic) by message_id. Same
// shape as doTag, but a single value rather than an appended array — a message
// files in exactly one topic folder, not a set of tags.
async function doSetTopic(db, action, msg) {
  const topic = String(action.topic || '').trim();
  if (!TOPIC_VALUES.includes(topic)) throw new Error(`set_topic action has an unknown topic "${topic}"`);
  if (!msg.messageId) throw new Error('set_topic action needs a message id');
  const { rowCount } = await db.query(
    `UPDATE comms_email_queue SET topic = $2 WHERE message_id = $1`,
    [msg.messageId, topic]);
  return { topic, rows: rowCount };
}

async function doGmailLabel(action, msg) {
  const name = String(action.label || '').trim().slice(0, 120);
  if (!name) throw new Error('gmail_label action has no label');
  const { id, disabled } = await gmail.ensureLabel({ name });
  if (disabled) return { label: name, dry_run: true };
  const r = await gmail.modifyMessage({ messageId: msg.messageId, addLabelIds: [id] });
  return { label: name, dry_run: r.disabled === true };
}

async function doGmailFlag(kind, msg) {
  const remove = kind === 'archive' ? ['INBOX'] : ['UNREAD'];
  const r = await gmail.modifyMessage({ messageId: msg.messageId, removeLabelIds: remove });
  return { removed: remove, dry_run: r.disabled === true };
}

/**
 * File this message's attachments into the paperwork store (b269).
 * Mirrors POST /api/paperwork/upload: content-addressed on disk under
 * <base>/YYYY/MM/<sha>.<ext>, a row in paperwork_documents, an 'extract' job.
 * Deduped on sha256 exactly as a manual upload is.
 */
async function doFileAttachment(db, action, msg, rule) {
  const atts = (msg.attachments || []).filter(a =>
    FILEABLE_EXT.has(path.extname(a.filename || '').toLowerCase()));
  if (!atts.length) return { filed: 0, skipped: (msg.attachments || []).length };

  const category = String(action.category || '').trim() || null;
  if (category) {
    const { rows } = await db.query(
      `SELECT 1 FROM paperwork_categories WHERE key=$1`, [category]);
    if (!rows.length) throw new Error(`unknown paperwork category "${category}"`);
  }
  const subfolder = String(action.subfolder || '').trim().slice(0, 120) || null;

  const filed = [], dupes = [];
  for (const a of atts) {
    const bytes = await gmail.getAttachment({ messageId: msg.messageId, attachmentId: a.attachmentId });
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');

    const { rows: [dupe] } = await db.query(
      `SELECT id FROM paperwork_documents WHERE sha256=$1`, [sha]);
    if (dupe) { dupes.push(dupe.id); continue; }

    const ext = path.extname(a.filename || '').toLowerCase() || '.bin';
    const now = new Date();
    const dir = path.join(PAPERWORK_BASE(), String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, sha + ext);
    fs.writeFileSync(finalPath, bytes);

    const { rows: [doc] } = await db.query(
      `INSERT INTO paperwork_documents
         (sha256, filename, stored_path, mime, size_bytes, uploaded_by, status, category, subfolder, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9) RETURNING id`,
      [sha, String(a.filename || 'attachment').slice(0, 300), finalPath,
       a.mimeType || null, bytes.length, rule.created_by || null, category, subfolder,
       `Filed automatically by the email rule "${rule.name}".`]);
    await db.query(`INSERT INTO paperwork_jobs (document_id, stage) VALUES ($1,'extract')`, [doc.id]);
    try {
      await db.query(
        `INSERT INTO paperwork_audit (document_id, action, staff_id, detail)
         VALUES ($1,'uploaded',$2,$3::jsonb)`,
        [doc.id, rule.created_by || null, JSON.stringify({ source: 'email_rule', rule_id: rule.id })]);
    } catch (_) { /* audit is best-effort; the document is filed either way */ }
    filed.push(doc.id);
  }
  // Document ids and counts only — never a filename, which is often a child's name.
  return { filed: filed.length, document_ids: filed, duplicates: dupes.length };
}

/** Run one rule's actions. Every action is independent: one failing does not stop the rest. */
async function runActions(db, rule, msg, { dryRun = false } = {}) {
  const acts = Array.isArray(rule.actions) ? rule.actions : [];
  const results = [];
  for (const a of acts) {
    const type = String(a?.type || '');
    if (dryRun) { results.push({ type, ok: true, detail: { skipped: 'dry_run' } }); continue; }
    try {
      let detail;
      switch (type) {
        case 'forward':         detail = await doForward(db, a, msg, rule); break;
        case 'notify':          detail = await doNotify(db, a, msg, rule); break;
        case 'tag':             detail = await doTag(db, a, msg); break;
        case 'set_topic':       detail = await doSetTopic(db, a, msg); break;
        case 'gmail_label':     detail = await doGmailLabel(a, msg); break;
        case 'mark_read':       detail = await doGmailFlag('mark_read', msg); break;
        case 'archive':         detail = await doGmailFlag('archive', msg); break;
        case 'file_attachment': detail = await doFileAttachment(db, a, msg, rule); break;
        default: throw new Error(`unknown action type "${type}"`);
      }
      results.push({ type, ok: true, detail: detail || {} });
    } catch (e) {
      results.push({ type, ok: false, error: redact(e.message) });
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// The run
// ═══════════════════════════════════════════════════════════════════════════

async function loadActiveRules(db) {
  const { rows } = await db.query(
    `SELECT id, name, enabled, priority, stop_on_match, match_mode, conditions, actions, created_by
       FROM email_rules
      WHERE deleted = false AND enabled = true
      ORDER BY priority ASC, id ASC`);
  return rows;
}

async function recordRun(db, rule, row) {
  try {
    await db.query(
      `INSERT INTO email_rule_runs
         (rule_id, message_id, matched, decision, matched_conditions, actions, ai_used, ai_host, duration_ms, error)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
      [rule.id, row.messageId || null, !!row.matched, row.decision,
       row.matchedConditions || [], JSON.stringify(row.actions || []),
       !!row.aiUsed, row.aiHost || null, row.durationMs || null, row.error || null]);
  } catch (e) { console.error(`[email-rules] run log failed rule=${rule.id}:`, e.message); }

  try {
    if (row.matched) {
      await db.query(
        `UPDATE email_rules
            SET eval_count = eval_count + 1, match_count = match_count + 1,
                evals_since_match = 0, last_evaluated_at = now(), last_matched_at = now(),
                last_action_summary = $2,
                last_error = $3, last_error_at = CASE WHEN $3::text IS NULL THEN last_error_at ELSE now() END
          WHERE id = $1`,
        [rule.id, row.actionSummary || null, row.error || null]);
    } else {
      await db.query(
        `UPDATE email_rules
            SET eval_count = eval_count + 1, evals_since_match = evals_since_match + 1,
                last_evaluated_at = now(),
                last_error = COALESCE($2, last_error),
                last_error_at = CASE WHEN $2::text IS NULL THEN last_error_at ELSE now() END
          WHERE id = $1`,
        [rule.id, row.error || null]);
    }
  } catch (e) { console.error(`[email-rules] counter update failed rule=${rule.id}:`, e.message); }
}

function summariseActions(results) {
  if (!results.length) return 'no actions';
  return results.map(r => `${r.type} ${r.ok ? 'ok' : 'failed'}`).join('; ').slice(0, 300);
}

/**
 * Evaluate every enabled rule against one inbound message, in priority order,
 * and run the actions of those that match.
 *
 * Called from src/jobs/gmail-inbox-poller.js once per NEW message. Best-effort
 * by contract: it never throws into the poll loop.
 *
 * @param {object} opts.dryRun  evaluate and log, take no action (the Test button)
 * @returns {Promise<{evaluated:number, matched:number, results:Array}>}
 */
async function runRulesForMessage(db, msg, opts = {}) {
  const pool = db || getPool();
  const cfg = await settings(pool);
  if (String(cfg.email_rules_enabled).toLowerCase() === 'false') {
    return { evaluated: 0, matched: 0, results: [], skipped: 'disabled' };
  }

  let rules;
  try { rules = await loadActiveRules(pool); }
  catch (e) { console.error('[email-rules] could not load rules:', e.message); return { evaluated: 0, matched: 0, results: [] }; }

  const out = [];
  let matched = 0;
  for (const rule of rules) {
    const started = Date.now();
    let verdict, error = null, decision, actions = [];
    try {
      verdict = await evaluateRule(pool, rule, msg);
      decision = verdict.matched ? 'matched' : 'no_match';
    } catch (e) {
      // AI unreachable / host not local / anything unexpected. Fail CLOSED and
      // VISIBLY: no actions, decision recorded, error on the rule row.
      verdict = { matched: false, matchedConditions: [], aiUsed: true, aiHost: null };
      decision = (e.code === 'ai_unavailable' || e.code === 'not_local_host') ? 'ai_unavailable' : 'error';
      error = redact(e.message);
    }

    if (verdict.matched && !opts.dryRun) {
      actions = await runActions(pool, rule, msg, { dryRun: false });
      matched++;
    } else if (verdict.matched) {
      actions = await runActions(pool, rule, msg, { dryRun: true });
      decision = 'dry_run';
      matched++;
    }

    const row = {
      messageId: msg.messageId, matched: verdict.matched, decision,
      matchedConditions: verdict.matchedConditions, actions,
      aiUsed: verdict.aiUsed, aiHost: verdict.aiHost,
      durationMs: Date.now() - started, error,
      actionSummary: verdict.matched ? summariseActions(actions) : null,
    };
    if (!opts.noRecord) await recordRun(pool, rule, row);
    out.push({ rule_id: rule.id, rule_name: rule.name, ...row });

    // ONLY identifiers and a decision. No subject, no sender, no body — ever.
    console.log(`[email-rules] rule=${rule.id} msg=${msg.messageId || '-'} decision=${decision}`
      + (actions.length ? ` actions=${actions.map(a => a.type + (a.ok ? '' : '!')).join(',')}` : ''));

    if (verdict.matched && rule.stop_on_match) break;
  }
  return { evaluated: rules.length, matched, results: out };
}

/** Housekeeping: drop run rows past the retention window. Cheap, runs after a poll. */
async function pruneRuns(db) {
  const pool = db || getPool();
  const cfg = await settings(pool);
  const days = parseInt(cfg.email_rules_run_retention_days, 10) || 180;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM email_rule_runs WHERE created_at < now() - ($1 || ' days')::interval`, [String(days)]);
    if (rowCount) console.log(`[email-rules] pruned ${rowCount} run rows older than ${days}d`);
  } catch (e) { console.error('[email-rules] prune failed:', e.message); }
}

/** Is the AI criterion path usable right now? Powers the health badge in Roost. */
async function aiHealth(db) {
  const cfg = await settings(db || getPool());
  const configured = cfg.email_rules_ollama_host;
  let host = null, local = false, reachable = false, error = null;
  try { host = assertLocalOllama(configured); local = true; }
  catch (e) { return { host: configured, local: false, reachable: false, model: cfg.email_rules_ollama_model, error: e.message }; }
  try {
    const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    reachable = !!r.ok;
    if (!r.ok) error = `Ollama returned ${r.status}`;
  } catch (e) { error = e.name === 'TimeoutError' ? 'timed out' : e.message; }
  return { host, local, reachable, model: cfg.email_rules_ollama_model, error };
}

module.exports = {
  runRulesForMessage,
  evaluateRule,
  evaluateCondition,
  evaluateAi,
  runActions,
  classifySender,
  loadActiveRules,
  pruneRuns,
  aiHealth,
  settings,
  assertLocalOllama,
  isLocalHostname,
  redact,
  summariseActions,
  CONDITION_TYPES,
  ACTION_TYPES,
  TOPIC_VALUES,
  AiUnavailableError,
  NotLocalHostError,
  _clearSettingsCache,
};
