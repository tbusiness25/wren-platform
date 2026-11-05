'use strict';
/**
 * termly-drafts.js — b359 (2026-09-29). Mounted at /api/termly-drafts.
 *
 *   "For the AI assisted planning, this can be per staff member (for their
 *    keychildren). It looks at ALL their previous observations and next steps,
 *    and writes new termly update as draft, based on kids interests and
 *    development. It can then add suggested resource cards/activities."
 *                                                        — Toby, 2026-09-29
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * It is NOT a second termly-update store, a second drafter or a second review
 * screen. b246 owns all three. A draft made here is an ordinary
 * ladn.reports(report_type='termly_update') row in status 'awaiting_review',
 * routed to the key person, opened at /ey/termly-update?id=…, edited and sent
 * through the endpoints that already exist. If you delete every row this file
 * writes, every draft it produced survives untouched.
 *
 * What is new is the RUN: one press of a button for a whole key-person
 * caseload, which needed three things b246 has no place for.
 *
 *  1 · IT MUST NOT TIME OUT.  Twenty children at ~40s of local inference each is
 *      thirteen minutes. No HTTP request survives that, and no practitioner
 *      should watch a spinner for it. So: POST /runs creates the run and returns
 *      immediately with one row per key child; the page then calls
 *      POST /runs/:id/step once per child and polls GET /runs/:id. One child per
 *      request, so a timeout costs one child and the progress bar is real rather
 *      than animated.
 *
 *  2 · A FAILURE MUST BE ONE CHILD'S.  Each item carries its own status and its
 *      own error. The Ascent falling over on child 11 leaves ten drafts standing
 *      and says so.
 *
 *  3 · NO NAME REACHES THE PROMPT.  b246 sends the child's first name and is
 *      entitled to — the Ascent is ours and sovereign-model.js refuses any host
 *      that is not a private IP literal. Toby's brief asks for more than that
 *      here, and it is worth having: src/lib/name-redact.js swaps every child
 *      and staff name for ⟪CHILD⟫ / ⟪ANOTHER CHILD⟫ / ⟪STAFF⟫ before the
 *      request and puts the subject's name back afterwards, on this server. The
 *      exact redacted prompt is stored on the item so the claim is checkable by
 *      reading the row instead of trusting this comment. A name that survives
 *      redaction fails that section rather than being sent.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Child developmental records by name — the same class as /api/termly-update,
 * /api/reports and /api/report-cycle, and listed beside them in
 * server-unified.js's PARENT_DENY / HR_DENY / on-site / off-site sets.
 *
 * Within that: you may run it for YOUR OWN key children; a manager, deputy,
 * admin, headteacher or room leader may run it for anyone. That is b246's
 * isLead()/key-person rule, borrowed rather than re-invented — see the
 * router._isLead hook at the bottom of src/routes/termly-update.js.
 */

const express = require('express');
const router = express.Router();

const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');

const TU = require('../lib/termly-update');
const TC = require('../lib/termly-cycle');
const SUG = require('../lib/termly-suggestions');
const NR = require('../lib/name-redact');
const ai = require('../lib/ai-models');

// b246's router, for its start/draft internals. Required lazily inside the
// handlers is unnecessary here (no require-time host assertion in that file),
// but the reference is resolved once so a typo shows up at boot, not at 3pm.
const TUROUTE = require('./termly-update');

// The card library loader — file-backed, shared with /api/resource-cards so the
// two can never disagree about which cards exist.
const CARDS = require('./resource-cards');

router.use(authenticate);

const REPORT_TYPE = 'termly_update';
const SUGGEST_TIMEOUT_MS = parseInt(process.env.TERMLY_SUGGEST_TIMEOUT_MS || '90000', 10);

function isLead(user) { return TUROUTE._isLead ? TUROUTE._isLead(user) : false; }

function learningOrAdminOnly(req, res, next) {
  const p = req._portal;
  if (p && p !== 'learning' && p !== 'admin') {
    return res.status(403).json({ error: 'Available on the EY and Roost portals only' });
  }
  next();
}
router.use(learningOrAdminOnly);

async function settingInt(db, key, dflt) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = $1`, [key]);
    const n = parseInt(rows[0] && rows[0].value, 10);
    return Number.isFinite(n) ? n : dflt;
  } catch (_) { return dflt; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Who this run is for
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Resolve the key person a request is about, and refuse politely if the caller
 * is not allowed to act for them. Returns { id } or null (response already sent).
 */
function resolveKeyPerson(req, res) {
  const asked = parseInt(req.query.staff_id || (req.body && req.body.staff_id), 10);
  if (!Number.isInteger(asked) || asked === Number(req.user.id)) return { id: Number(req.user.id), self: true };
  if (!isLead(req.user)) {
    res.status(403).json({ error: 'Only a manager or room leader can draft for someone else\'s key children.' });
    return null;
  }
  return { id: asked, self: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /context — everything the page needs before anyone presses a button
// ═══════════════════════════════════════════════════════════════════════════
router.get('/context', async (req, res) => {
  try {
    const db = getPool();
    const who = resolveKeyPerson(req, res);
    if (!who) return;

    const on = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.on || '')) ? req.query.on : TC.ymd(new Date());
    const { cycles, config } = await TC.loadCycles(db);
    const cycle = TC.currentCycle(cycles, on) || TC.nextCycle(cycles, on);

    // The key children, with how much there actually is to draft from. The
    // counts are COUNTS — no observation text crosses this endpoint.
    const { rows: kids } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.preferred_name, c.room_id,
             r.name AS room_name,
             to_char(c.start_date,'YYYY-MM-DD')  AS start_date,
             to_char(c.date_of_birth,'YYYY-MM-DD') AS date_of_birth,
             (SELECT count(*) FROM observations o
               WHERE o.child_id = c.id
                 AND COALESCE(o.review_status,'published') = 'published'
                 AND COALESCE(o.dsl_only,false) = false)                     AS obs_total,
             (SELECT count(*) FROM next_steps n
               WHERE n.child_id = c.id AND n.status = 'pending')             AS next_steps_open,
             (SELECT count(*) FROM reports rp
               WHERE rp.child_id = c.id AND rp.report_type = $2)             AS previous_updates,
             (SELECT rp2.id FROM reports rp2
               WHERE rp2.child_id = c.id AND rp2.report_type = $2
                 AND rp2.cycle_key = $3 LIMIT 1)                             AS this_cycle_report_id,
             (SELECT rp3.status FROM reports rp3
               WHERE rp3.child_id = c.id AND rp3.report_type = $2
                 AND rp3.cycle_key = $3 LIMIT 1)                             AS this_cycle_status
        FROM children c
        LEFT JOIN rooms r ON r.id = c.room_id
       WHERE c.key_person_id = $1
         AND COALESCE(c.is_active, true) = true
         AND (c.leave_date IS NULL OR c.leave_date > CURRENT_DATE)
       ORDER BY c.first_name, c.last_name`, [who.id, REPORT_TYPE, cycle ? cycle.key : '']);

    // Is the Ascent answering? Ask before anyone waits three minutes to find out.
    let reachable = false, probeError = null;
    try {
      const r = await fetch(`${ai.host()}/api/tags`, { signal: AbortSignal.timeout(4000) });
      reachable = r.ok;
      if (!r.ok) probeError = `Ollama answered ${r.status}`;
    } catch (e) { probeError = e.message; }

    const { rows: staffRows } = isLead(req.user)
      ? await db.query(`
          SELECT s.id, COALESCE(NULLIF(btrim(s.first_name || ' ' || COALESCE(s.last_name,'')), ''),
                                 'Staff #' || s.id) AS name,
                 s.role,
                 (SELECT count(*) FROM children c
                   WHERE c.key_person_id = s.id AND COALESCE(c.is_active,true) = true
                     AND (c.leave_date IS NULL OR c.leave_date > CURRENT_DATE)) AS key_children
            FROM staff s
           WHERE COALESCE(s.is_active, true) = true
           ORDER BY key_children DESC, name`)
      : { rows: [] };

    const { rows: recent } = await db.query(`
      SELECT r.id, r.key_person_id, r.status, r.cycle_key, r.cycle_label, r.child_total,
             r.started_at, r.finished_at, r.degraded, r.degraded_reason,
             (SELECT count(*) FROM termly_draft_run_items i WHERE i.run_id = r.id AND i.status = 'drafted') AS drafted,
             (SELECT count(*) FROM termly_draft_run_items i WHERE i.run_id = r.id AND i.status = 'failed')  AS failed
        FROM termly_draft_runs r
       WHERE r.key_person_id = $1
       ORDER BY r.started_at DESC LIMIT 8`, [who.id]);

    res.json({
      on,
      key_person: who,
      cycle: cycle ? { key: cycle.key, label: cycle.label, name: cycle.name,
                       due_on: cycle.due_on, overdue_on: cycle.overdue_on } : null,
      calendar_problem: cycle ? null : 'The school term calendar has no half-term covering today, so there is no cycle to draft for.',
      children: kids.map(k => ({
        id: k.id,
        name: `${k.preferred_name || k.first_name || ''} ${k.last_name || ''}`.trim(),
        room: k.room_name,
        start_date: k.start_date,
        observations: Number(k.obs_total),
        next_steps_open: Number(k.next_steps_open),
        previous_updates: Number(k.previous_updates),
        this_cycle_report_id: k.this_cycle_report_id || null,
        this_cycle_status: k.this_cycle_status || null,
        // Nothing to say is not a model failure and must not look like one.
        draftable: Number(k.obs_total) > 0 || Number(k.next_steps_open) > 0,
      })),
      model: { host: ai.host(), name: ai.model('heavy'), reachable, error: probeError },
      can_run_for_others: isLead(req.user),
      staff: staffRows,
      recent_runs: recent,
      user: { id: req.user.id, role: req.user.role },
      history_limit: await settingInt(db, 'termly_draft_history_limit', 160),
    });
  } catch (e) {
    console.error('[b359] context:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /runs — create a run. Returns immediately; nothing is drafted yet.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/runs', async (req, res) => {
  try {
    const db = getPool();
    const who = resolveKeyPerson(req, res);
    if (!who) return;

    const on = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body && req.body.on || '')) ? req.body.on : TC.ymd(new Date());
    const { cycles } = await TC.loadCycles(db);
    const wanted = req.body && req.body.cycle_key ? String(req.body.cycle_key) : null;
    const cycle = wanted ? TC.cycleByKey(cycles, wanted) : TC.currentCycle(cycles, on);
    if (!cycle) {
      return res.status(409).json({
        error: 'No termly-update cycle covers this date — the school term calendar does not reach it.',
        calendar: TC.calendarHealth(cycles, on),
      });
    }

    // Which children. A caller may narrow to a subset; the default is all of
    // this key person's active children with something to draft from.
    const asked = Array.isArray(req.body && req.body.child_ids)
      ? req.body.child_ids.map(n => parseInt(n, 10)).filter(Number.isInteger) : null;

    const { rows: kids } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.preferred_name
        FROM children c
       WHERE c.key_person_id = $1
         AND COALESCE(c.is_active, true) = true
         AND (c.leave_date IS NULL OR c.leave_date > CURRENT_DATE)
       ORDER BY c.first_name, c.last_name`, [who.id]);
    const chosen = asked && asked.length
      ? kids.filter(k => asked.includes(Number(k.id)))
      : kids;

    if (!chosen.length) {
      return res.status(409).json({ error: 'That member of staff has no active key children to draft for.' });
    }

    const { rows: runRows } = await db.query(`
      INSERT INTO termly_draft_runs
        (key_person_id, requested_by, requested_portal, cycle_key, cycle_label,
         status, model, ollama_host, child_total, options)
      VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9::jsonb)
      RETURNING *`,
      [who.id, req.user.id, req._portal || null, cycle.key, cycle.label,
       ai.model('heavy'), ai.host(), chosen.length,
       JSON.stringify({
         on,
         all_history: true,
         redact_names: true,
         suggestions: true,
         child_ids: chosen.map(c => c.id),
       })]);
    const run = runRows[0];

    for (const [i, k] of chosen.entries()) {
      await db.query(`
        INSERT INTO termly_draft_run_items (run_id, child_id, ordinal, status)
        VALUES ($1,$2,$3,'pending')
        ON CONFLICT (run_id, child_id) DO NOTHING`, [run.id, k.id, i + 1]);
    }

    res.status(201).json(await loadRun(db, run.id, req.user));
  } catch (e) {
    console.error('[b359] create run:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// The per-child draft — the whole of b359's work happens in here
// ═══════════════════════════════════════════════════════════════════════════

/** Build the suggestion pools for one child, from the two real stores. */
async function buildPools(db, ev) {
  const areas = [
    ...(ev.open_next_steps || []).map(n => n.area_label).filter(Boolean),
    ...(ev.tracker && ev.tracker.areas || []).map(a => a.heading),
    ...(ev.last_term.observations || []).flatMap(o => o.areas || []),
  ];
  const ageMonths = ev.child.age_months;

  const cardIndex = (() => { try { return CARDS._loadCards().index || []; } catch { return []; } })();
  const cardBySlug = (() => { try { return CARDS._loadCards().bySlug || {}; } catch { return {}; } })();

  // ladn.planning_activities — the Activity Bank, the store the b359
  // "Activities & Resources" page shows and the one observations already
  // reference. NOT curriculum_activities (see termly-suggestions.js).
  const { rows: actRows } = await db.query(`
    SELECT id, title, description, age_group, age_band, eyfs_areas, duration_minutes,
           materials_needed, setup_instructions, group_size, times_used
      FROM planning_activities
     WHERE COALESCE(is_public, true) = true
     ORDER BY times_used DESC NULLS LAST, id
     LIMIT 600`);

  return {
    cardBySlug,
    activityById: new Map(actRows.map(r => [Number(r.id), r])),
    nurseryCards:      SUG.buildCardPool(cardIndex, { areas, ageMonths }),
    nurseryActivities: SUG.buildActivityPool(actRows, { areas, ageMonths, home: false }),
    homeCards:         SUG.buildCardPool(cardIndex, { areas, ageMonths, limit: 20 }),
    homeActivities:    SUG.buildActivityPool(actRows, { areas, ageMonths, home: true, limit: 18 }),
  };
}

/**
 * Ask the model which of the pool would help THIS child, and validate every
 * answer against the pool. Never throws: a failed suggestion call leaves a draft
 * with no suggestions, which is a smaller loss than no draft.
 */
async function suggestFor(ev, pools, { redactor, model, onPrompt }) {
  if (!pools.nurseryCards.length && !pools.nurseryActivities.length) {
    return SUG.empty('The card and activity libraries are empty on this instance.');
  }
  let sovereign;
  try { sovereign = require('../lib/sovereign-model'); }
  catch (e) { return SUG.empty(`The local model could not be reached (${e.message}).`); }

  const need = (ev.open_next_steps || []).slice(0, 8)
    .map(n => `• ${n.description}`).join('\n') || '(no next steps recorded)';
  const interests = [
    ev.interests.interests && `Interests: ${ev.interests.interests}`,
    ev.interests.favourites && `Favourites: ${ev.interests.favourites}`,
    ev.interests.tags && ev.interests.tags.length && `Tags: ${ev.interests.tags.join(', ')}`,
  ].filter(Boolean).join('\n') || '(nothing recorded about what they like)';

  let prompt = [
    `A child aged ${ev.child.age_months != null ? ev.child.age_months + ' months' : 'unknown'} in an English day nursery.`,
    '',
    'What we are working on with them:',
    need,
    '',
    interests,
    '',
    SUG.poolBlock(pools),
    '',
    SUG.instructionBlock(),
  ].join('\n');

  if (redactor) {
    prompt = redactor.redact(prompt);
    const leaked = redactor.leaks(prompt);
    if (leaked.length) return SUG.empty(`Suggestions were not requested: ${leaked.length} name(s) survived redaction.`);
  }
  if (typeof onPrompt === 'function') { try { onPrompt('suggestions', prompt, []); } catch (_) {} }

  try {
    const out = await sovereign.generateJSON({
      model, prompt, temperature: 0.2, numPredict: 700,
      timeoutMs: SUGGEST_TIMEOUT_MS, long: true,
      system: 'You choose from a fixed list of nursery activities and resource cards. '
            + 'You never invent an identifier. You reply with JSON and nothing else.',
    });
    if (!out.ok) return SUG.empty(`The model did not return usable JSON (${out.error}).`);
    const result = SUG.validate(out.value, pools);
    // Rehydration is pointless for ids, but the "why" sentences are prose and
    // may carry ⟪CHILD⟫ — they are shown to a practitioner and may end up in a
    // parent's copy, so they go through the same door out as everything else.
    if (redactor) {
      for (const p of [...result.nursery, ...result.home]) {
        p.why = redactor.rehydrate(p.why, ev.child.known_as);
      }
    }
    return result;
  } catch (e) {
    return SUG.empty(`The local model failed while choosing suggestions (${e.message}).`);
  }
}

/** Draft ONE child inside a run. Returns the updated item row. */
async function draftOne(db, run, item, user) {
  const started = Date.now();
  await db.query(
    `UPDATE termly_draft_run_items SET status='running', started_at=now(), updated_at=now() WHERE id=$1`,
    [item.id]);

  const opts = run.options || {};
  const model = ai.model('heavy');
  const prompts = [];
  const onPrompt = (key, text) => { prompts.push({ key, text }); };

  try {
    const { cycles } = await TC.loadCycles(db);
    const cycle = TC.cycleByKey(cycles, run.cycle_key);
    if (!cycle) throw new Error(`the term calendar no longer has a half-term for ${run.cycle_key}`);

    // The redactor. Built per child so the SUBJECT's name maps to ⟪CHILD⟫ and
    // everyone else's to ⟪ANOTHER CHILD⟫ — the sets differ for every child, so
    // this cannot be hoisted out of the loop even though the name lists can.
    const sets = await NR.loadNameSets(db);
    const redactor = opts.redact_names === false ? null : NR.fromSets(sets, item.child_id);

    // The b246 report row for this child + cycle. ON CONFLICT is what makes a
    // re-run safe: a child already drafted this cycle is picked up, not doubled.
    const { rows: kidRows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.key_person_id, c.room_id,
             to_char(c.start_date,'YYYY-MM-DD') AS start_date,
             to_char(c.leave_date,'YYYY-MM-DD') AS leave_date
        FROM children c WHERE c.id = $1`, [item.child_id]);
    if (!kidRows.length) throw new Error('child not found');
    const child = kidRows[0];

    const dest = await TUROUTE._routeTo(db, child);
    const { rows: repRows } = await db.query(`
      INSERT INTO reports (child_id, staff_id, report_type, cycle_key, status,
                           assigned_staff_id, lifecycle_status, ai_generated,
                           shared_with_parents, content, created_at, updated_at)
      VALUES ($1,$2,$3,$4,'drafting',$5,'draft',false,false,$6::jsonb, now(), now())
      ON CONFLICT (child_id, cycle_key) WHERE report_type = 'termly_update' AND cycle_key IS NOT NULL
        DO UPDATE SET updated_at = now()
      RETURNING id, status, (xmax = 0) AS inserted`,
      [item.child_id, user.id, REPORT_TYPE, cycle.key, dest.staff_id,
       JSON.stringify({ kind: 'termly_update', version: 1,
                        status_note: 'Gathering the records…',
                        cycle: { key: cycle.key, label: cycle.label },
                        drafted_by_run: run.id })]);
    const report = repRows[0];

    // An update this cycle that a human has already worked on is NOT overwritten.
    // A run is a convenience, not a licence to throw away someone's editing.
    if (!report.inserted && report.status !== 'drafting') {
      await db.query(`
        UPDATE termly_draft_run_items
           SET status='skipped', report_id=$2, finished_at=now(), updated_at=now(),
               error=$3, duration_ms=$4
         WHERE id=$1`,
        [item.id, report.id,
         `This cycle's update already exists and is "${report.status}" — it was left alone.`,
         Date.now() - started]);
      return;
    }

    let suggestions = SUG.empty(null);
    let pools = null;

    const result = await TUROUTE._runDraft(report.id, {
      notify: false,
      evidence: {
        allHistory: opts.all_history !== false,
        historyLimit: await settingInt(db, 'termly_draft_history_limit', 160),
      },
      draft: { redactor, displayName: child.preferred_name || child.first_name, model, onPrompt },
      // Suggestions are attached HERE, inside the same UPDATE that stores the
      // draft, so a report row never exists in a half-suggested state.
      afterDraft: async ({ ev, content }) => {
        if (opts.suggestions === false) return;
        pools = await buildPools(db, ev);
        suggestions = await suggestFor(ev, pools, { redactor, model, onPrompt });
        content.suggestions = {
          nursery: suggestions.nursery,
          home: suggestions.home,
          dropped: suggestions.dropped,
          unavailable: suggestions.unavailable || null,
          // The same ids in the shape observations.linked_* / home_* expect, so
          // a practitioner turning this draft into an observation does not have
          // to re-pick anything.
          card_slugs: suggestions.card_slugs,
          activity_ids: suggestions.activity_ids,
          home_card_slugs: suggestions.home_card_slugs,
          home_activity_ids: suggestions.home_activity_ids,
          pool: pools ? {
            nursery_cards: pools.nurseryCards.length,
            nursery_activities: pools.nurseryActivities.length,
            home_cards: pools.homeCards.length,
            home_activities: pools.homeActivities.length,
          } : null,
          source: 'b359',
        };
        // Toby: "The home suggestions are text the practitioner can include in
        // the termly update shared with parents." So they go INTO the at_home
        // section's body, not only into a side panel a parent never sees.
        const add = SUG.homeSectionAddendum(suggestions);
        if (add) {
          const sec = (content.sections || []).find(x => x.key === 'at_home');
          if (sec && !sec.placeholder) sec.body = `${sec.body}\n${add}`.trim();
          else if (sec) { sec.body = `${sec.body}\n${add}`.trim(); sec.suggestions_only = true; }
        }
        content.history = ev.history || null;
      },
    });

    if (!result || !result.ok) {
      throw new Error(result && result.error ? result.error : `draft did not complete (${result && result.reason})`);
    }

    // The redacted prompt is stored VERBATIM. It is the evidence for the claim
    // this route makes about what crossed the wire, and a claim you cannot check
    // is not a claim. Capped so one enormous caseload cannot fill the table.
    const promptText = prompts.map(p => `── ${p.key} ──\n${p.text}`).join('\n\n').slice(0, 24000);
    const leaks = redactor ? redactor.leaks(promptText) : [];

    await db.query(`
      UPDATE termly_draft_run_items
         SET status='drafted', report_id=$2, finished_at=now(), updated_at=now(),
             observation_count=$3, next_step_count=$4, previous_update_count=$5,
             suggestions=$6::jsonb, dropped=$7::jsonb,
             redacted_prompt=$8, names_leaked=$9::jsonb,
             model=$10, duration_ms=$11, error=NULL
       WHERE id=$1`,
      [item.id, report.id,
       result.content && result.content.history ? result.content.history.observations_read : null,
       result.content && result.content.history ? result.content.history.next_steps_read : null,
       result.content && result.content.history ? result.content.history.previous_updates_read : null,
       JSON.stringify(result.content && result.content.suggestions || {}),
       JSON.stringify(suggestions.dropped || []),
       promptText, JSON.stringify(leaks),
       model, Date.now() - started]);
  } catch (e) {
    console.error('[b359] child', item.child_id, 'failed:', e.message);
    await db.query(`
      UPDATE termly_draft_run_items
         SET status='failed', finished_at=now(), updated_at=now(), error=$2, duration_ms=$3
       WHERE id=$1`, [item.id, e.message, Date.now() - started]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /runs/:id/step — draft the NEXT pending child. One child per request.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/runs/:id/step', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const run = await loadRunRow(db, id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (Number(run.key_person_id) !== Number(req.user.id) && !isLead(req.user)) {
      return res.status(403).json({ error: 'Not your run.' });
    }

    // A specific child may be named (the page retries one failure without
    // re-running nineteen successes); otherwise take the next pending one.
    const wanted = parseInt(req.body && req.body.child_id, 10);
    const { rows: items } = wanted && Number.isInteger(wanted)
      ? await db.query(`SELECT * FROM termly_draft_run_items WHERE run_id=$1 AND child_id=$2`, [id, wanted])
      : await db.query(`
          SELECT * FROM termly_draft_run_items
           WHERE run_id=$1 AND status='pending' ORDER BY ordinal LIMIT 1`, [id]);

    if (!items.length) {
      await finishRun(db, run);
      return res.json(Object.assign({ done: true }, await loadRun(db, id, req.user)));
    }

    if (run.status === 'queued') {
      await db.query(`UPDATE termly_draft_runs SET status='running', updated_at=now() WHERE id=$1`, [id]);
      run.status = 'running';
    }

    await draftOne(db, run, items[0], req.user);

    const out = await loadRun(db, id, req.user);
    if (!out.pending) await finishRun(db, run);
    res.json(Object.assign({ done: !out.pending }, await loadRun(db, id, req.user)));
  } catch (e) {
    console.error('[b359] step:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/** Close a run off and tell the key person, once. */
async function finishRun(db, run) {
  const { rows } = await db.query(`
    SELECT count(*) FILTER (WHERE status='drafted') AS drafted,
           count(*) FILTER (WHERE status='failed')  AS failed,
           count(*) FILTER (WHERE status='skipped') AS skipped,
           count(*) FILTER (WHERE status IN ('pending','running')) AS open
      FROM termly_draft_run_items WHERE run_id=$1`, [run.id]);
  const c = rows[0];
  if (Number(c.open) > 0) return;
  const { rowCount } = await db.query(`
    UPDATE termly_draft_runs
       SET status='done', finished_at=now(), updated_at=now(),
           degraded = ($2::int > 0), 
           degraded_reason = CASE WHEN $2::int > 0
             THEN $2::text || ' of ' || child_total || ' could not be drafted — see the list.'
             ELSE NULL END
     WHERE id=$1 AND status <> 'done'`, [run.id, Number(c.failed)]);
  if (!rowCount) return;                       // someone else closed it first

  const title = `Termly update drafts ready — ${c.drafted} of ${run.child_total}`;
  const body = [
    `Wren has drafted ${c.drafted} termly update${Number(c.drafted) === 1 ? '' : 's'} for your key children,`,
    'from everything on record for each of them, with activities and ideas for home.',
    Number(c.skipped) ? `${c.skipped} already had an update this cycle and were left alone.` : '',
    Number(c.failed) ? `${c.failed} could not be drafted.` : '',
    'Read each one, edit it, then send it.',
  ].filter(Boolean).join(' ');
  notify('termly_update_draft', 'staff', run.key_person_id, title, body,
    { priority: 'normal', link: `/ey/keyperson-planning?run=${run.id}` });
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /runs/:id — poll. GET /runs — the list.
// ═══════════════════════════════════════════════════════════════════════════
async function loadRunRow(db, id) {
  const { rows } = await db.query(`SELECT * FROM termly_draft_runs WHERE id=$1`, [id]);
  return rows[0] || null;
}

async function loadRun(db, id, user) {
  const run = await loadRunRow(db, id);
  if (!run) return null;
  const { rows: items } = await db.query(`
    SELECT i.*, 
           COALESCE(NULLIF(btrim(COALESCE(c.preferred_name, c.first_name) || ' ' || COALESCE(c.last_name,'')),''),
                    'Child #' || i.child_id) AS child_name,
           rp.status AS report_status
      FROM termly_draft_run_items i
      LEFT JOIN children c ON c.id = i.child_id
      LEFT JOIN reports rp ON rp.id = i.report_id
     WHERE i.run_id = $1
     ORDER BY i.ordinal, i.id`, [id]);
  const kp = await db.query(
    `SELECT COALESCE(NULLIF(btrim(first_name || ' ' || COALESCE(last_name,'')),''),'Staff #'||id) AS name
       FROM staff WHERE id=$1`, [run.key_person_id]).catch(() => ({ rows: [] }));

  const counts = { pending: 0, running: 0, drafted: 0, failed: 0, skipped: 0 };
  for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1;

  return {
    id: run.id,
    key_person_id: run.key_person_id,
    key_person_name: kp.rows[0] ? kp.rows[0].name : null,
    requested_by: run.requested_by,
    status: run.status,
    cycle_key: run.cycle_key, cycle_label: run.cycle_label,
    model: run.model, ollama_host: run.ollama_host,
    child_total: run.child_total,
    degraded: run.degraded, degraded_reason: run.degraded_reason,
    started_at: run.started_at, finished_at: run.finished_at,
    counts,
    pending: counts.pending + counts.running,
    items: items.map(i => ({
      id: i.id, child_id: i.child_id, child_name: i.child_name, ordinal: i.ordinal,
      status: i.status, report_id: i.report_id, report_status: i.report_status,
      observation_count: i.observation_count, next_step_count: i.next_step_count,
      previous_update_count: i.previous_update_count,
      suggestions: i.suggestions || {},
      dropped: i.dropped || [],
      names_leaked: i.names_leaked || [],
      // The prompt itself is deliberately NOT in the list payload — it is long,
      // and it is available one child at a time from /items/:itemId/prompt.
      has_prompt: !!i.redacted_prompt,
      model: i.model, duration_ms: i.duration_ms, error: i.error,
      review_link: i.report_id ? `/ey/termly-update?id=${i.report_id}` : null,
    })),
  };
}

router.get('/runs', async (req, res) => {
  try {
    const db = getPool();
    const who = resolveKeyPerson(req, res);
    if (!who) return;
    const { rows } = await db.query(`
      SELECT r.id, r.key_person_id, r.status, r.cycle_key, r.cycle_label, r.child_total,
             r.started_at, r.finished_at, r.degraded, r.degraded_reason,
             (SELECT count(*) FROM termly_draft_run_items i WHERE i.run_id=r.id AND i.status='drafted') AS drafted,
             (SELECT count(*) FROM termly_draft_run_items i WHERE i.run_id=r.id AND i.status='failed')  AS failed
        FROM termly_draft_runs r
       WHERE r.key_person_id = $1
       ORDER BY r.started_at DESC LIMIT 30`, [who.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/runs/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const out = await loadRun(db, id, req.user);
    if (!out) return res.status(404).json({ error: 'Not found' });
    if (Number(out.key_person_id) !== Number(req.user.id) && !isLead(req.user)) {
      return res.status(403).json({ error: 'Not your run.' });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /runs/:id/items/:itemId/prompt — what was actually sent to the model
// ═══════════════════════════════════════════════════════════════════════════
// Manager-level only. It is the drafting evidence, not a working screen, and it
// is the one place in Wren that stores a whole prompt.
router.get('/runs/:id/items/:itemId/prompt', async (req, res) => {
  if (!isLead(req.user)) return res.status(403).json({ error: 'Manager or room leader only.' });
  const runId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  if (!Number.isInteger(runId) || !Number.isInteger(itemId)) return res.status(404).json({ error: 'Not found' });
  try {
    const { rows } = await getPool().query(`
      SELECT i.id, i.child_id, i.redacted_prompt, i.names_leaked, i.model, i.duration_ms
        FROM termly_draft_run_items i WHERE i.id=$1 AND i.run_id=$2`, [itemId, runId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({
      id: rows[0].id,
      child_id: rows[0].child_id,
      model: rows[0].model,
      duration_ms: rows[0].duration_ms,
      names_leaked: rows[0].names_leaked || [],
      prompt: rows[0].redacted_prompt || '',
      tokens: { child: NR.CHILD_TOKEN, other: NR.OTHER_TOKEN, staff: NR.STAFF_TOKEN },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// b359 — lent to scripts/b359-verify.js so the verifier drafts through the real
// path rather than a copy of it.
router._draftOne = draftOne;
router._loadRun = loadRun;
router._buildPools = buildPools;
router._suggestFor = suggestFor;

module.exports = router;
