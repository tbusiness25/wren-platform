const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');
const { recordAudit } = require('../utils/audit');

// ── Ensure entry-time signature column exists (idempotent, non-destructive) ──
let _migrated = false;
async function _ensureColumns() {
  if (_migrated) return;
  try {
    await getPool().query(
      `ALTER TABLE incidents ADD COLUMN IF NOT EXISTS signature_data text`
    );
    _migrated = true;
  } catch (e) {
    // Non-fatal: column may already exist or DB momentarily unavailable.
    console.error('[incidents] signature_data migration:', e.message);
  }
}
_ensureColumns();

router.use(authenticate);

// GET / — all incidents (optional ?status=, ?child_id=)
router.get('/', async (req, res) => {
  const status  = req.query.status;
  const childId = req.query.child_id ? parseInt(req.query.child_id, 10) : null;
  try {
    const db = getPool();
    let q = `
      SELECT i.*, c.first_name || ' ' || c.last_name as child_name, c.room_id,
             s.first_name || ' ' || s.last_name as reporter_name,
             r.name as room_name
      FROM incidents i
      JOIN children c ON c.id = i.child_id
      JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = i.reported_by
    `;
    const params = [];
    const where = [];
    if (status)  { params.push(status);  where.push(`i.status=$${params.length}`); }
    if (childId) { params.push(childId); where.push(`i.child_id=$${params.length}`); }
    if (where.length) q += ' WHERE ' + where.join(' AND ');
    q += ' ORDER BY i.created_at DESC LIMIT 100';
    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT i.*, c.first_name || ' ' || c.last_name as child_name,
             s.first_name || ' ' || s.last_name as reporter_name
      FROM incidents i
      JOIN children c ON c.id = i.child_id
      LEFT JOIN staff s ON s.id = i.reported_by
      WHERE i.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /
router.post('/', async (req, res) => {
  const { child_id, incident_date, incident_time, incident_type, location,
          description, injury_description, first_aid_given,
          body_map_area, body_map_data, signature_data, witness_name } = req.body;
  if (!child_id || !description) {
    return res.status(400).json({ error: 'child_id and description required' });
  }
  try {
    await _ensureColumns();
    const db = getPool();
    // body_map_data is jsonb; serialise objects, pass null through.
    const bodyMapDataParam = (body_map_data === undefined || body_map_data === null)
      ? null
      : (typeof body_map_data === 'string' ? body_map_data : JSON.stringify(body_map_data));
    const { rows } = await db.query(`
      INSERT INTO incidents (child_id, reported_by, incident_date, incident_time,
        incident_type, location, description, injury_description, first_aid_given,
        body_map_area, body_map_data, signature_data, witness_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [child_id, req.user.id,
        incident_date || new Date().toISOString().split('T')[0],
        incident_time, incident_type, location,
        description, injury_description, first_aid_given,
        body_map_area || null, bodyMapDataParam, signature_data || null,
        // accept both 'witness_name' and the accident form's 'witnesses' key
        (witness_name || req.body.witnesses) || null]);
    const { rows: childRow } = await db.query(
      `SELECT first_name || ' ' || last_name as name FROM children WHERE id=$1`, [child_id]
    ).catch(() => ({ rows: [] }));
    const childName = childRow[0]?.name || `Child #${child_id}`;
    const isSevere = ['head_injury','hospital','severe'].some(s =>
      (incident_type || '').toLowerCase().includes(s) ||
      (injury_description || '').toLowerCase().includes(s)
    );
    const category = isSevere ? 'incident_severe' : 'incident_reported';
    notify(category, 'all-managers', null,
      `${isSevere ? '🚨 Severe incident' : 'Incident reported'}: ${childName}`,
      `${incident_type || 'Incident'} at ${location || 'nursery'}. ${description.slice(0,200)}`,
      { priority: isSevere ? 'urgent' : 'normal',
        relatedTable: 'incidents', relatedId: rows[0].id,
        link: '/incidents.html' }
    );
    recordAudit({ req, action: 'create', entity_type: 'incident', entity_id: rows[0].id,
      meta: { child_id, incident_type: incident_type || null, severe: isSevere } });
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id
router.put('/:id', async (req, res) => {
  const { parent_notified, parent_notified_at, manager_reviewed,
          status, first_aid_given, description, injury_description,
          body_map_area, body_map_data, signature_data, witness_name } = req.body;
  try {
    await _ensureColumns();
    const db = getPool();
    const updates = [];
    const vals = [];
    const add = (col, val) => { if (val !== undefined) { vals.push(val); updates.push(`${col}=$${vals.length}`); }};
    add('parent_notified', parent_notified);
    add('parent_notified_at', parent_notified_at);
    add('manager_reviewed', manager_reviewed);
    add('manager_reviewed_at', manager_reviewed ? new Date() : undefined);
    add('status', status);
    add('first_aid_given', first_aid_given);
    add('description', description);
    add('injury_description', injury_description);
    add('body_map_area', body_map_area);
    if (body_map_data !== undefined) {
      add('body_map_data', body_map_data === null ? null
        : (typeof body_map_data === 'string' ? body_map_data : JSON.stringify(body_map_data)));
    }
    add('signature_data', signature_data);
    add('witness_name', witness_name);
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE incidents SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );
    recordAudit({ req, action: 'update', entity_type: 'incident', entity_id: req.params.id,
      meta: { fields: updates.map(u => u.split('=')[0]) } });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/notify-parent — generate parent signature link and mark notified
router.post('/:id/notify-parent', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  if (!isManager) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE incidents SET parent_notified=true, parent_notified_at=NOW(),
         parent_notified_by=$2, parent_signature_requested=true,
         parent_signature_token=gen_random_uuid()
       WHERE id=$1
       RETURNING id, parent_signature_token, child_id`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const baseUrl = process.env.ADMIN_BASE_URL || 'https://admin.example.com';
    res.json({
      ok: true,
      sign_url: `${baseUrl}/api/incidents/sign/${rows[0].parent_signature_token}`,
      token: rows[0].parent_signature_token,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /sign/:token — public, no auth — shows incident for parent review
router.get('/sign/:token', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT i.id, i.incident_date, i.incident_time, i.incident_type, i.location,
             i.description, i.injury_description, i.first_aid_given,
             i.parent_signed_at, i.body_map_area,
             c.first_name||' '||c.last_name as child_name
      FROM incidents i
      JOIN children c ON c.id=i.child_id
      WHERE i.parent_signature_token=$1
    `, [req.params.token]);
    if (!rows.length) return res.status(404).json({ error: 'Invalid or expired link' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /sign/:token — parent signs the incident form
router.post('/sign/:token', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE incidents SET parent_signed_at=NOW() WHERE parent_signature_token=$1
         AND parent_signed_at IS NULL
       RETURNING id, parent_signed_at`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Link already used or not found' });
    res.json({ ok: true, signed_at: rows[0].parent_signed_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/sign-off — manager signs off incident
router.post('/:id/sign-off', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE incidents SET manager_reviewed=true, manager_reviewed_at=NOW(),
         manager_sign_off_at=NOW(), manager_signed_by=$2, status='closed'
       WHERE id=$1 RETURNING *`,
      [req.params.id, req.user.id]
    );
    recordAudit({ req, action: 'sign-off', entity_type: 'incident', entity_id: req.params.id });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
