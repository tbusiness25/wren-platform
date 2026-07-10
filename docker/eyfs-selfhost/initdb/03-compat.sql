-- =============================================================================
-- Schema compatibility patches for the self-host bundle.
--
-- 01-schema.sql is a point-in-time pg_dump of the demo_eyfs schema. A few
-- columns the current EYFS app code expects were added after that dump was
-- taken. This file brings the seeded schema up to what the running code needs.
--
-- Everything here is idempotent (ADD COLUMN IF NOT EXISTS), so it is safe to
-- re-run and safe as schema evolves. Runs after 01-schema.sql and 02-seed.sql
-- because docker-entrypoint-initdb.d applies files in alphanumeric order.
-- =============================================================================

SET search_path TO demo_eyfs;

-- The staff list / login pad need pin_length so the keypad knows whether to
-- expect a 4- or 6-digit PIN. Default 4 matches the seeded demo PINs (1234).
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_length integer DEFAULT 4;
UPDATE staff SET pin_length = 4 WHERE pin_length IS NULL;
