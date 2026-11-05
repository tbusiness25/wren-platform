'use strict';
// AI reminders (b151) — thin REST wrapper around src/lib/reminders.js, used by
// the chat intent handler (src/routes/ai.js) internally and exposed here for
// direct testing / any future UI. Reminders are per-staff and staff-only.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const reminders = require('../lib/reminders');
const { formatWhen } = require('../lib/reminder-nlp');

router.use(authenticate);

function serialise(r) {
  return { ...r, formatted_when: formatWhen(new Date(r.due_at), r.recurrence) };
}

// GET /api/reminders?status=pending
router.get('/', async (req, res) => {
  if (!Number.isInteger(req.user?.id)) return res.status(403).json({ error: 'staff only' });
  try {
    const rows = await reminders.listReminders(getPool(), req.user.id, { status: req.query.status });
    res.json(rows.map(serialise));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/reminders  { task_text, due_at (ISO), recurrence }
router.post('/', async (req, res) => {
  if (!Number.isInteger(req.user?.id)) return res.status(403).json({ error: 'staff only' });
  const { task_text, due_at, recurrence } = req.body || {};
  if (!task_text || !due_at) return res.status(400).json({ error: 'task_text and due_at required' });
  const dueAt = new Date(due_at);
  if (isNaN(dueAt.getTime())) return res.status(400).json({ error: 'due_at is not a valid date' });
  if (dueAt.getTime() < Date.now()) return res.status(400).json({ error: 'due_at must be in the future' });
  try {
    const row = await reminders.createReminder(getPool(), {
      staffId: req.user.id, taskText: task_text, dueAt, recurrence: recurrence || 'none', createdVia: 'api',
    });
    res.status(201).json(serialise(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/reminders/:id — cancel (only your own, only if still pending)
router.delete('/:id', async (req, res) => {
  if (!Number.isInteger(req.user?.id)) return res.status(403).json({ error: 'staff only' });
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid reminder id' });
  try {
    const row = await reminders.cancelReminder(getPool(), req.user.id, req.params.id);
    if (!row) return res.status(404).json({ error: 'not found (or not pending / not yours)' });
    res.json({ ok: true, reminder: serialise(row) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
