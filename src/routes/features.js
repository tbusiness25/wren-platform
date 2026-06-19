const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const managerOnly = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

// GET /api/features/public — flag list only (no config), any authed user
// Must come before /:key to avoid route conflict
router.get('/public', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT key, is_enabled FROM feature_flags ORDER BY key'
    );
    const result = {};
    for (const row of rows) result[row.key] = row.is_enabled;
    res.json(result);
  } catch (err) {
    console.error('features /public error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/features — full list with config, admin only
router.get('/', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT key, is_enabled, enabled_at, enabled_by, config, notes FROM feature_flags ORDER BY key'
    );
    res.json(rows);
  } catch (err) {
    console.error('features GET error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// PUT /api/features/:key — toggle feature, admin only
router.put('/:key', managerOnly, async (req, res) => {
  const { key } = req.params;
  const { is_enabled, config } = req.body;

  if (typeof is_enabled !== 'boolean') {
    return res.status(400).json({ error: 'is_enabled must be a boolean' });
  }

  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE feature_flags
       SET is_enabled = $1,
           enabled_at = CASE WHEN $1 = true AND (enabled_at IS NULL OR is_enabled = false) THEN NOW() ELSE enabled_at END,
           enabled_by = $2,
           config     = COALESCE($3::jsonb, config)
       WHERE key = $4
       RETURNING *`,
      [is_enabled, req.user.id, config ? JSON.stringify(config) : null, key]
    );
    if (!rows.length) return res.status(404).json({ error: 'Feature not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('features PUT error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

module.exports = router;
