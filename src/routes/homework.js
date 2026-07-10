const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER || 'wren',
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || 'wren',
});

const schema = () => process.env.PG_SCHEMA || 'demo_primary';

const upload = multer({
  dest: path.join(process.env.UPLOADS_DIR || '/app/uploads', 'homework'),
  limits: { fileSize: 20 * 1024 * 1024 },
}).array('attachments', 5);

// List homework — filter by class_id, subject_id, status, child_id (parent view)
router.get('/', async (req, res) => {
  const { class_id, subject_id, status, pupil_id, parent, child_id } = req.query;
  const s = schema();
  try {
    let where = ['1=1'];
    const vals = [];
    if (class_id)  { vals.push(class_id);  where.push(`h.class_id=$${vals.length}`); }
    if (subject_id){ vals.push(subject_id); where.push(`h.subject_id=$${vals.length}`); }
    if (status === 'published') where.push('h.is_published=true');
    else if (status === 'draft') where.push('h.is_published=false');
    // child_id: look up child's class(es) and filter homework for that class
    if (child_id) {
      vals.push(parseInt(child_id));
      where.push(`(h.class_id IN (SELECT class_id FROM ${s}.class_pupils WHERE pupil_id=$${vals.length})
                  OR h.class_id IN (SELECT id FROM ${s}.classes WHERE year_group=(SELECT year_group FROM ${s}.children WHERE id=$${vals.length})))`);
      where.push('h.is_published=true');
    }
    if (pupil_id && parent) {
      where.push('h.is_published=true');
    }
    const { rows } = await pool.query(
      `SELECT h.*,
        c.name AS class_name, c.year_group,
        subj.name AS subject_name,
        CONCAT(st.first_name,' ',st.last_name) AS teacher_name,
        subj.name AS subject,
        (SELECT json_agg(json_build_object('id',hs.id,'pupil_id',hs.pupil_id,'submitted_at',hs.submitted_at,'grade',hs.grade,'parent_acknowledged',hs.parent_acknowledged,'teacher_feedback',hs.teacher_feedback))
         FROM ${s}.homework_submissions hs WHERE hs.homework_id=h.id) AS submissions
       FROM ${s}.homework h
       LEFT JOIN ${s}.classes c ON c.id=h.class_id
       LEFT JOIN ${s}.subjects subj ON subj.id=h.subject_id
       LEFT JOIN ${s}.staff st ON st.id=h.set_by_teacher_id
       WHERE ${where.join(' AND ')}
       ORDER BY h.due_date ASC, h.set_at DESC`,
      vals
    );
    res.json(rows);
  } catch (e) {
    console.error('homework GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get single homework item
router.get('/:id', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(
      `SELECT h.*,
        c.name AS class_name, c.year_group,
        subj.name AS subject_name,
        CONCAT(st.first_name,' ',st.last_name) AS teacher_name,
        (SELECT json_agg(row_to_json(hs.*)) FROM ${s}.homework_submissions hs WHERE hs.homework_id=h.id) AS submissions
       FROM ${s}.homework h
       LEFT JOIN ${s}.classes c ON c.id=h.class_id
       LEFT JOIN ${s}.subjects subj ON subj.id=h.subject_id
       LEFT JOIN ${s}.staff st ON st.id=h.set_by_teacher_id
       WHERE h.id=$1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create homework
router.post('/', async (req, res) => {
  const s = schema();
  const { class_id, subject_id, set_by_teacher_id, title, description, due_date, type,
          estimated_duration_minutes, external_resource_url, is_published } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO ${s}.homework
         (class_id,subject_id,set_by_teacher_id,title,description,due_date,type,estimated_duration_minutes,external_resource_url,is_published)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [class_id, subject_id, set_by_teacher_id, title, description, due_date,
       type || 'worksheet', estimated_duration_minutes || 20, external_resource_url || null,
       is_published || false]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('homework POST error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update homework (publish/draft/edit)
router.patch('/:id', async (req, res) => {
  const s = schema();
  const allowed = ['title','description','due_date','type','estimated_duration_minutes',
                   'external_resource_url','is_published','attachment_paths'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      vals.push(req.body[k]);
      sets.push(`${k}=$${vals.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE ${s}.homework SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete homework
router.delete('/:id', async (req, res) => {
  const s = schema();
  try {
    await pool.query(`DELETE FROM ${s}.homework WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Submit homework (pupil/parent upload)
router.post('/:id/submit', async (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const s = schema();
    const { pupil_id, content, parent_acknowledged } = req.body;
    const paths = (req.files || []).map(f => f.path);
    try {
      const existing = await pool.query(
        `SELECT id FROM ${s}.homework_submissions WHERE homework_id=$1 AND pupil_id=$2`,
        [req.params.id, pupil_id]
      );
      let row;
      if (existing.rows.length) {
        const r = await pool.query(
          `UPDATE ${s}.homework_submissions SET submitted_at=now(), content=$1,
           attachment_paths=array_cat(attachment_paths,$2::text[]), parent_acknowledged=$3
           WHERE homework_id=$4 AND pupil_id=$5 RETURNING *`,
          [content || null, paths, parent_acknowledged === 'true', req.params.id, pupil_id]
        );
        row = r.rows[0];
      } else {
        const r = await pool.query(
          `INSERT INTO ${s}.homework_submissions
             (homework_id,pupil_id,submitted_at,content,attachment_paths,parent_acknowledged)
           VALUES ($1,$2,now(),$3,$4,$5) RETURNING *`,
          [req.params.id, pupil_id, content || null, paths, parent_acknowledged === 'true']
        );
        row = r.rows[0];
      }
      res.status(201).json(row);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// Mark homework (teacher grades a submission)
router.patch('/:id/submissions/:subId/mark', async (req, res) => {
  const s = schema();
  const { grade, teacher_feedback, marked_by } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE ${s}.homework_submissions SET grade=$1,teacher_feedback=$2,marked_by=$3,marked_at=now()
       WHERE id=$4 AND homework_id=$5 RETURNING *`,
      [grade, teacher_feedback, marked_by, req.params.subId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Submission not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Parent acknowledges marked work
router.patch('/:id/submissions/:subId/acknowledge', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(
      `UPDATE ${s}.homework_submissions SET parent_acknowledged=true WHERE id=$1 AND homework_id=$2 RETURNING *`,
      [req.params.subId, req.params.id]
    );
    res.json(rows[0] || { ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
