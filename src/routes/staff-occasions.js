'use strict';
// staff-occasions.js — b142: birthdays, work anniversaries, Christmas & Eid.
// Manager-level only (voucher amounts + service history are managerial-planning data).
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const {
  getPolicy, setPolicy, getServicePeriods, getBaseline, computeCreditedService,
  getUpcomingEvents, ensureChecklistRow, CHECKLIST_ITEMS_BY_TYPE,
} = require('../services/staff-celebrations');

const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin']))
    return res.status(403).json({ error: 'Manager only' });
  next();
};

router.use(authenticate, managerOnly);

// ── Policy ────────────────────────────────────────────────────────────────────

router.get('/policy', async (req, res) => {
  try { res.json(await getPolicy()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/policy', async (req, res) => {
  try { res.json(await setPolicy(req.body || {}, req.user.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Upcoming ──────────────────────────────────────────────────────────────────

router.get('/upcoming', async (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 60));
  try { res.json(await getUpcomingEvents(days)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Service periods ───────────────────────────────────────────────────────────

router.get('/service-periods/:staffId', async (req, res) => {
  try { res.json(await getServicePeriods(req.params.staffId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// A staff member's service periods must not overlap — computeCreditedService()
// sums each period independently, so an overlap double-counts credited months
// (2026-07-23 q01 finding). excludeId lets PUT check against everything else.
async function overlappingPeriods(db, staffId, startDate, endDate, excludeId) {
  const { rows } = await db.query(
    `SELECT id, start_date::text, end_date::text FROM staff_service_periods
     WHERE staff_id=$1 AND id != COALESCE($4, -1)
       AND start_date <= COALESCE($3::date, 'infinity'::date)
       AND COALESCE(end_date, 'infinity'::date) >= $2::date`,
    [staffId, startDate, endDate || null, excludeId || null]
  );
  return rows;
}

router.post('/service-periods', async (req, res) => {
  const { staff_id, start_date, end_date, engagement_type, credit_factor, notes } = req.body || {};
  if (!staff_id || !start_date || !engagement_type)
    return res.status(400).json({ error: 'staff_id, start_date, engagement_type required' });
  if (!['contract', 'temp'].includes(engagement_type))
    return res.status(400).json({ error: 'engagement_type must be contract|temp' });
  const factor = engagement_type === 'contract' ? 1.0 : Number(credit_factor);
  if (![1, 0.5, 0].includes(factor))
    return res.status(400).json({ error: 'credit_factor must be 1, 0.5 or 0' });
  try {
    const db = getPool();
    const overlaps = await overlappingPeriods(db, staff_id, start_date, end_date);
    if (overlaps.length) {
      return res.status(400).json({ error: `Overlaps existing service period(s): ${overlaps.map(r => `#${r.id} (${r.start_date}–${r.end_date || 'ongoing'})`).join(', ')} — service periods must not overlap` });
    }
    const { rows } = await db.query(
      `INSERT INTO staff_service_periods (staff_id, start_date, end_date, engagement_type, credit_factor, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, staff_id, start_date::text, end_date::text, engagement_type, credit_factor, notes`,
      [staff_id, start_date, end_date || null, engagement_type, factor, notes || null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/service-periods/:id', async (req, res) => {
  const { start_date, end_date, engagement_type, credit_factor, notes } = req.body || {};
  if (credit_factor != null && ![1, 0.5, 0].includes(Number(credit_factor)))
    return res.status(400).json({ error: 'credit_factor must be 1, 0.5 or 0' });
  try {
    const db = getPool();
    if (start_date || end_date !== undefined) {
      const { rows: existing } = await db.query('SELECT staff_id, start_date::text, end_date::text FROM staff_service_periods WHERE id=$1', [req.params.id]);
      if (!existing.length) return res.status(404).json({ error: 'Not found' });
      const effStart = start_date || existing[0].start_date;
      const effEnd = end_date === null ? null : (end_date || existing[0].end_date);
      const overlaps = await overlappingPeriods(db, existing[0].staff_id, effStart, effEnd, Number(req.params.id));
      if (overlaps.length) {
        return res.status(400).json({ error: `Overlaps existing service period(s): ${overlaps.map(r => `#${r.id} (${r.start_date}–${r.end_date || 'ongoing'})`).join(', ')} — service periods must not overlap` });
      }
    }
    const { rows } = await db.query(
      `UPDATE staff_service_periods SET
         start_date      = COALESCE($2, start_date),
         end_date        = CASE WHEN $3::text = '__clear__' THEN NULL ELSE COALESCE($3::date, end_date) END,
         engagement_type = COALESCE($4, engagement_type),
         credit_factor   = COALESCE($5, credit_factor),
         notes           = COALESCE($6, notes),
         updated_at      = NOW()
       WHERE id=$1 RETURNING id, staff_id, start_date::text, end_date::text, engagement_type, credit_factor, notes`,
      [req.params.id, start_date || null, end_date === null ? '__clear__' : (end_date || null),
       engagement_type || null, credit_factor != null ? Number(credit_factor) : null, notes != null ? notes : null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/service-periods/:id', async (req, res) => {
  try {
    await getPool().query('DELETE FROM staff_service_periods WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Baseline ("agreed prior service") ─────────────────────────────────────────

router.get('/baseline/:staffId', async (req, res) => {
  try { res.json(await getBaseline(req.params.staffId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/baseline/:staffId', async (req, res) => {
  const { baseline_months, as_of_date, agreed_by, note } = req.body || {};
  if (baseline_months == null || !as_of_date)
    return res.status(400).json({ error: 'baseline_months and as_of_date required' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO staff_service_baseline (staff_id, baseline_months, as_of_date, agreed_by, note, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (staff_id) DO UPDATE SET
         baseline_months=$2, as_of_date=$3, agreed_by=$4, note=$5, updated_at=NOW()
       RETURNING staff_id, baseline_months, as_of_date::text, agreed_by, note`,
      [req.params.staffId, baseline_months, as_of_date, agreed_by || req.user.id, note || null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/baseline/:staffId', async (req, res) => {
  try {
    await getPool().query('DELETE FROM staff_service_baseline WHERE staff_id=$1', [req.params.staffId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Service summary (credited total + next milestone) ────────────────────────

router.get('/service-summary/:staffId', async (req, res) => {
  try { res.json(await computeCreditedService(req.params.staffId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Occasions (Christmas / Eid / ad-hoc, whole-team or per-staff) ────────────

router.get('/occasions', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, staff_id, kind, title, occasion_date::text, recurrence, voucher_amount, notes
       FROM staff_occasions ORDER BY occasion_date`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/occasions', async (req, res) => {
  const { staff_id, kind, title, occasion_date, recurrence, voucher_amount, notes } = req.body || {};
  if (!kind || !title || !occasion_date)
    return res.status(400).json({ error: 'kind, title, occasion_date required' });
  if (!['christmas', 'eid_al_fitr', 'eid_al_adha', 'other'].includes(kind))
    return res.status(400).json({ error: 'invalid kind' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO staff_occasions (staff_id, kind, title, occasion_date, recurrence, voucher_amount, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, staff_id, kind, title, occasion_date::text, recurrence, voucher_amount, notes`,
      [staff_id || null, kind, title, occasion_date, recurrence || 'annual', voucher_amount || null, notes || null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/occasions/:id', async (req, res) => {
  const { title, occasion_date, recurrence, voucher_amount, notes } = req.body || {};
  try {
    const { rows } = await getPool().query(
      `UPDATE staff_occasions SET
         title          = COALESCE($2, title),
         occasion_date  = COALESCE($3, occasion_date),
         recurrence     = COALESCE($4, recurrence),
         voucher_amount = COALESCE($5, voucher_amount),
         notes          = COALESCE($6, notes),
         updated_at     = NOW()
       WHERE id=$1 RETURNING id, staff_id, kind, title, occasion_date::text, recurrence, voucher_amount, notes`,
      [req.params.id, title || null, occasion_date || null, recurrence || null, voucher_amount || null, notes != null ? notes : null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/occasions/:id', async (req, res) => {
  try {
    await getPool().query('DELETE FROM staff_occasions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Checklist ─────────────────────────────────────────────────────────────────

router.get('/checklist/:eventKey', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, event_key, event_type, staff_id, occasion_id, event_date::text, event_year,
              milestone_years, title, voucher_amount, voucher_tier, checklist_state
       FROM staff_celebration_checklist WHERE event_key=$1`,
      [req.params.eventKey]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found — call GET /upcoming first to materialise it' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT body: { item: 'card'|'vouchers'|'flowers'|'window_notice'|'newsletter', done: true|false }
router.put('/checklist/:eventKey/item', async (req, res) => {
  const { item, done } = req.body || {};
  if (!item) return res.status(400).json({ error: 'item required' });
  try {
    const db = getPool();
    const { rows: existing } = await db.query(
      `SELECT id, event_type, checklist_state FROM staff_celebration_checklist WHERE event_key=$1`,
      [req.params.eventKey]
    );
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const allowed = CHECKLIST_ITEMS_BY_TYPE[existing[0].event_type] || [];
    if (!allowed.includes(item)) return res.status(400).json({ error: `item not valid for ${existing[0].event_type}` });
    const state = existing[0].checklist_state || {};
    state[item] = done
      ? { done: true, done_at: new Date().toISOString(), done_by: req.user.id }
      : { done: false };
    const { rows } = await db.query(
      `UPDATE staff_celebration_checklist SET checklist_state=$2, updated_at=NOW() WHERE id=$1
       RETURNING id, event_key, checklist_state`,
      [existing[0].id, JSON.stringify(state)]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Christmas voucher tier (manager's choice per staff member)
router.put('/checklist/:eventKey/tier', async (req, res) => {
  const { voucher_tier } = req.body || {};
  try {
    const { rows } = await getPool().query(
      `UPDATE staff_celebration_checklist SET voucher_tier=$2, updated_at=NOW() WHERE event_key=$1
       RETURNING id, event_key, voucher_tier`,
      [req.params.eventKey, voucher_tier || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// "Add to newsletter" — drops a congratulations line into the current draft newsletter
// (reuses the b138 newsletter-sections pattern: POST /api/newsletter/:id/sections).
router.post('/checklist/:eventKey/add-to-newsletter', async (req, res) => {
  const db = getPool();
  try {
    const { rows: cl } = await db.query(
      `SELECT scc.*, s.first_name, s.last_name, s.preferred_name
       FROM staff_celebration_checklist scc
       LEFT JOIN staff s ON s.id = scc.staff_id
       WHERE scc.event_key=$1`,
      [req.params.eventKey]
    );
    if (!cl.length) return res.status(404).json({ error: 'Not found' });
    const ev = cl[0];
    const { rows: draftRows } = await db.query(
      // b295: the celebration line is written for PARENTS ("Happy birthday to
      // …!"), so it belongs in the parents newsletter, not in whatever draft
      // happens to be newest.
      `SELECT id FROM newsletters
        WHERE status='draft' AND COALESCE(audience,'parents')='parents'
        ORDER BY created_at DESC LIMIT 1`
    );
    if (!draftRows.length) return res.status(400).json({ error: 'No draft newsletter to add to — create one first' });
    const draftId = draftRows[0].id;
    const name = ev.first_name ? `${ev.preferred_name || ev.first_name} ${ev.last_name}` : null;
    const lines = {
      anniversary: `Huge congratulations to ${name} on their ${ev.milestone_years}-year work anniversary with Your Nursery this month! 🎉`,
      birthday: `Happy birthday to ${name}! 🎂`,
      christmas: null,
      eid: `Wishing our Muslim families and staff a very happy ${ev.title}! 🌙`,
      other: name ? `Congratulations to ${name}!` : ev.title,
    };
    const text = lines[ev.event_type];
    if (!text) return res.status(400).json({ error: `add-to-newsletter not applicable for ${ev.event_type}` });

    const { rows: mx } = await db.query(
      'SELECT COALESCE(MAX(section_order), -1) + 1 AS next FROM newsletter_sections WHERE newsletter_id=$1',
      [draftId]
    );
    const { rows: section } = await db.query(
      `INSERT INTO newsletter_sections (newsletter_id, section_type, title, raw_notes, metadata, section_order)
       VALUES ($1,'text',$2,$3,$4,$5) RETURNING *`,
      [draftId, 'Celebrations', text, JSON.stringify({ source: 'staff-occasions', event_key: ev.event_key }), mx[0].next]
    );
    await db.query('UPDATE newsletters SET updated_at=NOW() WHERE id=$1', [draftId]);

    const state = ev.checklist_state || {};
    if ((CHECKLIST_ITEMS_BY_TYPE[ev.event_type] || []).includes('newsletter')) {
      state.newsletter = { done: true, done_at: new Date().toISOString(), done_by: req.user.id };
      await db.query(`UPDATE staff_celebration_checklist SET checklist_state=$2, updated_at=NOW() WHERE id=$1`,
        [ev.id, JSON.stringify(state)]);
    }
    res.json({ ok: true, newsletter_id: draftId, section: section[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
