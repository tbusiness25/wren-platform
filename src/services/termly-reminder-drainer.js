'use strict';
/*
 * Termly Update Reminder Drainer (Prompt 28C).
 *
 * Mirrors task-reminder-drainer.js. Every N hours, scan key children for those
 * whose termly update is Due / Overdue and keep ONE active in-app reminder per
 * child alive (addressed to that child's key person), plus a manager summary.
 * When a child's termly update is completed (status flips to Done) the reminder
 * auto-clears (dismissed).
 *
 * "Don't spam": exactly one active notification per child — refreshed in place,
 * never duplicated. It only re-fires (bumps to the top of the bell + re-marks
 * unread) once every REFIRE window so the key person is nudged again until it's
 * done, without being pestered every drain.
 *
 * Dedupe is logical: (category, related_table='children', related_id, recipient,
 * dismissed_at IS NULL). The drainer is single-process per container so there's
 * no insert race.
 *
 * Envs (all optional):
 *   TERMLY_REMINDER_INTERVAL — seconds between scans (default 21600 = 6h)
 *   TERMLY_REMINDER_REFIRE   — seconds before an active reminder re-fires (default 259200 = 3 days)
 *   TERMLY_REMINDER_DISABLED — truthy to skip starting at all
 */

const { getPool } = require('../db/pool');
const { notify } = require('./notification-dispatcher');
const { fetchTermlyStatuses } = require('./termly-status');

function startTermlyReminderDrainer({ interval = 21600, refire = 259200 } = {}) {
  if (process.env.TERMLY_REMINDER_DISABLED) {
    console.log('[termly-reminder] disabled by env');
    return;
  }
  const INTERVAL = (parseInt(process.env.TERMLY_REMINDER_INTERVAL) || interval) * 1000;
  const REFIRE   = (parseInt(process.env.TERMLY_REMINDER_REFIRE)   || refire)   * 1000;

  let _running = false;

  async function drainOnce() {
    if (_running) return;
    _running = true;
    const db = getPool();
    try {
      const { children } = await fetchTermlyStatuses(db, { onlyKeyed: false });
      let created = 0, refreshed = 0, cleared = 0;

      for (const c of children) {
        const outstanding = c.status === 'due' || c.status === 'overdue';

        if (outstanding && c.key_person_id) {
          const title = `Termly update ${c.status === 'overdue' ? 'overdue' : 'due'}: ${c.first_name} ${c.last_name}`;
          const body = c.last_termly_date
            ? `${c.first_name}'s last termly update was ${c.last_termly_date} — it's now ${c.status}. `
              + `Write their termly update (observation + next steps) and tag their Birth-to-5 statements in Trackers.`
            : `${c.first_name} has no termly update on record yet. `
              + `Write their first termly update (observation + next steps) and tag their Birth-to-5 statements in Trackers.`;
          const priority = c.status === 'overdue' ? 'high' : 'normal';

          // One active reminder per child for this key person.
          const { rows: ex } = await db.query(
            `SELECT id, created_at FROM notifications
             WHERE category='termly_update_due' AND related_table='children'
               AND related_id=$1 AND recipient_type='staff' AND recipient_id=$2
               AND dismissed_at IS NULL
             ORDER BY created_at DESC LIMIT 1`,
            [c.child_id, c.key_person_id]
          );

          if (!ex.length) {
            // First nudge — full notify (in-app + telegram per the staff member's prefs).
            notify('termly_update_due', 'staff', c.key_person_id, title, body, {
              priority,
              relatedTable: 'children',
              relatedId: c.child_id,
              link: '/ey/trackers#termly',
            });
            created++;
          } else {
            const age = Date.now() - new Date(ex[0].created_at).getTime();
            if (age >= REFIRE) {
              // Re-fire: bump to top of the bell + re-mark unread to nudge again.
              await db.query(
                `UPDATE notifications
                   SET title=$1, body=$2, priority=$3, created_at=NOW(), read_at=NULL
                 WHERE id=$4`,
                [title, body, priority, ex[0].id]
              );
            } else {
              // Keep current text/priority fresh without re-nagging.
              await db.query(
                `UPDATE notifications SET title=$1, body=$2, priority=$3 WHERE id=$4`,
                [title, body, priority, ex[0].id]
              );
            }
            refreshed++;
          }
        } else if (c.status === 'done') {
          // Auto-clear any active reminder(s) for this child once it's been done.
          const { rowCount } = await db.query(
            `UPDATE notifications SET dismissed_at=NOW()
             WHERE category='termly_update_due' AND related_table='children'
               AND related_id=$1 AND dismissed_at IS NULL`,
            [c.child_id]
          );
          if (rowCount) cleared += rowCount;
        }
      }

      // ── Manager summary: one active notification, refreshed/cleared ────────────
      const outstandingCount = children.filter(c => c.status !== 'done' && c.key_person_id).length;
      const { rows: sumEx } = await db.query(
        `SELECT id FROM notifications
         WHERE category='termly_update_summary' AND recipient_type='all-managers'
           AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 1`
      );
      if (outstandingCount > 0) {
        const sTitle = `${outstandingCount} termly update${outstandingCount === 1 ? '' : 's'} outstanding`;
        const sBody = `${outstandingCount} key child${outstandingCount === 1 ? '' : 'ren'} still need their termly update this cycle. `
          + `Open Trackers → Termly Updates to see who and chase them.`;
        if (!sumEx.length) {
          notify('termly_update_summary', 'all-managers', null, sTitle, sBody, {
            priority: 'normal', link: '/ey/trackers#termly',
          });
        } else {
          await db.query(
            `UPDATE notifications SET title=$1, body=$2 WHERE id=$3`,
            [sTitle, sBody, sumEx[0].id]
          );
        }
      } else if (sumEx.length) {
        await db.query(`UPDATE notifications SET dismissed_at=NOW() WHERE id=$1`, [sumEx[0].id]);
      }

      if (created || cleared) {
        console.log(`[termly-reminder] created=${created} refreshed=${refreshed} cleared=${cleared} outstanding=${outstandingCount}`);
      }
    } catch (e) {
      console.error('[termly-reminder] drain error:', e.message);
    } finally {
      _running = false;
    }
  }

  // Immediate first pass, then on the interval.
  drainOnce().catch(e => console.error('[termly-reminder] first pass failed:', e.message));
  setInterval(drainOnce, INTERVAL);
  console.log(`[termly-reminder] started (interval=${INTERVAL / 1000}s, refire=${REFIRE / 1000}s)`);
}

module.exports = { startTermlyReminderDrainer };
