'use strict';
/**
 * b365 signal — there is empty space in a room over the next three months, and
 * this is what it is worth.
 *
 * Toby: "Notify us and create guides/summaries if Wren spots an issue or
 * opportunity — empty space, cheaper supplier, way to save money etc."
 *
 * THE QUESTION
 *   For each room, on the 15th of each of the next `months_ahead` months: how
 *   many children will be on roll, how many places does the room have, and what
 *   is a spare place worth per month?
 *
 * ── CHILDREN ARE PLACED BY AGE, NOT BY children.room_id ─────────────────────
 * Measured on wren_dev 2026-09-29: only 41 of 89 children on roll carry a
 * room_id at all, and 6 of 4,270 invoices do. A forecast built on room_id would
 * silently be a forecast about half the nursery. Age at the forecast date is
 * what the public availability heat-map uses (src/routes/public-availability.js)
 * and what the admissions engine uses, so it is what this uses — otherwise the
 * notification would disagree with the screen it tells you to go and look at.
 *
 * ── WHAT A PLACE IS WORTH ───────────────────────────────────────────────────
 * The average NET monthly invoice for a child of that age band over the last
 * three complete months. Where a band has no invoices, places are reported and
 * the money is reported as NOT CALCULABLE. An empty room with a made-up price
 * on it is worse than an empty room.
 *
 *
 * ── WHERE THE THRESHOLDS COME FROM ──────────────────────────────────────────
 * `defaults` below is the fallback. The live value is the SETTING, read through
 * ctx.setting(), so Toby can move it from the Settings screen without a deploy.
 * That also means the Roost "what would this say if…" preview and the test
 * harness change a threshold by overriding the SETTING (runner.makeSettingReader
 * takes overrides), not by passing cfg — cfg loses to a setting that exists, and
 * that precedence is deliberate: the stored value is what the nursery is running on.
 * ── WHY IT IS QUIET ─────────────────────────────────────────────────────────
 * A nursery is not full and is not meant to be. It speaks only when a room has
 * at least `min_places` spare against its TARGET capacity — the number the
 * setting plans to run at — not against the legal maximum.
 */

const U = require('./_util');

module.exports = {
  key: 'empty_space',
  label: 'Empty space in a room, and what it is worth',
  question: 'Which rooms have spare places against target over the next N months, and what is the monthly revenue at stake?',
  category: 'signal_empty_space',
  priority: 45,
  recipients: 'all-managers',
  link: '/occupancy-v2.html',
  defaults: {
    months_ahead: 3,
    min_places: 2,          // overridden by settings.finance_empty_space_min_places
    min_value_pence: 50000, // £500 a month before it is worth a notification
    cooldown_hours: 24 * 14,
    min_gap_hours: 24 * 7,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;
    const minPlaces = parseInt(
      await ctx.setting('finance_empty_space_min_places', String(cfg.min_places)), 10) || cfg.min_places;
    const schoolMonths = parseInt(await ctx.setting('school_start_age_months', '60'), 10) || 60;

    const { rows: rooms } = await db.query(
      `SELECT id, name, capacity, COALESCE(target_capacity, capacity) AS target,
              min_age_months, max_age_months
         FROM rooms
        WHERE capacity IS NOT NULL AND capacity > 0
        ORDER BY min_age_months NULLS FIRST, id`);
    if (!rooms.length) return { dormant: true, reason: 'no rooms with a capacity are configured' };

    // The 15th of each month ahead — mid-month, so a child joining or leaving at
    // either end is counted where they actually spend the month.
    const t = U.parts(today);
    const dates = [];
    for (let i = 1; i <= Math.max(1, cfg.months_ahead); i++) {
      let y = t.y, m = t.m + i;
      while (m > 12) { m -= 12; y += 1; }
      dates.push({ y, m, date: U.dayOfMonth(y, m, 15), label: U.monthLabel(y, m) });
    }

    // What a place in each age band earns, from the last three COMPLETE months.
    // Drafts and credit notes are excluded: a bill nobody has seen is not a price.
    const { rows: fees } = await db.query(
      `SELECT r.id AS room_id,
              ROUND(AVG(per.net_pence))::bigint AS avg_net_pence,
              count(*)::int                     AS months_of_children
         FROM rooms r
         JOIN LATERAL (
           SELECT i.id,
                  i.amount_pence AS net_pence,
                  (EXTRACT(YEAR FROM age(i.issued_on, c.date_of_birth)) * 12
                 + EXTRACT(MONTH FROM age(i.issued_on, c.date_of_birth)))::int AS age_m
             FROM invoices i
             JOIN children c ON c.id = i.child_id
            WHERE i.credit_note_for_id IS NULL
              AND COALESCE(i.status,'') NOT IN ('draft','void','cancelled')
              AND i.amount_pence > 0
              AND c.date_of_birth IS NOT NULL
              AND COALESCE(c.is_demo, false) = false
              AND i.issued_on >= ($1::date - interval '4 months')
              AND i.issued_on <  date_trunc('month', $1::date)
         ) per ON per.age_m >= COALESCE(r.min_age_months, 0)
              AND per.age_m <  COALESCE(r.max_age_months, 999)
        GROUP BY r.id`, [today]);
    const feeByRoom = new Map(fees.map(f => [f.room_id, { pence: Number(f.avg_net_pence), n: f.months_of_children }]));

    const findings = [];
    for (const room of rooms) {
      for (const d of dates) {
        const { rows: [row] } = await db.query(
          `SELECT count(*)::int AS on_roll
             FROM children c
            WHERE COALESCE(c.is_active, true) = true
              AND COALESCE(c.is_demo, false) = false
              AND c.erased_at IS NULL
              AND c.date_of_birth IS NOT NULL
              AND (c.start_date IS NULL OR c.start_date <= $1::date)
              AND (c.leave_date IS NULL OR c.leave_date >= $1::date)
              AND (EXTRACT(YEAR FROM age($1::date, c.date_of_birth)) * 12
                 + EXTRACT(MONTH FROM age($1::date, c.date_of_birth)))::int
                  BETWEEN COALESCE($2::int, 0) AND LEAST(COALESCE($3::int, 999), $4::int) - 1`,
          [d.date, room.min_age_months, room.max_age_months, schoolMonths]);

        const onRoll = row.on_roll;
        const spare = Number(room.target) - onRoll;
        if (spare < minPlaces) continue;
        const fee = feeByRoom.get(room.id) || null;
        findings.push({
          room_id: room.id, room: room.name, month: `${d.y}-${String(d.m).padStart(2, '0')}`,
          month_label: d.label, as_at: d.date,
          on_roll: onRoll, target: Number(room.target), capacity: Number(room.capacity),
          spare_places: spare,
          value_per_place_pence: fee ? fee.pence : null,
          value_pence: fee ? spare * fee.pence : null,
        });
      }
    }
    if (!findings.length) return null;

    // The biggest single opportunity leads; the rest are the evidence.
    findings.sort((a, b) => (b.value_pence || 0) - (a.value_pence || 0) || b.spare_places - a.spare_places);
    const top = findings[0];
    const valued = findings.filter(f => f.value_pence != null);
    if (valued.length && top.value_pence != null && top.value_pence < cfg.min_value_pence) return null;

    const money = p => `£${(p / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
    const worth = top.value_pence != null
      ? `That is about ${money(top.value_pence)} a month at the average fee for that age band `
        + `(${money(top.value_per_place_pence)} a place).`
      : 'Wren holds no recent invoices for that age band, so it cannot say what a place there is worth.';
    const others = findings.length - 1;

    return {
      fingerprint: U.fingerprint({
        rooms: findings.map(f => `${f.room_id}:${f.month}:${f.spare_places}`).sort(),
      }),
      headline: `${top.room} has ${top.spare_places} ${U.plural(top.spare_places, 'place')} spare in ${top.month_label} `
        + `— ${top.on_roll} children against a target of ${top.target}. ${worth}`
        + (others > 0 ? ` ${others} other room-month${others === 1 ? ' is' : 's are'} also below target.` : ''),
      facts: {
        months_ahead: cfg.months_ahead,
        min_places: minPlaces,
        placed_by: 'age at the forecast date, not children.room_id',
        total_value_pence: valued.reduce((s, f) => s + f.value_pence, 0) || null,
        rows: findings.slice(0, 12),
      },
    };
  },
};
