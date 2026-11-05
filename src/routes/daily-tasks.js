'use strict';
// GET /api/daily-tasks/pending — time-triggered completion checks for nursery staff
// Returns tasks that are (a) past their trigger time today and (b) not yet complete.
// Called from the EY home page every 5 min.

const router = require('express').Router();
const authenticate = require('../middleware/auth');
const { getPool } = require('../db/pool');

router.use(authenticate);

// Task schedule — times are UK local (the server is on docker-work in London)
const SCHEDULE = [
  { id: 'ra_baby',  title: 'Baby Room risk assessment', subtitle: 'Daily environmental check needed', link: '/ey/risk-assessments?category=daily&location=Baby+Room', color: 'red',    triggerHour: 7, triggerMin: 45 },
  { id: 'ra_pre',   title: 'Pre-school risk assessment', subtitle: 'Daily environmental check needed', link: '/ey/risk-assessments?category=daily&location=Pre-school',  color: 'red',    triggerHour: 7, triggerMin: 45 },
  // diaryfix2 (2026-10-13): these opened /ey/diary — the day's read-only list, which
  // ignores ?meal= — so "Add lunch" landed somewhere lunch could not be added. They
  // now open the one diary page on its meals view, scrolled to that meal.
  { id: 'lunch',    title: 'Lunch diary', subtitle: 'Add lunch for all children on register', link: '/ey/diary/entry?type=food&meal=lunch',  color: 'amber',  triggerHour: 11, triggerMin: 45 },
  { id: 'tea',      title: 'Tea diary',   subtitle: 'Add tea for all children on register',   link: '/ey/diary/entry?type=food&meal=tea',    color: 'orange', triggerHour: 15, triggerMin: 45 },
];

async function isDue(task, nowHour, nowMin) {
  return nowHour > task.triggerHour || (nowHour === task.triggerHour && nowMin >= task.triggerMin);
}

async function isComplete(task, today, client) {
  switch (task.id) {
    // b404 (2026-10-06): these two used to check the FORMAL risk_assessments
    // library (location ILIKE '%baby%' / '%pre%school%', status <> 'draft') —
    // a heavyweight Evolve-standard document, not the simple daily walk-round
    // this chip's own subtitle ("Daily environmental check needed") and its
    // target page (/ey/risk-assessments, the daily-checks panel) actually
    // point at. Staff essentially never create a formal RA from this tablet
    // flow, so the chip could never clear even after the room's daily check
    // was genuinely done. Fixed to check daily_safety_checks (opening, for
    // that specific room) — the same table/room-split the EY page now uses.
    case 'ra_baby': {
      const r = await client.query(
        `SELECT id FROM daily_safety_checks
         WHERE check_date=$1 AND check_type='opening' AND room='Baby Room'
         LIMIT 1`,
        [today]
      );
      return r.rowCount > 0;
    }
    case 'ra_pre': {
      const r = await client.query(
        `SELECT id FROM daily_safety_checks
         WHERE check_date=$1 AND check_type='opening' AND room='Pre-school'
         LIMIT 1`,
        [today]
      );
      return r.rowCount > 0;
    }
    case 'lunch':
    case 'tea': {
      const meal = task.id; // 'lunch' or 'tea'
      // Count present children
      const present = await client.query(
        `SELECT COUNT(*) AS cnt FROM attendance
         WHERE date=$1 AND COALESCE(absent, false)=false`,
        [today]
      );
      const presentCount = parseInt(present.rows[0].cnt, 10);
      if (presentCount === 0) return true; // nobody in = nothing to do

      // Count how many have had this meal logged today
      const logged = await client.query(
        `SELECT COUNT(DISTINCT child_id) AS cnt FROM diary_entries
         WHERE food_meal=$1
           AND date(occurred_at AT TIME ZONE 'Europe/London')=$2::date
           AND deleted_at IS NULL`,
        [meal, today]
      );
      const loggedCount = parseInt(logged.rows[0].cnt, 10);
      return loggedCount >= presentCount;
    }
  }
  return false;
}

router.get('/pending', async (req, res) => {
  try {
    const now = new Date();
    // Use UK local time for trigger comparison. Round-tripping through
    // toLocaleString('en-GB') -> new Date() is not spec-guaranteed: en-GB formats as
    // DD/MM/YYYY but Date parsing reads MM/DD/YYYY, so any day-of-month > 12 threw
    // "Invalid time value" (and days 1-12 silently swapped day/month) — bughunt 2026-07-21.
    // formatToParts reads the fields directly instead of round-tripping through a string.
    const _londonParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const nowHour = parseInt(_londonParts.hour, 10);
    const nowMin  = parseInt(_londonParts.minute, 10);
    const today   = `${_londonParts.year}-${_londonParts.month}-${_londonParts.day}`;

    const client = await getPool().connect();
    const pending = [];
    try {
      for (const task of SCHEDULE) {
        if (!await isDue(task, nowHour, nowMin)) continue;
        if (await isComplete(task, today, client)) continue;
        pending.push({ id: task.id, title: task.title, subtitle: task.subtitle, link: task.link, color: task.color });
      }
    } finally {
      client.release();
    }
    res.json({ pending, checkedAt: now.toISOString() });
  } catch (e) {
    console.error('[daily-tasks]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
