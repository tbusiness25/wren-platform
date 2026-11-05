'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b249 §3 — the parents' half of the signature book.
//
// Before this there was NO parent-facing policies surface at all. The parents
// portal had consents.html (per-child toggles, /welcome/consents/api/{list,set})
// and declaration.html (the FEEE funding declaration) and nothing that showed a
// family a policy, let alone let them sign one. policy_acknowledgments is
// keyed on staff_id NOT NULL, so it could not hold a parent's signature either.
//
// ── WHY A SIBLING TABLE, NOT A NULLABLE staff_id ─────────────────────────────
// Set out in full in the migration (§2). The short version: three live queries
// in src/routes/policies.js count policy_acknowledgments rows AGAINST THE STAFF
// LIST — "14 of 18 have signed". Parent rows in that table would inflate the
// numerator and the manager's coverage figure would start reading 40/18. And a
// parent has no staff.id: b239 resolves them to a verified email address and
// nothing else, so the address is the key.
//
// ── WHAT IS RECORDED ─────────────────────────────────────────────────────────
// policy id AND version, the version label, timestamp, IP, user agent — the
// shape of contract_signature_log, which is the existing precedent for a
// signature record here. The version is in the UNIQUE key, so a signature
// against v1.1 cannot satisfy v1.2: bumping a policy makes every parent
// outstanding again, exactly as it already does for staff.
//
// ── IDENTITY ─────────────────────────────────────────────────────────────────
// parentEmailOf(req) only. It reads no header by construction. The portal-wide
// gate in server-unified.js has already run requireParentIdentity for anything
// matching /welcome/<feature>/api/, so by the time a handler here runs the
// address has been proved by a Wren JWT or a verified Cloudflare assertion.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const parentRouter = express.Router();

const { getPool } = require('../db/pool');
const { parentEmailOf } = require('../lib/parent-identity');

// GET /welcome/policies/api/list — the parent-facing policies and my signatures.
parentRouter.get('/list', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT p.id, p.title, p.content, p.version, p.version_label, p.category,
             p.effective_date, p.published_at, p.requires_parent_signature,
             a.acknowledged_at, a.policy_version AS signed_version, a.version_label AS signed_label,
             (a.id IS NOT NULL) AS signed
        FROM policies p
        LEFT JOIN parent_policy_acknowledgments a
          ON a.policy_id = p.id AND a.parent_email = $1 AND a.policy_version = p.version
       WHERE p.is_active = true AND p.parent_facing = true
       -- b285: anything still waiting for a signature leads (that is what a
       -- parent opened this page for), and below that the SETTING'S order —
       -- ladn.policies.sort_order, statutory-first — so a parent sees
       -- safeguarding above the green statement, exactly as staff do.
       ORDER BY (p.requires_parent_signature AND a.id IS NULL) DESC,
                p.sort_order NULLS LAST, p.title`, [email]);

    // A previous signature against an OLDER version is not a signature against
    // this one — but the family should be told that is what happened, rather
    // than silently seeing an unsigned document they remember signing.
    const ids = rows.map(r => r.id);
    let prior = [];
    if (ids.length) {
      ({ rows: prior } = await db.query(`
        SELECT policy_id, MAX(policy_version) AS last_version, MAX(acknowledged_at) AS last_at
          FROM parent_policy_acknowledgments
         WHERE parent_email = $1 AND policy_id = ANY($2::int[])
         GROUP BY policy_id`, [email, ids]));
    }
    const priorBy = Object.fromEntries(prior.map(p => [p.policy_id, p]));

    res.json({
      policies: rows.map(p => ({
        ...p,
        superseded_signature: (!p.signed && priorBy[p.id])
          ? { version: priorBy[p.id].last_version, at: priorBy[p.id].last_at }
          : null,
      })),
      outstanding: rows.filter(p => p.requires_parent_signature && !p.signed).length,
    });
  } catch (e) {
    console.error('[parent-policies] list:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /welcome/policies/api/sign — record one signature.
 *
 * The VERSION IS READ FROM THE DATABASE, never from the request body. A client
 * that could name the version it was signing could sign v1.1 of a document it
 * was shown as v1.2, which is the one thing this table exists to prevent.
 *
 * ON CONFLICT DO NOTHING on (policy_id, parent_email, policy_version): signing
 * twice is a double-tap, not an error, and must not move the timestamp on a
 * signature already given.
 */
parentRouter.post('/sign', express.json({ limit: '8kb' }), async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  const policyId = parseInt((req.body || {}).policy_id, 10);
  if (!Number.isFinite(policyId)) return res.status(400).json({ error: 'policy_id required' });
  try {
    const { rows: pol } = await db.query(
      `SELECT id, title, version, version_label, parent_facing, requires_parent_signature
         FROM policies WHERE id = $1 AND is_active = true`, [policyId]);
    if (!pol.length || !pol[0].parent_facing) return res.status(404).json({ error: 'Policy not found' });
    const p = pol[0];

    // Scope the signature to a child only when the parent actually has one, and
    // only ever to their own. Nullable by design — the ADULT signs, once,
    // however many children they have here.
    let childId = parseInt((req.body || {}).child_id, 10);
    if (Number.isFinite(childId)) {
      const own = await db.query(
        `SELECT 1 FROM parent_portal_access WHERE lower(email)=$1 AND child_id=$2 AND is_active=true`,
        [email, childId]);
      if (!own.rows.length) return res.status(403).json({ error: 'Not your child' });
    } else { childId = null; }

    const source = ((req.body || {}).source === 'enrolment') ? 'enrolment' : 'portal';
    await db.query(`
      INSERT INTO parent_policy_acknowledgments
        (policy_id, parent_email, child_id, policy_version, version_label, ip, user_agent, source, detail)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (policy_id, parent_email, policy_version) DO NOTHING`,
      [p.id, email, childId, p.version, p.version_label,
       String(req.ip || '').slice(0, 45),
       String(req.headers['user-agent'] || '').slice(0, 1000),
       source,
       JSON.stringify({ title: p.title, signed_label: p.version_label })]);

    const { rows: back } = await db.query(
      `SELECT acknowledged_at, policy_version, version_label FROM parent_policy_acknowledgments
        WHERE policy_id=$1 AND parent_email=$2 AND policy_version=$3`, [p.id, email, p.version]);
    res.json({ ok: true, signed: back[0] || null, policy: { id: p.id, title: p.title, version: p.version, version_label: p.version_label } });
  } catch (e) {
    console.error('[parent-policies] sign:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /welcome/policies/api/outstanding — "what do I still owe?"
 *
 * ── THE T&C QUESTION, ANSWERED HONESTLY ──────────────────────────────────────
 * Toby's ask was "signed when they submit T&C". There is NO single terms-and-
 * conditions submission point on prod for a parent to hang this off. Verified,
 * not assumed:
 *   · src/routes/contracts.js POST /:id/sign is STAFF employment contracts —
 *     staff_contracts, keyed on staff_id, countersigned by a manager.
 *     No parent ever touches it.
 *   · editions/parents/welcome/consents.html is per-child photo/outing/etc
 *     toggles (child_consents), not an agreement to terms.
 *   · declaration.html is the FEEE funding parental declaration — a termly
 *     funding form, not enrolment.
 *   · parent_enrolment_invites and the /onboard/child form collect a
 *     child's details for manager approval; neither presents terms nor records
 *     an acceptance.
 * So the standalone parents page is the route, and this endpoint is the seam a
 * future enrolment gate plugs into: it returns exactly what an enrolment
 * submission would need to collect, and POST /sign already accepts
 * source='enrolment' so those signatures are distinguishable from portal ones.
 * What a proper gate still needs is written up in the b249 NOTES.
 */
parentRouter.get('/outstanding', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT p.id, p.title, p.version, p.version_label
        FROM policies p
        LEFT JOIN parent_policy_acknowledgments a
          ON a.policy_id = p.id AND a.parent_email = $1 AND a.policy_version = p.version
       WHERE p.is_active = true AND p.parent_facing = true
         AND p.requires_parent_signature = true AND a.id IS NULL
       ORDER BY p.sort_order NULLS LAST, p.title`, [email]);   -- b285
    res.json({ outstanding: rows.length, policies: rows });
  } catch (e) {
    console.error('[parent-policies] outstanding:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = { parentRouter };
