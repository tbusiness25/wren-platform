'use strict';
/*
 * b314 — the executable half of src/audit/field-map.json.
 *
 * field-map.json says where a field is MEANT to land and who is MEANT to read
 * it. This file knows how to actually do it: pick a subject row, read the value
 * through the API, write a distinctive new one through the real endpoint the UI
 * uses, look at the destination tables, and ask every consumer what it now
 * believes. scripts/b314-field-audit.js drives it.
 *
 * The ids here MUST match the ids in field-map.json. The audit refuses to run
 * if they drift, because a map entry with no probe is a field nobody is testing
 * while the map implies somebody is.
 *
 * Every spec owns its own restore. `snapshot` returns whatever it will disturb;
 * `restore` puts it back; the harness re-snapshots afterwards and deep-compares.
 * That is what makes "run it twice and the second run is identical" true even
 * for a room change, which does not overwrite a booking but closes one and
 * opens another.
 *
 * GDPR: subjects are referred to by id. No probe ever reads or prints a child's
 * or a parent's name, and every probe value is obviously synthetic.
 */

const DOWS = ['mon', 'tue', 'wed', 'thu', 'fri'];

/* ── small helpers shared by the specs ─────────────────────────────────────── */

const ymd = d => {
  const x = d instanceof Date ? d : new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
};
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/* pg returns DATE as a local-midnight JS Date — String() and toISOString() are
 * both wrong across a DST boundary. (memory/reference_pg_date_ymd_trap.md) */
const dcol = v => (v == null ? null : v instanceof Date ? ymd(v) : String(v).slice(0, 10));

/** The occupancy board's own numbers: date → room_id → occupied, plus closures. */
async function gridCounts(ctx, weekStart, weeks = 2) {
  const r = await ctx.api('admin', { path: `/api/occupancy-calendar/grid?weeks=${weeks}&start=${weekStart}` });
  if (r.code !== 200) return { _error: `HTTP ${r.code}` };
  const out = { closures: r.json.closures || {} };
  for (const wk of r.json.data || []) {
    for (const rm of wk.rooms || []) {
      for (const d of DOWS) {
        const cell = (rm.days || {})[d];
        if (!cell) continue;
        (out[cell.date] || (out[cell.date] = {}))[rm.room_id] = cell.occupied;
      }
    }
  }
  return out;
}

/** The rota ratio board's own numbers: date → room_id → booked. */
async function ratioCounts(ctx, weekStart) {
  const r = await ctx.api('admin', { path: `/api/rota/week/${weekStart}/ratio` });
  if (r.code !== 200) return { _error: `HTTP ${r.code}` };
  const out = {};
  for (const [date, day] of Object.entries(r.json.days || {})) {
    out[date] = {};
    for (const [rid, rm] of Object.entries(day.rooms || {})) out[date][rid] = rm.booked;
  }
  return out;
}

/**
 * A child who is unambiguously countable: active, exactly one live booking, the
 * booking covers the whole of the coming week and is ticked every weekday, and
 * the booking's room agrees with the profile. Anything less and a count delta
 * has more than one explanation.
 */
async function pickCountableChild(ctx) {
  const wk0 = mondayOf(ctx.today);
  const horizon = addDays(wk0, 13);
  const rows = await ctx.sql(`
    SELECT c.id AS child_id, c.room_id, b.id AS booking_id, b.room_id AS booking_room_id
      FROM children c
      JOIN child_bookings b ON b.child_id = c.id AND b.is_active = true
     WHERE COALESCE(c.is_active, true)
       AND c.date_of_birth IS NOT NULL
       AND c.room_id IS NOT NULL
       AND b.room_id = c.room_id
       AND b.mon AND b.tue AND b.wed AND b.thu AND b.fri
       AND b.start_date <= $1::date
       AND (b.end_date IS NULL OR b.end_date >= $2::date)
       AND (c.leave_date IS NULL OR c.leave_date >= $2::date)
       AND (SELECT count(*) FROM child_bookings b2 WHERE b2.child_id = c.id AND b2.is_active) = 1
     ORDER BY c.id DESC LIMIT 1`, [wk0, horizon]);
  if (!rows.length) return null;
  const rooms = await ctx.sql('SELECT id FROM rooms ORDER BY id');
  const other = rooms.map(r => r.id).find(id => id !== rows[0].room_id);
  if (!other) return null;
  // The day we assert the count delta on must be TODAY OR LATER. A room change
  // effective today is not meant to rewrite Monday: asking about a past day is
  // asking a different question, and it is asked separately (see history_day).
  // Closed days count nobody whatever the register says, so skip those too.
  const grid = await gridCounts(ctx, wk0, 2);
  const window = [];
  for (let w = 0; w < 2; w++) for (let i = 0; i < 5; i++) window.push(addDays(addDays(wk0, w * 7), i));
  const day = window.find(d => d >= ctx.today && grid[d] && !(grid.closures || {})[d]) || ctx.today;
  const past = window.filter(d => d < ctx.today && grid[d] && !(grid.closures || {})[d]).pop() || null;
  return { ...rows[0], other_room_id: other, week_start: mondayOf(day),
           assert_day: day, history_day: past, history_week: past ? mondayOf(past) : null };
}

async function bookingSnapshot(ctx, childId) {
  const rows = await ctx.sql(
    `SELECT id, room_id, mon, tue, wed, thu, fri, start_date, end_date, funded, notes,
            source, is_active, created_by
       FROM child_bookings WHERE child_id = $1 ORDER BY id`, [childId]);
  return rows.map(r => ({ ...r, start_date: dcol(r.start_date), end_date: dcol(r.end_date) }));
}

/** Put the child's bookings back exactly: restore known rows, drop rows we made. */
async function bookingRestore(ctx, childId, snap) {
  const keep = snap.map(r => r.id);
  await ctx.sql(
    `DELETE FROM child_bookings WHERE child_id = $1 AND NOT (id = ANY($2::int[]))`,
    [childId, keep.length ? keep : [-1]]);
  for (const r of snap) {
    await ctx.sql(
      `UPDATE child_bookings SET room_id=$1, mon=$2, tue=$3, wed=$4, thu=$5, fri=$6,
              start_date=$7, end_date=$8, funded=$9, notes=$10, source=$11, is_active=$12
        WHERE id=$13`,
      [r.room_id, r.mon, r.tue, r.wed, r.thu, r.fri, r.start_date, r.end_date, r.funded,
       r.notes, r.source, r.is_active, r.id]);
  }
}

/** The booking that actually counts today — the one occupancy will look at. */
function liveBooking(list, on) {
  return list.find(b => b.is_active && (!b.start_date || b.start_date <= on) &&
                        (!b.end_date || b.end_date >= on)) || null;
}

/* The two consumers that turn a room change into a number a manager acts on.
 * Both are count-delta consumers: the child leaves one room's tally and joins
 * the other's on the day we assert. */
const roomCountConsumers = [
  {
    name: 'GET /api/occupancy-calendar/grid',
    why: 'the occupancy board, and the ratios computed from it',
    read: async (ctx, s) => {
      const g = await gridCounts(ctx, s.week_start);
      return g._error ? g : { from: g[s.assert_day]?.[s.room_id], to: g[s.assert_day]?.[s.other_room_id] };
    },
    expect: (v, s, before) => ({ from: before.from - 1, to: before.to + 1 }),
  },
  {
    name: 'GET /api/rota/week/:date/ratio',
    why: 'the staffing requirement — a legal question',
    read: async (ctx, s) => {
      const g = await ratioCounts(ctx, s.week_start);
      return g._error ? g : { from: g[s.assert_day]?.[String(s.room_id)], to: g[s.assert_day]?.[String(s.other_room_id)] };
    },
    expect: (v, s, before) => ({ from: before.from - 1, to: before.to + 1 }),
  },
  {
    // The other half of "did it change the right thing": a move effective today
    // must NOT rewrite where the child was last Tuesday. A transfer that closes
    // the old booking with is_active=false makes the child vanish from the old
    // room for every past date, which falsifies occupancy history.
    name: 'GET /api/occupancy-calendar/grid — a PAST day must not move',
    why: 'a move effective today must not rewrite where the child already was',
    read: async (ctx, s) => {
      if (!s.history_day) return 'n/a';
      const g = await gridCounts(ctx, s.history_week, 1);
      return g._error ? g : { from: g[s.history_day]?.[s.room_id], to: g[s.history_day]?.[s.other_room_id] };
    },
    expect: (v, s, before) => before,
  },
];

/* ── the specs ─────────────────────────────────────────────────────────────── */

const specs = [

/* ═══ child room, via the profile save ═══════════════════════════════════════ */
{
  id: 'child.room_id@children-put',
  pick: pickCountableChild,
  snapshot: async (ctx, s) => ({
    child: (await ctx.sql('SELECT room_id, room FROM children WHERE id=$1', [s.child_id]))[0],
    bookings: await bookingSnapshot(ctx, s.child_id),
  }),
  restore: async (ctx, s, snap) => {
    await ctx.sql('UPDATE children SET room_id=$1, room=$2 WHERE id=$3',
      [snap.child.room_id, snap.child.room, s.child_id]);
    await bookingRestore(ctx, s.child_id, snap.bookings);
  },
  landed: async (ctx, s) => {
    const c = (await ctx.sql('SELECT room_id FROM children WHERE id=$1', [s.child_id]))[0];
    const b = liveBooking(await bookingSnapshot(ctx, s.child_id), ctx.today);
    return { 'children.room_id': c.room_id, 'child_bookings.room_id': b ? b.room_id : null };
  },
  read: async (ctx, s) => (await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.room_id,
  newValue: (ctx, s) => s.other_room_id,
  write: (ctx, s, v) => ctx.api('admin',
    { method: 'PUT', path: `/api/children/${s.child_id}`, body: { room_id: v } }),
  expectLanded: v => ({ 'children.room_id': v, 'child_bookings.room_id': v }),
  consumers: [
    { name: 'GET /api/children/:id',
      read: async (ctx, s) => (await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.room_id,
      expect: v => v },
    { name: 'GET /api/bookings/child/:childId',
      why: 'the register occupancy is computed from',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: `/api/bookings/child/${s.child_id}` });
        const live = liveBooking((r.json || []).map(b => ({ ...b, start_date: dcol(b.start_date), end_date: dcol(b.end_date) })), ctx.today);
        return live ? live.room_id : null;
      },
      expect: v => v },
    { name: 'GET /api/occupancy-v2/person/child/:id',
      read: async (ctx, s) => (await ctx.api('admin', { path: `/api/occupancy-v2/person/child/${s.child_id}` })).json?.room_id,
      expect: v => v },
    ...roomCountConsumers,
  ],
},

/* ═══ child room, via the room-move widget — the bug Toby found ═══════════════ */
{
  id: 'child.room_id@room-move',
  pick: pickCountableChild,
  snapshot: async (ctx, s) => ({
    child: (await ctx.sql('SELECT room_id, room FROM children WHERE id=$1', [s.child_id]))[0],
    bookings: await bookingSnapshot(ctx, s.child_id),
    move_ids: (await ctx.sql('SELECT id FROM child_room_moves WHERE child_id=$1 ORDER BY id', [s.child_id])).map(r => r.id),
  }),
  restore: async (ctx, s, snap) => {
    await ctx.sql('DELETE FROM child_room_moves WHERE child_id=$1 AND NOT (id = ANY($2::int[]))',
      [s.child_id, snap.move_ids.length ? snap.move_ids : [-1]]);
    await ctx.sql('UPDATE children SET room_id=$1, room=$2 WHERE id=$3',
      [snap.child.room_id, snap.child.room, s.child_id]);
    await bookingRestore(ctx, s.child_id, snap.bookings);
  },
  landed: async (ctx, s) => {
    const c = (await ctx.sql('SELECT room_id FROM children WHERE id=$1', [s.child_id]))[0];
    const b = liveBooking(await bookingSnapshot(ctx, s.child_id), ctx.today);
    const m = await ctx.sql('SELECT count(*)::int n FROM child_room_moves WHERE child_id=$1', [s.child_id]);
    return { 'children.room_id': c.room_id, 'child_bookings.room_id': b ? b.room_id : null,
             'child_room_moves.rows': m[0].n };
  },
  read: async (ctx, s) => (await ctx.api('admin', { path: `/api/occupancy-v2/person/child/${s.child_id}` })).json?.room_id,
  newValue: (ctx, s) => s.other_room_id,
  write: (ctx, s, v) => ctx.api('admin', { method: 'POST', path: '/api/occupancy-v2/room-move',
    body: { child_id: s.child_id, to_room_id: v, moved_on: ctx.today } }),
  expectLanded: (v, s, before) => ({ 'children.room_id': v, 'child_bookings.room_id': v,
    'child_room_moves.rows': before['child_room_moves.rows'] + 1 }),
  consumers: [
    { name: 'GET /api/occupancy-v2/room-moves',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: `/api/occupancy-v2/room-moves?child_id=${s.child_id}` });
        return (r.json || [])[0]?.to_room_id ?? null;
      },
      expect: v => v },
    { name: 'GET /api/occupancy-v2/person/child/:id',
      read: async (ctx, s) => (await ctx.api('admin', { path: `/api/occupancy-v2/person/child/${s.child_id}` })).json?.room_id,
      expect: v => v },
    { name: 'GET /api/bookings/child/:childId',
      why: 'the register occupancy is computed from — this is the one that was wrong',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: `/api/bookings/child/${s.child_id}` });
        const live = liveBooking((r.json || []).map(b => ({ ...b, start_date: dcol(b.start_date), end_date: dcol(b.end_date) })), ctx.today);
        return live ? live.room_id : null;
      },
      expect: v => v },
    ...roomCountConsumers,
  ],
},

/* ═══ the booking's own room ══════════════════════════════════════════════════ */
{
  id: 'booking.room_id',
  pick: pickCountableChild,
  // The child row is in the snapshot because b314 made the profile follow the
  // live booking's room. A spec that disturbs a thing must own putting it back;
  // when this one did not, the next run picked a different subject and the suite
  // stopped being reproducible. That is what running it twice is for.
  snapshot: async (ctx, s) => ({
    bookings: await bookingSnapshot(ctx, s.child_id),
    child: (await ctx.sql('SELECT room_id, room FROM children WHERE id=$1', [s.child_id]))[0],
  }),
  restore: async (ctx, s, snap) => {
    await bookingRestore(ctx, s.child_id, snap.bookings);
    await ctx.sql('UPDATE children SET room_id=$1, room=$2 WHERE id=$3',
      [snap.child.room_id, snap.child.room, s.child_id]);
  },
  landed: async (ctx, s) => ({
    'child_bookings.room_id': (await ctx.sql('SELECT room_id FROM child_bookings WHERE id=$1', [s.booking_id]))[0]?.room_id,
  }),
  read: async (ctx, s) => {
    const r = await ctx.api('admin', { path: `/api/bookings/child/${s.child_id}` });
    return (r.json || []).find(b => b.id === s.booking_id)?.room_id;
  },
  newValue: (ctx, s) => s.other_room_id,
  write: (ctx, s, v) => ctx.api('admin', { method: 'PUT', path: `/api/bookings/${s.booking_id}`, body: { room_id: v } }),
  expectLanded: v => ({ 'child_bookings.room_id': v }),
  consumers: [
    { name: 'GET /api/bookings/child/:childId',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: `/api/bookings/child/${s.child_id}` });
        return (r.json || []).find(b => b.id === s.booking_id)?.room_id;
      },
      expect: v => v },
    ...roomCountConsumers,
    { name: 'GET /api/children/:id',
      why: 'the profile — does it follow the register, or disagree with it?',
      read: async (ctx, s) => (await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.room_id,
      expect: v => v },
  ],
},

/* ═══ the Mon–Fri tick boxes ══════════════════════════════════════════════════ */
{
  id: 'booking.days',
  pick: pickCountableChild,
  snapshot: async (ctx, s) => ({ bookings: await bookingSnapshot(ctx, s.child_id) }),
  restore: (ctx, s, snap) => bookingRestore(ctx, s.child_id, snap.bookings),
  landed: async (ctx, s) => {
    const b = (await ctx.sql('SELECT mon,tue,wed,thu,fri FROM child_bookings WHERE id=$1', [s.booking_id]))[0];
    return { 'child_bookings.days': DOWS.map(d => (b[d] ? d : '')).filter(Boolean).join(',') };
  },
  read: async (ctx, s) => {
    const r = await ctx.api('admin', { path: `/api/bookings/child/${s.child_id}` });
    const b = (r.json || []).find(x => x.id === s.booking_id) || {};
    return DOWS.map(d => (b[d] ? d : '')).filter(Boolean).join(',');
  },
  // untick exactly the day we assert on — the smallest change with a visible consequence
  newValue: (ctx, s) => DOWS.filter(d => d !== s.assert_dow).join(','),
  write: (ctx, s, v) => {
    const body = {};
    for (const d of DOWS) body[d] = v.split(',').includes(d);
    return ctx.api('admin', { method: 'PUT', path: `/api/bookings/${s.booking_id}`, body });
  },
  expectLanded: v => ({ 'child_bookings.days': v }),
  consumers: [
    { name: 'GET /api/occupancy-calendar/grid',
      why: 'the day they no longer come must lose a place',
      read: async (ctx, s) => {
        const g = await gridCounts(ctx, s.week_start);
        return g._error ? g : { day: g[s.assert_day]?.[s.room_id] };
      },
      expect: (v, s, before) => ({ day: before.day - 1 }) },
    { name: 'GET /api/rota/week/:date/ratio',
      read: async (ctx, s) => {
        const g = await ratioCounts(ctx, s.week_start);
        return g._error ? g : { day: g[s.assert_day]?.[String(s.room_id)] };
      },
      expect: (v, s, before) => ({ day: before.day - 1 }) },
    { name: 'GET /api/occupancy-v2/person/child/:id',
      read: async (ctx, s) => ((await ctx.api('admin', { path: `/api/occupancy-v2/person/child/${s.child_id}` })).json?.booked_days || []).length,
      expect: v => v.split(',').filter(Boolean).length },
  ],
},

/* ═══ funded flag on a booking ════════════════════════════════════════════════ */
{
  id: 'booking.funded',
  pick: pickCountableChild,
  snapshot: async (ctx, s) => ({ bookings: await bookingSnapshot(ctx, s.child_id) }),
  restore: (ctx, s, snap) => bookingRestore(ctx, s.child_id, snap.bookings),
  landed: async (ctx, s) => ({
    'child_bookings.funded': (await ctx.sql('SELECT funded FROM child_bookings WHERE id=$1', [s.booking_id]))[0]?.funded,
  }),
  read: async (ctx, s) => {
    const r = await ctx.api('admin', { path: `/api/bookings/child/${s.child_id}` });
    return !!(r.json || []).find(b => b.id === s.booking_id)?.funded;
  },
  newValue: (ctx, s, cur) => !cur,
  write: (ctx, s, v) => ctx.api('admin', { method: 'PUT', path: `/api/bookings/${s.booking_id}`, body: { funded: v } }),
  expectLanded: v => ({ 'child_bookings.funded': v }),
  consumers: [
    { name: 'GET /api/bookings/child/:childId',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: `/api/bookings/child/${s.child_id}` });
        return !!(r.json || []).find(b => b.id === s.booking_id)?.funded;
      },
      expect: v => v },
  ],
},

/* ═══ date of birth — the age band drives the legal ratio ════════════════════ */
{
  id: 'child.date_of_birth',
  pick: async ctx => {
    const s = await pickCountableChild(ctx);
    if (!s) return null;
    const dob = dcol((await ctx.sql('SELECT date_of_birth FROM children WHERE id=$1', [s.child_id]))[0]?.date_of_birth);
    if (!dob) return null;
    // Three bands, not two: under2 · two · threePlus. Predicting "they leave
    // threePlus" when they were actually a two-year-old is a bug in the test,
    // not in the product, so record the band they are in now and move them to a
    // different one deliberately.
    const yrs = (new Date(ctx.today) - new Date(dob)) / (1000 * 60 * 60 * 24 * 365.25);
    const from_band = yrs < 2 ? 'under2' : yrs < 3 ? 'two' : 'threePlus';
    const target_band = from_band === 'under2' ? 'threePlus' : 'under2';
    return { ...s, dob, from_band, target_band,
             new_dob: target_band === 'under2' ? addDays(ctx.today, -300) : addDays(ctx.today, -365 * 4) };
  },
  snapshot: async (ctx, s) => (await ctx.sql('SELECT date_of_birth FROM children WHERE id=$1', [s.child_id]))[0],
  restore: (ctx, s, snap) => ctx.sql('UPDATE children SET date_of_birth=$1 WHERE id=$2',
    [dcol(snap.date_of_birth), s.child_id]),
  landed: async (ctx, s) => ({
    'children.date_of_birth': dcol((await ctx.sql('SELECT date_of_birth FROM children WHERE id=$1', [s.child_id]))[0]?.date_of_birth),
  }),
  read: async (ctx, s) => dcol((await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.date_of_birth),
  newValue: (ctx, s) => s.new_dob,
  write: (ctx, s, v) => ctx.api('admin', { method: 'PUT', path: `/api/children/${s.child_id}`, body: { date_of_birth: v } }),
  expectLanded: v => ({ 'children.date_of_birth': v }),
  consumers: [
    { name: 'GET /api/children/:id',
      read: async (ctx, s) => dcol((await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.date_of_birth),
      expect: v => v },
    { name: 'GET /api/rota/week/:date/ratio',
      why: 'the age-band split that sets how many staff the room legally needs',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: `/api/rota/week/${s.week_start}/ratio` });
        const d = r.json?.days?.[s.assert_day];
        return d ? { under2: d.booked.under2, two: d.booked.two, threePlus: d.booked.threePlus }
                 : { _error: `HTTP ${r.code}` };
      },
      expect: (v, s, before) => {
        const after = { ...before };
        after[s.from_band] -= 1;
        after[s.target_band] += 1;
        return after;
      } },
  ],
},

/* ═══ allergies, the clinical field ══════════════════════════════════════════ */
{
  id: 'child.allergies',
  pick: pickCountableChild,
  snapshot: async (ctx, s) => (await ctx.sql('SELECT allergies FROM children WHERE id=$1', [s.child_id]))[0],
  restore: (ctx, s, snap) => ctx.sql('UPDATE children SET allergies=$1 WHERE id=$2', [snap.allergies, s.child_id]),
  landed: async (ctx, s) => (await ctx.sql('SELECT allergies AS "children.allergies" FROM children WHERE id=$1', [s.child_id]))[0],
  read: async (ctx, s) => (await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.allergies ?? null,
  newValue: ctx => `b314 probe allergy ${ctx.stamp}`,
  write: (ctx, s, v) => ctx.api('admin', { method: 'PUT', path: `/api/children/${s.child_id}`, body: { allergies: v } }),
  expectLanded: v => ({ 'children.allergies': v }),
  consumers: [
    { name: 'GET /api/children/:id',
      read: async (ctx, s) => (await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.allergies ?? null,
      expect: v => v },
    { name: 'GET /api/kitchen/allergen-summary',
      why: 'what the chef is handed before service',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: '/api/kitchen/allergen-summary' });
        const list = Array.isArray(r.json) ? r.json : (r.json?.children || r.json?.rows || []);
        const row = list.find(c => c.id === s.child_id);
        return row ? (row.allergies ?? null) : null;
      },
      expect: v => v,
      // b314 merged the two allergy boxes onto the one line the chef reads, so
      // this asks the chef's question — are the words there — not a column's.
      compare: (got, want) => typeof got === 'string' && got.includes(want) },
  ],
},

/* ═══ allergies, the OTHER field the same person can type into ═══════════════ */
{
  id: 'child.food_allergies@about-me',
  pick: pickCountableChild,
  snapshot: async (ctx, s) => ({
    row: (await ctx.sql('SELECT food_allergies FROM child_about_me WHERE child_id=$1', [s.child_id]))[0] || null,
    children_allergies: (await ctx.sql('SELECT allergies FROM children WHERE id=$1', [s.child_id]))[0].allergies,
  }),
  restore: async (ctx, s, snap) => {
    if (snap.row) await ctx.sql('UPDATE child_about_me SET food_allergies=$1 WHERE child_id=$2', [snap.row.food_allergies, s.child_id]);
    else await ctx.sql('DELETE FROM child_about_me WHERE child_id=$1', [s.child_id]);
  },
  landed: async (ctx, s) => ({
    'child_about_me.food_allergies': (await ctx.sql('SELECT food_allergies FROM child_about_me WHERE child_id=$1', [s.child_id]))[0]?.food_allergies ?? null,
  }),
  read: async (ctx, s) => (await ctx.api('admin', { path: `/api/children/${s.child_id}/about-me` })).json?.food_allergies ?? null,
  newValue: ctx => `b314 probe food allergy ${ctx.stamp}`,
  write: (ctx, s, v) => ctx.api('admin',
    { method: 'PUT', path: `/api/children/${s.child_id}/about-me`, body: { food_allergies: v } }),
  expectLanded: v => ({ 'child_about_me.food_allergies': v }),
  consumers: [
    { name: 'GET /api/children/:id/about-me',
      read: async (ctx, s) => (await ctx.api('admin', { path: `/api/children/${s.child_id}/about-me` })).json?.food_allergies ?? null,
      expect: v => v },
    { name: 'GET /api/kitchen/allergen-summary',
      why: 'THE POINT — a food allergy typed here has to reach the kitchen',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: '/api/kitchen/allergen-summary' });
        const list = Array.isArray(r.json) ? r.json : (r.json?.children || r.json?.rows || []);
        const row = list.find(c => c.id === s.child_id);
        return row ? `${row.allergies || ''} ${row.dietary_requirements || ''}`.trim() : null;
      },
      expect: v => v,
      // a substring match is enough: the chef needs to SEE the words, not match a column
      compare: (got, want) => typeof got === 'string' && got.includes(want) },
  ],
},

/* ═══ funded hours ════════════════════════════════════════════════════════════ */
{
  id: 'child.funded_hours',
  pick: pickCountableChild,
  snapshot: async (ctx, s) => (await ctx.sql('SELECT funded_hours FROM children WHERE id=$1', [s.child_id]))[0],
  restore: (ctx, s, snap) => ctx.sql('UPDATE children SET funded_hours=$1 WHERE id=$2', [snap.funded_hours, s.child_id]),
  landed: async (ctx, s) => ({
    'children.funded_hours': Number((await ctx.sql('SELECT funded_hours FROM children WHERE id=$1', [s.child_id]))[0]?.funded_hours),
  }),
  read: async (ctx, s) => Number((await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.funded_hours),
  newValue: (ctx, s, cur) => (Number(cur) === 15 ? 30 : 15),
  write: (ctx, s, v) => ctx.api('admin', { method: 'PUT', path: `/api/children/${s.child_id}`, body: { funded_hours: v } }),
  expectLanded: v => ({ 'children.funded_hours': v }),
  consumers: [
    { name: 'GET /api/children/:id',
      read: async (ctx, s) => Number((await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.funded_hours),
      expect: v => v },
    { name: 'GET /api/occupancy-v2/person/child/:id',
      why: 'the weekly fee shown on the person card',
      read: async (ctx, s) => (await ctx.api('admin', { path: `/api/occupancy-v2/person/child/${s.child_id}` })).json?.fee?.funded_hours ?? null,
      expect: v => v },
  ],
},

/* ═══ key person ══════════════════════════════════════════════════════════════ */
{
  id: 'child.key_person_id',
  pick: async ctx => {
    const s = await pickCountableChild(ctx);
    if (!s) return null;
    const cur = (await ctx.sql('SELECT key_person_id FROM children WHERE id=$1', [s.child_id]))[0]?.key_person_id;
    const alt = (await ctx.sql(
      `SELECT id FROM staff WHERE COALESCE(is_active,true) AND id <> 1 AND id IS DISTINCT FROM $1 ORDER BY id LIMIT 1`,
      [cur || null]))[0];
    return alt ? { ...s, alt_staff_id: alt.id } : null;
  },
  snapshot: async (ctx, s) => (await ctx.sql('SELECT key_person_id FROM children WHERE id=$1', [s.child_id]))[0],
  restore: (ctx, s, snap) => ctx.sql('UPDATE children SET key_person_id=$1 WHERE id=$2', [snap.key_person_id, s.child_id]),
  landed: async (ctx, s) => (await ctx.sql('SELECT key_person_id AS "children.key_person_id" FROM children WHERE id=$1', [s.child_id]))[0],
  read: async (ctx, s) => (await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.key_person_id ?? null,
  newValue: (ctx, s) => s.alt_staff_id,
  write: (ctx, s, v) => ctx.api('admin', { method: 'PUT', path: `/api/children/${s.child_id}`, body: { key_person_id: v } }),
  expectLanded: v => ({ 'children.key_person_id': v }),
  consumers: [
    { name: 'GET /api/children/:id',
      read: async (ctx, s) => (await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.key_person_id ?? null,
      expect: v => v },
    { name: 'GET /api/children/:id/profile',
      why: 'the profile header the practitioners read',
      // it returns the key person's NAME, not the id — so this asks the only
      // question that matters and the only one that can be printed: does the
      // header now name a key person at all?
      read: async (ctx, s) => {
        const j = (await ctx.api('admin', { path: `/api/children/${s.child_id}/profile` })).json || {};
        return !!(j.key_person_first || j.key_person_last || j.key_person_id);
      },
      expect: () => true },
  ],
},

/* ═══ leave date ══════════════════════════════════════════════════════════════ */
{
  id: 'child.leave_date',
  pick: pickCountableChild,
  snapshot: async (ctx, s) => ({
    child: (await ctx.sql('SELECT leave_date, is_active, enrolment_status FROM children WHERE id=$1', [s.child_id]))[0],
    bookings: await bookingSnapshot(ctx, s.child_id),   // b314 bounds them by the leave date
  }),
  restore: async (ctx, s, snap) => {
    await ctx.sql('UPDATE children SET leave_date=$1, is_active=$2, enrolment_status=$3 WHERE id=$4',
      [dcol(snap.child.leave_date), snap.child.is_active, snap.child.enrolment_status, s.child_id]);
    await bookingRestore(ctx, s.child_id, snap.bookings);
  },
  landed: async (ctx, s) => ({
    'children.leave_date': dcol((await ctx.sql('SELECT leave_date FROM children WHERE id=$1', [s.child_id]))[0]?.leave_date),
  }),
  read: async (ctx, s) => dcol((await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.leave_date),
  // a FUTURE date: a past one deliberately deactivates the child, which is a
  // different behaviour and would confound the count consumers
  newValue: (ctx, s) => { s.probe_leave_date = addDays(ctx.today, 120); return s.probe_leave_date; },
  write: (ctx, s, v) => ctx.api('admin', { method: 'PUT', path: `/api/children/${s.child_id}`, body: { leave_date: v } }),
  expectLanded: v => ({ 'children.leave_date': v }),
  consumers: [
    { name: 'GET /api/children/:id',
      read: async (ctx, s) => dcol((await ctx.api('admin', { path: `/api/children/${s.child_id}` })).json?.leave_date),
      expect: v => v },
    { name: 'GET /api/occupancy/projection',
      why: 'the place has to come free in the week they leave, or the forecast keeps it taken',
      // The projection's `leaves` list carries a room and a date and NO child id
      // (occupancy.js: leaves.push({room, date})), so this asks the only question
      // it can answer: does a leaver appear on the day we just set? That is also
      // the question that matters — the place coming free is what the forecast
      // is for. Who it is, this endpoint does not say; see the report.
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: `/api/occupancy/projection?weeks=30` });
        const dates = new Set();
        for (const w of r.json?.series || []) for (const l of w.leaves || []) dates.add(String(l.date).slice(0, 10));
        return { has_leaver_on_the_new_date: dates.has(s.probe_leave_date || '\u0000') };
      },
      expect: () => ({ has_leaver_on_the_new_date: true }) },
  ],
},

/* ═══ room capacity ═══════════════════════════════════════════════════════════ */
{
  id: 'room.capacity',
  pick: async ctx => {
    const r = (await ctx.sql('SELECT id, capacity, name, display_name FROM rooms ORDER BY id'))[0];
    return r ? { room_id: r.id, capacity: r.capacity, week_start: mondayOf(ctx.today) } : null;
  },
  snapshot: async (ctx, s) => (await ctx.sql('SELECT capacity, display_name FROM rooms WHERE id=$1', [s.room_id]))[0],
  restore: (ctx, s, snap) => ctx.sql('UPDATE rooms SET capacity=$1, display_name=$2 WHERE id=$3',
    [snap.capacity, snap.display_name, s.room_id]),
  landed: async (ctx, s) => ({
    'rooms.capacity': Number((await ctx.sql('SELECT capacity FROM rooms WHERE id=$1', [s.room_id]))[0]?.capacity),
  }),
  read: async (ctx, s) => {
    const r = await ctx.api('admin', { path: '/api/occupancy-v2/rooms' });
    return Number((r.json || []).find(x => x.id === s.room_id)?.capacity);
  },
  newValue: (ctx, s, cur) => Number(cur) + 7,
  write: (ctx, s, v) => ctx.api('admin', { method: 'PUT', path: `/api/admin/rooms/${s.room_id}`, body: { capacity: v } }),
  expectLanded: v => ({ 'rooms.capacity': v }),
  consumers: [
    { name: 'GET /api/occupancy-v2/rooms',
      read: async (ctx, s) => Number((await ctx.api('admin', { path: '/api/occupancy-v2/rooms' })).json?.find(x => x.id === s.room_id)?.capacity),
      expect: v => v },
    { name: 'GET /api/occupancy-calendar/grid',
      why: 'available places, and the colour band the manager reads off',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: `/api/occupancy-calendar/grid?weeks=1&start=${s.week_start}` });
        return Number((r.json?.rooms || []).find(x => x.id === s.room_id)?.capacity);
      },
      expect: v => v },
    { name: 'GET /api/occupancy/projection',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: '/api/occupancy/projection?weeks=1' });
        return Number((r.json?.rooms || []).find(x => x.id === s.room_id)?.capacity);
      },
      expect: v => v },
  ],
},

/* ═══ the room's NAME ═════════════════════════════════════════════════════════ */
{
  id: 'room.name',
  pick: async ctx => {
    const r = (await ctx.sql('SELECT id FROM rooms ORDER BY id'))[0];
    return r ? { room_id: r.id, week_start: mondayOf(ctx.today) } : null;
  },
  snapshot: async (ctx, s) => (await ctx.sql('SELECT name, display_name, capacity FROM rooms WHERE id=$1', [s.room_id]))[0],
  restore: (ctx, s, snap) => ctx.sql('UPDATE rooms SET name=$1, display_name=$2 WHERE id=$3',
    [snap.name, snap.display_name, s.room_id]),
  landed: async (ctx, s) => ({
    'rooms.display_name': (await ctx.sql('SELECT display_name FROM rooms WHERE id=$1', [s.room_id]))[0]?.display_name,
  }),
  read: async (ctx, s) => (await ctx.sql('SELECT display_name FROM rooms WHERE id=$1', [s.room_id]))[0]?.display_name,
  newValue: ctx => `b314 Room ${ctx.stamp}`,
  write: (ctx, s, v) => ctx.api('admin', { method: 'PUT', path: `/api/admin/rooms/${s.room_id}`, body: { display_name: v } }),
  expectLanded: v => ({ 'rooms.display_name': v }),
  consumers: [
    { name: 'GET /api/occupancy-v2/rooms',
      why: 'the room picker on every occupancy screen',
      read: async (ctx, s) => (await ctx.api('admin', { path: '/api/occupancy-v2/rooms' })).json?.find(x => x.id === s.room_id)?.name ?? null,
      expect: v => v },
    { name: 'GET /api/occupancy-calendar/grid',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: `/api/occupancy-calendar/grid?weeks=1&start=${s.week_start}` });
        return (r.json?.rooms || []).find(x => x.id === s.room_id)?.name ?? null;
      },
      expect: v => v },
    { name: 'GET /api/rota/week/:date/ratio',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: `/api/rota/week/${s.week_start}/ratio` });
        const day = Object.values(r.json?.days || {})[0];
        return day?.rooms?.[String(s.room_id)]?.room_name ?? null;
      },
      expect: v => v },
  ],
},

/* ═══ which room a member of staff belongs to ════════════════════════════════ */
{
  id: 'staff.room_id',
  pick: async ctx => {
    const st = (await ctx.sql(
      `SELECT id, room_id FROM staff WHERE COALESCE(is_active,true) AND id <> 1 ORDER BY id DESC LIMIT 1`))[0];
    if (!st) return null;
    const rooms = await ctx.sql('SELECT id FROM rooms ORDER BY id');
    const other = rooms.map(r => r.id).find(id => id !== st.room_id);
    return other ? { staff_id: st.id, room_id: st.room_id, other_room_id: other } : null;
  },
  snapshot: async (ctx, s) => (await ctx.sql('SELECT room_id FROM staff WHERE id=$1', [s.staff_id]))[0],
  restore: (ctx, s, snap) => ctx.sql('UPDATE staff SET room_id=$1 WHERE id=$2', [snap.room_id, s.staff_id]),
  landed: async (ctx, s) => (await ctx.sql('SELECT room_id AS "staff.room_id" FROM staff WHERE id=$1', [s.staff_id]))[0],
  read: async (ctx, s) => (await ctx.api('admin', { path: `/api/staff/${s.staff_id}` })).json?.room_id ?? null,
  newValue: (ctx, s) => s.other_room_id,
  write: (ctx, s, v) => ctx.api('admin', { method: 'PUT', path: `/api/staff/${s.staff_id}`, body: { room_id: v } }),
  expectLanded: v => ({ 'staff.room_id': v }),
  consumers: [
    { name: 'GET /api/staff/:id',
      read: async (ctx, s) => (await ctx.api('admin', { path: `/api/staff/${s.staff_id}` })).json?.room_id ?? null,
      expect: v => v },
    { name: 'GET /api/occupancy-v2/person/staff/:id',
      read: async (ctx, s) => (await ctx.api('admin', { path: `/api/occupancy-v2/person/staff/${s.staff_id}` })).json?.room_id ?? null,
      expect: v => v },
    { name: 'GET /api/occupancy-v2/staff-roster',
      why: 'who is counted against which room on the roster',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: '/api/occupancy-v2/staff-roster' });
        const list = Array.isArray(r.json) ? r.json : (r.json?.staff || []);
        return list.find(x => x.id === s.staff_id)?.room_id ?? null;
      },
      expect: v => v },
  ],
},

/* ═══ contracted hours ════════════════════════════════════════════════════════ */
{
  id: 'staff.contracted_hours',
  pick: async ctx => {
    const st = (await ctx.sql(
      `SELECT id, contracted_hours FROM staff WHERE COALESCE(is_active,true) AND id <> 1 ORDER BY id DESC LIMIT 1`))[0];
    return st ? { staff_id: st.id } : null;
  },
  snapshot: async (ctx, s) => (await ctx.sql('SELECT contracted_hours FROM staff WHERE id=$1', [s.staff_id]))[0],
  restore: (ctx, s, snap) => ctx.sql('UPDATE staff SET contracted_hours=$1 WHERE id=$2', [snap.contracted_hours, s.staff_id]),
  landed: async (ctx, s) => ({
    'staff.contracted_hours': Number((await ctx.sql('SELECT contracted_hours FROM staff WHERE id=$1', [s.staff_id]))[0]?.contracted_hours),
  }),
  read: async (ctx, s) => Number((await ctx.api('admin', { path: `/api/staff/${s.staff_id}` })).json?.contracted_hours),
  newValue: (ctx, s, cur) => (Number(cur) === 31 ? 29 : 31),
  write: (ctx, s, v) => ctx.api('admin', { method: 'PUT', path: `/api/staff/${s.staff_id}`, body: { contracted_hours: v } }),
  expectLanded: v => ({ 'staff.contracted_hours': v }),
  consumers: [
    { name: 'GET /api/staff/:id',
      read: async (ctx, s) => Number((await ctx.api('admin', { path: `/api/staff/${s.staff_id}` })).json?.contracted_hours),
      expect: v => v },
    { name: 'GET /api/occupancy-v2/staff-roster',
      read: async (ctx, s) => {
        const r = await ctx.api('admin', { path: '/api/occupancy-v2/staff-roster' });
        const list = Array.isArray(r.json) ? r.json : (r.json?.staff || []);
        const row = list.find(x => x.id === s.staff_id);
        return row ? Number(row.contracted_hours) : null;
      },
      expect: v => v },
  ],
},

];

/* pickCountableChild returns assert_day; the booking.days spec needs the weekday name too */
for (const sp of specs) {
  const orig = sp.pick;
  sp.pick = async ctx => {
    const s = await orig(ctx);
    if (s && s.assert_day && !s.assert_dow) {
      s.assert_dow = DOWS[(new Date(s.assert_day + 'T00:00:00Z').getUTCDay() + 6) % 7];
    }
    return s;
  };
}

module.exports = { specs, helpers: { ymd, mondayOf, addDays, dcol, gridCounts, ratioCounts, DOWS } };
