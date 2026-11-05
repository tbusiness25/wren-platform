'use strict';
/**
 * inbox-intel.js — b235 (2026-08-26)
 *
 * "How many parents didn't I respond to, what was ignored — and how can I avoid
 * it in future."
 *
 * Pure queries and local-model calls. No Express, no res.json, nothing that
 * knows what a request is; src/routes/inbox-intel.js is the only caller that
 * does. Everything here is safe to run from a script or a cron.
 *
 * ── THE FOUR PLACES A CONVERSATION CAN LIVE ─────────────────────────────────
 * Wren has grown more than one inbox, and conflating them produces figures that
 * look authoritative and are wrong. b232's messages collector already had to
 * work this out; the same distinction holds here:
 *
 *   message_threads → messages         PARENTS PORTAL. sender_type is
 *                                      'parent'|'staff'|'external'.
 *   threads → thread_messages          COMMS HUB (email triage, enquiries,
 *                                      Vapi calls). direction 'in'|'out',
 *                                      keyed to contacts, not children.
 *   enquiries                          the enquiry funnel, with its own
 *                                      replied_at.
 *   inbox_gmail_threads                the Gmail sweep (Part B), de-identified.
 *
 * thread_messages.thread_id points at `threads`, NOT at `message_threads`.
 *
 * ── WHAT IS STORED, AND WHAT IS NOT ─────────────────────────────────────────
 * The Gmail sweep is 33,000+ real threads about real children. Persisting their
 * subjects and bodies into wren_dev would turn the scrubbed-synthetic dev
 * database into a live personal-data store, which is not a trade this build is
 * entitled to make. So the sweep stores DERIVED, NON-IDENTIFYING metadata only:
 * a salted hash of the correspondent, their domain, message counts, timestamps,
 * label ids and booleans. Subjects and bodies are read into memory, shown to the
 * LOCAL model, and dropped. Nothing personal is written to disk by this build.
 *
 * That constraint is why `topic` on a verdict is a short generic phrase and not
 * a subject line.
 */

const { getPool } = require('../db/pool');
const FM = require('./fee-model');   // b299 — the 52-week billing basis, in one place
const sovereign = require('./sovereign-model');
const { ref, domainOf } = require('./inbox-redact');

// ── schema ──────────────────────────────────────────────────────────────────
// Additive only, IF NOT EXISTS throughout, per the standing rule.
const DDL = `
-- The Gmail sweep index. DE-IDENTIFIED BY DESIGN: no subject, no body, no address.
CREATE TABLE IF NOT EXISTS inbox_gmail_threads (
  thread_id        varchar(32) PRIMARY KEY,
  first_msg_at     timestamptz,
  last_msg_at      timestamptz,
  msg_count        integer,
  inbound_count    integer,
  outbound_count   integer,
  last_direction   varchar(4),
  answered         boolean,
  from_ref         varchar(80),
  from_domain      varchar(120),
  labels           text[],
  primary_label    text,
  is_bulk          boolean DEFAULT false,
  is_parent        boolean DEFAULT false,
  reply_minutes    integer,
  swept_at         timestamptz,
  created_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_igt_unswept ON inbox_gmail_threads (thread_id) WHERE swept_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_igt_last    ON inbox_gmail_threads (last_msg_at);
CREATE INDEX IF NOT EXISTS idx_igt_answer  ON inbox_gmail_threads (answered, last_direction);
CREATE INDEX IF NOT EXISTS idx_igt_primary ON inbox_gmail_threads (primary_label);

-- Resumability. One row per named sweep.
CREATE TABLE IF NOT EXISTS inbox_sweep_state (
  key            varchar(60) PRIMARY KEY,
  page_token     text,
  listed         integer DEFAULT 0,
  fetched        integer DEFAULT 0,
  errors         integer DEFAULT 0,
  phase          varchar(20),
  started_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  finished_at    timestamptz,
  note           text
);

-- Router output. draft_reply is a DRAFT and is never sent by anything in b235.
CREATE TABLE IF NOT EXISTS inbox_router_verdicts (
  id               serial PRIMARY KEY,
  item_kind        varchar(20) NOT NULL,
  item_ref         varchar(64) NOT NULL,
  lane             varchar(30) NOT NULL,
  urgency          varchar(10) NOT NULL,
  who              varchar(20),
  deadline         date,
  suggested_action text,
  draft_reply      text,
  confidence       numeric(4,3),
  topic            text,
  forced           boolean DEFAULT false,
  forced_key       varchar(20),
  forced_reason    text,
  verdict_source   varchar(30),
  model            varchar(60),
  run_id           varchar(40),
  created_at       timestamptz DEFAULT now(),
  UNIQUE (item_kind, item_ref)
);
CREATE INDEX IF NOT EXISTS idx_irv_lane ON inbox_router_verdicts (lane, urgency);
CREATE INDEX IF NOT EXISTS idx_irv_run  ON inbox_router_verdicts (run_id);

-- Router vs Toby's own filing, on threads held out of nothing — the labels were
-- never used to produce the prediction, so this is a fair score.
CREATE TABLE IF NOT EXISTS inbox_label_eval (
  id             serial PRIMARY KEY,
  run_id         varchar(40),
  item_ref       varchar(64),
  truth_lane     varchar(30),
  predicted_lane varchar(30),
  deciding_label text,
  agreed         boolean,
  confidence     numeric(4,3),
  created_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ile_run ON inbox_label_eval (run_id);
`;

async function ensureSchema() {
  const db = getPool();
  await db.query(DDL);
  return true;
}

// ── Part A: what was missed ─────────────────────────────────────────────────

/**
 * Parents-portal threads whose last message came from a parent.
 * "Unanswered" here means exactly that and nothing more — no judgement about
 * whether the parent needed an answer.
 */
async function portalUnanswered() {
  const db = getPool();
  const { rows } = await db.query(`
    WITH last AS (
      SELECT mt.id AS thread_id,
             mt.created_at AS thread_started,
             m.sender_type, m.created_at AS last_at
        FROM message_threads mt
        JOIN LATERAL (
          SELECT sender_type, created_at FROM messages
           WHERE thread_id = mt.id ORDER BY created_at DESC LIMIT 1
        ) m ON true
    )
    SELECT
      COUNT(*) FILTER (WHERE sender_type = 'parent')::int                              AS unanswered,
      COUNT(*)::int                                                                     AS threads_total,
      COUNT(*) FILTER (WHERE sender_type = 'parent'
                         AND last_at < now() - interval '48 hours')::int                AS unanswered_over_48h,
      COUNT(*) FILTER (WHERE sender_type = 'parent'
                         AND last_at < now() - interval '7 days')::int                  AS unanswered_over_7d,
      COUNT(*) FILTER (WHERE sender_type = 'parent'
                         AND last_at < now() - interval '30 days')::int                 AS unanswered_over_30d,
      MIN(last_at) FILTER (WHERE sender_type = 'parent')                                AS oldest_unanswered_at,
      ARRAY_AGG(thread_id ORDER BY last_at) FILTER (WHERE sender_type = 'parent')       AS thread_ids
      FROM last`);
  const r = rows[0] || {};
  return {
    threads_total: r.threads_total || 0,
    unanswered: r.unanswered || 0,
    unanswered_over_48h: r.unanswered_over_48h || 0,
    unanswered_over_7d: r.unanswered_over_7d || 0,
    unanswered_over_30d: r.unanswered_over_30d || 0,
    oldest_unanswered_at: r.oldest_unanswered_at || null,
    oldest_age_days: r.oldest_unanswered_at ? ageDays(r.oldest_unanswered_at) : null,
    thread_ids: (r.thread_ids || []).slice(0, 200),
  };
}

/** Comms-hub threads whose last message was inbound. */
async function hubUnanswered() {
  const db = getPool();
  const { rows } = await db.query(`
    WITH last AS (
      SELECT t.id AS thread_id, tm.direction, tm.created_at AS last_at
        FROM threads t
        JOIN LATERAL (
          SELECT direction, created_at FROM thread_messages
           WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1
        ) tm ON true
       WHERE t.archived_at IS NULL
    )
    SELECT
      COUNT(*)::int                                                           AS threads_total,
      COUNT(*) FILTER (WHERE direction = 'in')::int                           AS unanswered,
      COUNT(*) FILTER (WHERE direction = 'in'
                        AND last_at < now() - interval '48 hours')::int       AS unanswered_over_48h,
      COUNT(*) FILTER (WHERE direction = 'in'
                        AND last_at < now() - interval '7 days')::int         AS unanswered_over_7d,
      MIN(last_at) FILTER (WHERE direction = 'in')                            AS oldest_unanswered_at,
      ARRAY_AGG(thread_id ORDER BY last_at) FILTER (WHERE direction = 'in')   AS thread_ids
      FROM last`);
  const r = rows[0] || {};
  return {
    threads_total: r.threads_total || 0,
    unanswered: r.unanswered || 0,
    unanswered_over_48h: r.unanswered_over_48h || 0,
    unanswered_over_7d: r.unanswered_over_7d || 0,
    oldest_unanswered_at: r.oldest_unanswered_at || null,
    oldest_age_days: r.oldest_unanswered_at ? ageDays(r.oldest_unanswered_at) : null,
    thread_ids: (r.thread_ids || []).slice(0, 200),
  };
}

/**
 * Response time: for every inbound message, how long until the next outbound in
 * the same thread. Measured per MESSAGE, not per thread — a thread with six
 * exchanges tells you six things about how fast he answers.
 *
 * Percentiles come from percentile_cont, so they are real quantiles rather than
 * an average pretending to be one. Averages hide the tail, and the tail is the
 * entire question here.
 */
async function responseTimes() {
  const db = getPool();
  const { rows } = await db.query(`
    WITH pairs AS (
      -- parents portal
      SELECT m.created_at AS in_at,
             (SELECT MIN(s.created_at) FROM messages s
               WHERE s.thread_id = m.thread_id AND s.sender_type = 'staff'
                 AND s.created_at > m.created_at) AS out_at,
             'portal' AS channel
        FROM messages m WHERE m.sender_type = 'parent'
      UNION ALL
      -- comms hub
      SELECT tm.created_at,
             (SELECT MIN(s.created_at) FROM thread_messages s
               WHERE s.thread_id = tm.thread_id AND s.direction = 'out'
                 AND s.created_at > tm.created_at),
             'hub'
        FROM thread_messages tm WHERE tm.direction = 'in'
    ), answered AS (
      SELECT channel, in_at, out_at,
             EXTRACT(EPOCH FROM (out_at - in_at)) / 3600.0 AS hours
        FROM pairs WHERE out_at IS NOT NULL
    )
    SELECT
      (SELECT COUNT(*) FROM pairs)::int                                        AS inbound_total,
      (SELECT COUNT(*) FROM answered)::int                                     AS answered_total,
      (SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::numeric, 2) FROM answered) AS median_hours,
      (SELECT ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY hours)::numeric, 2) FROM answered) AS p90_hours,
      (SELECT ROUND(AVG(hours)::numeric, 2) FROM answered)                     AS mean_hours,
      (SELECT ROUND(MAX(hours)::numeric, 2) FROM answered)                     AS max_hours,
      (SELECT COUNT(*) FROM answered WHERE hours <= 2)::int                    AS within_2h,
      (SELECT COUNT(*) FROM answered WHERE hours <= 24)::int                   AS within_24h`);
  const r = rows[0] || {};
  const inbound = r.inbound_total || 0;
  return {
    inbound_total: inbound,
    answered_total: r.answered_total || 0,
    never_answered: inbound - (r.answered_total || 0),
    answered_pct: inbound ? +(((r.answered_total || 0) / inbound) * 100).toFixed(1) : null,
    median_hours: numOrNull(r.median_hours),
    p90_hours: numOrNull(r.p90_hours),
    mean_hours: numOrNull(r.mean_hours),
    max_hours: numOrNull(r.max_hours),
    within_2h: r.within_2h || 0,
    within_24h: r.within_24h || 0,
  };
}

/**
 * When do the messages he never answers arrive? This is the figure Part D is
 * built on — "route 15:00–18:00 to the deputy" is only a recommendation if the data
 * says that window is where things fall over.
 */
async function arrivalPattern() {
  const db = getPool();
  const { rows } = await db.query(`
    WITH inbound AS (
      SELECT m.created_at AS at,
             EXISTS (SELECT 1 FROM messages s WHERE s.thread_id = m.thread_id
                       AND s.sender_type='staff' AND s.created_at > m.created_at) AS answered
        FROM messages m WHERE m.sender_type = 'parent'
      UNION ALL
      SELECT tm.created_at,
             EXISTS (SELECT 1 FROM thread_messages s WHERE s.thread_id = tm.thread_id
                       AND s.direction='out' AND s.created_at > tm.created_at)
        FROM thread_messages tm WHERE tm.direction = 'in'
    )
    SELECT EXTRACT(HOUR FROM at)::int AS hour,
           EXTRACT(ISODOW FROM at)::int AS dow,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE NOT answered)::int AS unanswered
      FROM inbound
     GROUP BY 1, 2 ORDER BY 1, 2`);

  const byHour = {}, byDow = {};
  let total = 0, unanswered = 0;
  for (const r of rows) {
    total += r.n; unanswered += r.unanswered;
    byHour[r.hour] = byHour[r.hour] || { n: 0, unanswered: 0 };
    byHour[r.hour].n += r.n; byHour[r.hour].unanswered += r.unanswered;
    byDow[r.dow] = byDow[r.dow] || { n: 0, unanswered: 0 };
    byDow[r.dow].n += r.n; byDow[r.dow].unanswered += r.unanswered;
  }
  // The handover window is the operational reality behind the number: 15:00–18:00
  // is when rooms change over and nobody is at a screen.
  const handover = Object.entries(byHour)
    .filter(([h]) => +h >= 15 && +h < 18)
    .reduce((a, [, v]) => ({ n: a.n + v.n, unanswered: a.unanswered + v.unanswered }), { n: 0, unanswered: 0 });

  return {
    inbound_total: total,
    unanswered_total: unanswered,
    by_hour: byHour,
    by_dow: byDow,
    handover_window: Object.assign({}, handover, {
      share_of_unanswered: unanswered ? +((handover.unanswered / unanswered) * 100).toFixed(1) : null,
    }),
    worst_hour: pickWorst(byHour),
    worst_dow: pickWorst(byDow),
  };
}

/**
 * Enquiries that never got a reply. These are the expensive ones: an enquiry is
 * a family who wanted a place and asked for it.
 */
async function enquiriesMissed() {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int                                                       AS total,
      COUNT(*) FILTER (WHERE replied_at IS NULL)::int                     AS never_replied,
      COUNT(*) FILTER (WHERE replied_at IS NULL
                         AND created_at < now() - interval '7 days')::int AS never_replied_over_7d,
      COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int                 AS replied,
      ROUND(percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (replied_at - created_at))/3600.0)::numeric, 2) AS median_reply_hours,
      MIN(created_at) FILTER (WHERE replied_at IS NULL)                   AS oldest_unreplied_at
      FROM enquiries`);
  const r = rows[0] || {};

  const { rows: bySource } = await db.query(`
    SELECT COALESCE(source, 'unknown') AS source, COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE replied_at IS NULL)::int AS never_replied
      FROM enquiries GROUP BY 1 ORDER BY 3 DESC, 2 DESC`);

  const { rows: byStage } = await db.query(`
    SELECT COALESCE(stage, 'unknown') AS stage, COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE replied_at IS NULL)::int AS never_replied
      FROM enquiries GROUP BY 1 ORDER BY 3 DESC, 2 DESC`);

  const value = await placeValue();
  const missed = r.never_replied || 0;

  return {
    total: r.total || 0,
    never_replied: missed,
    never_replied_over_7d: r.never_replied_over_7d || 0,
    replied: r.replied || 0,
    never_replied_pct: r.total ? +((missed / r.total) * 100).toFixed(1) : null,
    median_reply_hours: numOrNull(r.median_reply_hours),
    oldest_unreplied_at: r.oldest_unreplied_at || null,
    oldest_age_days: r.oldest_unreplied_at ? ageDays(r.oldest_unreplied_at) : null,
    by_source: bySource,
    by_stage: byStage,
    // Deliberately conservative, and the assumptions travel with the number so
    // nobody quotes it without them.
    revenue_at_risk: {
      day_rate_pence: value.day_rate_pence,
      assumed_days_per_week: value.days_per_week,
      assumed_weeks_per_year: value.weeks_per_year,
      assumed_conversion_rate: value.conversion,
      annual_value_per_place_gbp: value.annual_per_place_gbp,
      expected_lost_annual_gbp: value.annual_per_place_gbp == null ? null
        : Math.round(missed * value.conversion * value.annual_per_place_gbp),
      basis: `${missed} unanswered enquiries × ${value.conversion} assumed conversion × £${value.annual_per_place_gbp} per place per year`,
    },
  };
}

/** The day rate actually on the fee schedule, not a guess. */
async function placeValue() {
  const db = getPool();
  // b299 — was 48. A place is BILLED 52 weeks a year (fees are payable for all of
  // them, bank holidays and the Christmas closure included), so 48 was not a
  // conservative estimate of a year's fees, it was the wrong number of weeks.
  // The conservatism belongs in `conversion` — a quarter of unanswered enquiries
  // turning into a placement — where it is stated and can be argued with.
  const daysPerWeek = 5, weeksPerYear = FM.WEEKS_PER_YEAR, conversion = 0.25;
  let dayRate = null;
  try {
    const { rows } = await db.query(`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_pence)::int AS p
        FROM fee_items
       WHERE active AND unit = 'day' AND price_pence IS NOT NULL AND price_pence > 0`);
    dayRate = rows[0] && rows[0].p ? rows[0].p : null;
  } catch (_) { /* fee_items may not exist on every edition */ }
  return {
    day_rate_pence: dayRate,
    days_per_week: daysPerWeek,
    weeks_per_year: weeksPerYear,
    conversion,
    annual_per_place_gbp: dayRate == null ? null
      : Math.round((dayRate / 100) * daysPerWeek * weeksPerYear),
  };
}

/** Which kinds of conversation go unanswered most. */
async function categoryBreakdown() {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT COALESCE(tm.source, 'unknown') AS category,
           COUNT(*)::int AS inbound,
           COUNT(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM thread_messages s
              WHERE s.thread_id = tm.thread_id AND s.direction = 'out'
                AND s.created_at > tm.created_at))::int AS unanswered
      FROM thread_messages tm
     WHERE tm.direction = 'in'
     GROUP BY 1 ORDER BY 3 DESC, 2 DESC`);
  return rows.map((r) => Object.assign({}, r, {
    unanswered_pct: r.inbound ? +((r.unanswered / r.inbound) * 100).toFixed(1) : null,
  }));
}

/** Everything in Part A, in one call. */
async function partA() {
  const [portal, hub, times, arrivals, enq, cats] = await Promise.all([
    portalUnanswered(), hubUnanswered(), responseTimes(),
    arrivalPattern(), enquiriesMissed(), categoryBreakdown(),
  ]);
  return {
    generated_at: new Date().toISOString(),
    portal, hub,
    response_times: times,
    arrivals,
    enquiries: enq,
    categories: cats,
    totals: {
      unanswered_conversations: portal.unanswered + hub.unanswered + enq.never_replied,
      conversations_examined: portal.threads_total + hub.threads_total + enq.total,
    },
  };
}

// ── Part B reads: the Gmail sweep, once it has run ──────────────────────────

/** The `1. TO DO` backlog — by his own classification, what he meant to do and didn't. */
async function todoBacklog() {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE last_msg_at < now() - interval  '30 days')::int AS over_30d,
           COUNT(*) FILTER (WHERE last_msg_at < now() - interval  '90 days')::int AS over_90d,
           COUNT(*) FILTER (WHERE last_msg_at < now() - interval '365 days')::int AS over_1y,
           COUNT(*) FILTER (WHERE last_msg_at < now() - interval '730 days')::int AS over_2y,
           MIN(last_msg_at) AS oldest_at,
           ROUND(AVG(EXTRACT(EPOCH FROM (now() - last_msg_at)) / 86400.0)::numeric, 1) AS mean_age_days,
           ROUND(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (now() - last_msg_at)) / 86400.0)::numeric, 1) AS median_age_days
      FROM inbox_gmail_threads
     WHERE swept_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(labels) l WHERE l = '1. TO DO' OR l LIKE '1. TO DO/%')`);
  const r = rows[0] || {};

  const { rows: subs } = await db.query(`
    SELECT l AS label, COUNT(*)::int AS n,
           ROUND(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (now() - last_msg_at)) / 86400.0)::numeric, 1) AS median_age_days
      FROM inbox_gmail_threads, unnest(labels) l
     WHERE swept_at IS NOT NULL AND (l = '1. TO DO' OR l LIKE '1. TO DO/%')
     GROUP BY 1 ORDER BY 2 DESC`);

  return {
    total: r.n || 0,
    over_30d: r.over_30d || 0, over_90d: r.over_90d || 0,
    over_1y: r.over_1y || 0, over_2y: r.over_2y || 0,
    oldest_at: r.oldest_at || null,
    oldest_age_days: r.oldest_at ? ageDays(r.oldest_at) : null,
    mean_age_days: numOrNull(r.mean_age_days),
    median_age_days: numOrNull(r.median_age_days),
    by_label: subs,
  };
}

/** Did the things routed to the admissions lead actually get answered? If delegation leaks, the lane leaks. */
async function delegationLeak() {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE answered)::int AS answered,
           COUNT(*) FILTER (WHERE NOT answered)::int AS unanswered,
           ROUND(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (now() - last_msg_at)) / 86400.0)::numeric, 1) AS median_age_days
      FROM inbox_gmail_threads
     WHERE swept_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(labels) l WHERE l = '2. the admissions lead to respond')`);
  const r = rows[0] || {};
  return {
    delegated: r.n || 0,
    answered: r.answered || 0,
    unanswered: r.unanswered || 0,
    leak_pct: r.n ? +(((r.unanswered || 0) / r.n) * 100).toFixed(1) : null,
    median_age_days: numOrNull(r.median_age_days),
  };
}

/**
 * Arrival pattern over the Gmail sweep — the same question as arrivalPattern()
 * but with a sample big enough to mean something.
 *
 * The portal and comms-hub tables hold single-figure numbers of inbound
 * messages on dev, and "40% of unanswered mail arrives at handover" computed
 * from two messages is not a finding, it is noise with a percent sign on it.
 * The mailbox has tens of thousands of threads, so Part D prefers this and only
 * falls back to the database figures when the sweep has not run.
 *
 * Bulk mail is excluded throughout: a newsletter arriving at 16:00 and never
 * being answered is not a handover problem.
 */
async function gmailArrivalPattern() {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT EXTRACT(HOUR FROM last_msg_at)::int AS hour,
           EXTRACT(ISODOW FROM last_msg_at)::int AS dow,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE last_direction = 'in' AND NOT answered)::int AS unanswered
      FROM inbox_gmail_threads
     WHERE swept_at IS NOT NULL AND NOT is_bulk AND last_msg_at IS NOT NULL
     GROUP BY 1, 2`);
  if (!rows.length) return null;

  const byHour = {}, byDow = {};
  let total = 0, unanswered = 0;
  for (const r of rows) {
    total += r.n; unanswered += r.unanswered;
    byHour[r.hour] = byHour[r.hour] || { n: 0, unanswered: 0 };
    byHour[r.hour].n += r.n; byHour[r.hour].unanswered += r.unanswered;
    byDow[r.dow] = byDow[r.dow] || { n: 0, unanswered: 0 };
    byDow[r.dow].n += r.n; byDow[r.dow].unanswered += r.unanswered;
  }
  const handover = Object.entries(byHour)
    .filter(([h]) => +h >= 15 && +h < 18)
    .reduce((a, [, v]) => ({ n: a.n + v.n, unanswered: a.unanswered + v.unanswered }), { n: 0, unanswered: 0 });

  return {
    source: 'gmail',
    inbound_total: total,
    unanswered_total: unanswered,
    by_hour: byHour,
    by_dow: byDow,
    handover_window: Object.assign({}, handover, {
      share_of_unanswered: unanswered ? +((handover.unanswered / unanswered) * 100).toFixed(1) : null,
    }),
    worst_hour: pickWorst(byHour),
    worst_dow: pickWorst(byDow),
  };
}

/** Gmail sweep headline figures, including who was never answered. */
async function gmailStats() {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS listed,
           COUNT(*) FILTER (WHERE swept_at IS NOT NULL)::int AS swept,
           COUNT(*) FILTER (WHERE swept_at IS NOT NULL AND last_direction = 'in' AND NOT answered)::int AS unanswered,
           COUNT(*) FILTER (WHERE swept_at IS NOT NULL AND is_bulk)::int AS bulk,
           COUNT(*) FILTER (WHERE swept_at IS NOT NULL AND is_parent)::int AS parent_threads,
           COUNT(*) FILTER (WHERE swept_at IS NOT NULL AND is_parent AND last_direction='in' AND NOT answered)::int AS parent_unanswered,
           MIN(first_msg_at) AS earliest, MAX(last_msg_at) AS latest,
           ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY reply_minutes)::numeric, 1) AS median_reply_minutes,
           ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY reply_minutes)::numeric, 1) AS p90_reply_minutes
      FROM inbox_gmail_threads`);
  const r = rows[0] || {};

  const { rows: byLabel } = await db.query(`
    SELECT COALESCE(primary_label, '(unfiled)') AS label,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE last_direction = 'in' AND NOT answered)::int AS unanswered
      FROM inbox_gmail_threads WHERE swept_at IS NOT NULL
     GROUP BY 1 ORDER BY 2 DESC LIMIT 40`);

  const { rows: byDomain } = await db.query(`
    SELECT from_domain, COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE last_direction='in' AND NOT answered)::int AS unanswered
      FROM inbox_gmail_threads
     WHERE swept_at IS NOT NULL AND from_domain IS NOT NULL AND from_domain <> ''
     GROUP BY 1 ORDER BY 2 DESC LIMIT 25`);

  return {
    listed: r.listed || 0, swept: r.swept || 0,
    unanswered: r.unanswered || 0,
    bulk: r.bulk || 0,
    bulk_pct: r.swept ? +(((r.bulk || 0) / r.swept) * 100).toFixed(1) : null,
    parent_threads: r.parent_threads || 0,
    parent_unanswered: r.parent_unanswered || 0,
    earliest: r.earliest || null, latest: r.latest || null,
    // The mailbox goes back to 2021. Every per-month figure in the prevention
    // report divides by THIS, not by 12 — dividing a five-and-a-half-year
    // backlog by twelve overstates the monthly rate by 5.5x, and "hours saved
    // per month" is precisely the number that gets acted on.
    months_covered: (r.earliest && r.latest)
      ? Math.max(1, Math.round(((new Date(r.latest) - new Date(r.earliest)) / 2629800000) * 10) / 10)
      : null,
    median_reply_minutes: numOrNull(r.median_reply_minutes),
    p90_reply_minutes: numOrNull(r.p90_reply_minutes),
    by_label: byLabel,
    by_domain: byDomain,
  };
}

// ── Part D: how to avoid it in future ───────────────────────────────────────

/**
 * Recommendations, each one gated on a real threshold over a real figure.
 *
 * These are generated from a catalogue, not from the model, and that is
 * deliberate. The brief's rule was "no generic productivity advice — every
 * recommendation must cite a figure this analysis produced". A model asked for
 * advice will always produce advice, cited or not. A catalogue whose entries
 * only fire when a computed number crosses a threshold cannot produce an
 * uncited recommendation, because with no number there is no entry.
 *
 * The local model is used afterwards, for one paragraph of framing over the
 * figures that already exist. If it is unavailable the recommendations stand
 * on their own.
 */
const _narrativeCache = new Map();
const _narrativeJobs = new Map();

async function prevention(opts = {}) {
  const a = await partA();
  let gm = null, todo = null, leak = null, gmArr = null;
  try { gm = await gmailStats(); } catch (_) { /* sweep not run yet */ }
  try { todo = await todoBacklog(); } catch (_) { /* ditto */ }
  try { leak = await delegationLeak(); } catch (_) { /* ditto */ }
  try { gmArr = await gmailArrivalPattern(); } catch (_) { /* ditto */ }

  const recs = [];
  const add = (r) => { if (r) recs.push(r); };

  // A recommendation resting on a handful of rows is noise with a percent sign
  // on it, and it is exactly what "every recommendation must cite a figure"
  // is meant to prevent — a cited figure computed from n=2 is worse than no
  // recommendation, because it looks like evidence.
  const MIN_SAMPLE = 30;

  // How long the evidence actually covers. Rates are per month over the period
  // observed, never per month over an assumed year.
  const MONTHS = (gm && gm.months_covered) ? gm.months_covered : 12;

  // 1. The handover window. Prefer the Gmail sample (tens of thousands of
  // threads) over the portal tables, which hold single figures on dev.
  const arr = (gmArr && gmArr.unanswered_total >= MIN_SAMPLE) ? gmArr : a.arrivals;
  const hw = arr.handover_window;
  if (hw && hw.share_of_unanswered != null && arr.unanswered_total >= MIN_SAMPLE) {
    add({
      id: 'handover-window',
      title: 'Auto-route messages arriving 15:00–18:00 to the deputy',
      figure: `${hw.share_of_unanswered}% of unanswered ${arr.source === 'gmail' ? 'email threads' : 'inbound messages'} `
        + `(${hw.unanswered.toLocaleString('en-GB')} of ${arr.unanswered_total.toLocaleString('en-GB')}) arrived between 15:00 and 18:00`,
      why: 'That is room handover and collection. Nobody is at a screen, and by the time anyone is, the message has scrolled away.',
      change: 'Add a routing rule so anything inbound in that window is assigned to the deputy by default, and only comes back to you if she reassigns it.',
      hours_saved_per_month: round1((hw.unanswered / MONTHS) * 0.05),
      effort: 'one routing rule',
    });
  }

  // 2. Bulk mail.
  if (gm && gm.bulk_pct != null && gm.bulk_pct >= 10) {
    add({
      id: 'filter-bulk',
      title: 'Filter bulk and newsletter mail out of the inbox entirely',
      figure: `${gm.bulk_pct}% of swept threads (${gm.bulk.toLocaleString('en-GB')} of ${gm.swept.toLocaleString('en-GB')}) are bulk or list mail that never needed an answer, over ${MONTHS} months`,
      why: 'Every one of those is a decision you make and then unmake. The cost is not reading them, it is deciding about them.',
      change: 'A Gmail filter that skips the inbox for anything carrying a List-Id, straight into Misc/Newsletters, which is where you file them by hand anyway.',
      hours_saved_per_month: round1((gm.bulk / MONTHS) * (5 / 60)),
      effort: 'one Gmail filter',
    });
  }

  // 3. The TO DO backlog.
  if (todo && todo.total > 0 && todo.over_90d > 0) {
    add({
      id: 'todo-amnesty',
      title: 'Declare an amnesty on the `1. TO DO` backlog, then cap it',
      figure: `${todo.total} threads carry a "1. TO DO" label; ${todo.over_90d} are over 90 days old and ${todo.over_1y} are over a year old (median age ${todo.median_age_days} days)`,
      why: 'A label you have applied to hundreds of things over several years is not a to-do list, it is a place things go to stop being visible. Anything a year old was never going to happen.',
      change: 'Archive everything in that label older than 12 months unread, then hard-cap the label at 20 items — adding the 21st means removing one.',
      hours_saved_per_month: round1(todo.total * 0.02),
      effort: 'one bulk archive, then a habit',
    });
  }

  // 4. Delegation that leaks.
  if (leak && leak.delegated > 0 && leak.leak_pct != null && leak.leak_pct >= 20) {
    add({
      id: 'delegation-leak',
      title: 'Delegated items need a return date, not just a label',
      figure: `${leak.unanswered} of ${leak.delegated} threads filed "2. the admissions lead to respond" (${leak.leak_pct}%) still have no reply`,
      why: 'Delegation already leaks at this rate. Routing more to the deputy without fixing that just moves the pile.',
      change: 'When the router assigns delegate-to-ayla it also sets a chase date, and an unanswered delegated item comes back to the attention board after 3 days.',
      hours_saved_per_month: round1(leak.unanswered * 0.05),
      effort: 'router change, already built',
    });
  }

  // 5. Enquiries — the money one.
  const e = a.enquiries;
  if (e.never_replied > 0) {
    add({
      id: 'enquiry-sla',
      title: 'Give enquiries a hard same-day rule, enforced by the board',
      figure: `${e.never_replied} of ${e.total} enquiries (${e.never_replied_pct}%) have never been replied to` +
        (e.revenue_at_risk.expected_lost_annual_gbp
          ? `, worth roughly £${e.revenue_at_risk.expected_lost_annual_gbp.toLocaleString('en-GB')} a year at ${e.revenue_at_risk.assumed_conversion_rate} conversion`
          : ''),
      why: 'An enquiry is a family who wanted a place and asked for it. Two days of silence and they have booked somewhere else.',
      change: 'Any enquiry with no reply after 4 working hours goes RED on the attention board and is auto-assigned — to the deputy if you have not opened it.',
      hours_saved_per_month: 0,
      revenue_protected_annual_gbp: e.revenue_at_risk.expected_lost_annual_gbp || null,
      effort: 'collector threshold, already built',
    });
  }

  // 6. The tail on response time.
  const rt = a.response_times;
  if (rt.median_hours != null && rt.p90_hours != null && rt.answered_total >= MIN_SAMPLE
      && rt.p90_hours > rt.median_hours * 4) {
    add({
      id: 'tail-not-average',
      title: 'Stop measuring your inbox by the average — the tail is the problem',
      figure: `median reply ${rt.median_hours}h but 90th percentile ${rt.p90_hours}h, over ${rt.answered_total} answered messages`,
      why: 'Most things get answered fast. A small number wait weeks, and those are the ones people remember and complain about.',
      change: 'Track the 90th percentile on the board, not the average. Anything past 48h surfaces regardless of what it is.',
      hours_saved_per_month: 0,
      effort: 'one metric change',
    });
  }

  // 7. Never-answered rate.
  if (rt.inbound_total >= MIN_SAMPLE && rt.never_answered > 0) {
    add({
      id: 'never-answered',
      title: 'Close the loop on inbound messages that got no reply at all',
      figure: `${rt.never_answered} of ${rt.inbound_total} inbound messages (${round1(100 - (rt.answered_pct || 0))}%) never received any reply`,
      why: 'Not slow — absent. These are the ones that turn into a complaint or a lost family.',
      change: 'A daily 09:00 digest of everything inbound and unanswered for 24h, one line each, ranked by the router.',
      hours_saved_per_month: round1(rt.never_answered * 0.08),
      effort: 'one cron + existing router',
    });
  }

  // Worst single hour, when it is genuinely concentrated AND the sample is big
  // enough for "concentrated" to be a real claim.
  const wh = arr.worst_hour;
  if (wh && wh.key != null && arr.unanswered_total >= MIN_SAMPLE) {
    const share = +((wh.unanswered / arr.unanswered_total) * 100).toFixed(1);
    if (share >= 15) {
      add({
        id: 'worst-hour',
        title: `Block ten minutes at ${String((+wh.key + 1) % 24).padStart(2, '0')}:00 to clear the ${String(wh.key).padStart(2, '0')}:00 arrivals`,
        figure: `${share}% of all unanswered inbound (${wh.unanswered.toLocaleString('en-GB')} of ${arr.unanswered_total.toLocaleString('en-GB')}) arrived in the ${String(wh.key).padStart(2, '0')}:00 hour alone`,
        why: 'One hour of the day accounts for a fifth of everything you miss. That is a calendar problem, not a discipline problem.',
        change: 'A recurring ten-minute slot one hour later, with the router queue open. Nothing else.',
        hours_saved_per_month: round1((wh.unanswered / MONTHS) * 0.03),
        effort: 'a calendar entry',
      });
    }
  }

  recs.sort((x, y) => (y.hours_saved_per_month || 0) - (x.hours_saved_per_month || 0));

  const out = {
    generated_at: new Date().toISOString(),
    based_on: {
      conversations_examined: a.totals.conversations_examined,
      gmail_threads_swept: gm ? gm.swept : 0,
      inbound_messages: a.response_times.inbound_total,
      arrival_sample: arr.source === 'gmail' ? 'gmail' : 'wren-tables',
      arrival_sample_size: arr.unanswered_total,
      min_sample_required: MIN_SAMPLE,
      months_covered: MONTHS,
      // pg hands these back as Date objects, so String() gives "Wed Oct 14 2020…"
      // and slicing that produces "Wed Oct 14". toISOString() first.
      period: gm && gm.earliest ? `${isoDay(gm.earliest)} to ${isoDay(gm.latest)}` : null,
    },
    recommendations: recs,
    total_hours_saved_per_month: round1(recs.reduce((s, r) => s + (r.hours_saved_per_month || 0), 0)),
    revenue_protected_annual_gbp: recs.reduce((s, r) => s + (r.revenue_protected_annual_gbp || 0), 0) || null,
    narrative: null,
    narrative_model: null,
  };

  // The one model call in Part D: framing, over figures that already exist.
  // 2026-10-08: the local model took ~29s on every Cockpit load (users navigated away
  // → 499s). The figures change slowly, so the narrative is cached per set of figures
  // for 30 min; on a miss it is generated in the background and we wait at most 3s.
  if (opts.narrative !== false && recs.length) {
    const key = recs.map((r) => `${r.title}|${r.figure}`).join('\n');
    const hit = _narrativeCache.get(key);
    if (hit && hit.text && Date.now() - hit.at < 30 * 60 * 1000) {
      out.narrative = hit.text; out.narrative_model = hit.model;
    } else {
      let job = _narrativeJobs.get(key);
      if (!job) {
        job = (async () => {
          await sovereign.assertSovereign();
          const txt = await sovereign.generate({
            system: 'You write two or three plain sentences for the manager of a small nursery. Direct, no motivational language, no bullet points, no preamble. You may only refer to the figures given.',
            prompt: `These are the findings about his inbox. Write two or three sentences telling him what the pattern is and which single change to make first.\n\n${
              recs.map((r) => `- ${r.title} — ${r.figure}`).join('\n')}`,
            temperature: 0.2,
            numPredict: 220,
          });
          const text = txt.trim().replace(/^```[\s\S]*?\n|```$/g, '') || null;
          if (text) _narrativeCache.set(key, { text, model: sovereign.MODEL, at: Date.now() });
          return text;
        })().finally(() => _narrativeJobs.delete(key));
        job.catch(() => {});
        _narrativeJobs.set(key, job);
      }
      try {
        const text = await Promise.race([job, new Promise((r) => setTimeout(() => r(undefined), 3000))]);
        if (text === undefined) {
          out.narrative = hit ? hit.text : null;
          out.narrative_model = hit ? hit.model : null;
          if (!hit) out.narrative_note = 'The local model is writing a summary — refresh in a minute.';
        } else {
          out.narrative = text; out.narrative_model = sovereign.MODEL;
        }
      } catch (e) {
        out.narrative = null;
        out.narrative_note = 'Local model unavailable — recommendations stand without it. No cloud fallback exists.';
      }
    }
  }

  return out;
}

// ── verdict storage ─────────────────────────────────────────────────────────

async function saveVerdict(kind, itemRef, v, runId) {
  const db = getPool();
  const { rows } = await db.query(`
    INSERT INTO inbox_router_verdicts
      (item_kind, item_ref, lane, urgency, who, deadline, suggested_action,
       draft_reply, confidence, topic, forced, forced_key, forced_reason,
       verdict_source, model, run_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (item_kind, item_ref) DO UPDATE SET
      lane=EXCLUDED.lane, urgency=EXCLUDED.urgency, who=EXCLUDED.who,
      deadline=EXCLUDED.deadline, suggested_action=EXCLUDED.suggested_action,
      draft_reply=EXCLUDED.draft_reply, confidence=EXCLUDED.confidence,
      topic=EXCLUDED.topic, forced=EXCLUDED.forced, forced_key=EXCLUDED.forced_key,
      forced_reason=EXCLUDED.forced_reason, verdict_source=EXCLUDED.verdict_source,
      model=EXCLUDED.model, run_id=EXCLUDED.run_id, created_at=now()
    RETURNING id`,
    [kind, String(itemRef), v.lane, v.urgency, v.who, v.deadline, v.suggested_action,
     v.draft_reply, v.confidence, v.topic || null, !!v.forced, v.forced_key || null,
     v.forced_reason || null, v.source || null, v.model || null, runId || null]);
  return rows[0] ? rows[0].id : null;
}

async function laneDistribution(runId) {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT lane, urgency, verdict_source, COUNT(*)::int AS n
      FROM inbox_router_verdicts
     ${runId ? 'WHERE run_id = $1' : ''}
     GROUP BY 1,2,3 ORDER BY 4 DESC`, runId ? [runId] : []);
  const byLane = {};
  for (const r of rows) byLane[r.lane] = (byLane[r.lane] || 0) + r.n;
  return { by_lane: byLane, detail: rows, total: rows.reduce((s, r) => s + r.n, 0) };
}

// ── helpers ─────────────────────────────────────────────────────────────────
function ageDays(t) { return Math.round((Date.now() - new Date(t).getTime()) / 86400000); }
function isoDay(d) { return d ? new Date(d).toISOString().slice(0, 10) : null; }
function numOrNull(v) { return v == null ? null : Number(v); }
function round1(n) { return Math.round((n || 0) * 10) / 10; }
function pickWorst(map) {
  let key = null, best = -1, rec = null;
  for (const [k, v] of Object.entries(map)) {
    if (v.unanswered > best) { best = v.unanswered; key = k; rec = v; }
  }
  return rec ? { key: key == null ? null : +key, n: rec.n, unanswered: rec.unanswered } : null;
}

module.exports = {
  DDL, ensureSchema,
  portalUnanswered, hubUnanswered, responseTimes, arrivalPattern,
  enquiriesMissed, categoryBreakdown, placeValue, partA,
  gmailStats, gmailArrivalPattern, todoBacklog, delegationLeak,
  prevention, saveVerdict, laneDistribution,
  ref, domainOf,
};
