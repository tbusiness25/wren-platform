'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b285 — the statutory-first ordering of policies and procedures.
//
// the office manager: "Policies and procedures need to be put in order so safeguarding etc is
// first." Before this, ladn.policies had no order at all: a manager's list came
// back published_at DESC, a practitioner's alphabetically by title, and the
// parents portal alphabetically by title. Three portals, three orders, none of
// them the one an inspector or a new member of staff would expect.
//
// The bands are the ones in the brief:
//
//   1  Safeguarding / Child Protection
//   2  Whistleblowing, Safer Recruitment, Allegations against staff,
//      Mobile phone & camera
//   3  Health & Safety, First Aid, Fire, Medication, Food safety, Intimate care
//   4  SEND / Inclusion / Equality / Behaviour
//   5  Everything else, alphabetically
//
// ── WHY TITLE RULES RUN BEFORE CATEGORY RULES ────────────────────────────────
// The real corpus has both "1.2 Safeguarding" (category "Safeguarding & welfare")
// and "Policy Statement Safeguarding" (category "General policies"). Classifying
// on category alone would put the second one in band 5, below the fire policy.
// So every title rule is tried first, and the category is only a fallback for a
// document whose title says nothing useful.
//
// ── WHY BAND 2 SWEEPS THE REST OF THE SAFEGUARDING CATEGORY ──────────────────
// The brief names four documents for band 2. The corpus has eleven in the
// safeguarding family — uncollected child, missing child, online safety,
// looked-after children, children's rights, relationships with children. Leaving
// those in band 5 would put "Missing child" below "No smoking", which is not
// what "safeguarding etc is first" means. Named documents sort first WITHIN the
// band (rank 0); the rest of the category follows (rank 1).
//
// ── THE NUMBERS ──────────────────────────────────────────────────────────────
// sort_order = band*10000 + rank*1000 + position*10. The gaps are deliberate:
// a drag-and-drop reorder writes explicit integers between neighbours without
// having to renumber the world, and a new policy created through the API lands
// at the end of its band rather than at the top of the list.
// ─────────────────────────────────────────────────────────────────────────────

const BAND = {
  SAFEGUARDING: 1,
  SAFEGUARDING_ADJACENT: 2,
  HEALTH_SAFETY: 3,
  INCLUSION: 4,
  OTHER: 5,
};

// [band, rank, regex] — first match wins, so order matters within this list.
const TITLE_RULES = [
  // ── band 1 — safeguarding and child protection themselves ────────────────
  [BAND.SAFEGUARDING, 0, /\b(safeguarding|child protection|children'?s? rights)\b/i],

  // ── band 2 — the four the brief names, then the rest of the family ───────
  [BAND.SAFEGUARDING_ADJACENT, 0, /\bwhistle\s?-?blow/i],
  [BAND.SAFEGUARDING_ADJACENT, 0, /\bsafer recruit|\brecruitment and vetting\b/i],
  [BAND.SAFEGUARDING_ADJACENT, 0, /\ballegation/i],
  [BAND.SAFEGUARDING_ADJACENT, 0, /\bmobile phone|\bcamera|\bcctv\b|\bphotograph/i],
  [BAND.SAFEGUARDING_ADJACENT, 1, /\bmissing child|\buncollected child|\blooked after children\b/i],
  [BAND.SAFEGUARDING_ADJACENT, 1, /\bonline safety|\be-?safety\b|\bprevent duty\b|\bradicalis/i],
  [BAND.SAFEGUARDING_ADJACENT, 1, /\brelationships with children|\bbabysitting\b/i],
  [BAND.SAFEGUARDING_ADJACENT, 1, /\blockdown|\bemergency plan\b/i],

  // ── band 3 — health, safety and care of the child's body ─────────────────
  [BAND.HEALTH_SAFETY, 0, /\bhealth (and|&) safety\b/i],
  [BAND.HEALTH_SAFETY, 0, /\bfirst aid\b/i],
  [BAND.HEALTH_SAFETY, 0, /\bfire\b/i],
  [BAND.HEALTH_SAFETY, 0, /\bmedicin|\bmedication\b/i],
  [BAND.HEALTH_SAFETY, 0, /\bfood (safety|hygiene|and drink)\b|\bkitchen\b|\ballerg/i],
  [BAND.HEALTH_SAFETY, 0, /\bintimate care|\bnappy|\bnappies|\btoilet training\b/i],
  [BAND.HEALTH_SAFETY, 1, /\brisk assessment|\bpremises\b|\bsecurity on premises\b/i],
  [BAND.HEALTH_SAFETY, 1, /\bsick|\binfectious|\bconjunctivitis|\bcoronavirus|\bcovid/i],
  [BAND.HEALTH_SAFETY, 1, /\bsids\b|\bsudden infant death|\brest and sleep\b|\bsleep\b/i],
  [BAND.HEALTH_SAFETY, 1, /\baccident|\bincident/i],
  [BAND.HEALTH_SAFETY, 1, /\bhealth care plan\b|\bindividual health\b/i],
  [BAND.HEALTH_SAFETY, 1, /\bno smoking|\banimals in the setting|\bhot and cold weather\b/i],
  [BAND.HEALTH_SAFETY, 1, /\boutings? (and|&) visits|\bsupervision of children on outings\b/i],
  [BAND.HEALTH_SAFETY, 1, /\bstaff personal safety\b|\bhome visits\b/i],

  // ── band 4 — inclusion, and how we respond to a child ────────────────────
  [BAND.INCLUSION, 0, /\bsend\b|\bspecial educational|\bsen\b/i],
  [BAND.INCLUSION, 0, /\binclusion\b|\bvaluing diversity|\bdiversity (and|&) equality\b/i],
  [BAND.INCLUSION, 0, /\bequal(ity| opportunities)\b/i],
  [BAND.INCLUSION, 0, /\bbehaviour\b/i],
  [BAND.INCLUSION, 1, /\bbritish values\b/i],
];

// Fallbacks, applied only when no title rule matched.
const CATEGORY_RULES = [
  [BAND.SAFEGUARDING_ADJACENT, 1, /safeguarding|welfare/i],
  // "Suitable people" is the EYFS section on vetting, DBS and disqualification —
  // it IS this setting's safer-recruitment policy, and its two documents are
  // titled "2.1 Employment" and "2.2 Student placements", so no title rule can
  // reach them. rank 2 keeps them below the named band-2 documents.
  [BAND.SAFEGUARDING_ADJACENT, 2, /suitable people/i],
  [BAND.HEALTH_SAFETY, 2, /^health$|premises|environment|equipment/i],
  [BAND.INCLUSION, 2, /learning (and|&) development/i],
];

/**
 * Which band and rank a policy belongs to. Pure — no database, no side effects,
 * so the API, the ordering script and the tests all classify identically.
 * @returns {{band:number, rank:number}}
 */
function classify(title, category) {
  const t = String(title || '');
  for (const [band, rank, re] of TITLE_RULES) if (re.test(t)) return { band, rank };
  const c = String(category || '');
  for (const [band, rank, re] of CATEGORY_RULES) if (re.test(c)) return { band, rank };
  return { band: BAND.OTHER, rank: 0 };
}

// Titles arrive as "1.2 Safeguarding", "10.11 Making a complaint" — a leading
// section number that sorts "10.1" before "2.1" as text. Compare on the words,
// and fall back to the numbers so two identically-worded titles stay stable.
function sortKey(title) {
  const t = String(title || '');
  return t.replace(/^\s*[\d.]+\s*/, '').toLowerCase() + ' ' + t.toLowerCase();
}

/**
 * Give every policy in `rows` an explicit sort_order, statutory-first.
 * @param {Array<{id:number,title:string,category:string}>} rows
 * @returns {Array<{id:number,title:string,band:number,sort_order:number}>}
 */
function assignOrder(rows) {
  const decorated = rows.map(r => {
    const { band, rank } = classify(r.title, r.category);
    return { id: r.id, title: r.title, category: r.category, band, rank };
  });
  decorated.sort((a, b) =>
    a.band - b.band || a.rank - b.rank || sortKey(a.title).localeCompare(sortKey(b.title)));

  // Position within (band, rank) so the gaps stay meaningful per group.
  const seen = new Map();
  return decorated.map(d => {
    const k = d.band + ':' + d.rank;
    const pos = seen.get(k) || 0;
    seen.set(k, pos + 1);
    return Object.assign({}, d, { sort_order: d.band * 10000 + d.rank * 1000 + pos * 10 });
  });
}

/**
 * The sort_order for a policy being created now: just after the last policy that
 * belongs in the same band or an earlier one. So a new safeguarding policy lands
 * with the safeguarding ones and a new "General policies" note lands at the
 * bottom — neither at the top of the whole list.
 *
 * Computed from the CURRENT list rather than from the band arithmetic, because a
 * manager who has dragged the order in Roost has renumbered it; assuming the
 * seeded band*10000 numbers were still in place would drop every new policy at
 * the very bottom of a hand-sorted list.
 */
async function nextSortOrder(db, title, category) {
  const { band, rank } = classify(title, category);
  const mine = band * 10 + rank;
  const { rows } = await db.query(
    `SELECT title, category, sort_order FROM policies
      WHERE is_active = true AND sort_order IS NOT NULL
      ORDER BY sort_order`);
  if (!rows.length) return band * 10000 + rank * 1000;

  let after = null, before = null;
  for (const r of rows) {
    const c = classify(r.title, r.category);
    if (c.band * 10 + c.rank <= mine) after = Number(r.sort_order);
    else { before = Number(r.sort_order); break; }
  }
  if (after == null) return Math.floor(Number(rows[0].sort_order)) - 10;   // first in the list
  if (before == null) return after + 10;                                   // last in the list
  const mid = Math.floor((after + before) / 2);
  return mid > after && mid < before ? mid : after + 1;
}

// The one ORDER BY every surface uses. NULLS LAST so an unclassified policy can
// never appear above safeguarding; title as the tie-break so the order is total.
const ORDER_BY = 'sort_order NULLS LAST, title';

module.exports = { BAND, classify, assignOrder, nextSortOrder, sortKey, ORDER_BY };
