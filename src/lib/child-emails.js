'use strict';
// src/lib/child-emails.js — b532 (2026-10-28)
//
// Toby: "if I clicked on a child's profile and went to Communications I wouldn't just be able to
// see the messages sent on Wren but I'd also be able to see emails that they've had in the past."
//
// The emails are the ones the Inbox already holds (ladn.comms_email_queue, polled from staff@ and
// toby@ since June). Nothing is fetched from Gmail here and nothing is sent.
// An email belongs to a child when:
//   · it was sent from (or, for replies sent through Wren, to) one of that child's family
//     addresses — parent 1/2, the billing email, the family's parent-app logins, the contact
//     record — worked out at read time, so new mail shows without any job running; or
//   · scripts/link-parent-emails.js matched it (the local model on the Ascent, for mail from an
//     address Wren doesn't hold), recorded in ladn.comms_email_child_links.
// Mailbox access is the Inbox's own rule (allowedMailboxes): a confidential mailbox (toby@)
// stays hidden from anyone without a grant, and the response says how many were hidden.

const FAMILY_EMAILS_SQL = `
  SELECT DISTINCT lower(btrim(e)) AS email FROM (
    SELECT unnest(ARRAY[c.parent_1_email, c.parent_2_email, c.primary_contact_email]) AS e
      FROM children c WHERE c.id = $1
    UNION ALL SELECT ppa.email FROM parent_portal_access ppa WHERE ppa.child_id = $1 AND ppa.is_active
    UNION ALL SELECT ct.primary_email FROM contacts ct WHERE $1 = ANY(ct.child_ids)
  ) x WHERE e IS NOT NULL AND btrim(e) LIKE '%_@_%'`;

// 2026-10-28 (Toby: "I send a lot of messages to myself, my child's messages now have all my
// emails to myself"): a staff member's own address is never a family address, and mail FROM a
// staff address is never a parent email — even when that member of staff is also a parent here.
const STAFF_EMAILS_SQL = `SELECT DISTINCT lower(btrim(email)) AS email FROM staff
  WHERE email IS NOT NULL AND btrim(email) LIKE '%_@_%'`;

async function staffEmails(db) {
  const { rows } = await db.query(STAFF_EMAILS_SQL).catch(() => ({ rows: [] }));
  return rows.map(r => r.email);
}

async function familyEmails(db, childId) {
  const { rows } = await db.query(FAMILY_EMAILS_SQL, [childId]).catch(() => ({ rows: [] }));
  const staff = new Set(await staffEmails(db));
  return rows.map(r => r.email).filter(e => !staff.has(e) && !/@example-nursery\.co\.uk$/.test(e));
}

/** Emails for one child, newest first. allowed = mailbox addresses this user may read. */
async function childEmails(db, childId, allowed, { limit = 200 } = {}) {
  const addrs = await familyEmails(db, childId);
  const { rows } = await db.query(`
    WITH links AS (
      SELECT email_id, method FROM comms_email_child_links WHERE child_id = $1
    )
    SELECT q.id, q.mailbox, q.direction, q.from_email, q.to_email, q.subject, q.snippet,
           COALESCE(q.received_at, q.sent_at) AS at, q.section, q.status,
           CASE WHEN lower(btrim(q.from_email)) = ANY($2::text[]) THEN 'from family'
                WHEN q.direction IS DISTINCT FROM 'in' AND lower(btrim(q.to_email)) = ANY($2::text[]) THEN 'to family'
                ELSE (SELECT l.method FROM links l WHERE l.email_id = q.id) END AS matched_by,
           EXISTS (SELECT 1 FROM inbox_intel_cards ic WHERE ic.email_id = q.id AND ic.case_kind = 'safeguarding') AS safeguarding
      FROM comms_email_queue q
     WHERE lower(btrim(q.from_email)) = ANY($2::text[])
        OR (q.direction IS DISTINCT FROM 'in' AND lower(btrim(q.to_email)) = ANY($2::text[]))
        OR q.id IN (SELECT email_id FROM links)
     ORDER BY at DESC NULLS LAST
     LIMIT $3`, [childId, addrs, Math.min(Math.max(limit, 1), 500)]);
  const ok = new Set((allowed || []).map(m => String(m).toLowerCase()));
  const staff = new Set(await staffEmails(db));
  const notStaffMail = (r) => !staff.has(String(r.from_email || '').toLowerCase().trim());
  const parentMail = rows.filter(notStaffMail);
  const visible = parentMail.filter(r => ok.has(String(r.mailbox || '').toLowerCase()));
  return { emails: visible, hidden: parentMail.length - visible.length, family_addresses: addrs.length };
}

module.exports = { childEmails, familyEmails, staffEmails };
