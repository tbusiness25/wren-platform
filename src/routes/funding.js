const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const crypto = require('crypto');

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

    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (botToken && chatId) {
        const msg = encodeURIComponent(`✅ ${cf.child_name} funding declaration signed by parent`);
        require('https').get(`https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${msg}`);
      }
    } catch (_) {}

    res.json({ ok: true, child_name: cf.child_name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.use(authenticate);

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
    const { rows: terms } = await db.query('SELECT * FROM funding_terms ORDER BY start_date DESC');
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
      children = rows;
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
      'SELECT * FROM funding_terms ORDER BY start_date DESC'
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
            WHEN cf.funding_type='2yr_working' THEN cf.total_hours_term * ft.rate_2yr_working_parents
            ELSE 0
          END
        ), 0) as estimated_value
      FROM child_funding cf
      JOIN funding_terms ft ON ft.id = cf.term_id
      WHERE cf.term_id = $1
    `, [termId]);
    const { rows: [enrolled] } = await db.query(
      'SELECT COUNT(*) as cnt FROM children WHERE is_active=true'
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
    await db.query('UPDATE funding_terms SET is_current=false');
    const { rows } = await db.query(
      'UPDATE funding_terms SET is_current=true WHERE id=$1 RETURNING *', [req.params.id]
    );
    res.json(rows[0]);
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
          WHEN cf.funding_type='2yr_working' THEN cf.total_hours_term * $5::numeric
          ELSE 0
        END as estimated_value
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN child_funding cf ON cf.child_id = c.id AND cf.term_id = $1
      WHERE c.is_active = true
      ORDER BY c.last_name, c.first_name
    `, [
      req.params.id,
      term.rate_3yr_universal,
      term.rate_3yr_extended,
      term.rate_2yr_disadvantaged,
      term.rate_2yr_working_parents
    ]);
    res.json({ term, children: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /terms/:termId/children/:childId  (upsert allocation) ─────────────
router.post('/terms/:termId/children/:childId', async (req, res) => {
  if (!['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role)) {
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
    res.json(rows[0]);
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
            WHEN cf.funding_type='2yr_working' THEN cf.total_hours_term * $5::numeric
            ELSE 0
          END
        ), 0) as total_value
      FROM child_funding cf
      WHERE cf.term_id=$1 AND cf.funding_type != 'none'
      GROUP BY cf.funding_type
    `, [term.id, term.rate_3yr_universal, term.rate_3yr_extended, term.rate_2yr_disadvantaged, term.rate_2yr_working_parents]);

    const { rows: [totals] } = await db.query(`
      SELECT
        COUNT(*) as total_children,
        COALESCE(SUM(cf.total_hours_term), 0) as total_hours,
        COALESCE(SUM(
          CASE
            WHEN cf.funding_type='universal' THEN cf.total_hours_term * $2::numeric
            WHEN cf.funding_type='extended' THEN cf.total_hours_term * $3::numeric
            WHEN cf.funding_type='2yr_disadvantaged' THEN cf.total_hours_term * $4::numeric
            WHEN cf.funding_type='2yr_working' THEN cf.total_hours_term * $5::numeric
            ELSE 0
          END
        ), 0) as total_value,
        COUNT(*) FILTER (WHERE NOT cf.declaration_signed) as declarations_outstanding
      FROM child_funding cf
      WHERE cf.term_id=$1 AND cf.funding_type != 'none'
    `, [term.id, term.rate_3yr_universal, term.rate_3yr_extended, term.rate_2yr_disadvantaged, term.rate_2yr_working_parents]);

    const { rows: expiringCodes } = await db.query(`
      SELECT c.first_name||' '||c.last_name as child_name, cf.thirty_hour_code, cf.thirty_hour_code_expiry
      FROM child_funding cf
      JOIN children c ON c.id=cf.child_id
      WHERE cf.term_id=$1 AND cf.thirty_hour_code_expiry IS NOT NULL
        AND cf.thirty_hour_code_expiry <= $2
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
router.get('/terms/:termId/export', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [term] } = await db.query('SELECT * FROM funding_terms WHERE id=$1', [req.params.termId]);
    if (!term) return res.status(404).json({ error: 'Term not found' });

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
          WHEN cf.funding_type='2yr_working' THEN $5::numeric
          ELSE 0
        END as rate,
        CASE
          WHEN cf.funding_type='universal' THEN cf.total_hours_term * $2::numeric
          WHEN cf.funding_type='extended' THEN cf.total_hours_term * $3::numeric
          WHEN cf.funding_type='2yr_disadvantaged' THEN cf.total_hours_term * $4::numeric
          WHEN cf.funding_type='2yr_working' THEN cf.total_hours_term * $5::numeric
          ELSE 0
        END as value,
        cf.declaration_signed,
        cf.pupil_premium, cf.deprivation_weighting, cf.thirty_hour_code
      FROM child_funding cf
      JOIN children c ON c.id = cf.child_id
      WHERE cf.term_id=$1 AND cf.funding_type != 'none'
      ORDER BY c.last_name, c.first_name
    `, [term.id, term.rate_3yr_universal, term.rate_3yr_extended, term.rate_2yr_disadvantaged, term.rate_2yr_working_parents]);

    const header = 'Child Name,DOB,Funding Type,UE Hrs/Wk,EE Hrs/Wk,Total/Wk,Weeks,Total Hours,Rate (£/hr),Value (£),Declaration Signed,Pupil Premium,Deprivation Band,30hr Code\r\n';
    const csvRows = rows.map(r => [
      `"${r.child_name}"`, r.dob,
      r.funding_type, r.universal_hours_week, r.extended_hours_week,
      r.total_hours_week, r.weeks_in_term, r.total_hours_term,
      parseFloat(r.rate||0).toFixed(4),
      parseFloat(r.value||0).toFixed(2),
      r.declaration_signed ? 'Yes' : 'No',
      r.pupil_premium ? 'Yes' : 'No',
      r.deprivation_weighting || '',
      r.thirty_hour_code || ''
    ].join(',')).join('\r\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="funding-${term.name.replace(/\s/g,'-')}-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(header + csvRows);
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

module.exports = router;
