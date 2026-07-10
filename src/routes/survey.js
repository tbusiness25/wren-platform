const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

// ── PDF + email helper ────────────────────────────────────────────────────
async function generateAndEmailPDF(surveyType, responses, email) {
  if (!email || !process.env.SMTP_HOST || !process.env.SMTP_PASS) return;
  try {
    const PDFDocument = require('pdfkit');
    const nodemailer = require('nodemailer');

    const pdf = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).font('Helvetica-Bold').text('Your Nursery', { align: 'center' });
      doc.fontSize(13).font('Helvetica').text(`Survey: ${surveyType}`, { align: 'center' });
      doc.fontSize(10).text(`Submitted by: ${email}`, { align: 'center' });
      doc.fontSize(10).text(`Date: ${new Date().toLocaleString('en-GB')}`, { align: 'center' });
      doc.moveDown(1.5);

      Object.entries(responses).forEach(([key, val]) => {
        if (key === '_email') return;
        const label = key.replace(/_/g, ' ');
        const value = Array.isArray(val) ? val.join(', ') : String(val ?? '');
        doc.fontSize(10).font('Helvetica-Bold').text(label + ':', { continued: false });
        doc.fontSize(10).font('Helvetica').text(value || '(blank)');
        doc.moveDown(0.4);
      });

      doc.end();
    });

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || 587),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'wren@example-nursery.co.uk',
      to: 'admin@example.com',
      subject: `Survey response: ${surveyType} from ${email}`,
      text: `New survey response from ${email}. See attached PDF.`,
      attachments: [{ filename: `survey-${surveyType}-${Date.now()}.pdf`, content: pdf }]
    });
  } catch (e) {
    console.error('Survey PDF email error:', e.message);
  }
}

// POST /submit — annual parents survey
router.post('/submit', async (req, res) => {
  const { responses } = req.body;
  if (!responses) return res.status(400).json({ error: 'responses required' });
  const email = req.headers['cf-access-authenticated-user-email'] || '';
  try {
    const db = getPool();
    const { rows } = await db.query(
      'INSERT INTO survey_responses (survey_type, responses, email) VALUES ($1,$2,$3) RETURNING id',
      ['parents_annual', JSON.stringify(responses), email || null]
    );
    generateAndEmailPDF('parents_annual', responses, email);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /eylog-feedback
router.post('/eylog-feedback', async (req, res) => {
  const { responses } = req.body;
  if (!responses) return res.status(400).json({ error: 'responses required' });
  const email = req.headers['cf-access-authenticated-user-email'] || '';
  try {
    const db = getPool();
    const { rows } = await db.query(
      'INSERT INTO survey_responses (survey_type, responses, email) VALUES ($1,$2,$3) RETURNING id',
      ['parents_eylog', JSON.stringify(responses), email || null]
    );
    generateAndEmailPDF('parents_eylog', responses, email);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /results/:type — manager only
router.get('/results/:type', authenticate, async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM survey_responses WHERE survey_type=$1 ORDER BY submitted_at DESC',
      [req.params.type]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Survey Templates ──────────────────────────────────────────────────────────

const mgr = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role))
    return res.status(403).json({ error: 'Manager only' });
  next();
};

// GET /templates — list all templates
router.get('/templates', authenticate, mgr, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM survey_responses r WHERE r.template_id = t.id) AS response_count,
        (SELECT COUNT(*) FROM survey_invites i WHERE i.template_id = t.id) AS invite_count,
        (SELECT COUNT(*) FROM survey_invites i WHERE i.template_id = t.id AND i.opened_at IS NOT NULL) AS opened_count,
        (SELECT COUNT(*) FROM survey_invites i WHERE i.template_id = t.id AND i.clicked_at IS NOT NULL) AS clicked_count,
        (SELECT COUNT(*) FROM survey_invites i WHERE i.template_id = t.id AND i.response_id IS NULL AND i.sent_at IS NOT NULL) AS pending_count,
        (SELECT MAX(r.submitted_at) FROM survey_responses r WHERE r.template_id = t.id) AS last_response_at
      FROM survey_templates t
      ORDER BY t.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /templates/:id — single template
router.get('/templates/:id', authenticate, mgr, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM survey_templates WHERE id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /templates — create template
router.post('/templates', authenticate, mgr, async (req, res) => {
  const { name, slug, survey_type, description, questions } = req.body;
  if (!name || !slug || !survey_type) return res.status(400).json({ error: 'name, slug, survey_type required' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO survey_templates (name, slug, survey_type, description, questions)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, slug.toLowerCase().replace(/[^a-z0-9-]/g, '-'), survey_type, description || null, JSON.stringify(questions || [])]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Slug already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /templates/:id — update template
router.put('/templates/:id', authenticate, mgr, async (req, res) => {
  const { name, description, questions, active } = req.body;
  try {
    const { rows } = await getPool().query(
      `UPDATE survey_templates SET
        name        = COALESCE($2, name),
        description = COALESCE($3, description),
        questions   = COALESCE($4::jsonb, questions),
        active      = COALESCE($5, active),
        updated_at  = NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, name || null, description || null,
       questions != null ? JSON.stringify(questions) : null,
       active != null ? active : null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /templates/:id — soft delete (set active=false)
router.delete('/templates/:id', authenticate, mgr, async (req, res) => {
  try {
    await getPool().query(
      'UPDATE survey_templates SET active=false, updated_at=NOW() WHERE id=$1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /templates/:id/responses — response list for a template
router.get('/templates/:id/responses', authenticate, mgr, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT r.*, i.email AS invite_email, i.clicked_at
       FROM survey_responses r
       LEFT JOIN survey_invites i ON i.response_id = r.id
       WHERE r.template_id=$1
       ORDER BY r.submitted_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /templates/:id/send — generate magic-link invites and enqueue emails
router.post('/templates/:id/send', authenticate, mgr, async (req, res) => {
  const db = getPool();
  const templateId = parseInt(req.params.id);
  try {
    const { rows: tpl } = await db.query(
      'SELECT * FROM survey_templates WHERE id=$1 AND active=true', [templateId]
    );
    if (!tpl.length) return res.status(404).json({ error: 'Template not found or inactive' });
    const template = tpl[0];

    // Collect unique parent emails from active children
    const { rows: parents } = await db.query(`
      SELECT DISTINCT lower(trim(e)) AS email, child_id FROM (
        SELECT parent_1_email AS e, id AS child_id FROM children WHERE is_active=true AND parent_1_email IS NOT NULL AND parent_1_email != ''
        UNION ALL
        SELECT parent_2_email, id FROM children WHERE is_active=true AND parent_2_email IS NOT NULL AND parent_2_email != ''
      ) t WHERE lower(trim(e)) ~ '^[^@]+@[^@]+\.[^@]+$'
    `);

    if (!parents.length) return res.status(400).json({ error: 'No parent emails found' });

    const PUBLIC_ORIGIN = process.env.PARENTS_DOMAIN
      ? `https://${process.env.PARENTS_DOMAIN}`
      : 'https://parents.example-nursery.co.uk';

    let created = 0, skipped = 0;
    const invites = [];

    for (const p of parents) {
      // Skip if already invited (per template + email)
      const { rows: existing } = await db.query(
        'SELECT id FROM survey_invites WHERE template_id=$1 AND email=$2',
        [templateId, p.email]
      );
      if (existing.length) { skipped++; continue; }

      const { rows: inv } = await db.query(
        `INSERT INTO survey_invites (template_id, email, child_id, sent_at)
         VALUES ($1,$2,$3,NOW()) RETURNING *`,
        [templateId, p.email, p.child_id || null]
      );
      invites.push({ ...inv[0], url: `${PUBLIC_ORIGIN}/welcome/surveys/${template.slug}?t=${inv[0].token}` });
      created++;
    }

    // Queue emails via comms_email_queue (existing send mechanism)
    for (const inv of invites) {
      const pixel = `${PUBLIC_ORIGIN}/api/survey/open/${inv.token}.gif`;
      const html = `<p>Dear Parent,</p><p>We'd really value your thoughts. Please take a few minutes to complete our survey:</p>`
        + `<p><a href="${inv.url}">Complete the survey →</a></p>`
        + `<p>This link is personal to you — no login needed.</p>`
        + `<p>Thank you,<br>Your Nursery</p>`
        + `<img src="${pixel}" width="1" height="1" alt="" style="display:none">`;
      try {
        await db.query(
          `INSERT INTO comms_email_queue
             (from_email, from_name, subject, status, received_at, draft_text, body_html, classification)
           VALUES ($1,$2,$3,'pending',NOW(),$4,$5,'survey-invite')`,
          [
            inv.email || 'wren@example-nursery.co.uk',
            'Your Nursery',
            `We'd love your feedback — ${template.name}`,
            `Dear Parent,\n\nWe'd really value your thoughts. Please take a few minutes to complete our survey:\n\n${inv.url}\n\nThis link is personal to you — no login needed.\n\nThank you,\nYour Nursery`,
            html
          ]
        );
      } catch (err) { console.error('Survey invite queue error:', err.message); /* non-fatal — invite row still created */ }
    }

    res.json({ ok: true, invites_created: created, skipped, total_parents: parents.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Public dynamic survey renderer ────────────────────────────────────────────

// GET /active — public list of active survey templates (name/slug/desc only) for the
// parents landing page so admin-published surveys are browsable without a magic link.
router.get('/active', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT name, slug, survey_type, description,
              COALESCE(jsonb_array_length(questions),0) AS question_count
       FROM survey_templates WHERE active=true ORDER BY created_at`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /render/:slug — return template JSON for dynamic form (public, no auth)
router.get('/render/:slug', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT id, name, slug, survey_type, description, questions FROM survey_templates WHERE slug=$1 AND active=true',
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Survey not found' });

    // Track invite click if token provided
    const { t: token } = req.query;
    if (token) {
      getPool().query(
        'UPDATE survey_invites SET clicked_at=COALESCE(clicked_at,NOW()) WHERE token=$1',
        [token]
      ).catch(() => {});
    }

    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /submit-template — submit response from dynamic form (public, links to template + invite)
router.post('/submit-template', async (req, res) => {
  const { slug, responses, token } = req.body;
  if (!slug || !responses) return res.status(400).json({ error: 'slug and responses required' });
  const email = req.headers['cf-access-authenticated-user-email'] || req.body.email || '';
  try {
    const db = getPool();
    const { rows: tpl } = await db.query(
      'SELECT * FROM survey_templates WHERE slug=$1 AND active=true', [slug]
    );
    if (!tpl.length) return res.status(404).json({ error: 'Survey not found' });
    const template = tpl[0];

    const { rows } = await db.query(
      `INSERT INTO survey_responses (survey_type, responses, email, template_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [template.survey_type, JSON.stringify(responses), email || null, template.id]
    );
    const responseId = rows[0].id;

    // Link invite to response if token provided
    if (token) {
      await db.query(
        'UPDATE survey_invites SET response_id=$1, clicked_at=COALESCE(clicked_at,NOW()) WHERE token=$2',
        [responseId, token]
      ).catch(() => {});
    }

    generateAndEmailPDF(template.survey_type, responses, email);
    res.json({ ok: true, id: responseId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Open tracking pixel ───────────────────────────────────────────────────────

// 1x1 transparent GIF
const TRACK_PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// GET /open/:token.gif — tracking pixel embedded in invite emails
router.get('/open/:token', async (req, res) => {
  const token = (req.params.token || '').replace(/\.gif$/i, '');
  if (token) {
    getPool().query(
      'UPDATE survey_invites SET opened_at=COALESCE(opened_at,NOW()) WHERE token=$1',
      [token]
    ).catch(() => {});
  }
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.send(TRACK_PIXEL);
});

// ── Results / aggregates ──────────────────────────────────────────────────────

// GET /templates/:id/results — full results: per-question aggregates + engagement
router.get('/templates/:id/results', authenticate, mgr, async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id);
  try {
    const { rows: tpl } = await db.query('SELECT * FROM survey_templates WHERE id=$1', [id]);
    if (!tpl.length) return res.status(404).json({ error: 'Not found' });
    const template = tpl[0];
    const questions = template.questions || [];

    const { rows: responses } = await db.query(
      'SELECT id, responses, email, submitted_at FROM survey_responses WHERE template_id=$1 ORDER BY submitted_at DESC',
      [id]
    );

    // Engagement
    const { rows: [eng] } = await db.query(`
      SELECT
        COUNT(*) AS invited,
        COUNT(*) FILTER (WHERE sent_at IS NOT NULL)   AS sent,
        COUNT(*) FILTER (WHERE opened_at IS NOT NULL)  AS opened,
        COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked,
        COUNT(*) FILTER (WHERE response_id IS NOT NULL) AS responded
      FROM survey_invites WHERE template_id=$1
    `, [id]);

    // Per-question aggregates
    const aggregates = questions.map(q => {
      const agg = { id: q.id, label: q.label, type: q.type, answered: 0 };
      if (q.type === 'rating') {
        let sum = 0, n = 0; const dist = { 1:0,2:0,3:0,4:0,5:0 };
        responses.forEach(r => {
          const v = parseInt(r.responses?.[q.id]);
          if (v >= 1 && v <= 5) { sum += v; n++; dist[v]++; }
        });
        agg.answered = n;
        agg.average = n ? +(sum / n).toFixed(2) : null;
        agg.distribution = dist;
      } else if (q.type === 'yes_no') {
        let yes = 0, no = 0;
        responses.forEach(r => {
          const v = String(r.responses?.[q.id] || '').toLowerCase();
          if (v === 'yes') yes++; else if (v === 'no') no++;
        });
        agg.answered = yes + no;
        agg.counts = { yes, no };
      } else if (q.type === 'multi_choice') {
        const counts = {};
        (q.options || []).forEach(o => { counts[o] = 0; });
        responses.forEach(r => {
          const v = r.responses?.[q.id];
          if (Array.isArray(v)) v.forEach(o => { if (counts[o] != null) counts[o]++; else counts[o] = 1; });
          else if (v != null && v !== '') { counts[v] = (counts[v] || 0) + 1; }
        });
        agg.answered = responses.filter(r => {
          const v = r.responses?.[q.id];
          return Array.isArray(v) ? v.length : (v != null && v !== '');
        }).length;
        agg.counts = counts;
      } else { // text / long_text
        const texts = [];
        responses.forEach(r => {
          const v = r.responses?.[q.id];
          if (v != null && String(v).trim() !== '') texts.push(String(v).trim());
        });
        agg.answered = texts.length;
        agg.texts = texts;
      }
      return agg;
    });

    res.json({
      template: { id: template.id, name: template.name, slug: template.slug, description: template.description, questions },
      engagement: {
        invited:   parseInt(eng.invited),
        sent:      parseInt(eng.sent),
        opened:    parseInt(eng.opened),
        clicked:   parseInt(eng.clicked),
        responded: parseInt(eng.responded),
        response_count: responses.length,
        open_rate:     parseInt(eng.sent)    ? Math.round(eng.opened   / eng.sent    * 100) : null,
        click_rate:    parseInt(eng.sent)    ? Math.round(eng.clicked  / eng.sent    * 100) : null,
        completion_rate: parseInt(eng.clicked) ? Math.round(eng.responded / eng.clicked * 100) : null,
        response_rate: parseInt(eng.sent)    ? Math.round(eng.responded / eng.sent    * 100) : null,
      },
      aggregates,
      responses,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /templates/:id/export.csv — CSV of all responses (manager only)
router.get('/templates/:id/export.csv', authenticate, mgr, async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id);
  try {
    const { rows: tpl } = await db.query('SELECT * FROM survey_templates WHERE id=$1', [id]);
    if (!tpl.length) return res.status(404).json({ error: 'Not found' });
    const template = tpl[0];
    const questions = template.questions || [];

    const { rows: responses } = await db.query(
      'SELECT id, responses, email, submitted_at FROM survey_responses WHERE template_id=$1 ORDER BY submitted_at',
      [id]
    );

    const esc = (v) => {
      if (v == null) return '';
      const s = Array.isArray(v) ? v.join('; ') : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const header = ['Response ID', 'Email', 'Submitted At', ...questions.map(q => q.label)];
    const lines = [header.map(esc).join(',')];
    responses.forEach(r => {
      const row = [r.id, r.email || '', new Date(r.submitted_at).toISOString(),
        ...questions.map(q => r.responses?.[q.id])];
      lines.push(row.map(esc).join(','));
    });

    const fname = (template.slug || 'survey') + '-responses.csv';
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${fname}"`);
    res.send('﻿' + lines.join('\r\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /templates/:id/remind — nudge invitees who haven't responded yet
router.post('/templates/:id/remind', authenticate, mgr, async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id);
  try {
    const { rows: tpl } = await db.query('SELECT * FROM survey_templates WHERE id=$1 AND active=true', [id]);
    if (!tpl.length) return res.status(404).json({ error: 'Template not found or inactive' });
    const template = tpl[0];

    const PUBLIC_ORIGIN = process.env.PARENTS_DOMAIN
      ? `https://${process.env.PARENTS_DOMAIN}`
      : 'https://parents.example-nursery.co.uk';

    // Invitees who were sent but have not responded
    const { rows: pending } = await db.query(
      'SELECT * FROM survey_invites WHERE template_id=$1 AND response_id IS NULL AND sent_at IS NOT NULL',
      [id]
    );

    let reminded = 0;
    for (const inv of pending) {
      const url = `${PUBLIC_ORIGIN}/welcome/surveys/${template.slug}?t=${inv.token}`;
      const pixel = `${PUBLIC_ORIGIN}/api/survey/open/${inv.token}.gif`;
      const html = `<p>Dear Parent,</p><p>Just a gentle reminder that we'd still love your feedback. It only takes a few minutes:</p>`
        + `<p><a href="${url}">Complete the survey →</a></p>`
        + `<p>This link is personal to you — no login needed.</p>`
        + `<p>Thank you,<br>Your Nursery</p>`
        + `<img src="${pixel}" width="1" height="1" alt="" style="display:none">`;
      try {
        await db.query(
          `INSERT INTO comms_email_queue
             (from_email, from_name, subject, status, received_at, draft_text, body_html, classification)
           VALUES ($1,$2,$3,'pending',NOW(),$4,$5,'survey-reminder')`,
          [
            inv.email || 'wren@example-nursery.co.uk',
            'Your Nursery',
            `A quick reminder — ${template.name}`,
            `Dear Parent,\n\nJust a gentle reminder that we'd still love your feedback. It only takes a few minutes:\n\n${url}\n\nThis link is personal to you — no login needed.\n\nThank you,\nYour Nursery`,
            html
          ]
        );
        await db.query('UPDATE survey_invites SET reminded_at=NOW() WHERE id=$1', [inv.id]);
        reminded++;
      } catch (err) { console.error('Survey reminder queue error:', err.message); }
    }

    res.json({ ok: true, reminded, pending: pending.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Comms Hub metrics ─────────────────────────────────────────────────────────

// GET /comms-metrics — aggregated stats for the Comms Hub dashboard cards
router.get('/comms-metrics', authenticate, async (req, res) => {
  const db = getPool();
  try {
    // Newsletter stats
    const { rows: [nlStats] } = await db.query(`
      SELECT
        COUNT(*) AS total_newsletters,
        MAX(sent_at) AS last_sent_at,
        (SELECT sent_to_count FROM newsletters WHERE sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1) AS last_send_count,
        (SELECT COUNT(*) FROM newsletter_sends WHERE status='sent') AS total_sends,
        (SELECT COUNT(*) FROM newsletter_sends WHERE status='failed') AS total_failures
      FROM newsletters
    `).catch(() => ({ rows: [{ total_newsletters: 0 }] }));

    // Survey stats
    const { rows: surveyStats } = await db.query(`
      SELECT t.id, t.name, t.slug,
        (SELECT COUNT(*) FROM survey_responses r WHERE r.template_id=t.id) AS response_count,
        (SELECT COUNT(*) FROM survey_invites i WHERE i.template_id=t.id) AS invite_count,
        (SELECT COUNT(*) FROM survey_invites i WHERE i.template_id=t.id AND i.clicked_at IS NOT NULL) AS clicked_count,
        (SELECT MAX(r.submitted_at) FROM survey_responses r WHERE r.template_id=t.id) AS last_response_at
      FROM survey_templates t WHERE t.active=true ORDER BY t.created_at
    `).catch(() => ({ rows: [] }));

    const { rows: [surveyTotal] } = await db.query(`
      SELECT COUNT(*) AS total_responses FROM survey_responses
    `).catch(() => ({ rows: [{ total_responses: 0 }] }));

    // Permission slip stats
    const { rows: [slipStats] } = await db.query(`
      SELECT
        COUNT(*) AS total_slips,
        COUNT(*) FILTER (WHERE status='sent') AS sent_slips,
        (SELECT COUNT(*) FROM permission_slip_responses WHERE response='pending') AS pending_responses,
        (SELECT COUNT(*) FROM permission_slip_responses WHERE response='approved') AS signed_responses,
        (SELECT MAX(signed_at) FROM permission_slip_responses) AS last_signed_at
      FROM permission_slips
    `).catch(() => ({ rows: [{ total_slips: 0 }] }));

    res.json({
      newsletters: nlStats || {},
      surveys: { templates: surveyStats || [], total_responses: parseInt(surveyTotal?.total_responses || 0) },
      permission_slips: slipStats || {},
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
