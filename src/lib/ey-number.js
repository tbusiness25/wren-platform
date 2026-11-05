'use strict';
// src/lib/ey-number.js — b532 (2026-10-28)
//
// Toby: "assign children on the waiting list an EY number so I can reference them and find
// them on the system … and make sure that the staff have an EY number as well".
//
// One series, the one LADN already uses: EyLog numbered every child LA<n>CD (LA1CD–LA248CD).
// Wren carries it on:
//   children.eylog_ref      — the child's EY number (existing column; new children get the next
//                             one from ladn.ey_number_seq by trigger, see the b532 migration)
//   waiting_list.ey_number  — a waiting-list child's number, from the same sequence (trigger)
//   staff.ey_number         — LA<id>ST, a generated column
// When a waiting-list child is enrolled, the child keeps the number the office has been using
// for them: adoptWaitlistNumber() moves it onto the child row.

/** The number a child row was given automatically (>= 249) can be replaced by the waiting-list one. */
function _autoAssigned(ref) {
  const m = /^LA(\d+)CD$/.exec(String(ref || ''));
  return !ref || (m && Number(m[1]) >= 249);
}

async function adoptWaitlistNumber(db, childId, waitingListId) {
  if (!childId || !waitingListId) return null;
  try {
    const { rows: [w] } = await db.query(`SELECT ey_number FROM waiting_list WHERE id = $1`, [waitingListId]);
    if (!w || !w.ey_number) return null;
    const { rows: [c] } = await db.query(`SELECT eylog_ref FROM children WHERE id = $1`, [childId]);
    if (!c || c.eylog_ref === w.ey_number || !_autoAssigned(c.eylog_ref)) return c ? c.eylog_ref : null;
    await db.query(`UPDATE children SET eylog_ref = $2, updated_at = now() WHERE id = $1`, [childId, w.ey_number]);
    return w.ey_number;
  } catch (e) {
    console.error('[ey-number] adopt', e.message);
    return null;
  }
}

module.exports = { adoptWaitlistNumber };
