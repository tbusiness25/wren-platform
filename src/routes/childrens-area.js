// Children's Area — parent auth + child PIN sessions + all child-facing data
// Mounted at /api/childrens-area in primary server.js
const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const crypto  = require('crypto');

const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT || '5432'),
  user:     process.env.PG_USER     || 'wren',
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || 'wren',
  max: 5,
});

const s = () => process.env.PG_SCHEMA || 'demo_primary';

// ── Crypto helpers ────────────────────────────────────────────────────────────
const SALT = () => process.env.JWT_SECRET || 'wren-children-area-default-salt';
const hashPin   = (pin)   => crypto.createHash('sha256').update(String(pin) + SALT()).digest('hex');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const genToken  = ()      => crypto.randomBytes(32).toString('hex');

// ── Parent auth middleware ────────────────────────────────────────────────────
// Validates x-parent-token header; injects req.parentEmail
async function requireParent(req, res, next) {
  const raw = req.headers['x-parent-token'];
  if (!raw) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const th = hashToken(raw);
    const { rows } = await pool.query(
      `SELECT email FROM ${s()}.parent_portal_access WHERE token_hash=$1 AND is_active=true LIMIT 1`,
      [th]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid session' });
    req.parentEmail = rows[0].email;
    next();
  } catch (e) {
    console.error('[children-area] parent auth:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
}

// ── Child session middleware ──────────────────────────────────────────────────
// Validates x-child-session header; injects req.childSession {id, parent_email, child_id}
// Also rolls the 30-min expiry window on every call.
async function requireChildSession(req, res, next) {
  const raw = req.headers['x-child-session'];
  if (!raw) return res.status(401).json({ error: 'Child session required' });
  try {
    const th = hashToken(raw);
    const { rows } = await pool.query(
      `SELECT id, parent_email, child_id FROM ${s()}.child_sessions
       WHERE session_token_hash=$1 AND expires_at > now()`,
      [th]
    );
    if (!rows.length) return res.status(401).json({ error: 'Session expired', code: 'SESSION_EXPIRED' });
    await pool.query(
      `UPDATE ${s()}.child_sessions
       SET last_active_at=now(), expires_at=now()+interval '30 minutes' WHERE id=$1`,
      [rows[0].id]
    );
    req.childSession = rows[0];
    next();
  } catch (e) {
    console.error('[children-area] child session auth:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
}

// ── POST /api/childrens-area/parent-login ─────────────────────────────────────
// Demo parent login: email must exist in parent_portal_access.
// Issues a fresh token on each login (previous token invalidated).
router.post('/parent-login', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const norm = email.toLowerCase().trim();
  try {
    const { rows } = await pool.query(
      `SELECT id FROM ${s()}.parent_portal_access WHERE lower(email)=$1 AND is_active=true LIMIT 1`,
      [norm]
    );
    if (!rows.length) return res.status(404).json({ error: 'Email not recognised' });
    const token = genToken();
    const th    = hashToken(token);
    await pool.query(
      `UPDATE ${s()}.parent_portal_access SET token_hash=$1, last_login=now() WHERE lower(email)=$2`,
      [th, norm]
    );
    res.json({ token });
  } catch (e) {
    console.error('[children-area] parent-login:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /api/childrens-area/children ─────────────────────────────────────────
// Returns children linked to this parent, with PIN-set status.
router.get('/children', requireParent, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ch.id, ch.first_name, ch.last_name, ch.photo_url, ch.year_group,
             EXISTS(
               SELECT 1 FROM ${s()}.child_pins cp
               WHERE cp.parent_email=$1 AND cp.child_id=ch.id
             ) AS has_pin
      FROM ${s()}.parent_portal_access pa
      JOIN ${s()}.children ch ON ch.id=pa.child_id
      WHERE lower(pa.email)=$1 AND pa.is_active=true
      ORDER BY ch.first_name
    `, [req.parentEmail]);
    res.json(rows);
  } catch (e) {
    console.error('[children-area] children:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /api/childrens-area/pin-setup ───────────────────────────────────────
// Parent sets or changes the child PIN. Resets any active lockout.
router.post('/pin-setup', requireParent, async (req, res) => {
  const { child_id, pin } = req.body || {};
  if (!child_id || !pin) return res.status(400).json({ error: 'child_id and pin required' });
  if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
  try {
    // Confirm this child belongs to this parent
    const { rows: access } = await pool.query(
      `SELECT 1 FROM ${s()}.parent_portal_access
       WHERE lower(email)=$1 AND child_id=$2 AND is_active=true LIMIT 1`,
      [req.parentEmail, child_id]
    );
    if (!access.length) return res.status(403).json({ error: 'Access denied' });

    const ph = hashPin(pin);
    await pool.query(`
      INSERT INTO ${s()}.child_pins (parent_email, child_id, pin_hash, updated_at)
      VALUES ($1,$2,$3,now())
      ON CONFLICT (parent_email, child_id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash, updated_at=now()
    `, [req.parentEmail, child_id, ph]);

    // Clear any lockout when parent resets PIN
    await pool.query(
      `DELETE FROM ${s()}.child_pin_lockouts WHERE parent_email=$1 AND child_id=$2`,
      [req.parentEmail, child_id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[children-area] pin-setup:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /api/childrens-area/pin-verify ──────────────────────────────────────
// Child enters PIN → issues child session token on success.
// Wrong PIN 5× → 5-minute lockout.
router.post('/pin-verify', requireParent, async (req, res) => {
  const { child_id, pin } = req.body || {};
  if (!child_id || !pin) return res.status(400).json({ error: 'child_id and pin required' });
  try {
    // Check lockout first
    const { rows: lockRows } = await pool.query(
      `SELECT fail_count, locked_until FROM ${s()}.child_pin_lockouts
       WHERE parent_email=$1 AND child_id=$2`,
      [req.parentEmail, child_id]
    );
    if (lockRows.length && lockRows[0].locked_until && new Date(lockRows[0].locked_until) > new Date()) {
      const secs = Math.ceil((new Date(lockRows[0].locked_until) - Date.now()) / 1000);
      return res.status(429).json({ error: 'Locked out', retry_after_seconds: secs });
    }

    // Fetch stored PIN
    const { rows: pinRows } = await pool.query(
      `SELECT pin_hash FROM ${s()}.child_pins WHERE parent_email=$1 AND child_id=$2`,
      [req.parentEmail, child_id]
    );
    if (!pinRows.length) return res.status(404).json({ error: 'No PIN set for this child' });

    if (hashPin(pin) !== pinRows[0].pin_hash) {
      // Record failure
      await pool.query(`
        INSERT INTO ${s()}.child_pin_lockouts (parent_email, child_id, fail_count, locked_until, updated_at)
        VALUES ($1,$2,1,NULL,now())
        ON CONFLICT (parent_email, child_id) DO UPDATE
          SET fail_count   = child_pin_lockouts.fail_count + 1,
              locked_until = CASE WHEN child_pin_lockouts.fail_count + 1 >= 5
                               THEN now() + interval '5 minutes' ELSE NULL END,
              updated_at   = now()
      `, [req.parentEmail, child_id]);

      const { rows: lk } = await pool.query(
        `SELECT fail_count, locked_until FROM ${s()}.child_pin_lockouts
         WHERE parent_email=$1 AND child_id=$2`,
        [req.parentEmail, child_id]
      );
      const fc     = lk[0]?.fail_count || 1;
      const locked = !!(lk[0]?.locked_until);
      return res.status(401).json({
        error: 'Wrong PIN',
        attempts_remaining: Math.max(0, 5 - fc),
        locked,
      });
    }

    // PIN correct — clear lockout, create session
    await pool.query(
      `DELETE FROM ${s()}.child_pin_lockouts WHERE parent_email=$1 AND child_id=$2`,
      [req.parentEmail, child_id]
    );
    // Invalidate any previous session for this child+parent
    await pool.query(
      `DELETE FROM ${s()}.child_sessions WHERE parent_email=$1 AND child_id=$2`,
      [req.parentEmail, child_id]
    );

    const sessionToken = genToken();
    const sessionTH    = hashToken(sessionToken);
    const { rows: [cs] } = await pool.query(`
      INSERT INTO ${s()}.child_sessions (parent_email, child_id, session_token_hash)
      VALUES ($1,$2,$3) RETURNING id
    `, [req.parentEmail, child_id, sessionTH]);

    await pool.query(`
      INSERT INTO ${s()}.child_audit_events (child_session_id, parent_email, child_id, event_type)
      VALUES ($1,$2,$3,'session_start')
    `, [cs.id, req.parentEmail, child_id]);

    res.json({ session_token: sessionToken, expires_in_seconds: 1800 });
  } catch (e) {
    console.error('[children-area] pin-verify:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /api/childrens-area/session ──────────────────────────────────────────
// Returns child info for active session.
router.get('/session', requireChildSession, async (req, res) => {
  const { child_id } = req.childSession;
  try {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, photo_url, year_group FROM ${s()}.children WHERE id=$1`,
      [child_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Child not found' });
    res.json({ child: rows[0], expires_in_seconds: 1800 });
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /api/childrens-area/points ───────────────────────────────────────────
// Child's own positive awards feed + all-time and week totals.
router.get('/points', requireChildSession, async (req, res) => {
  const { child_id } = req.childSession;
  const limit = Math.min(parseInt(req.query.limit || '50'), 100);
  try {
    const { rows: feed } = await pool.query(`
      SELECT a.id, a.awarded_at, a.value, a.reason_text,
             cat.name AS category_name, cat.icon AS category_icon,
             CONCAT(st.first_name, ' ', st.last_name) AS awarded_by_name
      FROM ${s()}.wp_awards a
      JOIN ${s()}.wp_categories cat ON cat.id=a.category_id
      LEFT JOIN ${s()}.staff st ON st.id=a.awarded_by_staff_id
      WHERE a.child_id=$1 AND a.value>0
      ORDER BY a.awarded_at DESC
      LIMIT $2
    `, [child_id, limit]);

    const { rows: [totals] } = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN value>0 THEN value END),0)::int AS all_time_total,
        COALESCE(SUM(CASE WHEN value>0 AND awarded_at>=date_trunc('week',now()) THEN value END),0)::int AS week_total
      FROM ${s()}.wp_awards WHERE child_id=$1
    `, [child_id]);

    res.json({ feed, totals });
  } catch (e) {
    console.error('[children-area] points:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /api/childrens-area/homework ─────────────────────────────────────────
// Homework for the child's year group, with submission status.
router.get('/homework', requireChildSession, async (req, res) => {
  const { child_id } = req.childSession;
  try {
    const { rows: [child] } = await pool.query(
      `SELECT class_group FROM ${s()}.children WHERE id=$1`, [child_id]
    );
    if (!child) return res.json([]);

    // Join via class name (children.class_group matches classes.name).
    // Also include homework with no class_id (school-wide homework).
    const { rows } = await pool.query(`
      SELECT h.id, h.title, h.description, h.due_date, h.type,
             h.estimated_duration_minutes, h.external_resource_url,
             h.attachment_paths, h.quiz_questions,
             sub.name AS subject_name,
             hs.id AS submission_id, hs.completed_at, hs.answers_json,
             hs.teacher_feedback, hs.grade
      FROM ${s()}.homework h
      LEFT JOIN ${s()}.subjects sub ON sub.id=h.subject_id
      LEFT JOIN ${s()}.classes  cls ON cls.id=h.class_id
      LEFT JOIN ${s()}.homework_submissions hs
        ON hs.homework_id=h.id AND hs.pupil_id=$1
      WHERE h.is_published=true
        AND (h.class_id IS NULL OR cls.name=$2)
      ORDER BY hs.completed_at IS NULL DESC, h.due_date ASC NULLS LAST, h.set_at DESC
      LIMIT 30
    `, [child_id, child.class_group]);
    res.json(rows);
  } catch (e) {
    console.error('[children-area] homework:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /api/childrens-area/homework/:id/submit ──────────────────────────────
// Child submits a homework (quiz answers or free text).
router.post('/homework/:id/submit', requireChildSession, async (req, res) => {
  const hwId = parseInt(req.params.id);
  if (!hwId) return res.status(400).json({ error: 'Invalid homework id' });
  const { answers_json, content } = req.body || {};
  const { child_id, id: sessionId, parent_email } = req.childSession;
  try {
    await pool.query(`
      INSERT INTO ${s()}.homework_submissions
        (homework_id, pupil_id, completed_at, content, parent_acknowledged, answers_json, child_session_id)
      VALUES ($1,$2,now(),$3,true,$4,$5)
      ON CONFLICT (homework_id, pupil_id) DO UPDATE
        SET completed_at=now(), content=EXCLUDED.content,
            answers_json=EXCLUDED.answers_json, child_session_id=EXCLUDED.child_session_id
    `, [hwId, child_id, content || null, answers_json ? JSON.stringify(answers_json) : null, sessionId]);

    await pool.query(`
      INSERT INTO ${s()}.child_audit_events
        (child_session_id, parent_email, child_id, event_type, event_data)
      VALUES ($1,$2,$3,'homework_submitted',$4::jsonb)
    `, [sessionId, parent_email, child_id, JSON.stringify({ homework_id: hwId })]);

    res.json({ ok: true });
  } catch (e) {
    console.error('[children-area] homework submit:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /api/childrens-area/reading-log ──────────────────────────────────────
router.get('/reading-log', requireChildSession, async (req, res) => {
  const { child_id } = req.childSession;
  try {
    const { rows } = await pool.query(`
      SELECT id, book_title, pages_read, date_read, notes, created_at
      FROM ${s()}.reading_log_entries
      WHERE child_id=$1
      ORDER BY date_read DESC, created_at DESC
      LIMIT 50
    `, [child_id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /api/childrens-area/reading-log ─────────────────────────────────────
router.post('/reading-log', requireChildSession, async (req, res) => {
  const { book_title, pages_read, date_read, notes } = req.body || {};
  if (!book_title || pages_read === undefined) {
    return res.status(400).json({ error: 'book_title and pages_read required' });
  }
  const { child_id, id: sessionId, parent_email } = req.childSession;
  try {
    const { rows: [entry] } = await pool.query(`
      INSERT INTO ${s()}.reading_log_entries
        (child_id, parent_email, child_session_id, book_title, pages_read, date_read, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [
      child_id, parent_email, sessionId,
      book_title.trim().slice(0, 200),
      Math.max(0, parseInt(pages_read) || 0),
      date_read || new Date().toISOString().slice(0, 10),
      (notes || '').slice(0, 500) || null,
    ]);

    await pool.query(`
      INSERT INTO ${s()}.child_audit_events
        (child_session_id, parent_email, child_id, event_type, event_data)
      VALUES ($1,$2,$3,'reading_logged',$4::jsonb)
    `, [sessionId, parent_email, child_id,
        JSON.stringify({ book_title: book_title.trim(), pages_read: parseInt(pages_read) || 0 })]);

    res.status(201).json({ ok: true, id: entry.id });
  } catch (e) {
    console.error('[children-area] reading-log post:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /api/childrens-area/portfolio ────────────────────────────────────────
// Observations the teacher has shared with parents — scoped to this child.
router.get('/portfolio', requireChildSession, async (req, res) => {
  const { child_id } = req.childSession;
  try {
    const { rows } = await pool.query(`
      SELECT o.id, o.created_at AS observation_date, o.title, o.observation_text,
             o.observation_type, o.photo_urls,
             CONCAT(st.first_name,' ',st.last_name) AS added_by_name
      FROM ${s()}.observations o
      LEFT JOIN ${s()}.staff st ON st.id=o.staff_id
      WHERE o.child_id=$1 AND o.shared_with_parents=true
      ORDER BY o.created_at DESC
      LIMIT 30
    `, [child_id]);
    res.json(rows);
  } catch (e) {
    console.error('[children-area] portfolio:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
