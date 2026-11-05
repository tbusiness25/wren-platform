'use strict';
// ===========================================================================
// task-reminders.js — reminders, one-shot overdue escalation and recurrence
// for staff tasks (b209).
//
// Deliberately modelled on src/lib/event-reminders.js (b184): the same
// schedule-then-fire split, the same claim-before-notify concurrency guard,
// and the same "ride the EXISTING dispatcher poller, add no cron" rule.
//
// Four phases, all driven from sweepTaskReminders():
//   1. SCHEDULE   — one `task_reminders` row per (task, assignee, lead time)
//                   with the wall-clock moment it should fire. A backfill sweep,
//                   so a task created by ANY code path (the route below, the
//                   monthly checklist seeder, a future importer) gets reminders
//                   without that path having to remember to ask for them.
//   2. FIRE       — when scheduled_for passes, notify() creates the in-app
//                   notification and the staff member's own channel preferences
//                   decide what else happens (telegram / push / email). The
//                   notification row is NOT created up front, or the bell would
//                   show a "reminder" the moment the task was assigned.
//   3. ESCALATE   — a task still open N minutes past due goes to the manager
//                   ONCE. Two independent guards make "once, not nightly" true:
//                   the unique index on (task_id, staff_id, kind, lead_mins)
//                   and the tasks.escalated_at stamp.
//   4. RECUR      — a completed task carrying a repeat rule spawns its next
//                   occurrence exactly once (tasks.recurrence_spawned_at is the
//                   stamp), copying the assignees but NOT the attachments.
//
// Lead times are settings, not constants:
//     settings.task_reminder_lead_1         default 1440 (minutes → 24h before)
//     settings.task_reminder_lead_2         default 60   (minutes →  1h before)
//     settings.task_overdue_escalation_mins default 120  (grace after due)
//     settings.task_default_due_time        default '09:00'
//
// Schema-unqualified table names throughout: the pool sets search_path per
// edition, so this works on ladn, demo_*, htps and childrenscorner alike.
// ===========================================================================

const DEFAULT_LEAD_1     = 1440;    // 24h before, minutes
const DEFAULT_LEAD_2     = 60;      // 1h before, minutes
const DEFAULT_ESCALATION = 120;     // minutes past due before the manager hears
const DEFAULT_DUE_TIME   = '09:00';
const TZ                 = 'Europe/London';

// Only schedule for tasks due inside this window — keeps the backfill query
// cheap and stops a 2030 task from filling the table for years.
const HORIZON_DAYS = 180;

const OPEN_STATUSES = ['open', 'in_progress'];

let _schemaChecked = false;

// Idempotent self-heal, mirroring event-reminders.ensureSchema and the house
// pattern in server-unified.js. The authoritative DDL is
// scripts/migrations/2026-08-19-b209-staff-tasks.sql; this makes the code safe
// on an edition where that migration has not been run yet.
async function ensureSchema(db) {
  if (_schemaChecked) return true;
  try {
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS room_id               integer`);
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat_rule           text`);
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat_every          integer DEFAULT 1`);
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat_until          date`);
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat_parent_id      integer`);
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_spawned_at timestamptz`);
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS escalated_at          timestamptz`);
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completion_note       text`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS task_assignees (
        id              serial PRIMARY KEY,
        task_id         integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        staff_id        integer NOT NULL,
        status          text NOT NULL DEFAULT 'open',
        completed_at    timestamptz,
        completion_note text,
        assigned_by     integer,
        created_at      timestamptz DEFAULT now()
      )`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS task_assignees_uq ON task_assignees (task_id, staff_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS task_assignees_staff_idx ON task_assignees (staff_id, status)`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS task_attachments (
        id           serial PRIMARY KEY,
        task_id      integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title        text,
        filename     text,
        stored_path  text,
        mime         text,
        size_bytes   bigint,
        uploaded_by  integer,
        uploaded_at  timestamptz DEFAULT now(),
        notes        text,
        deleted      boolean DEFAULT false
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS task_attachments_task_idx ON task_attachments (task_id) WHERE deleted = false`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS task_reminders (
        id              serial PRIMARY KEY,
        task_id         integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        staff_id        integer NOT NULL,
        kind            text NOT NULL DEFAULT 'lead',
        lead_mins       integer NOT NULL,
        scheduled_for   timestamptz NOT NULL,
        status          text NOT NULL DEFAULT 'scheduled',
        notification_id integer,
        fired_at        timestamptz,
        created_at      timestamptz DEFAULT now()
      )`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS task_reminders_uq ON task_reminders (task_id, staff_id, kind, lead_mins)`);
    await db.query(`CREATE INDEX IF NOT EXISTS task_reminders_due_idx ON task_reminders (status, scheduled_for)`);
    // b501 (Tasks v2) — same DDL as migrations/2026-10-17-b501-tasks-v2.sql, so an edition that has not run it self-heals.
    await db.query(`ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS mode               text    NOT NULL DEFAULT 'quick',
      ADD COLUMN IF NOT EXISTS is_project         boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS parent_task_id     integer,
      ADD COLUMN IF NOT EXISTS start_date         date,
      ADD COLUMN IF NOT EXISTS smart_specific     text,
      ADD COLUMN IF NOT EXISTS smart_measurable   text,
      ADD COLUMN IF NOT EXISTS smart_achievable   text,
      ADD COLUMN IF NOT EXISTS smart_relevant     text,
      ADD COLUMN IF NOT EXISTS relevant_kind      text,
      ADD COLUMN IF NOT EXISTS relevant_ref       text,
      ADD COLUMN IF NOT EXISTS evidence_required  boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS skip_non_open_days boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS assignee_spec      jsonb,
      ADD COLUMN IF NOT EXISTS archived_at        timestamptz`);
    await db.query(`ALTER TABLE task_assignees
      ADD COLUMN IF NOT EXISTS via           text,
      ADD COLUMN IF NOT EXISTS first_seen_at timestamptz,
      ADD COLUMN IF NOT EXISTS last_seen_at  timestamptz,
      ADD COLUMN IF NOT EXISTS seen_count    integer NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE task_attachments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'material'`);
    await db.query(`CREATE TABLE IF NOT EXISTS task_comments (
        id serial PRIMARY KEY, task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, author_id integer,
        author_name text, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), legacy_key text UNIQUE)`);
    await db.query(`CREATE TABLE IF NOT EXISTS task_history (
        id serial PRIMARY KEY, task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, actor_id integer,
        action text NOT NULL, detail jsonb, created_at timestamptz NOT NULL DEFAULT now(), legacy_key text UNIQUE)`);
    await db.query(`CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent_task_id) WHERE parent_task_id IS NOT NULL`);
    _schemaChecked = true;
    return true;
  } catch (e) {
    console.error('[task-reminders] schema init failed:', e.message);
    return false;
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

async function _settings(db, keys) {
  const out = {};
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [keys]);
    for (const r of rows) out[r.key] = r.value;
  } catch (e) {
    console.error('[task-reminders] settings lookup failed, using defaults:', e.message);
  }
  return out;
}

/** Lead times in minutes, newest value wins. Bad/blank values fall back. */
async function getLeadMinutes(db) {
  const leads = [DEFAULT_LEAD_1, DEFAULT_LEAD_2];
  const s = await _settings(db, ['task_reminder_lead_1', 'task_reminder_lead_2']);
  const n1 = parseInt(s.task_reminder_lead_1, 10);
  const n2 = parseInt(s.task_reminder_lead_2, 10);
  if (Number.isFinite(n1) && n1 > 0) leads[0] = n1;
  if (Number.isFinite(n2) && n2 > 0) leads[1] = n2;
  // b501 — and a third one AT the due moment ("due now"). Dedupe: identical leads would collide on the (task, staff, kind, lead) index.
  leads.push(0);
  return [...new Set(leads)];
}

async function getEscalationMinutes(db) {
  const s = await _settings(db, ['task_overdue_escalation_mins']);
  const n = parseInt(s.task_overdue_escalation_mins, 10);
  return (Number.isFinite(n) && n >= 0) ? n : DEFAULT_ESCALATION;
}

async function getDefaultDueTime(db) {
  const s = await _settings(db, ['task_default_due_time']);
  return normaliseTime(s.task_default_due_time || DEFAULT_DUE_TIME);
}

// ── Due moment, in SQL ──────────────────────────────────────────────────────
// tasks.time_of_day is FREE TEXT and always has been: real rows in ladn hold
// 'morning' as well as '09:30'. A plain `time_of_day::time` therefore takes the
// whole query down with `invalid input syntax for type time: "morning"` —
// which is exactly what the first run of the b209 self-test hit. So the cast is
// guarded: a value has to look like a real 24h time before it is used at all,
// and anything else silently falls back to settings.task_default_due_time.
// The pattern is deliberately strict about the hour (0-23) and minute (0-59) —
// a loose \d{1,2} would let '99:99' through and reintroduce the same crash.
const DUE_TIME_SQL = (col, defaultParam) =>
  `COALESCE((CASE WHEN ${col} ~ '^[[:space:]]*([01]?[0-9]|2[0-3])[:.][0-5][0-9]'
                  THEN regexp_replace(${col}, '^[[:space:]]*([0-9]{1,2})[:.]([0-9]{2}).*$', '\\1:\\2')
             END)::time, ${defaultParam}::time)`;

/** The task's due moment as London wall-clock. `alias` is the tasks alias. */
const DUE_AT_SQL = (alias, defaultParam, tzParam) =>
  `((${alias}.due_date + ${DUE_TIME_SQL(`${alias}.time_of_day`, defaultParam)}) AT TIME ZONE ${tzParam})`;

// The JS-side twin of DUE_TIME_SQL: normalise free text to HH:MM so the
// timestamp maths can never be fed something Postgres will reject.
function normaliseTime(raw) {
  const m = String(raw || '').match(/(\d{1,2})[:.](\d{2})/);
  if (!m) return DEFAULT_DUE_TIME;
  const h   = Math.min(23, parseInt(m[1], 10));
  const min = Math.min(59, parseInt(m[2], 10));
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

// ── 1. SCHEDULE ─────────────────────────────────────────────────────────────

/**
 * Everyone who should be reminded about this task. task_assignees is the real
 * list; tasks.owner_staff_id is kept in step with the FIRST assignee so the
 * pre-b209 readers (cockpit card, monthly checklist, GET /api/tasks/summary)
 * still see what they always saw — but a task created before b209 has only the
 * owner, so fall back to it.
 */
async function taskRecipients(db, taskId, ownerStaffId) {
  const ids = new Set();
  try {
    const { rows } = await db.query(
      `SELECT staff_id FROM task_assignees WHERE task_id=$1 AND status <> 'done'`, [taskId]);
    rows.forEach(r => ids.add(Number(r.staff_id)));
  } catch (e) {
    console.error('[task-reminders] assignee lookup failed:', e.message);
  }
  if (!ids.size && ownerStaffId) ids.add(Number(ownerStaffId));
  return [...ids].filter(Number.isInteger);
}

/**
 * Schedule the lead reminders for ONE task. Returns the rows it created (empty
 * when the task has no due date, no assignees, or every lead time is already in
 * the past). ON CONFLICT DO NOTHING makes it safe to call repeatedly — the
 * create/update routes call it inline so the caller gets ids back immediately,
 * and the sweep calls it again for anything created elsewhere.
 */
async function scheduleTaskReminders(db, taskId) {
  if (!(await ensureSchema(db))) return [];
  const { rows: ts } = await db.query(
    `SELECT id, title, status, due_date, time_of_day, owner_staff_id FROM tasks WHERE id=$1`, [taskId]);
  const t = ts[0];
  if (!t || !t.due_date) return [];
  if (!OPEN_STATUSES.includes(t.status)) return [];

  const staffIds = await taskRecipients(db, t.id, t.owner_staff_id);
  if (!staffIds.length) return [];

  const leads    = await getLeadMinutes(db);
  const dueTime  = t.time_of_day ? normaliseTime(t.time_of_day) : await getDefaultDueTime(db);
  const created  = [];

  for (const staffId of staffIds) {
    for (const lead of leads) {
      try {
        // Every parameter is cast explicitly: $3 feeds both an integer column
        // and an interval, and without ::int Postgres infers it as text from
        // the interval side and then rejects the insert (the b184 trap).
        const { rows } = await db.query(`
          INSERT INTO task_reminders (task_id, staff_id, kind, lead_mins, scheduled_for)
          SELECT $1::int, $2::int, 'lead', $3::int, ts
          FROM (
            SELECT (($4::date + $5::time) AT TIME ZONE $6) - make_interval(mins => $3::int) AS ts
          ) s
          WHERE s.ts > NOW()
          ON CONFLICT (task_id, staff_id, kind, lead_mins) DO NOTHING
          RETURNING id, task_id, staff_id, kind, lead_mins, scheduled_for, status`,
          [t.id, staffId, lead, t.due_date, dueTime, TZ]);
        if (rows[0]) created.push(rows[0]);
      } catch (e) {
        console.error(`[task-reminders] schedule failed (task ${t.id}, staff ${staffId}, lead ${lead}):`, e.message);
      }
    }
  }
  return created;
}

/**
 * Backfill sweep: any open, dated task whose assignee count no longer matches
 * its reminder count gets the missing rows. This is what makes "every assigned
 * task earns reminders" true regardless of which route did the assigning.
 */
async function scheduleMissingReminders(db) {
  if (!(await ensureSchema(db))) return 0;
  let ts = [];
  const leadCount = (await getLeadMinutes(db)).length;
  try {
    const { rows } = await db.query(`
      SELECT t.id
      FROM tasks t
      WHERE t.status = ANY($1::text[])
        AND t.due_date IS NOT NULL
        AND t.due_date >= CURRENT_DATE
        AND t.due_date <= CURRENT_DATE + ($2 || ' days')::interval
        AND (
          SELECT COUNT(*) FROM task_reminders r WHERE r.task_id = t.id AND r.kind = 'lead'
        ) < (
          GREATEST(
            (SELECT COUNT(*) FROM task_assignees a WHERE a.task_id = t.id AND a.status <> 'done'),
            CASE WHEN t.owner_staff_id IS NULL THEN 0 ELSE 1 END
          ) * $3::int
        )
      ORDER BY t.due_date
      LIMIT 200`, [OPEN_STATUSES, HORIZON_DAYS, leadCount]);
    ts = rows;
  } catch (e) {
    console.error('[task-reminders] backfill query failed:', e.message);
    return 0;
  }
  let n = 0;
  for (const t of ts) n += (await scheduleTaskReminders(db, t.id)).length;
  return n;
}

// ── 2. FIRE ─────────────────────────────────────────────────────────────────

function leadLabel(mins) {
  if (mins <= 0) return 'due now';
  if (mins >= 1440) {
    const d = Math.round(mins / 1440);
    return `due in ${d} day${d === 1 ? '' : 's'}`;
  }
  if (mins >= 60) {
    const h = Math.round(mins / 60);
    return `due in ${h} hour${h === 1 ? '' : 's'}`;
  }
  return `due in ${mins} minutes`;
}

function dateLabel(d) {
  try {
    return new Date(d).toLocaleDateString('en-GB',
      { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
  } catch (_) { return String(d); }
}

/**
 * Fire every lead reminder now due. notifyAsync is AWAITED (not fire-and-forget)
 * so the notification id can be stamped onto the reminder row — that stamp is
 * also the proof the reminder actually landed.
 *
 * A reminder for a task that has since been completed/cancelled, or whose
 * assignee has already ticked their own line off, is closed as 'skipped'
 * rather than fired: nobody wants a reminder about something they just did.
 */
async function fireDueReminders(db, notifyAsync) {
  if (!(await ensureSchema(db))) return 0;
  let due = [];
  try {
    const { rows } = await db.query(`
      SELECT r.id, r.task_id, r.staff_id, r.lead_mins, r.scheduled_for,
             t.title, t.status, t.due_date, t.time_of_day, t.priority,
             (SELECT a.status FROM task_assignees a
               WHERE a.task_id = t.id AND a.staff_id = r.staff_id) AS my_status
      FROM task_reminders r
      JOIN tasks t ON t.id = r.task_id
      WHERE r.kind = 'lead' AND r.status = 'scheduled' AND r.scheduled_for <= NOW()
      ORDER BY r.scheduled_for
      LIMIT 50`);
    due = rows;
  } catch (e) {
    console.error('[task-reminders] due query failed:', e.message);
    return 0;
  }

  let fired = 0;
  for (const r of due) {
    // Claim first so a second dispatcher process (prod runs one, but the dev
    // container shares this DB) can't fire the same reminder twice.
    let claimed = false;
    try {
      const { rowCount } = await db.query(
        `UPDATE task_reminders SET status='firing' WHERE id=$1 AND status='scheduled'`, [r.id]);
      claimed = rowCount > 0;
    } catch (e) { console.error('[task-reminders] claim failed:', e.message); }
    if (!claimed) continue;

    const stale = !OPEN_STATUSES.includes(r.status) || r.my_status === 'done';
    if (stale) {
      await db.query(
        `UPDATE task_reminders SET status='skipped', fired_at=NOW() WHERE id=$1`, [r.id]
      ).catch(() => {});
      continue;
    }

    const body = `${dateLabel(r.due_date)}`
      + (r.time_of_day ? ` at ${normaliseTime(r.time_of_day)}` : '')
      + ` — ${leadLabel(r.lead_mins)}.`
      + (r.lead_mins <= 0 ? ' Please tick it off, or tell us what is stopping you.' : '');

    let notifId = null;
    try {
      notifId = await notifyAsync('task_due', 'staff', r.staff_id,
        `📋 ${r.title}`, body,
        { relatedTable: 'tasks', relatedId: r.task_id, link: '/task-link?task=' + r.task_id,
          priority: r.priority === 'urgent' ? 'high' : 'normal' });
    } catch (e) {
      console.error('[task-reminders] notify failed:', e.message);
    }

    try {
      await db.query(
        `UPDATE task_reminders SET status=$1, notification_id=$2, fired_at=NOW() WHERE id=$3`,
        [notifId ? 'sent' : 'skipped', notifId || null, r.id]);
    } catch (e) { console.error('[task-reminders] stamp failed:', e.message); }
    if (notifId) fired++;
  }
  return fired;
}

// ── 3. ESCALATE (once — never nightly) ──────────────────────────────────────

/**
 * A task still open more than `task_overdue_escalation_mins` past its due
 * moment goes to the manager ONCE.
 *
 * "Once" is guaranteed twice over, because a nagging escalation is exactly the
 * failure mode this is written to avoid:
 *   (a) tasks.escalated_at IS NULL is in the WHERE clause and is stamped
 *       whatever the notification outcome — so the row can never be selected
 *       a second time, even if notify() failed;
 *   (b) task_reminders carries a kind='escalation' row per task under the
 *       unique index (task_id, staff_id=0, 'escalation', 0), so a concurrent
 *       process racing on (a) still cannot insert a second one.
 * Re-opening a task deliberately does NOT clear escalated_at — the manager has
 * already been told about this task, and the assignee's own reminders continue.
 */
async function escalateOverdue(db, notifyAsync) {
  if (!(await ensureSchema(db))) return 0;
  const graceMins   = await getEscalationMinutes(db);
  const defaultTime = await getDefaultDueTime(db);

  let overdue = [];
  try {
    const { rows } = await db.query(`
      SELECT t.id, t.title, t.due_date, t.priority, t.owner_staff_id,
             COALESCE(
               (SELECT string_agg(s.first_name || ' ' || s.last_name, ', ' ORDER BY s.first_name)
                  FROM task_assignees a JOIN staff s ON s.id = a.staff_id
                 WHERE a.task_id = t.id AND a.status <> 'done'),
               (SELECT s.first_name || ' ' || s.last_name FROM staff s WHERE s.id = t.owner_staff_id)
             ) AS who
      FROM tasks t
      WHERE t.status = ANY($1::text[])
        AND t.due_date IS NOT NULL
        AND t.escalated_at IS NULL
        AND ${DUE_AT_SQL('t', '$2', '$3')} + make_interval(mins => $4::int) <= NOW()
      ORDER BY t.due_date
      LIMIT 25`, [OPEN_STATUSES, defaultTime, TZ, graceMins]);
    overdue = rows;
  } catch (e) {
    console.error('[task-reminders] overdue query failed:', e.message);
    return 0;
  }

  let escalated = 0;
  for (const t of overdue) {
    // Guard (b): claim the one escalation slot for this task.
    let claimed = false;
    try {
      const { rows } = await db.query(`
        INSERT INTO task_reminders (task_id, staff_id, kind, lead_mins, scheduled_for, status)
        VALUES ($1, 0, 'escalation', 0, NOW(), 'firing')
        ON CONFLICT (task_id, staff_id, kind, lead_mins) DO NOTHING
        RETURNING id`, [t.id]);
      claimed = rows.length > 0;
      if (claimed) t._reminderId = rows[0].id;
    } catch (e) { console.error('[task-reminders] escalation claim failed:', e.message); }

    // Guard (a): stamp the task even when the slot was already taken, so this
    // row leaves the candidate set for good.
    try {
      await db.query(`UPDATE tasks SET escalated_at=NOW() WHERE id=$1 AND escalated_at IS NULL`, [t.id]);
    } catch (e) { console.error('[task-reminders] escalation stamp failed:', e.message); }
    if (!claimed) continue;

    const body = `Due ${dateLabel(t.due_date)} and still open`
      + (t.who ? ` — assigned to ${t.who}.` : '.')
      + ' This is the only escalation for this task.';

    let notifId = null;
    try {
      notifId = await notifyAsync('task_overdue', 'all-managers', null,
        `⚠️ Overdue task: ${t.title}`, body,
        { relatedTable: 'tasks', relatedId: t.id, link: '/staff-tasks.html',
          priority: t.priority === 'urgent' ? 'high' : 'normal' });
    } catch (e) {
      console.error('[task-reminders] escalation notify failed:', e.message);
    }

    try {
      await db.query(
        `UPDATE task_reminders SET status=$1, notification_id=$2, fired_at=NOW() WHERE id=$3`,
        [notifId ? 'sent' : 'skipped', notifId || null, t._reminderId]);
    } catch (e) { console.error('[task-reminders] escalation stamp failed:', e.message); }
    if (notifId) escalated++;
  }
  return escalated;
}

// ── 4. RECUR ────────────────────────────────────────────────────────────────

const REPEAT_RULES = ['daily', 'weekly', 'fortnightly', 'monthly', 'termly', 'yearly'];

/** The SQL interval for one step of a repeat rule. null = not a repeat rule. */
function repeatInterval(rule, every) {
  const n = Math.max(1, parseInt(every, 10) || 1);
  switch (String(rule || '').toLowerCase()) {
    case 'daily':       return `${n} days`;
    case 'weekly':      return `${n} weeks`;
    case 'fortnightly': return `${n * 2} weeks`;
    case 'monthly':     return `${n} months`;
    case 'termly':      return `${n * 3} months`;   // a term ≈ a quarter
    case 'yearly':      return `${n} years`;
    default:            return null;
  }
}

/**
 * A finished repeating task spawns its next occurrence — once. This is the
 * "most nursery tasks are recurring" requirement: the weekly fire-drill check
 * and the monthly first-aid stock count reappear on their own.
 *
 * It runs in the sweep rather than in the complete route on purpose, so a task
 * marked done ANY way (the complete endpoint, a manager's PUT, a future
 * importer) still rolls forward. tasks.recurrence_spawned_at is the stamp that
 * makes it once; the child carries repeat_parent_id so the series is traceable.
 */
async function spawnRecurrences(db) {
  if (!(await ensureSchema(db))) return 0;
  let due = [];
  try {
    // b501 — a repeat keeps its SCHEDULE. A copy is created when the current one is finished (as before) OR when its
    // due date has passed without it being done. The missed one stays overdue and visible; the next one appears on
    // time. (Before b501 a repeat stopped dead until somebody completed the last copy.)
    const { rows } = await db.query(`
      SELECT id, title, description, priority, due_date::text AS due_date, time_of_day, owner_staff_id,
             created_by, source, source_ref, linked_to, linked_id, room_id,
             repeat_rule, repeat_every, repeat_until::text AS repeat_until, repeat_parent_id, category,
             mode, smart_specific, smart_measurable, smart_achievable, smart_relevant, relevant_kind, relevant_ref,
             evidence_required, skip_non_open_days, assignee_spec,
             (now() AT TIME ZONE 'Europe/London')::date::text AS today
      FROM tasks
      WHERE repeat_rule IS NOT NULL
        AND recurrence_spawned_at IS NULL
        AND due_date IS NOT NULL
        AND status <> 'cancelled'
        AND (status = 'done' OR due_date < (now() AT TIME ZONE 'Europe/London')::date)
      ORDER BY id
      LIMIT 25`);
    due = rows;
  } catch (e) {
    console.error('[task-reminders] recurrence query failed:', e.message);
    return 0;
  }

  let spawned = 0;
  for (const t of due) {
    const step = repeatInterval(t.repeat_rule, t.repeat_every);
    // Stamp FIRST, unconditionally: an unrecognised rule must not be re-examined
    // on every 30s tick for the rest of time.
    try {
      const { rowCount } = await db.query(
        `UPDATE tasks SET recurrence_spawned_at=NOW() WHERE id=$1 AND recurrence_spawned_at IS NULL`, [t.id]);
      if (!rowCount) continue;   // another process got there first
    } catch (e) {
      console.error('[task-reminders] recurrence stamp failed:', e.message);
      continue;
    }
    if (!step) {
      console.error(`[task-reminders] task ${t.id} has an unknown repeat_rule "${t.repeat_rule}" — not repeated`);
      continue;
    }

    try {
      // Next due date: one step after this one, and never in the past (a series that fell behind jumps to the next
      // future date instead of back-filling a pile of overdue copies).
      const { rows: [nx0] } = await db.query(`
        SELECT d::date::text AS next
          FROM generate_series($1::date::timestamp + $2::interval, GREATEST($1::date, $3::date)::timestamp + $2::interval, $2::interval) d
         WHERE d::date >= $3::date
         ORDER BY d LIMIT 1`, [t.due_date, step, t.today]);
      let next = nx0 && nx0.next;
      if (!next) continue;
      if (t.skip_non_open_days) next = await nextOpenDay(db, next);
      if (t.repeat_until && next > t.repeat_until) continue;   // past repeat_until — the series has ended

      const { rows: nx } = await db.query(`
        INSERT INTO tasks (title, description, status, priority, due_date, owner_staff_id,
                           created_by, source, source_ref, linked_to, linked_id, time_of_day,
                           room_id, repeat_rule, repeat_every, repeat_until, repeat_parent_id, category,
                           mode, smart_specific, smart_measurable, smart_achievable, smart_relevant,
                           relevant_kind, relevant_ref, evidence_required, skip_non_open_days, assignee_spec)
        VALUES ($1,$2,'open',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                $18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
        RETURNING id, due_date::text AS due_date`,
        [t.title, t.description, t.priority, next, t.owner_staff_id, t.created_by,
         t.source, t.source_ref, t.linked_to, t.linked_id, t.time_of_day, t.room_id,
         t.repeat_rule, t.repeat_every, t.repeat_until, t.repeat_parent_id || t.id, t.category || 'nursery',
         t.mode || 'quick', t.smart_specific, t.smart_measurable, t.smart_achievable, t.smart_relevant,
         t.relevant_kind, t.relevant_ref, !!t.evidence_required, !!t.skip_non_open_days,
         t.assignee_spec ? JSON.stringify(t.assignee_spec) : null]);
      const nxt = nx[0];
      // Carry the assignees forward; a recurring task keeps its team (and how each was asked).
      await db.query(`
        INSERT INTO task_assignees (task_id, staff_id, assigned_by, via)
        SELECT $1, a.staff_id, a.assigned_by, a.via FROM task_assignees a WHERE a.task_id = $2
        ON CONFLICT (task_id, staff_id) DO NOTHING`, [nxt.id, t.id]);
      // Attachments are deliberately NOT copied — a scanned form from last
      // month is evidence of last month's check, not this month's.
      await scheduleTaskReminders(db, nxt.id);
      await db.query(
        `INSERT INTO task_history (task_id, actor_id, action, detail) VALUES ($1, NULL, 'repeated_from', $2::jsonb)`,
        [nxt.id, JSON.stringify({ from_task_id: t.id })]).catch(() => {});
      spawned++;
      console.log(`[task-reminders] task ${t.id} (${t.repeat_rule}) → next occurrence ${nxt.id} due ${nxt.due_date}`);
    } catch (e) {
      console.error(`[task-reminders] recurrence spawn failed for task ${t.id}:`, e.message);
    }
  }
  return spawned;
}

/** First nursery-open day on or after `dateStr` (not a weekend, not a bank holiday / closure date). */
async function nextOpenDay(db, dateStr) {
  const { loadClosures, isClosedOn } = require('./closures');
  const add = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const closed = await loadClosures(db, dateStr, add(dateStr, 60));
  let d = dateStr;
  for (let i = 0; i < 60; i++) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6 && !isClosedOn(closed, d)) return d;
    d = add(d, 1);
  }
  return dateStr;
}

// ── One tick of all four phases — the entry point the dispatcher calls ──────

async function sweepTaskReminders(db, notifyAsync) {
  const scheduled = await scheduleMissingReminders(db);
  const fired     = await fireDueReminders(db, notifyAsync);
  // b501 — the daily overdue nudge to the assignee, then ONE escalation per (task, assignee) to the assigner and the
  // line manager after N days. These replace the b209 "all managers, 120 minutes after due" alert (escalateOverdue
  // below is kept, exported, but no longer called from the sweep).
  const acc       = require('./task-accountability');
  const nudged    = await acc.nudgeOverdue(db, notifyAsync);
  const escalated = await acc.escalateOverdue(db, notifyAsync);
  const spawned   = await spawnRecurrences(db);
  return { scheduled, fired, nudged, escalated, spawned };
}

module.exports = {
  REPEAT_RULES,
  OPEN_STATUSES,
  TZ,
  DUE_TIME_SQL,
  DUE_AT_SQL,
  ensureSchema,
  getLeadMinutes,
  getEscalationMinutes,
  getDefaultDueTime,
  normaliseTime,
  repeatInterval,
  taskRecipients,
  scheduleTaskReminders,
  scheduleMissingReminders,
  fireDueReminders,
  escalateOverdue,
  spawnRecurrences,
  nextOpenDay,
  sweepTaskReminders,
};
