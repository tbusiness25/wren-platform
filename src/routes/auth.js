const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const totp = require('../lib/totp');
const { verifyCfAccessJwt } = require('../lib/cf-access-verify');
const { canViewSalaries } = require('../lib/capabilities');
// b239 — the parents portal front-end sends no bearer token; it authenticates
// with whatever cookie is in the jar. Every parent mint point below now also
// sets Wren's OWN session cookie, so the portal keeps working when the
// Cloudflare one goes away. See src/lib/parent-identity.js for why.
const { setParentSessionCookie, clearParentSessionCookie, fromWrenJwt } = require('../lib/parent-identity');
// b491 (2026-10-12): persistent per-account lockout — on top of, not instead of,
// the express-rate-limit limiters below (those reset on every window rollover
// and don't survive a restart). See src/lib/account-lockout.js.
const lockout = require('../lib/account-lockout');

// Roles that require TOTP when enrolled
const TOTP_ROLES = ['manager', 'deputy_manager', 'admin']; // fixed 2026-07-28: 'deputy' never matched ladn.staff.role

// b491 (2026-10-12) — which roles MUST have a second factor (Wren's own TOTP, or
// Wren ID — 'accountant' never reaches this code path at all: PIN is refused for
// it outright, a few lines below, and Wren ID + Authentik is its only door).
// Overridable from Roost → Security (settings.security_totp_roles, comma-
// separated); falls back to TOTP_ROLES so an unconfigured setting changes nothing.
// login-20261023: the one copy now lives in src/lib/totp-policy.js (Google SSO and Wren ID use it too).
const { getTotpRoles } = require('../lib/totp-policy');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// ── b210 (2026-08-21): Google Workspace SSO for staff, Roost + Seed only ──────
// Additive sub-router. Everything below this line — the PIN login, the TOTP
// gate, remember-device, the parent flows — is unchanged. SSO is a SECOND door
// to the same JWT, not a replacement: staff with no Workspace mailbox, and a
// manager locked out of Google, still sign in with a PIN exactly as before.
// The sub-router 404s on any portal other than admin/hr, so EY tablets never
// see it. See src/routes/auth-google.js and src/lib/google-oidc.js.
router.use('/google', require('./auth-google'));

// b233 — the same arrangement again for Wren's OWN identity provider
// (Authentik). Everything above about SSO being a SECOND door applies verbatim:
// PIN login is untouched and stays primary. This sub-router 404s on any portal
// that does not support it, and its parent half is off unless
// WREN_OIDC_PARENTS=on. Cloudflare Access is NOT weakened by mounting this —
// see wren-docs/decisions/2026-08-26-authentik-own-idp.md and the header of
// src/routes/auth-oidc.js.
router.use('/oidc', require('./auth-oidc'));

// ── Cloudflare Access JWT verification (security fix 2026-07-21) ──
// The previous inline verifier here assumed a response shape the real CF
// certs endpoint doesn't return (public_key/public_keys) — it could never
// actually verify a real assertion. Real verification now lives in
// src/lib/cf-access-verify.js (also used by server-unified.js's parent-portal
// gate) and is unit-tested against a mocked JWKS. Kept as a thin wrapper here
// since /cf-auto-login below is the JWT-minting choke point for the whole
// parent portal.

const totpChallengeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    try {
      const decoded = jwt.decode(req.body?.challenge_token || '');
      return decoded?.id ? `totp-${decoded.id}` : (req.ip || 'unknown');
    } catch { return (req.ip || 'unknown'); }
  },
  message: { error: 'Too many TOTP attempts, please try again in 5 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  // Card #21 (2026-07-21): keyed by staff identity, not IP. A shared EY
  // tablet — or wren-nginx not forwarding X-Forwarded-For for the ladn
  // location blocks — puts every staff member's login behind one apparent
  // IP, so an IP-only bucket meant one person's mistyped PIN locked out
  // everyone else on the same device/building for the rest of the window.
  keyGenerator: (req) => {
    const staffId = req.body?.staff_id;
    const email = (req.body?.email || '').toString().toLowerCase().trim();
    if (staffId) return `login-staff-${staffId}`;
    if (email) return `login-email-${email}`;
    // weeklybugs-20261030 (manual:37): /api/auth/refresh sends no body, so every
    // device's call always fell through to here — and behind cloudflared/nginx
    // req.ip collapses to one shared address for every client (same reason
    // auth-google.js, auth-oidc.js, staff-signin.js, clockin.js, door.js,
    // attendance.js, handbook.js and view-as.js all key off cf-connecting-ip
    // instead). One global 5-per-60s bucket for every login page's "keep me
    // signed in" check meant ordinary multi-user traffic 429'd constantly.
    return req.headers['cf-connecting-ip'] || req.ip || 'unknown';
  },
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
});

// Public: minimal staff info for PIN selector — id, initials, photo only (no PII)
router.get('/staff-list', async (req, res) => {
  try {
    const db = getPool();
    // room_id / room_name added 2026-07-29 (item 6): the EY login picker splits
    // the staff list by room so a room tablet shows fewer names. LEFT JOIN so
    // staff with no room (managers/floaters) still appear (room_id null).
    const { rows } = await db.query(`
      SELECT s.id,
             s.first_name,
             s.last_name,
             s.preferred_name,
             s.role,
             s.job_title,   -- login-20261023: tiles show the title; the role is the permission tier
             COALESCE(s.pin_length, 4) AS pin_length,
             LEFT(s.first_name, 1) || LEFT(COALESCE(s.last_name, ''), 1) as initials,
             s.profile_photo,
             s.room_id,
             r.name AS room_name
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.is_active = true
      ORDER BY s.first_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /pin-length?email= — returns the PIN length (4 or 6) for an email-based
// login so the PIN pad knows when to auto-submit. Always returns a length even
// for unknown emails (defaults to 4) to avoid leaking account existence.
router.get('/pin-length', async (req, res) => {
  const email = (req.query.email || '').toString().trim().toLowerCase();
  if (!email) return res.json({ pin_length: 4 });
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT COALESCE(pin_length, 4) AS pin_length FROM staff WHERE lower(email)=$1 AND is_active=true LIMIT 1',
      [email]
    );
    res.json({ pin_length: rows.length && rows[0].pin_length === 6 ? 6 : 4 });
  } catch (e) {
    res.json({ pin_length: 4 });
  }
});

// POST /login — PIN login for staff
router.post('/login', loginLimiter, async (req, res) => {
  const { staff_id, pin, email } = req.body;

  // Demo mode: auto-login (disabled in production, never uses Toby's account id=1)
  if (process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production' && req.body.demo_auto) {
    try {
      const db = getPool();
      const { rows } = await db.query(
        'SELECT * FROM staff WHERE id != 1 AND is_active=true ORDER BY id LIMIT 1'
      );
      if (!rows.length) return res.status(401).json({ error: 'No staff in demo' });
      const staff = rows[0];
      const token = jwt.sign(
        { id: staff.id, name: `${staff.first_name} ${staff.last_name}`,
          role: staff.role, room_id: staff.room_id },
        process.env.JWT_SECRET,
        { expiresIn: '12h', audience: req._portal || 'learning' }
      );
      return res.json({ token, staff: { id: staff.id, first_name: staff.first_name,
        last_name: staff.last_name, role: staff.role, room_id: staff.room_id }});
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Email + password path (demo accounts / future web login)
  const password = req.body.password;
  if (email && password && !pin && !staff_id) {
    try {
      const db = getPool();
      // login-20261023: case-insensitive, same as /pin-length (see the PIN path below).
      const { rows } = await db.query(
        'SELECT * FROM staff WHERE lower(trim(email))=lower(trim($1)) AND is_active=true ORDER BY id LIMIT 2', [email]);
      const staffRow = rows.length === 1 ? rows[0] : null;
      if (!staffRow || !staffRow.password_hash) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      const valid = await bcrypt.compare(password, staffRow.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

      const token = jwt.sign(
        { id: staffRow.id, name: `${staffRow.first_name} ${staffRow.last_name}`,
          role: staffRow.role, room_id: staffRow.room_id,
          scope: staffRow.scope || 'all', scope_value: staffRow.scope_value || null },
        process.env.JWT_SECRET,
        { expiresIn: '12h', audience: req._portal || 'learning' }
      );
      db.query('UPDATE staff SET last_login_at=now() WHERE id=$1', [staffRow.id]).catch(() => {});
      return res.json({ token, staff: { id: staffRow.id, first_name: staffRow.first_name,
        last_name: staffRow.last_name, role: staffRow.role, room_id: staffRow.room_id } });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (!pin) return res.status(400).json({ error: 'PIN required' });

  try {
    const db = getPool();
    let staffRow;

    if (staff_id) {
      const { rows } = await db.query(
        'SELECT * FROM staff WHERE id=$1 AND is_active=true', [staff_id]
      );
      staffRow = rows[0];
    } else if (email) {
      // login-20261023: match the address case-insensitively. 9 of 20 active staff
      // have capitals in their stored email, so a phone that typed it differently
      // got "Staff not found" — shown to them as "Incorrect PIN". /pin-length
      // already matched on lower(email); this makes the login agree with it.
      // Two active rows sharing an address is ambiguous, so neither is picked.
      const { rows } = await db.query(
        'SELECT * FROM staff WHERE lower(trim(email))=lower(trim($1)) AND is_active=true ORDER BY id LIMIT 2', [email]
      );
      staffRow = rows.length === 1 ? rows[0] : undefined;
    }

    if (!staffRow) {
      recordAudit({ req, action: 'login', entity_type: 'staff', actor_type: 'anonymous', meta: { success: false, reason: 'staff_not_found', staff_id, email } });
      return res.status(401).json({ error: 'Staff not found' });
    }
    // b480 (2026-10-12) — accountant accounts never use PIN login, whatever the
    // PIN is or isn't set to. Nathan (external accountant) signs in with Wren
    // ID (Authentik) using a passkey or authenticator app; checked here, on the
    // DB row, before any token exists, so a correct PIN still never mints one.
    if (staffRow.role === 'accountant') {
      recordAudit({ req, action: 'login', entity_type: 'staff', entity_id: staffRow.id, actor_id: staffRow.id, actor_type: 'anonymous', meta: { success: false, reason: 'accountant_pin_disabled' } });
      return res.status(403).json({
        error: 'accountant_pin_disabled',
        message: 'This account signs in with Wren ID (passkey or authenticator app) — PIN login is disabled.',
      });
    }
    if (!staffRow.pin_hash) {
      recordAudit({ req, action: 'login', entity_type: 'staff', entity_id: staffRow.id, actor_id: staffRow.id, actor_type: 'anonymous', meta: { success: false, reason: 'pin_not_set' } });
      return res.status(401).json({ error: 'PIN not set' });
    }

    // b491 (2026-10-12): persistent lockout — checked before the PIN is even compared.
    const lockState = await lockout.checkLocked(db, 'staff', staffRow.id);
    if (lockState.locked) {
      recordAudit({ req, action: 'login', entity_type: 'staff', entity_id: staffRow.id, actor_id: staffRow.id, actor_type: 'anonymous', meta: { success: false, reason: 'account_locked' } });
      return res.status(403).json({ error: 'account_locked', locked_until: lockState.until.toISOString(), message: lockout.formatLockMessage(lockState.until) });
    }

    const valid = await bcrypt.compare(pin, staffRow.pin_hash);
    if (!valid) {
      recordAudit({ req, action: 'login', entity_type: 'staff', entity_id: staffRow.id, actor_id: staffRow.id, actor_type: 'anonymous', meta: { success: false, reason: 'wrong_pin' } });
      const fail = await lockout.recordFailure(db, 'staff', staffRow.id, { req, staffId: staffRow.id, label: `${staffRow.first_name} ${staffRow.last_name}` });
      if (fail.locked) {
        return res.status(403).json({ error: 'account_locked', locked_until: fail.until.toISOString(), message: lockout.formatLockMessage(fail.until) });
      }
      return res.status(401).json({ error: 'Incorrect PIN' });
    }
    await lockout.recordSuccess(db, 'staff', staffRow.id);

    // ── TOTP gate ─────────────────────────────────────────────────────────────
    const totpDisabled = process.env.WREN_TOTP_DISABLED === 'true';
    const graceUntil = process.env.TOTP_GRACE_UNTIL ? new Date(process.env.TOTP_GRACE_UNTIL) : null;
    const inGrace = graceUntil && new Date() < graceUntil;
    const totpRoles = await getTotpRoles(db);
    // b491 review: EY (learning) tablet logins stay PIN-only (brief item 2; shared tablets are
    // device-enrolled, and the EY login page has no TOTP or enrolment step).
    const roleNeedsTotp = !totpDisabled && totpRoles.includes(staffRow.role) && !inGrace
      && (req._portal || 'learning') !== 'learning';
    const needsTotp = roleNeedsTotp && staffRow.totp_verified === true;

    if (needsTotp) {
      const challengeToken = jwt.sign(
        // 26 Oct: carry the "trust this device" tick through the code step. It used to be read only
        // after this early return, so a manager with 2FA could never be remembered.
        { id: staffRow.id, role: staffRow.role, scope: 'totp_only', remember: req.body.remember === true },
        process.env.JWT_SECRET,
        { expiresIn: '5m', audience: req._portal || 'learning' }
      );
      return res.json({ requires_totp: true, challenge_token: challengeToken });
    }
    // b491 (2026-10-12): the role requires 2FA but none is enrolled yet — PIN alone
    // used to be enough forever (totp_verified stays false until enrolment completes).
    // No lock-out of existing managers: a narrow token good for nothing except
    // finishing enrolment (gated at editions/ladn/server-unified.js's two-factor
    // scope gate) replaces a full session, so PIN-only access never actually opens.
    if (roleNeedsTotp && staffRow.totp_verified !== true) {
      const enrollToken = jwt.sign(
        { id: staffRow.id, role: staffRow.role, scope: 'totp_enroll_required' },
        process.env.JWT_SECRET,
        { expiresIn: '15m', audience: req._portal || 'learning' }
      );
      recordAudit({ req, action: 'login', entity_type: 'staff', entity_id: staffRow.id, actor_id: staffRow.id, actor_type: 'staff', meta: { success: false, reason: 'totp_enrollment_required' } });
      return res.json({ requires_totp_enrollment: true, enroll_token: enrollToken });
    }
    // ── End TOTP gate ─────────────────────────────────────────────────────────

    const token = jwt.sign(
      { id: staffRow.id,
        name: `${staffRow.first_name} ${staffRow.last_name}`,
        role: staffRow.role,
        room_id: staffRow.room_id,
        scope: staffRow.scope || 'all',
        scope_value: staffRow.scope_value || null },
      process.env.JWT_SECRET,
      { expiresIn: '12h', audience: req._portal || 'learning' }
    );

    recordAudit({ req, action: 'login', entity_type: 'staff', entity_id: staffRow.id, actor_type: 'staff', actor_id: staffRow.id, actor_email: staffRow.email, meta: { success: true } });
    db.query('UPDATE staff SET last_login_at=now() WHERE id=$1', [staffRow.id]).catch(() => {});

    // Remember-device (2026-07-04): opt-in per login. Issues a rotating opaque
    // refresh token (staff variant of the parents flow) so trusted personal
    // devices can silently re-mint a 12h JWT instead of re-entering the PIN.
    // NOT for shared tablets — the UI only offers it on the admin login.
    if (req.body.remember === true) {
      try {
        const rawRt = await issueStaffRefreshToken(db, staffRow.id, req._portal || 'learning', req.headers['user-agent']);
        setRefreshCookie(res, rawRt);
        recordAudit({ req, action: 'remember_device', entity_type: 'staff', entity_id: staffRow.id, actor_type: 'staff', actor_id: staffRow.id, meta: { portal: req._portal || 'learning' } });
      } catch (e) { /* remember-device is best-effort — login still succeeds */ }
    }

    res.json({
      token,
      staff: {
        id: staffRow.id,
        first_name: staffRow.first_name,
        last_name: staffRow.last_name,
        role: staffRow.role,
        room_id: staffRow.room_id,
        profile_photo: staffRow.profile_photo,
        scope: staffRow.scope || 'all',
        scope_value: staffRow.scope_value || null
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /parent-login — email+password login for parent portal (demo + future)
router.post('/parent-login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT ppa.*, c.first_name, c.last_name, c.room_id
       FROM parent_portal_access ppa
       JOIN children c ON c.id = ppa.child_id
       WHERE lower(ppa.email)=$1 AND ppa.is_active=true AND c.is_active=true
       ORDER BY ppa.id LIMIT 1`,
      [email.toLowerCase()]
    );
    const rec = rows[0];
    if (!rec) return res.status(401).json({ error: 'Invalid email or password' });

    // b491 (2026-10-12): persistent lockout, keyed on the lower-cased email
    // (a parent account has no staff id).
    const lockState = await lockout.checkLocked(db, 'parent', email);
    if (lockState.locked) {
      return res.status(403).json({ error: 'account_locked', locked_until: lockState.until.toISOString(), message: lockout.formatLockMessage(lockState.until) });
    }

    // Check password_hash if set; fallback to token_hash for backwards compat
    const hashToCheck = rec.password_hash || rec.token_hash;
    if (!hashToCheck) return res.status(401).json({ error: 'Account not set up for password login' });
    const valid = await bcrypt.compare(password, hashToCheck);
    if (!valid) {
      const fail = await lockout.recordFailure(db, 'parent', email, { req, label: 'parent portal' });
      if (fail.locked) {
        return res.status(403).json({ error: 'account_locked', locked_until: fail.until.toISOString(), message: lockout.formatLockMessage(fail.until) });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    await lockout.recordSuccess(db, 'parent', email);

    // Get all children for this parent email
    const { rows: children } = await db.query(
      `SELECT ppa.child_id, c.first_name, c.last_name, c.room_id
       FROM parent_portal_access ppa
       JOIN children c ON c.id = ppa.child_id
       WHERE lower(ppa.email)=$1 AND ppa.is_active=true AND c.is_active=true`,
      [email.toLowerCase()]
    );

    const childIds = children.map(c => c.child_id);
    const token = jwt.sign(
      { id: 0, name: email, email, role: 'parent',
        child_id: rec.child_id, child_ids: childIds, room_id: rec.room_id },
      process.env.JWT_SECRET,
      { expiresIn: '30d', audience: req._portal || 'parents' }
    );
    db.query('UPDATE parent_portal_access SET last_login=now() WHERE email=$1', [email.toLowerCase()]).catch(() => {});
    setParentSessionCookie(req, res, token);   // b239
    res.json({ token, children });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /me — return current user info
router.get('/me', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT s.id, s.first_name, s.last_name, s.email, s.role, s.room_id,
              s.profile_photo, s.contracted_hours,
              r.name as room_name
       FROM staff s
       LEFT JOIN rooms r ON r.id = s.room_id
       WHERE s.id=$1 AND s.is_active=true`, [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const me = rows[0];
    // b488: so pages like rota.html can gate a payroll export client-side
    // without guessing at role — the server route (requireSalaryView) is the
    // real gate, this just lets the UI match it instead of 403ing after a click.
    me.can_view_salaries = await canViewSalaries(req.user);
    res.json(me);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /cf-auto-login — reads CF Access header, issues parent JWT automatically
// Security fix 2026-07-21: this mints a 30-day parent JWT trusted by every
// other parent route in the app — it must not trust the plaintext header
// alone. Verified against Cloudflare's real signing keys (defense-in-depth;
// the /welcome/* routes downstream are also independently gated in
// server-unified.js). Kill switch: PARENT_CF_JWT_ENFORCE=false + restart.
router.get('/cf-auto-login', loginLimiter, async (req, res) => {
  // ── b320: inside a "view as" session, hand back the session's OWN token ────
  // Six Finch pages boot by calling this and using the token it returns for one
  // call. A view-as session has no Cloudflare identity of its own — the manager
  // passed CF Access as themselves — so the normal path below would either 401
  // ('no_child', the manager is not a parent) or, worse, mint a thirty-day
  // parent token for whoever the manager happens to be.
  //
  // Nothing is minted here: this returns the token the request already carries,
  // with the same claims, the same thirty-minute expiry and the same `vas`
  // marker, so it stays read-only everywhere it is used. No refresh token, no
  // refresh cookie, no last_login write against somebody else's account.
  if (req.viewAs) {
    try {
      const db = getPool();
      // req.parent is NOT set here. The gate that would set it,
      // app.use('/api/auth/cf-auto-login', _requireVerifiedParentSession), tests
      // req.path — and inside an app.use() mount express has already stripped
      // the prefix, so req.path is '/' and the gate's own path test never
      // matches. (The route is still verified: the CF check below is inside the
      // handler.) So take the address from the verified token instead, which is
      // where it authoritatively lives anyway.
      const vas = require('../lib/view-as').claimsOf(req) || {};
      const email = String((req.parent && req.parent.email) || vas.email || vas.name || '')
        .toLowerCase().trim();
      if (!email || email.indexOf('@') === -1) return res.status(401).json({ error: 'Unauthorised' });
      const { rows } = await db.query(
        `SELECT c.id, c.first_name, c.last_name, c.room_id FROM children c
          WHERE ((lower(c.parent_1_email)=$1 OR lower(c.parent_2_email)=$1) AND c.is_active=true)
             OR EXISTS (SELECT 1 FROM parent_portal_access pa
                        WHERE pa.child_id=c.id AND lower(pa.email)=$1 AND pa.is_active=true)
          ORDER BY c.is_active DESC, c.id`, [email]);
      if (!rows.length) return res.status(401).json({ error: 'no_child' });
      // b399 — "view as" shows the manager exactly what this parent sees,
      // enquiry-mode nav included (the server-side gate applies the same way).
      let enquiryMode = false;
      try { enquiryMode = await require('../lib/enquiry-access').isEnquiryModeEmail(db, email); } catch (_) {}
      return res.json({
        token: require('../lib/view-as').rawTokenOf(req),
        child: rows[0], children: rows, view_as: true, read_only: true, enquiry_mode: enquiryMode,
      });
    } catch (e) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  let cfEmail = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!cfEmail) {
    // 2026-10-29 — parents sign in with a Wren email code now (/parent-code/* below), and
    // Cloudflare Access no longer sits in front of the parents host. Pages still call this
    // to get a bearer token, so with no CF identity the Wren session cookie answers instead:
    // the same token, re-minted with today's children, never outliving the cookie it came
    // from, and no refresh token or cookie re-issued (only signing in does that).
    const w = fromWrenJwt(req);
    if (!w.ok || (w.claims && w.claims.vas)) {
      res.setHeader('X-Wren-Login', 'required');
      return res.status(401).json({ error: 'login_required', login: '/login.html' });
    }
    try {
      const db = getPool();
      const rows = await parentChildrenFor(db, w.email);
      if (!rows.length) {
        res.setHeader('X-Wren-Login', 'required');
        return res.status(401).json({ error: 'no_child' });
      }
      const child = rows[0];
      const token = jwt.sign(
        { id: 0, name: w.email, role: 'parent', child_id: child.id, child_ids: rows.map(r => r.id), room_id: child.room_id,
          exp: w.claims.exp || Math.floor(Date.now() / 1000) + 30 * 24 * 3600 },
        process.env.JWT_SECRET,
        { audience: req._portal || 'parents' }
      );
      let enquiryMode = false;
      try { enquiryMode = await require('../lib/enquiry-access').isEnquiryModeEmail(db, w.email); } catch (_) {}
      return res.json({ token, child, children: rows, enquiry_mode: enquiryMode });
    } catch (e) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
  if (process.env.PARENT_CF_JWT_ENFORCE !== 'false') {
    const rawAssertion = (req.headers['cf-access-jwt-assertion'] || req.headers['cf-access-jwt'] || req.cookies?.CF_Authorization || '').toString().trim();
    const result = await verifyCfAccessJwt(rawAssertion, cfEmail);
    if (!result.ok) {
      console.warn(`[cf-access-guard] cf-auto-login REJECTED (${result.reason}) claimed=${cfEmail}`);
      return res.status(401).json({ error: 'Cloudflare Access verification failed' });
    }
  }
  try {
    const db = getPool();
    // Resolve the child either via the active parent-email link OR via an active
    // parent_portal_access row — the latter covers provisional/enquiry families
    // (child.is_active=false) so they can use messaging pre-enrolment, exactly as
    // the /welcome/* endpoints already scope. Prefer a real active child if both exist.
    const { rows } = await db.query(
      `SELECT c.id, c.first_name, c.last_name, c.room_id FROM children c
       WHERE ((lower(c.parent_1_email)=$1 OR lower(c.parent_2_email)=$1) AND c.is_active=true)
          OR EXISTS (SELECT 1 FROM parent_portal_access pa
                     WHERE pa.child_id=c.id AND lower(pa.email)=$1 AND pa.is_active=true)
       ORDER BY c.is_active DESC, c.id`,
      [cfEmail]
    );
    if (!rows.length) return res.status(401).json({ error: 'no_child' });
    const child = rows[0];                     // primary (for single-child back-compat)
    const childIds = rows.map(r => r.id);      // ALL this parent's children (siblings)
    const token = jwt.sign(
      { id: 0, name: cfEmail, role: 'parent', child_id: child.id, child_ids: childIds, room_id: child.room_id },
      process.env.JWT_SECRET,
      { expiresIn: '30d', audience: req._portal || 'parents' }
    );
    const rawRefresh = await issueRefreshToken(db, cfEmail, child.id, req.headers['user-agent']);
    setRefreshCookie(res, rawRefresh);
    setParentSessionCookie(req, res, token);   // b239 — Wren's own session, alongside CF's
    // b399 (2026-10-06) — lets the parents app (pwa.js) render the cut-down
    // nav for a family on the pipeline but not yet enrolled. The server-side
    // gate (src/lib/parent-enquiry-mode.js) enforces this independently —
    // this is only so the UI doesn't offer a tile that would 403.
    let enquiryMode = false;
    try {
      enquiryMode = await require('../lib/enquiry-access').isEnquiryModeEmail(db, cfEmail);
    } catch (_) { /* default false — full nav, server-side gate still enforces */ }
    res.json({ token, child, children: rows, enquiry_mode: enquiryMode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /logout — client-side only (JWT is stateless) but log it
router.post('/logout', authenticate, (req, res) => {
  recordAudit({ req, action: 'logout', entity_type: 'staff', entity_id: req.user.id });
  res.json({ ok: true });
});

// ── TOTP endpoints ────────────────────────────────────────────────────────────

// POST /api/auth/totp — complete challenge (code or recovery)
router.post('/totp', totpChallengeLimiter, async (req, res) => {
  const { challenge_token, code } = req.body;
  if (!challenge_token || !code) return res.status(400).json({ error: 'challenge_token and code required' });

  let decoded;
  try {
    decoded = jwt.verify(challenge_token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired challenge token' });
  }
  if (decoded.scope !== 'totp_only') return res.status(401).json({ error: 'Invalid challenge token scope' });

  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT id, first_name, last_name, role, room_id, profile_photo, scope, scope_value, totp_secret, totp_verified, totp_last_used FROM staff WHERE id=$1 AND is_active=true',
      [decoded.id]
    );
    if (!rows.length) return res.status(401).json({ error: 'Staff not found' });
    const staffRow = rows[0];

    // b491 (2026-10-12): the same persistent lockout as PIN login — a TOTP
    // brute-force (or recovery-code guessing) on a correct PIN counts the same way.
    const lockState = await lockout.checkLocked(db, 'staff', staffRow.id);
    if (lockState.locked) {
      return res.status(403).json({ error: 'account_locked', locked_until: lockState.until.toISOString(), message: lockout.formatLockMessage(lockState.until) });
    }

    const currentWin = totp.currentWindow();
    let authMethod = null;

    // Try TOTP code
    if (/^\d{6}$/.test(code)) {
      if (totp.verify(code, staffRow.totp_secret)) {
        if (staffRow.totp_last_used === currentWin) {
          await db.query("INSERT INTO totp_audit(staff_id,event,ip,user_agent) VALUES($1,'failed',$2,$3)",
            [staffRow.id, req.ip, (req.headers['user-agent']||'').substring(0,200)]);
          return res.status(401).json({ error: 'Code already used — wait for the next code' });
        }
        authMethod = 'used';
      }
    } else {
      // Try recovery code
      const cleanCode = code.trim().toUpperCase();
      const { rows: recs } = await db.query(
        'SELECT id, code_hash FROM totp_recovery_codes WHERE staff_id=$1 AND used_at IS NULL',
        [staffRow.id]
      );
      for (const rec of recs) {
        if (await totp.compareCode(cleanCode, rec.code_hash)) {
          await db.query('UPDATE totp_recovery_codes SET used_at=now() WHERE id=$1', [rec.id]);
          authMethod = 'recovery_used';
          break;
        }
      }
    }

    if (!authMethod) {
      await db.query("INSERT INTO totp_audit(staff_id,event,ip,user_agent) VALUES($1,'failed',$2,$3)",
        [staffRow.id, req.ip, (req.headers['user-agent']||'').substring(0,200)]);
      const fail = await lockout.recordFailure(db, 'staff', staffRow.id, { req, staffId: staffRow.id, label: `${staffRow.first_name} ${staffRow.last_name}` });
      if (fail.locked) {
        return res.status(403).json({ error: 'account_locked', locked_until: fail.until.toISOString(), message: lockout.formatLockMessage(fail.until) });
      }
      return res.status(401).json({ error: 'Invalid code' });
    }
    await lockout.recordSuccess(db, 'staff', staffRow.id);

    // Update last used window (replay prevention)
    if (authMethod === 'used') {
      await db.query('UPDATE staff SET totp_last_used=$1 WHERE id=$2', [currentWin, staffRow.id]);
    }
    await db.query("INSERT INTO totp_audit(staff_id,event,ip,user_agent) VALUES($1,$2,$3,$4)",
      [staffRow.id, authMethod, req.ip, (req.headers['user-agent']||'').substring(0,200)]);

    const fullToken = jwt.sign(
      { id: staffRow.id,
        name: `${staffRow.first_name} ${staffRow.last_name}`,
        role: staffRow.role,
        room_id: staffRow.room_id,
        scope: staffRow.scope || 'all',
        scope_value: staffRow.scope_value || null },
      process.env.JWT_SECRET,
      { expiresIn: '12h', audience: req._portal || 'learning' }
    );
    db.query('UPDATE staff SET last_login_at=now() WHERE id=$1', [staffRow.id]).catch(() => {});

    // Remember-device after a passed code: the refresh path re-checks enrolment and lockout,
    // so a trusted personal phone skips the PIN and the code for 30 days. Not offered on EY tablets.
    // 2026-10-27: the box can also be ticked on the code step itself — Wren ID sign-ins never
    // show the PIN step, so Toby could not be remembered on Roost. Never on EY tablets.
    const _rmPortal = req._portal || decoded.aud || 'learning';
    if (decoded.remember === true || (req.body.remember === true && _rmPortal !== 'learning')) {
      try {
        const portal = _rmPortal;
        const rawRt = await issueStaffRefreshToken(db, staffRow.id, portal, req.headers['user-agent']);
        setRefreshCookie(res, rawRt);
        recordAudit({ req, action: 'remember_device', entity_type: 'staff', entity_id: staffRow.id, actor_type: 'staff', actor_id: staffRow.id, meta: { portal, after_totp: true } });
      } catch (e) { /* best-effort — the sign-in still succeeds */ }
    }

    res.json({
      token: fullToken,
      staff: { id: staffRow.id, first_name: staffRow.first_name, last_name: staffRow.last_name,
                role: staffRow.role, room_id: staffRow.room_id, profile_photo: staffRow.profile_photo,
                scope: staffRow.scope || 'all', scope_value: staffRow.scope_value || null }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/totp/enroll/start — begin enrolment (requires valid JWT)
router.post('/totp/enroll/start', authenticate, async (req, res) => {
  // b491 review: a PIN-only challenge token must never re-key an existing second factor.
  if (req.user.scope === 'totp_only') return res.status(403).json({ error: 'totp_required' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT id, email, first_name, last_name FROM staff WHERE id=$1 AND is_active=true',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    const staffRow = rows[0];
    const secret = totp.generateSecret();
    const accountName = staffRow.email || `${staffRow.first_name}.${staffRow.last_name}@wren`;
    const otpauthUrl = totp.buildOtpauthUrl(secret, accountName);
    const qrDataUrl = await totp.buildQrDataUrl(otpauthUrl);

    await db.query(
      'UPDATE staff SET totp_secret=$1, totp_verified=false, totp_enrolled_at=NULL WHERE id=$2',
      [secret, req.user.id]
    );
    res.json({ otpauth_url: otpauthUrl, qr_data_url: qrDataUrl, secret });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/totp/enroll/verify — confirm first valid code, issue recovery codes
router.post('/totp/enroll/verify', authenticate, async (req, res) => {
  if (req.user.scope === 'totp_only') return res.status(403).json({ error: 'totp_required' }); // b491 review
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT id, first_name, last_name, role, room_id, scope, scope_value, totp_secret, totp_verified FROM staff WHERE id=$1 AND is_active=true',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    const staffRow = rows[0];
    if (!staffRow.totp_secret) return res.status(400).json({ error: 'Enrolment not started — call /enroll/start first' });
    if (!totp.verify(code, staffRow.totp_secret)) {
      await db.query("INSERT INTO totp_audit(staff_id,event,ip,user_agent) VALUES($1,'failed',$2,$3)",
        [req.user.id, req.ip, (req.headers['user-agent']||'').substring(0,200)]);
      return res.status(401).json({ error: 'Invalid code' });
    }

    // Generate and store recovery codes
    const plainCodes = totp.generateRecoveryCodes(10);
    await db.query('DELETE FROM totp_recovery_codes WHERE staff_id=$1', [req.user.id]);
    for (const code of plainCodes) {
      const hash = await totp.hashCode(code);
      await db.query('INSERT INTO totp_recovery_codes(staff_id,code_hash) VALUES($1,$2)', [req.user.id, hash]);
    }

    await db.query(
      "UPDATE staff SET totp_verified=true, totp_enrolled_at=now(), totp_last_used=NULL WHERE id=$1",
      [req.user.id]
    );
    await db.query("INSERT INTO totp_audit(staff_id,event,ip,user_agent) VALUES($1,'enrolled',$2,$3)",
      [req.user.id, req.ip, (req.headers['user-agent']||'').substring(0,200)]);

    // b491 (2026-10-12): if this call completed a MANDATORY first-login enrolment,
    // req.user carries the narrow 'totp_enroll_required' scope — which the server's
    // two-factor scope gate confines to /api/auth/*. Mint a real session now so the
    // guided setup flow can hand the caller straight into the app; a voluntary
    // re-enrolment (already fully authenticated) also gets a fresh token, harmlessly.
    const fullToken = jwt.sign(
      { id: staffRow.id, name: `${staffRow.first_name} ${staffRow.last_name}`, role: staffRow.role,
        room_id: staffRow.room_id, scope: staffRow.scope || 'all', scope_value: staffRow.scope_value || null },
      process.env.JWT_SECRET,
      { expiresIn: '12h', audience: req._portal || 'learning' }
    );
    db.query('UPDATE staff SET last_login_at=now() WHERE id=$1', [staffRow.id]).catch(() => {});

    res.json({ ok: true, recovery_codes: plainCodes, token: fullToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/totp/recovery/regenerate — replace all unused recovery codes
router.post('/totp/recovery/regenerate', authenticate, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT totp_verified FROM staff WHERE id=$1 AND is_active=true', [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    if (!rows[0].totp_verified) return res.status(400).json({ error: 'TOTP not enrolled' });

    const plainCodes = totp.generateRecoveryCodes(10);
    await db.query('DELETE FROM totp_recovery_codes WHERE staff_id=$1 AND used_at IS NULL', [req.user.id]);
    for (const code of plainCodes) {
      const hash = await totp.hashCode(code);
      await db.query('INSERT INTO totp_recovery_codes(staff_id,code_hash) VALUES($1,$2)', [req.user.id, hash]);
    }
    await db.query("INSERT INTO totp_audit(staff_id,event,ip,user_agent) VALUES($1,'recovery_regenerated',$2,$3)",
      [req.user.id, req.ip, (req.headers['user-agent']||'').substring(0,200)]);

    res.json({ ok: true, recovery_codes: plainCodes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/totp/reset — manager resets another staff member's TOTP
router.post('/totp/reset', authenticate, async (req, res) => {
  // b491 review: EY (learning) stays PIN-only for managers, so the controls that turn 2FA off,
  // reset someone's second factor or PIN, or lift a lockout are Roost/HR-only (post-2FA sessions).
  if ((req._portal || 'learning') === 'learning') return res.status(403).json({ error: 'roost_or_hr_only', message: 'Use Roost or HR for account security.' });
  const { target_staff_id } = req.body;
  if (!target_staff_id) return res.status(400).json({ error: 'target_staff_id required' });
  if (!hasRole(req.user, TOTP_ROLES)) return res.status(403).json({ error: 'Manager+ only' });

  // Safety: cannot self-reset Toby (id=1) — he must use break-glass
  if (target_staff_id == 1 && req.user.id !== 1) {
    return res.status(403).json({ error: 'Cannot reset manager id=1 via this endpoint — use break-glass procedure' });
  }

  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT id, first_name, last_name FROM staff WHERE id=$1 AND is_active=true', [target_staff_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });

    await db.query(
      "UPDATE staff SET totp_secret=NULL, totp_verified=false, totp_enrolled_at=NULL, totp_last_used=NULL WHERE id=$1",
      [target_staff_id]
    );
    await db.query('DELETE FROM totp_recovery_codes WHERE staff_id=$1', [target_staff_id]);
    await db.query(
      "INSERT INTO totp_audit(staff_id,event,ip,user_agent) VALUES($1,'reset',$2,$3)",
      [target_staff_id, req.ip, (req.headers['user-agent']||'').substring(0,200)]
    );

    res.json({ ok: true, message: `TOTP reset for staff id=${target_staff_id}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/totp/status — get TOTP enrolment status for current user
router.get('/totp/status', authenticate, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT totp_verified, totp_enrolled_at FROM staff WHERE id=$1', [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { rows: recs } = await db.query(
      'SELECT COUNT(*)::int as remaining FROM totp_recovery_codes WHERE staff_id=$1 AND used_at IS NULL',
      [req.user.id]
    );
    res.json({
      enrolled: rows[0].totp_verified,
      enrolled_at: rows[0].totp_enrolled_at,
      recovery_codes_remaining: recs[0].remaining,
      totp_required: hasRole(req.user, TOTP_ROLES),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/totp/users — manager: list all TOTP-role staff with enrolment status
router.get('/totp/users', authenticate, async (req, res) => {
  if (!hasRole(req.user, TOTP_ROLES)) return res.status(403).json({ error: 'Manager+ only' });
  const db = getPool();
  try {
    const roles = await getTotpRoles(db); // b491: reflects the Roost → Security setting, not the hard-coded default
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, email, role, totp_verified, totp_enrolled_at
       FROM staff WHERE role = ANY($1) AND is_active=true ORDER BY id`,
      [roles]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Security settings (b491, 2026-10-12) ───────────────────────────────────────

// GET /api/auth/security-settings — manager+: which roles must have a second factor.
router.get('/security-settings', authenticate, async (req, res) => {
  if (!hasRole(req.user, TOTP_ROLES)) return res.status(403).json({ error: 'Manager+ only' });
  const db = getPool();
  try {
    res.json({ totp_roles: await getTotpRoles(db), default_totp_roles: TOTP_ROLES });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/auth/security-settings — manager+: set which roles must have a second factor. Audited.
router.put('/security-settings', authenticate, async (req, res) => {
  // b491 review: EY (learning) stays PIN-only for managers, so the controls that turn 2FA off,
  // reset someone's second factor or PIN, or lift a lockout are Roost/HR-only (post-2FA sessions).
  if ((req._portal || 'learning') === 'learning') return res.status(403).json({ error: 'roost_or_hr_only', message: 'Use Roost or HR for account security.' });
  if (!hasRole(req.user, TOTP_ROLES)) return res.status(403).json({ error: 'Manager+ only' });
  const { totp_roles } = req.body;
  if (!Array.isArray(totp_roles) || !totp_roles.length) return res.status(400).json({ error: 'totp_roles must be a non-empty array' });
  const db = getPool();
  try {
    const value = totp_roles.map(r => String(r).trim()).filter(Boolean).join(',');
    await db.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('security_totp_roles', $1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=now()`,
      [value, req.user.id]
    );
    recordAudit({ req, action: 'update', entity_type: 'settings', entity_id: 'security_totp_roles', meta: { totp_roles: value } });
    res.json({ ok: true, totp_roles: value.split(',') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Account lockout admin (b491, 2026-10-12) ───────────────────────────────────

// GET /api/auth/lockouts — manager+: list currently-locked accounts, for Roost/HR → Security.
router.get('/lockouts', authenticate, async (req, res) => {
  if (!hasRole(req.user, TOTP_ROLES)) return res.status(403).json({ error: 'Manager+ only' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT al.account_type, al.account_key, al.failed_attempts, al.locked_until, al.lockout_count, al.updated_at,
              s.first_name, s.last_name
         FROM account_lockouts al
         LEFT JOIN staff s ON al.account_type='staff' AND s.id::text = al.account_key
        WHERE al.locked_until IS NOT NULL AND al.locked_until > now()
        ORDER BY al.locked_until DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/lockouts/unlock — manager+: clear a lock (and its escalation level). Audited.
router.post('/lockouts/unlock', authenticate, async (req, res) => {
  // b491 review: EY (learning) stays PIN-only for managers, so the controls that turn 2FA off,
  // reset someone's second factor or PIN, or lift a lockout are Roost/HR-only (post-2FA sessions).
  if ((req._portal || 'learning') === 'learning') return res.status(403).json({ error: 'roost_or_hr_only', message: 'Use Roost or HR for account security.' });
  if (!hasRole(req.user, TOTP_ROLES)) return res.status(403).json({ error: 'Manager+ only' });
  const { account_type, account_key } = req.body;
  if (!account_type || !account_key) return res.status(400).json({ error: 'account_type and account_key required' });
  if (!['staff', 'parent'].includes(account_type)) return res.status(400).json({ error: 'invalid account_type' });
  const db = getPool();
  try {
    const ok = await lockout.unlock(db, account_type, account_key);
    if (!ok) return res.status(404).json({ error: 'No lockout record for that account' });
    recordAudit({ req, action: 'account_unlocked', entity_type: account_type, meta: { account_type, account_key } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/totp/break-glass — localhost-only emergency TOTP reset for id=1
router.post('/totp/break-glass', async (req, res) => {
  const remoteIp = req.ip || req.socket?.remoteAddress || '';
  const isLocal = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: 'Localhost only' });

  const secret = process.env.WREN_BREAK_GLASS_SECRET;
  if (!secret) return res.status(503).json({ error: 'Break-glass not configured' });
  if (req.headers['x-break-glass'] !== secret) return res.status(403).json({ error: 'Invalid break-glass secret' });

  const db = getPool();
  try {
    await db.query(
      "UPDATE staff SET totp_secret=NULL, totp_verified=false, totp_enrolled_at=NULL, totp_last_used=NULL WHERE id=1"
    );
    await db.query('DELETE FROM totp_recovery_codes WHERE staff_id=1');
    await db.query(
      "INSERT INTO totp_audit(staff_id,event,ip,user_agent) VALUES(1,'break_glass',$1,$2)",
      [req.ip, (req.headers['user-agent']||'').substring(0,200)]
    );
    console.log('[BREAK-GLASS] TOTP reset for Toby (id=1) via break-glass at', new Date().toISOString());
    res.json({ ok: true, message: 'TOTP cleared for id=1 — PIN login now works' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /set-my-pin — staff sets their own PIN (4 or 6 digits)
// Stores pin_length. For id=1 (Toby) also syncs the protected backup so it
// never goes stale (mirrors staff.js set-pin rule).
router.post('/set-my-pin', authenticate, async (req, res) => {
  const pin = req.body && req.body.pin != null ? String(req.body.pin) : '';
  if (!/^\d+$/.test(pin) || (pin.length !== 4 && pin.length !== 6)) {
    return res.status(400).json({ error: 'PIN must be exactly 4 or 6 digits' });
  }
  const db = getPool();
  const client = await db.connect();
  try {
    const hash = await bcrypt.hash(pin, 10);
    await client.query('BEGIN');
    // Schema-unqualified 2026-07-04 (sweep): search_path scopes each edition;
    // demo set-my-pin must never touch production staff.
    const { rows: upd } = await client.query(
      'UPDATE staff SET pin_hash=$1, pin_length=$2, updated_at=NOW() WHERE id=$3 RETURNING first_name, last_name',
      [hash, pin.length, req.user.id]
    );
    if (req.user.id === 1 && upd.length) {
      // Protected-pin dual-write only where the schema has the table (LADN)
      const { rows: reg } = await client.query(
        "SELECT to_regclass('protected_staff_pins') IS NOT NULL AS has_table");
      if (reg[0]?.has_table) {
        const name = `${upd[0].first_name || ''} ${upd[0].last_name || ''}`.trim();
        await client.query(`
          INSERT INTO protected_staff_pins (staff_id, staff_name, pin_hash, updated_at)
          VALUES (1, $1, $2, NOW())
          ON CONFLICT (staff_id) DO UPDATE SET staff_name=$1, pin_hash=$2, updated_at=NOW()
        `, [name, hash]);
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, pin_length: pin.length });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});


// POST /api/auth/demo-login — frictionless role-based auto-login (DEMO_MODE only)
// H3 (2026-06-20): refuse unless the active PG schema is a `demo_*` schema.
// Prevents demo-login from working on production LADN even if DEMO_MODE=true.
router.post('/demo-login', loginLimiter, async (req, res) => {
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(403).json({ error: 'Not a demo environment' });
  }
  const { role } = req.body;
  if (!role) return res.status(400).json({ error: 'role required' });

  const db = getPool();

  // Schema guard: demo-login must only work on demo_* schemas
  try {
    const { rows: schemaRows } = await db.query('SELECT current_schema()');
    const activeSchema = schemaRows[0]?.current_schema || '';
    if (!/^demo_/i.test(activeSchema)) {
      return res.status(403).json({ error: `Demo login refused — active schema is '${activeSchema}' (must be demo_*)` });
    }
  } catch (schemaErr) {
    return res.status(500).json({ error: 'Could not verify schema' });
  }

  // Parent login — issue a parent JWT
  if (role === 'parent') {
    try {
      const { rows } = await db.query(
        `SELECT ppa.*, c.first_name, c.last_name, c.room_id
         FROM parent_portal_access ppa
         JOIN children c ON c.id = ppa.child_id
         WHERE lower(ppa.email) = 'parent@demo.wren' AND ppa.is_active = true
         ORDER BY ppa.id LIMIT 1`
      );
      if (!rows.length) return res.status(404).json({ error: 'No demo parent account found' });
      const rec = rows[0];
      const { rows: kids } = await db.query(
        `SELECT child_id FROM parent_portal_access
         WHERE lower(email) = 'parent@demo.wren' AND is_active = true`
      );
      const token = jwt.sign(
        { id: 0, name: 'Demo Parent', email: rec.email, role: 'parent',
          child_id: rec.child_id, child_ids: kids.map(k => k.child_id),
          room_id: rec.room_id },
        process.env.JWT_SECRET, { expiresIn: '30d', audience: req._portal || 'parents' }
      );
      return res.json({ token, role: 'parent', redirect: '/parent.html' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // Staff roles
  const roleMap = {
    admin:        { dbRoles: ['admin','manager','deputy_manager','headteacher','business_manager'], redirect: '/admin.html' },
    manager:      { dbRoles: ['manager','deputy_manager','admin','headteacher','business_manager'], redirect: '/admin.html' },
    headteacher:  { dbRoles: ['headteacher','manager','deputy_manager','admin'],     redirect: '/admin.html' },
    business_manager: { dbRoles: ['business_manager','manager','admin'],             redirect: '/admin.html' },
    practitioner: { dbRoles: ['practitioner','room_leader'],           redirect: '/index.html' },
    teacher:      { dbRoles: ['teacher','practitioner','room_leader'], redirect: '/index.html' },
    hr:           { dbRoles: ['manager','deputy_manager','admin','business_manager'], redirect: '/hr.html' },
    student:      { dbRoles: ['student'],                              redirect: '/student.html' },
  };
  const mapping = roleMap[role];
  if (!mapping) return res.status(400).json({ error: 'Unknown role: ' + role });

  try {
    // Prefer the canonical demo account (role@demo.wren), fall back to any active staff with that DB role
    const { rows } = await db.query(
      `SELECT * FROM staff
       WHERE is_active = true
         AND (lower(email) = lower($1 || '@demo.wren') OR role = ANY($2::text[]))
       ORDER BY (lower(email) = lower($1 || '@demo.wren')) DESC,
                (role = $3) DESC, id ASC
       LIMIT 1`,
      [role, mapping.dbRoles, mapping.dbRoles[0]]
    );
    if (!rows.length) return res.status(404).json({ error: 'No demo staff for role: ' + role });
    const staff = rows[0];
    const token = jwt.sign(
      { id: staff.id, name: `${staff.first_name} ${staff.last_name}`,
        role: staff.role, room_id: staff.room_id,
        scope: staff.scope || 'all', scope_value: staff.scope_value || null },
      process.env.JWT_SECRET, { expiresIn: '12h', audience: req._portal || 'learning' }
    );
    return res.json({
      token, role: staff.role, redirect: mapping.redirect,
      staff: { id: staff.id, first_name: staff.first_name,
               last_name: staff.last_name, role: staff.role }
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── Refresh token helpers ──────────────────────────────────────────────────

async function issueRefreshToken(db, parentEmail, childId, deviceHint) {
  const raw = crypto.randomBytes(48).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days
  await db.query(
    `INSERT INTO refresh_tokens (token_hash, parent_email, child_id, expires_at, device_hint)
     VALUES ($1,$2,$3,$4,$5)`,
    [hash, parentEmail, childId, expires, (deviceHint||'').substring(0,120)]
  );
  return raw; // only raw token goes to client as cookie
}

// Staff remember-device variant (2026-07-04): same table, staff_id + portal set,
// parent_email NULL. 30 days (shorter than the 90-day parent window).
async function issueStaffRefreshToken(db, staffId, portal, deviceHint) {
  const raw = crypto.randomBytes(48).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO refresh_tokens (token_hash, staff_id, portal, expires_at, device_hint)
     VALUES ($1,$2,$3,$4,$5)`,
    [hash, staffId, portal, expires, (deviceHint||'').substring(0,120)]
  );
  return raw;
}

function setRefreshCookie(res, rawToken) {
  res.cookie('wren_refresh', rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days in ms
    path: '/api/auth'
  });
}

// POST /api/auth/refresh — silently renew JWT using httpOnly refresh cookie
router.post('/refresh', loginLimiter, async (req, res) => {
  const raw = req.cookies?.wren_refresh;
  if (!raw) return res.status(401).json({ error: 'No refresh token' });
  try {
    const db = getPool();
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const { rows } = await db.query(
      `SELECT * FROM refresh_tokens
       WHERE token_hash=$1 AND revoked=false AND expires_at > NOW()`,
      [hash]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    const rt = rows[0];

    // Staff remember-device branch (2026-07-04): rows with staff_id set belong to
    // a trusted staff device — re-mint a normal 12h staff JWT and rotate.
    if (rt.staff_id) {
      const { rows: sRows } = await db.query(
        'SELECT * FROM staff WHERE id=$1 AND is_active=true', [rt.staff_id]);
      if (!sRows.length) {
        await db.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1', [rt.id]);
        return res.status(401).json({ error: 'Account no longer active' });
      }
      const s = sRows[0];
      // b491 review: a remember-device token must not sidestep the lockout or the second factor.
      // Existing tokens for 2FA roles were all minted by PIN-only logins.
      const _lk = await lockout.checkLocked(db, 'staff', s.id, { peek: true });
      if (_lk.locked) return res.status(403).json({ error: 'account_locked', locked_until: _lk.until.toISOString(), message: lockout.formatLockMessage(_lk.until) });
      const _rtPortal = rt.portal || req._portal || 'learning';
      if (_rtPortal !== 'learning' && !(process.env.WREN_TOTP_DISABLED === 'true')
          && (await getTotpRoles(db)).includes(s.role) && s.totp_verified !== true) {
        await db.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1', [rt.id]);
        res.clearCookie('wren_refresh', { path: '/api/auth' });
        return res.status(401).json({ error: 'totp_enrollment_required', message: 'Sign in with your PIN to set up two-factor authentication.' });
      }
      // b480 review F4: accountants sign in with Wren ID only. A remember-device token
      // (only PIN login issues them) must not re-mint a Roost session after a role change.
      if (s.role === 'accountant') {
        await db.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1', [rt.id]);
        res.clearCookie('wren_refresh', { path: '/api/auth' });
        return res.status(401).json({ error: 'wren_id_required', message: 'This account signs in with Wren ID.' });
      }
      const staffToken = jwt.sign(
        { id: s.id, name: `${s.first_name} ${s.last_name}`, role: s.role,
          room_id: s.room_id, scope: s.scope || 'all', scope_value: s.scope_value || null },
        process.env.JWT_SECRET,
        { expiresIn: '12h', audience: rt.portal || req._portal || 'learning' }
      );
      await db.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1', [rt.id]);
      const newStaffRaw = await issueStaffRefreshToken(db, s.id, rt.portal || req._portal || 'learning', req.headers['user-agent']);
      setRefreshCookie(res, newStaffRaw);
      return res.json({ token: staffToken,
        staff: { id: s.id, first_name: s.first_name, last_name: s.last_name, role: s.role, room_id: s.room_id } });
    }

    // sec-20261026: the staff branch above re-checks staff.is_active; this one
    // re-minted a 30-day parent token forever without re-checking that the
    // family still HAS access — a withdrawn parent_portal_access row (e.g. on
    // safeguarding grounds) did not end a remembered session. The test is the
    // same one /cf-auto-login applies to a fresh sign-in, so a refresh can never
    // grant more than signing in again would.
    {
      const _em = String(rt.parent_email || '').toLowerCase().trim();
      const { rows: still } = await db.query(
        `SELECT 1 FROM children c
          WHERE c.id = $2
            AND (((lower(c.parent_1_email)=$1 OR lower(c.parent_2_email)=$1) AND c.is_active=true)
                 OR EXISTS (SELECT 1 FROM parent_portal_access pa
                             WHERE pa.child_id=c.id AND lower(pa.email)=$1 AND pa.is_active=true))
          LIMIT 1`,
        [_em, rt.child_id]);
      if (!still.length) {
        await db.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1', [rt.id]);
        res.clearCookie('wren_refresh', { path: '/api/auth' });
        return res.status(401).json({ error: 'Access no longer active' });
      }
    }
    // Issue new JWT
    const token = jwt.sign(
      { id: 0, name: rt.parent_email, role: 'parent', child_id: rt.child_id },
      process.env.JWT_SECRET,
      { expiresIn: '30d', audience: req._portal || 'parents' }
    );
    // Rotate refresh token (issue new one, revoke old)
    await db.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1', [rt.id]);
    const newRaw = await issueRefreshToken(db, rt.parent_email, rt.child_id, req.headers['user-agent']);
    setRefreshCookie(res, newRaw);
    // 2026-10-29 — with Cloudflare Access gone from the parents host, the wren_parent cookie is
    // what every page authenticates with; a "remember me" refresh that left it unset would send
    // the parent from /login.html to their page and straight back again. Parents host only.
    if (req._portal === 'parents') setParentSessionCookie(req, res, token);
    res.json({ token });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/admin-reset-pin — manager resets another staff member's PIN
router.post('/admin-reset-pin', authenticate, async (req, res) => {
  // b491 review: EY (learning) stays PIN-only for managers, so the controls that turn 2FA off,
  // reset someone's second factor or PIN, or lift a lockout are Roost/HR-only (post-2FA sessions).
  if ((req._portal || 'learning') === 'learning') return res.status(403).json({ error: 'roost_or_hr_only', message: 'Use Roost or HR for account security.' });
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  const { staff_id } = req.body;
  const pin = req.body && req.body.pin != null ? String(req.body.pin) : '';
  if (!/^\d+$/.test(pin) || (pin.length !== 4 && pin.length !== 6)) {
    return res.status(400).json({ error: 'PIN must be exactly 4 or 6 digits' });
  }
  if (Number(staff_id) === 1) return res.status(403).json({ error: 'Owner PIN cannot be reset via admin panel' });
  const hash = await bcrypt.hash(pin, 10);
  const db = getPool();
  // (was hard-coded staff / audit_log — 2026-07-04: schema-unqualified so
  //  demo/HT editions write their own schema, never production)
  const { rowCount } = await db.query(
    'UPDATE staff SET pin_hash=$1, pin_length=$2, updated_at=NOW() WHERE id=$3', [hash, pin.length, staff_id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Staff not found' });
  await db.query(
    "INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, meta) VALUES ('staff',$1,'pin_reset','staff',$2,$3)",
    [req.user.id, staff_id, JSON.stringify({ reset_by: req.user.id })]
  ).catch(() => {});
  res.json({ ok: true });
});

// POST /api/auth/logout-parent — revoke refresh token
router.post('/logout-parent', async (req, res) => {
  const raw = req.cookies?.wren_refresh;
  if (raw) {
    try {
      const db = getPool();
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      await db.query('UPDATE refresh_tokens SET revoked=true WHERE token_hash=$1', [hash]);
    } catch(e) {}
  }
  res.clearCookie('wren_refresh', { path: '/api/auth' });
  clearParentSessionCookie(res);   // b239 — logging out must drop Wren's session too
  res.json({ ok: true });
});

// ── Parent sign-in by email code (2026-10-29) ─────────────────────────────────
// Wren's own version of what Cloudflare Access's email OTP did for the parents
// portal, so families stop holding Cloudflare Zero Trust seats (the free plan
// caps at 50, and parents had used 37 of them). A parent types their address,
// Wren emails a 6-digit code, the code buys exactly the token /cf-auto-login
// mints — same claims, same audience, same cookie — so nothing downstream of
// sign-in changes. Decision + rollback: wren-docs/decisions/2026-10-29-parent-email-code-login.md
//
//   · Nobody can learn whether an address is registered. /request answers every
//     well-formed address the same way, and its per-address limits count every
//     request, known address or not, so even a 429 says nothing.
//   · Only a hash of the code is stored (HMAC over a per-row salt), and only a
//     sha256 of the address — this table never holds an email.
//   · One live code per address: asking again retires the last one. Five wrong
//     tries burn a code, and the b491 persistent lockout (keyed on the address,
//     reserved before the compare) sits on top.
//   · Parents host only. The email carries the code and the nursery's name, nothing else.
const PARENT_CODE_TTL_MIN = 10;
const PARENT_CODE_MAX_TRIES = 5;
const PARENT_CODE_SENT_MSG = "If that address is registered with the nursery, a code is on its way. It can take a minute to arrive.";
const PARENT_CODE_BAD_MSG = "That code isn't right, or it has run out. Check the newest email from us, or ask for a new code.";
const PARENT_CODE_EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const NURSERY_NAME = 'Your Nursery';

function parentCodeIp(req) {
  // Behind the tunnel req.ip is the proxy's address for every family; Cloudflare's own
  // header is the real client. A forged one off the tunnel only dodges this limiter,
  // never the per-address limits or the lockout.
  return String(req.headers['cf-connecting-ip'] || req.ip || 'unknown');
}
const parentCodeRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  keyGenerator: (req) => `pcode-req-${parentCodeIp(req)}`,
  message: { error: 'too_many', message: 'Too many tries from this connection. Please wait a few minutes.' },
  standardHeaders: true, legacyHeaders: false, validate: { keyGeneratorIpFallback: false },
});
const parentCodeVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  keyGenerator: (req) => `pcode-ver-${parentCodeIp(req)}`,
  message: { error: 'too_many', message: 'Too many tries from this connection. Please wait a few minutes.' },
  standardHeaders: true, legacyHeaders: false, validate: { keyGeneratorIpFallback: false },
});

function parentCodeEmail(raw) {
  const e = String(raw || '').toLowerCase().trim();
  return (e.length <= 254 && PARENT_CODE_EMAIL_RE.test(e)) ? e : '';
}
const parentCodeEmailHash = (email) => crypto.createHash('sha256').update(email).digest('hex');
const parentCodeHash = (salt, code) =>
  crypto.createHmac('sha256', `${process.env.JWT_SECRET}:parent-code`).update(`${salt}:${code}`).digest('hex');

let _parentCodeTable = null;
function ensureParentCodeTable(db) {
  if (!_parentCodeTable) {
    _parentCodeTable = db.query(`
      CREATE TABLE IF NOT EXISTS parent_login_codes (
        id          bigserial PRIMARY KEY,
        email_hash  text NOT NULL,
        code_hash   text,
        salt        text NOT NULL,
        sent        boolean NOT NULL DEFAULT false,
        attempts    integer NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now(),
        expires_at  timestamptz NOT NULL,
        used_at     timestamptz,
        burnt_at    timestamptz,
        ip_hash     text
      )`)
      .then(() => db.query('CREATE INDEX IF NOT EXISTS parent_login_codes_email_idx ON parent_login_codes (email_hash, created_at DESC)'))
      .catch((e) => { _parentCodeTable = null; throw e; });
  }
  return _parentCodeTable;
}

// The children a parent address opens — the SAME union /cf-auto-login has always used
// (and src/lib/parent-identity.js confirms against): an active child carrying the address,
// or an active parent_portal_access row (provisional / enquiry families). Siblings included.
async function parentChildrenFor(db, email) {
  const { rows } = await db.query(
    `SELECT c.id, c.first_name, c.last_name, c.room_id FROM children c
     WHERE ((lower(c.parent_1_email)=$1 OR lower(c.parent_2_email)=$1) AND c.is_active=true)
        OR EXISTS (SELECT 1 FROM parent_portal_access pa
                   WHERE pa.child_id=c.id AND lower(pa.email)=$1 AND pa.is_active=true)
     ORDER BY c.is_active DESC, c.id`,
    [email]
  );
  return rows;
}

async function sendParentCode(email, code) {
  const { sendViaGmail } = require('../lib/gmail-sender');
  const text = `Your sign-in code for the ${NURSERY_NAME} parents app is:\n\n${code}\n\n`
    + `It works for ${PARENT_CODE_TTL_MIN} minutes. If you didn't ask for it, you can ignore this email: `
    + `nobody can sign in without the code.\n\n${NURSERY_NAME}\n`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5">`  // colour-ok: email body, not a themed portal page
    + `<p>Your sign-in code for the ${NURSERY_NAME} parents app is:</p>`
    + `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p>`
    + `<p>It works for ${PARENT_CODE_TTL_MIN} minutes. If you didn't ask for it, you can ignore this email: nobody can sign in without the code.</p>`
    + `<p>${NURSERY_NAME}</p></div>`;
  return sendViaGmail({ to: email, subject: `${code} is your ${NURSERY_NAME} sign-in code`, text, html, fromName: NURSERY_NAME });
}

// POST /api/auth/parent-code/request { email } — always the same answer for a well-formed address.
router.post('/parent-code/request', parentCodeRequestLimiter, async (req, res) => {
  if (req._portal !== 'parents') return res.status(404).json({ error: 'Not found' });
  const email = parentCodeEmail(req.body && req.body.email);
  if (!email) return res.status(400).json({ error: 'bad_email', message: 'Please enter your email address.' });
  const db = getPool();
  let client;
  try {
    await ensureParentCodeTable(db);
    const eh = parentCodeEmailHash(email);
    client = await db.connect();
    await client.query('BEGIN');
    // Serialise requests for one address so two taps cannot both pass the limit.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['parent-code:' + eh]);
    const { rows: [lim] } = await client.query(
      `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 minute')::int AS last_min,
              count(*)::int AS last_hour
         FROM parent_login_codes WHERE email_hash=$1 AND created_at > now() - interval '1 hour'`, [eh]);
    if (lim.last_min >= 1 || lim.last_hour >= 5) {
      await client.query('ROLLBACK');
      client.release(); client = null;
      const wait = lim.last_min >= 1 ? 60 : 3600;
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: 'too_many', retry_after: wait,
        message: wait === 60 ? 'Please wait a minute before asking for another code.'
                             : 'Too many codes asked for this address. Please try again in an hour, or use the newest code you have.' });
    }
    const known = (await parentChildrenFor(client, email)).length > 0;
    const lk = await lockout.checkLocked(client, 'parent', email, { peek: true });
    const willSend = known && !lk.locked;
    const code = willSend ? String(crypto.randomInt(0, 1000000)).padStart(6, '0') : null;
    const salt = crypto.randomBytes(16).toString('hex');
    const { rows: [row] } = await client.query(
      `INSERT INTO parent_login_codes (email_hash, code_hash, salt, sent, expires_at, ip_hash)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6) RETURNING id`,
      [eh, code ? parentCodeHash(salt, code) : null, salt, willSend, PARENT_CODE_TTL_MIN,
       crypto.createHash('sha256').update(parentCodeIp(req)).digest('hex').slice(0, 16)]);
    // One live code per address: a new request retires every earlier one.
    await client.query(
      `UPDATE parent_login_codes SET burnt_at=now()
        WHERE email_hash=$1 AND id<>$2 AND used_at IS NULL AND burnt_at IS NULL`, [eh, row.id]);
    await client.query('COMMIT');
    client.release(); client = null;
    // Sent after the answer, so how long the answer takes says nothing about the address either.
    if (willSend) setImmediate(() => sendParentCode(email, code).catch((e) => console.error('[parent-code] send failed:', e.message)));
    return res.json({ ok: true, message: PARENT_CODE_SENT_MSG, expires_in_min: PARENT_CODE_TTL_MIN });
  } catch (e) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
    console.error('[parent-code] request error:', e.message);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/parent-code/verify { email, code } — on success, the /cf-auto-login token and cookies.
router.post('/parent-code/verify', parentCodeVerifyLimiter, async (req, res) => {
  if (req._portal !== 'parents') return res.status(404).json({ error: 'Not found' });
  const email = parentCodeEmail(req.body && req.body.email);
  const code = String((req.body && req.body.code) || '').replace(/\s+/g, '');
  if (!email || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'bad_input', message: 'Enter the 6-digit code from the email.' });
  }
  const db = getPool();
  let client;
  try {
    await ensureParentCodeTable(db);
    // b491 lockout, reserved before anything is compared — for every address, known or not,
    // so a lock is no clue that an address is registered.
    const lockState = await lockout.checkLocked(db, 'parent', email);
    if (lockState.locked) {
      return res.status(403).json({ error: 'account_locked', locked_until: lockState.until.toISOString(), message: lockout.formatLockMessage(lockState.until) });
    }
    const eh = parentCodeEmailHash(email);
    client = await db.connect();
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      `SELECT id, code_hash, salt, attempts FROM parent_login_codes
        WHERE email_hash=$1 AND sent AND code_hash IS NOT NULL
          AND used_at IS NULL AND burnt_at IS NULL AND expires_at > now()
        ORDER BY id DESC LIMIT 1 FOR UPDATE`, [eh]);
    let ok = false;
    if (row) {
      const a = Buffer.from(parentCodeHash(row.salt, code), 'hex');
      const b = Buffer.from(String(row.code_hash), 'hex');
      ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (ok) {
        await client.query('UPDATE parent_login_codes SET used_at=now(), attempts=attempts+1 WHERE id=$1', [row.id]);
      } else {
        await client.query(
          `UPDATE parent_login_codes SET attempts=attempts+1,
                  burnt_at = CASE WHEN attempts+1 >= $2 THEN now() ELSE burnt_at END
            WHERE id=$1`, [row.id, PARENT_CODE_MAX_TRIES]);
      }
    }
    await client.query('COMMIT');
    client.release(); client = null;

    if (!ok) {
      const fail = await lockout.recordFailure(db, 'parent', email, { req, label: 'parent portal (email code)' });
      if (fail.locked) {
        return res.status(403).json({ error: 'account_locked', locked_until: fail.until.toISOString(), message: lockout.formatLockMessage(fail.until) });
      }
      return res.status(400).json({ error: 'bad_code', message: PARENT_CODE_BAD_MSG });
    }
    await lockout.recordSuccess(db, 'parent', email);

    // Access is re-read now, not taken from when the code was sent.
    const rows = await parentChildrenFor(db, email);
    if (!rows.length) return res.status(400).json({ error: 'bad_code', message: PARENT_CODE_BAD_MSG });
    const child = rows[0];
    const token = jwt.sign(
      { id: 0, name: email, role: 'parent', child_id: child.id, child_ids: rows.map(r => r.id), room_id: child.room_id },
      process.env.JWT_SECRET,
      { expiresIn: '30d', audience: req._portal || 'parents' }
    );
    const rawRefresh = await issueRefreshToken(db, email, child.id, req.headers['user-agent']);
    setRefreshCookie(res, rawRefresh);
    setParentSessionCookie(req, res, token);
    db.query('UPDATE parent_portal_access SET last_login=now() WHERE lower(email)=$1 AND is_active=true', [email]).catch(() => {});
    recordAudit({ req, action: 'parent_code_login', entity_type: 'parent_portal_access', actor_type: 'parent', actor_email: email });
    let enquiryMode = false;
    try { enquiryMode = await require('../lib/enquiry-access').isEnquiryModeEmail(db, email); } catch (_) {}
    return res.json({ token, child, children: rows, enquiry_mode: enquiryMode });
  } catch (e) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
    console.error('[parent-code] verify error:', e.message);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
