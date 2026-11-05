'use strict';
/**
 * picker.js — b504 (My list, Part A3).
 *
 * Chooses the (at most) three "Do now" jobs for a day, and keeps the lanes
 * (now / next / later) honest as dates arrive. The scoring is pure and stated:
 * every pick carries a one-sentence `reason` built from the same facts, so the
 * screen never says "because" about something the code did not weigh.
 *
 * Rules kept from the brief and DESIGN.md:
 *   - nothing is ever deleted; this file only sets lane / picked_for / picked_by /
 *     carried_days / plan_due on rows;
 *   - Toby's own picks (picked_by = 'toby') are never overwritten for the day;
 *   - the pick is idempotent: calling it twice on one day changes nothing;
 *   - a LATER item moves up on its own date (plan_due <= today), not before;
 *   - two dates on every job: due_date = REAL deadline, plan_due = YOUR date.
 */

const H = require('../../lib/uk-bank-holidays');

const DO_NOW_MAX = 3;
const NEXT_MAX = 7;          // Toby, 17 Oct: "NEXT (<=7)" — the brief said 5; his ask wins
const STARTER_MINS = 15;
const BIG_MINS = 60;

// Rows from these sources are "jobs" even when the kind column is still NULL (rows
// inserted by the older UPSERT list no columns of ours). Used in SQL and in JS.
const JOB_SOURCES = ['manual', 'session', 'kanban', 'tasks', 'launch-list'];
const KIND_SQL = `COALESCE(kind, CASE WHEN source IN ('${JOB_SOURCES.join("','")}') THEN 'job' ELSE 'ops' END)`;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── helpers ──────────────────────────────────────────────────────────────────
function ymd(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    // pg returns DATE as local midnight; read local getters (see signals/_util.js).
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

/** 'Fri 23 Oct' */
function dayLabel(s) {
  const d = ymd(s); if (!d) return '';
  const w = H.dow(d);
  const [, m, dd] = d.split('-').map(Number);
  return `${DOW[w]} ${dd} ${MON[m - 1]}`;
}

/** 'today' | 'tomorrow' | 'Fri 23 Oct' | 'passed Fri 16 Oct' */
function relLabel(s, asOf) {
  const d = ymd(s); if (!d) return '';
  const n = H.daysBetween(asOf, d);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 0) return `passed ${dayLabel(d)}`;
  return dayLabel(d);
}

// ── buffers ──────────────────────────────────────────────────────────────────
/** Working days between "your date" and the real deadline. */
function bufferDays(item) {
  const tags = item.tags || [];
  const est = Number(item.effort_minutes) || 0;
  const money = tags.includes('money') || tags.includes('statutory') || ['finance', 'compliance'].includes(item.category);
  let base;
  if (item.kind === 'waiting' || tags.includes('chase')) base = 5;
  else if (money) base = est > 120 ? 5 : 3;
  else if (item.kind === 'decision') base = 3;
  else base = 2;
  if (est > 120 && !money) base += Math.ceil((est - 120) / 120);   // +1 per extra 120 min
  return Math.min(base, 5);
}

/**
 * The default "your date" for a job with a real deadline.
 * Floors: never before tomorrow unless the real date is today/tomorrow; never in
 * the past; never after the real date. No real date -> the next working day.
 */
function defaultPlanDue(item, asOf) {
  const real = ymd(item.due_date);
  const tomorrow = H.addDays(asOf, 1);
  if (!real) return H.nextWorkingDay(asOf);
  if (H.daysBetween(asOf, real) <= 1) {                       // today, tomorrow, or already past
    const p = H.addWorkingDays(real, -bufferDays(item));
    return p < asOf ? asOf : (p > real ? real : p);
  }
  let p = H.addWorkingDays(real, -bufferDays(item));
  if (p < tomorrow) p = H.onOrAfterWorkingDay(tomorrow);
  return p > real ? real : p;
}

// ── score ────────────────────────────────────────────────────────────────────
/** Higher first. Returns {score, reason}. Pure: no I/O. */
function score(item, ctx) {
  const asOf = ctx.asOf;
  const real = ymd(item.due_date), plan = ymd(item.plan_due);
  let s = 0;
  if (real && H.daysBetween(asOf, real) <= 1) s += 100;
  if (plan && plan <= asOf) s += 60;
  if (ctx.launchMode && (item.tags || []).includes('launch')) s += 40;
  if (item.rag === 'red' && item.blocked_on === 'toby') s += 30;
  const first = ymd(item.first_seen);
  if (first) s += Math.max(0, Math.min(20, H.daysBetween(first, asOf)));
  const est = item.effort_minutes == null ? null : Number(item.effort_minutes);
  if (est != null && est <= STARTER_MINS) s += 15;
  return { score: s, reason: reasonFor(item, asOf) };
}

function reasonFor(item, asOf) {
  const real = ymd(item.due_date), plan = ymd(item.plan_due);
  const bits = [];
  if (real) {
    const n = H.daysBetween(asOf, real);
    bits.push(n < 0 ? `Real deadline ${relLabel(real, asOf)}` : n === 0 ? 'Real deadline today' : n === 1 ? 'Real deadline tomorrow' : `Real deadline ${dayLabel(real)}`);
  } else if (plan) {
    bits.push(plan <= asOf ? 'Your date is today' : `Your date ${dayLabel(plan)}`);
  }
  if (item.effort_minutes) bits.push(`${item.effort_minutes} min`);
  if (!bits.length) bits.push('On your list');
  if ((item.carried_days || 0) >= 2) bits.push(`carried ${item.carried_days} days`);
  return bits.join('; ') + '.';
}

// ── selection (pure) ─────────────────────────────────────────────────────────
/**
 * Choose up to `slots` new picks from `ranked` (already sorted by score desc).
 * `already` = items already picked today (they count for the "one big" rule and
 * the starter rule). Returns the chosen items in rank order.
 */
function choose(ranked, slots, already) {
  const chosen = [];
  let big = already.filter(i => Number(i.effort_minutes) > BIG_MINS).length;
  // At most one Wren-found ops item in Do now: red findings must not crowd out Toby's own jobs.
  let ops = already.filter(i => i.kind === 'ops').length;
  for (const it of ranked) {
    if (chosen.length >= slots) break;
    const isBig = Number(it.effort_minutes) > BIG_MINS;
    if (isBig && big >= 1) continue;
    if (it.kind === 'ops' && ops >= 1) continue;
    chosen.push(it);
    if (isBig) big++;
    if (it.kind === 'ops') ops++;
  }
  const isStarter = i => i.effort_minutes != null && Number(i.effort_minutes) <= STARTER_MINS;
  if (slots > 0 && !already.some(isStarter) && !chosen.some(isStarter)) {
    const starter = ranked.find(i => isStarter(i) && !chosen.includes(i));
    if (starter) {
      if (chosen.length < slots) chosen.push(starter);
      else if (chosen.length) chosen[chosen.length - 1] = starter;   // replace the weakest new pick
    }
  }
  return chosen;
}

// ── DB side ──────────────────────────────────────────────────────────────────
const CAND_COLS = `id, source, source_key, title, why, rag, category, due_date::text AS due_date, plan_due::text AS plan_due,
  blocked_on, effort_minutes, tags, lane, picked_for::text AS picked_for, picked_by, carried_days, stage,
  first_seen, owner_staff_id, ${KIND_SQL} AS kind, resolved_at, snoozed_until, parked_at`;

const OPEN_SQL = `resolved_at IS NULL AND dropped_at IS NULL AND parked_at IS NULL
  AND (snoozed_until IS NULL OR snoozed_until <= now())
  AND NOT ('confirm-close' = ANY(tags))`;

/**
 * Lazily called by GET /mylist. Idempotent. Returns {picked: [ids newly picked], promoted: n}.
 */
async function pickToday(db, asOf, opts = {}) {
  const staffId = opts.staffId || 1;
  const launchMode = !!opts.launchMode;
  const out = { picked: [], promoted: 0, demoted: 0 };

  // 1. yesterday's unfinished picks go back into the pool (the wrap counted them as carried).
  const dem = await db.query(
    `UPDATE attention_items SET lane = 'next'
      WHERE lane = 'now' AND resolved_at IS NULL AND picked_for IS NOT NULL AND picked_for < $1::date
        AND (owner_staff_id = $2 OR owner_staff_id IS NULL)`, [asOf, staffId]);
  out.demoted = dem.rowCount;

  // 2. lanes by date. New rows (lane NULL) get next/later; LATER moves up on its day.
  const p1 = await db.query(
    `UPDATE attention_items SET lane = CASE
         WHEN COALESCE(plan_due, due_date) IS NOT NULL AND COALESCE(plan_due, due_date) <= $1::date + 7 THEN 'next' ELSE 'later' END
      WHERE lane IS NULL AND ${KIND_SQL} IN ('job','decision','waiting')
        AND ${OPEN_SQL}`, [asOf]);
  const p2 = await db.query(
    `UPDATE attention_items SET lane = 'next'
      WHERE lane = 'later' AND COALESCE(picked_by,'') <> 'toby'
        AND (first_seen AT TIME ZONE 'Europe/London')::date < $1::date   -- a row keeps the lane it was filed in until tomorrow
        AND ${KIND_SQL} IN ('job','decision','waiting') AND ${OPEN_SQL}
        AND ((plan_due IS NOT NULL AND plan_due <= $1::date) OR (due_date IS NOT NULL AND due_date <= $1::date + 2))`, [asOf]);
  out.promoted = p1.rowCount + p2.rowCount;

  // 3. today's slots.
  const { rows: todays } = await db.query(
    `SELECT ${CAND_COLS} FROM attention_items
      WHERE picked_for = $1::date AND dropped_at IS NULL AND (owner_staff_id = $2 OR owner_staff_id IS NULL)
        AND (resolved_at IS NULL OR resolved_at >= $1::date)`, [asOf, staffId]);
  const slots = DO_NOW_MAX - todays.length;
  if (slots <= 0) return out;

  // 4. the pool: Toby's own open jobs/decisions in now/next, plus red-and-blocked-on-Toby ops due within 7 days.
  const { rows: pool } = await db.query(
    `SELECT ${CAND_COLS} FROM attention_items
      WHERE ${OPEN_SQL}
        AND (picked_for IS NULL OR picked_for < $1::date)
        AND (
          (owner_staff_id = $2 AND ${KIND_SQL} IN ('job','decision') AND lane IN ('now','next')
             AND COALESCE(blocked_on,'toby') = 'toby')
          OR (${KIND_SQL} = 'ops' AND $2 = 1 AND rag = 'red' AND blocked_on = 'toby'
             AND due_date IS NOT NULL AND due_date <= $1::date + 7)
        )`, [asOf, staffId]);

  const ranked = pool
    .map(it => Object.assign({}, it, score(it, { asOf, launchMode })))
    .sort((a, b) => b.score - a.score || (a.id - b.id));
  const chosen = choose(ranked, slots, todays);
  if (chosen.length) {
    await db.query(
      `UPDATE attention_items SET lane = 'now', picked_for = $2::date, picked_by = 'auto'
        WHERE id = ANY($1::int[])`, [chosen.map(c => c.id), asOf]);
    out.picked = chosen.map(c => c.id);
  }
  return out;
}

/**
 * The wrap. Undone picks carry (+1); at 2 they are "stuck". Records plan hit/miss
 * for items resolved today. Idempotent per day via mylist_days.wrapped_at.
 */
async function rollOver(db, asOf, staffId = 1) {
  const { rows: [d] } = await db.query(
    `SELECT wrapped_at FROM mylist_days WHERE staff_id = $1 AND day = $2::date`, [staffId, asOf]);
  if (d && d.wrapped_at) return { already: true };

  const { rows: undone } = await db.query(
    `UPDATE attention_items SET carried_days = carried_days + 1
      WHERE picked_for = $1::date AND resolved_at IS NULL AND dropped_at IS NULL AND (owner_staff_id = $2 OR owner_staff_id IS NULL)
      RETURNING id, carried_days`, [asOf, staffId]);
  const { rows: done } = await db.query(
    `SELECT id, plan_due::text AS plan_due, resolved_at::date::text AS rd FROM attention_items
      WHERE picked_for = $1::date AND resolved_at IS NOT NULL AND dropped_at IS NULL AND (owner_staff_id = $2 OR owner_staff_id IS NULL)`, [asOf, staffId]);
  const { rows: resolvedToday } = await db.query(
    `SELECT plan_due::text AS plan_due, (resolved_at AT TIME ZONE 'Europe/London')::date::text AS rd FROM attention_items
      WHERE resolved_at >= $1::date AND resolved_at < $1::date + 1 AND plan_due IS NOT NULL AND resolved_by = $2`, [asOf, staffId]);
  const hit = resolvedToday.filter(r => r.rd <= r.plan_due).length;
  const miss = resolvedToday.length - hit;
  const picks = [...undone.map(r => r.id), ...done.map(r => r.id)];
  await db.query(
    `INSERT INTO mylist_days (staff_id, day, picks, done, carried, plan_hit, plan_missed, wrapped_at)
     VALUES ($1, $2::date, $3::int[], $4, $5, $6, $7, now())
     ON CONFLICT (staff_id, day) DO UPDATE SET picks = EXCLUDED.picks, done = EXCLUDED.done,
       carried = EXCLUDED.carried, plan_hit = EXCLUDED.plan_hit, plan_missed = EXCLUDED.plan_missed, wrapped_at = now()`,
    [staffId, asOf, picks, done.length, undone.length, hit, miss]);
  return { already: false, carried: undone.map(r => r.id), stuck: undone.filter(r => r.carried_days >= 2).map(r => r.id), done: done.length, plan_hit: hit, plan_missed: miss };
}

module.exports = {
  DO_NOW_MAX, NEXT_MAX, STARTER_MINS, BIG_MINS, JOB_SOURCES, KIND_SQL, OPEN_SQL, CAND_COLS,
  ymd, dayLabel, relLabel, bufferDays, defaultPlanDue, score, reasonFor, choose, pickToday, rollOver,
};
