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
router.use(authenticate);

const managerOnly = (req, res, next) => {
  if (!['manager', 'room_leader'].includes(req.user.role)) return res.status(403).json({ error: 'Manager access required' });
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
  const { rows } = await db.query(`
    SELECT child_id, EXTRACT(ISODOW FROM date)::int AS dow, COUNT(*)::int AS n
    FROM attendance
    WHERE date BETWEEN $1::date AND $2::date AND COALESCE(absent,false)=false
      AND EXTRACT(ISODOW FROM date) <= 5
    GROUP BY child_id, EXTRACT(ISODOW FROM date)`, [from, today]);
  const { rows: opens } = await db.query(`
    SELECT EXTRACT(ISODOW FROM date)::int AS dow, COUNT(DISTINCT date)::int AS opendays
    FROM attendance
    WHERE date BETWEEN $1::date AND $2::date AND EXTRACT(ISODOW FROM date) <= 5
    GROUP BY EXTRACT(ISODOW FROM date)`, [from, today]);
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
    WHERE is_active=true AND contracted_days IS NOT NULL AND array_length(contracted_days,1) > 0`);
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
    WHERE is_active=true AND date_of_birth IS NOT NULL`);
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
      SELECT room_id, COUNT(*)::int AS n FROM children WHERE is_active=true GROUP BY room_id`);
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
      FROM waiting_list
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

    function feeMonths(cand, vacancyDate) {
      const start = cand.available_from > vacancyDate ? cand.available_from : vacancyDate;
      const ageAtStart = cand.dob ? ageMonths(cand.dob, start) : 24;
      const remaining = Math.max(0, cfg.school_start_age_months - ageAtStart);
      const ptFactor = Math.min(1, (Number(cand.days_needed) || 5) / 5);
      return Math.round(remaining * ptFactor * 10) / 10;
    }

    const out = vac.map(v => {
      const candidates = [...waitCands, ...babyCands].map(c => {
        const fm = feeMonths(c, v.vacancy_date);
        return {
          ...c, fee_months: fm,
          fee_value_pence: Math.round(fm * feePerMonth),
          starts_late_days: c.available_from > v.vacancy_date
            ? Math.round((new Date(c.available_from) - new Date(v.vacancy_date)) / 86400000) : 0,
        };
      }).sort((a, b) =>
        b.fee_value_pence - a.fee_value_pence ||
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
      FROM waiting_list
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
    const now = new Date();
    const { rows } = await db.query(`
      SELECT id, child_first_name, child_last_name, child_dob, room_needed,
             expected_start_date, parent_name, parent_phone, parent_email,
             COALESCE(priority,3) AS priority, COALESCE(tier,'active') AS tier,
             COALESCE(days_needed,5) AS days_needed, COALESCE(min_days,$1) AS min_days,
             COALESCE(deposit_paid,false) AS deposit_paid, deposit_amount_pence,
             COALESCE(ready_reserve,false) AS ready_reserve,
             offer_made_at, offer_expires_at, offer_status, seat_depth, status, date_added
      FROM waiting_list
      WHERE COALESCE(status,'waiting') NOT IN ('placed','declined','lost','withdrawn')
      ORDER BY COALESCE(tier,'active') ASC, COALESCE(priority,3) ASC, date_added ASC`,
      [cfg.preschool_min_days_default]);

    const enrich = rows.map(r => {
      const status = liveOfferStatus(r, now);
      return {
        ...r,
        offer_status: status,
        offer_expired: status === 'expired',
        offer_live: status === 'offered',
        hours_left: (status === 'offered' && r.offer_expires_at)
          ? Math.max(0, Math.round((new Date(r.offer_expires_at) - now) / 3600000)) : null,
      };
    });
    const active = enrich.filter(r => r.tier === 'active');
    const parked = enrich.filter(r => r.tier === 'parked');
    res.json({
      generated: ymd(new Date()),
      depth_cap: cfg.waitlist_depth_per_seat, offer_expiry_hours: cfg.offer_expiry_hours,
      min_days_default: cfg.preschool_min_days_default, min_days_floor: cfg.preschool_min_days_floor,
      summary: {
        active_count: active.length, parked_count: parked.length,
        ready_reserve_count: enrich.filter(r => r.ready_reserve).length,
        live_offers: enrich.filter(r => r.offer_live).length,
        expired_offers: enrich.filter(r => r.offer_expired).length,
        deposits_held: enrich.filter(r => r.deposit_paid).length,
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
      WHERE id=$1 RETURNING id, offer_made_at, offer_expires_at, offer_status`,
      [req.params.id, String(hrs)]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
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
      RETURNING id, offer_status`, [req.params.id, status]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
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

// POST /waitlist/:id/deposit  {paid:bool, amount_pence:int}
router.post('/waitlist/:id/deposit', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const paid = !!(req.body && req.body.paid);
    const amt = req.body && req.body.amount_pence != null ? parseInt(req.body.amount_pence) : null;
    const { rows } = await db.query(
      `UPDATE waiting_list SET deposit_paid=$2, deposit_amount_pence=$3 WHERE id=$1
       RETURNING id, deposit_paid, deposit_amount_pence`, [req.params.id, paid, amt]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
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

module.exports = router;
