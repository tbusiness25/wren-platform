'use strict';
/* ===========================================================================
 * clock-pairing.js — b310 (2026-09-10)
 *
 * Turn a day's raw taps into worked time. Pure: hand it a list of events, it
 * hands back pairs, worked minutes, breaks and anomalies. No DB, no clock, no
 * timezone maths — src/routes/clockin.js does all of that and passes epoch
 * milliseconds in.
 *
 * WHY PAIRS AND NOT first-in-minus-last-out
 * A second out/in pair on the same day is LUNCH, not a second shift. Somebody who
 * taps out at 12:30 and back in at 13:15 has worked the day minus 45 minutes, and
 * a timesheet that says otherwise is one Toby pays for. So worked time is the SUM
 * OF THE PAIRS and the gaps between pairs are breaks. There is no cap, no assumed
 * 30-minute deduction and no "if the day is longer than 6 hours take an hour off":
 * a deduction nobody tapped is a deduction nobody can defend.
 *
 * WHAT HAPPENS TO A RUN OF THE SAME DIRECTION
 * The gate is an 'in' reader. Tap it, walk in; walk back out to the bins through
 * the emergency exit; tap the gate again to get back in. That is two consecutive
 * 'in' events with no 'out' between them, and it is normal, not an error.
 *
 * The rule, applied IDENTICALLY in both directions: a run of consecutive
 * same-direction events collapses to its FIRST event. The first tap is the moment
 * the person presented at the reader for that transition; later taps in the run
 * are re-presentations (the door did not open, they came back through). Taking
 * the first in both directions means the rule cannot systematically favour the
 * employer or the employee — which "first in, last out" would, and by a lot.
 * Every collapsed run is still reported as an anomaly, because a day with four
 * gate taps and no office tap is a day a manager should look at.
 *
 * WHAT IS NEVER INVENTED
 * A trailing 'in' with no 'out' does NOT get an assumed leaving time. It ends the
 * day `open`, and the caller raises a question for the person to answer. Same for
 * a leading 'out' with no 'in'. An unanswerable day contributes 0 worked minutes
 * and says so; it never contributes a guess.
 * ===========================================================================*/

/** ms → whole minutes, rounded to nearest. */
const mins = ms => Math.round(ms / 60000);

/**
 * @param {Array} events  [{ id, type:'clock_in'|'clock_out', at:<epoch ms>, source, device_id }]
 *                        Order does not matter; they are sorted here.
 * @param {object} [opt]
 * @param {number} [opt.repeatTapSeconds=180]  two same-direction taps closer than
 *        this are one tap, not an anomaly — a re-presented fob at the same reader.
 * @returns {{
 *   pairs: Array, open: object|null, orphanOut: object|null,
 *   workedMinutes: number, breakMinutes: number, spanMinutes: number|null,
 *   firstIn: object|null, lastOut: object|null,
 *   anomalies: Array, used: Array, complete: boolean
 * }}
 */
function pairDay(events, opt = {}) {
  const repeatMs = Math.max(0, Number(opt.repeatTapSeconds ?? 180)) * 1000;

  const sorted = (events || [])
    .filter(e => e && (e.type === 'clock_in' || e.type === 'clock_out') && Number.isFinite(Number(e.at)))
    .map(e => ({ ...e, at: Number(e.at) }))
    .sort((a, b) => a.at - b.at || (a.id || 0) - (b.id || 0));

  const anomalies = [];

  // ── Collapse runs of the same direction to their first event ──────────────
  const used = [];
  for (const e of sorted) {
    const prev = used[used.length - 1];
    if (prev && prev.type === e.type) {
      const gap = e.at - prev.at;
      if (gap <= repeatMs) {
        anomalies.push({ kind: 'repeat_tap', type: e.type, at: e.at, ignored_event_id: e.id, seconds: Math.round(gap / 1000) });
      } else {
        anomalies.push({ kind: 'consecutive_same_direction', type: e.type, at: e.at, ignored_event_id: e.id, kept_event_id: prev.id, minutes: mins(gap) });
      }
      continue;   // keep the FIRST of the run
    }
    used.push(e);
  }

  // ── An 'out' with nothing before it: they were in and nobody recorded it ──
  let orphanOut = null;
  if (used.length && used[0].type === 'clock_out') {
    orphanOut = used.shift();
    anomalies.push({ kind: 'out_without_in', at: orphanOut.at, event_id: orphanOut.id });
  }

  // ── Pair them off ─────────────────────────────────────────────────────────
  const pairs = [];
  let open = null;
  for (const e of used) {
    if (e.type === 'clock_in') { open = e; continue; }
    if (!open) continue;                        // cannot happen after the collapse, belt and braces
    pairs.push({
      in_event_id: open.id ?? null,
      out_event_id: e.id ?? null,
      in_at: open.at,
      out_at: e.at,
      minutes: mins(e.at - open.at),
      in_source: open.source ?? null,
      out_source: e.source ?? null,
      in_device: open.device_id ?? null,
      out_device: e.device_id ?? null,
    });
    open = null;
  }
  if (open) anomalies.push({ kind: 'in_without_out', at: open.at, event_id: open.id });

  const workedMinutes = pairs.reduce((a, p) => a + p.minutes, 0);

  // Breaks are the gaps BETWEEN pairs — the lunch, and any other time off site
  // that somebody actually tapped for. Time after the final tap-out is not a break.
  let breakMinutes = 0;
  const breaks = [];
  for (let i = 1; i < pairs.length; i++) {
    const b = mins(pairs[i].in_at - pairs[i - 1].out_at);
    breaks.push({ from: pairs[i - 1].out_at, to: pairs[i].in_at, minutes: b });
    breakMinutes += b;
  }

  const firstIn = pairs.length ? { id: pairs[0].in_event_id, at: pairs[0].in_at } : (open ? { id: open.id, at: open.at } : null);
  const lastOut = pairs.length ? { id: pairs[pairs.length - 1].out_event_id, at: pairs[pairs.length - 1].out_at } : null;
  const spanMinutes = (firstIn && lastOut && lastOut.at >= firstIn.at) ? mins(lastOut.at - firstIn.at) : null;

  return {
    pairs, breaks, open, orphanOut,
    workedMinutes, breakMinutes, spanMinutes,
    firstIn, lastOut,
    anomalies, used,
    complete: !open && !orphanOut && pairs.length > 0,
  };
}

/**
 * Group a flat list of events into days, then pair each.
 * @param {Array} events  each with a `date` ('YYYY-MM-DD', already in Europe/London)
 * @returns {Map<string, ReturnType<pairDay>>}
 */
function pairDays(events, opt = {}) {
  const byDate = new Map();
  for (const e of (events || [])) {
    if (!e || !e.date) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const out = new Map();
  for (const [date, list] of byDate) out.set(date, pairDay(list, opt));
  return out;
}

/** '4h 25m' — for screens, never for arithmetic. */
function fmtMinutes(m) {
  if (m == null || !Number.isFinite(Number(m))) return '—';
  const n = Math.max(0, Math.round(Number(m)));
  const h = Math.floor(n / 60), r = n % 60;
  return h ? `${h}h ${r}m` : `${r}m`;
}

module.exports = { pairDay, pairDays, fmtMinutes };
