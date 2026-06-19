'use strict';
// External API for Home Assistant and other integrations.
// Uses scoped bearer tokens generated in the parent portal.
// All data filtered by parent_permissions_matrix.

const express     = require('express');
const router      = express.Router();
const crypto      = require('crypto');
const { getPool } = require('../db/pool');
const rateLimit   = require('express-rate-limit');
const authenticate = require('../middleware/auth');

const extLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,  // 2/sec sustained
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Rate limit exceeded' },
});

router.use(extLimiter);

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// ── Token auth middleware ─────────────────────────────────────────────────────
async function extAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer wren_parent_')) return res.status(401).json({ error: 'Invalid token format' });
  const raw = h.slice(7);
  const hash = sha256(raw);

  try {
    const db = getPool();
    const { rows: [tok] } = await db.query(`
      SELECT t.*, pa.child_id, pa.email AS parent_email, pa.is_active,
             c.first_name, c.last_name
      FROM ladn.external_api_tokens t
      JOIN ladn.parent_portal_access pa ON lower(pa.email) = lower(t.parent_email) AND pa.is_active = true
      JOIN ladn.children c ON c.id = t.child_id
      WHERE t.token_hash = $1
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > NOW())
    `, [hash]);

    if (!tok) return res.status(401).json({ error: 'Invalid or expired token' });

    await db.query('UPDATE ladn.external_api_tokens SET last_used_at=NOW() WHERE token_hash=$1', [hash]);
    req.extToken = tok;
    next();
  } catch (e) {
    console.error('[ext-api] auth error:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
}

// ── Helper: resolve effective permissions for a child ─────────────────────────
async function getEffectivePerms(db, childId) {
  const { rows } = await db.query(`
    SELECT m.attribute_key,
           COALESCE(
             (SELECT co.api FROM ladn.parent_permissions_child_overrides co
              WHERE co.child_id=$1 AND co.attribute_key=m.attribute_key LIMIT 1),
             o.api,
             m.default_api
           ) AS api_enabled
    FROM ladn.parent_permissions_matrix m
    LEFT JOIN ladn.parent_permissions_overrides o ON o.attribute_key = m.attribute_key
    WHERE m.affects_audiences @> '{"api"}'
  `, [childId]);
  const perms = {};
  for (const r of rows) perms[r.attribute_key] = r.api_enabled;
  return perms;
}

// ── GET /api/external/v1/parent/me — main data endpoint ──────────────────────
router.get('/v1/parent/me', extAuth, async (req, res) => {
  const db = getPool();
  const childId = req.extToken.child_id;
  const childName = req.extToken.first_name;

  try {
    const perms = await getEffectivePerms(db, childId);
    const today = new Date().toISOString().slice(0, 10);
    const data = { child_id: childId, child_name: childName, as_of: new Date().toISOString(), attributes: {} };

    // Daily diary
    if (perms.daily_diary) {
      const { rows: [diary] } = await db.query(`
        SELECT mood, food_ate, food_rating, nappy_count FROM ladn.daily_diary
        WHERE child_id=$1 AND diary_date=$2 LIMIT 1
      `, [childId, today]);
      if (diary) data.attributes.daily_diary = diary;
    }

    // Nap
    if (perms.nap) {
      const { rows: naps } = await db.query(`
        SELECT start_time, end_time, duration_minutes FROM ladn.sleep_checks
        WHERE child_id=$1 AND sleep_date=$2 ORDER BY start_time DESC LIMIT 3
      `, [childId, today]);
      data.attributes.nap = naps;
    }

    // Attendance
    if (perms.attendance) {
      const { rows: [att] } = await db.query(`
        SELECT status, arrived_at FROM ladn.attendance
        WHERE child_id=$1 AND date=$2 LIMIT 1
      `, [childId, today]);
      data.attributes.attendance = att || { status: 'unknown' };
    }

    // at_setting (live check-in — explicit opt-in required)
    if (perms.at_setting) {
      const { rows: [clk] } = await db.query(`
        SELECT clock_in_time, clock_out_time FROM ladn.staff_clock_events
        WHERE child_id=$1 AND event_date=$2 ORDER BY clock_in_time DESC LIMIT 1
      `, [childId, today]).catch(() => ({ rows: [] }));
      data.attributes.at_setting = clk ? clk.clock_out_time == null : false;
    }

    // Observations this week
    if (perms.observations_week_count) {
      const { rows: [obs] } = await db.query(`
        SELECT COUNT(*)::int AS count FROM ladn.observations
        WHERE child_id=$1 AND observed_at >= date_trunc('week', NOW())
      `, [childId]);
      data.attributes.observations_week_count = obs?.count || 0;
    }

    // Outstanding fees
    if (perms.fees) {
      const { rows: [fee] } = await db.query(`
        SELECT COALESCE(SUM(amount - COALESCE(amount_paid,0)), 0)::numeric(10,2) AS outstanding
        FROM ladn.invoices WHERE child_id=$1 AND status NOT IN ('paid','cancelled')
      `, [childId]);
      data.attributes.fees = { outstanding_gbp: parseFloat(fee?.outstanding || 0) };
    }

    // Next event
    if (perms.next_event) {
      const { rows: [ev] } = await db.query(`
        SELECT title, event_date, event_type FROM ladn.curriculum_activities
        WHERE (related_child_ids @> ARRAY[$1::int] OR related_child_ids IS NULL)
          AND event_date >= CURRENT_DATE
        ORDER BY event_date ASC LIMIT 1
      `, [childId]).catch(() => ({ rows: [] }));
      data.attributes.next_event = ev || null;
    }

    // Homework due
    if (perms.homework_due) {
      const { rows: hw } = await db.query(`
        SELECT title, due_date, subject FROM ladn.homework
        WHERE (child_id=$1 OR class_wide=true) AND due_date >= CURRENT_DATE
        ORDER BY due_date ASC LIMIT 3
      `, [childId]).catch(() => ({ rows: [] }));
      data.attributes.homework_due = hw;
    }

    // Behaviour points today
    if (perms.behaviour_points) {
      const { rows: [bp] } = await db.query(`
        SELECT COALESCE(SUM(points),0)::int AS total FROM ladn.behaviour_points
        WHERE child_id=$1 AND awarded_at::date = $2
      `, [childId, today]).catch(() => ({ rows: [{ total: 0 }] }));
      data.attributes.behaviour_points_today = bp?.total || 0;
    }

    res.json(data);
  } catch (e) {
    console.error('[ext-api] /me error:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /api/external/v1/parent/tokens — list tokens (CF-authed parent) ───────
router.get('/v1/parent/tokens', async (req, res) => {
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT t.id, t.label, t.child_id, t.last_used_at, t.expires_at, t.created_at,
             t.revoked_at, c.first_name || ' ' || c.last_name AS child_name
      FROM ladn.external_api_tokens t
      LEFT JOIN ladn.children c ON c.id = t.child_id
      WHERE lower(t.parent_email) = $1 AND t.revoked_at IS NULL
      ORDER BY t.created_at DESC
    `, [email]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/external/v1/parent/tokens — generate new token ─────────────────
router.post('/v1/parent/tokens', async (req, res) => {
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const { child_id, label } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });

  const db = getPool();
  try {
    // Verify parent has access to this child
    const { rows: [access] } = await db.query(
      'SELECT child_id FROM ladn.parent_portal_access WHERE lower(email)=$1 AND child_id=$2 AND is_active=true',
      [email, child_id]
    );
    if (!access) return res.status(403).json({ error: 'No access to this child' });

    // Max 5 active tokens per parent/child
    const { rows: existing } = await db.query(
      'SELECT id FROM ladn.external_api_tokens WHERE lower(parent_email)=$1 AND child_id=$2 AND revoked_at IS NULL',
      [email, child_id]
    );
    if (existing.length >= 5) return res.status(429).json({ error: 'Maximum 5 tokens per child. Revoke an existing one first.' });

    const raw = 'wren_parent_' + crypto.randomBytes(32).toString('hex');
    const hash = sha256(raw);

    await db.query(`
      INSERT INTO ladn.external_api_tokens (token_hash, parent_email, child_id, label)
      VALUES ($1, $2, $3, $4)
    `, [hash, email, child_id, label || 'Home Assistant']);

    // Return the raw token ONCE — not stored
    res.status(201).json({ token: raw, label: label || 'Home Assistant', note: 'Store this token securely — it cannot be retrieved again.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/external/v1/parent/tokens/:id — revoke token ─────────────────
router.delete('/v1/parent/tokens/:id', async (req, res) => {
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rowCount } = await db.query(
      'UPDATE ladn.external_api_tokens SET revoked_at=NOW() WHERE id=$1 AND lower(parent_email)=$2 AND revoked_at IS NULL',
      [req.params.id, email]
    );
    if (!rowCount) return res.status(404).json({ error: 'Token not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Staff: manage tokens for external API (admin panel) ───────────────────────
const staffRouter = express.Router();
staffRouter.use(authenticate);

staffRouter.get('/admin/tokens', async (req, res) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role))
    return res.status(403).json({ error: 'Admin only' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT t.id, t.label, t.child_id, t.parent_email, t.last_used_at, t.revoked_at, t.created_at,
             c.first_name || ' ' || c.last_name AS child_name
      FROM ladn.external_api_tokens t
      LEFT JOIN ladn.children c ON c.id = t.child_id
      ORDER BY t.created_at DESC LIMIT 200
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

staffRouter.delete('/admin/tokens/:id', async (req, res) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role))
    return res.status(403).json({ error: 'Admin only' });
  const db = getPool();
  try {
    await db.query('UPDATE ladn.external_api_tokens SET revoked_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { externalRouter: router, staffExternalRouter: staffRouter };
