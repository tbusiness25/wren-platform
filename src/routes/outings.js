const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET / — list outings
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT o.*, r.name as room_name,
        s.first_name || ' ' || s.last_name as created_by_name
      FROM outings o
      LEFT JOIN rooms r ON r.id = o.room_id
      LEFT JOIN staff s ON s.id = o.created_by
      ORDER BY o.date DESC LIMIT 100
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /today-defaults — staff and children clocked in today for room
router.get('/today-defaults', async (req, res) => {
  const user = req.user;
  try {
    const db = getPool();
    const roomId = req.query.room_id || user.room_id;
    // Staff clocked in today in this room
    const { rows: staff } = await db.query(`
      SELECT s.id, s.first_name, s.last_name
      FROM staff s
      JOIN staff_attendance sa ON sa.staff_id = s.id AND sa.date = CURRENT_DATE
      WHERE sa.clock_in IS NOT NULL AND sa.clock_out IS NULL
        AND (s.room_id=$1 OR $1::int IS NULL)
    `, [roomId || null]);
    // Children signed in today in this room
    const { rows: children } = await db.query(`
      SELECT c.id, c.first_name, c.last_name
      FROM children c
      JOIN attendance a ON a.child_id = c.id AND a.date = CURRENT_DATE
      WHERE a.sign_in_time IS NOT NULL AND a.sign_out_time IS NULL
        AND (c.room_id=$1 OR $1::int IS NULL)
    `, [roomId || null]);
    res.json({ staff, children });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM outings WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /
router.post('/', async (req, res) => {
  const { date, destination, outing_type, purpose, learning_intention,
    staff_ids, child_ids, risk_assessment_completed, risk_assessment_url,
    transport_method, departure_time, return_time, notes, room_id } = req.body;
  if (!destination) return res.status(400).json({ error: 'destination required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO outings (date, destination, outing_type, purpose, learning_intention,
        staff_ids, child_ids, risk_assessment_completed, risk_assessment_url,
        transport_method, departure_time, return_time, notes, room_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [date||new Date().toISOString().split('T')[0], destination, outing_type,
        purpose, learning_intention, staff_ids||[], child_ids||[],
        risk_assessment_completed||false, risk_assessment_url,
        transport_method, departure_time||null, return_time||null,
        notes, room_id||req.user.room_id, req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id
router.put('/:id', async (req, res) => {
  const fields = ['destination','outing_type','purpose','learning_intention','staff_ids','child_ids',
    'risk_assessment_completed','risk_assessment_url','transport_method','departure_time','return_time','notes'];
  const updates=[], vals=[];
  fields.forEach(f=>{if(req.body[f]!==undefined){vals.push(req.body[f]);updates.push(`${f}=$${vals.length}`);}});
  if(!updates.length) return res.status(400).json({error:'No fields'});
  vals.push(req.params.id);
  try {
    const db = getPool();
    const { rows } = await db.query(`UPDATE outings SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    const db = getPool();
    await db.query('DELETE FROM outings WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/send-consent — mark consent as sent (stub — real email needs SMTP config)
router.post('/:id/send-consent', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    // Get outing + child emails
    const { rows: [outing] } = await db.query('SELECT * FROM outings WHERE id=$1', [req.params.id]);
    if (!outing) return res.status(404).json({ error: 'Not found' });
    const childIds = outing.child_ids || [];
    const { rows: children } = await db.query(
      `SELECT first_name||' '||last_name as name, parent_1_email, parent_1_name FROM children WHERE id = ANY($1) AND parent_1_email IS NOT NULL`,
      [childIds]
    );
    // Mark as consent_sent
    await db.query(`UPDATE outings SET notes=COALESCE(notes,'')||' [Consent sent ${new Date().toLocaleDateString('en-GB')}]' WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, parents_notified: children.length, parents: children.map(c => c.parent_1_email) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/ai-risk — generate risk assessment via Ollama
router.post('/:id/ai-risk', async (req, res) => {
  const { destination, age_range } = req.body;
  try {
    const aiBody = {
      model: 'qwen2.5:4b',
      prompt: `Generate a brief risk assessment for a nursery outing to ${destination||'local park'} with children aged ${age_range||'2-5 years'}. Include: main hazards, control measures, emergency procedures. Format as plain text with section headings. Keep it concise and practical for a nursery setting. UK context.`,
      stream: false, think: false,
    };
    const aiRes = await fetch(`${process.env.OLLAMA_HOST||'http://localhost:11434'}/api/generate`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(aiBody),
      signal: AbortSignal.timeout(30000),
    });
    const data = await aiRes.json();
    res.json({ risk_assessment: data.response || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
