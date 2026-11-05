'use strict';
// b424 (2026-10-08) — one bulk query for every pipeline card's status badges (D/P/
// allergy/home-visit + enquired date), same "one call for the whole board" shape as
// welcome-pack.js's /progress endpoint — not one request per card.

const WP = require('./welcome-pack');
const { isDepositSatisfied } = require('./enquiry-stage');

// Computes, per enquiry id:
//   deposit:    'paid' | 'unpaid' | 'not_required' | 'unknown' (no waiting-list row yet —
//               too early in the funnel for a deposit to mean anything)
//   paperwork:  'complete' (welcome-pack checklist 100%) | 'partial' (some done) | 'none'
//   allergy:    true/false — only ever true once a child record exists to carry it
//   home_visit: null | 'requested' | 'booked' | 'completed' | 'cancelled'
//   enquired_at / enquired_source / days_on_list
async function loadPipelineStatus(db) {
  // b428 — waiting_list_live (merged_into_id IS NULL), not the raw table: a
  // merged duplicate row must never be the one that decides a badge.
  const { rows } = await db.query(`
    SELECT e.id AS enquiry_id, e.created_at AS enquiry_created_at,
           e.enquiry_submitted_at, e.enquiry_date_source, e.parent_email AS enquiry_parent_email,
           w.id AS waiting_list_id, w.deposit_required, w.deposit_amount_pence,
           w.enquiry_submitted_at AS wl_submitted_at, w.enquiry_date_source AS wl_source,
           w.date_added, w.parent_email AS wl_parent_email,
           c.id AS child_id, c.status AS child_status,
           c.allergies, c.allergen_notes, c.allergens,
           hv.status AS home_visit_status,
           -- b531 — what the board needs for "deposit & forms due" / "welcome pack due"
           COALESCE(c.start_date, w.expected_start_date, e.preferred_start_date, e.start_date_requested) AS start_date,
           concat_ws(' ', cr.name, w.room_needed, e.preferred_room, e.room_needed) AS room_text,
           wp.sent_at AS welcome_pack_sent_at,
           vw.status AS viewing_status, vw.slot_date AS viewing_date
      FROM enquiries e
      LEFT JOIN waiting_list_live w ON w.enquiry_id = e.id
      LEFT JOIN children c ON c.enquiry_id = e.id
      LEFT JOIN rooms cr ON cr.id = c.room_id
      LEFT JOIN LATERAL (
        SELECT status FROM home_visits WHERE child_id = c.id ORDER BY created_at DESC LIMIT 1
      ) hv ON true
      LEFT JOIN LATERAL (
        SELECT max(sent_at) AS sent_at FROM welcome_pack_sends WHERE child_id = c.id AND kind = 'welcome' AND sent_ok
      ) wp ON true
      LEFT JOIN LATERAL (
        SELECT status, slot_date FROM viewings
         WHERE (family_type = 'enquiry' AND family_id = e.id) OR (family_type = 'waiting_list' AND family_id = w.id)
         ORDER BY slot_date DESC, start_time DESC LIMIT 1
      ) vw ON true
  `);

  // b428 — "sibling / existing family" filter: a conservative, exact-email match
  // against active children (the b422 NOTES deliberately left out name/address
  // fuzzy-matching as "a real matching problem... risked being wrong"; an exact
  // parent email match carries none of that risk).
  const familyEmailsByEnquiry = {};
  const allFamilyEmails = new Set();
  for (const r of rows) {
    const emails = [r.enquiry_parent_email, r.wl_parent_email]
      .map(e => (e || '').trim().toLowerCase()).filter(Boolean);
    familyEmailsByEnquiry[r.enquiry_id] = emails;
    emails.forEach(e => allFamilyEmails.add(e));
  }
  // email -> set of active child ids carrying it, so a child who IS this
  // enquiry's own linked record never counts as its own "sibling".
  const childIdsByEmail = {};
  if (allFamilyEmails.size) {
    const emailList = [...allFamilyEmails];
    const { rows: sibRows } = await db.query(
      `SELECT id, lower(email) AS email FROM (
         SELECT id, parent_1_email AS email FROM children WHERE status='active' AND parent_1_email = ANY($1::text[])
         UNION SELECT id, parent_2_email        FROM children WHERE status='active' AND parent_2_email = ANY($1::text[])
         UNION SELECT id, primary_contact_email FROM children WHERE status='active' AND primary_contact_email = ANY($1::text[])
       ) x WHERE email IS NOT NULL`, [emailList]);
    sibRows.forEach(r => { (childIdsByEmail[r.email] = childIdsByEmail[r.email] || new Set()).add(r.id); });
  }

  // b428 — the P badge used to come from child_status alone ('active' =
  // "complete"), so a Registered card could show a green P next to a 0/7
  // welcome-pack checklist. Load the real checklist for every linked child —
  // same computation b422's /api/welcome-pack/progress uses — instead.
  const childIds = [...new Set(rows.map(r => r.child_id).filter(Boolean))];
  let childrenById = {}, checklistConfig = {};
  if (childIds.length) {
    const { rows: fullChildren } = await db.query('SELECT * FROM children WHERE id = ANY($1::int[])', [childIds]);
    childrenById = Object.fromEntries(fullChildren.map(c => [c.id, c]));
    const { rows: [cfgRow] } = await db.query(
      `SELECT checklist_config FROM welcome_pack_settings WHERE id=true`).catch(() => ({ rows: [null] }));
    checklistConfig = (cfgRow && cfgRow.checklist_config) || {};
  }
  const checklistCache = {}; // one computeChecklist() per child, even if several enquiry rows point at them

  const out = {};
  for (const r of rows) {
    const hasChild = !!r.child_id;

    let paperwork = 'none';
    if (hasChild && childrenById[r.child_id]) {
      if (!checklistCache[r.child_id]) {
        checklistCache[r.child_id] = await WP.computeChecklist(db, childrenById[r.child_id], checklistConfig);
      }
      const { progress } = checklistCache[r.child_id];
      paperwork = progress.total === 0 || progress.done === 0 ? 'none'
        : progress.done >= progress.total ? 'complete' : 'partial';
    }

    // b428 — the same evidence tryAdvanceToRegistered() uses (waiting-list
    // deposit_paid/deposit_required OR a paid/credited child_deposits row),
    // not a narrower read of just the waiting_list row.
    const depositOk = await isDepositSatisfied(db, r.enquiry_id);
    const deposit = r.deposit_required === false ? 'not_required'
      : depositOk ? 'paid'
      : r.waiting_list_id ? 'unpaid'
      : 'unknown';

    const allergyText = [r.allergies, r.allergen_notes].filter(Boolean).join(' ').trim();
    const allergy = hasChild && !!(allergyText || (Array.isArray(r.allergens) && r.allergens.length));

    const enquiredAt = r.enquiry_submitted_at || r.wl_submitted_at || r.date_added || r.enquiry_created_at;
    const enquiredSource = r.enquiry_submitted_at ? (r.enquiry_date_source || 'enquiry')
      : r.wl_submitted_at ? (r.wl_source || 'waiting_list')
      : (r.date_added ? 'date_added' : 'created_at');

    const sibling = familyEmailsByEnquiry[r.enquiry_id].some(e => {
      const ids = childIdsByEmail[e];
      return ids && [...ids].some(cid => cid !== r.child_id);
    });

    out[r.enquiry_id] = {
      deposit, deposit_amount_pence: r.deposit_amount_pence || null,
      paperwork, allergy, sibling,
      home_visit: r.home_visit_status || null,
      waiting_list_id: r.waiting_list_id || null, child_id: r.child_id || null,
      enquired_at: enquiredAt, enquired_source: enquiredSource,
      days_on_list: enquiredAt ? Math.floor((Date.now() - new Date(enquiredAt).getTime()) / 86400000) : null,
      // b531
      form_in: hasChild && ['pending', 'active'].includes(r.child_status),
      start_date: r.start_date ? ymd(r.start_date) : null,
      days_to_start: r.start_date ? Math.ceil((new Date(ymd(r.start_date) + 'T12:00:00Z') - Date.now()) / 86400000) : null,
      room_kind: /baby/i.test(r.room_text || '') ? 'baby' : /pre/i.test(r.room_text || '') ? 'preschool' : null,
      welcome_pack_sent_at: r.welcome_pack_sent_at || null,
      viewing: r.viewing_status ? { status: r.viewing_status, date: ymd(r.viewing_date) } : null,
    };
  }
  return out;
}

function ymd(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

module.exports = { loadPipelineStatus };
