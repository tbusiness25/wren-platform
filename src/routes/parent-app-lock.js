// b131 — Parent app lock (PIN + WebAuthn biometric). Mounted parents-only at /api/app-lock.
//
// b239 (2026-08-27) REVISED THE AUTH MODEL. What this comment used to say:
//   "identity comes from the Cloudflare Access header, not a bearer JWT — the CF Access
//    session itself is the thing that gates who can reach these endpoints at all.
//    'Forgot PIN' therefore falls back to CF Access re-auth for free."
// That was true, and it was load-bearing, and it stops being true the moment Cloudflare
// Access comes off the parents portal. None of these nine endpoints was ever behind the
// 2026-07-21 signature gate — the gate matches `/welcome/<x>/api/` and four /api prefixes,
// and /api/app-lock is not one of them — so the plaintext header was the whole control.
// POST /disable clears a parent's app lock. On an origin reachable without traversing
// Cloudflare (the Tailscale mesh, dev :3015), that was one header away from anyone.
//
// Identity now comes from src/lib/parent-identity.js — a Wren-minted parent JWT first,
// the *verified* CF assertion second — and every route carries requireParentIdentity.
// "Forgot PIN" now falls back to whatever Wren's own parent login is at the time, which
// is the point: the fallback stops being specific to Cloudflare.
// Full enumeration: logs/b239-parent-identity-routes.md.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { getPool } = require('../db/pool');
const { requireParentIdentity, parentEmailOf } = require('../lib/parent-identity'); // b239
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');

// ── b264: per-tenant, not LADN-only ──────────────────────────────────────────
// This module used to write `ladn.parent_app_lock` from whatever schema the process was
// connected to, so mounting it in any other edition would have read and written
// Your Nursery' production rows. The SQL is now unqualified and follows the pool's
// search_path (src/db/pool.js ← PG_SCHEMA), which is correct: the parents-app PIN/passkey lock are
// a per-setting feature, not a shared one.
//
// `parent_app_lock` currently exists only in the ladn schema, because that is the only
// edition where this feature has been rolled out. Mounted elsewhere these routes
// will now 500 on a missing relation — which is the intended outcome. A loud error
// is the correct answer to "this edition has not got this feature yet"; silently
// serving another nursery's rows is not. To roll it out, add the table to that
// schema; do NOT re-qualify the SQL.

const PIN_LOCKOUT_THRESHOLD = 6;
const PIN_LOCKOUT_MINUTES = 15;

// b239 — see the note above: the "CF Access session is the gate" assumption in
// this file's header comment stops holding at cutover. Identity now comes from
// src/lib/parent-identity.js and every route carries requireParentIdentity, so
// "forgot PIN" falls back to whatever Wren's own login is at the time rather than
// to Cloudflare specifically. POST /disable clears a parent's app lock, which is
// why this file could not be left on header trust.
function parentEmail(req) {
  return parentEmailOf(req);
}

// rpID must be a domain the browser origin matches; req.hostname (behind trust-proxy,
// already set in server.js) reflects the real public host on both dev (:3015 host header)
// and prod (parents.example-nursery.co.uk via nginx/CF).
function rpIdAndOrigin(req) {
  return { rpID: req.hostname, origin: `${req.protocol}://${req.get('host')}` };
}

const attemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => parentEmail(req) || req.ip || 'unknown',
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
});

// GET /status
router.get('/status', requireParentIdentity, async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT enabled, (pin_hash IS NOT NULL) AS has_pin, idle_minutes, webauthn_credentials
       FROM parent_app_lock WHERE lower(parent_email)=$1`,
      [email]
    );
    if (!rows.length) return res.json({ enabled: false, has_pin: false, idle_minutes: 5, webauthn_devices: [] });
    const r = rows[0];
    const creds = Array.isArray(r.webauthn_credentials) ? r.webauthn_credentials : [];
    res.json({
      enabled: r.enabled,
      has_pin: r.has_pin,
      idle_minutes: r.idle_minutes,
      webauthn_devices: creds.map(c => ({ label: c.deviceLabel || 'Device', createdAt: c.createdAt })),
    });
  } catch (e) {
    console.error('app-lock status:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /set-pin { pin, idle_minutes }
router.post('/set-pin', requireParentIdentity, attemptLimiter, async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const { pin, idle_minutes } = req.body || {};
  if (!/^\d{4,6}$/.test(String(pin || ''))) {
    return res.status(400).json({ error: 'PIN must be 4-6 digits' });
  }
  const idleMinutes = Math.min(Math.max(parseInt(idle_minutes, 10) || 5, 1), 60);
  const db = getPool();
  try {
    const hash = await bcrypt.hash(String(pin), 10);
    await db.query(
      `INSERT INTO parent_app_lock (parent_email, pin_hash, enabled, idle_minutes, failed_pin_attempts, locked_until)
       VALUES ($1,$2,true,$3,0,NULL)
       ON CONFLICT (parent_email) DO UPDATE
         SET pin_hash=$2, enabled=true, idle_minutes=$3, failed_pin_attempts=0, locked_until=NULL, updated_at=now()`,
      [email, hash, idleMinutes]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('app-lock set-pin:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /verify-pin { pin }
router.post('/verify-pin', requireParentIdentity, attemptLimiter, async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT pin_hash, failed_pin_attempts, locked_until FROM parent_app_lock WHERE lower(parent_email)=$1`,
      [email]
    );
    if (!rows.length || !rows[0].pin_hash) return res.status(404).json({ error: 'No PIN set' });
    const row = rows[0];
    if (row.locked_until && new Date(row.locked_until) > new Date()) {
      return res.status(429).json({ ok: false, locked: true, error: 'Too many attempts, try again later' });
    }
    const match = await bcrypt.compare(String(req.body?.pin || ''), row.pin_hash);
    if (match) {
      await db.query(
        `UPDATE parent_app_lock SET failed_pin_attempts=0, locked_until=NULL WHERE lower(parent_email)=$1`,
        [email]
      );
      return res.json({ ok: true });
    }
    const attempts = (row.failed_pin_attempts || 0) + 1;
    const lockedUntil = attempts >= PIN_LOCKOUT_THRESHOLD
      ? new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60 * 1000) : null;
    await db.query(
      `UPDATE parent_app_lock SET failed_pin_attempts=$2, locked_until=$3 WHERE lower(parent_email)=$1`,
      [email, attempts, lockedUntil]
    );
    res.json({ ok: false, locked: !!lockedUntil });
  } catch (e) {
    console.error('app-lock verify-pin:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /set-idle { idle_minutes }
router.post('/set-idle', requireParentIdentity, async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const idleMinutes = Math.min(Math.max(parseInt(req.body?.idle_minutes, 10) || 5, 1), 60);
  const db = getPool();
  try {
    await db.query(
      `UPDATE parent_app_lock SET idle_minutes=$2, updated_at=now() WHERE lower(parent_email)=$1`,
      [email, idleMinutes]
    );
    res.json({ ok: true, idle_minutes: idleMinutes });
  } catch (e) {
    console.error('app-lock set-idle:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /disable — full reset (also serves as the "forgot PIN" backstop: reaching this
// route at all already required a live CF Access / email-OTP session).
router.post('/disable', requireParentIdentity, async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    await db.query(
      `UPDATE parent_app_lock
       SET enabled=false, pin_hash=NULL, webauthn_credentials='[]'::jsonb,
           failed_pin_attempts=0, locked_until=NULL,
           webauthn_current_challenge=NULL, webauthn_challenge_expires_at=NULL, updated_at=now()
       WHERE lower(parent_email)=$1`,
      [email]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('app-lock disable:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── WebAuthn: register a platform authenticator (Face ID / fingerprint) ────────────
router.post('/webauthn/register-options', requireParentIdentity, attemptLimiter, async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT webauthn_credentials FROM parent_app_lock WHERE lower(parent_email)=$1`, [email]
    );
    const existing = rows.length && Array.isArray(rows[0].webauthn_credentials) ? rows[0].webauthn_credentials : [];
    const { rpID } = rpIdAndOrigin(req);
    const userIDBuf = crypto.createHash('sha256').update(email).digest();
    const options = await generateRegistrationOptions({
      rpName: 'Your Nursery Parent App',
      rpID,
      userID: isoBase64URL.fromBuffer(userIDBuf),
      userName: email,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required', authenticatorAttachment: 'platform' },
      excludeCredentials: existing.map(c => ({ id: isoBase64URL.toBuffer(c.credentialID), type: 'public-key' })),
    });
    await db.query(
      `INSERT INTO parent_app_lock (parent_email, webauthn_current_challenge, webauthn_challenge_expires_at)
       VALUES ($1,$2, now() + interval '5 minutes')
       ON CONFLICT (parent_email) DO UPDATE
         SET webauthn_current_challenge=$2, webauthn_challenge_expires_at=now() + interval '5 minutes'`,
      [email, options.challenge]
    );
    res.json(options);
  } catch (e) {
    console.error('app-lock webauthn register-options:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/webauthn/register-verify', requireParentIdentity, attemptLimiter, async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT webauthn_current_challenge, webauthn_challenge_expires_at, webauthn_credentials
       FROM parent_app_lock WHERE lower(parent_email)=$1`, [email]
    );
    if (!rows.length || !rows[0].webauthn_current_challenge) {
      return res.status(400).json({ error: 'No registration in progress' });
    }
    const row = rows[0];
    if (new Date(row.webauthn_challenge_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Registration expired, please try again' });
    }
    const { rpID, origin } = rpIdAndOrigin(req);
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: row.webauthn_current_challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Verification failed' });
    }
    const info = verification.registrationInfo;
    const newCred = {
      credentialID: isoBase64URL.fromBuffer(info.credentialID),
      credentialPublicKey: isoBase64URL.fromBuffer(info.credentialPublicKey),
      counter: info.counter,
      credentialDeviceType: info.credentialDeviceType,
      credentialBackedUp: info.credentialBackedUp,
      transports: (req.body.response && req.body.response.transports) || [],
      deviceLabel: (req.headers['user-agent'] || '').slice(0, 120) || 'Device',
      createdAt: new Date().toISOString(),
    };
    const existing = Array.isArray(row.webauthn_credentials) ? row.webauthn_credentials : [];
    const updated = existing.concat([newCred]);
    await db.query(
      `UPDATE parent_app_lock
       SET webauthn_credentials=$2::jsonb, enabled=true,
           webauthn_current_challenge=NULL, webauthn_challenge_expires_at=NULL, updated_at=now()
       WHERE lower(parent_email)=$1`,
      [email, JSON.stringify(updated)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('app-lock webauthn register-verify:', e.message);
    res.status(400).json({ error: 'Verification failed' });
  }
});

// ── WebAuthn: authenticate (unlock) ─────────────────────────────────────────────────
router.post('/webauthn/auth-options', requireParentIdentity, attemptLimiter, async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT webauthn_credentials FROM parent_app_lock WHERE lower(parent_email)=$1`, [email]
    );
    const existing = rows.length && Array.isArray(rows[0].webauthn_credentials) ? rows[0].webauthn_credentials : [];
    if (!existing.length) return res.status(404).json({ error: 'No biometric registered' });
    const { rpID } = rpIdAndOrigin(req);
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: existing.map(c => ({
        id: isoBase64URL.toBuffer(c.credentialID), type: 'public-key', transports: c.transports || undefined,
      })),
    });
    await db.query(
      `UPDATE parent_app_lock SET webauthn_current_challenge=$2, webauthn_challenge_expires_at=now() + interval '5 minutes'
       WHERE lower(parent_email)=$1`,
      [email, options.challenge]
    );
    res.json(options);
  } catch (e) {
    console.error('app-lock webauthn auth-options:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/webauthn/auth-verify', requireParentIdentity, attemptLimiter, async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT webauthn_current_challenge, webauthn_challenge_expires_at, webauthn_credentials
       FROM parent_app_lock WHERE lower(parent_email)=$1`, [email]
    );
    if (!rows.length || !rows[0].webauthn_current_challenge) {
      return res.status(400).json({ error: 'No authentication in progress' });
    }
    const row = rows[0];
    if (new Date(row.webauthn_challenge_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Authentication expired, please try again' });
    }
    const creds = Array.isArray(row.webauthn_credentials) ? row.webauthn_credentials : [];
    const match = creds.find(c => c.credentialID === req.body.id);
    if (!match) return res.status(400).json({ error: 'Unknown credential' });
    const { rpID, origin } = rpIdAndOrigin(req);
    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: row.webauthn_current_challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      authenticator: {
        credentialID: isoBase64URL.toBuffer(match.credentialID),
        credentialPublicKey: isoBase64URL.toBuffer(match.credentialPublicKey),
        counter: match.counter,
        transports: match.transports || undefined,
      },
    });
    if (!verification.verified) return res.status(400).json({ ok: false, error: 'Verification failed' });
    const updated = creds.map(c => c.credentialID === match.credentialID
      ? { ...c, counter: verification.authenticationInfo.newCounter } : c);
    await db.query(
      `UPDATE parent_app_lock
       SET webauthn_credentials=$2::jsonb, webauthn_current_challenge=NULL, webauthn_challenge_expires_at=NULL, updated_at=now()
       WHERE lower(parent_email)=$1`,
      [email, JSON.stringify(updated)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('app-lock webauthn auth-verify:', e.message);
    res.status(400).json({ ok: false, error: 'Verification failed' });
  }
});

module.exports = router;
