'use strict';

// RFC 5545 §3.6.5 VTIMEZONE for Europe/London (GMT winter / BST summer)
const VTIMEZONE_LONDON = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/London',
  'X-LIC-LOCATION:Europe/London',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0000',
  'TZOFFSETTO:+0100',
  'TZNAME:BST',
  'DTSTART:19700329T010000',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0000',
  'TZNAME:GMT',
  'DTSTART:19701025T020000',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'END:VTIMEZONE',
];

// Escape TEXT values per RFC 5545 §3.3.11
function escapeText(val) {
  return String(val || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545 line folding: max 75 octets per line; continuation lines start with a space.
// We work in characters here (safe for typical school content).
function foldLine(line) {
  const MAX = 75;
  if (line.length <= MAX) return line;
  const parts = [];
  parts.push(line.slice(0, MAX));
  let remaining = line.slice(MAX);
  while (remaining.length > 0) {
    parts.push(' ' + remaining.slice(0, MAX - 1));
    remaining = remaining.slice(MAX - 1);
  }
  return parts.join('\r\n');
}

// Format a Date as UTC timestamp: 20260512T143022Z  (used for DTSTAMP)
function fmtUtcStamp(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
         `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// Parse a dtstart/dtend value into an iCal-ready string.
//   Date object  → uses local-time getters (assumes container TZ = UTC, caller built the time in UTC = London local)
//   "YYYY-MM-DD" → all-day date
//   "YYYY-MM-DDTHH:MM:SS" or "YYYY-MM-DDTHH:MM" → datetime (London local)
// Returns { icsVal, isAllDay } where icsVal is e.g. "20260912" or "20260912T090000"
function parseEventDate(val) {
  if (!val) return null;

  if (val instanceof Date) {
    const pad = n => String(n).padStart(2, '0');
    const y = val.getFullYear(), m = val.getMonth() + 1, d = val.getDate();
    const h = val.getHours(), mi = val.getMinutes(), s = val.getSeconds();
    const hasTime = h || mi || s;
    const dateStr = `${y}${pad(m)}${pad(d)}`;
    if (!hasTime) return { icsVal: dateStr, isAllDay: true };
    return { icsVal: `${dateStr}T${pad(h)}${pad(mi)}${pad(s)}`, isAllDay: false };
  }

  const str = String(val).trim();
  if (str.includes('T')) {
    // datetime string — strip separators
    const [datePart, timePart] = str.split('T');
    const d = datePart.replace(/-/g, '');
    const t = timePart.replace(/:/g, '').slice(0, 6).padEnd(6, '0');
    return { icsVal: `${d}T${t}`, isAllDay: false };
  }
  // date-only string
  return { icsVal: str.slice(0, 10).replace(/-/g, ''), isAllDay: true };
}

/**
 * Build an RFC 5545 iCalendar string.
 *
 * @param {object} opts
 * @param {string}   opts.name         - Calendar display name (X-WR-CALNAME)
 * @param {string}  [opts.description] - Calendar description (X-WR-CALDESC)
 * @param {object[]} opts.events       - Array of event objects:
 *   {
 *     uid:         string,           // globally unique — e.g. "lesson-42-2026-09-12@wren"
 *     summary:     string,           // event title
 *     description?: string,          // optional body text
 *     location?:   string,           // optional room / place
 *     dtstart:     Date | string,    // all-day: "YYYY-MM-DD"; timed: "YYYY-MM-DDTHH:MM:SS"
 *     dtend?:      Date | string,    // optional end (exclusive for all-day, inclusive-end for timed)
 *     allDay:      boolean,          // true → VALUE=DATE; false → TZID=Europe/London datetime
 *   }
 *
 * @returns {string} iCal text with CRLF line endings.
 */
function buildCalendar({ name, description, events = [] }) {
  const dtstamp = fmtUtcStamp(new Date());
  const hasTimed = events.some(e => !e.allDay);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Wren//Wren School MIS 1.0//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'X-WR-TIMEZONE:Europe/London',
  ];
  if (description) lines.push(`X-WR-CALDESC:${escapeText(description)}`);

  if (hasTimed) lines.push(...VTIMEZONE_LONDON);

  for (const ev of events) {
    const start = parseEventDate(ev.dtstart);
    if (!start) continue;
    const end = ev.dtend ? parseEventDate(ev.dtend) : null;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${dtstamp}`);

    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${start.icsVal}`);
      // RFC 5545: DTEND for all-day is the exclusive end date (day after last day)
      if (end && end.icsVal !== start.icsVal) {
        lines.push(`DTEND;VALUE=DATE:${end.icsVal}`);
      }
    } else {
      lines.push(`DTSTART;TZID=Europe/London:${start.icsVal}`);
      if (end) lines.push(`DTEND;TZID=Europe/London:${end.icsVal}`);
    }

    lines.push(`SUMMARY:${escapeText(ev.summary)}`);
    if (ev.description) {
      lines.push(`DESCRIPTION:${escapeText(String(ev.description).slice(0, 500))}`);
    }
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return lines.map(foldLine).join('\r\n');
}

/**
 * Build a single-event iCal suitable for emailing as a .ics attachment
 * when a parents' evening slot is booked.
 *
 * @param {object} opts
 * @param {string}  opts.slotDate         - "YYYY-MM-DD"
 * @param {string}  opts.slotTime         - "HH:MM" (London local)
 * @param {number}  opts.durationMinutes  - appointment length
 * @param {string} [opts.teacherName]
 * @param {string} [opts.childName]
 * @param {string} [opts.location]
 * @returns {string} iCal text
 */
function buildParentsEveningIcs({ slotDate, slotTime, durationMinutes, teacherName, childName, location }) {
  const [h, m] = (slotTime || '00:00').split(':').map(Number);
  const dur = durationMinutes || 10;
  const endH = Math.floor((h * 60 + m + dur) / 60) % 24;
  const endM = (m + dur) % 60;
  const pad = n => String(n).padStart(2, '0');
  const d = String(slotDate).slice(0, 10).replace(/-/g, '');
  const dtstart = `${d}T${pad(h)}${pad(m)}00`;
  const dtend   = `${d}T${pad(endH)}${pad(endM)}00`;
  const uid = `pe-slot-${slotDate}-${slotTime.replace(':', '')}@wren`;

  return buildCalendar({
    name: "Parents' Evening",
    events: [{
      uid,
      summary: childName ? `Parents' Evening — ${childName}` : "Parents' Evening",
      dtstart,
      dtend,
      allDay: false,
      location: location || '',
      description: teacherName ? `Appointment with ${teacherName}` : "Parents' Evening appointment",
    }],
  });
}

module.exports = { buildCalendar, buildParentsEveningIcs };
