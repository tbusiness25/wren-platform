'use strict';

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const crypto = require('crypto');

// ── Auth middleware ────────────────────────────────────────────────────────────
// Accept EITHER a valid Wren JWT (admin UI) OR the per-school extension API token (browser extension,
// stored in settings.extension_api_token). The extension sends it as `Authorization: Bearer <token>`.
async function extensionOrAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-wren-token'] || '');
  if (token) {
    try {
      const { rows: [s] } = await getPool().query(
        "SELECT value FROM settings WHERE key='extension_api_token' LIMIT 1");
      if (s && s.value && token === s.value) {
        req.user = { id: 1, role: 'manager', via: 'funding-extension' };
        return next();
      }
    } catch (_) { /* settings unavailable — fall through to JWT auth */ }
  }
  return authenticate(req, res, next);
}
router.use(extensionOrAuth);
// req.user is already set by extensionOrAuth, so managerOnly is just the role gate (no second authenticate).
function managerOnly(req, res, next) {
  if (req.user && ['manager', 'deputy_manager'].includes(req.user.role)) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// ── GET /api/funding-portal/template-for-url ──────────────────────────────────
// Called by browser extension with the current portal URL; returns matching template or null
router.get('/template-for-url', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM funding_portal_templates ORDER BY is_public DESC, test_count DESC'
    );
    const match = rows.find(t => {
      try { return new RegExp(t.portal_url_pattern, 'i').test(url); }
      catch (_) { return false; }
    });
    if (!match) return res.json(null);
    res.json({ template: match, version: match.version, last_updated: match.updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/terms ─────────────────────────────────────────────
// Funding terms for the extension's term selector (kept under this router so the extension token works).
router.get('/terms', managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT id, name FROM funding_terms ORDER BY id DESC');
    res.json(rows.map((t, i) => ({ id: t.id, name: t.name, is_current: i === 0 })));
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
        `SELECT child_id FROM child_funding WHERE term_id=$1 AND funding_type != 'none'`,
        [term_id]
      );
      childIdList = funded.map(r => r.child_id);
    }

    if (!childIdList.length) return res.json({ children: [], term: null, la: null });

    // Fetch term info
    const { rows: [term] } = await db.query(
      'SELECT * FROM funding_terms WHERE id=$1', [term_id]
    );

    // Fetch LA template info
    const { rows: [la] } = await db.query(
      'SELECT la_code, la_name, engine FROM funding_portal_templates WHERE la_code=$1', [la_code]
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
        c.address_line1 AS address_line_1,
        NULL::text AS address_line_2,
        NULL::text AS city,
        c.postcode,
        c.parent_1_name,
        c.parent_1_name AS parent_1_first_name,
        NULL::text AS parent_1_last_name,
        c.parent_1_email,
        c.parent_1_phone,
        NULL::text AS parent_1_ni_number,
        c.parent_2_name,
        c.parent_2_name AS parent_2_first_name,
        NULL::text AS parent_2_last_name,
        c.parent_2_email,
        c.parent_2_phone,
        NULL::text AS parent_2_ni_number,
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
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN child_funding cf ON cf.child_id = c.id AND cf.term_id = $1
      WHERE c.id IN (${placeholders})
      ORDER BY c.first_name, c.last_name
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
      INSERT INTO funding_portal_submissions
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
        UPDATE funding_portal_templates
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
      FROM funding_portal_submissions fps
      LEFT JOIN staff s ON s.id = fps.submitted_by
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
      FROM funding_portal_templates
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
      'SELECT * FROM funding_portal_templates WHERE id=$1', [req.params.id]
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
      INSERT INTO funding_portal_templates
        (la_code, la_name, portal_url_pattern, engine, steps, is_public, test_status, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,false,'unverified',$6,$7)
      ON CONFLICT (la_code) DO UPDATE SET
        la_name = EXCLUDED.la_name,
        portal_url_pattern = EXCLUDED.portal_url_pattern,
        engine = EXCLUDED.engine,
        steps = EXCLUDED.steps,
        notes = EXCLUDED.notes,
        version = funding_portal_templates.version + 1,
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
      'SELECT * FROM funding_portal_templates WHERE id=$1', [req.params.id]
    );
    if (!t) return res.status(404).json({ error: 'Template not found' });
    if (t.test_count < 5) {
      return res.status(400).json({
        error: `Template needs at least 5 successful submissions before sharing. Current: ${t.test_count}`
      });
    }
    const { rows: [updated] } = await getPool().query(`
      UPDATE funding_portal_templates
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
const _EXT_DIR = require('path').join(__dirname, '../../extensions/funding-portal');
// Build the Load-Unpacked zip on demand from the extension source in the image
// (no binary committed to git). Cached once built.
function _buildZip() {
  const fs = require('fs'); const path = require('path');
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const skip = new Set(['dist', 'node_modules', 'PROVENANCE.md']);
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name) || name.startsWith('.')) continue;
      const fp = path.join(dir, name); const rp = rel ? rel + '/' + name : name;
      const st = fs.statSync(fp);
      if (st.isDirectory()) walk(fp, rp);
      else if (!/\.(zip|crx|pem)$/.test(name)) zip.addLocalFile(fp, rel);
    }
  })(_EXT_DIR, '');
  const out = path.join(_EXT_DIR, 'dist', 'wren-funding-portal.zip');
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); zip.writeZip(out); return out; } catch (_) {
    // Read-only FS fallback: write to a tmp dir.
    const tmp = path.join(require('os').tmpdir(), 'wren-funding-portal.zip');
    zip.writeZip(tmp); return tmp;
  }
}
function _extPackage() {
  const fs = require('fs'); const path = require('path');
  for (const [file, kind] of [['dist/wren-funding-portal.crx', 'crx'], ['dist/wren-funding-portal.zip', 'zip']]) {
    const p = path.join(_EXT_DIR, file);
    try { const st = fs.statSync(p); return { path: p, kind, filename: path.basename(p), size: st.size }; } catch (_) {}
  }
  // No prebuilt package — build the zip now (source is in the image).
  try {
    const p = _buildZip();
    const st = fs.statSync(p);
    return { path: p, kind: 'zip', filename: 'wren-funding-portal.zip', size: st.size };
  } catch (e) { console.error('[funding-portal] zip build failed:', e.message); return null; }
}

router.get('/extension/download', async (req, res) => {
  const fs = require('fs'); const path = require('path');
  const pkg = _extPackage();
  let extVersion = '0.2.0';
  try { extVersion = JSON.parse(fs.readFileSync(path.join(_EXT_DIR, 'manifest.json'), 'utf8')).version; } catch (_) {}
  res.json({
    version: extVersion,
    available: !!pkg,
    kind: pkg ? pkg.kind : null,
    filename: pkg ? pkg.filename : null,
    size_bytes: pkg ? pkg.size : null,
    download_url: pkg ? '/api/funding-portal/extension/file' : null,
    instructions: pkg && pkg.kind === 'zip' ? [
      'Download the .zip below and unzip it to a permanent folder (don\'t delete it after — Chrome loads it from there).',
      'Open Chrome → chrome://extensions',
      'Enable "Developer mode" (top-right toggle).',
      'Click "Load unpacked" and select the unzipped folder.',
      'Open the extension, enter your Wren server URL and the API token from Roost → System → Funding Portal.',
    ] : [
      'Download the .crx file below.',
      'Open Chrome → chrome://extensions, enable Developer mode, drag the .crx onto the page, Add extension.',
      'Open the extension and enter your Wren server URL and API token.',
    ],
  });
});

// Serve the actual package file (auth: manager JWT via the router's auth above,
// OR the extension api-token — extensionOrAuth already guards this router).
router.get('/extension/file', async (req, res) => {
  const pkg = _extPackage();
  if (!pkg) return res.status(404).json({ error: 'Extension not packaged yet' });
  res.download(pkg.path, pkg.filename);
});

// ── LA template requests (2026-07-10) — the scale mechanism ───────────────────
// Any setting can say "here's my Local Authority + portal + a sample of the
// form"; the local AI drafts a Wren template; Toby reviews and signs off; on
// approval it becomes a real (private) funding_portal_templates row. This is how
// coverage grows to new LAs without hand-coding each one.
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const FUNDING_MODEL = process.env.FUNDING_TEMPLATE_MODEL || 'gpt-oss:120b';

// Submit a request (manager auth via the router guard; the public website tool
// posts through a same-origin proxy that adds the extension token).
router.post('/template-request', async (req, res) => {
  const { la_name, portal_url, form_sample, notes, email } = req.body || {};
  if (!la_name) return res.status(400).json({ error: 'la_name required' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO funding_template_requests (la_name, portal_url, submitted_by_email, form_sample, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [String(la_name).slice(0, 200), portal_url || null, email || req.user?.email || null,
       String(form_sample || '').slice(0, 20000), String(notes || '').slice(0, 2000)]);
    res.status(201).json({ ok: true, id: rows[0].id, status: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/template-requests', managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, la_name, portal_url, submitted_by_email, notes, status,
              (ai_draft IS NOT NULL) AS has_draft, created_at, decided_at
       FROM funding_template_requests ORDER BY created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI drafts a template from the portal URL + form sample. Returns the draft for
// Toby to review; does NOT go live until /approve. Deterministic-ish: low temp.
router.post('/template-requests/:id/ai-draft', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT * FROM funding_template_requests WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    const prompt = `You map UK Local Authority Early Years funding portal forms into Wren's JSON template format. Produce ONLY JSON.

The Wren template shape:
{"la_code":"short-slug","la_name":"...","portal_url_pattern":"https://host/*","engine":"synergy|capita|liquid-logic|custom","steps":[{"page":"login|headcount|child-details|submit","selector_hints":["..."]}],"field_mappings":{"child_first_name":"<their field label or selector>","child_last_name":"...","dob":"...","start_date":"...","hours_per_week":"...","funding_type":"...","ethnicity":"...","address":"...","postcode":"..."},"ethnicity_lookup":{"White British":"WBRI"}}

Local Authority: ${r.la_name}
Portal URL: ${r.portal_url || '(not given)'}
Form sample (field labels / HTML the provider pasted):
${(r.form_sample || '(none provided — infer from the portal family)').slice(0, 12000)}

Pick engine from the URL/host if it's a known family (servelec/synergy→synergy, capita/ems→capita, liquidlogic→liquid-logic, else custom). Map every field you can see; leave unknowns null. Return ONLY the JSON object.`;
    const resp = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: FUNDING_MODEL, prompt, stream: false, think: false, options: { temperature: 0.15, num_predict: 1200 } }),
      signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
    const raw = ((await resp.json()).response || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI returned no JSON — try pasting a clearer form sample');
    let draft; try { draft = JSON.parse(m[0]); } catch { throw new Error('AI JSON was malformed — regenerate'); }
    await db.query(`UPDATE funding_template_requests SET ai_draft=$1, status='drafted' WHERE id=$2`, [JSON.stringify(draft), r.id]);
    res.json({ ok: true, draft });
  } catch (e) {
    console.error('[funding-portal] ai-draft error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Toby approves → the AI draft (or his edited version) becomes a live template.
router.post('/template-requests/:id/approve', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT * FROM funding_template_requests WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    const draft = (req.body && req.body.template) || (typeof r.ai_draft === 'string' ? JSON.parse(r.ai_draft) : r.ai_draft);
    if (!draft || !draft.la_name) return res.status(400).json({ error: 'No usable draft to approve' });
    const { rows: tmpl } = await db.query(
      `INSERT INTO funding_portal_templates
        (la_code, la_name, portal_url_pattern, engine, version, steps, field_mappings, ethnicity_lookup, notes, approved_by, is_public, test_status)
       VALUES ($1,$2,$3,$4,'0.1',$5,$6,$7,$8,$9,false,'untested') RETURNING id`,
      [draft.la_code || null, draft.la_name, draft.portal_url_pattern || r.portal_url, draft.engine || 'custom',
       JSON.stringify(draft.steps || []), JSON.stringify(draft.field_mappings || {}),
       JSON.stringify(draft.ethnicity_lookup || {}), 'AI-drafted from request #' + r.id + ', approved by Toby', req.user.id]);
    await db.query(`UPDATE funding_template_requests SET status='approved', decided_by=$1, decided_at=now() WHERE id=$2`, [req.user.id, r.id]);
    res.json({ ok: true, template_id: tmpl[0].id, note: 'Template created (marked untested — do one real submission to verify before relying on it).' });
  } catch (e) {
    console.error('[funding-portal] approve error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/template-requests/:id/reject', managerOnly, async (req, res) => {
  try {
    const { rowCount } = await getPool().query(
      `UPDATE funding_template_requests SET status='rejected', decided_by=$1, decided_at=now() WHERE id=$2 AND status<>'approved'`,
      [req.user.id, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found or already approved' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/funding-portal/extension/token ──────────────────────────────────
// Generate or rotate the per-school extension API token stored in the school record
router.get('/extension/token', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [setting] } = await db.query(
      "SELECT value FROM settings WHERE key='extension_api_token' LIMIT 1"
    );
    if (setting) return res.json({ token: setting.value });

    // Generate and store new token
    const token = crypto.randomBytes(32).toString('hex');
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('extension_api_token', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
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
      "INSERT INTO settings (key, value) VALUES ('extension_api_token', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      [token]
    );
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
