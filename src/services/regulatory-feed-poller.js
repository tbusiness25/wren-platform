'use strict';
// Regulatory feed poller — runs hourly at :15, polls due sources.
// Handlers: atom (fast-xml-parser), html_scrape (hash-based), pdf_landing (pdf-parse).
// Rate limits: max 1 req/source/min, max 10 req/min across all sources.
// Respects robots.txt — disallowed → is_active=false.

const https        = require('https');
const http         = require('http');
const crypto       = require('crypto');
const { getPool }  = require('../db/pool');

const USER_AGENT = 'Wren-Regulatory-Watcher/1.0 (operator: admin@example.com)';
const MAX_REQ_PER_MIN = 10;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet(url, opts = {}) {
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ status: 0, body: '', error: 'bad url' }); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': opts.acceptXml ? 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*' : 'text/html, */*',
      ...(opts.headers || {}),
    };

    let body = Buffer.alloc(0);
    const maxBytes = opts.maxBytes || 512 * 1024; // 512 KB default

    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    const req = lib.request(
      { hostname: parsed.hostname, path: parsed.pathname + (parsed.search || ''),
        method: 'GET', headers },
      res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return httpGet(res.headers.location, opts).then(finish);
        }
        const status = res.statusCode;
        const respHeaders = res.headers;
        res.on('data', chunk => {
          body = Buffer.concat([body, chunk]);
          if (body.length > maxBytes) {
            res.resume(); // drain remainder, close cleanly
            finish({ status, body: body.toString('utf8'), headers: respHeaders });
          }
        });
        res.on('end', () => finish({ status, body: body.toString('utf8'), headers: respHeaders }));
        res.on('error', () => finish({ status, body: body.toString('utf8'), headers: respHeaders }));
      }
    );
    req.setTimeout(opts.timeout || 15000, () => { req.destroy(); finish({ status: 0, body: '', error: 'timeout' }); });
    req.on('error', e => finish({ status: 0, body: '', error: e.message }));
    req.end();
  });
}

function sha256(str) {
  return crypto.createHash('sha256').update(str || '').digest('hex');
}

// ── Robots.txt checker ────────────────────────────────────────────────────────

const robotsCache = new Map(); // hostname → {allowed: Set, disallowed: Set, fetchedAt}

async function isAllowedByRobots(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return true; }

  const now = Date.now();
  const cached = robotsCache.get(parsed.hostname);
  if (cached && (now - cached.fetchedAt) < 3600000) {
    return !isDisallowed(parsed.pathname, cached.disallowed);
  }

  const robotsUrl = `${parsed.protocol}//${parsed.hostname}/robots.txt`;
  const res = await httpGet(robotsUrl, { timeout: 5000 });
  const disallowed = new Set();

  if (res.status === 200) {
    let inOurAgent = false;
    for (const line of res.body.split('\n')) {
      const l = line.trim().toLowerCase();
      if (l.startsWith('user-agent:')) {
        const agent = l.replace('user-agent:', '').trim();
        inOurAgent = agent === '*' || agent.includes('wren');
      }
      if (inOurAgent && l.startsWith('disallow:')) {
        const path = l.replace('disallow:', '').trim();
        if (path) disallowed.add(path);
      }
    }
  }

  robotsCache.set(parsed.hostname, { disallowed, fetchedAt: now });
  return !isDisallowed(parsed.pathname, disallowed);
}

function isDisallowed(pathname, disallowed) {
  for (const d of disallowed) {
    if (d && pathname.startsWith(d)) return true;
  }
  return false;
}

// ── HTML content extractor (no cheerio dep) ───────────────────────────────────

function extractTextContent(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Rate limiter ──────────────────────────────────────────────────────────────

const reqTimestamps = [];

async function rateLimitedGet(url, opts = {}) {
  const now = Date.now();
  // Purge timestamps older than 60s
  while (reqTimestamps.length && reqTimestamps[0] < now - 60000) reqTimestamps.shift();

  if (reqTimestamps.length >= MAX_REQ_PER_MIN) {
    const wait = 60000 - (now - reqTimestamps[0]) + 100;
    await new Promise(r => setTimeout(r, wait));
  }
  reqTimestamps.push(Date.now());
  return httpGet(url, opts);
}

// ── Atom/RSS handler ──────────────────────────────────────────────────────────

async function handleAtom(db, source) {
  const { XMLParser } = require('fast-xml-parser');
  const feedUrl = source.feed_url || source.url;

  const res = await rateLimitedGet(feedUrl, { acceptXml: true, timeout: 15000 });
  if (res.status === 429) {
    await db.query(`UPDATE regulatory_sources SET poll_interval_hours = poll_interval_hours * 2, last_error=$1, last_polled_at=now() WHERE id=$2`,
      [`Rate limited (429) — poll interval doubled`, source.id]);
    return;
  }
  if (!res.body || res.status !== 200) {
    throw new Error(`Feed returned HTTP ${res.status}`);
  }

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  let parsed;
  try { parsed = parser.parse(res.body); }
  catch (e) { throw new Error(`XML parse error: ${e.message}`); }

  // Normalise Atom vs RSS
  const feed  = parsed.feed || parsed.rss?.channel || {};
  const rawEntries = feed.entry || feed.item || [];
  const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];

  let newCount = 0;
  for (const entry of entries.slice(0, 20)) { // cap at 20 per poll
    const title   = (entry.title?.['#text'] || entry.title || '').toString().trim();
    const link    = entry.link?.['@_href'] || entry.link?.href || (typeof entry.link === 'string' ? entry.link : '') || entry.url || '';
    const pubDate = entry.updated || entry.published || entry.pubDate || '';
    const summary = (entry.summary?.['#text'] || entry.summary || entry.description || '').toString().slice(0, 2000);

    if (!title) continue;
    const entryHash = sha256(`${title}|${pubDate}|${link}`);

    // Skip if this exact entry already recorded for this source
    const { rows: exist } = await db.query(
      `SELECT id FROM regulatory_alerts WHERE source_id=$1 AND raw_content LIKE $2 LIMIT 1`,
      [source.id, `%${entryHash}%`]
    );
    if (exist.length) continue;

    await db.query(`
      INSERT INTO regulatory_alerts (source_id, alert_type, title, summary, url, raw_content)
      VALUES ($1, 'new_publication', $2, $3, $4, $5)
    `, [source.id, title, summary || null, link || null, JSON.stringify({ entryHash, pubDate, summary })]);
    newCount++;
  }

  // Update last_seen_hash to fingerprint of feed content
  const feedHash = sha256(res.body.slice(0, 8192));
  await db.query(
    `UPDATE regulatory_sources SET last_seen_hash=$1, last_polled_at=now(), last_error=null WHERE id=$2`,
    [feedHash, source.id]
  );
  if (newCount > 0) console.log(`  [atom] ${source.source_key}: ${newCount} new alert(s)`);
}

// ── HTML scrape handler ───────────────────────────────────────────────────────

async function handleHtmlScrape(db, source) {
  const allowed = await isAllowedByRobots(source.url);
  if (!allowed) {
    await db.query(
      `UPDATE regulatory_sources SET is_active=false, last_error=$1, last_polled_at=now() WHERE id=$2`,
      ['Disabled by robots.txt', source.id]
    );
    console.log(`  [html] ${source.source_key}: DISABLED (robots.txt)`);
    return;
  }

  const res = await rateLimitedGet(source.url, { timeout: 15000 });
  if (res.status === 429) {
    await db.query(`UPDATE regulatory_sources SET poll_interval_hours = poll_interval_hours * 2, last_error=$1, last_polled_at=now() WHERE id=$2`,
      [`Rate limited (429) — poll interval doubled`, source.id]);
    return;
  }
  if (!res.body || res.status !== 200) {
    throw new Error(`Page returned HTTP ${res.status}`);
  }

  const text     = extractTextContent(res.body);
  const newHash  = sha256(text.slice(0, 32768));
  const prevHash = source.last_seen_hash;

  if (prevHash && prevHash === newHash) {
    await db.query(`UPDATE regulatory_sources SET last_polled_at=now(), last_error=null WHERE id=$1`, [source.id]);
    return; // no change
  }

  // Extract a meaningful title from the page
  const titleMatch = res.body.match(/<title[^>]*>([^<]+)<\/title>/i);
  const pageTitle  = titleMatch ? titleMatch[1].trim() : source.name;

  if (prevHash) {
    // Page changed → create alert
    await db.query(`
      INSERT INTO regulatory_alerts (source_id, alert_type, title, url, raw_content)
      VALUES ($1, 'page_modified', $2, $3, $4)
    `, [source.id, `${source.name}: page content updated`, source.url, text.slice(0, 8000)]);
    console.log(`  [html] ${source.source_key}: content changed → alert created`);
  } else {
    console.log(`  [html] ${source.source_key}: first seen — hash stored, no alert`);
  }

  await db.query(
    `UPDATE regulatory_sources SET last_seen_hash=$1, last_polled_at=now(), last_error=null WHERE id=$2`,
    [newHash, source.id]
  );
}

// ── PDF landing handler ───────────────────────────────────────────────────────

async function handlePdfLanding(db, source) {
  const res = await rateLimitedGet(source.url, { timeout: 15000 });
  if (!res.body || res.status !== 200) throw new Error(`Landing page HTTP ${res.status}`);

  // Find PDF links
  const pdfPattern = /href="([^"]*\.pdf[^"]*)"/gi;
  const pdfLinks = [];
  let m;
  while ((m = pdfPattern.exec(res.body)) !== null) {
    const href = m[1];
    pdfLinks.push(href.startsWith('http') ? href : new URL(href, source.url).href);
  }

  if (!pdfLinks.length) {
    // No PDF found — fall back to hash-based scrape of the landing page
    return handleHtmlScrape(db, source);
  }

  // Use first PDF link for version detection — hash the link itself + page snippet
  const landingHash = sha256(pdfLinks[0] + res.body.slice(0, 2000));
  if (source.last_seen_hash === landingHash) {
    await db.query(`UPDATE regulatory_sources SET last_polled_at=now(), last_error=null WHERE id=$1`, [source.id]);
    return;
  }

  // PDF changed — attempt to fetch and extract text
  let pdfText = '';
  try {
    const pdfRes = await rateLimitedGet(pdfLinks[0], { maxBytes: 5 * 1024 * 1024, timeout: 30000 });
    if (pdfRes.status === 200 && pdfRes.body.length > 100) {
      const pdfParse = require('pdf-parse');
      const buf = Buffer.from(pdfRes.body, 'binary');
      const data = await pdfParse(buf, { max: 5 });
      pdfText = data.text.slice(0, 8000);
    }
  } catch (e) {
    pdfText = `[PDF extraction failed: ${e.message}]`;
  }

  if (source.last_seen_hash) {
    const titleMatch = res.body.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : source.name;
    await db.query(`
      INSERT INTO regulatory_alerts (source_id, alert_type, title, url, raw_content)
      VALUES ($1, 'version_changed', $2, $3, $4)
    `, [source.id, `${source.name}: updated document detected`, pdfLinks[0], pdfText || extractTextContent(res.body).slice(0, 8000)]);
    console.log(`  [pdf] ${source.source_key}: version changed → alert created`);
  } else {
    console.log(`  [pdf] ${source.source_key}: first seen — hash stored`);
  }

  await db.query(
    `UPDATE regulatory_sources SET last_seen_hash=$1, last_polled_at=now(), last_error=null WHERE id=$2`,
    [landingHash, source.id]
  );
}

// ── Main poll runner ──────────────────────────────────────────────────────────

async function runDueSources(schemaOverride) {
  const db    = getPool();
  const schema = schemaOverride || process.env.PG_SCHEMA || 'ladn';

  const { rows: sources } = await db.query(`
    SELECT * FROM ${schema}.regulatory_sources
    WHERE is_active = true
      AND (last_polled_at IS NULL
           OR last_polled_at < now() - (poll_interval_hours || ' hours')::interval)
    ORDER BY importance, last_polled_at NULLS FIRST
  `);

  if (!sources.length) return;
  console.log(`[regulatory-poller] ${sources.length} source(s) due for polling (schema: ${schema})`);

  for (const source of sources) {
    try {
      if (source.feed_type === 'atom' || source.feed_type === 'rss') {
        await handleAtom(db, source);
      } else if (source.feed_type === 'html_scrape') {
        await handleHtmlScrape(db, source);
      } else if (source.feed_type === 'pdf_landing') {
        await handlePdfLanding(db, source);
      } else {
        console.warn(`  [skip] ${source.source_key}: unknown feed_type '${source.feed_type}'`);
      }
    } catch (err) {
      console.error(`  [error] ${source.source_key}: ${err.message}`);
      try {
        await db.query(
          `UPDATE ${schema}.regulatory_sources SET last_error=$1, last_polled_at=now() WHERE id=$2`,
          [err.message.slice(0, 500), source.id]
        );
      } catch (_) { /* ignore secondary error */ }
    }

    // Per-source minimum gap of 1s
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ── Cron scheduler (runs at :15 every hour) ───────────────────────────────────

let _cronTimer = null;

function startPoller() {
  if (_cronTimer) return;

  async function tick() {
    const now   = new Date();
    const min   = now.getMinutes();
    const sec   = now.getSeconds();
    const msToNext = ((15 - ((min - 15) % 60 + 60) % 60) % 60 * 60000) + (60 - sec) * 1000;
    // Align to :15 of each hour; first run within 10 seconds if we're near :15
    const delay = (min === 15 && sec < 10) ? 0 : msToNext;

    _cronTimer = setTimeout(async () => {
      try { await runDueSources(); } catch (e) { console.error('[regulatory-poller] cron error:', e); }
      tick(); // reschedule
    }, Math.max(delay, 1000));
  }

  tick();
  console.log('[regulatory-poller] started (hourly at :15)');
}

function stopPoller() {
  if (_cronTimer) { clearTimeout(_cronTimer); _cronTimer = null; }
}

module.exports = { startPoller, stopPoller, runDueSources };
