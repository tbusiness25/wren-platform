'use strict';
/*
 * plan-drafts.js — b223 (2026-08-24)
 *
 *   /api/plan-drafts/...
 *
 * "Could Ascent draft next half-term's plan from the next steps and observations,
 *  and staff just edit and sign it off?"
 *
 * It can, on these terms:
 *
 *  · DRAFT, NEVER DECIDE.  Generating writes a draft. Nothing reaches the termly
 *    plan until a human presses Sign off. A draft can be edited item by item and
 *    any item can be excluded before it is accepted.
 *
 *  · GROUNDED, NOT RECALLED.  The evidence is b218's gathered list — every current
 *    next step across the children, clustered — reached through areas.js's own
 *    _gather/_buildIntentions, so the drafter and the tick-list can never diverge.
 *    The model chooses and arranges; the server supplies every fact.
 *
 *  · CITED.  Each drafted intention stores the real ladn.next_steps ids (and
 *    observation ids) behind it and how many children it serves. GET /:id/sources
 *    walks that back to the observations themselves.
 *
 *  · SIGNED OFF THROUGH THE EXISTING ROUTES.  Accepting writes ladn.term_plans /
 *    ladn.termly_plan_weeks / ladn.area_intentions using planning.js's and
 *    areas.js's own helpers. There is no parallel plan store: plan_drafts is a
 *    workspace and an audit trail.
 *
 *  · LOCAL ONLY.  OLLAMA_HOST (Ascent). Children's next steps must not reach a
 *    cloud model — a GDPR boundary, not a preference. The prompt carries next-step
 *    TEXT and counts, never a name, a date of birth or an id.
 *
 *  · DEGRADES HONESTLY.  If Ascent is unreachable or returns nonsense, the draft
 *    is stored as failed, with the plain gathered list attached, and the page shows
 *    that list and says what happened. It never shows an empty plan.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const CAL = require('../lib/school-calendar');
const G = require('../lib/area-gather');
const PD = require('../lib/plan-draft');
const { ensureEnrolmentMiddleware } = require('../utils/enrolment');

// The gathering and the sign-off both go through the routes that OWN them.
const AREAS    = require('./areas');
const PLANNING = require('./planning');
const CARDS    = require('./resource-cards');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);
router.use(ensureEnrolmentMiddleware(getPool));

const PLAN_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher', 'room_leader', 'practitioner'];
function requirePlan(req, res) {
  if (hasRole(req.user, PLAN_ROLES)) return true;
  res.status(403).json({ error: 'Insufficient permissions' });
  return false;
}

function ymd(d) {
  if (!d) return null;
  return typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
}
function intArray(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(n => parseInt(n, 10)).filter(Number.isInteger))];
}
function slugArray(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(s => String(s == null ? '' : s).trim()).filter(s => /^[a-z0-9-]+$/.test(s)))];
}

async function audit(db, draftId, action, staffId, detail, itemId) {
  try {
    await db.query(
      `INSERT INTO plan_draft_audit (draft_id, item_id, action, staff_id, detail)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [draftId, itemId || null, action, staffId || null, JSON.stringify(detail || {})]);
  } catch (e) { console.error('[plan-drafts] audit failed:', e.message); }
}

// ── The window the evidence is gathered over ─────────────────────────────────
// Same rule as GET /api/areas/gathered, deliberately: a half-term that has not
// started has no observations in it, so fall back to the last 120 days rather
// than drafting from an empty list and calling it a plan.
async function resolveWindow(db, q, sourcePeriod) {
  const today = CAL.todayYmd();
  let from = CAL.cleanYmd(q.from), to = CAL.cleanYmd(q.to);
  let reason = 'explicit';
  if (!from || !to) {
    if (sourcePeriod && ymd(sourcePeriod.start_date) <= today) {
      from = ymd(sourcePeriod.start_date);
      to = ymd(sourcePeriod.end_date) < today ? ymd(sourcePeriod.end_date) : today;
      reason = 'half_term';
    } else {
      to = today;
      from = CAL.addDays(today, -120);
      reason = 'last_120_days';
    }
  }
  return { from, to, reason };
}

// ── Few-shot: the setting's OWN plans ────────────────────────────────────────
// Retrieval, not fine-tuning. Two sources, in order of how much they really are
// the setting's own voice:
//   1 · intentions from drafts a practitioner signed off — edited ones first,
//       because those are words a human actually typed;
//   2 · intentions typed straight into the termly plan (ladn.term_plans.intentions),
//       which pre-date this feature entirely and are the truest examples there are.
// Wren-generated text that no human has touched is deliberately NOT fed back in:
// that is how a model ends up learning from itself.
async function loadExamples(db, area, limit) {
  const cap = Number.isInteger(limit) ? limit : PD.MAX_EXAMPLES;
  const out = [];
  const seen = new Set();
  const add = (text, source) => {
    const t = String(text || '').trim();
    const k = t.toLowerCase();
    if (!t || t.length < 15 || seen.has(k) || out.length >= cap) return;
    seen.add(k); out.push({ text: t, source });
  };

  try {
    const { rows } = await db.query(
      `SELECT i.intention_text, i.edited, d.accepted_at, d.term_name
         FROM plan_draft_items i
         JOIN plan_drafts d ON d.id = i.draft_id
        WHERE d.status = 'accepted' AND i.included = true AND i.area = $1
        ORDER BY i.edited DESC, d.accepted_at DESC NULLS LAST
        LIMIT $2`, [area, cap]);
    rows.forEach(r => add(r.intention_text, r.edited ? 'signed-off (edited by staff)' : 'signed-off draft'));
  } catch (e) { /* table may not exist on an un-migrated schema — examples are optional */ }

  if (out.length < cap) {
    try {
      const { rows } = await db.query(
        `SELECT it->>'text' AS text, p.term_name, p.academic_year
           FROM term_plans p,
                LATERAL jsonb_array_elements(COALESCE(p.intentions -> $1, '[]'::jsonb)) it
          WHERE p.intentions IS NOT NULL
            -- Rows a sign-off wrote are already covered above, with an honest
            -- label. Counting them here too would present un-edited model text
            -- to the model as "written by staff".
            AND COALESCE(it->>'source', '') <> 'plan_draft'
          ORDER BY p.updated_at DESC NULLS LAST
          LIMIT $2`, [area, cap * 2]);
      rows.forEach(r => add(r.text, `written by staff · ${r.term_name || ''} ${r.academic_year || ''}`.trim()));
    } catch (e) { /* older schema without intentions jsonb */ }
  }
  return out;
}

/** How much of the setting's own practice is available to learn from. */
async function exampleReadiness(db) {
  const out = { signed_off_drafts: 0, hand_written_plans: 0 };
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM plan_drafts WHERE status = 'accepted'`);
    out.signed_off_drafts = rows[0].n;
  } catch (e) { /* ignore */ }
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM term_plans
        WHERE intentions IS NOT NULL AND intentions <> '{}'::jsonb`);
    out.hand_written_plans = rows[0].n;
  } catch (e) { /* ignore */ }
  return out;
}

// ── Activity bank for one area ───────────────────────────────────────────────
// curriculum_activities.eyfs_areas holds SHORT CODES ('MATH'), the cards and the
// framework hold full names — canonicalArea() is the only thing that knows both.
async function loadActivities(db, area, room) {
  const { rows } = await db.query(
    `SELECT id, name, eyfs_areas, age_range, category
       FROM curriculum_activities
      WHERE COALESCE(is_library, true) = true
      ORDER BY id`);
  const bands = PD.bandsForRoom(room);
  const bandOk = (r) => {
    if (!bands.length || !r.age_range) return true;
    const a = String(r.age_range).toLowerCase();
    return bands.some(b => a.includes(b === 'preschool' ? 'pre-school' : b)) || a.includes('all');
  };
  return rows
    .filter(r => (r.eyfs_areas || []).some(c => G.canonicalArea(c) === area))
    .filter(bandOk);
}

// ─── GET /context ────────────────────────────────────────────────────────────
// Everything the drafting page needs before anyone presses a button, INCLUDING
// whether Ascent is answering right now — so the page can say "the model is
// offline, here is the gathered list" before wasting three minutes finding out.
router.get('/context', async (req, res) => {
  try {
    const db = getPool();
    const today = CAL.cleanYmd(req.query.date, CAL.todayYmd());
    const [cal, areas, rooms, readiness, up] = await Promise.all([
      CAL.loadCalendar(db, null),
      AREAS._settingAreas(db),
      db.query(`SELECT id, name, min_age_months, max_age_months FROM rooms ORDER BY id`),
      exampleReadiness(db),
      PD.probe(4000),
    ]);
    const day = CAL.resolveDay(today, cal.terms, cal.breaks);
    const gatherFrom = day.half_term || day.previous_half_term || null;
    const gatherFor  = day.next_half_term || day.half_term || null;

    res.json({
      today, areas, rooms: rooms.rows,
      sub_areas: G.ASPECTS_BY_AREA,
      half_terms: cal.terms,
      day, gather_from: gatherFrom, gather_for: gatherFor,
      max_intentions: PD.MAX_INTENTIONS,
      model: { host: PD.OLLAMA_HOST(), name: PD.OLLAMA_MODEL(), reachable: up },
      learning: readiness,
      can_draft: hasRole(req.user, PLAN_ROLES),
      user: { id: req.user.id, role: req.user.role },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /generate ──────────────────────────────────────────────────────────
// Draft ONE area of ONE half-term. Always returns a draft row, even when the
// model never answered: a failed run is a record, not a silence.
router.post('/generate', async (req, res) => {
  if (!requirePlan(req, res)) return;
  const area = G.canonicalArea(req.body.area);
  if (!area) return res.status(400).json({ error: 'area required' });
  const db = getPool();
  try {
    const target = await AREAS._resolvePeriod(db, { half_term_id: req.body.half_term_id || req.body.for_half_term_id });
    if (!target) return res.status(400).json({ error: 'half_term_id required (the half-term being planned)' });
    const source = await AREAS._resolvePeriod(db, { half_term_id: req.body.source_half_term_id });
    const win = await resolveWindow(db, req.body, source);

    const roomId = parseInt(req.body.room_id, 10);
    const room = Number.isInteger(roomId)
      ? (await db.query(`SELECT id, name, min_age_months, max_age_months FROM rooms WHERE id = $1`, [roomId])).rows[0] || null
      : null;

    // 1 · the evidence — b218's own gatherer, not a second copy of it
    const { items, nameSet } = await AREAS._gather(db, {
      from: win.from, to: win.to, roomId: Number.isInteger(roomId) ? roomId : null,
    });
    const areaItems = items.filter(i => i.area === area);
    const candidates = AREAS._buildIntentions(areaItems, area, nameSet);

    // The plain list, stored on the draft so a failed run still has something true to show.
    const gatheredForPage = candidates.map(c => ({
      cluster_key: c.cluster_key, intention_text: c.intention_text, sub_area: c.sub_area,
      child_count: c.child_count, recurrence: c.recurrence, is_group: c.is_group,
      rationale: c.rationale, rooms: c.rooms,
      next_step_ids: c.sources.map(s => s.next_step_id).filter(Boolean),
      observation_ids: c.sources.map(s => s.observation_id).filter(Boolean),
    }));

    const base = {
      half_term_id: target.id, period_kind: target.kind, term_name: target.name,
      academic_year: target.academic_year, source_half_term_id: source ? source.id : null,
      room_id: Number.isInteger(roomId) ? roomId : null, area,
      window_from: win.from, window_to: win.to,
      gathered: gatheredForPage, candidate_count: candidates.length,
    };

    // 2 · nothing to plan from is not a model failure, and must not look like a plan
    if (!candidates.length) {
      const draft = await insertDraft(db, Object.assign({}, base, {
        status: 'failed', degraded: true,
        degraded_reason: `No current next steps in ${area} in ${win.from} – ${win.to}, so there is nothing to draft from.`,
        model: null, ollama_host: null, card_pool_count: 0, activity_pool_count: 0,
        few_shot_count: 0, duration_ms: 0, dropped: [], raw_response: null,
      }), req.user.id);
      await audit(db, draft.id, 'degraded', req.user.id, { reason: 'no_evidence' });
      return res.status(200).json(await loadDraft(db, draft.id));
    }

    // 3 · the libraries the model may choose from
    const subAreas = [...new Set(candidates.map(c => c.sub_area).filter(Boolean))];
    const cardIndex = (() => { try { return CARDS._loadCards().index || []; } catch { return []; } })();
    const cardBySlug = (() => { try { return CARDS._loadCards().bySlug || {}; } catch { return {}; } })();
    const cardPool = PD.buildCardPool(cardIndex, {
      area,
      subAreas: subAreas.length ? subAreas : (G.ASPECTS_BY_AREA[area] || []),
      bands: PD.bandsForRoom(room),
    });
    const activityRows = await loadActivities(db, area, room);
    const activityPool = PD.buildActivityPool(activityRows);

    // 4 · retrieval: how this setting writes when it writes its own
    const examples = await loadExamples(db, area);

    // 5 · the prompt — redacted evidence only
    const ev = PD.buildEvidence(candidates, nameSet);
    const weeks = await PLANNING._periodWeeks(db, target).catch(() => []);
    const prompt = PD.buildPrompt({
      period: target, room, area, subAreas,
      theme: String(req.body.theme || '').trim() || null,
      weeks: weeks.length || null,
      evidence: ev.evidence, cards: cardPool, activities: activityPool, examples,
    });

    // 6 · Ascent. Probe first so an offline box costs 4 seconds, not three minutes.
    const reachable = await PD.probe(4000);
    if (!reachable) {
      const draft = await insertDraft(db, Object.assign({}, base, {
        status: 'failed', degraded: true,
        degraded_reason: `The local model on ${PD.OLLAMA_HOST()} did not answer. Nothing was drafted — ` +
                         `the gathered next steps below are Wren's own and are unaffected.`,
        model: PD.OLLAMA_MODEL(), ollama_host: PD.OLLAMA_HOST(),
        card_pool_count: cardPool.length, activity_pool_count: activityPool.length,
        few_shot_count: examples.length, duration_ms: 0, dropped: [], raw_response: null,
      }), req.user.id);
      await audit(db, draft.id, 'degraded', req.user.id, { reason: 'model_unreachable', host: PD.OLLAMA_HOST() });
      return res.status(200).json(await loadDraft(db, draft.id));
    }

    // b333: resolved once, so a failed run records the model that was asked.
    const planModel = PD.OLLAMA_MODEL();
    let out = null, err = null;
    try {
      out = await PD.callModel(prompt, { model: planModel });
    } catch (e) { err = e; }

    if (err || !out || !out.text) {
      const draft = await insertDraft(db, Object.assign({}, base, {
        status: 'failed', degraded: true,
        degraded_reason: `The local model failed: ${err ? err.message : 'empty reply'}. ` +
                         `Nothing was drafted — the gathered next steps below are Wren's own and are unaffected.`,
        model: PD.OLLAMA_MODEL(), ollama_host: PD.OLLAMA_HOST(),
        card_pool_count: cardPool.length, activity_pool_count: activityPool.length,
        few_shot_count: examples.length, duration_ms: out ? out.ms : null,
        dropped: [], raw_response: out ? out.text : null,
      }), req.user.id);
      await audit(db, draft.id, 'degraded', req.user.id, { reason: 'model_error', detail: err ? err.message : 'empty' });
      return res.status(200).json(await loadDraft(db, draft.id));
    }

    // 7 · validate everything it said against everything that exists
    let parsed = null, parseErr = null;
    try { parsed = PD.parseModelJson(out.text); } catch (e) { parseErr = e; }

    let validated = { items: [], dropped: [] };
    if (parsed) {
      const validIds = new Set();
      const { rows: nsRows } = await db.query(`SELECT id FROM next_steps`);
      nsRows.forEach(r => validIds.add(r.id));
      validated = PD.validate(parsed, {
        byRef: ev.byRef, cardBySlug, area, nameSet,
        cardPoolSlugs: new Set(cardPool.map(c => c.slug)),
        activityById: new Map(activityRows.map(r => [r.id, r])),
        validNextStepIds: validIds,
      });
    }

    const failed = !!parseErr || !validated.items.length;
    const draft = await insertDraft(db, Object.assign({}, base, {
      status: failed ? 'failed' : 'draft',
      degraded: failed,
      degraded_reason: parseErr
        ? `The local model did not return usable JSON (${parseErr.message}). Nothing was drafted.`
        : (failed ? 'Every suggestion the model returned failed validation — see what was dropped below. Nothing was drafted.' : null),
      model: out.model, ollama_host: out.host,
      card_pool_count: cardPool.length, activity_pool_count: activityPool.length,
      few_shot_count: examples.length, duration_ms: out.ms,
      dropped: validated.dropped, raw_response: failed ? out.text.slice(0, 8000) : null,
    }), req.user.id);

    for (const [i, it] of validated.items.entries()) {
      await db.query(
        `INSERT INTO plan_draft_items
           (draft_id, ordinal, area, sub_area, cluster_key, intention_text, drafted_text,
            why, rationale, next_step_ids, observation_ids, child_count, recurrence,
            card_slugs, drafted_card_slugs, activity_ids, drafted_activity_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9::int[],$10::int[],$11,$12,$13::text[],$13::text[],$14::int[],$14::int[])`,
        [draft.id, i + 1, it.area, it.sub_area, it.cluster_keys.join(' + '), it.intention_text,
         it.why, it.rationale, it.next_step_ids, it.observation_ids, it.child_count, it.recurrence,
         it.card_slugs, it.activity_ids]);
    }
    await audit(db, draft.id, failed ? 'degraded' : 'generated', req.user.id, {
      model: out.model, host: out.host, ms: out.ms,
      candidates: candidates.length, offered: ev.offered,
      suggested: validated.items.length, dropped: validated.dropped.length,
      few_shot: examples.length,
    });

    res.status(201).json(await loadDraft(db, draft.id));
  } catch (e) {
    console.error('[plan-drafts] generate:', e);
    res.status(500).json({ error: e.message });
  }
});

async function insertDraft(db, d, userId) {
  const { rows } = await db.query(
    `INSERT INTO plan_drafts
       (half_term_id, period_kind, term_name, academic_year, source_half_term_id, room_id, area,
        status, model, ollama_host, degraded, degraded_reason, window_from, window_to,
        candidate_count, card_pool_count, activity_pool_count, few_shot_count, duration_ms,
        dropped, gathered, raw_response, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             $20::jsonb,$21::jsonb,$22,$23)
     RETURNING *`,
    [d.half_term_id, d.period_kind, d.term_name, d.academic_year, d.source_half_term_id,
     d.room_id, d.area, d.status, d.model || null, d.ollama_host || null,
     !!d.degraded, d.degraded_reason || null, d.window_from, d.window_to,
     d.candidate_count || 0, d.card_pool_count || 0, d.activity_pool_count || 0,
     d.few_shot_count || 0, d.duration_ms == null ? null : d.duration_ms,
     JSON.stringify(d.dropped || []), JSON.stringify(d.gathered || []),
     d.raw_response || null, userId || null]);
  return rows[0];
}

// One draft, hydrated the way the page renders it.
async function loadDraft(db, id) {
  const { rows } = await db.query(
    `SELECT d.*, s.first_name || ' ' || s.last_name AS generated_by_name,
            a.first_name || ' ' || a.last_name AS accepted_by_name,
            rm.name AS room_name
       FROM plan_drafts d
       LEFT JOIN staff s ON s.id = d.generated_by
       LEFT JOIN staff a ON a.id = d.accepted_by
       LEFT JOIN rooms rm ON rm.id = d.room_id
      WHERE d.id = $1`, [id]);
  if (!rows.length) return null;
  const draft = rows[0];
  const { rows: items } = await db.query(
    `SELECT * FROM plan_draft_items WHERE draft_id = $1 ORDER BY ordinal, id`, [id]);
  const { rows: log } = await db.query(
    `SELECT l.*, s.first_name || ' ' || s.last_name AS staff_name
       FROM plan_draft_audit l LEFT JOIN staff s ON s.id = l.staff_id
      WHERE l.draft_id = $1 ORDER BY l.created_at, l.id`, [id]);
  let hydrate = (slugs) => slugs.map(s => ({ slug: s, title: s, missing: false }));
  try { hydrate = PLANNING._hydrateCards; } catch (e) { /* fall back to slugs */ }
  // Activities are ids on the row; the page must show what they are CALLED, or a
  // practitioner is asked to sign off "activity #22".
  const actIds = [...new Set(items.flatMap(i => i.activity_ids || []))];
  const actById = new Map();
  if (actIds.length) {
    const { rows: acts } = await db.query(
      `SELECT id, name, age_range, category FROM curriculum_activities WHERE id = ANY($1::int[])`, [actIds]);
    acts.forEach(a => actById.set(a.id, a));
  }
  return {
    draft,
    items: items.map(i => Object.assign({}, i, {
      cards: hydrate(i.card_slugs || []),
      activities: (i.activity_ids || []).map(id => actById.get(id) || { id, name: `Activity #${id}`, missing: true }),
    })),
    audit: log,
  };
}

// ─── GET / ───────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const params = [];
    let sql = `SELECT d.id, d.area, d.half_term_id, d.term_name, d.academic_year, d.room_id,
                      rm.name AS room_name, d.status, d.degraded, d.degraded_reason, d.model,
                      d.candidate_count, d.duration_ms, d.few_shot_count,
                      d.generated_at, d.accepted_at, d.plan_id,
                      s.first_name || ' ' || s.last_name AS generated_by_name,
                      (SELECT count(*)::int FROM plan_draft_items i WHERE i.draft_id = d.id) AS item_count,
                      jsonb_array_length(d.dropped) AS dropped_count
                 FROM plan_drafts d
                 LEFT JOIN staff s ON s.id = d.generated_by
                 LEFT JOIN rooms rm ON rm.id = d.room_id
                WHERE 1=1`;
    if (req.query.half_term_id) { params.push(parseInt(req.query.half_term_id, 10)); sql += ` AND d.half_term_id = $${params.length}`; }
    const area = G.canonicalArea(req.query.area);
    if (req.query.area && !area) return res.status(400).json({ error: 'Unknown area' });
    if (area) { params.push(area); sql += ` AND d.area = $${params.length}`; }
    if (req.query.status) { params.push(String(req.query.status)); sql += ` AND d.status = $${params.length}`; }
    sql += ` ORDER BY d.generated_at DESC LIMIT 100`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /:id ────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const out = await loadDraft(getPool(), id);
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /:id/items/:itemId/sources ──────────────────────────────────────────
// The trace a practitioner asks for when they want to know WHY: suggestion →
// the next steps it cites → the child and observation each was written about.
// This is the one endpoint here that returns child NAMES, so /api/plan-drafts is
// registered in server-unified.js's PARENT_DENY, HR_DENY, _ONSITE_CHILD_DATA and
// OFFSITE_CHILD sets alongside 'areas' — same data, same rule.
router.get('/:id/items/:itemId/sources', async (req, res) => {
  const itemId = parseInt(req.params.itemId, 10);
  if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const db = getPool();
    const { rows: it } = await db.query(
      `SELECT * FROM plan_draft_items WHERE id = $1 AND draft_id = $2`,
      [itemId, parseInt(req.params.id, 10)]);
    if (!it.length) return res.status(404).json({ error: 'Not found' });
    const item = it[0];
    const nsIds = item.next_step_ids || [];
    const obsIds = item.observation_ids || [];
    const [ns, obs] = await Promise.all([
      nsIds.length ? db.query(
        `SELECT n.id, n.description, n.status, n.created_at, n.observation_id,
                c.first_name, c.last_name, rm.name AS room_name
           FROM next_steps n
           JOIN children c ON c.id = n.child_id
           LEFT JOIN rooms rm ON rm.id = c.room_id
          WHERE n.id = ANY($1::int[])
          ORDER BY n.created_at DESC`, [nsIds]) : { rows: [] },
      obsIds.length ? db.query(
        `SELECT o.id, o.title, o.next_steps AS description, o.created_at,
                c.first_name, c.last_name, rm.name AS room_name
           FROM observations o
           JOIN children c ON c.id = o.child_id
           LEFT JOIN rooms rm ON rm.id = c.room_id
          WHERE o.id = ANY($1::int[])
          ORDER BY o.created_at DESC`, [obsIds]) : { rows: [] },
    ]);
    res.json({
      item,
      next_steps: ns.rows.map(r => ({ ...r, kind: 'next_step',
        child_name: `${r.first_name || ''} ${r.last_name || ''}`.trim() })),
      observations: obs.rows.map(r => ({ ...r, kind: 'observation_next_step',
        child_name: `${r.first_name || ''} ${r.last_name || ''}`.trim() })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /:id/items/:itemId ────────────────────────────────────────────────
// Edit before sign-off. drafted_text / drafted_card_slugs are never touched, so
// the audit can always say what the model wrote and what the human made of it.
router.patch('/:id/items/:itemId', async (req, res) => {
  if (!requirePlan(req, res)) return;
  const draftId = parseInt(req.params.id, 10);
  const itemId  = parseInt(req.params.itemId, 10);
  if (!Number.isInteger(draftId) || !Number.isInteger(itemId)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const db = getPool();
    const { rows: dRows } = await db.query(`SELECT * FROM plan_drafts WHERE id = $1`, [draftId]);
    if (!dRows.length) return res.status(404).json({ error: 'Draft not found' });
    if (dRows[0].status === 'accepted') return res.status(409).json({ error: 'This draft has already been signed off' });
    const { rows: iRows } = await db.query(
      `SELECT * FROM plan_draft_items WHERE id = $1 AND draft_id = $2`, [itemId, draftId]);
    if (!iRows.length) return res.status(404).json({ error: 'Item not found' });
    const cur = iRows[0];

    const before = { intention_text: cur.intention_text, card_slugs: cur.card_slugs,
                     activity_ids: cur.activity_ids, included: cur.included };

    let text = cur.intention_text;
    if (req.body.intention_text != null) {
      text = String(req.body.intention_text).trim().slice(0, 400);
      if (!text) return res.status(400).json({ error: 'intention_text cannot be empty' });
    }
    // The same validation the model's own output goes through: a practitioner
    // may type freely, but a card slug that does not exist is still not a card.
    let cards = cur.card_slugs || [];
    const rejected = [];
    if (req.body.card_slugs != null) {
      let bySlug = {};
      try { bySlug = CARDS._loadCards().bySlug || {}; } catch (e) { bySlug = {}; }
      cards = [];
      for (const s of slugArray(req.body.card_slugs)) {
        if (bySlug[s]) cards.push(s); else rejected.push({ kind: 'card', value: s, reason: 'no such resource card' });
      }
    }
    let acts = cur.activity_ids || [];
    if (req.body.activity_ids != null) {
      const want = intArray(req.body.activity_ids);
      if (want.length) {
        const { rows } = await db.query(`SELECT id FROM curriculum_activities WHERE id = ANY($1::int[])`, [want]);
        const ok = new Set(rows.map(r => r.id));
        acts = want.filter(id => ok.has(id));
        want.filter(id => !ok.has(id)).forEach(id => rejected.push({ kind: 'activity', value: id, reason: 'no such activity' }));
      } else acts = [];
    }
    const included = req.body.included == null ? cur.included : !!req.body.included;
    const edited = cur.edited
      || text !== cur.drafted_text
      || JSON.stringify(cards) !== JSON.stringify(cur.drafted_card_slugs || [])
      || JSON.stringify(acts) !== JSON.stringify(cur.drafted_activity_ids || []);

    const { rows } = await db.query(
      `UPDATE plan_draft_items
          SET intention_text = $2, card_slugs = $3::text[], activity_ids = $4::int[],
              included = $5, edited = $6, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [itemId, text, cards, acts, included, edited]);

    const after = { intention_text: text, card_slugs: cards, activity_ids: acts, included };
    const changed = Object.keys(after).filter(k => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    if (changed.length) {
      await audit(db, draftId,
        (changed.length === 1 && changed[0] === 'included') ? (included ? 'included' : 'excluded') : 'edited',
        req.user.id, { changed, before, after, rejected }, itemId);
    }
    res.json({ item: rows[0], rejected });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /:id/accept — the sign-off ─────────────────────────────────────────
// The only route in this file that touches the real plan. It writes through the
// EXISTING stores:
//   · ladn.area_intentions (+ _sources) via areas.js's own adoptClusters, so the
//     citation chain suggestion → next step → observation is the same one a
//     ticked candidate gets;
//   · ladn.term_plans.intentions, MERGED into whatever is already there and
//     capped exactly as PUT /api/planning/termly/plan caps it;
//   · ladn.termly_plan_weeks week 1 for the room, for the cards and activities —
//     merged, never replacing what a practitioner already put there.
router.post('/:id/accept', async (req, res) => {
  if (!requirePlan(req, res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const db = getPool();
  try {
    const { rows: dRows } = await db.query(`SELECT * FROM plan_drafts WHERE id = $1`, [id]);
    if (!dRows.length) return res.status(404).json({ error: 'Not found' });
    const draft = dRows[0];
    if (draft.status === 'accepted') return res.status(409).json({ error: 'Already signed off' });
    if (draft.status === 'discarded') return res.status(409).json({ error: 'This draft was discarded' });

    const { rows: items } = await db.query(
      `SELECT * FROM plan_draft_items WHERE draft_id = $1 AND included = true ORDER BY ordinal, id`, [id]);
    if (!items.length) return res.status(400).json({ error: 'Nothing to sign off — every suggestion is excluded' });

    const roomId = parseInt(req.body.room_id != null ? req.body.room_id : draft.room_id, 10);
    if (!Number.isInteger(roomId)) {
      return res.status(400).json({ error: 'room_id required — a termly plan belongs to a room' });
    }

    // 1 · the period, resolved by planning.js's own resolver
    const term = await PLANNING._resolvePeriod(db, { half_term_id: draft.half_term_id });
    if (!term) return res.status(400).json({ error: 'The half-term this draft was made for no longer exists' });
    const { term_name, academic_year } = PLANNING._termKey(term);
    const framework = await PLANNING._activeFramework(db);
    const MAXI = PLANNING._MAX_INTENTIONS_PER_AREA || 3;

    // 2 · carry the cited evidence into area_intentions — the SAME path a tick takes
    const clusterKeys = [...new Set(items.flatMap(i => String(i.cluster_key || '').split(' + ')).filter(Boolean))];
    let adopted = { saved: [], skipped: [] };
    if (clusterKeys.length) {
      const source = draft.source_half_term_id
        ? await AREAS._resolvePeriod(db, { half_term_id: draft.source_half_term_id }) : null;
      adopted = await AREAS._adoptClusters(db, {
        area: draft.area,
        target: { id: term.id, kind: 'half_term', name: term_name, academic_year },
        source,
        from: ymd(draft.window_from), to: ymd(draft.window_to),
        roomId: draft.room_id || null,
        keys: clusterKeys, userId: req.user.id || null,
      });
    }

    // 3 · merge into term_plans.intentions — other areas untouched, cap respected
    // b328 — matched the half-term's display name, so it found no existing plan for a
    // renamed half-term and would have made a second one. Same lookup as planning.js.
    const prev = await PLANNING._findTermPlan(db, roomId, term);
    const merged = (prev && prev.intentions && typeof prev.intentions === 'object' && !Array.isArray(prev.intentions))
      ? JSON.parse(JSON.stringify(prev.intentions)) : {};
    const list = Array.isArray(merged[draft.area]) ? merged[draft.area] : [];
    const seen = new Set(list.map(x => String(x && x.text || '').trim().toLowerCase()));
    const addedTexts = [], skippedTexts = [];
    for (const it of items) {
      const t = String(it.intention_text || '').trim();
      if (!t || seen.has(t.toLowerCase())) { if (t) skippedTexts.push({ text: t, reason: 'already in the plan' }); continue; }
      if (list.length >= MAXI) { skippedTexts.push({ text: t, reason: `over the ${MAXI}-per-area cap` }); continue; }
      seen.add(t.toLowerCase());
      list.push({ statement_id: null, code: null, text: t, sub_area: it.sub_area || null, area: draft.area,
                  source: 'plan_draft', draft_id: id, draft_item_id: it.id });
      addedTexts.push(t);
    }
    if (list.length) merged[draft.area] = list;
    const flat = [];
    for (const [a, l] of Object.entries(merged)) (l || []).forEach(x => x && x.text && flat.push(`${a}: ${x.text}`));

    const theme = String(req.body.theme != null ? req.body.theme : (prev ? prev.theme : '') || '').trim();
    const schoolTermId = term.kind === 'half_term' ? term.id : null;
    const { rows: planRows } = await db.query(
      `INSERT INTO term_plans
         (room_id, term_name, academic_year, framework, theme, intentions, learning_intentions,
          key_books, songs, event_ids, created_by, updated_at, school_term_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::text[],$8::text[],$9::text[],$10::jsonb,$11, now(),$12)
       ON CONFLICT (room_id, term_name, academic_year) DO UPDATE SET
         framework           = EXCLUDED.framework,
         theme               = CASE WHEN COALESCE(btrim(term_plans.theme),'') = ''
                                    THEN EXCLUDED.theme ELSE term_plans.theme END,
         intentions          = EXCLUDED.intentions,
         learning_intentions = EXCLUDED.learning_intentions,
         school_term_id      = COALESCE(EXCLUDED.school_term_id, term_plans.school_term_id),
         updated_at          = now()
       RETURNING *`,
      [roomId, term_name, academic_year, framework, theme,
       JSON.stringify(merged), flat,
       prev ? (prev.key_books || []) : [], prev ? (prev.songs || []) : [],
       JSON.stringify(prev && Array.isArray(prev.event_ids) ? prev.event_ids : []),
       req.user.id || null, schoolTermId]);
    const plan = planRows[0];

    // 4 · cards + activities → week 1's continuous provision, MERGED.
    //     Deliberately week 1 and not spread across the half-term: which week a
    //     card belongs in is a practitioner's judgement, and inventing a spread
    //     would be the model deciding something it was never shown.
    const weeks = await PLANNING._periodWeeks(db, term).catch(() => []);
    const week1 = weeks[0] || null;
    const wantCards = [...new Set(items.flatMap(i => i.card_slugs || []))];
    const wantActs  = [...new Set(items.flatMap(i => i.activity_ids || []))];
    let weekRow = null;
    if (week1 && (wantCards.length || wantActs.length)) {
      const { rows: wRows } = await db.query(
        `SELECT * FROM termly_plan_weeks WHERE plan_id = $1 AND week_no = 1 AND room_id = $2 LIMIT 1`,
        [plan.id, roomId]);
      const cur = wRows[0] || null;
      const curCards = cur && Array.isArray(cur.resource_card_ids) ? cur.resource_card_ids : [];
      const curActs  = cur && Array.isArray(cur.activity_ids) ? cur.activity_ids : [];
      const nextCards = [...new Set([...curCards.map(String), ...wantCards])];
      const nextActs  = [...new Set([...curActs.map(Number), ...wantActs])];
      const { rows: saved } = await db.query(
        `INSERT INTO termly_plan_weeks
           (plan_id, week_no, room_id, week_commencing, resource_card_ids, activity_ids, notes, created_by, updated_at)
         VALUES ($1,1,$2,$3,$4::jsonb,$5::jsonb,$6,$7, now())
         ON CONFLICT (plan_id, week_no, room_id) DO UPDATE SET
           resource_card_ids = EXCLUDED.resource_card_ids,
           activity_ids      = EXCLUDED.activity_ids,
           updated_at        = now()
         RETURNING *`,
        [plan.id, roomId, week1.week_commencing || null,
         JSON.stringify(nextCards), JSON.stringify(nextActs),
         cur ? cur.notes : null, req.user.id || null]);
      weekRow = saved[0];
    }

    // 5 · what the human changed before accepting — the point of the audit
    const { rows: allItems } = await db.query(
      `SELECT * FROM plan_draft_items WHERE draft_id = $1 ORDER BY ordinal, id`, [id]);
    const changes = allItems.map(i => ({
      item_id: i.id,
      included: i.included,
      text_changed: String(i.intention_text) !== String(i.drafted_text),
      drafted_text: i.drafted_text,
      final_text: i.intention_text,
      cards_changed: JSON.stringify(i.card_slugs || []) !== JSON.stringify(i.drafted_card_slugs || []),
      drafted_cards: i.drafted_card_slugs || [], final_cards: i.card_slugs || [],
    }));

    await db.query(
      `UPDATE plan_drafts SET status = 'accepted', accepted_by = $2, accepted_at = now(),
              plan_id = $3, room_id = COALESCE(room_id, $4), updated_at = now()
        WHERE id = $1`, [id, req.user.id || null, plan.id, roomId]);
    await audit(db, id, 'accepted', req.user.id, {
      plan_id: plan.id, room_id: roomId, term: `${term_name} ${academic_year}`,
      intentions_added: addedTexts.length, intentions_skipped: skippedTexts,
      area_intentions_saved: adopted.saved.length, area_intentions_skipped: adopted.skipped,
      cards_to_week_1: wantCards, activities_to_week_1: wantActs,
      edited_before_accepting: changes.filter(c => c.text_changed || c.cards_changed).length,
      excluded: changes.filter(c => !c.included).length,
      changes,
    });

    res.json({
      ok: true,
      plan, week: weekRow,
      term: { id: term.id, name: term_name, academic_year },
      room_id: roomId,
      intentions_added: addedTexts, intentions_skipped: skippedTexts,
      area_intentions: { saved: adopted.saved.length, skipped: adopted.skipped },
      cards_to_week_1: wantCards, activities_to_week_1: wantActs,
      draft: (await loadDraft(db, id)).draft,
    });
  } catch (e) {
    console.error('[plan-drafts] accept:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /:id/discard ───────────────────────────────────────────────────────
// Never a DELETE: a draft that was rejected is part of how the setting decided.
router.post('/:id/discard', async (req, res) => {
  if (!requirePlan(req, res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE plan_drafts SET status = 'discarded', updated_at = now()
        WHERE id = $1 AND status <> 'accepted' RETURNING *`, [id]);
    if (!rows.length) return res.status(409).json({ error: 'Not found, or already signed off' });
    await audit(db, id, 'discarded', req.user.id, { reason: String(req.body.reason || '').slice(0, 400) || null });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
