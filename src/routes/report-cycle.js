'use strict';
/**
 * report-cycle.js — b244 (2026-08-28). Mounted at /api/report-cycle.
 *
 * The reports each child is owed and when, and the one write this build has:
 * moving a report between the three statuses.
 *
 * Everything here is a read over src/lib/report-cycle.js, which derives the
 * schedule from children.start_date / date_of_birth, the documents already in
 * reports and parent_reports, and b238's observations.termly_update flag. There
 * is no state of its own to get out of step.
 *
 * ── WHAT THIS ROUTE DOES NOT DO ─────────────────────────────────────────────
 * It does not generate report content, and there is no endpoint here that could.
 * The 2-year check is drafted when a family books their appointment (b243) and
 * signed by a key person; the other three are written by practitioners. b244
 * schedules and chases. A "draft everything that is overdue" button is exactly
 * the feature that would turn a nursery's own words into a model's, so it is
 * absent rather than disabled.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Child developmental records by name. Same class as /api/reports and
 * /api/two-year-check: staff session required, and the mount is listed in
 * server-unified.js's PARENT_DENY / HR_DENY / on-site / off-site sets alongside
 * them. A practitioner who is not a manager sees their own key children by
 * default — the same rule the b93 report tracker applies, so the two surfaces
 * do not disagree about who may see whom.
 */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const RC = require('../lib/report-cycle');

router.use(authenticate);

const LEAD_ROLES = ['manager', 'deputy_manager', 'admin', 'room_leader', 'senior_practitioner'];
const isLead = req => LEAD_ROLES.includes(req.user && req.user.role);

/**
 * Who is this request allowed to see?
 *
 * A lead sees the setting. Anyone else sees their own key children — not their
 * room. A room filter would show a practitioner every child in the room whether
 * or not the reports are theirs to write, and the board's whole job is "what do
 * *I* owe".
 */
function scopeFor(req) {
  const q = req.query || {};
  const scope = {};
  if (q.room_id && /^\d+$/.test(q.room_id)) scope.room_id = parseInt(q.room_id, 10);
  if (isLead(req)) {
    if (q.mine === '1' || q.mine === 'true') scope.key_person_id = req.user.id;
    else if (q.key_person_id && /^\d+$/.test(q.key_person_id)) scope.key_person_id = parseInt(q.key_person_id, 10);
  } else {
    // Not negotiable by query string.
    scope.key_person_id = req.user.id;
  }
  return scope;
}

// ── GET /formats — the four formats, the three statuses, the cadence ─────────
// Reference data for the UI so the page does not carry a second copy of the
// schedule that could drift from the library's.
router.get('/formats', async (req, res) => {
  try {
    const cfg = await RC.loadConfig(getPool());
    res.json({
      formats: RC.FORMATS.map(f => ({
        key: f.key, label: f.label, blurb: f.blurb, aka: f.aka || [],
        repeating: !!f.repeating, once: !!f.once,
        from_observations: !!f.from_observations,
        // b246 — true for the termly update alone: its cadence comes from
        // ladn.school_terms, not from this child's own dates.
        on_school_terms: !!f.on_school_terms,
      })),
      statuses: RC.STATUSES,
      room_cycles: RC.ROOM_CYCLES,
      config: cfg,
    });
  } catch (e) {
    console.error('report-cycle formats:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /due — the board ─────────────────────────────────────────────────────
// One row per slot that needs a human, overdue first. ?upcoming=1 adds slots
// falling due inside the horizon; ?states=overdue,due narrows it.
router.get('/due', async (req, res) => {
  try {
    const db = getPool();
    const schedule = await RC.buildSchedule(db, Object.assign(scopeFor(req), {
      on: /^\d{4}-\d{2}-\d{2}$/.test(req.query.on || '') ? req.query.on : undefined,
    }));
    const states = String(req.query.states || '').split(',').map(s => s.trim()).filter(Boolean);
    const rows = RC.dueRows(schedule, {
      include_upcoming: req.query.upcoming === '1' || req.query.upcoming === 'true',
      states: states.length ? states : undefined,
    });

    // Counts the header shows, and the per-key-person split that makes the board
    // actionable rather than a list of 40 names.
    const byFormat = {}, byKeyPerson = {};
    const counts = { overdue: 0, due: 0, in_progress: 0, upcoming: 0 };
    for (const r of rows) {
      counts[r.state] = (counts[r.state] || 0) + 1;
      const f = (byFormat[r.format] = byFormat[r.format] ||
        { format: r.format, label: r.format_label, overdue: 0, due: 0, in_progress: 0, upcoming: 0 });
      f[r.state] = (f[r.state] || 0) + 1;
      const kpKey = r.key_person_id == null ? 'none' : String(r.key_person_id);
      const kp = (byKeyPerson[kpKey] = byKeyPerson[kpKey] ||
        { key_person_id: r.key_person_id, key_person_name: r.key_person_name || 'No key person',
          overdue: 0, due: 0, in_progress: 0, upcoming: 0 });
      kp[r.state] = (kp[r.state] || 0) + 1;
    }

    res.json({
      on: schedule.on,
      rows,
      counts,
      by_format: Object.values(byFormat),
      by_key_person: Object.values(byKeyPerson)
        .sort((a, b) => (b.overdue - a.overdue) || (b.due - a.due)),
      children_considered: schedule.children.length,
      // Surfaced, not swallowed: a document whose format could not be worked out
      // is a document that will not satisfy its slot, and the board would chase a
      // report that already exists. If this number moves, the title normalisation
      // in src/lib/report-cycle.js has drifted behind what staff are typing.
      unmapped: schedule.unmapped,
      termly_available: schedule.termly_available,
      // b246 — the termly rows are the one format on this board anchored to the
      // school calendar rather than to the child. Saying WHICH half-term they are
      // judged against is what stops a due date looking arbitrary.
      termly_cycle: schedule.termly_cycle
        ? { key: schedule.termly_cycle.key, label: schedule.termly_cycle.label,
            term_start: schedule.termly_cycle.term_start, term_end: schedule.termly_cycle.term_end,
            due_on: schedule.termly_cycle.due_on, overdue_on: schedule.termly_cycle.overdue_on }
        : null,
      termly_anchor: schedule.termly_anchor || null,
    });
  } catch (e) {
    console.error('report-cycle due:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /child/:id — one child's whole cycle, past and future ────────────────
router.get('/child/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'child id required' });
  try {
    const db = getPool();
    if (!isLead(req)) {
      const { rows } = await db.query('SELECT key_person_id FROM children WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      if (rows[0].key_person_id !== req.user.id) {
        return res.status(403).json({ error: 'This is not one of your key children.' });
      }
    }
    const schedule = await RC.buildSchedule(db, { child_ids: [id] });
    if (!schedule.children.length) return res.status(404).json({ error: 'Not found' });

    // Every cycle document on file, so the page can show what HAS been done
    // rather than only what is outstanding.
    const { docs } = await RC.gatherDocuments(db, [id]);
    res.json({
      on: schedule.on,
      child: schedule.children[0],
      history: docs
        .filter(d => d.child_id === id)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
        .map(d => ({ id: d.id, table: d.table, format: d.format,
                     label: RC.FORMAT_BY_KEY[d.format].label,
                     status: d.status, date: d.date, title: d.title })),
    });
  } catch (e) {
    console.error('report-cycle child:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /report/:id/status — move a report between the three statuses ──────
// The one write in b244. A report sits in Draft while it is being written,
// Pending Parent Review once it has gone to the family, Completed when the
// conversation has happened. Only the last two satisfy a slot.
//
// reports rows only. parent_reports has its own status vocabulary and its own
// editor (the summative report screen); reaching across and rewriting it from
// here would give one row two owners.
router.patch('/report/:id/status', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = String((req.body && req.body.status) || '').trim().toLowerCase();
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'report id required' });
  if (!RC.STATUS_KEYS.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${RC.STATUS_KEYS.join(', ')}` });
  }
  try {
    const db = getPool();
    const { rows: found } = await db.query(
      'SELECT id, child_id, report_type FROM reports WHERE id=$1', [id]);
    if (!found.length) return res.status(404).json({ error: 'Not found' });

    if (!isLead(req)) {
      const { rows } = await db.query('SELECT key_person_id FROM children WHERE id=$1', [found[0].child_id]);
      if (!rows.length || rows[0].key_person_id !== req.user.id) {
        return res.status(403).json({ error: 'This is not one of your key children.' });
      }
    }

    // updated_at exists from b243 and is what the PDF cache in src/routes/reports.js
    // compares against pdf_generated_at. Touching it here means a status change
    // that the renderer shows (it prints the status) re-renders rather than
    // serving a stale file.
    const { rows } = await db.query(
      `UPDATE reports SET lifecycle_status = $2, updated_at = now()
        WHERE id = $1
       RETURNING id, child_id, report_type, lifecycle_status, updated_at`, [id, status]);
    res.json({ ok: true, report: rows[0] });
  } catch (e) {
    console.error('report-cycle status:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
