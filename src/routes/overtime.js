'use strict';
/* ===========================================================================
 * overtime.js — b309 (2026-09-10)
 *
 * Overtime: request → approve → pay OR time off in lieu.
 *
 * WHY IT EXISTS
 * ladn.hr_overtime has existed for months but only scripts/brighthr-importer.js
 * ever wrote to it — 10 rows, source='brighthr' — and only src/routes/insights.js
 * ever read it. There was no way to ASK for overtime and no way to approve it, so
 * every hour of extra cover at LADN was still being agreed in BrightHR
 * (wren-docs/research/reports/14-brighthr-parity.html, backlog item 5).
 *
 * SHAPE
 * Deliberately the same shape as src/routes/toil.js, which already does
 * request/approve/adjust properly: /my for the person, /all + /pending + /staff/:id
 * for the manager, and a POST that a manager uses to enter something directly.
 * Two things toil.js does not have, because they are what the parity report asked
 * for:
 *
 *   1. A REAL STATUS LIFECYCLE. toil.js has no status column at all (its own
 *      comment says so), so a TOIL request is inserted already-used. Overtime
 *      gets pending → approved/declined → paid, because a claim for money has to
 *      be refusable.
 *
 *   2. NOBODY APPROVES THEIR OWN. A manager can raise overtime for themselves —
 *      they work the extra hours like anyone else — but the approval has to come
 *      from a different person. That is enforced here and not merely in the UI.
 *
 * THE IMPORTED ROWS ARE NOT TOUCHED
 * The 10 BrightHR rows have status NULL (the migration deliberately added the
 * column with no default so existing rows were not backfilled). They are shown as
 * "imported" and are excluded from the approval queue: nobody should be asked to
 * approve, today, an hour somebody worked in 2024. Their `approved` boolean is
 * read but never written.
 * ===========================================================================*/

const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
const isManager = req => MANAGER_ROLES.includes(req.user && req.user.role);
const SETTLEMENTS = ['pay', 'toil'];

/**
 * The display status of a row. An imported BrightHR row has no Wren status; it
 * reports as 'imported' rather than being silently promoted into the queue.
 */
const STATUS_SQL = `
  CASE
    WHEN o.status IS NOT NULL THEN o.status
    WHEN COALESCE(o.source,'') = 'brighthr' THEN 'imported'
    WHEN o.approved IS TRUE THEN 'approved'
    ELSE 'imported'
  END`;

const SELECT_ROW = `
  SELECT o.id, o.staff_id, o.date::date AS date, o.hours, o.rate, o.reason,
         ${STATUS_SQL} AS status, o.settlement, o.settlement_preference,
         o.approved, o.paid, o.paid_at,
         o.requested_by, o.requested_at, o.approved_by, o.approved_at,
         o.decided_note, o.toil_entry_id, COALESCE(o.source,'wren') AS source,
         o.created_at,
         s.first_name || ' ' || s.last_name AS staff_name,
         a.first_name || ' ' || a.last_name AS approved_by_name
    FROM hr_overtime o
    JOIN staff s ON s.id = o.staff_id
    LEFT JOIN staff a ON a.id = o.approved_by`;

const num = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ── Staff: my overtime ──────────────────────────────────────────────────────
router.get('/my', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`${SELECT_ROW} WHERE o.staff_id=$1 ORDER BY o.date DESC NULLS LAST, o.id DESC LIMIT 200`,
      [req.user.id]);
    const sum = key => rows.filter(key).reduce((a, r) => a + (Number(r.hours) || 0), 0);
    res.json({
      entries: rows,
      totals: {
        pending_hours:  Math.round(sum(r => r.status === 'pending') * 100) / 100,
        approved_hours: Math.round(sum(r => r.status === 'approved') * 100) / 100,
        paid_hours:     Math.round(sum(r => r.paid === true) * 100) / 100,
        toil_hours:     Math.round(sum(r => r.status === 'approved' && r.settlement === 'toil') * 100) / 100,
      },
    });
  } catch (e) {
    console.error('[overtime/my]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /request — staff ask for overtime they have worked or are about to work.
// Body: { date, hours, reason, settlement_preference }
router.post('/request', async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const hours = num(b.hours);
  if (!isDate(b.date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
  if (!(hours > 0))    return res.status(400).json({ error: 'hours must be a positive number' });
  if (hours > 24)      return res.status(400).json({ error: 'hours must be 24 or fewer for a single day' });
  const pref = SETTLEMENTS.includes(b.settlement_preference) ? b.settlement_preference : null;
  try {
    // One claim per person per day. A second claim for the same day is almost
    // always a double-submit, and the alternative — silently paying twice — is
    // the expensive kind of bug.
    const { rows: dup } = await db.query(
      `SELECT id FROM hr_overtime WHERE staff_id=$1 AND date::date=$2::date AND status IN ('pending','approved')`,
      [req.user.id, b.date]);
    if (dup.length) {
      return res.status(409).json({ error: `You already have an overtime claim for ${b.date} (#${dup[0].id}).` });
    }
    // The preference goes in settlement_PREFERENCE. `settlement` stays NULL
    // until a manager decides, so an approval always represents a choice.
    const { rows } = await db.query(`
      INSERT INTO hr_overtime (staff_id, date, hours, reason, status, settlement_preference, requested_by, requested_at, source, updated_at)
      VALUES ($1, $2::date, $3, $4, 'pending', $5, $1, now(), 'wren', now())
      RETURNING id`,
      [req.user.id, b.date, hours, (b.reason || '').slice(0, 500) || null, pref]);

    const { rows: st } = await db.query('SELECT first_name, last_name FROM staff WHERE id=$1', [req.user.id]);
    const name = st[0] ? `${st[0].first_name} ${st[0].last_name}` : `Staff #${req.user.id}`;
    try {
      notify('overtime_requested', 'all-managers', null,
        `${name} claimed ${hours}h overtime`,
        `${b.date}${b.reason ? ' — ' + String(b.reason).slice(0, 160) : ''}${pref ? `. Asked for: ${pref === 'toil' ? 'time off in lieu' : 'payment'}.` : ''}`,
        { relatedTable: 'hr_overtime', relatedId: rows[0].id, link: '/admin/staff/overtime' });
    } catch (_) { /* a notification failure must not lose the claim */ }

    const { rows: full } = await db.query(`${SELECT_ROW} WHERE o.id=$1`, [rows[0].id]);
    res.status(201).json(full[0]);
  } catch (e) {
    console.error('[overtime/request]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /:id — withdraw your own claim while it is still pending.
router.delete('/:id', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const { rows } = await db.query('SELECT staff_id, status FROM hr_overtime WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];
    if (row.staff_id !== req.user.id && !isManager(req)) return res.status(403).json({ error: 'Forbidden' });
    if (row.status !== 'pending') {
      return res.status(409).json({ error: `Only a pending claim can be withdrawn (this one is ${row.status || 'imported'}).` });
    }
    await db.query(`UPDATE hr_overtime SET status='cancelled', updated_at=now() WHERE id=$1`, [id]);
    res.json({ ok: true, id, status: 'cancelled' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manager ─────────────────────────────────────────────────────────────────

// GET /pending — the approval queue. Wren claims only; imported rows never appear.
router.get('/pending', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { rows } = await getPool().query(
      `${SELECT_ROW} WHERE o.status='pending' ORDER BY o.date ASC NULLS LAST, o.id ASC`);
    res.json(rows.map(r => ({ ...r, self_request: r.staff_id === req.user.id })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /all?status=&from=&to=&staff_id=
router.get('/all', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const where = [], params = [];
  if (req.query.status)   { params.push(req.query.status);   where.push(`${STATUS_SQL} = $${params.length}`); }
  if (isDate(req.query.from)) { params.push(req.query.from); where.push(`o.date >= $${params.length}::date`); }
  if (isDate(req.query.to))   { params.push(req.query.to);   where.push(`o.date <= $${params.length}::date`); }
  if (req.query.staff_id) { params.push(parseInt(req.query.staff_id, 10)); where.push(`o.staff_id = $${params.length}`); }
  try {
    const { rows } = await getPool().query(
      `${SELECT_ROW} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY o.date DESC NULLS LAST, o.id DESC LIMIT 1000`, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /summary — per-staff totals for the current and previous month.
router.get('/summary', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { rows } = await getPool().query(`
      SELECT s.id, s.first_name || ' ' || s.last_name AS name, s.role,
             COALESCE(SUM(o.hours) FILTER (WHERE ${STATUS_SQL}='pending'), 0)  AS pending_hours,
             COALESCE(SUM(o.hours) FILTER (WHERE ${STATUS_SQL}='approved'), 0) AS approved_hours,
             COALESCE(SUM(o.hours) FILTER (WHERE ${STATUS_SQL}='approved' AND o.settlement='toil'), 0) AS toil_hours,
             COALESCE(SUM(o.hours) FILTER (WHERE ${STATUS_SQL}='approved' AND o.settlement='pay'), 0)  AS pay_hours,
             COALESCE(SUM(o.hours) FILTER (WHERE o.paid IS TRUE), 0) AS paid_hours,
             COALESCE(SUM(o.hours) FILTER (WHERE ${STATUS_SQL}='imported'), 0) AS imported_hours
        FROM staff s
        LEFT JOIN hr_overtime o ON o.staff_id = s.id
       WHERE s.is_active = true
       GROUP BY s.id, s.first_name, s.last_name, s.role
       ORDER BY s.first_name, s.last_name`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /staff/:staffId
router.get('/staff/:staffId', async (req, res) => {
  const staffId = parseInt(req.params.staffId, 10);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'staffId must be a number' });
  if (!isManager(req) && staffId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { rows } = await getPool().query(
      `${SELECT_ROW} WHERE o.staff_id=$1 ORDER BY o.date DESC NULLS LAST, o.id DESC LIMIT 500`, [staffId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST / — a manager records overtime directly for someone (already agreed).
// It still lands as PENDING unless the manager approves it in the same call, and
// it still cannot be self-approved.
router.post('/', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body || {};
  const staffId = parseInt(b.staff_id, 10);
  const hours = num(b.hours);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'staff_id required' });
  if (!isDate(b.date))            return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
  if (!(hours > 0))               return res.status(400).json({ error: 'hours must be a positive number' });
  const settlement = SETTLEMENTS.includes(b.settlement) ? b.settlement : null;
  // Approving in the same call needs BOTH: somebody else's claim, and a stated
  // settlement. Missing either leaves it pending and the response says which.
  const approveNow = b.approve === true && staffId !== req.user.id && !!settlement;
  try {
    const db = getPool();
    // If it is being approved here and now, the settlement is a DECISION. If it
    // is only being recorded, it is still just a suggestion for whoever decides.
    const { rows } = await db.query(`
      INSERT INTO hr_overtime (staff_id, date, hours, rate, reason, status, settlement, settlement_preference,
                               requested_by, requested_at, approved_by, approved_at, approved, source, updated_at)
      VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12,'wren',now())
      RETURNING id`,
      [staffId, b.date, hours, num(b.rate), (b.reason || '').slice(0, 500) || null,
       approveNow ? 'approved' : 'pending',
       approveNow ? settlement : null,
       approveNow ? null : settlement,
       req.user.id, approveNow ? req.user.id : null, approveNow ? new Date() : null,
       approveNow ? true : null]);
    if (approveNow && settlement === 'toil') await settleAsToil(db, rows[0].id, req.user.id);
    const { rows: full } = await db.query(`${SELECT_ROW} WHERE o.id=$1`, [rows[0].id]);
    const note = b.approve !== true ? undefined
      : staffId === req.user.id
        ? 'Recorded as pending: you cannot approve your own overtime, so another manager has to.'
        : !settlement
          ? "Recorded as pending: an approval has to say whether it is settled as 'pay' or 'toil'."
          : undefined;
    res.status(201).json({ ...full[0], note });
  } catch (e) {
    console.error('[overtime POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Settling as TOIL means the hours land in the TOIL bank the person can spend.
 * Written into ladn.toil_entries as an 'earned' row, which is exactly what
 * src/routes/toil.js already sums — so an approved overtime hour shows up in the
 * TOIL balance without a second ledger.
 */
async function settleAsToil(db, overtimeId, approverId) {
  const { rows } = await db.query(
    `SELECT staff_id, hours, date::date AS date, reason, toil_entry_id FROM hr_overtime WHERE id=$1`, [overtimeId]);
  const o = rows[0];
  if (!o || o.toil_entry_id) return null;
  const { rows: t } = await db.query(`
    INSERT INTO toil_entries (staff_id, type, hours, occurred_on, reason, approved_by)
    VALUES ($1, 'earned', $2, $3::date, $4, $5) RETURNING id`,
    [o.staff_id, o.hours, o.date, `Overtime #${overtimeId}${o.reason ? ' — ' + o.reason : ''}`.slice(0, 500), approverId]);
  await db.query('UPDATE hr_overtime SET toil_entry_id=$1, updated_at=now() WHERE id=$2', [t[0].id, overtimeId]);
  return t[0].id;
}

// POST /:id/approve — body { settlement: 'pay'|'toil', note? }
router.post('/:id/approve', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  const b = req.body || {};
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT o.id, o.staff_id, o.hours, o.date::date AS date, o.status, o.settlement,
              o.settlement_preference, o.source
         FROM hr_overtime o WHERE o.id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];

    // ── The rule the brief asks to be enforced ──────────────────────────────
    if (row.staff_id === req.user.id) {
      return res.status(403).json({
        error: 'You cannot approve your own overtime. Another manager has to approve this claim.',
        code: 'self_approval_blocked',
      });
    }
    if (row.status !== 'pending') {
      return res.status(409).json({ error: `Only a pending claim can be approved (this one is ${row.status || 'imported'}).` });
    }
    // The approver must SAY how it is being settled. The requester's preference
    // is deliberately NOT used as a fallback: an approval that quietly grants
    // whatever was asked for is not a decision, and the record would claim a
    // manager chose something they never saw.
    const settlement = SETTLEMENTS.includes(b.settlement) ? b.settlement : null;
    if (!settlement) {
      return res.status(400).json({
        error: "settlement must be 'pay' or 'toil' — an approval has to say how it is being settled.",
        requested_preference: row.settlement_preference || null,
      });
    }

    await db.query(`
      UPDATE hr_overtime
         SET status='approved', approved=true, settlement=$1, approved_by=$2, approved_at=now(),
             decided_note=$3, updated_at=now()
       WHERE id=$4`,
      [settlement, req.user.id, (b.note || '').slice(0, 500) || null, id]);

    let toilEntryId = null;
    if (settlement === 'toil') toilEntryId = await settleAsToil(db, id, req.user.id);

    try {
      notify('overtime_approved', String(row.staff_id), null,
        `Overtime approved — ${row.hours}h`,
        `Your ${row.hours}h overtime on ${row.date} has been approved and will be settled as ${settlement === 'toil' ? 'time off in lieu' : 'payment'}.`,
        { relatedTable: 'hr_overtime', relatedId: id });
    } catch (_) { /* non-fatal */ }

    const { rows: full } = await db.query(`${SELECT_ROW} WHERE o.id=$1`, [id]);
    res.json({ ...full[0], toil_entry_id: toilEntryId || full[0].toil_entry_id });
  } catch (e) {
    console.error('[overtime/approve]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/decline — body { note }
router.post('/:id/decline', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  const b = req.body || {};
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT staff_id, hours, date::date AS date, status FROM hr_overtime WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];
    // Declining your own claim is the same conflict of interest as approving it.
    if (row.staff_id === req.user.id) {
      return res.status(403).json({ error: 'You cannot decide your own overtime claim. Withdraw it instead, or ask another manager.', code: 'self_approval_blocked' });
    }
    if (row.status !== 'pending') {
      return res.status(409).json({ error: `Only a pending claim can be declined (this one is ${row.status || 'imported'}).` });
    }
    await db.query(`
      UPDATE hr_overtime SET status='declined', approved=false, approved_by=$1, approved_at=now(),
                             decided_note=$2, updated_at=now() WHERE id=$3`,
      [req.user.id, (b.note || '').slice(0, 500) || null, id]);
    try {
      notify('overtime_declined', String(row.staff_id), null,
        `Overtime claim declined — ${row.hours}h`,
        `Your ${row.hours}h overtime claim for ${row.date} was declined.${b.note ? ' ' + String(b.note).slice(0, 200) : ''}`,
        { relatedTable: 'hr_overtime', relatedId: id });
    } catch (_) { /* non-fatal */ }
    const { rows: full } = await db.query(`${SELECT_ROW} WHERE o.id=$1`, [id]);
    res.json(full[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/paid — mark an approved, pay-settled claim as having reached payroll.
router.post('/:id/paid', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT status, settlement, paid FROM hr_overtime WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].status !== 'approved') return res.status(409).json({ error: 'Only an approved claim can be marked paid.' });
    if (rows[0].settlement !== 'pay')  return res.status(409).json({ error: 'This claim was settled as time off in lieu, not payment.' });
    await db.query('UPDATE hr_overtime SET paid=true, paid_at=now(), updated_at=now() WHERE id=$1', [id]);
    const { rows: full } = await db.query(`${SELECT_ROW} WHERE o.id=$1`, [id]);
    res.json(full[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
