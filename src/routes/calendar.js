const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');

router.use(authenticate);

const N8N_BASE = process.env.N8N_URL || 'http://n8n:5678';

// GET /api/calendar/upcoming?days=7
router.get('/upcoming', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '7'), 30);
  try {
    const url = `${N8N_BASE}/webhook/staff-calendar?days=${days}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`n8n ${response.status}`);
    const data = await response.json();
    const events = Array.isArray(data) ? data : (data.events || data.items || []);
    res.json(events);
  } catch (err) {
    console.error('calendar fetch error:', err.message);
    res.json([]); // graceful empty — card shows friendly message
  }
});

// GET /actions — action plan item deadlines as calendar events
router.get('/actions', async (req, res) => {
  try {
    const { getPool } = require('../db/pool');
    const db = getPool();
    const isManager = ['manager', 'deputy_manager', 'room_leader', 'senior_practitioner'].includes(req.user.role);
    const params = [];
    let extra = '';
    if (!isManager) {
      params.push(req.user.id);
      extra = ` AND i.assigned_staff_id = $${params.length}`;
    }
    const { rows } = await db.query(`
      SELECT i.id, i.title, i.deadline, i.priority, ap.title AS plan_title
      FROM ladn.action_plan_items i
      JOIN ladn.action_plans ap ON ap.id = i.plan_id
      WHERE i.status != 'completed' AND i.deadline IS NOT NULL AND ap.archived_at IS NULL
      ${extra}
      ORDER BY i.deadline ASC LIMIT 90
    `, params);
    res.json(rows.map(r => ({
      id: 'action-' + r.id,
      title: '[Action] ' + r.title,
      start: r.deadline,
      end: r.deadline,
      type: 'action-deadline',
      colour: r.priority === 'high' ? '#ef4444' : r.priority === 'medium' ? '#f59e0b' : '#22c55e',
      details_url: '/action-plans.html#item-' + r.id,
      plan_title: r.plan_title
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
