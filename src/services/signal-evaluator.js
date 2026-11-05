'use strict';
/**
 * b311 — the scheduled evaluator.
 *
 * The brief: "The evaluator itself belongs in Wren, next to the data — a
 * scheduled job plus src/lib/signals/*.js, surfaced through the existing
 * notifications machinery, so it inherits the per-staff notification settings
 * already built."
 *
 * ── WHY IN-PROCESS AND NOT CRON ─────────────────────────────────────────────
 * Two reasons, and the second is the one that matters.
 *
 * 1. Every other timed thing in Wren already works this way — the dispatcher's
 *    30-second poller, the termly watcher, the four drainers. A tenth pattern
 *    would be a tenth thing to remember.
 *
 * 2. A crontab line runs the working tree. A build that edits a file under
 *    wren/scripts reaches production that night whether or not anybody deployed
 *    it — which is exactly how a DEV-ONLY build stops being dev-only. Living
 *    inside the server process means this code starts running in production on
 *    the day somebody rebuilds the image, and not one minute before.
 *
 * ── CADENCE ─────────────────────────────────────────────────────────────────
 * Hourly by default (settings.signals_interval_minutes). That is not a
 * responsiveness figure — the runner's own window, cooldowns and daily cap
 * decide when anything is actually said. It is just how often the questions get
 * asked, and asking them costs a handful of counting queries.
 *
 * The first pass is deliberately delayed: a container restart at 09:00 should
 * not put four notifications on somebody's screen before the pool has warmed
 * up, and nothing here is urgent enough to want that.
 *
 * SIGNALS_EVALUATOR_DISABLED=true turns it off entirely.
 */

const { getPool } = require('../db/pool');

const FIRST_RUN_DELAY_MS = 3 * 60 * 1000;      // three minutes after boot
const DEFAULT_INTERVAL_MIN = 60;
const MIN_INTERVAL_MIN = 5;

let _started = false;
let _timer = null;
let _last = null;

async function _intervalMs() {
  try {
    const { rows } = await getPool().query(
      `SELECT value FROM settings WHERE key = 'signals_interval_minutes'`);
    const v = parseInt(rows[0] && rows[0].value, 10);
    if (Number.isFinite(v) && v >= MIN_INTERVAL_MIN) return v * 60000;
  } catch (_) { /* fall through to the default */ }
  return DEFAULT_INTERVAL_MIN * 60000;
}

async function sweep() {
  const runner = require('../lib/signals/runner');
  try {
    const out = await runner.runOnce({});
    _last = { at: new Date().toISOString(), fired: out.fired || 0, held_back: out.held_back || 0 };
    // Log the SHAPE of the run, never the wording — a signal body can carry
    // counts about children, and build logs are neither walled nor rotated.
    const byOutcome = out.results.reduce((a, r) => (a[r.outcome] = (a[r.outcome] || 0) + 1, a), {});
    const summary = Object.entries(byOutcome).map(([k, v]) => `${k} ${v}`).join(', ');
    if ((out.fired || 0) > 0 || (out.held_back || 0) > 0) {
      console.log(`[signals] ${summary}`);
    }
  } catch (e) {
    _last = { at: new Date().toISOString(), error: e.message };
    console.error('[signals] sweep failed:', e.message);
  }
}

function startSignalEvaluator() {
  if (_started) return;
  if (String(process.env.SIGNALS_EVALUATOR_DISABLED || '') === 'true') {
    console.log('[signals] evaluator disabled by SIGNALS_EVALUATOR_DISABLED');
    return;
  }
  _started = true;

  const schedule = async () => {
    const ms = await _intervalMs();
    if (_timer) clearInterval(_timer);
    // The interval is re-read on every tick, so changing
    // settings.signals_interval_minutes takes effect within one cycle rather
    // than at the next container restart.
    _timer = setTimeout(async () => { await sweep(); schedule(); }, ms);
    if (_timer.unref) _timer.unref();
  };

  setTimeout(async () => { await sweep(); schedule(); }, FIRST_RUN_DELAY_MS).unref?.();
  console.log(`[signals] evaluator started (first pass in ${FIRST_RUN_DELAY_MS / 60000} min, then hourly by default)`);
}

function lastRun() { return _last; }

module.exports = { startSignalEvaluator, sweep, lastRun };
