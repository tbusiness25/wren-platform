// ============================================================================
// New Starters / Apprentices — induction checklist + sign-offs (PHASE 1)
// Mounted at /api/induction on the learning (Nest), HR and admin portals.
//
// Day-to-day ownership = room leader + manager oversight.
//   managers                = manager / deputy_manager / admin
//   room leader (per assign) = staff.id === assignment.room_leader_id
//
// A staff member may mark their OWN item done / in_progress. Setting an item to
// 'signed_off' requires a manager OR the assignment's room leader.
// ============================================================================
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

// ── role helpers ────────────────────────────────────────────────────────────
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
function isManager(user) {
  return !!user && hasRole(user, MANAGER_ROLES);
}
function isLeaderOf(user, assignment) {
  return !!user && !!assignment && Number(assignment.room_leader_id) === Number(user.id);
}
function isOwnerOf(user, assignment) {
  return !!user && !!assignment && Number(assignment.staff_id) === Number(user.id);
}
function canViewAssignment(user, assignment) {
  return isManager(user) || isOwnerOf(user, assignment) || isLeaderOf(user, assignment);
}

// ── b313 — sign-off-only items ──────────────────────────────────────────────
// Some induction items a starter self-certifies ("I have read the handbook").
// Others a room leader signs off in person, standing next to them ("fire-exit
// walk", "induction formally signed off by manager").
//
// Before b313 that distinction lived in exactly one place and in the worst
// possible form: a string comparison in editions/hr/public/my-induction.html
// that decided whether to RENDER a "Mark done" button. A hidden button is not a
// rule. Proved against the API on wren_dev, 2026-09-10, before this build:
//   PATCH /api/induction/item-progress/2522 {"status":"done"}
//   with the STARTER's own JWT  ->  200, status=done
// on their own 'Induction formally signed off by manager' row.
//
// So it is now a column, induction_template_items.signoff_only, enforced here
// on BOTH write paths. A tenant that has not yet run
// migrations/2026-09-10-b313-induction-signoff-only.sql keeps the OLD title rule
// rather than losing the check altogether — identical behaviour either way, and
// still closed. The probe runs once per process because search_path is fixed per
// container (src/db/pool.js sets it on the pool, not per request).
const LEGACY_SIGNOFF_ONLY_TITLE = 'Induction formally signed off by manager';
let _signoffOnlyColumn = null;            // null = not probed yet
async function hasSignoffOnlyColumn(db) {
  if (_signoffOnlyColumn !== null) return _signoffOnlyColumn;
  try {
    const { rows } = await db.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name  = 'induction_template_items'
         AND column_name = 'signoff_only'
       LIMIT 1`);
    _signoffOnlyColumn = rows.length > 0;
  } catch (_) { _signoffOnlyColumn = false; }
  return _signoffOnlyColumn;
}

// The SELECT fragment for the flag, so one expression serves both tenants. The
// fallback compares against a constant declared above — no request data reaches
// this string.
async function signoffOnlySql(db) {
  return (await hasSignoffOnlyColumn(db))
    ? 'COALESCE(ti.signoff_only, false)'
    : "(ti.title = '" + LEGACY_SIGNOFF_ONLY_TITLE.replace(/'/g, "''") + "')";
}

// Is ONE template item sign-off-only?
// login-20261023 — the pathway's "ready to observe" item moves ONLY with the manager's switch
// (POST /assignments/:id/ready), which also grants or removes the observation capabilities. A manual
// tick would make the screen say "ready" while observations were still off.
const READY_ITEM_REFUSAL = { error: 'ready_item', message: 'Use “Ready to observe” on the apprentice’s pathway — a manager switches this on.' };
async function isReadyItem(db, itemId) {
  try {
    const { rows } = await db.query("SELECT to_jsonb(ti) ->> 'auto_rule' AS r FROM induction_template_items ti WHERE id = $1", [itemId]);
    return !!rows.length && rows[0].r === 'ready';
  } catch (_) { return false; }
}

async function isSignoffOnlyItem(db, itemId) {
  const expr = await signoffOnlySql(db);
  const { rows } = await db.query(
    `SELECT ${expr} AS flag FROM induction_template_items ti WHERE ti.id = $1`, [itemId]);
  return rows.length ? rows[0].flag === true : false;
}

// The single refusal rule, shared by both write paths. A manager or the
// assignment's room leader may set any status on a sign-off-only item; the
// starter may set none of them (not even 'in_progress' — the item is not theirs
// to move). Returns null when the write is allowed.
function signoffOnlyRefusal(flag, { mgr, leader }) {
  if (!flag || mgr || leader) return null;
  return {
    error: 'signoff_only',
    message: 'Your room leader or a manager signs this item off with you in person — ' +
             'it is not one you can tick yourself.',
  };
}

// ============================================================================
// TEMPLATES
// ============================================================================

// GET /templates — list active templates (with item counts)
router.get('/templates', async (req, res) => {
  try {
    const db = getPool();
    const includeInactive = isManager(req.user) && req.query.all === 'true';
    // b404-F port (17 Oct 2026): the per-room CHILD settling-in templates (target_type='child') live in the
    // same table but must never show up in the STAFF "assign a template" lists — they have their own
    // GET /child-templates. Falls back to the unfiltered list if the migration that adds target_type
    // has not been applied yet (42703 undefined_column), so this route can never break on that.
    const listSql = (childFilter) => `
      SELECT t.id, t.name, t.role_target, t.room_id, t.is_active, t.created_at,
             r.name AS room_name,
             COUNT(i.id)::int AS item_count
      FROM induction_templates t
      LEFT JOIN rooms r ON r.id = t.room_id
      LEFT JOIN induction_template_items i ON i.template_id = t.id
      ${includeInactive ? (childFilter ? "WHERE COALESCE(t.target_type,'staff') <> 'child'" : '')
                        : ('WHERE t.is_active = true' + (childFilter ? " AND COALESCE(t.target_type,'staff') <> 'child'" : ''))}
      GROUP BY t.id, r.name
      ORDER BY t.id
    `;
    let rows;
    try { ({ rows } = await db.query(listSql(true))); }
    catch (e) { if (e && e.code === '42703') ({ rows } = await db.query(listSql(false))); else throw e; }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /templates/:id — template + its items (grouped client-side by section)
router.get('/templates/:id', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { rows: tpl } = await db.query(`
      SELECT t.*, r.name AS room_name FROM induction_templates t
      LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = $1
    `, [id]);
    if (!tpl.length) return res.status(404).json({ error: 'Template not found' });
    const { rows: items } = await db.query(`
      SELECT i.*, c.name AS course_name, c.status AS course_status,
             p.title AS policy_title, p.category AS policy_category, p.version AS policy_version
      FROM induction_template_items i
      LEFT JOIN courses c ON c.id = i.course_id
      LEFT JOIN policies p ON p.id = i.policy_id
      WHERE i.template_id = $1
      ORDER BY i.week_number NULLS LAST, i.sort_order, i.id
    `, [id]);
    res.json({ ...tpl[0], items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /templates (manager) — create a template
router.post('/templates', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { name, role_target, room_id, is_active } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const { rows } = await db.query(`
      INSERT INTO induction_templates (name, role_target, room_id, is_active)
      VALUES ($1, $2, $3, COALESCE($4, true))
      RETURNING *
    `, [
      String(name).trim(),
      Array.isArray(role_target) && role_target.length ? role_target : ['apprentice', 'practitioner'],
      room_id || null,
      typeof is_active === 'boolean' ? is_active : null,
    ]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /templates/:id/items (manager) — add an item to a template
router.post('/templates/:id/items', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const templateId = parseInt(req.params.id, 10);
    const { section, title, description, item_type, course_id, policy_id, source_refs, sort_order, required, week_number } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
    const validTypes = ['form', 'course', 'reading', 'task', 'policy_ack', 'document'];
    if (!validTypes.includes(item_type)) return res.status(400).json({ error: 'item_type must be one of ' + validTypes.join(', ') });
    const { rows: tExists } = await db.query('SELECT id FROM induction_templates WHERE id=$1', [templateId]);
    if (!tExists.length) return res.status(404).json({ error: 'Template not found' });
    const { rows } = await db.query(`
      INSERT INTO induction_template_items
        (template_id, section, title, description, item_type, course_id, policy_id, source_refs, sort_order, required, week_number)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,0),COALESCE($10,true),$11)
      RETURNING *
    `, [
      templateId, section || null, String(title).trim(), description || null, item_type,
      course_id || null,
      policy_id || null,
      Array.isArray(source_refs) ? source_refs : null,
      Number.isInteger(sort_order) ? sort_order : null,
      typeof required === 'boolean' ? required : null,
      Number.isInteger(week_number) ? week_number : null,
    ]);
    // b313 — a separate UPDATE rather than a dynamic INSERT above, so the insert
    // stays byte-identical on a tenant that has not run the b313 migration.
    if (req.body && req.body.signoff_only === true && await hasSignoffOnlyColumn(db)) {
      await db.query('UPDATE induction_template_items SET signoff_only = true WHERE id = $1', [rows[0].id]);
      rows[0].signoff_only = true;
    }
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// ASSIGNMENTS
// ============================================================================

// Shared SELECT for assignment list rows (with names + live % complete)
const ASSIGNMENT_LIST_SQL = `
  SELECT a.id, a.staff_id, a.template_id, a.assigned_by, a.room_leader_id,
         a.start_date, a.target_complete_date, a.status, a.created_at,
         s.first_name || ' ' || s.last_name AS staff_name,
         s.role AS staff_role,
         rm.name AS room_name,
         t.name AS template_name,
         rl.first_name || ' ' || rl.last_name AS room_leader_name,
         (SELECT COUNT(*) FROM induction_template_items ti WHERE ti.template_id = a.template_id)::int AS total_items,
         (SELECT COUNT(*) FROM induction_item_progress ip
            WHERE ip.assignment_id = a.id AND ip.status IN ('done','signed_off'))::int AS done_items,
         (SELECT COUNT(*) FROM induction_item_progress ip
            WHERE ip.assignment_id = a.id AND ip.status = 'signed_off')::int AS signed_off_items
  FROM induction_assignments a
  JOIN staff s ON s.id = a.staff_id
  LEFT JOIN rooms rm ON rm.id = s.room_id
  LEFT JOIN induction_templates t ON t.id = a.template_id
  LEFT JOIN staff rl ON rl.id = a.room_leader_id
`;

function withPct(row) {
  const total = row.total_items || 0;
  const pct = total ? Math.round((row.done_items / total) * 100) : 0;
  const pctSigned = total ? Math.round((row.signed_off_items / total) * 100) : 0;
  return { ...row, pct_complete: pct, pct_signed_off: pctSigned };
}

// ── auto-complete engine ─────────────────────────────────────────────────────
// Heals induction_item_progress against the real state of the underlying assets
// it's linked to, rather than duplicating the course/policy engines:
//   'course' items      → done once course_attempts shows a PASSED attempt for
//                          that staff member + that course.
//   'policy_ack' items   → done once policy_acknowledgments has a row for that
//                          staff member at the policy's CURRENT version (so a
//                          version bump correctly un-acks a stale sign-off).
// Never downgrades a manager sign-off ('signed_off') or an already-'done' item —
// only advances 'pending'/'in_progress' rows forward. Also auto-completes the
// assignment itself once every required item is done/signed_off.
async function syncItemProgress(db, assignmentId) {
  const { rows: aRows } = await db.query('SELECT * FROM induction_assignments WHERE id=$1', [assignmentId]);
  if (!aRows.length) return;
  const a = aRows[0];

  await db.query(`
    UPDATE induction_item_progress ip
    SET status = 'done',
        completed_at = COALESCE(ip.completed_at, ca.completed_at::timestamptz, now()),
        evidence_note = COALESCE(ip.evidence_note, 'Auto-completed: course passed at ' || ca.score_pct || '%')
    FROM induction_template_items ti
    JOIN course_attempts ca ON ca.course_id = ti.course_id AND ca.passed = true AND ca.staff_id = $2
    WHERE ip.item_id = ti.id
      AND ip.assignment_id = $1
      AND ti.item_type = 'course'
      AND ip.status IN ('pending', 'in_progress')
  `, [assignmentId, a.staff_id]);

  await db.query(`
    UPDATE induction_item_progress ip
    SET status = 'done',
        completed_at = COALESCE(ip.completed_at, pa.acknowledged_at, now()),
        evidence_note = COALESCE(ip.evidence_note, 'Auto-completed: policy acknowledged')
    FROM induction_template_items ti
    JOIN policies p ON p.id = ti.policy_id
    JOIN policy_acknowledgments pa ON pa.policy_id = p.id AND pa.policy_version = p.version AND pa.staff_id = $2
    WHERE ip.item_id = ti.id
      AND ip.assignment_id = $1
      AND ti.item_type = 'policy_ack'
      AND ip.status IN ('pending', 'in_progress')
  `, [assignmentId, a.staff_id]);

  // login-20261023 — Apprentice pathway: items that tick themselves from what Wren already records
  // (observations opened, quiz answers, articles, reflections, the manager's "ready" switch).
  let auto = {};
  try { auto = await require('../lib/induction-auto').applyAutoRules(db, a); }
  catch (e) { console.error('[induction] auto rules:', e.message); }

  if (a.status === 'in_progress') {
    const { rows: chk } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE ti.required)::int AS required_total,
        COUNT(*) FILTER (WHERE ti.required AND ip.status IN ('done','signed_off'))::int AS required_done
      FROM induction_template_items ti
      LEFT JOIN induction_item_progress ip ON ip.item_id = ti.id AND ip.assignment_id = $1
      WHERE ti.template_id = $2
    `, [assignmentId, a.template_id]);
    const c = chk[0];
    if (c.required_total > 0 && c.required_total === c.required_done) {
      await db.query(`UPDATE induction_assignments SET status='complete' WHERE id=$1`, [assignmentId]);
    }
  }
  return auto;
}

// GET /assignments?staff_id= — managers see all (or filtered); others see own + ones they lead
router.get('/assignments', async (req, res) => {
  try {
    const db = getPool();
    const mgr = isManager(req.user);
    const qStaff = req.query.staff_id ? parseInt(req.query.staff_id, 10) : null;
    let where, params;
    // b485 — demo staff (clock-in test fixtures) never surface on the manager's
    // unfiltered induction dashboard. An explicit staff_id lookup still works —
    // a tester checking a demo assignment by id is not "the stats".
    const notDemo = 'NOT EXISTS (SELECT 1 FROM staff ds WHERE ds.id = a.staff_id AND COALESCE(ds.is_demo, false))';
    if (mgr) {
      if (qStaff) { where = 'WHERE a.staff_id = $1'; params = [qStaff]; }
      else { where = `WHERE ${notDemo}`; params = []; }
    } else {
      // own assignments + assignments where I am the room leader
      where = 'WHERE a.staff_id = $1 OR a.room_leader_id = $1';
      params = [Number(req.user.id)];
    }
    const { rows: idRows } = await db.query(`SELECT a.id FROM induction_assignments a ${where}`, params);
    for (const r of idRows) await syncItemProgress(db, r.id);
    const { rows } = await db.query(`${ASSIGNMENT_LIST_SQL} ${where} ORDER BY a.status, a.target_complete_date NULLS LAST, a.id DESC`, params);
    res.json(rows.map(withPct));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /assignments/:id — assignment + item progress joined to items
router.get('/assignments/:id', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query(`${ASSIGNMENT_LIST_SQL} WHERE a.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Assignment not found' });
    const assignment = rows[0];
    if (!canViewAssignment(req.user, assignment)) return res.status(403).json({ error: 'Forbidden' });

    const auto = (await syncItemProgress(db, id)) || {};

    // b313 — signoff_only travels with the item so all three windows on this
    // workbook (the tokened welcome page, HR, the EY tablet) can SAY who ticks
    // it instead of offering a control the API then refuses.
    const soSql = await signoffOnlySql(db);
    const { rows: items } = await db.query(`
      SELECT ti.id AS item_id, ti.section, ti.title, ti.description, ti.item_type,
             ti.course_id, ti.policy_id, ti.week_number, ti.source_refs, ti.sort_order, ti.required,
             ${soSql} AS signoff_only,
             -- login-20261023: read through to_jsonb so a tenant without the pathway migration still works
             (to_jsonb(ti) ->> 'due_day')::int AS due_day, to_jsonb(ti) ->> 'auto_rule' AS auto_rule,
             to_jsonb(ti) ->> 'learning_intention' AS learning_intention,
             c.name AS course_name,
             p.title AS policy_title, p.category AS policy_category,
             ip.id AS progress_id,
             COALESCE(ip.status, 'pending') AS status,
             ip.completed_at, ip.signed_off_by, ip.signed_off_at, ip.evidence_note,
             so.first_name || ' ' || so.last_name AS signed_off_by_name
      FROM induction_template_items ti
      LEFT JOIN induction_item_progress ip ON ip.item_id = ti.id AND ip.assignment_id = $1
      LEFT JOIN courses c ON c.id = ti.course_id
      LEFT JOIN policies p ON p.id = ti.policy_id
      LEFT JOIN staff so ON so.id = ip.signed_off_by
      WHERE ti.template_id = $2
      ORDER BY ti.week_number NULLS LAST, ti.sort_order, ti.id
    `, [id, assignment.template_id]);

    // Re-fetch pct after the sync above may have advanced items/assignment status.
    const { rows: freshRows } = await db.query(`${ASSIGNMENT_LIST_SQL} WHERE a.id = $1`, [id]);
    const fresh = freshRows[0] || assignment;

    // login-20261023: due date from the start date, and the live count for self-ticking items.
    const start = fresh.start_date || fresh.created_at;
    for (const it of items) {
      it.due_on = (it.due_day != null && start) ? new Date(new Date(start).getTime() + it.due_day * 86400000).toISOString().slice(0, 10) : null;
      it.auto_progress = auto[it.item_id] || null;
    }
    res.json({
      ...withPct(fresh),
      can_sign_off: isManager(req.user) || isLeaderOf(req.user, assignment),
      can_mark_ready: isManager(req.user),
      is_owner: isOwnerOf(req.user, assignment),
      items,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /assignments (manager OR the named room_leader) — assign a template to a starter
router.post('/assignments', async (req, res) => {
  try {
    const db = getPool();
    const { staff_id, template_id, room_leader_id, start_date, target_complete_date } = req.body || {};
    if (!staff_id || !template_id) return res.status(400).json({ error: 'staff_id and template_id are required' });

    // Authorisation: managers may assign anyone; a non-manager may only create an
    // assignment they will personally lead (room_leader_id === themselves).
    if (!isManager(req.user)) {
      // 2026-10-26 (Toby): only the leadership team may lead an induction. Leading one gives
      // read/write on that starter's probation reviews, so a practitioner or apprentice must
      // not be able to make themselves a colleague's room leader.
      if (!hasRole(req.user, ['room_leader'])) {
        return res.status(403).json({ error: 'Only the leadership team can set up an induction' });
      }
      if (!room_leader_id || Number(room_leader_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: 'Only a manager, or the room leader for this starter, can create an assignment' });
      }
      // 29 Oct: staff_id was not limited, so a room leader could make themselves "induction
      // leader" of ANY colleague (another leader, a manager) and then read and write that
      // person's probation record. A room leader may lead a practitioner or apprentice in their
      // own room only.
      const { rows: [who] } = await db.query(
        `SELECT t.role AS target_role, t.room_id AS target_room, me.room_id AS my_room
           FROM staff t, staff me WHERE t.id = $1 AND me.id = $2`, [staff_id, req.user.id]);
      if (!who || Number(staff_id) === Number(req.user.id)
          || !['practitioner', 'apprentice'].includes(String(who.target_role))
          || who.my_room == null || Number(who.target_room) !== Number(who.my_room)) {
        return res.status(403).json({ error: 'A room leader can set up an induction only for a practitioner or apprentice in their own room' });
      }
    }

    const { rows: stExists } = await db.query('SELECT id FROM staff WHERE id=$1', [staff_id]);
    if (!stExists.length) return res.status(400).json({ error: 'staff_id not found' });
    const { rows: tExists } = await db.query('SELECT id FROM induction_templates WHERE id=$1', [template_id]);
    if (!tExists.length) return res.status(400).json({ error: 'template_id not found' });

    const { rows } = await db.query(`
      INSERT INTO induction_assignments
        (staff_id, template_id, assigned_by, room_leader_id, start_date, target_complete_date, status)
      VALUES ($1,$2,$3,$4,$5,$6,'in_progress')
      RETURNING *
    `, [
      staff_id, template_id, Number(req.user.id),
      room_leader_id || null,
      start_date || null,
      target_complete_date || null,
    ]);
    const assignment = rows[0];

    // Pre-create a pending progress row for every template item (idempotent).
    await db.query(`
      INSERT INTO induction_item_progress (assignment_id, item_id, status)
      SELECT $1, ti.id, 'pending'
      FROM induction_template_items ti
      WHERE ti.template_id = $2
      ON CONFLICT (assignment_id, item_id) DO NOTHING
    `, [assignment.id, template_id]);

    res.status(201).json(assignment);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /assignments/:id/summary — % complete + counts by status
router.get('/assignments/:id/summary', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { rows: aRows } = await db.query('SELECT * FROM induction_assignments WHERE id=$1', [id]);
    if (!aRows.length) return res.status(404).json({ error: 'Assignment not found' });
    if (!canViewAssignment(req.user, aRows[0])) return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM induction_template_items ti WHERE ti.template_id = $2)::int AS total,
        COUNT(*) FILTER (WHERE ip.status = 'pending')::int     AS pending,
        COUNT(*) FILTER (WHERE ip.status = 'in_progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE ip.status = 'done')::int        AS done,
        COUNT(*) FILTER (WHERE ip.status = 'signed_off')::int  AS signed_off
      FROM induction_item_progress ip
      WHERE ip.assignment_id = $1
    `, [id, aRows[0].template_id]);
    const s = rows[0];
    const total = s.total || 0;
    const complete = (s.done || 0) + (s.signed_off || 0);
    res.json({
      assignment_id: id,
      total,
      counts: { pending: s.pending, in_progress: s.in_progress, done: s.done, signed_off: s.signed_off },
      pct_complete: total ? Math.round((complete / total) * 100) : 0,
      pct_signed_off: total ? Math.round(((s.signed_off || 0) / total) * 100) : 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /assignments/:id/sync — re-run the auto-complete engine on demand (used by
// the my-induction workbook right after finishing a course quiz or acknowledging
// a policy elsewhere, so "resume where you left off" reflects it immediately).
router.post('/assignments/:id/sync', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { rows: aRows } = await db.query('SELECT * FROM induction_assignments WHERE id=$1', [id]);
    if (!aRows.length) return res.status(404).json({ error: 'Assignment not found' });
    if (!canViewAssignment(req.user, aRows[0])) return res.status(403).json({ error: 'Forbidden' });

    await syncItemProgress(db, id);

    const { rows } = await db.query(`${ASSIGNMENT_LIST_SQL} WHERE a.id = $1`, [id]);
    res.json(withPct(rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// ITEM PROGRESS
// ============================================================================

// PATCH /item-progress/:id — update a single item's progress
//   own item        → may set 'in_progress' / 'done' (+ evidence_note)
//   manager/leader  → may also set 'signed_off' / 'pending'
router.patch('/item-progress/:id', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { status, evidence_note } = req.body || {};
    const validStatuses = ['pending', 'in_progress', 'done', 'signed_off'];
    if (status != null && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'status must be one of ' + validStatuses.join(', ') });
    }

    // Load the progress row + its assignment for authorisation
    const { rows: prRows } = await db.query(`
      SELECT ip.*, a.staff_id, a.room_leader_id
      FROM induction_item_progress ip
      JOIN induction_assignments a ON a.id = ip.assignment_id
      WHERE ip.id = $1
    `, [id]);
    if (!prRows.length) return res.status(404).json({ error: 'Progress row not found' });
    const pr = prRows[0];

    const mgr = isManager(req.user);
    const leader = isLeaderOf(req.user, pr);
    const owner = isOwnerOf(req.user, pr);

    // b313 — a sign-off-only item is not the starter's to move, in either
    // direction. Checked before the status branch below so it also covers an
    // owner trying 'in_progress' or 'pending' on it.
    if (status != null) {
      const refusal = signoffOnlyRefusal(await isSignoffOnlyItem(db, pr.item_id), { mgr, leader });
      if (refusal) return res.status(403).json(refusal);
      if (await isReadyItem(db, pr.item_id)) return res.status(409).json(READY_ITEM_REFUSAL);
    }

    if (status === 'signed_off') {
      if (!(mgr || leader)) return res.status(403).json({ error: 'Only a manager or the room leader can sign off an item' });
    } else if (status != null) {
      // pending / in_progress / done
      if (!(owner || mgr || leader)) return res.status(403).json({ error: 'Forbidden' });
    } else {
      // evidence_note-only update
      if (!(owner || mgr || leader)) return res.status(403).json({ error: 'Forbidden' });
    }

    // Build the update
    const sets = [];
    const params = [];
    let p = 1;
    if (status != null) {
      sets.push(`status = $${p++}`); params.push(status);
      if (status === 'done' || status === 'signed_off') {
        sets.push(`completed_at = COALESCE(completed_at, now())`);
      } else if (status === 'pending') {
        sets.push(`completed_at = NULL`);
      }
      if (status === 'signed_off') {
        sets.push(`signed_off_by = $${p++}`); params.push(Number(req.user.id));
        sets.push(`signed_off_at = now()`);
      } else {
        // clearing a sign-off when moved back
        sets.push(`signed_off_by = NULL`);
        sets.push(`signed_off_at = NULL`);
      }
    }
    if (evidence_note !== undefined) {
      sets.push(`evidence_note = $${p++}`); params.push(evidence_note || null);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(id);
    const { rows } = await db.query(
      `UPDATE induction_item_progress SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      params
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /assignments/:id/items/:itemId/progress — the id-AGNOSTIC write path (b313)
//
// WHY THIS EXISTS. The workbook GET returns two ids per row: `item_id` (the
// template item) and `progress_id` (the induction_item_progress row — null when
// no row has been created yet). PATCH /item-progress/:id above wants the SECOND.
// editions/hr/public/my-induction.html sent the FIRST, so every "Mark done" and
// every "Sign off" on the HR portal was dead. Proved on wren_dev, 2026-09-10:
//   PATCH /api/induction/item-progress/50   -> 404 {"error":"Progress row not found"}
//   PATCH /api/induction/item-progress/2488 -> 200  (the same item, the right id)
// and because Wren.api() rejects with the response BODY rather than an Error,
// the page reported "Could not update: undefined" — no clue what went wrong.
// (memory/reference_wren_api_rejects_with_body.md)
//
// Rather than leave three pages to remember which of two ids to send, this route
// takes the pair the workbook is actually about — the assignment and the
// template item — and UPSERTS. That also fixes a second, quieter gap: an item
// added to a template AFTER an assignment was created has no progress row at
// all, so PATCH could never reach it and the item could never be completed.
//
// Authorisation is identical to the PATCH above, plus the b313 signoff_only
// rule, plus one thing the PATCH cannot express: an owner's self-tick never
// downgrades a sign-off a manager has already given. (The same rule
// starter-pack.recordAck() applies to a pack acknowledgement.)
router.put('/assignments/:id/items/:itemId/progress', async (req, res) => {
  try {
    const db = getPool();
    const assignmentId = parseInt(req.params.id, 10);
    const itemId = parseInt(req.params.itemId, 10);
    const { status, evidence_note } = req.body || {};
    const validStatuses = ['pending', 'in_progress', 'done', 'signed_off'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'status must be one of ' + validStatuses.join(', ') });
    }

    const { rows: aRows } = await db.query('SELECT * FROM induction_assignments WHERE id=$1', [assignmentId]);
    if (!aRows.length) return res.status(404).json({ error: 'Assignment not found' });
    const a = aRows[0];

    const mgr = isManager(req.user);
    const leader = isLeaderOf(req.user, a);
    const owner = isOwnerOf(req.user, a);
    if (!(mgr || leader || owner)) return res.status(403).json({ error: 'Forbidden' });
    if (status === 'signed_off' && !(mgr || leader)) {
      return res.status(403).json({ error: 'Only a manager or the room leader can sign off an item' });
    }

    // The item must belong to THIS assignment's template. Without this check the
    // route would be a way to write a progress row onto somebody else's workbook
    // by pairing your own assignment id with their item id.
    const { rows: tiRows } = await db.query(
      'SELECT id FROM induction_template_items WHERE id=$1 AND template_id=$2', [itemId, a.template_id]);
    if (!tiRows.length) return res.status(404).json({ error: 'Item not found on this assignment' });

    const refusal = signoffOnlyRefusal(await isSignoffOnlyItem(db, itemId), { mgr, leader });
    if (refusal) return res.status(403).json(refusal);
    if (await isReadyItem(db, itemId)) return res.status(409).json(READY_ITEM_REFUSAL);

    const { rows: prev } = await db.query(
      'SELECT * FROM induction_item_progress WHERE assignment_id=$1 AND item_id=$2', [assignmentId, itemId]);
    if (prev.length && prev[0].status === 'signed_off' && !(mgr || leader)) {
      // Already signed off in person: report it plainly rather than silently
      // rewriting a manager's decision, and rather than erroring at somebody who
      // simply tapped an item that is already finished.
      return res.json({ ...prev[0], changed: false, reason: 'already signed off' });
    }

    const isDone = status === 'done' || status === 'signed_off';
    const isSigned = status === 'signed_off';
    const { rows } = await db.query(`
      INSERT INTO induction_item_progress
        (assignment_id, item_id, status, completed_at, signed_off_by, signed_off_at, evidence_note)
      VALUES ($1, $2, $3,
              CASE WHEN $4::boolean THEN now() ELSE NULL END,
              $5::int,
              CASE WHEN $6::boolean THEN now() ELSE NULL END,
              $7)
      ON CONFLICT (assignment_id, item_id) DO UPDATE SET
        status        = EXCLUDED.status,
        completed_at  = CASE WHEN $4::boolean
                               THEN COALESCE(induction_item_progress.completed_at, now())
                             ELSE NULL END,
        signed_off_by = EXCLUDED.signed_off_by,
        signed_off_at = CASE WHEN $6::boolean
                               THEN COALESCE(induction_item_progress.signed_off_at, now())
                             ELSE NULL END,
        evidence_note = COALESCE(EXCLUDED.evidence_note, induction_item_progress.evidence_note)
      RETURNING *`,
      [assignmentId, itemId, status, isDone, isSigned ? Number(req.user.id) : null, isSigned,
       evidence_note === undefined ? null : (evidence_note || null)]);

    // Re-run the auto-complete engine so the assignment closes itself the moment
    // the last required item lands — whichever of the three windows ticked it.
    await syncItemProgress(db, assignmentId);
    const { rows: fresh } = await db.query(`${ASSIGNMENT_LIST_SQL} WHERE a.id = $1`, [assignmentId]);

    res.json({ ...rows[0], changed: true, assignment: fresh.length ? withPct(fresh[0]) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /template-items/:id (manager) — the two flags a manager may flip on an
// existing template item without rebuilding the template: whether it is required
// at all, and whether it is signed off in person (b313). Nothing else is
// editable here on purpose — retitling an item would orphan the progress rows
// that the tokened welcome page and the starter pack address by title.
router.patch('/template-items/:id', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { signoff_only, required } = req.body || {};
    const sets = [];
    const params = [];
    let p = 1;
    if (typeof required === 'boolean') { sets.push(`required = $${p++}`); params.push(required); }
    if (typeof signoff_only === 'boolean') {
      if (!(await hasSignoffOnlyColumn(db))) {
        return res.status(409).json({
          error: 'signoff_only_unavailable',
          message: 'This setting needs migrations/2026-09-10-b313-induction-signoff-only.sql.',
        });
      }
      sets.push(`signoff_only = $${p++}`); params.push(signoff_only);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(id);
    const { rows } = await db.query(
      `UPDATE induction_template_items SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// PROBATION (PHASE 2) — probationary periods + scheduled reviews
//
//   managers                     → may create a probation period, record the
//                                  FINAL outcome (status), and author/complete reviews
//   room leader (of the starter) → may author/complete reviews for a starter they
//                                  lead (room_leader_id on that starter's induction
//                                  assignment), but may NOT set the final outcome
//   the starter                  → may VIEW their own probation (read-only)
//
// Review dates are auto-derived on POST (review_1 = start + length/3, review_2 =
// start + 2*length/3, final = start + length weeks). The three scheduled reviews
// are also created as probation_reviews rows so the timeline + /probation/due work
// immediately; ad-hoc reviews can be added later via POST /probation/:id/reviews.
// ============================================================================

const TERMINAL_STATUSES = ['passed', 'extended', 'failed', 'left'];
const PROBATION_STATUSES = ['active', ...TERMINAL_STATUSES];
const REVIEW_TYPES = ['review_1', 'review_2', 'final', 'ad_hoc'];

// Derive the three review dates from a start date + length in weeks.
function deriveReviewDates(startDate, lengthWeeks) {
  const lw = Number.isInteger(lengthWeeks) && lengthWeeks > 0 ? lengthWeeks : 26;
  const totalDays = lw * 7;
  const base = new Date(String(startDate).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(base.getTime())) return { review_1_date: null, review_2_date: null, final_review_date: null, length_weeks: lw };
  const add = (days) => {
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return {
    length_weeks: lw,
    review_1_date: add(Math.round(totalDays / 3)),
    review_2_date: add(Math.round((totalDays * 2) / 3)),
    final_review_date: add(totalDays),
  };
}

// Is `user` the room leader for `staffId` (via that starter's induction assignment)?
async function leadsStaff(db, userId, staffId) {
  const { rows } = await db.query(
    'SELECT 1 FROM induction_assignments WHERE staff_id = $1 AND room_leader_id = $2 LIMIT 1',
    [staffId, userId]
  );
  return rows.length > 0;
}

const PROBATION_SELECT = `
  SELECT p.id, p.staff_id, p.start_date, p.length_weeks,
         p.review_1_date, p.review_2_date, p.final_review_date,
         p.status, p.outcome_note, p.decided_by, p.decided_at, p.created_at,
         s.first_name || ' ' || s.last_name AS staff_name, s.role AS staff_role,
         rm.name AS room_name,
         db.first_name || ' ' || db.last_name AS decided_by_name,
         EXISTS (SELECT 1 FROM induction_assignments ia
                   WHERE ia.staff_id = p.staff_id AND ia.room_leader_id = $1) AS i_lead,
         (SELECT COUNT(*) FROM probation_reviews r
            WHERE r.probation_id = p.id AND r.completed_date IS NOT NULL)::int AS reviews_completed,
         (SELECT COUNT(*) FROM probation_reviews r WHERE r.probation_id = p.id)::int AS reviews_total
  FROM probation_periods p
  JOIN staff s ON s.id = p.staff_id
  LEFT JOIN rooms rm ON rm.id = s.room_id
  LEFT JOIN staff db ON db.id = p.decided_by
`;

// GET /probation?staff_id= — managers see all (or filtered); others see own + led
router.get('/probation', async (req, res) => {
  try {
    const db = getPool();
    const uid = Number(req.user.id);
    const mgr = isManager(req.user);
    const qStaff = req.query.staff_id ? parseInt(req.query.staff_id, 10) : null;
    let where = 'WHERE COALESCE(s.is_demo, false) = false', params = [uid];
    if (mgr) {
      if (qStaff) { where = 'WHERE p.staff_id = $2'; params.push(qStaff); }
    } else {
      where = `WHERE (p.staff_id = $1 OR EXISTS (
                 SELECT 1 FROM induction_assignments ia
                 WHERE ia.staff_id = p.staff_id AND ia.room_leader_id = $1))`;
      if (qStaff) { where += ' AND p.staff_id = $2'; params.push(qStaff); }
    }
    const { rows } = await db.query(
      `${PROBATION_SELECT} ${where} ORDER BY p.status, p.final_review_date NULLS LAST, p.id DESC`,
      params
    );
    res.json(rows.map(r => ({ ...r, can_review: mgr || r.i_lead, can_set_outcome: mgr })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /probation/due — uncompleted reviews scheduled within the next 14 days
// (includes overdue). NOTE: registered before /probation/:id so 'due' is literal.
router.get('/probation/due', async (req, res) => {
  try {
    const db = getPool();
    const uid = Number(req.user.id);
    const mgr = isManager(req.user);
    const params = [];
    let scope = '';
    if (!mgr) {
      params.push(uid);
      scope = `AND (p.staff_id = $1 OR EXISTS (
                 SELECT 1 FROM induction_assignments ia
                 WHERE ia.staff_id = p.staff_id AND ia.room_leader_id = $1))`;
    }
    const { rows } = await db.query(`
      SELECT r.id AS review_id, r.probation_id, r.review_type, r.scheduled_date,
             r.completed_date, p.staff_id, p.status AS probation_status,
             s.first_name || ' ' || s.last_name AS staff_name,
             rm.name AS room_name,
             rl.first_name || ' ' || rl.last_name AS room_leader_name,
             (r.scheduled_date - CURRENT_DATE) AS days_until
      FROM probation_reviews r
      JOIN probation_periods p ON p.id = r.probation_id
      JOIN staff s ON s.id = p.staff_id
      LEFT JOIN rooms rm ON rm.id = s.room_id
      LEFT JOIN LATERAL (
        SELECT ia.room_leader_id FROM induction_assignments ia
        WHERE ia.staff_id = p.staff_id AND ia.room_leader_id IS NOT NULL
        ORDER BY ia.id DESC LIMIT 1
      ) lead ON true
      LEFT JOIN staff rl ON rl.id = lead.room_leader_id
      WHERE r.completed_date IS NULL
        AND r.scheduled_date IS NOT NULL
        AND r.scheduled_date <= CURRENT_DATE + INTERVAL '14 days'
        AND p.status = 'active'
        AND COALESCE(s.is_demo, false) = false
        ${scope}
      ORDER BY r.scheduled_date ASC, r.id ASC
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /probation/:id — period + its reviews
router.get('/probation/:id', async (req, res) => {
  try {
    const db = getPool();
    const uid = Number(req.user.id);
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query(`${PROBATION_SELECT} WHERE p.id = $2`, [uid, id]);
    if (!rows.length) return res.status(404).json({ error: 'Probation period not found' });
    const period = rows[0];
    const mgr = isManager(req.user);
    const canView = mgr || period.i_lead || Number(period.staff_id) === uid;
    if (!canView) return res.status(403).json({ error: 'Forbidden' });

    const { rows: reviews } = await db.query(`
      SELECT r.*, rv.first_name || ' ' || rv.last_name AS reviewer_name
      FROM probation_reviews r
      LEFT JOIN staff rv ON rv.id = r.reviewer_id
      WHERE r.probation_id = $1
      ORDER BY
        CASE r.review_type WHEN 'review_1' THEN 1 WHEN 'review_2' THEN 2 WHEN 'final' THEN 3 ELSE 4 END,
        r.scheduled_date NULLS LAST, r.id
    `, [id]);

    res.json({
      ...period,
      can_review: mgr || period.i_lead,
      can_set_outcome: mgr,
      reviews,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /probation (manager only) — start a probation period; auto-derive dates +
// create the three scheduled review rows.
router.post('/probation', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { staff_id, start_date, length_weeks } = req.body || {};
    if (!staff_id) return res.status(400).json({ error: 'staff_id is required' });
    if (!start_date) return res.status(400).json({ error: 'start_date is required' });
    if (Number(staff_id) === 1) return res.status(400).json({ error: 'Cannot create a probation period for the owner account' });

    const { rows: stExists } = await db.query('SELECT id FROM staff WHERE id=$1', [staff_id]);
    if (!stExists.length) return res.status(400).json({ error: 'staff_id not found' });

    const d = deriveReviewDates(start_date, length_weeks);
    if (!d.review_1_date) return res.status(400).json({ error: 'start_date must be a valid date (YYYY-MM-DD)' });

    const { rows } = await db.query(`
      INSERT INTO probation_periods
        (staff_id, start_date, length_weeks, review_1_date, review_2_date, final_review_date, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'active')
      RETURNING *
    `, [staff_id, String(start_date).slice(0, 10), d.length_weeks, d.review_1_date, d.review_2_date, d.final_review_date]);
    const period = rows[0];

    // Create the three scheduled (uncompleted) review rows.
    await db.query(`
      INSERT INTO probation_reviews (probation_id, review_type, scheduled_date)
      VALUES ($1,'review_1',$2), ($1,'review_2',$3), ($1,'final',$4)
    `, [period.id, d.review_1_date, d.review_2_date, d.final_review_date]);

    res.status(201).json(period);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /probation/:id (manager only) — record the final outcome / adjust schedule
router.patch('/probation/:id', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only — only a manager can set a probation outcome' });
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { status, outcome_note, length_weeks, review_1_date, review_2_date, final_review_date } = req.body || {};
    if (status != null && !PROBATION_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status must be one of ' + PROBATION_STATUSES.join(', ') });
    }
    const { rows: exists } = await db.query('SELECT id FROM probation_periods WHERE id=$1', [id]);
    if (!exists.length) return res.status(404).json({ error: 'Probation period not found' });

    const sets = [], params = [];
    let p = 1;
    if (status != null) {
      sets.push(`status = $${p++}`); params.push(status);
      if (TERMINAL_STATUSES.includes(status)) {
        sets.push(`decided_by = $${p++}`); params.push(Number(req.user.id));
        sets.push('decided_at = now()');
      } else {
        // back to active — clear the decision stamp
        sets.push('decided_by = NULL');
        sets.push('decided_at = NULL');
      }
    }
    if (outcome_note !== undefined) { sets.push(`outcome_note = $${p++}`); params.push(outcome_note || null); }
    if (Number.isInteger(length_weeks)) { sets.push(`length_weeks = $${p++}`); params.push(length_weeks); }
    if (review_1_date !== undefined) { sets.push(`review_1_date = $${p++}`); params.push(review_1_date || null); }
    if (review_2_date !== undefined) { sets.push(`review_2_date = $${p++}`); params.push(review_2_date || null); }
    if (final_review_date !== undefined) { sets.push(`final_review_date = $${p++}`); params.push(final_review_date || null); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(id);
    const { rows } = await db.query(
      `UPDATE probation_periods SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`, params
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /probation/:id/reviews — add a review (manager OR the starter's room leader)
router.post('/probation/:id/reviews', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { rows: pRows } = await db.query('SELECT id, staff_id FROM probation_periods WHERE id=$1', [id]);
    if (!pRows.length) return res.status(404).json({ error: 'Probation period not found' });

    const mgr = isManager(req.user);
    const leads = mgr || await leadsStaff(db, Number(req.user.id), pRows[0].staff_id);
    if (!leads) return res.status(403).json({ error: 'Only a manager or the starter\'s room leader can author a review' });

    const { review_type, scheduled_date, completed_date, reviewer_id,
            rating, strengths, development_areas, actions, source_refs } = req.body || {};
    const rt = review_type || 'ad_hoc';
    if (!REVIEW_TYPES.includes(rt)) return res.status(400).json({ error: 'review_type must be one of ' + REVIEW_TYPES.join(', ') });

    const reviewer = completed_date
      ? (reviewer_id || Number(req.user.id))
      : (reviewer_id || null);

    const { rows } = await db.query(`
      INSERT INTO probation_reviews
        (probation_id, review_type, scheduled_date, completed_date, reviewer_id,
         rating, strengths, development_areas, actions, source_refs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [
      id, rt, scheduled_date || null, completed_date || null, reviewer,
      rating || null, strengths || null, development_areas || null, actions || null,
      Array.isArray(source_refs) ? source_refs : null,
    ]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /reviews/:id — update / complete a review (manager OR the room leader)
router.patch('/reviews/:id', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { rows: rRows } = await db.query(`
      SELECT r.*, p.staff_id FROM probation_reviews r
      JOIN probation_periods p ON p.id = r.probation_id
      WHERE r.id = $1
    `, [id]);
    if (!rRows.length) return res.status(404).json({ error: 'Review not found' });
    const review = rRows[0];

    const mgr = isManager(req.user);
    const leads = mgr || await leadsStaff(db, Number(req.user.id), review.staff_id);
    if (!leads) return res.status(403).json({ error: 'Only a manager or the starter\'s room leader can update a review' });

    const { scheduled_date, completed_date, reviewer_id, rating,
            strengths, development_areas, actions, source_refs, review_type } = req.body || {};
    if (review_type != null && !REVIEW_TYPES.includes(review_type)) {
      return res.status(400).json({ error: 'review_type must be one of ' + REVIEW_TYPES.join(', ') });
    }

    const sets = [], params = [];
    let p = 1;
    if (review_type !== undefined)       { sets.push(`review_type = $${p++}`); params.push(review_type); }
    if (scheduled_date !== undefined)    { sets.push(`scheduled_date = $${p++}`); params.push(scheduled_date || null); }
    if (completed_date !== undefined) {
      sets.push(`completed_date = $${p++}`); params.push(completed_date || null);
      // Stamp reviewer on completion if not already set / not explicitly provided.
      if (completed_date && reviewer_id === undefined && !review.reviewer_id) {
        sets.push(`reviewer_id = $${p++}`); params.push(Number(req.user.id));
      }
    }
    if (reviewer_id !== undefined)       { sets.push(`reviewer_id = $${p++}`); params.push(reviewer_id || null); }
    if (rating !== undefined)            { sets.push(`rating = $${p++}`); params.push(rating || null); }
    if (strengths !== undefined)         { sets.push(`strengths = $${p++}`); params.push(strengths || null); }
    if (development_areas !== undefined) { sets.push(`development_areas = $${p++}`); params.push(development_areas || null); }
    if (actions !== undefined)           { sets.push(`actions = $${p++}`); params.push(actions || null); }
    if (source_refs !== undefined)       { sets.push(`source_refs = $${p++}`); params.push(Array.isArray(source_refs) ? source_refs : null); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(id);
    const { rows } = await db.query(
      `UPDATE probation_reviews SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`, params
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// APPRENTICE EVENTS (PHASE 3) — assessor-visit & training-day log
//
//   managers                     → see all events; may log / edit / delete any
//   room leader (of the starter) → may log / edit / delete events for a starter
//                                  they lead (room_leader_id on that starter's
//                                  induction assignment); sees own + led
//   the starter                  → sees their OWN events (read-only)
//   creator (created_by)         → may edit / delete an event they logged
//
// READ-ONLY w.r.t. email: this section only READS email_triage to surface
// apprentice-related candidates, and writes exactly ONE flag (apprentice_relevant
// + apprentice_event_type for context) when a manager attaches an email to an
// event. It NEVER sends/replies/drafts outbound email and does NOT touch the live
// email-triage n8n workflow. Swift (the provider) has no public API, so this
// MIRRORS apprentice progress in Wren rather than integrating with their portal.
// ============================================================================

const EVENT_TYPES = ['assessor_visit', 'training_day', 'epa', 'review', 'other'];

// Subject/body_preview substrings that mark a triaged email as apprentice-related.
const APPRENTICE_PATTERNS = [
  '%assessor%', '%off the job%', '%off-the-job%', '%training day%',
  '%EPA%', '%end point%', '%apprentic%', '%Swift%',
];

// Event rows with apprentice + creator names, room, and (subject-only) linked-email meta.
// b338 (2026-09-17, decision 4): a new link (linked_comms_email_id) points at
// the live comms_email_queue table; an OLD link (linked_email_triage_id) still
// points at the frozen legacy table and keeps resolving — nothing is migrated
// or re-linked, both columns just stay readable side by side. COALESCE picks
// whichever one is set; an event can only ever have one.
const EVENTS_SELECT = `
  SELECT e.id, e.staff_id, e.event_type, e.title, e.event_date, e.event_time,
         e.location, e.provider, e.notes, e.otj_hours, e.linked_email_triage_id,
         e.linked_comms_email_id,
         e.created_by, e.created_at,
         s.first_name || ' ' || s.last_name AS staff_name, s.role AS staff_role,
         rm.name AS room_name,
         cb.first_name || ' ' || cb.last_name AS created_by_name,
         COALESCE(cq.subject, et.subject)         AS linked_email_subject,
         COALESCE(cq.from_name, et.from_name)     AS linked_email_from,
         COALESCE(cq.received_at, et.received_at) AS linked_email_received_at
  FROM apprentice_events e
  JOIN staff s ON s.id = e.staff_id
  LEFT JOIN rooms rm ON rm.id = s.room_id
  LEFT JOIN staff cb ON cb.id = e.created_by
  LEFT JOIN email_triage et ON et.id = e.linked_email_triage_id
  LEFT JOIN comms_email_queue cq ON cq.id = e.linked_comms_email_id
`;

// May `user` log/edit/delete an event for `staffId`? (manager or that starter's leader)
async function canManageEventFor(db, user, staffId) {
  if (isManager(user)) return true;
  return await leadsStaff(db, Number(user.id), staffId);
}

// GET /events?staff_id= — managers see all (or filtered); others see own + led
router.get('/events', async (req, res) => {
  try {
    const db = getPool();
    const uid = Number(req.user.id);
    const mgr = isManager(req.user);
    const qStaff = req.query.staff_id ? parseInt(req.query.staff_id, 10) : null;
    let where = '', params = [];
    if (mgr) {
      if (qStaff) { where = 'WHERE e.staff_id = $1'; params = [qStaff]; }
    } else {
      params = [uid];
      where = `WHERE (e.staff_id = $1 OR EXISTS (
                 SELECT 1 FROM induction_assignments ia
                 WHERE ia.staff_id = e.staff_id AND ia.room_leader_id = $1))`;
      if (qStaff) { params.push(qStaff); where += ' AND e.staff_id = $2'; }
    }
    const { rows } = await db.query(
      `${EVENTS_SELECT} ${where}
       ORDER BY e.event_date DESC NULLS LAST, e.event_time DESC NULLS LAST, e.id DESC`,
      params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /events/upcoming — events in the next 30 days (incl. today) for the dashboard.
// Registered before any /events/:id route so 'upcoming' stays literal.
router.get('/events/upcoming', async (req, res) => {
  try {
    const db = getPool();
    const uid = Number(req.user.id);
    const mgr = isManager(req.user);
    const qStaff = req.query.staff_id ? parseInt(req.query.staff_id, 10) : null;
    const params = [];
    let scope = '';
    if (!mgr) {
      params.push(uid);
      scope = `AND (e.staff_id = $${params.length} OR EXISTS (
                 SELECT 1 FROM induction_assignments ia
                 WHERE ia.staff_id = e.staff_id AND ia.room_leader_id = $${params.length}))`;
    }
    let staffFilter = '';
    if (qStaff) { params.push(qStaff); staffFilter = `AND e.staff_id = $${params.length}`; }
    const { rows } = await db.query(
      `${EVENTS_SELECT}
       WHERE e.event_date IS NOT NULL
         AND e.event_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
         ${scope} ${staffFilter}
       ORDER BY e.event_date ASC, e.event_time ASC NULLS LAST, e.id ASC`,
      params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /events (manager OR the starter's room leader) — log an event
router.post('/events', async (req, res) => {
  try {
    const db = getPool();
    const { staff_id, event_type, title, event_date, event_time, location, provider, notes, otj_hours } = req.body || {};
    if (!staff_id) return res.status(400).json({ error: 'staff_id is required' });
    if (!event_type || !EVENT_TYPES.includes(event_type)) {
      return res.status(400).json({ error: 'event_type must be one of ' + EVENT_TYPES.join(', ') });
    }
    if (!event_date) return res.status(400).json({ error: 'event_date is required' });

    const { rows: stExists } = await db.query('SELECT id FROM staff WHERE id=$1', [staff_id]);
    if (!stExists.length) return res.status(400).json({ error: 'staff_id not found' });

    if (!(await canManageEventFor(db, req.user, staff_id))) {
      return res.status(403).json({ error: "Only a manager or the starter's room leader can log an event" });
    }

    let otj = null;
    if (otj_hours !== undefined && otj_hours !== null && otj_hours !== '') {
      otj = Number(otj_hours);
      if (!isFinite(otj) || otj < 0) return res.status(400).json({ error: 'otj_hours must be a non-negative number' });
    }
    const prov = (provider && String(provider).trim()) ? String(provider).trim() : 'Swift';

    const { rows } = await db.query(`
      INSERT INTO apprentice_events
        (staff_id, event_type, title, event_date, event_time, location, provider, notes, otj_hours, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
    `, [
      staff_id, event_type, title || null, String(event_date).slice(0, 10),
      event_time || null, location || null, prov, notes || null, otj, Number(req.user.id),
    ]);
    const { rows: full } = await db.query(`${EVENTS_SELECT} WHERE e.id = $1`, [rows[0].id]);
    res.status(201).json(full[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /events/:id (manager, the creator, or the starter's room leader)
router.patch('/events/:id', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { rows: evRows } = await db.query('SELECT id, staff_id, created_by FROM apprentice_events WHERE id=$1', [id]);
    if (!evRows.length) return res.status(404).json({ error: 'Event not found' });
    const ev = evRows[0];

    const allowed = isManager(req.user)
      || Number(ev.created_by) === Number(req.user.id)
      || await leadsStaff(db, Number(req.user.id), ev.staff_id);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });

    const { event_type, title, event_date, event_time, location, provider, notes, otj_hours } = req.body || {};
    if (event_type != null && !EVENT_TYPES.includes(event_type)) {
      return res.status(400).json({ error: 'event_type must be one of ' + EVENT_TYPES.join(', ') });
    }
    const sets = [], params = [];
    let p = 1;
    if (event_type !== undefined) { sets.push(`event_type = $${p++}`); params.push(event_type); }
    if (title !== undefined)      { sets.push(`title = $${p++}`); params.push(title || null); }
    if (event_date !== undefined) { sets.push(`event_date = $${p++}`); params.push(event_date ? String(event_date).slice(0, 10) : null); }
    if (event_time !== undefined) { sets.push(`event_time = $${p++}`); params.push(event_time || null); }
    if (location !== undefined)   { sets.push(`location = $${p++}`); params.push(location || null); }
    if (provider !== undefined)   { sets.push(`provider = $${p++}`); params.push((provider && String(provider).trim()) ? String(provider).trim() : 'Swift'); }
    if (notes !== undefined)      { sets.push(`notes = $${p++}`); params.push(notes || null); }
    if (otj_hours !== undefined) {
      let otj = null;
      if (otj_hours !== null && otj_hours !== '') {
        otj = Number(otj_hours);
        if (!isFinite(otj) || otj < 0) return res.status(400).json({ error: 'otj_hours must be a non-negative number' });
      }
      sets.push(`otj_hours = $${p++}`); params.push(otj);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(id);
    await db.query(`UPDATE apprentice_events SET ${sets.join(', ')} WHERE id = $${p}`, params);
    const { rows: full } = await db.query(`${EVENTS_SELECT} WHERE e.id = $1`, [id]);
    res.json(full[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /events/:id (manager, the creator, or the starter's room leader)
// Hard-delete is fine here — apprentice_events are operational log rows, not
// protected * production records. ONLY the event row is removed; the linked
// email_triage row (if any) is untouched.
router.delete('/events/:id', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { rows: evRows } = await db.query('SELECT id, staff_id, created_by FROM apprentice_events WHERE id=$1', [id]);
    if (!evRows.length) return res.status(404).json({ error: 'Event not found' });
    const ev = evRows[0];

    const allowed = isManager(req.user)
      || Number(ev.created_by) === Number(req.user.id)
      || await leadsStaff(db, Number(req.user.id), ev.staff_id);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });

    await db.query('DELETE FROM apprentice_events WHERE id=$1', [id]);
    res.json({ deleted: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /triage/apprentice-candidates (manager only) — READ-ONLY.
// Recent inbound emails (category staff/other) that look assessor/training/
// apprenticeship related and are not yet linked to an event. Returns subject +
// preview only — never the full body.
// b338 (2026-09-17, decision 4): moved off the legacy, frozen email_triage
// table onto the live comms_email_queue pipeline — body_preview → snippet,
// linked_email_triage_id → linked_comms_email_id. Old links (made before this
// build) still resolve via EVENTS_SELECT's COALESCE; this endpoint just stops
// offering the dead table as new candidates.
router.get('/triage/apprentice-candidates', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    // b487 (2026-10-12): excludes confidential mailboxes (toby@) — no per-viewer check here.
    // b486c (2026-10-13, defect 9): ALLOW-list, not a deny-list — see
    // src/lib/inbox-access.js's nonConfidentialMailboxAddresses() header comment.
    const _allowBoxes = await require('../lib/inbox-access').nonConfidentialMailboxAddresses(db);
    const { rows } = await db.query(`
      SELECT cq.id, cq.received_at, cq.from_name, cq.subject, cq.snippet AS body_preview
      FROM comms_email_queue cq
      WHERE cq.category IN ('staff','other')
        AND (cq.subject ILIKE ANY($1) OR cq.snippet ILIKE ANY($1))
        AND COALESCE(cq.apprentice_relevant, false) = false
        AND cq.received_at >= now() - INTERVAL '18 months'
        AND (cq.mailbox IS NULL OR cq.mailbox = ANY($2))
        AND NOT EXISTS (SELECT 1 FROM apprentice_events ae WHERE ae.linked_comms_email_id = cq.id)
      ORDER BY cq.received_at DESC NULLS LAST
      LIMIT 30
    `, [APPRENTICE_PATTERNS, _allowBoxes]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /events/:id/link-email (manager only) — attach an email to an event.
// b338 (2026-09-17, decision 4): this now writes to comms_email_queue, not the
// legacy email_triage table — same param name (triage_id) for backward
// compatibility with the new-starters.html caller, but the id it refers to now
// comes from the candidates list above, which is comms_email_queue-backed.
// Sets the flag columns (apprentice_relevant=true, apprentice_event_type for
// context) and stores the reference on the event; does NOT alter the email's
// classification or send anything. Runs in a transaction so the two writes
// stay consistent.
router.post('/events/:id/link-email', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const db = getPool();
  let client;
  try {
    const id = parseInt(req.params.id, 10);
    const triageId = parseInt((req.body || {}).triage_id, 10);
    if (!triageId) return res.status(400).json({ error: 'triage_id is required' });

    const { rows: evRows } = await db.query('SELECT id, event_type FROM apprentice_events WHERE id=$1', [id]);
    if (!evRows.length) return res.status(404).json({ error: 'Event not found' });
    const { rows: trRows } = await db.query('SELECT id FROM comms_email_queue WHERE id=$1', [triageId]);
    if (!trRows.length) return res.status(400).json({ error: 'triage_id not found' });

    client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE apprentice_events SET linked_comms_email_id=$1 WHERE id=$2', [triageId, id]);
      await client.query(
        'UPDATE comms_email_queue SET apprentice_relevant=true, apprentice_event_type=COALESCE(apprentice_event_type,$1) WHERE id=$2',
        [evRows[0].event_type, triageId]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    }

    const { rows: full } = await db.query(`${EVENTS_SELECT} WHERE e.id = $1`, [id]);
    res.json(full[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (client) client.release();
  }
});

// ============================================================================
// b275 — ONBOARD A NEW STARTER BY EMAIL (2026-09-04)
//
// Toby: "Maybe like eylog so i put her email in, it emails her how to login to
// wren and access induction etc."
//
// One manager action, five effects:
//   1. a staff row (INACTIVE — cannot log in until approved), created or reused
//   2. an onboarding_invites row: single-use, expiring token, linked to that row
//   3. an induction_assignments row + a pending progress row per template item
//   4. a welcome email (src/lib/starter-welcome.js → gmail-sender)
//   5. an audit entry
//
// APPENDED, not merged into the existing routes. POST /assignments above is
// unchanged and still the way to assign a workbook to somebody who already works
// here; this is the path for somebody who does not exist in Wren yet.
//
// The token gates ONLY this starter's own induction content and their own details
// form (both in src/routes/onboarding-public.js). It is not a credential: no
// authed route accepts it, so it cannot reach /api/children, another staff
// member's record, or any part of the EY portal.
// ============================================================================

const { ensureTable: ensureInviteTable, mintToken } = require('../lib/onboarding-invites-db');
const { composeWelcomeEmail, sendWelcomeEmail } = require('../lib/starter-welcome');
// b288 — what the starter is actually sent: handbook + the two inductions Toby
// does on paper. A table, not a constant, so the set is a manager's to change.
const starterPack = require('../lib/starter-pack');

const STARTER_TOKEN_DAYS = parseInt(process.env.STARTER_INVITE_DAYS || '21', 10);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Where the tokened pages live, and where the starter will eventually log in.
// Resolved the same way onboarding-invites.js resolves its invite host: a
// live-editable settings row first, then env, then a sane default — so a tenant
// can repoint it without a deploy.
async function starterUrls(db) {
  async function setting(key) {
    try {
      const { rows } = await db.query('SELECT value FROM settings WHERE key=$1 LIMIT 1', [key]);
      return rows[0]?.value || null;
    } catch (_) { return null; }
  }
  const publicHost = (await setting('onboard_public_host'))
    || process.env.ONBOARD_PUBLIC_HOST || process.env.PARENTS_DOMAIN || process.env.ADMIN_DOMAIN || 'localhost';
  // The staff-facing portal a practitioner/apprentice logs into (Nest / EY).
  const portalUrl = (await setting('staff_portal_url'))
    || (process.env.EY_DOMAIN ? `https://${process.env.EY_DOMAIN}` : null)
    || `https://${publicHost}`;
  const settingName = (await setting('nursery_name')) || 'Your Nursery';
  return {
    publicHost,
    portalUrl,
    settingName,
    // /onboard/ — the ONLY path the public nursery site proxies same-origin
    // (nginx.conf 2026-07-15). A /starter/ link would 404 for exactly the
    // person it is addressed to: somebody with no Cloudflare Access session.
    inductionUrl: token => `https://${publicHost}/onboard/induction?token=${token}`,
  };
}

function roleLabel(role, employmentType) {
  const map = {
    apprentice: 'Apprentice',
    practitioner: 'Early Years Practitioner',
    room_leader: 'Room Leader',
    cook: 'Cook',
    manager: 'Manager',
    admin: 'Administrator',
  };
  return map[role] || (employmentType || 'team member');
}

// Roles this route is allowed to create. Deliberately narrow: b275 onboards floor
// staff. Nobody gets minted straight into a management role by an email form.
const STARTER_ROLES = ['apprentice', 'practitioner', 'room_leader', 'cook'];

// POST /starters — the whole onboard-by-email action.
// Body: { email, first_name, last_name, role?, start_date?, room_id?,
//         room_leader_id?, employment_type?, template_id?, target_complete_date? }
router.post('/starters', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const db = getPool();
  const b = req.body || {};

  const email = String(b.email || '').trim().toLowerCase().slice(0, 320);
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email address is required' });
  const first = String(b.first_name || '').trim().slice(0, 120);
  const last = String(b.last_name || '').trim().slice(0, 120);
  if (!first || !last) return res.status(400).json({ error: 'First and last name are required' });

  const role = STARTER_ROLES.includes(b.role) ? b.role : 'practitioner';
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.start_date || '')) ? b.start_date : null;
  const roomId = b.room_id ? parseInt(b.room_id, 10) : null;
  const roomLeaderId = b.room_leader_id ? parseInt(b.room_leader_id, 10) : null;
  const employmentType = String(b.employment_type || '').trim().slice(0, 60) || null;
  const templateId = b.template_id ? parseInt(b.template_id, 10) : 1;

  try {
    await ensureInviteTable();

    // ── 1. the staff record ───────────────────────────────────────────────────
    // Reuse an existing row when the email already belongs to somebody — a
    // returning starter, or a manager who added them by hand five minutes ago.
    // Reuse is a MERGE of the blanks only: an existing name, role or room is
    // never overwritten from this form, and pin_hash is never touched at all.
    const { rows: existing } = await db.query(
      'SELECT * FROM staff WHERE lower(email) = $1 ORDER BY id LIMIT 1', [email]);
    let staff, reused = false;
    if (existing.length) {
      staff = existing[0];
      reused = true;
      if (Number(staff.id) === 1) {
        return res.status(409).json({ error: 'That email belongs to the setting owner — pick a different address.' });
      }
      if (staff.is_active) {
        return res.status(409).json({ error: `${staff.first_name} ${staff.last_name} is already an active member of staff. Use "Assign template to starter" instead.` });
      }
      const { rows: upd } = await db.query(`
        UPDATE staff SET
          first_name      = COALESCE(NULLIF($2,''), first_name),
          last_name       = COALESCE(NULLIF($3,''), last_name),
          role            = COALESCE(role, $4),
          room_id         = COALESCE(room_id, $5),
          contract_start  = COALESCE(contract_start, $6::date),
          employment_type = COALESCE(employment_type, $7),
          updated_at      = NOW()
        WHERE id = $1 RETURNING *`,
        [staff.id, first, last, role, roomId, startDate, employmentType]);
      staff = upd[0];
    } else {
      const { rows: ins } = await db.query(`
        INSERT INTO staff (first_name, last_name, email, role, room_id, contract_start,
                           employment_type, is_active, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6::date,$7,false,NOW(),NOW())
        RETURNING *`,
        [first, last, email, role, roomId, startDate, employmentType]);
      staff = ins[0];
    }

    // ── 2. the invite token ───────────────────────────────────────────────────
    const token = mintToken();
    const { rows: invRows } = await db.query(`
      INSERT INTO onboarding_invites
        (type, token, email, note, status, created_by, expires_at, staff_id)
      VALUES ('staff',$1,$2,$3,'pending',$4, now() + ($5 || ' days')::interval, $6)
      RETURNING id, token, expires_at`,
      [token, email, `New starter: ${first} ${last}`, Number(req.user.id), String(STARTER_TOKEN_DAYS), staff.id]);
    const invite = invRows[0];

    // ── 3. the induction assignment ───────────────────────────────────────────
    // Reuse an open assignment on the same template rather than stacking a
    // second workbook on the same person (a resend, or a manager clicking twice).
    const { rows: tpl } = await db.query(
      'SELECT id, name FROM induction_templates WHERE id=$1', [templateId]);
    if (!tpl.length) return res.status(400).json({ error: 'template_id not found' });

    const { rows: openA } = await db.query(
      `SELECT * FROM induction_assignments
        WHERE staff_id=$1 AND template_id=$2 AND status <> 'complete'
        ORDER BY id DESC LIMIT 1`, [staff.id, templateId]);
    let assignment;
    if (openA.length) {
      assignment = openA[0];
    } else {
      const target = /^\d{4}-\d{2}-\d{2}$/.test(String(b.target_complete_date || ''))
        ? b.target_complete_date
        : (startDate ? null : null);
      const { rows: aIns } = await db.query(`
        INSERT INTO induction_assignments
          (staff_id, template_id, assigned_by, room_leader_id, start_date, target_complete_date, status)
        VALUES ($1,$2,$3,$4,$5::date,
                COALESCE($6::date, ($5::date + interval '28 days')::date),
                'in_progress')
        RETURNING *`,
        [staff.id, templateId, Number(req.user.id), roomLeaderId || null, startDate, target]);
      assignment = aIns[0];
    }
    // Pre-create a pending progress row per item (idempotent — same statement the
    // existing POST /assignments uses).
    await db.query(`
      INSERT INTO induction_item_progress (assignment_id, item_id, status)
      SELECT $1, ti.id, 'pending'
      FROM induction_template_items ti
      WHERE ti.template_id = $2
      ON CONFLICT (assignment_id, item_id) DO NOTHING`, [assignment.id, templateId]);

    await db.query('UPDATE onboarding_invites SET assignment_id=$1 WHERE id=$2', [assignment.id, invite.id]);

    // ── 3b. the document pack (b288) ──────────────────────────────────────────
    // One assignment per pack document that has a checklist behind it, so
    // "fire induction done, with dates" has a real row to live on. Never a
    // parallel table — this is the same induction_assignments /
    // induction_item_progress pair the room leader already ticks.
    // Failure here must not lose the starter: the record, invite and workbook
    // are already committed, and a manager can re-attach with a resend.
    let pack = [];
    try {
      pack = await starterPack.ensurePackAssignments(db, {
        staffId: staff.id,
        assignedBy: Number(req.user.id),
        roomLeaderId: roomLeaderId || assignment.room_leader_id || null,
        startDate: startDate,
        targetCompleteDate: null,
        skipTemplateId: templateId,   // the 4-week workbook is assigned above
      });
    } catch (e) {
      console.error('[induction/starters] pack assignments failed:', e.message);
    }

    // ── 4. the email ──────────────────────────────────────────────────────────
    const urls = await starterUrls(db);
    const leader = roomLeaderId || assignment.room_leader_id;
    const { rows: leaderRow } = leader
      ? await db.query('SELECT first_name, last_name FROM staff WHERE id=$1', [leader])
      : { rows: [] };
    const { rows: meRow } = await db.query(
      'SELECT first_name, last_name, email FROM staff WHERE id=$1', [Number(req.user.id)]);

    const packDocs = await starterPack.activeDocuments(db).catch(() => []);
    const packLinks = starterPack.documentLinks(packDocs, urls.publicHost, token);

    const parts = composeWelcomeEmail({
      firstName: staff.preferred_name || first,
      settingName: urls.settingName,
      portalUrl: urls.portalUrl,
      inductionUrl: urls.inductionUrl(token),
      roleLabel: roleLabel(staff.role, employmentType),
      startDate: startDate || staff.contract_start,
      expiresAt: invite.expires_at,
      managerName: meRow[0] ? `${meRow[0].first_name} ${meRow[0].last_name}` : null,
      managerEmail: meRow[0]?.email || null,
      roomLeaderName: leaderRow[0] ? `${leaderRow[0].first_name} ${leaderRow[0].last_name}` : null,
      documents: packLinks,
    });
    const mail = await sendWelcomeEmail(email, parts);
    await db.query(
      `UPDATE onboarding_invites
          SET emailed_at = now(),
              email_status = $2,
              send_count = send_count + 1
        WHERE id = $1`,
      [invite.id, mail.sent ? 'sent' : (mail.disabled ? 'disabled' : 'failed')]);

    // ── 5. audit (ids only — no name, no address) ─────────────────────────────
    try {
      require('../utils/audit').recordAudit({
        req, action: 'create', entity_type: 'starter_onboard', entity_id: staff.id,
        meta: { invite_id: invite.id, assignment_id: assignment.id, reused_staff: reused,
                pack_documents: packLinks.map(d => d.slug),
                pack_assignments: pack.map(p => p.assignment_id),
                email_status: mail.sent ? 'sent' : (mail.disabled ? 'disabled' : 'failed') },
      });
    } catch (_) { /* audit is never allowed to fail the onboard */ }

    res.status(201).json({
      staff_id: staff.id,
      reused_staff: reused,
      invite_id: invite.id,
      assignment_id: assignment.id,
      expires_at: invite.expires_at,
      induction_url: urls.inductionUrl(token),
      details_url: `https://${urls.publicHost}/onboard/staff?token=${token}`,
      portal_url: urls.portalUrl,
      documents: packLinks,
      pack_assignments: pack,
      email: { to: email, sent: mail.sent, disabled: mail.disabled, error: mail.error, subject: mail.subject },
    });
  } catch (e) {
    console.error('[induction/starters] failed:', e.message); // message only — never field values
    res.status(500).json({ error: e.message });
  }
});

// GET /starters — invite status for the manager screen.
// sent → opened → details submitted → approved, plus the induction % so a manager
// can see a starter reading week 1 before they arrive.
router.get('/starters', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  try {
    await ensureInviteTable();
    const { rows } = await getPool().query(`
      SELECT i.id, i.email, i.status, i.created_at, i.expires_at, i.opened_at,
             i.emailed_at, i.email_status, i.send_count, i.submitted_at, i.approved_at,
             i.staff_id, i.assignment_id,
             s.first_name, s.last_name, s.role, s.is_active,
             rm.name AS room_name,
             a.start_date, a.status AS assignment_status,
             (SELECT COUNT(*) FROM induction_template_items ti WHERE ti.template_id = a.template_id)::int AS total_items,
             (SELECT COUNT(*) FROM induction_item_progress ip
               WHERE ip.assignment_id = a.id AND ip.status IN ('done','signed_off'))::int AS done_items
        FROM onboarding_invites i
        LEFT JOIN staff s ON s.id = i.staff_id
        LEFT JOIN rooms rm ON rm.id = s.room_id
        LEFT JOIN induction_assignments a ON a.id = i.assignment_id
       WHERE i.type = 'staff' AND i.staff_id IS NOT NULL
         AND i.status <> 'rejected'
       ORDER BY i.created_at DESC
       LIMIT 100`);
    const now = Date.now();
    // b288 — handbook / induction / fire induction state for every starter on
    // the screen, in three queries rather than three per row. Tolerates a
    // tenant that has not run the migration: an empty pack, not a broken page.
    let packs = new Map();
    try {
      packs = await starterPack.packStatusForStaffIds(getPool(), rows.map(r => r.staff_id));
    } catch (e) { console.error('[induction/starters] pack status unavailable:', e.message); }
    res.json(rows.map(r => ({
      ...r,
      pack: packs.get(Number(r.staff_id)) || [],
      // One word for the screen. Derived, never stored, so it can't go stale.
      stage: r.approved_at ? 'approved'
        : r.submitted_at ? 'details submitted'
        : (r.status === 'expired' || (r.expires_at && new Date(r.expires_at).getTime() < now)) ? 'expired'
        : r.opened_at ? 'opened'
        : r.email_status === 'sent' ? 'sent'
        : r.email_status === 'disabled' ? 'not emailed (test env)'
        : r.email_status === 'failed' ? 'email failed'
        : 'created',
      pct_complete: r.total_items ? Math.round((r.done_items / r.total_items) * 100) : 0,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /starters/:id/resend — mint a FRESH token and send the welcome again.
// A fresh token because the old one may be in a mailbox they've lost access to,
// or past its expiry; rotating it also invalidates the previous link. Refused
// once the details are in — at that point the invite has done its job.
router.post('/starters/:id/resend', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const db = getPool();
  try {
    await ensureInviteTable();
    const { rows } = await db.query(
      `SELECT * FROM onboarding_invites WHERE id=$1 AND type='staff' AND staff_id IS NOT NULL`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Starter invite not found' });
    const inv = rows[0];
    if (['submitted', 'approved', 'rejected'].includes(inv.status)) {
      return res.status(409).json({ error: 'This starter has already sent their details in.' });
    }
    if (!inv.email) return res.status(409).json({ error: 'This invite has no email address on it.' });

    const token = mintToken();
    const { rows: upd } = await db.query(`
      UPDATE onboarding_invites
         SET token = $2, status = 'pending', expires_at = now() + ($3 || ' days')::interval
       WHERE id = $1 RETURNING expires_at`, [id, token, String(STARTER_TOKEN_DAYS)]);

    const { rows: st } = await db.query('SELECT * FROM staff WHERE id=$1', [inv.staff_id]);
    const { rows: a } = inv.assignment_id
      ? await db.query('SELECT * FROM induction_assignments WHERE id=$1', [inv.assignment_id])
      : { rows: [] };
    const urls = await starterUrls(db);
    const { rows: leaderRow } = a[0]?.room_leader_id
      ? await db.query('SELECT first_name, last_name FROM staff WHERE id=$1', [a[0].room_leader_id])
      : { rows: [] };
    const { rows: meRow } = await db.query(
      'SELECT first_name, last_name, email FROM staff WHERE id=$1', [Number(req.user.id)]);

    // b288 — a resend carries whatever the pack is TODAY. If a manager switched
    // a document on since the first email, the new link has it; the assignments
    // are re-ensured (idempotent) so a document added after onboarding still
    // gets somewhere to record its completion.
    try {
      await starterPack.ensurePackAssignments(db, {
        staffId: inv.staff_id,
        assignedBy: Number(req.user.id),
        roomLeaderId: a[0]?.room_leader_id || null,
        startDate: a[0]?.start_date || null,
        skipTemplateId: a[0]?.template_id || null,
      });
    } catch (e) { console.error('[induction/starters/resend] pack assignments failed:', e.message); }
    const packDocs = await starterPack.activeDocuments(db).catch(() => []);
    const packLinks = starterPack.documentLinks(packDocs, urls.publicHost, token);

    const parts = composeWelcomeEmail({
      firstName: st[0]?.preferred_name || st[0]?.first_name,
      settingName: urls.settingName,
      portalUrl: urls.portalUrl,
      inductionUrl: urls.inductionUrl(token),
      roleLabel: roleLabel(st[0]?.role, st[0]?.employment_type),
      startDate: a[0]?.start_date || st[0]?.contract_start,
      expiresAt: upd[0].expires_at,
      managerName: meRow[0] ? `${meRow[0].first_name} ${meRow[0].last_name}` : null,
      managerEmail: meRow[0]?.email || null,
      roomLeaderName: leaderRow[0] ? `${leaderRow[0].first_name} ${leaderRow[0].last_name}` : null,
      documents: packLinks,
    });
    const mail = await sendWelcomeEmail(inv.email, parts, 'starter-welcome-resend');
    await db.query(
      `UPDATE onboarding_invites
          SET emailed_at = now(), email_status = $2, send_count = send_count + 1, opened_at = NULL
        WHERE id = $1`,
      [id, mail.sent ? 'sent' : (mail.disabled ? 'disabled' : 'failed')]);

    try {
      require('../utils/audit').recordAudit({
        req, action: 'update', entity_type: 'starter_onboard', entity_id: inv.staff_id,
        meta: { invite_id: id, resent: true, email_status: mail.sent ? 'sent' : (mail.disabled ? 'disabled' : 'failed') },
      });
    } catch (_) {}

    res.json({
      ok: true,
      invite_id: id,
      expires_at: upd[0].expires_at,
      induction_url: urls.inductionUrl(token),
      documents: packLinks,
      email: { sent: mail.sent, disabled: mail.disabled, error: mail.error },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// b288 — THE STARTER PACK (2026-09-08)
//
// Toby: "a new starter I want to enrol from wren. needs handbook etc sent. I
// have uploaded the inductions that I do — new staff induction, and Fire
// induction."
//
// What a new starter receives is a table a manager owns, not a list in this
// file. These three routes are the manager's side of it: read the set, change
// the set, and see who has done what.
//
// NOTHING BELOW SENDS AN EMAIL. Changing the pack changes what the NEXT invite
// carries; it does not re-mail anybody. The only send is the one a manager
// explicitly triggers with Onboard / Resend.
// (wren-docs/decisions/2026-09-08-no-auto-parent-email.md)
// ============================================================================

// GET /starter-pack — the configurable document set, active and inactive.
router.get('/starter-pack', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  try {
    res.json(await starterPack.allDocuments(getPool()));
  } catch (e) {
    // A tenant that has not run the b288 migration has no table yet. An empty
    // pack is the honest answer there, and keeps the Roost page rendering.
    if (/relation .* does not exist/i.test(e.message)) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /starter-pack/:id — what a manager may change without a deploy.
// Deliberately a small set: the document's own words (title, summary), where it
// sits, whether a starter gets it at all, and whether it needs an
// acknowledgement. Not editable here: body_html and template_id, which come
// from the source document and the migration that generated it.
const PACK_FIELDS = {
  title: v => String(v).trim().slice(0, 200) || null,
  summary: v => (v == null ? null : String(v).trim().slice(0, 600)),
  external_url: v => (v == null || v === '' ? null : String(v).trim().slice(0, 1000)),
  sort_order: v => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null),
  is_active: v => v === true || v === 'true',
  requires_ack: v => v === true || v === 'true',
  ack_item_id: v => (v == null || v === '' ? null : parseInt(v, 10)),
};
router.patch('/starter-pack/:id', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const db = getPool();
  const sets = [], vals = [id];
  for (const [k, clean] of Object.entries(PACK_FIELDS)) {
    if (!(k in (req.body || {}))) continue;
    const v = clean(req.body[k]);
    if (k === 'title' && v === null) return res.status(400).json({ error: 'A document needs a title' });
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  try {
    // An acknowledgement has to have somewhere to be recorded. induction_item_progress
    // is that somewhere, so requires_ack without an induction item is refused rather
    // than accepted and then silently un-trackable.
    const { rows: cur } = await db.query('SELECT * FROM starter_pack_documents WHERE id=$1', [id]);
    if (!cur.length) return res.status(404).json({ error: 'Document not found' });
    const after = { ...cur[0] };
    for (const [k, clean] of Object.entries(PACK_FIELDS)) {
      if (k in (req.body || {})) after[k] = clean(req.body[k]);
    }
    if (after.requires_ack && !after.ack_item_id) {
      return res.status(400).json({
        error: 'Pick the induction item this acknowledgement records against, or turn the acknowledgement off.',
      });
    }
    if (after.ack_item_id) {
      const { rows: item } = await db.query(
        'SELECT id FROM induction_template_items WHERE id=$1', [after.ack_item_id]);
      if (!item.length) return res.status(400).json({ error: 'That induction item does not exist' });
    }
    vals.push(Number(req.user.id));
    const { rows } = await db.query(
      `UPDATE starter_pack_documents SET ${sets.join(', ')}, updated_at = now(), updated_by = $${vals.length}
        WHERE id = $1 RETURNING id`, vals);
    try {
      require('../utils/audit').recordAudit({
        req, action: 'update', entity_type: 'starter_pack_document', entity_id: id,
        meta: { fields: Object.keys(req.body || {}) },
      });
    } catch (_) {}
    const all = await starterPack.allDocuments(db);
    res.json(all.find(d => d.id === rows[0].id) || { id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /starters/:id/pack — per-starter completion, for the manager screen.
// "handbook acknowledged, induction done, fire induction done, with dates."
router.get('/starters/:id/pack', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const db = getPool();
  try {
    await ensureInviteTable();
    const { rows } = await db.query(
      `SELECT id, staff_id FROM onboarding_invites WHERE id=$1 AND type='staff'`, [id]);
    if (!rows.length || !rows[0].staff_id) return res.status(404).json({ error: 'Starter invite not found' });
    res.json({ invite_id: id, staff_id: rows[0].staff_id, documents: await starterPack.packStatusForStaff(db, rows[0].staff_id) });
  } catch (e) {
    if (/relation .* does not exist/i.test(e.message)) return res.json({ invite_id: id, documents: [] });
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// CHILD INDUCTIONS (b404, 2026-10-06) — room settling-in checklists for
// newly-starting CHILDREN, parallel to the staff machinery above.
//
// Why a parallel path rather than reusing /assignments wholesale: that query
// INNER JOINs staff ON staff.id = a.staff_id (ASSIGNMENT_LIST_SQL) and
// syncItemProgress() drives course_attempts/policy_acknowledgments off
// a.staff_id — both are staff-only concepts with no meaning for a child.
// induction_assignments.child_id (migrations/2026-10-06-b404-child-induction.sql)
// is the alternative to staff_id (CHECK: exactly one of the two is set), so a
// child row is simply invisible to every query above — zero regression risk.
//
// Ticking: a child has no self-service "owner" the way a new staff member
// owns their own reading list — every tick on a child's checklist is, by
// definition, a member of staff confirming it on the child's behalf. So
// child template items are seeded signoff_only=true and the client writes
// status='signed_off' directly via the EXISTING, unmodified
// PATCH /item-progress/:id route above: isOwnerOf() is always false for a
// child row (staff_id IS NULL), so that route already requires manager-or-
// room-leader for every write — "editable by managers" from the brief, for
// free, reusing the exact tick/date/who columns (signed_off_by + signed_off_at)
// already proven for staff induction.
// ============================================================================

const CHILD_ASSIGNMENT_LIST_SQL = `
  SELECT a.id, a.child_id, a.template_id, a.assigned_by, a.room_leader_id,
         a.start_date, a.target_complete_date, a.status, a.created_at,
         ch.room_id AS child_room_id,
         ch.first_name || ' ' || ch.last_name AS child_name,
         rm.name AS room_name,
         t.name AS template_name,
         rl.first_name || ' ' || rl.last_name AS room_leader_name,
         (SELECT COUNT(*) FROM induction_template_items ti WHERE ti.template_id = a.template_id)::int AS total_items,
         (SELECT COUNT(*) FROM induction_item_progress ip
            WHERE ip.assignment_id = a.id AND ip.status IN ('done','signed_off'))::int AS done_items,
         (SELECT COUNT(*) FROM induction_item_progress ip
            WHERE ip.assignment_id = a.id AND ip.status = 'signed_off')::int AS signed_off_items
  FROM induction_assignments a
  JOIN children ch ON ch.id = a.child_id
  LEFT JOIN rooms rm ON rm.id = ch.room_id
  LEFT JOIN induction_templates t ON t.id = a.template_id
  LEFT JOIN staff rl ON rl.id = a.room_leader_id
`;

function canViewChildAssignment(user, assignment) {
  return isManager(user) || isLeaderOf(user, assignment);
}

// GET /child-templates?room_id= — settling-in templates (target_type='child')
router.get('/child-templates', async (req, res) => {
  try {
    const db = getPool();
    const roomId = req.query.room_id ? parseInt(req.query.room_id, 10) : null;
    const params = [];
    let where = `WHERE t.is_active = true AND t.target_type = 'child'`;
    if (roomId) { params.push(roomId); where += ` AND (t.room_id = $${params.length} OR t.room_id IS NULL)`; }
    const { rows } = await db.query(`
      SELECT t.id, t.name, t.room_id, t.is_active, t.created_at,
             r.name AS room_name,
             COUNT(i.id)::int AS item_count
      FROM induction_templates t
      LEFT JOIN rooms r ON r.id = t.room_id
      LEFT JOIN induction_template_items i ON i.template_id = t.id
      ${where}
      GROUP BY t.id, r.name
      ORDER BY t.room_id NULLS LAST, t.id
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child-assignments?room_id=&child_id=&status= — managers see all; a
// room leader/key person sees only the ones assigned to them.
router.get('/child-assignments', async (req, res) => {
  try {
    const db = getPool();
    const mgr = isManager(req.user);
    const params = [];
    let where = 'WHERE a.child_id IS NOT NULL';
    if (!mgr) { params.push(Number(req.user.id)); where += ` AND a.room_leader_id = $${params.length}`; }
    if (req.query.child_id) { params.push(parseInt(req.query.child_id, 10)); where += ` AND a.child_id = $${params.length}`; }
    if (req.query.room_id) { params.push(parseInt(req.query.room_id, 10)); where += ` AND ch.room_id = $${params.length}`; }
    if (req.query.status) { params.push(req.query.status); where += ` AND a.status = $${params.length}`; }
    const { rows } = await db.query(`
      ${CHILD_ASSIGNMENT_LIST_SQL} ${where}
      ORDER BY a.status, a.target_complete_date NULLS LAST, a.id DESC
    `, params);
    res.json(rows.map(withPct));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child-assignments/:id — full workbook (items + progress)
router.get('/child-assignments/:id', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query(`${CHILD_ASSIGNMENT_LIST_SQL} WHERE a.id = $1 AND a.child_id IS NOT NULL`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Assignment not found' });
    const assignment = rows[0];
    if (!canViewChildAssignment(req.user, assignment)) return res.status(403).json({ error: 'Forbidden' });

    const soSql = await signoffOnlySql(db);
    const { rows: items } = await db.query(`
      SELECT ti.id AS item_id, ti.section, ti.title, ti.description, ti.item_type,
             ti.sort_order, ti.required,
             ${soSql} AS signoff_only,
             ip.id AS progress_id,
             COALESCE(ip.status, 'pending') AS status,
             ip.completed_at, ip.signed_off_by, ip.signed_off_at, ip.evidence_note,
             so.first_name || ' ' || so.last_name AS signed_off_by_name
      FROM induction_template_items ti
      LEFT JOIN induction_item_progress ip ON ip.item_id = ti.id AND ip.assignment_id = $1
      LEFT JOIN staff so ON so.id = ip.signed_off_by
      WHERE ti.template_id = $2
      ORDER BY ti.sort_order, ti.id
    `, [id, assignment.template_id]);

    res.json({
      ...withPct(assignment),
      can_sign_off: isManager(req.user) || isLeaderOf(req.user, assignment),
      is_owner: false,
      items,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /child-assignments (manager only) — assign a settling-in template to a child
router.post('/child-assignments', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { child_id, template_id, room_leader_id, start_date, target_complete_date } = req.body || {};
    if (!child_id || !template_id) return res.status(400).json({ error: 'child_id and template_id are required' });

    const { rows: chExists } = await db.query('SELECT id FROM children WHERE id=$1', [child_id]);
    if (!chExists.length) return res.status(400).json({ error: 'child_id not found' });
    const { rows: tExists } = await db.query(
      `SELECT id FROM induction_templates WHERE id=$1 AND target_type='child'`, [template_id]);
    if (!tExists.length) return res.status(400).json({ error: 'template_id not found (or is not a child settling-in template)' });

    const { rows } = await db.query(`
      INSERT INTO induction_assignments
        (child_id, template_id, assigned_by, room_leader_id, start_date, target_complete_date, status)
      VALUES ($1,$2,$3,$4,$5,$6,'in_progress')
      RETURNING *
    `, [
      child_id, template_id, Number(req.user.id),
      room_leader_id || null,
      start_date || null,
      target_complete_date || null,
    ]);
    const assignment = rows[0];

    // Pre-create a pending progress row for every template item (idempotent) —
    // same pattern as POST /assignments for staff.
    await db.query(`
      INSERT INTO induction_item_progress (assignment_id, item_id, status)
      SELECT $1, ti.id, 'pending'
      FROM induction_template_items ti
      WHERE ti.template_id = $2
      ON CONFLICT (assignment_id, item_id) DO NOTHING
    `, [assignment.id, template_id]);

    res.status(201).json(assignment);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── login-20261023 — Apprentice pathway ─────────────────────────────────────────────────────────
// Rides on the induction above: the pathway is a template ('Apprentice pathway — first three months'),
// the mentor is the assignment's room_leader_id, sign-off is the existing item sign-off. These routes
// add only what induction could not do: the apprentice's notes for their mentor and practice
// observations (staff_reflections, shared_with_mentor), colleagues' notes about them
// (apprentice_feedback), and the manager's "ready to observe" switch.
const PATHWAY_NAME = 'Apprentice pathway — first three months';
const READY_CAPS = ['observations.create', 'observations.edit-own'];

async function assignmentFor(db, id) {
  const { rows } = await db.query('SELECT * FROM induction_assignments WHERE id = $1', [id]);
  return rows[0] || null;
}
async function mentorsOf(db, staffId) {
  const { rows } = await db.query(
    "SELECT DISTINCT room_leader_id FROM induction_assignments WHERE staff_id = $1 AND room_leader_id IS NOT NULL", [staffId]);
  return rows.map((r) => Number(r.room_leader_id));
}

// GET /apprentices — every active apprentice. Colleagues see names (so they can write an observation
// about them); managers and each apprentice's mentor also see pathway progress.
router.get('/apprentices', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT s.id, COALESCE(s.preferred_name, s.first_name) AS first_name, s.last_name, s.job_title, r.name AS room_name,
             a.id AS assignment_id, a.start_date, a.status, a.room_leader_id,
             ml.first_name || ' ' || ml.last_name AS mentor_name
        FROM staff s
        LEFT JOIN rooms r ON r.id = s.room_id
        LEFT JOIN LATERAL (
          SELECT ia.* FROM induction_assignments ia JOIN induction_templates t ON t.id = ia.template_id
           WHERE ia.staff_id = s.id AND t.name = $1 ORDER BY ia.created_at DESC LIMIT 1) a ON true
        LEFT JOIN staff ml ON ml.id = a.room_leader_id
       WHERE s.is_active AND s.role = 'apprentice' AND NOT COALESCE(s.is_demo, false)
       ORDER BY s.first_name`, [PATHWAY_NAME]);
    const { rows: tpl } = await db.query('SELECT id FROM induction_templates WHERE name = $1 LIMIT 1', [PATHWAY_NAME]);
    const ia = require('../lib/induction-auto');
    const out = [];
    for (const r of rows) {
      const mine = isManager(req.user) || Number(r.room_leader_id) === Number(req.user.id) || Number(r.id) === Number(req.user.id);
      const row = { id: r.id, name: `${r.first_name} ${r.last_name || ''}`.trim(), job_title: r.job_title, room_name: r.room_name,
                    mentor_name: r.mentor_name || null, on_pathway: !!r.assignment_id };
      if (mine && r.assignment_id) {
        await syncItemProgress(db, r.assignment_id);
        const { rows: [c] } = await db.query(`
          SELECT count(*)::int AS total, count(*) FILTER (WHERE ip.status IN ('done','signed_off'))::int AS done
            FROM induction_template_items ti LEFT JOIN induction_item_progress ip ON ip.item_id = ti.id AND ip.assignment_id = $1
           WHERE ti.template_id = (SELECT template_id FROM induction_assignments WHERE id = $1)`, [r.assignment_id]);
        Object.assign(row, { assignment_id: r.assignment_id, start_date: r.start_date, done: c.done, total: c.total,
                             ready: await ia.isReadyToObserve(db, r.id) });
      }
      row.can_view = mine;
      out.push(row);
    }
    res.json({ template_id: tpl.length ? tpl[0].id : null, can_start: isManager(req.user), apprentices: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /assignments/:id/journal — the apprentice's shared notes + practice observations, and what
// colleagues have written. The apprentice, their mentor and managers only. Private reflections
// (shared_with_mentor = false) are never returned here.
router.get('/assignments/:id/journal', async (req, res) => {
  try {
    const db = getPool();
    const a = await assignmentFor(db, parseInt(req.params.id, 10));
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!canViewAssignment(req.user, a)) return res.status(403).json({ error: 'Forbidden' });
    const { rows: entries } = await db.query(`
      SELECT id, kind, title, body, created_at FROM staff_reflections
       WHERE staff_id = $1 AND (shared_with_mentor OR kind = 'practice_observation')
       ORDER BY created_at DESC LIMIT 100`, [a.staff_id]);
    const { rows: feedback } = await db.query(`
      SELECT f.id, f.kind, f.reflection_id, f.body, f.created_at,
             au.first_name || ' ' || au.last_name AS author_name
        FROM apprentice_feedback f LEFT JOIN staff au ON au.id = f.author_staff_id
       WHERE f.apprentice_staff_id = $1 ORDER BY f.created_at DESC LIMIT 200`, [a.staff_id]);
    res.json({ entries, feedback, is_owner: isOwnerOf(req.user, a) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /assignments/:id/journal — the apprentice writes a note for their mentor or a practice
// observation. { kind: 'note' | 'practice_observation', title?, body }. Never touches a child record.
router.post('/assignments/:id/journal', async (req, res) => {
  try {
    const db = getPool();
    const a = await assignmentFor(db, parseInt(req.params.id, 10));
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!isOwnerOf(req.user, a)) return res.status(403).json({ error: 'Only the apprentice writes in their own pathway notes' });
    const kind = req.body && req.body.kind === 'practice_observation' ? 'practice_observation' : 'note';
    const body = String((req.body && req.body.body) || '').trim().slice(0, 8000);
    const title = String((req.body && req.body.title) || '').trim().slice(0, 200) || (kind === 'note' ? 'Note for my mentor' : 'Practice observation');
    if (body.length < 3) return res.status(400).json({ error: 'Write something first' });
    const { rows } = await db.query(
      `INSERT INTO staff_reflections (staff_id, kind, title, body, shared, shared_with_mentor, created_at, updated_at)
       VALUES ($1, $2, $3, $4, false, true, now(), now()) RETURNING id, kind, title, body, created_at`,
      [a.staff_id, kind, title, body]);
    await syncItemProgress(db, a.id);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /apprentices/:staffId/feedback — any colleague: an observation about the apprentice, or a
// comment on one of their journal entries. { kind: 'observation' | 'comment', body, reflection_id? }
router.post('/apprentices/:staffId/feedback', async (req, res) => {
  try {
    const db = getPool();
    const staffId = parseInt(req.params.staffId, 10);
    if (Number(req.user.id) === staffId) return res.status(400).json({ error: 'This is for colleagues to write about you' });
    const { rows: s } = await db.query("SELECT id FROM staff WHERE id = $1 AND is_active AND role = 'apprentice'", [staffId]);
    if (!s.length) return res.status(404).json({ error: 'Not an active apprentice' });
    const body = String((req.body && req.body.body) || '').trim().slice(0, 4000);
    if (body.length < 3) return res.status(400).json({ error: 'Write something first' });
    const kind = req.body && req.body.kind === 'comment' ? 'comment' : 'observation';
    const reflectionId = req.body && req.body.reflection_id ? parseInt(req.body.reflection_id, 10) : null;
    if (reflectionId) {
      // A comment answers a SHARED entry of this apprentice only.
      const { rows: ok } = await db.query(
        "SELECT 1 FROM staff_reflections WHERE id = $1 AND staff_id = $2 AND (shared_with_mentor OR kind = 'practice_observation')", [reflectionId, staffId]);
      if (!ok.length) return res.status(404).json({ error: 'Entry not found' });
    }
    const { rows } = await db.query(
      `INSERT INTO apprentice_feedback (apprentice_staff_id, author_staff_id, kind, reflection_id, body)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, kind, reflection_id, body, created_at`,
      [staffId, Number(req.user.id), kind, reflectionId, body]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /assignments/:id/ready { ready: true|false } — managers only. Ready = the apprentice can write
// observations (a per-person grant on top of the apprentice role's matrix row, which has none).
// Not ready = the grant is taken away again. The pathway's 'ready' item ticks itself from this.
router.post('/assignments/:id/ready', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'A manager signs an apprentice off as ready' });
  try {
    const db = getPool();
    const a = await assignmentFor(db, parseInt(req.params.id, 10));
    if (!a) return res.status(404).json({ error: 'Not found' });
    const ready = !!(req.body && req.body.ready);
    if (ready) {
      await db.query(
        `INSERT INTO staff_capabilities (staff_id, capability_id, level, granted_by, granted_at)
         SELECT $1, c.id, 'edit', $2, now() FROM capabilities c WHERE c.key = ANY($3::text[])
         ON CONFLICT (staff_id, capability_id) DO UPDATE SET level = 'edit', granted_by = $2, granted_at = now()`,
        [a.staff_id, Number(req.user.id), READY_CAPS]);
    } else {
      await db.query(
        `DELETE FROM staff_capabilities sc USING capabilities c
          WHERE sc.capability_id = c.id AND sc.staff_id = $1 AND c.key = ANY($2::text[])`, [a.staff_id, READY_CAPS]);
      // Un-tick the 'ready' item so the pathway tells the truth.
      await db.query(
        `UPDATE induction_item_progress ip SET status = 'pending', completed_at = NULL, evidence_note = NULL
           FROM induction_template_items ti
          WHERE ip.item_id = ti.id AND ip.assignment_id = $1 AND to_jsonb(ti) ->> 'auto_rule' = 'ready'`, [a.id]);
    }
    require('../utils/audit').recordAudit({ req, action: 'update', entity_type: 'staff', entity_id: a.staff_id,
      meta: { change: ready ? 'apprentice_ready_to_observe' : 'apprentice_not_ready', capabilities: READY_CAPS } });
    await syncItemProgress(db, a.id);
    res.json({ ok: true, ready });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
