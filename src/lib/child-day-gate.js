'use strict';
// src/lib/child-day-gate.js — b405 (2026-10-06)
//
// Toby: the parents' "child's day" (diary/meals/sleep/nappies) must not
// update live while staff are still writing it — reveal a day's
// STAFF-authored entries once the child is signed out, or at closing time
// if there's no sign-out recorded that day (matching the end-of-day review
// staff already do). This supersedes the 2026-07-30 "LIVE-TODAY" behaviour
// (today's still-draft staff entries no longer leak mid-day).
//
// How it meets the 13 Oct diary model (diaryfix2): staff diary entries are
// status='draft' until someone presses Publish. TODAY's drafts are what this
// gates — they reach the parent at the reveal. Deliberately NOT applied to:
// anything already status='published' (that is staff deliberately releasing it —
// shows as before), or source='parent' rows (a parent's own home-log entry must
// stay visible immediately — it was never the thing being hidden).
//
// Used by: editions/ladn/server-unified.js (/welcome/diary/api/days),
// src/routes/parents.js (/child/:childId/diary).

const TZ = 'Europe/London';

// Mirrors src/lib/clock-autoclose.js's _timeSetting() convention (kept as its
// own small copy rather than importing that file, to avoid any accidental
// coupling to the staff auto-close sweep).
async function closingTimeSetting(db) {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'closing_time'");
    const v = rows[0] && String(rows[0].value || '').trim();
    return (v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) ? v : '18:00';
  } catch (_) { return '18:00'; }
}

// A correlated SQL boolean fragment: true once TODAY's diary is safe to
// reveal for the child named by childIdExpr (e.g. 'diary_entries.child_id').
// closingTime has already been validated as HH:MM by closingTimeSetting(),
// so string interpolation here is safe (not user input).
//
// "Signed out" = some attendance row today has a sign_out_time AND no row today
// has the child still IN (sign_in_time set, sign_out_time null). The second half
// matters: the register can hold a stale EyLog / booking "shell" row that is
// already "out" next to a genuine sign-in on another row (see the 2026-07-30 note
// in src/routes/attendance.js) — without it the day would be revealed the moment
// the child arrived. A child who signs back in after being signed out (sign_out
// cleared by the register) is "in" again and is hidden again until they leave.
function revealedTodayClause(childIdExpr, closingTime) {
  return `(
    (
      EXISTS (
        SELECT 1 FROM ladn.attendance a
        WHERE a.child_id = ${childIdExpr} AND a.date = CURRENT_DATE AND a.sign_out_time IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM ladn.attendance a2
        WHERE a2.child_id = ${childIdExpr} AND a2.date = CURRENT_DATE
          AND a2.sign_in_time IS NOT NULL AND a2.sign_out_time IS NULL
      )
    )
    OR (now() AT TIME ZONE '${TZ}')::time >= '${closingTime}'::time
  )`;
}

module.exports = { TZ, closingTimeSetting, revealedTodayClause };
