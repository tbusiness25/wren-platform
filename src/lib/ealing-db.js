'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Ealing EY Hub — database layer (build b196, 2026-08-19)
//
// This is OTHER ORGANISATIONS' data (Ealing's early-years settings), so it lives
// in its own `ealing` schema and gets its own connection pool whose search_path
// deliberately EXCLUDES `ladn`. That is the hard wall: even a bug that issued an
// unqualified `SELECT * FROM children` from this pool would error rather than
// silently read nursery records. Every statement below is additionally
// schema-qualified (`ealing.x`) so the guarantee holds twice over.
//
// Nothing in this file — or anything that requires it — may ever write to ladn.*.
// (Proof for reviewers: `grep -n 'ladn\.' src/lib/ealing-*.js src/routes/ealing*.js`
//  must return zero rows.)
//
// Schema creation is LAZY: it fires on the first /api/ealing/* request, never at
// boot. So mounting this on production changes nothing until the Ealing portal is
// actually used.
// ─────────────────────────────────────────────────────────────────────────────
const { Pool } = require('pg');

let pool;

/** Pool bound to the `ealing` schema only. `ladn` is not on the search_path. */
function getEalingPool() {
  if (!pool) {
    pool = new Pool({
      host:     process.env.PG_HOST || 'localhost',
      port:     parseInt(process.env.PG_PORT || '5434'),
      database: process.env.PG_DB || 'wren',
      user:     process.env.PG_USER || 'wren',
      password: process.env.PG_PASSWORD,
      options:  '-c search_path=ealing,public',   // NOTE: no `ladn` — intentional
      max: 6,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => console.error('[ealing-db] pool error:', err.message));
  }
  return pool;
}

// ── Schema (additive + idempotent; CREATE ... IF NOT EXISTS only, never DROP) ──
let _ready = null;

const DDL = `
CREATE SCHEMA IF NOT EXISTS ealing;

-- An "org" is one early-years SETTING (private nursery, pre-school, childminder,
-- school nursery class) — or the LA team itself (setting_type='la').
CREATE TABLE IF NOT EXISTS ealing.orgs (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  urn           text,
  setting_type  text NOT NULL DEFAULT 'pvi'
                CHECK (setting_type IN ('pvi','childminder','school_nursery','maintained','la')),
  contact_email text,
  contact_phone text,
  address       text,
  postcode      text,
  ward          text,
  is_active     boolean NOT NULL DEFAULT true,
  is_demo       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ealing_orgs_name_uq ON ealing.orgs (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS ealing_orgs_urn_uq  ON ealing.orgs (urn) WHERE urn IS NOT NULL;

-- Per-setting accounts. Deliberately NOT the nursery staff PIN model (CLAUDE.md
-- rule 1 territory) — these are external organisations: email + bcrypt password,
-- or an emailed magic link.
CREATE TABLE IF NOT EXISTS ealing.users (
  id             serial PRIMARY KEY,
  org_id         integer NOT NULL REFERENCES ealing.orgs(id) ON DELETE CASCADE,
  email          text NOT NULL,
  full_name      text NOT NULL,
  job_title      text,
  role           text NOT NULL DEFAULT 'setting' CHECK (role IN ('setting','la_admin')),
  password_hash  text,
  is_active      boolean NOT NULL DEFAULT true,
  approved_at    timestamptz,
  last_login_at  timestamptz,
  failed_logins  integer NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ealing_users_email_uq ON ealing.users (lower(email));
CREATE INDEX IF NOT EXISTS ealing_users_org_idx ON ealing.users (org_id);

-- Magic-link / password-reset tokens. Only the SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS ealing.login_tokens (
  id         serial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES ealing.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  purpose    text NOT NULL DEFAULT 'magic_link'
             CHECK (purpose IN ('magic_link','password_reset')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ealing_login_tokens_user_idx ON ealing.login_tokens (user_id);

-- Requests to join, made from the public sign-up form. INACTIVE until an
-- la_admin approves (same shape as the nursery onboarding-invite flow).
CREATE TABLE IF NOT EXISTS ealing.access_requests (
  id            serial PRIMARY KEY,
  setting_name  text NOT NULL,
  urn           text,
  setting_type  text,
  full_name     text NOT NULL,
  job_title     text,
  email         text NOT NULL,
  phone         text,
  message       text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
  decided_at    timestamptz,
  decided_by    integer REFERENCES ealing.users(id),
  created_org_id integer REFERENCES ealing.orgs(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ealing_access_requests_status_idx ON ealing.access_requests (status, created_at);

-- EGFL links + named LA contacts, grouped by topic and searchable.
CREATE TABLE IF NOT EXISTS ealing.resources (
  id            serial PRIMARY KEY,
  slug          text UNIQUE,
  kind          text NOT NULL DEFAULT 'link' CHECK (kind IN ('link','contact')),
  category      text NOT NULL,
  title         text NOT NULL,
  description   text,
  url           text,
  contact_name  text,
  contact_email text,
  contact_phone text,
  source        text,          -- where this was verified from
  verified_on   date,
  confirmed     boolean NOT NULL DEFAULT true,  -- false => shows in "to confirm"
  sort_order    integer NOT NULL DEFAULT 100,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ealing_resources_cat_idx ON ealing.resources (category, sort_order);

-- The Yellow Book + other LA documents (browse + download).
CREATE TABLE IF NOT EXISTS ealing.documents (
  id              serial PRIMARY KEY,
  slug            text UNIQUE,
  title           text NOT NULL,
  description     text,
  category        text NOT NULL,
  doc_type        text NOT NULL DEFAULT 'pdf',
  url             text,        -- canonical EGFL/gov.uk URL
  file_path       text,        -- locally stored copy, if the LA uploaded one
  file_name       text,
  mime_type       text,
  published_label text,        -- e.g. "September 2025", "2022-23"
  source          text,
  verified_on     date,
  confirmed       boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 100,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ealing_documents_cat_idx ON ealing.documents (category, sort_order);

-- Funding-portal / FIS submission windows and deadlines (the calendar).
CREATE TABLE IF NOT EXISTS ealing.portal_dates (
  id           serial PRIMARY KEY,
  cycle        text NOT NULL,        -- 'actuals' | 'adjustments' | 'senif'
  period_label text NOT NULL,        -- 'Month 1 - April 2026'
  date_type    text NOT NULL,        -- 'open' | 'close' | 'payment' | 'panel' | 'deadline'
  event_date   date NOT NULL,
  title        text NOT NULL,
  notes        text,
  source       text,
  source_url   text,
  confirmed    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle, period_label, date_type)
);
CREATE INDEX IF NOT EXISTS ealing_portal_dates_date_idx ON ealing.portal_dates (event_date);

-- In-app reminder preferences + per-user dismissals.
CREATE TABLE IF NOT EXISTS ealing.reminder_prefs (
  user_id      integer PRIMARY KEY REFERENCES ealing.users(id) ON DELETE CASCADE,
  lead_days    integer NOT NULL DEFAULT 7 CHECK (lead_days BETWEEN 1 AND 60),
  portal_dates boolean NOT NULL DEFAULT true,
  events       boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ealing.reminder_dismissals (
  id           serial PRIMARY KEY,
  user_id      integer NOT NULL REFERENCES ealing.users(id) ON DELETE CASCADE,
  ref_type     text NOT NULL CHECK (ref_type IN ('portal_date','event')),
  ref_id       integer NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, ref_type, ref_id)
);

-- Events calendar + manager-arranged meet-ups, with RSVP.
CREATE TABLE IF NOT EXISTS ealing.events (
  id                 serial PRIMARY KEY,
  title              text NOT NULL,
  description        text,
  kind               text NOT NULL DEFAULT 'la_event'
                     CHECK (kind IN ('la_event','training','meetup','network')),
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz,
  location           text,
  online_url         text,
  capacity           integer,
  created_by_user_id integer REFERENCES ealing.users(id),
  created_by_org_id  integer REFERENCES ealing.orgs(id),
  is_published       boolean NOT NULL DEFAULT true,
  cancelled_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ealing_events_start_idx ON ealing.events (starts_at);

CREATE TABLE IF NOT EXISTS ealing.event_rsvps (
  id         serial PRIMARY KEY,
  event_id   integer NOT NULL REFERENCES ealing.events(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES ealing.users(id) ON DELETE CASCADE,
  org_id     integer NOT NULL REFERENCES ealing.orgs(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'going' CHECK (status IN ('going','maybe','declined')),
  attendees  integer NOT NULL DEFAULT 1 CHECK (attendees BETWEEN 1 AND 20),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

-- Managers' forum: topics -> threads -> posts. Never anonymous — every row
-- carries the poster's real name AND their setting.
CREATE TABLE IF NOT EXISTS ealing.forum_topics (
  id          serial PRIMARY KEY,
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  description text,
  is_general  boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ealing.forum_threads (
  id           serial PRIMARY KEY,
  topic_id     integer NOT NULL REFERENCES ealing.forum_topics(id) ON DELETE CASCADE,
  title        text NOT NULL,
  user_id      integer NOT NULL REFERENCES ealing.users(id),
  org_id       integer NOT NULL REFERENCES ealing.orgs(id),
  author_name  text NOT NULL,
  setting_name text NOT NULL,
  is_locked    boolean NOT NULL DEFAULT false,
  hidden_at    timestamptz,
  deleted_at   timestamptz,
  last_post_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ealing_forum_threads_topic_idx ON ealing.forum_threads (topic_id, last_post_at DESC);

CREATE TABLE IF NOT EXISTS ealing.forum_posts (
  id            serial PRIMARY KEY,
  thread_id     integer NOT NULL REFERENCES ealing.forum_threads(id) ON DELETE CASCADE,
  user_id       integer NOT NULL REFERENCES ealing.users(id),
  org_id        integer NOT NULL REFERENCES ealing.orgs(id),
  author_name   text NOT NULL,
  setting_name  text NOT NULL,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  edited_at     timestamptz,
  hidden_at     timestamptz,
  hidden_reason text,
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS ealing_forum_posts_thread_idx ON ealing.forum_posts (thread_id, created_at);

-- PER-SETTING reports. This is the table the hard scope filter guards: a row is
-- only ever readable by users whose JWT org_id matches org_id.
CREATE TABLE IF NOT EXISTS ealing.org_reports (
  id                 serial PRIMARY KEY,
  org_id             integer NOT NULL REFERENCES ealing.orgs(id) ON DELETE CASCADE,
  report_type        text NOT NULL CHECK (report_type IN ('ofsted','ealing_visit','other')),
  title              text NOT NULL,
  report_date        date,
  overall_judgement  text,
  summary            text,
  url                text,
  file_path          text,
  file_name          text,
  mime_type          text,
  uploaded_by_user_id integer REFERENCES ealing.users(id),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ealing_org_reports_org_idx ON ealing.org_reports (org_id, report_date DESC);

CREATE TABLE IF NOT EXISTS ealing.audit_log (
  id          bigserial PRIMARY KEY,
  action      text NOT NULL,
  user_id     integer,
  org_id      integer,
  actor_email text,
  ref_type    text,
  ref_id      integer,
  detail      text,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ealing_audit_created_idx ON ealing.audit_log (created_at DESC);
`;

/**
 * Create the schema if it isn't there yet. Memoised on the promise so concurrent
 * first requests don't race; a failure clears the memo so the next request retries.
 */
function ensureEalingSchema() {
  if (_ready) return _ready;
  _ready = getEalingPool().query(DDL)
    .then(() => { console.log('[ealing-db] schema ready'); })
    .catch((e) => { _ready = null; throw e; });
  return _ready;
}

/** Write an audit row. Never throws — auditing must not break the request. */
async function audit(db, { action, userId = null, orgId = null, actorEmail = null,
                           refType = null, refId = null, detail = null, ip = null }) {
  try {
    await db.query(
      `INSERT INTO ealing.audit_log (action, user_id, org_id, actor_email, ref_type, ref_id, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [action, userId, orgId, actorEmail, refType, refId,
       detail ? String(detail).slice(0, 500) : null, ip ? String(ip).slice(0, 60) : null]
    );
  } catch (e) { console.error('[ealing-db] audit write failed:', e.message); }
}

module.exports = { getEalingPool, ensureEalingSchema, audit };
