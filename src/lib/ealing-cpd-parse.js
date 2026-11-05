'use strict';
// ════════════════════════════════════════════════════════════════════════════
// b322 — reading Ealing's training emails.  2026-09-11.
//
// Pure functions: no DB, no network, no side effects.  Give it an email, get
// back courses.  That is deliberate — it means the whole recogniser is testable
// against saved fixtures without a mailbox, a poller or a container.
//
// ── WHY THE EMAILS AND NOT THE WEBSITE ──────────────────────────────────────
// ealingcpd.org.uk publishes the programme but exposes no RSS, no iCal and no
// API, and booking sits behind a login.  Checked 2026-09-11.  The emails are
// therefore the only machine-readable source we are entitled to read, so this
// file is the integration.
//
// ── THE TRAP THAT SHAPES THIS FILE ──────────────────────────────────────────
// Ealing send through Mimecast, and Mimecast replaces the text/plain part with
// its own stationery boilerplate.  Every one of the 21 Ealing emails in the
// queue on 2026-09-11 had a body_text of exactly 1137 bytes reading "Mimecast
// Stationery, This example text is used to illustrate an email message…".
// The real message is only ever in body_html.
//
//   A parser written against body_text would find nothing, every time, and
//   would look like a recogniser that simply never matched.
//
// So: html is the source, text is ignored, and anything that looks like the
// Mimecast placeholder is discarded outright (isMimecastStationery).
//
// ── THREE SHAPES, MEASURED FROM REAL MAIL ───────────────────────────────────
//   1. PROGRAMME TABLE — "Ealing Early Training Programme 2026–2027".  An HTML
//      table, columns Event Code | Name | Date | Venue.  43 courses in one
//      email.  This is the bulk of the catalogue and it parses deterministically.
//   2. SINGLE ANNOUNCEMENT — "EYFS Transition Conference 2026".  Prose, no
//      event code, but a booking link https://ealingcpd.org.uk/Event/297380
//      plus Date:/Time:/Venue: lines.  The Event id is the dedupe key when
//      there is no course code.
//   3. NOT A COURSE — "No Subscription Required – Free Training… 2026-2027" is
//      an offer/brochure email.  It mentions training throughout and contains
//      zero bookable courses.  It must yield nothing, and there is a fixture
//      test for exactly that.
//
// ── NO MODEL ────────────────────────────────────────────────────────────────
// There is no LLM in this path.  A table of codes and dates is arithmetic, not
// judgement, and a local model that hallucinated a date would put a staff
// member on the wrong day.  Where the deterministic pass is unsure it sets
// needs_review rather than guessing — see confidenceOf().
// ════════════════════════════════════════════════════════════════════════════

// The senders.  Ealing's early-years team writes from several boxes on
// ealing.gov.uk (children@, earlyyearspartnership@, trainingsupport@,
// earlyyearsfunding@) — all measured from the live queue — and the CPD platform
// itself may write from ealingcpd.org.uk.
const SENDER_DOMAINS = ['ealing.gov.uk', 'ealingcpd.org.uk', 'ealingcpd.com', 'egfl.org.uk'];

// The booking platform.  A link to it is the strongest single signal that an
// email is about a bookable course rather than a funding deadline.
const CPD_HOST_RE = /ealingcpd\.org\.uk/i;
const EVENT_URL_RE = /https?:\/\/(?:www\.)?ealingcpd\.org\.uk\/Event\/(\d{3,9})/ig;

// Ealing's course codes.  Two published forms, both supported:
//   EY-0926-T004   (month-year batch — the 2026-27 programme table)
//   EY-EL-T034     (subject batch — the form quoted in Toby's brief)
// Anchored on the EY- prefix on purpose.  A looser pattern matched postcodes
// and phone numbers in the footer of the same emails.
const COURSE_CODE_RE = /\bEY-[A-Z0-9]{2,8}-[A-Z]?\d{2,4}\b/i;
const COURSE_CODE_RE_G = /\bEY-[A-Z0-9]{2,8}-[A-Z]?\d{2,4}\b/ig;

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

// ── html → text ─────────────────────────────────────────────────────────────

/**
 * Flatten Outlook/Mimecast HTML to readable text.
 *
 * Order matters and is not cosmetic: <style> blocks in Outlook mail are huge
 * (the 2026-27 programme email carries ~2KB of mso- font definitions) and if
 * tags are stripped before the style block is removed, every CSS rule lands in
 * the body text and the date regexes start matching things like "margin:0cm".
 */
function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    // Keep the href — the booking link is data, not decoration.
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (m, href, txt) => `${txt.replace(/<[^>]*>/g, '')} <${href}> `)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' │ ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (m, d) => {
      const n = parseInt(d, 10);
      return (n >= 32 && n < 0x10000) ? String.fromCharCode(n) : ' ';
    })
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text of one table cell, with <sup> ordinals repaired. */
function cellText(cellHtml) {
  return normaliseOrdinals(stripHtml(cellHtml)).replace(/\s*│\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * "1<sup>st</sup> July" flattens to "1 st July", which no date parser will
 * match.  Rejoin the ordinal to its number, then drop the suffix.
 */
function normaliseOrdinals(text) {
  return String(text || '').replace(/(\d{1,2})\s*(st|nd|rd|th)\b/gi, '$1');
}

/** True for the Mimecast stationery placeholder that replaces every text part. */
function isMimecastStationery(text) {
  const t = String(text || '');
  return /Mimecast Stationery/i.test(t) && /This example text is used to illustrate/i.test(t);
}

/** The legal footer Mimecast appends — never course content, always trimmed. */
function stripMimecastFooter(text) {
  return String(text || '')
    .replace(/\*{10,}[\s\S]*$/m, '')
    .replace(/Please consider the environment before printing[\s\S]*$/i, '')
    .trim();
}

// ── dates and times ─────────────────────────────────────────────────────────

function ymd(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31) || !(y >= 2000 && y <= 2100)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects 31 February and friends: the Date would roll into March.
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Every date in a string, in order, de-duplicated.
 *
 * Handles the three forms Ealing actually send:
 *   "18 September 2026"                  → one date
 *   "18 & 19 September 2026"             → two dates, shared month/year
 *   "12/10/2026"                         → UK day-first
 * and the "Wednesday 1st July 2026" form once normaliseOrdinals has run.
 */
function parseDates(text) {
  const s = normaliseOrdinals(String(text || ''));
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };

  // Day lists sharing one month+year: "18 & 19 September 2026", "5, 12 and 19 May 2027".
  const listRe = /\b((?:\d{1,2}\s*(?:,|&|and|\/)\s*)+\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/ig;
  let m;
  while ((m = listRe.exec(s)) !== null) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) continue;
    const year = parseInt(m[3], 10);
    for (const dayStr of m[1].split(/\s*(?:,|&|and|\/)\s*/)) {
      push(ymd(year, month, parseInt(dayStr, 10)));
    }
  }

  // "18 September 2026"
  const dmy = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/ig;
  while ((m = dmy.exec(s)) !== null) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) push(ymd(parseInt(m[3], 10), month, parseInt(m[1], 10)));
  }

  // "September 18, 2026" — rarer, but cheap to support.
  const mdy = /\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/ig;
  while ((m = mdy.exec(s)) !== null) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month) push(ymd(parseInt(m[3], 10), month, parseInt(m[2], 10)));
  }

  // "12/10/2026" — UK order, day first.  Never assume US order on UK council mail.
  const slash = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
  while ((m = slash.exec(s)) !== null) {
    push(ymd(parseInt(m[3], 10), parseInt(m[2], 10), parseInt(m[1], 10)));
  }

  return out.sort();
}

/**
 * A start/end time pair.  "09:15 – 15:30", "9.30am - 12pm", "9:30am to 12:00pm".
 * Returns { start_time, end_time } as HH:MM, or nulls when nothing parses —
 * never a guessed default, because "we don't know the time" and "it starts at
 * 09:00" are different things to a manager checking cover.
 */
function parseTimeRange(text) {
  const s = String(text || '');
  const re = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i;
  const m = re.exec(s);
  if (!m) return { start_time: null, end_time: null };

  const to24 = (hh, mm, ap, siblingAp) => {
    let h = parseInt(hh, 10);
    const min = mm ? parseInt(mm, 10) : 0;
    if (h > 23 || min > 59) return null;
    // "9.30am – 12pm": the meridiem may only be on one side. Borrow it, but only
    // to disambiguate a bare hour ≤ 12.
    const ap2 = (ap || siblingAp || '').toLowerCase();
    if (ap2 === 'pm' && h < 12) h += 12;
    if (ap2 === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };

  const start = to24(m[1], m[2], m[3], m[6]);
  const end = to24(m[4], m[5], m[6], m[3]);
  if (!start || !end) return { start_time: null, end_time: null };
  // An end before the start means we matched something that was not a time
  // range (a date range, a page number). Better to report nothing.
  if (end <= start) return { start_time: start, end_time: null };
  return { start_time: start, end_time: end };
}

// ── venue, price, parts ─────────────────────────────────────────────────────

/**
 * online | in_person | hybrid | null.
 * Ealing write "Online, via MS Teams" or a physical venue name; hybrid is rare
 * but stated explicitly when it happens.
 */
function deliveryModeOf(venue, extra) {
  // The venue cell decides on its own whenever there IS one. Passing the whole
  // email body in as a tie-breaker made every course 'hybrid': a programme email
  // naturally names both "Online, via MS Teams" and "Ealing Education Centre"
  // somewhere, so the body always matched both tests. `extra` is only consulted
  // when the course itself states no venue at all.
  const src = String(venue || '').trim() || String(extra || '');
  const s = src.toLowerCase();
  const online = /\b(online|virtual|ms teams|microsoft teams|zoom|webinar|remote|via teams)\b/.test(s);
  const inPerson = /\b(centre|center|hall|school|club|hotel|venue|isleworth|education centre)\b/.test(s);
  if (online && inPerson) return 'hybrid';
  if (online) return 'online';
  if (inPerson) return 'in_person';
  return null;
}

/**
 * Price.  Returns { price_text, price_pence, is_free }.
 *
 * is_free is only ever true on an explicit statement of free-ness. The 2026-27
 * programme says "FREE training" and "The subscription model has been removed",
 * but a setting outside the Quality Partnership pays (£260 was the figure on the
 * site on 2026-09-11), so silence is recorded as "not stated" — never as free.
 */
function parsePrice(text) {
  const s = String(text || '');
  const money = /£\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/.exec(s);
  if (money) {
    const pence = Math.round(parseFloat(money[1].replace(/,/g, '')) * 100);
    return { price_text: `£${money[1]}`, price_pence: Number.isFinite(pence) ? pence : null, is_free: pence === 0, price_note: null };
  }
  if (FREE_RE.test(s)) {
    return { price_text: 'Free', price_pence: 0, is_free: true, price_note: null };
  }
  return { price_text: null, price_pence: null, is_free: null, price_note: null };
}

const FREE_RE = /\b(free of charge|no charge|free training|is free|are free|at no cost|fully funded|no subscription required|FREE)\b/;

/**
 * Price from a WHOLE email body — deliberately far more cautious than
 * parsePrice() on a single cell, and the reason is a real bug this caught.
 *
 * The 2026-27 programme email says "FREE training" about the catalogue AND
 * quotes "£500 for a half-day session", "£900 for a full-day", "£400 per visit"
 * about a completely separate bespoke-INSET offer further down the same email.
 * A first-match-wins scan stamped £500 onto all 43 free courses.
 *
 * There is no reliable way to attribute a figure to a course from document
 * order, so when an email carries both kinds of statement this reports NOTHING
 * and keeps a short quote for the manager. "Not stated — check on Ealing CPD
 * Online" is a true sentence; "£500" was a false one, and price is never what
 * a staff member is deciding on anyway — the manager does the booking.
 */
function parseBodyPrice(text) {
  const s = String(text || '');
  const monies = [...s.matchAll(/£\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g)].map(m => m[1]);
  const distinct = [...new Set(monies)];
  const saysFree = FREE_RE.test(s);

  if (saysFree && !distinct.length) return { price_text: 'Free', price_pence: 0, is_free: true, price_note: null };
  if (!saysFree && distinct.length === 1) {
    const pence = Math.round(parseFloat(distinct[0].replace(/,/g, '')) * 100);
    return { price_text: `£${distinct[0]}`, price_pence: Number.isFinite(pence) ? pence : null, is_free: pence === 0, price_note: null };
  }
  if (!saysFree && !distinct.length) return { price_text: null, price_pence: null, is_free: null, price_note: null };

  // Ambiguous: several figures, or a free claim sitting alongside figures.
  const note = saysFree
    ? `Email mentions free training and also ${distinct.map(d => '£' + d).join(', ')} — confirm on Ealing CPD Online.`
    : `Email mentions ${distinct.map(d => '£' + d).join(', ')} — confirm which applies on Ealing CPD Online.`;
  return { price_text: null, price_pence: null, is_free: null, price_note: note.slice(0, 300) };
}

/** "(5-PART PROGRAMME)" / "2 part course" → 5 / 2.  null when single-session. */
function partsOf(title) {
  const m = /\((\d{1,2})[-\s]?part\b/i.exec(String(title || ''))
         || /\b(\d{1,2})[-\s]?part\s+(?:course|programme|program|series)\b/i.exec(String(title || ''));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Course titles arrive SHOUTED in the programme table
 * ("INTRODUCTION TO SAFEGUARDING / CHILD PROTECTION TRAINING"). Title-case them
 * for the catalogue, but leave any title that already has mixed case alone —
 * re-casing "EYFS Transition Conference" would produce "Eyfs".
 */
// Acronyms that must survive title-casing, keyed by their UPPERCASE form so the
// canonical spelling wins — 'DSLS' is the lookup, 'DSLs' is what gets printed.
const KEEP_UPPER = new Map([
  ['EY', 'EY'], ['EYFS', 'EYFS'], ['SEND', 'SEND'], ['DSL', 'DSL'], ['DSLS', 'DSLs'],
  ['PVI', 'PVI'], ['SEN', 'SEN'], ['SENCO', 'SENCO'], ['CPD', 'CPD'], ['DBS', 'DBS'],
  ['LA', 'LA'], ['MS', 'MS'], ['UK', 'UK'], ['NHS', 'NHS'], ['SALT', 'SALT'],
  ['ICT', 'ICT'], ['EAL', 'EAL'], ['QA', 'QA'], ['AM', 'AM'], ['PM', 'PM'],
  ['ELSA', 'ELSA'], ['LGBT', 'LGBT'], ['ASD', 'ASD'], ['ADHD', 'ADHD'],
]);
// Small words stay lowercase mid-title. Without this the table's shouted titles
// come back as "Safeguarding Lightening Briefing For PVI Leaders And DSLs".
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'via', 'with']);
function tidyTitle(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // "Shouty" is a ratio, not an absolute. The real table contains
  // "SAFEGUARDING LIGHTENING BRIEFING FOR PVI LEADERS AND DSLs" — the two
  // lowercase letters in "DSLs" made an /^[^a-z]*$/ test call it mixed-case and
  // leave the whole title shouting.
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (!letters) return t;
  const upperRatio = (letters.replace(/[^A-Z]/g, '').length) / letters.length;
  if (upperRatio < 0.8) return t;               // genuinely mixed case → leave it
  return t.split(' ').map((w, i) => {
    const bare = w.replace(/[^A-Za-z]/g, '');
    if (KEEP_UPPER.has(bare.toUpperCase()) && bare.length <= 6) {
      return w.replace(bare, KEEP_UPPER.get(bare.toUpperCase()));
    }
    if (/^\d/.test(w)) return w.toLowerCase();   // "5-PART" → "5-part"
    if (i > 0 && SMALL_WORDS.has(bare.toLowerCase())) return w.toLowerCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

// ── table extraction ────────────────────────────────────────────────────────

/**
 * Every <tr> in the document as an array of cell strings.
 *
 * Rows are pulled flat rather than per-<table> on purpose: Outlook nests tables
 * for layout, and a nesting-aware matcher is both harder and less useful — an
 * inner table's rows are still rows, and headerless rows are ignored later
 * anyway.
 */
function extractRows(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) cells.push(cellText(c[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/**
 * Which column is which, from a header row.  Returns null when this row is not
 * a header.  Matching is on meaning, not position, so Ealing reordering the
 * columns next year does not silently shift every date into the venue field.
 */
function headerMap(cells) {
  const idx = { code: -1, title: -1, date: -1, venue: -1, time: -1, price: -1 };
  cells.forEach((cell, i) => {
    const c = cell.toLowerCase();
    if (idx.code < 0 && /\b(event|course|programme)?\s*code\b/.test(c)) idx.code = i;
    else if (idx.title < 0 && /\b(name|title|course|event|training|session)\b/.test(c)) idx.title = i;
    else if (idx.date < 0 && /\b(date|when|day)s?\b/.test(c)) idx.date = i;
    else if (idx.time < 0 && /\b(time|start)s?\b/.test(c)) idx.time = i;
    else if (idx.venue < 0 && /\b(venue|location|where|delivery|format)\b/.test(c)) idx.venue = i;
    else if (idx.price < 0 && /\b(cost|price|fee|charge)s?\b/.test(c)) idx.price = i;
  });
  // A header is only a header if it names a title AND a date. "Code" alone
  // appears in unrelated layout tables.
  return (idx.title >= 0 && idx.date >= 0) ? idx : null;
}

// ── the two parsers ─────────────────────────────────────────────────────────

/** Shape 1: the programme table. */
function parseProgrammeTable(html, ctx) {
  const rows = extractRows(html);
  const found = [];
  let map = null;

  for (const cells of rows) {
    const asHeader = headerMap(cells);
    if (asHeader) { map = asHeader; continue; }
    if (!map) continue;

    const get = (i) => (i >= 0 && i < cells.length ? cells[i] : '');
    const title = get(map.title);
    const dateCell = get(map.date);
    const dates = parseDates(dateCell);
    if (!title || !dates.length) continue;
    // A row whose "title" is itself a date or a code is a stray layout row.
    if (!/[A-Za-z]{3}/.test(title)) continue;

    const codeCell = get(map.code);
    const codeMatch = COURSE_CODE_RE.exec(codeCell) || COURSE_CODE_RE.exec(title);
    const venue = get(map.venue);
    const times = parseTimeRange(get(map.time) || dateCell);
    const price = get(map.price) ? parsePrice(get(map.price)) : ctx.bodyPrice;

    found.push(buildCourse({
      course_code: codeMatch ? codeMatch[0].toUpperCase() : null,
      title,
      dates,
      venue,
      times,
      price,
      booking_url: ctx.eventUrlFor(codeMatch ? codeMatch[0] : null) || ctx.defaultBookingUrl,
      source: 'programme_table',
      ctx,
    }));
  }
  return found;
}

/**
 * Shape 2: a single-course announcement in prose.
 *
 * Requires a booking link to the CPD platform. Without one there is nothing to
 * distinguish "come to our conference on 1 July" from "submit your claims by
 * 24 July", and the funding-deadline emails outnumber the course ones.
 */
function parseAnnouncement(text, html, ctx) {
  if (!ctx.eventUrls.length) return [];

  const dates = parseDates(fieldValue(text, 'date') || text);
  if (!dates.length) return [];

  const title = announcementTitle(text, ctx);
  if (!title) return [];

  const venue = fieldValue(text, 'venue') || fieldValue(text, 'location') || '';
  const times = parseTimeRange(fieldValue(text, 'time') || text);
  const deadline = parseDates(fieldValue(text, 'book(?:ing)? by|deadline|closing date') || '')[0] || null;

  return [buildCourse({
    course_code: (COURSE_CODE_RE.exec(text) || [null])[0],
    title,
    dates,
    venue,
    times,
    price: ctx.bodyPrice,
    booking_url: ctx.eventUrls[0].url,
    event_ref: ctx.eventUrls[0].id,
    booking_deadline: deadline,
    source: 'announcement',
    ctx,
  })];
}

/** "Date: Wednesday 1 July 2026" → "Wednesday 1 July 2026". */
function fieldValue(text, label) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:${label})\\s*[:\\u2502-]\\s*([^\\n]{1,160})`, 'i');
  const m = re.exec(String(text || ''));
  return m ? m[1].trim() : null;
}

/**
 * The course name in a prose email.  The subject is usually right but carries
 * "Reminder:" / "Final reminder:" / "**NEW**" noise, so strip that first, then
 * prefer a quoted title from the body when one is present.
 */
function announcementTitle(text, ctx) {
  const quoted = /[“"']([^”"']{12,120})[”"']/.exec(text);
  let subject = String(ctx.subject || '')
    .replace(/^\s*(\*+\s*NEW\s*\*+|RE|FW|FWD)\s*:?\s*/i, '')
    .replace(/^\s*(final\s+)?reminder\s*[:–-]\s*/i, '')
    .replace(/^\s*important\s+update\s*[:–-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Drop a trailing " - Wednesday 1st July 2026" from the subject: the date is
  // captured properly elsewhere and repeating it in the name reads badly in a
  // catalogue sorted by date.
  subject = subject.replace(/\s*[-–—]\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+\d{1,2}.*$/i, '').trim();
  if (subject.length >= 8) {
    // Splice in the quoted strapline when the subject already references it.
    return subject.slice(0, 220);
  }
  return quoted ? quoted[1].trim().slice(0, 220) : null;
}

function buildCourse(o) {
  const dates = (o.dates || []).filter(Boolean).sort();
  const venue = String(o.venue || '').replace(/\s+/g, ' ').trim() || null;
  const price = o.price || { price_text: null, price_pence: null, is_free: null };
  return {
    course_code: o.course_code ? String(o.course_code).toUpperCase() : null,
    event_ref: o.event_ref || null,
    title: tidyTitle(o.title).slice(0, 300),
    raw_title: String(o.title || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    provider: 'Ealing CPD Online',
    venue,
    delivery_mode: deliveryModeOf(venue, o.ctx && o.ctx.bodyText),
    start_time: o.times ? o.times.start_time : null,
    end_time: o.times ? o.times.end_time : null,
    price_text: price.price_text,
    price_pence: price.price_pence,
    is_free: price.is_free,
    // Carried through deliberately. When parseBodyPrice() refuses to attribute a
    // figure it explains WHY here, and that sentence is the only thing standing
    // between "price not stated" and a manager assuming the course is free.
    price_note: price.price_note || null,
    parts_total: partsOf(o.title),
    dates,
    first_date: dates[0] || null,
    last_date: dates[dates.length - 1] || null,
    booking_deadline: o.booking_deadline || null,
    booking_url: o.booking_url || null,
    source_url: (o.ctx && o.ctx.defaultBookingUrl) || 'https://ealingcpd.org.uk',
    extraction: o.source,
  };
}

/**
 * How much to trust a row.  Anything below 'high' is stored with needs_review
 * set, so a manager confirms before staff act on it.  Nothing is discarded for
 * low confidence — a course we half-read is still a course somebody should see.
 */
function confidenceOf(course) {
  if (course.extraction === 'programme_table' && course.course_code && course.first_date) return 'high';
  if (course.extraction === 'programme_table' && course.first_date) return 'medium';
  if (course.extraction === 'announcement' && course.event_ref && course.first_date) return 'medium';
  return 'low';
}

// ── the public entry point ──────────────────────────────────────────────────

/**
 * Is this email from Ealing's early-years training channel at all?
 * Cheap, runs before any parsing, and is the only thing the poller hook calls
 * on the 99% of mail that has nothing to do with CPD.
 */
function isEalingCpdEmail(msg) {
  const from = String((msg && (msg.fromEmail || msg.from_email)) || '').toLowerCase();
  const domain = from.split('@')[1] || '';
  // Anchored on the domain boundary: example-nursery*.co.uk is our own
  // address and matched a naive substring test on 329 of 1,061 queued emails.
  const senderOk = SENDER_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
  const html = String((msg && (msg.bodyHtml || msg.body_html)) || '');
  const linkOk = CPD_HOST_RE.test(html) || CPD_HOST_RE.test(String((msg && msg.subject) || ''));
  return senderOk || linkOk;
}

/**
 * Parse one email into courses.
 *
 * @param {{fromEmail?:string, from_email?:string, subject?:string,
 *          bodyHtml?:string, body_html?:string, bodyText?:string,
 *          body_text?:string, receivedAt?:string}} msg
 * @returns {{ok:boolean, reason:string, courses:Array, extraction:string}}
 */
function parseEmail(msg) {
  const m = msg || {};
  const html = String(m.bodyHtml || m.body_html || '');
  const rawText = String(m.bodyText || m.body_text || '');
  const subject = String(m.subject || '');

  if (!isEalingCpdEmail(m)) return { ok: false, reason: 'not_ealing', courses: [], extraction: 'none' };

  // body_text is Mimecast's placeholder on every real Ealing email — see the
  // header note. Fall back to it only when it is genuinely the message.
  const text = stripMimecastFooter(
    html ? stripHtml(html) : (isMimecastStationery(rawText) ? '' : rawText)
  );
  if (!text) return { ok: false, reason: 'empty_body', courses: [], extraction: 'none' };

  // Booking links, indexed so a table row's code can be matched to its own link
  // when the email provides per-course links.
  const eventUrls = [];
  EVENT_URL_RE.lastIndex = 0;
  let em;
  while ((em = EVENT_URL_RE.exec(html || text)) !== null) {
    if (!eventUrls.some(e => e.id === em[1])) eventUrls.push({ id: em[1], url: em[0] });
  }

  const ctx = {
    subject,
    bodyText: text,
    eventUrls,
    defaultBookingUrl: eventUrls.length === 1 ? eventUrls[0].url : 'https://ealingcpd.org.uk',
    bodyPrice: parseBodyPrice(text),
    // Only meaningful when an email gives one link per course; the 2026-27
    // programme gives a single site link, so this returns null and the default
    // is used.
    eventUrlFor: () => null,
  };

  let courses = parseProgrammeTable(html, ctx);
  let extraction = 'programme_table';
  if (!courses.length) {
    courses = parseAnnouncement(text, html, ctx);
    extraction = courses.length ? 'announcement' : 'none';
  }

  // Dedupe within the single email. The 2026-27 programme lists the same
  // safeguarding briefing four times on four dates with four codes, which is
  // four courses — but a code repeated with the same date is one row rendered
  // twice by Outlook, and that must collapse.
  const seen = new Map();
  for (const c of courses) {
    const key = dedupeKey(c);
    if (!seen.has(key)) { c.confidence = confidenceOf(c); seen.set(key, c); }
  }
  const list = [...seen.values()];

  if (!list.length) return { ok: false, reason: 'no_courses_found', courses: [], extraction: 'none' };
  return { ok: true, reason: 'ok', courses: list, extraction };
}

/**
 * The identity of a course across emails.
 *
 * Course code first — that is Toby's stated rule and Ealing's own identifier.
 * Then the platform's Event id. Only when neither exists do we fall back to
 * title+date, which is why a re-sent reminder for the Transition Conference
 * collapses onto the original rather than creating a second row.
 */
function dedupeKey(c) {
  if (c.course_code) return `code:${c.course_code}`;
  if (c.event_ref) return `event:${c.event_ref}`;
  return `t:${c.title.toLowerCase().replace(/[^a-z0-9]+/g, '')}|${c.first_date || ''}`;
}

module.exports = {
  parseEmail, isEalingCpdEmail, dedupeKey,
  // exported for tests and for the rescan tool
  stripHtml, parseDates, parseTimeRange, parsePrice, parseBodyPrice, partsOf, tidyTitle,
  deliveryModeOf, extractRows, headerMap, normaliseOrdinals,
  isMimecastStationery, stripMimecastFooter, confidenceOf,
  SENDER_DOMAINS, COURSE_CODE_RE_G,
};
