'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b341 — staff side of notices given in the parents app. Mounted at /api/leaving-notices.
//
//   GET  /child/:id            every notice for a child, newest first (Roost child profile)
//   POST /:id/acknowledge      "a manager has seen this" — closes the What-needs-me card
//
// The notice rows are write-once, so acknowledging writes a row in child_leaving_notice_acks
// and never touches the notice. A manager changing children.leave_date afterwards is normal
// and is done on the child profile exactly as before; it does not go through here.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

// The people who run the setting. Narrower than the keepsake roles on purpose: a notice carries a
// parent's name and address and a fee consequence.
const MANAGERS = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'];
const managersOnly = (req, res, next) =>
  hasRole(req.user, MANAGERS) ? next() : res.status(403).json({ error: 'Manager access required' });

router.get('/child/:id', managersOnly, async (req, res) => {
  const childId = parseInt(req.params.id, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'bad child id' });
  try {
    const { rows } = await getPool().query(
      `SELECT n.id, n.given_by_email, n.typed_name, n.given_at, n.short_notice, n.is_revision,
              to_char(n.given_on,'YYYY-MM-DD') AS given_on, to_char(n.notice_start,'YYYY-MM-DD') AS notice_start,
              to_char(n.earliest_last_day,'YYYY-MM-DD') AS earliest_last_day, to_char(n.chosen_last_day,'YYYY-MM-DD') AS chosen_last_day,
              to_char(n.fees_run_to,'YYYY-MM-DD') AS fees_run_to, n.terms_version, n.terms_version_label, n.terms_clause,
              n.screen_text, n.reason_code, n.reason_notes, n.source,
              a.created_at AS acknowledged_at, a.staff_id AS acknowledged_by
         FROM child_leaving_notices n
         LEFT JOIN LATERAL (SELECT created_at, staff_id FROM child_leaving_notice_acks WHERE notice_id = n.id ORDER BY id DESC LIMIT 1) a ON true
        WHERE n.child_id = $1 ORDER BY n.given_at DESC, n.id DESC`, [childId]);
    res.json({ notices: rows });
  } catch (e) { console.error('[leaving-notices] list:', e.message); res.status(500).json({ error: e.message }); }
});

router.post('/:id/acknowledge', managersOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const db = getPool();
    const n = await db.query(`SELECT id, child_id FROM child_leaving_notices WHERE id = $1`, [id]);
    if (!n.rows.length) return res.status(404).json({ error: 'Not found' });
    const note = String((req.body || {}).note || '').trim().slice(0, 500) || null;
    const ack = await db.query(
      `INSERT INTO child_leaving_notice_acks (notice_id, staff_id, note)
       SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM child_leaving_notice_acks WHERE notice_id = $1)
       RETURNING id, created_at`, [id, req.user?.id || null, note]);
    await recordAudit({ req, action: 'update', entity_type: 'child_leaving_notice', entity_id: id,
      meta: { child_id: n.rows[0].child_id, acknowledged: true, already: !ack.rows.length } });
    res.json({ ok: true, already_acknowledged: !ack.rows.length });
  } catch (e) { console.error('[leaving-notices] ack:', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
