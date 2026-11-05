-- Importers migration 2026-05-05
-- Adds staff_contracts table and eylog_ref tracking columns

CREATE TABLE IF NOT EXISTS ladn.staff_contracts (
  id                    SERIAL PRIMARY KEY,
  staff_id              INTEGER NOT NULL REFERENCES ladn.staff(id) ON DELETE CASCADE,
  start_date            DATE,
  end_date              DATE,
  employment_type       TEXT,
  contracted_hours      NUMERIC,
  annual_salary_pennies BIGINT,
  job_title             TEXT,
  department            TEXT,
  brighthr_ref          TEXT UNIQUE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staff_contracts_staff_id_idx ON ladn.staff_contracts(staff_id);

-- Idempotency ref columns for eylog import
ALTER TABLE ladn.observations   ADD COLUMN IF NOT EXISTS eylog_ref TEXT;
ALTER TABLE ladn.medicine_records ADD COLUMN IF NOT EXISTS eylog_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS observations_eylog_ref_idx
  ON ladn.observations(eylog_ref) WHERE eylog_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS medicine_records_eylog_ref_idx
  ON ladn.medicine_records(eylog_ref) WHERE eylog_ref IS NOT NULL;
