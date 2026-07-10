'use strict';
const express  = require('express');
const router   = express.Router();
const { Pool } = require('pg');
const multer   = require('multer');
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const authenticate  = require('../middleware/auth');
const { getPool }   = require('../db/pool');

// ── Constants ────────────────────────────────────────────────────────────────

const OLLAMA_URL  = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL_BIG   = process.env.AI_MODEL_BIG  || 'qwen3.5:27b';
const MODEL_FAST  = process.env.AI_MODEL_FAST || 'qwen3.5:4b';
const STATS_URL   = process.env.INSIGHTS_STATS_URL || 'http://wren-insights-stats:8220';
// 2026-07-08: deputy_manager REMOVED — insights expose financial health / occupancy-profit
// metrics. Manager/owner only. Deputies keep child-data access, not business analytics.
const ADMIN_ROLES = new Set(['manager','admin']);

const BANNED_SQL_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|CREATE|ALTER|GRANT|REVOKE|EXECUTE|CALL|COPY|VACUUM|ANALYZE)\b/i;
const BANNED_TABLES = new Set([
  'safeguarding_concerns','medicine_records','protected_staff_pins',
  'message_audit','parent_portal_access','surveillance_confirmations',
  'staff_performance_flags','query_audit','user_api_keys'
]);

// ── Read-only pool for NL→SQL ─────────────────────────────────────────────────
let _roPool;
function getRoPool(schema) {
  if (!_roPool) {
    _roPool = new Pool({
      host:     process.env.PG_HOST || 'wren-postgres',
      port:     parseInt(process.env.PG_PORT || '5432'),
      database: process.env.PG_DB || 'wren',
      user:     process.env.PG_INSIGHTS_RO_USER || 'wren_insights_ro',
      password: process.env.PG_INSIGHTS_RO_PASSWORD || '', // <redacted — set in .env, not committed>
      max:      4,
      statement_timeout: 8000,
    });
  }
  return _roPool;
}

// ── In-memory rate limiter (30 queries / 5 minutes per user) ─────────────────
const rateMap = new Map();
function checkRate(userId) {
  const now = Date.now();
  const window = 5 * 60 * 1000;
  const limit = 30;
  let hits = (rateMap.get(userId) || []).filter(t => now - t < window);
  if (hits.length >= limit) return false;
  hits.push(now);
  rateMap.set(userId, hits);
  return true;
}

// ── Schema digest cache ───────────────────────────────────────────────────────
let _schemaDigestCache = {};
let _schemaDigestTs    = 0;

async function getSchemaDigest(schema) {
  if (Date.now() - _schemaDigestTs < 5 * 60 * 1000 && _schemaDigestCache[schema]) {
    return _schemaDigestCache[schema];
  }
  const db = getPool();
  const { rows: tables } = await db.query(
    `SELECT schema_name, table_name, display_name, blocked_columns, description
     FROM insights.queryable_tables WHERE is_active = TRUE AND schema_name = $1`,
    [schema]
  );
  if (!tables.length) return '';

  const lines = [`Tables available in the "${schema}" schema:\n`];
  for (const t of tables) {
    const { rows: cols } = await db.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [t.schema_name, t.table_name]
    );
    const blocked = new Set((t.blocked_columns || []).filter(Boolean));
    const colList = cols.filter(c => !blocked.has(c.column_name))
      .map(c => `${c.column_name} (${c.data_type})`).join(', ');
    lines.push(`  ${t.table_name}: ${colList}`);
    if (t.description) lines.push(`    # ${t.description}`);
  }
  const digest = lines.join('\n');
  _schemaDigestCache[schema] = digest;
  _schemaDigestTs = Date.now();
  return digest;
}

// ── SQL safety validator ──────────────────────────────────────────────────────
function validateSql(sql, schema) {
  const clean = sql.replace(/--[^\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'').trim();
  if (!/^SELECT\b/i.test(clean)) return { ok: false, reason: 'Only SELECT queries are allowed' };
  if (BANNED_SQL_KEYWORDS.test(clean)) return { ok: false, reason: 'Query contains disallowed SQL keywords' };
  if ((clean.match(/;/g) || []).length > 0) return { ok: false, reason: 'Multiple statements not allowed' };
  const tableRefs = clean.match(/\b(?:FROM|JOIN)\s+(?:"?(\w+)"?\."?(\w+)"?|"?(\w+)"?)/gi) || [];
  for (const ref of tableRefs) {
    const parts = ref.replace(/\b(?:FROM|JOIN)\s+/i,'').replace(/"/g,'').split('.');
    const tbl = parts[parts.length - 1].toLowerCase();
    if (BANNED_TABLES.has(tbl)) {
      return { ok: false, reason: `Table "${tbl}" is not accessible from Insights` };
    }
    if (parts.length === 2 && parts[0].toLowerCase() !== schema && parts[0].toLowerCase() !== 'insights') {
      return { ok: false, reason: `Schema "${parts[0]}" is not allowed` };
    }
  }
  return { ok: true };
}

// ── Qwen non-streaming call ───────────────────────────────────────────────────
function callQwen(prompt, model) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: model || MODEL_FAST, prompt, stream: false, think: false });
    const url  = new URL('/api/generate', OLLAMA_URL);
    const lib  = url.protocol === 'https:' ? require('https') : require('http');
    const req  = lib.request({
      hostname: url.hostname, port: url.port || 80,
      path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).response || null); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(60000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// ── Metric computation ────────────────────────────────────────────────────────
function evalRag(value, thresholds) {
  if (!thresholds || value == null) return 'neutral';
  try {
    const v = parseFloat(value);
    if (isNaN(v)) return 'neutral';
    if (thresholds.green) {
      const g = thresholds.green.replace(/[^0-9.<>=]/g,'');
      if (g.startsWith('>=') && v >= parseFloat(g.slice(2))) return 'green';
      if (g.startsWith('>') && v > parseFloat(g.slice(1))) return 'green';
      if (g.startsWith('<') && v < parseFloat(g.slice(1))) return 'green';
      if (g.startsWith('=') && v === parseFloat(g.slice(1))) return 'green';
      if (/^\d/.test(g) && v === parseFloat(g)) return 'green';
    }
    if (thresholds.red) {
      const r = thresholds.red.replace(/[^0-9.<>=]/g,'');
      if (r.startsWith('<=') && v <= parseFloat(r.slice(2))) return 'red';
      if (r.startsWith('<') && v < parseFloat(r.slice(1))) return 'red';
      if (r.startsWith('>') && v > parseFloat(r.slice(1))) return 'red';
    }
    return 'amber';
  } catch { return 'neutral'; }
}

async function computeMetric(metricDef, schema) {
  const db = getPool();
  const sql = metricDef.sql_template.replace(/\{schema\}/g, schema);
  const start = Date.now();
  try {
    const { rows } = await db.query(sql);
    const duration = Date.now() - start;
    // Derive a primary numeric value for RAG
    let primaryValue = null;
    if (rows.length === 1) {
      const firstVal = Object.values(rows[0])[0];
      primaryValue = parseFloat(firstVal);
    } else if (metricDef.chart_type === 'number') {
      primaryValue = rows.length;
    } else {
      primaryValue = rows.length;
    }
    const rag = evalRag(primaryValue, metricDef.rag_thresholds);
    // Generate AI insight (short, non-blocking)
    let aiInsight = null;
    if (rows.length > 0 && metricDef.chart_type !== 'table') {
      const prompt = `You are a UK nursery manager assistant. Based on this data, write one clear sentence insight for the manager. Be specific with numbers. Data: ${JSON.stringify(rows.slice(0,5))}. Metric: ${metricDef.name}.`;
      aiInsight = await callQwen(prompt, MODEL_FAST);
    }
    const { rows: [saved] } = await db.query(
      `INSERT INTO insights.metric_results (metric_id, computed_at, result_data, rag_status, ai_insight, schema_scope)
       VALUES ($1, now(), $2, $3, $4, $5)
       RETURNING *`,
      [metricDef.id, JSON.stringify({ rows, duration_ms: duration }), rag, aiInsight, schema]
    );
    return saved;
  } catch (e) {
    await db.query(
      `INSERT INTO insights.metric_results (metric_id, computed_at, result_data, rag_status, schema_scope, error_message)
       VALUES ($1, now(), '{}', 'neutral', $2, $3)`,
      [metricDef.id, schema, e.message]
    );
    return null;
  }
}

// ── Nightly computation cron ──────────────────────────────────────────────────
let _computeRunning = false;
async function runAllMetrics(schemaScope) {
  if (_computeRunning) return { skipped: true };
  _computeRunning = true;
  const db = getPool();
  const schema = schemaScope || process.env.PG_SCHEMA || 'ladn';
  try {
    const { rows: metrics } = await db.query(
      `SELECT * FROM insights.metric_definitions WHERE is_active = TRUE ORDER BY sort_order`
    );
    let ok = 0, fail = 0;
    for (const m of metrics) {
      const res = await computeMetric(m, schema);
      if (res) ok++; else fail++;
    }
    // Also trigger stats container
    try {
      const statsRes = await fetch(`${STATS_URL}/run-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schema }),
        signal: AbortSignal.timeout(30000)
      });
      if (statsRes.ok) console.log('[insights] stats service run-all completed');
    } catch (e) {
      console.log('[insights] stats service unavailable:', e.message);
    }
    console.log(`[insights] nightly compute: ${ok} ok, ${fail} failed`);
    return { ok, fail, schema };
  } finally {
    _computeRunning = false;
  }
}

// Start nightly cron — every 5 minutes, fires compute at 2am
setInterval(() => {
  const h = new Date().getHours(), m = new Date().getMinutes();
  if (h === 2 && m < 5) runAllMetrics().catch(e => console.error('[insights cron]', e.message));
}, 5 * 60 * 1000);

// ── Multer for RAG uploads ────────────────────────────────────────────────────
const ragUploadDir = '/app/uploads/insights';
try { fs.mkdirSync(ragUploadDir, { recursive: true }); } catch {}

const ragUpload = multer({
  dest: ragUploadDir,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = new Set(['application/pdf','text/csv','text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword']);
    if (allowed.has(file.mimetype) || file.originalname.endsWith('.csv')) cb(null, true);
    else cb(new Error('Unsupported file type'), false);
  }
});

// ── CSV chunker → staging table ───────────────────────────────────────────────
async function loadCsvToStaging(filePath, originalName, uploadId) {
  const db = getPool();
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV has no data rows');

  const delim = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(delim).map(h => h.replace(/^["']|["']$/g,'').trim()
    .toLowerCase().replace(/[^a-z0-9_]/g,'_').replace(/^(\d)/,'c_$1') || 'col');
  const dataRows = lines.slice(1).map(l => l.split(delim).map(v => v.replace(/^["']|["']$/g,'').trim()));

  const safeName = originalName.replace(/[^a-z0-9]/gi,'_').toLowerCase().slice(0,40) + '_' + Date.now().toString(36);
  const createCols = headers.map(h => `"${h}" text`).join(', ');

  await db.query(`CREATE TABLE IF NOT EXISTS insights_staging."${safeName}" (${createCols})`);

  for (const row of dataRows.slice(0, 50000)) {
    const vals = headers.map((_, i) => row[i] || null);
    const placeholders = vals.map((_, i) => `$${i+1}`).join(',');
    await db.query(`INSERT INTO insights_staging."${safeName}" VALUES (${placeholders})`, vals);
  }

  // Infer column types from sample
  const sample = dataRows.slice(0,5).map(r => Object.fromEntries(headers.map((h,i) => [h, r[i]])));
  await db.query(
    `INSERT INTO insights.staging_tables_registry (upload_id, table_name, source_filename, column_metadata, row_count)
     VALUES ($1, $2, $3, $4, $5)`,
    [uploadId, safeName, originalName, JSON.stringify({ headers, sample }), dataRows.length]
  );
  return { table_name: safeName, rows: dataRows.length, columns: headers };
}

// ── Text chunker for RAG ──────────────────────────────────────────────────────
function chunkText(text, size = 500, overlap = 80) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    chunks.push(words.slice(i, i + size).join(' '));
    i += size - overlap;
  }
  return chunks;
}

// ── All routes require auth ───────────────────────────────────────────────────
router.use(authenticate);

// 2026-07-08: whole Insights module is management BI (financial health, occupancy → profit,
// staff analytics). Previously only SOME endpoints carried ADMIN_ROLES, so /metrics, /dashboards,
// /anomalies, /forecasts etc. leaked to any authenticated staff (incl. deputy + practitioners).
// Blanket manager/owner gate here; the per-endpoint ADMIN_ROLES checks below are now redundant
// but left in place as defence-in-depth.
router.use((req, res, next) => {
  if (!ADMIN_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'Manager access required' });
  next();
});

// ════════════════════════════════════════════════════════════════════════════
// METRIC LIBRARY
// ════════════════════════════════════════════════════════════════════════════

// GET /metrics — list all metrics with latest result
router.get('/metrics', async (req, res) => {
  try {
    const db = getPool();
    const { category, edition } = req.query;
    let where = 'md.is_active = TRUE';
    const vals = [];
    if (category) { vals.push(category); where += ` AND md.category = $${vals.length}`; }
    if (edition)  { vals.push(`{${edition}}`); where += ` AND md.edition && $${vals.length}::text[]`; }

    const { rows } = await db.query(`
      SELECT md.*,
        lr.id        AS latest_result_id,
        lr.computed_at,
        lr.result_data,
        lr.rag_status,
        lr.ai_insight,
        lr.error_message
      FROM insights.metric_definitions md
      LEFT JOIN LATERAL (
        SELECT * FROM insights.metric_results mr
        WHERE mr.metric_id = md.id
        ORDER BY mr.computed_at DESC LIMIT 1
      ) lr ON TRUE
      WHERE ${where}
      ORDER BY md.sort_order, md.category, md.name
    `, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /metrics/run-all — trigger full computation (admin)
router.post('/metrics/run-all', async (req, res) => {
  if (!ADMIN_ROLES.has(req.user.role)) return res.status(403).json({ error: 'Admin required' });
  try {
    const schema = req.body.schema || process.env.PG_SCHEMA || 'ladn';
    const result = await runAllMetrics(schema);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /metrics/:id/run — run single metric
router.post('/metrics/:id/run', async (req, res) => {
  if (!ADMIN_ROLES.has(req.user.role)) return res.status(403).json({ error: 'Admin required' });
  try {
    const db = getPool();
    const { rows: [m] } = await db.query('SELECT * FROM insights.metric_definitions WHERE id=$1', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Metric not found' });
    const schema = req.body.schema || process.env.PG_SCHEMA || 'ladn';
    const result = await computeMetric(m, schema);
    res.json(result || { error: 'Computation failed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /metrics/:id — single metric with history
router.get('/metrics/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [m] } = await db.query('SELECT * FROM insights.metric_definitions WHERE id=$1', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Not found' });
    const { rows: history } = await db.query(
      `SELECT id, computed_at, rag_status, ai_insight, error_message,
              result_data->'duration_ms' AS duration_ms
       FROM insights.metric_results WHERE metric_id=$1 ORDER BY computed_at DESC LIMIT 30`,
      [m.id]
    );
    res.json({ ...m, history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARDS
// ════════════════════════════════════════════════════════════════════════════

router.get('/dashboards', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT d.*, COUNT(w.id)::int AS widget_count
       FROM insights.user_dashboards d
       LEFT JOIN insights.dashboard_widgets w ON w.dashboard_id = d.id
       WHERE d.user_id = $1 OR d.is_shared = TRUE
       GROUP BY d.id ORDER BY d.is_default DESC, d.name`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/dashboards', async (req, res) => {
  const { name, is_default = false } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const db = getPool();
    if (is_default) {
      await db.query('UPDATE insights.user_dashboards SET is_default=FALSE WHERE user_id=$1', [req.user.id]);
    }
    const { rows: [d] } = await db.query(
      `INSERT INTO insights.user_dashboards (user_id, name, is_default)
       VALUES ($1,$2,$3) RETURNING *`,
      [req.user.id, name, is_default]
    );
    res.status(201).json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/dashboards/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [existing] } = await db.query(
      'SELECT * FROM insights.user_dashboards WHERE id=$1', [req.params.id]
    );
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.user_id !== req.user.id && !ADMIN_ROLES.has(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const allowed = ['name','is_default','layout','is_shared'];
    const updates = []; const vals = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        vals.push(typeof req.body[k] === 'object' ? JSON.stringify(req.body[k]) : req.body[k]);
        updates.push(`${k}=$${vals.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(new Date()); updates.push(`updated_at=$${vals.length}`);
    vals.push(req.params.id);
    const { rows: [d] } = await db.query(
      `UPDATE insights.user_dashboards SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/dashboards/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [existing] } = await db.query('SELECT * FROM insights.user_dashboards WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.user_id !== req.user.id && !ADMIN_ROLES.has(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    await db.query('DELETE FROM insights.user_dashboards WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/dashboards/:id/widgets', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT w.*,
              md.name AS metric_name, md.chart_type AS metric_chart_type,
              lr.result_data, lr.rag_status, lr.ai_insight, lr.computed_at
       FROM insights.dashboard_widgets w
       LEFT JOIN insights.metric_definitions md ON md.id = w.metric_id
       LEFT JOIN LATERAL (
         SELECT * FROM insights.metric_results mr WHERE mr.metric_id = w.metric_id
         ORDER BY mr.computed_at DESC LIMIT 1
       ) lr ON TRUE
       WHERE w.dashboard_id = $1
       ORDER BY (w.position->>'y')::int ASC, (w.position->>'x')::int ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/dashboards/:id/widgets', async (req, res) => {
  try {
    const db = getPool();
    const { metric_id, custom_definition, position, title, filters } = req.body;
    // Validate custom_definition against safelist if provided
    if (custom_definition) {
      const err = await validateWidgetDef(custom_definition);
      if (err) return res.status(400).json({ error: err });
    }
    const { rows: [w] } = await db.query(
      `INSERT INTO insights.dashboard_widgets (dashboard_id, metric_id, custom_definition, position, title, filters)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, metric_id || null,
       custom_definition ? JSON.stringify(custom_definition) : null,
       position ? JSON.stringify(position) : '{"x":0,"y":0,"w":2,"h":2}',
       title || null,
       filters ? JSON.stringify(filters) : null]
    );
    res.status(201).json(w);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/dashboards/:id/widgets/:wid', async (req, res) => {
  try {
    const db = getPool();
    const allowed = ['metric_id','custom_definition','position','title','filters'];
    const updates = []; const vals = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        vals.push(typeof req.body[k] === 'object' ? JSON.stringify(req.body[k]) : req.body[k]);
        updates.push(`${k}=$${vals.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.wid, req.params.id);
    const { rows: [w] } = await db.query(
      `UPDATE insights.dashboard_widgets SET ${updates.join(',')} WHERE id=$${vals.length-1} AND dashboard_id=$${vals.length} RETURNING *`,
      vals
    );
    if (!w) return res.status(404).json({ error: 'Not found' });
    res.json(w);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/dashboards/:id/widgets/:wid', async (req, res) => {
  try {
    const db = getPool();
    await db.query('DELETE FROM insights.dashboard_widgets WHERE id=$1 AND dashboard_id=$2', [req.params.wid, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Custom widget definition validator
async function validateWidgetDef(def) {
  if (!def.source_table) return 'source_table required';
  const db = getPool();
  const schema = def.source_schema || process.env.PG_SCHEMA || 'ladn';
  const { rows: [tbl] } = await db.query(
    `SELECT blocked_columns FROM insights.queryable_tables
     WHERE schema_name=$1 AND table_name=$2 AND is_active=TRUE`,
    [schema, def.source_table]
  );
  if (!tbl) return `Table "${def.source_table}" is not in the queryable safelist`;
  const blocked = new Set((tbl.blocked_columns || []).filter(Boolean));
  if (def.measure?.field && blocked.has(def.measure.field)) return `Column "${def.measure.field}" is blocked`;
  if (def.group_by?.field && blocked.has(def.group_by.field)) return `Column "${def.group_by.field}" is blocked`;
  const validFns = new Set(['count','sum','avg','min','max','count_distinct']);
  if (def.measure?.fn && !validFns.has(def.measure.fn)) return `Invalid measure function "${def.measure.fn}"`;
  return null;
}

// POST /dashboards/:id/widgets/:wid/preview — run custom widget SQL
router.post('/dashboards/:id/widgets/:wid/preview', async (req, res) => {
  try {
    const def = req.body;
    if (!def.source_table) return res.status(400).json({ error: 'source_table required' });
    const err = await validateWidgetDef(def);
    if (err) return res.status(400).json({ error: err });
    const sql = buildWidgetSql(def);
    const db = getPool();
    const { rows } = await db.query(sql);
    res.json({ rows, sql });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /widgets/preview — preview without saving
router.post('/widgets/preview', async (req, res) => {
  try {
    const def = req.body;
    if (!def.source_table) return res.status(400).json({ error: 'source_table required' });
    const err = await validateWidgetDef(def);
    if (err) return res.status(400).json({ error: err });
    const sql = buildWidgetSql(def);
    const db = getPool();
    const { rows } = await db.query(sql);
    res.json({ rows, sql });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function buildWidgetSql(def) {
  const schema = (def.source_schema || 'ladn').replace(/[^a-z0-9_]/g,'');
  const table  = (def.source_table || '').replace(/[^a-z0-9_]/g,'');
  const fn     = ({ count:'COUNT', sum:'SUM', avg:'AVG', min:'MIN', max:'MAX', count_distinct:'COUNT DISTINCT' })[def.measure?.fn] || 'COUNT';
  const mCol   = def.measure?.field ? `"${def.measure.field.replace(/"/g,'')}"` : '*';
  const measure = fn === 'COUNT DISTINCT' ? `COUNT(DISTINCT ${mCol})` : `${fn}(${mCol})`;

  const gbField = def.group_by?.field;
  const gbTrunc = def.group_by?.trunc;
  let gbExpr = null, gbSelect = null;
  if (gbField) {
    const safe = gbField.replace(/[^a-z0-9_]/g,'');
    const timeFields = new Set(['created_at','updated_at','date','event_time','start_date','paid_on','issued_on']);
    if (gbTrunc && timeFields.has(safe)) {
      gbExpr   = `DATE_TRUNC('${gbTrunc.replace(/[^a-z]/g,'')}', "${safe}")`;
      gbSelect = `${gbExpr} AS x`;
    } else {
      gbExpr   = `"${safe}"`;
      gbSelect = `"${safe}" AS x`;
    }
  }

  let whereClause = '';
  if (def.filters?.length) {
    const ops = { '=':'=', '!=':'!=', '>':'>','<':'<','>=':'>=','<=':'<=' };
    const parts = [];
    for (const f of def.filters) {
      const col = (f.col||'').replace(/[^a-z0-9_]/g,'');
      const op  = ops[f.op] || '=';
      if (col && f.val !== undefined) parts.push(`"${col}" ${op} '${String(f.val).replace(/'/g,"''")}'`);
    }
    if (parts.length) whereClause = `WHERE ${parts.join(' AND ')}`;
  }

  if (gbSelect) {
    return `SELECT ${gbSelect}, ${measure} AS y FROM "${schema}"."${table}" ${whereClause} GROUP BY ${gbExpr} ORDER BY x LIMIT 500`;
  } else {
    return `SELECT ${measure} AS y FROM "${schema}"."${table}" ${whereClause} LIMIT 1`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// INSIGHTS CHAT (NL→SQL)
// ════════════════════════════════════════════════════════════════════════════

router.get('/queryable-tables', async (req, res) => {
  try {
    const db = getPool();
    const schema = req.query.schema || process.env.PG_SCHEMA || 'ladn';
    const { rows } = await db.query(
      `SELECT qt.schema_name, qt.table_name, qt.display_name, qt.category,
              qt.blocked_columns, qt.description,
              (SELECT array_agg(column_name::text ORDER BY ordinal_position)
               FROM information_schema.columns ic
               WHERE ic.table_schema = qt.schema_name
                 AND ic.table_name = qt.table_name
                 AND ic.column_name != ALL(COALESCE(qt.blocked_columns, ARRAY[]::text[]))
              ) AS columns
       FROM insights.queryable_tables qt
       WHERE qt.is_active = TRUE AND qt.schema_name = $1
       ORDER BY qt.category, qt.display_name`,
      [schema]
    );
    // Also add staging tables
    const { rows: staging } = await db.query(
      `SELECT table_name, source_filename, column_metadata, row_count
       FROM insights.staging_tables_registry ORDER BY created_at DESC LIMIT 20`
    );
    res.json({ tables: rows, staging });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/chat', async (req, res) => {
  const { question, schema: reqSchema, confirm_surveillance } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'question required' });

  const schema = reqSchema || process.env.PG_SCHEMA || 'ladn';
  const start  = Date.now();
  let generated_sql = null;

  // Rate limit
  if (!checkRate(req.user.id)) {
    await logQuery(req.user, question, null, 0, 'Rate limit exceeded', schema, Date.now()-start, true, 'rate_limited');
    return res.status(429).json({ error: 'Rate limit: 30 queries per 5 minutes' });
  }

  try {
    // Surveillance check — individual staff drill-down requires confirmation
    const isSurveillance = /\b(individual|specific|named|who is|which staff)\b/i.test(question);
    if (isSurveillance && !confirm_surveillance) {
      return res.status(403).json({
        error: 'surveillance_confirmation_required',
        message: 'Viewing individual staff performance data requires you to confirm this access will be logged and used appropriately.',
        confirm_key: 'confirm_surveillance'
      });
    }
    if (isSurveillance && confirm_surveillance) {
      const db = getPool();
      await db.query(
        `INSERT INTO insights.surveillance_confirmations (user_id, target_type, ip_address)
         VALUES ($1, 'staff', $2)`,
        [req.user.id, req.ip]
      );
    }

    const digest = await getSchemaDigest(schema);
    const prompt = `You are a PostgreSQL expert analyzing UK nursery/school data in the "${schema}" schema.
Convert the manager's question into a single SQL SELECT query.

${digest}

Rules:
- Return ONLY the SQL SELECT statement, nothing else
- Always include LIMIT 1000
- Use proper PostgreSQL syntax
- Filter to active records where relevant (is_active = TRUE)
- Never use semicolons
- If the question involves staff, exclude sensitive columns (pin_hash, ni_number, email)

Manager question: ${question}

SQL (SELECT only):`;

    const rawSql = await callQwen(prompt, MODEL_BIG);
    if (!rawSql) {
      await logQuery(req.user, question, null, 0, 'AI unavailable', schema, Date.now()-start, false, null);
      return res.status(503).json({ error: 'AI service unavailable. Please try again.' });
    }

    // Extract SQL from response (Qwen sometimes wraps in ```sql ... ```)
    const sqlMatch = rawSql.match(/```sql\s*([\s\S]*?)```/i) ||
                     rawSql.match(/```\s*(SELECT[\s\S]*?)```/i) ||
                     rawSql.match(/(SELECT[\s\S]*)/i);
    generated_sql = (sqlMatch ? sqlMatch[1] : rawSql).trim()
      .replace(/;+$/, '').replace(/\n+/g,' ').trim();

    // Safety validation
    const valid = validateSql(generated_sql, schema);
    if (!valid.ok) {
      await logQuery(req.user, question, generated_sql, 0, valid.reason, schema, Date.now()-start, true, valid.reason);
      return res.status(400).json({ error: valid.reason, blocked: true, generated_sql });
    }

    // Ensure LIMIT
    if (!/\bLIMIT\b/i.test(generated_sql)) generated_sql += ' LIMIT 1000';

    // Run with read-only pool
    const roPool = getRoPool(schema);
    await roPool.query(`SET search_path = ${schema}, insights, public`);
    const { rows, fields } = await roPool.query(generated_sql);
    const duration = Date.now() - start;

    // Generate plain-English explanation
    const explainPrompt = `Explain this SQL query result in plain English for a nursery manager. Be specific with numbers. Keep it to 2 sentences maximum.
Query: ${question}
Result (first 3 rows): ${JSON.stringify(rows.slice(0,3))}
Total rows: ${rows.length}`;
    const explanation = await callQwen(explainPrompt, MODEL_FAST);

    await logQuery(req.user, question, generated_sql, rows.length, null, schema, duration, false, null);

    // Suggest chart type
    const chartType = suggestChartType(rows, fields);

    res.json({ rows, fields: fields?.map(f => f.name), generated_sql, explanation, duration_ms: duration, chart_suggestion: chartType });
  } catch (e) {
    const duration = Date.now() - start;
    await logQuery(req.user, question, generated_sql, 0, e.message, schema, duration, false, null);
    res.status(500).json({ error: e.message, generated_sql });
  }
});

function suggestChartType(rows, fields) {
  if (!rows.length || !fields) return 'table';
  const names = fields.map(f => f.name.toLowerCase());
  if (rows.length === 1) return 'number';
  if (names.some(n => ['date','week','month','created_at','day'].some(d => n.includes(d)))) return 'line';
  if (rows.length <= 10 && names.some(n => ['count','total','amount','sum'].some(d => n.includes(d)))) return 'bar';
  return 'table';
}

async function logQuery(user, question, sql, rowCount, error, schema, duration, blocked, blockReason) {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO insights.query_audit (user_id, user_name, query_text, generated_sql, row_count, error_message, schema_scope, duration_ms, blocked, block_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [user.id, `${user.first_name} ${user.last_name}`, question, sql, rowCount, error, schema, duration, blocked, blockReason]
    );
  } catch {}
}

router.get('/audit', async (req, res) => {
  if (!ADMIN_ROLES.has(req.user.role)) return res.status(403).json({ error: 'Admin required' });
  try {
    const db = getPool();
    const limit = Math.min(parseInt(req.query.limit||100), 500);
    const { rows } = await db.query(
      `SELECT * FROM insights.query_audit ORDER BY queried_at DESC LIMIT $1`, [limit]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// RAG DOCUMENT UPLOAD
// ════════════════════════════════════════════════════════════════════════════

router.get('/documents', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT d.*, COUNT(c.id)::int AS chunk_count,
              str.table_name AS staging_table, str.row_count AS staging_rows
       FROM insights.rag_documents d
       LEFT JOIN insights.rag_chunks c ON c.document_id = d.id
       LEFT JOIN insights.staging_tables_registry str ON str.upload_id = d.id
       GROUP BY d.id, str.table_name, str.row_count
       ORDER BY d.uploaded_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/documents/upload', ragUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!ADMIN_ROLES.has(req.user.role)) return res.status(403).json({ error: 'Admin required' });

  const db = getPool();
  const { rows: [doc] } = await db.query(
    `INSERT INTO insights.rag_documents (filename, mime_type, uploaded_by, file_size_bytes, status)
     VALUES ($1,$2,$3,$4,'processing') RETURNING *`,
    [req.file.originalname, req.file.mimetype, req.user.id, req.file.size]
  );

  // Process asynchronously
  processRagUpload(doc.id, req.file.path, req.file.originalname, req.file.mimetype).catch(e => {
    console.error('[insights RAG] process error:', e.message);
  });

  res.status(202).json({ ...doc, message: 'Processing started' });
});

async function processRagUpload(docId, filePath, originalName, mimeType) {
  const db = getPool();
  try {
    let text = '';
    const isCsv = mimeType === 'text/csv' || originalName.endsWith('.csv');

    if (isCsv) {
      // CSV → staging table
      const result = await loadCsvToStaging(filePath, originalName, docId);
      text = `CSV file: ${originalName}\nColumns: ${result.rows > 0 ? 'see staging table' : 'empty'}\nRows: ${result.rows}`;
      await db.query(`UPDATE insights.rag_documents SET status='ready', total_chunks=1 WHERE id=$1`, [docId]);
      return;
    } else if (mimeType === 'application/pdf') {
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      text = data.text;
    } else if (mimeType.includes('wordprocessingml') || mimeType.includes('msword')) {
      const result = await mammoth.extractRawText({ path: filePath });
      text = result.value;
    } else {
      text = fs.readFileSync(filePath, 'utf8');
    }

    const chunks = chunkText(text);
    let chunkIndex = 0;
    for (const chunk of chunks) {
      await db.query(
        `INSERT INTO insights.rag_chunks (document_id, chunk_index, text, search_vector)
         VALUES ($1,$2,$3, to_tsvector('english', $3))`,
        [docId, chunkIndex++, chunk]
      );
    }
    await db.query(
      `UPDATE insights.rag_documents SET status='ready', total_chunks=$1 WHERE id=$2`,
      [chunks.length, docId]
    );
  } catch (e) {
    await db.query(
      `UPDATE insights.rag_documents SET status='failed', error_message=$1 WHERE id=$2`,
      [e.message, docId]
    );
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

router.delete('/documents/:id', async (req, res) => {
  if (!ADMIN_ROLES.has(req.user.role)) return res.status(403).json({ error: 'Admin required' });
  try {
    const db = getPool();
    // Also drop staging table if exists
    const { rows: [reg] } = await db.query(
      'SELECT table_name FROM insights.staging_tables_registry WHERE upload_id=$1', [req.params.id]
    );
    if (reg?.table_name) {
      const safeName = reg.table_name.replace(/[^a-z0-9_]/g,'');
      await db.query(`DROP TABLE IF EXISTS insights_staging."${safeName}"`);
    }
    await db.query('DELETE FROM insights.rag_documents WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /documents/query — RAG search
router.post('/documents/query', async (req, res) => {
  const { question, doc_id } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'question required' });
  if (!checkRate(req.user.id)) return res.status(429).json({ error: 'Rate limit exceeded' });

  try {
    const db = getPool();
    const tsq = question.trim().replace(/[^a-z0-9\s]/gi,'').split(/\s+/).filter(Boolean).join(' & ');
    let qWhere = 'search_vector @@ to_tsquery($1)';
    let vals = [tsq];
    if (doc_id) { vals.push(doc_id); qWhere += ` AND document_id=$${vals.length}`; }

    const { rows: chunks } = await db.query(
      `SELECT c.text, c.chunk_index, d.filename,
              ts_rank(c.search_vector, to_tsquery($1)) AS rank
       FROM insights.rag_chunks c
       JOIN insights.rag_documents d ON d.id = c.document_id
       WHERE ${qWhere} AND d.status='ready'
       ORDER BY rank DESC LIMIT 5`,
      vals
    );

    if (!chunks.length) return res.json({ answer: 'No relevant documents found for that question.', chunks: [] });

    const context = chunks.map((c, i) => `[${i+1}] From "${c.filename}":\n${c.text}`).join('\n\n');
    const prompt = `You are a helpful assistant answering questions about nursery/school documents.
Based on the following document excerpts, answer the question clearly.
Include document citations like [1] when referencing specific content.

Documents:
${context}

Question: ${question}

Answer:`;

    const answer = await callQwen(prompt, MODEL_BIG);
    res.json({
      answer: answer || 'Unable to generate answer.',
      chunks: chunks.map(c => ({ filename: c.filename, excerpt: c.text.slice(0,200), rank: c.rank }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// ANOMALIES & FORECASTS (via stats service)
// ════════════════════════════════════════════════════════════════════════════

router.get('/anomalies', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM insights.anomaly_results
       WHERE run_at = (SELECT MAX(run_at) FROM insights.anomaly_results)
       ORDER BY anomaly_score DESC LIMIT 50`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/forecasts', async (req, res) => {
  const { metric_key } = req.query;
  try {
    const db = getPool();
    const vals = []; let where = '';
    if (metric_key) { vals.push(metric_key); where = `WHERE metric_key=$1`; }
    const { rows } = await db.query(
      `SELECT * FROM insights.forecast_results ${where}
       ORDER BY run_at DESC LIMIT 10`, vals
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats/health', async (req, res) => {
  try {
    const response = await fetch(`${STATS_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await response.json();
    res.json({ available: true, ...data });
  } catch {
    res.json({ available: false, message: 'Stats service not reachable' });
  }
});

// ── Staff history — list + Bradford Factor ───────────────────────────────────
router.get('/staff-history', authenticate, async (req, res) => {
  if (!ADMIN_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'Forbidden' });
  const schema = req.user?.schema || 'ladn';
  const db = getPool();
  try {
    const { from = '', to = '', room_id = '' } = req.query;
    const fromDate = from || new Date(Date.now() - 365*24*60*60*1000).toISOString().slice(0,10);
    const toDate   = to   || new Date().toISOString().slice(0,10);

    // Bradford Factor rolling 52 weeks
    const { rows: bfRows } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.room_id,
        COUNT(DISTINCT a.id)::int       AS spells,
        COALESCE(SUM(a.duration_days),0)::numeric AS total_days,
        (COUNT(DISTINCT a.id)::numeric * COUNT(DISTINCT a.id)::numeric
          * COALESCE(SUM(a.duration_days),0))::numeric AS bradford_factor
      FROM ${schema}.staff s
      LEFT JOIN ${schema}.hr_absences a
        ON a.staff_id = s.id
        AND a.start_date >= CURRENT_DATE - INTERVAL '52 weeks'
        AND a.absence_type NOT ILIKE '%annual leave%'
      WHERE s.is_active = TRUE
        ${room_id ? `AND s.room_id = ${parseInt(room_id, 10)}` : ''}
      GROUP BY s.id, s.first_name, s.last_name, s.room_id
      ORDER BY bradford_factor DESC`);

    // Per-staff absence summary within date range
    const { rows: absRows } = await db.query(`
      SELECT staff_id, absence_type, COUNT(*) AS spells,
        SUM(duration_days) AS total_days
      FROM ${schema}.hr_absences
      WHERE start_date BETWEEN $1 AND $2
        AND absence_type NOT ILIKE '%annual leave%'
      GROUP BY staff_id, absence_type`, [fromDate, toDate]);

    // Holiday utilisation
    const { rows: holRows } = await db.query(`
      SELECT staff_id, SUM(taken_days) AS taken, SUM(entitlement_days) AS entitlement
      FROM ${schema}.hr_holiday_entitlement
      WHERE year_start <= $2::date AND (year_end IS NULL OR year_end >= $1::date)
      GROUP BY staff_id`, [fromDate, toDate]);

    // TOIL totals
    const { rows: toilRows } = await db.query(`
      SELECT staff_id, ROUND(SUM(hours)::numeric, 1) AS total_hours
      FROM ${schema}.hr_toil_entries
      WHERE status = 'Approved'
        AND accrued_date BETWEEN $1 AND $2
      GROUP BY staff_id`, [fromDate, toDate]);

    res.json({ staff: bfRows, absences: absRows, holidays: holRows, toil: toilRows, from: fromDate, to: toDate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /staff-history/:staffId — full timeline for one staff member
router.get('/staff-history/:staffId', authenticate, async (req, res) => {
  if (!ADMIN_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'Forbidden' });
  const schema  = req.user?.schema || 'ladn';
  const staffId = parseInt(req.params.staffId, 10);
  if (!staffId) return res.status(400).json({ error: 'Invalid staffId' });
  const db = getPool();
  try {
    const [absences, holidays, toil, overtime] = await Promise.all([
      db.query(`SELECT absence_type, start_date, end_date, duration_days, duration_hours, is_certified, is_paid, reason
                FROM ${schema}.hr_absences WHERE staff_id=$1 ORDER BY start_date DESC LIMIT 500`, [staffId]),
      db.query(`SELECT year_start, year_end, entitlement_days, taken_days, remaining_days, carried_over_days
                FROM ${schema}.hr_holiday_entitlement WHERE staff_id=$1 ORDER BY year_start DESC`, [staffId]),
      db.query(`SELECT accrued_date, used_date, hours, status, reason
                FROM ${schema}.hr_toil_entries WHERE staff_id=$1 ORDER BY accrued_date DESC LIMIT 200`, [staffId]),
      db.query(`SELECT date, hours, rate, approved, paid, reason
                FROM ${schema}.hr_overtime WHERE staff_id=$1 ORDER BY date DESC`, [staffId]),
    ]);
    res.json({
      absences: absences.rows,
      holidays: holidays.rows,
      toil:     toil.rows,
      overtime: overtime.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /surveillance-confirm
router.post('/surveillance-confirm', async (req, res) => {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO insights.surveillance_confirmations (user_id, target_type, target_id, ip_address)
       VALUES ($1,$2,$3,$4)`,
      [req.user.id, req.body.target_type || 'staff', req.body.target_id || null, req.ip]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.runAllMetrics = runAllMetrics;
