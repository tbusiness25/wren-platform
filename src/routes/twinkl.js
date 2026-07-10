'use strict';
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { encrypt, decrypt, maskKey, searchApi, resolveUrl } = require('../lib/twinkl-client');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER || 'wren',
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || 'wren',
});

const schema = () => process.env.PG_SCHEMA || 'demo_primary';

// ── Settings ─────────────────────────────────────────────────────────────────

// GET /api/twinkl/settings  — returns {configured, masked_key}
router.get('/settings', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(
      `SELECT api_key_enc, api_key_iv, api_key_tag, enabled
       FROM ${s}.twinkl_settings LIMIT 1`
    );
    if (!rows.length || !rows[0].api_key_enc) {
      return res.json({ configured: false, enabled: false, masked_key: null });
    }
    let masked = null;
    try {
      const plain = decrypt(rows[0].api_key_enc, rows[0].api_key_iv, rows[0].api_key_tag);
      masked = maskKey(plain);
    } catch { /* decryption failed — treat as unconfigured */ }
    res.json({ configured: !!masked, enabled: rows[0].enabled, masked_key: masked });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/twinkl/settings  {api_key}  — save encrypted key
router.post('/settings', async (req, res) => {
  const { api_key, configured_by } = req.body;
  if (!api_key || !api_key.trim()) return res.status(400).json({ error: 'api_key required' });
  const s = schema();
  try {
    const { enc_value, iv, tag } = encrypt(api_key.trim());
    // Single-row settings table — always update row id=1 (seeded by migration)
    const result = await pool.query(
      `UPDATE ${s}.twinkl_settings
         SET api_key_enc=$1, api_key_iv=$2, api_key_tag=$3, enabled=true, configured_by=$4, configured_at=NOW()
       WHERE id=(SELECT MIN(id) FROM ${s}.twinkl_settings)`,
      [enc_value, iv, tag, configured_by || null]
    );
    if (result.rowCount === 0) {
      // Settings row missing — insert it
      await pool.query(
        `INSERT INTO ${s}.twinkl_settings (api_key_enc, api_key_iv, api_key_tag, enabled, configured_by)
         VALUES ($1,$2,$3,true,$4)`,
        [enc_value, iv, tag, configured_by || null]
      );
    }
    res.json({ ok: true, masked_key: maskKey(api_key.trim()) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/twinkl/settings  — clear API key
router.delete('/settings', async (req, res) => {
  const s = schema();
  try {
    await pool.query(`UPDATE ${s}.twinkl_settings SET api_key_enc=NULL, api_key_iv=NULL, api_key_tag=NULL, enabled=false`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Search ────────────────────────────────────────────────────────────────────

// GET /api/twinkl/search?q=...&year_group=...&subject=...&key_stage=...
router.get('/search', async (req, res) => {
  const { q, year_group, subject, key_stage } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'q required' });

  const s = schema();
  let apiKey = null;
  try {
    const { rows } = await pool.query(
      `SELECT api_key_enc, api_key_iv, api_key_tag, enabled FROM ${s}.twinkl_settings LIMIT 1`
    );
    if (rows.length && rows[0].enabled && rows[0].api_key_enc) {
      apiKey = decrypt(rows[0].api_key_enc, rows[0].api_key_iv, rows[0].api_key_tag);
    }
  } catch { /* no settings row — fallback mode */ }

  if (!apiKey) {
    return res.json({ mode: 'fallback', results: [], message: 'Twinkl API not configured — use URL paste mode below.' });
  }

  try {
    const results = await searchApi(apiKey, q.trim(), {
      yearGroup: year_group ? Number(year_group) : undefined,
      subject,
      keyStage: key_stage ? Number(key_stage) : undefined,
    });
    res.json({ mode: 'api', results });
  } catch (e) {
    if (e.code === 'INVALID_KEY') {
      return res.json({ mode: 'fallback', results: [], message: 'Twinkl API key is invalid — check Settings.' });
    }
    // API temporarily down — graceful fallback
    console.error('Twinkl search error:', e.message);
    res.json({ mode: 'fallback', results: [], message: 'Twinkl search unavailable right now — use URL paste mode.' });
  }
});

// ── URL resolve ───────────────────────────────────────────────────────────────

// POST /api/twinkl/resolve  {url}  — fetch OG metadata from a Twinkl URL
router.post('/resolve', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const meta = await resolveUrl(url);
    res.json(meta);
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

// ── Attached resources ────────────────────────────────────────────────────────

// GET /api/twinkl/resources?entity_type=homework&entity_id=42
router.get('/resources', async (req, res) => {
  const { entity_type, entity_id } = req.query;
  if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type and entity_id required' });
  const s = schema();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ${s}.lesson_resources WHERE entity_type=$1 AND entity_id=$2 ORDER BY created_at`,
      [entity_type, Number(entity_id)]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/twinkl/resources  {entity_type, entity_id, external_url, title, description, thumbnail_url, tags, created_by}
router.post('/resources', async (req, res) => {
  const { entity_type, entity_id, external_url, title, description, thumbnail_url, tags, created_by } = req.body;
  if (!entity_type || !entity_id || !external_url || !title) {
    return res.status(400).json({ error: 'entity_type, entity_id, external_url and title required' });
  }
  const s = schema();
  try {
    const { rows } = await pool.query(
      `INSERT INTO ${s}.lesson_resources
         (entity_type, entity_id, provider, external_url, title, description, thumbnail_url, tags, created_by)
       VALUES ($1, $2, 'twinkl', $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [entity_type, Number(entity_id), external_url, title, description || null, thumbnail_url || null, tags || [], created_by || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/twinkl/resources/:id
router.delete('/resources/:id', async (req, res) => {
  const s = schema();
  try {
    await pool.query(`DELETE FROM ${s}.lesson_resources WHERE id=$1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
