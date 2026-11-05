'use strict';

/**
 * Edval CSV importer.
 *
 * Edval (used across AU/NZ/UK) exports timetables via:
 *   File → Export → Timetable CSV
 *
 * Edval uses a slightly different column naming convention to TimeTabler.
 * Common export columns:
 *   Period, Day, Class, Subject, Teacher, Room, Week, Year Group
 *   — or —
 *   PeriodId, DayId, ClassCode, SubjectCode, TeacherCode, RoomCode, WeekType
 *
 * Edval "WeekType" is typically "A", "B", "BOTH" (means single-week).
 * "DayId" may be integers 1-5 or text Mon-Fri.
 * "PeriodId" is typically integers 1-8.
 */

// Reuse day/week/period resolvers — Edval uses same conventions
const { parse: ttParse, TEMPLATE: TT_TEMPLATE } = require('./timetabler');

// Edval-specific column aliases (added on top of timetabler's)
const EDVAL_COL_OVERRIDE = [
  ['day',          ['dayid', 'day id', 'day_id', 'daynum']],
  ['period',       ['periodid', 'period id', 'period_id', 'periodnum']],
  ['week',         ['weektype', 'week type', 'week_type', 'rotation', 'cycle']],
  ['class_name',   ['classcode', 'class code', 'class_code', 'classgroup']],
  ['subject_code', ['subjectcode', 'subject code', 'subject_code', 'subj_code']],
  ['teacher_name', ['teachercode', 'teacher code', 'teacher_code', 'staffcode']],
  ['room_code',    ['roomcode', 'room code', 'room_code']],
  ['year_group',   ['yeargroup', 'year group', 'year_group', 'yeargrp']],
  ['group_code',   ['setcode', 'groupcode']],
];

// Edval "BOTH" week type maps to week pattern 1 (single-week school)
function preprocess(text) {
  return text.replace(/\bBOTH\b/gi, '1').replace(/\bSINGLE\b/gi, '1');
}

/**
 * parse(text, options) → Array of activity rows
 *
 * Delegates to timetabler parser after normalising Edval-specific naming.
 * Edval doesn't need its own full parser — same CSV structure, different headers.
 */
function parse(text, options = {}) {
  const processed = preprocess(text);
  // The timetabler parser handles all the column aliases Edval uses
  return ttParse(processed, options);
}

module.exports.parse    = parse;
module.exports.TEMPLATE = {
  name: 'edval-v1',
  source_kind: 'edval',
  version: 1,
  is_builtin: true,
  expected_headers: ['Period', 'Day', 'Class', 'Subject', 'Teacher', 'Room'],
  optional_headers: ['WeekType', 'YearGroup', 'SetCode'],
  notes: 'Edval CSV export. WeekType A/B/BOTH supported.',
};
