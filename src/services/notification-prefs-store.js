'use strict';

/**
 * b230 (2026-08-25) — ONE write path for per-staff notification preferences.
 *
 * Why this file exists
 * --------------------
 * Three screens and four endpoints were writing the same preferences into two
 * tables, independently:
 *
 *   user_notification_prefs  (staff_id, category, mode)              ← PUT /api/notifications/my-settings
 *   notification_preferences (staff_id, event_category, channels[],  ← PUT /api/notifications/prefs
 *                             enabled, scope)                          PUT /api/notifications/prefs/:staffId
 *   …and both at once                                                ← PUT /api/notification-matrix
 *
 * The dispatcher reads BOTH: mode gates whether anything is created at all
 * (see _getUserCategoryMode), then `enabled`/`channels`/`scope` decide where it
 * goes. So a staff member who turned a category "off" on one screen could still
 * have enabled=true on the other, and vice versa — the two screens disagreed
 * and the dispatcher obeyed whichever it happened to consult first. That is the
 * bug that produced the b230 ticket.
 *
 * Every endpoint now funnels through savePreferences() below. It is a MERGE,
 * not a replace: a caller sends only the fields it knows about (the old
 * /prefs endpoint knows channels+enabled but not mode; /my-settings knows mode
 * but not scope) and the store fills the rest from what is already stored, then
 * writes both tables inside one transaction. Whatever you change, the two
 * tables come out consistent.
 *
 * Deliberately NOT merged in: notification_schedule_prefs. That is a
 * SETTING-WIDE queue policy (channel × event_type × working-hours/away-mode)
 * read by the queue drainer, not a per-staff preference. Different axis, not a
 * duplicate — collapsing it would be a migration, not a settings screen.
 */

const {
  CATEGORY_KEYS, isComplianceLocked, defaultModeForCategory,
  CATEGORIES,
} = require('./notification-categories');

const MODES    = ['off', 'inapp', 'inapp_push', 'digest'];
const SCOPES   = ['all', 'my_room', 'my_keychildren'];
const CHANNELS = ['inapp', 'telegram', 'email', 'webpush'];

// A compliance-locked category may not be silenced. 'digest' is blocked
// alongside 'off' because a digest defers to the next daily rollup — up to
// ~24h — which for a safeguarding concern or a ratio breach is the same thing
// as off. (PUT /my-settings already enforced this; the matrix only blocked
// 'off'. Unified here, which is the whole point of a single write path.)
const BLOCKED_FOR_LOCKED = new Set(['off', 'digest']);

const isValidTime = v => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(v || ''));

/**
 * Normalise one incoming row into the canonical shape, merging with whatever is
 * already stored for that (staff, category).
 *
 * Incoming may carry any subset of:
 *   { key | category | event_category, mode, enabled, telegram, email,
 *     channels: [...], scope }
 *
 * @returns {{key, mode, channels: string[], enabled: boolean, scope: string}}
 */
function _mergeRow(incoming, current) {
  const key = String(incoming.key || incoming.category || incoming.event_category || '');

  // ── mode ──────────────────────────────────────────────────────────────────
  let mode = MODES.includes(incoming.mode) ? incoming.mode : null;
  if (mode === null && incoming.enabled === false) {
    // Old-style caller turning a category off: express it as mode 'off' too.
    mode = 'off';
  }
  if (mode === null) {
    mode = current.mode || defaultModeForCategory(key);
    // Old-style caller turning a category back ON while the stored mode still
    // says 'off' — re-enabling must actually re-enable, so fall back to the
    // category default rather than leaving it silently muted.
    if (incoming.enabled === true && mode === 'off') mode = defaultModeForCategory(key);
  }

  // ── channels ──────────────────────────────────────────────────────────────
  // Start from what the dispatcher already knows about this person so a screen
  // that has no opinion on (say) email cannot delete their email channel.
  const set = new Set(
    Array.isArray(incoming.channels)
      ? incoming.channels.filter(c => CHANNELS.includes(c))
      : (current.channels || ['inapp']).filter(c => CHANNELS.includes(c))
  );
  set.add('inapp');                                   // the bell is never optional
  if (incoming.telegram === true)  set.add('telegram');
  if (incoming.telegram === false) set.delete('telegram');
  if (incoming.email === true)     set.add('email');
  if (incoming.email === false)    set.delete('email');

  // ── scope ─────────────────────────────────────────────────────────────────
  const scope = SCOPES.includes(incoming.scope) ? incoming.scope : (current.scope || 'all');

  // enabled is derived, never independent: 'off' is the single source of truth
  // for "this person does not want this". Keeping it derived is what stops the
  // two tables drifting apart again.
  return { key, mode, channels: Array.from(set), enabled: mode !== 'off', scope };
}

/**
 * Read the current stored state for a set of categories, so _mergeRow has
 * something to merge against. One round trip, not one per row.
 */
async function _loadCurrent(client, staffId, keys) {
  if (!keys.length) return {};
  const [modes, prefs] = await Promise.all([
    client.query(
      `SELECT category, mode FROM user_notification_prefs
        WHERE staff_id=$1 AND category = ANY($2::varchar[])`, [staffId, keys]),
    client.query(
      `SELECT event_category, channels, enabled, scope FROM notification_preferences
        WHERE staff_id=$1 AND event_category = ANY($2::varchar[])`, [staffId, keys]),
  ]);
  const out = {};
  for (const k of keys) out[k] = {};
  for (const r of modes.rows) (out[r.category] ||= {}).mode = r.mode;
  for (const r of prefs.rows) {
    const o = (out[r.event_category] ||= {});
    o.channels = r.channels; o.enabled = r.enabled; o.scope = r.scope;
  }
  return out;
}

/**
 * Save preferences for one member of staff. Transactional across both tables.
 *
 * @param {import('pg').Pool} db
 * @param {number} staffId
 * @param {object} payload  { categories: [...], quiet_hours: {...} }
 * @returns {Promise<{saved:number, rejected:Array<{key:string, why:string}>}>}
 */
async function savePreferences(db, staffId, payload) {
  const rows      = Array.isArray(payload && payload.categories) ? payload.categories : [];
  const quiet     = payload && payload.quiet_hours;
  const rejected  = [];
  const accepted  = [];

  // Validate first, so one bad row cannot half-apply a batch.
  const wanted = [];
  for (const r of rows) {
    const key = String((r && (r.key || r.category || r.event_category)) || '');
    if (!CATEGORY_KEYS.includes(key)) { rejected.push({ key, why: 'unknown category' }); continue; }
    wanted.push(key);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const current = await _loadCurrent(client, staffId, wanted);

    for (const r of rows) {
      const key = String((r && (r.key || r.category || r.event_category)) || '');
      if (!CATEGORY_KEYS.includes(key)) continue;              // already rejected above

      const merged = _mergeRow(r, current[key] || {});

      if (isComplianceLocked(key) && BLOCKED_FOR_LOCKED.has(merged.mode)) {
        const label = (CATEGORIES[key] && CATEGORIES[key].label) || key;
        rejected.push({
          key,
          why: `${label} cannot be set to ${merged.mode === 'off' ? 'off' : 'digest'}`
             + ' — compliance-critical, must be delivered immediately',
        });
        continue;
      }

      await client.query(
        `INSERT INTO user_notification_prefs (staff_id, category, mode, updated_at)
              VALUES ($1,$2,$3,NOW())
         ON CONFLICT (staff_id, category)
           DO UPDATE SET mode = EXCLUDED.mode, updated_at = NOW()`,
        [staffId, key, merged.mode]);

      await client.query(
        `INSERT INTO notification_preferences
                (staff_id, event_category, channels, enabled, scope, updated_at)
              VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (staff_id, event_category)
           DO UPDATE SET channels   = EXCLUDED.channels,
                         enabled    = EXCLUDED.enabled,
                         scope      = EXCLUDED.scope,
                         updated_at = NOW()`,
        [staffId, key, merged.channels, merged.enabled, merged.scope]);

      accepted.push(key);
    }

    if (quiet && typeof quiet === 'object') {
      // Accept both shapes in use: {enabled,start,end} (my-settings) and
      // {quiet_hours_enabled,quiet_hours_start,quiet_hours_end} (matrix).
      const enabled = (quiet.enabled !== undefined ? quiet.enabled : quiet.quiet_hours_enabled) !== false;
      const rawS    = quiet.start !== undefined ? quiet.start : quiet.quiet_hours_start;
      const rawE    = quiet.end   !== undefined ? quiet.end   : quiet.quiet_hours_end;
      const start   = isValidTime(rawS) ? String(rawS) : '20:00';
      const end     = isValidTime(rawE) ? String(rawE) : '07:00';
      await client.query(
        `INSERT INTO user_notification_settings
                (staff_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, updated_at)
              VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (staff_id)
           DO UPDATE SET quiet_hours_enabled = EXCLUDED.quiet_hours_enabled,
                         quiet_hours_start   = EXCLUDED.quiet_hours_start,
                         quiet_hours_end     = EXCLUDED.quiet_hours_end,
                         updated_at          = NOW()`,
        [staffId, enabled, start, end]);
    }

    await client.query('COMMIT');
    return { saved: accepted.length, rejected };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { savePreferences, MODES, SCOPES, CHANNELS };
