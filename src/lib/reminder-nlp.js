'use strict';
// Reminder NLP (b151) — deterministic intent + natural-language date parsing for
// "remind me to X [when]" chat messages. Deliberately NOT LLM-based: local Ollama
// models are unreliable at exact date arithmetic, and a 2-minute-out test needs to
// be exact, not "close enough". No npm date library is installed in this repo
// (confirmed — no chrono-node/date-fns/luxon); this hand-rolled parser covers the
// phrasings the task actually needs and reuses the same Europe/London DST-safe
// wall-clock→UTC technique already proven live by notification-dispatcher.js's
// quiet-hours math (b149).

const DAY_INDEX = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};
const DAY_NAMES_RE = Object.keys(DAY_INDEX).sort((a, b) => b.length - a.length).join('|');

const CREATE_TRIGGERS = [
  /^(?:hey wren[,]?\s*)?(?:please\s+)?remind me to (.+)$/i,
  /^(?:hey wren[,]?\s*)?(?:please\s+)?set (?:a |an )?reminder (?:for me )?to (.+)$/i,
  /^(?:hey wren[,]?\s*)?(?:please\s+)?create a reminder (?:to |that )?(.+)$/i,
  /^(?:hey wren[,]?\s*)?(?:please\s+)?add a reminder (?:to |that )?(.+)$/i,
  /^(?:hey wren[,]?\s*)?(?:please\s+)?remind me (.+)$/i,
];

const LIST_RE = /\b(what|which|show|list|any)\b.*\breminders?\b|\breminders?\b.*\b(do i have|are (?:set|pending|active))\b/i;
// Explicit — the word "reminder" is present, always treat as a cancel intent
// (respond "not found" rather than silently ignoring if no match).
const CANCEL_RE = /\b(cancel|delete|remove|stop)\b.*\breminders?\b/i;
// Weak — just a cancel verb, e.g. Toby's own example "cancel the fire alarm
// one" (no literal "reminder"). Only safe to treat as a cancel-reminder intent
// if it turns out to fuzzy-match one of the user's actual pending reminders —
// the caller must check that before intercepting, so an unrelated "cancel my
// X" message isn't hijacked into a false "no reminder found" reply.
const WEAK_CANCEL_RE = /\b(cancel|delete|remove|stop)\b/i;
const AUTOMATIONS_QUERY_RE = /\b(what|which|show|list)\b.*\bautomations?\b|\bautomations?\b.*\b(do we have|are (?:set|active|running))\b/i;

function _londonDriftMs(refNow) {
  const utcMs = refNow.getTime();
  const londonMs = new Date(refNow.toLocaleString('en-US', { timeZone: 'Europe/London' })).getTime();
  return utcMs - londonMs;
}

// Build a real UTC Date for a Europe/London wall-clock instant. The BST/GMT
// offset must be the one in effect on the TARGET date (y,m,d), not on refNow —
// using refNow's offset is wrong whenever the target date sits on the other
// side of a DST boundary from refNow (2026-07-23 q01 finding: this broke both
// one-shot reminders created near a clock-change and every `nextOccurrence`
// rollover of a recurring reminder that crosses one). Noon UTC on the target
// date is a safe pivot for computing that date's own offset — UK transitions
// always happen at 01:00/02:00 local, so noon can never be mid-transition.
function londonDateAt(y, m, d, hh, mm, refNow) {
  const naiveUtc = new Date(Date.UTC(y, m - 1, d, hh, mm, 0, 0));
  const targetNoonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Date(naiveUtc.getTime() + _londonDriftMs(targetNoonUtc));
}

function londonNowParts(refNow) {
  refNow = refNow || new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(refNow).reduce((a, p) => (a[p.type] = p.value, a), {});
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    dow: DAY_INDEX[parts.weekday.toLowerCase()],
  };
}

function _addDaysToParts(parts, days) {
  // Use UTC noon as a neutral pivot to avoid DST-edge date-rollover surprises,
  // then re-read the London calendar date — good enough for day-level arithmetic.
  const pivot = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
  pivot.setUTCDate(pivot.getUTCDate() + days);
  return {
    year: pivot.getUTCFullYear(), month: pivot.getUTCMonth() + 1, day: pivot.getUTCDate(),
    dow: (parts.dow + days % 7 + 7) % 7,
  };
}

function _parseTimeOfDay(text) {
  const m = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3] ? m[3].toLowerCase() : null;
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

// Finds where the "when" clause starts inside a de-triggered reminder request,
// e.g. "check the fire alarm every Friday at 5pm" → task="check the fire alarm".
const WHEN_START_RE = new RegExp(
  `\\b(every\\s+(?:${DAY_NAMES_RE}|day|weekday)s?|next\\s+(?:${DAY_NAMES_RE})|(?:${DAY_NAMES_RE})|` +
  `tomorrow|tonight|today|in\\s+\\d+\\s*(?:minute|min|mins|hour|hr|hrs|day|days|week|weeks)s?|` +
  `at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)\\b`, 'i'
);

function detectCreateRequest(message) {
  const msg = String(message || '').trim();
  for (const re of CREATE_TRIGGERS) {
    const m = msg.match(re);
    if (m && m[1] && m[1].trim().length) return m[1].trim();
  }
  return null;
}

function isListQuery(message) { return LIST_RE.test(String(message || '')); }
function isCancelQuery(message) { return CANCEL_RE.test(String(message || '')); }
function mightBeCancelQuery(message) { return WEAK_CANCEL_RE.test(String(message || '')); }
function isAutomationsQuery(message) { return AUTOMATIONS_QUERY_RE.test(String(message || '')); }

function extractCancelSearchText(message) {
  // "cancel the fire alarm one" / "cancel my fire alarm reminder" → "fire alarm"
  let t = String(message || '')
    .replace(/\b(cancel|delete|remove|stop)\b/gi, '')
    .replace(/\b(the|my|a|an|one|reminder|reminders|please)\b/gi, '')
    .trim();
  return t;
}

// Parses the remainder of a create request (after "remind me to ") into
// { taskText, dueAt, recurrence } or null if no recognisable time was found.
function parseReminderRequest(remainder, refNow) {
  refNow = refNow || new Date();
  const whenMatch = remainder.match(WHEN_START_RE);
  if (!whenMatch) return null;

  const idx = whenMatch.index;
  let taskText = remainder.slice(0, idx).trim().replace(/\s+(on|at|by|for)$/i, '').trim();
  const whenText = remainder.slice(idx).trim();
  if (!taskText) return null;

  // Recurrence
  let recurrence = 'none';
  const everyWeekday = /^every\s+weekdays?\b/i.test(whenText);
  const everyDow = new RegExp(`^every\\s+(${DAY_NAMES_RE})\\b`, 'i').test(whenText);
  const everyDay = /^every\s+days?\b/i.test(whenText);
  if (everyWeekday) recurrence = 'weekdays';
  else if (everyDow) recurrence = 'weekly';
  else if (everyDay) recurrence = 'daily';

  const time = _parseTimeOfDay(whenText);

  const now = londonNowParts(refNow);

  // Relative offset: "in N minutes/hours/days"
  const relMatch = whenText.match(/\bin\s+(\d+)\s*(minute|min|mins|hour|hr|hrs|day|days|week|weeks)s?\b/i);
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    // "in N days/weeks at HH:MM" — the clock time was explicitly given, so land
    // on that calendar date AT that time, not (now + raw milliseconds), which
    // silently dropped the requested time-of-day (2026-07-23 q01 finding).
    if (time && (unit.startsWith('day') || unit.startsWith('week'))) {
      const days = unit.startsWith('week') ? n * 7 : n;
      const d = _addDaysToParts(now, days);
      const dueAt = londonDateAt(d.year, d.month, d.day, time.hh, time.mm, refNow);
      return { taskText, dueAt, recurrence: 'none' };
    }
    const ms = unit.startsWith('min') ? n * 60000
      : unit.startsWith('h') ? n * 3600000
      : unit.startsWith('week') ? n * 7 * 86400000
      : n * 86400000;
    const dueAt = new Date(refNow.getTime() + ms);
    return { taskText, dueAt, recurrence: 'none' };
  }

  // Explicit weekday (with or without "next"/"every")
  const dowMatch = new RegExp(`\\b(?:next\\s+)?(${DAY_NAMES_RE})\\b`, 'i').exec(whenText);
  if (dowMatch) {
    const targetDow = DAY_INDEX[dowMatch[1].toLowerCase()];
    let diff = (targetDow - now.dow + 7) % 7;
    if (diff === 0) diff = 7; // "Friday" said on a Friday → next Friday, not today
    const d = _addDaysToParts(now, diff);
    const t = time || { hh: 9, mm: 0 };
    const dueAt = londonDateAt(d.year, d.month, d.day, t.hh, t.mm, refNow);
    return { taskText, dueAt, recurrence };
  }

  // tomorrow / today / tonight
  if (/\btomorrow\b/i.test(whenText)) {
    const d = _addDaysToParts(now, 1);
    const t = time || { hh: 9, mm: 0 };
    return { taskText, dueAt: londonDateAt(d.year, d.month, d.day, t.hh, t.mm, refNow), recurrence };
  }
  if (/\btonight\b/i.test(whenText)) {
    const t = time || { hh: 19, mm: 0 };
    // If the given/default time has already passed today, this can't mean
    // "tonight" any more — roll to tomorrow rather than firing near-instantly
    // for an already-past time (2026-07-23 q01 finding).
    const candidate = londonDateAt(now.year, now.month, now.day, t.hh, t.mm, refNow);
    const dueAt = candidate > refNow ? candidate : londonDateAt(..._addDaysAndSpread(now, 1), t.hh, t.mm, refNow);
    return { taskText, dueAt, recurrence };
  }
  if (/\btoday\b/i.test(whenText)) {
    const t = time || { hh: 17, mm: 0 };
    const candidate = londonDateAt(now.year, now.month, now.day, t.hh, t.mm, refNow);
    const dueAt = candidate > refNow ? candidate : londonDateAt(..._addDaysAndSpread(now, 1), t.hh, t.mm, refNow);
    return { taskText, dueAt, recurrence };
  }

  // "every day at 9am" (no weekday, no relative offset, no tomorrow/today) — daily/weekdays recurrence with just a time
  if ((recurrence === 'daily' || recurrence === 'weekdays') && time) {
    let d = now;
    const candidate = londonDateAt(d.year, d.month, d.day, time.hh, time.mm, refNow);
    const dueAt = candidate > refNow ? candidate : londonDateAt(..._addDaysAndSpread(d, 1), time.hh, time.mm, refNow);
    return { taskText, dueAt, recurrence };
  }

  // Bare "at HH:MM" with no day reference — assume next occurrence of that time (today if still ahead, else tomorrow)
  if (time && whenText.trim().toLowerCase().startsWith('at')) {
    const todayAt = londonDateAt(now.year, now.month, now.day, time.hh, time.mm, refNow);
    if (todayAt > refNow) return { taskText, dueAt: todayAt, recurrence };
    const d = _addDaysToParts(now, 1);
    return { taskText, dueAt: londonDateAt(d.year, d.month, d.day, time.hh, time.mm, refNow), recurrence };
  }

  return null;
}

function _addDaysAndSpread(parts, days) {
  const d = _addDaysToParts(parts, days);
  return [d.year, d.month, d.day];
}

// Computes the next due_at after a recurring reminder has just fired at `firedAt`.
function nextOccurrence(firedAt, recurrence) {
  const parts = londonNowParts(firedAt);
  // Preserve the wall-clock time-of-day the reminder was originally due at.
  const londonTimeParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(firedAt).reduce((a, p) => (a[p.type] = p.value, a), {});
  const tHH = Number(londonTimeParts.hour), tMM = Number(londonTimeParts.minute);

  if (recurrence === 'daily') {
    const d = _addDaysToParts(parts, 1);
    return londonDateAt(d.year, d.month, d.day, tHH, tMM, firedAt);
  }
  if (recurrence === 'weekly') {
    const d = _addDaysToParts(parts, 7);
    return londonDateAt(d.year, d.month, d.day, tHH, tMM, firedAt);
  }
  if (recurrence === 'weekdays') {
    let days = 1;
    let d = _addDaysToParts(parts, days);
    while (d.dow === 0 || d.dow === 6) { days += 1; d = _addDaysToParts(parts, days); }
    return londonDateAt(d.year, d.month, d.day, tHH, tMM, firedAt);
  }
  return null;
}

function formatWhen(dueAt, recurrence) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(dueAt).reduce((a, p) => (a[p.type] = p.value, a), {});
  const base = `${parts.weekday} ${parts.day} ${parts.month} at ${parts.hour}:${parts.minute}`;
  if (recurrence === 'none') return base;
  const label = { daily: 'daily', weekly: 'weekly', weekdays: 'every weekday' }[recurrence] || recurrence;
  return `${base} (recurring ${label})`;
}

module.exports = {
  detectCreateRequest, parseReminderRequest, isListQuery, isCancelQuery, mightBeCancelQuery,
  isAutomationsQuery, extractCancelSearchText, nextOccurrence, formatWhen,
  londonDateAt, londonNowParts,
};
