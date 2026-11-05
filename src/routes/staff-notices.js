'use strict';
// staff-notices.js — b295 (2026-09-09)
//
// The running list of things staff need told, and the staff newsletter that
// assembles itself from that list.
//
// Toby: "have keep a list of things that come up in our conversation and builds
// that could go into staff newsletters — ie what changes I need to alert them
// to… memory is shit ADHD."
//
// The list is the point. The newsletter is what you do with it. Everything here
// is manager-only, and sending is always a person pressing send — there is no
// cron, no scheduler and no AI path into the send route, deliberately (see
// wren-docs/decisions/2026-09-08-no-auto-parent-email.md: the rule there is about
// parents, but these are real personal inboxes and the discipline is the same).

const express = require('express');
const router  = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { renderNewsletter } = require('../newsletter-renderer');
const { sendViaGmail, COMMS_MAILBOX } = require('../lib/gmail-sender');
const { emailAllowedForCategory } = require('../services/notification-dispatcher');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// The notification category this build classifies. It is in the dispatcher's
// EMAIL_ALLOWED_CATEGORIES because a staff bulletin is about the staff member's
// own working life and never carries child-level content — and the check below
// is what makes that classification load-bearing rather than decorative. If
// somebody removes the category from the allowlist, this route stops sending.
const NOTICE_CATEGORY = 'staff_notice_newsletter';

const MGR_ROLES = ['manager', 'deputy_manager', 'admin'];
const managerOnly = (req, res, next) => {
  if (!req.user || !hasRole(req.user, MGR_ROLES))
    return res.status(403).json({ error: 'Manager only' });
  next();
};

const URGENCIES = ['before_next_shift', 'this_week', 'whenever'];
const URGENCY_LABEL = {
  before_next_shift: 'Before your next shift',
  this_week:         'This week',
  whenever:          'When you get a minute',
};
const STATUSES = ['pending', 'included', 'sent', 'dropped'];

const clean = (v, max = 2000) => {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
};

// ── Audience ─────────────────────────────────────────────────────────────────
// 'all' | 'room_leaders' | 'managers' | 'room:<room name>'. Room audiences are
// validated against ladn.rooms rather than accepted as free text, so a typo
// cannot create a room nobody is in and silently address nobody.
async function validAudiences(db) {
  const base = ['all', 'room_leaders', 'managers'];
  try {
    const { rows } = await db.query('SELECT name FROM rooms ORDER BY id');
    return base.concat(rows.map(r => `room:${r.name}`));
  } catch (e) {
    console.error('[b295] rooms lookup failed:', e.message);
    return base;
  }
}

function audienceLabel(a) {
  if (a === 'all')          return 'Everyone';
  if (a === 'room_leaders') return 'Room leaders';
  if (a === 'managers')     return 'Managers';
  if (String(a).startsWith('room:')) return String(a).slice(5);
  return String(a || 'Everyone');
}

// Who a notice with this audience is actually addressed to. Used at send time so
// a room-specific notice is not emailed to the whole team.
function audienceWhere(audience) {
  if (audience === 'managers')     return { sql: `s.role IN ('manager','deputy_manager','admin')`, params: [] };
  if (audience === 'room_leaders') return { sql: `s.role IN ('room_leader','manager','deputy_manager','admin')`, params: [] };
  if (String(audience || '').startsWith('room:'))
    return { sql: `r.name = $1`, params: [String(audience).slice(5)] };
  return { sql: 'TRUE', params: [] };
}

router.use(authenticate, managerOnly);

// ── The list ─────────────────────────────────────────────────────────────────

// GET /  — the whole list, newest first. Dropped rows are returned too: they stay
// visible with their reason so the same idea is not re-raised and re-dropped.
router.get('/', async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT n.*, nl.title AS newsletter_title, nl.status AS newsletter_status,
             s.first_name || ' ' || s.last_name AS added_by_name
        FROM staff_notices n
        LEFT JOIN newsletters nl ON nl.id = n.newsletter_id
        LEFT JOIN staff s        ON s.id  = n.added_by
       ${status ? 'WHERE n.status = $1' : ''}
       ORDER BY n.added_at DESC, n.id DESC`, status ? [status] : []);
    const { rows: counts } = await db.query(
      `SELECT status, count(*)::int AS n FROM staff_notices GROUP BY status`);
    const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
    counts.forEach(c => { byStatus[c.status] = c.n; });
    res.json({
      notices: rows.map(r => ({ ...r, audience_label: audienceLabel(r.audience),
                                urgency_label: URGENCY_LABEL[r.urgency] || r.urgency })),
      counts: byStatus,
      audiences: await validAudiences(db),
      urgencies: URGENCIES.map(u => ({ key: u, label: URGENCY_LABEL[u] })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /summary — the Cockpit card's numbers plus the few most recent pending
// notices. Kept tiny: the card renders nothing at all if this 404s, so a deploy
// without the b295 migration shows no broken panel.
router.get('/summary', async (req, res) => {
  try {
    const db = getPool();
    const { rows: c } = await db.query(
      `SELECT status, count(*)::int AS n FROM staff_notices GROUP BY status`);
    const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
    c.forEach(r => { counts[r.status] = r.n; });
    const { rows: recent } = await db.query(`
      SELECT id, what, why_it_matters, urgency, audience, source, added_at
        FROM staff_notices WHERE status='pending'
       ORDER BY added_at DESC, id DESC LIMIT 6`);
    res.json({
      counts,
      pending: counts.pending,
      recent: recent.map(r => ({ ...r, audience_label: audienceLabel(r.audience),
                                 urgency_label: URGENCY_LABEL[r.urgency] || r.urgency })),
      urgencies: URGENCIES.map(u => ({ key: u, label: URGENCY_LABEL[u] })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /  — add one thing to the list.
router.post('/', async (req, res) => {
  const what    = clean(req.body?.what, 400);
  const why     = clean(req.body?.why_it_matters, 1200);
  const source  = clean(req.body?.source, 300);
  const urgency = URGENCIES.includes(req.body?.urgency) ? req.body.urgency : 'whenever';
  const audience = clean(req.body?.audience, 80) || 'all';
  if (!what) return res.status(400).json({ error: 'Say what staff need to know' });
  try {
    const db = getPool();
    const allowed = await validAudiences(db);
    if (!allowed.includes(audience))
      return res.status(400).json({ error: `Unknown audience "${audience}"`, audiences: allowed });
    const { rows } = await db.query(`
      INSERT INTO staff_notices (what, why_it_matters, source, audience, urgency, status, added_by)
      VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING *`,
      [what, why || null, source || null, audience, urgency, req.user.id]);
    res.json({ notice: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id — edit the wording. A sent notice is history and is not editable;
// everything else is, because the seeded text is a starting point, not the final
// word (that is the whole reason it is seeded rather than sent).
router.patch('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const sets = [], params = [id];
  const add = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };
  if (req.body?.what !== undefined) {
    const w = clean(req.body.what, 400);
    if (!w) return res.status(400).json({ error: 'Say what staff need to know' });
    add('what', w);
  }
  if (req.body?.why_it_matters !== undefined) add('why_it_matters', clean(req.body.why_it_matters, 1200) || null);
  if (req.body?.source !== undefined)         add('source',         clean(req.body.source, 300) || null);
  if (req.body?.urgency !== undefined) {
    if (!URGENCIES.includes(req.body.urgency)) return res.status(400).json({ error: 'Unknown urgency' });
    add('urgency', req.body.urgency);
  }
  try {
    const db = getPool();
    if (req.body?.audience !== undefined) {
      const a = clean(req.body.audience, 80);
      const allowed = await validAudiences(db);
      if (!allowed.includes(a)) return res.status(400).json({ error: `Unknown audience "${a}"`, audiences: allowed });
      add('audience', a);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
    const { rows } = await db.query(`
      UPDATE staff_notices SET ${sets.join(', ')}, updated_at=now()
       WHERE id=$1 AND status <> 'sent' RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ error: 'Not found, or already sent' });
    res.json({ notice: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/drop — take it off the list WITHOUT deleting it. The reason is
// required by the table constraint as well as here: a dropped notice with no
// reason is exactly the thing that gets re-raised in three months.
router.post('/:id/drop', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = clean(req.body?.reason, 500);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  if (!reason) return res.status(400).json({ error: 'Say why you are dropping it' });
  try {
    const { rows } = await getPool().query(`
      UPDATE staff_notices
         SET status='dropped', dropped_reason=$2, dropped_at=now(),
             newsletter_id=NULL, included_at=NULL, updated_at=now()
       WHERE id=$1 AND status IN ('pending','included') RETURNING *`, [id, reason]);
    if (!rows.length) return res.status(404).json({ error: 'Not found, or already sent' });
    res.json({ notice: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/restore — a dropped notice back to pending. The reason it was dropped
// stays on the row; it is history, not a mistake to be tidied away.
router.post('/:id/restore', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const { rows } = await getPool().query(`
      UPDATE staff_notices SET status='pending', dropped_at=NULL, updated_at=now()
       WHERE id=$1 AND status='dropped' RETURNING *`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not a dropped notice' });
    res.json({ notice: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── The child-name guard ─────────────────────────────────────────────────────
//
// A staff newsletter goes to PERSONAL inboxes. That is allowed because it is
// about the staff member's own working life — and it stops being allowed the
// moment it names a child. This is the check that keeps the two apart, and it
// runs on the assembled text of the actual newsletter, immediately before the
// send, not on the notices at the time they were written.
//
// Two tiers, because one tier is either useless or unusable:
//
//   HARD  — a child's first AND last name adjacent in the text. There is no
//           innocent reading of that; it cannot be acknowledged away.
//   CHECK — a first name (or preferred name) on its own. A nursery is full of
//           children called Summer, Rose, May and Sky, and a build that blocks
//           "Pre-school Summer 2 is now planned" forever is a build people route
//           around. So it still BLOCKS, but the manager can acknowledge a
//           specific word as not-a-child; the acknowledgement is recorded on the
//           newsletter (newsletters.child_check) rather than being a flag that
//           vanishes with the request.
//
// Names are read at request time and never logged. `matches` is returned to a
// manager's own browser, which is a surface that shows child names all day; it
// does not go to a log file, to Telegram, or to the recipients.
const NAME_MIN = 3;

async function childNameCheck(db, text, acknowledged = []) {
  const ack = new Set(acknowledged.map(a => String(a).trim().toLowerCase()));
  const hay = String(text || '');
  const lower = hay.toLowerCase();
  const hard = [], soft = [];
  let rows = [];
  try {
    // Every child the setting has ever held a record for — a leaver's name is
    // still a child's name. Kept to id + names; nothing else is read.
    ({ rows } = await db.query(
      `SELECT id, first_name, last_name, preferred_name FROM children`));
  } catch (e) {
    // Fail CLOSED. If the guard cannot run, the send does not happen.
    return { ok: false, error: `Could not run the child-name check: ${e.message}`, hard: [], soft: [] };
  }

  // Escape the name parts INDIVIDUALLY and only then join them with \s+. Escaping
  // the joined string escapes the separator's own backslash, which is how the
  // full-name tier silently degraded to matching a literal "\s" and never fired.
  const rxEsc = (w) => String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bounded = (body) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])(?:${body})([^\\p{L}\\p{N}]|$)`, 'iu');
  const wordRe = (w) => bounded(rxEsc(w));

  for (const c of rows) {
    const last  = String(c.last_name || '').trim();
    const firsts = [c.first_name, c.preferred_name]
      .map(f => String(f || '').trim()).filter(f => f.length >= NAME_MIN);
    for (const f of firsts) {
      if (last.length >= 2 && bounded(`${rxEsc(f)}\\s+${rxEsc(last)}`).test(hay)) {
        hard.push({ child_id: c.id, matched: `${f} ${last}` });
        continue;
      }
      if (!lower.includes(f.toLowerCase())) continue;      // cheap reject first
      if (!wordRe(f).test(hay)) continue;
      if (ack.has(f.toLowerCase())) continue;
      soft.push({ child_id: c.id, matched: f });
    }
  }
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter(m => { const k = m.matched.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  return { ok: !hard.length && !soft.length, hard: dedupe(hard), soft: dedupe(soft) };
}

// ── Assembling a staff newsletter from the list ──────────────────────────────

function noticeLine(n) {
  const what = String(n.what || '').trim();
  const why  = String(n.why_it_matters || '').trim();
  const who  = n.audience && n.audience !== 'all' ? ` _(${audienceLabel(n.audience)})_` : '';
  return why ? `**${what}**${who} — ${why}` : `**${what}**${who}`;
}

async function loadNewsletter(db, id) {
  const { rows } = await db.query(
    `SELECT * FROM newsletters WHERE id=$1 AND audience='staff'`, [id]);
  if (!rows.length) return null;
  const { rows: sections } = await db.query(
    `SELECT * FROM newsletter_sections WHERE newsletter_id=$1 ORDER BY section_order, id`, [id]);
  return { newsletter: rows[0], sections };
}

// GET /newsletters — the staff newsletters, and only ever the staff ones.
router.get('/newsletters', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT n.id, n.title, n.subject, n.status, n.sent_at, n.sent_to_count, n.created_at,
             (SELECT count(*)::int FROM staff_notices sn WHERE sn.newsletter_id = n.id) AS notice_count
        FROM newsletters n
       WHERE n.audience='staff'
       ORDER BY n.created_at DESC`);
    res.json({ newsletters: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /newsletters — draft one from the list. Pass notice_ids to choose, or
// omit them to take everything still pending. The generated text is a starting
// point: the sections are editable through the existing newsletter builder
// endpoints, and nothing here is final until a person presses send.
router.post('/newsletters', async (req, res) => {
  const ids = Array.isArray(req.body?.notice_ids)
    ? req.body.notice_ids.map(Number).filter(Number.isInteger) : null;
  const title   = clean(req.body?.title, 200) || `Staff update — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const subject = clean(req.body?.subject, 200) || title;
  const intro   = clean(req.body?.intro, 2000);
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: notices } = await client.query(
      ids && ids.length
        ? `SELECT * FROM staff_notices WHERE id = ANY($1) AND status='pending' ORDER BY added_at, id`
        : `SELECT * FROM staff_notices WHERE status='pending' ORDER BY added_at, id`,
      ids && ids.length ? [ids] : []);
    if (!notices.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Nothing pending to put in it' });
    }

    const { rows: [nl] } = await client.query(`
      INSERT INTO newsletters (title, subject, status, audience, from_name, term, academic_year)
      VALUES ($1,$2,'draft','staff',$3,$4,$5) RETURNING *`,
      [title, subject, req.body?.from_name || 'Nursery Manager', clean(req.body?.term, 60) || null,
       clean(req.body?.academic_year, 20) || null]);

    let order = 0;
    if (intro) {
      await client.query(`
        INSERT INTO newsletter_sections (newsletter_id, section_type, title, final_content, section_order)
        VALUES ($1,'text',$2,$3,$4)`, [nl.id, 'A quick word', intro, order++]);
    }
    // Grouped by urgency, in the order the urgencies actually matter.
    for (const u of URGENCIES) {
      const inGroup = notices.filter(n => n.urgency === u);
      if (!inGroup.length) continue;
      await client.query(`
        INSERT INTO newsletter_sections (newsletter_id, section_type, title, final_content, section_order, metadata)
        VALUES ($1,'text',$2,$3,$4,$5)`,
        [nl.id, URGENCY_LABEL[u], inGroup.map(noticeLine).join('\n\n'), order++,
         JSON.stringify({ b295_urgency: u, notice_ids: inGroup.map(n => n.id) })]);
    }

    await client.query(`
      UPDATE staff_notices SET status='included', newsletter_id=$1, included_at=now(), updated_at=now()
       WHERE id = ANY($2)`, [nl.id, notices.map(n => n.id)]);

    await client.query('COMMIT');
    res.json({ newsletter: nl, notices_included: notices.length, sections: order });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// GET /newsletters/:id — the draft plus its sections and the notices in it.
router.get('/newsletters/:id', async (req, res) => {
  try {
    const db = getPool();
    const found = await loadNewsletter(db, parseInt(req.params.id, 10));
    if (!found) return res.status(404).json({ error: 'Not a staff newsletter' });
    const { rows: notices } = await db.query(
      `SELECT * FROM staff_notices WHERE newsletter_id=$1 ORDER BY urgency, id`, [req.params.id]);
    res.json({ ...found, notices });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /newsletters/:id/preview — the rendered HTML, for the iframe.
router.get('/newsletters/:id/preview', async (req, res) => {
  try {
    const found = await loadNewsletter(getPool(), parseInt(req.params.id, 10));
    if (!found) return res.status(404).send('Not a staff newsletter');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderNewsletter(found.newsletter, found.sections));
  } catch (e) { res.status(500).send(String(e.message)); }
});

// POST /newsletters/:id/check — run the child-name guard without sending. Lets
// the screen show what would block BEFORE the manager commits to a send.
router.post('/newsletters/:id/check', async (req, res) => {
  try {
    const db = getPool();
    const found = await loadNewsletter(db, parseInt(req.params.id, 10));
    if (!found) return res.status(404).json({ error: 'Not a staff newsletter' });
    const ack = Array.isArray(req.body?.acknowledge) ? req.body.acknowledge : [];
    const text = found.sections.map(s =>
      `${s.title || ''}\n${s.final_content || s.ai_draft || s.raw_notes || ''}`).join('\n\n')
      + `\n${found.newsletter.title || ''}\n${found.newsletter.subject || ''}`;
    res.json(await childNameCheck(db, text, ack));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /newsletters/:id/recipients — who it would go to, as counts and addresses.
// Manager-only surface, so the addresses are shown: the manager is the person who
// has to notice that somebody's address is wrong before it is sent, not after.
router.get('/newsletters/:id/recipients', async (req, res) => {
  try {
    const db = getPool();
    const found = await loadNewsletter(db, parseInt(req.params.id, 10));
    if (!found) return res.status(404).json({ error: 'Not a staff newsletter' });
    const { recipients, skipped } = await resolveStaffRecipients(db, parseInt(req.params.id, 10));
    res.json({ total: recipients.length, recipients, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The union of the audiences of the notices in this newsletter. A newsletter
// holding one Pre-school notice and one everyone notice goes to everyone; a
// newsletter holding only the Pre-school notice goes to Pre-school. Working it
// out from the CONTENT means nobody has to remember to set it separately.
async function resolveStaffRecipients(db, newsletterId) {
  const { rows: notices } = await db.query(
    `SELECT DISTINCT audience FROM staff_notices WHERE newsletter_id=$1`, [newsletterId]);
  const audiences = notices.map(n => n.audience);
  const wide = !audiences.length || audiences.includes('all');

  const seen = new Map();
  const skipped = [];
  const push = async (audience) => {
    const w = audienceWhere(audience);
    const { rows } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.email, s.role
        FROM staff s LEFT JOIN rooms r ON r.id = s.room_id
       WHERE s.is_active = true AND COALESCE(s.is_demo, false) = false AND ${w.sql}`, w.params);
    for (const s of rows) {
      const email = String(s.email || '').trim().toLowerCase();
      const name = `${s.first_name} ${s.last_name}`.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        if (!skipped.some(x => x.staff_id === s.id)) skipped.push({ staff_id: s.id, name, reason: 'no usable email address' });
        continue;
      }
      if (!seen.has(email)) seen.set(email, { staff_id: s.id, name, email, role: s.role });
    }
  };
  if (wide) await push('all');
  else for (const a of audiences) await push(a);
  return { recipients: [...seen.values()], skipped };
}

// POST /newsletters/:id/send — a PERSON pressing send. No cron reaches this: it
// sits behind authenticate + managerOnly and takes the sender's staff id from
// the token, which a scheduled job has no way to produce.
//
// body: { acknowledge?: [word], test_email?: 'someone@example.com' }
router.post('/newsletters/:id/send', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });

  // The classification gate. A staff bulletin is emailable because it is about
  // the staff member's own working life; if that category is ever taken off the
  // dispatcher's allowlist, this route stops sending rather than quietly
  // disagreeing with the dispatcher.
  if (!emailAllowedForCategory(NOTICE_CATEGORY)) {
    return res.status(403).json({
      error: `"${NOTICE_CATEGORY}" is not on the email allowlist in `
           + `src/services/notification-dispatcher.js — nothing sent.` });
  }

  const db = getPool();
  try {
    const found = await loadNewsletter(db, id);
    if (!found) return res.status(404).json({ error: 'Not a staff newsletter' });
    if (found.newsletter.status === 'sent')
      return res.status(400).json({ error: 'Already sent' });
    if (!found.sections.length)
      return res.status(400).json({ error: 'Nothing in it to send' });

    const ack = Array.isArray(req.body?.acknowledge)
      ? req.body.acknowledge.map(a => clean(a, 60)).filter(Boolean) : [];
    const text = found.sections.map(s =>
      `${s.title || ''}\n${s.final_content || s.ai_draft || s.raw_notes || ''}`).join('\n\n')
      + `\n${found.newsletter.title || ''}\n${found.newsletter.subject || ''}`;

    const check = await childNameCheck(db, text, ack);
    await db.query(`UPDATE newsletters SET child_check=$2, updated_at=now() WHERE id=$1`,
      [id, JSON.stringify({ checked_at: new Date().toISOString(), by: req.user.id,
                            hard: check.hard, soft: check.soft, acknowledged: ack })]);
    if (check.error) return res.status(500).json({ error: check.error });
    if (check.hard.length) {
      return res.status(422).json({
        error: 'This names a child. A staff newsletter goes to personal email addresses, '
             + 'so it must never carry child-level content — edit the wording and try again.',
        blocked: true, hard: check.hard, soft: check.soft, can_acknowledge: false });
    }
    if (check.soft.length) {
      return res.status(422).json({
        error: `Not sent: ${check.soft.map(s => `"${s.matched}"`).join(', ')} `
             + `${check.soft.length === 1 ? 'is' : 'are'} also the name of a child on the register. `
             + 'Reword it, or confirm each word is not about a child.',
        blocked: true, hard: [], soft: check.soft, can_acknowledge: true });
    }

    const html = renderNewsletter(found.newsletter, found.sections);
    const subject = found.newsletter.subject || found.newsletter.title || 'Staff update — Your Nursery';
    const fromName = found.newsletter.from_name || 'Your Nursery';

    // A test send goes to one address and changes nothing: no send records, no
    // status change, and the notices stay 'included'.
    const testTo = clean(req.body?.test_email, 200).toLowerCase();
    if (testTo) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testTo))
        return res.status(400).json({ error: 'That is not an email address' });
      const r = await sendViaGmail({ to: testTo, subject: `[TEST] ${subject}`, html,
                                     from: COMMS_MAILBOX, fromName });
      return res.json({ test: true, to: testTo, disabled: !!(r && r.disabled) });
    }

    const { recipients, skipped } = await resolveStaffRecipients(db, id);
    if (!recipients.length)
      return res.status(400).json({ error: 'No staff with a usable email address', skipped });

    // BCC batches — staff must not see each other's personal addresses in a To
    // header. They are colleagues, but these are personal inboxes.
    const BATCH = 90;
    let sent = 0, failed = 0, disabled = false;
    const errors = [];
    for (let i = 0; i < recipients.length; i += BATCH) {
      const batch = recipients.slice(i, i + BATCH);
      let ok = false, errText = null;
      try {
        const r = await sendViaGmail({ bcc: batch.map(b => b.email), subject, html,
                                       from: COMMS_MAILBOX, fromName });
        if (r && r.disabled) disabled = true;
        ok = true;
      } catch (err) { errText = err.message; errors.push(err.message); }
      for (const b of batch) {
        const status = ok ? (disabled ? 'test' : 'sent') : 'failed';
        if (ok) sent++; else failed++;
        await db.query(`
          INSERT INTO staff_newsletter_sends (newsletter_id, staff_id, staff_email, staff_name, status, error_text)
          VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, b.staff_id, b.email, b.name, status, errText]).catch(() => {});
      }
    }

    await db.query(`
      UPDATE newsletters SET status='sent', sent_at=now(), sent_to_count=$2, sent_by=$3,
             rendered_html=$4, updated_at=now()
       WHERE id=$1`, [id, sent, req.user.id, html]);
    await db.query(`
      UPDATE staff_notices SET status='sent', sent_at=now(), updated_at=now()
       WHERE newsletter_id=$1 AND status='included'`, [id]);

    res.json({ sent, failed, total: recipients.length, skipped, disabled,
               errors: errors.slice(0, 3), acknowledged: ack });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
