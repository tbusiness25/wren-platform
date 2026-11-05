'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b239 — reconcile the Google group against the children register.
//
// `parents@example-nursery.co.uk` is synced daily at 07:00 from the email
// ALLOWLIST (src/lib/email-allowlist.js), which is deliberately broad: it
// includes enquiry and waiting-list parents so front-line staff can reply to
// them. That breadth is correct for "who may staff email", and wrong for "who
// should be receiving nursery mail", and nothing has ever compared the two.
//
// Two questions, and they fail in opposite directions:
//
//   ORPHANS — in the group, no enrolled child. A family that left in July is
//     still receiving the newsletter in October unless somebody remembered to
//     remove them. That is a GDPR problem (processing after the relationship
//     ended), not an untidiness problem.
//
//   MISSING — parent of an enrolled child, not in the group. They get NO
//     nursery email at all and nobody finds out until they say "I never got
//     that". This is the one that actually hurts a family.
//
// ORPHANS ARE NOT ALL THE SAME, and treating them as one number is how a report
// like this gets ignored. An enquiry parent in the group is expected and correct.
// A leaver is a real finding. Someone Wren has never heard of is a different and
// more interesting finding again. They are classified, not lumped.
//
// PRIVACY: counts, ids and pseudonymous refs only. `ref()` is byte-identical to
// the one in scripts/sync-gmail-allowlist.js — sha256(address)[0..10]@domain —
// so a ref in this output and a ref in that log are the same string for the same
// person, and neither is an address. Nothing here ever returns or logs one.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const EMAIL_SQL_RE = "^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$";

/** sha256(address)[0..10] + '@' + domain — the project-wide pseudonymous ref. */
function ref(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return '<empty>';
  const at = e.lastIndexOf('@');
  const digest = crypto.createHash('sha256').update(e).digest('hex').slice(0, 10);
  return at >= 0 ? `${digest}@${e.slice(at + 1)}` : digest;
}

/**
 * Google normalises addresses — gmail dots and +aliases collapse, googlemail
 * becomes gmail — so a plain string comparison between the register and the
 * group reports churn that is not real. The sync script already learned this the
 * hard way (it re-adds and re-removes the same person forever without it), so
 * both sides are normalised the same way before they are compared.
 */
function normalise(email) {
  let e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** Parents of children who are enrolled RIGHT NOW. The narrow set. */
async function enrolledParents(db) {
  const { rows } = await db.query(`
    SELECT c.id AS child_id, lower(trim(e)) AS email
      FROM children c
      CROSS JOIN LATERAL (VALUES (c.parent_1_email), (c.parent_2_email), (c.primary_contact_email)) v(e)
     WHERE (c.is_active = true
            OR (c.start_date IS NOT NULL AND c.start_date <= CURRENT_DATE + INTERVAL '60 days'))
       AND (c.leave_date IS NULL OR c.leave_date >= CURRENT_DATE)
       AND lower(trim(e)) ~ '${EMAIL_SQL_RE}'
     UNION
    SELECT pa.child_id, lower(trim(pa.email)) AS email
      FROM parent_portal_access pa
      JOIN children c ON c.id = pa.child_id
     WHERE pa.is_active = true
       AND (c.is_active = true
            OR (c.start_date IS NOT NULL AND c.start_date <= CURRENT_DATE + INTERVAL '60 days'))
       AND (c.leave_date IS NULL OR c.leave_date >= CURRENT_DATE)
       AND lower(trim(pa.email)) ~ '${EMAIL_SQL_RE}'`);
  // email(normalised) → the child ids it covers
  const byEmail = new Map();
  for (const r of rows) {
    const k = normalise(r.email);
    if (!byEmail.has(k)) byEmail.set(k, { email: r.email, childIds: new Set() });
    byEmail.get(k).childIds.add(r.child_id);
  }
  return byEmail;
}

/**
 * Everyone Wren knows about who is NOT a parent of an enrolled child, and why.
 * Used to classify orphans, so an enquiry parent legitimately in the group is
 * not reported as a leak and a genuine leaver is not buried among them.
 */
async function knownNonEnrolled(db) {
  const out = new Map();
  const add = (email, kind, id) => {
    const k = normalise(email);
    if (!k || out.has(k)) return;
    out.set(k, { kind, id: id == null ? null : Number(id) });
  };
  const q = async (sql, kind) => {
    try {
      const { rows } = await db.query(sql);
      rows.forEach((r) => add(r.email, kind, r.id));
    } catch (e) {
      // A missing optional table must not take the whole report down, but it
      // must not silently become "nobody" either — the caller sees `partial`.
      out.set(`__error_${kind}`, { kind: 'error', id: null, message: e.message });
    }
  };
  await q(`SELECT c.id, lower(trim(c.parent_1_email)) AS email FROM children c
            WHERE (c.is_active = false OR c.leave_date < CURRENT_DATE)
              AND lower(trim(c.parent_1_email)) ~ '${EMAIL_SQL_RE}'
           UNION
           SELECT c.id, lower(trim(c.parent_2_email)) FROM children c
            WHERE (c.is_active = false OR c.leave_date < CURRENT_DATE)
              AND lower(trim(c.parent_2_email)) ~ '${EMAIL_SQL_RE}'`, 'leaver');
  await q(`SELECT id, lower(trim(parent_email)) AS email FROM enquiries
            WHERE lower(trim(parent_email)) ~ '${EMAIL_SQL_RE}'`, 'enquiry');
  await q(`SELECT id, lower(trim(parent_email)) AS email FROM waiting_list_live
            WHERE lower(trim(parent_email)) ~ '${EMAIL_SQL_RE}'`, 'waiting_list');
  await q(`SELECT c.id, lower(trim(c.parent_1_email)) AS email FROM children c
            WHERE c.is_active = false AND c.start_date > CURRENT_DATE
              AND lower(trim(c.parent_1_email)) ~ '${EMAIL_SQL_RE}'`, 'future_starter');
  return out;
}

/**
 * reconcile — compare the group's membership against the register.
 *
 * @param {object}  db            a pg pool/client with search_path=ladn
 * @param {string[]} groupMembers addresses as Google reports them
 * @returns {Promise<object>} counts, ids and refs. NEVER an address.
 */
async function reconcile(db, groupMembers) {
  const enrolled = await enrolledParents(db);
  const known = await knownNonEnrolled(db);
  const partial = [...known.values()].filter((v) => v.kind === 'error').map((v) => v.message);

  const members = new Map();               // normalised → as Google reports it
  for (const m of groupMembers || []) {
    const k = normalise(m);
    if (k) members.set(k, m);
  }

  // ── In the group, no enrolled child ───────────────────────────────────────
  const orphans = [];
  for (const [k, original] of members) {
    if (enrolled.has(k)) continue;
    const why = known.get(k);
    orphans.push({
      ref: ref(original),
      classification: why ? why.kind : 'unknown_to_wren',
      // The id is Wren's own — a child id for a leaver/future starter, an
      // enquiry or waiting-list id otherwise. Null when Wren has never seen them.
      id: why ? why.id : null,
    });
  }

  // ── Parent of an enrolled child, not in the group ─────────────────────────
  const missing = [];
  for (const [k, info] of enrolled) {
    if (members.has(k)) continue;
    missing.push({ ref: ref(info.email), child_ids: [...info.childIds].sort((a, b) => a - b) });
  }

  const byClass = orphans.reduce((acc, o) => {
    acc[o.classification] = (acc[o.classification] || 0) + 1;
    return acc;
  }, {});

  return {
    ran_at: new Date().toISOString(),
    ok: partial.length === 0,
    partial,
    counts: {
      group_members: members.size,
      enrolled_parent_addresses: enrolled.size,
      orphans: orphans.length,
      missing: missing.length,
      orphans_by_classification: byClass,
      // The one that is a live GDPR exposure rather than an expected breadth.
      leavers_still_in_group: byClass.leaver || 0,
      unknown_to_wren: byClass.unknown_to_wren || 0,
    },
    orphans: orphans.sort((a, b) => a.ref.localeCompare(b.ref)),
    missing: missing.sort((a, b) => a.ref.localeCompare(b.ref)),
  };
}

/** Idempotent, additive. Safe to call on every run. */
async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS parents_group_reconciliation (
      id            bigserial PRIMARY KEY,
      ran_at        timestamptz NOT NULL DEFAULT now(),
      group_email   text        NOT NULL,
      ok            boolean     NOT NULL DEFAULT true,
      counts        jsonb       NOT NULL DEFAULT '{}'::jsonb,
      -- refs and Wren ids only, never an address. See the header of this file.
      orphans       jsonb       NOT NULL DEFAULT '[]'::jsonb,
      missing       jsonb       NOT NULL DEFAULT '[]'::jsonb,
      note          text
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS parents_group_reconciliation_ran_at_idx
                    ON parents_group_reconciliation (ran_at DESC)`);
}

async function persist(db, groupEmail, result, note) {
  await ensureSchema(db);
  const { rows } = await db.query(
    `INSERT INTO parents_group_reconciliation (group_email, ok, counts, orphans, missing, note)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6) RETURNING id, ran_at`,
    [groupEmail, result.ok, JSON.stringify(result.counts),
     JSON.stringify(result.orphans), JSON.stringify(result.missing), note || null]);
  return rows[0];
}

/** The most recent reconciliation, or null if one has never run. */
async function latest(db) {
  try {
    const { rows } = await db.query(
      `SELECT id, ran_at, group_email, ok, counts, orphans, missing, note
         FROM parents_group_reconciliation ORDER BY ran_at DESC LIMIT 1`);
    return rows[0] || null;
  } catch (e) {
    if (/relation .* does not exist/i.test(e.message)) return null;
    throw e;
  }
}

module.exports = { reconcile, ref, normalise, enrolledParents, ensureSchema, persist, latest };
