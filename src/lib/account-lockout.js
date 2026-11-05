'use strict';
/**
 * account-lockout.js — b491 (2026-10-12, security hardening).
 *
 * Persistent per-account lockout, on top of (not instead of) the existing
 * express-rate-limit 5/min login limiters in src/routes/auth.js. The limiter
 * resets the moment its window rolls over; this survives a server restart and
 * punishes repeat offenders harder each time. One account (staff id, or a
 * parent's lower-cased email) is one row in ladn.account_lockouts.
 */

const FAILURE_THRESHOLD = 8;           // failures within the window before locking
const WINDOW_MS = 24 * 60 * 60 * 1000; // rolling 24h failure window
const BASE_LOCK_MINUTES = 30;          // first lockout duration; doubles each repeat
const ESCALATION_DECAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 clean days resets the escalation level
const MAX_LOCK_MINUTES = 24 * 60;      // b491 review: cap — staff ids are public (EY picker), so an uncapped doubling is a DoS lever

function keyFor(accountType, accountKeyRaw) {
  const key = accountType === 'parent' ? String(accountKeyRaw || '').toLowerCase().trim() : String(accountKeyRaw);
  return { accountType, key };
}

/**
 * Returns {locked, until}. b491 review: this now RESERVES an attempt atomically
 * (failed_attempts+1 in one UPSERT, row-locked) before the caller compares the
 * PIN/code, and refuses once the window already holds FAILURE_THRESHOLD failures.
 * The old SELECT-then-compare let 40 parallel guesses through with the counter at 4.
 * recordSuccess() clears the reservation; recordFailure() keeps it and locks at the
 * threshold. {peek:true} only reads (used where nothing is being guessed, e.g. /refresh).
 * Never throws (fails open).
 */
async function checkLocked(db, accountType, accountKeyRaw, { peek = false } = {}) {
  const { key } = keyFor(accountType, accountKeyRaw);
  try {
    if (peek) {
      const { rows } = await db.query(
        `SELECT locked_until FROM account_lockouts WHERE account_type=$1 AND account_key=$2`, [accountType, key]);
      const until = rows[0]?.locked_until ? new Date(rows[0].locked_until) : null;
      return (until && until > new Date()) ? { locked: true, until } : { locked: false, until: null };
    }
    const { rows } = await db.query(
      `INSERT INTO account_lockouts (account_type, account_key, failed_attempts, window_start, updated_at)
       VALUES ($1, $2, 1, now(), now())
       ON CONFLICT (account_type, account_key) DO UPDATE SET
         failed_attempts = CASE WHEN account_lockouts.locked_until > now() THEN account_lockouts.failed_attempts
                                WHEN account_lockouts.window_start IS NULL OR account_lockouts.window_start < now() - make_interval(secs => $3)
                                THEN 1 ELSE account_lockouts.failed_attempts + 1 END,
         window_start = CASE WHEN account_lockouts.window_start IS NULL OR account_lockouts.window_start < now() - make_interval(secs => $3)
                             THEN now() ELSE account_lockouts.window_start END,
         updated_at = now()
       RETURNING failed_attempts, locked_until`,
      [accountType, key, WINDOW_MS / 1000]
    );
    const until = rows[0]?.locked_until ? new Date(rows[0].locked_until) : null;
    if (until && until > new Date()) return { locked: true, until };
    if ((rows[0]?.failed_attempts || 0) > FAILURE_THRESHOLD) {
      // Over the cap without a recorded lock (a burst raced the lock write): treat as locked.
      return { locked: true, until: new Date(Date.now() + BASE_LOCK_MINUTES * 60 * 1000) };
    }
    return { locked: false, until: null };
  } catch (e) {
    console.error('[account-lockout] checkLocked error:', e.message);
    return { locked: false, until: null }; // fail open — never let a DB hiccup brick every login
  }
}

/**
 * Record a failed attempt (already counted by checkLocked's reservation). Locks
 * once the window holds FAILURE_THRESHOLD failures. Returns {locked, until, attempts}.
 * `staffId` is for the Telegram alert only (never the PIN/password or a name).
 */
async function recordFailure(db, accountType, accountKeyRaw, { req, staffId, label } = {}) {
  const { key } = keyFor(accountType, accountKeyRaw);
  try {
    const now = new Date();
    const { rows } = await db.query(
      `SELECT failed_attempts, lockout_count, last_locked_at, locked_until
         FROM account_lockouts WHERE account_type=$1 AND account_key=$2`, [accountType, key]);
    const r = rows[0] || { failed_attempts: 1, lockout_count: 0, last_locked_at: null, locked_until: null };
    if (r.locked_until && new Date(r.locked_until) > now) return { locked: true, until: new Date(r.locked_until), attempts: r.failed_attempts };
    if ((r.failed_attempts || 0) < FAILURE_THRESHOLD) return { locked: false, until: null, attempts: r.failed_attempts };
    let level = r.lockout_count || 0;
    if (r.last_locked_at && (now - new Date(r.last_locked_at)) > ESCALATION_DECAY_MS) level = 0;
    const minutes = Math.min(BASE_LOCK_MINUTES * Math.pow(2, level), MAX_LOCK_MINUTES);
    const until = new Date(now.getTime() + minutes * 60 * 1000);
    // Only one concurrent request wins the lock write (and sends the alert).
    const { rowCount } = await db.query(
      `UPDATE account_lockouts SET failed_attempts=0, window_start=NULL, locked_until=$3, lockout_count=$4,
              last_locked_at=$5, updated_at=now()
        WHERE account_type=$1 AND account_key=$2 AND (locked_until IS NULL OR locked_until <= now())`,
      [accountType, key, until, level + 1, now]);
    if (!rowCount) return { locked: true, until, attempts: r.failed_attempts };
    try {
      await require('../utils/audit').recordAudit({
        req, action: 'account_locked', entity_type: accountType, entity_id: staffId || null,
        actor_type: 'system',
        meta: { account_type: accountType, label: label || key, attempts: r.failed_attempts, lockout_count: level + 1, locked_until: until.toISOString() },
      });
    } catch (_) { /* audit must never block a login response */ }
    _alertLockout({ accountType, staffId, attempts: r.failed_attempts, minutes, until }).catch(() => {});
    return { locked: true, until, attempts: r.failed_attempts };
  } catch (e) {
    console.error('[account-lockout] recordFailure error:', e.message);
    return { locked: false, until: null, attempts: 0 };
  }
}

/** Successful login — clears the failure counter. Escalation level (lockout_count) is untouched. */
async function recordSuccess(db, accountType, accountKeyRaw) {
  const { key } = keyFor(accountType, accountKeyRaw);
  try {
    await db.query(
      `UPDATE account_lockouts SET failed_attempts=0, window_start=NULL, updated_at=now()
       WHERE account_type=$1 AND account_key=$2`,
      [accountType, key]
    );
  } catch (e) {
    console.error('[account-lockout] recordSuccess error:', e.message);
  }
}

/** Manager unlock — clears the lock AND the escalation level (fresh start). Audited by the caller's route. */
async function unlock(db, accountType, accountKeyRaw) {
  const { key } = keyFor(accountType, accountKeyRaw);
  const { rowCount } = await db.query(
    `UPDATE account_lockouts SET locked_until=NULL, failed_attempts=0, window_start=NULL, lockout_count=0, updated_at=now()
     WHERE account_type=$1 AND account_key=$2`,
    [accountType, key]
  );
  return rowCount > 0;
}

async function _alertLockout({ accountType, staffId, attempts, minutes, until }) {
  try {
    const { sendTelegramNow } = require('./notifications');
    // b491 review: staff id + counts only (brief item 1) — no name, no email, never the PIN.
    const who = accountType === 'staff' ? `staff id ${staffId}` : 'a parent account';
    await sendTelegramNow(
      `🔒 Account locked: ${who} — ${attempts} failed attempts. ` +
      `Locked ${minutes} min, until ${until.toLocaleString('en-GB', { timeZone: 'Europe/London' })}. ` +
      `A manager can unlock it (POST /api/auth/lockouts/unlock).`
    );
  } catch (e) {
    console.error('[account-lockout] Telegram alert failed:', e.message);
  }
}

function formatLockMessage(until) {
  const hhmm = new Date(until).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  return `Too many attempts — try again at ${hhmm}`;
}

module.exports = { checkLocked, recordFailure, recordSuccess, unlock, formatLockMessage, FAILURE_THRESHOLD };
