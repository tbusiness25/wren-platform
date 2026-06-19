// Per-staff + role capability resolution.
// Added 2026-06-06: medicine access moved from hardcoded manager-only gate
// (CLAUDE.md ABSOLUTE RULE 6, superseded by Toby) to a permissions-matrix
// model where an individual staff member can be granted a capability
// regardless of role, mirroring EyLog per-practitioner permissions.
//
// hasCapability(user, capKey) returns true if:
//   - the staff is Toby (id=1) — always true (owner/manager, never lose access)
//   - the staff's role is 'manager' — always true
//   - the staff's role grants the capability (role_capabilities), OR
//   - a per-staff override grants it (staff_capabilities)

const { getPool } = require('../db/pool');

// Map the role string carried in the JWT (req.user.role) onto the key used in
// ladn.roles. The staff table uses 'deputy_manager' but the roles table key is
// 'deputy'; 'admin' is treated as manager-equivalent for capability purposes.
const ROLE_KEY_ALIASES = {
  deputy_manager: 'deputy',
  admin: 'manager',
};

function roleKeyFor(user) {
  const r = (user && user.role) || '';
  return ROLE_KEY_ALIASES[r] || r;
}

/**
 * Resolve whether a user holds a capability.
 * @param {object} user  req.user (must have id and role)
 * @param {string} capKey  capability key, e.g. 'medicine_record'
 * @returns {Promise<boolean>}
 */
async function hasCapability(user, capKey) {
  if (!user) return false;
  // Toby (id=1) and any manager always resolve true — never lose access.
  if (Number(user.id) === 1) return true;
  if (user.role === 'manager') return true;

  const roleKey = roleKeyFor(user);
  const db = getPool();
  try {
    const { rows } = await db.query(
      `
      SELECT 1
      FROM ladn.capabilities c
      WHERE c.key = $1
        AND (
          EXISTS (
            SELECT 1
            FROM ladn.role_capabilities rc
            JOIN ladn.roles r ON r.id = rc.role_id
            WHERE rc.capability_id = c.id
              AND r.key = $2
              AND rc.level IS NOT NULL
              AND rc.level <> ''
          )
          OR EXISTS (
            SELECT 1
            FROM ladn.staff_capabilities sc
            WHERE sc.capability_id = c.id
              AND sc.staff_id = $3
              AND sc.level IS NOT NULL
              AND sc.level <> ''
          )
        )
      LIMIT 1
      `,
      [capKey, roleKey, Number(user.id)]
    );
    return rows.length > 0;
  } catch (e) {
    // Fail closed for capability checks — better to deny than wrongly grant
    // access to medical records on a transient DB error.
    return false;
  }
}

module.exports = { hasCapability, roleKeyFor };
