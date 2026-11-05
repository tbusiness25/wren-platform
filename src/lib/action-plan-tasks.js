'use strict';
// ===========================================================================
// action-plan-tasks.js — b358 (2026-09-29)
//
// Toby: "I want a full task system assigned to Wren. Maybe this can replace our
// action plan, or be built into it? So it's called action plan, but we can
// assign tasks to staff and deadlines and notes etc — they get message and
// notification."
//
// ── ONE SYSTEM, TWO TABLES, ON PURPOSE ──────────────────────────────────────
// Wren had two task systems: b209's `tasks` (multi-assignee, 24h/1h reminders,
// one-shot overdue escalation, recurrence, attachments, /ey/my-tasks) and
// `action_plan_items` (the Ofsted-style plans, one assignee, a deadline,
// comments). The brief says: one system, called Action Plan, done additively,
// deleting nothing.
//
// So Action Plan is the FRONT DOOR and b209 is the ENGINE. This file is the
// bridge. An action plan item that is assigned to somebody gets a mirror row in
// `tasks`, linked both ways (action_plan_items.task_id ⇄ tasks.linked_to =
// 'action_plan_item' / linked_id). The mirror is not duplication for its own
// sake — it is what earns the item every piece of machinery b209 already has
// and has already been proved to work:
//
//   · task_assignees   → more than one assignee, with no new join table
//   · task_reminders   → the 24h-before reminder the brief asks for, plus 1h
//   · task_attachments → a file on an action
//   · /api/tasks/mine  → which is exactly what /ey/my-tasks already renders
//
// Writing a second reminder engine beside b209's — or a second "my list"
// endpoint — is the thing this file exists to avoid.
//
// ── WHAT IS DELIBERATELY NOT DONE ───────────────────────────────────────────
// Nothing is migrated, dropped or deleted. Pre-b358 `tasks` rows have
// linked_to IS NULL and are simply not action-plan items, so the cockpit board,
// the monthly checklist and the Wren To Do List are untouched. Pre-b358 action
// plan items have task_id IS NULL and keep behaving exactly as they did.
// action_plan_items.assigned_staff_id is still maintained as the FIRST
// assignee, so every existing reader (the Roost list, /calendar, the parents
// scope) sees what it always saw.
//
// ── THE TWO STATUS VOCABULARIES ─────────────────────────────────────────────
// The brief asks for open / in progress / done. The column has had a CHECK
// constraint on todo / in-progress / completed / blocked since it was created,
// and rows and UI depend on those values. Changing it would be a data
// migration for a cosmetic gain, so the vocabularies are MAPPED here instead
// and the column is left alone.
// ===========================================================================

const taskReminders = require('./task-reminders');
const { notify, notifyAsync } = require('../services/notification-dispatcher');
const { sendStaffDm } = require('./staff-dm');

// ── Status maps ─────────────────────────────────────────────────────────────
// item (the column's vocabulary)  ⇄  task (b209's)  ⇄  public (the brief's)
const ITEM_TO_TASK = { 'todo': 'open', 'in-progress': 'in_progress', 'completed': 'done', 'blocked': 'open' };
const TASK_TO_ITEM = { 'open': 'todo', 'in_progress': 'in-progress', 'done': 'completed', 'cancelled': 'blocked' };
const ITEM_STATUSES = ['todo', 'in-progress', 'completed', 'blocked'];

/** Whatever the client called it → the value the column will accept. */
function normItemStatus(v, fallback = null) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, '_');
  const map = {
    open: 'todo', todo: 'todo', not_started: 'todo',
    in_progress: 'in-progress', 'in-progress': 'in-progress', started: 'in-progress',
    done: 'completed', complete: 'completed', completed: 'completed',
    blocked: 'blocked', stuck: 'blocked',
  };
  return map[s] || fallback;
}
/** The column's value → the word the API speaks. */
const publicStatus = s => ({ 'todo': 'open', 'in-progress': 'in_progress',
                             'completed': 'done', 'blocked': 'blocked' }[s] || 'open');

const PRIORITIES = ['low', 'medium', 'high'];
const normPriority = (v, fallback = 'medium') => {
  const p = String(v == null ? '' : v).trim().toLowerCase();
  return PRIORITIES.includes(p) ? p : fallback;
};

// ── Idempotent self-heal ────────────────────────────────────────────────────
// The house pattern (see task-reminders.ensureSchema): the authoritative DDL is
// scripts/migrations/2026-09-29-b358-action-plan-tasks.sql; this makes the code
// safe on an edition where that migration has not been run yet.
let _schemaChecked = false;
async function ensureSchema(db) {
  if (_schemaChecked) return true;
  try {
    await db.query(`ALTER TABLE action_plan_items ADD COLUMN IF NOT EXISTS task_id integer`);
    await db.query(`ALTER TABLE action_plan_items ADD COLUMN IF NOT EXISTS related_child_id integer`);
    await db.query(`ALTER TABLE action_plan_items ADD COLUMN IF NOT EXISTS document_ref text`);
    // The "tell the assignee once" stamp — see sweepOverdue below.
    await db.query(`ALTER TABLE action_plan_items ADD COLUMN IF NOT EXISTS overdue_notified_at timestamptz`);
    await db.query(`ALTER TABLE action_plans ADD COLUMN IF NOT EXISTS is_task_plan boolean DEFAULT false`);
    await db.query(`CREATE INDEX IF NOT EXISTS action_plan_items_task_idx
                      ON action_plan_items (task_id) WHERE task_id IS NOT NULL`);
    _schemaChecked = true;
    return true;
  } catch (e) {
    console.error('[action-plan-tasks] schema init failed:', e.message);
    return false;
  }
}

// ── Where standalone assigned work lives ────────────────────────────────────
/**
 * Not every assignment belongs to an improvement plan. "Order more paper towels
 * by Friday" is a task, and before b358 it had to be created in the other
 * system. It now lands in a single plan flagged is_task_plan, created on demand
 * so a setting that never assigns standalone work has no phantom plan.
 */
async function getOrCreateTaskPlan(db, createdBy) {
  await ensureSchema(db);
  const { rows: found } = await db.query(
    `SELECT id FROM action_plans WHERE is_task_plan = true AND archived_at IS NULL ORDER BY id LIMIT 1`);
  if (found.length) return found[0].id;
  const { rows } = await db.query(`
    INSERT INTO action_plans (title, description, scope, status, priority, created_by, is_task_plan,
                              progress_notes, evidence_attachments)
    VALUES ('Assigned work',
            'Day-to-day work assigned to staff with a deadline. Created automatically by Wren the first time somebody was given a task outside an improvement plan.',
            'staff', 'open', 'medium', $1, true, '[]', '[]')
    RETURNING id`, [createdBy || null]);
  return rows[0].id;
}

// ── Who is on this item ─────────────────────────────────────────────────────
/** Every staff id assigned to an item, from both places assignment can live. */
async function assigneeIds(db, item) {
  const ids = new Set();
  if (item.assigned_staff_id) ids.add(Number(item.assigned_staff_id));
  if (item.task_id) {
    try {
      const { rows } = await db.query(
        `SELECT staff_id FROM task_assignees WHERE task_id = $1 AND status <> 'done'`, [item.task_id]);
      rows.forEach(r => ids.add(Number(r.staff_id)));
    } catch (e) { console.error('[action-plan-tasks] assignee lookup failed:', e.message); }
  }
  return [...ids].filter(Number.isInteger);
}

// ── Telling somebody ────────────────────────────────────────────────────────
/**
 * The brief: "they get message and notification". Both, for an assignment.
 *
 * The category is 'task_assigned', which is already registered in
 * notification-categories.js — a category that fires through notify() but is
 * absent from that catalog is INVISIBLE to the settings screen, so nobody can
 * turn it off and nobody knows it exists. Per-staff channel preferences then
 * decide whether it also goes to Telegram / push / email; that is the
 * dispatcher's job and is not second-guessed here.
 */
async function tellAssigned(db, actor, item, staffId, planTitle) {
  const due = item.deadline
    ? 'Due ' + new Date(item.deadline).toLocaleDateString('en-GB',
        { weekday: 'short', day: 'numeric', month: 'short', timeZone: taskReminders.TZ })
    : 'No deadline set';
  notify('task_assigned', 'staff', staffId,
    `📋 New action: ${item.title}`,
    `${due}${item.priority && item.priority !== 'medium' ? ` · ${item.priority} priority` : ''}.`,
    { relatedTable: 'action_plan_items', relatedId: item.id, link: '/ey/my-tasks',
      priority: item.priority === 'high' ? 'high' : 'normal' });

  const lines = [
    `You've been given an action: "${item.title}".`,
    due + '.',
    planTitle ? `Plan: ${planTitle}.` : null,
    item.description ? `Notes: ${item.description}` : null,
    'You can add a note or mark it done on your action plan in Wren.',
  ].filter(Boolean);
  await sendStaffDm(db, actor && actor.id, staffId, 'Action Plan: ' + item.title, lines.join('\n'));
}

// ── Replace the assignee set on the mirror task ─────────────────────────────
/**
 * Mirrors b209's own setAssignees: rows already marked done are left alone,
 * because removing somebody must not erase the fact that they completed their
 * line. tasks.owner_staff_id is kept pointing at the first assignee so every
 * pre-b209 reader still sees an owner.
 */
async function setAssignees(db, actor, item, taskId, staffIds, opts = {}) {
  const { rows: before } = await db.query(
    `SELECT staff_id FROM task_assignees WHERE task_id = $1`, [taskId]);
  const had = new Set(before.map(r => Number(r.staff_id)));

  for (const sid of staffIds) {
    await db.query(`
      INSERT INTO task_assignees (task_id, staff_id, assigned_by)
      VALUES ($1,$2,$3) ON CONFLICT (task_id, staff_id) DO NOTHING`,
      [taskId, sid, (actor && actor.id) || null]);
  }
  if (staffIds.length) {
    await db.query(`
      DELETE FROM task_assignees
       WHERE task_id = $1 AND NOT (staff_id = ANY($2::int[])) AND status <> 'done'`,
      [taskId, staffIds]);
    await db.query(`UPDATE tasks SET owner_staff_id = $2 WHERE id = $1`, [taskId, staffIds[0]]);
  }
  return staffIds.filter(sid => !had.has(sid));
}

// ═══════════════════════════════════════════════════════════════════════════
// The bridge itself
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Make the mirror task match the item, creating it if the item has just been
 * assigned for the first time. Returns { task_id, added } — `added` being the
 * assignees who did not have this item before, i.e. the people who were told.
 *
 * An item with NO assignees never gets a task: an unassigned improvement-plan
 * action is not on anybody's list and should not appear on one.
 */
async function syncItem(db, actor, item, opts = {}) {
  if (!(await ensureSchema(db))) return { task_id: item.task_id || null, added: [] };

  const assignees = Array.isArray(opts.assignees) && opts.assignees.length
    ? [...new Set(opts.assignees.map(Number).filter(n => Number.isInteger(n) && n > 0))]
    : (item.assigned_staff_id ? [Number(item.assigned_staff_id)] : []);

  if (!assignees.length && !item.task_id) return { task_id: null, added: [] };

  const taskStatus = ITEM_TO_TASK[item.status] || 'open';
  let taskId = item.task_id || null;

  if (!taskId) {
    const { rows } = await db.query(`
      INSERT INTO tasks (title, description, status, priority, due_date, owner_staff_id,
                         created_by, source, source_ref, linked_to, linked_id, category)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'action_plan',$8,'action_plan_item',$9,'nursery')
      RETURNING id`,
      [item.title, item.description || null, taskStatus, normPriority(item.priority),
       item.deadline || null, assignees[0] || null, (actor && actor.id) || null,
       String(item.id), item.id]);
    taskId = rows[0].id;
    await db.query(`UPDATE action_plan_items SET task_id = $1 WHERE id = $2`, [taskId, item.id]);
  } else {
    await db.query(`
      UPDATE tasks SET title = $2, description = $3, status = $4, priority = $5,
                       due_date = $6, updated_at = NOW(),
                       completed_at = CASE WHEN $4 = 'done' THEN COALESCE(completed_at, NOW()) ELSE completed_at END
       WHERE id = $1`,
      [taskId, item.title, item.description || null, taskStatus,
       normPriority(item.priority), item.deadline || null]);
  }

  let added = [];
  if (assignees.length) {
    added = await setAssignees(db, actor, item, taskId, assignees, opts);
  }

  // Finishing the item closes everyone's line, so a queued reminder cannot fire
  // at somebody about work that is already done.
  if (taskStatus === 'done') {
    await db.query(`
      UPDATE task_assignees SET status = 'done', completed_at = COALESCE(completed_at, NOW())
       WHERE task_id = $1 AND status <> 'done'`, [taskId]).catch(() => {});
    await db.query(`
      UPDATE task_reminders SET status = 'skipped', fired_at = NOW()
       WHERE task_id = $1 AND status = 'scheduled'`, [taskId]).catch(() => {});
  }

  // Schedule inline so the caller can PROVE the 24h/1h reminders exist; the
  // dispatcher sweep would pick it up within 30s anyway.
  try { await taskReminders.scheduleTaskReminders(db, taskId); }
  catch (e) { console.error('[action-plan-tasks] reminder scheduling failed:', e.message); }

  if (!opts.silent && added.length) {
    let planTitle = null;
    try {
      const { rows } = await db.query(
        `SELECT title FROM action_plans WHERE id = $1`, [item.plan_id]);
      planTitle = rows[0] ? rows[0].title : null;
    } catch (_) { /* the plan title is decoration on the message */ }
    for (const sid of added) {
      if (actor && Number(sid) === Number(actor.id)) continue;   // no "you assigned yourself" ping
      await tellAssigned(db, actor, item, sid, planTitle);
    }
  }

  return { task_id: taskId, added };
}

// ═══════════════════════════════════════════════════════════════════════════
// Overdue — the assignee's own notice, ONCE
// ═══════════════════════════════════════════════════════════════════════════
/**
 * b209 already escalates an overdue task to the MANAGER once (escalateOverdue).
 * The brief asks for something different and additional: the ASSIGNEE is told
 * their own action is overdue, once, not repeatedly.
 *
 * "Once" is guaranteed by stamping action_plan_items.overdue_notified_at BEFORE
 * anything is sent and only for rows where it is still NULL, so the row leaves
 * the candidate set for good whatever the notification outcome. That is the
 * same belt-and-braces rule as b184/b209, and it is the whole point: a nagging
 * daily "this is overdue" is the failure mode worth engineering against.
 *
 * The category is 'task_due' rather than 'task_overdue' on purpose.
 * 'task_overdue' is registered managerOnly — it is addressed to whoever has to
 * chase, never to the person who is already late — so using it here would
 * either be filtered out or would put a manager-only category in a
 * practitioner's bell. 'task_due' is the registered, non-managerOnly category
 * for "your work needs attention", and the title says which kind.
 */
async function sweepOverdue(db, dispatch) {
  if (!(await ensureSchema(db))) return 0;
  const send = dispatch || notifyAsync;
  let rows = [];
  try {
    const r = await db.query(`
      SELECT i.id, i.title, i.deadline, i.task_id, i.assigned_staff_id, i.plan_id,
             ap.title AS plan_title
        FROM action_plan_items i
        LEFT JOIN action_plans ap ON ap.id = i.plan_id
       WHERE i.status <> 'completed'
         AND i.deadline IS NOT NULL
         AND i.deadline < CURRENT_DATE
         AND i.overdue_notified_at IS NULL
         AND (ap.id IS NULL OR ap.archived_at IS NULL)
       ORDER BY i.deadline
       LIMIT 25`);
    rows = r.rows;
  } catch (e) {
    console.error('[action-plan-tasks] overdue query failed:', e.message);
    return 0;
  }

  let told = 0;
  for (const item of rows) {
    // Stamp FIRST and unconditionally — the row can never be picked up again.
    let claimed = false;
    try {
      const { rowCount } = await db.query(
        `UPDATE action_plan_items SET overdue_notified_at = NOW()
          WHERE id = $1 AND overdue_notified_at IS NULL`, [item.id]);
      claimed = rowCount > 0;
    } catch (e) { console.error('[action-plan-tasks] overdue stamp failed:', e.message); }
    if (!claimed) continue;

    const who = await assigneeIds(db, item);
    const when = new Date(item.deadline).toLocaleDateString('en-GB',
      { weekday: 'short', day: 'numeric', month: 'short', timeZone: taskReminders.TZ });

    for (const sid of who) {
      try {
        await send('task_due', 'staff', sid,
          `⚠️ Overdue action: ${item.title}`,
          `This was due ${when} and is still open. This is the only reminder you will get for it.`,
          { relatedTable: 'action_plan_items', relatedId: item.id, link: '/ey/my-tasks',
            priority: 'high' });
        await sendStaffDm(db, null, sid, 'Overdue action: ' + item.title,
          [`"${item.title}" was due ${when} and is still open.`,
           item.plan_title ? `Plan: ${item.plan_title}.` : null,
           'Open your action plan in Wren to add a note or mark it done.'].filter(Boolean).join('\n'));
        told++;
      } catch (e) {
        console.error('[action-plan-tasks] overdue notify failed:', e.message);
      }
    }
  }
  return told;
}

module.exports = {
  ITEM_STATUSES, ITEM_TO_TASK, TASK_TO_ITEM,
  normItemStatus, publicStatus, normPriority,
  ensureSchema, getOrCreateTaskPlan, assigneeIds,
  syncItem, sweepOverdue,
};
