'use strict';
/**
 * kitchen.js — b331 collector for the b232 "What needs me" board. The kitchen.
 *
 *   Morning checks not done by 10:00 (today)       RED    statutory, due today
 *   End-of-day checks not done by 17:30 (today)    RED
 *   Either one missed on an earlier day this week  AMBER  overdue — until Toby
 *                                                         marks it done, or the
 *                                                         day drops out of the
 *                                                         7-day window
 *   Fridge/freezer probe above limit > 60 min      RED    food safety
 *   No probe reading for 2 hours                   AMBER  a feed that stopped
 *   Problems in today's checks ("No", too warm)    AMBER  blocked on Toby
 *   A shopping order the chef sent (last 7 days)      AMBER  blocked on Toby
 *
 * Days before settings.kitchen_checks_alert_from never count, and weekends and
 * bank holidays are skipped. Nothing on a card names a child.
 *
 * ── WHY IT REFUSES TO RUN FROM THE HOST ─────────────────────────────────────
 * scripts/attention-refresh.js runs every collector from the working tree at
 * 06:45 against PRODUCTION. This collector creates tables on first use and its
 * cards only make sense once the kitchen screens are deployed, so it runs only
 * inside the Wren app process that started src/jobs/kitchen-watch.js (which sets
 * the flag below), or when KITCHEN_COLLECTOR=on is set deliberately. Anywhere
 * else it reports ok:false, which by the refresh's rule 2 resolves nothing and
 * inserts nothing.
 */

const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'kitchen';

async function collect() {
  if (!global.__wrenKitchenWatch && process.env.KITCHEN_COLLECTOR !== 'on') {
    return { ok: false, items: [], note: 'runs inside the Wren app only (src/jobs/kitchen-watch.js)' };
  }
  const K = require('../../lib/kitchen-simple');
  const db = getPool();
  try { await K.ensureSchema(db); }
  catch (e) { return { ok: false, items: [], note: `kitchen tables: ${e.message}` }; }

  const now = K.londonNow();
  const limits = await K.getLimits(db);
  const items = [];

  // 1. Missed checks.
  for (const m of await K.missedChecks(db, now, limits)) {
    const c = m.today
      ? classify({ statutory: true, dueDate: m.date })
      : classify({ dueDate: m.date });
    const what = m.shift === 'opening' ? 'morning checks' : 'end-of-day checks';
    items.push({
      source: SOURCE,
      source_key: `sfbb-${m.shift}:${m.date}`,
      rag: c.rag,
      title: `Kitchen ${what} not done — ${K.shortDayLabel(m.date)}`,
      detail: `${m.answered} of ${m.total} questions answered. ${m.shift === 'opening' ? 'Due by 10:00.' : 'Due by 17:30.'} ` +
              'Safer Food Better Business records are a legal requirement.',
      why: m.today
        ? `The ${what} were due by ${m.shift === 'opening' ? '10:00' : '17:30'} today.`
        : `Missed on ${K.shortDayLabel(m.date)} — mark done once you have spoken to the kitchen.`,
      category: 'kitchen',
      due_date: m.date,
      blocked_on: 'toby',
      effort_minutes: 5,
      action_url: '/kitchen-sfbb-review.html',
      evidence: { date: m.date, shift: m.shift, answered: m.answered, total: m.total },
      sort_hint: m.shift === 'opening' ? 0 : 1,
    });
  }

  // 2. Fridge / freezer probes.
  for (const s of await K.sensorStatus(db, limits)) {
    if (!s.flagged) continue;
    const c = s.status === 'too_warm' ? classify({ childSafety: true }) : classify({ cronStopped: true });
    items.push({
      source: SOURCE,
      source_key: `sensor-${s.status}:${s.location}`,
      rag: c.rag,
      title: s.status === 'too_warm'
        ? `${s.label} probe above ${s.limit}°C for over an hour`
        : `${s.label} probe: no reading for 2 hours`,
      detail: s.detail,
      why: s.status === 'too_warm'
        ? 'Chilled food kept above the limit is a food-safety risk. The kitchen screen is telling the chef to check it by hand.'
        : 'Nobody is watching this fridge/freezer until the probe reports again.',
      category: 'kitchen',
      due_date: now.date,
      blocked_on: 'toby',
      effort_minutes: 10,
      action_url: '/kitchen.html',
      evidence: { location: s.location, status: s.status, reading: s.reading == null ? null : s.reading, limit: s.limit },
      sort_hint: 0,
    });
  }

  // 3. Problems in today's checks.
  const probs = await K.problemsToday(db, now.date, limits);
  if (probs.length) {
    const c = classify({ blockedOnToby: true });
    items.push({
      source: SOURCE,
      source_key: `sfbb-problems:${now.date}`,
      rag: c.rag,
      title: `Kitchen: ${probs.length} problem${probs.length === 1 ? '' : 's'} in today's food-safety checks`,
      detail: probs.slice(0, 8).join('; ') + (probs.length > 8 ? `; +${probs.length - 8} more` : ''),
      why: 'the chef answered No or recorded a reading outside the limit. She has been asked to tell you.',
      category: 'kitchen',
      due_date: now.date,
      blocked_on: 'toby',
      effort_minutes: 10,
      action_url: '/kitchen-sfbb-review.html',
      evidence: { date: now.date, problems: probs.length },
      sort_hint: 2,
    });
  }

  // 4. Shopping orders waiting for Toby.
  const { rows: lists } = await db.query(`
    SELECT id, items_json, ordered_by, created_at FROM shopping_lists
     WHERE source = 'favourites' AND status = 'sent' AND created_at > now() - interval '7 days'
     ORDER BY created_at`);
  for (const l of lists) {
    const its = Array.isArray(l.items_json) ? l.items_json : [];
    const c = classify({ blockedOnToby: true });
    items.push({
      source: SOURCE,
      source_key: `shopping:${l.id}`,
      rag: c.rag,
      title: `Kitchen shopping order — ${its.length} item${its.length === 1 ? '' : 's'} from ${K.firstName(l.ordered_by) || 'the kitchen'}`,
      detail: its.map(i => `${i.name} ×${i.qty}`).join(', ').slice(0, 1500),
      why: 'Sent from the kitchen screen. Mark it ordered in Roost → Kitchen → Shopping Lists.',
      category: 'kitchen',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 15,
      action_url: '/kitchen.html',
      evidence: { shopping_list_id: l.id, items: its.length },
      sort_hint: 3,
    });
  }

  return { ok: true, items };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
