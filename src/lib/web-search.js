// web-search.js — staff-only web search/fetch for the Wren chat assistants (b169, 2026-07-28).
//
// Rationale: staff Chromebooks/laptops are being locked down to Wren-only, so the staff
// chat assistants need to fetch/search the web FOR staff (activity ideas, NHS/EYFS guidance,
// term dates, songs) instead of open browsing. Uses the local SearXNG instance on
// docker-work — no external search API, no keys, results stay on our own metasearcher.
//
// Nursery-staff tool: safesearch is forced on and a small denylist blocks obvious
// non-work categories (social media, streaming, shopping). NEVER used on the parents
// persona and NEVER fed any child/parent data — callers pass only the staff question.

const DEFAULT_BASES = [
  process.env.SEARXNG_URL,            // explicit override wins
  'http://172.17.0.1:8082',          // docker0 gateway → host SearXNG (primary from inside wren)
  'http://your-server:8082',       // docker-work Tailscale IP (fallback)
].filter(Boolean);

// Obvious non-work categories for a nursery staff tool. Matched against the result host.
// Kept deliberately small — safesearch=2 does most of the heavy lifting; this just trims
// the distraction/again-not-a-browser categories the prompt called out.
const DENY_HOSTS = [
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 't.co', 'tiktok.com',
  'snapchat.com', 'reddit.com', 'pinterest.com', 'threads.net', 'linkedin.com',
  'youtube.com', 'youtu.be', 'netflix.com', 'twitch.tv', 'spotify.com',
  'amazon.co.uk', 'amazon.com', 'ebay.co.uk', 'ebay.com', 'etsy.com',
  'aliexpress.com', 'temu.com', 'argos.co.uk', 'shein.com',
];

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

function isDenied(url) {
  const h = hostOf(url);
  if (!h) return true;
  return DENY_HOSTS.some(d => h === d || h.endsWith('.' + d));
}

function enabled() {
  return String(process.env.STAFF_CHAT_WEB || 'on').toLowerCase() !== 'off';
}

// search(q, {max}) → [{ title, url, snippet }]. Tries each SearXNG base until one answers.
// 6s timeout per base. Returns [] on total failure (caller degrades gracefully — never throws).
async function search(q, { max = 5 } = {}) {
  if (!enabled()) return [];
  const query = String(q || '').trim();
  if (!query) return [];

  for (const base of DEFAULT_BASES) {
    try {
      const u = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=2&language=en-GB`;
      const r = await fetch(u, {
        signal: AbortSignal.timeout(6000),
        headers: { 'Accept': 'application/json', 'User-Agent': 'WrenStaffAssistant/1.0' },
      });
      if (!r.ok) continue;
      const data = await r.json();
      const rows = Array.isArray(data.results) ? data.results : [];
      const out = [];
      const seen = new Set();
      for (const row of rows) {
        const url = row.url || '';
        if (!/^https?:\/\//i.test(url) || isDenied(url)) continue;
        const key = hostOf(url) + (row.title || '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          title: String(row.title || '').slice(0, 200),
          url,
          snippet: String(row.content || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        });
        if (out.length >= max) break;
      }
      return out;
    } catch { /* try next base */ }
  }
  return [];
}

// fetchPage(url) → readable plain text (tags stripped, 8k cap). Allowlist-first policy:
// any https is allowed EXCEPT denied categories. Returns '' on failure (never throws).
async function fetchPage(url) {
  if (!enabled()) return '';
  if (!/^https:\/\//i.test(String(url || '')) || isDenied(url)) return '';
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'Accept': 'text/html', 'User-Agent': 'WrenStaffAssistant/1.0' },
      redirect: 'follow',
    });
    if (!r.ok) return '';
    const ct = r.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(ct)) return '';
    let html = await r.text();
    // Drop non-content blocks entirely, then strip remaining tags.
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ');
    // Decode the handful of entities that survive tag-stripping.
    html = html
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(+n); } catch { return ' '; } });
    return html.replace(/\s+/g, ' ').trim().slice(0, 8000);
  } catch { return ''; }
}

// Cheap regex intent detector — does this staff message plausibly want the live web?
// Deliberately conservative: explicit "search/look up/find online" verbs, URLs, or
// clearly-current-events phrasing. Everyday practice questions are answered from the
// EYFS corpus/RAG as before, not the web.
const WEB_INTENT_RE = new RegExp([
  /\b(search|google|look ?up|find( me)?|search for)\b.*\b(online|web|internet)\b/,
  /\b(search|google) (for|the web|online)\b/,
  /\b(look ?up|find|show me|get me) .*\b(song|rhyme|recipe|craft|activity idea|template|printable|guidance|nhs|term dates?|weather|opening hours?|phone number|website)\b/,
  /\bhttps?:\/\/\S+/,
  /\b(latest|current|today'?s?|this week'?s?|recent|up to date|news about)\b/,
  /\bwhat'?s on\b|\bnear (me|us|the nursery)\b/,
].map(r => r.source).join('|'), 'i');

function wantsWeb(message) {
  if (!enabled()) return false;
  return WEB_INTENT_RE.test(String(message || ''));
}

module.exports = { search, fetchPage, wantsWeb, enabled, isDenied, hostOf };
