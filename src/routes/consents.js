// Child consent management (photo/media, outings, sunscreen, marketing).
// Admin/staff-facing (authed). Parent-facing read/write lives inline in
// server-unified.js under /welcome/consents/* (CF-Access email scoped).
//
// Storage: child_consents (one row per child+type). Legacy ad-hoc columns
// children.photo_consent / media_consent are kept in sync (dual-write) so
// existing consumers stay correct — see CONSENT_TYPES[].legacy.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

// b265 (2026-09-01): the catalogue moved to src/lib/child-permissions.js so the
// enquiry form, the parents portal, Roost and the media gate all read ONE list.
// It is a superset of the four types this file used to declare — same keys,
// same legacy mapping — plus the registration permissions from the signed terms
// and the category/default/consequence metadata those need. Nothing that
// consumed CONSENT_TYPES has to change; the shape it exported is still here.
const PERMS = require('../lib/child-permissions');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const CONSENT_TYPES = PERMS.CONSENT_TYPES;
const TYPE_KEYS = PERMS.TYPE_KEYS;
const LEGACY_BY_KEY = PERMS.LEGACY_BY_KEY;

// Merge the stored rows onto the full catalogue so every type is represented
// (granted:null when never set).
function mergeConsents(rows) {
  const byType = Object.fromEntries(rows.map(r => [r.consent_type, r]));
  return CONSENT_TYPES.slice()
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map(t => {
      const r = byType[t.key];
      return {
        consent_type: t.key,
        label: t.label,
        help: t.help,
        icon: t.icon,
        // b265 additions — a UI can now render the mandatory/optional split, say
        // what follows from a "no", and show where the position came from.
        category: t.category || 'optional',
        detail: t.detail || null,
        // b340 — mandatory items are not switches. The parents screen renders
        // `why` for them, and offers a switch only where family_can_set is true.
        why: t.why || null,
        in_accepted_terms: t.category === 'mandatory' ? t.in_accepted_terms === true : null,
        family_can_set: PERMS.familyCanSet(t.key),
        consequence: t.consequence || null,
        default_granted: t.default_granted === undefined ? null : t.default_granted,
        withdrawable_in_portal: !!t.withdrawable_in_portal,
        governs_group_media: !!t.enforces_group_media,
        granted: r ? r.granted : null,
        consent_date: r ? r.consent_date : null,
        source: r ? r.source : null,
        // "who decided this, and how do we know" — see PERMS.SOURCE_EVIDENCE.
        // null when nothing is recorded at all, which is the honest answer and
        // the thing the reconciliation report counts.
        evidence: r && r.source ? (PERMS.SOURCE_EVIDENCE[r.source] || 'unknown') : null,
        notes: r ? (r.notes || null) : null,
        updated_at: r ? r.updated_at : null,
      };
    });
}

// Upsert a single consent and keep the legacy children.* column in sync.
// `updatedBy`: staff id (manager) or 0 (parent). Returns the merged row.
async function setConsent(db, childId, consentType, granted, source, updatedBy, notes) {
  if (!TYPE_KEYS.has(consentType)) throw new Error('Unknown consent_type');
  // b265: record the source honestly. A permission that came from the terms at
  // registration is not the same evidence as one a parent ticked, so an unknown
  // label is rejected rather than quietly stored.
  const src = PERMS.SOURCE_SET.has(source) ? source : 'manager';
  const g = (granted === null || granted === undefined) ? null : !!granted;
  await db.query(`
    INSERT INTO child_consents (child_id, consent_type, granted, consent_date, source, updated_by, updated_at, notes)
    VALUES ($1,$2,$3::boolean, CASE WHEN $3::boolean IS NULL THEN NULL ELSE CURRENT_DATE END, $4, $5, now(), $6)
    ON CONFLICT (child_id, consent_type) DO UPDATE
      SET granted=EXCLUDED.granted, consent_date=EXCLUDED.consent_date,
          source=EXCLUDED.source, updated_by=EXCLUDED.updated_by, updated_at=now(),
          notes=COALESCE(EXCLUDED.notes, child_consents.notes)
  `, [childId, consentType, g, src, updatedBy, notes || null]);
  // ── Keeping the two stores in step ──────────────────────────────────────────
  // child_consents is canonical; children.photo_consent / .media_consent are the
  // legacy booleans other code still reads. b265 keeps them aligned BOTH ways:
  //   • here, because setConsent is the single writer every Wren surface uses;
  //   • and by a trigger (scripts/b265-consent-schema.sql), so a hand-written
  //     UPDATE or an import that bypasses this function cannot desync them.
  // Belt and braces on purpose — the two stores disagreeing is the bug this
  // build exists to fix, and one writer is only one bad script away from
  // being two.
  const legacyCol = LEGACY_BY_KEY[consentType];
  if (legacyCol) {
    // A null granted means "nothing recorded". The legacy column has no way to
    // say that, so it takes false — which is what every consumer of it already
    // assumes for an unset consent.
    await db.query(`UPDATE children SET ${legacyCol}=$1 WHERE id=$2`, [g === null ? false : g, childId]);
  }
}

/**
 * b265 — write the permissions a REGISTRATION establishes, in one transaction.
 *
 * Mandatory items land granted=true with source='registration' unless the
 * family opted out on the form; optional items are only written if the family
 * actually answered. Nothing here decides for a family that said nothing.
 *
 * Idempotent by design: re-running for the same child updates the same rows
 * (the child_id+consent_type unique index), so a re-submitted form or a second
 * enrolment pass cannot double-write or flip a later portal choice back —
 * `skipExisting` (default true) leaves any row a parent has already touched
 * alone.
 */
async function applyRegistrationConsents(db, childId, choices, updatedBy, opts) {
  const o = opts || {};
  const skipExisting = o.skipExisting !== false;
  const rows = PERMS.registrationRows(choices);
  let existing = new Set();
  if (skipExisting) {
    const cur = await db.query(
      `SELECT consent_type FROM child_consents WHERE child_id=$1 AND granted IS NOT NULL`, [childId]);
    existing = new Set(cur.rows.map(r => r.consent_type));
  }
  const written = [];
  for (const r of rows) {
    if (existing.has(r.consent_type)) continue;
    await setConsent(db, childId, r.consent_type, r.granted, 'registration', updatedBy || 0, o.notes || null);
    written.push({ consent_type: r.consent_type, granted: r.granted });
  }
  return { child_id: childId, written, skipped: rows.length - written.length };
}

router.use(authenticate);

const MGR_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher'];

// GET /api/consents/types — the catalogue (labels/help for UIs)
router.get('/types', (_req, res) => res.json(CONSENT_TYPES));

// GET /api/consents/child/:childId — current consents for a child (admin view)
router.get('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT consent_type, granted, consent_date, source, updated_at FROM child_consents WHERE child_id=$1',
      [parseInt(req.params.childId, 10)]
    );
    res.json({ child_id: parseInt(req.params.childId, 10), consents: mergeConsents(rows) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/consents/overview — all active children with a compact consent summary
// (manager oversight — one row per child).
router.get('/overview', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.room_id, r.name AS room_name,
             COALESCE(json_agg(json_build_object(
                 'consent_type', cc.consent_type, 'granted', cc.granted
             ) ORDER BY cc.consent_type) FILTER (WHERE cc.consent_type IS NOT NULL), '[]') AS consents
      FROM children c
      LEFT JOIN rooms r ON r.id=c.room_id
      LEFT JOIN child_consents cc ON cc.child_id=c.id
      WHERE COALESCE(c.is_active,true)=true
      GROUP BY c.id, c.first_name, c.last_name, c.room_id, r.name
      ORDER BY c.first_name, c.last_name
    `);
    // The not-asked count is an addition to this report; if it ever fails the report itself must still load.
    const not_asked = await buildNotAsked(db).catch(e => { console.error('consents overview: not_asked failed:', e.message); return null; });
    res.json({ types: CONSENT_TYPES, children: rows, not_asked });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * b340 — who has never been ASKED an optional question. A child with no row (or a
 * row holding null) for an optional key is "not asked yet", which is not a refusal
 * and must never be read as one. This is what a manager works from at drop-off
 * when a permission moves from "part of registration" to "a real choice": Calpol
 * and the sunhat did exactly that in b340, and most families were never asked.
 * Pure SELECT; counts and child ids only.
 */
async function buildNotAsked(db) {
  const keys = PERMS.OPTIONAL_KEYS;
  const { rows } = await db.query(`
    SELECT k.key AS consent_type, c.id AS child_id
      FROM children c
     CROSS JOIN unnest($1::text[]) AS k(key)
      LEFT JOIN child_consents cc ON cc.child_id = c.id AND cc.consent_type = k.key
     WHERE COALESCE(c.is_active, true) = true AND cc.granted IS NULL`, [keys]);
  const byType = Object.fromEntries(keys.map(k => [k, 0]));
  const kids = new Set();
  for (const r of rows) { byType[r.consent_type]++; kids.add(r.child_id); }
  const { rows: [t] } = await db.query(
    `SELECT count(*)::int AS n FROM children WHERE COALESCE(is_active, true) = true`);
  return { active_children: t.n, children_with_gap: kids.size, by_type: byType };
}

// PUT /api/consents/child/:childId — manager sets/overrides one consent
// body: { consent_type, granted (bool|null) }
router.put('/child/:childId', async (req, res) => {
  if (!MGR_ROLES.includes(req.user && req.user.role)) {
    return res.status(403).json({ error: 'Manager or deputy only' });
  }
  const childId = parseInt(req.params.childId, 10);
  const { consent_type, granted, source, notes } = req.body || {};
  if (!TYPE_KEYS.has(consent_type)) return res.status(400).json({ error: 'Unknown consent_type' });
  try {
    const db = getPool();
    // b265: a manager recording a letter from the family should say so —
    // 'written_notice' is real evidence, 'manager' (the default) is not.
    const src = (source === 'written_notice' || source === 'registration') ? source : 'manager';
    await setConsent(db, childId, consent_type, granted, src, req.user.id, notes);
    const { rows } = await db.query(
      'SELECT consent_type, granted, consent_date, source, notes, updated_at FROM child_consents WHERE child_id=$1',
      [childId]
    );
    res.json({ child_id: childId, consents: mergeConsents(rows) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ b265 additions ═════════════════════════════════════════════════════════

// GET /api/consents/catalogue — the full permissions model for a UI: the
// mandatory/optional split, the wording, the consequence of a "no", and the
// honest notice about what a nursery can and cannot control.
router.get('/catalogue', (_req, res) => res.json({
  permissions: PERMS.publicCatalogue(),
  opt_out_basis: PERMS.OPT_OUT_BASIS,
  media_reality_notice: PERMS.MEDIA_REALITY_NOTICE,
  download_warning: PERMS.DOWNLOAD_WARNING,
  group_media_key: PERMS.GROUP_MEDIA_KEY,
  sources: PERMS.SOURCES,
  sections: PERMS.sectionCopy(),     // b340: the two sections of the parents screen
}));

// POST /api/consents/child/:childId/registration — write the registration
// position for a child. Used when an enquiry becomes a provisional/enrolled
// child, and by Roost when a paper registration is keyed in.
// body: { choices: {consent_type: true|false}, overwrite?: bool, notes?: string }
router.post('/child/:childId/registration', async (req, res) => {
  if (!MGR_ROLES.includes(req.user && req.user.role)) {
    return res.status(403).json({ error: 'Manager or deputy only' });
  }
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'bad child id' });
  const { choices, overwrite, notes } = req.body || {};
  try {
    const db = getPool();
    const out = await applyRegistrationConsents(db, childId, choices || {}, req.user.id,
      { skipExisting: !overwrite, notes });
    const { rows } = await db.query(
      'SELECT consent_type, granted, consent_date, source, notes, updated_at FROM child_consents WHERE child_id=$1',
      [childId]);
    res.json({ ...out, consents: mergeConsents(rows) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/consents/reconciliation — READ-ONLY. What the terms imply versus
// what is actually stored, per permission, for active children.
//
// This endpoint DOES NOT WRITE ANYTHING. Migrating 246 children from "nothing
// recorded" to "granted" is a decision with a legal character; it is Toby's to
// make and to date, so this reports and proposes and stops there. The single
// reviewed action it describes is executed only by POST /reconciliation/apply,
// which needs an explicit confirmation phrase.
router.get('/reconciliation', async (req, res) => {
  if (!MGR_ROLES.includes(req.user && req.user.role)) {
    return res.status(403).json({ error: 'Manager or deputy only' });
  }
  try {
    res.json(await buildReconciliation(getPool()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/consents/reconciliation/apply — the one reviewed action, gated.
// Requires { confirm: "APPLY REGISTERED TERMS", consent_types: [...] } and a
// manager. Writes source='registration' rows ONLY where nothing is recorded —
// it never overturns a position a family actually took.
router.post('/reconciliation/apply', async (req, res) => {
  if (!(req.user && hasRole(req.user, ['manager', 'admin']))) {
    return res.status(403).json({ error: 'Manager only — this records a legal position for every child.' });
  }
  const { confirm, consent_types } = req.body || {};
  if (confirm !== 'APPLY REGISTERED TERMS') {
    return res.status(400).json({
      error: 'Confirmation phrase required',
      hint: 'POST { "confirm": "APPLY REGISTERED TERMS", "consent_types": ["photo_media", ...] }',
    });
  }
  const wanted = Array.isArray(consent_types)
    ? consent_types.filter(k => PERMS.MANDATORY_KEYS.includes(k))
    : [];
  if (!wanted.length) {
    return res.status(400).json({ error: 'consent_types must name at least one mandatory permission',
      allowed: PERMS.MANDATORY_KEYS });
  }
  try {
    const db = getPool();
    const before = await buildReconciliation(db);
    // Insert-where-missing only. ON CONFLICT DO NOTHING means a child who
    // already has a row — granted or withdrawn — is untouched.
    const { rows } = await db.query(`
      INSERT INTO child_consents (child_id, consent_type, granted, consent_date, source, updated_by, updated_at, notes)
      SELECT c.id, t.k, true, CURRENT_DATE, 'registration', $2, now(),
             'b265 reconciliation: recorded from the signed registration terms'
        FROM children c CROSS JOIN unnest($1::text[]) AS t(k)
       WHERE COALESCE(c.is_active, true) = true
      ON CONFLICT (child_id, consent_type) DO NOTHING
      RETURNING child_id, consent_type`, [wanted, req.user.id]);
    // Bring the legacy booleans along for the types that have one.
    for (const k of wanted) {
      const col = LEGACY_BY_KEY[k];
      if (!col) continue;
      await db.query(
        `UPDATE children SET ${col}=true WHERE id IN (
           SELECT child_id FROM child_consents WHERE consent_type=$1 AND granted=true)`, [k]);
    }
    res.json({ ok: true, applied: rows.length, consent_types: wanted,
      before: before.totals, after: (await buildReconciliation(db)).totals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * The reconciliation figures. Pure SELECT — safe to run against production.
 * Also used by scripts/consent-reconciliation.js so the CLI report and the
 * screen can never disagree.
 */
async function buildReconciliation(db) {
  const { rows: [tot] } = await db.query(`
    SELECT count(*)::int AS children_total,
           count(*) FILTER (WHERE COALESCE(is_active,true))::int AS children_active,
           count(*) FILTER (WHERE photo_consent)::int AS legacy_photo_true,
           count(*) FILTER (WHERE media_consent)::int AS legacy_media_true
      FROM children`);
  const { rows: perType } = await db.query(`
    SELECT cc.consent_type,
           count(*)::int AS rows_stored,
           count(*) FILTER (WHERE cc.granted IS TRUE)::int  AS granted,
           count(*) FILTER (WHERE cc.granted IS FALSE)::int AS withdrawn,
           count(*) FILTER (WHERE cc.granted IS NULL)::int  AS unset,
           count(*) FILTER (WHERE cc.source IN ('parent_portal','written_notice','manager'))::int AS from_a_person,
           count(*) FILTER (WHERE cc.source = 'registration')::int AS from_the_terms,
           count(*) FILTER (WHERE cc.source IS NULL OR cc.source IN ('imported','migrated','parent'))::int AS evidence_unknown,
           count(*) FILTER (WHERE cc.granted IS FALSE
                              AND (cc.source IS NULL OR cc.source IN ('imported','migrated','parent')))::int AS no_by_nobody
      FROM child_consents cc
      JOIN children c ON c.id = cc.child_id AND COALESCE(c.is_active,true)
     GROUP BY cc.consent_type`);
  const byType = Object.fromEntries(perType.map(r => [r.consent_type, r]));

  const permissions = PERMS.CONSENT_TYPES.slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(t => {
      const r = byType[t.key] || { rows_stored: 0, granted: 0, withdrawn: 0, unset: 0,
                                   from_a_person: 0, from_the_terms: 0, evidence_unknown: 0,
                                   no_by_nobody: 0 };
      const noPosition = tot.children_active - r.rows_stored;
      return {
        consent_type: t.key,
        label: t.label,
        category: t.category,
        terms_imply: t.category === 'mandatory' ? 'granted' : 'a choice the family makes',
        stored_granted: r.granted,
        stored_withdrawn: r.withdrawn,
        stored_unset: r.unset,
        no_position_recorded: noPosition,
        from_a_person: r.from_a_person,
        from_the_terms: r.from_the_terms,
        evidence_unknown: r.evidence_unknown,
        // Stored as a "no" that no person ever chose. Distinct from "no row" and
        // arguably worse: a missing row is silence, this is a recorded refusal
        // attributed to a family that never gave one.
        no_recorded_by_nobody: r.no_by_nobody,
        // A mandatory item with no row is the exact gap this build found: the
        // terms say yes, the database says nothing, and code reads nothing as no.
        contradicts_terms: t.category === 'mandatory' ? (noPosition + r.withdrawn - r.from_a_person) : 0,
      };
    });

  // Do the two stores agree? photo_media ↔ children.photo_consent and
  // marketing_face ↔ children.media_consent, for active children.
  const { rows: [drift] } = await db.query(`
    SELECT
      count(*) FILTER (WHERE cc.consent_type='photo_media'
                         AND cc.granted IS DISTINCT FROM COALESCE(c.photo_consent,false))::int AS photo_mismatch,
      count(*) FILTER (WHERE cc.consent_type='marketing_face'
                         AND cc.granted IS DISTINCT FROM COALESCE(c.media_consent,false))::int AS media_mismatch
      FROM child_consents cc JOIN children c ON c.id=cc.child_id
     WHERE COALESCE(c.is_active,true) AND cc.granted IS NOT NULL`);

  const mandatoryGap = permissions
    .filter(p => p.category === 'mandatory')
    .reduce((n, p) => n + p.no_position_recorded, 0);

  // The active-children figures above are the ones an action would touch. These
  // are the whole roll — leavers included — because that is where the headline
  // "246 false, 1 true" comes from and it should still be visible.
  const { rows: [allRows] } = await db.query(`
    SELECT count(*)::int AS consent_rows,
           count(*) FILTER (WHERE granted IS TRUE)::int  AS granted,
           count(*) FILTER (WHERE granted IS FALSE)::int AS withdrawn,
           count(*) FILTER (WHERE granted IS FALSE
                              AND (source IS NULL OR source IN ('imported','migrated','parent')))::int
             AS no_recorded_by_nobody
      FROM child_consents`);
  const allChildren = {
    children: tot.children_total,
    ...allRows,
    legacy_photo_true: tot.legacy_photo_true,
    legacy_photo_false: tot.children_total - tot.legacy_photo_true,
    legacy_media_true: tot.legacy_media_true,
  };

  return {
    generated_at: new Date().toISOString(),
    read_only: true,
    totals: {
      ...tot,
      consent_rows: perType.reduce((n, r) => n + r.rows_stored, 0),
      mandatory_positions_missing: mandatoryGap,
      stores_in_step: drift.photo_mismatch === 0 && drift.media_mismatch === 0,
      store_drift: drift,
    },
    permissions,
    all_children: allChildren,
    the_second_question: {
      what: `${allRows.no_recorded_by_nobody} consent rows across the whole roll are stored as "no" `
          + `with no evidence behind them — source "migrated"/"imported", nobody's decision. `
          + `That is not silence, it is a recorded refusal attributed to families who never gave one.`,
      not_touched: 'The apply action above is insert-only (ON CONFLICT DO NOTHING), so it cannot and does '
                 + 'not overturn these. Changing a stored refusal is a separate decision and this build '
                 + 'does not build a button for it.',
    },
    the_finding:
      `The signed terms grant ${PERMS.MANDATORY_KEYS.length} permissions on registration unless a family gives `
      + `written notice otherwise. Across ${tot.children_active} active children that is `
      + `${tot.children_active * PERMS.MANDATORY_KEYS.length} positions the terms establish; `
      + `${mandatoryGap} of them have no row in Wren at all, and every consumer reads a missing row as "no". `
      + `That is the contradiction — not the policy.`,
    the_action: {
      what: 'Record the mandatory permissions as granted, source="registration", for active children who have '
          + 'no row for them. Children who already have a position — granted or withdrawn — are not touched.',
      how: 'POST /api/consents/reconciliation/apply { "confirm": "APPLY REGISTERED TERMS", "consent_types": [...] }',
      who: 'Manager only.',
      not_done_here: 'This build deliberately does NOT flip anything. Dating a consent migration is a decision '
                   + 'with a legal character and it is Toby\'s to make.',
      rows_it_would_write: mandatoryGap,
    },
  };
}

module.exports = router;
module.exports.CONSENT_TYPES = CONSENT_TYPES;
module.exports.TYPE_KEYS = TYPE_KEYS;
module.exports.mergeConsents = mergeConsents;
module.exports.setConsent = setConsent;
module.exports.applyRegistrationConsents = applyRegistrationConsents;
module.exports.buildReconciliation = buildReconciliation;
module.exports.buildNotAsked = buildNotAsked;
module.exports.PERMS = PERMS;
