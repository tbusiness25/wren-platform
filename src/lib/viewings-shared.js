'use strict';
// b336 — Viewings: helpers shared by the Roost grid, the EY room view, the
// public family picker and James's getLiveData read. "What counts as an open
// slot" is defined once, here, so the three surfaces can never disagree about
// it.
//
// weekday convention: 0=Mon..6=Sun — matches ladn.staff_work_patterns, NOT
// JS's own getDay() (0=Sun). Computed at local noon so a date string never
// rolls to the wrong day across a DST boundary.
// (memory/reference_ratio_engine_getday_mismatch.md — never trust raw getDay().)

// pg hands a `date` column back as a local-midnight JS Date. String(d) and
// d.toISOString() both risk stepping to the wrong day; use local getters.
// (memory/reference_pg_date_ymd_trap.md)
function ymd(d) {
  if (d == null) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function isoWeekday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return (d.getDay() + 6) % 7;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function addMinutes(hhmm, mins) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const total = ((h * 60 + m + mins) % 1440 + 1440) % 1440;
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

function nowLondonHHMM() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour12: false, hour: '2-digit', minute: '2-digit' });
}

function todayLondon() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => parts.find(p => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

// Every slot occurrence (date x active viewing_slots) between from..from+days-1,
// each tagged 'open' or carrying the viewing that fills it. roomId optional.
async function computeSlotGrid(db, { roomId, from, days = 7 } = {}) {
  const fromDate = from || todayLondon();
  const toDate = addDays(fromDate, Math.max(1, days) - 1);

  const { rows: slots } = await db.query(
    `SELECT vs.id AS slot_id, vs.room_id, vs.weekday, vs.start_time, vs.duration_minutes,
            r.name AS room_name, r.display_name
       FROM viewing_slots vs JOIN rooms r ON r.id = vs.room_id
      WHERE vs.active = true ${roomId ? 'AND vs.room_id = $1' : ''}
      ORDER BY vs.room_id, vs.weekday, vs.start_time`,
    roomId ? [roomId] : []);

  const { rows: booked } = await db.query(
    `SELECT v.id, v.room_id, v.slot_date, v.start_time, v.status, v.family_type, v.family_id
       FROM viewings v
      WHERE v.slot_date BETWEEN $1 AND $2
        AND v.status NOT IN ('cancelled','declined')
        ${roomId ? 'AND v.room_id = $3' : ''}`,
    roomId ? [fromDate, toDate, roomId] : [fromDate, toDate]);

  const byKey = new Map();
  for (const b of booked) byKey.set(`${b.room_id}|${ymd(b.slot_date)}|${b.start_time}`, b);

  const out = [];
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    const wd = isoWeekday(d);
    for (const s of slots) {
      if (s.weekday !== wd) continue;
      const viewing = byKey.get(`${s.room_id}|${d}|${s.start_time}`) || null;
      out.push({
        slot_id: s.slot_id, room_id: s.room_id, room_name: s.display_name || s.room_name,
        date: d, weekday: wd, start_time: s.start_time,
        end_time: addMinutes(s.start_time, s.duration_minutes),
        status: viewing ? viewing.status : 'open',
        viewing_id: viewing ? viewing.id : null,
        family_type: viewing ? viewing.family_type : null,
        family_id: viewing ? viewing.family_id : null,
      });
    }
  }
  return out;
}

// The next N genuinely open slots from right now — for the family picker and
// for James (Vapi). Looks 60 days ahead so a quiet week doesn't come back empty.
async function nextOpenSlots(db, { roomId, limit = 5 } = {}) {
  const today = todayLondon();
  const nowHHMM = nowLondonHHMM();
  const grid = await computeSlotGrid(db, { roomId, from: today, days: 60 });
  return grid
    .filter(s => s.status === 'open' && !(s.date === today && s.start_time <= nowHHMM))
    .slice(0, limit);
}

// waiting_list and enquiries name the same facts with different column names.
// One place that knows both shapes, so nothing downstream has to.
async function loadFamily(db, familyType, familyId) {
  if (familyType === 'waiting_list') {
    const { rows } = await db.query(
      `SELECT id, child_first_name, child_last_name, parent_name, parent_email, parent_phone, room_needed AS room_pref
         FROM waiting_list WHERE id=$1`, [familyId]);
    return rows[0] || null;
  }
  if (familyType === 'enquiry') {
    const { rows } = await db.query(
      `SELECT id, child_first_name, child_last_name, parent_name, parent_email, parent_phone, preferred_room AS room_pref
         FROM enquiries WHERE id=$1`, [familyId]);
    return rows[0] || null;
  }
  return null;
}

// room_needed/preferred_room are free text (memory: not a reliable FK). Best
// effort match against rooms.name/display_name; null means "don't guess" —
// callers should offer both rooms rather than pick the wrong one.
async function resolveFamilyRoomId(db, family) {
  if (!family || !family.room_pref) return null;
  const text = String(family.room_pref).toLowerCase();
  const { rows } = await db.query(`SELECT id, name, display_name FROM rooms`);
  const hit = rows.find(r =>
    text.includes(String(r.name).toLowerCase()) ||
    (r.display_name && text.includes(String(r.display_name).toLowerCase())));
  return hit ? hit.id : null;
}

module.exports = {
  ymd, isoWeekday, addDays, addMinutes, todayLondon, nowLondonHHMM,
  computeSlotGrid, nextOpenSlots, loadFamily, resolveFamilyRoomId,
};
