const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const N8N_WEBHOOK = 'https://n8n.example.com/webhook/away-mode-changed';

const managerOnly = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

// GET /api/away-mode — current state
router.get('/', authenticate, managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT am.id, am.active, am.return_date, am.cover_person_id,
             am.updated_at,
             s.first_name || ' ' || s.last_name AS cover_person_name,
             u.first_name || ' ' || u.last_name AS updated_by_name
      FROM ladn.away_mode am
      LEFT JOIN ladn.staff s ON s.id = am.cover_person_id
      LEFT JOIN ladn.staff u ON u.id = am.updated_by
      WHERE am.id = 1
    `);
    if (!rows.length) return res.json({ active: false, return_date: null, cover_person_id: null });
    res.json(rows[0]);
  } catch (err) {
    console.error('away-mode GET error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// PUT /api/away-mode — update state, fire N8N webhook
router.put('/', authenticate, managerOnly, async (req, res) => {
  const db = getPool();
  const { active, return_date, cover_person_id } = req.body;
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });
  if (active && !return_date) return res.status(400).json({ error: 'return_date required when active=true' });

  try {
    const { rows } = await db.query(`
      UPDATE ladn.away_mode
      SET active          = $1,
          return_date     = $2,
          cover_person_id = $3,
          updated_at      = now(),
          updated_by      = $4
      WHERE id = 1
      RETURNING id, active, return_date, cover_person_id, updated_at
    `, [active, return_date || null, cover_person_id || null, req.user.id]);

    const state = rows[0];

    // Fire N8N webhook (fire and forget — N8N handles Google Workspace OOO)
    fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        active: state.active,
        return_date: state.return_date,
        cover_person_id: state.cover_person_id,
        updated_by: req.user.id,
        updated_at: state.updated_at,
      }),
      signal: AbortSignal.timeout(8000),
    }).catch(e => console.error('away-mode n8n webhook error:', e.message));

    res.json({ ok: true, ...state });
  } catch (err) {
    console.error('away-mode PUT error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

module.exports = router;
