'use strict';
/**
 * ratio-eligibility — the single answer to "does this person count in ratio, and
 * at what level?"
 *
 * It lives in its own module because BOTH `src/lib/offratio.js` (the rota's
 * per-slot view) and `src/services/ratio-engine.js` (the absence gatekeeper) need
 * it, and offratio already requires ratio-engine — so putting it in either one
 * would create a circular require. They disagreeing is the actual failure mode:
 * the gatekeeper would let someone book leave that the rota then shows as
 * under-ratio.
 *
 * 2026-09-04. Replaces two divergent copies, one of which excluded two people by
 * matching their FIRST NAME (/\b(hetty|clare)\b/i) — which silently caught every
 * future the chef or the office manager and broke on any change of name. Those are now
 * `staff.counts_on_ratio = false` rows.
 */

// Roles that do not count towards ratio unless a manager says otherwise.
//
// b271 (2026-09-04) — this list is the whole point of the role rename. Toby:
// "Change Manager role to admin - dont add us to ratios/absences etc - Me and
// the business manager. Change deputy role to Manager." So:
//   'manager' REMOVED — the three ex-deputies (the room leader, a practitioner, the deputy) are on the
//             floor every day and have always counted in practice; the old list
//             excluded them the moment they were renamed.
//   'admin'   ADDED   — Toby, the business manager and the office manager run the business and are not
//             counted, which is what they were getting from 'manager' before.
// A per-person `staff.counts_on_ratio` override still wins over the role.
const EXCLUDED_ROLES = ['admin', 'owner', 'chef', 'cook'];

// EYFS lets a 16+ apprentice working towards a level 2 or 3 qualification count in
// ratio AT LEVEL 2, but only where the provider judges them competent. That is a
// judgement about a person, reviewed as they progress — not a property of the role.
// So `staff.ratio_level` wins, and the role is only the fallback for people nobody
// has made a judgement about.
const ROLE_DEFAULT_RATIO_LEVEL = {
  apprentice: 'unqualified',
  practitioner: 'level3',
  room_leader: 'level3',
  senior_practitioner: 'level3',
  deputy_manager: 'level3',
  manager: 'level3',
  // b271: admin/owner are EXCLUDED_ROLES so this level is only ever read if a
  // per-person counts_on_ratio=true override puts an owner back on the floor
  // (e.g. covering a room in an emergency). Level 3 is correct for all three.
  admin: 'level3',
  owner: 'level3',
  headteacher: 'level6',
};

const RATIO_LEVELS = ['unqualified', 'level2', 'level3', 'level6'];
const RATIO_LEVEL_LABELS = {
  unqualified: 'Unqualified',
  level2: 'Level 2',
  level3: 'Level 3',
  level6: 'Level 6 / EYT',
};

/** true/false from the row's own override, else inferred from the role. */
function countsOnRatio(s) {
  if (!s) return false;
  if (s.counts_on_ratio === true)  return true;
  if (s.counts_on_ratio === false) return false;
  return !EXCLUDED_ROLES.includes(String(s.role || '').toLowerCase());
}

/** The level this person counts AT. Manager judgement first, role second. */
function ratioLevelOf(s) {
  if (!s) return null;
  if (s.ratio_level) return s.ratio_level;
  return ROLE_DEFAULT_RATIO_LEVEL[String(s.role || '').toLowerCase()] || 'unqualified';
}

module.exports = {
  EXCLUDED_ROLES, ROLE_DEFAULT_RATIO_LEVEL,
  RATIO_LEVELS, RATIO_LEVEL_LABELS,
  countsOnRatio, ratioLevelOf,
};
