const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const { roleKeyFor, rawRole, isOwnerRole, OWNER_ONLY_CAPS } = require('../lib/capabilities'); // b271
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth');

router.use(authenticate);

// Security (2026-06-22): any authenticated staff could previously PATCH role
// capabilities / POST staff-assignments (no role check), letting a practitioner
// grant themselves any capability and bypass the whole matrix. Lock all MUTATING
// permission changes to manager/owner; GETs (roles/capabilities/me) stay readable.
function _isPermAdmin(u) {
  return !!u && (Number(u.id) === 1 || u.role === 'manager' || u.role === 'admin' || u.role === 'headteacher');
}
router.use((req, res, next) => {
  if (req.method === 'GET') return next();
  if (_isPermAdmin(req.user)) return next();
  return res.status(403).json({ error: 'Manager access required to change permissions' });
});
// sec-20261026: OWNER_ONLY_CAPS (view_staff_salaries) exists so a floor manager
// (role 'manager') does NOT see colleagues' pay — but the two capability-write
// routes below let that same manager grant it, to their own role key or to
// themselves, and canViewSalaries() then honours the grant. Only an owner may
// write an owner-only capability, and only an owner may assign a role key that
// carries one.
router.use(async (req, res, next) => {
  if (req.method === 'GET' || isOwnerRole(req.user)) return next();
  const m = /^\/(?:roles\/[^/]+|staff\/[^/]+)\/capabilities\/([^/]+)\/?$/.exec(req.path);
  if (m && OWNER_ONLY_CAPS.has(decodeURIComponent(m[1]))) {
    return res.status(403).json({ error: 'owner_only', message: 'Only an owner can change this permission.' });
  }
  if (req.path === '/staff-assignments' && req.method === 'POST' && req.body && req.body.role_key) {
    try {
      const { rows } = await getPool().query(
        `SELECT 1 FROM role_capabilities rc JOIN roles r ON r.id = rc.role_id JOIN capabilities c ON c.id = rc.capability_id
          WHERE r.key = $1 AND c.key = ANY($2::text[]) LIMIT 1`, [req.body.role_key, [...OWNER_ONLY_CAPS]]);
      if (rows.length) return res.status(403).json({ error: 'owner_only', message: 'Only an owner can assign this role.' });
    } catch (e) { return res.status(500).json({ error: 'permission check failed' }); }
  }
  next();
});

// GET /roles — all roles with their capability levels
router.get('/roles', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT r.id, r.key, r.display_name, r.description, r.is_built_in,
        json_object_agg(c.key, rc.level) FILTER (WHERE c.key IS NOT NULL) AS capabilities
      FROM roles r
      LEFT JOIN role_capabilities rc ON rc.role_id = r.id
      LEFT JOIN capabilities c ON c.id = rc.capability_id
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
      'SELECT * FROM capabilities ORDER BY category, id'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /me — capability keys the CURRENT user holds (role + per-staff), for nav gating.
// Mirrors src/lib/capabilities.hasCapability resolution. Managers hold everything.
router.get('/me', async (req, res) => {
  const db = getPool();
  const u = req.user || {};
  // b271: this used to read `u.role === 'manager'`, which after the rename is the
  // FLOOR manager. Left alone, an owner (role 'admin') would have fallen to the
  // else-branch with roleKey 'admin' — a key no roles row has — and been handed an
  // EMPTY capability list, blanking their whole nav. Resolve through the shared
  // helpers so this screen and src/lib/capabilities.js can never disagree again.
  const isOwner = isOwnerRole(u);
  // The floor manager holds everything except the owner-only capabilities.
  const isFloorManager = rawRole(u) === 'manager';
  try {
    let keys;
    if (isOwner || isFloorManager) {
      const { rows } = await db.query('SELECT key FROM capabilities');
      keys = rows.map(r => r.key)
        .filter(k => isOwner || !OWNER_ONLY_CAPS.has(k));
    } else {
      const roleKey = roleKeyFor(u);
      const { rows } = await db.query(`
        SELECT DISTINCT c.key FROM capabilities c
        WHERE EXISTS (
            SELECT 1 FROM role_capabilities rc JOIN roles r ON r.id=rc.role_id
            WHERE rc.capability_id=c.id AND r.key=$1 AND rc.level IS NOT NULL AND rc.level<>'' )
           OR EXISTS (
            SELECT 1 FROM staff_capabilities sc
            WHERE sc.capability_id=c.id AND sc.staff_id=$2 AND sc.level IS NOT NULL AND sc.level<>'' )
      `, [roleKey, Number(u.id)]);
      keys = rows.map(r => r.key);
    }
    res.json({ id: u.id, role: u.role, manager: isOwner || isFloorManager, owner: isOwner, capabilities: keys });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /enforcement — b237: which capabilities are actually READ by a route.
// The Permissions screen shows this next to every row so a capability nothing
// enforces is visibly marked "not enforced yet". Before b237 four route files
// out of 267 consulted the matrix, so most of the grid was decorative — the
// screen has to say so rather than imply a control that does not exist.
// Source of truth: src/lib/capability-routes.js (hand-maintained, one line per
// gated route). No DB access, no personal data — safe for any authenticated user.
router.get('/enforcement', (req, res) => {
  try {
    const { GATED_ROUTES, enforcementCounts } = require('../lib/capability-routes');
    res.json({ counts: enforcementCounts(), routes: GATED_ROUTES, total: GATED_ROUTES.length });
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
    const roleRes = await db.query('SELECT id FROM roles WHERE key=$1', [roleKey]);
    const capRes  = await db.query('SELECT id FROM capabilities WHERE key=$1', [capKey]);
    if (!roleRes.rows[0] || !capRes.rows[0]) return res.status(404).json({ error: 'Role or capability not found' });
    const roleId = roleRes.rows[0].id;
    const capId  = capRes.rows[0].id;

    // Read old level for audit
    const old = await db.query(
      'SELECT level FROM role_capabilities WHERE role_id=$1 AND capability_id=$2',
      [roleId, capId]
    );
    const oldLevel = old.rows[0]?.level || null;

    if (!level) {
      await db.query('DELETE FROM role_capabilities WHERE role_id=$1 AND capability_id=$2', [roleId, capId]);
    } else {
      await db.query(`
        INSERT INTO role_capabilities (role_id, capability_id, level)
        VALUES ($1,$2,$3)
        ON CONFLICT (role_id, capability_id) DO UPDATE SET level=$3
      `, [roleId, capId, level]);
    }

    // Audit
    await db.query(`
      INSERT INTO permissions_audit (changed_by, role_key, capability_key, old_level, new_level)
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
      FROM staff s
      LEFT JOIN staff_role_assignments sra ON sra.staff_id = s.id
      LEFT JOIN roles r ON r.id = sra.role_id
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
    const roleRes = await db.query('SELECT id FROM roles WHERE key=$1', [role_key]);
    if (!roleRes.rows[0]) return res.status(404).json({ error: 'Role not found' });
    await db.query(`
      INSERT INTO staff_role_assignments (staff_id, role_id, assigned_by)
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
      DELETE FROM staff_role_assignments sra
      USING roles r
      WHERE sra.role_id = r.id AND sra.staff_id=$1 AND r.key=$2
    `, [staff_id, role_key]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /approval-queue
router.get('/approval-queue', async (req, res) => {
  // 29 Oct: GETs skip the router's manager gate; this one lists every pending request with names.
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'owner'])) return res.status(403).json({ error: 'Managers only' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT aq.*, s.first_name || ' ' || s.last_name AS staff_name
      FROM approval_queue aq
      JOIN staff s ON s.id = aq.staff_id
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
      UPDATE approval_queue
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
  return Number(user.id) === 1 || ['manager', 'admin', 'owner', 'headteacher'].includes(rawRole(user)); // b271
}

// GET /staff/:id/capabilities — per-staff overrides for one staff member
router.get('/staff/:id/capabilities', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager access required' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT c.key, c.display_name, c.category, sc.level, sc.granted_at, sc.granted_by
      FROM staff_capabilities sc
      JOIN capabilities c ON c.id = sc.capability_id
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
    const staffRes = await db.query('SELECT id FROM staff WHERE id=$1', [staffId]);
    const capRes   = await db.query('SELECT id FROM capabilities WHERE key=$1', [capKey]);
    if (!staffRes.rows[0]) return res.status(404).json({ error: 'Staff not found' });
    if (!capRes.rows[0])   return res.status(404).json({ error: 'Capability not found' });
    const capId = capRes.rows[0].id;

    const old = await db.query(
      'SELECT level FROM staff_capabilities WHERE staff_id=$1 AND capability_id=$2',
      [staffId, capId]
    );
    const oldLevel = old.rows[0]?.level || null;

    if (!level) {
      await db.query('DELETE FROM staff_capabilities WHERE staff_id=$1 AND capability_id=$2', [staffId, capId]);
    } else {
      await db.query(`
        INSERT INTO staff_capabilities (staff_id, capability_id, level, granted_by, granted_at)
        VALUES ($1,$2,$3,$4, now())
        ON CONFLICT (staff_id, capability_id) DO UPDATE SET level=$3, granted_by=$4, granted_at=now()
      `, [staffId, capId, level, req.user.id]);
    }

    // Audit (role_key column repurposed to record the staff target as 'staff:ID')
    await db.query(`
      INSERT INTO permissions_audit (changed_by, role_key, capability_key, old_level, new_level)
      VALUES ($1,$2,$3,$4,$5)
    `, [req.user.id, `staff:${staffId}`, capKey, oldLevel, level || null]);

    res.json({ ok: true, staff_id: staffId, capability: capKey, level: level || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2026-09-04 — RATIO COMPETENCY. Appended; nothing above this line changed.
//
// EYFS lets a 16+ apprentice working towards a level 2 or 3 qualification be
// counted in ratio AT LEVEL 2, but only where the provider judges them competent.
// That judgement is per person and gets revisited as they progress, so it is a
// column on `staff`, not a property of the apprentice role — and it is set here,
// on the permissions screen, next to the medicines and accidents overrides,
// because it is the same kind of decision: "this person, specifically, may."
//
// Two separate questions, deliberately not collapsed into one:
//   ratio_level     — at what level do they count?  NULL = infer from role
//   counts_on_ratio — do they count at all?          NULL = infer from role
// ═════════════════════════════════════════════════════════════════════════════

const { RATIO_LEVELS, RATIO_LEVEL_LABELS, countsOnRatio, ratioLevelOf } =
  require('../lib/ratio-eligibility');

// GET /staff/:id/ratio — the effective answer plus whether it is an override.
router.get('/staff/:id/ratio', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager access required' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, role, ratio_level, counts_on_ratio,
              ratio_level_note, ratio_level_set_at, ratio_level_set_by
         FROM staff WHERE id = $1`, [parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    const s = rows[0];
    res.json({
      ...s,
      effective_level: ratioLevelOf(s),
      effective_counts: countsOnRatio(s),
      is_level_override:  s.ratio_level !== null,
      is_counts_override: s.counts_on_ratio !== null,
      levels: RATIO_LEVELS.map(k => ({ key: k, label: RATIO_LEVEL_LABELS[k] })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /staff/:id/ratio — set or clear the overrides.
// Body: { ratio_level, counts_on_ratio, note }. null on either clears it back to
// "infer from role"; omitting a key leaves it untouched.
router.put('/staff/:id/ratio', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager access required' });
  const staffId = parseInt(req.params.id, 10);
  const body = req.body || {};
  const db = getPool();

  if ('ratio_level' in body && body.ratio_level !== null && body.ratio_level !== ''
      && !RATIO_LEVELS.includes(body.ratio_level)) {
    return res.status(400).json({ error: `ratio_level must be null or one of: ${RATIO_LEVELS.join(', ')}` });
  }
  if ('counts_on_ratio' in body && body.counts_on_ratio !== null
      && typeof body.counts_on_ratio !== 'boolean') {
    return res.status(400).json({ error: 'counts_on_ratio must be true, false or null' });
  }

  try {
    const before = await db.query(
      'SELECT ratio_level, counts_on_ratio FROM staff WHERE id=$1', [staffId]);
    if (!before.rows.length) return res.status(404).json({ error: 'Staff not found' });

    const sets = [], vals = [];
    if ('ratio_level' in body) {
      vals.push(body.ratio_level || null); sets.push(`ratio_level = $${vals.length}`);
    }
    if ('counts_on_ratio' in body) {
      vals.push(body.counts_on_ratio === null ? null : !!body.counts_on_ratio);
      sets.push(`counts_on_ratio = $${vals.length}`);
    }
    if ('note' in body) {
      vals.push(String(body.note || '').slice(0, 500) || null);
      sets.push(`ratio_level_note = $${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

    vals.push(req.user.id); sets.push(`ratio_level_set_by = $${vals.length}`);
    sets.push('ratio_level_set_at = now()');
    vals.push(staffId);

    const { rows } = await db.query(
      `UPDATE staff SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, role, ratio_level, counts_on_ratio, ratio_level_note`, vals);
    const s = rows[0];

    // Same audit trail as a capability override — this widens who may be left
    // alone with children, so it should be as traceable as any other grant.
    await db.query(`
      INSERT INTO permissions_audit (changed_by, role_key, capability_key, old_level, new_level)
      VALUES ($1,$2,'ratio.competency',$3,$4)
    `, [req.user.id, `staff:${staffId}`,
        `${before.rows[0].ratio_level || 'role-default'}/${before.rows[0].counts_on_ratio === null ? 'role-default' : before.rows[0].counts_on_ratio}`,
        `${s.ratio_level || 'role-default'}/${s.counts_on_ratio === null ? 'role-default' : s.counts_on_ratio}`]);

    res.json({ ok: true, ...s, effective_level: ratioLevelOf(s), effective_counts: countsOnRatio(s) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
