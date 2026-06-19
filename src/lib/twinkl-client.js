'use strict';
const crypto = require('crypto');
const https = require('https');

const ALGO = 'aes-256-gcm';
const TWINKL_API_BASE = 'https://api.twinkl.co.uk/v1';

// Key derived from JWT_SECRET so it's consistent across restarts and tied to server identity.
function _key() {
  const secret = process.env.JWT_SECRET;
  return crypto.createHash('sha256').update('twinkl:' + secret).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, _key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc_value: enc.toString('hex'), iv: iv.toString('hex'), tag: tag.toString('hex') };
}

function decrypt(enc_value, iv, tag) {
  const decipher = crypto.createDecipheriv(ALGO, _key(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(enc_value, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

function maskKey(value) {
  if (!value) return null;
  if (value.length <= 8) return '••••••••';
  return '••••' + value.slice(-4);
}

// Minimal https GET with timeout.
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(9000, () => { req.destroy(); reject(new Error('Twinkl request timed out')); });
  });
}

// Call Twinkl partner API.
// Normalises varying response shapes to a consistent [{external_url, title, description, thumbnail_url, tags}] array.
async function searchApi(apiKey, query, opts = {}) {
  const params = new URLSearchParams({ q: query, per_page: String(opts.limit || 12) });
  if (opts.yearGroup) params.set('year_group', String(opts.yearGroup));
  if (opts.subject)   params.set('subject', opts.subject);
  if (opts.keyStage)  params.set('key_stage', String(opts.keyStage));

  const res = await httpGet(`${TWINKL_API_BASE}/resources?${params}`, {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'User-Agent': 'Wren/1.0',
  });

  if (res.status === 401) throw Object.assign(new Error('Invalid Twinkl API key'), { code: 'INVALID_KEY' });
  if (res.status !== 200) throw new Error(`Twinkl API returned ${res.status}`);

  const data = JSON.parse(res.body);
  const resources = data.resources || data.data || data.results || [];
  return resources.map(normalise);
}

// Fetch a twinkl.co.uk page and extract Open Graph metadata.
async function resolveUrl(url) {
  if (!url || !url.includes('twinkl.co.uk')) {
    throw new Error('URL must be a twinkl.co.uk resource URL');
  }

  const res = await httpGet(url, {
    'User-Agent': 'Mozilla/5.0 (compatible; WrenBot/1.0; +https://getwren.co.uk)',
    Accept: 'text/html',
  });

  if (res.status !== 200) throw new Error(`Could not fetch Twinkl page (HTTP ${res.status})`);

  const html = res.body;
  const og = parseOG(html);
  const title = og['og:title'] || extractTitle(html) || url;

  return {
    external_url: url,
    title: title.replace(/\s*[|\-—]\s*Twinkl.*/i, '').trim(),
    description: og['og:description'] || '',
    thumbnail_url: og['og:image'] || null,
    tags: [],
    provider: 'twinkl',
  };
}

function normalise(r) {
  return {
    external_url: r.url || r.resource_url || r.href || `https://www.twinkl.co.uk/resource/${r.id || ''}`,
    title: r.title || r.name || '(Untitled)',
    description: r.description || r.summary || '',
    thumbnail_url: r.thumbnail_url || r.image_url || r.thumbnail || r.image || null,
    tags: Array.isArray(r.tags) ? r.tags : (r.keywords ? String(r.keywords).split(',').map(t => t.trim()) : []),
    year_group: r.year_group,
    key_stage: r.key_stage,
    subject: r.subject,
    provider: 'twinkl',
  };
}

function parseOG(html) {
  const og = {};
  const re = /<meta[^>]+>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const propMatch = /property=["']([^"']+)["']/.exec(tag);
    const contentMatch = /content=["']([^"']+)["']/.exec(tag);
    if (propMatch && contentMatch) og[propMatch[1]] = contentMatch[1];
  }
  return og;
}

function extractTitle(html) {
  const m = /<title>([^<]+)<\/title>/i.exec(html);
  return m ? m[1] : null;
}

module.exports = { encrypt, decrypt, maskKey, searchApi, resolveUrl };
