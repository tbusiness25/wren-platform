'use strict';
// ===========================================================================
// outstanding-tasks.js — b502. Staff-side outstanding items become ACCOUNTABLE TASKS (b501): they get the assignment bell, the 24h /
// due-time reminders, the daily nudge and the escalation, so they repeat until resolved — and they CLOSE THEMSELVES the moment the
// engine says the item is complete. No ticking needed.
//
//   child items that are OURS to fix (no key person; All About Me not marked complete)
//        → one task per (item, responsible person): the key person, else the room leader, else the deputy, else a manager.
//          Grouped, so a person with 9 children to sort has ONE task that says "9" and lists them, not nine tasks.
//   staff's own items (DBS, right to work, training, qualification)
//        → one task for them per item type.
//   weekly checklist: every Monday, each manager / deputy / room leader gets "This week's outstanding details" for their scope.
//        (One new task per person per week rather than a repeating copy: a missed week stays open and visible, and the checklist is
//        rebuilt from the engine each Monday instead of repeating last week's words.)
//
// One OPEN task per scope is guaranteed by the unique index tasks_outstanding_open_uq (source_ref, while open).
// Task text can name a child, so these tasks (like all task notifications) are in-app and push only, never email.
// Nothing here runs by itself unless settings.outstanding_tasks_enabled / outstanding_weekly_enabled are 'true' AND a cron calls
// scripts/outstanding-sync.js (see NOTES). The Roost button runs it on demand: a person pressing it is the authorisation.
// ===========================================================================

const OUT = require('./outstanding');
const taskReminders = require('./task-reminders');
const { lineManagersFor, managersExcept } = require('./task-accountability');

const TZ = 'Europe/London';
const ISO = d => d.toISOString().slice(0, 10);

async function londonToday(db) {
  const { rows: [r] } = await db.query(`SELECT (now() AT TIME ZONE $1)::date::text AS today, extract(dow FROM now() AT TIME ZONE $1)::int AS dow`, [TZ]);
  return r;
}
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ISO(d); };

/** key person → room leader → deputy → a manager */
async function responsibleFor(db, child, preferKeyPerson) {
  if (preferKeyPerson && child.key_person_id) {
    const { rows: [k] } = await db.query(`SELECT id FROM staff WHERE id=$1 AND is_active=true`, [child.key_person_id]);
    if (k) return Number(k.id);
  }
  if (child.room_id) {
    const { rows } = await db.query(`SELECT id FROM staff WHERE is_active=true AND role='room_leader' AND room_id=$1 ORDER BY id LIMIT 1`, [child.room_id]);
    if (rows.length) return Number(rows[0].id);
  }
  const { rows: d } = await db.query(`SELECT id FROM staff WHERE is_active=true AND role='deputy_manager' ORDER BY id LIMIT 1`);
  if (d.length) return Number(d[0].id);
  const m = await managersExcept(db, []);
  return m.length ? m[0] : null;
}

/** What the open auto-tasks SHOULD be right now. Pure read. */
async function desired(db) {
  const want = new Map();            // source_ref -> { assignee, title, description, due_offset_days, priority }
  const kids = await OUT.forChildren(db, { who: 'us' });
  const byKey = new Map();
  for (const k of kids) for (const it of k.items) {
    const assignee = await responsibleFor(db, k, it.code === 'about_me_incomplete');
    if (!assignee) continue;
    const ref = `child:${it.code}:${assignee}`;
    if (!byKey.has(ref)) byKey.set(ref, { assignee, code: it.code, label: OUT.CODES[it.code].label, kids: [] });
    byKey.get(ref).kids.push(k);
  }
  for (const [ref, g] of byKey) {
    const rooms = [...new Set(g.kids.map(k => k.room_name).filter(Boolean))];
    want.set(ref, {
      assignee: g.assignee, priority: 'medium', days: 7,
      title: `${g.label}: ${g.kids.length}${rooms.length ? ' (' + rooms.join(', ') + ')' : ''}`,
      description: `${g.label}.\n\n${g.kids.length} child${g.kids.length === 1 ? '' : 'ren'} still need this sorting out:\n` + g.kids.map(k => `- ${k.name}${k.room_name ? ' (' + k.room_name + ')' : ''}`).join('\n')
        + `\n\nThis task closes by itself when every one is done. It is rebuilt from the live records, so the list above is always current.`,
    });
  }
  const staff = await OUT.forStaff(db);
  for (const s of staff) for (const it of s.items) {
    const ref = `staff:${it.code}:${s.staff_id}`;
    want.set(ref, {
      assignee: s.staff_id, priority: it.expired ? 'high' : 'medium', days: it.expired ? 3 : 14,
      title: it.label + (it.detail ? `: ${it.detail}` : ''),
      description: `${it.label}${it.detail ? ' - ' + it.detail : ''}${it.due ? ` (date: ${it.due})` : ''}.\n\nPlease sort this out. It closes by itself as soon as Wren sees the record is complete.`,
    });
  }
  return want;
}

/**
 * Create / refresh / close the auto-tasks. dryRun (default) returns the plan and writes nothing.
 * `actor` = the staff row who pressed the button (or null from the cron).
 */
async function sync(db, { dryRun = true, actor = null } = {}) {
  await taskReminders.ensureSchema(db);
  const want = await desired(db);
  const { rows: open } = await db.query(`SELECT id, source_ref, title, description FROM tasks WHERE source='outstanding' AND status IN ('open','in_progress')`);
  const have = new Map(open.map(t => [t.source_ref, t]));
  const plan = { create: [], update: [], close: [], unchanged: 0 };
  for (const [ref, w] of want) {
    const t = have.get(ref);
    if (!t) plan.create.push({ source_ref: ref, assignee: w.assignee, title: w.title });
    else if (t.title !== w.title || t.description !== w.description) plan.update.push({ id: t.id, source_ref: ref, title: w.title });
    else plan.unchanged++;
  }
  for (const [ref, t] of have) if (!want.has(ref)) plan.close.push({ id: t.id, source_ref: ref, title: t.title });
  if (dryRun) return { dry_run: true, ...plan, counts: { create: plan.create.length, update: plan.update.length, close: plan.close.length, unchanged: plan.unchanged } };

  const today = (await londonToday(db)).today;
  for (const c of plan.create) {
    const w = want.get(c.source_ref);
    const { rows: ins } = await db.query(`
      INSERT INTO tasks (title, description, status, priority, due_date, owner_staff_id, created_by, source, source_ref, category, mode)
      VALUES ($1,$2,'open',$3,$4,$5,$6,'outstanding',$7,'nursery','quick')
      ON CONFLICT (source_ref) WHERE source IN ('outstanding','outstanding_weekly') AND status IN ('open','in_progress') DO NOTHING
      RETURNING id`, [w.title, w.description, w.priority, addDays(today, w.days), w.assignee, actor ? actor.id : null, c.source_ref]);
    if (!ins.length) continue;           // another process got there first: one open task per item
    await db.query(`INSERT INTO task_assignees (task_id, staff_id, assigned_by, via) VALUES ($1,$2,$3,'person') ON CONFLICT DO NOTHING`, [ins[0].id, w.assignee, actor ? actor.id : null]);
    await db.query(`INSERT INTO task_history (task_id, actor_id, action, detail) VALUES ($1,$2,'created',$3::jsonb)`, [ins[0].id, actor ? actor.id : null, JSON.stringify({ from: 'outstanding-details', ref: c.source_ref })]);
    try { await taskReminders.scheduleTaskReminders(db, ins[0].id); } catch (e) { /* the sweep backfills */ }
    c.id = ins[0].id;
  }
  for (const u of plan.update) {
    const w = want.get(u.source_ref);
    await db.query(`UPDATE tasks SET title=$2, description=$3, updated_at=now() WHERE id=$1`, [u.id, w.title, w.description]);
  }
  for (const c of plan.close) {
    await db.query(`UPDATE tasks SET status='done', completed_at=now(), updated_at=now(), completion_note='Closed automatically: the record is complete.' WHERE id=$1 AND status IN ('open','in_progress')`, [c.id]);
    await db.query(`UPDATE task_assignees SET status='done', completed_at=COALESCE(completed_at, now()), completion_note=COALESCE(completion_note,'Closed automatically: the record is complete.') WHERE task_id=$1 AND status <> 'done'`, [c.id]);
    await db.query(`UPDATE task_reminders SET status='skipped', fired_at=now() WHERE task_id=$1 AND status='scheduled'`, [c.id]);
    await db.query(`INSERT INTO task_history (task_id, actor_id, action, detail) VALUES ($1,NULL,'auto_closed',$2::jsonb)`, [c.id, JSON.stringify({ reason: 'engine says complete' })]);
  }
  return { dry_run: false, ...plan, counts: { create: plan.create.length, update: plan.update.length, close: plan.close.length, unchanged: plan.unchanged } };
}

// ── weekly checklist ─────────────────────────────────────────────────────────
function checklistText(cl) {
  const lines = cl.lines.map(l => `${l.who === 'parent' ? '[parent to do]' : '[us to do]'} ${l.label}: ${l.count}`
    + (l.children.length ? ` - ${l.children.slice(0, 12).join(', ')}${l.count > 12 ? ', and more' : ''}` : ''));
  const staff = (cl.staff || []).map(s => `${s.name}: ${s.items.join('; ')}`);
  return (lines.length ? lines.join('\n') : 'Nothing outstanding for your area this week.')
    + (staff.length ? `\n\nStaff records:\n${staff.join('\n')}` : '')
    + `\n\nGo through each line: chase the family or sort it out yourself. Open Roost > Children > Missing details for the full list.`;
}

/** Monday's checklist for every manager / deputy / room leader. One task per person per week. */
async function weeklyChecklists(db, { dryRun = true, actor = null, asOf = null } = {}) {
  await taskReminders.ensureSchema(db);
  const t = await londonToday(db);
  const day = asOf || t.today;
  const monday = (() => { const d = new Date(day + 'T00:00:00Z'); const dow = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() - (dow - 1)); return ISO(d); })();
  const friday = addDays(monday, 4);
  const { rows: people } = await db.query(`SELECT id, role, room_id, first_name FROM staff WHERE is_active=true AND role IN ('manager','deputy_manager','room_leader','admin') AND COALESCE(terminated,false)=false ORDER BY id`);
  const plan = [];
  const cache = new Map();
  for (const p of people) {
    const scope = p.role === 'room_leader' ? { room_id: p.room_id } : {};
    if (p.role === 'room_leader' && !p.room_id) continue;
    const key = JSON.stringify(scope);
    if (!cache.has(key)) cache.set(key, await OUT.checklist(db, scope));
    const cl = cache.get(key);
    const ref = `weekly:${p.id}:${monday}`;
    plan.push({ staff_id: p.id, source_ref: ref, total: cl.total, scope: scope.room_id ? 'room' : 'setting', title: `${cl.title} (week of ${monday})`, description: checklistText(cl) });
  }
  if (dryRun) return { dry_run: true, monday, plan: plan.map(({ description, ...x }) => x) };
  let created = 0;
  for (const w of plan) {
    const { rows: ins } = await db.query(`
      INSERT INTO tasks (title, description, status, priority, due_date, time_of_day, owner_staff_id, created_by, source, source_ref, category, mode)
      VALUES ($1,$2,'open','medium',$3,'17:00',$4,$5,'outstanding_weekly',$6,'nursery','quick')
      ON CONFLICT (source_ref) WHERE source IN ('outstanding','outstanding_weekly') AND status IN ('open','in_progress') DO NOTHING
      RETURNING id`, [w.title, w.description, friday, w.staff_id, actor ? actor.id : null, w.source_ref]);
    if (!ins.length) { await db.query(`UPDATE tasks SET description=$2, updated_at=now() WHERE source='outstanding_weekly' AND source_ref=$1 AND status IN ('open','in_progress')`, [w.source_ref, w.description]); continue; }
    await db.query(`INSERT INTO task_assignees (task_id, staff_id, assigned_by, via) VALUES ($1,$2,$3,'person') ON CONFLICT DO NOTHING`, [ins[0].id, w.staff_id, actor ? actor.id : null]);
    await db.query(`INSERT INTO task_history (task_id, actor_id, action, detail) VALUES ($1,$2,'created',$3::jsonb)`, [ins[0].id, actor ? actor.id : null, JSON.stringify({ from: 'outstanding-weekly', week: monday })]);
    try { await taskReminders.scheduleTaskReminders(db, ins[0].id); } catch (e) { /* sweep backfills */ }
    created++;
  }
  return { dry_run: false, monday, created, people: plan.length };
}

module.exports = { desired, sync, weeklyChecklists, checklistText, responsibleFor };
