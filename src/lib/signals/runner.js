'use strict';
/**
 * b311 — the evaluator.
 *
 *     signal (SQL, deterministic) → threshold → phrasing (local model) → one notification
 *
 * This file is the middle three arrows. Its job is mostly to say NOTHING, and
 * every branch below that returns early is the feature.
 *
 * ── THE ORDER OF THE GATES, AND WHY ─────────────────────────────────────────
 *  1. globally off / outside the working window   — nobody is woken at 03:00
 *  2. muted (by a person, or by itself)           — hard rule 3
 *  3. evaluate                                    — the only place truth is decided
 *  4. nothing to say                              — CLEARS the open events, which
 *                                                   is how "somebody acted" is
 *                                                   distinguished from "somebody
 *                                                   dismissed it and ignored it"
 *  5. cooldown / minimum gap                      — the same fact, twice, is noise
 *  6. dismissed N times running, condition still  — the signal mutes ITSELF and
 *     standing                                      says so, once
 *  7. daily cap                                   — a capped signal does NOT
 *                                                   consume its cooldown, so it
 *                                                   gets its turn tomorrow
 *  8. phrase, guard, send, record
 *
 * ── WHAT IT NEVER DOES ──────────────────────────────────────────────────────
 * It reads. The only rows this build writes are its own three tables and the
 * notifications the dispatcher creates. There is no UPDATE against a nursery
 * table anywhere in src/lib/signals — that is checkable by grep and the b311
 * test harness checks it.
 *
 * It also cannot email anybody. Every signal category is on
 * EMAIL_BLOCKED_CATEGORIES in src/services/notification-dispatcher.js, which is
 * the single point every channel decision passes through; and the dispatcher's
 * allowlist fails closed anyway, so an unclassified category is not emailed
 * either. A parent's address is not reachable from here by any path: the
 * dispatcher only ever resolves recipients out of ladn.staff.
 */

const { getPool } = require('../../db/pool');
const registry = require('./index');
const U = require('./_util');
const phrasing = require('./phrasing');
const nameGuard = require('./child-name-guard');
const { notifyAsync } = require('../../services/notification-dispatcher');

const OUTCOMES = ['fired', 'silent', 'dormant', 'cooling', 'capped', 'muted', 'disabled', 'error', 'closed'];

// ── settings ────────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {object} [overrides] values that win over the settings table for this
 *   run only. Used by the Roost "what would this say if…" preview and by the
 *   b311 test harness, which needs to prove the daily cap holds without editing
 *   the setting a live nursery is running on.
 */
function makeSettingReader(db, overrides) {
  let cache = null;
  const over = overrides || {};
  return async function setting(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(over, key)) return String(over[key]);
    if (!cache) {
      cache = {};
      try {
        const { rows } = await db.query(`SELECT key, value FROM settings`);
        for (const r of rows) cache[r.key] = r.value;
      } catch (e) { /* a missing settings table means every default applies */ }
    }
    const v = cache[key];
    return (v === undefined || v === null || v === '') ? fallback : v;
  };
}

const isTrue = v => String(v) !== 'false' && String(v) !== '0' && String(v) !== '';

/** Is now inside the window a notification is allowed to appear in? */
function withinWindow(now, startHM, endHM, weekdaysOnly) {
  const hm = U.londonHM(now);
  const day = new Date(now).toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'short' });
  if (weekdaysOnly && !['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(day)) {
    return { ok: false, why: `${day} — signals are weekdays only` };
  }
  if (hm < startHM || hm >= endHM) {
    return { ok: false, why: `${hm} is outside ${startHM}–${endHM}` };
  }
  return { ok: true, why: '' };
}

// ── state ───────────────────────────────────────────────────────────────────

async function loadState(db, key) {
  await db.query(
    `INSERT INTO signal_state (signal_key) VALUES ($1) ON CONFLICT (signal_key) DO NOTHING`, [key]);
  const { rows } = await db.query(`SELECT * FROM signal_state WHERE signal_key = $1`, [key]);
  return rows[0];
}

async function markRun(db, key, outcome, detail) {
  await db.query(
    `UPDATE signal_state
        SET last_run_at = now(), last_run_outcome = $2, last_run_detail = $3, updated_at = now()
      WHERE signal_key = $1`,
    [key, outcome, detail ? String(detail).slice(0, 500) : null]);
}

/**
 * A signal that has gone quiet closes its open events. That stamp is the ONLY
 * evidence this system has that a notification led to something being done, and
 * the self-muting rule below is measured against it.
 */
async function clearOpenEvents(db, key) {
  const { rowCount } = await db.query(
    `UPDATE signal_events SET cleared_at = now()
      WHERE signal_key = $1 AND cleared_at IS NULL`, [key]);
  return rowCount;
}

/**
 * How many times running has this been dismissed with the condition still
 * standing? An event counts as dismissed when every notification it created
 * carries a dismissed_at. An event that was CLEARED breaks the streak, because
 * clearing means the thing got done.
 */
async function dismissStreak(db, key, limit) {
  const { rows } = await db.query(
    `SELECT e.id, e.cleared_at,
            (SELECT bool_and(n.dismissed_at IS NOT NULL)
               FROM notifications n WHERE n.id = ANY(e.notification_ids)) AS all_dismissed
       FROM signal_events e
      WHERE e.signal_key = $1
      ORDER BY e.fired_at DESC
      LIMIT $2`, [key, limit]);
  if (rows.length < limit) return 0;
  let streak = 0;
  for (const r of rows) {
    if (r.cleared_at) break;
    if (r.all_dismissed !== true) break;
    streak++;
  }
  return streak;
}

async function firedToday(db, today) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM signal_events
      WHERE (fired_at AT TIME ZONE 'Europe/London')::date = $1::date`, [today]);
  return rows[0].n;
}

// ── recipients ──────────────────────────────────────────────────────────────

/**
 * 'all-managers' → one broadcast notification (the dispatcher expands it).
 * 'dsl'          → one notification per designated safeguarding lead, falling
 *                  back to the manager broadcast if nobody is flagged.
 */
async function resolveRecipients(db, kind) {
  if (kind === 'dsl') {
    const { rows } = await db.query(
      `SELECT id FROM staff
        WHERE is_active = true AND COALESCE(terminated, false) = false
          AND (COALESCE(is_dsl, false) = true OR COALESCE(is_deputy_dsl, false) = true)
        ORDER BY is_dsl DESC, id`);
    if (rows.length) return { mode: 'staff', ids: rows.map(r => r.id), note: 'DSL' };
    return { mode: 'broadcast', ids: [], note: 'no DSL recorded — fell back to managers' };
  }
  return { mode: 'broadcast', ids: [], note: '' };
}

async function managerIds(db) {
  try {
    const { rows } = await db.query(
      `SELECT id FROM staff WHERE is_active = true AND role IN ('manager','room_leader')`);
    return rows.map(r => r.id);
  } catch (_) { return []; }
}

// ── the body: what it saw ───────────────────────────────────────────────────

const FACT_LABELS = {
  as_of: 'as of', days_away: 'days away', run_date: 'run date', pay_date: 'pay date',
  headcount_date: 'headcount date', page_last_edited: 'page last edited',
  gap_days: 'the standard', share_pct: 'share of roll (%)',
};

function humanKey(k) {
  return FACT_LABELS[k] || String(k).replace(/_/g, ' ');
}

/**
 * Rule 4 of the brief, made mechanical: the body of every notification carries
 * the fact set the claim was built from, so a manager can check it against the
 * screen the link opens. Scalars only — a nested object goes to signal_events
 * for the Roost screen but is not readable in a bell popover.
 */
function factsLine(facts) {
  const bits = [];
  for (const [k, v] of Object.entries(facts || {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    if (typeof v === 'boolean') { bits.push(`${humanKey(k)}: ${v ? 'yes' : 'no'}`); continue; }
    bits.push(`${humanKey(k)}: ${v}`);
  }
  return bits.length ? `Wren counted — ${bits.join('; ')}.` : '';
}

// ── one signal ──────────────────────────────────────────────────────────────

async function runSignal(signal, ctx) {
  const { db, today, dryRun } = ctx;
  const state = await loadState(db, signal.key);
  const cfg = Object.assign({}, signal.defaults, state.config || {},
    (ctx.cfgOverrides && ctx.cfgOverrides[signal.key]) || {});
  const report = { key: signal.key, label: signal.label, priority: signal.priority, outcome: 'silent', detail: '' };

  if (state.muted) {
    report.outcome = 'muted';
    report.detail = state.auto_muted ? 'muted itself' : (state.mute_reason || 'muted by a manager');
    if (!dryRun) await markRun(db, signal.key, 'muted', report.detail);
    return report;
  }

  // ── 3. the only place truth is decided ───────────────────────────────────
  let result;
  try {
    result = await signal.evaluate(Object.assign({}, ctx, { cfg }));
  } catch (e) {
    report.outcome = 'error';
    report.detail = e.message;
    if (!dryRun) await markRun(db, signal.key, 'error', e.message);
    return report;
  }

  // ── 4. nothing to say. The success case. ─────────────────────────────────
  if (!result) {
    const cleared = dryRun ? 0 : await clearOpenEvents(db, signal.key);
    report.outcome = 'silent';
    report.detail = cleared ? `nothing to say — closed ${cleared} open ${U.plural(cleared, 'notice', 'notices')}` : 'nothing to say';
    if (!dryRun) await markRun(db, signal.key, 'silent', report.detail);
    return report;
  }

  if (result.dormant) {
    report.outcome = 'dormant';
    report.detail = result.reason || 'cannot be evaluated here';
    if (!dryRun) await markRun(db, signal.key, 'dormant', report.detail);
    return report;
  }

  report.headline = result.headline;
  report.fingerprint = result.fingerprint;
  report.facts = result.facts || {};

  // ── 5. cooldown / minimum gap ────────────────────────────────────────────
  const cooldownHours = Number(result.cooldownHours || cfg.cooldown_hours) || 72;
  const minGapHours = Number(cfg.min_gap_hours) || 24;
  if (state.last_fired_at) {
    const hoursSince = (ctx.now.getTime() - new Date(state.last_fired_at).getTime()) / 3600000;
    const same = state.last_fingerprint === result.fingerprint;
    if (same && hoursSince < cooldownHours) {
      report.outcome = 'cooling';
      report.detail = `same finding, ${Math.round(hoursSince)}h into a ${cooldownHours}h cooldown`;
      if (!dryRun) await markRun(db, signal.key, 'cooling', report.detail);
      return report;
    }
    if (!same && hoursSince < minGapHours) {
      report.outcome = 'cooling';
      report.detail = `the numbers moved, but only ${Math.round(hoursSince)}h since the last notice (minimum ${minGapHours}h)`;
      if (!dryRun) await markRun(db, signal.key, 'cooling', report.detail);
      return report;
    }
  }

  // ── 6. dismissed N times running, condition still standing ───────────────
  const muteAfter = parseInt(await ctx.setting('signals_dismiss_mute_after', '3'), 10) || 3;
  const streak = await dismissStreak(db, signal.key, muteAfter);
  if (streak >= muteAfter) {
    const why = `dismissed ${muteAfter} times running and the finding never went away`;
    report.outcome = 'closed';
    report.detail = `muted itself — ${why}`;
    if (!dryRun) {
      await db.query(
        `UPDATE signal_state
            SET muted = true, auto_muted = true, muted_at = now(),
                mute_reason = $2, last_run_at = now(), last_run_outcome = 'muted',
                last_run_detail = $2, updated_at = now()
          WHERE signal_key = $1`, [signal.key, `Muted itself: ${why}.`]);
      // One last message, so a signal never goes quiet without saying it has.
      await notifyAsync('signal_muted_itself', 'all-managers', null,
        `Wren has muted a signal: ${signal.label}`,
        `"${signal.label}" has been dismissed ${muteAfter} times running and the finding it reports has not changed, `
        + `so Wren has stopped raising it. Nothing about the underlying data has changed — only whether you are told. `
        + `Turn it back on from Signals when you want it.`,
        { link: '/signals.html', priority: 'normal' }).catch(() => {});
    }
    return report;
  }

  // ── 7. the daily cap ─────────────────────────────────────────────────────
  const cap = parseInt(await ctx.setting('signals_daily_cap', '4'), 10);
  if (cap > 0) {
    const already = ctx.firedThisRun + (await firedToday(db, today));
    if (already >= cap) {
      report.outcome = 'capped';
      report.detail = `held back — ${already} of a maximum ${cap} notifications already sent today`;
      // Deliberately does NOT touch last_fired_at: a capped signal keeps its
      // place in the queue and speaks tomorrow instead of losing its turn.
      if (!dryRun) await markRun(db, signal.key, 'capped', report.detail);
      return report;
    }
  }

  // ── 8. phrase, guard, send, record ───────────────────────────────────────
  const veto = async (text) => {
    try {
      const hit = await nameGuard.containsChildName(db, text);
      // The count is reported, never the name — this string is logged.
      return hit.hit ? `the wording contains ${hit.count} name(s) from the roll` : null;
    } catch (e) {
      return `the child-name guard could not run (${e.message})`;
    }
  };

  const phrased = await phrasing.phrase({
    headline: result.headline,
    facts: result.facts,
    enabled: isTrue(await ctx.setting('signals_phrasing', 'true')),
    model: await ctx.setting('signals_model', phrasing.defaultModel()),
    timeoutMs: parseInt(await ctx.setting('signals_phrase_timeout_ms', '25000'), 10),
    veto,
  });

  // The DETERMINISTIC sentence is checked too, not just the model's rewrite. A
  // signal that names a child without declaring containsChildData is a bug in
  // the signal, and it must not be the first person outside the setting who
  // finds out.
  let sentText = phrased.text;
  let phrasingNote = phrased.note;
  if (!result.containsChildData) {
    const why = await veto(sentText);
    if (why) {
      // Fall back to a wording that cannot carry a name at all.
      sentText = `${signal.label}. Open Signals to see what Wren found — the wording was withheld because ${why}.`;
      phrasingNote = `withheld: ${why}`;
    }
  }

  const link = result.link || signal.link || '/signals.html';
  const body = [sentText, factsLine(result.facts)].filter(Boolean).join('\n\n');

  const who = await resolveRecipients(db, signal.recipients);
  const notificationIds = [];
  let recipientIds = [];

  if (!dryRun) {
    if (who.mode === 'staff') {
      recipientIds = who.ids;
      for (const sid of who.ids) {
        try {
          const id = await notifyAsync(signal.category, 'staff', sid, signal.label, body,
            { link, priority: 'normal', relatedTable: 'signal_events' });
          if (id) notificationIds.push(id);
        } catch (e) { /* one recipient's preferences must not stop the rest */ }
      }
    } else {
      recipientIds = await managerIds(db);
      try {
        const id = await notifyAsync(signal.category, 'all-managers', null, signal.label, body,
          { link, priority: 'normal', relatedTable: 'signal_events' });
        if (id) notificationIds.push(id);
      } catch (e) {
        report.outcome = 'error';
        report.detail = `notify failed: ${e.message}`;
        await markRun(db, signal.key, 'error', report.detail);
        return report;
      }
    }

    const { rows: ev } = await db.query(
      `INSERT INTO signal_events
         (signal_key, fingerprint, headline, sent_text, phrasing_source, phrasing_note,
          facts, link, notification_ids, recipient_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [signal.key, result.fingerprint, result.headline, sentText,
       phrased.source, phrasingNote || null, JSON.stringify(result.facts || {}),
       link, notificationIds, recipientIds]);

    await db.query(
      `UPDATE signal_state
          SET last_fired_at = now(), last_fingerprint = $2, fire_count = fire_count + 1,
              last_run_at = now(), last_run_outcome = 'fired', last_run_detail = $3,
              updated_at = now()
        WHERE signal_key = $1`,
      [signal.key, result.fingerprint,
       `sent to ${recipientIds.length} ${U.plural(recipientIds.length, 'person', 'people')}${who.note ? ' (' + who.note + ')' : ''}`]);

    report.event_id = ev[0].id;
  }

  report.outcome = 'fired';
  report.sent_text = sentText;
  report.phrasing_source = phrased.source;
  report.phrasing_note = phrasingNote;
  report.recipients = recipientIds.length;
  report.recipient_note = who.note;
  report.link = link;
  report.detail = `sent — phrased by ${phrased.source === 'local_model' ? 'the local model' : 'the query itself'}`;
  return report;
}

// ── the sweep ───────────────────────────────────────────────────────────────

/**
 * Evaluate every signal once.
 * @param {object} opts
 * @param {string} [opts.today]   'YYYY-MM-DD' — injectable, which is what makes
 *                                every signal testable without touching a row
 * @param {string} [opts.only]    one signal key
 * @param {boolean} [opts.dryRun] evaluate and phrase, send and store nothing
 * @param {boolean} [opts.ignoreWindow] skip the working-hours gate (run-now)
 * @param {object}  [opts.settingOverrides] settings that apply to this run only
 * @param {object}  [opts.cfgOverrides] per-signal threshold overrides,
 *   { signal_key: { threshold: value } } — this run only, nothing is stored
 */
async function runOnce(opts = {}) {
  const db = opts.db || getPool();
  const now = opts.now || new Date();
  const today = opts.today || U.londonToday(now);
  const setting = makeSettingReader(db, opts.settingOverrides);

  const enabled = isTrue(await setting('signals_enabled', 'true'));
  const win = withinWindow(now,
    String(await setting('signals_window_start', '07:30')),
    String(await setting('signals_window_end', '18:30')),
    isTrue(await setting('signals_weekdays_only', 'true')));

  const signals = opts.only
    ? [registry.byKey(opts.only)].filter(Boolean)
    : registry.all();

  const out = {
    ran_at: now.toISOString(), today,
    enabled, window: win, dry_run: !!opts.dryRun,
    cap: parseInt(await setting('signals_daily_cap', '4'), 10),
    fired_before_this_run: await firedToday(db, today),
    results: [],
  };

  if (!enabled) {
    out.results = signals.map(s => ({ key: s.key, label: s.label, outcome: 'disabled', detail: 'signals_enabled is false' }));
    return out;
  }
  if (!win.ok && !opts.ignoreWindow) {
    out.results = signals.map(s => ({ key: s.key, label: s.label, outcome: 'disabled', detail: win.why }));
    return out;
  }

  let firedThisRun = 0;
  for (const signal of signals) {
    const ctx = { db, now, today, setting, dryRun: !!opts.dryRun, firedThisRun,
                  cfgOverrides: opts.cfgOverrides || null };
    let r;
    try {
      r = await runSignal(signal, ctx);
    } catch (e) {
      r = { key: signal.key, label: signal.label, outcome: 'error', detail: e.message };
      try { await markRun(db, signal.key, 'error', e.message); } catch (_) {}
    }
    if (r.outcome === 'fired') firedThisRun++;
    out.results.push(r);
  }
  out.fired = firedThisRun;
  out.held_back = out.results.filter(r => r.outcome === 'capped').length;
  return out;
}

module.exports = {
  runOnce, runSignal, withinWindow, factsLine, dismissStreak,
  clearOpenEvents, resolveRecipients, firedToday, makeSettingReader, OUTCOMES,
};
