'use strict';
/**
 * access-requests.js  (Feature A, 2026-07-16)  → mounted at /api/access-requests
 *
 * Replaces the Google-admin / Cloudflare round-trip with an in-Wren workflow:
 *   1. Any staff member (EY app) raises a request  → POST /            (status 'pending')
 *   2. A manager sees pending requests in Roost     → GET  /?status=pending
 *   3. Manager approves                             → POST /:id/approve
 *        → Wren performs the grant (CF allowlist and/or Google group) via
 *          src/lib/access-grants.js, degrading gracefully if the CF token is stale
 *          or the Google Directory scopes aren't authorised (records the request as
 *          approved + the grant as queued).
 *      or rejects                                   → POST /:id/reject
 *
 * kind:
 *   cf_allowlist    → add target_email to the CF Access parents allowlist
 *   group_member    → add target_email to the parents@ Google Group
 *   portal_unblock  → both (parent/staff can't reach a portal): CF allowlist + group
 *
 * Table (self-provisioned, additive, CREATE TABLE IF NOT EXISTS):
 *   access_requests(id, requested_by, kind, target_email, note, status,
 *                        created_at, resolved_by, resolved_at, grant_result)
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { grantCfAllowlist, grantGroupMember } = require('../lib/access-grants');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// ── b264: per-tenant, not LADN-only ──────────────────────────────────────────
// This module used to write `ladn.access_requests` from whatever schema the process was
// connected to, so mounting it in any other edition would have read and written
// Your Nursery' production rows. The SQL is now unqualified and follows the pool's
// search_path (src/db/pool.js ← PG_SCHEMA), which is correct: staff access requests are
// a per-setting feature, not a shared one.
//
// `access_requests` currently exists only in the ladn schema, because that is the only
// edition where this feature has been rolled out. Mounted elsewhere these routes
// will now 500 on a missing relation — which is the intended outcome. A loud error
// is the correct answer to "this edition has not got this feature yet"; silently
// serving another nursery's rows is not. To roll it out, add the table to that
// schema; do NOT re-qualify the SQL.

const ADMIN_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'];
const VALID_KINDS = ['cf_allowlist', 'group_member', 'portal_unblock'];

let _schemaReady = null;
async function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    const db = getPool();
    await db.query(`
      CREATE TABLE IF NOT EXISTS access_requests (
        id           SERIAL PRIMARY KEY,
        requested_by INTEGER,
        kind         TEXT NOT NULL,
        target_email TEXT,
        note         TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TIMESTAMPTZ DEFAULT now(),
        resolved_by  INTEGER,
        resolved_at  TIMESTAMPTZ,
        grant_result JSONB
      )
    `);
  })().catch(e => { _schemaReady = null; throw e; });
  return _schemaReady;
}

router.use(authenticate);
router.use(async (req, res, next) => {
  try { await ensureSchema(); next(); }
  catch (e) { console.error('access-requests schema:', e.message); res.status(500).json({ error: 'schema init failed' }); }
});

const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ADMIN_ROLES)) return res.status(403).json({ error: 'Manager access required' });
  next();
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ── Staff: raise a request ────────────────────────────────────────────────────
router.post('/', express.json({ limit: '8kb' }), async (req, res) => {
  const db = getPool();
  const kind = String(req.body?.kind || '').trim();
  const target_email = req.body?.target_email ? String(req.body.target_email).trim().toLowerCase() : null;
  const note = req.body?.note ? String(req.body.note).slice(0, 2000) : null;
  if (!VALID_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be one of ' + VALID_KINDS.join(', ') });
  if ((kind === 'cf_allowlist' || kind === 'group_member') && (!target_email || !EMAIL_RE.test(target_email))) {
    return res.status(400).json({ error: 'a valid target_email is required for this kind' });
  }
  if (target_email && !EMAIL_RE.test(target_email)) return res.status(400).json({ error: 'target_email is not a valid email' });
  try {
    const { rows } = await db.query(
      `INSERT INTO access_requests (requested_by, kind, target_email, note, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
      [req.user.id, kind, target_email, note]
    );
    res.status(201).json(rows[0]);
  } catch (e) { console.error('access-requests create:', e.message); res.status(500).json({ error: 'DB error' }); }
});

// ── Staff: my own requests ────────────────────────────────────────────────────
router.get('/mine', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id, kind, target_email, note, status, created_at, resolved_at
       FROM access_requests WHERE requested_by=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { console.error('access-requests mine:', e.message); res.status(500).json({ error: 'DB error' }); }
});

// ── Manager: list (optionally by status) ──────────────────────────────────────
router.get('/', managerOnly, async (req, res) => {
  const db = getPool();
  const status = req.query.status ? String(req.query.status) : null;
  try {
    const { rows } = await db.query(
      `SELECT ar.*, s.first_name || ' ' || s.last_name AS requested_by_name,
              rs.first_name || ' ' || rs.last_name AS resolved_by_name
       FROM access_requests ar
       LEFT JOIN staff s  ON s.id  = ar.requested_by
       LEFT JOIN staff rs ON rs.id = ar.resolved_by
       WHERE ($1::text IS NULL OR ar.status = $1)
       ORDER BY (ar.status='pending') DESC, ar.created_at DESC LIMIT 300`,
      [status]
    );
    res.json(rows);
  } catch (e) { console.error('access-requests list:', e.message); res.status(500).json({ error: 'DB error' }); }
});

// ── Manager: reject ───────────────────────────────────────────────────────────
router.post('/:id/reject', managerOnly, express.json({ limit: '4kb' }), async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE access_requests
         SET status='rejected', resolved_by=$2, resolved_at=now(),
             grant_result = COALESCE(grant_result,'{}'::jsonb) || jsonb_build_object('reject_note', $3::text)
       WHERE id=$1 AND status='pending' RETURNING *`,
      [req.params.id, req.user.id, req.body?.note ? String(req.body.note).slice(0, 500) : null]
    );
    if (!rows.length) return res.status(409).json({ error: 'not found or already resolved' });
    res.json(rows[0]);
  } catch (e) { console.error('access-requests reject:', e.message); res.status(500).json({ error: 'DB error' }); }
});

// ── Manager: approve → perform the grant (graceful-degrade) ───────────────────
router.post('/:id/approve', managerOnly, async (req, res) => {
  const db = getPool();
  let reqRow;
  try {
    const r = await db.query(`SELECT * FROM access_requests WHERE id=$1`, [req.params.id]);
    reqRow = r.rows[0];
  } catch (e) { console.error('access-requests approve load:', e.message); return res.status(500).json({ error: 'DB error' }); }
  if (!reqRow) return res.status(404).json({ error: 'not found' });
  if (reqRow.status !== 'pending') return res.status(409).json({ error: `already ${reqRow.status}` });

  const email = reqRow.target_email;
  const grant = { cf: null, group: null };
  try {
    if (reqRow.kind === 'cf_allowlist' || reqRow.kind === 'portal_unblock') {
      grant.cf = await grantCfAllowlist(email);
    }
    if (reqRow.kind === 'group_member' || reqRow.kind === 'portal_unblock') {
      grant.group = await grantGroupMember(email);
    }
  } catch (e) {
    // grant helpers are non-throwing, but belt-and-braces: never 500 the approve.
    grant.error = e.message;
  }

  // Decide final status. The request is APPROVED regardless; the *grant* may be
  // queued if a token/scope is invalid — we still record approval + surface why.
  const parts = [grant.cf, grant.group].filter(Boolean);
  const anyQueued = parts.some(p => p && p.ok === false && p.queued);
  const anyApplied = parts.some(p => p && p.ok === true);
  const finalStatus = anyQueued ? 'grant_queued' : 'approved';

  const messages = [];
  if (grant.cf) {
    if (grant.cf.ok) messages.push(grant.cf.already ? 'CF allowlist: already present' : 'CF allowlist: added ✓');
    else if (grant.cf.needs_token) messages.push('CF token invalid/absent — CF grant queued');
    else messages.push('CF grant failed (queued): ' + grant.cf.error);
  }
  if (grant.group) {
    if (grant.group.ok) messages.push(grant.group.already ? 'Google group: already a member' : 'Google group: added ✓');
    else if (grant.group.needs_token) messages.push('Google Directory scopes not authorised — group grant queued');
    else messages.push('Google group grant failed (queued): ' + grant.group.error);
  }

  try {
    const { rows } = await db.query(
      `UPDATE access_requests
         SET status=$2, resolved_by=$3, resolved_at=now(), grant_result=$4::jsonb
       WHERE id=$1 RETURNING *`,
      [reqRow.id, finalStatus, req.user.id, JSON.stringify({ grant, messages, at: new Date().toISOString() })]
    );
    res.json({ ...rows[0], grant_applied: anyApplied, grant_queued: anyQueued, messages });
  } catch (e) { console.error('access-requests approve save:', e.message); res.status(500).json({ error: 'DB error' }); }
});

module.exports = router;
