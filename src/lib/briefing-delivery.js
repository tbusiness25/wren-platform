'use strict';
// b503 — who gets which briefing, and the Monday-morning pass that tells them. Rides the dispatcher poller (like task reminders), prod only,
// only for a period a manager has switched ON in settings (briefing_week_enabled / _month_ / _term_), once per person per briefing.
//
// What leaves Wren: an in-app notification (+ push where the person has it) and, because `briefing_ready` is classified as emailable for staff,
// possibly an email — and that text is COUNTS ONLY ("2 urgent, 9 for this week. Open Wren to read it."). A briefing names children; this text never does.
const B = require('./briefings');

async function setting(db, key) {
  try { const { rows } = await db.query(`SELECT value FROM settings WHERE key=$1`, [key]); return rows[0] && rows[0].value === 'true'; } catch (e) { return false; }
}

/** The counts-only text. Pure: takes numbers, returns strings. */
function notificationText(b) {
  const word = { week: 'weekly', month: 'monthly', term: 'termly' }[b.period];
  const per = { week: 'this week', month: 'the next four weeks', term: 'next term' }[b.period];
  return { title: `Your ${word} briefing is ready`, body: `${b.counts.urgent} urgent, ${b.counts.this_period} for ${per}. Open Wren to read it.` };
}

/** Is this Monday a termly-briefing Monday? The first Monday on or after the funding term's start, or the Monday nearest its middle. */
async function termMonday(db, today) {
  try {
    const { rows: [t] } = await db.query(`SELECT start_date::text AS s, end_date::text AS e FROM funding_terms WHERE $1::date BETWEEN start_date - 7 AND end_date ORDER BY (is_current IS TRUE) DESC, start_date DESC LIMIT 1`, [today]);
    if (!t) return false;
    const firstMon = B.mondayOnOrBefore(B.addDays(t.s, 6));
    const mid = B.mondayOnOrBefore(B.addDays(t.s, Math.round((new Date(t.e) - new Date(t.s)) / 86400000 / 2)));
    return today === firstMon || today === mid;
  } catch (e) { return false; }
}

async function deliverOne(db, notifyFn, b, staff) {
  const saved = await B.save(db, b);
  const { rows: ins } = await db.query(`INSERT INTO briefing_deliveries (briefing_id, staff_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING staff_id`, [saved.id, staff.id]);
  if (!ins.length) return { id: saved.id, sent: false };
  const t = notificationText(b);
  await notifyFn('briefing_ready', 'staff', staff.id, t.title, t.body, { relatedTable: 'briefings', relatedId: saved.id, link: `/briefing-link?id=${saved.id}`, priority: 'normal' });
  return { id: saved.id, sent: true };
}

/** One pass. `clk` = { today, hour, dow } for tests. Returns { periods, built, sent }. */
async function deliverDue(db, notifyFn, clk) {
  let now = clk;
  if (!now) { const { rows: [r] } = await db.query(`SELECT (now() AT TIME ZONE 'Europe/London')::date::text AS today, extract(hour FROM now() AT TIME ZONE 'Europe/London')::int AS hour, extract(dow FROM now() AT TIME ZONE 'Europe/London')::int AS dow`); now = r; }
  const res = { periods: [], built: 0, sent: 0 };
  if (now.dow !== 1 || now.hour < 7) return res;                  // Monday, from 07:00 London
  const due = [];
  if (await setting(db, 'briefing_week_enabled')) due.push('week');
  if (Number(now.today.slice(8, 10)) <= 7 && await setting(db, 'briefing_month_enabled')) due.push('month');
  if (await setting(db, 'briefing_term_enabled') && await termMonday(db, now.today)) due.push('term');
  if (!due.length) return res;
  const { rows: people } = await db.query(`SELECT id, role, room_id FROM staff WHERE is_active = true AND COALESCE(terminated,false) = false AND role IN ('manager','admin','headteacher','deputy_manager','room_leader') ORDER BY id`);
  for (const period of due) {
    res.periods.push(period);
    const cache = new Map();
    for (const p of people) {
      const scope = B.scopeForStaff(p); if (!scope) continue;
      const key = B.scopeKeyOf(scope);
      if (!cache.has(key)) { cache.set(key, await B.build(db, period, scope, now.today)); res.built++; }
      const r = await deliverOne(db, notifyFn, cache.get(key), p);
      if (r.sent) res.sent++;
    }
  }
  return res;
}

module.exports = { deliverDue, deliverOne, notificationText, termMonday };
