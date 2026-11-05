'use strict';
/**
 * owner-digest.js — b185 (2026-08-19) — Owner monthly digest.
 *
 * ONE place that answers "how did the setting do last month?" for the OWNER,
 * across occupancy, staffing, CPD, performance, finance and compliance. The
 * nightly report engine (scripts/report-engine-nightly.js --only=ownerdigest)
 * builds it once a month, renders it to PDF (src/lib/owner-digest-pdf.js) and
 * emails it — through the EXISTING Gmail service-account sender, on the
 * EXISTING nightly cron. No second mailer, no second pipeline.
 *
 * Distinct from b183's staff-performance report (that one goes to the
 * management group and is about practice); this one is broader and goes to
 * Toby alone.
 *
 * ── GDPR — THIS EMAIL LEAVES THE BUILDING ──────────────────────────────────
 * Counts and aggregates only. NO child names, NO parent names, NO safeguarding
 * detail — the compliance section carries a count and nothing else, and the
 * CPD collector deliberately drops any compliance item whose subject is a
 * child (sen_apdr_review) before it can reach the page. Staff names ARE
 * included: Toby is their employer and the staffing/CPD sections are useless
 * without them. assertNoChildNames() below is a belt-and-braces check the
 * caller can run over the finished object.
 *
 * ── HONESTY ────────────────────────────────────────────────────────────────
 * Every collector is independently try/caught and every metric may be null.
 * A null renders as "no data" and says WHY in the section note — it is never
 * silently shown as 0, and no figure is ever estimated to fill a gap. A
 * genuine measured zero (the query ran, the answer was none) IS shown as 0.
 * That distinction is the whole point: the owner has to be able to tell
 * "nothing happened" from "we are not recording this".
 */

const path = require('path');

/* ── month helpers ─────────────────────────────────────────────────────────── */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM' → { month, label, start, end, weekdays }. */
function monthMeta(monthStr) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthStr || ''));
  if (!m) throw new Error(`owner-digest: bad month "${monthStr}" (want YYYY-MM)`);
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error(`owner-digest: bad month "${monthStr}"`);
  const start = `${m[1]}-${m[2]}-01`;
  const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  return { month: `${m[1]}-${m[2]}`, label: `${MONTH_NAMES[mo - 1]} ${y}`, start, end,
           weekdays: weekdaysBetween(start, end) };
}

function prevMonthOf(monthStr) {
  const [y, mo] = monthStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The month BEFORE the one containing `iso` — what a run on the 1st reports on. */
function monthBefore(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function addDaysIso(iso, n) {
  return new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
}

/** Mon–Fri days in an inclusive range. The setting is Mon–Fri 8–6. */
function weekdaysBetween(start, end) {
  let n = 0;
  for (let d = new Date(start + 'T00:00:00Z'); d <= new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) n++;
  }
  return n;
}

/* ── formatting ────────────────────────────────────────────────────────────── */

const round1 = n => (n == null ? null : Math.round(n * 10) / 10);
const num = v => (v == null ? null : Number(v));

const fmtInt   = n => Number(n).toLocaleString('en-GB');
const fmtPct   = n => `${Math.round(n)}%`;
const fmtHours = n => `${round1(n).toLocaleString('en-GB')} h`;
const fmtDays  = n => `${round1(n).toLocaleString('en-GB')} day${round1(n) === 1 ? '' : 's'}`;
const fmtMoney = pence => '£' + (Number(pence) / 100).toLocaleString('en-GB',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/* ── metric construction ───────────────────────────────────────────────────── */

/**
 * Direction of travel. null when either side is missing — we do not claim a
 * trend against an absent number.
 */
function dirOf(value, prev) {
  if (value == null || prev == null) return null;
  const d = Number(value) - Number(prev);
  if (Math.abs(d) < 1e-9) return 'flat';
  return d > 0 ? 'up' : 'down';
}

const ARROWS = { up: '▲', down: '▼', flat: '=' };

/**
 * One figure with its previous month beside it.
 * opts: { format, polarity: higher_better|lower_better|neutral, note, missing }
 */
function metric(label, value, prev, opts = {}) {
  const fmt = opts.format || fmtInt;
  const v = value == null ? null : Number(value);
  const p = prev  == null ? null : Number(prev);
  const missing = opts.missing || 'no data';
  const direction = dirOf(v, p);
  return {
    label,
    value: v,
    prev: p,
    display:      v == null ? missing : fmt(v),
    prev_display: p == null ? missing : fmt(p),
    direction,
    arrow: direction ? ARROWS[direction] : '',
    delta: (v != null && p != null) ? round1(v - p) : null,
    delta_display: (v != null && p != null && direction !== 'flat')
      ? `${v > p ? '+' : '−'}${fmt(Math.abs(v - p))}` : null,
    polarity: opts.polarity || 'neutral',
    note: opts.note || null,
  };
}

/** true when the movement is in the direction the owner wants. null = can't say. */
function isGood(m) {
  if (!m.direction || m.direction === 'flat' || m.polarity === 'neutral') return null;
  if (m.polarity === 'higher_better') return m.direction === 'up';
  if (m.polarity === 'lower_better')  return m.direction === 'down';
  return null;
}

function section(key, title, icon, link) {
  return { key, title, icon, link: link || null, metrics: [], tables: [], bullets: [],
           notes: [], no_data: false };
}

/** Run a query, returning [] and recording an honest note if the source is absent. */
async function q(db, sec, label, sql, params) {
  try {
    const { rows } = await db.query(sql, params || []);
    return rows;
  } catch (e) {
    sec.notes.push(`${label}: not available in this database (${e.message.split('\n')[0]}).`);
    return null;
  }
}

/**
 * Has this source EVER been written to? The difference between "we measured, the
 * answer was none" (a real 0) and "we have never recorded this at all" (no data)
 * is the whole point of the honesty rule, and only this query can tell them apart.
 * null = the table does not exist on this edition.
 */
async function everUsed(db, table) {
  try {
    const { rows } = await db.query(`SELECT EXISTS (SELECT 1 FROM ${table}) AS used`);
    return rows[0].used;
  } catch (_) { return null; }
}

/** A section with nothing measurable is marked no_data rather than shown empty. */
function finishSection(sec) {
  const anyValue = sec.metrics.some(m => m.value != null)
    || sec.tables.some(t => t.rows && t.rows.length)
    || sec.bullets.length > 0;
  sec.no_data = !anyValue;
  return sec;
}

/* ══════════ 1. OCCUPANCY ══════════════════════════════════════════════════ */

async function collectOccupancy(db, P, V) {
  const sec = section('occupancy', 'Occupancy', '🏠', '/occupancy.html');

  const roomsRows = await q(db, sec, 'rooms', `
    SELECT id, name, COALESCE(display_name, name) AS display_name,
           COALESCE(capacity, target_capacity, legal_capacity) AS capacity
      FROM rooms ORDER BY id`);
  const rooms = roomsRows || [];

  // Attended child-days per room, from the attendance register. Children who have
  // since left are still counted — this is what the month actually looked like.
  const perRoomSql = `
    SELECT c.room_id,
           count(*) FILTER (WHERE NOT COALESCE(a.absent, false))::int AS attended,
           count(*)::int                                             AS booked,
           count(DISTINCT a.date)::int                               AS open_days
      FROM attendance a
      JOIN children c ON c.id = a.child_id
     WHERE a.date BETWEEN $1::date AND $2::date
       AND COALESCE(c.is_demo, false) = false
     GROUP BY c.room_id`;
  const cur  = await q(db, sec, 'attendance register', perRoomSql, [P.start, P.end]);
  const prev = cur === null ? null : await q(db, sec, 'attendance register (previous month)', perRoomSql, [V.start, V.end]);

  const byRoom  = new Map((cur  || []).map(r => [r.room_id, r]));
  const byRoomP = new Map((prev || []).map(r => [r.room_id, r]));

  // Setting-wide occupancy = attended child-days ÷ (capacity × weekdays open).
  let capDays = 0, attended = 0, attendedP = 0, capDaysP = 0, anyRoomData = false;
  const roomRows = [];
  for (const r of rooms) {
    const cap = Number(r.capacity || 0);
    const a  = byRoom.get(r.id),  ap = byRoomP.get(r.id);
    const at = a  ? Number(a.attended)  : null;
    const atP = ap ? Number(ap.attended) : null;
    if (at != null) anyRoomData = true;
    const denom  = cap * P.weekdays;
    const denomP = cap * V.weekdays;
    if (cap && at  != null) { capDays  += denom;  attended  += at; }
    if (cap && atP != null) { capDaysP += denomP; attendedP += atP; }
    const pct  = (cap && at  != null && denom)  ? (at  / denom)  * 100 : null;
    const pctP = (cap && atP != null && denomP) ? (atP / denomP) * 100 : null;
    roomRows.push([
      r.display_name || r.name,
      cap ? String(cap) : 'not set',
      at == null ? 'no data' : fmtInt(at),
      pct == null ? 'no data' : fmtPct(pct),
      pctP == null ? 'no data' : fmtPct(pctP),
      pct != null && pctP != null ? ARROWS[dirOf(pct, pctP)] : '',
      // Spare capacity = places left on an average open day.
      (cap && at != null && P.weekdays) ? round1(cap - at / P.weekdays).toString() : 'no data',
    ]);
  }
  if (roomRows.length) {
    sec.tables.push({
      title: 'By room',
      columns: ['Room', 'Capacity', 'Child-days', 'Occupancy', `${V.label}`, '', 'Spare places/day'],
      rows: roomRows,
      note: `Occupancy = attended child-days ÷ (capacity × ${P.weekdays} weekdays in ${P.label}).`,
    });
  }

  // Attendance whose child sits in no known room would otherwise vanish from the
  // setting total without trace. Say so instead.
  const orphan = (cur || []).filter(r => !rooms.some(x => x.id === r.room_id))
                            .reduce((s2, r) => s2 + Number(r.attended), 0);
  if (orphan) {
    sec.notes.push(`${orphan} attended child-day(s) are excluded from the room figures because `
      + 'the child is not assigned to a room. They are in the register but cannot be placed.');
  }

  sec.metrics.push(metric('Occupancy (all rooms)',
    capDays ? (attended / capDays) * 100 : null,
    capDaysP ? (attendedP / capDaysP) * 100 : null,
    { format: fmtPct, polarity: 'higher_better' }));
  sec.metrics.push(metric('Attended child-days',
    anyRoomData ? attended : null,
    (prev && prev.length) ? attendedP : null,
    { polarity: 'higher_better' }));

  // Attendance rate — booked places actually taken up.
  const bookedTotal = (cur || []).reduce((s, r) => s + Number(r.booked), 0);
  const bookedPrev  = (prev || []).reduce((s, r) => s + Number(r.booked), 0);
  sec.metrics.push(metric('Booked places taken up',
    bookedTotal ? (attended / bookedTotal) * 100 : null,
    bookedPrev  ? (attendedP / bookedPrev) * 100 : null,
    { format: fmtPct, polarity: 'higher_better',
      note: 'Attended ÷ booked on the register (the rest were marked absent).' }));

  // ── per day of week ──────────────────────────────────────────────────────
  const dow = await q(db, sec, 'attendance by weekday', `
    SELECT EXTRACT(ISODOW FROM a.date)::int              AS dow,
           count(*) FILTER (WHERE NOT COALESCE(a.absent, false))::int AS attended,
           count(DISTINCT a.date)::int                   AS days
      FROM attendance a
     WHERE a.date BETWEEN $1::date AND $2::date
     GROUP BY 1 ORDER BY 1`, [P.start, P.end]);
  if (dow && dow.length) {
    const totalCap = rooms.reduce((s, r) => s + Number(r.capacity || 0), 0);
    sec.tables.push({
      title: 'By day of the week',
      columns: ['Day', 'Days with a register', 'Avg children/day', 'Avg occupancy'],
      rows: dow.filter(d => d.dow >= 1 && d.dow <= 5).map(d => {
        const avg = Number(d.days) ? Number(d.attended) / Number(d.days) : null;
        return [
          DAY_NAMES[d.dow - 1],
          String(d.days),
          avg == null ? 'no data' : round1(avg).toString(),
          (avg != null && totalCap) ? fmtPct((avg / totalCap) * 100) : 'no data',
        ];
      }),
      note: totalCap ? `Against a total capacity of ${totalCap} places.` : 'Room capacities are not set, so no percentage can be given.',
    });
  }

  // ── funded vs paid ───────────────────────────────────────────────────────
  const fund = await q(db, sec, 'bookings (funded/paid split)', `
    SELECT COALESCE(funded, false) AS funded,
           count(DISTINCT child_id)::int AS children,
           SUM( (CASE WHEN mon THEN 1 ELSE 0 END) + (CASE WHEN tue THEN 1 ELSE 0 END)
              + (CASE WHEN wed THEN 1 ELSE 0 END) + (CASE WHEN thu THEN 1 ELSE 0 END)
              + (CASE WHEN fri THEN 1 ELSE 0 END) )::int AS day_slots
      FROM child_bookings cb
      JOIN children c ON c.id = cb.child_id
     WHERE COALESCE(cb.is_active, true) = true
       AND cb.start_date <= $2::date
       AND (cb.end_date IS NULL OR cb.end_date >= $1::date)
       AND COALESCE(c.is_demo, false) = false
     GROUP BY 1`, [P.start, P.end]);
  if (fund && fund.length) {
    const f = fund.find(r => r.funded === true) || { children: 0, day_slots: 0 };
    const p = fund.find(r => r.funded === false) || { children: 0, day_slots: 0 };
    const totalSlots = Number(f.day_slots) + Number(p.day_slots);
    sec.metrics.push(metric('Funded share of booked days',
      totalSlots ? (Number(f.day_slots) / totalSlots) * 100 : null, null,
      { format: fmtPct, note: `${f.children} funded / ${p.children} privately paid children with a live booking. `
        + 'Read from the funded flag on the booking, which is a different record from the funding '
        + 'entitlements counted in the Finance section — the two can disagree.' }));
    sec.bullets.push(`Live bookings in ${P.label}: ${totalSlots} booked day-places a week — `
      + `${f.day_slots} funded, ${p.day_slots} privately paid.`);
  } else if (fund) {
    sec.notes.push('No live rows in child_bookings for this month, so the funded/paid split cannot be given.');
  }

  // ── forward view ─────────────────────────────────────────────────────────
  const horizon = addDaysIso(P.end, 90);
  const starters = await q(db, sec, 'starters (bookings)', `
    SELECT count(DISTINCT cb.child_id)::int AS n FROM child_bookings cb
      JOIN children c ON c.id = cb.child_id
     WHERE COALESCE(cb.is_active, true) = true AND cb.start_date > $1::date AND cb.start_date <= $2::date
       AND COALESCE(c.is_demo, false) = false`,
    [P.end, horizon]);
  const leavers = await q(db, sec, 'leavers', `
    SELECT count(*)::int AS n FROM children
     WHERE leave_date > $1::date AND leave_date <= $2::date AND COALESCE(is_demo, false) = false`, [P.end, horizon]);
  const wl = await q(db, sec, 'waiting list', `
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE expected_start_date > $1::date
                              AND expected_start_date <= $2::date)::int AS starting_soon
      FROM waiting_list_live
     WHERE COALESCE(status, 'active') NOT IN ('placed', 'declined', 'withdrawn', 'closed')
       AND COALESCE(tier, '') <> 'parked'`, [P.end, horizon]);

  if (starters || leavers || wl) {
    const bits = [];
    if (starters) bits.push(`${starters[0].n} child(ren) due to start`);
    if (leavers)  bits.push(`${leavers[0].n} due to leave`);
    if (wl)       bits.push(`${wl[0].total} on the waiting list (${wl[0].starting_soon} wanting a place in that window)`);
    sec.bullets.push(`Next 3 months (to ${horizon}): ${bits.join('; ')}.`);
    if (starters && leavers) {
      sec.metrics.push(metric('Net roll change, next 3 months',
        Number(starters[0].n) - Number(leavers[0].n), null,
        { polarity: 'higher_better', format: n => (n > 0 ? '+' : '') + fmtInt(n) }));
    }
  }

  if (!anyRoomData) {
    sec.notes.push(`No attendance was recorded for ${P.label}, so occupancy cannot be calculated. `
      + 'The register (attendance) is the source — nothing has been estimated in its place.');
  }
  return finishSection(sec);
}

/* ══════════ 2. STAFFING ═══════════════════════════════════════════════════ */

async function collectStaffing(db, P, V) {
  const sec = section('staffing', 'Staffing', '👥', '/staffing-analytics.html');

  // Rostered hours (rota_shifts is the plan of record; is_absent rows are excluded
  // because nobody worked them).
  const rotaSql = `
    SELECT COALESCE(SUM(
             EXTRACT(EPOCH FROM (planned_end - planned_start)) / 3600.0
             - COALESCE(break_mins, 0) / 60.0), 0)::numeric AS hours,
           count(*)::int AS shifts,
           count(DISTINCT rs.staff_id)::int AS staff
      FROM rota_shifts rs
      LEFT JOIN staff s ON s.id = rs.staff_id
     WHERE shift_date BETWEEN $1::date AND $2::date
       AND rs.staff_id IS NOT NULL
       AND planned_start IS NOT NULL AND planned_end IS NOT NULL
       AND COALESCE(is_absent, false) = false
       AND COALESCE(s.is_demo, false) = false`;
  const rota  = await q(db, sec, 'rota', rotaSql, [P.start, P.end]);
  const rotaP = rota === null ? null : await q(db, sec, 'rota (previous month)', rotaSql, [V.start, V.end]);
  const rostered  = (rota  && Number(rota[0].shifts))  ? Number(rota[0].hours)  : null;
  const rosteredP = (rotaP && Number(rotaP[0].shifts)) ? Number(rotaP[0].hours) : null;

  // Contracted hours for the same period = weekly contract × weeks (weekdays ÷ 5).
  const contract = await q(db, sec, 'contracted hours', `
    SELECT COALESCE(SUM(COALESCE(contracted_hours, hours_per_week)), 0)::numeric AS weekly,
           count(*) FILTER (WHERE COALESCE(contracted_hours, hours_per_week) IS NOT NULL)::int AS n,
           count(*)::int AS active
      FROM staff WHERE is_active = true AND COALESCE(terminated, false) = false
        AND COALESCE(is_demo, false) = false`);
  const weeklyContract = (contract && Number(contract[0].n)) ? Number(contract[0].weekly) : null;
  const contractedThis = weeklyContract == null ? null : weeklyContract * (P.weekdays / 5);
  const contractedPrev = weeklyContract == null ? null : weeklyContract * (V.weekdays / 5);

  sec.metrics.push(metric('Hours rostered', rostered, rosteredP,
    { format: fmtHours, polarity: 'neutral' }));
  sec.metrics.push(metric('Hours contracted', contractedThis, contractedPrev,
    { format: fmtHours, polarity: 'neutral',
      note: weeklyContract == null ? null
        : `${contract[0].n} of ${contract[0].active} active staff have contracted hours on file — `
          + `${round1(weeklyContract)} hours a week between them. The other `
          + `${Number(contract[0].active) - Number(contract[0].n)} are not counted, so this is a floor, not the true total.` }));
  sec.metrics.push(metric('Rostered vs contracted',
    (rostered != null && contractedThis) ? (rostered / contractedThis) * 100 : null,
    (rosteredP != null && contractedPrev) ? (rosteredP / contractedPrev) * 100 : null,
    { format: fmtPct, polarity: 'neutral',
      note: 'Over 100% means more hours were rostered than the contracts cover.' }));

  // Actual clocked hours — separate source, often not in use. Never conflated
  // with the roster: if nobody clocks in, this must read "no data", not zero.
  const clockSql = `
    SELECT COALESCE(SUM(total_minutes), 0)::numeric / 60.0 AS hours, count(*)::int AS n
      FROM staff_shifts WHERE shift_date BETWEEN $1::date AND $2::date AND total_minutes IS NOT NULL`;
  const clock  = await q(db, sec, 'clocked hours', clockSql, [P.start, P.end]);
  const clockP = clock === null ? null : await q(db, sec, 'clocked hours (previous month)', clockSql, [V.start, V.end]);
  sec.metrics.push(metric('Hours actually clocked',
    (clock  && Number(clock[0].n))  ? Number(clock[0].hours)  : null,
    (clockP && Number(clockP[0].n)) ? Number(clockP[0].hours) : null,
    { format: fmtHours, polarity: 'neutral',
      note: (clock && !Number(clock[0].n)) ? 'Nobody clocked in and out through Wren this month.' : null }));

  // ── ratio compliance ─────────────────────────────────────────────────────
  const hcSql = `
    SELECT count(*)::int AS checks,
           count(*) FILTER (WHERE ratio_ok = false)::int AS breaches
      FROM room_headcounts
     WHERE scheduled_for >= $1::date AND scheduled_for < ($2::date + 1)
       AND status IN ('completed', 'done', 'complete')`;
  const hc  = await q(db, sec, 'headcounts', hcSql, [P.start, P.end]);
  const hcP = hc === null ? null : await q(db, sec, 'headcounts (previous month)', hcSql, [V.start, V.end]);
  sec.metrics.push(metric('Headcount checks completed',
    hc  ? Number(hc[0].checks)  : null,
    hcP ? Number(hcP[0].checks) : null, { polarity: 'higher_better' }));
  sec.metrics.push(metric('Under-ratio events recorded',
    (hc && Number(hc[0].checks)) ? Number(hc[0].breaches) : null,
    (hcP && Number(hcP[0].checks)) ? Number(hcP[0].breaches) : null,
    { polarity: 'lower_better',
      note: (hc && !Number(hc[0].checks)) ? 'No headcount was completed this month, so ratio compliance is unevidenced.' : null }));

  // Over-ratio (b189) — deliberate and usually good, reported as spend not as fault.
  const ofrSql = `
    SELECT count(*)::int AS entries,
           COALESCE(SUM(surplus_minutes), 0)::int AS mins,
           count(*) FILTER (WHERE account IS NULL)::int AS unaccounted
      FROM offratio_log WHERE date BETWEEN $1::date AND $2::date`;
  const ofr  = await q(db, sec, 'off-ratio log', ofrSql, [P.start, P.end]);
  const ofrP = ofr === null ? null : await q(db, sec, 'off-ratio log (previous month)', ofrSql, [V.start, V.end]);
  if (ofr) {
    sec.metrics.push(metric('Over-ratio hours (room-days above ratio)',
      Number(ofr[0].mins) / 60, ofrP ? Number(ofrP[0].mins) / 60 : null,
      { format: fmtHours, polarity: 'neutral',
        note: 'Usually deliberate — settling, SEND support, planning, supervision. Shown so the cost is visible, not as a fault.' }));
    if (Number(ofr[0].unaccounted)) {
      sec.bullets.push(`${ofr[0].unaccounted} of ${ofr[0].entries} over-ratio room-days are still waiting for the room leader to say how the time was used.`);
    }
  }

  // ── absence ──────────────────────────────────────────────────────────────
  const absSql = `
    SELECT count(*)::int AS n,
           COALESCE(SUM(COALESCE(days_count, duration_days,
                                 GREATEST(1, (LEAST(end_date, $2::date) - GREATEST(start_date, $1::date)) + 1))), 0)::numeric AS days
      FROM absence_requests
     WHERE start_date <= $2::date AND COALESCE(end_date, start_date) >= $1::date
       AND COALESCE(status, 'approved') NOT IN ('rejected', 'cancelled', 'declined')`;
  const abs  = await q(db, sec, 'absence requests', absSql, [P.start, P.end]);
  const absP = abs === null ? null : await q(db, sec, 'absence requests (previous month)', absSql, [V.start, V.end]);
  const hrAbs = await q(db, sec, 'BrightHR absence', `
    SELECT count(*)::int AS n, COALESCE(SUM(duration_days), 0)::numeric AS days
      FROM hr_absences WHERE start_date <= $2::date AND COALESCE(end_date, start_date) >= $1::date`,
    [P.start, P.end]);
  const absEver = (await everUsed(db, 'absence_requests')) || (await everUsed(db, 'hr_absences'));
  const absDays  = (abs  && absEver) ? Number(abs[0].days)  : null;
  const absDaysP = (absP && absEver) ? Number(absP[0].days) : null;
  sec.metrics.push(metric('Staff absence days', absDays, absDaysP,
    { format: fmtDays, polarity: 'lower_better',
      note: absEver === false
        ? 'No staff absence has ever been recorded, so this is blank rather than zero.'
        : (hrAbs && Number(hrAbs[0].n)
            ? `Plus ${hrAbs[0].n} record(s) imported from BrightHR covering ${round1(Number(hrAbs[0].days))} days.` : null) }));

  // ── TOIL ─────────────────────────────────────────────────────────────────
  let toilBalance = null, toilNote = null;
  const toil = await q(db, sec, 'TOIL', `
    SELECT COALESCE(SUM(CASE WHEN lower(COALESCE(type,'accrued')) LIKE 'accru%' THEN hours
                             ELSE -hours END), 0)::numeric AS balance,
           count(*)::int AS n
      FROM toil_entries WHERE occurred_on <= $1::date`, [P.end]);
  if (toil && Number(toil[0].n)) { toilBalance = Number(toil[0].balance); }
  if (toilBalance == null) {
    const hrToil = await q(db, sec, 'TOIL (HR)', `
      SELECT COALESCE(SUM(CASE WHEN used_date IS NULL THEN hours ELSE 0 END), 0)::numeric AS balance,
             count(*)::int AS n
        FROM hr_toil_entries WHERE accrued_date <= $1::date`, [P.end]);
    if (hrToil && Number(hrToil[0].n)) { toilBalance = Number(hrToil[0].balance); }
  }
  if (toilBalance == null) toilNote = 'No TOIL has ever been recorded, in either the Wren or the BrightHR table.';
  sec.metrics.push(metric(`TOIL owed at ${P.end}`, toilBalance, null,
    { format: fmtHours, polarity: 'lower_better', note: toilNote }));

  // ── overtime / agency spend ──────────────────────────────────────────────
  const otSql = `
    SELECT count(*)::int AS n, COALESCE(SUM(hours), 0)::numeric AS hours,
           COALESCE(SUM(hours * COALESCE(rate, 0)), 0)::numeric AS cost,
           count(*) FILTER (WHERE COALESCE(rate, 0) = 0)::int AS no_rate
      FROM hr_overtime WHERE date BETWEEN $1::date AND $2::date`;
  const ot  = await q(db, sec, 'overtime', otSql, [P.start, P.end]);
  const otP = ot === null ? null : await q(db, sec, 'overtime (previous month)', otSql, [V.start, V.end]);
  const otEver = await everUsed(db, 'hr_overtime');
  sec.metrics.push(metric('Overtime hours',
    (ot  && otEver) ? Number(ot[0].hours)  : null,
    (otP && otEver) ? Number(otP[0].hours) : null,
    { format: fmtHours, polarity: 'lower_better',
      note: otEver === false ? 'No overtime has ever been recorded in Wren, so this is blank rather than zero.' : null }));
  sec.metrics.push(metric('Overtime cost',
    (ot && Number(ot[0].n) && !Number(ot[0].no_rate)) ? Number(ot[0].cost) * 100 : null,
    (otP && Number(otP[0].n)) ? Number(otP[0].cost) * 100 : null,
    { format: fmtMoney, polarity: 'lower_better',
      note: (ot && Number(ot[0].no_rate))
        ? `${ot[0].no_rate} overtime record(s) carry no rate, so a cost cannot be given.`
        : 'Wren holds no separate agency-spend record — this is overtime only.' }));

  // ── upcoming leave ───────────────────────────────────────────────────────
  const soon = addDaysIso(P.end, 60);
  const leave = await q(db, sec, 'upcoming leave', `
    SELECT btrim(COALESCE(s.preferred_name, s.first_name, '') || ' ' || COALESCE(s.last_name, '')) AS name,
           ar.start_date::text AS start_date, COALESCE(ar.end_date, ar.start_date)::text AS end_date,
           COALESCE(ar.absence_type, ar.request_type, 'leave') AS kind,
           COALESCE(ar.status, 'requested') AS status
      FROM absence_requests ar JOIN staff s ON s.id = ar.staff_id
     WHERE ar.start_date > $1::date AND ar.start_date <= $2::date
       AND COALESCE(ar.status, 'approved') NOT IN ('rejected', 'cancelled', 'declined')
     ORDER BY ar.start_date LIMIT 25`, [P.end, soon]);
  if (leave && leave.length) {
    sec.tables.push({
      title: `Leave booked in the next 60 days (to ${soon})`,
      columns: ['Staff', 'From', 'To', 'Type', 'Status'],
      rows: leave.map(l => [l.name, l.start_date, l.end_date, l.kind, l.status]),
    });
  } else if (leave) {
    sec.bullets.push(`No staff leave is booked between ${addDaysIso(P.end, 1)} and ${soon}.`);
  }

  return finishSection(sec);
}

/* ══════════ 3. CPD ════════════════════════════════════════════════════════ */

// Certificate kinds the owner cares about. sen_apdr_review is deliberately NOT
// here: its subject is a CHILD, and no child name may leave the building.
const CPD_KINDS = ['paediatric_first_aid', 'safeguarding_training', 'mandatory_training',
                   'dbs', 'right_to_work', 'visa', 'induction'];

async function collectCpd(db, P, V) {
  const sec = section('cpd', 'CPD & certificates', '🎓', '/cpd-matrix.html');

  const doneSql = `
    SELECT count(*)::int AS n, count(DISTINCT staff_id)::int AS staff,
           COALESCE(SUM(hours), 0)::numeric AS hours
      FROM cpd_records WHERE completion_date BETWEEN $1::date AND $2::date`;
  const done  = await q(db, sec, 'CPD records', doneSql, [P.start, P.end]);
  const doneP = done === null ? null : await q(db, sec, 'CPD records (previous month)', doneSql, [V.start, V.end]);
  const cpdEver = await everUsed(db, 'cpd_records');
  sec.metrics.push(metric('Courses completed',
    (done && cpdEver) ? Number(done[0].n) : null,
    (doneP && cpdEver) ? Number(doneP[0].n) : null,
    { polarity: 'higher_better',
      note: cpdEver === false
        ? 'No CPD record has ever been entered, so this is blank rather than zero.'
        : (done && Number(done[0].n) ? `${done[0].staff} member(s) of staff, ${round1(Number(done[0].hours))} CPD hours.` : null) }));

  const authSql = `
    SELECT count(*)::int AS n FROM course_assignments
     WHERE authorised_at >= $1::date AND authorised_at < ($2::date + 1)`;
  const auth  = await q(db, sec, 'course assignments', authSql, [P.start, P.end]);
  const authP = auth === null ? null : await q(db, sec, 'course assignments (previous month)', authSql, [V.start, V.end]);
  const caEver = await everUsed(db, 'course_assignments');
  sec.metrics.push(metric('In-house courses authorised',
    (auth && caEver) ? Number(auth[0].n) : null,
    (authP && caEver) ? Number(authP[0].n) : null,
    { polarity: 'higher_better',
      note: caEver === false ? 'No in-house course has ever been assigned, so this is blank rather than zero.' : null }));

  // ── expiring / overdue certificates ──────────────────────────────────────
  // Reuses b186's compliance-expiry collector so the digest and the Single
  // Central Record can never disagree. It answers as of TODAY (forward-looking,
  // which is what the owner needs), not as of the month end.
  let expiring = null;
  try {
    const { collectExpiring } = require(path.join(__dirname, 'compliance-expiry'));
    const res = await collectExpiring(db, { kinds: CPD_KINDS });
    // Belt-and-braces: a child-subject item must never reach this email.
    expiring = { window_days: res.window_days, items: res.items.filter(i => i.subject_type !== 'child') };
  } catch (e) {
    sec.notes.push(`Certificate expiry sweep unavailable (${e.message.split('\n')[0]}).`);
  }

  if (expiring) {
    const overdue = expiring.items.filter(i => i.status === 'overdue');
    const soon    = expiring.items.filter(i => i.status === 'due_soon');
    sec.metrics.push(metric('Certificates overdue now', overdue.length, null, { polarity: 'lower_better' }));
    sec.metrics.push(metric(`Expiring within ${expiring.window_days} days`, soon.length, null, { polarity: 'lower_better' }));
    const KL = require(path.join(__dirname, 'compliance-expiry')).KIND_LABELS;
    if (overdue.length || soon.length) {
      sec.tables.push({
        title: 'Overdue and expiring',
        columns: ['Staff', 'Item', 'Due', 'Status'],
        rows: [...overdue, ...soon].slice(0, 30).map(i => [
          i.subject_name, KL[i.kind] || i.kind, i.due_date,
          i.status === 'overdue' ? `OVERDUE by ${Math.abs(i.days_remaining)}d` : `${i.days_remaining}d left`,
        ]),
        note: `Checked as at today, not at the end of ${P.label}. Window: ${expiring.window_days} days.`,
      });
    } else {
      sec.bullets.push(`Nothing is overdue and nothing expires in the next ${expiring.window_days} days.`);
    }
  }

  // ── what is booked ───────────────────────────────────────────────────────
  const booked = await q(db, sec, 'booked training', `
    SELECT COALESCE(co.name, 'course #' || ca.course_id) AS course,
           count(*)::int AS n, MIN(ca.due_date)::text AS next_due
      FROM course_assignments ca
      LEFT JOIN courses co ON co.id = ca.course_id
     WHERE COALESCE(ca.status, 'assigned') IN ('assigned', 'in_progress', 'started', 'booked')
     GROUP BY 1 ORDER BY 3 NULLS LAST LIMIT 15`);
  if (booked && booked.length) {
    sec.tables.push({
      title: 'Booked / assigned and not yet complete',
      columns: ['Course', 'Staff assigned', 'Earliest due'],
      rows: booked.map(b => [b.course, String(b.n), b.next_due || 'no due date']),
    });
  } else if (booked) {
    sec.bullets.push('No in-house course is currently assigned and outstanding.');
  }

  if (done && !Number(done[0].n) && (!doneP || !Number(doneP[0].n))) {
    sec.notes.push('No CPD completions are recorded for either month. cpd_records is the source; '
      + 'external training completed outside Wren will not appear here.');
  }
  return finishSection(sec);
}

/* ══════════ 4. PERFORMANCE (b183 headline only) ═══════════════════════════ */

async function collectPerformance(db, P) {
  const sec = section('performance', 'Practice & performance', '🌱', '/staff-performance.html');
  sec.notes.push('Headline only — the full staff-performance report (b183) goes to the '
    + 'management group and stays in Roost.');

  const rows = await q(db, sec, 'staff analytics reports', `
    SELECT id, scope_from::text AS scope_from, scope_to::text AS scope_to,
           generated_at, deterministic_stats, narrative_summary
      FROM staff_analytics_reports
     WHERE report_type = 'obs_performance'
     ORDER BY generated_at DESC LIMIT 1`);

  if (!rows || !rows.length) {
    sec.notes.push('No observation-practice report has been generated yet — run it from '
      + 'Roost → Staff → Performance and it will appear here next month.');
    return finishSection(sec);
  }

  const r = rows[0];
  const stats = r.deterministic_stats || {};
  const by = Array.isArray(stats.by_staff) ? stats.by_staff : [];
  const observing = by.filter(s => Number(s.obs_window) > 0);
  const totalObs  = observing.reduce((s, x) => s + Number(x.obs_window || 0), 0);
  const withNs    = observing.reduce((s, x) => s + Number(x.next_steps_count || 0), 0);

  sec.metrics.push(metric('Observation events in the report window', totalObs || null, null,
    { polarity: 'higher_better',
      note: stats.window_days ? `Rolling ${stats.window_days}-day window, not the calendar month.` : null }));
  sec.metrics.push(metric('Practitioners observing', observing.length || null, null,
    { polarity: 'higher_better',
      note: by.length ? `Out of ${by.length} active staff.` : null }));
  sec.metrics.push(metric('Observations carrying a next step',
    totalObs ? (withNs / totalObs) * 100 : null, null,
    { format: fmtPct, polarity: 'higher_better' }));

  sec.bullets.push(`Last generated ${new Date(r.generated_at).toISOString().slice(0, 10)}`
    + (r.scope_from ? `, covering ${r.scope_from} to ${r.scope_to}.` : '.'));
  sec.bullets.push('These are supportive coaching signals about practice, not a ranking and not '
    + 'a performance score. Read the full report in Roost before acting on any of it.');
  sec.bullets.push('Full report: Roost → Staff → Performance (/staff-performance.html).');

  return finishSection(sec);
}

/* ══════════ 5. FINANCE ════════════════════════════════════════════════════ */

async function collectFinance(db, P, V) {
  const sec = section('finance', 'Finance', '💷', '/finance.html');
  sec.notes.push('An invoice is counted in the month it was issued; where issued_on is blank '
    + 'the date it was created is used instead.');

  const invSql = `
    SELECT count(*)::int AS n,
           COALESCE(SUM(i.amount_pence), 0)::bigint AS gross,
           COALESCE(SUM(COALESCE(i.funding_deduction_pence, 0)), 0)::bigint AS funding
      FROM invoices i
      LEFT JOIN children c ON c.id = i.child_id
     WHERE COALESCE(i.issued_on, i.created_at::date) BETWEEN $1::date AND $2::date
       AND COALESCE(i.status, '') <> 'void'
       AND COALESCE(c.is_demo, false) = false`;
  const inv  = await q(db, sec, 'invoices', invSql, [P.start, P.end]);
  const invP = inv === null ? null : await q(db, sec, 'invoices (previous month)', invSql, [V.start, V.end]);
  sec.metrics.push(metric('Invoiced',
    inv  ? Number(inv[0].gross)  : null,
    invP ? Number(invP[0].gross) : null,
    { format: fmtMoney, polarity: 'higher_better',
      note: inv ? `${inv[0].n} invoice(s) raised.` : null }));

  const paySql = `
    SELECT count(*)::int AS n, COALESCE(SUM(p.amount_pence), 0)::bigint AS total
      FROM payments p
      LEFT JOIN children c ON c.id = p.child_id
     WHERE p.created_at >= $1::date AND p.created_at < ($2::date + 1)
       AND COALESCE(p.status, 'succeeded') IN ('succeeded', 'paid', 'completed', 'settled')
       AND COALESCE(c.is_demo, false) = false`;
  const pay  = await q(db, sec, 'payments', paySql, [P.start, P.end]);
  const payP = pay === null ? null : await q(db, sec, 'payments (previous month)', paySql, [V.start, V.end]);
  sec.metrics.push(metric('Collected',
    pay  ? Number(pay[0].total)  : null,
    payP ? Number(payP[0].total) : null,
    { format: fmtMoney, polarity: 'higher_better',
      note: pay ? `${pay[0].n} payment(s) recorded.` : null }));

  if (inv && pay && Number(inv[0].gross)) {
    sec.metrics.push(metric('Collected as a share of invoiced',
      (Number(pay[0].total) / Number(inv[0].gross)) * 100,
      (invP && payP && Number(invP[0].gross)) ? (Number(payP[0].total) / Number(invP[0].gross)) * 100 : null,
      { format: fmtPct, polarity: 'higher_better',
        note: 'Payments landing this month may settle invoices raised in an earlier one, so this can exceed 100%.' }));
  }

  // ── outstanding by age, as at the month end ──────────────────────────────
  const aged = await q(db, sec, 'outstanding balances', `
    SELECT CASE
             WHEN due IS NULL                THEN 'no due date'
             WHEN due > $1::date             THEN 'not yet due'
             WHEN $1::date - due <= 30       THEN '1–30 days'
             WHEN $1::date - due <= 60       THEN '31–60 days'
             WHEN $1::date - due <= 90       THEN '61–90 days'
             ELSE '90+ days' END              AS bucket,
           count(*)::int                      AS n,
           COALESCE(SUM(amount_pence), 0)::bigint AS total
      FROM (SELECT i.amount_pence, i.due_on AS due FROM invoices i
             LEFT JOIN children c ON c.id = i.child_id
             WHERE COALESCE(i.status, '') NOT IN ('paid', 'void', 'cancelled', 'credited')
               AND i.paid_on IS NULL
               AND COALESCE(i.issued_on, i.created_at::date) <= $1::date
               AND COALESCE(c.is_demo, false) = false) t
     GROUP BY 1`, [P.end]);
  if (aged && aged.length) {
    const order = ['not yet due', '1–30 days', '31–60 days', '61–90 days', '90+ days', 'no due date'];
    aged.sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket));
    const outstanding = aged.reduce((s, r) => s + Number(r.total), 0);
    const overdue = aged.filter(r => !['not yet due', 'no due date'].includes(r.bucket))
                        .reduce((s, r) => s + Number(r.total), 0);
    sec.metrics.push(metric(`Outstanding at ${P.end}`, outstanding, null,
      { format: fmtMoney, polarity: 'lower_better' }));
    sec.metrics.push(metric('Of which past its due date', overdue, null,
      { format: fmtMoney, polarity: 'lower_better' }));
    sec.tables.push({
      title: `Outstanding by age, as at ${P.end}`,
      columns: ['Age', 'Invoices', 'Amount'],
      rows: aged.map(r => [r.bucket, String(r.n), fmtMoney(r.total)]),
    });
  } else if (aged) {
    sec.bullets.push(`Nothing was outstanding at ${P.end}.`);
  }

  // ── funding claimed vs expected ──────────────────────────────────────────
  const sub = await q(db, sec, 'funding submissions', `
    SELECT count(*)::int AS n,
           COALESCE(SUM(total_hours_claimed), 0)::numeric AS hours,
           COALESCE(SUM(total_value), 0)::numeric         AS value
      FROM funding_submissions
     WHERE submitted_at >= $1::date AND submitted_at < ($2::date + 1)`, [P.start, P.end]);
  const expected = await q(db, sec, 'expected funding', `
    SELECT COALESCE(SUM(cf.total_hours_week), 0)::numeric AS weekly_hours,
           count(*)::int AS n
      FROM child_funding cf
      JOIN funding_terms ft ON ft.id = cf.term_id
      LEFT JOIN children c ON c.id = cf.child_id
     WHERE ft.start_date <= $2::date AND ft.end_date >= $1::date
       AND COALESCE(c.is_demo, false) = false`, [P.start, P.end]);

  const claimedValue = (sub && Number(sub[0].n)) ? Math.round(Number(sub[0].value) * 100) : null;
  sec.metrics.push(metric('Funding claimed', claimedValue, null,
    { format: fmtMoney,
      note: (sub && !Number(sub[0].n))
        ? 'No funding submission was made this month — the claim may sit outside the month, or outside Wren.'
        : null }));
  if (expected && Number(expected[0].n)) {
    const wk = Number(expected[0].weekly_hours);
    sec.bullets.push(`${expected[0].n} funded child record(s) live in ${P.label}, `
      + `entitled to ${round1(wk)} funded hours a week between them `
      + `(≈${round1(wk * (P.weekdays / 5))} hours over the month).`);
  } else if (expected) {
    sec.notes.push('No child_funding rows overlap this month, so expected funding cannot be stated.');
  }

  return finishSection(sec);
}

/* ══════════ 6. COMPLIANCE (COUNTS ONLY) ═══════════════════════════════════ */

async function collectCompliance(db, P, V) {
  const sec = section('compliance', 'Compliance', '🛡️', '/compliance.html');
  sec.notes.push('Counts only. No child is named and no detail of any concern appears here or '
    + 'in the attached PDF — this email leaves the building. Open the record in Roost.');

  const incSql = `
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE COALESCE(riddor_reportable, false))::int AS riddor,
           count(*) FILTER (WHERE manager_reviewed_at IS NULL AND manager_sign_off_at IS NULL)::int AS unreviewed
      FROM incidents WHERE incident_date BETWEEN $1::date AND $2::date`;
  const inc  = await q(db, sec, 'incidents', incSql, [P.start, P.end]);
  const incP = inc === null ? null : await q(db, sec, 'incidents (previous month)', incSql, [V.start, V.end]);
  sec.metrics.push(metric('Accidents / incidents logged',
    inc ? Number(inc[0].n) : null, incP ? Number(incP[0].n) : null, { polarity: 'lower_better' }));
  if (inc && Number(inc[0].riddor)) {
    sec.metrics.push(metric('Of which RIDDOR-reportable', Number(inc[0].riddor), null, { polarity: 'lower_better' }));
  }
  if (inc && Number(inc[0].unreviewed)) {
    sec.bullets.push(`${inc[0].unreviewed} incident(s) from ${P.label} have not yet been signed off by a manager.`);
  }

  const sgSql = `
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE COALESCE(is_referral, false))::int AS referrals,
           count(*) FILTER (WHERE COALESCE(status, 'open') NOT IN ('closed', 'resolved'))::int AS open
      FROM safeguarding_concerns WHERE concern_date >= $1::date AND concern_date < ($2::date + 1)`;
  const sg  = await q(db, sec, 'safeguarding concerns', sgSql, [P.start, P.end]);
  const sgP = sg === null ? null : await q(db, sec, 'safeguarding concerns (previous month)', sgSql, [V.start, V.end]);
  sec.metrics.push(metric('Safeguarding concerns raised',
    sg ? Number(sg[0].n) : null, sgP ? Number(sgP[0].n) : null,
    { polarity: 'neutral', note: 'A count only. More is not automatically worse — recording is what matters.' }));
  if (sg) {
    sec.metrics.push(metric('Of which referred on', Number(sg[0].referrals), null, { polarity: 'neutral' }));
    sec.metrics.push(metric('Still open', Number(sg[0].open), null, { polarity: 'lower_better' }));
  }

  // ── fire drill ───────────────────────────────────────────────────────────
  const drill = await q(db, sec, 'fire drills', `
    SELECT MAX(drill_date)::text AS last_drill,
           MAX(next_drill_due)::text AS next_due,
           count(*) FILTER (WHERE drill_date BETWEEN $1::date AND $2::date)::int AS in_month
      FROM fire_drills`, [P.start, P.end]);
  if (drill && drill[0].last_drill) {
    const nd = drill[0].next_due;
    sec.bullets.push(`Fire drills: last held ${drill[0].last_drill}`
      + (Number(drill[0].in_month) ? ` (${drill[0].in_month} in ${P.label})` : ` (none in ${P.label})`)
      + (nd ? `; next due ${nd}${nd < P.end ? ' — OVERDUE' : ''}.` : '; no next date set.'));
  } else if (drill) {
    sec.notes.push('No fire drill has ever been recorded in Wren (fire_drills is empty).');
  }

  // ── setting incidents (b193) ─────────────────────────────────────────────
  // The third record: fire, intruder, lost child, outbreak, near miss. COUNTS
  // ONLY — no category is named against a child and no description is carried,
  // because this email leaves the building.
  const siSql = `
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE severity = 'major')::int AS major,
           count(*) FILTER (WHERE status <> 'closed')::int AS open
      FROM setting_incidents WHERE occurred_at >= $1::date AND occurred_at < ($2::date + 1)`;
  const si  = await q(db, sec, 'setting incidents', siSql, [P.start, P.end]);
  const siV = si === null ? null : await q(db, sec, 'setting incidents (previous month)', siSql, [V.start, V.end]);
  if (si) {
    sec.metrics.push(metric('Setting incidents logged',
      Number(si[0].n), siV ? Number(siV[0].n) : null,
      { polarity: 'neutral',
        note: 'Significant events at the setting — fire, intruder, lost child, outbreak, near miss. '
            + 'A count only; recording a near miss is a good sign, not a bad one.' }));
    if (Number(si[0].major)) {
      sec.metrics.push(metric('Of which major', Number(si[0].major), null, { polarity: 'lower_better' }));
    }
    if (Number(si[0].open)) {
      sec.bullets.push(`${si[0].open} setting incident(s) from ${P.label} are still open or under review.`);
    }
  }

  // Ofsted notifications are a STANDING position, not a monthly count: an
  // un-notified notifiable event stays a problem until it is notified, so this
  // reads the whole open set rather than the month.
  const ofs = await q(db, sec, 'Ofsted notifications', `
    SELECT count(*) FILTER (WHERE ofsted_notified_at IS NULL)::int AS outstanding,
           count(*) FILTER (WHERE ofsted_notified_at IS NULL AND ofsted_due_by < CURRENT_DATE)::int AS overdue,
           min(ofsted_due_by)::text AS earliest_due
      FROM setting_incidents WHERE ofsted_notifiable = true`);
  if (ofs) {
    sec.metrics.push(metric('Ofsted notifications outstanding',
      Number(ofs[0].outstanding), null, { polarity: 'lower_better',
        note: 'EYFS allows 14 days to notify Ofsted of a significant event.' }));
    if (Number(ofs[0].overdue)) {
      sec.bullets.push(`⚠️ ${ofs[0].overdue} Ofsted notification(s) are PAST the 14-day deadline`
        + (ofs[0].earliest_due ? ` (earliest due ${ofs[0].earliest_due})` : '')
        + '. Open Setting Incidents in Roost — the reference is on the record.');
    } else if (Number(ofs[0].outstanding)) {
      sec.bullets.push(`${ofs[0].outstanding} Ofsted notification(s) are due but not yet overdue`
        + (ofs[0].earliest_due ? `; the earliest deadline is ${ofs[0].earliest_due}.` : '.'));
    }
  }

  // ── policy reviews ───────────────────────────────────────────────────────
  const pol = await q(db, sec, 'policy reviews', `
    SELECT count(*) FILTER (WHERE review_due < CURRENT_DATE)::int AS overdue,
           count(*) FILTER (WHERE review_due >= CURRENT_DATE
                              AND review_due <= CURRENT_DATE + 60)::int AS due_soon,
           count(*)::int AS total
      FROM policies WHERE COALESCE(is_active, true) = true AND review_due IS NOT NULL`);
  if (pol) {
    sec.metrics.push(metric('Policy reviews overdue', Number(pol[0].overdue), null, { polarity: 'lower_better' }));
    sec.metrics.push(metric('Policy reviews due within 60 days', Number(pol[0].due_soon), null, { polarity: 'lower_better' }));
    sec.bullets.push(`${pol[0].total} active policies carry a review date.`);
  }

  // ── assigned staff tasks (b209) ──────────────────────────────────────────
  // The fire-drill check, the first-aid stock count, the medication audit: the
  // recurring jobs that prove the statutory checks happened. What the owner
  // needs from a month is one number — did the work that was due get done —
  // and the count of anything still hanging over. No task title is carried:
  // a title can name a child ("chase Ofsted form for …") and this email leaves
  // the building. Open the board in Roost for the detail.
  const taskSql = `
    SELECT count(*)::int AS due_tasks,
           count(*) FILTER (WHERE status = 'done')::int AS completed,
           count(*) FILTER (WHERE status IN ('open','in_progress'))::int AS still_open
      FROM tasks WHERE due_date BETWEEN $1::date AND $2::date`;
  const tk  = await q(db, sec, 'staff tasks', taskSql, [P.start, P.end]);
  const tkP = tk === null ? null : await q(db, sec, 'staff tasks (previous month)', taskSql, [V.start, V.end]);
  if (tk && Number(tk[0].due_tasks)) {
    const rate  = Math.round((Number(tk[0].completed) / Number(tk[0].due_tasks)) * 100);
    const rateP = (tkP && Number(tkP[0].due_tasks))
      ? Math.round((Number(tkP[0].completed) / Number(tkP[0].due_tasks)) * 100) : null;
    sec.metrics.push(metric('Assigned tasks completed', rate, rateP,
      { format: v => `${v}%`, polarity: 'higher_better',
        note: `${tk[0].completed} of ${tk[0].due_tasks} tasks due in ${P.label} are marked done.` }));
    if (Number(tk[0].still_open)) {
      sec.bullets.push(`${tk[0].still_open} task(s) due in ${P.label} are still open — see Staff Tasks in Roost.`);
    }
  } else if (tk) {
    sec.notes.push(`No staff tasks carried a due date in ${P.label}, so there is no completion rate to report.`);
  }

  return finishSection(sec);
}

/* ══════════ BUILD ═════════════════════════════════════════════════════════ */

/**
 * Build the whole digest for a month.
 * @param {object} db      pg pool (search_path already set per edition)
 * @param {string} monthStr 'YYYY-MM' — the month being reported ON
 */
async function buildOwnerDigest(db, monthStr) {
  const P = monthMeta(monthStr);
  const V = monthMeta(prevMonthOf(monthStr));

  let settingName = 'Your Nursery';
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key IN ('setting_name','nursery_name') LIMIT 1`);
    if (rows.length && rows[0].value) settingName = rows[0].value;
  } catch (_) { /* keep the default */ }

  const sections = [];
  const collectors = [
    ['occupancy',   () => collectOccupancy(db, P, V)],
    ['staffing',    () => collectStaffing(db, P, V)],
    ['cpd',         () => collectCpd(db, P, V)],
    ['performance', () => collectPerformance(db, P)],
    ['finance',     () => collectFinance(db, P, V)],
    ['compliance',  () => collectCompliance(db, P, V)],
  ];
  for (const [key, fn] of collectors) {
    try {
      sections.push(await fn());
    } catch (e) {
      // One broken section must not cost the owner the other five.
      const sec = section(key, key[0].toUpperCase() + key.slice(1), '⚠️', null);
      sec.no_data = true;
      sec.notes.push(`This section could not be built: ${e.message.split('\n')[0]}`);
      sections.push(sec);
    }
  }

  const digest = {
    month: P.month, month_label: P.label,
    prev_month: V.month, prev_month_label: V.label,
    period: { start: P.start, end: P.end, weekdays: P.weekdays },
    prev_period: { start: V.start, end: V.end, weekdays: V.weekdays },
    generated_at: new Date().toISOString(),
    setting_name: settingName,
    sections,
  };
  digest.headlines = headlineMetrics(digest);
  return digest;
}

/** The handful of figures that belong in the email body / on a phone. */
const HEADLINE_KEYS = [
  ['occupancy',   'Occupancy (all rooms)'],
  ['staffing',    'Hours rostered'],
  ['staffing',    'Staff absence days'],
  ['cpd',         'Certificates overdue now'],
  ['finance',     'Invoiced'],
  ['finance',     'Collected'],
  ['compliance',  'Accidents / incidents logged'],
  ['compliance',  'Safeguarding concerns raised'],
  ['compliance',  'Setting incidents logged'],            // b193
  ['compliance',  'Ofsted notifications outstanding'],    // b193 — a statutory clock, headline it
];

function headlineMetrics(digest) {
  const out = [];
  for (const [secKey, label] of HEADLINE_KEYS) {
    const sec = digest.sections.find(s => s.key === secKey);
    if (!sec) continue;
    const m = sec.metrics.find(x => x.label === label);
    if (m) out.push({ section: sec.title, ...m });
  }
  return out;
}

/** One line, for a notification title or a log. */
function summaryLine(digest) {
  const occ = digest.headlines.find(h => h.label === 'Occupancy (all rooms)');
  const inv = digest.headlines.find(h => h.label === 'Invoiced');
  const bits = [];
  bits.push(occ && occ.value != null ? `occupancy ${occ.display} ${occ.arrow}` : 'occupancy not recorded');
  bits.push(inv && inv.value != null ? `invoiced ${inv.display}` : 'nothing invoiced');
  const missing = digest.sections.filter(s => s.no_data).length;
  if (missing) bits.push(`${missing} of ${digest.sections.length} sections have no data`);
  return `${digest.month_label}: ${bits.join(', ')}.`;
}

/* ══════════ GDPR GUARD ════════════════════════════════════════════════════ */

// Words that are also ordinary vocabulary in this document. A bare name token
// matching one of these says nothing — wren_dev's scrubbed children are literally
// called "Child Wren", which would otherwise trip the guard on the sentence that
// promises no child is named.
const NAME_STOPWORDS = new Set([
  'child', 'children', 'wren', 'baby', 'room', 'rooms', 'staff', 'day', 'days',
  'angel', 'angels', 'little', 'nursery', 'school', 'pre', 'preschool', 'test',
  'demo', 'dev', 'none', 'new', 'first', 'last', 'name',
  ...MONTH_NAMES.map(m => m.toLowerCase()),
  ...DAY_NAMES.map(d => d.toLowerCase()),
]);

/**
 * Only the strings that carry DATA READ FROM THE DATABASE — table cells, metric
 * values and their notes, and the bullets that interpolate query results. The
 * section prose I wrote is excluded on purpose: scanning it makes the guard fire
 * on its own promise not to name a child.
 */
function dynamicStrings(digest) {
  const cells = [], other = [];
  for (const sec of digest.sections || []) {
    for (const t of sec.tables || []) {
      for (const row of t.rows || []) {
        for (const c of row) if (c != null) cells.push(String(c));
      }
    }
    for (const m of sec.metrics || []) {
      if (m.display) other.push(String(m.display));
      if (m.prev_display) other.push(String(m.prev_display));
      if (m.note) other.push(String(m.note));
    }
    for (const b of sec.bullets || []) other.push(String(b));
  }
  return { cells, all: cells.concat(other) };
}

const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Belt-and-braces: no child may be identifiable in the rendered digest.
 *
 * BLOCKING check — a child's FULL name ("Ada Lovelace") anywhere in the data-bearing
 * text. That is unambiguous: nothing in this report has any business carrying one.
 *
 * ADVISORY check — a bare first or last name inside a TABLE CELL, which is the only
 * place a stray person name could realistically be rendered. Reported as `warnings`
 * because staff and children legitimately share first names and blocking the owner's
 * whole digest over "Sophie" would be worse than the risk it guards against.
 *
 * Staff names are expected throughout and are never checked.
 *
 * @returns {{ok:boolean, hits:string[], warnings:string[], skipped?:string}}
 */
async function assertNoChildNames(db, digest) {
  let rows;
  try {
    ({ rows } = await db.query(`
      SELECT btrim(COALESCE(first_name, '')) AS first_name,
             btrim(COALESCE(preferred_name, '')) AS preferred_name,
             btrim(COALESCE(last_name, '')) AS last_name
        FROM children`));
  } catch (e) {
    return { ok: true, hits: [], warnings: [],
             skipped: `children table unreadable (${e.message.split('\n')[0]})` };
  }

  const fullNames = new Set();
  const parts = new Set();
  for (const r of rows) {
    for (const given of [r.first_name, r.preferred_name]) {
      if (given && r.last_name) fullNames.add(`${given} ${r.last_name}`);
      if (given && given.length >= 3) parts.add(given);
    }
    if (r.last_name && r.last_name.length >= 3) parts.add(r.last_name);
  }

  const { cells, all } = dynamicStrings(digest);
  const allBlob  = all.join('\n');
  const cellBlob = cells.join('\n');

  const hits = [];
  for (const n of fullNames) {
    if (new RegExp(`\\b${reEsc(n)}\\b`, 'i').test(allBlob)) hits.push(n);
  }
  const warnings = [];
  for (const n of parts) {
    if (NAME_STOPWORDS.has(n.toLowerCase())) continue;
    if (new RegExp(`\\b${reEsc(n)}\\b`, 'i').test(cellBlob)) warnings.push(n);
  }

  return { ok: hits.length === 0, hits, warnings };
}

module.exports = {
  buildOwnerDigest,
  summaryLine,
  headlineMetrics,
  assertNoChildNames,
  monthMeta,
  prevMonthOf,
  monthBefore,
  weekdaysBetween,
  everUsed,
  isGood,
  fmtMoney, fmtPct, fmtHours, fmtInt, fmtDays,
  ARROWS,
};
