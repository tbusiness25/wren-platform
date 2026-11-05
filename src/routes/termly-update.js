'use strict';
/**
 * termly-update.js — b246 (2026-08-28). Mounted at /api/termly-update.
 *
 * The termly update a keyperson fills in and a parent reads: five sections,
 * scheduled on Ealing's half-terms, and never reaching a family without a named
 * practitioner approving it.
 *
 * ── WHERE THE DOCUMENT LIVES ────────────────────────────────────────────────
 * ladn.reports, report_type='termly_update', cycle_key='2026-2027/autumn-1'.
 * NOT a new table. It reuses b243's workflow columns (status / assigned_staff_id
 * / sent_at / updated_at), b244's lifecycle_status, shared_with_parents, and the
 * b238 PDF pipeline — so a termly update appears on the reports screen, in the
 * parents app and in the PDF cache exactly like every other report, and b244's
 * "Reports due" board is the only place that chases it.
 *
 * The pre-b246 marker is untouched: a practitioner who writes a termly update
 * the old way, by flagging an observation, still satisfies the cycle. See
 * src/services/termly-status.js, which now counts BOTH.
 *
 * ── WHY THERE IS NO NIGHTLY JOB ─────────────────────────────────────────────
 * b93's engine wrote 63 drafts nobody ever finalised and its toggles were turned
 * off on the morning of 2026-08-28. There is deliberately no cron here, no
 * "draft everything due" endpoint, and no way to produce a document without a
 * practitioner opening a child. The schedule chases a PERSON; the person writes.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Child developmental records by name. Same class as /api/reports,
 * /api/two-year-check and /api/report-cycle: staff session required, and the
 * mount is listed in server-unified.js's PARENT_DENY / HR_DENY / on-site /
 * off-site sets alongside them.
 *
 * Within that, the gate is the RELATIONSHIP, not a capability — the same
 * reasoning as b243. On prod `reports.send-to-parents` is granted at level
 * 'view' to `practitioner`, and hasCapability ignores the level (see
 * memory/reference_hascapability_ignores_level.md), so gating on it would be
 * both too loose for strangers and, if tightened, would 403 the key person who
 * has to write the thing. You may read, edit and send an update if you are the
 * assigned staff member, the child's key person, or manager-level.
 */

const express = require('express');
const fsp = require('fs').promises;
const nodePath = require('path');

const router = express.Router();

const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');
const { renderReportPdf, reportFilename } = require('../lib/report-pdf');
const TU = require('../lib/termly-update');
const TC = require('../lib/termly-cycle');

let resolveRoomLeader;
try { ({ resolveRoomLeader } = require('../lib/offratio')); } catch (_) { resolveRoomLeader = null; }

// One cache directory, the same one src/routes/reports.js and b243 use.
const REPORTS_PDF_DIR = process.env.REPORTS_PDF_DIR
  || nodePath.join(process.env.UPLOAD_ROOT || '/app/uploads', 'reports');

const REPORT_TYPE = 'termly_update';
const OPEN_STATUSES = ['drafting', 'awaiting_review'];
const MANAGER_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager']);
const LEAD_ROLES = new Set([...MANAGER_ROLES, 'room_leader', 'senior_practitioner']);
const isManager = u => !!(u && MANAGER_ROLES.has(u.role));
const isLead = u => !!(u && LEAD_ROLES.has(u.role));

/* b404-C (Toby, 17 Oct 2026) — "termly updates are reviewed by Room Leaders: it's
 * their responsibility that their staff do things on time." A room leader (or a
 * manager / deputy) approves BEFORE a family sees a termly update. The key person
 * writes it and sends it to the room leader (POST /:id/submit); only an approver
 * can POST /:id/send. The termly watcher never shares on its own any more
 * (src/services/termly-watcher.js). */
function mayApprove(user, row) {
  if (!user) return false;
  if (isManager(user)) return true;
  if (user.role !== 'room_leader') return false;
  // A room leader approves for their own room. When either room is unknown (a
  // leader with no room set, a child with none) don't strand the update: any
  // room leader may — the audit trail records who approved.
  if (!user._room_id || !row || !row.room_id) return true;
  return Number(user._room_id) === Number(row.room_id);
}
/** Problems the writer must fix. The name/role signature is the APPROVER's, so
 *  it is only asked of someone who can approve. */
function problemsFor(user, row, content) {
  return mayApprove(user, row)
    ? TU.sendProblems(content)
    : TU.sendProblems(Object.assign({}, content, { approved_by: { name: '-', role: '-' } }));
}

function requireEyfsEdition(req, res, next) {
  if (!TU.isEyfsEdition()) {
    return res.status(404).json({ error: 'Progress updates apply to early years settings only.' });
  }
  next();
}

router.use(requireEyfsEdition);
router.use(authenticate);
// b404-C — a room leader's room, read once per request, so mayHandle()/mayApprove()
// can stay synchronous. Never throws: a failure just leaves _room_id unset.
router.use(async (req, _res, next) => {
  try {
    if (req.user && req.user.role === 'room_leader' && req.user._room_id === undefined) {
      const { rows } = await getPool().query('SELECT room_id FROM staff WHERE id = $1', [req.user.id]);
      req.user._room_id = rows[0] ? rows[0].room_id : null;
    }
  } catch (_) { /* leave unset */ }
  next();
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
const onParam = req => (/^\d{4}-\d{2}-\d{2}$/.test(req.query.on || '') ? req.query.on : null);

async function settingHeader(db) {
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key IN ('nursery_name','setting_name','nursery_address')`);
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return { name: m.nursery_name || m.setting_name || 'Your Nursery',
             address: m.nursery_address || '' };
  } catch { return { name: 'Your Nursery', address: '' }; }
}

/** One update plus everything needed to render or gate it. */
async function loadUpdate(db, id) {
  const { rows } = await db.query(`
    SELECT r.*,
           c.first_name, c.last_name, c.preferred_name, c.date_of_birth,
           c.key_person_id, c.room_id, c.start_date, c.leave_date,
           c.first_name || ' ' || c.last_name AS child_name,
           rm.name AS room_name,
           s.first_name || ' ' || s.last_name AS author_name,
           a.first_name || ' ' || a.last_name AS assigned_name,
           a.role AS assigned_role
      FROM reports r
      JOIN children c    ON c.id = r.child_id
      LEFT JOIN rooms rm ON rm.id = c.room_id
      LEFT JOIN staff s  ON s.id = r.staff_id
      LEFT JOIN staff a  ON a.id = r.assigned_staff_id
     WHERE r.id = $1 AND r.report_type = $2`, [id, REPORT_TYPE]);
  return rows[0] || null;
}

function mayHandle(user, row) {
  if (!user || !row) return false;
  if (isManager(user)) return true;
  if (Number(row.assigned_staff_id) === Number(user.id)) return true;
  if (Number(row.key_person_id) === Number(user.id)) return true;
  // b404-C — the room leader of the child's room reads, edits and approves.
  if (user.role === 'room_leader' && user._room_id && row.room_id
      && Number(user._room_id) === Number(row.room_id)) return true;
  return false;
}

const parseContent = v => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : (v || {}));

/** Key person; failing that the room lead; failing that the managers. */
async function routeTo(db, child) {
  if (child.key_person_id) return { staff_id: child.key_person_id, via: 'key_person', reason: null };
  if (resolveRoomLeader && child.room_id) {
    try {
      const lead = await resolveRoomLeader(db, child.room_id);
      if (lead) return { staff_id: lead.id, via: 'room_lead',
        reason: `${child.first_name || 'This child'} has no key person, so this update has come to you as the room lead.` };
    } catch (_) { /* fall through */ }
  }
  return { staff_id: null, via: 'managers',
    reason: 'This child has no key person and no room lead could be identified, so the update has gone to the management team.' };
}

/**
 * The row as the PDF renderer wants it: parent-facing sections only, citations
 * stripped, a real title rather than titleCase('termly_update').
 */
function renderable(row) {
  const content = parseContent(row.content);
  if (content.kind !== 'termly_update') {
    // Not one of ours — an imported document that happens to share the type.
    // Hand it back untouched so b238's own shape-flattening deals with it.
    return Object.assign({}, row, { display_title: 'Progress Update' });
  }
  const signed = content.approved_by || null;
  const author = signed && signed.name
    ? `${signed.name}${signed.role ? ', ' + signed.role : ''}`
    : row.author_name;
  const title = content.cycle && content.cycle.label
    ? `Progress Update — ${content.cycle.label}` : 'Progress Update';
  return Object.assign({}, row, {
    display_title: title,
    author_name: author,
    content: { sections: TU.printableSections(content) },
  });
}

/** Render, cache to disk, record on the row. Mirrors b238/b243. */
async function writePdf(db, row) {
  if (row.source === 'eylog' && row.pdf_path) {
    const abs = nodePath.resolve(REPORTS_PDF_DIR, nodePath.basename(row.pdf_path));
    return fsp.readFile(abs);
  }
  const setting = await settingHeader(db);
  const buf = await renderReportPdf(renderable(row), setting);
  const stored = `report-${row.id}.pdf`;
  try {
    await fsp.mkdir(REPORTS_PDF_DIR, { recursive: true });
    await fsp.writeFile(nodePath.join(REPORTS_PDF_DIR, stored), buf);
    await db.query(
      `UPDATE reports SET pdf_path=$2, pdf_generated_at=now(), pdf_bytes=$3,
                          source=COALESCE(source,'wren')
        WHERE id=$1`, [row.id, stored, buf.length]);
  } catch (e) {
    console.error('[b246] could not cache update PDF', row.id, e.message);
  }
  return buf;
}

// ── The drafting job ─────────────────────────────────────────────────────────
// In-process and fire-and-forget, like b243: the practitioner gets the row back
// immediately and the model takes as long as it takes. The in-flight set stops a
// double-tap starting two runs against the same row.
const _drafting = new Set();

/* b359 (2026-09-29) — runDraft gained an options bag so ONE drafting path can
 * serve both b246's per-child button and b359's per-key-person run. Called with
 * no second argument it does exactly what it did before, line for line:
 *
 *   opts.evidence   → TU.gatherEvidence  (b359 passes { allHistory, historyLimit })
 *   opts.draft      → TU.buildDraft      (b359 passes { redactor, onPrompt })
 *   opts.afterDraft → hook run with the finished content BEFORE it is stored,
 *                     so b359 can attach the card/activity suggestions without
 *                     a second UPDATE and without a half-written row ever
 *                     existing
 *   opts.notify     → false suppresses the per-child notification. Twenty
 *                     children is twenty bells otherwise, and b359 rings once
 *                     for the run.
 *
 * It now RETURNS a small result object. Nothing read the old undefined. */
async function runDraft(reportId, opts = {}) {
  if (_drafting.has(reportId)) return { ok: false, reason: 'already_drafting' };
  _drafting.add(reportId);
  const db = getPool();
  try {
    const row = await loadUpdate(db, reportId);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'drafting') return { ok: false, reason: 'not_drafting', status: row.status };

    const { cycles, config } = await TC.loadCycles(db);
    const cycle = TC.cycleByKey(cycles, row.cycle_key);
    if (!cycle) throw new Error(`the term calendar no longer has a half-term for ${row.cycle_key}`);

    const ev = await TU.gatherEvidence(db, row.child_id, cycle, opts.evidence || {});
    const content = await TU.buildDraft(ev, opts.draft || {});
    if (typeof opts.afterDraft === 'function') {
      await opts.afterDraft({ db, row, cycle, ev, content });
    }
    const dest = await routeTo(db, row);
    content.routing = dest;
    content.config = { due_weeks: config.due_weeks, overdue_weeks: config.overdue_weeks,
                       min_days: config.min_days, anchor: config.anchor };

    await db.query(`
      UPDATE reports
         SET content = $2, status = 'awaiting_review', assigned_staff_id = COALESCE(assigned_staff_id, $3),
             ai_generated = true, lifecycle_status = 'draft', updated_at = now()
       WHERE id = $1`, [reportId, JSON.stringify(content), dest.staff_id]);

    const childName = `${row.first_name || ''} ${row.last_name || ''}`.trim();
    const target = row.assigned_staff_id || dest.staff_id;
    const title = `Progress update ready to review — ${childName}`;
    const body = [
      `Wren has drafted ${childName}'s ${cycle.label} progress update from their own records.`,
      'Read it, add the next steps and the cards you want to use, then approve and send it.',
      dest.reason,
    ].filter(Boolean).join(' ');
    const link = `/ey/termly-update?id=${reportId}`;
    if (opts.notify === false) {
      // b359 — the run tells the key person once, about all of them.
    } else if (target) {
      notify('termly_update_draft', 'staff', target, title, body,
        { priority: 'normal', relatedTable: 'children', relatedId: row.child_id, link });
    } else {
      notify('termly_update_draft', 'all-managers', null, title, body,
        { priority: 'normal', relatedTable: 'children', relatedId: row.child_id, link });
    }
    return { ok: true, id: reportId, child_id: row.child_id, content };
  } catch (e) {
    console.error('[b246] draft failed for report', reportId, e.message);
    // Never leave an update stuck in 'drafting'. Put it in front of the person it
    // belongs to, with the failure written down.
    try {
      await db.query(`
        UPDATE reports
           SET status='awaiting_review',
               content = COALESCE(content,'{}'::jsonb) ||
                         jsonb_build_object('draft_error', $2::text, 'kind', 'termly_update'),
               updated_at = now()
         WHERE id=$1 AND status='drafting'`, [reportId, e.message]);
    } catch (e2) { console.error('[b246] could not record draft failure', e2.message); }
    return { ok: false, reason: 'draft_failed', error: e.message, id: reportId };
  } finally {
    _drafting.delete(reportId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /cycle — the schedule, straight off Ealing's dates
// ═══════════════════════════════════════════════════════════════════════════
router.get('/cycle', async (req, res) => {
  try {
    const db = getPool();
    const { cycles, config, terms } = await TC.loadCycles(db);
    const on = onParam(req) || TC.ymd(new Date());
    const current = TC.currentCycle(cycles, on);
    const next = TC.nextCycle(cycles, on);
    res.json({
      on,
      config,
      current, next,
      // Said out loud rather than logged: an exhausted calendar produces an empty
      // board, which reads exactly like a board with nothing outstanding.
      calendar: TC.calendarHealth(cycles, on),
      source: terms.length ? (terms[0].source || null) : null,
      cycles: cycles.map(c => ({
        key: c.key, label: c.label, name: c.name, academic_year: c.academic_year,
        term_start: c.term_start, term_end: c.term_end,
        opens_on: c.opens_on, due_on: c.due_on, overdue_on: c.overdue_on,
        reviews: c.reviews, closures: c.closures,
      })),
      sections: TU.SECTIONS.map(s => ({ key: s.key, heading: s.heading, modelled: s.modelled })),
    });
  } catch (e) {
    console.error('termly-update cycle:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /queue — who is owed one, and where each has got to
// ═══════════════════════════════════════════════════════════════════════════
/**
 * A lead sees the setting (optionally ?mine=1 or ?key_person_id=). Anyone else
 * sees their own key children and nothing else — not their room. The board's job
 * is "what do *I* owe", which is the same rule /api/report-cycle applies, so the
 * two surfaces cannot disagree about who may see whom.
 */
router.get('/queue', async (req, res) => {
  try {
    const db = getPool();
    const on = onParam(req) || TC.ymd(new Date());
    const { cycles, config } = await TC.loadCycles(db);
    const cycle = req.query.cycle_key
      ? TC.cycleByKey(cycles, String(req.query.cycle_key))
      : TC.currentCycle(cycles, on);

    const params = [];
    const conds = ['c.is_active = true'];
    if (!isLead(req.user)) {
      params.push(req.user.id); conds.push(`c.key_person_id = $${params.length}`);
    } else if (req.query.mine === '1') {
      params.push(req.user.id); conds.push(`c.key_person_id = $${params.length}`);
    } else if (/^\d+$/.test(req.query.key_person_id || '')) {
      params.push(parseInt(req.query.key_person_id, 10)); conds.push(`c.key_person_id = $${params.length}`);
    }
    if (/^\d+$/.test(req.query.room_id || '')) {
      params.push(parseInt(req.query.room_id, 10)); conds.push(`c.room_id = $${params.length}`);
    }

    // The child list, their last termly update from EITHER source, and the b246
    // document for this cycle if one has been started. One query rather than
    // three round trips per child.
    params.push(cycle ? cycle.key : null);
    const cycleParam = `$${params.length}`;
    const { rows } = await db.query(`
      SELECT c.id AS child_id, c.first_name, c.last_name, c.preferred_name,
             c.room_id, c.key_person_id,
             to_char(c.start_date,'YYYY-MM-DD') AS start_date,
             to_char(c.leave_date,'YYYY-MM-DD') AS leave_date,
             rm.name AS room_name,
             kp.first_name || ' ' || kp.last_name AS key_person_name,
             obs.last_obs_date, obs.last_obs_id,
             doc.id AS report_id, doc.status AS report_status,
             to_char(doc.sent_at,'YYYY-MM-DD') AS report_sent_on,
             doc.assigned_staff_id, doc.approval_state,
             a.first_name || ' ' || a.last_name AS assigned_name,
             sent.last_sent_date
        FROM children c
        LEFT JOIN rooms rm ON rm.id = c.room_id
        LEFT JOIN staff kp ON kp.id = c.key_person_id
        LEFT JOIN LATERAL (
          SELECT to_char(o.created_at,'YYYY-MM-DD') AS last_obs_date, o.id AS last_obs_id
            FROM observations o
           WHERE o.child_id = c.id AND o.termly_update = true
           ORDER BY o.created_at DESC LIMIT 1) obs ON true
        LEFT JOIN LATERAL (
          SELECT r.id, r.status, r.sent_at, r.assigned_staff_id,
                 r.content->'approval'->>'state' AS approval_state
            FROM reports r
           WHERE r.child_id = c.id AND r.report_type = 'termly_update'
             AND r.cycle_key = ${cycleParam}
           ORDER BY r.id DESC LIMIT 1) doc ON true
        LEFT JOIN LATERAL (
          SELECT to_char(MAX(r2.sent_at),'YYYY-MM-DD') AS last_sent_date
            FROM reports r2
           WHERE r2.child_id = c.id AND r2.report_type = 'termly_update'
             AND r2.sent_at IS NOT NULL) sent ON true
        LEFT JOIN staff a ON a.id = doc.assigned_staff_id
       WHERE ${conds.join(' AND ')}
       ORDER BY c.first_name, c.last_name
       LIMIT 400`, params);

    const counts = { done: 0, in_progress: 0, due: 0, overdue: 0, upcoming: 0, not_applicable: 0 };
    const children = rows.map(r => {
      // The cycle is satisfied by EITHER path: a sent b246 document, or the
      // pre-b246 observation flag. Whichever is later.
      const last = [r.last_obs_date, r.last_sent_date].filter(Boolean).sort().pop() || null;
      // …and a document written FOR this half-term satisfies it on any date it
      // was sent. Same rule as src/services/termly-status.js, and the reason is
      // the same: an update sent in the last week of the holiday for the term
      // that is about to start would otherwise leave the cycle looking open.
      const sentThisCycle = (r.report_id && r.report_status === 'sent') ? cycle.opens_on : null;
      const effective = [last, sentThisCycle].filter(Boolean).sort().pop() || null;
      const st = TC.statusFor(cycle, { start_date: r.start_date, leave_date: r.leave_date }, effective, on, config);
      // A draft in hand outranks "overdue": somebody is on it.
      if (r.report_id && r.report_status !== 'sent' && ['due', 'overdue', 'upcoming'].includes(st.state)) {
        st.state = 'in_progress';
      }
      counts[st.state] = (counts[st.state] || 0) + 1;
      return {
        child_id: r.child_id,
        name: [(r.preferred_name || r.first_name), r.last_name].filter(Boolean).join(' '),
        room_id: r.room_id, room_name: r.room_name,
        key_person_id: r.key_person_id, key_person_name: r.key_person_name,
        last_update: last,
        last_update_source: last && last === r.last_sent_date ? 'termly_update' : (last ? 'observation' : null),
        report_id: r.report_id || null,
        report_status: r.report_status || null,
        report_sent_on: r.report_sent_on || null,
        approval_state: r.approval_state || null,
        assigned_staff_id: r.assigned_staff_id || null,
        assigned_name: r.assigned_name || null,
        state: st.state, reason: st.reason, days_over: st.days_over,
      };
    });

    const ORDER = { overdue: 0, due: 1, in_progress: 2, upcoming: 3, done: 4, not_applicable: 5 };
    children.sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || a.name.localeCompare(b.name));

    res.json({
      on, cycle, config, counts, children,
      calendar: TC.calendarHealth(cycles, on),
    });
  } catch (e) {
    console.error('termly-update queue:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /child/:childId/start — open (or reopen) this child's update
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The ONLY way a termly update comes into existence. A practitioner opens a
 * child; the model then drafts from that child's records. There is no nightly
 * job and no bulk button — see the note at the top of this file.
 *
 * Idempotent by construction: reports_termly_update_cycle_uq makes one update per
 * child per cycle a database fact, and the ON CONFLICT below returns the existing
 * row rather than erroring. Three people opening the same child on the first
 * Monday of term get the same document.
 */
router.post('/child/:childId/start', async (req, res) => {
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'child id required' });
  try {
    const db = getPool();
    const { rows: kids } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.key_person_id, c.room_id,
             to_char(c.start_date,'YYYY-MM-DD') AS start_date,
             to_char(c.leave_date,'YYYY-MM-DD') AS leave_date
        FROM children c WHERE c.id = $1`, [childId]);
    if (!kids.length) return res.status(404).json({ error: 'Not found' });
    const child = kids[0];
    if (!isLead(req.user) && Number(child.key_person_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'This is not one of your key children.' });
    }

    const on = (req.body && /^\d{4}-\d{2}-\d{2}$/.test(req.body.on)) ? req.body.on : TC.ymd(new Date());
    const { cycles, config } = await TC.loadCycles(db);
    const wanted = (req.body && req.body.cycle_key) ? String(req.body.cycle_key) : null;
    const cycle = wanted ? TC.cycleByKey(cycles, wanted) : TC.currentCycle(cycles, on);
    if (!cycle) {
      return res.status(409).json({
        error: 'No termly-update cycle covers this date.',
        calendar: TC.calendarHealth(cycles, on),
      });
    }
    // A child not owed this cycle is not blocked from having one — a keyperson
    // may have a good reason — but the reason is recorded on the row so the
    // review screen can say why it exists out of turn.
    const owed = TC.owedBy(cycle, child, config);

    const dest = await routeTo(db, child);
    const { rows } = await db.query(`
      INSERT INTO reports (child_id, staff_id, report_type, cycle_key, status,
                           assigned_staff_id, lifecycle_status, ai_generated,
                           shared_with_parents, content, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'drafting', $5, 'draft', false, false, $6::jsonb, now(), now())
      ON CONFLICT (child_id, cycle_key) WHERE report_type = 'termly_update' AND cycle_key IS NOT NULL
        DO UPDATE SET updated_at = now()
      RETURNING id, status, cycle_key, (xmax = 0) AS inserted`,
      [childId, req.user.id, REPORT_TYPE, cycle.key, dest.staff_id,
       JSON.stringify({ kind: 'termly_update', version: 1, status_note: 'Gathering the records…',
                        cycle: { key: cycle.key, label: cycle.label },
                        out_of_turn: owed.owed ? null : owed.reason })]);

    const row = rows[0];
    if (row.inserted) setImmediate(() => runDraft(row.id));
    res.status(row.inserted ? 201 : 200).json({
      ok: true, id: row.id, status: row.status, cycle_key: row.cycle_key,
      created: !!row.inserted, cycle,
      out_of_turn: owed.owed ? null : owed.reason,
    });
  } catch (e) {
    console.error('termly-update start:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /:id — the draft, its evidence, its next steps and its tracking data
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const row = await loadUpdate(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, row)) {
      return res.status(403).json({ error: 'This update belongs to another key person' });
    }
    const content = parseContent(row.content);
    res.json({
      id: row.id,
      child_id: row.child_id,
      child_name: row.child_name,
      room_name: row.room_name,
      cycle_key: row.cycle_key,
      status: row.status,
      lifecycle_status: row.lifecycle_status,
      sent_at: row.sent_at,
      updated_at: row.updated_at,
      created_at: row.created_at,
      assigned_staff_id: row.assigned_staff_id,
      assigned_name: row.assigned_name,
      assigned_role: row.assigned_role ? TU.roleLabel(row.assigned_role) : null,
      shared_with_parents: row.shared_with_parents,
      has_pdf: !!row.pdf_generated_at,
      section_keys: TU.SECTION_KEYS,
      problems: row.status === 'sent' ? [] : problemsFor(req.user, row, content),
      can_approve: mayApprove(req.user, row),
      approval: content.approval || null,
      content,
    });
  } catch (e) {
    console.error('termly-update get:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PUT /:id — the practitioner's edits
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Deliberately narrow. Section bodies, their own name and role, and a note to
 * the family. The evidence index, the model metadata, the tracking figures and
 * the child block are ours and stay exactly as recorded — a practitioner
 * disagreeing with the tracker fixes the tracker, not the copy of it in a PDF.
 */
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const row = await loadUpdate(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, row)) return res.status(403).json({ error: 'This update belongs to another key person' });
    if (row.status === 'sent') return res.status(409).json({ error: 'This update has already been sent to the family.' });

    const content = parseContent(row.content);
    const incoming = req.body || {};

    if (incoming.sections && typeof incoming.sections === 'object') {
      const existing = Array.isArray(content.sections) ? content.sections : [];
      content.sections = existing.map(s => {
        if (!Object.prototype.hasOwnProperty.call(incoming.sections, s.key)) return s;
        const body = String(incoming.sections[s.key] == null ? '' : incoming.sections[s.key]).slice(0, 12000);
        const edited = body.trim() !== String(s.body || '').trim();
        return Object.assign({}, s, { body, edited_by_practitioner: edited || !!s.edited_by_practitioner });
      });
    }
    // b404-C — the "Reviewed and approved by" line on the PDF is the approver's, so only
    // someone who can approve may set it.
    if (incoming.approved_by && typeof incoming.approved_by === 'object' && mayApprove(req.user, row)) {
      content.approved_by = {
        name: String(incoming.approved_by.name || '').slice(0, 120).trim(),
        role: String(incoming.approved_by.role || '').slice(0, 120).trim(),
        staff_id: req.user.id,
        at: new Date().toISOString(),
      };
    }
    if (typeof incoming.parent_note === 'string') content.parent_note = incoming.parent_note.slice(0, 2000);
    content.last_edited_by = { staff_id: req.user.id, at: new Date().toISOString() };

    const { rows } = await db.query(
      `UPDATE reports SET content=$2, staff_id=COALESCE(staff_id,$3), updated_at=now()
        WHERE id=$1 RETURNING id, updated_at`,
      [id, JSON.stringify(content), req.user.id]);
    res.json({ ok: true, id: rows[0].id, updated_at: rows[0].updated_at,
               problems: problemsFor(req.user, row, content), content });
  } catch (e) {
    console.error('termly-update put:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Next steps — section 3, and the b245 link
// ═══════════════════════════════════════════════════════════════════════════
/**
 * POST /:id/next-step — add a next step to this update, optionally carrying a
 * resource card or a library activity.
 *
 * Writes a real ladn.next_steps row, with source_report_id pointing back here.
 * It is NOT a copy living inside the report jsonb: a next step is a live thing
 * the room works on, appears in the child's profile and in the planner, and gets
 * marked complete against an observation. A second private copy would be stale
 * the first time somebody completed one.
 *
 * The card and activity are the same two libraries the room planner uses
 * (/api/next-steps/libraries — src/content/resource-cards/*.json and
 * curriculum_activities WHERE is_library). Same card types, chosen for one child
 * rather than the room, which is exactly what b246 was asked for.
 */
router.post('/:id/next-step', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  const description = String((req.body && req.body.description) || '').trim();
  if (!description) return res.status(400).json({ error: 'description required' });
  try {
    const db = getPool();
    const row = await loadUpdate(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, row)) return res.status(403).json({ error: 'This update belongs to another key person' });
    if (row.status === 'sent') return res.status(409).json({ error: 'This update has already been sent.' });

    const b = req.body || {};
    const slug = b.resource_card_slug && /^[a-z0-9-]+$/.test(String(b.resource_card_slug))
      ? String(b.resource_card_slug) : null;
    const actId = b.library_activity_id ? parseInt(b.library_activity_id, 10) : null;
    const { rows } = await db.query(`
      INSERT INTO next_steps (child_id, staff_id, description, status, due_by,
                              resource_card_slug, resource_card_title, library_activity_id,
                              source_report_id, created_at, updated_at)
      VALUES ($1,$2,$3,'pending',$4::date,$5,$6,$7,$8, now(), now())
      RETURNING id, description, status, due_by, resource_card_slug, resource_card_title,
                library_activity_id`,
      [row.child_id, req.user.id, description.slice(0, 2000),
       /^\d{4}-\d{2}-\d{2}$/.test(b.due_by || '') ? b.due_by : null,
       slug, b.resource_card_title ? String(b.resource_card_title).slice(0, 200) : null,
       Number.isInteger(actId) ? actId : null, id]);

    const refreshed = await refreshNextSteps(db, id, req.user.id);
    res.status(201).json({ ok: true, next_step: rows[0], next_steps: refreshed.next_steps,
                           section: refreshed.section });
  } catch (e) {
    console.error('termly-update next-step:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /:id/next-step/:nsId — attach or change the card/activity on one step,
 * or remove it from the update.
 */
router.patch('/:id/next-step/:nsId', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const nsId = parseInt(req.params.nsId, 10);
  if (!Number.isInteger(id) || !Number.isInteger(nsId)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const row = await loadUpdate(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, row)) return res.status(403).json({ error: 'This update belongs to another key person' });
    if (row.status === 'sent') return res.status(409).json({ error: 'This update has already been sent.' });

    const { rows: owned } = await db.query(
      'SELECT id, child_id FROM next_steps WHERE id=$1', [nsId]);
    if (!owned.length || Number(owned[0].child_id) !== Number(row.child_id)) {
      return res.status(404).json({ error: 'That next step is not on this child.' });
    }

    const b = req.body || {};
    const sets = [], params = [nsId];
    const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (Object.prototype.hasOwnProperty.call(b, 'resource_card_slug')) {
      const slug = b.resource_card_slug && /^[a-z0-9-]+$/.test(String(b.resource_card_slug))
        ? String(b.resource_card_slug) : null;
      add('resource_card_slug', slug);
      add('resource_card_title', slug && b.resource_card_title ? String(b.resource_card_title).slice(0, 200) : null);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'library_activity_id')) {
      const n = b.library_activity_id == null ? null : parseInt(b.library_activity_id, 10);
      add('library_activity_id', Number.isInteger(n) ? n : null);
    }
    if (typeof b.description === 'string' && b.description.trim()) add('description', b.description.trim().slice(0, 2000));
    if (Object.prototype.hasOwnProperty.call(b, 'due_by')) {
      add('due_by', /^\d{4}-\d{2}-\d{2}$/.test(b.due_by || '') ? b.due_by : null);
    }
    // "Take it off this update" — the step itself is left alone, only its link to
    // this document is cleared. Deleting a live next step because it was dropped
    // from one term's write-up would lose work the room is still doing.
    if (b.detach === true) add('source_report_id', null);
    if (!sets.length) return res.status(400).json({ error: 'nothing to change' });
    sets.push('updated_at = now()');

    const { rows } = await db.query(
      `UPDATE next_steps SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, description, status, due_by, resource_card_slug, resource_card_title, library_activity_id`,
      params);

    const refreshed = await refreshNextSteps(db, id, req.user.id);
    res.json({ ok: true, next_step: rows[0], next_steps: refreshed.next_steps, section: refreshed.section });
  } catch (e) {
    console.error('termly-update next-step patch:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Re-read the child's open next steps and rewrite section 3 and
 * content.next_steps from them.
 *
 * The prose and the structure are regenerated TOGETHER, from the database, every
 * time either changes. Editing one and leaving the other is how a PDF ends up
 * listing a next step that was removed twenty minutes earlier.
 *
 * A section the practitioner has hand-edited is left alone — their words win over
 * a regenerated list, and edited_by_practitioner is how we know.
 */
async function refreshNextSteps(db, reportId, staffId) {
  const row = await loadUpdate(db, reportId);
  const content = parseContent(row.content);
  const { cycles } = await TC.loadCycles(db);
  const cycle = TC.cycleByKey(cycles, row.cycle_key) || TC.currentCycle(cycles, TC.ymd(new Date()));

  const { rows: steps } = await db.query(`
    SELECT n.id, n.description, n.status, to_char(n.due_by,'YYYY-MM-DD') AS due_by,
           n.resource_card_slug, n.resource_card_title, n.library_activity_id,
           n.framework_statement_id, fs.area AS fs_area,
           ca.name AS activity_name,
           o.eyfs_areas AS obs_areas
      FROM next_steps n
      LEFT JOIN framework_statements fs ON fs.id = n.framework_statement_id
      LEFT JOIN curriculum_activities ca ON ca.id = n.library_activity_id
      LEFT JOIN observations o ON o.id = n.observation_id
     WHERE n.child_id = $1 AND n.status = 'pending'
     ORDER BY (n.source_report_id = $2) DESC, n.created_at DESC
     LIMIT 40`, [row.child_id, reportId]);

  const items = steps.map(n => {
    let key = TU.areaKey(n.fs_area);
    if (!key && Array.isArray(n.obs_areas)) { for (const a of n.obs_areas) { key = TU.areaKey(a); if (key) break; } }
    return {
      ref: `NS-${n.id}`, id: n.id, next_step_id: n.id,
      description: n.description, status: n.status, due_by: n.due_by,
      area: key, area_label: key ? TU.AREA_BY_KEY[key].heading : null,
      resource_card_slug: n.resource_card_slug, resource_card_title: n.resource_card_title,
      library_activity_id: n.library_activity_id, library_activity_name: n.activity_name,
    };
  });

  content.next_steps = { items };
  const evStub = {
    child: content.child || { known_as: (row.preferred_name || row.first_name || 'your child') },
    keyperson: content.keyperson || null,
    open_next_steps: items,
    windows: content.windows || { last_term: {}, this_term: { label: cycle ? cycle.name : 'this term' } },
  };
  const sections = Array.isArray(content.sections) ? content.sections : [];
  content.sections = sections.map(s => {
    if (s.key !== 'next_steps') return s;
    if (s.edited_by_practitioner) return s;      // their words win
    return Object.assign({}, s, {
      body: TU.renderNextSteps(items, evStub),
      evidence: items.map(i => i.ref),
      sufficient: items.length > 0,
      placeholder: items.length === 0,
    });
  });
  content.last_edited_by = { staff_id: staffId, at: new Date().toISOString() };

  await db.query('UPDATE reports SET content=$2, updated_at=now() WHERE id=$1',
    [reportId, JSON.stringify(content)]);
  return { next_steps: content.next_steps,
           section: content.sections.find(s => s.key === 'next_steps') || null };
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /:id/submit — the key person sends it to the room leader (b404-C)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Toby, 17 Oct 2026: termly updates are reviewed by Room Leaders. Nothing reaches
 * a family from this route — it only marks the update "with the room leader" and
 * tells the room leader (staff-side notification, no child's name in it). The
 * content checks are the same ones /send makes, minus the signature, which is the
 * approver's.
 */
router.post('/:id/submit', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const row = await loadUpdate(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, row)) return res.status(403).json({ error: 'This update belongs to another key person' });
    if (row.status === 'sent') return res.status(409).json({ error: 'Already sent' });
    if (row.status === 'drafting') return res.status(409).json({ error: 'Wren is still drafting this — give it a minute.' });

    const content = parseContent(row.content);
    const problems = TU.sendProblems(Object.assign({}, content, { approved_by: { name: '-', role: '-' } }));
    if (problems.length) return res.status(422).json({ error: 'Not ready to send to your room leader', problems });

    content.approval = {
      state: 'with_room_leader',
      submitted_by_staff_id: req.user.id,
      submitted_at: new Date().toISOString(),
    };
    await db.query(`UPDATE reports SET content=$2, status='awaiting_review', updated_at=now() WHERE id=$1`,
      [id, JSON.stringify(content)]);

    // Who to tell: every active room leader of the child's room (a room can have two);
    // failing that whoever resolveRoomLeader() finds (senior / deputy); failing that every manager.
    let leaderIds = [];
    if (row.room_id) {
      try {
        const { rows: ls } = await db.query(
          `SELECT id FROM staff WHERE COALESCE(is_active, true) = true AND COALESCE(is_demo, false) = false
              AND room_id = $1 AND role = 'room_leader' AND id <> $2`, [row.room_id, req.user.id]);
        leaderIds = ls.map(l => l.id);
        if (!leaderIds.length && resolveRoomLeader) {
          const lead = await resolveRoomLeader(db, row.room_id);
          if (lead && Number(lead.id) !== Number(req.user.id)) leaderIds = [lead.id];
        }
      } catch (_) { /* fall through to managers */ }
    }
    try {
      const link = `/ey/termly-update?id=${id}`;
      const title = 'A termly update is waiting for your approval';
      const body = `A key person has sent a termly update${row.room_name ? ' for ' + row.room_name : ''} for you to read. `
        + 'A family only sees it once you approve it.';
      const opts = { priority: 'normal', relatedTable: 'reports', relatedId: id, link };
      if (leaderIds.length) leaderIds.forEach(lid => notify('termly_update_draft', 'staff', lid, title, body, opts));
      else notify('termly_update_draft', 'all-managers', null, title, body, opts);
    } catch (_) { /* the submit already succeeded */ }

    res.json({ ok: true, id, approval: content.approval, notified: leaderIds.length ? 'room_leader' : 'managers' });
  } catch (e) {
    console.error('termly-update submit:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /:id/send — the human gate
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Staff review every update (Toby, 2026-08-28). Nothing here can be bypassed:
 * every section must have words in it, no section may still be an unedited
 * "not enough recorded yet" placeholder, and a named practitioner with a named
 * role must have signed. Only then does a PDF exist and a parent get told.
 */
router.post('/:id/send', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const row = await loadUpdate(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, row)) return res.status(403).json({ error: 'This update belongs to another key person' });
    if (row.status === 'sent') return res.status(409).json({ error: 'Already sent' });
    // b404-C — a room leader approves before a family sees it. The key person's
    // route is POST /:id/submit.
    if (!mayApprove(req.user, row)) {
      return res.status(403).json({
        error: 'A room leader approves termly updates before families see them. Use "Send to room leader".',
        needs_approval: true,
      });
    }

    const content = parseContent(row.content);
    const problems = TU.sendProblems(content);
    if (problems.length) return res.status(422).json({ error: 'Not ready to send', problems });

    const submittedBy = content.approval && content.approval.submitted_by_staff_id;
    content.sent = { by_staff_id: req.user.id, at: new Date().toISOString() };
    content.approval = {
      state: 'approved',
      submitted_by_staff_id: submittedBy || null,
      submitted_at: (content.approval && content.approval.submitted_at) || null,
      approved_by_staff_id: req.user.id,
      approved_at: content.sent.at,
    };
    delete content.status_note;

    const { rows } = await db.query(`
      UPDATE reports
         SET status='sent', sent_at=now(), shared_with_parents=true,
             lifecycle_status='pending_parent_review',
             staff_id=$3, content=$2, updated_at=now()
       WHERE id=$1 RETURNING *`, [id, JSON.stringify(content), req.user.id]);
    const sent = Object.assign({}, row, rows[0]);

    let pdfBytes = null;
    try { pdfBytes = (await writePdf(db, sent)).length; }
    catch (e) { console.error('[b246] PDF render failed on send', id, e.message); }

    try {
      notify('report_shared', 'parent', row.child_id,
        `${row.child_name}'s progress update`,
        `${(content.cycle && content.cycle.label) || 'This term'}'s update is ready — what went well last term, `
        + 'what we are working on now, and some things you could try at home. You can read it in the app.',
        { relatedTable: 'reports', relatedId: id, link: '/welcome/termly-update' });
    } catch (_) { /* the send already succeeded */ }

    res.json({ ok: true, id, status: 'sent', pdf_bytes: pdfBytes,
               pdf_url: `/api/termly-update/${id}/pdf` });
  } catch (e) {
    console.error('termly-update send:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/redraft — ask the model again after new records. Never after sending:
// a sent update is a record of what the family was told.
router.post('/:id/redraft', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const row = await loadUpdate(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, row)) return res.status(403).json({ error: 'This update belongs to another key person' });
    if (row.status !== 'awaiting_review') {
      return res.status(409).json({ error: 'Only a draft awaiting review can be redrafted.' });
    }
    await db.query(`UPDATE reports SET status='drafting', updated_at=now() WHERE id=$1`, [id]);
    setImmediate(() => runDraft(id));
    res.json({ ok: true, status: 'drafting' });
  } catch (e) {
    console.error('termly-update redraft:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/pdf — the document, for the practitioner.
router.get('/:id/pdf', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const row = await loadUpdate(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, row)) return res.status(403).json({ error: 'This update belongs to another key person' });
    const buf = await writePdf(db, row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      (req.query.download === '1' ? 'attachment' : 'inline') +
      '; filename="' + reportFilename(renderable(row)).replace(/"/g, '') + '"');
    res.end(buf);
  } catch (e) {
    console.error('termly-update pdf:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PARENT ROUTES — mounted at /welcome/termly-update/api on the parents portal
//
// Identity is already established: the portal-wide gate in server-unified.js runs
// requireParentIdentity for every /welcome/<x>/api/* path before these are
// reached, and parentEmailOf(req) reads only what that resolver established.
// Ownership is re-checked per request against parent_portal_access — a child who
// left between login and request is not in the answer.
//
// Two endpoints and no more. A parent LISTS the updates that have been sent to
// them and DOWNLOADS one. There is deliberately no HTML rendering of the body
// here: the b238 spec is "no report content living as a web page", and a termly
// update is a report.
// ═══════════════════════════════════════════════════════════════════════════
const parentRouter = express.Router();
const { parentEmailOf } = require('../lib/parent-identity');

parentRouter.use(requireEyfsEdition);

async function parentChildren(db, email) {
  const { rows } = await db.query(`
    SELECT DISTINCT c.id, c.first_name, c.last_name, c.preferred_name,
           kp.first_name AS kp_first, kp.last_name AS kp_last
      FROM children c
      LEFT JOIN parent_portal_access pa ON pa.child_id = c.id AND pa.is_active = true
      LEFT JOIN staff kp ON kp.id = c.key_person_id
     WHERE (lower(pa.email) = $1
            OR lower(COALESCE(c.parent_1_email,'')) = $1
            OR lower(COALESCE(c.parent_2_email,'')) = $1)
       AND COALESCE(c.is_active, true) = true
     ORDER BY c.first_name`, [email]);
  return rows;
}

/** GET /context — this family's sent updates, newest first, per child. */
parentRouter.get('/context', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const db = getPool();
    const kids = await parentChildren(db, email);
    if (!kids.length) return res.json({ children: [] });

    const { cycles } = await TC.loadCycles(db);
    const current = TC.currentCycle(cycles, TC.ymd(new Date()));

    // SENT only. A draft is the key person's working copy and is not the
    // family's to read — that is the whole point of the review gate.
    const { rows } = await db.query(`
      SELECT id, child_id, cycle_key, sent_at, pdf_generated_at,
             content->'cycle'->>'label' AS cycle_label,
             content->'approved_by'->>'name' AS approved_by
        FROM reports
       WHERE report_type = 'termly_update' AND status = 'sent'
         AND child_id = ANY($1::int[])
       ORDER BY sent_at DESC NULLS LAST, id DESC`, [kids.map(k => k.id)]);

    res.json({
      current_cycle: current ? { key: current.key, label: current.label } : null,
      children: kids.map(k => ({
        id: k.id,
        name: (k.preferred_name || k.first_name),
        key_person: k.kp_first ? `${k.kp_first} ${k.kp_last || ''}`.trim() : null,
        updates: rows.filter(r => r.child_id === k.id).map(r => ({
          id: r.id, cycle_key: r.cycle_key,
          cycle_label: r.cycle_label || r.cycle_key,
          sent_at: r.sent_at, written_by: r.approved_by || null,
          pdf_url: `/welcome/termly-update/api/pdf/${r.id}`,
        })),
      })),
    });
  } catch (e) {
    console.error('[b246] parent context:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/** GET /pdf/:id — the finished update, for the family it was sent to. */
parentRouter.get('/pdf/:id', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const row = await loadUpdate(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const mine = await parentChildren(db, email);
    if (!mine.some(c => c.id === row.child_id)) return res.status(403).json({ error: 'Not your child' });
    if (row.status !== 'sent') {
      return res.status(403).json({ error: 'This update has not been sent to you yet.' });
    }
    const buf = await writePdf(db, row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      (req.query.download === '1' ? 'attachment' : 'inline') +
      '; filename="' + reportFilename(renderable(row)).replace(/"/g, '') + '"');
    res.end(buf);
  } catch (e) {
    console.error('[b246] parent pdf:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/* ── b359 reuse hooks ────────────────────────────────────────────────────────
 * src/routes/termly-drafts.js drafts for a whole key-person caseload. It does it
 * through THESE, not through a copy of them, so there is exactly one place a
 * termly update is created, one place it is drafted, and one review screen. The
 * underscore prefix is the convention this codebase already uses for a router
 * that lends its internals (see resource-cards.js's _loadCards, areas.js's
 * _gather, planning.js's _periodWeeks). */
router._runDraft   = runDraft;
router._routeTo    = routeTo;
router._loadUpdate = loadUpdate;
router._REPORT_TYPE = REPORT_TYPE;
router._isLead     = isLead;
router._isManager  = isManager;

module.exports = router;
module.exports.parentRouter = parentRouter;
module.exports.renderable = renderable;
module.exports.runDraft = runDraft;
