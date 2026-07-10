// Email gateway — "AI as the firewall to the real internet" (build 82, 2026-07-09).
// Staff on EY tablets have no direct email; they compose here, the AI checks the
// draft, mail goes out via the nursery's own mailbox (Gmail API / DWD), and every
// message is logged in ladn.staff_outbound_email for audit.
//
// Verdicts: 'ok' → sent immediately; 'flagged' → manager review queue;
// 'blocked' → refused (e.g. recipient is a parent — parent comms are in-app only,
// Toby's decision 2026-07-06).
//
// REAL SENDS ARE GATED behind EMAIL_GATEWAY_LIVE === 'on'. Anywhere else
// (dev container, staging) the send is a logged dry-run with message_id
// 'dev-dry-run' so the whole flow can be exercised safely.
'use strict';

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { getPool } = require('../db/pool');

const OLLAMA_HOST = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://ollama:11434';
const GATEWAY_MODEL = process.env.EMAIL_GATEWAY_MODEL || 'qwen3.6:35b-a3b';
const STAFF_MAILBOX = process.env.GATEWAY_MAILBOX || 'staff@example-nursery.co.uk';
const LIVE = () => process.env.EMAIL_GATEWAY_LIVE === 'on';

// ── Auth: any staff may compose; manager-level for review ────────────────────
function authenticate(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-wren-token'] || '';
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    if (!Number.isInteger(req.user.id)) throw new Error('not staff');
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
function managerOnly(req, res, next) {
  const role = String(req.user?.role || '').toLowerCase();
  if (['manager', 'deputy', 'deputy_manager', 'headteacher', 'admin'].includes(role)) return next();
  return res.status(403).json({ error: 'Manager only' });
}
router.use(authenticate);

// ── Deterministic recipient checks ────────────────────────────────────────────
const FREEMAIL = /@(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|aol|protonmail|proton|gmx|mail|yandex)\./i;

async function recipientIsParent(db, email) {
  const e = String(email).toLowerCase().trim();
  const { rows } = await db.query(
    `SELECT 1 FROM children
      WHERE lower(parent_1_email)=$1 OR lower(parent_2_email)=$1 OR lower(primary_contact_email)=$1
     UNION ALL
     SELECT 1 FROM waiting_list WHERE lower(parent_email)=$1
     UNION ALL
     SELECT 1 FROM enquiries WHERE lower(parent_email)=$1
     LIMIT 1`, [e]);
  return rows.length > 0;
}

// ── AI content check (local Ollama — sovereign) ───────────────────────────────
// Returns { verdict: 'ok'|'flagged', notes, suggested_body|null }. Fails SAFE:
// any AI error → 'flagged' so a human always reviews when the firewall is down.
async function aiCheck({ to, subject, body, staffName }) {
  const prompt = `You are the outbound-email firewall for Your Nursery (Ealing). A staff member wants to send an email through the nursery mailbox. Assess it.

RULES:
- Emails must be professional and appropriate for a nursery employee writing to suppliers, trip venues, training providers or other organisations.
- BLOCK-level problems (verdict "flagged" — a manager must review): any child's full name or identifying detail, anything about safeguarding concerns/incidents, medical details about a child, staff grievances, anything rude/unprofessional, requests for personal favours, anything that looks like personal (non-work) use.
- Personal/freemail recipient addresses are suspicious but allowed if the content is clearly work-related (e.g. a sole-trader supplier on gmail) — mention it in notes.
- Minor tone/typo issues → verdict "ok" but include a cleaned-up version.

From: ${staffName} (staff member)
To: ${to}
Subject: ${subject}
Body:
${String(body).slice(0, 4000)}

Return ONLY valid JSON, no markdown:
{"verdict":"ok|flagged","notes":"one or two sentences explaining the verdict","suggested_body":"improved body text, or null if the original is fine"}`;

  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GATEWAY_MODEL, prompt, stream: false, think: false, options: { temperature: 0.1, num_predict: 700 } }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
    const data = await resp.json();
    const raw = (data.response || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON from model');
    const p = JSON.parse(m[0]);
    const verdict = p.verdict === 'ok' ? 'ok' : 'flagged';
    return {
      verdict,
      notes: String(p.notes || '').slice(0, 1000),
      suggested_body: p.suggested_body && p.suggested_body !== body ? String(p.suggested_body).slice(0, 8000) : null,
    };
  } catch (err) {
    console.error('[email-gateway] AI check failed — failing safe to flagged:', err.message);
    return { verdict: 'flagged', notes: `AI check unavailable (${err.message}) — held for manager review.`, suggested_body: null };
  }
}

// ── Gated send ────────────────────────────────────────────────────────────────
async function gatedSend({ to, subject, body, staffName }) {
  const footer = `\n\n—\n${staffName}\nYour Nursery\n[sent via Wren by ${staffName}]`;
  const text = String(body) + footer;
  if (!LIVE()) {
    console.log(`[email-gateway] DRY RUN (EMAIL_GATEWAY_LIVE!=on) — would send to ${to}: "${subject}"`);
    return { messageId: 'dev-dry-run' };
  }
  const gmail = require('../lib/gmail-sender');
  const r = await gmail.sendViaGmail({ to, subject, text, from: STAFF_MAILBOX });
  return { messageId: r.messageId };
}

// ── POST /compose ─────────────────────────────────────────────────────────────
router.post('/compose', async (req, res) => {
  const { to, subject, body, use_suggested } = req.body || {};
  if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject and body are required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to).trim())) return res.status(400).json({ error: 'Invalid recipient address' });
  const db = getPool();
  const staffName = req.user.name || `staff #${req.user.id}`;

  try {
    // Hard rule first: parents are never emailed through the gateway.
    if (await recipientIsParent(db, to)) {
      const { rows } = await db.query(
        `INSERT INTO staff_outbound_email (staff_id, to_email, subject, body_draft, ai_verdict, ai_notes, status)
         VALUES ($1,$2,$3,$4,'blocked','Recipient is a parent — parent communication must use in-app messaging.','rejected')
         RETURNING id`, [req.user.id, String(to).trim(), subject, body]);
      return res.status(422).json({
        id: rows[0].id, verdict: 'blocked',
        reason: 'This address belongs to a parent. Parent communication must go through in-app messaging, not email.',
      });
    }

    const check = await aiCheck({ to, subject, body, staffName });
    if (FREEMAIL.test(to) && check.verdict === 'ok' && !/freemail|personal address|gmail|hotmail/i.test(check.notes)) {
      check.notes = (check.notes ? check.notes + ' ' : '') + 'Note: personal/freemail recipient address.';
    }
    const finalBody = use_suggested && check.suggested_body ? check.suggested_body : body;

    if (check.verdict === 'ok') {
      const sent = await gatedSend({ to: String(to).trim(), subject, body: finalBody, staffName });
      const { rows } = await db.query(
        `INSERT INTO staff_outbound_email (staff_id, to_email, subject, body_draft, body_final, ai_verdict, ai_notes, status, sent_at, message_id)
         VALUES ($1,$2,$3,$4,$5,'ok',$6,'sent',now(),$7) RETURNING id`,
        [req.user.id, String(to).trim(), subject, body, finalBody, check.notes, sent.messageId]);
      return res.json({ id: rows[0].id, verdict: 'ok', status: 'sent', notes: check.notes, suggested_body: check.suggested_body, dry_run: sent.messageId === 'dev-dry-run' });
    }

    // flagged → review queue
    const { rows } = await db.query(
      `INSERT INTO staff_outbound_email (staff_id, to_email, subject, body_draft, body_final, ai_verdict, ai_notes, status)
       VALUES ($1,$2,$3,$4,$5,'flagged',$6,'pending_review') RETURNING id`,
      [req.user.id, String(to).trim(), subject, body, finalBody, check.notes]);
    return res.status(202).json({ id: rows[0].id, verdict: 'flagged', status: 'pending_review', notes: check.notes, suggested_body: check.suggested_body });
  } catch (err) {
    console.error('[email-gateway] compose error:', err.message);
    res.status(500).json({ error: 'Could not process email' });
  }
});

// ── GET /mine — the staff member's own history (+ best-effort reply matching) ─
router.get('/mine', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, to_email, subject, ai_verdict, ai_notes, status, sent_at, created_at
       FROM staff_outbound_email WHERE staff_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
    // Best-effort inbound reply matching: same correspondent + "Re:" + our subject.
    // Honest limitation: matching is by subject/sender only, not threading headers.
    for (const r of rows.filter(r => r.status === 'sent')) {
      try {
        const { rows: replies } = await db.query(
          `SELECT received_at::date AS received, left(coalesce(nullif(summary,''), body_preview,''),200) AS gist
           FROM email_triage
           WHERE lower(from_email)=lower($1) AND subject ILIKE '%' || $2 || '%'
             AND received_at > $3 ORDER BY received_at DESC LIMIT 1`,
          [r.to_email, r.subject.slice(0, 60), r.sent_at || r.created_at]);
        if (replies.length) r.reply = replies[0];
      } catch { /* reply matching is best-effort */ }
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Manager review queue ──────────────────────────────────────────────────────
router.get('/review-queue', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT o.id, o.staff_id, s.first_name || ' ' || s.last_name AS staff_name,
              o.to_email, o.subject, o.body_draft, o.body_final, o.ai_notes, o.created_at
       FROM staff_outbound_email o LEFT JOIN staff s ON s.id = o.staff_id
       WHERE o.status='pending_review' ORDER BY o.created_at ASC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/approve', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT o.*, s.first_name || ' ' || s.last_name AS staff_name
       FROM staff_outbound_email o LEFT JOIN staff s ON s.id = o.staff_id
       WHERE o.id=$1 AND o.status='pending_review'`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found or not pending' });
    const row = rows[0];
    const sent = await gatedSend({
      to: row.to_email, subject: row.subject,
      body: row.body_final || row.body_draft,
      staffName: row.staff_name || `staff #${row.staff_id}`,
    });
    await db.query(
      `UPDATE staff_outbound_email SET status='sent', reviewed_by=$1, sent_at=now(), message_id=$2 WHERE id=$3`,
      [req.user.id, sent.messageId, row.id]);
    res.json({ ok: true, status: 'sent', dry_run: sent.messageId === 'dev-dry-run' });
  } catch (err) {
    console.error('[email-gateway] approve error:', err.message);
    res.status(500).json({ error: 'Send failed' });
  }
});

router.post('/:id/reject', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `UPDATE staff_outbound_email SET status='rejected', reviewed_by=$1,
              ai_notes = coalesce(ai_notes,'') || CASE WHEN $2 <> '' THEN ' | Manager: ' || $2 ELSE '' END
       WHERE id=$3 AND status='pending_review'`,
      [req.user.id, String((req.body || {}).reason || '').slice(0, 500), req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found or not pending' });
    res.json({ ok: true, status: 'rejected' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
