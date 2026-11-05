'use strict';
// b490 (2026-10-12) — one place a manager overrides a child's day rate for a date
// range, instead of the fee_items catalogue band rate. Read by both billing engines
// (buildDfeLineItems' SQL lookup in finance-invoices.js, and computeItemisedForChild's
// JS lookup) so neither can show a different price for the same child in the same
// month. See child_price_overrides (migrations/b490-price-overrides.sql).

const sch = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s || '')) throw new Error('bad schema'); return s; };

// Appended into a childQuery's FROM/JOIN clauses. The caller must already bind
// $2=year, $3=month (the same positions the fee_items LATERAL in finance-invoices.js
// uses) and have `c.id` in scope.
function priceOverrideLateralSql(schema = 'ladn') {
  const S = sch(schema);
  return `
      LEFT JOIN LATERAL (
        SELECT price_pence, reason, id
          FROM ${S}.child_price_overrides
         WHERE child_id = c.id AND active AND unit = 'day'
           AND from_date <= (make_date($2::int,$3::int,1) + INTERVAL '1 month' - INTERVAL '1 day')::date
           AND to_date   >= make_date($2::int,$3::int,1)
         ORDER BY from_date DESC LIMIT 1) ov ON true`;
}

// Same lookup for callers that price in JS rather than SQL (the itemised engine —
// see computeItemisedForChild in finance-invoices.js).
async function activeDayRateOverride(db, childId, year, month, schema = 'ladn') {
  const S = sch(schema);
  const { rows: [row] } = await db.query(`
    SELECT price_pence, reason, id
      FROM ${S}.child_price_overrides
     WHERE child_id = $1 AND active AND unit = 'day'
       AND from_date <= (make_date($2::int,$3::int,1) + INTERVAL '1 month' - INTERVAL '1 day')::date
       AND to_date   >= make_date($2::int,$3::int,1)
     ORDER BY from_date DESC LIMIT 1`, [childId, year, month]);
  return row || null;
}

module.exports = { priceOverrideLateralSql, activeDayRateOverride };
