'use strict';
/**
 * eyfs-news.js — b361 (2026-09-29)
 *
 * Fetching and parsing the public EYFS news feeds the Staff Reading Corner's
 * weekly digest is built from. No database writes, no model calls, no side
 * effects beyond the HTTP requests themselves — so it can be exercised on its
 * own with `node scripts/b361-weekly-digest.js --dry-run --no-model`.
 *
 * ── WHAT MAY BE FETCHED, AND WHY THAT LIST IS SHORT ─────────────────────────
 * Toby's brief asks for "EYFS topics in the news, on facebook groups etc".
 *
 * Facebook groups are not fetchable and this file will not pretend otherwise.
 * Meta's terms prohibit automated collection, and there is no Groups API that
 * serves posts to a third party — there is no key that would make it work, so
 * this is not a configuration gap that a later build closes. The registry row
 * for Facebook has kind='manual' and no feed_url, and fetchSource() refuses any
 * row whose kind is not 'rss'. The route surfaces that row to the page so staff
 * are told, rather than left to assume the corner has seen everything.
 *
 * Nursery World and the Early Years Alliance both answer a script with HTTP 403.
 * They are registry rows too, marked 'blocked', with the reason stored. A source
 * that cannot be read is worth more as a visible absence than as a silent one.
 *
 * What is left — and it is plenty — is gov.uk (Ofsted and DfE, including the two
 * Ofsted blogs), Early Education, Birth to 5 Matters and NDNA. All publish open
 * RSS/Atom feeds intended to be read by feed readers, which is what this is.
 *
 * ── HOW IT BEHAVES ──────────────────────────────────────────────────────────
 * • One request per source, 20s timeout, a descriptive User-Agent, and a failure
 *   is recorded against that source and reported — never swallowed and never
 *   allowed to fail the run. Five sources working and three down still produces
 *   a digest, and the digest says which three were down.
 * • It reads the feed's own <description>/<summary>. It does NOT then fetch the
 *   article itself: one request per source per week is a polite amount of
 *   traffic for somebody else's server, and the feed summary is enough for the
 *   local model to write three sentences from.
 * • Items are scored against the topic keywords in settings.reading_corner_topics
 *   so the Ofsted feed's weekly school-inspection news does not crowd out early
 *   years.
 */

const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const UA = 'WrenReadingCorner/1.0 (+https://example-nursery.co.uk; nursery staff CPD digest)';
const FETCH_TIMEOUT_MS = 20000;
const MAX_ITEMS_PER_SOURCE = 25;

// ── URL normalisation — the dedupe key ──────────────────────────────────────
// gov.uk's search feed and the Ofsted organisation feed both carry the same
// publication, one of them with `?utm_source=`. Without this they are two items.
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|source$|at_medium$|at_campaign$)/i;

function normaliseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  // A trailing slash is not a different page.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

function urlHash(raw) {
  const n = normaliseUrl(raw);
  return n ? crypto.createHash('sha1').update(n).digest('hex') : null;
}

// ── text helpers ────────────────────────────────────────────────────────────
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch (_) { return ' '; } })
    .replace(/&amp;/g, '&');
}
function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function clip(s, n) {
  const t = String(s || '').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—(]+$/, '') + '…';
}

// A feed date can be RFC-822, ISO, or absent. Absent is fine — the job falls
// back to "we first saw it this week", which is the honest answer.
function parseDate(v) {
  if (!v) return null;
  const d = new Date(String(v).trim());
  return isNaN(d) ? null : d;
}
const ymd = d => (d instanceof Date && !isNaN(d)) ? d.toISOString().slice(0, 10) : null;

// ── feed parsing ────────────────────────────────────────────────────────────
// fast-xml-parser is already a dependency (xero-node and the EyMan scraper use
// it), so no new package. RSS 2.0 and Atom are both handled here rather than in
// two code paths, because the only differences that matter are three tag names.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // An Atom <content type="html"> arrives as an object with a #text child;
  // this keeps the text reachable at a predictable key.
  textNodeName: '#text',
});

const asArray = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Atom <link> is an element with attributes; RSS <link> is text. */
function linkOf(entry) {
  if (typeof entry.link === 'string') return entry.link;
  const links = asArray(entry.link);
  const alt = links.find(l => l && l['@_rel'] === 'alternate' && l['@_href'])
           || links.find(l => l && l['@_href'] && !l['@_rel'])
           || links.find(l => l && l['@_href']);
  if (alt) return alt['@_href'];
  if (entry.id && /^https?:\/\//.test(String(entry.id))) return String(entry.id);
  if (entry.guid) return typeof entry.guid === 'string' ? entry.guid : (entry.guid['#text'] || null);
  return null;
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && v['#text'] != null) return String(v['#text']);
  return '';
}

/**
 * Feed categories, flattened. Worth the trouble: Early Education tags its job
 * adverts "External job posts", and dropping those on a category is far more
 * reliable than guessing from a title that happens to contain "Nursery".
 * RSS gives plain strings, Atom gives <category term="…" label="…">.
 */
function categoriesOf(e) {
  return asArray(e.category)
    .map(c => (typeof c === 'string' ? c : (c && (c['@_label'] || c['@_term'] || c['#text'])) || ''))
    .map(s => stripTags(s))
    .filter(Boolean)
    .slice(0, 12);
}

/**
 * @param {string} xml
 * @returns {{title:string,url:string,url_hash:string,published_on:string|null,raw_summary:string,categories:string[]}[]}
 */
function parseFeed(xml) {
  let doc;
  try { doc = parser.parse(String(xml || '')); } catch (e) { throw new Error('feed did not parse as XML: ' + e.message); }

  const channel = doc && doc.rss && doc.rss.channel ? doc.rss.channel : null;
  const atom = doc && doc.feed ? doc.feed : null;
  const entries = channel ? asArray(channel.item) : atom ? asArray(atom.entry) : [];
  if (!channel && !atom) throw new Error('not an RSS or Atom document');

  const out = [];
  for (const e of entries.slice(0, MAX_ITEMS_PER_SOURCE)) {
    const url = normaliseUrl(linkOf(e));
    const title = stripTags(textOf(e.title));
    if (!url || !title) continue;
    const when = parseDate(textOf(e.pubDate) || textOf(e.published) || textOf(e.updated) || textOf(e['dc:date']));
    const raw = stripTags(textOf(e.description) || textOf(e.summary) || textOf(e.content) || textOf(e['content:encoded']));
    out.push({
      title: clip(title, 300),
      url,
      url_hash: urlHash(url),
      published_on: ymd(when),
      raw_summary: clip(raw, 1800),
      categories: categoriesOf(e),
    });
  }
  return out;
}

// ── topic scoring ───────────────────────────────────────────────────────────
function kwRegex(kw) {
  // Escape, then allow a hyphen where the keyword has a space, so "early years"
  // also matches an "early-years" slug or hyphenated headline.
  const esc = String(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s\\-]');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i');
}

/**
 * How well an item matches the setting's topics.
 *
 * The URL is DELIBERATELY not part of the haystack. Every Ofsted publication
 * lives under a gov.uk path containing "ofsted", so scoring the URL made the
 * Ofsted feed's spending returns and its Armed Forces training report score as
 * highly as an early years inspection change. Title, summary and the feed's own
 * categories are what the publisher actually said the item is about.
 *
 * @returns {{score:number, matched:string[], in_title:string[]}} score 0 = not about us
 */
function topicScore(item, keywords) {
  const title = String(item.title || '').toLowerCase();
  const cats = (item.categories || []).join(' ').toLowerCase();
  const body = `${title} ${String(item.raw_summary || '').toLowerCase()} ${cats}`;
  const matched = [], inTitle = [];
  for (const k of keywords) {
    const kw = String(k || '').trim().toLowerCase();
    if (kw.length < 3) continue;
    const re = kwRegex(kw);
    if (!re.test(body)) continue;
    matched.push(kw);
    if (re.test(title) || re.test(cats)) inTitle.push(kw);
  }
  return { score: matched.length + inTitle.length * 2, matched, in_title: inTitle };
}

/**
 * True when an item is one of the things a national feed carries that nobody in
 * a nursery needs on a Monday: job adverts, corporate transparency returns, and
 * the parts of Ofsted's remit that are not early years.
 *
 * Matched against the title and the feed's categories only — not the summary,
 * where "the report on inspection of prisons" in a round-up would take a real
 * article with it.
 */
function isNoise(item, excludes) {
  const hay = `${item.title || ''} ${(item.categories || []).join(' ')}`.toLowerCase();
  for (const x of excludes || []) {
    const kw = String(x || '').trim().toLowerCase();
    if (kw.length >= 3 && kwRegex(kw).test(hay)) return kw;
  }
  return null;
}

const DEFAULT_TOPICS = [
  'eyfs', 'early years', 'early education', 'childcare', 'nursery', 'pre-school', 'preschool',
  'childminder', 'reception', 'foundation stage', 'safeguarding', 'ofsted', 'development matters',
  'birth to 5', 'two-year-old', '2-year-old', 'funded hours', 'speech and language',
  'communication and language', 'phonics', 'send', 'early help', 'curriculum', 'school readiness',
];

const DEFAULT_EXCLUDES = [
  // Job adverts — Early Education tags these "External job posts".
  'external job posts', 'job post', 'vacancy', 'vacancies', 'recruiting', 'we are seeking',
  // Corporate/administrative publications from a government feed.
  'transparency data', 'spending over', 'audit and risk', 'committee minutes', 'board minutes',
  'annual report and accounts', 'freedom of information', 'senior officials', 'organogram',
  'procurement', 'workforce management information',
  // Ofsted inspects far more than nurseries.
  'armed forces', 'prison', 'probation', 'youth offending', 'further education and skills',
  'initial teacher education', 'initial teacher training', 'apprenticeship provider',
  'independent school', 'sixth form', 'secondary school', 'idsr',
];

// ── fetching ────────────────────────────────────────────────────────────────
/**
 * Fetch and parse one registry row.
 * Never throws for a network or parse problem — the caller gets {ok:false,error}
 * and the run continues with the sources that did answer.
 *
 * @param {{key:string,name:string,feed_url:string,kind:string,enabled:boolean}} source
 * @returns {Promise<{ok:boolean, key:string, items:object[], error:string|null, status:number|null}>}
 */
async function fetchSource(source, opts = {}) {
  const key = source && source.key;
  if (!source || source.kind !== 'rss' || !source.feed_url) {
    // Not an error, a fact about the source: Facebook and the 403s live here.
    return { ok: false, key, items: [], status: null, skipped: true,
             error: source && source.kind === 'manual'
               ? 'not fetchable — read by people, not by Wren'
               : 'no feed url (this source blocks automated readers)' };
  }
  if (source.enabled === false) return { ok: false, key, items: [], status: null, skipped: true, error: 'disabled' };

  let res;
  try {
    res = await fetch(source.feed_url, {
      headers: { 'user-agent': opts.userAgent || UA, accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
      signal: AbortSignal.timeout(opts.timeoutMs || FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (e) {
    return { ok: false, key, items: [], status: null, error: `unreachable: ${e.message}` };
  }
  if (!res.ok) return { ok: false, key, items: [], status: res.status, error: `HTTP ${res.status}` };

  let xml;
  try { xml = await res.text(); } catch (e) { return { ok: false, key, items: [], status: res.status, error: 'body unreadable: ' + e.message }; }

  let items;
  try { items = parseFeed(xml); } catch (e) { return { ok: false, key, items: [], status: res.status, error: e.message }; }

  return {
    ok: true, key, status: res.status, error: null,
    items: items.map(i => Object.assign({}, i, {
      source_key: source.key, source_name: source.name, publisher: source.publisher || source.name,
    })),
  };
}

/**
 * Fetch every fetchable source, in parallel, and return one flat candidate list
 * plus a per-source report. Deduped on url_hash, newest first.
 *
 * @returns {Promise<{items:object[], ok:string[], failed:{key:string,name:string,error:string}[], skipped:{key:string,name:string,error:string}[]}>}
 */
async function gather(sources, opts = {}) {
  const results = await Promise.all(sources.map(s => fetchSource(s, opts)));
  const byHash = new Map();
  const ok = [], failed = [], skipped = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i], s = sources[i];
    if (r.ok) {
      ok.push(r.key);
      for (const it of r.items) if (!byHash.has(it.url_hash)) byHash.set(it.url_hash, it);
    } else if (r.skipped) {
      skipped.push({ key: r.key, name: s.name, error: r.error });
    } else {
      failed.push({ key: r.key, name: s.name, error: r.error });
    }
  }
  const items = [...byHash.values()].sort((a, b) => String(b.published_on || '').localeCompare(String(a.published_on || '')));
  return { items, ok, failed, skipped, perSource: results.map((r, i) => ({ key: r.key, name: sources[i].name, ok: r.ok, count: r.items.length, error: r.error, status: r.status })) };
}

/**
 * Narrow a candidate list to what this setting cares about, recent first.
 *
 * Two gates, not one. The topic score says "this mentions early years"; the
 * relevance gate says "this is ABOUT early years" — the match has to be in the
 * title or in the publisher's own categories, or the body has to mention at
 * least two different topics. A school-workforce statistics release that says
 * "early years" once in paragraph nine does not get through.
 *
 * @param {object[]} items
 * @param {{topics?:string[], excludes?:string[], lookbackDays?:number, max?:number, today?:Date}} opts
 * @returns {object[]} each with topic_score, topics[], and dropped items absent
 */
function shortlist(items, opts = {}) {
  const topics = (opts.topics && opts.topics.length) ? opts.topics : DEFAULT_TOPICS;
  const excludes = opts.excludes === undefined ? DEFAULT_EXCLUDES : (opts.excludes || []);
  const lookback = opts.lookbackDays == null ? 10 : opts.lookbackDays;
  const today = opts.today || new Date();
  const cutoffYmd = ymd(new Date(today.getTime() - lookback * 86400000));

  const scored = [];
  for (const it of items) {
    // No date at all: keep it. A feed that omits pubDate (some WordPress ones
    // do) would otherwise vanish entirely, which is worse than an item that
    // turns out to be a fortnight old.
    if (it.published_on && it.published_on < cutoffYmd) continue;
    const noise = isNoise(it, excludes);
    if (noise) continue;
    const t = topicScore(it, topics);
    if (t.score <= 0) continue;
    if (!t.in_title.length && t.matched.length < 2) continue;
    scored.push(Object.assign({}, it, { topic_score: t.score, topics: t.matched.slice(0, 6) }));
  }
  scored.sort((a, b) =>
    (b.topic_score - a.topic_score) ||
    String(b.published_on || '').localeCompare(String(a.published_on || '')));
  return opts.max ? scored.slice(0, opts.max) : scored;
}

module.exports = {
  UA, DEFAULT_TOPICS, DEFAULT_EXCLUDES, MAX_ITEMS_PER_SOURCE,
  normaliseUrl, urlHash, parseFeed, topicScore, isNoise, fetchSource, gather, shortlist,
  stripTags, clip, ymd, categoriesOf,
};
