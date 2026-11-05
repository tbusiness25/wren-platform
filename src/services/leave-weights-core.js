// Fair Leave — per-employee weight preferences core (b106, 2026-07-20).
// Points model (b135, 2026-07-22): Toby's call — length-of-service was hard-coded
// neutral 0.5 (no reliable hire-date column) and only ever punished new staff, so
// it's gone. Personal weighting is now an RPG-style POINTS BUDGET: staff spend
// 10 points across the 4 remaining factors, 1–5 points each, must total exactly
// 10. weight = points / 10, so a valid allocation always sums to 1.0 — no bounds-
// vs-manager-default band needed any more (that concept is gone with `service`).
//
// Manager default weights stay as the fallback used to score everyone who has
// NOT set personal points (or when the feature is off): booking_order .40,
// rotation .30, spread .20, notice .10 (old weights renormalised after dropping
// service's .08 — same relative ordering, service's .5-neutral score contributed
// nothing informative anyway).
//
// Anti-gaming, unchanged from b106: changeable at most ONCE per calendar year
// (server-enforced), preview-anytime, manager can see everyone's chosen build.
//
// Protected-characteristic reasons are handled in absence-fairness.js and are
// NEVER scored — nothing here touches that.
'use strict';

// Manager defaults (the fallback weights). Kept in lock-step with
// absence-fairness.js DEFAULT_WEIGHTS.
const DEFAULT_WEIGHTS = {
  booking_order: 0.40,
  rotation: 0.30,
  spread: 0.20,
  notice: 0.10,
};
const FACTOR_KEYS = Object.keys(DEFAULT_WEIGHTS);

const FACTOR_LABELS = {
  booking_order: 'First-come, first-served',
  rotation: 'Turn-taking',
  spread: 'Spreading leave fairly',
  notice: 'Notice given',
};
// One plain-English sentence each — short enough to read aloud at a staff meeting.
const FACTOR_EXPLAIN = {
  booking_order: 'Booking early counts for more when your own claim is scored.',
  rotation: "Missing out on a popular period last year counts in your favour this year.",
  spread: "Having taken less leave so far this year counts for more.",
  notice: 'Giving lots of advance notice counts for more.',
};

const r2 = n => Math.round(n * 10000) / 10000;

// ── Points budget (b135) ──────────────────────────────────────────────────────
const POINTS_TOTAL = 10;
const POINT_MIN = 1;
const POINT_MAX = 5;
// Manager default expressed as points (same ratio as DEFAULT_WEIGHTS: 4:3:2:1).
const DEFAULT_POINTS = { booking_order: 4, rotation: 3, spread: 2, notice: 1 };

// One-tap presets shown above the raw point stepper on the staff page. Order
// matches FACTOR_KEYS: booking_order, rotation, spread, notice.
const PRESETS = [
  {
    key: 'standard', label: 'Standard',
    points: { booking_order: 4, rotation: 3, spread: 2, notice: 1 },
    blurb: "The manager default. If you do nothing, this is what you're on — balanced across all four.",
  },
  {
    key: 'early_planner', label: 'Early planner',
    points: { booking_order: 5, rotation: 2, spread: 1, notice: 2 },
    blurb: 'For people who book far ahead — leans on first-come-first-served and the notice you give.',
  },
  {
    key: 'fair_share', label: 'Fair share',
    points: { booking_order: 2, rotation: 4, spread: 3, notice: 1 },
    blurb: 'Leans on turn-taking and spreading leave fairly across the year.',
  },
];

function pointsToWeights(points) {
  const out = {};
  for (const k of FACTOR_KEYS) out[k] = r2((Number(points && points[k]) || 0) / POINTS_TOTAL);
  return out;
}

// Which preset (if any) the given points allocation exactly matches, else null.
function matchPreset(points) {
  if (!points) return null;
  for (const p of PRESETS) {
    if (FACTOR_KEYS.every(k => Number(points[k]) === p.points[k])) return p.key;
  }
  return null;
}

// Strict validator — total must be exactly 10, each factor a whole number 1–5,
// no unknown/missing keys. Used by PUT (422) and preview so client + server
// enforce identically.
function validatePoints(raw) {
  const violations = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, violations: [{ factor: '*', reason: 'points object required' }] };
  }
  const unknown = Object.keys(raw).filter(k => !FACTOR_KEYS.includes(k));
  for (const k of unknown) violations.push({ factor: k, reason: 'unknown factor' });
  const missing = FACTOR_KEYS.filter(k => !(k in raw));
  for (const k of missing) violations.push({ factor: k, label: FACTOR_LABELS[k], reason: 'missing' });

  let total = 0;
  let hasBadType = false;
  for (const k of FACTOR_KEYS) {
    if (!(k in raw)) continue;
    const v = raw[k];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      violations.push({ factor: k, label: FACTOR_LABELS[k], value: v, reason: 'must be a whole number' });
      hasBadType = true;
      continue;
    }
    if (v < POINT_MIN || v > POINT_MAX) {
      violations.push({
        factor: k, label: FACTOR_LABELS[k], value: v, min: POINT_MIN, max: POINT_MAX,
        reason: `must be between ${POINT_MIN} and ${POINT_MAX}`,
      });
      continue;
    }
    total += v;
  }
  if (!missing.length && !hasBadType && total !== POINTS_TOTAL) {
    violations.push({ factor: '*', total, reason: `points must total exactly ${POINTS_TOTAL} (got ${total})` });
  }
  return { ok: violations.length === 0, violations };
}

// ── Manager weights: sanitise + renormalise ──────────────────────────────────
// Drops any key that isn't a current factor (e.g. a stale `service` entry from
// before b135) and renormalises the rest to sum to 1.0, so a legacy settings
// row loads without crashing and without silently under-weighting everything.
function sanitizeManagerWeights(mw) {
  const src = { ...DEFAULT_WEIGHTS, ...(mw || {}) };
  const clean = {};
  let sum = 0;
  for (const k of FACTOR_KEYS) {
    const v = Number(src[k]);
    clean[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_WEIGHTS[k];
    sum += clean[k];
  }
  const out = {};
  for (const k of FACTOR_KEYS) out[k] = r2(sum > 0 ? clean[k] / sum : DEFAULT_WEIGHTS[k]);
  return out;
}

// ── DB: table + reads ─────────────────────────────────────────────────────────
async function ensureTable(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS leave_weight_prefs (
    id       serial PRIMARY KEY,
    staff_id integer NOT NULL UNIQUE REFERENCES staff(id) ON DELETE CASCADE,
    weights  jsonb   NOT NULL,
    set_at   timestamptz NOT NULL DEFAULT now(),
    year     integer NOT NULL
  )`);
}

// Current effective manager weights (settings override, else defaults),
// sanitised against the current factor set. Mirrors absence-fairness.js
// getWeights() — that route now delegates here so the two never disagree.
async function getManagerWeights(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='absence_fairness_weights'`);
    if (rows[0]) {
      const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      return sanitizeManagerWeights(v);
    }
  } catch (_) {}
  return sanitizeManagerWeights(null);
}

// Is personal-weighting switched on? Default ON when the setting is absent.
async function getEnabled(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='leave_personal_weights_enabled'`);
    if (rows[0]) {
      const v = rows[0].value;
      return !(v === 'false' || v === false || v === '0' || v === 0);
    }
  } catch (_) {}
  return true;
}

async function setEnabled(db, enabled, byId) {
  const val = enabled ? 'true' : 'false';
  await db.query(
    `INSERT INTO settings (key, value, updated_by, updated_at)
       VALUES ('leave_personal_weights_enabled', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=now()`,
    [val, byId || null]);
  return enabled;
}

// Raw (points) personal allocation for one staff member, or null if none saved.
// `weights` is the jsonb column name (unchanged from b106); it now stores the
// raw POINTS object, e.g. {"booking_order":4,"rotation":3,"spread":2,"notice":1}.
async function getPersonalRow(db, staffId) {
  try {
    await ensureTable(db);
    const { rows } = await db.query(
      `SELECT staff_id, weights, set_at, year FROM leave_weight_prefs WHERE staff_id=$1`, [staffId]);
    if (!rows[0]) return null;
    const raw = typeof rows[0].weights === 'string' ? JSON.parse(rows[0].weights) : rows[0].weights;
    return { staff_id: rows[0].staff_id, points: raw, set_at: rows[0].set_at, year: rows[0].year };
  } catch (_) { return null; }
}

// The weights to actually use when scoring staffId's claim. Falls back to
// manager weights if personal weighting is off or none are saved.
async function getEffectiveWeightsFor(db, staffId, managerWeights, enabled) {
  const mgrClean = sanitizeManagerWeights(managerWeights);
  if (!enabled) return { weights: mgrClean, personal: false };
  const row = await getPersonalRow(db, staffId);
  if (!row) return { weights: mgrClean, personal: false };
  return { weights: pointsToWeights(row.points), personal: true };
}

// Prefetch personal weights (converted from points) for a set of staff ids in
// one query — used by /rank so it stays a single extra round-trip.
async function getEffectiveWeightsMap(db, staffIds, managerWeights, enabled) {
  const map = {};
  if (!enabled || !staffIds || !staffIds.length) return map;
  try {
    await ensureTable(db);
    const { rows } = await db.query(
      `SELECT staff_id, weights FROM leave_weight_prefs WHERE staff_id = ANY($1)`, [staffIds]);
    for (const row of rows) {
      const raw = typeof row.weights === 'string' ? JSON.parse(row.weights) : row.weights;
      map[row.staff_id] = pointsToWeights(raw);
    }
  } catch (_) {}
  return map;
}

// ── Worked example (no real data) ─────────────────────────────────────────────
// Three synthetic competitors with fixed factor profiles, so the employee can
// see how spending their points differently changes where THEY would land.
const WORKED_EXAMPLE = [
  { key: 'you', name: 'You', factors: { booking_order: 0.55, rotation: 1.0, spread: 0.80, notice: 0.60 } },
  { key: 'a',   name: 'A colleague who booked earlier',   factors: { booking_order: 1.0, rotation: 0.0, spread: 0.45, notice: 0.85 } },
  { key: 'b',   name: "A colleague who's taken less leave", factors: { booking_order: 0.30, rotation: 1.0, spread: 1.0, notice: 0.35 } },
];

function scoreWith(weights, factors) {
  let s = 0;
  for (const k of FACTOR_KEYS) s += (weights[k] || 0) * (factors[k] || 0);
  return r2(s);
}

// Rank the worked example under a given weight-set. Returns the ordered list
// plus where "You" land.
function rankWorkedExample(weights) {
  const scored = WORKED_EXAMPLE.map(c => ({ key: c.key, name: c.name, score: scoreWith(weights, c.factors) }));
  scored.sort((a, b) => b.score - a.score);
  const youIndex = scored.findIndex(c => c.key === 'you');
  return { order: scored, you_rank: youIndex + 1, of: scored.length };
}

module.exports = {
  DEFAULT_WEIGHTS, FACTOR_KEYS, FACTOR_LABELS, FACTOR_EXPLAIN,
  POINTS_TOTAL, POINT_MIN, POINT_MAX, DEFAULT_POINTS, PRESETS,
  r2, pointsToWeights, matchPreset, validatePoints, sanitizeManagerWeights,
  ensureTable, getManagerWeights, getEnabled, setEnabled,
  getPersonalRow, getEffectiveWeightsFor, getEffectiveWeightsMap,
  rankWorkedExample, WORKED_EXAMPLE,
};
