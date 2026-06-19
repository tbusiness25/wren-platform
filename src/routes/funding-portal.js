'use strict';

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const crypto = require('crypto');

// ── Auth middleware ────────────────────────────────────────────────────────────
router.use(authenticate);
const managerOnly = requireRole('manager', 'deputy_manager');

// ── GET /api/funding-portal/template-for-url ──────────────────────────────────
// Called by browser extension with the current portal URL; returns matching template or null
router.get('/template-for-url', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM ladn.funding_portal_templates ORDER BY is_public DESC, test_count DESC'
    );
    const match = rows.find(t => {
      try { return new RegExp(t.portal_url_pattern, 'i').test(url); }
      catch (_) { return false; }
    });
    if (!match) return res.json(null);
    res.json({ template: match, version: match.version, last_updated: match.updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/data-for-submission ────────────────────────────────
// Returns children + parent data needed for auto-fill
router.get('/data-for-submission', managerOnly, async (req, res) => {
  const { la_code, term_id, child_ids } = req.query;
  if (!la_code) return res.status(400).json({ error: 'la_code required' });
  if (!term_id) return res.status(400).json({ error: 'term_id required' });

  try {
    const db = getPool();

    // Resolve child IDs: either explicit list or all funded children for the term
    let childIdList = [];
    if (child_ids) {
      childIdList = child_ids.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      const { rows: funded } = await db.query(
        `SELECT child_id FROM ladn.child_funding WHERE term_id=$1 AND funding_type != 'none'`,
        [term_id]
      );
      childIdList = funded.map(r => r.child_id);
    }

    if (!childIdList.length) return res.json({ children: [], term: null, la: null });

    // Fetch term info
    const { rows: [term] } = await db.query(
      'SELECT * FROM ladn.funding_terms WHERE id=$1', [term_id]
    );

    // Fetch LA template info
    const { rows: [la] } = await db.query(
      'SELECT la_code, la_name, engine FROM ladn.funding_portal_templates WHERE la_code=$1', [la_code]
    );

    // Fetch children + funding allocation + parent data
    const placeholders = childIdList.map((_, i) => `$${i + 2}`).join(',');
    const { rows: children } = await db.query(`
      SELECT
        c.id,
        c.first_name,
        c.last_name,
        TO_CHAR(c.date_of_birth, 'DD/MM/YYYY') as dob,
        TO_CHAR(c.date_of_birth, 'YYYY-MM-DD') as dob_iso,
        c.gender,
        c.ethnicity,
        c.upn,
        c.address_line_1,
        c.address_line_2,
        c.city,
        c.postcode,
        c.parent_1_first_name,
        c.parent_1_last_name,
        c.parent_1_email,
        c.parent_1_phone,
        c.parent_1_ni_number,
        c.parent_2_first_name,
        c.parent_2_last_name,
        c.parent_2_email,
        c.parent_2_phone,
        c.parent_2_ni_number,
        r.name as room_name,
        cf.funding_type,
        cf.universal_hours_week,
        cf.extended_hours_week,
        cf.total_hours_week,
        cf.weeks_in_term,
        cf.total_hours_term,
        cf.thirty_hour_code,
        TO_CHAR(cf.thirty_hour_code_expiry, 'DD/MM/YYYY') as thirty_hour_code_expiry,
        cf.stretched_funding,
        cf.declaration_signed,
        cf.pupil_premium,
        cf.eypp_eligible,
        cf.deprivation_weighting
      FROM ladn.children c
      LEFT JOIN ladn.rooms r ON r.id = c.room_id
      LEFT JOIN ladn.child_funding cf ON cf.child_id = c.id AND cf.term_id = $1
      WHERE c.id IN (${placeholders})
      ORDER BY c.last_name, c.first_name
    `, [term_id, ...childIdList]);

    res.json({
      children,
      term: term ? {
        id: term.id,
        name: term.name,
        start_date: term.start_date,
        end_date: term.end_date,
        weeks: term.term_months
      } : null,
      la: la || { la_code, la_name: la_code, engine: 'synergy' }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/funding-portal/log-submission ───────────────────────────────────
// Extension reports back after each submission attempt
router.post('/log-submission', async (req, res) => {
  const {
    la_code, la_name, term_id, term_label,
    child_ids, children_data,
    status, children_submitted, children_failed,
    errors, audit_trail, submission_references, extension_version
  } = req.body;

  if (!la_code || !term_label) return res.status(400).json({ error: 'la_code and term_label required' });

  try {
    const { rows: [row] } = await getPool().query(`
      INSERT INTO ladn.funding_portal_submissions
        (la_code, la_name, term_id, term_label, child_ids, children_data, status,
         children_submitted, children_failed, errors, audit_trail, submission_references,
         extension_version, submitted_by, attempted_at,
         completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),
        CASE WHEN $7 IN ('success','partial','failed') THEN NOW() ELSE NULL END)
      RETURNING id, attempted_at
    `, [
      la_code, la_name || la_code, term_id || null, term_label,
      child_ids ? `{${child_ids.map(id => `"${id}"`).join(',')}}` : null,
      children_data ? JSON.stringify(children_data) : null,
      status || 'in-progress',
      children_submitted || 0,
      children_failed || 0,
      errors ? JSON.stringify(errors) : null,
      audit_trail ? JSON.stringify(audit_trail) : null,
      submission_references ? JSON.stringify(submission_references) : null,
      extension_version || null,
      req.user.id
    ]);

    // Update test_count on template when submission completes successfully
    if (status === 'success' || status === 'partial') {
      await getPool().query(`
        UPDATE ladn.funding_portal_templates
        SET test_count = test_count + 1,
            last_tested_at = NOW(),
            test_status = CASE
              WHEN test_count >= 4 AND test_status = 'draft' THEN 'passing'
              ELSE test_status
            END
        WHERE la_code = $1
      `, [la_code]);
    }

    res.status(201).json({ ok: true, id: row.id, attempted_at: row.attempted_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/submissions ───────────────────────────────────────
router.get('/submissions', managerOnly, async (req, res) => {
  const { la_code, limit = 50 } = req.query;
  try {
    const vals = [];
    let where = '';
    if (la_code) { vals.push(la_code); where = 'WHERE fps.la_code=$1'; }
    const { rows } = await getPool().query(`
      SELECT fps.*,
        s.first_name||' '||s.last_name as submitted_by_name
      FROM ladn.funding_portal_submissions fps
      LEFT JOIN ladn.staff s ON s.id = fps.submitted_by
      ${where}
      ORDER BY fps.attempted_at DESC
      LIMIT $${vals.length + 1}
    `, [...vals, parseInt(limit)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/templates ─────────────────────────────────────────
router.get('/templates', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT id, la_code, la_name, portal_url_pattern, engine, version,
        CASE WHEN jsonb_array_length(steps) > 0 THEN true ELSE false END as has_steps,
        jsonb_array_length(steps) as step_count,
        is_public, test_status, test_count, last_tested_at, notes,
        created_at, updated_at
      FROM ladn.funding_portal_templates
      ORDER BY
        CASE WHEN test_status='passing' THEN 0 WHEN test_status='draft' THEN 1 ELSE 2 END,
        la_name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/templates/:id ─────────────────────────────────────
router.get('/templates/:id', async (req, res) => {
  try {
    const { rows: [t] } = await getPool().query(
      'SELECT * FROM ladn.funding_portal_templates WHERE id=$1', [req.params.id]
    );
    if (!t) return res.status(404).json({ error: 'Template not found' });
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/funding-portal/templates ────────────────────────────────────────
// Visual mapper POSTs new template here; marked private until 5 successful tests
router.post('/templates', managerOnly, async (req, res) => {
  const { la_code, la_name, portal_url_pattern, engine, steps, notes } = req.body;
  if (!la_code || !la_name || !portal_url_pattern) {
    return res.status(400).json({ error: 'la_code, la_name, portal_url_pattern required' });
  }
  try {
    const { rows: [t] } = await getPool().query(`
      INSERT INTO ladn.funding_portal_templates
        (la_code, la_name, portal_url_pattern, engine, steps, is_public, test_status, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,false,'unverified',$6,$7)
      ON CONFLICT (la_code) DO UPDATE SET
        la_name = EXCLUDED.la_name,
        portal_url_pattern = EXCLUDED.portal_url_pattern,
        engine = EXCLUDED.engine,
        steps = EXCLUDED.steps,
        notes = EXCLUDED.notes,
        version = ladn.funding_portal_templates.version + 1,
        updated_at = NOW()
      RETURNING *
    `, [la_code, la_name, portal_url_pattern, engine || 'synergy',
        JSON.stringify(steps || []), notes || null, req.user.id]);
    res.status(201).json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/funding-portal/templates/:id/share ──────────────────────────────
// Manager submits template for community review after 5 successful tests
router.post('/templates/:id/share', managerOnly, async (req, res) => {
  try {
    const { rows: [t] } = await getPool().query(
      'SELECT * FROM ladn.funding_portal_templates WHERE id=$1', [req.params.id]
    );
    if (!t) return res.status(404).json({ error: 'Template not found' });
    if (t.test_count < 5) {
      return res.status(400).json({
        error: `Template needs at least 5 successful submissions before sharing. Current: ${t.test_count}`
      });
    }
    const { rows: [updated] } = await getPool().query(`
      UPDATE ladn.funding_portal_templates
      SET test_status='pending-review', updated_at=NOW()
      WHERE id=$1 RETURNING *
    `, [req.params.id]);

    // Telegram notification to Wren team
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (botToken && chatId) {
        const msg = encodeURIComponent(
          `📋 New LA template submitted for review: ${t.la_name} (${t.la_code}) — ${t.test_count} successful submissions`
        );
        require('https').get(`https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${msg}`);
      }
    } catch (_) {}

    res.json({ ok: true, template: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/extension/download ───────────────────────────────
// Returns extension download metadata; actual .crx served as static file
router.get('/extension/download', async (req, res) => {
  const extDir = require('path').join(__dirname, '../../extensions/funding-portal');
  const crxPath = require('path').join(extDir, 'dist/wren-funding-portal.crx');
  const fs = require('fs');
  let fileSize = null;
  try { fileSize = fs.statSync(crxPath).size; } catch (_) {}
  res.json({
    version: '0.1.0',
    filename: 'wren-funding-portal.crx',
    available: !!fileSize,
    size_bytes: fileSize,
    instructions: [
      'Download the .crx file below.',
      'Open Chrome → chrome://extensions',
      'Enable "Developer mode" (top right toggle).',
      'Drag and drop the .crx file onto the extensions page.',
      'Click "Add extension" when prompted.',
      'Open the extension popup and enter your Wren server URL and API token.'
    ]
  });
});

// ── GET /api/funding-portal/extension/token ──────────────────────────────────
// Generate or rotate the per-school extension API token stored in the school record
router.get('/extension/token', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [setting] } = await db.query(
      "SELECT value FROM ladn.settings WHERE key='extension_api_token' LIMIT 1"
    );
    if (setting) return res.json({ token: setting.value });

    // Generate and store new token
    const token = crypto.randomBytes(32).toString('hex');
    await db.query(
      "INSERT INTO ladn.settings (key, value) VALUES ('extension_api_token', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      [token]
    );
    res.json({ token });
  } catch (e) {
    // settings table may not exist — return a session-scoped token as fallback
    const token = crypto.randomBytes(32).toString('hex');
    res.json({ token, ephemeral: true });
  }
});

// ── POST /api/funding-portal/extension/token/rotate ──────────────────────────
router.post('/extension/token/rotate', managerOnly, async (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    await getPool().query(
      "INSERT INTO ladn.settings (key, value) VALUES ('extension_api_token', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      [token]
    );
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
