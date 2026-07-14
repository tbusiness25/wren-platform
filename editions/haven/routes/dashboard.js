'use strict';
// Haven — dashboard summary
const express = require('express');
const router = express.Router();
const { getPool } = require('../../../src/db/pool');
const authenticate = require('../../../src/middleware/auth');
const { requirePerm, fail } = require('../lib/permissions');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const [counts, reviewsDue, openIncidents, news2Alerts, dolsExpiring, handover] = await Promise.all([
      db.query(`SELECT
        (SELECT count(*) FROM residents WHERE is_active = true)::int AS residents,
        (SELECT count(*) FROM care_plans WHERE status='active')::int AS active_care_plans,
        (SELECT count(*) FROM incidents WHERE status != 'closed')::int AS open_incidents,
        (SELECT count(*) FROM safeguarding_concerns WHERE status != 'closed')::int AS open_safeguarding,
        (SELECT count(*) FROM cqc_notifications WHERE status = 'draft')::int AS draft_cqc_notifications,
        (SELECT count(*) FROM risk_assessments WHERE status='active' AND next_review_due < CURRENT_DATE)::int AS overdue_risk_reviews,
        (SELECT count(*) FROM care_plans WHERE status='active' AND next_review_due < CURRENT_DATE)::int AS overdue_care_plan_reviews,
        (SELECT count(*) FROM body_map_entries WHERE resolved_at IS NULL)::int AS active_body_map_marks`),
      db.query(`SELECT cp.id, cp.title, cp.category, cp.next_review_due, r.id AS resident_id,
                       r.first_name, r.last_name
                FROM care_plans cp JOIN residents r ON r.id = cp.resident_id
                WHERE cp.status='active' AND cp.next_review_due <= CURRENT_DATE + 7
                ORDER BY cp.next_review_due LIMIT 10`),
      db.query(`SELECT i.id, i.incident_type, i.occurred_at, i.riddor_reportable,
                       r.first_name, r.last_name
                FROM incidents i LEFT JOIN residents r ON r.id = i.resident_id
                WHERE i.status != 'closed' ORDER BY i.occurred_at DESC LIMIT 10`),
      db.query(`SELECT DISTINCT ON (cs.resident_id) cs.resident_id, cs.score, cs.band, cs.scored_at,
                       r.first_name, r.last_name
                FROM clinical_scores cs JOIN residents r ON r.id = cs.resident_id
                WHERE cs.tool = 'news2' AND r.is_active = true
                ORDER BY cs.resident_id, cs.scored_at DESC`),
      db.query(`SELECT m.id, m.resident_id, m.dols_expiry_date, m.dols_status, r.first_name, r.last_name
                FROM mca_dols m JOIN residents r ON r.id = m.resident_id
                WHERE m.dols_status IN ('urgent_granted','standard_granted')
                  AND m.dols_expiry_date <= CURRENT_DATE + 30
                ORDER BY m.dols_expiry_date LIMIT 10`),
      db.query(`SELECT h.*, r.first_name, r.last_name
                FROM handover_notes h LEFT JOIN residents r ON r.id = h.resident_id
                WHERE h.shift_date = CURRENT_DATE
                ORDER BY CASE h.priority WHEN 'urgent' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, h.created_at
                LIMIT 15`),
    ]);
    res.json({
      counts: counts.rows[0],
      care_plan_reviews_due: reviewsDue.rows,
      open_incidents: openIncidents.rows,
      news2_latest: news2Alerts.rows.filter(x => ['medium','high','low_medium'].includes(x.band)),
      dols_expiring: dolsExpiring.rows,
      todays_handover: handover.rows,
    });
  } catch (e) { fail(res, e); }
});

module.exports = router;
