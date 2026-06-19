-- Wren Insights — full schema migration
-- Idempotent: safe to re-run

BEGIN;

CREATE SCHEMA IF NOT EXISTS insights;
CREATE SCHEMA IF NOT EXISTS insights_staging;

-- ── Queryable tables safelist ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insights.queryable_tables (
  id          serial PRIMARY KEY,
  schema_name text    NOT NULL,
  table_name  text    NOT NULL,
  display_name text   NOT NULL,
  category    text,          -- 'staff','children','finance','operations','quality'
  blocked_columns text[],    -- columns never exposed
  description text,
  is_active   boolean DEFAULT TRUE,
  UNIQUE(schema_name, table_name)
);

-- ── Metric definitions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insights.metric_definitions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  category         text NOT NULL,
  edition          text[] DEFAULT ARRAY['eyfs','primary','secondary'],
  sql_template     text NOT NULL,
  chart_type       text NOT NULL DEFAULT 'number',
  refresh_cadence  text DEFAULT 'daily',
  rag_thresholds   jsonb,
  description      text,
  insight_template text,
  is_builtin       boolean DEFAULT TRUE,
  is_active        boolean DEFAULT TRUE,
  sort_order       integer DEFAULT 100,
  created_by       integer,
  created_at       timestamptz DEFAULT now()
);

-- ── Metric results ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insights.metric_results (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_id    uuid REFERENCES insights.metric_definitions(id) ON DELETE CASCADE,
  computed_at  timestamptz DEFAULT now(),
  result_data  jsonb,
  rag_status   text,     -- 'green','amber','red','neutral'
  ai_insight   text,
  schema_scope text,
  error_message text
);
CREATE INDEX IF NOT EXISTS metric_results_metric_id ON insights.metric_results(metric_id);
CREATE INDEX IF NOT EXISTS metric_results_computed_at ON insights.metric_results(computed_at DESC);

-- ── User dashboards ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insights.user_dashboards (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    integer,
  name       text NOT NULL,
  is_default boolean DEFAULT FALSE,
  layout     jsonb DEFAULT '[]',
  is_shared  boolean DEFAULT FALSE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_dashboards_user_id ON insights.user_dashboards(user_id);

-- ── Dashboard widgets ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insights.dashboard_widgets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id      uuid REFERENCES insights.user_dashboards(id) ON DELETE CASCADE,
  metric_id         uuid REFERENCES insights.metric_definitions(id) ON DELETE SET NULL,
  custom_definition jsonb,
  position          jsonb DEFAULT '{"x":0,"y":0,"w":2,"h":2}',
  filters           jsonb,
  title             text,
  created_at        timestamptz DEFAULT now()
);

-- ── Query audit ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insights.query_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       integer,
  user_name     text,
  query_text    text NOT NULL,
  generated_sql text,
  row_count     integer,
  error_message text,
  schema_scope  text,
  duration_ms   integer,
  blocked       boolean DEFAULT FALSE,
  block_reason  text,
  queried_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS query_audit_user_id    ON insights.query_audit(user_id);
CREATE INDEX IF NOT EXISTS query_audit_queried_at ON insights.query_audit(queried_at DESC);

-- ── RAG documents ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insights.rag_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename        text NOT NULL,
  mime_type       text,
  uploaded_by     integer,
  uploaded_at     timestamptz DEFAULT now(),
  total_chunks    integer DEFAULT 0,
  status          text DEFAULT 'processing',
  error_message   text,
  file_size_bytes bigint
);

-- ── RAG chunks (tsvector FTS — no pgvector needed) ───────────────────────────
CREATE TABLE IF NOT EXISTS insights.rag_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid REFERENCES insights.rag_documents(id) ON DELETE CASCADE,
  chunk_index   integer NOT NULL,
  text          text NOT NULL,
  search_vector tsvector,
  metadata      jsonb
);
CREATE INDEX IF NOT EXISTS rag_chunks_fts    ON insights.rag_chunks USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS rag_chunks_doc_id ON insights.rag_chunks(document_id);

-- ── Staging tables registry ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insights.staging_tables_registry (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id       uuid REFERENCES insights.rag_documents(id) ON DELETE CASCADE,
  schema_name     text DEFAULT 'insights_staging',
  table_name      text NOT NULL,
  source_filename text,
  column_metadata jsonb,
  row_count       integer,
  created_at      timestamptz DEFAULT now()
);

-- ── Surveillance confirmations ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insights.surveillance_confirmations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      integer,
  target_type  text,
  target_id    integer,
  confirmed_at timestamptz DEFAULT now(),
  ip_address   text
);

-- ── Anomaly results (written by stats service) ───────────────────────────────
CREATE TABLE IF NOT EXISTS insights.anomaly_results (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at       timestamptz DEFAULT now(),
  schema_scope text,
  metric_key   text,
  entity_type  text,     -- 'staff','child'
  entity_id    integer,
  entity_name  text,
  anomaly_score numeric,
  severity     text,     -- 'low','medium','high'
  description  text,
  raw_data     jsonb
);
CREATE INDEX IF NOT EXISTS anomaly_results_run_at ON insights.anomaly_results(run_at DESC);

-- ── Forecast results ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insights.forecast_results (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at       timestamptz DEFAULT now(),
  schema_scope text,
  metric_key   text,
  forecast_data jsonb,   -- {dates:[], best:[], expected:[], worst:[]}
  horizon_days  integer
);
CREATE INDEX IF NOT EXISTS forecast_results_run_at ON insights.forecast_results(run_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- Read-only user for NL→SQL chat queries
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wren_insights_ro') THEN
    -- NOTE: set a strong password at apply time; do not commit the real value.
    CREATE USER wren_insights_ro WITH PASSWORD 'CHANGE_ME_AT_APPLY_TIME';
  END IF;
END $$;

GRANT CONNECT ON DATABASE wren TO wren_insights_ro;
GRANT USAGE ON SCHEMA ladn TO wren_insights_ro;
GRANT USAGE ON SCHEMA demo_eyfs TO wren_insights_ro;
GRANT USAGE ON SCHEMA insights TO wren_insights_ro;
GRANT USAGE ON SCHEMA insights_staging TO wren_insights_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA demo_eyfs TO wren_insights_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA insights TO wren_insights_ro;

-- Selective grants on ladn schema (never safeguarding, medicine, pins)
DO $$
DECLARE
  t text;
  blocked_tables text[] := ARRAY[
    'safeguarding_concerns','medicine_records','protected_staff_pins',
    'message_audit','parent_portal_access','staff_performance_flags',
    'surveillance_confirmations'
  ];
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'ladn' AND table_type = 'BASE TABLE'
  LOOP
    IF NOT (t = ANY(blocked_tables)) THEN
      EXECUTE format('GRANT SELECT ON ladn.%I TO wren_insights_ro', t);
    END IF;
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Queryable tables safelist seed
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO insights.queryable_tables
  (schema_name, table_name, display_name, category, blocked_columns, description)
VALUES
  ('ladn','observations',   'Observations',      'quality',    ARRAY['staff_notes'],
   'Child observations written by staff'),
  ('ladn','staff',          'Staff',             'staff',
   ARRAY['pin_hash','ni_number','dbs_number','totp_secret','totp_last_used','email','phone','address_line1','address_line2','postcode','date_of_birth','emergency_contact_name','emergency_contact_phone'],
   'Staff members (sensitive fields blocked)'),
  ('ladn','children',       'Children',          'children',
   ARRAY[''],
   'Children enrolled'),
  ('ladn','attendance',     'Attendance',        'children',   ARRAY[]::text[],
   'Daily attendance records'),
  ('ladn','absence_requests','Absence Requests', 'staff',      ARRAY['notes']::text[],
   'Staff absence and holiday requests'),
  ('ladn','staff_clock_events','Clock Events',   'staff',      ARRAY[]::text[],
   'Staff clock-in/out events'),
  ('ladn','cpd_records',    'CPD Records',       'staff',      ARRAY[]::text[],
   'Continuing professional development'),
  ('ladn','supervisions',   'Supervisions',      'staff',      ARRAY['notes']::text[],
   'Staff supervision records'),
  ('ladn','invoices',       'Invoices',          'finance',    ARRAY['bill_payer_email','tfc_reference']::text[],
   'Parent invoices'),
  ('ladn','daily_diary',    'Daily Diary',       'children',   ARRAY[]::text[],
   'Daily diary entries (food, sleep, nappies, mood)'),
  ('ladn','incidents',      'Incidents',         'operations', ARRAY[]::text[],
   'Incident log'),
  ('ladn','enquiries',      'Enquiries',         'children',   ARRAY['bill_payer_email','parent_email']::text[],
   'Admissions enquiries'),
  ('ladn','rooms',          'Rooms',             'operations', ARRAY[]::text[],
   'Room configuration'),
  ('ladn','repairs',        'Repairs',           'operations', ARRAY[]::text[],
   'Repair and maintenance requests'),
  ('demo_eyfs','observations','Demo Observations','quality',   ARRAY['staff_notes']::text[],
   'Demo EYFS observations'),
  ('demo_eyfs','staff',     'Demo Staff',        'staff',
   ARRAY['pin_hash','ni_number','dbs_number','totp_secret','email','phone'],
   'Demo staff'),
  ('demo_eyfs','children',  'Demo Children',     'children',   ARRAY[]::text[],
   'Demo children'),
  ('demo_eyfs','attendance','Demo Attendance',   'children',   ARRAY[]::text[],
   'Demo attendance')
ON CONFLICT (schema_name, table_name) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- Metric definitions seed — 55 metrics
-- ────────────────────────────────────────────────────────────────────────────

-- STAFF METRICS ──────────────────────────────────────────────────────────────

INSERT INTO insights.metric_definitions
  (name, category, edition, sql_template, chart_type, refresh_cadence,
   rag_thresholds, description, insight_template, sort_order)
VALUES

('Bradford Factor Leaderboard', 'staff', ARRAY['eyfs','primary','secondary'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name, s.role,
  COUNT(DISTINCT ar.id) AS absence_count,
  COALESCE(SUM(ar.days_count),0) AS total_days,
  (COUNT(DISTINCT ar.id)^2 * COALESCE(SUM(ar.days_count),0))::numeric(10,1) AS bradford_score
FROM {schema}.staff s
LEFT JOIN {schema}.absence_requests ar
  ON ar.staff_id = s.id
  AND ar.absence_type = 'sick'
  AND ar.status = 'approved'
  AND ar.start_date >= CURRENT_DATE - INTERVAL '52 weeks'
WHERE s.is_active = TRUE
GROUP BY s.id, s.first_name, s.last_name, s.role
ORDER BY bradford_score DESC
LIMIT 20$$,
'table', 'weekly',
'{"green": "<50", "amber": "50-450", "red": ">450"}',
'Bradford Factor ranking — last 52 weeks. Score = (number of absences)² × total days.',
'Top Bradford score this year is {top_score} for {top_name}.',
10),

('Staff Headcount by Role', 'staff', ARRAY['eyfs','primary','secondary'],
$$SELECT role, COUNT(*) AS headcount
FROM {schema}.staff
WHERE is_active = TRUE
GROUP BY role ORDER BY headcount DESC$$,
'bar', 'daily', NULL,
'Active staff split by role.',
'You have {total} active staff across {roles} roles.',
11),

('Sick Days by Month (last 12 months)', 'staff', ARRAY['eyfs','primary','secondary'],
$$SELECT TO_CHAR(start_date,'Mon YYYY') AS month,
  DATE_TRUNC('month', start_date) AS month_ts,
  COUNT(*) AS absence_count,
  COALESCE(SUM(days_count),0)::numeric(10,1) AS total_days
FROM {schema}.absence_requests
WHERE absence_type = 'sick'
  AND status = 'approved'
  AND start_date >= CURRENT_DATE - INTERVAL '12 months'
GROUP BY TO_CHAR(start_date,'Mon YYYY'), DATE_TRUNC('month', start_date)
ORDER BY month_ts$$,
'line', 'daily', NULL,
'Monthly sick day totals for the last 12 months.',
'This month so far: {current_month_days} sick days across {current_month_count} absences.',
12),

('Sick Days by Day of Week', 'staff', ARRAY['eyfs','primary','secondary'],
$$SELECT TO_CHAR(start_date,'Day') AS day_name,
  EXTRACT(DOW FROM start_date) AS dow,
  COUNT(*) AS absence_count
FROM {schema}.absence_requests
WHERE absence_type = 'sick'
  AND status = 'approved'
  AND start_date >= CURRENT_DATE - INTERVAL '52 weeks'
GROUP BY TO_CHAR(start_date,'Day'), EXTRACT(DOW FROM start_date)
ORDER BY dow$$,
'bar', 'weekly', NULL,
'Sick absences by day of week — last 52 weeks. Monday/Friday spikes are a common pattern.',
'Most common sick day: {top_day} with {top_count} absences.',
13),

('Annual Leave Booked by Month', 'staff', ARRAY['eyfs','primary','secondary'],
$$SELECT TO_CHAR(start_date,'Mon YYYY') AS month,
  DATE_TRUNC('month', start_date) AS month_ts,
  COUNT(*) AS bookings,
  COALESCE(SUM(days_count),0)::numeric(10,1) AS total_days
FROM {schema}.absence_requests
WHERE absence_type IN ('holiday','annual_leave')
  AND status = 'approved'
  AND start_date >= CURRENT_DATE - INTERVAL '12 months'
GROUP BY TO_CHAR(start_date,'Mon YYYY'), DATE_TRUNC('month', start_date)
ORDER BY month_ts$$,
'bar', 'daily', NULL,
'Approved holiday bookings by month — useful for spotting August pile-ups.',
'{month} is busiest for holiday with {top_days} days booked.',
14),

('CPD Hours per Staff vs 30hr Target', 'staff', ARRAY['eyfs','primary','secondary'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  COALESCE(SUM(CASE WHEN c.completed_date >= DATE_TRUNC('year', CURRENT_DATE) THEN c.duration_hours ELSE 0 END),0)::numeric(10,1) AS hours_this_year,
  30 AS target_hours,
  ROUND(COALESCE(SUM(CASE WHEN c.completed_date >= DATE_TRUNC('year', CURRENT_DATE) THEN c.duration_hours ELSE 0 END),0) / 30.0 * 100) AS pct_complete
FROM {schema}.staff s
LEFT JOIN {schema}.cpd_records c ON c.staff_id = s.id
WHERE s.is_active = TRUE
GROUP BY s.id, s.first_name, s.last_name
ORDER BY hours_this_year DESC$$,
'bar', 'weekly',
'{"green": ">=30", "amber": "15-29", "red": "<15"}',
'CPD hours this year per staff vs 30-hour annual target.',
'{below_target} staff members are below the 30hr CPD target for this year.',
15),

('Late Clock-ins (last 30 days)', 'staff', ARRAY['eyfs','primary','secondary'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  COUNT(*) AS late_count,
  MAX(ce.event_time::time) AS latest_clock_in
FROM {schema}.staff_clock_events ce
JOIN {schema}.staff s ON s.id = ce.staff_id
WHERE ce.event_type = 'clock_in'
  AND ce.event_time >= CURRENT_DATE - INTERVAL '30 days'
  AND ce.event_time::time > '08:05:00'
GROUP BY s.id, s.first_name, s.last_name
HAVING COUNT(*) > 0
ORDER BY late_count DESC$$,
'table', 'daily', NULL,
'Staff who clocked in after 08:05 in the last 30 days.',
'{late_staff} staff members had {total_lates} late clock-ins in the last 30 days.',
16),

('Mandatory Training Expiring Within 90 Days', 'staff', ARRAY['eyfs','primary','secondary'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  s.role,
  s.dbs_expiry AS dbs_expires,
  CASE WHEN s.dbs_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + 90 THEN 'DBS expiring' ELSE NULL END AS dbs_flag,
  (CURRENT_DATE - s.contract_start) / 365 AS years_employed
FROM {schema}.staff s
WHERE s.is_active = TRUE
  AND s.dbs_expiry IS NOT NULL
  AND s.dbs_expiry <= CURRENT_DATE + 90
ORDER BY s.dbs_expiry ASC$$,
'table', 'daily',
'{"green": ">90 days", "amber": "31-90 days", "red": "<=30 days"}',
'Staff with mandatory training or DBS checks expiring in the next 90 days.',
'{expiring_count} staff have training or DBS expiring in the next 90 days — action required.',
17),

('Absence Rate by Staff (last 12 months)', 'staff', ARRAY['eyfs','primary','secondary'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  s.role,
  COALESCE(SUM(ar.days_count) FILTER (WHERE ar.absence_type='sick'),0)::numeric(10,1) AS sick_days,
  COALESCE(SUM(ar.days_count) FILTER (WHERE ar.absence_type IN ('holiday','annual_leave')),0)::numeric(10,1) AS holiday_days,
  COALESCE(s.contracted_hours / 5.0 * 52, 260) AS working_days_pa,
  ROUND(COALESCE(SUM(ar.days_count) FILTER (WHERE ar.absence_type='sick'),0) / NULLIF(COALESCE(s.contracted_hours / 5.0 * 52, 260),0) * 100, 1) AS sick_rate_pct
FROM {schema}.staff s
LEFT JOIN {schema}.absence_requests ar
  ON ar.staff_id = s.id AND ar.status = 'approved'
  AND ar.start_date >= CURRENT_DATE - INTERVAL '12 months'
WHERE s.is_active = TRUE
GROUP BY s.id, s.first_name, s.last_name, s.role, s.contracted_hours
ORDER BY sick_rate_pct DESC NULLS LAST$$,
'table', 'weekly', NULL,
'Sick and holiday days per staff member in the last 12 months.',
'Team average sick rate: {avg_sick_rate}% — sector benchmark is ~2.5%.',
18),

('Supervisions Completed This Term', 'staff', ARRAY['eyfs','primary','secondary'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  s.role,
  COUNT(sv.id) AS supervisions_completed,
  MAX(sv.scheduled_date) AS last_supervision,
  CASE WHEN MAX(sv.scheduled_date) < CURRENT_DATE - 90 THEN 'overdue' ELSE 'ok' END AS status
FROM {schema}.staff s
LEFT JOIN {schema}.supervisions sv
  ON sv.staff_id = s.id
  AND sv.status = 'completed'
  AND sv.scheduled_date >= DATE_TRUNC('quarter', CURRENT_DATE)
WHERE s.is_active = TRUE AND s.role != 'manager'
GROUP BY s.id, s.first_name, s.last_name, s.role
ORDER BY supervisions_completed ASC, s.last_name$$,
'table', 'weekly',
'{"green": ">=1", "amber": "0 but recent", "red": "0 and overdue"}',
'Supervisions completed for each staff member this quarter.',
'{overdue_count} staff members have not had a supervision this quarter.',
19),

-- QUALITY CONTROL METRICS ─────────────────────────────────────────────────────

('Observation Count per Staff (last 4 weeks)', 'quality', ARRAY['eyfs'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  s.role,
  COUNT(o.id) AS observation_count,
  ROUND(AVG(LENGTH(o.observation_text)),0)::integer AS avg_word_approx,
  COUNT(o.id) FILTER (WHERE array_length(o.photo_urls,1) > 0) AS with_photos
FROM {schema}.staff s
LEFT JOIN {schema}.observations o
  ON o.staff_id = s.id
  AND o.created_at >= CURRENT_DATE - INTERVAL '4 weeks'
WHERE s.is_active = TRUE
GROUP BY s.id, s.first_name, s.last_name, s.role
ORDER BY observation_count DESC$$,
'bar', 'daily',
'{"green": ">=20", "amber": "10-19", "red": "<10"}',
'Observations written per staff member in the last 4 weeks.',
'Team total: {total_obs} observations in 4 weeks. Average per staff: {avg_obs}.',
20),

('Days Staff Came In But Wrote No Observations', 'quality', ARRAY['eyfs'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  COUNT(DISTINCT ce.event_time::date) AS days_worked,
  COUNT(DISTINCT o.created_at::date) AS days_with_obs,
  COUNT(DISTINCT ce.event_time::date) - COUNT(DISTINCT o.created_at::date) AS no_obs_days
FROM {schema}.staff s
LEFT JOIN {schema}.staff_clock_events ce
  ON ce.staff_id = s.id AND ce.event_type = 'clock_in'
  AND ce.event_time >= DATE_TRUNC('term', CURRENT_DATE)
  AND ce.event_time >= CURRENT_DATE - INTERVAL '13 weeks'
LEFT JOIN {schema}.observations o
  ON o.staff_id = s.id
  AND o.created_at::date = ce.event_time::date
WHERE s.is_active = TRUE
GROUP BY s.id, s.first_name, s.last_name
HAVING COUNT(DISTINCT ce.event_time::date) > 0
ORDER BY no_obs_days DESC$$,
'table', 'daily',
'{"green": "<5", "amber": "5-10", "red": ">10"}',
'Days each staff member clocked in but wrote zero observations this term. Key QC metric.',
'{top_name} has {top_no_obs} days this term with no observations written.',
21),

('Longest No-Observation Streak per Staff', 'quality', ARRAY['eyfs'],
$$WITH date_series AS (
  SELECT generate_series(
    CURRENT_DATE - INTERVAL '90 days',
    CURRENT_DATE,
    '1 day'::interval
  )::date AS d
),
obs_days AS (
  SELECT staff_id, created_at::date AS obs_date
  FROM {schema}.observations
  WHERE created_at >= CURRENT_DATE - INTERVAL '90 days'
  GROUP BY staff_id, created_at::date
),
staff_dates AS (
  SELECT s.id AS staff_id, s.first_name || ' ' || s.last_name AS staff_name, ds.d
  FROM {schema}.staff s CROSS JOIN date_series ds
  WHERE s.is_active = TRUE AND EXTRACT(DOW FROM ds.d) BETWEEN 1 AND 5
),
with_flag AS (
  SELECT sd.staff_id, sd.staff_name, sd.d,
    CASE WHEN od.obs_date IS NULL THEN 0 ELSE 1 END AS has_obs
  FROM staff_dates sd
  LEFT JOIN obs_days od ON od.staff_id = sd.staff_id AND od.obs_date = sd.d
)
SELECT staff_name,
  MAX(streak_len) AS longest_no_obs_streak
FROM (
  SELECT staff_id, staff_name, d,
    ROW_NUMBER() OVER (PARTITION BY staff_id ORDER BY d)
    - ROW_NUMBER() OVER (PARTITION BY staff_id, has_obs ORDER BY d) AS grp,
    has_obs
  FROM with_flag
) g
JOIN LATERAL (
  SELECT COUNT(*) AS streak_len FROM with_flag w2
  WHERE w2.staff_id = g.staff_id AND w2.d = g.d AND g.has_obs = 0
) sl ON g.has_obs = 0
GROUP BY staff_id, staff_name
ORDER BY longest_no_obs_streak DESC$$,
'table', 'daily', NULL,
'Longest run of consecutive working days with no observations — last 90 days.',
'Longest no-observation streak: {top_name} — {top_streak} consecutive days.',
22),

('Average Observation Length by Staff (last 4 weeks)', 'quality', ARRAY['eyfs'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  COUNT(o.id) AS obs_count,
  ROUND(AVG(
    array_length(string_to_array(trim(o.observation_text), ' '), 1)
  ))::integer AS avg_words,
  MIN(array_length(string_to_array(trim(o.observation_text), ' '), 1)) AS min_words,
  MAX(array_length(string_to_array(trim(o.observation_text), ' '), 1)) AS max_words
FROM {schema}.staff s
JOIN {schema}.observations o ON o.staff_id = s.id
  AND o.created_at >= CURRENT_DATE - INTERVAL '4 weeks'
  AND o.observation_text IS NOT NULL AND trim(o.observation_text) != ''
WHERE s.is_active = TRUE
GROUP BY s.id, s.first_name, s.last_name
HAVING COUNT(o.id) >= 3
ORDER BY avg_words DESC$$,
'bar', 'daily',
'{"green": ">=80", "amber": "40-79", "red": "<40"}',
'Average word count per observation by staff member — tracks observation quality/depth.',
'Team average observation length: {team_avg} words. Target: 80+ words.',
23),

('Observation Timing Distribution by Staff', 'quality', ARRAY['eyfs'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  EXTRACT(HOUR FROM o.created_at) AS hour_of_day,
  COUNT(*) AS obs_count
FROM {schema}.staff s
JOIN {schema}.observations o ON o.staff_id = s.id
  AND o.created_at >= CURRENT_DATE - INTERVAL '8 weeks'
WHERE s.is_active = TRUE
GROUP BY s.id, s.first_name, s.last_name, EXTRACT(HOUR FROM o.created_at)
ORDER BY s.last_name, hour_of_day$$,
'heatmap', 'weekly', NULL,
'When during the day each staff member writes observations. Useful for spotting after-hours writing.',
'{after_hours_pct}% of observations are written after 7pm — may indicate backlog writing.',
24),

('After-Hours Observation Rate', 'quality', ARRAY['eyfs'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  COUNT(*) AS total_obs,
  COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM o.created_at) >= 19) AS after_7pm,
  ROUND(COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM o.created_at) >= 19)::numeric
        / NULLIF(COUNT(*),0) * 100, 1) AS after_hours_pct
FROM {schema}.staff s
JOIN {schema}.observations o ON o.staff_id = s.id
  AND o.created_at >= CURRENT_DATE - INTERVAL '8 weeks'
WHERE s.is_active = TRUE
GROUP BY s.id, s.first_name, s.last_name
ORDER BY after_hours_pct DESC$$,
'bar', 'weekly',
'{"green": "<20%", "amber": "20-40%", "red": ">40%"}',
'Percentage of observations written after 7pm per staff — high % suggests backlog catch-up.',
'{top_after_hours_name} writes {top_pct}% of observations after 7pm.',
25),

('Observation EYFS Area Coverage', 'quality', ARRAY['eyfs'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  COUNT(o.id) AS total_obs,
  ROUND(AVG(array_length(o.eyfs_areas, 1)), 1) AS avg_areas_linked,
  COUNT(*) FILTER (WHERE array_length(o.eyfs_areas,1) = 0 OR o.eyfs_areas IS NULL) AS no_areas_linked
FROM {schema}.staff s
JOIN {schema}.observations o ON o.staff_id = s.id
  AND o.created_at >= CURRENT_DATE - INTERVAL '8 weeks'
WHERE s.is_active = TRUE
GROUP BY s.id, s.first_name, s.last_name
ORDER BY avg_areas_linked DESC$$,
'bar', 'weekly',
'{"green": ">=2", "amber": "1-2", "red": "<1"}',
'Average number of EYFS framework areas linked per observation — measures observation depth.',
'Team average EYFS areas per observation: {team_avg}. Observations with no areas: {no_areas}.',
26),

('Photo Quality — Observations with Photos', 'quality', ARRAY['eyfs'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  COUNT(o.id) AS total_obs,
  COUNT(*) FILTER (WHERE array_length(o.photo_urls,1) > 0) AS with_photos,
  ROUND(COUNT(*) FILTER (WHERE array_length(o.photo_urls,1) > 0)::numeric
        / NULLIF(COUNT(o.id),0) * 100, 1) AS photo_pct,
  ROUND(AVG(COALESCE(array_length(o.photo_urls,1),0)),1) AS avg_photos_per_obs
FROM {schema}.staff s
JOIN {schema}.observations o ON o.staff_id = s.id
  AND o.created_at >= CURRENT_DATE - INTERVAL '4 weeks'
WHERE s.is_active = TRUE
GROUP BY s.id, s.first_name, s.last_name
ORDER BY photo_pct DESC$$,
'bar', 'daily', NULL,
'Percentage of observations that include at least one photo per staff member.',
'{photo_pct}% of observations this month include photos. Target: >60%.',
27),

-- CHILDREN METRICS ────────────────────────────────────────────────────────────

('Observation Count per Child (last 4 weeks)', 'children', ARRAY['eyfs'],
$$SELECT c.first_name || ' ' || c.last_name AS child_name,
  r.name AS room,
  COUNT(o.id) AS observation_count,
  CASE WHEN COUNT(o.id) >= 4 THEN 'green'
       WHEN COUNT(o.id) >= 2 THEN 'amber'
       ELSE 'red' END AS rag
FROM {schema}.children c
LEFT JOIN {schema}.rooms r ON r.id = c.room_id
LEFT JOIN {schema}.observations o ON o.child_id = c.id
  AND o.created_at >= CURRENT_DATE - INTERVAL '4 weeks'
WHERE c.is_active = TRUE
GROUP BY c.id, c.first_name, c.last_name, r.name
ORDER BY observation_count ASC$$,
'table', 'daily',
'{"green": ">=4", "amber": "2-3", "red": "0-1"}',
'Observation count per child in the last 4 weeks. Target: 4+/month.',
'{red_count} children have fewer than 2 observations in the last 4 weeks — review needed.',
30),

('Attendance Rate per Child (last 4 weeks)', 'children', ARRAY['eyfs'],
$$SELECT c.first_name || ' ' || c.last_name AS child_name,
  r.name AS room,
  COUNT(a.id) FILTER (WHERE a.status = 'present') AS days_present,
  COUNT(a.id) AS days_registered,
  ROUND(COUNT(a.id) FILTER (WHERE a.status = 'present')::numeric
        / NULLIF(COUNT(a.id),0) * 100, 1) AS attendance_pct
FROM {schema}.children c
LEFT JOIN {schema}.rooms r ON r.id = c.room_id
LEFT JOIN {schema}.attendance a ON a.child_id = c.id
  AND a.date >= CURRENT_DATE - INTERVAL '4 weeks'
WHERE c.is_active = TRUE
GROUP BY c.id, c.first_name, c.last_name, r.name
HAVING COUNT(a.id) > 0
ORDER BY attendance_pct ASC$$,
'table', 'daily',
'{"green": ">=90%", "amber": "75-89%", "red": "<75%"}',
'Attendance percentage per child in the last 4 weeks.',
'{low_attendance_count} children have attendance below 75% — may warrant parent contact.',
31),

('Age Distribution of Children', 'children', ARRAY['eyfs'],
$$SELECT
  CASE
    WHEN EXTRACT(YEAR FROM AGE(c.date_of_birth)) = 0 THEN 'Under 1'
    WHEN EXTRACT(YEAR FROM AGE(c.date_of_birth)) = 1 THEN '1 year'
    WHEN EXTRACT(YEAR FROM AGE(c.date_of_birth)) = 2 THEN '2 years'
    WHEN EXTRACT(YEAR FROM AGE(c.date_of_birth)) = 3 THEN '3 years'
    WHEN EXTRACT(YEAR FROM AGE(c.date_of_birth)) = 4 THEN '4 years'
    ELSE '5+ years'
  END AS age_group,
  r.name AS room,
  COUNT(*) AS child_count
FROM {schema}.children c
LEFT JOIN {schema}.rooms r ON r.id = c.room_id
WHERE c.is_active = TRUE AND c.date_of_birth IS NOT NULL
GROUP BY age_group, r.name
ORDER BY r.name, age_group$$,
'bar', 'daily', NULL,
'Children by age group and room.',
'{total_children} children enrolled across {rooms} rooms.',
32),

('Children with No Next Steps Written', 'children', ARRAY['eyfs'],
$$SELECT c.first_name || ' ' || c.last_name AS child_name,
  r.name AS room,
  MAX(o.created_at) AS last_obs_date,
  CURRENT_DATE - MAX(o.created_at)::date AS days_since_last_obs
FROM {schema}.children c
LEFT JOIN {schema}.rooms r ON r.id = c.room_id
LEFT JOIN {schema}.observations o ON o.child_id = c.id
  AND (o.next_steps IS NULL OR trim(o.next_steps) = '')
WHERE c.is_active = TRUE
GROUP BY c.id, c.first_name, c.last_name, r.name
HAVING MAX(o.created_at) IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM {schema}.observations o2
      WHERE o2.child_id = c.id
        AND o2.next_steps IS NOT NULL AND trim(o2.next_steps) != ''
        AND o2.created_at >= CURRENT_DATE - INTERVAL '8 weeks'
    )
ORDER BY days_since_last_obs DESC NULLS LAST$$,
'table', 'daily',
'{"green": "0", "amber": "1-5", "red": ">5"}',
'Children with no next-steps written in the last 8 weeks.',
'{count} children have had no next steps written in the last 8 weeks.',
33),

('Key Person Observation Distribution', 'children', ARRAY['eyfs'],
$$SELECT s.first_name || ' ' || s.last_name AS key_person,
  COUNT(DISTINCT o.child_id) AS children_observed,
  COUNT(o.id) AS total_observations,
  ROUND(COUNT(o.id)::numeric / NULLIF(COUNT(DISTINCT o.child_id),0), 1) AS obs_per_child
FROM {schema}.staff s
JOIN {schema}.observations o ON o.staff_id = s.id
  AND o.created_at >= CURRENT_DATE - INTERVAL '4 weeks'
WHERE s.is_active = TRUE
GROUP BY s.id, s.first_name, s.last_name
ORDER BY total_observations DESC$$,
'bar', 'daily', NULL,
'How many children each staff member is observing — reveals distribution issues.',
'Observation range: {min_obs} to {max_obs} per key person. Uneven distribution flags workload issues.',
34),

('Rooms Occupancy vs Ratio', 'children', ARRAY['eyfs'],
$$SELECT r.name AS room,
  r.capacity,
  COUNT(c.id) AS enrolled_children,
  ROUND(COUNT(c.id)::numeric / NULLIF(r.capacity,0) * 100, 1) AS occupancy_pct
FROM {schema}.rooms r
LEFT JOIN {schema}.children c ON c.room_id = r.id AND c.is_active = TRUE
GROUP BY r.id, r.name, r.capacity
ORDER BY r.name$$,
'bar', 'daily',
'{"green": "<85%", "amber": "85-95%", "red": ">=95%"}',
'Room occupancy as a percentage of maximum capacity.',
'{over_capacity_rooms} rooms are above 85% occupancy.',
35),

('Daily Diary Completion Rate (last 2 weeks)', 'children', ARRAY['eyfs'],
$$SELECT c.first_name || ' ' || c.last_name AS child_name,
  COUNT(DISTINCT a.date) FILTER (WHERE a.status = 'present') AS days_present,
  COUNT(DISTINCT dd.date) AS diary_entries,
  CASE
    WHEN COUNT(DISTINCT a.date) FILTER (WHERE a.status = 'present') = 0 THEN NULL
    ELSE ROUND(COUNT(DISTINCT dd.date)::numeric
               / COUNT(DISTINCT a.date) FILTER (WHERE a.status = 'present') * 100)
  END AS completion_pct
FROM {schema}.children c
LEFT JOIN {schema}.attendance a ON a.child_id = c.id
  AND a.date >= CURRENT_DATE - INTERVAL '2 weeks'
LEFT JOIN {schema}.daily_diary dd ON dd.child_id = c.id
  AND dd.date >= CURRENT_DATE - INTERVAL '2 weeks'
WHERE c.is_active = TRUE
GROUP BY c.id, c.first_name, c.last_name
ORDER BY completion_pct ASC NULLS LAST$$,
'table', 'daily',
'{"green": "100%", "amber": "75-99%", "red": "<75%"}',
'Percentage of days attended that have a diary entry completed.',
'{missing_diary} children are missing diary entries for attended days.',
36),

-- FINANCE METRICS ─────────────────────────────────────────────────────────────

('Invoice Status Summary', 'finance', ARRAY['eyfs','primary','secondary'],
$$SELECT status,
  COUNT(*) AS invoice_count,
  ROUND(SUM(amount_pence)::numeric / 100, 2) AS total_value_gbp
FROM {schema}.invoices
WHERE issued_on >= CURRENT_DATE - INTERVAL '6 months'
GROUP BY status
ORDER BY total_value_gbp DESC$$,
'bar', 'daily', NULL,
'Invoice count and value by status for the last 6 months.',
'Outstanding invoices: £{outstanding_total}. Overdue: £{overdue_total}.',
40),

('Outstanding Balance Aged Buckets', 'finance', ARRAY['eyfs','primary','secondary'],
$$SELECT
  CASE
    WHEN due_on >= CURRENT_DATE THEN 'Not yet due'
    WHEN CURRENT_DATE - due_on <= 30 THEN '1-30 days overdue'
    WHEN CURRENT_DATE - due_on <= 60 THEN '31-60 days overdue'
    WHEN CURRENT_DATE - due_on <= 90 THEN '61-90 days overdue'
    ELSE '90+ days overdue'
  END AS bucket,
  COUNT(*) AS invoice_count,
  ROUND(SUM(amount_pence)::numeric / 100, 2) AS total_gbp
FROM {schema}.invoices
WHERE status IN ('pending','overdue','sent')
GROUP BY bucket
ORDER BY
  CASE bucket
    WHEN '90+ days overdue' THEN 1
    WHEN '61-90 days overdue' THEN 2
    WHEN '31-60 days overdue' THEN 3
    WHEN '1-30 days overdue' THEN 4
    ELSE 5
  END$$,
'bar', 'daily',
'{"green": "0 overdue", "amber": "1-30 days", "red": ">30 days"}',
'Outstanding invoices grouped by overdue age. £90+ bucket is highest risk.',
'Total outstanding: £{total}. {overdue_count} invoices are overdue.',
41),

('Monthly Revenue (last 12 months)', 'finance', ARRAY['eyfs','primary','secondary'],
$$SELECT TO_CHAR(paid_on,'Mon YYYY') AS month,
  DATE_TRUNC('month', paid_on) AS month_ts,
  COUNT(*) AS paid_count,
  ROUND(SUM(amount_pence)::numeric / 100, 2) AS revenue_gbp
FROM {schema}.invoices
WHERE status = 'paid'
  AND paid_on >= CURRENT_DATE - INTERVAL '12 months'
GROUP BY TO_CHAR(paid_on,'Mon YYYY'), DATE_TRUNC('month', paid_on)
ORDER BY month_ts$$,
'line', 'daily', NULL,
'Monthly revenue from paid invoices — last 12 months.',
'Best revenue month: {best_month} at £{best_amount}. This month so far: £{this_month}.',
42),

('Payment Method Mix', 'finance', ARRAY['eyfs','primary','secondary'],
$$SELECT COALESCE(payment_method, 'unknown') AS payment_method,
  COUNT(*) AS count,
  ROUND(SUM(amount_pence)::numeric / 100, 2) AS total_gbp
FROM {schema}.invoices
WHERE status = 'paid'
  AND paid_on >= CURRENT_DATE - INTERVAL '6 months'
GROUP BY COALESCE(payment_method, 'unknown')
ORDER BY total_gbp DESC$$,
'bar', 'daily', NULL,
'Payment method breakdown for paid invoices in the last 6 months.',
'{top_method} is the most common payment method at {top_pct}% of transactions.',
43),

('Average Days to Pay Invoice', 'finance', ARRAY['eyfs','primary','secondary'],
$$SELECT
  ROUND(AVG(paid_on - due_on)) AS avg_days_to_pay,
  COUNT(*) FILTER (WHERE paid_on < due_on) AS paid_early,
  COUNT(*) FILTER (WHERE paid_on = due_on) AS paid_on_time,
  COUNT(*) FILTER (WHERE paid_on > due_on) AS paid_late,
  ROUND(AVG(paid_on - due_on) FILTER (WHERE paid_on > due_on)) AS avg_days_late
FROM {schema}.invoices
WHERE status = 'paid'
  AND paid_on IS NOT NULL
  AND due_on IS NOT NULL
  AND paid_on >= CURRENT_DATE - INTERVAL '6 months'$$,
'number', 'weekly', NULL,
'Average days between invoice due date and actual payment.',
'Average payment lag: {avg_days} days. {late_pct}% of invoices paid late.',
44),

('Weekly Invoice Issuance Trend', 'finance', ARRAY['eyfs','primary','secondary'],
$$SELECT DATE_TRUNC('week', issued_on) AS week_start,
  COUNT(*) AS issued_count,
  ROUND(SUM(amount_pence)::numeric / 100, 2) AS total_gbp
FROM {schema}.invoices
WHERE issued_on >= CURRENT_DATE - INTERVAL '12 weeks'
GROUP BY DATE_TRUNC('week', issued_on)
ORDER BY week_start$$,
'line', 'weekly', NULL,
'Weekly invoice issuance count and value for the last 12 weeks.',
'Last week: {last_week_count} invoices issued totalling £{last_week_total}.',
45),

-- OPERATIONS METRICS ──────────────────────────────────────────────────────────

('Active Staff vs Regulatory Ratio', 'operations', ARRAY['eyfs'],
$$SELECT r.name AS room,
  COUNT(DISTINCT c.id) AS children_enrolled,
  COUNT(DISTINCT sc.staff_id) FILTER (
    WHERE sc.event_type = 'clock_in'
    AND sc.event_time::date = CURRENT_DATE
  ) AS staff_on_site_today,
  r.capacity,
  ROUND(COUNT(DISTINCT c.id)::numeric /
    NULLIF(COUNT(DISTINCT sc.staff_id) FILTER (
      WHERE sc.event_type = 'clock_in' AND sc.event_time::date = CURRENT_DATE
    ), 0), 1) AS children_per_staff
FROM {schema}.rooms r
LEFT JOIN {schema}.children c ON c.room_id = r.id AND c.is_active = TRUE
LEFT JOIN {schema}.staff s ON s.room_id = r.id AND s.is_active = TRUE
LEFT JOIN {schema}.staff_clock_events sc ON sc.staff_id = s.id
GROUP BY r.id, r.name, r.capacity
ORDER BY r.name$$,
'table', 'realtime', NULL,
'Current children-per-staff ratio by room. Statutory EYFS ratio: Baby 1:3, Pre-school 1:8.',
'Current ratio check: {ratio_status}.',
50),

('Repair and Maintenance Backlog', 'operations', ARRAY['eyfs','primary','secondary'],
$$SELECT status,
  COUNT(*) AS count,
  COUNT(*) FILTER (WHERE created_at < CURRENT_DATE - INTERVAL '7 days') AS older_than_7_days
FROM {schema}.repairs
WHERE status != 'completed'
GROUP BY status
ORDER BY count DESC$$,
'table', 'daily',
'{"green": "0 open", "amber": "1-5 open", "red": ">5 open"}',
'Open repair requests by status. Highlights maintenance backlog.',
'{open_repairs} open repairs — {old_repairs} open for more than 7 days.',
51),

('Enquiry Conversion Funnel (last 3 months)', 'children', ARRAY['eyfs'],
$$SELECT
  COUNT(*) AS total_enquiries,
  COUNT(*) FILTER (WHERE status != 'new') AS progressed,
  COUNT(*) FILTER (WHERE status = 'tour_booked') AS tours_booked,
  COUNT(*) FILTER (WHERE status = 'offer_made') AS offers_made,
  COUNT(*) FILTER (WHERE status = 'enrolled') AS enrolled,
  ROUND(COUNT(*) FILTER (WHERE status = 'enrolled')::numeric
        / NULLIF(COUNT(*),0) * 100, 1) AS conversion_rate_pct
FROM {schema}.enquiries
WHERE created_at >= CURRENT_DATE - INTERVAL '3 months'$$,
'number', 'daily',
'{"green": ">20%", "amber": "10-20%", "red": "<10%"}',
'Enquiry-to-enrolment conversion funnel for the last 3 months.',
'Conversion rate: {conversion_pct}%. {enrolled} children enrolled from {total} enquiries.',
52),

('Enquiry Source Distribution', 'children', ARRAY['eyfs'],
$$SELECT COALESCE(source, 'unknown') AS source,
  COUNT(*) AS count,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER () * 100, 1) AS pct
FROM {schema}.enquiries
WHERE created_at >= CURRENT_DATE - INTERVAL '6 months'
GROUP BY COALESCE(source, 'unknown')
ORDER BY count DESC$$,
'bar', 'weekly', NULL,
'Where enquiries are coming from in the last 6 months.',
'Top referral source: {top_source} at {top_pct}% of enquiries.',
53),

('Clock-In Summary Today', 'staff', ARRAY['eyfs','primary','secondary'],
$$SELECT s.first_name || ' ' || s.last_name AS staff_name,
  MIN(ce.event_time) FILTER (WHERE ce.event_type = 'clock_in') AS clocked_in_at,
  MAX(ce.event_time) FILTER (WHERE ce.event_type = 'clock_out') AS clocked_out_at,
  ROUND(EXTRACT(EPOCH FROM (
    MAX(ce.event_time) FILTER (WHERE ce.event_type = 'clock_out')
    - MIN(ce.event_time) FILTER (WHERE ce.event_type = 'clock_in')
  )) / 3600.0, 2) AS hours_worked
FROM {schema}.staff s
LEFT JOIN {schema}.staff_clock_events ce
  ON ce.staff_id = s.id AND ce.event_time::date = CURRENT_DATE
WHERE s.is_active = TRUE
GROUP BY s.id, s.first_name, s.last_name
ORDER BY clocked_in_at ASC NULLS LAST$$,
'table', 'realtime', NULL,
'Today''s clock-in summary for all active staff.',
'{on_site_count} staff currently on site.',
54),

('Observation Total This Week', 'quality', ARRAY['eyfs'],
$$SELECT COUNT(*) AS total_observations,
  COUNT(DISTINCT staff_id) AS staff_who_observed,
  COUNT(DISTINCT child_id) AS children_observed,
  ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT staff_id),0), 1) AS avg_per_staff
FROM {schema}.observations
WHERE created_at >= DATE_TRUNC('week', CURRENT_DATE)$$,
'number', 'realtime', NULL,
'Observation totals for the current week.',
'{total_obs} observations this week across {children_obs} children by {staff_obs} staff.',
55)

ON CONFLICT DO NOTHING;

COMMIT;
