'use strict';
/*
 * b218 (2026-08-24) — Areas of responsibility.
 *
 *   /api/areas/...
 *
 * Three things, in order of how they are used across a half-term:
 *
 *   1 · OWNERSHIP    a manager gives each practitioner one of the seven EYFS
 *                    areas. An area may be shared; nobody is forced to have one.
 *   2 · CONTRIBUTION each half-term the owner writes what they have noticed in
 *                    that area, what they would change, and their ideas. Stored
 *                    per (staff, area, half-term) so it builds a history.
 *   3 · INTENTIONS   at the end of the half-term Wren GATHERS every current next
 *                    step across all children, groups it, ranks it, and hands the
 *                    owner a pre-written list to TICK. What they tick becomes the
 *                    next half-term's intentions, and each one keeps the next
 *                    steps it came from, so it traces back to real observations.
 *
 * Nothing here writes to the supervision or CPD modules, and nothing here edits
 * term_plans — the termly plan reads carried-in intentions, it does not own them.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const CAL = require('../lib/school-calendar');
const G = require('../lib/area-gather');
const { operationalChildFilter, ensureEnrolmentMiddleware } = require('../utils/enrolment');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);
router.use(ensureEnrolmentMiddleware(getPool));

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher'];
const PLAN_ROLES    = ['manager', 'deputy_manager', 'admin', 'headteacher', 'room_leader', 'practitioner'];

function isManager(req) { return hasRole(req.user, MANAGER_ROLES); }
function requireManager(req, res) {
  if (isManager(req)) return true;
  res.status(403).json({ error: 'Only a manager can change areas of responsibility' });
  return false;
}

// The live seven. Read from the setting's ACTIVE framework rather than hard-coded,
// because a setting can adopt its own curriculum (b180) — but mapped through the
// canonical names so 'PSED' and the spelt-out version are never two areas. The
// framework's own profile/summary block ('Fledge Profile') is not an area.
async function settingAreas(db) {
  try {
    const { rows: fwRows } = await db.query(
      `SELECT value FROM settings WHERE key = 'default_framework' LIMIT 1`);
    // fledge-off (2026-10-26): was `|| 'fledge'`. The switch now decides — no row, or a
    // row still saying 'fledge' while Fledge is off, both read as Birth to 5 Matters.
    void fwRows;
    const framework = await require('../lib/fledge-switch').effectiveDefaultFramework(db);
    const { rows } = await db.query(
      // b332 — is_active keeps a retired block ('Fledge Profile') out of the
      // seven, which is what the comment above always intended.
      `SELECT DISTINCT area FROM framework_statements WHERE framework = $1 AND is_active`, [framework]);
    const found = rows.map(r => G.canonicalArea(r.area)).filter(Boolean);
    const uniq = G.AREAS.filter(a => found.includes(a));
    return uniq.length ? uniq : G.AREAS;
  } catch {
    return G.AREAS;
  }
}

// ── Periods ──────────────────────────────────────────────────────────────────
// A half-term (ladn.school_terms, b217) is the planning period. Where a setting
// has no calendar seeded we fall back to funding periods so nothing 500s, and
// period_kind records which one a row belongs to so their ids can never collide.
async function resolvePeriod(db, q) {
  const htId = parseInt(q.half_term_id, 10);
  if (Number.isInteger(htId)) {
    const ht = await CAL.loadHalfTermById(db, htId);
    if (ht) return { kind: 'half_term', id: ht.id, name: ht.name,
                     academic_year: ht.academic_year,
                     start_date: ht.start_date, end_date: ht.end_date };
  }
  const tId = parseInt(q.term_id, 10);
  if (Number.isInteger(tId)) {
    const { rows } = await db.query(
      `SELECT id, name, year, start_date, end_date FROM funding_terms WHERE id = $1`, [tId]);
    if (rows[0]) return { kind: 'funding', id: rows[0].id, name: rows[0].name,
                          academic_year: String(rows[0].year || ''),
                          start_date: rows[0].start_date, end_date: rows[0].end_date };
  }
  return null;
}

function ymd(d) {
  if (!d) return null;
  return typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
}

// ─── GET /context ────────────────────────────────────────────────────────────
// Everything a page needs to render before the user touches anything: the seven
// areas, the half-terms, where we are in the year, and the caller's own area.
router.get('/context', async (req, res) => {
  try {
    const db = getPool();
    const today = CAL.cleanYmd(req.query.date, CAL.todayYmd());
    const [areas, cal] = await Promise.all([settingAreas(db), CAL.loadCalendar(db, null)]);
    const day = CAL.resolveDay(today, cal.terms, cal.breaks);

    // The half-term whose next steps we gather FROM: the one we are in, or the
    // one that has just ended if today falls in a break.
    const gatherFrom = day.half_term || day.previous_half_term || null;
    // …and the one intentions are FOR: the next one.
    const gatherFor  = day.half_term && day.next_half_term ? day.next_half_term
                     : (day.next_half_term || day.half_term || null);

    const { rows: mine } = await db.query(
      `SELECT r.id, r.area, r.assigned_at, r.notes,
              a.first_name || ' ' || a.last_name AS assigned_by_name
         FROM staff_area_responsibilities r
         LEFT JOIN staff a ON a.id = r.assigned_by
        WHERE r.staff_id = $1 AND r.ended_at IS NULL
        LIMIT 1`, [req.user.id]);

    res.json({
      today,
      areas,
      sub_areas: G.ASPECTS_BY_AREA,
      half_terms: cal.terms,
      day,
      gather_from: gatherFrom,
      gather_for: gatherFor,
      my_area: mine[0] || null,
      can_assign: isManager(req),
      can_pick: hasRole(req.user, PLAN_ROLES),
      user: { id: req.user.id, role: req.user.role },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /owners ─────────────────────────────────────────────────────────────
// The seven areas, who owns each, and whether that owner has written this
// period's contribution yet. One call for the manager overview.
router.get('/owners', async (req, res) => {
  try {
    const db = getPool();
    const areas = await settingAreas(db);
    const period = await resolvePeriod(db, req.query);

    const { rows: owners } = await db.query(
      `SELECT r.id, r.area, r.staff_id, r.assigned_at, r.notes,
              s.first_name, s.last_name, s.role, s.room_id, rm.name AS room_name
         FROM staff_area_responsibilities r
         JOIN staff s ON s.id = r.staff_id AND s.is_active = true
         LEFT JOIN rooms rm ON rm.id = s.room_id
        WHERE r.ended_at IS NULL
        ORDER BY r.area, s.first_name`);

    let contribs = [];
    if (period) {
      const { rows } = await db.query(
        `SELECT area, staff_id, submitted_at, updated_at,
                (COALESCE(btrim(noticed),'') <> '' OR COALESCE(btrim(would_change),'') <> ''
                 OR COALESCE(btrim(ideas),'') <> '') AS has_content
           FROM area_contributions
          WHERE half_term_id = $1 AND period_kind = $2`, [period.id, period.kind]);
      contribs = rows;
    }
    const cKey = (a, s) => `${a}|${s}`;
    const cMap = new Map(contribs.map(c => [cKey(c.area, c.staff_id), c]));

    // Adopted intentions per area for this period — "has this area been picked yet".
    let intentionCounts = [];
    if (period) {
      const { rows } = await db.query(
        `SELECT area, count(*)::int AS n, sum(child_count)::int AS children
           FROM area_intentions
          WHERE half_term_id = $1 AND period_kind = $2 AND status = 'active'
          GROUP BY area`, [period.id, period.kind]);
      intentionCounts = rows;
    }
    const iMap = new Map(intentionCounts.map(r => [r.area, r]));

    res.json({
      period,
      areas: areas.map(area => {
        const mine = owners.filter(o => o.area === area);
        const ic = iMap.get(area);
        return {
          area,
          sub_areas: G.ASPECTS_BY_AREA[area] || [],
          owners: mine.map(o => {
            const c = cMap.get(cKey(area, o.staff_id));
            return {
              responsibility_id: o.id,
              staff_id: o.staff_id,
              name: `${o.first_name} ${o.last_name}`.trim(),
              role: o.role,
              room_name: o.room_name,
              assigned_at: o.assigned_at,
              notes: o.notes,
              contribution_written: !!(c && c.has_content),
              contribution_submitted_at: c ? c.submitted_at : null,
            };
          }),
          intentions_adopted: ic ? ic.n : 0,
          intention_children: ic ? ic.children : 0,
        };
      }),
      unassigned_staff_note: 'Nobody is forced to have an area — an area with no owner is simply unclaimed.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /staff/:id ──────────────────────────────────────────────────────────
// One staff member's area, for the Roost staff record. History included so a
// change of ownership is answerable later.
router.get('/staff/:id', async (req, res) => {
  const staffId = parseInt(req.params.id, 10);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'Invalid staff id' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT r.id, r.area, r.notes, r.assigned_at, r.ended_at,
              a.first_name || ' ' || a.last_name AS assigned_by_name
         FROM staff_area_responsibilities r
         LEFT JOIN staff a ON a.id = r.assigned_by
        WHERE r.staff_id = $1
        ORDER BY r.ended_at NULLS FIRST, r.assigned_at DESC`, [staffId]);
    const current = rows.find(r => !r.ended_at) || null;
    res.json({
      staff_id: staffId,
      current,
      history: rows.filter(r => r.ended_at),
      areas: await settingAreas(db),
      can_assign: isManager(req),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /assign ────────────────────────────────────────────────────────────
// One area each: an existing open row is ENDED (not deleted) before the new one
// opens, so the partial unique index holds and last term's owner is still on file.
router.post('/assign', async (req, res) => {
  if (!requireManager(req, res)) return;
  const staffId = parseInt(req.body.staff_id, 10);
  const area = G.canonicalArea(req.body.area);
  const notes = req.body.notes == null ? null : String(req.body.notes).trim() || null;
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'staff_id required' });
  if (!area) return res.status(400).json({ error: 'area must be one of the seven EYFS areas' });
  try {
    const db = getPool();
    const valid = await settingAreas(db);
    if (!valid.includes(area)) return res.status(400).json({ error: `Unknown area: ${area}` });
    const { rows: st } = await db.query(
      `SELECT id, first_name, last_name FROM staff WHERE id = $1 AND is_active = true`, [staffId]);
    if (!st.length) return res.status(404).json({ error: 'Staff member not found or inactive' });

    const { rows: existing } = await db.query(
      `SELECT id, area FROM staff_area_responsibilities WHERE staff_id = $1 AND ended_at IS NULL`,
      [staffId]);
    if (existing.length && existing[0].area === area) {
      const { rows } = await db.query(
        `UPDATE staff_area_responsibilities SET notes = $2, updated_at = now()
          WHERE id = $1 RETURNING *`, [existing[0].id, notes]);
      return res.json({ ...rows[0], unchanged_area: true });
    }
    if (existing.length) {
      await db.query(
        `UPDATE staff_area_responsibilities SET ended_at = now(), ended_by = $2, updated_at = now()
          WHERE id = $1`, [existing[0].id, req.user.id || null]);
    }
    const { rows } = await db.query(
      `INSERT INTO staff_area_responsibilities (staff_id, area, notes, assigned_by)
       VALUES ($1,$2,$3,$4) RETURNING *`, [staffId, area, notes, req.user.id || null]);
    res.status(201).json({ ...rows[0], replaced: existing.length ? existing[0].area : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /unassign ──────────────────────────────────────────────────────────
router.post('/unassign', async (req, res) => {
  if (!requireManager(req, res)) return;
  const staffId = parseInt(req.body.staff_id, 10);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'staff_id required' });
  try {
    const { rows } = await getPool().query(
      `UPDATE staff_area_responsibilities
          SET ended_at = now(), ended_by = $2, updated_at = now()
        WHERE staff_id = $1 AND ended_at IS NULL
        RETURNING id, area`, [staffId, req.user.id || null]);
    res.json({ ok: true, ended: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /contributions ──────────────────────────────────────────────────────
// ?area= and/or ?staff_id= and/or ?half_term_id=. With no half_term_id it
// returns the whole history for the filter, newest half-term first — that is the
// "what have we said about this area across the year" view.
router.get('/contributions', async (req, res) => {
  try {
    const db = getPool();
    const params = [];
    let sql = `
      SELECT ac.*, s.first_name, s.last_name, s.role,
             st.name AS half_term_name, st.start_date, st.end_date, st.academic_year AS ht_year
        FROM area_contributions ac
        JOIN staff s ON s.id = ac.staff_id
        LEFT JOIN school_terms st ON st.id = ac.half_term_id AND ac.period_kind = 'half_term'
       WHERE 1=1`;
    const area = G.canonicalArea(req.query.area);
    if (req.query.area && !area) return res.status(400).json({ error: 'Unknown area' });
    if (area)               { params.push(area);            sql += ` AND ac.area = $${params.length}`; }
    if (req.query.staff_id) { params.push(parseInt(req.query.staff_id, 10)); sql += ` AND ac.staff_id = $${params.length}`; }
    if (req.query.half_term_id) { params.push(parseInt(req.query.half_term_id, 10)); sql += ` AND ac.half_term_id = $${params.length}`; }
    sql += ` ORDER BY COALESCE(st.start_date, ac.created_at::date) DESC, ac.area, s.first_name`;
    const { rows } = await db.query(sql, params);
    res.json(rows.map(r => ({ ...r, staff_name: `${r.first_name} ${r.last_name}`.trim() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /contribution ───────────────────────────────────────────────────────
// Your own contribution for (your area, this half-term). A manager may write one
// for somebody else (they cover for staff who are off) — anyone else may not.
router.put('/contribution', async (req, res) => {
  try {
    const db = getPool();
    const period = await resolvePeriod(db, req.body);
    if (!period) return res.status(400).json({ error: 'half_term_id required' });
    const staffId = req.body.staff_id ? parseInt(req.body.staff_id, 10) : req.user.id;
    if (staffId !== req.user.id && !isManager(req)) {
      return res.status(403).json({ error: 'You can only write your own contribution' });
    }
    // The area defaults to whatever this person owns — the whole point is that
    // they are not asked to choose one every half-term.
    let area = G.canonicalArea(req.body.area);
    if (!area) {
      const { rows } = await db.query(
        `SELECT area FROM staff_area_responsibilities WHERE staff_id = $1 AND ended_at IS NULL LIMIT 1`,
        [staffId]);
      area = rows.length ? rows[0].area : null;
    }
    if (!area) return res.status(400).json({ error: 'No area of responsibility set for this staff member' });

    const txt = v => (v == null ? null : String(v).trim() || null);
    const noticed = txt(req.body.noticed), change = txt(req.body.would_change), ideas = txt(req.body.ideas);
    const anything = !!(noticed || change || ideas);

    const { rows } = await db.query(
      `INSERT INTO area_contributions
         (area, staff_id, half_term_id, period_kind, term_name, academic_year,
          noticed, would_change, ideas, submitted_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10 THEN now() ELSE NULL END, now())
       ON CONFLICT (staff_id, area, half_term_id, period_kind) DO UPDATE SET
         noticed      = EXCLUDED.noticed,
         would_change = EXCLUDED.would_change,
         ideas        = EXCLUDED.ideas,
         term_name    = EXCLUDED.term_name,
         academic_year= EXCLUDED.academic_year,
         submitted_at = CASE WHEN $10 THEN COALESCE(area_contributions.submitted_at, now()) ELSE NULL END,
         updated_at   = now()
       RETURNING *`,
      [area, staffId, period.id, period.kind, period.name, period.academic_year,
       noticed, change, ideas, anything]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// GATHERING — the important bit
// ═══════════════════════════════════════════════════════════════════════════
// Two real sources of "a child's next step", both of which exist in Wren:
//
//   A · ladn.next_steps           the tracked ones (pending / planned / open)
//   B · ladn.observations.next_steps  the free text a practitioner wrote at the
//                                 bottom of an observation and never promoted
//
// B is skipped where a next_steps row already points at that observation, so a
// promoted next step is never counted twice.
//
// ⚠️ b183: a GROUP observation is one piece of practice about several children.
// Recurrence counts distinct occurrences (group_uuid where there is one), while
// "children served" counts distinct child_ids. Counting rows for both would make
// group work look like ten separate pieces of evidence.

const OPEN_STATUSES = ['pending', 'planned', 'open'];

async function gather(db, opts) {
  const roomId = Number.isInteger(opts.roomId) ? opts.roomId : null;
  const params = [OPEN_STATUSES];
  let roomSqlA = '';
  if (roomId) { params.push(roomId); roomSqlA = ` AND c.room_id = $${params.length}`; }

  const { rows: tracked } = await db.query(`
    SELECT ns.id AS next_step_id, ns.child_id, ns.description AS text, ns.created_at,
           ns.status, ns.observation_id, ns.framework_statement_id,
           fs.area AS fw_area, fs.sub_area AS fw_sub_area,
           o.eyfs_areas AS obs_areas, o.group_uuid,
           c.first_name, c.last_name, c.room_id, rm.name AS room_name
      FROM next_steps ns
      JOIN children c ON c.id = ns.child_id
      LEFT JOIN rooms rm ON rm.id = c.room_id
      LEFT JOIN framework_statements fs ON fs.id = ns.framework_statement_id
      LEFT JOIN observations o ON o.id = ns.observation_id
     WHERE ns.status = ANY($1::text[])
       AND ${operationalChildFilter('c')}
       ${roomSqlA}
     ORDER BY ns.created_at DESC`, params);

  const params2 = [opts.from, opts.to];
  let roomSqlB = '';
  if (roomId) { params2.push(roomId); roomSqlB = ` AND c.room_id = $${params2.length}`; }

  const { rows: embedded } = await db.query(`
    SELECT o.id AS observation_id, o.child_id, o.next_steps AS text, o.created_at,
           o.eyfs_areas AS obs_areas, o.group_uuid,
           fs.area AS fw_area, fs.sub_area AS fw_sub_area,
           c.first_name, c.last_name, c.room_id, rm.name AS room_name
      FROM observations o
      JOIN children c ON c.id = o.child_id
      LEFT JOIN rooms rm ON rm.id = c.room_id
      LEFT JOIN framework_statements fs
             ON fs.id = (CASE WHEN array_length(o.linked_framework_ids,1) > 0
                              THEN o.linked_framework_ids[1] END)
     WHERE o.next_steps IS NOT NULL AND btrim(o.next_steps) <> ''
       AND COALESCE(o.review_status,'published') = 'published'
       AND o.created_at >= $1::date AND o.created_at < ($2::date + interval '1 day')
       AND NOT EXISTS (SELECT 1 FROM next_steps ns2 WHERE ns2.observation_id = o.id)
       AND ${operationalChildFilter('c')}
       ${roomSqlB}
     ORDER BY o.created_at DESC`, params2);

  // Child names come out of the text before clustering: the same intention
  // written about six children must land in ONE row, and a name must never end
  // up inside an intention that is about to be shown to the whole room.
  const { rows: nameRows } = await db.query(
    `SELECT DISTINCT lower(first_name) AS n FROM children WHERE first_name IS NOT NULL`);
  const nameSet = new Set(nameRows.map(r => r.n).filter(n => n && n.length > 1));

  const items = [];
  for (const r of tracked) {
    items.push(Object.assign({}, r, {
      kind: 'next_step',
      occurrence_key: r.group_uuid ? `g:${r.group_uuid}` : `ns:${r.next_step_id}`,
    }));
  }
  for (const r of embedded) {
    items.push(Object.assign({}, r, {
      kind: 'observation_next_step',
      next_step_id: null,
      occurrence_key: r.group_uuid ? `g:${r.group_uuid}` : `obs:${r.observation_id}`,
    }));
  }

  for (const it of items) {
    const c = G.classify(it.text, {
      frameworkArea: it.fw_area, frameworkSubArea: it.fw_sub_area, obsAreas: it.obs_areas || [],
    });
    it.area = c.area; it.sub_area = c.sub_area; it.via = c.via;
  }
  return { items, nameSet, counts: { tracked: tracked.length, embedded: embedded.length } };
}

/** Turn classified items for ONE area into ranked, pre-written intentions. */
function buildIntentions(areaItems, area, nameSet) {
  const clusters = G.cluster(areaItems, nameSet);
  const out = clusters.map(c => {
    const children = new Map();
    const rooms = new Map();
    const occ = new Set();
    const subCounts = new Map();
    let latest = null;
    for (const it of c.items) {
      if (!children.has(it.child_id)) {
        children.set(it.child_id, {
          child_id: it.child_id,
          name: `${it.first_name || ''} ${it.last_name || ''}`.trim(),
          room_id: it.room_id, room_name: it.room_name,
        });
      }
      const rk = it.room_id || 0;
      if (!rooms.has(rk)) rooms.set(rk, { room_id: it.room_id, room_name: it.room_name || 'No room', children: new Set() });
      rooms.get(rk).children.add(it.child_id);
      occ.add(it.occurrence_key);
      if (it.sub_area) subCounts.set(it.sub_area, (subCounts.get(it.sub_area) || 0) + 1);
      const d = it.created_at ? new Date(it.created_at).getTime() : 0;
      if (!latest || d > latest) latest = d;
    }
    const subArea = [...subCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const roomList = [...rooms.values()]
      .map(r => ({ room_id: r.room_id, room_name: r.room_name, child_count: r.children.size }))
      .sort((a, b) => b.child_count - a.child_count);
    const childList = [...children.values()];
    const text = G.intentionTextFor(c.items, nameSet, childList.length);

    return {
      cluster_key: G.clusterKey(area, c.tokens),
      area,
      sub_area: subArea ? subArea[0] : null,
      intention_text: text,
      child_count: childList.length,
      children: childList,
      rooms: roomList,
      recurrence: occ.size,
      is_group: childList.length > 1,
      last_seen: latest ? new Date(latest).toISOString() : null,
      via: [...new Set(c.items.map(i => i.via))],
      variants: [...new Set(c.items.map(i => String(i.text || '').trim()))].slice(0, 8),
      rationale: `${childList.length} ${childList.length === 1 ? 'child' : 'children'} · ` +
                 `${occ.size} separate ${occ.size === 1 ? 'observation/next step' : 'observations or next steps'}` +
                 (roomList.length ? ` · ${roomList.map(r => `${r.room_name} (${r.child_count})`).join(', ')}` : ''),
      sources: c.items.map(i => ({
        kind: i.kind,
        next_step_id: i.next_step_id || null,
        observation_id: i.observation_id || null,
        child_id: i.child_id,
        child_name: `${i.first_name || ''} ${i.last_name || ''}`.trim(),
        text: String(i.text || '').trim(),
        created_at: i.created_at,
      })),
    };
  }).filter(i => i.intention_text);

  // Ranked the way a practitioner would rank it: what serves the most children
  // first, then what keeps coming up, then what is freshest.
  out.sort((a, b) => b.child_count - a.child_count
                  || b.recurrence - a.recurrence
                  || String(b.last_seen || '').localeCompare(String(a.last_seen || '')));
  return out;
}

// ─── GET /gathered ───────────────────────────────────────────────────────────
// ?area=            one of the seven (omit for every area, summary only)
// ?half_term_id=    the half-term the next steps come FROM (defaults to the one
//                   we are in, or the one that has just ended)
// ?for_half_term_id= the half-term the intentions are FOR (used to mark which
//                   candidates have already been adopted)
// ?room_id=         narrow to one playroom
// ?from= &to=       override the observation window (YYYY-MM-DD)
router.get('/gathered', async (req, res) => {
  try {
    const db = getPool();
    const cal = await CAL.loadCalendar(db, null);
    const today = CAL.cleanYmd(req.query.date, CAL.todayYmd());
    const day = CAL.resolveDay(today, cal.terms, cal.breaks);

    let period = await resolvePeriod(db, req.query);
    if (!period) {
      const ht = day.half_term || day.previous_half_term;
      if (ht) period = { kind: 'half_term', id: ht.id, name: ht.name,
                         academic_year: ht.academic_year,
                         start_date: ht.start_date, end_date: ht.end_date };
    }

    // The window for source B (free-text next steps inside observations). A
    // half-term that has not started yet has no observations in it, so fall back
    // to the previous 120 days rather than returning an empty, misleading list.
    let from = CAL.cleanYmd(req.query.from);
    let to   = CAL.cleanYmd(req.query.to);
    let windowReason = 'explicit';
    if (!from || !to) {
      if (period && ymd(period.start_date) <= today) {
        from = ymd(period.start_date);
        to = ymd(period.end_date) < today ? ymd(period.end_date) : today;
        windowReason = 'half_term';
      } else {
        to = today;
        from = CAL.addDays(today, -120);
        windowReason = 'last_120_days';
      }
    }

    const roomId = parseInt(req.query.room_id, 10);
    const { items, nameSet, counts } = await gather(db, {
      from, to, roomId: Number.isInteger(roomId) ? roomId : null,
    });

    const areas = await settingAreas(db);
    const wanted = G.canonicalArea(req.query.area);
    if (req.query.area && !wanted) return res.status(400).json({ error: 'Unknown area' });

    // Which candidates have already been ticked for the target half-term?
    const target = req.query.for_half_term_id
      ? await resolvePeriod(db, { half_term_id: req.query.for_half_term_id })
      : null;
    let adopted = new Set();
    if (target) {
      const { rows } = await db.query(
        `SELECT cluster_key FROM area_intentions
          WHERE half_term_id = $1 AND period_kind = $2 AND status = 'active' AND cluster_key IS NOT NULL`,
        [target.id, target.kind]);
      adopted = new Set(rows.map(r => r.cluster_key));
    }

    const byArea = {};
    for (const a of areas) byArea[a] = [];
    const unsorted = [];
    for (const it of items) {
      if (it.area && byArea[it.area]) byArea[it.area].push(it);
      else unsorted.push(it);
    }

    const summary = areas.map(a => ({
      area: a,
      next_steps: byArea[a].length,
      children: new Set(byArea[a].map(i => i.child_id)).size,
    }));

    const body = {
      period, window: { from, to, reason: windowReason },
      room_id: Number.isInteger(roomId) ? roomId : null,
      totals: {
        next_steps_in: items.length,
        tracked: counts.tracked,
        from_observations: counts.embedded,
        unattributed: unsorted.length,
        children: new Set(items.map(i => i.child_id)).size,
      },
      summary,
      // Said plainly rather than hidden: a next step with no framework link, no
      // area tag and no recognisable words cannot be filed, and pretending
      // otherwise would put it under the wrong practitioner.
      unattributed_note: unsorted.length
        ? `${unsorted.length} next step(s) could not be attributed to an area — no framework link, no area tag, and no recognisable wording.`
        : null,
      for_half_term: target,
    };

    if (wanted) {
      const intentions = buildIntentions(byArea[wanted] || [], wanted, nameSet)
        .map(i => Object.assign(i, { already_adopted: adopted.has(i.cluster_key) }));
      body.area = wanted;
      body.intentions = intentions;
      body.area_totals = {
        next_steps_in: (byArea[wanted] || []).length,
        clustered_into: intentions.length,
        children: new Set((byArea[wanted] || []).map(i => i.child_id)).size,
        group_intentions: intentions.filter(i => i.is_group).length,
      };
    }
    res.json(body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /intentions ────────────────────────────────────────────────────────
// Adopt ticked candidates into the next half-term.
//
// The client sends CLUSTER KEYS, not intention text and not source ids: the
// server re-gathers and stores the sources it computes itself. That is the whole
// traceability promise — what is written to area_intention_sources is what Wren
// can actually see in the data, never something a browser posted.
router.post('/intentions', async (req, res) => {
  if (!hasRole(req.user, PLAN_ROLES)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const keys = Array.isArray(req.body.cluster_keys)
    ? req.body.cluster_keys.map(k => String(k || '')).filter(Boolean) : [];
  const area = G.canonicalArea(req.body.area);
  if (!area) return res.status(400).json({ error: 'area required' });
  if (!keys.length) return res.status(400).json({ error: 'cluster_keys required' });
  try {
    const db = getPool();
    const target = await resolvePeriod(db, { half_term_id: req.body.for_half_term_id || req.body.half_term_id });
    if (!target) return res.status(400).json({ error: 'for_half_term_id required' });
    const source = await resolvePeriod(db, { half_term_id: req.body.source_half_term_id });

    const today = CAL.todayYmd();
    let from = CAL.cleanYmd(req.body.from), to = CAL.cleanYmd(req.body.to);
    if ((!from || !to) && source && ymd(source.start_date) <= today) {
      from = ymd(source.start_date);
      to = ymd(source.end_date) < today ? ymd(source.end_date) : today;
    }
    if (!from || !to) { to = today; from = CAL.addDays(today, -120); }

    const roomId = parseInt(req.body.room_id, 10);
    const { saved, skipped } = await adoptClusters(db, {
      area, target, source, from, to,
      roomId: Number.isInteger(roomId) ? roomId : null,
      keys, userId: req.user.id || null,
    });
    res.status(201).json({ for_period: target, source_period: source, window: { from, to }, saved, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── adoptClusters ───────────────────────────────────────────────────────────
// b223 — lifted verbatim out of POST /intentions so the plan-draft sign-off can
// carry its accepted suggestions into area_intentions through EXACTLY the same
// path a ticked candidate takes. There is one adoption code path, not two.
//
// The caller passes CLUSTER KEYS. This re-gathers and writes the sources IT
// computes — never something a browser (or a model) supplied.
async function adoptClusters(db, o) {
  const { area, target, source, from, to, roomId, keys, userId } = o;
  const { items, nameSet } = await gather(db, { from, to, roomId: Number.isInteger(roomId) ? roomId : null });
  const areaItems = items.filter(i => i.area === area);
  const candidates = buildIntentions(areaItems, area, nameSet);
  const byKey = new Map(candidates.map(c => [c.cluster_key, c]));

  const saved = [], skipped = [];
  for (const key of keys) {
    const cand = byKey.get(key);
    if (!cand) { skipped.push({ cluster_key: key, reason: 'no longer in the gathered list' }); continue; }

    const { rows } = await db.query(
        `INSERT INTO area_intentions
           (area, sub_area, half_term_id, period_kind, term_name, academic_year,
            source_half_term_id, room_id, intention_text, rationale,
            child_count, child_ids, recurrence, is_group, cluster_key, chosen_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16, now())
         ON CONFLICT (half_term_id, period_kind, area, cluster_key)
           WHERE cluster_key IS NOT NULL
         DO UPDATE SET
           intention_text = EXCLUDED.intention_text,
           sub_area       = EXCLUDED.sub_area,
           rationale      = EXCLUDED.rationale,
           child_count    = EXCLUDED.child_count,
           child_ids      = EXCLUDED.child_ids,
           recurrence     = EXCLUDED.recurrence,
           is_group       = EXCLUDED.is_group,
           status         = 'active',
           updated_at     = now()
         RETURNING *`,
        [area, cand.sub_area, target.id, target.kind, target.name, target.academic_year,
         source ? source.id : null,
         cand.rooms.length === 1 ? cand.rooms[0].room_id : null,
         cand.intention_text, cand.rationale,
         cand.child_count, JSON.stringify(cand.children.map(c => c.child_id)),
         cand.recurrence, cand.is_group, cand.cluster_key, userId || null]);

    const intention = rows[0];
    for (const s of cand.sources) {
      await db.query(
        `INSERT INTO area_intention_sources
           (intention_id, next_step_id, observation_id, child_id, source_kind, source_text, source_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [intention.id, s.next_step_id, s.observation_id, s.child_id, s.kind, s.text, s.created_at]);
    }
    const { rows: cnt } = await db.query(
      `SELECT count(*)::int AS n FROM area_intention_sources WHERE intention_id = $1`, [intention.id]);
    saved.push({ ...intention, source_count: cnt[0].n });
  }
  return { saved, skipped };
}

// ─── GET /intentions ─────────────────────────────────────────────────────────
// What has been carried into a half-term. This is what the termly plan reads.
router.get('/intentions', async (req, res) => {
  try {
    const db = getPool();
    const params = [];
    let sql = `
      SELECT i.*, s.first_name || ' ' || s.last_name AS chosen_by_name,
             rm.name AS room_name,
             (SELECT count(*)::int FROM area_intention_sources src WHERE src.intention_id = i.id) AS source_count
        FROM area_intentions i
        LEFT JOIN staff s ON s.id = i.chosen_by
        LEFT JOIN rooms rm ON rm.id = i.room_id
       WHERE 1=1`;
    if (req.query.half_term_id) { params.push(parseInt(req.query.half_term_id, 10)); sql += ` AND i.half_term_id = $${params.length}`; }
    const area = G.canonicalArea(req.query.area);
    if (req.query.area && !area) return res.status(400).json({ error: 'Unknown area' });
    if (area) { params.push(area); sql += ` AND i.area = $${params.length}`; }
    if (req.query.status) { params.push(String(req.query.status)); sql += ` AND i.status = $${params.length}`; }
    else sql += ` AND i.status = 'active'`;
    sql += ` ORDER BY i.area, i.child_count DESC, i.id`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /intentions/:id/sources ─────────────────────────────────────────────
// The trace: intention → the next steps it came from → the observation and the
// child each was written about.
router.get('/intentions/:id/sources', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const db = getPool();
    const { rows: iRows } = await db.query(`SELECT * FROM area_intentions WHERE id = $1`, [id]);
    if (!iRows.length) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(
      `SELECT src.*, c.first_name, c.last_name, rm.name AS room_name,
              o.title AS observation_title, o.created_at AS observation_date,
              o.group_uuid IS NOT NULL AS from_group_observation,
              ns.status AS next_step_status
         FROM area_intention_sources src
         LEFT JOIN children c ON c.id = src.child_id
         LEFT JOIN rooms rm ON rm.id = c.room_id
         LEFT JOIN observations o ON o.id = COALESCE(src.observation_id,
                                                     (SELECT observation_id FROM next_steps WHERE id = src.next_step_id))
         LEFT JOIN next_steps ns ON ns.id = src.next_step_id
        WHERE src.intention_id = $1
        ORDER BY c.first_name, src.source_date DESC`, [id]);
    res.json({
      intention: iRows[0],
      sources: rows.map(r => ({ ...r, child_name: `${r.first_name || ''} ${r.last_name || ''}`.trim() })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /intentions/:id ───────────────────────────────────────────────────
// Drop or complete one. Never a DELETE: an intention that was carried and then
// dropped is part of the term's story.
router.patch('/intentions/:id', async (req, res) => {
  if (!hasRole(req.user, PLAN_ROLES)) return res.status(403).json({ error: 'Insufficient permissions' });
  const id = parseInt(req.params.id, 10);
  const status = String(req.body.status || '').trim();
  if (!['active', 'dropped', 'achieved'].includes(status)) {
    return res.status(400).json({ error: 'status must be active, dropped or achieved' });
  }
  try {
    const { rows } = await getPool().query(
      `UPDATE area_intentions SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, status]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b238 (2026-08-27) — AI-ASSISTED PLANNING
// Spec: wren-docs/ey-portal-restructure-2026-08-27.md §2
//
//   "Every half term each practitioner fills out their area of responsibility and
//    drafts the next half term. Keep the job, rename it AI-assisted planning, and
//    make it do the work: pull all observations, all next steps and all termly
//    updates for their key children, then suggest activities and resources and
//    draft the half term. The practitioner edits rather than starts blank."
//
// This is DRAFTING, not deciding. Nothing here writes an intention, a plan or a
// contribution — it returns a draft the practitioner edits and then saves through
// the existing POST /intentions and PUT /contribution routes. That keeps the
// audit trail honest: a signed-off intention is always a human action.
//
// GDPR — SOVEREIGN MODEL ONLY, NAMES STRIPPED
//   · The model is Ollama on Ascent (OLLAMA_HOST), never a cloud model. Locked by
//     the 2026-05-14 AI split: Groq for demos, local for LADN production.
//   · Every line of evidence goes through G.depersonalise(text, nameSet) first —
//     the SAME helper the gathered-intentions tick list already uses, not a second
//     implementation of name-stripping (reflections.js established this pattern).
//   · The response carries COUNTS and depersonalised text. No child id, no name.
// ═══════════════════════════════════════════════════════════════════════════

const PD = require('../lib/plan-draft');

const AI_PLAN_SYSTEM = [
  'You are an experienced early years curriculum lead in an English day nursery,',
  'drafting the next half-term plan for one practitioner\'s area of responsibility.',
  'You are given DEPERSONALISED evidence: recent observations, the children\'s current',
  'next steps, and the progress updates written about them. No child is named and you',
  'must never invent a name, an age or a specific child.',
  'Draft a plan the practitioner will EDIT, not one they must accept. Be concrete and',
  'practical: things that can actually be set up in a nursery room on a Monday morning.',
  'Only ever suggest an activity or a resource from the candidate lists you are given —',
  'reference them by the exact id or slug provided. Never invent one.',
  'Return ONLY a JSON object of this shape:',
  '{"theme":"","rationale":"","intentions":[{"text":"","why":""}],',
  ' "activity_ids":[],"resource_slugs":[],',
  ' "weekly_focus":[{"week":1,"focus":""}],"contribution":{"noticed":"","change":"","ideas":""}}',
  'Between 2 and 4 intentions. weekly_focus covers however many weeks you are told the',
  'half-term runs. contribution is a first-person draft of the practitioner\'s own',
  'half-termly write-up, for them to correct.',
].join(' ');

const AI_PLAN_MAX_EVIDENCE = 40;   // lines of each kind fed to the model
const AI_PLAN_MAX_CARDS    = 40;
const AI_PLAN_MAX_ACTS     = 30;

/** Depersonalise, trim and de-duplicate a set of evidence lines. */
function _evidenceLines(rows, nameSet, pick, limit) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const raw = pick(r);
    if (!raw) continue;
    const clean = G.depersonalise(String(raw), nameSet, 'a child')
      .replace(/\s+/g, ' ').trim().slice(0, 240);
    if (clean.length < 8) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= (limit || AI_PLAN_MAX_EVIDENCE)) break;
  }
  return out;
}

// ─── GET /ai-plan/context ────────────────────────────────────────────────────
// What the page needs before anyone presses the button: how much evidence there
// is to work from, and whether Ascent is answering right now. Answering "the
// model is offline" up front beats a three-minute spinner that then fails.
router.get('/ai-plan/context', async (req, res) => {
  try {
    const db = getPool();
    const today = CAL.cleanYmd(req.query.date, CAL.todayYmd());
    const cal = await CAL.loadCalendar(db, null);
    const day = CAL.resolveDay(today, cal.terms, cal.breaks);
    const from = day.half_term || day.previous_half_term || null;
    const forHt = day.next_half_term || day.half_term || null;

    const { rows: mine } = await db.query(
      `SELECT area FROM staff_area_responsibilities
        WHERE staff_id = $1 AND ended_at IS NULL LIMIT 1`, [req.user.id]);

    const { rows: kids } = await db.query(
      `SELECT count(*)::int AS n FROM children
        WHERE key_person_id = $1 AND ${operationalChildFilter('children')}`, [req.user.id]);

    const up = await PD.probe(4000);
    res.json({
      today,
      my_area: (mine[0] && mine[0].area) || null,
      gather_from: from,
      gather_for: forHt,
      key_children: kids[0] ? kids[0].n : 0,   // COUNT only — never the children
      can_draft: hasRole(req.user, PLAN_ROLES),
      model: { host: PD.OLLAMA_HOST(), name: PD.OLLAMA_MODEL(), reachable: up },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /ai-plan ───────────────────────────────────────────────────────────
// Body: { area?, room_id?, half_term_id?, scope? }
//   scope: 'key_children' (default) | 'room'  — a practitioner with no key
//   children assigned would otherwise get an empty draft, so 'room' is the
//   honest fallback rather than silently widening the query.
router.post('/ai-plan', async (req, res) => {
  if (!hasRole(req.user, PLAN_ROLES)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const db = getPool();
  try {
    // ── 1 · window + area ────────────────────────────────────────────────────
    const today = CAL.cleanYmd(req.body.date, CAL.todayYmd());
    const cal = await CAL.loadCalendar(db, null);
    const day = CAL.resolveDay(today, cal.terms, cal.breaks);
    const sourceHt = day.half_term || day.previous_half_term || null;
    const targetHt = (await resolvePeriod(db, req.body)) || day.next_half_term || day.half_term || null;

    // Where no calendar is seeded, fall back to the last 12 weeks so the feature
    // still works rather than 500ing on a missing school_terms row.
    const from = ymd(sourceHt && sourceHt.start_date) ||
      ymd(new Date(Date.now() - 84 * 86400000));
    const to = ymd(sourceHt && sourceHt.end_date) || today;

    const areas = await settingAreas(db);
    const { rows: mine } = await db.query(
      `SELECT area FROM staff_area_responsibilities
        WHERE staff_id = $1 AND ended_at IS NULL LIMIT 1`, [req.user.id]);
    const area = G.canonicalArea(req.body.area) || (mine[0] && G.canonicalArea(mine[0].area)) || areas[0];

    // ── 2 · whose children ───────────────────────────────────────────────────
    const scope = req.body.scope === 'room' ? 'room' : 'key_children';
    const roomId = Number.isInteger(parseInt(req.body.room_id, 10)) ? parseInt(req.body.room_id, 10) : null;
    const childParams = [];
    let childWhere;
    if (scope === 'room' && roomId) {
      childParams.push(roomId);
      childWhere = `children.room_id = $1 AND ${operationalChildFilter('children')}`;
    } else {
      childParams.push(req.user.id);
      childWhere = `children.key_person_id = $1 AND ${operationalChildFilter('children')}`;
    }
    const { rows: kidRows } = await db.query(
      `SELECT id FROM children WHERE ${childWhere}`, childParams);
    const childIds = kidRows.map(r => r.id);
    if (!childIds.length) {
      return res.status(200).json({
        drafted: false,
        reason: 'no_children',
        message: scope === 'room'
          ? 'No children are currently in that room, so there is nothing to plan from.'
          : 'You have no key children assigned yet, so there is nothing to plan from. '
            + 'Ask a manager to assign your key children, or draft from a whole room instead.',
      });
    }

    // ── 3 · the evidence: ALL observations, ALL next steps, ALL termly updates ─
    const [obsRows, nsRows, termlyRows, nameRows] = await Promise.all([
      db.query(
        `SELECT title, next_steps, analysis, eyfs_areas, created_at
           FROM observations
          WHERE child_id = ANY($1::int[])
            AND COALESCE(review_status,'published') = 'published'
            AND COALESCE(termly_update,false) = false
            AND COALESCE(dsl_only,false) = false
            AND created_at >= $2::date AND created_at < ($3::date + interval '1 day')
          ORDER BY created_at DESC
          LIMIT 400`, [childIds, from, to]),
      db.query(
        `SELECT ns.description, ns.status, ns.created_at, fs.area AS fw_area
           FROM next_steps ns
           LEFT JOIN framework_statements fs ON fs.id = ns.framework_statement_id
          WHERE ns.child_id = ANY($1::int[])
          ORDER BY ns.created_at DESC
          LIMIT 400`, [childIds]),
      db.query(
        `SELECT title, observation_text, next_steps, additional_comments, eyfs_areas, created_at
           FROM observations
          WHERE child_id = ANY($1::int[])
            AND termly_update = true
            AND COALESCE(dsl_only,false) = false
          ORDER BY created_at DESC
          LIMIT 200`, [childIds]),
      // The name set is drawn from EVERY child, not just these ones: a sibling or
      // room-mate named inside an observation must be stripped too.
      db.query(`SELECT DISTINCT lower(first_name) AS n FROM children WHERE first_name IS NOT NULL`),
    ]);
    const nameSet = new Set(nameRows.rows.map(r => r.n).filter(n => n && n.length > 1));

    const inArea = (rowAreas, fwArea) => {
      if (fwArea && G.canonicalArea(fwArea) === area) return true;
      return (rowAreas || []).some(a => G.canonicalArea(a) === area);
    };

    const obsInArea = obsRows.rows.filter(r => inArea(r.eyfs_areas));
    const nsInArea = nsRows.rows.filter(r =>
      inArea(null, r.fw_area) || G.classify(r.description, { frameworkArea: r.fw_area }).area === area);
    const termlyInArea = termlyRows.rows.filter(r => inArea(r.eyfs_areas));

    // If the area filter leaves nothing, plan from everything rather than
    // returning an empty draft — a thin area is exactly when help is wanted.
    const obsSrc    = obsInArea.length    ? obsInArea    : obsRows.rows;
    const nsSrc     = nsInArea.length     ? nsInArea     : nsRows.rows;
    const termlySrc = termlyInArea.length ? termlyInArea : termlyRows.rows;

    const evObs = _evidenceLines(obsSrc, nameSet, r => r.title || r.analysis);
    const evNext = _evidenceLines(nsSrc, nameSet, r => r.description);
    const evTermly = _evidenceLines(termlySrc, nameSet,
      r => [r.title, r.next_steps, r.additional_comments].filter(Boolean).join(' — '));

    if (!evObs.length && !evNext.length && !evTermly.length) {
      return res.status(200).json({
        drafted: false, reason: 'no_evidence',
        message: 'There are no observations, next steps or progress updates to plan from yet.',
        counts: { children: childIds.length, observations: 0, next_steps: 0, termly_updates: 0 },
      });
    }

    // ── 4 · what may be suggested: real cards and real activities only ───────
    let cardPool = [];
    try {
      const idx = require('./resource-cards')._loadCards().index || [];
      cardPool = idx
        .filter(c => !area || !(c.areas || []).length || (c.areas || []).some(a => G.canonicalArea(a) === area))
        .slice(0, AI_PLAN_MAX_CARDS)
        .map(c => ({ slug: c.slug, title: c.title, strapline: c.strapline || '' }));
      if (!cardPool.length) {
        cardPool = idx.slice(0, AI_PLAN_MAX_CARDS)
          .map(c => ({ slug: c.slug, title: c.title, strapline: c.strapline || '' }));
      }
    } catch (_) { cardPool = []; }

    // planning_activities is the same library the observation flow attaches from
    // (/api/activity-bank), so anything suggested here can actually be attached.
    let activityPool = [];
    try {
      const { rows } = await db.query(
        `SELECT id, title, age_group, eyfs_areas FROM planning_activities
          ORDER BY times_used DESC NULLS LAST, id LIMIT 400`);
      const matched = rows.filter(r => (r.eyfs_areas || []).some(a => G.canonicalArea(a) === area));
      activityPool = (matched.length ? matched : rows).slice(0, AI_PLAN_MAX_ACTS)
        .map(r => ({ id: r.id, title: r.title, age_group: r.age_group || '' }));
    } catch (_) { activityPool = []; }

    // ── 5 · ask the local model ─────────────────────────────────────────────
    const weeks = (() => {
      const a = targetHt && targetHt.start_date, b = targetHt && targetHt.end_date;
      if (!a || !b) return 6;
      const d = Math.round((new Date(ymd(b)) - new Date(ymd(a))) / 604800000);
      return Math.min(8, Math.max(4, d || 6));
    })();

    const prompt = [
      `AREA OF RESPONSIBILITY: ${area}`,
      `PLANNING FOR: ${(targetHt && targetHt.name) || 'the next half-term'} (${weeks} weeks)`,
      `EVIDENCE WINDOW: ${from} to ${to}`,
      `KEY CHILDREN IN SCOPE: ${childIds.length}`,
      '',
      `RECENT OBSERVATIONS (${evObs.length}):`,
      ...(evObs.length ? evObs.map(l => `- ${l}`) : ['- (none recorded in this window)']),
      '',
      `CURRENT NEXT STEPS (${evNext.length}):`,
      ...(evNext.length ? evNext.map(l => `- ${l}`) : ['- (none recorded)']),
      '',
      `TERMLY UPDATES (${evTermly.length}):`,
      ...(evTermly.length ? evTermly.map(l => `- ${l}`) : ['- (none recorded)']),
      '',
      'CANDIDATE ACTIVITIES (use activity_ids from this list only):',
      ...(activityPool.length ? activityPool.map(a => `- id ${a.id}: ${a.title}${a.age_group ? ' (' + a.age_group + ')' : ''}`)
                              : ['- (none available)']),
      '',
      'CANDIDATE RESOURCE CARDS (use resource_slugs from this list only):',
      ...(cardPool.length ? cardPool.map(c => `- ${c.slug}: ${c.title}`) : ['- (none available)']),
      '',
      `Draft the half-term. weekly_focus must have exactly ${weeks} entries, weeks 1 to ${weeks}.`,
    ].join('\n');

    // b333: resolved once, so a failed run reports the model that was asked.
    // num_ctx is the resolver's now (plan-draft.js sends the long size).
    const planModel = PD.OLLAMA_MODEL();
    let raw;
    try {
      raw = await PD.callModel(prompt, { system: AI_PLAN_SYSTEM, maxTokens: 1600, model: planModel });
    } catch (e) {
      // Degraded, not failed: hand back the gathered evidence so the practitioner
      // can still write the plan themselves. Never a silent empty draft.
      return res.status(200).json({
        drafted: false, reason: 'model_unreachable',
        message: `The local model on ${PD.OLLAMA_HOST()} did not answer, so nothing was drafted. `
               + 'The evidence below was still gathered — you can write the plan from it.',
        model: { host: PD.OLLAMA_HOST(), name: PD.OLLAMA_MODEL() },
        area, window: { from, to },
        counts: { children: childIds.length, observations: evObs.length,
                  next_steps: evNext.length, termly_updates: evTermly.length },
        evidence: { observations: evObs, next_steps: evNext, termly_updates: evTermly },
      });
    }

    let parsed;
    try { parsed = PD.parseModelJson(raw.text); }
    catch (e) {
      return res.status(200).json({
        drafted: false, reason: 'unparseable',
        message: 'The local model answered but not in a usable shape. Nothing was drafted.',
        model: { host: raw.host, name: raw.model, ms: raw.ms },
        area, window: { from, to },
        counts: { children: childIds.length, observations: evObs.length,
                  next_steps: evNext.length, termly_updates: evTermly.length },
        evidence: { observations: evObs, next_steps: evNext, termly_updates: evTermly },
      });
    }

    // ── 6 · check what it returned against what actually exists ──────────────
    const cardBySlug = new Map(cardPool.map(c => [c.slug, c]));
    const actById = new Map(activityPool.map(a => [Number(a.id), a]));
    const dropped = [];

    const resources = [...new Set((Array.isArray(parsed.resource_slugs) ? parsed.resource_slugs : [])
      .map(v => String(v || '').trim().toLowerCase()))]
      .filter(slug => { if (cardBySlug.has(slug)) return true; if (slug) dropped.push(`resource card "${slug}" does not exist`); return false; })
      .map(slug => cardBySlug.get(slug));

    const activities = [...new Set((Array.isArray(parsed.activity_ids) ? parsed.activity_ids : [])
      .map(v => parseInt(v, 10)).filter(Number.isInteger))]
      .filter(id => { if (actById.has(id)) return true; dropped.push(`activity ${id} does not exist`); return false; })
      .map(id => actById.get(id));

    const intentions = (Array.isArray(parsed.intentions) ? parsed.intentions : [])
      .map(i => ({
        text: G.depersonalise(String((i && i.text) || '').trim(), nameSet, 'children').slice(0, 240),
        why: G.depersonalise(String((i && i.why) || '').trim(), nameSet, 'children').slice(0, 400),
      }))
      .filter(i => i.text.length >= 8)
      .slice(0, 4);

    const weekly = (Array.isArray(parsed.weekly_focus) ? parsed.weekly_focus : [])
      .map((w, i) => ({
        week: parseInt((w && w.week), 10) || (i + 1),
        focus: G.depersonalise(String((w && w.focus) || '').trim(), nameSet, 'children').slice(0, 240),
      }))
      .filter(w => w.focus)
      .slice(0, weeks);

    const contrib = parsed.contribution || {};
    const contribution = {
      noticed: G.depersonalise(String(contrib.noticed || '').trim(), nameSet, 'children').slice(0, 1500),
      change:  G.depersonalise(String(contrib.change  || '').trim(), nameSet, 'children').slice(0, 1500),
      ideas:   G.depersonalise(String(contrib.ideas   || '').trim(), nameSet, 'children').slice(0, 1500),
    };

    res.json({
      drafted: true,
      area,
      scope,
      window: { from, to, source_half_term: sourceHt && sourceHt.name, target_half_term: targetHt && targetHt.name, weeks },
      counts: { children: childIds.length, observations: evObs.length,
                next_steps: evNext.length, termly_updates: evTermly.length },
      draft: {
        theme: G.depersonalise(String(parsed.theme || '').trim(), nameSet, 'children').slice(0, 120),
        rationale: G.depersonalise(String(parsed.rationale || '').trim(), nameSet, 'children').slice(0, 900),
        intentions, activities, resources, weekly_focus: weekly, contribution,
      },
      dropped,
      model: { host: raw.host, name: raw.model, ms: raw.ms },
      note: 'Draft only — nothing has been saved. Edit it, then save through the '
          + 'Contribution and Intentions steps as usual.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// b223 — internals exposed for the plan drafter (src/routes/plan-drafts.js),
// following the same `router._loadCards` convention resource-cards.js uses. The
// drafter must gather through THIS code, not a second copy of it, or the model
// would be grounded on something different from what the tick-list shows.
router._gather          = gather;
router._buildIntentions = buildIntentions;
router._adoptClusters   = adoptClusters;
router._settingAreas    = settingAreas;
router._resolvePeriod   = resolvePeriod;

module.exports = router;
