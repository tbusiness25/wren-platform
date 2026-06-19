-- Module definitions — one row per custom module
CREATE TABLE IF NOT EXISTS ladn.modules (
  id              SERIAL PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  icon            TEXT,
  attaches_to     TEXT NOT NULL CHECK (attaches_to IN ('child','staff','parent','standalone','multi')),
  portals         JSONB NOT NULL DEFAULT '[]'::jsonb,
  permissions     JSONB NOT NULL DEFAULT '{}'::jsonb,
  fields          JSONB NOT NULL DEFAULT '[]'::jsonb,
  workflows       JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_prompts      JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INTEGER,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      INTEGER
);
CREATE INDEX IF NOT EXISTS modules_active_idx ON ladn.modules (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS modules_attaches_idx ON ladn.modules (attaches_to);

-- Records submitted against a module
CREATE TABLE IF NOT EXISTS ladn.module_records (
  id              BIGSERIAL PRIMARY KEY,
  module_id       INTEGER NOT NULL REFERENCES ladn.modules(id) ON DELETE RESTRICT,
  entity_type     TEXT,
  entity_id       INTEGER,
  related_ids     JSONB NOT NULL DEFAULT '{}'::jsonb,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_by    INTEGER,
  submitted_portal TEXT,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      INTEGER,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted      BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS module_records_module_idx ON ladn.module_records (module_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS module_records_entity_idx ON ladn.module_records (entity_type, entity_id) WHERE entity_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS module_records_data_gin ON ladn.module_records USING GIN (data);

-- Saved views / dashboards on modules
CREATE TABLE IF NOT EXISTS ladn.module_views (
  id              SERIAL PRIMARY KEY,
  module_id       INTEGER NOT NULL REFERENCES ladn.modules(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  filter_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  display_type    TEXT NOT NULL DEFAULT 'table' CHECK (display_type IN ('table','cards','chart','count','stat')),
  display_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_shared       BOOLEAN NOT NULL DEFAULT false,
  created_by      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS module_views_module_idx ON ladn.module_views (module_id);

-- Uploaded files (photos/signatures) referenced by module records
CREATE TABLE IF NOT EXISTS ladn.module_uploads (
  id              BIGSERIAL PRIMARY KEY,
  record_id       BIGINT REFERENCES ladn.module_records(id) ON DELETE CASCADE,
  field_key       TEXT NOT NULL,
  filename        TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      INTEGER,
  storage_path    TEXT NOT NULL,
  uploaded_by     INTEGER,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS module_uploads_record_idx ON ladn.module_uploads (record_id);
