'use strict';
/**
 * enquiry-portal.js  (Feature B, 2026-07-16)  → mounted at /api/enquiry-portal
 *
 * Give an enquiring family Parents-portal access BEFORE the child starts, so the
 * setting can build history (diary / observations / messaging) from day zero. On
 * enrolment the SAME child row is reused (no duplicate) — it just flips active.
 *
 * Flow (manager-only, Roost):
 *   POST /:enquiryId/grant   → create/reuse a PROVISIONAL child row
 *                                (status='enquiry', is_active=false, enquiry_id set)
 *                              + parent_portal_access row for the parent email
 *                                (access_level='enquiry')
 *                              + add the parent email to the CF Access parents
 *                                allowlist (via src/lib/access-grants, graceful-degrade)
 *   GET  /                    → list enquiries with their portal-access state
 *   POST /:enquiryId/revoke   → deactivate the parent's portal access
 *   POST /child/:childId/enrol→ flip the provisional child to active (SAME row reused)
 *
 * OWN-CHILD SCOPING: the parent then uses the existing /welcome/* endpoints in
 * editions/ladn/server-unified.js, which every read/write scopes by
 *   parent_portal_access WHERE lower(email)=<cf-access-authenticated-user-email>
 *   AND child_id=<...> AND is_active=true
 * — the CF-verified header email, never a body child_id. A provisional child is just
 * another row in that table, so it is covered by the same scoping (verified on dev).
 *
 * Additive schema only: ALTER children ADD COLUMN IF NOT EXISTS enquiry_id.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { grantCfAllowlist } = require('../lib/access-grants');
// b399 (2026-10-06) — the grant/close logic moved to a shared module so the
// "Invite to the parents app" button (bare waiting-list rows, no enquiry
// required) and the automatic grant on a new website enquiry use the SAME
// code as this manager-only route, not a third copy of it.
const { grantEnquiryAccess, closeEnquiryAccess } = require('../lib/enquiry-access');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

const ADMIN_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'];

let _schemaReady = null;
async function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    const db = getPool();
    // Stable link enquiry → provisional child, so enrolment reuses the row.
    await db.query(`ALTER TABLE children ADD COLUMN IF NOT EXISTS enquiry_id INTEGER`);
    // b265: the permissions a family answered on the registration form, parked
    // on the enquiry until a child row exists to hang them off.
    await db.query(`ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS permissions jsonb`);
    await db.query(`ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS permissions_agreed_at timestamptz`);
  })().catch(e => { _schemaReady = null; throw e; });
  return _schemaReady;
}

// b265 — carry the registration permissions onto the child.
//
// Runs when the provisional child is created (grant) and again at enrolment, so
// a family who registered before b265 shipped still gets their position written
// the first time either step runs. skipExisting is on: anything the family has
// since changed in the parents portal wins over the form they filled in months
// ago. Never throws into the caller — a permissions write failing must not stop
// a child being enrolled; it is logged and the reconciliation report will show
// the gap.
async function applyEnquiryPermissions(db, enquiryId, childId, staffId) {
  try {
    const { applyRegistrationConsents } = require('./consents');
    const { rows } = await db.query(
      `SELECT permissions, permissions_agreed_at FROM enquiries WHERE id=$1`, [enquiryId]);
    if (!rows.length) return { written: [], reason: 'no enquiry' };
    const choices = rows[0].permissions || {};
    const note = rows[0].permissions_agreed_at
      ? `Registration form, acknowledged ${new Date(rows[0].permissions_agreed_at).toISOString().slice(0, 10)} (enquiry #${enquiryId})`
      : `Registration terms (enquiry #${enquiryId})`;
    return await applyRegistrationConsents(db, childId, choices, staffId || 0,
      { skipExisting: true, notes: note });
  } catch (e) {
    console.error('[enquiry-portal] b265 permissions:', e.message);
    return { written: [], error: e.message };
  }
}

router.use(authenticate);
router.use((req, res, next) => {
  if (!hasRole(req.user, ADMIN_ROLES)) return res.status(403).json({ error: 'Manager access required' });
  next();
});
router.use(async (req, res, next) => {
  try { await ensureSchema(); next(); }
  catch (e) { console.error('enquiry-portal schema:', e.message); res.status(500).json({ error: 'schema init failed' }); }
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ── List enquiries + portal-access state ──────────────────────────────────────
router.get('/', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT e.id AS enquiry_id, e.child_first_name, e.child_last_name, e.child_dob,
             e.parent_name, e.parent_email, e.room_needed, e.stage, e.status,
             c.id AS provisional_child_id, c.status AS child_status, c.is_active AS child_active,
             pa.id AS access_id, pa.is_active AS access_active, pa.access_level
      FROM enquiries e
      LEFT JOIN children c ON c.enquiry_id = e.id
      LEFT JOIN parent_portal_access pa ON pa.child_id = c.id AND lower(pa.email) = lower(e.parent_email)
      ORDER BY (pa.is_active IS TRUE) DESC, e.created_at DESC LIMIT 300
    `);
    res.json(rows);
  } catch (e) { console.error('enquiry-portal list:', e.message); res.status(500).json({ error: 'DB error' }); }
});

// ── Grant portal access for an enquiry ────────────────────────────────────────
router.post('/:enquiryId/grant', async (req, res) => {
  const db = getPool();
  const enquiryId = parseInt(req.params.enquiryId, 10);
  if (!Number.isInteger(enquiryId)) return res.status(400).json({ error: 'bad enquiry id' });

  const grant = await grantEnquiryAccess(db, { enquiryId });
  if (!grant.ok) return res.status(400).json({ error: grant.error });

  // b265 — write the registration permissions onto the (new or reused) child.
  const perms = await applyEnquiryPermissions(db, enquiryId, grant.provisional_child_id, req.user?.id);

  const cf = grant.cf_grant || {};
  const messages = [];
  if (perms.written && perms.written.length) {
    messages.push(`Permissions: ${perms.written.length} recorded from the registration form`);
  }
  if (cf.ok) messages.push(cf.already ? 'CF allowlist: already present' : 'CF allowlist: added ✓');
  else if (cf.needs_token) messages.push('CF token invalid/absent — CF grant queued (DB access granted)');
  else messages.push('CF grant failed (queued): ' + (cf.error || 'unknown error'));

  res.json({
    ok: true, enquiry_id: enquiryId, provisional_child_id: grant.provisional_child_id,
    cf_grant: cf, cf_queued: cf.ok === false && !!cf.queued, messages,
    permissions: perms,
  });
});

// ── Grant portal access for a bare waiting-list row (b399, 2026-10-06) ────────
// "Invite to the parents app" on a waiting-list row that has no enquiry behind
// it yet (manually added, or imported) — grantEnquiryAccess backfills a
// minimal enquiry so the rest of the pipeline (close-on-withdraw, convert-to-
// child reuse) has the same one link column to work with as every other family.
router.post('/waiting-list/:id/grant', async (req, res) => {
  const db = getPool();
  const waitingListId = parseInt(req.params.id, 10);
  if (!Number.isInteger(waitingListId)) return res.status(400).json({ error: 'bad waiting-list id' });

  const grant = await grantEnquiryAccess(db, { waitingListId });
  if (!grant.ok) return res.status(400).json({ error: grant.error });

  const perms = await applyEnquiryPermissions(db, grant.enquiry_id, grant.provisional_child_id, req.user?.id);
  const cf = grant.cf_grant || {};
  const messages = [];
  if (cf.ok) messages.push(cf.already ? 'CF allowlist: already present' : 'CF allowlist: added ✓');
  else messages.push('CF grant failed (queued): ' + (cf.error || 'unknown error'));

  res.json({
    ok: true, waiting_list_id: waitingListId, enquiry_id: grant.enquiry_id,
    provisional_child_id: grant.provisional_child_id, cf_grant: cf, messages, permissions: perms,
  });
});

// ── Revoke portal access ──────────────────────────────────────────────────────
router.post('/:enquiryId/revoke', async (req, res) => {
  const db = getPool();
  const enquiryId = parseInt(req.params.enquiryId, 10);
  if (!Number.isInteger(enquiryId)) return res.status(400).json({ error: 'bad enquiry id' });
  const result = await closeEnquiryAccess(db, { enquiryId, reason: 'revoked by manager' });
  if (!result.ok) return res.status(500).json({ error: result.error });
  res.json({ ok: true, revoked: result.closed });
});

// ── Enrol: flip provisional child → active (SAME row, no duplicate) ───────────
router.post('/child/:childId/enrol', async (req, res) => {
  const db = getPool();
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'bad child id' });
  try {
    const cur = await db.query(`SELECT id, status, enquiry_id FROM children WHERE id=$1`, [childId]);
    if (!cur.rows.length) return res.status(404).json({ error: 'child not found' });
    if (cur.rows[0].status !== 'enquiry') return res.status(409).json({ error: `child is not a provisional/enquiry record (status=${cur.rows[0].status})` });

    const { rows } = await db.query(
      `UPDATE children SET status='active', is_active=true, start_date=COALESCE(start_date, CURRENT_DATE), updated_at=now()
       WHERE id=$1 RETURNING id, status, is_active, enquiry_id`,
      [childId]
    );
    // Promote the portal access level (still same rows — history carries over).
    await db.query(
      `UPDATE parent_portal_access SET access_level='active' WHERE child_id=$1 AND access_level='enquiry'`,
      [childId]
    );
    let perms = null;
    if (rows[0].enquiry_id) {
      await db.query(`UPDATE enquiries SET stage='registered', status='registered', updated_at=now() WHERE id=$1`, [rows[0].enquiry_id])
        .catch(e => console.error('enquiry stage update (non-fatal):', e.message));
      // b265 — second pass, for a child granted portal access before this
      // build shipped. skipExisting means it cannot overturn a later choice.
      perms = await applyEnquiryPermissions(db, rows[0].enquiry_id, childId, req.user?.id);
    }
    res.json({ ok: true, child: rows[0], permissions: perms,
      note: 'Provisional record reused — diary/observations history preserved.' });
  } catch (e) { console.error('enquiry-portal enrol:', e.message); res.status(500).json({ error: 'DB error' }); }
});

module.exports = router;
