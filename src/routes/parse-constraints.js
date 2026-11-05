'use strict';

const express              = require('express');
const router               = express.Router();
const { getPool }          = require('../db/pool');
const { requireRole }      = require('../middleware/auth');
const { parseConstraints } = require('../lib/qwen-constraint-parser');

const schema = () => process.env.PG_SCHEMA || 'demo_secondary';
const db     = () => getPool();

// ── Audit table ───────────────────────────────────────────────────────────────

async function ensureAuditTable() {
  const s = schema();
  await db().query(`
    CREATE TABLE IF NOT EXISTS ${s}.timetable_nlc_audit (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER,
      user_name     VARCHAR(100),
      input_text    TEXT NOT NULL,
      constraint_count INTEGER DEFAULT 0,
      parsed_json   JSONB,
      accepted_json JSONB,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

db().query('SELECT 1').then(() => ensureAuditTable()).catch(() => {});

// ── In-memory rate limiter: 10 req / 5 min / user ────────────────────────────

const _rl       = new Map();   // userId → [timestamp, ...]
const RL_MAX    = 10;
const RL_WINDOW = 5 * 60 * 1000;

function checkRate(userId) {
  const now   = Date.now();
  const start = now - RL_WINDOW;
  const hits  = (_rl.get(userId) || []).filter(t => t > start);
  if (hits.length >= RL_MAX) {
    const resetIn = Math.ceil((Math.min(...hits) + RL_WINDOW - now) / 1000);
    return { ok: false, resetIn };
  }
  hits.push(now);
  _rl.set(userId, hits);
  return { ok: true };
}

// ── POST /  — parse free-text constraints ─────────────────────────────────────

router.post(
  '/',
  requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'),
  async (req, res) => {
    const { text, schoolContext = {} } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length < 5)
      return res.status(400).json({ error: 'text is required (min 5 chars)' });
    if (text.length > 4000)
      return res.status(400).json({ error: 'text too long (max 4000 chars)' });

    const uid  = String(req.user?.id || req.ip);
    const rate = checkRate(uid);
    if (!rate.ok) {
      return res.status(429).json({
        error: `Rate limit: max ${RL_MAX} parse requests per 5 minutes. Reset in ${rate.resetIn}s.`,
      });
    }

    try {
      const result = await parseConstraints({ text: text.trim(), schoolContext });

      // Audit log — best-effort, never blocks the response
      db().query(
        `INSERT INTO ${schema()}.timetable_nlc_audit
           (user_id, user_name, input_text, constraint_count, parsed_json)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.user?.id, req.user?.name || null, text.trim(),
         result.constraints.length, JSON.stringify(result.constraints)]
      ).catch(() => {});

      res.json({ constraints: result.constraints, count: result.constraints.length });
    } catch (err) {
      const offline = /unreachable|timeout|ECONNREFUSED/i.test(err.message);
      if (offline) {
        return res.status(503).json({
          error: 'AI parser unavailable — Qwen model offline. Add constraints manually.',
          offline: true,
        });
      }
      res.status(500).json({ error: 'Parse error: ' + err.message });
    }
  }
);

// ── POST /accept  — log which constraints the user accepted ───────────────────

router.post(
  '/accept',
  requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'),
  async (req, res) => {
    const { constraints, inputText } = req.body;
    if (!Array.isArray(constraints))
      return res.status(400).json({ error: 'constraints must be an array' });

    try {
      await db().query(
        `INSERT INTO ${schema()}.timetable_nlc_audit
           (user_id, user_name, input_text, constraint_count, accepted_json)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.user?.id, req.user?.name || null, inputText || '',
         constraints.length, JSON.stringify(constraints)]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;
