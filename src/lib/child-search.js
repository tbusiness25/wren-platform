'use strict';
// b337 (2026-09-17) — "find a child by anything I remember about them": their
// first/last/preferred name, their Wren id (123 or #123), their EyLog ref, or a
// parent's name, email address or phone number (any UK format). One query,
// shared by the children list search box (/api/children/search) and the
// Ctrl+K global search (/api/search/global) so both match the same fields the
// same way and report the same match reason. Phone comparison always happens
// in SQL via ladn.normalize_phone_digits() — the DB is the single source of
// truth for "same number, different format", not a JS re-implementation of it.

const ID_RE = /^#?(\d{1,7})$/;

function parseIdQuery(q) {
  const m = ID_RE.exec(q.trim());
  return m ? parseInt(m[1], 10) : null;
}

// A query is "phone-shaped" when it has no letters and enough digits to be
// worth normalising — tells "07911 123456" apart from a name or email so a
// short numeric-looking name fragment doesn't get treated as a phone number.
function looksLikePhone(q) {
  const digits = q.replace(/[^\d]/g, '');
  return digits.length >= 5 && !/[a-zA-Z]/.test(q);
}

const CHILD_SEARCH_SELECT = `
  SELECT c.*, r.name AS room_name,
    cfn.total_hours_week AS current_funded_hours,
    cfn.funding_type     AS current_funding_type,
    CASE
      WHEN c.id = $1::int THEN 'Wren id'
      WHEN c.eylog_ref IS NOT NULL AND c.eylog_ref ILIKE $2::text THEN 'EY number'
      WHEN c.first_name ILIKE $2::text OR c.last_name ILIKE $2::text OR c.preferred_name ILIKE $2::text
        OR (c.first_name || ' ' || c.last_name) ILIKE $3::text THEN 'name'
      WHEN c.parent_1_email ILIKE $3::text OR c.parent_2_email ILIKE $3::text THEN 'parent email'
      WHEN $4::text IS NOT NULL AND (
             ladn.normalize_phone_digits(c.parent_1_phone) = ladn.normalize_phone_digits($4::text)
          OR ladn.normalize_phone_digits(c.parent_2_phone) = ladn.normalize_phone_digits($4::text)
      ) THEN 'parent phone'
      WHEN c.parent_1_name ILIKE $3::text OR c.parent_2_name ILIKE $3::text THEN 'parent name'
      ELSE 'match'
    END AS matched_field
  FROM children c
  LEFT JOIN rooms r ON r.id = c.room_id
  LEFT JOIN LATERAL (
    SELECT cf.total_hours_week, cf.funding_type
      FROM child_funding cf JOIN funding_terms ft ON ft.id = cf.term_id
     WHERE cf.child_id = c.id AND ft.is_current
     ORDER BY cf.total_hours_week DESC NULLS LAST LIMIT 1) cfn ON true
`;

// searchChildren(db, rawQuery, { limit, scopeFilter }) — scopeFilter is the
// { sql, params } shape produced by middleware/scope-filter's buildScopeSQL,
// built fresh here (not reused from req.scopeFilter) because that helper
// always numbers its own placeholder from $1 and this query already has four.
async function searchChildren(db, rawQuery, opts = {}) {
  const q = String(rawQuery || '').trim();
  if (!q) return [];

  const id = parseIdQuery(q);
  const isPhone = looksLikePhone(q);
  if (id === null && q.length < 2) return []; // minimum length for free text

  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 8, 1), 25);
  const params = [
    id,                       // $1 — exact Wren id
    q + '%',                  // $2 — prefix match (name, eylog ref)
    '%' + q + '%',            // $3 — contains match (full name, emails, parent names)
    isPhone ? q : null,       // $4 — raw phone text; normalised on both sides in SQL
  ];

  let where = `(
    c.id = $1::int
    OR (c.eylog_ref IS NOT NULL AND c.eylog_ref ILIKE $2::text)
    OR c.first_name ILIKE $2::text OR c.last_name ILIKE $2::text OR c.preferred_name ILIKE $2::text
    OR (c.first_name || ' ' || c.last_name) ILIKE $3::text
    OR c.parent_1_email ILIKE $3::text OR c.parent_2_email ILIKE $3::text
    OR c.parent_1_name ILIKE $3::text OR c.parent_2_name ILIKE $3::text
    OR ($4::text IS NOT NULL AND char_length(ladn.normalize_phone_digits($4::text)) >= 5 AND (
         ladn.normalize_phone_digits(c.parent_1_phone) = ladn.normalize_phone_digits($4::text)
      OR ladn.normalize_phone_digits(c.parent_2_phone) = ladn.normalize_phone_digits($4::text)
    ))
  )`;

  if (opts.scopeFilter && opts.scopeFilter.sql) {
    // Reindex the scope fragment's $1 onto the next free placeholder — buildScopeSQL
    // always writes it starting from its own startIdx=1, once or twice, same value.
    const nextIdx = params.length + 1;
    where += ` AND (${opts.scopeFilter.sql.replace(/\$1\b/g, '$' + nextIdx)})`;
    params.push(...opts.scopeFilter.params);
  }

  const limitIdx = params.length + 1;
  params.push(limit);

  const { rows } = await db.query(
    `${CHILD_SEARCH_SELECT}
     WHERE ${where}
     ORDER BY c.is_active DESC, CASE WHEN c.id = $1::int THEN 0 ELSE 1 END, c.first_name, c.last_name
     LIMIT $${limitIdx}`,
    params
  );
  return rows;
}

module.exports = { searchChildren, parseIdQuery, looksLikePhone };
