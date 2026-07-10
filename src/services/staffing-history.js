'use strict';
// Staffing-effectiveness analytics (Prompt 21, 2026-06-29) — read-only.
//
// Answers, for any past day/week/month/year: how WELL did we staff, not just how
// many were in. Builds ON TOP of Prompt 20's retrospective occupancy work — it
// reuses the EXACT per-day computation exported from src/routes/occupancy.js
// (children present, ratio-counting staff present, required staff, delta, ratio
// status) and the deterministic src/services/ratio-engine.js — so the cover figures
// here reconcile 1:1 with the Occupancy ▸ History view. We do NOT re-implement the
// ratio maths.
//
// What this service ADDS over occupancy:
//   • staff OFF that day  — approved absence_requests covering the date (the literal
//     "who was off" / concurrent-absence answer). Computed directly from
//     absence_requests, NOT from the present-staff list (occupancy drops on-leave
//     inferred staff from "present", which is correct for cover but is not the same
//     as "how many were off").
//   • requests DENIED vs approved — counts, rejection rate, trend, breakdowns.
//   • a combined day SCORE + colour STATUS that folds cover AND absence pressure.
//
// id=1 (Toby, owner/manager) is excluded from the request approval/denial metrics and
// the per-staff breakdowns (he self-approves; counting his own requests would distort
// the rejection rate). He is NOT excluded from ratio cover (he never counts toward
// ratio anyway — see ratio-engine / occupancy isRatioCountable).

const occupancy = require('../routes/occupancy');
const I = occupancy.internals;          // ATT_FROM, ymd, eachDate, computeDay, …
const ratioEngine = require('./ratio-engine');   // ageBandOn, requiredStaff (the ratio maths)

const OWNER_ID = 1;
const ymd = d => new Date(d).toISOString().slice(0, 10);

// ── colour / score rules (explicit, drives the calendar) ───────────────────────
// RED   (under): under ratio (delta<0) OR >=3 staff off at once.
// AMBER (tight): exactly on ratio (delta==0) OR 1–2 staff off.
// GREEN (good) : over ratio AND nobody off.
function dayStatus(delta, off) {
  if (delta < 0 || off >= 3) return 'under';
  if (delta === 0 || off >= 1) return 'tight';
  return 'good';
}
// 0–100 health score: cover headroom is the spine, absence/denials dent it.
function dayScore(delta, off, denied) {
  let s = delta < 0 ? Math.max(0, 30 + delta * 10)       // under ratio: −1→20, −3→0
                    : Math.min(100, 72 + delta * 9);     // on/over   :  0→72, +3→99
  s -= off * 8;
  s -= denied * 5;
  return Math.max(0, Math.min(100, Math.round(s)));
}

function isWeekday(dateStr) { return I.isoDow0Mon(dateStr) <= 4; }

// Weekdays (Mon–Fri) in an inclusive [from,to] window — nursery operates Mon–Fri,
// so an "absence day" only bites on a working day.
function weekdaysBetween(from, to) {
  if (from > to) return 0;
  let n = 0;
  for (const d of I.eachDate(from, to)) if (isWeekday(d)) n++;
  return n;
}

function maxStr(a, b) { return a > b ? a : b; }
function minStr(a, b) { return a < b ? a : b; }

// ── shared loader ───────────────────────────────────────────────────────────────
// Loads occupancy's inputs (attendance/staff/work-patterns/approved-absence/shifts,
// indexed) for the cover side, PLUS the full absence_requests set joined to staff
// names for the absence/denial side.
async function loadInputs(db, from, to) {
  const inp = await I.loadHistoryInputs(db, from, to);
  I.buildIndexes(inp);
  const { rows: requests } = await db.query(`
    SELECT ar.id, ar.staff_id, ar.start_date::text AS sd, ar.end_date::text AS ed,
           COALESCE(ar.absence_type,'other') AS absence_type,
           COALESCE(ar.request_type,ar.absence_type,'other') AS request_type,
           COALESCE(ar.status,'pending') AS status,
           ar.days_count, ar.duration_days, ar.half_day, ar.rejected_reason,
           ar.created_at::text AS created_at,
           s.first_name, s.last_name, s.role
    FROM absence_requests ar
    LEFT JOIN staff s ON s.id = ar.staff_id
    ORDER BY ar.start_date`, []);
  return { inp, requests };
}

// Approved-absence staff OFF on a given date (anyone whose approved leave covers it).
function staffOffOnDate(requests, date) {
  return requests
    .filter(r => r.status === 'approved' && r.sd <= date && r.ed >= date)
    .map(r => ({
      staff_id: r.staff_id,
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || ('Staff #' + r.staff_id),
      role: r.role || '',
      absence_type: r.absence_type,
      half_day: !!r.half_day && r.half_day !== '' && r.half_day !== 'false',
      in_ratio: I.isRatioCountable({ role: r.role, first_name: r.first_name, last_name: r.last_name }),
    }));
}
// Denied (rejected) requests whose leave window covers a given date.
function deniedOnDate(requests, date) {
  return requests.filter(r => r.status === 'rejected' && r.sd <= date && r.ed >= date);
}

// One calendar/day cell: occupancy cover figures + absence overlay.
function buildDay(inp, requests, date) {
  const cover = I.computeDay(inp, date);   // {children_in, staff_in, staff_required, delta, status:'good'|'tight'|'under'|'closed', …}
  const off = staffOffOnDate(requests, date);
  const denied = deniedOnDate(requests, date);
  const closed = cover.status === 'closed';
  const staff_off_count = off.length;
  const requests_denied_count = denied.length;
  const status = closed ? 'closed' : dayStatus(cover.delta, staff_off_count);
  return {
    date, weekday: cover.weekday, weekend: cover.weekend, closed,
    children_in: cover.children_in,
    staff_in: cover.staff_in,
    staff_required: cover.staff_required,
    delta: cover.delta,
    ratio_status: cover.status,                 // pure cover status (delta-only)
    staff_off_count, requests_denied_count,
    status,                                     // combined colour
    score: closed ? null : dayScore(cover.delta, staff_off_count, requests_denied_count),
    staff_source: cover.staff_source,
  };
}

// ── effectiveness summary KPIs over [from,to] ──────────────────────────────────
async function effectiveness(db, from, to) {
  const { inp, requests } = await loadInputs(db, from, to);
  const days = I.eachDate(from, to).map(d => buildDay(inp, requests, d));
  const op = days.filter(d => !d.closed);          // operating days only

  const onOrOver = op.filter(d => d.delta >= 0).length;
  const under = op.filter(d => d.delta < 0).length;
  const offCounts = op.map(d => d.staff_off_count);
  const maxConc = offCounts.length ? Math.max(...offCounts) : 0;
  const avgConc = offCounts.length ? Math.round((offCounts.reduce((a, b) => a + b, 0) / offCounts.length) * 100) / 100 : 0;

  let busiest = null, quietest = null;
  for (const d of op) {
    if (!busiest || d.children_in > busiest.children_in) busiest = { date: d.date, children_in: d.children_in };
    if (!quietest || d.children_in < quietest.children_in) quietest = { date: d.date, children_in: d.children_in };
  }

  // Requests in scope: leave period starts within [from,to], owner excluded.
  const scoped = requests.filter(r => r.staff_id !== OWNER_ID && r.sd >= from && r.sd <= to);
  const approved = scoped.filter(r => r.status === 'approved').length;
  const rejected = scoped.filter(r => r.status === 'rejected').length;
  const pending = scoped.filter(r => r.status === 'pending').length;
  const decided = approved + rejected;
  const rejection_rate = decided ? Math.round((rejected / decided) * 1000) / 10 : 0;

  // Total approved absence WORKING-days landing inside the window (owner excluded).
  let total_absence_days = 0;
  for (const r of requests) {
    if (r.staff_id === OWNER_ID || r.status !== 'approved') continue;
    const s = maxStr(r.sd, from), e = minStr(r.ed, to);
    total_absence_days += weekdaysBetween(s, e);
  }

  return {
    from, to,
    data_range: { earliest: I.ATT_FROM, latest: inp._maxData },
    days_total: op.length,
    days_on_or_over_ratio: onOrOver,
    days_under_ratio: under,
    pct_effective: op.length ? Math.round((onOrOver / op.length) * 100) : null,
    total_absence_days,
    requests_approved: approved,
    requests_rejected: rejected,
    requests_pending: pending,
    rejection_rate,
    max_concurrent_absence: maxConc,
    avg_concurrent_absence: avgConc,
    busiest_day: busiest,
    quietest_day: quietest,
    note: 'Cover figures (staff_in / required / delta) reuse the Occupancy ▸ History engine; staff presence is inferred from rota/contract minus approved leave (clock data — staff_shifts — is empty). Request metrics exclude the owner (staff id 1).',
  };
}

// ── month calendar (one entry per day) ─────────────────────────────────────────
async function calendar(db, month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error('month must be YYYY-MM');
  const y = +m[1], mo = +m[2];
  const first = `${m[1]}-${m[2]}-01`;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const last = `${m[1]}-${m[2]}-${String(lastDay).padStart(2, '0')}`;
  const { inp, requests } = await loadInputs(db, first, last);
  const days = I.eachDate(first, last).map(d => buildDay(inp, requests, d));
  const op = days.filter(d => !d.closed);
  return {
    month, from: first, to: last,
    data_range: { earliest: I.ATT_FROM, latest: inp._maxData },
    legend: {
      good: 'over ratio and nobody off',
      tight: 'exactly on ratio, or 1–2 staff off',
      under: 'under ratio, or 3+ staff off at once',
      closed: 'weekend / no attendance data',
    },
    summary: {
      operating_days: op.length,
      under_days: op.filter(d => d.status === 'under').length,
      tight_days: op.filter(d => d.status === 'tight').length,
      good_days: op.filter(d => d.status === 'good').length,
      avg_children: op.length ? Math.round(op.reduce((s, d) => s + d.children_in, 0) / op.length) : 0,
      max_concurrent_off: op.length ? Math.max(...op.map(d => d.staff_off_count)) : 0,
    },
    days,
  };
}

// ── day drill-down ──────────────────────────────────────────────────────────────
async function day(db, date) {
  const { inp, requests } = await loadInputs(db, date, date);
  const cell = buildDay(inp, requests, date);

  // present staff (occupancy's inference) + per-room cover
  const present = I.staffPresentOnDate(inp, date);
  const ratioPresent = present.filter(p => p.in_ratio);
  const att = inp.attByDate.get(date) || [];
  // Per-room children + the ratio-required staff for that room's age mix. Staff are
  // NOT reliably room-tagged in the data (staff.room_id is mostly null), so we
  // report the per-room REQUIREMENT (from the ratio engine) against children present,
  // and the ACTUAL staff figure stays at the whole-setting level (staff_in vs required).
  const childrenByRoom = {};
  const bandsByRoom = {};
  for (const c of att) {
    const rn = c.room_name || '(unassigned)';
    childrenByRoom[rn] = (childrenByRoom[rn] || 0) + 1;
    if (!bandsByRoom[rn]) bandsByRoom[rn] = { under2: 0, two: 0, threePlus: 0 };
    const band = c.dob ? ratioEngine.ageBandOn(c.dob, date) : 'threePlus';
    bandsByRoom[rn][band] = (bandsByRoom[rn][band] || 0) + 1;
  }
  const cover_by_room = Object.keys(childrenByRoom).sort().map(rn => ({
    room: rn,
    children_in: childrenByRoom[rn],
    required_staff: ratioEngine.requiredStaff(bandsByRoom[rn]),
  }));

  const off = staffOffOnDate(requests, date).sort((a, b) => (b.in_ratio - a.in_ratio) || a.name.localeCompare(b.name));
  const denied = deniedOnDate(requests, date).map(r => ({
    staff_id: r.staff_id,
    name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || ('Staff #' + r.staff_id),
    absence_type: r.absence_type, rejected_reason: r.rejected_reason || null,
    start_date: r.sd, end_date: r.ed,
  }));

  const staff_present = ratioPresent
    .map(p => ({ id: p.id, name: p.full_name, role: p.role, source: p.source }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    date, weekday: cell.weekday, weekend: cell.weekend, closed: cell.closed,
    status: cell.status, ratio_status: cell.ratio_status, score: cell.score,
    children_in: cell.children_in, children_by_room: childrenByRoom,
    staff_in: cell.staff_in, staff_required: cell.staff_required, delta: cell.delta,
    cover_met: cell.delta >= 0,
    staff_off_count: cell.staff_off_count, staff_off: off,
    requests_denied_count: cell.requests_denied_count, requests_denied: denied,
    cover_by_room, staff_present,
    note: 'Staff OFF = approved absence covering this date (incl. non-ratio roles). Present/cover staff inferred from rota/contract minus approved leave; clock data is empty.',
  };
}

// ── requests stats over [from,to] (approved/denied/pending, trend, breakdowns) ──
function isoWeekStart(dateStr) { return I.weekStart(dateStr); }

async function requestStats(db, from, to) {
  const { rows: requests } = await db.query(`
    SELECT ar.id, ar.staff_id, ar.start_date::text AS sd, ar.end_date::text AS ed,
           COALESCE(ar.absence_type,'other') AS absence_type,
           COALESCE(ar.status,'pending') AS status, ar.created_at::text AS created_at,
           s.first_name, s.last_name, s.role
    FROM absence_requests ar
    LEFT JOIN staff s ON s.id = ar.staff_id
    WHERE ar.staff_id <> $3
      AND ar.start_date >= $1::date AND ar.start_date <= $2::date
    ORDER BY ar.start_date`, [from, to, OWNER_ID]);

  const approved = requests.filter(r => r.status === 'approved').length;
  const rejected = requests.filter(r => r.status === 'rejected').length;
  const pending = requests.filter(r => r.status === 'pending').length;
  const decided = approved + rejected;
  const rejection_rate = decided ? Math.round((rejected / decided) * 1000) / 10 : 0;

  // weekly trend (bucket by Monday of the leave start week)
  const wk = new Map();
  for (const r of requests) {
    const k = isoWeekStart(r.sd);
    if (!wk.has(k)) wk.set(k, { week: k, approved: 0, rejected: 0, pending: 0 });
    wk.get(k)[r.status] = (wk.get(k)[r.status] || 0) + 1;
  }
  const trend = [...wk.values()].sort((a, b) => a.week.localeCompare(b.week)).map(w => {
    const dec = w.approved + w.rejected;
    return { ...w, rejection_rate: dec ? Math.round((w.rejected / dec) * 1000) / 10 : 0 };
  });

  // by absence_type
  const byType = new Map();
  for (const r of requests) {
    if (!byType.has(r.absence_type)) byType.set(r.absence_type, { absence_type: r.absence_type, approved: 0, rejected: 0, pending: 0, total: 0 });
    const t = byType.get(r.absence_type); t[r.status] = (t[r.status] || 0) + 1; t.total++;
  }

  // by staff
  const byStaff = new Map();
  for (const r of requests) {
    if (!byStaff.has(r.staff_id)) byStaff.set(r.staff_id, {
      staff_id: r.staff_id,
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || ('Staff #' + r.staff_id),
      role: r.role || '', approved: 0, rejected: 0, pending: 0, total: 0,
    });
    const s = byStaff.get(r.staff_id); s[r.status] = (s[r.status] || 0) + 1; s.total++;
  }
  const staffArr = [...byStaff.values()];
  const top_requesters = [...staffArr].sort((a, b) => b.total - a.total || b.rejected - a.rejected).slice(0, 10);
  const top_denied = [...staffArr].filter(s => s.rejected > 0).sort((a, b) => b.rejected - a.rejected).slice(0, 10);

  return {
    from, to,
    total: requests.length,
    requests_approved: approved, requests_rejected: rejected, requests_pending: pending,
    rejection_rate,
    trend,
    by_type: [...byType.values()].sort((a, b) => b.total - a.total),
    top_requesters, top_denied,
    note: 'Owner (staff id 1) excluded. Requests counted by leave start date within range.',
  };
}

// ── trends over the FULL range (Prompt 39, 2026-06-30) ──────────────────────────
// The deep-history view that prompt 39's RAG + AI chat consume. Computes, across the
// whole attendance span, the metrics Toby asked for:
//   • over-ratio days  (delta>0 — more ratio-staff present than the children required:
//                        "overstaffed when we didn't need to be")
//   • under-ratio days (delta<0 — short of ratio)  • on-ratio days (delta==0)
//   • surplus staff-days ("extra in") = Σ max(0,delta) over operating days
//   • deficit staff-days              = Σ max(0,-delta)
//   • seasonality: by calendar month and by weekday
//   • the most-overstaffed individual days (biggest surplus)
// Reuses buildDay (occupancy/ratio engine) — no ratio maths re-implemented. Read-only.
// NB: staff presence is inferred from rota/contract minus approved leave (clock data is
// empty), so "extra in" is the rota-vs-attendance surplus, not a clocked figure.
const DOW_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function trends(db, from, to) {
  const { inp, requests } = await loadInputs(db, from, to);
  const days = I.eachDate(from, to).map(d => buildDay(inp, requests, d));
  const op = days.filter(d => !d.closed);   // operating days only

  let over = 0, on = 0, under = 0, surplus = 0, deficit = 0, deltaSum = 0;
  const byMonth = new Map(), byDow = new Map();
  for (const d of op) {
    if (d.delta > 0) over++; else if (d.delta === 0) on++; else under++;
    surplus += Math.max(0, d.delta);
    deficit += Math.max(0, -d.delta);
    deltaSum += d.delta;

    const mk = d.date.slice(0, 7);
    if (!byMonth.has(mk)) byMonth.set(mk, { month: mk, op_days: 0, children: 0, deltaSum: 0, over_ratio_days: 0, on_ratio_days: 0, under_ratio_days: 0, surplus_staff_days: 0, deficit_staff_days: 0, off_max: 0 });
    const m = byMonth.get(mk);
    m.op_days++; m.children += d.children_in; m.deltaSum += d.delta;
    if (d.delta > 0) m.over_ratio_days++; else if (d.delta === 0) m.on_ratio_days++; else m.under_ratio_days++;
    m.surplus_staff_days += Math.max(0, d.delta); m.deficit_staff_days += Math.max(0, -d.delta);
    m.off_max = Math.max(m.off_max, d.staff_off_count);

    const wk = DOW_NAMES[d.weekday] || String(d.weekday);
    if (!byDow.has(wk)) byDow.set(wk, { weekday: wk, dow: d.weekday, op_days: 0, children: 0, deltaSum: 0, over_ratio_days: 0, on_ratio_days: 0, under_ratio_days: 0, surplus_staff_days: 0, deficit_staff_days: 0 });
    const w = byDow.get(wk);
    w.op_days++; w.children += d.children_in; w.deltaSum += d.delta;
    if (d.delta > 0) w.over_ratio_days++; else if (d.delta === 0) w.on_ratio_days++; else w.under_ratio_days++;
    w.surplus_staff_days += Math.max(0, d.delta); w.deficit_staff_days += Math.max(0, -d.delta);
  }
  const round2 = n => Math.round(n * 100) / 100;
  const finishMonth = m => ({ month: m.month, op_days: m.op_days, avg_children: m.op_days ? Math.round(m.children / m.op_days) : 0, avg_delta: m.op_days ? round2(m.deltaSum / m.op_days) : 0, over_ratio_days: m.over_ratio_days, on_ratio_days: m.on_ratio_days, under_ratio_days: m.under_ratio_days, surplus_staff_days: m.surplus_staff_days, deficit_staff_days: m.deficit_staff_days, max_concurrent_off: m.off_max });
  const finishDow = w => ({ weekday: w.weekday, op_days: w.op_days, avg_children: w.op_days ? Math.round(w.children / w.op_days) : 0, avg_delta: w.op_days ? round2(w.deltaSum / w.op_days) : 0, over_ratio_days: w.over_ratio_days, under_ratio_days: w.under_ratio_days, surplus_staff_days: w.surplus_staff_days, deficit_staff_days: w.deficit_staff_days });

  const most_overstaffed_days = [...op].filter(d => d.delta > 0).sort((a, b) => b.delta - a.delta || b.children_in - a.children_in).slice(0, 10)
    .map(d => ({ date: d.date, children_in: d.children_in, staff_in: d.staff_in, staff_required: d.staff_required, delta: d.delta }));
  const most_understaffed_days = [...op].filter(d => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 10)
    .map(d => ({ date: d.date, children_in: d.children_in, staff_in: d.staff_in, staff_required: d.staff_required, delta: d.delta }));

  return {
    from, to,
    data_range: { earliest: I.ATT_FROM, latest: inp._maxData },
    operating_days: op.length,
    over_ratio_days: over,
    on_ratio_days: on,
    under_ratio_days: under,
    pct_over_ratio: op.length ? Math.round((over / op.length) * 100) : null,
    pct_under_ratio: op.length ? Math.round((under / op.length) * 100) : null,
    surplus_staff_days: surplus,
    deficit_staff_days: deficit,
    avg_delta: op.length ? round2(deltaSum / op.length) : 0,
    by_month: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map(finishMonth),
    by_weekday: [...byDow.values()].sort((a, b) => a.dow - b.dow).map(finishDow),
    most_overstaffed_days,
    most_understaffed_days,
    note: 'delta = ratio-counting staff present (rota/contract minus approved leave; clock data empty) − staff required by EYFS ratios for children present (EyLog register). Surplus staff-days ("extra in") = Σ max(0,delta). Ratio analysis only spans the attendance window (data_range).',
  };
}

module.exports = { effectiveness, calendar, day, requestStats, trends, dayStatus, dayScore };
