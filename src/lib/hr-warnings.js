'use strict';
/* ===========================================================================
 * hr-warnings.js — b366 (2026-09-29)
 *
 * Toby: "Absence warnings on Wren (auto send out Bradford factor verbal
 * warning) — so when staff reach certain targets (allow us to set these in
 * settings) they get a notification message in HR and we get told. Then the
 * same with when it's written, and so on. Same with things like minor issues."
 *
 * WHAT THIS DOES AND WHAT IT REFUSES TO DO
 * It computes a score per person, compares it to thresholds Toby set, and when
 * somebody crosses one it DRAFTS a letter and tells the manager. That is the
 * whole of it. It does not send the letter, it does not record an outcome, and
 * it does not tell the staff member anything.
 *
 * The auto-send switch Toby asked for exists — per stage, in the settings row —
 * and it ships OFF, because:
 *   • A formal warning is a step in a process, not a message. The ACAS Code
 *     wants an investigation, a written invitation, a meeting at which the
 *     person can respond and be accompanied, and only then a decision (Code of
 *     Practice 1, paras 5–27). A cron job that emails "you have a verbal
 *     warning" has skipped all four, and an unreasonable failure to follow the
 *     Code lets a tribunal adjust an award by up to 25% (TULR(C)A 1992 s.207A).
 *   • From 1 January 2027 the unfair-dismissal qualifying period drops to six
 *     months and the compensatory award is uncapped (Employment Rights Act
 *     2025). The cost of getting this wrong stops being bounded.
 *   • A Bradford score cannot see a disability, a pregnancy, or cancer
 *     treatment. Triggering formal action off it without a human in the way is
 *     how a setting ends up defending a discrimination claim it could have
 *     avoided by reading the record first.
 * So: approve, then it moves. That is one click per warning, and it is the
 * click that makes the rest of the record defensible. (b318, employment rules:
 * handbook first, law second, flag third.)
 *
 * SCORES
 *   bradford  B = S² × D over the lookback window. S = separate spells, D =
 *             total days. Shared with services/bradford-factor.js so that a day
 *             which counts once there counts once here.
 *   lateness  a count of late arrivals over the lookback window, from
 *             lib/lateness.js — which reads clock events only and judges nobody
 *             whose start time is unknown.
 * =========================================================================== */

const TZ = 'Europe/London';

/** Today in Europe/London as YYYY-MM-DD. */
function londonToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

/** 'YYYY-MM-DD' n weeks before `ymd`. */
function weeksBefore(ymd, weeks) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Math.round(Number(weeks) * 7));
  return d.toISOString().slice(0, 10);
}

const ymd = v => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v).toLocaleDateString('en-CA', { timeZone: TZ });
};

/**
 * Bradford Factor over an arbitrary window.
 *
 * services/bradford-factor.js fixes the window at 52 weeks and has no way to
 * ask for another; a stage with a 26-week lookback needs one. The merge rule is
 * deliberately identical: absence_requests is authoritative for the Wren era,
 * so an hr_absences row starting on the same day is dropped rather than counted
 * a second time.
 */
async function bradford(db, staffId, from, to) {
  const [{ rows: hist }, { rows: reqs }] = await Promise.all([
    db.query(`
      SELECT start_date, end_date, duration_days AS days
        FROM hr_absences
       WHERE staff_id = $1 AND LOWER(absence_type) LIKE 'sick%'
         AND start_date >= $2::date AND start_date <= $3::date`, [staffId, from, to]),
    db.query(`
      SELECT start_date, end_date, days_count AS days
        FROM absence_requests
       WHERE staff_id = $1 AND status = 'approved'
         AND (LOWER(request_type) = 'sick' OR LOWER(absence_type) = 'sick')
         AND start_date >= $2::date AND start_date <= $3::date`, [staffId, from, to]),
  ]);
  // 2026-10-01 — one illness is ONE episode. BrightHR stores most sickness as one row per day
  // (50 of 52 rows in the last year were single days), and the two stores overlap, so counting
  // rows made S — which Bradford squares — up to twice the truth (one member of staff scored
  // 6,069 on 17 "episodes" that were 9 illnesses). Every sick weekday from either store goes
  // into one set; a run of consecutive working days (weekends do not break it) is one episode.
  // D stays the stored duration where one exists, else the number of sick weekdays.
  const isWeekday = d => { const w = d.getUTCDay(); return w !== 0 && w !== 6; };
  const dayset = new Set();
  for (const r of [...hist, ...reqs]) {
    const a = ymd(r.start_date), b = ymd(r.end_date) || a;
    if (!a) continue;
    for (let d = new Date(a + 'T00:00:00Z'), e = new Date((b < a ? a : b) + 'T00:00:00Z'); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
      if (isWeekday(d)) dayset.add(d.toISOString().slice(0, 10));
    }
  }
  const sorted = [...dayset].sort();
  const episodes = [];
  for (const day of sorted) {
    const last = episodes[episodes.length - 1];
    if (last) {
      const nxt = new Date(last.to + 'T00:00:00Z');
      do { nxt.setUTCDate(nxt.getUTCDate() + 1); } while (!isWeekday(nxt));
      if (nxt.toISOString().slice(0, 10) === day) { last.to = day; last.days += 1; continue; }
    }
    episodes.push({ start_date: day, end_date: day, from: day, to: day, days: 1 });
  }
  const S = episodes.length;
  const D = episodes.reduce((sum, ep) => sum + ep.days, 0);
  return {
    score: Math.round(S * S * D),
    instances: S,
    days: Math.round(D * 10) / 10,
    episodes: episodes.map(e => ({ from: e.from, to: e.to, days: e.days })),
  };
}

/**
 * Late arrivals in a window, counted the same way the Lateness report counts
 * them: first clock-in of the day against the rota (then the contracted
 * pattern), with the grace period applied. A day with no recorded arrival is
 * not late — it is not counted at all.
 *
 * Re-implemented here as SQL rather than reusing the route's in-memory analysis
 * because this runs for every member of staff at once and the route's shape is
 * one window at a time.
 */
async function lateCount(db, staffId, from, to, graceMinutes) {
  const grace = Number.isFinite(Number(graceMinutes)) ? Math.max(0, Number(graceMinutes)) : 5;
  const { rows } = await db.query(`
    WITH arrivals AS (
      SELECT DISTINCT ON (e.staff_id, (e.event_time AT TIME ZONE '${TZ}')::date)
             e.staff_id,
             (e.event_time AT TIME ZONE '${TZ}')::date AS d,
             (e.event_time AT TIME ZONE '${TZ}')::time AS t
        FROM staff_clock_events_current e
       WHERE e.event_type = 'clock_in'
         AND e.staff_id = $1
         AND (e.event_time AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date
       ORDER BY e.staff_id, (e.event_time AT TIME ZONE '${TZ}')::date, e.event_time ASC
    ),
    sched AS (
      SELECT rs.staff_id, rs.shift_date AS d, rs.planned_start AS start_t
        FROM rota_shifts rs
       WHERE rs.staff_id = $1
         AND rs.shift_date BETWEEN $2::date AND $3::date
         AND rs.planned_start IS NOT NULL
         AND COALESCE(rs.is_absent, false) = false
         AND COALESCE(rs.is_open, false) = false
    )
    SELECT a.d::text AS date,
           to_char(a.t, 'HH24:MI')       AS arrived_at,
           to_char(s.start_t, 'HH24:MI') AS scheduled_start,
           (EXTRACT(EPOCH FROM (a.t - s.start_t)) / 60)::int AS minutes_late
      FROM arrivals a
      JOIN sched s ON s.staff_id = a.staff_id AND s.d = a.d
     WHERE (EXTRACT(EPOCH FROM (a.t - s.start_t)) / 60) > $4
     ORDER BY a.d DESC`, [staffId, from, to, grace]);
  return { score: rows.length, instances: rows.length, days: 0, occurrences: rows };
}

/**
 * Render a stage's letter template.
 *
 * Deliberately a dumb {{token}} substitution and nothing else — no conditionals,
 * no loops. The template is a letter a manager will read, correct and sign; the
 * moment it becomes a language it becomes something nobody edits.
 *
 * An unknown token is left standing rather than blanked, so a typo shows up in
 * the draft instead of silently producing a sentence with a hole in it.
 */
function renderLetter(template, vars) {
  if (!template) return '';
  return String(template).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => {
    const v = vars[key.toLowerCase()];
    return (v === undefined || v === null || v === '') ? whole : String(v);
  });
}

/**
 * Evaluate every active stage for one person.
 *
 * Returns the stages they are OVER, highest threshold first. The caller decides
 * what to do about it — this function writes nothing.
 *
 * Only the highest crossed stage of each kind is acted on. Somebody who arrives
 * at a Bradford score of 420 has crossed all four; raising four drafts at once
 * would be a pile of paper, not a process, and would skip the informal
 * conversation that should have happened at 50.
 */
/**
 * 2026-10-01 — THE LADDER. What this person has already been through, per kind.
 *
 * Without this the sweep drafted whatever the score reached, so a first-ever
 * draft could be a FINAL written warning whose letter says "you have
 * previously received a written warning" — untrue, and the ACAS Code expects
 * the stages to be climbed in order. Toby (2026-10-01): treat everyone as not
 * having had a verbal yet; he edits the one exception by hand (PUT /stage).
 *
 *   rank          the highest LIVE warning on a disciplinary case (verbal 1,
 *                 written 2, final 3), else 0. A case counts for a kind when
 *                 it was opened from a trigger of that kind; a capability case
 *                 opened by hand counts for every kind.
 *   inProgress    a trigger of this kind was approved and its case has no
 *                 outcome yet — the meeting has not happened, so nothing more
 *                 is drafted on top of it.
 *   lastStepOn    the latest approval, outcome or dismissal of this kind. A new
 *                 draft needs a FRESH absence (or late arrival) after it, so the
 *                 same year of sickness cannot walk someone up the ladder one
 *                 morning at a time, and a dismissal is not re-raised tomorrow.
 */
const OUTCOME_RANK = { verbal_warning: 1, written_warning: 2, final_written_warning: 3 };
const stageRank = st => OUTCOME_RANK[st.outcome_key] || 0;

async function loadHistory(db, staffId, today) {
  const t0 = today || londonToday();
  const [{ rows: trig }, { rows: loose }] = await Promise.all([
    db.query(`
      SELECT t.kind, t.status, t.approved_at, t.dismissed_at, t.case_id,
             c.outcome, c.outcome_on, c.warning_expires_on, c.closed_on
        FROM hr_warning_triggers t
        LEFT JOIN disciplinary_cases c ON c.id = t.case_id
       WHERE t.staff_id = $1 AND t.status IN ('approved','dismissed')`, [staffId]),
    db.query(`
      SELECT c.outcome, c.outcome_on, c.warning_expires_on
        FROM disciplinary_cases c
       WHERE c.staff_id = $1 AND c.case_type = 'capability' AND c.outcome IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM hr_warning_triggers t WHERE t.case_id = c.id)`, [staffId]),
  ]);
  const hist = {};
  const of = k => (hist[k] = hist[k] || { rank: 0, inProgress: false, lastStepOn: null });
  const step = (h, d) => { const v = ymd(d); if (v && (!h.lastStepOn || v > h.lastStepOn)) h.lastStepOn = v; };
  const live = r => r.warning_expires_on && ymd(r.warning_expires_on) >= t0;
  for (const r of trig) {
    const h = of(r.kind);
    if (r.status === 'dismissed') { step(h, r.dismissed_at); continue; }
    step(h, r.approved_at);
    if (r.case_id && !r.outcome && !r.closed_on) h.inProgress = true;
    if (r.outcome) step(h, r.outcome_on);
    if (live(r)) h.rank = Math.max(h.rank, OUTCOME_RANK[r.outcome] || 0);
  }
  for (const r of loose) {
    for (const k of ['bradford', 'lateness']) {
      const h = of(k);
      step(h, r.outcome_on);
      if (live(r)) h.rank = Math.max(h.rank, OUTCOME_RANK[r.outcome] || 0);
    }
  }
  return hist;
}

/** Has there been an absence episode / late arrival strictly after `since`? */
function freshSince(m, since) {
  if (!since) return true;
  if (Array.isArray(m.episodes)) return m.episodes.some(e => e.from > since);
  if (Array.isArray(m.occurrences)) return m.occurrences.some(o => String(o.date) > since);
  return false;
}

async function evaluate(db, staffId, stages, opts = {}) {
  const today = opts.today || londonToday();
  const grace = opts.graceMinutes;
  const history = opts.history || null;   // from loadHistory(); null = the old, ladder-less answer
  const out = [];
  const byKind = new Map();   // kind → measurement, computed once per lookback

  for (const st of stages) {
    if (!st.is_active) continue;
    const weeks = Number(st.lookback_weeks) || 52;
    const cacheKey = `${st.kind}|${weeks}`;
    if (!byKind.has(cacheKey)) {
      const from = weeksBefore(today, weeks);
      const m = st.kind === 'lateness'
        ? await lateCount(db, staffId, from, today, grace)
        : await bradford(db, staffId, from, today);
      byKind.set(cacheKey, { ...m, from, to: today, weeks });
    }
    const m = byKind.get(cacheKey);
    if (m.score >= Number(st.threshold)) {
      if (history) {
        // The ladder: never more than one step above the live warning, and
        // never a stage at or below one they already hold (an informal chat
        // and a verbal are both open to someone with no live warning).
        const h = history[st.kind] || { rank: 0 };
        const r = stageRank(st);
        if (r > h.rank + 1) continue;
        if (h.rank > 0 && r <= h.rank) continue;
      }
      out.push({ stage: st, measurement: m });
    }
  }

  // Highest threshold wins, per kind.
  const best = new Map();
  for (const c of out) {
    const k = c.stage.kind;
    if (!best.has(k) || Number(c.stage.threshold) > Number(best.get(k).stage.threshold)) best.set(k, c);
  }
  let picked = [...best.values()];
  if (history) {
    picked = picked.filter(c => {
      const h = history[c.stage.kind];
      if (!h) return true;
      if (h.inProgress) return false;
      return freshSince(c.measurement, h.lastStepOn);
    });
  }
  return picked.sort((a, b) => Number(b.stage.threshold) - Number(a.stage.threshold));
}

module.exports = {
  TZ, londonToday, weeksBefore, ymd,
  bradford, lateCount, renderLetter, evaluate,
  loadHistory, stageRank, OUTCOME_RANK,
};
