'use strict';
// 2026-10-21 — one-off EXTRA SESSIONS, and how they reach the family's next invoice.
//
// An extra session is a dated ladn.child_fee_items row (frequency 'one-off'). Two ways in:
//   · a parent asks in the app (/welcome/bookings) and a manager approves it
//     (POST /api/bookings/requests/:id/resolve, source 'booking-approval');
//   · a member of staff adds it straight onto the child's account
//     (POST /api/bookings/extra-session, source 'staff-extra-session').
// Either way the price is the child's normal day rate (fee_items, by age band) scaled to
// the session's share of the day, worked out once, when the session is agreed.
//
// The invoice generator (src/routes/finance-invoices.js) picks up every such row that has
// no invoice_id yet and whose date falls on or before the end of the month being billed,
// adds it as a line, and stamps invoice_id so it is billed exactly once. A reissue carries
// the rows on the old invoice across to the replacement.

const SOURCES = ['booking-approval', 'staff-extra-session'];
const SESSION_LABEL = { full: 'Full day', am: 'Morning', pm: 'Afternoon' };
const SESSION_TYPE_CODE = { full: 'day', am: 'am', pm: 'pm' };

function normSession(s) {
  return Object.prototype.hasOwnProperty.call(SESSION_LABEL, s) ? s : 'full';
}

function _mins(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

/** The share of a full day this session is, from settings.booking_session_types. */
async function sessionFraction(db, session) {
  const s = normSession(session);
  if (s === 'full') return 1;
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'booking_session_types'`);
    const list = JSON.parse((rows[0] && rows[0].value) || 'null');
    if (Array.isArray(list)) {
      const len = t => { const a = _mins(t && t.start), b = _mins(t && t.finish); return (a != null && b != null && b > a) ? b - a : null; };
      const day = len(list.find(t => t && t.code === 'day'));
      const part = len(list.find(t => t && t.code === SESSION_TYPE_CODE[s]));
      if (day && part) return Math.min(1, part / day);
    }
  } catch (_) { /* fall through to a half day */ }
  return 0.5;
}

/** The child's normal day rate on that date — the same age-banded fee_items row the invoice uses. */
async function dayRatePence(db, childId, onDate) {
  const { ageBandFromDob } = require('../services/itemised-billing');
  const { rows: kid } = await db.query('SELECT date_of_birth FROM children WHERE id=$1', [childId]);
  const dob = kid[0] && kid[0].date_of_birth;
  const ageBand = dob ? ageBandFromDob(dob, onDate) : null;
  const { rows } = await db.query(`
    SELECT price_pence FROM fee_items
     WHERE statutory_category='additional_paid_hours' AND unit='day' AND optoutable=false
       AND active=true AND (age_band=$1 OR age_band IS NULL)
       AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)
     ORDER BY (age_band=$1) DESC NULLS LAST LIMIT 1
  `, [ageBand, onDate]);
  return rows[0] && rows[0].price_pence != null ? Number(rows[0].price_pence) : null;
}

/**
 * Put one extra session on a child's account. Returns the child_fee_items row.
 * `meta` lands in raw (booking_request_id, added_by, notes) for the audit trail.
 */
async function recordExtraSession(db, { childId, date, session, source, meta = {} }) {
  const s = normSession(session);
  const rate = await dayRatePence(db, childId, date);
  const fraction = await sessionFraction(db, s);
  const price = rate != null ? Math.round(rate * fraction) : null;
  const when = new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const { rows } = await db.query(`
    INSERT INTO child_fee_items
      (child_id, fee_item_id, item_name, quantity, price_pence, frequency, start_date, end_date, source, raw)
    VALUES ($1, NULL, $2, 1, $3, 'one-off', $4, $4, $5, $6::jsonb)
    RETURNING *
  `, [childId, `Extra session — ${SESSION_LABEL[s].toLowerCase()}, ${when}`, price, date, source,
      JSON.stringify(Object.assign({ session: s, day_rate_pence: rate, fraction }, meta))]);
  return rows[0];
}

/**
 * The extra sessions an invoice for this child should carry: not yet on any invoice and
 * dated on or before the end of the billed month — plus, for a reissue, the ones already
 * on the invoice being replaced. Never throws: a tenant without the table bills as before.
 */
async function extrasForInvoice(db, childId, periodToIso, { fromInvoiceId = null } = {}) {
  try {
    const { rows } = await db.query(`
      SELECT id, item_name, price_pence, start_date, raw
        FROM child_fee_items
       WHERE child_id = $1 AND frequency = 'one-off' AND source = ANY($2::text[])
         AND ((invoice_id IS NULL AND start_date <= $3::date) OR ($4::int IS NOT NULL AND invoice_id = $4::int))
       ORDER BY start_date, id
    `, [childId, SOURCES, periodToIso, fromInvoiceId]);
    return rows;
  } catch (e) {
    if (!/does not exist/.test(e.message)) console.error('[extra-sessions] load:', e.message);
    return [];
  }
}

/** One invoice line per extra session. */
function extraSessionLines(extras) {
  return extras.filter(x => Number(x.price_pence) > 0).map(x => ({
    label:        x.item_name || 'Extra session',
    // The DfE statutory category for paid hours, but NOT the core childcare line's
    // 'additional_private_paid_hours' — the statement (eyman-invoice-model isCoreChildcare)
    // would fold that into the childcare row. Without optoutable:false it stays its own row.
    category:     'additional_paid_hours',
    is_funded:    false,
    is_extra_session: true,
    child_fee_item_id: x.id,
    quantity:     1,
    unit_label:   'session',
    unit_pence:   Number(x.price_pence),
    amount_pence: Number(x.price_pence),
    // b535 review — a carried correction rides this store too; the family should read
    // "Correction to the November invoice…", not "One-off extra session".
    note:         (x.raw && x.raw.b535_carry_forward && x.raw.line_note)
                  || 'One-off extra session, at your normal session rate.',
  }));
}

/** Stamp the rows as billed on this invoice. */
async function markInvoiced(db, ids, invoiceId) {
  if (!ids || !ids.length) return;
  await db.query(`UPDATE child_fee_items SET invoice_id=$1, updated_at=NOW() WHERE id = ANY($2::int[])`,
    [invoiceId, ids]);
}

module.exports = { SOURCES, SESSION_LABEL, normSession, sessionFraction, dayRatePence,
                   recordExtraSession, extrasForInvoice, extraSessionLines, markInvoiced };
