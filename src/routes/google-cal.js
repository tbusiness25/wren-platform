'use strict';
const express    = require('express');
const router     = express.Router();
const authenticate = require('../middleware/auth');
const { getPool }  = require('../db/pool');

router.use(authenticate);

let gcal = null;
function _gcal() {
  if (!gcal) gcal = require('../lib/google-calendar');
  return gcal;
}

// Google Calendar is an OPTIONAL integration. When GOOGLE_SA_KEY is unset it's
// simply disabled — endpoints degrade gracefully (no events, calm status) rather
// than erroring, so the staff calendar still loads its DB-sourced events.
const _gcalEnabled = () => !!process.env.GOOGLE_SA_KEY;

// GET /api/google-cal/status
router.get('/status', async (req, res) => {
  if (!_gcalEnabled()) return res.json({ ok: false, connected: false, configured: false, reason: 'Google Calendar not configured (optional)' });
  try {
    const db = getPool();
    const status = await _gcal().testConnection(db);
    res.json(status);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/google-cal/events?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/events', async (req, res) => {
  if (!_gcalEnabled()) return res.json([]); // optional integration disabled — no events, no error
  const { from, to, days } = req.query;
  const fromDate = from || new Date().toISOString().slice(0, 10);
  const toDate   = to   || (() => {
    const d = new Date(); d.setDate(d.getDate() + parseInt(days || 30));
    return d.toISOString().slice(0, 10);
  })();
  try {
    const db     = getPool();
    const events = await _gcal().listEvents(db, { from: fromDate, to: toDate });
    res.json(events.map(e => ({
      id:          e.id,
      summary:     e.summary,
      description: e.description,
      location:    e.location,
      start:       e.start?.dateTime || e.start?.date,
      end:         e.end?.dateTime   || e.end?.date,
      all_day:     !e.start?.dateTime,
      html_link:   e.htmlLink,
      colour_id:   e.colorId,
      wren_ref:    e.extendedProperties?.private?.wrenRef,
      wren_type:   e.extendedProperties?.private?.wrenType,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/google-cal/events — manual event creation
router.post('/events', async (req, res) => {
  const { summary, description, start, end, location, all_day } = req.body;
  if (!summary || !start) return res.status(400).json({ error: 'summary and start required' });
  try {
    const db = getPool();
    // For all-day events, use date-only format
    const startVal = all_day ? start.slice(0, 10) : start;
    const endVal   = all_day ? (end || start).slice(0, 10) : (end || start);
    const event = await _gcal().createEvent(db, {
      summary, description, location,
      start: startVal, end: endVal,
      wrenRef:  `manual-${Date.now()}`,
      wrenType: 'manual',
    });
    res.status(201).json({ ok: true, id: event.id, html_link: event.htmlLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/google-cal/events/:id
router.delete('/events/:id', async (req, res) => {
  try {
    const db = getPool();
    await _gcal().deleteEvent(db, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/google-cal/push/outing/:id — sync outing to Google Calendar
router.post('/push/outing/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [outing] } = await db.query(
      `SELECT * FROM outings WHERE id = $1`, [req.params.id]
    );
    if (!outing) return res.status(404).json({ error: 'Outing not found' });
    const dateStr = outing.outing_date
      ? new Date(outing.outing_date).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const summary = `Trip: ${outing.destination || outing.title || 'Nursery outing'}`;
    const desc    = [
      outing.notes ? `Notes: ${outing.notes}` : '',
      outing.children_count ? `Children: ${outing.children_count}` : '',
      outing.staff_count    ? `Staff: ${outing.staff_count}` : '',
    ].filter(Boolean).join('\n');
    const event = await _gcal().createEvent(db, {
      summary, description: desc,
      location: outing.destination,
      start: dateStr, end: dateStr,
      wrenRef: `outing-${outing.id}`, wrenType: 'outing',
      colorId: '5', // banana/yellow
    });
    res.json({ ok: true, gcal_id: event.id, html_link: event.htmlLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/google-cal/push/enquiry-tour/:id — sync tour booking to calendar
router.post('/push/enquiry-tour/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [enq] } = await db.query(
      `SELECT * FROM enquiries WHERE id = $1`, [req.params.id]
    );
    if (!enq) return res.status(404).json({ error: 'Enquiry not found' });
    if (!enq.tour_date) return res.status(400).json({ error: 'No tour date on enquiry' });

    const dateStr = new Date(enq.tour_date).toISOString().slice(0, 10);
    const summary = `Tour: ${enq.parent_name || enq.child_name || 'Enquiry'} (${enq.child_name || ''})`;
    const desc    = [
      enq.parent_email  ? `Email: ${enq.parent_email}` : '',
      enq.parent_phone  ? `Phone: ${enq.parent_phone}` : '',
      enq.preferred_room ? `Room: ${enq.preferred_room}` : '',
      enq.notes         ? `Notes: ${enq.notes}` : '',
    ].filter(Boolean).join('\n');
    const event = await _gcal().createEvent(db, {
      summary, description: desc,
      start: enq.tour_date, end: enq.tour_date,
      wrenRef: `enquiry-tour-${enq.id}`, wrenType: 'enquiry_tour',
      colorId: '3', // sage/green
    });
    res.json({ ok: true, gcal_id: event.id, html_link: event.htmlLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/google-cal/push/action-plan-item/:id — sync action deadline
router.post('/push/action-plan-item/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [item] } = await db.query(
      `SELECT i.*, ap.title AS plan_title
       FROM action_plan_items i
       JOIN action_plans ap ON ap.id = i.plan_id
       WHERE i.id = $1`, [req.params.id]
    );
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!item.deadline) return res.status(400).json({ error: 'No deadline set' });

    const dateStr = new Date(item.deadline).toISOString().slice(0, 10);
    const event   = await _gcal().createEvent(db, {
      summary: `[Action] ${item.title}`,
      description: `Plan: ${item.plan_title}\nPriority: ${item.priority || 'normal'}`,
      start: dateStr, end: dateStr,
      wrenRef: `action-item-${item.id}`, wrenType: 'action_deadline',
      colorId: item.priority === 'high' ? '11' : '6', // tomato or tangerine
    });
    res.json({ ok: true, gcal_id: event.id, html_link: event.htmlLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/google-cal/synced — list all synced events
router.get('/synced', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM gcal_events ORDER BY synced_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
