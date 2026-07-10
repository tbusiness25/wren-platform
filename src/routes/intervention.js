'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const OLLAMA_URL = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:4b';

router.use(authenticate);

async function streamOllama(systemPrompt, userMessage, res) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      stream: true,
      options: { num_ctx: 4096, temperature: 0.7 },
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) throw new Error(`Ollama error: ${response.status}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    for (const line of chunk.split('\n').filter(l => l.trim())) {
      try {
        const json = JSON.parse(line);
        if (json.message?.content) {
          fullContent += json.message.content;
          res.write(`data: ${JSON.stringify({ content: json.message.content })}\n\n`);
        }
        if (json.done) res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      } catch {}
    }
  }
  res.end();
  return fullContent;
}

// GET /api/interventions — list saved plans
router.get('/', async (req, res) => {
  try {
    const { status, child_id } = req.query;
    let q = `
      SELECT i.*, c.first_name || ' ' || c.last_name AS child_name,
        s.first_name || ' ' || s.last_name AS created_by_name
      FROM interventions i
      JOIN children c ON c.id = i.child_id
      LEFT JOIN staff s ON s.id = i.created_by
      WHERE 1=1
    `;
    const params = [];
    if (status) { params.push(status); q += ` AND i.status = $${params.length}`; }
    if (child_id) { params.push(parseInt(child_id)); q += ` AND i.child_id = $${params.length}`; }
    q += ' ORDER BY i.created_at DESC LIMIT 100';
    const { rows } = await getPool().query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/interventions/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT i.*, c.first_name || ' ' || c.last_name AS child_name,
        s.first_name || ' ' || s.last_name AS created_by_name
      FROM interventions i
      JOIN children c ON c.id = i.child_id
      LEFT JOIN staff s ON s.id = i.created_by
      WHERE i.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/interventions/generate — stream AI intervention plan
router.post('/generate', async (req, res) => {
  try {
    const { child_id, concern, additional_context, child_name, age_months } = req.body;
    if (!concern) return res.status(400).json({ error: 'concern required' });

    const ageStr = age_months
      ? `${Math.floor(age_months / 12)} years ${age_months % 12} months`
      : 'age not specified';

    const systemPrompt = `You are an experienced Early Years specialist at a nursery in England.
You have deep knowledge of:
- The EYFS Statutory Framework 2021 and Development Matters 2021
- Birth to 5 Matters
- The SEND Code of Practice 2015
- Evidence-based early years intervention strategies

Suggest a practical, play-based intervention plan. Structure your response with these exact headings:

**Observable Goals**
(3-4 specific, measurable goals)

**Practitioner Strategies**
(practical scripts and approaches for staff to use day-to-day)

**Environmental Adaptations**
(changes to the room, resources, or routine)

**Parent Partnership Suggestions**
(what parents can do at home)

**Review Date Recommendation**
(suggest a number of weeks for the first review)

Keep suggestions practical and achievable in a busy nursery. Use warm, professional language. Never use clinical diagnostic language. Focus on what the child CAN do.`;

    const userMessage = `Child: ${child_name || 'the child'}, aged ${ageStr}

Area of concern: ${concern}

${additional_context ? `Additional context from practitioner:\n${additional_context}` : ''}

Please write a practical intervention plan.`;

    await streamOllama(systemPrompt, userMessage, res);
  } catch (e) {
    console.error('[intervention] generate error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// POST /api/interventions — save a plan
router.post('/', async (req, res) => {
  try {
    const { child_id, concern, plan, next_review_date } = req.body;
    if (!child_id || !concern || !plan) return res.status(400).json({ error: 'child_id, concern and plan required' });
    const { rows } = await getPool().query(
      `INSERT INTO interventions(child_id, concern, plan, created_by, next_review_date)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [child_id, concern, JSON.stringify(plan), req.user.id, next_review_date || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/interventions/:id — update status
router.put('/:id', async (req, res) => {
  try {
    const { status, next_review_date, plan } = req.body;
    const updates = [];
    const params = [];
    if (status) { params.push(status); updates.push(`status=$${params.length}`); }
    if (next_review_date) { params.push(next_review_date); updates.push(`next_review_date=$${params.length}`); }
    if (plan) { params.push(JSON.stringify(plan)); updates.push(`plan=$${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const { rows } = await getPool().query(
      `UPDATE interventions SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/interventions/:id/review — add review note
router.post('/:id/review', async (req, res) => {
  try {
    const { notes, outcome, next_review_weeks } = req.body;
    const db = getPool();
    const { rows } = await db.query('SELECT reviews FROM interventions WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const reviews = rows[0].reviews || [];
    reviews.push({
      date: new Date().toISOString().slice(0, 10),
      staff_id: req.user.id,
      staff_name: req.user.name,
      notes: notes || '',
      outcome: outcome || '',
    });
    const nextReview = next_review_weeks
      ? new Date(Date.now() + next_review_weeks * 7 * 86400000).toISOString().slice(0, 10)
      : null;
    const updated = await db.query(
      `UPDATE interventions SET reviews=$1, next_review_date=COALESCE($2, next_review_date) WHERE id=$3 RETURNING *`,
      [JSON.stringify(reviews), nextReview, req.params.id]
    );
    res.json(updated.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
