const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const schema = () => process.env.PG_SCHEMA || 'ladn';

// Whisper transcription helper (Node 20 native FormData)
async function transcribeAudio(filePath) {
  try {
    const fs = require('fs');
    const path = require('path');
    const buffer = fs.readFileSync(filePath);
    const blob = new Blob([buffer], { type: 'audio/webm' });
    const form = new FormData();
    form.append('audio_file', blob, path.basename(filePath));
    const resp = await fetch('http://wren-whisper:9876/asr?output=txt&task=transcribe', {
      method: 'POST', body: form, signal: AbortSignal.timeout(90000)
    });
    if (!resp.ok) return null;
    return (await resp.text()).trim();
  } catch { return null; }
}

router.use(authenticate);

// GET /escalated — action plans >7 days past target with no recent progress note
router.get('/escalated', async (req, res) => {
  if (!['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role)) return res.status(403).json({error:'Forbidden'});
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ap.*, s.first_name || ' ' || s.last_name as owner_name
      FROM ${schema()}.action_plans ap
      LEFT JOIN ${schema()}.staff s ON s.id=ap.owner_staff_id
      WHERE ap.status NOT IN ('completed','cancelled')
        AND ap.target_date IS NOT NULL
        AND ap.target_date < NOW()::date - 7
        AND (
          ap.progress_notes = '[]'::jsonb
          OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(ap.progress_notes) pn
            WHERE (pn->>'date')::date > NOW()::date - 7
          )
        )
      ORDER BY ap.target_date ASC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET / — list action plans
router.get('/', async (req, res) => {
  const isManager = ['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role);
  try {
    const db = getPool();
    let q = `
      SELECT ap.*, s.first_name || ' ' || s.last_name as owner_name,
        s2.first_name || ' ' || s2.last_name as created_by_name,
        sv.scheduled_date as linked_supervision_date
      FROM ${schema()}.action_plans ap
      LEFT JOIN ${schema()}.staff s ON s.id = ap.owner_staff_id
      LEFT JOIN ${schema()}.staff s2 ON s2.id = ap.created_by
      LEFT JOIN ${schema()}.supervisions sv ON sv.id = ap.supervision_id
    `;
    const params = [];
    if (!isManager) {
      q += ` WHERE ap.owner_staff_id=$1 OR ap.actions::text LIKE '%"assignee_id":${req.user.id}%'`;
      params.push(req.user.id);
    }
    q += ' ORDER BY CASE ap.priority WHEN \'urgent\' THEN 1 WHEN \'high\' THEN 2 WHEN \'medium\' THEN 3 ELSE 4 END, ap.target_date ASC NULLS LAST';
    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ap.*, s.first_name || ' ' || s.last_name as owner_name,
        sv.scheduled_date as linked_supervision_date, sv.type as linked_supervision_type
      FROM ${schema()}.action_plans ap
      LEFT JOIN ${schema()}.staff s ON s.id = ap.owner_staff_id
      LEFT JOIN ${schema()}.supervisions sv ON sv.id = ap.supervision_id
      WHERE ap.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /
router.post('/', async (req, res) => {
  const { title, area, priority, description, success_criteria, actions, target_date,
          owner_staff_id, linked_to, linked_id, supervision_id, visible_to_parents } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO ${schema()}.action_plans (title, area, priority, description, success_criteria, actions,
        target_date, owner_staff_id, linked_to, linked_id, supervision_id, created_by,
        progress_notes, evidence_attachments, visible_to_parents)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'[]','[]',$13)
      RETURNING *
    `, [title, area, priority||'medium', description, success_criteria,
        JSON.stringify(actions||[]), target_date||null,
        owner_staff_id||req.user.id, linked_to||null, linked_id||null,
        supervision_id||null, req.user.id, visible_to_parents||false]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id
router.put('/:id', async (req, res) => {
  const fields = ['title','area','priority','status','description','success_criteria','actions',
    'target_date','completed_date','actual_completion_date','review_notes','owner_staff_id',
    'linked_to','linked_id','supervision_id','progress_notes','evidence_attachments',
    'visible_to_parents'];
  const jsonFields = ['actions','progress_notes','evidence_attachments'];
  const updates=[], vals=[];
  fields.forEach(f=>{
    if(req.body[f]!==undefined){
      vals.push(jsonFields.includes(f)?JSON.stringify(req.body[f]):req.body[f]);
      updates.push(`${f}=$${vals.length}`);
    }
  });
  if(!updates.length) return res.status(400).json({error:'No fields'});
  updates.push(`updated_at=NOW()`);
  vals.push(req.params.id);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE ${schema()}.action_plans SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/progress-note — add a progress note (text or voice)
router.post('/:id/progress-note', async (req, res) => {
  const { note, voice_transcript } = req.body;
  const text = note || voice_transcript;
  if (!text) return res.status(400).json({ error: 'note or voice_transcript required' });
  try {
    const db = getPool();
    const { rows: ap } = await db.query('SELECT progress_notes, owner_staff_id FROM ${schema()}.action_plans WHERE id=$1', [req.params.id]);
    if (!ap.length) return res.status(404).json({ error: 'Not found' });
    const notes = ap[0].progress_notes || [];
    notes.push({ date: new Date().toISOString().split('T')[0], note: text, by: req.user.username || req.user.id, source: voice_transcript ? 'voice' : 'text' });
    await db.query('UPDATE ${schema()}.action_plans SET progress_notes=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(notes), req.params.id]);
    res.json({ ok: true, notes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  if (!['manager','deputy_manager','room_leader','senior_practitioner'].includes(req.user.role)) return res.status(403).json({error:'Forbidden'});
  try {
    const db = getPool();
    await db.query('DELETE FROM ${schema()}.action_plans WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── New routes added for cross-portal action plans module ─────────────────────

// PATCH /:id — soft-archive, scope, category changes (manager only)
// Coexists with PUT /:id above (different HTTP method).
router.patch('/:id', async (req, res) => {
  if (!['manager', 'deputy_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  const allowed = ['title', 'scope', 'category', 'description', 'status', 'priority',
    'target_date', 'owner_staff_id', 'related_child_id', 'archived_at'];
  const updates = [], vals = [];
  for (const f of allowed) {
    if (req.body[f] !== undefined) {
      vals.push(req.body[f]);
      updates.push(`${f}=$${vals.length}`);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields' });
  updates.push('updated_at=NOW()');
  vals.push(req.params.id);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE ${schema()}.action_plans SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/items — convenience: add action item to a plan (delegates to items table)
router.post('/:id/items', async (req, res) => {
  const isManager = ['manager', 'deputy_manager', 'room_leader', 'senior_practitioner'].includes(req.user.role);
  if (!isManager) return res.status(403).json({ error: 'Manager role required' });
  const { title, description, priority, deadline, category, tags, assigned_staff_id } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const db = getPool();
    const { rows: plan } = await db.query(
      'SELECT id, title, scope FROM ${schema()}.action_plans WHERE id=$1 AND archived_at IS NULL', [req.params.id]
    );
    if (!plan.length) return res.status(404).json({ error: 'Plan not found' });
    const { rows } = await db.query(`
      INSERT INTO ${schema()}.action_plan_items
        (plan_id, title, description, priority, deadline, category, tags, assigned_staff_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.params.id, title, description || null, priority || 'medium',
        deadline || null, category || null, tags || null, assigned_staff_id || null]);
    if (assigned_staff_id) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (token && chatId) {
        const dl = deadline ? ` (due ${new Date(deadline).toLocaleDateString('en-GB')})` : '';
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId,
            text: `[ACTIONS] New action assigned: "${title}"${dl} on plan "${plan[0].title}"` }),
          signal: AbortSignal.timeout(8000)
        }).catch(() => {});
      }
    }
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /plan-items/:id — fetch items + stats for a specific plan
router.get('/plan-items/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT i.*,
             s.first_name || ' ' || s.last_name AS assignee_name,
             (SELECT COUNT(*)::int FROM ${schema()}.action_plan_comments c WHERE c.item_id = i.id) AS comment_count
      FROM ${schema()}.action_plan_items i
      LEFT JOIN ${schema()}.staff s ON s.id = i.assigned_staff_id
      WHERE i.plan_id = $1
      ORDER BY i.position ASC, i.deadline ASC NULLS LAST
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
