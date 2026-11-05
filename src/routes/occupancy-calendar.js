'use strict';
// ===========================================================================
// OCCUPANCY CALENDAR (EyMan-style weekly grid) — 2026-07-15, additive.
//
// The week-by-week, per-room, Mon–Fri (AM/PM) occupancy grid the owner wants,
// PLUS decision tooling EyMan doesn't have:
//   • GET  /grid       — weeks × rooms × weekday grid (Places Occupied +
//                        Available Spaces + FTE + %), children starting /
//                        waitlisted per week, colour bands. Load-More via ?start.
//   • GET  /waitlist   — the FULL waiting list (not just next 3) for the drag tray,
//                        each with age band + a deterministic revenue estimate.
//   • POST /impact     — "drop this waitlisted child on this room/week": is it
//                        ratio-legal? what % does it fill? est. revenue gained.
//                        Mirrors the absence /preview transparency pattern.
//   • POST /suggest    — ranked "who to offer next" (deterministic maths; optional
//                        LOCAL-Ollama plain-English summary, never the numbers/PII).
//
// DATA SOURCES (reused, read-only):
//   ladn.child_bookings  — §55 booked weekday register (mon..fri bits, room_id).
//                          Bookings are WHOLE-DAY here, so AM==PM per day (the grid
//                          keeps the AM/PM split so half-day sessions drop in later).
//   ladn.rooms           — capacity / target_capacity / legal_capacity / fee.
//   ladn.waiting_list    — real waitlist (status, room_needed, expected_start,
//                          preferred_days, dob, priority, deposit).
//   ladn.funding_terms   — funded hourly rates for the revenue estimate.
//   src/services/ratio-engine — the SAME ratio maths the rota + absence tools use.
// Read-only. Mounts at /api/occupancy-calendar (see server-unified.js).
// ===========================================================================
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const ratioEngine = require('../services/ratio-engine');
// b194: bank holidays + settings.closure_dates. ladn.bank_holidays already held
// 2026-08-31 "Summer bank holiday" but nothing in occupancy read it, so the grid showed a
// full Baby Room on a day the nursery was shut.
const closures = require('../lib/closures');
const ai = require('../lib/ai-models');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);
const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'admin', 'room_leader'])) return res.status(403).json({ error: 'Manager access required' });
  next();
};

const DOWS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const SESSION_HOURS = 10;           // 8am–6pm operating day
const WEEKS_PER_MONTH = 52 / 12;
const FUNDED_HOURS = { under2: 0, two: 15, threePlus: 15 }; // baseline weekly funded entitlement
// Plain-English summary over pre-computed numbers → ai-models.js role 'heavy',
// resolved per call. (b333: was OCCUPANCY_AI_MODEL / gpt-oss:120b, no longer installed.)
const AI_MODEL = () => ai.model('heavy');
const OLLAMA_HOST = ai.host();

const pad = n => String(n).padStart(2, '0');
function ymd(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function mondayOf(dateStr) { const d = new Date(dateStr + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return ymd(d); }
function ageMonths(dob, atStr) { if (!dob) return null; return (new Date(atStr + 'T00:00:00Z') - new Date(ymd(new Date(dob)) + 'T00:00:00Z')) / (1000 * 60 * 60 * 24 * 30.4375); }
function bandOfDob(dob, atStr) { return dob ? ratioEngine.ageBandOn(dob, atStr) : 'threePlus'; }

// colour band for occupancy vs a room's ceilings (green free · amber near · red full · over)
function occBand(occ, room) {
  if (occ > room.legal_capacity) return 'over';
  if (occ >= room.capacity) return 'red';
  if (occ >= (room.target_capacity || room.capacity)) return 'amber';
  return 'green';
}

async function loadRooms(db) {
  const { rows } = await db.query(`
    SELECT id, name, capacity,
           COALESCE(target_capacity, capacity) AS target_capacity,
           COALESCE(legal_capacity,  capacity) AS legal_capacity,
           COALESCE(monthly_fee_pence, 0) AS monthly_fee_pence,
           ratio_children_per_staff, min_age_months
    FROM rooms ORDER BY min_age_months, id`);
  return rows.map(r => ({ ...r, capacity: +r.capacity, target_capacity: +r.target_capacity, legal_capacity: +r.legal_capacity, monthly_fee_pence: +r.monthly_fee_pence }));
}

async function loadActiveBookings(db) {
  const { rows } = await db.query(`
    SELECT b.child_id, b.room_id, b.mon, b.tue, b.wed, b.thu, b.fri,
           b.start_date::text AS start_date, b.end_date::text AS end_date,
           c.date_of_birth::text AS dob
    FROM child_bookings b
    JOIN children c ON c.id = b.child_id
    WHERE b.is_active = true AND COALESCE(c.is_active, true) = true`);
  return rows;
}

// ── b314 (2026-09-10) — the children the register cannot see ────────────────
// Occupancy is computed entirely from child_bookings. A child who is enrolled
// and attending but has no live booking row is therefore in NOBODY's count: the
// board shows a room emptier than it is, and the ratios computed off that board
// ask for fewer staff than the room needs. At the time of the audit that was 5
// live children on production — 4 Baby Room, 1 Pre-school.
//
// The board does NOT guess their days from children.room_id. A booking says
// WHICH DAYS a child comes and a profile does not, so inventing five full-time
// children would over-count exactly as badly as omitting them. Instead the grid
// now says so out loud, per room, and names the ids so a manager can fix the
// bookings. Under-counting a ratio silently is the one outcome that is not
// allowed.
async function notBookedChildren(db, onDate) {
  const { rows } = await db.query(`
    SELECT c.id, c.room_id, r.name AS room_name
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
     WHERE COALESCE(c.is_active, true) = true
       AND COALESCE(c.is_demo, false) = false
       AND (c.leave_date IS NULL OR c.leave_date >= $1::date)
       AND NOT EXISTS (
         SELECT 1 FROM child_bookings b
          WHERE b.child_id = c.id AND b.is_active = true
            AND (b.end_date IS NULL OR b.end_date >= $1::date))
     ORDER BY c.room_id NULLS LAST, c.id`, [onDate]);
  const by_room = {};
  for (const r of rows) {
    const k = r.room_id == null ? 'none' : String(r.room_id);
    (by_room[k] || (by_room[k] = { room_id: r.room_id, room_name: r.room_name || 'No room set', count: 0, child_ids: [] }));
    by_room[k].count++;
    by_room[k].child_ids.push(r.id);          // ids only — never a name
  }
  return { total: rows.length, by_room: Object.values(by_room),
    note: rows.length
      ? `${rows.length} enrolled child(ren) have no live booking, so they are not in any figure on this board.`
      : 'Every enrolled child has a live booking.' };
}

// booked children in a room on a given date (from the whole-day register).
// `closed` is the Map from src/lib/closures — a closed date has NOBODY in, whatever the
// register says, so it returns empty before any booking is considered.
function occupiedOn(bookings, roomId, dateStr, closed) {
  if (closed && closed.has(dateStr)) return [];
  const dow = (new Date(dateStr + 'T00:00:00Z').getUTCDay() + 6) % 7; // 0=Mon
  if (dow > 4) return [];
  const bit = DOWS[dow];
  const out = [];
  for (const b of bookings) {
    if (b.room_id !== roomId) continue;
    if (!b[bit]) continue;
    if (b.start_date && dateStr < b.start_date) continue;
    if (b.end_date && dateStr > b.end_date) continue;
    out.push(b);
  }
  return out;
}

async function currentFundingTerm(db, dateStr) {
  const { rows } = await db.query(`
    SELECT * FROM funding_terms
    WHERE $1::date BETWEEN start_date AND end_date
    ORDER BY start_date DESC LIMIT 1`, [dateStr]);
  if (rows.length) return rows[0];
  const { rows: latest } = await db.query(`SELECT * FROM funding_terms ORDER BY end_date DESC LIMIT 1`);
  return latest[0] || null;
}

// Deterministic weekly revenue estimate for a child in a room on `daysPerWeek` days.
// Splits into funded (entitlement hours × term rate) + private (remaining hours × a
// per-hour rate derived from the room's monthly fee). All clearly an ESTIMATE.
function estimateRevenue(room, band, daysPerWeek, term) {
  const rateKey = band === 'threePlus' ? 'rate_3yr_universal' : band === 'two' ? 'rate_2yr_working_parents' : 'rate_under_2';
  const fundedRate = term ? Number(term[rateKey]) || 0 : 0;
  const fundedHours = Math.min(FUNDED_HOURS[band] || 0, daysPerWeek * SESSION_HOURS);
  const fundedWeek = fundedHours * fundedRate;
  const totalHours = daysPerWeek * SESSION_HOURS;
  const privateHours = Math.max(0, totalHours - fundedHours);
  // full-time (5×10h) hours per month → per-hour private rate from the monthly fee
  const ftHoursMonth = 5 * SESSION_HOURS * WEEKS_PER_MONTH;
  const privateHourly = ftHoursMonth ? (room.monthly_fee_pence / 100) / ftHoursMonth : 0;
  const privateWeek = privateHours * privateHourly;
  const week = fundedWeek + privateWeek;
  return {
    days_per_week: daysPerWeek,
    funded_hours_week: Math.round(fundedHours * 10) / 10,
    funded_rate_per_hour: Math.round(fundedRate * 100) / 100,
    funded_week_gbp: Math.round(fundedWeek * 100) / 100,
    private_hours_week: Math.round(privateHours * 10) / 10,
    private_rate_per_hour: Math.round(privateHourly * 100) / 100,
    private_week_gbp: Math.round(privateWeek * 100) / 100,
    total_week_gbp: Math.round(week * 100) / 100,
    est_month_gbp: Math.round(week * WEEKS_PER_MONTH * 100) / 100,
    term: term ? term.name : null,
  };
}

// normalise waiting_list.preferred_days (['Monday','tue',...]) to canonical mon..fri
function normDays(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const v of arr) { const s = String(v).toLowerCase().slice(0, 3); if (DOWS.includes(s) && !out.includes(s)) out.push(s); }
  return out;
}
// which weekdays would this waitlist child take: preferred if known, else first N days
function targetDaysFor(w) {
  const pref = normDays(w.preferred_days);
  if (pref.length) return pref;
  const n = Math.max(1, Math.min(5, w.days_needed || w.min_days || 3));
  return DOWS.slice(0, n);
}
function roomForNeeded(rooms, roomNeeded, dob, atStr) {
  if (roomNeeded) { const m = rooms.find(r => r.name.toLowerCase() === String(roomNeeded).toLowerCase()); if (m) return m; }
  // fall back to age: <24mo → baby room, else pre-school
  const am = ageMonths(dob, atStr);
  if (am != null && am < 24) return rooms[0];
  return rooms[rooms.length - 1];
}

// ── GET /grid?start=YYYY-MM-DD&weeks=N ──────────────────────────────────────
router.get('/grid', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const today = ymd(new Date());
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '') ? mondayOf(req.query.start) : mondayOf(today);
    const nWeeks = Math.min(Math.max(parseInt(req.query.weeks) || 4, 1), 12);

    const rooms = await loadRooms(db);
    const bookings = await loadActiveBookings(db);
    const closedDays = await closures.loadClosures(db, start, addDays(start, nWeeks * 7));
    const notBooked = await notBookedChildren(db, start > today ? start : today);   // b314
    const { rows: waitRows } = await db.query(`
      SELECT id, room_needed, expected_start_date::text AS expected_start_date,
             child_dob::text AS dob, status, left(child_first_name,1) AS fi,
             left(coalesce(child_last_name,''),1) AS li
      FROM waiting_list_live WHERE status IN ('waiting','placed')`);

    const weeks = [];
    for (let w = 0; w < nWeeks; w++) {
      const weekStart = addDays(start, w * 7);
      const weekEnd = addDays(weekStart, 4);
      const roomsOut = rooms.map(room => {
        const days = {};
        let occSum = 0, openDays = 0;
        for (let d = 0; d < 5; d++) {
          const dateStr = addDays(weekStart, d);
          const closedWhy = closedDays.get(dateStr) || null;
          const occ = occupiedOn(bookings, room.id, dateStr, closedDays).length;
          const avail = closedWhy ? 0 : room.capacity - occ;
          days[DOWS[d]] = {
            date: dateStr, occupied: occ, available: avail,
            am: occ, pm: occ,               // whole-day register → AM==PM
            pct: closedWhy ? 0 : Math.round((occ / room.capacity) * 100),
            band: closedWhy ? 'closed' : occBand(occ, room),
            closed: !!closedWhy, closure: closedWhy,
          };
          if (!closedWhy) { occSum += occ; openDays++; }
        }
        // Averaged over the OPEN days: a bank-holiday week is a 4-day week, and dividing
        // its occupancy by 5 would understate every room in it.
        const avgOcc = openDays ? occSum / openDays : 0;
        return {
          room_id: room.id, name: room.name,
          capacity: room.capacity, target_capacity: room.target_capacity, legal_capacity: room.legal_capacity,
          days,
          avg_occupied: Math.round(avgOcc * 10) / 10,
          avg_available: Math.round((room.capacity - avgOcc) * 10) / 10,
          avg_pct: Math.round((avgOcc / room.capacity) * 100),
          fte: Math.round(avgOcc * 10) / 10,  // FTE ≈ mean daily occupancy (whole-day places)
          band: occBand(Math.round(avgOcc), room),
        };
      });

      // children starting this week (booking start_date OR waitlist expected_start)
      const starting = [];
      for (const b of bookings) {
        if (b.start_date && b.start_date >= weekStart && b.start_date <= weekEnd) {
          const room = rooms.find(r => r.id === b.room_id);
          starting.push({ kind: 'booked', child_id: b.child_id, room: room ? room.name : null, date: b.start_date, band: bandOfDob(b.dob, b.start_date) });
        }
      }
      for (const wl of waitRows) {
        if (wl.expected_start_date && wl.expected_start_date >= weekStart && wl.expected_start_date <= weekEnd) {
          starting.push({ kind: 'waitlist', waitlist_id: wl.id, initials: (wl.fi + wl.li).toUpperCase(), room: wl.room_needed, date: wl.expected_start_date, status: wl.status, band: bandOfDob(wl.dob, wl.expected_start_date) });
        }
      }
      // waitlisted whose expected start is on/before this week's end (i.e. relevant now), per room
      const waitByRoom = {};
      for (const wl of waitRows) {
        if (wl.status !== 'waiting') continue;
        if (wl.expected_start_date && wl.expected_start_date > weekEnd) continue;
        const key = wl.room_needed || 'Unassigned';
        waitByRoom[key] = (waitByRoom[key] || 0) + 1;
      }

      weeks.push({
        week_start: weekStart, week_end: weekEnd,
        label: new Date(weekStart + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
        rooms: roomsOut,
        starting: starting.sort((a, b) => a.date.localeCompare(b.date)),
        starting_count: starting.length,
        waitlisted_by_room: waitByRoom,
        waitlisted_count: Object.values(waitByRoom).reduce((s, n) => s + n, 0),
      });
    }

    res.json({
      generated: today, start, weeks: nWeeks, next_start: addDays(start, nWeeks * 7),
      rooms: rooms.map(r => ({ id: r.id, name: r.name, capacity: r.capacity, target_capacity: r.target_capacity, legal_capacity: r.legal_capacity })),
      bands: { green: '≤ target', amber: 'target..cap', red: 'at/over capacity', over: '> legal (blocked)', closed: 'setting closed' },
      closures: Object.fromEntries(closedDays),
      not_booked: notBooked,   // b314 — children this board cannot see, said out loud
      note: 'Occupancy from the §55 child_bookings register (whole-day, so AM=PM). Available = capacity − occupied. '
          + 'Bank holidays (bank_holidays) and settings.closure_dates read 0 and are averaged out of the week.'
          + (notBooked.total ? ' ⚠ ' + notBooked.note : ''),
      data: weeks,
    });
  } catch (e) { console.error('[occupancy-calendar/grid]', e); res.status(500).json({ error: e.message }); }
});

// ── GET /waitlist — full waiting list for the drag tray ─────────────────────
router.get('/waitlist', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const today = ymd(new Date());
    const includePlaced = req.query.include === 'placed';
    const rooms = await loadRooms(db);
    const term = await currentFundingTerm(db, today);
    const { rows } = await db.query(`
      SELECT id, child_first_name, left(coalesce(child_last_name,''),1) AS li,
             child_dob::text AS dob, room_needed, expected_start_date::text AS expected_start_date,
             preferred_days, days_needed, min_days, priority, deposit_paid, tier, status,
             date_added::text AS date_added
      FROM waiting_list_live
      WHERE status = ANY($1)
      ORDER BY priority ASC, date_added ASC`, [includePlaced ? ['waiting', 'placed'] : ['waiting']]);

    const list = rows.map(w => {
      const atStr = w.expected_start_date && w.expected_start_date > today ? w.expected_start_date : today;
      const band = bandOfDob(w.dob, atStr);
      const room = roomForNeeded(rooms, w.room_needed, w.dob, atStr);
      const days = targetDaysFor(w);
      const rev = estimateRevenue(room, band, days.length, term);
      return {
        waitlist_id: w.id,
        name: `${w.child_first_name} ${w.li}.`,
        room_needed: w.room_needed, room_id: room.id, room_name: room.name,
        age_band: band, age_months: w.dob ? Math.round(ageMonths(w.dob, atStr)) : null,
        expected_start_date: w.expected_start_date,
        target_days: days, days_per_week: days.length,
        priority: w.priority, deposit_paid: w.deposit_paid, tier: w.tier, status: w.status,
        est_revenue: rev,
      };
    });
    res.json({ generated: today, count: list.length, term: term ? term.name : null, waitlist: list });
  } catch (e) { console.error('[occupancy-calendar/waitlist]', e); res.status(500).json({ error: e.message }); }
});

// core impact maths for one candidate on one room+week (reused by /impact and /suggest)
async function computeImpact(db, rooms, bookings, term, w, roomId, weekStart) {
  const room = rooms.find(r => r.id === roomId) || roomForNeeded(rooms, w.room_needed, w.dob, weekStart);
  const closedDays = await closures.loadClosures(db, weekStart, addDays(weekStart, 6));
  const days = targetDaysFor(w);
  const perDay = [];
  let ratioLegalAll = true, capacityOkAll = true, fillSum = 0;
  for (const dn of days) {
    const dIdx = DOWS.indexOf(dn);
    const dateStr = addDays(weekStart, dIdx);
    // A closed day is not a place that can be offered — skip it rather than counting a
    // phantom vacancy (and rather than asking the ratio engine about a day with no session).
    if (closedDays.has(dateStr)) {
      perDay.push({ day: dn, date: dateStr, closed: true, closure: closedDays.get(dateStr),
        occupied_now: 0, occupied_after: 0, available_after: 0,
        within_capacity: false, within_legal: false, ratio_legal: true });
      continue;
    }
    const occNow = occupiedOn(bookings, room.id, dateStr, closedDays).length;
    const occAfter = occNow + 1;
    const capacityOk = occAfter <= room.legal_capacity;
    const withinTarget = occAfter <= room.capacity;
    if (!capacityOk) capacityOkAll = false;
    // ratio: reuse the shared engine's per-date check, then add this child's band
    const chk = await ratioEngine.checkDate(db, dateStr, null);
    const band = bandOfDob(w.dob, dateStr);
    const bandsAfter = { under2: chk.booked.under2, two: chk.booked.two, threePlus: chk.booked.threePlus };
    bandsAfter[band] = (bandsAfter[band] || 0) + 1;
    const reqAfter = ratioEngine.requiredStaff(bandsAfter);
    const needAfter = reqAfter + (chk.need - chk.required); // preserve the +1 spare buffer
    const ratioLegal = chk.available >= needAfter;
    if (!ratioLegal) ratioLegalAll = false;
    fillSum += occAfter / room.capacity;
    perDay.push({
      day: dn, date: dateStr, occupied_now: occNow, occupied_after: occAfter,
      available_after: room.capacity - occAfter, within_capacity: withinTarget, within_legal: capacityOk,
      staff_available: chk.available, staff_needed_after: needAfter, ratio_legal: ratioLegal,
    });
  }
  const band = bandOfDob(w.dob, weekStart);
  const rev = estimateRevenue(room, band, days.length, term);
  // Average the fill over the days actually assessed — a closed day contributes no
  // occupancy and must not drag the mean down as if the room sat empty.
  const openDays = perDay.filter(d => !d.closed).length;
  const closedDays_ = perDay.filter(d => d.closed);
  return {
    room: { id: room.id, name: room.name, capacity: room.capacity, legal_capacity: room.legal_capacity },
    target_days: days, per_day: perDay,
    ratio_legal: ratioLegalAll, capacity_ok: capacityOkAll,
    avg_fill_after_pct: openDays ? Math.round((fillSum / openDays) * 100) : 0,
    closed_days: closedDays_.map(d => ({ date: d.date, closure: d.closure })),
    est_revenue: rev, age_band: band,
  };
}

// ── POST /impact  { waitlist_id, room_id?, week_start?, ai? } ───────────────
router.post('/impact', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { waitlist_id, room_id, week_start, ai } = req.body || {};
    if (!waitlist_id) return res.status(400).json({ error: 'waitlist_id required' });
    const today = ymd(new Date());
    const rooms = await loadRooms(db);
    const bookings = await loadActiveBookings(db);
    const { rows } = await db.query(`
      SELECT id, child_first_name, left(coalesce(child_last_name,''),1) AS li, child_dob::text AS dob,
             room_needed, expected_start_date::text AS expected_start_date, preferred_days, days_needed, min_days, priority
      FROM waiting_list WHERE id=$1`, [waitlist_id]);
    if (!rows.length) return res.status(404).json({ error: 'waitlist entry not found' });
    const w = rows[0];
    const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(week_start || '')
      ? mondayOf(week_start)
      : mondayOf(w.expected_start_date && w.expected_start_date > today ? w.expected_start_date : today);
    const term = await currentFundingTerm(db, weekStart);
    const targetRoom = room_id ? Number(room_id) : roomForNeeded(rooms, w.room_needed, w.dob, weekStart).id;

    const impact = await computeImpact(db, rooms, bookings, term, w, targetRoom, weekStart);
    const verdict = !impact.capacity_ok ? 'blocked_capacity' : !impact.ratio_legal ? 'needs_staff' : 'ok';

    let ai_summary = null;
    if (ai) {
      ai_summary = await aiSummary(
        `A nursery manager is considering offering a place to a waitlisted child (age band ${impact.age_band}) in ${impact.room.name} starting week ${weekStart}, ${impact.target_days.join('/')} (${impact.target_days.length} days/week). ` +
        `Room capacity ${impact.room.capacity}. After adding, average fill ${impact.avg_fill_after_pct}%. ` +
        `Ratio-legal on all days: ${impact.ratio_legal ? 'yes' : 'NO'}. Within capacity: ${impact.capacity_ok ? 'yes' : 'NO'}. ` +
        `Estimated income £${impact.est_revenue.total_week_gbp}/week (£${impact.est_revenue.est_month_gbp}/month). ` +
        `In 2 short sentences, give the manager a plain-English recommendation. Do not invent numbers; the manager decides.`);
    }

    res.json({
      waitlist_id: w.id, child: `${w.child_first_name} ${w.li}.`, week_start: weekStart,
      verdict, ...impact, ai_summary,
      disclaimer: 'Decision support only. Ratio uses the statutory engine (+1 spare buffer); revenue is an estimate from funding rates + room fee. The manager decides.',
    });
  } catch (e) { console.error('[occupancy-calendar/impact]', e); res.status(500).json({ error: e.message }); }
});

// ── POST /suggest  { week_start?, limit?, ai? } — ranked who-to-offer-next ───
router.post('/suggest', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const today = ymd(new Date());
    const weekStart = /^\d{4}-\d{2}-\d{2}$/.test((req.body || {}).week_start || '') ? mondayOf(req.body.week_start) : mondayOf(today);
    const limit = Math.min(Math.max(parseInt((req.body || {}).limit) || 5, 1), 15);
    const rooms = await loadRooms(db);
    const bookings = await loadActiveBookings(db);
    const term = await currentFundingTerm(db, weekStart);
    const { rows } = await db.query(`
      SELECT id, child_first_name, left(coalesce(child_last_name,''),1) AS li, child_dob::text AS dob,
             room_needed, expected_start_date::text AS expected_start_date, preferred_days, days_needed, min_days,
             priority, deposit_paid, date_added::text AS date_added
      FROM waiting_list_live WHERE status='waiting'`);

    const scored = [];
    for (const w of rows) {
      const room = roomForNeeded(rooms, w.room_needed, w.dob, weekStart);
      const impact = await computeImpact(db, rooms, bookings, term, w, room.id, weekStart);
      // deterministic score: legal fit + revenue + priority + deposit + wait time
      let score = 0; const reasons = [];
      if (impact.capacity_ok && impact.ratio_legal) { score += 100; reasons.push('fits legally on all requested days'); }
      else if (impact.capacity_ok) { score += 40; reasons.push('room has space but needs extra staff for ratio'); }
      else { score += 0; reasons.push('room over capacity on one or more days'); }
      const revMonth = impact.est_revenue.est_month_gbp;
      score += Math.min(60, revMonth / 20);           // revenue, capped
      reasons.push(`≈ £${revMonth}/month`);
      score += (6 - (w.priority || 3)) * 5;            // priority 1 best
      if (w.deposit_paid) { score += 15; reasons.push('deposit paid'); }
      const waitDays = Math.max(0, Math.round((new Date(today) - new Date(w.date_added)) / 86400000));
      score += Math.min(15, waitDays / 14);
      if (waitDays > 30) reasons.push(`waiting ${waitDays} days`);
      if (w.expected_start_date && w.expected_start_date <= addDays(weekStart, 6)) reasons.push('wants to start now');
      scored.push({
        waitlist_id: w.id, name: `${w.child_first_name} ${w.li}.`,
        room: impact.room.name, age_band: impact.age_band, target_days: impact.target_days,
        ratio_legal: impact.ratio_legal, capacity_ok: impact.capacity_ok,
        avg_fill_after_pct: impact.avg_fill_after_pct,
        est_month_gbp: revMonth, priority: w.priority, deposit_paid: w.deposit_paid,
        expected_start_date: w.expected_start_date,
        score: Math.round(score * 10) / 10, reasons,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    let ai_summary = null;
    if ((req.body || {}).ai) {
      const lines = top.map((s, i) => `${i + 1}. ${s.room} place, age ${s.age_band}, ${s.target_days.length} days, ${s.ratio_legal && s.capacity_ok ? 'legal fit' : s.capacity_ok ? 'needs staff' : 'over capacity'}, ≈£${s.est_month_gbp}/mo`).join('\n');
      ai_summary = await aiSummary(
        `A nursery manager wants to fill spare places from the waiting list for week ${weekStart}. This deterministic ranking was computed by rules (legal ratio fit first, then revenue, priority, deposit, wait time). Do NOT reorder. In 3-4 short sentences, summarise the recommendation warmly and note that any child needing extra staff or over capacity should not be offered until cover is arranged. The manager decides.\n\nRanking:\n${lines}`);
    }

    res.json({
      week_start: weekStart, count: scored.length, suggestions: top, ai_summary,
      disclaimer: 'Decision support only. Ranking is deterministic; the optional summary is written by a LOCAL model and never changes the order or invents numbers.',
    });
  } catch (e) { console.error('[occupancy-calendar/suggest]', e); res.status(500).json({ error: e.message }); }
});

// LOCAL-Ollama plain-English helper. Fails soft (returns null). Never sends child/parent
// names — callers pass age band / room / days / £ only.
async function aiSummary(prompt) {
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL(), stream: false, think: false, prompt, options: ai.options({ temperature: 0.3, num_predict: 300 }) }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) return null;
    return ((await resp.json()).response || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;
  } catch (e) { console.error('[occupancy-calendar] aiSummary failed (non-fatal):', e.message); return null; }
}

module.exports = router;
