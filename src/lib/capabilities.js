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
//
// b271 (2026-09-04) — DECISION: the roles TABLE keys are NOT renamed. staff.role
// and roles.key stay separate namespaces and this map stays the only bridge.
// Renaming roles.key would silently orphan every row in another table that
// stores a role key as a string (nav_layout, per-role settings), for no gain:
// the matrix is a permissions surface, not the staff hierarchy. Instead:
//   staff.role 'admin'   -> roles.key 'manager'  (the top matrix row; unchanged)
//   staff.role 'manager' -> roles.key 'deputy'   (NEW — the floor manager, the
//                            ex-deputy; keeps all 52 deputy grants incl. the 7
//                            paperwork.* ones roles.key 'manager' never had)
// Keeping the two rows distinct is also what keeps pay owner-only: 'deputy' has
// no view_staff_salaries grant and 'manager' does. Collapsing them would hand
// three floor managers everyone's salary.
// roles.display_name is updated by migrations/2026-09-04-b271-roles.sql so the
// Permissions screen reads "Admin / Owner" and "Manager" despite the old keys.
const ROLE_KEY_ALIASES = {
  deputy_manager: 'deputy',   // legacy: pre-b271 JWTs still in flight
  manager: 'deputy',          // b271: staff.role 'manager' = floor manager
  admin: 'manager',
  owner: 'manager',
  headteacher: 'manager',     // school top role (auth.js rewrites role, keeps role_original)
  // b237 (2026-08-27): staff.role stores 'room_leader' but the roles table key is
  // 'room-leader'. Without this alias a room leader resolved to a role key that
  // does not exist, so they held NONE of their 43 matrix grants — harmless while
  // nothing read the matrix, actively wrong now that routes do.
  room_leader: 'room-leader',
};

// b271: auth.js rewrites a headteacher's role to 'manager' and stashes the
// original on role_original. After b271 'manager' means FLOOR manager, so
// reading user.role alone would quietly demote every headteacher to the deputy
// matrix row. Always resolve from the original role where one was kept.
function rawRole(user) {
  return String((user && (user.role_original || user.role)) || '');
}

function roleKeyFor(user) {
  const r = rawRole(user);
  return ROLE_KEY_ALIASES[r] || r;
}

// ── b271: who is an OWNER? ──────────────────────────────────────────────────
// The distinction the rename exists to draw. Owners run the business and are
// not on the floor; managers are. Toby (id=1) is hard-coded here for the same
// reason he is hard-coded everywhere else: he must never lose access to his own
// system. 'headteacher' is the school editions' top role.
const OWNER_ROLES = ['admin', 'owner', 'headteacher'];
function isOwnerRole(user) {
  if (!user) return false;
  if (Number(user.id) === 1) return true;
  return OWNER_ROLES.includes(rawRole(user));
}

// Capabilities an owner holds and a floor manager does NOT — the single
// exception to "the new managers gain everything a manager could do" (Toby,
// 2026-09-04). Without this, the blanket manager pass below would return true
// for view_staff_salaries and canViewSalaries()'s fallback would hand three
// floor managers every colleague's pay.
const OWNER_ONLY_CAPS = new Set(['view_staff_salaries']);

// ── b505: capabilities the FLOOR MANAGER's blanket pass does NOT cover ───────
// The blanket pass above exists so the new managers gain everything a manager
// could do. For CCTV it defeats the point of having a capability at all: adding
// requireCapability('security.cameras-view') to a route that is already
// manager-gated would change nothing, and the Permissions screen would show a
// switch that does not switch anything — which is the exact lie b237 exists to
// stop the screen telling.
//
// So these three fall through to the matrix. By default migrations/2026-10-18-b505
// GRANTS them to roles.key 'deputy' as well as 'manager', so b505 changes nobody's
// access on the day it ships; what it changes is that revoking one now actually
// takes footage away.
//
// An OWNER (staff.role admin/owner/headteacher, and Toby at id=1) still always
// passes, for the same reason he is hard-coded everywhere else: he must never
// lock himself out of his own cameras.
//
// This is a NARROWING only. It can never let somebody through a gate they would
// otherwise fail — cameras.js still requires the manager role AND the Roost
// portal AND the opening-hours rule, all of them before this is consulted.
// b511 (2026-10-19) adds the two Building & devices capabilities for the same
// reason. Opening the Zigbee network to anything that asks to join, or removing a
// device from it, is not something every floor manager should hold by default —
// and the office managers who WILL hold it (the office manager, the admissions lead) are not managers at
// all, so they can only ever arrive through the matrix. If these got the blanket
// pass, granting them to the office manager would be the only grant that did anything and
// revoking them from a manager would do nothing.
const MATRIX_REQUIRED_CAPS = new Set([
  'security.cameras-view',
  'security.recordings-view',
  'security.building-control',
  'building.devices.view',
  'building.devices.manage',
  // nest-building (2026-11-02): the Building page on Nest (heating, boiler,
  // kitchen probes, pairing) for Toby's leadership tier. Granted by
  // migrations/2026-11-02-nest-building.sql to roles.key room-leader + deputy
  // (+ manager). Matrix-required for the same reason as the b511 pair: a
  // revoke from the floor manager must actually take it away.
  'building.view',
  'building.manage',
]);
const _blanketPassApplies = capKey => !OWNER_ONLY_CAPS.has(capKey) && !MATRIX_REQUIRED_CAPS.has(capKey);

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
  if (isOwnerRole(user)) return true;
  // b271: the floor manager keeps the blanket pass for everything EXCEPT the
  // owner-only capabilities, which fall through to the matrix (roles.key
  // 'deputy', which grants no salary access).
  if (rawRole(user) === 'manager' && _blanketPassApplies(capKey)) return true;

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

// ── Capability middleware (b237, 2026-08-27) ────────────────────────────────
// The 47-capability x 5-role matrix in role_capabilities was almost entirely
// decorative: only children.js, kitchen.js, medicine.js and permissions.js ever
// read it, so an apprentice's response on /api/incidents was byte-identical to a
// manager's. requireCapability() is the gate the matrix was always missing.
//
// Deliberately mirrors requireSalaryView's shape (a plain express middleware that
// resolves a promise and 403s on rejection) so the two read the same way at the
// call site. hasCapability()'s signature is untouched — b202/b228 depend on it.

// Level ordering for requireCapabilityLevel. A grant of 'manage' satisfies a
// requirement of 'view'; a grant of 'view' does not satisfy 'edit'.
const CAPABILITY_LEVELS = ['view', 'edit', 'approve', 'manage'];
function levelRank(level) {
  const i = CAPABILITY_LEVELS.indexOf(String(level || '').trim());
  return i < 0 ? -1 : i;
}

/**
 * The effective level a user holds for a capability — the HIGHER of their role
 * grant and their per-staff override (an override is meant to widen access, not
 * cap it). Returns null when they hold nothing.
 *
 * Managers/headteacher/Toby resolve to 'manage': they always pass, exactly as
 * hasCapability() already guarantees.
 * @returns {Promise<string|null>}
 */
async function capabilityLevel(user, capKey) {
  if (!user) return null;
  if (isOwnerRole(user)) return 'manage';
  if (rawRole(user) === 'manager' && _blanketPassApplies(capKey)) return 'manage';

  const roleKey = roleKeyFor(user);
  const db = getPool();
  try {
    const { rows } = await db.query(
      `
      SELECT rc.level
      FROM capabilities c
      JOIN role_capabilities rc ON rc.capability_id = c.id
      JOIN roles r ON r.id = rc.role_id
      WHERE c.key = $1 AND r.key = $2 AND rc.level IS NOT NULL AND rc.level <> ''
      UNION ALL
      SELECT sc.level
      FROM capabilities c
      JOIN staff_capabilities sc ON sc.capability_id = c.id
      WHERE c.key = $1 AND sc.staff_id = $3 AND sc.level IS NOT NULL AND sc.level <> ''
      `,
      [capKey, roleKey, Number(user.id)]
    );
    let best = null;
    for (const row of rows) {
      if (levelRank(row.level) > levelRank(best)) best = row.level;
    }
    return best;
  } catch (e) {
    // Fail closed, same as hasCapability — a transient DB error must never widen
    // access. Callers treat null as "holds nothing".
    return null;
  }
}

function _capabilityForbidden(res, capKey, minLevel) {
  return res.status(403).json({
    error: 'capability_forbidden',
    capability: capKey,
    ...(minLevel ? { required_level: minLevel } : {}),
  });
}

/**
 * Express middleware: 403 unless the user holds `capKey` at any level.
 * Toby (id=1), manager and headteacher always pass. Fails closed on a DB error.
 * @param {string} capKey capability key, e.g. 'accidents.create'
 */
function requireCapability(capKey) {
  return function (req, res, next) {
    hasCapability(req.user, capKey)
      .then(ok => (ok ? next() : _capabilityForbidden(res, capKey)))
      .catch(() => _capabilityForbidden(res, capKey));
  };
}

/**
 * Express middleware: 403 unless the user holds `capKey` at `minLevel` or above
 * (view < edit < approve < manage). Use where a route needs write-vs-read
 * separation on the SAME capability key — e.g. accidents.create is 'view' to
 * list accidents but 'edit' to file one.
 * @param {string} capKey
 * @param {'view'|'edit'|'approve'|'manage'} minLevel
 */
function requireCapabilityLevel(capKey, minLevel) {
  const need = levelRank(minLevel);
  if (need < 0) throw new Error(`requireCapabilityLevel: unknown level "${minLevel}"`);
  return function (req, res, next) {
    capabilityLevel(req.user, capKey)
      .then(level => (levelRank(level) >= need
        ? next()
        : _capabilityForbidden(res, capKey, minLevel)))
      .catch(() => _capabilityForbidden(res, capKey, minLevel));
  };
}

// ── Staff salary / pay visibility (added 2026-06-30, PROMPT 35) ──────────────
// Pay/salary is confidential and manager-only. Deputy managers keep HOURS and
// work patterns but must NOT see pay. These are the staff columns considered
// "pay" — stripped from staff records / 403'd on finance routes for anyone who
// is not a salary-viewer. ('salary' is listed defensively; LADN only has
// annual_salary, but other editions may add it.)
// b303 (2026-09-10): the HMRC starter-checklist answers join this list. They are
// what the employer needs to operate PAYE for a named employee — the same
// confidentiality as tax_code, which was already here. `payroll_starter` is the
// derived block src/routes/staff.js builds from them; it is stripped by name so
// the shape can change without reopening the hole.
const SALARY_PAY_FIELDS = [
  'annual_salary', 'fixed_annual_salary', 'salary', 'hourly_rate', 'hourly_rate_pence', 'tax_code',
  'payroll_reference', 'pension_eligible',
  'pension_employee_contribution', 'pension_employer_contribution',
  'starter_declaration', 'student_loan_plan', 'postgrad_loan', 'p45_provided',
  'payroll_starter',
];

// Roles that ALWAYS see staff pay — OWNER-level plus finance authority.
// b271 (2026-09-04): 'manager' REMOVED. Before the rename 'manager' meant Toby,
// the office manager and the business manager; after it, it means the room leader, a practitioner and the deputy, who are on the
// floor and must not see their colleagues' pay. This one line is the difference
// between the rename being correct and it publishing three people's salaries to
// three more people. business_manager legitimately needs pay; headteacher is the
// school editions' owner-equivalent.
const SALARY_VIEW_ROLES = ['admin', 'owner', 'headteacher', 'business_manager'];

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
  if (SALARY_VIEW_ROLES.includes(rawRole(user))) return true;
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
  // b271 — the owner/floor-manager split.
  rawRole, isOwnerRole, OWNER_ROLES, OWNER_ONLY_CAPS, ROLE_KEY_ALIASES,
  // b505 — the three capabilities the floor-manager blanket pass does not cover.
  MATRIX_REQUIRED_CAPS,
  // b237 — the capability gate + its level-aware sibling.
  capabilityLevel, requireCapability, requireCapabilityLevel, CAPABILITY_LEVELS,
  // b429 — exported so a route handler can do its own inline level check
  // (one action, two different required levels depending on what it's about
  // to do) without duplicating the ordering logic.
  levelRank,
  canViewSalaries, requireSalaryView, stripSalaryFields,
  SALARY_PAY_FIELDS, SALARY_VIEW_ROLES,
};
