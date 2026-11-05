'use strict';
/**
 * b264 — one place that decides which database a Wren process talks to.
 *
 * WHY THIS EXISTS
 *
 * src/db/pool.js reads PG_HOST/PG_PORT/PG_DB/PG_USER/PG_PASSWORD and sets search_path
 * from PG_SCHEMA. Eighteen modules under src/ do NOT use it — they build their own
 * `new Pool(...)` — and sixteen of those read `process.env.PG_DATABASE`. No container
 * sets PG_DATABASE; every container sets PG_DB. So those sixteen ignore whatever the
 * container was configured with and fall through to the literal default, `wren`,
 * which is production.
 *
 * Today that is latent: the editions mounting them all run against `wren` anyway. It
 * stops being latent the moment either of two things happens —
 *
 *   · a dev instance of a school edition is started with PG_DB=wren_dev: those routes
 *     read and write PRODUCTION while every other route on the same process uses dev;
 *   · the tenant/LADN database split (b264 §2) repoints an edition with PG_DB and
 *     PG_HOST: those routes stay pointed at the old instance and quietly keep serving
 *     the old data.
 *
 * The split is only worth doing if the repointing is total, so the resolution has to
 * live in one function that everything shares.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not route by schema, and it deliberately has no table of "which schema lives
 * on which host". Each container already carries its own PG_HOST and PG_DB; the cutover
 * is then an env change per edition and nothing else, which is the property that makes
 * it reversible one edition at a time. Guessing a host from a schema name would put the
 * mapping in code, in a shared image, where a mistake reaches every tenant at once.
 *
 * OPTIONAL ENFORCEMENT (PG_ENFORCE_INSTANCE=true)
 *
 * After the split, set PG_ENFORCE_INSTANCE=true and PG_INSTANCE=<ladn|tenants> on every
 * container. A process whose PG_SCHEMA is `ladn` while PG_INSTANCE says `tenants`, or
 * the reverse, refuses to start. That converts "we repointed everything correctly" from
 * a claim into something the process checks at boot.
 */

const LADN_SCHEMA = 'ladn';

function resolveConnection(overrides = {}) {
  const database =
    overrides.database ||
    process.env.PG_DB ||
    process.env.PG_DATABASE ||     // legacy spelling — kept so nothing regresses
    'wren';
  return {
    host:     overrides.host     || process.env.PG_HOST || 'localhost',
    port:     Number(overrides.port || process.env.PG_PORT || 5434),
    database,
    user:     overrides.user     || process.env.PG_USER || 'wren',
    password: overrides.password !== undefined ? overrides.password : process.env.PG_PASSWORD,
  };
}

function schema() {
  return process.env.PG_SCHEMA || LADN_SCHEMA;
}

/**
 * Boot-time placement check. No-op unless PG_ENFORCE_INSTANCE=true, so it can be
 * added everywhere now and switched on after the cutover.
 * @throws if the schema and the declared instance disagree.
 */
function assertInstancePlacement() {
  if (process.env.PG_ENFORCE_INSTANCE !== 'true') return { enforced: false };
  const inst = process.env.PG_INSTANCE || '';
  const s = schema();
  if (!['ladn', 'tenants'].includes(inst)) {
    throw new Error(
      `PG_ENFORCE_INSTANCE=true but PG_INSTANCE is "${inst || '(unset)'}" — expected "ladn" or "tenants".`);
  }
  const want = s === LADN_SCHEMA ? 'ladn' : 'tenants';
  if (inst !== want) {
    const c = resolveConnection();
    throw new Error(
      `Instance placement mismatch: PG_SCHEMA="${s}" belongs on the "${want}" instance but ` +
      `PG_INSTANCE="${inst}" (connecting to ${c.host}:${c.port}/${c.database}). Refusing to start — ` +
      `this is the check that stops a tenant edition reaching the LADN database after the b264 split.`);
  }
  return { enforced: true, instance: inst, schema: s };
}

/** One-line description for a boot log. Never includes the password. */
function describe() {
  const c = resolveConnection();
  return `${c.user}@${c.host}:${c.port}/${c.database} search_path=${schema()}` +
         (process.env.PG_INSTANCE ? ` instance=${process.env.PG_INSTANCE}` : '');
}

module.exports = { resolveConnection, schema, assertInstancePlacement, describe, LADN_SCHEMA };
