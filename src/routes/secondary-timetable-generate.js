'use strict';

const express        = require('express');
const router         = express.Router();
const { getPool }    = require('../db/pool');
const authenticate   = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const fetClient      = require('../lib/fet-client');

const schema = () => process.env.PG_SCHEMA || 'demo_secondary';
const db     = () => getPool();

// ── DB helpers ────────────────────────────────────────────────────────────────

async function ensureSchema() {
  const s = schema();
  await db().query(`
    CREATE TABLE IF NOT EXISTS ${s}.timetable_drafts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL DEFAULT 'Untitled draft',
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      step INTEGER NOT NULL DEFAULT 1,
      state JSONB NOT NULL DEFAULT '{}',
      job_id VARCHAR(100),
      result JSONB,
      created_by_id INTEGER,
      created_by_name VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db().query(`
    CREATE TABLE IF NOT EXISTS ${s}.timetable_draft_activities (
      id SERIAL PRIMARY KEY,
      draft_id UUID NOT NULL REFERENCES ${s}.timetable_drafts(id) ON DELETE CASCADE,
      week_pattern INTEGER NOT NULL DEFAULT 1,
      day_of_week INTEGER NOT NULL,
      period_num INTEGER NOT NULL,
      year_group INTEGER,
      subject_id INTEGER,
      class_id INTEGER,
      teacher_id INTEGER,
      room_id INTEGER,
      teacher_name VARCHAR(100),
      subject_name VARCHAR(100),
      room_code VARCHAR(20),
      pupil_count INTEGER,
      set_num INTEGER,
      activity_ref VARCHAR(50),
      notes TEXT
    )
  `);
}

// Run migration on startup (safe — IF NOT EXISTS)
db().query('SELECT 1').then(() => ensureSchema()).catch(() => {});

// ── Telegram notification ─────────────────────────────────────────────────────

function notify(msg) {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  const cid = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !cid) return;
  try {
    const https = require('https');
    const body  = JSON.stringify({ chat_id: cid, text: msg });
    const req   = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${tok}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.write(body); req.end();
  } catch {}
}

// ── Drafts CRUD ───────────────────────────────────────────────────────────────

router.get('/drafts', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  try {
    const { rows } = await db().query(
      `SELECT id, name, status, step, job_id, created_by_name, created_at, updated_at
       FROM ${s}.timetable_drafts ORDER BY updated_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/drafts', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  const { name = 'Untitled draft', state = {} } = req.body;
  try {
    const { rows } = await db().query(
      `INSERT INTO ${s}.timetable_drafts (name, state, created_by_id, created_by_name)
       VALUES ($1,$2,$3,$4) RETURNING id, name, status, step`,
      [name, JSON.stringify(state), req.user.id, req.user.name || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/drafts/:id', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  try {
    const { rows } = await db().query(
      `SELECT * FROM ${s}.timetable_drafts WHERE id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Draft not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/drafts/:id', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  const { name, state, step } = req.body;
  try {
    const sets = ['updated_at=NOW()'];
    const vals = [];
    if (name  !== undefined) { vals.push(name);              sets.push(`name=$${vals.length}`); }
    if (state !== undefined) { vals.push(JSON.stringify(state)); sets.push(`state=$${vals.length}`); }
    if (step  !== undefined) { vals.push(step);              sets.push(`step=$${vals.length}`); }
    vals.push(req.params.id);
    const { rows } = await db().query(
      `UPDATE ${s}.timetable_drafts SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING id, name, status, step`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Draft not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/drafts/:id', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  try {
    await db().query(`DELETE FROM ${s}.timetable_drafts WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start generation ──────────────────────────────────────────────────────────

router.post('/drafts/:id/generate', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  const draftId = req.params.id;

  try {
    const { rows } = await db().query(`SELECT * FROM ${s}.timetable_drafts WHERE id=$1`, [draftId]);
    if (!rows[0]) return res.status(404).json({ error: 'Draft not found' });
    const draft = rows[0];

    const state = draft.state || {};

    // Build FET input from wizard state
    const fetInput = {
      school_name: draft.name,
      calendar:    state.calendar || { weeks: 1, days: 5, periods_per_day: 6 },
      teachers:    (state.teachers || []).map(t => ({
        id:            t.id,
        name:          t.name,
        teacher_name:  t.name,
        unavailable:   (t.unavailable || []).map(([d, p]) => [1, d, p]),
        max_periods_day:  t.max_periods_day  || 6,
        max_periods_week: t.max_periods_week || 30,
      })),
      subjects: state.subjects || [],
      rooms:    (state.rooms || []).map(r => ({
        ...r,
        unavailable: (r.unavailable || []).map(([d, p]) => [1, d, p]),
      })),
      activities:  (state.activities || []).map(a => ({
        id:           a.id,
        subject_id:   a.subject_id,
        subject_name: a.subject_name,
        subject_code: a.subject_code,
        year_group:   a.year_group,
        set_num:      a.set_num,
        teacher_id:   a.teacher_id,
        teacher_name: a.teacher_name,
        class_id:     a.class_id,
        pupil_count:  a.pupil_count,
        periods_week: a.periods_week,
      })),
      constraints: [
        ...(state.constraints   || []),
        ...(state.nlConstraints || []),
      ],
    };

    // Cancel previous job if any
    if (draft.job_id) {
      fetClient.cancelJob(draft.job_id).catch(() => {});
    }

    // Clear any previous draft activities
    await db().query(`DELETE FROM ${s}.timetable_draft_activities WHERE draft_id=$1`, [draftId]);

    // Start FET job
    let jobData;
    try {
      jobData = await fetClient.solve(fetInput);
    } catch (e) {
      return res.status(502).json({ error: 'FET service error: ' + e.message });
    }

    // Mark draft as generating
    await db().query(
      `UPDATE ${s}.timetable_drafts SET status='generating', job_id=$1, updated_at=NOW() WHERE id=$2`,
      [jobData.job_id, draftId]
    );

    notify(`Timetable generation started (draft: "${draft.name}")`);

    res.json({ job_id: jobData.job_id, status: 'generating' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Poll generation status ────────────────────────────────────────────────────

router.get('/drafts/:id/status', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  const draftId = req.params.id;

  try {
    const { rows } = await db().query(
      `SELECT id, name, status, job_id, result FROM ${s}.timetable_drafts WHERE id=$1`, [draftId]);
    if (!rows[0]) return res.status(404).json({ error: 'Draft not found' });
    const draft = rows[0];

    if (!draft.job_id || !['generating', 'cancelling'].includes(draft.status)) {
      return res.json({ status: draft.status, result: draft.result });
    }

    // Poll FET service
    let jobData;
    try {
      jobData = await fetClient.getJob(draft.job_id);
    } catch (e) {
      return res.json({ status: draft.status, polling_error: e.message });
    }

    // Job still running
    if (jobData.status === 'running') {
      return res.json({ status: 'generating', job_id: draft.job_id });
    }

    // Job finished — persist result
    const newStatus = jobData.status === 'done' ? 'generated'
                    : jobData.status === 'cancelled' ? 'draft'
                    : jobData.status; // infeasible, error

    await db().query(
      `UPDATE ${s}.timetable_drafts SET status=$1, result=$2, updated_at=NOW() WHERE id=$3`,
      [newStatus, JSON.stringify(jobData.result || null), draftId]
    );

    if (jobData.status === 'done' && jobData.result?.assignments) {
      const acts = jobData.result.assignments;
      for (const a of acts) {
        await db().query(`
          INSERT INTO ${s}.timetable_draft_activities
            (draft_id, week_pattern, day_of_week, period_num,
             year_group, subject_id, teacher_id, room_id,
             teacher_name, subject_name, room_code, set_num, pupil_count)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `, [
          draftId, a.week_pattern, a.day_of_week, a.period_num,
          a.year_group, a.subject_id, a.teacher_id, a.room_id,
          a.teacher_name, a.subject_name, a.room_code, a.set_num, a.pupil_count,
        ]);
      }
      notify(`Timetable generated for draft "${draft.name}" — ${acts.length} periods scheduled. Open Wren to review and accept.`);
    }

    res.json({ status: newStatus, result: jobData.result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cancel generation ─────────────────────────────────────────────────────────

router.post('/drafts/:id/cancel', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  const draftId = req.params.id;
  try {
    const { rows } = await db().query(`SELECT job_id FROM ${s}.timetable_drafts WHERE id=$1`, [draftId]);
    if (!rows[0]) return res.status(404).json({ error: 'Draft not found' });
    if (rows[0].job_id) {
      await fetClient.cancelJob(rows[0].job_id).catch(() => {});
    }
    await db().query(
      `UPDATE ${s}.timetable_drafts SET status='draft', job_id=NULL, updated_at=NOW() WHERE id=$1`,
      [draftId]
    );
    await db().query(`DELETE FROM ${s}.timetable_draft_activities WHERE draft_id=$1`, [draftId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Get draft activities (for preview) ───────────────────────────────────────

router.get('/drafts/:id/activities', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  try {
    const { rows } = await db().query(
      `SELECT * FROM ${s}.timetable_draft_activities
       WHERE draft_id=$1 ORDER BY week_pattern, day_of_week, period_num`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Accept draft → write to live timetable ───────────────────────────────────

router.post('/drafts/:id/accept', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  const draftId = req.params.id;

  const client = await db().connect();
  try {
    await client.query('BEGIN');

    const dr = await client.query(`SELECT * FROM ${s}.timetable_drafts WHERE id=$1 AND status='generated'`, [draftId]);
    if (!dr.rows[0]) return res.status(404).json({ error: 'Draft not found or not generated' });
    const draft = dr.rows[0];
    const state = draft.state || {};

    // Upsert timetable_periods from wizard step 1
    const periodTimes = state.calendar?.period_times || [];
    const weeks = state.calendar?.weeks || 1;
    for (let w = 1; w <= weeks; w++) {
      for (const pt of periodTimes) {
        await client.query(`
          INSERT INTO ${s}.timetable_periods (week_pattern, day_of_week, period_num, label, start_time, end_time)
          SELECT $1, d, $2, $3, $4, $5
          FROM generate_series(1,5) d
          ON CONFLICT DO NOTHING
        `, [w, pt.period, `P${pt.period}`, pt.start, pt.end]);
      }
    }

    const batchId = require('crypto').randomUUID();

    // Clear existing generated timetable (same source_kind) if requested
    if (req.body.clear_existing) {
      await client.query(`DELETE FROM ${s}.timetable_activities WHERE source_kind='generated'`);
    }

    // Copy draft activities → timetable_activities (resolve names → DB integer IDs where possible)
    const { rows: drafted } = await client.query(
      `SELECT * FROM ${s}.timetable_draft_activities WHERE draft_id=$1`, [draftId]);

    let inserted = 0;
    for (const da of drafted) {
      const pRes = await client.query(
        `SELECT id FROM ${s}.timetable_periods WHERE week_pattern=$1 AND day_of_week=$2 AND period_num=$3 LIMIT 1`,
        [da.week_pattern, da.day_of_week, da.period_num]
      );
      const periodId = pRes.rows[0]?.id ?? null;

      // Resolve subject by name (wizard may use string IDs like "s1" — look up by name)
      let subjectId = null;
      if (da.subject_name) {
        const sRes = await client.query(
          `SELECT id FROM ${s}.subjects WHERE lower(name)=lower($1) LIMIT 1`, [da.subject_name]);
        subjectId = sRes.rows[0]?.id ?? null;
      }

      // Resolve teacher by full name
      let teacherId = null;
      if (da.teacher_name) {
        const tRes = await client.query(
          `SELECT id FROM ${s}.staff WHERE lower(first_name||' '||last_name)=lower($1) AND is_active=true LIMIT 1`,
          [da.teacher_name]);
        teacherId = tRes.rows[0]?.id ?? null;
      }

      // Resolve room by code or name
      let roomId = null;
      if (da.room_code || da.room_name) {
        const rName = da.room_code || da.room_name;
        const rRes = await client.query(
          `SELECT id FROM ${s}.rooms WHERE lower(code)=lower($1) OR lower(name)=lower($1) LIMIT 1`, [rName]);
        roomId = rRes.rows[0]?.id ?? null;
      }

      await client.query(`
        INSERT INTO ${s}.timetable_activities
          (source_kind, import_batch, week_pattern, day_of_week, period_id, year_group,
           subject_id, teacher_id, room_id, teacher_name, subject_name, room_code, pupil_count)
        VALUES ('generated',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        batchId, da.week_pattern, da.day_of_week, periodId, da.year_group,
        subjectId, teacherId, roomId,
        da.teacher_name, da.subject_name, da.room_code, da.pupil_count,
      ]);
      inserted++;
    }

    await client.query(
      `UPDATE ${s}.timetable_drafts SET status='accepted', updated_at=NOW() WHERE id=$1`, [draftId]);
    await client.query('COMMIT');

    notify(`Timetable accepted for "${draft.name}" — ${inserted} periods are now live.`);

    res.json({ ok: true, inserted, batch_id: batchId });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Reject / reset draft result ───────────────────────────────────────────────

router.post('/drafts/:id/reject', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  try {
    await db().query(`DELETE FROM ${s}.timetable_draft_activities WHERE draft_id=$1`, [req.params.id]);
    await db().query(
      `UPDATE ${s}.timetable_drafts SET status='draft', result=NULL, job_id=NULL, updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
