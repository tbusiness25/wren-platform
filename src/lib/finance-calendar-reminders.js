'use strict';
/**
 * finance-calendar-reminders.js — b346
 *
 * The notification half of "a calendar with teeth". The What-needs-me board is the
 * other half (src/services/attention/finance-calendar.js) and this file reuses the
 * SAME colour decision, so a reminder and a card can never disagree about whether a
 * deadline is red.
 *
 * It rides the EXISTING notification dispatcher poller (services/notification-
 * dispatcher.js startDispatcher, 30s) exactly as b184 event reminders and b209 task
 * reminders do — no new cron job, no new systemd timer. It is throttled to once an
 * hour inside the process, because a deadline calendar does not change every 30
 * seconds, and it only speaks between 08:00 and 18:00 London, so nobody is woken at
 * 03:00 by a tax return.
 *
 * ── TWO MESSAGES PER OCCURRENCE AT MOST ─────────────────────────────────────
 *   finance_deadline       our own date has arrived (in-app only — a heads-up)
 *   finance_deadline_red   the statutory date is within 7 days or has passed (urgent)
 * Each is CLAIMED first (INSERT … ON CONFLICT DO NOTHING on finance_calendar_notices)
 * and only sent by whoever wins the insert. At-most-once: a crash between the claim
 * and the send loses one reminder, which the board card still shows; the alternative
 * is the same sentence every 30 seconds.
 *
 * Recipients are the finance-trusted managers (canViewSalaries — the owner and the
 * finance roles), not "all managers": all-managers includes room leaders, and the
 * company's tax position is not theirs to chase. Personal preferences still apply
 * (mute / digest) because the dispatcher enforces them.
 *
 * Nothing here contains an amount, a child, a parent or a member of staff — dates,
 * the rule's name, and who is waiting.
 */

const store = require('./finance-calendar-store');
const cal = require('./finance-calendar');
const { canViewSalaries } = require('./capabilities');
const { ragOf } = require('../services/attention/finance-calendar');

const CATEGORY = 'finance_deadline';
const CATEGORY_RED = 'finance_deadline_red';
const LINK = '/admin/finance-hmrc/calendar';
const EVERY_MS = 60 * 60 * 1000;
const PARTY_WORD = { toby: 'you', accountant: 'the accountant', bank: 'the bank', hmrc: 'HMRC' };

let _lastRun = 0;

const londonHour = (d = new Date()) =>
  parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(d), 10) % 24;

/** Who gets these: active managers/admins who hold the finance-trusted check. */
async function financeRecipients(db) {
  const { rows } = await db.query(`SELECT id, role FROM staff WHERE is_active = true AND role IN ('manager','admin')`);
  const out = [];
  for (const r of rows) {
    try { if (await canViewSalaries({ id: r.id, role: r.role })) out.push(r.id); } catch { /* fail closed */ }
  }
  return out;
}

function textFor(occ, stage, r) {
  const party = PARTY_WORD[occ.blocked_on] || 'you';
  const dates = occ.statutory
    ? `Our own date is ${cal.niceDate(occ.internal)}; the statutory date is ${cal.niceDate(occ.statutory)}.`
    : `Our own date is ${cal.niceDate(occ.internal)}.`;
  const tail = `Waiting on ${party}. Mark it done in Finance → HMRC & Deadlines with a note of what was filed.`;
  if (stage === 'red') {
    const d = occ.days_to_statutory;
    const when = d < 0 ? `Overdue by ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'}` : d === 0 ? 'Due today' : `Due in ${d} day${d === 1 ? '' : 's'}`;
    return { title: `${when}: ${occ.title}`, body: `${occ.label}. ${r.why} ${dates} ${tail}` };
  }
  return { title: `Coming up: ${occ.title}`, body: `${occ.label}. ${dates} ${tail}` };
}

/**
 * @param {object} db        pg pool
 * @param {Function} dispatch  notification-dispatcher's async dispatch (category, recipientType, recipientId, title, body, opts)
 * @param {{force?:boolean, today?:string, now?:Date}} opts   force skips the throttle and the working-hours window (tests)
 */
async function sweepFinanceCalendar(db, dispatch, opts = {}) {
  const now = opts.now || new Date();
  if (!opts.force) {
    if (Date.now() - _lastRun < EVERY_MS) return { scheduled: 0, fired: 0, skipped: 'throttled' };
    const h = londonHour(now);
    if (h < 8 || h >= 18) return { scheduled: 0, fired: 0, skipped: 'outside_working_hours' };
  }
  _lastRun = Date.now();

  if (!(await store.hasTables(db))) return { scheduled: 0, fired: 0, skipped: 'not_migrated' };
  const { rows: nt } = await db.query(`SELECT to_regclass('finance_calendar_notices') AS t`);
  if (!nt[0] || !nt[0].t) return { scheduled: 0, fired: 0, skipped: 'not_migrated' };

  const c = await store.loadCalendar(db, opts.today ? { today: opts.today } : {});
  const due = c.occurrences.filter(o => !o.marker && o.status === 'open' && c.today >= (o.internal || o.statutory));
  if (!due.length) return { scheduled: 0, fired: 0 };

  const recipients = await financeRecipients(db);
  let fired = 0;

  for (const raw of due) {
    const occ = Object.assign({}, raw, { days_to_statutory: raw.statutory ? cal.diffDays(c.today, raw.statutory) : null });
    const r = ragOf(occ);
    const stage = r.rag === 'red' ? 'red' : 'internal';

    const claim = await db.query(
      `INSERT INTO finance_calendar_notices (rule_code, period_key, stage, recipients) VALUES ($1,$2,$3,$4)
       ON CONFLICT (rule_code, period_key, stage) DO NOTHING RETURNING 1`,
      [occ.rule, occ.period, stage, recipients.length]);
    if (!claim.rowCount) continue;                 // already said it

    const t = textFor(occ, stage, r);
    for (const id of recipients) {
      try {
        await dispatch(stage === 'red' ? CATEGORY_RED : CATEGORY, 'staff', id, t.title, t.body,
          { link: LINK, priority: stage === 'red' ? 'urgent' : 'normal', relatedTable: 'finance_calendar_items' });
        fired++;
      } catch (e) { /* one person's preferences must not stop the rest */ }
    }
  }
  return { scheduled: due.length, fired };
}

module.exports = { sweepFinanceCalendar, financeRecipients, CATEGORY, CATEGORY_RED, _resetThrottle: () => { _lastRun = 0; } };
