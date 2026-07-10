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

// GET / — list reports (scoped by role)
router.get('/', async (req, res) => {
  const isManager = ['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role);
  try {
    const db = getPool();
    const { child_id } = req.query;
    const params = [];
    let where = '';
    if (child_id) {
      where = 'WHERE pr.child_id=$1';
      params.push(child_id);
    }
    if (!isManager) {
      // Non-managers can only see reports for children in their room
      const { rows: rooms } = await db.query('SELECT room_id FROM staff WHERE id=$1', [req.user.id]);
      if (rooms.length && rooms[0].room_id != null) {
        if (where) where += ' AND '; else where += 'WHERE ';
        where += 'c.room_id = $' + (params.length + 1);
        params.push(rooms[0].room_id);
      } else {
        // Staff without a room sees nothing
        return res.json({ reports: [] });
      }
    }
    const { rows } = await db.query(`
      SELECT pr.*,
             c.first_name, c.last_name, c.preferred_name,
             r.name as room_name,
             s.first_name || ' ' || s.last_name as created_by
      FROM parent_reports pr
      LEFT JOIN children c ON c.id = pr.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = pr.generated_by
      ${where}
      ORDER BY pr.generated_at DESC NULLS LAST, pr.id DESC
      LIMIT 200
    `, params);
    res.json({ reports: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /children — list active children (scoped to room for non-managers)
router.get('/children', async (req, res) => {
  const isManager = ['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role);
  try {
    const db = getPool();
    let q = `
      SELECT c.id, c.first_name, c.last_name, c.preferred_name, r.name as room_name
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      WHERE c.is_active = true
    `;
    const params = [];
    if (!isManager) {
      const { rows: staffRows } = await db.query('SELECT room_id FROM staff WHERE id=$1', [req.user.id]);
      if (staffRows[0]?.room_id != null) {
        q += ' AND c.room_id=$1';
        params.push(staffRows[0].room_id);
      }
    }
    q += ' ORDER BY c.first_name, c.last_name';
    const { rows } = await db.query(q, params);
    res.json({ children: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:child_id — load data for report generation (scoped to room)
router.get('/child/:child_id', async (req, res) => {
  const { child_id } = req.params;
  const { report_type = 'progress' } = req.query;
  const period = datePeriod(report_type);
  try {
    const db = getPool();
    // IDOR guard: verify user has access to this child's room
    const isManager = ['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role);
    if (!isManager) {
      const { rows: staffRows } = await db.query('SELECT room_id FROM staff WHERE id=$1', [req.user.id]);
      const userRoom = staffRows[0]?.room_id;
      if (staffRows.length === 0 || userRoom == null) {
        return res.status(403).json({ error: 'Forbidden — no room assignment' });
      }
      const { rows: childRows } = await db.query('SELECT room_id FROM children WHERE id=$1', [child_id]);
      if (childRows.length && childRows[0].room_id !== userRoom) {
        return res.status(403).json({ error: 'Forbidden — not your child' });
      }
    }
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

// POST /generate — generate AI draft and save (IDOR guard: room-scoped)
router.post('/generate', async (req, res) => {
  const { child_id, report_type = 'progress', practitioner_notes = '' } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  const period = datePeriod(report_type);
  try {
    const db = getPool();
    // IDOR guard: verify user can access this child's room
    const isManager = ['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role);
    if (!isManager) {
      const { rows: staffRows } = await db.query('SELECT room_id FROM staff WHERE id=$1', [req.user.id]);
      const userRoom = staffRows[0]?.room_id;
      if (staffRows.length === 0 || userRoom == null) {
        return res.status(403).json({ error: 'Forbidden — no room assignment' });
      }
      const { rows: childRows } = await db.query('SELECT room_id FROM children WHERE id=$1', [child_id]);
      if (childRows.length && childRows[0].room_id !== userRoom) {
        return res.status(403).json({ error: 'Forbidden — not your child' });
      }
    }
    // Validate child exists
    const childCheck = await db.query('SELECT id FROM children WHERE id=$1', [child_id]);
    if (!childCheck.rows.length) return res.status(404).json({ error: 'Child not found' });

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
router.get('/:id', async (req, res, next) => {
  // Non-numeric ids belong to later routes (/reminders, /checklist/... etc.)
  if (!/^\d+$/.test(req.params.id)) return next();
  const isManager = ['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT pr.*, c.first_name, c.last_name, c.preferred_name,
             pa.email as parent_email
      FROM parent_reports pr
      LEFT JOIN children c ON c.id = pr.child_id
      LEFT JOIN parent_portal_access pa ON pa.child_id = pr.child_id AND pa.is_active = true
      WHERE pr.id=$1
      LIMIT 1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    // IDOR guard: non-managers can only see reports for children in their room
    if (!isManager) {
      const { rows: staffRows } = await db.query('SELECT room_id FROM staff WHERE id=$1', [req.user.id]);
      const userRoom = staffRows[0]?.room_id;
      // Non-managers without a room (or not in staff table) get 403
      if (staffRows.length === 0 || userRoom == null) {
        return res.status(403).json({ error: 'Forbidden — no room assignment' });
      }
      // Note: the JOIN on GET already returns the row from DB (the room_id in rows
      // is from the JOIN, not staff.room_id). Need to compare user's room vs child's room.
      if (userRoom !== r.room_id) {
        return res.status(403).json({ error: 'Forbidden — not your child report' });
      }
    }
    res.json({
      ...r,
      content: r.final_content || r.draft_content,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id — update draft content (IDOR guard: owner/manager only)
router.put('/:id', async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  try {
    const db = getPool();
    // IDOR guard
    const isManager = ['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role);
    if (!isManager) {
      const { rows: staffRows } = await db.query('SELECT room_id FROM staff WHERE id=$1', [req.user.id]);
      const userRoom = staffRows[0]?.room_id;
      // Non-managers without a room (or not in staff table) get 403
      if (staffRows.length === 0 || userRoom == null) {
        return res.status(403).json({ error: 'Forbidden — no room assignment' });
      }
      const { rows: reportRows } = await db.query(
        'SELECT c.room_id FROM parent_reports pr JOIN children c ON c.id=pr.child_id WHERE pr.id=$1', [req.params.id]
      );
      if (reportRows.length && reportRows[0].room_id !== userRoom) {
        return res.status(403).json({ error: 'Forbidden — not your child report' });
      }
    }
    const { rows } = await db.query(`
      UPDATE parent_reports SET draft_content=$1 WHERE id=$2 RETURNING id
    `, [content, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ report: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/finalise — mark final (IDOR guard: owner/manager only)
router.post('/:id/finalise', async (req, res) => {
  const { content } = req.body;
  try {
    const db = getPool();
    // IDOR guard
    const isManager = ['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role);
    if (!isManager) {
      const { rows: staffRows } = await db.query('SELECT room_id FROM staff WHERE id=$1', [req.user.id]);
      const userRoom = staffRows[0]?.room_id;
      if (staffRows.length === 0 || userRoom == null) {
        return res.status(403).json({ error: 'Forbidden — no room assignment' });
      }
      const { rows: reportRows } = await db.query(
        'SELECT c.room_id FROM parent_reports pr JOIN children c ON c.id=pr.child_id WHERE pr.id=$1', [req.params.id]
      );
      if (reportRows.length && reportRows[0].room_id !== userRoom) {
        return res.status(403).json({ error: 'Forbidden — not your child report' });
      }
    }
    const { rows } = await db.query(`
      UPDATE parent_reports
      SET final_content = COALESCE($1, draft_content),
          status = 'finalised',
          finalised_at = NOW()
      WHERE id=$2 RETURNING id, child_id, report_type, final_content
    `, [content || null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    // Termly reports drive the planning cycle: extract the "Next steps" bullets
    // into next_steps rows so NEXT term's report can review whether they were
    // achieved. Re-finalising replaces this report's previously extracted rows.
    const rep = rows[0];
    if (rep.report_type === 'termly' && rep.final_content) {
      try {
        const m = rep.final_content.match(/\*\*Next steps[^*]*\*\*([\s\S]*?)(?=\n\s*\*\*|$)/i);
        if (m) {
          const CLOSERS = /^(thank you|yours|warm(ly| regards)|kind regards|best wishes|we look forward|with love|see you|the practitioner|little angels)/i;
          const bullets = [];
          for (const raw of m[1].split('\n')) {
            const l = raw.replace(/^[\s\-•*\d.)]+/, '').trim();
            if (CLOSERS.test(l)) break;               // sign-off starts — goals are done
            if (l.length > 12) bullets.push(l);
            if (bullets.length >= 6) break;
          }
          await db.query('DELETE FROM next_steps WHERE source_report_id=$1', [rep.id]);
          for (const b of bullets) {
            await db.query(`
              INSERT INTO next_steps (child_id, staff_id, description, status, source_report_id)
              VALUES ($1, $2, $3, 'pending', $4)
            `, [rep.child_id, req.user.id, b, rep.id]);
          }
        }
      } catch (nsErr) { console.error('termly next-steps extract:', nsErr.message); }
    }

    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/send — generate PDF and email parent (IDOR guard: owner/manager/same-room only)
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
    // IDOR guard: check room
    const isManager = ['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role);
    if (!isManager) {
      const { rows: staffRows } = await db.query('SELECT room_id FROM staff WHERE id=$1', [req.user.id]);
      const userRoom = staffRows[0]?.room_id;
      if (staffRows.length === 0 || userRoom == null) {
        return res.status(403).json({ error: 'Forbidden — no room assignment' });
      }
      if (userRoom !== report.room_id) {
        return res.status(403).json({ error: 'Forbidden — not your child report' });
      }
    }
    const content = report.final_content || report.draft_content || '';
    const childName = `${report.first_name} ${report.last_name}`;
    // Collect parent emails from portal access; fall back to child's parents
    const emailRows = await db.query(
      'SELECT email FROM parent_portal_access WHERE child_id=$1 AND is_active=true ORDER BY created_at LIMIT 2',
      [report.child_id]
    );
    const parentEmails = emailRows.rows.map(r => r.email).filter(Boolean);

    if (parentEmails.length === 0) {
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
        from: process.env.SMTP_FROM || 'wren@example-nursery.co.uk',
        to: parentEmails.join(','),
        subject: `${childName}'s ${report.report_type} — Your Nursery`,
        text: `Dear Parent/Carer,\n\nPlease find ${childName}'s ${report.report_type} attached.\n\nWarm regards,\nYour Nursery`,
        attachments: [{ filename: `${childName}-report.pdf`, content: pdfBuf, contentType: 'application/pdf' }],
      });
      await db.query(`UPDATE parent_reports SET status='sent', sent_at=NOW() WHERE id=$1`, [req.params.id]);
      res.json({ ok: true, parent_email: parentEmails.join(', ') });
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

/* ══════════════════════════════════════════════════════════════════════════
 * TWINKL-STYLE REPORT QUESTIONNAIRE (2026-07-03)
 * Flow: GET /checklist/:child_id → practitioner ticks statements per EYFS area
 * + CoEL levels → POST /generate (with selections) → POST /:id/refine to
 * shorten / expand / make parent-friendly.
 * ══════════════════════════════════════════════════════════════════════════ */

// Bigger model for report prose; falls back to OLLAMA_MODEL if unavailable.
const REPORT_MODEL = () => process.env.ASSISTANT_MODEL || 'qwen3.6:35b-a3b';

async function _ollamaGenerate(prompt, model) {
  const r = await fetch(`${OLLAMA_HOST()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, think: false }),
  });
  if (!r.ok) throw new Error(`Ollama error ${r.status}`);
  const data = await r.json();
  return (data.response || '').trim();
}

// Try the big report model first, fall back to the small default.
async function _generateProse(prompt) {
  try {
    return { text: await _ollamaGenerate(prompt, REPORT_MODEL()), model: REPORT_MODEL() };
  } catch (e) {
    console.error('parent-reports: report model failed, falling back:', e.message);
    return { text: await _ollamaGenerate(prompt, OLLAMA_MODEL()), model: OLLAMA_MODEL() };
  }
}

// Shared IDOR guard: non-managers may only touch children in their own room.
async function _guardChildAccess(db, req, childId) {
  const isManager = ['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role);
  if (isManager) return null;
  const { rows: staffRows } = await db.query('SELECT room_id FROM staff WHERE id=$1', [req.user.id]);
  const userRoom = staffRows[0]?.room_id;
  if (staffRows.length === 0 || userRoom == null) return 'Forbidden — no room assignment';
  const { rows: childRows } = await db.query('SELECT room_id FROM children WHERE id=$1', [childId]);
  if (childRows.length && childRows[0].room_id !== userRoom) return 'Forbidden — not your child';
  return null;
}

// Parse "(36-48 months)" / "(8 to 20 months)" / "(48-71 months)" out of an
// age_range label. Returns { lo, hi } in months, or null.
function _parseRangeMonths(label) {
  const m = String(label || '').match(/\((\d+)\s*(?:-|to)\s*(\d+)\+?\s*months?\)/i);
  if (!m) return null;
  return { lo: parseInt(m[1], 10), hi: parseInt(m[2], 10) };
}

// ── Settings helpers (settings key/value) ──────────────────────────────
async function _getSetting(db, key, fallback) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
    return rows.length ? rows[0].value : fallback;
  } catch (_) { return fallback; }
}

// Current term (and half-term point) from the school_terms setting.
async function _currentTerm(db, onDate) {
  const raw = await _getSetting(db, 'school_terms', '[]');
  let terms = [];
  try { terms = JSON.parse(raw); } catch (_) {}
  const d = onDate || new Date().toISOString().slice(0, 10);
  const current = terms.find(t => d >= t.start && d <= t.end) || null;
  // If between terms (holidays), report the most recently ended term so late
  // termly reports can still be written against it.
  const previousEnded = terms.filter(t => t.end < d).sort((a, b) => b.end.localeCompare(a.end))[0] || null;
  const idx = current ? terms.indexOf(current) : -1;
  return {
    terms,
    current: current || previousEnded,
    inTerm: !!current,
    previous: idx > 0 ? terms[idx - 1] : (current ? null : (terms.filter(t => t.end < (previousEnded ? previousEnded.start : d)).sort((a, b) => b.end.localeCompare(a.end))[0] || null)),
  };
}

// GET /reminders — EY home popups: 2-year checks due + termly reports due.
// 2yo age threshold comes from settings.two_year_check_reminder_months (Toby: 22).
// Termly reports are due in the last 4 weeks of each term; children on the SEN
// register also get a mid-term review point (due in the 2 weeks before half-term
// ends) — "adapted dates for SEN/additional needs".
router.get('/reminders', async (req, res) => {
  try {
    const db = getPool();
    const months = parseInt(await _getSetting(db, 'two_year_check_reminder_months', '22'), 10) || 22;

    // 2-year checks: reached the reminder age, not yet 30 months, no check recorded.
    const { rows: twoYear } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, r.name AS room_name,
        (EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 +
         EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)))::int AS age_months
      FROM children c LEFT JOIN rooms r ON r.id=c.room_id
      WHERE c.is_active = true
        AND c.date_of_birth IS NOT NULL
        AND AGE(NOW(), c.date_of_birth) >= make_interval(months => $1)
        AND AGE(NOW(), c.date_of_birth) <  make_interval(months => 30)
        AND NOT EXISTS (SELECT 1 FROM parent_reports pr
                        WHERE pr.child_id=c.id AND pr.report_type='2-year check')
        AND NOT EXISTS (SELECT 1 FROM observations o
                        WHERE o.child_id=c.id AND o.observation_type='2year_check')
      ORDER BY c.date_of_birth
    `, [months]);

    // Termly reports due
    const { current, inTerm } = await _currentTerm(db);
    let termly = [];
    let termlyWindow = null;
    if (current) {
      const today = new Date().toISOString().slice(0, 10);
      const endMinus4w = new Date(new Date(current.end + 'T00:00:00').getTime() - 28 * 86400000).toISOString().slice(0, 10);
      const inEndWindow = inTerm && today >= endMinus4w;
      // SEN mid-term window: 2 weeks up to the end of half-term
      let senWindow = false;
      if (inTerm && current.half_term_end) {
        const htMinus2w = new Date(new Date(current.half_term_end + 'T00:00:00').getTime() - 14 * 86400000).toISOString().slice(0, 10);
        senWindow = today >= htMinus2w && today <= current.half_term_end;
      }
      if (inEndWindow || senWindow || !inTerm) {
        const { rows } = await db.query(`
          SELECT c.id, c.first_name, c.last_name, r.name AS room_name,
                 EXISTS (SELECT 1 FROM sen_register s WHERE s.child_id=c.id) AS sen
          FROM children c LEFT JOIN rooms r ON r.id=c.room_id
          WHERE c.is_active = true
            AND NOT EXISTS (SELECT 1 FROM parent_reports pr
                            WHERE pr.child_id=c.id AND pr.report_type='termly'
                              AND pr.generated_at >= $1::date)
          ORDER BY c.first_name
        `, [current.start]);
        // Everyone in the end-of-term window (or post-term catch-up); SEN children
        // additionally during the half-term window.
        termly = (inEndWindow || !inTerm) ? rows : rows.filter(r => r.sen);
        termlyWindow = (inEndWindow || !inTerm) ? 'end_of_term' : 'sen_half_term';
      }
    }

    res.json({
      two_year: twoYear,
      two_year_from_months: months,
      termly,
      termly_window: termlyWindow,
      term: current,
    });
  } catch (e) {
    console.error('parent-reports reminders:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /checklist/:child_id — statements per EYFS area for the child's age band,
// with tracker status, plus CoEL groups. Powers the questionnaire step.
router.get('/checklist/:child_id', async (req, res) => {
  const { child_id } = req.params;
  try {
    const db = getPool();
    const denied = await _guardChildAccess(db, req, child_id);
    if (denied) return res.status(403).json({ error: denied });

    const { rows: childRows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.preferred_name, r.name AS room_name,
        EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 +
        EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)) AS age_months
      FROM children c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1
    `, [child_id]);
    if (!childRows.length) return res.status(404).json({ error: 'Child not found' });
    const child = childRows[0];
    const age = Math.round(parseFloat(child.age_months) || 0);

    // All B25(LA) statements + this child's tracker status per statement.
    const { rows: stmts } = await db.query(`
      SELECT fs.id, fs.area, fs.aspect, fs.age_range, fs.statement_text,
             ft.status,
             (ft.linked_observation_id IS NOT NULL) AS evidenced
      FROM framework_statements fs
      LEFT JOIN framework_tracker ft
        ON ft.statement_id = fs.id AND ft.child_id = $1
      WHERE fs.framework = 'birth_to_5_la'
      ORDER BY fs.area, fs.aspect, fs.ordinal, fs.id
    `, [child_id]);

    // Keep statements whose range covers the child's age, or ended within the
    // last 12 months (EyLog habit: current range + the one they're moving out of).
    const inBand = stmts.filter(s => {
      const r = _parseRangeMonths(s.age_range);
      if (!r) return false;
      return age >= r.lo && (age <= r.hi || age - r.hi <= 12);
    });
    // Group by area → aspect
    const areas = {};
    for (const s of inBand) {
      const areaKey = s.area.replace(/\bThe\b/g, 'the'); // normalise "Understanding The World"
      (areas[areaKey] = areas[areaKey] || []).push({
        id: s.id, aspect: s.aspect, age_range: s.age_range,
        text: s.statement_text,
        status: s.status || null,
        evidenced: !!s.evidenced,
      });
    }

    // CoEL groups (LADN's coel framework: 3 areas × aspects)
    const { rows: coelRows } = await db.query(`
      SELECT id, area, aspect, statement_text
      FROM framework_statements WHERE framework='coel'
      ORDER BY area, aspect, ordinal, id
    `);
    const coel = {};
    for (const c of coelRows) {
      (coel[c.area] = coel[c.area] || []).push({ id: c.id, aspect: c.aspect, text: c.statement_text });
    }

    res.json({
      child: {
        id: child.id,
        name: (child.preferred_name || child.first_name) + ' ' + (child.last_name || ''),
        first_name: child.preferred_name || child.first_name,
        age_months: age,
        room_name: child.room_name,
      },
      areas,
      coel,
    });
  } catch (e) {
    console.error('parent-reports checklist:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /generate-from-checklist — Twinkl-style: write the report FROM the ticked
// statements (+ CoEL levels + optional practitioner note), grounded in recent obs.
router.post('/generate-from-checklist', async (req, res) => {
  const { child_id, report_type = 'progress', statement_ids = [], coel = [], focus_note = '' } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  if (!Array.isArray(statement_ids) || !statement_ids.length) {
    return res.status(400).json({ error: 'Tick at least one statement first' });
  }
  try {
    const db = getPool();
    const denied = await _guardChildAccess(db, req, child_id);
    if (denied) return res.status(403).json({ error: denied });

    // Termly reports follow the Ealing school term (settings.school_terms);
    // other types keep their rolling windows.
    let period = datePeriod(report_type);
    let termCtx = null;
    if (report_type === 'termly') {
      termCtx = await _currentTerm(db);
      if (termCtx.current) period = { start: termCtx.current.start, end: termCtx.current.end };
    }

    const [childRes, stmtRes, obsRes] = await Promise.all([
      db.query(`
        SELECT c.*, r.name as room_name,
          EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 +
          EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)) as age_months
        FROM children c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1
      `, [child_id]),
      db.query(`
        SELECT area, aspect, statement_text FROM framework_statements
        WHERE id = ANY($1::int[]) ORDER BY area, aspect, ordinal
      `, [statement_ids.map(Number).filter(Boolean)]),
      db.query(`
        SELECT observation_text, created_at::date AS d FROM observations
        WHERE child_id=$1 AND created_at::date BETWEEN $2 AND $3
        ORDER BY created_at DESC LIMIT 6
      `, [child_id, period.start, period.end]),
    ]);
    if (!childRes.rows.length) return res.status(404).json({ error: 'Child not found' });
    const child = childRes.rows[0];
    const name = child.preferred_name || child.first_name;
    const ageMonths = Math.round(parseFloat(child.age_months) || 0);
    const ageStr = ageMonths >= 12
      ? `${Math.floor(ageMonths/12)} year${Math.floor(ageMonths/12)!==1?'s':''} ${ageMonths%12} months`
      : `${ageMonths} months`;

    // Evidence block: ticked statements grouped by area
    const byArea = {};
    for (const s of stmtRes.rows) (byArea[s.area] = byArea[s.area] || []).push(s);
    const evidence = Object.keys(byArea).map(area =>
      `${area}:\n` + byArea[area].map(s => `  - ${s.statement_text}${s.aspect ? ' [' + s.aspect + ']' : ''}`).join('\n')
    ).join('\n');

    const coelBlock = (Array.isArray(coel) && coel.length)
      ? '\nCharacteristics of Effective Learning (practitioner judgement):\n' +
        coel.map(c => `  - ${c.characteristic}: ${c.level}`).join('\n')
      : '';

    const obsQuotes = obsRes.rows.length
      ? '\nRecent observation snippets (use 1-2 as colour, do not quote verbatim at length):\n' +
        obsRes.rows.map(o => `  - [${o.d}] ${(o.observation_text || '').slice(0, 160)}`).join('\n')
      : '';

    const noteBlock = focus_note && focus_note.trim()
      ? `\nPractitioner's note about ${name}:\n${focus_note.trim()}\n` : '';

    // Termly: review the PREVIOUS term's next steps (achieved or still working on)
    // and set fresh ones for next term — EyLog-style planning cycle without the
    // compromise (Toby, 2026-07-03 item 11).
    let termlyBlock = '';
    if (report_type === 'termly' && termCtx && termCtx.current) {
      const prevTerm = termCtx.previous;
      let prevSteps = { rows: [] };
      if (prevTerm) {
        prevSteps = await db.query(`
          SELECT description, status FROM next_steps
          WHERE child_id=$1 AND created_at::date BETWEEN $2 AND $3
          ORDER BY created_at DESC LIMIT 10
        `, [child_id, prevTerm.start, prevTerm.end]).catch(() => ({ rows: [] }));
      }
      const { rows: lastTermly } = await db.query(`
        SELECT draft_content, final_content FROM parent_reports
        WHERE child_id=$1 AND report_type='termly' AND generated_at < $2::date
        ORDER BY generated_at DESC LIMIT 1
      `, [child_id, termCtx.current.start]).catch(() => ({ rows: [] }));

      termlyBlock = `\nThis is the ${termCtx.current.name} TERMLY report. It must review last term and set up next term:\n`;
      if (prevSteps.rows.length) {
        termlyBlock += `Last term's next steps (status from our tracker — 'completed' means achieved):\n` +
          prevSteps.rows.map(s => `  - [${s.status}] ${s.description}`).join('\n') + '\n';
      } else {
        termlyBlock += `No recorded next steps from last term — say this is ${name}'s first termly report cycle.\n`;
      }
      if (lastTermly.length) {
        const prev = (lastTermly[0].final_content || lastTermly[0].draft_content || '').slice(0, 600);
        termlyBlock += `Extract of last term's report for continuity (do not repeat it verbatim):\n${prev}\n`;
      }
    }

    const is2yr = report_type === '2-year check';
    const prompt = `You are writing a ${is2yr ? 'statutory EYFS Progress Check at Age Two' : report_type + ' parent report'} for ${name} ${child.last_name}, aged ${ageStr}, in the ${child.room_name} at Your Nursery, Ealing.

The practitioner has confirmed ${name} is demonstrating the following (Birth to 5 Matters statements, grouped by EYFS area). THESE ARE YOUR SOURCE MATERIAL — every claim in the report must trace back to one of these, the CoEL judgements, or the practitioner's note. Do not invent achievements.

${evidence}
${coelBlock}${obsQuotes}${noteBlock}${termlyBlock}
Write the report in warm, professional UK English, addressed to ${name}'s parents/carers. Use ${name}'s name naturally. Turn the statements into flowing prose — never list or number them, never use framework jargon like "Range 5" or statement codes. ${is2yr
  ? 'Cover ONLY the three prime areas (Communication and Language; Physical Development; Personal, Social and Emotional Development) plus **Next Steps**, using those bold headings. 250-350 words.'
  : report_type === 'termly'
  ? 'Structure: **What ' + name + ' has learned this term** (flowing prose grouped by the EYFS areas you have material for), **Last term\'s next steps** (which were achieved, which we are still working on — honest but positive), **Next steps for next term** (2-4 fresh, specific goals), and a short closing. 300-450 words.'
  : 'Use a bold heading per EYFS area you have material for (skip areas with no ticked statements), then **Next Steps** and a short closing. 300-450 words.'}`;

    const out = await _generateProse(prompt);

    const { rows: saved } = await db.query(`
      INSERT INTO parent_reports (child_id, report_type, period_start, period_end,
        draft_content, status, generated_at, generated_by)
      VALUES ($1, $2, $3, $4, $5, 'draft', NOW(), $6)
      RETURNING id
    `, [child_id, report_type, period.start, period.end, out.text, req.user.id]);

    res.json({ id: saved[0].id, draft: out.text, model: out.model });
  } catch (e) {
    console.error('parent-reports generate-from-checklist:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/refine — rewrite the current draft: shorten / expand / parent_friendly /
// formal / custom instruction. Returns the rewrite; does NOT save (PUT saves).
router.post('/:id/refine', async (req, res) => {
  const { instruction = '', content = '' } = req.body;
  if (!content.trim()) return res.status(400).json({ error: 'content required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT pr.child_id, c.first_name, c.preferred_name FROM parent_reports pr LEFT JOIN children c ON c.id=pr.child_id WHERE pr.id=$1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const denied = await _guardChildAccess(db, req, rows[0].child_id);
    if (denied) return res.status(403).json({ error: denied });
    const name = rows[0].preferred_name || rows[0].first_name || 'the child';

    const CANNED = {
      shorten:         'Shorten this report to roughly two-thirds of its length. Keep every section heading and the warm tone; trim repetition and filler, keep the most specific detail.',
      expand:          'Expand this report by roughly a third. Keep the same facts — do NOT invent new achievements — but develop each point more warmly and add connective prose.',
      parent_friendly: 'Rewrite this report to be more parent-friendly: everyday language, no early-years jargon, shorter sentences, warmer tone. Keep all facts, headings and the same overall length.',
      formal:          'Rewrite this report in a slightly more formal, professional register suitable for sharing with a school or external professional. Keep all facts and headings.',
    };
    const task = CANNED[instruction] || (instruction.trim() ? instruction.trim() : CANNED.parent_friendly);

    const prompt = `Below is a nursery parent report about ${name}. ${task}

Return ONLY the rewritten report, in UK English, keeping the **bold heading** structure.

---
${content.trim()}`;

    const out = await _generateProse(prompt);
    res.json({ draft: out.text, model: out.model });
  } catch (e) {
    console.error('parent-reports refine:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
