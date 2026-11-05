'use strict';
/* ===========================================================================
 * lateness.js — b309 (2026-09-10)
 *
 * Lateness: the gap between the time somebody was due to start and the time they
 * actually clocked in. Pure — hand it two lists and it hands back occurrences.
 * src/routes/lateness.js does the SQL.
 *
 * WHERE THE NUMBERS COME FROM, AND WHERE THEY DO NOT
 * There is exactly ONE source of "actually arrived": ladn.staff_clock_events.
 * That table holds 1 row today and will hold 1 row until b310 makes clock-in
 * real (QR or PIN board). The parity report is explicit about this and so is the
 * brief: build the reporting, let it read zero rows, do NOT invent a second
 * source. So there is no inference from a rota being marked "worked", no
 * door-entry proxy, and no manual "mark as late" that writes a fake clock event.
 * An empty report is the honest answer to "who was late last week" while nobody
 * is clocking in, and the route says so in as many words.
 *
 * "Due to start" is a different question and does have a real answer today: the
 * rota. In order of authority —
 *   1. ladn.rota_shifts.planned_start for that person on that date (the published
 *      rota; 124 rows on dev).
 *   2. their contracted work pattern for that weekday.
 * If neither knows, the arrival is not judged at all. Being unable to say when
 * someone was due is not evidence that they were on time, and it is certainly not
 * evidence that they were late — such a day is reported as `unscheduled`, counted
 * separately, and never folded into a lateness total.
 *
 * GRACE
 * A grace period (settings.lateness_grace_minutes, default 5) is subtracted
 * before anything is called late. Minutes late are reported from the SCHEDULED
 * time, not from the end of grace — a report that quietly shaved five minutes off
 * every figure would be lying in the employer's favour.
 * ===========================================================================*/

/** 'HH:MM[:SS]' → minutes past midnight. Null for anything unparseable. */
function toMinutes(t) {
  if (t == null) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** minutes past midnight → 'HH:MM' */
function toHHMM(mins) {
  if (mins == null) return null;
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Match arrivals to schedules and decide who was late.
 *
 * @param {object} o
 * @param {Array}  o.arrivals   [{staff_id, date:'YYYY-MM-DD', time:'HH:MM', method}]
 *                              the FIRST clock_in of each person on each date
 * @param {Array}  o.scheduled  [{staff_id, date:'YYYY-MM-DD', start:'HH:MM', source}]
 * @param {number} [o.graceMinutes=5]
 * @param {Set|Array} [o.closedDates] dates the setting was shut — never judged
 * @returns {{occurrences:Array, unscheduled:Array, onTime:number, byStaff:Array, totals:object}}
 */
function analyse(o = {}) {
  const grace = Number.isFinite(Number(o.graceMinutes)) ? Math.max(0, Number(o.graceMinutes)) : 5;
  const closed = o.closedDates instanceof Set ? o.closedDates : new Set(o.closedDates || []);

  const schedIdx = new Map();
  for (const s of (o.scheduled || [])) {
    const start = toMinutes(s.start);
    if (start == null) continue;
    const key = `${s.staff_id}|${s.date}`;
    // The rota wins over the pattern; the caller passes rota rows first.
    if (!schedIdx.has(key)) schedIdx.set(key, { start, source: s.source || 'rota' });
  }

  const occurrences = [], unscheduled = [];
  let onTime = 0;
  const byStaff = new Map();
  const bump = (staffId, field, by = 1) => {
    if (!byStaff.has(staffId)) {
      byStaff.set(staffId, { staff_id: staffId, occurrences: 0, total_minutes: 0, worst_minutes: 0, on_time: 0, unscheduled: 0 });
    }
    const r = byStaff.get(staffId);
    r[field] += by;
    return r;
  };

  for (const a of (o.arrivals || [])) {
    if (closed.has(a.date)) continue;                 // the setting was shut
    const arrived = toMinutes(a.time);
    if (arrived == null) continue;
    const sched = schedIdx.get(`${a.staff_id}|${a.date}`);
    if (!sched) {
      unscheduled.push({ staff_id: a.staff_id, date: a.date, arrived_at: toHHMM(arrived), method: a.method || null });
      bump(a.staff_id, 'unscheduled');
      continue;
    }
    const minutesLate = arrived - sched.start;
    if (minutesLate > grace) {
      occurrences.push({
        staff_id: a.staff_id,
        date: a.date,
        scheduled_start: toHHMM(sched.start),
        arrived_at: toHHMM(arrived),
        minutes_late: minutesLate,          // from the scheduled time, not from the end of grace
        beyond_grace: minutesLate - grace,
        schedule_source: sched.source,
        method: a.method || null,
      });
      const r = bump(a.staff_id, 'occurrences');
      r.total_minutes += minutesLate;
      if (minutesLate > r.worst_minutes) r.worst_minutes = minutesLate;
    } else {
      onTime++;
      bump(a.staff_id, 'on_time');
    }
  }

  occurrences.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : y.minutes_late - x.minutes_late));

  const totals = {
    arrivals: (o.arrivals || []).length,
    judged: occurrences.length + onTime,
    late_occurrences: occurrences.length,
    on_time: onTime,
    unscheduled: unscheduled.length,
    total_minutes_late: occurrences.reduce((a, x) => a + x.minutes_late, 0),
    grace_minutes: grace,
  };
  totals.late_rate = totals.judged ? Math.round((occurrences.length / totals.judged) * 1000) / 10 : null;

  return {
    occurrences,
    unscheduled,
    onTime,
    byStaff: [...byStaff.values()].sort((a, b) => b.total_minutes - a.total_minutes),
    totals,
  };
}

module.exports = { analyse, toMinutes, toHHMM };
