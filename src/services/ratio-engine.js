// Deterministic staffing-ratio engine for the absence gatekeeper (A3).
// NO LLM — pure arithmetic + DB reads. qwen only writes wording elsewhere.
//
// NURSERY-CONTEXT source of truth:
//   Q2 ratios: under-2 → 1:3, 2yr → 1:5, 3yr+ → 1:8
//   Q5 not counted in ratio: manager (Toby), chef (Hetty), Clare
//   Q6 must keep enough staff on the day +1 (a spare for same-day sickness)
//   Q9 no leave block > 2 weeks (14 days) without written manager permission
//
// BOOKING DATA CAVEAT: as of 2026-06-12 ladn.attendance is empty and there is no
// contracted-days table, so bookedChildrenByBand() derives expected bookings from
// attendance over a trailing window. With no data it returns zeros and every date
// trivially passes — the engine is correct but needs a bookings source to be useful.

const RATIOS = { under2: 3, two: 5, threePlus: 8 };
const EXCLUDED_ROLES = ['manager', 'chef', 'owner'];
const EXCLUDED_NAME_RE = /\b(hetty|clare)\b/i;
const SPARE_BUFFER = 1;            // Q6: keep one spare staff above the requirement
const MAX_BLOCK_DAYS = 14;         // Q9
const LOOKBACK_WEEKS = 8;          // booking-pattern derivation window
const SEARCH_HORIZON_DAYS = 90;    // how far ahead to look for nearest passing dates

function ageBandOn(dob, dateStr) {
  const d = new Date(dateStr), b = new Date(dob);
  let yrs = d.getFullYear() - b.getFullYear();
  const m = d.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && d.getDate() < b.getDate())) yrs--;
  if (yrs < 2) return 'under2';
  if (yrs < 3) return 'two';
  return 'threePlus';
}

function requiredStaff(counts) {
  return Math.ceil((counts.under2 || 0) / RATIOS.under2)
       + Math.ceil((counts.two || 0) / RATIOS.two)
       + Math.ceil((counts.threePlus || 0) / RATIOS.threePlus);
}

// Booked children by age band on a given date (weekday-pattern proxy from attendance).
async function bookedChildrenByBand(db, dateStr) {
  const dow = new Date(dateStr + 'T00:00:00').getDay(); // 0=Sun..6=Sat
  // Children expected on this weekday = attended that weekday at least once in lookback.
  const { rows } = await db.query(`
    SELECT DISTINCT c.id, c.date_of_birth
    FROM ladn.children c
    JOIN ladn.attendance a ON a.child_id = c.id
    WHERE c.is_active = true AND c.date_of_birth IS NOT NULL
      AND EXTRACT(DOW FROM a.date) = $1
      AND a.date > (CURRENT_DATE - ($2 * 7) * INTERVAL '1 day')
      AND COALESCE(a.absent,false) = false
  `, [dow, LOOKBACK_WEEKS]);
  const counts = { under2: 0, two: 0, threePlus: 0, total: rows.length };
  for (const r of rows) counts[ageBandOn(r.date_of_birth, dateStr)]++;
  return counts;
}

// Staff available to count in ratio on a given date (excludes excluded roles/names,
// excludes anyone with approved leave covering the date, and optionally one candidate).
async function availableRatioStaff(db, dateStr, excludeStaffId) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const { rows } = await db.query(`
    SELECT DISTINCT s.id, s.first_name, s.last_name, s.role
    FROM ladn.staff s
    JOIN ladn.staff_work_patterns wp ON wp.staff_id = s.id
    WHERE s.is_active = true
      AND wp.day_of_week = $1
      AND COALESCE(wp.is_off,false) = false
      AND (wp.effective_from IS NULL OR wp.effective_from <= $2::date)
      AND (wp.effective_to   IS NULL OR wp.effective_to   >= $2::date)
      AND s.id <> COALESCE($3,-1)
      AND NOT EXISTS (
        SELECT 1 FROM ladn.absence_requests ar
        WHERE ar.staff_id = s.id AND ar.status='approved'
          AND ar.start_date <= $2::date AND ar.end_date >= $2::date)
  `, [dow, dateStr, excludeStaffId || null]);
  return rows.filter(r =>
    !EXCLUDED_ROLES.includes((r.role || '').toLowerCase()) &&
    !EXCLUDED_NAME_RE.test(`${r.first_name || ''} ${r.last_name || ''}`));
}

async function checkDate(db, dateStr, excludeStaffId) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const weekend = (dow === 0 || dow === 6);
  const booked = await bookedChildrenByBand(db, dateStr);
  const required = requiredStaff(booked);
  const available = (await availableRatioStaff(db, dateStr, excludeStaffId)).length;
  const need = required + SPARE_BUFFER;          // Q6 +1 spare
  const pass = weekend || booked.total === 0 || available >= need;
  return {
    date: dateStr, weekday: dow, weekend,
    booked, required, spare_buffer: SPARE_BUFFER, need, available, pass,
    reason: pass
      ? (weekend ? 'Weekend — nursery closed.' : (booked.total === 0 ? 'No children booked.' : `OK: ${available} staff available, ${need} needed (incl. +1 spare).`))
      : `Ratios fail: only ${available} ratio staff available but ${required} required +${SPARE_BUFFER} spare = ${need} needed (booked: ${booked.under2}×<2, ${booked.two}×2yr, ${booked.threePlus}×3yr+).`
  };
}

function addDays(dateStr, n) {
  // Build from LOCAL components — toISOString() would shift the date on BST/non-UTC hosts.
  const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

// Check a whole requested range. Returns { pass, days[], failing_days[], blackout, nearest }.
async function checkRange(db, startDate, endDate, excludeStaffId) {
  const len = daysBetween(startDate, endDate) + 1;
  const blackout = len > MAX_BLOCK_DAYS;
  const days = [];
  for (let i = 0; i < len; i++) days.push(await checkDate(db, addDays(startDate, i), excludeStaffId));
  const failing = days.filter(d => !d.pass);
  let nearest = null;
  if (failing.length) nearest = await nearestPassingWindow(db, startDate, len, excludeStaffId);
  return {
    pass: failing.length === 0,
    request_days: len,
    blackout,
    blackout_note: blackout ? `Request is ${len} days — over the ${MAX_BLOCK_DAYS}-day limit; written manager permission required.` : null,
    days,
    failing_days: failing.map(d => ({ date: d.date, reason: d.reason })),
    nearest_passing_dates: nearest
  };
}

// Find up to 3 future start dates of length `len` where every working day passes.
async function nearestPassingWindow(db, fromDate, len, excludeStaffId) {
  const found = [];
  for (let offset = 1; offset <= SEARCH_HORIZON_DAYS && found.length < 3; offset++) {
    const start = addDays(fromDate, offset);
    // Only propose weekday start dates — nursery is closed at weekends, so a
    // weekend "pass" is meaningless for a leave request.
    const sdow = new Date(start + 'T00:00:00').getDay();
    if (sdow === 0 || sdow === 6) continue;
    let ok = true;
    for (let i = 0; i < len; i++) {
      const c = await checkDate(db, addDays(start, i), excludeStaffId);
      if (!c.pass) { ok = false; break; }
    }
    if (ok) { found.push(start); offset += len - 1; }
  }
  return found;
}

module.exports = {
  RATIOS, ageBandOn, requiredStaff,
  bookedChildrenByBand, availableRatioStaff,
  checkDate, checkRange, nearestPassingWindow,
};
