'use strict';

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const crypto = require('crypto');
const ai = require('../lib/ai-models');
const closures = require('../lib/closures');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// ── Auth middleware ────────────────────────────────────────────────────────────
// Accept EITHER a valid Wren JWT (admin UI) OR the per-school extension API token (browser extension,
// stored in settings.extension_api_token). The extension sends it as `Authorization: Bearer <token>`.
async function extensionOrAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-wren-token'] || '');
  if (token) {
    try {
      const { rows: [s] } = await getPool().query(
        "SELECT value FROM settings WHERE key='extension_api_token' LIMIT 1");
      if (s && s.value && token === s.value) {
        req.user = { id: 1, role: 'manager', via: 'funding-extension' };
        return next();
      }
    } catch (_) { /* settings unavailable — fall through to JWT auth */ }
  }
  return authenticate(req, res, next);
}
router.use(extensionOrAuth);
// req.user is already set by extensionOrAuth, so managerOnly is just the role gate (no second authenticate).
function managerOnly(req, res, next) {
  if (req.user && hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// ── GET /api/funding-portal/template-for-url ──────────────────────────────────
// Called by browser extension with the current portal URL; returns matching template or null
router.get('/template-for-url', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM funding_portal_templates ORDER BY is_public DESC, test_count DESC'
    );
    const match = rows.find(t => {
      try { return new RegExp(t.portal_url_pattern, 'i').test(url); }
      catch (_) { return false; }
    });
    if (!match) return res.json(null);
    res.json({ template: match, version: match.version, last_updated: match.updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/terms ─────────────────────────────────────────────
// Funding terms for the extension's term selector (kept under this router so the extension token works).
router.get('/terms', managerOnly, async (req, res) => {
  try {
    // 2026-10-12: was ORDER BY id DESC with the newest row marked current — that preselected the archived
    // duplicate "Autumn 2026" (id 90) instead of the real current term. Use the term's own flags.
    // 2026-10-13: + start_date/end_date (YYYY-MM-DD) so the extension can offer the term's months.
    const { rows } = await getPool().query(
      `SELECT id, name, is_current,
              to_char(start_date, 'YYYY-MM-DD') AS start_ymd, to_char(end_date, 'YYYY-MM-DD') AS end_ymd
         FROM funding_terms
        WHERE NOT COALESCE(is_archived, false)
        ORDER BY start_date DESC NULLS LAST, id DESC`);
    const anyCurrent = rows.some(t => t.is_current);
    // 2026-10-20: + Ealing's timetable weeks per claim month (funding_claim_periods), so the extension's
    // "Weeks in claim" box fills itself when a month is picked (October 2026 is 3 weeks, not the default 4).
    const { rows: periods } = await getPool().query(
      `SELECT term_id, period_year, period_month, weeks, weeks_confirmed FROM funding_claim_periods
        WHERE weeks IS NOT NULL`).catch(() => ({ rows: [] }));
    const weeksByTerm = new Map();
    for (const p of periods) {
      const ym = p.period_year + '-' + String(p.period_month).padStart(2, '0');
      if (!weeksByTerm.has(p.term_id)) weeksByTerm.set(p.term_id, {});
      weeksByTerm.get(p.term_id)[ym] = { weeks: Number(p.weeks), confirmed: !!p.weeks_confirmed };
    }
    res.json(rows.map((t, i) => ({ id: t.id, name: t.name, is_current: anyCurrent ? !!t.is_current : i === 0,
      start_date: t.start_ymd, end_date: t.end_ymd, month_weeks: weeksByTerm.get(t.id) || {} })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/data-for-submission ────────────────────────────────
// Returns children + parent data needed for auto-fill
router.get('/data-for-submission', managerOnly, async (req, res) => {
  const { la_code, term_id, child_ids } = req.query;
  if (!la_code) return res.status(400).json({ error: 'la_code required' });
  if (!term_id) return res.status(400).json({ error: 'term_id required' });

  try {
    const db = getPool();

    // Resolve child IDs: either explicit list or all funded children for the term
    let childIdList = [];
    const fundingOffLeavers = new Set();
    if (child_ids) {
      childIdList = child_ids.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      // b484 (2026-10-12): the default (no explicit child_ids) path is the automatic one —
      // "every funded child this term" — and that must never include a demo child in a real
      // LA funding claim. An explicit child_ids list is a deliberate, by-hand choice and is
      // left alone (so a demo child can still be included on purpose for testing).
      const { rows: funded } = await db.query(
        `SELECT cf.child_id FROM child_funding cf
          LEFT JOIN children c ON c.id = cf.child_id
         WHERE cf.term_id=$1 AND cf.funding_type != 'none' AND COALESCE(c.is_demo, false) = false`,
        [term_id]
      );
      childIdList = funded.map(r => r.child_id);
      // 2026-10-23: a leaver whose funding for this term was then switched to 'none' (109 and 113, 22 Oct) fell out
      // of the query above, so they never reached `excluded` — and the one-click run needs them there to offer to
      // undo what was already entered for them on the portal. They're fetched only to be reported as excluded below.
      const { rows: offLeavers } = await db.query(
        `SELECT cf.child_id FROM child_funding cf
           JOIN children c ON c.id = cf.child_id
           JOIN funding_terms t ON t.id = cf.term_id
          WHERE cf.term_id=$1 AND cf.funding_type = 'none' AND COALESCE(c.is_demo, false) = false
            AND c.leave_date IS NOT NULL AND c.leave_date >= t.start_date`,
        [term_id]
      ).catch(() => ({ rows: [] }));
      for (const r of offLeavers) { fundingOffLeavers.add(Number(r.child_id)); childIdList.push(r.child_id); }
    }

    if (!childIdList.length) return res.json({ children: [], term: null, la: null });

    // Fetch term info
    const { rows: [term] } = await db.query(
      'SELECT * FROM funding_terms WHERE id=$1', [term_id]
    );

    // Fetch LA template info
    const { rows: [la] } = await db.query(
      'SELECT la_code, la_name, engine FROM funding_portal_templates WHERE la_code=$1', [la_code]
    );

    // Fetch children + funding allocation + parent data
    const placeholders = childIdList.map((_, i) => `$${i + 2}`).join(',');
    const { rows: children } = await db.query(`
      SELECT
        c.id,
        c.first_name,
        c.last_name,
        TO_CHAR(c.date_of_birth, 'DD/MM/YYYY') as dob,
        TO_CHAR(c.date_of_birth, 'YYYY-MM-DD') as dob_iso,
        TO_CHAR(c.leave_date, 'YYYY-MM-DD') as leave_iso,
        c.gender,
        c.ethnicity,
        c.upn,
        c.address_line1 AS address_line_1,
        c.address_line2 AS address_line_2,   -- addresses-20261023: were hard-coded NULL; columns added by the 2026-10-23 migration
        c.town AS city,
        c.postcode,
        c.parent_1_name,
        c.parent_1_name AS parent_1_first_name,
        NULL::text AS parent_1_last_name,
        c.parent_1_email,
        c.parent_1_phone,
        NULL::text AS parent_1_ni_number,
        c.parent_2_name,
        c.parent_2_name AS parent_2_first_name,
        NULL::text AS parent_2_last_name,
        c.parent_2_email,
        c.parent_2_phone,
        NULL::text AS parent_2_ni_number,
        r.name as room_name,
        cf.funding_type,
        cf.universal_hours_week,
        cf.extended_hours_week,
        cf.total_hours_week,
        cf.weeks_in_term,
        cf.total_hours_term,
        cf.thirty_hour_code,
        cf.carer_ni_number,
        TO_CHAR(cf.carer_dob, 'YYYY-MM-DD') AS carer_dob,
        TO_CHAR(cf.thirty_hour_code_expiry, 'DD/MM/YYYY') as thirty_hour_code_expiry,
        cf.stretched_funding,
        cf.declaration_signed,
        cf.pupil_premium,
        cf.eypp_eligible,
        cf.deprivation_weighting,
        bk.d AS booked_days, bk.mon AS att_mon, bk.tue AS att_tue,
        bk.wed AS att_wed, bk.thu AS att_thu, bk.fri AS att_fri
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN child_funding cf ON cf.child_id = c.id AND cf.term_id = $1
      LEFT JOIN LATERAL (
        SELECT b.mon, b.tue, b.wed, b.thu, b.fri,
               (b.mon::int + b.tue::int + b.wed::int + b.thu::int + b.fri::int) AS d
        FROM child_bookings b WHERE b.child_id = c.id AND b.is_active LIMIT 1
      ) bk ON true
      WHERE c.id IN (${placeholders})
      ORDER BY c.first_name, c.last_name
    `, [term_id, ...childIdList]);

    // 2026-10-13 (Toby): Parent/Carer 1's NI number and date of birth for Ealing's carer tab. Both come from
    // the family's latest SIGNED parental declaration (the claimed term's first, else their most recent —
    // neither changes term to term); the NI falls back to the allocation's carer_ni_number, which the office
    // types in Roost (and a declaration copies into when it is empty). parent_1_ni_number was hard-coded
    // NULL above and there was no parent DOB at all, so the extension never had either to type.
    const declByChild = new Map();
    try {
      const { rows: decl } = await db.query(
        `SELECT DISTINCT ON (child_id) child_id, payload->'parent' AS parent, payload->'partner' AS partner
           FROM funding_declarations
          WHERE child_id = ANY($1::int[]) AND status = 'signed'
          ORDER BY child_id, (term_id = $2::int) DESC, signed_at DESC`,
        [childIdList.map(Number).filter(Number.isInteger), parseInt(term_id, 10)]);
      for (const d of decl) declByChild.set(Number(d.child_id), d);
    } catch (e) { console.error('[funding-portal] declarations lookup failed:', e.message); }
    // parentdetails-20261023: + the PARENT RECORD (contact_identity, typed in Roost → Family → Parental details) between the
    // declaration and the allocation — one resolver, src/lib/carer-identity.js, which the Missing-details engine also uses.
    // Order per field: signed declaration → parent record → child_funding. The raw chain below stays as the last resort so a
    // stored value the resolver's stricter check rejects still reaches the portal exactly as it did before.
    let identity = new Map();
    try { identity = await require('../lib/carer-identity').resolve(db, childIdList, { termId: term_id }); }
    catch (e) { console.error('[funding-portal] parent record lookup failed:', e.message); }
    const niOf = v => { const s = String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase(); return s || null; };
    const dmyOf = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v == null ? '' : v).trim()); return m ? `${m[3]}/${m[2]}/${m[1]}` : null; };

    // ── Portal-value derivation (2026-07-15, Toby) ─────────────────────────────
    // Fill the Ealing FIS headcount with the CORRECT per-week claim, derived not read (the
    // stored raw hours were the stretched figure with a wrong age-split). Steps per child:
    //  1. Term-time weekly entitlement from funding_type: 30h working/extended, 15h universal/
    //     2yr-disadvantaged.
    //  2. Attendance cap — a part-timer can't claim more than they attend: max = booked_days × 10h.
    //     (2 days ⇒ 20h cap, even on a 30h entitlement.)
    //  3. Age split of the capped term-time hours: UNDER 3 = all extended (0 universal);
    //     3+ = up to 15 universal, remainder extended.
    //  4. Stretched funding (LADN spreads the 38 funded weeks over 52): if stretched, multiply
    //     the per-week hours by 38/52 and set funded-entitlement-weeks = 52 (else 38).
    // The portal's Std/Ext "hours per week" fields want the ACTUAL WEEKLY entitlement (max 15
    // universal, 30 expanded) — NOT stretched. Stretch (attending all year) is captured by the
    // Funded Entitlement Weeks field (52 vs 38 term-time), not by shrinking the weekly hours.
    // (Earlier bug: we multiplied hours by 38/52 → 21.92; the portal capped/expected 30.)
    // Worked: 2yo 30h 5d → uni 0 / ext 30;  2yo 30h 2d → uni 0 / ext 20 (attendance cap);
    //         3yo 30h 5d → uni 15 / ext 15;  3yo universal 15h → uni 15 / ext 0.
    // WksAttendInTerm (the claim window) = ?weeks=, default 4 (2–3 in holiday months).
    const HRS_PER_DAY = 10;
    const round2 = n => Math.round(n * 100) / 100;
    const isoOfDate = d => { if (!d) return null; const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };   // local parts: pg DATE is local midnight
    let runWeeks = (req.query.weeks != null && req.query.weeks !== '')
      ? parseFloat(req.query.weeks) : 4;
    // 2026-10-20: no ?weeks= sent but the month is on Ealing's timetable → the timetable's weeks, not 4.
    if ((req.query.weeks == null || req.query.weeks === '') && /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || ''))) {
      const [py, pm] = String(req.query.month).split('-').map(Number);
      const { rows: [cp] } = await db.query(
        `SELECT weeks FROM funding_claim_periods WHERE term_id=$1 AND period_year=$2 AND period_month=$3 AND weeks_confirmed`,
        [term_id, py, pm]).catch(() => ({ rows: [] }));
      if (cp && cp.weeks != null) runWeeks = Number(cp.weeks);
    }
    const refDate = (term && term.start_date) ? new Date(term.start_date) : new Date();
    // Summer/final term ends before the summer holidays, so 3+ children (leaving for
    // school in Sept) have nothing to stretch INTO → don't tick stretch for them on the
    // summer upload. Under-3s continuing in Sept still stretch. (Toby, 2026-07-16)
    const isSummerTerm = /summer/i.test((term && term.name) || '');
    // 2026-10-13: + 'under_2' (9 months to 2, working parent — 30h since Sept 2025). It fell through to 0, so
    // the 8 under-2s on the Autumn 2026 claim would have been typed into Ealing's portal as 0 hours.
    const entitlement = ft => (ft === 'extended' || ft === '2yr_working' || ft === 'under_2') ? 30
      : (ft === 'universal' || ft === '2yr_disadvantaged') ? 15 : 0;
    for (const c of children) {
      const E = entitlement(c.funding_type);
      const days = (c.booked_days != null && c.booked_days > 0) ? Number(c.booked_days) : null;
      const capped = days ? Math.min(E, days * HRS_PER_DAY) : E;   // attendance cap (2 days ⇒ 20h)
      let ageYears = null;
      if (c.dob_iso) ageYears = (refDate - new Date(c.dob_iso)) / (365.25 * 24 * 3600 * 1000);
      // 2026-10-13: which of Ealing's Actuals age-group grids the child is in — by age at the start of the term
      // claimed (a child moves up the term after a birthday): under 2 → 9 months–2 (working parent), 2 → two year
      // olds, 3+ → three and four year olds. The extension (0.2.6) works the groups one grid at a time.
      // 2026-10-21: funding moves up from the TERM AFTER the birthday — a birthday on/after the term's first day doesn't
      // count yet (a 1 Sep 2023 birthday is a 2-year-old for Autumn 2026, not a 3-4). Exact age put her in the 3 & 4s.
      const ds = c.dob_iso ? String(c.dob_iso).slice(0, 10) : null, ts = `${refDate.getFullYear()}-${String(refDate.getMonth() + 1).padStart(2, '0')}-${String(refDate.getDate()).padStart(2, '0')}`;   // local parts: pg DATE is local midnight
      const plusY = (iso, n) => (parseInt(iso.slice(0, 4), 10) + n) + iso.slice(4, 10);
      c.portal_group = !ds ? null : plusY(ds, 3) < ts ? '3_4yo' : plusY(ds, 2) < ts ? '2yo' : '9m_2yr';
      const under3 = c.portal_group ? c.portal_group !== '3_4yo' : (ageYears != null && ageYears < 3);   // 2026-10-21: by the funding rule, not exact age
      c.universal_hours_week = round2(under3 ? 0 : Math.min(15, capped));        // actual weekly, not stretched
      c.extended_hours_week  = round2(under3 ? capped : Math.max(0, capped - 15));
      c.total_hours_week     = round2((c.universal_hours_week || 0) + (c.extended_hours_week || 0));
      c.stretched            = !!c.stretched_funding && !(isSummerTerm && !under3);
      c.funded_entitlement_weeks = c.stretched ? 52 : 38;   // the stretch lives HERE, not in the hours
      // attendance day flags (mon..fri from the register; Sat/Sun always No)
      c.attends = { mon: !!c.att_mon, tue: !!c.att_tue, wed: !!c.att_wed, thu: !!c.att_thu, fri: !!c.att_fri, sat: false, sun: false };
      if (!isNaN(runWeeks)) c.weeks_in_term = runWeeks;
      c.total_hours_term = round2((c.total_hours_week || 0) * (c.weeks_in_term || 0));
      const dp = declByChild.get(Number(c.id)) || {};
      const p1 = dp.parent || {}, p2 = dp.partner || {};
      const idn = identity.get(Number(c.id)) || { p1: {}, p2: {} };
      c.parent_1_ni_number = idn.p1.ni || niOf(p1.parent_ni) || niOf(c.carer_ni_number);
      // 2026-10-15 (Toby): no declaration this term → the parent DOB already on file (child_funding.carer_dob,
      // loaded from the council's Sept export / EyLog), so the carer tab isn't blank for every unsigned family.
      c.parent_1_dob = dmyOf(idn.p1.dob) || dmyOf(p1.parent_dob) || dmyOf(c.carer_dob);
      c.parent_2_ni_number = idn.p2.ni || niOf(p2.partner_ni);
      c.parent_2_dob = dmyOf(idn.p2.dob) || dmyOf(p2.partner_dob);
      c.parent_1_ni_from = c.parent_1_ni_number ? (idn.p1.ni_source || 'raw') : null;     // declaration | parent_record | allocation
      c.parent_1_dob_from = c.parent_1_dob ? (idn.p1.dob_source || 'raw') : null;
      delete c.carer_ni_number;
      delete c.carer_dob;
      // 2026-10-20 (Toby): Synergy's carer tab has Forename AND Surname*; Wren keeps one full name, so the whole
      // name went into Forename and Surname stayed blank. Last word = surname, the rest = forename.
      const nm = String(c.parent_1_name || '').trim().split(/\s+/).filter(Boolean);
      c.parent_1_first_name = nm.length > 1 ? nm.slice(0, -1).join(' ') : (nm[0] || null);
      c.parent_1_last_name = nm.length > 1 ? nm[nm.length - 1] : null;
      // Gender as the portal's dropdown words it (Wren stores M / F).
      const g = String(c.gender || '').trim().toUpperCase();
      c.gender_word = g === 'M' || g === 'MALE' ? 'Male' : g === 'F' || g === 'FEMALE' ? 'Female' : null;
      // Working Family steps (consent tick + Check Eligibility Code) only for a working-parent child with a code.
      c.working_family = ['extended', '2yr_working', 'under_2'].includes(c.funding_type) && !!String(c.thirty_hour_code || '').trim();
    }

    // 2026-10-22 (Toby): leavers. The feed claimed every funded child whatever their leave date, so two 3-4s who
    // left for school in September went onto the September adjustment, and a child leaving 16 Oct was claimed for
    // all 3 October weeks. Against the claimed period (?month=, else the whole term):
    //  - left before the period starts → not claimed;
    //  - a 3-4 leaving in the first month of the Autumn term → not claimed: they've gone to school, and the school
    //    claims them from September;
    //  - leaves during the claimed month → weeks capped at the weeks they were here (Mondays on or before the leave
    //    date). Never more than the month's claim weeks; a holiday week before the leave date isn't known, so a
    //    leaver straight after half term can still be one week over — check those by hand.
    // Dropped children come back in `excluded` with the reason, so the extension's run isn't silently short.
    const excluded = [];
    {
      const ymq = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? String(req.query.month) : null;
      const isoOf = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
      const termStart = term && term.start_date ? isoOf(term.start_date) : null;
      let periodStart = termStart, periodEnd = term && term.end_date ? isoOf(term.end_date) : null;
      if (ymq) {
        const [y, m] = ymq.split('-').map(Number);
        periodStart = `${ymq}-01`;
        periodEnd = `${ymq}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
      }
      const firstMonthOfAutumn = /autumn/i.test((term && term.name) || '') && termStart
        ? termStart.slice(0, 7) : null;
      const mondaysUpTo = (from, to) => {   // Mondays in [from, to], ISO dates, local time
        let n = 0; const d = new Date(from + 'T00:00:00'), end = new Date(to + 'T00:00:00');
        while (d <= end) { if (d.getDay() === 1) n++; d.setDate(d.getDate() + 1); }
        return n;
      };
      const kept = [];
      for (const c of children) {
        const lv = c.leave_iso;
        if (lv && periodStart && lv < periodStart) {
          excluded.push({ id: c.id, first_name: c.first_name, last_name: c.last_name, leave_date: lv, portal_group: c.portal_group, reason: `Left on ${lv}, before this claim period` });
          continue;
        }
        if (lv && c.portal_group === '3_4yo' && firstMonthOfAutumn && lv.slice(0, 7) === firstMonthOfAutumn) {
          excluded.push({ id: c.id, first_name: c.first_name, last_name: c.last_name, leave_date: lv, portal_group: c.portal_group, reason: `Left for school on ${lv}: the school claims them from September` });
          continue;
        }
        if (lv && ymq && lv <= periodEnd && !isNaN(runWeeks)) {
          const wks = Math.min(runWeeks, mondaysUpTo(periodStart, lv));
          if (wks <= 0) {
            excluded.push({ id: c.id, first_name: c.first_name, last_name: c.last_name, leave_date: lv, portal_group: c.portal_group, reason: `Left on ${lv}, before the first claim week of the month` });
            continue;
          }
          if (wks < runWeeks) {
            c.weeks_in_term = wks;
            c.total_hours_term = round2((c.total_hours_week || 0) * wks);
            c.leaver_weeks_note = `Leaves ${lv}: ${wks} of ${runWeeks} weeks`;
          }
        }
        if (fundingOffLeavers.has(Number(c.id))) {   // 2026-10-23: funding switched off in Wren after they left — report, never claim
          excluded.push({ id: c.id, first_name: c.first_name, last_name: c.last_name, leave_date: lv, portal_group: c.portal_group, reason: `Left on ${lv}: funding for this term is switched off in Wren` });
          continue;
        }
        kept.push(c);
      }
      children.splice(0, children.length, ...kept);
    }

    // 2026-10-13: Ealing claims month by month. The extension's month picker sends ?month=YYYY-MM so the run
    // is labelled and logged as that month (e.g. September entered as an October adjustment). Echoed only —
    // the children and hours above are the same whichever month is picked (Toby's call, 2026-10-13).
    const ym = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? String(req.query.month) : null;
    const claimMonth = ym ? new Date(ym + '-01T00:00:00Z').toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : null;

    // 2026-10-17 (Toby: "I just need adjustments for September as it was missed"): Synergy's Adjustments
    // "Pending Adjustment" tab wants TOTAL hours for the period (not weekly) split universal/extended, a
    // More/Less Hours choice and a mandatory Reason (the portal refuses to save without it). Same weekly
    // figures as the actuals above × the weeks in the claim; the extension (0.2.8, "Adjustment" claim type)
    // types these. Additive fields only — the actuals path never reads them.
    // 2026-10-20 (Toby): the Pending Adjustment tab splits by the FIRST 15 hours a week ("Pending Adjustment")
    // and the rest ("Expanded Pending Adjustment") whatever the child's age — a 30h child over a 4-week month is
    // 60 + 60 = 120. The actuals split above (under-3s all extended) is the Actuals grid's and stays as it is.
    for (const c of children) {
      const wk = isNaN(runWeeks) ? 0 : (c.leaver_weeks_note ? c.weeks_in_term : runWeeks);   // 2026-10-22: leavers' capped weeks
      const perWeek = c.total_hours_week || 0;
      // 2026-10-21 (Toby): under-3s on working-parent funding have no "funded" entitlement in Synergy — it is all
      // Expanded (0 + 120 for a 30h two-year-old). 15 + rest is the 3–4-year-old split; 2yo disadvantaged = all first box.
      const under3a = c.portal_group === '2yo' || c.portal_group === '9m_2yr';
      const firstWeek = round2(under3a ? (c.funding_type === '2yr_disadvantaged' ? perWeek : 0) : Math.min(15, perWeek));
      const restWeek = round2(Math.max(0, perWeek - firstWeek));
      c.adj_weeks = wk;
      c.adj_universal_hours_total = round2(firstWeek * wk);
      c.adj_extended_hours_total = round2(restWeek * wk);
      c.adj_total_hours = round2(c.adj_universal_hours_total + c.adj_extended_hours_total);
      c.adj_direction = 'More Hours';
      c.adj_reason = `Missed from the ${claimMonth ? claimMonth + ' ' : ''}headcount claim. `
        + `${firstWeek} + ${restWeek} expanded hours a week`
        + ` x ${wk} weeks = ${c.adj_total_hours} hours.`;
    }

    // 2026-10-23 (one-click run): the hourly rates for the term's funding year (April–March), so the extension can put
    // Wren's expected £ (hours x rate) beside each grid's "Total Funding Amount". Keyed by the portal's age groups.
    let rates = null;
    try {
      const ts = term && term.start_date ? new Date(term.start_date) : new Date();
      const fy0 = ts.getMonth() >= 3 ? ts.getFullYear() : ts.getFullYear() - 1;
      const fundingYear = `${fy0}-${String((fy0 + 1) % 100).padStart(2, '0')}`;
      const { rows: rr } = await db.query(
        'SELECT age_band, pence_per_hour, provisional FROM funding_rates WHERE funding_year=$1', [fundingYear]);
      const band = { under_2: '9m_2yr', '2yo': '2yo', '3yo': '3_4yo' };
      if (rr.length) {
        rates = { funding_year: fundingYear, provisional: rr.some(r => r.provisional) };
        for (const r of rr) if (band[r.age_band]) rates[band[r.age_band]] = Number(r.pence_per_hour) / 100;
      }
    } catch (e) { console.error('[funding-portal] rates lookup failed:', e.message); }

    res.json({
      children,
      excluded,
      rates,
      term: term ? {
        id: term.id,
        name: term.name,
        start_date: term.start_date,
        end_date: term.end_date,
        // 2026-10-23: plain dates too — start_date is a JS Date, and under BST it serialises as the day before
        start_ymd: isoOfDate(term.start_date),
        end_ymd: isoOfDate(term.end_date),
        weeks: term.term_months,
        claim_month: claimMonth,
        claim_month_ym: ym
      } : null,
      la: la || { la_code, la_name: la_code, engine: 'synergy' }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/funding-portal/log-submission ───────────────────────────────────
// Extension reports back after each submission attempt
router.post('/log-submission', async (req, res) => {
  const {
    la_code, la_name, term_id, term_label,
    child_ids, children_data,
    status, children_submitted, children_failed,
    errors, audit_trail, submission_references, extension_version
  } = req.body;

  if (!la_code || !term_label) return res.status(400).json({ error: 'la_code and term_label required' });

  try {
    const { rows: [row] } = await getPool().query(`
      INSERT INTO funding_portal_submissions
        (la_code, la_name, term_id, term_label, child_ids, children_data, status,
         children_submitted, children_failed, errors, audit_trail, submission_references,
         extension_version, submitted_by, attempted_at,
         completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),
        CASE WHEN $7 IN ('success','partial','failed') THEN NOW() ELSE NULL END)
      RETURNING id, attempted_at
    `, [
      la_code, la_name || la_code, term_id || null, term_label,
      child_ids ? `{${child_ids.map(id => `"${id}"`).join(',')}}` : null,
      children_data ? JSON.stringify(children_data) : null,
      status || 'in-progress',
      children_submitted || 0,
      children_failed || 0,
      errors ? JSON.stringify(errors) : null,
      audit_trail ? JSON.stringify(audit_trail) : null,
      submission_references ? JSON.stringify(submission_references) : null,
      extension_version || null,
      req.user.id
    ]);

    // Update test_count on template when submission completes successfully
    if (status === 'success' || status === 'partial') {
      await getPool().query(`
        UPDATE funding_portal_templates
        SET test_count = test_count + 1,
            last_tested_at = NOW(),
            test_status = CASE
              WHEN test_count >= 4 AND test_status = 'draft' THEN 'passing'
              ELSE test_status
            END
        WHERE la_code = $1
      `, [la_code]);
    }

    res.status(201).json({ ok: true, id: row.id, attempted_at: row.attempted_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/submissions ───────────────────────────────────────
router.get('/submissions', managerOnly, async (req, res) => {
  const { la_code, limit = 50 } = req.query;
  try {
    const vals = [];
    let where = '';
    if (la_code) { vals.push(la_code); where = 'WHERE fps.la_code=$1'; }
    const { rows } = await getPool().query(`
      -- b367 (2026-09-29): this used to be
      --   LEFT JOIN staff s ON s.id = fps.submitted_by
      -- but funding_portal_submissions has no submitted_by column, so every call 500'd
      -- (Roost funding.html, on prod and on every demo schema). Its only person column
      -- is user_id, a uuid, which cannot join to staff.id (integer) — the table records
      -- no staff author at all, so submitted_by_name is NULL until one exists. The key
      -- is kept so the response shape does not change for any caller.
      SELECT fps.*,
        NULL::text as submitted_by_name
      FROM funding_portal_submissions fps
      ${where}
      ORDER BY fps.attempted_at DESC
      LIMIT $${vals.length + 1}
    `, [...vals, parseInt(limit)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/templates ─────────────────────────────────────────
router.get('/templates', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT id, la_code, la_name, portal_url_pattern, engine, version,
        CASE WHEN jsonb_array_length(steps) > 0 THEN true ELSE false END as has_steps,
        jsonb_array_length(steps) as step_count,
        is_public, test_status, test_count, last_tested_at, notes,
        created_at, updated_at
      FROM funding_portal_templates
      ORDER BY
        CASE WHEN test_status='passing' THEN 0 WHEN test_status='draft' THEN 1 ELSE 2 END,
        la_name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/templates/:id ─────────────────────────────────────
router.get('/templates/:id', async (req, res) => {
  try {
    const { rows: [t] } = await getPool().query(
      'SELECT * FROM funding_portal_templates WHERE id=$1', [req.params.id]
    );
    if (!t) return res.status(404).json({ error: 'Template not found' });
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/funding-portal/templates ────────────────────────────────────────
// Visual mapper POSTs new template here; marked private until 5 successful tests
router.post('/templates', managerOnly, async (req, res) => {
  const { la_code, la_name, portal_url_pattern, engine, steps, notes } = req.body;
  if (!la_code || !la_name || !portal_url_pattern) {
    return res.status(400).json({ error: 'la_code, la_name, portal_url_pattern required' });
  }
  try {
    const { rows: [t] } = await getPool().query(`
      INSERT INTO funding_portal_templates
        (la_code, la_name, portal_url_pattern, engine, steps, is_public, test_status, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,false,'unverified',$6,$7)
      ON CONFLICT (la_code) DO UPDATE SET
        la_name = EXCLUDED.la_name,
        portal_url_pattern = EXCLUDED.portal_url_pattern,
        engine = EXCLUDED.engine,
        steps = EXCLUDED.steps,
        notes = EXCLUDED.notes,
        version = funding_portal_templates.version + 1,
        updated_at = NOW()
      RETURNING *
    `, [la_code, la_name, portal_url_pattern, engine || 'synergy',
        JSON.stringify(steps || []), notes || null, req.user.id]);
    res.status(201).json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/funding-portal/templates/:id/share ──────────────────────────────
// Manager submits template for community review after 5 successful tests
router.post('/templates/:id/share', managerOnly, async (req, res) => {
  try {
    const { rows: [t] } = await getPool().query(
      'SELECT * FROM funding_portal_templates WHERE id=$1', [req.params.id]
    );
    if (!t) return res.status(404).json({ error: 'Template not found' });
    if (t.test_count < 5) {
      return res.status(400).json({
        error: `Template needs at least 5 successful submissions before sharing. Current: ${t.test_count}`
      });
    }
    const { rows: [updated] } = await getPool().query(`
      UPDATE funding_portal_templates
      SET test_status='pending-review', updated_at=NOW()
      WHERE id=$1 RETURNING *
    `, [req.params.id]);

    // Telegram notification to Wren team
    // login-20261023: through the one Telegram sender (src/lib/notifications.js), which carries the dev guard.
    require('../lib/notifications').sendTelegramNow({ parse_mode: null,
      text: `📋 New LA template submitted for review: ${t.la_name} (${t.la_code}) — ${t.test_count} successful submissions` });

    res.json({ ok: true, template: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/extension/download ───────────────────────────────
// Returns extension download metadata; actual .crx served as static file
const _EXT_DIR = require('path').join(__dirname, '../../extensions/funding-portal');
// Build the Load-Unpacked zip on demand from the extension source in the image
// (no binary committed to git). Cached once built.
function _buildZip() {
  const fs = require('fs'); const path = require('path');
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const skip = new Set(['dist', 'node_modules', 'PROVENANCE.md', 'tests']);   // 0.5.0: + the mock-portal harness
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name) || name.startsWith('.')) continue;
      const fp = path.join(dir, name); const rp = rel ? rel + '/' + name : name;
      const st = fs.statSync(fp);
      if (st.isDirectory()) walk(fp, rp);
      // b499: skip the DEV-ONLY-rule backup files (*.bak-<build>-<date>) too — they were being
      // zipped straight into what ships to a nursery's Chrome.
      else if (!/\.(zip|crx|pem)$/.test(name) && !/\.bak-/.test(name)) zip.addLocalFile(fp, rel);
    }
  })(_EXT_DIR, '');
  const out = path.join(_EXT_DIR, 'dist', 'wren-funding-portal.zip');
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); zip.writeZip(out); return out; } catch (_) {
    // Read-only FS fallback: write to a tmp dir.
    const tmp = path.join(require('os').tmpdir(), 'wren-funding-portal.zip');
    zip.writeZip(tmp); return tmp;
  }
}
function _extPackage() {
  const fs = require('fs'); const path = require('path');
  for (const [file, kind] of [['dist/wren-funding-portal.crx', 'crx'], ['dist/wren-funding-portal.zip', 'zip']]) {
    const p = path.join(_EXT_DIR, file);
    try { const st = fs.statSync(p); return { path: p, kind, filename: path.basename(p), size: st.size }; } catch (_) {}
  }
  // No prebuilt package — build the zip now (source is in the image).
  try {
    const p = _buildZip();
    const st = fs.statSync(p);
    return { path: p, kind: 'zip', filename: 'wren-funding-portal.zip', size: st.size };
  } catch (e) { console.error('[funding-portal] zip build failed:', e.message); return null; }
}

router.get('/extension/download', async (req, res) => {
  const fs = require('fs'); const path = require('path');
  const pkg = _extPackage();
  let extVersion = '0.2.0';
  try { extVersion = JSON.parse(fs.readFileSync(path.join(_EXT_DIR, 'manifest.json'), 'utf8')).version; } catch (_) {}
  res.json({
    version: extVersion,
    available: !!pkg,
    kind: pkg ? pkg.kind : null,
    filename: pkg ? pkg.filename : null,
    size_bytes: pkg ? pkg.size : null,
    download_url: pkg ? '/api/funding-portal/extension/file' : null,
    instructions: pkg && pkg.kind === 'zip' ? [
      'Download the .zip below and unzip it to a permanent folder (don\'t delete it after — Chrome loads it from there).',
      'Open Chrome → chrome://extensions',
      'Enable "Developer mode" (top-right toggle).',
      'Click "Load unpacked" and select the unzipped folder.',
      'Open the extension, enter your Wren server URL and the API token from Roost → System → Funding Portal.',
    ] : [
      'Download the .crx file below.',
      'Open Chrome → chrome://extensions, enable Developer mode, drag the .crx onto the page, Add extension.',
      'Open the extension and enter your Wren server URL and API token.',
    ],
  });
});

// Serve the actual package file (auth: manager JWT via the router's auth above,
// OR the extension api-token — extensionOrAuth already guards this router).
router.get('/extension/file', async (req, res) => {
  const pkg = _extPackage();
  if (!pkg) return res.status(404).json({ error: 'Extension not packaged yet' });
  res.download(pkg.path, pkg.filename);
});

// ── LA template requests (2026-07-10) — the scale mechanism ───────────────────
// Any setting can say "here's my Local Authority + portal + a sample of the
// form"; the local AI drafts a Wren template; Toby reviews and signs off; on
// approval it becomes a real (private) funding_portal_templates row. This is how
// coverage grows to new LAs without hand-coding each one.
const OLLAMA_HOST = ai.host();
// Drafting an LA template from a sample form → ai-models.js role 'heavy', resolved
// per call. (b333: was FUNDING_TEMPLATE_MODEL / gpt-oss:120b, no longer installed.)
const FUNDING_MODEL = () => ai.model('heavy');

// Submit a request (manager auth via the router guard; the public website tool
// posts through a same-origin proxy that adds the extension token).
router.post('/template-request', async (req, res) => {
  const { la_name, portal_url, form_sample, notes, email } = req.body || {};
  if (!la_name) return res.status(400).json({ error: 'la_name required' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO funding_template_requests (la_name, portal_url, submitted_by_email, form_sample, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [String(la_name).slice(0, 200), portal_url || null, email || req.user?.email || null,
       String(form_sample || '').slice(0, 20000), String(notes || '').slice(0, 2000)]);
    res.status(201).json({ ok: true, id: rows[0].id, status: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/template-requests', managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, la_name, portal_url, submitted_by_email, notes, status,
              (ai_draft IS NOT NULL) AS has_draft, created_at, decided_at
       FROM funding_template_requests ORDER BY created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI drafts a template from the portal URL + form sample. Returns the draft for
// Toby to review; does NOT go live until /approve. Deterministic-ish: low temp.
router.post('/template-requests/:id/ai-draft', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT * FROM funding_template_requests WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    const prompt = `You map UK Local Authority Early Years funding portal forms into Wren's JSON template format. Produce ONLY JSON.

The Wren template shape:
{"la_code":"short-slug","la_name":"...","portal_url_pattern":"https://host/*","engine":"synergy|capita|liquid-logic|custom","steps":[{"page":"login|headcount|child-details|submit","selector_hints":["..."]}],"field_mappings":{"child_first_name":"<their field label or selector>","child_last_name":"...","dob":"...","start_date":"...","hours_per_week":"...","funding_type":"...","ethnicity":"...","address":"...","postcode":"..."},"ethnicity_lookup":{"White British":"WBRI"}}

Local Authority: ${r.la_name}
Portal URL: ${r.portal_url || '(not given)'}
Form sample (field labels / HTML the provider pasted):
${(r.form_sample || '(none provided — infer from the portal family)').slice(0, 12000)}

Pick engine from the URL/host if it's a known family (servelec/synergy→synergy, capita/ems→capita, liquidlogic→liquid-logic, else custom). Map every field you can see; leave unknowns null. Return ONLY the JSON object.`;
    const resp = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: FUNDING_MODEL(), prompt, stream: false, think: false, options: ai.options({ temperature: 0.15, num_predict: 1200 }, 'long') }),
      signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
    const raw = ((await resp.json()).response || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI returned no JSON — try pasting a clearer form sample');
    let draft; try { draft = JSON.parse(m[0]); } catch { throw new Error('AI JSON was malformed — regenerate'); }
    await db.query(`UPDATE funding_template_requests SET ai_draft=$1, status='drafted' WHERE id=$2`, [JSON.stringify(draft), r.id]);
    res.json({ ok: true, draft });
  } catch (e) {
    console.error('[funding-portal] ai-draft error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Toby approves → the AI draft (or his edited version) becomes a live template.
router.post('/template-requests/:id/approve', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT * FROM funding_template_requests WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    const draft = (req.body && req.body.template) || (typeof r.ai_draft === 'string' ? JSON.parse(r.ai_draft) : r.ai_draft);
    if (!draft || !draft.la_name) return res.status(400).json({ error: 'No usable draft to approve' });
    const { rows: tmpl } = await db.query(
      `INSERT INTO funding_portal_templates
        (la_code, la_name, portal_url_pattern, engine, version, steps, field_mappings, ethnicity_lookup, notes, approved_by, is_public, test_status)
       VALUES ($1,$2,$3,$4,'0.1',$5,$6,$7,$8,$9,false,'untested') RETURNING id`,
      [draft.la_code || null, draft.la_name, draft.portal_url_pattern || r.portal_url, draft.engine || 'custom',
       JSON.stringify(draft.steps || []), JSON.stringify(draft.field_mappings || {}),
       JSON.stringify(draft.ethnicity_lookup || {}), 'AI-drafted from request #' + r.id + ', approved by Toby', req.user.id]);
    await db.query(`UPDATE funding_template_requests SET status='approved', decided_by=$1, decided_at=now() WHERE id=$2`, [req.user.id, r.id]);
    res.json({ ok: true, template_id: tmpl[0].id, note: 'Template created (marked untested — do one real submission to verify before relying on it).' });
  } catch (e) {
    console.error('[funding-portal] approve error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/template-requests/:id/reject', managerOnly, async (req, res) => {
  try {
    const { rowCount } = await getPool().query(
      `UPDATE funding_template_requests SET status='rejected', decided_by=$1, decided_at=now() WHERE id=$2 AND status<>'approved'`,
      [req.user.id, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found or already approved' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/extension/token ──────────────────────────────────
// Generate or rotate the per-school extension API token stored in the school record
router.get('/extension/token', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [setting] } = await db.query(
      "SELECT value FROM settings WHERE key='extension_api_token' LIMIT 1"
    );
    if (setting) return res.json({ token: setting.value });

    // Generate and store new token
    const token = crypto.randomBytes(32).toString('hex');
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('extension_api_token', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      [token]
    );
    res.json({ token });
  } catch (e) {
    // settings table may not exist — return a session-scoped token as fallback
    const token = crypto.randomBytes(32).toString('hex');
    res.json({ token, ephemeral: true });
  }
});

// ── GET /api/funding-portal/extension/connection-info ────────────────────────
// Everything a manager needs to point the browser extension at this Wren server:
// the public URL (from the request host) + this server's own IP addresses (LAN /
// Tailscale) for setups that connect by IP. Manager-only; no secrets returned.
router.get('/extension/connection-info', managerOnly, async (req, res) => {
  try {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.get('host') || '';
    const server_url = host ? `${proto}://${host}` : '';
    // Prefer an operator-set list (settings.funding_api_ips) — inside a container os.network
    // Interfaces() only sees docker-bridge IPs (172.x / the compose subnet), never the host's
    // real LAN/Tailscale address the extension actually needs. Fall back to non-docker IfaceIPs.
    const { rows: [ipRow] } = await getPool().query(
      "SELECT value FROM settings WHERE key='funding_api_ips' LIMIT 1").catch(() => ({ rows: [] }));
    let ips = [];
    if (ipRow && ipRow.value) {
      ips = ipRow.value.split(',').map(s => ({ address: s.trim() })).filter(x => x.address);
    } else {
      const nets = require('os').networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const ni of nets[name] || []) {
          if (ni.family === 'IPv4' && !ni.internal && !/^172\.(1[6-9]|2\d|3[01])\./.test(ni.address))
            ips.push({ iface: name, address: ni.address });
        }
      }
    }
    const { rows: [t] } = await getPool().query(
      "SELECT value FROM settings WHERE key='extension_api_token' LIMIT 1").catch(() => ({ rows: [] }));
    res.json({ server_url, ips, token_present: !!(t && t.value) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/funding-portal/extension/token/rotate ──────────────────────────
router.post('/extension/token/rotate', managerOnly, async (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    await getPool().query(
      "INSERT INTO settings (key, value) VALUES ('extension_api_token', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      [token]
    );
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── b499 (2026-10-13): "Send page layout to Wren" — a names-free page capture ─────────────────
// The extension sends STRUCTURE (control types/ids/labels, button/link text outside tables, table
// shape, tab headers) never cell text or values — see content.js captureLayout(). Scrubbed again
// here against every real child/parent name plus PII regexes, because a mislabelled control or a
// stray heading could still carry a name through from the client.

const _MONTHS = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
// Keep identical to CAPTURE_PII_PATTERNS in extensions/funding-portal/content-scripts/content.js.
const PII_PATTERNS = [
  [/\b\d{4}-\d{2}-\d{2}\b/g, '[REDACTED]'],                                  // ISO date
  [/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, '[REDACTED]'],                 // D/M/Y or D-M-Y
  [/\b\d{1,2}-[A-Za-z]{3}-\d{4}\b/g, '[REDACTED]'],                          // DD-MMM-YYYY
  [new RegExp('\\b\\d{1,2}(?:st|nd|rd|th)?[\\s-]+' + _MONTHS + '\\.?,?[\\s-]+\\d{2,4}\\b', 'gi'), '[REDACTED]'],   // 13 Oct 2023, 15th October 2023
  [new RegExp('\\b' + _MONTHS + '\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b', 'gi'), '[REDACTED]'],           // October 14, 2023
  [/\b[A-CEGHJ-PR-TW-Z]{1}[A-CEGHJ-NPR-TW-Z]{1}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-DFM]?\b/gi, '[REDACTED]'], // NI number
  [/\b[\w.+-]+@[\w-]+\.[A-Za-z.]{2,}\b/gi, '[REDACTED]'],                     // email
  [/\+\s?44[\s\d()-]{8,16}\d/g, '[REDACTED]'],                               // +44 7700 900123, +44 (0)7700 900123
  [/(?<![\w.])\(?0\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\d)/g, '[REDACTED]'], // 07700 900124, (020) 7946 0123
  [/\b(?:\+44\s?|0)(?:\d\s?){9,10}\b/g, '[REDACTED]'],                       // UK phone, run together
  [/\b(GIR\s?0AA|[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2})\b/g, '[REDACTED]'], // postcode
];

async function nameScrubRegex(db) {
  const words = new Set();
  try {
    const { rows } = await db.query(`
      SELECT first_name, last_name FROM children
      UNION ALL SELECT parent_1_name, NULL FROM children WHERE parent_1_name IS NOT NULL
      UNION ALL SELECT parent_2_name, NULL FROM children WHERE parent_2_name IS NOT NULL
      UNION ALL SELECT first_name, last_name FROM staff
    `);
    for (const r of rows) {
      for (const v of [r.first_name, r.last_name]) {
        if (!v) continue;
        for (const w of String(v).split(/\s+/)) {
          const t = w.replace(/[^\p{L}\p{N}'’-]/gu, '');
          if (t.length >= 2 && /\p{L}/u.test(t)) words.add(t.toLowerCase());   // digits kept: "Baby2" must match as written
          // O'Brien -> brien, Smith-Jones -> smith + jones (a portal often shows only one half)
          for (const part of t.split(/['’-]/)) if (part.length >= 3) words.add(part.toLowerCase());
        }
      }
    }
  } catch (e) { console.error('[funding-portal] name-scrub lookup failed:', e.message); }
  if (!words.size) return null;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Unicode-aware boundaries: plain \b treats é / ë / ñ as non-word characters, so "José", "Zoë" and
  // "Núñez" were never matched at the accented end (release check, 2026-10-13).
  return new RegExp('(?<![\\p{L}\\p{N}_])(?:' + [...words].map(esc).join('|') + ')(?![\\p{L}\\p{N}_])', 'giu');
}

function scrubString(s, nameRe) {
  let out = s;
  for (const [re, repl] of PII_PATTERNS) out = out.replace(re, repl);
  if (nameRe) out = out.replace(nameRe, '[REDACTED]');
  return out.length > 400 ? out.slice(0, 400) : out;   // clip AFTER scrubbing, never before
}

function scrubDeep(node, nameRe) {
  if (typeof node === 'string') return scrubString(node, nameRe);
  if (Array.isArray(node)) return node.map(n => scrubDeep(n, nameRe));
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) out[k] = scrubDeep(node[k], nameRe);
    return out;
  }
  return node;
}

// Keep the path, drop every query VALUE (client already should have; defended again here).
function sanitizeUrlPath(p) {
  if (!p) return null;
  const [path, qs] = String(p).slice(0, 500).split('?');
  if (!qs) return path;
  const keys = qs.split('&').map(kv => kv.split('=')[0]).filter(Boolean);
  return keys.length ? `${path}?${keys.map(k => k + '=').join('&')}` : path;
}

router.post('/page-capture', managerOnly, async (req, res) => {
  const { la_code, url_path, structure, extension_version } = req.body || {};
  if (!structure || typeof structure !== 'object' || Array.isArray(structure)) return res.status(400).json({ error: 'structure (object) required' });
  // The global JSON limit is 20 MB; a page layout is a few KB. Refuse anything that is not one.
  let size = 0; try { size = JSON.stringify(structure).length; } catch (_) { size = Infinity; }
  if (size > 300000) return res.status(413).json({ error: 'structure too large' });
  try {
    const db = getPool();
    const nameRe = await nameScrubRegex(db);
    const scrubbed = scrubDeep(structure, nameRe);
    const safePath = sanitizeUrlPath(url_path);
    if (scrubbed && typeof scrubbed === 'object' && 'url_path' in scrubbed) scrubbed.url_path = sanitizeUrlPath(structure.url_path);
    const { rows: [row] } = await db.query(
      `INSERT INTO funding_portal_page_captures (la_code, url_path, captured_by, structure, extension_version)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, captured_at`,
      [la_code ? String(la_code).slice(0, 60) : null, safePath, req.user.id, JSON.stringify(scrubbed),
       extension_version ? String(extension_version).slice(0, 20) : null]);
    res.status(201).json({ ok: true, id: row.id, captured_at: row.captured_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/page-captures', managerOnly, async (req, res) => {
  const { la_code, limit = 20 } = req.query;
  try {
    const vals = []; let where = '';
    if (la_code) { vals.push(la_code); where = 'WHERE la_code=$1'; }
    const { rows } = await getPool().query(
      `SELECT id, la_code, url_path, captured_at, extension_version FROM funding_portal_page_captures
       ${where} ORDER BY captured_at DESC LIMIT $${vals.length + 1}`,
      [...vals, parseInt(limit, 10)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/page-captures/:id', managerOnly, async (req, res) => {
  try {
    const { rows: [row] } = await getPool().query(
      'SELECT * FROM funding_portal_page_captures WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── b499 (2026-10-13): DfE Early Years Census ────────────────────────────────────────────────
// Toby's screenshot (Synergy "My Details → Census") lists 16 fields in a fixed order; this
// computes every one of them from Wren's own data so the office has something to check against
// (and the extension can fill the portal page without typing). "15 of 15" in the build brief
// undercounts the portal's own field list by one — Child Statistics (5) + Establishment
// Characteristics (2) + Staff Information (9) = 16 — so this fills and reports all 16; see NOTES.
const CENSUS_EXCLUDED_ROLES = ['cook', 'chef', 'admin', 'accountant'];
const CENSUS_MANAGER_ROLES = ['manager', 'deputy_manager'];

// Academic year containing `at` (Sept 1 -> Aug 31), for "weeks open this year".
function academicYearRange(at) {
  const y = at.getUTCFullYear(), m = at.getUTCMonth();
  const startY = m >= 8 ? y : y - 1;
  return {
    start: new Date(Date.UTC(startY, 8, 1)),
    end: new Date(Date.UTC(startY + 1, 7, 31)),
  };
}

router.get('/census', managerOnly, async (req, res) => {
  const db = getPool();
  const viaExtension = req.user && req.user.via === 'funding-extension';
  try {
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
    const censusDate = new Date(dateStr + 'T00:00:00Z');

    // ── Children on roll on the census date ───────────────────────────────
    const { rows: children } = await db.query(`
      SELECT c.id, c.first_name, c.last_name,
             EXTRACT(YEAR FROM age($1::date, c.date_of_birth))::int AS age_years
        FROM children c
       WHERE COALESCE(c.is_demo,false) = false
         AND c.start_date <= $1::date
         AND (c.leave_date IS NULL OR c.leave_date >= $1::date)
         AND EXISTS (
           SELECT 1 FROM child_bookings b
            WHERE b.child_id = c.id AND b.is_active
              AND b.start_date <= $1::date AND (b.end_date IS NULL OR b.end_date >= $1::date)
         )
    `, [dateStr]);
    // Release-check fix: age was (days since birth) / 365.25, which put a child in the wrong band on ~5% of
    // dates (the day of a birthday with no leap day in between: a child turning 1 was still "under 1").
    // age() is calendar-exact (a 29 February birthday turns a year older on 1 March in a non-leap year).
    const bands = { under1: [], age1: [], age2: [], age3: [], age4: [], over4: [] };
    let missingDob = 0;
    for (const c of children) {
      const age = c.age_years;
      if (age == null || age < 0) { missingDob++; continue; }
      const name = `${c.first_name || ''} ${c.last_name || ''}`.trim();
      const bucket = age < 1 ? 'under1' : age < 2 ? 'age1' : age < 3 ? 'age2' : age < 4 ? 'age3' : age < 5 ? 'age4' : 'over4';
      bands[bucket].push(name);
    }

    // ── Weeks open this academic year ──────────────────────────────────────
    const { start: yStart, end: yEnd } = academicYearRange(censusDate);
    const yStartYmd = yStart.toISOString().slice(0, 10), yEndYmd = yEnd.toISOString().slice(0, 10);
    const closedMap = await closures.loadClosures(db, yStartYmd, yEndYmd);
    let openWeekdays = 0;
    for (let d = new Date(yStart); d <= yEnd; d.setUTCDate(d.getUTCDate() + 1)) {
      if (!closures.isClosedOn(closedMap, d.toISOString().slice(0, 10))) openWeekdays++;
    }
    const weeksOpenComputed = Math.min(52, Math.round((openWeekdays / 5) * 10) / 10);
    const { rows: [weeksRow] } = await db.query(
      `SELECT value FROM settings WHERE key='census_weeks_open_override'`).catch(() => ({ rows: [] }));
    const weeksOverride = weeksRow && weeksRow.value !== '' && weeksRow.value != null ? parseFloat(weeksRow.value) : null;
    const weeksOpen = (weeksOverride != null && !isNaN(weeksOverride)) ? weeksOverride : weeksOpenComputed;

    // ── Partnership with a maintained school ───────────────────────────────
    const { rows: [partRow] } = await db.query(
      `SELECT value FROM settings WHERE key='census_partnership_maintained_school'`).catch(() => ({ rows: [] }));
    const partnership = !!(partRow && partRow.value === 'true');

    // ── Staff ───────────────────────────────────────────────────────────────
    const { rows: staffRows } = await db.query(`
      SELECT id, first_name, last_name, role, qualification_level,
             census_fr_level, census_managerial, census_works_with_under5,
             census_qts, census_eyps, census_eyts, census_senco_l3, is_volunteer
        FROM staff WHERE is_active AND COALESCE(is_demo,false) = false
    `);
    const under5 = staffRows
      .map(s => ({
        name: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
        works_under5: s.census_works_with_under5 != null ? s.census_works_with_under5 : !CENSUS_EXCLUDED_ROLES.includes(s.role),
        managerial: s.census_managerial != null ? s.census_managerial : CENSUS_MANAGER_ROLES.includes(s.role),
        fr_level: s.census_fr_level != null ? s.census_fr_level : s.qualification_level,
        qts: !!s.census_qts, eyps: !!s.census_eyps, eyts: !!s.census_eyts, senco_l3: !!s.census_senco_l3,
        volunteer: !!s.is_volunteer,
      }))
      .filter(s => s.works_under5);
    const who = pred => under5.filter(pred).map(s => s.name);

    const strip = f => viaExtension ? { ...f, children: undefined, people: undefined } : f;
    const childField = (key, label, list, how) => strip({ key, section: 'child_statistics', label, value: list.length, how, children: list });
    const staffField = (key, label, list, how) => strip({ key, section: 'staff_information', label, value: list.length, how, people: list });

    const fields = [
      childField('under_1', 'Number of under 1 year olds', bands.under1,
        `On roll on ${dateStr} (active booking covering the date, start date on or before it, not left), aged under 1 on that date.`),
      childField('age_1', 'Number of 1 year olds', bands.age1, `As above, aged 1 on ${dateStr}.`),
      childField('age_2', 'Number of 2 year olds', bands.age2, `As above, aged 2 on ${dateStr}.`),
      childField('age_3', 'Number of 3 year olds', bands.age3, `As above, aged 3 on ${dateStr}.`),
      childField('age_4', 'Number of 4 year olds', bands.age4, `As above, aged 4 on ${dateStr}. ${bands.over4.length ? bands.over4.length + ' child(ren) aged 5+ on roll are not counted on this form.' : ''}`.trim()),
      strip({ key: 'partnership', section: 'establishment_characteristics', label: 'Work in partnership with a maintained school?',
        value: partnership, how: 'Settings value (census_partnership_maintained_school), default No — set on the Census tab.' }),
      strip({ key: 'weeks_open', section: 'establishment_characteristics', label: 'Number of weeks per year that the early years setting is open',
        value: weeksOpen, override_value: weeksOverride, computed_value: weeksOpenComputed, how: weeksOverride != null
          ? `Manual override saved on the Census tab (computed value from the calendar was ${weeksOpenComputed}).`
          : `Computed: ${openWeekdays} open weekdays (bank holidays and nursery closures excluded) ÷ 5, capped at 52.0, for ${yStartYmd} to ${yEndYmd}.` }),
      staffField('staff_total', 'Total staff at provider who work with children aged under 5', who(() => true),
        'Active, non-demo staff whose role works with under-5s (cook/admin/accountant excluded by default, overridable per person on the Census tab).'),
      staffField('staff_l2', 'Number of staff with a full and relevant early years level 2 qualification', who(s => s.fr_level === 2),
        'Full & relevant level = census_fr_level, falling back to qualification_level. Exactly level 2.'),
      staffField('staff_l3_non_mgr', 'Number of staff with a full and relevant early years level 3 qualification and not in a managerial role',
        who(s => s.fr_level >= 3 && !s.managerial), 'Full & relevant level 3+ (DfE guidance counts level 6+ under this line too — there is no separate level 6 row on this form) and not managerial (role manager/deputy_manager, or the per-person override).'),
      staffField('staff_l3_mgr', 'Number of staff with a full and relevant early years level 3 qualification and in a managerial role',
        who(s => s.fr_level >= 3 && s.managerial), 'As above, but managerial.'),
      staffField('staff_qts', 'Number of staff with qualified teacher status', who(s => s.qts), 'census_qts flag, set on the staff profile or the Census tab grid.'),
      staffField('staff_eyps', 'Number of staff with early years professional status', who(s => s.eyps), 'census_eyps flag.'),
      staffField('staff_eyts', 'Number of staff with early years teacher status', who(s => s.eyts), 'census_eyts flag.'),
      staffField('staff_no_fr', 'Number of staff without a full and relevant early years qualification (excluding volunteers)',
        who(s => !s.volunteer && (s.fr_level == null || s.fr_level < 2)), 'No full & relevant level (NULL, 0 or 1) and not a volunteer (is_volunteer).'),
      staffField('staff_senco_l3', 'Number of staff with a level 3 early years special educational needs coordinator qualification or SENCO national professional qualification (NPQ)',
        who(s => s.senco_l3), 'census_senco_l3 flag.'),
    ];

    res.json({
      date: dateStr,
      academic_year: { start: yStartYmd, end: yEndYmd },
      fields,
      note: "Check your LA's census guidance for the reference date — Wren takes the date you pick as the on-roll snapshot."
        + (missingDob ? ` WARNING: ${missingDob} child(ren) on roll have no date of birth (or a date of birth after ${dateStr}) and are not counted in any age band.` : ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/census/settings', managerOnly, async (req, res) => {
  const { partnership, weeks_override } = req.body || {};
  try {
    const db = getPool();
    if (partnership !== undefined) {
      await db.query(
        `INSERT INTO settings (key, value) VALUES ('census_partnership_maintained_school', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [(partnership === true || partnership === 'true') ? 'true' : 'false']);
    }
    if (weeks_override !== undefined) {
      if (weeks_override !== null && weeks_override !== '') {
        const w = parseFloat(weeks_override);
        if (!(w >= 1 && w <= 52)) return res.status(400).json({ error: 'weeks_override must be between 1 and 52' });
      }
      const v = (weeks_override === null || weeks_override === '') ? '' : String(parseFloat(weeks_override));
      await db.query(
        `INSERT INTO settings (key, value) VALUES ('census_weeks_open_override', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
