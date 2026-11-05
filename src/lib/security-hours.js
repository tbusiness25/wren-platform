'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * security-hours.js — b505 (2026-10-18)
 *
 * THE ONE answer to "should the building be empty right now?", used by the
 * out-of-hours alert gate and by the Security hub's Out-of-hours tab. Both read
 * this; neither has its own copy of the rule, so the tab can never show a window
 * the alerter is not actually using.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────
 * IN HOURS  = Monday–Friday, between settings.security_alerts_open_time and
 *             settings.security_alerts_close_time (Europe/London), and NOT a
 *             bank holiday and NOT a nursery closure day.
 * OUT OF HOURS = everything else.
 *
 * Defaults are 07:30–18:30: the published 08:00–18:00 session plus a 30-minute
 * margin either side, so footage of staff arriving and locking up is treated as
 * in-hours footage. That is the same window /usr/local/sbin/ladn-cctv-gate uses on
 * the Z420, deliberately — two definitions of "open" that can drift apart is the
 * failure mode this file exists to prevent.
 *
 * ── IT FAILS CLOSED, AND "CLOSED" MEANS "IN HOURS" ────────────────────────────
 * The consequence of a wrong answer is asymmetric. Deciding "out of hours" when
 * the nursery is actually open sends an intruder alert about a member of staff
 * walking in, and — worse — treats footage from a session day as out-of-hours
 * footage. Deciding "in hours" when the building is actually empty loses an alert.
 * Losing an alert is recoverable; mislabelling in-hours footage is not. So every
 * uncertainty resolves to IN HOURS:
 *
 *   • the closure/bank-holiday lookup threw             → in hours (weekdays)
 *   • the open/close settings are missing or malformed  → in hours (weekdays, defaults)
 *   • anything else unexpected                          → in hours
 *
 * A weekend is the one case that stays out-of-hours under failure, because it does
 * not depend on any lookup: Saturday is Saturday whatever the database says.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const closures = require('./closures');

const TZ = 'Europe/London';
const DEFAULT_OPEN  = '07:30';
const DEFAULT_CLOSE = '18:30';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** London wall-clock parts for an instant. Containers run UTC, so this is the only honest way. */
function londonParts(d) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = {};
  for (const p of f) if (p.type !== 'literal') g[p.type] = p.value;
  return {
    weekday: g.weekday,                                    // 'Mon' … 'Sun'
    ymd: `${g.year}-${g.month}-${g.day}`,
    hour: parseInt(g.hour === '24' ? '0' : g.hour, 10),
    minute: parseInt(g.minute, 10),
  };
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const toMins = hhmm => {
  const m = HHMM.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const fromMins = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/**
 * The window in force, read from settings. Returns the defaults (and says so) when
 * a row is missing or malformed — it never returns a window nobody configured
 * without flagging that it did.
 */
async function window_(db) {
  let open = null, close = null, source = 'defaults';
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings
        WHERE key IN ('security_alerts_open_time','security_alerts_close_time')`);
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    open  = toMins(m.security_alerts_open_time);
    close = toMins(m.security_alerts_close_time);
    if (open != null && close != null) source = 'settings';
  } catch (e) {
    // A settings read that fails must not silently widen or narrow the window.
    source = 'defaults (settings unreadable)';
  }
  if (open == null || close == null || open >= close) {
    open  = toMins(DEFAULT_OPEN);
    close = toMins(DEFAULT_CLOSE);
    if (source === 'settings') source = 'defaults (setting was not a valid HH:MM window)';
  }
  return {
    open_time: fromMins(open), close_time: fromMins(close),
    open_mins: open, close_mins: close, source,
    days: 'Mon–Fri', timezone: TZ,
  };
}

/**
 * Is the building expected to be empty at `now`?
 *
 * @returns {Promise<{out_of_hours:boolean, reason:string, certain:boolean,
 *                    window:object, london:string, ymd:string, weekday:string,
 *                    closure:string|null}>}
 * `certain` is false when something had to be assumed. The caller decides what to
 * do with that; the alert gate refuses to send on anything but a certain yes.
 */
async function state(db, now = new Date()) {
  const p = londonParts(now);
  const win = await window_(db);
  const london = `${p.weekday} ${p.ymd} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  const base = { window: win, london, ymd: p.ymd, weekday: p.weekday, closure: null };

  // A weekend needs no lookup and cannot be got wrong.
  if (!WEEKDAYS.includes(p.weekday)) {
    return { ...base, out_of_hours: true, certain: true,
             reason: `${p.weekday} — the nursery is Mon–Fri, so the building should be empty.` };
  }

  // A weekday outside the window needs no lookup either.
  const mins = p.hour * 60 + p.minute;
  if (mins < win.open_mins || mins >= win.close_mins) {
    return { ...base, out_of_hours: true, certain: true,
             reason: `Weekday outside ${win.open_time}–${win.close_time} — the building should be empty.` };
  }

  // Inside the window on a weekday. The ONLY thing that can make this
  // out-of-hours is a closure, and a closure lookup we cannot trust must not be
  // allowed to declare the building empty.
  let closedLabel = null, lookupOk = true;
  try {
    const map = await closures.loadClosures(db, p.ymd, p.ymd);
    closedLabel = closures.closureLabel(map, p.ymd);
    // loadClosures swallows a missing table and returns an empty Map, which is
    // indistinguishable from "today is not a closure". Prove the statutory list is
    // actually readable before trusting an empty answer.
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM bank_holidays`);
    if (!rows.length || rows[0].n <= 0) lookupOk = false;
  } catch (e) {
    lookupOk = false;
  }

  if (closedLabel) {
    return { ...base, closure: closedLabel, out_of_hours: true, certain: lookupOk,
             reason: `${closedLabel} — the nursery is closed today, so the building should be empty.` };
  }
  if (!lookupOk) {
    return { ...base, out_of_hours: false, certain: false,
             reason: 'The bank-holiday and closure list could not be read, so Wren cannot tell whether '
                   + 'the nursery is open today. It is treating the building as OCCUPIED and will not '
                   + 'send an alert. This is the safe direction, not a measurement.' };
  }
  return { ...base, out_of_hours: false, certain: true,
           reason: `Weekday inside ${win.open_time}–${win.close_time} — the nursery is open.` };
}

/**
 * The next three days the nursery is closed, from `fromYmd` forward.
 * Weekends are not listed: they are not a closure, they are simply not a session day.
 */
async function nextClosures(db, fromYmd, howMany = 3) {
  const out = [];
  try {
    const start = fromYmd || londonParts(new Date()).ymd;
    const end = new Date(`${start}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 180);
    const map = await closures.loadClosures(db, start, end.toISOString().slice(0, 10));
    for (const [d, label] of [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (d < start) continue;
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      out.push({ date: d, label });
      if (out.length >= howMany) break;
    }
  } catch (e) { /* an unreadable list shows as "not known", never as "none" */ }
  return out;
}

module.exports = {
  TZ, DEFAULT_OPEN, DEFAULT_CLOSE,
  londonParts, window: window_, state, nextClosures,
};
