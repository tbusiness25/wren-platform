'use strict';
/**
 * request-audit.js (b164, 2026-07-27) — automatic per-request activity logging.
 *
 * Hooked from src/middleware/auth.js (authenticate), so EVERY authenticated API
 * request on every portal lands in ladn.audit_log with no per-route wiring:
 * who, what (view/create/update/delete/download), which entity, status, duration.
 * Client-side page_view/click/session_end events arrive separately via
 * POST /api/audit/beacon (src/routes/audit.js).
 *
 * Design constraints:
 *  - fire-and-forget (recordAudit never throws) — cannot break a request.
 *  - skip-list for machine polling so the log stays human-meaningful.
 *  - 10s in-memory throttle per (actor, method, path) to absorb parallel fetches
 *    from a single screen render.
 */
const { recordAudit } = require('./audit');

// Polling / self-noise endpoints — never logged.
const SKIP = [
  /^\/api\/notifications/, /^\/api\/audit(\/|$)/, /^\/api\/assistant\/health/,
  /^\/api\/devices\/status/, /^\/api\/auth\/(me|refresh|heartbeat)/, /^\/api\/health/,
  /^\/api\/away-mode\/status/, /^\/api\/state\//,
  // b345 (2026-09-21): the anonymous "tell management" box. This is NOT noise-suppression, it is
  // the anonymity guarantee: a logged POST here would put the writer's staff id, ip, user agent
  // and a millisecond timestamp in audit_log next to the comment's arrival. The route writes its
  // own actor-less, day-stamped line instead (src/routes/staff-voice.js). Only /speak-up — the
  // named entries and the manager's /inbox reads are logged like everything else.
  /^\/api\/staff-voice\/speak-up(\/|$)/,
  // b356 (2026-09-24): the same anonymity guarantee, for parents — genuinely anonymous feedback
  // and answers on the current-parent side of the question board. Both handlers in
  // src/routes/parent-voice.js never read req.user; a logged POST here would put the parent's
  // id, ip, user agent and a millisecond timestamp next to a submission that promises none of
  // that. Reads (/inbox, /questions/admin) are NOT skipped.
  /^\/api\/parent-voice\/feedback(\/|$)/,
  /^\/api\/parent-voice\/questions\/[^/]+\/answer$/,
];

const DOWNLOAD_RX = /export|download|\.csv|\.pdf|\.xlsx|\/print(\/|$)/i;

const ACTION_BY_METHOD = { GET: 'view', HEAD: 'view', POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

// (actorId|method|path) -> last log epoch-ms. Swept lazily.
const _recent = new Map();
const THROTTLE_MS = 10000;
let _lastSweep = 0;

function _throttled(key, now) {
  if (now - _lastSweep > 60000) {
    for (const [k, t] of _recent) if (now - t > THROTTLE_MS) _recent.delete(k);
    _lastSweep = now;
  }
  const last = _recent.get(key);
  _recent.set(key, now);
  return last != null && (now - last) < THROTTLE_MS;
}

function classify(method, path) {
  if (DOWNLOAD_RX.test(path)) return 'download';
  return ACTION_BY_METHOD[method] || method.toLowerCase();
}

function entityOf(path) {
  // /api/<entity>/<maybe-id>/...  → entity_type + numeric entity_id when present
  const m = path.match(/^\/api\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?/i);
  if (!m) return { entity_type: 'api', entity_id: null };
  const seg2 = m[2] && /^\d+$/.test(m[2]) ? m[2] : null;
  return { entity_type: m[1], entity_id: seg2 };
}

function logRequest(req, res) {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (!path.startsWith('/api/')) return;
  for (const rx of SKIP) if (rx.test(path)) return;
  const method = (req.method || 'GET').toUpperCase();
  // Views are throttled; mutations always log.
  const action = classify(method, path);
  const actorId = req.user?.id ?? 'anon';
  if (action === 'view' && _throttled(actorId + '|' + method + '|' + path, Date.now())) return;
  const started = Date.now();
  res.on('finish', () => {
    try {
      // Only log real outcomes; 401/403 spam (expired tokens, probes) stays out —
      // security-relevant denials are already captured by hr_blocked_routes etc.
      if (res.statusCode >= 400 && res.statusCode !== 404) return;
      const { entity_type, entity_id } = entityOf(path);
      recordAudit({
        req, action, entity_type, entity_id,
        meta: {
          method, path, status: res.statusCode,
          ms: Date.now() - started, portal: req._portal || null, auto: true,
        },
      });
    } catch { /* never throw */ }
  });
}

module.exports = { logRequest };
