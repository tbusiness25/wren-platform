// src/routes/action-plan-items.js
// Routes for action_plan_items, comments, and deadline calendar events.
// Mounted at /api/action-plan-items in admin, ladn, hr, and parents servers.

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(8000)
    });
  } catch {}
}

// GET /calendar — action item deadlines formatted as calendar events
// Used by the calendar page to surface action plan due dates.
router.get('/calendar', async (req, res) => {
  try {
    const db = getPool();
    const isManager = ['manager', 'deputy_manager', 'room_leader', 'senior_practitioner'].includes(req.user.role);
    const params = [];
    let extraWhere = '';
    if (!isManager) {
      params.push(req.user.id);
      extraWhere = ` AND i.assigned_staff_id = $${params.length}`;
    }
    const { rows } = await db.query(`
      SELECT i.id, i.title, i.deadline, i.priority, i.plan_id,
             ap.title AS plan_title
      FROM action_plan_items i
      JOIN action_plans ap ON ap.id = i.plan_id
      WHERE i.status != 'completed'
        AND i.deadline IS NOT NULL
        AND ap.archived_at IS NULL
        ${extraWhere}
      ORDER BY i.deadline ASC LIMIT 90
    `, params);
    const events = rows.map(r => ({
      id: 'action-' + r.id,
      title: '[Action] ' + r.title,
      start: r.deadline,
      end: r.deadline,
      type: 'action-deadline',
      colour: r.priority === 'high' ? '#ef4444' : r.priority === 'medium' ? '#f59e0b' : '#22c55e',
      details_url: '/action-plans.html#item-' + r.id,
      plan_title: r.plan_title,
      priority: r.priority
    }));
    res.json(events);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET / — list items for a plan (query param: plan_id)
router.get('/', async (req, res) => {
  const planId = req.query.plan_id;
  if (!planId) return res.status(400).json({ error: 'plan_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT i.*,
             s.first_name || ' ' || s.last_name AS assignee_name,
             cs.first_name || ' ' || cs.last_name AS completed_by_name,
             (SELECT COUNT(*)::int FROM action_plan_comments c WHERE c.item_id = i.id) AS comment_count
      FROM action_plan_items i
      LEFT JOIN staff s ON s.id = i.assigned_staff_id
      LEFT JOIN staff cs ON cs.id = i.completed_by_staff_id
      WHERE i.plan_id = $1
      ORDER BY i.position ASC, i.priority DESC, i.deadline ASC NULLS LAST
    `, [planId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — add action item to a plan
router.post('/', async (req, res) => {
  const { plan_id, title, description, priority, deadline, category, tags, assigned_staff_id, notify_assignee } = req.body;
  if (!plan_id || !title) return res.status(400).json({ error: 'plan_id and title required' });
  const isManager = ['manager', 'deputy_manager', 'room_leader', 'senior_practitioner'].includes(req.user.role);
  if (!isManager) return res.status(403).json({ error: 'Manager role required to add items' });
  try {
    const db = getPool();
    // Verify plan exists and is not archived
    const { rows: plan } = await db.query(
      'SELECT id, title, scope FROM action_plans WHERE id=$1 AND archived_at IS NULL', [plan_id]
    );
    if (!plan.length) return res.status(404).json({ error: 'Plan not found' });
    const { rows } = await db.query(`
      INSERT INTO action_plan_items
        (plan_id, title, description, priority, deadline, category, tags, assigned_staff_id, notify_assignee)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [plan_id, title, description || null, priority || 'medium', deadline || null,
        category || null, tags || null, assigned_staff_id || null,
        notify_assignee !== false]);

    // Notify assignee if telegram_chat_id set
    if (assigned_staff_id) {
      const { rows: st } = await db.query(
        'SELECT telegram_chat_id, first_name FROM staff WHERE id=$1', [assigned_staff_id]
      );
      if (st[0]?.telegram_chat_id) {
        const dl = deadline ? ` (due ${new Date(deadline).toLocaleDateString('en-GB')})` : '';
        await sendTelegramTo(st[0].telegram_chat_id,
          `[ACTIONS] Hi ${st[0].first_name}, you've been assigned an action: "${title}"${dl} on plan "${plan[0].title}"`);
      }
    }
    // Always notify manager TELEGRAM_CHAT_ID on assignment
    if (assigned_staff_id) {
      await sendTelegram(`[ACTIONS] New action assigned: "${title}" on "${plan[0].title}"`);
    }

    // Audit
    await db.query(`INSERT INTO action_plan_audit (plan_id,item_id,actor_id,actor_type,action,after_value)
      VALUES ($1,$2,$3,'staff','item_created',$4)`,
      [plan_id, rows[0].id, req.user.id, JSON.stringify(rows[0])]).catch(() => {});

    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id — update an action item (assignee or manager)
router.patch('/:id', async (req, res) => {
  const allowed = ['title', 'description', 'priority', 'status', 'deadline', 'category', 'tags', 'assigned_staff_id', 'position'];
  const updates = [];
  const vals = [];
  for (const f of allowed) {
    if (req.body[f] !== undefined) {
      vals.push(req.body[f]);
      updates.push(`${f}=$${vals.length}`);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  try {
    const db = getPool();
    const { rows: check } = await db.query(`
      SELECT i.*, ap.scope, ap.title AS plan_title
      FROM action_plan_items i
      JOIN action_plans ap ON ap.id = i.plan_id
      WHERE i.id = $1
    `, [req.params.id]);
    if (!check.length) return res.status(404).json({ error: 'Not found' });
    const item = check[0];
    const isManager = ['manager', 'deputy_manager', 'room_leader', 'senior_practitioner'].includes(req.user.role);
    const isAssignee = item.assigned_staff_id === req.user.id;
    if (!isManager && !isAssignee) return res.status(403).json({ error: 'Only assignee or manager can update this item' });

    // Mark completion timestamp
    if (req.body.status === 'completed' && item.status !== 'completed') {
      updates.push('completed_at=NOW()');
      vals.push(req.user.id);
      updates.push(`completed_by_staff_id=$${vals.length}`);
    }
    updates.push('updated_at=NOW()');
    vals.push(req.params.id);

    const { rows } = await db.query(
      `UPDATE action_plan_items SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );

    // Notify manager on completion
    if (req.body.status === 'completed' && item.status !== 'completed') {
      const who = req.user.username || `staff ${req.user.id}`;
      await sendTelegram(`[ACTIONS] Action completed: "${item.title}" (plan: "${item.plan_title}") by ${who}`);
    }

    // Notify new assignee
    if (req.body.assigned_staff_id && req.body.assigned_staff_id !== item.assigned_staff_id) {
      const { rows: st } = await db.query(
        'SELECT telegram_chat_id, first_name FROM staff WHERE id=$1', [req.body.assigned_staff_id]
      );
      if (st[0]?.telegram_chat_id) {
        await sendTelegramTo(st[0].telegram_chat_id,
          `[ACTIONS] Hi ${st[0].first_name}, you've been assigned: "${item.title}" on plan "${item.plan_title}"`);
      }
    }

    await db.query(`INSERT INTO action_plan_audit (plan_id,item_id,actor_id,actor_type,action,before_value,after_value)
      VALUES ($1,$2,$3,'staff','item_updated',$4,$5)`,
      [item.plan_id, item.id, req.user.id, JSON.stringify({ status: item.status, assigned_staff_id: item.assigned_staff_id }), JSON.stringify(req.body)]
    ).catch(() => {});

    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/comments — list comments on an item
router.get('/:id/comments', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.*,
             CASE WHEN c.author_type != 'parent'
               THEN s.first_name || ' ' || s.last_name
               ELSE 'Parent'
             END AS author_name
      FROM action_plan_comments c
      LEFT JOIN staff s ON s.id = c.author_id AND c.author_type != 'parent'
      WHERE c.item_id = $1
      ORDER BY c.created_at ASC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/comments — add a comment
router.post('/:id/comments', async (req, res) => {
  const commentBody = req.body.body;
  if (!commentBody?.trim()) return res.status(400).json({ error: 'Comment body required' });
  try {
    const db = getPool();
    const { rows: check } = await db.query(`
      SELECT i.plan_id, ap.scope, i.title AS item_title, ap.title AS plan_title
      FROM action_plan_items i
      JOIN action_plans ap ON ap.id = i.plan_id
      WHERE i.id = $1
    `, [req.params.id]);
    if (!check.length) return res.status(404).json({ error: 'Not found' });
    const authorType = ['manager', 'deputy_manager'].includes(req.user.role) ? 'manager' : 'staff';
    const { rows } = await db.query(`
      INSERT INTO action_plan_comments (item_id, author_type, author_id, body)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [req.params.id, authorType, req.user.id, commentBody.trim()]);
    const who = req.user.username || `staff ${req.user.id}`;
    await sendTelegram(`[ACTIONS] Comment on "${check[0].item_title}": ${commentBody.trim().substring(0,80)} — by ${who}`);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function sendTelegramTo(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(8000)
    });
  } catch {}
}

module.exports = router;
