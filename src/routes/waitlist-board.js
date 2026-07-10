'use strict';
// ===========================================================================
// PARENT WAITLIST BOARD — manager-gated control room for the public
// availability heat-map. (Toby, 2026-07-06)
//
//   GET    /api/waitlist-board/state?months=N     → computed series WITH meta
//                                                   (pre-override values, loads,
//                                                   override notes) + overrides
//   PUT    /api/waitlist-board/override           → pin a room×month cell
//   DELETE /api/waitlist-board/override           → back to computed (?room_id&month)
//   GET    /api/waitlist-board/suggestions        → next openings + ranked
//                                                   waitlist candidates per opening
//   GET    /api/waitlist-board/signals            → possible leaver notices found
//                                                   in triaged inbox email (read-only)
//   GET/PUT /api/waitlist-board/occupancy-prompt  → the "how our occupancy works"
//                                                   text (settings key) the AI uses
//   POST   /api/waitlist-board/advise             → AI narrative: what to do next
//
// Design notes:
//   • All availability maths comes from public-availability.js exports — ONE
//     source of truth, the board just adds names/meta a manager may see.
//   • Overrides live in availability_overrides and are applied inside
//     computeAvailability, so the public map reflects an edit within its 120s
//     cache window. No code deploys needed to correct the public story.
//   • Portable to product editions: everything is schema-scoped; a setting's
//     own `occupancy_prompt` explains its model to the AI advisor.
// ===========================================================================
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const pub = require('./public-availability');

const OLLAMA_URL = process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://your-ollama-host:11434';
const ADVISOR_MODEL = process.env.WREN_ADVISOR_MODEL || 'qwen3.6:35b-a3b';

router.use(express.json({ limit: '64kb' }));
router.use(authenticate);
router.use((req, res, next) => {
  if (!['manager', 'room_leader'].includes(req.user.role)) return res.status(403).json({ error: 'Manager access required' });
  next();
});

const { ymd, ageMonths, plusMonths, WEEKDAYS } = pub.helpers;
const MONTH_RE = /^\d{4}-\d{2}$/;

// ── GET /state — the board grid ──────────────────────────────────────────────
router.get('/state', async (req, res) => {
  const db = getPool();
  try {
    const now = new Date();
    const months = Math.min(Math.max(parseInt(req.query.months) || 18, 1), 24);
    const out = await pub.computeAvailability(db, { fromY: now.getUTCFullYear(), fromM: now.getUTCMonth(), months }, { withMeta: true });
    const { rows: overrides } = await db.query(
      `SELECT room_id, month, status, prob_space, heat, note, updated_by, updated_at
       FROM availability_overrides ORDER BY month`);
    const { rows: prompt } = await db.query(`SELECT value FROM settings WHERE key='occupancy_prompt'`);
    res.json({ ...out, overrides, occupancy_prompt: prompt[0] ? prompt[0].value : '' });
  } catch (e) {
    console.error('[waitlist-board/state]', e.message);
    res.status(500).json({ error: 'Could not load board state' });
  }
});

// ── PUT /override — pin a cell ───────────────────────────────────────────────
router.put('/override', async (req, res) => {
  const b = req.body || {};
  const roomId = parseInt(b.room_id);
  const month = String(b.month || '');
  if (!Number.isInteger(roomId) || !MONTH_RE.test(month)) return res.status(400).json({ error: 'room_id and month (YYYY-MM) required' });
  const status = ['open', 'limited', 'full'].includes(b.status) ? b.status : null;
  const num = v => (v === null || v === undefined || v === '') ? null : Math.min(1, Math.max(0, Number(v)));
  const prob = num(b.prob_space), heat = num(b.heat);
  if (!status && prob === null && heat === null) return res.status(400).json({ error: 'Nothing to override — set status, prob_space and/or heat' });
  const db = getPool();
  try {
    await db.query(`
      INSERT INTO availability_overrides (room_id, month, status, prob_space, heat, note, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (room_id, month) DO UPDATE
        SET status=$3, prob_space=$4, heat=$5, note=$6, updated_by=$7, updated_at=NOW()`,
      [roomId, month, status, prob, heat, (b.note || '').slice(0, 500) || null, req.user.name || String(req.user.id)]);
    res.json({ ok: true, note: 'Public map picks this up within ~2 minutes (cache).' });
  } catch (e) {
    console.error('[waitlist-board/override]', e.message);
    res.status(500).json({ error: 'Could not save override' });
  }
});

// ── DELETE /override — back to computed ──────────────────────────────────────
router.delete('/override', async (req, res) => {
  const roomId = parseInt(req.query.room_id);
  const month = String(req.query.month || '');
  if (!Number.isInteger(roomId) || !MONTH_RE.test(month)) return res.status(400).json({ error: 'room_id and month required' });
  try {
    await getPool().query(`DELETE FROM availability_overrides WHERE room_id=$1 AND month=$2`, [roomId, month]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not clear override' }); }
});

// ── openings + candidates (the deterministic "auto-manage" core) ─────────────
async function buildSuggestions(db) {
  const cfg = await pub.loadSettings(db);
  const rooms = await pub.loadRooms(db, cfg);
  const todayS = ymd(new Date());
  const { rows: kids } = await db.query(`
    SELECT id, first_name, last_name, room_id, date_of_birth AS dob,
           start_date, leave_date, transfer_planned_date
    FROM children WHERE is_active=true AND date_of_birth IS NOT NULL`);

  // Baby Room: chain of openings (move-up / leave) vs confirmed incoming starts.
  const openings = []; const incoming = [];
  for (const c of kids) {
    if (c.room_id !== rooms.baby.id) continue;
    const name = `${c.first_name} ${c.last_name}`.trim();
    const sd = c.start_date ? ymd(c.start_date) : null;
    if (sd && sd > todayS) incoming.push({ name, sd });
    const tdate = c.transfer_planned_date ? ymd(c.transfer_planned_date) : plusMonths(ymd(c.dob), cfg.transfer_age_min_months);
    const ld = c.leave_date ? ymd(c.leave_date) : null;
    const out = (ld && ld < tdate) ? ld : tdate;
    if (out > todayS) openings.push({ date: out, vacated_by: name, matched_by: null });
  }
  openings.sort((a, b) => a.date < b.date ? -1 : 1);
  incoming.sort((a, b) => a.sd < b.sd ? -1 : 1);
  for (const inc of incoming) {   // same 60-day bridge rule as the public model
    let best = null;
    for (const o of openings) {
      if (o.matched_by || o.date > inc.sd) continue;
      if (new Date(inc.sd) - new Date(o.date) <= 60 * 864e5) best = o;
    }
    if (best) best.matched_by = `${inc.name} (starts ${inc.sd})`;
  }
  // Running over capacity (e.g. 11/10): the earliest unmatched openings just
  // bring the room back to cap — they are NOT sellable spaces.
  let curLoad = 0;
  for (const c of kids) {
    if (c.room_id !== rooms.baby.id) continue;
    const sd = c.start_date ? ymd(c.start_date) : null;
    const ld = c.leave_date ? ymd(c.leave_date) : null;
    const tdate = c.transfer_planned_date ? ymd(c.transfer_planned_date) : plusMonths(ymd(c.dob), cfg.transfer_age_min_months);
    if ((!sd || sd <= todayS) && (!ld || ld >= todayS) && tdate > todayS) curLoad++;
  }
  let absorb = Math.max(0, curLoad - rooms.baby.cap);
  for (const o of openings) {
    if (absorb <= 0) break;
    if (!o.matched_by) { o.matched_by = `absorbs current over-capacity (running ${curLoad}/${rooms.baby.cap})`; absorb--; }
  }

  const { rows: wl } = await db.query(`
    SELECT id, child_first_name, child_last_name, child_dob, room_needed,
           expected_start_date, parent_name, preferred_days, notes, date_added, offer_status
    FROM waiting_list
    WHERE COALESCE(status,'waiting')='waiting' AND COALESCE(tier,'active')='active'`);
  const isBaby = w => /bab/i.test(w.room_needed || '');

  const unmatched = openings.filter(o => !o.matched_by).map(o => {
    const cands = wl.filter(isBaby).map(w => {
      const dob = w.child_dob ? ymd(w.child_dob) : null;
      const age = dob ? ageMonths(dob, o.date) : null;                       // age at the opening
      const est = w.expected_start_date ? ymd(w.expected_start_date) : null;
      const gapW = est ? Math.abs(new Date(est) - new Date(o.date)) / (864e5 * 7) : 26;
      const waitedM = w.date_added ? (new Date() - new Date(w.date_added)) / (864e5 * 30.4) : 0;
      let score = 100 - gapW * 3 + Math.min(12, waitedM);
      const flags = [];
      if (age !== null && age < 5) { score -= 60; flags.push('too young at opening'); }
      if (age !== null && age > 20) { score -= 25; flags.push('near move-up age already'); }
      if (/1st offer/i.test(w.notes || '')) { score += 15; flags.push('offer already out'); }
      return {
        waitlist_id: w.id,
        child: `${w.child_first_name} ${w.child_last_name}`.trim(),
        parent: w.parent_name || null,
        dob, age_at_opening_months: age === null ? null : Math.round(age),
        wants_from: est, waited_months: Math.round(waitedM),
        notes: w.notes || null, score: Math.round(score), flags,
      };
    }).sort((a, b) => b.score - a.score).slice(0, 5);
    return { room: 'Baby Room', opening_date: o.date, vacated_by: o.vacated_by, flex: 'offer a start ±1 month', candidates: cands };
  });

  // Pre-school: per-weekday headroom 12 months out + waiting fits.
  const now = new Date();
  const meta = await pub.computeAvailability(db, { fromY: now.getUTCFullYear(), fromM: now.getUTCMonth(), months: 13 }, { withMeta: true });
  const psWl = wl.filter(w => !isBaby(w));
  const psMonths = meta.series.map(m => {
    const free = {}; for (const wd of WEEKDAYS) free[wd] = Math.max(0, rooms.pre.cap - m.loads.pre_by_day[wd]);
    return { month: m.month, free_by_day: free };
  });
  const psCandidates = psWl.map(w => {
    const est = w.expected_start_date ? ymd(w.expected_start_date).slice(0, 7) : null;
    const mrow = psMonths.find(m => m.month === est) || psMonths[0];
    const days = (w.preferred_days && w.preferred_days.length) ? w.preferred_days : WEEKDAYS;
    const fit = Math.min(...days.map(d => mrow.free_by_day[d] ?? 0));
    return {
      waitlist_id: w.id, child: `${w.child_first_name} ${w.child_last_name}`.trim(),
      parent: w.parent_name || null, wants_from: w.expected_start_date ? ymd(w.expected_start_date) : null,
      wanted_days: days, seats_free_on_wanted_days: fit,
      verdict: fit >= 1 ? 'can offer now' : 'wanted days full — suggest alternative days',
      notes: w.notes || null,
    };
  }).sort((a, b) => b.seats_free_on_wanted_days - a.seats_free_on_wanted_days);

  return { generated: todayS, baby_room: { openings: unmatched, chain: openings }, pre_school: { months: psMonths, candidates: psCandidates } };
}

router.get('/suggestions', async (req, res) => {
  try { res.json(await buildSuggestions(getPool())); }
  catch (e) { console.error('[waitlist-board/suggestions]', e.message); res.status(500).json({ error: 'Could not build suggestions' }); }
});

// ── GET /signals — possible leaver notices in the triaged inbox (read-only) ──
const LEAVER_RE = "(giv\\w+ (our |my )?notice|hand\\w* in (our |my )?notice|last day (at|will be)|leaving (the )?nursery|withdraw\\w* (him|her|them|from)|de-?register|moving (away|house|out of)|won'?t be (returning|coming back)|end\\w* (his|her|their) place)";
router.get('/signals', async (req, res) => {
  const db = getPool();
  try {
    let hits = [];
    try {
      const { rows } = await db.query(`
        SELECT id, received_at::date AS received, from_name, from_email, subject,
               summary, left(coalesce(body_preview, ''), 300) AS preview
        FROM email_triage
        WHERE received_at > NOW() - INTERVAL '60 days'
          AND COALESCE(category,'') NOT IN ('spam','newsletter','transactional')
          AND lower(coalesce(subject,'')||' '||coalesce(body_preview,'')||' '||coalesce(summary,'')) ~ $1
        ORDER BY received_at DESC LIMIT 20`, [LEAVER_RE]);
      hits = rows;
    } catch (e) { /* email_triage may not exist in this schema */ }

    // Try to name the child: match active children names in the email text.
    const { rows: kids } = await db.query(
      `SELECT id, first_name, last_name, room_id, leave_date, notice_given_date
       FROM children WHERE is_active=true`);
    for (const h of hits) {
      const text = `${h.subject || ''} ${h.preview || ''} ${h.summary || ''}`.toLowerCase();
      const m = kids.find(k => k.first_name && text.includes(k.first_name.toLowerCase()) &&
        k.last_name && text.includes(k.last_name.toLowerCase()))
        || kids.find(k => k.first_name && k.first_name.length > 3 && text.includes(k.first_name.toLowerCase()));
      if (m) {
        h.child_match = { id: m.id, name: `${m.first_name} ${m.last_name}`, room_id: m.room_id, leave_date_on_file: m.leave_date ? ymd(m.leave_date) : null };
        h.action = m.leave_date ? 'leave date already recorded' : 'no leave date on file — record it, then check Suggestions for replacements';
      } else {
        h.action = 'review — could not match a child';
      }
    }
    // Also surface recent notice flags recorded directly on children.
    const recentNotice = kids.filter(k => k.notice_given_date && (new Date() - new Date(k.notice_given_date)) < 45 * 864e5)
      .map(k => ({ child: `${k.first_name} ${k.last_name}`, notice_given: ymd(k.notice_given_date), leave_date: k.leave_date ? ymd(k.leave_date) : null }));
    res.json({ email_signals: hits, recent_notices: recentNotice });
  } catch (e) {
    console.error('[waitlist-board/signals]', e.message);
    res.status(500).json({ error: 'Could not scan for signals' });
  }
});

// ── occupancy prompt (how this setting's occupancy works — feeds the advisor) ─
router.get('/occupancy-prompt', async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT value FROM settings WHERE key='occupancy_prompt'`);
    res.json({ occupancy_prompt: rows[0] ? rows[0].value : '' });
  } catch (e) { res.status(500).json({ error: 'Could not load prompt' }); }
});
router.put('/occupancy-prompt', async (req, res) => {
  // existing code unchanged
});

// ── POST /invite-to-app — manager invites a waitlist family to the app ──
router.post('/invite-to-app', async (req, res) => {
  const db = getPool();
  const { waiting_list_id } = req.body || {};
  if (!Number.isInteger(waiting_list_id)) return res.status(400).json({ error: 'waiting_list_id required' });
  try {
    // fetch parent email from waiting_list
    const { rows: wlRows } = await db.query(`SELECT parent_email FROM waiting_list WHERE id=$1`, [waiting_list_id]);
    if (!wlRows.length) return res.status(404).json({ error: 'waiting_list entry not found' });
    const email = wlRows[0].parent_email;
    if (!email) return res.status(400).json({ error: 'parent_email missing on waiting_list entry' });
    // upsert into parent_portal_access with waitlist access level using UPDATE then INSERT if needed
    const updRes = await db.query(`
      UPDATE parent_portal_access SET access_level='waitlist', waiting_list_id=$2 WHERE email=$1 RETURNING *
    `, [email, waiting_list_id]);
    if (updRes.rowCount === 0) {
      await db.query(`
        INSERT INTO parent_portal_access (email, access_level, waiting_list_id)
        VALUES ($1, 'waitlist', $2)
      `, [email, waiting_list_id]);
    }
    // queue email for allowlist
    await db.query(`INSERT INTO cf_allowlist_queue (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);
    res.json({ ok: true, email });
  } catch (e) {
    console.error('[waitlist-board/invite-to-app]', e.message);
    res.status(500).json({ error: 'Could not process invite' });
  }
});

// ── POST /advise — AI admissions manager (local Ollama, sovereign) ───────────
// (A duplicate stub /advise that only saved occupancy_prompt used to sit here and
// shadowed this handler — prompt saving lives at PUT /occupancy-prompt.)
router.post('/advise', async (req, res) => {
  const db = getPool();
  try {
    const now = new Date();
    const [state, sugg] = await Promise.all([
      pub.computeAvailability(db, { fromY: now.getUTCFullYear(), fromM: now.getUTCMonth(), months: 15 }, { withMeta: true }),
      buildSuggestions(db),
    ]);
    const { rows: ps } = await db.query(`SELECT value FROM settings WHERE key='occupancy_prompt'`);
    const occPrompt = ps[0] ? ps[0].value : '(not set)';
    const grid = state.series.map(m =>
      `${m.month}: Baby=${m.rooms[0].status}(load ${m.loads.baby}) Pre=${m.rooms[1].status}(max-day ${Math.max(...Object.values(m.loads.pre_by_day))})`).join('\n');
    const prompt = `You are the admissions manager for this nursery. Be concise and concrete.

HOW OUR OCCUPANCY WORKS (written by the manager — treat as ground truth):
${occPrompt}

NEXT 15 MONTHS (computed board):
${grid}

UNMATCHED BABY-ROOM OPENINGS (no confirmed replacement) + top candidates:
${sugg.baby_room.openings.slice(0, 6).map(o =>
    `• ${o.opening_date} (${o.vacated_by} moves up): ` +
    (o.candidates.slice(0, 3).map(c => `${c.child} (wants ${c.wants_from || '?'}, ${c.age_at_opening_months ?? '?'}mo at start, waited ${c.waited_months}m${c.flags.length ? ', ' + c.flags.join('/') : ''}${c.notes ? ' — ' + c.notes : ''})`).join('; ') || 'no candidates')
  ).join('\n')}

PRE-SCHOOL WAITLIST FIT:
${sugg.pre_school.candidates.slice(0, 8).map(c =>
    `• ${c.child}: wants ${(c.wanted_days || []).join('/')} from ${c.wants_from || '?'} — ${c.verdict}`).join('\n')}

Reply with three short sections in plain text (no markdown headers):
1) ANYTHING WRONG — inconsistencies or risks in the data above.
2) DO NEXT — who to offer/chase this week, in priority order, with the reason.
3) ADVERTISE — which months/rooms to promote publicly.`;
    const r = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ADVISOR_MODEL, prompt, stream: false, think: false }),
      signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    const d = await r.json();
    const text = (d.response || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    res.json({ ok: true, model: ADVISOR_MODEL, advice: text || '(no advice returned)' });
  } catch (e) {
    console.error('[waitlist-board/advise]', e.message);
    res.status(502).json({ error: `Advisor unavailable (${e.message}) — the deterministic Suggestions list still works.` });
  }
});

module.exports = router;
