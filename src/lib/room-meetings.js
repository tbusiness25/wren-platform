'use strict';
/**
 * room-meetings.js — b530 (2026-10-26). THE room meeting store.
 *
 * Toby: "staff meetings are something that need to be organised and led by room
 * leaders, and it's their responsibility to make sure they are going ahead and
 * all the staff were attending and the meeting minutes are written up. We can
 * build this all into Wren."
 *
 * Every surface reads and writes through this file — the routes appended to
 * src/routes/cpd-programme.js, the rhythm sweep (src/lib/room-meeting-rhythm.js),
 * the What-needs-me collector (src/services/attention/room-meetings.js) and the
 * Roost panel. Same reason as src/lib/finance-calendar-store.js: three callers
 * with three copies of "is this meeting overdue" is three answers.
 *
 * ── ONE PLACE, ONE VERSION ─────────────────────────────────────────────────
 * The table is b262's ladn.cpd_room_meetings, extended by
 * migrations/2026-10-26-b530-room-meetings.sql — NOT a new one. The CPD article
 * is now ONE agenda item instead of the whole agenda. ladn.duty_staff_meetings
 * is retired (0 rows, no read route); see that migration's header and the b530
 * NOTES.
 *
 * ── WHO CAN DO WHAT ────────────────────────────────────────────────────────
 *   manager-level   read + write every room
 *   room_leader     read every room, write ONLY their own (staff.room_id)
 *   everyone else   read ONLY their own room, write nothing; they confirm they
 *                   have read the minutes
 *   no room at all  nothing, with a sentence saying why rather than an empty page
 *
 * Both halves are decided HERE and re-checked in the route, because a client
 * that hides a button is not a permission (memory
 * reference_parse_time_wren_user_is_always_empty — the whole of b521's bug).
 *
 * ── NO CHILD DATA ──────────────────────────────────────────────────────────
 * Nothing in this file selects from children, observations, diary, medicine,
 * incidents or safeguarding. Rooms, staff, the CPD article and the rota only —
 * which is what lets /api/cpd-programme onto the HR portal's allow-list.
 */

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager', 'owner'];
const STATUSES = ['planned', 'held', 'minutes_written'];
const HAPPENED = ['held', 'minutes_written'];

// ── Dates ───────────────────────────────────────────────────────────────────
// pg hands a DATE back as LOCAL midnight, so toISOString() shifts it a day west
// of UTC. Local getters only (reference_pg_date_ymd_trap), same as b262's route.
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function toDate(v) {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const [y, m, d] = String(v).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(v, n) { const d = toDate(v); d.setDate(d.getDate() + n); return d; }
/** ISO weekday, 1=Mon … 7=Sun. */
function isoDow(v) { const g = toDate(v).getDay(); return g === 0 ? 7 : g; }
/** Mon–Fri only: the nursery does not open at the weekend. */
function addWorkingDays(v, n) {
  let d = toDate(v), left = n;
  while (left > 0) { d = addDays(d, 1); if (isoDow(d) <= 5) left--; }
  return d;
}
function niceDate(v) {
  try {
    return toDate(v).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  } catch (_) { return String(v).slice(0, 10); }
}
function hhmm(t) { return t ? String(t).slice(0, 5) : null; }

/** A real number or null. NEVER Number(x) — see the note in scopeFor. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Who is asking ───────────────────────────────────────────────────────────
/**
 * req.user is the decoded JWT and NOTHING ELSE — authenticate() in
 * src/middleware/auth.js sets `req.user = decoded`. A Wren token carries id,
 * role and aud; it does NOT carry room_id. Every scope decision below turns on
 * the room, so the room has to come from ladn.staff, which is also the honest
 * place to read the ROLE from: a token minted before somebody was made a room
 * leader would otherwise keep them a practitioner until it expired.
 *
 * Same shape as `who()` in src/routes/briefings.js, for the same reason. One
 * query per request; if the staff row has gone, fall back to the token so an
 * ex-member of staff gets a clean "no room" rather than a 500.
 */
async function actorFor(db, user) {
  const id = num(user && user.id);
  if (id === null) return { id: null, role: null, room_id: null };
  try {
    const { rows } = await db.query(
      `SELECT id, role, room_id, is_active FROM staff WHERE id = $1`, [id]);
    if (rows.length) {
      return {
        id, role: rows[0].role || (user && user.role) || null,
        room_id: num(rows[0].room_id),
        is_active: rows[0].is_active !== false,
        token_role: user && user.role,
      };
    }
  } catch (_) { /* fall through to the token */ }
  return { id, role: (user && user.role) || null, room_id: null, is_active: true, token_role: user && user.role };
}

// ── Scope ───────────────────────────────────────────────────────────────────
const isManagerLevel = (user) => !!user && MANAGER_ROLES.includes(String(user.role || ''));
const isRoomLeader   = (user) => !!user && String(user.role || '') === 'room_leader';

/**
 * What this person may see and change.
 *
 * `me` is in here so the page can answer "is this action mine" without reading
 * a role or an id off anything it guessed at — every decision the UI makes
 * comes from this object, and every one of them is re-made on the server.
 *
 * @returns {{me:number|null, level:'manager'|'room_leader'|'staff', room_id:number|null,
 *            can_read_all:boolean, writable_room_ids:number[]|'all', reason:string|null}}
 */
function scopeFor(user) {
  // Number(null) is 0 and Number.isFinite(0) is true, so the obvious version of
  // this line turns "has no room" into "is in room 0" — the trap recorded in
  // memory project_building_devices_b511. Nothing leaks (room 0 matches no real
  // room), but the page's whole no-room path keys on room_id === null, so a
  // practitioner with no room would get a silently empty screen instead of the
  // sentence telling them to ask a manager. Caught by the b530 harness.
  const roomId = num(user && user.room_id);
  const me = num(user && user.id);
  if (isManagerLevel(user)) {
    return { me, level: 'manager', room_id: roomId, can_read_all: true, writable_room_ids: 'all', reason: null };
  }
  if (isRoomLeader(user)) {
    return {
      me, level: 'room_leader', room_id: roomId, can_read_all: true,
      writable_room_ids: roomId ? [roomId] : [],
      reason: roomId ? null
        : 'You are a room leader with no room on your staff record, so there is no room for you to run a meeting for. Ask a manager to set your room.',
    };
  }
  return {
    me, level: 'staff', room_id: roomId, can_read_all: false, writable_room_ids: [],
    reason: roomId ? null
      : 'Your staff record has no room on it, so Wren does not know whose minutes to show you. Ask a manager to set your room.',
  };
}
function canWrite(user, roomId) {
  const rid = num(roomId);
  if (rid === null) return false;
  const s = scopeFor(user);
  if (s.writable_room_ids === 'all') return true;
  return s.writable_room_ids.includes(rid);
}
function canRead(user, roomId) {
  const rid = num(roomId);
  if (rid === null) return false;
  const s = scopeFor(user);
  return s.can_read_all || (s.room_id !== null && s.room_id === rid);
}

// ── Rooms, leaders and the expected list ────────────────────────────────────
async function rooms(db) {
  const { rows } = await db.query(
    `SELECT id, name, coalesce(display_name, name) AS display_name FROM rooms ORDER BY id`);
  return rows;
}

/** The room's leader — who a new meeting defaults to. Lowest id if there are two. */
async function defaultLeaderFor(db, roomId) {
  const { rows } = await db.query(
    `SELECT id FROM staff WHERE is_active = true AND role = 'room_leader' AND room_id = $1 ORDER BY id LIMIT 1`,
    [roomId]);
  return rows.length ? Number(rows[0].id) : null;
}

/** Every active room leader with a room — who the nudges go to. */
async function leadersByRoom(db) {
  const { rows } = await db.query(
    `SELECT room_id, id FROM staff
      WHERE is_active = true AND role = 'room_leader' AND room_id IS NOT NULL ORDER BY room_id, id`);
  const m = new Map();
  for (const r of rows) if (!m.has(r.room_id)) m.set(Number(r.room_id), Number(r.id));
  return m;
}

/**
 * Who is expected at a meeting in this room on this day.
 *
 * The rota first — ladn.rota_shifts is the published plan, and "who is in that
 * day" is exactly what it knows. Anyone marked absent or an unclaimed open
 * shift is not a person. If the rota has nothing for that room and day (no week
 * published yet), fall back to everybody whose staff record says they are in
 * the room, which is never wrong, only broader.
 */
async function expectedAttendees(db, roomId, date) {
  const { rows: rota } = await db.query(
    `SELECT DISTINCT s.id
       FROM rota_shifts rs
       JOIN staff s ON s.id = rs.staff_id
      WHERE rs.room_id = $1 AND rs.shift_date = $2
        AND coalesce(rs.is_absent, false) = false
        AND coalesce(rs.is_open, false) = false
        AND s.is_active = true AND coalesce(s.role, '') <> 'parent'
      ORDER BY s.id`, [roomId, ymd(toDate(date))]);
  if (rota.length) return { staff_ids: rota.map(r => Number(r.id)), from_rota: true };

  const { rows: byRoom } = await db.query(
    `SELECT id FROM staff
      WHERE is_active = true AND room_id = $1 AND coalesce(role, '') <> 'parent' ORDER BY id`, [roomId]);
  return { staff_ids: byRoom.map(r => Number(r.id)), from_rota: false };
}

// ── The CPD article that is the meeting's first agenda item ─────────────────
/**
 * b262 resolves "which article does this week's meeting discuss" from
 * ladn.school_terms, and that maths (half-terms of 8/7/6/5/7/8 weeks, week
 * membership by overlap) is proved and tested there. It is required LAZILY from
 * the route module rather than copied here: a second copy of the term
 * arithmetic is the duplicate Toby's one-place rule exists to stop, and a lazy
 * require keeps the load order safe in both directions.
 *
 * Returns null — never throws — when there is no term, no theme or no article;
 * a meeting with no CPD article is a perfectly good meeting.
 */
async function cpdAgendaArticle(db, date) {
  try {
    const cpd = require('../routes/cpd-programme');
    if (typeof cpd.meetingArticleFor !== 'function') return null;
    return await cpd.meetingArticleFor(db, date);
  } catch (e) {
    return null;
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────
const MEETING_COLS = `
  m.id, m.room_id, rm.name AS room_name, m.meeting_date, m.start_time, m.status,
  m.theme_id, m.article_id, m.led_by, m.discussion, m.changing_what,
  m.is_evaluation, m.held_at, m.minutes_written_at, m.auto_created,
  m.cancelled_at, m.cancelled_reason, m.created_at, m.updated_at,
  t.title AS theme_title, a.title AS article_title, a.week_no AS article_week,
  ldr.first_name || ' ' || ldr.last_name AS led_by_name,
  (SELECT count(*)::int FROM cpd_room_meeting_attendees x WHERE x.meeting_id = m.id)                      AS expected_count,
  (SELECT count(*)::int FROM cpd_room_meeting_attendees x WHERE x.meeting_id = m.id AND x.attended)       AS attended_count,
  (SELECT count(*)::int FROM cpd_room_meeting_agenda  x WHERE x.meeting_id = m.id)                        AS agenda_count,
  (SELECT count(*)::int FROM cpd_room_meeting_actions x WHERE x.meeting_id = m.id)                        AS action_count,
  (SELECT count(*)::int FROM cpd_room_meeting_actions x WHERE x.meeting_id = m.id AND x.done_at IS NULL)  AS actions_open,
  (SELECT count(*)::int FROM cpd_room_meeting_reads   x WHERE x.meeting_id = m.id)                        AS read_count`;

const MEETING_FROM = `
  FROM cpd_room_meetings m
  JOIN rooms rm ON rm.id = m.room_id
  LEFT JOIN cpd_themes t ON t.id = m.theme_id
  LEFT JOIN cpd_theme_articles a ON a.id = m.article_id
  LEFT JOIN staff ldr ON ldr.id = m.led_by`;

function shapeMeeting(row, user) {
  return {
    ...row,
    meeting_date: ymd(toDate(row.meeting_date)),
    start_time: hhmm(row.start_time),
    can_edit: canWrite(user, row.room_id),
    is_my_room: scopeFor(user).room_id === num(row.room_id),
    minutes_overdue: minutesOverdue(row),
  };
}

/** Has this meeting been held with the minutes still unwritten past the 2 working days? */
function minutesOverdue(row, today) {
  if (row.status !== 'held') return false;
  const due = addWorkingDays(row.meeting_date, 2);
  return toDate(today || new Date()) > due;
}

async function listMeetings(db, user, q = {}) {
  const s = scopeFor(user);
  const where = [], vals = [];
  if (!s.can_read_all) {
    if (s.room_id === null) return { meetings: [], scope: s };
    vals.push(s.room_id); where.push(`m.room_id = $${vals.length}`);
  }
  if (q.room_id) {
    const rid = parseInt(q.room_id, 10);
    if (!canRead(user, rid)) return { meetings: [], scope: s, note: 'That room is not yours to read.' };
    vals.push(rid); where.push(`m.room_id = $${vals.length}`);
  }
  if (q.from)   { vals.push(ymd(toDate(q.from))); where.push(`m.meeting_date >= $${vals.length}`); }
  if (q.to)     { vals.push(ymd(toDate(q.to)));   where.push(`m.meeting_date <= $${vals.length}`); }
  if (q.status && STATUSES.includes(q.status)) { vals.push(q.status); where.push(`m.status = $${vals.length}`); }
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 60));

  const { rows } = await db.query(
    `SELECT ${MEETING_COLS},
            (SELECT count(*)::int FROM cpd_room_meeting_reads x
              WHERE x.meeting_id = m.id AND x.staff_id = $${vals.length + 1}) AS read_by_me
     ${MEETING_FROM}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY m.meeting_date DESC, m.id DESC LIMIT ${limit}`,
    [...vals, user.id]);
  return { meetings: rows.map(r => ({ ...shapeMeeting(r, user), read_by_me: !!r.read_by_me })), scope: s };
}

async function getMeeting(db, user, id) {
  const { rows } = await db.query(`SELECT ${MEETING_COLS} ${MEETING_FROM} WHERE m.id = $1`, [id]);
  if (!rows.length) return null;
  const row = rows[0];
  if (!canRead(user, row.room_id)) return { forbidden: true, room_id: row.room_id };

  const [agenda, attendees, actions, reads] = await Promise.all([
    db.query(
      `SELECT g.id, g.position, g.source, g.article_id, g.title, g.notes, g.created_by, g.created_at,
              a.week_no AS article_week, a.minutes AS article_minutes, a.slug AS article_slug,
              a.practice_point AS article_practice_point
         FROM cpd_room_meeting_agenda g
         LEFT JOIN cpd_theme_articles a ON a.id = g.article_id
        WHERE g.meeting_id = $1 ORDER BY g.position, g.id`, [id]),
    db.query(
      `SELECT x.staff_id, x.attended, x.absence_reason, x.from_rota,
              s.first_name || ' ' || s.last_name AS name, s.job_title, s.role
         FROM cpd_room_meeting_attendees x JOIN staff s ON s.id = x.staff_id
        WHERE x.meeting_id = $1 ORDER BY s.first_name, s.last_name`, [id]),
    db.query(
      `SELECT c.id, c.what, c.owner_id, c.due_date, c.done_at, c.done_by,
              o.first_name || ' ' || o.last_name AS owner_name
         FROM cpd_room_meeting_actions c LEFT JOIN staff o ON o.id = c.owner_id
        WHERE c.meeting_id = $1 ORDER BY c.due_date NULLS LAST, c.id`, [id]),
    db.query(
      `SELECT r.staff_id, r.read_at, s.first_name || ' ' || s.last_name AS name
         FROM cpd_room_meeting_reads r JOIN staff s ON s.id = r.staff_id
        WHERE r.meeting_id = $1 ORDER BY r.read_at`, [id]),
  ]);

  const meeting = shapeMeeting(row, user);
  return {
    meeting,
    agenda: agenda.rows,
    attendees: attendees.rows,
    actions: actions.rows.map(a => ({ ...a, due_date: a.due_date ? ymd(toDate(a.due_date)) : null })),
    reads: reads.rows,
    read_by_me: reads.rows.some(r => num(r.staff_id) === num(user.id)),
    can_confirm_read: row.status === 'minutes_written'
      && (scopeFor(user).room_id === num(row.room_id) || canWrite(user, row.room_id)),
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────
/**
 * Schedule a meeting. Idempotent on (room_id, meeting_date) — b262's UNIQUE —
 * so the rhythm sweep can run every thirty seconds and a leader pressing the
 * button twice gets one meeting.
 *
 * `auto` marks a row Wren created rather than a person, which is what makes
 * "Wren put this in your diary" honest on the page.
 */
async function createMeeting(db, actor, { room_id, meeting_date, start_time, led_by, auto = false }) {
  const roomId = parseInt(room_id, 10);
  if (!Number.isFinite(roomId)) throw badRequest('Which room is the meeting for?');
  const date = ymd(toDate(meeting_date || new Date()));
  const leader = Number.isFinite(parseInt(led_by, 10))
    ? parseInt(led_by, 10)
    : (await defaultLeaderFor(db, roomId));

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO cpd_room_meetings
         (room_id, meeting_date, start_time, status, led_by, auto_created, created_by, updated_by, updated_at)
       VALUES ($1,$2,$3,'planned',$4,$5,$6,$6, now())
       ON CONFLICT (room_id, meeting_date) DO UPDATE
         SET start_time = coalesce(cpd_room_meetings.start_time, EXCLUDED.start_time)
       RETURNING id, status, (xmax = 0) AS inserted`,
      [roomId, date, start_time || null, leader, !!auto, actor && actor.id ? actor.id : null]);
    const id = Number(rows[0].id);
    const fresh = rows[0].inserted;
    await client.query('COMMIT');

    // Both are idempotent and neither is worth failing the meeting for.
    if (fresh) {
      await ensureCpdAgendaItem(db, id, date).catch(() => {});
      await ensureExpected(db, id, roomId, date, actor).catch(() => {});
    }
    return { id, created: fresh };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** The week's CPD article, added as agenda item 10. One per meeting, ever. */
async function ensureCpdAgendaItem(db, meetingId, date) {
  const art = await cpdAgendaArticle(db, date);
  if (!art || !art.article) return null;
  const { rows } = await db.query(
    `INSERT INTO cpd_room_meeting_agenda (meeting_id, position, source, article_id, title, notes)
     VALUES ($1, 10, 'cpd_article', $2, $3, $4)
     ON CONFLICT (meeting_id, article_id) WHERE article_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [meetingId, art.article.id,
     `This week's CPD read: ${art.article.title}`,
     art.article.practice_point || null]);
  if (rows.length) {
    await db.query(
      `UPDATE cpd_room_meetings SET theme_id = coalesce(theme_id, $2), article_id = coalesce(article_id, $3)
        WHERE id = $1`, [meetingId, art.theme ? art.theme.id : null, art.article.id]);
  }
  return rows.length ? Number(rows[0].id) : null;
}

/** Pre-fill the expected list from the rota. Never removes a row somebody ticked. */
async function ensureExpected(db, meetingId, roomId, date, actor) {
  const { staff_ids, from_rota } = await expectedAttendees(db, roomId, date);
  let added = 0;
  for (const sid of staff_ids) {
    const { rowCount } = await db.query(
      `INSERT INTO cpd_room_meeting_attendees (meeting_id, staff_id, attended, from_rota, recorded_by)
       VALUES ($1,$2,true,$3,$4) ON CONFLICT DO NOTHING`,
      [meetingId, sid, from_rota, actor && actor.id ? actor.id : null]);
    added += rowCount;
  }
  return { added, from_rota, expected: staff_ids.length };
}

function badRequest(message) { const e = new Error(message); e.status = 400; return e; }
function forbidden(message) { const e = new Error(message); e.status = 403; return e; }

/**
 * Change a meeting: date, time, leader, the minutes, the status.
 * The status ladder is planned → held → minutes written, and the one rule that
 * matters is the last rung: the minutes cannot be called written until there is
 * something under "discussed" and under "decided", and until every absence has
 * a reason. b262 enforced the first half with a NOT NULL and a route check; the
 * second half is Toby's ask ("all the staff were attending").
 */
async function updateMeeting(db, actor, id, patch = {}) {
  const { rows: cur } = await db.query(
    `SELECT id, room_id, status, meeting_date, discussion, changing_what, held_at FROM cpd_room_meetings WHERE id = $1`, [id]);
  if (!cur.length) return null;
  const m = cur[0];
  if (!canWrite(actor, m.room_id)) {
    throw forbidden('Only this room\'s leader, or a manager, can change this meeting. You can read it.');
  }

  const set = [], vals = [];
  const put = (col, v) => { vals.push(v); set.push(`${col} = $${vals.length}`); };

  if (patch.meeting_date) put('meeting_date', ymd(toDate(patch.meeting_date)));
  if (patch.start_time !== undefined) put('start_time', patch.start_time || null);
  if (patch.led_by !== undefined) put('led_by', Number.isFinite(parseInt(patch.led_by, 10)) ? parseInt(patch.led_by, 10) : null);
  if (patch.discussion !== undefined) put('discussion', String(patch.discussion || '').trim() || null);
  if (patch.changing_what !== undefined) put('changing_what', String(patch.changing_what || '').trim() || null);
  if (patch.is_evaluation !== undefined) put('is_evaluation', !!patch.is_evaluation);
  if (patch.cancelled_reason !== undefined) {
    const why = String(patch.cancelled_reason || '').trim();
    put('cancelled_reason', why || null);
    put('cancelled_at', why ? new Date() : null);
  }

  let status = m.status;
  if (patch.status !== undefined) {
    status = String(patch.status);
    if (!STATUSES.includes(status)) throw badRequest(`Status must be one of ${STATUSES.join(', ')}.`);
    const discussion = patch.discussion !== undefined ? String(patch.discussion || '').trim() : (m.discussion || '');
    const changing  = patch.changing_what !== undefined ? String(patch.changing_what || '').trim() : (m.changing_what || '');
    if (status === 'minutes_written') {
      if (!discussion) throw badRequest('Write what was discussed before marking the minutes written.');
      if (!changing) {
        throw badRequest('Write what the room decided — what you are doing differently. This is the part an inspector asks about.');
      }
      const { rows: noReason } = await db.query(
        `SELECT count(*)::int AS n FROM cpd_room_meeting_attendees
          WHERE meeting_id = $1 AND attended = false AND coalesce(btrim(absence_reason), '') = ''`, [id]);
      if (noReason[0].n > 0) {
        throw badRequest(`${noReason[0].n} ${noReason[0].n === 1 ? 'person is' : 'people are'} marked absent with no reason. `
          + 'Say why they were not there, then mark the minutes written.');
      }
      put('minutes_written_at', new Date());
      put('held_at', m.held_at || new Date());
    }
    if (status === 'held' && !m.held_at) put('held_at', new Date());
    if (status === 'planned') { put('held_at', null); put('minutes_written_at', null); }
    put('status', status);
  }

  if (!set.length) return { id, unchanged: true };
  vals.push(actor && actor.id ? actor.id : null); set.push(`updated_by = $${vals.length}`);
  set.push('updated_at = now()');
  vals.push(id);
  const { rows } = await db.query(
    `UPDATE cpd_room_meetings SET ${set.join(', ')} WHERE id = $${vals.length} RETURNING id, status`, vals);
  return rows[0];
}

async function addAgendaItem(db, actor, meetingId, { title, notes, position }) {
  const m = await roomOf(db, meetingId);
  if (!m) return null;
  if (!canWrite(actor, m.room_id)) throw forbidden('Only this room\'s leader, or a manager, can add an agenda item.');
  const t = String(title || '').trim();
  if (!t) throw badRequest('An agenda item needs a few words.');
  const { rows } = await db.query(
    `INSERT INTO cpd_room_meeting_agenda (meeting_id, position, source, title, notes, created_by)
     VALUES ($1,$2,'manual',$3,$4,$5) RETURNING id, position, source, title, notes`,
    [meetingId, Number.isFinite(parseInt(position, 10)) ? parseInt(position, 10) : 50,
     t.slice(0, 400), String(notes || '').trim() || null, actor.id]);
  return rows[0];
}

/** The auto-added CPD article cannot be deleted — it is the programme, not a note. */
async function removeAgendaItem(db, actor, meetingId, itemId) {
  const m = await roomOf(db, meetingId);
  if (!m) return null;
  if (!canWrite(actor, m.room_id)) throw forbidden('Only this room\'s leader, or a manager, can remove an agenda item.');
  const { rows } = await db.query(
    `DELETE FROM cpd_room_meeting_agenda
      WHERE id = $1 AND meeting_id = $2 AND source = 'manual' RETURNING id`, [itemId, meetingId]);
  if (!rows.length) {
    const { rows: still } = await db.query(
      `SELECT source FROM cpd_room_meeting_agenda WHERE id = $1 AND meeting_id = $2`, [itemId, meetingId]);
    if (still.length) throw badRequest('This week\'s CPD read is part of the programme and stays on the agenda.');
    return null;
  }
  return { removed: Number(rows[0].id) };
}

/**
 * Who came. The whole list in one call: every row given is set, every row not
 * given is left alone, so two leaders ticking at once cannot wipe each other.
 */
async function setAttendance(db, actor, meetingId, list) {
  const m = await roomOf(db, meetingId);
  if (!m) return null;
  if (!canWrite(actor, m.room_id)) throw forbidden('Only this room\'s leader, or a manager, can record attendance.');
  if (!Array.isArray(list) || !list.length) throw badRequest('Nobody was sent to record.');

  let written = 0;
  for (const raw of list) {
    const sid = parseInt(raw && raw.staff_id, 10);
    if (!Number.isFinite(sid)) continue;
    const attended = raw.attended === undefined ? true : !!raw.attended;
    const reason = attended ? null : (String(raw.absence_reason || '').trim() || null);
    const { rowCount } = await db.query(
      `INSERT INTO cpd_room_meeting_attendees (meeting_id, staff_id, attended, absence_reason, recorded_by, recorded_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (meeting_id, staff_id) DO UPDATE
         SET attended = EXCLUDED.attended, absence_reason = EXCLUDED.absence_reason,
             recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
      [meetingId, sid, attended, reason, actor.id]);
    written += rowCount;
  }
  return { written };
}

async function addAction(db, actor, meetingId, { what, owner_id, due_date }) {
  const m = await roomOf(db, meetingId);
  if (!m) return null;
  if (!canWrite(actor, m.room_id)) throw forbidden('Only this room\'s leader, or a manager, can add an action.');
  const w = String(what || '').trim();
  if (!w) throw badRequest('An action needs a few words saying what will happen.');
  const { rows } = await db.query(
    `INSERT INTO cpd_room_meeting_actions (meeting_id, what, owner_id, due_date, created_by)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, what, owner_id, due_date, done_at`,
    [meetingId, w.slice(0, 1000),
     Number.isFinite(parseInt(owner_id, 10)) ? parseInt(owner_id, 10) : null,
     due_date ? ymd(toDate(due_date)) : null, actor.id]);
  const a = rows[0];
  return { ...a, due_date: a.due_date ? ymd(toDate(a.due_date)) : null };
}

/** The owner may tick off their own action; the leader and a manager may do anything. */
async function updateAction(db, actor, meetingId, actionId, patch = {}) {
  const { rows: cur } = await db.query(
    `SELECT c.id, c.owner_id, m.room_id FROM cpd_room_meeting_actions c
       JOIN cpd_room_meetings m ON m.id = c.meeting_id
      WHERE c.id = $1 AND c.meeting_id = $2`, [actionId, meetingId]);
  if (!cur.length) return null;
  const a = cur[0];
  const mine = Number(a.owner_id) === Number(actor.id);
  const writer = canWrite(actor, a.room_id);
  if (!writer && !mine) throw forbidden('Only the action\'s owner, this room\'s leader or a manager can change it.');
  if (!writer && (patch.what !== undefined || patch.owner_id !== undefined || patch.due_date !== undefined)) {
    throw forbidden('You can tick your own action off, but only the room leader or a manager can reword or reassign it.');
  }

  const set = [], vals = [];
  const put = (col, v) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
  if (patch.what !== undefined) {
    const w = String(patch.what || '').trim();
    if (!w) throw badRequest('An action needs a few words.');
    put('what', w.slice(0, 1000));
  }
  if (patch.owner_id !== undefined) put('owner_id', Number.isFinite(parseInt(patch.owner_id, 10)) ? parseInt(patch.owner_id, 10) : null);
  if (patch.due_date !== undefined) put('due_date', patch.due_date ? ymd(toDate(patch.due_date)) : null);
  if (patch.done !== undefined) {
    put('done_at', patch.done ? new Date() : null);
    put('done_by', patch.done ? actor.id : null);
  }
  if (!set.length) return { id: actionId, unchanged: true };
  vals.push(actionId);
  const { rows } = await db.query(
    `UPDATE cpd_room_meeting_actions SET ${set.join(', ')} WHERE id = $${vals.length}
      RETURNING id, what, owner_id, due_date, done_at`, vals);
  const r = rows[0];
  return { ...r, due_date: r.due_date ? ymd(toDate(r.due_date)) : null };
}

/** "I've read these." Own room only, and only once the minutes exist. */
async function confirmRead(db, actor, meetingId) {
  const { rows } = await db.query(
    `SELECT id, room_id, status FROM cpd_room_meetings WHERE id = $1`, [meetingId]);
  if (!rows.length) return null;
  const m = rows[0];
  const s = scopeFor(actor);
  if (!(s.room_id === Number(m.room_id) || canWrite(actor, m.room_id))) {
    throw forbidden('You can only confirm you have read your own room\'s minutes.');
  }
  if (m.status !== 'minutes_written') {
    throw badRequest('There are no minutes to read yet — this meeting has not been written up.');
  }
  await db.query(
    `INSERT INTO cpd_room_meeting_reads (meeting_id, staff_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [meetingId, actor.id]);
  const { rows: n } = await db.query(
    `SELECT count(*)::int AS read_count FROM cpd_room_meeting_reads WHERE meeting_id = $1`, [meetingId]);
  return { read: true, read_count: n[0].read_count };
}

async function roomOf(db, meetingId) {
  const { rows } = await db.query(`SELECT id, room_id, status FROM cpd_room_meetings WHERE id = $1`, [meetingId]);
  return rows.length ? rows[0] : null;
}

// ── The rhythm, per room ────────────────────────────────────────────────────
async function getSchedule(db) {
  const { rows } = await db.query(
    `SELECT sc.room_id, rm.name AS room_name, sc.weekday, sc.start_time, sc.every_n_weeks,
            sc.is_active, sc.updated_at,
            (SELECT id FROM staff WHERE is_active = true AND role = 'room_leader' AND room_id = sc.room_id ORDER BY id LIMIT 1) AS leader_id,
            (SELECT first_name || ' ' || last_name FROM staff
              WHERE is_active = true AND role = 'room_leader' AND room_id = sc.room_id ORDER BY id LIMIT 1) AS leader_name
       FROM cpd_room_meeting_schedule sc JOIN rooms rm ON rm.id = sc.room_id
      ORDER BY sc.room_id`);
  return rows.map(r => ({ ...r, start_time: hhmm(r.start_time) }));
}

const DAY_NAME = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday' };

async function setSchedule(db, actor, roomId, patch = {}) {
  if (!canWrite(actor, roomId)) {
    throw forbidden('Only this room\'s leader, or a manager, can change when the room meets.');
  }
  const set = [], vals = [];
  const put = (col, v) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
  if (patch.weekday !== undefined) {
    const w = parseInt(patch.weekday, 10);
    if (!(w >= 1 && w <= 5)) throw badRequest('The meeting day has to be a weekday — the nursery is closed at the weekend.');
    put('weekday', w);
  }
  if (patch.start_time !== undefined) {
    const t = String(patch.start_time || '').trim();
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(t)) throw badRequest('Give a start time like 13:00.');
    put('start_time', t);
  }
  if (patch.every_n_weeks !== undefined) {
    const n = parseInt(patch.every_n_weeks, 10);
    if (!(n >= 1 && n <= 4)) throw badRequest('Meet every 1 to 4 weeks.');
    put('every_n_weeks', n);
  }
  if (patch.is_active !== undefined) put('is_active', !!patch.is_active);
  if (!set.length) return { room_id: roomId, unchanged: true };
  vals.push(actor.id); set.push(`updated_by = $${vals.length}`);
  set.push('updated_at = now()');
  vals.push(roomId);
  const { rows } = await db.query(
    `UPDATE cpd_room_meeting_schedule SET ${set.join(', ')} WHERE room_id = $${vals.length}
      RETURNING room_id, weekday, start_time, every_n_weeks, is_active`, vals);
  if (!rows.length) return null;
  return { ...rows[0], start_time: hhmm(rows[0].start_time) };
}

// ── The Roost panel: held / missed / minutes outstanding, per room ──────────
/**
 * "Missed" is counted, not guessed: it is the number of meeting slots the
 * room's own rhythm says should have happened in the window, minus the ones
 * that did. A room that cancelled every week shows as missed, because Toby's
 * ask is that the leader makes sure they go ahead.
 *
 * The window has a START but no END. A meeting that has HAPPENED is always in
 * the past, so no upper bound can hide one — and without it `planned_ahead`
 * ("how many has this room got in the diary") was dead code, because the outer
 * WHERE had already thrown away every future date. Found by the b530 harness.
 */
async function overview(db, { weeks = 8, today } = {}) {
  const end = toDate(today || new Date());
  const start = addDays(end, -7 * weeks + 1);
  const sched = await getSchedule(db);
  const { rows } = await db.query(
    `SELECT m.room_id,
            count(*) FILTER (WHERE m.status IN ('held','minutes_written'))::int AS held,
            count(*) FILTER (WHERE m.status = 'held')::int                      AS minutes_outstanding,
            count(*) FILTER (WHERE m.status = 'planned' AND m.meeting_date >= $2)::int AS planned_ahead,
            count(*) FILTER (WHERE m.status = 'planned' AND m.meeting_date <  $2)::int AS planned_gone_by,
            max(m.meeting_date) FILTER (WHERE m.status IN ('held','minutes_written'))  AS last_held,
            sum(CASE WHEN m.status IN ('held','minutes_written')
                     THEN (SELECT count(*) FROM cpd_room_meeting_attendees x WHERE x.meeting_id = m.id AND x.attended)
                     ELSE 0 END)::int                                            AS attendances,
            sum(CASE WHEN m.status IN ('held','minutes_written')
                     THEN (SELECT count(*) FROM cpd_room_meeting_attendees x WHERE x.meeting_id = m.id)
                     ELSE 0 END)::int                                            AS expected_total
       FROM cpd_room_meetings m
      WHERE m.meeting_date >= $1
      GROUP BY m.room_id`,
    [ymd(start), ymd(end)]);
  const byRoom = new Map(rows.map(r => [Number(r.room_id), r]));

  const roomsOut = sched.map(s => {
    const r = byRoom.get(Number(s.room_id)) || {};
    const held = r.held || 0;
    const slots = s.is_active ? Math.floor(weeks / s.every_n_weeks) : 0;
    const missed = Math.max(0, slots - held);
    const lastHeld = r.last_held ? ymd(toDate(r.last_held)) : null;
    const daysSince = lastHeld ? Math.round((toDate(end) - toDate(lastHeld)) / 86400000) : null;
    return {
      room_id: Number(s.room_id), room_name: s.room_name,
      leader_id: s.leader_id, leader_name: s.leader_name,
      rhythm: s.is_active ? `${DAY_NAME[s.weekday] || 'Wednesday'}s ${s.start_time}${s.every_n_weeks > 1 ? `, every ${s.every_n_weeks} weeks` : ''}` : 'Not scheduled',
      is_active: s.is_active,
      held, slots, missed,
      minutes_outstanding: r.minutes_outstanding || 0,
      planned_ahead: r.planned_ahead || 0,
      planned_gone_by: r.planned_gone_by || 0,
      last_held: lastHeld,
      days_since_held: daysSince,
      overdue: !!s.is_active && (daysSince === null || daysSince > 14),
      attendance_pct: r.expected_total ? Math.round((r.attendances / r.expected_total) * 100) : null,
    };
  });
  return {
    window_weeks: weeks, from: ymd(start), to: ymd(end),
    rooms: roomsOut,
    totals: {
      held: roomsOut.reduce((a, r) => a + r.held, 0),
      missed: roomsOut.reduce((a, r) => a + r.missed, 0),
      minutes_outstanding: roomsOut.reduce((a, r) => a + r.minutes_outstanding, 0),
      rooms_overdue: roomsOut.filter(r => r.overdue).length,
    },
  };
}

/** Rooms that have gone more than `days` without a HELD meeting. The one definition. */
async function roomsWithoutAMeeting(db, { days = 14, today } = {}) {
  const end = toDate(today || new Date());
  const since = ymd(addDays(end, -days));
  const { rows } = await db.query(
    `SELECT sc.room_id, rm.name AS room_name,
            (SELECT max(meeting_date) FROM cpd_room_meetings m
              WHERE m.room_id = sc.room_id AND m.status IN ('held','minutes_written')) AS last_held
       FROM cpd_room_meeting_schedule sc JOIN rooms rm ON rm.id = sc.room_id
      WHERE sc.is_active = true
      ORDER BY sc.room_id`);
  return rows
    .filter(r => !r.last_held || ymd(toDate(r.last_held)) < since)
    .map(r => ({
      room_id: Number(r.room_id), room_name: r.room_name,
      last_held: r.last_held ? ymd(toDate(r.last_held)) : null,
      days_since: r.last_held ? Math.round((toDate(end) - toDate(r.last_held)) / 86400000) : null,
    }));
}

async function isEnabled(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'room_meetings_enabled'`);
    return !rows.length || String(rows[0].value).toLowerCase() === 'true';
  } catch (_) { return false; }
}

module.exports = {
  MANAGER_ROLES, STATUSES, HAPPENED, DAY_NAME,
  num, ymd, toDate, addDays, isoDow, addWorkingDays, niceDate, hhmm,
  actorFor, isManagerLevel, isRoomLeader, scopeFor, canRead, canWrite,
  rooms, defaultLeaderFor, leadersByRoom, expectedAttendees,
  listMeetings, getMeeting, minutesOverdue,
  createMeeting, updateMeeting, ensureCpdAgendaItem, ensureExpected,
  addAgendaItem, removeAgendaItem, setAttendance, addAction, updateAction, confirmRead,
  getSchedule, setSchedule, overview, roomsWithoutAMeeting, isEnabled,
};
