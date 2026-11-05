'use strict';
/**
 * report-cycle.js — b244 collector. Reports that are due, on the Cockpit board.
 *
 * Reads src/lib/report-cycle.js — the same derivation the EY "Reports due" page
 * shows, so the two surfaces can never disagree about what is outstanding.
 *
 * ── WHY THIS IS AGGREGATED AND NOT ONE ITEM PER REPORT ──────────────────────
 * The obvious build is one attention_item per outstanding report. With ~40 active
 * children and four formats that is a board with sixty rows on it, which is the
 * failure mode the b232 crons collector already documents by name: a board that
 * cries wolf is a board Toby stops opening, and then the two genuinely red things
 * on it are invisible.
 *
 * So: one item per FORMAT that has something overdue, carrying the count and the
 * link to the page that lists the actual children — plus one item for overdue
 * reports with no key person to chase, because that one is nobody's job by
 * definition and will otherwise sit there forever.
 *
 * ── GDPR ────────────────────────────────────────────────────────────────────
 * attention_items rows are rendered on Roost and get read back out of the table
 * by other tooling. Titles and details here carry COUNTS; `evidence` carries
 * CHILD IDS. No child's name goes into this table from b244 — the names are on
 * the EY page, behind the staff session and the on-site gate, which is where a
 * key person is doing the work anyway.
 *
 * ── RAG ─────────────────────────────────────────────────────────────────────
 * red    the statutory 2-year check overdue at all, or anything overdue by more
 *        than the format's own grace period twice over
 * amber  everything else overdue
 * Nothing here is ever green: a slot that is fine does not need a board.
 */
const { getPool } = require('../../db/pool');
const RC = require('../../lib/report-cycle');

const SOURCE = 'report_cycle';

// The 2-year check is the one with a statute behind it and a closing window —
// past 36 months it cannot be written at all. It goes red the day it is overdue.
const ALWAYS_RED = new Set(['two_year_check']);

module.exports = {
  name: 'report-cycle',
  owns: [SOURCE],

  async collect() {
    const db = getPool();

    let schedule;
    try {
      schedule = await RC.buildSchedule(db, {});
    } catch (e) {
      // Rule 2: "I could not look" must never read as "there is nothing there",
      // or the refresh quietly closes every report finding on the board.
      return { ok: false, items: [], note: `could not build the schedule: ${e.message}` };
    }

    if (!schedule.children.length) {
      return { ok: true, items: [], note: 'no active children' };
    }

    const rows = RC.dueRows(schedule, { states: ['overdue', 'due'] });
    const items = [];

    // ── one item per format with something overdue ───────────────────────────
    const byFormat = {};
    for (const r of rows) {
      const f = (byFormat[r.format] = byFormat[r.format] || {
        format: r.format, label: r.format_label,
        plural: (RC.FORMAT_BY_KEY[r.format] || {}).plural || r.format_label,
        overdue: [], due: [], worst_days: 0, key_people: new Set(), unassigned: [],
      });
      f[r.state].push(r);
      if (r.state === 'overdue') {
        if (r.days_over != null && r.days_over > f.worst_days) f.worst_days = r.days_over;
        if (r.key_person_id == null) f.unassigned.push(r.child_id);
        else f.key_people.add(r.key_person_id);
      }
    }

    for (const f of Object.values(byFormat)) {
      if (!f.overdue.length) continue;   // "due but not yet overdue" is not a finding
      const n = f.overdue.length;
      const red = ALWAYS_RED.has(f.format) || f.worst_days >= 84;
      items.push({
        source: SOURCE,
        source_key: `overdue:${f.format}`,
        rag: red ? 'red' : 'amber',
        title: `${n} ${n === 1 ? f.label.toLowerCase() : f.plural} overdue`,
        detail: `${n} overdue, longest by ${f.worst_days} days`
              + (f.due.length ? `; ${f.due.length} more due now` : '')
              + `. Across ${f.key_people.size} key ${f.key_people.size === 1 ? 'person' : 'people'}`
              + (f.unassigned.length ? ` and ${f.unassigned.length} with no key person` : '')
              + '.',
        why: f.format === 'two_year_check'
          ? 'The progress check at age two is statutory and can only be written between 24 and 36 months. '
            + 'Once a child passes three the window has closed and it cannot be done at all.'
          : whyFor(f.format),
        category: 'compliance',
        // The earliest date in this group — the board sorts on it.
        due_date: f.overdue.map(r => r.due_on).filter(Boolean).sort()[0] || null,
        blocked_on: 'toby',
        effort_minutes: Math.min(240, 20 * n),
        // b246 — the termly update has its own screen (the five sections, the card
        // picker and the tracker); everything else is written on the child's record,
        // which is what the reports-due board links to.
        action_url: f.format === 'termly_update' ? '/ey/termly-update' : `/ey/reports-due?format=${f.format}`,
        evidence: {
          format: f.format,
          overdue: n,
          due_soon: f.due.length,
          worst_days_over: f.worst_days,
          // ids, never names — see the GDPR note at the top of this file.
          child_ids: f.overdue.map(r => r.child_id).slice(0, 50),
          key_person_ids: [...f.key_people],
        },
        sort_hint: red ? 5 : 25,
      });
    }

    // ── overdue work nobody owns ─────────────────────────────────────────────
    const orphaned = rows.filter(r => r.state === 'overdue' && r.key_person_id == null);
    if (orphaned.length) {
      const kids = [...new Set(orphaned.map(r => r.child_id))];
      items.push({
        source: SOURCE,
        source_key: 'overdue:no_key_person',
        rag: 'red',
        title: `${kids.length} ${kids.length === 1 ? 'child has' : 'children have'} overdue reports and no key person`,
        detail: `${orphaned.length} overdue report${orphaned.length === 1 ? '' : 's'} across ${kids.length} `
              + `child${kids.length === 1 ? '' : 'ren'} with children.key_person_id unset. `
              + 'Nobody is being chased for these because there is nobody to chase.',
        why: 'Every other finding on this board reaches a named key person. These do not, so they '
           + 'will sit here indefinitely no matter how overdue they get. Assigning a key person is '
           + 'the fix, not writing the reports.',
        category: 'compliance',
        due_date: orphaned.map(r => r.due_on).filter(Boolean).sort()[0] || null,
        blocked_on: 'toby',
        effort_minutes: 15,
        action_url: '/ey/reports-due?unassigned=1',
        evidence: { child_ids: kids.slice(0, 50), slots: orphaned.length },
        sort_hint: 4,
      });
    }

    // ── the mapping itself ───────────────────────────────────────────────────
    // A document whose format could not be worked out cannot satisfy a slot, so
    // every one of them is a report the board may be chasing that already exists.
    // That is the exact failure b244 was built to avoid, so it gets said out loud
    // rather than living in a log nobody reads.
    const unmapped = (schedule.unmapped.reports || 0) + (schedule.unmapped.parent_reports || 0);
    if (unmapped >= 5) {
      items.push({
        source: SOURCE,
        source_key: 'unmapped_documents',
        rag: 'amber',
        title: `${unmapped} report${unmapped === 1 ? '' : 's'} could not be matched to a format`,
        detail: `${schedule.unmapped.reports} in reports and ${schedule.unmapped.parent_reports} in `
              + 'parent_reports have a type and title that normaliseFormat() does not recognise. '
              + 'They cannot satisfy a slot, so the board may be chasing reports that exist.',
        why: 'The EyLog imports use about fifteen titles for four documents. The mapping in '
           + 'src/lib/report-cycle.js collapses them; anything it misses shows up as a missing report.',
        category: 'data',
        blocked_on: 'claude',
        effort_minutes: 30,
        action_url: '/ey/reports-due',
        evidence: schedule.unmapped,
        sort_hint: 60,
      });
    }

    return {
      ok: true,
      items,
      note: `${schedule.children.length} children, ${rows.length} slots due or overdue`
          + (schedule.termly_available ? '' : ' (termly status unavailable)'),
    };
  },
};

function whyFor(format) {
  switch (format) {
    case 'settling_in':
      return 'The settling-in report is written 4–8 weeks after a child starts, while settling is still '
           + 'what the family is thinking about. Written six months late it is a different document.';
    case 'six_month_chat':
      return 'The six-month chat is the standing conversation with the family. A missed one is not a '
           + 'missing document so much as half a year in which nobody sat down with them.';
    case 'termly_update':
      // b246 (2026-08-28): the cadence moved onto Ealing's half-terms and the
      // update grew five sections. Both matter to whoever reads this board: an
      // overdue termly update now means a whole ROOM is late together, which is
      // a different (and more visible to families) problem from one child slipping
      // on their own rolling clock.
      return 'The termly update is what a family actually reads: what went well last term, what we are '
           + 'working on this term, the next steps, ideas for home and the tracking data. It runs on '
           + 'Ealing\'s half-terms, so the whole room is due together — and a whole room being late is '
           + 'visible to every family at once. The reminder chases individual key people; this is the count.';
    default:
      return 'Scheduled from the child\'s start date and date of birth.';
  }
}
