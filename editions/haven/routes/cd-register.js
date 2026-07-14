'use strict';
// Haven — controlled drugs register (stock in/out log with two signatures).
// This is a stock REGISTER, not eMAR: medication administration stays on paper MAR.
// Balance is computed server-side per (drug_name, form_strength, resident) ledger.
const express = require('express');
const router = express.Router();
const { getPool } = require('../../../src/db/pool');
const authenticate = require('../../../src/middleware/auth');
const { requirePerm, fail } = require('../lib/permissions');
const { recordAudit } = require('../../../src/utils/audit');
const bcrypt = require('bcryptjs');

router.use(authenticate);

// GET / — ledger entries (?resident_id=&drug_name=)
router.get('/', async (req, res) => {
  try {
    const params = [];
    const where = ['1=1'];
    if (req.query.resident_id) { params.push(req.query.resident_id); where.push(`cd.resident_id = $${params.length}`); }
    if (req.query.drug_name) { params.push(`%${req.query.drug_name}%`); where.push(`cd.drug_name ILIKE $${params.length}`); }
    const { rows } = await getPool().query(`
      SELECT cd.*, r.first_name, r.last_name,
             w1.first_name AS witness_1_first, w1.last_name AS witness_1_last,
             w2.first_name AS witness_2_first, w2.last_name AS witness_2_last
      FROM controlled_drugs_register cd
      LEFT JOIN residents r ON r.id = cd.resident_id
      LEFT JOIN staff w1 ON w1.id = cd.witness_1
      LEFT JOIN staff w2 ON w2.id = cd.witness_2
      WHERE ${where.join(' AND ')}
      ORDER BY cd.entry_at DESC, cd.id DESC LIMIT 300`, params);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// GET /balances — current balance per drug/resident ledger
router.get('/balances', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT DISTINCT ON (cd.drug_name, cd.form_strength, cd.resident_id)
             cd.drug_name, cd.form_strength, cd.resident_id, cd.balance, cd.entry_at,
             r.first_name, r.last_name
      FROM controlled_drugs_register cd
      LEFT JOIN residents r ON r.id = cd.resident_id
      ORDER BY cd.drug_name, cd.form_strength, cd.resident_id, cd.entry_at DESC, cd.id DESC`);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// POST / — append a ledger entry. Two DIFFERENT staff signatures required.
// Body: { resident_id, drug_name, form_strength, entry_type, qty_in, qty_out,
//         witness_2_id, witness_2_pin, ... }
// witness_1 is the logged-in user (their JWT is signature 1). witness_2 must
// COUNTERSIGN by entering their own PIN, verified server-side against
// staff.pin_hash. Selecting a name is not a signature.
router.post('/', requirePerm('clinical_write'), async (req, res) => {
  const db = getPool();
  const client = await db.connect();
  try {
    const b = req.body || {};
    if (!b.drug_name || !b.entry_type) {
      return res.status(400).json({ error: 'drug_name, entry_type required' });
    }
    const qtyIn = Number(b.qty_in || 0);
    const qtyOut = Number(b.qty_out || 0);
    if (qtyIn < 0 || qtyOut < 0 || Number.isNaN(qtyIn) || Number.isNaN(qtyOut)) {
      return res.status(400).json({ error: 'qty_in/qty_out must be non-negative numbers' });
    }
    const witness2 = parseInt(b.witness_2_id, 10);
    if (!witness2) return res.status(400).json({ error: 'witness_2_id required — CD entries need two signatures' });
    if (witness2 === req.user.id) return res.status(400).json({ error: 'witness_2 must be a different staff member' });
    const witness2Pin = String(b.witness_2_pin || '');
    if (!witness2Pin) return res.status(400).json({ error: 'Witness PIN required — the second staff member must countersign' });

    // Countersign check BEFORE opening the transaction
    const { rows: wRows } = await db.query(
      'SELECT id, pin_hash FROM staff WHERE id = $1 AND is_active = true', [witness2]);
    if (!wRows.length) return res.status(400).json({ error: 'witness_2 not found or inactive' });
    if (!wRows[0].pin_hash) return res.status(400).json({ error: 'Witness has no PIN set — they cannot countersign' });
    const pinOk = await bcrypt.compare(witness2Pin, wRows[0].pin_hash);
    if (!pinOk) {
      recordAudit({ req, action: 'update', entity_type: 'cd_register_entry',
        meta: { event: 'countersign_rejected', witness_2: witness2, drug: b.drug_name } });
      return res.status(401).json({ error: 'Witness PIN incorrect — entry not recorded' });
    }

    await client.query('BEGIN');

    // Lock the ledger tail and compute the running balance
    const { rows: lastRows } = await client.query(
      `SELECT balance FROM controlled_drugs_register
       WHERE drug_name = $1 AND COALESCE(form_strength,'') = COALESCE($2,'')
         AND COALESCE(resident_id, 0) = COALESCE($3, 0)
       ORDER BY entry_at DESC, id DESC LIMIT 1 FOR UPDATE`,
      [b.drug_name, b.form_strength || null, b.resident_id || null]);
    const prev = lastRows.length ? Number(lastRows[0].balance) : 0;
    const balance = prev + qtyIn - qtyOut;
    if (balance < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Balance cannot go negative (current ${prev}, out ${qtyOut})` });
    }
    const { rows } = await client.query(
      `INSERT INTO controlled_drugs_register (resident_id, drug_name, form_strength, entry_type,
         qty_in, qty_out, balance, supplier_or_destination, witness_1, witness_2, notes, entry_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12::timestamptz, now())) RETURNING *`,
      [b.resident_id || null, b.drug_name, b.form_strength || null, b.entry_type,
       qtyIn, qtyOut, balance, b.supplier_or_destination || null,
       req.user.id, witness2, b.notes || null, b.entry_at || null]);
    await client.query('COMMIT');
    recordAudit({ req, action: 'create', entity_type: 'cd_register_entry', entity_id: rows[0].id,
      meta: { drug: b.drug_name, entry_type: b.entry_type, qty_in: qtyIn, qty_out: qtyOut, balance, witness_2: witness2 } });
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, e);
  } finally { client.release(); }
});

module.exports = router;
