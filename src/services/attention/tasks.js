'use strict';
/**
 * tasks.js — b504 collector. Toby's open tasks, so each job exists once.
 *
 * Mirrors open `tasks` rows (category 'nursery') that are Toby's — owner, or an
 * open task_assignees line — into attention_items as source 'tasks', key
 * 'task-<id>'. One-to-one, EXCEPT the overdue rows that came from the monthly
 * checklist: those collapse into ONE item ('monthly-checklist-overdue', "Monthly
 * checklist: N overdue", count in `evidence`) so 30 stale ticks do not bury the
 * three jobs that matter.
 *
 * Columns are read defensively (b501 may reshape `tasks`): a query failure returns
 * ok:false, which by the refresh's rule 2 resolves nothing.
 * Write-through on Done lives in src/routes/attention.js and mirrors
 * POST /api/tasks/:id/complete.
 */

const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'tasks';
const TOBY = 1;

async function collect() {
  const db = getPool();
  let rows, hasAssignees = true;
  const base = `
      SELECT t.id, t.title, t.source AS task_source, t.priority,
             t.due_date::text AS due_date,
             (t.due_date IS NOT NULL AND t.due_date < (now() AT TIME ZONE 'Europe/London')::date) AS overdue
        FROM tasks t
       WHERE t.status IN ('open','in_progress') AND t.category = 'nursery'`;
  try {
    ({ rows } = await db.query(`${base}
         AND (t.owner_staff_id = ${TOBY}
              OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.staff_id = ${TOBY} AND a.status <> 'done'))`));
  } catch (e) {
    hasAssignees = false;
    try {
      ({ rows } = await db.query(`${base} AND t.owner_staff_id = ${TOBY}`));
    } catch (e2) {
      return { ok: false, items: [], note: `tasks unreadable: ${e2.message}` };
    }
  }

  const items = [];
  let monthlyOverdue = 0;
  for (const r of rows) {
    if (r.task_source === 'monthly_checklist' && r.overdue) { monthlyOverdue++; continue; }
    const c = classify({ dueDate: r.due_date, blockedOnToby: true, informational: !r.due_date });
    items.push({
      source: SOURCE, source_key: `task-${r.id}`,
      title: r.title, detail: null, why: c.why, rag: c.rag, category: 'tasks',
      due_date: r.due_date, blocked_on: 'toby', effort_minutes: null,
      action_url: '/my-tasks.html',
      evidence: { task_id: r.id, task_source: r.task_source, priority: r.priority },
      manual: false,
      extra_on_insert: { kind: 'job', owner_staff_id: TOBY, tags: r.task_source === 'monthly_checklist' ? ['checklist'] : [] },
    });
  }
  if (monthlyOverdue > 0) {
    items.push({
      source: SOURCE, source_key: 'monthly-checklist-overdue',
      title: `Monthly checklist: ${monthlyOverdue} overdue`, detail: null,
      why: 'Overdue checklist ticks, grouped into one so they do not bury today.',
      rag: 'amber', category: 'tasks', due_date: null, blocked_on: 'toby', effort_minutes: null,
      action_url: '/my-tasks.html',
      evidence: { count: monthlyOverdue, task_source: 'monthly_checklist', assignees_checked: hasAssignees },
      manual: false,
      extra_on_insert: { kind: 'job', owner_staff_id: TOBY, tags: ['checklist'] },
    });
  }
  return { ok: true, items };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
