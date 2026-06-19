'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const fs = require('fs');
const path = require('path');

const OLLAMA_HOST        = process.env.OLLAMA_HOST        || 'http://localhost:11434';
const OLLAMA_MODEL       = process.env.OLLAMA_MODEL       || 'qwen3.5:4b';
const AI_SUGGESTER_MODEL = process.env.AI_SUGGESTER_MODEL || OLLAMA_MODEL;
const AI_LOG = path.join(__dirname, '../../logs/ai-helper.log');
const { classifyArea } = require('../services/eyfs-area-classifier');

function appendLog(msg) {
  try { fs.appendFileSync(AI_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
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

router.use(authenticate);

const OBS_SELECT = `
  SELECT o.*, c.first_name || ' ' || c.last_name as child_name,
    c.first_name as child_first_name, c.last_name as child_last_name,
    c.room_id as room_id,
    EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth))::int as child_age_months,
    r.name as room_name,
    s.first_name || ' ' || s.last_name as staff_name
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
  if (area) { params.push(`%${area}%`); sql += ` AND o.eyfs_areas::text ILIKE $${params.length}`; }
  if (from) { params.push(from); sql += ` AND o.created_at >= $${params.length}`; }
  if (to) { params.push(to); sql += ` AND o.created_at <= $${params.length}`; }
  if (type) { params.push(type); sql += ` AND o.observation_type=$${params.length}`; }
  if (shared === 'true') sql += ` AND o.shared_with_parents=true`;
  if (search) { params.push(`%${search}%`); sql += ` AND (o.observation_text ILIKE $${params.length} OR o.title ILIKE $${params.length})`; }
  sql += ' ORDER BY o.created_at DESC LIMIT 200';
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
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const VALID_OBS_TAGS = new Set(['planned_activity','tracking','next_step_followup','baseline','termly_update','parental']);

function validateObsTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.filter(t => VALID_OBS_TAGS.has(t));
}

// POST /
router.post('/', async (req, res) => {
  const {
    child_id, observation_text, observation_type, eyfs_areas, subject_areas,
    photo_urls, title, shared_with_parents, next_steps, analysis,
    baseline, planned_activity, termly_update, parental,
    additional_comments, staff_notes, framework_tracker_ids, obs_date,
    obs_tags, client_uuid, dsl_only,
    next_step_framework_statement_id, next_step_due_by, fulfils_next_step_id
  } = req.body;
  if (!child_id || !observation_text)
    return res.status(400).json({ error: 'child_id and observation_text required' });

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
  const cleanTags = validateObsTags(obs_tags || []);

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

  try {
    const { rows } = await db.query(`
      INSERT INTO observations (child_id, staff_id, title, observation_text, observation_type,
        eyfs_areas, subject_areas, photo_urls, shared_with_parents,
        next_steps, analysis, baseline, planned_activity, termly_update, parental,
        additional_comments, staff_notes, linked_framework_ids, obs_tags,
        client_uuid, created_at, updated_at, dsl_only)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$21,
        COALESCE($20::timestamptz, NOW()), NOW(), $22)
      ON CONFLICT (client_uuid) WHERE client_uuid IS NOT NULL DO NOTHING
      RETURNING *
    `, [child_id, req.user.id, title, observation_text,
        observation_type || 'learning_story',
        eyfs_areas || [], subject_areas || [],
        photo_urls || [], shared_with_parents || false,
        next_steps, analysis,
        isBaseline, isPlannedActivity, isTermlyUpdate, isParental,
        additional_comments, staff_notes,
        framework_tracker_ids || [], mergedTags,
        obs_date || null, client_uuid || null, dsl_only || false]);

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
    if (framework_tracker_ids?.length) {
      for (const sid of framework_tracker_ids) {
        try {
          const { rows: stRows } = await db.query(
            'SELECT framework, area, aspect, age_range, statement_text FROM framework_statements WHERE id=$1', [sid]);
          if (!stRows.length) continue;
          const st = stRows[0];
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
                  linked_observation_id=COALESCE($8, framework_tracker.linked_observation_id),
                  assessed_by=$9, assessed_at=NOW(), updated_at=NOW()
          `, [child_id, st.framework, st.area, st.aspect, st.age_range,
              st.statement_text, sid, obs.id, req.user.id]);
        } catch (e) { /* non-fatal: the observation is already saved; tracker link is best-effort */ }
      }
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

    res.status(201).json({ ...obs, next_step_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id
router.put('/:id', async (req, res) => {
  const {
    observation_text, title, eyfs_areas, subject_areas, shared_with_parents,
    photo_urls, next_steps, analysis, baseline, planned_activity,
    termly_update, parental, additional_comments, staff_notes,
    framework_tracker_ids, observation_type
  } = req.body;
  const db = getPool();
  try {
    const { rows } = await db.query(`
      UPDATE observations SET
        observation_text=COALESCE($1,observation_text),
        title=COALESCE($2,title),
        eyfs_areas=COALESCE($3,eyfs_areas),
        subject_areas=COALESCE($4,subject_areas),
        shared_with_parents=COALESCE($5,shared_with_parents),
        photo_urls=COALESCE($6,photo_urls),
        observation_type=COALESCE($7,observation_type),
        next_steps=$8, analysis=$9,
        baseline=COALESCE($10,baseline),
        planned_activity=COALESCE($11,planned_activity),
        termly_update=COALESCE($12,termly_update),
        parental=COALESCE($13,parental),
        additional_comments=$14, staff_notes=$15,
        linked_framework_ids=COALESCE($16,linked_framework_ids),
        updated_at=NOW()
      WHERE id=$17 AND (staff_id=$18 OR $19 IN ('manager','deputy_manager'))
      RETURNING *
    `, [observation_text, title, eyfs_areas, subject_areas,
        shared_with_parents, photo_urls, observation_type,
        next_steps, analysis, baseline, planned_activity,
        termly_update, parental, additional_comments, staff_notes,
        framework_tracker_ids || null,
        req.params.id, req.user.id, req.user.role]);

    if (!rows.length) return res.status(404).json({ error: 'Not found or not authorised' });
    const obs = rows[0];

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
    }

    res.json(obs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id/tags — replace obs_tags array
router.patch('/:id/tags', async (req, res) => {
  const { obs_tags } = req.body;
  if (!Array.isArray(obs_tags)) return res.status(400).json({ error: 'obs_tags must be array' });
  const cleanTags = validateObsTags(obs_tags);
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
router.delete('/:id', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager only' });
  try {
    await getPool().query('DELETE FROM observations WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/share — toggle shared_with_parents
router.post('/:id/share', async (req, res) => {
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
  let sql = 'SELECT id,framework,area,aspect,age_range,statement_code,statement_text,ordinal FROM framework_statements WHERE 1=1';
  if (framework) { params.push(framework); sql += ` AND framework=$${params.length}`; }
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

  const db = getPool();
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

    // Fetch candidates — area-scoped when classifier is confident, broader otherwise
    let candidateSql = `
      SELECT id, framework, area, aspect, age_range, statement_text
      FROM framework_statements
      WHERE framework = ANY($1)
        AND statement_text NOT LIKE '(stub%'
    `;
    const params = [frameworks];

    if (classifiedAreas) {
      params.push(classifiedAreas);
      candidateSql += ` AND area = ANY($${params.length})`;
    }
    if (ageFilter && ageFilter.length) {
      params.push(ageFilter);
      candidateSql += ` AND (age_range = ANY($${params.length}) OR age_range='End of Reception' OR age_range IS NULL)`;
    }
    const fetchLimit = classifiedAreas ? 30 : 50;
    candidateSql += ` ORDER BY framework, ordinal LIMIT ${fetchLimit}`;

    const { rows: candidates } = await db.query(candidateSql, params);
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
  // Returns plausible B25M ranges and DM bands for child's age
  const ranges = [];
  if (months <= 20) ranges.push('Range 1 (Birth to 12 months)', 'Range 2 (8 to 20 months)', 'Birth to 3');
  if (months >= 8 && months <= 30) ranges.push('Range 2 (8 to 20 months)', 'Range 3 (16 to 26 months)', 'Birth to 3');
  if (months >= 16 && months <= 40) ranges.push('Range 3 (16 to 26 months)', 'Range 4 (22 to 36 months)', 'Birth to 3', '3 and 4-year-olds');
  if (months >= 22 && months <= 50) ranges.push('Range 4 (22 to 36 months)', 'Range 5 (30 to 50 months)', '3 and 4-year-olds');
  if (months >= 30 && months <= 65) ranges.push('Range 5 (30 to 50 months)', 'Range 6 (40 to 60+ months)', '3 and 4-year-olds', 'Children in Reception');
  if (months >= 40) ranges.push('Range 6 (40 to 60+ months)', 'Children in Reception');
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
  const timer = setTimeout(() => controller.abort(), 7000);

  const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: AI_SUGGESTER_MODEL, prompt: fullPrompt, stream: false, think: false, options: { temperature: 0 } }),
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
    for (const sid of statement_ids) {
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
// Optional filters: staff_id, room_id, area (EYFS area substring), mine=1 (my key children).
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

// GET /populated-frameworks — which frameworks have ≥10 real (non-stub) statements
router.get('/populated-frameworks', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT framework, COUNT(*) AS n
      FROM framework_statements
      WHERE statement_text NOT ILIKE '%stub%'
      GROUP BY framework
    `);
    const counts = {};
    rows.forEach(r => { counts[r.framework] = parseInt(r.n); });
    res.json({
      eyfs_statutory:      (counts['eyfs_statutory']      || 0) >= 10,
      birth_to_5:          (counts['birth_to_5']          || 0) >= 10,
      development_matters: (counts['development_matters'] || 0) >= 10,
      iters_3:             (counts['iters_3']             || 0) >= 10,
      ecers_3:             (counts['ecers_3']             || 0) >= 10,
      eydj:                (counts['eydj']                || 0) >= 10,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DEPRECATED comment — old B25M endpoint kept for backwards compat
// GET /child/:childId/framework — still functional, see above

// ── Observation photo upload ──────────────────────────────────────────────────
const multer = require('multer');
const OBS_UPLOAD_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'observations')
  : path.join(__dirname, '../../data/ladn/uploads/observations');

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
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  },
});

// POST /upload — observation photo upload (up to 10 files)
router.post('/upload', _obsUpload.array('photos', 10), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded' });
  const urls = req.files.map(f => `/api/observations/photo/${f.filename}`);
  res.json({ urls });
});

// GET /photo/:filename — serve uploaded observation photos
router.get('/photo/:filename', (req, res) => {
  const name = path.basename(req.params.filename); // strip path traversal
  const full = path.join(OBS_UPLOAD_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(full);
});

module.exports = router;
