-- Wren backup system tables
-- Layer 1: local snapshot (6h), Layer 2: off-site encrypted (daily), Layer 3: cold storage (weekly)

CREATE TABLE IF NOT EXISTS ladn.backup_config (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_schema         TEXT NOT NULL DEFAULT 'ladn',
  destination_type      TEXT NOT NULL DEFAULT 'none',
  destination_name      TEXT,
  rclone_remote_name    TEXT,
  encryption_passphrase_enc TEXT,
  schedule_layer1_cron  TEXT DEFAULT '0 */6 * * *',
  schedule_layer2_time  TEXT DEFAULT '02:00',
  schedule_layer3_day   TEXT DEFAULT 'sunday',
  retention_layer1_days INT DEFAULT 7,
  retention_layer2_days INT DEFAULT 90,
  retention_layer3_days INT DEFAULT 365,
  layer3_type           TEXT DEFAULT 'usb',
  layer3_b2_bucket      TEXT,
  layer3_usb_label      TEXT DEFAULT 'WREN-BACKUP',
  enabled               BOOLEAN DEFAULT TRUE,
  last_layer1_at        TIMESTAMPTZ,
  last_layer2_at        TIMESTAMPTZ,
  last_layer3_at        TIMESTAMPTZ,
  last_status           TEXT DEFAULT 'never',
  last_error            TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(school_schema)
);

CREATE TABLE IF NOT EXISTS ladn.backup_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id        UUID REFERENCES ladn.backup_config(id) ON DELETE SET NULL,
  layer            INT NOT NULL CHECK (layer IN (1, 2, 3)),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  bytes_written    BIGINT,
  files_count      INT,
  status           TEXT DEFAULT 'running' CHECK (status IN ('running','ok','warn','fail')),
  error            TEXT,
  destination_path TEXT,
  trigger_type     TEXT DEFAULT 'cron',
  triggered_by     INT
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_config ON ladn.backup_runs(config_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_runs_layer  ON ladn.backup_runs(layer, started_at DESC);

INSERT INTO ladn.backup_config (school_schema, destination_type, destination_name, enabled)
VALUES ('ladn', 'none', 'Not configured', TRUE)
ON CONFLICT (school_schema) DO NOTHING;
