'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * cctv-alerts.js — b505 (2026-10-18)
 *
 * Out-of-hours intruder alerting. Reads detections off the recorder, decides
 * whether the building should have been empty, and — only then — sends Toby a
 * short TEXT notification loud enough to get through Do Not Disturb.
 *
 * Toby, 2026-10-17 evening: "don't bother with my home assistant. Just do it
 * through the front end in the Security panel page with CCTV on Wren. If you can
 * get it so that Wren / the admin can send me notifications that go through Do
 * Not Disturb, that would be great."
 *
 * ── THE FOUR GATES, IN ORDER ──────────────────────────────────────────────────
 *   1. ARMED?        settings.security_alerts_armed must be 'on'. Default off.
 *   2. OUT OF HOURS? src/lib/security-hours.js, and it must be CERTAIN. An
 *                    uncertain answer means in-hours, which means no alert.
 *   3. IN SERVICE?   the camera must be one Wren says exists. A detection from a
 *                    camera that is not in service is recorded and not sent.
 *   4. NOT A REPEAT? one alert per camera per settings.security_alerts_dedup_minutes.
 *
 * Every decision writes a cctv_alerts row, INCLUDING the suppressions. A system
 * that silently sends nothing is indistinguishable from a camera that saw
 * nothing, and for a security log that is the wrong thing to be unable to tell
 * you. `suppressed` + `suppress_reason` is how the hub shows "it saw this and
 * chose not to wake you, because …".
 *
 * ── WHAT NEVER LEAVES ─────────────────────────────────────────────────────────
 * No snapshot, no clip, no attachment, no deep link to footage. Frigate puts a
 * base64 JPEG in every event row; frigate.publicEvent() strips it and nothing
 * here ever reads e.thumbnail. The message is a time, a camera name and
 * "Open Roost → Security hub". Footage stays behind the §3 trigger and the audit
 * log, which is the whole point of having them.
 *
 * ── NO CRON IS INSTALLED BY THIS BUILD ────────────────────────────────────────
 * sweep() is idempotent (cctv_alerts_event_uq makes a re-read a no-op), so it is
 * safe to call from a page load, from the route, or from a cron line. The cron
 * line is written up in the NOTES file for Toby to install deliberately; a
 * DEV-ONLY build does not add a host cron job that would reach prod that night.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const frigate = require('./frigate');
const hours   = require('./security-hours');
const ntfy    = require('./ntfy');

const DEFAULT_LABELS = ['person', 'car'];
const DEFAULT_DEDUP_MINUTES = 5;
const LOOKBACK_SECONDS = 15 * 60;    // a sweep considers the last 15 minutes of events

async function setting(db, key, fallback) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null ? String(rows[0].value) : fallback;
  } catch (e) { return fallback; }
}

/** Armed? Default OFF, and unreadable means OFF. Nothing wakes anybody by accident. */
async function isArmed(db) {
  return String(await setting(db, 'security_alerts_armed', 'off')).toLowerCase() === 'on';
}

async function labels(db) {
  const raw = await setting(db, 'security_alerts_labels', DEFAULT_LABELS.join(','));
  const out = String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return out.length ? out : DEFAULT_LABELS.slice();
}

async function dedupMinutes(db) {
  const n = parseInt(await setting(db, 'security_alerts_dedup_minutes', String(DEFAULT_DEDUP_MINUTES)), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 180) : DEFAULT_DEDUP_MINUTES;
}

/** Which camera keys Wren says physically exist. Same precedence as cameras.js. */
async function camerasInService(db) {
  const parse = s => String(s || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  let keys = parse(await setting(db, 'cameras_in_service', ''));
  if (!keys.length) keys = parse(process.env.CAMERAS_IN_SERVICE);
  if (!keys.length) keys = ['door'];
  return keys;
}

async function cameraRows(db, keys) {
  try {
    const { rows } = await db.query(
      `SELECT id, key, name FROM cameras WHERE lower(key) = ANY($1)`, [keys]);
    return rows;
  } catch (e) { return []; }
}

// ── The message ──────────────────────────────────────────────────────────────
// Text only. Deliberately short enough to read on a lock screen, and deliberately
// carries no way to see footage without going through the audited path.
function alertText(cameraName, label, when) {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: hours.TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(when);
  const what = label === 'car' ? 'A vehicle' : label === 'person' ? 'Someone' : `A ${label}`;
  return {
    title: `Nursery — ${cameraName}`,
    body: `${what} detected at ${cameraName}, ${hhmm}. The building should be empty. `
        + `Open Roost → Security hub to look.`,
  };
}

/**
 * Record one alert decision and, if every gate passes, send it.
 * Idempotent on frigate_event.
 *
 * @returns {Promise<{sent:boolean, suppressed:string|null, id:number|null}>}
 */
async function record(db, {
  cameraKey, cameraId, cameraName, label, eventId, detectedAt,
  hoursState, armed, dedupMins, isTest = false,
}) {
  let suppress = null;
  if (!armed)                                  suppress = 'disarmed';
  else if (!hoursState.out_of_hours)           suppress = 'in_hours';
  else if (!hoursState.certain)                suppress = 'in_hours';
  if (!suppress && !isTest) {
    // Dedup is per CAMERA, not per event: three people walking past the door in
    // ninety seconds is one thing happening, and three alerts is how an alerting
    // system gets muted by its owner.
    try {
      const { rows } = await db.query(
        `SELECT 1 FROM cctv_alerts
          WHERE camera_key = $1 AND delivered = true AND is_test = false
            AND detected_at >= $2::timestamptz - ($3 || ' minutes')::interval
          LIMIT 1`, [cameraKey, detectedAt, String(dedupMins)]);
      if (rows.length) suppress = 'dedup';
    } catch (e) { /* a failed dedup check must not block a real alert */ }
  }

  const msg = alertText(cameraName || cameraKey, label, new Date(detectedAt));
  let delivered = false, deliveryError = null, priority = null;

  if (!suppress) {
    const cfg = ntfy.config();
    if (!cfg.configured) {
      suppress = 'not_configured';
      deliveryError = cfg.missing.length ? `ntfy not configured (missing ${cfg.missing.join(', ')})` : null;
    } else {
      priority = ntfy.MAX_PRIORITY;
      const r = await ntfy.publish({
        title: msg.title, body: msg.body, priority,
        tags: isTest ? ['bell'] : ['rotating_light'],
      });
      delivered = !!r.ok;
      if (!r.ok) deliveryError = r.error || `ntfy failed (HTTP ${r.status})`;
    }
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO cctv_alerts
         (camera_key, camera_id, object_label, frigate_event, detected_at,
          out_of_hours, hours_reason, delivered, delivery_error,
          suppressed, suppress_reason, message, priority, is_test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ${eventId ? 'ON CONFLICT (frigate_event) WHERE frigate_event IS NOT NULL DO NOTHING' : ''}
       RETURNING id`,
      [cameraKey, cameraId || null, label || null, eventId || null, detectedAt,
       !!hoursState.out_of_hours, hoursState.reason || null,
       delivered, deliveryError,
       !!suppress, suppress,
       `${msg.title} — ${msg.body}`, priority, !!isTest]);
    return { sent: delivered, suppressed: suppress, id: rows[0] ? rows[0].id : null };
  } catch (e) {
    console.error('[cctv-alerts] could not write the alert row:', e.message);
    return { sent: delivered, suppressed: suppress, id: null, error: e.message };
  }
}

/**
 * One pass: read recent detections off the recorder and decide about each.
 * Never throws. Returns a summary the hub can show verbatim.
 */
async function sweep(db, { now = new Date(), lookbackSeconds = LOOKBACK_SECONDS } = {}) {
  const out = {
    ran_at: now.toISOString(), armed: false, recorder: null,
    considered: 0, sent: 0, suppressed: {}, errors: [], hours: null,
  };
  try {
    out.armed = await isArmed(db);
    const st = await hours.state(db, now);
    out.hours = { out_of_hours: st.out_of_hours, certain: st.certain, reason: st.reason };

    const base = await frigate.baseUrl(db);
    if (!base) { out.recorder = 'not configured'; return out; }
    const reach = await frigate.reachable(base);
    out.recorder = reach.ok ? `up (${reach.version})` : `unreachable: ${reach.error}`;
    if (!reach.ok) return out;

    const keys = await camerasInService(db);
    const rows = await cameraRows(db, keys);
    const byKey = new Map(rows.map(r => [String(r.key).toLowerCase(), r]));
    const want = await labels(db);
    const dedupMins = await dedupMinutes(db);
    const after = Math.floor(now.getTime() / 1000) - lookbackSeconds;

    for (const key of keys) {
      let evs;
      try {
        evs = await frigate.events(base, key, { after, before: Math.floor(now.getTime() / 1000) + 5, limit: 100 });
      } catch (e) { out.errors.push(`${key}: ${e.message}`); continue; }
      for (const raw of (Array.isArray(evs) ? evs : [])) {
        // publicEvent() is the only shape that ever leaves frigate.js — it is what
        // drops the base64 thumbnail. Nothing below touches `raw` again.
        const e = frigate.publicEvent(raw);
        if (!want.includes(String(e.label || '').toLowerCase())) continue;
        out.considered++;
        const cam = byKey.get(String(key).toLowerCase());
        const r = await record(db, {
          cameraKey: key, cameraId: cam && cam.id, cameraName: (cam && cam.name) || key,
          label: e.label, eventId: e.id,
          detectedAt: new Date((e.start_time || 0) * 1000).toISOString(),
          hoursState: st, armed: out.armed, dedupMins,
        });
        if (r.sent) out.sent++;
        if (r.suppressed) out.suppressed[r.suppressed] = (out.suppressed[r.suppressed] || 0) + 1;
      }
    }
  } catch (e) {
    out.errors.push(e.message);
  }
  return out;
}

/**
 * "Send test alert" from the hub. Bypasses the arm toggle, the hours gate and the
 * dedup window — the point is to prove the phone rings — but is marked is_test so
 * it can never be mistaken for a detection, and it says so in its own text.
 */
async function sendTest(db, { staffName } = {}) {
  const st = await hours.state(db);
  const cfg = ntfy.config();
  if (!cfg.configured) {
    return { ok: false, error: `ntfy is not configured (missing ${cfg.missing.join(', ')}). `
      + 'See wren-docs/compliance/cctv-policy-v1.2-DRAFT.md and the b505 NOTES for the setup.' };
  }
  const r = await ntfy.publish({
    title: 'Nursery — test alert',
    body: `This is a TEST from Wren's Security hub${staffName ? `, sent by ${staffName}` : ''}. `
        + 'If this woke your phone through Do Not Disturb, the alerting path works.',
    priority: ntfy.MAX_PRIORITY, tags: ['bell'],
  });
  try {
    await db.query(
      `INSERT INTO cctv_alerts
         (camera_key, object_label, detected_at, out_of_hours, hours_reason,
          delivered, delivery_error, suppressed, suppress_reason, message, priority, is_test)
       VALUES ('(test)', NULL, now(), $1, $2, $3, $4, false, NULL, $5, $6, true)`,
      [!!st.out_of_hours, st.reason || null, !!r.ok, r.ok ? null : (r.error || null),
       'Test alert sent from the Security hub.', ntfy.MAX_PRIORITY]);
  } catch (e) { /* the send is the point; a log failure is reported, not fatal */ }
  return r.ok ? { ok: true } : { ok: false, error: r.error || `ntfy replied HTTP ${r.status}` };
}

module.exports = {
  isArmed, sweep, record, sendTest, alertText,
  camerasInService, labels, dedupMinutes,
  DEFAULT_LABELS, DEFAULT_DEDUP_MINUTES, LOOKBACK_SECONDS,
};
