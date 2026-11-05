// Absence & holiday fairness — decision SUPPORT, not decision-making (2026-07-10).
//
// LEGAL DESIGN (UK): the manager always decides. This ranks competing leave
// claims against OBJECTIVE, DISCLOSED criteria using DETERMINISTIC code (so it's
// auditable and defensible); the local AI only writes the plain-English
// rationale — it never sets the scores. Protected-characteristic factors
// (disability-, pregnancy/maternity-related absence, religious observance) are
// FLAGGED for the manager's attention and are NEVER used to lower a score.
// This keeps the tool out of UK GDPR Art. 22 (automated decisions on special-
// category data) and gives an Equality Act 2010 audit trail.
//
// See wren-docs/absence-fairness-spec + the staff letter (manuals/).
'use strict';
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { getPool } = require('../db/pool');
// b106 (2026-07-20): per-employee weight preferences. Reuses THIS engine's
// scoring; a candidate's own claim is scored with their personal weights (if set
// and the feature is on), everyone else with the manager defaults.
const LWCore = require('../services/leave-weights-core');

// b333: model + host come from ai-models.js, resolved per call (role 'heavy' —
// the rationale's wording is legally careful, see LEGAL DESIGN above).
const ai = require('../lib/ai-models');

// Default, disclosed criteria weights (0–1). Editable in settings so staff can
// see exactly how it works — transparency is what keeps the fuss down.
// b135 (2026-07-22, Toby): length-of-service dropped — it was hard-coded
// neutral 0.5 (no reliable hire-date column) and only ever punished new staff.
// Old weights renormalised to sum 1.0 with the same relative ordering.
const DEFAULT_WEIGHTS = {
  booking_order: 0.40,   // first-come, first-served (earlier request wins)
  rotation: 0.30,        // didn't get this period last year → higher
  spread: 0.20,          // has taken less leave so far this year → higher
  notice: 0.10,          // more notice given → higher
};

// Manager/admin only.
router.use((req, res, next) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-wren-token'] || '';
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }
  if (!['manager', 'admin', 'deputy_manager', 'headteacher'].includes(String(req.user.role || '').toLowerCase())) {
    return res.status(403).json({ error: 'Manager only' });
  }
  next();
});

// Delegates to leave-weights-core so a legacy settings row (e.g. one still
// carrying a `service` key from before b135) is sanitised + renormalised in
// exactly one place, never crashes, and this route + /api/leave-weights can
// never disagree about what "the manager weights" are.
async function getWeights(db) {
  return LWCore.getManagerWeights(db);
}

// ── GET/PUT settings (weights) — visible to managers so it's not a black box ──
router.get('/settings', async (req, res) => {
  const db = getPool();
  res.json({ weights: await getWeights(db), defaults: DEFAULT_WEIGHTS,
    personal_weights_enabled: await LWCore.getEnabled(db),
    personal_weights_points: { total: LWCore.POINTS_TOTAL, min: LWCore.POINT_MIN, max: LWCore.POINT_MAX },
    personal_weights_presets: LWCore.PRESETS,
    criteria_explained: {
      booking_order: 'Who asked first (first-come, first-served).',
      rotation: 'Whether they had this popular period last year — turn-taking.',
      spread: 'How much leave they have already taken this year — spreading it fairly.',
      notice: 'How much notice they gave.',
    },
    protected_never_scored: [
      'Disability-related absence (reasonable adjustments apply; never counts against them)',
      'Pregnancy or maternity-related absence (protected)',
      'Religious or belief observance (protected; any refusal must be for genuine operational need, applied equally)',
    ] });
});

router.put('/settings', async (req, res) => {
  const w = req.body && req.body.weights;
  if (!w || typeof w !== 'object') return res.status(400).json({ error: 'weights object required' });
  const clean = {};
  for (const k of Object.keys(DEFAULT_WEIGHTS)) clean[k] = Math.max(0, Math.min(1, parseFloat(w[k]) || 0));
  try {
    await getPool().query(
      `INSERT INTO settings (key, value) VALUES ('absence_fairness_weights',$1)
       ON CONFLICT (key) DO UPDATE SET value=$1`, [JSON.stringify(clean)]);
    res.json({ ok: true, weights: clean });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Protected-characteristic detection (FLAG only, never score) ───────────────
const DISABILITY_RE = /\b(disab|reasonable adjustment|chronic|long.?term condition|ME\/CFS|fibromyalg|MS\b|epilep|diabet|mental health|anxiety|depression|autis|adhd|hospital|surgery|operation|treatment|therapy|oncolog|cancer|dialysis)\b/i;
const PREGNANCY_RE = /\b(pregnan|maternit|antenatal|ante-natal|midwife|morning sickness|IVF|fertility)\b/i;
const RELIGION_RE = /\b(ramadan|eid|hajj|umrah|diwali|yom kippur|rosh hashanah|passover|christmas|easter|vaisakhi|navratri|religious|observance|prayer|pilgrimage|fast(ing)?)\b/i;

function protectedFlags(text) {
  const t = String(text || '');
  const flags = [];
  if (DISABILITY_RE.test(t)) flags.push({ kind: 'disability', note: 'Possible disability-related — do NOT weigh reliability against them; consider reasonable adjustments.' });
  if (PREGNANCY_RE.test(t)) flags.push({ kind: 'pregnancy_maternity', note: 'Possible pregnancy/maternity-related — protected; must not count against them.' });
  if (RELIGION_RE.test(t)) flags.push({ kind: 'religion_belief', note: 'Religious/belief observance — protected; any refusal must be for genuine operational need applied equally to all.' });
  return flags;
}

// ── POST /rank — score competing claims to a contested period ─────────────────
// body: { start_date, end_date, staff_ids? (defaults to everyone with a pending
//         or overlapping request for that window) }
router.post('/rank', async (req, res) => {
  const { start_date, end_date } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start_date || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end_date || ''))) {
    return res.status(400).json({ error: 'start_date and end_date (YYYY-MM-DD) required' });
  }
  const db = getPool();
  const weights = await getWeights(db);
  try {
    // Candidate requests: pending/holiday requests overlapping the window.
    let staffIds = Array.isArray(req.body.staff_ids) ? req.body.staff_ids.map(Number).filter(Boolean) : null;
    const { rows: reqs } = await db.query(
      `SELECT a.id, a.staff_id, a.start_date, a.end_date, a.absence_type, a.status,
              a.notes, a.created_at,
              s.first_name || ' ' || s.last_name AS name, s.role,
              s.holiday_entitlement_days
       FROM absence_requests a JOIN staff s ON s.id=a.staff_id
       WHERE a.absence_type IN ('holiday','other')
         AND a.start_date <= $2 AND a.end_date >= $1
         ${staffIds ? 'AND a.staff_id = ANY($3)' : ''}
       ORDER BY a.created_at`,
      staffIds ? [start_date, end_date, staffIds] : [start_date, end_date]);

    if (!reqs.length) return res.json({ candidates: [], note: 'No overlapping holiday requests for that window.' });

    // b106: prefetch personal (normalised) weights for every candidate, so a
    // person's own claim is scored with their chosen weights. Manager defaults
    // are also normalised so the two are compared on the same scale.
    const personalEnabled = await LWCore.getEnabled(db);
    const candidateStaffIds = [...new Set(reqs.map(r => r.staff_id))];
    const personalMap = await LWCore.getEffectiveWeightsMap(db, candidateStaffIds, weights, personalEnabled);
    const managerNorm = LWCore.sanitizeManagerWeights(weights);

    const yearStart = start_date.slice(0, 4) + '-01-01';
    // Precompute per-staff: leave taken this year, whether they had this calendar
    // period last year (rotation), earliest request date.
    const scored = [];
    const firstReq = Math.min(...reqs.map(r => new Date(r.created_at).getTime()));
    const lastReq = Math.max(...reqs.map(r => new Date(r.created_at).getTime()));
    for (const r of reqs) {
      const [{ rows: taken }, { rows: lastYear }] = await Promise.all([
        db.query(`SELECT COALESCE(SUM(days_count),0) AS d FROM absence_requests
                  WHERE staff_id=$1 AND absence_type='holiday' AND status='approved' AND start_date >= $2`,
          [r.staff_id, yearStart]),
        db.query(`SELECT 1 FROM absence_requests
                  WHERE staff_id=$1 AND absence_type='holiday' AND status='approved'
                    AND EXTRACT(MONTH FROM start_date)=EXTRACT(MONTH FROM $2::date)
                    AND EXTRACT(YEAR FROM start_date)=EXTRACT(YEAR FROM $2::date)-1 LIMIT 1`,
          [r.staff_id, start_date]),
      ]);
      const takenDays = parseFloat(taken[0].d) || 0;
      const hadLastYear = lastYear.length > 0;
      const entitlement = parseFloat(r.holiday_entitlement_days) || 28;

      // Deterministic factor scores, each normalised 0–1.
      const bookingOrder = lastReq === firstReq ? 1 : 1 - ((new Date(r.created_at).getTime() - firstReq) / (lastReq - firstReq)); // earlier = higher
      const rotation = hadLastYear ? 0 : 1;                                  // didn't have it last year = higher
      const spread = Math.max(0, 1 - (takenDays / Math.max(1, entitlement))); // taken less = higher
      const noticeDays = (new Date(start_date) - new Date(r.created_at)) / 86400000;
      const notice = Math.max(0, Math.min(1, noticeDays / 84));              // up to ~12 weeks notice

      const factors = { booking_order: bookingOrder, rotation, spread, notice };
      // b106: score THIS candidate with their own weights if they've set them
      // (and the feature is on); otherwise the manager defaults.
      const candW = personalMap[r.staff_id] || managerNorm;
      let score = 0; for (const k of LWCore.FACTOR_KEYS) score += (candW[k] || 0) * (factors[k] || 0);
      // b135: ALSO score with the manager defaults for everyone (even those with
      // personal weights), so we can tell whether personal weighting actually
      // changed the outcome — the "same order anyway" fact.
      let defaultScore = 0; for (const k of LWCore.FACTOR_KEYS) defaultScore += (managerNorm[k] || 0) * (factors[k] || 0);

      const flags = protectedFlags((r.notes || '') + ' ' + (r.absence_type === 'other' ? 'other' : ''));

      scored.push({
        request_id: r.id, staff_id: r.staff_id, name: r.name, role: r.role,
        requested: { start: r.start_date, end: r.end_date, notes: r.notes, requested_on: r.created_at },
        score: Math.round(score * 1000) / 1000,
        default_score: Math.round(defaultScore * 1000) / 1000,
        factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, Math.round(v * 100) / 100])),
        taken_days_this_year: takenDays, had_period_last_year: hadLastYear,
        used_personal_weights: !!personalMap[r.staff_id],
        weights_used: candW,
        protected_flags: flags,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    scored.forEach((c, i) => { c.rank = i + 1; });

    // b135: rank the SAME candidates under manager-default weights only, so we
    // can flag when someone's personal weighting choices actually changed the
    // outcome versus when the order would have been identical anyway.
    const defaultOrder = [...scored].sort((a, b) => b.default_score - a.default_score);
    defaultOrder.forEach((c, i) => { c.default_rank = i + 1; });
    const orderChangedByPersonalWeights = scored.some((c, i) => defaultOrder[i] !== c);
    let swapNote = null;
    if (orderChangedByPersonalWeights) {
      for (let i = 0; i < scored.length; i++) {
        if (scored[i] !== defaultOrder[i]) {
          swapNote = `Under standard weights, ${defaultOrder[i].name} would be ranked #${i + 1} instead of ${scored[i].name}.`;
          break;
        }
      }
    }

    // AI writes a plain-English rationale ONLY (never the numbers). Fails soft.
    let rationale = null;
    try {
      const summary = scored.map((s, i) =>
        `${i + 1}. ${s.name}: score ${s.score} (asked ${new Date(s.requested.requested_on).toLocaleDateString('en-GB')}, taken ${s.taken_days_this_year}d this yr, ${s.had_period_last_year ? 'HAD this period last year' : 'did not have it last year'})${s.protected_flags.length ? ' ⚠ ' + s.protected_flags.map(f => f.kind).join(',') : ''}`).join('\n');
      const orderFact = orderChangedByPersonalWeights
        ? `This order would be DIFFERENT under the standard (non-personalised) weights — mention that at least one person's own weighting choices affected today's result.`
        : `This order would be the SAME even under the standard (non-personalised) weights — reassure the manager that nobody's personal weighting choices changed the outcome here, so there's nothing to justify on that front.`;
      const resp = await fetch(`${ai.host()}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ai.model('heavy'), stream: false, think: false,
          prompt: `You are helping a nursery manager decide, fairly, who gets a contested holiday period. The RANKING below was computed by objective rules (first-come-first-served, turn-taking vs last year, spreading leave fairly, notice given). Do NOT change the order. In 3-4 short sentences, explain the recommendation in plain, warm English the manager could paraphrase to staff. If any entry is flagged (⚠), explicitly remind the manager those factors are protected and must not count against that person — and that a refusal for anyone must be for genuine operational need (ratios/can't close) applied equally.\n\n${orderFact}\n\nRanking:\n${summary}\n\nThe manager makes the final decision.`,
          options: ai.options({ temperature: 0.3, num_predict: 350 }) }),
        signal: AbortSignal.timeout(90000),
      });
      if (resp.ok) rationale = ((await resp.json()).response || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (aiErr) { console.error('[absence-fairness] rationale failed (non-fatal):', aiErr.message); }

    res.json({
      window: { start_date, end_date }, weights, candidates: scored, rationale,
      personal_weights_enabled: personalEnabled,
      order_changed_by_personal_weights: orderChangedByPersonalWeights,
      swap_note: swapNote,
      disclaimer: 'Decision support only. Scores are computed from objective rules; protected-characteristic factors are flagged and never scored down. The manager makes the final decision.',
    });
  } catch (e) {
    console.error('[absence-fairness] rank error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Even-handed religious/observance advance reminder ─────────────────────────
// The discrimination protection: give EVERYONE the same fair, documented advance
// notice to book known observance dates, apply neutral rules, keep the record.
router.post('/observance-reminder', async (req, res) => {
  const { occasion, approx_dates, book_by } = req.body || {};
  if (!occasion) return res.status(400).json({ error: 'occasion required' });
  const db = getPool();
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS observance_reminders (
      id serial PRIMARY KEY, occasion text NOT NULL, approx_dates text, book_by date,
      sent_to_count int, sent_by int, created_at timestamptz DEFAULT now())`);
    const { rows: staff } = await db.query(`SELECT id FROM staff WHERE is_active IS NOT FALSE`);
    // Notify every active staff member equally (in-app notification).
    for (const s of staff) {
      await db.query(
        `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, priority)
         VALUES ('staff',$1,'leave',$2,$3,'normal')`,
        [s.id, `Booking reminder: ${occasion}`,
         `A reminder to all staff: if you observe ${occasion}${approx_dates ? ' (' + approx_dates + ')' : ''} and would like leave, please request it${book_by ? ' by ' + book_by : ' as early as possible'}. We treat every request the same way — first come, first served, balanced with the rooms we must keep covered — so booking early gives the best chance. Thank you.`]
      ).catch(() => {});
    }
    const { rows } = await db.query(
      `INSERT INTO observance_reminders (occasion, approx_dates, book_by, sent_to_count, sent_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [occasion, approx_dates || null, book_by || null, staff.length, req.user.id]);
    res.status(201).json({ ok: true, id: rows[0].id, sent_to: staff.length,
      note: 'Sent to all active staff equally and logged — this even-handed advance notice is your evidence of fair, non-discriminatory process.' });
  } catch (e) {
    console.error('[absence-fairness] observance reminder error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/observance-log', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM observance_reminders ORDER BY created_at DESC LIMIT 50`).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
