'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// frigate.js — b362 (2026-09-29) — Wren's client for the recorder.
//
// WHAT CHANGED ON 2026-09-28: recording became real. Frigate 0.14.1 now runs on
// the Z420 AT THE NURSERY (http://your-ollama-host:5000), recording the `door`
// camera to /srv/frigate. Before that there was no recorder at all — go2rtc
// restreams and stores nothing — so wren-docs and src/lib/cctv-preserve.js both
// still say "nothing is recording". For the door camera that is now out of date,
// and this module is the first thing in Wren that actually talks to the box.
//
// VERIFIED AGAINST THE LIVE RECORDER, 2026-09-29, from inside wren-ladn-dev:
//   GET  /api/version                                   → "0.14.1-f4f3cfa"
//   GET  /api/config                                    → 200 (retention read from here)
//   GET  /api/events?camera=&after=&before=&limit=       → 200, array
//   GET  /api/<cam>/recordings/summary                   → 200, day/hour rollup
//   GET  /api/<cam>/recordings?after=&before=            → 200, 10s segments
//   GET  /api/events/<id>/clip.mp4                       → 200 video/mp4
//   GET  /api/events/<id>/thumbnail.jpg                  → 200 image/jpeg
//   GET  /api/<cam>/start/<ts>/end/<ts>/clip.mp4         → 200 video/mp4
// Frigate's own auth is enabled in its config but the API answers unauthenticated
// on the LAN/Tailscale path, so no token is sent. That is the recorder's posture,
// not Wren's: nothing here is exposed to a browser — every byte is proxied through
// src/routes/cameras.js behind the manager + Roost-portal gate and the access log.
//
// ── WHERE THE ADDRESS COMES FROM ─────────────────────────────────────────────
// In precedence order, most specific first:
//   1. settings.cctv_frigate_url        — a DB row, so it is PER DATABASE and
//                                         therefore settable on wren_dev alone
//   2. process.env.FRIGATE_API_URL      — what editions/ladn/.env declares
//   3. process.env.FRIGATE_URL          — what src/lib/cctv-preserve.js reads
//
// Layer 1 exists because editions/ladn/.env is loaded by BOTH wren-ladn (prod)
// and wren-ladn-dev, so there is no env-var edit that reaches dev without also
// arming prod on its next restart. A settings row on wren_dev is the only
// dev-only switch available. See the NOTES file for the exact prod change.
//
// ⚠️ THE .ENV IS STALE: FRIGATE_API_URL=http://172.31.0.1:5000 pointed at a
// docker-work Frigate that no longer exists, and 172.31.0.1:5000 times out from
// inside the container (measured). Before b362 no Wren route read that variable
// at all, so nothing was broken by it — this module is the first reader, which
// is exactly why the value has to be corrected rather than trusted.
// ─────────────────────────────────────────────────────────────────────────────

const http  = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 10_000;
const CLIP_TIMEOUT_MS    = 120_000;

// ── Address resolution ───────────────────────────────────────────────────────
let _cache = { at: 0, url: null };
const CACHE_MS = 30_000;   // a settings change is picked up within 30s

/**
 * The recorder's base URL, or null if none is configured.
 * Never throws — a missing recorder is a state the screen has to show, not an
 * exception that turns into a 500.
 */
async function baseUrl(db, { fresh = false } = {}) {
  if (!fresh && _cache.url !== null && Date.now() - _cache.at < CACHE_MS) return _cache.url;
  let fromDb = '';
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'cctv_frigate_url'`);
    fromDb = String((rows[0] && rows[0].value) || '').trim();
  } catch (e) {
    // The settings table not being readable is not a reason to lose the env
    // fallback — carry on to it rather than reporting "no recorder".
    console.warn('[frigate] settings read failed:', e.message);
  }
  const url = (fromDb
    || String(process.env.FRIGATE_API_URL || '').trim()
    || String(process.env.FRIGATE_URL || '').trim()
  ).replace(/\/+$/, '') || null;
  _cache = { at: Date.now(), url };
  return url;
}

/** Where the address came from, for the diagnostics line on the screen. */
async function addressSource(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'cctv_frigate_url'`);
    if (String((rows[0] && rows[0].value) || '').trim()) return 'settings.cctv_frigate_url';
  } catch { /* fall through to the env answer */ }
  if (String(process.env.FRIGATE_API_URL || '').trim()) return 'env FRIGATE_API_URL';
  if (String(process.env.FRIGATE_URL || '').trim())     return 'env FRIGATE_URL';
  return 'not configured';
}

// ── Minimal HTTP, matching cctv-preserve.js so this pulls in no dependency ───
function _req(urlStr, { method = 'GET', timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error(`bad recorder URL: ${e.message}`)); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, timeout }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`the recorder did not answer within ${timeout / 1000}s`)));
    req.on('error', reject);
    req.end();
  });
}

/** GET + JSON.parse. Throws with the recorder's own status attached. */
async function getJson(base, path, timeout = DEFAULT_TIMEOUT_MS) {
  const res = await _req(`${base}${path}`, { timeout });
  if (res.statusCode !== 200) {
    const e = new Error(`recorder replied HTTP ${res.statusCode} for ${path}`);
    e.statusCode = res.statusCode;
    throw e;
  }
  try { return JSON.parse(res.body); }
  catch (e) { throw new Error(`recorder returned unparseable JSON for ${path}: ${e.message}`); }
}

/**
 * Open a raw upstream GET and hand the caller the live response, for piping
 * video straight through without buffering a 7MB clip in this process.
 * Resolves with the http.IncomingMessage; the caller pipes and destroys it.
 */
function openStream(base, path, { timeout = CLIP_TIMEOUT_MS, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(`${base}${path}`); } catch (e) { return reject(new Error(`bad recorder URL: ${e.message}`)); }
    const lib = u.protocol === 'https:' ? https : http;
    // `headers` carries Range through, so a <video> element can seek inside a clip
    // instead of re-fetching the whole file on every scrub.
    const req = lib.get(u, { timeout, headers }, (res) => resolve({ res, req }));
    req.on('timeout', () => req.destroy(new Error(`the recorder stalled after ${timeout / 1000}s`)));
    req.on('error', reject);
  });
}

// ── Reachability ─────────────────────────────────────────────────────────────
/**
 * Is the recorder there? Returns a state, never throws — "the box is off" is
 * the single most important thing this screen can say truthfully.
 */
async function reachable(base) {
  if (!base) return { ok: false, error: 'No recorder address is configured.', version: null };
  try {
    const res = await _req(`${base}/api/version`, { timeout: 6_000 });
    if (res.statusCode !== 200) return { ok: false, error: `recorder replied HTTP ${res.statusCode}`, version: null };
    return { ok: true, error: null, version: res.body.trim().slice(0, 64) };
  } catch (e) {
    return { ok: false, error: e.message, version: null };
  }
}

// ── Retention, as the recorder actually reports it ───────────────────────────
/**
 * The retention Frigate is CONFIGURED with, per camera, in days.
 *
 * Frigate 0.14 keeps three clocks and they are set independently:
 *   record.retain.days            continuous recording ("mode: all" = everything)
 *   record.events.retain.default  the event recordings
 *   snapshots.retain.default      the still images
 * A policy limit is breached if ANY of them exceeds it, so `max_days` is what
 * the warning is computed from. Reported verbatim — this function never rounds
 * a number down to make the screen look compliant.
 */
async function retention(base, cameraKeys = null) {
  const cfg = await getJson(base, '/api/config');
  const cams = (cfg && cfg.cameras) || {};
  const out = [];
  for (const [key, c] of Object.entries(cams)) {
    if (cameraKeys && !cameraKeys.includes(key)) continue;
    const rec  = (c && c.record) || {};
    const snap = (c && c.snapshots) || {};
    const continuous = rec.enabled ? num(rec.retain && rec.retain.days) : null;
    const events     = rec.enabled ? num(rec.events && rec.events.retain && rec.events.retain.default) : null;
    const snapshots  = snap.enabled ? num(snap.retain && snap.retain.default) : null;
    const days = [continuous, events, snapshots].filter(n => n != null);
    out.push({
      camera: key,
      recording_enabled: !!rec.enabled,
      continuous_days: continuous,
      continuous_mode: (rec.retain && rec.retain.mode) || null,
      event_days: events,
      event_mode: (rec.events && rec.events.retain && rec.events.retain.mode) || null,
      snapshot_days: snapshots,
      max_days: days.length ? Math.max(...days) : null,
    });
  }
  return { version: cfg && cfg.version, cameras: out };
}
const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

// ── The reads the Recordings screen needs ────────────────────────────────────
/** Object events for one camera in a window. `after`/`before` are epoch seconds. */
function events(base, cameraKey, { after, before, limit = 200 } = {}) {
  const q = [`camera=${encodeURIComponent(cameraKey)}`, `limit=${Math.min(Math.max(1, limit), 500)}`];
  if (Number.isFinite(after))  q.push(`after=${Math.floor(after)}`);
  if (Number.isFinite(before)) q.push(`before=${Math.floor(before)}`);
  return getJson(base, `/api/events?${q.join('&')}`, 20_000);
}

/** Which days exist, and how much was recorded in each hour of them. */
function recordingsSummary(base, cameraKey) {
  return getJson(base, `/api/${encodeURIComponent(cameraKey)}/recordings/summary`, 20_000);
}

/** The 10-second segments inside a window — how "is there footage at 07:14" is answered. */
function recordingSegments(base, cameraKey, after, before) {
  return getJson(base,
    `/api/${encodeURIComponent(cameraKey)}/recordings?after=${Math.floor(after)}&before=${Math.floor(before)}`,
    20_000);
}

// ── Paths that carry video. Built here so the route never string-builds one ──
const eventClipPath   = id => `/api/events/${encodeURIComponent(id)}/clip.mp4`;
const eventThumbPath  = id => `/api/events/${encodeURIComponent(id)}/thumbnail.jpg`;
const windowClipPath  = (cameraKey, startTs, endTs) =>
  `/api/${encodeURIComponent(cameraKey)}/start/${Math.floor(startTs)}/end/${Math.floor(endTs)}/clip.mp4`;

/**
 * Strip a Frigate event down to what a listing may hold.
 *
 * `thumbnail` is dropped, deliberately and always. Frigate embeds a base64 JPEG
 * of the detection in every event row — which is FOOTAGE, and footage reaches a
 * screen only through an audited request under a CCTV Policy §3 trigger. Letting
 * it ride along on a list response would put a picture of whoever was at the
 * door into an unaudited payload and make the access log a partial record.
 * `box`, `region` and the raw score go too: they describe the same pixels and no
 * screen uses them.
 */
function publicEvent(e) {
  const start = num(e.start_time);
  const end   = num(e.end_time);
  return {
    id: e.id,
    camera: e.camera,
    label: e.label,
    sub_label: e.sub_label || null,
    start_time: start,
    end_time: end,
    duration_s: (start != null && end != null) ? Math.round((end - start) * 10) / 10 : null,
    score: e.data && num(e.data.top_score) != null ? Math.round(num(e.data.top_score) * 100) : null,
    has_clip: !!e.has_clip,
    has_snapshot: !!e.has_snapshot,
    retain_indefinitely: !!e.retain_indefinitely,
  };
}

module.exports = {
  baseUrl, addressSource, reachable, retention,
  events, recordingsSummary, recordingSegments,
  eventClipPath, eventThumbPath, windowClipPath,
  publicEvent, getJson, openStream,
  DEFAULT_TIMEOUT_MS, CLIP_TIMEOUT_MS,
};
