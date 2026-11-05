// src/routes/action-plan-items.js
// Routes for action_plan_items, comments, and deadline calendar events.
// Mounted at /api/action-plan-items in admin, ladn, hr, and parents servers.

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

// b358 (2026-09-29) — Action Plan is now the task system. The bridge keeps a
// mirror row in b209's `tasks` for any item that is assigned to somebody, which
// is what gives an action multiple assignees, the 24h/1h reminders, the
// notification dispatcher and /ey/my-tasks — none of which are rebuilt here.
// See src/lib/action-plan-tasks.js for why it is a bridge and not a migration.
const APT = require('../lib/action-plan-tasks');
// b501 (Tasks v2): the plan is a project task and this item one of its sub-tasks; see src/lib/task-projects.js.
const TP = require('../lib/task-projects');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const APA = require('../lib/action-plan-access');

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'room_leader', 'senior_practitioner'];
const isManagerReq = req => MANAGER_ROLES.includes(req.user && req.user.role);

/** Normalise whatever the client sent as assignees into a clean id array. */
function parseAssignees(body) {
  const raw = body && (body.assignees != null ? body.assignees
            : (body.assignee_ids != null ? body.assignee_ids : null));
  if (raw == null) return null;                      // field absent = don't touch
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  const out = [];
  for (const v of arr) {
    const n = parseInt(v, 10);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

router.use(authenticate);

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await require('../lib/notifications').sendTelegramNow({ parse_mode: null, text });
  } catch {}
}

// GET /calendar — action item deadlines formatted as calendar events
// Used by the calendar page to surface action plan due dates.
router.get('/calendar', async (req, res) => {
  try {
    const db = getPool();
    const isManager = hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'room_leader', 'senior_practitioner']);
    const params = [];
    let extraWhere = '';
    if (!isManager) {
      params.push(req.user.id);
      extraWhere = ` AND i.assigned_staff_id = $${params.length}`;
    }
    const { rows } = await db.query(`
      SELECT i.id, i.title, i.deadline, i.priority, i.plan_id,
             ap.title AS plan_title
      FROM action_plan_items i
      JOIN action_plans ap ON ap.id = i.plan_id
      WHERE i.status != 'completed'
        AND i.deadline IS NOT NULL
        AND ap.archived_at IS NULL
        ${extraWhere}
      ORDER BY i.deadline ASC LIMIT 90
    `, params);
    const events = rows.map(r => ({
      id: 'action-' + r.id,
      title: '[Action] ' + r.title,
      start: r.deadline,
      end: r.deadline,
      type: 'action-deadline',
      colour: r.priority === 'high' ? '#ef4444' : r.priority === 'medium' ? '#f59e0b' : '#22c55e',
      details_url: '/action-plans.html#item-' + r.id,
      plan_title: r.plan_title,
      priority: r.priority
    }));
    res.json(events);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET / — list items for a plan (query param: plan_id)
router.get('/', async (req, res) => {
  const planId = req.query.plan_id;
  if (!planId) return res.status(400).json({ error: 'plan_id required' });
  try {
    const db = getPool();
    if (!(await APA.canSeePlan(db, req.user, planId))) return res.status(403).json({ error: 'Forbidden — not your action plan' });
    const { rows } = await db.query(`
      SELECT i.*,
             s.first_name || ' ' || s.last_name AS assignee_name,
             cs.first_name || ' ' || cs.last_name AS completed_by_name,
             (SELECT COUNT(*)::int FROM action_plan_comments c WHERE c.item_id = i.id) AS comment_count
      FROM action_plan_items i
      LEFT JOIN staff s ON s.id = i.assigned_staff_id
      LEFT JOIN staff cs ON cs.id = i.completed_by_staff_id
      WHERE i.plan_id = $1
      ORDER BY i.position ASC, i.priority DESC, i.deadline ASC NULLS LAST
    `, [planId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — add action item to a plan
//
// b358 extends this in place rather than adding a second create endpoint: the
// pre-b358 body ({plan_id, title, assigned_staff_id, …}) behaves exactly as
// before, and the new optional fields turn the same call into a full assignment:
//   assignees[]        one or more staff (assigned_staff_id stays as the first,
//                      so every pre-b358 reader still sees an owner)
//   related_child_id   a child, by id only
//   document_ref       a pointer to a document
//   status             open | in progress | done (mapped to the column's own
//                      todo / in-progress / completed — see the lib)
// plan_id is now OPTIONAL: an item created without one lands in the "Assigned
// work" plan, so day-to-day work no longer has to be invented as an improvement
// plan first.
router.post('/', async (req, res) => {
  const { plan_id, title, description, priority, deadline, category, tags,
          assigned_staff_id, notify_assignee, related_child_id, document_ref } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!isManagerReq(req)) return res.status(403).json({ error: 'Manager role required to add items' });
  try {
    const db = getPool();
    await APT.ensureSchema(db);

    // Who is this for? assignees[] wins; assigned_staff_id is the legacy single form.
    let assignees = parseAssignees(req.body);
    if (assignees == null) assignees = assigned_staff_id ? [parseInt(assigned_staff_id, 10)] : [];

    // Where does it live? A named plan must exist and be open; with no plan
    // named, standalone assigned work goes to the "Assigned work" plan.
    let planId = plan_id ? parseInt(plan_id, 10) : null;
    let planTitle = null;
    if (planId) {
      const { rows: plan } = await db.query(
        'SELECT id, title, scope FROM action_plans WHERE id=$1 AND archived_at IS NULL', [planId]
      );
      if (!plan.length) return res.status(404).json({ error: 'Plan not found' });
      planTitle = plan[0].title;
    } else {
      planId = await APT.getOrCreateTaskPlan(db, req.user.id);
      planTitle = 'Assigned work';
    }

    const status = APT.normItemStatus(req.body.status, 'todo');
    const { rows } = await db.query(`
      INSERT INTO action_plan_items
        (plan_id, title, description, priority, status, deadline, category, tags,
         assigned_staff_id, notify_assignee, related_child_id, document_ref)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [planId, title, description || null, APT.normPriority(priority), status, deadline || null,
        category || null, tags || null, assignees[0] || null,
        notify_assignee !== false,
        related_child_id ? parseInt(related_child_id, 10) : null,
        document_ref || null]);

    // The bridge: mirror task, assignees, 24h/1h reminders, and the assignee's
    // in-app notification + EY/HR message. The raw per-assignee Telegram this
    // route used to send is gone on purpose — it bypassed each person's own
    // notification preferences, and the dispatcher honours them.
    let bridged = { task_id: null, added: [] };
    if (assignees.length || status !== 'todo') {
      bridged = await APT.syncItem(db, req.user, rows[0], {
        assignees, silent: notify_assignee === false });
    }

    // Unchanged: the manager broadcast.
    if (assignees.length) {
      await sendTelegram(`[ACTIONS] New action assigned: "${title}" on "${planTitle}"`);
    }

    // Audit
    await db.query(`INSERT INTO action_plan_audit (plan_id,item_id,actor_id,actor_type,action,after_value)
      VALUES ($1,$2,$3,'staff','item_created',$4)`,
      [planId, rows[0].id, req.user.id, JSON.stringify(rows[0])]).catch(() => {});

    await TP.foldPlan(db, planId);
    res.status(201).json({ ...rows[0], task_id: bridged.task_id,
                           assignees, notified: bridged.added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id — update an action item (assignee or manager)
router.patch('/:id', async (req, res) => {
  // b358 — related_child_id and document_ref joined the list, and `status` now
  // accepts the brief's vocabulary (open / in progress / done) as well as the
  // column's own (todo / in-progress / completed / blocked).
  const allowed = ['title', 'description', 'priority', 'status', 'deadline', 'category', 'tags',
                   'assigned_staff_id', 'position', 'related_child_id', 'document_ref'];
  const updates = [];
  const vals = [];
  for (const f of allowed) {
    if (req.body[f] !== undefined) {
      let v = req.body[f];
      // Never let a typo'd status through to the CHECK constraint as a 500.
      if (f === 'status') {
        v = APT.normItemStatus(v);
        if (!v) return res.status(400).json({
          error: `status must be one of: open, in progress, done, blocked` });
      }
      if (f === 'priority') v = APT.normPriority(v);
      vals.push(v);
      updates.push(`${f}=$${vals.length}`);
    }
  }
  const wantAssignees = parseAssignees(req.body);
  if (!updates.length && !wantAssignees) return res.status(400).json({ error: 'No fields to update' });
  try {
    const db = getPool();
    await APT.ensureSchema(db);
    const { rows: check } = await db.query(`
      SELECT i.*, ap.scope, ap.title AS plan_title
      FROM action_plan_items i
      LEFT JOIN action_plans ap ON ap.id = i.plan_id
      WHERE i.id = $1
    `, [req.params.id]);
    if (!check.length) return res.status(404).json({ error: 'Not found' });
    const item = check[0];
    const isManager = isManagerReq(req);
    // b358 — an item can now have more than one assignee, so "is this mine"
    // asks BOTH places assignment lives, not just the legacy single column.
    // Without this, a second assignee could not tick off their own work.
    const assignedNow = await APT.assigneeIds(db, item);
    const isAssignee = assignedNow.includes(Number(req.user.id))
                    || Number(item.assigned_staff_id) === Number(req.user.id);
    if (!isManager && !isAssignee) return res.status(403).json({ error: 'Only assignee or manager can update this item' });
    // Only a manager may hand work to somebody else.
    if (wantAssignees && !isManager) {
      return res.status(403).json({ error: 'Only a manager can change who an action is assigned to' });
    }

    // b358 — the client may speak either vocabulary ('done' or 'completed'), so
    // the comparison is against the NORMALISED value, not the raw body.
    const newStatus = req.body.status !== undefined ? APT.normItemStatus(req.body.status) : null;

    // Mark completion timestamp
    if (newStatus === 'completed' && item.status !== 'completed') {
      updates.push('completed_at=NOW()');
      vals.push(req.user.id);
      updates.push(`completed_by_staff_id=$${vals.length}`);
    }
    updates.push('updated_at=NOW()');
    vals.push(req.params.id);

    const { rows } = await db.query(
      `UPDATE action_plan_items SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );

    // b358 — assigned_staff_id stays as the FIRST assignee so every pre-b358
    // reader (the Roost list, GET /calendar, the parents scope in
    // server-unified.js) still sees an owner on the row it always read.
    if (wantAssignees && wantAssignees.length) {
      await db.query('UPDATE action_plan_items SET assigned_staff_id=$1 WHERE id=$2',
        [wantAssignees[0], item.id]);
      rows[0].assigned_staff_id = wantAssignees[0];
    }

    // b358 — keep the mirror task in step. Title, notes, priority, deadline,
    // status and the assignee set all live on it, and it is what schedules the
    // 24h/1h reminders and tells anyone newly added. The raw per-assignee
    // Telegram this route used to send is gone on purpose: it bypassed each
    // person's own notification preferences, and the dispatcher honours them.
    let bridged = { task_id: rows[0].task_id || null, added: [] };
    try {
      bridged = await APT.syncItem(db, req.user, rows[0], {
        assignees: wantAssignees || undefined,
        silent: req.body.notify_assignee === false,
      });
    } catch (e) {
      console.error('[action-plan-items] bridge sync failed:', e.message);
    }

    // Notify manager on completion (unchanged — the manager broadcast).
    if (newStatus === 'completed' && item.status !== 'completed') {
      const who = req.user.username || `staff ${req.user.id}`;
      await sendTelegram(`[ACTIONS] Action completed: "${item.title}" (plan: "${item.plan_title}") by ${who}`);
    }

    await db.query(`INSERT INTO action_plan_audit (plan_id,item_id,actor_id,actor_type,action,before_value,after_value)
      VALUES ($1,$2,$3,'staff','item_updated',$4,$5)`,
      [item.plan_id, item.id, req.user.id, JSON.stringify({ status: item.status, assigned_staff_id: item.assigned_staff_id }), JSON.stringify(req.body)]
    ).catch(() => {});

    if (rows[0].plan_id) await TP.foldPlan(db, rows[0].plan_id);   // b501: an item that has just been assigned gets its mirror task parented under the plan's project
    res.json({ ...rows[0], task_id: bridged.task_id, notified: bridged.added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/comments — list comments on an item
router.get('/:id/comments', async (req, res) => {
  try {
    const db = getPool();
    if (!(await APA.canSeeItem(db, req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden — not your action plan' });
    const { rows } = await db.query(`
      SELECT c.*,
             CASE WHEN c.author_type != 'parent'
               THEN s.first_name || ' ' || s.last_name
               ELSE 'Parent'
             END AS author_name
      FROM action_plan_comments c
      LEFT JOIN staff s ON s.id = c.author_id AND c.author_type != 'parent'
      WHERE c.item_id = $1
      ORDER BY c.created_at ASC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/comments — add a comment
router.post('/:id/comments', async (req, res) => {
  const commentBody = req.body.body;
  if (!commentBody?.trim()) return res.status(400).json({ error: 'Comment body required' });
  try {
    const db = getPool();
    if (!(await APA.canSeeItem(db, req.user, req.params.id))) return res.status(403).json({ error: 'Forbidden — not your action plan' });
    const { rows: check } = await db.query(`
      SELECT i.plan_id, ap.scope, i.title AS item_title, ap.title AS plan_title
      FROM action_plan_items i
      JOIN action_plans ap ON ap.id = i.plan_id
      WHERE i.id = $1
    `, [req.params.id]);
    if (!check.length) return res.status(404).json({ error: 'Not found' });
    const authorType = hasRole(req.user, ['manager', 'deputy_manager', 'admin']) ? 'manager' : 'staff';
    const { rows } = await db.query(`
      INSERT INTO action_plan_comments (item_id, author_type, author_id, body)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [req.params.id, authorType, req.user.id, commentBody.trim()]);
    const who = req.user.username || `staff ${req.user.id}`;
    await sendTelegram(`[ACTIONS] Comment on "${check[0].item_title}": ${commentBody.trim().substring(0,80)} — by ${who}`);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   b358 (2026-09-29) — Action Plan as the task system.

   Appended, never rewritten: every route above keeps its behaviour. Route
   order is safe — '/mine' and '/board' are literal single-segment paths and
   this router has no 'GET /:id' handler to shadow them (the only ':id' routes
   are PATCH /:id and the two /:id/comments pairs).
   ═══════════════════════════════════════════════════════════════════════════ */

// ── GET /mine — my action plan ──────────────────────────────────────────────
// What /ey/my-tasks ("My Action Plan") and My Morning both ask for. The staff id
// comes from the signed token and can never be named in the query string, so a
// practitioner can only ever reach their own rows here.
//
// Assignment is read from BOTH places it can live: the item's own
// assigned_staff_id (the pre-b358 single assignee, still maintained) and the
// mirror task's task_assignees rows (b358's multi-assignee path).
router.get('/mine', async (req, res) => {
  const db = getPool();
  try {
    await APT.ensureSchema(db);
    const me = Number(req.user.id);
    const { rows } = await db.query(`
      SELECT i.id, i.title, i.description, i.priority, i.status, i.category,
             to_char(i.deadline,'YYYY-MM-DD') AS deadline,
             i.task_id, i.related_child_id, i.document_ref, i.completed_at,
             ap.id AS plan_id, ap.title AS plan_title, COALESCE(ap.is_task_plan,false) AS is_task_plan,
             (i.deadline IS NOT NULL AND i.deadline < CURRENT_DATE AND i.status <> 'completed') AS is_overdue,
             (i.deadline = CURRENT_DATE) AS is_today,
             (SELECT COUNT(*)::int FROM action_plan_comments c WHERE c.item_id = i.id) AS comment_count
        FROM action_plan_items i
        LEFT JOIN action_plans ap ON ap.id = i.plan_id
       WHERE (ap.id IS NULL OR ap.archived_at IS NULL)
         AND ( i.assigned_staff_id = $1
               OR EXISTS (SELECT 1 FROM task_assignees a
                           WHERE a.task_id = i.task_id AND a.staff_id = $1 AND a.status <> 'done') )
         AND (i.status <> 'completed' OR i.completed_at > NOW() - INTERVAL '7 days')
       ORDER BY i.deadline ASC NULLS LAST,
                CASE i.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                i.id`, [me]);

    const pub = r => ({ ...r, status: APT.publicStatus(r.status) });
    const buckets = { overdue: [], today: [], upcoming: [], no_deadline: [], recently_done: [] };
    for (const r of rows) {
      const o = pub(r);
      if (r.status === 'completed')   buckets.recently_done.push(o);
      else if (r.is_overdue)          buckets.overdue.push(o);
      else if (r.is_today)            buckets.today.push(o);
      else if (r.deadline)            buckets.upcoming.push(o);
      else                            buckets.no_deadline.push(o);
    }
    res.json({
      staff_id: me,
      counts: { overdue: buckets.overdue.length, today: buckets.today.length,
                upcoming: buckets.upcoming.length, no_deadline: buckets.no_deadline.length },
      ...buckets,
    });
  } catch (e) {
    console.error('[action-plan-items] mine error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /board — the manager view, every action across every plan ───────────
// Filters: assignee, status (open|in_progress|done|blocked|all), overdue=1,
// plan_id. Managers only: this is the whole setting's work.
router.get('/board', async (req, res) => {
  const db = getPool();
  try {
    if (!isManagerReq(req)) return res.status(403).json({ error: 'Manager access required' });
    await APT.ensureSchema(db);

    const params = [];
    let where = '(ap.id IS NULL OR ap.archived_at IS NULL)';

    const status = String(req.query.status || 'open');
    if (status === 'open') {
      where += ` AND i.status <> 'completed'`;
    } else if (status && status !== 'all') {
      const s = APT.normItemStatus(status);
      if (s) { params.push(s); where += ` AND i.status = $${params.length}`; }
    }
    if (req.query.assignee) {
      params.push(parseInt(req.query.assignee, 10));
      const p = `$${params.length}`;
      where += ` AND ( i.assigned_staff_id = ${p}
                       OR EXISTS (SELECT 1 FROM task_assignees a
                                   WHERE a.task_id = i.task_id AND a.staff_id = ${p}) )`;
    }
    if (req.query.plan_id) {
      params.push(parseInt(req.query.plan_id, 10));
      where += ` AND i.plan_id = $${params.length}`;
    }
    if (String(req.query.overdue || '') === '1') {
      where += ` AND i.deadline IS NOT NULL AND i.deadline < CURRENT_DATE AND i.status <> 'completed'`;
    }
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 300));

    const { rows } = await db.query(`
      SELECT i.id, i.title, i.description, i.priority, i.status, i.category,
             to_char(i.deadline,'YYYY-MM-DD') AS deadline,
             i.task_id, i.related_child_id, i.document_ref, i.completed_at,
             ap.id AS plan_id, ap.title AS plan_title, COALESCE(ap.is_task_plan,false) AS is_task_plan,
             (i.deadline IS NOT NULL AND i.deadline < CURRENT_DATE AND i.status <> 'completed') AS is_overdue,
             s.first_name || ' ' || s.last_name AS assignee_name,
             (SELECT COUNT(*)::int FROM action_plan_comments c WHERE c.item_id = i.id) AS comment_count,
             COALESCE((
               SELECT json_agg(json_build_object(
                        'staff_id', a.staff_id,
                        'name', st.first_name || ' ' || st.last_name,
                        'status', a.status) ORDER BY st.first_name)
                 FROM task_assignees a JOIN staff st ON st.id = a.staff_id
                WHERE a.task_id = i.task_id), '[]'::json) AS assignees
        FROM action_plan_items i
        LEFT JOIN action_plans ap ON ap.id = i.plan_id
        LEFT JOIN staff s ON s.id = i.assigned_staff_id
       WHERE ${where}
       ORDER BY (i.deadline IS NULL), i.deadline ASC,
                CASE i.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                i.id DESC
       LIMIT ${limit}`, params);

    res.json(rows.map(r => ({ ...r, status: APT.publicStatus(r.status) })));
  } catch (e) {
    console.error('[action-plan-items] board error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function sendTelegramTo(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await require('../lib/notifications').sendTelegramNow({ parse_mode: null, text });
  } catch {}
}

module.exports = router;
