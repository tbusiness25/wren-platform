'use strict';
// BrightHR-style named, reusable Working Time Patterns (2026-06-17).
// A pattern = name + per-day (Mon..Sun) start/end/break + public-holiday handling.
// Assigning a pattern to a staff member SYNCS its days into staff_work_patterns
// (effective-dated), which the existing rota auto-generate engine already consumes —
// so the engine is unchanged. Manager-only. Additive; never drops production data.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);
const MANAGER_ROLES = ['manager', 'deputy_manager'];
const managerOnly = (req, res, next) =>
  MANAGER_ROLES.includes(req.user.role) ? next() : res.status(403).json({ error: 'Manager access required' });

// Numeric :id guard (Express 5 / path-to-regexp v8 drops inline :id(\d+) regex).
router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'Not found' });
  next();
});

// Pattern + its day rows, shaped for the editor.
async function patternWithDays(db, id) {
  const { rows: p } = await db.query('SELECT * FROM work_patterns WHERE id=$1', [id]);
  if (!p.length) return null;
  const { rows: days } = await db.query(
    'SELECT day_of_week, shift_start, shift_end, is_off, break_minutes, room FROM work_pattern_days WHERE work_pattern_id=$1 ORDER BY day_of_week', [id]);
  return { ...p[0], days };
}

// GET /api/work-patterns — list (with days) for the editor + copy-existing dropdown.
router.get('/', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT id FROM work_patterns ORDER BY is_default DESC, name');
    const out = [];
    for (const r of rows) out.push(await patternWithDays(db, r.id));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const p = await patternWithDays(db, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Replace the day rows for a pattern (used by create + update).
async function writeDays(db, patternId, days) {
  await db.query('DELETE FROM work_pattern_days WHERE work_pattern_id=$1', [patternId]);
  for (const d of (days || [])) {
    const dow = parseInt(d.day_of_week, 10);
    if (!(dow >= 0 && dow <= 6)) continue;
    await db.query(
      `INSERT INTO work_pattern_days (work_pattern_id, day_of_week, shift_start, shift_end, is_off, break_minutes, room)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [patternId, dow,
       d.is_off ? null : (d.shift_start || null),
       d.is_off ? null : (d.shift_end || null),
       !!d.is_off,
       parseInt(d.break_minutes, 10) || 0,
       d.room || null]);
  }
}

// POST /api/work-patterns — create. Body: {name, is_default, pattern_start_date, public_holiday_handling, days[]}.
// ?copy_from=<id> seeds days from an existing pattern when none supplied.
router.post('/', managerOnly, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (b.is_default) await client.query('UPDATE work_patterns SET is_default=false WHERE is_default=true');
    const { rows } = await client.query(
      `INSERT INTO work_patterns (name, is_default, pattern_start_date, public_holiday_handling)
       VALUES ($1,$2,$3,COALESCE($4,'not_deducted')) RETURNING id`,
      [b.name, !!b.is_default, b.pattern_start_date || null, b.public_holiday_handling || null]);
    const id = rows[0].id;
    let days = b.days;
    if ((!days || !days.length) && req.query.copy_from) {
      const src = await patternWithDays(client, req.query.copy_from);
      days = src ? src.days : [];
    }
    await writeDays(client, id, days);
    await client.query('COMMIT');
    res.status(201).json(await patternWithDays(db, id));
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// PUT /api/work-patterns/:id — update pattern meta + days.
router.put('/:id', managerOnly, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (b.is_default) await client.query('UPDATE work_patterns SET is_default=false WHERE is_default=true AND id<>$1', [req.params.id]);
    await client.query(
      `UPDATE work_patterns SET name=COALESCE($2,name), is_default=COALESCE($3,is_default),
         pattern_start_date=COALESCE($4,pattern_start_date),
         public_holiday_handling=COALESCE($5,public_holiday_handling), updated_at=now() WHERE id=$1`,
      [req.params.id, b.name ?? null, (typeof b.is_default === 'boolean' ? b.is_default : null),
       b.pattern_start_date ?? null, b.public_holiday_handling ?? null]);
    if (Array.isArray(b.days)) await writeDays(client, req.params.id, b.days);
    await client.query('COMMIT');
    res.json(await patternWithDays(db, req.params.id));
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

router.delete('/:id', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    await db.query('UPDATE staff SET work_pattern_id=NULL WHERE work_pattern_id=$1', [req.params.id]);
    await db.query('DELETE FROM work_patterns WHERE id=$1', [req.params.id]); // cascades to days
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/work-patterns/:id/assign  { staff_id }
// Links the pattern to the staff member AND syncs its days into staff_work_patterns
// (effective-dated) so the existing /api/rota/auto-generate consumes them unchanged.
router.post('/:id/assign', managerOnly, async (req, res) => {
  const db = getPool();
  const staffId = parseInt((req.body || {}).staff_id, 10);
  if (!staffId) return res.status(400).json({ error: 'staff_id required' });
  const client = await db.connect();
  try {
    const pat = await patternWithDays(client, req.params.id);
    if (!pat) return res.status(404).json({ error: 'Pattern not found' });
    const eff = pat.pattern_start_date ? new Date(pat.pattern_start_date).toISOString().slice(0, 10)
                                       : new Date().toISOString().slice(0, 10);
    await client.query('BEGIN');
    await client.query('UPDATE staff SET work_pattern_id=$1 WHERE id=$2', [req.params.id, staffId]);
    // Close any prior open pattern rows so the engine doesn't see two patterns per day.
    await client.query(
      `UPDATE staff_work_patterns SET effective_to=$2::date - 1
       WHERE staff_id=$1 AND effective_to IS NULL AND effective_from < $2::date`, [staffId, eff]);
    // Upsert the pattern's days as the staff member's active pattern.
    for (const d of pat.days) {
      await client.query(
        `INSERT INTO staff_work_patterns
           (staff_id, day_of_week, shift_start, shift_end, is_off, lunch_break_minutes, room, effective_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (staff_id, day_of_week, effective_from)
         DO UPDATE SET shift_start=EXCLUDED.shift_start, shift_end=EXCLUDED.shift_end,
           is_off=EXCLUDED.is_off, lunch_break_minutes=EXCLUDED.lunch_break_minutes,
           room=EXCLUDED.room, effective_to=NULL, updated_at=now()`,
        [staffId, d.day_of_week, d.shift_start, d.shift_end, d.is_off, d.break_minutes || 0, d.room, eff]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, staff_id: staffId, pattern_id: Number(req.params.id), effective_from: eff, days: pat.days.length });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

module.exports = router;
