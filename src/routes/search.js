'use strict';
// Global search — Roost top-bar search across children, staff and parents/contacts.
// Additive route (mounted at /api/search). Uses UNQUALIFIED table names so it runs
// against whatever schema the container's search_path is set to (ladn / demo_* / …).
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
// b337 — same child search (name, Wren id, EyLog ref, parent name/email/phone)
// the children list box uses, so Ctrl+K finds a child the same ways.
const { searchChildren, looksLikePhone } = require('../lib/child-search');
// b534 — isManagerRole gates the family-notes text match below: those notes can
// carry sensitive family context, same restriction as /api/comms/family-notes.
const { isManagerRole } = require('../lib/email-allowlist');

const CHILD_MATCH_LABEL = {
  'Wren id':      'matched Wren id',
  'EyLog ref':    'matched EY number',
  'EY number':    'matched EY number',
  'parent email': 'matched parent email',
  'parent phone': 'matched parent phone',
  'parent name':  'matched parent name',
};

router.use(authenticate);

// GET /api/search/global?q=  → { query, children:[], staff:[], parents:[] }
// Name-prefix, case-insensitive; limit 5 per entity type.
router.get('/global', async (req, res) => {
  // Parents authenticate per-child — they must not be able to search the whole roll.
  if (req.user && req.user.role === 'parent') {
    return res.json({ query: '', children: [], staff: [], parents: [] });
  }
  const raw = String(req.query.q || '').trim();
  // b337 — a bare Wren id ("7", "#123") is a valid search even under the
  // normal 2-character minimum for free text.
  const idLike = /^#?\d{1,7}$/.test(raw);
  if (raw.length < 2 && !idLike) return res.json({ query: raw, children: [], staff: [], parents: [] });
  const q = raw.slice(0, 60);
  const pref = q + '%';        // prefix match
  const anyw = '%' + q + '%';  // contained (for emails / mid-name)
  const db = getPool();
  const out = { query: q, children: [], staff: [], parents: [] };

  try {
    // b337 — reuse the same matcher as /api/children/search: name, Wren id,
    // EyLog ref, or a parent's name/email/phone. Parents authenticate
    // per-child (guarded above) so this only ever runs for staff/managers.
    const kids = await searchChildren(db, raw, { limit: 5, scopeFilter: req.scopeFilter });
    out.children = kids.map(k => ({
      id: k.id,
      name: `${k.first_name} ${k.last_name}`.trim(),
      // b532 — the EY number, and a confirmed child who hasn't started yet says so
      // (it used to read 'left', so a family just enrolled from the waiting list looked gone).
      sub: [k.eylog_ref || null, CHILD_MATCH_LABEL[k.matched_field] || null, k.room_name,
            k.status === 'pending' ? ('starting' + (k.start_date ? ' ' + new Date(k.start_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''))
              : k.status === 'enquiry' ? 'enquiry'
              : (k.is_active ? null : 'left')]
        .filter(Boolean).join(' · '),
      link: `/child-profile.html?id=${k.id}`,
    }));
  } catch (e) { out.children_error = e.message; }

  // b532 — waiting-list children, by name or EY number (LA…CD), shown with the children.
  // Placed rows are left out: once enrolled the child row above is the one to open.
  try {
    const { rows: wl } = await db.query(`
      SELECT id, child_first_name, child_last_name, ey_number, expected_start_date
        FROM waiting_list
       WHERE merged_into_id IS NULL AND archived_at IS NULL AND COALESCE(status,'waiting') = 'waiting'
         AND (ey_number ILIKE $1 OR child_first_name ILIKE $1 OR child_last_name ILIKE $1
              OR (child_first_name || ' ' || child_last_name) ILIKE $2)
       ORDER BY child_first_name, child_last_name
       LIMIT 5`, [pref, anyw]);
    for (const w of wl) {
      if (out.children.length >= 8) break;
      out.children.push({
        id: null,
        name: `${w.child_first_name || ''} ${w.child_last_name || ''}`.trim() || 'Waiting-list child',
        sub: ['Waiting list', w.ey_number,
              w.expected_start_date ? 'wants ' + new Date(w.expected_start_date).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : null]
          .filter(Boolean).join(' · '),
        link: '/admissions/waitlist-manage.html',
      });
    }
  } catch (e) { out.waiting_list_error = e.message; }

  // b534 — a hit inside a family relationship note (ladn.family_comms_notes), managers
  // only (same restriction as /api/comms/family-notes: these can carry complaints/fee
  // disputes). Only children already enrolled get a note row, so this only ever links
  // to a real child profile, never a bare waiting-list/enquiry id.
  if (isManagerRole(req.user)) {
    try {
      const { rows: fn } = await db.query(`
        SELECT c.id, c.first_name, c.last_name
          FROM family_comms_notes fn
          JOIN children c ON c.id = fn.child_id
         WHERE fn.child_id IS NOT NULL AND fn.note ILIKE $1
         ORDER BY c.first_name, c.last_name
         LIMIT 5`, [anyw]);
      const already = new Set(out.children.map((c) => c.id).filter(Boolean));
      for (const c of fn) {
        if (already.has(c.id) || out.children.length >= 8) continue;
        already.add(c.id);
        out.children.push({
          id: c.id,
          name: `${c.first_name} ${c.last_name}`.trim(),
          sub: 'Matched in family notes',
          link: `/child-profile.html?id=${c.id}#messages`,
        });
      }
    } catch (e) { out.family_notes_error = e.message; }
  }

  try {
    const { rows: staff } = await db.query(`
      SELECT id, first_name, last_name, role, is_active, ey_number
      FROM staff
      WHERE (first_name ILIKE $1 OR last_name ILIKE $1
         OR (first_name || ' ' || last_name) ILIKE $1
         OR ey_number ILIKE $1)              -- b532 — staff EY number (LA<id>ST)
        AND NOT COALESCE(is_demo, false)
      ORDER BY is_active DESC, first_name, last_name
      LIMIT 5`, [pref]);
    out.staff = staff.map(s => ({
      id: s.id,
      name: `${s.first_name} ${s.last_name}`.trim(),
      sub: [s.ey_number || null, s.role ? String(s.role).replace(/_/g, ' ') : null, s.is_active ? null : 'inactive'].filter(Boolean).join(' · '),
      link: `/staff-profile.html?id=${s.id}`,
    }));
  } catch (e) { out.staff_error = e.message; }

  // Parents/contacts: enrolled children carry parent name+email inline; the contacts
  // table holds enquirers/waiting-list. Merge both, prefer a child link where one exists.
  try {
    const parents = [];
    const seen = new Set();
    const push = (name, sub, link) => {
      const key = (name || '').toLowerCase() + '|' + (link || '');
      if (!name || seen.has(key)) return;
      seen.add(key);
      parents.push({ name, sub, link });
    };

    // b337 — a phone-shaped query also matches on either parent's number, any
    // UK format, via the same ladn.normalize_phone_digits() the child search uses.
    const isPhoneQ = looksLikePhone(raw);
    const phoneParam = isPhoneQ ? raw : null;

    const { rows: cp } = await db.query(`
      SELECT id, first_name, last_name,
             parent_1_name, parent_1_email, parent_2_name, parent_2_email
      FROM children
      WHERE parent_1_name ILIKE $1 OR parent_2_name ILIKE $1
         OR parent_1_email ILIKE $2 OR parent_2_email ILIKE $2
         OR ($3::text IS NOT NULL AND (
              ladn.normalize_phone_digits(parent_1_phone) = ladn.normalize_phone_digits($3::text)
           OR ladn.normalize_phone_digits(parent_2_phone) = ladn.normalize_phone_digits($3::text)
         ))
      ORDER BY first_name, last_name
      LIMIT 10`, [pref, anyw, phoneParam]);
    for (const c of cp) {
      const childName = `${c.first_name} ${c.last_name}`.trim();
      const link = `/child-profile.html?id=${c.id}#family`;
      const m1 = (c.parent_1_name && (c.parent_1_name.toLowerCase().startsWith(q.toLowerCase()))) ||
                 (c.parent_1_email && c.parent_1_email.toLowerCase().includes(q.toLowerCase()));
      const m2 = (c.parent_2_name && (c.parent_2_name.toLowerCase().startsWith(q.toLowerCase()))) ||
                 (c.parent_2_email && c.parent_2_email.toLowerCase().includes(q.toLowerCase()));
      // A phone-only match still needs to surface even though m1/m2 above only
      // check name/email — push whichever parent name exists so the phone hit
      // isn't silently dropped.
      if (m1 && c.parent_1_name) push(c.parent_1_name, `Parent of ${childName}`, link);
      if (m2 && c.parent_2_name) push(c.parent_2_name, `Parent of ${childName}`, link);
      if (!m1 && !m2 && isPhoneQ) {
        if (c.parent_1_name) push(c.parent_1_name, `Parent of ${childName} · matched phone`, link);
        else if (c.parent_2_name) push(c.parent_2_name, `Parent of ${childName} · matched phone`, link);
      }
    }

    // contacts table (enquiries / waiting list). child_ids is an int[] — link to first child.
    let contactRows = [];
    try {
      const r = await db.query(`
        SELECT id, full_name, primary_email, child_ids, status
        FROM contacts
        WHERE full_name ILIKE $1 OR primary_email ILIKE $2
           OR ($3::text IS NOT NULL AND (
                ladn.normalize_phone_digits(primary_phone) = ladn.normalize_phone_digits($3::text)
             OR ladn.normalize_phone_digits(secondary_phone) = ladn.normalize_phone_digits($3::text)
           ))
        ORDER BY (archived_at IS NULL) DESC, full_name
        LIMIT 10`, [pref, anyw, phoneParam]);
      contactRows = r.rows;
    } catch (_) { /* contacts table may not exist on some tenants */ }
    for (const ct of contactRows) {
      const firstChild = Array.isArray(ct.child_ids) && ct.child_ids.length ? ct.child_ids[0] : null;
      const link = firstChild ? `/child-profile.html?id=${firstChild}#family` : `/communications.html?contact=${ct.id}`;
      push(ct.full_name, ct.status ? `Contact · ${ct.status}` : 'Contact', link);
    }

    out.parents = parents.slice(0, 5);
  } catch (e) { out.parents_error = e.message; }

  // 29 Oct: the HR portal (staff's own phones) carries no child or family data — HR_ALLOW's own
  // rule — but a two-letter search here returned up to 8 children and 5 parents. Colleagues only,
  // and only current ones.
  if (req._portal === 'hr') {
    out.children = []; out.parents = [];
    out.staff = (out.staff || []).filter((s) => !/\binactive\b/.test(s.sub || ''));
  }
  res.json(out);
});

module.exports = router;
