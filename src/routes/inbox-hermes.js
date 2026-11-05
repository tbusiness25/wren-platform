'use strict';
/**
 * inbox-hermes.js — b364 (2026-09-29)  ·  /api/inbox-hermes
 *
 * The inbox, in sections, with the context already worked out.
 *
 *   GET    /sections                    the section switcher: counts per section
 *   GET    /recipients                  the by-recipient view: counts per addressee
 *   GET    /emails                      one section's email, mailbox-scoped
 *   GET    /emails/:id                  one email + its card (built on demand)
 *   POST   /emails/:id/card             rebuild the card
 *   PUT    /emails/:id/section          correct the section (a person's decision)
 *   POST   /emails/:id/task             hand it to someone — a b358 Action Plan task
 *   POST   /emails/:id/sent             log that a reply went out (who, which draft)
 *   GET    /missed                      "what have I missed" since last login
 *   POST   /seen                        stamp this person as having read it
 *   GET    /summary/thread/:threadId    summarise one conversation
 *   GET    /summary/section/:section    summarise a section's week
 *   GET    /rules  POST /rules  PATCH /rules/:id     the sender→section rules
 *   GET    /urgent-sections  PUT /urgent-sections    which sections alert
 *   POST   /classify-backlog            classify rows that predate b364
 *   GET    /model                       which local model, and proof it is local
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * src/lib/inbox-access.js: Roost portal AND on settings.comms_manager_staff_ids
 * AND holding at least one comms_mailbox_access grant. That is Toby, the office manager and
 * the admissions lead (once her staff row and grant exist), plus anyone Toby adds — a PERSON
 * list, deliberately not a role check, because "manager" includes the deputies
 * and the brief says not deputies by default.
 *
 * Every read is filtered by req._mailboxes. An email in a mailbox you were not
 * granted does not appear in a list, a count, a summary or the missed panel, and
 * fetching it by id is a 403.
 *
 * ── THIS ROUTER CANNOT SEND AN EMAIL ────────────────────────────────────────
 * There is no mail transport required anywhere in this file. Sending a reply is
 * the existing POST /api/comms/emails/:id/send-draft, which a person triggers by
 * pressing send; POST /emails/:id/sent below only writes the audit row.
 */

const express = require('express');
const router = express.Router();

const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const access = require('../lib/inbox-access');
const sectionsLib = require('../lib/inbox-sections');
const hermes = require('../lib/inbox-hermes');
const sovereign = require('../lib/sovereign-model');
const apTasks = require('../lib/action-plan-tasks');

router.use(authenticate);
router.use(access.guard());

const fail = (res, e, code = 500) => {
  console.error('[inbox-hermes]', e.message);
  res.status(code).json({ error: 'inbox_hermes_failed', message: e.message });
};

/** One email, or null, after the mailbox check. */
async function loadEmail(db, id, mailboxes) {
  const { rows } = await db.query(
    `SELECT * FROM comms_email_queue WHERE id = $1`, [parseInt(id, 10)]);
  if (!rows.length) return { notFound: true };
  if (!mailboxes.includes(rows[0].mailbox)) return { forbidden: true };
  return { email: rows[0] };
}

// ── the section switcher ────────────────────────────────────────────────────
router.get('/sections', async (req, res) => {
  try {
    const db = getPool();
    const list = await sectionsLib.sectionList(db);
    const urgent = await sectionsLib.urgentSections(db);
    const { rows: counts } = await db.query(`
      SELECT COALESCE(section, '_unclassified') AS section,
             count(*)::int AS total,
             count(*) FILTER (WHERE action_state = 'needs_reply' AND status = 'pending')::int AS needs_reply,
             count(*) FILTER (WHERE received_at > now() - interval '7 days')::int AS last_7d,
             count(*) FILTER (WHERE section_source = 'model')::int AS model_guessed,
             max(received_at) AS latest_at
        FROM comms_email_queue
       WHERE direction = 'in' AND mailbox = ANY($1)
         AND (snoozed_until IS NULL OR snoozed_until <= now())
       GROUP BY 1`, [req._mailboxes]);
    const byKey = Object.fromEntries(counts.map(c => [c.section, c]));
    res.json({
      mailboxes: req._mailboxes,
      urgent_sections: urgent,
      unclassified: byKey._unclassified || { section: '_unclassified', total: 0, needs_reply: 0, last_7d: 0 },
      sections: list.map(s => Object.assign({}, s, {
        urgent: urgent.includes(s.key),
        total: byKey[s.key]?.total || 0,
        needs_reply: byKey[s.key]?.needs_reply || 0,
        last_7d: byKey[s.key]?.last_7d || 0,
        model_guessed: byKey[s.key]?.model_guessed || 0,
        latest_at: byKey[s.key]?.latest_at || null,
      })),
    });
  } catch (e) { fail(res, e); }
});

// ── the by-recipient view ───────────────────────────────────────────────────
// "I'd like to view in sections based on who it's addressed to." Two groupings,
// because they answer different questions: `mailbox` is which mailbox Wren
// polled (and is the access boundary), `addressed_to` is what the sender
// actually typed on the To line. Rows received before b364 have no addressed_to
// and are reported honestly as "not recorded" rather than folded into the mailbox.
router.get('/recipients', async (req, res) => {
  try {
    const db = getPool();
    const { rows: boxes } = await db.query(`
      SELECT mailbox, count(*)::int AS total,
             count(*) FILTER (WHERE action_state = 'needs_reply' AND status='pending')::int AS needs_reply
        FROM comms_email_queue
       WHERE direction = 'in' AND mailbox = ANY($1) GROUP BY 1 ORDER BY 2 DESC`, [req._mailboxes]);
    const { rows: to } = await db.query(`
      SELECT lower(trim(addressed_to)) AS addressed_to, count(*)::int AS total,
             count(*) FILTER (WHERE action_state = 'needs_reply' AND status='pending')::int AS needs_reply,
             max(received_at) AS latest_at
        FROM comms_email_queue
       WHERE direction = 'in' AND mailbox = ANY($1) AND addressed_to IS NOT NULL AND addressed_to <> ''
       GROUP BY 1 ORDER BY 2 DESC LIMIT 40`, [req._mailboxes]);
    const { rows: unknown } = await db.query(`
      SELECT count(*)::int AS n FROM comms_email_queue
       WHERE direction = 'in' AND mailbox = ANY($1) AND (addressed_to IS NULL OR addressed_to = '')`,
      [req._mailboxes]);
    res.json({
      by_mailbox: boxes,
      by_addressee: to,
      addressee_not_recorded: unknown[0]?.n || 0,
      note: 'addressed_to is the To/Delivered-To header, recorded from b364 onward. Older rows have none.',
    });
  } catch (e) { fail(res, e); }
});

// ── one section's email ─────────────────────────────────────────────────────
router.get('/emails', async (req, res) => {
  try {
    const db = getPool();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '40', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const params = [req._mailboxes];
    const where = [`eq.direction = 'in'`, `eq.mailbox = ANY($1)`];

    if (req.query.section === '_unclassified') {
      where.push('eq.section IS NULL');
    } else if (req.query.section && req.query.section !== 'all') {
      params.push(req.query.section);
      where.push(`eq.section = $${params.length}`);
    }
    if (req.query.mailbox) {
      params.push(req.query.mailbox);
      where.push(`eq.mailbox = $${params.length}`);
    }
    if (req.query.addressed_to) {
      params.push(String(req.query.addressed_to).toLowerCase());
      where.push(`lower(trim(eq.addressed_to)) = $${params.length}`);
    }
    if (req.query.action_state) {
      params.push(req.query.action_state);
      where.push(`eq.action_state = $${params.length}`);
    }
    if (req.query.q) {
      params.push('%' + String(req.query.q).slice(0, 80) + '%');
      where.push(`(eq.subject ILIKE $${params.length} OR eq.from_name ILIKE $${params.length} OR eq.from_email ILIKE $${params.length})`);
    }
    if (req.query.include_snoozed !== '1') {
      where.push(`(eq.snoozed_until IS NULL OR eq.snoozed_until <= now())`);
    }

    params.push(limit, offset);
    const { rows } = await db.query(`
      SELECT eq.id, eq.section, eq.section_source, eq.section_confidence, eq.section_reason,
             eq.mailbox, eq.addressed_to, eq.thread_id, eq.from_name, eq.from_email,
             eq.subject, eq.snippet, eq.summary, eq.received_at, eq.importance,
             eq.action_state, eq.status, eq.topic, eq.has_attachments, eq.snoozed_until,
             eq.assigned_to, a.first_name AS assigned_to_name,
             c.case_kind, (c.email_id IS NOT NULL) AS has_card,
             (c.suggested_reply IS NOT NULL) AS has_draft, c.unavailable AS card_unavailable
        FROM comms_email_queue eq
        LEFT JOIN inbox_intel_cards c ON c.email_id = eq.id
        LEFT JOIN staff a ON a.id = eq.assigned_to
       WHERE ${where.join(' AND ')}
       ORDER BY eq.received_at DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    const countParams = params.slice(0, params.length - 2);
    const { rows: cnt } = await db.query(
      `SELECT count(*)::int AS total FROM comms_email_queue eq WHERE ${where.join(' AND ')}`, countParams);
    res.json({ emails: rows, total: cnt[0].total, limit, offset });
  } catch (e) { fail(res, e); }
});

// ── one email, with its card ────────────────────────────────────────────────
// The card is built on demand when there is not one yet, unless ?card=0. That is
// what makes the feature work on the backlog as well as on new mail, and it is
// why a manager never sees an empty panel with a "generate" button.
router.get('/emails/:id', async (req, res) => {
  try {
    const db = getPool();
    const found = await loadEmail(db, req.params.id, req._mailboxes);
    if (found.notFound) return res.status(404).json({ error: 'not_found' });
    if (found.forbidden) return res.status(403).json({ error: 'no_mailbox_access' });
    const email = found.email;

    let card = await hermes.getCard(db, email.id);
    if (!card && req.query.card !== '0') {
      card = await hermes.card(db, email, { staffId: req.user.id });
    }
    // The section may never have been set (a row from before b364).
    if (!email.section && req.query.classify !== '0') {
      try {
        const v = await sectionsLib.classifyRow(db, email, { useModel: true });
        email.section = v.section; email.section_source = v.source;
        email.section_confidence = v.confidence; email.section_reason = v.reason;
      } catch (_) {}
    }

    const { rows: thread } = await db.query(`
      SELECT id, direction, from_name, from_email, subject, received_at, sent_at,
             status, left(COALESCE(summary, snippet, ''), 200) AS gist
        FROM comms_email_queue
       WHERE thread_id = $1 AND thread_id IS NOT NULL
       ORDER BY COALESCE(received_at, sent_at) ASC LIMIT 30`, [email.thread_id]);

    res.json({
      email, card,
      thread: thread.length > 1 ? thread : [],
      can_send: true,
      send_endpoint: `/api/comms/emails/${email.id}/send-draft`,
      note: 'A suggested reply is a draft. It is sent only by POSTing to send_endpoint, which happens when a person presses send.',
    });
  } catch (e) { fail(res, e); }
});

// ── rebuild the card ────────────────────────────────────────────────────────
router.post('/emails/:id/card', async (req, res) => {
  try {
    const db = getPool();
    const found = await loadEmail(db, req.params.id, req._mailboxes);
    if (found.notFound) return res.status(404).json({ error: 'not_found' });
    if (found.forbidden) return res.status(403).json({ error: 'no_mailbox_access' });
    res.json({ card: await hermes.card(db, found.email, { staffId: req.user.id, force: true }) });
  } catch (e) { fail(res, e); }
});

// ── correct the section ─────────────────────────────────────────────────────
// A person's correction is source 'manual' at confidence 1, and it also writes a
// comms_email_topic_feedback-style trail through comms_email_activity so "Wren
// keeps getting this wrong" is answerable from data later.
router.put('/emails/:id/section', async (req, res) => {
  try {
    const db = getPool();
    const section = String((req.body || {}).section || '');
    if (!sectionsLib.SECTIONS.includes(section)) {
      const list = await sectionsLib.sectionList(db);
      if (!list.some(s => s.key === section)) return res.status(400).json({ error: 'unknown_section' });
    }
    const found = await loadEmail(db, req.params.id, req._mailboxes);
    if (found.notFound) return res.status(404).json({ error: 'not_found' });
    if (found.forbidden) return res.status(403).json({ error: 'no_mailbox_access' });
    const was = found.email.section;
    const { rows } = await db.query(`
      UPDATE comms_email_queue
         SET section = $2, section_source = 'manual', section_confidence = 1.000,
             section_reason = $3, section_set_at = now(), section_set_by = $4
       WHERE id = $1
       RETURNING id, section, section_source, section_confidence, section_reason`,
      [found.email.id, section,
       `Set by hand${was ? ` (was ${was}, ${found.email.section_source || 'unknown source'})` : ''}.`,
       req.user.id]);
    try {
      await db.query(
        `INSERT INTO comms_email_activity (email_id, staff_id, action) VALUES ($1,$2,'section_corrected')`,
        [found.email.id, req.user.id]);
    } catch (_) {}
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

// ── hand it to someone ─────────────────────────────────────────────────────
// b358's Action Plan is the task system. This creates an item in the "Assigned
// work" plan and lets b358 do the rest — the mirror task, the assignees, the
// 24h/1h reminders, the notification. No second task store (the brief is explicit).
router.post('/emails/:id/task', async (req, res) => {
  try {
    const db = getPool();
    const found = await loadEmail(db, req.params.id, req._mailboxes);
    if (found.notFound) return res.status(404).json({ error: 'not_found' });
    if (found.forbidden) return res.status(403).json({ error: 'no_mailbox_access' });
    const email = found.email;

    const b = req.body || {};
    const assignees = Array.isArray(b.assignees) ? b.assignees.map(Number).filter(Number.isInteger)
                    : (b.assigned_staff_id ? [Number(b.assigned_staff_id)] : []);
    if (!assignees.length) return res.status(400).json({ error: 'assignee_required',
      message: 'Say who it is for — an unassigned item is not on anybody\'s list.' });

    const title = String(b.title || `Email: ${email.subject || '(no subject)'}`).trim().slice(0, 200);
    // The description names the email rather than copying it. A task list is read
    // by whoever it is assigned to, who may not be on the email-reading list —
    // so the body of a parent's email must not be pasted into it.
    const description = [
      String(b.notes || '').trim().slice(0, 2000),
      `From the ${email.section || 'inbox'} section of the ${email.mailbox || 'shared'} mailbox`
        + `${email.received_at ? `, received ${String(email.received_at).slice(0, 10)}` : ''}.`,
      `Open it in Wren: /hermes-inbox.html?email=${email.id}`,
    ].filter(Boolean).join('\n\n');

    const planId = await apTasks.getOrCreateTaskPlan(db, req.user.id);
    const { rows: items } = await db.query(`
      INSERT INTO action_plan_items
        (plan_id, title, description, priority, status, deadline, category,
         assigned_staff_id, notify_assignee, document_ref)
      VALUES ($1,$2,$3,$4,'todo',$5,'communications',$6,true,$7)
      RETURNING *`,
      [planId, title, description, apTasks.normPriority(b.priority || 'medium'),
       b.deadline || null, assignees[0], `comms_email_queue:${email.id}`]);
    const item = items[0];

    const synced = await apTasks.syncItem(db, req.user, item, { assignees });

    // The email itself is now somebody else's: assign it and take it off the
    // needs-reply list, which is what "give it to someone" means in an inbox.
    await db.query(
      `UPDATE comms_email_queue SET assigned_to = $2, action_state = 'waiting_on' WHERE id = $1`,
      [email.id, assignees[0]]);
    try {
      await db.query(
        `INSERT INTO comms_email_activity (email_id, staff_id, action) VALUES ($1,$2,'assigned')`,
        [email.id, req.user.id]);
    } catch (_) {}

    res.status(201).json({
      item, task_id: synced.task_id, told: synced.added,
      plan_id: planId,
      note: 'Created in the Action Plan (Assigned work). The email body was not copied into it.',
    });
  } catch (e) { fail(res, e); }
});

// ── log that a reply went out ───────────────────────────────────────────────
// The send itself is POST /api/comms/emails/:id/send-draft (b338, unchanged), and
// that endpoint writes the inbox_reply_log row server-side so the audit cannot be
// skipped by a client that forgets. This endpoint exists for the one thing the
// server cannot know: whether the draft that went out was Hermes's suggestion
// untouched, an edit of it, or typed from scratch. It only ever REFINES the row
// the send already wrote, and refuses to invent one.
router.post('/emails/:id/sent', async (req, res) => {
  try {
    const db = getPool();
    const found = await loadEmail(db, req.params.id, req._mailboxes);
    if (found.notFound) return res.status(404).json({ error: 'not_found' });
    if (found.forbidden) return res.status(403).json({ error: 'no_mailbox_access' });
    const src = String((req.body || {}).draft_source || 'unknown');
    if (!['hermes', 'hermes-edited', 'typed', 'suggested', 'unknown'].includes(src)) {
      return res.status(400).json({ error: 'bad_draft_source' });
    }
    const { rows } = await db.query(`
      UPDATE inbox_reply_log SET draft_source = $3
       WHERE id = (SELECT id FROM inbox_reply_log
                    WHERE email_id = $1 AND staff_id = $2
                      AND sent_at > now() - interval '10 minutes'
                    ORDER BY sent_at DESC LIMIT 1)
       RETURNING *`, [found.email.id, req.user.id, src]);
    if (!rows.length) {
      return res.status(409).json({ error: 'no_send_to_annotate',
        message: 'No reply from you was logged for this email in the last ten minutes. '
               + 'The send path writes that row — this endpoint only labels which draft went out.' });
    }
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

// ── what have I missed ─────────────────────────────────────────────────────
router.get('/missed', async (req, res) => {
  try {
    const db = getPool();
    // ?since= is for the test harness and for "show me the last 24 hours again".
    // It never moves the stored stamp.
    const since = req.query.since ? new Date(req.query.since) : null;
    if (req.query.since && isNaN(since.getTime())) return res.status(400).json({ error: 'bad_since' });
    res.json(await hermes.missed(db, req.user.id, req._mailboxes, since));
  } catch (e) { fail(res, e); }
});

router.post('/seen', async (req, res) => {
  try { res.json(await hermes.markSeen(getPool(), req.user.id)); } catch (e) { fail(res, e); }
});

// ── summaries ───────────────────────────────────────────────────────────────
router.get('/summary/thread/:threadId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT id, direction, from_name, from_email, subject, snippet, summary, body_text,
             section, received_at, mailbox
        FROM comms_email_queue
       WHERE thread_id = $1 AND mailbox = ANY($2)
       ORDER BY COALESCE(received_at, sent_at) ASC LIMIT 30`,
      [req.params.threadId, req._mailboxes]);
    if (!rows.length) return res.status(404).json({ error: 'thread_not_found_or_not_yours' });
    res.json(await hermes.summarise(db, {
      scope: 'thread', ref: req.params.threadId, from: null, to: null,
      emails: rows, staffId: req.user.id,
    }));
  } catch (e) { fail(res, e); }
});

router.get('/summary/section/:section', async (req, res) => {
  try {
    const db = getPool();
    const days = Math.min(31, Math.max(1, parseInt(req.query.days || '7', 10)));
    // The window is snapped to whole days so two people asking "this week" in the
    // same afternoon hit the same cache row instead of generating twice.
    const to = new Date(); to.setHours(23, 59, 59, 999);
    const from = new Date(to.getTime() - days * 86400000); from.setHours(0, 0, 0, 0);
    const { rows } = await db.query(`
      SELECT id, direction, from_name, from_email, subject, snippet, summary,
             section, received_at, mailbox
        FROM comms_email_queue
       WHERE direction = 'in' AND section = $1 AND mailbox = ANY($2)
         AND received_at >= $3 AND received_at <= $4
       ORDER BY received_at ASC LIMIT 60`,
      [req.params.section, req._mailboxes, from, to]);
    res.json(Object.assign(
      await hermes.summarise(db, {
        scope: 'section', ref: req.params.section, from, to, emails: rows, staffId: req.user.id,
      }),
      { days, window_from: from, window_to: to }));
  } catch (e) { fail(res, e); }
});

// ── the sender rules ────────────────────────────────────────────────────────
router.get('/rules', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT r.*, s.first_name AS created_by_name,
             (SELECT count(*)::int FROM comms_email_queue q
               WHERE q.section = r.section AND q.section_source = 'domain') AS section_matches
        FROM inbox_section_rules r LEFT JOIN staff s ON s.id = r.created_by
       ORDER BY r.priority ASC, r.id ASC`);
    res.json({ rules: rows, sections: await sectionsLib.sectionList(db) });
  } catch (e) { fail(res, e); }
});

router.post('/rules', async (req, res) => {
  try {
    const db = getPool();
    const b = req.body || {};
    const kind = ['domain', 'email', 'from_contains', 'subject'].includes(b.match_kind) ? b.match_kind : 'domain';
    const value = String(b.value || '').trim().toLowerCase().replace(/^@+/, '');
    if (!value) return res.status(400).json({ error: 'value_required' });
    const list = await sectionsLib.sectionList(db);
    if (!list.some(s => s.key === b.section)) return res.status(400).json({ error: 'unknown_section' });
    const { rows } = await db.query(`
      INSERT INTO inbox_section_rules (match_kind, value, section, priority, note, created_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (match_kind, value) DO UPDATE
        SET section = EXCLUDED.section, enabled = true, priority = EXCLUDED.priority,
            note = EXCLUDED.note
      RETURNING *`,
      [kind, value, b.section,
       Number.isFinite(Number(b.priority)) ? Math.max(1, Math.min(9999, Number(b.priority))) : 50,
       String(b.note || '').slice(0, 500) || null, req.user.id]);
    sectionsLib.invalidateRules();
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e); }
});

router.patch('/rules/:id', async (req, res) => {
  try {
    const db = getPool();
    const enabled = (req.body || {}).enabled === true;
    const { rows } = await db.query(
      `UPDATE inbox_section_rules SET enabled = $2 WHERE id = $1 RETURNING *`,
      [parseInt(req.params.id, 10), enabled]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    sectionsLib.invalidateRules();
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

// ── which sections alert ───────────────────────────────────────────────────
router.get('/urgent-sections', async (req, res) => {
  try {
    const db = getPool();
    res.json({ urgent_sections: await sectionsLib.urgentSections(db),
               sections: await sectionsLib.sectionList(db) });
  } catch (e) { fail(res, e); }
});

router.put('/urgent-sections', async (req, res) => {
  try {
    const db = getPool();
    const want = Array.isArray((req.body || {}).sections) ? req.body.sections : null;
    if (!want) return res.status(400).json({ error: 'sections_array_required' });
    const list = await sectionsLib.sectionList(db);
    const keys = new Set(list.map(s => s.key));
    const clean = [...new Set(want.map(String).filter(s => keys.has(s)))];
    await db.query(`
      INSERT INTO settings (key, value) VALUES ('inbox_urgent_sections', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(clean)]);
    res.json({ urgent_sections: clean });
  } catch (e) { fail(res, e); }
});

// ── classify the backlog ───────────────────────────────────────────────────
// Every row in the queue that predates b364 has no section. This walks them in
// batches, most recent first, so the sections are useful immediately rather than
// only for mail that arrives from now on. Capped per call: a model step on
// hundreds of rows is minutes of Ascent time, and an HTTP request should not hold
// it. Call it again for the next batch.
router.post('/classify-backlog', async (req, res) => {
  try {
    const db = getPool();
    const limit = Math.min(200, Math.max(1, parseInt((req.body || {}).limit || '50', 10)));
    const useModel = (req.body || {}).use_model !== false;
    const { rows } = await db.query(`
      SELECT id, from_email, from_name, subject, body_text, snippet, topic
        FROM comms_email_queue
       WHERE section IS NULL AND direction = 'in' AND mailbox = ANY($1)
       ORDER BY received_at DESC NULLS LAST LIMIT $2`, [req._mailboxes, limit]);
    const bySection = {}, bySource = {};
    for (const row of rows) {
      try {
        const v = await sectionsLib.classifyRow(db, row, { useModel });
        bySection[v.section] = (bySection[v.section] || 0) + 1;
        bySource[v.source] = (bySource[v.source] || 0) + 1;
      } catch (e) { bySource.error = (bySource.error || 0) + 1; }
    }
    const { rows: left } = await db.query(
      `SELECT count(*)::int AS n FROM comms_email_queue
        WHERE section IS NULL AND direction='in' AND mailbox = ANY($1)`, [req._mailboxes]);
    res.json({ classified: rows.length, by_section: bySection, by_source: bySource, remaining: left[0].n });
  } catch (e) { fail(res, e); }
});

// ── proof of sovereignty ───────────────────────────────────────────────────
// Not decoration. "Which model read the parents' email" has to have an answer on
// demand, and this is it. Same endpoint shape as b235's /api/inbox-intel/model.
router.get('/model', async (req, res) => {
  const ai = require('../lib/ai-models');
  try {
    const s = await sovereign.assertSovereign();
    res.json({
      host: s.host, reasoning_model: s.model, classifier_model: ai.model('fast'),
      installed: s.available, cloud_fallback: false,
      note: 'src/lib/sovereign-model.js refuses any host that is not a private, loopback or Tailscale-CGNAT IP literal, '
          + 'and re-checks before every request. There is no cloud provider in the module, so email content cannot reach one.',
    });
  } catch (e) {
    res.status(503).json({
      error: 'sovereign_model_unavailable', message: e.message,
      classifier_model: ai.model('fast'), cloud_fallback: false,
      degraded: 'Email still arrives and the sections still work from the sender rules and the contact lookup — '
              + 'those are SQL. Drafts and summaries say they are unavailable until the Ascent is back.',
    });
  }
});

module.exports = router;
