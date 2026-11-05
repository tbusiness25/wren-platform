'use strict';
// ===========================================================================
// waitlist.js — Waitlist qualitative data + "Wren thoughts" (2026-08-03)
//
// Manager-facing enrichment of ladn.waiting_list, ADDITIVE to the existing
// admissions surfaces (src/routes/enquiries.js keeps the base CRUD; this router
// adds the qualitative capture, AI analysis, priority scoring, termly update
// email, auto-remove/reserve routine and a read-only conversation timeline).
//
// Mount (server-unified.js, alongside the other authed /api routers):
//   app.use('/api/waitlist', require('../../src/routes/waitlist'));
//
// Endpoints (all manager-only unless noted):
//   GET    /api/waitlist                 → enriched list (age-derived + priority_score, recomputed)
//   GET    /api/waitlist/:id             → single row + timeline summary
//   PUT    /api/waitlist/:id             → update qualitative fields (additive, only provided keys)
//   POST   /api/waitlist/:id/analyse     → "Wren thoughts" via local Ollama; stores wren_thoughts
//   POST   /api/waitlist/rescore         → recompute + persist priority_score for all active rows
//   POST   /api/waitlist/termly-update   → generate + (guarded) send each family a status email
//   POST   /api/waitlist/auto-actions/run→ flag remove / reserve_ready by list_duration + age
//   GET    /api/waitlist/:id/timeline    → read-only Vapi calls + emails/messages matched to enquiry
// ===========================================================================
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const ai = require('../lib/ai-models');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
let sendEmail;
try { ({ sendEmail } = require('../utils/email')); } catch (_) { sendEmail = async () => ({ skipped: true }); }

const OLLAMA_URL = ai.host();
// Interactive analysis — ai-models.js role 'default', resolved per call.
// (b333: was OLLAMA_WAITLIST_MODEL / qwen3.6:35b-a3b.)
const WAITLIST_MODEL = () => ai.model('default');

const SCHOOL_START_MONTHS = 60;   // reception exit ≈ age 5 (60 months)
const PRESCHOOL_MIN_MONTHS = 24;  // transfer to pre-school ≈ age 2

router.use(authenticate);

// Manager-only gate (headteacher is already mapped to 'manager' in auth.js).
function requireManager(req, res, next) {
  if (req.user && hasRole(req.user, ['manager', 'admin'])) return next();
  return res.status(403).json({ error: 'Manager access required' });
}

// ── helpers ────────────────────────────────────────────────────────────────
const ymd = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
function ageMonthsAt(dob, at) {
  if (!dob) return null;
  const a = new Date(at || Date.now());
  const b = new Date(dob);
  return (a - b) / (1000 * 60 * 60 * 24 * 30.4375);
}
function monthsBetween(from, to) {
  if (!from) return null;
  return (new Date(to || Date.now()) - new Date(from)) / (1000 * 60 * 60 * 24 * 30.4375);
}

// ───────────────────────────────────────────────────────────────────────────
// PRIORITY SCORE  (higher = place sooner)  — range ~0..100
//
//   priority_score = RETENTION(0..60) + DURATION(0..20) + COMMITMENT(0..20)
//
// 1) RETENTION (weight 60) — the pre-school retention rule Toby asked for:
//    a child who would stay until reception (school-age exit at 60 months) ranks
//    ABOVE one who would leave at 3. retentionMonths = 60 − ageAtStart (capped
//    0..60), scaled /60*60. So the YOUNGER a child is at their requested start,
//    the longer they retain a place, the higher they score. DOB unknown → neutral 30.
// 2) DURATION requested / willingness to wait (weight 20):
//    min(list_duration_months, 24)/24*20  — a family prepared to hold on longer
//    (or wanting a longer placement) is worth more of the scarce seat.
// 3) COMMITMENT (weight 20): deposit_paid 10 + existing_family 4 (sibling already
//    with us = retention + goodwill) + flexible_start 3 + flexible_parttime 3
//    (easier to slot into an awkward opening).
// ───────────────────────────────────────────────────────────────────────────
function computePriority(row) {
  const startAt = row.expected_start_date || new Date();
  let ageAtStart = ageMonthsAt(row.child_dob, startAt);
  let retentionMonths;
  if (ageAtStart == null) retentionMonths = 30; // neutral when DOB missing
  else retentionMonths = Math.max(0, Math.min(SCHOOL_START_MONTHS, SCHOOL_START_MONTHS - ageAtStart));
  const retention = (retentionMonths / SCHOOL_START_MONTHS) * 60;

  const dur = Math.max(0, Math.min(24, Number(row.list_duration_months) || 0)) / 24 * 20;

  let commitment = 0;
  if (row.deposit_paid) commitment += 10;
  if (row.existing_family && String(row.existing_family).trim()) commitment += 4;
  if (row.flexible_start) commitment += 3;
  if (row.flexible_parttime) commitment += 3;
  commitment = Math.min(20, commitment);

  return Math.round((retention + dur + commitment) * 10) / 10;
}

function withDerived(row) {
  const ageNowM = ageMonthsAt(row.child_dob, new Date());
  const ageAtStartM = ageMonthsAt(row.child_dob, row.expected_start_date || new Date());
  return {
    ...row,
    age_months_now: ageNowM == null ? null : Math.round(ageNowM),
    age_months_at_start: ageAtStartM == null ? null : Math.round(ageAtStartM),
    months_on_list: row.date_added ? Math.round(monthsBetween(row.date_added, new Date())) : null,
    priority_score: computePriority(row),
  };
}

// ── local Ollama (non-streaming) ────────────────────────────────────────────
async function askOllama(prompt, { model = WAITLIST_MODEL(), timeoutMs = 90000 } = {}) {
  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // b333: think:false added — the role model is a thinking model, and without it the
    // reasoning runs first (slow) and can leave `response` empty.
    body: JSON.stringify({ model, prompt, stream: false, think: false, options: ai.options({ temperature: 0.3 }) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.response || '').trim();
}

// Non-identifying attribute bag for the model — deliberately NO child/parent names.
function attrBag(row) {
  const ageNow = ageMonthsAt(row.child_dob, new Date());
  const ageStart = ageMonthsAt(row.child_dob, row.expected_start_date || new Date());
  const days = Array.isArray(row.preferred_days) && row.preferred_days.length
    ? row.preferred_days.join(', ')
    : (row.days_needed ? `${row.days_needed} days/week` : 'not specified');
  return [
    `Room requested: ${row.room_needed || 'not specified'}`,
    ageNow != null ? `Current age: ~${Math.round(ageNow)} months` : 'Current age: unknown',
    ageStart != null ? `Age at requested start: ~${Math.round(ageStart)} months` : '',
    row.expected_start_date ? `Requested start: ${ymd(row.expected_start_date)}` : 'Requested start: flexible',
    `Days requested: ${days}`,
    row.funded_hours_type ? `Funding: ${row.funded_hours_type}` : '',
    row.flexible_start ? 'Flexible on start date' : '',
    row.flexible_parttime ? 'Flexible on part-time / days' : '',
    row.existing_family ? `Existing family link: ${row.existing_family}` : '',
    row.list_duration_months ? `Willing to wait / duration: ${row.list_duration_months} months` : '',
    row.how_heard ? `How they heard: ${row.how_heard}` : '',
  ].filter(Boolean).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /  — enriched list (recomputes priority_score on read; persists if drifted)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT * FROM waiting_list_live
      WHERE COALESCE(status,'waiting') NOT IN ('placed','declined')
      ORDER BY COALESCE(priority_score,0) DESC, date_added ASC`);
    // Preserve each row's stored score BEFORE deriving, so we only persist when the
    // recomputed score genuinely drifted (was comparing to an unset field → every
    // list load rewrote every row). (L3 fix)
    const enriched = rows.map(row => {
      const orig = row.priority_score;
      const d = withDerived(row);
      d.__orig_priority = orig;
      return d;
    });
    // best-effort persist of recomputed scores (does not block the response)
    Promise.all(enriched
      .filter(r => r.priority_score != null && Number(r.priority_score) !== Number(r.__orig_priority))
      .map(r => db.query(`UPDATE waiting_list SET priority_score=$1 WHERE id=$2`, [r.priority_score, r.id])))
      .catch(e => console.error('[waitlist] score persist:', e.message));
    res.json(enriched);
  } catch (e) {
    console.error('[waitlist GET]', e.message);
    res.status(500).json({ error: 'Failed to load waitlist' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /:id
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:id', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT * FROM waiting_list WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(withDerived(rows[0]));
  } catch (e) {
    console.error('[waitlist GET id]', e.message);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PUT /:id  — update qualitative fields (additive; only provided keys touched)
// ═══════════════════════════════════════════════════════════════════════════
const EDITABLE = ['flexible_start', 'flexible_parttime', 'how_heard', 'existing_family',
  'list_duration_months', 'auto_action', 'private_notes', 'notes', 'room_needed',
  'expected_start_date', 'days_needed', 'preferred_days', 'status', 'tier', 'priority'];
const AUTO_ACTIONS = ['keep', 'remove', 'reserve_ready'];

router.put('/:id', requireManager, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const sets = [], vals = [];
  let i = 1;
  for (const k of EDITABLE) {
    if (!(k in b)) continue;
    if (k === 'auto_action' && b[k] != null && !AUTO_ACTIONS.includes(b[k])) {
      return res.status(400).json({ error: `auto_action must be one of ${AUTO_ACTIONS.join('|')}` });
    }
    sets.push(`${k}=$${i++}`);
    vals.push(b[k] === '' ? null : b[k]);
  }
  if (!sets.length) return res.status(400).json({ error: 'No editable fields provided' });
  vals.push(req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE waiting_list SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // recompute + persist priority after any qualitative change
    const score = computePriority(rows[0]);
    await db.query(`UPDATE waiting_list SET priority_score=$1 WHERE id=$2`, [score, req.params.id]);
    res.json(withDerived({ ...rows[0], priority_score: score }));
  } catch (e) {
    console.error('[waitlist PUT]', e.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /rescore  — recompute + persist priority_score for all active rows
// ═══════════════════════════════════════════════════════════════════════════
router.post('/rescore', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT * FROM waiting_list_live WHERE COALESCE(status,'waiting') NOT IN ('placed','declined')`);
    let n = 0;
    for (const r of rows) {
      await db.query(`UPDATE waiting_list SET priority_score=$1 WHERE id=$2`, [computePriority(r), r.id]);
      n++;
    }
    res.json({ ok: true, rescored: n });
  } catch (e) {
    console.error('[waitlist rescore]', e.message);
    res.status(500).json({ error: 'Rescore failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /:id/analyse  — "Wren thoughts": fit analysis + priority steer + selling points
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:id/analyse', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT * FROM waiting_list WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];
    const priority = computePriority(row);

    // Non-identifying context on current openings so the model can reason about
    // replacement-fit for a leaver (best-effort; empty is fine).
    let leaverCtx = '';
    try {
      const { rows: leavers } = await db.query(`
        SELECT room_id, TO_CHAR(leave_date,'YYYY-MM') AS m, COUNT(*)::int n
        FROM children WHERE is_active=true AND leave_date IS NOT NULL
          AND leave_date >= CURRENT_DATE AND leave_date < CURRENT_DATE + INTERVAL '9 months'
        GROUP BY room_id, TO_CHAR(leave_date,'YYYY-MM') ORDER BY m`);
      if (leavers.length) leaverCtx = 'Upcoming leavers (openings) by month: '
        + leavers.map(l => `${l.m}×${l.n}`).join(', ');
    } catch (_) { /* non-fatal */ }

    const prompt =
`You are Wren, an admissions assistant for a UK day nursery (Early Years, EYFS).
Analyse how well this waiting-list family fits, using ONLY the attributes below.
Do NOT invent names or personal details.

ATTRIBUTES:
${attrBag(row)}
${leaverCtx ? '\n' + leaverCtx : ''}
Computed internal priority score (0-100, higher = place sooner): ${priority}

Write a concise analysis (max ~140 words) in three short labelled parts:
1) FIT: replacement-fit for an upcoming leaver, and the age-based retention logic
   (a younger child is likely to stay longer, up to reception/school age ~5).
2) PRIORITY STEER: one line — how highly to prioritise this family and why.
3) SELLING POINTS: 2-3 short bullet points we could use to keep this family warm,
   drawing on our strengths: consistency of key-person care, a thorough structured
   phonics programme, and encouraging independent next steps in learning.
Return plain text only.`;

    const model = WAITLIST_MODEL();   // resolved once: the model asked is the model returned
    let text;
    try {
      text = await askOllama(prompt, { model });
    } catch (e) {
      console.error('[waitlist analyse] ollama:', e.message);
      return res.status(502).json({ error: 'AI model unavailable', detail: e.message });
    }
    if (!text) return res.status(502).json({ error: 'AI returned empty response' });

    await db.query(
      `UPDATE waiting_list SET wren_thoughts=$1, wren_thoughts_at=NOW(), priority_score=$2 WHERE id=$3`,
      [text, priority, req.params.id]);
    res.json({ ok: true, wren_thoughts: text, wren_thoughts_at: new Date().toISOString(), priority_score: priority, model });
  } catch (e) {
    console.error('[waitlist analyse]', e.message);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /:id/timeline  — read-only conversation audit (Vapi calls + emails/messages)
//   Best-effort matching by enquiry_id, parent email and parent phone (loose,
//   last-9-digits). Purely read; returns metadata + short previews.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:id/timeline', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT * FROM waiting_list WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];
    const email = (row.parent_email || '').toLowerCase() || null;
    const phoneDigits = (row.parent_phone || '').replace(/[^0-9]/g, '');
    const phoneTail = phoneDigits.length >= 9 ? phoneDigits.slice(-9) : null;
    const enquiryId = row.enquiry_id || null;

    const events = [];

    // Vapi calls matched by phone tail (from_number or to_number).
    if (phoneTail) {
      try {
        const { rows: calls } = await db.query(`
          SELECT id, started_at, duration_seconds, from_number, to_number, urgency, outcome,
                 LEFT(COALESCE(summary,''),240) AS summary
          FROM vapi_calls
          WHERE right(regexp_replace(COALESCE(from_number,''),'[^0-9]','','g'),9)=$1
             OR right(regexp_replace(COALESCE(to_number,''),'[^0-9]','','g'),9)=$1
          ORDER BY started_at DESC LIMIT 25`, [phoneTail]);
        for (const c of calls) events.push({
          type: 'call', at: c.started_at, source: 'vapi',
          summary: c.summary, meta: { duration_seconds: c.duration_seconds, urgency: c.urgency, outcome: c.outcome },
        });
      } catch (e) { console.error('[timeline vapi]', e.message); }
    }

    // thread_messages matched by enquiry_id / sender email / sender phone.
    try {
      const conds = [], params = [];
      if (enquiryId) { params.push(enquiryId); conds.push(`enquiry_id=$${params.length}`); }
      if (email) { params.push(email); conds.push(`lower(sender_email)=$${params.length}`); }
      if (phoneTail) { params.push(phoneTail); conds.push(`right(regexp_replace(COALESCE(sender_phone,''),'[^0-9]','','g'),9)=$${params.length}`); }
      if (conds.length) {
        const { rows: tm } = await db.query(`
          SELECT id, direction, source, created_at, LEFT(COALESCE(body_text,''),240) AS body
          FROM thread_messages WHERE ${conds.join(' OR ')}
          ORDER BY created_at DESC LIMIT 40`, params);
        for (const m of tm) events.push({
          type: 'message', at: m.created_at, source: m.source || 'thread',
          direction: m.direction, summary: m.body, meta: {},
        });
      }
    } catch (e) { console.error('[timeline thread_messages]', e.message); }

    // parent-portal messages matched by parent_email.
    if (email) {
      try {
        const { rows: msgs } = await db.query(`
          SELECT id, sender_type, created_at, LEFT(COALESCE(body,''),240) AS body
          FROM messages WHERE lower(parent_email)=$1
          ORDER BY created_at DESC LIMIT 25`, [email]);
        for (const m of msgs) events.push({
          type: 'message', at: m.created_at, source: 'parent_portal',
          direction: m.sender_type === 'parent' ? 'in' : 'out', summary: m.body, meta: {},
        });
      } catch (e) { console.error('[timeline messages]', e.message); }
    }

    events.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    res.json({
      matched_on: { enquiry_id: enquiryId, has_email: !!email, has_phone: !!phoneTail },
      count: events.length,
      events,
    });
  } catch (e) {
    console.error('[waitlist timeline]', e.message);
    res.status(500).json({ error: 'Timeline failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Termly update email — shared builder (reused by the route + could be cr* driven)
// ═══════════════════════════════════════════════════════════════════════════
async function buildTermlyUpdates(db) {
  const { rows } = await db.query(`
    SELECT * FROM waiting_list_live
    WHERE COALESCE(status,'waiting') NOT IN ('placed','declined','withdrawn')
      AND COALESCE(tier,'active') IN ('active','ready','parked')
    ORDER BY room_needed, COALESCE(priority_score,0) DESC, date_added ASC`);
  // rank/position within room by priority
  const posByRoom = {};
  const out = [];
  const seenEmail = new Set();
  for (const r of rows) {
    const room = r.room_needed || 'General';
    posByRoom[room] = (posByRoom[room] || 0) + 1;
    const position = posByRoom[room];
    // One family, one email. The waiting list holds duplicate rows for the same
    // family (the EyLog pipeline import creates a second row), and this loop used
    // to build one message per ROW. On 2026-09-01 that sent all three contactable
    // families their update twice — and because position is counted per row, the
    // duplicates landed on consecutive numbers, so one parent was told they were
    // 10th and then 11th. Keep the first (best) position and skip the rest.
    const key = (r.parent_email || '').trim().toLowerCase();
    if (key) {
      if (seenEmail.has(key)) continue;
      seenEmail.add(key);
    }
    const child = (r.child_first_name || '').trim() || 'your child';
    const subject = `Your Nursery — your waiting list update`;
    const text =
`Hello ${(r.parent_name || 'there').trim()},

Just a quick update to let you know ${child} is still on our waiting list for ${room}.
You are currently number ${position} on the ${room} list. We review the list each term and
will be in touch as soon as a suitable place looks likely${r.expected_start_date ? ` around your requested start of ${ymd(r.expected_start_date)}` : ''}.

There is nothing you need to do — we're keeping your place warm. If your plans have changed,
or you'd like to update your preferred days or start date, just reply to this email.

Warm wishes,
Your Nursery, Ealing`;
    out.push({ id: r.id, to: r.parent_email || null, position, room, subject, text });
  }
  return out;
}

// Send the termly updates. dryRun=true (default) just counts. Guarded/best-effort:
// sendEmail() already prefers Gmail API, falls back to SMTP, and no-ops+logs when
// neither is configured (dev). Callable from cron (see report).
/**
 * Build, and only send when a person has said so for THIS run.
 *
 * 2026-09-08: `dryRun:false` was enough to email real families, and a cron passed
 * exactly that at 09:00 on 1 September. Toby had not authorised any of it and
 * heard about it from a colleague. Sending now additionally requires
 * `confirmedBy` — a staff id, which a cron has no way to invent — so an
 * automated caller cannot reach a parent however it sets dryRun.
 * See wren-docs/decisions/2026-09-08-no-auto-parent-email.md.
 */
async function sendTermlyUpdates(db, { dryRun = true, confirmedBy = null } = {}) {
  const updates = await buildTermlyUpdates(db);
  let sent = 0, skipped = 0, failed = 0;
  const live = !dryRun && Number.isInteger(confirmedBy) && confirmedBy > 0;
  if (!dryRun && !live) {
    console.warn('[termly-update] send refused: no confirmedBy staff id — treating as dry run');
  }
  for (const u of updates) {
    if (!u.to || !live) { skipped++; continue; }
    try {
      const r = await sendEmail({ to: u.to, subject: u.subject, text: u.text });
      if (r && r.skipped) skipped++; else sent++;
    } catch (e) { failed++; console.error('[termly-update send]', e.message); }
  }
  return { total: updates.length, sent, skipped, failed, live, recipients: updates.filter(u => u.to).length };
}

// POST /termly-update — DRY-RUN by default; pass {send:true} to actually send.
router.post('/termly-update', requireManager, async (req, res) => {
  const db = getPool();
  const doSend = req.body && req.body.send === true;
  try {
    const r0 = await sendTermlyUpdates(db, { dryRun: !doSend, confirmedBy: req.user && req.user.id });
    const { total, sent, skipped, failed } = r0;
    res.json({
      ok: true, dry_run: !doSend, total, sent, skipped, failed,
      note: doSend ? undefined : 'Dry run — no emails sent. POST {"send":true} to actually send.',
      // preview counts only, never row content in the log
    });
  } catch (e) {
    console.error('[waitlist termly-update]', e.message);
    res.status(500).json({ error: 'Termly update failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Auto-remove / reserve-ready routine — callable from cron (see report crontab).
//   Rule (based on list_duration_months + date_added):
//     monthsOnList >= list_duration_months + 3  → auto_action='remove'
//     monthsOnList >= list_duration_months       → auto_action='reserve_ready'
//   Only active/waiting rows with a stated list_duration_months are touched.
//   Never deletes — just flags auto_action + (optionally) queues a status email.
// ═══════════════════════════════════════════════════════════════════════════
async function runAutoActions(db, { dryRun = true } = {}) {
  const { rows } = await db.query(`
    SELECT * FROM waiting_list_live
    WHERE COALESCE(status,'waiting') NOT IN ('placed','declined','withdrawn')
      AND list_duration_months IS NOT NULL AND list_duration_months > 0`);
  const results = { checked: rows.length, flagged_remove: 0, flagged_reserve: 0, queued_emails: 0, changes: [] };
  for (const r of rows) {
    const monthsOnList = r.date_added ? monthsBetween(r.date_added, new Date()) : 0;
    let action = null;
    if (monthsOnList >= r.list_duration_months + 3) action = 'remove';
    else if (monthsOnList >= r.list_duration_months) action = 'reserve_ready';
    if (!action || action === r.auto_action) continue;
    results.changes.push({ id: r.id, from: r.auto_action || null, to: action, months_on_list: Math.round(monthsOnList) });
    if (action === 'remove') results.flagged_remove++; else results.flagged_reserve++;
    if (!dryRun) {
      // b251 (2026-09-01) — this used to write tier='ready'. Nothing else in Wren
      // knows that value: the tier route accepts only 'active'|'parked', and
      // engRenderWaitlist() renders exactly two tables (d.active where
      // tier='active', d.parked where tier='parked'). A row moved to 'ready' fell
      // into neither and DISAPPEARED from the Waiting list tab — the family would
      // still be on the list, still get the "a place may be opening" email above,
      // and be invisible to the three managers working the page.
      // Dormant so far only because every prod row has list_duration_months NULL,
      // so the weekly 06:30 Monday cron checks 0 rows. Set the flag that actually
      // means "call them first" — ready_reserve, which the ⚡ badge, the summary
      // chip and the Reserve Ready ranking (+15) all already read — and leave the
      // tier alone so the row stays visible where it was.
      const setReserve = action === 'reserve_ready';
      await db.query(
        `UPDATE waiting_list SET auto_action=$1, ready_reserve = ready_reserve OR $2 WHERE id=$3`,
        [action, setReserve, r.id]);
      // queue an email best-effort
      if (r.parent_email) {
        const subject = action === 'remove'
          ? 'Your Nursery — waiting list check-in'
          : 'Your Nursery — a place may be opening for you';
        const text = action === 'remove'
          ? `Hello ${(r.parent_name || 'there').trim()},\n\nYou've been on our waiting list for a while and we want to make sure we still have your plans right. If you'd still like to stay on the list, just reply and we'll keep your place. If we don't hear back we'll gently move you off the active list, but you're always welcome to re-enquire.\n\nWarm wishes,\nYour Nursery`
          : `Hello ${(r.parent_name || 'there').trim()},\n\nGood news — based on where you are on our list, a place may be opening up soon. We'll be in touch shortly with details. Please reply if your preferred days or start date have changed.\n\nWarm wishes,\nYour Nursery`;
        try { await sendEmail({ to: r.parent_email, subject, text }); results.queued_emails++; }
        catch (e) { console.error('[auto-actions email]', e.message); }
      }
    }
  }
  return results;
}

// POST /auto-actions/run — DRY-RUN by default; {apply:true} to persist + queue emails.
router.post('/auto-actions/run', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const out = await runAutoActions(db, { dryRun: !(req.body && req.body.apply === true) });
    res.json({ ok: true, dry_run: !(req.body && req.body.apply === true), ...out });
  } catch (e) {
    console.error('[waitlist auto-actions]', e.message);
    res.status(500).json({ error: 'Auto-actions failed' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// b184 (2026-08-18) — bulk email by pipeline stage + book a viewing
//
// Appended, not rewritten: everything above this line is untouched. Both routes
// sit AFTER the existing router.use(authenticate) at the top of this file, so
// they are authed like every other waitlist route.
//
//   GET  /api/waitlist/bulk-email/stages   → distinct pipeline stages + counts
//   POST /api/waitlist/bulk-email          → email a stage (DRY RUN by default)
//   POST /api/waitlist/:id/book-viewing    → stage → viewing + calendar + notify
//
// Route-order note: /bulk-email/stages is two segments, so the GET '/:id'
// registered earlier in this file (single segment) cannot swallow it.
// ═══════════════════════════════════════════════════════════════════════════

const { sendViaGmail, COMMS_MAILBOX } = require('../lib/gmail-sender');
const { notifyAsync } = require('../services/notification-dispatcher');
const eventReminders = require('../lib/event-reminders');

// Manager OR room leader — viewings are a room-leader job too, unlike the
// qualitative/AI routes above which stay manager-only.
function requireManagerOrRoomLeader(req, res, next) {
  if (req.user && hasRole(req.user, ['manager', 'admin', 'room_leader'])) return next();
  return res.status(403).json({ error: 'Manager or room leader access required' });
}

const BULK_BATCH = 90;          // BCC batch size — matches newsletter.js
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Resolve the families a bulk email would reach. Rows with no (or malformed)
// parent_email are counted as skipped rather than silently dropped — a manager
// deciding whether to send needs to know the list has holes in it.
async function resolveBulkRecipients(db, stage) {
  const all = !stage || stage === 'all';
  const { rows } = await db.query(
    all
      ? `SELECT id, child_first_name, parent_name, parent_email, COALESCE(status,'waiting') AS status
         FROM waiting_list_live ORDER BY id`
      : `SELECT id, child_first_name, parent_name, parent_email, COALESCE(status,'waiting') AS status
         FROM waiting_list_live WHERE COALESCE(status,'waiting') = $1 ORDER BY id`,
    all ? [] : [stage]);

  const seen = new Set();
  const recipients = [];
  let skipped_no_email = 0;
  for (const r of rows) {
    const email = String(r.parent_email || '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) { skipped_no_email++; continue; }
    if (seen.has(email)) continue;                 // one family, one email
    seen.add(email);
    recipients.push({ id: r.id, email, name: r.parent_name || '', status: r.status });
  }
  return { recipients, skipped_no_email, considered: rows.length };
}

// GET /bulk-email/stages — populates the UI dropdown from real data, so the
// stage list can never drift from what is actually in the table.
router.get('/bulk-email/stages', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT COALESCE(status,'waiting') AS stage,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE parent_email IS NOT NULL AND parent_email <> '')::int AS with_email
      FROM waiting_list_live
      GROUP BY 1 ORDER BY 2 DESC`);
    const totals = rows.reduce((a, r) => ({
      total: a.total + r.total, with_email: a.with_email + r.with_email }), { total: 0, with_email: 0 });
    res.json({ stages: rows, all: totals });
  } catch (e) {
    console.error('[waitlist bulk-email/stages]', e.message);
    res.status(500).json({ error: 'Stage lookup failed' });
  }
});

// POST /bulk-email — {stage, subject, body_html, dry_run}
// DRY RUN IS THE DEFAULT: only an explicit dry_run:false sends anything.
router.post('/bulk-email', requireManager, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const stage = (b.stage === undefined || b.stage === null || b.stage === '') ? 'all' : String(b.stage);
  const dryRun = b.dry_run !== false;   // anything other than an explicit false = preview
  const subject = String(b.subject || '').trim();
  const bodyHtml = String(b.body_html || '').trim();

  try {
    if (stage !== 'all') {
      const { rows: valid } = await db.query(
        `SELECT 1 FROM waiting_list_live WHERE COALESCE(status,'waiting')=$1 LIMIT 1`, [stage]);
      if (!valid.length) {
        return res.status(400).json({ error: `Unknown stage '${stage}' — no waiting list rows have that status.` });
      }
    }

    const { recipients, skipped_no_email, considered } = await resolveBulkRecipients(db, stage);

    if (dryRun) {
      return res.json({
        ok: true, dry_run: true, stage,
        recipient_count: recipients.length,
        recipients: recipients.map(r => r.email),
        skipped_no_email, considered,
        note: 'Dry run — nothing sent. POST the same body with "dry_run": false to send.',
      });
    }

    // ── real send from here ──────────────────────────────────────────────
    if (!subject) return res.status(400).json({ error: 'subject required to send' });
    if (!bodyHtml) return res.status(400).json({ error: 'body_html required to send' });
    if (!recipients.length) return res.status(400).json({ error: 'No recipients with a usable email address for that stage' });

    let sent = 0, failed = 0, disabled = false;
    const errors = [];
    const sentIds = [];

    for (let i = 0; i < recipients.length; i += BULK_BATCH) {
      const batch = recipients.slice(i, i + BULK_BATCH);
      try {
        // BCC so families never see each other's addresses.
        const r = await sendViaGmail({
          bcc: batch.map(x => x.email),
          subject,
          html: bodyHtml,
          from: COMMS_MAILBOX,
        });
        if (r && r.disabled) disabled = true;   // dev / MAIL_DISABLED guard tripped
        sent += batch.length;
        sentIds.push(...batch.map(x => x.id));
      } catch (err) {
        failed += batch.length;
        errors.push(err.message);
        console.error('[waitlist bulk-email send]', err.message);
      }
    }

    // Only stamp contact on families we actually reached, and only for a real
    // send — a dev/MAIL_DISABLED run must not claim we contacted anyone.
    if (sentIds.length && !disabled) {
      await db.query(
        `UPDATE waiting_list SET last_contacted_at=NOW(), last_contacted_by=$1 WHERE id = ANY($2::int[])`,
        [req.user.id, sentIds]).catch(e => console.error('[waitlist bulk-email stamp]', e.message));
    }

    res.json({
      ok: failed === 0, dry_run: false, stage,
      recipient_count: recipients.length,
      sent, failed, skipped_no_email,
      mail_disabled: disabled,
      note: disabled ? 'MAIL_DISABLED/dev environment — addresses were resolved but nothing left the building.' : undefined,
      errors: errors.length ? errors.slice(0, 5) : undefined,
    });
  } catch (e) {
    console.error('[waitlist bulk-email]', e.message);
    res.status(500).json({ error: 'Bulk email failed' });
  }
});

// ── Book a viewing ──────────────────────────────────────────────────────────
// Moves the family to the viewing stage, puts the viewing on the staff
// calendar, and tells the staff who are on it. The viewing stage value is a
// setting (waitlist_viewing_status, default 'viewing') so a setting that calls
// it something else doesn't need a code change.
async function viewingStatus(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='waitlist_viewing_status'`);
    const v = (rows[0] && String(rows[0].value || '').trim()) || '';
    return v || 'viewing';
  } catch (_) { return 'viewing'; }
}

// Accepts '2026-08-20T10:30' (datetime-local) or a full ISO string, and returns
// the date + HH:MM as the nursery would write them. Parsed as LOCAL wall-clock:
// a manager picking 10:30 means 10:30 in Ealing, not 10:30 UTC.
function splitStartsAt(raw) {
  const m = String(raw || '').match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[2], 10), min = parseInt(m[3], 10);
  if (h > 23 || min > 59) return null;
  return { date: m[1], time: String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0') };
}

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = ((h * 60 + m + mins) % 1440 + 1440) % 1440;
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

// POST /:id/book-viewing — {starts_at, duration_mins, staff_ids, notes}
router.post('/:id/book-viewing', requireManagerOrRoomLeader, async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad waiting list id' });

  const when = splitStartsAt(b.starts_at);
  if (!when) return res.status(400).json({ error: 'starts_at required (YYYY-MM-DDTHH:MM)' });

  const duration = Number.isFinite(parseInt(b.duration_mins, 10)) ? parseInt(b.duration_mins, 10) : 45;
  if (duration < 5 || duration > 480) return res.status(400).json({ error: 'duration_mins must be 5–480' });

  const staffIds = [...new Set((Array.isArray(b.staff_ids) ? b.staff_ids : [])
    .map(n => parseInt(n, 10)).filter(Number.isInteger))];
  const notes = String(b.notes || '').trim();

  try {
    const { rows: wl } = await db.query(
      `SELECT id, child_first_name, child_last_name, parent_name, room_needed, status
       FROM waiting_list WHERE id=$1`, [id]);
    if (!wl.length) return res.status(404).json({ error: 'Waiting list entry not found' });
    const fam = wl[0];

    // Reject staff ids that aren't real active staff rather than silently
    // creating an event nobody is assigned to.
    let validStaff = [];
    if (staffIds.length) {
      const { rows: sr } = await db.query(
        `SELECT id, first_name, last_name FROM staff WHERE id = ANY($1::int[]) AND is_active=true`, [staffIds]);
      validStaff = sr;
      const missing = staffIds.filter(sid => !sr.some(s => s.id === sid));
      if (missing.length) return res.status(400).json({ error: `Unknown or inactive staff id(s): ${missing.join(', ')}` });
    }

    const childFirst = (fam.child_first_name || '').trim() || 'family';
    const stage = await viewingStatus(db);

    // (a) stage + contact stamp
    await db.query(
      `UPDATE waiting_list SET status=$1, last_contacted_at=NOW(), last_contacted_by=$2 WHERE id=$3`,
      [stage, req.user.id, id]);

    // (b) the calendar row. audience='staff' keeps a viewing off the parent
    // calendar feed (calendar-feeds.js excludes audience 'staff').
    const description = [
      `Show-round for ${childFirst}${fam.child_last_name ? ' ' + fam.child_last_name : ''}`
        + (fam.parent_name ? ` (parent: ${fam.parent_name})` : '') + '.',
      fam.room_needed ? `Room of interest: ${fam.room_needed}.` : '',
      notes,
    ].filter(Boolean).join('\n');

    const { rows: evRows } = await db.query(`
      INSERT INTO events
        (title, description, event_date, start_time, end_time, location, audience,
         rsvp_required, is_published, created_by, staff_ids, source_table, source_id)
      VALUES ($1,$2,$3,$4,$5,$6,'staff',false,true,$7,$8,'waiting_list',$9)
      RETURNING id, title, event_date, start_time, end_time, staff_ids`,
      [`Viewing — ${childFirst}`, description, when.date, when.time,
       addMinutes(when.time, duration), 'Your Nursery',
       req.user.id, staffIds.length ? staffIds : null, id]);
    const ev = evRows[0];

    // (c) tell the staff who are on it. notifyAsync (not notify) so the
    // notification ids come back and can be returned as proof.
    const notification_ids = [];
    for (const s of validStaff) {
      try {
        const nid = await notifyAsync('viewing_booked', 'staff', s.id,
          `👋 Viewing — ${childFirst}`,
          `${when.date} at ${when.time} (${duration} min)`
            + (fam.room_needed ? ` · ${fam.room_needed}` : '')
            + (notes ? ` · ${notes}` : ''),
          { relatedTable: 'events', relatedId: ev.id, link: '/admissions/waitlist-manage.html' });
        if (nid) notification_ids.push(nid);
      } catch (e) {
        console.error('[book-viewing notify]', e.message);
      }
    }

    // Schedule the 24h/1h reminders inline so the caller sees them immediately;
    // the dispatcher sweep would otherwise pick this event up within 30s.
    let reminders = [];
    try { reminders = await eventReminders.scheduleEventReminders(db, ev.id); }
    catch (e) { console.error('[book-viewing reminders]', e.message); }

    // (d) proof for the caller
    res.status(201).json({
      ok: true,
      waiting_list_id: id,
      status: stage,
      event_id: ev.id,
      event: ev,
      notification_ids,
      staff_notified: validStaff.map(s => s.id),
      reminders: reminders.map(r => ({ id: r.id, staff_id: r.staff_id, lead_mins: r.lead_mins, scheduled_for: r.scheduled_for })),
    });
  } catch (e) {
    console.error('[waitlist book-viewing]', e.message);
    res.status(500).json({ error: 'Book viewing failed: ' + e.message });
  }
});


module.exports = router;
// Exported for cron scripts (auto-remove + termly email).
module.exports.runAutoActions = runAutoActions;
module.exports.buildTermlyUpdates = buildTermlyUpdates;
module.exports.sendTermlyUpdates = sendTermlyUpdates;
module.exports.computePriority = computePriority;
