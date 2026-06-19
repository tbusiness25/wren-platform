const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET /roles — all roles with their capability levels
router.get('/roles', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT r.id, r.key, r.display_name, r.description, r.is_built_in,
        json_object_agg(c.key, rc.level) FILTER (WHERE c.key IS NOT NULL) AS capabilities
      FROM ladn.roles r
      LEFT JOIN ladn.role_capabilities rc ON rc.role_id = r.id
      LEFT JOIN ladn.capabilities c ON c.id = rc.capability_id
      GROUP BY r.id ORDER BY r.id
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /capabilities — all capabilities grouped by category
router.get('/capabilities', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT * FROM ladn.capabilities ORDER BY category, id'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /roles/:roleKey/capabilities/:capKey — set level
router.patch('/roles/:roleKey/capabilities/:capKey', async (req, res) => {
  const { roleKey, capKey } = req.params;
  const { level } = req.body;
  const validLevels = ['view', 'edit', 'approve', 'manage', null, ''];
  if (!validLevels.includes(level)) return res.status(400).json({ error: 'Invalid level' });
  const db = getPool();
  try {
    const roleRes = await db.query('SELECT id FROM ladn.roles WHERE key=$1', [roleKey]);
    const capRes  = await db.query('SELECT id FROM ladn.capabilities WHERE key=$1', [capKey]);
    if (!roleRes.rows[0] || !capRes.rows[0]) return res.status(404).json({ error: 'Role or capability not found' });
    const roleId = roleRes.rows[0].id;
    const capId  = capRes.rows[0].id;

    // Read old level for audit
    const old = await db.query(
      'SELECT level FROM ladn.role_capabilities WHERE role_id=$1 AND capability_id=$2',
      [roleId, capId]
    );
    const oldLevel = old.rows[0]?.level || null;

    if (!level) {
      await db.query('DELETE FROM ladn.role_capabilities WHERE role_id=$1 AND capability_id=$2', [roleId, capId]);
    } else {
      await db.query(`
        INSERT INTO ladn.role_capabilities (role_id, capability_id, level)
        VALUES ($1,$2,$3)
        ON CONFLICT (role_id, capability_id) DO UPDATE SET level=$3
      `, [roleId, capId, level]);
    }

    // Audit
    await db.query(`
      INSERT INTO ladn.permissions_audit (changed_by, role_key, capability_key, old_level, new_level)
      VALUES ($1,$2,$3,$4,$5)
    `, [req.user.id, roleKey, capKey, oldLevel, level || null]);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /staff-assignments — staff with their assigned roles
router.get('/staff-assignments', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT s.id, s.first_name || ' ' || s.last_name AS name, s.role AS legacy_role,
        json_agg(json_build_object('role_key', r.key, 'role_name', r.display_name,
          'assigned_at', sra.assigned_at)) FILTER (WHERE r.key IS NOT NULL) AS roles
      FROM ladn.staff s
      LEFT JOIN ladn.staff_role_assignments sra ON sra.staff_id = s.id
      LEFT JOIN ladn.roles r ON r.id = sra.role_id
      WHERE s.is_active = true
      GROUP BY s.id ORDER BY s.id
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /staff-assignments — assign role to staff
router.post('/staff-assignments', async (req, res) => {
  const { staff_id, role_key } = req.body;
  if (!staff_id || !role_key) return res.status(400).json({ error: 'staff_id and role_key required' });
  const db = getPool();
  try {
    const roleRes = await db.query('SELECT id FROM ladn.roles WHERE key=$1', [role_key]);
    if (!roleRes.rows[0]) return res.status(404).json({ error: 'Role not found' });
    await db.query(`
      INSERT INTO ladn.staff_role_assignments (staff_id, role_id, assigned_by)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
    `, [staff_id, roleRes.rows[0].id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /staff-assignments — remove role from staff
router.delete('/staff-assignments', async (req, res) => {
  const { staff_id, role_key } = req.body;
  const db = getPool();
  try {
    await db.query(`
      DELETE FROM ladn.staff_role_assignments sra
      USING ladn.roles r
      WHERE sra.role_id = r.id AND sra.staff_id=$1 AND r.key=$2
    `, [staff_id, role_key]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /approval-queue
router.get('/approval-queue', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT aq.*, s.first_name || ' ' || s.last_name AS staff_name
      FROM ladn.approval_queue aq
      JOIN ladn.staff s ON s.id = aq.staff_id
      WHERE aq.status = 'pending'
      ORDER BY aq.submitted_at
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /approval-queue/:id — approve or reject
router.patch('/approval-queue/:id', async (req, res) => {
  const { status, notes } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      UPDATE ladn.approval_queue
      SET status=$1, reviewed_by=$2, reviewed_at=now(), notes=$3
      WHERE id=$4 RETURNING *
    `, [status, req.user.id, notes||null, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Per-staff capability overrides (added 2026-06-06) ────────────────────────
// Lets a manager grant/revoke a capability for an individual staff member,
// regardless of their role (EyLog-style per-practitioner permissions).
// Primary use: medicine_record / medicine_signoff opt-in per staff.
// Manager-only (or Toby id=1); every change audited to permissions_audit.
function isManager(user) {
  return Number(user.id) === 1 || user.role === 'manager' || user.role === 'admin';
}

// GET /staff/:id/capabilities — per-staff overrides for one staff member
router.get('/staff/:id/capabilities', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager access required' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT c.key, c.display_name, c.category, sc.level, sc.granted_at, sc.granted_by
      FROM ladn.staff_capabilities sc
      JOIN ladn.capabilities c ON c.id = sc.capability_id
      WHERE sc.staff_id = $1
      ORDER BY c.category, c.key
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /staff/:id/capabilities/:capKey — grant or revoke a capability for staff
// Body: { level: 'view'|'edit'|'approve'|'manage' } to grant; null/'' to revoke.
router.put('/staff/:id/capabilities/:capKey', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager access required' });
  const staffId = parseInt(req.params.id, 10);
  const { capKey } = req.params;
  const { level } = req.body || {};
  const validLevels = ['view', 'edit', 'approve', 'manage', null, ''];
  if (!validLevels.includes(level)) return res.status(400).json({ error: 'Invalid level' });
  const db = getPool();
  try {
    const staffRes = await db.query('SELECT id FROM ladn.staff WHERE id=$1', [staffId]);
    const capRes   = await db.query('SELECT id FROM ladn.capabilities WHERE key=$1', [capKey]);
    if (!staffRes.rows[0]) return res.status(404).json({ error: 'Staff not found' });
    if (!capRes.rows[0])   return res.status(404).json({ error: 'Capability not found' });
    const capId = capRes.rows[0].id;

    const old = await db.query(
      'SELECT level FROM ladn.staff_capabilities WHERE staff_id=$1 AND capability_id=$2',
      [staffId, capId]
    );
    const oldLevel = old.rows[0]?.level || null;

    if (!level) {
      await db.query('DELETE FROM ladn.staff_capabilities WHERE staff_id=$1 AND capability_id=$2', [staffId, capId]);
    } else {
      await db.query(`
        INSERT INTO ladn.staff_capabilities (staff_id, capability_id, level, granted_by, granted_at)
        VALUES ($1,$2,$3,$4, now())
        ON CONFLICT (staff_id, capability_id) DO UPDATE SET level=$3, granted_by=$4, granted_at=now()
      `, [staffId, capId, level, req.user.id]);
    }

    // Audit (role_key column repurposed to record the staff target as 'staff:ID')
    await db.query(`
      INSERT INTO ladn.permissions_audit (changed_by, role_key, capability_key, old_level, new_level)
      VALUES ($1,$2,$3,$4,$5)
    `, [req.user.id, `staff:${staffId}`, capKey, oldLevel, level || null]);

    res.json({ ok: true, staff_id: staffId, capability: capKey, level: level || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
