'use strict';
// ============================================================================
// b225 — Invoice discounts.  Mounted at /api/discounts. Manager-guarded.
//
// Three things live here:
//   • the catalogue      — what discounts exist and what they take off
//   • the attachments    — which child has which one, between which dates
//   • the family view    — who a child's siblings are and where they rank
//
// Nothing in here applies a discount to an invoice. That happens once, in the
// generators, through src/lib/invoice-discounts.js. A discount is only ever
// attached by a manager choosing to attach it: sharing a bill payer with an
// older sibling makes a family ELIGIBLE, it does not make the discount happen.
// ============================================================================

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const DISC = require('../lib/invoice-discounts');
// b535 (2026-10-29) — attaching, re-dating or ending a discount moves the bill, so the
// save says which invoices it has just made out of date (src/lib/invoice-pricing.js).
// Read-only, never throws, appended to the response; the discount write is untouched.
const PRICING = require('../lib/invoice-pricing');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const managerGuard = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerGuard);

const iso = d => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

/**
 * Validate a catalogue row off the wire. Money and percentages are the one place
 * a sloppy parse turns into a wrong bill, so a value that is not a finite number
 * is rejected rather than coerced to zero.
 */
function validateDiscount(body, { partial = false } = {}) {
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'name required' };
    out.name = name.slice(0, 120);
  }
  if (body.kind !== undefined || !partial) {
    if (!DISC.KINDS.includes(body.kind)) {
      return { error: `kind must be one of: ${DISC.KINDS.join(', ')}` };
    }
    out.kind = body.kind;
  }
  if (body.value !== undefined || !partial) {
    const v = Number(body.value);
    if (!Number.isFinite(v) || v < 0) return { error: 'value must be a number of 0 or more' };
    const kind = out.kind || body.kind;
    if (kind === 'percent' && v > 100) return { error: 'a percentage discount cannot exceed 100%' };
    if (kind === 'fixed_pence' && Math.round(v) !== v) {
      return { error: 'a fixed discount must be a whole number of pence' };
    }
    out.value = v;
  }
  if (body.applies_to !== undefined || !partial) {
    const at = body.applies_to || 'fees_only';
    if (!DISC.APPLIES_TO.includes(at)) {
      return { error: `applies_to must be one of: ${DISC.APPLIES_TO.join(', ')}` };
    }
    out.applies_to = at;
  }
  if (body.code   !== undefined) out.code   = String(body.code || '').trim().slice(0, 40) || null;
  if (body.notes  !== undefined) out.notes  = String(body.notes || '').trim().slice(0, 1000) || null;
  if (body.active !== undefined) out.active = !!body.active;
  return { value: out };
}

// ── GET /api/discounts ───────────────────────────────────────────────────────
// The catalogue, with how many children currently hold each one.
router.get('/', async (req, res) => {
  const db = getPool();
  try {
    const onlyActive = req.query.active === 'true';
    const { rows } = await db.query(
      `SELECT d.id, d.name, d.code, d.kind, d.value, d.applies_to, d.active, d.notes, d.created_at,
              (SELECT COUNT(*) FROM child_discounts cd
                WHERE cd.discount_id = d.id
                  AND (cd.end_date IS NULL OR cd.end_date >= CURRENT_DATE)) AS attached_count,
              (SELECT COUNT(*) FROM invoice_discount_lines idl
                WHERE idl.discount_id = d.id AND idl.superseded_at IS NULL) AS applied_count
         FROM discounts d
        ${onlyActive ? 'WHERE d.active = true' : ''}
        ORDER BY d.active DESC, d.name`);
    res.json({ discounts: rows.map(r => ({
      ...r,
      value: Number(r.value),
      attached_count: Number(r.attached_count),
      applied_count: Number(r.applied_count),
    })) });
  } catch (e) {
    console.error('[discounts] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/discounts/sibling-candidates ────────────────────────────────────
// Families with more than one child on roll, ranked by who started first, with
// whichever of them already holds a discount marked. This is a WORKLIST for a
// manager, not a rule — nothing here is applied by the system.
//
// Declared before '/:id'-shaped routes so a single path segment cannot swallow it.
router.get('/sibling-candidates', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT ${DISC.familyKeySql('c')} AS family_key,
              c.id, c.first_name, c.last_name, c.start_date, c.room,
              EXISTS (SELECT 1 FROM child_discounts cd
                        JOIN discounts d ON d.id = cd.discount_id
                       WHERE cd.child_id = c.id AND d.active = true
                         AND (cd.end_date IS NULL OR cd.end_date >= CURRENT_DATE)) AS has_discount
         FROM children c
        WHERE c.status = 'active'
          AND ${DISC.familyKeySql('c')} IS NOT NULL
        ORDER BY 1, c.start_date NULLS LAST, c.id`);

    const families = [];
    let current = null;
    for (const r of rows) {
      if (!current || current.family_key !== r.family_key) {
        current = { family_key: r.family_key, children: [] };
        families.push(current);
      }
      current.children.push({
        id: r.id, name: `${r.first_name} ${r.last_name}`, room: r.room,
        start_date: r.start_date ? iso(r.start_date) : null,
        rank: current.children.length + 1,
        has_discount: r.has_discount,
      });
    }
    const multi = families.filter(f => f.children.length > 1);
    res.json({
      families: multi,
      family_count: multi.length,
      // Rank 2+ with nothing attached — the children a sibling discount would
      // normally be offered to, and hasn't been.
      untreated: multi.flatMap(f => f.children.filter(c => c.rank > 1 && !c.has_discount)).length,
    });
  } catch (e) {
    console.error('[discounts] sibling-candidates error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/discounts ──────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const db = getPool();
  const v = validateDiscount(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.value;
  try {
    const { rows: [row] } = await db.query(
      `INSERT INTO discounts (name, code, kind, value, applies_to, active, notes)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,true),$7) RETURNING *`,
      [d.name, d.code || null, d.kind, d.value, d.applies_to,
       d.active === undefined ? null : d.active, d.notes || null]);
    recordAudit({ req, action: 'create', entity_type: 'discount', entity_id: row.id,
      meta: { name: row.name, kind: row.kind, value: Number(row.value), applies_to: row.applies_to } });
    res.json({ ok: true, discount: { ...row, value: Number(row.value) } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That discount code is already in use' });
    console.error('[discounts] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/discounts/:id ───────────────────────────────────────────────────
// Edits the catalogue row only. Invoices already generated keep the figures they
// were generated with — invoice_discount_lines records what was actually taken
// off, so changing the rate today never rewrites a bill a family has already had.
router.put('/:id', async (req, res) => {
  const db = getPool();
  const v = validateDiscount(req.body || {}, { partial: true });
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.value;
  const sets = [], params = [];
  for (const k of ['name', 'code', 'kind', 'value', 'applies_to', 'active', 'notes']) {
    if (d[k] !== undefined) { params.push(d[k]); sets.push(`${k} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(parseInt(req.params.id, 10));
  try {
    const { rows: [row] } = await db.query(
      `UPDATE discounts SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length} RETURNING *`, params);
    if (!row) return res.status(404).json({ error: 'Discount not found' });
    recordAudit({ req, action: 'update', entity_type: 'discount', entity_id: row.id, meta: d });
    res.json({ ok: true, discount: { ...row, value: Number(row.value) } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That discount code is already in use' });
    console.error('[discounts] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/discounts/:id ────────────────────────────────────────────────
// Deactivates. Never a real delete: the row is referenced by every invoice that
// ever carried it, and a bill has to stay able to say what came off it.
router.delete('/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [row] } = await db.query(
      `UPDATE discounts SET active = false, updated_at = NOW() WHERE id = $1 RETURNING id, name`,
      [parseInt(req.params.id, 10)]);
    if (!row) return res.status(404).json({ error: 'Discount not found' });
    recordAudit({ req, action: 'deactivate', entity_type: 'discount', entity_id: row.id,
      meta: { name: row.name } });
    res.json({ ok: true, deactivated: row.id,
      note: 'Deactivated, not deleted — invoices that already carry it keep their record.' });
  } catch (e) {
    console.error('[discounts] deactivate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/discounts/child/:child_id ───────────────────────────────────────
// What this child has, what they could have, and who their siblings are.
router.get('/child/:child_id', async (req, res) => {
  const db = getPool();
  const childId = parseInt(req.params.child_id, 10);
  if (!childId) return res.status(400).json({ error: 'child_id required' });
  try {
    const [{ rows: attached }, family, { rows: catalogue }] = await Promise.all([
      db.query(
        `SELECT cd.id, cd.discount_id, cd.start_date, cd.end_date, cd.notes, cd.created_at,
                d.name, d.code, d.kind, d.value, d.applies_to, d.active,
                s.first_name || ' ' || s.last_name AS created_by_name,
                (SELECT COUNT(*) FROM invoice_discount_lines idl
                  WHERE idl.child_discount_id = cd.id AND idl.superseded_at IS NULL) AS times_applied
           FROM child_discounts cd
           JOIN discounts d ON d.id = cd.discount_id
           LEFT JOIN staff s ON s.id = cd.created_by
          WHERE cd.child_id = $1
          ORDER BY cd.start_date DESC, cd.id DESC`, [childId]),
      DISC.familyOf(db, childId),
      db.query(`SELECT id, name, code, kind, value, applies_to FROM discounts
                 WHERE active = true ORDER BY name`),
    ]);
    if (!family) return res.status(404).json({ error: 'Child not found' });

    const today = iso(new Date());
    res.json({
      child_id: childId,
      discounts: attached.map(r => ({
        ...r,
        value: Number(r.value),
        start_date: iso(r.start_date),
        end_date: r.end_date ? iso(r.end_date) : null,
        times_applied: Number(r.times_applied),
        live: iso(r.start_date) <= today && (!r.end_date || iso(r.end_date) >= today) && r.active,
      })),
      catalogue: catalogue.map(r => ({ ...r, value: Number(r.value) })),
      family: {
        family_key: family.family_key,
        size: family.size,
        rank: family.rank,
        // Rank 2+ of a family with more than one child on roll. Says only that
        // the usual sibling case applies; attaching it is still a decision.
        sibling_eligible: family.size > 1 && family.rank > 1,
        siblings: family.siblings.map(sb => ({
          id: sb.id, name: `${sb.first_name} ${sb.last_name}`, rank: sb.rank,
          start_date: sb.start_date ? iso(sb.start_date) : null,
          has_discount: sb.has_discount,
          is_this_child: sb.id === childId,
        })),
      },
    });
  } catch (e) {
    console.error('[discounts] child list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/discounts/child/:child_id ──────────────────────────────────────
// Attach a discount to a child. Body: { discount_id, start_date?, end_date?, notes? }
router.post('/child/:child_id', async (req, res) => {
  const db = getPool();
  const childId = parseInt(req.params.child_id, 10);
  const discountId = parseInt(req.body?.discount_id, 10);
  if (!childId || !discountId) return res.status(400).json({ error: 'child_id and discount_id required' });

  const startDate = req.body?.start_date || iso(new Date());
  const endDate   = req.body?.end_date || null;
  if (endDate && endDate < startDate) {
    return res.status(400).json({ error: 'end_date cannot be before start_date' });
  }
  try {
    const { rows: [d] } = await db.query(
      'SELECT id, name, active FROM discounts WHERE id = $1', [discountId]);
    if (!d) return res.status(404).json({ error: 'Discount not found' });
    if (!d.active) return res.status(400).json({ error: 'That discount is not active' });

    const { rows: [row] } = await db.query(
      `INSERT INTO child_discounts (child_id, discount_id, start_date, end_date, created_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [childId, discountId, startDate, endDate, req.user.id,
       req.body?.notes ? String(req.body.notes).slice(0, 500) : null]);

    recordAudit({ req, action: 'attach_discount', entity_type: 'child', entity_id: childId,
      meta: { discount_id: discountId, discount: d.name, start_date: startDate, end_date: endDate } });
    res.json({ ok: true, child_discount: { ...row, start_date: iso(row.start_date),
      end_date: row.end_date ? iso(row.end_date) : null },
      stale_invoices: await PRICING.staleForChild(db, childId),   // b535
      note: 'Applies to invoices generated from now on. Invoices already raised are unchanged — '
          + 'update an unsent one, or reissue a sent one, to pick it up.' });
  } catch (e) {
    if (e.code === '23503') return res.status(404).json({ error: 'Child not found' });
    if (e.code === '23505') {
      return res.status(409).json({ error: 'That discount is already attached to this child from that date' });
    }
    console.error('[discounts] attach error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/discounts/child-discount/:id ────────────────────────────────────
// Change the dates on an attachment. Body: { start_date?, end_date? }
// end_date: null clears it (open-ended again).
router.put('/child-discount/:id', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  const sets = [], params = [];
  if (req.body?.start_date !== undefined) { params.push(req.body.start_date); sets.push(`start_date = $${params.length}`); }
  if (req.body?.end_date !== undefined)   { params.push(req.body.end_date || null); sets.push(`end_date = $${params.length}`); }
  if (req.body?.notes !== undefined)      { params.push(String(req.body.notes || '').slice(0, 500) || null); sets.push(`notes = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(id);
  try {
    const { rows: [row] } = await db.query(
      `UPDATE child_discounts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!row) return res.status(404).json({ error: 'Attachment not found' });
    recordAudit({ req, action: 'update_discount_dates', entity_type: 'child', entity_id: row.child_id,
      meta: { child_discount_id: id, start_date: iso(row.start_date),
              end_date: row.end_date ? iso(row.end_date) : null } });
    res.json({ ok: true, child_discount: { ...row, start_date: iso(row.start_date),
      end_date: row.end_date ? iso(row.end_date) : null },
      stale_invoices: await PRICING.staleForChild(db, row.child_id) });   // b535
  } catch (e) {
    if (e.code === '23514') return res.status(400).json({ error: 'end_date cannot be before start_date' });
    console.error('[discounts] update attachment error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/discounts/child-discount/:id ─────────────────────────────────
// Detach. An attachment that has never reached an invoice is removed; one that
// HAS is end-dated instead, because deleting it would leave invoices carrying a
// discount with nothing on file saying who granted it or when.
router.delete('/child-discount/:id', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  try {
    const { rows: [row] } = await db.query(
      `SELECT cd.*, (SELECT COUNT(*) FROM invoice_discount_lines idl
                      WHERE idl.child_discount_id = cd.id) AS used
         FROM child_discounts cd WHERE cd.id = $1`, [id]);
    if (!row) return res.status(404).json({ error: 'Attachment not found' });

    if (Number(row.used) > 0) {
      // Not simply "today": an invoice for a FUTURE month is raised in the month
      // before it, so an attachment can already have been applied while its own
      // start_date is still ahead of us. Ending such a row today would put
      // end_date before start_date, which the table rejects — rightly. Ending it
      // ON its start date collapses the window to the single day it was granted
      // for, which still covers the invoice that already carries it and stops it
      // reaching any later month.
      const startIso = iso(row.start_date);
      const today = iso(new Date());
      const asked = req.body?.end_date || null;
      const endOn = asked
        ? (asked < startIso ? startIso : asked)
        : (today < startIso ? startIso : today);
      const { rows: [ended] } = await db.query(
        `UPDATE child_discounts SET end_date = $1 WHERE id = $2 RETURNING *`, [endOn, id]);
      recordAudit({ req, action: 'end_discount', entity_type: 'child', entity_id: row.child_id,
        meta: { child_discount_id: id, end_date: endOn, reason: 'already applied to an invoice' } });
      return res.json({ ok: true, ended: true, end_date: iso(ended.end_date),
        stale_invoices: await PRICING.staleForChild(db, row.child_id),   // b535
        note: 'This discount has already been applied to an invoice, so it was end-dated rather '
            + 'than removed. Those invoices keep their record of it.' });
    }

    await db.query('DELETE FROM child_discounts WHERE id = $1', [id]);
    recordAudit({ req, action: 'detach_discount', entity_type: 'child', entity_id: row.child_id,
      meta: { child_discount_id: id, discount_id: row.discount_id } });
    res.json({ ok: true, removed: true, stale_invoices: await PRICING.staleForChild(db, row.child_id) });   // b535
  } catch (e) {
    if (e.code === '23514') return res.status(400).json({ error: 'end_date cannot be before start_date' });
    console.error('[discounts] detach error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/discounts/invoice/:invoice_id ───────────────────────────────────
// The audit trail: what was taken off this invoice, and what it was taken off.
router.get('/invoice/:invoice_id', async (req, res) => {
  const db = getPool();
  try {
    const rows = await DISC.invoiceDiscountLines(db, parseInt(req.params.invoice_id, 10));
    res.json({
      lines: rows.map(r => ({ ...r, amount_pence: Number(r.amount_pence) })),
      total_pence: rows.reduce((s, r) => s - Number(r.amount_pence), 0),
    });
  } catch (e) {
    console.error('[discounts] invoice lines error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
