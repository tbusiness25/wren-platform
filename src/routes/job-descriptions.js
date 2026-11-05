'use strict';
// (b123) Role job descriptions — DRAFT content, is_active=false until Toby reviews.
const express      = require('express');
const router        = express.Router();
const { getPool }   = require('../db/pool');
const { requireRole } = require('../middleware/auth');

const managerOnly = requireRole('manager', 'deputy_manager', 'admin');
const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';

// ─── GET /api/job-descriptions — all (draft + active) ─────────────────────────

router.get('/', ...managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, role, title, version, is_active, updated_at
         FROM ${SCHEMA()}.job_descriptions
        ORDER BY role`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/job-descriptions/:id — full content ──────────────────────────────

router.get('/:id', ...managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [row] } = await db.query(
      `SELECT id, role, title, content_md, version, is_active, updated_at
         FROM ${SCHEMA()}.job_descriptions WHERE id=$1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
