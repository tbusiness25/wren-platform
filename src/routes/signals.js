'use strict';
/**
 * b311 — the signals API.
 *
 * Two surfaces in one router, deliberately, because they are the same system:
 *
 *   MANAGEMENT (manager / owner)   the Roost Signals screen. What each signal
 *                                  asks, when it last ran, what it last said,
 *                                  and the mute control hard rule 3 requires.
 *
 *   THE NUDGE (any signed-in staff) the confused-clicks offer. Scoped to the
 *                                  CALLER's own beacons — there is no staff_id
 *                                  parameter anywhere in it, so one member of
 *                                  staff cannot ask this router what another
 *                                  one has been clicking on.
 *
 * The nudge routes are registered FIRST, before /:key, or 'nudge' would be read
 * as a signal key.
 *
 * Nothing here writes nursery data. The only tables this router updates are
 * signal_state (mute + thresholds) and signal_nudges (the offer log).
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const registry = require('../lib/signals');
const runner = require('../lib/signals/runner');
const phrasing = require('../lib/signals/phrasing');
const nudge = require('../lib/signals/nudge');

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher'];
function isManager(req) {
  const u = req.user || {};
  if (Number(u.id) === 1) return true;
  const role = String(u.role_original || u.role || '');
  return MANAGER_ROLES.includes(role);
}
function requireManager(req, res, next) {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  next();
}
function staffId(req) {
  const id = req.user && (req.user.id || req.user.staff_id);
  return Number.isFinite(Number(id)) ? Number(id) : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// THE NUDGE — any signed-in staff member, their own activity only
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/signals/nudge
 * The browser asks only after it has itself seen a burst of navigation, so this
 * is not polled; the server then makes the decision from the recorded beacons
 * rather than trusting the page's own account of itself.
 * Returns { offer:false } far more often than not, and that is the success case.
 */
router.get('/nudge', async (req, res) => {
  const sid = staffId(req);
  if (!sid) return res.json({ offer: false, reason: 'no staff id on the token' });
  // A parent token must never reach the staff activity log. server-unified.js
  // has 'signals' on PARENT_DENY; this is the belt-and-braces layer.
  if (String(req.user.role || '') === 'parent') return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    const setting = runner.makeSettingReader(db);
    if (String(await setting('signals_nudge_enabled', 'true')) === 'false') {
      return res.json({ offer: false, reason: 'the offer is switched off' });
    }
    const ev = await nudge.evaluate(db, sid, {
      windowSecs: parseInt(await setting('signals_nudge_window_seconds', '120'), 10),
      minSections: parseInt(await setting('signals_nudge_sections', '4'), 10),
      maxPerDay: parseInt(await setting('signals_nudge_max_per_day', '2'), 10),
    });
    if (!ev.offer) return res.json({ offer: false, reason: ev.reason });
    const id = await nudge.record(db, sid, ev);
    res.json({
      offer: true,
      id,
      // Rule 4 holds here too: the offer says what it noticed, not "you seem lost".
      saw: `${ev.section_count} sections in ${Math.round(ev.window_secs / 60) || 1} ${ev.window_secs >= 120 ? 'minutes' : 'minute'}, with nothing changed`,
      question: 'What were you trying to find?',
    });
  } catch (e) {
    // The offer must never break a page. Silence beats an error banner.
    res.json({ offer: false, reason: 'could not evaluate' });
  }
});

/** POST /api/signals/nudge/:id/answer  { answer, portal } → where to go. */
router.post('/nudge/:id/answer', async (req, res) => {
  const sid = staffId(req);
  if (!sid) return res.status(401).json({ error: 'Unauthenticated' });
  const answer = String(req.body?.answer || '').trim().slice(0, 200);
  if (answer.length < 2) return res.status(400).json({ error: 'Say a little more' });
  try {
    const db = getPool();
    // Scoped to the caller's own row — an id from somebody else's session
    // updates nothing and returns nothing.
    await db.query(
      `UPDATE signal_nudges SET answer = $3, answered_at = now()
        WHERE id = $1 AND staff_id = $2`,
      [parseInt(req.params.id, 10) || 0, sid, answer]);
    const portal = String(req.body?.portal || '').trim().toLowerCase() || null;
    res.json({ answer, destinations: nudge.destinations(answer, portal, 4) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/signals/nudge/:id/dismiss */
router.post('/nudge/:id/dismiss', async (req, res) => {
  const sid = staffId(req);
  if (!sid) return res.status(401).json({ error: 'Unauthenticated' });
  try {
    await getPool().query(
      `UPDATE signal_nudges SET dismissed_at = now() WHERE id = $1 AND staff_id = $2`,
      [parseInt(req.params.id, 10) || 0, sid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

router.use(requireManager);

/** GET /api/signals — the whole board. */
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const setting = runner.makeSettingReader(db);
    const signals = registry.all();

    const { rows: states } = await db.query(`SELECT * FROM signal_state`);
    const byKey = Object.fromEntries(states.map(s => [s.signal_key, s]));

    const { rows: latest } = await db.query(
      `SELECT DISTINCT ON (signal_key)
              signal_key, id, fired_at, headline, sent_text, phrasing_source,
              phrasing_note, facts, link, cleared_at, notification_ids
         FROM signal_events
        ORDER BY signal_key, fired_at DESC`);
    const lastBy = Object.fromEntries(latest.map(e => [e.signal_key, e]));

    const { rows: counts } = await db.query(
      `SELECT signal_key,
              count(*)::int AS fires,
              count(*) FILTER (WHERE cleared_at IS NOT NULL)::int AS acted_on
         FROM signal_events GROUP BY signal_key`);
    const countBy = Object.fromEntries(counts.map(c => [c.signal_key, c]));

    const today = require('../lib/signals/_util').londonToday(new Date());
    const cap = parseInt(await setting('signals_daily_cap', '4'), 10);
    const sentToday = await runner.firedToday(db, today);
    const win = runner.withinWindow(new Date(),
      String(await setting('signals_window_start', '07:30')),
      String(await setting('signals_window_end', '18:30')),
      String(await setting('signals_weekdays_only', 'true')) !== 'false');

    res.json({
      enabled: String(await setting('signals_enabled', 'true')) !== 'false',
      window: { start: await setting('signals_window_start', '07:30'),
                end: await setting('signals_window_end', '18:30'),
                weekdays_only: String(await setting('signals_weekdays_only', 'true')) !== 'false',
                open_now: win.ok, why: win.why },
      cap, sent_today: sentToday, remaining_today: Math.max(0, cap - sentToday),
      interval_minutes: parseInt(await setting('signals_interval_minutes', '60'), 10),
      phrasing: {
        enabled: String(await setting('signals_phrasing', 'true')) !== 'false',
        model: await setting('signals_model', phrasing.defaultModel()),
      },
      nudge: {
        enabled: String(await setting('signals_nudge_enabled', 'true')) !== 'false',
        sections: parseInt(await setting('signals_nudge_sections', '4'), 10),
        window_seconds: parseInt(await setting('signals_nudge_window_seconds', '120'), 10),
        max_per_day: parseInt(await setting('signals_nudge_max_per_day', '2'), 10),
      },
      signals: signals.map(s => {
        const st = byKey[s.key] || {};
        const last = lastBy[s.key] || null;
        const c = countBy[s.key] || { fires: 0, acted_on: 0 };
        return {
          key: s.key, label: s.label, question: s.question, category: s.category,
          priority: s.priority, recipients: s.recipients, link: s.link,
          defaults: s.defaults,
          config: st.config || {},
          effective: Object.assign({}, s.defaults, st.config || {}),
          muted: !!st.muted, auto_muted: !!st.auto_muted,
          mute_reason: st.mute_reason || null, muted_at: st.muted_at || null,
          last_run_at: st.last_run_at || null,
          last_run_outcome: st.last_run_outcome || null,
          last_run_detail: st.last_run_detail || null,
          last_fired_at: st.last_fired_at || null,
          fire_count: st.fire_count || 0,
          fires: c.fires, acted_on: c.acted_on,
          last_event: last && {
            id: last.id, fired_at: last.fired_at,
            headline: last.headline, sent_text: last.sent_text,
            phrasing_source: last.phrasing_source, phrasing_note: last.phrasing_note,
            facts: last.facts, link: last.link, cleared_at: last.cleared_at,
          },
        };
      }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/signals/health — is the local model there? */
router.get('/health', async (req, res) => {
  try {
    const db = getPool();
    const setting = runner.makeSettingReader(db);
    const model = String(await setting('signals_model', phrasing.defaultModel()));
    phrasing._reset();
    const p = await phrasing.probe(model);
    res.json({
      model,
      local_model_available: p.ok,
      note: p.note || null,
      // Said out loud because it is the design, not a degradation: with the
      // local model down every notification still sends, in the wording the
      // query produced.
      fallback: 'notifications still send, phrased by the query itself',
      signals: registry.all().length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/signals/:key/history?limit=20 */
router.get('/:key/history', async (req, res) => {
  const s = registry.byKey(req.params.key);
  if (!s) return res.status(404).json({ error: 'No such signal' });
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const { rows } = await getPool().query(
      `SELECT e.id, e.fired_at, e.fingerprint, e.headline, e.sent_text,
              e.phrasing_source, e.phrasing_note, e.facts, e.link, e.cleared_at,
              e.recipient_ids,
              (SELECT count(*)::int FROM notifications n
                WHERE n.id = ANY(e.notification_ids) AND n.dismissed_at IS NOT NULL) AS dismissed,
              array_length(e.notification_ids, 1) AS notifications
         FROM signal_events e
        WHERE e.signal_key = $1
        ORDER BY e.fired_at DESC
        LIMIT $2`, [s.key, limit]);
    res.json({ key: s.key, label: s.label, events: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/signals/:key/mute  { muted: true|false, reason } */
router.post('/:key/mute', async (req, res) => {
  const s = registry.byKey(req.params.key);
  if (!s) return res.status(404).json({ error: 'No such signal' });
  const muted = req.body?.muted !== false;
  const reason = String(req.body?.reason || '').slice(0, 300) || null;
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO signal_state (signal_key) VALUES ($1) ON CONFLICT (signal_key) DO NOTHING`, [s.key]);
    // Every parameter is cast. Inside a CASE the other branch is a bare NULL,
    // which gives Postgres nothing to infer from, so $3 arrives as text and the
    // update fails on muted_by (integer). Verified 2026-09-10.
    await db.query(
      `UPDATE signal_state
          SET muted = $2::boolean,
              -- Turning it back ON also clears the self-mute flag: whatever Wren
              -- decided, a person has now overruled it.
              auto_muted = CASE WHEN $2::boolean THEN auto_muted ELSE false END,
              muted_by = CASE WHEN $2::boolean THEN $3::integer ELSE NULL END,
              muted_at = CASE WHEN $2::boolean THEN now() ELSE NULL END,
              mute_reason = CASE WHEN $2::boolean THEN $4::text ELSE NULL END,
              updated_at = now()
        WHERE signal_key = $1`,
      [s.key, muted, staffId(req), reason]);
    res.json({ ok: true, key: s.key, muted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PUT /api/signals/:key/config  { threshold_key: value, … }
 * Only keys the signal already declares in its defaults are accepted, and only
 * as numbers or short strings — a config blob is not a place to put arbitrary
 * data that later code will read back and trust.
 */
router.put('/:key/config', async (req, res) => {
  const s = registry.byKey(req.params.key);
  if (!s) return res.status(404).json({ error: 'No such signal' });
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  const clean = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in s.defaults)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
    else if (typeof v === 'string' && v.length <= 120) clean[k] = v;
    else if (typeof v === 'boolean') clean[k] = v;
  }
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO signal_state (signal_key) VALUES ($1) ON CONFLICT (signal_key) DO NOTHING`, [s.key]);
    await db.query(
      `UPDATE signal_state SET config = $2::jsonb, updated_at = now() WHERE signal_key = $1`,
      [s.key, JSON.stringify(clean)]);
    res.json({ ok: true, key: s.key, config: clean, effective: Object.assign({}, s.defaults, clean) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/signals/run  { only, dry_run, today }
 * "Run now" from the Roost screen. dry_run evaluates and phrases but sends and
 * stores nothing — it is how a manager can see what a signal WOULD say before
 * deciding whether they want to hear from it.
 */
router.post('/run', async (req, res) => {
  try {
    const out = await runner.runOnce({
      only: req.body?.only ? String(req.body.only) : undefined,
      dryRun: req.body?.dry_run === true,
      today: req.body?.today ? String(req.body.today).slice(0, 10) : undefined,
      ignoreWindow: true,   // a manager pressing the button IS the schedule
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/signals/nudges?days=14 — what people have been unable to find. */
router.get('/nudges/log', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    const { rows } = await getPool().query(
      `SELECT n.id, n.shown_at, n.window_secs, n.answer, n.answered_at, n.dismissed_at,
              array_length(n.sections, 1) AS section_count,
              COALESCE(s.first_name || ' ' || s.last_name, 'staff ' || n.staff_id) AS staff
         FROM signal_nudges n
         LEFT JOIN staff s ON s.id = n.staff_id
        WHERE n.shown_at > now() - ($1 || ' days')::interval
        ORDER BY n.shown_at DESC
        LIMIT 200`, [String(days)]);
    res.json({ days, nudges: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Deadline banners (28 Oct 2026) ───────────────────────────────────────────
// Toby, after the November invoices did not go out: "When things like this go
// past due date I need a banner reminder. Maybe add that type of notification in
// settings?" The signals engine (signals_enabled) has never been switched on, so
// nothing told him. Banners do not wait for it: GET /banners asks only the
// signals a manager has chosen to see as a banner, directly and read-only — no
// notification, no signal_events row, no cooldown or daily cap, no local-model
// wording — and the Roost top bar shows whatever comes back. Choices live in
// settings.signal_banners ({key: true|false}), NOT in signal_state.config,
// because the Thresholds form replaces that object wholesale.
const BANNER_DEFAULTS = { invoice_run_due: true };
// A banner keeps going until the job is done, not just for the signal's short
// after-the-day grace (5 days for invoices) — that is the whole point of it.
const BANNER_GRACE_DAYS = 20;

async function bannerPrefs(db) {
  let saved = {};
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'signal_banners'`);
    if (rows[0] && rows[0].value) saved = JSON.parse(rows[0].value) || {};
  } catch (_) { saved = {}; }
  const out = {};
  for (const s of registry.all()) {
    out[s.key] = typeof saved[s.key] === 'boolean' ? saved[s.key] : !!BANNER_DEFAULTS[s.key];
  }
  return out;
}

/** GET /api/signals/banners — what to show at the top of Roost right now. */
router.get('/banners', requireManager, async (req, res) => {
  if (req._portal && req._portal !== 'admin') return res.json({ banners: [], prefs: {} });
  try {
    const db = getPool();
    const prefs = await bannerPrefs(db);
    const { rows: muted } = await db.query(`SELECT signal_key FROM signal_state WHERE muted = true`);
    const mutedSet = new Set(muted.map(r => r.signal_key));
    const { rows: st } = await db.query(`SELECT signal_key, config FROM signal_state`);
    const cfgBy = Object.fromEntries(st.map(r => [r.signal_key, r.config || {}]));
    const today = require('../lib/signals/_util').londonToday(new Date());
    const setting = runner.makeSettingReader(db);
    const banners = [];
    for (const s of registry.all()) {
      if (!prefs[s.key] || mutedSet.has(s.key) || typeof s.evaluate !== 'function') continue;
      const cfg = Object.assign({}, s.defaults, cfgBy[s.key] || {});
      if (typeof cfg.grace_days === 'number') cfg.grace_days = Math.max(cfg.grace_days, BANNER_GRACE_DAYS);
      try {
        const r = await s.evaluate({ db, now: new Date(), today, setting, dryRun: true, cfg });
        if (r && r.headline) {
          const overdue = r.facts && typeof r.facts.days_away === 'number' && r.facts.days_away < 0;
          banners.push({ key: s.key, label: s.label, headline: r.headline, link: s.link || null,
                         fingerprint: r.fingerprint || null, overdue, priority: s.priority || 99 });
        }
      } catch (e) {
        console.warn('[signals/banners]', s.key, e.message);
      }
    }
    banners.sort((a, b) => (b.overdue - a.overdue) || (a.priority - b.priority));
    res.json({ banners, prefs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** PUT /api/signals/banners/:key  { on: true|false } — the Signals screen's switch. */
router.put('/banners/:key', requireManager, async (req, res) => {
  const s = registry.byKey(req.params.key);
  if (!s) return res.status(404).json({ error: 'No such signal' });
  const on = !!(req.body && req.body.on);
  try {
    const db = getPool();
    const prefs = await bannerPrefs(db);
    prefs[s.key] = on;
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('signal_banners', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(prefs)]);
    res.json({ ok: true, key: s.key, on, prefs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
