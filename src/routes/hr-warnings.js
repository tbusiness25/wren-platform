'use strict';
/* ===========================================================================
 * hr-warnings.js (route) — b366 (2026-09-29)
 *
 * The attendance triggers screen, and the sweep behind it.
 *
 *   GET    /stages                 the stages and their thresholds
 *   PUT    /stages/:key            manager: threshold, lookback, on/off, letter
 *   POST   /run                    manager: evaluate everyone now (idempotent)
 *   GET    /triggers               manager: the drafts and what happened to them
 *   GET    /triggers/:id           manager: one, with the absences behind it
 *   PUT    /triggers/:id/letter    manager: edit the draft before approving
 *   PUT    /triggers/:id/stage     manager: move a draft to another stage (re-writes the letter)
 *   POST   /triggers/:id/approve   manager: tell the person, open the case
 *   POST   /triggers/:id/dismiss   manager: no, with a reason
 *   GET    /watchlist              manager: every active person's current score
 *   GET    /my                     a person reading their OWN issued letters
 *
 * THE ONE RULE THIS FILE ENFORCES
 * Nothing reaches the staff member until a named human has approved that
 * specific draft. /run cannot notify a staff member — it has no code path that
 * does — and approve is the only thing that writes staff_notified_at. See
 * src/lib/hr-warnings.js for why the auto-send switch ships off.
 *
 * Approving opens a disciplinary case at the INVITATION step, never at an
 * outcome. src/routes/discipline.js refuses an outcome without an invitation
 * and a meeting on record, and this route must not be the back door round it.
 * =========================================================================== */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const HRW = require('../lib/hr-warnings');
const { notify } = require('../services/notification-dispatcher');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
const isManager = req => MANAGER_ROLES.includes(req.user && req.user.role);
const KINDS = ['bradford', 'lateness'];

router.use(authenticate);

function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    console.error('[hr-warnings]', req.method, req.path, e.message);
    res.status(e.status || 500).json({ error: e.message });
  });
}

async function setting(db, key, fallback) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows.length ? rows[0].value : fallback;
  } catch (_) { return fallback; }
}

async function loadStages(db) {
  const { rows } = await db.query(
    `SELECT * FROM ${SCHEMA()}.hr_warning_stages ORDER BY sort_order, threshold`);
  return rows;
}

/** The setting's own name, for the letter's sign-off. */
async function settingName(db) {
  return (await setting(db, 'setting_name', null)) || 'Your Nursery';
}

// ── GET /stages ─────────────────────────────────────────────────────────────
router.get('/stages', wrap(async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  const [stages, enabled, grace] = await Promise.all([
    loadStages(db),
    setting(db, 'hr_warnings_enabled', 'false'),
    setting(db, 'lateness_grace_minutes', '5'),
  ]);
  res.json({
    enabled: String(enabled) === 'true',
    lateness_grace_minutes: Number(grace) || 5,
    stages,
    kinds: KINDS,
    tokens: ['first_name', 'last_name', 'full_name', 'score', 'threshold', 'instances',
             'days', 'lookback_weeks', 'window_from', 'window_to', 'manager_name',
             'setting_name', 'today'],
    // Said on the screen, not buried in a commit message.
    caveat: 'A Bradford Factor score is a screening tool, not a judgement. It scores four '
          + 'short colds higher than one long certified illness — that is what it is for, and '
          + 'also its limit. Absence connected to a disability, a pregnancy or ongoing '
          + 'treatment needs a person to read the record, not a threshold.',
  });
}));

// ── PUT /stages/:key ────────────────────────────────────────────────────────
router.put('/stages/:key', wrap(async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body || {};
  const sets = [], vals = [];
  const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

  if (b.threshold !== undefined) {
    const n = Number(b.threshold);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'threshold must be 1 or more' });
    put('threshold', Math.round(n));
  }
  if (b.lookback_weeks !== undefined) {
    const n = Number(b.lookback_weeks);
    if (!Number.isFinite(n) || n < 1 || n > 260) return res.status(400).json({ error: 'lookback_weeks must be between 1 and 260' });
    put('lookback_weeks', Math.round(n));
  }
  if (typeof b.is_active === 'boolean') put('is_active', b.is_active);
  if (typeof b.auto_send === 'boolean') put('auto_send', b.auto_send);
  if (b.letter_template !== undefined) put('letter_template', String(b.letter_template || '').slice(0, 20000));
  if (b.label !== undefined && String(b.label).trim()) put('label', String(b.label).trim().slice(0, 120));
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

  put('updated_by', req.user.id);
  sets.push('updated_at = now()');
  vals.push(req.params.key);
  const db = getPool();
  const { rows } = await db.query(
    `UPDATE ${SCHEMA()}.hr_warning_stages SET ${sets.join(', ')} WHERE stage_key = $${vals.length} RETURNING *`, vals);
  if (!rows.length) return res.status(404).json({ error: 'No such stage' });

  await recordAudit({ req, action: 'update', entity_type: 'hr_warning_stage', entity_id: rows[0].id,
    meta: { stage_key: rows[0].stage_key, is_active: rows[0].is_active, threshold: rows[0].threshold,
            auto_send: rows[0].auto_send } }).catch(() => {});
  res.json(rows[0]);
}));

// ── PUT /enabled ────────────────────────────────────────────────────────────
router.put('/enabled', wrap(async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const on = req.body && req.body.enabled === true;
  const db = getPool();
  await db.query(
    `INSERT INTO ${SCHEMA()}.settings (key, value) VALUES ('hr_warnings_enabled', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [on ? 'true' : 'false']);
  await recordAudit({ req, action: 'update', entity_type: 'setting', entity_id: 0,
    meta: { key: 'hr_warnings_enabled', value: on } }).catch(() => {});
  res.json({ enabled: on });
}));

// ═══════════════════════════════════════════════════════════════════════════
// THE SWEEP
//
// Idempotent by construction: the partial unique index on (staff_id, stage_key)
// WHERE status IN ('draft','approved') means a second run the same night, or a
// second run five minutes later, adds nothing. A stage that was DISMISSED can
// be raised again, but only after a FRESH absence (or late arrival) since the
// dismissal — a dismissal is a judgement about a moment, not a permanent
// exemption, and not something to be re-asked the next morning either. The
// same rule, and the stage ladder, live in HRW.loadHistory / HRW.evaluate
// (2026-10-01: before that this comment described a check nothing made).
//
// WHERE THIS RUNS: in-process, once a London day at/after 06:00 — see the
// nightly block at the bottom of this file — and by POST /run.
// ═══════════════════════════════════════════════════════════════════════════
async function sweep(db, { byStaffId, only } = {}) {
  const enabled = String(await setting(db, 'hr_warnings_enabled', 'false')) === 'true';
  const stages = (await loadStages(db)).filter(s => s.is_active);
  if (!enabled) return { ran: false, reason: 'hr_warnings_enabled is off', drafted: [], considered: 0 };
  if (!stages.length) return { ran: false, reason: 'no stage is switched on', drafted: [], considered: 0 };

  const grace = Number(await setting(db, 'lateness_grace_minutes', '5')) || 5;
  const today = HRW.londonToday();
  const manager = await settingName(db);

  const params = [];
  let clause = '';
  if (only) { params.push(only); clause = ' AND s.id = $1'; }
  const { rows: staff } = await db.query(
    `SELECT s.id, s.first_name, s.last_name FROM ${SCHEMA()}.staff s
      WHERE s.is_active = true AND COALESCE(s.role,'') <> 'parent' ${clause}
      ORDER BY s.id`, params);

  const drafted = [];
  for (const person of staff) {
    let crossings;
    try {
      const history = await HRW.loadHistory(db, person.id, today);
      crossings = await HRW.evaluate(db, person.id, stages, { today, graceMinutes: grace, history });
    } catch (e) {
      console.error('[hr-warnings] evaluate staff', person.id, e.message);
      continue;
    }
    for (const c of crossings) {
      const st = c.stage, m = c.measurement;
      const letter = HRW.renderLetter(st.letter_template, {
        first_name: person.first_name,
        last_name: person.last_name,
        full_name: `${person.first_name} ${person.last_name}`.trim(),
        score: m.score,
        threshold: st.threshold,
        instances: m.instances,
        days: m.days,
        lookback_weeks: m.weeks,
        window_from: m.from,
        window_to: m.to,
        manager_name: 'Nursery Manager',
        setting_name: manager,
        today,
      });

      // ON CONFLICT DO NOTHING against the partial unique index: if this person
      // already has a live draft or an approved-but-unissued letter for this
      // stage, nothing happens and nobody is told a second time.
      const { rows } = await db.query(`
        INSERT INTO ${SCHEMA()}.hr_warning_triggers
          (staff_id, stage_key, kind, score, threshold, lookback_weeks,
           window_from, window_to, detail, letter_body, status, detected_on)
        VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9::jsonb,$10,'draft',$11::date)
        ON CONFLICT (staff_id, stage_key) WHERE status IN ('draft','approved') DO NOTHING
        RETURNING *`,
        [person.id, st.stage_key, st.kind, m.score, st.threshold, m.weeks,
         m.from, m.to,
         JSON.stringify({ instances: m.instances, days: m.days,
                          episodes: m.episodes || undefined, occurrences: m.occurrences || undefined }),
         letter, today]);
      if (!rows.length) continue;   // already raised — say nothing again

      const t = rows[0];
      drafted.push({ id: t.id, staff_id: person.id, stage_key: st.stage_key, score: m.score });

      // → THE MANAGER, and only the manager. There is deliberately no branch
      //   here that can notify `person.id`.
      const managerId = Number(await setting(db, 'hr_warnings_manager_staff_id', '1')) || 1;
      try {
        notify('hr_warning_stage_reached', 'staff', managerId,
          `${person.first_name} ${person.last_name} — ${st.label}`,
          st.kind === 'lateness'
            ? `${m.instances} late arrivals in the last ${m.weeks} weeks (trigger ${st.threshold}). A draft letter is waiting for you to read. ${person.first_name} has not been told.`
            : `Bradford Factor ${m.score} over ${m.weeks} weeks — ${m.instances} absences, ${m.days} days (trigger ${st.threshold}). A draft letter is waiting for you to read. ${person.first_name} has not been told.`,
          { priority: 'normal', relatedTable: 'hr_warning_triggers', relatedId: t.id,
            link: '/staff/absence-warnings.html' });
        await db.query(
          `UPDATE ${SCHEMA()}.hr_warning_triggers SET manager_notified_at = now() WHERE id = $1`, [t.id]);
      } catch (e) {
        console.error('[hr-warnings] notify manager:', e.message);
      }
    }
  }
  return { ran: true, considered: staff.length, stages: stages.length, drafted };
}

router.post('/run', wrap(async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const only = req.body && req.body.staff_id ? Number(req.body.staff_id) : null;
  const out = await sweep(getPool(), { only });
  await recordAudit({ req, action: 'run', entity_type: 'hr_warning_sweep', entity_id: 0,
    meta: { drafted: out.drafted.length, ran: out.ran } }).catch(() => {});
  res.json(out);
}));

// ── GET /triggers ───────────────────────────────────────────────────────────
router.get('/triggers', wrap(async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  const params = [];
  const where = [];
  if (req.query.status) { params.push(String(req.query.status)); where.push(`t.status = $${params.length}`); }
  else where.push(`t.status IN ('draft','approved')`);
  if (req.query.staff_id) { params.push(Number(req.query.staff_id)); where.push(`t.staff_id = $${params.length}`); }
  const { rows } = await db.query(`
    SELECT t.id, t.staff_id, t.stage_key, t.kind, t.score, t.threshold, t.lookback_weeks,
           t.window_from, t.window_to, t.status, t.detected_on, t.manager_notified_at,
           t.approved_at, t.staff_notified_at, t.dismissed_at, t.dismissed_reason, t.case_id,
           t.detail,
           s.first_name || ' ' || s.last_name AS staff_name, s.job_title, s.role,
           st.label AS stage_label, st.outcome_key,
           ap.first_name || ' ' || ap.last_name AS approved_by_name,
           dm.first_name || ' ' || dm.last_name AS dismissed_by_name
      FROM ${SCHEMA()}.hr_warning_triggers t
      JOIN ${SCHEMA()}.staff s ON s.id = t.staff_id
      LEFT JOIN ${SCHEMA()}.hr_warning_stages st ON st.stage_key = t.stage_key
      LEFT JOIN ${SCHEMA()}.staff ap ON ap.id = t.approved_by
      LEFT JOIN ${SCHEMA()}.staff dm ON dm.id = t.dismissed_by
     WHERE ${where.join(' AND ')}
     ORDER BY (t.status = 'draft') DESC, t.detected_on DESC, t.id DESC
     LIMIT 300`, params);
  res.json(rows);
}));

// ── GET /triggers/:id ───────────────────────────────────────────────────────
router.get('/triggers/:id', wrap(async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  const { rows } = await db.query(`
    SELECT t.*, s.first_name || ' ' || s.last_name AS staff_name, s.job_title,
           st.label AS stage_label, st.outcome_key, st.auto_send
      FROM ${SCHEMA()}.hr_warning_triggers t
      JOIN ${SCHEMA()}.staff s ON s.id = t.staff_id
      LEFT JOIN ${SCHEMA()}.hr_warning_stages st ON st.stage_key = t.stage_key
     WHERE t.id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}));

// ── PUT /triggers/:id/letter — edit the draft ───────────────────────────────
router.put('/triggers/:id/letter', wrap(async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const body = String((req.body || {}).letter_body || '');
  if (!body.trim()) return res.status(400).json({ error: 'The letter cannot be empty' });
  const db = getPool();
  const { rows } = await db.query(`
    UPDATE ${SCHEMA()}.hr_warning_triggers SET letter_body = $1, updated_at = now()
     WHERE id = $2 AND status = 'draft' RETURNING id, status`,
    [body.slice(0, 20000), req.params.id]);
  if (!rows.length) return res.status(409).json({ error: 'Only a draft can be edited' });
  res.json(rows[0]);
}));

// ── PUT /triggers/:id/stage — move a draft up or down the ladder ────────────
// 2026-10-01. The sweep starts everyone with no live warning at the bottom of
// the ladder; this is how a manager records that a person is further up it
// (a warning given before Wren held them), or brings an over-graded draft
// down. The score is re-measured over the new stage's lookback to the same end
// date and the letter is RE-WRITTEN from that stage's template — any hand edits
// to the old draft are replaced, and the screen says so before it does it.
async function restage(db, id, stageKey, { req = null, actorId = null } = {}) {
  const { rows: tr } = await db.query(`
    SELECT t.*, s.first_name, s.last_name
      FROM ${SCHEMA()}.hr_warning_triggers t
      JOIN ${SCHEMA()}.staff s ON s.id = t.staff_id
     WHERE t.id = $1`, [id]);
  if (!tr.length) throw Object.assign(new Error('Not found'), { status: 404 });
  const t = tr[0];
  if (t.status !== 'draft') throw Object.assign(new Error('Only a draft can change stage'), { status: 409 });
  const st = (await loadStages(db)).find(s => s.stage_key === stageKey);
  if (!st) throw Object.assign(new Error('No such stage'), { status: 400 });
  if (st.kind !== t.kind) throw Object.assign(new Error(`That stage measures ${st.kind}, this draft measures ${t.kind}`), { status: 400 });
  if (st.stage_key === t.stage_key) return t;

  const to = HRW.ymd(t.window_to) || HRW.londonToday();
  const weeks = Number(st.lookback_weeks) || 52;
  const from = HRW.weeksBefore(to, weeks);
  const grace = Number(await setting(db, 'lateness_grace_minutes', '5')) || 5;
  const m = st.kind === 'lateness'
    ? await HRW.lateCount(db, t.staff_id, from, to, grace)
    : await HRW.bradford(db, t.staff_id, from, to);
  if (m.score < Number(st.threshold)) {
    throw Object.assign(new Error(`${t.first_name}'s score is ${m.score} — below the ${st.label} trigger of ${st.threshold}`), { status: 400 });
  }
  const letter = HRW.renderLetter(st.letter_template, {
    first_name: t.first_name, last_name: t.last_name,
    full_name: `${t.first_name} ${t.last_name}`.trim(),
    score: m.score, threshold: st.threshold, instances: m.instances, days: m.days,
    lookback_weeks: weeks, window_from: from, window_to: to,
    manager_name: 'Nursery Manager', setting_name: await settingName(db), today: HRW.londonToday(),
  });
  let rows;
  try {
    ({ rows } = await db.query(`
      UPDATE ${SCHEMA()}.hr_warning_triggers
         SET stage_key = $2, score = $3, threshold = $4, lookback_weeks = $5,
             window_from = $6::date, window_to = $7::date, detail = $8::jsonb,
             letter_body = $9, updated_at = now()
       WHERE id = $1 AND status = 'draft' RETURNING *`,
      [id, st.stage_key, m.score, st.threshold, weeks, from, to,
       JSON.stringify({ instances: m.instances, days: m.days,
                        episodes: m.episodes || undefined, occurrences: m.occurrences || undefined }),
       letter]));
  } catch (e) {
    if (e.code === '23505') throw Object.assign(new Error(`${t.first_name} already has an open ${st.label} letter`), { status: 409 });
    throw e;
  }
  if (!rows.length) throw Object.assign(new Error('Only a draft can change stage'), { status: 409 });
  await recordAudit({ req, action: 'update', entity_type: 'hr_warning_trigger', entity_id: Number(id),
    actor_id: actorId || undefined,
    diff: { stage_key: { from: t.stage_key, to: st.stage_key } },
    meta: { staff_id: t.staff_id, kind: t.kind, score: m.score } }).catch(() => {});
  return rows[0];
}

router.put('/triggers/:id/stage', wrap(async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const key = String((req.body || {}).stage_key || '');
  if (!key) return res.status(400).json({ error: 'stage_key is required' });
  const row = await restage(getPool(), req.params.id, key, { req });
  res.json(row);
}));

// ── POST /triggers/:id/approve ──────────────────────────────────────────────
// The ONLY path that tells the staff member anything.
router.post('/triggers/:id/approve', wrap(async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  const { rows: tr } = await db.query(`
    SELECT t.*, s.first_name, s.last_name, st.label AS stage_label, st.outcome_key
      FROM ${SCHEMA()}.hr_warning_triggers t
      JOIN ${SCHEMA()}.staff s ON s.id = t.staff_id
      LEFT JOIN ${SCHEMA()}.hr_warning_stages st ON st.stage_key = t.stage_key
     WHERE t.id = $1`, [req.params.id]);
  if (!tr.length) return res.status(404).json({ error: 'Not found' });
  const t = tr[0];
  if (t.status !== 'draft') return res.status(409).json({ error: `Already ${t.status}` });
  if (t.staff_id === req.user.id) {
    return res.status(400).json({ error: 'You cannot approve an attendance letter about yourself.' });
  }

  const openCase = (req.body || {}).open_case !== false;
  let caseId = null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // A disciplinary case, opened at the CONCERN step — which is what
    // discipline.js writes on create. It records the invitation as the next
    // thing due and records NO outcome: an outcome before a meeting is not a
    // record of a fair process, and discipline.js refuses one anyway.
    if (openCase) {
      const concern = t.kind === 'lateness'
        ? `Timekeeping: ${t.detail && t.detail.instances != null ? t.detail.instances : t.score} late arrivals in the ${t.lookback_weeks} weeks to ${HRW.ymd(t.window_to)}. Attendance trigger "${t.stage_label}" (${t.threshold}) reached.`
        : `Attendance: Bradford Factor ${t.score} in the ${t.lookback_weeks} weeks to ${HRW.ymd(t.window_to)} (${t.detail && t.detail.instances} absences, ${t.detail && t.detail.days} days). Attendance trigger "${t.stage_label}" (${t.threshold}) reached.`;
      const { rows: cs } = await client.query(`
        INSERT INTO ${SCHEMA()}.disciplinary_cases
          (staff_id, case_type, concern, opened_on, opened_by)
        VALUES ($1, 'capability', $2, CURRENT_DATE, $3) RETURNING id, opened_on`,
        [t.staff_id, concern, req.user.id]);
      caseId = cs[0].id;
      await client.query(`
        INSERT INTO ${SCHEMA()}.disciplinary_case_steps
          (case_id, step_key, occurred_on, summary, recorded_by)
        VALUES ($1, 'concern', $2::date, $3, $4)`,
        [caseId, HRW.ymd(cs[0].opened_on), concern, req.user.id]);
    }

    await client.query(`
      UPDATE ${SCHEMA()}.hr_warning_triggers
         SET status = 'approved', approved_by = $2, approved_at = now(),
             staff_notified_at = now(), case_id = $3, updated_at = now()
       WHERE id = $1`, [t.id, req.user.id, caseId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }

  // NOW the staff member is told — after a named human approved this letter.
  try {
    notify('hr_warning_issued', 'staff', t.staff_id,
      `${t.stage_label} — attendance`,
      'Your manager would like to talk to you about your attendance record. The letter is on '
      + 'your HR page under "My attendance". You have the right to be accompanied at any formal '
      + 'meeting by a trade union representative or a work colleague.',
      { priority: 'normal', relatedTable: 'hr_warning_triggers', relatedId: t.id,
        link: '/my-absences.html#attendance-letters' });
  } catch (e) { console.error('[hr-warnings] notify staff:', e.message); }

  await recordAudit({ req, action: 'approve', entity_type: 'hr_warning_trigger', entity_id: t.id,
    meta: { staff_id: t.staff_id, stage_key: t.stage_key, case_id: caseId } }).catch(() => {});
  res.json({ ok: true, id: t.id, status: 'approved', case_id: caseId,
    next: caseId ? 'Record the written invitation on the disciplinary case before the meeting.' : null });
}));

// ── POST /triggers/:id/dismiss ──────────────────────────────────────────────
router.post('/triggers/:id/dismiss', wrap(async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const reason = String((req.body || {}).reason || '').trim();
  // A dismissal with no reason is the defect this whole build exists to avoid:
  // in six months nobody can say whether the trigger was wrong or ignored.
  if (!reason) return res.status(400).json({ error: 'Say why — "certified, disability-related" or "already dealt with" is enough. It is the record of why no action was taken.' });
  const db = getPool();
  const { rows } = await db.query(`
    UPDATE ${SCHEMA()}.hr_warning_triggers
       SET status = 'dismissed', dismissed_by = $2, dismissed_at = now(),
           dismissed_reason = $3, updated_at = now()
     WHERE id = $1 AND status = 'draft'
     RETURNING id, staff_id, stage_key, status`, [req.params.id, req.user.id, reason.slice(0, 2000)]);
  if (!rows.length) return res.status(409).json({ error: 'Only a draft can be dismissed' });
  await recordAudit({ req, action: 'dismiss', entity_type: 'hr_warning_trigger', entity_id: rows[0].id,
    meta: { staff_id: rows[0].staff_id, stage_key: rows[0].stage_key, reason } }).catch(() => {});
  res.json(rows[0]);
}));

// ── GET /watchlist — where everybody stands right now ───────────────────────
// Scores only, computed live. No absence reasons, no notes: this is a screening
// list and it is read on a shared screen.
router.get('/watchlist', wrap(async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  const weeks = Math.min(260, Math.max(1, Number(req.query.weeks) || 52));
  const today = HRW.londonToday();
  const from = HRW.weeksBefore(today, weeks);
  const grace = Number(await setting(db, 'lateness_grace_minutes', '5')) || 5;
  const stages = await loadStages(db);
  const active = stages.filter(s => s.is_active);

  const { rows: staff } = await db.query(
    `SELECT id, first_name, last_name, job_title FROM ${SCHEMA()}.staff
      WHERE is_active = true AND COALESCE(role,'') <> 'parent' ORDER BY first_name, last_name`);

  const out = [];
  for (const p of staff) {
    const bf = await HRW.bradford(db, p.id, from, today);
    const lt = await HRW.lateCount(db, p.id, HRW.weeksBefore(today, 8), today, grace);
    // Which switched-on stage does each score currently sit at?
    const hit = kind => active
      .filter(s => s.kind === kind && (kind === 'lateness' ? lt.score : bf.score) >= Number(s.threshold))
      .sort((a, b) => Number(b.threshold) - Number(a.threshold))[0] || null;
    const bStage = hit('bradford'), lStage = hit('lateness');
    out.push({
      staff_id: p.id, name: `${p.first_name} ${p.last_name}`.trim(), job_title: p.job_title || null,
      bradford_score: bf.score, bradford_instances: bf.instances, bradford_days: bf.days,
      late_count_8w: lt.score,
      stage: bStage ? { key: bStage.stage_key, label: bStage.label, threshold: bStage.threshold } : null,
      lateness_stage: lStage ? { key: lStage.stage_key, label: lStage.label, threshold: lStage.threshold } : null,
    });
  }
  out.sort((a, b) => b.bradford_score - a.bradford_score || b.late_count_8w - a.late_count_8w);
  res.json({ window: { from, to: today, weeks }, lateness_window_weeks: 8, staff: out,
             stages_active: active.length });
}));

// ── GET /my — your own attendance letters ───────────────────────────────────
// Only the ones a manager approved. A draft about you is not a thing that
// exists as far as this endpoint is concerned, and that is the point.
router.get('/my', wrap(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT t.id, t.stage_key, t.kind, t.approved_at, t.staff_notified_at, t.letter_body,
           t.window_from, t.window_to, t.lookback_weeks, t.case_id,
           st.label AS stage_label
      FROM ${SCHEMA()}.hr_warning_triggers t
      LEFT JOIN ${SCHEMA()}.hr_warning_stages st ON st.stage_key = t.stage_key
     WHERE t.staff_id = $1 AND t.status IN ('approved','issued')
     ORDER BY t.approved_at DESC NULLS LAST, t.id DESC`, [req.user.id]);
  res.json({
    letters: rows,
    your_rights: [
      'You have the right to be accompanied at any formal meeting by a trade union representative or a work colleague.',
      'If any of your absences relate to a disability, a pregnancy, or treatment you are receiving, tell your manager — it must be taken into account before any decision.',
      'You have the right to appeal any disciplinary decision, in writing to your line manager.',
    ],
  });
}));

// ── 2026-10-01 — nightly sweep (Toby: "set the required level then turn on") ──────────
// In-process, like the other Wren jobs: no host cron, no login needed. Checks every 15 min
// and runs once per London day at/after 06:00. The master switch and the per-stage switches
// still decide everything — with hr_warnings_enabled off this does nothing. It only ever
// DRAFTS; a manager approves before a member of staff is told (unless a stage's auto_send
// is ticked). Guarded so a second container (dev) shares no state with prod: each reads its
// own database's settings row.
if (!global.__wrenHrWarningsNightly) {
  global.__wrenHrWarningsNightly = true;
  const tick = async () => {
    try {
      const db = getPool();
      const now = new Date();
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(now));
      if (hour < 6) return;
      const today = HRW.londonToday();
      const last = String(await setting(db, 'hr_warnings_last_sweep', ''));
      if (last === today) return;
      await db.query(`INSERT INTO ${SCHEMA()}.settings (key, value) VALUES ('hr_warnings_last_sweep', $1)
                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [today]);
      const out = await sweep(db, {});
      console.log(`[hr-warnings] nightly sweep ${today}: ran=${out.ran} considered=${out.considered} drafted=${(out.drafted || []).length}${out.reason ? ' (' + out.reason + ')' : ''}`);
    } catch (e) { console.error('[hr-warnings] nightly sweep failed:', e.message); }
  };
  setTimeout(tick, 60 * 1000);
  setInterval(tick, 15 * 60 * 1000).unref();
}

module.exports = router;
module.exports.sweep = sweep;
module.exports.restage = restage;
