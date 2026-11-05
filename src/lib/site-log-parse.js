'use strict';
/**
 * b517 — the one place that understands a getwren.co.uk web-server log line.
 *
 * Pure functions only: no database, no filesystem, no clock. scripts/site-analytics-ingest.js
 * feeds lines in and writes the counts out; the unit fixture feeds the same lines in and
 * checks the classification. Keeping the two apart is what makes the bot filter testable,
 * which matters because roughly half of all traffic to the site is robots.
 *
 * Two log formats are understood:
 *   OLD  (nginx's stock "main", everything logged before b517 shipped)
 *        $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent
 *        "$http_referer" "$http_user_agent" "$http_x_forwarded_for"
 *   NEW  (the "wrenland" format b517 adds to landing/nginx.conf)
 *        ... "$http_x_forwarded_for" "$host" "$http_cf_ipcountry" $request_time
 *
 * The OLD format does not log the hostname, so for those lines the host is inferred from
 * the referrer and then from the path, and falls back to '(unknown)'. Anything the Roost
 * page shows for a day before the format change carries that caveat.
 */

// ── Our own hostnames ────────────────────────────────────────────────────────
const OWN_HOSTS = new Set([
  'getwren.co.uk', 'www.getwren.co.uk', 'phonics.getwren.co.uk',
  'ey.getwren.co.uk', 'admin.getwren.co.uk', 'primary.getwren.co.uk',
  'secondary.getwren.co.uk', 'demo.getwren.co.uk', 'classmind.getwren.co.uk',
  'example-nursery.co.uk', 'www.example-nursery.co.uk',
  'parents.example-nursery.co.uk', 'ey.example-nursery.co.uk',
  'hr.example-nursery.co.uk', 'admin.example-nursery.co.uk',
  'localhost', '127.0.0.1', 'your-server',
]);

// www.getwren.co.uk and getwren.co.uk are one website as far as Toby is concerned;
// phonics.getwren.co.uk is a separate app and stays separate.
function normaliseHost(h) {
  if (!h) return '';
  let s = String(h).toLowerCase().trim().replace(/:\d+$/, '');
  if (s === 'www.getwren.co.uk') s = 'getwren.co.uk';
  if (s === 'www.example-nursery.co.uk') s = 'example-nursery.co.uk';
  return s;
}

// ── Robots ───────────────────────────────────────────────────────────────────
// Order matters: the first match wins, so put the specific names before the
// generic 'bot' catch-all at the bottom.
const UA_RULES = [
  // Link-preview fetchers. These are the share signal: one of these arriving
  // means a human pasted the URL into that app a moment earlier.
  [/facebookexternalhit|facebookcatalog|facebookbot/i,       'facebook',        'preview', 'facebook'],
  [/whatsapp/i,                                              'whatsapp',        'preview', 'whatsapp'],
  [/telegrambot|telegram/i,                                  'telegram',        'preview', 'telegram'],
  [/slackbot|slack-imgproxy|slack-linkexpanding/i,           'slack',           'preview', 'slack'],
  [/twitterbot/i,                                            'twitter',         'preview', 'twitter'],
  [/linkedinbot/i,                                           'linkedin',        'preview', 'linkedin'],
  [/discordbot/i,                                            'discord',         'preview', 'discord'],
  [/pinterest(bot|\/|\s)/i,                                  'pinterest',       'preview', 'pinterest'],
  [/skypeuripreview/i,                                       'skype',           'preview', 'skype'],
  [/redditbot/i,                                             'reddit',          'preview', 'reddit'],
  [/embedly/i,                                               'embedly',         'preview', 'embedly'],
  [/iframely/i,                                              'iframely',        'preview', 'iframely'],
  [/vkshare/i,                                               'vk',              'preview', 'vk'],
  [/viber/i,                                                 'viber',           'preview', 'viber'],
  [/snapchat/i,                                              'snapchat',        'preview', 'snapchat'],
  [/flipboard/i,                                             'flipboard',       'preview', 'flipboard'],
  [/mastodon|akkoma|pleroma|misskey/i,                       'mastodon',        'preview', 'mastodon'],
  [/bluesky|bskybot/i,                                       'bluesky',         'preview', 'bluesky'],
  [/nuzzel/i,                                                'nuzzel',          'preview', 'nuzzel'],

  // Google's own non-search fetchers. NOT a share signal: nobody pasted a link,
  // so these are crawlers with a 'tool' family rather than 'preview'.
  [/google.?pagerenderer|googledocs|google-read-aloud|google-site-verification/i,
                                                             'google-fetcher',  'tool',    null],

  // AI crawlers and AI-assistant fetches.
  [/gptbot/i,                                                'gptbot',          'ai',      null],
  [/chatgpt-user/i,                                          'chatgpt-user',    'ai',      null],
  [/oai-?searchbot/i,                                        'oai-searchbot',   'ai',      null],
  [/perplexity-?user/i,                                      'perplexity-user', 'ai',      null],
  [/perplexitybot/i,                                         'perplexitybot',   'ai',      null],
  [/claude-?(bot|web|searchbot|user)|anthropic-ai/i,         'claudebot',       'ai',      null],
  [/google-extended/i,                                       'google-extended', 'ai',      null],
  [/applebot-extended/i,                                     'applebot-extended','ai',     null],
  [/bytespider/i,                                            'bytespider',      'ai',      null],
  [/amazonbot/i,                                             'amazonbot',       'ai',      null],
  [/exasearchbot|crawler\.exa\.ai/i,                         'exasearchbot',    'ai',      null],
  [/meta-external(agent|fetcher)/i,                          'meta-ai',         'ai',      null],
  [/cohere-ai/i,                                             'cohere',          'ai',      null],
  [/diffbot/i,                                               'diffbot',         'ai',      null],
  [/youbot/i,                                                'youbot',          'ai',      null],
  [/mistralai-user/i,                                        'mistral',         'ai',      null],
  [/ai2bot|imagesiftbot|omgili|webzio|timpibot/i,            'ai-other',        'ai',      null],

  // Search engines.
  [/googlebot|google favicon|storebot-google|googleother/i,  'googlebot',       'search',  null],
  [/bingbot|adidxbot|msnbot|bingpreview/i,                   'bingbot',         'search',  null],
  [/applebot/i,                                              'applebot',        'search',  null],
  [/duckduckbot|duckduckgo/i,                                'duckduckbot',     'search',  null],
  [/yandex/i,                                                'yandexbot',       'search',  null],
  [/baiduspider|baidu/i,                                     'baiduspider',     'search',  null],
  [/\bslurp\b/i,                                             'yahoo-slurp',     'search',  null],
  [/seznambot/i,                                             'seznambot',       'search',  null],
  [/petalbot|aspiegelbot/i,                                  'petalbot',        'search',  null],
  [/mojeekbot/i,                                             'mojeekbot',       'search',  null],
  [/qwantbot|qwantify/i,                                     'qwantbot',        'search',  null],
  [/\byeti\b/i,                                              'naver-yeti',      'search',  null],
  [/sogou/i,                                                 'sogou',           'search',  null],

  // Hostile probes. These arrive with their own fingerprints as well as hostile paths.
  [/secret-scanner|masscan|zgrab|nmap|sqlmap|dirbuster|gobuster|ffuf|wpscan|nuclei|l9(explore|tcpid)/i,
                                                             'scanner',         'scanner', null],
  [/censysinspect|internet-?measurement|expanse|paloaltonetworks|shodan|netsystemsresearch|odin\b/i,
                                                             'net-survey',      'scanner', null],

  // SEO and marketing crawlers.
  [/semrushbot/i,                                            'semrushbot',      'seo',     null],
  [/ahrefsbot/i,                                             'ahrefsbot',       'seo',     null],
  [/mj12bot/i,                                               'mj12bot',         'seo',     null],
  [/dotbot|opensiteexplorer|rogerbot/i,                      'dotbot',          'seo',     null],
  [/blexbot|barkrowler|babbar/i,                             'blexbot',         'seo',     null],
  [/dataforseo|serpstat|megaindex|seokicks|linkdexbot|zoominfo|bomborabot|netcraft/i,
                                                             'seo-other',       'seo',     null],
  [/screaming ?frog|sitebulb/i,                              'seo-audit',       'seo',     null],

  // Scrapers, monitors, libraries and headless browsers.
  [/shapbot/i,                                               'shapbot',         'scraper', null],
  [/msh-pdfmin|pdfmin/i,                                     'pdf-scraper',     'scraper', null],
  [/headlesschrome|puppeteer|playwright|phantomjs|selenium/i,'headless',        'scraper', null],
  [/scrapy|httpx|colly|node-fetch|axios|guzzle|postmanruntime/i, 'http-library', 'tool',   null],
  [/^curl\/|\bcurl\/|wget|python-requests|python-urllib|aiohttp|go-http-client|okhttp|libwww-perl|java\/\d/i,
                                                             'http-client',     'tool',    null],
  [/uptimerobot|pingdom|site24x7|statuscake|betteruptime|better-uptime|hetrixtools|newrelic|datadog|zabbix|nagios|blackbox_exporter|prometheus/i,
                                                             'monitor',         'monitor', null],
  [/chrome-lighthouse|pagespeed|gtmetrix|w3c_validator|validator\.nu/i, 'audit-tool', 'tool', null],
  [/feedfetcher|feedly|rss|newsblur|inoreader/i,             'feed-reader',     'tool',    null],

  // Anything self-identifying as a robot that none of the above named.
  [/bot\b|bot\/|crawler|crawl\b|spider|archiver|fetcher|scraper|monitoring|preview|probe|checker/i,
                                                             'other-bot',       'other',   null],
  // A URL inside the user-agent. Only crawlers advertise where to complain
  // ("(compatible; Hunyuan/1.0; +https://hunyuan.tencent.com/)"); no browser does.
  [/\+https?:\/\//i,                                        'self-declared',   'other',   null],
];

// Hostile paths. A request for any of these is a probe whoever sent it, so it is
// counted as a scanner hit and never as a page view.
const SCANNER_PATH = new RegExp([
  '(^|/)\\.env', '(^|/)\\.git(/|$)', '(^|/)\\.svn(/|$)', '(^|/)\\.hg(/|$)',
  '(^|/)\\.aws(/|$)', '(^|/)\\.ssh(/|$)', '(^|/)\\.docker(/|$)',
  '(^|/)\\.vscode(/|$)', '(^|/)\\.idea(/|$)', '(^|/)\\.DS_Store$',
  'wp-login', 'wp-admin', 'wp-content', 'wp-includes', 'wp-json', 'wordpress',
  'xmlrpc\\.php', 'phpmyadmin', 'phpinfo', 'myadmin', '/adminer',
  '\\.(php|php7|phtml|asp|aspx|jsp|cgi|pl|sh|bak|old|sql|zip~)$',
  '/cgi-bin/', '/vendor/', '/backend/\\.env', '/laravel', '/telescope',
  '/actuator', '/solr/', '/jenkins', '/druid/', '/server-status',
  '/credentials', '/secrets', 'eval-stdin', 'hello.?world', '/shell',
  '/autodiscover', '/owa/', '/ecp/', '/boaform', '/HNAP1', '/setup\\.cgi',
  '/config\\.(json|php|ya?ml)$', '/\\.well-known/traffic-advice',
  // Credential-page enumeration. nginx answers 200 + index.html for any unknown
  // path on this site, so a 404 never gives these away; the site has no login at
  // all, which is what makes the whole family safe to treat as a probe.
  '^/(admin|administrator|auth|login|signin|sign-in|signup|sign-up|register|account|accounts|user|users|dashboard|portal|cpanel|webmail|wp|graphql|_profiler|debug)(/|$)',
  '^/(forgot-password|reset-password|password-reset|logout|oauth|sso|saml)(/|$)',
  // ── 2026-10-20, from a month of the real log ──────────────────────────────
  // Everything below was found counting as a "page view" on getwren.co.uk because
  // the same scanner also fetched something that looked like a stylesheet, which
  // is all the corroboration rule asks for. ANY dotfile is a probe (nothing on
  // this site is served from one) except /.well-known/, which is legitimate.
  '(^|/)\\.(?!well-known(/|$))[A-Za-z0-9_.-]+',
  // Admin consoles, app servers and framework debug endpoints. None of these
  // paths exists on getwren.co.uk. IF THE SITE EVER GAINS ONE — a /blog, say —
  // take it out of this list, or its traffic will be counted as robots.
  '^/(backoffice|panel|console|secure|whm|webadmin|server-info|server-status|telescope|horizon|actuator|phpinfo|_environment|environment|credentials|secrets|vault|shell|webshell|filemanager|owa|ecp|autodiscover|boaform|hnap1|solr|jenkins|druid|grafana|kibana|elasticsearch|phpunit|geoserver|webinterface|remote|blog|cms|portal|manager|struts|jmx-console|invoker)(/|$)',
  '^/(app|info|status|settings|setup|install|config|configuration|env|test|tmp|temp|cache|logs|log|db|database|sql|dump|backup|old)/?$',
  'application\\.properties$', '/web\\.config$', '/docker-compose\\.ya?ml$',
  '/(package|composer)\\.json$', '/id_(rsa|dsa|ed25519)$', '/webroot/',
  // Some scanners announce themselves in the path, which is as good as a signature.
  'scnr-probe', 'acunetix', 'nessus', '/\\$\\{jndi:',
].join('|'), 'i');

// Paths that are real but are not a page view: housekeeping, beacons, feeds.
const NON_PAGE_PATH = /^\/(robots\.txt|sitemap[^/]*\.xml|favicon\.ico|apple-touch-icon[^/]*|browserconfig\.xml|sw\.js|manifest\.webmanifest|site\.webmanifest|ads\.txt|_i|api\/|\.well-known\/)/i;

const ASSET_EXT   = /\.(css|js|mjs|json|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|txt|xml|wasm|m4a|ogg|webm)$/i;
const DOWNLOAD_EXT= /\.(pdf|zip|docx?|pptx?|xlsx?|epub|mp3|mp4|mov|csv)$/i;

// Referrer spam. These show up with ordinary browser user-agents, so the referrer
// is the only tell. The ingest job merges this list with ladn.settings
// 'site_analytics_spam_referrers' so Toby can add a domain without a deploy.
const SPAM_REFERRERS = [
  'binance.com', 'fanhouse.agency', 'michelerizzato.it', 'rottenwifi.com',
  'techbloat.com', 'itechfaqs.com', 'macmyths.com', 'laptops251.com',
  'freedom251.com', 'everythingxiaomi.com', 'semalt.com', 'buttons-for-website.com',
  'hulfingtonpost.com', 'ilovevitaly.com', 'trafficmonetizer.org', 'best-seo-offer.com',
  'event-tracking.com', 'get-free-traffic-now.com', 'success-seo.com', 'social-buttons.com',
];

// Referrer domain → group. Longest suffix match wins.
const REF_GROUPS = [
  [/(^|\.)google\.[a-z.]+$/,                'google'],
  [/(^|\.)(bing\.com|msn\.com)$/,           'bing'],
  [/(^|\.)(duckduckgo\.com|yahoo\.[a-z.]+|ecosia\.org|startpage\.com|search\.brave\.com|qwant\.com|baidu\.com|yandex\.[a-z.]+|naver\.com|sogou\.com|mojeek\.com)$/, 'other-search'],
  [/(^|\.)(chatgpt\.com|openai\.com|perplexity\.ai|claude\.ai|copilot\.microsoft\.com|gemini\.google\.com|you\.com|phind\.com|poe\.com)$/, 'ai'],
  [/(^|\.)(facebook\.com|fb\.me|fb\.com|instagram\.com)$/, 'facebook'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/,         'whatsapp'],
  [/(^|\.)(twitter\.com|x\.com|t\.co)$/,    'twitter'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/,       'linkedin'],
  [/(^|\.)reddit\.com$/,                    'reddit'],
  [/(^|\.)(t\.me|telegram\.me|telegram\.org)$/, 'telegram'],
  [/(^|\.)(youtube\.com|youtu\.be)$/,       'youtube'],
  [/(^|\.)pinterest\.[a-z.]+$/,             'pinterest'],
  [/(^|\.)(mumsnet\.com|netmums\.com|eyfs\.info|tes\.com|twinkl\.co\.uk)$/, 'eyfs-community'],
];

// ── Section the path belongs to, so Toby can read Phonics apart from Resources ──
function sectionOf(host, path) {
  const h = normaliseHost(host);
  const p = String(path || '/').toLowerCase();
  if (h === 'phonics.getwren.co.uk') return 'phonics-app';
  // "For parents": the family-facing guidance inside the phonics programme.
  if (/^\/phonics-programme\/(families|parents|home-reading|home-slips)\b/.test(p)) return 'parents';
  if (/^\/phonics\/([a-z-]{2,10}\/)?(parents|school-readiness|child-development)\b/.test(p)) return 'parents';
  if (/^\/phonics(\/|$|\.html|-programme|-app)/.test(p) || p === '/sitemap-phonics.xml') return 'phonics';
  if (/^\/kids(\/|$)/.test(p)) return 'kids';
  if (/^\/(free-)?resources(\/|$|-|\.html)/.test(p)) return 'resources';
  if (p === '/' || /^\/(index|features|compare-[a-z]+|security|support|terms|privacy|open-source|what-happens-when|worst-case|unsubscribe|availability)(\.html)?$/.test(p)) return 'wren';
  return 'other';
}

function kindOfPath(path) {
  const p = String(path || '/');
  if (NON_PAGE_PATH.test(p)) return 'ignore';
  if (DOWNLOAD_EXT.test(p)) return 'download';
  if (ASSET_EXT.test(p)) return 'asset';
  if (/\.html?$/i.test(p) || /\/$/.test(p) || !/\.[a-z0-9]{1,6}$/i.test(p)) return 'page';
  return 'asset';
}

function classifyUA(ua) {
  const s = String(ua == null ? '' : ua).trim();
  if (!s || s === '-') return { kind: 'bot', bot: 'no-user-agent', family: 'other', platform: null };
  for (const [re, bot, family, platform] of UA_RULES) {
    if (re.test(s)) {
      return { kind: 'bot', bot, family, platform: platform || null };
    }
  }
  // A browser string that claims AppleWebKit but names no browser engine version is
  // a truncated forgery — the single commonest shape in this log's scraper traffic.
  if (/applewebkit/i.test(s) && !/(chrome|crios|safari\/|firefox|fxios|version\/|edg[ae]?\/|opr\/|samsungbrowser)/i.test(s)) {
    return { kind: 'bot', bot: 'forged-ua', family: 'scraper', platform: null };
  }
  if (s.length < 20) return { kind: 'bot', bot: 'short-ua', family: 'other', platform: null };
  return { kind: 'human', bot: null, family: null, platform: null };
}

// ── One log line → a record, or null when the line is not a request ──────────
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const LINE_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+|-)(.*)$/;

function parseTimeLocal(s) {
  // 20/Oct/2026:11:26:36 +0000
  const m = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(String(s || ''));
  if (!m) return null;
  const mo = MONTHS[m[2]];
  if (mo === undefined) return null;
  const offMin = (m[7][0] === '-' ? -1 : 1) * (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(3, 5), 10));
  const ms = Date.UTC(+m[3], mo, +m[1], +m[4], +m[5], +m[6]) - offMin * 60000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}

function quotedFields(tail) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(tail)) !== null) out.push(m[1]);
  return out;
}

function parseLine(line) {
  const raw = String(line == null ? '' : line).trim();
  if (!raw) return null;
  const m = LINE_RE.exec(raw);
  if (!m) return null;
  const at = parseTimeLocal(m[2]);
  if (!at) return null;

  const reqParts = String(m[3]).split(' ');
  const method = (reqParts[0] || '').toUpperCase();
  const target = reqParts.length >= 2 ? reqParts[1] : (reqParts[0] || '/');
  const qi = target.indexOf('?');
  let path = qi === -1 ? target : target.slice(0, qi);
  const query = qi === -1 ? '' : target.slice(qi + 1);
  try { path = decodeURIComponent(path); } catch (_) { /* keep the raw path */ }
  if (!path.startsWith('/')) path = '/' + path;

  const f = quotedFields(m[6]);              // referer, ua, xff, [host], [country]
  const referer = f[0] === undefined ? '-' : f[0];
  const ua      = f[1] === undefined ? '-' : f[1];
  const xff     = f[2] === undefined ? '-' : f[2];
  const hostF   = f[3] === undefined ? ''  : f[3];
  const countryF= f[4] === undefined ? ''  : f[4];

  // The real client is the FIRST address in X-Forwarded-For; $remote_addr is only
  // the docker bridge. Falls back to $remote_addr when there is no XFF.
  let ip = String(xff).split(',')[0].trim();
  if (!ip || ip === '-') ip = m[1];

  return {
    at,
    ip,
    method,
    path: path.slice(0, 300),
    query,
    status: parseInt(m[4], 10),
    bytes: m[5] === '-' ? 0 : parseInt(m[5], 10),
    referer: referer === '-' ? '' : referer,
    ua: ua === '-' ? '' : ua,
    logged_host: hostF && hostF !== '-' ? hostF : '',
    country: countryF && countryF !== '-' && /^[A-Za-z]{2}$/.test(countryF) ? countryF.toUpperCase() : '',
  };
}

// ── Where did the request say it came from ──────────────────────────────────
function refererDomain(referer) {
  const s = String(referer || '').trim();
  if (!s || s === '-') return '';
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(s);
  if (!m) return '';
  return m[1].toLowerCase().replace(/:\d+$/, '');
}

function queryParam(query, name) {
  const re = new RegExp('(?:^|&)' + name + '=([^&]*)');
  const m = re.exec(String(query || ''));
  if (!m) return '';
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')).slice(0, 80); } catch (_) { return m[1].slice(0, 80); }
}

function refInfo(rec, spamList) {
  const spam = spamList && spamList.length ? spamList : SPAM_REFERRERS;
  const dom = refererDomain(rec.referer);
  if (dom) {
    if (OWN_HOSTS.has(dom)) return { group: 'internal', domain: dom };
    for (const s of spam) {
      const sd = String(s).toLowerCase();
      if (dom === sd || dom.endsWith('.' + sd)) return { group: 'spam', domain: dom };
    }
    for (const [re, g] of REF_GROUPS) if (re.test(dom)) return { group: g, domain: dom };
    return { group: 'other', domain: dom };
  }
  // No referrer. A campaign parameter still tells us where the link was posted —
  // most often utm_source=chatgpt.com, which is how the phonics pages get found.
  const utm = (queryParam(rec.query, 'utm_source') || queryParam(rec.query, 'ref')).toLowerCase();
  if (utm) {
    for (const [re, g] of REF_GROUPS) if (re.test(utm)) return { group: g, domain: utm };
    return { group: 'other', domain: utm };
  }
  return { group: 'direct', domain: '(direct)' };
}

// A campaign needs somebody to have TAGGED a link. ?source= is deliberately not
// read as a medium: the phonics app launches itself with ?source=app and ?as=parent,
// which would otherwise fill the campaign list with the app's own navigation.
function campaignOf(rec) {
  const src  = queryParam(rec.query, 'utm_source') || queryParam(rec.query, 'ref');
  const med  = queryParam(rec.query, 'utm_medium');
  const camp = queryParam(rec.query, 'utm_campaign');
  if (!src && !camp) return null;
  return {
    source:   (src  || '(none)').toLowerCase().slice(0, 80),
    medium:   (med  || '(none)').toLowerCase().slice(0, 80),
    campaign: (camp || '(none)').toLowerCase().slice(0, 80),
  };
}

// ── First-party events: /_i?e=... and /go/<slug> ─────────────────────────────
function eventOf(rec) {
  if (rec.path === '/_i') {
    const e = (queryParam(rec.query, 'e') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
    if (!e) return null;
    const label = (queryParam(rec.query, 't') || '').toLowerCase().replace(/[^a-z0-9_./-]/g, '').slice(0, 120);
    return { event: e, label: label };
  }
  // A /go/ link is ONE slug. Scanners walk deep paths under any prefix — the real
  // log already holds /go/add-on/business-continuity/api/cruise_config — and those
  // are not click-throughs. An unknown single slug still counts and still
  // redirects to the Wren home page, which is the point of the default in the map.
  const go = /^\/go\/([a-z0-9][a-z0-9-]{0,40})\/?$/i.exec(rec.path);
  if (go) return { event: 'go', label: go[1].toLowerCase() };
  return null;
}

// ── The full picture for one line ────────────────────────────────────────────
function classify(rec, opts) {
  const o = opts || {};
  const uaInfo = classifyUA(rec.ua);
  const ref    = refInfo(rec, o.spamReferrers);

  let kind   = uaInfo.kind;          // 'human' | 'bot'
  let bot    = uaInfo.bot;
  let family = uaInfo.family;

  // Hostile path wins over a convincing user-agent.
  if (SCANNER_PATH.test(rec.path)) { kind = 'bot'; family = 'scanner'; bot = bot || 'path-probe'; }
  // A spam referrer with a browser user-agent is still not a visit.
  if (ref.group === 'spam' && kind === 'human') { kind = 'bot'; family = 'spam'; bot = 'referrer-spam'; }
  // A non-GET is never a page view (the lead forms POST here).
  const isRead = rec.method === 'GET' || rec.method === 'HEAD';
  // 4xx/5xx is not a view of anything. 304 is a real repeat view.
  const ok = rec.status === 200 || rec.status === 206 || rec.status === 304;

  const pathKind = kindOfPath(rec.path);
  const section  = sectionOf(o.host || rec.logged_host, rec.path);
  const event    = eventOf(rec);

  let bucket;                        // which counter on site_hits_daily this line adds to
  // scanner_hits means a hostile probe and nothing else. Referrer spam is a robot
  // too, but it is not an attack, so it lands in bot_hits and shows up by name in
  // site_bot_daily as 'referrer-spam'.
  if (family === 'scanner') bucket = 'scanner';
  else if (family === 'preview')                 bucket = 'preview';
  else if (kind === 'bot')                       bucket = 'bot';
  else if (!isRead || !ok || pathKind === 'ignore') bucket = 'other';
  else if (pathKind === 'download')              bucket = 'download';
  else if (pathKind === 'page')                  bucket = 'page';
  else                                            bucket = 'asset';

  return {
    kind, bot, family, bucket, section, pathKind, event,
    platform: uaInfo.platform,
    ref,
    campaign: campaignOf(rec),
    // A page view is what gets counted as a visit, and only a page view makes the
    // request's sender count towards unique visitors for the day.
    countsAsVisitor: bucket === 'page' || bucket === 'download',
  };
}


// ── Which site was this, on a line logged before b517 added $host ───────────
// Best effort, in this order: the logged host; the referrer when it is one of
// ours (true for every sub-resource of a page view); then a path shape that only
// one of the two sites has. Anything still undecided is '(unknown)' rather than
// guessed, so the Roost page can say so honestly.
const PATH_HOST_HINTS = [
  [/^\/(phonics-programme|free-resources|resources|kids|compare-|features|security|support|terms|privacy|open-source|what-happens-when|worst-case|unsubscribe|wren-one-pager|cyber-essentials)/i, 'getwren.co.uk'],
  [/^\/phonics(\/|$|\.html)/i,                                 'getwren.co.uk'],
  [/^\/sitemap-phonics\.xml$/i,                                 'getwren.co.uk'],
  [/^\/index\.html$/i,                                          'getwren.co.uk'],
  [/^\/wren-analytics\.js$/i,                                   'getwren.co.uk'],
  [/^\/js\/site-nav\.js$/i,                                    'getwren.co.uk'],
  // The phonics PWA lives at the root of its own host, so these are only ever its.
  [/^\/(app\.(js|css)|games\.(js|css)|listen\.js|write(-glyphs)?\.js|audio\.js|engine\.js|art\.js)$/i, 'phonics.getwren.co.uk'],
  [/^\/data\/[a-z0-9_-]+\.json$/i,                             'phonics.getwren.co.uk'],
  [/^\/(art|audio)\//i,                                         'phonics.getwren.co.uk'],
  [/^\/manifest\.webmanifest$/i,                                'phonics.getwren.co.uk'],
];

function inferHost(rec) {
  if (rec.logged_host) {
    const h = normaliseHost(rec.logged_host);
    if (h) return h;
  }
  const dom = normaliseHost(refererDomain(rec.referer));
  if (dom && OWN_HOSTS.has(dom) && dom !== 'localhost' && dom !== '127.0.0.1' && dom !== 'your-server') return dom;
  for (const [re, h] of PATH_HOST_HINTS) if (re.test(rec.path)) return h;
  return '(unknown)';
}

module.exports = {
  OWN_HOSTS, SPAM_REFERRERS, REF_GROUPS, UA_RULES,
  normaliseHost, inferHost, PATH_HOST_HINTS, parseLine, parseTimeLocal, quotedFields,
  classifyUA, classify, sectionOf, kindOfPath,
  refInfo, refererDomain, campaignOf, eventOf, queryParam,
};
