'use strict';
/**
 * b264 — single-instance guard for shared modules that are NOT per-tenant features.
 *
 * Nearly everything under src/ is a nursery feature: mount it in any edition and it
 * should operate on that edition's own schema. A small number of modules are not.
 * They serve Wren-the-company rather than a setting — getwren.co.uk traffic counts,
 * product-sales leads — and their data is deliberately kept in one place.
 *
 * Before b264 those modules hard-coded `ladn.` and were therefore "safe" only for as
 * long as nobody mounted them elsewhere. De-qualifying them alone would have swapped
 * one silent wrong answer for another: mounted in wren-htps they would quietly start
 * a second, parallel set of marketing counters in the htps schema and nobody would
 * notice for months.
 *
 * So they get this instead — a refusal that is loud at mount time and at request
 * time, naming the module, the schema it found and the schema it needs.
 *
 *   const { singleInstanceOnly } = require('../lib/tenant-guard');
 *   router.use(singleInstanceOnly('analytics', 'getwren.co.uk traffic counters'));
 *
 * The check is on PG_SCHEMA because that is what actually decides which tenant the
 * pool talks to (src/db/pool.js). It is deliberately NOT on hostname or edition name:
 * those can be right while the database connection is wrong, which is the exact
 * failure b258 found.
 */

const HOME_SCHEMA = 'ladn';

function currentSchema() {
  return process.env.PG_SCHEMA || HOME_SCHEMA;
}

/**
 * Express middleware. Refuses every request in this router when the process is
 * pointed at a schema other than the one this module's data lives in.
 *
 * @param {string} moduleName  for the log line and the error body
 * @param {string} what        one clause saying what the data is, for the operator
 */
function singleInstanceOnly(moduleName, what) {
  const schema = currentSchema();
  if (schema !== HOME_SCHEMA) {
    // Mount-time shout. The request-time refusal below is the enforcement; this is
    // so it shows up in `docker logs` at boot rather than only when someone clicks.
    console.error(
      `[tenant-guard] ${moduleName} is single-instance (${what}) and is mounted in a ` +
      `process running against schema "${schema}". Every request to it will be refused. ` +
      `If this edition is meant to have its own ${moduleName}, that is a new feature, ` +
      `not a mount — do not "fix" it by re-qualifying the SQL.`);
  }
  return function tenantGuard(req, res, next) {
    const s = currentSchema();
    if (s === HOME_SCHEMA) return next();
    return res.status(503).json({
      error: 'not available on this instance',
      module: moduleName,
      detail: `${moduleName} holds ${what}, which is kept on the Wren home instance only. ` +
              `This process is connected to schema "${s}".`,
    });
  };
}

/** Same rule, for a non-Express caller (a service, a cron entry point). Throws. */
function assertSingleInstance(moduleName, what) {
  const s = currentSchema();
  if (s !== HOME_SCHEMA) {
    throw new Error(
      `${moduleName} is single-instance (${what}) and this process runs against schema "${s}". Refusing.`);
  }
}

module.exports = { singleInstanceOnly, assertSingleInstance, currentSchema, HOME_SCHEMA };
