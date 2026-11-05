'use strict';
// ===========================================================================
// task-accountability.js — b501 (Tasks v2)
//
// Toby, 15 Oct 2026: "we're asking staff to do it and because we're giving them autonomy they're just not doing it…
// the point of this is to hold them accountable. They should be getting the notifications and acting on them, not
// making any excuses."
//
// Two phases, driven from task-reminders.sweepTaskReminders() (so they ride the existing dispatcher poller — no new cron):
//   NUDGE     — while a task is overdue, ONE in-app (+ push where the person has it) nudge a day to each assignee who
//               has not done their part. Nursery days only, from `task_nudge_time` (default 09:00 London).
//   ESCALATE  — after `task_escalate_after_days` (default 2) overdue, ONE escalation per (task, assignee) to whoever
//               assigned it AND the person's line manager (their room leader, else the deputy, else the managers).
//
// "Once" is enforced by the unique index task_reminders_uq (task_id, staff_id, kind, lead_mins):
//   nudge       → (task, assignee, 'nudge',      days_overdue)   one row per overdue day
//   escalation  → (task, assignee, 'escalation', 0)              one row, ever
//
// What is NEVER chased: platform tasks (the Wren To Do List), tasks due before `task_accountability_start` (the old
// backlog), archived tasks, and project parents that have sub-tasks (the sub-tasks are chased instead).
//
// Both categories (task_nudge, task_escalated) are deliberately NOT on the staff email allowlist in
// notification-dispatcher.js: a task title can name a child, and a personal inbox is outside the setting's control
// (memory feedback_staff_personal_emails_safeguarding_split). In-app and push only.
// ===========================================================================

const tr = require('./task-reminders');
const TZ = tr.TZ;

async function _settings(db, keys) {
  const out = {};
  try {
    const { rows } = await db.query(`SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [keys]);
    for (const r of rows) out[r.key] = r.value;
  } catch (e) { console.error('[task-accountability] settings lookup failed, using defaults:', e.message); }
  return out;
}

async function getConfig(db) {
  const s = await _settings(db, ['task_escalate_after_days', 'task_nudge_time', 'task_nudge_weekends', 'task_accountability_start']);
  const days = parseInt(s.task_escalate_after_days, 10);
  return {
    escalateDays: (Number.isFinite(days) && days >= 1) ? days : 2,
    nudgeTime: tr.normaliseTime(s.task_nudge_time || '09:00'),
    nudgeWeekends: String(s.task_nudge_weekends || 'false').toLowerCase() === 'true',
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(s.task_accountability_start || '')) ? s.task_accountability_start : null,
  };
}

/** London wall clock from the database, so there is one clock for the whole sweep. */
async function londonClock(db) {
  const { rows: [r] } = await db.query(`
    SELECT to_char(now() AT TIME ZONE $1, 'HH24:MI') AS hm,
           extract(dow FROM now() AT TIME ZONE $1)::int AS dow,
           (now() AT TIME ZONE $1)::date::text AS today`, [TZ]);
  return r;
}

/** Is the nursery open today (not a weekend, not a bank holiday / closure)? */
async function isOpenDay(db, clock) {
  if (clock.dow === 0 || clock.dow === 6) return false;
  try {
    const { loadClosures, isClosedOn } = require('./closures');
    return !isClosedOn(await loadClosures(db, clock.today, clock.today), clock.today);
  } catch (_) { return true; }
}

/**
 * Who is this person's line manager? Their room leader, else the deputy, else the managers.
 * A room leader's own line manager is the deputy (never another leader in the same room), and nobody is their own.
 */
async function lineManagersFor(db, staffId) {
  const id = Number(staffId);
  const { rows: [me] } = await db.query(`SELECT id, role, room_id FROM staff WHERE id = $1`, [id]);
  if (!me) return [];
  if (me.role !== 'room_leader' && me.room_id) {
    const { rows } = await db.query(
      `SELECT id FROM staff WHERE is_active = true AND role = 'room_leader' AND room_id = $1 AND id <> $2 ORDER BY id`, [me.room_id, id]);
    if (rows.length) return rows.map(r => Number(r.id));
  }
  const { rows: deps } = await db.query(
    `SELECT id FROM staff WHERE is_active = true AND role = 'deputy_manager' AND id <> $1 ORDER BY id`, [id]);
  if (deps.length) return deps.map(r => Number(r.id));
  return managersExcept(db, [id]);
}

async function managersExcept(db, except) {
  const { rows } = await db.query(
    `SELECT id FROM staff WHERE is_active = true AND role IN ('manager','admin') AND NOT (id = ANY($1::int[])) ORDER BY id`,
    [except.map(Number)]);
  return rows.map(r => Number(r.id));
}

/**
 * Every (task, assignee) who still owes work on a task that is overdue by at least `minDays` whole days.
 * Leaf tasks only; nursery category only; nothing due before the accountability start date.
 */
async function overdueRows(db, cfg, minDays, limit = 200) {
  const defaultTime = await tr.getDefaultDueTime(db);
  const { rows } = await db.query(`
    SELECT t.id AS task_id, t.title, t.due_date::text AS due_date, t.priority, t.created_by,
           p.staff_id, COALESCE(p.assigned_by, t.created_by) AS asked_by,
           ((now() AT TIME ZONE $4)::date - t.due_date)::int AS days_over,
           s.first_name || ' ' || s.last_name AS who,
           ab.first_name || ' ' || ab.last_name AS asked_by_name
      FROM tasks t
      JOIN LATERAL (
        SELECT a.staff_id, a.assigned_by FROM task_assignees a WHERE a.task_id = t.id AND a.status <> 'done'
        UNION ALL
        SELECT t.owner_staff_id, t.created_by
         WHERE t.owner_staff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_assignees a2 WHERE a2.task_id = t.id)
      ) p ON true
      JOIN staff s ON s.id = p.staff_id AND s.is_active = true
      LEFT JOIN staff ab ON ab.id = COALESCE(p.assigned_by, t.created_by)
     WHERE t.status = ANY($1::text[])
       AND t.category = 'nursery'
       AND t.archived_at IS NULL
       AND t.due_date IS NOT NULL
       AND ($2::date IS NULL OR t.due_date >= $2::date)
       AND ${tr.DUE_AT_SQL('t', '$3', '$4')} < now()
       AND ((now() AT TIME ZONE $4)::date - t.due_date) >= $5::int
       AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)
     ORDER BY t.due_date, t.id
     LIMIT ${Number(limit) || 200}`,
    [tr.OPEN_STATUSES, cfg.startDate, defaultTime, TZ, minDays]);
  return rows;
}

const dateLabel = d => {
  try { return new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  catch (_) { return String(d); }
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ── NUDGE ───────────────────────────────────────────────────────────────────
async function nudgeOverdue(db, notifyAsync) {
  if (!(await tr.ensureSchema(db))) return 0;
  const cfg = await getConfig(db);
  const clock = await londonClock(db);
  if (clock.hm < cfg.nudgeTime) return 0;
  if (!cfg.nudgeWeekends && !(await isOpenDay(db, clock))) return 0;

  let rows = [];
  try { rows = await overdueRows(db, cfg, 1); }
  catch (e) { console.error('[task-accountability] nudge query failed:', e.message); return 0; }

  let sent = 0;
  for (const r of rows) {
    let claimed = null;
    try {
      const { rows: c } = await db.query(`
        INSERT INTO task_reminders (task_id, staff_id, kind, lead_mins, scheduled_for, status)
        VALUES ($1, $2, 'nudge', $3, now(), 'firing')
        ON CONFLICT (task_id, staff_id, kind, lead_mins) DO NOTHING
        RETURNING id`, [r.task_id, r.staff_id, r.days_over]);
      claimed = c[0] && c[0].id;
    } catch (e) { console.error('[task-accountability] nudge claim failed:', e.message); }
    if (!claimed) continue;

    let notifId = null;
    try {
      notifId = await notifyAsync('task_nudge', 'staff', r.staff_id,
        `⚠️ Overdue: ${r.title}`,
        `Due ${dateLabel(r.due_date)} — ${plural(r.days_over, 'day')} overdue`
          + (r.asked_by_name ? `, asked by ${r.asked_by_name}` : '')
          + `. Do it now, or open it and say what is stopping you.`,
        { relatedTable: 'tasks', relatedId: r.task_id, link: '/task-link?task=' + r.task_id, priority: 'high' });
    } catch (e) { console.error('[task-accountability] nudge notify failed:', e.message); }
    try {
      await db.query(`UPDATE task_reminders SET status=$1, notification_id=$2, fired_at=now() WHERE id=$3`,
        [notifId ? 'sent' : 'skipped', notifId || null, claimed]);
      await db.query(`INSERT INTO task_history (task_id, actor_id, action, detail) VALUES ($1, NULL, 'nudged', $2::jsonb)`,
        [r.task_id, JSON.stringify({ staff_id: r.staff_id, days_overdue: r.days_over })]);
    } catch (e) { console.error('[task-accountability] nudge stamp failed:', e.message); }
    if (notifId) sent++;
  }
  return sent;
}

// ── ESCALATE (once per task per person) ──────────────────────────────────────
async function escalateOverdue(db, notifyAsync) {
  if (!(await tr.ensureSchema(db))) return 0;
  const cfg = await getConfig(db);
  let rows = [];
  try { rows = await overdueRows(db, cfg, cfg.escalateDays); }
  catch (e) { console.error('[task-accountability] escalation query failed:', e.message); return 0; }

  let escalated = 0;
  for (const r of rows) {
    let claimed = null;
    try {
      const { rows: c } = await db.query(`
        INSERT INTO task_reminders (task_id, staff_id, kind, lead_mins, scheduled_for, status)
        VALUES ($1, $2, 'escalation', 0, now(), 'firing')
        ON CONFLICT (task_id, staff_id, kind, lead_mins) DO NOTHING
        RETURNING id`, [r.task_id, r.staff_id]);
      claimed = c[0] && c[0].id;
    } catch (e) { console.error('[task-accountability] escalation claim failed:', e.message); }
    if (!claimed) continue;

    // The assigner and the person's line manager — never the person themself, each once.
    let recipients = new Set();
    try {
      if (r.asked_by && Number(r.asked_by) !== Number(r.staff_id)) recipients.add(Number(r.asked_by));
      for (const id of await lineManagersFor(db, r.staff_id)) if (id !== Number(r.staff_id)) recipients.add(id);
      if (!recipients.size) for (const id of await managersExcept(db, [r.staff_id])) recipients.add(id);
    } catch (e) { console.error('[task-accountability] recipients failed:', e.message); }

    let first = null;
    for (const rid of recipients) {
      try {
        const nid = await notifyAsync('task_escalated', 'staff', rid,
          `⚠️ ${r.who} has not done: ${r.title}`,
          `Due ${dateLabel(r.due_date)} — ${plural(r.days_over, 'day')} overdue and still open. `
            + `They have been reminded every day since. This is the only escalation for this task.`,
          { relatedTable: 'tasks', relatedId: r.task_id,
            link: '/task-link?task=' + r.task_id,
            priority: 'high' });
        if (nid && !first) first = nid;
      } catch (e) { console.error('[task-accountability] escalation notify failed:', e.message); }
    }
    try {
      await db.query(`UPDATE task_reminders SET status=$1, notification_id=$2, fired_at=now() WHERE id=$3`,
        [first ? 'sent' : 'skipped', first || null, claimed]);
      await db.query(`UPDATE tasks SET escalated_at = COALESCE(escalated_at, now()) WHERE id = $1`, [r.task_id]);
      await db.query(`INSERT INTO task_history (task_id, actor_id, action, detail) VALUES ($1, NULL, 'escalated', $2::jsonb)`,
        [r.task_id, JSON.stringify({ staff_id: r.staff_id, days_overdue: r.days_over, to: [...recipients] })]);
    } catch (e) { console.error('[task-accountability] escalation stamp failed:', e.message); }
    if (first) escalated++;
  }
  return escalated;
}

module.exports = { getConfig, londonClock, isOpenDay, lineManagersFor, managersExcept, overdueRows, nudgeOverdue, escalateOverdue };
