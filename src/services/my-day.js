'use strict';
/**
 * my-day.js — b358 (2026-09-29). Served by GET /api/my-morning/day.
 *
 * Toby: "This is the first thing staff should be shown once they login."
 *
 * ── WHAT THIS IS, AND HOW IT RELATES TO b286 ────────────────────────────────
 * b286's morning board (services/morning-board.js) answers ONE question well:
 * "what is outstanding for my key children, across eight strands". This file
 * answers a different and wider one: "what does my day look like" — what is on
 * today, who is off, who is in, what am I owed, what have I been asked to do.
 *
 * It is a READER. It owns no table and writes nothing.
 *
 * ── THE RULE THAT MATTERS MOST: NEVER A SECOND DEFINITION ───────────────────
 * Where b286 already defines "outstanding", this file CALLS it rather than
 * restating it. The parent-messages block, the tracking block and the termly
 * count are lifted straight out of MB.board()'s own strands, so this page and
 * /ey/my-morning's board can never disagree about a number. Reports due comes
 * from b244's report-cycle library for the same reason. Nothing here recomputes
 * a deadline that another part of Wren already owns.
 *
 * Where there was NO existing definition — what is planned for today, who is
 * off, which courses are outstanding — the query is written once, here, and the
 * definition is carried on the block so a number can always be checked by hand.
 *
 * ── AND THE b286 FAILURE MODE, INHERITED ────────────────────────────────────
 * A false zero. "0 outstanding" reads as "done" and a practitioner walks away.
 * So a block whose SOURCE is missing returns state 'not_tracked' with the reason
 * in words and count null — never 0. A block that errors returns 'error', also
 * never 0. Only a block that genuinely asked its source and got nothing back is
 * empty, and an empty block HIDES rather than showing a reassuring nought.
 *
 * ── GDPR ────────────────────────────────────────────────────────────────────
 * Child names are in the response and the response only — the same class of data
 * as b286's board, and /api/my-morning is already on PARENT_DENY / HR_DENY /
 * _ONSITE_CHILD_DATA / OFFSITE_CHILD in server-unified.js for exactly that
 * reason. Nothing here is ever logged.
 *
 * The staff-absence block is deliberately names-only: `absence_type`, `reason`
 * and every proof column are never selected. Who is off is roster information a
 * colleague needs; WHY they are off is not, and a morning board is the last
 * place it should surface.
 */

const MB = require('./morning-board');
const RC = require('../lib/report-cycle');

const { ymd } = MB._internal;

// ── Block shape ─────────────────────────────────────────────────────────────
/**
 * `state`:
 *   items        asked the source, here is the work / what is on
 *   ok           asked the source, nothing to show (the page HIDES these,
 *                unless always_show — see the meeting block)
 *   none         the block does not apply to this person at all, with a reason
 *   not_tracked  the source does not exist. count is null. Never drawn as 0.
 *   error        the query failed. count is null. Never drawn as 0.
 */
function block(key, label, extra) {
  return Object.assign({
    key, label, state: 'ok', count: 0, items: [],
    note: null, definition: null, link: null, always_show: false,
  }, extra || {});
}
const notTracked = (key, label, why, definition) =>
  block(key, label, { state: 'not_tracked', count: null, note: why, definition });

// ── Schema probes ───────────────────────────────────────────────────────────
const _cache = new Map();
async function hasTable(db, name) {
  if (_cache.has('t:' + name)) return _cache.get('t:' + name);
  const { rows } = await db.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name]);
  const ok = !!(rows[0] && rows[0].ok);
  _cache.set('t:' + name, ok);
  return ok;
}
async function hasColumn(db, table, col) {
  const k = 'c:' + table + '.' + col;
  if (_cache.has(k)) return _cache.get(k);
  const { rows } = await db.query(`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, [table, col]);
  const ok = rows.length > 0;
  _cache.set(k, ok);
  return ok;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Today's activities
// ═══════════════════════════════════════════════════════════════════════════
const DEF_ACTIVITIES =
  'Rows in ladn.planned_activities with today’s plan_date whose status is still ‘planned’ or '
+ '‘overdue’. Three things put an activity on this list: it is for one of my key children, it is a '
+ 'room-wide activity in a room I work in, or I am the person down to lead it (planned_activities.led_by). '
+ 'An activity already marked ‘happened’ or ‘cancelled’ is not shown.';

async function blockActivities(db, kids, rooms, me, on) {
  const key = 'activities', label = 'Today’s activities';
  if (!(await hasTable(db, 'planned_activities'))) {
    return notTracked(key, label, 'This edition has no planned_activities table.', DEF_ACTIVITIES);
  }
  const ids = kids.map(k => k.child_id);
  const byId = new Map(kids.map(k => [k.child_id, k]));
  const { rows } = await db.query(`
    SELECT pa.id, pa.slot, pa.status, pa.child_id, pa.room_id, pa.led_by,
           COALESCE(pa.title, pa.custom_title, ca.name, 'Untitled activity') AS title,
           rm.name AS room_name
      FROM planned_activities pa
      LEFT JOIN curriculum_activities ca ON ca.id = pa.activity_id
      LEFT JOIN rooms rm ON rm.id = COALESCE(pa.room_id, (SELECT room_id FROM children WHERE id = pa.child_id))
     WHERE pa.plan_date = $1::date
       AND COALESCE(pa.status,'planned') IN ('planned','overdue')
       AND ( pa.child_id = ANY($2::int[])
             OR (pa.child_id IS NULL AND pa.room_id = ANY($3::int[]))
             OR pa.led_by = $4 )
     ORDER BY pa.slot NULLS LAST, pa.id`,
    [on, ids.length ? ids : [-1], rooms.length ? rooms : [-1], me]);

  return block(key, label, {
    state: rows.length ? 'items' : 'ok',
    count: rows.length,
    definition: DEF_ACTIVITIES,
    link: '/ey/activities',
    items: rows.map(r => {
      const k = r.child_id ? byId.get(Number(r.child_id)) : null;
      const mine = Number(r.led_by) === Number(me);
      return {
        id: r.id, label: r.title,
        sub: [r.slot || null, k ? 'for ' + k.name : (r.room_name || 'whole setting'),
              mine ? 'you are leading this' : null].filter(Boolean).join(' · '),
        state: mine ? 'mine' : 'due',
        href: '/ey/activities',
      };
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Meeting today?
// ═══════════════════════════════════════════════════════════════════════════
const DEF_MEETING =
  'Three diaries are asked, and only the ones this edition actually has: a supervision booked for me today '
+ '(ladn.supervisions.scheduled_date, not already completed or cancelled), a room meeting today in a room I '
+ 'work in (ladn.cpd_room_meetings.meeting_date), and a whole-staff meeting today (ladn.duty_staff_meetings) '
+ 'where I am named in attendee_ids or nobody is named. This block stays visible when the answer is no, '
+ 'because "is there a meeting today" is a yes/no question and the "no" is the useful half.';

async function blockMeeting(db, rooms, me, on) {
  const key = 'meeting', label = 'Meeting today?';
  const items = [];
  const asked = [];

  if (await hasTable(db, 'supervisions')) {
    asked.push('supervisions');
    const { rows } = await db.query(`
      SELECT s.id, s.type, s.scheduled_date,
             sup.first_name || ' ' || sup.last_name AS supervisor_name
        FROM supervisions s
        LEFT JOIN staff sup ON sup.id = s.supervisor_id
       WHERE s.staff_id = $1 AND s.scheduled_date = $2::date
         AND COALESCE(s.status,'scheduled') NOT IN ('completed','cancelled')`, [me, on]);
    rows.forEach(r => items.push({
      id: 'sup-' + r.id, label: 'Supervision' + (r.type ? ' (' + String(r.type).replace(/_/g, ' ') + ')' : ''),
      sub: r.supervisor_name ? 'with ' + r.supervisor_name : 'Supervision booked for today',
      state: 'due', href: 'https://hr.example-nursery.co.uk/my-supervisions.html', // 2026-10-05: supervisions are HR-portal only
    }));
  }

  if (await hasTable(db, 'cpd_room_meetings') && rooms.length) {
    asked.push('room meetings');
    const { rows } = await db.query(`
      SELECT m.id, rm.name AS room_name
        FROM cpd_room_meetings m
        LEFT JOIN rooms rm ON rm.id = m.room_id
       WHERE m.meeting_date = $1::date AND m.room_id = ANY($2::int[])`, [on, rooms]);
    rows.forEach(r => items.push({
      id: 'room-' + r.id, label: 'Room meeting',
      sub: r.room_name || 'Your room', state: 'due', href: '/ey/deep-dive',
    }));
  }

  if (await hasTable(db, 'duty_staff_meetings')) {
    asked.push('staff meetings');
    const { rows } = await db.query(`
      SELECT id FROM duty_staff_meetings
       WHERE meeting_date = $1::date
         AND (attendee_ids IS NULL OR array_length(attendee_ids, 1) IS NULL OR $2 = ANY(attendee_ids))`,
      [on, me]);
    rows.forEach(r => items.push({
      id: 'staff-' + r.id, label: 'Staff meeting',
      sub: 'Whole-staff meeting today', state: 'due', href: '/ey/duties',
    }));
  }

  if (!asked.length) {
    return notTracked(key, label,
      'This edition has no supervision, room-meeting or staff-meeting diary, so today cannot be checked.',
      DEF_MEETING);
  }
  return block(key, label, {
    state: items.length ? 'items' : 'ok',
    count: items.length,
    always_show: true,
    definition: DEF_MEETING,
    note: items.length ? null : 'No — nothing in the diary for you today.',
    items,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Outstanding work
// ═══════════════════════════════════════════════════════════════════════════
// Every line here is somebody else's count, called rather than restated:
// reports from b244's library, termly updates from b286's strand (which is
// itself b277's tracker), next steps from ladn.next_steps, and assigned work
// from the b358 Action Plan. A second definition of "outstanding" on this page
// would be a number that disagrees with the page it links to.
const DEF_OUTSTANDING =
  'Four sources, each counted by the part of Wren that owns it, never recounted here: reports due comes from '
+ 'b244’s report-cycle library (overdue + due, my key children only); termly updates is b286’s termly '
+ 'strand, which is b277’s tracker; next steps overdue is ladn.next_steps still pending with due_by before '
+ 'today for my key children; and assigned work is the Action Plan items assigned to me that are not completed.';

async function blockOutstanding(db, kids, me, on, boardStrands) {
  const key = 'outstanding', label = 'Outstanding work';
  const items = [];
  const ids = kids.map(k => k.child_id);

  // ── Reports due — b244's own library ──────────────────────────────────────
  try {
    const schedule = await RC.buildSchedule(db, { key_person_id: me, on });
    const due = RC.dueRows(schedule, { states: ['overdue', 'due'] });
    if (due.length) {
      const over = due.filter(r => r.state === 'overdue').length;
      items.push({
        id: 'reports', label: due.length + ' report' + (due.length === 1 ? '' : 's') + ' to write',
        sub: over ? over + ' already overdue' : 'due now',
        state: over ? 'overdue' : 'due', href: '/ey/reports-due',
      });
    }
  } catch (e) {
    items.push({ id: 'reports', label: 'Reports could not be read',
      sub: e.message, state: 'unknown', href: '/ey/reports-due' });
  }

  // ── Termly updates — b286's strand (b277's tracker) ───────────────────────
  const termly = boardStrands.get('termly');
  if (termly && typeof termly.outstanding === 'number' && termly.outstanding > 0) {
    items.push({
      id: 'termly', label: termly.outstanding + ' termly update' + (termly.outstanding === 1 ? '' : 's') + ' owed',
      sub: 'this half-term', state: 'due', href: '/ey/termly-tracker',
    });
  } else if (termly && termly.outstanding === null) {
    items.push({ id: 'termly', label: 'Termly updates are not being counted',
      sub: termly.note || 'the source is missing', state: 'unknown', href: '/ey/termly-tracker' });
  }

  // ── Next steps overdue ────────────────────────────────────────────────────
  if (ids.length && await hasTable(db, 'next_steps')) {
    const { rows } = await db.query(`
      SELECT COUNT(*)::int AS n FROM next_steps
       WHERE child_id = ANY($1::int[]) AND status = 'pending'
         AND due_by IS NOT NULL AND due_by < $2::date`, [ids, on]);
    const n = rows[0] ? rows[0].n : 0;
    if (n) items.push({
      id: 'next_steps_overdue', label: n + ' next step' + (n === 1 ? '' : 's') + ' overdue',
      sub: 'past the date they were due by', state: 'overdue', href: '/ey/trackers',
    });
  }

  // ── Assigned work — the b358 Action Plan ──────────────────────────────────
  const mine = await myActionPlanItems(db, me);
  if (mine.length) {
    const over = mine.filter(r => r.is_overdue).length;
    items.push({
      id: 'action_plan', label: mine.length + ' action' + (mine.length === 1 ? '' : 's') + ' assigned to you',
      sub: over ? over + ' overdue' : 'on your action plan',
      state: over ? 'overdue' : 'due', href: '/ey/my-tasks',
    });
  }

  return block(key, label, {
    state: items.length ? 'items' : 'ok',
    count: items.length,
    definition: DEF_OUTSTANDING,
    link: '/ey/my-tasks',
    items,
  });
}

/**
 * The Action Plan items assigned to me and not finished.
 * Assignment is read from BOTH places it can live: the item's own
 * assigned_staff_id (the pre-b358 single assignee, still maintained) and the
 * mirror task's task_assignees rows (b358's multi-assignee path). A person who
 * appears in either is assigned.
 */
async function myActionPlanItems(db, me) {
  if (!(await hasTable(db, 'action_plan_items'))) return [];
  const linked = await hasColumn(db, 'action_plan_items', 'task_id');
  const viaTask = linked && await hasTable(db, 'task_assignees')
    ? `OR EXISTS (SELECT 1 FROM task_assignees a
                   WHERE a.task_id = i.task_id AND a.staff_id = $1 AND a.status <> 'done')`
    : '';
  const { rows } = await db.query(`
    SELECT i.id, i.title, i.deadline, i.priority, i.status,
           ap.title AS plan_title,
           (i.deadline IS NOT NULL AND i.deadline < CURRENT_DATE) AS is_overdue
      FROM action_plan_items i
      LEFT JOIN action_plans ap ON ap.id = i.plan_id
     WHERE i.status <> 'completed'
       AND (ap.id IS NULL OR ap.archived_at IS NULL)
       AND ( i.assigned_staff_id = $1 ${viaTask} )
     ORDER BY i.deadline ASC NULLS LAST, i.id`, [me]);
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. My key children in today, and my buddies
// ═══════════════════════════════════════════════════════════════════════════
const DEF_IN_TODAY =
  'My key children with a row in ladn.attendance for today that is not marked absent. A child signed in has '
+ 'a sign_in_time; a child booked but not yet arrived has a row without one, and is shown as "not in yet" '
+ 'rather than counted as present. Children with no attendance row for today are not booked in and are not '
+ 'listed. BUDDIES (2026-10-01): children whose children.buddy_staff_id is me — set on EY Key Children — '
+ 'are listed the same way and marked "buddy", so whoever covers for an absent key person can see who.';

async function myBuddyChildren(db, me) {
  if (!(await hasColumn(db, 'children', 'buddy_staff_id'))) return [];
  const { rows } = await db.query(`
    SELECT c.id AS child_id,
           trim(coalesce(c.preferred_name, c.first_name, '') || ' ' || coalesce(c.last_name, '')) AS name,
           r.name AS room_name
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
     WHERE c.buddy_staff_id = $1 AND c.is_active = true
       AND (c.leave_date IS NULL OR c.leave_date >= CURRENT_DATE)`, [me]);
  return rows.map(r => ({ ...r, child_id: Number(r.child_id), buddy: true }));
}

async function blockInToday(db, kids, on, me) {
  const key = 'in_today', label = 'My key children in today';
  const mine = new Set(kids.map(k => Number(k.child_id)));
  const buddies = me ? (await myBuddyChildren(db, me)).filter(b => !mine.has(b.child_id)) : [];
  const all = kids.concat(buddies);
  if (!all.length) {
    // b404 (2026-10-06): this used to fall through to block()'s always_show:
    // false default, so the block simply vanished from the page instead of
    // explaining itself — a practitioner with real key children (confirmed
    // elsewhere, e.g. the morning board below) saw NOTHING about them here and
    // read it as "key children are broken", not "none are in yet". Same fix as
    // the 'meeting' block above: a 'none'/zero answer here is itself the
    // useful half, so it must stay on the page, not hide.
    return block(key, label, { state: 'none', definition: DEF_IN_TODAY, always_show: true,
      note: 'No children are assigned to you as key person or buddy. Room leaders set this on Key Children.',
      link: '/ey/key-children' });
  }
  if (!(await hasTable(db, 'attendance'))) {
    return notTracked(key, label, 'This edition has no attendance register.', DEF_IN_TODAY);
  }
  const ids = all.map(k => k.child_id);
  const byId = new Map(all.map(k => [k.child_id, k]));
  const { rows } = await db.query(`
    SELECT child_id, (sign_in_time IS NOT NULL) AS signed_in, COALESCE(absent,false) AS absent
      FROM attendance
     WHERE date = $1::date AND child_id = ANY($2::int[]) AND COALESCE(absent,false) = false`,
    [on, ids]);

  const items = rows.map(r => {
    const k = byId.get(Number(r.child_id)) || {};
    return {
      id: 'c-' + r.child_id, child_id: Number(r.child_id),
      label: k.name || ('Child #' + r.child_id),
      sub: [k.buddy ? 'buddy' : null, k.room_name, r.signed_in ? 'signed in' : 'booked, not in yet'].filter(Boolean).join(' · '),
      state: r.signed_in ? 'in' : 'upcoming',
      href: '/ey/child/' + r.child_id,
    };
  }).sort((a, b) => a.label.localeCompare(b.label));

  // b404 (2026-10-06): zero signed in yet (e.g. before drop-off) is a real
  // answer about this practitioner's own key children, not "nothing to show" —
  // block()'s default always_show:false was hiding this block completely
  // whenever nobody had arrived, which is indistinguishable on the page from
  // the block not existing at all. always_show:true + an explicit note keeps
  // it visible and honest, same treatment as blockMeeting's "No" above.
  return block(key, label, {
    state: items.length ? 'items' : 'ok',
    count: items.length,
    always_show: true,
    definition: DEF_IN_TODAY,
    note: items.length
      ? (buddies.length ? 'Includes the children you are buddy for (marked "buddy").' : null)
      : 'None of your ' + all.length + ' key child' + (all.length === 1 ? '' : 'ren') + ' ' + (all.length === 1 ? 'is' : 'are') + ' in yet.',
    link: '/ey/register',
    items,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Next steps
// ═══════════════════════════════════════════════════════════════════════════
const DEF_NEXT_STEPS =
  'Rows in ladn.next_steps for my key children whose status is still ‘pending’, soonest due_by first '
+ 'and undated ones last. A next step that has been completed, or whose child is no longer mine, is not here.';

async function blockNextSteps(db, kids, on) {
  const key = 'next_steps', label = 'Next steps';
  if (!kids.length) {
    return block(key, label, { state: 'none', definition: DEF_NEXT_STEPS,
      note: 'No children are assigned to you as key person.' });
  }
  if (!(await hasTable(db, 'next_steps'))) {
    return notTracked(key, label, 'This edition has no next_steps table.', DEF_NEXT_STEPS);
  }
  const ids = kids.map(k => k.child_id);
  const byId = new Map(kids.map(k => [k.child_id, k]));
  const { rows } = await db.query(`
    SELECT id, child_id, description, to_char(due_by,'YYYY-MM-DD') AS due_by
      FROM next_steps
     WHERE child_id = ANY($1::int[]) AND status = 'pending'
     ORDER BY due_by ASC NULLS LAST, id
     LIMIT 40`, [ids]);

  return block(key, label, {
    state: rows.length ? 'items' : 'ok',
    count: rows.length,
    definition: DEF_NEXT_STEPS,
    link: '/ey/trackers',
    items: rows.map(r => {
      const k = byId.get(Number(r.child_id)) || {};
      const late = r.due_by && r.due_by < on;
      return {
        id: 'ns-' + r.id, child_id: Number(r.child_id),
        label: k.name || ('Child #' + r.child_id),
        sub: [r.description, r.due_by ? (late ? 'was due ' + r.due_by : 'due ' + r.due_by) : 'no date']
               .filter(Boolean).join(' · '),
        state: late ? 'overdue' : 'due',
        href: '/ey/trackers?child=' + r.child_id,
      };
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Messages from parents — b286's strand, called not copied
// ═══════════════════════════════════════════════════════════════════════════
function blockMessages(boardStrands) {
  const key = 'messages', label = 'Messages from parents';
  const s = boardStrands.get('messages');
  if (!s) return notTracked(key, label, 'The message strand could not be read.', null);
  if (s.outstanding === null) {
    return notTracked(key, label, s.note || 'The message threads could not be read.', s.definition);
  }
  return block(key, label, {
    state: s.items && s.items.length ? 'items' : 'ok',
    count: s.outstanding,
    definition: s.definition,
    note: s.note,
    link: '/ey/messages',
    items: (s.items || []).map(i => ({
      id: 'th-' + i.thread_id, child_id: i.child_id, label: i.label, sub: i.sub,
      state: i.state, href: '/ey/messages?thread=' + i.thread_id,
    })),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Who's off today
// ═══════════════════════════════════════════════════════════════════════════
// NAMES ONLY. absence_type, reason and every proof column are deliberately not
// selected — see the GDPR note at the top of this file.
const DEF_OFF =
  'Staff whose absence covers today, from two sources unioned: ladn.absence_requests that are approved (or '
+ 'auto-approved), and ladn.hr_absences (b229’s BrightHR import, which is already-taken absence). Names '
+ 'only — the reason and the absence type are never read by this block.';

async function blockWhoIsOff(db, on, me) {
  const key = 'who_off', label = 'Who’s off today';
  const parts = [];
  if (await hasTable(db, 'absence_requests')) {
    parts.push(`SELECT staff_id, start_date, end_date FROM absence_requests
                 WHERE (status = 'approved' OR COALESCE(auto_approved,false) = true)`);
  }
  if (await hasTable(db, 'hr_absences')) {
    parts.push(`SELECT staff_id, start_date, end_date FROM hr_absences`);
  }
  if (!parts.length) {
    return notTracked(key, label, 'This edition records no staff absence.', DEF_OFF);
  }
  const { rows } = await db.query(`
    SELECT DISTINCT s.id,
           COALESCE(NULLIF(s.preferred_name,''), s.first_name) || ' ' || s.last_name AS name
      FROM (${parts.join(' UNION ALL ')}) a
      JOIN staff s ON s.id = a.staff_id
     WHERE $1::date >= a.start_date
       AND $1::date <= COALESCE(a.end_date, a.start_date)
     ORDER BY name`, [on]);

  return block(key, label, {
    state: rows.length ? 'items' : 'ok',
    count: rows.length,
    definition: DEF_OFF,
    items: rows.map(r => ({
      id: 'off-' + r.id, label: r.name,
      sub: Number(r.id) === Number(me) ? 'that’s you' : 'off today',
      state: 'info', href: null,
    })),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Courses to complete
// ═══════════════════════════════════════════════════════════════════════════
const DEF_COURSES =
  'Rows in ladn.course_assignments for me whose status is not a finished one (completed / complete / passed), '
+ 'joined to ladn.courses for the title. Soonest due first; a course with no due date is listed last.';

async function blockCourses(db, me, on) {
  const key = 'courses', label = 'Courses to complete';
  if (!(await hasTable(db, 'course_assignments')) || !(await hasTable(db, 'courses'))) {
    return notTracked(key, label, 'This edition has no course catalogue.', DEF_COURSES);
  }
  const { rows } = await db.query(`
    SELECT ca.id, ca.status, ca.required, to_char(ca.due_date,'YYYY-MM-DD') AS due_date,
           c.name, c.slug
      FROM course_assignments ca
      JOIN courses c ON c.id = ca.course_id
     WHERE ca.staff_id = $1
       AND LOWER(COALESCE(ca.status,'')) NOT IN ('completed','complete','passed')
     ORDER BY ca.due_date ASC NULLS LAST, c.name`, [me]);

  return block(key, label, {
    state: rows.length ? 'items' : 'ok',
    count: rows.length,
    definition: DEF_COURSES,
    link: '/ey/cpd-catalogue',
    items: rows.map(r => {
      const late = r.due_date && r.due_date < on;
      return {
        id: 'co-' + r.id, label: r.name,
        sub: [r.required ? 'required' : null,
              r.due_date ? (late ? 'was due ' + r.due_date : 'due ' + r.due_date) : 'no date']
               .filter(Boolean).join(' · '),
        state: late ? 'overdue' : 'due',
        href: '/ey/cpd-catalogue',
      };
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. Key-child tracking at a glance — b286's strand, called not copied
// ═══════════════════════════════════════════════════════════════════════════
function blockTracking(kids, boardStrands) {
  const key = 'tracking', label = 'Key-child tracking at a glance';
  const s = boardStrands.get('tracking');
  if (!s) return notTracked(key, label, 'The tracking strand could not be read.', null);
  if (s.outstanding === null) {
    return notTracked(key, label, s.note || 'Tracking could not be read.', s.definition);
  }
  if (!kids.length) {
    return block(key, label, { state: 'none', definition: s.definition,
      note: 'No children are assigned to you as key person.' });
  }
  // The strand lists the children with NOTHING recorded this half-term. Every
  // other child in scope has something, so on-track / behind is the strand's own
  // answer read two ways — not a second judgement invented here.
  const behind = new Set((s.items || []).map(i => Number(i.child_id)));
  const items = kids.map(k => ({
    id: 'tr-' + k.child_id, child_id: k.child_id, label: k.name,
    sub: [k.room_name, behind.has(k.child_id) ? 'nothing recorded this half-term' : 'tracked this half-term']
           .filter(Boolean).join(' · '),
    state: behind.has(k.child_id) ? 'overdue' : 'ok',
    href: '/ey/trackers?child=' + k.child_id,
  })).sort((a, b) => (a.state === b.state ? a.label.localeCompare(b.label) : (a.state === 'overdue' ? -1 : 1)));

  return block(key, label, {
    state: 'items',
    count: behind.size,
    definition: s.definition,
    note: behind.size
      ? behind.size + ' of ' + kids.length + ' have nothing recorded this half-term.'
      : 'All ' + kids.length + ' have something recorded this half-term.',
    link: '/ey/trackers',
    items,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. This fortnight — b368 (2026-10-01). The focus block's core text, key
// words and song, for every room this person's key children are in — the "My
// Morning / EY home" card the brief asks for. Reads ladn.plan_blocks
// (src/routes/planning.js's focus-blocks section); writes nothing.
// ═══════════════════════════════════════════════════════════════════════════
const DEF_FORTNIGHT =
  'The most recently PUBLISHED ladn.plan_blocks row for each room my key children are in, '
+ 'preferring one whose week has started. A room with no published block yet is simply not '
+ 'listed here — see Planning → Focus Block to start one.';

// b371 — the date that is n WEEKDAYS (Mon-Fri) after ymd; same helper as
// src/routes/planning.js's addWeekdays, duplicated rather than imported
// because my-day.js has no dependency on the planning route today.
function addWeekdaysUTC(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

async function blockFortnight(db, rooms, on) {
  const key = 'fortnight', label = 'This fortnight';
  if (!rooms.length) {
    return block(key, label, { state: 'none', definition: DEF_FORTNIGHT,
      note: 'No children are assigned to you as key person, so there is no room to show.' });
  }
  if (!(await hasTable(db, 'plan_blocks'))) {
    return notTracked(key, label, 'This edition has no focus-block table yet.', DEF_FORTNIGHT);
  }
  const { rows } = await db.query(`
    SELECT DISTINCT ON (pb.room_id) pb.id, pb.room_id, r.name AS room_name,
           pb.core_text, pb.key_vocabulary, pb.song_rhyme, pb.week_commencing,
           pb.week_from, pb.week_to
      FROM plan_blocks pb
      JOIN rooms r ON r.id = pb.room_id
     WHERE pb.room_id = ANY($1::int[]) AND pb.status = 'published'
     ORDER BY pb.room_id, (pb.week_commencing IS NOT NULL AND pb.week_commencing <= $2::date) DESC,
              pb.week_commencing DESC NULLS LAST`, [rooms, on]);
  if (!rows.length) return block(key, label, { state: 'ok', definition: DEF_FORTNIGHT });

  // b371 — if today actually falls inside the block's own weekday span, send
  // the card straight to Today's Input rather than the block overview; a day
  // outside that span (weekend, or the block has finished) still links to the
  // overview, the same as before b371.
  const items = rows.map(r => {
    const vocab = Array.isArray(r.key_vocabulary) ? r.key_vocabulary : [];
    const bits = [
      r.core_text ? ('book: ' + r.core_text) : null,
      vocab.length ? ('words: ' + vocab.slice(0, 4).join(', ') + (vocab.length > 4 ? '…' : '')) : null,
      r.song_rhyme ? ('song: ' + r.song_rhyme) : null,
    ].filter(Boolean);
    const totalDays = Math.max(1, ((r.week_to || r.week_from || 1) - (r.week_from || 1) + 1) * 5);
    const wc = r.week_commencing ? String(r.week_commencing).slice(0, 10) : null;
    const todayInBlock = wc && on >= wc && on <= addWeekdaysUTC(wc, totalDays - 1);
    return {
      id: 'fb-' + r.id, label: r.room_name,
      sub: bits.length ? bits.join(' · ') : 'Published, no core text set yet',
      state: '', href: todayInBlock ? ('/ey/planning-today?room_id=' + r.room_id) : ('/ey/focus-block?room_id=' + r.room_id),
    };
  });
  return block(key, label, { state: 'items', count: items.length, definition: DEF_FORTNIGHT, items });
}

// ═══════════════════════════════════════════════════════════════════════════
// The day
// ═══════════════════════════════════════════════════════════════════════════
const BLOCK_ORDER = ['activities', 'meeting', 'outstanding', 'in_today', 'next_steps',
                     'messages', 'who_off', 'courses', 'tracking', 'fortnight'];

/**
 * Block 7 of the brief — "Emails to read" — is deliberately absent.
 *
 * The shared inbox (b-inbox) stores its threads in ladn.inbox_gmail_threads,
 * which has no per-staff dimension at all: no staff_id, no per-person read
 * state, only whole-mailbox columns (answered, last_direction, labels). There is
 * therefore no honest per-staff unread count to show, and inventing one — "the
 * mailbox has 12 unread" on every practitioner's page — would be exactly the
 * false signal the rest of this file exists to avoid. Recorded in
 * ladn-ready/logs/b358.NOTES.md as the brief asks.
 */
async function day(db, user, q) {
  const on = ymd(q && q.on) || ymd(new Date());
  const me = Number(user.id);

  const scope = await MB.resolveScope(db, user, { scope: 'mine' });
  const kids = await MB.scopedChildren(db, scope, on);
  const rooms = [...new Set(kids.map(k => k.room_id).filter(Boolean))];

  // b286's board, run once. The message, tracking and termly blocks are read
  // out of it rather than recomputed — one definition, two pages.
  let boardStrands = new Map();
  let boardError = null;
  try {
    const board = await MB.board(db, user, { scope: 'mine', on });
    boardStrands = new Map((board.strands || []).map(s => [s.key, s]));
  } catch (e) {
    boardError = e.message;
  }

  const run = (fn, key, label) => fn().catch(e => block(key, label, {
    state: 'error', count: null,
    note: 'This could not be read: ' + e.message + '. It is shown as unknown, never as zero.',
  }));

  const results = await Promise.all([
    run(() => blockActivities(db, kids, rooms, me, on), 'activities', 'Today’s activities'),
    run(() => blockMeeting(db, rooms, me, on), 'meeting', 'Meeting today?'),
    run(() => blockOutstanding(db, kids, me, on, boardStrands), 'outstanding', 'Outstanding work'),
    run(() => blockInToday(db, kids, on, me), 'in_today', 'My key children in today'),
    run(() => blockNextSteps(db, kids, on), 'next_steps', 'Next steps'),
    run(async () => blockMessages(boardStrands), 'messages', 'Messages from parents'),
    run(() => blockWhoIsOff(db, on, me), 'who_off', 'Who’s off today'),
    run(() => blockCourses(db, me, on), 'courses', 'Courses to complete'),
    run(async () => blockTracking(kids, boardStrands), 'tracking', 'Key-child tracking at a glance'),
    run(() => blockFortnight(db, rooms, on), 'fortnight', 'This fortnight'),
  ]);

  const byKey = new Map(results.map(b => [b.key, b]));
  const blocks = BLOCK_ORDER.map(k => byKey.get(k)).filter(Boolean);

  return {
    on,
    me: { id: me, role: user.role },
    key_children: kids.length,
    blocks,
    // The page needs to say out loud when something is NOT counted, so an empty
    // screen can never be mistaken for a finished one.
    unknown_blocks: blocks.filter(b => b.count === null).map(b => b.key),
    board_error: boardError,
    omitted: [{
      key: 'emails',
      label: 'Emails to read',
      why: 'The shared inbox stores no per-staff read state, so there is no honest per-person unread count.',
    }],
  };
}

module.exports = { day, BLOCK_ORDER, _internal: { myActionPlanItems } };
