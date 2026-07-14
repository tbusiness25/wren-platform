-- Wren integrations schema additions
-- Tables: workflow_templates, parent_permissions_matrix, external_api_tokens, gias_cache, n8n_audit

-- ── Workflow templates ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ladn.wren_workflow_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  edition         TEXT[]  DEFAULT '{}',         -- ['eyfs','primary','secondary']
  category        TEXT,                          -- 'finance','safeguarding','communication','operations'
  trigger_type    TEXT DEFAULT 'manual',         -- 'event','cron','manual'
  trigger_config  JSONB  DEFAULT '{}',
  workflow_json   JSONB  DEFAULT '{}',
  audit_required  BOOLEAN DEFAULT TRUE,
  who_can_run     TEXT DEFAULT 'admin',          -- 'admin','teacher','staff'
  who_can_edit    TEXT DEFAULT 'admin',
  is_builtin      BOOLEAN DEFAULT TRUE,
  enabled_by_default BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ladn.wren_workflow_instances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     UUID REFERENCES ladn.wren_workflow_templates(id) ON DELETE SET NULL,
  school_schema   TEXT NOT NULL DEFAULT 'ladn',
  enabled         BOOLEAN DEFAULT FALSE,
  overrides       JSONB DEFAULT '{}',           -- school-specific param overrides
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ladn.wren_workflow_executions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id     UUID REFERENCES ladn.wren_workflow_instances(id) ON DELETE SET NULL,
  template_name   TEXT,
  triggered_by    TEXT,                         -- 'system','manual:staff_id','event:type'
  triggered_by_staff_id INT,
  status          TEXT DEFAULT 'pending',       -- 'pending','running','success','failed'
  n8n_execution_id TEXT,
  payload         JSONB DEFAULT '{}',
  result          JSONB DEFAULT '{}',
  error           TEXT,
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

-- ── Parent permissions matrix ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ladn.parent_permissions_matrix (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attribute_key       TEXT NOT NULL UNIQUE,
  attribute_label     TEXT NOT NULL,
  category            TEXT,                     -- 'daily','learning','finance','events','communication'
  description         TEXT,
  affects_audiences   TEXT[] DEFAULT '{}',      -- ['portal','api','ics','email']
  default_portal      BOOLEAN DEFAULT TRUE,
  default_api         BOOLEAN DEFAULT FALSE,
  default_ics         BOOLEAN DEFAULT FALSE,
  default_email       BOOLEAN DEFAULT TRUE,
  sort_order          INT DEFAULT 100
);

CREATE TABLE IF NOT EXISTS ladn.parent_permissions_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attribute_key   TEXT NOT NULL REFERENCES ladn.parent_permissions_matrix(attribute_key) ON DELETE CASCADE,
  portal          BOOLEAN,
  api             BOOLEAN,
  ics             BOOLEAN,
  email           BOOLEAN,
  changed_by      INT,                          -- staff.id
  changed_at      TIMESTAMPTZ DEFAULT NOW(),
  reason          TEXT,
  UNIQUE(attribute_key)
);

CREATE TABLE IF NOT EXISTS ladn.parent_permissions_child_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id        INT NOT NULL,
  attribute_key   TEXT NOT NULL REFERENCES ladn.parent_permissions_matrix(attribute_key) ON DELETE CASCADE,
  portal          BOOLEAN,
  api             BOOLEAN,
  changed_by      INT,
  changed_at      TIMESTAMPTZ DEFAULT NOW(),
  reason          TEXT,
  UNIQUE(child_id, attribute_key)
);

-- ── External API tokens (for HA integration) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS ladn.external_api_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      TEXT NOT NULL UNIQUE,         -- sha256 of the actual token
  parent_email    TEXT NOT NULL,
  child_id        INT NOT NULL,
  label           TEXT DEFAULT 'Home Assistant',
  scopes          TEXT[] DEFAULT ARRAY['read_child_data'],
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ext_token_hash ON ladn.external_api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_ext_token_email ON ladn.external_api_tokens(parent_email);

-- ── GIAS school lookup cache ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ladn.gias_cache (
  id              SERIAL PRIMARY KEY,
  cache_key       TEXT NOT NULL UNIQUE,         -- 'postcode:W139LU' or 'urn:123456'
  result_json     JSONB NOT NULL DEFAULT '[]',
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_gias_cache_key ON ladn.gias_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_gias_expires ON ladn.gias_cache(expires_at);

-- ── n8n workflow audit log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ladn.n8n_audit (
  id              BIGSERIAL PRIMARY KEY,
  event_type      TEXT NOT NULL,                -- 'trigger','complete','error'
  workflow_name   TEXT,
  n8n_execution_id TEXT,
  triggered_by    TEXT,
  payload_summary JSONB DEFAULT '{}',
  occurred_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Seed: permission matrix defaults ─────────────────────────────────────────
INSERT INTO ladn.parent_permissions_matrix
  (attribute_key, attribute_label, category, description, affects_audiences,
   default_portal, default_api, default_ics, default_email, sort_order)
VALUES
  -- Daily care
  ('lunch',          'Today''s lunch',              'daily',         'What the child ate for lunch',                     '{"portal","api","email"}', TRUE,  TRUE,  FALSE, TRUE,  10),
  ('nap',            'Nap / sleep record',           'daily',         'Nap start/end times (EYFS)',                       '{"portal","api"}',         TRUE,  TRUE,  FALSE, FALSE, 11),
  ('nappy',          'Nappy changes',                'daily',         'Nappy change log (EYFS under 2)',                  '{"portal","email"}',       TRUE,  FALSE, FALSE, FALSE, 12),
  ('mood',           'Daily mood / wellbeing',       'daily',         'Child''s mood at drop-off and throughout day',     '{"portal","email"}',       TRUE,  FALSE, FALSE, TRUE,  13),
  ('daily_diary',    'Daily diary',                  'daily',         'Full daily diary entry',                           '{"portal","api","email"}', TRUE,  TRUE,  FALSE, TRUE,  14),

  -- Learning
  ('observations',   'Observations',                 'learning',      'Learning observations (text, photo, video)',       '{"portal","api","email"}', TRUE,  TRUE,  FALSE, TRUE,  20),
  ('observations_week_count', 'Observations this week (count)', 'learning', 'Number of observations this week',           '{"api"}',                  FALSE, TRUE,  FALSE, FALSE, 21),
  ('learning_journey','Learning journey',            'learning',      'Full learning journey / portfolio',                '{"portal","email"}',       TRUE,  FALSE, FALSE, FALSE, 22),
  ('next_steps',     'Next steps',                   'learning',      'Practitioner-set next learning goals',             '{"portal","email"}',       TRUE,  FALSE, FALSE, TRUE,  23),
  ('homework_due',   'Homework due',                 'learning',      'Upcoming homework assignments',                    '{"portal","api","email"}', TRUE,  TRUE,  FALSE, TRUE,  24),
  ('behaviour_points','Behaviour points today',      'learning',      'Points awarded today',                             '{"portal","api"}',         TRUE,  FALSE, FALSE, FALSE, 25),

  -- Attendance
  ('attendance',     'Attendance status',            'attendance',    'Present / absent / late',                         '{"portal","api","ics","email"}', TRUE, TRUE, TRUE, TRUE, 30),
  ('attendance_pct', 'Attendance %',                 'attendance',    'Overall attendance percentage',                    '{"portal","api","email"}', TRUE,  TRUE,  FALSE, TRUE,  31),
  ('at_setting',     'Currently at setting (live)',  'attendance',    'Real-time check-in status — privacy-sensitive',    '{"api"}',                  FALSE, FALSE, FALSE, FALSE, 32),

  -- Finance
  ('fees',           'Outstanding fees',             'finance',       'Balance outstanding on account',                  '{"portal","email"}',       TRUE,  FALSE, FALSE, TRUE,  40),
  ('invoices',       'Invoice history',              'finance',       'Full invoice list',                               '{"portal","email"}',       TRUE,  FALSE, FALSE, FALSE, 41),
  ('payments',       'Payment history',              'finance',       'Payments made',                                   '{"portal"}',               TRUE,  FALSE, FALSE, FALSE, 42),

  -- Events & Calendar
  ('next_event',     'Next event',                   'events',        'Upcoming trip, parents evening, etc.',            '{"portal","api","ics","email"}', TRUE, TRUE, TRUE, TRUE, 50),
  ('school_calendar','School calendar',              'events',        'Full school/nursery calendar feed',               '{"portal","ics"}',         TRUE,  FALSE, TRUE,  FALSE, 51),
  ('trip_consent',   'Trip consent status',          'events',        'Outstanding permission slips',                    '{"portal","email"}',       TRUE,  FALSE, FALSE, TRUE,  52),

  -- Communication
  ('messages',       'Messages',                     'communication', 'Parent-staff messaging thread',                   '{"portal","email"}',       TRUE,  FALSE, FALSE, TRUE,  60),
  ('newsletters',    'Newsletters',                  'communication', 'School newsletters',                              '{"portal","email"}',       TRUE,  FALSE, FALSE, FALSE, 61)
ON CONFLICT (attribute_key) DO NOTHING;
