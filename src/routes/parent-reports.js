'use strict';
const express  = require('express');
const router   = express.Router();
const PDFDoc   = require('pdfkit');
const nodemailer = require('nodemailer');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const OLLAMA_HOST  = () => process.env.OLLAMA_HOST  || 'http://localhost:11434';
const OLLAMA_MODEL = () => process.env.OLLAMA_MODEL || 'qwen3.5:4b';

function datePeriod(reportType) {
  const now = new Date();
  const end = now.toISOString().split('T')[0];
  let months = 3;
  if (reportType === '2-year check') months = 24;
  else if (reportType === 'leaving')  months = 12;
  const start = new Date(now);
  start.setMonth(start.getMonth() - months);
  return { start: start.toISOString().split('T')[0], end };
}

// GET / — list all reports, optionally ?child_id=X
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const { child_id } = req.query;
    const params = child_id ? [child_id] : [];
    const { rows } = await db.query(`
      SELECT pr.*,
             c.first_name, c.last_name, c.preferred_name,
             r.name as room_name,
             s.first_name || ' ' || s.last_name as created_by
      FROM parent_reports pr
      LEFT JOIN children c ON c.id = pr.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = pr.generated_by
      ${child_id ? 'WHERE pr.child_id=$1' : ''}
      ORDER BY pr.generated_at DESC NULLS LAST, pr.id DESC
      LIMIT 200
    `, params);
    res.json({ reports: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /children — list active children (for selector)
router.get('/children', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.preferred_name, r.name as room_name
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      WHERE c.is_active = true
      ORDER BY c.first_name, c.last_name
    `);
    res.json({ children: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:child_id — load data for report generation
router.get('/child/:child_id', async (req, res) => {
  const { child_id } = req.params;
  const { report_type = 'progress' } = req.query;
  const period = datePeriod(report_type);
  try {
    const db = getPool();
    const [childRes, obsRes, diaryRes, frameworkRes] = await Promise.all([
      db.query(`
        SELECT c.*, r.name as room_name,
          EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 +
          EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)) as age_months
        FROM children c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1
      `, [child_id]),
      db.query(`
        SELECT title, observation_text AS description, eyfs_areas,
               created_at::date AS observation_date, next_steps
        FROM observations
        WHERE child_id=$1 AND created_at::date BETWEEN $2 AND $3
        ORDER BY created_at DESC LIMIT 20
      `, [child_id, period.start, period.end]),
      db.query(`
        SELECT date, mood, meals, activities, notes
        FROM daily_diary
        WHERE child_id=$1 AND date BETWEEN $2 AND $3
        ORDER BY date DESC LIMIT 14
      `, [child_id, period.start, period.end]),
      db.query(`
        SELECT area AS name,
               COUNT(*) FILTER (WHERE status='secure')     AS secure_count,
               COUNT(*) FILTER (WHERE status='developing') AS developing_count,
               COUNT(*) FILTER (WHERE status IN ('emerging','not_yet')) AS emerging_count,
               COUNT(*) AS total_descriptors
        FROM framework_tracker WHERE child_id=$1
        GROUP BY area ORDER BY area
      `, [child_id]),
    ]);
    if (!childRes.rows.length) return res.status(404).json({ error: 'Child not found' });
    res.json({
      child:        childRes.rows[0],
      observations: obsRes.rows,
      diary:        diaryRes.rows,
      b25:          frameworkRes.rows,
      date_range:   { from: period.start, to: period.end },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /generate — generate AI draft and save
router.post('/generate', async (req, res) => {
  const { child_id, report_type = 'progress', practitioner_notes = '' } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });

  const period = datePeriod(report_type);
  try {
    const db = getPool();
    const [childRes, obsRes, frameworkRes, diaryRes] = await Promise.all([
      db.query(`
        SELECT c.*, r.name as room_name,
          EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 +
          EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)) as age_months
        FROM children c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1
      `, [child_id]),
      db.query(`
        SELECT title, observation_text AS description, eyfs_areas,
               created_at::date AS observation_date, next_steps
        FROM observations
        WHERE child_id=$1 AND created_at::date BETWEEN $2 AND $3
        ORDER BY created_at DESC LIMIT 15
      `, [child_id, period.start, period.end]),
      db.query(`
        SELECT area AS name,
               COUNT(*) FILTER (WHERE status='secure')     AS secure_count,
               COUNT(*) FILTER (WHERE status='developing') AS developing_count,
               COUNT(*) FILTER (WHERE status IN ('emerging','not_yet')) AS emerging_count
        FROM framework_tracker WHERE child_id=$1 GROUP BY area ORDER BY area
      `, [child_id]),
      db.query(`
        SELECT mood, activities
        FROM daily_diary
        WHERE child_id=$1 AND date BETWEEN $2 AND $3
        ORDER BY date DESC LIMIT 10
      `, [child_id, period.start, period.end]),
    ]);

    if (!childRes.rows.length) return res.status(404).json({ error: 'Child not found' });
    const child = childRes.rows[0];
    const name = child.preferred_name || child.first_name;
    const ageMonths = Math.round(parseFloat(child.age_months) || 0);
    const ageStr = ageMonths >= 12
      ? `${Math.floor(ageMonths/12)} year${Math.floor(ageMonths/12)!==1?'s':''} ${ageMonths%12} months`
      : `${ageMonths} months`;

    const obsText = obsRes.rows.length
      ? obsRes.rows.map(o =>
          `- [${o.observation_date}] ${o.title || ''}: ${(o.description||'').slice(0,200)}${(o.eyfs_areas||[]).length?' (EYFS: '+(o.eyfs_areas||[]).join(', ')+')':''}`
        ).join('\n')
      : 'No observations recorded in this period.';

    const diaryHighlights = diaryRes.rows
      .flatMap(d => (d.activities || []).slice(0, 2))
      .filter(Boolean).slice(0, 6).join(', ') || 'various activities';

    const frameworkSummary = frameworkRes.rows
      .map(a => `${a.name}: ${a.secure_count||0} secure, ${a.developing_count||0} developing`)
      .join('; ') || 'No tracker data.';

    const notesBlock = practitioner_notes && practitioner_notes.trim()
      ? `\nPractitioner notes and agreed next steps:\n${practitioner_notes.trim()}\n`
      : '';

    let prompt;
    if (report_type === '2-year check') {
      // Statutory EYFS "progress check at age two" — focuses on the 3 PRIME areas only.
      prompt = `You are writing the statutory EYFS Progress Check at Age Two for ${name} ${child.last_name}, aged ${ageStr}, in the ${child.room_name} at Your Nursery, Ealing.

Key observations from ${period.start} to ${period.end}:
${obsText}

Framework tracker summary: ${frameworkSummary}

Recent activities enjoyed: ${diaryHighlights}
${notesBlock}
Write a warm, professional written summary in UK English for the child's parents/carers, as required by the EYFS framework. Use ${name}'s name naturally throughout. The progress check at age two covers ONLY the three PRIME areas of learning. Structure as follows — each section 2–4 sentences describing the child's strengths and any areas where they may need extra support:

**Communication and Language**
**Physical Development**
**Personal, Social and Emotional Development**
**Next Steps** (how the nursery and parents can support development together)

Target 250–350 words total. Quote specific observations where possible. Note this is a shared review between practitioners and parents. Warm but professional tone — this goes to parents.`;
    } else {
      prompt = `You are writing a ${report_type} parent report for ${name} ${child.last_name}, aged ${ageStr}, in the ${child.room_name} at Your Nursery, Ealing.

Key observations from ${period.start} to ${period.end}:
${obsText}

EYFS framework tracker summary: ${frameworkSummary}

Recent activities enjoyed: ${diaryHighlights}
${notesBlock}
Write a warm, professional parent report in UK English. Use ${name}'s name naturally throughout. Structure as follows — each section should be 2–4 sentences:

**Welcome**
**Personal, Social and Emotional Development**
**Communication and Language**
**Physical Development**
**Literacy**
**Mathematics**
**Understanding the World**
**Expressive Arts and Design**
**Next Steps**
**Closing message**

Target 300–400 words total. Quote specific observations where possible. Warm but professional tone — this goes to parents.`;
    }

    const ollamaRes = await fetch(`${OLLAMA_HOST()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL(), prompt, stream: false, think: false }),
    });
    if (!ollamaRes.ok) throw new Error(`Ollama error ${ollamaRes.status}`);
    const ollamaData = await ollamaRes.json();
    const draft = (ollamaData.response || '').trim();

    const { rows: saved } = await db.query(`
      INSERT INTO parent_reports (child_id, report_type, period_start, period_end,
        draft_content, status, generated_at, generated_by)
      VALUES ($1, $2, $3, $4, $5, 'draft', NOW(), $6)
      RETURNING id
    `, [child_id, report_type, period.start, period.end, draft, req.user.id]);

    res.json({ id: saved[0].id, draft });
  } catch (e) {
    console.error('parent-reports generate:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /:id — get single report
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT pr.*, c.first_name, c.last_name, c.preferred_name,
             pa.parent_1_email, pa.parent_2_email
      FROM parent_reports pr
      LEFT JOIN children c ON c.id = pr.child_id
      LEFT JOIN parent_portal_access pa ON pa.child_id = pr.child_id AND pa.is_active = true
      WHERE pr.id=$1
      LIMIT 1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    res.json({
      ...r,
      content: r.final_content || r.draft_content,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id — update draft content
router.put('/:id', async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE parent_reports SET draft_content=$1 WHERE id=$2 RETURNING id
    `, [content, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ report: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/finalise — mark final
router.post('/:id/finalise', async (req, res) => {
  const { content } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE parent_reports
      SET final_content = COALESCE($1, draft_content),
          status = 'finalised',
          finalised_at = NOW()
      WHERE id=$2 RETURNING id
    `, [content || null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/send — generate PDF and email parent
router.post('/:id/send', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT pr.*, c.first_name, c.last_name,
             pa.parent_1_email, pa.parent_2_email
      FROM parent_reports pr
      LEFT JOIN children c ON c.id = pr.child_id
      LEFT JOIN parent_portal_access pa ON pa.child_id = pr.child_id AND pa.is_active = true
      WHERE pr.id=$1 LIMIT 1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const report = rows[0];
    const content = report.final_content || report.draft_content || '';
    const childName = `${report.first_name} ${report.last_name}`;
    const parentEmail = report.parent_1_email || report.parent_2_email;

    if (!parentEmail) {
      return res.status(400).json({ error: 'No parent email on file for this child' });
    }

    // Build PDF in memory
    const pdfBuf = await new Promise((resolve, reject) => {
      const doc = new PDFDoc({ size: 'A4', margin: 60 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).font('Helvetica-Bold')
         .text('Your Nursery', { align: 'center' });
      doc.fontSize(11).font('Helvetica')
         .text('1A Example Lane, Ealing, W13 9LU', { align: 'center' });
      doc.moveDown();
      doc.fontSize(14).font('Helvetica-Bold')
         .text(`${report.report_type} — ${childName}`, { align: 'center' });
      doc.fontSize(11).font('Helvetica')
         .text(`Period: ${report.period_start} to ${report.period_end}`, { align: 'center' });
      doc.moveDown(2);
      doc.fontSize(11).font('Helvetica').text(content, { lineGap: 4 });
      doc.end();
    });

    if (process.env.SMTP_PASS) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.brevo.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'wren@example.com',
        to: [report.parent_1_email, report.parent_2_email].filter(Boolean).join(','),
        subject: `${childName}'s ${report.report_type} — Your Nursery`,
        text: `Dear Parent/Carer,\n\nPlease find ${childName}'s ${report.report_type} attached.\n\nWarm regards,\nYour Nursery`,
        attachments: [{ filename: `${childName}-report.pdf`, content: pdfBuf, contentType: 'application/pdf' }],
      });
      await db.query(`UPDATE parent_reports SET status='sent', sent_at=NOW() WHERE id=$1`, [req.params.id]);
      res.json({ ok: true, parent_email: parentEmail });
    } else {
      // SMTP not configured — return PDF for download
      await db.query(`UPDATE parent_reports SET status='sent', sent_at=NOW() WHERE id=$1`, [req.params.id]);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${childName}-report.pdf"`,
      });
      res.send(pdfBuf);
    }
  } catch (e) {
    console.error('parent-reports send:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
