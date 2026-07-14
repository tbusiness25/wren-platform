'use strict';
const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');

function pool() { return getPool(); }

// GET /api/email-triage — list with pagination and has_feedback flag
router.get('/', authenticate, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const { rows } = await pool().query(`
      SELECT t.id, t.message_id, t.thread_id, t.received_at, t.from_email, t.from_name,
             t.subject, t.body_preview, t.has_attachments, t.attachment_summary,
             t.classified_at, t.classifier_model, t.category, t.importance,
             t.sender_type, t.summary, t.suggested_action, t.classification_confidence,
             t.alerted_at, t.user_action, t.user_action_at, t.contact_known, t.contact_role,
             EXISTS(SELECT 1 FROM email_triage_feedback f WHERE f.triage_id = t.id) AS has_feedback
      FROM email_triage t
      ORDER BY t.received_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    const { rows: [{ total }] } = await pool().query('SELECT COUNT(*) as total FROM email_triage');
    res.json({ items: rows, total: parseInt(total), limit, offset });
  } catch (e) {
    console.error('email-triage GET error', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email-triage/stats — 7-day summary
router.get('/stats', async (req, res) => {
  try {
    const { rows: [s] } = await pool().query(`
      SELECT
        COUNT(*)::int AS total_7d,
        COUNT(*) FILTER (WHERE alerted_at IS NOT NULL)::int AS alerted_7d,
        (SELECT COUNT(*)::int FROM email_triage_feedback f
           JOIN email_triage t ON f.triage_id = t.id
           WHERE t.received_at > NOW() - INTERVAL '7 days') AS corrections_7d,
        ROUND(AVG(importance)::numeric, 1) AS avg_importance
      FROM email_triage
      WHERE received_at > NOW() - INTERVAL '7 days'
    `);
    const { rows: topCats } = await pool().query(`
      SELECT category, COUNT(*)::int AS cnt
      FROM email_triage
      WHERE received_at > NOW() - INTERVAL '7 days' AND category IS NOT NULL
      GROUP BY category ORDER BY cnt DESC LIMIT 3
    `);
    const { rows: topDomains } = await pool().query(`
      SELECT SPLIT_PART(from_email,'@',2) AS domain, COUNT(*)::int AS cnt
      FROM email_triage
      WHERE received_at > NOW() - INTERVAL '7 days' AND from_email LIKE '%@%'
      GROUP BY domain ORDER BY cnt DESC LIMIT 3
    `);
    res.json({ ...s, top_categories: topCats, top_domains: topDomains });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email-triage/stats/summary — 24h summary (kept for compat)
router.get('/stats/summary', async (req, res) => {
  try {
    const { rows } = await pool().query(`
      SELECT
        COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '24 hours') AS last_24h,
        COUNT(*) FILTER (WHERE alerted_at IS NOT NULL AND received_at > NOW() - INTERVAL '24 hours') AS alerted_24h,
        COUNT(*) FILTER (WHERE importance >= 4 AND received_at > NOW() - INTERVAL '24 hours') AS high_importance_24h,
        COUNT(*) FILTER (WHERE classified_at IS NULL) AS unclassified
      FROM email_triage
    `);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email-triage/rules/list
router.get('/rules/list', authenticate, async (req, res) => {
  try {
    const { rows } = await pool().query(
      'SELECT * FROM email_sender_rules ORDER BY id'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email-triage/rules/list — add rule
router.post('/rules/list', authenticate, async (req, res) => {
  const { pattern, rule, reason } = req.body || {};
  if (!pattern || !rule) return res.status(400).json({ error: 'pattern and rule required' });
  try {
    const { rows } = await pool().query(
      'INSERT INTO email_sender_rules (pattern, rule, reason) VALUES ($1, $2, $3) RETURNING *',
      [pattern, rule, reason || null]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/email-triage/rules/:id
router.delete('/rules/:id', authenticate, async (req, res) => {
  try {
    await pool().query('DELETE FROM email_sender_rules WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email-triage/:id — single message with full body
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows } = await pool().query(
      'SELECT * FROM email_triage WHERE id = $1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email-triage/:id/feedback
router.post('/:id/feedback', authenticate, async (req, res) => {
  const { correction, detail } = req.body || {};
  if (!correction) return res.status(400).json({ error: 'correction required' });
  try {
    await pool().query(
      'INSERT INTO email_triage_feedback (triage_id, correction, detail) VALUES ($1, $2, $3)',
      [req.params.id, correction, detail || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/email-triage/:id/user-action
router.patch('/:id/user-action', authenticate, async (req, res) => {
  const { action } = req.body || {};
  const allowed = ['opened', 'replied', 'archived', 'dismissed'];
  if (!allowed.includes(action)) return res.status(400).json({ error: 'invalid action' });
  try {
    await pool().query(
      'UPDATE email_triage SET user_action=$1, user_action_at=NOW() WHERE id=$2',
      [action, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const OLLAMA_URL = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://localhost:11434';

// POST /api/email-triage/:id/reclassify — re-run Ollama classifier on a single email
router.post('/:id/reclassify', authenticate, async (req, res) => {
  try {
    const { rows } = await pool().query(
      'SELECT id, from_email, from_name, subject, body_preview FROM email_triage WHERE id=$1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const em = rows[0];

    const prompt = `You are an email classifier for Toby Jones, manager of Little Angels Day Nursery in Ealing, West London.
Classify the incoming email. Return ONLY valid JSON with these exact fields:
{"category":"parent|supplier|council|staff|newsletter|spam|personal|transactional|other","importance":3,"sender_type":"human|automated|mixed","summary":"one sentence description","suggested_action":"reply-now|reply-soon|fyi|archive|unsubscribe|spam-report","confidence":0.85,"reasoning":"brief why"}
Importance: 1=spam/auto, 2=info, 3=read, 4=reply within 24h, 5=urgent/safety.

From: ${em.from_name || ''} <${em.from_email || ''}>
Subject: ${em.subject || '(no subject)'}
Body: ${(em.body_preview || '').substring(0, 800)}`;

    const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5:4b', prompt, stream: false, think: false }),
      signal: AbortSignal.timeout(20000),
    });
    const ollamaData = await ollamaRes.json();
    const raw = ollamaData.response || '';

    let cls = { category: 'other', importance: 2, sender_type: 'automated', summary: '', suggested_action: 'fyi', confidence: 0.5 };
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const p = JSON.parse(jsonMatch[0]);
        cls = {
          category: p.category || cls.category,
          importance: Math.min(5, Math.max(1, parseInt(p.importance) || cls.importance)),
          sender_type: p.sender_type || cls.sender_type,
          summary: (p.summary || '').substring(0, 500),
          suggested_action: p.suggested_action || cls.suggested_action,
          confidence: Math.min(1, Math.max(0, parseFloat(p.confidence) || cls.confidence)),
        };
      }
    } catch (e) { /* keep defaults */ }

    await pool().query(
      `UPDATE email_triage SET category=$1, importance=$2, sender_type=$3, summary=$4,
       suggested_action=$5, classification_confidence=$6, classifier_model='qwen2.5:4b', classified_at=NOW()
       WHERE id=$7`,
      [cls.category, cls.importance, cls.sender_type, cls.summary, cls.suggested_action, cls.confidence, req.params.id]
    );

    res.json({ ok: true, ...cls });
  } catch (e) {
    console.error('reclassify error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
