const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager'];

// List active policies relevant to this staff member's role
router.get('/', async (req, res) => {
  const db = getPool();
  const isManager = MANAGER_ROLES.includes(req.user.role);
  try {
    let rows;
    if (isManager) {
      ({ rows } = await db.query(`
        SELECT p.*,
          COUNT(pa.id) FILTER (WHERE pa.policy_version = p.version) AS ack_count,
          COUNT(s.id) FILTER (WHERE s.is_active = true) AS staff_count
        FROM policies p
        LEFT JOIN policy_acknowledgments pa ON pa.policy_id = p.id
        LEFT JOIN staff s ON s.is_active = true
        WHERE p.is_active = true
        GROUP BY p.id
        ORDER BY p.published_at DESC NULLS LAST, p.created_at DESC`));
    } else {
      ({ rows } = await db.query(`
        SELECT p.*,
          pa.acknowledged_at,
          (pa.id IS NOT NULL) AS acknowledged
        FROM policies p
        LEFT JOIN policy_acknowledgments pa
          ON pa.policy_id = p.id AND pa.staff_id = $1 AND pa.policy_version = p.version
        WHERE p.is_active = true AND $2 = ANY(p.required_roles)
        ORDER BY (pa.id IS NULL) DESC, p.title`,
        [req.user.id, req.user.role]));
    }
    res.json(rows);
  } catch (err) {
    console.error('policies GET /', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get single policy with acknowledgment status for current user
router.get('/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT * FROM policies WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const policy = rows[0];
    const { rows: ack } = await db.query(
      `SELECT acknowledged_at FROM policy_acknowledgments
       WHERE policy_id = $1 AND staff_id = $2 AND policy_version = $3`,
      [req.params.id, req.user.id, policy.version]
    );
    res.json({ ...policy, acknowledged: ack.length > 0, acknowledged_at: ack[0]?.acknowledged_at || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Staff acknowledges a policy
router.post('/:id/acknowledge', async (req, res) => {
  const db = getPool();
  try {
    const { rows: pol } = await db.query('SELECT version FROM policies WHERE id = $1 AND is_active = true', [req.params.id]);
    if (!pol.length) return res.status(404).json({ error: 'Policy not found' });
    await db.query(
      `INSERT INTO policy_acknowledgments (policy_id, staff_id, policy_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (policy_id, staff_id, policy_version) DO NOTHING`,
      [req.params.id, req.user.id, pol[0].version]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: get acknowledgment status (who has read a policy)
router.get('/:id/acknowledgments', async (req, res) => {
  if (!MANAGER_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT s.id, s.name, s.role, pa.acknowledged_at
      FROM staff s
      LEFT JOIN policy_acknowledgments pa
        ON pa.staff_id = s.id AND pa.policy_id = $1
      WHERE s.is_active = true
      ORDER BY pa.acknowledged_at NULLS LAST, s.name`,
      [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: create a new policy
router.post('/', async (req, res) => {
  if (!MANAGER_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  const { title, content, category, required_roles } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title and content required' });
  try {
    const { rows } = await db.query(`
      INSERT INTO policies (title, content, category, required_roles, is_active, published_at)
      VALUES ($1, $2, $3, $4, true, now()) RETURNING *`,
      [title, content, category || null, required_roles || ['practitioner','room_leader','manager']]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: update a policy (bump_version resets acknowledgments)
router.patch('/:id', async (req, res) => {
  if (!MANAGER_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  const { title, content, category, required_roles, is_active, bump_version } = req.body;
  try {
    const versionClause = bump_version ? ', version = version + 1' : '';
    const { rows } = await db.query(`
      UPDATE policies
      SET title = COALESCE($1, title),
          content = COALESCE($2, content),
          category = COALESCE($3, category),
          required_roles = COALESCE($4, required_roles),
          is_active = COALESCE($5, is_active)
          ${versionClause}
      WHERE id = $6 RETURNING *`,
      [title, content, category, required_roles, is_active, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
