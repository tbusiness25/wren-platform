const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

// b209 — assign work with deadlines, reminders and attachments. Everything
// below EXTENDS this router; the pre-b209 endpoints keep their behaviour so the
// cockpit card, the monthly checklist and Roost /tasks.html are untouched.
const taskReminders = require('../lib/task-reminders');
const { notify, notifyAsync } = require('../services/notification-dispatcher');
// b501 (Tasks v2) — groups, accountability, SMART fields, sub-tasks, comments, history.
const taskGroups = require('../lib/task-groups');
const taskAccountability = require('../lib/task-accountability');

router.use(authenticate);

// ── b209 role helpers ───────────────────────────────────────────────────────
// Who may assign work to someone else: managers to anyone, a room leader to
// their own room. Everyone else can still create a task — for themselves.
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
function isManager(req) { return MANAGER_ROLES.includes(req.user && req.user.role); }
function isRoomLeader(req) { return (req.user && req.user.role) === 'room_leader'; }
function portal(req) { return req._portal || 'learning'; }

// ── b501 helpers ────────────────────────────────────────────────────────────
// A parent token must never reach any task route. 'tasks' is in PARENT_DENY in server-unified.js; this is the belt to that
// pair of braces, and it also catches any non-staff role that somehow holds a token for a staff portal.
router.use((req, res, next) => {
  if (portal(req) === 'parents' || (req.user && req.user.role === 'parent')) return res.status(403).json({ error: 'Forbidden' });
  next();
});

/** Write one line to the task's history. Never throws — history must not break the action it records. */
async function hist(db, taskId, actorId, action, detail) {
  try {
    await db.query(`INSERT INTO task_history (task_id, actor_id, action, detail) VALUES ($1,$2,$3,$4::jsonb)`,
      [taskId, actorId || null, action, detail ? JSON.stringify(detail) : null]);
  } catch (e) { /* pre-b501 schema: ensureSchema adds the table on the first sweep */ }
}

/** Who may EDIT or DELETE a task: the person who set it, or a manager / deputy. (b501 security fix.) */
function canEditTask(req, task) {
  return isManager(req) || Number(task.created_by) === Number(req.user.id);
}

const SMART_TEXT = ['smart_specific', 'smart_measurable', 'smart_achievable', 'smart_relevant'];
const RELEVANT_KINDS = ['eyfs_area', 'ofsted_area', 'policy', 'child', 'room', 'other'];
const MODES = ['quick', 'smart'];

// ── b307 category ───────────────────────────────────────────────────────────
// 'nursery' = the setting's own work (the cockpit board). 'platform' = work on
// Wren itself (the Wren To Do List). A fifth axis alongside source/source_ref/
// linked_to/linked_id — it replaces none of them. Anything unrecognised (or
// absent) falls back to 'nursery', which is where an unclassified task belongs:
// never inferred from the title.
const CATEGORIES = ['nursery', 'platform'];
function normCategory(v, fallback = 'nursery') {
  const c = String(v == null ? '' : v).trim().toLowerCase();
  return CATEGORIES.includes(c) ? c : fallback;
}

/**
 * The staff ids this requester is allowed to put a task on.
 * Returns null for "anyone" (managers) so callers can skip the check entirely.
 */
async function assignableStaffIds(db, req) {
  if (isManager(req)) return null;
  const me = Number(req.user.id);
  const ids = new Set([me]);
  if (isRoomLeader(req)) {
    try {
      const { rows } = await db.query(
        `SELECT s.id FROM staff s
          WHERE s.is_active = true
            AND s.room_id IS NOT NULL
            AND s.room_id = (SELECT room_id FROM staff WHERE id = $1)`, [me]);
      rows.forEach(r => ids.add(Number(r.id)));
    } catch (e) {
      console.error('[tasks] room-leader scope lookup failed:', e.message);
    }
  }
  return ids;
}

/** Normalise whatever the client sent as assignees into a clean id array. */
function parseAssignees(body) {
  const raw = body.assignees != null ? body.assignees
            : (body.assignee_ids != null ? body.assignee_ids : null);
  if (raw == null) return null;                       // field absent = don't touch
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  const out = [];
  for (const v of arr) {
    const n = parseInt(v, 10);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Replace a task's assignee set, notify anyone newly added, and keep
 * tasks.owner_staff_id pointing at the first assignee so every pre-b209 reader
 * (cockpit card, /api/tasks/summary, the legacy reminder drainer) still sees
 * an owner. Rows already marked done are left alone — removing an assignee
 * must not erase the fact that they completed their line.
 */
async function setAssignees(db, req, task, staffIds, opts = {}) {
  const taskId = task.id;
  const { rows: before } = await db.query(
    `SELECT staff_id FROM task_assignees WHERE task_id=$1`, [taskId]);
  const had = new Set(before.map(r => Number(r.staff_id)));

  for (const sid of staffIds) {
    await db.query(
      `INSERT INTO task_assignees (task_id, staff_id, assigned_by, via)
       VALUES ($1,$2,$3,$4) ON CONFLICT (task_id, staff_id) DO NOTHING`,
      [taskId, sid, req.user.id || null, (opts.via && opts.via[sid]) || 'person']);
  }
  if (staffIds.length) {
    await db.query(
      `DELETE FROM task_assignees
        WHERE task_id=$1 AND NOT (staff_id = ANY($2::int[])) AND status <> 'done'`,
      [taskId, staffIds]);
    await db.query(`UPDATE tasks SET owner_staff_id=$2 WHERE id=$1`, [taskId, staffIds[0]]);
  }

  // Tell the people who did not already have this task.
  const added = staffIds.filter(sid => !had.has(sid));
  if (!opts.silent) {
    for (const sid of added) {
      if (Number(sid) === Number(req.user.id)) continue;   // no "you assigned yourself" ping
      const due = task.due_date
        ? 'Due ' + new Date(task.due_date).toLocaleDateString('en-GB',
            { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' })
        : 'No due date set';
      const others = staffIds.length - 1;
      notify('task_assigned', 'staff', sid, `📋 New task: ${task.title}`,
        `${due}${task.priority && task.priority !== 'medium' ? ` · ${task.priority} priority` : ''}`
          + (others > 0 ? ` · you and ${others} other${others === 1 ? '' : 's'}` : '') + '.',
        { relatedTable: 'tasks', relatedId: taskId, link: '/task-link?task=' + taskId,
          priority: task.priority === 'urgent' ? 'high' : 'normal' });
    }
  }
  if (added.length) await hist(db, taskId, req.user.id, 'assigned', { staff_ids: added, via: opts.via || null });
  return added;
}

// GET /api/tasks/summary
router.get('/summary', async (req, res) => {
  const db = getPool();
  try {
    const today = new Date().toISOString().split('T')[0];
    // 29 Oct: a non-manager saw the nursery's top overdue / today tasks with their owners'
    // names. Same rule as GET / below: theirs, created by them, or assigned to them.
    const mineOnly = !isManager(req);
    const mine = (p) => mineOnly ? ` AND (t.owner_staff_id = ${p} OR t.created_by = ${p}
                  OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.staff_id = ${p}))` : '';
    const me = Number(req.user.id);
    const { rows: overdue } = await db.query(
      `SELECT t.id, t.title, t.due_date, t.priority,
              s.first_name || ' ' || s.last_name AS owner_name
       FROM tasks t LEFT JOIN staff s ON s.id = t.owner_staff_id
       WHERE t.status IN ('open','in_progress') AND t.due_date < $1${mine('$2')}
       ORDER BY t.due_date ASC LIMIT 3`,
      mineOnly ? [today, me] : [today]
    );
    const { rows: todayTasks } = await db.query(
      `SELECT t.id, t.title, t.due_date, t.priority,
              s.first_name || ' ' || s.last_name AS owner_name
       FROM tasks t LEFT JOIN staff s ON s.id = t.owner_staff_id
       WHERE t.status IN ('open','in_progress') AND t.due_date = $1${mine('$2')}
       ORDER BY t.priority DESC LIMIT 3`,
      mineOnly ? [today, me] : [today]
    );
    const { rows: countRow } = await db.query(
      `SELECT COUNT(*) AS total FROM tasks t WHERE t.status IN ('open','in_progress')${mine('$1')}`,
      mineOnly ? [me] : []
    );
    res.json({ overdue, today: todayTasks, total_open: parseInt(countRow[0].total) });
  } catch (err) {
    console.error('tasks summary error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/tasks
// b209: scoped. A manager/deputy still sees every task (unchanged — this is what
// Roost /tasks.html and the cockpit card have always shown). Anyone else now sees
// only the tasks that are theirs: assigned to them, owned by them, or created by
// them. Before b209 this endpoint returned the whole board to any authenticated
// staff member, which with named assignees would have been a real leak.
router.get('/', async (req, res) => {
  const db = getPool();
  try {
    const { status, owner } = req.query;
    let q = `SELECT t.*, s.first_name || ' ' || s.last_name AS owner_name
             FROM tasks t LEFT JOIN staff s ON s.id = t.owner_staff_id WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); q += ` AND t.status = $${params.length}`; }
    if (owner)  { params.push(parseInt(owner)); q += ` AND t.owner_staff_id = $${params.length}`; }
    // b307 — ?category=nursery|platform. Absent = every category, so every
    // pre-b307 caller (Roost /tasks.html, the cockpit card) is unchanged.
    if (req.query.category && CATEGORIES.includes(String(req.query.category))) {
      params.push(String(req.query.category));
      q += ` AND t.category = $${params.length}`;
    }
    if (!isManager(req)) {
      params.push(Number(req.user.id));
      const p = `$${params.length}`;
      q += ` AND (t.owner_staff_id = ${p} OR t.created_by = ${p}
                  OR EXISTS (SELECT 1 FROM task_assignees a
                              WHERE a.task_id = t.id AND a.staff_id = ${p}))`;
    }
    // b307 — a single-category read is a LIST, so it honours the manual order
    // first. The unfiltered read keeps its pre-b307 ordering exactly, so
    // Roost /tasks.html and the cockpit card do not shift under anyone.
    q += (req.query.category && CATEGORIES.includes(String(req.query.category)))
      ? ' ORDER BY t.sort_order ASC NULLS LAST, t.due_date ASC NULLS LAST, t.priority DESC, t.id ASC'
      : ' ORDER BY t.due_date ASC NULLS LAST, t.priority DESC, t.created_at DESC';
    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (err) {
    console.error('tasks GET error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/tasks
// b209 extends this in place rather than adding a second create endpoint: the pre-b209 body ({title, priority, due_date, …})
// behaves exactly as before. b501 (Tasks v2) adds, all optional:
//   assign {people[], roles[], rooms[], team}   one person, several, a role, a room, or everyone (resolved to people now)
//   mode 'quick'|'smart' + smart_specific / smart_measurable / smart_achievable / smart_relevant (+ relevant_kind/ref),
//   start_date, evidence_required, skip_non_open_days, is_project, parent_task_id (a sub-task / milestone), subtasks[]
async function createTask(db, req, b, opts = {}) {
  const { title, description, status, priority, due_date, owner_staff_id,
          source, source_ref, linked_to, linked_id, time_of_day,
          room_id, repeat_rule, repeat_every, repeat_until } = b;
  if (!title || !String(title).trim()) return { status: 400, json: { error: 'title required' } };
  const category = normCategory(b.category, 'nursery');
  if (repeat_rule && !taskReminders.REPEAT_RULES.includes(String(repeat_rule))) {
    return { status: 400, json: { error: `repeat_rule must be one of: ${taskReminders.REPEAT_RULES.join(', ')}` } };
  }
  const mode = MODES.includes(String(b.mode)) ? String(b.mode)
    : (SMART_TEXT.some(f => b[f]) || b.start_date ? 'smart' : 'quick');
  const relevantKind = b.relevant_kind && RELEVANT_KINDS.includes(String(b.relevant_kind)) ? String(b.relevant_kind) : null;

  // A sub-task hangs off a project: you must be able to edit the project to add to it.
  let parent = null;
  if (b.parent_task_id) {
    const pid = parseInt(b.parent_task_id, 10);
    const { rows: [pr] } = await db.query(`SELECT * FROM tasks WHERE id=$1`, [pid]);
    if (!pr) return { status: 404, json: { error: 'Project not found' } };
    if (!canEditTask(req, pr)) return { status: 403, json: { error: 'Only the person who set the project, or a manager, can add to it' } };
    if (pr.parent_task_id) return { status: 400, json: { error: 'A sub-task cannot have sub-tasks of its own' } };
    parent = pr;
  }

  // Who is this for? assign{} / assignees[] win; owner_staff_id is the legacy single form; with neither, an assigner's
  // task is unassigned (their own list) and everyone else's is implicitly their own.
  const parsed = taskGroups.parseSpec(b);
  let assignees = [], via = {};
  if (parsed.present) {
    const r = await taskGroups.resolve(db, req, parsed.spec);
    if (r.error) return { status: r.status || 400, json: { error: r.error, blocked_staff_ids: r.blocked } };
    assignees = r.ids; via = r.via;
  } else if (owner_staff_id) {
    const r = await taskGroups.resolve(db, req, { people: [parseInt(owner_staff_id, 10)], roles: [], rooms: [], team: false });
    if (r.error) return { status: r.status || 400, json: { error: r.error, blocked_staff_ids: r.blocked } };
    assignees = r.ids; via = r.via;
  }
  if (!assignees.length && !parent && !isManager(req) && !isRoomLeader(req)) { assignees = [Number(req.user.id)]; via[assignees[0]] = 'person'; }

  const { rows } = await db.query(
    `INSERT INTO tasks (title, description, status, priority, due_date,
       owner_staff_id, created_by, source, source_ref, linked_to, linked_id,
       time_of_day, room_id, repeat_rule, repeat_every, repeat_until, category,
       mode, is_project, parent_task_id, start_date, smart_specific, smart_measurable, smart_achievable, smart_relevant,
       relevant_kind, relevant_ref, evidence_required, skip_non_open_days, assignee_spec)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30) RETURNING *`,
    [String(title).trim(), description || null, status || 'open', priority || 'medium',
     due_date || null, assignees[0] || null, req.user.id,
     source || 'manual', source_ref || null, linked_to || null, linked_id || null,
     time_of_day || null, room_id ? parseInt(room_id, 10) : null,
     repeat_rule || null, parseInt(repeat_every, 10) || 1, repeat_until || null,
     category,
     mode, !!b.is_project || (Array.isArray(b.subtasks) && b.subtasks.length > 0), parent ? parent.id : null,
     b.start_date || null,
     b.smart_specific || null, b.smart_measurable || null, b.smart_achievable || null, b.smart_relevant || null,
     relevantKind, b.relevant_ref != null ? String(b.relevant_ref) : null,
     !!b.evidence_required, !!b.skip_non_open_days,
     parsed.present ? JSON.stringify(parsed.spec) : null]);
  const task = rows[0];

  if (assignees.length) await setAssignees(db, req, task, assignees, { via });
  await hist(db, task.id, req.user.id, parent ? 'subtask_added' : 'created', { mode, parent_task_id: parent ? parent.id : null, assignees: assignees.length });
  if (parent) await hist(db, parent.id, req.user.id, 'subtask_added', { task_id: task.id, title: task.title });

  // Milestones given with the task, each with its own due date and optional assignee.
  const made = [];
  if (!parent && Array.isArray(b.subtasks)) {
    for (const st of b.subtasks.slice(0, 50)) {
      if (!st || !st.title) continue;
      const r = await createTask(db, req, Object.assign({}, st, { parent_task_id: task.id, category: task.category, priority: st.priority || task.priority }), { nested: true });
      if (r.status === 201) made.push(r.json.id); else return r;
    }
  }
  // Schedule inline so the caller can PROVE the reminders exist; the sweep would pick it up within 30s anyway.
  let reminders = [];
  try { reminders = await taskReminders.scheduleTaskReminders(db, task.id); }
  catch (e) { console.error('[tasks] reminder scheduling failed:', e.message); }
  return { status: 201, json: { ...task, assignees, via, subtask_ids: made, reminders } };
}

router.post('/', async (req, res) => {
  const db = getPool();
  try {
    const r = await createTask(db, req, req.body || {});
    res.status(r.status).json(r.json);
  } catch (err) {
    console.error('tasks POST error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// PUT /api/tasks/:id
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  // b209 — room link, repeat rule and completion note joined the list.
  // b307 — 'category' and 'sort_order' joined the list. category is what the
  // one-click "this is a Wren task" control writes; sort_order is the manual
  // position in the Wren To Do List.
  const allowed = ['title','description','status','priority','due_date',
                 'owner_staff_id','source','source_ref','linked_to','linked_id',
                 'time_of_day','room_id','repeat_rule','repeat_every','repeat_until',
                 'completion_note','category','sort_order',
                 // b501
                 'mode','is_project','parent_task_id','start_date','smart_specific','smart_measurable','smart_achievable',
                 'smart_relevant','relevant_kind','relevant_ref','evidence_required','skip_non_open_days','archived_at'];
  // b501 SECURITY FIX — before this, any signed-in staff member could edit any task by id. Edit = the person who set the
  // task, or a manager / deputy. An assignee ticks their own part through POST /:id/complete (and /uncomplete).
  try {
    const { rows: [cur] } = await getPool().query(`SELECT id, created_by FROM tasks WHERE id=$1`, [parseInt(id, 10) || 0]);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (!canEditTask(req, cur)) return res.status(403).json({ error: 'Only the person who set this task, or a manager, can edit it' });
  } catch (err) { return res.status(500).json({ error: 'DB error' }); }
  if (req.body.parent_task_id !== undefined && req.body.parent_task_id !== null && Number(req.body.parent_task_id) === parseInt(id, 10)) {
    return res.status(400).json({ error: 'A task cannot be its own project' });
  }
  if (req.body.mode !== undefined && !MODES.includes(String(req.body.mode))) return res.status(400).json({ error: `mode must be one of: ${MODES.join(', ')}` });
  if (req.body.relevant_kind && !RELEVANT_KINDS.includes(String(req.body.relevant_kind))) return res.status(400).json({ error: `relevant_kind must be one of: ${RELEVANT_KINDS.join(', ')}` });
  const updates = [];
  const vals = [];
  for (const f of allowed) {
    if (req.body[f] !== undefined) {
      // Never let a typo'd category through to the CHECK constraint as a 500.
      if (f === 'category' && !CATEGORIES.includes(String(req.body[f]))) {
        return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
      }
      vals.push(f === 'sort_order'
        ? (req.body[f] === null ? null : (parseInt(req.body[f], 10) || 0))
        : req.body[f]);
      updates.push(`${f} = $${vals.length}`);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
  vals.push(new Date().toISOString());
  updates.push(`updated_at = $${vals.length}`);
  if (req.body.status === 'done') {
    vals.push(new Date().toISOString());
    updates.push(`completed_at = $${vals.length}`);
  }
  vals.push(id);
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const task = rows[0];

    // b209 — reassignment (managers / room leaders only, within their scope). b501: a role / room / team works here too.
    let assignees = null;
    const parsedSpec = taskGroups.parseSpec(req.body);
    if (parsedSpec.present) {
      const r = await taskGroups.resolve(db, req, parsedSpec.spec);
      if (r.error) return res.status(r.status || 400).json({ error: r.error, blocked_staff_ids: r.blocked });
      if (r.ids.length) {
        assignees = r.ids;
        await setAssignees(db, req, task, assignees, { via: r.via });
        await db.query(`UPDATE tasks SET assignee_spec=$2::jsonb WHERE id=$1`, [task.id, JSON.stringify(parsedSpec.spec)]).catch(() => {});
      }
    }
    await hist(db, task.id, req.user.id, req.body.status === 'done' ? 'completed_by_editor' : 'edited',
      { fields: allowed.filter(f => req.body[f] !== undefined) });
    // Marking the whole task done closes everyone's line with it, so a stale
    // reminder can't fire at someone for work that is finished.
    if (req.body.status === 'done') {
      await db.query(
        `UPDATE task_assignees SET status='done', completed_at=COALESCE(completed_at, NOW())
          WHERE task_id=$1 AND status <> 'done'`, [task.id]).catch(() => {});
      await db.query(
        `UPDATE task_reminders SET status='skipped', fired_at=NOW()
          WHERE task_id=$1 AND kind='lead' AND status='scheduled'`, [task.id]).catch(() => {});
    }
    // A moved deadline or a new team means new reminder rows.
    if (req.body.due_date !== undefined || req.body.time_of_day !== undefined || assignees) {
      try { await taskReminders.scheduleTaskReminders(db, task.id); }
      catch (e) { console.error('[tasks] reminder re-scheduling failed:', e.message); }
    }
    res.json(task);
  } catch (err) {
    console.error('tasks PUT error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/tasks/monthly-checklist?year=&month=
// Returns the standard monthly admin checklist, auto-seeding it if this is a new month.
const MONTHLY_CHECKLIST_ITEMS = [
  { title: 'Process payroll & wages',          priority: 'high',   description: 'Run wages summary, create payroll run, export for BrightPay/accountant.' },
  { title: 'Submit funding claim to Ealing LA', priority: 'high',   description: 'EYPP, 15h/30h universal and extended. Portal: ealing.gov.uk' },
  { title: 'Send parent newsletter',            priority: 'high',   description: 'Draft, review with deputy, send via Wren comms.' },
  { title: 'Medicine records audit',            priority: 'high',   description: 'Review all active medicine records. Archive completed courses.' },
  { title: 'Safeguarding register review',      priority: 'high',   description: 'Check all open concerns with the deputy. Update risk status.' },
  { title: 'Risk assessment review',            priority: 'medium', description: 'Review any outstanding risk assessments flagged for update this month.' },
  { title: 'Staff supervision scheduling',      priority: 'medium', description: 'Ensure all staff have a supervision booked within the quarter.' },
  { title: 'Incident & accident log review',    priority: 'medium', description: 'Review all incidents from the past month. Look for patterns.' },
  { title: 'Process absence requests',          priority: 'medium', description: 'Approve/reject outstanding holiday and sick leave requests.' },
  { title: 'CPD records check',                 priority: 'medium', description: 'Update any completed training. Check upcoming mandatory renewals.' },
  { title: 'Fire drill (if quarterly due)',      priority: 'medium', description: 'Check last drill date. Run drill if >3 months since last one.' },
  { title: 'Check DBS renewal dates',           priority: 'low',    description: 'Flag any DBS certificates expiring in the next 3 months.' },
  { title: 'Kitchen & fridge/freezer logs',     priority: 'low',    description: 'Review temperature logs for the month. Flag any out-of-range readings.' },
  { title: 'Parent messages — outstanding',     priority: 'low',    description: 'Check for any unanswered parent messages over 48h old.' },
  { title: 'SEN register review',               priority: 'low',    description: 'Review SEN register with SENCO. Update EHCP targets if due.' },
  { title: 'Invoices & outstanding balances',   priority: 'low',    description: 'Chase outstanding invoice balances over 30 days.' },
];

router.get('/monthly-checklist', async (req, res) => {
  const now = new Date();
  const y = parseInt(req.query.year  || now.getFullYear());
  const m = parseInt(req.query.month || now.getMonth() + 1);
  const ref = `monthly-checklist-${y}-${String(m).padStart(2, '0')}`;
  const dueDate = new Date(y, m - 1, 28).toISOString().split('T')[0]; // last working day-ish
  const db = getPool();
  try {
    const { rows: existing } = await db.query(
      `SELECT * FROM tasks WHERE source = 'monthly_checklist' AND source_ref = $1 ORDER BY id ASC`,
      [ref]
    );
    if (existing.length > 0) return res.json({ items: existing, seeded: false, ref });

    // First time for this month — seed the checklist
    const seeded = [];
    for (const item of MONTHLY_CHECKLIST_ITEMS) {
      const { rows } = await db.query(
        `INSERT INTO tasks (title, description, status, priority, due_date, owner_staff_id, created_by, source, source_ref)
         VALUES ($1, $2, 'open', $3, $4, $5, $5, 'monthly_checklist', $6) RETURNING *`,
        [item.title, item.description, item.priority, dueDate, req.user.id, ref]
      );
      seeded.push(rows[0]);
    }
    res.json({ items: seeded, seeded: true, ref });
  } catch (err) {
    console.error('monthly-checklist error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res) => {
  const db = getPool();
  try {
    // b501 SECURITY FIX — delete = the person who set the task, or a manager / deputy.
    const tid = parseInt(req.params.id, 10);
    if (!Number.isInteger(tid)) return res.status(400).json({ error: 'bad task id' });
    const { rows: [cur] } = await db.query('SELECT id, created_by, title FROM tasks WHERE id = $1', [tid]);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (!canEditTask(req, cur)) return res.status(403).json({ error: 'Only the person who set this task, or a manager, can delete it' });
    const { rows: [kids] } = await db.query('SELECT count(*)::int AS n FROM tasks WHERE parent_task_id = $1', [tid]);
    if (kids.n > 0 && String(req.query.with_subtasks || '') !== '1') {
      return res.status(409).json({ error: 'has_subtasks', message: `This project has ${kids.n} sub-task${kids.n === 1 ? '' : 's'}. Delete them too?`, subtasks: kids.n });
    }
    if (kids.n > 0) await db.query('DELETE FROM tasks WHERE parent_task_id = $1', [tid]);
    await db.query('DELETE FROM tasks WHERE id = $1', [tid]);
    res.json({ ok: true, deleted_subtasks: kids.n });
  } catch (err) {
    console.error('tasks DELETE error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   b209 — assign work with deadlines, reminders and attachments.

   Appended, never rewritten: every route above keeps its behaviour. Route
   order matters — all of these are either literal paths ('/mine', '/board') or
   two-segment paths, so none of them is shadowed by the single-segment
   '/:id' handlers above.
   ═══════════════════════════════════════════════════════════════════════════ */

// Due moment as a SQL expression: the date plus its time-of-day, read in London
// wall-clock. Shared with the reminder engine rather than rewritten here — and
// it is guarded, because tasks.time_of_day is free text and really does contain
// values like 'morning' that a bare ::time cast dies on.
const DUE_AT_SQL = (timeParam, tzParam) => taskReminders.DUE_AT_SQL('t', timeParam, tzParam);
const TZ = taskReminders.TZ;

/** Can this requester see this task at all? Managers yes; otherwise it must be theirs. */
async function canSeeTask(db, req, taskId) {
  const { rows } = await db.query(
    `SELECT t.*,
            EXISTS (SELECT 1 FROM task_assignees a
                     WHERE a.task_id = t.id AND a.staff_id = $2) AS is_assignee
       FROM tasks t WHERE t.id = $1`, [taskId, Number(req.user.id)]);
  const t = rows[0];
  if (!t) return null;
  if (isManager(req)) return t;
  const me = Number(req.user.id);
  if (t.is_assignee || Number(t.owner_staff_id) === me || Number(t.created_by) === me) return t;
  // b501 — a sub-task is visible to anyone on its project; a project is visible to anyone on one of its sub-tasks.
  const { rows: [rel] } = await db.query(
    `SELECT 1 AS ok FROM tasks x
      WHERE (x.id = $2::int OR x.parent_task_id = $1::int OR ($2::int IS NOT NULL AND x.parent_task_id = $2::int))
        AND (x.owner_staff_id = $3::int OR x.created_by = $3::int
             OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = x.id AND a.staff_id = $3))
      LIMIT 1`, [t.id, t.parent_task_id, me]);
  if (rel) { t._via_project = true; return t; }
  return false;
}

// ── GET /api/tasks/assignable-staff — who this person may assign work to ────
router.get('/assignable-staff', async (req, res) => {
  const db = getPool();
  try {
    const allowed = await assignableStaffIds(db, req);
    const params = [];
    let where = `s.is_active = true AND s.role <> 'parent'`;
    if (allowed) { params.push([...allowed]); where += ` AND s.id = ANY($1::int[])`; }
    const { rows } = await db.query(
      `SELECT s.id, s.first_name, s.last_name, s.role, s.room_id, r.name AS room_name
         FROM staff s LEFT JOIN rooms r ON r.id = s.room_id
        WHERE ${where}
        ORDER BY s.first_name, s.last_name`, params);
    res.json({
      can_assign_others: allowed == null || allowed.size > 1,
      scope: isManager(req) ? 'all' : (isRoomLeader(req) ? 'my_room' : 'self'),
      staff: rows,
    });
  } catch (err) {
    console.error('[tasks] assignable-staff error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /api/tasks/mine — the staff member's own list, bucketed ─────────────
// Due today / overdue / upcoming, plus anything undated and what they finished
// in the last week. A practitioner can only ever reach their own rows here:
// the staff id comes from the signed token, never from the query string.
router.get('/mine', async (req, res) => {
  const db = getPool();
  try {
    const me = Number(req.user.id);
    const defaultTime = await taskReminders.getDefaultDueTime(db);
    const { rows } = await db.query(`
      SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date,
             t.time_of_day, t.room_id, t.linked_to, t.linked_id, t.repeat_rule,
             t.completion_note, t.created_at, t.created_by,
             t.mode, t.is_project, t.parent_task_id, t.evidence_required,
             (SELECT p.title FROM tasks p WHERE p.id = t.parent_task_id) AS project_title,
             (SELECT count(*)::int FROM tasks c WHERE c.parent_task_id = t.id) AS subtasks_total,
             (SELECT count(*)::int FROM tasks c WHERE c.parent_task_id = t.id AND c.status = 'done') AS subtasks_done,
             COALESCE(a.status, CASE WHEN t.status = 'done' THEN 'done' ELSE 'open' END) AS my_status,
             a.completed_at AS my_completed_at,
             a.completion_note AS my_note,
             ${DUE_AT_SQL('$2', '$3')} AS due_at,
             (t.due_date = CURRENT_DATE) AS is_today,
             (t.status = ANY($4::text[]) AND t.due_date IS NOT NULL
               AND ${DUE_AT_SQL('$2', '$3')} < NOW()) AS is_overdue,
             r.name AS room_name,
             c.first_name || ' ' || c.last_name AS created_by_name,
             (SELECT count(*) FROM task_attachments ta
               WHERE ta.task_id = t.id AND ta.deleted = false)::int AS attachment_count
        FROM tasks t
        LEFT JOIN task_assignees a ON a.task_id = t.id AND a.staff_id = $1
        LEFT JOIN rooms r ON r.id = t.room_id
        LEFT JOIN staff c ON c.id = t.created_by
       WHERE (a.staff_id = $1 OR (a.staff_id IS NULL AND t.owner_staff_id = $1))
         AND (t.status = ANY($4::text[]) OR t.completed_at > NOW() - INTERVAL '7 days')
       ORDER BY t.due_date ASC NULLS LAST,
                CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2
                                WHEN 'medium' THEN 3 ELSE 4 END,
                t.id`,
      [me, defaultTime, TZ, taskReminders.OPEN_STATUSES]);

    const buckets = { overdue: [], today: [], upcoming: [], no_due: [], recently_done: [] };
    for (const t of rows) {
      if (t.my_status === 'done') buckets.recently_done.push(t);
      else if (t.is_overdue)      buckets.overdue.push(t);
      else if (t.is_today)        buckets.today.push(t);
      else if (t.due_date)        buckets.upcoming.push(t);
      else                        buckets.no_due.push(t);
    }
    res.json({ staff_id: me, counts: {
      overdue: buckets.overdue.length, today: buckets.today.length,
      upcoming: buckets.upcoming.length, no_due: buckets.no_due.length },
      ...buckets });
  } catch (err) {
    console.error('[tasks] mine error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── POST /api/tasks/:id/complete — tick off my line, with an optional note ──
// A note is REQUIRED when the task is already overdue: "why was this late" is
// the one piece of information the manager cannot reconstruct afterwards.
// b501: it is YOUR line (an assignee may only tick or untick their own part); a manager can tick one person's part with
// { on_behalf_of: staffId }; evidence_required tasks need a photo / file from you first; a project with open sub-tasks
// cannot be completed; an unassigned milestone is ticked in place by anyone on the project.
router.post('/:id/complete', async (req, res) => {
  const db = getPool();
  try {
    const taskId = parseInt(req.params.id, 10);
    if (!Number.isInteger(taskId)) return res.status(400).json({ error: 'bad task id' });
    let me = Number(req.user.id);
    const note = (req.body && req.body.note ? String(req.body.note) : '').trim();

    const task = await canSeeTask(db, req, taskId);
    if (task === null) return res.status(404).json({ error: 'Not found' });
    if (task === false) return res.status(403).json({ error: 'This task is not assigned to you' });

    const behalf = req.body && req.body.on_behalf_of ? parseInt(req.body.on_behalf_of, 10) : null;
    if (behalf && behalf !== me) {
      if (!isManager(req)) return res.status(403).json({ error: 'Only a manager can tick off somebody else\'s part' });
      me = behalf;
    }

    const { rows: lines } = await db.query(`SELECT staff_id, status FROM task_assignees WHERE task_id=$1`, [taskId]);
    const myLine = lines.find(l => Number(l.staff_id) === me);
    const isOwnerOnly = !lines.length && Number(task.owner_staff_id) === me;
    const unassigned = !lines.length && !task.owner_staff_id;
    if (!myLine && !isOwnerOnly) {
      // Not on the team: only an UNASSIGNED milestone/task may be ticked in place, by someone who can see it.
      if (!unassigned) return res.status(403).json({ error: 'This task is not assigned to you' });
    }

    // A project is done when its sub-tasks are.
    const { rows: [open] } = await db.query(
      `SELECT count(*)::int AS n FROM tasks WHERE parent_task_id=$1 AND status = ANY($2::text[])`, [taskId, taskReminders.OPEN_STATUSES]);
    if (open.n > 0) {
      return res.status(409).json({ error: 'subtasks_open', open_subtasks: open.n,
        message: `${open.n} sub-task${open.n === 1 ? ' is' : 's are'} still open. Finish them first.` });
    }

    const defaultTime = await taskReminders.getDefaultDueTime(db);
    const { rows: [chk] } = await db.query(
      `SELECT (t.due_date IS NOT NULL AND ${DUE_AT_SQL('$2', '$3')} < NOW()) AS overdue
         FROM tasks t WHERE t.id = $1`, [taskId, defaultTime, TZ]);
    if (chk && chk.overdue && !note) {
      return res.status(400).json({
        error: 'note_required_overdue',
        message: 'This task is overdue — please add a short note saying what happened.' });
    }

    // Evidence: a photo or file from THIS person must be on the task before it can be ticked.
    if (task.evidence_required) {
      const { rows: [ev] } = await db.query(
        `SELECT count(*)::int AS n FROM task_attachments WHERE task_id=$1 AND kind='evidence' AND deleted=false AND uploaded_by=$2`, [taskId, me]);
      if (!ev.n) {
        return res.status(400).json({ error: 'evidence_required',
          message: 'This task needs a photo or file as evidence. Upload it first, then tick it off.' });
      }
    }

    // Legacy tasks (owner only, no assignee row) get one on the way past.
    if (myLine || isOwnerOnly) {
      await db.query(
        `INSERT INTO task_assignees (task_id, staff_id, assigned_by, via)
         VALUES ($1,$2,$3,'owner') ON CONFLICT (task_id, staff_id) DO NOTHING`,
        [taskId, me, task.created_by || null]);
      await db.query(
        `UPDATE task_assignees SET status='done', completed_at=NOW(), completion_note=$3
          WHERE task_id=$1 AND staff_id=$2`, [taskId, me, note || null]);
      // Any reminder still queued for me is now pointless.
      await db.query(
        `UPDATE task_reminders SET status='skipped', fired_at=NOW()
          WHERE task_id=$1 AND staff_id=$2 AND kind='lead' AND status='scheduled'`, [taskId, me]);
    }

    // The task itself is done only when NOBODY still has it open.
    const { rows: [outstanding] } = await db.query(
      `SELECT count(*)::int AS n FROM task_assignees WHERE task_id=$1 AND status <> 'done'`, [taskId]);
    let taskDone = false;
    if (outstanding.n === 0) {
      await db.query(
        `UPDATE tasks SET status='done', completed_at=NOW(), updated_at=NOW(),
                completion_note=COALESCE(NULLIF($2,''), completion_note)
          WHERE id=$1 AND status <> 'done'`, [taskId, note]);
      await db.query(
        `UPDATE task_reminders SET status='skipped', fired_at=NOW()
          WHERE task_id=$1 AND kind='lead' AND status='scheduled'`, [taskId]);
      taskDone = true;
    }
    await hist(db, taskId, Number(req.user.id), behalf && behalf !== Number(req.user.id) ? 'completed_on_behalf' : 'completed',
      { staff_id: me, late: !!(chk && chk.overdue), note: note || null, task_complete: taskDone });

    const { rows: [fresh] } = await db.query(`SELECT * FROM tasks WHERE id=$1`, [taskId]);
    res.json({ ok: true, task_complete: taskDone, outstanding_assignees: outstanding.n,
               was_overdue: !!(chk && chk.overdue), task: fresh });
  } catch (err) {
    console.error('[tasks] complete error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── POST /api/tasks/:id/uncomplete — untick my line (an assignee may only untick their own part) ─────
router.post('/:id/uncomplete', async (req, res) => {
  const db = getPool();
  try {
    const taskId = parseInt(req.params.id, 10);
    if (!Number.isInteger(taskId)) return res.status(400).json({ error: 'bad task id' });
    let me = Number(req.user.id);
    const task = await canSeeTask(db, req, taskId);
    if (task === null) return res.status(404).json({ error: 'Not found' });
    if (task === false) return res.status(403).json({ error: 'This task is not assigned to you' });
    const behalf = req.body && req.body.on_behalf_of ? parseInt(req.body.on_behalf_of, 10) : null;
    if (behalf && behalf !== me) {
      if (!isManager(req)) return res.status(403).json({ error: 'Only a manager can untick somebody else\'s part' });
      me = behalf;
    }
    const { rows: lines } = await db.query(`SELECT staff_id FROM task_assignees WHERE task_id=$1`, [taskId]);
    const mine = lines.some(l => Number(l.staff_id) === me);
    if (lines.length && !mine) return res.status(403).json({ error: 'This task is not assigned to you' });
    if (mine) {
      await db.query(`UPDATE task_assignees SET status='open', completed_at=NULL, completion_note=NULL WHERE task_id=$1 AND staff_id=$2`, [taskId, me]);
    }
    await db.query(`UPDATE tasks SET status='open', completed_at=NULL, updated_at=NOW() WHERE id=$1 AND status='done'`, [taskId]);
    // A parent that was waiting on this one is no longer finished either.
    if (task.parent_task_id) await db.query(`UPDATE tasks SET status='open', completed_at=NULL, updated_at=NOW() WHERE id=$1 AND status='done'`, [task.parent_task_id]);
    try { await taskReminders.scheduleTaskReminders(db, taskId); } catch (_) {}
    await hist(db, taskId, Number(req.user.id), 'unticked', { staff_id: me });
    const { rows: [fresh] } = await db.query(`SELECT * FROM tasks WHERE id=$1`, [taskId]);
    res.json({ ok: true, task: fresh });
  } catch (err) {
    console.error('[tasks] uncomplete error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

/* ── Attachments ────────────────────────────────────────────────────────────
   Same storage shape, size ceiling and extension allowlist as
   src/routes/person-documents.js — deliberately the same upload stack, not a
   new one. An attachment may carry child-identifying material (a scanned form,
   a photo of a notice), so:
     · staff auth only, and the parents portal is refused outright (belt and
       braces over 'tasks' already being in PARENT_DENY in server-unified.js);
     · files are served through this route, never from a static directory;
     · retention follows the 'staff_task_record' policy seeded by the b209
       migration, which names task_attachments in its record_tables.           */

const ATTACH_BASE = process.env.TASK_ATTACH_BASE
  || path.join(__dirname, '../../data/task-attachments');
const ATTACH_MAX_BYTES = 30 * 1024 * 1024; // 30MB — matches person-documents
const ATTACH_EXT = {
  '.pdf':  'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.heic': 'image/heic',
  '.mp4':  'video/mp4',
};

const attachUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(ATTACH_BASE, 'tmp');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      cb(null, dir);
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.bin';
      cb(null, `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: ATTACH_MAX_BYTES },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ATTACH_EXT[ext]) return cb(null, true);
    cb(new Error(`Unsupported file type "${ext}". Accepted: ${Object.keys(ATTACH_EXT).join(', ')}`));
  },
});

function pubAttachment(r) {
  return {
    id: r.id, task_id: r.task_id, title: r.title, filename: r.filename,
    mime: r.mime, size_bytes: r.size_bytes != null ? Number(r.size_bytes) : null,
    uploaded_by: r.uploaded_by, uploaded_by_name: r.uploaded_by_name || null,
    uploaded_at: r.uploaded_at, notes: r.notes, kind: r.kind || 'material',
    file_url: r.stored_path ? `/api/tasks/attachments/${r.id}/file` : null,
  };
}

// GET /api/tasks/:id/attachments
router.get('/:id/attachments', async (req, res) => {
  const db = getPool();
  try {
    if (portal(req) === 'parents') return res.status(403).json({ error: 'Forbidden' });
    const taskId = parseInt(req.params.id, 10);
    const task = await canSeeTask(db, req, taskId);
    if (task === null) return res.status(404).json({ error: 'Not found' });
    if (task === false) return res.status(403).json({ error: 'Forbidden' });
    const { rows } = await db.query(
      `SELECT ta.*, s.first_name || ' ' || s.last_name AS uploaded_by_name
         FROM task_attachments ta LEFT JOIN staff s ON s.id = ta.uploaded_by
        WHERE ta.task_id=$1 AND ta.deleted=false ORDER BY ta.uploaded_at DESC`, [taskId]);
    res.json(rows.map(pubAttachment));
  } catch (err) {
    console.error('[tasks] attachments list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tasks/:id/attachments  (multipart, field name: file)
router.post('/:id/attachments', (req, res) => {
  attachUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const tmpPath = req.file && req.file.path;
    const cleanup = () => { if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} } };
    try {
      const db = getPool();
      if (portal(req) === 'parents') { cleanup(); return res.status(403).json({ error: 'Forbidden' }); }
      if (!req.file) return res.status(400).json({ error: 'file is required' });

      const taskId = parseInt(req.params.id, 10);
      const task = await canSeeTask(db, req, taskId);
      if (task === null) { cleanup(); return res.status(404).json({ error: 'Not found' }); }
      if (task === false) { cleanup(); return res.status(403).json({ error: 'Forbidden' }); }

      const ext = path.extname(req.file.originalname).toLowerCase();
      const finalDir = path.join(ATTACH_BASE, String(taskId));
      fs.mkdirSync(finalDir, { recursive: true });
      const finalPath = path.join(finalDir, req.file.filename);
      fs.renameSync(req.file.path, finalPath);

      const title = (req.body.title || '').trim() || req.file.originalname;
      const notes = (req.body.notes || '').trim() || null;
      // b501 — 'material' = guidance / templates from whoever set the task; 'evidence' = what an assignee uploads to prove it.
      const kind = String(req.body.kind || '') === 'evidence' ? 'evidence' : 'material';
      if (kind === 'material' && !canEditTask(req, task)) {
        fs.unlink(finalPath, () => {});
        return res.status(403).json({ error: 'Only the person who set this task, or a manager, can add materials. Use evidence to show your work.' });
      }
      const { rows: [row] } = await db.query(
        `INSERT INTO task_attachments
           (task_id, title, filename, stored_path, mime, size_bytes, uploaded_by, notes, kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [taskId, title, req.file.originalname, finalPath,
         ATTACH_EXT[ext] || req.file.mimetype, req.file.size, req.user.id || null, notes, kind]);
      await hist(db, taskId, req.user.id, kind === 'evidence' ? 'evidence_added' : 'material_added', { attachment_id: row.id, filename: req.file.originalname });
      res.status(201).json(pubAttachment(row));
    } catch (e) {
      cleanup();
      console.error('[tasks] attachment upload error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
});

// GET /api/tasks/attachments/:attId/file — stream it, scoped
router.get('/attachments/:attId/file', async (req, res) => {
  const db = getPool();
  try {
    if (portal(req) === 'parents') return res.status(403).json({ error: 'Forbidden' });
    const { rows: [att] } = await db.query(
      `SELECT * FROM task_attachments WHERE id=$1 AND deleted=false`, [req.params.attId]);
    if (!att) return res.status(404).json({ error: 'Not found' });
    const task = await canSeeTask(db, req, att.task_id);
    if (!task) return res.status(403).json({ error: 'Forbidden' });
    if (!att.stored_path || !fs.existsSync(att.stored_path))
      return res.status(404).json({ error: 'File not on disk' });
    if (att.mime) res.setHeader('Content-Type', att.mime);
    const dl = String(req.query.download || '') === '1';
    res.setHeader('Content-Disposition',
      `${dl ? 'attachment' : 'inline'}; filename="${(att.filename || 'attachment').replace(/["\\]/g, '')}"`);
    fs.createReadStream(att.stored_path).pipe(res);
  } catch (e) {
    console.error('[tasks] attachment file error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tasks/attachments/:attId — soft delete (uploader or manager)
router.delete('/attachments/:attId', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [att] } = await db.query(
      `SELECT * FROM task_attachments WHERE id=$1 AND deleted=false`, [req.params.attId]);
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (!isManager(req) && Number(att.uploaded_by) !== Number(req.user.id))
      return res.status(403).json({ error: 'Forbidden' });
    await db.query(`UPDATE task_attachments SET deleted=true WHERE id=$1`, [att.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[tasks] attachment delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tasks/board — the manager view ─────────────────────────────────
// Every task with its assignees, filterable by assignee / status / due window /
// room, and flagged overdue. Managers only: this is the whole setting's board.
router.get('/board', async (req, res) => {
  const db = getPool();
  try {
    if (!isManager(req)) return res.status(403).json({ error: 'Manager access required' });
    const defaultTime = await taskReminders.getDefaultDueTime(db);
    const params = [defaultTime, TZ];
    let where = '1=1';

    const status = String(req.query.status || 'open');
    if (status === 'open') { params.push(taskReminders.OPEN_STATUSES); where += ` AND t.status = ANY($${params.length}::text[])`; }
    else if (status && status !== 'all') { params.push(status); where += ` AND t.status = $${params.length}`; }

    if (req.query.assignee) {
      params.push(parseInt(req.query.assignee, 10));
      where += ` AND (t.owner_staff_id = $${params.length}
                      OR EXISTS (SELECT 1 FROM task_assignees a
                                  WHERE a.task_id = t.id AND a.staff_id = $${params.length}))`;
    }
    if (req.query.room_id) { params.push(parseInt(req.query.room_id, 10)); where += ` AND t.room_id = $${params.length}`; }
    // b307 — ?category=nursery|platform. Absent = both, so the pre-b307 board is unchanged.
    if (req.query.category && CATEGORIES.includes(String(req.query.category))) {
      params.push(String(req.query.category));
      where += ` AND t.category = $${params.length}`;
    }
    if (req.query.due_before) { params.push(req.query.due_before); where += ` AND t.due_date <= $${params.length}::date`; }
    if (req.query.due_after)  { params.push(req.query.due_after);  where += ` AND t.due_date >= $${params.length}::date`; }
    if (String(req.query.overdue || '') === '1') {
      where += ` AND t.due_date IS NOT NULL AND ${DUE_AT_SQL('$1', '$2')} < NOW()
                 AND t.status = ANY(ARRAY['open','in_progress'])`;
    }
    // b501 — sub-tasks live inside their project; the board lists top-level tasks (?include_subtasks=1 lists them too,
    // ?projects=1 lists only projects).
    if (String(req.query.include_subtasks || '') !== '1') where += ` AND t.parent_task_id IS NULL`;
    if (String(req.query.projects || '') === '1') where += ` AND (t.is_project = true OR EXISTS (SELECT 1 FROM tasks pc WHERE pc.parent_task_id = t.id))`;
    where += ` AND t.archived_at IS NULL`;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));

    const { rows } = await db.query(`
      SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date, t.time_of_day,
             t.room_id, t.repeat_rule, t.repeat_every, t.source, t.linked_to, t.linked_id,
             t.category, t.sort_order,
             t.mode, t.is_project, t.parent_task_id, t.evidence_required, t.start_date,
             (SELECT count(*)::int FROM tasks c WHERE c.parent_task_id = t.id) AS subtasks_total,
             (SELECT count(*)::int FROM tasks c WHERE c.parent_task_id = t.id AND c.status = 'done') AS subtasks_done,
             t.created_at, t.completed_at, t.escalated_at, t.completion_note,
             ${DUE_AT_SQL('$1', '$2')} AS due_at,
             (t.due_date IS NOT NULL AND ${DUE_AT_SQL('$1', '$2')} < NOW()
               AND t.status = ANY(ARRAY['open','in_progress'])) AS is_overdue,
             r.name AS room_name,
             c.first_name || ' ' || c.last_name AS created_by_name,
             (SELECT count(*) FROM task_attachments ta
               WHERE ta.task_id = t.id AND ta.deleted = false)::int AS attachment_count,
             COALESCE((
               SELECT json_agg(json_build_object(
                        'staff_id', a.staff_id,
                        'name', s.first_name || ' ' || s.last_name,
                        'status', a.status,
                        'completed_at', a.completed_at,
                        'note', a.completion_note) ORDER BY s.first_name)
                 FROM task_assignees a JOIN staff s ON s.id = a.staff_id
                WHERE a.task_id = t.id), '[]'::json) AS assignees
        FROM tasks t
        LEFT JOIN rooms r ON r.id = t.room_id
        LEFT JOIN staff c ON c.id = t.created_by
       WHERE ${where}
       ORDER BY t.due_date ASC NULLS LAST,
                CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2
                                WHEN 'medium' THEN 3 ELSE 4 END, t.id DESC
       LIMIT ${limit}`, params);
    res.json(rows);
  } catch (err) {
    console.error('[tasks] board error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tasks/stats — who is overdue, and completion rate over time ────
router.get('/stats', async (req, res) => {
  const db = getPool();
  try {
    if (!isManager(req)) return res.status(403).json({ error: 'Manager access required' });
    const months = Math.min(24, Math.max(1, parseInt(req.query.months, 10) || 6));
    const defaultTime = await taskReminders.getDefaultDueTime(db);

    // Completion rate is measured against the work that was DUE in each month —
    // that is the question a manager is actually asking ("did the month's jobs
    // get done?"), not how many rows happened to be created.
    const { rows: byMonth } = await db.query(`
      SELECT to_char(date_trunc('month', t.due_date), 'YYYY-MM') AS month,
             count(*)::int AS due_tasks,
             count(*) FILTER (WHERE t.status = 'done')::int AS completed,
             count(*) FILTER (WHERE t.status = 'done'
                                AND t.completed_at IS NOT NULL
                                AND t.completed_at <= ${DUE_AT_SQL('$1', '$2')})::int AS completed_on_time,
             count(*) FILTER (WHERE t.status = ANY(ARRAY['open','in_progress'])
                                AND ${DUE_AT_SQL('$1', '$2')} < NOW())::int AS still_overdue
        FROM tasks t
       WHERE t.due_date IS NOT NULL
         AND t.due_date >= (date_trunc('month', CURRENT_DATE) - ($3 || ' months')::interval)::date
       GROUP BY 1 ORDER BY 1`, [defaultTime, TZ, months - 1]);

    const trend = byMonth.map(m => ({
      ...m,
      completion_rate: m.due_tasks ? Math.round((m.completed / m.due_tasks) * 100) : null,
      on_time_rate:    m.completed ? Math.round((m.completed_on_time / m.completed) * 100) : null,
    }));

    const { rows: byStaff } = await db.query(`
      SELECT s.id AS staff_id, s.first_name || ' ' || s.last_name AS name, s.role,
             count(*) FILTER (WHERE t.status = ANY(ARRAY['open','in_progress']))::int AS open_tasks,
             count(*) FILTER (WHERE t.status = ANY(ARRAY['open','in_progress'])
                                AND t.due_date IS NOT NULL
                                AND ${DUE_AT_SQL('$1', '$2')} < NOW())::int AS overdue_tasks,
             count(*) FILTER (WHERE a.status = 'done'
                                AND a.completed_at > NOW() - ($3 || ' months')::interval)::int AS completed_recent
        FROM task_assignees a
        JOIN tasks t ON t.id = a.task_id
        JOIN staff s ON s.id = a.staff_id
       GROUP BY s.id, s.first_name, s.last_name, s.role
      HAVING count(*) FILTER (WHERE t.status = ANY(ARRAY['open','in_progress'])) > 0
          OR count(*) FILTER (WHERE a.status = 'done'
                                AND a.completed_at > NOW() - ($3 || ' months')::interval) > 0
       ORDER BY overdue_tasks DESC, open_tasks DESC, name`, [defaultTime, TZ, months]);

    const { rows: [tot] } = await db.query(`
      SELECT count(*) FILTER (WHERE t.status = ANY(ARRAY['open','in_progress']))::int AS open_total,
             count(*) FILTER (WHERE t.status = ANY(ARRAY['open','in_progress'])
                                AND t.due_date IS NOT NULL
                                AND ${DUE_AT_SQL('$1', '$2')} < NOW())::int AS overdue_total,
             count(*) FILTER (WHERE t.escalated_at IS NOT NULL)::int AS escalated_total
        FROM tasks t`, [defaultTime, TZ]);

    res.json({ months, trend, by_staff: byStaff, totals: tot });
  } catch (err) {
    console.error('[tasks] stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  b307 — the nursery / Wren split
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/tasks/counts — how many open tasks in each category ────────────
// The cockpit board shows nursery work only, so it needs to be able to say out
// loud how much it is NOT showing: "N Wren tasks →". The count is rendered
// even when it is zero — that line is the promise that nothing vanished.
//
// No route above this one matches '/counts' ( '/', '/summary',
// '/monthly-checklist', '/assignable-staff', '/mine', '/board', '/stats',
// '/:id/attachments', '/attachments/:attId/file' ), so this is a pure append.
router.get('/counts', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT category,
             count(*)::int AS total,
             count(*) FILTER (WHERE status IN ('open','in_progress'))::int AS open
        FROM tasks GROUP BY category`);
    const out = { total: {}, open: {} };
    for (const c of CATEGORIES) { out.total[c] = 0; out.open[c] = 0; }
    for (const r of rows) {
      out.total[r.category] = r.total;             // an unexpected value still shows up
      out.open[r.category]  = r.open;
    }
    out.total_all = Object.values(out.total).reduce((a, b) => a + b, 0);
    out.open_all  = Object.values(out.open).reduce((a, b) => a + b, 0);
    res.json(out);
  } catch (err) {
    console.error('[tasks] counts error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── POST /api/tasks/reorder — set the manual order of a list ────────────────
// Body: { ids: [12, 7, 30, …] } — position is the array index. Only the ids
// sent are touched, so reordering the Wren list never renumbers nursery tasks.
// Managers only: this is a shared list, not a personal one.
router.post('/reorder', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager access required' });
  const raw = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
  if (!raw) return res.status(400).json({ error: 'ids array required' });
  const ids = [];
  for (const v of raw) {
    const n = parseInt(v, 10);
    if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }
  if (!ids.length) return res.status(400).json({ error: 'no valid ids' });
  const db = getPool();
  try {
    // One statement, so a half-applied order is not possible.
    const { rowCount } = await db.query(
      `UPDATE tasks t SET sort_order = v.pos, updated_at = NOW()
         FROM (SELECT * FROM unnest($1::int[]) WITH ORDINALITY AS x(id, pos)) v
        WHERE t.id = v.id`, [ids]);
    res.json({ ok: true, reordered: rowCount });
  } catch (err) {
    console.error('[tasks] reorder error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── b338 (2026-09-17) — pin a task onto the Cockpit "Pinned" lane ───────────
// Two-segment path, so it is not shadowed by the single-segment '/:id' routes
// above (same route-ordering note as the b209 block).
// b501 — pinning is for managers, or for the person's own task (assignee / owner / creator).
async function canPin(db, req, taskId) {
  const { rows: [t] } = await db.query(
    `SELECT t.id, t.owner_staff_id, t.created_by,
            EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.staff_id = $2) AS is_assignee
       FROM tasks t WHERE t.id = $1`, [taskId, Number(req.user.id)]);
  if (!t) return null;
  if (isManager(req)) return true;
  const me = Number(req.user.id);
  return !!(t.is_assignee || Number(t.owner_staff_id) === me || Number(t.created_by) === me);
}
router.post('/:id/pin', async (req, res) => {
  const db = getPool();
  try {
    const ok = await canPin(db, req, parseInt(req.params.id, 10) || 0);
    if (ok === null) return res.status(404).json({ error: 'Not found' });
    if (!ok) return res.status(403).json({ error: 'Only a manager, or the person the task is for, can pin it' });
    const { rows } = await db.query(
      `UPDATE tasks SET pinned_by=$1, pinned_at=NOW() WHERE id=$2 RETURNING *`,
      [req.user.id, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('tasks pin error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});
router.delete('/:id/pin', async (req, res) => {
  const db = getPool();
  try {
    const ok = await canPin(db, req, parseInt(req.params.id, 10) || 0);
    if (ok === null) return res.status(404).json({ error: 'Not found' });
    if (!ok) return res.status(403).json({ error: 'Only a manager, or the person the task is for, can unpin it' });
    const { rows } = await db.query(
      `UPDATE tasks SET pinned_by=NULL, pinned_at=NULL WHERE id=$1 RETURNING *`,
      [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('tasks unpin error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   b501 — Tasks v2. Appended, never rewritten. Every literal path below is either GET-only (there is no GET '/:id')
   or two-segment, so none of it is shadowed by the single-segment '/:id' handlers above.
   ═══════════════════════════════════════════════════════════════════════════ */

const fmtName = r => (r ? `${r.first_name || ''} ${r.last_name || ''}`.trim() : null);

// ── GET /api/tasks/assignable-groups — roles, rooms and the team this person may assign to ─────────────────
router.get('/assignable-groups', async (req, res) => {
  try { res.json(await taskGroups.assignableGroups(getPool(), req)); }
  catch (err) { console.error('[tasks] assignable-groups error:', err.message); res.status(500).json({ error: 'DB error' }); }
});

// ── GET /api/tasks/:id/detail — THE task detail, used by every surface (public/js/wren-task-detail.js) ──────
// Opening it records that the assignee has SEEN the task (first_seen_at / last_seen_at), so "I didn't see it" is answerable.
router.get('/:id/detail', async (req, res) => {
  const db = getPool();
  try {
    const taskId = parseInt(req.params.id, 10);
    if (!Number.isInteger(taskId)) return res.status(400).json({ error: 'bad task id' });
    const task = await canSeeTask(db, req, taskId);
    if (task === null) return res.status(404).json({ error: 'Not found' });
    if (task === false) return res.status(403).json({ error: 'Forbidden' });
    const me = Number(req.user.id);
    const defaultTime = await taskReminders.getDefaultDueTime(db);

    // seen tracking (only for someone who actually has a line on it)
    const { rows: seen } = await db.query(
      `UPDATE task_assignees SET first_seen_at = COALESCE(first_seen_at, now()), last_seen_at = now(), seen_count = seen_count + 1
        WHERE task_id = $1 AND staff_id = $2 RETURNING (seen_count = 1) AS first`, [taskId, me]);
    if (seen[0] && seen[0].first) await hist(db, taskId, me, 'seen', null);

    const { rows: [t] } = await db.query(`
      SELECT t.*, ${DUE_AT_SQL('$2', '$3')} AS due_at,
             (t.due_date IS NOT NULL AND t.status = ANY(ARRAY['open','in_progress']) AND ${DUE_AT_SQL('$2', '$3')} < NOW()) AS is_overdue,
             r.name AS room_name, c.first_name AS cb_first, c.last_name AS cb_last,
             p.title AS project_title
        FROM tasks t
        LEFT JOIN rooms r ON r.id = t.room_id
        LEFT JOIN staff c ON c.id = t.created_by
        LEFT JOIN tasks p ON p.id = t.parent_task_id
       WHERE t.id = $1`, [taskId, defaultTime, TZ]);

    const { rows: assignees } = await db.query(`
      SELECT a.staff_id, s.first_name || ' ' || s.last_name AS name, s.role, a.status, a.via, a.completed_at, a.completion_note AS note,
             a.first_seen_at, a.last_seen_at, a.seen_count,
             (a.status = 'done' AND a.completed_at IS NOT NULL AND t.due_date IS NOT NULL AND a.completed_at > ${DUE_AT_SQL('$2', '$3')}) AS late
        FROM task_assignees a JOIN staff s ON s.id = a.staff_id JOIN tasks t ON t.id = a.task_id
       WHERE a.task_id = $1 ORDER BY s.first_name, s.last_name`, [taskId, defaultTime, TZ]);

    const { rows: subtasks } = await db.query(`
      SELECT c.id, c.title, c.status, c.priority, c.due_date, c.time_of_day, c.completed_at, c.evidence_required,
             (c.due_date IS NOT NULL AND c.status = ANY(ARRAY['open','in_progress']) AND ${taskReminders.DUE_AT_SQL('c', '$2', '$3')} < NOW()) AS is_overdue,
             COALESCE((SELECT json_agg(json_build_object('staff_id', a.staff_id, 'name', s.first_name || ' ' || s.last_name, 'status', a.status) ORDER BY s.first_name)
                         FROM task_assignees a JOIN staff s ON s.id = a.staff_id WHERE a.task_id = c.id), '[]'::json) AS assignees
        FROM tasks c WHERE c.parent_task_id = $1 ORDER BY c.due_date ASC NULLS LAST, c.id`, [taskId, defaultTime, TZ]);

    const { rows: attachments } = await db.query(
      `SELECT ta.*, s.first_name || ' ' || s.last_name AS uploaded_by_name
         FROM task_attachments ta LEFT JOIN staff s ON s.id = ta.uploaded_by
        WHERE ta.task_id=$1 AND ta.deleted=false ORDER BY ta.uploaded_at DESC`, [taskId]);
    const { rows: comments } = await db.query(
      `SELECT id, author_id, author_name, body, created_at FROM task_comments WHERE task_id=$1 ORDER BY created_at, id`, [taskId]);
    const { rows: history } = await db.query(
      `SELECT h.id, h.actor_id, s.first_name || ' ' || s.last_name AS actor_name, h.action, h.detail, h.created_at
         FROM task_history h LEFT JOIN staff s ON s.id = h.actor_id
        WHERE h.task_id=$1 ORDER BY h.created_at DESC, h.id DESC LIMIT 100`, [taskId]);

    const myLine = assignees.find(a => Number(a.staff_id) === me) || null;
    const total = subtasks.length ? subtasks.length : assignees.length;
    const done = subtasks.length ? subtasks.filter(x => x.status === 'done').length : assignees.filter(a => a.status === 'done').length;
    const { creator_name: _x, cb_first, cb_last, ...rest } = t;
    res.json({
      task: { ...rest, created_by_name: fmtName({ first_name: cb_first, last_name: cb_last }) },
      assignees, subtasks,
      attachments: attachments.map(pubAttachment),
      comments, history,
      progress: { done, total, of: subtasks.length ? 'sub-tasks' : 'people' },
      perms: {
        can_edit: canEditTask(req, t), can_delete: canEditTask(req, t),
        can_pin: isManager(req) || !!myLine || Number(t.created_by) === me || Number(t.owner_staff_id) === me,
        can_add_materials: canEditTask(req, t), can_add_subtasks: canEditTask(req, t) && !t.parent_task_id,
        my_line: myLine ? { status: myLine.status, via: myLine.via, first_seen_at: myLine.first_seen_at } : null,
        can_tick: !!myLine || (Number(t.owner_staff_id) === me && !assignees.length) || (!assignees.length && !t.owner_staff_id),
        can_tick_for_others: isManager(req),
        can_comment: true,
      },
    });
  } catch (err) {
    console.error('[tasks] detail error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── POST /api/tasks/:id/comments ────────────────────────────────────────────
router.post('/:id/comments', async (req, res) => {
  const db = getPool();
  try {
    const taskId = parseInt(req.params.id, 10);
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'body required' });
    if (body.length > 4000) return res.status(400).json({ error: 'comment too long' });
    const task = await canSeeTask(db, req, taskId);
    if (task === null) return res.status(404).json({ error: 'Not found' });
    if (task === false) return res.status(403).json({ error: 'Forbidden' });
    const { rows: [me] } = await db.query(`SELECT first_name, last_name FROM staff WHERE id=$1`, [Number(req.user.id)]);
    const { rows: [row] } = await db.query(
      `INSERT INTO task_comments (task_id, author_id, author_name, body) VALUES ($1,$2,$3,$4) RETURNING id, author_id, author_name, body, created_at`,
      [taskId, Number(req.user.id), fmtName(me) || req.user.name || null, body]);
    await hist(db, taskId, req.user.id, 'commented', { comment_id: row.id });
    res.status(201).json(row);
  } catch (err) {
    console.error('[tasks] comment error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── POST /api/tasks/:id/subtasks — add a milestone / sub-task (title, due_date, optional assignee) ───────────
router.post('/:id/subtasks', async (req, res) => {
  const db = getPool();
  try {
    const r = await createTask(db, req, Object.assign({}, req.body || {}, { parent_task_id: parseInt(req.params.id, 10) }));
    res.status(r.status).json(r.json);
  } catch (err) {
    console.error('[tasks] subtask error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /api/tasks/projects — project tasks (incl. the folded Action Plans) with sub-task progress ───────────
// Managers see every project; everyone else sees the projects they are on (or have a sub-task in).
router.get('/projects', async (req, res) => {
  const db = getPool();
  try {
    const me = Number(req.user.id);
    const params = [taskReminders.OPEN_STATUSES, await taskReminders.getDefaultDueTime(db), TZ];
    let where = `(t.is_project = true OR EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)) AND t.parent_task_id IS NULL AND t.archived_at IS NULL`;
    const st = String(req.query.status || 'open');
    if (st === 'open') where += ` AND t.status = ANY($1::text[])`;
    else if (st !== 'all') { params.push(st); where += ` AND t.status = $${params.length}`; }
    if (!isManager(req)) {
      params.push(me);
      where += ` AND (t.owner_staff_id = $${params.length} OR t.created_by = $${params.length}
                 OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.staff_id = $${params.length})
                 OR EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id AND (c.owner_staff_id = $${params.length}
                      OR EXISTS (SELECT 1 FROM task_assignees a2 WHERE a2.task_id = c.id AND a2.staff_id = $${params.length}))))`;
    }
    const { rows } = await db.query(`
      SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date, t.start_date, t.mode, t.is_project, t.linked_to, t.linked_id,
             t.smart_measurable, t.smart_relevant, t.owner_staff_id,
             o.first_name || ' ' || o.last_name AS owner_name,
             (t.due_date IS NOT NULL AND t.status = ANY($1::text[]) AND ${DUE_AT_SQL('$2', '$3')} < NOW()) AS is_overdue,
             (SELECT count(*)::int FROM tasks c WHERE c.parent_task_id = t.id) AS subtasks_total,
             (SELECT count(*)::int FROM tasks c WHERE c.parent_task_id = t.id AND c.status = 'done') AS subtasks_done,
             (SELECT count(*)::int FROM tasks c WHERE c.parent_task_id = t.id AND c.status = ANY($1::text[])
                 AND c.due_date IS NOT NULL AND ${taskReminders.DUE_AT_SQL('c', '$2', '$3')} < NOW()) AS subtasks_overdue
        FROM tasks t LEFT JOIN staff o ON o.id = t.owner_staff_id
       WHERE ${where}
       ORDER BY t.due_date ASC NULLS LAST, t.id DESC LIMIT 200`, params);
    res.json(rows);
  } catch (err) {
    console.error('[tasks] projects error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /api/tasks/accountability — per-person counts over 4 and 12 weeks + the overdue-by-person list ──────
// Managers / deputies only. A line is one person's part of one task that fell due in the window. "On time" means they
// finished it by the due moment; "late" after it; "overdue" means it is still open and the due moment has passed.
// Group tasks count once PER PERSON. Project parents with sub-tasks are left out (their sub-tasks count instead).
router.get('/accountability', async (req, res) => {
  const db = getPool();
  try {
    if (!isManager(req)) return res.status(403).json({ error: 'Manager access required' });
    const defaultTime = await taskReminders.getDefaultDueTime(db);
    const lines = `
      WITH lines AS (
        SELECT a.staff_id, t.id AS task_id, t.title, t.due_date, ${DUE_AT_SQL('$1', '$2')} AS due_at,
               (a.status = 'done') AS done, a.completed_at AS done_at, t.status AS task_status
          FROM task_assignees a JOIN tasks t ON t.id = a.task_id
         WHERE t.category = 'nursery' AND t.due_date IS NOT NULL AND t.status <> 'cancelled' AND t.archived_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)
        UNION ALL
        SELECT t.owner_staff_id, t.id, t.title, t.due_date, ${DUE_AT_SQL('$1', '$2')},
               (t.status = 'done'), t.completed_at, t.status
          FROM tasks t
         WHERE t.owner_staff_id IS NOT NULL AND t.category = 'nursery' AND t.due_date IS NOT NULL AND t.status <> 'cancelled' AND t.archived_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id)
           AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)
      )`;
    const period = async weeks => {
      const { rows } = await db.query(`${lines}
        SELECT l.staff_id, s.first_name || ' ' || s.last_name AS name, s.role, r.name AS room_name,
               count(*)::int AS assigned,
               count(*) FILTER (WHERE l.done AND l.done_at IS NOT NULL AND l.done_at <= l.due_at)::int AS done_on_time,
               count(*) FILTER (WHERE l.done AND (l.done_at IS NULL OR l.done_at > l.due_at))::int AS done_late,
               count(*) FILTER (WHERE NOT l.done AND l.due_at < now())::int AS overdue
          FROM lines l JOIN staff s ON s.id = l.staff_id AND s.is_active = true LEFT JOIN rooms r ON r.id = s.room_id
         WHERE l.due_date >= ((now() AT TIME ZONE $3)::date - ($4::int * 7)) AND l.due_date <= (now() AT TIME ZONE $3)::date
         GROUP BY l.staff_id, s.first_name, s.last_name, s.role, r.name
         ORDER BY overdue DESC, name`, [defaultTime, TZ, TZ, weeks]);
      return rows;
    };
    const w4 = await period(4), w12 = await period(12);
    const byId = new Map();
    const ensure = r => { if (!byId.has(r.staff_id)) byId.set(r.staff_id, { staff_id: r.staff_id, name: r.name, role: r.role, room_name: r.room_name, w4: null, w12: null }); return byId.get(r.staff_id); };
    const pick = r => ({ assigned: r.assigned, done_on_time: r.done_on_time, done_late: r.done_late, overdue: r.overdue });
    w4.forEach(r => { ensure(r).w4 = pick(r); });
    w12.forEach(r => { ensure(r).w12 = pick(r); });
    const zero = { assigned: 0, done_on_time: 0, done_late: 0, overdue: 0 };
    const people = [...byId.values()].map(p => ({ ...p, w4: p.w4 || zero, w12: p.w12 || zero }))
      .sort((a, b) => (b.w12.overdue - a.w12.overdue) || (b.w4.overdue - a.w4.overdue) || String(a.name).localeCompare(String(b.name)));

    // Overdue by person — everything open that is past due right now, not only the window.
    const { rows: od } = await db.query(`${lines}
      SELECT l.staff_id, s.first_name || ' ' || s.last_name AS name, s.role, l.task_id, l.title, l.due_date::text AS due_date,
             ((now() AT TIME ZONE $3)::date - l.due_date)::int AS days_over,
             (SELECT first_seen_at FROM task_assignees x WHERE x.task_id = l.task_id AND x.staff_id = l.staff_id) AS first_seen_at
        FROM lines l JOIN staff s ON s.id = l.staff_id AND s.is_active = true
       WHERE NOT l.done AND l.due_at < now() AND l.task_status = ANY($4::text[])
       ORDER BY l.staff_id, l.due_date`, [defaultTime, TZ, TZ, taskReminders.OPEN_STATUSES]);
    const grouped = new Map();
    for (const r of od) {
      if (!grouped.has(r.staff_id)) grouped.set(r.staff_id, { staff_id: r.staff_id, name: r.name, role: r.role, count: 0, oldest_days: 0, tasks: [] });
      const g = grouped.get(r.staff_id);
      g.count++; g.oldest_days = Math.max(g.oldest_days, r.days_over);
      if (g.tasks.length < 25) g.tasks.push({ id: r.task_id, title: r.title, due_date: r.due_date, days_over: r.days_over, seen: !!r.first_seen_at });
    }
    const overdue_by_person = [...grouped.values()].sort((a, b) => (b.count - a.count) || (b.oldest_days - a.oldest_days));
    res.json({ weeks: [4, 12], people, overdue_by_person });
  } catch (err) {
    console.error('[tasks] accountability error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
