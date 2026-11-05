// Newsletter recipient-audience resolver (EyLog-style "who does it go TO").
//
// Resolves a set of audience SEGMENTS → a deduped list of email recipients,
// server-side, against the CURRENT edition/tenant schema (search_path is set
// per-container: ladn / demo_eyfs / demo_primary / demo_secondary). Never expose
// the raw email list to the browser beyond a count.
//
// Additive + extensible: add a new segment by appending to AUDIENCE_SEGMENTS and
// adding a matching branch in segmentRows(). Each branch is defensive about
// optional columns so it works across editions whose `children` table drifts.
'use strict';

const EMAIL_RE = /^[^@]+@[^@]+\.[^@]+$/;

// The offer-able segments. `label`/`description` drive the UI checklist; `key`
// is the stable id passed back on send. EASILY EXTENSIBLE — append here.
const AUDIENCE_SEGMENTS = [
  { key: 'all_parents',  label: 'All parents',
    description: 'Every family with a currently-enrolled child' },
  { key: 'bill_payers',  label: 'Bill payers',
    description: 'The primary financial / fee-paying contact per family' },
  { key: 'non_starters', label: 'Non-starters',
    description: 'Registered children with a future start date (not yet started)' },
  { key: 'just_left',    label: 'Just left',
    description: 'Children who left within the last N weeks' },
  { key: 'staff',        label: 'Staff',
    description: 'All active staff work email addresses' },
  { key: 'waiting_list', label: 'Waiting list',
    description: 'Contacts currently on the waiting list' },
];

const SEGMENT_KEYS = new Set(AUDIENCE_SEGMENTS.map(s => s.key));

// Which columns actually exist on a table in the current schema, so the resolver
// degrades gracefully across editions instead of throwing on a missing column.
async function tableCols(db, table) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(rows.map(r => r.column_name));
}

// Raw rows [{email,name,child_name}] for one segment (NOT yet validated/deduped).
async function segmentRows(db, key, opts, cols) {
  const c = cols.children;
  const demo = c.has('is_demo') ? 'AND COALESCE(is_demo,false)=false' : '';

  switch (key) {
    case 'all_parents':
      return (await db.query(`
        SELECT parent_1_email AS email, parent_1_name AS name,
               first_name || ' ' || last_name AS child_name
          FROM children
         WHERE is_active = true ${demo}
           AND parent_1_email IS NOT NULL AND parent_1_email <> ''
        UNION ALL
        SELECT parent_2_email, parent_2_name, first_name || ' ' || last_name
          FROM children
         WHERE is_active = true ${demo}
           AND parent_2_email IS NOT NULL AND parent_2_email <> ''
      `)).rows;

    case 'bill_payers': {
      // Prefer the designated primary financial contact; fall back to parent 1.
      const payer = c.has('primary_contact_email')
        ? `COALESCE(NULLIF(primary_contact_email,''), parent_1_email)`
        : `parent_1_email`;
      return (await db.query(`
        SELECT ${payer} AS email, parent_1_name AS name,
               first_name || ' ' || last_name AS child_name
          FROM children
         WHERE is_active = true ${demo}
           AND ${payer} IS NOT NULL AND ${payer} <> ''
      `)).rows;
    }

    case 'non_starters': {
      if (!c.has('start_date')) return [];
      const leaveGuard = c.has('leave_date')
        ? 'AND (leave_date IS NULL OR leave_date > CURRENT_DATE)' : '';
      return (await db.query(`
        SELECT parent_1_email AS email, parent_1_name AS name,
               first_name || ' ' || last_name AS child_name
          FROM children
         WHERE start_date > CURRENT_DATE ${leaveGuard} ${demo}
           AND parent_1_email IS NOT NULL AND parent_1_email <> ''
        UNION ALL
        SELECT parent_2_email, parent_2_name, first_name || ' ' || last_name
          FROM children
         WHERE start_date > CURRENT_DATE ${leaveGuard} ${demo}
           AND parent_2_email IS NOT NULL AND parent_2_email <> ''
      `)).rows;
    }

    case 'just_left': {
      if (!c.has('leave_date')) return [];
      const weeks = Math.max(1, parseInt(opts.just_left_weeks, 10) || 6);
      return (await db.query(`
        SELECT parent_1_email AS email, parent_1_name AS name,
               first_name || ' ' || last_name AS child_name
          FROM children
         WHERE leave_date IS NOT NULL AND leave_date < CURRENT_DATE
           AND leave_date >= CURRENT_DATE - ($1::int * INTERVAL '1 week') ${demo}
           AND parent_1_email IS NOT NULL AND parent_1_email <> ''
        UNION ALL
        SELECT parent_2_email, parent_2_name, first_name || ' ' || last_name
          FROM children
         WHERE leave_date IS NOT NULL AND leave_date < CURRENT_DATE
           AND leave_date >= CURRENT_DATE - ($1::int * INTERVAL '1 week') ${demo}
           AND parent_2_email IS NOT NULL AND parent_2_email <> ''
      `, [weeks])).rows;
    }

    case 'staff':
      return (await db.query(`
        SELECT email, first_name || ' ' || last_name AS name, NULL::text AS child_name
          FROM staff
         WHERE is_active = true AND email IS NOT NULL AND email <> ''
      `)).rows;

    case 'waiting_list':
      return (await db.query(`
        SELECT parent_email AS email, parent_name AS name,
               COALESCE(child_first_name,'') || ' ' || COALESCE(child_last_name,'') AS child_name
          FROM waiting_list_live
         WHERE parent_email IS NOT NULL AND parent_email <> ''
           AND COALESCE(status,'') NOT IN ('placed','enrolled','declined','withdrawn','archived','rejected')
      `)).rows;

    default:
      return [];
  }
}

// Resolve one or more segments → deduped, validated recipients.
// Returns { counts:{key:n}, recipients:[{email,name,child_name,segments:[..]}], total }.
// `counts` is per-segment unique-valid-email counts (what the UI shows); `total`
// is the deduped union across all selected segments.
async function resolveSegments(db, keys, opts = {}) {
  const wanted = [...new Set((keys || []).filter(k => SEGMENT_KEYS.has(k)))];
  const cols = {
    children: await tableCols(db, 'children'),
  };

  const counts = {};
  const merged = new Map(); // email -> {email,name,child_name,segments:Set}

  for (const key of wanted) {
    let rows = [];
    try { rows = await segmentRows(db, key, opts, cols); }
    catch (e) { counts[key] = { error: e.message, count: 0 }; continue; }

    const seenInSegment = new Set();
    for (const r of rows) {
      const email = (r.email || '').toLowerCase().trim();
      if (!EMAIL_RE.test(email)) continue;
      seenInSegment.add(email);

      const existing = merged.get(email);
      if (existing) {
        existing.segments.add(key);
        if (!existing.name && r.name) existing.name = r.name;
        if (!existing.child_name && r.child_name) existing.child_name = (r.child_name || '').trim();
      } else {
        merged.set(email, {
          email,
          name: r.name || '',
          child_name: (r.child_name || '').trim(),
          segments: new Set([key]),
        });
      }
    }
    counts[key] = seenInSegment.size;
  }

  const recipients = [...merged.values()].map(r => ({
    email: r.email,
    name: r.name,
    child_name: r.child_name,
    segments: [...r.segments],
  }));

  return { counts, recipients, total: recipients.length };
}

module.exports = { AUDIENCE_SEGMENTS, SEGMENT_KEYS, resolveSegments };
