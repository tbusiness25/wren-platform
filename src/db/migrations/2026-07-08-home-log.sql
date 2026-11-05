-- Home Log table for parent‑portal logging (DEV‑ONLY)
-- Additive migration – safe to run multiple times

CREATE TABLE IF NOT EXISTS home_log (
    id SERIAL PRIMARY KEY,
    child_id INT NULL,
    waiting_list_id INT NULL,
    logged_by TEXT NOT NULL CHECK (logged_by IN ('parent','import')),
    parent_email TEXT,
    kind TEXT NOT NULL CHECK (kind IN (
        'feed','bottle','breastfeed','solids','nappy','sleep','milestone','note','photo'
    )),
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NULL,
    detail JSONB DEFAULT '{}'::jsonb,
    source TEXT NOT NULL DEFAULT 'wren' CHECK (source IN ('wren','nighp_csv')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (child_id IS NOT NULL OR waiting_list_id IS NOT NULL)
);

-- Indexes for fast look‑ups
CREATE INDEX IF NOT EXISTS idx_home_log_child ON home_log (child_id, started_at);
CREATE INDEX IF NOT EXISTS idx_home_log_waiting ON home_log (waiting_list_id, started_at);
