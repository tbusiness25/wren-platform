'use strict';
// classroom.js — read-only endpoints for Google Classroom cache
// Mounts at /api/classroom

const express = require('express');
const router  = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const adminOnly = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ── GET /api/classroom/settings ───────────────────────────────────────────────
router.get('/settings', adminOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT * FROM classroom_settings WHERE school_id=1');
    res.json(rows[0] || { school_id: 1, enabled: false, workspace_domain: '', admin_email: '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/classroom/settings ──────────────────────────────────────────────
router.post('/settings', adminOnly, async (req, res) => {
  const { workspace_domain, admin_email, enabled } = req.body;
  const db = getPool();
  try {
    await db.query(
      `INSERT INTO classroom_settings (school_id, workspace_domain, admin_email, enabled, updated_at)
       VALUES (1,$1,$2,$3,now())
       ON CONFLICT (school_id) DO UPDATE SET
         workspace_domain=$1, admin_email=$2, enabled=$3, updated_at=now()`,
      [workspace_domain || '', admin_email || '', enabled === true || enabled === 'true']
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/classroom/test ──────────────────────────────────────────────────
// Verifies the service account + impersonation work; returns course count.
router.post('/test', adminOnly, async (req, res) => {
  const { admin_email } = req.body;
  if (!admin_email) return res.status(400).json({ error: 'admin_email required' });
  try {
    const gc = require('../lib/google-classroom-client');
    const result = await gc.testConnection(admin_email);
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── POST /api/classroom/sync ──────────────────────────────────────────────────
// Fire-and-forget; returns immediately, runs sync in background.
// Intended to be called from n8n Mon–Fri 05:00 or from the settings page.
router.post('/sync', adminOnly, async (req, res) => {
  res.json({ ok: true, message: 'Sync started in background' });

  const schema = process.env.PG_SCHEMA || 'demo_secondary';
  const pgConfig = {
    host:     process.env.PG_HOST     || 'localhost',
    port:     parseInt(process.env.PG_PORT || '5434'),
    database: process.env.PG_DB       || 'wren',
    user:     process.env.PG_USER     || 'wren',
    password: process.env.PG_PASSWORD,
  };

  const { syncSchema } = require('../jobs/classroom-daily-sync');
  syncSchema(pgConfig, schema).catch(err =>
    console.error('[classroom-sync] background sync error:', err.message)
  );
});

// ── GET /api/classroom/sync-status ────────────────────────────────────────────
router.get('/sync-status', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT enabled, last_sync_at, last_sync_ok, last_sync_error,
              last_sync_courses_cnt, last_sync_students_cnt
       FROM classroom_settings WHERE school_id=1`
    );
    res.json(rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/classroom/courses ────────────────────────────────────────────────
router.get('/courses', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT * FROM classroom_courses WHERE school_id=1 ORDER BY name'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/classroom/assignments ────────────────────────────────────────────
// Query params: child_id, course_id, due_from, due_to, state, week (bool)
router.get('/assignments', async (req, res) => {
  const { child_id, course_id, due_from, due_to, state, week } = req.query;
  const db = getPool();
  try {
    const where = ['cc.school_id=1'];
    const vals  = [];

    if (child_id)  { vals.push(child_id);  where.push(`cc.wren_child_id=$${vals.length}`); }
    if (course_id) { vals.push(course_id); where.push(`cc.course_id=$${vals.length}`); }
    if (state)     { vals.push(state);     where.push(`cc.submission_state=$${vals.length}`); }
    if (due_from)  { vals.push(due_from);  where.push(`cc.due_date>=$${vals.length}`); }
    if (due_to)    { vals.push(due_to);    where.push(`cc.due_date<=$${vals.length}`); }
    if (week === 'true') {
      where.push("cc.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'");
    }

    const { rows } = await db.query(
      `SELECT cc.* FROM classroom_cache cc
       WHERE ${where.join(' AND ')}
       ORDER BY cc.due_date ASC NULLS LAST
       LIMIT 500`,
      vals
    );

    const sync = await db.query(
      'SELECT last_sync_at, last_sync_ok FROM classroom_settings WHERE school_id=1'
    );

    res.json({
      assignments: rows,
      last_synced_at: sync.rows[0]?.last_sync_at || null,
      sync_ok: sync.rows[0]?.last_sync_ok,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/classroom/student/:childId ───────────────────────────────────────
router.get('/student/:childId', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT * FROM classroom_cache
       WHERE school_id=1 AND wren_child_id=$1
       ORDER BY due_date ASC NULLS LAST`,
      [req.params.childId]
    );
    const sync = await db.query(
      'SELECT last_sync_at, last_sync_ok FROM classroom_settings WHERE school_id=1'
    );
    res.json({
      assignments: rows,
      last_synced_at: sync.rows[0]?.last_sync_at || null,
      sync_ok: sync.rows[0]?.last_sync_ok,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/classroom/behind ─────────────────────────────────────────────────
// Students with overdue assignments not yet turned in.  Teacher view.
// Optional: ?course_id=
router.get('/behind', async (req, res) => {
  const { course_id } = req.query;
  const db = getPool();
  try {
    const where = [
      "cc.school_id=1",
      "cc.due_date < CURRENT_DATE",
      "cc.submission_state NOT IN ('TURNED_IN','RETURNED')",
    ];
    const vals = [];
    if (course_id) { vals.push(course_id); where.push(`cc.course_id=$${vals.length}`); }

    const { rows } = await db.query(
      `SELECT cc.*,
              ch.first_name, ch.last_name
       FROM classroom_cache cc
       LEFT JOIN children ch ON ch.id = cc.wren_child_id
       WHERE ${where.join(' AND ')}
       ORDER BY cc.due_date ASC, cc.course_name, cc.student_email`,
      vals
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
