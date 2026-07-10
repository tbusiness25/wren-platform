const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET /api/compliance-events/upcoming
router.get('/upcoming', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT * FROM compliance_events
       WHERE is_active = true AND next_due <= CURRENT_DATE + interval '30 days'
       ORDER BY next_due ASC LIMIT 5`
    );
    res.json(rows);
  } catch (err) {
    console.error('compliance-events GET error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/compliance-events/:id/acknowledge
// Marks this occurrence done and advances next_due by the event's recurrence
router.post('/:id/acknowledge', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [evt] } = await db.query(
      'SELECT * FROM compliance_events WHERE id = $1', [req.params.id]
    );
    if (!evt) return res.status(404).json({ error: 'Not found' });

    const current = new Date(evt.next_due);
    let nextDue;

    if (evt.cron) {
      // Pattern: '0 0 D * *' — monthly on day D
      const parts = evt.cron.split(' ');
      const dayOfMonth = parseInt(parts[2]);
      if (!isNaN(dayOfMonth)) {
        // Advance by one month same day
        const next = new Date(current);
        next.setMonth(next.getMonth() + 1);
        nextDue = next;
      }
    }

    if (!nextDue && evt.rrule) {
      // Rough FREQ=MONTHLY support
      if (evt.rrule.includes('FREQ=MONTHLY')) {
        const next = new Date(current);
        next.setMonth(next.getMonth() + 1);
        nextDue = next;
      } else if (evt.rrule.includes('FREQ=YEARLY') || evt.rrule.includes('FREQ=ANNUAL')) {
        const next = new Date(current);
        next.setFullYear(next.getFullYear() + 1);
        nextDue = next;
      }
    }

    if (!nextDue) {
      // Heuristic: next_due gap from today determines recurrence
      const daysDiff = Math.ceil((current - new Date()) / 86400000) + 30;
      nextDue = new Date(current.getTime() + (daysDiff < 60 ? 30 : 365) * 86400000);
    }

    const nextDueStr = nextDue.toISOString().split('T')[0];
    const { rows } = await db.query(
      `UPDATE compliance_events SET next_due = $1 WHERE id = $2 RETURNING *`,
      [nextDueStr, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('compliance acknowledge error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

module.exports = router;
