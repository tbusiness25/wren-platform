'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// family-signin.js — changing the address a parent signs in with must not lock the family out.
// b342, 2026-09-21
//
// A parent's login is an email address with an ACTIVE row in parent_portal_access, and every
// /welcome API scopes to those rows. So "change my email" on the parents' Your-account screen is
// not just a contact edit when the address being replaced is one somebody signs in with. Done
// naively (overwrite the address) it strands the family: the new address has no access row, the old
// one no longer matches anything, and Cloudflare Access — whose allowlist is rebuilt from the
// address columns — stops admitting the old one as well.
//
// THE RULE
//   The new address gets its own active row at once. The old row stays active. The old row is
//   retired only when the NEW address has actually been used to sign in (settleFor, called from
//   the parents' family-details endpoints, which every app open hits). Until then both work.
//
//   · Never an address that has no login today: a brand-new address for a parent whose old address
//     had no access row is a CONTACT change only. Giving a typed-in address access to a child's
//     photos, diary and invoices is a decision for the office, not a text box — one mistyped letter
//     would hand another household's inbox a child's day.
//   · Correcting a typo before first use: B → B' while B has never signed in retires B (nothing is
//     lost — nobody used it) and B' inherits B's predecessor, so the original address is still
//     the one that keeps working.
//   · Nothing here deletes a row. A retired row is deactivated with a reason and a time.
// ─────────────────────────────────────────────────────────────────────────────

const norm = e => String(e == null ? '' : e).trim().toLowerCase();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

let _cols = { at: 0, ok: false };
async function hasSwitchColumns(db) {
  const now = Date.now();
  if (_cols.ok) return true;
  if (now - _cols.at < 60 * 1000) return false;
  let ok = false;
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'parent_portal_access'
          AND column_name IN ('replaces_email', 'switch_started_at', 'retired_at', 'retired_reason')`);
    ok = rows[0].n === 4;
  } catch (_) { ok = false; }
  _cols = { at: now, ok };
  return ok;
}
async function requireSwitchColumns(db) {
  if (!(await hasSwitchColumns(db))) {
    const e = new Error('sign-in switching needs migrations/2026-09-21-b342-family-details-and-reports.sql');
    e.code = 'B342_NOT_MIGRATED';
    throw e;
  }
}

/** Active access rows for one address, limited to these children. */
async function activeAccessFor(db, email, childIds) {
  await requireSwitchColumns(db);
  const { rows } = await db.query(
    `SELECT id, child_id, lower(email) AS email, access_level, lower(replaces_email) AS replaces_email
       FROM parent_portal_access
      WHERE lower(email) = $1 AND is_active = true AND child_id = ANY($2::int[])
      ORDER BY id`, [norm(email), childIds]);
  return rows;
}

/**
 * What would changing `oldEmail` to `newEmail` mean for the group's children?
 *   none          same address (or one side blank) — nothing to do
 *   contact_only  the old address has no login on these children — a contact edit, no access change
 *   signin_switch the old address IS a login — the switch described at the top of this file
 */
async function planChange(db, { childIds, oldEmail, newEmail }) {
  const o = norm(oldEmail), n = norm(newEmail);
  if (!o || !n || o === n) return { kind: 'none', rows: [] };
  const rows = await activeAccessFor(db, o, childIds);
  return rows.length ? { kind: 'signin_switch', rows } : { kind: 'contact_only', rows: [] };
}

/** Carry out a planned signin_switch. Idempotent on (child, new address). */
async function applyChange(db, { plan, newEmail }) {
  await requireSwitchColumns(db);
  const nw = norm(newEmail);
  const out = { child_ids: [], corrected_before_use: false };
  for (const r of plan.rows) {
    // If the row being replaced is itself an unused replacement, chain to ITS predecessor: that is the
    // address that is still known to work, and it must stay the one that does.
    const origin = r.replaces_email || r.email;
    await db.query(
      `INSERT INTO parent_portal_access (child_id, email, is_active, access_level, replaces_email, switch_started_at)
       VALUES ($1, $2, true, $3, $4, now())
       ON CONFLICT (child_id, email) DO UPDATE
          SET is_active = true, replaces_email = EXCLUDED.replaces_email, switch_started_at = now(),
              retired_at = NULL, retired_reason = NULL`,
      [r.child_id, nw, r.access_level, origin]);
    if (r.replaces_email) {
      await db.query(
        `UPDATE parent_portal_access
            SET is_active = false, retired_at = now(), retired_reason = 'corrected before first use'
          WHERE id = $1`, [r.id]);
      out.corrected_before_use = true;
    }
    out.child_ids.push(r.child_id);
  }
  return out;
}

/**
 * The address `email` has just been used to sign in with. Retire whatever it replaced.
 * Returns [{ from, to, child_ids }] — empty when nothing was pending, which is nearly always.
 */
async function settleFor(db, email) {
  const to = norm(email);
  if (!to || !(await hasSwitchColumns(db))) return [];
  const { rows: pending } = await db.query(
    `SELECT id, child_id, lower(replaces_email) AS from_email
       FROM parent_portal_access
      WHERE lower(email) = $1 AND is_active = true AND replaces_email IS NOT NULL`, [to]);
  if (!pending.length) return [];
  const byFrom = new Map();
  for (const p of pending) {
    await db.query(
      `UPDATE parent_portal_access
          SET is_active = false, retired_at = now(),
              retired_reason = 'replaced by a new sign-in address, which has now been used'
        WHERE child_id = $1 AND lower(email) = $2 AND is_active = true`, [p.child_id, p.from_email]);
    await db.query('UPDATE parent_portal_access SET replaces_email = NULL WHERE id = $1', [p.id]);
    if (!byFrom.has(p.from_email)) byFrom.set(p.from_email, []);
    byFrom.get(p.from_email).push(p.child_id);
  }
  // The identity resolver caches "is this address known" for 30s; the old address should stop
  // working now, not half a minute from now.
  try { require('./parent-identity').invalidate(); } catch (_) { /* best effort */ }
  return [...byFrom.entries()].map(([from, child_ids]) => ({ from, to, child_ids }));
}

/** Switches still waiting for the new address to be used, for these children. */
async function pendingFor(db, childIds) {
  if (!(await hasSwitchColumns(db))) return [];
  const { rows } = await db.query(
    `SELECT lower(email) AS to_email, lower(replaces_email) AS from_email, child_id, switch_started_at
       FROM parent_portal_access
      WHERE child_id = ANY($1::int[]) AND is_active = true AND replaces_email IS NOT NULL
      ORDER BY switch_started_at, id`, [childIds]);
  const by = new Map();
  for (const r of rows) {
    const k = `${r.from_email}>${r.to_email}`;
    if (!by.has(k)) by.set(k, { from: r.from_email, to: r.to_email, child_ids: [], since: r.switch_started_at });
    by.get(k).child_ids.push(r.child_id);
  }
  return [...by.values()];
}

/** Which of these addresses is somebody's login on these children right now? */
async function loginAddressesFor(db, childIds) {
  const { rows } = await db.query(
    `SELECT DISTINCT lower(email) AS email FROM parent_portal_access
      WHERE child_id = ANY($1::int[]) AND is_active = true`, [childIds]);
  return new Set(rows.map(r => r.email));
}

/** Mask an address for a sentence on screen or a line in a log: "j***@example.com". */
function mask(email) {
  const e = norm(email), at = e.lastIndexOf('@');
  if (at < 1) return e ? '***' : '';
  return `${e[0]}***${e.slice(at)}`;
}

module.exports = { norm, EMAIL_RE, hasSwitchColumns, planChange, applyChange, settleFor, pendingFor, loginAddressesFor, mask };
