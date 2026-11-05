// Gmail inbox poller — pulls recent inbox mail for the comms mailbox(es) via the
// Google service account (DWD, gmail.readonly) and upserts it into
// comms_email_queue so the comms hub + daily briefing surface real inbound
// email. Classifies each message via the local Ollama (sovereign — no cloud AI).
// Idempotent on message_id. Drafting a reply is a separate step (b364Step below,
// via inbox-hermes.js's Hermes card) — classifyAndDraft() despite its name only
// classifies as of b486b (2026-10-12, D5); see that function's own comment.
// b338 (2026-09-17): loops over POLL_MAILBOXES (still just staff@ by default —
// see the constant below) and stamps each row with the `mailbox` it came from.
//
// REPLACES dependence on the flaky n8n "Wren — Email Triage" workflow for
// populating the comms queue. It does NOT touch n8n or the email_triage table.
//
// If gmail.readonly returns 403/unauthorized_client the DWD scope has not yet
// propagated — this logs "waiting on gmail.readonly DWD scope" and returns
// cleanly WITHOUT writing any fake rows. Runs on an interval from
// server-unified.js. Append-only / additive.
'use strict';

const { getPool } = require('../db/pool');
const gmail = require('../lib/gmail-sender');
// b147 (2026-07-22): host resolved per-call — this poller runs unattended on an interval
// (not a human waiting on a reply), so it's a fit for the 3090 batch box, Ascent on fallback.
const { pickBatchOllama } = require('../lib/ollama-pick');
const ai = require('../lib/ai-models');
// b279 (2026-09-04): manager-configurable email routing rules. They evaluate on
// this poll rather than in a poller of their own.
const emailRules = require('../services/email-rules');
// b322 (2026-09-11): Ealing Council's training emails, read into a CPD
// catalogue staff can request from. Same pipeline, same connection.
const ealingCpd = require('../lib/ealing-cpd-store');
// b364 (2026-09-29): the section (Parents / Ealing / Apprenticeships / …), the
// Hermes card (context, draft, options, reasoning) and the urgent-section alert.
// Hooked onto THIS pipeline for the same reason the b279 rules and the b322 CPD
// ingest are: it is the only Gmail connection in the product, and a second poller
// would be a second thing to break.
const inboxSections = require('../lib/inbox-sections');
const inboxHermes   = require('../lib/inbox-hermes');
const inboxAlerts   = require('../lib/inbox-alerts');
// b486c (2026-10-13): the background half of the EY list's useModel:false split
// (see comms.js's GET /emails and CHECK.md defect 6) — classifies whatever the
// in-request rules/known-sender/topic pass couldn't, off the request path.
const inboxClassifyJob = require('./inbox-classify-job');
// b424 (2026-10-08): admissions pipeline auto-actions from a known family's email.
const { advanceEnquiry, RANK } = require('../lib/enquiry-stage');

const POLL_MS     = parseInt(process.env.COMMS_POLL_MS || String(8 * 60 * 1000), 10); // 8 min
const MAX_FETCH    = parseInt(process.env.COMMS_POLL_MAX || '50', 10); // 2026-10-09: was 20 — a burst between polls could slip past

// b338 (2026-09-17): which mailboxes this poller ingests. Comma-separated env,
// defaulting to ONLY the mailbox already live (INBOX_MAILBOX = staff@) so
// behaviour is unchanged until Toby explicitly sets POLL_MAILBOXES — widening
// to a second mailbox (e.g. admin@/toby@, confidential) also needs that
// mailbox added to READABLE_MAILBOXES in gmail-sender.js's env, or listInbox()
// throws for it. This is a deliberate two-key switch, not a default-on change.
const POLL_MAILBOXES = (process.env.POLL_MAILBOXES || gmail.INBOX_MAILBOX)
  .split(',').map(s => s.trim()).filter(Boolean);

// b338: topic folders. Rules (email-rules.js `set_topic` action) win — they run
// AFTER the insert below and overwrite this column by message_id, same pattern
// as the existing `tag` action. The model's guess is written first so a message
// always gets some topic even when no rule matches it.
const TOPIC_VALUES = ['new_enquiry', 'utilities', 'bills', 'ofsted', 'ealing', 'cpd', 'apprenticeships', 'curriculum', 'general'];

// Senders we never need to draft a reply to (own mailbox, no-reply addresses).
function isNoReplySender(email) {
  if (!email) return true;
  const e = email.toLowerCase();
  return /no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|notifications?@/.test(e)
      || e === (gmail.INBOX_MAILBOX || gmail.COMMS_MAILBOX || '').toLowerCase();
}

// ── Local-Ollama classification ────────────────────────────────────────────────
// Despite the name (kept as-is — one call site below, exported, low value in
// renaming), this only classifies as of b486b (2026-10-12, D5) — see the file
// header comment.
async function classifyAndDraft(msg) {
  const body = (msg.bodyText || msg.snippet || '').replace(/\s+/g, ' ').slice(0, 1200);
  // b486b (2026-10-12, D5): this prompt used to also ask for three reply drafts
  // ("replies") — dropped. That output fed the legacy insert-time drafting path
  // removed from upsertMessage() above; asking the model to write them was pure
  // waste once nothing reads them, and this call already competes with the
  // Hermes card's own model call for the same Ascent/3090 capacity (the thing
  // D1/D2 in this review are about). Classification only now.
  const prompt = `You are the inbox assistant for Nursery Manager, manager of Your Nursery, a small nursery in Ealing, West London. An email has arrived. Classify it.

From: ${msg.fromName || ''} <${msg.fromEmail || ''}>
Subject: ${msg.subject || '(no subject)'}
Body: ${body}

Return ONLY valid JSON in exactly this shape (no prose, no markdown):
{"category":"parent|enquiry|supplier|council|staff|newsletter|spam|personal|transactional|other","topic":"new_enquiry|utilities|bills|ofsted|ealing|cpd|apprenticeships|curriculum|general","importance":3,"needs_reply":true,"summary":"one sentence","suggested_action":"reply-now|reply-soon|fyi|archive|unsubscribe|spam-report"}

Rules: importance 1=spam/auto … 5=urgent/safety. topic is your best guess at which folder this belongs in — pick "general" if nothing else fits; a routing rule may override it.`;

  // b333 (2026-09-15): both the 3090 and Ascent now carry the same model (ai-models.js
  // role 'batch'), so no explicit model names are needed here — pickBatchOllama()
  // resolves both sides itself. (Was batchModel 'qwen3.5:4b' / fallbackModel
  // OLLAMA_MODEL — OLLAMA_MODEL was never declared in this file, a latent bug.)
  const pick = await pickBatchOllama();
  const resp = await fetch(`${pick.host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // num_predict cut from 900 (b486b, D5): that budget was sized for three full
    // reply drafts, no longer asked for — classification + a one-sentence summary
    // needs far less, and a smaller budget is also less Ascent/3090 time per email.
    body: JSON.stringify({ model: pick.model, prompt, stream: false, think: false, options: ai.options({ temperature: 0.3, num_predict: 300 }),
      ...(pick.keepAlive ? { keep_alive: pick.keepAlive } : {}) }),
    // bumped from 45s: the 3090 disk-cold-loads a 4b model in ~50s — 90s gives margin either host.
    // 2026-10-20: measured 285s cold load on the 3090, so every classify timed out (344/383 emails had no
    // category). Match the drafting path's 300s; once warm it's ~2s.
    signal: AbortSignal.timeout(300000),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status} (${pick.source} @ ${pick.host})`);
  const data = await resp.json();
  const raw = (data.response || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('no JSON in Ollama response');
  const p = JSON.parse(jsonMatch[0]);

  return {
    category: String(p.category || 'other').slice(0, 40),
    topic: TOPIC_VALUES.includes(p.topic) ? p.topic : 'general',
    importance: Math.min(5, Math.max(1, parseInt(p.importance, 10) || 2)),
    needs_reply: p.needs_reply !== false,
    summary: String(p.summary || '').slice(0, 500),
    suggested_action: String(p.suggested_action || 'fyi').slice(0, 40),
  };
}

// Upsert one inbound message. Returns true if a new row was inserted.
//
// b486b (2026-10-12, D5): classifyAndDraft()'s own "replies" field used to be
// written straight into suggested_draft/suggested_replies here, at INSERT time —
// a SECOND drafting path alongside the Hermes card (b364Step -> attemptDraft(),
// called right after this insert), which ignores inbox_hermes_autocards /
// inbox_hermes_summary_only entirely, so "Summaries only"/"Off" didn't stop it.
// ONE drafting path now: the Hermes card. classifyAndDraft() still classifies
// (category/topic/importance/summary/needs_reply/suggested_action, all still
// used — by routing rules, alerts, the briefing, etc.) but its replies are
// discarded rather than raced against attemptDraft()'s own fill rule.
async function upsertMessage(db, msg, ai, mailbox) {
  const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;
  const { rows } = await db.query(
    `INSERT INTO comms_email_queue
       (message_id, thread_id, direction, from_email, from_name, subject, snippet,
        body_text, body_html, received_at, status, classification, category, topic,
        importance, summary, suggested_action, suggested_draft, suggested_replies,
        mailbox, action_state, has_attachments)
     VALUES ($1,$2,'in',$3,$4,$5,$6,$7,$8,$9,'pending','inbound',$10,$11,$12,$13,$14,$15,$16::jsonb,$17,'needs_reply',$18)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING id`,
    [
      msg.messageId, msg.threadId, msg.fromEmail, msg.fromName, msg.subject, msg.snippet,
      msg.bodyText || null, msg.bodyHtml || null, msg.receivedAt || new Date().toISOString(),
      ai ? ai.category : null, ai ? ai.topic : null, ai ? ai.importance : null, ai ? ai.summary : null,
      ai ? ai.suggested_action : null, null, null, mailbox, hasAttachments,
    ]
  );
  return rows.length > 0;
}

// ── b364: section, card, alert ────────────────────────────────────────────────
/**
 * The b364 step. Runs AFTER the insert and after the b279 rules, on purpose:
 * step 3 of the section classifier reads the `topic` a routing rule may just have
 * set, so running earlier would make a manager's own rule invisible to it.
 *
 * Four things, each independently wrapped, in the order that matters most first:
 *
 *  1. record who it was ADDRESSED to. gmail-sender's parseMessage() has always
 *     read the To / Delivered-To / Cc headers and this pipeline threw them away.
 *     They are a separate UPDATE rather than two more columns on upsertMessage's
 *     INSERT so that statement stays byte-for-byte what it was.
 *  2. the section. Sender rules, then the contact lookup, then the rule's topic,
 *     then the small local model — all four of which except the last are SQL, so
 *     an unreachable Ascent still files the mail.
 *  3. the Hermes card. Skippable with settings inbox_hermes_autocards=false, and
 *     built on demand by the route anyway when a person opens an email that has
 *     none — so turning it off costs a wait, not a feature.
 *  4. the alert, for a section marked urgent.
 *
 * Never throws: the caller's loop must not lose an email because a model was
 * busy. Returns a small verdict for the log line, with no email content in it.
 */
async function b364Step(db, msg, aiVerdict) {
  const out = { section: null, source: null, card: null, alert: null };

  try {
    const addressedTo = String(msg.deliveredTo || msg.xOriginalTo || msg.to || '')
      .trim().slice(0, 300) || null;
    const ccTo = String(msg.cc || '').trim().slice(0, 500) || null;
    if (addressedTo || ccTo) {
      await db.query(
        `UPDATE comms_email_queue SET addressed_to = COALESCE($2, addressed_to),
                                      cc_to = COALESCE($3, cc_to)
           WHERE message_id = $1`, [msg.messageId, addressedTo, ccTo]);
    }
  } catch (e) { console.error('[gmail-poller] b364 addressed_to failed:', e.message); }

  let row = null;
  try {
    const { rows } = await db.query(
      `SELECT * FROM comms_email_queue WHERE message_id = $1`, [msg.messageId]);
    row = rows[0] || null;
  } catch (e) { console.error('[gmail-poller] b364 row read failed:', e.message); }
  if (!row) return out;

  try {
    const v = await inboxSections.classifyRow(db, row, { useModel: true });
    out.section = v.section; out.source = v.source;
    row.section = v.section; row.section_source = v.source; row.section_confidence = v.confidence;
  } catch (e) { console.error('[gmail-poller] b364 classify failed:', e.message); }

  try {
    // b486 (2026-10-12): drafting optional. 'full' | 'summary_only' | 'off' —
    // combines inbox_hermes_autocards (this flag, unchanged) with the new
    // inbox_hermes_summary_only key. attemptDraft() also backfills
    // comms_email_queue.summary/suggested_draft (the b364-verify fill rule) and
    // tracks draft_status/draft_attempts for the automatic retry sweep below.
    const mode = await inboxHermes.draftMode(db);
    // No card for our own mail or a no-reply robot: there is nothing to suggest a
    // reply to, and it is minutes of Ascent time per poll for nobody's benefit.
    if (mode !== 'off' && !isNoReplySender(msg.fromEmail)) {
      const r = await inboxHermes.attemptDraft(db, row, { staffId: null, summaryOnly: mode === 'summary_only' });
      out.card = r.ok ? (r.draftFilled || r.draftKeptExisting || mode === 'summary_only' ? 'drafted' : 'facts-only') : 'unavailable';
    } else {
      out.card = mode === 'off' ? 'off' : 'skipped-noreply';
    }
  } catch (e) {
    out.card = 'failed';
    console.error('[gmail-poller] b364 card failed:', e.message);
  }

  try {
    out.alert = await inboxAlerts.alertFor(db, row, null);
  } catch (e) { console.error('[gmail-poller] b364 alert failed:', e.message); }

  return out;
}

// ── b424: admissions pipeline suggestions from a known family's email ────────
// Deterministic phrase matching, not a second LLM call — the model's JSON contract
// (classifyAndDraft's prompt shape) is used elsewhere and this does not need to
// risk it. Three signals, forward-funnel only (RANK), matched against a family
// already on the pipeline (by email, case-insensitive). Never moves a card
// backwards and never auto-emails; auto-APPLYING the stage move itself is gated
// on settings.admissions_auto_apply_email_moves (default off — see Settings →
// Admissions), same pattern as inbox_hermes_autocards above.
const PIPELINE_SIGNALS = [
  { to: 'tour_booked', reason: 'viewing booked/confirmed',
    re: /\b(viewing|visit|tour)\b[^.]{0,40}\b(booked|confirmed|arranged|scheduled|all set|see you (on|at))\b/i },
  { to: 'tour_done', reason: 'viewing done (thank-you note)',
    re: /\b(thank you (so much |very much )?for (the|your|having (us|me) (for|to) the)|lovely to (meet|see) you|enjoyed (the|our|meeting))\b[^.]{0,40}\b(visit|viewing|tour|today|this morning|this afternoon)\b/i },
  { to: 'on_waiting_list', reason: 'wants a place / asked to join the waiting list',
    re: /\b(we'?d like|please (add|put)|we want|keen to (take|accept))\b[^.]{0,40}\b(a place|the place|waiting list|wait list|go ahead)\b/i },
];

// b429 — a reply's quoted original message can carry the same phrases the
// family wrote earlier for a completely different reason (e.g. our own "is
// the viewing confirmed for Tuesday?" quoted back at us). Strip it out before
// matching: classic ">"-prefixed lines, and everything from an "On ... wrote:"
// header or a stray "gmail_quote" marker (left over if a text/plain part ever
// carries the web client's class name) onward, since that is where the
// quoted original begins.
function stripQuotedReply(text) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^>/.test(t)) continue;
    if (/^on\b.{0,120}\bwrote:\s*$/i.test(t)) break;
    if (/gmail_quote/i.test(t)) break;
    out.push(line);
  }
  return out.join('\n');
}

// b428 added "drop any sentence ending in '?'" — but an informally-typed
// question ("can we still get a place") never gets a question mark at all.
// Also drop a sentence that OPENS with a question auxiliary — the structure
// that makes it a question in English, "?" or not.
const QUESTION_START = /^(can|could|is|are|do|does|did|will|would|should|have|has|may|might|shall)\b/i;
function isQuestionSentence(s) {
  const t = s.trim();
  if (!t) return false;
  return t.endsWith('?') || QUESTION_START.test(t);
}

// b429 — pulled out of b424Step so it can be tested directly against fixture
// strings with no DB/Gmail connection (see scripts/b429-test-pipeline-signals.js).
function scanForSignal(rawText, curStage) {
  const curRank = RANK[curStage] ?? -1;
  const noQuote = stripQuotedReply(rawText).slice(0, 4000);
  const scanText = noQuote.split(/(?<=[.!?])\s+/).filter(s => !isQuestionSentence(s)).join(' ');
  return PIPELINE_SIGNALS.find(s => RANK[s.to] > curRank && s.re.test(scanText)) || null;
}

async function b424Step(db, msg) {
  const email = (msg.fromEmail || '').trim().toLowerCase();
  if (!email) return null;
  const { rows } = await db.query(`
    SELECT e.id, e.stage FROM enquiries e WHERE lower(e.parent_email) = $1
       AND e.stage NOT IN ('lost','declined','registered')
    UNION
    SELECT w.enquiry_id AS id, e.stage FROM waiting_list w JOIN enquiries e ON e.id = w.enquiry_id
     WHERE lower(w.parent_email) = $1 AND w.enquiry_id IS NOT NULL
       AND e.stage NOT IN ('lost','declined','registered')
    LIMIT 1`, [email]);
  if (!rows.length) return null; // not a known family on the open pipeline — nothing to suggest
  const { id: enquiryId, stage: curStage } = rows[0];

  const text = `${msg.subject || ''} ${(msg.bodyText || msg.snippet || '')}`;
  const hit = scanForSignal(text, curStage);
  if (!hit) return null;

  const { rows: cfgRows } = await db.query(`SELECT value FROM settings WHERE key='admissions_auto_apply_email_moves'`);
  // b428 — "wants a place" never auto-applies even with the setting on: accepting
  // it has to create the real waiting_list row (src/routes/enquiries.js's
  // convert-to-waiting-list action), not just flip enquiries.stage, and that is
  // exactly the kind of step this build keeps as a person's decision.
  const autoApply = hit.to !== 'on_waiting_list'
    && cfgRows.length > 0 && String(cfgRows[0].value).toLowerCase() === 'true';

  if (autoApply) {
    await advanceEnquiry(db, enquiryId, hit.to, { reason: `auto-applied from email: ${hit.reason}` });
    await db.query(`
      INSERT INTO pipeline_suggested_moves (enquiry_id, to_stage, reason, source_email_message_id, source_email_subject, status, decided_at)
      VALUES ($1,$2,$3,$4,$5,'auto_applied',now())
      ON CONFLICT (enquiry_id, to_stage) WHERE status='pending' DO NOTHING`,
      [enquiryId, hit.to, hit.reason, msg.messageId, (msg.subject || '').slice(0, 300)]);
    return { enquiryId, to: hit.to, applied: true };
  }
  await db.query(`
    INSERT INTO pipeline_suggested_moves (enquiry_id, to_stage, reason, source_email_message_id, source_email_subject)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (enquiry_id, to_stage) WHERE status='pending' DO NOTHING`,
    [enquiryId, hit.to, hit.reason, msg.messageId, (msg.subject || '').slice(0, 300)]);
  return { enquiryId, to: hit.to, applied: false };
}

// ── b127: link inbound replies back to the gateway sender as a Wren message ──
// If this inbound message's Gmail threadId matches a 'sent' staff_outbound_email
// row, surface it as a message in a staff_group thread for that staff member
// (lazily created on first reply) instead of leaving it stranded in Gmail.
// Honest limitation: this makes the reply READABLE in Wren; a staff reply typed
// into that Wren thread does not itself go back out over email — it stays an
// internal note. Full bidirectional threading would need the messages.js reply
// path to detect a gateway-linked thread and re-send via gmail-sender.
async function _linkGatewayReply(db, msg) {
  if (!msg.threadId) return;
  const { rows } = await db.query(
    `SELECT id, staff_id, subject, wren_thread_id FROM staff_outbound_email
     WHERE gmail_thread_id=$1 AND status='sent' ORDER BY sent_at DESC LIMIT 1`,
    [msg.threadId]);
  if (!rows.length) return;
  const gw = rows[0];

  let threadId = gw.wren_thread_id;
  if (!threadId) {
    const { rows: tRows } = await db.query(
      `INSERT INTO message_threads (subject, recipient_type, recipient_staff_id, last_message_at)
       VALUES ($1, 'staff_group', $2, NOW()) RETURNING id`,
      [`Re: ${gw.subject}`.slice(0, 250), gw.staff_id]);
    threadId = tRows[0].id;
    await db.query(`UPDATE staff_outbound_email SET wren_thread_id=$1 WHERE id=$2`, [threadId, gw.id]);
  } else {
    await db.query(`UPDATE message_threads SET last_message_at=NOW() WHERE id=$1`, [threadId]);
  }

  const body = `↩️ Reply from ${msg.fromName || msg.fromEmail} <${msg.fromEmail}>:\n\n${msg.bodyText || msg.snippet || ''}`.slice(0, 8000);
  await db.query(
    `INSERT INTO messages (thread_id, sender_type, sender_id, body) VALUES ($1,'external',NULL,$2)`,
    [threadId, body]);

  try {
    const { notify } = require('../services/notification-dispatcher');
    notify('email_gateway_reply', 'staff', gw.staff_id,
      `Reply from ${msg.fromEmail}`,
      (msg.snippet || '').slice(0, 300),
      {
        relatedTable: 'message_threads', relatedId: threadId,
        link: `https://ey.example-nursery.co.uk/ey/inbox.html?staffThread=${threadId}`,
      });
  } catch (e) { console.error('[gmail-poller] notify failed:', e.message); }

  console.log(`[gmail-poller] linked reply (gmail thread ${msg.threadId}) → wren message_thread ${threadId} for staff ${gw.staff_id}`);
}

// ── LEGACY auto-forward — OFF as of b279 (2026-09-04) ─────────────────────────
// This was built on 2026-08-04 for one situation: Toby away, wanting Cyclescheme
// and Ofsted mail chased to his personal inbox. It then kept running, because it
// was on by default and the only switch was an env var nobody could see.
//
// Toby, 2026-09-04: "For things like forwarding emails to me whilst I was away,
// you can turn off. Add it as a feature, not just for away mode, but as a
// workflow." So: this path is now OPT-IN (INBOX_FORWARD=on), which means it is
// OFF everywhere, because nothing sets that variable. Its behaviour is seeded as
// two DISABLED rules in migrations/2026-09-04-b279-email-rules.sql, so the old
// keyword list is visible and one toggle away rather than deleted.
//
// The code is kept, not removed, so the seeded rules can be checked against what
// actually used to run. Nothing calls it while INBOX_FORWARD is unset.
const FORWARD_ON       = String(process.env.INBOX_FORWARD || '').toLowerCase() === 'on';
const FORWARD_TO       = process.env.INBOX_FORWARD_TO || 'admin@example.com';
const FORWARD_KEYWORDS = (process.env.INBOX_FORWARD_KEYWORDS || 'cyclescheme,cycle scheme,cycle to work,cycle-to-work')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const BANK_RE   = /\b(bank|barclays|natwest|hsbc|lloyds|santander|metro ?bank|starling|monzo|tide|revolut|co-?op(erative)? bank)\b/i;
const URGENT_RE = /\b(urgent|immediate(ly)?|action required|time[- ]sensitive|fraud|suspicious|unauthori[sz]ed|overdraw|payment failed|final (notice|demand))\b/i;

function forwardReason(msg, ai) {
  const from = (msg.fromEmail || '').toLowerCase();
  const hay = `${msg.subject || ''} ${msg.bodyText || msg.snippet || ''}`.toLowerCase();
  const kw = FORWARD_KEYWORDS.find(k => hay.includes(k));
  if (kw) return `keyword “${kw}”`;
  if (/@ofsted\.gov\.uk$/i.test(from) || /\bofsted\b/i.test(hay)) return 'Ofsted';
  if (BANK_RE.test(hay) && URGENT_RE.test(hay)) return 'urgent bank';
  if (ai && Number(ai.importance) >= 5) return `flagged urgent (importance ${ai.importance})`;
  return null;
}

async function maybeForward(db, msg, ai) {
  if (!FORWARD_ON) return;
  const reason = forwardReason(msg, ai);
  if (!reason) return;
  try {
    // Only if not already forwarded (dedup).
    const { rows } = await db.query(
      'SELECT forwarded_at FROM comms_email_queue WHERE message_id=$1', [msg.messageId]);
    if (rows.length && rows[0].forwarded_at) return;
    const safe = s => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const bodyText = (msg.bodyText || msg.snippet || '').slice(0, 5000);
    const html = `<p style="color:#7c2d12"><strong>⚠️ Wren flagged this inbox email — ${safe(reason)}</strong></p>`
      + `<p><strong>From:</strong> ${safe(msg.fromName || '')} &lt;${safe(msg.fromEmail || '')}&gt;<br>`
      + `<strong>Subject:</strong> ${safe(msg.subject || '(no subject)')}<br>`
      + `<strong>Received:</strong> ${safe(msg.receivedAt || '')}</p><hr>`
      + `<div>${safe(bodyText).replace(/\n/g, '<br>')}</div>`
      + `<hr><p style="font-size:12px;color:#94a3b8">Forwarded automatically from the Your Nursery shared inbox because it matched a watch rule (${safe(reason)}). Reply from your normal nursery mailbox.</p>`;
    const text = `Wren flagged this inbox email — ${reason}\n\nFrom: ${msg.fromName || ''} <${msg.fromEmail || ''}>\nSubject: ${msg.subject || ''}\nReceived: ${msg.receivedAt || ''}\n\n${bodyText}`;
    await gmail.sendViaGmail({
      to: FORWARD_TO,
      replyTo: msg.fromEmail || undefined,
      subject: `[LADN ⚠ ${reason}] ${msg.subject || '(no subject)'}`,
      html, text, fromName: 'Your Nursery Inbox Watch',
    });
    await db.query('UPDATE comms_email_queue SET forwarded_at=now(), forward_reason=$2 WHERE message_id=$1',
      [msg.messageId, reason]);
    // b279: was `forwarded to ${FORWARD_TO} (${reason}): ${msg.subject}` — a
    // subject line and a personal address written to build-logs, which is an
    // unwalled sink. Identifiers and the matched reason only.
    console.log(`[gmail-poller] legacy forward sent for msg=${msg.messageId} (${reason})`);
  } catch (e) { console.error('[gmail-poller] forward failed:', e.message); }
}

// Notify inbox-access staff (managers/deputies + anyone with staff.inbox_access) that a
// new email has landed, so cover staff on the floor see it in the EY Nursery Inbox without
// opening Gmail (2026-08-04). Best-effort; never blocks the poll.
//
// b486c (2026-10-13, CHECK.md defect 2): this used to notify EVERY inbox-eligible
// staff member of EVERY new email, in every mailbox, with no section or
// safeguarding filter — the confidential toby@ mailbox's subject plus a
// 140-character snippet reached the other manager, both deputies and every
// inbox_access practitioner on the first poll after POLL_MAILBOXES widened
// (verified on prod: staff 2, 11, 17, 43). Now mirrors the two rules the
// list/action routes in comms.js already enforce: a confidential mailbox
// notifies only its own grantees; a non-confidential mailbox (staff@) notifies
// only people who could open THIS row on their own EY surface — same section +
// safeguarding check (ey-inbox-permissions.js's canSeeEmail), so a practitioner
// with inbox_access never gets a finance/staff/safeguarding subject line.
async function notifyInboxStaff(db, msg, mailbox) {
  if (isNoReplySender(msg.fromEmail)) return; // no ping for our own / no-reply mail
  try {
    const { notify } = require('../services/notification-dispatcher');
    const inboxAccessLib = require('../lib/inbox-access');
    const eyInboxPerms = require('../lib/ey-inbox-permissions');

    const { rows: rowRows } = await db.query(
      `SELECT id, section, section_source FROM comms_email_queue WHERE message_id=$1`, [msg.messageId]);
    const row = rowRows[0] || null;

    let recipients;
    if (await inboxAccessLib.isConfidentialMailbox(db, mailbox)) {
      recipients = await inboxAccessLib.mailboxGranteeIds(db, mailbox);
    } else {
      const { rows: candidates } = await db.query(
        `SELECT id, role FROM staff WHERE is_active=true
           AND (lower(role) IN ('manager','deputy_manager','admin','headteacher','owner','room_leader') OR inbox_access=true)`);
      let card = null;
      if (row) {
        const { rows: cardRows } = await db.query(
          `SELECT case_kind FROM inbox_intel_cards WHERE email_id=$1`, [row.id]);
        card = cardRows[0] || null;
      }
      const emailForFilter = {
        section: row ? row.section : null,
        subject: msg.subject, snippet: msg.snippet, body_text: msg.bodyText,
      };
      // review 2026-10-13: "notify only people who could see that row on their own surface".
      //  - a Roost grantee for this mailbox reads every row of it on Roost (no content filter there);
      //  - everyone else's surface is the EY list, so they need an EY-eligible role (an inbox_access
      //    practitioner is told "ask a manager" there and was still getting subject + snippet here),
      //    a CLASSIFIED row (the EY list hides NULL / section_source='fallback'), and the same
      //    section + safeguarding rule the list and the by-id actions apply.
      const grantees = new Set(await inboxAccessLib.mailboxGranteeIds(db, mailbox));
      recipients = [];
      for (const c of candidates) {
        const fakeUser = { id: c.id, role: c.role };
        if (grantees.has(c.id)) { recipients.push(c.id); continue; }
        if (!inboxAccessLib.isEyInboxEligible(fakeUser)) continue;
        if (!row || !row.section || row.section_source === 'fallback') continue;
        if (await eyInboxPerms.canSeeEmail(db, fakeUser, emailForFilter, card)) recipients.push(c.id);
      }
    }

    const subj = (msg.subject || '(no subject)').slice(0, 80);
    const body = `From ${msg.fromName || msg.fromEmail || 'sender'}: ${(msg.snippet || '').slice(0, 140)}`;
    for (const staffId of recipients) {
      notify('parent_message_received', 'staff', staffId, `📧 New email — ${subj}`, body,
        { relatedTable: 'comms_email_queue', link: '/ey/nursery-inbox.html' });
    }
  } catch (e) { console.error('[gmail-poller] inbox notify failed:', e.message); }
}

// Poll ONE mailbox. Extracted from the original single-mailbox pollInbox() (b338,
// 2026-09-17) so the same per-message pipeline — classify, upsert, gateway-reply
// link, rules, Ealing CPD, legacy forward, notify — runs unchanged for each
// mailbox in POLL_MAILBOXES. Every step here is unchanged in BEHAVIOUR from
// before this build; only the surrounding loop and the `mailbox` stamp are new.
async function pollOneMailbox(mailbox) {
  let messages;
  try {
    messages = await gmail.listInbox({ maxResults: MAX_FETCH, mailbox });
  } catch (e) {
    if (gmail.isAuthScopeError(e)) {
      console.log(`[gmail-poller] waiting on gmail.readonly DWD scope (${mailbox}) — inbox poll skipped (no fake rows written)`);
      return { skipped: 'readonly_dwd_pending' };
    }
    console.error(`[gmail-poller] inbox list failed (${mailbox}):`, e.message);
    return { error: e.message };
  }

  const db = getPool();
  let inserted = 0, seen = 0;
  for (const msg of messages) {
    seen++;
    // Skip if we already have this message (cheap pre-check before any AI work).
    try {
      const { rows } = await db.query('SELECT 1 FROM comms_email_queue WHERE message_id=$1', [msg.messageId]);
      if (rows.length) continue;
    } catch (e) { console.error('[gmail-poller] dedup check failed:', e.message); continue; }

    let ai = null;
    if (!isNoReplySender(msg.fromEmail)) {
      try { ai = await classifyAndDraft(msg); }
      catch (e) { console.error(`[gmail-poller] classify failed for ${msg.messageId}:`, e.message); }
    }

    try {
      const isNew = await upsertMessage(db, msg, ai, mailbox);
      if (isNew) {
        inserted++;
        console.log(`[gmail-poller] queued inbound id=${msg.messageId} mailbox=${mailbox} cat=${ai ? ai.category : 'n/a'} topic=${ai ? ai.topic : 'n/a'} imp=${ai ? ai.importance : '-'}`);
        try { await _linkGatewayReply(db, msg); } catch (e) { console.error('[gmail-poller] gateway reply link failed:', e.message); }
        // b279: the routing rules. Evaluated on THIS pipeline — there is no
        // second poller and no second Gmail connection. Best-effort by contract:
        // runRulesForMessage never throws into the poll loop. Rules that call
        // set_topic (b338) run here, AFTER the insert above, and overwrite the
        // model's topic guess by message_id — so a matching rule always wins.
        try { await emailRules.runRulesForMessage(db, msg); }
        catch (e) { console.error('[gmail-poller] email-rules step failed:', e.message); }
        // b322: Ealing's training emails become the CPD catalogue. Hooked here
        // for the same reason the rules are — this is the only Gmail connection
        // in the product, and a second poller would be a second thing to break.
        // ingestFromEmail never throws and exits in one cheap test for the ~99%
        // of mail that is not from the council.
        try { await ealingCpd.ingestFromEmail(db, msg); }
        catch (e) { console.error('[gmail-poller] ealing-cpd step failed:', e.message); }
        // b364: section → card → alert. Last of the per-message steps because it
        // reads whatever the b279 rules above have just decided, and never throws.
        try {
          const b364 = await b364Step(db, msg, ai);
          console.log(`[gmail-poller] b364 msg=${msg.messageId} section=${b364.section || 'none'}`
            + ` (${b364.source || '-'}) card=${b364.card || '-'}`
            + ` alert=${b364.alert && b364.alert.alerted ? 'sent×' + b364.alert.recipients : (b364.alert && b364.alert.reason) || '-'}`);
        } catch (e) { console.error('[gmail-poller] b364 step failed:', e.message); }
        // b424: admissions pipeline suggestion/auto-move from a known family's email.
        try {
          // review 2026-10-13: b424Step writes the email's SUBJECT into pipeline_suggested_moves (the
          // admissions page) — not for a confidential mailbox (toby@): "visible only to ids 1 and 13".
          const b424 = (await require('../lib/inbox-access').isConfidentialMailbox(db, mailbox)) ? null : await b424Step(db, msg);
          if (b424) console.log(`[gmail-poller] b424 msg=${msg.messageId} enquiry=${b424.enquiryId} → ${b424.to} (${b424.applied ? 'auto-applied' : 'suggested'})`);
        } catch (e) { console.error('[gmail-poller] b424 step failed:', e.message); }
        // Legacy forwarder — inert unless INBOX_FORWARD=on (b279).
        try { await maybeForward(db, msg, ai); } catch (e) { console.error('[gmail-poller] forward step failed:', e.message); }
        try { await notifyInboxStaff(db, msg, mailbox); } catch (e) { console.error('[gmail-poller] inbox notify step failed:', e.message); }
      }
    } catch (e) {
      console.error(`[gmail-poller] upsert failed for ${msg.messageId}:`, e.message);
    }
  }
  if (inserted) { try { await emailRules.pruneRuns(db); } catch (_) {} }
  return { seen, inserted };
}

// b486 (2026-10-12): last-poll info for the Inbox's "Resync" button ("Last synced
// hh:mm · N new") — in-memory, same single-process assumption the interval below
// already makes. Set at the end of every pollInbox() run, automatic or manual.
let _lastPoll = null;
function getLastPollInfo() { return _lastPoll; }

// b486b (2026-10-12, D1): Resync (comms.js POST /inbox/resync) calls pollInbox()
// on demand, same as the 8-minute interval. Without a guard, firing Resync while
// the interval poll is mid-run — or a retry sweep that outlives the 8 minutes —
// started a SECOND full poll, classifying the same brand-new email twice (the
// per-message dedup check in pollOneMailbox only protects the INSERT, not the
// classifyAndDraft() call before it). One in-flight promise: a concurrent caller
// joins the run already happening instead of starting its own.
let _pollInFlight = null;
function pollInbox() {
  if (_pollInFlight) return _pollInFlight;
  _pollInFlight = _pollInboxRun().finally(() => { _pollInFlight = null; });
  return _pollInFlight;
}

async function _pollInboxRun() {
  if (!gmail.isConfigured()) {
    console.log('[gmail-poller] SA key not configured — skipping inbox poll');
    _lastPoll = { at: new Date().toISOString(), skipped: 'no_sa_key' };
    return { skipped: 'no_sa_key' };
  }

  let seen = 0, inserted = 0;
  const byMailbox = {};
  for (const mailbox of POLL_MAILBOXES) {
    const r = await pollOneMailbox(mailbox);
    byMailbox[mailbox] = r;
    seen += r.seen || 0;
    inserted += r.inserted || 0;
  }
  console.log(`[gmail-poller] poll complete — mailboxes=${POLL_MAILBOXES.length} ${seen} fetched, ${inserted} new queued`);
  try { await reconcileRepliedElsewhere(); } catch (e) { console.error('[gmail-poller] reply check:', e.message); }
  // b486 — failed-draft retries ride the same 8-minute cadence as the poll itself
  // rather than a second interval. Best-effort: a retry-sweep failure must not make
  // the poll itself look like it failed.
  let retry = null;
  try { retry = await inboxHermes.retryFailedDrafts(getPool()); }
  catch (e) { console.error('[gmail-poller] draft retry sweep failed:', e.message); }
  if (retry && retry.checked) {
    console.log(`[gmail-poller] draft retry sweep — ${retry.checked} checked, ${retry.succeeded} ok, ${retry.failed_again} failed again, ${retry.gave_up} gave up, ${retry.skipped || 0} already in progress`);
  }
  // b486c (2026-10-13, CHECK.md defect 6): the model-backed classification
  // backlog sweep — same cadence as the retry sweep above, for the same reason
  // (one scheduler, not two). Best-effort: a sweep failure must not make the
  // poll itself look like it failed.
  let classifyBacklog = null;
  try { classifyBacklog = await inboxClassifyJob.sweepOnce(getPool()); }
  catch (e) { console.error('[gmail-poller] section classify sweep failed:', e.message); }
  if (classifyBacklog && classifyBacklog.claimed) {
    console.log(`[gmail-poller] section classify sweep — ${classifyBacklog.claimed} claimed, ${classifyBacklog.classified} classified, ${classifyBacklog.failed} failed`);
  }
  _lastPoll = { at: new Date().toISOString(), seen, inserted, byMailbox, retry, classifyBacklog };
  return { seen, inserted, byMailbox, retry, classifyBacklog };
}

// 2026-10-09 — keep the inbox true to Gmail. An email waiting for a reply is marked done
// when, in Gmail, someone has replied in that thread since it arrived, or the thread has
// been archived (no message left in the Inbox). Labels and dates only (threadReplyState).
// Up to REPLY_CHECK_BATCH threads per poll, oldest-checked first, so a backlog clears in a
// few polls without a burst of API calls.
const REPLY_CHECK_BATCH = parseInt(process.env.REPLY_CHECK_BATCH || '150', 10);
async function reconcileRepliedElsewhere() {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT mailbox, thread_id, max(received_at) AS latest_in, array_agg(id) AS ids
      FROM comms_email_queue
     WHERE action_state = 'needs_reply' AND thread_id IS NOT NULL AND mailbox IS NOT NULL
       AND received_at > now() - interval '60 days' AND sent_at IS NULL
     GROUP BY mailbox, thread_id
     ORDER BY max(received_at) ASC
     LIMIT $1`, [REPLY_CHECK_BATCH]);
  let replied = 0, archived = 0, checked = 0;
  for (const r of rows) {
    let st = null;
    try { st = await gmail.threadReplyState({ mailbox: r.mailbox, threadId: r.thread_id }); } catch (e) { continue; }
    if (!st) continue;
    checked++;
    const repliedSince = st.lastSentAt && st.lastSentAt > new Date(r.latest_in);
    if (repliedSince || !st.inInbox) {
      await db.query(`UPDATE comms_email_queue SET action_state = 'done', handled_at = COALESCE(handled_at, now())
                       WHERE id = ANY($1::int[]) AND action_state = 'needs_reply'`, [r.ids]);
      if (repliedSince) replied++; else archived++;
    }
  }
  if (checked) console.log(`[gmail-poller] reply check — ${checked} threads checked, ${replied} replied in Gmail, ${archived} archived in Gmail`);
  return { checked, replied, archived };
}

function startInboxPoller() {
  // b486b (2026-10-12, D1 restart case): draft_claimed_at (inbox-hermes.js
  // attemptDraft()) only guards against a concurrent call in the SAME process
  // lifetime — the job state it protects is in-memory only. A row still showing
  // claimed at boot was claimed by a process that no longer exists (crash,
  // SIGKILL, deploy restart), so its 15-minute staleness window would otherwise
  // block a manual retry on those rows for up to 15 minutes after they're
  // actually free. Nothing can be "in progress" the instant a process boots, so
  // clear every leftover claim once, here, rather than waiting it out.
  getPool().query(`UPDATE comms_email_queue SET draft_claimed_at = NULL WHERE draft_claimed_at IS NOT NULL`)
    .catch(e => console.error('[gmail-poller] clear stale draft claims:', e.message));
  // b486c: same reasoning, for the section-classification claim.
  inboxClassifyJob.clearStaleClaims(getPool())
    .catch(e => console.error('[gmail-poller] clear stale section claims:', e.message));
  // Initial run delayed slightly so it doesn't compete with boot.
  setTimeout(() => { pollInbox().catch(e => console.error('[gmail-poller] initial run:', e.message)); }, 30 * 1000);
  setInterval(() => { pollInbox().catch(e => console.error('[gmail-poller] interval:', e.message)); }, POLL_MS);
  console.log(`[gmail-poller] inbox poller started (every ${Math.round(POLL_MS / 60000)} min, mailboxes ${POLL_MAILBOXES.join(', ')})`);
}

module.exports = {
  pollInbox, pollOneMailbox, classifyAndDraft, startInboxPoller, _linkGatewayReply,
  forwardReason, maybeForward, upsertMessage, POLL_MAILBOXES, TOPIC_VALUES, reconcileRepliedElsewhere,
  // b486 — "Resync" button status line
  getLastPollInfo,
  // b364 — exported so the verify harness can run the step against a synthetic
  // message without a Gmail connection.
  b364Step,
  // b424 — same reason: testable against a synthetic message with no live Gmail.
  b424Step,
  // b429 — the pure text-matching core of b424Step, plus its helpers, so
  // scripts/b429-test-pipeline-signals.js can check fixture strings with no
  // DB/Gmail connection at all.
  scanForSignal, stripQuotedReply, isQuestionSentence, PIPELINE_SIGNALS,
};
