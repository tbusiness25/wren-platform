'use strict';
const express  = require('express');
const router   = express.Router();
const PDFDoc   = require('pdfkit');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const OLLAMA_HOST  = () => process.env.OLLAMA_HOST  || 'http://localhost:11434';
const OLLAMA_MODEL = () => process.env.OLLAMA_MODEL || 'qwen3.5:4b';

// GET /leavers — children approaching leaving age (4y10m+)
router.get('/leavers', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.date_of_birth,
             r.name as room_name,
             EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 +
             EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)) as age_months,
             lb.id as book_id, lb.status as book_status
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN leavers_books lb ON lb.child_id = c.id
      WHERE c.is_active = true
        AND (
          EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 +
          EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth))
        ) >= 46
      ORDER BY c.date_of_birth ASC
    `);
    res.json({ children: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:child_id — get book for child
router.get('/:child_id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT lb.*,
             c.first_name, c.last_name, c.date_of_birth,
             r.name as room_name,
             s.first_name || ' ' || s.last_name as generated_by_name
      FROM leavers_books lb
      LEFT JOIN children c ON c.id = lb.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = lb.generated_by
      WHERE lb.child_id=$1
    `, [req.params.child_id]);
    if (!rows.length) return res.json({ book: null });
    res.json({ book: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /generate/:child_id — generate or regenerate book
router.post('/generate/:child_id', async (req, res) => {
  const { child_id } = req.params;
  try {
    const db = getPool();

    const [childRes, obsRes, memRes, frameworkRes] = await Promise.all([
      db.query(`
        SELECT c.*, r.name as room_name,
          EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 +
          EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)) as age_months
        FROM children c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1
      `, [child_id]),
      db.query(`
        SELECT title, description, eyfs_areas, observation_date
        FROM observations
        WHERE child_id=$1 AND (status IS NULL OR status != 'rejected')
        ORDER BY observation_date DESC LIMIT 20
      `, [child_id]),
      db.query(`
        SELECT title, description, happened_on, milestone_type
        FROM memory_box_entries WHERE child_id=$1
        ORDER BY happened_on ASC
      `, [child_id]),
      db.query(`
        SELECT area_name as name, secure_count, developing_count
        FROM framework_tracker WHERE child_id=$1 ORDER BY area_name
      `, [child_id]),
    ]);

    if (!childRes.rows.length) return res.status(404).json({ error: 'Child not found' });
    const child = childRes.rows[0];
    const name = child.preferred_name || child.first_name;
    const ageMonths = Math.round(parseFloat(child.age_months) || 0);
    const ageYears = Math.floor(ageMonths / 12);

    const obsHighlights = obsRes.rows.slice(0, 8)
      .map(o => `- ${o.title || 'Observation'} (${o.observation_date}): ${(o.description||'').slice(0,150)}`)
      .join('\n') || 'No observations.';

    const memHighlights = memRes.rows
      .map(m => `- ${m.title}: ${(m.description||'').slice(0,100)}`)
      .join('\n') || 'No memory box entries.';

    const topAreas = frameworkRes.rows
      .filter(a => (parseInt(a.secure_count)||0) > 0)
      .slice(0, 4)
      .map(a => a.name).join(', ') || 'all areas';

    const prompt = `Write a warm, celebratory farewell message for ${name}'s Leavers Book at Your Nursery, Ealing.

${name} is ${ageYears} years old and has been with us in the ${child.room_name}.

Observations highlights:
${obsHighlights}

Special memories:
${memHighlights}

Strong areas: ${topAreas}

Write 3–4 paragraphs suitable for a printed keepsake book:
1. Opening paragraph — celebrate ${name}'s time with us, warm and personal
2. What made ${name} special — personality, favourite things, strengths
3. Growth and learning — highlight key milestones and EYFS achievements
4. Farewell message — wishes for school, from all the team

UK English, warm and celebratory. Address it to ${name} directly. This will be treasured by the family.`;

    const ollamaRes = await fetch(`${OLLAMA_HOST()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL(), prompt, stream: false, think: false }),
    });
    if (!ollamaRes.ok) throw new Error(`Ollama error ${ollamaRes.status}`);
    const ollamaData = await ollamaRes.json();
    const aiHighlights = (ollamaData.response || '').trim();

    const coverTitle = `${name}'s Leavers Book`;

    const { rows: saved } = await db.query(`
      INSERT INTO leavers_books
        (child_id, cover_title, ai_highlights, status, generated_at, generated_by)
      VALUES ($1, $2, $3, 'draft', NOW(), $4)
      ON CONFLICT (child_id) DO UPDATE SET
        cover_title=EXCLUDED.cover_title,
        ai_highlights=EXCLUDED.ai_highlights,
        status='draft',
        generated_at=EXCLUDED.generated_at,
        generated_by=EXCLUDED.generated_by
      RETURNING *
    `, [child_id, coverTitle, aiHighlights, req.user.id]);

    res.json({ book: saved[0] });
  } catch (e) {
    console.error('leavers-book generate:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id — update farewell / cover title
router.put('/:id', async (req, res) => {
  const { cover_title, leaving_date, staff_farewell, ai_highlights } = req.body;
  try {
    const db = getPool();
    const fields = [];
    const vals = [];
    let idx = 1;
    if (cover_title    !== undefined) { fields.push(`cover_title=$${idx++}`);    vals.push(cover_title); }
    if (leaving_date   !== undefined) { fields.push(`leaving_date=$${idx++}`);   vals.push(leaving_date); }
    if (staff_farewell !== undefined) { fields.push(`staff_farewell=$${idx++}`); vals.push(staff_farewell); }
    if (ai_highlights  !== undefined) { fields.push(`ai_highlights=$${idx++}`);  vals.push(ai_highlights); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE leavers_books SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ book: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/finalise — generate PDF
router.post('/:id/finalise', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT lb.*, c.first_name, c.last_name, c.date_of_birth, r.name as room_name
      FROM leavers_books lb
      LEFT JOIN children c ON c.id = lb.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      WHERE lb.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const book = rows[0];
    const childName = `${book.first_name} ${book.last_name}`;

    const pdfBuf = await new Promise((resolve, reject) => {
      const doc = new PDFDoc({ size: 'A4', margin: 60 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Cover
      doc.fontSize(24).font('Helvetica-Bold')
         .text(book.cover_title || `${childName}'s Leavers Book`, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(14).font('Helvetica')
         .text('Your Nursery', { align: 'center' });
      doc.text('1A Example Lane, Ealing, W13 9LU', { align: 'center' });
      if (book.leaving_date) {
        doc.moveDown(0.5);
        doc.text(`Leaving: ${book.leaving_date}`, { align: 'center' });
      }

      doc.moveDown(2);

      // AI highlights
      if (book.ai_highlights) {
        doc.fontSize(12).font('Helvetica-Bold').text('From All of Us at Your Nursery');
        doc.moveDown(0.5);
        doc.fontSize(11).font('Helvetica').text(book.ai_highlights, { lineGap: 5 });
        doc.moveDown(2);
      }

      // Staff farewell
      if (book.staff_farewell) {
        doc.fontSize(12).font('Helvetica-Bold').text('A Personal Message');
        doc.moveDown(0.5);
        doc.fontSize(11).font('Helvetica').text(book.staff_farewell, { lineGap: 5 });
        doc.moveDown(2);
      }

      doc.fontSize(10).font('Helvetica').fillColor('#888888')
         .text('With love from the whole team.', { align: 'center' });

      doc.end();
    });

    await db.query(`
      UPDATE leavers_books SET status='finalised', pdf_url='generated' WHERE id=$1
    `, [req.params.id]);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${childName}-leavers-book.pdf"`,
    });
    res.send(pdfBuf);
  } catch (e) {
    console.error('leavers-book finalise:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
