'use strict';
// 29 Oct 2026 — who may see an action plan's items and comments. GET /api/action-plans/:id had an
// owner check, but the item list (GET /api/action-plan-items?plan_id=), an item's comments
// (GET/POST /api/action-plan-items/:id/comments) and GET /api/action-plans/plan-items/:id had none,
// so any member of staff could read any plan's items, assignees and comments. Same rule as the plan
// itself: the file's manager list (which includes room leaders — Toby's call), the plan's owner,
// or someone assigned to it (an item, or the plan's actions JSON).
const { hasRole } = require('../middleware/auth');

const PLAN_MANAGERS = ['manager', 'deputy_manager', 'admin', 'room_leader', 'senior_practitioner'];

async function canSeePlan(db, user, planId, schema = process.env.PG_SCHEMA || 'ladn') {
  if (hasRole(user, PLAN_MANAGERS)) return true;
  const me = Number(user && user.id);
  if (!me || !planId) return false;
  const { rows: [ap] } = await db.query(`SELECT owner_staff_id, actions FROM ${schema}.action_plans WHERE id=$1`, [planId]);
  if (!ap) return false;
  if (Number(ap.owner_staff_id) === me) return true;
  try {
    const arr = typeof ap.actions === 'string' ? JSON.parse(ap.actions) : ap.actions;
    if (Array.isArray(arr) && arr.some((a) => Number((a && (a.assignee_id || a.assigned_staff_id)) || 0) === me)) return true;
  } catch (_) { /* not JSON */ }
  const { rows } = await db.query(`SELECT 1 FROM ${schema}.action_plan_items WHERE plan_id=$1 AND assigned_staff_id=$2 LIMIT 1`, [planId, me]);
  return rows.length > 0;
}

async function canSeeItem(db, user, itemId, schema = process.env.PG_SCHEMA || 'ladn') {
  const { rows: [it] } = await db.query(`SELECT plan_id FROM ${schema}.action_plan_items WHERE id=$1`, [itemId]);
  return it ? canSeePlan(db, user, it.plan_id, schema) : false;
}

module.exports = { canSeePlan, canSeeItem };
