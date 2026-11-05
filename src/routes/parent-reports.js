'use strict';
const express  = require('express');
const router   = express.Router();
const PDFDoc   = require('pdfkit');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
// b268 — corrected age for children born premature (About Me → premature_weeks)
const { correctedAge } = require('../lib/corrected-age');
// b315 — the ONE room writer. Recording a transition must not be a fifth way to
// half-move a child.
const childRoom = require('../lib/child-room');

router.use(authenticate);

// b333: host + models from the one resolver (src/lib/ai-models.js). OLLAMA_MODEL is
// the general 'default' role — the fallback when the report model fails.
const ai = require('../lib/ai-models');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const OLLAMA_HOST  = () => ai.host();
const OLLAMA_MODEL = () => ai.model('default');

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
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner']);
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
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner']);
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
    const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner']);
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
        WHERE child_id=$1 AND date BETWEEN $2 AND $3 AND status='published'
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
    const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner']);
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
        WHERE child_id=$1 AND date BETWEEN $2 AND $3 AND status='published'
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
      // b333: a whole parent report — the 'heavy' role, like the checklist route below.
      body: JSON.stringify({ model: REPORT_MODEL(), prompt, stream: false, think: false, options: ai.options() }),
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
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner']);
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
    const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner']);
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
    const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner']);
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
          const CLOSERS = /^(thank you|yours|warm(ly| regards)|kind regards|best wishes|we look forward|with love|see you|the practitioner|our nursery)/i;
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
    const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner']);
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
         .text('123 Example Lane, Your Town, AB1 2CD', { align: 'center' });
      doc.moveDown();
      doc.fontSize(14).font('Helvetica-Bold')
         .text(`${report.report_type} — ${childName}`, { align: 'center' });
      doc.fontSize(11).font('Helvetica')
         .text(`Period: ${report.period_start} to ${report.period_end}`, { align: 'center' });
      doc.moveDown(2);
      doc.fontSize(11).font('Helvetica').text(content, { lineGap: 4 });
      doc.end();
    });

    // b491 (2026-10-12, HR audit M10): dev/test environments never send real mail.
    // login-20261023: through the one email sender (src/lib/notifications.js sendEmailDetailed: Gmail service
    // account first, dev guard, email_audit) instead of a private SMTP transport.
    const _esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const _sent = await require('../lib/notifications').sendEmailDetailed(parentEmails.join(','),
      `${childName}'s ${report.report_type} — Your Nursery`,
      `<p>Dear Parent/Carer,</p><p>Please find ${_esc(childName)}'s ${_esc(report.report_type)} attached.</p><p>Warm regards,<br>Your Nursery</p>`,
      'parent_report', [{ filename: `${childName}-report.pdf`, content: pdfBuf, contentType: 'application/pdf' }]);
    if (_sent.ok) {
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

// Report prose is the 'heavy' role; falls back to OLLAMA_MODEL ('default') if that call fails.
const REPORT_MODEL = () => ai.model('heavy');

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
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner']);
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
        -- Also count checks recorded on the native Wren "2-year check" screen
        -- (ey/two-year-check.html → /api/two-year-checks → module_records). Without
        -- this the popup nagged even after the key person completed the check in-app.
        -- (item 12, 2026-07-29)
        AND NOT EXISTS (SELECT 1 FROM module_records mr
                        JOIN modules m ON m.id = mr.module_id
                        WHERE mr.entity_id = c.id AND mr.entity_type='child'
                          AND mr.is_deleted = false
                          AND m.slug = 'assess-eyfs-2yr-progress-check')
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
        cam.premature_weeks,
        EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 +
        EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)) AS age_months
      FROM children c
      LEFT JOIN rooms r ON r.id=c.room_id
      LEFT JOIN child_about_me cam ON cam.child_id=c.id
      WHERE c.id=$1
    `, [child_id]);
    if (!childRows.length) return res.status(404).json({ error: 'Child not found' });
    const child = childRows[0];
    const age = Math.round(parseFloat(child.age_months) || 0);
    // b268 — a child born early is developmentally younger than their birthday says.
    // The statements below are still selected on actual age (the band filter already
    // keeps the range they are moving out of, which covers the corrected age), but the
    // practitioner is told plainly which age to read them against.
    const ca = correctedAge(age, child.premature_weeks);

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
        premature_weeks: ca.premature_weeks,               // b268
        corrected_age_months: ca.corrected_age_months,     // b268
        corrected_age_label: ca.corrected_label || null,   // b268
        corrected_age_note: ca.note,                       // b268
      },
      areas,
      coel,
    });
  } catch (e) {
    console.error('parent-reports checklist:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Item 11 (2026-07-30, a practitioner/EY): tracking/REVIEW view for the report flow ──
// Staff asked to see the child's current observations + where they are per area
// BEFORE writing. GET /profile/:child_id returns, for each of the 7 EYFS areas
// (and their sub-areas / aspects): the current Birth-to-5 range the child is
// working within (derived from framework_tracker), secure/developing counts, and
// the recent observations tagged to that area. Read-only — feeds the new Step 1.5.

// Canonical 7 EYFS areas (match framework_statements.area; "the World" lower-cased).
const EYFS_AREAS = [
  'Communication and Language',
  'Physical Development',
  'Personal, Social and Emotional Development',
  'Literacy',
  'Mathematics',
  'Understanding the World',
  'Expressive Arts and Design',
];
// Observation eyfs_areas tags come in many spellings (PSED, "Communication &
// Language", "Understanding The World"…). Fold them onto the canonical names.
function _canonArea(raw) {
  const s = String(raw || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.startsWith('communication')) return 'Communication and Language';
  if (s.startsWith('physical'))      return 'Physical Development';
  if (s === 'psed' || s.startsWith('personal')) return 'Personal, Social and Emotional Development';
  if (s.startsWith('literacy'))      return 'Literacy';
  if (s.startsWith('math') || s.startsWith('numeracy')) return 'Mathematics';
  if (s.startsWith('understanding')) return 'Understanding the World';
  if (s.startsWith('expressive'))    return 'Expressive Arts and Design';
  return null;
}
// "Range 3 (18-24 months)" -> 3 ; "Range 1-2 (0-18 months)" -> 2 (upper bound).
function _rangeNum(label) {
  const m = String(label || '').match(/range\s*(\d+)(?:\s*[-–]\s*(\d+))?/i);
  if (!m) return null;
  return m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10);
}
// tracking-20261030 — best-fit range from [{rn, n, recent}] evidence (see the profile route): the highest
// range holding at least TWO ticks in the last 6 months (all time when the window has fewer than two).
// One stray tick can no longer set a child's range. Compared on prod against the old "highest single
// tick" and a one-third-share rule (scripts/tracker-bestfit-compare.js): this one moved the fewest
// child-areas below their age range while removing most of the single-tick inflation.
function _bestFitRange(ev) {
  if (!ev || !ev.length) return { range: null, highest: null, basis: null };
  const highest = Math.max(...ev.map(e => e.rn));
  const useRecent = ev.reduce((t, e) => t + e.recent, 0) >= 2;
  const by = {};
  for (const e of ev) { const k = useRecent ? e.recent : e.n; if (k) by[e.rn] = (by[e.rn] || 0) + k; }
  const ranges = Object.keys(by).map(Number).sort((x, y) => y - x);
  const two = ranges.find(r => by[r] >= 2);
  const range = two != null ? two : ranges[0];
  const ticks = ranges.reduce((t, r) => t + by[r], 0);
  return { range, highest, basis: { ticks, window: useRecent ? 'last 6 months' : 'all time',
                                    rule: 'highest range with 2+ ticks' } };
}
// The B25 range a child's age falls in (for the "age-expected around Range N" hint).
function _expectedRange(months) {
  const m = Math.max(0, Math.round(months || 0));
  if (m < 9)  return 1;
  if (m < 18) return 2;
  if (m < 24) return 3;
  if (m < 36) return 4;
  if (m < 48) return 5;
  return 6;
}

router.get('/profile/:child_id', async (req, res) => {
  const { child_id } = req.params;
  try {
    const db = getPool();
    const denied = await _guardChildAccess(db, req, child_id);
    if (denied) return res.status(403).json({ error: denied });

    const { rows: childRows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.preferred_name, r.name AS room_name,
        cam.premature_weeks,
        (EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 +
         EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)))::int AS age_months
      FROM children c
      LEFT JOIN rooms r ON r.id=c.room_id
      LEFT JOIN child_about_me cam ON cam.child_id=c.id
      WHERE c.id=$1
    `, [child_id]);
    if (!childRows.length) return res.status(404).json({ error: 'Child not found' });
    const child = childRows[0];
    const age = Math.round(parseFloat(child.age_months) || 0);
    // b268 — "age-expected around Range N" is exactly the judgement prematurity
    // distorts, so a premature child gets both numbers and is told which is which.
    const caProf = correctedAge(age, child.premature_weeks);

    const [trackRes, obsRes, rangeRes] = await Promise.all([
      db.query(`
        SELECT area, aspect, age_range, status, COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE assessed_at >= NOW() - INTERVAL '6 months')::int AS recent
        FROM framework_tracker
        WHERE child_id=$1 AND framework='birth_to_5_la'
        GROUP BY area, aspect, age_range, status
      `, [child_id]),
      db.query(`
        SELECT id, title, observation_text, eyfs_areas, next_steps,
               created_at::date AS d
        FROM observations
        WHERE child_id=$1 AND created_at >= NOW() - INTERVAL '15 months'
        ORDER BY created_at DESC LIMIT 40
      `, [child_id]),
      /* b278/b291 — the RANGE a practitioner actually recorded for each area,
       * and how secure they judged the child to be in it. This is a professional
       * judgement; `current_range` below is only an inference from which
       * statements happen to be ticked. Where both exist, the recorded one is
       * the one a report should quote. Guarded — a pre-b278 instance has no
       * table and the profile still renders. */
      db.query(`
        SELECT DISTINCT ON (area) area, range_ordinal, range_label, security, context, judged_on
          FROM child_range_judgements
         WHERE child_id=$1 AND framework='birth_to_5_la'
         ORDER BY area, judged_on DESC, id DESC
      `, [child_id]).catch(() => ({ rows: [] })),
    ]);

    // Keyed by canonical area name so it lines up with areaMap below.
    const recordedRange = {};
    for (const r of (rangeRes.rows || [])) {
      const a = _canonArea(r.area);
      if (a) recordedRange[a] = r;
    }

    // Fold tracker rows into per-area (and per-aspect) structures.
    const WORKING = new Set(['secure', 'developing', 'observed', 'emerging']);
    const areaMap = {};
    for (const a of EYFS_AREAS) {
      areaMap[a] = { area: a, secure: 0, developing: 0, emerging: 0, observed: 0,
                     not_yet: 0, assessed: 0, current_range: null, secure_range: null,
                     aspects: {}, _obs: [], _ev: [] };
    }
    for (const row of trackRes.rows) {
      const area = _canonArea(row.area);
      if (!area || !areaMap[area]) continue;
      const rn = _rangeNum(row.age_range);
      const st = row.status || 'not_yet';
      const A = areaMap[area];
      if      (st === 'secure')     A.secure     += row.n;
      else if (st === 'developing') A.developing += row.n;
      else if (st === 'emerging')   A.emerging   += row.n;
      else if (st === 'observed')   A.observed   += row.n;
      else                          A.not_yet    += row.n;
      if (st !== 'not_yet') A.assessed += row.n;
      if (rn != null) {
        if (WORKING.has(st))  A._ev.push({ rn, n: row.n, recent: row.recent || 0 });
        if (st === 'secure')  A.secure_range  = Math.max(A.secure_range  || 0, rn);
        const asp = row.aspect || 'General';
        const AS = (A.aspects[asp] = A.aspects[asp] ||
          { aspect: asp, current_range: null, secure_range: null, secure: 0, developing: 0, _ev: [] });
        if (st === 'secure')     AS.secure     += row.n;
        else if (st === 'developing') AS.developing += row.n;
        if (WORKING.has(st)) AS._ev.push({ rn, n: row.n, recent: row.recent || 0 });
        if (st === 'secure') AS.secure_range  = Math.max(AS.secure_range  || 0, rn);
      }
    }
    // tracking-20261030 — the inferred range is a BEST FIT, not the highest single tick. Until today
    // one Range 6 tag (most rows are EyLog-imported "observed" ticks with no assessor) made a child read
    // "working in Range 6". Now: the highest range that at least a third of the child's evidence in the
    // area sits in or above, counting only the last 6 months when there are 2+ ticks in that window.
    // The old figure is kept as highest_range_seen so a screen can still show the outlier.
    for (const a of EYFS_AREAS) {
      const A = areaMap[a];
      const fit = _bestFitRange(A._ev);
      A.current_range = fit.range; A.highest_range_seen = fit.highest; A.range_basis = fit.basis;
      for (const AS of Object.values(A.aspects)) {
        const f2 = _bestFitRange(AS._ev);
        AS.current_range = f2.range; AS.highest_range_seen = f2.highest; delete AS._ev;
      }
    }

    // Attach recent observations to their areas (an obs can carry several tags).
    const unmapped = [];
    for (const o of obsRes.rows) {
      const snippet = (o.observation_text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      const item = { id: o.id, date: o.d, title: o.title || '', snippet,
                     next_steps: ((o.next_steps || '').trim().slice(0, 200)) || null };
      const tags = Array.isArray(o.eyfs_areas) ? o.eyfs_areas : [];
      const canon = [...new Set(tags.map(_canonArea).filter(Boolean))];
      if (!canon.length) { unmapped.push(item); continue; }
      for (const a of canon) areaMap[a]._obs.push(item);
    }

    const areas = EYFS_AREAS.map(a => {
      const A = areaMap[a];
      // b291 — the recorded judgement, kept separate from the inferred one so a
      // screen can show which is which rather than silently mixing them.
      const rec = recordedRange[A.area] || null;
      return {
        area: A.area,
        current_range: A.current_range,
        current_range_label: A.current_range ? 'Range ' + A.current_range : null,
        highest_range_seen: A.highest_range_seen,
        range_basis: A.range_basis,
        recorded_range: rec ? rec.range_ordinal : null,
        recorded_range_label: rec ? rec.range_label : null,
        // NULL means not yet rated. Never coerced to 'emerging'.
        recorded_security: rec ? (rec.security || null) : null,
        recorded_security_label: rec ? B291_SECURITY.label(rec.security) : null,
        recorded_on: rec ? _ymdLocal(rec.judged_on) : null,
        secure_range: A.secure_range,
        counts: { secure: A.secure, developing: A.developing, emerging: A.emerging,
                  observed: A.observed, not_yet: A.not_yet, assessed: A.assessed },
        aspects: Object.values(A.aspects).sort((x, y) => x.aspect.localeCompare(y.aspect)),
        observations: A._obs.slice(0, 8),
        obs_count: A._obs.length,
      };
    });

    res.json({
      child: {
        id: child.id,
        name: (child.preferred_name || child.first_name) + ' ' + (child.last_name || ''),
        first_name: child.preferred_name || child.first_name,
        age_months: age,
        room_name: child.room_name,
        premature_weeks: caProf.premature_weeks,               // b268
        corrected_age_months: caProf.corrected_age_months,     // b268
        corrected_age_label: caProf.corrected_label || null,   // b268
        corrected_age_note: caProf.note,                       // b268
      },
      expected_range: _expectedRange(age),
      // b268 — the range the corrected age falls in; null when nothing to correct.
      expected_range_corrected: caProf.corrected_age_months == null
        ? null : _expectedRange(caProf.corrected_age_months),
      areas,
      unmapped_observations: unmapped.slice(0, 8),
      total_observations: obsRes.rows.length,
    });
  } catch (e) {
    console.error('parent-reports profile:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /generate-from-checklist — write the report from the practitioner's
// assessment (+ CoEL levels + optional practitioner note), grounded in recent obs.
// b278 (2026-09-04): that assessment is now the RANGE per area, not a list of
// ticked statements. `statement_ids` is still accepted for older clients (the
// demo editions still send it), but the LADN screens send `ranges`.
/* b291 — the three security terms, from the one definition the picker, the
 * validator and the tracker grid all share. */
const B291_SECURITY = require('../../public/js/wren-security-rating.js');

/** A pg DATE arrives as a local-midnight JS Date. toISOString() would shift it
 *  a day west of Greenwich, so read the local parts. */
function _ymdLocal(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* b278 — statements that GROUND a report, derived from the ranges recorded for
 * it. Never written back anywhere: the report records a range, and this only
 * decides what prose the model is allowed to draw on.
 *
 * Preference order per area:
 *   1. statements inside the chosen range that the tracker already evidences
 *      (they were tagged by observations — this reads them);
 *   2. failing that, every statement in that range, which is what the range
 *      itself describes.
 */
async function _statementsForRanges(db, childId, framework, ranges) {
  const { rows: bands } = await db.query(`
    SELECT DISTINCT area, aspect, age_range, MIN(ordinal) AS ord
      FROM framework_statements
     WHERE framework = $1 AND is_active AND statement_text NOT LIKE '(stub%'   -- b332
     GROUP BY area, aspect, age_range
     ORDER BY MIN(ordinal) NULLS LAST
  `, [framework]);
  if (!bands.length) return { ids: [], note: '' };

  // Same two shapes as the tracker grid: numbered "Range N" in age_range
  // (Birth to 5 Matters), or the band in aspect (Fledge). Derived, not configured.
  const numbered = bands.every(b => /^\s*Range\s*\d/i.test(String(b.age_range || '')));
  const posOf = (b) => {
    if (numbered) {
      const m = /^\s*Range\s*(\d+)/i.exec(String(b.age_range || ''));
      return m ? parseInt(m[1], 10) : null;
    }
    const m = /^\s*(?:Band|Stage|Step|Phase)\s*(\d+)/i.exec(String(b.aspect || ''));
    return m ? parseInt(m[1], 10) : null;
  };

  const ids = [];
  const noteLines = [];
  for (const r of ranges) {
    const ord = parseInt(r.range_ordinal, 10);
    if (!r.area || !ord) continue;
    const match = bands.filter(b => b.area === r.area && posOf(b) === ord);
    if (!match.length) continue;
    const label = numbered ? match[0].age_range : match[0].aspect;

    const conds = numbered
      ? `fs.area = $2 AND fs.age_range = ANY($3::text[])`
      : `fs.area = $2 AND fs.aspect = ANY($3::text[])`;
    const keys = [...new Set(match.map(b => (numbered ? b.age_range : b.aspect)))];

    const { rows: evidenced } = await db.query(`
      SELECT fs.id FROM framework_statements fs
      JOIN framework_tracker ft
        ON ft.statement_id = fs.id AND ft.child_id = $4 AND ft.framework = $1
       AND COALESCE(ft.status,'') NOT IN ('not_yet','not_observed','na')
      WHERE fs.framework = $1 AND fs.is_active AND ${conds}
      ORDER BY fs.ordinal NULLS LAST, fs.id
      LIMIT 40
    `, [framework, r.area, keys, childId]);

    let picked = evidenced.map(x => x.id);
    if (!picked.length) {
      const { rows: all } = await db.query(`
        SELECT fs.id FROM framework_statements fs
        WHERE fs.framework = $1 AND fs.is_active AND ${conds}
        ORDER BY fs.ordinal NULLS LAST, fs.id
        LIMIT 40
      `, [framework, r.area, keys]);
      picked = all.map(x => x.id);
    }
    ids.push(...picked);
    /* b291 — how secure the child is IN that range rides with it. This is the
     * difference between "working in Range 4" and "working in Range 4 and doing
     * it independently", and it should change what the report says. An area with
     * no rating is stated as NOT RATED so the model neither guesses at it nor
     * quietly writes as though it were secure. */
    const sec = B291_SECURITY.normalise(r.security);
    const how = sec
      ? `${B291_SECURITY.label(sec).toLowerCase()} — ${B291_SECURITY.meta(sec).help}`
      : 'how secure has NOT been rated — do not describe how consistent or independent they are in this area';
    noteLines.push(`  - ${r.area}: ${label} · ${how}`);
  }

  return {
    ids: [...new Set(ids)],
    note: noteLines.length
      ? "\nPractitioner's best-fit range for each area, and how secure the child is in it " +
        '(this is the assessment the report records — describe where the child is and how ' +
        'consistently they are doing it, but never quote the range label, the words ' +
        '"emerging/developing/secure", or any code back to the parent):\n' +
        noteLines.join('\n') + '\n'
      : '',
  };
}

router.post('/generate-from-checklist', async (req, res) => {
  const { child_id, report_type = 'progress', coel = [], focus_note = '' } = req.body;
  let { statement_ids = [] } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });

  /* b278 — a report records the RANGE, not statements (Toby, 2026-09-04:
   * "tagging statements in obs, and ranges in reports"). The screen now sends
   * `ranges`, and the statements that ground the prose are DERIVED here from
   * what the tracker already holds inside the chosen range — nobody ticks them.
   * `statement_ids` is still accepted so an older client keeps working. */
  const ranges = Array.isArray(req.body.ranges) ? req.body.ranges : [];
  const rangeFramework = req.body.framework || 'birth_to_5_la';
  let rangeNote = '';

  if (!Array.isArray(statement_ids)) statement_ids = [];
  if (!statement_ids.length && !ranges.length) {
    return res.status(400).json({ error: 'Record a range for at least one area first' });
  }
  try {
    const db = getPool();
    const denied = await _guardChildAccess(db, req, child_id);
    if (denied) return res.status(403).json({ error: denied });

    if (ranges.length) {
      const derived = await _statementsForRanges(db, child_id, rangeFramework, ranges);
      statement_ids = derived.ids;
      rangeNote = derived.note;
      if (!statement_ids.length) {
        return res.status(400).json({
          error: 'No framework statements found for those ranges — check the framework selection',
        });
      }
    }

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

The practitioner has recorded ${name}'s best-fit range in each area${rangeNote ? ' (below)' : ''}, and the developmental statements that sit inside those ranges follow. THESE ARE YOUR SOURCE MATERIAL — every claim in the report must trace back to one of these, the CoEL judgements, or the practitioner's note. Do not invent achievements.
${rangeNote}
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
      eylog_style:     'Rewrite this report in the concise, observational EyLog house style the staff are used to: shorter factual sentences, present the learning area by area under the same bold headings, plainly state what the child can now do and the immediate next step, minimal flourish. Keep all facts, headings and UK English.',
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

/* ══════════════════════════════════════════════════════════════════════════
 * b93 REPORT ENGINE (2026-07-17)
 * - GET /report-tracker  — every child × required reports, anchored to each
 *   child's own start date (settling, transition, 2-yr check, termly,
 *   6-month conversation cycle, leaver). Powers the EY Report Tracker page.
 * - POST /log-chat       — record a 6-month parent conversation (short note,
 *   stored as a finalised parent_reports row, report_type 'parent-chat').
 * - POST /room-move      — log a child moving rooms (feeds transition +
 *   re-settling requirements on the tracker).
 * Auto-draft generation lives in scripts/report-engine-nightly.js.
 * ══════════════════════════════════════════════════════════════════════════ */

// Cadence toggles — LADN can run termly auto-reports, the start-anchored
// 6-month cycle, both, or neither (settings rows, 'on'/'off').
async function _engineToggles(db) {
  return {
    termly: (await _getSetting(db, 'report_engine_termly_auto', 'off')) === 'on',
    cycle:  (await _getSetting(db, 'report_engine_cycle_auto',  'off')) === 'on',
  };
}

// Current term for the termly cadence: funding_terms row covering the date
// (spec source), falling back to the settings.school_terms list already used
// by the summative flow.
async function _engineTerm(db, onDate) {
  const d = onDate || new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await db.query(`
      SELECT name, start_date::text AS start, end_date::text AS end
      FROM funding_terms
      WHERE start_date <= $1::date AND end_date >= $1::date
      ORDER BY is_current DESC, start_date DESC LIMIT 1
    `, [d]);
    if (rows.length) return { ...rows[0], source: 'funding_terms' };
  } catch (_) {}
  const t = await _currentTerm(db, d);
  return t.current ? { name: t.current.name, start: t.current.start, end: t.current.end, source: 'school_terms' } : null;
}

function _addDays(iso, days) {
  return new Date(new Date(iso + 'T00:00:00Z').getTime() + days * 86400000).toISOString().slice(0, 10);
}
function _addMonths(iso, months) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
function _dueStatus(due, today) {
  if (due < today) return 'overdue';
  if (due <= _addDays(today, 14)) return 'due_soon';
  return 'upcoming';
}
// A matched report row → 'done' (finalised/sent) or 'draft' (needs review)
function _matchStatus(rep) {
  return (rep.status === 'finalised' || rep.status === 'sent') ? 'done' : 'draft';
}

// GET /report-tracker — the per-child required-reports matrix.
router.get('/report-tracker', async (req, res) => {
  try {
    const db = getPool();
    const today = new Date().toISOString().slice(0, 10);
    const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner']);

    const params = [];
    let where = 'WHERE c.is_active = true';
    if (req.query.room_id) { params.push(req.query.room_id); where += ` AND c.room_id=$${params.length}`; }
    if (req.query.staff_id) { params.push(req.query.staff_id); where += ` AND c.key_person_id=$${params.length}`; }
    if (req.query.mine) { params.push(req.user.id); where += ` AND c.key_person_id=$${params.length}`; }
    if (!isManager) {
      const { rows: staffRows } = await db.query('SELECT room_id FROM staff WHERE id=$1', [req.user.id]);
      const userRoom = staffRows[0]?.room_id;
      if (userRoom == null) return res.json({ children: [], summary: [] });
      params.push(userRoom); where += ` AND c.room_id=$${params.length}`;
    }

    const { rows: kids } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.preferred_name,
             c.date_of_birth::text AS dob, c.start_date::text AS start_date,
             c.leave_date::text AS leave_date, c.room_id, r.name AS room_name,
             c.key_person_id, s.first_name || ' ' || s.last_name AS key_person_name,
             (EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 +
              EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)))::int AS age_months
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = c.key_person_id
      ${where}
      ORDER BY r.name NULLS LAST, c.first_name, c.last_name
    `, params);
    if (!kids.length) return res.json({ children: [], summary: [] });

    const ids = kids.map(k => k.id);
    const { rows: reps } = await db.query(`
      SELECT id, child_id, report_type, status, generated_at::date::text AS generated_on
      FROM parent_reports WHERE child_id = ANY($1::int[])
      ORDER BY generated_at DESC NULLS LAST, id DESC
    `, [ids]);
    let moves = [];
    try {
      const r = await db.query(`
        SELECT child_id, moved_on::text AS moved_on, to_room_id
        FROM child_room_moves WHERE child_id = ANY($1::int[]) ORDER BY moved_on DESC
      `, [ids]);
      moves = r.rows;
    } catch (_) { /* table optional */ }

    const toggles = await _engineToggles(db);
    const term = toggles.termly ? await _engineTerm(db, today) : null;

    const byChild = {};
    for (const r of reps) (byChild[r.child_id] = byChild[r.child_id] || []).push(r);
    const latestOf = (cid, type, sinceDate) => (byChild[cid] || []).find(r =>
      r.report_type === type && (!sinceDate || (r.generated_on && r.generated_on >= sinceDate))) || null;
    const countOf = (cid, type) => (byChild[cid] || []).filter(r => r.report_type === type).length;

    const children = kids.map(k => {
      const items = [];
      const push = (type, label, due, matched, opts) => {
        const it = {
          type, label, due_date: due,
          status: matched ? _matchStatus(matched) : _dueStatus(due, today),
          report_id: matched ? matched.id : null,
          ...(opts || {}),
        };
        items.push(it);
      };

      // 1) Settling-in — ~6 weeks after start (children started >12 months ago
      //    with no settling report are grandfathered, not flagged overdue forever).
      if (k.start_date) {
        const matched = latestOf(k.id, 'settling');
        if (matched || k.start_date >= _addMonths(today, -12)) {
          // b244 (2026-08-28): 42 → 56 days. Toby's window is "4-8 weeks after
          // start date", and this tracker has one date per row rather than a
          // due/overdue pair, so it takes the OVERDUE end — 8 weeks. That makes
          // it flag overdue on the same day src/lib/report-cycle.js does; the
          // 14-day due_soon band in _dueStatus() then lights up inside the
          // 4–8 week window, which is when it should be being written.
          push('settling', 'Settling-in', _addDays(k.start_date, 56), matched, { write_type: 'settling' });
        }
      }

      // 2) Transition + new-room settling — from child_room_moves (logged via POST /room-move)
      for (const m of moves.filter(m => m.child_id === k.id)) {
        if (m.moved_on < _addMonths(today, -12)) continue;
        const matched = latestOf(k.id, 'transition', m.moved_on);
        push('transition', 'Room transition', _addDays(m.moved_on, 42), matched, { write_type: 'transition' });
      }

      // 3) Statutory 2-year check — due at 30 months.
      //    b244 (2026-08-28): was 22 months. Toby was explicit that LADN does this
      //    check at 2½, which is what the health visitor's 2–2½ year review needs,
      //    and 30 months is now the schedule in src/lib/report-cycle.js and in
      //    settings.report_cycle_two_year_due_months. Two boards disagreeing about
      //    the date of a statutory document is worse than either board being wrong
      //    on its own, so this anchor moves with it.
      //    The 24–36 month statutory WINDOW is unchanged; so is the 20-month point
      //    at which the row starts appearing as 'upcoming'.
      if (k.dob) {
        const matched = latestOf(k.id, '2-year check');
        if (matched || (k.age_months >= 20 && k.age_months < 36)) {
          push('2-year check', '2-year check', _addMonths(k.dob, 30), matched, { write_type: '2-year check' });
        }
      }

      // 4) Termly report (cadence toggle) — due one week before term end.
      if (term && (!k.start_date || k.start_date <= term.end)) {
        const matched = latestOf(k.id, 'termly', term.start);
        push('termly', 'Termly report (' + term.name + ')', _addDays(term.end, -7), matched, { write_type: 'termly' });
      }

      // 5) 6-month conversation cycle from the child's OWN start date (cadence
      //    toggle): +6mo parent chat, +12mo full written report, alternating.
      //    Shows the earliest unmet milestone due within the next 8 weeks.
      if (toggles.cycle && k.start_date) {
        const horizon = _addDays(today, 56);
        let chatsNeeded = 0, writtenNeeded = 0, pending = null;
        for (let n = 6; n <= 72; n += 6) {
          const due = _addMonths(k.start_date, n);
          if (due > horizon) break;
          if (k.leave_date && due > k.leave_date) break;
          const isChat = (n % 12) === 6;
          if (isChat) chatsNeeded++; else writtenNeeded++;
          const met = isChat ? countOf(k.id, 'parent-chat') >= chatsNeeded
                             : countOf(k.id, 'progress') >= writtenNeeded;
          if (!met && !pending) pending = { n, due, isChat };
        }
        if (pending) {
          push(pending.isChat ? 'parent-chat' : 'written',
               pending.isChat ? 'Parent chat (+' + pending.n + 'mo)' : 'Written report (+' + pending.n + 'mo)',
               pending.due, null,
               pending.isChat ? { log_chat: true } : { write_type: 'progress' });
        } else if (chatsNeeded + writtenNeeded > 0) {
          const lastChat = latestOf(k.id, 'parent-chat');
          const lastWritten = latestOf(k.id, 'progress');
          const last = [lastChat, lastWritten].filter(Boolean)
            .sort((a, b) => String(b.generated_on).localeCompare(String(a.generated_on)))[0];
          items.push({ type: 'cycle', label: '6-month cycle', due_date: null, status: 'done',
                       report_id: last ? last.id : null });
        }
      }

      // 6) Leaver report — when leave_date approaches (within 6 weeks).
      if (k.leave_date && k.leave_date <= _addDays(today, 42)) {
        const matched = latestOf(k.id, 'leaving', _addMonths(k.leave_date, -6));
        push('leaving', 'Leaver report', _addDays(k.leave_date, -7), matched, { write_type: 'leaving' });
      }

      return {
        child_id: k.id,
        name: (k.preferred_name || k.first_name) + ' ' + (k.last_name || ''),
        room_name: k.room_name, age_months: k.age_months,
        key_person_id: k.key_person_id, key_person_name: k.key_person_name,
        items,
      };
    });

    // Per-key-person accountability summary
    const summary = {};
    for (const c of children) {
      const kp = c.key_person_name || 'No key person';
      const s = (summary[kp] = summary[kp] || { key_person: kp, key_person_id: c.key_person_id, overdue: 0, due_soon: 0, draft: 0, done: 0, upcoming: 0, children: 0 });
      s.children++;
      for (const it of c.items) s[it.status] = (s[it.status] || 0) + 1;
    }

    res.json({
      children,
      summary: Object.values(summary).sort((a, b) => (b.overdue - a.overdue) || (b.due_soon - a.due_soon)),
      toggles, term, today,
    });
  } catch (e) {
    console.error('parent-reports report-tracker:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /log-chat — record a 6-month parent conversation as a short finalised record.
router.post('/log-chat', async (req, res) => {
  const { child_id, note = '', chat_date } = req.body || {};
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  if (!String(note).trim()) return res.status(400).json({ error: 'note required — a one-liner is fine' });
  try {
    const db = getPool();
    const denied = await _guardChildAccess(db, req, child_id);
    if (denied) return res.status(403).json({ error: denied });
    const d = (chat_date && /^\d{4}-\d{2}-\d{2}$/.test(chat_date)) ? chat_date : new Date().toISOString().slice(0, 10);
    const { rows } = await db.query(`
      INSERT INTO parent_reports (child_id, report_type, period_start, period_end,
        final_content, status, generated_at, finalised_at, generated_by)
      VALUES ($1, 'parent-chat', $2, $2, $3, 'finalised', NOW(), NOW(), $4)
      RETURNING id
    `, [child_id, d, String(note).trim().slice(0, 4000), req.user.id]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error('parent-reports log-chat:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /room-move — record a room move (manager-level), so the tracker can
// require a transition report + a fresh settling-in for the new room.
//
// b315: this used to INSERT its own child_room_moves row and nothing else, which
// made it the fifth place that half-moved a child — the tracker knew about a move
// that occupancy, the register and the child's own profile had never heard of.
// It now goes through the one room writer, which moves the booking, keeps the
// profile in step and writes that same history row. A child already in the room
// (the ordinary case here: the move happened on the profile and this is the
// transition report catching up) comes back as no_change with the history intact.
router.post('/room-move', async (req, res) => {
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin','room_leader','senior_practitioner']);
  if (!isManager) return res.status(403).json({ error: 'Manager access only' });
  const { child_id, to_room_id, moved_on } = req.body || {};
  if (!child_id || !to_room_id) return res.status(400).json({ error: 'child_id and to_room_id required' });
  try {
    const db = getPool();
    const d = (moved_on && /^\d{4}-\d{2}-\d{2}$/.test(moved_on)) ? moved_on : new Date().toISOString().slice(0, 10);
    const move = await childRoom.setChildRoom(db, {
      childId: Number(child_id), toRoomId: Number(to_room_id), effectiveDate: d,
      actorId: req.user.id, source: 'transition-report',
    });
    if (!move.ok) {
      return res.status(move.reason === 'no_such_child' ? 404 : 400).json({ error: move.reason });
    }
    res.json({ ok: true, id: move.move_log_id, room_move: move });
  } catch (e) {
    console.error('parent-reports room-move:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* termly-fix-20261030 — GET /glance/:child_id. "When they write their termly reports they
 * should have the basic info about the child's development collated in front of them"
 * (Toby). The summative page's review step shows ranges + observations, then disappears
 * when the practitioner moves on to choosing ranges and writing. This is the compact
 * panel that stays on screen: open next steps (with the area of the observation each came
 * from), interests from All About Me, this half-term's attendance and observation count,
 * and the last termly report. Same child-access guard as /profile. Read only. */
router.get('/glance/:child_id', async (req, res) => {
  const childId = parseInt(req.params.child_id, 10);
  if (!childId) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    const denied = await _guardChildAccess(db, req, childId);
    if (denied) return res.status(403).json({ error: denied });
    const CAL = require('../lib/school-calendar');
    const today = CAL.todayYmd();
    let from = null, to = today, period = null;
    try {
      const cal = await CAL.loadCalendar(db, CAL.academicYearOf(today));
      const r = CAL.resolveDay(today, cal.terms, cal.breaks) || {};
      // in term: this half-term so far; in a holiday: the half-term just gone
      const ht = r.half_term || r.previous_half_term || null;
      if (ht) { from = CAL.cleanYmd(ht.start_date); to = r.half_term ? today : CAL.cleanYmd(ht.end_date); period = ht.name; }
    } catch (_) { /* no calendar: fall back to the last 8 weeks */ }
    if (!from) { from = CAL.addDays(today, -56); period = 'the last 8 weeks'; }

    const [ns, about, att, obs, last] = await Promise.all([
      db.query(`
        SELECT n.id, n.description, n.status, to_char(n.due_by,'YYYY-MM-DD') AS due_by,
               to_char(n.created_at,'YYYY-MM-DD') AS set_on, o.eyfs_areas
          FROM next_steps n LEFT JOIN observations o ON o.id = n.observation_id
         WHERE n.child_id = $1 AND COALESCE(n.status,'open') NOT IN ('cancelled','superseded','completed','achieved','closed')
           AND n.closed_at IS NULL
         ORDER BY n.created_at DESC LIMIT 12`, [childId]),
      db.query(`SELECT interests, favourite_toys_activities, favourite_songs_rhymes, dislikes
                  FROM child_about_me WHERE child_id = $1`, [childId]),
      db.query(`
        SELECT COUNT(DISTINCT date) FILTER (WHERE NOT COALESCE(absent,false) AND sign_in_time IS NOT NULL)::int AS attended,
               COUNT(DISTINCT date) FILTER (WHERE COALESCE(absent,false))::int AS absent
          FROM attendance WHERE child_id = $1 AND date BETWEEN $2::date AND $3::date`, [childId, from, to]),
      db.query(`SELECT COUNT(*)::int AS n FROM observations
                 WHERE child_id = $1 AND created_at::date BETWEEN $2::date AND $3::date`, [childId, from, to]),
      db.query(`
        SELECT report_type, status, to_char(COALESCE(sent_at, finalised_at, generated_at),'YYYY-MM-DD') AS on_date
          FROM parent_reports WHERE child_id = $1 AND report_type = 'termly'
         ORDER BY COALESCE(sent_at, finalised_at, generated_at) DESC NULLS LAST LIMIT 1`, [childId]),
    ]);
    const a = about.rows[0] || {};
    const txt = v => (v == null ? '' : String(v).trim());
    res.json({
      period: { name: period, from, to },
      next_steps: ns.rows.map(r => ({
        id: r.id, description: r.description, status: r.status, due_by: r.due_by, set_on: r.set_on,
        areas: Array.isArray(r.eyfs_areas) ? r.eyfs_areas : [],
      })),
      interests: {
        interests: txt(a.interests) || null,
        favourite_toys_activities: txt(a.favourite_toys_activities) || null,
        favourite_songs_rhymes: txt(a.favourite_songs_rhymes) || null,
        dislikes: txt(a.dislikes) || null,
      },
      attendance: att.rows[0] || { attended: 0, absent: 0 },
      observations_this_period: (obs.rows[0] || {}).n || 0,
      last_termly_report: last.rows[0] || null,
    });
  } catch (e) {
    console.error('[parent-reports] glance:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* resources-20261030 — GET /suggest/:child_id. A short list of resource cards and Activity
 * Bank activities for ONE child, each with its reason: the areas of their open next steps,
 * their All About Me interests, and the room plan this week (src/lib/child-suggestions.js).
 * Staff said the full libraries are "too overwhelming". Same child-access guard as /glance. */
router.get('/suggest/:child_id', async (req, res) => {
  const childId = parseInt(req.params.child_id, 10);
  if (!childId) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    const denied = await _guardChildAccess(db, req, childId);
    if (denied) return res.status(403).json({ error: denied });
    const { rows: [child] } = await db.query(`
      SELECT c.id, c.room_id,
             (EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 + EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)))::int AS age_months,
             concat_ws(' ', cam.interests, cam.favourite_toys_activities) AS interest_text
        FROM children c LEFT JOIN child_about_me cam ON cam.child_id = c.id WHERE c.id = $1`, [childId]);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const { rows: stepRows } = await db.query(`
      SELECT o.eyfs_areas FROM next_steps n JOIN observations o ON o.id = n.observation_id
       WHERE n.child_id = $1 AND n.closed_at IS NULL
         AND COALESCE(n.status,'open') NOT IN ('cancelled','superseded','completed','achieved','closed')`, [childId]);
    const stepAreas = stepRows.flatMap(r => Array.isArray(r.eyfs_areas) ? r.eyfs_areas : []);

    // The room's plan for the half-term we are in (or the next one, in a holiday) and this week's days.
    let themeText = '';
    if (child.room_id) {
      const { rows: [plan] } = await db.query(`
        SELECT p.id, p.theme, t.start_date FROM term_plans p JOIN school_terms t ON t.id = p.school_term_id
         WHERE p.room_id = $1 AND p.subject IS NULL AND t.end_date >= CURRENT_DATE
         ORDER BY t.start_date LIMIT 1`, [child.room_id]);
      if (plan) {
        const { rows: dayRows } = await db.query(`
          SELECT title FROM termly_plan_days
           WHERE plan_id = $1 AND week_no = GREATEST(1, 1 + ((CURRENT_DATE - $2::date) / 7))`, [plan.id, plan.start_date]);
        themeText = [plan.theme, ...dayRows.map(d => d.title)].filter(Boolean).join(' ');
      }
    }

    const cardIndex = (() => { try { return require('./resource-cards')._loadCards().index || []; } catch { return []; } })();
    const { rows: actRows } = await db.query(`
      SELECT id, title, description, age_group, age_band, eyfs_areas, tags
        FROM planning_activities WHERE COALESCE(is_public, true) = true
       ORDER BY times_used DESC NULLS LAST, id LIMIT 800`);
    const out = require('../lib/child-suggestions').suggestForChild({
      cardIndex, activityRows: actRows, stepAreas, ageMonths: child.age_months,
      interestText: child.interest_text, themeText, limit: Math.min(12, parseInt(req.query.limit, 10) || 6),
    });
    res.json(out);
  } catch (e) {
    console.error('[parent-reports] suggest:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
