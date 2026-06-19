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

// Roles that require TOTP when enrolled
const TOTP_ROLES = ['manager', 'deputy', 'admin'];

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
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public: minimal staff info for PIN selector — id, initials, photo only (no PII)
router.get('/staff-list', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT s.id,
             s.first_name,
             s.last_name,
             s.preferred_name,
             s.role,
             COALESCE(s.pin_length, 4) AS pin_length,
             LEFT(s.first_name, 1) || LEFT(COALESCE(s.last_name, ''), 1) as initials,
             s.profile_photo
      FROM staff s
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
      const { rows } = await db.query('SELECT * FROM staff WHERE email=$1 AND is_active=true', [email]);
      const staffRow = rows[0];
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
      const { rows } = await db.query(
        'SELECT * FROM staff WHERE email=$1 AND is_active=true', [email]
      );
      staffRow = rows[0];
    }

    if (!staffRow) {
      recordAudit({ req, action: 'login', entity_type: 'staff', actor_type: 'anonymous', meta: { success: false, reason: 'staff_not_found', staff_id, email } });
      return res.status(401).json({ error: 'Staff not found' });
    }
    if (!staffRow.pin_hash) {
      recordAudit({ req, action: 'login', entity_type: 'staff', entity_id: staffRow.id, actor_id: staffRow.id, actor_type: 'anonymous', meta: { success: false, reason: 'pin_not_set' } });
      return res.status(401).json({ error: 'PIN not set' });
    }

    const valid = await bcrypt.compare(pin, staffRow.pin_hash);
    if (!valid) {
      recordAudit({ req, action: 'login', entity_type: 'staff', entity_id: staffRow.id, actor_id: staffRow.id, actor_type: 'anonymous', meta: { success: false, reason: 'wrong_pin' } });
      return res.status(401).json({ error: 'Incorrect PIN' });
    }

    // ── TOTP gate ─────────────────────────────────────────────────────────────
    const totpDisabled = process.env.WREN_TOTP_DISABLED === 'true';
    const graceUntil = process.env.TOTP_GRACE_UNTIL ? new Date(process.env.TOTP_GRACE_UNTIL) : null;
    const inGrace = graceUntil && new Date() < graceUntil;
    const needsTotp = !totpDisabled
      && TOTP_ROLES.includes(staffRow.role)
      && staffRow.totp_verified === true
      && !inGrace;

    if (needsTotp) {
      const challengeToken = jwt.sign(
        { id: staffRow.id, role: staffRow.role, scope: 'totp_only' },
        process.env.JWT_SECRET,
        { expiresIn: '5m', audience: req._portal || 'learning' }
      );
      return res.json({ requires_totp: true, challenge_token: challengeToken });
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

    // Check password_hash if set; fallback to token_hash for backwards compat
    const hashToCheck = rec.password_hash || rec.token_hash;
    if (!hashToCheck) return res.status(401).json({ error: 'Account not set up for password login' });
    const valid = await bcrypt.compare(password, hashToCheck);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

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
      { expiresIn: '12h', audience: req._portal || 'parents' }
    );
    db.query('UPDATE parent_portal_access SET last_login=now() WHERE email=$1', [email.toLowerCase()]).catch(() => {});
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
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /cf-auto-login — reads CF Access header, issues parent JWT automatically
router.get('/cf-auto-login', loginLimiter, async (req, res) => {
  const cfEmail = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!cfEmail) {
    return res.status(403).json({ error: 'No Cloudflare Access session. Access this portal via parents.example.com' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, room_id FROM children
       WHERE (lower(parent_1_email)=$1 OR lower(parent_2_email)=$1) AND is_active=true
       ORDER BY id LIMIT 1`,
      [cfEmail]
    );
    if (!rows.length) return res.status(401).json({ error: 'no_child' });
    const child = rows[0];
    const token = jwt.sign(
      { id: 0, name: cfEmail, role: 'parent', child_id: child.id, room_id: child.room_id },
      process.env.JWT_SECRET,
      { expiresIn: '8h', audience: req._portal || 'parents' }
    );
    const rawRefresh = await issueRefreshToken(db, cfEmail, child.id, req.headers['user-agent']);
    setRefreshCookie(res, rawRefresh);
    res.json({ token, child });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /parent-login — email-based login for parents (local dev/testing fallback)
// Security: Cloudflare Access OTP injects Cf-Access-Authenticated-User-Email header.
// We verify the submitted email matches the CF-verified email so a parent
// cannot log in as another parent even if they know their email address.
router.post('/parent-login', loginLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  // CF Access verification — mandatory, no fallback
  const cfEmail = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!cfEmail) {
    return res.status(403).json({ error: 'This portal requires Cloudflare Access verification. Please access via parents.example.com' });
  }
  if (cfEmail !== email.toLowerCase().trim()) {
    return res.status(403).json({ error: 'Email does not match your verified session. Please use the email you signed in with.' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, room_id FROM children
       WHERE (lower(parent_1_email)=lower($1) OR lower(parent_2_email)=lower($1))
         AND is_active=true LIMIT 1`,
      [email]
    );
    if (!rows.length) return res.status(401).json({ error: 'No child found for this email' });
    const child = rows[0];
    const token = jwt.sign(
      { id: 0, name: email, role: 'parent', child_id: child.id, room_id: child.room_id },
      process.env.JWT_SECRET,
      { expiresIn: '1h', audience: req._portal || 'parents' }
    );
    const rawRefresh = await issueRefreshToken(db, cfEmail, child.id, req.headers['user-agent']);
    setRefreshCookie(res, rawRefresh);
    res.json({ token, child });
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
      'SELECT id, first_name, last_name, role, room_id, profile_photo, scope, scope_value, totp_secret, totp_verified, totp_last_used FROM ladn.staff WHERE id=$1 AND is_active=true',
      [decoded.id]
    );
    if (!rows.length) return res.status(401).json({ error: 'Staff not found' });
    const staffRow = rows[0];

    const currentWin = totp.currentWindow();
    let authMethod = null;

    // Try TOTP code
    if (/^\d{6}$/.test(code)) {
      if (totp.verify(code, staffRow.totp_secret)) {
        if (staffRow.totp_last_used === currentWin) {
          await db.query("INSERT INTO ladn.totp_audit(staff_id,event,ip,user_agent) VALUES($1,'failed',$2,$3)",
            [staffRow.id, req.ip, (req.headers['user-agent']||'').substring(0,200)]);
          return res.status(401).json({ error: 'Code already used — wait for the next code' });
        }
        authMethod = 'used';
      }
    } else {
      // Try recovery code
      const cleanCode = code.trim().toUpperCase();
      const { rows: recs } = await db.query(
        'SELECT id, code_hash FROM ladn.totp_recovery_codes WHERE staff_id=$1 AND used_at IS NULL',
        [staffRow.id]
      );
      for (const rec of recs) {
        if (await totp.compareCode(cleanCode, rec.code_hash)) {
          await db.query('UPDATE ladn.totp_recovery_codes SET used_at=now() WHERE id=$1', [rec.id]);
          authMethod = 'recovery_used';
          break;
        }
      }
    }

    if (!authMethod) {
      await db.query("INSERT INTO ladn.totp_audit(staff_id,event,ip,user_agent) VALUES($1,'failed',$2,$3)",
        [staffRow.id, req.ip, (req.headers['user-agent']||'').substring(0,200)]);
      return res.status(401).json({ error: 'Invalid code' });
    }

    // Update last used window (replay prevention)
    if (authMethod === 'used') {
      await db.query('UPDATE ladn.staff SET totp_last_used=$1 WHERE id=$2', [currentWin, staffRow.id]);
    }
    await db.query("INSERT INTO ladn.totp_audit(staff_id,event,ip,user_agent) VALUES($1,$2,$3,$4)",
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
    db.query('UPDATE ladn.staff SET last_login_at=now() WHERE id=$1', [staffRow.id]).catch(() => {});

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
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT id, email, first_name, last_name FROM ladn.staff WHERE id=$1 AND is_active=true',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    const staffRow = rows[0];
    const secret = totp.generateSecret();
    const accountName = staffRow.email || `${staffRow.first_name}.${staffRow.last_name}@wren`;
    const otpauthUrl = totp.buildOtpauthUrl(secret, accountName);
    const qrDataUrl = await totp.buildQrDataUrl(otpauthUrl);

    await db.query(
      'UPDATE ladn.staff SET totp_secret=$1, totp_verified=false, totp_enrolled_at=NULL WHERE id=$2',
      [secret, req.user.id]
    );
    res.json({ otpauth_url: otpauthUrl, qr_data_url: qrDataUrl, secret });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/totp/enroll/verify — confirm first valid code, issue recovery codes
router.post('/totp/enroll/verify', authenticate, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT totp_secret, totp_verified FROM ladn.staff WHERE id=$1 AND is_active=true',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    const staffRow = rows[0];
    if (!staffRow.totp_secret) return res.status(400).json({ error: 'Enrolment not started — call /enroll/start first' });
    if (!totp.verify(code, staffRow.totp_secret)) {
      await db.query("INSERT INTO ladn.totp_audit(staff_id,event,ip,user_agent) VALUES($1,'failed',$2,$3)",
        [req.user.id, req.ip, (req.headers['user-agent']||'').substring(0,200)]);
      return res.status(401).json({ error: 'Invalid code' });
    }

    // Generate and store recovery codes
    const plainCodes = totp.generateRecoveryCodes(10);
    await db.query('DELETE FROM ladn.totp_recovery_codes WHERE staff_id=$1', [req.user.id]);
    for (const code of plainCodes) {
      const hash = await totp.hashCode(code);
      await db.query('INSERT INTO ladn.totp_recovery_codes(staff_id,code_hash) VALUES($1,$2)', [req.user.id, hash]);
    }

    await db.query(
      "UPDATE ladn.staff SET totp_verified=true, totp_enrolled_at=now(), totp_last_used=NULL WHERE id=$1",
      [req.user.id]
    );
    await db.query("INSERT INTO ladn.totp_audit(staff_id,event,ip,user_agent) VALUES($1,'enrolled',$2,$3)",
      [req.user.id, req.ip, (req.headers['user-agent']||'').substring(0,200)]);

    res.json({ ok: true, recovery_codes: plainCodes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/totp/recovery/regenerate — replace all unused recovery codes
router.post('/totp/recovery/regenerate', authenticate, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT totp_verified FROM ladn.staff WHERE id=$1 AND is_active=true', [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    if (!rows[0].totp_verified) return res.status(400).json({ error: 'TOTP not enrolled' });

    const plainCodes = totp.generateRecoveryCodes(10);
    await db.query('DELETE FROM ladn.totp_recovery_codes WHERE staff_id=$1 AND used_at IS NULL', [req.user.id]);
    for (const code of plainCodes) {
      const hash = await totp.hashCode(code);
      await db.query('INSERT INTO ladn.totp_recovery_codes(staff_id,code_hash) VALUES($1,$2)', [req.user.id, hash]);
    }
    await db.query("INSERT INTO ladn.totp_audit(staff_id,event,ip,user_agent) VALUES($1,'recovery_regenerated',$2,$3)",
      [req.user.id, req.ip, (req.headers['user-agent']||'').substring(0,200)]);

    res.json({ ok: true, recovery_codes: plainCodes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/totp/reset — manager resets another staff member's TOTP
router.post('/totp/reset', authenticate, async (req, res) => {
  const { target_staff_id } = req.body;
  if (!target_staff_id) return res.status(400).json({ error: 'target_staff_id required' });
  if (!TOTP_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Manager+ only' });

  // Safety: cannot self-reset Toby (id=1) — he must use break-glass
  if (target_staff_id == 1 && req.user.id !== 1) {
    return res.status(403).json({ error: 'Cannot reset manager id=1 via this endpoint — use break-glass procedure' });
  }

  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT id, first_name, last_name FROM ladn.staff WHERE id=$1 AND is_active=true', [target_staff_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });

    await db.query(
      "UPDATE ladn.staff SET totp_secret=NULL, totp_verified=false, totp_enrolled_at=NULL, totp_last_used=NULL WHERE id=$1",
      [target_staff_id]
    );
    await db.query('DELETE FROM ladn.totp_recovery_codes WHERE staff_id=$1', [target_staff_id]);
    await db.query(
      "INSERT INTO ladn.totp_audit(staff_id,event,ip,user_agent) VALUES($1,'reset',$2,$3)",
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
      'SELECT totp_verified, totp_enrolled_at FROM ladn.staff WHERE id=$1', [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { rows: recs } = await db.query(
      'SELECT COUNT(*)::int as remaining FROM ladn.totp_recovery_codes WHERE staff_id=$1 AND used_at IS NULL',
      [req.user.id]
    );
    res.json({
      enrolled: rows[0].totp_verified,
      enrolled_at: rows[0].totp_enrolled_at,
      recovery_codes_remaining: recs[0].remaining,
      totp_required: TOTP_ROLES.includes(req.user.role),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/totp/users — manager: list all TOTP-role staff with enrolment status
router.get('/totp/users', authenticate, async (req, res) => {
  if (!TOTP_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Manager+ only' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, email, role, totp_verified, totp_enrolled_at
       FROM ladn.staff WHERE role = ANY($1) AND is_active=true ORDER BY id`,
      [TOTP_ROLES]
    );
    res.json(rows);
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
      "UPDATE ladn.staff SET totp_secret=NULL, totp_verified=false, totp_enrolled_at=NULL, totp_last_used=NULL WHERE id=1"
    );
    await db.query('DELETE FROM ladn.totp_recovery_codes WHERE staff_id=1');
    await db.query(
      "INSERT INTO ladn.totp_audit(staff_id,event,ip,user_agent) VALUES(1,'break_glass',$1,$2)",
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
    const { rows: upd } = await client.query(
      'UPDATE ladn.staff SET pin_hash=$1, pin_length=$2, updated_at=NOW() WHERE id=$3 RETURNING first_name, last_name',
      [hash, pin.length, req.user.id]
    );
    if (req.user.id === 1 && upd.length) {
      const name = `${upd[0].first_name || ''} ${upd[0].last_name || ''}`.trim();
      await client.query(`
        INSERT INTO ladn.protected_staff_pins (staff_id, staff_name, pin_hash, updated_at)
        VALUES (1, $1, $2, NOW())
        ON CONFLICT (staff_id) DO UPDATE SET staff_name=$1, pin_hash=$2, updated_at=NOW()
      `, [name, hash]);
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
router.post('/demo-login', loginLimiter, async (req, res) => {
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(403).json({ error: 'Not a demo environment' });
  }
  const { role } = req.body;
  if (!role) return res.status(400).json({ error: 'role required' });

  const db = getPool();

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
        process.env.JWT_SECRET, { expiresIn: '12h', audience: req._portal || 'parents' }
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
    // Issue new JWT
    const token = jwt.sign(
      { id: 0, name: rt.parent_email, role: 'parent', child_id: rt.child_id },
      process.env.JWT_SECRET,
      { expiresIn: '8h', audience: req._portal || 'parents' }
    );
    // Rotate refresh token (issue new one, revoke old)
    await db.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1', [rt.id]);
    const newRaw = await issueRefreshToken(db, rt.parent_email, rt.child_id, req.headers['user-agent']);
    setRefreshCookie(res, newRaw);
    res.json({ token });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/admin-reset-pin — manager resets another staff member's PIN
router.post('/admin-reset-pin', authenticate, async (req, res) => {
  if (!['manager', 'deputy_manager'].includes(req.user?.role)) {
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
  const { rowCount } = await db.query(
    'UPDATE ladn.staff SET pin_hash=$1, pin_length=$2, updated_at=NOW() WHERE id=$3', [hash, pin.length, staff_id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Staff not found' });
  await db.query(
    "INSERT INTO ladn.audit_log (actor_type, actor_id, action, entity_type, entity_id, meta) VALUES ('staff',$1,'pin_reset','staff',$2,$3)",
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
  res.json({ ok: true });
});

module.exports = router;
