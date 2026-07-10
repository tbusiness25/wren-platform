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
// roles. The staff table uses 'deputy_manager' but the roles table key is
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
  // headteacher = school manager-equivalent (no such role exists on LADN, so this
  // is a no-op for the nursery; it unlocks capability-gated features — e.g.
  // medicine — for the top authority on the school editions/demos).
  if (Number(user.id) === 1) return true;
  if (user.role === 'manager' || user.role === 'headteacher') return true;

  const roleKey = roleKeyFor(user);
  const db = getPool();
  try {
    const { rows } = await db.query(
      `
      SELECT 1
      FROM capabilities c
      WHERE c.key = $1
        AND (
          EXISTS (
            SELECT 1
            FROM role_capabilities rc
            JOIN roles r ON r.id = rc.role_id
            WHERE rc.capability_id = c.id
              AND r.key = $2
              AND rc.level IS NOT NULL
              AND rc.level <> ''
          )
          OR EXISTS (
            SELECT 1
            FROM staff_capabilities sc
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

// ── Staff salary / pay visibility (added 2026-06-30, PROMPT 35) ──────────────
// Pay/salary is confidential and manager-only. Deputy managers keep HOURS and
// work patterns but must NOT see pay. These are the staff columns considered
// "pay" — stripped from staff records / 403'd on finance routes for anyone who
// is not a salary-viewer. ('salary' is listed defensively; LADN only has
// annual_salary, but other editions may add it.)
const SALARY_PAY_FIELDS = [
  'annual_salary', 'salary', 'hourly_rate', 'hourly_rate_pence', 'tax_code',
  'payroll_reference', 'pension_eligible',
  'pension_employee_contribution', 'pension_employer_contribution',
];

// Roles that ALWAYS see staff pay (manager-level + finance authority).
// deputy_manager is deliberately EXCLUDED. business_manager legitimately needs
// pay; headteacher is treated as school-manager-equivalent (default grant).
// admin maps to manager. owner is a defensive alias.
const SALARY_VIEW_ROLES = ['manager', 'headteacher', 'business_manager', 'admin', 'owner'];

/**
 * Can this user view staff salary / pay data?
 * True for Toby (id=1), manager-level roles, business_manager, OR anyone the
 * permissions matrix has granted the `view_staff_salaries` capability (so Toby
 * can toggle it on for the deputy later without a code change).
 * @param {object} user req.user
 * @returns {Promise<boolean>}
 */
async function canViewSalaries(user) {
  if (!user) return false;
  if (Number(user.id) === 1) return true;
  if (SALARY_VIEW_ROLES.includes(user.role)) return true;
  return hasCapability(user, 'view_staff_salaries');
}

/** Express middleware: 403 unless the user can view salaries. */
function requireSalaryView(req, res, next) {
  canViewSalaries(req.user)
    .then(ok => ok
      ? next()
      : res.status(403).json({ error: 'salary_view_forbidden',
          message: 'Salary and pay data is restricted to managers.' }))
    .catch(() => res.status(403).json({ error: 'salary_view_forbidden' }));
}

/** Strip the pay fields from an object in place; returns the same object. */
function stripSalaryFields(obj) {
  if (obj) for (const f of SALARY_PAY_FIELDS) delete obj[f];
  return obj;
}

module.exports = {
  hasCapability, roleKeyFor,
  canViewSalaries, requireSalaryView, stripSalaryFields,
  SALARY_PAY_FIELDS, SALARY_VIEW_ROLES,
};
