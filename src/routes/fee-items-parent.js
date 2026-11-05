'use strict';
// b144 — Parent-facing fee schedule / calculator / opt-out routes for editions
// whose parents portal uses JWT Bearer auth (not CF Access headers) — i.e.
// primary/secondary school editions. Modelled on payments-parent.js's
// parentAuth/parentChildIds pattern. Schema-relative throughout (relies on
// PG_SCHEMA/search_path per edition) — never hard-code a schema prefix here,
// see wren/logs/b139-demo-feature-parity.NOTES.md for why that matters.
// Mount at /api/fee-items-parent in any edition with a JWT parent portal.

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { getPool } = require('../db/pool');
const IB = require('../services/itemised-billing');

function parentAuth(req, res, next) {
  const h = (req.headers.authorization || '').trim();
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthenticated' });
  try {
    // chain E4 review (2026-10-21): the identical hole b394 closed in payments-parent.js
    // was left open here, in a file whose own header says it is modelled on it — a bare
    // verify accepted ANY validly-signed JWT, staff tokens included, against a named
    // child's fee items. Mounted only on editions/primary/server-unified.js, whose parent
    // tokens come from parents-portal.js and now carry both claims.
    req.parent = jwt.verify(h.slice(7), process.env.JWT_SECRET, { audience: req._portal || 'parents' });
    if (req.parent.role !== 'parent') return res.status(401).json({ error: 'Invalid token' });
    req.parentEmail = (req.parent.email || '').toLowerCase().trim();
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function parentChildIds(db, email) {
  const { rows } = await db.query(
    'SELECT child_id FROM parent_portal_access WHERE lower(email)=$1 AND is_active=true',
    [email]
  );
  return rows.map(r => r.child_id);
}

async function currentTerm(db) {
  const { rows: [t] } = await db.query(
    `SELECT * FROM funding_terms WHERE is_current=true ORDER BY start_date DESC LIMIT 1`);
  return t || null;
}
function rateForBand(map, band) {
  if (band === '3_4yo') return map['3yo'] || map['3_4yo'] || 0;
  return map[band] || 0;
}

// ── GET /schedule — active fee items + funding rates + per-child prefill ──────
router.get('/schedule', parentAuth, async (req, res) => {
  const db = getPool();
  try {
    const onDate = new Date().toISOString().slice(0, 10);
    const { rows: allItems } = await db.query(
      `SELECT id,name,statutory_category,unit,price_pence,formula,age_band,optoutable,
              waive_when_funding_covers_day,note,effective_from,effective_to,active
       FROM fee_items ORDER BY statutory_category, age_band NULLS FIRST, id`);
    const items = allItems.filter(it => IB.itemActiveOn(it, onDate));
    const { rows: rateRows } = await db.query(
      `SELECT age_band,pence_per_hour,funding_year,provisional FROM funding_rates ORDER BY funding_year DESC, age_band`);

    const childIds = await parentChildIds(db, req.parentEmail);
    let prefill = [];
    if (childIds.length) {
      const term = await currentTerm(db);
      const { rows } = await db.query(`
        SELECT c.id, c.first_name,
          (CASE WHEN c.date_of_birth > $2::date - INTERVAL '2 years' THEN 'under_2'
                WHEN c.date_of_birth > $2::date - INTERVAL '3 years' THEN '2yo'
                ELSE '3_4yo' END) AS age_band,
          cf.total_hours_week, cf.universal_hours_week, cf.extended_hours_week,
          COALESCE((SELECT SUM(cb.mon::int+cb.tue::int+cb.wed::int+cb.thu::int+cb.fri::int) FROM child_bookings cb WHERE cb.child_id=c.id AND cb.is_active=true),0) AS days_per_week,
          COALESCE((SELECT SUM(cb.mon::int+cb.tue::int+cb.wed::int+cb.thu::int+cb.fri::int) FROM child_bookings cb WHERE cb.child_id=c.id AND cb.is_active=true AND cb.funded=true),0) AS funded_days_per_week
        FROM children c
        LEFT JOIN child_funding cf ON cf.child_id=c.id AND cf.term_id=$3
        WHERE c.id = ANY($1::int[])`, [childIds, IB.AGE_BAND_REFERENCE, term ? term.id : null]);
      prefill = rows;
    }
    res.json({
      fee_items: items, funding_rates: rateRows, children: prefill,
      statement: 'Funded early-years hours (where applicable) are always free. Meals, consumables and extra activities are voluntary — you can opt out of any item without affecting your child’s place, and a free alternative is available on request.',
    });
  } catch (e) { console.error('[fee-items-parent] schedule:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// b216 — the fee-formula variables that live in ladn.settings (meal rates,
// reviewed each April). Every caller of buildItemisedLines has to supply these or
// a formula naming one throws: an unknown identifier is rejected rather than
// silently evaluated as zero, which is the right way round.
// 2026-09-17 — the consumables fee is back on the EyLog basis (see
// services/itemised-billing.js); mealFormulaVars supplies meal_hours_basis itself.
async function formulaVarsFor(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN
      ('meal_charge_2yo_weekly_pence','meal_charge_3_4yo_weekly_pence')`);
  return IB.mealFormulaVars(Object.fromEntries(rows.map(r => [r.key, r.value])));
}

// ── POST /calculate — same engine as the manager-side calculator ──────────────
router.post('/calculate', parentAuth, async (req, res) => {
  const db = getPool();
  try {
    const b = req.body || {};
    if (!b.age_band) return res.status(400).json({ error: 'age_band required' });
    const { rows: items } = await db.query(`SELECT * FROM fee_items ORDER BY id`);
    const { rows: rateRows } = await db.query(`SELECT age_band,pence_per_hour FROM funding_rates ORDER BY updated_at DESC`);
    const ratesMap = {}; for (const r of rateRows) if (!(r.age_band in ratesMap)) ratesMap[r.age_band] = Number(r.pence_per_hour);
    const daysPerWeek = Number(b.days_per_week || 0);
    const fundedDays = b.funded_days_per_week != null ? Number(b.funded_days_per_week) : daysPerWeek;
    const privateDays = Math.max(0, daysPerWeek - fundedDays);
    const result = IB.buildItemisedLines({
      ageBand: b.age_band, weeklyFundedHours: Number(b.weekly_funded_hours || 0),
      daysPerWeek, fundedDaysPerWeek: fundedDays, privateDaysPerWeek: privateDays,
      weeks: Number(b.weeks || IB.WEEKS_PER_MONTH), feeItems: items,
      fundingRatePence: rateForBand(ratesMap, b.age_band), optedOutItemIds: b.opted_out_item_ids || [],
      periodLabel: b.period_label || '', onDateIso: new Date().toISOString().slice(0, 10),
      formulaVars: await formulaVarsFor(db),
    });
    res.json({ ok: true, age_band: b.age_band, ...result });
  } catch (e) { console.error('[fee-items-parent] calculate:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// ── POST /optout-request — voluntary opt-out, awaits manager approval ─────────
router.post('/optout-request', parentAuth, async (req, res) => {
  const db = getPool();
  const { child_id, fee_item_id, opted_out = true, note } = req.body || {};
  if (!child_id || !fee_item_id) return res.status(400).json({ error: 'child_id and fee_item_id required' });
  try {
    const owned = await parentChildIds(db, req.parentEmail);
    if (!owned.includes(Number(child_id))) return res.status(403).json({ error: 'Not your child' });
    const { rows: [fi] } = await db.query(`SELECT id,optoutable FROM fee_items WHERE id=$1`, [fee_item_id]);
    if (!fi) return res.status(404).json({ error: 'Fee item not found' });
    if (fi.optoutable === false) return res.status(400).json({ error: 'This item is core and cannot be opted out of' });
    const { rows: [row] } = await db.query(`
      INSERT INTO child_fee_optouts (child_id, fee_item_id, opted_out, status, effective_from, requested_by, note)
      VALUES ($1,$2,$3,'pending',CURRENT_DATE,$4,$5)
      ON CONFLICT (child_id, fee_item_id)
      DO UPDATE SET opted_out=EXCLUDED.opted_out, status='pending', requested_by=EXCLUDED.requested_by,
                    note=EXCLUDED.note, approved_by=NULL, approved_at=NULL, updated_at=NOW()
      RETURNING *`, [child_id, fee_item_id, opted_out, req.parentEmail, note || null]);
    res.json({ ok: true, optout: row, message: 'Your request has been sent for approval. Your place is unaffected.' });
  } catch (e) { console.error('[fee-items-parent] optout-request:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// ── GET /my-optouts ────────────────────────────────────────────────────────────
router.get('/my-optouts', parentAuth, async (req, res) => {
  const db = getPool();
  try {
    const owned = await parentChildIds(db, req.parentEmail);
    if (!owned.length) return res.json({ optouts: [] });
    const { rows } = await db.query(`
      SELECT o.child_id,o.fee_item_id,o.opted_out,o.status,o.created_at,fi.name AS fee_item_name
      FROM child_fee_optouts o JOIN fee_items fi ON fi.id=o.fee_item_id
      WHERE o.child_id = ANY($1::int[]) ORDER BY o.created_at DESC`, [owned]);
    res.json({ optouts: rows });
  } catch (e) { res.status(500).json({ error: 'Internal error' }); }
});

module.exports = router;
