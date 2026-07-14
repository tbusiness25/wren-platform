'use strict';
const express    = require('express');
const router     = express.Router();
const fs         = require('fs');
const nodemailer = require('nodemailer');
const { getPool }       = require('../db/pool');
const authenticate      = require('../middleware/auth');
const { renderNewsletter } = require('../newsletter-renderer');
const { isAllowedRecipient, isManagerRole } = require('../lib/email-allowlist');

const OLLAMA_HOST  = process.env.OLLAMA_HOST  || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:4b';

const managerOnly = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager only' });
  next();
};

// ── List ──────────────────────────────────────────────────────────────────────

// GET /  — list all newsletters
router.get('/', authenticate, managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT id, title, term, academic_year, status, subject,
             sent_at, sent_to_count, created_at, updated_at
      FROM newsletters ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /  — create newsletter
router.post('/', authenticate, managerOnly, async (req, res) => {
  const { title, term, academic_year, subject } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const { rows } = await getPool().query(`
      INSERT INTO newsletters (title, term, academic_year, subject, status)
      VALUES ($1, $2, $3, $4, 'draft') RETURNING *
    `, [title, term || '', academic_year || '2025-2026', subject || title]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single newsletter ─────────────────────────────────────────────────────────

// GET /:id/preview  — HTML for iframe (no auth wall — uses token param fallback)
router.get('/:id/preview', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows: nl } = await db.query('SELECT * FROM newsletters WHERE id=$1', [req.params.id]);
    if (!nl.length) return res.status(404).send('Not found');
    const { rows: sections } = await db.query(
      'SELECT * FROM newsletter_sections WHERE newsletter_id=$1 ORDER BY section_order, id',
      [req.params.id]
    );
    res.set('Content-Type', 'text/html');
    res.send(renderNewsletter(nl[0], sections));
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// GET /:id/export  — download HTML
router.get('/:id/export', authenticate, managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows: nl } = await db.query('SELECT * FROM newsletters WHERE id=$1', [req.params.id]);
    if (!nl.length) return res.status(404).json({ error: 'Not found' });
    const { rows: sections } = await db.query(
      'SELECT * FROM newsletter_sections WHERE newsletter_id=$1 ORDER BY section_order, id',
      [req.params.id]
    );
    const html     = renderNewsletter(nl[0], sections);
    const filename = `newsletter-${(nl[0].term || nl[0].id).toString().replace(/\s+/g, '-').toLowerCase()}.html`;
    res.set('Content-Type', 'text/html');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Literal-path routes MUST be before /:id to prevent "drafts"/"templates"/"reminders" being parsed as integer IDs
router.get('/drafts', authenticate, managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, title, term, academic_year, status, subject, sent_at, sent_to_count, created_at, updated_at
       FROM newsletters ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/templates', authenticate, managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT id, source_filename, tone_notes, brand_colours, uploaded_at FROM newsletter_templates ORDER BY uploaded_at DESC'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/reminders', authenticate, managerOnly, async (req, res) => {
  const included = req.query.included === 'true';
  try {
    const { rows } = await getPool().query(
      `SELECT nr.*, s.first_name || ' ' || s.last_name AS staff_name
       FROM newsletter_reminders nr
       LEFT JOIN staff s ON s.id = nr.added_by
       WHERE nr.included = $1 ORDER BY nr.added_at DESC`,
      [included]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id  — full newsletter + sections
router.get('/:id', authenticate, managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows: nl } = await db.query('SELECT * FROM newsletters WHERE id=$1', [req.params.id]);
    if (!nl.length) return res.status(404).json({ error: 'Not found' });
    const { rows: sections } = await db.query(
      'SELECT * FROM newsletter_sections WHERE newsletter_id=$1 ORDER BY section_order, id',
      [req.params.id]
    );
    res.json({ ...nl[0], sections });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id  — update header fields
router.put('/:id', authenticate, managerOnly, async (req, res) => {
  const { title, term, academic_year, subject, status, from_name } = req.body;
  try {
    const { rows } = await getPool().query(`
      UPDATE newsletters SET
        title         = COALESCE($2, title),
        term          = COALESCE($3, term),
        academic_year = COALESCE($4, academic_year),
        subject       = COALESCE($5, subject),
        status        = COALESCE($6, status),
        from_name     = COALESCE($7, from_name),
        updated_at    = NOW()
      WHERE id=$1 RETURNING *
    `, [req.params.id, title, term, academic_year, subject, status, from_name]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id  — drafts only
router.delete('/:id', authenticate, managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT status FROM newsletters WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].status === 'sent') return res.status(403).json({ error: 'Cannot delete a sent newsletter' });
    await db.query('DELETE FROM newsletters WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sections ──────────────────────────────────────────────────────────────────

// POST /:id/sections  — add section
router.post('/:id/sections', authenticate, managerOnly, async (req, res) => {
  const { section_type, title, raw_notes, metadata } = req.body;
  try {
    const db = getPool();
    const { rows: mx } = await db.query(
      'SELECT COALESCE(MAX(section_order), -1) + 1 AS next FROM newsletter_sections WHERE newsletter_id=$1',
      [req.params.id]
    );
    const { rows } = await db.query(`
      INSERT INTO newsletter_sections
        (newsletter_id, section_type, title, raw_notes, metadata, section_order)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [req.params.id, section_type || 'text', title || '', raw_notes || '',
        JSON.stringify(metadata || {}), mx[0].next]);
    await db.query('UPDATE newsletters SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id/sections/:sid
router.put('/:id/sections/:sid', authenticate, managerOnly, async (req, res) => {
  const { title, raw_notes, ai_draft, final_content, metadata, section_type, section_order } = req.body;
  try {
    const { rows } = await getPool().query(`
      UPDATE newsletter_sections SET
        title         = COALESCE($3, title),
        raw_notes     = COALESCE($4, raw_notes),
        ai_draft      = COALESCE($5, ai_draft),
        final_content = COALESCE($6, final_content),
        metadata      = COALESCE($7::jsonb, metadata),
        section_type  = COALESCE($8, section_type),
        section_order = COALESCE($9, section_order),
        updated_at    = NOW()
      WHERE id=$1 AND newsletter_id=$2 RETURNING *
    `, [req.params.sid, req.params.id, title, raw_notes, ai_draft, final_content,
        metadata != null ? JSON.stringify(metadata) : null, section_type, section_order]);
    if (!rows.length) return res.status(404).json({ error: 'Section not found' });
    await getPool().query('UPDATE newsletters SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id/sections/:sid
router.delete('/:id/sections/:sid', authenticate, managerOnly, async (req, res) => {
  try {
    await getPool().query(
      'DELETE FROM newsletter_sections WHERE id=$1 AND newsletter_id=$2',
      [req.params.sid, req.params.id]
    );
    await getPool().query('UPDATE newsletters SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/sections/:sid/reorder  — direction: 'up'|'down'
router.post('/:id/sections/:sid/reorder', authenticate, managerOnly, async (req, res) => {
  const { direction } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT id, section_order FROM newsletter_sections WHERE newsletter_id=$1 ORDER BY section_order, id',
      [req.params.id]
    );
    const idx = rows.findIndex(s => s.id == req.params.sid);
    if (idx === -1) return res.status(404).json({ error: 'Section not found' });
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= rows.length) return res.json(rows);

    const a = rows[idx], b = rows[swapIdx];
    const ao = a.section_order, bo = b.section_order;
    if (ao === bo) {
      // Assign distinct values
      await db.query('UPDATE newsletter_sections SET section_order=$1 WHERE id=$2', [swapIdx, a.id]);
      await db.query('UPDATE newsletter_sections SET section_order=$1 WHERE id=$2', [idx, b.id]);
    } else {
      await db.query('UPDATE newsletter_sections SET section_order=$1 WHERE id=$2', [bo, a.id]);
      await db.query('UPDATE newsletter_sections SET section_order=$1 WHERE id=$2', [ao, b.id]);
    }
    const { rows: updated } = await db.query(
      'SELECT * FROM newsletter_sections WHERE newsletter_id=$1 ORDER BY section_order, id',
      [req.params.id]
    );
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI draft ─────────────────────────────────────────────────────────────────

// POST /:id/ai-draft
router.post('/:id/ai-draft', authenticate, managerOnly, async (req, res) => {
  const { section_id, raw_notes, section_type, context } = req.body;
  if (!raw_notes) return res.status(400).json({ error: 'raw_notes required' });

  const system = `You are a professional nursery newsletter writer for Little Angels Day Nursery in Ealing, West London. Write in warm, professional British English. Use UK spelling throughout (e.g. recognise not recognize, colour not color). Your writing should be friendly, reassuring, and appropriate for parents of young children aged 6 months to 5 years. Never use Americanisms. Write in flowing paragraphs — 2–3 paragraphs maximum. Do not use bullet points unless specifically asked. Be concise and warm.`;

  const hints = {
    text:          'Expand these notes into 2–3 warm, engaging paragraphs for a parent newsletter.',
    card:          'Expand these notes into a concise, friendly callout card for a parent newsletter. Keep it to 3–5 sentences.',
    security_note: 'Write a brief, reassuring security or safeguarding note for parents based on these points. 2–4 sentences.',
    cta:           'Write friendly, compelling body text for a call-to-action box. 2–3 sentences max.',
  };
  const hint = hints[section_type] || hints.text;
  const prompt = context
    ? `Context: ${context}\n\n${hint}\n\nNotes:\n${raw_notes}`
    : `${hint}\n\nNotes:\n${raw_notes}`;

  try {
    const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        system,
        prompt,
        stream: false,
        think: false,
        options: { num_predict: 700, temperature: 0.72 }
      }),
      signal: AbortSignal.timeout(50000)
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    const data = await r.json();
    let draft = (data.response || '').trim();
    // Strip Qwen3 chain-of-thought tags
    draft = draft.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    if (section_id) {
      await getPool().query(
        'UPDATE newsletter_sections SET ai_draft=$1, updated_at=NOW() WHERE id=$2 AND newsletter_id=$3',
        [draft, section_id, req.params.id]
      );
    }
    res.json({ draft });
  } catch (e) {
    res.status(503).json({ error: 'AI unavailable', detail: e.message });
  }
});

// ── Render ────────────────────────────────────────────────────────────────────

// POST /:id/render
router.post('/:id/render', authenticate, managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows: nl } = await db.query('SELECT * FROM newsletters WHERE id=$1', [req.params.id]);
    if (!nl.length) return res.status(404).json({ error: 'Not found' });
    const { rows: sections } = await db.query(
      'SELECT * FROM newsletter_sections WHERE newsletter_id=$1 ORDER BY section_order, id',
      [req.params.id]
    );
    const html = renderNewsletter(nl[0], sections);
    await db.query('UPDATE newsletters SET rendered_html=$1, updated_at=NOW() WHERE id=$2', [html, req.params.id]);
    res.json({ html });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Send ──────────────────────────────────────────────────────────────────────

// POST /:id/send
router.post('/:id/send', authenticate, managerOnly, async (req, res) => {
  const nlId = req.params.id;
  try {
    const db = getPool();
    const { rows: nl } = await db.query('SELECT * FROM newsletters WHERE id=$1', [nlId]);
    if (!nl.length) return res.status(404).json({ error: 'Not found' });
    const newsletter = nl[0];

    const { rows: sections } = await db.query(
      'SELECT * FROM newsletter_sections WHERE newsletter_id=$1 ORDER BY section_order, id',
      [nlId]
    );
    const html = renderNewsletter(newsletter, sections);

    // Gather parent emails (de-duped)
    const { rows: emailRows } = await db.query(`
      SELECT DISTINCT lower(trim(email)) AS email, parent_name, child_name
      FROM (
        SELECT parent_1_email AS email, parent_1_name AS parent_name,
               first_name || ' ' || last_name AS child_name
        FROM children WHERE is_active=true AND parent_1_email IS NOT NULL AND parent_1_email != ''
        UNION
        SELECT parent_2_email, parent_2_name,
               first_name || ' ' || last_name
        FROM children WHERE is_active=true AND parent_2_email IS NOT NULL AND parent_2_email != ''
      ) e
      WHERE lower(trim(email)) ~ '^[^@]+@[^@]+\\.[^@]+$'
    `);

    if (!emailRows.length) return res.status(400).json({ error: 'No parent emails found' });

    // Staff email blocklist (defence in depth): the send route is already
    // managerOnly, but if a non-manager ever reaches it, restrict delivery to the
    // parent allowlist. For managers this is a no-op (isAllowedRecipient → true).
    let recipientRows = emailRows;
    if (!isManagerRole(req.user)) {
      const checks = await Promise.all(emailRows.map(r => isAllowedRecipient(r.email, req.user)));
      const blocked = emailRows.filter((_, i) => !checks[i]);
      if (blocked.length) {
        return res.status(403).json({ error: 'recipient_not_parent',
          message: 'Staff can only email parents of enrolled children',
          blocked_count: blocked.length });
      }
      recipientRows = emailRows.filter((_, i) => checks[i]);
    }

    const subject = newsletter.subject || newsletter.title || 'Newsletter — Little Angels Day Nursery';
    const smtpOk  = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

    const sent   = [];
    const failed = [];

    // Send via the shared transport: SMTP if set, else the n8n Gmail/Workspace relay (2026-06-16 fix —
    // was silently faking 'sent' to a logfile when SMTP was unconfigured).
    const { sendEmail } = require('../lib/notifications');
    for (const row of recipientRows) {
      let ok = false, errText = null;
      try { ok = await sendEmail(row.email, subject, html, 'newsletter'); }
      catch (err) { errText = err.message; }
      if (ok) {
        sent.push(row.email);
        try { await db.query(
          `INSERT INTO newsletter_sends (newsletter_id,parent_email,parent_name,child_name,status)
           VALUES ($1,$2,$3,$4,'sent')`,
          [nlId, row.email, row.parent_name || '', row.child_name || '']); } catch (_) {}
      } else {
        failed.push({ email: row.email, error: errText || 'sendEmail returned false (no transport)' });
        try { await db.query(
          `INSERT INTO newsletter_sends (newsletter_id,parent_email,parent_name,child_name,status,error_text)
           VALUES ($1,$2,$3,$4,'failed',$5)`,
          [nlId, row.email, row.parent_name || '', row.child_name || '', errText || 'no transport']); } catch (_) {}
      }
    }

        await db.query(`
      UPDATE newsletters
      SET status='sent', sent_at=NOW(), sent_to_count=$2, rendered_html=$3, updated_at=NOW()
      WHERE id=$1
    `, [nlId, sent.length, html]);

    res.json({ sent: sent.length, failed: failed.length, total: recipientRows.length, smtp: smtpOk });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Newsletter Templates ──────────────────────────────────────────────────────

// GET /templates
router.get('/templates', authenticate, managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT id, source_filename, tone_notes, brand_colours, uploaded_at FROM newsletter_templates ORDER BY uploaded_at DESC'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /templates — upload + AI-parse newsletter template
router.post('/templates', authenticate, managerOnly, async (req, res) => {
  const { filename, text_content } = req.body;
  if (!text_content) return res.status(400).json({ error: 'text_content required' });

  const sys = `You are an expert at analysing newsletter templates. Extract the structural and tonal characteristics. Return only valid JSON.`;
  const prompt = `Analyse this newsletter text and extract its template structure:

${text_content.slice(0, 3000)}

Return JSON:
{
  "sections": [
    {"name": "section name", "purpose": "what this section does", "typical_length": "short|medium|long"}
  ],
  "tone": "warm|formal|casual|professional",
  "tone_notes": "description of the writing style",
  "intro_style": "how they start the newsletter",
  "sign_off": "how they end the newsletter",
  "brand_colours": [],
  "typical_sections": ["Manager introduction", "Learning focus this week", "Reminders", "Events coming up"]
}`;

  try {
    const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, system: sys, prompt, stream: false, think: false, options: { num_predict: 800 } }),
      signal: AbortSignal.timeout(60000)
    });
    const data = await r.json();
    let raw = (data.response || '').trim().replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { tone_notes: 'Warm and professional', typical_sections: [] };

    const { rows } = await getPool().query(
      `INSERT INTO newsletter_templates (source_filename, parsed_structure, brand_colours, tone_notes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [filename || 'uploaded-template', JSON.stringify(parsed), parsed.brand_colours || [], parsed.tone_notes || '', req.user.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Newsletter Reminders ───────────────────────────────────────────────────────

// GET /reminders
router.get('/reminders', authenticate, managerOnly, async (req, res) => {
  const included = req.query.included === 'true';
  try {
    const { rows } = await getPool().query(
      `SELECT nr.*, s.first_name || ' ' || s.last_name AS staff_name
       FROM newsletter_reminders nr
       LEFT JOIN staff s ON s.id = nr.added_by
       WHERE nr.included = $1 ORDER BY nr.added_at DESC`,
      [included]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /reminders — add a "include in newsletter" item
router.post('/reminders', authenticate, async (req, res) => {
  const { source_type, source_id, note } = req.body;
  if (!note) return res.status(400).json({ error: 'note required' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO newsletter_reminders (added_by, source_type, source_id, note)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, source_type || 'manual', source_id || null, note]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /reminders/:id/include — mark as included in a newsletter
router.patch('/reminders/:id/include', authenticate, managerOnly, async (req, res) => {
  const { newsletter_id } = req.body;
  try {
    const { rows } = await getPool().query(
      `UPDATE newsletter_reminders SET included=true, newsletter_id=$2 WHERE id=$1 RETURNING *`,
      [req.params.id, newsletter_id || null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /reminders/:id
router.delete('/reminders/:id', authenticate, managerOnly, async (req, res) => {
  try {
    await getPool().query('DELETE FROM newsletter_reminders WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auto-draft from planning ──────────────────────────────────────────────────

// POST /:id/pull-planning — pull next week's planning into a new section
router.post('/:id/pull-planning', authenticate, managerOnly, async (req, res) => {
  const { week_starting, room_id } = req.body;
  if (!week_starting) return res.status(400).json({ error: 'week_starting required' });
  try {
    const db = getPool();

    // Fetch planning activities for that week
    const { rows: plans } = await db.query(
      `SELECT day, eyfs_area, activity_title, role_of_adult
       FROM weekly_plans
       WHERE week_commencing=$1 AND ($2::int IS NULL OR room_id=$2)
       ORDER BY CASE day WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 ELSE 6 END`,
      [week_starting, room_id || null]
    );

    // Fetch reminders not yet included
    const { rows: reminders } = await db.query(
      `SELECT note, source_type FROM newsletter_reminders WHERE included=false ORDER BY added_at DESC LIMIT 10`
    );

    // Fetch term plan for context
    const { rows: termRow } = await db.query(
      `SELECT theme, learning_intentions FROM medium_term_plans WHERE room_id=$1 ORDER BY updated_at DESC LIMIT 1`,
      [room_id || 1]
    );
    const theme = termRow[0]?.theme || '';

    const planSummary = plans.length
      ? plans.map(p => `${p.day}: ${p.activity_title} (${p.eyfs_area})`).join('\n')
      : 'No planned activities found for this week.';

    const reminderText = reminders.length
      ? reminders.map(r => `- ${r.note}`).join('\n')
      : '';

    const sys = `You are writing a warm, professional nursery newsletter for Little Angels Day Nursery in Ealing, West London. Use British English. Write in 2-3 flowing paragraphs per section. Never use bullet points. Be warm, reassuring, and engaging for parents.`;

    const prompt = `Write TWO newsletter sections based on this week's planning:

Theme this half-term: ${theme || 'general'}

Next week's activities:
${planSummary}

${reminderText ? `Things to mention:\n${reminderText}` : ''}

Write:
1. A "Learning Focus" section (2 paragraphs) describing what children will be doing next week and what they'll be learning.
2. A "Reminders" section (1-2 short paragraphs) covering the items to mention above if any.

Return JSON:
{
  "learning_focus": "...",
  "reminders": "..."
}`;

    const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, system: sys, prompt, stream: false, think: false, options: { num_predict: 1200 } }),
      signal: AbortSignal.timeout(90000)
    });
    const data = await r.json();
    let raw = (data.response || '').trim().replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const content = m ? JSON.parse(m[0]) : { learning_focus: raw, reminders: '' };

    // Insert sections into the newsletter
    const nlDb = getPool();
    const { rows: mx } = await nlDb.query(
      'SELECT COALESCE(MAX(section_order), -1) + 1 AS next FROM newsletter_sections WHERE newsletter_id=$1',
      [req.params.id]
    );
    let nextOrder = mx[0].next;

    const inserted = [];
    if (content.learning_focus) {
      const { rows: s1 } = await nlDb.query(
        `INSERT INTO newsletter_sections (newsletter_id, section_type, title, ai_draft, raw_notes, section_order)
         VALUES ($1,'text','Learning Focus This Week',$2,$3,$4) RETURNING *`,
        [req.params.id, content.learning_focus, planSummary, nextOrder++]
      );
      inserted.push(s1[0]);
    }
    if (content.reminders && content.reminders.trim()) {
      const { rows: s2 } = await nlDb.query(
        `INSERT INTO newsletter_sections (newsletter_id, section_type, title, ai_draft, raw_notes, section_order)
         VALUES ($1,'card','Reminders',$2,$3,$4) RETURNING *`,
        [req.params.id, content.reminders, reminderText, nextOrder++]
      );
      inserted.push(s2[0]);
    }

    // Mark used reminders as included
    if (reminders.length) {
      await nlDb.query(
        `UPDATE newsletter_reminders SET included=true, newsletter_id=$1 WHERE included=false`,
        [req.params.id]
      );
    }

    // Update newsletter week_starting
    await nlDb.query('UPDATE newsletters SET week_starting=$1, updated_at=NOW() WHERE id=$2', [week_starting, req.params.id]);

    res.json({ ok: true, sections_added: inserted.length, sections: inserted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /auto-draft — create a full newsletter draft from planning (one-shot)
router.post('/auto-draft', authenticate, managerOnly, async (req, res) => {
  const { week_starting, room_id, template_id, title } = req.body;
  if (!week_starting) return res.status(400).json({ error: 'week_starting required' });
  try {
    const db = getPool();

    // Create newsletter record
    const weekDate = new Date(week_starting);
    const weekStr = weekDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const nlTitle = title || `Newsletter — week beginning ${weekStr}`;
    const { rows: nlRows } = await db.query(
      `INSERT INTO newsletters (title, subject, status, week_starting, auto_generated, template_id)
       VALUES ($1,$2,'draft',$3,true,$4) RETURNING *`,
      [nlTitle, nlTitle, week_starting, template_id || null]
    );
    const nl = nlRows[0];

    // Fetch template structure if provided
    let toneNotes = 'warm and professional British English, flowing paragraphs';
    if (template_id) {
      const { rows: tmpl } = await db.query('SELECT tone_notes, parsed_structure FROM newsletter_templates WHERE id=$1', [template_id]);
      if (tmpl.length && tmpl[0].tone_notes) toneNotes = tmpl[0].tone_notes;
    }

    // Gather data
    const [plansRes, remindersRes, birthdaysRes] = await Promise.all([
      db.query(
        `SELECT day, eyfs_area, activity_title FROM weekly_plans
         WHERE week_commencing=$1 AND ($2::int IS NULL OR room_id=$2)
         ORDER BY CASE day WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 ELSE 6 END`,
        [week_starting, room_id || null]
      ),
      db.query('SELECT note, source_type FROM newsletter_reminders WHERE included=false ORDER BY added_at DESC LIMIT 8'),
      db.query(`
        SELECT first_name, date_of_birth
        FROM children WHERE is_active=true
        AND EXTRACT(MONTH FROM date_of_birth) = EXTRACT(MONTH FROM $1::date)
        AND EXTRACT(DAY FROM date_of_birth) BETWEEN EXTRACT(DAY FROM $1::date) AND EXTRACT(DAY FROM $1::date) + 7
      `, [week_starting])
    ]);

    const planSummary = plansRes.rows.map(p => `${p.day}: ${p.activity_title} (${p.eyfs_area})`).join('\n') || 'Varied activities across all EYFS areas';
    const reminderText = remindersRes.rows.map(r => r.note).join('\n');
    const birthdayText = birthdaysRes.rows.map(r => `${r.first_name}`).join(', ');

    const sys = `You are writing a warm, professional weekly nursery newsletter for Little Angels Day Nursery, Ealing. ${toneNotes}. Use British English. Never use bullet points in the newsletter body. Write in flowing paragraphs.`;

    const prompt = `Create a complete newsletter for the week beginning ${weekStr}.

Activities planned this week:
${planSummary}

${reminderText ? `Items to include:\n${reminderText}` : ''}
${birthdayText ? `\nBirthdays this week: ${birthdayText}` : ''}

Write the following sections and return as JSON:
{
  "manager_intro": "Warm opening paragraph from the manager (2-3 sentences)",
  "learning_focus": "Description of learning activities and what children will be working on (2-3 paragraphs)",
  "birthdays": "${birthdayText ? `A warm birthday mention` : ''}",
  "reminders": "${reminderText ? 'Reminders paragraph covering the items listed above' : ''}",
  "closing": "Warm sign-off (1-2 sentences)"
}`;

    const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, system: sys, prompt, stream: false, think: false, options: { num_predict: 1500 } }),
      signal: AbortSignal.timeout(120000)
    });
    const aiData = await r.json();
    let raw = (aiData.response || '').trim().replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const jsonM = raw.match(/\{[\s\S]*\}/);
    const sections = jsonM ? JSON.parse(jsonM[0]) : { manager_intro: raw };

    // Insert sections
    let order = 0;
    const sectionDefs = [
      { key: 'manager_intro', title: "Manager's Introduction", type: 'text' },
      { key: 'learning_focus', title: 'Learning Focus This Week', type: 'text' },
      { key: 'birthdays', title: 'Birthdays', type: 'card' },
      { key: 'reminders', title: 'Reminders', type: 'card' },
      { key: 'closing', title: 'From the Team', type: 'text' }
    ];
    for (const def of sectionDefs) {
      const content = sections[def.key];
      if (!content || !content.trim()) continue;
      await db.query(
        `INSERT INTO newsletter_sections (newsletter_id, section_type, title, ai_draft, section_order)
         VALUES ($1,$2,$3,$4,$5)`,
        [nl.id, def.type, def.title, content, order++]
      );
    }

    // Mark reminders as included
    if (remindersRes.rows.length) {
      await db.query('UPDATE newsletter_reminders SET included=true, newsletter_id=$1 WHERE included=false', [nl.id]);
    }

    res.json({ ok: true, newsletter_id: nl.id, title: nl.title, sections_added: order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Legacy compat routes (old newsletter.html still references these) ─────────

router.get('/drafts', authenticate, managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, title, term, academic_year, status, subject, sent_at, sent_to_count, created_at, updated_at
       FROM newsletters ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/draft', authenticate, managerOnly, async (req, res) => {
  const { id, term, subject, html_content, manager_intro, academic_year } = req.body;
  try {
    const db = getPool();
    let row;
    if (id) {
      const { rows } = await db.query(`
        UPDATE newsletters SET
          term=COALESCE($2,term), subject=COALESCE($3,subject),
          html_content=COALESCE($4,html_content), manager_intro=COALESCE($5,manager_intro),
          academic_year=COALESCE($6,academic_year), updated_at=NOW()
        WHERE id=$1 RETURNING *
      `, [id, term, subject, html_content, manager_intro, academic_year]);
      row = rows[0];
    } else {
      const title = subject || 'Newsletter';
      const { rows } = await db.query(`
        INSERT INTO newsletters (title,term,subject,html_content,manager_intro,academic_year,status)
        VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING *
      `, [title, term, subject, html_content, manager_intro, academic_year || '2025-2026']);
      row = rows[0];
    }
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
