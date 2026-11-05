'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Ealing EY Hub — PUBLIC (pre-auth) endpoints. Build b196, 2026-08-19.
//
// Mounted BEFORE the server's /api auth, off-site and device gates (those are
// nursery-portal concepts and would otherwise mis-classify this portal). Every
// endpoint here is deliberately unauthenticated, rate-limited, and touches only
// the `ealing` schema.
//
// Paths: POST /api/ealing/auth/login
//        POST /api/ealing/auth/magic-link
//        POST /api/ealing/auth/magic-consume
//        POST /api/ealing/auth/request-access
// ─────────────────────────────────────────────────────────────────────────────
const express   = require('express');
const rateLimit = require('express-rate-limit');
const { getEalingPool, ensureEalingSchema, audit } = require('../lib/ealing-db');
const A = require('../lib/ealing-auth');

const router = express.Router();
router.use('/api/ealing', express.json({ limit: '32kb' }));

const clean = (v, n = 200) => (v == null ? null : String(v).trim().slice(0, n) || null);
const ipOf  = (req) => (req.ip || req.socket?.remoteAddress || '').slice(0, 60);

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many attempts. Please wait a few minutes and try again.' },
});
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many requests from this network. Please try again later.' },
});

// Guard every route with the lazy schema bootstrap.
router.use('/api/ealing', async (req, res, next) => {
  try { await ensureEalingSchema(); next(); }
  catch (e) { console.error('[ealing] schema init failed:', e.message); res.status(503).json({ error: 'unavailable' }); }
});

async function loadUserByEmail(db, email) {
  const { rows } = await db.query(
    `SELECT u.*, o.name AS org_name, o.is_active AS org_active
       FROM ealing.users u
       JOIN ealing.orgs  o ON o.id = u.org_id
      WHERE lower(u.email) = lower($1)`, [email]);
  return rows[0] || null;
}

function sessionPayload(user) {
  return {
    token: A.mintToken(user),
    user: {
      id: user.id, name: user.full_name, email: user.email,
      role: user.role, job_title: user.job_title,
      org_id: user.org_id, org_name: user.org_name,
    },
  };
}

// ── Password login ───────────────────────────────────────────────────────────
router.post('/api/ealing/auth/login', loginLimiter, async (req, res) => {
  const email = clean(req.body?.email, 200);
  const password = req.body?.password;
  if (!email || !password) return res.status(400).json({ error: 'missing_fields', message: 'Email and password are required.' });

  const db = getEalingPool();
  try {
    const user = await loadUserByEmail(db, email);
    // Uniform failure message — never reveals whether the account exists.
    const deny = () => res.status(401).json({ error: 'invalid_credentials', message: 'Email or password not recognised.' });
    if (!user) return deny();
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'locked', message: 'Too many failed attempts. Try again in 15 minutes.' });
    }
    if (!user.is_active || !user.org_active || !user.approved_at) {
      await audit(db, { action: 'login_denied_inactive', userId: user.id, orgId: user.org_id, actorEmail: email, ip: ipOf(req) });
      return res.status(403).json({ error: 'not_approved', message: 'This account is not active yet. The Ealing EY team will be in touch once it is approved.' });
    }
    const ok = await A.verifyPassword(password, user.password_hash);
    if (!ok) {
      await db.query(
        `UPDATE ealing.users
            SET failed_logins = failed_logins + 1,
                locked_until = CASE WHEN failed_logins + 1 >= 8 THEN now() + interval '15 minutes' ELSE locked_until END
          WHERE id = $1`, [user.id]);
      await audit(db, { action: 'login_failed', userId: user.id, orgId: user.org_id, actorEmail: email, ip: ipOf(req) });
      return deny();
    }
    await db.query(`UPDATE ealing.users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
    await audit(db, { action: 'login', userId: user.id, orgId: user.org_id, actorEmail: email, ip: ipOf(req) });
    res.json(sessionPayload(user));
  } catch (e) {
    console.error('[ealing] login:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Magic link: request ──────────────────────────────────────────────────────
// Always answers 200 with the same body so the endpoint can't be used to test
// which settings are registered. NOTE: no mail is sent yet — the sending mailbox
// for LA-wide mail is an open decision (see NOTES "TO CONFIRM"). The link is
// logged server-side, and echoed in the response ONLY on the dev database.
router.post('/api/ealing/auth/magic-link', loginLimiter, async (req, res) => {
  const email = clean(req.body?.email, 200);
  const generic = { ok: true, message: 'If that email is registered, a sign-in link is on its way.' };
  if (!email) return res.json(generic);

  const db = getEalingPool();
  try {
    const user = await loadUserByEmail(db, email);
    if (!user || !user.is_active || !user.org_active || !user.approved_at) return res.json(generic);

    const raw = A.newLinkToken();
    await db.query(
      `INSERT INTO ealing.login_tokens (user_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, 'magic_link', now() + interval '30 minutes')`,
      [user.id, A.hashLinkToken(raw)]);
    await audit(db, { action: 'magic_link_requested', userId: user.id, orgId: user.org_id, actorEmail: email, ip: ipOf(req) });

    const link = `${req.protocol}://${req.get('host')}/magic?t=${raw}`;
    console.log(`[ealing] magic link for ${email}: ${link}`);
    if (A.IS_DEV_DB) return res.json({ ...generic, dev_link: link });
    res.json(generic);
  } catch (e) {
    console.error('[ealing] magic-link:', e.message);
    res.json(generic);
  }
});

// ── Magic link: consume ──────────────────────────────────────────────────────
router.post('/api/ealing/auth/magic-consume', loginLimiter, async (req, res) => {
  const raw = clean(req.body?.token, 400);
  if (!raw) return res.status(400).json({ error: 'missing_token' });

  const db = getEalingPool();
  try {
    const { rows } = await db.query(
      `UPDATE ealing.login_tokens
          SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`, [A.hashLinkToken(raw)]);
    if (!rows.length) return res.status(400).json({ error: 'link_invalid', message: 'That sign-in link has expired or has already been used.' });

    const { rows: urows } = await db.query(
      `SELECT u.*, o.name AS org_name, o.is_active AS org_active
         FROM ealing.users u JOIN ealing.orgs o ON o.id = u.org_id
        WHERE u.id = $1`, [rows[0].user_id]);
    const user = urows[0];
    if (!user || !user.is_active || !user.org_active || !user.approved_at) {
      return res.status(403).json({ error: 'not_approved' });
    }
    await db.query(`UPDATE ealing.users SET last_login_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1`, [user.id]);
    await audit(db, { action: 'login_magic_link', userId: user.id, orgId: user.org_id, actorEmail: user.email, ip: ipOf(req) });
    res.json(sessionPayload(user));
  } catch (e) {
    console.error('[ealing] magic-consume:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Request access (public sign-up) ──────────────────────────────────────────
// Creates a PENDING request only. No org, no user and no login until an
// la_admin approves it in the hub.
router.post('/api/ealing/auth/request-access', signupLimiter, async (req, res) => {
  const b = req.body || {};
  if (clean(b.website_hp, 200)) return res.status(201).json({ ok: true }); // honeypot

  const setting_name = clean(b.setting_name, 200);
  const full_name    = clean(b.full_name, 160);
  const email        = clean(b.email, 200);
  if (!setting_name || !full_name || !email) {
    return res.status(400).json({ error: 'missing_fields', message: 'Setting name, your name and your email are required.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'bad_email', message: 'That email address does not look right.' });
  }

  const db = getEalingPool();
  try {
    const { rows } = await db.query(
      `INSERT INTO ealing.access_requests
         (setting_name, urn, setting_type, full_name, job_title, email, phone, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [setting_name, clean(b.urn, 40), clean(b.setting_type, 40), full_name,
       clean(b.job_title, 120), email, clean(b.phone, 40), clean(b.message, 1000)]);
    await audit(db, { action: 'access_requested', actorEmail: email, refType: 'access_request', refId: rows[0].id,
                      detail: setting_name, ip: ipOf(req) });
    res.status(201).json({ ok: true, message: 'Thanks — the Ealing EY team will review your request and email you when your account is ready.' });
  } catch (e) {
    console.error('[ealing] request-access:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
