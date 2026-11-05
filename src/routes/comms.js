const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const gmail = require('../lib/gmail-sender');
const { sendEmail } = require('../lib/notifications');
const { isAllowedRecipient, isManagerRole, getAllowedEmails } = require('../lib/email-allowlist');
// b338 (2026-09-17): topic enum shared with the email-rules 'set_topic' action
// and the poller's classifier, so a PATCH here can't write a value the rest of
// the pipeline doesn't recognise.
const { TOPIC_VALUES } = require('../services/email-rules');
// b486 (2026-10-12): Resync / Draft replies / drafting-optional settings — all on
// top of the existing b364 Hermes card pipeline, not a new one.
const gmailPoller = require('../jobs/gmail-inbox-poller');
const inboxHermes = require('../lib/inbox-hermes');
const inboxDraftJob = require('../jobs/inbox-draft-job');
// b487 (2026-10-12): toby@ (confidential, Toby+the office manager only) + the EY tablet's
// staff inbox (deputy managers/room leaders/managers, staff@ only, section-
// and safeguarding-filtered). inboxAccessLib is the CANONICAL mailbox-access
// module (src/lib/inbox-access.js) — used here only for the NEW eyAllowedMailboxes/
// isEyInboxEligible/isConfidentialMailbox helpers; the admin-list functions
// just below (managerStaffIds/mailboxDefinitions/allowedMailboxes/isCommsManager)
// are the pre-existing b338 copy and are left exactly as they were.
const inboxAccessLib = require('../lib/inbox-access');
const eyInboxPerms = require('../lib/ey-inbox-permissions');
const inboxSectionsLib = require('../lib/inbox-sections');
const { hasCapability, isOwnerRole, rawRole } = require('../lib/capabilities');

router.use(authenticate);

// 2026-10-13 (P0): nothing in this router is for a family. A parent token
// (aud 'parents', role 'parent') reached /summary, /enquiries and /messages and
// got every family's threads, every enquiry and the inbox. 'comms' is on
// PARENT_DENY in server-unified.js too (627c8c66); this refusal is here as well
// because the router is also mounted by the demo/school editions' own servers,
// which have no PARENT_DENY.
router.use((req, res, next) => {
  if (req.user && (req.user.role === 'parent' || req.user.aud === 'parents')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

// ── b338: shared-inbox settings (mailboxes + who is "management") ───────────
// "Only management can read email: Toby, the office manager and the admissions lead" — driven by a
// settings list of staff ids (never hard-coded names) plus the per-mailbox
// grants table (comms_mailbox_access). This is layered ON TOP OF the existing
// inboxAccess gate below, not a replacement for it: it only narrows access
// further (a senior role that isn't on the manager list now sees an empty
// mailbox list from every endpoint that calls allowedMailboxes()).
const ACTION_STATES = ['needs_reply', 'waiting_on', 'fyi', 'done'];

async function managerStaffIds(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='comms_manager_staff_ids'`);
    const parsed = JSON.parse(rows[0]?.value || '[]');
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch { return []; }
}

async function mailboxDefinitions(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='comms_mailboxes'`);
    const parsed = JSON.parse(rows[0]?.value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Mailbox addresses this staff member may read. Empty array = no email access at all. */
async function allowedMailboxes(db, staffId) {
  const mgrs = await managerStaffIds(db);
  if (!mgrs.includes(Number(staffId))) return [];
  const { rows } = await db.query(`SELECT mailbox FROM comms_mailbox_access WHERE staff_id=$1`, [staffId]);
  return rows.map(r => r.mailbox);
}

async function isCommsManager(db, staffId) {
  const mgrs = await managerStaffIds(db);
  return mgrs.includes(Number(staffId));
}

// b487 (2026-10-12): which mailboxes a READ (list/get) should resolve to for
// THIS caller. On the EY/'learning' portal, an eligible deputy manager/room
// leader/manager gets the role-based, non-confidential set (staff@ — never
// toby@, whoever is asking); everywhere else, behaviour is EXACTLY the
// pre-existing admin-list lookup above, untouched. `ey:true` tells callers to
// also apply the section/safeguarding content filter from
// src/lib/ey-inbox-permissions.js — that filter is never applied to a Roost
// caller, who is already on the much narrower comms_manager_staff_ids list.
async function resolveReadMailboxes(req, db) {
  if (req._portal === 'learning' && inboxAccessLib.isEyInboxEligible(req.user)) {
    return { mailboxes: await inboxAccessLib.eyAllowedMailboxes(db), ey: true };
  }
  return { mailboxes: await allowedMailboxes(db, req.user.id), ey: false };
}

// b487: the confidential-mailbox guard send-draft already carried inline
// (2026-09-29) — lifted out so pin/unpin/ignore/edit-draft, which had NO
// mailbox check at all, apply the exact same rule rather than a near-copy.
// Non-confidential mailboxes (staff@) are unaffected either way — this only
// ever blocks a reply/pin/ignore/edit on a row that arrived in a mailbox
// flagged confidential (toby@) by someone not granted it.
async function assertMailboxActionable(db, user, mailbox) {
  if (!mailbox) return { ok: true };
  if (!(await inboxAccessLib.isConfidentialMailbox(db, mailbox))) return { ok: true };
  const mine = await allowedMailboxes(db, user.id);
  if (mine.includes(mailbox)) return { ok: true };
  return { ok: false, status: 403, body: { error: 'confidential_mailbox',
    message: 'That email is in a confidential mailbox you have not been granted.' } };
}

// GET /api/comms/mailboxes — mailboxes the calling staff member has access to.
// Staff never get mailbox access (decision, 2026-09-17) — this returns an empty
// list for anyone not on the comms_manager_staff_ids setting, same rule whether
// they're a practitioner or a deputy/admin with the broader inboxAccess flag.
router.get('/mailboxes', async (req, res) => {
  const db = getPool();
  try {
    const allowed = await allowedMailboxes(db, req.user.id);
    const defs = await mailboxDefinitions(db);
    res.json({ mailboxes: defs.filter(d => allowed.includes(d.address)) });
  } catch (err) {
    console.error('comms mailboxes error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// Inbox access gate (2026-08-04): the incoming-email routes are reachable from any
// portal (EY/HR/Roost), so restrict them to senior staff OR anyone explicitly granted
// staff.inbox_access — NOT every practitioner. Managers/deputies pass by role.
// b487 (2026-10-12): 'room_leader' added — the EY staff inbox is explicitly for
// deputy managers AND room leaders (Toby, 2026-10-12), and a room leader's
// staff.inbox_access is not reliably set (role-based here, same as the other four).
const _INBOX_SENIOR = ['manager', 'deputy_manager', 'admin', 'headteacher', 'owner', 'room_leader'];
async function inboxAccess(req, res, next) {
  try {
    if (_INBOX_SENIOR.includes(String(req.user?.role || '').toLowerCase())) return next();
    if (Number.isInteger(req.user?.id)) {
      const { rows } = await getPool().query('SELECT inbox_access FROM staff WHERE id=$1', [req.user.id]);
      if (rows[0] && rows[0].inbox_access) return next();
    }
  } catch (_) {}
  return res.status(403).json({ error: 'Inbox access required' });
}
// Gate the incoming-email hub routes (GET /emails + /emails/:id/*).
router.use('/emails', inboxAccess);

// 2026-10-13 (P0): /calls and /messages (and POST /enquiries/:id/reply) only ever
// ran authenticate(), so any token that passed the audience check — a
// practitioner on the EY tablet included — read every family's message threads
// (child names) and every Vapi call, and could post into any thread. Managers
// and deputies only, by role: the same list isManagerRole() already uses for
// "may email anyone" (manager, deputy_manager, deputy, admin, owner,
// headteacher, business_manager, and Toby id=1). This replaces the per-route
// inboxAccess that 627c8c66 put on /summary and /enquiries: inboxAccess also
// admits anyone with staff.inbox_access, who is not meant to see admissions,
// phone calls or every family's thread. The dashboards that call /summary
// .catch() a failure, so a practitioner just loses the unread-messages alert.
// /summary's email block is scoped separately, by mailbox, below.
function commsManagersOnly(req, res, next) {
  if (isManagerRole(req.user)) return next();
  return res.status(403).json({ error: 'Managers only' });
}
router.use(['/summary', '/enquiries', '/calls', '/messages'], commsManagersOnly);

// GET /api/comms/validate-recipient?email=... — client-side recipient check.
// Non-blocking helper for the compose UI: returns whether THIS user may email the
// address. Managers always allowed. Never echoes any other parent's address.
router.get('/validate-recipient', async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email query param required' });
  try {
    const allowed = await isAllowedRecipient(email, req.user);
    res.json({ email, allowed, manager: isManagerRole(req.user) });
  } catch (e) {
    res.status(500).json({ error: 'validation failed' });
  }
});

// GET /api/comms/summary — dashboard card data + morning-briefing counts
router.get('/summary', async (req, res) => {
  const db = getPool();
  const result = {
    vapi_calls: [], emails: [], threads: [], enquiries: [], unread_count: 0,
    counts: { calls_unreviewed: 0, emails_pending: 0, emails_need_reply: 0,
              messages_unread: 0, enquiries_open: 0 },
  };

  try {
    const { rows } = await db.query(
      `SELECT id, started_at, duration_seconds, from_number, summary, urgency
       FROM vapi_calls WHERE reviewed_at IS NULL ORDER BY started_at DESC LIMIT 5`
    );
    result.vapi_calls = rows;
  } catch {}
  try {
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM vapi_calls WHERE reviewed_at IS NULL`);
    result.counts.calls_unreviewed = rows[0]?.n || 0;
  } catch {}

  // 2026-10-13 (P0): the email block is scoped to the caller's own mailboxes —
  // the same hard boundary GET /emails has used since b338. It used to read the
  // whole queue, so the top 10 could include the confidential mailbox (admin@ on
  // prod, granted to Toby alone) for anyone who could reach /summary. No mailbox
  // access → no emails and zero email counts, never a fallback to "all".
  let mailboxes = [];
  try { mailboxes = await allowedMailboxes(db, req.user.id); } catch {}
  if (mailboxes.length) {
    try {
      const { rows } = await db.query(
        `SELECT id, from_email, from_name, subject, classification, category, importance,
                summary, suggested_action, suggested_draft, suggested_replies, direction, received_at
         FROM comms_email_queue
         WHERE status = 'pending' AND (direction = 'in' OR direction IS NULL)
           AND mailbox = ANY($1)
         ORDER BY importance DESC NULLS LAST, received_at DESC LIMIT 10`,
        [mailboxes]
      );
      result.emails = rows;
    } catch {}
    try {
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS pending,
                COUNT(*) FILTER (WHERE direction='in' AND suggested_action IN ('reply-now','reply-soon'))::int AS need_reply
         FROM comms_email_queue WHERE status='pending' AND mailbox = ANY($1)`,
        [mailboxes]
      );
      result.counts.emails_pending = rows[0]?.pending || 0;
      result.counts.emails_need_reply = rows[0]?.need_reply || 0;
    } catch {}
  }

  // Website enquiries that still need a response (no reply logged, open stage).
  try {
    const { rows } = await db.query(
      `SELECT id, parent_name, parent_email, parent_phone, child_first_name, child_last_name,
              room_needed, preferred_room, message, notes, source, stage, status, ai_score,
              created_at, replied_at
       FROM enquiries
       WHERE replied_at IS NULL
         AND COALESCE(stage, status, 'new') NOT IN ('enrolled','lost','closed','declined')
       ORDER BY created_at DESC LIMIT 10`
    );
    result.enquiries = rows;
  } catch {}
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM enquiries
       WHERE replied_at IS NULL AND COALESCE(stage, status, 'new') NOT IN ('enrolled','lost','closed','declined')`
    );
    result.counts.enquiries_open = rows[0]?.n || 0;
  } catch {}

  try {
    const { rows } = await db.query(
      `SELECT mt.id, mt.subject,
              c.first_name || ' ' || c.last_name AS child_name,
              mt.last_message_at,
              (SELECT COUNT(*) FROM messages m
               WHERE m.thread_id = mt.id AND m.is_read = false AND m.sender_type = 'parent') AS unread
       FROM message_threads mt
       LEFT JOIN children c ON c.id = mt.child_id
       LEFT JOIN message_archive ar ON ar.thread_id = mt.id AND ar.user_kind = 'staff' AND ar.user_id = $1
       WHERE ar.thread_id IS NULL          -- b107: threads this user archived don't count as unread
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE m.thread_id = mt.id AND m.is_read = false AND m.sender_type = 'parent'
         )
       ORDER BY mt.last_message_at DESC LIMIT 3`,
      [req.user.id]
    );
    result.threads = rows;
    result.unread_count = rows.reduce((s, t) => s + parseInt(t.unread || 0), 0);
    result.counts.messages_unread = result.unread_count;
  } catch {}

  res.json(result);
});

// ── Enquiries (website / phone enquiries from enquiries) ──────────────────

// GET /api/comms/enquiries?status&page — unified into the comms stream
router.get('/enquiries', async (req, res) => {
  const db = getPool();
  try {
    const { status, page = 1 } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;
    const params = [];
    const conditions = [];

    if (status === 'open') {
      conditions.push(`(replied_at IS NULL AND COALESCE(stage, status, 'new') NOT IN ('enrolled','lost','closed','declined'))`);
    } else if (status === 'replied') {
      conditions.push(`replied_at IS NOT NULL`);
    } else if (status && status !== 'all') {
      params.push(status);
      conditions.push(`COALESCE(stage, status) = $${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit); params.push(offset);

    const { rows } = await db.query(
      `SELECT e.id, e.parent_name, e.parent_email, e.parent_phone,
              e.child_first_name, e.child_last_name, e.child_dob,
              e.room_needed, e.preferred_room, e.preferred_start_date, e.start_date_requested,
              e.message, e.notes, e.source, e.stage, e.status, e.ai_score, e.ai_score_reason,
              e.created_at, e.updated_at, e.replied_at,
              s.first_name || ' ' || s.last_name AS replied_by_name
       FROM enquiries e
       LEFT JOIN staff s ON s.id = e.replied_by
       ${where}
       ORDER BY e.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM enquiries e ${where}`, countParams
    );
    res.json({ enquiries: rows, total: parseInt(countRows[0].total), page: parseInt(page), limit });
  } catch (err) {
    console.error('comms enquiries error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/enquiries/:id/reply — send an email reply to an enquirer + log it
router.post('/enquiries/:id/reply', async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT * FROM enquiries WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const enq = rows[0];
    const recipient = (enq.parent_email || '').trim();
    if (!recipient) return res.status(400).json({ error: 'Enquiry has no email address' });

    // Staff email blocklist: non-managers may only email parents of enrolled children.
    if (!(await isAllowedRecipient(recipient, req.user))) {
      return res.status(403).json({ error: 'recipient_not_parent',
        message: 'Staff can only email parents of enrolled children' });
    }

    const subject = `Your Nursery — your enquiry`;
    const html = `<div style="font-family:system-ui,Arial,sans-serif;line-height:1.6">${String(body).replace(/\n/g, '<br>')}</div>`;
    let sent = false, info = '';
    try {
      if (gmail.isConfigured()) {
        const r = await gmail.sendViaGmail({ to: recipient, subject, html, text: body });
        sent = !!(r && r.ok); info = r && r.messageId ? `gmail:${r.messageId}` : 'gmail';
      } else {
        sent = await sendEmail(recipient, subject, html, 'enquiry-reply'); info = 'sendEmail';
      }
    } catch (e) {
      return res.status(502).json({ error: 'Send failed: ' + e.message });
    }
    if (!sent) return res.status(502).json({ error: 'Send failed (no transport delivered the message)' });

    await db.query(
      `UPDATE enquiries SET replied_at=NOW(), replied_by=$2,
         stage = CASE WHEN COALESCE(stage,'new') = 'new' THEN 'contacted' ELSE stage END
       WHERE id=$1`,
      [enq.id, req.user.id]
    );
    res.json({ ok: true, sent_to: recipient, via: info });
  } catch (err) {
    console.error('comms enquiry reply error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Calls ─────────────────────────────────────────────────────────────────────

// GET /api/comms/calls?from&to&urgency&reviewed&page
router.get('/calls', async (req, res) => {
  const db = getPool();
  try {
    const { from, to, urgency, reviewed, page = 1 } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    const params = [];
    const conditions = [];

    if (from) {
      params.push(from);
      conditions.push(`vc.started_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`vc.started_at <= ($${params.length}::date + interval '1 day')`);
    }
    if (urgency) {
      params.push(urgency);
      conditions.push(`vc.urgency = $${params.length}`);
    }
    if (reviewed === 'yes') {
      conditions.push('vc.reviewed_at IS NOT NULL');
    } else if (reviewed === 'no') {
      conditions.push('vc.reviewed_at IS NULL');
    }

    const { safeguarding } = req.query;
    if (safeguarding === 'yes') conditions.push('vc.safeguarding_flagged = true');

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    params.push(limit);
    params.push(offset);
    const { rows } = await db.query(
      `SELECT vc.*,
              s.first_name || ' ' || s.last_name AS reviewed_by_name
       FROM vapi_calls vc
       LEFT JOIN staff s ON s.id = vc.reviewed_by
       ${where}
       ORDER BY vc.started_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM vapi_calls vc ${where}`,
      countParams
    );

    res.json({ calls: rows, total: parseInt(countRows[0].total), page: parseInt(page), limit });
  } catch (err) {
    console.error('comms calls error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/calls/:id/reviewed
router.post('/calls/:id/reviewed', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE vapi_calls SET reviewed_by=$1, reviewed_at=NOW() WHERE id=$2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('comms calls reviewed error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/calls/:id/follow-up — creates a tasks row
router.post('/calls/:id/follow-up', async (req, res) => {
  const { task_title, due_date } = req.body;
  if (!task_title) return res.status(400).json({ error: 'task_title required' });
  const db = getPool();
  try {
    const { rows: [task] } = await db.query(
      `INSERT INTO tasks (title, source, source_ref, linked_to, created_by, status, priority, due_date)
       VALUES ($1,'vapi_call',$2,'vapi_call',$3,'open','medium',$4) RETURNING *`,
      [task_title, req.params.id, req.user.id, due_date || null]
    );
    res.status(201).json(task);
  } catch (err) {
    console.error('comms follow-up error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Emails ────────────────────────────────────────────────────────────────────

// GET /api/comms/emails?from&status&direction&page&topic&action_state&mailbox&assigned_to&pinned
router.get('/emails', async (req, res) => {
  const db = getPool();
  try {
    const { from, status = 'pending', direction, page = 1, topic, action_state, mailbox, assigned_to, pinned } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;
    const params = [];
    const conditions = [];

    // b338: mailbox is the hard access boundary. No allowed mailbox → no rows,
    // full stop, before any other filter is even considered.
    // b487: on the EY portal this resolves to the role-based, non-confidential
    // set instead (see resolveReadMailboxes above) — everywhere else unchanged.
    const { mailboxes: allowed, ey } = await resolveReadMailboxes(req, db);
    // review 2026-10-13: a practitioner holding staff.inbox_access passes the router gate but is not
    // EY-eligible and has no Roost grant, so this answered 200 [] — the tablet then said "Nothing
    // waiting — inbox is clear" instead of the "ask a manager" it shows for a 403.
    if (!allowed.length && !ey && req._portal === 'learning') {
      return res.status(403).json({ error: 'Inbox access required' });
    }
    if (!allowed.length) return res.json({ emails: [], total: 0, page: parseInt(page), limit });
    params.push(allowed);
    conditions.push(`mailbox = ANY($${params.length})`);

    // b487: the EY staff inbox additionally hides content the viewer isn't
    // permitted to see — never applied to a Roost caller (`ey` is only ever
    // true for the EY/'learning' portal; Roost's own, much narrower
    // comms_manager_staff_ids list is the gate there).
    if (ey) {
      // "Unclassified... are classified on demand before being shown on EY,
      // and stay hidden from EY if still unclassified" (Toby, 2026-10-12).
      // Bounded (10/request) so a backlog of unclassified mail can't turn one
      // page load into a long chain of model calls.
      // b486c (2026-10-13, CHECK.md defect 6): useModel:false — this used to
      // call the local model (the default) for up to 10 rows, each with up to
      // a 45s timeout, INSIDE this request. Prod has 1,227 pending staff@ rows
      // with a NULL section; at worst that was 10 serial 45s waits (7.5
      // minutes) behind nginx's 60s /api/ timeout, for every single page load.
      // The rule/known-sender/routing-topic steps (inbox-sections.js steps 1-3)
      // are in-process and free — only the model step is skipped here. Rows
      // that still need the model are picked up by the background sweep
      // (gmail-inbox-poller.js's classifyBacklog(), same 8-minute cadence as
      // the poll itself) and simply stay excluded from EY until then.
      try {
        const { rows: pending } = await db.query(
          `SELECT id, from_email, from_name, subject, body_text, snippet, topic
             FROM comms_email_queue WHERE mailbox = ANY($1) AND section IS NULL
             ORDER BY received_at DESC LIMIT 10`, [allowed]);
        for (const p of pending) {
          // review 2026-10-13: skipFallbackWrite — without the model this pass can only RESOLVE a row
          // (rule / known sender / routing topic); when none match it must leave the row NULL for the
          // background sweep, not write section='other'/'fallback' (which the sweep never revisits).
          try { await inboxSectionsLib.classifyRow(db, p, { useModel: false, skipFallbackWrite: true }); } catch (_) { /* stays NULL — excluded below */ }
        }
      } catch (_) { /* classification is best-effort; the hard exclusion below still applies */ }
      // b486c (defect 6): section_source='fallback' (the classifier gave up and
      // filed it under 'other' at 0.2 confidence) is unclassified too, not just
      // a NULL section — it used to pass this condition and show on EY.
      conditions.push(`section IS NOT NULL AND section_source IS DISTINCT FROM 'fallback'`);

      const blockedSections = await eyInboxPerms.listBlockedSections(db, req.user);
      if (blockedSections.length) {
        params.push(blockedSections);
        conditions.push(`NOT (section = ANY($${params.length}))`);
      }
      // Safeguarding is filtered in JS after the fetch below, not here — see
      // ey-inbox-permissions.js's filterListForSafeguarding() for why.
    }

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (direction === 'in') {
      conditions.push(`(direction = 'in')`);
    } else if (direction === 'out') {
      conditions.push(`(direction = 'out' OR direction IS NULL)`);
    }
    if (from) {
      params.push(from);
      conditions.push(`received_at >= $${params.length}`);
    }
    if (topic) {
      params.push(topic);
      conditions.push(`topic = $${params.length}`);
    }
    if (action_state) {
      params.push(action_state);
      conditions.push(`action_state = $${params.length}`);
    }
    if (mailbox) {
      params.push(mailbox);
      conditions.push(`mailbox = $${params.length}`);
    }
    if (assigned_to) {
      params.push(parseInt(assigned_to, 10));
      conditions.push(`assigned_to = $${params.length}`);
    }
    if (pinned === '1') {
      conditions.push(`pinned_by IS NOT NULL`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit);
    params.push(offset);

    // b486c (2026-10-13, CHECK.md defect 4): the EY branch names its columns —
    // never eq.* — so a column added to comms_email_queue later isn't shipped
    // to the shared tablet by default. body_html is dropped outright: the EY
    // UI (nursery-inbox.html) has never read it, only body_text/summary. The
    // inbox_intel_cards join brings in case_kind (so the safeguarding filter
    // below reads the SAME column the by-id actions already check — see
    // ey-inbox-permissions.js) and facts (so the finance-facts check just
    // below can null a draft built from numbers the viewer has no right to
    // see). Roost's query (the `else` branch) is untouched: its audience is
    // already the one or two people on comms_manager_staff_ids.
    const selectCols = ey
      ? `eq.id, eq.received_at, eq.from_email, eq.from_name, eq.to_email, eq.subject, eq.body_text,
         eq.classification, eq.suggested_draft, eq.draft_text, eq.status, eq.handled_at, eq.handled_by,
         eq.message_id, eq.thread_id, eq.sent_at, eq.direction, eq.category, eq.importance,
         eq.suggested_replies, eq.snippet, eq.summary, eq.suggested_action, eq.mailbox, eq.topic,
         eq.action_state, eq.snoozed_until, eq.assigned_to, eq.pinned_by, eq.pinned_at,
         eq.has_attachments, eq.apprentice_relevant, eq.apprentice_event_type,
         eq.section, eq.section_confidence, eq.section_source, eq.section_reason,
         eq.addressed_to, eq.cc_to, eq.draft_status, eq.draft_attempts,
         s.first_name || ' ' || s.last_name AS handled_by_name,
         a.first_name || ' ' || a.last_name AS assigned_to_name,
         p.first_name || ' ' || p.last_name AS pinned_by_name,
         c.case_kind, c.facts`
      : `eq.*,
         s.first_name || ' ' || s.last_name AS handled_by_name,
         a.first_name || ' ' || a.last_name AS assigned_to_name,
         p.first_name || ' ' || p.last_name AS pinned_by_name`;
    const cardJoin = ey ? 'LEFT JOIN inbox_intel_cards c ON c.email_id = eq.id' : '';

    const { rows } = await db.query(
      `SELECT ${selectCols}
       FROM comms_email_queue eq
       LEFT JOIN staff s ON s.id = eq.handled_by
       LEFT JOIN staff a ON a.id = eq.assigned_to
       LEFT JOIN staff p ON p.id = eq.pinned_by
       ${cardJoin}
       ${where}
       ORDER BY eq.received_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM comms_email_queue ${where}`,
      countParams
    );

    let outRows = rows, total = parseInt(countRows[0].total);
    if (ey) {
      // JS-side, not SQL (see ey-inbox-permissions.js) — corrects `total` by
      // however many of THIS page it removed, which is exact for the EY
      // tablet's un-paginated single fetch and an honest approximation on a
      // later page of a (currently theoretical) longer list.
      const filtered = await eyInboxPerms.filterListForSafeguarding(db, req.user, rows);
      outRows = filtered.rows;
      total = Math.max(0, total - filtered.hiddenCount);

      // b486c (defect 4): a summary/draft built from invoice, payment or
      // funding facts is withheld from anyone without finance.view — they
      // still see the email and may still reply in their own words, just not
      // Wren's AI draft of someone else's balance. facts/case_kind were only
      // ever needed here, server-side — never sent to the client either way.
      const canFinance = await hasCapability(req.user, 'finance.view');
      outRows = outRows.map(r => {
        const facts = r.facts || {};
        // review 2026-10-13: a row is money-bearing if the card's facts hold invoices/payments/funding
        // OR the card/row says it is a billing case (invoice_query / funding_query, topic 'invoice') —
        // 30 of prod's 54 draft_text rows are invoice-reply drafts with NO card, and a card whose
        // fact lookup found nothing still produced a draft that quotes figures. draft_text is withheld
        // too: nursery-inbox.html falls back to it, and pre-fills the reply box from it.
        const hasMoney = (Array.isArray(facts.invoices) && facts.invoices.length)
          || (Array.isArray(facts.payments) && facts.payments.length)
          || (Array.isArray(facts.funding) && facts.funding.length)
          || r.case_kind === 'invoice_query' || r.case_kind === 'funding_query'
          || r.topic === 'invoice';
        const { facts: _f, case_kind: _ck, ...rest } = r;
        if (hasMoney && !canFinance) {
          return { ...rest, suggested_draft: null, suggested_replies: null, draft_text: null, summary: null, draft_hidden: true,
            draft_hidden_reason: 'Draft hidden — contains billing details.' };
        }
        return rest;
      });
    }

    res.json({ emails: outRows, total, page: parseInt(page), limit });
  } catch (err) {
    console.error('comms emails error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/comms/emails/:id — one email, with any live "X is replying" status
// from another staff member (activity row, action='replying', last 2 minutes).
router.get('/emails/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT eq.*,
              s.first_name || ' ' || s.last_name AS handled_by_name,
              a.first_name || ' ' || a.last_name AS assigned_to_name,
              p.first_name || ' ' || p.last_name AS pinned_by_name
       FROM comms_email_queue eq
       LEFT JOIN staff s ON s.id = eq.handled_by
       LEFT JOIN staff a ON a.id = eq.assigned_to
       LEFT JOIN staff p ON p.id = eq.pinned_by
       WHERE eq.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const allowed = await allowedMailboxes(db, req.user.id);
    if (!allowed.includes(rows[0].mailbox)) return res.status(403).json({ error: 'No access to this mailbox' });

    const { rows: replying } = await db.query(
      `SELECT ca.staff_id, s.first_name || ' ' || s.last_name AS staff_name, ca.created_at
       FROM comms_email_activity ca JOIN staff s ON s.id = ca.staff_id
       WHERE ca.email_id=$1 AND ca.action='replying' AND ca.created_at > now() - interval '2 minutes'
         AND ca.staff_id != $2
       ORDER BY ca.created_at DESC LIMIT 1`, [req.params.id, req.user.id]);

    res.json({ ...rows[0], currently_replying: replying[0] || null });
  } catch (err) {
    console.error('comms email get error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// PATCH /api/comms/emails/:id — action_state / topic (manual override) /
// assigned_to / snoozed_until. Writes a comms_email_activity row only for an
// assignment change (assigned/unassigned) — the other fields are not "who did
// what", just row state.
router.patch('/emails/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows: cur } = await db.query('SELECT mailbox, topic FROM comms_email_queue WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const allowed = await allowedMailboxes(db, req.user.id);
    if (!allowed.includes(cur[0].mailbox)) return res.status(403).json({ error: 'No access to this mailbox' });

    const { action_state, topic, assigned_to, snoozed_until } = req.body || {};
    const sets = [], params = [];
    let p = 1;

    if (action_state !== undefined) {
      if (!ACTION_STATES.includes(action_state)) return res.status(400).json({ error: 'invalid action_state' });
      sets.push(`action_state = $${p++}`); params.push(action_state);
    }
    if (topic !== undefined) {
      if (!TOPIC_VALUES.includes(topic)) return res.status(400).json({ error: 'invalid topic' });
      if (cur[0].topic !== topic) {
        await db.query(
          `INSERT INTO comms_email_topic_feedback (email_id, staff_id, old_topic, new_topic) VALUES ($1,$2,$3,$4)`,
          [req.params.id, req.user.id, cur[0].topic, topic]);
      }
      sets.push(`topic = $${p++}`); params.push(topic);
    }
    if (assigned_to !== undefined) {
      sets.push(`assigned_to = $${p++}`); params.push(assigned_to || null);
    }
    if (snoozed_until !== undefined) {
      sets.push(`snoozed_until = $${p++}`); params.push(snoozed_until || null);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE comms_email_queue SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`, params);

    if (assigned_to !== undefined) {
      await db.query(
        `INSERT INTO comms_email_activity (email_id, staff_id, action) VALUES ($1,$2,$3)`,
        [req.params.id, req.user.id, assigned_to ? 'assigned' : 'unassigned']);
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('comms email patch error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/emails/:id/open — "N opened this" activity row.
router.post('/emails/:id/open', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT id, mailbox, section, subject, snippet, summary FROM comms_email_queue WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // review 2026-10-13: had no mailbox/eligibility check — any inbox_access caller could write an
    // "opened"/"replying" activity row onto a confidential-mailbox email (and probe which ids exist).
    const guard = await _assertRowActionable(db, req, rows[0]);
    if (!guard.ok) return res.status(guard.status).json(guard.body);
    await db.query(`INSERT INTO comms_email_activity (email_id, staff_id, action) VALUES ($1,$2,'opened')`,
      [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('comms email open error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/emails/:id/drafting — "N is replying" row, checked by
// GET /emails/:id for the 2-minute collision warning. Call when the reply
// editor opens; no explicit end call needed, it just ages out.
router.post('/emails/:id/drafting', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT id, mailbox, section, subject, snippet, summary FROM comms_email_queue WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // review 2026-10-13: had no mailbox/eligibility check — any inbox_access caller could write an
    // "opened"/"replying" activity row onto a confidential-mailbox email (and probe which ids exist).
    const guard = await _assertRowActionable(db, req, rows[0]);
    if (!guard.ok) return res.status(guard.status).json(guard.body);
    await db.query(`INSERT INTO comms_email_activity (email_id, staff_id, action) VALUES ($1,$2,'replying')`,
      [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('comms email drafting error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/comms/emails/:id/activity — who opened/replied/assigned this, and when.
// b486c (2026-10-13, CHECK.md defect 2 minor / defect 8): this had NO mailbox
// check at all — anyone with inboxAccess who knew/guessed an id could see who
// opened or assigned a toby@ email. Same guard every other by-id route here uses.
router.get('/emails/:id/activity', async (req, res) => {
  const db = getPool();
  try {
    const { rows: cur } = await db.query(
      'SELECT id, mailbox, section, subject, snippet, summary FROM comms_email_queue WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const guard = await _assertRowActionable(db, req, cur[0]);
    if (!guard.ok) return res.status(guard.status).json(guard.body);
    const { rows } = await db.query(
      `SELECT ca.id, ca.action, ca.created_at, s.first_name || ' ' || s.last_name AS staff_name
       FROM comms_email_activity ca JOIN staff s ON s.id = ca.staff_id
       WHERE ca.email_id=$1 ORDER BY ca.created_at DESC LIMIT 100`, [req.params.id]);
    res.json({ activity: rows });
  } catch (err) {
    console.error('comms email activity error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST/DELETE /api/comms/emails/:id/pin
// b487 (2026-10-12): both previously had NO mailbox check at all — any
// authenticated caller who knew/guessed an id could pin/unpin a row in the
// confidential toby@ mailbox. Same guard send-draft already carried.
router.post('/emails/:id/pin', async (req, res) => {
  const db = getPool();
  try {
    const { rows: cur } = await db.query(
      'SELECT id, mailbox, section, subject, snippet, summary FROM comms_email_queue WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const guard = await _assertRowActionable(db, req, cur[0]);
    if (!guard.ok) return res.status(guard.status).json(guard.body);
    const { rows } = await db.query(
      `UPDATE comms_email_queue SET pinned_by=$1, pinned_at=NOW() WHERE id=$2 RETURNING id`,
      [req.user.id, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // b486c (2026-10-13, defect 8): was `res.json(rows[0])` — the full row,
    // subject/summary/draft included, for an action whose only job is "pinned
    // or not". A caller who can pin a row they are not otherwise shown (e.g.
    // a stale id from a page they can no longer see) got its content back.
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('comms email pin error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});
router.delete('/emails/:id/pin', async (req, res) => {
  const db = getPool();
  try {
    const { rows: cur } = await db.query(
      'SELECT id, mailbox, section, subject, snippet, summary FROM comms_email_queue WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const guard = await _assertRowActionable(db, req, cur[0]);
    if (!guard.ok) return res.status(guard.status).json(guard.body);
    const { rows } = await db.query(
      `UPDATE comms_email_queue SET pinned_by=NULL, pinned_at=NULL WHERE id=$1 RETURNING id`,
      [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('comms email unpin error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/emails/:id/send-draft
// Body (all optional): { reply_index: 0|1|2 } to pick an A/B/C suggested reply,
// or { draft_text } for explicit text. For INBOUND rows this ACTUALLY sends the
// chosen reply to the original sender via the Gmail API (threaded), then marks
// the row 'sent'. For outbound rows it sends to to_email. If the send fails the
// row is NOT marked sent (so it can be retried).
router.post('/emails/:id/send-draft', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT * FROM comms_email_queue WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];

    // Pick the body to send: explicit text > chosen A/B/C reply > stored draft.
    let bodyText = (req.body && req.body.draft_text) || null;
    const idx = req.body && req.body.reply_index;
    if (!bodyText && (idx === 0 || idx === 1 || idx === 2) && Array.isArray(row.suggested_replies) && row.suggested_replies[idx]) {
      bodyText = row.suggested_replies[idx].text;
    }
    if (!bodyText) bodyText = row.draft_text || row.suggested_draft || null;

    const isInbound = row.direction === 'in' || (!row.to_email && row.from_email);
    const recipient = (row.to_email || row.from_email || '').trim();

    if (!recipient) return res.status(400).json({ error: 'No recipient address on this email' });
    if (!bodyText)  return res.status(400).json({ error: 'No draft text to send' });

    // b364 (2026-09-29): a CONFIDENTIAL mailbox may only be replied from by
    // somebody granted it. Narrow on purpose — this endpoint is also the EY
    // staff inbox's send button, used by deputy managers/room leaders/managers,
    // and gating every mailbox on comms_mailbox_access would take their reply
    // button away. staff@ is confidential:false so nothing they do changes;
    // toby@ (confidential) can no longer be replied from by anybody who was
    // not granted it, which before b364 only the UI prevented.
    // b487: lifted into the shared assertMailboxActionable() helper so
    // pin/unpin/ignore/edit-draft apply the identical rule.
    const mboxGuard = await assertMailboxActionable(db, req.user, row.mailbox);
    if (!mboxGuard.ok) return res.status(mboxGuard.status).json(mboxGuard.body);

    // b487 (2026-10-12): an EY caller cannot act on a row the list would never
    // have shown them (finance/staff section, or a safeguarding case) just
    // because they know its id.
    // b486c (2026-10-13, defect 8): gated on "not a Roost comms-manager grant",
    // not on portal — see _assertRowActionable's comment just above for why
    // (this route pre-dates that shared helper and carried its own copy).
    if (!(await isCommsManager(db, req.user.id))) {
      if (!inboxAccessLib.isEyInboxEligible(req.user)) {
        return res.status(403).json({ error: 'forbidden', message: 'Ask a manager.' });
      }
      const { rows: cardRows } = await db.query(
        'SELECT case_kind FROM inbox_intel_cards WHERE email_id=$1', [row.id]).catch(() => ({ rows: [] }));
      if (!(await eyInboxPerms.canSeeEmail(db, req.user, row, cardRows[0]))) {
        return res.status(403).json({ error: 'forbidden', message: 'You do not have access to this email.' });
      }
    }

    // Staff email blocklist: non-managers may only email parents of enrolled children.
    if (!(await isAllowedRecipient(recipient, req.user))) {
      return res.status(403).json({ error: 'recipient_not_parent',
        message: 'Staff can only email parents of enrolled children' });
    }

    let subject = row.subject || 'Your Nursery';
    if (isInbound && !/^re:/i.test(subject)) subject = 'Re: ' + subject;
    const html = `<div style="font-family:system-ui,Arial,sans-serif;line-height:1.6">${String(bodyText).replace(/\n/g, '<br>')}</div>`;

    // Send — prefer threaded Gmail API for inbound replies, else shared sendEmail.
    // b338: reply from the SAME alias the message arrived on, once that's a
    // mailbox other than the one that's been live since before this build
    // (INBOX_MAILBOX/staff@) — so today's staff@ replies are byte-for-byte
    // unchanged, and only a newly-enabled mailbox (e.g. admin@/toby@) gets its
    // own From address instead of always showing as the shared default.
    // 2026-10-05 (Toby): "If it comes into toby@ it should respond from toby@ — also bcc toby@";
    // replies to the shared inbox show the info@ alias and bcc staff@.
    //  • admin@/toby@ conversations → sign in as that mailbox (the thread lives there), From: toby@, Bcc toby@.
    //  • staff@ (shared) conversations → staff@ has NO info@ send-as alias, so sign in as COMMS_MAILBOX
    //    (toby@, which has info@ as an accepted alias), From: info@, Bcc staff@. The staff@ Gmail
    //    threadId does not exist in toby@'s mailbox ("Requested entity was not found" — the 5 Oct
    //    failure), so thread by In-Reply-To/References from the original message instead.
    const TOBY = (process.env.TOBY_MAILBOX || 'toby@example-nursery.co.uk').toLowerCase();
    const rowBox = String(row.mailbox || gmail.INBOX_MAILBOX || '').toLowerCase();
    const isToby = rowBox === TOBY || rowBox === String(gmail.COMMS_MAILBOX || '').toLowerCase() || rowBox.startsWith('admin@');
    const plan = isToby
      ? { impersonate: rowBox, from: TOBY, fromName: 'Nursery Manager', bcc: TOBY, threadId: isInbound ? (row.thread_id || undefined) : undefined }
      : { impersonate: gmail.COMMS_MAILBOX, from: undefined /* default info@ */, fromName: 'Your Nursery', bcc: rowBox || undefined, threadId: undefined };
    let threading = {};
    if (isInbound && row.message_id && !isToby && gmail.getThreadingHeaders) {
      threading = await gmail.getThreadingHeaders(rowBox, row.message_id);
    }
    let sent = false, sendInfo = '';
    try {
      if (gmail.isConfigured()) {
        const base = { to: recipient, subject, html, text: bodyText, impersonate: plan.impersonate,
                       from: plan.from, fromName: plan.fromName, bcc: plan.bcc, ...threading };
        let r;
        try {
          r = await gmail.sendViaGmail({ ...base, threadId: plan.threadId });
        } catch (te) {
          // A stale/foreign Gmail threadId must not block the reply — resend unthreaded.
          if (plan.threadId && /thread|not found/i.test(te.message || '')) {
            r = await gmail.sendViaGmail(base);
          } else { throw te; }
        }
        sent = !!(r && r.ok);
        sendInfo = r && r.messageId ? `gmail:${r.messageId}` : 'gmail';
      } else {
        sent = await sendEmail(recipient, subject, html, 'comms-reply');
        sendInfo = 'sendEmail';
      }
    } catch (e) {
      console.error('comms send-draft delivery error:', e.message);
      await db.query(
        `UPDATE comms_email_queue SET last_error=$2, send_attempts=COALESCE(send_attempts,0)+1 WHERE id=$1`,
        [row.id, e.message]
      ).catch(() => {});
      return res.status(502).json({ error: 'Send failed: ' + e.message });
    }

    if (!sent) {
      return res.status(502).json({ error: 'Send failed (no transport delivered the message)' });
    }

    // The email is already delivered — never let a post-send bookkeeping error
    // leave the row 'pending' (it would be re-sent). Mark sent; if the
    // handled_by FK fails (e.g. user not in staff), retry without it.
    let upd;
    try {
      ({ rows: upd } = await db.query(
        `UPDATE comms_email_queue
           SET status='sent', draft_text=$2, handled_at=NOW(), handled_by=$3, sent_at=NOW(),
               send_attempts=COALESCE(send_attempts,0)+1, last_error=NULL
         WHERE id=$1 RETURNING *`,
        [row.id, bodyText, req.user.id]
      ));
    } catch (ue) {
      ({ rows: upd } = await db.query(
        `UPDATE comms_email_queue
           SET status='sent', draft_text=$2, handled_at=NOW(), sent_at=NOW(),
               send_attempts=COALESCE(send_attempts,0)+1, last_error=NULL
         WHERE id=$1 RETURNING *`,
        [row.id, bodyText]
      ));
    }
    // b364 (2026-09-29): who pressed send, from which mailbox, and how long the
    // body was. Written HERE rather than by the client, so the audit row cannot
    // be skipped by a screen that forgets to report. No recipient address and no
    // body text — the domain and a character count answer "who sent what, when"
    // without this becoming a second copy of the correspondence. Which DRAFT went
    // out (Hermes as-is / edited / typed) is labelled afterwards by
    // POST /api/inbox-hermes/emails/:id/sent, which only refines this row.
    try {
      await db.query(
        `INSERT INTO inbox_reply_log (email_id, staff_id, mailbox, recipient_domain, draft_source, body_chars)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.id, req.user.id, row.mailbox || null,
         (recipient.split('@')[1] || null), 'unknown', String(bodyText).length]);
    } catch (e) { /* b364 tables not applied here — the send is unaffected */ }

    res.json({ ok: true, sent_to: recipient, via: sendInfo, email: upd[0] });
  } catch (err) {
    console.error('comms send-draft error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// b487 (2026-10-12): shared pre-check for edit-draft/ignore — the same
// confidential-mailbox guard, plus (EY callers only) the section/safeguarding
// permission check, so a caller cannot edit or ignore a row by id that the
// list would never have shown them.
//
// b486c (2026-10-13, CHECK.md defect 8): this used to key the EY content
// check off `req._portal === 'learning'` — so the IDENTICAL action from the HR
// portal (no comms deny there pre-b491) or from an EY `inbox_access`
// practitioner skipped isEyInboxEligible AND canSeeEmail entirely, because
// neither check is portal-specific, it is "does this person hold one of the
// handful of comms_manager_staff_ids Roost grants". Anyone who does not is
// checked here regardless of which portal's JWT they happen to be carrying.
async function _assertRowActionable(db, req, row) {
  const mboxGuard = await assertMailboxActionable(db, req.user, row.mailbox);
  if (!mboxGuard.ok) return mboxGuard;
  if (!(await isCommsManager(db, req.user.id))) {
    if (!inboxAccessLib.isEyInboxEligible(req.user)) {
      return { ok: false, status: 403, body: { error: 'forbidden', message: 'Ask a manager.' } };
    }
    const { rows: cardRows } = await db.query(
      'SELECT case_kind FROM inbox_intel_cards WHERE email_id=$1', [row.id]).catch(() => ({ rows: [] }));
    if (!(await eyInboxPerms.canSeeEmail(db, req.user, row, cardRows[0]))) {
      return { ok: false, status: 403, body: { error: 'forbidden', message: 'You do not have access to this email.' } };
    }
  }
  return { ok: true };
}

// POST /api/comms/emails/:id/edit-draft
router.post('/emails/:id/edit-draft', async (req, res) => {
  const { draft_text } = req.body;
  if (!draft_text) return res.status(400).json({ error: 'draft_text required' });
  const db = getPool();
  try {
    const { rows: cur } = await db.query('SELECT id, mailbox, section, subject, snippet, summary FROM comms_email_queue WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const guard = await _assertRowActionable(db, req, cur[0]);
    if (!guard.ok) return res.status(guard.status).json(guard.body);
    const { rows } = await db.query(
      `UPDATE comms_email_queue SET draft_text=$1 WHERE id=$2 RETURNING *`,
      [draft_text, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('comms edit-draft error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/emails/:id/ignore
router.post('/emails/:id/ignore', async (req, res) => {
  const db = getPool();
  try {
    const { rows: cur } = await db.query('SELECT id, mailbox, section, subject, snippet, summary FROM comms_email_queue WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const guard = await _assertRowActionable(db, req, cur[0]);
    if (!guard.ok) return res.status(guard.status).json(guard.body);
    const { rows } = await db.query(
      `UPDATE comms_email_queue
       SET status='ignored', handled_at=NOW(), handled_by=$1
       WHERE id=$2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('comms ignore error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/emails/:id/draft-retry — manual, immediate retry of one failed
// draft (bypasses the backoff wait). Same attemptDraft() the automatic sweep and
// the Draft replies job use — same fill rule, never overwrites draft_text or an
// existing suggested_draft.
router.post('/emails/:id/draft-retry', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT * FROM comms_email_queue WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];
    const allowed = await allowedMailboxes(db, req.user.id);
    if (!allowed.includes(row.mailbox)) return res.status(403).json({ error: 'No access to this mailbox' });

    const mode = await inboxHermes.draftMode(db);
    // b486c (2026-10-13, CHECK.md defect 7): Retry used to ignore "Off" and
    // draft anyway. Checked here, not inside attemptDraft(), because the
    // automatic retry sweep (retryFailedDrafts(), driven by the same mode)
    // already skips a row entirely when drafting is off — this route is the
    // one place that bypassed it.
    if (mode === 'off') {
      return res.status(409).json({ error: 'drafting_off', message: 'Drafting is turned off in Settings → Inbox.' });
    }
    // force:true (b486b, D1) — this is "manual, immediate retry" per the comment
    // above; a stale claim here is never a concurrent call of this same route
    // (the user only has one Retry button per email), so waiting out the 15-min
    // window would just mean a crash blocks the thing meant to recover from it.
    const result = await inboxHermes.attemptDraft(db, row, { staffId: req.user.id, summaryOnly: mode === 'summary_only', force: true });
    const { rows: fresh } = await db.query('SELECT * FROM comms_email_queue WHERE id=$1', [req.params.id]);
    res.json({
      ok: result.ok, attempts: result.attempts || 0, gave_up: !!result.gaveUp,
      reason: result.reason || null, email: fresh[0],
    });
  } catch (err) {
    console.error('comms draft-retry error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Inbox: resync, draft replies, drafting-optional settings (b486) ──────────
// All manager-only (isCommsManager — the same comms_manager_staff_ids list every
// other inbox action here is gated on), because Resync hits the Gmail API across
// every polled mailbox and Draft replies is minutes of Ascent time.

// GET /api/comms/inbox/status — "Last synced hh:mm · N new" + current drafting mode.
router.get('/inbox/status', async (req, res) => {
  const db = getPool();
  try {
    if (!(await isCommsManager(db, req.user.id))) return res.status(403).json({ error: 'Manager only' });
    const last = gmailPoller.getLastPollInfo();
    const mode = await inboxHermes.draftMode(db);
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='inbox_card_timeout_s'`);
    const timeoutS = parseInt(rows[0]?.value, 10) || 300;
    res.json({
      last_synced_at: last ? last.at : null, last_poll: last,
      draft_mode: mode, draft_timeout_s: timeoutS,
      draft_job: inboxDraftJob.status(),
    });
  } catch (err) {
    console.error('comms inbox status error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/inbox/resync — starts the existing poll-once path (plus the
// reply-elsewhere reconcile it already does at the end of pollInbox()) and
// returns immediately. b486b (2026-10-12, D2): this used to await pollInbox()
// and answer with its result — nginx's /api/ location has no proxy_read_timeout
// (60s default), and a poll with new mail (classify + section + Hermes card
// calls, each up to minutes on a struggling Ascent) regularly exceeds that, so
// Resync showed "Resync failed" while the poll kept running fine underneath.
// The UI now polls GET /inbox/status until last_synced_at moves. pollInbox()
// itself joins an in-flight run (see gmail-inbox-poller.js) rather than starting
// a second one, so firing Resync while the 8-minute interval poll is mid-run is
// free, not a duplicate poll.
router.post('/inbox/resync', async (req, res) => {
  const db = getPool();
  try {
    if (!(await isCommsManager(db, req.user.id))) return res.status(403).json({ error: 'Manager only' });
    gmailPoller.pollInbox().catch(e => console.error('comms inbox resync (background) error:', e.message));
    res.status(202).json({ ok: true, started: true });
  } catch (err) {
    console.error('comms inbox resync error:', err.message);
    res.status(500).json({ error: 'Resync failed: ' + err.message });
  }
});

// POST /api/comms/inbox/draft-replies — start the background catch-up job.
// 202 + the job snapshot if it just started; 409 + the running job if one from
// another manager (or tab) is already going, so the UI can attach to it instead
// of starting a second one.
router.post('/inbox/draft-replies', async (req, res) => {
  const db = getPool();
  try {
    if (!(await isCommsManager(db, req.user.id))) return res.status(403).json({ error: 'Manager only' });
    // b486c (2026-10-13, CHECK.md defect 7): "Off" used to be ignored here too
    // — the button drafted up to 200 full replies regardless of the setting.
    const mode = await inboxHermes.draftMode(db);
    if (mode === 'off') {
      return res.status(409).json({ error: 'drafting_off', message: 'Drafting is turned off in Settings → Inbox.' });
    }
    if (inboxDraftJob.status().running) {
      return res.status(409).json({ error: 'already_running', job: inboxDraftJob.status() });
    }
    const allowed = await allowedMailboxes(db, req.user.id);
    if (!allowed.length) return res.status(403).json({ error: 'No mailbox access' });
    inboxDraftJob.run(db, { mailboxes: allowed, staffId: req.user.id, summaryOnly: mode === 'summary_only' })
      .catch(e => console.error('comms draft-replies job error:', e.message));
    res.status(202).json({ started: true, job: inboxDraftJob.status() });
  } catch (err) {
    console.error('comms draft-replies start error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/comms/inbox/draft-replies/status — poll for live progress.
router.get('/inbox/draft-replies/status', async (req, res) => {
  const db = getPool();
  try {
    if (!(await isCommsManager(db, req.user.id))) return res.status(403).json({ error: 'Manager only' });
    res.json(inboxDraftJob.status());
  } catch (err) {
    console.error('comms draft-replies status error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET/PUT /api/comms/inbox/settings — the drafting-optional 3-way mode + the
// configurable card timeout. PUT only ever touches the keys it was sent.
router.get('/inbox/settings', async (req, res) => {
  const db = getPool();
  try {
    if (!(await isCommsManager(db, req.user.id))) return res.status(403).json({ error: 'Manager only' });
    const mode = await inboxHermes.draftMode(db);
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='inbox_card_timeout_s'`);
    res.json({ mode, timeout_s: parseInt(rows[0]?.value, 10) || 300 });
  } catch (err) {
    console.error('comms inbox settings get error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

router.put('/inbox/settings', async (req, res) => {
  const db = getPool();
  try {
    if (!(await isCommsManager(db, req.user.id))) return res.status(403).json({ error: 'Manager only' });
    const { mode, timeout_s } = req.body || {};

    // b486b (2026-10-12, D3): validate EVERYTHING in the request before writing
    // ANYTHING. This used to validate+write mode, then validate timeout_s — so
    // {mode:'off', timeout_s:5} wrote mode (drafting off) before rejecting the
    // request for its bad timeout, and the Settings page (which always sends
    // both) showed "Could not save" while drafting had actually been turned off.
    if (mode !== undefined && !['full', 'summary_only', 'off'].includes(mode)) {
      return res.status(400).json({ error: 'invalid mode' });
    }
    let timeoutN;
    if (timeout_s !== undefined) {
      timeoutN = parseInt(timeout_s, 10);
      if (!Number.isFinite(timeoutN) || timeoutN < 30 || timeoutN > 900) {
        return res.status(400).json({ error: 'timeout_s must be 30-900' });
      }
    }

    if (mode !== undefined) {
      const autocards = mode !== 'off';
      const summaryOnly = mode === 'summary_only';
      await db.query(`INSERT INTO settings (key, value) VALUES ('inbox_hermes_autocards', $1)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(autocards)]);
      await db.query(`INSERT INTO settings (key, value) VALUES ('inbox_hermes_summary_only', $1)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(summaryOnly)]);
    }
    if (timeout_s !== undefined) {
      await db.query(`INSERT INTO settings (key, value) VALUES ('inbox_card_timeout_s', $1)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(timeoutN)]);
    }
    const freshMode = await inboxHermes.draftMode(db);
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='inbox_card_timeout_s'`);
    res.json({ mode: freshMode, timeout_s: parseInt(rows[0]?.value, 10) || 300 });
  } catch (err) {
    console.error('comms inbox settings put error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Messages ──────────────────────────────────────────────────────────────────

// GET /api/comms/messages?child_id&staff_id&search&page
router.get('/messages', async (req, res) => {
  const db = getPool();
  try {
    const { child_id, staff_id, search, page = 1 } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;
    const params = [];
    const conditions = ["(t.recipient_type != 'staff_group' OR t.recipient_type IS NULL)"];

    if (child_id) {
      params.push(parseInt(child_id));
      conditions.push(`t.child_id = $${params.length}`);
    }
    if (staff_id) {
      params.push(parseInt(staff_id));
      conditions.push(`t.recipient_staff_id = $${params.length}`);
    }
    if (search) {
      params.push('%' + search + '%');
      conditions.push(`(t.subject ILIKE $${params.length} OR c.first_name ILIKE $${params.length} OR c.last_name ILIKE $${params.length})`);
    }

    const where = 'WHERE ' + conditions.join(' AND ');
    params.push(limit);
    params.push(offset);

    const { rows } = await db.query(
      `SELECT t.id, t.subject, t.last_message_at, t.created_at, t.recipient_type,
              c.first_name || ' ' || c.last_name AS child_name, c.id AS child_id,
              s.first_name || ' ' || s.last_name AS assigned_staff,
              (SELECT COUNT(*) FROM messages m
               WHERE m.thread_id=t.id AND m.is_read=false AND m.sender_type='parent') AS unread_count,
              (SELECT body FROM messages m2
               WHERE m2.thread_id=t.id ORDER BY m2.created_at DESC LIMIT 1) AS last_body,
              (SELECT sender_type FROM messages m3
               WHERE m3.thread_id=t.id ORDER BY m3.created_at DESC LIMIT 1) AS last_sender_type
       FROM message_threads t
       LEFT JOIN children c ON c.id = t.child_id
       LEFT JOIN staff s ON s.id = t.recipient_staff_id
       ${where}
       ORDER BY t.last_message_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total
       FROM message_threads t
       LEFT JOIN children c ON c.id = t.child_id
       ${where}`,
      countParams
    );

    res.json({ threads: rows, total: parseInt(countRows[0].total), page: parseInt(page), limit });
  } catch (err) {
    console.error('comms messages error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/comms/messages/:thread_id
router.get('/messages/:thread_id', async (req, res) => {
  const db = getPool();
  try {
    const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.thread_id]);
    if (!threads.length) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(
      `SELECT m.*, s.first_name || ' ' || s.last_name AS staff_name
       FROM messages m LEFT JOIN staff s ON s.id = m.sender_id
       WHERE m.thread_id=$1 ORDER BY m.created_at ASC`,
      [req.params.thread_id]
    );
    await db.query(
      `UPDATE messages SET is_read=true WHERE thread_id=$1 AND sender_type='parent'`,
      [req.params.thread_id]
    );
    res.json({ thread: threads[0], messages: rows });
  } catch (err) {
    console.error('comms thread error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/messages — create new outbound message thread
router.post('/messages', async (req, res) => {
  const { child_id, subject, body } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  const db = getPool();
  try {
    const { rows: threads } = await db.query(
      `INSERT INTO message_threads (child_id, subject, last_message_at)
       VALUES ($1, $2, NOW()) RETURNING *`,
      [child_id || null, subject || 'Message from nursery']
    );
    const thread = threads[0];
    const { rows: msgs } = await db.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body)
       VALUES ($1,'staff',$2,$3) RETURNING *`,
      [thread.id, req.user.id, body]
    );
    res.json({ thread, message: msgs[0] });
  } catch (err) {
    console.error('comms new message error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/messages/:thread_id/reply
router.post('/messages/:thread_id/reply', async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  const db = getPool();
  try {
    const { rows: threads } = await db.query('SELECT * FROM message_threads WHERE id=$1', [req.params.thread_id]);
    if (!threads.length) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body)
       VALUES ($1,'staff',$2,$3) RETURNING *`,
      [req.params.thread_id, req.user.id, body]
    );
    await db.query('UPDATE message_threads SET last_message_at=NOW() WHERE id=$1', [req.params.thread_id]);
    res.json(rows[0]);
  } catch (err) {
    console.error('comms reply error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Manager notes — the three-manager shared board ───────────────────────────
// Scoped to whoever is on comms_manager_staff_ids (same list as mailbox
// access) — deliberately NOT the private Obsidian vault at /api/cockpit/notes,
// which is single-user and unattributed. This one is attributed by design.

// GET /api/comms/notes
router.get('/notes', async (req, res) => {
  const db = getPool();
  try {
    if (!(await isCommsManager(db, req.user.id))) return res.status(403).json({ error: 'Manager only' });
    const { rows } = await db.query(
      `SELECT n.*, s.first_name || ' ' || s.last_name AS author_name
       FROM manager_notes n JOIN staff s ON s.id = n.author_staff_id
       ORDER BY n.pinned DESC, n.created_at DESC LIMIT 200`);
    res.json({ notes: rows });
  } catch (err) {
    console.error('comms notes list error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/comms/notes
router.post('/notes', async (req, res) => {
  const db = getPool();
  try {
    if (!(await isCommsManager(db, req.user.id))) return res.status(403).json({ error: 'Manager only' });
    const { body, related_email_id, related_task_id } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body required' });
    const { rows } = await db.query(
      `INSERT INTO manager_notes (author_staff_id, body, related_email_id, related_task_id)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, String(body).trim().slice(0, 4000), related_email_id || null, related_task_id || null]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('comms notes create error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// PATCH /api/comms/notes/:id — pin/unpin only (the body is not editable once posted).
router.patch('/notes/:id', async (req, res) => {
  const db = getPool();
  try {
    if (!(await isCommsManager(db, req.user.id))) return res.status(403).json({ error: 'Manager only' });
    const { pinned } = req.body || {};
    const { rows } = await db.query(
      `UPDATE manager_notes SET pinned=$1 WHERE id=$2 RETURNING *`, [!!pinned, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('comms notes patch error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// DELETE /api/comms/notes/:id — the author, or Toby, may delete.
router.delete('/notes/:id', async (req, res) => {
  const db = getPool();
  try {
    if (!(await isCommsManager(db, req.user.id))) return res.status(403).json({ error: 'Manager only' });
    const { rows: cur } = await db.query('SELECT author_staff_id FROM manager_notes WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    if (Number(cur[0].author_staff_id) !== Number(req.user.id) && Number(req.user.id) !== 1) {
      return res.status(403).json({ error: 'Only the author or Toby can delete a note' });
    }
    await db.query('DELETE FROM manager_notes WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('comms notes delete error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// b532 (2026-10-28) — GET /api/comms/child-emails?child_id= — the emails the Inbox holds for
// one child's family, for the child profile's Messages tab. Managers only (same as /messages),
// and only mailboxes this user may read in the Inbox. Read-only; nothing is fetched or sent.
router.get('/child-emails', commsManagersOnly, async (req, res) => {
  const childId = parseInt(req.query.child_id, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    const allowed = await allowedMailboxes(db, req.user.id);
    const out = await require('../lib/child-emails').childEmails(db, childId, allowed);
    res.json(out);
  } catch (e) {
    console.error('[comms] child-emails:', e.message);
    res.status(500).json({ error: 'Could not load emails' });
  }
});

// b534 (2026-10-28) — family details + relationship notes pulled from the Inbox by
// scripts/family-context-from-email.js (local model only — see that file). Managers
// only, same guard as /child-emails: these notes can carry sensitive family context
// (fee disputes, complaints) that a practitioner should not read on the profile.
const FAMILY_NOTE_ID_COLS = { child_id: 'child_id', enquiry_id: 'enquiry_id', waiting_list_id: 'waiting_list_id' };
const FAMILY_FILL_COLUMNS = {
  children: ['parent_1_phone', 'parent_2_phone', 'parent_2_email', 'address_line1', 'address_line2', 'postcode', 'town'],
  enquiries: ['parent_phone'],
  waiting_list: ['parent_phone'],
};

// GET /api/comms/family-notes?child_id=  (or ?enquiry_id= / ?waiting_list_id=)
router.get('/family-notes', commsManagersOnly, async (req, res) => {
  const idCol = Object.keys(FAMILY_NOTE_ID_COLS).find((k) => req.query[k] !== undefined);
  const id = idCol ? parseInt(req.query[idCol], 10) : NaN;
  if (!idCol || !Number.isInteger(id)) {
    return res.status(400).json({ error: 'child_id, enquiry_id or waiting_list_id required' });
  }
  try {
    const db = getPool();
    const { rows: notes } = await db.query(
      `SELECT * FROM family_comms_notes WHERE ${idCol} = $1`, [id]);
    const target = idCol === 'child_id' ? 'children' : idCol === 'enquiry_id' ? 'enquiries' : 'waiting_list';
    const { rows: fills } = await db.query(
      `SELECT * FROM family_detail_fills WHERE target_table = $1 AND target_id = $2 ORDER BY filled_at DESC`,
      [target, id]);
    res.json({ note: notes[0] || null, fills });
  } catch (e) {
    console.error('[comms] family-notes get:', e.message);
    res.status(500).json({ error: 'Could not load family notes' });
  }
});

// PUT /api/comms/family-notes/:id — edit the note. :id === 'new' creates one (body
// must carry child_id/enquiry_id/waiting_list_id). An edit is never overwritten by a
// later run of scripts/family-context-from-email.js (edited_at is set here).
router.put('/family-notes/:id', commsManagersOnly, async (req, res) => {
  const note = String(req.body?.note || '').slice(0, 4000);
  const important = Array.isArray(req.body?.important) ? req.body.important.slice(0, 20) : undefined;
  try {
    const db = getPool();
    if (req.params.id === 'new') {
      const idCol = Object.keys(FAMILY_NOTE_ID_COLS).find((k) => req.body?.[k] !== undefined);
      const id = idCol ? parseInt(req.body[idCol], 10) : NaN;
      if (!idCol || !Number.isInteger(id)) {
        return res.status(400).json({ error: 'child_id, enquiry_id or waiting_list_id required' });
      }
      const { rows } = await db.query(
        `INSERT INTO family_comms_notes (${idCol}, note, important, edited_by, edited_at, updated_at)
         VALUES ($1, $2, COALESCE($3::jsonb, '[]'::jsonb), $4, now(), now())
         ON CONFLICT (${idCol}) WHERE ${idCol} IS NOT NULL
         DO UPDATE SET note = EXCLUDED.note,
                       important = COALESCE($3::jsonb, family_comms_notes.important),
                       edited_by = EXCLUDED.edited_by, edited_at = now(), updated_at = now()
         RETURNING *`,
        [id, note, important ? JSON.stringify(important) : null, req.user.id]);
      return res.json({ note: rows[0] });
    }
    const noteId = parseInt(req.params.id, 10);
    if (!Number.isInteger(noteId)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await db.query(
      `UPDATE family_comms_notes
          SET note = $1, important = COALESCE($2::jsonb, important), edited_by = $3, edited_at = now(), updated_at = now()
        WHERE id = $4 RETURNING *`,
      [note, important ? JSON.stringify(important) : null, req.user.id, noteId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ note: rows[0] });
  } catch (e) {
    console.error('[comms] family-notes put:', e.message);
    res.status(500).json({ error: 'Could not save note' });
  }
});

// POST /api/comms/family-fills/:id/undo — revert one field this tool filled in, back
// to empty. Only reverts if the field still holds exactly the value this fill wrote
// (so it can't clobber something a person typed in afterwards).
router.post('/family-fills/:id/undo', commsManagersOnly, async (req, res) => {
  const fillId = parseInt(req.params.id, 10);
  if (!Number.isInteger(fillId)) return res.status(400).json({ error: 'invalid id' });
  try {
    const db = getPool();
    const { rows: cur } = await db.query('SELECT * FROM family_detail_fills WHERE id=$1', [fillId]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const fill = cur[0];
    if (fill.undone_at) return res.status(409).json({ error: 'Already undone' });
    const allowedCols = FAMILY_FILL_COLUMNS[fill.target_table];
    if (!allowedCols || !allowedCols.includes(fill.target_column)) {
      return res.status(400).json({ error: 'Unknown fill target' });
    }
    const { rowCount } = await db.query(
      `UPDATE ${fill.target_table} SET ${fill.target_column} = NULL WHERE id = $1 AND ${fill.target_column} = $2`,
      [fill.target_id, fill.value]);
    await db.query('UPDATE family_detail_fills SET undone_at = now(), undone_by = $1 WHERE id = $2',
      [req.user.id, fillId]);
    res.json({ ok: true, reverted: rowCount > 0 });
  } catch (e) {
    console.error('[comms] family-fills undo:', e.message);
    res.status(500).json({ error: 'Could not undo' });
  }
});

module.exports = router;
