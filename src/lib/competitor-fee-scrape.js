'use strict';
/**
 * b203 — Competitor fee scraping.  (2026-08-19)
 *
 * Feeds ladn.competitor_fees for the fee-comparison grid and the April fee review.
 * Extends the existing Competitor Intelligence module; it does not replace any of it.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────────────
 * Never invent a number.  Every row written here carries the verbatim sentence it was
 * read from (`source_quote`) and the URL it came from, so any figure on Toby's screen
 * can be traced back to the provider's own words in one click.  Where a page cannot be
 * parsed confidently the raw text is stored at confidence='low' with needs_review=true;
 * where a site cannot be read at all the FAILURE is recorded against the source rather
 * than the source being quietly skipped.  A missing week must look missing.
 *
 * ── ETHICS (carried over from the competitor-intel module, unchanged) ───────────
 *   • Public pages only.  robots.txt is fetched and obeyed, including Crawl-delay.
 *   • The User-Agent says honestly who we are and why, with a contact address.
 *   • NO impersonation and NO fake enquiries.  Busy Bees put their fee sheet behind a
 *     "give us your details" form; we record that as `gated` and stop.  Filling that
 *     form in to get a price would be exactly the fake enquiry the module forbids.
 *   • One request per page per week, serialised, with a per-host delay.
 *
 * ── WHY PER-SITE ADAPTERS ───────────────────────────────────────────────────────
 * A generic "find the £ signs" pass produces plausible rubbish: registration fees,
 * late-collection charges and Tax-Free Childcare marketing copy all look like prices.
 * Each adapter below was written against the page as it actually stood on 2026-08-19
 * (evidence in the b203 NOTES), and every adapter degrades to `generic` — low
 * confidence, flagged for review — the moment the layout stops matching.  A layout
 * change therefore shows up as "needs review", never as a wrong number.
 */

const { getPool } = require('../db/pool');

// Identify honestly. Overridable so a Wren install elsewhere doesn't claim to be LADN.
const CONTACT   = process.env.FEE_WATCH_CONTACT || 'admin@example-nursery.co.uk';
const USER_AGENT = process.env.FEE_WATCH_UA ||
  `WrenFeeWatch/1.0 (+https://getwren.co.uk; local nursery fee benchmarking; contact ${CONTACT})`;

// b333 (2026-09-15): an OLLAMA_HOST / MODEL (gpt-oss:120b) pair stood here but was never
// read — nothing in this file calls a model — so it was removed rather than converted.

const FETCH_TIMEOUT_MS = 25000;
const MAX_BYTES        = 5 * 1024 * 1024;   // a fee page is never 5MB; refuse anything bigger

// ── polite fetching ──────────────────────────────────────────────────────────

const lastHostFetch = new Map();   // hostname → epoch ms
const robotsCache   = new Map();   // hostname → { disallowed:Set, crawlDelayMs, fetchedAt }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function politeWait(hostname, crawlDelayMs) {
  const last = lastHostFetch.get(hostname);
  if (last) {
    const wait = crawlDelayMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
  }
  lastHostFetch.set(hostname, Date.now());
}

/** Raw GET. Returns { ok, status, buffer, text, contentType, error }. Never throws. */
async function httpGet(url, { timeout = FETCH_TIMEOUT_MS } = {}) {
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/pdf,*/*' },
      signal: AbortSignal.timeout(timeout),
    });
    const contentType = r.headers.get('content-type') || '';
    const ab = await r.arrayBuffer();
    if (ab.byteLength > MAX_BYTES) {
      return { ok: false, status: r.status, contentType, error: `response too large (${ab.byteLength} bytes)` };
    }
    const buffer = Buffer.from(ab);
    return {
      ok: r.ok, status: r.status, contentType, buffer,
      text: /pdf/i.test(contentType) ? '' : buffer.toString('utf8'),
    };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

/**
 * robots.txt, cached an hour per host.  Also reads Crawl-delay — Fielding Primary asks
 * for 10s and we honour it rather than hammering a primary school's web host.
 */
async function robotsFor(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return { allowed: true, crawlDelayMs: 0 }; }

  const cached = robotsCache.get(parsed.hostname);
  if (!cached || Date.now() - cached.fetchedAt > 3600000) {
    const res = await httpGet(`${parsed.protocol}//${parsed.hostname}/robots.txt`, { timeout: 8000 });
    const disallowed = new Set();
    let crawlDelayMs = 0;
    if (res.ok && res.text) {
      let ours = false;
      for (const line of res.text.split('\n')) {
        const l = line.trim().toLowerCase();
        if (!l || l.startsWith('#')) continue;
        if (l.startsWith('user-agent:')) {
          const agent = l.slice('user-agent:'.length).trim();
          ours = agent === '*' || agent.includes('wren');
          continue;
        }
        if (!ours) continue;
        if (l.startsWith('disallow:')) {
          const p = l.slice('disallow:'.length).trim();
          if (p) disallowed.add(p);
        } else if (l.startsWith('crawl-delay:')) {
          const s = parseFloat(l.slice('crawl-delay:'.length).trim());
          if (s > 0) crawlDelayMs = Math.max(crawlDelayMs, Math.min(s, 60) * 1000);
        }
      }
    }
    robotsCache.set(parsed.hostname, { disallowed, crawlDelayMs, fetchedAt: Date.now() });
  }

  const { disallowed, crawlDelayMs } = robotsCache.get(parsed.hostname);
  const path = parsed.pathname || '/';
  for (const d of disallowed) {
    // Wildcard rules ("/*?add-to-cart=") only match when the pattern really matches.
    if (d.includes('*')) {
      const rx = new RegExp('^' + d.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
      if (rx.test(path + (parsed.search || ''))) return { allowed: false, crawlDelayMs };
    } else if (path.startsWith(d)) {
      return { allowed: false, crawlDelayMs };
    }
  }
  return { allowed: true, crawlDelayMs };
}

/** robots-checked, rate-limited fetch. */
async function fetchPolitely(url, { crawlDelayMs = 2000 } = {}) {
  const robots = await robotsFor(url);
  if (!robots.allowed) return { ok: false, status: 0, robotsBlocked: true, error: 'blocked by robots.txt' };
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  await politeWait(host, Math.max(crawlDelayMs, robots.crawlDelayMs));
  return httpGet(url);
}

// ── text extraction ──────────────────────────────────────────────────────────

/**
 * HTML → newline-preserving text.  Block-level closers become newlines BEFORE tags are
 * stripped: fee tables are the whole point here, and flattening `<td>£105</td>` rows into
 * one line destroys the label→number adjacency every adapter depends on.
 */
function htmlToLines(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(tr|p|div|li|h[1-6]|td|th|table|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&pound;|&#163;/g, '£')
    .replace(/&amp;|&#38;/g, '&')
    .replace(/&(?:rsquo|#8217|#39|apos);/g, "'")
    .replace(/&(?:ndash|#8211);/g, '–')
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t ]+/g, ' ')
    .split('\n').map(l => l.trim()).filter(Boolean);
}

async function pdfToLines(buffer) {
  try {
    const pdf = require('pdf-parse');
    const d = await pdf(buffer);
    return String(d.text || '').split('\n').map(l => l.trim()).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// ── small parsing helpers ────────────────────────────────────────────────────

const MONEY_RX = /£\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/;

/** "£2,346.74" → 234674 pence. Returns null for anything that isn't cleanly a price. */
function toPence(str) {
  if (str == null) return null;
  const m = MONEY_RX.exec(String(str));
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function allPence(str) {
  const out = [];
  const rx = new RegExp(MONEY_RX.source, 'g');
  let m;
  while ((m = rx.exec(String(str || '')))) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (isFinite(n) && n > 0) out.push(Math.round(n * 100));
  }
  return out;
}

/** Provider wording → the age bands ladn.fee_items already uses. */
function bandFromLabel(label) {
  const l = String(label || '').toLowerCase();
  if (/under\s*2|under-2|0\s*[-–]\s*2|birth|baby|9\s*month|3\s*month|months?\s*(?:to|[-–])\s*1\s*year|1\s*[-–]\s*2\s*year/.test(l)) return 'under_2';
  if (/2\s*[-–]\s*3|two\s*year|\b2\s*yo\b|2\s*year[- ]?olds?/.test(l)) return '2yo';
  if (/3\s*[-–]\s*[45]|three\s*and\s*four|3\s*&\s*4|pre[- ]?school|nursery\s*class|3\s*year[- ]?olds?/.test(l)) return '3_4yo';
  if (/over\s*2|over-2|2\s*[-–]\s*5|24m|24\s*months?\s*[-–]/.test(l)) return 'over_2';
  return 'unknown';
}

/**
 * Per-day equivalent, with the arithmetic written down.
 * Returns { pence, basis } or { pence: null, basis: reason } when it cannot be done
 * honestly — an unconvertible fee is left NULL rather than fudged.
 */
function toDayEquivalent({ fee_pence, period, days_per_week, weeks_per_year, sessions_per_day }) {
  if (!fee_pence) return { pence: null, basis: null };
  switch (period) {
    case 'day':
      return { pence: fee_pence, basis: 'provider quotes a per-day rate' };
    case 'half_day':
      return { pence: null, basis: 'half-day rate — not converted to a full day (a full day is rarely 2× a half day)' };
    case 'session': {
      if (!sessions_per_day) return { pence: null, basis: 'session rate — no stated number of sessions in a full day' };
      return {
        pence: Math.round(fee_pence * sessions_per_day),
        basis: `${sessions_per_day} × published session rate = one full day (provider's own session times tile the day)`,
      };
    }
    case 'week': {
      if (!days_per_week) return { pence: null, basis: 'weekly fee — days per week not stated' };
      return { pence: Math.round(fee_pence / days_per_week), basis: `weekly fee ÷ ${days_per_week} days` };
    }
    case 'month': {
      if (!days_per_week || !weeks_per_year) {
        return { pence: null, basis: 'monthly fee — provider does not state the weeks/year factor, so no honest per-day figure' };
      }
      const perDay = (fee_pence * 12) / weeks_per_year / days_per_week;
      return {
        pence: Math.round(perDay),
        basis: `monthly fee × 12 ÷ ${weeks_per_year} weeks ÷ ${days_per_week} days (provider's own stated calculation)`,
      };
    }
    default:
      return { pence: null, basis: null };
  }
}

/** A fee row, with the defaults that keep every writer honest. */
function feeRow(o) {
  const period = o.period || null;
  const de = o.day_equiv_pence !== undefined
    ? { pence: o.day_equiv_pence, basis: o.day_equiv_basis || null }
    : toDayEquivalent({
        fee_pence: o.fee_pence, period,
        days_per_week: o.days_per_week, weeks_per_year: o.weeks_per_year,
        sessions_per_day: o.sessions_per_day,
      });
  return {
    age_band:       o.age_band || 'unknown',
    room_label:     o.room_label || null,
    session_type:   o.session_type || 'other',
    days_per_week:  o.days_per_week ?? null,
    funding_basis:  o.funding_basis || 'standard',
    fee_pence:      o.fee_pence ?? null,
    period,
    day_equiv_pence: de.pence ?? null,
    day_equiv_basis: de.basis || null,
    effective_date: o.effective_date || null,
    source_quote:   (o.source_quote || '').slice(0, 500),
    raw_excerpt:    o.raw_excerpt ? String(o.raw_excerpt).slice(0, 2000) : null,
    confidence:     o.confidence || 'low',
    needs_review:   o.needs_review ?? (o.confidence !== 'high'),
    parse_note:     o.parse_note || null,
  };
}

/** Find the nearest preceding line that names an age band — table labels sit above prices. */
function nearestBandAbove(lines, i, lookback = 25) {
  for (let k = i; k >= Math.max(0, i - lookback); k--) {
    const b = bandFromLabel(lines[k]);
    if (b !== 'unknown') return { band: b, label: lines[k] };
  }
  return { band: 'unknown', label: null };
}

// ── adapters ─────────────────────────────────────────────────────────────────
// Each returns { status, fees, note, effective_date?, extraUrls? }.
// status: parsed | low_confidence | not_published | gated | unreachable

/**
 * Monkey Puzzle Ealing — /fees/ carries no prices itself; it links two PDFs
 * ("Ealing-Under-2s-April-26-NEW.pdf" / "Ealing-Over-2s-April-26-NEW.pdf").
 * We follow those links from the page rather than hard-coding them, so a re-issued
 * PDF for next April is picked up automatically.
 */
async function adapterMonkeyPuzzle({ html, url, source }) {
  const pdfUrls = [...new Set(
    (String(html).match(/href="([^"]+\.pdf)"/gi) || [])
      .map(h => h.replace(/^href="/i, '').replace(/"$/, ''))
      .filter(u => /under[-\s]?2|over[-\s]?2|fee/i.test(u))
      .map(u => { try { return new URL(u, url).toString(); } catch { return null; } })
      .filter(Boolean)
  )];

  if (!pdfUrls.length) {
    return { status: 'low_confidence', fees: [], note: 'No fee PDFs linked from /fees/ — layout may have changed.' };
  }

  const fees = [];
  const notes = [];
  for (const pdfUrl of pdfUrls.slice(0, 4)) {
    const res = await fetchPolitely(pdfUrl, { crawlDelayMs: source.crawl_delay_ms });
    if (!res.ok || !res.buffer) { notes.push(`${pdfUrl.split('/').pop()}: HTTP ${res.status}`); continue; }
    const lines = await pdfToLines(res.buffer);
    if (!lines.length) { notes.push(`${pdfUrl.split('/').pop()}: unreadable PDF`); continue; }

    const isUnder2 = /under[-\s]?2/i.test(pdfUrl) || lines.some(l => /Under 2/i.test(l));
    const band     = isUnder2 ? 'under_2' : 'over_2';
    const roomLbl  = isUnder2 ? "Under 2's" : "Over 2's";
    // The PDF says so itself: "(Weekly Booking × 51 weeks) ÷ 12 months".
    const weeksLine = lines.find(l => /×\s*51\s*weeks|51 weeks a year/i.test(l));
    const weeks = weeksLine ? 51 : null;

    // Headline day rate: the line after "Full Day" is the price.
    const fdIdx = lines.findIndex(l => /^Full Day$/i.test(l.trim()));
    if (fdIdx >= 0) {
      for (let k = fdIdx + 1; k < Math.min(fdIdx + 4, lines.length); k++) {
        const p = toPence(lines[k]);
        if (p) {
          fees.push(feeRow({
            age_band: band, room_label: roomLbl, session_type: 'full_day',
            fee_pence: p, period: 'day', confidence: 'high', needs_review: false,
            source_quote: `Full Day ${lines[k]}${lines[fdIdx + 2] ? ' (' + lines[fdIdx + 2] + ')' : ''}`,
            parse_note: 'Headline full-day rate from the provider fee PDF.',
          }));
          break;
        }
      }
    }

    // Monthly tables: a "Without funding" / "With funding" block of 5 prices, which the
    // PDF's own "FULL DAYS 5 4 3 2 1" row maps onto 5→1 days per week.
    for (const [needle, basis] of [['Without funding', 'standard'], ['With funding', 'funded_30h']]) {
      const idx = lines.findIndex(l => l.trim().toLowerCase() === needle.toLowerCase());
      if (idx < 0) continue;
      const prices = [];
      for (let k = idx + 1; k < lines.length && prices.length < 5; k++) {
        const p = toPence(lines[k]);
        if (p) prices.push({ pence: p, quote: lines[k] });
        else if (prices.length) break;      // block ended
      }
      prices.forEach((pr, n) => {
        const days = 5 - n;                  // the PDF prints 5,4,3,2,1 in that order
        fees.push(feeRow({
          age_band: band, room_label: roomLbl,
          session_type: `month_${days}d`, days_per_week: days,
          funding_basis: basis, fee_pence: pr.pence, period: 'month',
          weeks_per_year: weeks,
          confidence: 'high', needs_review: false,
          source_quote: `${needle} — ${days} full days/week: ${pr.quote}`,
          parse_note: weeks
            ? 'Monthly fee; provider states (Weekly Booking × 51 weeks) ÷ 12 months.'
            : 'Monthly fee; weeks/year factor not found in the PDF, so no per-day equivalent.',
        }));
      });
    }
    notes.push(`${pdfUrl.split('/').pop()}: ok`);
  }

  const eff = /april[-\s]?26/i.test(pdfUrls.join(' ')) ? '2026-04-01' : null;
  return {
    status: fees.length ? 'parsed' : 'low_confidence',
    fees, effective_date: eff,
    note: `Fee PDFs followed from /fees/ — ${notes.join('; ')}`,
  };
}

/**
 * Busy Bees — the nursery page shows no prices; the fee sheet is behind a form at
 * /download-fee-sheet/<id> that asks for a parent's name and email.  Submitting it would
 * be a fake enquiry, which this module does not do.  Recorded as gated, with the reason,
 * so the gap on Toby's screen is explained rather than mysterious.
 */
async function adapterBusyBees({ lines, url }) {
  const calc = lines.find(l => /fee calculator|calculate your fees/i.test(l));
  return {
    status: 'gated',
    fees: [],
    note: 'Fees are not published on the page: Busy Bees put the fee sheet behind a details-capture form ' +
          '(/download-fee-sheet/…) and a "fee calculator". We do not submit forms or make enquiries, so no ' +
          'figure is recorded. Ask them directly, or use a parent-shared fee sheet, and enter it manually.' +
          (calc ? ` Page offers: "${calc.slice(0, 120)}".` : ''),
  };
}

/**
 * Corner House — the fee table is a tab widget, and that matters: the flat text of the
 * page prints the three age tabs ("0-2 Years", "2-3 Years", "3-5 Years") as a header row
 * and then all nine price panels in DOM order, so reading top-to-bottom silently files
 * every price under the LAST age heading seen.  The markup carries the answer explicitly —
 * each panel is `<div class="mso-sf-panel" data-fg="F" data-yg="Y">` where the fg/yg
 * indices point at the tab buttons — so we parse the attributes, not the prose.
 *
 * The page states its own annualisation ("calculated over 51 weeks then divided by 12"),
 * which is what makes a per-day comparison possible at all.
 */
function adapterCornerHouse({ lines, html }) {
  const fees = [];
  const weeksLine = lines.find(l => /over\s*51\s*weeks|multiply the weekly amount by 51/i.test(l));
  const weeks = weeksLine ? 51 : null;

  // Tab buttons → index maps. data-yg gives the age band, data-fg standard vs funded.
  const tabLabels = (attr) => {
    const out = {};
    const rx = new RegExp(`<button[^>]*data-${attr}="(\\d+)"[^>]*>([\\s\\S]*?)</button>`, 'gi');
    let m;
    while ((m = rx.exec(html || ''))) out[m[1]] = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return out;
  };
  const ygLabels = tabLabels('yg');

  const panelRx = /<div class="mso-sf-panel[^"]*"[^>]*data-fg="(\d+)"[^>]*data-yg="(\d+)"[^>]*>([\s\S]*?)(?=<div class="mso-sf-panel[^"]*"[^>]*data-fg=|<\/div>\s*<\/div>\s*<\/div>\s*<\/div>)/gi;
  let pm;
  while ((pm = panelRx.exec(html || ''))) {
    const [, , yg, body] = pm;
    const roomLabel = ygLabels[yg] || null;
    const band = bandFromLabel(roomLabel || '');
    if (band === 'unknown') continue;

    // The panel header is the funding basis in the provider's own words.
    const headerRaw = (/<div class="mso-sf-panel-header">([\s\S]*?)<\/div>/i.exec(body) || [])[1] || '';
    const header = headerRaw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const basis = /30\s*hours?/i.test(header) ? 'funded_30h'
                : /15\s*hours?/i.test(header) ? 'funded_15h'
                : 'standard';

    const rowRx = /<td class="mso-sf-table-label">([\s\S]*?)<\/td>\s*<td class="mso-sf-table-price">([\s\S]*?)<\/td>/gi;
    let rm;
    while ((rm = rowRx.exec(body))) {
      const label = rm[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      const priceTxt = rm[2].replace(/<[^>]+>/g, ' ').replace(/&pound;/g, '£').replace(/\s+/g, ' ').trim();
      const price = toPence(priceTxt);
      if (!price) continue;

      const dm = /\((\d)\s*Days?\)/i.exec(label);
      const days = dm ? parseInt(dm[1], 10) : null;
      const isMonthly = /full year/i.test(label) || days != null;
      // The funded panels close with per-day "Food" / "Extra Consumables" rows — the charge a
      // funded parent still pays, so very much worth comparing. They carry the same value as
      // each other, so the label has to go into room_label or the unique key drops one.
      const isConsumable = !isMonthly && /food|consumable/i.test(label);

      fees.push(feeRow({
        age_band: band, room_label: isConsumable ? `${roomLabel} — ${label}` : roomLabel,
        session_type: isConsumable ? 'consumables' : (days ? `month_${days}d` : 'other'),
        days_per_week: days, funding_basis: basis,
        fee_pence: price, period: isMonthly ? 'month' : (isConsumable ? 'day' : null),
        day_equiv_pence: isConsumable ? null : undefined,
        day_equiv_basis: isConsumable ? 'consumables charge, not a childcare day rate' : undefined,
        weeks_per_year: weeks,
        confidence: 'high', needs_review: false,
        source_quote: `${roomLabel} — ${header || 'Standard'} — ${label}: ${priceTxt}`,
        parse_note: weeks
          ? 'Monthly fee; the page states fees are calculated over 51 weeks ÷ 12 months.'
          : 'Monthly fee; the 51-week annualisation sentence was not found this run, so no per-day equivalent.',
      }));
    }
  }

  // One-off charges — part of what a parent actually compares.
  for (let i = 0; i < lines.length; i++) {
    if (!/^Registration Fee$|^Nursery Acceptance Deposit$/i.test(lines[i])) continue;
    for (let k = i + 1; k < Math.min(i + 5, lines.length); k++) {
      const p = toPence(lines[k]);
      if (!p) continue;
      fees.push(feeRow({
        age_band: 'mixed', room_label: null,
        session_type: /registration/i.test(lines[i]) ? 'registration' : 'deposit',
        fee_pence: p, period: 'one_off', confidence: 'high', needs_review: false,
        source_quote: `${lines[i]}: ${lines[k]}`,
      }));
      break;
    }
  }

  const bands = new Set(fees.filter(f => f.period === 'month').map(f => f.age_band));
  return {
    status: fees.length ? 'parsed' : 'low_confidence',
    fees,
    note: fees.length
      ? `Parsed ${fees.length} price points from the tabbed fee widget across ${bands.size} age band(s).`
      : 'Fee widget markup did not match — falling back to review.',
  };
}

/**
 * Fielding Primary School Nursery — maintained-school, term-time, session-priced.
 * The table prints each row over three lines (name / times / price), so the price is up to
 * two lines below its label; reading only the next line finds nothing and, worse, lets the
 * "£5.05 per five-hour session" consumables row look like the session fee itself.  Rows are
 * therefore matched on their own label first, and the price is taken from the following
 * lines up to the next label.
 *
 * The two standard sessions (8:00am–1:00pm and 1:00pm–6:00pm) tile the 8am–6pm day, so a
 * full-day equivalent is 2× the session rate — an assumption written into day_equiv_basis
 * rather than hidden.  Ad-hoc and late-collection rates are not day-comparable and stay NULL.
 */
function adapterFielding({ lines }) {
  const fees = [];
  const eff = lines.some(l => /September 2026/i.test(l)) ? '2026-09-01' : null;

  // Row label → how to file it. Order matters: the first match wins.
  const ROWS = [
    { rx: /^Morning or Afternoon \(Ad-hoc\)$/i,      type: 'session_adhoc', band: '3_4yo', sessions: null, conf: 'high' },
    { rx: /^(Morning|Afternoon)$/i,                    type: 'session',       band: '3_4yo', sessions: 2,    conf: 'high' },
    { rx: /^Early Morning \(Ad-hoc\)$/i,             type: 'wraparound_adhoc', band: '3_4yo', sessions: null, conf: 'high' },
    { rx: /^Early Morning$/i,                          type: 'wraparound',    band: '3_4yo', sessions: null, conf: 'high' },
    { rx: /^Late Collection/i,                         type: 'late_fee',      band: '3_4yo', sessions: null, conf: 'high' },
    { rx: /^Government Funding$/i,                     type: 'funding_offset',band: '3_4yo', sessions: null, conf: 'high' },
    { rx: /^Meals\/?\s*Snacks/i,                     type: 'consumables',   band: '3_4yo', sessions: null, conf: 'high' },
  ];
  const isLabel = l => ROWS.some(r => r.rx.test(l.trim()));

  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].trim();
    const row = ROWS.find(r => r.rx.test(label));
    if (!row) continue;

    // Walk forward to the price, stopping at the next row label so a blank cell cannot
    // steal the following row's number.
    let price = null, detail = [];
    for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
      if (isLabel(lines[k])) break;
      const p = toPence(lines[k]);
      if (p) { price = p; detail.push(lines[k]); break; }
      detail.push(lines[k]);
    }
    if (!price) continue;

    fees.push(feeRow({
      age_band: row.band, room_label: 'Nursery (term-time)',
      session_type: row.type,
      fee_pence: price,
      period: row.type === 'late_fee' ? 'one_off' : 'session',
      sessions_per_day: row.sessions,
      funding_basis: row.type === 'funding_offset' ? 'funded_30h' : 'standard',
      confidence: row.conf, needs_review: false,
      effective_date: eff,
      source_quote: `${label} — ${detail.join(' — ')}`.slice(0, 300),
      parse_note: row.type === 'session'
        ? 'Term-time only, maintained-school nursery. Full-day equivalent assumes the two published five-hour sessions (8:00am–1:00pm + 1:00pm–6:00pm) tile one day.'
        : row.type === 'funding_offset'
          ? 'The funding value the school applies per five-hour session — not a parent-paid fee.'
          : row.type === 'consumables'
            ? 'Meals/snacks/milk/wipes charge per five-hour session.'
            : null,
    }));
  }

  const core = fees.filter(f => f.session_type === 'session').length;
  return {
    status: core ? 'parsed' : 'low_confidence',
    fees, effective_date: eff,
    note: core
      ? `Parsed ${fees.length} price points (${core} standard session rates) from the term-time table.`
      : 'Session table did not match the expected label/price layout.',
  };
}

/**
 * Destiny Helpers — prices in prose on /admissions/, one age band per line, e.g.
 *   "£70 per day/ £45 half day: 1-2 years old"
 *   "8am (pre booked) /9:00 AM – 18:00PM : £400/£350 per week (1-2 years)"
 * The two figures are a with/without-pre-booked-8am-start pair; we take the LOWER as the
 * standard rate (the higher includes the optional early start) and say so in the note.
 */
function adapterDestinyHelpers({ lines }) {
  const fees = [];
  for (const line of lines) {
    const prices = allPence(line);
    if (!prices.length) continue;
    const band = bandFromLabel(line);
    if (band === 'unknown') continue;
    const roomLabel = (/\(([^)]*year[^)]*)\)/i.exec(line) || /:\s*([^:]*years?[^:]*)$/i.exec(line) || [])[1]?.trim()
      || (/(\d+\s*months?\s*to\s*\d+\s*years?)/i.exec(line) || [])[1] || null;

    if (/per day/i.test(line)) {
      const day = Math.min(...prices);
      const half = prices.length > 1 ? Math.max(...prices) : null;
      // "£70 per day/ £45 half day" — the day rate is the FIRST figure, not the smallest.
      const ordered = prices;
      fees.push(feeRow({
        age_band: band, room_label: roomLabel, session_type: 'full_day',
        fee_pence: ordered[0], period: 'day',
        confidence: 'high', needs_review: false,
        source_quote: line.slice(0, 300),
      }));
      if (ordered[1] && /half day/i.test(line)) {
        fees.push(feeRow({
          age_band: band, room_label: roomLabel, session_type: 'half_day',
          fee_pence: ordered[1], period: 'half_day',
          confidence: 'high', needs_review: false,
          source_quote: line.slice(0, 300),
        }));
      }
      continue;
    }

    if (/per week/i.test(line)) {
      // Full-day week vs half-day week — decide from the stated hours in the line.
      const fullDay = /18:00|18\.00|6\s*pm/i.test(line) && /9:00\s*AM|9:00AM|8am/i.test(line) && !/13:00|1\s*pm/i.test(line);
      const std = Math.min(...prices);   // lower of the "£400/£350" pair = without the optional 8am start
      fees.push(feeRow({
        age_band: band, room_label: roomLabel,
        session_type: fullDay ? 'week_5d' : 'week_sessions',
        days_per_week: fullDay ? 5 : null,
        fee_pence: std, period: 'week',
        confidence: fullDay ? 'high' : 'medium',
        needs_review: !fullDay,
        source_quote: line.slice(0, 300),
        parse_note: prices.length > 1
          ? 'Line quotes two figures (with / without the optional pre-booked 8am start); the lower — standard 9am start — is stored.'
          : null,
      }));
      continue;
    }

    if (/per hour/i.test(line)) {
      fees.push(feeRow({
        age_band: band === 'unknown' ? 'mixed' : band, room_label: roomLabel,
        session_type: 'hour', fee_pence: prices[0], period: 'hour',
        confidence: 'medium', source_quote: line.slice(0, 300),
      }));
    }
  }

  // Consumables for funded children — a real cost to a funded parent, worth comparing.
  const cons = lines.find(l => /funded children/i.test(l) && /£/.test(l));
  if (cons) {
    const p = toPence(cons);
    if (p) fees.push(feeRow({
      age_band: 'mixed', session_type: 'consumables', fee_pence: p, period: 'day',
      day_equiv_pence: null, day_equiv_basis: 'consumables charge, not a childcare day rate',
      confidence: 'high', needs_review: false, source_quote: cons.slice(0, 300),
    }));
  }

  return {
    status: fees.length ? 'parsed' : 'low_confidence',
    fees,
    note: fees.length ? `Parsed ${fees.length} price points from admissions prose.` : 'No age-banded prices found in the prose.',
  };
}

/**
 * Little Garden Nursery — fees are a laid-out table inside a PDF
 * (01.Management_Fees_<date>.pdf, linked from the homepage), and the extraction is lossy in
 * two specific, reversible ways: the decimal point and the thousands separator both come out
 * as a run of spaces ("£546  87" is £546.87; "£1  041  68" is £1,041.68).  That much can be
 * decoded safely.
 *
 * What CANNOT be decoded safely is column alignment.  Each block is headed
 * "1 Day 2 Days 3 Days 4 Days 5 Days", but the AM/PM rows print only three figures — and
 * nothing in the text says whether those three are days 1–3 or days 3–5.  So this adapter
 * takes the rows that carry exactly five figures (which map onto 1–5 days unambiguously)
 * and stores everything else as low-confidence raw text for Toby to eyeball.  Guessing which
 * column a three-figure row belongs to is precisely the invented number this module forbids.
 *
 * The PDF also states no weeks-per-year factor, so the monthly figures get NO per-day
 * equivalent — they are comparable to other monthly fees and to nothing else.
 */
async function adapterLittleGarden({ html, url, source }) {
  const pdfUrl = (() => {
    const hits = (String(html).match(/href="([^"]+\.pdf)"/gi) || [])
      .map(h => h.replace(/^href="/i, '').replace(/"$/, ''))
      .filter(u => /management[_-]?fees|fees/i.test(u));
    if (!hits.length) return null;
    try { return new URL(hits[0], url).toString(); } catch { return null; }
  })();

  if (!pdfUrl) {
    return { status: 'not_published', fees: [], note: 'No fees PDF linked from the homepage this run.' };
  }

  const res = await fetchPolitely(pdfUrl, { crawlDelayMs: source.crawl_delay_ms });
  if (!res.ok || !res.buffer) {
    return { status: 'unreachable', fees: [], note: `Fees PDF ${pdfUrl.split('/').pop()} returned HTTP ${res.status}.` };
  }
  const lines = await pdfToLines(res.buffer);
  if (!lines.length) return { status: 'unreachable', fees: [], note: 'Fees PDF fetched but produced no text.' };

  // "£546  87" → 54687 ; "£1  041  68" → 104168.  Last group is pence, the rest are pounds.
  const decode = tok => {
    const parts = tok.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const pence = parts[parts.length - 1];
    if (!/^\d{2}$/.test(pence)) return null;
    const pounds = parts.slice(0, -1).join('');
    if (!/^\d+$/.test(pounds)) return null;
    return parseInt(pounds, 10) * 100 + parseInt(pence, 10);
  };
  const decodeRow = line => line.split('£').slice(1).map(decode).filter(v => v != null);

  const fees = [];
  let band = 'unknown', roomLabel = null, basis = 'standard';
  // The unaligned rows are the evidence Toby actually has to eyeball, and they collide on the
  // (band, label, session_type) uniqueness key — so number them, or 35 rows of raw evidence
  // silently collapse into 8 and the review queue looks far tidier than the PDF really is.
  let rawSeq = 0;
  const effM = /(\d{2})(\d{2})(\d{2})\.pdf$/i.exec(pdfUrl);   // ..._260426.pdf → 2026-04-26
  const eff = effM ? `20${effM[1]}-${effM[2]}-${effM[3]}` : null;

  for (const line of lines) {
    // Section headings inside the PDF name the age group.
    if (/^(Babies|\d+\s*Years?)$/i.test(line.trim())) {
      roomLabel = line.trim();
      band = /babies/i.test(line) ? 'under_2' : bandFromLabel(line.replace(/^(\d+)\s*Years?$/i, '$1 year olds'));
      if (band === 'unknown' && /^2\s*Years?$/i.test(line.trim())) band = '2yo';
      if (band === 'unknown' && /^(3|4)\s*Years?$/i.test(line.trim())) band = '3_4yo';
      continue;
    }
    if (/30\s*Hours/i.test(line)) basis = 'funded_30h';
    else if (/15\s*Hours/i.test(line)) basis = 'funded_15h';
    else if (/No\s*$|No\s*FULL TIME/i.test(line)) basis = 'standard';

    if (!/£/.test(line)) continue;
    const vals = decodeRow(line);
    const termTime = /TERM\s*TIME/i.test(line);
    const fullTime = /FULL\s*TIME/i.test(line);

    if (vals.length === 5 && (fullTime || termTime) && band !== 'unknown') {
      vals.forEach((v, n) => {
        const days = n + 1;                       // header prints 1,2,3,4,5 Days in order
        fees.push(feeRow({
          age_band: band, room_label: `${roomLabel}${termTime ? ' (term-time)' : ' (full year)'}`,
          session_type: `month_${days}d`, days_per_week: days,
          funding_basis: basis, fee_pence: v, period: 'month',
          day_equiv_pence: null,
          day_equiv_basis: 'no per-day equivalent — the PDF states no weeks-per-year factor',
          effective_date: eff,
          confidence: 'medium', needs_review: true,
          source_quote: line.slice(0, 300),
          parse_note: 'Decoded from a PDF table: text extraction turns the decimal point and thousands separator into spaces. Only rows carrying exactly five figures are stored, because the header maps them onto 1–5 days unambiguously. CHECK against the PDF before quoting.',
        }));
      });
      continue;
    }

    if (vals.length && band !== 'unknown') {
      // Everything else — three-figure AM/PM rows, "Extras / Daily Rate" — is kept as raw
      // evidence at low confidence, without asserting which day-count it belongs to.
      fees.push(feeRow({
        age_band: band, room_label: `${roomLabel} — unaligned row ${++rawSeq}`,
        session_type: 'other', funding_basis: basis,
        fee_pence: null, period: null,
        confidence: 'low', needs_review: true,
        effective_date: eff,
        source_quote: line.slice(0, 300),
        raw_excerpt: `decoded figures: ${vals.map(v => '£' + (v / 100).toFixed(2)).join(', ')}`,
        parse_note: 'PDF row whose figures cannot be matched to a day count from the text alone — no fee stored, raw values kept for manual review.',
      }));
    }
  }

  const solid = fees.filter(f => f.fee_pence).length;
  return {
    status: solid ? 'low_confidence' : 'low_confidence',
    fees, effective_date: eff,
    note: `Fees PDF ${pdfUrl.split('/').pop()} read: ${solid} monthly figure(s) decoded from five-column rows, ` +
          `${fees.length - solid} row(s) kept as raw evidence only. All flagged for review — the PDF's table layout ` +
          `does not survive text extraction cleanly.`,
  };
}

/**
 * Ealing Council Family Information Service — the borough's own published guide to what a
 * day nursery costs.  Worth capturing because it is the figure a local parent is most likely
 * to have read, and because it is the only *official* local number available: the FIS
 * provider directory (ealingfamiliesdirectory.org.uk) is a JavaScript app that returns only
 * "Loading..." to a fetch, and its listings carry no fees even when rendered.
 *
 * Stored as a range (low and high) against the council's exact sentence.  Note that the same
 * paragraph still talks about the "Nursery Education Grant", language retired years ago —
 * so the guide is flagged for review rather than trusted as current.
 */
function adapterEalingFis({ lines, url }) {
  const fees = [];
  const line = lines.find(l => /expect to pay/i.test(l) && /£/.test(l));
  if (!line) {
    return { status: 'not_published', fees: [], note: 'Council page no longer carries a published fee guide sentence.' };
  }
  const vals = allPence(line);
  const stale = /nursery education grant/i.test(line);
  const per = /per child per week|per week/i.test(line) ? 'week' : /per day/i.test(line) ? 'day' : null;

  [['low', Math.min(...vals)], ['high', Math.max(...vals)]].forEach(([end, v]) => {
    if (!isFinite(v) || vals.length < 2) return;
    fees.push(feeRow({
      age_band: 'mixed', room_label: `Ealing borough guide (${end} end of range)`,
      session_type: `la_guide_${end}`, fee_pence: v, period: per,
      day_equiv_pence: null,
      day_equiv_basis: 'borough-wide guide range — not a specific provider rate, so not converted to a per-day figure',
      confidence: 'medium', needs_review: true,
      source_quote: line.slice(0, 400),
      parse_note: 'Ealing Council FIS guidance, not a provider price list.' +
        (stale ? ' The same paragraph still refers to the "Nursery Education Grant", a scheme retired years ago — treat the range as dated and check it against Coram before using it as a benchmark.' : ''),
    }));
  });

  return {
    status: fees.length ? 'parsed' : 'low_confidence',
    fees,
    note: fees.length
      ? `Captured Ealing Council's published day-nursery fee range${stale ? ' (page language is dated — flagged)' : ''}.`
      : 'Fee guide sentence found but no range could be read from it.',
  };
}

/**
 * Generic fallback.  Deliberately timid: it only keeps lines that look like a childcare
 * price AND name an age band or a session, and everything it produces is low confidence
 * flagged for review.  Where the local model is reachable it is asked to pull structure
 * out of the same text, but its output is never promoted above 'low' either — an LLM
 * reading a fee table is a suggestion for Toby, not a source of truth.
 */
async function adapterGeneric({ lines, url }) {
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!MONEY_RX.test(line)) continue;
    if (/tax[- ]free|save|up to £|voucher|£2,000|£4,000|per year per child/i.test(line)) continue;  // marketing copy
    if (!/per day|per week|per month|per hour|session|full day|half day|daily|weekly|monthly|year|day\b/i.test(line)
        && bandFromLabel(line) === 'unknown') continue;
    const { band, label } = nearestBandAbove(lines, i);
    const p = toPence(line);
    if (!p) continue;
    const period = /per month|monthly/i.test(line) ? 'month'
                 : /per week|weekly/i.test(line) ? 'week'
                 : /per hour|hourly|ph\b/i.test(line) ? 'hour'
                 : /half day/i.test(line) ? 'half_day'
                 : /per day|full day|daily/i.test(line) ? 'day'
                 : /session/i.test(line) ? 'session' : null;
    candidates.push(feeRow({
      age_band: band, room_label: label, session_type: 'other',
      fee_pence: p, period,
      confidence: 'low', needs_review: true,
      source_quote: line.slice(0, 300),
      raw_excerpt: lines.slice(Math.max(0, i - 3), i + 3).join(' | '),
      parse_note: 'Generic extraction — no site-specific parser matched. Confirm against the page before using.',
    }));
    if (candidates.length >= 40) break;
  }

  if (!candidates.length) {
    return {
      status: 'not_published',
      fees: [],
      note: 'Page fetched successfully but contains no recognisable published fees.',
    };
  }
  return {
    status: 'low_confidence',
    fees: candidates,
    note: `Generic extraction found ${candidates.length} candidate price line(s) — all flagged for manual review.`,
  };
}

const ADAPTERS = {
  monkey_puzzle:   adapterMonkeyPuzzle,
  busy_bees:       adapterBusyBees,
  corner_house:    adapterCornerHouse,
  fielding:        adapterFielding,
  destiny_helpers: adapterDestinyHelpers,
  little_garden:   adapterLittleGarden,
  ealing_fis:      adapterEalingFis,
  generic:         adapterGeneric,
};

// ── one source ───────────────────────────────────────────────────────────────

/**
 * Scrape a single registered source.  Always resolves; a failure is a RESULT
 * ({status:'unreachable', …}) that gets written down, never a thrown error that
 * loses the fact that we tried.
 */
async function scrapeSource(source) {
  const started = Date.now();
  const base = { provider_key: source.provider_key, provider: source.provider_name, url: source.url };

  // A source registered as `gated` is not fetched for prices at all — we already know the
  // answer is behind a form, and re-asking weekly is pointless traffic.
  if (source.method === 'gated') {
    const res = await fetchPolitely(source.url, { crawlDelayMs: source.crawl_delay_ms });
    const lines = res.ok ? htmlToLines(res.text) : [];
    const out = await adapterBusyBees({ lines, url: source.url });
    return { ...base, ...out, http_code: res.status, robots_ok: !res.robotsBlocked, ms: Date.now() - started };
  }

  const res = await fetchPolitely(source.url, { crawlDelayMs: source.crawl_delay_ms });
  if (res.robotsBlocked) {
    return { ...base, status: 'robots_blocked', fees: [], note: 'robots.txt disallows this path — not fetched.',
             http_code: 0, robots_ok: false, ms: Date.now() - started };
  }
  if (!res.ok) {
    return {
      ...base, status: 'unreachable', fees: [],
      note: `Could not read the page: HTTP ${res.status}${res.error ? ' — ' + res.error : ''}. ` +
            (res.status === 403 ? 'The site refuses non-browser clients (WAF). No fee recorded for this run.' : 'No fee recorded for this run.'),
      http_code: res.status, error: res.error || `HTTP ${res.status}`, robots_ok: true, ms: Date.now() - started,
    };
  }

  const isPdf = /pdf/i.test(res.contentType) || /\.pdf($|\?)/i.test(source.url);
  const lines = isPdf ? await pdfToLines(res.buffer) : htmlToLines(res.text);
  if (!lines.length) {
    return { ...base, status: 'unreachable', fees: [], note: 'Fetched, but no readable text (empty or JS-rendered page).',
             http_code: res.status, robots_ok: true, ms: Date.now() - started };
  }

  const adapter = ADAPTERS[source.adapter] || ADAPTERS.generic;
  let out;
  try {
    out = await adapter({ lines, html: res.text, url: source.url, source });
  } catch (e) {
    out = { status: 'low_confidence', fees: [], note: `Adapter "${source.adapter}" threw: ${e.message}. Falling back to review.` };
  }

  // A site-specific adapter that finds nothing falls back to the timid generic pass rather
  // than reporting a clean "no fees" — a layout change must surface as review, not silence.
  if ((!out.fees || !out.fees.length) && source.adapter !== 'generic' && out.status !== 'gated') {
    const fb = await adapterGeneric({ lines, url: source.url });
    out = {
      status: fb.fees.length ? 'low_confidence' : out.status,
      fees: fb.fees,
      note: `${out.note || ''} Site-specific parser matched nothing — generic fallback: ${fb.note}`.trim(),
      effective_date: out.effective_date,
    };
  }

  return { ...base, ...out, http_code: res.status, robots_ok: true, ms: Date.now() - started };
}

// ── the weekly run ───────────────────────────────────────────────────────────

/**
 * Scrape every active source and write one competitor_fee_runs row plus the fees.
 * Called by the existing weekly competitor-refresh cron and by the Roost "Scrape now"
 * button.  Sources are done one at a time — the point is a courteous weekly read, not speed.
 */
async function runFeeScrape({ triggeredBy = 'cron', onlyKey = null } = {}) {
  const db = getPool();

  const { rows: sources } = await db.query(
    `SELECT * FROM competitor_fee_sources
     WHERE active = true ${onlyKey ? 'AND provider_key = $1' : ''}
     ORDER BY id`, onlyKey ? [onlyKey] : []);

  const { rows: [run] } = await db.query(
    `INSERT INTO competitor_fee_runs (triggered_by, sources_total) VALUES ($1,$2) RETURNING *`,
    [triggeredBy, sources.length]);

  let parsed = 0, low = 0, unreadable = 0, written = 0;
  const summary = [];

  for (const source of sources) {
    const r = await scrapeSource(source);

    if (r.status === 'parsed') parsed++;
    else if (r.status === 'low_confidence') low++;
    else unreadable++;                       // gated | unreachable | robots_blocked | not_published

    for (const f of (r.fees || [])) {
      const effective = f.effective_date || r.effective_date || null;
      try {
        await db.query(`
          INSERT INTO competitor_fees
            (run_id, competitor_id, provider_key, provider, url, age_band, room_label, session_type,
             days_per_week, funding_basis, fee_pence, period, day_equiv_pence, day_equiv_basis,
             effective_date, source_quote, raw_excerpt, confidence, needs_review, parse_note)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (run_id, provider_key, COALESCE(age_band,''), COALESCE(room_label,''),
                       COALESCE(session_type,''), COALESCE(days_per_week, -1), COALESCE(funding_basis,''))
          DO UPDATE SET fee_pence = EXCLUDED.fee_pence, source_quote = EXCLUDED.source_quote,
                        day_equiv_pence = EXCLUDED.day_equiv_pence, scraped_at = now()`,
          [run.id, source.competitor_id, source.provider_key, source.provider_name, source.url,
           f.age_band, f.room_label, f.session_type, f.days_per_week, f.funding_basis,
           f.fee_pence, f.period, f.day_equiv_pence, f.day_equiv_basis,
           effective, f.source_quote, f.raw_excerpt, f.confidence, f.needs_review, f.parse_note]);
        written++;
      } catch (e) {
        // A single bad row must not lose the rest of the run.
        console.error(`[b203] fee insert failed (${source.provider_key}):`, e.message);
      }
    }

    await db.query(
      `UPDATE competitor_fee_sources
         SET last_status=$2, last_checked_at=now(), last_http_code=$3, last_error=$4,
             robots_ok=$5, updated_at=now()
       WHERE id=$1`,
      [source.id, r.status, r.http_code || null, r.error || null, r.robots_ok ?? null]);

    summary.push({
      provider_key: source.provider_key, provider: source.provider_name,
      status: r.status, fees: (r.fees || []).length, http: r.http_code, note: r.note, ms: r.ms,
    });
    console.log(`[b203] ${source.provider_key}: ${r.status} (${(r.fees || []).length} fees, HTTP ${r.http_code}) — ${r.note || ''}`);
  }

  await db.query(
    `UPDATE competitor_fee_runs
       SET finished_at=now(), sources_parsed=$2, sources_low=$3, sources_unreadable=$4,
           fees_written=$5, summary=$6
     WHERE id=$1`,
    [run.id, parsed, low, unreadable, written, JSON.stringify(summary)]);

  return { run_id: run.id, sources: sources.length, parsed, low_confidence: low, unreadable, fees_written: written, summary };
}

module.exports = {
  runFeeScrape, scrapeSource,
  // exported for tests / reuse
  htmlToLines, pdfToLines, toPence, allPence, bandFromLabel, toDayEquivalent, feeRow,
  fetchPolitely, robotsFor, USER_AGENT, ADAPTERS,
};
