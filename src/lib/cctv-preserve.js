'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b249 — asking the recorder to keep a clip before it is overwritten.
//
// ⚠️ THE CAMERAS ARE INSTALLED AND SWITCHED OFF. NOTHING IS RECORDING.
//    wren-docs/cctv/LADN-CCTV-Policy-2026.md v1.1 says so, and the privacy
//    notice parents are being asked to sign says so in plain English. Frigate is
//    configured (docker/frigate/config.yml.b234) but there is no Frigate
//    container on this host and no camera is connected — `cameras` has six
//    rows and every one is enabled=false.
//
//    So this module exists to be CORRECT WHEN IT FAILS. That is its whole job
//    today. Every path through it that does not end with an exported file
//    stat'd on disk ends in a failure state that the UI shows in red.
//
// THE ONE RULE
//    'preserved' is written only when (a) the recorder returned an export, (b)
//    Wren downloaded it, and (c) fs.stat found a non-empty file. The database
//    enforces the same thing independently — cctv_req_preserved_needs_clip_chk
//    rejects preserve_status='preserved' without clip_path AND clip_verified_at
//    — so a future code path cannot claim a clip that is not there either.
//
//    There is deliberately NO branch that marks a request preserved because a
//    request was accepted, because a 200 came back, or because the export was
//    queued. "Queued" is 'pending', and 'pending' is not preserved.
//
// WHY IT IS GATED OFF
//    settings.cctv_auto_preserve is 'off' and the migration will not turn it on
//    (ON CONFLICT DO NOTHING). With it off this module does nothing at all and
//    records 'disabled' — it does not attempt, and it does not pretend. Turning
//    it on before a recorder exists produces 'unavailable' rows, which is the
//    honest answer and exactly what should appear on the screen.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const CLIP_DIR = process.env.CCTV_CLIP_DIR || '/app/data/cctv-clips';
const EXPORT_TIMEOUT_MS   = 30_000;   // asking Frigate to start an export
const DOWNLOAD_TIMEOUT_MS = 180_000;  // pulling the finished file
const POLL_INTERVAL_MS    = 3_000;
const POLL_MAX_MS         = 120_000;

// The states, spelled out once. These are the CHECK constraint's values.
const S = {
  NOT_ATTEMPTED: 'not_attempted',
  DISABLED:      'disabled',
  PENDING:       'pending',
  FAILED:        'failed',
  UNAVAILABLE:   'unavailable',
  EXPIRED:       'expired',
  PRESERVED:     'preserved',
};

// ── Settings ─────────────────────────────────────────────────────────────────
async function readSettings(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings
      WHERE key IN ('cctv_auto_preserve','cctv_frigate_url')`);
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    enabled:    String(m.cctv_auto_preserve || 'off').trim().toLowerCase() === 'on',
    frigateUrl: String(m.cctv_frigate_url || process.env.FRIGATE_URL || '').trim().replace(/\/+$/, ''),
  };
}

/**
 * Is preservation switched on AND pointed at something?
 * Both are required. "On" with no recorder URL is not on — it is a
 * misconfiguration, and saying so is more use than half-trying.
 */
async function status(db) {
  const s = await readSettings(db);
  if (!s.enabled)    return { available: false, reason: 'Automatic preservation is switched off. Nothing is recording yet — the cameras are installed but not switched on.', ...s };
  if (!s.frigateUrl) return { available: false, reason: 'Automatic preservation is switched ON but no recorder address is set (settings.cctv_frigate_url is empty).', ...s };
  return { available: true, reason: 'Automatic preservation is on.', ...s };
}

// ── Minimal HTTP, so this module pulls in nothing ────────────────────────────
function request(urlStr, { method = 'GET', body = null, timeout = EXPORT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error(`bad recorder URL: ${e.message}`)); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error(`no answer from the recorder within ${timeout / 1000}s`)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function download(urlStr, destPath, timeout = DOWNLOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error(`bad export URL: ${e.message}`)); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`recorder returned HTTP ${res.statusCode} for the exported clip`));
      }
      const tmp = destPath + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => {
        // Rename only after the stream closed cleanly, so a truncated download
        // never presents itself as a finished clip.
        try { fs.renameSync(tmp, destPath); resolve(destPath); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`the clip download stalled after ${timeout / 1000}s`)));
    req.on('error', reject);
  });
}

// ── The window to preserve ───────────────────────────────────────────────────
/**
 * The incident, widened by a margin either side. People do not report the time
 * of an incident to the minute; a request that says "about half two" and
 * exports 14:30:00–14:30:01 is useless. 10 minutes of padding costs nothing and
 * is the difference between a clip that answers the question and one that does
 * not.
 */
const PAD_MINUTES = 10;
function windowFor(reqRow) {
  const day = (reqRow.incident_date instanceof Date)
    ? reqRow.incident_date
    : new Date(String(reqRow.incident_date) + 'T00:00:00');
  const y = day.getFullYear(), mo = day.getMonth(), d = day.getDate();
  const hm = (t, fallbackH, fallbackM) => {
    if (!t) return [fallbackH, fallbackM];
    const [h, m] = String(t).split(':').map(n => parseInt(n, 10));
    return [Number.isFinite(h) ? h : fallbackH, Number.isFinite(m) ? m : fallbackM];
  };
  const [fh, fm] = hm(reqRow.incident_time_from, 8, 0);
  const [th, tm] = hm(reqRow.incident_time_to || reqRow.incident_time_from, 18, 0);
  const from = new Date(y, mo, d, fh, fm, 0);
  const to   = new Date(y, mo, d, th, tm, 0);
  if (to <= from) to.setTime(from.getTime() + 60_000);
  return {
    from: new Date(from.getTime() - PAD_MINUTES * 60_000),
    to:   new Date(to.getTime()   + PAD_MINUTES * 60_000),
  };
}

// ── The attempt ──────────────────────────────────────────────────────────────
/**
 * Ask the recorder to export the requested window and keep the file.
 *
 * NEVER THROWS. It returns a state, because "the recorder did not answer" is a
 * result the manager has to see on the screen, not a 500 that vanishes into a
 * log. The caller writes the returned state onto the request row.
 *
 * @returns {Promise<{status:string, error:string|null, clip_path:string|null,
 *                    clip_bytes:number|null, verified_at:Date|null, detail:object}>}
 */
async function preserve(db, reqRow, opts = {}) {
  const fail = (st, msg, detail = {}) => ({
    status: st, error: msg, clip_path: null, clip_bytes: null, verified_at: null,
    detail: { ...detail, attempted_at: new Date().toISOString() },
  });

  const st = await status(db);
  if (!st.available) return fail(st.enabled ? S.FAILED : S.DISABLED, st.reason, { gate: 'settings' });

  // The window may already be gone. Say that rather than asking for footage
  // that has been overwritten — a 404 from the recorder reads as a fault, and
  // this is not a fault, it is the retention policy working.
  const expires = new Date(reqRow.footage_expires_at);
  if (Number.isFinite(expires.getTime()) && expires.getTime() < Date.now()) {
    return fail(S.EXPIRED,
      `The footage was overwritten on ${expires.toLocaleString('en-GB')} — ${reqRow.retention_days} days after the incident. `
      + 'It cannot be recovered.', { expired_at: expires.toISOString() });
  }

  // Which camera? Explicit choice wins; otherwise every enabled camera is tried,
  // because the requester describes a place, not a device.
  const { rows: cams } = opts.cameraId
    ? await db.query('SELECT id, key, name, enabled FROM cameras WHERE id=$1', [opts.cameraId])
    : await db.query('SELECT id, key, name, enabled FROM cameras WHERE enabled = true ORDER BY id');

  if (!cams.length) {
    return fail(S.UNAVAILABLE,
      'No camera is switched on, so there is no recording to preserve. The cameras are installed but not yet '
      + 'in service — see the CCTV Policy §2. Nothing has been lost that existed.', { cameras_enabled: 0 });
  }
  const disabled = cams.filter(c => !c.enabled);
  if (disabled.length === cams.length) {
    return fail(S.UNAVAILABLE,
      `Camera "${cams[0].name}" is registered but not switched on, so it has recorded nothing.`,
      { camera_id: cams[0].id });
  }

  const win = windowFor(reqRow);
  const startTs = Math.floor(win.from.getTime() / 1000);
  const endTs   = Math.floor(win.to.getTime() / 1000);
  const errors  = [];

  for (const cam of cams.filter(c => c.enabled)) {
    try {
      // Frigate's export API. ⚠️ UNVERIFIED AGAINST A LIVE RECORDER — there is
      // no Frigate on this host to test against. The shape is Frigate 0.13+:
      //   POST /api/export/<camera>/start/<epoch>/end/<epoch>
      //   → { export_id | id | ... }, then the file appears under /api/exports.
      // If your Frigate differs, THIS is the call to change, and a mismatch
      // surfaces as a loud 'failed' with the recorder's own body attached — it
      // will never be mistaken for a successful preserve.
      const startUrl = `${st.frigateUrl}/api/export/${encodeURIComponent(cam.key)}/start/${startTs}/end/${endTs}`;
      const res = await request(startUrl, {
        method: 'POST',
        body: JSON.stringify({ playback: 'realtime', name: `wren-cctv-request-${reqRow.id}-${cam.key}` }),
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        errors.push(`${cam.name}: recorder replied HTTP ${res.statusCode} — ${res.body.slice(0, 300)}`);
        continue;
      }
      let payload = {};
      try { payload = JSON.parse(res.body); } catch { /* some builds return text */ }
      const exportId = payload.export_id || payload.id || (payload.export && payload.export.id) || null;

      const file = await waitForExport(st.frigateUrl, exportId, cam.key);
      if (!file) {
        errors.push(`${cam.name}: the export was accepted but no finished file appeared within ${POLL_MAX_MS / 1000}s.`);
        continue;
      }

      fs.mkdirSync(CLIP_DIR, { recursive: true });
      const dest = path.join(CLIP_DIR, `request-${reqRow.id}-${cam.key}-${startTs}.mp4`);
      await download(`${st.frigateUrl}/exports/${encodeURIComponent(file)}`, dest);

      // (c) — the only thing that licenses 'preserved'.
      const stat = fs.statSync(dest);
      if (!stat.size) {
        try { fs.unlinkSync(dest); } catch { /* nothing to clean up */ }
        errors.push(`${cam.name}: the recorder produced an empty file.`);
        continue;
      }
      return {
        status: S.PRESERVED, error: null, clip_path: dest, clip_bytes: stat.size,
        verified_at: new Date(),
        detail: { camera_id: cam.id, camera: cam.key, export_id: exportId,
                  window_from: win.from.toISOString(), window_to: win.to.toISOString() },
      };
    } catch (e) {
      errors.push(`${cam.name}: ${e.message}`);
    }
  }

  // Everything failed. Which KIND of failure matters: nobody answering is a
  // different problem from the recorder refusing, and the manager needs to know
  // which one so they know whether to chase the box or the request.
  const noAnswer = errors.every(m => /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|no answer from the recorder/i.test(m));
  return fail(noAnswer ? S.UNAVAILABLE : S.FAILED,
    (noAnswer ? 'The recorder did not answer. ' : 'The recorder refused the export. ') + errors.join(' | '),
    { errors });
}

/** Poll /api/exports until the export for this camera is finished. */
async function waitForExport(base, exportId, cameraKey) {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let list;
    try {
      const res = await request(`${base}/api/exports`, { timeout: EXPORT_TIMEOUT_MS });
      if (res.statusCode !== 200) continue;
      list = JSON.parse(res.body);
    } catch { continue; }
    const rows = Array.isArray(list) ? list : (list && list.exports) || [];
    const hit = rows.find(r =>
      (exportId && (r.id === exportId || r.export_id === exportId)) ||
      (!exportId && r.camera === cameraKey));
    if (!hit) continue;
    if (hit.in_progress === true || hit.status === 'in_progress') continue;
    const file = hit.video_path ? path.basename(hit.video_path) : (hit.file || hit.name || null);
    if (file) return file;
  }
  return null;
}

module.exports = { STATES: S, status, preserve, windowFor, CLIP_DIR };
