// Staff side of parent change requests (build 75d, 2026-07-09).
// Parents submit allergy/details change requests via /api/parents/...; staff
// review and approve/reject here. Approving an allergy request applies it to
// ladn.children (allergies text + allergens array) and alerts all staff.
// details_change requests are whitelist-only (postcode, parent_1_phone) —
// anything else is recorded and approved but applied manually by the manager,
// stated plainly in the response.
'use strict';
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { getPool } = require('../db/pool');

const DETAILS_WHITELIST = { postcode: 'postcode', phone: 'parent_1_phone' };

router.use((req, res, next) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-wren-token'] || '';
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  if (req.user.aud === 'parents' || req.user.role === 'parent' || !Number.isInteger(req.user.id)) {
    return res.status(403).json({ error: 'Staff only' });
  }
  next();
});

// GET / — pending (default) or all recent requests
router.get('/', async (req, res) => {
  try {
    const all = req.query.all === '1';
    const { rows } = await getPool().query(
      `SELECT r.*, c.first_name || ' ' || c.last_name AS child_name
       FROM parent_change_requests r LEFT JOIN children c ON c.id = r.child_id
       ${all ? '' : "WHERE r.status='pending'"} ORDER BY r.created_at DESC LIMIT 100`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/approve', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT * FROM parent_change_requests WHERE id=$1 AND status='pending'`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found or not pending' });
    const r = rows[0];
    const detail = typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail;
    let applied = null;

    if (r.kind === 'allergy_add') {
      const allergen = String(detail.allergen || '').trim();
      const reaction = String(detail.reaction || '').trim();
      if (!allergen) return res.status(400).json({ error: 'request has no allergen' });
      const entry = allergen + (reaction ? ` (reaction: ${reaction})` : '') + ' [parent-reported, staff-confirmed]';
      await db.query(
        `UPDATE children SET
           allergies = CASE WHEN coalesce(allergies,'')='' THEN $1 ELSE allergies || '; ' || $1 END,
           allergens = CASE WHEN allergens IS NULL THEN ARRAY[$2] ELSE array_append(allergens, $2) END
         WHERE id=$3 AND NOT (coalesce(allergens, '{}') @> ARRAY[$2])`,
        [entry, allergen.toLowerCase(), r.child_id]);
      applied = `allergy "${allergen}" added to the child record`;
      // High-priority alert to all staff — allergies are safety-critical.
      await db.query(
        `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
         VALUES ('all-staff', NULL, 'allergy', $1, $2, '/app.html#children', 'children', $3, 'high')`,
        [`⚠️ New allergy confirmed: ${allergen}`,
         `A parent-reported allergy (${allergen}${reaction ? ', reaction: ' + reaction : ''}) has been confirmed and added to the child's record. Check before serving food.`,
         r.child_id]).catch(e => console.error('[change-requests] allergy alert failed:', e.message));
    } else if (r.kind === 'allergy_remove') {
      const allergen = String(detail.allergen || '').trim().toLowerCase();
      if (allergen) {
        await db.query(
          `UPDATE children SET allergens = array_remove(allergens, $1) WHERE id=$2`, [allergen, r.child_id]);
        applied = `allergen "${allergen}" removed from the allergens list — REVIEW the free-text allergies field manually`;
      }
    } else if (r.kind === 'details_change') {
      const field = DETAILS_WHITELIST[String(detail.field || '')];
      if (field && detail.new_value) {
        await db.query(`UPDATE children SET ${field}=$1 WHERE id=$2`, [String(detail.new_value).slice(0, 300), r.child_id]);
        applied = `${detail.field} updated`;
      } else {
        applied = 'approved — apply manually via the child profile (field not auto-applicable)';
      }
    }

    await db.query(
      `UPDATE parent_change_requests SET status='approved', decided_by=$1, decided_at=now() WHERE id=$2`,
      [req.user.id, r.id]);
    res.json({ ok: true, applied });
  } catch (e) {
    console.error('[change-requests] approve error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/reject', async (req, res) => {
  try {
    const { rowCount } = await getPool().query(
      `UPDATE parent_change_requests SET status='rejected', decided_by=$1, decided_at=now()
       WHERE id=$2 AND status='pending'`, [req.user.id, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found or not pending' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
