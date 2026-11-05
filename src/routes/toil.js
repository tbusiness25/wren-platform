const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];

// TOIL balances read from TWO tables: toil_entries (live, manager-entered) and
// hr_toil_entries (1,845 rows imported from BrightHR). hr_toil_entries has no
// 'type' column — open rows (used_date IS NULL) are accrued/earned and still in
// the balance; settled rows (used_date set, e.g. "paid Sept pay period") are
// treated as used. Cancelled rows are excluded. Writes still go ONLY to
// toil_entries; this union is read-only. (Assumption flagged to Toby: settled =
// paid out. If BrightHR semantics differ this is a one-line change.)
//
// M6c (b488, 2026-10-12): the BrightHR import has been frozen since 2026-06-08
// (nothing newer has ever synced in) — it still needs to stay VISIBLE (hence
// its own 'brighthr-historical' source tag, unchanged here) so a manager can
// see where an old balance came from, but it should stop being added into the
// LIVE balance every time, which was silently treating a frozen snapshot as
// current. Each balance SUM below now excludes 'brighthr-historical' rows
// unless the setting toil_include_brighthr_historical='true' says to fold
// them back in; callers that just list entries (not a balance) are unaffected.
const TOIL_LEDGER = `(
  SELECT id, staff_id, type, hours, occurred_on, reason, approved_by, created_at, 'manual'::text AS source
    FROM toil_entries
  UNION ALL
  SELECT id, staff_id,
         CASE WHEN used_date IS NULL THEN 'earned' ELSE 'used' END AS type,
         hours,
         COALESCE(used_date, accrued_date)::date AS occurred_on,
         reason, NULL::int AS approved_by, created_at, 'brighthr-historical'::text AS source
    FROM hr_toil_entries
   WHERE status <> 'Cancelled'
)`;
async function includeHistoricalToil(db) {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key='toil_include_brighthr_historical'");
    return rows.length > 0 && rows[0].value === 'true';
  } catch (_) { return false; } // settings unavailable — fail safe: historical stays excluded
}
// The balance CASE needs "this type AND (not frozen-historical, unless the
// setting says include it)" on both the earn and spend side.
const BALANCE_SQL = (alias, includeHistorical) => `
  COALESCE(SUM(CASE WHEN ${alias}.type IN ('earned','adjustment') AND (${alias}.source <> 'brighthr-historical' OR ${includeHistorical}) THEN ${alias}.hours ELSE 0 END), 0) -
  COALESCE(SUM(CASE WHEN ${alias}.type = 'used' AND (${alias}.source <> 'brighthr-historical' OR ${includeHistorical}) THEN ${alias}.hours ELSE 0 END), 0)`;

// My TOIL balance + entries
router.get('/my', async (req, res) => {
  const db = getPool();
  try {
    const includeHistorical = await includeHistoricalToil(db);
    const { rows } = await db.query(`
      SELECT
        ${BALANCE_SQL('t', includeHistorical)} AS balance,
        COALESCE(json_agg(
          json_build_object('id',id,'type',type,'hours',hours,'occurred_on',occurred_on,
            'reason',reason,'created_at',created_at,'source',source)
          ORDER BY occurred_on DESC
        ) FILTER (WHERE id IS NOT NULL), '[]') AS entries
      FROM ${TOIL_LEDGER} t
      WHERE staff_id = $1`, [req.user.id]);
    res.json({ balance: parseFloat(rows[0].balance) || 0, entries: rows[0].entries });
  } catch (err) {
    console.error('toil /my', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Request to use TOIL (staff self-serve)
router.post('/request', async (req, res) => {
  const db = getPool();
  const { hours, occurred_on, reason } = req.body;
  if (!hours || !occurred_on) return res.status(400).json({ error: 'hours and occurred_on required' });
  if (!(hours > 0)) return res.status(400).json({ error: 'hours must be a positive number' });
  try {
    // Balance check (bughunt 2026-07-21): this used to insert unconditionally, letting
    // a request drive the balance arbitrarily negative with zero oversight. No status
    // column exists yet for a full pending/approval lifecycle (schema change — out of
    // scope for this pass), so this is the balance guard + manager notification called
    // out as the minimum fix.
    const includeHistorical = await includeHistoricalToil(db);
    const { rows: balRows } = await db.query(`
      SELECT ${BALANCE_SQL('t', includeHistorical)} AS balance
      FROM ${TOIL_LEDGER} t WHERE staff_id = $1`, [req.user.id]);
    const balance = parseFloat(balRows[0].balance) || 0;
    if (parseFloat(hours) > balance) {
      return res.status(400).json({ error: `Insufficient TOIL balance (${balance}h available, ${hours}h requested)` });
    }
    const { rows } = await db.query(`
      INSERT INTO toil_entries (staff_id, type, hours, occurred_on, reason)
      VALUES ($1, 'used', $2, $3, $4) RETURNING *`,
      [req.user.id, hours, occurred_on, reason]);

    const { rows: st } = await db.query('SELECT first_name, last_name FROM staff WHERE id=$1', [req.user.id]);
    const name = st[0] ? `${st[0].first_name} ${st[0].last_name}` : `Staff #${req.user.id}`;
    notify('toil_used', 'all-managers', null,
      `${name} used ${hours}h TOIL`,
      `${occurred_on}${reason ? ' — ' + reason : ''}. New balance: ${(balance - parseFloat(hours)).toFixed(2)}h.`,
      { relatedTable: 'toil_entries', relatedId: rows[0].id }
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: summary for all active staff
router.get('/all', async (req, res) => {
  if (!hasRole(req.user, MANAGER_ROLES)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  try {
    const includeHistorical = await includeHistoricalToil(db);
    const { rows } = await db.query(`
      SELECT s.id, s.first_name || ' ' || s.last_name AS name, s.role,
        ${BALANCE_SQL('t', includeHistorical)} AS balance
      FROM staff s
      LEFT JOIN ${TOIL_LEDGER} t ON t.staff_id = s.id
      WHERE s.is_active = true
      GROUP BY s.id, s.first_name, s.last_name, s.role
      ORDER BY s.first_name, s.last_name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: entries for a specific staff member
router.get('/staff/:staffId', async (req, res) => {
  if (!hasRole(req.user, MANAGER_ROLES)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT t.*, s.first_name || ' ' || s.last_name AS approved_by_name
      FROM ${TOIL_LEDGER} t
      LEFT JOIN staff s ON s.id = t.approved_by
      WHERE t.staff_id = $1
      ORDER BY t.occurred_on DESC`, [req.params.staffId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: add/adjust TOIL entry for any staff member
router.post('/', async (req, res) => {
  if (!hasRole(req.user, MANAGER_ROLES)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  const { staff_id, type, hours, occurred_on, reason } = req.body;
  if (!staff_id || !type || !hours || !occurred_on) {
    return res.status(400).json({ error: 'staff_id, type, hours, occurred_on required' });
  }
  try {
    const { rows } = await db.query(`
      INSERT INTO toil_entries (staff_id, type, hours, occurred_on, reason, approved_by)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [staff_id, type, hours, occurred_on, reason, req.user.id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: update an entry
router.patch('/:id', async (req, res) => {
  if (!hasRole(req.user, MANAGER_ROLES)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  const { hours, reason, type } = req.body;
  try {
    const { rows } = await db.query(`
      UPDATE toil_entries
      SET hours = COALESCE($1, hours),
          reason = COALESCE($2, reason),
          type = COALESCE($3, type)
      WHERE id = $4 RETURNING *`,
      [hours, reason, type, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: delete an entry
router.delete('/:id', async (req, res) => {
  if (!hasRole(req.user, MANAGER_ROLES)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  try {
    await db.query('DELETE FROM toil_entries WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
