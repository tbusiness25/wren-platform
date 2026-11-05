'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const NS_SELECT = `
  SELECT ns.*,
    c.first_name || ' ' || c.last_name AS child_name,
    c.first_name AS child_first_name,
    r.name AS room_name,
    s.first_name || ' ' || s.last_name AS staff_name,
    o.observation_text AS source_obs_text,
    o.created_at AS source_obs_date,
    fs.statement_text AS framework_statement_text,
    fs.area AS framework_area,
    pa.plan_date AS planned_date,
    pa.slot AS planned_slot,
    la.name AS library_activity_name
  FROM next_steps ns
  JOIN children c ON c.id = ns.child_id
  LEFT JOIN rooms r ON r.id = c.room_id
  LEFT JOIN staff s ON s.id = ns.staff_id
  LEFT JOIN observations o ON o.id = ns.observation_id
  LEFT JOIN framework_statements fs ON fs.id = ns.framework_statement_id
  LEFT JOIN planned_activities pa ON pa.id = ns.planned_activity_id
  LEFT JOIN curriculum_activities la ON la.id = ns.library_activity_id
`;

// GET / — list with optional child, status, room filters
router.get('/', async (req, res) => {
  const { child_id, status, room_id, limit = 100 } = req.query;
  const db = getPool();
  let sql = NS_SELECT + ' WHERE 1=1';
  const params = [];
  if (child_id) { params.push(child_id);  sql += ` AND ns.child_id=$${params.length}`; }
  if (status)   { params.push(status);    sql += ` AND ns.status=$${params.length}`; }
  if (room_id)  { params.push(room_id);   sql += ` AND r.id=$${params.length}`; }
  params.push(Math.min(parseInt(limit) || 100, 500));
  sql += ` ORDER BY ns.created_at DESC LIMIT $${params.length}`;
  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /by-child/:child_id — all next steps for a child, grouped by status
router.get('/by-child/:child_id', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      NS_SELECT + ' WHERE ns.child_id=$1 ORDER BY ns.status, ns.created_at DESC',
      [req.params.child_id]
    );
    const grouped = { pending: [], planned: [], completed: [], cancelled: [] };
    rows.forEach(r => { (grouped[r.status] || grouped.pending).push(r); });
    res.json(grouped);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /suggestions/:child_id — framework-gap next-step suggestions for a child.
// LADN assesses by COVERAGE: framework_tracker holds only 'observed' statements, so a
// GAP is a Development Matters (birth_to_5_la) statement at the child's working level
// that has NO tracker row yet. We surface the under-evidenced AREAS + sample statements
// so a practitioner can turn a real curriculum gap into a tracked next step.
const PRIMARY_FW = 'birth_to_5_la';
router.get('/suggestions/:child_id', async (req, res) => {
  const db = getPool();
  const childId = parseInt(req.params.child_id);
  if (!childId) return res.status(400).json({ error: 'Invalid child_id' });
  try {
    const { rows: cRows } = await db.query(
      "SELECT id, first_name || ' ' || last_name AS name FROM children WHERE id=$1", [childId]);
    if (!cRows.length) return res.status(404).json({ error: 'Child not found' });

    // Leading level = highest 'Range N' band the child has been observed in, plus its label.
    const { rows: lead } = await db.query(`
      SELECT MAX((substring(age_range from 'Range ([0-9]+)'))::int) AS lvl,
             (array_agg(age_range ORDER BY (substring(age_range from 'Range ([0-9]+)'))::int DESC))[1] AS band
      FROM framework_tracker
      WHERE child_id=$1 AND framework=$2 AND age_range ~ 'Range [0-9]+'`, [childId, PRIMARY_FW]);
    const lvl = lead[0] && lead[0].lvl;

    if (!lvl) {
      return res.json({ child_id: childId, child_name: cRows[0].name,
        has_assessment: false, leading_range: null, leading_band: null,
        total_gaps: 0, areas: [],
        message: 'Not enough framework-tracker data yet to suggest gaps for this child.' });
    }

    // Gaps at the leading band (+ one below, for consolidation), excluding statements
    // already observed OR already captured as an open next step for this child.
    const { rows: areas } = await db.query(`
      WITH gaps AS (
        SELECT fs.id, fs.area, fs.age_range, fs.statement_text,
               (substring(fs.age_range from 'Range ([0-9]+)'))::int AS rng
        FROM framework_statements fs
        WHERE fs.framework=$2
          AND fs.is_active                    -- b332: never suggest a retired statement
          AND fs.age_range ~ 'Range [0-9]+'
          AND (substring(fs.age_range from 'Range ([0-9]+)'))::int BETWEEN GREATEST($3::int-1,1) AND $3::int
          AND fs.id NOT IN (SELECT statement_id FROM framework_tracker
                            WHERE child_id=$1 AND framework=$2 AND statement_id IS NOT NULL)
          AND fs.id NOT IN (SELECT framework_statement_id FROM next_steps
                            WHERE child_id=$1 AND framework_statement_id IS NOT NULL
                              AND status IN ('pending','planned'))
      )
      SELECT area,
             count(*)::int AS gap_count,
             (array_agg(json_build_object('statement_id', id, 'text', statement_text,
                        'age_range', age_range) ORDER BY rng DESC, id))[1:3] AS samples
      FROM gaps GROUP BY area
      ORDER BY gap_count DESC, area`, [childId, PRIMARY_FW, lvl]);

    const total = areas.reduce((s, a) => s + a.gap_count, 0);
    res.json({ child_id: childId, child_name: cRows[0].name, has_assessment: true,
      leading_range: lvl, leading_band: lead[0].band, total_gaps: total, areas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /from-statement — turn a framework gap into a tracked (pending) next step.
router.post('/from-statement', async (req, res) => {
  const { child_id, statement_id, due_by } = req.body;
  if (!child_id || !statement_id)
    return res.status(400).json({ error: 'child_id and statement_id required' });
  const db = getPool();
  try {
    const { rows: st } = await db.query(
      'SELECT id, statement_text, area FROM framework_statements WHERE id=$1', [statement_id]);
    if (!st.length) return res.status(404).json({ error: 'Framework statement not found' });
    // Don't create a duplicate open next step for the same child + statement.
    const { rows: dup } = await db.query(
      "SELECT id FROM next_steps WHERE child_id=$1 AND framework_statement_id=$2 AND status IN ('pending','planned') LIMIT 1",
      [child_id, statement_id]);
    if (dup.length) return res.json({ id: dup[0].id, duplicate: true });
    const desc = `${st[0].area}: ${st[0].statement_text}`;
    const { rows } = await db.query(`
      INSERT INTO next_steps (child_id, staff_id, framework_statement_id, description, status, due_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'pending', $5::date, NOW(), NOW()) RETURNING *`,
      [child_id, req.user.id, statement_id, desc, due_by || null]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — create a free-text next step for a child (child-profile "Add next step").
// Additive: the framework-driven creator is POST /from-statement; this is the manual one.
// b181 (2026-08-19): a next step may now be written straight from the SAME two
// libraries the termly/weekly planner uses — a resource card (continuous
// provision, by slug) or an activity-bank card (curriculum_activities.id). The
// reference is kept so "what provision did we actually put out for this next
// step" stays answerable. Both are optional; the free-text path is unchanged.
router.post('/', async (req, res) => {
  const { child_id, description, due_by, observation_id,
          resource_card_slug, resource_card_title, library_activity_id } = req.body;
  if (!child_id || !description || !String(description).trim())
    return res.status(400).json({ error: 'child_id and description required' });
  const slug = resource_card_slug && /^[a-z0-9-]+$/.test(String(resource_card_slug))
    ? String(resource_card_slug) : null;
  const actId = library_activity_id ? parseInt(library_activity_id, 10) : null;
  try {
    const { rows } = await getPool().query(`
      INSERT INTO next_steps (child_id, staff_id, observation_id, description, status, due_by,
                              resource_card_slug, resource_card_title, library_activity_id,
                              created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'pending', $5::date, $6, $7, $8, NOW(), NOW())
      RETURNING *`,
      [child_id, req.user.id, observation_id || null, String(description).trim(), due_by || null,
       slug, resource_card_title ? String(resource_card_title) : null,
       Number.isInteger(actId) ? actId : null]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The two libraries label their areas DIFFERENTLY: resource-card JSON and
// framework_statements use full area names ('Mathematics'), while
// curriculum_activities.eyfs_areas stores short codes ('MATH'). Without this
// map an ?area=Mathematics filter silently returns zero activities. Accepts
// either form and matches both.
const AREA_ALIASES = [
  ['Communication & Language',                 ['CL', 'C&L', 'COMMUNICATION AND LANGUAGE']],
  ['Physical Development',                     ['PD']],
  ['Personal, Social & Emotional Development', ['PSED', 'PSE']],
  ['Literacy',                                 ['LIT']],
  ['Mathematics',                              ['MATH', 'MATHS', 'M']],
  ['Understanding the World',                  ['UW']],
  ['Expressive Arts & Design',                 ['EAD', 'EA&D']],
];
function areaVariants(area) {
  const want = String(area || '').trim();
  if (!want) return [];
  const up = want.toUpperCase();
  for (const [full, codes] of AREA_ALIASES) {
    if (full.toUpperCase() === up || codes.includes(up)) {
      return [...new Set([full, ...codes])];
    }
  }
  return [want];                                    // unknown area — match it literally
}

// GET /libraries — the two pickers behind ONE call, so the next-steps UI offers
// exactly what the planner offers without duplicating either source of truth.
//   cards      → src/content/resource-cards/*.json (via the resource-cards loader)
//   activities → ladn.curriculum_activities WHERE is_library
// ?q searches card TITLES (not the pre-built haystack, which folds in every
// framework aspect and so matches "shape" on nearly every maths card) and
// activity name/description.
router.get('/libraries', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const area = String(req.query.area || '').trim();
  const variants = areaVariants(area);
  try {
    let cards = [];
    try { cards = require('./resource-cards')._loadCards().index || []; } catch { cards = []; }
    if (area) {
      const upper = variants.map(v => v.toUpperCase());
      cards = cards.filter(c => (c.areas || []).some(a => upper.includes(String(a).toUpperCase())));
    }
    if (q) {
      cards = cards.filter(c =>
        String(c.title || '').toLowerCase().includes(q) ||
        String(c.strapline || '').toLowerCase().includes(q));
    }

    const params = [];
    let sql = `SELECT id, name, description, category, eyfs_areas, age_range
                 FROM curriculum_activities WHERE is_library = true`;
    if (area) { params.push(variants); sql += ` AND eyfs_areas && $${params.length}::text[]`; }
    if (q)    { params.push('%' + q + '%'); sql += ` AND (lower(name) LIKE $${params.length} OR lower(COALESCE(description,'')) LIKE $${params.length})`; }
    sql += ' ORDER BY name LIMIT 500';
    const { rows: activities } = await getPool().query(sql, params);

    // b211 review (2026-08-21): was slice(0, 200), which silently hid 84 of the 284
    // cards from the termly-plan picker. The cap was safe while this endpoint narrowed
    // server-side via ?q/?area, but the sub-aspect picker loads the library once and
    // filters in the browser — so a truncated list means ticking a sub-aspect returns
    // fewer cards than actually exist, with nothing on screen to say so.
    res.json({ cards, activities });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /overview?room_id= — the manager board: coverage, overdue reviews,
// achievements this half-term, stale items. room_id omitted = whole setting.
// NOTE: this must be registered BEFORE GET /:id below — "/overview" is a
// single path segment and would otherwise be swallowed by :id ("overview").
router.get('/overview', async (req, res) => {
  try {
    const db = getPool();
    const roomId = /^\d+$/.test(req.query.room_id || '') ? parseInt(req.query.room_id, 10) : null;
    const limit = await _softLimit(db);
    const staleW = await _staleWeeks(db);

    // "This half-term" — the live termly-update cycle when the term calendar
    // covers today, else the last 6 weeks (the same cadence the duty uses).
    let halfTermFrom = null;
    try {
      const TC = require('../lib/termly-cycle');
      const { cycles } = await TC.loadCycles(db);
      const cur = TC.currentCycle(cycles, TC.ymd(new Date()));
      halfTermFrom = cur ? cur.opens_on : null;
    } catch (_) { /* no term calendar loaded — fall through to the 6-week default */ }
    if (!halfTermFrom) halfTermFrom = new Date(Date.now() - 42 * 86400000).toISOString().slice(0, 10);

    const params = [];
    let roomCond = '';
    if (roomId) { params.push(roomId); roomCond = ` AND c.room_id=$${params.length}`; }

    const { rows: kids } = await db.query(`
      SELECT c.id,
             EXISTS(SELECT 1 FROM next_steps n WHERE n.child_id=c.id
                      AND n.status = ANY($${params.length + 1}::text[]) AND n.closed_at IS NULL) AS has_active,
             EXISTS(SELECT 1 FROM next_steps n WHERE n.child_id=c.id
                      AND n.status = ANY($${params.length + 1}::text[]) AND n.closed_at IS NULL
                      AND n.review_due IS NOT NULL AND n.review_due < CURRENT_DATE) AS overdue_review
        FROM children c
       WHERE c.is_active = true${roomCond}`,
      [...params, ACTIVE_STATUSES]);

    const achievedParams = [...params, halfTermFrom];
    const { rows: achievedRows } = await db.query(
      `SELECT count(*)::int AS n FROM next_steps n JOIN children c ON c.id=n.child_id
        WHERE n.close_reason='achieved' AND n.closed_at >= $${achievedParams.length}::date${roomCond}`,
      achievedParams);

    const staleParams = [...params, ACTIVE_STATUSES, staleW * 7];
    const { rows: staleRows } = await db.query(
      `SELECT count(*)::int AS n FROM next_steps n JOIN children c ON c.id=n.child_id
        WHERE n.status = ANY($${staleParams.length - 1}::text[]) AND n.closed_at IS NULL
          AND COALESCE(n.last_reviewed_at, n.updated_at, n.created_at) < NOW() - ($${staleParams.length}::int * INTERVAL '1 day')
          ${roomCond}`,
      staleParams);

    const total = kids.length;
    const withActive = kids.filter(k => k.has_active).length;
    res.json({
      room_id: roomId, soft_limit: limit, stale_weeks: staleW,
      children_total: total,
      children_with_active: withActive,
      children_with_active_pct: total ? Math.round(100 * withActive / total) : null,
      overdue_reviews: kids.filter(k => k.overdue_review).length,
      achieved_this_half_term: achievedRows[0].n,
      stale_items: staleRows[0].n,
      half_term_from: halfTermFrom,
      // Per child, for "My key children"-style flags — cheap to carry since
      // the query above already computed both booleans per child.
      children: kids.map(k => ({ id: k.id, has_active: k.has_active, overdue_review: k.overdue_review })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(NS_SELECT + ' WHERE ns.id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id — update status, framework link, due date
router.patch('/:id', async (req, res) => {
  const { status, framework_statement_id, due_by, description,
          resource_card_slug, resource_card_title, library_activity_id,
          // b393 (2026-10-05) — the new lifecycle columns, alongside the old fields above.
          review_due, parent_visible } = req.body; // b181
  const VALID = new Set(['pending','planned','completed','cancelled']);
  if (status && !VALID.has(status)) return res.status(400).json({ error: 'Invalid status' });
  const _slug = resource_card_slug && /^[a-z0-9-]+$/.test(String(resource_card_slug))
    ? String(resource_card_slug) : null;
  const _actId = library_activity_id ? parseInt(library_activity_id, 10) : null;
  const _reviewDue = /^\d{4}-\d{2}-\d{2}$/.test(review_due || '') ? review_due : null;
  try {
    const { rows } = await getPool().query(`
      UPDATE next_steps SET
        status                 = COALESCE($1, status),
        framework_statement_id = COALESCE($2, framework_statement_id),
        due_by                 = COALESCE($3::date, due_by),
        description            = COALESCE($4, description),
        resource_card_slug     = COALESCE($6, resource_card_slug),
        resource_card_title    = COALESCE($7, resource_card_title),
        library_activity_id    = COALESCE($8, library_activity_id),
        review_due             = COALESCE($9::date, review_due),
        parent_visible         = COALESCE($10, parent_visible),
        updated_at             = NOW()
      WHERE id=$5
      RETURNING *
    `, [status || null, framework_statement_id || null,
        due_by || null, description || null,
        req.params.id,
        _slug, resource_card_title ? String(resource_card_title) : null,
        Number.isInteger(_actId) ? _actId : null,
        _reviewDue, typeof parent_visible === 'boolean' ? parent_visible : null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/promote-to-activity — convert next_step → planned_activity (scope=individual)
router.post('/:id/promote-to-activity', async (req, res) => {
  const { plan_date, slot, led_by } = req.body;
  const db = getPool();
  try {
    const { rows: nsRows } = await db.query('SELECT * FROM next_steps WHERE id=$1', [req.params.id]);
    if (!nsRows.length) return res.status(404).json({ error: 'Next step not found' });
    const ns = nsRows[0];
    if (ns.status === 'completed' || ns.status === 'cancelled')
      return res.status(400).json({ error: `Cannot promote a ${ns.status} next step` });

    const { rows: paRows } = await db.query(`
      INSERT INTO planned_activities
        (child_id, next_step_id, source_observation_id, scope, plan_date, slot, led_by,
         title, description, status, created_at)
      VALUES ($1, $2, $3, 'individual', $4, $5, $6, $7, $8, 'planned', NOW())
      RETURNING *
    `, [ns.child_id, ns.id, ns.observation_id,
        plan_date || null, slot || null, led_by || req.user.id,
        ns.description,
        `Individual activity from next step: ${ns.description.slice(0, 100)}`]);

    const pa = paRows[0];

    // Link back to next_step and mark as planned
    await db.query(`
      UPDATE next_steps
        SET status='planned', planned_activity_id=$1, updated_at=NOW()
      WHERE id=$2
    `, [pa.id, ns.id]);

    res.status(201).json({ planned_activity: pa, next_step_id: ns.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/mark-completed — link to an observation that evidences completion
router.post('/:id/mark-completed', async (req, res) => {
  const { completed_observation_id } = req.body;
  try {
    const { rows } = await getPool().query(`
      UPDATE next_steps
        SET status='completed',
            completed_observation_id=$1,
            updated_at=NOW()
      WHERE id=$2
      RETURNING *
    `, [completed_observation_id || null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b393 (2026-10-05) — the lifecycle: active / achieved / parked / retired
//
// Existing statuses keep meaning what they always meant (pending/open/planned
// = active, completed = achieved, cancelled = closed-but-not-achieved).
// close_reason is the new thing: it is what tells a parked next step apart
// from a retired one, both of which land on status='cancelled'. See
// wren-docs/decisions/2026-10-05-next-steps-system.md.
// ═══════════════════════════════════════════════════════════════════════════
const ACTIVE_STATUSES = ['pending', 'open', 'planned'];
const NS_LEAD_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'room_leader', 'senior_practitioner']);

/** Manager/deputy/room-leader may act on any child; everyone else only on their own room. */
async function _mayActOnChild(db, user, childId) {
  if (!user) return false;
  if (NS_LEAD_ROLES.has(user.role)) return true;
  const { rows } = await db.query('SELECT room_id FROM children WHERE id=$1', [childId]);
  if (!rows.length) return false;
  // Release port (17 Oct 2026): not every token carries room_id (Google / Wren ID sign-ins mint one without it),
  // so fall back to the staff row instead of refusing a practitioner their own room's child.
  let userRoom = user.room_id;
  if (userRoom == null && user.id != null) {
    try { const r = await db.query('SELECT room_id FROM staff WHERE id=$1', [user.id]); userRoom = r.rows[0] && r.rows[0].room_id; } catch (_) {}
  }
  return rows[0].room_id != null && userRoom != null && Number(rows[0].room_id) === Number(userRoom);
}

async function _settingInt(db, key, fallback) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
    const n = rows.length ? parseInt(rows[0].value, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch { return fallback; }
}
const _softLimit   = db => _settingInt(db, 'next_steps_soft_limit', 3);
const _staleWeeks  = db => _settingInt(db, 'next_steps_stale_weeks', 12);

async function _loadOwned(db, id) {
  const { rows } = await db.query('SELECT id, child_id, status, close_reason FROM next_steps WHERE id=$1', [id]);
  return rows[0] || null;
}

// POST /:id/achieved — "Seen it ✓": close with evidence, optionally the
// observation that showed it.
router.post('/:id/achieved', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const ns = await _loadOwned(db, id);
    if (!ns) return res.status(404).json({ error: 'Not found' });
    if (!await _mayActOnChild(db, req.user, ns.child_id)) return res.status(403).json({ error: 'Not your room' });
    const { observation_id, note } = req.body || {};
    const { rows } = await db.query(`
      UPDATE next_steps SET
        status='completed', close_reason='achieved',
        closed_at=NOW(), closed_by=$1,
        completed_observation_id=COALESCE($2::int, completed_observation_id),
        evidence_note=COALESCE($3, evidence_note),
        updated_at=NOW()
      WHERE id=$4 RETURNING *`,
      [req.user.id, observation_id || null, note ? String(note).trim().slice(0, 2000) : null, id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/park — "Not now": paused, revisited at the next half-term review.
router.post('/:id/park', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const ns = await _loadOwned(db, id);
    if (!ns) return res.status(404).json({ error: 'Not found' });
    if (!await _mayActOnChild(db, req.user, ns.child_id)) return res.status(403).json({ error: 'Not your room' });
    const { note } = req.body || {};
    const { rows } = await db.query(`
      UPDATE next_steps SET
        status='cancelled', close_reason='parked',
        closed_at=NOW(), closed_by=$1,
        evidence_note=COALESCE($2, evidence_note),
        updated_at=NOW()
      WHERE id=$3 RETURNING *`,
      [req.user.id, note ? String(note).trim().slice(0, 2000) : null, id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/retire — stale or superseded, closed for good (not revisited).
router.post('/:id/retire', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const ns = await _loadOwned(db, id);
    if (!ns) return res.status(404).json({ error: 'Not found' });
    if (!await _mayActOnChild(db, req.user, ns.child_id)) return res.status(403).json({ error: 'Not your room' });
    const reason = (req.body && req.body.superseded) ? 'superseded' : 'retired';
    const { note } = req.body || {};
    const { rows } = await db.query(`
      UPDATE next_steps SET
        status='cancelled', close_reason=$1,
        closed_at=NOW(), closed_by=$2,
        evidence_note=COALESCE($3, evidence_note),
        updated_at=NOW()
      WHERE id=$4 RETURNING *`,
      [reason, req.user.id, note ? String(note).trim().slice(0, 2000) : null, id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/carry-forward — keep working on it (un-parking it if it was
// parked), and push the review date out. This is the half-term review's
// "still relevant" answer.
router.post('/:id/carry-forward', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const ns = await _loadOwned(db, id);
    if (!ns) return res.status(404).json({ error: 'Not found' });
    if (!await _mayActOnChild(db, req.user, ns.child_id)) return res.status(403).json({ error: 'Not your room' });
    const reviewDue = /^\d{4}-\d{2}-\d{2}$/.test((req.body && req.body.review_due) || '') ? req.body.review_due : null;
    const wasParked = ns.status === 'cancelled' && ns.close_reason === 'parked';
    const { rows } = await db.query(`
      UPDATE next_steps SET
        status       = CASE WHEN $1 THEN 'pending' ELSE status END,
        closed_at    = CASE WHEN $1 THEN NULL ELSE closed_at END,
        close_reason = CASE WHEN $1 THEN NULL ELSE close_reason END,
        review_due       = COALESCE($2::date, review_due),
        last_reviewed_at = NOW(),
        updated_at       = NOW()
      WHERE id=$3 RETURNING *`,
      [wasParked, reviewDue, id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/active — the "Working on now" set, with the soft-limit warning.
router.get('/child/:childId/active', async (req, res) => {
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'Invalid child_id' });
  try {
    const db = getPool();
    const limit = await _softLimit(db);
    const { rows } = await db.query(
      NS_SELECT + ` WHERE ns.child_id=$1 AND ns.status = ANY($2::text[]) AND ns.closed_at IS NULL
                    ORDER BY ns.review_due ASC NULLS LAST, ns.created_at DESC`,
      [childId, ACTIVE_STATUSES]);
    res.json({
      child_id: childId, soft_limit: limit,
      count: rows.length, over_limit: rows.length > limit,
      items: rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
