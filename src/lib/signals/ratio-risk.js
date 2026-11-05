'use strict';
/**
 * b311 signal — a day ahead where the booked children outnumber the staff who
 * will be there.
 *
 * THE QUESTION
 *   Between tomorrow and `horizon_days`, is there a working day on which the
 *   §55 booked register needs more ratio staff than the work patterns and
 *   approved leave leave available?
 *
 * The arithmetic is NOT redone here. src/services/ratio-engine.js is the one
 * definition of a ratio in Wren — the absence gatekeeper and the rota's slot
 * view both read it, and a second implementation would drift from them within a
 * term and then argue with them in front of a manager. This signal calls
 * checkDate() and reports what it says.
 *
 * That engine also carries the setting's own rules: the configured 1:4 for
 * two-year-olds rather than the statutory 1:5, and Q6's +1 spare for same-day
 * sickness. So "fails" here means "fails LADN's standard", which is the
 * standard the manager would be judged against anyway.
 *
 * The engine falls back to an attendance proxy when the booked register does
 * not cover a date. A prediction built on a proxy is a weaker claim, so the
 * headline says which source it used and the signal will not fire at all on
 * 'none'.
 *
 * ── THE DAY-OF-WEEK DISAGREEMENT (found 2026-09-10, NOT fixed here) ─────────
 * ladn.staff_work_patterns.day_of_week runs 0=Mon … 4=Fri. Three other modules
 * say so in as many words (src/lib/payroll-engine.js:53,
 * src/routes/occupancy.js:147, src/routes/occupancy-sandbox.js:26) and the
 * table proves it: on dev AND on prod it holds rows for 0–4 and none for 5 or
 * 6. ratio-engine.availableRatioStaff() passes JavaScript's getDay(), which is
 * 1=Mon … 5=Fri. So it reads Tuesday's patterns for a Monday and, on a Friday,
 * matches no row at all and reports zero staff available.
 *
 * That is a pre-existing bug in a shared file the absence gatekeeper and the
 * rota also depend on. Fixing it would change who gets leave approved, which is
 * not b311's to change on the way past — it is written up in
 * ladn-ready/logs/b311.NOTES.md instead.
 *
 * What this signal does about it: DETECT the disagreement rather than assume
 * it, and go dormant while it stands. A signal whose whole purpose is to be
 * trusted about staffing cannot raise an alarm off a figure it knows is being
 * read from the wrong column. It starts working again, by itself, on the day
 * either side is corrected — nothing here needs revisiting.
 */

const U = require('./_util');
const ratio = require('../../services/ratio-engine');

/**
 * Is the ratio engine reading the work-pattern table on the same convention it
 * was written with? True when the table carries a Saturday/Sunday row (so
 * getDay() semantics), or when it is empty (nothing to disagree about).
 */
async function conventionsAgree(db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE day_of_week IN (5, 6))::int AS weekend_rows,
            count(*) FILTER (WHERE day_of_week = 0)::int AS zero_rows
       FROM staff_work_patterns`);
  const r = rows[0];
  if (!r.total) return { agree: true, note: 'no work patterns recorded' };
  if (r.weekend_rows > 0) return { agree: true, note: 'work patterns use getDay() days' };
  if (r.zero_rows > 0) {
    return {
      agree: false,
      note: 'ladn.staff_work_patterns uses 0=Mon…4=Fri but the ratio engine looks it up with '
          + 'JavaScript getDay() (1=Mon…5=Fri), so it reads the wrong day and finds nobody at all on a Friday',
    };
  }
  return { agree: true, note: 'inconclusive — treated as agreeing' };
}

module.exports = {
  conventionsAgree,
  key: 'ratio_risk',
  label: 'A day ahead where ratios do not work',
  question: 'Is there a working day in the next N where booked children exceed available ratio staff?',
  category: 'signal_ratio_risk',
  priority: 5,               // the most operational of the nine — it wins the cap
  recipients: 'all-managers',
  link: '/admin/rota',
  defaults: {
    horizon_days: 14,
    skip_today: true,        // today is the rota's problem, not a prediction
    cooldown_hours: 24,
    min_gap_hours: 6,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;

    const conv = await conventionsAgree(db);
    if (!conv.agree) return { dormant: true, reason: conv.note };

    const failing = [];
    let checked = 0;
    let sawBookings = false;

    for (let i = cfg.skip_today ? 1 : 0; i <= cfg.horizon_days; i++) {
      const date = U.addDays(today, i);
      const d = U.dow(date);
      if (d === 0 || d === 6) continue;               // the nursery is shut
      let res;
      try {
        res = await ratio.checkDate(db, date, null);
      } catch (e) {
        // One bad date must not take the whole sweep down.
        continue;
      }
      checked++;
      if (res.booked && res.booked.source === 'bookings') sawBookings = true;
      if (!res.pass && res.booked && res.booked.total > 0) {
        failing.push({
          date,
          booked: res.booked.total,
          required: res.required,
          need: res.need,
          available: res.available,
          source: res.booked.source,
        });
      }
    }

    if (!checked) return { dormant: true, reason: 'no working days in the horizon' };
    if (!failing.length) return null;
    // An attendance-proxy-only answer is a guess about who is booked. Say
    // nothing rather than raise an alarm from a guess.
    if (!sawBookings && failing.every(f => f.source !== 'bookings')) {
      return { dormant: true, reason: 'no booked register covers these dates — the ratio engine is on its attendance proxy, which is too weak to raise an alarm from' };
    }

    const worst = failing.reduce((a, b) => (b.need - b.available > a.need - a.available ? b : a));
    const first = failing[0];
    const n = failing.length;

    return {
      fingerprint: U.fingerprint({ dates: failing.map(f => f.date) }),
      headline: `${n} working ${U.plural(n, 'day', 'days')} in the next ${cfg.horizon_days} ${U.plural(n, 'does', 'do')} not work on ratios. `
        + `The first is ${U.longDate(first.date)}: ${first.booked} children booked needs ${first.need} ratio staff including the spare, and ${first.available} are available.`,
      facts: { failing_days: n, horizon_days: cfg.horizon_days, checked_days: checked,
               first: first, worst: worst, dates: failing.map(f => f.date),
               source: first.source },
    };
  },
};
