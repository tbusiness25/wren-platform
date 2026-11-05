// Fair Leave — per-employee weight preferences (b106, 2026-07-20).
// Points model (b135, 2026-07-22): staff spend a 10-point budget across the 4
// factors (booking order, turn-taking, spread, notice), 1–5 points each, must
// total exactly 10. weight = points/10. Length-of-service is gone (see
// leave-weights-core.js). Anti-gaming guards, unchanged from b106:
//   • changeable at most once per calendar year (409 until 1 Jan);
//   • preview/what-if allowed anytime without saving.
//
// Manager-only endpoints (GET /all, PUT /config) let Roost list everyone's
// chosen build (transparency) and flip the master enable toggle.
'use strict';
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getPool } = require('../db/pool');
const C = require('../services/leave-weights-core');

router.use(authenticate);
// headteacher is already normalised to 'manager' by the auth middleware; admin
// is a Roost role. Keep in step with absence-fairness.js's manager gate.
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher'];
const isManager = (req) => MANAGER_ROLES.includes(String(req.user.role || '').toLowerCase());
const currentYear = () => new Date().getFullYear();

// ── GET /config ── everyone: defaults, presets, whether the feature is on ────
router.get('/config', async (req, res) => {
  const db = getPool();
  try {
    const mgr = await C.getManagerWeights(db);
    res.json({
      enabled: await C.getEnabled(db),
      default_points: C.DEFAULT_POINTS,
      default_weights: mgr,
      presets: C.PRESETS,
      factor_keys: C.FACTOR_KEYS,
      factor_labels: C.FACTOR_LABELS,
      factor_explain: C.FACTOR_EXPLAIN,
      points_total: C.POINTS_TOTAL, point_min: C.POINT_MIN, point_max: C.POINT_MAX,
      year: currentYear(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /config ── manager only: master enable/disable toggle ─────────────────
router.put('/config', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  const enabled = !(req.body && (req.body.enabled === false || req.body.enabled === 'false'));
  try {
    await C.setEnabled(getPool(), enabled, req.user.id);
    res.json({ ok: true, enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /mine ── caller's own saved build + lock state ────────────────────────
router.get('/mine', async (req, res) => {
  const db = getPool();
  try {
    const mgr = await C.getManagerWeights(db);
    const row = await C.getPersonalRow(db, req.user.id);
    const yr = currentYear();
    const locked = !!(row && row.year >= yr);
    res.json({
      enabled: await C.getEnabled(db),
      default_points: C.DEFAULT_POINTS,
      default_weights: mgr,
      presets: C.PRESETS,
      factor_keys: C.FACTOR_KEYS,
      factor_labels: C.FACTOR_LABELS,
      factor_explain: C.FACTOR_EXPLAIN,
      points_total: C.POINTS_TOTAL, point_min: C.POINT_MIN, point_max: C.POINT_MAX,
      year: yr,
      has_prefs: !!row,
      points: row ? row.points : null,                       // whole-number spend on the stat allocator
      normalised: row ? C.pointsToWeights(row.points) : null, // what actually gets used
      matched_preset: row ? C.matchPreset(row.points) : 'standard',
      set_at: row ? row.set_at : null,
      set_year: row ? row.year : null,
      locked,
      locked_until: locked ? (yr + 1) + '-01-01' : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /preview ── validate + worked example (NO save, anytime) ────────────
router.post('/preview', async (req, res) => {
  const db = getPool();
  try {
    const mgr = await C.getManagerWeights(db);
    const points = req.body && req.body.points;
    const check = C.validatePoints(points);
    if (!check.ok) {
      return res.status(422).json({
        error: 'invalid_points', message: 'Points must total exactly 10, with 1-5 on each factor.',
        violations: check.violations, points_total: C.POINTS_TOTAL, point_min: C.POINT_MIN, point_max: C.POINT_MAX,
      });
    }
    const weights = C.pointsToWeights(points);
    res.json({
      ok: true,
      points,
      weights,
      matched_preset: C.matchPreset(points),
      worked_example: C.rankWorkedExample(weights),
      worked_example_default: C.rankWorkedExample(mgr),
      note: 'Preview only — nothing saved. This shows where you would land against three example colleagues under your build versus the standard weights.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /mine ── save caller's build (422 invalid, once-per-year 409) ────────
router.put('/mine', async (req, res) => {
  const db = getPool();
  try {
    const mgr = await C.getManagerWeights(db);
    const points = req.body && req.body.points;

    // 1) points budget — client + server enforce identically
    const check = C.validatePoints(points);
    if (!check.ok) {
      return res.status(422).json({
        error: 'invalid_points', message: 'Points must total exactly 10, with 1-5 on each factor.',
        violations: check.violations, points_total: C.POINTS_TOTAL, point_min: C.POINT_MIN, point_max: C.POINT_MAX,
      });
    }

    // 2) once-per-calendar-year lock
    await C.ensureTable(db);
    const existing = await C.getPersonalRow(db, req.user.id);
    const yr = currentYear();
    if (existing && existing.year >= yr) {
      return res.status(409).json({
        error: 'locked_this_year',
        message: `You've already set your leave weights for ${yr}. They can be changed again from 1 January ${yr + 1}.`,
        locked_until: (yr + 1) + '-01-01',
        current: { points: existing.points, normalised: C.pointsToWeights(existing.points), set_at: existing.set_at, set_year: existing.year },
      });
    }

    // 3) store the validated points allocation (normalised to weights on read/use)
    await db.query(
      `INSERT INTO leave_weight_prefs (staff_id, weights, set_at, year)
         VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (staff_id) DO UPDATE SET weights=$2::jsonb, set_at=now(), year=$3`,
      [req.user.id, JSON.stringify(points), yr]);

    res.json({
      ok: true,
      points,
      normalised: C.pointsToWeights(points),
      matched_preset: C.matchPreset(points),
      year: yr,
      locked_until: (yr + 1) + '-01-01',
      message: `Saved. Your leave weights for ${yr} are locked in — you can change them again from 1 January ${yr + 1}.`,
    });
  } catch (e) {
    console.error('[leave-weights] PUT /mine', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /all ── manager only: everyone's chosen build (read-only, Roost) ─────
router.get('/all', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  const db = getPool();
  try {
    const mgr = await C.getManagerWeights(db);
    await C.ensureTable(db);
    const { rows } = await db.query(
      `SELECT p.staff_id, p.weights, p.set_at, p.year,
              s.first_name || ' ' || s.last_name AS name, s.role
         FROM leave_weight_prefs p
         JOIN staff s ON s.id = p.staff_id
        ORDER BY name`);
    const yr = currentYear();
    const people = rows.map(r => {
      const points = typeof r.weights === 'string' ? JSON.parse(r.weights) : r.weights;
      return {
        staff_id: r.staff_id, name: r.name, role: r.role,
        points, normalised: C.pointsToWeights(points),
        matched_preset: C.matchPreset(points),
        set_at: r.set_at, year: r.year,
        locked: r.year >= yr,
      };
    });
    res.json({
      enabled: await C.getEnabled(db),
      default_points: C.DEFAULT_POINTS,
      default_weights: mgr,
      factor_keys: C.FACTOR_KEYS,
      factor_labels: C.FACTOR_LABELS,
      count: people.length,
      people,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
