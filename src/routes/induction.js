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

router.use(authenticate);

// ── role helpers ────────────────────────────────────────────────────────────
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
function isManager(user) {
  return !!user && MANAGER_ROLES.includes(user.role);
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

// ============================================================================
// TEMPLATES
// ============================================================================

// GET /templates — list active templates (with item counts)
router.get('/templates', async (req, res) => {
  try {
    const db = getPool();
    const includeInactive = isManager(req.user) && req.query.all === 'true';
    const { rows } = await db.query(`
      SELECT t.id, t.name, t.role_target, t.room_id, t.is_active, t.created_at,
             r.name AS room_name,
             COUNT(i.id)::int AS item_count
      FROM induction_templates t
      LEFT JOIN rooms r ON r.id = t.room_id
      LEFT JOIN induction_template_items i ON i.template_id = t.id
      ${includeInactive ? '' : 'WHERE t.is_active = true'}
      GROUP BY t.id, r.name
      ORDER BY t.id
    `);
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
      SELECT i.*, c.name AS course_name, c.status AS course_status
      FROM induction_template_items i
      LEFT JOIN courses c ON c.id = i.course_id
      WHERE i.template_id = $1
      ORDER BY i.section, i.sort_order, i.id
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
    const { section, title, description, item_type, course_id, source_refs, sort_order, required } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
    const validTypes = ['form', 'course', 'reading', 'task'];
    if (!validTypes.includes(item_type)) return res.status(400).json({ error: 'item_type must be one of ' + validTypes.join(', ') });
    const { rows: tExists } = await db.query('SELECT id FROM induction_templates WHERE id=$1', [templateId]);
    if (!tExists.length) return res.status(404).json({ error: 'Template not found' });
    const { rows } = await db.query(`
      INSERT INTO induction_template_items
        (template_id, section, title, description, item_type, course_id, source_refs, sort_order, required)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,0),COALESCE($9,true))
      RETURNING *
    `, [
      templateId, section || null, String(title).trim(), description || null, item_type,
      course_id || null,
      Array.isArray(source_refs) ? source_refs : null,
      Number.isInteger(sort_order) ? sort_order : null,
      typeof required === 'boolean' ? required : null,
    ]);
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

// GET /assignments?staff_id= — managers see all (or filtered); others see own + ones they lead
router.get('/assignments', async (req, res) => {
  try {
    const db = getPool();
    const mgr = isManager(req.user);
    const qStaff = req.query.staff_id ? parseInt(req.query.staff_id, 10) : null;
    let where, params;
    if (mgr) {
      if (qStaff) { where = 'WHERE a.staff_id = $1'; params = [qStaff]; }
      else { where = ''; params = []; }
    } else {
      // own assignments + assignments where I am the room leader
      where = 'WHERE a.staff_id = $1 OR a.room_leader_id = $1';
      params = [Number(req.user.id)];
    }
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

    const { rows: items } = await db.query(`
      SELECT ti.id AS item_id, ti.section, ti.title, ti.description, ti.item_type,
             ti.course_id, ti.source_refs, ti.sort_order, ti.required,
             c.name AS course_name,
             ip.id AS progress_id,
             COALESCE(ip.status, 'pending') AS status,
             ip.completed_at, ip.signed_off_by, ip.signed_off_at, ip.evidence_note,
             so.first_name || ' ' || so.last_name AS signed_off_by_name
      FROM induction_template_items ti
      LEFT JOIN induction_item_progress ip ON ip.item_id = ti.id AND ip.assignment_id = $1
      LEFT JOIN courses c ON c.id = ti.course_id
      LEFT JOIN staff so ON so.id = ip.signed_off_by
      WHERE ti.template_id = $2
      ORDER BY ti.section, ti.sort_order, ti.id
    `, [id, assignment.template_id]);

    res.json({
      ...withPct(assignment),
      can_sign_off: isManager(req.user) || isLeaderOf(req.user, assignment),
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
      if (!room_leader_id || Number(room_leader_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: 'Only a manager, or the room leader for this starter, can create an assignment' });
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
    let where = '', params = [uid];
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
const EVENTS_SELECT = `
  SELECT e.id, e.staff_id, e.event_type, e.title, e.event_date, e.event_time,
         e.location, e.provider, e.notes, e.otj_hours, e.linked_email_triage_id,
         e.created_by, e.created_at,
         s.first_name || ' ' || s.last_name AS staff_name, s.role AS staff_role,
         rm.name AS room_name,
         cb.first_name || ' ' || cb.last_name AS created_by_name,
         et.subject     AS linked_email_subject,
         et.from_name   AS linked_email_from,
         et.received_at AS linked_email_received_at
  FROM apprentice_events e
  JOIN staff s ON s.id = e.staff_id
  LEFT JOIN rooms rm ON rm.id = s.room_id
  LEFT JOIN staff cb ON cb.id = e.created_by
  LEFT JOIN email_triage et ON et.id = e.linked_email_triage_id
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
// Recent triaged emails (category staff/other) that look assessor/training/
// apprenticeship related and are not yet linked to an event. Returns subject +
// preview only — never the full body.
router.get('/triage/apprentice-candidates', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT et.id, et.received_at, et.from_name, et.subject, et.body_preview
      FROM email_triage et
      WHERE et.category IN ('staff','other')
        AND (et.subject ILIKE ANY($1) OR et.body_preview ILIKE ANY($1))
        AND COALESCE(et.apprentice_relevant, false) = false
        AND et.received_at >= now() - INTERVAL '18 months'
        AND NOT EXISTS (SELECT 1 FROM apprentice_events ae WHERE ae.linked_email_triage_id = et.id)
      ORDER BY et.received_at DESC NULLS LAST
      LIMIT 30
    `, [APPRENTICE_PATTERNS]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /events/:id/link-email (manager only) — attach a triaged email to an event.
// This is the ONLY write to email_triage: it sets the flag columns
// (apprentice_relevant=true, apprentice_event_type for context) and stores the
// reference on the event. It does NOT alter the email's classification or send
// anything. Runs in a transaction so the two writes stay consistent.
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
    const { rows: trRows } = await db.query('SELECT id FROM email_triage WHERE id=$1', [triageId]);
    if (!trRows.length) return res.status(400).json({ error: 'triage_id not found' });

    client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE apprentice_events SET linked_email_triage_id=$1 WHERE id=$2', [triageId, id]);
      await client.query(
        'UPDATE email_triage SET apprentice_relevant=true, apprentice_event_type=COALESCE(apprentice_event_type,$1) WHERE id=$2',
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

module.exports = router;
