'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const { checkEnum } = require('../lib/enum-guard');
const authenticate = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const { randomUUID } = require('crypto');
const path = require('path');

const ai = require('../lib/ai-models');
const OLLAMA_HOST        = ai.host();
// Observation drafting/chat → ai-models.js role 'default'; statement suggestion
// (deterministic, temperature 0) → role 'fast'. Both resolved per call.
// (b333: was OLLAMA_MODEL / AI_SUGGESTER_MODEL, both defaulting to qwen3.5:4b.)
const OLLAMA_MODEL       = () => ai.model('default');
const AI_SUGGESTER_MODEL = () => ai.model('fast');
const AI_LOG = path.join(__dirname, '../../logs/ai-helper.log');
const { classifyArea } = require('../services/eyfs-area-classifier');
const { resolveFramework } = require('../lib/framework-map');
// fledge-off (2026-10-26) — the one Fledge switch (ladn.settings.fledge_enabled).
const FS = require('../lib/fledge-switch');
const { notify } = require('../services/notification-dispatcher');
const { recordAudit } = require('../utils/audit');
// b237 (2026-08-27) — the observations.* capabilities were decorative until now.
const { requireCapability, requireCapabilityLevel, hasCapability } = require('../lib/capabilities');
// b265 (2026-09-01) — parent media controls: download gate (off by default),
// group-media suppression at share time, and identity watermarking.
const mediaGate = require('../lib/parent-media-gate');
const watermark = require('../lib/media-watermark');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

function appendLog(msg) {
  try { fs.appendFileSync(AI_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

// ── Review queue (b177) ──────────────────────────────────────────────────────
// New/unqualified staff (staff.can_publish=false) can record observations but
// can't publish them straight to parents — mirrors EyLog's moderation queue.
// Their obs saves as review_status='pending_review' with shared_with_parents
// forced false (whatever they asked for is remembered in
// requested_shared_with_parents and applied on Approve). A manager/deputy/room
// leader then Approves (publishes + applies the requested share flag) or Returns
// (with a note) via GET/POST /review-queue below.
//
// Toby (id=1) and role='manager' always publish directly regardless of the flag —
// mirrors the same safety net src/lib/capabilities.js uses ("never lose access").
async function _canPublish(db, user) {
  if (Number(user.id) === 1 || hasRole(user, ['manager', 'admin'])) return true;
  try {
    const { rows } = await db.query('SELECT can_publish FROM staff WHERE id=$1', [user.id]);
    return rows.length ? rows[0].can_publish !== false : true;
  } catch (e) { return true; } // fail open — never block a genuine save on a lookup error
}

// Who can review/approve/return a pending observation: managers, deputy managers,
// admin — always. A room_leader may review only within their own room (req.user.room_id
// carries their room from the JWT, set at login — see src/routes/auth.js).
function _isReviewerRole(role) {
  return ['manager', 'deputy_manager', 'admin'].includes(role) || role === 'room_leader';
}
function _canReviewRoom(user, roomId) {
  if (hasRole(user, ['manager', 'deputy_manager', 'admin'])) return true;
  if (user.role === 'room_leader') return roomId != null && Number(user.room_id) === Number(roomId);
  return false;
}

// Fire the staff-side "this was published" ping scoped to the child's key person
// ONLY (never all-staff/all-managers as a blanket broadcast) — falls back to
// all-managers only when the child genuinely has no key person assigned yet,
// matching the existing convention in scripts/report-engine-nightly.js.
// actingUserId is skipped as a recipient so approving/publishing your own key
// child's observation doesn't self-notify.
async function _notifyPublished(db, { childId, keyPersonId, actingUserId, obsId, childName }) {
  const title = `New update shared: ${childName || 'a child'}`;
  const body  = 'An observation was shared with parents.';
  const link  = `/ey/observation/${obsId}`;
  try {
    await notify('observation_published', 'parent', childId, title, body,
      { relatedTable: 'observations', relatedId: obsId, link });
  } catch (e) { /* non-fatal — publish already succeeded */ }
  try {
    if (keyPersonId && Number(keyPersonId) !== Number(actingUserId)) {
      await notify('observation_published', 'staff', keyPersonId, title, body,
        { relatedTable: 'observations', relatedId: obsId, link });
    } else if (!keyPersonId) {
      await notify('observation_published', 'all-managers', null, title, body,
        { relatedTable: 'observations', relatedId: obsId, link });
    }
  } catch (e) { /* non-fatal */ }
}

// Notify reviewers (managers/deputy + the child's room leader) that something
// needs a look — scoped to that room's reviewers, not a blanket all-staff shout.
async function _notifyReviewers(db, { roomId, childName, obsId }) {
  try {
    const { rows } = await db.query(
      `SELECT id FROM staff WHERE is_active=true AND (
         role IN ('manager','deputy_manager')
         OR (role='room_leader' AND room_id=$1)
       )`, [roomId || -1]);
    const title = `Observation awaiting review: ${childName || 'a child'}`;
    const body  = 'A new/unqualified staff member submitted an observation — review before it reaches parents.';
    const link  = `/ey/review-queue`;
    // notify() is fire-and-forget (returns undefined, handles its own errors
    // internally) — call it plain, don't chain .then/.catch onto its return value.
    rows.forEach(r => notify('observation_pending_review', 'staff', r.id, title, body,
      { relatedTable: 'observations', relatedId: obsId, link }));
  } catch (e) { /* non-fatal */ }
}

// ── AI session-level degradation tracking ────────────────────────────────────
const _aiFailures = {};

function isAiDegraded(staffId) {
  const f = _aiFailures[staffId];
  if (!f || !f.until) return false;
  if (Date.now() > f.until) { delete _aiFailures[staffId]; return false; }
  return true;
}
function recordAiSuccess(staffId) {
  if (_aiFailures[staffId]) _aiFailures[staffId].count = 0;
}
function recordAiFailure(staffId) {
  if (!_aiFailures[staffId]) _aiFailures[staffId] = { count: 0 };
  _aiFailures[staffId].count++;
  if (_aiFailures[staffId].count >= 1) {
    _aiFailures[staffId].until = Date.now() + 30 * 60 * 1000;
    appendLog(`Staff ${staffId}: AI suggester degraded for 30 min after consecutive failures`);
  }
}

// GET /photo/:filename is exempted below (bughunt 2026-07-21) — every real caller
// renders it as a plain <img src>, which browsers never attach an Authorization
// header to, so it always 401'd and observation photos never actually displayed
// anywhere. It gets its own auth check (header OR ?token= query fallback) instead.
router.use((req, res, next) => {
  if (req.method === 'GET' && /^\/photo\//.test(req.path)) return next();
  return authenticate(req, res, next);
});

// Reject a non-numeric :id before it ever reaches a SQL query — used to 500 with a
// raw Postgres "invalid input syntax for type integer" error (bughunt 2026-07-21).
// 'new' is a deliberate sentinel (not a regression of the above) — /:id/suggest-statements
// and /:id/draft both accept it for the pre-save "Draft with Wren" flow on an
// observation that hasn't been created yet. This guard was blocking it with the same
// "Invalid id" 400, which is why staff-feedback card #15 saw the AI draft do nothing
// (fbfix 2026-07-21).
// 2026-07-23 FIX: this used to `return res.status(400)` on any non-numeric id, but a
// router.param callback fires as soon as a route with :id MATCHES — and '/:id' (line
// ~150) matches literal paths declared later in this file. That silently 400'd
// /populated-frameworks, /tracker-frameworks, /fledge-bands and /default-framework,
// which is why the EY Framework Grid showed "Could not load frameworks" and Fledge
// never appeared in the framework selector. next('route') skips this route so Express
// can match the real literal one; a genuinely bad id now falls through to a clean 404
// instead of reaching SQL, which preserves the original guard's intent.
router.param('id', (req, res, next, id) => {
  if (id === 'new') return next();
  if (!/^\d+$/.test(id)) return next('route');
  next();
});

const OBS_SELECT = `
  SELECT o.*, c.first_name || ' ' || c.last_name as child_name,
    c.first_name as child_first_name, c.last_name as child_last_name,
    c.room_id as room_id,
    EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth))::int as child_age_months,
    r.name as room_name,
    -- staff_name from the staff join; fall back to o.author_name (the EyLog-recorded
    -- practitioner) so historical obs by leavers with no staff row stay attributed.
    COALESCE(s.first_name || ' ' || s.last_name, o.author_name) as staff_name
  FROM observations o
  JOIN children c ON c.id = o.child_id
  LEFT JOIN staff s ON s.id = o.staff_id
  LEFT JOIN rooms r ON r.id = c.room_id
`;

// GET /recent
router.get('/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  try {
    const { rows } = await getPool().query(OBS_SELECT + ' ORDER BY o.created_at DESC LIMIT $1', [limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET / — filtered list
router.get('/', async (req, res) => {
  // Accept both old short names and frontend query param names
  const child_id   = req.query.child_id;
  const staff_id   = req.query.staff_id;
  const area       = req.query.eyfs_area  || req.query.area;
  const from       = req.query.date_from  || req.query.from;
  const to         = req.query.date_to    || req.query.to;
  const type       = req.query.observation_type || req.query.type;
  const shared     = req.query.shared;
  const search     = req.query.search;
  let sql = OBS_SELECT + ' WHERE 1=1';
  const params = [];
  if (child_id) { params.push(child_id); sql += ` AND o.child_id=$${params.length}`; }
  if (staff_id) { params.push(staff_id); sql += ` AND o.staff_id=$${params.length}`; }
  // Obs-tracker list filters (Prompt 27C): room + my-key-children.
  if (req.query.room_id) { params.push(req.query.room_id); sql += ` AND c.room_id=$${params.length}`; }
  if (req.query.mine === '1' && req.user && req.user.id) { params.push(req.user.id); sql += ` AND c.key_person_id=$${params.length}`; }
  // Prompt 50: scope to an explicit set of selected children (EY home multi-select / ?children=).
  if (req.query.child_ids) {
    const ids = String(req.query.child_ids).split(',').map(n => parseInt(n, 10)).filter(Boolean);
    if (ids.length) { params.push(ids); sql += ` AND o.child_id = ANY($${params.length}::int[])`; }
  }
  if (area) { params.push(`%${area}%`); sql += ` AND o.eyfs_areas::text ILIKE $${params.length}`; }
  if (from) { params.push(from); sql += ` AND o.created_at >= $${params.length}`; }
  if (to) { params.push(to); sql += ` AND o.created_at <= $${params.length}`; }
  if (type) { params.push(type); sql += ` AND o.observation_type=$${params.length}`; }
  // Prompt 28A: filter to just termly updates (the distinct "Termly Update & Tracking" kind).
  if (req.query.termly_update === '1' || req.query.termly_update === 'true') sql += ` AND o.termly_update=true`;
  // b354 — the inverse: "Observation" in the Report Tracker's type filter means
  // NOT a termly update (plain observations), not merely "unspecified".
  else if (req.query.termly_update === '0' || req.query.termly_update === 'false') sql += ` AND o.termly_update IS NOT TRUE`;
  // b354 (2026-09-24) — Toby: "if it was all of their observations they could
  // filter and say I only want ones that had text in the next steps field or
  // the analysis field". ?has_field=next_steps,analysis (OR'd). Allowlisted —
  // never build a column name from raw input. "Parent voice"/"child voice"
  // aren't in this list: no such columns exist on observations yet (checked
  // 2026-09-24), so they're left out rather than silently mapped to the wrong
  // field — see the b354 build notes.
  const HAS_FIELD_COLS = new Set(['next_steps', 'analysis', 'additional_comments', 'at_home_ideas', 'next_steps_home', 'closing_note']);
  if (req.query.has_field) {
    const cols = String(req.query.has_field).split(',').map(s => s.trim()).filter(c => HAS_FIELD_COLS.has(c));
    if (cols.length) sql += ` AND (${cols.map(c => `btrim(coalesce(o.${c},'')) <> ''`).join(' OR ')})`;
  }
  if (shared === 'true') sql += ` AND o.shared_with_parents=true`;
  if (search) { params.push(`%${search}%`); sql += ` AND (o.observation_text ILIKE $${params.length} OR o.title ILIKE $${params.length})`; }
  // 2026-10-29 (a practitioner, feedback 38) — ?before=<created_at> pages back past the 200 cap, so the
  // learning journey can reach a child's older observations for termly updates.
  if (req.query.before && !isNaN(Date.parse(req.query.before))) { params.push(new Date(req.query.before).toISOString()); sql += ` AND o.created_at < $${params.length}`; }
  // Honour an explicit ?limit= (2026-07-04) — capped at the long-standing 200 default
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 200);
  sql += ` ORDER BY o.created_at DESC LIMIT ${limit}`;
  try {
    const { rows } = await getPool().query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId
router.get('/child/:childId', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      OBS_SELECT + ' WHERE o.child_id=$1 ORDER BY o.created_at DESC',
      [req.params.childId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/framework-summary
router.get('/child/:childId/framework-summary', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT unnest(eyfs_areas) as area, count(*) as obs_count
      FROM observations WHERE child_id=$1 GROUP BY 1 ORDER BY 2 DESC
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id
router.get('/:id', async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const { rows } = await getPool().query(OBS_SELECT + ' WHERE o.id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // login-20261023 — the Apprentice pathway's "read ten observations": which member of staff has
    // opened which observation, once each. Staff only (parents read through their own routes), never
    // their own observation, fire-and-forget so a missing table never fails the read.
    if (req.user && Number(req.user.id) > 0 && req.user.role !== 'parent' && !req.isParent
        && Number(rows[0].staff_id) !== Number(req.user.id)) {
      getPool().query('INSERT INTO observation_reads (staff_id, observation_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [Number(req.user.id), Number(req.params.id)]).catch(() => {});
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const VALID_OBS_TAGS = new Set(['planned_activity','tracking','next_step_followup','baseline','termly_update','parental']);

function validateObsTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.filter(t => VALID_OBS_TAGS.has(t));
}

/**
 * Same check, but names what it threw away.
 *
 * Added 2026-09-08: `validateObsTags` silently dropped unknown tags and the
 * routes returned 200, so a caller sending a tag outside the set got success,
 * an empty `obs_tags`, and no way to know. Tagging is how termly updates and
 * tracking are found later, so a discarded tag is lost work, not a cosmetic
 * miss. Returns { clean, invalid }; callers 400 when `invalid` is non-empty.
 */
function partitionObsTags(tags) {
  const arr = Array.isArray(tags) ? tags : [];
  const clean = [], invalid = [];
  for (const t of arr) (VALID_OBS_TAGS.has(t) ? clean : invalid).push(t);
  return { clean, invalid };
}
const OBS_TAG_LIST = [...VALID_OBS_TAGS];

// ── b277 (2026-09-04) — the termly-update watcher trigger ────────────────────
/**
 * Toby: "create a watcher, that activates once the staff member has done the
 * termly update."
 *
 * This is that moment. Called from the POST and PUT handlers below AFTER the row
 * is safely written, and it is deliberately unable to break either of them:
 *
 *   · setImmediate — the practitioner's save has already returned. Assembling a
 *     document reads a dozen tables and may call the local model; none of that
 *     belongs on the latency of a tablet in a room.
 *   · require() inside the function — src/services/termly-watcher.js pulls in
 *     the sovereign model client, which asserts its host at require time. A bad
 *     OLLAMA_HOST must fail one termly update, not take down every observation
 *     in the setting by refusing to load this router.
 *   · every error swallowed and logged with IDS ONLY. An observation that saved
 *     is saved.
 *
 * A PENDING-REVIEW observation is skipped. b177 holds an unpublished
 * practitioner's work back from parents; publishing a termly update assembled
 * from it would drive straight through that gate. The hourly sweep picks it up
 * once a reviewer approves it, because the source query filters on
 * review_status='published' too.
 */
function _fireTermlyWatcher(obs, meta) {
  try {
    if (!obs || !obs.id || !obs.child_id) return;
    if (!(meta && meta.isTermlyUpdate)) return;
    if (meta.reviewStatus && meta.reviewStatus !== 'published') return;
    if (obs.dsl_only) return;
    setImmediate(() => {
      try {
        require('../services/termly-watcher')
          .onObservationCompleted(obs.child_id, obs.id)
          .catch(e => console.error('[b277] watcher hook failed obs=' + obs.id + ':', e.message));
      } catch (e) {
        console.error('[b277] watcher unavailable obs=' + obs.id + ':', e.message);
      }
    });
  } catch (e) {
    console.error('[b277] watcher trigger failed:', e.message);
  }
}

// b238 (2026-08-27, §2) — a TERMLY UPDATE is where resources and activities
// attach; an OBSERVATION takes its next steps from the framework and attaches
// neither. Two id spaces, because the two libraries are stored differently:
//   · resource cards  → src/content/resource-cards/<slug>.json  (file-backed, slug)
//   · activity bank   → ladn.planning_activities.id             (DB, integer)
// Both are capped: an observation attaching 200 cards is a client bug, not a use
// case, and an unbounded text[] from the tablet is not something to trust.
const OBS_ATTACH_MAX = 40;
const CARD_SLUG_RE = /^[a-z0-9-]{1,80}$/;

function _cardSlugArray(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(s => String(s == null ? '' : s).trim().toLowerCase())
    .filter(s => CARD_SLUG_RE.test(s)))].slice(0, OBS_ATTACH_MAX);
}

function _activityIdArray(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0))]
    .slice(0, OBS_ATTACH_MAX);
}

// POST /
// ── b237: edit-own vs edit-any ───────────────────────────────────────────────
// The matrix distinguishes observations.edit-own from observations.edit-any and
// nothing read either. Editing YOUR OWN observation needs edit-own; touching one
// another practitioner recorded needs edit-any. The PUT below ALSO carries the
// pre-existing SQL ownership clause (staff_id=$18 OR manager/deputy) — that stays;
// this gate refuses earlier and with an honest 403 instead of an empty result.
async function _requireObsEditPermission(req, res, next) {
  try {
    const { rows } = await getPool().query(
      'SELECT staff_id FROM observations WHERE id=$1', [req.params.id]);
    // Unknown id: let the route answer 404 rather than leaking existence via 403.
    if (!rows.length) return next();
    const isOwn = Number(rows[0].staff_id) === Number(req.user.id);
    const needed = isOwn ? 'observations.edit-own' : 'observations.edit-any';
    if (await hasCapability(req.user, needed)) return next();
    return res.status(403).json({ error: 'capability_forbidden', capability: needed });
  } catch (e) {
    // Fail closed — consistent with hasCapability.
    return res.status(403).json({ error: 'capability_forbidden', capability: 'observations.edit-own' });
  }
}

router.post('/', requireCapabilityLevel('observations.create', 'edit'), async (req, res) => {
  // fledge-off (2026-10-26): no NEW Fledge statement tag while the switch is off.
  if (req.body && Array.isArray(req.body.framework_tracker_ids)) {
    req.body.framework_tracker_ids = await FS.dropFledgeStatementIds(getPool(), req.body.framework_tracker_ids);
  }
  const {
    child_id, observation_text, observation_type, eyfs_areas, subject_areas,
    photo_urls, title, shared_with_parents, next_steps, analysis,
    baseline, planned_activity, termly_update, parental,
    additional_comments, staff_notes, framework_tracker_ids, obs_date,
    obs_tags, client_uuid, dsl_only,
    next_step_framework_statement_id, next_step_due_by, fulfils_next_step_id,
    // b238 (2026-08-27, §2): a PROGRESS UPDATE is where resources and activities
    // attach. A plain observation takes its next steps from the framework and
    // sends neither of these.
    linked_resource_card_slugs, linked_activity_ids,
    // b296 (2026-09-09): the progress update's own sections. Toby's shape is
    // "Progress update / What parents can do at home / Next steps at nursery /
    // Next steps at home / a free-text box", with each half of the next steps
    // carrying its own cards and activities. next_steps stays the NURSERY half,
    // so every row written since b238 keeps its meaning.
    at_home_ideas, next_steps_home, closing_note,
    home_resource_card_slugs, home_activity_ids
  } = req.body;
  if (!child_id || !observation_text)
    return res.status(400).json({ error: 'child_id and observation_text required' });
  // Used to reach the INSERT with a non-numeric child_id and 500 with a raw Postgres
  // "invalid input syntax for type integer" error (bughunt 2026-07-21).
  if (!/^\d+$/.test(String(child_id)))
    return res.status(400).json({ error: 'child_id must be a number' });

  const db = getPool();

  // ── Idempotency for the offline outbox (offlineobs-20260608) ───────────────
  // The tablet outbox attaches a client-generated UUID to each queued obs so a
  // retry after a flaky network can't create a duplicate. If we've already
  // stored a row for this client_uuid, return it unchanged with 200 so the
  // client treats the retry as a confirmed success and removes it from the queue.
  if (client_uuid) {
    try {
      const dup = await db.query(
        'SELECT * FROM observations WHERE client_uuid = $1 LIMIT 1', [client_uuid]);
      if (dup.rows.length) {
        return res.status(200).json({ ...dup.rows[0], deduped: true });
      }
    } catch (e) { /* fall through to insert; unique index still protects us */ }
  }
  // b280: observation_type went to Postgres unvalidated, so a bad value came back
  // as a 500 carrying the raw CHECK-constraint text. Tablets run an installed PWA
  // and a stale one really does send types the server has since dropped.
  {
    const bad = await checkEnum(db, 'observations', 'observation_type', observation_type);
    if (bad) return res.status(400).json(bad);
  }
  const { clean: cleanTags, invalid: badTags } = partitionObsTags(obs_tags || []);
  if (badTags.length) {
    return res.status(400).json({
      error: `Unknown observation tag(s): ${badTags.join(', ')}`,
      field: 'obs_tags', invalid: badTags, allowed: OBS_TAG_LIST,
    });
  }

  // b177 review queue: staff without publish rights save as pending_review —
  // shared_with_parents is forced false at the DB level (so every existing
  // parent-facing query, unmodified, simply never sees it) and their requested
  // value is remembered for Approve to apply.
  const canPublish = await _canPublish(db, req.user);
  const requestedShared = shared_with_parents || false;
  const reviewStatus = canPublish ? 'published' : 'pending_review';
  const effectiveShared = canPublish ? requestedShared : false;

  // Sync boolean flags from tags (so both representations stay consistent)
  const isBaseline         = cleanTags.includes('baseline')         || (baseline         ?? false);
  const isPlannedActivity  = cleanTags.includes('planned_activity') || (planned_activity  ?? false);
  const isTermlyUpdate     = cleanTags.includes('termly_update')    || (termly_update     ?? false);
  const isParental         = cleanTags.includes('parental')         || (parental          ?? false);

  // Merge flags back into tags array
  const mergedTags = [...new Set([
    ...cleanTags,
    ...(isBaseline        ? ['baseline']         : []),
    ...(isPlannedActivity ? ['planned_activity']  : []),
    ...(isTermlyUpdate    ? ['termly_update']     : []),
    ...(isParental        ? ['parental']          : []),
  ])];

  // b183 (2026-08-18): every observation carries a group_uuid. A group observation is
  // created by the client POSTing once per child with the SAME body.group_uuid, so all
  // its rows share one id and performance metrics can count it once
  // (COUNT(DISTINCT group_uuid)). A single observation gets its own fresh uuid, so the
  // column is never NULL going forward and the counting SQL needs no NULL special-case.
  const _groupUuid = (typeof req.body.group_uuid === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.body.group_uuid))
    ? req.body.group_uuid : randomUUID();

  // b238 (§2) — sanitise the termly-update attachments. Resource cards are
  // file-backed and keyed by slug; the activity bank is ladn.planning_activities
  // keyed by integer id. Anything else is dropped rather than 400'ing an
  // otherwise-valid observation the tablet has already queued offline.
  const cardSlugs = _cardSlugArray(linked_resource_card_slugs);
  const activityIds = _activityIdArray(linked_activity_ids);
  // b296 — the AT-HOME half, sanitised the same way and for the same reason.
  const homeCardSlugs = _cardSlugArray(home_resource_card_slugs);
  const homeActivityIds = _activityIdArray(home_activity_ids);

  try {
    const { rows } = await db.query(`
      INSERT INTO observations (group_uuid, child_id, staff_id, title, observation_text, observation_type,
        eyfs_areas, subject_areas, photo_urls, shared_with_parents,
        next_steps, analysis, baseline, planned_activity, termly_update, parental,
        additional_comments, staff_notes, linked_framework_ids, obs_tags,
        client_uuid, created_at, updated_at, dsl_only,
        review_status, requested_shared_with_parents, submitted_for_review_at,
        linked_resource_card_slugs, linked_activity_ids,
        at_home_ideas, next_steps_home, closing_note,
        home_resource_card_slugs, home_activity_ids)
      VALUES ($25,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$21,
        COALESCE($20::timestamptz, NOW()), NOW(), $22, $23, $24,
        CASE WHEN $23='pending_review' THEN NOW() ELSE NULL END,
        $26::text[], $27::integer[],
        $28, $29, $30, $31::text[], $32::integer[])
      ON CONFLICT (client_uuid) WHERE client_uuid IS NOT NULL DO NOTHING
      RETURNING *
    `, [child_id, req.user.id, title, observation_text,
        observation_type || 'learning_story',
        eyfs_areas || [], subject_areas || [],
        photo_urls || [], effectiveShared,
        next_steps, analysis,
        isBaseline, isPlannedActivity, isTermlyUpdate, isParental,
        additional_comments, staff_notes,
        framework_tracker_ids || [], mergedTags,
        obs_date || null, client_uuid || null, dsl_only || false,
        reviewStatus, canPublish ? null : requestedShared,
        _groupUuid, cardSlugs, activityIds,     // b238 — $26, $27
        // b296 — $28..$32. Nulled on a plain observation by the client, so an
        // observation's stored row is exactly what it was before this build.
        at_home_ideas || null, next_steps_home || null, closing_note || null,
        homeCardSlugs, homeActivityIds]);

    // ON CONFLICT DO NOTHING returns 0 rows if a concurrent/duplicate insert
    // raced us on the same client_uuid — fetch and return the winning row.
    if (!rows.length && client_uuid) {
      const existing = await db.query(
        'SELECT * FROM observations WHERE client_uuid = $1 LIMIT 1', [client_uuid]);
      if (existing.rows.length) {
        return res.status(200).json({ ...existing.rows[0], deduped: true });
      }
    }

    const obs = rows[0];

    // Link framework tracker rows.
    // framework_tracker_ids are framework_statements.id values (the obs UI sends the
    // selected statement ids, possibly across MULTIPLE frameworks). Resolve each to
    // its framework/area/aspect/statement and UPSERT one tracker row per
    // (child, framework, area, aspect, statement) — this is what makes multi-framework
    // tagging actually persist (one row per framework). Mirrors POST /framework-tracker/link
    // so that online saves AND offline outbox replays both link correctly.
    // (Previously this UPDATE'd by tracker PK, which no-op'd because the ids are
    // statement ids, not tracker ids — 0 of 12,002 obs ever linked.)
    // Frameworks in settings.reference_frameworks are "reference only" (2026-07-08):
    // their statements stay in observation_statements (staff-visible) but never
    // become framework_tracker assessment rows — e.g. EYFS links on a B25M setting.
    if (framework_tracker_ids?.length) {
      const refFw = await _referenceFrameworks(db);
      for (const sid of framework_tracker_ids) {
        try {
          const { rows: stRows } = await db.query(
            'SELECT framework, area, aspect, age_range, statement_text FROM framework_statements WHERE id=$1', [sid]);
          if (!stRows.length) continue;
          const st = stRows[0];
          if (refFw.has(st.framework)) continue;
          await db.query(`
            INSERT INTO framework_tracker
              (child_id, framework, area, aspect, age_range, statement, statement_id,
               status, linked_observation_id, assessed_by, assessed_at, created_at, updated_at)
            -- COALESCE area/aspect to '' so the (child,framework,area,aspect,statement) unique
            -- index actually dedupes: many framework_statements (e.g. ALL Development Matters)
            -- have aspect=NULL, and Postgres treats NULL as distinct in unique indexes, so a
            -- NULL aspect would never match ON CONFLICT and would insert duplicate tracker rows.
            VALUES ($1,$2,COALESCE($3,''),COALESCE($4,''),$5,$6,$7,'emerging',$8,$9,NOW(),NOW(),NOW())
            ON CONFLICT (child_id, framework, area, aspect, statement) DO UPDATE
              SET statement_id=EXCLUDED.statement_id,
                  status=CASE WHEN framework_tracker.status='not_yet' THEN 'emerging' ELSE framework_tracker.status END,
                  -- E3b: this was COALESCE($8, …), i.e. the new observation always won,
                  -- so tagging the same statement again moved the grid cell's evidence
                  -- link off the observation that first earned it and the earlier
                  -- observation silently lost its link. Keep the EARLIEST link; a cell
                  -- with no link yet still gets one.
                  linked_observation_id=COALESCE(framework_tracker.linked_observation_id, $8),
                  assessed_by=$9, assessed_at=NOW(), updated_at=NOW()
          `, [child_id, st.framework, st.area, st.aspect, st.age_range,
              st.statement_text, sid, obs.id, req.user.id]);
        } catch (e) { /* non-fatal: the observation is already saved; tracker link is best-effort */ }
      }
      // E3b — and record the links the observation view actually reads.
      await _syncObservationStatements(db, obs.id, framework_tracker_ids, req.user.id);
    }

    // Auto-create a next_steps row when next_steps text is non-empty
    let next_step_id = null;
    if (next_steps && next_steps.trim().length > 5) {
      const ns = await db.query(`
        INSERT INTO next_steps (observation_id, child_id, staff_id, description,
          framework_statement_id, due_by, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW(), NOW())
        RETURNING id
      `, [obs.id, child_id, req.user.id, next_steps.trim(),
          next_step_framework_statement_id || null,
          next_step_due_by || null]);
      next_step_id = ns.rows[0]?.id;
    }

    // If this obs fulfils a next step (next_step_followup tag), mark it completed
    if (fulfils_next_step_id) {
      await db.query(`
        UPDATE next_steps SET status='completed', completed_observation_id=$1, updated_at=NOW()
        WHERE id=$2 AND child_id=$3
      `, [obs.id, fulfils_next_step_id, child_id]);
    }

    // b177: fire the correctly-scoped notification for whichever path this obs took.
    try {
      const { rows: cRows } = await db.query(
        'SELECT key_person_id, room_id, first_name, last_name FROM children WHERE id=$1', [child_id]);
      const child = cRows[0];
      const childName = child ? `${child.first_name} ${child.last_name}` : null;
      if (reviewStatus === 'pending_review') {
        await _notifyReviewers(db, { roomId: child && child.room_id, childName, obsId: obs.id });
      } else if (effectiveShared) {
        await _notifyPublished(db, {
          childId: child_id, keyPersonId: child && child.key_person_id,
          actingUserId: req.user.id, obsId: obs.id, childName,
        });
      }
    } catch (e) { /* non-fatal — obs already saved */ }

    // b277 — THE WATCHER TRIGGER. "activates once the staff member has done the
    // termly update." Fire-and-forget after the response is decided: the
    // practitioner's save must never wait on, or be failed by, assembling a
    // document. _fireTermlyWatcher() re-reads everything it needs from the
    // database by id, so nothing from this request body can reach a family.
    _fireTermlyWatcher(obs, { isTermlyUpdate, reviewStatus });

    res.status(201).json({ ...obs, next_step_id });
  } catch (e) {
    // 23503 = FK violation — used to leak the raw constraint name for a client input
    // error (e.g. child_id pointing at no real child) as a 500 (bughunt 2026-07-21).
    if (e.code === '23503') return res.status(400).json({ error: 'child_id does not refer to a real child' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id
router.put('/:id', _requireObsEditPermission, async (req, res) => {
  const {
    observation_text, title, eyfs_areas, subject_areas, shared_with_parents,
    photo_urls, next_steps, analysis, baseline, planned_activity,
    termly_update, parental, additional_comments, staff_notes,
    framework_tracker_ids, observation_type, obs_date,
    // b238 (§2) — progress-update attachments, editable after the fact.
    linked_resource_card_slugs, linked_activity_ids,
    // b296 — the progress update's own sections, editable the same way.
    at_home_ideas, next_steps_home, closing_note,
    home_resource_card_slugs, home_activity_ids
  } = req.body;
  const db = getPool();
  try {
    // b177 review queue: a non-publish editor's shared_with_parents choice is
    // remembered (requested_shared_with_parents) rather than applied live — the
    // real column only flips on Approve. Editing a RETURNED item resubmits it
    // (back to pending_review + re-notify reviewers); we need the OLD status to
    // detect that transition, hence the SELECT before the UPDATE.
    const canPublish = await _canPublish(db, req.user);
    const { rows: beforeRows } = await db.query(
      'SELECT review_status, child_id FROM observations WHERE id=$1', [req.params.id]);
    const wasReturned = beforeRows.length && beforeRows[0].review_status === 'returned';

    const { rows } = await db.query(`
      UPDATE observations SET
        observation_text=COALESCE($1,observation_text),
        title=COALESCE($2,title),
        eyfs_areas=COALESCE($3,eyfs_areas),
        subject_areas=COALESCE($4,subject_areas),
        shared_with_parents = CASE WHEN $21 THEN COALESCE($5,shared_with_parents) ELSE shared_with_parents END,
        requested_shared_with_parents = CASE WHEN $21 THEN requested_shared_with_parents ELSE COALESCE($5,requested_shared_with_parents) END,
        photo_urls=COALESCE($6,photo_urls),
        observation_type=COALESCE($7,observation_type),
        next_steps=$8, analysis=$9,
        baseline=COALESCE($10,baseline),
        planned_activity=COALESCE($11,planned_activity),
        termly_update=COALESCE($12,termly_update),
        parental=COALESCE($13,parental),
        additional_comments=$14, staff_notes=$15,
        linked_framework_ids=COALESCE($16,linked_framework_ids),
        linked_resource_card_slugs=COALESCE($22::text[],linked_resource_card_slugs),
        linked_activity_ids=COALESCE($23::integer[],linked_activity_ids),
        -- b296. COALESCE, not a bare assignment: a client that knows nothing
        -- about these fields (an older tablet, or the outbox replaying a queued
        -- edit) must not wipe what somebody wrote today. Sending an explicit
        -- empty string / [] still clears them.
        at_home_ideas=COALESCE($24,at_home_ideas),
        next_steps_home=COALESCE($25,next_steps_home),
        closing_note=COALESCE($26,closing_note),
        home_resource_card_slugs=COALESCE($27::text[],home_resource_card_slugs),
        home_activity_ids=COALESCE($28::integer[],home_activity_ids),
        created_at=COALESCE($20::timestamptz,created_at),
        review_status = CASE WHEN review_status='returned' AND NOT $21 THEN 'pending_review' ELSE review_status END,
        submitted_for_review_at = CASE WHEN review_status='returned' AND NOT $21 THEN NOW() ELSE submitted_for_review_at END,
        review_note = CASE WHEN review_status='returned' AND NOT $21 THEN NULL ELSE review_note END,
        updated_at=NOW()
      WHERE id=$17 AND (staff_id=$18 OR $19 IN ('manager','deputy_manager'))
      RETURNING *
    `, [observation_text, title, eyfs_areas, subject_areas,
        shared_with_parents, photo_urls, observation_type,
        next_steps, analysis, baseline, planned_activity,
        termly_update, parental, additional_comments, staff_notes,
        framework_tracker_ids || null,
        req.params.id, req.user.id, req.user.role, obs_date || null, canPublish,
        // b238 — omitted (undefined) leaves the existing attachments alone;
        // an explicit [] clears them.
        Array.isArray(linked_resource_card_slugs) ? _cardSlugArray(linked_resource_card_slugs) : null,
        Array.isArray(linked_activity_ids) ? _activityIdArray(linked_activity_ids) : null,
        // b296 — $24..$28, same rule: undefined leaves it alone.
        at_home_ideas === undefined ? null : at_home_ideas,
        next_steps_home === undefined ? null : next_steps_home,
        closing_note === undefined ? null : closing_note,
        Array.isArray(home_resource_card_slugs) ? _cardSlugArray(home_resource_card_slugs) : null,
        Array.isArray(home_activity_ids) ? _activityIdArray(home_activity_ids) : null]);

    if (!rows.length) return res.status(404).json({ error: 'Not found or not authorised' });
    const obs = rows[0];

    // Resubmitted (returned -> pending_review) — tell reviewers again.
    if (wasReturned && obs.review_status === 'pending_review') {
      try {
        const { rows: cRows } = await db.query(
          'SELECT room_id, first_name, last_name FROM children WHERE id=$1', [obs.child_id]);
        const child = cRows[0];
        await _notifyReviewers(db, {
          roomId: child && child.room_id,
          childName: child ? `${child.first_name} ${child.last_name}` : null,
          obsId: obs.id,
        });
      } catch (e) { /* non-fatal */ }
    }

    // Re-link framework tracker rows
    if (framework_tracker_ids?.length) {
      await db.query(`
        UPDATE framework_tracker SET linked_observation_id=NULL
        WHERE linked_observation_id=$1 AND id != ALL($2::int[])
      `, [obs.id, framework_tracker_ids]);
      for (const ftId of framework_tracker_ids) {
        await db.query(`
          UPDATE framework_tracker
          SET linked_observation_id=$1, assessed_by=$2, assessed_at=NOW(), updated_at=NOW(),
            status = CASE WHEN status='not_yet' THEN 'emerging' ELSE status END
          WHERE id=$3 AND child_id=$4
        `, [obs.id, req.user.id, ftId, obs.child_id]);
      }
      // E3b — the edit path must record statement links too, or re-saving an
      // observation from Roost showed none of its tags back. Additive: a tag removed in
      // the UI is not deleted here, same as the tracker rows above.
      await _syncObservationStatements(db, obs.id, framework_tracker_ids, req.user.id);
    }

    // b277 — the same trigger on the edit path. A practitioner who saves an
    // observation and only then remembers to tick "Termly Update & Tracking"
    // must get the same result as one who ticked it first.
    _fireTermlyWatcher(obs, { isTermlyUpdate: !!obs.termly_update, reviewStatus: obs.review_status });

    res.json(obs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id/tags — replace obs_tags array
// login-20261023: editing an observation's tags/statements needs the same edit-own / edit-any rule as editing its text.
router.patch('/:id/tags', _requireObsEditPermission, async (req, res) => {
  const { obs_tags } = req.body;
  if (!Array.isArray(obs_tags)) return res.status(400).json({ error: 'obs_tags must be array' });
  const { clean: cleanTags, invalid: badTags } = partitionObsTags(obs_tags);
  if (badTags.length) {
    return res.status(400).json({
      error: `Unknown observation tag(s): ${badTags.join(', ')}`,
      field: 'obs_tags', invalid: badTags, allowed: OBS_TAG_LIST,
    });
  }
  try {
    const { rows } = await getPool().query(`
      UPDATE observations SET obs_tags=$1, updated_at=NOW()
      WHERE id=$2 RETURNING id, obs_tags
    `, [cleanTags, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id
// b237: the manager/deputy role check STAYS — capability is layered on top, stricter wins.
router.delete('/:id', requireCapabilityLevel('observations.edit-any', 'edit'), async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin']))
    return res.status(403).json({ error: 'Manager only' });
  // 2026-10-21 (chain E4): this was a bare DELETE, so it 500'd on any observation
  // another row still pointed at. SEVEN of the eleven foreign keys into
  // `observations` are ON DELETE NO ACTION and therefore block it:
  // framework_tracker.linked_observation_id (the one reported), plus
  // area_intention_sources, next_steps.completed_observation_id,
  // phonics_group_participants, planned_activities.{happened,source}_observation_id
  // and sen_targets.evidence_observation_id. The other four already cascade.
  //
  // The reference list is read from the FK catalogue rather than hard-coded, for two
  // reasons: this router is shared by every tenant and the demo schemas genuinely do
  // not all have these tables (demo_secondary is missing three), so a fixed list of
  // UPDATEs would simply move the 500; and a future FK is then handled by default.
  // to_regclass('observations') resolves through the request's own search_path, so
  // each tenant detaches its own rows and nothing here names a schema.
  //
  // Detach rather than delete: the tracker cell keeps its judgement and the next step
  // keeps its status, they just lose the evidence pointer. Deleting those rows would
  // throw away assessment history that a practitioner recorded separately.
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad id' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: before } = await client.query(
      'SELECT id, child_id, staff_id FROM observations WHERE id=$1 FOR UPDATE', [id]);
    if (!before.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const { rows: refs } = await client.query(`
      SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
        FROM pg_constraint k
        JOIN pg_class c      ON c.oid = k.conrelid
        JOIN pg_namespace n  ON n.oid = c.relnamespace
        JOIN pg_attribute a  ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
       WHERE k.contype = 'f'
         AND k.confrelid = to_regclass('observations')
         AND array_length(k.conkey, 1) = 1
         AND k.confdeltype IN ('a', 'r')
         AND NOT a.attnotnull`);
    const detached = [];
    for (const r of refs) {
      // Identifiers come from pg_catalog, never from the request, and are quoted anyway.
      const q = `UPDATE "${r.schema_name}"."${r.table_name}" SET "${r.column_name}"=NULL WHERE "${r.column_name}"=$1`;
      const out = await client.query(q, [id]);
      if (out.rowCount) detached.push(`${r.table_name}.${r.column_name}=${out.rowCount}`);
    }
    await client.query('DELETE FROM observations WHERE id=$1', [id]);
    await client.query('COMMIT');
    recordAudit({ req, action: 'delete', entity_type: 'observation', entity_id: id,
      meta: { child_id: before[0].child_id, author_id: before[0].staff_id, detached } });
    res.json({ ok: true, detached });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /:id/share — toggle shared_with_parents
// b237: publishing an observation to parents is exactly observations.publish-to-parents.
router.post('/:id/share', requireCapabilityLevel('observations.publish-to-parents', 'edit'), async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      UPDATE observations SET shared_with_parents=NOT shared_with_parents, updated_at=NOW()
      WHERE id=$1 RETURNING id, shared_with_parents
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/framework — framework tracker for a child
router.get('/child/:childId/framework', async (req, res) => {
  const { framework = 'birth_to_5' } = req.query;
  try {
    const { rows } = await getPool().query(`
      SELECT ft.*, s.first_name || ' ' || s.last_name as assessed_by_name
      FROM framework_tracker ft
      LEFT JOIN staff s ON s.id=ft.assessed_by
      WHERE ft.child_id=$1 AND ft.framework=$2
      ORDER BY ft.area, ft.aspect, ft.age_range, ft.id
    `, [req.params.childId, framework]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /framework/:ftId — update a single framework tracker entry
router.put('/framework/:ftId', async (req, res) => {
  const { status, notes, linked_observation_id } = req.body;
  try {
    const { rows } = await getPool().query(`
      UPDATE framework_tracker SET
        status=COALESCE($1,status),
        notes=$2,
        linked_observation_id=COALESCE($3,linked_observation_id),
        assessed_by=$4, assessed_at=NOW(), updated_at=NOW()
      WHERE id=$5 RETURNING *
    `, [status, notes, linked_observation_id, req.user.id, req.params.ftId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FRAMEWORK STATEMENTS CATALOGUE ──────────────────────────────────────────

// GET /statements — browse/search framework statements
router.get('/statements', async (req, res) => {
  const { framework, area, q, limit = 50 } = req.query;
  const db = getPool();
  const params = [];
  // b278: profile_refs rides along so a Fledge progression statement can show
  // the Profile statements it builds towards as ICONS, not as "→ 1, 2".
  let sql = 'SELECT id,framework,area,aspect,age_range,statement_code,statement_text,ordinal,profile_refs FROM framework_statements WHERE 1=1';
  // b332 — retired statements (the Fledge Profile) are not offered. ?include_retired=1
  // is for the framework document and the mapping page, which still show them.
  if (String(req.query.include_retired || '') !== '1') sql += ' AND is_active';
  if (framework) { params.push(framework); sql += ` AND framework=$${params.length}`; }
  // fledge-off (2026-10-26): Fledge statements are not offered while the switch is off
  // (a search with no framework must not surface them either).
  if (!(await FS.isFledgeEnabled(db))) sql += ` AND framework <> 'fledge'`;
  if (area) { params.push(area); sql += ` AND area=$${params.length}`; }
  if (q) {
    params.push(q);
    sql += ` AND (statement_text ILIKE '%'||$${params.length}||'%' OR area ILIKE '%'||$${params.length}||'%' OR aspect ILIKE '%'||$${params.length}||'%')`;
  }
  // Exclude stubs from search results unless specifically browsing
  if (!area && !q) {
    sql += ` AND statement_text NOT LIKE '(stub%'`;
  }
  sql += ` ORDER BY framework, ordinal, id LIMIT $${params.length + 1}`;
  params.push(Math.min(parseInt(limit) || 50, 200));
  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/age-bands — most recent age_range per framework+area
router.get('/child/:childId/age-bands', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT ft.framework, ft.area, ft.age_range,
             MAX(ft.assessed_at) as last_assessed
      FROM framework_tracker ft
      WHERE ft.child_id=$1 AND ft.age_range IS NOT NULL
      GROUP BY ft.framework, ft.area, ft.age_range
      ORDER BY ft.framework, ft.area, MAX(ft.assessed_at) DESC
    `, [req.params.childId]);
    // Return most recent per framework+area
    const map = {};
    rows.forEach(r => {
      const k = r.framework + '|' + r.area;
      if (!map[k]) map[k] = r;
    });
    res.json(Object.values(map));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /ai-suggest-statements — AI-powered statement linking suggestions
router.post('/ai-suggest-statements', async (req, res) => {
  const { observation_text, child_id, frameworks = ['eyfs_statutory'] } = req.body;
  if (!observation_text) return res.status(400).json({ error: 'observation_text required' });

  // b162: resolve short framework keys ('B25') to internal keys ('birth_to_5_la').
  // The obs-new drawer passes the short key it uses for /api/framework-statements;
  // without this the ANY($frameworks) candidate filter matched nothing.
  const fwKeys = (Array.isArray(frameworks) ? frameworks : [frameworks])
    .filter(Boolean).map(resolveFramework);
  let useFrameworks = fwKeys.length ? [...new Set(fwKeys)] : ['eyfs_statutory'];

  const db = getPool();
  // fledge-off (2026-10-26): never suggest a Fledge statement while the switch is off.
  useFrameworks = await FS.withoutFledge(db, useFrameworks);
  if (!useFrameworks.length) useFrameworks = [await FS.effectiveDefaultFramework(db)];
  try {
    // Get child's age in months
    let ageMonths = null;
    if (child_id) {
      const { rows: childRows } = await db.query(
        'SELECT EXTRACT(MONTH FROM AGE(NOW(), date_of_birth))::int + EXTRACT(YEAR FROM AGE(NOW(), date_of_birth))::int*12 as age_months FROM children WHERE id=$1',
        [child_id]
      );
      if (childRows.length) ageMonths = childRows[0].age_months;
    }

    const ageFilter = ageMonths !== null ? buildAgeRanges(ageMonths) : null;

    // Classify observation into EYFS developmental area(s) before candidate fetch
    const { areas: classifiedAreas } = classifyArea(observation_text);

    // Fetch candidates with progressive fallback so a framework whose age-band or
    // area label format differs from the classifier's never returns zero rows
    // (b162 — birth_to_5_la age labels are "Range 6 (48-71 months)", not the
    // legacy "Range 6 (40 to 60+ months)" buildAgeRanges emits, and its areas
    // use different casing e.g. "Understanding The World"). Area match is
    // case-insensitive; if area+age is empty we drop age, then drop area.
    async function fetchCandidates({ withArea, withAge }) {
      const params = [useFrameworks];
      let sql = `
        SELECT id, framework, area, aspect, age_range, statement_text
        FROM framework_statements
        WHERE framework = ANY($1)
          AND is_active                       -- b332: never suggest a retired statement
          AND statement_text NOT LIKE '(stub%'
      `;
      if (withArea && classifiedAreas) {
        params.push(classifiedAreas.map(a => a.toLowerCase()));
        sql += ` AND LOWER(area) = ANY($${params.length})`;
      }
      if (withAge && ageFilter && ageFilter.length) {
        params.push(ageFilter);
        sql += ` AND (age_range = ANY($${params.length}) OR age_range='End of Reception' OR age_range IS NULL)`;
      }
      const fetchLimit = (withArea && classifiedAreas) ? 40 : 60;
      sql += ` ORDER BY framework, ordinal LIMIT ${fetchLimit}`;
      const { rows } = await db.query(sql, params);
      return rows;
    }

    let candidates = await fetchCandidates({ withArea: true, withAge: true });
    if (!candidates.length) candidates = await fetchCandidates({ withArea: true, withAge: false });
    if (!candidates.length) candidates = await fetchCandidates({ withArea: false, withAge: false });
    if (!candidates.length) return res.json({ suggestions: [], method: 'no_candidates' });

    // Keyword-score and narrow pool to 15 (area-scoped) or 25 (all-area fallback)
    const obsWords = tokenise(observation_text);
    const poolSize = classifiedAreas ? 15 : 25;
    let scored = candidates.map(c => ({
      ...c,
      _kwScore: overlap(obsWords, tokenise(c.statement_text + ' ' + (c.area || '') + ' ' + (c.aspect || '')))
    })).sort((a, b) => b._kwScore - a._kwScore).slice(0, poolSize);

    // Save keyword-ranked top 3 BEFORE shuffling — used as fallback
    const kwTop = scored.slice(0, 3);

    // Shuffle to prevent positional anchoring for AI (Fisher-Yates)
    for (let i = scored.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [scored[i], scored[j]] = [scored[j], scored[i]];
    }

    // Session-level AI degradation check
    const staffId = req.user.id;
    let suggestions;

    if (isAiDegraded(staffId)) {
      appendLog(`Staff ${staffId}: AI degraded — keyword fallback`);
      suggestions = kwTop;
      suggestions._method = 'keyword_degraded';
    } else {
      try {
        suggestions = await aiSuggest(observation_text, scored, classifiedAreas);
        recordAiSuccess(staffId);
      } catch (err) {
        appendLog(`AI suggest failed: ${err.message} — falling back to keyword`);
        recordAiFailure(staffId);
        suggestions = kwTop;
        suggestions._method = 'keyword';
      }
    }

    res.json({ suggestions: suggestions.slice(0, 3), method: suggestions._method || 'ai' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function buildAgeRanges(months) {
  // Returns plausible age-band labels across the framework variants we hold, for
  // the child's age. Legacy B25M/DM labels PLUS birth_to_5_la's own label format
  // (b162: "Range N (X-Y months)" — 0-9 / 9-18 / 18-24 / 24-36 / 36-48 / 48-71),
  // so the age filter actually narrows birth_to_5_la instead of matching nothing.
  const ranges = [];
  // Legacy B25M / Development Matters bands
  if (months <= 20) ranges.push('Range 1 (Birth to 12 months)', 'Range 2 (8 to 20 months)', 'Birth to 3');
  if (months >= 8 && months <= 30) ranges.push('Range 2 (8 to 20 months)', 'Range 3 (16 to 26 months)', 'Birth to 3');
  if (months >= 16 && months <= 40) ranges.push('Range 3 (16 to 26 months)', 'Range 4 (22 to 36 months)', 'Birth to 3', '3 and 4-year-olds');
  if (months >= 22 && months <= 50) ranges.push('Range 4 (22 to 36 months)', 'Range 5 (30 to 50 months)', '3 and 4-year-olds');
  if (months >= 30 && months <= 65) ranges.push('Range 5 (30 to 50 months)', 'Range 6 (40 to 60+ months)', '3 and 4-year-olds', 'Children in Reception');
  if (months >= 40) ranges.push('Range 6 (40 to 60+ months)', 'Children in Reception');
  // birth_to_5_la label format
  if (months <= 12) ranges.push('Range 1 (0-9 months)', 'Range 1-2 (0-18 months)');
  if (months >= 6 && months <= 20) ranges.push('Range 2 (9-18 months)', 'Range 1-2 (0-18 months)');
  if (months >= 15 && months <= 27) ranges.push('Range 3 (18-24 months)');
  if (months >= 21 && months <= 40) ranges.push('Range 4 (24-36 months)');
  if (months >= 32 && months <= 52) ranges.push('Range 5 (36-48 months)');
  if (months >= 44) ranges.push('Range 6 (48-71 months)');
  return [...new Set(ranges)];
}

function tokenise(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3);
}

function overlap(a, b) {
  const setB = new Set(b);
  return a.filter(w => setB.has(w)).length;
}

async function aiSuggest(obsText, candidates, classifiedAreas) {
  // Assign random 3-char codes — avoids numeric ID anchoring in the LLM
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const usedCodes = new Set();
  const coded = candidates.map(c => {
    let code;
    do { code = Array.from({length: 3}, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
    while (usedCodes.has(code));
    usedCodes.add(code);
    return { ...c, _code: code };
  });
  const codeMap = {};
  coded.forEach(c => { codeMap[c._code] = c; });

  const areaConstraint = classifiedAreas
    ? `\nThis observation relates to the "${classifiedAreas.join(' / ')}" area of EYFS development. Only suggest statements from this area. Do not suggest statements from other developmental areas even if the child communicated or spoke during the activity.`
    : '';

  const candidateList = coded.map(c => `[${c._code}] ${c.statement_text}`).join('\n');

  const fullPrompt = `You are an Early Years practitioner in an English nursery linking observations to EYFS learning statements.

Rules:
- Return EXACTLY 3 codes from the candidate list below.
- Only suggest statements directly evidenced by what is described.
- Match the PRIMARY developmental focus of the observation — not incidental behaviour.
- If the observation is about counting, suggest Mathematics statements only.
- Return JSON ONLY: {"codes": ["XX1","YY2","ZZ3"]}. No prose, no explanation.${areaConstraint}

Observation: ${obsText.slice(0, 600)}

Candidates:
${candidateList}`;

  const controller = new AbortController();
  // b162: 7s was too tight — a cold-load / Ascent load-spike silently degraded
  // every suggest to keyword. The obs-new drawer shows a spinner + cancel, so a
  // longer server budget is fine; warm round-trips still return in ~0.5s.
  const timer = setTimeout(() => controller.abort(), 20000);

  const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: AI_SUGGESTER_MODEL(), prompt: fullPrompt, stream: false, think: false, options: ai.options({ temperature: 0 }) }),
    signal: controller.signal
  });
  clearTimeout(timer);

  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  const data = await r.json();
  const raw = (data.response || '').trim();

  const jsonStart = raw.indexOf('{');
  const jsonEnd   = raw.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) throw new Error(`Bad AI response: ${raw.slice(0, 120)}`);
  const { codes } = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  if (!Array.isArray(codes) || !codes.length) throw new Error('No codes in response');

  const resolved = codes.map(code => codeMap[code]).filter(Boolean)
    .map(({ _code, _kwScore, ...rest }) => rest);
  if (!resolved.length) throw new Error('No valid codes matched candidates');
  return resolved;
}

// POST /framework-tracker/link — upsert tracker rows from statement IDs
router.post('/framework-tracker/link', async (req, res) => {
  const { child_id, observation_id, statement_ids = [], status = 'emerging' } = req.body;
  if (!child_id || !statement_ids.length) return res.status(400).json({ error: 'child_id and statement_ids required' });
  const db = getPool();
  try {
    const linked = [];
    // fledge-off (2026-10-26): Fledge statements are not linked while the switch is off.
    for (const sid of await FS.dropFledgeStatementIds(db, statement_ids)) {
      const { rows: stRows } = await db.query('SELECT * FROM framework_statements WHERE id=$1', [sid]);
      if (!stRows.length) continue;
      const st = stRows[0];
      const { rows } = await db.query(`
        INSERT INTO framework_tracker
          (child_id, framework, area, aspect, age_range, statement, statement_id,
           status, linked_observation_id, assessed_by, assessed_at, created_at, updated_at)
        -- COALESCE area/aspect to '' so NULL-aspect statements (e.g. all Development Matters)
        -- dedupe via the unique index instead of inserting duplicate tracker rows.
        VALUES ($1,$2,COALESCE($3,''),COALESCE($4,''),$5,$6,$7,$8,$9,$10,NOW(),NOW(),NOW())
        ON CONFLICT (child_id, framework, area, aspect, statement) DO UPDATE
          SET statement_id=EXCLUDED.statement_id,
              status=CASE WHEN framework_tracker.status='not_yet' THEN $8 ELSE framework_tracker.status END,
              linked_observation_id=COALESCE($9, framework_tracker.linked_observation_id),
              assessed_by=$10, assessed_at=NOW(), updated_at=NOW()
        RETURNING *
      `, [child_id, st.framework, st.area, st.aspect, st.age_range,
          st.statement_text, sid, status, observation_id || null, req.user.id]);
      if (rows.length) linked.push(rows[0]);
    }
    res.json({ linked });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/framework-statements — linked statement IDs for a child
router.get('/child/:childId/framework-statements', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT ft.id as tracker_id, ft.statement_id, ft.framework, ft.area, ft.aspect,
             ft.age_range, ft.status, ft.linked_observation_id,
             fs.statement_text, fs.statement_code
      FROM framework_tracker ft
      LEFT JOIN framework_statements fs ON fs.id=ft.statement_id
      WHERE ft.child_id=$1 AND ft.statement_id IS NOT NULL
      ORDER BY ft.framework, ft.area, ft.id
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /coverage — coverage stats for curriculum heatmap
router.get('/coverage', async (req, res) => {
  const { framework = 'eyfs_statutory', room_id, weeks = 12 } = req.query;
  const db = getPool();
  try {
    const since = new Date();
    since.setDate(since.getDate() - (parseInt(weeks) || 12) * 7);
    const params = [framework, since.toISOString()];
    const childConds = [];
    if (room_id) { params.push(room_id); childConds.push(`c.room_id=$${params.length}`); }
    // ?mine=1 → only the requesting staff member's key children
    if (req.query.mine === '1' && req.user && req.user.id) { params.push(req.user.id); childConds.push(`c.key_person_id=$${params.length}`); }
    const childWhere = childConds.length
      ? `AND ft.child_id IN (SELECT id FROM children c WHERE ${childConds.join(' AND ')})` : '';
    const { rows } = await db.query(`
      SELECT fs.area, fs.aspect, fs.age_range, fs.statement_code, fs.statement_text,
             COUNT(DISTINCT ft.linked_observation_id) as link_count
      FROM framework_statements fs
      LEFT JOIN framework_tracker ft ON ft.statement_id=fs.id
        AND ft.linked_observation_id IS NOT NULL
        AND ft.assessed_at >= $2
        ${childWhere}
      WHERE fs.framework=$1
        AND fs.statement_text NOT LIKE '(stub%'
      GROUP BY fs.id, fs.area, fs.aspect, fs.age_range, fs.statement_code, fs.statement_text
      ORDER BY fs.area, fs.ordinal
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /monthly-grid — observation counts per child per month (the obs-tracker grid).
// Optional filters: staff_id, room_id, area (EYFS area substring), mine=1 (my key children),
// child_ids=1,2,3 (scope to an explicit selected set — EY home multi-select; Prompt 50).
router.get('/monthly-grid', async (req, res) => {
  const months = Math.min(Math.max(parseInt(req.query.months) || 6, 1), 18);
  const db = getPool();
  try {
    const since = new Date(); since.setMonth(since.getMonth() - (months - 1)); since.setDate(1);
    const params = [since.toISOString()];
    const where = ["o.created_at >= $1", "(c.is_active = true)"];
    if (req.query.staff_id) { params.push(req.query.staff_id); where.push(`o.staff_id = $${params.length}`); }
    if (req.query.room_id)  { params.push(req.query.room_id);  where.push(`c.room_id = $${params.length}`); }
    if (req.query.mine === '1' && req.user && req.user.id) { params.push(req.user.id); where.push(`c.key_person_id = $${params.length}`); }
    if (req.query.child_ids) {
      const ids = String(req.query.child_ids).split(',').map(n => parseInt(n, 10)).filter(Boolean);
      if (ids.length) { params.push(ids); where.push(`o.child_id = ANY($${params.length}::int[])`); }
    }
    if (req.query.area)     { params.push('%' + req.query.area + '%'); where.push(`o.eyfs_areas::text ILIKE $${params.length}`); }
    const { rows } = await db.query(`
      SELECT o.child_id, c.first_name, c.last_name, c.room_id,
             to_char(date_trunc('month', o.created_at), 'YYYY-MM') AS ym,
             COUNT(*) AS n
      FROM observations o
      JOIN children c ON c.id = o.child_id
      WHERE ${where.join(' AND ')}
      GROUP BY o.child_id, c.first_name, c.last_name, c.room_id, ym
    `, params);
    // Build the month column list (oldest→newest)
    const cols = [];
    const d = new Date(since);
    for (let i = 0; i < months; i++) { cols.push(d.toISOString().slice(0, 7)); d.setMonth(d.getMonth() + 1); }
    // Pivot into child rows
    const byChild = {};
    for (const r of rows) {
      if (!byChild[r.child_id]) byChild[r.child_id] = { child_id: r.child_id, name: `${r.first_name} ${r.last_name}`, room_id: r.room_id, months: {}, total: 0 };
      byChild[r.child_id].months[r.ym] = parseInt(r.n);
      byChild[r.child_id].total += parseInt(r.n);
    }
    const children = Object.values(byChild).sort((a, b) => b.total - a.total);
    res.json({ months: cols, children });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /populated-frameworks — which frameworks have ≥ THRESHOLD real (non-stub)
// statements. Data-driven off framework_statements (b108): previously a hardcoded
// key list that silently omitted Fledge (the curriculum framework, now the default)
// and birth_to_5_la. Now EVERY framework that actually has statements is returned,
// so a framework can never be "invisible" just because it wasn't in the list.
// Response shape is backward-compatible (boolean per framework key) and adds:
//   frameworks: [{framework,label,statements,has_tracker_data,is_default}]  (sorted)
//   default:    the configured/inferred default framework key
const _POP_FW_THRESHOLD = 8;
router.get('/populated-frameworks', async (req, res) => {
  try {
    const db = getPool();
    const [{ rows: sRows }, { rows: tRows }, { rows: dRows }] = await Promise.all([
      db.query(`
        SELECT framework, COUNT(*)::int AS n
        FROM framework_statements
        WHERE statement_text NOT ILIKE '%stub%' AND statement_text NOT LIKE '(stub%'
        GROUP BY framework`),
      db.query(`SELECT DISTINCT framework FROM framework_tracker WHERE statement_id IS NOT NULL`),
      db.query(`SELECT value FROM settings WHERE key='default_framework'`),
    ]);
    const counts   = {};
    sRows.forEach(r => { counts[r.framework] = r.n; });
    const hasData  = new Set(tRows.map(r => r.framework));
    let dflt       = (dRows[0] && dRows[0].value) || _inferDefaultFramework();
    // fledge-off (2026-10-26): Fledge is switched off (src/lib/fledge-switch.js).
    // A hidden framework is not offered anywhere, and is never the default.
    const _fledgeOn = await FS.isFledgeEnabled(db);
    if (!_fledgeOn) { delete counts.fledge; if (FS.isFledgeKey(dflt)) dflt = FS.OFF_FALLBACK; }

    // Backward-compatible boolean map: every framework present in the catalogue,
    // plus the legacy fixed keys (so old callers that check e.g. pop.birth_to_5
    // never get `undefined`).
    const out = {};
    ['eyfs_statutory','birth_to_5','development_matters','iters_3','ecers_3','eydj','eylog_dev_matters']
      .forEach(k => { out[k] = (counts[k] || 0) >= _POP_FW_THRESHOLD; });
    Object.keys(counts).forEach(k => { out[k] = counts[k] >= _POP_FW_THRESHOLD; });

    // b180: wizard-built frameworks carry their display name in framework_meta.
    // Guarded — editions that haven't run the b180 migration just fall through to
    // the static label map, exactly as before.
    let customLabels = {};
    try {
      const { rows: mRows } = await db.query(
        `SELECT framework, display_name FROM framework_meta WHERE display_name IS NOT NULL`);
      mRows.forEach(r => { customLabels[r.framework] = r.display_name; });
    } catch (_) { customLabels = {}; }

    out.frameworks = Object.keys(counts)
      .filter(k => counts[k] >= _POP_FW_THRESHOLD)
      .map(k => ({
        framework: k,
        label: customLabels[k] || TRACKER_FW_LABELS[k] || k,
        statements: counts[k],
        has_tracker_data: hasData.has(k),
        is_default: k === dflt,
      }))
      .sort((a, b) => (b.is_default - a.is_default) || (b.has_tracker_data - a.has_tracker_data) || (b.statements - a.statements));
    out.default = dflt;
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FRAMEWORK TRACKER GRID (EyLog-style "view all the data at once") ──────────
// Prompt 27B. Returns, for a SELECTED SET of children, the full statement grid
// for one framework + each child's status per statement (the coloured cell) +
// the observation that evidences it (click-through) + each child's next steps.
const TRACKER_FW_LABELS = {
  birth_to_5_la:       'Birth to 5 Matters',
  birth_to_5:          'Birth to 5 (legacy)',
  eyfs_statutory:      'Early Learning Goals (EYFS Profile)',
  development_matters: 'Development Matters',
  eylog_dev_matters:   'Development Matters (EyLog)',
  fledge:              'Fledge',
  eydj:                'EYDJ (SEN)',
  iters_3:             'ITERS-3',
  ecers_3:             'ECERS-3',
  coel:                'Characteristics of Effective Learning',
  leuven:              'Leuven (wellbeing & involvement)',
  phonics:             'Phonics',
  send:                'SEND',
};

// b180: a wizard-built framework's label lives in framework_meta.display_name.
// Guarded so editions without the b180 migration behave exactly as before.
async function _fwLabel(db, fw) {
  if (TRACKER_FW_LABELS[fw]) return TRACKER_FW_LABELS[fw];
  try {
    const { rows } = await db.query('SELECT display_name FROM framework_meta WHERE framework=$1', [fw]);
    if (rows[0] && rows[0].display_name) return rows[0].display_name;
  } catch (_) { /* table absent — fall through */ }
  return fw;
}

// Reference-only frameworks (settings.reference_frameworks, JSON array of framework
// keys, e.g. ["eyfs_statutory","development_matters"]). Statements from these
// frameworks can be linked to observations for staff reference, but must NOT create
// framework_tracker assessment rows (the setting tracks a different framework).
// Missing/invalid setting → empty set → behaviour unchanged. Added 2026-07-08.
async function _referenceFrameworks(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='reference_frameworks'`);
    const arr = rows[0] && rows[0].value ? JSON.parse(rows[0].value) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

// E3b (2026-10-20) — WRITE THE STATEMENT LINKS THE OBSERVATION VIEW READS.
// Tagging an observation with framework statements only ever wrote framework_tracker
// (the child's assessment grid). /ey/observation/:id, the parent report and
// GET /:id/statements all read observation_statements, which nothing on the save path
// filled — so a practitioner tagged two statements, saved, reopened the observation
// and saw none of them. (The 13,043 rows in there on prod are EyLog imports and
// ai.js's suggestion flow, which is why the table looked populated.)
//
// Additive by construction: it only ever INSERTs missing (observation_id, statement_id)
// pairs and never deletes or rewrites one, so re-saving an observation cannot lose a
// link a colleague added. NOT EXISTS rather than ON CONFLICT because two tenant schemas
// (childrenscorner 72, htps 97) carry pre-existing duplicate pairs, so the unique index
// an ON CONFLICT target needs cannot exist there.
//
// Reference-only frameworks ARE recorded here on purpose: they are deliberately kept out
// of framework_tracker (see the POST handler) but staff must still see what they tagged.
async function _syncObservationStatements(db, obsId, statementIds, userId) {
  if (!obsId || !Array.isArray(statementIds) || !statementIds.length) return 0;
  // fledge-off (2026-10-26): every save path comes through here — no new Fledge link.
  statementIds = await FS.dropFledgeStatementIds(db, statementIds);
  const ids = [...new Set(statementIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return 0;
  try {
    const { rowCount } = await db.query(`
      INSERT INTO observation_statements
        (observation_id, statement_id, framework, statement_code, is_next_step, source, confirmed_by)
      SELECT $1, fs.id, fs.framework, fs.statement_code, false, 'manual', $3
        FROM framework_statements fs
       WHERE fs.id = ANY($2::int[])
         AND NOT EXISTS (
           SELECT 1 FROM observation_statements os
            WHERE os.observation_id = $1 AND os.statement_id = fs.id)
    `, [obsId, ids, userId || null]);
    return rowCount || 0;
  } catch (e) {
    // Non-fatal, exactly like the tracker link below it: the observation is saved.
    console.error('[observations] statement links:', e.message);
    return 0;
  }
}

// b354 (2026-09-24) — which frameworks THIS setting offers for tagging/tracking.
// settings.active_frameworks (JSON array of framework_statements.framework keys,
// e.g. ["birth_to_5_la","coel","fledge"]). This DE-LISTS frameworks from the
// selectors below — it never deletes framework_statements/framework_tracker rows,
// so historical tagging against a hidden framework still reads back fine.
// Missing/empty setting → null → every caller falls back to "show everything",
// which is exactly today's behaviour. Demo editions have no such row, so they
// are unaffected by an LADN-only change to this setting.
async function _activeFrameworks(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='active_frameworks'`);
    const arr = rows[0] && rows[0].value ? JSON.parse(rows[0].value) : [];
    return (Array.isArray(arr) && arr.length) ? new Set(arr) : null;
  } catch { return null; }
}

// ── DEFAULT FRAMEWORK (per-instance) ────────────────────────────────────────
// Which framework the tracker pre-selects. Persisted in settings.default_framework;
// if unset, inferred from the edition (state-school editions → ELG/EYFS-Profile,
// nurseries → Birth to 5). LADN production has no settings row and is NOT a school
// edition, so it stays on birth_to_5 — this endpoint never changes that.
function _inferDefaultFramework() {
  const ed = (process.env.WREN_EDITION || '').toLowerCase();
  return (ed === 'ht' || ed === 'primary' || ed === 'secondary') ? 'eyfs_statutory' : 'birth_to_5';
}

// GET /default-framework — the configured/inferred default tracker framework.
router.get('/default-framework', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='default_framework'`);
    let fw = (rows[0] && rows[0].value) || _inferDefaultFramework();
    const active = await _activeFrameworks(db);
    // fledge-off (2026-10-26): Fledge is switched off (src/lib/fledge-switch.js).
    // Never answer 'fledge' while it is off, and never list it as active.
    // `fledge_enabled` lets the obs drawer drop its hard-coded Fledge chips.
    const fledgeOn = await FS.isFledgeEnabled(db);
    if (!fledgeOn && FS.isFledgeKey(fw)) fw = FS.OFF_FALLBACK;
    const activeList = active ? Array.from(active).filter(k => fledgeOn || !FS.isFledgeKey(k)) : null;
    res.json({
      framework: fw, label: await _fwLabel(db, fw), source: (rows[0] && rows[0].value) ? 'setting' : 'edition',
      active: activeList, fledge_enabled: fledgeOn,
    });
  } catch (e) {
    const fw = _inferDefaultFramework();
    res.json({ framework: fw, label: TRACKER_FW_LABELS[fw] || fw, source: 'edition', active: null });
  }
});

// PUT /default-framework {framework} — manager toggle, persisted in settings.
router.put('/default-framework', async (req, res) => {
  if (!req.user || !hasRole(req.user, ['manager','deputy_manager','admin','headteacher','business_manager'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  const fw = ((req.body && req.body.framework) || '').trim();
  if (!fw) return res.status(400).json({ error: 'framework required' });
  try {
    await getPool().query(
      `INSERT INTO settings (key, value, updated_by, updated_at)
       VALUES ('default_framework', $1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [fw, req.user.id]);
    res.json({ ok: true, framework: fw, label: await _fwLabel(getPool(), fw) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /tracker-frameworks — frameworks that actually have assessment data, for the selector
router.get('/tracker-frameworks', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ft.framework,
             COUNT(*)::int AS assessments,
             COUNT(DISTINCT ft.statement_id)::int AS statements,
             COUNT(DISTINCT ft.child_id)::int AS children
      FROM framework_tracker ft
      WHERE ft.statement_id IS NOT NULL
      GROUP BY ft.framework
      ORDER BY assessments DESC
    `);
    const active = await _activeFrameworks(db);
    // fledge-off (2026-10-26): Fledge is switched off (src/lib/fledge-switch.js).
    const visible = await FS.withoutFledge(db, active ? rows.filter(r => active.has(r.framework)) : rows);
    res.json(visible.map(r => ({ ...r, label: TRACKER_FW_LABELS[r.framework] || r.framework })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FLEDGE BANDS (read-only) ─────────────────────────────────────────────────
// b100. Best-fit Fledge band (1–5) per child per area, from ladn.band_judgements
// (latest judged_on wins per child+area). Seeded by scripts/b25-to-fledge-translate.js.
// GET ?child_id=N → that child's areas. No child_id → cohort band distribution
// (counts only, no child names) across attending children.
const FLEDGE_AREA_ORDER = [
  'Communication & Language',
  'Personal, Social & Emotional Development',
  'Physical Development',
  'Literacy',
  'Mathematics',
  'Understanding the World',
  'Expressive Arts & Design',
];
const FLEDGE_BAND_LABELS = {
  1: 'Nestlings', 2: 'First flutters', 3: 'Finding wings',
  4: 'Stretching wings', 5: 'Ready to fledge',
};
router.get('/fledge-bands', async (req, res) => {
  const db = getPool();
  // fledge-off (2026-10-26): Fledge is switched off (src/lib/fledge-switch.js).
  // `available:false` is what every caller already treats as "draw nothing".
  if (!(await FS.isFledgeEnabled(db))) return res.json({ available: false, disabled: true, areas: [], bands: [] });
  // Guard: table may not exist on instances that haven't run the migration yet.
  try {
    const t = await db.query(`SELECT to_regclass('band_judgements') AS t`);
    if (!t.rows[0] || !t.rows[0].t) return res.json({ available: false, areas: FLEDGE_AREA_ORDER, bands: [] });
  } catch { return res.json({ available: false, areas: FLEDGE_AREA_ORDER, bands: [] }); }

  // Latest judgement per (child, area).
  const latest = `
    SELECT DISTINCT ON (child_id, area) child_id, area, band, source, judged_on, notes
    FROM band_judgements
    ORDER BY child_id, area, judged_on DESC, id DESC`;

  try {
    const childId = parseInt(req.query.child_id, 10);
    if (childId) {
      const { rows } = await db.query(
        `SELECT area, band, source, judged_on FROM (${latest}) l WHERE child_id = $1`, [childId]);
      const byArea = Object.fromEntries(rows.map(r => [r.area, r]));
      const areas = FLEDGE_AREA_ORDER.map(a => {
        const r = byArea[a];
        return r ? {
          area: a, band: r.band, band_label: FLEDGE_BAND_LABELS[r.band] || null,
          source: r.source, judged_on: r.judged_on,
        } : { area: a, band: null, band_label: null, source: null, judged_on: null };
      });
      return res.json({ available: true, child_id: childId, areas });
    }

    // Cohort distribution across attending children (counts only).
    const { rows } = await db.query(`
      SELECT l.area, l.band, COUNT(*)::int AS n
      FROM (${latest}) l
      JOIN children c ON c.id = l.child_id
      WHERE c.status = 'active' AND COALESCE(c.is_active, true) = true
        AND (c.leave_date IS NULL OR c.leave_date >= CURRENT_DATE)
      GROUP BY l.area, l.band`);
    const map = {};
    rows.forEach(r => { (map[r.area] = map[r.area] || {})[r.band] = r.n; });
    const areas = FLEDGE_AREA_ORDER.map(a => {
      const d = map[a] || {};
      const dist = [1, 2, 3, 4, 5].map(b => d[b] || 0);
      return { area: a, dist, n: dist.reduce((x, y) => x + y, 0) };
    });
    const children = areas.reduce((mx, a) => Math.max(mx, a.n), 0);
    res.json({ available: true, scope: 'group', children, band_labels: FLEDGE_BAND_LABELS, areas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /framework-grid — the big grid. ?framework=&scope=group|room|mine&room_id=
router.get('/framework-grid', async (req, res) => {
  const framework = req.query.framework || 'birth_to_5_la';
  const scope     = req.query.scope || 'group';
  const db = getPool();
  try {
    // 1. Resolve the in-scope children.
    const cParams = [];
    const cConds  = ['c.is_active = true'];
    if (scope === 'room' && req.query.room_id) {
      cParams.push(req.query.room_id); cConds.push(`c.room_id = $${cParams.length}`);
    } else if (scope === 'mine' && req.user && req.user.id) {
      cParams.push(req.user.id); cConds.push(`c.key_person_id = $${cParams.length}`);
    }
    const { rows: children } = await db.query(`
      SELECT c.id, c.first_name, c.last_name,
             c.first_name || ' ' || c.last_name AS name,
             c.date_of_birth,
             c.room_id, r.name AS room_name, c.key_person_id
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      WHERE ${cConds.join(' AND ')}
      ORDER BY c.first_name, c.last_name
    `, cParams);
    const childIds = children.map(c => c.id);

    // 2. Statement rows for the framework (grouped Area → Aspect → Age band).
    const { rows: statements } = await db.query(`
      SELECT id, area, aspect, sub_area, age_range, statement_code, statement_text, ordinal
      FROM framework_statements
      WHERE framework = $1 AND is_active AND statement_text NOT LIKE '(stub%'
      ORDER BY area, ordinal, id
    `, [framework]);

    // 3. The cells: each child's tracker entry per statement.
    let cells = [];
    let nextSteps = [];
    if (childIds.length) {
      const cellRes = await db.query(`
        SELECT ft.id AS tracker_id, ft.child_id, ft.statement_id,
               ft.status, ft.linked_observation_id
        FROM framework_tracker ft
        WHERE ft.framework = $1
          AND ft.child_id = ANY($2::int[])
          AND ft.statement_id IS NOT NULL
      `, [framework, childIds]);
      cells = cellRes.rows;

      // 4. Each child's recent next steps (from their observations).
      // observations.next_steps may not exist in every schema (e.g. the school
      // editions' observations table) — degrade gracefully rather than 500 the grid.
      try {
        const nsRes = await db.query(`
          SELECT child_id, id AS observation_id, next_steps AS text, created_at
          FROM (
            SELECT o.child_id, o.id, o.next_steps, o.created_at,
                   ROW_NUMBER() OVER (PARTITION BY o.child_id ORDER BY o.created_at DESC) AS rn
            FROM observations o
            WHERE o.child_id = ANY($1::int[])
              AND o.next_steps IS NOT NULL AND length(trim(o.next_steps)) > 0
          ) t
          WHERE rn <= 3
          ORDER BY child_id, created_at DESC
        `, [childIds]);
        nextSteps = nsRes.rows;
      } catch (nsErr) { nextSteps = []; }
    }

    res.json({
      framework,
      label: TRACKER_FW_LABELS[framework] || framework,
      scope,
      children, statements, cells, nextSteps,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Observation photo upload ──────────────────────────────────────────────────
const multer = require('multer');
const OBS_UPLOAD_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'observations')
  : path.join(__dirname, '../../data/ladn/uploads/observations');

// b326 — where a photo may be READ from. Writes still go to OBS_UPLOAD_DIR alone; this is
// only about finding a file that is already there. Two upload trees exist side by side on
// every LADN instance: OBS_UPLOAD_DIR (container /app/data/ladn/uploads/observations, the
// multer target, root-owned on the host) and /app/uploads/observations (host-writable, and
// what src/lib/keepsake.js has always read). The July EyLog media import landed in the
// second and had to be copied across by hand; anything written there from the host now
// serves without that copy. First match wins, so nothing about existing files changes.
const OBS_READ_DIRS = [
  OBS_UPLOAD_DIR,
  process.env.DATA_DIR ? path.join(process.env.DATA_DIR, '..', 'observations') : null,
  '/app/uploads/observations',
  path.join(__dirname, '../../data/ladn/uploads/observations'),
].filter(Boolean).filter((d, i, a) => a.indexOf(d) === i);

// Resolve a bare filename to the first upload tree that holds it. Falls back to the write
// dir so the callers' `fs.existsSync(full)` 404 checks behave exactly as before.
function resolveObsFile(name) {
  for (const d of OBS_READ_DIRS) {
    const p = path.join(d, name);
    if (p.startsWith(d)) { try { if (fs.existsSync(p)) return p; } catch (_) { /* next */ } }
  }
  return path.join(OBS_UPLOAD_DIR, name);
}

const _obsStorage = multer.diskStorage({
  destination(req, file, cb) {
    fs.mkdirSync(OBS_UPLOAD_DIR, { recursive: true });
    cb(null, OBS_UPLOAD_DIR);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `obs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
  },
});
const _obsUpload = multer({
  storage: _obsStorage,
  // 100MB request ceiling to allow short videos; per-type caps enforced below
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) ||
             /^video\/(mp4|webm|quicktime|3gpp|x-matroska)$/.test(file.mimetype));
  },
});

// POST /upload — observation media upload (up to 10 files; images ≤8MB, videos ≤100MB)
router.post('/upload', _obsUpload.array('photos', 10), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded' });
  const tooBig = req.files.find(f => f.mimetype.startsWith('image/') && f.size > 8 * 1024 * 1024);
  if (tooBig) {
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
    return res.status(400).json({ error: 'Images must be under 8MB' });
  }
  const urls = req.files.map(f => `/api/observations/photo/${f.filename}`);
  res.json({ urls });
});

// GET /photo/:filename — serve uploaded observation photos
// Not behind router.use(authenticate) (see the exemption above) — a plain <img src>
// can't carry an Authorization header. Two sources of identity: the normal header
// (an API client with a real session — unchanged, still the full 12h JWT) or a
// ?token= query param — b491 (2026-10-12): that USED to accept the same long-lived
// session JWT (release CHECK.md finding F1 — a bearer-only gate upstream could be
// walked past by sending it as a query param instead of a header). It now only
// accepts a short-lived (≤10min) token signed with MEDIA_URL_KEY instead of
// JWT_SECRET (src/lib/media-url.js signSessionToken/verifySessionToken) — same
// claim shape, so every decoded.role/decoded.child_id(s) read below is unchanged,
// but it cannot be replayed as a session anywhere else and expires in minutes.
router.get('/photo/:filename', async (req, res) => {
  const header = req.headers['authorization'] || '';
  const headerTok = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-wren-token'] || '');
  let decoded;
  if (headerTok) {
    try {
      decoded = jwt.verify(headerTok, process.env.JWT_SECRET);
      if (!decoded.aud || decoded.aud !== (req._portal || 'learning')) {
        return res.status(401).json({ error: 'Invalid token audience' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  } else if (req.query.token) {
    decoded = require('../lib/media-url').verifySessionToken(req.query.token, req._portal || 'learning');
    if (!decoded) return res.status(403).json({ error: 'invalid_or_expired_media_url' });
    if ((req._portal || 'learning') === 'learning' && !(await require('../lib/device-token').isAllowed(req))) {
      return res.status(403).json({ error: 'device_required' });
    }
  } else {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const name = path.basename(req.params.filename); // strip path traversal
  // Ownership scoping (security fix 2026-07-21): any valid same-portal token
  // used to be enough to fetch ANY child's photo by filename — this only
  // fixed the "photos never display at all" bug, not access scoping. Mirrors
  // the message-attachment gate (_canAccessThread): a parent token may only
  // view photos belonging to their OWN child's shared observations.
  const full = resolveObsFile(name);
  const publicUrl = `/api/observations/photo/${name}`;
  const wantsDownload = req.query.download === '1' || req.query.download === 'true';

  if (decoded.role === 'parent') {
    const owned = (decoded.child_ids && decoded.child_ids.length) ? decoded.child_ids : [decoded.child_id];
    let verdict;
    try {
      // b265 — one query now answers both questions: does this family own the
      // photo, and has another family in the group withdrawn it. photoVerdict
      // is group_uuid-aware, which the old ownership check was not: on prod,
      // 250 of 1,877 photo-carrying groups hold the media on only some rows.
      verdict = await mediaGate.photoVerdict(getPool(), publicUrl, owned.filter(Number.isInteger));
    } catch (e) {
      console.error('[observations] photo verdict:', e.message);
      return res.status(500).json({ error: 'Internal error' });
    }
    if (!verdict.owned) return res.status(403).json({ error: 'Forbidden' });

    // ── The control that actually works ─────────────────────────────────────
    // Enforced at SHARE time, on the way out, so it holds however the URL was
    // obtained — a screenshot cannot defeat what was never sent.
    if (verdict.blocked) {
      return res.status(403).json({
        error: 'withheld',
        message: mediaGate.WITHHELD_NOTICE,
      });
    }

    // ── Download gate, off by default ───────────────────────────────────────
    if (wantsDownload && !(await mediaGate.isDownloadEnabled(getPool()))) {
      return res.status(403).json({
        error: 'download_disabled',
        message: 'Downloading photos is turned off for this nursery. You can still view them here.',
      });
    }

    // ── Watermark ───────────────────────────────────────────────────────────
    // Every parent-facing copy carries the viewing family's identity, inline as
    // well as on download — a screenshot of the page is the likely leak, not a
    // saved file, so marking only the download would mark the wrong one.
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
    const ext = path.extname(name).toLowerCase();
    const mime = watermark.mimeForExt(ext);
    // 2026-10-28 (Toby: "a parent asked for watermarks to be removed … I don't see the point").
    // settings.parent_media_watermark = 'off' serves the plain photo; anything else keeps the mark.
    const wmOff = await getPool().query(`SELECT value FROM settings WHERE key='parent_media_watermark'`)
      .then(r => String((r.rows[0] && r.rows[0].value) || '').trim().toLowerCase() === 'off').catch(() => false);
    if (!wmOff && watermark.canWatermark(mime)) {
      try {
        const stat = fs.statSync(full);
        // A parent token carries the email in `name`; resolve the family's real
        // name so the mark reads "Sam Okafor", not "sam.okafor". Falls back to
        // the email — a watermark nobody can read is not a watermark.
        const who = await mediaGate.viewerName(getPool(), decoded.email || decoded.name)
          .catch(() => null);
        const identity = watermark.identityLine(who || decoded.name, decoded.email || decoded.name);
        const marked = watermark.watermarkImage(fs.readFileSync(full), mime, identity, {
          cacheKey: `${name}:${stat.size}:${stat.mtimeMs}`,
        });
        if (!marked.applied) console.warn('[observations] watermark skipped for', name, '-', marked.reason);
        res.set('Content-Type', marked.mime);
        res.set('Cache-Control', 'private, max-age=300');
        if (wantsDownload) {
          res.set('Content-Disposition', `attachment; filename="${name}"`);
          res.set('X-Wren-Download-Warning', 'see /api/consents/catalogue download_warning');
        }
        return res.send(marked.buffer);
      } catch (e) {
        // A parent seeing an unmarked photo beats a parent seeing a broken one.
        console.error('[observations] watermark failed for', name, '-', e.message);
      }
    }
    if (wantsDownload) res.set('Content-Disposition', `attachment; filename="${name}"`);
    return res.sendFile(full);
  }

  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  if (wantsDownload) res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.sendFile(full);
});

// GET /photo-policy — what a parent's app is allowed to do with media here.
// The portal asks once and renders the download button (or does not) from the
// answer, so the button and the gate can never disagree.
router.get('/photo-policy', async (req, res) => {
  try {
    const enabled = await mediaGate.isDownloadEnabled(getPool());
    res.json({
      download_enabled: enabled,
      download_warning: mediaGate.DOWNLOAD_WARNING,
      reality_notice: mediaGate.MEDIA_REALITY_NOTICE,
      watermarked: await getPool().query(`SELECT value FROM settings WHERE key='parent_media_watermark'`)
        .then(r => String((r.rows[0] && r.rows[0].value) || '').trim().toLowerCase() !== 'off').catch(() => true),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TWINKL-ARI REPORT WRITER — suggest / draft / persist ──────────────
// These endpoints power the "Draft with Wren" flow:
//   1. POST /:id/suggest-statements  — AI suggests statement checkboxes + CoEL
//   2. POST /:id/draft               — AI generates parent-friendly prose
//   3. POST /:id/statements          — persist human's confirmed links

// Helper: call Ollama with retry logic
// Uses the native /api/chat endpoint with think:false — the OpenAI-compat
// /v1/chat/completions endpoint has no way to suppress qwen3.5's reasoning trace,
// which was silently eating the entire max_tokens budget before any real content
// came out (finish_reason:"length", content:"", ~2000 tokens of hidden <think>).
// That's why suggest-statements always fell back to pg_trgm and /draft always came
// back blank — the actual root cause behind staff-feedback card #15 (fbfix 2026-07-21).
// Response is normalised back to the OpenAI {choices:[{message:{content}}]} shape
// so both call sites below are unchanged.
function callOllama(messages, model, timeoutMs) {
  const url = new URL('/api/chat', OLLAMA_HOST);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || OLLAMA_MODEL(),
      messages,
      think: false,
      stream: false,
      options: ai.options({ temperature: 0.3, num_predict: 2048 }, 'long'),
    }),
    signal: AbortSignal.timeout(timeoutMs || 30000),
  }).then(r => {
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    return r.json();
  }).then(data => ({
    choices: [{ message: { content: (data.message && data.message.content) || '' } }]
  }));
}

// Helper: pg_trgm similarity query for statement candidates
function fetchTrgmCandidates(db, text, frameworks, limit) {
  const params = [];
  let sql = `
    SELECT id, framework, area, aspect, age_range, statement_code, statement_text
    FROM framework_statements
    WHERE framework = ANY($1)
      AND is_active                           -- b332
      AND statement_text NOT LIKE '(stub%'
  `;
  params.push(frameworks);
  // pg_trgm: similarity() needs both args typed as text
  params.push(text);
  sql += ` ORDER BY similarity(statement_text, $${params.length}::text) DESC`;
  if (limit && limit > 0) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }
  return db.query(sql, params);
}

// POST /:id/suggest-statements — AI suggests framework statements for an observation
// id may be 'new' (pre-save: the EY/admin forms suggest before the obs row exists) —
// in that case observation_text is required in the body and no obs row is fetched.
router.post('/:id/suggest-statements', authenticate, async (req, res) => {
  const isNew = req.params.id === 'new';
  const obsId = parseInt(req.params.id);
  if (!isNew && isNaN(obsId)) return res.status(400).json({ error: 'observation_id required' });

  const db = getPool();
  const { observation_text, child_id, frameworks } = req.body;

  // Fetch the observation (or synthesize one for pre-save suggests)
  let obs;
  if (isNew) {
    if (!observation_text || !observation_text.trim()) {
      return res.status(400).json({ error: 'observation_text required for pre-save suggestions' });
    }
    let ageMonths = null;
    if (child_id) {
      try {
        const { rows } = await db.query(
          'SELECT EXTRACT(MONTH FROM AGE(NOW(), date_of_birth))::int + EXTRACT(YEAR FROM AGE(NOW(), date_of_birth))::int*12 AS age_months FROM children WHERE id=$1',
          [child_id]);
        if (rows.length) ageMonths = rows[0].age_months;
      } catch (_) { /* age filter is best-effort */ }
    }
    obs = { observation_text, child_id: child_id || null, child_age_months: ageMonths };
  } else try {
    const { rows } = await db.query(OBS_SELECT + ' WHERE o.id=$1', [obsId]);
    if (!rows.length) return res.status(404).json({ error: 'Observation not found' });
    obs = rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }

  // Use provided text if given, otherwise the observation's own text
  const text = observation_text || obs.observation_text;
  const childIds = [child_id || obs.child_id];
  const fwList = frameworks || ['birth_to_5', 'development_matters', 'eyfs_statutory', 'coel'];

  // Fetch child age for any age-filtered frameworks
  const ageStr = obs.child_age_months !== undefined && obs.child_age_months !== null
    ? `${Math.floor(obs.child_age_months / 12)}y ${obs.child_age_months % 12}m`
    : '0-5 years';

  try {
    // Step 1: pg_trgm similarity to narrow pool (per-framework)
    const pools = {}; // framework -> candidates
    for (const fw of fwList) {
      const candidates = await fetchTrgmCandidates(db, text, [fw], 40);
      if (candidates.rows.length) pools[fw] = candidates.rows;
    }

    // Step 2: Ask Ollama to score and pick + flag CoEL
    let suggestions = [];
    let coelSuggestions = [];
    let method = 'ai';

    const staffId = req.user.id;
    if (isAiDegraded(staffId)) {
      // Degraded fallback: keyword match
      method = 'keyword_fallback';
      for (const [fw, cands] of Object.entries(pools)) {
        const obsWords = tokenise(text);
        const scored = cands
          .map(c => ({ ...c, _score: overlap(obsWords, tokenise(c.statement_text + ' ' + (c.area || '') + ' ' + (c.aspect || ''))) }))
          .sort((a, b) => b._score - a._score)
          .slice(0, 2);
        for (const s of scored) {
          suggestions.push({ ...s, _why: 'keyword_match' });
          if (fw === 'coel') coelSuggestions.push({ ...s });
        }
      }
    } else {
      try {
        // Build structured prompt for Ollama
        const poolList = [];
        for (const [fw, cands] of Object.entries(pools)) {
          for (const c of cands) {
            poolList.push(`[${fw}] ${c.area || ''} | ${c.aspect || ''} | ${c.age_range || ''} | ${c.statement_code} | ${c.statement_text}`);
          }
        }

        const prompt = `You are a nursery practitioner selecting relevant EYFS framework statements for an observation.

OBSERVATION TEXT: "${text.substring(0, 1000)}"
CHILD AGE: ${ageStr}

AVAILABLE STATEMENTS (pick the best fits):
${poolList.join('\n')}

Instructions:
1. Select 2-5 statements that best match this observation
2. For each selected statement, give a ONE-LINE reason why it fits
3. Identify any that are CoEL (Characteristics of Effective Learning) — mark coel_aspect as true
4. Return ONLY a valid JSON object matching this exact schema (no markdown, no extra text):
{
  "suggestions": [
    {"id": <integer>, "framework": "<framework>", "statement_code": "<code>", "area": "<area>", "aspect": "<aspect>", "age_range": "<age>", "statement_text": "<text>", "_why": "<1-line reason>"}
  ],
  "coel_matches": [
    {"id": <integer>, "framework": "<framework>", "statement_code": "<code>", "aspect": "<aspect>", "coel_level": "emerging|developing|secure"}
  ]
}`;

        const result = await callOllama(
          [{ role: 'system', content: 'You are an expert EYFS practitioner. Only select statements that genuinely match the observation. Never invent statements.' }, { role: 'user', content: prompt }],
          AI_SUGGESTER_MODEL(),
          30000
        );

        const content = result?.choices?.[0]?.message?.content || '';

        // Parse JSON from LLM response (may have markdown wrapper)
        let parsed;
        try {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        } catch { parsed = null; }

        if (parsed && parsed.suggestions?.length) {
          suggestions = parsed.suggestions;
          coelSuggestions = parsed.coel_matches || [];
        } else {
          method = 'keyword_fallback';
          for (const [fw, cands] of Object.entries(pools)) {
            const obsWords = tokenise(text);
            const scored = cands
              .map(c => ({ ...c, _score: overlap(obsWords, tokenise(c.statement_text + ' ' + (c.area || '') + ' ' + (c.aspect || ''))) }))
              .sort((a, b) => b._score - a._score)
              .slice(0, 2);
            for (const s of scored) {
              suggestions.push({ ...s, _why: 'keyword_match' });
            }
          }
        }
        recordAiSuccess(staffId);
      } catch (aiErr) {
        appendLog(`suggest-statements AI failed: ${aiErr.message} — falling back to pg_trgm ranking`);
        recordAiFailure(staffId);
        method = 'pg_trgm_rank';
        for (const [fw, cands] of Object.entries(pools)) {
          const scored = cands
            .map(c => ({
              ...c,
              _score: similarity(c.statement_text, text)
            }))
            .sort((a, b) => b._score - a._score)
            .slice(0, 3);
          for (const s of scored) {
            suggestions.push({ ...s, _why: 'similarity_rank' });
            if (fw === 'coel') coelSuggestions.push({ ...s, coel_level: 'developing' });
          }
        }
      }
    }

    res.json({
      observation_id: obsId,
      child_name: obs.child_name,
      child_age_months: obs.child_age_months,
      method,
      suggestions,
      coel_matches: coelSuggestions,
      total_candidates: Object.values(pools).reduce((a, b) => a + b.length, 0)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Helper: similarity between two strings (Levenshtein-like, simpler)
function similarity(a, b) {
  const wordsA = new Set(tokenise(a));
  const wordsB = new Set(tokenise(b));
  if (!wordsA.size || !wordsB.size) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / Math.max(wordsA.size, wordsB.size);
}

// POST /:id/draft — AI generates parent-friendly prose from confirmed selections
// id may be 'new' — same pre-save sentinel as /:id/suggest-statements (staff-feedback
// card #15: the EY form always calls this with 'new' while composing a brand-new,
// not-yet-saved observation, so it must not require an existing obs row).
router.post('/:id/draft', authenticate, async (req, res) => {
  const isNew = req.params.id === 'new';
  const obsId = parseInt(req.params.id);
  if (!isNew && isNaN(obsId)) return res.status(400).json({ error: 'observation_id required' });

  const { observation_text, child_name, child_pronouns, statement_codes, coel_selections } = req.body;
  const db = getPool();

  // Fetch the observation (or synthesize one for pre-save drafts)
  let obs;
  if (isNew) {
    if (!observation_text || !observation_text.trim()) {
      return res.status(400).json({ error: 'observation_text required for pre-save drafts' });
    }
    obs = { observation_text, child_name: child_name || 'this child' };
  } else try {
    const { rows } = await db.query(OBS_SELECT + ' WHERE o.id=$1', [obsId]);
    if (!rows.length) return res.status(404).json({ error: 'Observation not found' });
    obs = rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }

  const txt = observation_text || obs.observation_text;
  const name = child_name || obs.child_name;
  const pronouns = child_pronouns || 'they';

  // Fetch the confirmed statement details from the database
  let stmtDetails = [];
  if (statement_codes?.length) {
    const placeholders = statement_codes.map((_, i) => `$${i + 2}`).join(',');
    const params = [obsId, ...statement_codes];
    try {
      const { rows: stmts } = await db.query(
        `SELECT fs.id, fs.framework, fs.area, fs.aspect, fs.age_range, fs.statement_code, fs.statement_text
         FROM framework_statements fs LEFT JOIN observation_statements os ON os.statement_id = fs.id
         WHERE fs.statement_code = ANY($${1}) AND fs.id IN (${placeholders})`,
        [statement_codes, ...statement_codes]
      );
      stmtDetails = stmts;
    } catch {
      // Non-fatal: fall back to empty
    }
  }

  try {
    const { child_age_months } = obs;
    const ageStr = child_age_months !== undefined
      ? `${Math.floor(child_age_months / 12)} years ${child_age_months % 12} months`
      : 'age not known';

    // Build prompt with confirmed statements
    const stmtList = (stmtDetails.length ? stmtDetails.map(s =>
      `▸ ${s.framework}/${s.statement_code}: "${s.statement_text}"`
    ).join('\n') : (statement_codes?.map(c => `▸ ${c}`).join('\n') || 'None'));

    const coelList = (coel_selections?.length ? coel_selections.map(c =>
      `▸ ${c.characteristic} (${c.level}): ${c.coel_text || '(tick)'}`
    ).join('\n') : 'None');

    const prompt = `You are a warm, professional nursery practitioner writing observations for parents.

CHILD: ${name}, age ${ageStr}, pronouns: ${pronouns}

OBSERVATION TEXT (what happened):
"${txt.substring(0, 1200)}"

CONFIRMED STATEMENTS (these were ticked by the practitioner — include verbatim where appropriate):
${stmtList}

CONFIRMED CoEL (Characteristics of Effective Learning):
${coelList}

Write THREE outputs in this EXACT format:
---OBSERVATION---
[Keep the original observation text lightly edited for clarity]

---PARENT_TEXT---
[A warm, parent-friendly version using the confirmed statements woven into the prose naturally. Never invent new attainment claims. Use ${pronouns} for ${name}. Be specific, positive, and parent-accessible. 200-300 words.]

---NEXT_STEPS---
[3 specific, actionable next steps that build on what was observed. Each should connect to a framework area. Start each with an action verb.]

CRITICAL RULES:
- Use the VERBATIM confirmed statements in the parent text
- Do NOT invent new framework attainment claims
- Keep CoEL references natural, never clinical
- The next steps should be practical things staff can do next day
---OBSERVATION--- should be a polished version of the original`;

    const result = await callOllama(
      [
        { role: 'system', content: 'You are helping a nursery practitioner write a warm, parent-friendly observation report. Follow the EXACT output format with ---SEPARATOR--- lines.' },
        { role: 'user', content: prompt }
      ],
      OLLAMA_MODEL(),
      45000
    );

    const content = result?.choices?.[0]?.message?.content || '';

    // Parse the three sections
    const parts = content.split('---OBSERVATION---');
    let obsEdit = '';
    let parentText = '';
    let nextSteps = '';

    if (parts.length >= 2) {
      // The first part of the second separator split is the observation text
      if (parts[1].includes('---PARENT_TEXT---')) {
        const p1p2 = parts[1].split('---PARENT_TEXT---');
        obsEdit = p1p2[0].trim();
        if (p1p2[1].includes('---NEXT_STEPS---')) {
          const p3 = p1p2[1].split('---NEXT_STEPS---');
          parentText = p3[0].trim();
          nextSteps = p3[1].trim();
        }
      }
    }

    // If parsing failed, return raw content
    if (!parentText && content.includes('Dear') && content.length > 100) {
      parentText = content;
    }

    // Format next steps as array
    let stepsList = [];
    if (nextSteps) {
      stepsList = nextSteps.split('\n').filter(l => l.trim().length > 0 && (l.startsWith('-') || l.startsWith('*') || l.startsWith('▸') || /\d+\./.test(l))).map(l => l.replace(/^[-*▸\d.]+\s*/, '').trim());
      if (!stepsList.length) stepsList = [nextSteps];
    }

    res.json({
      observation_id: isNew ? null : obsId,
      polished_observation: obsEdit || content.slice(0, 500),
      parent_friendly_text: parentText || content,
      next_steps: stepsList,
      model: OLLAMA_MODEL()
    });
  } catch (e) {
    appendLog(`draft endpoint failed: ${e.message}`);
    res.status(500).json({ error: 'AI draft failed: ' + e.message });
  }
});

// POST /:id/statements — persist confirmed statement links + next steps
router.post('/:id/statements', authenticate, _requireObsEditPermission, async (req, res) => {
  const obsId = parseInt(req.params.id);
  if (isNaN(obsId)) return res.status(400).json({ error: 'observation_id required' });

  const { statements, coel_selections, next_steps_text } = req.body;
  const db = getPool();

  // Validate input
  if (!statements && !coel_selections && !next_steps_text) {
    return res.status(400).json({ error: 'Provide statements, coel_selections, or next_steps_text' });
  }

  try {
    const results = { persisted_statements: 0, persisted_coel: 0, updated_next_steps: false };

    // Persist statement links
    // fledge-off (2026-10-26): Fledge statements are not linked while the switch is off.
    const _okIds = new Set((await FS.dropFledgeStatementIds(db,
      (statements || []).map(s => s && s.statement_id).filter(Boolean))).map(Number));
    if (statements?.length) {
      for (const stmt of statements) {
        if (stmt && stmt.statement_id && !_okIds.has(Number(stmt.statement_id))) continue;
        const { statement_id, framework, statement_code } = stmt;
        if (!statement_id) continue;

        // Check if already linked to avoid duplicate
        const existing = await db.query(
          'SELECT id FROM observation_statements WHERE observation_id=$1 AND statement_id=$2 LIMIT 1',
          [obsId, statement_id]
        );

        if (existing.rows.length) {
          // Update existing entry
          await db.query(
            'UPDATE observation_statements SET confirmed_by=$1, is_next_step=COALESCE($2, is_next_step), updated_at=NOW() WHERE id=$3',
            [req.user.id, stmt.is_next_step || false, existing.rows[0].id]
          );
        } else {
          // Insert new link
          await db.query(`
            INSERT INTO observation_statements (observation_id, statement_id, framework, statement_code, coel_characteristic, coel_level, is_next_step, source, confirmed_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, [obsId, statement_id, framework, statement_code, null, null, stmt.is_next_step || false, 'manual', req.user.id]);
        }
        results.persisted_statements++;
      }

      // Clear AI-suggested rows that weren't picked (optional, for cleanliness)
      await db.query(
        `DELETE FROM observation_statements WHERE observation_id=$1 AND source='ai_suggested' AND confirmed_by IS NULL`,
        [obsId]
      );
    }

    // Persist CoEL selections
    if (coel_selections?.length) {
      for (const sel of coel_selections) {
        // Find the CoEL framework statement matching this characteristic + level
        const coelFwResult = await db.query(
          `SELECT id, statement_code FROM framework_statements
           WHERE framework='coel' AND coel_characteristic IS NOT NULL
             AND LOWER($1) = 'developing'`,
          [sel.coel_level]
        );
        // Simpler approach: just record as a special CoEL link
        // (CoEL rows have aspect=0, so we match by characteristic text)
        if (sel.statement_id) {
          const cex = await db.query(
            'SELECT id FROM observation_statements WHERE observation_id=$1 AND statement_id=$2 LIMIT 1',
            [obsId, sel.statement_id]
          );
          const row = {};
          if (cex.rows.length) {
            row.id = cex.rows[0].id;
            row.confirmed_by = req.user.id;
            row.coel_characteristic = sel.characteristic || row.coel_characteristic;
            row.coel_level = sel.level || row.coel_level;
            await db.query(
              'UPDATE observation_statements SET confirmed_by=$1, coel_characteristic=$2, coel_level=$3, updated_at=NOW() WHERE id=$4',
              [req.user.id, sel.characteristic, sel.level, row.id]
            );
          } else {
            await db.query(
              `INSERT INTO observation_statements (observation_id, statement_id, framework, statement_code, coel_characteristic, coel_level, is_next_step, source, confirmed_by, created_at)
               VALUES ($1, $2, 'coel', $3, $4, $5, $6, 'manual', $7, NOW() AT TIME ZONE 'UTC')`,
              [obsId, sel.statement_id, sel.statement_code, sel.characteristic, sel.level, false, req.user.id]
            );
          }
        }
        results.persisted_coel++;
      }
    }

    // Update next_steps text directly on the observation
    if (next_steps_text && next_steps_text.trim().length > 0) {
      await db.query('UPDATE observations SET next_steps=$1, updated_at=NOW() WHERE id=$2', [next_steps_text.trim(), obsId]);
      results.updated_next_steps = true;
    }

    // Fetch updated linked statements for return
    const { rows } = await db.query(
      `SELECT os.*, fs.framework, fs.area, fs.aspect, fs.age_range, fs.statement_code, fs.statement_text
       FROM observation_statements os
       JOIN framework_statements fs ON fs.id = os.statement_id
       WHERE os.observation_id=$1
       ORDER BY os.is_next_step DESC, os.created_at`,
      [obsId]
    );

    res.json({
      ...results,
      linked_statements: rows,
      message: 'Statement links saved'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TERMLY UPDATE COMPLETION TRACKING (Prompt 28B) ────────────────────────────
// Per-child status for the "Termly Update & Tracking" document. Status: done
// this cycle / due / overdue.
//
// b246 (2026-08-28): the cycle now follows EALING'S HALF-TERMS (ladn.school_terms,
// via src/lib/termly-cycle.js) rather than a rolling window from each child's own
// last update, and a SENT termly-update document counts alongside the
// observations.termly_update flag. The rolling behaviour is still there behind
// settings.termly_update_anchor='rolling' and is what runs if no term calendar
// covers the date. See the header of src/services/termly-status.js.
const { fetchTermlyStatuses } = require('../services/termly-status');

// GET /termly-status?staff_id=&filter=all|outstanding|done|due|overdue
//   Managers (manager/deputy/room_leader/senior_practitioner) see ALL key children;
//   pass staff_id to focus on one key person. Everyone else sees only their own.
router.get('/termly-status', async (req, res) => {
  const db = getPool();
  try {
    const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner']);
    let staffId = null;
    if (isManager) {
      if (req.query.staff_id) staffId = parseInt(req.query.staff_id, 10) || null;
    } else {
      staffId = req.user.id; // non-managers locked to their own key children
    }

    const on = /^\d{4}-\d{2}-\d{2}$/.test(req.query.on || '') ? req.query.on : undefined;
    const t = await fetchTermlyStatuses(db, { staffId, on });
    const { cycleWeeks, graceWeeks, children } = t;

    const summary = { done: 0, due: 0, overdue: 0, total: 0 };
    for (const c of children) { summary[c.status] = (summary[c.status] || 0) + 1; summary.total++; }
    summary.outstanding = summary.due + summary.overdue;

    // b246 — the three-word status above cannot say the difference between "had
    // one this half-term" and "the half-term has only just opened, it is not due
    // yet". Both are 'done' to every caller that predates b246, which is right:
    // neither needs chasing. But reporting them as one number would overstate how
    // many updates have actually been written, so the honest five-state breakdown
    // is reported ALONGSIDE it rather than replacing it.
    const states = { done: 0, due: 0, overdue: 0, upcoming: 0, not_applicable: 0 };
    for (const c of children) states[c.state || c.status] = (states[c.state || c.status] || 0) + 1;

    let list = children;
    const filter = (req.query.filter || 'all').toLowerCase();
    if (filter === 'outstanding')   list = list.filter(c => c.status !== 'done');
    else if (filter === 'done')     list = list.filter(c => c.status === 'done');
    else if (filter === 'due')      list = list.filter(c => c.status === 'due');
    else if (filter === 'overdue')  list = list.filter(c => c.status === 'overdue');

    res.json({
      cycle_weeks: cycleWeeks,
      grace_weeks: graceWeeks,
      scope: staffId ? 'mine' : 'all',
      staff_id: staffId,
      filter,
      summary,
      // b246 — which half-term these verdicts are against, and by what rule.
      anchor: t.anchor,
      cycle: t.cycle ? { key: t.cycle.key, label: t.cycle.label,
                         due_on: t.cycle.due_on, overdue_on: t.cycle.overdue_on,
                         term_start: t.cycle.term_start, term_end: t.cycle.term_end } : null,
      calendar: t.calendar || null,
      states,
      children: list,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ╔══════════════════════════════════════════╗
// ║ OLD endpoint kept for backwards compat  ║
// ║ POST /ai-suggest-statements (global)   ║
// ║ Now delegates to the new endpoint above ║
// ╚══════════════════════════════════════════╝
// (ai-suggest-statements already exists earlier in this file — do not duplicate)

// ── LINKED STATEMENTS + PARENT ENGAGEMENT (2026-07-27) ────────────────────────
// GET /:id/statements — the framework statements linked to one observation.
// Previously only returned as a side-effect of POST /:id/statements, so the
// 8,530 EyLog-imported links were invisible in every UI.
router.get('/:id/statements', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT os.id AS link_id, os.is_next_step, os.source,
              fs.id AS statement_id, fs.framework, fs.area, fs.aspect, fs.age_range,
              fs.statement_code, fs.statement_text, fs.profile_refs
       FROM observation_statements os
       JOIN framework_statements fs ON fs.id = os.statement_id
       WHERE os.observation_id=$1
       ORDER BY fs.framework, fs.ordinal, fs.id`,
      [req.params.id]
    );
    // E3b: every observation saved before this build wrote framework_tracker and NOT
    // observation_statements, so this returned nothing for all of them. Fall back to the
    // tracker's own link for those, so an observation from last week shows its tags
    // without the backfill having to have reached it. source tells the two apart.
    if (!rows.length) {
      const { rows: legacy } = await db.query(
        `SELECT ft.id AS link_id, false AS is_next_step, 'framework_tracker' AS source,
                fs.id AS statement_id, fs.framework, fs.area, fs.aspect, fs.age_range,
                fs.statement_code, fs.statement_text, fs.profile_refs
           FROM framework_tracker ft
           JOIN framework_statements fs ON fs.id = ft.statement_id
          WHERE ft.linked_observation_id=$1 AND ft.statement_id IS NOT NULL
          ORDER BY fs.framework, fs.ordinal, fs.id`,
        [req.params.id]
      );
      return res.json({ statements: legacy });
    }
    res.json({ statements: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/engagement — parent likes + comments for the staff detail view.
router.get('/:id/engagement', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const db = getPool();
  try {
    const [likes, comments] = await Promise.all([
      db.query('SELECT count(*)::int AS n FROM observation_likes WHERE observation_id=$1', [req.params.id]),
      db.query(
        `SELECT id, author_type, author_name, body, created_at
         FROM observation_comments WHERE observation_id=$1 ORDER BY created_at`,
        [req.params.id]
      ),
    ]);
    res.json({ likes: likes.rows[0].n, comments: comments.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/comments — staff reply on an observation thread.
router.post('/:id/comments', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const body = (req.body && req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body required' });
  if (body.length > 2000) return res.status(400).json({ error: 'comment too long' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `INSERT INTO observation_comments (observation_id, author_type, author_staff_id, author_name, body)
       SELECT $1, 'staff', $2, s.first_name || ' ' || s.last_name, $3 FROM staff s WHERE s.id=$2
       RETURNING id, author_type, author_name, body, created_at`,
      [req.params.id, req.user.id, body]
    );
    if (!rows.length) return res.status(400).json({ error: 'unknown staff author' });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── b177 Review queue endpoints ──────────────────────────────────────────────
// GET /review-queue — pending observations for this reviewer. Managers/deputy/admin
// see everything; a room_leader sees only their own room's children (req.user.room_id,
// set at login — src/routes/auth.js). Practitioners/apprentices: 403.
router.get('/review-queue', async (req, res) => {
  if (!_isReviewerRole(req.user.role)) return res.status(403).json({ error: 'Reviewer role required' });
  const db = getPool();
  try {
    const params = [];
    let roomClause = '';
    if (req.user.role === 'room_leader') {
      if (req.user.room_id == null) return res.json([]); // no room assigned — nothing to review
      params.push(req.user.room_id);
      roomClause = ` AND c.room_id = $${params.length}`;
    }
    const { rows } = await db.query(`
      SELECT o.id, o.child_id, o.title, o.observation_text, o.observation_type,
             o.eyfs_areas, o.photo_urls, o.next_steps, o.requested_shared_with_parents,
             o.submitted_for_review_at, o.created_at,
             c.first_name || ' ' || c.last_name AS child_name, c.room_id,
             r.name AS room_name,
             s.first_name || ' ' || s.last_name AS author_name, o.staff_id AS author_id
      FROM observations o
      JOIN children c ON c.id = o.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = o.staff_id
      WHERE o.review_status = 'pending_review' ${roomClause}
      ORDER BY o.submitted_for_review_at ASC NULLS LAST, o.created_at ASC
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /review-queue/count — lightweight badge count (same room scoping as above).
router.get('/review-queue/count', async (req, res) => {
  if (!_isReviewerRole(req.user.role)) return res.json({ count: 0 });
  const db = getPool();
  try {
    const params = [];
    let roomClause = '';
    if (req.user.role === 'room_leader') {
      if (req.user.room_id == null) return res.json({ count: 0 });
      params.push(req.user.room_id);
      roomClause = ` AND c.room_id = $${params.length}`;
    }
    const { rows } = await db.query(`
      SELECT COUNT(*)::int AS count FROM observations o
      JOIN children c ON c.id = o.child_id
      WHERE o.review_status = 'pending_review' ${roomClause}
    `, params);
    res.json({ count: rows[0].count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/review/approve — publish (applies the author's originally-requested
// shared_with_parents), fires the correctly-scoped publish notification, audits.
// b237: approving a pending observation publishes it — publish-to-parents at approve
// level. The reviewer-role + own-room checks below are unchanged; stricter wins.
router.post('/:id/review/approve', requireCapabilityLevel('observations.publish-to-parents', 'approve'), async (req, res) => {
  if (!_isReviewerRole(req.user.role)) return res.status(403).json({ error: 'Reviewer role required' });
  const db = getPool();
  try {
    const { rows: cur } = await db.query(
      `SELECT o.id, o.child_id, o.review_status, o.requested_shared_with_parents, c.room_id
       FROM observations o JOIN children c ON c.id = o.child_id WHERE o.id=$1`, [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    if (cur[0].review_status !== 'pending_review') return res.status(409).json({ error: 'Not pending review' });
    if (!_canReviewRoom(req.user, cur[0].room_id)) return res.status(403).json({ error: 'Not your room' });

    const { rows } = await db.query(`
      UPDATE observations SET
        review_status='published',
        shared_with_parents = COALESCE(requested_shared_with_parents, shared_with_parents),
        requested_shared_with_parents = NULL,
        reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND review_status='pending_review'
      RETURNING *
    `, [req.params.id, req.user.id]);
    if (!rows.length) return res.status(409).json({ error: 'Not pending review' });
    const obs = rows[0];

    if (obs.shared_with_parents) {
      const { rows: cRows } = await db.query(
        'SELECT key_person_id, first_name, last_name FROM children WHERE id=$1', [obs.child_id]);
      const child = cRows[0];
      await _notifyPublished(db, {
        childId: obs.child_id, keyPersonId: child && child.key_person_id,
        actingUserId: req.user.id, obsId: obs.id,
        childName: child ? `${child.first_name} ${child.last_name}` : null,
      }).catch(() => {});
    }

    recordAudit({ req, action: 'update', entity_type: 'observation', entity_id: obs.id,
      meta: { review_action: 'approve', child_id: obs.child_id, author_id: obs.staff_id } });
    res.json(obs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/review/return {note} — send back to the author with a note, no parent
// visibility change (it was never shared_with_parents in the first place).
router.post('/:id/review/return', async (req, res) => {
  if (!_isReviewerRole(req.user.role)) return res.status(403).json({ error: 'Reviewer role required' });
  const note = (req.body && req.body.note || '').trim();
  if (!note) return res.status(400).json({ error: 'note required' });
  const db = getPool();
  try {
    const { rows: cur } = await db.query(
      `SELECT o.id, o.staff_id, o.review_status, c.room_id
       FROM observations o JOIN children c ON c.id = o.child_id WHERE o.id=$1`, [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    if (cur[0].review_status !== 'pending_review') return res.status(409).json({ error: 'Not pending review' });
    if (!_canReviewRoom(req.user, cur[0].room_id)) return res.status(403).json({ error: 'Not your room' });

    const { rows } = await db.query(`
      UPDATE observations SET
        review_status='returned', reviewed_by=$2, reviewed_at=NOW(), review_note=$3, updated_at=NOW()
      WHERE id=$1 AND review_status='pending_review'
      RETURNING *
    `, [req.params.id, req.user.id, note]);
    if (!rows.length) return res.status(409).json({ error: 'Not pending review' });
    const obs = rows[0];

    if (obs.staff_id) {
      // notify() is fire-and-forget (returns undefined) — no .then/.catch chaining.
      notify('observation_returned', 'staff', obs.staff_id,
        'An observation was returned for changes',
        note, { relatedTable: 'observations', relatedId: obs.id, link: `/ey/observation/${obs.id}` }
      );
    }

    recordAudit({ req, action: 'update', entity_type: 'observation', entity_id: obs.id,
      meta: { review_action: 'return', child_id: obs.child_id, author_id: obs.staff_id } });
    res.json(obs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b255 (2026-09-01) — the EyLog-shaped tracker grid, for Roost and for EY
// ═══════════════════════════════════════════════════════════════════════════
// Toby: "For the trackers, keep them the same as eylog." So: children down the
// left, and one very wide scrolling grid of area → aspect → age band across the
// top, each cell a colour block with no text in it.
//
// These endpoints exist alongside GET /framework-grid (Prompt 27), which is
// unchanged and still serves the EY grid. The difference is where the work
// happens: /framework-grid ships 554 statements and 4,510 raw tracker rows and
// lets the browser group them. This ships the GROUPING — one row per
// (child × band) — because the grid draws bands, not statements, and Birth to 5
// has 96 bands where it has 554 statements. The statement-level detail is
// fetched for ONE cell at a time by /tracker-cell when the cell is opened.
//
// Nothing here is hard-coded to six ranges. The column tree is read out of the
// framework's own rows, which is the only way one screen can serve Birth to 5
// Matters (7 areas / 16 aspects / 6 ranges + 1 merged band) AND Fledge (8 areas,
// 11 "aspects" that are really bands, 5 bands, and a Fledge Profile area with no
// age bands at all).

// Statement status → cell colour. Identical to the EY grid's map so the two
// screens cannot disagree about what a colour means. Anything unrecognised is
// treated as evidence-but-not-secure (amber) rather than silently dropped.
const B255_GREEN = new Set(['secure', 'met', 'achieved', 'exceeding']);
const B255_GREY  = new Set(['not_yet', 'not_observed', 'na']);

// Which numbered range positions a band label occupies. "Range 3 (18-24 months)"
// is position 3..3; "Range 1-2 (0-18 months)" — a band Birth to 5 Matters really
// does merge, for Technology and both Expressive Arts aspects — is 1..2, so its
// header cell is drawn two columns wide. Returns null for a label that is not
// numbered at all (Fledge's "birth-18m", or no band at all).
function b255BandPos(ageRange) {
  const m = /^\s*Range\s*(\d+)\s*(?:[-\u2013]\s*(\d+))?/i.exec(String(ageRange || ''));
  if (!m) return null;
  const from = parseInt(m[1], 10);
  const to   = m[2] ? parseInt(m[2], 10) : from;
  return (to >= from && to - from < 8) ? { from, to } : { from, to: from };
}

function b255AgeMonths(dob) {
  if (!dob) return null;
  const d = dob instanceof Date ? dob : new Date(dob);
  if (isNaN(d)) return null;
  const now = new Date();
  let m = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) m -= 1;
  return m < 0 ? 0 : m;
}

/* ── b291: the demographic flags the tracker grid filters on ────────────────
 *
 * Toby asked to filter by "age, room, SEN, key person, and demographics (EAL /
 * EYPP / funded / gender)". ladn.children holds a column for all of them EXCEPT
 * EAL, so that one is derived and the derivation is stated here rather than
 * hidden in a WHERE clause. What each filter reads, and what is missing, is
 * written up in logs/b291-tracker-density.NOTES.md.
 */

/** SEN. Three records can say a child has SEN and they disagree in practice, so
 *  the filter is the union: an active sen_register row (b256's toolkit), the
 *  legacy send_needs boolean, or a filled-in sen_status/sen_needs. */
function b291Sen(k) {
  return !!(k.on_sen_register || k.send_needs ||
            (k.sen_status && String(k.sen_status).trim()) ||
            (k.sen_needs && String(k.sen_needs).trim()));
}

/** EAL — English as an Additional Language. There is NO eal column on
 *  ladn.children. The nearest true record is home_language (or the CTF
 *  first_language_code), so EAL means "a home language is recorded and it is not
 *  English". A child with no home language recorded is NOT counted as EAL —
 *  absent data is not a demographic. */
function b291Eal(k) {
  const lang = String(k.home_language || k.first_language_code || '').trim();
  if (!lang) return false;
  return !/^(eng|english|en)$/i.test(lang);
}

/** Funded — any of the four ways funding is recorded on a child. */
function b291Funded(k) {
  return !!(k.funded_hours_15 || k.funded_hours_30 || k.two_year_funded ||
            Number(k.funded_hours || 0) > 0);
}

/** DATE columns come back from pg as a local-midnight Date — read local parts. */
function b255Ymd(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The framework's column tree, straight out of its own statements.
 *
 * Two shapes come out of this, because two frameworks genuinely have two shapes:
 *
 *   NUMBERED (Birth to 5 Matters). Every band is "Range N (a-b months)", so the
 *   framework has a shared, ordered band vocabulary. Every aspect is given the
 *   FULL set of numbered positions — exactly as EyLog draws it — and an aspect
 *   with no statement in a range (Literacy → Writing has nothing before Range 3)
 *   gets a permanently empty cell there rather than a shifted column. Without
 *   this the ranges stop lining up across the 92-column grid and it is unreadable.
 *
 *   UNNUMBERED (Fledge). Its "aspects" ARE its bands — one band each — so there
 *   is nothing to line up and padding would draw four empty columns beside every
 *   real one. Each aspect keeps exactly the bands it has. The Fledge Profile
 *   area has no age band at all, and renders as one column per aspect.
 *
 * The mode is derived from the data, never configured: nothing here knows that
 * Birth to 5 has six ranges.
 */
async function b255Structure(db, framework) {
  const { rows } = await db.query(`
    SELECT area, aspect, age_range,
           COUNT(*)::int      AS statements,
           MIN(ordinal)       AS ord,
           MIN(id)            AS min_id
      FROM framework_statements
     WHERE framework = $1
       AND is_active                          -- b332
       AND statement_text NOT LIKE '(stub%'
     GROUP BY area, aspect, age_range
     ORDER BY MIN(ordinal) NULLS LAST, MIN(id)
  `, [framework]);
  if (!rows.length) return { areas: [], numbered: false, positions: 0 };

  // Numbered only if EVERY band in the framework is a numbered range.
  let numbered = true, maxPos = 0;
  const posOf = new Map();
  for (const r of rows) {
    const p = b255BandPos(r.age_range);
    if (!p) { numbered = false; break; }
    posOf.set(r.age_range, p);
    if (p.to > maxPos) maxPos = p.to;
  }
  if (!numbered) maxPos = 0;

  const areas = [];
  const areaIx = new Map();
  for (const r of rows) {
    const aspectLabel = r.aspect || r.area;   // an aspect-less framework still draws
    let a = areaIx.get(r.area);
    if (!a) { a = { area: r.area, aspects: [] }; areaIx.set(r.area, a); areas.push(a); }
    let asp = a.aspects.find(x => x.aspect === aspectLabel);
    // `aspect_raw` is what the DB actually holds (which may be NULL); `aspect` is
    // what the header shows. The client echoes aspect_raw back to /tracker-cell,
    // so a framework with no aspect column still resolves to the right rows.
    if (!asp) { asp = { aspect: aspectLabel, aspect_raw: r.aspect || null, bands: [] }; a.aspects.push(asp); }
    asp.bands.push({
      age_range: r.age_range || null,
      label: r.age_range || '\u2014',
      statements: r.statements,
      span: numbered ? (posOf.get(r.age_range).to - posOf.get(r.age_range).from + 1) : 1,
      from: numbered ? posOf.get(r.age_range).from : null,
    });
  }

  if (numbered) {
    // Lay each aspect's bands out on the framework's own numbered positions,
    // inserting an empty placeholder wherever that aspect has no statements.
    for (const a of areas) {
      for (const asp of a.aspects) {
        const byPos = new Map(asp.bands.map(b => [b.from, b]));
        const laid = [];
        for (let p = 1; p <= maxPos; p++) {
          const b = byPos.get(p);
          if (b) { laid.push(b); p += b.span - 1; }
          else   { laid.push({ age_range: null, label: '', statements: 0, span: 1, from: p, empty: true }); }
        }
        asp.bands = laid;
      }
    }
  }

  areas.forEach(a => {
    a.aspects.forEach(asp => { asp.span = asp.bands.reduce((n, b) => n + b.span, 0); });
    a.span = a.aspects.reduce((n, x) => n + x.span, 0);
  });
  return { areas, numbered, positions: maxPos };
}

// ── GET /grid-frameworks ───────────────────────────────────────────────────
// Every framework that HAS statements — not just the ones somebody has already
// assessed against. /tracker-frameworks deliberately hides an unused framework
// (it drives the EY selector, where an empty framework is noise); this one must
// show it, because "start tracking Fledge" begins with picking a framework
// nobody has used yet.
router.get('/grid-frameworks', requireCapability('children.view'), async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT fs.framework,
             COUNT(*)::int                                  AS statements,
             COUNT(DISTINCT fs.area)::int                   AS areas,
             COUNT(DISTINCT fs.aspect)::int                 AS aspects,
             COUNT(DISTINCT fs.age_range)::int              AS bands,
             COALESCE(t.assessments, 0)::int                AS assessments,
             COALESCE(t.children, 0)::int                   AS children
        FROM framework_statements fs
        LEFT JOIN (
          SELECT framework, COUNT(*) AS assessments, COUNT(DISTINCT child_id) AS children
            FROM framework_tracker WHERE statement_id IS NOT NULL GROUP BY framework
        ) t ON t.framework = fs.framework
       WHERE fs.statement_text NOT LIKE '(stub%'
       GROUP BY fs.framework, t.assessments, t.children
       ORDER BY COUNT(*) DESC
    `);
    let deflt = null;
    try {
      const s = await db.query(`SELECT value FROM settings WHERE key='default_framework'`);
      deflt = (s.rows[0] && s.rows[0].value) || null;
    } catch (_) { /* settings row absent — no default, the client picks the first */ }
    const active = await _activeFrameworks(db);
    // De-list, don't destroy: hide frameworks outside settings.active_frameworks from
    // the grid selector, but never hide the setting's own current default even if a
    // config edit forgot to include it.
    // fledge-off (2026-10-26): Fledge is switched off (src/lib/fledge-switch.js) —
    // not offered in the selector and never the default, even if the row says so.
    if (!(await FS.isFledgeEnabled(db)) && FS.isFledgeKey(deflt)) deflt = FS.OFF_FALLBACK;
    const visible = await FS.withoutFledge(db,
      active ? rows.filter(r => active.has(r.framework) || r.framework === deflt) : rows);
    res.json({
      default_framework: deflt,
      frameworks: await Promise.all(visible.map(async r => ({
        ...r, label: await _fwLabel(db, r.framework), is_default: r.framework === deflt,
      }))),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /tracker-grid?framework=&scope=group|room|mine&room_id= ────────────
// The whole grid in one call: the column tree, the children, and one aggregated
// cell per child × band.
router.get('/tracker-grid', requireCapability('children.view'), async (req, res) => {
  const framework = req.query.framework || 'birth_to_5_la';
  const scope     = req.query.scope || 'group';
  const db = getPool();
  try {
    const { areas, numbered, positions } = await b255Structure(db, framework);
    if (!areas.length) {
      return res.json({ framework, label: await _fwLabel(db, framework), scope,
                        areas: [], numbered: false, positions: 0,
                        children: [], cells: {}, empty: 'no_statements' });
    }

    const cParams = [];
    const cConds  = ['c.is_active = true'];
    if (scope === 'room' && req.query.room_id) {
      cParams.push(req.query.room_id); cConds.push(`c.room_id = $${cParams.length}`);
    } else if (scope === 'mine' && req.user && req.user.id) {
      cParams.push(req.user.id); cConds.push(`c.key_person_id = $${cParams.length}`);
    }
    /* b291 — the filter/sort columns come back WITH the grid, and the client
     * filters and sorts in the browser. 85 active children is nothing to filter
     * client-side, and it means changing a filter or a sort is instant and can
     * be restored from localStorage on reload without a round trip.
     *
     * Every column below is one ladn.children column, read as-is. Nothing is
     * inferred except EAL, which the table has no boolean for — see b291Eal. */
    const { rows: kids } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.date_of_birth,
             c.room_id, r.name AS room_name,
             c.key_person_id, s.first_name AS kp_first, s.last_name AS kp_last,
             c.send_needs, c.sen_status, c.sen_needs,
             c.eypp_eligible, c.pupil_premium, c.looked_after,
             c.home_language, c.first_language_code,
             c.gender,
             c.funded_hours, c.funded_hours_15, c.funded_hours_30, c.two_year_funded,
             EXISTS (SELECT 1 FROM sen_register sr
                      WHERE sr.child_id = c.id AND COALESCE(sr.is_active, true)) AS on_sen_register
        FROM children c
        LEFT JOIN rooms r ON r.id = c.room_id
        LEFT JOIN staff s ON s.id = c.key_person_id
       WHERE ${cConds.join(' AND ')}
       ORDER BY c.first_name, c.last_name
    `, cParams);
    const childIds = kids.map(k => k.id);

    // Children this framework is not used for — EyLog's full-width N/A row.
    // Table is b255; guard so an instance without the migration still renders.
    let optout = new Map();
    try {
      const { rows } = await db.query(
        `SELECT child_id, reason FROM framework_child_optout WHERE framework = $1`, [framework]);
      optout = new Map(rows.map(r => [r.child_id, r.reason || null]));
    } catch (_) { /* pre-migration instance — nobody is N/A */ }

    const children = kids.map(k => ({
      id: k.id,
      name: [k.first_name, k.last_name].filter(Boolean).join(' '),
      first_name: k.first_name, last_name: k.last_name,
      dob: b255Ymd(k.date_of_birth),
      age_months: b255AgeMonths(k.date_of_birth),
      room_id: k.room_id, room_name: k.room_name,
      // ── b291 filter/sort columns ─────────────────────────────────────────
      key_person_id: k.key_person_id || null,
      key_person_name: k.key_person_id
        ? [k.kp_first, k.kp_last].filter(Boolean).join(' ') : null,
      sen: b291Sen(k),
      // Which record says so, so a filtered list can be justified to an
      // inspector rather than being an unexplained subset.
      sen_source: k.on_sen_register ? 'sen_register'
                : k.send_needs ? 'send_needs'
                : (k.sen_status || k.sen_needs) ? 'sen_status' : null,
      eal: b291Eal(k),
      home_language: k.home_language || null,
      eypp: !!k.eypp_eligible,
      pupil_premium: !!k.pupil_premium,
      looked_after: !!k.looked_after,
      funded: b291Funded(k),
      gender: k.gender || null,
      na: optout.has(k.id),
      na_reason: optout.get(k.id) || null,
    }));

    // One aggregated row per child × band. `total` is how many statements the
    // band holds, so the client can tell "all of them are green" from "the one
    // that was assessed is green".
    let cells = {};
    if (childIds.length) {
      const { rows } = await db.query(`
        SELECT ft.child_id, fs.area, fs.aspect, fs.age_range,
               COUNT(*)::int AS assessed,
               COUNT(*) FILTER (WHERE ft.status = ANY($3::text[]))::int AS green,
               COUNT(*) FILTER (WHERE ft.status = ANY($4::text[]))::int AS grey
          FROM framework_tracker ft
          JOIN framework_statements fs ON fs.id = ft.statement_id
         WHERE ft.framework = $1
           AND ft.child_id = ANY($2::int[])
           AND fs.framework = $1
         GROUP BY ft.child_id, fs.area, fs.aspect, fs.age_range
      `, [framework, childIds, [...B255_GREEN], [...B255_GREY]]);

      for (const r of rows) {
        const amber = r.assessed - r.green - r.grey;
        // blank → nothing recorded. grey → recorded, but recorded as not yet.
        // green → every assessment in the band is secure. amber → in between.
        const colour = r.assessed === 0 ? 'blank'
                     : r.green === r.assessed ? 'green'
                     : (r.green + amber) === 0 ? 'grey'
                     : 'amber';
        cells[`${r.child_id}|${r.area}|${r.aspect || ''}|${r.age_range || ''}`] =
          { c: colour, n: r.assessed, g: r.green };
      }
    }

    /* ── b291: the RANGE judgements, keyed child|area ────────────────────────
     * The most recent judgement per child per area for this framework, whichever
     * of the three report moments recorded it. This is what the grid's
     * judgement columns show, and it carries `security` — which is NULL for
     * every judgement written before b291 and renders as "not yet rated". The
     * table is b278; guard so an instance without the migration still draws the
     * grid, exactly as the optout guard above does. */
    let ranges = {};
    let rangeAreas = [];
    if (childIds.length) {
      try {
        const { rows } = await db.query(`
          SELECT DISTINCT ON (child_id, area)
                 child_id, area, range_ordinal, range_label, security,
                 context, judged_on
            FROM child_range_judgements
           WHERE framework = $1 AND child_id = ANY($2::int[])
           ORDER BY child_id, area, judged_on DESC, id DESC
        `, [framework, childIds]);
        for (const r of rows) {
          ranges[`${r.child_id}|${r.area}`] = {
            ordinal: r.range_ordinal,
            label: r.range_label,
            // Never coerced. NULL stays NULL all the way to the cell.
            security: r.security || null,
            context: r.context,
            judged_on: b255Ymd(r.judged_on),
          };
        }
        rangeAreas = areas.map(a => a.area);
      } catch (_) { /* pre-b278 instance — no range judgements to show */ }
    }

    res.json({
      framework, label: await _fwLabel(db, framework), scope,
      areas, numbered, positions, children, cells,
      status_colours: { green: [...B255_GREEN], grey: [...B255_GREY] },
      // b291
      ranges, range_areas: rangeAreas,
      securities: B291_SECURITY.VALUES,
      // Which of Toby's filters this setting actually has data behind. A filter
      // with a 0 here is offered but says "none recorded" rather than silently
      // returning an empty grid and looking broken.
      filter_counts: {
        sen:    children.filter(c => c.sen).length,
        eal:    children.filter(c => c.eal).length,
        eypp:   children.filter(c => c.eypp).length,
        funded: children.filter(c => c.funded).length,
        gender: children.filter(c => c.gender).length,
        key_person: children.filter(c => c.key_person_id).length,
        room:   children.filter(c => c.room_id).length,
        rated:  Object.values(ranges).filter(r => r.security).length,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /tracker-cell — the statements behind ONE cell ─────────────────────
// ?framework=&child_id=&area=&aspect=&age_range=   (age_range may be empty)
// Read-only. Writing a status still goes through the routes that already exist:
// PUT /framework/:ftId and POST /framework-tracker/link.
router.get('/tracker-cell', requireCapability('children.view'), async (req, res) => {
  const { framework, area } = req.query;
  const childId = parseInt(req.query.child_id, 10);
  if (!framework || !area || !childId) {
    return res.status(400).json({ error: 'framework, area and child_id are required' });
  }
  const aspect = req.query.aspect || null;
  const ageRange = req.query.age_range || null;
  try {
    const { rows } = await getPool().query(`
      SELECT fs.id AS statement_id, fs.statement_code, fs.statement_text, fs.ordinal,
             ft.id AS tracker_id, ft.status, ft.linked_observation_id, ft.assessed_at,
             s.first_name || ' ' || s.last_name AS assessed_by_name
        FROM framework_statements fs
        LEFT JOIN framework_tracker ft
               ON ft.statement_id = fs.id AND ft.child_id = $2 AND ft.framework = $1
        LEFT JOIN staff s ON s.id = ft.assessed_by
       WHERE fs.framework = $1
         AND fs.is_active                     -- b332
         AND fs.area = $3
         AND (fs.aspect IS NOT DISTINCT FROM $4 OR $4 IS NULL)
         AND (fs.age_range IS NOT DISTINCT FROM $5 OR $5 IS NULL)
         AND fs.statement_text NOT LIKE '(stub%'
       ORDER BY fs.ordinal NULLS LAST, fs.id
    `, [framework, childId, area, aspect, ageRange]);
    res.json({ framework, child_id: childId, area, aspect, age_range: ageRange, statements: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /framework-optout {child_id, framework, na, reason} ────────────────
// Mark (or unmark) a child as "this framework is not used for them" — the N/A
// row. Deliberately NOT a framework_tracker status: it is an arrangement, not a
// judgement, and putting it in the status column would change what every
// existing count over that table means.
//
// children.edit at 'edit' level: a practitioner holds children.edit at 'view'
// only, so they see the N/A row but cannot decide a child is off-framework.
router.put('/framework-optout',
  requireCapabilityLevel('children.edit', 'edit'),
  async (req, res) => {
    const childId   = parseInt((req.body || {}).child_id, 10);
    const framework = ((req.body || {}).framework || '').trim();
    const na        = !!(req.body || {}).na;
    const reason    = ((req.body || {}).reason || '').trim() || null;
    if (!childId || !framework) return res.status(400).json({ error: 'child_id and framework are required' });
    try {
      const db = getPool();
      if (na) {
        await db.query(`
          INSERT INTO framework_child_optout (child_id, framework, reason, set_by, set_at)
          VALUES ($1, $2, $3, $4, now())
          ON CONFLICT (child_id, framework)
          DO UPDATE SET reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()
        `, [childId, framework, reason, req.user && req.user.id]);
      } else {
        await db.query(`DELETE FROM framework_child_optout WHERE child_id = $1 AND framework = $2`,
          [childId, framework]);
      }
      recordAudit({ req, action: 'update', entity_type: 'framework_optout', entity_id: childId,
        meta: { framework, na } });
      res.json({ ok: true, child_id: childId, framework, na });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

// ── GET /fledge-mapping-draft ──────────────────────────────────────────────
// §3 of b255. A DRAFT comparison of Fledge against Birth to 5 Matters, for Toby
// to read and nobody else to act on. It publishes nothing, alters no framework
// and is read by exactly one page. Manager-only, and it says DRAFT on it.
router.get('/fledge-mapping-draft', async (req, res) => {
  if (!req.user || !hasRole(req.user, ['manager', 'admin', 'headteacher'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  // fledge-off (2026-10-26): Fledge is switched off (src/lib/fledge-switch.js).
  if (!(await FS.isFledgeEnabled(getPool()))) return res.status(404).json({ error: 'not_available' });
  const db = getPool();
  try {
    const t = await db.query(`SELECT to_regclass('framework_mapping_draft') AS t`);
    if (!t.rows[0] || !t.rows[0].t) {
      return res.json({ available: false, draft: true, rows: [], note: 'The draft has not been generated on this instance.' });
    }
    const { rows: runs } = await db.query(`
      SELECT run_id, model, MIN(created_at) AS created_at, COUNT(*)::int AS n
        FROM framework_mapping_draft
       WHERE source_framework = 'fledge'
       GROUP BY run_id, model ORDER BY MIN(created_at) DESC LIMIT 1`);
    if (!runs.length) {
      return res.json({ available: false, draft: true, rows: [], note: 'The draft has not been generated on this instance.' });
    }
    const run = runs[0];
    const { rows } = await db.query(`
      SELECT d.id, d.confidence, d.reasoning, d.b25_statement_ids,
             src.id AS fledge_id, src.area, src.aspect, src.age_range,
             src.statement_code, src.statement_text, src.ordinal
        FROM framework_mapping_draft d
        JOIN framework_statements src ON src.id = d.source_statement_id
       WHERE d.run_id = $1
       ORDER BY src.ordinal NULLS LAST, src.id`, [run.run_id]);

    const ids = [...new Set(rows.flatMap(r => r.b25_statement_ids || []))];
    let b25 = new Map();
    if (ids.length) {
      const { rows: t2 } = await db.query(
        `SELECT id, area, aspect, age_range, statement_code, statement_text
           FROM framework_statements WHERE id = ANY($1::int[])`, [ids]);
      b25 = new Map(t2.map(r => [r.id, r]));
    }
    res.json({
      available: true, draft: true, run_id: run.run_id, model: run.model,
      generated_at: run.created_at, count: run.n,
      rows: rows.map(r => ({ ...r, matches: (r.b25_statement_ids || []).map(i => b25.get(i)).filter(Boolean) })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * b278 — STATEMENTS in observations, RANGES in reports (2026-09-04)
 *
 * Toby, 2026-09-04:
 *   "when we are doing observations, we are tagging the statements from the 7
 *    areas, we are NOT TAGGING when we do, just the range for — the termly
 *    updates, progress reports, and 2 year checks. Same with birth25 matters.
 *    tagging statements in obs, and ranges in reports."
 *
 * Statements already had a home (observation_statements / framework_tracker).
 * A range did not: band_judgements is Fledge-only (CHECK 1..5) and no UI ever
 * wrote to it. These endpoints are the range half, for BOTH frameworks.
 *
 * The range vocabulary is DERIVED from each framework's own statements via the
 * same b255 rules the tracker grid uses — nothing here knows that Birth to 5
 * has six ranges or that Fledge has five bands.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* Contexts that record a RANGE. Anything not in here records STATEMENTS. */
const B278_RANGE_CONTEXTS = ['termly_update', 'progress_report', 'two_year_check'];

/* b291 (2026-09-08) — HOW SECURE the child is in the range they were tagged at.
 *
 * Toby: "when we're tagging the ranges in Birth to Five or Development Matters
 * or Fledge, we should also be tagging how secure they are in that range."
 *
 * Still the range, never the statement (b278). The vocabulary is the standard
 * EYFS one and is shared with the browser — public/js/wren-security-rating.js is
 * the single definition, required here rather than retyped, so the three words
 * cannot drift between the picker, the grid and the validator.
 *
 * NULL is a legitimate stored value and means NOT YET RATED. It is never
 * defaulted, never back-filled and never rendered as 'emerging'. */
const B291_SECURITY = require('../../public/js/wren-security-rating.js');

/** Validate one security value off the wire.
 *  -> { ok:true, value } | { ok:false, error }
 *  Absent/empty/null are all "not rated" and are accepted. An unrecognised
 *  string is REJECTED rather than quietly coerced — silently storing NULL for a
 *  typo would look identical to a practitioner deliberately leaving it blank. */
function b291Security(v) {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (B291_SECURITY.KEYS.includes(v)) return { ok: true, value: v };
  return { ok: false, error: `security must be one of ${B291_SECURITY.KEYS.join(', ')} (or omitted for not-yet-rated), got: ${v}` };
}

/* The ordered band vocabulary for a framework, plus the areas it applies to.
 *
 * Two shapes, because the two frameworks genuinely have two shapes (b255):
 *   • NUMBERED  — every band is "Range N (a-b months)" in `age_range`
 *                 (Birth to 5 Matters). Position comes from b255BandPos, NOT
 *                 from counting distinct labels.
 *   • BANDED    — the band lives in `aspect` ("Band 1 — Nestlings", Fledge) and
 *                 `age_range` is empty. Position is the order of first
 *                 appearance by ordinal.
 * An area with no band at all (Fledge Profile) is not a range-able area and is
 * excluded — you cannot record "which range" against it.
 */
async function b278RangeVocabulary(db, framework) {
  const { rows } = await db.query(`
    SELECT area, aspect, age_range, COUNT(*)::int AS statements, MIN(ordinal) AS ord, MIN(id) AS min_id
      FROM framework_statements
     WHERE framework = $1 AND is_active AND statement_text NOT LIKE '(stub%'   -- b332
     GROUP BY area, aspect, age_range
     ORDER BY MIN(ordinal) NULLS LAST, MIN(id)
  `, [framework]);
  if (!rows.length) return { mode: 'none', ranges: [], areas: [] };

  // Numbered only if EVERY row carries a numbered range — same test as b255Structure.
  let numbered = rows.every(r => !!b255BandPos(r.age_range));

  if (numbered) {
    /* One option PER POSITION, not per distinct label. Birth to 5 Matters
     * genuinely merges Ranges 1-2 for Technology and both Expressive Arts
     * aspects (b255), so the labels are "Range 1 (0-11 months)" AND
     * "Range 1-2 (0-18 months)" — seven strings across six positions. A picker
     * that offered both would let a practitioner record two different things
     * meaning position 1, and the POST validator (keyed by position) would
     * silently keep whichever came last. So: positions 1..max, each with the
     * label that covers exactly that position, and the merged label kept
     * alongside as `merged` rather than as a rival option. */
    const seen = new Map();   // label -> {from,to}
    let maxPos = 0;
    for (const r of rows) {
      const p = b255BandPos(r.age_range);
      if (!seen.has(r.age_range)) seen.set(r.age_range, p);
      if (p.to > maxPos) maxPos = p.to;
    }
    const short = l => String(l).replace(/\s*\(.*\)\s*$/, '');
    const ranges = [];
    for (let pos = 1; pos <= maxPos; pos++) {
      const exact  = [...seen.entries()].find(([, p]) => p.from === pos && p.to === pos);
      const merged = [...seen.entries()].filter(([, p]) => p.from <= pos && p.to >= pos && p.to > p.from);
      const label  = exact ? exact[0] : (merged[0] ? merged[0][0] : 'Range ' + pos);
      ranges.push({
        ordinal: pos,
        label,
        short: exact ? short(exact[0]) : 'Range ' + pos,
        merged: merged.map(([l]) => l),
      });
    }
    const areas = [...new Set(rows.map(r => r.area))];
    return { mode: 'numbered', ranges, areas };
  }

  // BANDED: the aspect is the band. Only areas whose aspects all look like bands
  // qualify — Fledge Profile's aspects are themes, not bands, so it drops out.
  const bandLike = a => /^\s*(Band|Stage|Step|Phase)\s*\d/i.test(String(a || ''));
  const order = [];
  const seenB = new Map();
  for (const r of rows) {
    if (!bandLike(r.aspect)) continue;
    if (!seenB.has(r.aspect)) { seenB.set(r.aspect, order.length + 1); order.push(r.aspect); }
  }
  if (!order.length) return { mode: 'none', ranges: [], areas: [] };
  const ranges = order.map((label, i) => ({
    ordinal: i + 1, label,
    // "Band 2 — First flutters" → "Band 2"
    short: String(label).replace(/\s*[—–-]\s*.*$/, '').trim() || label,
    spans: null,
  }));
  const areas = [...new Set(rows.filter(r => bandLike(r.aspect)).map(r => r.area))];
  return { mode: 'banded', ranges, areas };
}

/* GET /framework-ranges?framework=birth_to_5_la
 * The range picker's options. This is what a termly update / progress report /
 * 2-year check offers — never a statement list. */
router.get('/framework-ranges', async (req, res) => {
  const framework = req.query.framework || 'birth_to_5_la';
  try {
    const vocab = await b278RangeVocabulary(getPool(), framework);
    res.json({
      framework,
      label: TRACKER_FW_LABELS[framework] || framework,
      contexts: B278_RANGE_CONTEXTS,
      // b291 — the three security terms, so a client never hard-codes them.
      securities: B291_SECURITY.VALUES,
      ...vocab,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /child-ranges/:child_id?framework=&context=
 * What has been recorded for this child, plus a per-area SUGGESTION derived from
 * the statements the tracker already holds (highest range with any evidence).
 * The suggestion is a starting point for the practitioner, never a saved value. */
router.get('/child-ranges/:child_id', async (req, res) => {
  const childId   = parseInt(req.params.child_id, 10);
  const framework = req.query.framework || 'birth_to_5_la';
  if (!childId) return res.status(400).json({ error: 'child_id required' });
  const db = getPool();
  try {
    const vocab = await b278RangeVocabulary(db, framework);
    const params = [childId, framework];
    let where = 'child_id = $1 AND framework = $2';
    if (req.query.context) { params.push(req.query.context); where += ` AND context = $${params.length}`; }

    const { rows: recorded } = await db.query(`
      SELECT DISTINCT ON (area, context)
             area, context, context_id, range_ordinal, range_label, judged_on, judged_by, notes,
             -- b291. NULL here means NOT YET RATED; the client must not read it
             -- as Emerging, and nothing below fills it in.
             security, security_set_at
        FROM child_range_judgements
       WHERE ${where}
       ORDER BY area, context, judged_on DESC, id DESC
    `, params);

    /* Suggestion: the highest range position in which this child has ANY
     * evidenced statement on the tracker. Statements were tagged by
     * observations — this reads them, it never writes them. */
    const suggested = {};
    try {
      const { rows: ev } = await db.query(`
        SELECT fs.area, fs.aspect, fs.age_range, ft.status
          FROM framework_tracker ft
          JOIN framework_statements fs ON fs.id = ft.statement_id
         WHERE ft.child_id = $1 AND ft.framework = $2
           AND COALESCE(ft.status, '') NOT IN ('not_yet', 'not_observed', 'na')
      `, [childId, framework]);
      const posOf = new Map(vocab.ranges.map(r => [r.label, r.ordinal]));
      for (const r of ev) {
        const key = vocab.mode === 'numbered' ? r.age_range : r.aspect;
        const p = posOf.get(key);
        if (p && (!suggested[r.area] || p > suggested[r.area])) suggested[r.area] = p;
      }
    } catch (_) { /* no tracker rows yet — no suggestion, not an error */ }

    res.json({
      child_id: childId, framework,
      mode: vocab.mode, ranges: vocab.ranges, areas: vocab.areas,
      securities: B291_SECURITY.VALUES,
      // pg hands back a DATE as a local-midnight JS Date; toISOString() would
      // shift it a day west of Greenwich. b255Ymd reads the local parts.
      recorded: recorded.map(r => ({
        ...r, judged_on: b255Ymd(r.judged_on),
        security: r.security || null,
        security_label: B291_SECURITY.label(r.security),
      })),
      suggested,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /child-range-summary/:child_id  (b291)
 * The latest range judgement per area, across every framework the child has
 * ever been ranged against, with how secure they were judged to be in it.
 *
 * This is what a CHILD PROFILE shows. It takes no framework parameter on
 * purpose: a profile must not have to know which framework the setting is
 * using, and a setting mid-way through a Birth-to-5 → Fledge move has rows
 * under both. Read-only; writes still go through POST /child-ranges. */
router.get('/child-range-summary/:child_id', async (req, res) => {
  const childId = parseInt(req.params.child_id, 10);
  if (!childId) return res.status(400).json({ error: 'child_id required' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT DISTINCT ON (framework, area)
             framework, area, range_ordinal, range_label, security,
             context, context_id, judged_on
        FROM child_range_judgements
       WHERE child_id = $1
       ORDER BY framework, area, judged_on DESC, id DESC
    `, [childId]);
    // fledge-off (2026-10-26): Fledge ranges stay in the table (history) but are not
    // shown while the Fledge switch is off (src/lib/fledge-switch.js).
    if (!(await FS.isFledgeEnabled(db))) {
      for (let i = rows.length - 1; i >= 0; i--) if (FS.isFledgeKey(rows[i].framework)) rows.splice(i, 1);
    }

    const labels = {};
    for (const fw of [...new Set(rows.map(r => r.framework))]) {
      labels[fw] = await _fwLabel(db, fw).catch(() => fw);
    }
    res.json({
      child_id: childId,
      securities: B291_SECURITY.VALUES,
      areas: rows.map(r => ({
        framework: r.framework,
        framework_label: labels[r.framework] || r.framework,
        area: r.area,
        range_ordinal: r.range_ordinal,
        range_label: r.range_label,
        // Never coerced: a row from before b291 stays null and the client
        // renders "not yet rated", not "Emerging".
        security: r.security || null,
        security_label: B291_SECURITY.label(r.security),
        context: r.context,
        judged_on: b255Ymd(r.judged_on),
      })),
    });
  } catch (e) {
    // Pre-b278 instance — the profile simply shows no ranges rather than an error.
    if (/relation .* does not exist/i.test(e.message || '')) {
      return res.json({ child_id: childId, areas: [], securities: B291_SECURITY.VALUES });
    }
    res.status(500).json({ error: e.message });
  }
});

/* POST /child-ranges
 * { child_id, framework, context, context_id?, judged_on?, notes?,
 *   areas: [{ area, range_ordinal, security? }] }
 *
 * Records the RANGE for one of the three report moments. Rejects a context that
 * is not a range context — an observation must never reach this endpoint, and
 * that rule is enforced here as well as in the UI.
 *
 * b291: `security` (emerging|developing|secure) rides alongside the range and is
 * OPTIONAL. Omitting it stores NULL — "not yet rated" — which is a real answer,
 * not a low one. An UNRECOGNISED value is a 400 rather than a silent NULL. */
router.post('/child-ranges', async (req, res) => {
  const b = req.body || {};
  const childId = parseInt(b.child_id, 10);
  const framework = b.framework || 'birth_to_5_la';
  // fledge-off (2026-10-26): Fledge is switched off (src/lib/fledge-switch.js).
  // No new Fledge range/band judgement while it is off; earlier ones stay as history.
  if (FS.isFledgeKey(framework) && !(await FS.isFledgeEnabled(getPool()))) {
    return res.status(409).json({ error: 'framework_not_available', framework });
  }
  const context = String(b.context || '');
  if (!childId) return res.status(400).json({ error: 'child_id required' });
  if (!B278_RANGE_CONTEXTS.includes(context)) {
    return res.status(400).json({
      error: `context must be one of ${B278_RANGE_CONTEXTS.join(', ')} — ` +
             'observations tag statements, not ranges',
    });
  }
  const areas = Array.isArray(b.areas) ? b.areas : [];
  if (!areas.length) return res.status(400).json({ error: 'areas required' });

  const db = getPool();
  try {
    const vocab = await b278RangeVocabulary(db, framework);
    if (vocab.mode === 'none') {
      return res.status(400).json({ error: `${framework} has no range vocabulary` });
    }
    const byOrd  = new Map(vocab.ranges.map(r => [r.ordinal, r]));
    const areaOk = new Set(vocab.areas);

    const rows = [];
    for (const a of areas) {
      const ord = parseInt(a.range_ordinal, 10);
      if (!byOrd.has(ord)) return res.status(400).json({ error: `unknown range position ${a.range_ordinal}` });
      if (!areaOk.has(a.area)) return res.status(400).json({ error: `area not in ${framework}: ${a.area}` });
      const sec = b291Security(a.security);
      if (!sec.ok) return res.status(400).json({ error: `${a.area}: ${sec.error}` });
      /* Sending `security: null` is "the practitioner cleared the rating" and
       * must overwrite. OMITTING the key is an older client that knows nothing
       * about b291, and must NOT wipe a rating somebody set earlier today. */
      const sent = Object.prototype.hasOwnProperty.call(a, 'security');
      rows.push({ area: a.area, ord, label: byOrd.get(ord).label,
                  security: sec.value, security_sent: sent });
    }

    const judgedOn = b.judged_on || null;
    const saved = [];
    for (const r of rows) {
      const staffId = (req.user && req.user.id) || null;
      const { rows: out } = await db.query(`
        INSERT INTO child_range_judgements
          (child_id, framework, area, range_ordinal, range_label, context, context_id,
           judged_on, judged_by, notes,
           security, security_set_by, security_set_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::date, CURRENT_DATE), $9::int, $10,
                -- Cast $11 the same way everywhere it appears, or pg deduces
                -- varchar from the column and text from the CASE and refuses.
                $11::text,
                CASE WHEN $11::text IS NULL THEN NULL ELSE $9::int END,
                CASE WHEN $11::text IS NULL THEN NULL ELSE now()   END)
        ON CONFLICT (child_id, framework, area, context, judged_on)
        DO UPDATE SET range_ordinal = EXCLUDED.range_ordinal,
                      range_label   = EXCLUDED.range_label,
                      context_id    = COALESCE(EXCLUDED.context_id, child_range_judgements.context_id),
                      judged_by     = EXCLUDED.judged_by,
                      notes         = EXCLUDED.notes,
                      -- b291. $12 is "this client sent a security field at all".
                      -- False = an older client; keep whatever is already there
                      -- rather than blanking a rating it does not know about.
                      security      = CASE WHEN $12 THEN EXCLUDED.security
                                           ELSE child_range_judgements.security END,
                      security_set_by = CASE WHEN $12 THEN EXCLUDED.security_set_by
                                             ELSE child_range_judgements.security_set_by END,
                      security_set_at = CASE WHEN $12 THEN EXCLUDED.security_set_at
                                             ELSE child_range_judgements.security_set_at END,
                      updated_at    = now()
        RETURNING id, area, range_ordinal, range_label, judged_on, security
      `, [childId, framework, r.area, r.ord, r.label, context, b.context_id || null,
          judgedOn, staffId, b.notes || null,
          r.security, r.security_sent]);
      saved.push(out[0]);
    }

    /* Fledge bands 1-5 also feed the pre-existing cohort view, which reads
     * band_judgements. Dual-write so /fledge-bands stays live rather than
     * showing a child as unassessed the moment the new table takes over. */
    if (framework === 'fledge') {
      for (const r of rows) {
        if (r.ord < 1 || r.ord > 5) continue;
        await db.query(`
          INSERT INTO band_judgements (child_id, area, band, judged_on, judged_by, source, notes, security)
          VALUES ($1,$2,$3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7, $8)
          ON CONFLICT (child_id, area, judged_on)
          DO UPDATE SET band = EXCLUDED.band, judged_by = EXCLUDED.judged_by, source = EXCLUDED.source,
                        security = CASE WHEN $9 THEN EXCLUDED.security
                                        ELSE band_judgements.security END
        `, [childId, r.area, r.ord, judgedOn, (req.user && req.user.id) || null,
            'b278:' + context, b.notes || null, r.security, r.security_sent]).catch(() => {});
      }
    }

    res.json({ ok: true, child_id: childId, framework, context,
               saved: saved.map(r => ({
                 ...r, judged_on: b255Ymd(r.judged_on),
                 security: r.security || null,
                 security_label: B291_SECURITY.label(r.security),
               })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /fledge-profile
 * The 19 Fledge Profile statements with their icon mapping, so no page has to
 * hard-code either. Toby, 2026-09-04: "where it links to the profile statement
 * — use icons/emojis rather than letters". The letter code rides along so it is
 * still available for tooltips, inspection evidence and printed reports. */
router.get('/fledge-profile', async (req, res) => {
  // fledge-off (2026-10-26): Fledge is switched off (src/lib/fledge-switch.js).
  if (!(await FS.isFledgeEnabled(getPool()))) return res.json({ framework: 'fledge', disabled: true, count: 0, statements: [] });
  let ICONS = null;
  try { ICONS = require('../../public/js/fledge-profile-icons.js'); } catch (_) {}
  try {
    const { rows } = await getPool().query(`
      SELECT id, statement_code, aspect, statement_text, ordinal
        FROM framework_statements
       WHERE framework = 'fledge' AND area = 'Fledge Profile'
       ORDER BY ordinal, id
    `);
    res.json({
      framework: 'fledge',
      count: rows.length,
      statements: rows.map(r => {
        const m = ICONS && ICONS.byCode(r.statement_code);
        return {
          id: r.id, code: r.statement_code, num: r.ordinal, aspect: r.aspect,
          text: r.statement_text,
          short: m ? m.short : null,
          icons: m ? m.icons : [],
        };
      }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
