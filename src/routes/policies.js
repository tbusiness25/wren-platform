const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
// b285 — the setting's policy order, and the publish that propagates a change.
const policyOrder = require('../lib/policy-order');
const termsPublish = require('../lib/terms-publish');
const termsDoc = require('../lib/terms-doc');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];

// List active policies relevant to this staff member's role
router.get('/', async (req, res) => {
  const db = getPool();
  const isManager = hasRole(req.user, MANAGER_ROLES);
  try {
    let rows;
    if (isManager) {
      ({ rows } = await db.query(`
        SELECT p.*,
          COUNT(pa.id) FILTER (WHERE pa.policy_version = p.version) AS ack_count,
          COUNT(s.id) FILTER (WHERE s.is_active = true) AS staff_count,
          EXISTS(SELECT 1 FROM policy_acknowledgments mya
                 WHERE mya.policy_id = p.id AND mya.staff_id = $1
                   AND mya.policy_version = p.version) AS acknowledged
        FROM policies p
        LEFT JOIN policy_acknowledgments pa ON pa.policy_id = p.id
        LEFT JOIN staff s ON s.is_active = true
        WHERE p.is_active = true
        GROUP BY p.id
        -- b285: was published_at DESC, i.e. "most recently touched first", which
        -- is the one order nobody asked for. The setting's own order now, so the
        -- manager's list matches what staff and parents see.
        ORDER BY p.sort_order NULLS LAST, p.title`,
        [req.user.id]));
    } else {
      ({ rows } = await db.query(`
        SELECT p.*,
          pa.acknowledged_at,
          (pa.id IS NOT NULL) AS acknowledged
        FROM policies p
        LEFT JOIN policy_acknowledgments pa
          ON pa.policy_id = p.id AND pa.staff_id = $1 AND pa.policy_version = p.version
        WHERE p.is_active = true AND $2 = ANY(p.required_roles)
        -- b285: unsigned still leads — the EY page renders "Needs signing" and
        -- "Signed" as two lists and that split has to survive — but WITHIN each
        -- of those the setting's order applies, so safeguarding is first in both.
        ORDER BY (pa.id IS NULL) DESC, p.sort_order NULLS LAST, p.title`,
        [req.user.id, req.user.role]));
    }
    res.json(rows);
  } catch (err) {
    console.error('policies GET /', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get single policy with acknowledgment status for current user
router.get('/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT * FROM policies WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const policy = rows[0];
    const { rows: ack } = await db.query(
      `SELECT acknowledged_at FROM policy_acknowledgments
       WHERE policy_id = $1 AND staff_id = $2 AND policy_version = $3`,
      [req.params.id, req.user.id, policy.version]
    );
    res.json({ ...policy, acknowledged: ack.length > 0, acknowledged_at: ack[0]?.acknowledged_at || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Staff acknowledges a policy
router.post('/:id/acknowledge', async (req, res) => {
  const db = getPool();
  try {
    const { rows: pol } = await db.query('SELECT version FROM policies WHERE id = $1 AND is_active = true', [req.params.id]);
    if (!pol.length) return res.status(404).json({ error: 'Policy not found' });
    await db.query(
      `INSERT INTO policy_acknowledgments (policy_id, staff_id, policy_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (policy_id, staff_id, policy_version) DO NOTHING`,
      [req.params.id, req.user.id, pol[0].version]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: get acknowledgment status (who has read a policy)
router.get('/:id/acknowledgments', async (req, res) => {
  if (!hasRole(req.user, MANAGER_ROLES)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  try {
    const { rows: pol } = await db.query('SELECT version FROM policies WHERE id = $1', [req.params.id]);
    const version = pol[0]?.version;
    const { rows } = await db.query(`
      SELECT s.id, (s.first_name || ' ' || s.last_name) AS name, s.role, pa.acknowledged_at,
        (pa.id IS NOT NULL) AS signed_current_version
      FROM staff s
      LEFT JOIN policy_acknowledgments pa
        ON pa.staff_id = s.id AND pa.policy_id = $1 AND pa.policy_version = $2
      WHERE s.is_active = true
      ORDER BY pa.acknowledged_at NULLS LAST, s.first_name, s.last_name`,
      [req.params.id, version]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: create a new policy
router.post('/', async (req, res) => {
  if (!hasRole(req.user, MANAGER_ROLES)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  const { title, content, category, required_roles } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title and content required' });
  try {
    // b285 — a new policy gets a place in the setting's order at creation, from
    // the same classifier that seeded the existing ones. Without this it would
    // have a NULL sort_order and land at the very bottom of every list.
    let sortOrder = null;
    try { sortOrder = await policyOrder.nextSortOrder(db, title, category); }
    catch (e) { console.error('policies POST / sort_order:', e.message); }
    const { rows } = await db.query(`
      INSERT INTO policies (title, content, category, required_roles, is_active, published_at, sort_order)
      VALUES ($1, $2, $3, $4, true, now(), $5) RETURNING *`,
      [title, content, category || null, required_roles || ['practitioner','room_leader','manager', 'admin'], sortOrder]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: update a policy (bump_version resets acknowledgments)
router.patch('/:id', async (req, res) => {
  if (!hasRole(req.user, MANAGER_ROLES)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  const { title, content, category, required_roles, is_active, bump_version,
          review_due, review_interval_months } = req.body;   // b186 — policy review cycle
  if (review_due && !/^\d{4}-\d{2}-\d{2}$/.test(review_due)) {
    return res.status(400).json({ error: 'review_due must be YYYY-MM-DD' });
  }
  try {
    const versionClause = bump_version ? ', version = version + 1' : '';
    // b186: a version bump IS a review — roll the next review date forward by the
    // policy's own interval, unless the caller set review_due explicitly.
    // ONE assignment to review_due either way (Postgres rejects two).
    // Both branches must reference $7 and $8 — Postgres rejects a bind with an
    // unreferenced parameter ("could not determine data type of parameter $7").
    const reviewDueClause = bump_version
      ? `, review_due = COALESCE($7::date, (CURRENT_DATE + (COALESCE($8, review_interval_months, 12) || ' months')::interval)::date)`
      : ', review_due = COALESCE($7::date, review_due)';
    const { rows } = await db.query(`
      UPDATE policies
      SET title = COALESCE($1, title),
          content = COALESCE($2, content),
          category = COALESCE($3, category),
          required_roles = COALESCE($4, required_roles),
          is_active = COALESCE($5, is_active),
          review_interval_months = COALESCE($8, review_interval_months)
          ${versionClause}${reviewDueClause}
      WHERE id = $6 RETURNING *`,
      [title, content, category, required_roles, is_active, req.params.id,
       review_due || null, review_interval_months || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    // Version bump = re-issue for signing: notify every active staff member whose
    // role the policy applies to (2026-07-14 — EYFS-change re-sign flow).
    if (bump_version) {
      const p = rows[0];
      try {
        await db.query(`
          INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
          SELECT 'staff', s.id, 'policy',
            $1, $2, '/policies.html', 'policies', $3, 'high'
          FROM staff s
          WHERE s.is_active = true AND s.role = ANY($4::text[])`,
          [`✍️ Policy updated — please re-sign: ${p.title}`,
           `"${p.title}" has been updated to version ${p.version}. Please read the new version and sign to confirm. Your previous signature no longer covers this version.`,
           p.id, p.required_roles || []]);
      } catch (e) {
        console.error('policies re-sign notify:', e.message);
      }
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// b249 — MANDATORY POLICIES: who still has to sign.
//
// APPENDED. Nothing above this line was changed: the acknowledge route, the
// list, the manager coverage query and the PATCH re-issue flow are exactly as
// they were. The gap b249 fills is that a policy could not be marked "everybody
// must sign this" — so nothing chased anyone, and the 18 active staff who each
// have to sign the CCTV notification before the cameras go on would have been
// chased by memory. policies.requires_acknowledgment (migration
// 2026-09-01-b249-cctv-compliance.sql §1) is that flag; these routes read it.
//
// WHO IS COUNTED. A policy applies to the roles in required_roles, so the
// denominator is active staff whose role is in that array — not every member of
// staff. The CCTV notification deliberately lists all six roles, including the
// apprentice and the cook, because the document says it is issued to every
// member of staff. The other 61 policies list three, and this query respects
// that rather than overriding it.
//
// WHY VERSION IS IN THE JOIN. A signature is against a version. When a policy is
// bumped, everyone is outstanding again — which is the existing behaviour of
// POST /:id/acknowledge and the PATCH re-issue notification, and it must stay
// true of the counting or the two would disagree.
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/policies/mandatory/outstanding
// Manager view: every must-sign policy with who has not signed the CURRENT
// version. Feeds the Cockpit attention item and the staff page's chase banner.
router.get('/mandatory/outstanding', async (req, res) => {
  if (!hasRole(req.user, MANAGER_ROLES)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT p.id, p.title, p.version, p.version_label, p.category, p.effective_date,
             p.parent_facing, p.requires_parent_signature,
             COUNT(s.id)::int AS applies_to,
             COUNT(pa.id)::int AS signed,
             (COUNT(s.id) - COUNT(pa.id))::int AS outstanding,
             COALESCE(
               json_agg(json_build_object('id', s.id, 'name', TRIM(s.first_name || ' ' || s.last_name), 'role', s.role)
                        ORDER BY s.first_name, s.last_name)
               FILTER (WHERE pa.id IS NULL), '[]'::json) AS outstanding_staff
        FROM policies p
        JOIN staff s
          ON s.is_active = true AND s.role = ANY(p.required_roles)
        LEFT JOIN policy_acknowledgments pa
          ON pa.policy_id = p.id AND pa.staff_id = s.id AND pa.policy_version = p.version
       WHERE p.is_active = true AND p.requires_acknowledgment = true
       GROUP BY p.id
       ORDER BY (COUNT(s.id) - COUNT(pa.id)) DESC, p.title`);
    res.json({
      policies: rows,
      total_outstanding: rows.reduce((n, r) => n + r.outstanding, 0),
    });
  } catch (err) {
    console.error('policies GET /mandatory/outstanding', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/policies/mandatory/mine
// What the signed-in member of staff still owes. Any role — this is the number
// the staff policies page puts at the top of the screen, and a practitioner
// must be able to see their own.
router.get('/mandatory/mine', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT p.id, p.title, p.version, p.version_label, p.category,
             (pa.id IS NOT NULL) AS acknowledged, pa.acknowledged_at
        FROM policies p
        LEFT JOIN policy_acknowledgments pa
          ON pa.policy_id = p.id AND pa.staff_id = $1 AND pa.policy_version = p.version
       WHERE p.is_active = true AND p.requires_acknowledgment = true
         AND $2 = ANY(p.required_roles)
       ORDER BY (pa.id IS NULL) DESC, p.title`, [req.user.id, req.user.role]);
    res.json({
      policies: rows,
      outstanding: rows.filter(r => !r.acknowledged).length,
    });
  } catch (err) {
    console.error('policies GET /mandatory/mine', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/policies/:id/parent-signatures
// Manager view of the OTHER signature book — the parents one. Kept here rather
// than in a parents route because this is the manager asking "who has signed
// the privacy notice", which belongs beside "who has signed the staff notice".
router.get('/:id/parent-signatures', async (req, res) => {
  if (!hasRole(req.user, MANAGER_ROLES)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  try {
    const { rows: pol } = await db.query(
      'SELECT id, title, version, version_label FROM policies WHERE id = $1', [req.params.id]);
    if (!pol.length) return res.status(404).json({ error: 'Not found' });
    const p = pol[0];
    // The denominator is every active portal address, not every child: one adult
    // signs once, however many children they have here.
    const { rows: signed } = await db.query(`
      SELECT a.parent_email, a.acknowledged_at, a.policy_version, a.version_label, a.source
        FROM parent_policy_acknowledgments a
       WHERE a.policy_id = $1 AND a.policy_version = $2
       ORDER BY a.acknowledged_at DESC`, [p.id, p.version]);
    const { rows: totals } = await db.query(`
      SELECT COUNT(DISTINCT lower(email))::int AS parents
        FROM parent_portal_access WHERE is_active = true`);

    // ── b274 — the OTHER half of the answer: who has NOT accepted ────────────
    // b249 built the count and the signed list. A manager chasing a version bump
    // needs the roll, so this rolls every active portal address against the
    // CURRENT version and, separately, against any EARLIER one.
    //
    // The prior-version column is the point of the whole build. A bump makes
    // every acceptance invalid (parent_policy_ack_uq carries policy_version),
    // and without this a family who signed v1 and has not yet seen v2 is
    // indistinguishable from a family who has never signed anything — which is
    // the difference between "remind them" and "chase them".
    //
    // ⚠️ THE DENOMINATOR IS parent_portal_access, NOT staff. b249 §4 exists
    // because parent rows in the staff acknowledgment table made the manager's
    // coverage figure read 40 of 18. Nothing in this query touches staff or
    // policy_acknowledgments; scripts/b274-verify.js §5 asserts that.
    const { rows: roll } = await db.query(`
      WITH parents AS (
        SELECT lower(email) AS email, COUNT(DISTINCT child_id)::int AS children
          FROM parent_portal_access WHERE is_active = true GROUP BY 1
      ), cur AS (
        SELECT lower(parent_email) AS email, MAX(acknowledged_at) AS at, MIN(source) AS source
          FROM parent_policy_acknowledgments
         WHERE policy_id = $1 AND policy_version = $2 GROUP BY 1
      ), prior AS (
        SELECT lower(parent_email) AS email, MAX(policy_version) AS version, MAX(acknowledged_at) AS at
          FROM parent_policy_acknowledgments
         WHERE policy_id = $1 AND policy_version < $2 GROUP BY 1
      )
      SELECT p.email, p.children,
             (cur.email IS NOT NULL) AS accepted,
             cur.at AS accepted_at, cur.source,
             prior.version AS prior_version, prior.at AS prior_at
        FROM parents p
        LEFT JOIN cur   ON cur.email   = p.email
        LEFT JOIN prior ON prior.email = p.email
       ORDER BY (cur.email IS NULL) DESC, (prior.version IS NOT NULL) DESC, p.email`,
      [p.id, p.version]);

    const accepted = roll.filter(r => r.accepted);
    const outstanding = roll.filter(r => !r.accepted);
    res.json({
      policy: p,
      signed_count: signed.length,
      parent_count: totals[0].parents,
      outstanding: Math.max(0, totals[0].parents - signed.length),
      signatures: signed,
      // b274 additions — the roll. accepted_count counts ACTIVE portal
      // addresses, so it can be lower than signed_count if somebody accepted and
      // their access was since closed; that is the honest figure to chase from.
      accepted_count: accepted.length,
      outstanding_count: outstanding.length,
      lapsed_count: outstanding.filter(r => r.prior_version != null).length,
      parents: roll,
    });
  } catch (err) {
    console.error('policies GET /:id/parent-signatures', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// b285 — THE REVIEWER: draft → preview → publish, version history, and order.
//
// APPENDED. Nothing above this line changed except three things, each marked
// with a b285 comment where it sits: the two list ORDER BYs (so every surface
// shows the setting's order) and POST / (so a new policy gets a place in it).
// The acknowledge route, the PATCH re-issue flow, b249's mandatory-policy
// queries and b274's parent acceptance roll are untouched.
//
// ── WHY PUBLISH IS NOT PATCH ─────────────────────────────────────────────────
// PATCH /:id writes ladn.policies directly, and every parent-facing surface
// reads ladn.policies on the request. So a half-finished edit saved through
// PATCH is live to parents the moment it is saved. Toby asked for a reviewer he
// can edit in; "publish is explicit; an edit in progress never reaches parents"
// is the requirement that follows. Hence:
//
//   PUT    /:id/draft     writes ladn.policy_edit_drafts. Parents see nothing.
//   POST   /:id/publish   promotes the draft: snapshots the OLD version into
//                         ladn.policy_versions, writes ladn.policies, records
//                         the new version with its editor, then propagates.
//
// PATCH /:id keeps working exactly as it did — the review-cycle editor on the
// same screen uses it, and so may anything else.
//
// ── WHY A VERSION SNAPSHOT IS TAKEN BEFORE THE WRITE, NOT AFTER ──────────────
// ladn.policies has one row per policy and holds only the current text. The
// migration backfilled a baseline row per policy, so at publish time the OLD
// version already has its snapshot; what the publish inserts is the NEW one. A
// UNIQUE (policy_id, version) means republishing the same version number twice
// updates that row rather than growing a second history entry for it.
// ═════════════════════════════════════════════════════════════════════════════

const jsonBody = express.json({ limit: '512kb' });   // a policy is a document

const requireManager = (req, res, next) =>
  hasRole(req.user, MANAGER_ROLES) ? next() : res.status(403).json({ error: 'Forbidden' });

const editorName = req =>
  (req.user && (req.user.name || req.user.full_name || req.user.email)) || ('staff #' + (req.user || {}).id);

/**
 * A policy version as a NUMBER.
 *
 * ⚠️ policies.version is INTEGER in ladn — but it is `character varying` in
 * demo_primary and demo_secondary, where every row holds the string '1.0'
 * (verified 2026-09-08 against both databases). This file is SHARED by all six
 * tenant schemas, so `before.version + 1` on those two would produce the string
 * '1.01', and policy_versions.version (INTEGER) would reject it outright. Coerce
 * once, here, and use it for the arithmetic, the history key and the staleness
 * comparison. The stored label keeps whatever the tenant actually wrote.
 */
const verNum = v => {
  const n = parseInt(String(v == null ? '' : v).split('.')[0], 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

/**
 * The staff re-sign notification, lifted out of PATCH /:id so publish can raise
 * the same one. PATCH's own copy is left exactly where it was — factoring it out
 * of there would be rewriting a working route.
 */
async function notifyReSign(db, p) {
  try {
    await db.query(`
      INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
      SELECT 'staff', s.id, 'policy',
        $1, $2, '/policies.html', 'policies', $3, 'high'
      FROM staff s
      WHERE s.is_active = true AND s.role = ANY($4::text[])`,
      [`✍️ Policy updated — please re-sign: ${p.title}`,
       `"${p.title}" has been updated to version ${p.version}. Please read the new version and sign to confirm. Your previous signature no longer covers this version.`,
       p.id, p.required_roles || []]);
  } catch (e) {
    console.error('policies publish re-sign notify:', e.message);
  }
}

// ── version history ──────────────────────────────────────────────────────────

// GET /api/policies/:id/versions — who changed it, when, and what they said.
router.get('/:id/versions', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT v.id, v.version, v.title, v.version_label, v.effective_date, v.change_note,
             v.edited_by, v.published_at, v.surfaces,
             COALESCE(NULLIF(TRIM(s.first_name || ' ' || s.last_name), ''), v.edited_by_name) AS edited_by_name,
             length(v.content) AS content_length
        FROM policy_versions v
        LEFT JOIN staff s ON s.id = v.edited_by
       WHERE v.policy_id = $1
       ORDER BY v.version DESC, v.published_at DESC`, [req.params.id]);
    res.json({ versions: rows, count: rows.length });
  } catch (e) {
    console.error('policies GET /:id/versions', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/policies/:id/versions/:version — the full text of one version, plus
// the one before it, so the screen can render a diff without a second round trip.
router.get('/:id/versions/:version', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT v.*, COALESCE(NULLIF(TRIM(s.first_name || ' ' || s.last_name), ''), v.edited_by_name) AS edited_by_name
        FROM policy_versions v LEFT JOIN staff s ON s.id = v.edited_by
       WHERE v.policy_id = $1 AND v.version = $2`, [req.params.id, req.params.version]);
    if (!rows.length) return res.status(404).json({ error: 'No such version' });
    const { rows: prev } = await db.query(`
      SELECT version, title, content, published_at FROM policy_versions
       WHERE policy_id = $1 AND version < $2 ORDER BY version DESC LIMIT 1`,
      [req.params.id, req.params.version]);
    res.json({ version: rows[0], previous: prev[0] || null });
  } catch (e) {
    console.error('policies GET /:id/versions/:version', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── the draft ────────────────────────────────────────────────────────────────

// GET /api/policies/:id/draft — the edit in progress, if there is one.
router.get('/:id/draft', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT d.*, COALESCE(NULLIF(TRIM(s.first_name || ' ' || s.last_name), ''), d.updated_by_name) AS updated_by_name
        FROM policy_edit_drafts d LEFT JOIN staff s ON s.id = d.updated_by
       WHERE d.policy_id = $1`, [req.params.id]);
    const { rows: pol } = await db.query(
      'SELECT id, title, content, category, version, version_label, effective_date FROM policies WHERE id = $1',
      [req.params.id]);
    if (!pol.length) return res.status(404).json({ error: 'Not found' });
    const d = rows[0] || null;
    res.json({
      live: pol[0],
      draft: d,
      // A draft written against an older version means somebody else published
      // in the meantime. Say so rather than letting the publish silently discard
      // their change.
      stale: !!(d && d.base_version !== verNum(pol[0].version)),
    });
  } catch (e) {
    console.error('policies GET /:id/draft', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/policies/:id/draft — save the edit in progress. Writes NOTHING that
// any parent- or staff-facing surface reads.
router.put('/:id/draft', requireManager, jsonBody, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  if (typeof b.content !== 'string' || !b.content.trim()) {
    return res.status(400).json({ error: 'content required' });
  }
  if (b.effective_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.effective_date)) {
    return res.status(400).json({ error: 'effective_date must be YYYY-MM-DD' });
  }
  try {
    const { rows: pol } = await db.query('SELECT id, version FROM policies WHERE id = $1', [req.params.id]);
    if (!pol.length) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(`
      INSERT INTO policy_edit_drafts
        (policy_id, title, content, category, version_label, effective_date, change_note,
         base_version, updated_by, updated_by_name, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
      ON CONFLICT (policy_id) DO UPDATE SET
        title = EXCLUDED.title, content = EXCLUDED.content, category = EXCLUDED.category,
        version_label = EXCLUDED.version_label, effective_date = EXCLUDED.effective_date,
        change_note = EXCLUDED.change_note, base_version = EXCLUDED.base_version,
        updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name,
        updated_at = now()
      RETURNING *`,
      [req.params.id, b.title || null, b.content, b.category || null, b.version_label || null,
       b.effective_date || null, b.change_note || null, verNum(pol[0].version),
       (req.user || {}).id || null, editorName(req)]);
    res.json({ ok: true, draft: rows[0] });
  } catch (e) {
    console.error('policies PUT /:id/draft', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/policies/:id/draft — throw the edit away. Never touches the policy.
router.delete('/:id/draft', requireManager, async (req, res) => {
  const db = getPool();
  try {
    await db.query('DELETE FROM policy_edit_drafts WHERE policy_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('policies DELETE /:id/draft', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── preview ──────────────────────────────────────────────────────────────────

// POST /api/policies/preview — what the text will look like when it lands.
// Sent as a POST because a policy is up to a few hundred kilobytes and this is a
// pure render: it reads nothing and writes nothing.
router.post('/preview', requireManager, jsonBody, async (req, res) => {
  const b = req.body || {};
  const content = String(b.content || '');
  try {
    const parsed = termsDoc.parse(content);
    res.json({
      // The parents/staff reading view is `textContent` into a pre-wrap box, so
      // the honest preview of it is the text itself — what the screen shows is
      // that this is NOT interpreted as markup.
      plain: content,
      markdown_found: /^\s*#{1,6}\s/m.test(content) || content.includes('**') || /^\s*\|/m.test(content),
      sections: parsed.sections.map(s => ({ heading: s.heading, display: termsDoc.titleCase(s.heading), paragraphs: s.paragraphs.length })),
      preamble: parsed.preamble,
      // Only meaningful for the T&C, but harmless for anything else and it is
      // what makes "preview the rendered result" true for the public website.
      accordion_html: termsDoc.accordionHtml(content, {
        version: b.version, version_label: b.version_label, effective_date: b.effective_date,
      }),
    });
  } catch (e) {
    console.error('policies POST /preview', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── publish ──────────────────────────────────────────────────────────────────

/**
 * POST /api/policies/:id/publish
 *
 * body: { from_draft?:true, content?, title?, category?, version_label?,
 *         effective_date?, change_note?, bump_version?:true, discard_draft?:true }
 *
 * Returns { policy, version, surfaces } — `surfaces` is the answer to "report
 * every surface that was updated", and it is also stored on the version row so
 * the question is still answerable next month.
 */
router.post('/:id/publish', requireManager, jsonBody, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  try {
    const { rows: cur } = await db.query('SELECT * FROM policies WHERE id = $1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const before = cur[0];

    let draft = null;
    if (b.from_draft !== false) {
      const { rows } = await db.query('SELECT * FROM policy_edit_drafts WHERE policy_id = $1', [req.params.id]);
      draft = rows[0] || null;
    }
    const src = draft || {};
    const content = (typeof b.content === 'string' && b.content.length) ? b.content : (src.content || null);
    if (!content) return res.status(400).json({ error: 'Nothing to publish — no draft and no content supplied' });

    const title = b.title || src.title || before.title;
    const category = b.category || src.category || before.category;
    const versionLabel = b.version_label || src.version_label || before.version_label;
    const effective = b.effective_date || src.effective_date || null;
    const changeNote = b.change_note || src.change_note || null;
    // pg hands a DATE back as a local-midnight Date, so a draft's effective_date
    // arrives as an object, not a string. String(d).slice(0,10) would give
    // "Fri Sep 04" (memory/reference_pg_date_ymd_trap.md) — use local getters.
    const ymd = d => {
      if (!d) return null;
      const dt = d instanceof Date ? d : new Date(String(d) + 'T00:00:00');
      if (isNaN(dt)) return null;
      return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    };
    const effectiveYmd = ymd(effective);
    if (effective && !effectiveYmd) {
      return res.status(400).json({ error: 'effective_date must be YYYY-MM-DD' });
    }

    // Publishing identical text is not an error, but it must not bump a version
    // — a bump invalidates every parent signature and every staff acknowledgement.
    const textChanged = content !== before.content || title !== before.title;
    const bump = b.bump_version === false ? false : textChanged;
    const curVersion = verNum(before.version);
    const newVersion = bump ? curVersion + 1 : curVersion;

    // A publish is a review: roll the next review date forward, exactly as
    // b186's PATCH does on a bump.
    const { rows: upd } = await db.query(`
      UPDATE policies
         SET title = $1, content = $2, category = $3,
             version = $4,
             version_label = COALESCE($5, version_label),
             effective_date = COALESCE($6::date, effective_date),
             published_at = now(),
             review_due = CASE WHEN $7 THEN
               (CURRENT_DATE + (COALESCE(review_interval_months, 12) || ' months')::interval)::date
               ELSE review_due END
       WHERE id = $8
       RETURNING *`,
      [title, content, category, newVersion, versionLabel,
       effectiveYmd, bump, req.params.id]);
    const after = upd[0];

    // The history row for what has just gone live.
    const { rows: verRow } = await db.query(`
      INSERT INTO policy_versions
        (policy_id, version, title, content, category, version_label, effective_date,
         change_note, edited_by, edited_by_name, published_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
      ON CONFLICT (policy_id, version) DO UPDATE SET
        title = EXCLUDED.title, content = EXCLUDED.content, category = EXCLUDED.category,
        version_label = EXCLUDED.version_label, effective_date = EXCLUDED.effective_date,
        change_note = EXCLUDED.change_note, edited_by = EXCLUDED.edited_by,
        edited_by_name = EXCLUDED.edited_by_name, published_at = now()
      RETURNING id, version, published_at`,
      [after.id, verNum(after.version), after.title, after.content, after.category,
       after.version_label, after.effective_date, changeNote,
       (req.user || {}).id || null, editorName(req)]);

    // The public read-through endpoint caches for 60s; a publish must be visible
    // on the guide and the fees page immediately, not up to a minute later.
    try { require('./public-terms').invalidate(); } catch (e) { /* not mounted */ }

    // Now make every other surface show it.
    let surfaces = [];
    try { surfaces = await termsPublish.propagate(db, after); }
    catch (e) {
      console.error('policies publish propagate:', e.message);
      surfaces = [{ id: 'propagate', label: 'Propagation', status: 'error', detail: e.message }];
    }
    await db.query('UPDATE policy_versions SET surfaces = $1 WHERE id = $2',
      [JSON.stringify(surfaces), verRow[0].id]).catch(() => {});

    if (b.discard_draft !== false) {
      await db.query('DELETE FROM policy_edit_drafts WHERE policy_id = $1', [req.params.id]).catch(() => {});
    }
    if (bump) await notifyReSign(db, after);

    res.json({
      ok: true,
      policy: after,
      version: verRow[0],
      bumped: bump,
      previous_version: curVersion,
      surfaces,
    });
  } catch (e) {
    console.error('policies POST /:id/publish', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── the order ────────────────────────────────────────────────────────────────

// POST /api/policies/reorder — { order: [id, id, ...] } in display order.
// Renumbers with gaps of 10 so a later single-item move does not have to
// renumber the world. Ids missing from the list keep their current sort_order.
router.post('/reorder', requireManager, jsonBody, async (req, res) => {
  const db = getPool();
  const ids = (req.body || {}).order;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'order[] required' });
  const clean = ids.map(n => parseInt(n, 10)).filter(Number.isFinite);
  if (clean.length !== ids.length) return res.status(400).json({ error: 'order[] must be policy ids' });
  try {
    await db.query('BEGIN');
    for (let i = 0; i < clean.length; i++) {
      await db.query('UPDATE policies SET sort_order = $1 WHERE id = $2', [(i + 1) * 10, clean[i]]);
    }
    await db.query('COMMIT');
    res.json({ ok: true, count: clean.length });
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('policies POST /reorder', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/policies/reorder/reset — back to the statutory-first default.
// The way out of a drag that went wrong, without a shell.
router.post('/reorder/reset', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT id, title, category FROM policies WHERE is_active = true');
    const ordered = policyOrder.assignOrder(rows);
    await db.query('BEGIN');
    for (const p of ordered) {
      await db.query('UPDATE policies SET sort_order = $1 WHERE id = $2', [p.sort_order, p.id]);
    }
    await db.query('COMMIT');
    res.json({ ok: true, count: ordered.length });
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('policies POST /reorder/reset', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── where the public website lives ───────────────────────────────────────────

// GET /api/policies/terms/target — is the public website wired up, and is it
// ready? Answers honestly rather than assuming: it stats the directory and looks
// for the markers in the file it would write.
router.get('/terms/target', requireManager, async (req, res) => {
  const db = getPool();
  const fs = require('fs');
  const path = require('path');
  try {
    const dir = await termsPublish.siteDir(db);
    const out = { dir: dir || '', configured: !!dir, exists: false, markers: false, file: null, hint: null };
    if (dir) {
      out.file = path.join(dir, 'index.html');
      try {
        const html = fs.readFileSync(out.file, 'utf8');
        out.exists = true;
        out.markers = termsPublish.BEGIN_RE.test(html) && termsPublish.END_RE.test(html);
        if (!out.markers) {
          out.hint = 'Run `node scripts/b285/prepare-public-site.js --dir ' + dir + '` once. '
                   + 'It wraps the clauses already in the page and changes no wording.';
        }
      } catch (e) { out.hint = e.message; }
    } else {
      out.hint = 'Not set, so publishing updates every surface except the public website.';
    }
    res.json(out);
  } catch (e) {
    console.error('policies GET /terms/target', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/policies/terms/target — { dir }. Empty string turns the surface off.
router.put('/terms/target', requireManager, jsonBody, async (req, res) => {
  const db = getPool();
  const dir = String((req.body || {}).dir || '').trim();
  if (dir && !dir.startsWith('/')) return res.status(400).json({ error: 'dir must be an absolute path' });
  try {
    await db.query(`
      INSERT INTO settings (key, value, updated_by, updated_at)
      VALUES ('terms_site_dir', $1, $2, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
        updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [dir, (req.user || {}).id || null]);
    res.json({ ok: true, dir });
  } catch (e) {
    console.error('policies PUT /terms/target', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
