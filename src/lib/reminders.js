'use strict';
// AI reminders (b151) — shared DB access used by both the chat intent handler
// (src/routes/ai.js) and the REST API (src/routes/reminders.js). Table:
// ladn.ai_reminders (scripts/migrations/2026-07-23-b151-ai-reminders-automations.sql).

async function createReminder(db, { staffId, taskText, dueAt, recurrence, createdVia }) {
  const { rows } = await db.query(
    `INSERT INTO ai_reminders (staff_id, task_text, due_at, recurrence, created_via)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [staffId, taskText, dueAt, recurrence || 'none', createdVia || 'chat']
  );
  return rows[0];
}

async function listReminders(db, staffId, { status } = {}) {
  const params = [staffId];
  let q = `SELECT * FROM ai_reminders WHERE staff_id=$1`;
  if (status) { params.push(status); q += ` AND status=$${params.length}`; }
  q += ' ORDER BY due_at ASC';
  const { rows } = await db.query(q, params);
  return rows;
}

// Fuzzy-find a staff member's own PENDING reminder by substring match against
// task_text — used both by chat cancel ("cancel the fire alarm one") and the
// REST API. Returns the single best match, or null if 0 or >1 candidates match
// (ambiguous — caller should ask the user to be more specific).
async function findPendingReminderByText(db, staffId, searchText) {
  const clean = String(searchText || '').trim();
  if (!clean) return { match: null, candidates: [] };
  const { rows } = await db.query(
    `SELECT * FROM ai_reminders WHERE staff_id=$1 AND status='pending'
       AND task_text ILIKE $2
     ORDER BY due_at ASC`,
    [staffId, `%${clean}%`]
  );
  if (rows.length === 1) return { match: rows[0], candidates: rows };
  return { match: null, candidates: rows };
}

async function cancelReminder(db, staffId, id) {
  const { rows } = await db.query(
    `UPDATE ai_reminders SET status='cancelled', updated_at=NOW()
     WHERE id=$1 AND staff_id=$2 AND status='pending' RETURNING *`,
    [id, staffId]
  );
  return rows[0] || null;
}

module.exports = { createReminder, listReminders, findPendingReminderByText, cancelReminder };
