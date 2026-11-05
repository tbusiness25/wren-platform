'use strict';
// ── Training matrix — b500 (2026-10-13) ───────────────────────────────────────
// Staff records → Training tab, Roost Settings. Toby: "the same for checking
// people's first aid, other training etc." This is the ONE server-side
// computation of "who's done what statutory course, and when does it expire" —
// GET /api/cpd/training-matrix is its only caller today. Anything else that needs
// "is this person's safeguarding current" should call computeTrainingMatrix()
// rather than re-deriving it.
//
// b500 review (2026-10-15): the matrix reads TWO existing stores, never a third —
//   • cpd_records       (external courses, the Training tab's own writes)
//   • mandatory_training (the HR/staff-profile "Mandatory Training" table; the
//                         Single Central Record's first-aid column reads it too)
// The first cut read cpd_records only, so on production every first-aid date held in
// mandatory_training showed as "missing" here while the SCR showed it as held.
// mandatory_training is READ-ONLY from this function (history is never overwritten).
const { getPool } = require('../db/pool');

const SETTINGS_KEY = 'training_matrix_courses';

// The statutory course list from Toby's brief, with validity in months
// (null = no expiry, e.g. SENCO) and a few recognition patterns matched
// case-insensitively, substring, against existing course names — so historical
// records "just work" without anyone re-entering them. When several patterns
// match one name, the LONGEST pattern wins (so "Designated Safeguarding Lead"
// counts for DSL, not for the shorter "safeguarding").
const DEFAULT_COURSES = [
  { key: 'paediatric_first_aid', name: 'Paediatric First Aid',              validity_months: 36, mandatory: true,  patterns: ['paediatric first aid', 'pfa', 'first aid'] },
  { key: 'safeguarding',         name: 'Safeguarding / Child Protection',    validity_months: 36, mandatory: true,  patterns: ['safeguarding', 'child protection'] },
  { key: 'dsl',                  name: 'DSL / Designated Lead',             validity_months: 24, mandatory: false, patterns: ['designated safeguarding lead', 'designated lead', 'dsl'] },
  { key: 'food_hygiene',         name: 'Food Hygiene L2',                   validity_months: 36, mandatory: true,  patterns: ['food hygiene'] },
  { key: 'fire_safety',          name: 'Fire Safety / Fire Marshal',        validity_months: 12, mandatory: true,  patterns: ['fire safety', 'fire marshal', 'fire warden'] },
  { key: 'prevent',              name: 'Prevent',                          validity_months: 24, mandatory: false, patterns: ['prevent', 'wrap training'] },
  { key: 'health_safety',        name: 'Health & Safety',                   validity_months: 36, mandatory: true,  patterns: ['health and safety', 'health & safety', 'health safety'] },
  { key: 'allergen',             name: 'Allergen Awareness',                validity_months: 12, mandatory: true,  patterns: ['allergen', 'allergy awareness'] },
  { key: 'manual_handling',      name: 'Manual Handling',                   validity_months: 36, mandatory: true,  patterns: ['manual handling'] },
  { key: 'gdpr',                 name: 'GDPR / Data Protection',            validity_months: 24, mandatory: true,  patterns: ['gdpr', 'data protection'] },
  { key: 'senco',                name: 'SENCO',                             validity_months: null, mandatory: false, patterns: ['senco'] },
];

async function loadCourses(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEY]);
    if (rows.length && rows[0].value) {
      const parsed = JSON.parse(rows[0].value);
      if (Array.isArray(parsed)) {
        const ok = parsed.filter(c => c && typeof c.key === 'string' && c.key);
        if (ok.length) return ok;
      }
    }
  } catch (_) { /* fall through to defaults */ }
  return DEFAULT_COURSES.map(c => ({ ...c, patterns: c.patterns.slice() }));
}

async function saveCourses(db, courses, updatedBy) {
  const json = JSON.stringify(courses);
  await db.query(`
    INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,NOW())
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = NOW()
  `, [SETTINGS_KEY, json, updatedBy || null]);
}

// Validates + normalises a course list coming from the "Manage courses" modal /
// the "Not mapped → map to…" action. A malformed list would otherwise be stored
// as-is and break the matrix for everyone (and `key` is echoed into HTML attributes).
// Returns { courses } or { error }.
function validateCourses(input) {
  if (!Array.isArray(input) || !input.length) return { error: 'courses array required' };
  if (input.length > 40) return { error: 'Too many courses (max 40)' };
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { error: 'Each course must be an object' };
    const key = String(raw.key || '');
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(key)) return { error: `Invalid course key "${key.slice(0, 40)}"` };
    if (seen.has(key)) return { error: `Duplicate course key "${key}"` };
    seen.add(key);
    const name = String(raw.name == null ? '' : raw.name).trim();
    if (!name || name.length > 80) return { error: `Course name for "${key}" must be 1–80 characters` };
    let validity = null;
    if (raw.validity_months !== null && raw.validity_months !== undefined && raw.validity_months !== '') {
      validity = Number(raw.validity_months);
      if (!Number.isInteger(validity) || validity < 1 || validity > 240) {
        return { error: `Validity for "${name}" must be a whole number of months (1–240), or blank for no expiry` };
      }
    }
    if (raw.patterns !== undefined && !Array.isArray(raw.patterns)) return { error: `Patterns for "${name}" must be a list` };
    const patterns = Array.from(new Set((raw.patterns || [])
      .map(p => String(p == null ? '' : p).trim().toLowerCase())
      .filter(Boolean)));
    if (patterns.length > 30 || patterns.some(p => p.length > 80)) {
      return { error: `Patterns for "${name}": at most 30, each up to 80 characters` };
    }
    out.push({ key, name, validity_months: validity, mandatory: !!raw.mandatory, patterns });
  }
  return { courses: out };
}

function matchCourseKey(courseName, courses) {
  const n = String(courseName || '').toLowerCase();
  if (!n) return null;
  let best = null, bestLen = 0;
  for (const c of courses) {
    for (const p of (c.patterns || [])) {
      const pl = String(p || '').toLowerCase();
      if (pl && n.includes(pl) && pl.length > bestLen) { best = c.key; bestLen = pl.length; }
    }
  }
  return best;
}

// pg returns DATE columns as JS Date objects, not strings — String(date) calls
// Date.prototype.toString() ("Thu Oct 11 2029 00:00:00 GMT…"), which happened to
// slice(0,10) into a plausible-looking but WRONG and unparseable "Thu Oct 11".
// Always go through this instead of String()/slice() on a date that may have
// come straight off a query.
function isoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// Calendar-month arithmetic in UTC, clamped to month end (31 Aug + 6 months = 28/29 Feb,
// not 3 Mar), so the result never depends on the server's timezone.
function addMonthsIso(dateStr, months) {
  const iso = isoDate(dateStr);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  if (isNaN(first)) return null;
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
}

function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ISO-string comparison (YYYY-MM-DD sorts lexically) — no timezone arithmetic.
function bucketStatus(expiryIso) {
  if (!expiryIso) return 'current'; // has a record, course never expires
  const today = new Date().toISOString().slice(0, 10);
  if (expiryIso < today) return 'overdue';
  if (expiryIso <= addDaysIso(today, 60)) return 'expiring_soon';
  return 'current';
}

// The one computation. `db` is any object with pg's query() (pool or client).
async function computeTrainingMatrix(db, { includeInactive = false } = {}) {
  const courses = await loadCourses(db);
  const { rows: staff } = await db.query(`
    SELECT id, first_name, last_name, role
    FROM staff
    WHERE COALESCE(is_demo,false) = false ${includeInactive ? '' : 'AND is_active = true'}
    ORDER BY first_name, last_name
  `);
  const { rows: cpd } = await db.query(`
    SELECT id, staff_id, course_name, provider, completion_date, expiry_date, notes, certificate_url, category
    FROM cpd_records
    WHERE staff_id IS NOT NULL AND completion_date IS NOT NULL
  `);
  let mandatory = [];
  try {
    ({ rows: mandatory } = await db.query(`
      SELECT id, staff_id, training_type, provider, completed_date, expiry_date, certificate_url
      FROM mandatory_training
      WHERE staff_id IS NOT NULL AND (completed_date IS NOT NULL OR expiry_date IS NOT NULL)
    `));
  } catch (_) { /* editions without the HR mandatory-training table: cpd_records only */ }

  // One shape for both stores.
  const records = [];
  cpd.forEach(r => records.push({
    source: 'cpd_records', rank: 1, id: r.id, staff_id: r.staff_id, label: r.course_name, category: r.category,
    provider: r.provider, completion_date: isoDate(r.completion_date), expiry_date: isoDate(r.expiry_date),
    notes: r.notes, certificate_url: r.certificate_url,
  }));
  mandatory.forEach(r => records.push({
    source: 'mandatory_training', rank: 0, id: r.id, staff_id: r.staff_id,
    label: String(r.training_type || '').replace(/[_-]+/g, ' ').trim(), category: null,
    provider: r.provider, completion_date: isoDate(r.completed_date), expiry_date: isoDate(r.expiry_date),
    notes: null, certificate_url: r.certificate_url,
  }));
  // ascending by when it was done; on a tie the cpd_records row (what this page writes) wins
  records.sort((a, b) => {
    const da = a.completion_date || a.expiry_date || '', db_ = b.completion_date || b.expiry_date || '';
    return da < db_ ? -1 : da > db_ ? 1 : (a.rank - b.rank) || (a.id - b.id);
  });

  const courseKeys = new Set(courses.map(c => c.key));
  const latest = {}; // `${staff_id}:${key}` -> record (kept: the LATEST completion)
  const unmatched = new Map(); // lowercased label -> { course_name, count }

  for (const r of records) {
    const key = (r.category && courseKeys.has(r.category)) ? r.category : matchCourseKey(r.label, courses);
    if (!key) {
      const name = String(r.label || '').trim();
      if (name) {
        const entry = unmatched.get(name.toLowerCase()) || { course_name: name, count: 0 };
        entry.count++;
        unmatched.set(name.toLowerCase(), entry);
      }
      continue;
    }
    latest[`${r.staff_id}:${key}`] = r; // sorted ascending → last write is the latest
  }

  const matrix = staff.map(s => {
    const cells = {};
    courses.forEach(c => {
      const rec = latest[`${s.id}:${c.key}`];
      if (!rec) { cells[c.key] = { status: 'missing' }; return; }
      let expiry = null;
      if (c.validity_months) {
        expiry = rec.expiry_date || (rec.completion_date ? addMonthsIso(rec.completion_date, c.validity_months) : null);
      }
      cells[c.key] = {
        record_id: rec.id,
        source: rec.source,
        completion_date: rec.completion_date,
        provider: rec.provider,
        notes: rec.notes,
        certificate_url: rec.certificate_url,
        expiry_date: expiry,
        // a record with a validity period but nothing to work an expiry from is not "current"
        status: (c.validity_months && !expiry) ? 'overdue' : bucketStatus(expiry),
      };
    });
    return { staff_id: s.id, name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), role: s.role, cells };
  });

  return {
    courses,
    staff: matrix,
    unmapped: Array.from(unmatched.values()).sort((a, b) => b.count - a.count),
  };
}

module.exports = {
  computeTrainingMatrix, loadCourses, saveCourses, validateCourses, matchCourseKey,
  addMonthsIso, addDaysIso, isoDate, bucketStatus,
  SETTINGS_KEY, DEFAULT_COURSES,
};
