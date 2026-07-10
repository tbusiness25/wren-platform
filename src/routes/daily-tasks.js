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
  { id: 'lunch',    title: 'Lunch diary', subtitle: 'Add lunch for all children on register', link: '/ey/diary?meal=lunch',  color: 'amber',  triggerHour: 11, triggerMin: 45 },
  { id: 'tea',      title: 'Tea diary',   subtitle: 'Add tea for all children on register',   link: '/ey/diary?meal=tea',    color: 'orange', triggerHour: 15, triggerMin: 45 },
];

async function isDue(task, nowHour, nowMin) {
  return nowHour > task.triggerHour || (nowHour === task.triggerHour && nowMin >= task.triggerMin);
}

async function isComplete(task, today, client) {
  switch (task.id) {
    case 'ra_baby': {
      const r = await client.query(
        `SELECT id FROM risk_assessments
         WHERE assessment_date=$1
           AND (location ILIKE '%baby%' OR location ILIKE '%baby room%')
           AND (status IS NULL OR status <> 'draft')
         LIMIT 1`,
        [today]
      );
      return r.rowCount > 0;
    }
    case 'ra_pre': {
      const r = await client.query(
        `SELECT id FROM risk_assessments
         WHERE assessment_date=$1
           AND (location ILIKE '%pre%school%' OR location ILIKE '%pre-school%' OR location ILIKE '%preschool%')
           AND (status IS NULL OR status <> 'draft')
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
    // Use UK local time for trigger comparison
    const londonTime = new Date(now.toLocaleString('en-GB', { timeZone: 'Europe/London' }));
    const nowHour = londonTime.getHours();
    const nowMin  = londonTime.getMinutes();
    const today   = londonTime.toISOString().slice(0, 10);

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
