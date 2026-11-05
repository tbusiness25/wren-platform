'use strict';
/**
 * wren-loopback.js — b527 (2026-10-26)
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * "Ask Wren" answers questions about children, families and the day. The one
 * rule it must never break is that it can only see what the person asking can
 * already see. There are two ways to build that, and only one of them is true
 * a year from now:
 *
 *   (a) query the tables and re-implement the gates in the assistant;
 *   (b) call Wren's own HTTP API, on the person's behalf, with their own token.
 *
 * (a) is a second copy of the permission model. It passes its tests on the day
 * it ships and then drifts: b491's HR allow-list, the EY device gate, the
 * off-site matrix, the four permission tiers, the per-staff capability matrix
 * and PARENT_DENY are six separate gates living in three files, and every one
 * of them has been changed this month. A copy would have to be changed six
 * times too, by somebody who remembered the assistant existed.
 *
 * So this is (b). The assistant has NO SQL against children, parents or staff.
 * It makes a real HTTP request to this process's own listening port, carrying
 * the caller's own Authorization header, device token, cookies and client IP,
 * and reads the answer. Every middleware in editions/ladn/server-unified.js
 * runs: portal dispatch, the parent/HR/Roost gates, the off-site matrix, the
 * device gate, authenticate(), the capability middleware in the route file, and
 * the per-row ownership checks inside the handler. A 403 is a 403.
 *
 * ── THE FOUR HEADERS THAT MATTER, AND WHY ────────────────────────────────────
 *  host               portal dispatch is hostname-based (admin./hr./parents./
 *                     else learning). Sent verbatim so the loopback lands on
 *                     the SAME portal the caller is on — an HR question is
 *                     answered under HR_ALLOW, an EY one under the device gate.
 *
 *  authorization      the caller's own JWT. Not a service token, not a minted
 *                     one: the same bytes they sent us. Its `aud`, `role`,
 *                     `scope`, `vas` and id are therefore unchanged.
 *
 *  x-wren-device      the tablet's enrolment token. Without it an EY request
 *                     for child data is 403 device_required, which is exactly
 *                     what should happen if the assistant is reached from an
 *                     unenrolled device (see memory reference_device_gate_
 *                     headerless_requests — a header-less request is refused).
 *
 *  x-forwarded-for    THE ONE THAT IS EASY TO GET WRONG. _offsiteGate() in
 *                     server-unified.js reads cf-connecting-ip, then XFF[0],
 *                     then req.ip, and 127.0.0.1 counts as ON-SITE. A naive
 *                     loopback is therefore always "at the nursery", and a
 *                     practitioner sitting at home would get child data through
 *                     the assistant that the app refuses them. So the caller's
 *                     resolved client IP is pinned here, computed with the same
 *                     precedence the gate itself uses. scripts/b527-evals.js
 *                     asserts the off-site refusal with a public IP.
 *
 * Nothing else is forwarded. In particular no x-wren-internal (the machine
 * bypass), no x-medicine-token and no x-task-secret: if the caller sent one it
 * is dropped, because the assistant must never be a way to replay a privileged
 * header the person happened to be holding.
 *
 * ── LOOP GUARD ───────────────────────────────────────────────────────────────
 * A tool can only reach an endpoint, never the assistant: x-wren-loopback is
 * stamped on every request made here, and src/routes/ask-wren.js refuses any
 * request carrying it. One hop, no recursion, no fork bomb from one question.
 */

const http = require('http');

const DEFAULT_TIMEOUT_MS = 12000;
/** Hard cap per response. A tool result is a paragraph of grounding, not a file. */
const MAX_BYTES = 512 * 1024;
const LOOP_HEADER = 'x-wren-loopback';

/**
 * Headers copied from the caller's request, verbatim. Deliberately a short
 * allow-list rather than "everything except…": a new privileged header added to
 * Wren next month is then NOT forwarded by default.
 */
const FORWARD = [
  'host',
  'x-forwarded-host',
  'x-forwarded-proto',
  'authorization',
  'x-wren-token',
  'x-wren-device',
  'cookie',
  'cf-connecting-ip',
  'cf-access-jwt-assertion',
  'user-agent',
  'accept-language',
];

/**
 * The caller's client IP, resolved exactly the way _offsiteGate()'s _clientIp()
 * in editions/ladn/server-unified.js resolves it. Kept byte-compatible with it
 * on purpose — if that precedence changes, this must change with it, and the
 * eval that asserts the off-site refusal is what will notice.
 * @param {import('express').Request} req
 * @returns {string}
 */
function callerIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf.replace('::ffff:', '');
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xff || req.ip || '').replace('::ffff:', '');
}

/** Was THIS request itself made by the loopback? Used by the route to refuse recursion. */
function isLoopback(req) {
  return !!(req && req.headers && req.headers[LOOP_HEADER]);
}

function buildQuery(query) {
  if (!query) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/**
 * One request to this server, as the caller.
 *
 * @param {import('express').Request} req   the ORIGINAL request (identity + port source)
 * @param {object} opts
 * @param {'GET'|'POST'} [opts.method]
 * @param {string} opts.path                an /api/... path. Must start with /api/.
 * @param {object} [opts.query]
 * @param {object} [opts.body]              JSON body for POST
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{status:number, json:any, text:string, ms:number, truncated:boolean}>}
 *          Never throws for an HTTP error — a 403 comes back as status 403 so the
 *          caller can say "you do not have access to that". Only a transport
 *          failure rejects.
 */
function callAsUser(req, opts) {
  const method = (opts.method || 'GET').toUpperCase();
  const path = String(opts.path || '');
  if (!path.startsWith('/api/')) {
    return Promise.reject(new Error(`wren-loopback: refusing a non-/api path (${path})`));
  }
  if (method !== 'GET' && method !== 'POST') {
    return Promise.reject(new Error(`wren-loopback: refusing method ${method}`));
  }
  // The port this very request arrived on. Reading it from the socket rather
  // than process.env.PORT means a harness or a second listener cannot send the
  // loopback somewhere else.
  const port = (req.socket && req.socket.localPort) || Number(process.env.PORT) || 3000;

  const headers = { accept: 'application/json', [LOOP_HEADER]: '1' };
  for (const h of FORWARD) {
    const v = req.headers[h];
    if (v !== undefined && v !== null && v !== '') headers[h] = Array.isArray(v) ? v[0] : v;
  }
  // See the header note at the top of this file: this is the line that keeps the
  // off-site gate honest.
  const ip = callerIp(req);
  if (ip) headers['x-forwarded-for'] = ip;

  let payload = null;
  if (method === 'POST') {
    payload = Buffer.from(JSON.stringify(opts.body || {}), 'utf8');
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }

  const started = Date.now();
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: path + buildQuery(opts.query),
      headers,
      // A redirect is never a tool result. Nothing under /api/ should 3xx, and
      // following one would be a second request with these headers on it.
      timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      let bytes = 0, truncated = false;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX_BYTES) { truncated = true; res.destroy(); return; }
        chunks.push(c);
      });
      const done = () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON — text stands */ }
        resolve({ status: res.statusCode || 0, json, text, ms: Date.now() - started, truncated });
      };
      res.on('end', done);
      res.on('close', () => { if (truncated) done(); });
    });
    r.on('timeout', () => { r.destroy(new Error('wren-loopback: timed out')); });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

module.exports = { callAsUser, callerIp, isLoopback, LOOP_HEADER, FORWARD, MAX_BYTES };
