'use strict';
// ============================================================================
// ENROLMENT LIFECYCLE (b96, 2026-07-17)
// children.enrolment_status (nullable TEXT): 'confirmed' | 'attending' | 'left'
//   confirmed = registered / deposit paid but NOT started yet → hidden from
//               operational surfaces (register, diary, planning, kitchen, EY
//               children grid) but COUNTED in occupancy forecasts from their
//               start month.
//   attending = currently at nursery (default for legacy NULL).
//   left      = leave_date passed (nightly roll also sets is_active=false).
// NOTE: this is deliberately SEPARATE from the existing `status` column, which
// the enquiry-portal / onboarding-invites pipeline uses ('enquiry' → 'active')
// and finance-forecast counts on. Do not merge them.
//
// Rolling is done by scripts/enrolment-status-roll.js (nightly cron).
// One-time prod backfill SQL: ladn-ready/logs/b96-enrolment-lifecycle.NOTES.md
// ============================================================================

const ENROLMENT_STATUSES = ['confirmed', 'attending', 'left'];

// SQL fragment: children who should appear on OPERATIONAL surfaces today.
// NULL enrolment_status is treated as 'attending' (legacy rows), but a future
// start_date always excludes regardless — so brand-new future starters are
// hidden even before the nightly roll / backfill has touched them.
function operationalChildFilter(alias = 'c') {
  const a = alias ? alias + '.' : '';
  return `(${a}is_active = true
    AND COALESCE(${a}enrolment_status, 'attending') NOT IN ('confirmed', 'left')
    AND (${a}start_date IS NULL OR ${a}start_date <= CURRENT_DATE))`;
}

// Computed column for SELECTs — what the status *effectively* is right now,
// even where the column hasn't been backfilled yet.
function effectiveStatusSQL(alias = 'c') {
  const a = alias ? alias + '.' : '';
  return `COALESCE(${a}enrolment_status,
    CASE WHEN ${a}start_date > CURRENT_DATE THEN 'confirmed' ELSE 'attending' END)`;
}

// Lazy, idempotent, per-process: make sure the column exists in whatever
// schema this edition's pool points at (ladn, demo_*, childrenscorner, htps…)
// so shared routes never 500 on a schema the migration hasn't reached.
let _ensured = false;
async function ensureEnrolmentColumn(db) {
  if (_ensured) return;
  try {
    await db.query(`ALTER TABLE children ADD COLUMN IF NOT EXISTS enrolment_status TEXT`);
    _ensured = true;
  } catch (e) {
    // non-fatal (e.g. read-only session); queries fall back to erroring visibly
    console.error('[enrolment] ensure column failed:', e.message);
  }
}

// Express middleware wrapper (one line to add per patched route file)
function ensureEnrolmentMiddleware(getPool) {
  return (req, res, next) => { ensureEnrolmentColumn(getPool()).finally(() => next()); };
}

module.exports = {
  ENROLMENT_STATUSES,
  operationalChildFilter,
  effectiveStatusSQL,
  ensureEnrolmentColumn,
  ensureEnrolmentMiddleware,
};
