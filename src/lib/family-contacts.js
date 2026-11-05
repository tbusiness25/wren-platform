'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// family-contacts.js — keep the two places a family's details live in step.
// 2026-09-21
//
// THE PROBLEM THIS EXISTS FOR
// A child's parents are recorded twice: `ladn.contacts` (one row per person, with
// a relationship, an email and a phone — what the EyLog import wrote and what the
// comms side reads) and four flat columns on `ladn.children` (`parent_1_*`,
// `parent_2_*` — what the child profile edits, what invoices pick the bill payer
// from, and what the keepsake send addresses).
//
// They drifted, silently and completely: on 2026-09-21 exactly ONE of 39 children
// on roll had a parent phone on the child row, and none had an emergency contact,
// while contacts held 26 mothers and 23 fathers with both. Staff opened the Family
// tab and saw an empty form; nine families could sign in and be told we could not
// find their child. Nobody knew until a parent complained.
//
// Toby's registration flow from October writes both, so this is about the children
// already on roll. Until the profile is re-pointed at `contacts` for good, an edit
// on one side is mirrored to the other, so the gap cannot silently reopen.
//
// RULES
//   · A contact is matched by POSITION, the same ordering the backfill used:
//     mother, then father, then anyone else, then by id. Position 1 is parent_1.
//   · Blank never overwrites a value. Clearing a field on the profile is a real
//     edit and is mirrored; a field simply absent from the request is not touched.
//   · A child with no contact row for that position gets one created, so a parent
//     typed into the profile appears in the comms side too.
//   · Every write is best-effort: a mirror failure must never fail the save the
//     member of staff actually asked for. It is logged, not thrown.
//
// b342 (2026-09-21) — FAMILIES EDIT THEIR OWN DETAILS, AND EMERGENCY CONTACTS JOIN THE STORE
//   The parents app now writes a family's parent 1, parent 2 and emergency contacts. The
//   direction is the OPPOSITE of the rules above: `contacts` is written first (it is the store)
//   and the flat `children.*` columns are then re-derived from it (syncChildColumns), so an
//   invoice or a keepsake send still reads the value the family typed. A person's position is now
//   pinned (`contacts.parent_slot`) instead of being a side effect of the relationship label —
//   otherwise editing "Mother" to "Carer" could swap parent 1 and parent 2, and parent 1 is who
//   the invoice is addressed to. Emergency contacts are `contacts` rows with
//   `is_emergency_contact`; the two flat slots on the child row mirror the first two.
//   The b342 functions REQUIRE the migration (they throw a named error without it); the older
//   ones probe for the columns and keep working on a database that has not been migrated.
// ─────────────────────────────────────────────────────────────────────────────

const PARENT_RELATIONSHIPS = ['Mother', 'Father', 'Parent', 'Guardian'];

// ── Does this database have the b342 columns? ───────────────────────────────────
// Cached once they are all there; while any is missing it re-probes every minute, so running
// the migration is picked up without a restart. Never throws — "could not look" means "no".
let _feat = { at: 0, v: null };
async function features(db) {
  const now = Date.now();
  if (_feat.v && _feat.v.slot && _feat.v.emergency && _feat.v.collect) return _feat.v;
  if (_feat.v && now - _feat.at < 60 * 1000) return _feat.v;
  const v = { slot: false, emergency: false, collect: false };
  try {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'contacts'
          AND column_name IN ('parent_slot', 'is_emergency_contact', 'collect_proposed')`);
    for (const r of rows) {
      if (r.column_name === 'parent_slot') v.slot = true;
      if (r.column_name === 'is_emergency_contact') v.emergency = true;
      if (r.column_name === 'collect_proposed') v.collect = true;
    }
  } catch (_) { /* keep the all-false answer */ }
  _feat = { at: now, v };
  return v;
}
function _resetFeatureCache() { _feat = { at: 0, v: null }; }

async function requireMigrated(db) {
  const f = await features(db);
  if (!(f.slot && f.emergency && f.collect)) {
    const e = new Error('family details need migrations/2026-09-21-b342-family-details-and-reports.sql');
    e.code = 'B342_NOT_MIGRATED';
    throw e;
  }
  return f;
}

// The ordering the 2026-09-21 backfill used, so slot 1 here is the same person it
// put into parent_1_* then. b342: a PINNED position (contacts.parent_slot) comes first, then the
// original ordering for everyone not pinned. An emergency contact is never a parent, whatever
// label it carries ("Father" typed as an emergency relationship must not become parent 2).
function rankedParentsSql(f) {
  return `
  SELECT ct.id, ct.full_name, ct.primary_email, ct.primary_phone, ct.relationship, ct.child_ids,
         ${f.slot ? 'ct.parent_slot' : 'NULL::smallint AS parent_slot'},
         row_number() OVER (PARTITION BY c.id
           ORDER BY ${f.slot ? 'COALESCE(ct.parent_slot, 3),' : ''}
                    CASE ct.relationship
                      WHEN 'Mother' THEN 1 WHEN 'Father' THEN 2 ELSE 3 END, ct.id) AS slot
    FROM children c
    JOIN contacts ct ON c.id = ANY(ct.child_ids)
   WHERE c.id = $1
     AND ct.relationship = ANY($2)
     ${f.emergency ? 'AND NOT ct.is_emergency_contact' : ''}`;
}

const clean = v => (v == null ? null : String(v).trim());

/**
 * Mirror parent_1_* / parent_2_* from a child row into `contacts`.
 * @param db     a pg pool/client
 * @param childId
 * @param body   the request body, so we only touch what was actually submitted
 * @param row    the updated children row (the values to write)
 */
async function mirrorParentsToContacts(db, childId, body = {}, row = {}) {
  const touched = Object.keys(body).some(k => /^parent_[12]_(name|email|phone)$/.test(k));
  if (!touched) return { mirrored: 0 };

  const { rows: ranked } = await db.query(rankedParentsSql(await features(db)), [childId, PARENT_RELATIONSHIPS]);
  const bySlot = new Map(ranked.map(r => [Number(r.slot), r]));
  let mirrored = 0;

  for (const slot of [1, 2]) {
    const name  = clean(row[`parent_${slot}_name`]);
    const email = clean(row[`parent_${slot}_email`]);
    const phone = clean(row[`parent_${slot}_phone`]);
    const submitted = ['name', 'email', 'phone'].some(k => body[`parent_${slot}_${k}`] !== undefined);
    if (!submitted) continue;
    if (!name && !email && !phone) continue;   // an empty slot is not a person

    const existing = bySlot.get(slot);
    if (existing) {
      await db.query(
        `UPDATE contacts
            SET full_name     = COALESCE($2, full_name),
                primary_email = COALESCE($3, primary_email),
                primary_phone = COALESCE($4, primary_phone)
          WHERE id = $1`,
        [existing.id, name, email ? email.toLowerCase() : null, phone]);
      mirrored++;
    } else {
      // No contact in this position yet — a parent typed straight into the profile.
      // Relationship is left as 'Parent' rather than guessed: we were not told which.
      await db.query(
        `INSERT INTO contacts (full_name, primary_email, primary_phone, relationship,
                               child_ids, status, source, created_at)
         VALUES ($1, $2, $3, 'Parent', ARRAY[$4::int], 'enrolled', 'child_profile', now())`,
        [name, email ? email.toLowerCase() : null, phone, childId]);
      mirrored++;
    }
  }
  return { mirrored };
}

/** Every contact on file for a child — what the profile shows under the four slots. */
async function contactsForChild(db, childId) {
  const f = await features(db);
  const { rows } = await db.query(
    `SELECT ct.id, ct.full_name, ct.relationship, ct.primary_email, ct.primary_phone, ct.status
            ${f.emergency ? ', ct.is_emergency_contact' : ''}
            ${f.collect ? ', ct.collect_proposed, ct.collect_proposed_at, ct.collect_declined_at' : ''}
       FROM contacts ct
      WHERE $1 = ANY(ct.child_ids)
      ORDER BY ${f.emergency ? 'ct.is_emergency_contact, ' : ''}CASE ct.relationship
                 WHEN 'Mother' THEN 1 WHEN 'Father' THEN 2 ELSE 3 END, ct.id`,
    [childId]);
  return rows;
}

// ═════════════════════════════════════════════════════════════════════════════
// b342 — the family's own view of their details
// ═════════════════════════════════════════════════════════════════════════════

// What the parents' app calls a relationship, and what is stored. "Other" stores 'Parent' — the same
// "we were not told which" label the profile mirror already uses — and reads back as "Other".
const RELATIONSHIP_CHOICES = [
  { value: 'mother', label: 'Mother',        stored: 'Mother' },
  { value: 'father', label: 'Father',        stored: 'Father' },
  { value: 'carer',  label: 'Carer',         stored: 'Guardian' },
  { value: 'other',  label: 'Other',         stored: 'Parent' },
];
const storedForChoice = v => {
  const hit = RELATIONSHIP_CHOICES.find(c => c.value === String(v || '').toLowerCase());
  return hit ? hit.stored : null;
};
const choiceForStored = stored => {
  const hit = RELATIONSHIP_CHOICES.find(c => c.stored === stored);
  return hit ? hit.value : 'other';
};

const MAX_EMERGENCY = 6;                 // EyMan held up to six per child; more than that is a list nobody rings
const digits = v => String(v == null ? '' : v).replace(/\D/g, '');
const blankToNull = v => { const t = clean(v); return t ? t : null; };
const lc = v => { const t = clean(v); return t ? t.toLowerCase() : null; };
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const isSubset = (a, b) => a.every(x => b.includes(x));

/** Every parent slot (1 and 2) for one child, with the contact behind it. Position pins are honoured. */
async function parentSlotsFor(db, childId) {
  const f = await features(db);
  const { rows } = await db.query(rankedParentsSql(f), [childId, PARENT_RELATIONSHIPS]);
  return rows.map(r => ({ ...r, slot: Number(r.slot) })).sort((a, b) => a.slot - b.slot);
}

/**
 * Pin the current parent positions so that a later relationship edit cannot reorder them.
 * Only ever fills a NULL — a pin someone chose is never moved by this.
 */
async function pinParentSlots(db, childIds) {
  await requireMigrated(db);
  for (const cid of childIds) {
    const slots = await parentSlotsFor(db, cid);
    for (const r of slots) {
      if (r.slot <= 2 && r.parent_slot == null) {
        await db.query('UPDATE contacts SET parent_slot = $2 WHERE id = $1 AND parent_slot IS NULL', [r.id, r.slot]);
      }
    }
  }
}

/**
 * The family's parents, grouped. Children whose parent 1 and parent 2 are the same two people form one
 * group — the normal case is one group for the whole family, so the parents app shows one set of
 * sections. A family whose children have different parents (a blended family) gets a group per set,
 * and nothing is silently merged.
 * @returns [{ key, child_ids:[…], parent1:{…}|null, parent2:{…}|null, others:[…] }]
 */
async function familyGroups(db, childIds) {
  await requireMigrated(db);
  const groups = new Map();
  for (const cid of [...childIds].sort((a, b) => a - b)) {
    const slots = await parentSlotsFor(db, cid);
    const p1 = slots.find(x => x.slot === 1) || null;
    const p2 = slots.find(x => x.slot === 2) || null;
    const key = `${p1 ? p1.id : 0}-${p2 ? p2.id : 0}`;
    if (!groups.has(key)) groups.set(key, { key, child_ids: [], parent1: p1, parent2: p2 });
    groups.get(key).child_ids.push(cid);
  }
  return [...groups.values()];
}

/** People on file for these children who are neither parent 1/2 nor a flagged emergency contact. */
async function otherPeopleFor(db, childIds, exceptIds) {
  const { rows } = await db.query(
    `SELECT ct.id, ct.full_name, ct.relationship
       FROM contacts ct
      WHERE ct.child_ids && $1::int[]
        AND NOT ct.is_emergency_contact
        AND NOT (ct.id = ANY($2::int[]))
        AND ct.archived_at IS NULL
      ORDER BY ct.id`, [childIds, exceptIds.length ? exceptIds : [0]]);
  return rows;
}


/**
 * contacts_phone_only_unique refuses a second contact with the same phone and NO email. A contact the family
 * removed is only detached and archived (never deleted), so re-adding that person hits their old row. An orphan —
 * nobody linked to it any more — is revived rather than refused; a row that still belongs to somebody else's child is
 * not ours to touch, and the caller reports a plain "could not save".
 */
async function phoneOnlyClash(db, phone) {
  if (!phone) return null;
  const { rows } = await db.query(
    `SELECT id, child_ids FROM contacts WHERE primary_email IS NULL AND primary_phone = $1 LIMIT 1`, [phone]);
  if (!rows.length) return null;
  return { id: rows[0].id, orphan: !rows[0].child_ids || rows[0].child_ids.length === 0 };
}
function phoneTaken() { const e = new Error('that phone number is on another record'); e.code = '23505'; return e; }

/**
 * Create or update ONE parent slot for a group of children.
 * The contact is edited in place — it is a person, and they may sit on several children.
 * Editing never removes anybody: a slot that has a person keeps them.
 */
async function upsertParent(db, { childIds, slot, name, email, phone, relationship, adoptId = null }) {
  const f = await requireMigrated(db);
  const stored = storedForChoice(relationship);
  const nm = blankToNull(name), em = lc(email), ph = blankToNull(phone);

  let existing = null;
  for (const cid of childIds) {
    const { rows } = await db.query(rankedParentsSql(f), [cid, PARENT_RELATIONSHIPS]);
    const hit = rows.find(r => Number(r.slot) === slot);
    if (hit) { existing = hit; break; }
  }

  if (existing) {
    const before = { name: existing.full_name, email: existing.primary_email, phone: existing.primary_phone,
                     relationship: existing.relationship };
    const { rows } = await db.query(
      `UPDATE contacts
          SET full_name     = $2,
              primary_email = $3,
              primary_phone = $4,
              relationship  = COALESCE($5, relationship),
              parent_slot   = COALESCE(parent_slot, $6),
              child_ids     = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(child_ids || $7::int[]) x)
        WHERE id = $1
        RETURNING id, full_name, primary_email, primary_phone, relationship`,
      [existing.id, nm, em, ph, stored, slot, childIds]);
    const r = rows[0];
    return { id: r.id, created: false, before,
             after: { name: r.full_name, email: r.primary_email, phone: r.primary_phone, relationship: r.relationship } };
  }

  if (!adoptId && !em && ph) {
    const clash = await phoneOnlyClash(db, ph);
    if (clash) { if (!clash.orphan) throw phoneTaken(); adoptId = clash.id; }
  }
  if (adoptId) {
    // The same person already exists, just not linked to these children yet: link them, do not copy them.
    const cur = (await db.query('SELECT full_name, primary_email, primary_phone, relationship FROM contacts WHERE id = $1', [adoptId])).rows[0];
    const { rows } = await db.query(
      `UPDATE contacts
          SET full_name = $2, primary_email = $3, primary_phone = $4, relationship = COALESCE($5, relationship),
              parent_slot = COALESCE(parent_slot, $6), archived_at = NULL,
              child_ids = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(child_ids || $7::int[]) x)
        WHERE id = $1
        RETURNING id, full_name, primary_email, primary_phone, relationship`,
      [adoptId, nm, em, ph, stored, slot, childIds]);
    const r = rows[0];
    return { id: r.id, created: false, adopted: true,
             before: { name: cur.full_name, email: cur.primary_email, phone: cur.primary_phone, relationship: cur.relationship },
             after: { name: r.full_name, email: r.primary_email, phone: r.primary_phone, relationship: r.relationship } };
  }

  const { rows } = await db.query(
    `INSERT INTO contacts (full_name, primary_email, primary_phone, relationship, child_ids,
                           status, source, parent_slot, created_at)
     VALUES ($1, $2, $3, $4, $5::int[], 'enrolled', 'parents_app', $6, now())
     RETURNING id, full_name, primary_email, primary_phone, relationship`,
    [nm, em, ph, stored || 'Parent', childIds, slot]);
  const r = rows[0];
  return { id: r.id, created: true, before: null,
           after: { name: r.full_name, email: r.primary_email, phone: r.primary_phone, relationship: r.relationship } };
}

// ── Emergency contacts ───────────────────────────────────────────────────────

/** Flagged emergency contacts for these children, with the collection state worked out. */
async function emergencyContactsFor(db, childIds) {
  await requireMigrated(db);
  const { rows } = await db.query(
    `SELECT ct.id, ct.full_name, ct.relationship, ct.primary_phone, ct.child_ids,
            ct.collect_proposed, ct.collect_proposed_at, ct.collect_declined_at
       FROM contacts ct
      WHERE ct.is_emergency_contact AND ct.child_ids && $1::int[]
      ORDER BY ct.id`, [childIds]);
  const { rows: collectors } = await db.query(
    `SELECT child_id, lower(btrim(name)) AS name, phone FROM authorised_collectors
      WHERE child_id = ANY($1::int[]) AND COALESCE(can_collect, true)`, [childIds]);
  return rows.map(r => {
    const approved = collectors.some(c => r.child_ids.includes(c.child_id)
      && ((r.full_name && c.name === r.full_name.trim().toLowerCase())
          || (digits(r.primary_phone).length >= 7 && digits(c.phone) === digits(r.primary_phone))));
    let collect = 'none';
    if (approved) collect = 'approved';
    else if (r.collect_proposed) collect = 'proposed';
    else if (r.collect_declined_at) collect = 'declined';
    return { id: r.id, name: r.full_name, relationship: r.relationship, phone: r.primary_phone,
             child_ids: r.child_ids, collect, legacy: false };
  });
}

/**
 * Emergency contacts that exist ONLY on the flat child columns — typed on the profile before the
 * store carried them. Read-only and side-effect free: they are shown to the family as ordinary
 * entries and become real contact rows the first time the family saves.
 */
async function legacyEmergencyFromColumns(db, childIds, alreadyFlaggedChildIds) {
  const want = childIds.filter(id => !alreadyFlaggedChildIds.includes(id));
  if (!want.length) return [];
  const { rows } = await db.query(
    `SELECT id, emergency_contact_1_name AS n1, emergency_contact_1_phone AS p1, emergency_contact_1_relation AS r1,
            emergency_contact_2_name AS n2, emergency_contact_2_phone AS p2
       FROM children WHERE id = ANY($1::int[]) ORDER BY id`, [want]);
  const out = [], seen = new Set();
  for (const r of rows) {
    for (const [n, p, rel] of [[r.n1, r.p1, r.r1], [r.n2, r.p2, null]]) {
      const name = blankToNull(n), phone = blankToNull(p);
      if (!name && !phone) continue;
      const key = digits(phone) || (name || '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: null, name, relationship: blankToNull(rel), phone, child_ids: [r.id], collect: 'none', legacy: true });
    }
  }
  return out;
}

/** Which of these children have NO emergency contact with a name AND a phone, anywhere we look? (the report asks the same question) */
async function childrenMissingEmergency(db, childIds) {
  const f = await features(db);
  if (!childIds.length) return [];
  const flagged = f.emergency
    ? `EXISTS (SELECT 1 FROM contacts ct WHERE c.id = ANY(ct.child_ids) AND ct.is_emergency_contact
                AND COALESCE(btrim(ct.full_name), '') <> '' AND COALESCE(btrim(ct.primary_phone), '') <> '')` : 'false';
  const { rows } = await db.query(
    `SELECT c.id FROM children c
      WHERE c.id = ANY($1::int[])
        AND NOT (${flagged}
                 OR (COALESCE(btrim(c.emergency_contact_1_name), '') <> '' AND COALESCE(btrim(c.emergency_contact_1_phone), '') <> '')
                 OR (COALESCE(btrim(c.emergency_contact_2_name), '') <> '' AND COALESCE(btrim(c.emergency_contact_2_phone), '') <> ''))
      ORDER BY c.id`, [childIds]);
  return rows.map(r => r.id);
}

/**
 * Reconcile a group's emergency contacts with what the family submitted.
 * `list` entries: { id?, name, relationship, phone, collect }.
 *   · id present   → must be one of the group's own contacts. Edited in place only if the row is
 *                    exclusively this family's; a row shared with another family is never edited here.
 *   · id absent    → a new person.
 *   · not submitted → detached from this group's children (never deleted; archived if nobody is left).
 * `collect` is a PROPOSAL. It can only ever set collect_proposed; the permission itself lives in
 * authorised_collectors and only the office writes it. A collector the office has already approved
 * is left exactly as it is — taking one away is a phone call, not a tick-box.
 */
async function saveEmergencyContacts(db, { childIds, ownedIds, list }) {
  await requireMigrated(db);
  const before = await emergencyContactsFor(db, childIds);
  const byId = new Map(before.map(c => [c.id, c]));
  const out = { added: [], updated: [], removed: [], proposed: [], before, after: [] };
  const keepIds = new Set();

  for (const item of list) {
    const name = blankToNull(item.name), phone = blankToNull(item.phone), rel = blankToNull(item.relationship);
    const wantCollect = item.collect === true;

    if (item.id != null) {
      const cur = byId.get(Number(item.id));
      if (!cur) { const e = new Error('not one of your contacts'); e.code = 'NOT_YOURS'; throw e; }
      if (!isSubset(cur.child_ids, ownedIds)) { const e = new Error('shared with another family'); e.code = 'SHARED_CONTACT'; throw e; }
      keepIds.add(cur.id);
      const changedFields = cur.name !== name || cur.relationship !== rel || cur.phone !== phone;
      let collectSql = '';
      if (cur.collect !== 'approved') {
        if (wantCollect && cur.collect !== 'proposed') { collectSql = ', collect_proposed = true, collect_proposed_at = now(), collect_declined_at = NULL'; out.proposed.push(cur.id); }
        if (!wantCollect && cur.collect === 'proposed') collectSql = ', collect_proposed = false';
      }
      await db.query(
        `UPDATE contacts SET full_name = $2, relationship = $3, primary_phone = $4,
                child_ids = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(child_ids || $5::int[]) x)
                ${collectSql}
          WHERE id = $1`, [cur.id, name, rel, phone, childIds]);
      if (changedFields) out.updated.push(cur.id);
      continue;
    }

    const clash = await phoneOnlyClash(db, phone);
    if (clash && !clash.orphan) throw phoneTaken();
    let newId;
    if (clash) {
      // Somebody this family removed earlier, being added back: revive that row.
      await db.query(
        `UPDATE contacts SET full_name = $2, relationship = $3, child_ids = $4::int[], is_emergency_contact = true,
                archived_at = NULL, collect_proposed = $5, collect_proposed_at = CASE WHEN $5 THEN now() END,
                collect_declined_at = NULL
          WHERE id = $1`, [clash.id, name, rel, childIds, wantCollect]);
      newId = clash.id;
    } else {
      const { rows } = await db.query(
        `INSERT INTO contacts (full_name, relationship, primary_phone, child_ids, status, source,
                               is_emergency_contact, collect_proposed, collect_proposed_at, created_at)
         VALUES ($1, $2, $3, $4::int[], 'enrolled', 'parents_app', true, $5, CASE WHEN $5 THEN now() END, now())
         RETURNING id`, [name, rel, phone, childIds, wantCollect]);
      newId = rows[0].id;
    }
    keepIds.add(newId);
    out.added.push(newId);
    if (wantCollect) out.proposed.push(newId);
  }

  // Anyone this group no longer lists is detached from THESE children only.
  for (const cur of before) {
    if (keepIds.has(cur.id)) continue;
    if (!isSubset(cur.child_ids.filter(id => childIds.includes(id)), ownedIds)) continue;
    const remaining = cur.child_ids.filter(id => !childIds.includes(id));
    await db.query(
      `UPDATE contacts
          SET child_ids = $2::int[],
              is_emergency_contact = ($3::boolean),
              archived_at = CASE WHEN $3::boolean THEN archived_at ELSE now() END
        WHERE id = $1`, [cur.id, remaining, remaining.length > 0]);
    out.removed.push(cur.id);
  }

  out.after = await emergencyContactsFor(db, childIds);
  return out;
}

// ── Contacts → the flat child columns ────────────────────────────────────────

/**
 * Re-derive the flat columns from the store, for these children. `contacts` is the truth; the columns
 * are what invoices and the keepsake send still read. A parent slot with no contact is left alone
 * (never blanked); the two emergency slots always follow the list, so removing the second contact
 * clears the second slot.
 */
async function syncChildColumns(db, childIds) {
  const f = await requireMigrated(db);
  for (const cid of childIds) {
    const slots = await parentSlotsFor(db, cid);
    const sets = [], vals = [cid];
    const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    for (const slot of [1, 2]) {
      const c = slots.find(x => x.slot === slot);
      if (!c) continue;
      put(`parent_${slot}_name`, blankToNull(c.full_name));
      put(`parent_${slot}_email`, lc(c.primary_email));
      put(`parent_${slot}_phone`, blankToNull(c.primary_phone));
    }
    const { rows: ec } = await db.query(
      `SELECT full_name, relationship, primary_phone FROM contacts
        WHERE is_emergency_contact AND $1 = ANY(child_ids) ORDER BY id LIMIT 2`, [cid]);
    put('emergency_contact_1_name', ec[0] ? blankToNull(ec[0].full_name) : null);
    put('emergency_contact_1_phone', ec[0] ? blankToNull(ec[0].primary_phone) : null);
    put('emergency_contact_1_relation', ec[0] ? blankToNull(ec[0].relationship) : null);
    put('emergency_contact_2_name', ec[1] ? blankToNull(ec[1].full_name) : null);
    put('emergency_contact_2_phone', ec[1] ? blankToNull(ec[1].primary_phone) : null);
    await db.query(`UPDATE children SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
  }
  return { children: childIds.length, f };
}

/**
 * Staff typed an emergency contact on the profile (the two flat slots). Carry it into the store so
 * the store stays the truth. By POSITION among this child's flagged contacts, like the parents.
 * A slot cleared on the profile detaches that person from this child — it never deletes them.
 * Best-effort like mirrorParentsToContacts: it must never fail the save the member of staff asked for.
 */
async function mirrorEmergencyToContacts(db, childId, body = {}, row = {}) {
  const touched = Object.keys(body).some(k => /^emergency_contact_[12]_(name|phone|relation)$/.test(k));
  if (!touched) return { mirrored: 0 };
  const f = await features(db);
  if (!f.emergency) return { mirrored: 0, skipped: 'not_migrated' };

  const { rows: flagged } = await db.query(
    `SELECT id, child_ids FROM contacts WHERE is_emergency_contact AND $1 = ANY(child_ids) ORDER BY id`, [childId]);
  let mirrored = 0;

  for (const slot of [1, 2]) {
    const submitted = ['name', 'phone', 'relation'].some(k => body[`emergency_contact_${slot}_${k}`] !== undefined);
    if (!submitted) continue;
    const name = blankToNull(row[`emergency_contact_${slot}_name`]);
    const phone = blankToNull(row[`emergency_contact_${slot}_phone`]);
    const rel = slot === 1 ? blankToNull(row.emergency_contact_1_relation) : null;
    const existing = flagged[slot - 1];

    if (!name && !phone) {
      if (existing) {
        const remaining = existing.child_ids.filter(id => id !== childId);
        await db.query(
          `UPDATE contacts SET child_ids = $2::int[], is_emergency_contact = $3::boolean,
                  archived_at = CASE WHEN $3::boolean THEN archived_at ELSE now() END WHERE id = $1`,
          [existing.id, remaining, remaining.length > 0]);
        mirrored++;
      }
      continue;
    }
    if (existing) {
      await db.query(
        `UPDATE contacts SET full_name = COALESCE($2, full_name), primary_phone = COALESCE($3, primary_phone),
                relationship = COALESCE($4, relationship) WHERE id = $1`, [existing.id, name, phone, rel]);
    } else {
      const clash = await phoneOnlyClash(db, phone);
      if (clash && !clash.orphan) continue;          // that number is on another family's contact; do not touch it
      if (clash) {
        await db.query(
          `UPDATE contacts SET full_name = COALESCE($2, full_name), relationship = COALESCE($3, relationship),
                  child_ids = ARRAY[$4::int], is_emergency_contact = true, archived_at = NULL WHERE id = $1`,
          [clash.id, name, rel, childId]);
      } else {
        await db.query(
          `INSERT INTO contacts (full_name, relationship, primary_phone, child_ids, status, source,
                                 is_emergency_contact, created_at)
           VALUES ($1, $2, $3, ARRAY[$4::int], 'enrolled', 'child_profile', true, now())`,
          [name, rel, phone, childId]);
      }
    }
    mirrored++;
  }
  return { mirrored };
}

module.exports = {
  mirrorParentsToContacts, contactsForChild, PARENT_RELATIONSHIPS,
  // b342
  features, requireMigrated, _resetFeatureCache, rankedParentsSql,
  RELATIONSHIP_CHOICES, storedForChoice, choiceForStored, MAX_EMERGENCY,
  parentSlotsFor, pinParentSlots, familyGroups, otherPeopleFor, upsertParent,
  emergencyContactsFor, legacyEmergencyFromColumns, childrenMissingEmergency, saveEmergencyContacts,
  syncChildColumns, mirrorEmergencyToContacts,
  digits, sameSet, isSubset,
};

