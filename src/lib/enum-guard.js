/**
 * enum-guard — turn CHECK-constraint violations into usable 400s.
 *
 * Added 2026-09-08 after the b280 simulation harness found three routes
 * (observation_type, nappy_state, meal_type) passing client values straight
 * to Postgres. A CHECK violation came back as a 500 carrying the raw
 * `violates check constraint "…"` text: unhelpful to the caller and a schema
 * leak. It matters in practice because the EY portal is an installed PWA, so a
 * tablet on a stale build genuinely sends values the server has since dropped.
 *
 * Values are read from the live catalogue at boot, not hard-coded, so a schema
 * change cannot leave a stale copy here — the one failure mode a hand-written
 * list always eventually hits.
 */
const CACHE = new Map();

/** Parse the allowed values out of a CHECK constraint definition. */
function parseAllowed(def) {
  // CHECK ((col = ANY (ARRAY['a'::text, 'b'::text])))
  const m = /ARRAY\[(.+?)\]/s.exec(def || '');
  if (!m) return null;
  const out = [];
  const re = /'((?:[^']|'')*)'/g;
  let g;
  while ((g = re.exec(m[1]))) out.push(g[1].replace(/''/g, "'"));
  return out.length ? out : null;
}

/**
 * Allowed values for ladn.<table>.<column>, or null when the column carries no
 * CHECK (in which case the caller must not reject anything).
 */
async function allowedValues(db, table, column) {
  const key = `${table}.${column}`;
  if (CACHE.has(key)) return CACHE.get(key);
  let vals = null;
  try {
    const { rows } = await db.query(
      `SELECT pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'ladn' AND c.relname = $1 AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) LIKE '%' || $2 || '%'`,
      [table, column]
    );
    // A column can carry more than one CHECK (observations.observation_type carries
    // two). Postgres enforces every one of them, so the effective set is the
    // INTERSECTION — using the permissive one would let through a value that then
    // 500s on the stricter one, which is the exact bug this module exists to stop.
    for (const r of rows) {
      const parsed = parseAllowed(r.def);
      if (!parsed) continue;
      vals = vals === null ? parsed : vals.filter(v => parsed.includes(v));
    }
  } catch (_) {
    vals = null; // never let the guard itself break a write
  }
  CACHE.set(key, vals);
  return vals;
}

/**
 * Returns null when ok, or a {error, field, allowed} body to send with a 400.
 * A null/undefined value is always allowed — absence is the caller's business,
 * this guard only judges values that were actually supplied.
 */
async function checkEnum(db, table, column, value) {
  if (value === undefined || value === null || value === '') return null;
  const allowed = await allowedValues(db, table, column);
  if (!allowed || allowed.includes(value)) return null;
  return {
    error: `Invalid ${column}: ${JSON.stringify(value)}`,
    field: column,
    allowed,
  };
}

module.exports = { checkEnum, allowedValues, _parseAllowed: parseAllowed };
