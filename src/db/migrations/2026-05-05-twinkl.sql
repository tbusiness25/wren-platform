-- Twinkl integration migration 2026-05-05
-- Adds lesson_resources (provider-agnostic attachment table) and
-- twinkl_settings (encrypted API credentials) to each school schema.

DO $$
DECLARE
  s TEXT;
BEGIN
  FOREACH s IN ARRAY ARRAY['demo_primary','demo_secondary'] LOOP

    EXECUTE format('
      CREATE TABLE IF NOT EXISTS %I.lesson_resources (
        id             SERIAL PRIMARY KEY,
        entity_type    VARCHAR(20) NOT NULL,
        entity_id      INTEGER NOT NULL,
        provider       VARCHAR(30) NOT NULL DEFAULT ''twinkl'',
        external_url   TEXT NOT NULL,
        title          VARCHAR(500) NOT NULL,
        description    TEXT,
        thumbnail_url  TEXT,
        tags           TEXT[],
        created_by     INTEGER,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )', s);

    EXECUTE format('
      CREATE INDEX IF NOT EXISTS lesson_resources_entity_idx
        ON %I.lesson_resources(entity_type, entity_id)', s);

    EXECUTE format('
      CREATE TABLE IF NOT EXISTS %I.twinkl_settings (
        id             SERIAL PRIMARY KEY,
        api_key_enc    TEXT,
        api_key_iv     TEXT,
        api_key_tag    TEXT,
        enabled        BOOLEAN DEFAULT false,
        configured_by  INTEGER,
        configured_at  TIMESTAMPTZ DEFAULT NOW()
      )', s);

    -- Ensure at most one row exists for settings
    EXECUTE format('
      INSERT INTO %I.twinkl_settings (enabled) VALUES (false)
      ON CONFLICT DO NOTHING
    ', s);

  END LOOP;
END
$$;
