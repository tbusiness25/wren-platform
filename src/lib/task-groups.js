'use strict';
// ===========================================================================
// task-groups.js — b501 (Tasks v2): "assign to one person, several people, a role, a room, or the whole team".
//
// A group is resolved to PEOPLE at the moment it is assigned, so the record shows exactly who was asked
// (task_assignees, one row each, with `via` saying how: person | role:<role> | room:<id> | team) and a later
// joiner is not silently pulled into old work. The spec that was asked for is kept on tasks.assignee_spec.
//
// Scope (unchanged rule, now explicit):
//   manager / deputy_manager / admin  → anyone, any role, any room, the whole team
//   room_leader                       → people and rooms, but only their own room (no roles, no team)
//   everyone else                     → themselves only
// ===========================================================================

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
// Roles that are people who can be given work. Parents and the external accountant are not "the team".
const NOT_TEAM = ['parent', 'accountant'];

const ROLE_LABELS = {
  manager: 'Managers', deputy_manager: 'Deputy managers', admin: 'Admins', room_leader: 'Room leaders',
  senior_practitioner: 'Senior practitioners', practitioner: 'Practitioners', apprentice: 'Apprentices', cook: 'Kitchen',
};

const ints = v => (Array.isArray(v) ? v : (v == null || v === '' ? [] : String(v).split(',')))
  .map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0);

/** Normalise whatever the client sent into {people, roles, rooms, team}. Legacy bodies (assignees / assignee_ids / owner_staff_id) still work. */
function parseSpec(body) {
  const b = body || {};
  const a = (b.assign && typeof b.assign === 'object') ? b.assign : {};
  const legacy = b.assignees != null ? b.assignees : (b.assignee_ids != null ? b.assignee_ids : null);
  const present = legacy != null || b.assign != null;
  const people = ints(a.people != null ? a.people : legacy);
  const roles = (Array.isArray(a.roles) ? a.roles : (a.roles ? String(a.roles).split(',') : []))
    .map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const rooms = ints(a.rooms);
  const team = a.team === true || a.team === 'true' || a.team === 1;
  return { present, spec: { people: [...new Set(people)], roles: [...new Set(roles)], rooms: [...new Set(rooms)], team } };
}

async function myRoomMembers(db, me) {
  const { rows } = await db.query(
    `SELECT s.id FROM staff s WHERE s.is_active = true AND s.room_id IS NOT NULL AND s.room_id = (SELECT room_id FROM staff WHERE id = $1)`, [me]);
  return rows.map(r => Number(r.id));
}

/**
 * Resolve a spec for this requester. Returns { ids, via, error?, status?, blocked? }.
 * `ids` keeps the order people → rooms → roles → team, first mention wins, so ids[0] is the owner.
 */
async function resolve(db, req, spec) {
  const role = req.user && req.user.role;
  const me = Number(req.user && req.user.id);
  const isMgr = MANAGER_ROLES.includes(role);
  const isLeader = role === 'room_leader';
  const out = { ids: [], via: {} };
  const add = (id, via) => { id = Number(id); if (!out.via[id]) { out.via[id] = via; out.ids.push(id); } };

  if (!isMgr) {
    if ((spec.roles && spec.roles.length) || spec.team) {
      return { ids: [], via: {}, status: 403,
        error: isLeader ? 'A room leader can assign to people and their own room, not to a role or the whole team'
                        : 'You can only create tasks for yourself' };
    }
  }

  // people
  for (const id of spec.people) add(id, 'person');

  // rooms
  if (spec.rooms.length) {
    const { rows } = await db.query(
      `SELECT id, room_id FROM staff WHERE is_active = true AND role <> ALL($1::text[]) AND room_id = ANY($2::int[]) ORDER BY id`, [NOT_TEAM, spec.rooms]);
    for (const r of rows) add(r.id, 'room:' + r.room_id);
  }
  // roles
  if (spec.roles.length) {
    const { rows } = await db.query(
      `SELECT id, role FROM staff WHERE is_active = true AND role <> ALL($1::text[]) AND role = ANY($2::text[]) ORDER BY id`, [NOT_TEAM, spec.roles]);
    for (const r of rows) add(r.id, 'role:' + r.role);
  }
  // whole team
  if (spec.team) {
    const { rows } = await db.query(`SELECT id FROM staff WHERE is_active = true AND role <> ALL($1::text[]) ORDER BY id`, [NOT_TEAM]);
    for (const r of rows) add(r.id, 'team');
  }

  // scope check
  if (!isMgr) {
    const allowed = new Set([me]);
    if (isLeader) (await myRoomMembers(db, me)).forEach(i => allowed.add(i));
    const blocked = out.ids.filter(i => !allowed.has(i));
    if (blocked.length) {
      return { ids: [], via: {}, status: 403, blocked,
        error: isLeader ? 'A room leader can only assign tasks to staff in their own room' : 'You can only create tasks for yourself' };
    }
  }
  // people who do not exist / are not active staff
  if (out.ids.length) {
    const { rows } = await db.query(`SELECT id FROM staff WHERE id = ANY($1::int[]) AND is_active = true AND role <> ALL($2::text[])`, [out.ids, NOT_TEAM]);
    const ok = new Set(rows.map(r => Number(r.id)));
    const bad = out.ids.filter(i => !ok.has(i));
    if (bad.length) {
      return { ids: [], via: {}, status: 400, error: 'Some of those people are not active staff', blocked: bad };
    }
  }
  return out;
}

/** The groups this requester may target, with live head-counts, for the assign form. */
async function assignableGroups(db, req) {
  const role = req.user && req.user.role;
  const isMgr = MANAGER_ROLES.includes(role);
  const isLeader = role === 'room_leader';
  const { rows: roles } = await db.query(
    `SELECT role, count(*)::int AS n FROM staff WHERE is_active = true AND role <> ALL($1::text[]) GROUP BY role ORDER BY role`, [NOT_TEAM]);
  const { rows: rooms } = await db.query(
    `SELECT r.id, r.name, count(s.id)::int AS n FROM rooms r
       LEFT JOIN staff s ON s.room_id = r.id AND s.is_active = true AND s.role <> ALL($1::text[]) GROUP BY r.id, r.name ORDER BY r.name`, [NOT_TEAM]);
  let myRoom = null;
  if (isLeader) { const { rows: [m] } = await db.query(`SELECT room_id FROM staff WHERE id = $1`, [Number(req.user.id)]); myRoom = m && m.room_id; }
  const { rows: [tm] } = await db.query(`SELECT count(*)::int AS n FROM staff WHERE is_active = true AND role <> ALL($1::text[])`, [NOT_TEAM]);
  return {
    can_use_roles: isMgr, can_use_team: isMgr, can_use_rooms: isMgr || (isLeader && !!myRoom),
    roles: isMgr ? roles.map(r => ({ role: r.role, label: ROLE_LABELS[r.role] || r.role, count: r.n })) : [],
    rooms: (isMgr ? rooms : rooms.filter(r => Number(r.id) === Number(myRoom))).map(r => ({ id: r.id, name: r.name, count: r.n })),
    team: isMgr ? { count: tm.n } : null,
  };
}

module.exports = { MANAGER_ROLES, NOT_TEAM, ROLE_LABELS, parseSpec, resolve, assignableGroups };
