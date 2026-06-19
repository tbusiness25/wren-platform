'use strict';
// Occupancy & ratio forecast (2026-06-16). Month-by-month room occupancy from
// children.start_date (in) / leave_date (out). Uses the child's CURRENT room
// (room_id) for placement and models baby→pre-school transfer at 24 months
// (the default; holdback/bring-forward flex is a planning lever, not auto-applied). Read-only.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
router.use(authenticate);
const managerOnly = (req, res, next) => {
  if (!['manager', 'room_leader'].includes(req.user.role)) return res.status(403).json({ error: 'Manager access required' });
  next();
};
const TRANSFER_AGE = 24, SCHOOL_AGE = 60;
const ymd = d => new Date(d).toISOString().slice(0, 10);
const ageMonths = (dob, at) => (new Date(at) - new Date(ymd(dob) + 'T00:00:00Z')) / (1000 * 60 * 60 * 24 * 30.4375);
function plusMonths(dateStr, n) { const t = new Date(dateStr + 'T00:00:00Z'); t.setUTCMonth(t.getUTCMonth() + n); return ymd(t); }

router.get('/forecast', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const now = new Date();
    const fp = (req.query.from || '').match(/^(\d{4})-(\d{2})$/);
    const fromY = fp ? +fp[1] : now.getUTCFullYear();
    const fromM = fp ? +fp[2] - 1 : now.getUTCMonth();
    const months = Math.min(Math.max(parseInt(req.query.months) || 18, 1), 36);

    const { rows: rooms } = await db.query(
      'SELECT id,name,capacity,min_age_months FROM ladn.rooms ORDER BY min_age_months');
    const babyRoom = rooms.find(r => r.min_age_months < TRANSFER_AGE) || { id: 1, capacity: 10 };
    const preRoom  = rooms.find(r => r.min_age_months >= TRANSFER_AGE) || { id: 2, capacity: 22 };
    const BABY_CAP = babyRoom.capacity, PRE_CAP = preRoom.capacity;

    const { rows: kids } = await db.query(`
      SELECT id, first_name, left(coalesce(last_name,''),1) AS li, room_id,
             date_of_birth AS dob, start_date, leave_date
      FROM ladn.children WHERE is_active=true AND date_of_birth IS NOT NULL`);

    const series = [];
    for (let k = 0; k < months; k++) {
      const d    = new Date(Date.UTC(fromY, fromM + k, 1));
      const mid  = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15));
      const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      const label = d.toISOString().slice(0, 7), first = ymd(d), last = ymd(mEnd), midS = ymd(mid);
      let babyN = 0, preN = 0, bUnder2 = 0, bAge2 = 0, bAge3 = 0; const leavers = [], starters = [], transfers = [];
      for (const c of kids) {
        const nm = c.first_name + ' ' + c.li + '.';
        const sd = c.start_date ? ymd(c.start_date) : null;
        const ld = c.leave_date ? ymd(c.leave_date) : null;
        if (ld && ld >= first && ld <= last) leavers.push({ id: c.id, name: nm, room: c.room_id === babyRoom.id ? 'baby' : 'pre' });
        if (sd && sd >= first && sd <= last) starters.push({ id: c.id, name: nm });
        const present = (!sd || sd <= last) && (!ld || ld >= first);
        if (!present) continue;
        if (ageMonths(c.dob, mid) >= SCHOOL_AGE && !ld) continue; // aged out, no leave recorded
        const roomNow = c.room_id === babyRoom.id ? 'baby'
                      : c.room_id === preRoom.id ? 'pre'
                      : (ageMonths(c.dob, mid) < TRANSFER_AGE ? 'baby' : 'pre');
        const tdate = plusMonths(ymd(c.dob), TRANSFER_AGE); // 2nd birthday
        let room = roomNow;
        if (roomNow === 'baby' && tdate <= midS) room = 'pre';                 // already transferred up
        if (roomNow === 'baby' && tdate >= first && tdate <= last) transfers.push({ id: c.id, name: nm });
        if (room === 'baby') babyN++; else preN++;
        // Statutory age band at mid-month (drives staff:child ratio).
        const am = ageMonths(c.dob, mid);
        if (am < 24) bUnder2++; else if (am < 36) bAge2++; else bAge3++;
      }
      // EYFS England statutory ratios: under-2 1:3, age-2 1:5, age 3-4 1:8.
      const RATIO = { under2: 3, age2: 5, age3plus: 8 };
      const requiredStaff = Math.ceil(bUnder2 / RATIO.under2) + Math.ceil(bAge2 / RATIO.age2) + Math.ceil(bAge3 / RATIO.age3plus);
      series.push({
        month: label,
        baby:      { count: babyN, capacity: BABY_CAP, headroom: Math.max(0, BABY_CAP - babyN), over: Math.max(0, babyN - BABY_CAP) },
        preschool: { count: preN, capacity: PRE_CAP, headroom: Math.max(0, PRE_CAP - preN), over: Math.max(0, preN - PRE_CAP) },
        ratios: { under2: bUnder2, age2: bAge2, age3plus: bAge3, required_staff: requiredStaff, rule: RATIO },
        leavers, starters, transfers
      });
    }
    const trough = series.reduce((m, s) => s.preschool.count < m.count ? { month: s.month, count: s.preschool.count, headroom: s.preschool.headroom } : m,
      { month: series[0].month, count: series[0].preschool.count, headroom: series[0].preschool.headroom });
    const august = series.filter(s => s.month.endsWith('-08')).map(s => ({ month: s.month, leavers: s.leavers.length }));
    res.json({ generated: ymd(now), from: series[0].month, months,
      baby_capacity: BABY_CAP, preschool_capacity: PRE_CAP, series,
      summary: { preschool_trough: trough, august_leavers: august } });
  } catch (e) { console.error('[occupancy]', e.message); res.status(500).json({ error: e.message }); }
});
module.exports = router;
