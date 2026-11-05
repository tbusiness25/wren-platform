'use strict';

/**
 * ASC Timetables (aSc Timetables) CSV importer.
 *
 * ASC is a Slovak product widely used in European schools including the UK.
 * Export path: File → Export → Export to CSV / Export to Excel
 *
 * ASC exports can vary significantly by version and export template.
 * This handles the two most common formats:
 *
 *  Format A (Lessons export):
 *    Lesson, ClassID, SubjectID, TeacherID, ClassroomID, Day, Period
 *    — IDs are codes/abbreviations, not display names
 *
 *  Format B (Human-readable export):
 *    Day, Period, Class, Subject, Teacher, Classroom/Room
 *
 *  Format C (XML-derived CSV — after converting aSc XML to CSV):
 *    id, classIds, subjectId, teacherIds, classroomIds, days, periods
 *    — days/periods are bitmasks or comma-separated lists
 *
 * Week pattern: ASC uses "Week" or "Weeks" column or "A"/"B" suffix on class names.
 */

// Reuse shared CSV and resolver utilities
const { parse: ttParse } = require('./timetabler');

// ASC-specific aliases not in the timetabler alias set
const ASC_EXTRA_ALIASES = {
  class_name:   ['classid', 'class id', 'classids', 'classname'],
  subject_code: ['subjectid', 'subject id', 'subjectids'],
  teacher_name: ['teacherid', 'teacher id', 'teacherids'],
  room_code:    ['classroomid', 'classroom id', 'classroomids', 'classroom', 'classrooms'],
  day:          ['days', 'dayofweek', 'day of week'],
  period:       ['periods', 'periodofday', 'lesson no', 'lessonno', 'lesson'],
};

// ASC bitmask day expansion:
// Some ASC exports encode Mon-Fri as bits in an integer (Mon=1, Tue=2, Wed=4, Thu=8, Fri=16)
// or as a 5-char string "10001" (Mon and Fri)
function expandDaysBitmask(raw) {
  const s = (raw || '').trim();
  // 5-char binary string
  if (/^[01]{5}$/.test(s)) {
    const days = [];
    for (let i = 0; i < 5; i++) { if (s[i] === '1') days.push(i + 1); }
    return days;
  }
  // Integer bitmask
  const n = parseInt(s);
  if (!isNaN(n) && n > 0) {
    const days = [];
    for (let i = 0; i < 5; i++) { if (n & (1 << i)) days.push(i + 1); }
    return days;
  }
  return null; // not a bitmask — return null so normal resolution applies
}

function expandPeriodsBitmask(raw) {
  const s = (raw || '').trim();
  if (/^[01]{8,10}$/.test(s)) {
    const periods = [];
    for (let i = 0; i < s.length; i++) { if (s[i] === '1') periods.push(i + 1); }
    return periods;
  }
  const n = parseInt(s);
  if (!isNaN(n) && n > 0 && s.length <= 2) return null; // plain period number
  if (!isNaN(n) && n > 9) {
    const periods = [];
    for (let i = 0; i < 8; i++) { if (n & (1 << i)) periods.push(i + 1); }
    return periods;
  }
  return null;
}

// Detect which ASC format we're looking at
function detectFormat(headers) {
  const h = headers.map(x => x.toLowerCase().replace(/[\s_]/g, ''));
  if (h.includes('classids') || h.includes('teacherids') || h.includes('classroomids')) return 'C';
  if (h.includes('classid') || h.includes('teacherid') || h.includes('classroomid')) return 'A';
  return 'B'; // default human-readable
}

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
      else if (c === ',' || c === ';')      { row.push(field); field = ''; }
      else if (c === '\r' && next === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
      else if (c === '\n' || c === '\r')    { row.push(field); rows.push(row); row = []; field = ''; }
      else                                  { field += c; }
    }
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

/**
 * parse(text, options) → Array of activity rows
 *
 * Handles ASC Format A (code-ID based) and Format B (human-readable).
 * Format C (bitmask days/periods) expands each row into multiple rows.
 */
function parse(text, options = {}) {
  const { week_pattern: defaultWp = 1 } = options;

  const rawRows = parseCSV(text.replace(/^﻿/, ''));
  if (rawRows.length < 2) throw new Error('CSV has fewer than 2 rows');

  const headers = rawRows[0].map(h => h.trim());
  const fmt     = detectFormat(headers);

  // For Format B (human-readable), delegate entirely to timetabler parser
  if (fmt === 'B') return ttParse(text, options);

  // Format A / C: resolve column indices manually
  const h = headers.map(x => x.toLowerCase().replace(/[\s_-]/g, ''));
  const col = (aliases) => {
    for (const a of aliases) {
      const idx = h.indexOf(a.toLowerCase().replace(/[\s_-]/g, ''));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const dayCol     = col(['day', 'days', 'dayofweek']);
  const periodCol  = col(['period', 'periods', 'periodno', 'lesson']);
  const classCol   = col(['classid', 'classids', 'class', 'form', 'group']);
  const subjectCol = col(['subjectid', 'subjectids', 'subject', 'subjectcode']);
  const teacherCol = col(['teacherid', 'teacherids', 'teacher', 'teachercode', 'staff']);
  const roomCol    = col(['classroomid', 'classroomids', 'room', 'classroom', 'venue']);
  const weekCol    = col(['week', 'weeks', 'weektype', 'rotation']);
  const yearCol    = col(['year', 'yeargroup', 'yeargrp']);

  function getCell(row, idx) { return idx === -1 ? '' : (row[idx] || '').trim(); }

  const activities = [];
  const seen = new Set();

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (row.every(c => !c.trim())) continue;

    const dayRaw     = getCell(row, dayCol);
    const periodRaw  = getCell(row, periodCol);
    const className  = getCell(row, classCol);
    const subjectRaw = getCell(row, subjectCol);
    const teacherRaw = getCell(row, teacherCol);
    const roomRaw    = getCell(row, roomCol);
    const weekRaw    = getCell(row, weekCol);
    const yearRaw    = getCell(row, yearCol);

    // Handle bitmask expansion for Format C
    const expandedDays    = expandDaysBitmask(dayRaw);
    const expandedPeriods = expandPeriodsBitmask(periodRaw);

    const days    = expandedDays    ?? [parseSingleDay(dayRaw)].filter(Boolean);
    const periods = expandedPeriods ?? [parseInt(periodRaw)].filter(n => !isNaN(n) && n >= 1 && n <= 9);

    if (!days.length || !periods.length) continue;

    // Resolve week pattern
    const wp = resolveWeekSimple(weekRaw, defaultWp);

    // Year group from class name
    const yg = resolveYearFromClass(yearRaw, className);

    for (const dow of days) {
      for (const pNum of periods) {
        if (dow < 1 || dow > 5 || pNum < 1 || pNum > 9) continue;
        const key = `${wp}:${dow}:${pNum}:${teacherRaw}`;
        if (seen.has(key)) continue;
        seen.add(key);

        activities.push({
          day_of_week:  dow,
          period_num:   pNum,
          week_pattern: wp,
          year_group:   yg,
          subject_code: subjectRaw || null,
          subject_name: subjectRaw || null,
          teacher_name: teacherRaw || null,
          room_code:    roomRaw || null,
          class_name:   className || null,
          group_code:   null,
          pupil_count:  null,
        });
      }
    }
  }

  if (!activities.length) throw new Error('No valid timetable rows found in ASC export');
  return activities;
}

function parseSingleDay(raw) {
  const DAY_MAP = {
    '1': 1, 'mon': 1, 'monday': 1,
    '2': 2, 'tue': 2, 'tues': 2, 'tuesday': 2,
    '3': 3, 'wed': 3, 'wednesday': 3,
    '4': 4, 'thu': 4, 'thur': 4, 'thurs': 4, 'thursday': 4,
    '5': 5, 'fri': 5, 'friday': 5,
  };
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/[\s.]/g, '');
  return DAY_MAP[key] ?? null;
}

function resolveWeekSimple(raw, def) {
  if (!raw) return def;
  const k = raw.trim().toLowerCase();
  if (k === 'a' || k === '1' || k === 'week a' || k === 'both') return 1;
  if (k === 'b' || k === '2' || k === 'week b') return 2;
  return def;
}

function resolveYearFromClass(yearRaw, className) {
  if (yearRaw) { const n = parseInt(yearRaw); if (n >= 7 && n <= 13) return n; }
  if (className) { const m = className.match(/(\d+)/); if (m) { const n = parseInt(m[1]); if (n >= 7 && n <= 13) return n; } }
  return null;
}

module.exports.parse    = parse;
module.exports.TEMPLATE = {
  name: 'asctimetables-v1',
  source_kind: 'asctimetables',
  version: 1,
  is_builtin: true,
  expected_headers: ['Day', 'Period', 'Class', 'Subject', 'Teacher', 'Room'],
  optional_headers: ['Week', 'Year', 'ClassroomId', 'SubjectId', 'TeacherId'],
  notes: 'ASC Timetables CSV export. Supports Format A (code IDs), Format B (human-readable), Format C (bitmask days/periods).',
};
