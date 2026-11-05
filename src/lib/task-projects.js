'use strict';
// ===========================================================================
// task-projects.js — b501 (Tasks v2). Action Plans are now PROJECT TASKS (a parent task with SMART fields; its items are
// sub-tasks with assignees). The data was folded in by migrations/2026-10-17-b501-tasks-v2.sql → b501_fold_action_plans().
//
// The old /api/action-plans and /api/action-plan-items endpoints still answer, so nothing that calls them breaks. Anything
// that WRITES through them is mirrored into tasks here, so there is never a plan that exists in one place only.
// Tasks is the version people edit; the old tables are kept as the read-only record.
//
// Never throws: a missing function (migration not applied) just means "not folded yet".
// ===========================================================================

async function foldPlan(db, planId) {
  try {
    const { rows } = await db.query(`SELECT b501_fold_action_plans($1::int) AS r`, [planId == null ? null : Number(planId)]);
    return rows[0] ? rows[0].r : null;
  } catch (e) {
    if (!/b501_fold_action_plans/.test(String(e.message))) console.error('[task-projects] fold failed:', e.message);
    return null;
  }
}

/** An edit made through the OLD plan API reaches the project task. (One-way: old → tasks.) */
async function syncPlanFields(db, planId) {
  try {
    await db.query(`
      UPDATE tasks t SET
             title = ap.title, description = ap.description,
             priority = CASE WHEN ap.priority IN ('urgent','high','medium','low') THEN ap.priority ELSE t.priority END,
             due_date = ap.target_date, owner_staff_id = COALESCE(ap.owner_staff_id, t.owner_staff_id),
             smart_measurable = ap.success_criteria,
             status = CASE WHEN ap.status IN ('completed','complete','done') THEN 'done'
                           WHEN ap.status = 'cancelled' THEN 'cancelled'
                           WHEN ap.status IN ('in-progress','in_progress','in progress') THEN 'in_progress' ELSE 'open' END,
             completed_at = CASE WHEN ap.status IN ('completed','complete','done') THEN COALESCE(t.completed_at, now()) ELSE NULL END,
             archived_at = CASE WHEN ap.archived_at IS NOT NULL THEN COALESCE(t.archived_at, now()) ELSE NULL END,
             updated_at = now()
        FROM action_plans ap
       WHERE t.linked_to = 'action_plan' AND t.linked_id = ap.id AND ap.id = $1`, [Number(planId)]);
  } catch (e) { console.error('[task-projects] sync failed:', e.message); }
}

/** A plan deleted through the old API is ARCHIVED as a task, never deleted (house rule: nothing is destroyed). */
async function archivePlan(db, planId) {
  try {
    await db.query(`UPDATE tasks SET archived_at = COALESCE(archived_at, now()), status = CASE WHEN status = 'done' THEN status ELSE 'cancelled' END, updated_at = now()
                     WHERE linked_to = 'action_plan' AND linked_id = $1`, [Number(planId)]);
  } catch (e) { console.error('[task-projects] archive failed:', e.message); }
}

module.exports = { foldPlan, syncPlanFields, archivePlan };
