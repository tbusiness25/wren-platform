const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const crypto = require('crypto');
const { recordAudit } = require('../utils/audit');

// b491 (2026-10-12, security hardening item 4) — carer_ni_number masking.
// A UK NI number is 2 letters + 3 digit-pairs + 1 letter (e.g. AB123456C); the
// mask shows only the last digit-pair and the final letter, matching the brief's
// example shape "•• •• •• 12 A". Applied to every `cf.*` row the funding dashboard
// and child-profile Funding section send to the browser — those callers never
// needed the real number, only to show it's on file. The Reveal endpoint below
// is the only place the real value now leaves the server for a browser to see.
function _maskNI(ni) {
  if (!ni) return null;
  const clean = String(ni).replace(/\s+/g, '').toUpperCase();
  if (clean.length < 3) return '•• •• •• •• •';
  const lastPair = clean.slice(-3, -1);
  const suffix = clean.slice(-1);
  return `•• •• •• ${lastPair} ${suffix}`;
}
function _maskFundingRow(row) {
  if (!row) return row;
  if (row.carer_ni_number !== undefined) {
    row.carer_ni_number_masked = _maskNI(row.carer_ni_number);
    row.carer_ni_number_on_file = row.carer_ni_number != null && row.carer_ni_number !== '';
    delete row.carer_ni_number;
  }
  // Never send the ciphertext/IV/auth-tag to a browser either — nothing there needs it.
  delete row.carer_ni_number_enc; delete row.carer_ni_number_iv; delete row.carer_ni_number_tag;
  return row;
}
// b298 — which funding_terms rows are the EyLog historic imports. One place
// decides, so every screen and route agrees. See src/lib/funding-periods.js.
const FP = require('../lib/funding-periods');
// b535 (2026-10-29) — a funding allocation is the biggest single thing that moves a
// bill, so saving one says which invoices it has just made out of date
// (src/lib/invoice-pricing.js). Read-only, never throws, appended to the response.
const PRICING = require('../lib/invoice-pricing');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// Public declaration routes (no auth) — registered BEFORE authenticate middleware
router.get('/declarations/sign/:token', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [cf] } = await db.query(`
      SELECT cf.*, c.first_name||' '||c.last_name as child_name,
        c.date_of_birth, ft.name as term_name, ft.start_date, ft.end_date
      FROM child_funding cf
      JOIN children c ON c.id=cf.child_id
      JOIN funding_terms ft ON ft.id=cf.term_id
      WHERE cf.declaration_token=$1
    `, [req.params.token]);
    if (!cf) return res.status(404).json({ error: 'Invalid or expired token' });
    if (cf.declaration_signed) return res.status(410).json({ error: 'Already signed', child_name: cf.child_name });
    res.json(cf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/declarations/sign/:token', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [cf] } = await db.query(`
      UPDATE child_funding
      SET declaration_signed=true, declaration_signed_date=CURRENT_DATE,
          declaration_method='portal', declaration_token=NULL, updated_at=NOW()
      WHERE declaration_token=$1 AND declaration_signed=false
      RETURNING *, (SELECT first_name||' '||last_name FROM children WHERE id=child_id) as child_name
    `, [req.params.token]);
    if (!cf) return res.status(404).json({ error: 'Invalid token or already signed' });

    // login-20261023: through the one Telegram sender (src/lib/notifications.js), which carries the dev guard.
    require('../lib/notifications').sendTelegramNow({ text: `✅ ${cf.child_name} funding declaration signed by parent`, parse_mode: null });

    res.json({ ok: true, child_name: cf.child_name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.use(authenticate);

// b491 (2026-10-12, security hardening item 6) — every GET below this point was
// reachable by ANY authenticated role (including practitioner) with no gate at
// all: the full funding ledger, carer NI numbers, declaration tokens. EY floor
// staff have no legitimate reason to see this (confirmed: no EY/practitioner
// page calls /api/funding/* at all). managerOnly below already protects the
// writes; this closes the much bigger read side.
router.use((req, res, next) => {
  if (hasRole(req.user, ['practitioner', 'apprentice'])) {
    return res.status(403).json({ error: 'Forbidden — funding is not available to this role' });
  }
  next();
});

const managerOnly = requireRole('manager', 'deputy_manager');

// ── Helper: age in months ──────────────────────────────────────────────────
function ageMonths(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  const now = new Date();
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
}

// ── Helper: weeks between two dates (excluding holiday ranges) ─────────────
function calcWeeks(startDate, endDate, holidays = []) {
  let totalDays = (new Date(endDate) - new Date(startDate)) / 86400000 + 1;
  let holidayDays = 0;
  for (const h of holidays) {
    const hs = new Date(h.start);
    const he = new Date(h.end);
    const s = new Date(startDate);
    const e = new Date(endDate);
    const overlapStart = hs < s ? s : hs;
    const overlapEnd = he > e ? e : he;
    if (overlapEnd >= overlapStart) {
      holidayDays += (overlapEnd - overlapStart) / 86400000 + 1;
    }
  }
  return Math.round(((totalDays - holidayDays) / 7) * 2) / 2; // round to 0.5
}

// ── GET / — dashboard summary for finance funding tab ─────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows: terms } = await db.query('SELECT * FROM funding_terms WHERE NOT is_archived ORDER BY start_date DESC'); // 2026-10-05: hide archived duplicates (term 90)
    const currentTerm = terms.find(t => new Date(t.start_date) <= new Date() && new Date(t.end_date) >= new Date()) || terms[0];
    let children = [], stats = { eligible_15h: 0, eligible_30h: 0, eligible_2yo: 0, eligible_eypp: 0 };
    if (currentTerm) {
      const { rows } = await db.query(`
        SELECT cf.*, c.first_name||' '||c.last_name AS child_name,
          r.name AS room, cf.universal_hours_week AS hours_15,
          cf.extended_hours_week AS hours_30,
          CASE WHEN cf.funding_type='2yo' THEN cf.universal_hours_week ELSE 0 END AS hours_2yo,
          CASE WHEN cf.eypp_eligible THEN 0 ELSE 0 END AS eypp_amount_pence
        FROM child_funding cf
        JOIN children c ON c.id = cf.child_id
        LEFT JOIN rooms r ON r.id = c.room_id
        WHERE cf.term_id = $1 AND c.is_active = true
        ORDER BY c.first_name, c.last_name`, [currentTerm.id]);
      children = rows.map(_maskFundingRow);
      stats = {
        eligible_15h:  rows.filter(r => (r.universal_hours_week||0) > 0).length,
        eligible_30h:  rows.filter(r => (r.extended_hours_week||0) > 0).length,
        eligible_2yo:  rows.filter(r => r.funding_type === '2yo').length,
        eligible_eypp: rows.filter(r => r.eypp_eligible).length,
      };
    }
    res.json({ terms, children, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /terms ─────────────────────────────────────────────────────────────
router.get('/terms', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM funding_terms WHERE NOT is_archived ORDER BY start_date DESC'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /terms/current ─────────────────────────────────────────────────────
router.get('/terms/current', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM funding_terms WHERE is_current=true LIMIT 1'
    );
    if (!rows[0]) return res.json(null);
    // Get summary counts
    const termId = rows[0].id;
    const { rows: [totals] } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE cf.funding_type != 'none' AND cf.funding_type IS NOT NULL) as funded_count,
        COUNT(*) as total_allocated,
        COUNT(*) FILTER (WHERE NOT cf.declaration_signed AND cf.funding_type != 'none') as declarations_outstanding,
        COALESCE(SUM(
          CASE
            WHEN cf.funding_type='universal' THEN cf.total_hours_term * ft.rate_3yr_universal
            WHEN cf.funding_type='extended' THEN cf.total_hours_term * ft.rate_3yr_extended
            WHEN cf.funding_type='2yr_disadvantaged' THEN cf.total_hours_term * ft.rate_2yr_disadvantaged
            WHEN cf.funding_type='under_2' THEN cf.total_hours_term * ft.rate_under_2
            WHEN cf.funding_type='2yr_working' THEN cf.total_hours_term * ft.rate_2yr_working_parents
            ELSE 0
          END
        ), 0) as estimated_value
      FROM child_funding cf
      JOIN funding_terms ft ON ft.id = cf.term_id
      WHERE cf.term_id = $1
    `, [termId]);
    const { rows: [enrolled] } = await db.query(
      'SELECT COUNT(*) as cnt FROM children WHERE is_active=true AND is_demo=false'
    );
    res.json({ ...rows[0], ...totals, total_enrolled: parseInt(enrolled.cnt) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /terms ────────────────────────────────────────────────────────────
router.post('/terms', managerOnly, async (req, res) => {
  const {
    name, description, year, start_date, end_date, funding_eligible_date,
    term_months, colour, holiday_dates, partial_week_entitlement,
    rate_under_2, rate_2yr_disadvantaged, rate_2yr_working_parents,
    rate_3yr_universal, rate_3yr_extended,
    inv_rate_under_2, inv_rate_2yr_disadvantaged, inv_rate_2yr_working_parents,
    inv_rate_3yr_universal, inv_rate_3yr_extended,
    eypp_rate, deprivation_band_a, deprivation_band_b, deprivation_band_c, deprivation_band_d,
    consumables_charge, consumables_description
  } = req.body;
  if (!name || !start_date || !end_date) return res.status(400).json({ error: 'name, start_date, end_date required' });
  try {
    const { rows } = await getPool().query(`
      INSERT INTO funding_terms (
        name, description, year, start_date, end_date, funding_eligible_date,
        term_months, colour, holiday_dates, partial_week_entitlement,
        rate_under_2, rate_2yr_disadvantaged, rate_2yr_working_parents,
        rate_3yr_universal, rate_3yr_extended,
        inv_rate_under_2, inv_rate_2yr_disadvantaged, inv_rate_2yr_working_parents,
        inv_rate_3yr_universal, inv_rate_3yr_extended,
        eypp_rate, deprivation_band_a, deprivation_band_b, deprivation_band_c, deprivation_band_d,
        consumables_charge, consumables_description
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
      RETURNING *`,
      [name, description, year, start_date, end_date, funding_eligible_date,
       term_months || [], colour || '#4a9abf', holiday_dates ? JSON.stringify(holiday_dates) : '[]',
       partial_week_entitlement || 'Full Week Entitlement',
       rate_under_2||0, rate_2yr_disadvantaged||0, rate_2yr_working_parents||0,
       rate_3yr_universal||0, rate_3yr_extended||0,
       inv_rate_under_2||0, inv_rate_2yr_disadvantaged||0, inv_rate_2yr_working_parents||0,
       inv_rate_3yr_universal||0, inv_rate_3yr_extended||0,
       eypp_rate||0, deprivation_band_a||0, deprivation_band_b||0, deprivation_band_c||0, deprivation_band_d||0,
       consumables_charge||0, consumables_description]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /terms/:id ─────────────────────────────────────────────────────────
router.get('/terms/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [term] } = await db.query('SELECT * FROM funding_terms WHERE id=$1', [req.params.id]);
    if (!term) return res.status(404).json({ error: 'Term not found' });
    res.json(term);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /terms/:id ─────────────────────────────────────────────────────────
router.put('/terms/:id', managerOnly, async (req, res) => {
  // b298 — the 17 "EyMan term N" rows imported from EyLog are HISTORY. Hundreds
  // of child_funding rows point at them, so they cannot be deleted; they have no
  // real dates, so they cannot be edited into something usable either. Read-only,
  // and refused here rather than only hidden in the UI.
  {
    const { rows: [existing] } = await getPool().query(
      'SELECT id, name, source, eylog_term_id, start_date FROM funding_terms WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Term not found' });
    if (FP.isHistoric(existing)) {
      return res.status(409).json({
        error: `"${existing.name}" was imported from EyLog and is kept read-only as funding history. `
             + 'Create a new funding period instead — the allocations on this one must not move.',
      });
    }
  }
  const allowed = [
    'name','description','year','start_date','end_date','funding_eligible_date',
    'term_months','colour','holiday_dates','partial_week_entitlement',
    'rate_under_2','rate_2yr_disadvantaged','rate_2yr_working_parents',
    'rate_3yr_universal','rate_3yr_extended',
    'inv_rate_under_2','inv_rate_2yr_disadvantaged','inv_rate_2yr_working_parents',
    'inv_rate_3yr_universal','inv_rate_3yr_extended',
    'eypp_rate','deprivation_band_a','deprivation_band_b','deprivation_band_c','deprivation_band_d',
    'consumables_charge','consumables_description'
  ];
  const updates = [], vals = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      vals.push(k === 'holiday_dates' ? JSON.stringify(req.body[k]) : req.body[k]);
      updates.push(`${k}=$${vals.length}`);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(new Date().toISOString());
  updates.push(`updated_at=$${vals.length}`);
  vals.push(req.params.id);
  try {
    const { rows } = await getPool().query(
      `UPDATE funding_terms SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /terms/:id ──────────────────────────────────────────────────────
router.delete('/terms/:id', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [check] } = await db.query(
      'SELECT COUNT(*) as cnt FROM child_funding WHERE term_id=$1', [req.params.id]
    );
    if (parseInt(check.cnt) > 0) return res.status(409).json({ error: 'Cannot delete: child funding allocations exist for this term' });
    await db.query('DELETE FROM funding_terms WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /terms/:id/set-current ─────────────────────────────────────────────
router.put('/terms/:id/set-current', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    // b298 — a period that ran in 1970 cannot be the current one.
    const { rows: [cand] } = await db.query(
      'SELECT id, name, source, eylog_term_id, start_date FROM funding_terms WHERE id=$1', [req.params.id]);
    if (!cand) return res.status(404).json({ error: 'Term not found' });
    if (FP.isHistoric(cand)) {
      return res.status(409).json({ error: `"${cand.name}" is an EyLog history row — it cannot be made the current funding period.` });
    }
    await db.query('UPDATE funding_terms SET is_current=false');
    const { rows } = await db.query(
      'UPDATE funding_terms SET is_current=true WHERE id=$1 RETURNING *', [req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /terms/:id/claim-periods — the months Ealing claim for, inside this term ──
router.get('/terms/:id/claim-periods', managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, period_label, period_year, period_month, portal_month,
              to_char(claim_start,'YYYY-MM-DD')      AS claim_start,
              to_char(claim_end,'YYYY-MM-DD')        AS claim_end,
              to_char(portal_opens,'YYYY-MM-DD')     AS portal_opens,
              to_char(portal_closes,'YYYY-MM-DD')    AS portal_closes,
              to_char(payment_expected,'YYYY-MM-DD') AS payment_expected,
              (portal_closes IS NOT NULL AND portal_closes < CURRENT_DATE)                    AS closed,
              (CURRENT_DATE BETWEEN portal_opens AND portal_closes)                           AS open_now,
              (portal_closes - CURRENT_DATE)                                                  AS days_left,
              weeks, weeks_confirmed, notes
         FROM funding_claim_periods WHERE term_id = $1
        ORDER BY period_year, period_month`, [req.params.id]);
    res.json({ periods: rows, unconfirmed: rows.filter(r => !r.weeks_confirmed).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /claim-periods/:id — set the weeks Ealing publish for that month ──────
router.put('/claim-periods/:id', managerOnly, async (req, res) => {
  const weeks = Number(req.body && req.body.weeks);
  if (!Number.isFinite(weeks) || weeks < 0 || weeks > 10) {
    return res.status(400).json({ error: 'weeks must be a number between 0 and 10' });
  }
  try {
    const { rows } = await getPool().query(
      `UPDATE funding_claim_periods
          SET weeks = $2, weeks_confirmed = true,
              notes = COALESCE($3, 'Confirmed against Ealing''s payment timetable.'),
              updated_at = now()
        WHERE id = $1 RETURNING id, period_label, weeks, weeks_confirmed`,
      [parseInt(req.params.id, 10) || 0, weeks, (req.body && req.body.notes) || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, period: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /terms/:id/children ────────────────────────────────────────────────
router.get('/terms/:id/children', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [term] } = await db.query('SELECT * FROM funding_terms WHERE id=$1', [req.params.id]);
    if (!term) return res.status(404).json({ error: 'Term not found' });

    const { rows } = await db.query(`
      SELECT
        c.id, c.first_name, c.last_name,
        c.first_name || ' ' || c.last_name as full_name,
        c.date_of_birth, c.room_id,
        r.name as room_name,
        EXTRACT(YEAR FROM AGE(c.date_of_birth))::int * 12 +
          EXTRACT(MONTH FROM AGE(c.date_of_birth))::int as age_months,
        COALESCE(cf.id, NULL) as allocation_id,
        COALESCE(cf.funding_type, 'none') as funding_type,
        COALESCE(cf.stretched_funding, false) as stretched_funding,
        COALESCE(cf.declaration_signed, false) as declaration_signed,
        cf.declaration_signed_date,
        cf.declaration_method,
        cf.declaration_sent_at,
        COALESCE(cf.pupil_premium, false) as pupil_premium,
        cf.deprivation_weighting,
        COALESCE(cf.universal_hours_week, 0) as universal_hours_week,
        COALESCE(cf.extended_hours_week, 0) as extended_hours_week,
        COALESCE(cf.total_hours_week, 0) as total_hours_week,
        COALESCE(cf.weeks_in_term, 0) as weeks_in_term,
        COALESCE(cf.total_hours_term, 0) as total_hours_term,
        COALESCE(cf.hours_used, 0) as hours_used,
        COALESCE(cf.hours_balance, 0) as hours_balance,
        cf.thirty_hour_code,
        cf.thirty_hour_code_expiry,
        COALESCE(cf.eypp_eligible, false) as eypp_eligible,
        cf.notes,
        CASE
          WHEN cf.funding_type='universal' THEN cf.total_hours_term * $2::numeric
          WHEN cf.funding_type='extended' THEN cf.total_hours_term * $3::numeric
          WHEN cf.funding_type='2yr_disadvantaged' THEN cf.total_hours_term * $4::numeric
          WHEN cf.funding_type='under_2' THEN cf.total_hours_term * $6::numeric
          WHEN cf.funding_type='2yr_working' THEN cf.total_hours_term * $5::numeric
          ELSE 0
        END as estimated_value
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN child_funding cf ON cf.child_id = c.id AND cf.term_id = $1
      WHERE c.is_active = true
      ORDER BY c.first_name, c.last_name
    `, [
      req.params.id,
      term.rate_3yr_universal,
      term.rate_3yr_extended,
      term.rate_2yr_disadvantaged,
      term.rate_2yr_working_parents,
      term.rate_under_2                     // $6 — b: added 2026-09-23, the under-2 working-parent rate
    ]);
    res.json({ term, children: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /terms/:termId/children/:childId  (upsert allocation) ─────────────
router.post('/terms/:termId/children/:childId', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner'])) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const {
    funding_type, stretched_funding, declaration_signed, declaration_signed_date,
    declaration_method, pupil_premium, deprivation_weighting,
    universal_hours_week, extended_hours_week, weeks_in_term,
    thirty_hour_code, thirty_hour_code_expiry, eypp_eligible, notes
  } = req.body;
  try {
    const { rows } = await getPool().query(`
      INSERT INTO child_funding (
        child_id, term_id, funding_type, stretched_funding, declaration_signed,
        declaration_signed_date, declaration_method, pupil_premium, deprivation_weighting,
        universal_hours_week, extended_hours_week, weeks_in_term,
        thirty_hour_code, thirty_hour_code_expiry, eypp_eligible, notes, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
      ON CONFLICT (child_id, term_id) DO UPDATE SET
        funding_type = EXCLUDED.funding_type,
        stretched_funding = EXCLUDED.stretched_funding,
        declaration_signed = EXCLUDED.declaration_signed,
        declaration_signed_date = EXCLUDED.declaration_signed_date,
        declaration_method = EXCLUDED.declaration_method,
        pupil_premium = EXCLUDED.pupil_premium,
        deprivation_weighting = EXCLUDED.deprivation_weighting,
        universal_hours_week = EXCLUDED.universal_hours_week,
        extended_hours_week = EXCLUDED.extended_hours_week,
        weeks_in_term = EXCLUDED.weeks_in_term,
        thirty_hour_code = EXCLUDED.thirty_hour_code,
        thirty_hour_code_expiry = EXCLUDED.thirty_hour_code_expiry,
        eypp_eligible = EXCLUDED.eypp_eligible,
        notes = EXCLUDED.notes,
        updated_at = NOW()
      RETURNING *`,
      [
        req.params.childId, req.params.termId,
        funding_type || 'none', stretched_funding || false,
        declaration_signed || false, declaration_signed_date || null,
        declaration_method || null, pupil_premium || false,
        deprivation_weighting || null,
        universal_hours_week || 0, extended_hours_week || 0,
        weeks_in_term || 0,
        thirty_hour_code || null, thirty_hour_code_expiry || null,
        eypp_eligible || false, notes || null
      ]
    );
    res.json(Object.assign(_maskFundingRow(rows[0]), {
      // b535 — what this allocation has just changed. Scoped to this child.
      stale_invoices: await PRICING.staleForChild(getPool(), req.params.childId),
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /terms/:termId/bulk-allocate ──────────────────────────────────────
router.post('/terms/:termId/bulk-allocate', managerOnly, async (req, res) => {
  const { child_ids, funding_type, universal_hours_week, extended_hours_week, weeks_in_term } = req.body;
  if (!child_ids || !child_ids.length) return res.status(400).json({ error: 'child_ids required' });
  try {
    const db = getPool();
    let updated = 0;
    for (const childId of child_ids) {
      await db.query(`
        INSERT INTO child_funding (child_id, term_id, funding_type, universal_hours_week, extended_hours_week, weeks_in_term, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (child_id, term_id) DO UPDATE SET
          funding_type = EXCLUDED.funding_type,
          universal_hours_week = COALESCE(EXCLUDED.universal_hours_week, child_funding.universal_hours_week),
          extended_hours_week = COALESCE(EXCLUDED.extended_hours_week, child_funding.extended_hours_week),
          weeks_in_term = COALESCE(EXCLUDED.weeks_in_term, child_funding.weeks_in_term),
          updated_at = NOW()
      `, [childId, req.params.termId, funding_type || 'universal', universal_hours_week || 0, extended_hours_week || 0, weeks_in_term || 0]);
      updated++;
    }
    res.json({ updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /terms/:termId/recalculate-hours ──────────────────────────────────
router.post('/terms/:termId/recalculate-hours', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [term] } = await db.query('SELECT * FROM funding_terms WHERE id=$1', [req.params.termId]);
    if (!term) return res.status(404).json({ error: 'Term not found' });
    // Calculate hours from sign_in/sign_out times during term period
    const { rows } = await db.query(`
      SELECT
        a.child_id,
        COALESCE(SUM(
          EXTRACT(EPOCH FROM (a.sign_out_time - a.sign_in_time)) / 3600.0
        ), 0) as hours_attended
      FROM attendance a
      WHERE a.date >= $1 AND a.date <= $2
        AND a.absent = false
        AND a.sign_in_time IS NOT NULL
        AND a.sign_out_time IS NOT NULL
      GROUP BY a.child_id
    `, [term.start_date, term.end_date]);
    let updated = 0;
    for (const r of rows) {
      const res2 = await db.query(
        `UPDATE child_funding SET hours_used=$1, updated_at=NOW()
         WHERE child_id=$2 AND term_id=$3`,
        [parseFloat(r.hours_attended).toFixed(2), r.child_id, req.params.termId]
      );
      if (res2.rowCount > 0) updated++;
    }
    res.json({ updated, children_with_attendance: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /terms/:termId/summary ─────────────────────────────────────────────
router.get('/terms/:termId/summary', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [term] } = await db.query('SELECT * FROM funding_terms WHERE id=$1', [req.params.termId]);
    if (!term) return res.status(404).json({ error: 'Term not found' });

    const { rows: byType } = await db.query(`
      SELECT
        cf.funding_type,
        COUNT(*) as count,
        COALESCE(SUM(cf.total_hours_term), 0) as total_hours,
        COALESCE(SUM(
          CASE
            WHEN cf.funding_type='universal' THEN cf.total_hours_term * $2::numeric
            WHEN cf.funding_type='extended' THEN cf.total_hours_term * $3::numeric
            WHEN cf.funding_type='2yr_disadvantaged' THEN cf.total_hours_term * $4::numeric
            WHEN cf.funding_type='under_2' THEN cf.total_hours_term * $6::numeric
          WHEN cf.funding_type='2yr_working' THEN cf.total_hours_term * $5::numeric
            ELSE 0
          END
        ), 0) as total_value
      FROM child_funding cf
      LEFT JOIN children c ON c.id = cf.child_id
      WHERE cf.term_id=$1 AND cf.funding_type != 'none' AND COALESCE(c.is_demo, false) = false
      GROUP BY cf.funding_type
    `, [term.id, term.rate_3yr_universal, term.rate_3yr_extended, term.rate_2yr_disadvantaged, term.rate_2yr_working_parents, term.rate_under_2]);

    const { rows: [totals] } = await db.query(`
      SELECT
        COUNT(*) as total_children,
        COALESCE(SUM(cf.total_hours_term), 0) as total_hours,
        COALESCE(SUM(
          CASE
            WHEN cf.funding_type='universal' THEN cf.total_hours_term * $2::numeric
            WHEN cf.funding_type='extended' THEN cf.total_hours_term * $3::numeric
            WHEN cf.funding_type='2yr_disadvantaged' THEN cf.total_hours_term * $4::numeric
            WHEN cf.funding_type='under_2' THEN cf.total_hours_term * $6::numeric
          WHEN cf.funding_type='2yr_working' THEN cf.total_hours_term * $5::numeric
            ELSE 0
          END
        ), 0) as total_value,
        COUNT(*) FILTER (WHERE NOT cf.declaration_signed) as declarations_outstanding
      FROM child_funding cf
      LEFT JOIN children c ON c.id = cf.child_id
      WHERE cf.term_id=$1 AND cf.funding_type != 'none' AND COALESCE(c.is_demo, false) = false
    `, [term.id, term.rate_3yr_universal, term.rate_3yr_extended, term.rate_2yr_disadvantaged, term.rate_2yr_working_parents, term.rate_under_2]);

    const { rows: expiringCodes } = await db.query(`
      SELECT c.first_name||' '||c.last_name as child_name, cf.thirty_hour_code, cf.thirty_hour_code_expiry
      FROM child_funding cf
      JOIN children c ON c.id=cf.child_id
      WHERE cf.term_id=$1 AND cf.thirty_hour_code_expiry IS NOT NULL
        AND cf.thirty_hour_code_expiry <= $2
        AND COALESCE(c.is_demo, false) = false
      ORDER BY cf.thirty_hour_code_expiry
    `, [term.id, term.end_date]);

    const { rows: submissions } = await db.query(`
      SELECT fs.*, s.first_name||' '||s.last_name as submitted_by_name
      FROM funding_submissions fs
      LEFT JOIN staff s ON s.id=fs.submitted_by
      WHERE fs.term_id=$1 ORDER BY fs.created_at DESC
    `, [term.id]);

    const byTypeMap = {};
    for (const r of byType) byTypeMap[r.funding_type] = r;

    res.json({
      term,
      by_type: byTypeMap,
      totals,
      codes_expiring_this_term: expiringCodes,
      submissions
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /terms/:termId/export (CSV) ───────────────────────────────────────
// 2026-09-23 — Ealing claim MONTHLY, not per term. Their own portal export carries
// claimPeriodStartDate/claimPeriodEndDate alongside the block dates, one claim per month.
// Wren was exporting the whole term's weeks, so every monthly claim was roughly four times
// what it should have been. Pass ?claim_period=<id> (or ?year=&month=) and the export prices
// that month using the weeks Ealing publish for it; with none it behaves as it always did.
router.get('/terms/:termId/export', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [term] } = await db.query('SELECT * FROM funding_terms WHERE id=$1', [req.params.termId]);
    if (!term) return res.status(404).json({ error: 'Term not found' });

    let period = null;
    if (req.query.claim_period) {
      const { rows } = await db.query(
        `SELECT * FROM funding_claim_periods WHERE id=$1 AND term_id=$2`, [parseInt(req.query.claim_period,10)||0, term.id]);
      period = rows[0] || null;
    } else if (req.query.year && req.query.month) {
      const { rows } = await db.query(
        `SELECT * FROM funding_claim_periods WHERE term_id=$1 AND period_year=$2 AND period_month=$3`,
        [term.id, parseInt(req.query.year,10)||0, parseInt(req.query.month,10)||0]);
      period = rows[0] || null;
    }

    const { rows } = await db.query(`
      SELECT
        c.first_name||' '||c.last_name as child_name,
        TO_CHAR(c.date_of_birth, 'DD/MM/YYYY') as dob,
        cf.funding_type, cf.universal_hours_week, cf.extended_hours_week,
        cf.total_hours_week, cf.weeks_in_term, cf.total_hours_term,
        CASE
          WHEN cf.funding_type='universal' THEN $2::numeric
          WHEN cf.funding_type='extended' THEN $3::numeric
          WHEN cf.funding_type='2yr_disadvantaged' THEN $4::numeric
          WHEN cf.funding_type='under_2' THEN $6::numeric
          WHEN cf.funding_type='2yr_working' THEN $5::numeric
          ELSE 0
        END as rate,
        CASE
          WHEN cf.funding_type='universal' THEN cf.total_hours_term * $2::numeric
          WHEN cf.funding_type='extended' THEN cf.total_hours_term * $3::numeric
          WHEN cf.funding_type='2yr_disadvantaged' THEN cf.total_hours_term * $4::numeric
          WHEN cf.funding_type='under_2' THEN cf.total_hours_term * $6::numeric
          WHEN cf.funding_type='2yr_working' THEN cf.total_hours_term * $5::numeric
          ELSE 0
        END as value,
        cf.declaration_signed,
        cf.pupil_premium, cf.deprivation_weighting, cf.thirty_hour_code
      FROM child_funding cf
      JOIN children c ON c.id = cf.child_id
      WHERE cf.term_id=$1 AND cf.funding_type != 'none' AND COALESCE(c.is_demo, false) = false
      ORDER BY c.first_name, c.last_name
    `, [term.id, term.rate_3yr_universal, term.rate_3yr_extended, term.rate_2yr_disadvantaged, term.rate_2yr_working_parents, term.rate_under_2]);

    // With a claim period the weeks, the hours and the value are all that MONTH's, which is what
    // Ealing's portal takes. The per-week hours are untouched — Toby: "it's 10.96 and 21.92".
    const header = 'Child Name,DOB,Funding Type,UE Hrs/Wk,EE Hrs/Wk,Total/Wk,Weeks,Total Hours,Rate (£/hr),Value (£),Declaration Signed,Pupil Premium,Deprivation Band,30hr Code,Claim Period\r\n';
    const periodLabel = period ? period.period_label : 'Whole term';
    const csvRows = rows.map(r => {
      const weeks = period ? Number(period.weeks) : Number(r.weeks_in_term || 0);
      const hours = period ? (Number(r.total_hours_week || 0) * weeks) : Number(r.total_hours_term || 0);
      const rate  = parseFloat(r.rate || 0);
      const value = period ? (hours * rate) : parseFloat(r.value || 0);
      return [
      `"${r.child_name}"`, r.dob,
      r.funding_type, r.universal_hours_week, r.extended_hours_week,
      r.total_hours_week, weeks.toFixed(2), hours.toFixed(2),
      rate.toFixed(4),
      value.toFixed(2),
      r.declaration_signed ? 'Yes' : 'No',
      r.pupil_premium ? 'Yes' : 'No',
      r.deprivation_weighting || '',
      r.thirty_hour_code || '',
      `"${periodLabel}"`
    ].join(','); }).join('\r\n');

    res.setHeader('Content-Type', 'text/csv');
    // 2026-09-23 — the term name is written by a human and Autumn 2026's contains an EN DASH
    // ("Funding: Autumn 2026 (1 Sep – 31 Dec)"). A non-ASCII byte in a header value makes Node
    // throw, so this download answered 500 and the manager could not get the spreadsheet out at
    // all. Keep only characters that are legal — and safe — in a filename.
    const safeName = String(term.name || 'term')
      .normalize('NFKD').replace(/[^\x20-\x7E]/g, '-')   // en/em dashes, curly quotes, accents
      .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'term';
    const periodPart = period
      ? '-' + String(period.period_label).replace(/[^A-Za-z0-9]+/g, '-')
      : '';
    res.setHeader('Content-Disposition', `attachment; filename="funding-${safeName}${periodPart}-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(header + csvRows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /child/:childId — all funding allocations for one child (for child profile) ──
// Additive: used by the child-profile Funding section. Joins the term so the UI can
// show term name/dates alongside each allocation. Edit via the existing upsert POST
// /terms/:termId/children/:childId.
router.get('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT cf.*, ft.name AS term_name, ft.start_date AS term_start,
             ft.end_date AS term_end, ft.is_current AS term_is_current
      FROM child_funding cf
      JOIN funding_terms ft ON ft.id = cf.term_id
      WHERE cf.child_id = $1
      ORDER BY ft.start_date DESC`, [req.params.childId]);
    // Also return terms so the UI can offer to add an allocation for a term with none.
    const { rows: terms } = await db.query(
      'SELECT id, name, start_date, end_date, is_current FROM funding_terms WHERE NOT is_archived ORDER BY start_date DESC');
    // Child-level billing mode (stretched over N weeks vs term-time actuals).
    const { rows: crow } = await db.query(
      'SELECT funding_billing_mode, stretch_weeks FROM children WHERE id=$1', [req.params.childId]);
    const child = crow[0] || {};
    res.json({ allocations: rows.map(_maskFundingRow), terms,
      funding_billing_mode: child.funding_billing_mode || 'term_time',
      stretch_weeks: child.stretch_weeks || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /:id/carer-ni-reveal — manager+: the full carer NI number, audited ──
// b491 (2026-10-12). The only place the real value now leaves the server for a
// browser. Never reachable by practitioner/apprentice (denied at the top of this
// router) or accountant (src/lib/accountant-gate.js's allowlist excludes this
// path entirely — see release CHECK.md finding F2, the same reasoning).
router.get('/:id/carer-ni-reveal', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT id, child_id, carer_ni_number FROM child_funding WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    recordAudit({
      req, action: 'view', entity_type: 'child_funding', entity_id: rows[0].id,
      meta: { field: 'carer_ni_number', child_id: rows[0].child_id, action_detail: 'carer_ni_reveal' },
    });
    res.json({ id: rows[0].id, carer_ni_number: rows[0].carer_ni_number || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /declarations/:childFundingId/send ────────────────────────────────
router.post('/declarations/:childFundingId/send', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const token = crypto.randomUUID();
    const { rows: [cf] } = await db.query(
      `UPDATE child_funding SET declaration_token=$1, declaration_sent_at=NOW()
       WHERE id=$2 RETURNING *, (SELECT first_name||' '||last_name FROM children WHERE id=child_id) as child_name,
       (SELECT parent_1_email FROM children WHERE id=child_id) as parent_email`,
      [token, req.params.childFundingId]
    );
    if (!cf) return res.status(404).json({ error: 'Allocation not found' });
    res.json({ ok: true, token, parent_email: cf.parent_email, child_name: cf.child_name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b298 (2026-09-10) — Settings → Funding dates
// ═══════════════════════════════════════════════════════════════════════════
// APPENDED, not rewritten. Toby: "In terms of funding dates and term dates,
// these can be options in the Settings menu … the termly dates are for the
// planning and the funding dates are for the funding in the settings."
//
// This is the read side of the Funding dates screen. It answers three questions
// the existing GET /terms could not:
//   · which rows are real periods and which are EyLog history (read-only)
//   · how many children are allocated to each, so nothing is deleted blind
//   · which period covers today, so "Allocate children" has a sensible default
//
// It deliberately says nothing about ladn.school_terms. Term dates are a
// different calendar with a different screen; the two are cross-linked in the
// UI and never derived from one another.

// ─── GET /calendar — funding periods, split into usable and historic ────────
// Mounted at /api/funding/calendar. NOT under /terms/... on purpose: the
// existing router matches GET /terms/:id before anything declared later, so a
// /terms/calendar path would be read as a term whose id is "calendar".
router.get('/calendar', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ft.*,
             (SELECT count(*)::int FROM child_funding cf WHERE cf.term_id = ft.id) AS allocation_count
        FROM funding_terms ft
       WHERE NOT ft.is_archived
       ORDER BY ft.start_date DESC, ft.id DESC`);
    const tagged = FP.tag(rows);
    const { periods, historic } = FP.classify(tagged);
    const today = new Date().toISOString().slice(0, 10);
    const covers = t => {
      const a = FP.yearOf(t.start_date) == null ? null : ymd(t.start_date);
      const b = ymd(t.end_date);
      return a && b && a <= today && today <= b;
    };
    const current = periods.find(covers) || periods.find(t => t.is_current) || null;
    res.json({
      today,
      periods,
      historic,
      current_id: current ? current.id : null,
      // Every allocation on a historic row is a row that must survive. Sent so
      // the screen can say the number out loud instead of implying "unused".
      historic_allocations: historic.reduce((n, t) => n + (t.allocation_count || 0), 0),
      total_allocations: tagged.reduce((n, t) => n + (t.allocation_count || 0), 0),
      period_shapes: FP.PERIOD_SHAPES,
      // Where allocation actually lives, so the screen never has to hard-code it.
      allocate_href: '/funding.html?full=1&tab=allocation',
      what_this_is: 'Used for funding: entitlement hours, rates and what the council pays. '
                  + 'Funding runs continuously — 1 Sep–31 Dec, 1 Jan–31 Mar, 1 Apr–31 Aug.',
      not_this: 'These are NOT the teaching half-terms. Planning runs on Settings → Term dates.',
      term_dates_href: '/term-dates.html',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /calendar/generate — the three funding periods for a year ─────────
// b299. A fresh edition (htps, childrenscorner) opens Settings → Funding dates
// with nothing on it. Funding does not run on half-terms — it runs continuously
// as 1 Sep–31 Dec, 1 Jan–31 Mar, 1 Apr–31 Aug — and those three shapes are the
// same for every English setting, so there is no reason to make anyone type them.
//
// It creates the periods and NOTHING ELSE. Every rate is left at zero: rates are
// set by the local authority, they differ between authorities and between years,
// and a rate Wren invented would quietly under- or over-claim real money. The
// response says so.
//
// Refuses a year that already has periods, for the same reason the term
// generator does.
//
// Body: { year: 2026 }  — the September the funding year starts in.
router.post('/calendar/generate', managerOnly, async (req, res) => {
  const year = parseInt((req.body || {}).year, 10);
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: 'year must be the four-digit September the funding year starts in' });
  }

  // Autumn sits in `year`; Spring and Summer fall in the calendar year after it.
  const shapes = FP.PERIOD_SHAPES.map(sh => {
    const y = sh.key === 'autumn' ? year : year + 1;
    return {
      key: sh.key,
      name: `Funding: ${sh.label} ${y} (${sh.start.slice(3)}/${sh.start.slice(0, 2)} – ${sh.end.slice(3)}/${sh.end.slice(0, 2)})`,
      start_date: `${y}-${sh.start}`,
      end_date: `${y}-${sh.end}`,
      months: sh.months,
      year: y,
    };
  });

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const first = shapes[0].start_date, last = shapes[shapes.length - 1].end_date;
    const { rows: clash } = await client.query(
      `SELECT count(*)::int AS n FROM funding_terms
        WHERE start_date <= $2::date AND end_date >= $1::date
          AND start_date > DATE '1971-01-01'`, [first, last]);
    if (clash[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `${clash[0].n} funding period(s) already cover ${first} to ${last}. `
             + 'Edit those rather than generating over them.',
        code: 'periods_exist',
      });
    }

    const created = [];
    for (const sh of shapes) {
      const { rows } = await client.query(
        `INSERT INTO funding_terms (name, year, start_date, end_date, term_months, colour, source)
         VALUES ($1,$2,$3::date,$4::date,$5,$6,$7)
         RETURNING id, name, start_date, end_date`,
        [sh.name, sh.year, sh.start_date, sh.end_date, sh.months, '#4a9abf',   // year is INTEGER
         `generated ${new Date().toISOString().slice(0, 10)}`]);
      created.push(rows[0]);
    }
    await client.query('COMMIT');

    res.json({
      ok: true,
      created,
      note: 'Every funding RATE on these periods is zero. Rates come from your local '
          + 'authority and change each April — set them on each period before you claim. '
          + 'Wren does not guess them.',
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// pg hands back DATE as a local-midnight JS Date; toISOString() would shift it
// a day in BST. Read the local getters.
function ymd(d) {
  if (d == null) return null;
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}


// ── GET /child/:childId/summary — accounts-20261028 ────────────────────────────
// Toby: "the funding page separately which shows the term, the hours they've used, the
// rates, the declaration form". One child, the current funding term, month by month, with
// the SAME arithmetic Ealing pays on (src/lib/funding-expected.js costPeriod: Ealing's claim
// weeks, the rate for the child's band, starters/leavers pro rata). Read-only.
router.get('/child/:childId/summary', async (req, res) => {
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'bad child id' });
  const FE = require('../lib/funding-expected');
  const ymdx = (v) => { if (!v) return null; if (v instanceof Date) { const q = (n) => String(n).padStart(2, '0'); return `${v.getFullYear()}-${q(v.getMonth() + 1)}-${q(v.getDate())}`; } return String(v).slice(0, 10); };
  try {
    const db = getPool();
    const { rows: [cf] } = await db.query(`
      SELECT cf.*, t.id AS t_id, t.name AS term_name, t.start_date AS term_start, t.end_date AS term_end,
             t.rate_under_2, t.rate_2yr_working_parents, t.rate_2yr_disadvantaged, t.rate_3yr_universal, t.rate_3yr_extended,
             c.date_of_birth AS dob, c.start_date, c.leave_date
        FROM child_funding cf JOIN funding_terms t ON t.id = cf.term_id JOIN children c ON c.id = cf.child_id
       WHERE cf.child_id = $1
       ORDER BY t.is_current DESC, t.start_date DESC LIMIT 1`, [childId]);
    if (!cf) return res.json({ funded: false });
    const { hours, source } = FE.hoursPerWeek(cf);
    const [{ rows: periods }, { rows: rateRows }, { rows: termRows }, decl] = await Promise.all([
      db.query(`SELECT * FROM funding_claim_periods WHERE term_id = $1 ORDER BY claim_start`, [cf.t_id]),
      db.query('SELECT age_band, funding_year, pence_per_hour FROM funding_rates'),
      db.query(`SELECT start_date::text AS start, end_date::text AS end FROM school_terms`).catch(() => ({ rows: [] })),
      db.query(`SELECT id, status, signed_at, term_id FROM funding_declarations WHERE child_id = $1
                 ORDER BY (status = 'signed') DESC, created_at DESC LIMIT 1`, [childId]).catch(() => ({ rows: [] })),
    ]);
    const rates = new Map(rateRows.map((r) => [`${r.age_band}|${r.funding_year}`, r.pence_per_hour]));
    const today = ymdx(new Date());
    const row = { child_id: childId, dob: cf.dob, funding_type: cf.funding_type, funded_hours_week: cf.funded_hours_week,
                  total_hours_week: cf.total_hours_week, stretched_funding: cf.stretched_funding, start_date: cf.start_date, leave_date: cf.leave_date };
    const months = periods.map((p) => {
      const period = Object.assign({}, p, { claim_start: ymdx(p.claim_start), claim_end: ymdx(p.claim_end) });
      const c = FE.costPeriod([row], period, rates, cf, termRows);
      const b = c.bands[0] || {};
      return { label: p.period_label, claim_start: period.claim_start, claim_end: period.claim_end, weeks: c.weeks,
               weeks_confirmed: c.weeks_confirmed, hours_week: b.hours_week || 0, hours: b.hours_claim || 0,
               pence_per_hour: b.pence_per_hour || null, expected_pence: c.expected_pence,
               done: !!period.claim_end && period.claim_end < today };
    });
    const sum = (k, f) => months.filter(f || (() => true)).reduce((n, m) => n + (Number(m[k]) || 0), 0);
    res.json({
      funded: cf.funding_type !== 'none' && hours > 0,
      term: { id: cf.t_id, name: cf.term_name, start: ymdx(cf.term_start), end: ymdx(cf.term_end) },
      funding_type: cf.funding_type, hours_week: hours, hours_source: source,
      stretched: !!cf.stretched_funding,
      months,
      hours_term: Math.round(sum('hours') * 100) / 100,
      hours_used_so_far: Math.round(sum('hours', (m) => m.done) * 100) / 100,
      expected_term_pence: sum('expected_pence'),
      declaration: decl.rows[0] || null,
      // A declaration recorded on the allocation itself (paper, or ticked by the office).
      declaration_recorded: cf.declaration_signed
        ? { signed: true, date: ymdx(cf.declaration_signed_date), method: cf.declaration_method || null } : null,
    });
  } catch (e) {
    console.error('[funding] child summary:', e.message);
    res.status(500).json({ error: 'Could not load the funding summary' });
  }
});

module.exports = router;
