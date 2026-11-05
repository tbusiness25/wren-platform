// @ts-check  (b508, 2026-10-18) — this file is type-checked. jsconfig.json has
// checkJs:false, so only files carrying this comment are checked; see jsconfig.json
// for how to run it. Keep it passing, or take the comment off deliberately.
// NOTE: this comment must stay the FIRST thing in the file — above 'use strict' —
// or TypeScript ignores it and the file is silently not checked.
'use strict';
/**
 * b508 (2026-10-18) — per-request CSP nonces for inline <script> blocks.
 *
 * WHY
 * The LADN CSP has always been `script-src 'self' 'unsafe-inline'`. `'unsafe-inline'`
 * is the one directive that makes the rest of the policy close to decorative for
 * script injection: anything that gets reflected into a page can run. The fix is a
 * per-request nonce — the server mints a random value, puts it on every <script> tag
 * it serves, and names it in the header — so an injected <script> the server did not
 * write has no nonce and does not execute.
 *
 * `script-src-attr 'none'` was ALREADY set before this build, so inline on*= handler
 * attributes were already blocked everywhere. That is not what this middleware is
 * about; see b508's NOTES for the three parents pages whose handlers were therefore
 * dead code, and which this build moved onto listeners.
 *
 * HOW
 * It buffers text/html responses (only those), injects nonce="…" into every <script>
 * tag that has not already got one, and rewrites the Content-Security-Policy header
 * helmet set upstream.
 *
 * THE IMPORTANT SUBTLETY — read before adding a portal to `strictPortals`:
 * a browser that sees ANY nonce in script-src IGNORES 'unsafe-inline' in that same
 * directive. So emitting a nonce on a portal whose pages are not fully covered breaks
 * every inline script on it instantly. That is why this is staged:
 *
 *   strict portal      script-src 'self' 'nonce-…'                 ('unsafe-inline' DROPPED)
 *   non-strict portal  script-src 'self' 'unsafe-inline'  UNCHANGED header; the nonce
 *                      attribute is still injected into the HTML, where it sits inert.
 *
 * The inert attribute is the point: turning a portal strict later is a one-word change
 * to the `strictPortals` set, with the plumbing already proven in production traffic.
 *
 * WHAT THIS CANNOT COVER, and so what has to be checked per portal before flipping it:
 *   - a <script> written by document.write() after load (it gets no nonce)
 *   - a <script> element built in JS and appended (set .nonce on it, or move the code
 *     into a file). innerHTML-inserted <script> never executed anyway, nonce or not.
 *   - an inline <script> in HTML that this middleware does not see, i.e. HTML produced
 *     by something other than an ordinary response body.
 * The b508 headless-Chrome probe (harness b508-csp-probe.js) is what proves a portal is
 * clear: it walks every page of the portal and counts real securitypolicyviolation events.
 */
const crypto = require('crypto');

const MAX_HTML_BYTES = 4 * 1024 * 1024;   // above this, pass through untouched rather than buffer

/**
 * res.write(chunk, encoding, cb) may be called with the encoding slot holding a
 * callback, or nothing at all. Narrow it to something Buffer.from will accept.
 * (b508: `// @ts-check` flagged `typeof encoding === 'string' ? encoding : 'utf8'`
 * — a typeof guard does not narrow `string` to `BufferEncoding`, so the Buffer.from
 * overload did not match. Same runtime behaviour, including the utf8 default.)
 * @param {any} e
 * @returns {BufferEncoding}
 */
function encOf(e) {
  return (typeof e === 'string' ? /** @type {BufferEncoding} */ (e) : 'utf8');
}

/** <script …> opening tags, but never the closing tag and never a comment. */
const SCRIPT_OPEN = /<script\b([^>]*)>/gi;

/**
 * Inject nonce="<nonce>" into every <script> opening tag that has not got one.
 * Tags that already carry a nonce (or that are inside a <!-- --> comment we cannot
 * cheaply detect) are left alone — injecting twice would produce invalid HTML.
 */
function injectNonce(html, nonce) {
  let added = 0;
  const out = html.replace(SCRIPT_OPEN, (full, attrs) => {
    if (/\bnonce\s*=/i.test(attrs)) return full;
    added++;
    return '<script nonce="' + nonce + '"' + attrs + '>';
  });
  return { html: out, added };
}

/**
 * Rewrite one CSP header string so script-src carries the nonce and no longer
 * carries 'unsafe-inline'. Every other directive is passed through untouched —
 * style-src in particular keeps 'unsafe-inline', which is a separate job.
 */
function withNonce(csp, nonce) {
  if (!csp) return `default-src 'self'; script-src 'self' 'nonce-${nonce}'`;
  const parts = String(csp).split(';').map(s => s.trim()).filter(Boolean);
  let seen = false;
  const rewritten = parts.map(d => {
    const name = d.split(/\s+/)[0].toLowerCase();
    if (name !== 'script-src') return d;
    seen = true;
    const tokens = d.split(/\s+/).slice(1).filter(t => t.toLowerCase() !== "'unsafe-inline'");
    return `script-src ${tokens.join(' ')} 'nonce-${nonce}'`.replace(/\s+/g, ' ');
  });
  if (!seen) rewritten.push(`script-src 'self' 'nonce-${nonce}'`);
  return rewritten.join(';');
}

/**
 * @param {object}   [opts]
 * @param {string[]} [opts.strictPortals]  portals whose script-src drops 'unsafe-inline'
 *                                         and names the nonce instead. Everything else gets
 *                                         the attribute injected but its header untouched.
 * @param {(req:any)=>string} [opts.portalOf] how to read the portal off the request
 */
function cspNonce(opts = {}) {
  const strict = new Set(opts.strictPortals || []);
  const portalOf = opts.portalOf || (req => req._portal || 'learning');

  return function cspNonceMiddleware(req, res, next) {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals = res.locals || {};
    res.locals.cspNonce = nonce;

    // Nothing with a body to rewrite.
    if (req.method !== 'GET' && req.method !== 'POST') return next();

    const isStrict = strict.has(portalOf(req));
    const origWriteHead = res.writeHead;
    const origWrite = res.write;
    const origEnd = res.end;

    let chunks = null;          // non-null once we have decided to buffer
    let bytes = 0;
    let bail = false;           // too big / not html after all → stream the rest through
    let headArgs = null;        // an explicit writeHead we deferred
    let flushing = false;       // see restore() — must be false-ing before the final write

    // Put the real write/writeHead/end back on the response before we do the final write.
    // This is load-bearing: origEnd() reaches ServerResponse#_implicitHeader(), which calls
    // `this.writeHead(...)` — our own wrapper — and that wrapper would defer it again, so the
    // body would go out with no status line at all. curl reports that as
    // "Received HTTP/0.9 when not allowed" and nothing works. Restoring first makes the
    // implicit header path the plain Node one.
    const restore = () => {
      flushing = true;
      res.writeHead = origWriteHead;
      res.write = origWrite;
      res.end = origEnd;
    };

    const isHtml = () => {
      const ct = res.getHeader('Content-Type');
      return !!ct && String(ct).toLowerCase().includes('text/html');
    };
    // 204/304 and HEAD carry no body; a redirect's tiny HTML body is not worth rewriting.
    const bodyWorthRewriting = () => {
      const s = res.statusCode;
      return req.method !== 'HEAD' && s !== 204 && s !== 304 && !(s >= 300 && s < 400);
    };

    const shouldBuffer = () => !bail && !flushing && isHtml() && bodyWorthRewriting();

    res.writeHead = function (...args) {
      // Defer the real writeHead while we might still rewrite the body, because the
      // Content-Length it carries is about to be wrong. Headers set with setHeader
      // (helmet's CSP, the no-cache sweep) are unaffected either way.
      if (shouldBuffer()) {
        // Merge any headers passed positionally so getHeader() sees them below.
        const maybeHeaders = args[2] || (typeof args[1] === 'object' ? args[1] : null);
        if (maybeHeaders && !Array.isArray(maybeHeaders)) {
          for (const [k, v] of Object.entries(maybeHeaders)) {
            if (k.toLowerCase() !== 'content-length') { try { res.setHeader(k, v); } catch (_) {} }
          }
        }
        if (typeof args[0] === 'number') res.statusCode = args[0];
        headArgs = [res.statusCode];
        return res;
      }
      return origWriteHead.apply(res, args);
    };

    res.write = function (chunk, encoding, cb) {
      if (!shouldBuffer()) {
        restore();
        if (headArgs) { origWriteHead.apply(res, headArgs); headArgs = null; }
        if (chunks) { for (const c of chunks) origWrite.call(res, c); chunks = null; }
        return origWrite.call(res, chunk, encoding, cb);
      }
      if (chunk) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encOf(encoding));
        bytes += buf.length;
        if (bytes > MAX_HTML_BYTES) {
          // Give up on rewriting rather than hold an unbounded buffer: flush what we have.
          bail = true;
          restore();
          if (headArgs) { origWriteHead.apply(res, headArgs); headArgs = null; }
          for (const c of (chunks || [])) origWrite.call(res, c);
          chunks = null;
          return origWrite.call(res, buf, undefined, cb);
        }
        (chunks = chunks || []).push(buf);
      }
      if (typeof cb === 'function') cb();
      if (typeof encoding === 'function') encoding();
      return true;
    };

    res.end = function (chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }

      if (!shouldBuffer() && !chunks) {
        restore();
        if (headArgs) { origWriteHead.apply(res, headArgs); headArgs = null; }
        return origEnd.call(res, chunk, encoding, cb);
      }
      if (chunk) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encOf(encoding));
        bytes += buf.length;
        (chunks = chunks || []).push(buf);
      }
      const body = Buffer.concat(chunks || []);
      const wasStrict = isStrict;          // read before restore() flips `flushing`
      restore();

      if (bail || bytes > MAX_HTML_BYTES) {
        if (headArgs) { origWriteHead.apply(res, headArgs); headArgs = null; }
        return origEnd.call(res, body, undefined, cb);
      }

      let outBody = body;
      try {
        const { html, added } = injectNonce(body.toString('utf8'), nonce);
        outBody = Buffer.from(html, 'utf8');
        res.setHeader('X-Wren-CSP-Nonce-Tags', String(added));   // observability; no secret in it
      } catch (_) { outBody = body; }

      if (wasStrict) {
        try {
          const current = res.getHeader('Content-Security-Policy');
          res.setHeader('Content-Security-Policy', withNonce(current, nonce));
        } catch (_) { /* header already sent — nothing safe to do */ }
      }

      try {
        res.setHeader('Content-Length', String(outBody.length));
        res.removeHeader('ETag');          // the body changed per request; a validator would lie
      } catch (_) {}
      if (headArgs) { origWriteHead.apply(res, headArgs); headArgs = null; }
      return origEnd.call(res, outBody, undefined, cb);
    };

    next();
  };
}

module.exports = { cspNonce, injectNonce, withNonce };
