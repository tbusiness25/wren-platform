'use strict';
/**
 * event-notify.js — b518 (2026-10-20)
 *
 * The in-app notification a family gets when a parent-facing event is published.
 * Lifted VERBATIM (behaviour-for-behaviour) out of src/routes/events.js, where it
 * was inline, so that the Events & Calendar area and /api/events share one copy
 * instead of drifting apart. events.js now calls this.
 *
 * Rules kept exactly as they were (2026-07-30):
 *   - only a published event, and only one that is not audience='staff';
 *   - audience 'all' / 'parents' → every child on the roster; a room id → that room;
 *   - in-app (and push where the family has it) only — NEVER an email to a parent.
 *     See the memory note feedback_no_auto_email_to_parents.
 *   - a failure here never fails the write that caused it.
 */

async function notifyParentsOfEvent(db, ev) {
  if (!ev || !ev.id) return { sent: 0, skipped: 'no event' };
  if (ev.is_published === false) return { sent: 0, skipped: 'not published' };
  const aud = String(ev.audience || 'all').toLowerCase();
  if (aud === 'staff') return { sent: 0, skipped: 'staff audience' };
  if (ev.layer && ev.layer !== 'parents') return { sent: 0, skipped: 'layer ' + ev.layer };
  try {
    const { notify } = require('../services/notification-dispatcher');
    const all = (aud === 'all' || aud === 'parents');
    const { rows: kids } = await db.query(
      all ? `SELECT id FROM children` : `SELECT id FROM children WHERE room_id::text = $1`,
      all ? [] : [String(ev.audience)]);
    for (const k of kids) {
      notify('event_published', 'parent', k.id, `New event: ${ev.title}`,
        (ev.description || '').slice(0, 160),
        { relatedTable: 'events', relatedId: ev.id, link: '/welcome/events' });
    }
    return { sent: kids.length };
  } catch (e) {
    return { sent: 0, error: e.message };   // notifications are optional, as before
  }
}

module.exports = { notifyParentsOfEvent };
