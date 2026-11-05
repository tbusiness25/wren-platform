'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b341 — a family gives notice in the parents app, and takes their own keepsake.
//
//   leavingRouter   mounted at /welcome/leaving/api
//     GET  /context     the family's children, any notice already given, the terms sentence
//     GET  /preview     the server's dates + the fee sentence for (child, chosen last day)
//     POST /give        write the notice
//   keepsakeRouter  mounted at /welcome/keepsake/api  (beside the existing /mine and /visible)
//     GET  /state       per child: leaving?, the active book, whether Create is allowed
//     POST /create      mint (or re-make) THEIR OWN child's book — the same routine Roost calls
//     POST /send-link   email the link to the signed-in parent's own address
//
// Both sit under /welcome/<feature>/api/, so server-unified.js's _requireVerifiedParentSession
// has already put every request through requireParentIdentity before a handler runs. Handlers
// read the answer with parentEmailOf(req) and never a header. A body child_id is NEVER trusted:
// ownership is re-read from parent_portal_access on every call.
//
// WHAT THE NOTICE WRITES (Toby, 2026-09-21: "they don't have to wait for me to do anything")
//   children.notice_given_date / leave_date / leave_reason / leave_reason_notes — the columns
//   Roost already edits and the keepsake gate already reads, which stay the single source of
//   truth — plus one append-only child_leaving_notices row holding what the parent was shown.
//   leave_date_manual is set too: a date a person chose is a decision and the b315 rule must
//   not recompute it if a date of birth is later corrected.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const { getPool } = require('../db/pool');
const { parentEmailOf } = require('../lib/parent-identity');
const { recordAudit } = require('../utils/audit');
const L = require('../lib/leaving-notice');
const M = require('../lib/keepsake-mint');
const { sendDirectEmail } = require('../lib/direct-email');

// ── shared ───────────────────────────────────────────────────────────────────
const parentsOnly = (req, res, next) => (req._portal === 'parents' ? next() : next('router'));
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

const label = c => c.preferred_name || c.first_name || 'your child';

// Every child this address has active portal access to. The date columns come back as text so
// the pg DATE → local-midnight trap can never move a day (memory/reference_pg_date_ymd_trap.md).
async function ownedChildren(db, email) {
  const { rows } = await db.query(
    `SELECT c.id, c.first_name, c.preferred_name, c.enrolment_status, COALESCE(c.is_active, true) AS is_active,
            to_char(c.notice_given_date, 'YYYY-MM-DD') AS notice_given_date,
            to_char(c.leave_date, 'YYYY-MM-DD')        AS leave_date
       FROM parent_portal_access pa
       JOIN children c ON c.id = pa.child_id
      WHERE lower(pa.email) = $1 AND pa.is_active = true
      ORDER BY c.first_name, c.id`, [email]);
  return rows;
}
async function ownedChild(db, email, childId) {
  if (!Number.isInteger(childId)) return null;
  return (await ownedChildren(db, email)).find(c => c.id === childId) || null;
}

const REASON_TO_LEAVE_REASON = {          // aligned with the labels already on children.leave_reason
  moving_away: 'Family Relocation', starting_school: 'Child starting School', changing_setting: 'Other',
  cost: 'Nursery Fees', could_do_better: 'Quality of Service Provided', prefer_not_to_say: null,
};

let _terms = { at: 0, v: null };
async function loadTerms(db) {
  if (_terms.v && Date.now() - _terms.at < 5 * 60 * 1000) return _terms.v;
  let v = { policy_id: null, version: null, version_label: null, clause: L.TERMS_CLAUSE_FALLBACK, from_policy: false };
  try {
    const { rows } = await db.query(
      `SELECT id, version, version_label, content FROM policies
        WHERE parent_facing = true AND is_active = true AND lower(title) = 'terms and conditions'
        ORDER BY id DESC LIMIT 1`);
    if (rows.length) {
      const clause = L.extractClause(rows[0].content);
      v = { policy_id: rows[0].id, version: rows[0].version, version_label: rows[0].version_label,
            clause: clause || L.TERMS_CLAUSE_FALLBACK, from_policy: !!clause };
    }
  } catch (_) { /* keep the fallback */ }
  _terms = { at: Date.now(), v };
  return v;
}

// The notice still standing for a child: the latest row, provided the nursery has not since cleared
// the dates on the child record (that is how the office records "they changed their mind") and the
// last day has not passed. A revision inherits its dates from this row; a fresh notice does not.
async function standingNotice(db, child, today) {
  if (!child.notice_given_date) return null;
  const { rows } = await db.query(
    `SELECT id, to_char(given_on,'YYYY-MM-DD') AS given_on, to_char(notice_start,'YYYY-MM-DD') AS notice_start,
            to_char(earliest_last_day,'YYYY-MM-DD') AS earliest_last_day, to_char(chosen_last_day,'YYYY-MM-DD') AS chosen_last_day,
            to_char(fees_run_to,'YYYY-MM-DD') AS fees_run_to, lower(given_by_email) AS given_by_email
       FROM child_leaving_notices WHERE child_id = $1 ORDER BY given_at DESC, id DESC LIMIT 1`, [child.id]);
  const n = rows[0];
  return n && n.chosen_last_day >= today ? n : null;
}

const wordCount = s => String(s || '').trim().split(/\s+/).filter(Boolean).length;

function previewFor(child, today, chosen, standing) {
  const prior = standing ? { notice_start: standing.notice_start, earliest_last_day: standing.earliest_last_day, given_on: standing.given_on } : null;
  return L.buildPreview(today, chosen, label(child), prior);
}

// A last day has to be a real, future weekday. A weekend is refused (the nursery is closed) with a
// message, never silently moved to another day.
function lastDayProblem(chosen, today) {
  if (!L.isYmd(chosen)) return 'Please choose a date.';
  if (chosen < today) return 'The last day cannot be in the past.';
  if (chosen > L.addDays(today, 730)) return 'Please choose a date within the next two years.';
  const dow = L.weekday(chosen);
  if (dow === 0 || dow === 6) return 'The nursery is open Monday to Friday — please choose a weekday.';
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// /welcome/leaving/api
// ═════════════════════════════════════════════════════════════════════════════
const leavingRouter = express.Router();
leavingRouter.use(parentsOnly, noStore, express.json({ limit: '16kb' }));

leavingRouter.get('/context', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const today = L.londonToday();
    const kids = (await ownedChildren(db, email)).filter(c => c.is_active && c.enrolment_status !== 'left');
    const children = [];
    for (const c of kids) {
      const standing = await standingNotice(db, c, today);
      children.push({
        id: c.id, name: label(c),
        leaving: !!(c.notice_given_date || c.leave_date),
        leave_date: c.leave_date, notice_given_date: c.notice_given_date,
        notice: standing ? {
          given_on: standing.given_on, notice_start: standing.notice_start, earliest_last_day: standing.earliest_last_day,
          chosen_last_day: standing.chosen_last_day, fees_run_to: standing.fees_run_to,
          given_by_you: standing.given_by_email === email,
          text: {
            given_on: L.longDate(standing.given_on), notice_start: L.longDate(standing.notice_start),
            earliest_last_day: L.longDate(standing.earliest_last_day), chosen_last_day: L.longDate(standing.chosen_last_day),
            fees_run_to: L.longDate(standing.fees_run_to),
          },
        } : null,
        // A date on the record that no notice row explains: the office entered it in Roost.
        recorded_by_nursery: !!((c.leave_date || c.notice_given_date) && !standing),
        recorded_leave_text: c.leave_date ? L.longDate(c.leave_date) : null,
      });
    }
    const terms = await loadTerms(db);
    res.json({
      today, today_text: L.longDate(today), children, reasons: L.REASONS,
      terms: { clause: terms.clause, version_label: terms.version_label },
      notice_weeks: L.NOTICE_WEEKS,
    });
  } catch (e) { console.error('[leaving] context:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

leavingRouter.get('/preview', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const child = await ownedChild(db, email, parseInt(req.query.child_id, 10));
    if (!child) return res.status(403).json({ error: 'Not your child' });
    const today = L.londonToday();
    const standing = await standingNotice(db, child, today);
    const chosen = req.query.last_day ? String(req.query.last_day) : null;
    if (chosen) { const bad = lastDayProblem(chosen, today); if (bad) return res.status(400).json({ error: bad, field: 'last_day' }); }
    res.json({ preview: previewFor(child, today, chosen, standing), revising: !!standing });
  } catch (e) { console.error('[leaving] preview:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

leavingRouter.post('/give', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const b = req.body || {};
  const childId = parseInt(b.child_id, 10);
  const typedName = String(b.typed_name || '').replace(/\s+/g, ' ').trim();
  const reasonCode = L.REASON_CODES.has(b.reason_code) ? b.reason_code : null;
  const reasonNotes = String(b.reason_notes || '').trim().slice(0, 1000) || null;
  const db = getPool();
  try {
    // 🔒 ownership — never the body's word for it
    const child = await ownedChild(db, email, childId);
    if (!child) return res.status(403).json({ error: 'Not your child' });
    if (!child.is_active || child.enrolment_status === 'left') return res.status(409).json({ error: 'This child has already left.' });

    if (b.confirm !== true) return res.status(400).json({ error: 'Please tick the box to confirm you are giving notice.', field: 'confirm' });
    if (typedName.length < 3 || wordCount(typedName) < 2) {
      return res.status(400).json({ error: 'Please type your full name (first and last) — it is what makes this a written notice.', field: 'typed_name' });
    }
    const today = L.londonToday();
    const chosenIn = String(b.last_day || '');
    const bad = lastDayProblem(chosenIn, today);
    if (bad) return res.status(400).json({ error: bad, field: 'last_day' });

    const standing = await standingNotice(db, child, today);
    const pv = previewFor(child, today, chosenIn, standing);

    // What they were shown has to be what gets stored. If the dates they saw are not the dates the
    // server computes now (the page sat open across a weekend or midnight), say so and let them look again.
    const shown = b.shown || {};
    if (shown.notice_start !== pv.notice_start || shown.earliest_last_day !== pv.earliest_last_day || shown.fees_run_to !== pv.fees_run_to) {
      return res.status(409).json({ error: 'The dates have changed since you last looked — please check them again.', reason: 'dates_changed', preview: pv });
    }

    // A double-tap replays, it does not write twice.
    const dup = await db.query(
      `SELECT id FROM child_leaving_notices
        WHERE child_id = $1 AND lower(given_by_email) = $2 AND chosen_last_day = $3::date
          AND given_at > now() - interval '2 minutes' ORDER BY id DESC LIMIT 1`, [childId, email, pv.chosen_last_day]);
    if (dup.rows.length) return res.json({ ok: true, replay: true, notice_id: dup.rows[0].id, preview: pv, keepsake_url: '/welcome/keepsake' });

    const terms = await loadTerms(db);
    const client = await db.connect();
    let noticeId;
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO child_leaving_notices
           (child_id, given_by_email, given_on, notice_start, earliest_last_day, chosen_last_day, fees_run_to, short_notice, is_revision,
            terms_policy_id, terms_version, terms_version_label, terms_clause, screen_text, typed_name, reason_code, reason_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [childId, email, today, pv.notice_start, pv.earliest_last_day, pv.chosen_last_day, pv.fees_run_to, pv.short_notice, !!standing,
         terms.policy_id, terms.version, terms.version_label, terms.clause, pv.screen_text, typedName, reasonCode, reasonNotes]);
      noticeId = ins.rows[0].id;
      // The notice date stays the ORIGINAL one when a family is only moving their last day.
      const noticeDate = standing ? standing.given_on : today;
      const leaveReason = reasonCode ? REASON_TO_LEAVE_REASON[reasonCode] : null;
      const notes = [reasonCode === 'changing_setting' ? 'Changing setting.' : null, reasonNotes].filter(Boolean).join(' ') || null;
      await client.query(
        `UPDATE children
            SET notice_given_date = $2, leave_date = $3, leave_date_manual = true,
                leave_reason = COALESCE($4, leave_reason), leave_reason_notes = COALESCE($5, leave_reason_notes),
                updated_at = now()
          WHERE id = $1`, [childId, noticeDate, pv.chosen_last_day, leaveReason, notes]);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection gone */ }
      throw e;
    } finally { client.release(); }

    await recordAudit({ req, action: 'create', entity_type: 'child_leaving_notice', entity_id: noticeId, actor_type: 'parent', actor_email: email,
      // `previous` matters when the office had typed a date already: the parent's notice replaces it on the child
      // record, and this is the only place the earlier value survives.
      meta: { child_id: childId, revision: !!standing, short_notice: pv.short_notice, chosen_last_day: pv.chosen_last_day,
              previous: { notice_given_date: child.notice_given_date, leave_date: child.leave_date } } });

    // Tell management INSIDE Wren — a card on the What-needs-me board (its collector reads the table) and a
    // bell notification. Neither names the child: the card links to the profile, where the access checks live.
    try {
      require('../services/notification-dispatcher').notify('leaving_notice', 'all-managers', null,
        standing ? 'A family has changed their child\'s last day' : 'A family has given notice',
        `Given in the parents app. Last day: ${L.longDate(pv.chosen_last_day)}. Open the child profile in Roost to see who and to acknowledge.`,
        { relatedTable: 'children', relatedId: childId, link: `/child-profile.html?id=${childId}` });
    } catch (e) { console.error('[leaving] notify:', e.message); }

    // The acknowledgement: it says the notice is recorded and to open the app for the dates, and nothing
    // else — no child, no date. Parent-initiated and a contract acknowledgement, so it may go; sent through
    // the one direct transport so the dev guard is a stop (not a fall-through to n8n).
    let acknowledged = false;
    try {
      const r = await sendDirectEmail({
        to: email, eventType: 'leaving-notice-ack',
        subject: 'We have your notice — Your Nursery',
        text: 'Hello,\n\nWe have received your notice and it is recorded. Please open the Your Nursery app to see the dates.\n\nYour Nursery',
        html: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#1e293b"><p>Hello,</p>'
            + '<p>We have received your notice and it is recorded. Please open the Your Nursery app to see the dates.</p>'
            + '<p style="font-size:12px;color:#94a3b8">Your Nursery</p></div>',
      });
      acknowledged = r.sent;
    } catch (e) { console.error('[leaving] ack email:', e.message); }

    res.status(201).json({ ok: true, notice_id: noticeId, revision: !!standing, preview: pv, acknowledged_by_email: acknowledged, keepsake_url: '/welcome/keepsake' });
  } catch (e) { console.error('[leaving] give:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// /welcome/keepsake/api  (state / create / send-link)
// ═════════════════════════════════════════════════════════════════════════════
const keepsakeRouter = express.Router();
keepsakeRouter.use(parentsOnly, noStore, express.json({ limit: '4kb' }));

// Minting walks thousands of photos. One attempt per child per 10 minutes, five a day.
const CREATE_GAP_S = 10 * 60, CREATE_PER_DAY = 5;
const LINK_GAP_S = 2 * 60, LINK_PER_DAY = 5;
const inFlight = new Set();                       // child ids being built right now (one process — prod is one container)

async function lastAttempts(db, childId, outcomes) {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS day,
            COALESCE(EXTRACT(EPOCH FROM (now() - max(created_at)))::int, NULL) AS since_last
       FROM keepsake_requests WHERE child_id = $1 AND outcome = ANY($2)`, [childId, outcomes]);
  return rows[0];
}
function limitVerdict(a, gapS, perDay) {
  if (a.since_last != null && a.since_last < gapS) return { blocked: 'rate_limited', retry_after_seconds: gapS - a.since_last };
  if (a.day >= perDay) return { blocked: 'daily_limit', retry_after_seconds: 3600 };
  return null;
}
const maskEmail = e => { const [u, d] = String(e).split('@'); return (u ? u[0] : '') + '***@' + (d || ''); };
const isoDay = d => new Date(d).toISOString().slice(0, 10);   // a timestamptz, not a DATE — UTC day is what we want to show

keepsakeRouter.get('/state', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const kids = await ownedChildren(db, email);
    const out = [];
    for (const c of kids) {
      const leaving = !!(c.notice_given_date || c.leave_date);
      const { rows } = await db.query(
        `SELECT id, token, media_count, expires_at, created_at, source,
                COALESCE((snapshot->'withheld'->>'group_media')::int, 0) AS withheld
           FROM leavers_gift_packages WHERE child_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
            AND media_count > 0                          -- an empty book minted earlier (staff, or the 06:00 auto-mint) is not shown as "your book"
          ORDER BY created_at DESC LIMIT 1`, [c.id]);
      const pkg = rows[0] || null;
      if (!leaving && !pkg) continue;                           // nothing to show for a child who is not leaving
      const a = await lastAttempts(db, c.id, ['minted', 'no_media']);
      const verdict = limitVerdict(a, CREATE_GAP_S, CREATE_PER_DAY);
      const gathering = !pkg && (await db.query(
        `SELECT 1 FROM keepsake_requests WHERE child_id = $1 AND outcome = 'no_media' AND created_at > now() - interval '14 days' LIMIT 1`, [c.id])).rows.length > 0;
      out.push({
        child_id: c.id, name: label(c), leaving,
        leave_text: c.leave_date ? L.longDate(c.leave_date) : null,
        package: pkg ? {
          url: `/keepsake/${pkg.token}`, download_url: `/keepsake/${pkg.token}/download`, pdf_url: `/keepsake/${pkg.token}/book.pdf`,
          media_count: pkg.media_count, withheld: pkg.withheld,
          covers_up_to_text: L.longDate(isoDay(pkg.created_at)),
          expires_text: pkg.expires_at ? L.longDate(isoDay(pkg.expires_at)) : null,
        } : null,
        can_create: leaving && !inFlight.has(c.id) && !verdict,
        create_blocked: !leaving ? 'not_leaving' : (inFlight.has(c.id) ? 'in_progress' : (verdict ? verdict.blocked : null)),
        retry_after_seconds: verdict ? verdict.retry_after_seconds : null,
        gathering,
      });
    }
    res.json({ children: out, email_hint: maskEmail(email) });
  } catch (e) { console.error('[keepsake] state:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

keepsakeRouter.post('/create', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const childId = parseInt((req.body || {}).child_id, 10);
  const db = getPool();
  try {
    const child = await ownedChild(db, email, childId);          // 🔒 a token naming child A cannot mint for child B
    if (!child) return res.status(403).json({ error: 'Not your child' });
    if (!(child.notice_given_date || child.leave_date)) {
      return res.status(403).json({ error: 'A memory book can be made once your child\'s leaving date is set.', reason: 'not_leaving' });
    }
    if (inFlight.has(childId)) return res.status(429).json({ error: 'We are already making it — this takes a minute.', reason: 'in_progress', retry_after_seconds: 30 });

    const verdict = limitVerdict(await lastAttempts(db, childId, ['minted', 'no_media']), CREATE_GAP_S, CREATE_PER_DAY);
    if (verdict) {
      return res.status(429).json({
        error: verdict.blocked === 'daily_limit' ? 'That is as many as we can make today — please try again tomorrow.'
                                                  : 'You just made one — please wait a few minutes before making it again.',
        reason: verdict.blocked, retry_after_seconds: verdict.retry_after_seconds });
    }

    inFlight.add(childId);
    try {
      const had = (await db.query(`SELECT 1 FROM leavers_gift_packages WHERE child_id=$1 AND status='active' LIMIT 1`, [childId])).rows.length > 0;
      const minted = await M.mintPackage(db, {
        childId, source: 'parent', createdByName: 'Parent (self-serve)', createdByEmail: email, requireMedia: true });
      const action = had ? 'remake' : 'create';
      const withheld = minted.snap ? ((minted.snap.withheld || {}).group_media || 0) : 0;

      if (!minted.ok && minted.reason === 'no_media') {
        // Never hand a family an empty book, and never let a parent be the one who finds the media sync broken.
        await db.query(
          `INSERT INTO keepsake_requests (child_id, parent_email, action, outcome, media_count, withheld) VALUES ($1,$2,$3,'no_media',0,$4)`,
          [childId, email, action, withheld]);
        try {
          require('../services/notification-dispatcher').notify('keepsake_empty', 'all-managers', null,
            'A family asked for a memory book and it came back empty',
            'The photos have not synced for this child. Nothing was made and the family was told it is being gathered. Check the EyLog media sync, then make the book in Roost.',
            { relatedTable: 'children', relatedId: childId, link: `/child-profile.html?id=${childId}` });
        } catch (e) { console.error('[keepsake] notify:', e.message); }
        return res.status(409).json({ ok: false, reason: 'gathering',
          error: `We are still gathering ${label(child)}'s photos — we will have this ready shortly.` });
      }
      if (!minted.ok) return res.status(404).json({ error: 'Child not found' });

      await db.query(
        `INSERT INTO keepsake_requests (child_id, parent_email, action, outcome, package_id, media_count, withheld) VALUES ($1,$2,$3,'minted',$4,$5,$6)`,
        [childId, email, action, minted.package.id, minted.package.media_count, withheld]);
      await recordAudit({ req, action: 'create', entity_type: 'leavers_gift', entity_id: minted.package.id, actor_type: 'parent', actor_email: email,
        meta: { child_id: childId, media: minted.package.media_count, withheld, self_serve: true, remake: had, revoked: minted.revoked } });
      res.status(201).json({ ok: true, remade: had, url: `/keepsake/${minted.package.token}`, media_count: minted.package.media_count, withheld });
    } finally { inFlight.delete(childId); }
  } catch (e) { console.error('[keepsake] create:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

keepsakeRouter.post('/send-link', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const childId = parseInt((req.body || {}).child_id, 10);
  const db = getPool();
  try {
    const child = await ownedChild(db, email, childId);
    if (!child) return res.status(403).json({ error: 'Not your child' });
    const { rows } = await db.query(
      `SELECT id, token, expires_at FROM leavers_gift_packages
        WHERE child_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now()) AND media_count > 0
        ORDER BY created_at DESC LIMIT 1`, [childId]);
    if (!rows.length) return res.status(404).json({ error: 'There is no memory book to send yet.', reason: 'no_package' });
    const verdict = limitVerdict(await lastAttempts(db, childId, ['link_sent']), LINK_GAP_S, LINK_PER_DAY);
    if (verdict) return res.status(429).json({ error: 'We have just sent that — please check your inbox, or try again in a few minutes.', reason: verdict.blocked, retry_after_seconds: verdict.retry_after_seconds });

    const pkg = rows[0];
    // To the signed-in parent's OWN address — never one taken from the request body.
    const mail = await M.sendLinkEmail({ to: email, token: pkg.token, childName: label(child), expiresAt: pkg.expires_at, eventType: 'keepsake-link-self' });
    await db.query(`INSERT INTO keepsake_requests (child_id, parent_email, action, outcome, package_id) VALUES ($1,$2,'send_link','link_sent',$3)`, [childId, email, pkg.id]);
    await db.query(`UPDATE leavers_gift_packages SET sent_at = now(), sent_to = $2, sent_count = COALESCE(sent_count,0) + 1 WHERE id = $1`, [pkg.id, email]);
    await recordAudit({ req, action: 'send', entity_type: 'leavers_gift', entity_id: pkg.id, actor_type: 'parent', actor_email: email,
      meta: { child_id: childId, self_serve: true, emailed: mail.sent } });
    res.json({ ok: true, emailed: mail.sent, to_hint: maskEmail(email), url: `/keepsake/${pkg.token}`,
      note: mail.sent ? null : (mail.disabled ? 'Email is switched off in this environment — copy the link instead.' : 'We could not send the email just now — copy the link instead.') });
  } catch (e) { console.error('[keepsake] send-link:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

module.exports = { leavingRouter, keepsakeRouter };
