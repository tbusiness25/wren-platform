'use strict';
// src/lib/diary-auto-publish.js — diarypub-20261028
//
// Toby (28 Oct): "can we have it so that the daily diaries auto go out when kids are
// signed out." Staff diary entries are saved as status='draft' and only became
// 'published' when someone pressed Publish on /ey/diary — nobody had since 14 Oct, so
// 1,233 entries sat as drafts. Parents saw a draft only on the day itself, after the
// reveal in child-day-gate.js (signed out, or closing time); the next morning an
// unpublished day dropped out of their history.
//
// This makes that same reveal permanent: a child's drafts are published once the child
// is signed out (and not back in), and every remaining draft for the day is published
// once closing time has passed — the same moment parents already started seeing them.
// It is the reveal rule, not a new one, so what a family sees on the day doesn't change;
// what changes is that the day stays in their history.
//
// Scope:
//   - Only days from `diary_auto_publish_from` (default 2026-10-28). Earlier drafts are
//     the backlog Toby hasn't decided on — lower the setting to include them.
//   - `diary_auto_publish` = 'off' switches it off (absent = on).
//   - Status only. Nothing is sent: no email, no push, no notification row.
//
// Called by: src/routes/attendance.js (sign-out, for that child, immediately) and
// editions/ladn/server-unified.js (every 5 minutes, all children — catches entries
// logged after pickup and children with no sign-out recorded).

const { TZ, closingTimeSetting, revealedTodayClause } = require('./child-day-gate');

const DEFAULT_FROM = '2026-10-28';

async function _setting(db, key) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0] ? String(rows[0].value == null ? '' : rows[0].value).trim() : null;
  } catch (_) { return null; }
}

async function publishRevealedDiaries(db, { childId } = {}) {
  const sw = await _setting(db, 'diary_auto_publish');
  if (sw && /^(off|false|0|no)$/i.test(sw)) return { skipped: 'off', entries: 0, diary: 0 };

  const fromRaw = await _setting(db, 'diary_auto_publish_from');
  const from = fromRaw && /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : DEFAULT_FROM;
  const closing = await closingTimeSetting(db);
  const cid = childId ? parseInt(childId, 10) : null;

  const params = [from];
  if (cid) params.push(cid);
  const childSql = (col) => (cid ? ` AND ${col} = $2` : '');
  const today = `(now() AT TIME ZONE '${TZ}')::date`;

  const de = await db.query(`
    UPDATE diary_entries de SET status = 'published'
     WHERE de.status = 'draft' AND de.deleted_at IS NULL
       AND (de.occurred_at AT TIME ZONE '${TZ}')::date >= $1::date
       AND ( (de.occurred_at AT TIME ZONE '${TZ}')::date < ${today}
             OR ((de.occurred_at AT TIME ZONE '${TZ}')::date = ${today}
                 AND ${revealedTodayClause('de.child_id', closing)}) )
       ${childSql('de.child_id')}`, params);

  const dd = await db.query(`
    UPDATE daily_diary d SET status = 'published'
     WHERE d.status = 'draft'
       AND d.date >= $1::date
       AND ( d.date < ${today}
             OR (d.date = ${today} AND ${revealedTodayClause('d.child_id', closing)}) )
       ${childSql('d.child_id')}`, params).catch(() => ({ rowCount: 0 }));

  return { entries: de.rowCount, diary: dd.rowCount };
}

module.exports = { publishRevealedDiaries, DEFAULT_FROM };
