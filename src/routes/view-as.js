'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b320 — "View as": start, redeem, exit, and the history of who looked at what.
//
// The four legs, and why they are shaped like this:
//
//   POST /api/view-as/start    (Roost only, manager only)
//       Creates the session row and returns a ONE-TIME CODE plus the URL of the
//       target portal. No token. The manager's browser opens that URL in a new
//       tab.
//   POST /api/view-as/redeem   (on the target portal's host)
//       Spends the code, mints the 30-minute token, sets the HttpOnly cookie.
//       The token is born here, on the host that will use it, which is why it
//       never travels in a URL, a log line or an email.
//   GET  /api/view-as/session  (inside the session)
//       What the banner shows: a first name and the minutes remaining.
//   POST /api/view-as/exit     (inside the session)
//       Ends the row and clears the cookie. Allowlisted in the read-only guard
//       because it is the one write a viewer is allowed to make.
//
// The hand-off code is the b233 OIDC pattern, deliberately: a 32-byte random
// value, stored only as a sha256, single-use, two minutes. Compare that with a
// master password, which is the alternative this build exists to avoid.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const V = require('../lib/view-as');

const PORTAL_HOSTS = {
  parents: process.env.WREN_PARENTS_HOST || 'parents.example-nursery.co.uk',
  hr:      process.env.WREN_HR_HOST      || 'hr.example-nursery.co.uk',
};

function portalOf(req) { return req._portal || 'learning'; }

// Same rule as every other Roost-only management screen (auth-oidc.js): the
// admin host, and a manager on it. The Roost person-allowlist in
// server-unified.js already sits in front of this for the whole portal.
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner'];
function requireRoostManager(req, res, next) {
  if (portalOf(req) !== 'admin') return res.status(404).json({ error: 'Not found' });
  if (!MANAGER_ROLES.includes(req.user && req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  // A view-as session must never be able to start another one, whatever role
  // the token carries. (The guard already refuses this POST; belt and braces.)
  if (req.viewAs) return res.status(403).json({ error: 'view_as_read_only' });
  next();
}

function schemaMissing(e) { return e && (e.code === '42P01' || e.code === '42703'); }
function notApplied(res) {
  return res.status(501).json({
    error: 'view_as_schema_not_applied',
    message: 'migrations/2026-09-11-b320-view-as.sql has not been applied to this database.',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/view-as/start
//   { kind: 'staff', staff_id } | { kind: 'parent', email }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/start', authenticate, requireRoostManager, async (req, res) => {
  const db = getPool();
  const kind = String((req.body && req.body.kind) || '').toLowerCase();
  if (kind !== 'staff' && kind !== 'parent') {
    return res.status(400).json({ error: 'kind must be "staff" or "parent"' });
  }

  try {
    let portal, subject_staff_id = null, subject_email = null, subject_label = null;

    if (kind === 'staff') {
      portal = 'hr';
      const staffId = Number(req.body.staff_id);
      if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'staff_id required' });
      const { rows } = await db.query(
        `SELECT id, first_name, last_name, role, is_active FROM staff WHERE id = $1`, [staffId]);
      const refusal = V.refusalFor(rows[0]);
      if (refusal) return res.status(403).json({ error: 'view_as_refused', message: refusal });
      subject_staff_id = rows[0].id;
      subject_label = rows[0].first_name || 'this member of staff';
    } else {
      portal = 'parents';
      subject_email = String(req.body.email || '').toLowerCase().trim();
      if (!subject_email || subject_email.indexOf('@') === -1) {
        return res.status(400).json({ error: 'email required' });
      }
      // The address must already belong to a parent here — the same two-armed
      // union src/lib/parent-identity.js confirms against, so a manager cannot
      // conjure a session for an address Wren does not already know.
      const { rows } = await db.query(
        `SELECT
           (SELECT count(*) FROM parent_portal_access
             WHERE lower(email) = $1 AND is_active = true)::int AS access_rows,
           (SELECT count(*) FROM children
             WHERE (lower(parent_1_email) = $1 OR lower(parent_2_email) = $1)
               AND is_active = true)::int AS child_rows`, [subject_email]);
      const r = rows[0] || { access_rows: 0, child_rows: 0 };
      if ((r.access_rows + r.child_rows) === 0) {
        return res.status(404).json({ error: 'view_as_refused', message: 'That address is not a parent here.' });
      }
      const { rows: nameRows } = await db.query(
        `SELECT CASE WHEN lower(parent_1_email) = $1 THEN parent_1_name ELSE parent_2_name END AS nm
           FROM children
          WHERE lower(parent_1_email) = $1 OR lower(parent_2_email) = $1
          ORDER BY is_active DESC, id LIMIT 1`, [subject_email]);
      const nm = (nameRows[0] && nameRows[0].nm) || '';
      subject_label = (nm.trim().split(/\s+/)[0]) || subject_email.split('@')[0];
    }

    const jti = V.newJti();
    const code = V.newCode();
    const now = Date.now();
    const { rows: ins } = await db.query(
      `INSERT INTO view_as_sessions
         (jti, code_hash, code_expires_at, actor_staff_id, actor_name,
          subject_kind, subject_staff_id, subject_email, subject_label, portal,
          expires_at, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, started_at, expires_at`,
      [jti, V.hashCode(code), new Date(now + V.HANDOFF_MS),
       req.user.id, req.user.name || null,
       kind, subject_staff_id, subject_email, subject_label, portal,
       new Date(now + V.SESSION_MS),
       req.headers['cf-connecting-ip'] || req.ip || null,
       (req.headers['user-agent'] || '').slice(0, 200)]
    );

    recordAudit({
      req, action: 'view_as_start', entity_type: 'view_as_session', entity_id: ins[0].id,
      meta: { portal, subject_kind: kind, subject_staff_id, subject_email, session: jti },
    });

    // Dev (:3015) has one host for every portal, so the absolute URL below would
    // point at production. When the request did not arrive on a real portal
    // hostname, hand back a same-origin path instead and let the tester set the
    // Host header themselves.
    const sameOrigin = !/example-nursery\.co\.uk$/i.test(req.hostname || '');
    const base = sameOrigin ? '' : `https://${PORTAL_HOSTS[portal]}`;

    res.json({
      ok: true,
      session_id: ins[0].id,
      portal,
      subject_label,
      expires_at: ins[0].expires_at,
      url: `${base}/view-as.html?c=${encodeURIComponent(code)}`,
    });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    console.error('[view-as] start failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/view-as/redeem   { code }
//   Runs on the TARGET portal's host. Spends the code, mints the token.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/redeem', async (req, res) => {
  const db = getPool();
  const code = String((req.body && req.body.code) || '').trim();
  if (!code) return res.status(400).json({ error: 'code required' });

  try {
    const { rows } = await db.query(
      `SELECT * FROM view_as_sessions WHERE code_hash = $1`, [V.hashCode(code)]);
    const s = rows[0];
    // One answer for every failure: a wrong code, a spent code and an expired
    // code are indistinguishable to the caller.
    const bad = () => res.status(401).json({ error: 'view_as_invalid', message: 'This view-as link is not valid any more. Start a new one from Roost.' });
    if (!s) return bad();
    if (s.redeemed_at) return bad();
    if (s.ended_at) return bad();
    if (!s.code_expires_at || new Date(s.code_expires_at).getTime() < Date.now()) return bad();
    if (new Date(s.expires_at).getTime() < Date.now()) return bad();
    if (portalOf(req) !== s.portal) {
      return res.status(400).json({
        error: 'wrong_portal',
        message: `This link opens the ${s.portal === 'hr' ? 'staff (Seed)' : 'parents (Finch)'} portal.`,
      });
    }

    // Re-read the subject NOW rather than trusting what was true at start:
    // a member of staff promoted to manager, or made inactive, in the two
    // minutes since must not be viewable.
    let claims;
    if (s.subject_kind === 'staff') {
      const { rows: st } = await db.query(
        `SELECT id, first_name, last_name, role, room_id, scope, scope_value, is_active
           FROM staff WHERE id = $1`, [s.subject_staff_id]);
      const refusal = V.refusalFor(st[0]);
      if (refusal) return res.status(403).json({ error: 'view_as_refused', message: refusal });
      const st0 = st[0];
      claims = {
        id: st0.id,
        name: `${st0.first_name || ''} ${st0.last_name || ''}`.trim(),
        role: st0.role,
        room_id: st0.room_id,
        scope: st0.scope || 'all',
        scope_value: st0.scope_value || null,
      };
    } else {
      const { rows: ch } = await db.query(
        `SELECT c.id, c.room_id FROM children c
          WHERE ((lower(c.parent_1_email) = $1 OR lower(c.parent_2_email) = $1) AND c.is_active = true)
             OR EXISTS (SELECT 1 FROM parent_portal_access pa
                         WHERE pa.child_id = c.id AND lower(pa.email) = $1 AND pa.is_active = true)
          ORDER BY c.is_active DESC, c.id`, [s.subject_email]);
      if (!ch.length) return res.status(403).json({ error: 'view_as_refused', message: 'That address has no children here any more.' });
      claims = {
        id: 0,
        name: s.subject_email,
        email: s.subject_email,
        role: 'parent',
        child_id: ch[0].id,
        child_ids: ch.map((r) => r.id),
        room_id: ch[0].room_id,
      };
    }

    // Single use: only the row that was still unredeemed gets spent, so two
    // simultaneous redemptions cannot both succeed.
    const { rowCount } = await db.query(
      `UPDATE view_as_sessions SET redeemed_at = now(), code_hash = NULL
        WHERE id = $1 AND redeemed_at IS NULL`, [s.id]);
    if (!rowCount) return bad();
    V.invalidate(s.jti);

    const token = V.mintToken(claims, {
      jti: s.jti, portal: s.portal,
      actorId: s.actor_staff_id, actorName: (s.actor_name || '').split(' ')[0] || null,
    });
    V.setCookie(req, res, token);

    res.json({
      ok: true,
      token,                       // Seed keeps its session in sessionStorage; Finch uses the cookie
      portal: s.portal,
      subject_label: s.subject_label,
      expires_at: s.expires_at,
      landing: s.portal === 'hr' ? '/index.html' : '/welcome',
    });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    console.error('[view-as] redeem failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/view-as/session — what the banner needs. No token, no ids.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/session', async (req, res) => {
  const c = V.claimsOf(req);
  if (!c) return res.json({ active: false });
  const row = await V.sessionRow(c.vas);
  if (!V.isLive(row)) return res.json({ active: false, ended: true });
  res.json({
    active: true,
    subject_label: (row && row.subject_label) || null,
    by_name: c.impersonated_by_name || null,
    expires_at: (row && row.expires_at) || (c.exp ? new Date(c.exp * 1000).toISOString() : null),
    read_only: true,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/view-as/exit — the Exit link on the banner.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/exit', async (req, res) => {
  const c = V.claimsOf(req);
  V.clearCookie(res);
  if (!c) return res.json({ ok: true });
  try {
    await getPool().query(
      `UPDATE view_as_sessions SET ended_at = now(), ended_reason = 'exited'
        WHERE jti = $1 AND ended_at IS NULL`, [c.vas]);
    V.invalidate(c.vas);
    recordAudit({
      req, action: 'view_as_end', entity_type: 'view_as_session', entity_id: null,
      actor_type: 'staff', actor_id: Number(c.impersonated_by),
      meta: { session: c.vas, reason: 'exited' },
    });
  } catch (e) { console.error('[view-as] exit failed:', e.message); }
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/view-as/history — Roost's record of who looked at whose account.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/history', authenticate, requireRoostManager, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT s.id, s.actor_staff_id, s.actor_name, s.subject_kind, s.subject_staff_id,
              s.subject_email, s.subject_label, s.portal, s.started_at, s.redeemed_at,
              s.expires_at, s.ended_at, s.ended_reason, s.page_views,
              (SELECT count(*) FROM view_as_page_views pv
                WHERE pv.session_id = s.id AND pv.status >= 400)::int AS blocked,
              (s.ended_at IS NULL AND s.expires_at > now() AND s.redeemed_at IS NOT NULL) AS live
         FROM view_as_sessions s
        ORDER BY s.started_at DESC
        LIMIT 200`);
    res.json({ sessions: rows });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/view-as/history/:id — every page that session looked at.
router.get('/history/:id', authenticate, requireRoostManager, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const db = getPool();
    const { rows: s } = await db.query(`SELECT * FROM view_as_sessions WHERE id = $1`, [id]);
    if (!s.length) return res.status(404).json({ error: 'Not found' });
    const { rows: pv } = await db.query(
      `SELECT at, method, path, status FROM view_as_page_views
        WHERE session_id = $1 ORDER BY at LIMIT 1000`, [id]);
    const { code_hash, ...session } = s[0];   // never hand the code hash back
    res.json({ session, page_views: pv });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/view-as/history/:id/end — end a session that is still live.
router.post('/history/:id/end', authenticate, requireRoostManager, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const { rows } = await getPool().query(
      `UPDATE view_as_sessions SET ended_at = now(), ended_reason = 'ended_by_manager'
        WHERE id = $1 AND ended_at IS NULL RETURNING jti`, [id]);
    if (rows[0]) V.invalidate(rows[0].jti);
    recordAudit({
      req, action: 'view_as_end', entity_type: 'view_as_session', entity_id: id,
      meta: { reason: 'ended_by_manager' },
    });
    res.json({ ok: true, ended: rows.length > 0 });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
