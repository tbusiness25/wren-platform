// Gmail inbox poller — pulls recent inbox mail for the comms mailbox via the
// Google service account (DWD, gmail.readonly) and upserts it into
// comms_email_queue so the comms hub + daily briefing surface real inbound
// email. Classifies each message and proposes A/B/C reply drafts via the local
// Ollama (sovereign — no cloud AI). Idempotent on message_id.
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

const OLLAMA_HOST  = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:4b';
const POLL_MS      = parseInt(process.env.COMMS_POLL_MS || String(8 * 60 * 1000), 10); // 8 min
const MAX_FETCH    = parseInt(process.env.COMMS_POLL_MAX || '20', 10);

// Senders we never need to draft a reply to (own mailbox, no-reply addresses).
function isNoReplySender(email) {
  if (!email) return true;
  const e = email.toLowerCase();
  return /no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|notifications?@/.test(e)
      || e === (gmail.COMMS_MAILBOX || '').toLowerCase();
}

// ── Local-Ollama classification + A/B/C draft generation ──────────────────────
async function classifyAndDraft(msg) {
  const body = (msg.bodyText || msg.snippet || '').replace(/\s+/g, ' ').slice(0, 1200);
  const prompt = `You are the inbox assistant for Nursery Manager, manager of Your Nursery, a small nursery in Ealing, West London. An email has arrived. Classify it and propose three short reply options the manager could send.

From: ${msg.fromName || ''} <${msg.fromEmail || ''}>
Subject: ${msg.subject || '(no subject)'}
Body: ${body}

Return ONLY valid JSON in exactly this shape (no prose, no markdown):
{"category":"parent|enquiry|supplier|council|staff|newsletter|spam|personal|transactional|other","importance":3,"needs_reply":true,"summary":"one sentence","suggested_action":"reply-now|reply-soon|fyi|archive|unsubscribe|spam-report","replies":[{"label":"Brief & warm","text":"full reply text option A"},{"label":"Detailed","text":"full reply text option B"},{"label":"Holding reply","text":"full reply text option C"}]}

Rules: importance 1=spam/auto … 5=urgent/safety. Each reply is a complete, polite UK-English email body the manager could send as-is, signed "Your Nursery". Keep replies concise. If no reply is needed set needs_reply=false but still provide replies.`;

  const resp = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, think: false, options: { temperature: 0.3, num_predict: 900 } }),
    signal: AbortSignal.timeout(45000),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
  const data = await resp.json();
  const raw = (data.response || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('no JSON in Ollama response');
  const p = JSON.parse(jsonMatch[0]);

  const replies = Array.isArray(p.replies) ? p.replies.slice(0, 3).map(r => ({
    label: String(r.label || '').slice(0, 40),
    text:  String(r.text  || '').slice(0, 4000),
  })).filter(r => r.text) : [];

  return {
    category: String(p.category || 'other').slice(0, 40),
    importance: Math.min(5, Math.max(1, parseInt(p.importance, 10) || 2)),
    needs_reply: p.needs_reply !== false,
    summary: String(p.summary || '').slice(0, 500),
    suggested_action: String(p.suggested_action || 'fyi').slice(0, 40),
    replies,
  };
}

// Upsert one inbound message. Returns true if a new row was inserted.
async function upsertMessage(db, msg, ai) {
  const replyA = ai && ai.replies && ai.replies[0] ? ai.replies[0].text : null;
  const repliesJson = ai && ai.replies && ai.replies.length ? JSON.stringify(ai.replies) : null;
  const { rows } = await db.query(
    `INSERT INTO comms_email_queue
       (message_id, thread_id, direction, from_email, from_name, subject, snippet,
        body_text, body_html, received_at, status, classification, category,
        importance, summary, suggested_action, suggested_draft, suggested_replies)
     VALUES ($1,$2,'in',$3,$4,$5,$6,$7,$8,$9,'pending','inbound',$10,$11,$12,$13,$14,$15::jsonb)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING id`,
    [
      msg.messageId, msg.threadId, msg.fromEmail, msg.fromName, msg.subject, msg.snippet,
      msg.bodyText || null, msg.bodyHtml || null, msg.receivedAt || new Date().toISOString(),
      ai ? ai.category : null, ai ? ai.importance : null, ai ? ai.summary : null,
      ai ? ai.suggested_action : null, replyA, repliesJson,
    ]
  );
  return rows.length > 0;
}

async function pollInbox() {
  if (!gmail.isConfigured()) {
    console.log('[gmail-poller] SA key not configured — skipping inbox poll');
    return { skipped: 'no_sa_key' };
  }

  let messages;
  try {
    messages = await gmail.listInbox({ maxResults: MAX_FETCH });
  } catch (e) {
    if (gmail.isAuthScopeError(e)) {
      console.log('[gmail-poller] waiting on gmail.readonly DWD scope — inbox poll skipped (no fake rows written)');
      return { skipped: 'readonly_dwd_pending' };
    }
    console.error('[gmail-poller] inbox list failed:', e.message);
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
      const isNew = await upsertMessage(db, msg, ai);
      if (isNew) {
        inserted++;
        console.log(`[gmail-poller] queued inbound id=${msg.messageId} cat=${ai ? ai.category : 'n/a'} imp=${ai ? ai.importance : '-'}`);
      }
    } catch (e) {
      console.error(`[gmail-poller] upsert failed for ${msg.messageId}:`, e.message);
    }
  }
  console.log(`[gmail-poller] poll complete — ${seen} fetched, ${inserted} new queued`);
  return { seen, inserted };
}

function startInboxPoller() {
  // Initial run delayed slightly so it doesn't compete with boot.
  setTimeout(() => { pollInbox().catch(e => console.error('[gmail-poller] initial run:', e.message)); }, 30 * 1000);
  setInterval(() => { pollInbox().catch(e => console.error('[gmail-poller] interval:', e.message)); }, POLL_MS);
  console.log(`[gmail-poller] inbox poller started (every ${Math.round(POLL_MS / 60000)} min, mailbox ${gmail.COMMS_MAILBOX})`);
}

module.exports = { pollInbox, classifyAndDraft, startInboxPoller };
