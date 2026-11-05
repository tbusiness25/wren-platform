'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Onboarding invites — shared helpers (PROMPT: add-new child/staff, 2026-07-15)
// A single-use, expiring token lets a parent (child) or new starter (staff) fill
// in their own details via a public, no-login form. The record is created
// INACTIVE and only becomes live after a manager approves it in Roost.
//
// The table lives in whichever tenant schema the pool points at (ladn on prod,
// wren_dev on dev, demo_* on demos) — created lazily & idempotently on first use.
// Additive-only: never drops or mutates existing tables.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const { getPool } = require('../db/pool');

let _ensured = null;
async function ensureTable() {
  if (_ensured) return _ensured;
  _ensured = getPool().query(`
    CREATE TABLE IF NOT EXISTS onboarding_invites (
      id                  SERIAL PRIMARY KEY,
      type                TEXT NOT NULL,               -- 'child' | 'staff'
      token               TEXT NOT NULL UNIQUE,
      email               TEXT,
      note                TEXT,
      status              TEXT NOT NULL DEFAULT 'pending', -- pending|submitted|approved|rejected|expired
      created_by          INTEGER,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at          TIMESTAMPTZ NOT NULL,
      submitted_at        TIMESTAMPTZ,
      submitted_entity_id INTEGER,
      submitted_summary   TEXT,
      approved_at         TIMESTAMPTZ,
      approved_by         INTEGER
    )
  `)
    // b275 — the manager-initiated NEW-STARTER invite creates the staff row and
    // the induction assignment up front (the self-service flow above creates them
    // at submission time), so the invite has to remember what it made and whether
    // the starter ever opened it. Additive; mirrors
    // migrations/2026-09-04-b275-starter-invites.sql so a tenant that has the
    // table but not the migration self-heals here.
    .then(() => getPool().query(`
      ALTER TABLE onboarding_invites ADD COLUMN IF NOT EXISTS staff_id      INTEGER;
      ALTER TABLE onboarding_invites ADD COLUMN IF NOT EXISTS assignment_id INTEGER;
      ALTER TABLE onboarding_invites ADD COLUMN IF NOT EXISTS opened_at     TIMESTAMPTZ;
      ALTER TABLE onboarding_invites ADD COLUMN IF NOT EXISTS emailed_at    TIMESTAMPTZ;
      ALTER TABLE onboarding_invites ADD COLUMN IF NOT EXISTS email_status  TEXT;
      ALTER TABLE onboarding_invites ADD COLUMN IF NOT EXISTS send_count    INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS onboarding_invites_staff_idx ON onboarding_invites (staff_id);
    `))
    // b405 — staff-side confirmation that the red book (child health record) and
    // birth certificate have been physically seen, ticked by the approving
    // manager at the point of approval. Never a parent upload. Additive; mirrors
    // migrations/2026-10-06-b405-redbook-birthcert-seen.sql so a tenant that has
    // the table but not the migration self-heals here.
    .then(() => getPool().query(`
      ALTER TABLE onboarding_invites ADD COLUMN IF NOT EXISTS red_book_seen   BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE onboarding_invites ADD COLUMN IF NOT EXISTS birth_cert_seen BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE onboarding_invites ADD COLUMN IF NOT EXISTS seen_by         INTEGER;
      ALTER TABLE onboarding_invites ADD COLUMN IF NOT EXISTS seen_at         TIMESTAMPTZ;
    `))
    .then(() => true).catch(e => { _ensured = null; throw e; });
  return _ensured;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
function mintToken() { return crypto.randomBytes(24).toString('base64url'); } // ~32 url-safe chars

// Resolve + validate a token → the invite row, or null if unknown/malformed.
// Lazily flips a still-'pending' invite to 'expired' once past expires_at.
async function loadInvite(token, type) {
  if (!TOKEN_RE.test(token || '')) return null;
  await ensureTable();
  const params = type ? [token, type] : [token];
  const { rows } = await getPool().query(
    `SELECT * FROM onboarding_invites WHERE token=$1${type ? ' AND type=$2' : ''}`, params);
  if (!rows.length) return null;
  const inv = rows[0];
  if (inv.status === 'pending' && inv.expires_at && new Date(inv.expires_at) < new Date()) {
    getPool().query(`UPDATE onboarding_invites SET status='expired' WHERE id=$1`, [inv.id]).catch(() => {});
    return { ...inv, status: 'expired' };
  }
  return inv;
}

module.exports = { ensureTable, mintToken, loadInvite, TOKEN_RE };
