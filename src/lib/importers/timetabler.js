'use strict';

/**
 * TimeTabler CSV importer.
 *
 * TimeTabler (UK's most-used secondary timetabling tool) can export timetables
 * in several CSV formats. The most common export path is:
 *   Reports → Timetable Summary → Export to CSV
 *
 * Expected column headers (case-insensitive, extras ignored):
 *   Day, Period, Class, Subject, Teacher, Room
 *   — or —
 *   Day, Period, Form, Subject, Teacher, Room
 *   — or —
 *   DayNo, PeriodNo, Set, SubjectCode, TeacherCode, Room
 *
 * Week A/B: if the export has a "Week" column containing "A"/"B" (or "1"/"2"),
 * that value is used; otherwise defaults to the week_pattern option.
 *
 * Day values accepted: Mon/Monday/1, Tue/Tuesday/2 … Fri/Friday/5.
 * Period values: integers 1-9 (mapped to timetable_periods.period_num).
 */

const DAY_MAP = {
  '1': 1, 'mon': 1, 'monday': 1,
  '2': 2, 'tue': 2, 'tues': 2, 'tuesday': 2,
  '3': 3, 'wed': 3, 'wednesday': 3,
  '4': 4, 'thu': 4, 'thur': 4, 'thurs': 4, 'thursday': 4,
  '5': 5, 'fri': 5, 'friday': 5,
};

const WEEK_MAP = {
  '1': 1, 'a': 1, 'week a': 1, 'wk a': 1,
  '2': 2, 'b': 2, 'week b': 2, 'wk b': 2,
};

// Column alias resolution — tries multiple possible header names
const COLUMN_ALIASES = {
  day:          ['day', 'dayno', 'day no', 'day_no', 'daynumber'],
  period:       ['period', 'periodno', 'period no', 'period_no', 'per', 'lesson'],
  week:         ['week', 'weekpattern', 'week pattern', 'week_pattern', 'wk'],
  class_name:   ['class', 'form', 'set', 'group', 'class name', 'classname', 'form class'],
  subject_code: ['subjectcode', 'subject code', 'subject_code', 'subj', 'code'],
  subject_name: ['subject', 'subjectname', 'subject name', 'subject_name'],
  teacher_name: ['teacher', 'teachercode', 'teacher code', 'teacher_code', 'staff', 'tutor'],
  room_code:    ['room', 'classroom', 'room code', 'room_code', 'roomcode', 'venue'],
  year_group:   ['year', 'year group', 'year_group', 'yeargroup', 'yr'],
  group_code:   ['setcode', 'set code', 'groupcode', 'group code', 'set_code'],
  pupil_count:  ['pupils', 'pupilcount', 'pupil count', 'size', 'nos'],
};

// ── CSV helpers ───────────────────────────────────────────────────────────────

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuote) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"')            { inQuote = false; }
      else                           { field += c; }
    } else {
      if (c === '"')                        { inQuote = true; }
      else if (c === ',')                   { row.push(field); field = ''; }
      else if (c === '\t')                  { row.push(field); field = ''; } // TSV support
      else if (c === '\r' && next === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
      else if (c === '\n' || c === '\r')    { row.push(field); rows.push(row); row = []; field = ''; }
      else                                  { field += c; }
    }
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function resolveHeader(headers, aliases) {
  const norm = aliases.map(a => a.toLowerCase().replace(/[\s_-]/g, ''));
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].toLowerCase().replace(/[\s_-]/g, '');
    if (norm.includes(h)) return i;
  }
  return -1;
}

function buildColMap(headers) {
  const map = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    map[key] = resolveHeader(headers, aliases);
  }
  return map;
}

function get(row, colMap, key) {
  const idx = colMap[key];
  if (idx === -1 || idx === undefined) return '';
  return (row[idx] || '').trim();
}

// ── Day and period resolution ─────────────────────────────────────────────────

function resolveDay(raw) {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/[\s.]/g, '');
  return DAY_MAP[key] ?? null;
}

function resolveWeek(raw, defaultWp) {
  if (!raw) return defaultWp;
  const key = raw.trim().toLowerCase().replace(/[\s_]/g, '');
  return WEEK_MAP[key] ?? defaultWp;
}

function resolvePeriod(raw) {
  if (!raw) return null;
  const n = parseInt(raw.trim());
  if (!isNaN(n) && n >= 1 && n <= 9) return n;
  // Handle labels like "P1", "Period 2"
  const m = raw.match(/(\d+)/);
  if (m) { const n2 = parseInt(m[1]); if (n2 >= 1 && n2 <= 9) return n2; }
  return null;
}

function resolveYearGroup(raw, className) {
  if (raw) {
    const n = parseInt(raw);
    if (n >= 7 && n <= 13) return n;
  }
  // Infer from class name: "10B" → 10, "Y9A" → 9, "7C" → 7
  if (className) {
    const m = (className || '').match(/(\d+)/);
    if (m) { const n = parseInt(m[1]); if (n >= 7 && n <= 13) return n; }
  }
  return null;
}

// ── Main parse function ───────────────────────────────────────────────────────

/**
 * parse(text, options) → Array of activity rows
 * Each row: { day_of_week, period_num, week_pattern, year_group, subject_code,
 *              subject_name, teacher_name, room_code, class_name, group_code, pupil_count }
 */
function parse(text, options = {}) {
  const { week_pattern: defaultWp = 1 } = options;

  const rawRows = parseCSV(text);
  if (rawRows.length < 2) throw new Error('CSV has fewer than 2 rows (no data?)');

  const headers = rawRows[0].map(h => h.trim());
  const colMap  = buildColMap(headers);

  // Verify we have at minimum: day + period
  if (colMap.day === -1 && colMap.period === -1) {
    throw new Error('Cannot find Day and Period columns. Expected headers like "Day, Period, Class, Subject, Teacher, Room"');
  }

  const activities = [];
  const seen = new Set(); // dedup (week, day, period, teacher)

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (row.every(c => !c.trim())) continue; // skip blank rows

    const dayRaw     = get(row, colMap, 'day');
    const periodRaw  = get(row, colMap, 'period');
    const weekRaw    = get(row, colMap, 'week');
    const className  = get(row, colMap, 'class_name');
    const yearRaw    = get(row, colMap, 'year_group');

    const dow        = resolveDay(dayRaw);
    const periodNum  = resolvePeriod(periodRaw);
    const wp         = resolveWeek(weekRaw, defaultWp);

    if (!dow || !periodNum) continue; // skip non-lesson rows (break/lunch headers etc.)

    const teacher    = get(row, colMap, 'teacher_name');
    const dedupKey   = `${wp}:${dow}:${periodNum}:${teacher}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    activities.push({
      day_of_week:  dow,
      period_num:   periodNum,
      week_pattern: wp,
      year_group:   resolveYearGroup(yearRaw, className),
      subject_code: get(row, colMap, 'subject_code') || null,
      subject_name: get(row, colMap, 'subject_name') || null,
      teacher_name: teacher || null,
      room_code:    get(row, colMap, 'room_code') || null,
      class_name:   className || null,
      group_code:   get(row, colMap, 'group_code') || null,
      pupil_count:  parseInt(get(row, colMap, 'pupil_count')) || null,
    });
  }

  if (!activities.length) throw new Error('No valid timetable rows found in CSV');
  return activities;
}

module.exports.parse    = parse;
module.exports.TEMPLATE = {
  name: 'timetabler-v1',
  source_kind: 'timetabler',
  version: 1,
  is_builtin: true,
  expected_headers: ['Day', 'Period', 'Class', 'Subject', 'Teacher', 'Room'],
  optional_headers: ['Week', 'Year', 'Set', 'Pupils'],
  notes: 'TimeTabler CSV export. Week A/B supported via "Week" column.',
};
