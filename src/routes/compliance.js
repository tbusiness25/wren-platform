'use strict';
/**
 * compliance.js — b186 (2026-08-19). Mounted at /api/compliance. Manager-gated.
 *
 * The single answer to "what is expiring?" across staff vetting, training,
 * policies, supervisions, induction and SEN reviews — previously scattered
 * across a DBS-only panel in admin.js and a handful of per-feature pages.
 *
 *   GET  /api/compliance/expiring
 *          ?days=N        override the settings window (compliance_alert_days)
 *          &kind=a,b      restrict to kinds
 *          &status=overdue|due_soon
 *          &all=1         include status 'ok' (dated but not yet due)
 *        → { window_days, counts, items: [{kind, subject_type, subject_id,
 *            subject_name, due_date, days_remaining, status, detail}] }
 *
 *   GET  /api/compliance/scr
 *        → the Single Central Record: one row per active staff member with
 *          every vetting field an inspector asks for, each dated field already
 *          RAG-rated against the SAME window as /expiring.
 *
 *   PATCH /api/compliance/scr/:staffId
 *        → set references_complete / prohibition_check_date (the two SCR fields
 *          with no other home in the UI). Whitelisted — nothing else writable.
 *
 * Kind/threshold logic lives in src/lib/compliance-expiry.js so the nightly
 * sweep in scripts/report-engine-nightly.js gives identical answers.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { collectExpiring, windowDays, statusFor, KINDS, KIND_LABELS } = require('../lib/compliance-expiry');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

// GET /api/compliance/expiring
router.get('/expiring', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const days  = parseInt(req.query.days, 10);
    const kinds = req.query.kind ? String(req.query.kind).split(',').map(s => s.trim()).filter(Boolean) : null;
    const bad   = (kinds || []).filter(k => !KINDS.includes(k));
    if (bad.length) return res.status(400).json({ error: `Unknown kind(s): ${bad.join(', ')}`, valid: KINDS });

    const { window_days, items } = await collectExpiring(db, {
      win: Number.isFinite(days) && days > 0 ? days : undefined,
      includeOk: req.query.all === '1' || req.query.all === 'true',
      kinds,
    });

    const filtered = req.query.status
      ? items.filter(i => i.status === req.query.status)
      : items;

    const counts = { overdue: 0, due_soon: 0, ok: 0, by_kind: {} };
    for (const i of filtered) {
      counts[i.status] = (counts[i.status] || 0) + 1;
      counts.by_kind[i.kind] = (counts.by_kind[i.kind] || 0) + 1;
    }

    res.json({ window_days, generated_at: new Date().toISOString(), kind_labels: KIND_LABELS, counts, items: filtered });
  } catch (err) {
    console.error('compliance/expiring error:', err.message);
    res.status(500).json({ error: 'Failed to build compliance list' });
  }
});

// GET /api/compliance/scr — Single Central Record
router.get('/scr', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const win = await windowDays(db);

    const { rows: staff } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.role,
             s.contract_start, s.dbs_number, s.dbs_initial_date, s.dbs_check_date,
             s.dbs_expiry, s.dbs_followup_date,
             s.right_to_work_status, s.right_to_work_check_date, s.right_to_work_expiry_date,
             s.visa_number IS NOT NULL AS has_visa, s.visa_expiry_date,
             s.qualification, s.qualification_level, s.is_first_aider,
             s.references_complete, s.prohibition_check_date
        FROM staff s
       WHERE s.is_active = true
       ORDER BY lower(coalesce(s.last_name, '')), lower(coalesce(s.first_name, ''))
    `);

    // Latest paediatric first aid + safeguarding training + induction per staff.
    const latest = async (sql) => {
      try { const { rows } = await db.query(sql); return rows; } catch (e) {
        console.warn('[compliance/scr] sub-query skipped:', e.message); return [];
      }
    };
    const pfa = await latest(`
      SELECT DISTINCT ON (staff_id) staff_id, completed_date, expiry_date
        FROM mandatory_training
       WHERE (training_type ILIKE '%paediatric%' OR training_type ILIKE '%first_aid%' OR training_type ILIKE '%first aid%')
       ORDER BY staff_id, coalesce(expiry_date, completed_date) DESC NULLS LAST`);
    const sg = await latest(`
      SELECT DISTINCT ON (staff_id) staff_id, completed_date, expiry_date
        FROM safeguarding_training
       ORDER BY staff_id, coalesce(expiry_date, completed_date) DESC NULLS LAST`);
    const ind = await latest(`
      SELECT DISTINCT ON (staff_id) staff_id, status, target_complete_date
        FROM induction_assignments
       ORDER BY staff_id, coalesce(target_complete_date, start_date) DESC NULLS LAST`);

    const byStaff = (rows) => rows.reduce((m, r) => (m[r.staff_id] = r, m), {});
    const pfaM = byStaff(pfa), sgM = byStaff(sg), indM = byStaff(ind);

    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    const rag = (d) => {
      if (!d) return { date: null, status: 'missing', days: null };
      const iso = (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
      const days = Math.round((new Date(iso + 'T00:00:00Z') - today) / 86400000);
      return { date: iso, status: statusFor(days, win), days };
    };
    const asDate = (d) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);

    const rowsOut = staff.map(s => {
      const p = pfaM[s.id], g = sgM[s.id], i = indM[s.id];
      const inductionDone = !!i && ['complete', 'completed', 'signed_off'].includes(String(i.status || '').toLowerCase());
      return {
        staff_id:   s.id,
        name:       `${(s.preferred_name || s.first_name || '').trim()} ${(s.last_name || '').trim()}`.trim() || `#${s.id}`,
        role:       s.role || null,
        start_date: asDate(s.contract_start),

        dbs_number:      s.dbs_number || null,
        dbs_issue_date:  asDate(s.dbs_initial_date || s.dbs_check_date),
        dbs_expiry:      rag(s.dbs_expiry),

        right_to_work_status:     s.right_to_work_status || null,
        right_to_work_check_date: asDate(s.right_to_work_check_date),
        right_to_work_expiry:     s.right_to_work_expiry_date ? rag(s.right_to_work_expiry_date) : null,

        visa_expiry: s.has_visa || s.visa_expiry_date ? rag(s.visa_expiry_date) : null,

        qualification:       s.qualification || null,
        qualification_level: s.qualification_level != null ? s.qualification_level : null,

        paediatric_first_aid: {
          held:   !!s.is_first_aider || !!p,
          ...rag(p && p.expiry_date),
        },
        safeguarding_training: {
          completed: asDate(g && g.completed_date),
          ...rag(g && (g.expiry_date || null)),
        },
        induction: { complete: inductionDone, status: (i && i.status) || null, target: asDate(i && i.target_complete_date) },

        references_complete:    !!s.references_complete,
        prohibition_check_date: asDate(s.prohibition_check_date),
      };
    });

    res.json({ window_days: win, generated_at: new Date().toISOString(), count: rowsOut.length, staff: rowsOut });
  } catch (err) {
    console.error('compliance/scr error:', err.message);
    res.status(500).json({ error: 'Failed to build Single Central Record' });
  }
});

// PATCH /api/compliance/scr/:staffId — the two SCR-only fields
router.patch('/scr/:staffId', managerOnly, async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.staffId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad staff id' });

  const sets = [], vals = [];
  if (Object.prototype.hasOwnProperty.call(req.body, 'references_complete')) {
    sets.push(`references_complete = $${sets.length + 1}`);
    vals.push(!!req.body.references_complete);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'prohibition_check_date')) {
    const d = req.body.prohibition_check_date;
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'prohibition_check_date must be YYYY-MM-DD' });
    sets.push(`prohibition_check_date = $${sets.length + 1}`);
    vals.push(d || null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  try {
    vals.push(id);
    const { rows } = await db.query(
      `UPDATE staff SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, references_complete, prohibition_check_date`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('compliance/scr PATCH error:', err.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

module.exports = router;
