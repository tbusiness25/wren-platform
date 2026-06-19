/**
 * Wren — Scope Filter Middleware
 *
 * Reads the JWT's scope + scope_value (injected at login, stored in token),
 * and appends a WHERE clause to relevant queries via req.scopeFilter.
 *
 * Rules:
 *   scope = 'all'        → no filter (sees everything)
 *   scope = 'year_group' → WHERE year_group = scope_value
 *   scope = 'class'      → WHERE form_group = scope_value (secondary/primary)
 *                          WHERE room      = scope_value  (EYFS)
 *   scope = 'room'       → WHERE room_id  = scope_value  (EYFS room_id variant)
 *
 * Scoped roles (may be limited):  teacher, practitioner, ta, cover_supervisor, room_leader
 * Always unrestricted:            manager, deputy_manager, headteacher, admin, senco,
 *                                 it_technician, business_manager, cook
 *
 * Filtered routes:  /api/children, /api/students, /api/observations,
 *                   /api/attendance, /api/behaviour, /api/assessments,
 *                   /api/behaviour-secondary, /api/behaviour-primary
 *
 * Usage in server.js (after authenticate middleware):
 *   const scopeFilter = require('../../src/middleware/scope-filter');
 *   app.use(scopeFilter);
 */

const SCOPED_ROUTES = [
  '/api/children',
  '/api/observations',
  '/api/attendance',
  '/api/attendance-register',
  '/api/behaviour',
  '/api/behaviour-secondary',
  '/api/behaviour-primary',
  '/api/assessments',
  '/api/assessments-secondary',
  '/api/assessments-primary',
];

// Roles that are always unscoped regardless of DB value
const UNRESTRICTED_ROLES = new Set([
  'manager', 'deputy_manager', 'headteacher', 'admin', 'senco',
  'it_technician', 'business_manager', 'cook',
]);

/**
 * Build a SQL WHERE fragment and params for scope filtering.
 * Returns { sql: string, params: any[] } or null if no filter needed.
 * Caller is responsible for starting param index ($N).
 *
 * @param {object} scopeInfo  - { scope, scope_value } from JWT or DB
 * @param {number} startIdx   - starting $N param index (default 1)
 */
function buildScopeSQL(scopeInfo, startIdx = 1) {
  if (!scopeInfo) return null;
  const { scope, scope_value: val } = scopeInfo;
  if (!scope || scope === 'all' || !val) return null;

  switch (scope) {
    case 'year_group':
      return { sql: `year_group = $${startIdx}`, params: [val] };
    case 'class':
      // Support both secondary (form_group) and EYFS/primary (room column)
      return {
        sql: `(form_group = $${startIdx} OR room = $${startIdx})`,
        params: [val],
      };
    case 'room':
      return { sql: `room_id = $${startIdx}`, params: [val] };
    default:
      return null;
  }
}

/**
 * Express middleware.
 * Attaches req.scopeFilter = { sql, params } or req.scopeFilter = null.
 * Also provides req.isScopedRoute(path) helper.
 */
module.exports = function scopeFilter(req, res, next) {
  const user = req.user; // set by authenticate middleware

  // Default: no filter
  req.scopeFilter = null;
  req.isScopedRoute = (path) =>
    SCOPED_ROUTES.some(r => path.startsWith(r));

  if (!user) return next();

  // Unrestricted roles always see everything
  if (UNRESTRICTED_ROLES.has(user.role)) return next();

  // Scoped roles — use scope from JWT (set at login, sourced from DB)
  const scope = user.scope || 'all';
  const scope_value = user.scope_value || null;

  req.scopeFilter = buildScopeSQL({ scope, scope_value });
  next();
};

module.exports.buildScopeSQL = buildScopeSQL;
module.exports.SCOPED_ROUTES = SCOPED_ROUTES;
module.exports.UNRESTRICTED_ROLES = UNRESTRICTED_ROLES;
