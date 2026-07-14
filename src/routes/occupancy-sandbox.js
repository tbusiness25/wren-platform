'use strict';
// Occupancy / ratio SANDBOX — model what-if rosters without touching real data.
//
// A "scenario" is a named, editable roster (JSON): a list of hypothetical children
// with dob, room, and booked weekdays. The simulator computes per-room occupancy
// (vs real room capacity) and Ofsted staffing ratios PURELY from that roster JSON.
// It reuses the same age-band + ratio maths as the live ratio-engine so the numbers
// match production, but it reads/writes NOTHING in ladn.children / child_bookings.
//
// Real data is only ever READ once, to *seed* a scenario ("start from today's roster").

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { RATIOS, ageBandOn, requiredStaff, availableRatioStaff } = require('../services/ratio-engine');

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const SPARE_BUFFER = 1; // Q6: one spare above requirement (mirrors ratio-engine)
// Roles/names that do NOT count toward ratios (mirrors ratio-engine EXCLUDED_ROLES).
const EXCLUDED_ROLES = ['manager', 'chef', 'owner'];
const EXCLUDED_NAME_RE = /\b(hetty|clare)\b/i;
// day_of_week (JS getDay: 0=Sun..6=Sat) → mon..fri keys
const DOW_TO_KEY = { 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri' };

function defaultCountsInRatio(role, name) {
  return !EXCLUDED_ROLES.includes((role || '').toLowerCase()) && !EXCLUDED_NAME_RE.test(name || '');
}

router.use(authenticate);
// Occupancy planning is a leadership tool.
router.use((req, res, next) => {
  const role = req.user?.role;
  if (!['manager', 'deputy_manager', 'room_leader'].includes(role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});

// ── date helpers (local components — no toISOString TZ shift) ─────────────────
function fmt(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function mondayOf(d) {
  const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = dd.getDay();               // 0=Sun..6=Sat
  dd.setDate(dd.getDate() + (day === 0 ? -6 : 1 - day));
  return fmt(dd);
}
function addDays(dateStr, n) {
  const [y, m, day] = dateStr.split('-').map(Number);
  const d = new Date(y, m - 1, day); d.setDate(d.getDate() + n);
  return fmt(d);
}

async function getRooms(db) {
  const { rows } = await db.query(
    `SELECT id, name, capacity, min_age_months, max_age_months
     FROM rooms ORDER BY id`);
  return rows;
}

// Build a roster from the REAL current active children + their active booking.
// READ-ONLY — used to seed a scenario; the returned array is plain JSON the user
// then edits freely.
async function buildRealRoster(db) {
  const { rows } = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.date_of_birth, c.room_id,
           b.mon, b.tue, b.wed, b.thu, b.fri, b.room_id AS booking_room_id
    FROM children c
    LEFT JOIN LATERAL (
      SELECT mon, tue, wed, thu, fri, room_id
      FROM child_bookings
      WHERE child_id = c.id AND is_active = true
        AND start_date <= CURRENT_DATE
        AND (end_date IS NULL OR end_date >= CURRENT_DATE)
      ORDER BY start_date DESC LIMIT 1
    ) b ON true
    WHERE c.is_active = true AND c.date_of_birth IS NOT NULL
    ORDER BY c.room_id NULLS LAST, c.first_name`);
  return rows.map(r => ({
    cid: 'r' + r.id,
    first_name: r.first_name || '',
    last_name: r.last_name || '',
    dob: r.date_of_birth ? fmt(new Date(r.date_of_birth)) : null,
    room_id: r.booking_room_id || r.room_id || null,
    days: { mon: !!r.mon, tue: !!r.tue, wed: !!r.wed, thu: !!r.thu, fri: !!r.fri },
    settling: false,
    counts_on_ratio: true,
  }));
}

// Build a STAFF roster from real active staff + their work pattern + quals.
// READ-ONLY — seeds a scenario; qualification_level/is_first_aider come straight
// from ladn.staff so the sandbox reflects real qualifications.
async function buildRealStaff(db) {
  // Paediatric first aid is VALID when a 'first_aid' training record is either
  // not-yet-expired, or (no expiry recorded) completed within the last 3 years
  // — PFA certificates run 3 years. Manual staff.is_first_aider flag also counts.
  const { rows } = await db.query(`
    SELECT s.id, s.first_name, s.last_name, s.role, s.room_id,
           s.qualification_level, s.is_first_aider,
           fa.valid AS fa_valid, fa.best_date AS fa_date,
           ARRAY_AGG(DISTINCT wp.day_of_week) FILTER (
             WHERE COALESCE(wp.is_off, false) = false
               AND (wp.effective_from IS NULL OR wp.effective_from <= CURRENT_DATE)
               AND (wp.effective_to   IS NULL OR wp.effective_to   >= CURRENT_DATE)
           ) AS work_dows
    FROM staff s
    LEFT JOIN staff_work_patterns wp ON wp.staff_id = s.id
    LEFT JOIN LATERAL (
      SELECT bool_or(
               mt.expiry_date >= CURRENT_DATE
               OR (mt.expiry_date IS NULL AND mt.completed_date >= CURRENT_DATE - INTERVAL '3 years')
             ) AS valid,
             max(COALESCE(mt.expiry_date, mt.completed_date)) AS best_date
      FROM mandatory_training mt
      WHERE mt.staff_id = s.id AND mt.training_type ILIKE '%first_aid%'
    ) fa ON true
    WHERE s.is_active = true AND COALESCE(s.role,'') <> 'parent'
    GROUP BY s.id, fa.valid, fa.best_date
    ORDER BY s.role, s.first_name`);
  return rows.map(r => {
    const name = `${r.first_name || ''} ${r.last_name || ''}`.trim();
    const days = { mon: false, tue: false, wed: false, thu: false, fri: false };
    for (const dow of (r.work_dows || [])) { if (DOW_TO_KEY[dow]) days[DOW_TO_KEY[dow]] = true; }
    return {
      sid: 's' + r.id,
      name, role: r.role || 'practitioner',
      qual_level: r.qualification_level == null ? 0 : Number(r.qualification_level),
      pfa: !!r.fa_valid || !!r.is_first_aider,
      pfa_expiry: r.fa_date ? fmt(new Date(r.fa_date)) : null,
      room_id: r.room_id || null,
      counts_in_ratio: defaultCountsInRatio(r.role, name),
      days,
    };
  });
}

// ── Rooms meta ────────────────────────────────────────────────────────────────
router.get('/rooms', async (req, res) => {
  try { res.json(await getRooms(getPool())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Real roster preview (unsaved) — children + staff ──────────────────────────
router.get('/seed-real', async (req, res) => {
  try {
    const db = getPool();
    const [children, staff] = await Promise.all([buildRealRoster(db), buildRealStaff(db)]);
    res.json({ children, staff });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── List scenarios ────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, created_at, updated_at,
              jsonb_array_length(roster) AS child_count
       FROM sandbox_scenarios ORDER BY updated_at DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create scenario (optionally seeded from real data) ────────────────────────
router.post('/', async (req, res) => {
  const { name, seed_from_real, roster, staff } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const db = getPool();
    let seedChildren = Array.isArray(roster) ? roster : [];
    let seedStaff = Array.isArray(staff) ? staff : [];
    if (seed_from_real) {
      [seedChildren, seedStaff] = await Promise.all([buildRealRoster(db), buildRealStaff(db)]);
    }
    const { rows } = await db.query(
      `INSERT INTO sandbox_scenarios (name, roster, staff, created_by)
       VALUES ($1, $2::jsonb, $3::jsonb, $4) RETURNING *`,
      [name, JSON.stringify(seedChildren), JSON.stringify(seedStaff), req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Get one scenario ──────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT * FROM sandbox_scenarios WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update scenario (name + roster) ───────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { name, roster, staff } = req.body || {};
  if (!Array.isArray(roster)) return res.status(400).json({ error: 'roster array required' });
  const staffArr = Array.isArray(staff) ? staff : [];
  try {
    const { rows } = await getPool().query(
      `UPDATE sandbox_scenarios
         SET name=COALESCE($2,name), roster=$3::jsonb, staff=$4::jsonb, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, name || null, JSON.stringify(roster), JSON.stringify(staffArr)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Delete scenario ───────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(`DELETE FROM sandbox_scenarios WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted_id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Simulate ──────────────────────────────────────────────────────────────────
// POST /:id/simulate  → simulate a saved scenario
// POST /simulate      → simulate an ad-hoc roster passed in the body (live editing)
// body: { roster?, week_start?: 'YYYY-MM-DD', ratio_staff?: number | {mon..fri} }
async function runSimulate(req, res, scenarioId) {
  try {
    const db = getPool();
    let roster = Array.isArray(req.body?.roster) ? req.body.roster : null;
    let staffRoster = Array.isArray(req.body?.staff) ? req.body.staff : null;
    if ((!roster || !staffRoster) && scenarioId) {
      const { rows } = await db.query(`SELECT roster, staff FROM sandbox_scenarios WHERE id=$1`, [scenarioId]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      if (!roster) roster = rows[0].roster;
      if (!staffRoster) staffRoster = rows[0].staff;
    }
    if (!Array.isArray(roster)) return res.status(400).json({ error: 'roster required' });
    const hasStaffRoster = Array.isArray(staffRoster) && staffRoster.length > 0;

    const rooms = await getRooms(db);
    const weekStart = req.body?.week_start || mondayOf(new Date());
    const rs = req.body?.ratio_staff;

    const days = [];
    for (let i = 0; i < 5; i++) {
      const wd = WEEKDAYS[i];
      const dateStr = addDays(weekStart, i);

      // Children physically present that day: booked on this weekday, has a dob,
      // and not a settling child explicitly excluded from ratio.
      const present = roster.filter(c =>
        c && c.days && c.days[wd] && c.dob &&
        !(c.settling && c.counts_on_ratio === false));

      // Per-room occupancy vs capacity + per-room required staff.
      const perRoom = rooms.map(room => {
        const inRoom = present.filter(c => Number(c.room_id) === room.id);
        const bands = { under2: 0, two: 0, threePlus: 0 };
        for (const c of inRoom) bands[ageBandOn(c.dob, dateStr)]++;
        return {
          room_id: room.id, room_name: room.name, capacity: room.capacity,
          occupancy: inRoom.length, headroom: room.capacity - inRoom.length,
          over_capacity: inRoom.length > room.capacity,
          bands, required_staff: requiredStaff(bands),
        };
      });
      // Unassigned (no/invalid room) still count nursery-wide.
      const unassigned = present.filter(c => !rooms.some(r => r.id === Number(c.room_id)));

      // Nursery-wide ratio (matches ratio-engine): sum ceil per age band + 1 spare.
      const totalBands = { under2: 0, two: 0, threePlus: 0 };
      for (const c of present) totalBands[ageBandOn(c.dob, dateStr)]++;
      const totalRequired = requiredStaff(totalBands);
      const need = totalRequired + SPARE_BUFFER;

      // Staff available + qualification checks.
      // Priority: a hypothetical STAFF roster (richest) > numeric override >
      // the REAL ratio-countable staff rostered that weekday.
      let staffAvail, staffSource, quals = null;
      if (hasStaffRoster) {
        staffSource = 'staff_roster';
        const presentStaff = staffRoster.filter(s => s && s.days && s.days[wd]);
        const ratioStaff = presentStaff.filter(s => s.counts_in_ratio !== false);
        staffAvail = ratioStaff.length;
        // EYFS qualification checks (simplified for planning):
        //  • at least one Level 3+ on duty
        //  • at least half of staff on duty hold Level 2+
        //  • at least one paediatric first aider on duty
        const level3 = presentStaff.filter(s => (Number(s.qual_level) || 0) >= 3).length;
        const l2plus = presentStaff.filter(s => (Number(s.qual_level) || 0) >= 2).length;
        const pfa = presentStaff.filter(s => !!s.pfa).length;
        const noKids = present.length === 0;
        quals = {
          present_staff: presentStaff.length,
          ratio_staff: ratioStaff.length,
          level3_count: level3,
          level3_ok: noKids || level3 >= 1,
          l2plus_count: l2plus,
          half_l2_ok: noKids || presentStaff.length === 0 ? true : (l2plus * 2 >= presentStaff.length),
          pfa_count: pfa,
          pfa_ok: noKids || pfa >= 1,
        };
      } else if (typeof rs === 'number') { staffAvail = rs; staffSource = 'override'; }
      else if (rs && typeof rs === 'object' && rs[wd] != null && rs[wd] !== '') { staffAvail = Number(rs[wd]); staffSource = 'override'; }
      else { staffAvail = (await availableRatioStaff(db, dateStr, null)).length; staffSource = 'real'; }

      const ratioPass = staffAvail >= need;
      const qualsPass = !quals || (quals.level3_ok && quals.half_l2_ok && quals.pfa_ok);

      days.push({
        date: dateStr, weekday: wd,
        total_children: present.length, total_bands: totalBands,
        unassigned_count: unassigned.length,
        required_staff: totalRequired, spare_buffer: SPARE_BUFFER, staff_needed: need,
        staff_available: staffAvail, staff_source: staffSource,
        ratio_pass: ratioPass,
        quals,
        qualifications_pass: qualsPass,
        staffing_ok: ratioPass && qualsPass && !perRoom.some(r => r.over_capacity),
        rooms: perRoom,
        any_over_capacity: perRoom.some(r => r.over_capacity),
      });
    }

    res.json({ week_start: weekStart, ratios: RATIOS, spare_buffer: SPARE_BUFFER, staff_mode: hasStaffRoster ? 'roster' : 'count', rooms, days });
  } catch (e) {
    console.error('[occupancy-sandbox] simulate error:', e);
    res.status(500).json({ error: e.message });
  }
}

router.post('/:id/simulate', (req, res) => runSimulate(req, res, req.params.id));
router.post('/simulate', (req, res) => runSimulate(req, res, null));

module.exports = router;
