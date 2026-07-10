const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// Writes are manager/deputy only (matches the "managers set the bookings" spec).
const isManager = r => ['manager', 'deputy_manager', 'admin', 'headteacher'].includes(r);
function requireManager(req, res) {
  if (!isManager(req.user && req.user.role)) {
    res.status(403).json({ error: 'Manager or deputy only' });
    return false;
  }
  return true;
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

/**
 * Compute the auto end-date: the 31 August immediately BEFORE the child's 5th
 * birthday (UK school-leaving / reception-entry cutoff). Verified against both
 * autumn- and summer-born children:
 *   born 2021-10-10 → 5th bday 2026-10-10 → end 2026-08-31 (leaves nursery to
 *                     start reception Sep 2026, the Sept after their 4th bday)
 *   born 2021-05-26 → 5th bday 2026-05-26 → end 2025-08-31 (reception Sep 2025)
 * String maths only (no Date object) to sidestep the BST off-by-one that has
 * bitten date arithmetic here before.
 * @param {string} dobStr 'YYYY-MM-DD'
 * @returns {string|null} 'YYYY-MM-DD' or null if dob unparseable
 */
function computeEndDate(dobStr) {
  if (!dobStr) return null;
  // Accept either 'YYYY-MM-DD' or a JS Date (node-pg returns DATE as Date).
  let s = dobStr;
  if (dobStr instanceof Date) {
    s = `${dobStr.getUTCFullYear()}-${String(dobStr.getUTCMonth() + 1).padStart(2, '0')}-${String(dobStr.getUTCDate()).padStart(2, '0')}`;
  }
  const m = String(s).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  // 5th birthday falls in year+5. If it's on/after 1 Sep, the 31 Aug BEFORE it
  // is 31 Aug (year+5). Otherwise it's 31 Aug (year+4).
  const endYear = (month >= 9) ? (year + 5) : (year + 4);
  return `${endYear}-08-31`;
}

// GET /api/bookings/child/:childId — active patterns for a child
router.get('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT b.*, r.name AS room_name
      FROM child_bookings b
      LEFT JOIN rooms r ON r.id = b.room_id
      WHERE b.child_id = $1 AND b.is_active = true
      ORDER BY b.start_date DESC, b.id DESC
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bookings — create a pattern
router.post('/', async (req, res) => {
  if (!requireManager(req, res)) return;
  const b = req.body || {};
  const childId = parseInt(b.child_id, 10);
  if (!childId) return res.status(400).json({ error: 'child_id required' });
  if (!b.start_date) return res.status(400).json({ error: 'start_date required' });
  const days = {};
  let anyDay = false;
  for (const d of WEEKDAYS) { days[d] = !!b[d]; if (days[d]) anyDay = true; }
  if (!anyDay) return res.status(400).json({ error: 'At least one weekday must be ticked' });

  try {
    const db = getPool();
    // Validate child exists + get dob for the auto end-date. Format dob as text
    // in SQL — node-pg returns DATE columns as JS Date objects, which computeEndDate
    // (a string parser) would reject.
    const { rows: crows } = await db.query(
      "SELECT id, to_char(date_of_birth,'YYYY-MM-DD') AS dob, room_id FROM children WHERE id=$1", [childId]
    );
    if (!crows.length) return res.status(404).json({ error: 'Child not found' });
    const child = crows[0];

    let endDate = b.end_date || null;
    if (!endDate && child.dob) {
      endDate = computeEndDate(child.dob);
    }
    // Fall back to the child's current room if none specified on the booking
    const roomId = (b.room_id != null && b.room_id !== '') ? parseInt(b.room_id, 10) : (child.room_id || null);

    const { rows } = await db.query(`
      INSERT INTO child_bookings
        (child_id, room_id, mon, tue, wed, thu, fri, start_date, end_date, funded, notes, source, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual',$12)
      RETURNING *
    `, [childId, roomId, days.mon, days.tue, days.wed, days.thu, days.fri,
        b.start_date, endDate, !!b.funded, b.notes || null, req.user.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/bookings/:id — update a pattern
router.put('/:id', async (req, res) => {
  if (!requireManager(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;
  const push = (col, val) => { sets.push(`${col}=$${i++}`); vals.push(val); };

  for (const d of WEEKDAYS) if (d in b) push(d, !!b[d]);
  if ('room_id' in b) push('room_id', (b.room_id === '' || b.room_id == null) ? null : parseInt(b.room_id, 10));
  if ('start_date' in b) push('start_date', b.start_date);
  if ('end_date' in b) push('end_date', b.end_date || null);
  if ('funded' in b) push('funded', !!b.funded);
  if ('notes' in b) push('notes', b.notes || null);
  if ('is_active' in b) push('is_active', !!b.is_active);

  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(id);

  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE child_bookings SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/bookings/:id — soft-delete (is_active=false)
router.delete('/:id', async (req, res) => {
  if (!requireManager(req, res)) return;
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE child_bookings SET is_active=false WHERE id=$1 RETURNING id',
      [parseInt(req.params.id, 10)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bookings/expected?date=YYYY-MM-DD — children expected that day.
// (active pattern covering the date, with the weekday bit set). Drives the
// register seed + occupancy. Defaults to today.
router.get('/expected', async (req, res) => {
  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
    ? req.query.date
    : new Date().toISOString().slice(0, 10);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT DISTINCT ON (c.id)
             c.id, c.first_name, c.last_name, c.room_id AS child_room_id,
             COALESCE(b.room_id, c.room_id) AS room_id,
             r.name AS room_name, b.funded, b.id AS booking_id
      FROM child_bookings b
      JOIN children c ON c.id = b.child_id
      LEFT JOIN rooms r ON r.id = COALESCE(b.room_id, c.room_id)
      WHERE b.is_active = true
        AND COALESCE(c.is_active, true) = true
        AND $1::date BETWEEN b.start_date AND COALESCE(b.end_date, DATE '2100-01-01')
        AND CASE EXTRACT(DOW FROM $1::date)::int
              WHEN 1 THEN b.mon WHEN 2 THEN b.tue WHEN 3 THEN b.wed
              WHEN 4 THEN b.thu WHEN 5 THEN b.fri ELSE false END
      ORDER BY c.id, b.start_date DESC
    `, [date]);
    res.json({ date, count: rows.length, children: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.computeEndDate = computeEndDate;
