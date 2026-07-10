-- Extensions needed by the Wren schema (gen_random_bytes etc.) — must exist
-- before 01-schema.sql runs. Safe to re-run.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
