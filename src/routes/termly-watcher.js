'use strict';
/**
 * termly-watcher.js — b277 (2026-09-04). Mounted at /api/termly-watcher.
 *
 * The tracker Toby asked for ("has its own tracker, so we can keep track of
 * staff sending them out on time"), the termly report of missed dates, and the
 * controls for the watcher itself.
 *
 * ── WHY A SECOND ROUTER AND NOT MORE OF b246's ──────────────────────────────
 * src/routes/termly-update.js is the DOCUMENT: one child, one draft, review and
 * send. This is the MANAGEMENT VIEW: every child at once, aggregated by staff
 * member and by room, plus the watcher's own switches. They have different
 * shapes, different gating (b246 gates on the key-person relationship, half of
 * this is manager-only) and different audiences. Bolting the second onto the
 * first would have meant editing a 952-line router that already works.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Staff session required. Child developmental data by name, so the mount is
 * listed in server-unified.js's PARENT_DENY / HR_DENY / OFFSITE_CHILD sets
 * alongside 'termly-update', 'report-cycle' and 'reports'.
 *
 * Within that: a non-lead sees the tracker scoped to their own key children —
 * the same rule as b246's queue — and the manager-only surfaces (the termly
 * report, the source preview, running the watcher by hand) 403.
 *
 * Gating is on ROLE, not on a capability, for the reason recorded in
 * memory/reference_hascapability_ignores_level.md: hasCapability() ignores the
 * level, so a 'view' grant of reports.send-to-parents would open every write
 * gate here. Roles are what b243, b244 and b246 all use for this class of data.
 */

const express = require('express');
const router = express.Router();

const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const TU = require('../lib/termly-update');
const TC = require('../lib/termly-cycle');
const TS = require('../lib/termly-sources');
const TT = require('../services/termly-tracker');
const TW = require('../services/termly-watcher');

const MANAGER_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager']);
const LEAD_ROLES = new Set([...MANAGER_ROLES, 'room_leader', 'senior_practitioner']);
const isManager = u => !!(u && MANAGER_ROLES.has(u.role));
const isLead = u => !!(u && LEAD_ROLES.has(u.role));

function requireEyfsEdition(req, res, next) {
  if (!TU.isEyfsEdition()) {
    return res.status(404).json({ error: 'Progress updates apply to early years settings only.' });
  }
  next();
}
function requireManager(req, res, next) {
  if (!isManager(req.user)) {
    return res.status(403).json({ error: 'Manager access only — this is the whole setting\'s data.' });
  }
  next();
}

router.use(requireEyfsEdition);
router.use(authenticate);

const onParam = req => (/^\d{4}-\d{2}-\d{2}$/.test(req.query.on || '') ? req.query.on : null);
const cycleParam = req => (typeof req.query.cycle_key === 'string' && req.query.cycle_key.trim()
  ? req.query.cycle_key.trim() : null);

// ═══════════════════════════════════════════════════════════════════════════
// GET /status — is the watcher on, what is it listening to, when did it last run
// ═══════════════════════════════════════════════════════════════════════════
router.get('/status', async (req, res) => {
  try {
    const db = getPool();
    const on = onParam(req) || TC.ymd(new Date());
    const [sourceCfg, watcherCfg, { cycles }] = await Promise.all([
      TS.loadSourceConfig(db), TW.loadWatcherConfig(db), TC.loadCycles(db),
    ]);
    const cycle = TC.currentCycle(cycles, on);

    // What the watcher has actually produced this cycle. Counts only.
    let produced = { total: 0, published: 0, awaiting_review: 0 };
    if (cycle) {
      const { rows } = await db.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status='sent')::int AS published,
               count(*) FILTER (WHERE status<>'sent')::int AS awaiting_review
          FROM reports
         WHERE report_type='termly_update' AND cycle_key=$1
           AND content->>'variant' = 'watched'`, [cycle.key]);
      produced = rows[0];
    }

    res.json({
      on,
      enabled: sourceCfg.enabled,
      release: watcherCfg.release,
      ai_home_ideas: watcherCfg.ai_home_ideas,
      model: watcherCfg.model || null,
      interval_minutes: watcherCfg.interval_minutes,
      next_steps_reminder_days: watcherCfg.next_steps_days,
      sources: TS.describeSources(sourceCfg),
      cycle: cycle ? { key: cycle.key, label: cycle.label, opens_on: cycle.opens_on,
                       due_on: cycle.due_on, overdue_on: cycle.overdue_on, closes_on: cycle.closes_on } : null,
      calendar: TC.calendarHealth(cycles, on),
      produced,
      // Said plainly rather than left for somebody to work out from the config.
      sovereignty: watcherCfg.ai_home_ideas
        ? 'The "ideas for home" section is written by the setting\'s own model on the Ascent. '
          + 'Everything else is the key person\'s words and the setting\'s records. No child data leaves the network.'
        : 'No AI is used. Every word of a watched update is the key person\'s own or comes from the setting\'s records.',
    });
  } catch (e) {
    console.error('termly-watcher status:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /tracker — who has done their termly updates, and were they on time
// ═══════════════════════════════════════════════════════════════════════════
router.get('/tracker', async (req, res) => {
  try {
    const db = getPool();
    // A practitioner sees their own key children and nobody else's. A lead sees
    // the room or the whole setting, and may narrow to one key person.
    const opts = { on: onParam(req), cycleKey: cycleParam(req) };
    if (!isLead(req.user)) opts.keyPersonId = req.user.id;
    else if (req.query.mine === '1') opts.keyPersonId = req.user.id;
    else if (/^\d+$/.test(req.query.key_person_id || '')) opts.keyPersonId = req.query.key_person_id;
    if (/^\d+$/.test(req.query.room_id || '')) opts.roomId = req.query.room_id;

    const out = await TT.trackerFor(db, opts);
    out.scope = isLead(req.user) ? (opts.keyPersonId ? 'key_person' : 'setting') : 'own_key_children';
    out.can_manage = isManager(req.user);
    res.json(out);
  } catch (e) {
    console.error('termly-watcher tracker:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /report — the termly report of missed dates, per staff member
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Manager-only, and not because the numbers are secret — because this is the
 * view that names one practitioner's lateness to another, which is a
 * supervision conversation and not a staffroom one.
 *
 * ?academic_year=2026-2027 rolls up every half-term that has opened, which is
 * the version that answers "who is habitually late" rather than "who was late
 * the week they were off".
 */
router.get('/report', requireManager, async (req, res) => {
  try {
    const db = getPool();
    const year = /^\d{4}-\d{4}$/.test(req.query.academic_year || '') ? req.query.academic_year : null;
    const out = await TT.termReport(db, {
      on: onParam(req), cycleKey: year ? null : cycleParam(req), academicYear: year,
    });
    res.json(out);
  } catch (e) {
    console.error('termly-watcher report:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /sources/preview — ⚠ the tool that closes the EyLog tag gap
// ═══════════════════════════════════════════════════════════════════════════
/**
 * EyLog hands Wren its observation tags as bare numeric ids with no dictionary,
 * so "which id means termly update" cannot be read anywhere — but it CAN be
 * counted. This returns, for a half-term, how many observations and how many
 * DISTINCT CHILDREN each tag touched. The termly tag is the one whose child
 * count is close to the roll.
 *
 * Counts only: no text, no names, no child ids.
 */
router.get('/sources/preview', requireManager, async (req, res) => {
  try {
    const db = getPool();
    const on = onParam(req) || TC.ymd(new Date());
    const { cycles } = await TC.loadCycles(db);
    const cycle = cycleParam(req) ? TC.cycleByKey(cycles, cycleParam(req)) : TC.currentCycle(cycles, on);
    if (!cycle) return res.status(409).json({ error: 'No termly-update cycle covers this date.' });
    const cfg = await TS.loadSourceConfig(db);
    const out = await TS.previewSources(db, cycle, { config: cfg, window_to: on });
    out.configured = TS.describeSources(cfg);
    res.json(out);
  } catch (e) {
    console.error('termly-watcher preview:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /run — run the watcher now
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The sweep runs hourly on its own; this is for the two cases where waiting is
 * wrong: straight after the EyLog sync when somebody wants to see the result,
 * and with dry=1 to answer "what would this do?" before turning a source on.
 *
 * dry=1 is the safe default in spirit — nothing is written and the response
 * carries ids only.
 */
router.post('/run', requireManager, async (req, res) => {
  try {
    const db = getPool();
    const body = req.body || {};
    const dry = body.dry === true || body.dry === '1' || req.query.dry === '1';
    const out = await TW.sweep(db, {
      on: /^\d{4}-\d{2}-\d{2}$/.test(body.on || '') ? body.on : null,
      cycleKey: typeof body.cycle_key === 'string' && body.cycle_key.trim() ? body.cycle_key.trim() : null,
      dryRun: dry,
      force: body.force === true,
      limit: body.limit,
    });
    res.json(out);
  } catch (e) {
    console.error('termly-watcher run:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /run/next-steps — the end-of-term next-steps nudge, on demand.
router.post('/run/next-steps', requireManager, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await TW.nextStepsSweep(getPool(), {
      on: /^\d{4}-\d{2}-\d{2}$/.test(body.on || '') ? body.on : null,
      cycleKey: typeof body.cycle_key === 'string' && body.cycle_key.trim() ? body.cycle_key.trim() : null,
      force: body.force === true,
    });
    res.json(out);
  } catch (e) {
    console.error('termly-watcher next-steps:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /run/report — send the half-term's staff report to the managers now.
router.post('/run/report', requireManager, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await TW.managerReportSweep(getPool(), {
      on: /^\d{4}-\d{2}-\d{2}$/.test(body.on || '') ? body.on : null,
      cycleKey: typeof body.cycle_key === 'string' && body.cycle_key.trim() ? body.cycle_key.trim() : null,
      force: body.force === true,
    });
    res.json(out);
  } catch (e) {
    console.error('termly-watcher report run:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /child/:childId — run the watcher for one child
// ═══════════════════════════════════════════════════════════════════════════
/**
 * "I ticked the box and nothing happened." A key person may run their own child;
 * a lead may run anyone's. It is the same processCompletion() the hook and the
 * sweep use, so it cannot produce a different document — and it refuses when
 * there is no completion, rather than manufacturing one.
 */
router.post('/child/:childId', async (req, res) => {
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'child id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT id, key_person_id FROM children WHERE id = $1', [childId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (!isLead(req.user) && Number(rows[0].key_person_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'This is not one of your key children.' });
    }
    const out = await TW.sweep(db, {
      on: (req.body && /^\d{4}-\d{2}-\d{2}$/.test(req.body.on)) ? req.body.on : null,
      cycleKey: (req.body && typeof req.body.cycle_key === 'string' && req.body.cycle_key.trim())
        ? req.body.cycle_key.trim() : null,
      childIds: [childId],
      dryRun: !!(req.body && (req.body.dry === true || req.body.dry === '1')),
      force: true,   // an explicit ask overrides the master switch being off
    });
    if (out.ran && (!out.results || !out.results.length)) {
      return res.status(200).json(Object.assign(out, {
        nothing_to_do: 'No completed progress update was found for this child in this half-term, '
          + 'or one has already been made. Tick "Progress Update & Tracking" on the observation first.',
      }));
    }
    res.json(out);
  } catch (e) {
    console.error('termly-watcher child run:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
