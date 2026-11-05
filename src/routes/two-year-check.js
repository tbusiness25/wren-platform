'use strict';
/**
 * two-year-check.js — b243 (2026-08-28)
 *
 * The Progress Check at Age Two, started by the parent and signed by the key
 * person. Shared layer: mounted by editions/ladn/server-unified.js (LADN's EY +
 * parents portals) and editions/eyfs/server-unified.js (the EYFS edition), and
 * gated to EYFS-family editions — a secondary school has no 2-year check.
 *
 * ── THE SHAPE OF IT ─────────────────────────────────────────────────────────
 *   parent books their health-visitor appointment
 *     → a ladn.reports row, report_type='two_year_check', status='requested'
 *     → the local model drafts it from the child's own records   (status='drafting')
 *     → the key person is notified                        (status='awaiting_review')
 *     → they edit, add their name and role, and SEND               (status='sent')
 *     → PDF rendered, stored on the row, parent notified and can download it
 *
 * Nothing reaches a parent without that explicit send. The model drafts; a
 * practitioner signs. That is the whole safety model, and it is why the send
 * endpoint refuses a draft with an empty prime-area section or a missing
 * practitioner name.
 *
 * ── WHY THE SEND GATE IS THE KEY PERSON, NOT A CAPABILITY ───────────────────
 * The obvious gate would be requireCapabilityLevel('reports.send-to-parents',
 * 'edit'), which is what src/routes/reports.js uses. It cannot be used here.
 * On prod that capability is granted at level 'view' to `practitioner` — and a
 * practitioner is exactly who a key person usually is. Gating on it would 403
 * the one person the statute says must write and sign this document, and the
 * whole flow would dead-end at the review step.
 *
 * So access is the RELATIONSHIP: you may read, edit and send a check if you are
 * the assigned staff member, the child's key person, or manager-level. That is
 * narrower than the capability for everyone else and correct for the key person.
 *
 * ── EXTENDS ladn.reports, DOES NOT PARALLEL IT ──────────────────────────────
 * report_type='two_year_check' already exists (16 rows on prod, imported from
 * EyLog). Those rows have status IS NULL and are untouched by everything here:
 * every query in this file that means "a b243 check" says so with an explicit
 * status filter. Columns added by migrations/2026-08-28-b243-two-year-check.sql.
 */

const express = require('express');
const fsp = require('fs').promises;
const nodePath = require('path');

const router = express.Router();
const parentRouter = express.Router();

const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');
const { renderReportPdf, reportFilename } = require('../lib/report-pdf');
const T = require('../lib/two-year-check');

let resolveRoomLeader;
try { ({ resolveRoomLeader } = require('../lib/offratio')); } catch (_) { resolveRoomLeader = null; }

// Same resolution as src/routes/reports.js — one cache directory, one set of
// files. A check's PDF is a reports PDF; it must land where the reports screen
// and the b238 renderer already look for it.
const REPORTS_PDF_DIR = process.env.REPORTS_PDF_DIR
  || nodePath.join(process.env.UPLOAD_ROOT || '/app/uploads', 'reports');

const OPEN_STATUSES = ['requested', 'drafting', 'awaiting_review'];
const MANAGER_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager']);
const isManager = u => !!(u && MANAGER_ROLES.has(u.role));

// ── Edition gate ─────────────────────────────────────────────────────────────
// Mounted on every edition that asks for it; refuses on the ones where a 2-year
// check is meaningless, rather than relying on each server file to remember.
function requireEyfsEdition(req, res, next) {
  if (!T.isEyfsEdition()) {
    return res.status(404).json({ error: 'The progress check at age two applies to early years settings only.' });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════

async function settingHeader(db) {
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key IN ('nursery_name','setting_name','nursery_address')`);
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return {
      name: m.nursery_name || m.setting_name || 'Your Nursery',
      address: m.nursery_address || '',
    };
  } catch { return { name: 'Your Nursery', address: '' }; }
}

/** One check plus everything needed to render or gate it. */
async function loadCheck(db, id) {
  const { rows } = await db.query(`
    SELECT r.*,
           c.first_name, c.last_name, c.preferred_name, c.date_of_birth,
           c.key_person_id, c.room_id,
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
     WHERE r.id = $1 AND r.report_type = 'two_year_check'`, [id]);
  return rows[0] || null;
}

/** The relationship gate described in this file's header. */
function mayHandle(user, check) {
  if (!user || !check) return false;
  if (isManager(user)) return true;
  if (Number(check.assigned_staff_id) === Number(user.id)) return true;
  if (Number(check.key_person_id) === Number(user.id)) return true;
  return false;
}

/**
 * Who should this draft go to?
 *
 * ── b528 (2026-10-26): THE ROOM THAT WRITES IT, NOT JUST THE KEY PERSON ─────
 * Toby: "it's the preschool staff that write it up." b243 routed to the key
 * person whoever they were, which at LADN means a Baby Room key person writes a
 * check for a child who is about to move to Pre-school — and the Baby Room was
 * writing them "right before they turn two", too early to be any use at a
 * health visitor review that happens at 2–2½.
 *
 * So the order is now:
 *   1. the child's key person, IF they work in the room that writes the check
 *      (resolved from the rooms table by age band — never a hard-coded id);
 *   2. that room's leader, with the reason recorded so the review screen can
 *      say why it is with them rather than with the key person;
 *   3. the management team.
 *
 * The key person keeps READ/EDIT/SEND access either way — that is mayHandle()
 * above, and it is deliberate: the person who knows the child must be able to
 * write in the document about them.
 */
async function routeTo(db, child) {
  const name = child.first_name || 'This child';
  let room = null;
  try { room = await T.resolveCheckRoom(db); } catch (_) { room = null; }
  const roomLabel = room ? room.name : 'the room that writes these checks';

  let kp = null;
  if (child.key_person_id) {
    try {
      const { rows } = await db.query(
        'SELECT id, room_id, first_name, last_name FROM staff WHERE id=$1 AND COALESCE(is_active,true)=true',
        [child.key_person_id]);
      kp = rows[0] || null;
    } catch (_) { kp = null; }
  }

  // 1 — the key person, when they are in the writing room.
  if (kp && room && Number(kp.room_id) === Number(room.id)) {
    return { staff_id: kp.id, via: 'key_person', room_id: room.id, room_name: room.name, reason: null };
  }

  // 2 — the writing room's leader.
  if (room && resolveRoomLeader) {
    try {
      const lead = await resolveRoomLeader(db, room.id);
      if (lead) {
        const why = kp
          ? `${name}'s key person, ${[kp.first_name, kp.last_name].filter(Boolean).join(' ')}, is not in ${roomLabel}, so this check has come to you as the ${roomLabel} lead. They can still read and edit it with you.`
          : `${name} has no key person assigned, so this check has come to you as the ${roomLabel} lead.`;
        return { staff_id: lead.id, via: 'check_room_leader', room_id: room.id, room_name: room.name, reason: why };
      }
    } catch (_) { /* fall through to managers */ }
  }

  // 3 — the management team. Never simply dropped.
  return { staff_id: null, via: 'managers',
    room_id: room ? room.id : null, room_name: room ? room.name : null,
    reason: room
      ? `No ${roomLabel} leader could be identified, so this check has gone to the management team.`
      : 'No room could be matched to the age this check is written at, so it has gone to the management team.' };
}

// ── The drafting job ─────────────────────────────────────────────────────────
// In-process and fire-and-forget: the parent gets their confirmation immediately
// and the 122b takes as long as it takes. The in-flight set stops a double-tap
// from starting two runs against the same row.
const _drafting = new Set();

async function runDraft(reportId) {
  if (_drafting.has(reportId)) return;
  _drafting.add(reportId);
  const db = getPool();
  try {
    const check = await loadCheck(db, reportId);
    if (!check) return;
    if (check.status !== 'requested') return;   // already drafted, or already sent

    await db.query(`UPDATE reports SET status='drafting', updated_at=now() WHERE id=$1`, [reportId]);

    const ev = await T.gatherEvidence(db, check.child_id);
    const content = await T.buildDraft(ev, { appointment_date: check.appointment_date });

    // Routing is decided at draft time, not request time, so a key person
    // assigned in the meantime still gets it.
    const dest = await routeTo(db, check);
    content.routing = dest;

    await db.query(`
      UPDATE reports
         SET content = $2, status = 'awaiting_review', assigned_staff_id = $3,
             ai_generated = true, updated_at = now()
       WHERE id = $1`, [reportId, JSON.stringify(content), dest.staff_id]);

    const childName = `${check.first_name || ''} ${check.last_name || ''}`.trim();
    const title = `2-year check ready to review — ${childName}`;
    const body = [
      `${childName}'s family have booked their health visitor review` +
        (check.appointment_date ? ` for ${T.longDate(check.appointment_date)}` : '') + '.',
      'Wren has drafted the progress check at age two from their records.',
      'Please read it, edit it, add your name and role, and send it to them.',
      dest.reason,
    ].filter(Boolean).join(' ');
    const link = `/ey/two-year-check/review?id=${reportId}`;

    if (dest.staff_id) {
      notify('two_year_check_draft', 'staff', dest.staff_id, title, body,
        { priority: 'high', relatedTable: 'children', relatedId: check.child_id, link });
    } else {
      notify('two_year_check_draft', 'all-managers', null, title, body,
        { priority: 'high', relatedTable: 'children', relatedId: check.child_id, link });
    }
  } catch (e) {
    console.error('[b243] draft failed for report', reportId, e.message);
    // Never leave a parent's request stuck in 'drafting'. Put it in front of a
    // human with the failure written down — a statutory document that silently
    // never arrives is the worse outcome.
    try {
      await db.query(`
        UPDATE reports
           SET status='awaiting_review',
               content = COALESCE(content, '{}'::jsonb) ||
                         jsonb_build_object('draft_error', $2::text, 'kind', 'two_year_check'),
               updated_at = now()
         WHERE id=$1 AND status='drafting'`, [reportId, e.message]);
      notify('two_year_check_draft', 'all-managers', null,
        'A 2-year check draft could not be generated',
        `Report #${reportId}: ${e.message}. The request is still open and needs writing by hand.`,
        { priority: 'high', relatedTable: 'reports', relatedId: reportId,
          link: `/ey/two-year-check/review?id=${reportId}` });
    } catch (e2) { console.error('[b243] could not record draft failure', e2.message); }
  } finally {
    _drafting.delete(reportId);
  }
}

/**
 * The row as the PDF renderer wants it: parent-facing sections only, citations
 * stripped, and a real title instead of titleCase('two_year_check').
 * Used by BOTH this route and src/routes/reports.js — one PDF path (b238).
 */
function renderable(check) {
  const content = (typeof check.content === 'string') ? JSON.parse(check.content) : (check.content || {});

  // ONLY a b243 check. The 16 pre-existing two_year_check rows on prod carry a
  // completely different jsonb — `sections` is an OBJECT keyed
  // introduction/achievements/next_steps/whatParentsCanDo, not an array — and
  // running them through printableSections() would return nothing and print
  // "This report has no written content yet." Hand those back untouched so the
  // b238 renderer's own shape-flattening deals with them exactly as it does now.
  if (content.kind !== 'two_year_check') {
    return Object.assign({}, check, { display_title: 'Progress Check at Age Two' });
  }

  const kp = content.keyperson_signed || content.keyperson || null;
  // The footer reads "Written by <author_name>". The practitioner's ROLE belongs
  // there too — a health visitor reading this needs to know whether the person
  // who wrote it is the child's key person or the room lead.
  const author = kp && kp.name
    ? `${kp.name}${kp.role ? ', ' + kp.role : ''}`
    : check.author_name;
  return Object.assign({}, check, {
    display_title: 'Progress Check at Age Two',
    author_name: author,
    content: { sections: T.printableSections(content) },
  });
}

/**
 * Render, cache to disk, and record on the row. Mirrors reports.js's cache.
 *
 * An IMPORTED PDF *is* the report and is never re-rendered — the same rule
 * src/routes/reports.js states, and the reason this function reads before it
 * writes: re-rendering would overwrite the imported file at the same
 * report-<id>.pdf path and destroy the original. No two_year_check row carries
 * source='eylog' today, but the import path that would create one exists.
 */
async function writePdf(db, check) {
  if (check.source === 'eylog' && check.pdf_path) {
    const abs = nodePath.resolve(REPORTS_PDF_DIR, nodePath.basename(check.pdf_path));
    return fsp.readFile(abs);   // rejects if it is gone; the caller turns that into a 404
  }
  const setting = await settingHeader(db);
  const buf = await renderReportPdf(renderable(check), setting);
  const stored = `report-${check.id}.pdf`;
  try {
    await fsp.mkdir(REPORTS_PDF_DIR, { recursive: true });
    await fsp.writeFile(nodePath.join(REPORTS_PDF_DIR, stored), buf);
    await db.query(
      `UPDATE reports SET pdf_path=$2, pdf_generated_at=now(), pdf_bytes=$3,
                          source=COALESCE(source,'wren')
        WHERE id=$1`, [check.id, stored, buf.length]);
  } catch (e) {
    // Same call as b238: a read-only volume must not stop the document being
    // produced — it is streamed either way, just not cached.
    console.error('[b243] could not cache check PDF', check.id, e.message);
  }
  return buf;
}

/** Parent-safe state line: "requested 28 Aug · draft with Aisha · sent 2 Sept". */
function stateLine(row) {
  const bits = [];
  if (row.requested_at) bits.push('requested ' + shortDate(row.requested_at));
  // b528: a parked request is not "nothing happening" and must not read as a
  // stall — it is waiting for a date we can name.
  if (row.status === 'requested' && row.parked_until) {
    bits.push('we will write it from ' + shortDate(row.parked_until));
  }
  if (row.status === 'drafting') bits.push('Wren is writing the draft');
  if (row.status === 'awaiting_review') {
    bits.push('draft with ' + (row.assigned_name ? row.assigned_name.split(' ')[0] : 'your key person'));
  }
  if (row.status === 'sent' && row.sent_at) bits.push('sent ' + shortDate(row.sent_at));
  return bits.join(' · ');
}
function shortDate(v) {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ═══════════════════════════════════════════════════════════════════════════
// STAFF ROUTES — mounted at /api/two-year-check
// ═══════════════════════════════════════════════════════════════════════════
router.use(requireEyfsEdition);
router.use(authenticate);

/**
 * GET /queue — checks waiting on somebody. A manager sees every open check; a
 * practitioner sees the ones routed to them or for their key children.
 * Legacy/imported rows (status IS NULL) never appear: this is a work queue.
 */
router.get('/queue', async (req, res) => {
  try {
    const db = getPool();
    const params = [];
    let scope = '';
    if (!isManager(req.user)) {
      params.push(req.user.id);
      scope = ` AND (r.assigned_staff_id = $1 OR c.key_person_id = $1)`;
    }
    const { rows } = await db.query(`
      SELECT r.id, r.child_id, r.status, r.appointment_date, r.requested_at,
             r.sent_at, r.created_at, r.updated_at, r.pdf_generated_at,
             c.first_name, c.last_name, c.date_of_birth, c.key_person_id,
             rm.name AS room_name,
             a.first_name || ' ' || a.last_name AS assigned_name,
             (r.content->'concerns') AS concerns,
             (r.content->'model'->>'errors') IS NOT NULL AS draft_had_errors
        FROM reports r
        JOIN children c    ON c.id = r.child_id
        LEFT JOIN rooms rm ON rm.id = c.room_id
        LEFT JOIN staff a  ON a.id = r.assigned_staff_id
       WHERE r.report_type = 'two_year_check'
         AND r.status IS NOT NULL${scope}
       ORDER BY CASE r.status WHEN 'awaiting_review' THEN 0 WHEN 'drafting' THEN 1
                              WHEN 'requested' THEN 2 ELSE 3 END,
                r.appointment_date NULLS LAST, r.requested_at DESC
       LIMIT 200`, params);
    res.json({
      checks: rows.map(r => Object.assign(r, {
        age_months: T.ageInMonths(r.date_of_birth),
        child_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      })),
      open: rows.filter(r => OPEN_STATUSES.includes(r.status)).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /:id — the draft, its evidence index, and the child it is about. */
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const check = await loadCheck(db, id);
    if (!check) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, check)) {
      return res.status(403).json({ error: 'This check belongs to another key person' });
    }
    const content = (typeof check.content === 'string') ? JSON.parse(check.content) : (check.content || {});
    res.json({
      id: check.id,
      child_id: check.child_id,
      child_name: check.child_name,
      date_of_birth: T.ymd(check.date_of_birth),
      age_months: T.ageInMonths(check.date_of_birth),
      room_name: check.room_name,
      status: check.status,
      appointment_date: T.ymd(check.appointment_date),
      requested_at: check.requested_at,
      sent_at: check.sent_at,
      updated_at: check.updated_at,
      assigned_staff_id: check.assigned_staff_id,
      assigned_name: check.assigned_name,
      assigned_role: check.assigned_role ? T.roleLabel(check.assigned_role) : null,
      shared_with_parents: check.shared_with_parents,
      has_pdf: !!check.pdf_generated_at,
      prime_keys: T.PRIME_KEYS,
      content,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PUT /:id — the key person's edits. Section bodies, their own name and role,
 * and the targeted plan. Deliberately narrow: the evidence index, the model
 * metadata and the child block are ours, not theirs, and stay as recorded.
 */
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const check = await loadCheck(db, id);
    if (!check) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, check)) return res.status(403).json({ error: 'This check belongs to another key person' });
    if (check.status === 'sent') return res.status(409).json({ error: 'This check has already been sent to the parents.' });

    const content = (typeof check.content === 'string') ? JSON.parse(check.content) : (check.content || {});
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
    if (incoming.keyperson && typeof incoming.keyperson === 'object') {
      content.keyperson_signed = {
        name: String(incoming.keyperson.name || '').slice(0, 120).trim(),
        role: String(incoming.keyperson.role || '').slice(0, 120).trim(),
      };
    }
    if (typeof incoming.parent_note === 'string') {
      content.parent_note = incoming.parent_note.slice(0, 2000);
    }
    content.last_edited_by = { staff_id: req.user.id, at: new Date().toISOString() };

    const { rows } = await db.query(
      `UPDATE reports SET content=$2, staff_id=COALESCE(staff_id,$3), updated_at=now()
        WHERE id=$1 RETURNING id, updated_at`,
      [id, JSON.stringify(content), req.user.id]);
    res.json({ ok: true, id: rows[0].id, updated_at: rows[0].updated_at, content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /:id/send — the human gate. Refuses anything that would go out
 * incomplete, then renders the PDF, marks it shared, and tells the parents.
 */
router.post('/:id/send', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const check = await loadCheck(db, id);
    if (!check) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, check)) return res.status(403).json({ error: 'This check belongs to another key person' });
    if (check.status === 'sent') return res.status(409).json({ error: 'Already sent' });

    const content = (typeof check.content === 'string') ? JSON.parse(check.content) : (check.content || {});
    const sections = Array.isArray(content.sections) ? content.sections : [];
    const byKey = Object.fromEntries(sections.map(s => [s.key, s]));

    const problems = [];
    for (const a of T.PRIME_AREAS) {
      const s = byKey[a.key];
      if (!s || !String(s.body || '').trim()) problems.push(`${a.heading} is empty.`);
    }
    const signed = content.keyperson_signed || {};
    if (!String(signed.name || '').trim()) problems.push('Add your name — a parent needs to know who wrote this.');
    if (!String(signed.role || '').trim()) problems.push('Add your role.');
    if (Array.isArray(content.concerns) && content.concerns.length) {
      const plan = byKey.targeted_plan;
      const planText = String((plan && plan.body) || '');
      if (!plan || !planText.trim() || !(plan.edited_by_practitioner)) {
        problems.push('This check flags an area where progress is less than expected, so the EYFS requires a targeted plan. Please write what we have agreed with the family in "What we will do next".');
      }
    }
    if (problems.length) return res.status(422).json({ error: 'Not ready to send', problems });

    content.sent = { by_staff_id: req.user.id, at: new Date().toISOString() };
    delete content.status_note;

    const { rows } = await db.query(`
      UPDATE reports
         SET status='sent', sent_at=now(), shared_with_parents=true,
             staff_id=$3, content=$2, updated_at=now()
       WHERE id=$1 RETURNING *`, [id, JSON.stringify(content), req.user.id]);
    const sent = Object.assign({}, check, rows[0]);

    let pdfBytes = null;
    try {
      const buf = await writePdf(db, sent);
      pdfBytes = buf.length;
    } catch (e) {
      console.error('[b243] PDF render failed on send', id, e.message);
    }

    const childName = check.child_name;
    try {
      notify('report_shared', 'parent', check.child_id,
        `${childName}'s progress check at age two`,
        'Your key person has finished the summary for your health visitor appointment. You can read and download it in the app.',
        { relatedTable: 'reports', relatedId: id, link: '/welcome/two-year-check' });
    } catch (_) { /* the send already succeeded */ }

    res.json({ ok: true, id, status: 'sent', pdf_bytes: pdfBytes,
      pdf_url: `/api/two-year-check/${id}/pdf` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /:id/redraft — ask the model again (after new observations, say).
 * Only from awaiting_review, never after sending: a sent document is a record.
 */
router.post('/:id/redraft', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const check = await loadCheck(db, id);
    if (!check) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, check)) return res.status(403).json({ error: 'This check belongs to another key person' });
    // b528: 'requested' is allowed too — that is a PARKED check (the child is not
    // two yet, see startOrPark), and this is the practitioner saying "write it
    // now anyway", which is their call to make. 'sent' is still refused: a sent
    // document is a record.
    if (check.status !== 'awaiting_review' && check.status !== 'requested') {
      return res.status(409).json({ error: 'Only a draft awaiting review can be redrafted.' });
    }
    await db.query(`UPDATE reports SET status='requested', updated_at=now() WHERE id=$1`, [id]);
    setImmediate(() => runDraft(id));
    res.json({ ok: true, status: 'requested' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /:id/pdf — the document, for the practitioner. */
router.get('/:id/pdf', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const check = await loadCheck(db, id);
    if (!check) return res.status(404).json({ error: 'Not found' });
    if (!mayHandle(req.user, check)) return res.status(403).json({ error: 'This check belongs to another key person' });
    const buf = await writePdf(db, check);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      (req.query.download === '1' ? 'attachment' : 'inline') +
      '; filename="' + reportFilename(renderable(check)).replace(/"/g, '') + '"');
    res.end(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /child/:childId/request — a practitioner starting a check themselves.
 * Same row, same draft, same review gate as the parent-triggered path; it just
 * does not wait for a family to book. Parity, so the parents app is the usual
 * way in rather than the only way in.
 */
router.post('/child/:childId/request', async (req, res) => {
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'bad child id' });
  try {
    const db = getPool();
    const { rows: crows } = await db.query(
      'SELECT id, first_name, last_name, date_of_birth, key_person_id, room_id FROM children WHERE id=$1', [childId]);
    if (!crows.length) return res.status(404).json({ error: 'Child not found' });
    const child = crows[0];
    if (!isManager(req.user) && Number(child.key_person_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'This child is not one of your key children' });
    }
    // b528: the REQUEST window (18 months) rather than the statutory window, for
    // the same reason the parents app uses it — a practitioner holding the
    // family's appointment letter should not have to force it either.
    const st = T.requestStage(child.date_of_birth);
    const el = st.eligibility;
    if (!st.can_request && req.body && req.body.force !== true) {
      return res.status(422).json({ error: el.message, eligibility: el, stage: st.stage });
    }
    const apptDate = (req.body && req.body.appointment_date) ? req.body.appointment_date : null;
    const created = await openOrCreate(db, child, {
      appointment_date: apptDate,
      requested_by_email: null,
    });
    if (created.existing) return res.json({ ok: true, id: created.id, existing: true, status: created.status });
    const started = await startOrPark(db, child, created.id, apptDate);
    res.status(201).json({ ok: true, id: created.id, status: 'requested',
      parked_until: started.parked_until });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * b528 — start the draft, or PARK it until the check can honestly be written.
 *
 * A request from 18 months is accepted (see T.requestStage — a health visitor
 * letter arrives before the second birthday), but the statutory document is
 * still written between 24 and 36 months. So a request below 24 months is left
 * at status 'requested' with nothing drafted and nobody told "this needs you";
 * the room that writes it is told it is COMING, with the date. The sweep in
 * src/services/two-year-check-draft-queue.js starts the draft when the child
 * reaches the window, or sooner if the appointment is within T.DRAFT_LEAD_DAYS.
 *
 * Drafting four months early would be worse than waiting: the evidence would be
 * a 19-month-old's, and it is the stale-draft-in-the-queue that makes a
 * practitioner stop reading the queue.
 */
async function startOrPark(db, child, reportId, appointmentDate) {
  if (T.draftDueNow(child.date_of_birth, appointmentDate)) {
    setImmediate(() => runDraft(reportId));
    return { drafting: true, parked_until: null };
  }
  const dest = await routeTo(db, child);
  const openOn = T.ymd(T.addMonths(child.date_of_birth, T.AGE_MIN_MONTHS));
  const name = child.preferred_name || child.first_name || 'This child';
  const note = `Parked until ${T.longDate(openOn)}, when ${name} turns two — the check is written between two and three.`;
  await db.query(`
    UPDATE reports
       SET assigned_staff_id = $2,
           content = COALESCE(content, '{}'::jsonb) || $3::jsonb,
           updated_at = now()
     WHERE id = $1 AND status = 'requested'`,
    [reportId, dest.staff_id, JSON.stringify({
      kind: 'two_year_check', parked_until: openOn, status_note: note, routing: dest,
    })]);

  const title = `2-year check coming up — ${name}`;
  const body = [
    `${name}'s family have asked for their progress check at age two` +
      (appointmentDate ? `, for a health visitor review on ${T.longDate(appointmentDate)}` : '') + '.',
    `They turn two on ${T.longDate(openOn)}. Wren will draft it then and tell you it is ready — nothing is needed from you yet.`,
    dest.reason,
  ].filter(Boolean).join(' ');
  const link = `/ey/two-year-check/review?id=${reportId}`;
  if (dest.staff_id) {
    notify('two_year_check_draft', 'staff', dest.staff_id, title, body,
      { priority: 'normal', relatedTable: 'children', relatedId: child.id, link });
  } else {
    notify('two_year_check_draft', 'all-managers', null, title, body,
      { priority: 'normal', relatedTable: 'children', relatedId: child.id, link });
  }
  return { drafting: false, parked_until: openOn };
}

/**
 * Create the row, or hand back the one already open for this child.
 * The unique partial index reports_two_year_check_open_uq is the real guard —
 * two taps a millisecond apart cannot both insert — and 23505 is caught here and
 * turned into "here is your existing request" rather than an error.
 */
async function openOrCreate(db, child, opts) {
  const existing = await db.query(`
    SELECT id, status FROM reports
     WHERE child_id=$1 AND report_type='two_year_check' AND status = ANY($2)
     ORDER BY id DESC LIMIT 1`, [child.id, OPEN_STATUSES]);
  if (existing.rows.length) {
    // A later appointment date is new information — record it on the open check.
    if (opts.appointment_date) {
      await db.query(`UPDATE reports SET appointment_date=$2, updated_at=now() WHERE id=$1`,
        [existing.rows[0].id, opts.appointment_date]);
    }
    return { id: existing.rows[0].id, status: existing.rows[0].status, existing: true };
  }
  const dest = await routeTo(db, child);
  const seed = {
    kind: 'two_year_check', version: 1,
    status_note: 'Requested — Wren is gathering the records.',
    appointment_date: opts.appointment_date || null,
    sections: [],
  };
  try {
    const { rows } = await db.query(`
      INSERT INTO reports (child_id, report_type, content, ai_generated, shared_with_parents,
                           status, appointment_date, requested_at, requested_by_email,
                           assigned_staff_id, source, updated_at)
      VALUES ($1,'two_year_check',$2,true,false,'requested',$3,now(),$4,$5,'wren',now())
      RETURNING id, status`,
      [child.id, JSON.stringify(seed), opts.appointment_date || null,
       opts.requested_by_email || null, dest.staff_id]);
    return { id: rows[0].id, status: rows[0].status, existing: false };
  } catch (e) {
    if (e.code === '23505') {
      const again = await db.query(`
        SELECT id, status FROM reports
         WHERE child_id=$1 AND report_type='two_year_check' AND status = ANY($2)
         ORDER BY id DESC LIMIT 1`, [child.id, OPEN_STATUSES]);
      if (again.rows.length) return { id: again.rows[0].id, status: again.rows[0].status, existing: true };
    }
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PARENT ROUTES — mounted at /welcome/two-year-check/api on the parents portal
//
// Identity is already established: the portal-wide gate in server-unified.js
// runs requireParentIdentity for every /welcome/<x>/api/* path before these are
// reached, and parentEmailOf(req) reads only what that resolver established.
// Ownership is re-checked per request against parent_portal_access — a child who
// left between login and request is not in the answer.
// ═══════════════════════════════════════════════════════════════════════════
const { parentEmailOf } = require('../lib/parent-identity');

parentRouter.use(requireEyfsEdition);

async function parentChildren(db, email) {
  const { rows } = await db.query(`
    SELECT DISTINCT c.id, c.first_name, c.last_name, c.preferred_name, c.date_of_birth,
           c.key_person_id,
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

/** GET /context — the explanation, each child's eligibility, and any check state. */
parentRouter.get('/context', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const db = getPool();
    const children = await parentChildren(db, email);
    if (!children.length) return res.json({ children: [] });

    const ids = children.map(c => c.id);
    const { rows: checks } = await db.query(`
      SELECT r.id, r.child_id, r.status, r.appointment_date, r.requested_at, r.sent_at,
             r.pdf_generated_at, r.created_at,
             (r.content->>'parked_until') AS parked_until,
             a.first_name || ' ' || a.last_name AS assigned_name
        FROM reports r
        LEFT JOIN staff a ON a.id = r.assigned_staff_id
       WHERE r.child_id = ANY($1) AND r.report_type='two_year_check'
         AND r.status IS NOT NULL
       ORDER BY r.created_at DESC`, [ids]);

    res.json({
      children: children.map(c => {
        const mine = checks.filter(k => k.child_id === c.id);
        const open = mine.find(k => OPEN_STATUSES.includes(k.status)) || null;
        // b528 — what this family sees. `stage` is the parents app's own
        // question ("explain it / you can ask for it / it has closed"), which is
        // NOT the same as `eligibility` ("may it be written today"); both are
        // sent so the page never has to work one out from the other.
        const st = T.requestStage(c.date_of_birth);
        return {
          id: c.id,
          name: `${c.preferred_name || c.first_name || ''} ${c.last_name || ''}`.trim(),
          first_name: c.preferred_name || c.first_name,
          date_of_birth: T.ymd(c.date_of_birth),
          age_months: st.months,
          key_person: c.key_person_id ? `${c.kp_first || ''} ${c.kp_last || ''}`.trim() : null,
          eligibility: st.eligibility,
          stage: st.stage,
          can_request: st.can_request,
          parked: st.parked,
          turns_two_on: T.ymd(T.addMonths(c.date_of_birth, T.AGE_MIN_MONTHS)),
          due_on: st.eligibility.due_on || null,
          open_check: open ? { id: open.id, status: open.status,
            appointment_date: T.ymd(open.appointment_date),
            parked_until: open.parked_until || null, state: stateLine(open) } : null,
          // b243 checks only. The pre-existing two_year_check rows (status NULL,
          // some already shared) are NOT surfaced here: their jsonb has an
          // object-shaped `sections` that neither renderer turns into a
          // document, so listing them would offer a parent a download that
          // prints nothing. They stay where they already are, on the existing
          // reports surface. Rendering them properly is its own job.
          checks: mine.map(k => ({
            id: k.id, status: k.status,
            appointment_date: T.ymd(k.appointment_date),
            requested_at: k.requested_at, sent_at: k.sent_at,
            state: stateLine(k),
            downloadable: k.status === 'sent',
          })),
        };
      }),
    });
  } catch (e) { console.error('[b243] parent context:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

/**
 * POST /book — "I've been contacted and booked an appointment".
 *
 * b528: the DATE IS NOW OPTIONAL and the window opens at 18 months.
 *   • Optional date, because Toby's flow is "once their health visitor has given
 *     them an appointment they press the button" — a family who has been told
 *     "we'll write to you" has still heard from the health visitor, and refusing
 *     the request for want of a date is how b243 collected nothing at all.
 *   • 18 months, because the letter arrives before the second birthday. A
 *     request below 24 months is PARKED, not written early (startOrPark).
 */
parentRouter.post('/book', express.json({ limit: '8kb' }), async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const childId = parseInt((req.body || {}).child_id, 10);
  const dateStr = String((req.body || {}).appointment_date || '').trim();
  if (!childId) return res.status(400).json({ error: 'Please choose your child.' });

  let when = null;
  if (dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'That date did not look right — please pick it again.' });
    }
    when = new Date(dateStr + 'T12:00:00');
    if (isNaN(when)) return res.status(400).json({ error: 'That date did not look right — please pick it again.' });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const twoYearsOn = new Date(today); twoYearsOn.setFullYear(twoYearsOn.getFullYear() + 2);
    if (when < new Date(today.getTime() - 31 * 86400000)) {
      return res.status(400).json({ error: 'That date is in the past. If the appointment has already happened, please tell us in a message instead.' });
    }
    if (when > twoYearsOn) return res.status(400).json({ error: 'That date is a long way off — please check it.' });
  }

  try {
    const db = getPool();
    const mine = await parentChildren(db, email);
    const child = mine.find(c => c.id === childId);
    if (!child) return res.status(403).json({ error: 'Not your child' });

    const st = T.requestStage(child.date_of_birth);
    if (!st.can_request) {
      return res.status(422).json({ error: st.eligibility.message, eligibility: st.eligibility, stage: st.stage });
    }

    const created = await openOrCreate(db, child, {
      appointment_date: dateStr || null, requested_by_email: email,
    });
    const started = created.existing
      ? { parked_until: null }
      : await startOrPark(db, child, created.id, dateStr || null);

    const first = child.preferred_name || child.first_name;
    let message;
    if (created.existing) {
      message = dateStr
        ? 'You already have a check in progress for this child — we have updated it with your appointment date.'
        : 'You already have a check in progress for this child — we will let you know here when it is ready.';
    } else if (started.parked_until) {
      message = `Thank you — we have made a note. ${first} turns two on ` +
        `${T.longDate(started.parked_until)}, and we write the check between two and three, so we will ` +
        `start it then and it will appear here.`;
    } else {
      message = `Thank you. ${first}'s summary will be written in Pre-school and sent to you here` +
        (dateStr ? ' before your appointment.' : ' — we will let you know as soon as it is ready.');
    }

    res.status(created.existing ? 200 : 201).json({
      ok: true, id: created.id, status: created.status, existing: created.existing,
      parked_until: started.parked_until || null, message,
    });
  } catch (e) { console.error('[b243] parent book:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

/** GET /pdf/:id — the finished document, for the family who own it. */
parentRouter.get('/pdf/:id', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const check = await loadCheck(db, id);
    if (!check) return res.status(404).json({ error: 'Not found' });
    const mine = await parentChildren(db, email);
    if (!mine.some(c => c.id === check.child_id)) return res.status(403).json({ error: 'Not your child' });
    // Only a b243 check a practitioner has actually sent. A draft is not theirs
    // yet, and a legacy row is not this endpoint's to serve (see the note in
    // /context above).
    if (check.status !== 'sent') {
      return res.status(403).json({ error: 'This check has not been sent to you yet.' });
    }

    const buf = await writePdf(db, check);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      (req.query.download === '1' ? 'attachment' : 'inline') +
      '; filename="' + reportFilename(renderable(check)).replace(/"/g, '') + '"');
    res.end(buf);
  } catch (e) { console.error('[b243] parent pdf:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

module.exports = router;
module.exports.parentRouter = parentRouter;
module.exports.renderable = renderable;
module.exports.runDraft = runDraft;
