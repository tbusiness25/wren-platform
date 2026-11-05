'use strict';
// ===========================================================================
// ADMISSIONS / OCCUPANCY ENGINE (Prompt 47, 2026-06-30) — additive, read-mostly.
// The yield-management core for LADN. Spec: wren-docs/admissions-occupancy-spec.md.
//
// Builds ON TOP of the existing pieces (does NOT replace them):
//   • src/routes/occupancy.js          → month forecast + retrospective history
//   • src/routes/enquiries.js          → pipeline, AI scoring, occupancy-grid
//   • rooms (target/cap/legal)    → the capacity bands
//   • waiting_list / enquiries → demand
//   • children / attendance  → who's in, on what weekdays
//
// Capacity model (Toby, 2026-06-30):
//   Baby Room  : 10 hard, full-time only.
//   Pre-school : target 22 (green) · cap 26 (orange "close") · legal 28 (red) · >28 blocked.
//   Pre-school is part-time-friendly → modelled as SEAT-DAYS PER WEEKDAY, not one number.
//
// Everything here is mounted at /api/admissions-engine and is manager-gated.
// Writes are confined to waiting_list offer/tier/deposit fields and the two
// new children planning columns (notice_given_date / transfer_planned_date) —
// never to historical child/attendance data.
// ===========================================================================
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
// b289 — per-row "where did this child come from / what happens next".
const provenance = require('../lib/pipeline-provenance');
const closures = require('../lib/closures');   // b194 — bank holidays + settings.closure_dates
// b398 — the pipeline moves forward on its own, and never backwards.
const { advanceEnquiry, tryAdvanceToRegistered } = require('../lib/enquiry-stage');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
router.use(authenticate);

// b224 (2026-08-25): +deputy_manager, +admin. Toby: "three managers use this" —
// at LADN that includes the DEPUTY manager, who ran admissions daily and was
// getting a 403 from every button on this page (Offer / Park / Message / Update
// / Enrol / Remove). Widened to match src/routes/admissions-contacts.js and the
// codebase's usual ['manager','deputy_manager', 'admin'] management gate. Additive: no
// role that could reach these routes before has lost access.
const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'room_leader', 'headteacher', 'business_manager'])) return res.status(403).json({ error: 'Manager access required' });
  next();
};

// ── date helpers ────────────────────────────────────────────────────────────
const ymd = d => new Date(d).toISOString().slice(0, 10);
const ageMonths = (dob, at) => (new Date(at) - new Date(ymd(dob) + 'T00:00:00Z')) / (1000 * 60 * 60 * 24 * 30.4375);
function plusMonths(dateStr, n) { const t = new Date(dateStr + 'T00:00:00Z'); t.setUTCMonth(t.getUTCMonth() + n); return ymd(t); }
function plusDays(dateStr, n) { const t = new Date(dateStr + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return ymd(t); }
function monthKey(dateStr) { return dateStr.slice(0, 7); }
function isoDow(dateStr) { return ((new Date(dateStr + 'T00:00:00Z').getUTCDay()) + 6) % 7 + 1; } // 1=Mon..7=Sun
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];           // index 0..4 ↔ isoDow 1..5
const WEEKDAY_FROM_ISO = { 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri' };

// ── settings (engine policy knobs) ──────────────────────────────────────────
const DEFAULTS = {
  transfer_age_min_months: 22,   // baby→pre floor (spec fix: was hard-coded 24)
  transfer_age_max_months: 30,   // top of each baby's transfer window
  preschool_min_days_default: 3, // soft min days for a part-timer
  preschool_min_days_floor: 2,   // hard floor a manager can override down to
  leaver_notice_weeks: 6,
  offer_expiry_hours: 72,
  waitlist_depth_per_seat: 3,
  school_start_age_months: 60,   // age the seat naturally frees (reception)
  baby_room_max_age_at_start_months: 18, // baby-room waitlist cutoff: a child over
                                         // this at their expected start won't settle
                                         // before the ~24mo pre-school transfer.
};
async function loadSettings(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key = ANY($1)`, [Object.keys(DEFAULTS)]);
  const cfg = { ...DEFAULTS };
  for (const r of rows) { const n = Number(r.value); cfg[r.key] = Number.isFinite(n) ? n : DEFAULTS[r.key]; }
  return cfg;
}

// ── room model ──────────────────────────────────────────────────────────────
// Returns {baby, pre} each with id/name/target/cap/legal/fee and a band() classifier.
async function loadRooms(db, cfg) {
  const { rows } = await db.query(`
    SELECT id, name, min_age_months, max_age_months, capacity,
           COALESCE(target_capacity, capacity) AS target_capacity,
           COALESCE(legal_capacity, capacity)  AS legal_capacity,
           monthly_fee_pence
    FROM rooms ORDER BY min_age_months`);
  const baby = rows.find(r => r.min_age_months < cfg.transfer_age_min_months) || rows[0];
  const pre  = rows.find(r => r.id !== (baby && baby.id)) || rows[rows.length - 1];
  const shape = r => ({
    id: r.id, name: r.name,
    target: r.target_capacity, cap: r.capacity, legal: r.legal_capacity,
    monthly_fee_pence: r.monthly_fee_pence,
  });
  return { baby: shape(baby), pre: shape(pre), all: rows.map(shape) };
}
// green ≤target · orange target..cap · red cap..legal · over >legal
function bandFor(count, room) {
  if (count > room.legal) return 'over';
  if (count > room.cap) return 'red';
  if (count > room.target) return 'orange';
  return 'green';
}

// ── child weekday patterns (the EyLog-level part-time detail) ───────────────
// A child's usual weekdays are inferred from the attendance register over a
// lookback window. A weekday counts as "booked" if the child attended ≥40% of
// that weekday's open days. Children with no attendance rows use their agreed
// children.contracted_days (added 2026-07-06) if set, else full-time (all 5).
async function loadWeekdayPatterns(db, lookbackDays = 70) {
  const today = ymd(new Date());
  const from = plusDays(today, -lookbackDays);
  // b194: bank holidays and settings.closure_dates are dropped from BOTH the numerator and
  // the denominator. Leaving them in is what makes this heuristic lie: a closed Monday adds
  // an "open day" nobody attended, so a child's Monday ratio falls below the 0.4 threshold
  // and Monday silently disappears from their pattern.
  const closedDates = [...(await closures.loadClosures(db, from, today)).keys()];
  const { rows } = await db.query(`
    SELECT child_id, EXTRACT(ISODOW FROM date)::int AS dow, COUNT(*)::int AS n
    FROM attendance
    WHERE date BETWEEN $1::date AND $2::date AND COALESCE(absent,false)=false
      AND EXTRACT(ISODOW FROM date) <= 5
      AND NOT (date = ANY($3::date[]))
    GROUP BY child_id, EXTRACT(ISODOW FROM date)`, [from, today, closedDates]);
  const { rows: opens } = await db.query(`
    SELECT EXTRACT(ISODOW FROM date)::int AS dow, COUNT(DISTINCT date)::int AS opendays
    FROM attendance
    WHERE date BETWEEN $1::date AND $2::date AND EXTRACT(ISODOW FROM date) <= 5
      AND NOT (date = ANY($3::date[]))
    GROUP BY EXTRACT(ISODOW FROM date)`, [from, today, closedDates]);
  const openByDow = {}; for (const o of opens) openByDow[o.dow] = o.opendays;
  const byChild = new Map();
  for (const r of rows) {
    if (!byChild.has(r.child_id)) byChild.set(r.child_id, new Set());
    const denom = openByDow[r.dow] || 0;
    if (denom === 0 || r.n / denom >= 0.4) byChild.get(r.child_id).add(WEEKDAY_FROM_ISO[r.dow]);
  }
  // Children with no register history yet (future/confirmed starters) fall back
  // to their agreed contracted_days instead of the full-week default.
  const { rows: contracted } = await db.query(`
    SELECT id, contracted_days FROM children
    WHERE is_active=true AND contracted_days IS NOT NULL AND array_length(contracted_days,1) > 0
      AND COALESCE(is_demo, false) = false`);
  for (const c of contracted) {
    if (byChild.has(c.id) && byChild.get(c.id).size) continue; // real attendance wins
    byChild.set(c.id, new Set(c.contracted_days.filter(d => WEEKDAYS.includes(d))));
  }
  return byChild; // Map child_id -> Set('mon','wed',...)
}
function patternFor(byChild, childId) {
  const s = byChild.get(childId);
  return (s && s.size) ? [...s] : [...WEEKDAYS]; // unknown → full week
}

// ── active children (the live roster) ───────────────────────────────────────
async function loadChildren(db) {
  const { rows } = await db.query(`
    SELECT id, first_name, left(coalesce(last_name,''),1) AS li,
           room_id, date_of_birth AS dob, start_date, leave_date,
           notice_given_date, transfer_planned_date
    FROM children
    WHERE is_active=true AND date_of_birth IS NOT NULL AND COALESCE(is_demo, false) = false`);
  return rows;
}
const fullName = c => `${c.first_name} ${c.li}.`;

// Effective end date for a child: leave_date is authoritative; once notice is
// given the leave_date already holds the (brought-forward) notice-end date.
function effectiveLeave(c) { return c.leave_date ? ymd(c.leave_date) : null; }

// Which room a child is in at a given month-mid, honouring the transfer floor.
function roomAt(c, midS, rooms, cfg) {
  if (c.room_id === rooms.baby.id) {
    const tdate = c.transfer_planned_date ? ymd(c.transfer_planned_date)
      : plusMonths(ymd(c.dob), cfg.transfer_age_min_months);
    return tdate <= midS ? 'pre' : 'baby';
  }
  if (c.room_id === rooms.pre.id) return 'pre';
  return ageMonths(c.dob, midS) < cfg.transfer_age_min_months ? 'baby' : 'pre';
}

// =====================================================================
// GET /capacity — live capacity + bands + the policy knobs.
// =====================================================================
router.get('/capacity', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const cfg = await loadSettings(db);
    const rooms = await loadRooms(db, cfg);
    const { rows: counts } = await db.query(`
      SELECT room_id, COUNT(*)::int AS n FROM children WHERE is_active=true AND COALESCE(is_demo, false) = false GROUP BY room_id`);
    const byRoom = {}; counts.forEach(r => { byRoom[r.room_id] = r.n; });
    const out = [rooms.baby, rooms.pre].map(r => {
      const cur = byRoom[r.id] || 0;
      return {
        id: r.id, name: r.name, full_time_only: r.id === rooms.baby.id,
        target: r.target, cap: r.cap, legal: r.legal,
        monthly_fee_pence: r.monthly_fee_pence,
        current: cur, band: bandFor(cur, r),
        headroom_to_target: Math.max(0, r.target - cur),
        headroom_to_cap: Math.max(0, r.cap - cur),
        headroom_to_legal: Math.max(0, r.legal - cur),
      };
    });
    res.json({ generated: ymd(new Date()), settings: cfg, rooms: out });
  } catch (e) { console.error('[admissions-engine/capacity]', e); res.status(500).json({ error: e.message }); }
});

// =====================================================================
// GET /seat-grid?from=YYYY-MM&months=N — per-weekday seat-day grid.
// Baby room as a single FT number; pre-school broken out Mon..Fri so an
// over-subscribed single day is visible and can block a full-time offer.
// =====================================================================
router.get('/seat-grid', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const cfg = await loadSettings(db);
    const rooms = await loadRooms(db, cfg);
    const now = new Date();
    const fp = (req.query.from || '').match(/^(\d{4})-(\d{2})$/);
    const fromY = fp ? +fp[1] : now.getUTCFullYear();
    const fromM = fp ? +fp[2] - 1 : now.getUTCMonth();
    const months = Math.min(Math.max(parseInt(req.query.months) || 12, 1), 24);

    const kids = await loadChildren(db);
    const patterns = await loadWeekdayPatterns(db);

    const series = [];
    for (let k = 0; k < months; k++) {
      const d = new Date(Date.UTC(fromY, fromM + k, 1));
      const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      const mid = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15));
      const label = d.toISOString().slice(0, 7), first = ymd(d), last = ymd(mEnd), midS = ymd(mid);

      let babyN = 0; const byDay = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0 };
      let preHead = 0; const transfers = [], leavers = [];
      for (const c of kids) {
        const sd = c.start_date ? ymd(c.start_date) : null;
        const ld = effectiveLeave(c);
        const present = (!sd || sd <= last) && (!ld || ld >= first);
        if (ld && ld >= first && ld <= last) leavers.push({ id: c.id, name: fullName(c) });
        if (!present) continue;
        if (ageMonths(c.dob, mid) >= cfg.school_start_age_months && !ld) continue; // aged out
        const room = roomAt(c, midS, rooms, cfg);
        // transfer happening this month?
        if (c.room_id === rooms.baby.id) {
          const tdate = c.transfer_planned_date ? ymd(c.transfer_planned_date) : plusMonths(ymd(c.dob), cfg.transfer_age_min_months);
          if (tdate >= first && tdate <= last) transfers.push({ id: c.id, name: fullName(c), date: tdate });
        }
        if (room === 'baby') { babyN++; continue; }
        preHead++;
        for (const wd of patternFor(patterns, c.id)) byDay[wd]++;
      }
      const dayBands = {};
      let peakDay = 'mon', peakSeats = -1;
      for (const wd of WEEKDAYS) {
        const seats = byDay[wd];
        dayBands[wd] = {
          seats, band: bandFor(seats, rooms.pre),
          headroom_to_target: Math.max(0, rooms.pre.target - seats),
          headroom_to_cap: Math.max(0, rooms.pre.cap - seats),
        };
        if (seats > peakSeats) { peakSeats = seats; peakDay = wd; }
      }
      const ftEquiv = Math.round((WEEKDAYS.reduce((s, wd) => s + byDay[wd], 0) / 5) * 10) / 10;
      series.push({
        month: label,
        baby: { count: babyN, target: rooms.baby.target, cap: rooms.baby.cap, legal: rooms.baby.legal, band: bandFor(babyN, rooms.baby) },
        preschool: {
          headcount: preHead, ft_equivalent: ftEquiv,
          by_day: dayBands, peak_day: peakDay, peak_seats: peakSeats, peak_band: bandFor(peakSeats, rooms.pre),
        },
        transfers, leavers,
      });
    }
    res.json({
      generated: ymd(now), from: series[0].month, months,
      rooms: { baby: rooms.baby, preschool: rooms.pre },
      bands: { green: '≤target', orange: 'target..cap', red: 'cap..legal', over: '>legal (blocked)' },
      series,
    });
  } catch (e) { console.error('[admissions-engine/seat-grid]', e); res.status(500).json({ error: e.message }); }
});

// =====================================================================
// GET /transfer-windows — each baby's 22→30mo window + a suggested month
// timed to a REAL pre-school vacancy (don't hold seats empty).
// =====================================================================
router.get('/transfer-windows', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const cfg = await loadSettings(db);
    const rooms = await loadRooms(db, cfg);
    const kids = await loadChildren(db);
    const patterns = await loadWeekdayPatterns(db);
    const today = ymd(new Date());

    // Forward pre-school peak-day load per month (excluding babies not yet transferred),
    // so we can find the first month each baby's transfer would still leave headroom.
    const HORIZON = 18;
    const preLoadByMonth = {}; // month -> peak seats
    const fromY = new Date().getUTCFullYear(), fromM = new Date().getUTCMonth();
    for (let k = 0; k < HORIZON; k++) {
      const d = new Date(Date.UTC(fromY, fromM + k, 1));
      const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      const mid = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15));
      const label = d.toISOString().slice(0, 7), first = ymd(d), last = ymd(mEnd), midS = ymd(mid);
      const byDay = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0 };
      for (const c of kids) {
        const sd = c.start_date ? ymd(c.start_date) : null;
        const ld = effectiveLeave(c);
        if (!((!sd || sd <= last) && (!ld || ld >= first))) continue;
        if (ageMonths(c.dob, mid) >= cfg.school_start_age_months && !ld) continue;
        if (roomAt(c, midS, rooms, cfg) !== 'pre') continue;
        for (const wd of patternFor(patterns, c.id)) byDay[wd]++;
      }
      preLoadByMonth[label] = Math.max(...WEEKDAYS.map(wd => byDay[wd]));
    }

    const babies = kids.filter(c => roomAt(c, today, rooms, cfg) === 'baby' && c.room_id === rooms.baby.id);
    const out = babies.map(c => {
      const dob = ymd(c.dob);
      const winStart = plusMonths(dob, cfg.transfer_age_min_months);
      const winEnd = plusMonths(dob, cfg.transfer_age_max_months);
      // first month within window where pre-school still has headroom to cap
      let suggested = null, reason = '';
      for (let k = 0; k < HORIZON; k++) {
        const d = new Date(Date.UTC(fromY, fromM + k, 1));
        const label = d.toISOString().slice(0, 7);
        if (label < monthKey(winStart)) continue;
        if (label > monthKey(winEnd)) break;
        const peak = preLoadByMonth[label] ?? 0;
        if (peak < rooms.pre.cap) { suggested = label; reason = `pre-school peak ${peak}/${rooms.pre.cap} — headroom`; break; }
      }
      if (!suggested) { suggested = monthKey(winEnd); reason = `no headroom in window — hold to window end ${monthKey(winEnd)}`; }
      return {
        id: c.id, name: fullName(c), dob,
        age_months_now: Math.floor(ageMonths(c.dob, today)),
        window_start: winStart, window_end: winEnd,
        window_start_month: monthKey(winStart), window_end_month: monthKey(winEnd),
        planned_date: c.transfer_planned_date ? ymd(c.transfer_planned_date) : null,
        suggested_month: suggested, suggested_reason: reason,
      };
    }).sort((a, b) => a.window_start.localeCompare(b.window_start));
    res.json({ generated: today, transfer_age_min_months: cfg.transfer_age_min_months, transfer_age_max_months: cfg.transfer_age_max_months, babies: out });
  } catch (e) { console.error('[admissions-engine/transfer-windows]', e); res.status(500).json({ error: e.message }); }
});

// =====================================================================
// GET /vacancies?months=N — forward seat vacancies. A leaver's notice
// brings the vacancy FORWARD to the (effective) leave date; baby transfers
// free a baby seat and consume a pre seat.
// =====================================================================
router.get('/vacancies', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const cfg = await loadSettings(db);
    const rooms = await loadRooms(db, cfg);
    const kids = await loadChildren(db);
    const months = Math.min(Math.max(parseInt(req.query.months) || 12, 1), 24);
    const today = ymd(new Date());
    const horizonEnd = plusMonths(today, months);

    const vacancies = [];
    for (const c of kids) {
      const ld = effectiveLeave(c);
      if (!ld || ld < today || ld > horizonEnd) continue;
      const room = c.room_id === rooms.baby.id ? rooms.baby : rooms.pre;
      const vacancyDate = plusDays(ld, 1);
      const monthsToSchool = Math.max(0, cfg.school_start_age_months - ageMonths(c.dob, ld));
      vacancies.push({
        type: 'leaver', room_id: room.id, room: room.name,
        child_id: c.id, child_name: fullName(c),
        leave_date: ld, vacancy_opens: vacancyDate,
        notice_given: !!c.notice_given_date,
        notice_given_date: c.notice_given_date ? ymd(c.notice_given_date) : null,
        brought_forward: !!c.notice_given_date,
        fee_months_freed: Math.round(monthsToSchool * 10) / 10,
      });
    }
    // baby→pre transfers (free a baby seat, consume a pre seat)
    for (const c of kids) {
      if (c.room_id !== rooms.baby.id) continue;
      const tdate = c.transfer_planned_date ? ymd(c.transfer_planned_date) : plusMonths(ymd(c.dob), cfg.transfer_age_min_months);
      if (tdate < today || tdate > horizonEnd) continue;
      vacancies.push({
        type: 'transfer_out', room_id: rooms.baby.id, room: rooms.baby.name,
        child_id: c.id, child_name: fullName(c),
        leave_date: tdate, vacancy_opens: tdate,
        notice_given: false, brought_forward: false,
        fee_months_freed: null, note: 'baby seat frees on transfer up to pre-school',
      });
    }
    vacancies.sort((a, b) => a.vacancy_opens.localeCompare(b.vacancy_opens));
    res.json({
      generated: today, months,
      leaver_notice_weeks: cfg.leaver_notice_weeks,
      count: vacancies.length, vacancies,
    });
  } catch (e) { console.error('[admissions-engine/vacancies]', e); res.status(500).json({ error: e.message }); }
});

// =====================================================================
// GET /yield?months=N — value each pre-school vacancy by expected remaining
// fee-months and recommend the revenue-optimal fill (waitlist family or baby
// transfer) that maximises fee-months while keeping the day-grid balanced.
// =====================================================================
router.get('/yield', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const cfg = await loadSettings(db);
    const rooms = await loadRooms(db, cfg);
    const kids = await loadChildren(db);
    const months = Math.min(Math.max(parseInt(req.query.months) || 12, 1), 24);
    const today = ymd(new Date());
    const horizonEnd = plusMonths(today, months);
    const feePerMonth = rooms.pre.monthly_fee_pence || 0;

    // pre-school vacancies (leavers only — those are the seats to refill)
    const vac = kids.filter(c => {
      const ld = effectiveLeave(c);
      return c.room_id === rooms.pre.id && ld && ld >= today && ld <= horizonEnd;
    }).map(c => ({ vacancy_date: plusDays(effectiveLeave(c), 1), from_child: fullName(c), from_id: c.id }));

    // candidate fills: active waitlist (pre-school) + babies ready to transfer
    const { rows: wl } = await db.query(`
      SELECT id, child_first_name, child_last_name, child_dob, room_needed,
             expected_start_date, COALESCE(days_needed,5) AS days_needed,
             COALESCE(tier,'active') AS tier, COALESCE(ready_reserve,false) AS ready_reserve
      FROM waiting_list_live
      WHERE COALESCE(status,'waiting') NOT IN ('placed','declined','lost','withdrawn')
        AND COALESCE(tier,'active')='active'`);
    const waitCands = wl
      .filter(w => !w.room_needed || /pre|school/i.test(w.room_needed))
      .map(w => ({
        kind: 'waitlist', id: w.id,
        name: `${w.child_first_name} ${(w.child_last_name || '').slice(0, 1)}.`,
        dob: w.child_dob ? ymd(w.child_dob) : null,
        days_needed: Number(w.days_needed) || 5,
        ready_reserve: w.ready_reserve,
        available_from: w.expected_start_date ? ymd(w.expected_start_date) : today,
      }));
    const babyCands = kids.filter(c => c.room_id === rooms.baby.id).map(c => {
      const tWin = plusMonths(ymd(c.dob), cfg.transfer_age_min_months);
      return {
        kind: 'transfer', id: c.id, name: fullName(c), dob: ymd(c.dob),
        days_needed: 5, ready_reserve: false, available_from: tWin > today ? tWin : today,
      };
    });

    // Fully-loaded cost of one EY practitioner-month (salary + on-costs). Tunable via
    // settings.staff_cost_per_month_pence; used to price the mixed-age ratio trade-off.
    const STAFF_COST_PER_MONTH_PENCE = Number(cfg.staff_cost_per_month_pence) || 220000;
    const ageAtStartOf = (cand, vacancyDate) => {
      const start = cand.available_from > vacancyDate ? cand.available_from : vacancyDate;
      return cand.dob ? ageMonths(cand.dob, start) : 24;
    };
    function feeMonths(cand, vacancyDate) {
      const ageAtStart = ageAtStartOf(cand, vacancyDate);
      const remaining = Math.max(0, cfg.school_start_age_months - ageAtStart);
      const ptFactor = Math.min(1, (Number(cand.days_needed) || 5) / 5);
      return Math.round(remaining * ptFactor * 10) / 10;
    }
    // Ratio cost of the mixed-age group: an under-2 needs 1:3 and a 2yo needs 1:5, both
    // richer (more staff/child) than the 1:8 for a 3–4yo. A younger just-turned-2 stays
    // longer (more fees) BUT spends their first year+ in the costlier band. This prices that
    // extra staffing so the AI ranks on NET value, not fees alone. Returns pence.
    function ratioCostPence(cand, vacancyDate) {
      if (!cand.dob) return 0;
      const ageAtStart = ageAtStartOf(cand, vacancyDate);
      const ptFactor = Math.min(1, (Number(cand.days_needed) || 5) / 5);
      const school = cfg.school_start_age_months;
      const inBand = (lo, hi) => Math.max(0, Math.min(hi, school) - Math.max(lo, ageAtStart));
      const mUnder2 = inBand(0, 24);   // 1:3 band
      const m2yo    = inBand(24, 36);  // 1:5 band
      const extraStaffMonths = (mUnder2 * (1 / 3 - 1 / 8) + m2yo * (1 / 5 - 1 / 8)) * ptFactor;
      return Math.round(extraStaffMonths * STAFF_COST_PER_MONTH_PENCE);
    }

    const out = vac.map(v => {
      const candidates = [...waitCands, ...babyCands].map(c => {
        const fm = feeMonths(c, v.vacancy_date);
        const feeVal = Math.round(fm * feePerMonth);
        const rc = ratioCostPence(c, v.vacancy_date);
        const ageAtStart = Math.round(ageAtStartOf(c, v.vacancy_date));
        const yr = m => `${Math.floor(m / 12)}y${m % 12}m`;
        const note = c.dob
          ? `Starts ~${yr(ageAtStart)} · ${fm} fee-months` +
            (rc > 0 ? ` · −£${Math.round(rc / 100)} extra ratio cost (younger = richer ratio for ~${Math.max(0, 36 - ageAtStart)}m)`
                    : ` · no extra ratio cost (already 3+, on 1:8)`)
          : `${fm} fee-months`;
        return {
          ...c, fee_months: fm,
          fee_value_pence: feeVal,
          ratio_cost_pence: rc,
          net_value_pence: feeVal - rc,
          age_at_start_months: ageAtStart,
          value_note: note,
          starts_late_days: c.available_from > v.vacancy_date
            ? Math.round((new Date(c.available_from) - new Date(v.vacancy_date)) / 86400000) : 0,
        };
      }).sort((a, b) =>
        b.net_value_pence - a.net_value_pence ||
        (b.ready_reserve - a.ready_reserve) ||
        a.starts_late_days - b.starts_late_days);
      return {
        vacancy_date: v.vacancy_date, from_child: v.from_child,
        recommended: candidates[0] || null,
        candidates: candidates.slice(0, 6),
      };
    }).sort((a, b) => a.vacancy_date.localeCompare(b.vacancy_date));

    res.json({
      generated: today, months, monthly_fee_pence: feePerMonth,
      school_start_age_months: cfg.school_start_age_months,
      vacancies: out,
    });
  } catch (e) { console.error('[admissions-engine/yield]', e); res.status(500).json({ error: e.message }); }
});

// =====================================================================
// GET /heatmap?from=YYYY-MM&months=N — forward availability per month×room,
// demand-weighted (hotter = more interest), with an honest probability of a
// space. Heat 0 (cold/open) → 1 (hot/contested). Click a cell → enquiry (UI).
// =====================================================================
router.get('/heatmap', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const cfg = await loadSettings(db);
    const rooms = await loadRooms(db, cfg);
    const kids = await loadChildren(db);
    const patterns = await loadWeekdayPatterns(db);
    const now = new Date();
    const fp = (req.query.from || '').match(/^(\d{4})-(\d{2})$/);
    const fromY = fp ? +fp[1] : now.getUTCFullYear();
    const fromM = fp ? +fp[2] - 1 : now.getUTCMonth();
    const months = Math.min(Math.max(parseInt(req.query.months) || 12, 1), 24);

    // demand per room/month: active enquiries + active waitlist targeting a month.
    const { rows: enq } = await db.query(`
      SELECT COALESCE(preferred_room, room_needed) AS room_name,
             TO_CHAR(COALESCE(preferred_start_date, start_date_requested), 'YYYY-MM') AS month
      FROM enquiries
      WHERE stage NOT IN ('registered','declined','lost')`);
    const { rows: wl } = await db.query(`
      SELECT room_needed AS room_name, TO_CHAR(expected_start_date,'YYYY-MM') AS month
      FROM waiting_list_live
      WHERE COALESCE(status,'waiting') NOT IN ('placed','declined','lost','withdrawn')
        AND COALESCE(tier,'active')='active'`);
    const demand = {}; // `${roomId}:${month}` -> count
    const addDemand = (roomName, month) => {
      if (!month) return;
      const r = /pre|school/i.test(roomName || '') ? rooms.pre : /bab/i.test(roomName || '') ? rooms.baby : null;
      if (!r) return;
      demand[`${r.id}:${month}`] = (demand[`${r.id}:${month}`] || 0) + 1;
    };
    enq.forEach(e => addDemand(e.room_name, e.month));
    wl.forEach(w => addDemand(w.room_name, w.month));

    const series = [];
    for (let k = 0; k < months; k++) {
      const d = new Date(Date.UTC(fromY, fromM + k, 1));
      const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      const mid = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15));
      const label = d.toISOString().slice(0, 7), first = ymd(d), last = ymd(mEnd), midS = ymd(mid);
      let babyN = 0; const byDay = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0 };
      for (const c of kids) {
        const sd = c.start_date ? ymd(c.start_date) : null;
        const ld = effectiveLeave(c);
        if (!((!sd || sd <= last) && (!ld || ld >= first))) continue;
        if (ageMonths(c.dob, mid) >= cfg.school_start_age_months && !ld) continue;
        const room = roomAt(c, midS, rooms, cfg);
        if (room === 'baby') babyN++;
        else for (const wd of patternFor(patterns, c.id)) byDay[wd]++;
      }
      const cells = [rooms.baby, rooms.pre].map(r => {
        const isPre = r.id === rooms.pre.id;
        const load = isPre ? Math.max(...WEEKDAYS.map(wd => byDay[wd])) : babyN;
        const headroom = Math.max(0, r.cap - load);
        const dem = demand[`${r.id}:${label}`] || 0;
        // honest p(space): headroom shrinks as demand competes for it.
        const prob = headroom <= 0 ? 0 : Math.max(0, Math.min(1, (headroom - dem) / headroom));
        // heat: hotter with more demand relative to headroom; full room = max heat.
        const heat = headroom <= 0 ? 1 : Math.max(0, Math.min(1, dem / (headroom + dem || 1)));
        return {
          room_id: r.id, room: r.name, load, headroom_to_cap: headroom,
          band: bandFor(load, r), demand: dem,
          heat: Math.round(heat * 100) / 100,
          prob_space: Math.round(prob * 100) / 100,
        };
      });
      series.push({ month: label, rooms: cells });
    }
    res.json({ generated: ymd(now), from: series[0].month, months, series });
  } catch (e) { console.error('[admissions-engine/heatmap]', e); res.status(500).json({ error: e.message }); }
});

// =====================================================================
// WAITLIST — tiers, capped depth, expiring offers, deposits, ready-reserve.
// Offers auto-expire on READ (no cron needed): an 'offered' row past its
// expiry is reported as 'expired' so the next in line surfaces.
// =====================================================================
function liveOfferStatus(row, now) {
  if (row.offer_status === 'offered' && row.offer_expires_at && new Date(row.offer_expires_at) < now) {
    return 'expired';
  }
  return row.offer_status || null;
}

router.get('/waitlist', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const cfg = await loadSettings(db);
    await ensureWaitlistCommsColumns(db);
    const now = new Date();
    const { rows } = await db.query(`
      SELECT w.id, w.child_first_name, w.child_last_name, w.child_dob, w.room_needed,
             w.expected_start_date, w.parent_name, w.parent_phone, w.parent_email,
             (SELECT x.ey_number FROM waiting_list x WHERE x.id = w.id) AS ey_number,  -- b532
             COALESCE(w.priority,3) AS priority, COALESCE(w.tier,'active') AS tier,
             COALESCE(w.days_needed,5) AS days_needed, COALESCE(w.min_days,$1) AS min_days,
             w.preferred_days, w.notes, w.source, w.enquiry_id,
             COALESCE(w.deposit_paid,false) AS deposit_paid, w.deposit_amount_pence,
             COALESCE(w.deposit_required,true) AS deposit_required,
             COALESCE(w.ready_reserve,false) AS ready_reserve,
             w.offer_made_at, w.offer_expires_at, w.offer_status, w.seat_depth, w.status, w.date_added,
             w.last_contacted_at, w.last_contacted_by, w.room_source, w.family_key,
             e.replied_at AS enquiry_replied_at, e.message AS enquiry_message,
             e.created_at AS enquiry_created_at,
             -- b428 — the Waiting list tab's new Enquired column: same fallback
             -- order as pipeline-status.js/enquiries.js's waiting-list GET.
             COALESCE(w.enquiry_submitted_at, e.enquiry_submitted_at) AS enquiry_submitted_at,
             COALESCE(w.enquiry_date_source, e.enquiry_date_source) AS enquiry_date_source
      FROM waiting_list_live w
      LEFT JOIN enquiries e ON e.id = w.enquiry_id
      WHERE COALESCE(w.status,'waiting') NOT IN ('placed','declined','lost','withdrawn')
      ORDER BY COALESCE(w.tier,'active') ASC, COALESCE(w.priority,3) ASC, w.date_added ASC`,
      [cfg.preschool_min_days_default]);

    const babyMax = cfg.baby_room_max_age_at_start_months || 18;
    // b289 — one query, then O(1) per row. Answers "is this child already
    // registered in Wren, or is somebody still expected to do that?" — which the
    // nightly EyLog sync will never do on its own. See src/lib/pipeline-provenance.js.
    const enrolIdx = await provenance.loadEnrolmentIndex(db);
    const enrich = rows.map(r => {
      const status = liveOfferStatus(r, now);
      // Baby-room age-out: a baby-room waitlist child who will be OVER babyMax months
      // at their expected start won't settle before the ~24mo pre-school transfer.
      const isBaby = /bab/i.test(r.room_needed || '');
      let ageAtStart = null, babyAgeOut = false;
      if (isBaby && r.child_dob && r.expected_start_date) {
        ageAtStart = Math.round(ageMonths(r.child_dob, ymd(r.expected_start_date)) * 10) / 10;
        babyAgeOut = ageAtStart > babyMax;
      }
      return {
        ...r,
        offer_status: status,
        offer_expired: status === 'expired',
        offer_live: status === 'offered',
        hours_left: (status === 'offered' && r.offer_expires_at)
          ? Math.max(0, Math.round((new Date(r.offer_expires_at) - now) / 3600000)) : null,
        age_at_start_months: ageAtStart,
        baby_age_out: babyAgeOut,
        baby_max_age_at_start: babyMax,
        // Comms indicator: most recent of an enquiry reply or a direct waitlist
        // message (logged into notes by POST /waitlist/:id/message below).
        last_contacted: [r.enquiry_replied_at, r.last_contacted_at]
          .filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null,
        ...provenance.describe(r, enrolIdx),
      };
    });
    const active = enrich.filter(r => r.tier === 'active');
    const parked = enrich.filter(r => r.tier === 'parked');
    res.json({
      generated: ymd(new Date()),
      depth_cap: cfg.waitlist_depth_per_seat, offer_expiry_hours: cfg.offer_expiry_hours,
      min_days_default: cfg.preschool_min_days_default, min_days_floor: cfg.preschool_min_days_floor,
      baby_max_age_at_start_months: babyMax,
      summary: {
        active_count: active.length, parked_count: parked.length,
        ready_reserve_count: enrich.filter(r => r.ready_reserve).length,
        live_offers: enrich.filter(r => r.offer_live).length,
        expired_offers: enrich.filter(r => r.offer_expired).length,
        deposits_held: enrich.filter(r => r.deposit_paid).length,
        age_out_count: enrich.filter(r => r.baby_age_out).length,
        // b289 — the two numbers the office manager actually needs off this screen.
        needs_registering_count: enrich.filter(r => r.pipeline_state === 'needs_registering').length,
        already_registered_count: enrich.filter(r => r.pipeline_state === 'registered').length,
        no_room_count: enrich.filter(r => r.room_status !== 'set').length,
      },
      active, parked,
    });
  } catch (e) { console.error('[admissions-engine/waitlist]', e); res.status(500).json({ error: e.message }); }
});

// POST /waitlist/:id/offer  — make a time-boxed offer (now + offer_expiry_hours)
router.post('/waitlist/:id/offer', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const cfg = await loadSettings(db);
    const hrs = Number(req.body && req.body.hours) || cfg.offer_expiry_hours;
    const { rows } = await db.query(`
      UPDATE waiting_list
      SET offer_made_at=NOW(), offer_expires_at=NOW() + ($2 || ' hours')::interval,
          offer_status='offered'
      WHERE id=$1 RETURNING id, offer_made_at, offer_expires_at, offer_status, enquiry_id`,
      [req.params.id, String(hrs)]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    // b398 — the pipeline card now moves with the waiting-list action that caused it.
    if (rows[0].enquiry_id) {
      await advanceEnquiry(db, rows[0].enquiry_id, 'offer_made', { req, reason: 'offer made' });
    }
    res.json({ ok: true, offer: rows[0] });
  } catch (e) { console.error('[admissions-engine/offer]', e); res.status(500).json({ error: e.message }); }
});

// POST /waitlist/:id/respond  {action:'accept'|'release'}
router.post('/waitlist/:id/respond', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const action = (req.body && req.body.action) || '';
    const status = action === 'accept' ? 'accepted' : action === 'release' ? 'released' : null;
    if (!status) return res.status(400).json({ error: "action must be 'accept' or 'release'" });
    const { rows } = await db.query(`
      UPDATE waiting_list SET offer_status=$2 WHERE id=$1
      RETURNING id, offer_status, enquiry_id`, [req.params.id, status]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    // b531 (the admissions lead, 27 Oct) — accepting the offer keeps the card on Allocated:
    // "Forms & deposit" means both have actually come in (enquiry-stage.js),
    // not that the family said yes. Declining the offer moves the card to
    // Declined — her table: "people who were offered a place but did not take
    // it". A person's explicit decision, so it is set here, not by advanceEnquiry.
    if (action === 'release' && rows[0].enquiry_id) {
      await db.query(
        `UPDATE enquiries SET stage='declined', updated_at=NOW()
          WHERE id=$1 AND stage IN ('offer_made','offer_accepted')`, [rows[0].enquiry_id]);
    }
    res.json({ ok: true, offer: rows[0] });
  } catch (e) { console.error('[admissions-engine/respond]', e); res.status(500).json({ error: e.message }); }
});

// POST /waitlist/:id/tier  {tier:'active'|'parked'}
router.post('/waitlist/:id/tier', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const tier = (req.body && req.body.tier) || '';
    if (!['active', 'parked'].includes(tier)) return res.status(400).json({ error: "tier must be 'active' or 'parked'" });
    const { rows } = await db.query(
      `UPDATE waiting_list SET tier=$2 WHERE id=$1 RETURNING id, tier`, [req.params.id, tier]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, entry: rows[0] });
  } catch (e) { console.error('[admissions-engine/tier]', e); res.status(500).json({ error: e.message }); }
});

// POST /waitlist/:id/deposit  {paid:bool, amount_pence:int, required:bool}
router.post('/waitlist/:id/deposit', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const paid = !!(req.body && req.body.paid);
    const amt = req.body && req.body.amount_pence != null ? parseInt(req.body.amount_pence) : null;
    // b424 — "required" lets a manager mark a funded-only family as not needing a
    // deposit at all (the D badge then shows grey, not a permanent red "unpaid").
    const required = req.body && req.body.required != null ? !!req.body.required : null;
    const { rows } = await db.query(
      `UPDATE waiting_list SET deposit_paid=$2, deposit_amount_pence=$3,
              deposit_required=COALESCE($4, deposit_required)
       WHERE id=$1 RETURNING id, deposit_paid, deposit_amount_pence, deposit_required, enquiry_id`,
      [req.params.id, paid, amt, required]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    // b424 — the deposit may be the half that was still missing for Registered
    // (the registration form could already be in). A no-op if the form isn't in yet.
    if (rows[0].enquiry_id && (paid || required === false)) {
      await tryAdvanceToRegistered(db, rows[0].enquiry_id, { req, reason: 'deposit settled' });
    }
    res.json({ ok: true, entry: rows[0] });
  } catch (e) { console.error('[admissions-engine/deposit]', e); res.status(500).json({ error: e.message }); }
});

// POST /waitlist/:id/ready-reserve  {ready:bool}
router.post('/waitlist/:id/ready-reserve', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const ready = !!(req.body && req.body.ready);
    const { rows } = await db.query(
      `UPDATE waiting_list SET ready_reserve=$2 WHERE id=$1 RETURNING id, ready_reserve`,
      [req.params.id, ready]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, entry: rows[0] });
  } catch (e) { console.error('[admissions-engine/ready-reserve]', e); res.status(500).json({ error: e.message }); }
});

// POST /waitlist/:id/remove  {reason?} — withdraw a waitlist entry (e.g. baby-room
// age-out). Additive, non-destructive: sets status='withdrawn' + appends a note.
router.post('/waitlist/:id/remove', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const reason = (req.body && req.body.reason) || null;
    const { rows } = await db.query(
      `UPDATE waiting_list
         SET status='withdrawn',
             notes = COALESCE(notes,'') ||
                     CASE WHEN $2::text IS NOT NULL THEN E'\n[removed ' || CURRENT_DATE || '] ' || $2 ELSE '' END
       WHERE id=$1 RETURNING id, status`, [req.params.id, reason]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, entry: rows[0] });
    // b399 (2026-10-06) — a withdrawn waiting-list entry loses its enquiry-mode portal access.
    require('../lib/enquiry-access').closeEnquiryAccess(db, { waitingListId: req.params.id, reason: reason || 'waiting-list entry withdrawn' }).catch(() => {});
  } catch (e) { console.error('[admissions-engine/remove]', e); res.status(500).json({ error: e.message }); }
});

// PATCH /waitlist/:id — edit the editable waiting-list fields (2026-07-28,
// additive "manage waiting list" build). Whitelisted columns only; never
// touches offer/tier/deposit/status (those have their own dedicated routes
// above) so this can't be used to sneak around the other write paths.
const WL_EDITABLE_FIELDS = [
  'child_first_name', 'child_last_name', 'child_dob', 'room_needed',
  'expected_start_date', 'parent_name', 'parent_email', 'parent_phone',
  'source', 'notes', 'priority', 'days_needed', 'preferred_days', 'min_days',
];
router.patch('/waitlist/:id', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const body = req.body || {};
    const sets = [];
    const vals = [req.params.id];
    for (const f of WL_EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        vals.push(body[f] === '' ? null : body[f]);
        sets.push(`${f} = $${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No editable fields supplied' });
    if (body.priority != null && !(body.priority >= 1 && body.priority <= 5)) {
      return res.status(400).json({ error: 'priority must be 1-5' });
    }
    const { rows } = await db.query(
      `UPDATE waiting_list SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    // 3 Nov 2026: the family's Pipeline card carries the same details — keep it in step
    // (src/lib/family-details.js), or an email added here never reaches the card.
    if (rows[0].enquiry_id) {
      const FD = require('../lib/family-details');
      const changed = {};
      // From the request, as written above ('' = cleared), not from rows[0]: pg hands date
      // columns back as JS Dates, which can land a day out once re-serialised.
      for (const f of FD.WAITLIST_FIELDS) if (Object.prototype.hasOwnProperty.call(body, f)) changed[f] = body[f] === '' ? null : body[f];
      try { await FD.mirrorToEnquiry(db, rows[0].enquiry_id, changed); }
      catch (e) { console.error('[admissions-engine/waitlist-patch] enquiry not updated:', e.message); }
    }
    res.json({ ok: true, entry: rows[0] });
  } catch (e) { console.error('[admissions-engine/waitlist-patch]', e); res.status(500).json({ error: e.message }); }
});

// POST /waitlist/:id/message — email the waiting-list parent directly (2026-07-28).
// Reuses the same Gmail-API-first send path as the enquiries/comms reply routes
// (src/lib/gmail-sender.js → src/utils/email.js fallback). Explicit send only —
// no auto-send anywhere in this route. Logs a note on the waiting_list row and
// stamps last_contacted_at (additive columns, added on first use below) so the
// waitlist view can show a "last contacted" indicator without needing a linked
// enquiry.
let _wlColumnsEnsured = false;
async function ensureWaitlistCommsColumns(db) {
  if (_wlColumnsEnsured) return;
  await db.query(`ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz`);
  await db.query(`ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS last_contacted_by integer`);
  _wlColumnsEnsured = true;
}
router.post('/waitlist/:id/message', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { subject, body } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body required' });
    // b289: this route emails a real family, so a merged (tombstoned) row is
    // refused here rather than merely hidden from the list that produced the id.
    const { rows: wlRows } = await db.query(
      `SELECT * FROM waiting_list WHERE id=$1 AND merged_into_id IS NULL`, [req.params.id]);
    if (!wlRows.length) return res.status(404).json({ error: 'not found' });
    const w = wlRows[0];
    const recipient = (w.parent_email || '').trim();
    if (!recipient) return res.status(400).json({ error: 'This waiting-list entry has no parent email address' });

    const subj = subject && String(subject).trim() ? String(subject).trim() : 'Your Nursery — your waiting list place';
    const html = `<div style="font-family:system-ui,Arial,sans-serif;line-height:1.6">${String(body).replace(/\n/g, '<br>')}</div>`;
    let sent = false, info = '';
    try {
      const gmail = require('../lib/gmail-sender');
      if (gmail.isConfigured && gmail.isConfigured()) {
        const r = await gmail.sendViaGmail({ to: recipient, subject: subj, html, text: body });
        sent = !!(r && r.ok); info = r && r.messageId ? `gmail:${r.messageId}` : 'gmail';
      }
    } catch (gerr) { console.error('[admissions-engine/waitlist-message] gmail failed:', gerr.message); }
    if (!sent) {
      try {
        const { sendEmail } = require('../utils/email');
        const r = await sendEmail({ to: recipient, subject: subj, html, text: body });
        sent = !(r && r.skipped); info = info || 'smtp';
      } catch (merr) { return res.status(502).json({ error: 'Send failed: ' + merr.message }); }
    }
    if (!sent) return res.status(502).json({ error: 'Send failed (no transport delivered the message — check SMTP/Gmail config)' });

    await ensureWaitlistCommsColumns(db);
    await db.query(
      `UPDATE waiting_list
         SET last_contacted_at = NOW(), last_contacted_by = $2,
             notes = COALESCE(notes,'') || E'\n[messaged ' || CURRENT_DATE || '] ' || $3
       WHERE id=$1`,
      [req.params.id, req.user.id, subj]);
    res.json({ ok: true, sent_to: recipient, via: info });
  } catch (e) { console.error('[admissions-engine/waitlist-message]', e); res.status(500).json({ error: e.message }); }
});

// =====================================================================
// RESERVE READY (2026-07-16, additive) — for every available space, hold a
// ranked OFFER (#1) + up to two RESERVES (#2/#3) from the FULL waiting list.
// If #1 declines, #2 auto-promotes (declines are simply filtered out on read,
// so the next candidate becomes the effective offer — no renumbering needed).
//
// Schema addition (additive, idempotent): ladn.space_offers stores only manager
// DECISIONS (declined / accepted) keyed by (space_key, waitlist_id). The ranked
// roster itself is recomputed live each read from the current waiting list, so it
// never goes stale as new families join. CREATE TABLE IF NOT EXISTS on first use.
// =====================================================================
async function ensureSpaceOffers(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS space_offers (
      id           serial PRIMARY KEY,
      space_key    text NOT NULL,
      room_id      integer,
      waitlist_id  integer NOT NULL,
      decision     text NOT NULL,              -- 'declined' | 'accepted'
      note         text,
      created_at   timestamptz DEFAULT now()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS space_offers_key_idx ON space_offers(space_key)`);
}

// deterministic candidate score (higher = better fit for a spare seat)
function scoreCandidate(w, availableFrom, today) {
  let score = 0;
  score += (6 - Math.min(5, Math.max(1, w.priority || 3))) * 20;   // priority 1 → +100
  if (w.deposit_paid) score += 40;
  if (w.ready_reserve) score += 15;
  const days = Math.min(5, Math.max(1, w.days_needed || 5));
  score += days * 4;                                               // more days = more revenue
  const waitDays = Math.max(0, Math.round((new Date(today) - new Date(w.date_added || today)) / 86400000));
  score += Math.min(30, waitDays / 7);
  if (w.es && w.es <= availableFrom) score += 20;                  // can start when the seat opens
  return Math.round(score * 10) / 10;
}

// GET /reserve-ready?months=N — spaces (open-now seats + upcoming leaver/transfer
// vacancies) each with a ranked offer + reserves drawn from the waiting list.
router.get('/reserve-ready', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    await ensureSpaceOffers(db);
    const cfg = await loadSettings(db);
    const rooms = await loadRooms(db, cfg);
    const kids = await loadChildren(db);
    const today = ymd(new Date());
    const months = Math.min(Math.max(parseInt(req.query.months) || 6, 1), 18);
    const horizonEnd = plusMonths(today, months);
    const babyMax = cfg.baby_room_max_age_at_start_months || 18;
    const roomById = new Map(rooms.all.map(r => [r.id, r]));

    const { rows: counts } = await db.query(
      `SELECT room_id, COUNT(*)::int AS n FROM children WHERE is_active=true AND COALESCE(is_demo, false) = false GROUP BY room_id`);
    const cur = {}; counts.forEach(c => { cur[c.room_id] = c.n; });

    // ── build available spaces ──────────────────────────────────────────
    const spaces = [];
    for (const r of [rooms.baby, rooms.pre]) {
      const free = Math.max(0, r.cap - (cur[r.id] || 0));
      const n = Math.min(free, 6);                          // cap the seat fan-out
      for (let i = 0; i < n; i++) spaces.push({
        space_key: `now:${r.id}:${i}`, room_id: r.id, room_name: r.name,
        available_from: today, source: 'open_now', label: `${r.name} — open now (seat ${i + 1} of ${free})`,
      });
    }
    for (const c of kids) {                                 // leaver vacancies
      const ld = effectiveLeave(c);
      if (ld && ld >= today && ld <= horizonEnd) {
        const room = c.room_id === rooms.baby.id ? rooms.baby : rooms.pre;
        spaces.push({
          space_key: `leaver:${c.id}`, room_id: room.id, room_name: room.name,
          available_from: plusDays(ld, 1), source: 'leaver', label: `${room.name} — ${fullName(c)} leaving ${ld}`,
        });
      }
    }
    for (const c of kids) {                                 // baby→pre transfers free a baby seat
      if (c.room_id !== rooms.baby.id) continue;
      const tdate = c.transfer_planned_date ? ymd(c.transfer_planned_date) : plusMonths(ymd(c.dob), cfg.transfer_age_min_months);
      if (tdate >= today && tdate <= horizonEnd) spaces.push({
        space_key: `transfer:${c.id}`, room_id: rooms.baby.id, room_name: rooms.baby.name,
        available_from: tdate, source: 'transfer', label: `${rooms.baby.name} — ${fullName(c)} transfers up ${tdate}`,
      });
    }
    spaces.sort((a, b) => a.available_from.localeCompare(b.available_from));

    // ── waiting list candidates ─────────────────────────────────────────
    const { rows: wl } = await db.query(`
      SELECT id, child_first_name, left(coalesce(child_last_name,''),1) AS li, child_dob,
             room_needed, expected_start_date::text AS es, COALESCE(priority,3) AS priority,
             COALESCE(days_needed,5) AS days_needed, COALESCE(deposit_paid,false) AS deposit_paid,
             COALESCE(ready_reserve,false) AS ready_reserve, date_added::text AS date_added
      FROM waiting_list_live WHERE COALESCE(status,'waiting')='waiting'`);
    const { rows: dec } = await db.query(`SELECT space_key, waitlist_id, decision FROM space_offers`);
    const declined = new Set(dec.filter(d => d.decision === 'declined').map(d => `${d.space_key}:${d.waitlist_id}`));
    const acceptedBySpace = new Map(dec.filter(d => d.decision === 'accepted').map(d => [d.space_key, d.waitlist_id]));
    const acceptedIds = new Set(dec.filter(d => d.decision === 'accepted').map(d => d.waitlist_id));

    const roomForWl = w => {
      const n = (w.room_needed || '').toLowerCase();
      if (/bab/.test(n)) return rooms.baby.id;
      if (/pre|school/.test(n)) return rooms.pre.id;
      return (w.child_dob && ageMonths(w.child_dob, today) < cfg.transfer_age_min_months) ? rooms.baby.id : rooms.pre.id;
    };
    const byRoom = new Map([[rooms.baby.id, []], [rooms.pre.id, []]]);
    for (const w of wl) {
      const rid = roomForWl(w);
      const es = w.es || today;
      const isBaby = rid === rooms.baby.id;
      const ageAtStart = w.child_dob ? Math.round(ageMonths(w.child_dob, es > today ? es : today) * 10) / 10 : null;
      if (isBaby && ageAtStart != null && ageAtStart > babyMax) continue;   // aged out — never reserve
      if (acceptedIds.has(w.id)) continue;                                  // already placed elsewhere
      w._rid = rid; w._es = es; w._name = `${w.child_first_name} ${w.li}.`;
      w._score = scoreCandidate({ ...w, es }, today, today);
      if (byRoom.has(rid)) byRoom.get(rid).push(w);
    }
    for (const list of byRoom.values())
      list.sort((a, b) => b._score - a._score || String(a.date_added || '').localeCompare(String(b.date_added || '')));

    // assign distinct candidates across each room's spaces (offer + 2 reserves each)
    const cursor = new Map();
    const mkCand = (w, rank, room) => {
      const days = Math.min(5, Math.max(1, w.days_needed));
      return {
        waitlist_id: w.id, name: w._name, rank, role: rank === 1 ? 'offer' : 'reserve',
        age_months: w.child_dob ? Math.round(ageMonths(w.child_dob, w._es > today ? w._es : today)) : null,
        expected_start_date: w.es, days_per_week: days,
        priority: w.priority, deposit_paid: w.deposit_paid, ready_reserve: w.ready_reserve,
        est_month_gbp: Math.round(((room.monthly_fee_pence || 0) / 100) * (days / 5)),
        score: w._score,
      };
    };
    const spacesOut = spaces.map(sp => {
      const list = byRoom.get(sp.room_id) || [];
      const room = roomById.get(sp.room_id) || {};
      let idx = cursor.get(sp.room_id) || 0;
      const picks = [];
      while (list[idx] && picks.length < 3) {
        const w = list[idx]; idx++;
        if (declined.has(`${sp.space_key}:${w.id}`)) continue;   // #1 declined → next auto-promotes
        picks.push(w);
      }
      cursor.set(sp.room_id, idx);
      const accepted = acceptedBySpace.get(sp.space_key) ?? null;
      return {
        ...sp, filled: accepted != null, accepted_waitlist_id: accepted,
        offer: picks[0] ? mkCand(picks[0], 1, room) : null,
        reserves: picks.slice(1).map((w, i) => mkCand(w, i + 2, room)),
      };
    });

    res.json({
      generated: today, months, baby_max_age_at_start_months: babyMax,
      spaces_count: spacesOut.length,
      open_now: spacesOut.filter(s => s.source === 'open_now').length,
      upcoming: spacesOut.filter(s => s.source !== 'open_now').length,
      note: 'Each available space holds a ranked offer (#1) + up to two reserves (#2/#3) from the full waiting list. Decline the offer and reserve #2 auto-promotes. Aged-out baby-room children are excluded. Ranking is deterministic (priority, deposit, ready-reserve, days/revenue, wait time, ready-to-start).',
      spaces: spacesOut,
    });
  } catch (e) { console.error('[admissions-engine/reserve-ready]', e); res.status(500).json({ error: e.message }); }
});

// POST /reserve-ready/decline  {space_key, waitlist_id, note?} — record a decline;
// on the next read the next reserve becomes the effective offer automatically.
router.post('/reserve-ready/decline', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    await ensureSpaceOffers(db);
    const { space_key, waitlist_id, note } = req.body || {};
    if (!space_key || !waitlist_id) return res.status(400).json({ error: 'space_key and waitlist_id required' });
    await db.query(`INSERT INTO space_offers (space_key, waitlist_id, decision, note) VALUES ($1,$2,'declined',$3)`,
      [space_key, waitlist_id, note || null]);
    res.json({ ok: true });
  } catch (e) { console.error('[admissions-engine/rr-decline]', e); res.status(500).json({ error: e.message }); }
});

// POST /reserve-ready/promote  {space_key, waitlist_id, room_id?} — accept this
// candidate into the space (marks it filled; flags the waitlist offer accepted).
router.post('/reserve-ready/promote', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    await ensureSpaceOffers(db);
    const { space_key, waitlist_id, room_id } = req.body || {};
    if (!space_key || !waitlist_id) return res.status(400).json({ error: 'space_key and waitlist_id required' });
    await db.query(`INSERT INTO space_offers (space_key, waitlist_id, room_id, decision) VALUES ($1,$2,$3,'accepted')`,
      [space_key, waitlist_id, room_id || null]);
    await db.query(`UPDATE waiting_list SET offer_status='accepted' WHERE id=$1`, [waitlist_id]);
    res.json({ ok: true });
  } catch (e) { console.error('[admissions-engine/rr-promote]', e); res.status(500).json({ error: e.message }); }
});

// b531 (the admissions lead, 27 Oct) — the deposit paragraph that goes in the same email as
// the registration form. the admissions lead types it once ("Save this wording"), Wren
// pre-fills it every time after. The bank details already in Settings come back
// with it so the first draft isn't blank.
router.get('/deposit-wording', managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT key, value FROM settings WHERE key = ANY($1)`,
      [['admissions_deposit_wording', 'payment_bank_account_name', 'payment_bank_sort_code', 'payment_bank_account_number']]);
    const v = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({
      wording: v.admissions_deposit_wording || '',
      bank: { account_name: v.payment_bank_account_name || '', sort_code: v.payment_bank_sort_code || '', account_number: v.payment_bank_account_number || '' },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/deposit-wording', managerOnly, async (req, res) => {
  const wording = String((req.body && req.body.wording) || '').slice(0, 4000);
  try {
    await getPool().query(
      `INSERT INTO settings (key, value) VALUES ('admissions_deposit_wording', $1)
       ON CONFLICT (key) DO UPDATE SET value=$1`, [wording]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
