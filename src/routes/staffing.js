'use strict';
/**
 * staffing.js — weekly staffing-requirement API (2026-08-03).
 * Mounted at /api/staffing (manager-gated). Thin wrapper over
 * src/services/staffing-weeks.weeklyStaffing — see that file for the maths.
 *
 *   GET /api/staffing/weeks?from=YYYY-MM-DD&to=YYYY-MM-DD&room=<id>
 *     → per-ISO-week, per-room { booked, required (configured ratios),
 *       on_rota, variance }. Defaults to the last completed academic year.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { weeklyStaffing, defaultAcademicRange } = require('../services/staffing-weeks');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/staffing/weeks
router.get('/weeks', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const def = defaultAcademicRange();
    const from = ISO.test(String(req.query.from || '')) ? req.query.from : def.from;
    const to   = ISO.test(String(req.query.to   || '')) ? req.query.to   : def.to;
    if (from > to) return res.status(400).json({ error: 'from must be on or before to' });

    let weeks = await weeklyStaffing(db, from, to);

    // Optional room filter
    const roomId = parseInt(req.query.room, 10);
    if (Number.isInteger(roomId)) weeks = weeks.filter(w => w.room_id === roomId);

    // Headline summary: peak booked week, and count of under-ratio (variance<0) weeks
    // — but on_rota is only meaningful where a rota exists, so under-ratio counts only
    // weeks that actually have staff on the rota (on_rota>0) to avoid false alarms.
    let peak = null;
    const underRatio = [];
    for (const w of weeks) {
      if (!peak || w.required > peak.required) peak = w;
      if (w.on_rota > 0 && w.variance < 0) underRatio.push(w);
    }
    const ratios = weeks[0]?.ratios || null;

    res.json({
      from, to,
      ratios,
      count: weeks.length,
      weeks,
      summary: {
        peak_week: peak ? { week_start: peak.week_start, room_name: peak.room_name, required: peak.required, booked: peak.booked } : null,
        under_ratio_weeks: underRatio.length,
      },
    });
  } catch (err) {
    console.error('staffing /weeks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
