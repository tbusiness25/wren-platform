'use strict';
/**
 * service.js — b504 (My list, Part A4). Everything the /api/attention/mylist*
 * routes do, kept out of the route file so the route file only appends thin
 * handlers. No Telegram, no email, no network: this file only reads and writes
 * ladn.attention_items, ladn.settings, mylist_days and the two write-through
 * tables (cockpit_cards, tasks/task_assignees).
 *
 * Nothing here deletes a row. "Drop" sets resolved_at + dropped_at; "park" sets
 * parked_at; "close" sets resolved_at. Every one can be undone from the table.
 */

const H = require('../../lib/uk-bank-holidays');
const picker = require('./picker');
const { classify } = require('../attention/rag');
const { londonToday } = require('../../lib/signals/_util');

const TOBY = 1;
const { KIND_SQL, OPEN_SQL, CAND_COLS, DO_NOW_MAX, NEXT_MAX } = picker;

const SETTING_DEFAULTS = {
  mylist_enabled: 'false', mylist_transport: 'dispatcher', mylist_nudge_staff_ids: '[1]', mylist_paused_until: '',
  mylist_launch_mode: 'false', mylist_launch_until: '2026-10-26', mylist_countdown_label: 'EyLog exit',
  mylist_countdown_date: '2026-10-26', mylist_window_start: '08:30', mylist_window_end: '17:45',
  mylist_launch_window_end: '19:30',
  mylist_times: '{"morning":"09:30","starter":"11:45","push":"16:15","wrap":"17:20","weekly":"07:30","friday":"16:30"}',
  mylist_daily_cap: '4', mylist_loud_per_day: '1', mylist_loud_per_week: '4', mylist_mute_after: '3',
  mylist_urgent_tone: 'true', mylist_do_now_max: '3', mylist_share_staff_id: '', mylist_share_after_days: '5',
  mylist_parked_until: '2026-11-02',
};

async function getSettings(db) {
  const out = Object.assign({}, SETTING_DEFAULTS);
  try {
    const { rows } = await db.query(`SELECT key, value FROM settings WHERE key LIKE 'mylist\\_%'`);
    for (const r of rows) if (r.key in SETTING_DEFAULTS && r.value != null) out[r.key] = r.value;
  } catch (_) { /* settings unreadable: defaults */ }
  return out;
}
async function setSetting(db, key, value, staffId) {
  if (!(key in SETTING_DEFAULTS)) { const e = new Error(`unknown setting ${key}`); e.status = 400; throw e; }
  await db.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, String(value), staffId || null]);
}

// ── item shaping ─────────────────────────────────────────────────────────────
const OWNER_LABEL = { toby: 'Toby', claude: 'Claude', external: 'Waiting' };

function shape(r, asOf, launchMode) {
  const sc = picker.score(r, { asOf, launchMode });
  const ev = r.evidence || {};
  return {
    id: r.id,
    title: r.title,
    why: r.why || null,
    detail: r.detail ? String(r.detail).slice(0, 600) : null,
    kind: r.kind,
    category: r.category || null,
    effort_minutes: r.effort_minutes,
    due_date: r.due_date,           // the REAL deadline
    plan_due: r.plan_due,           // YOUR date
    stage: r.stage,
    carried_days: r.carried_days,
    tags: r.tags || [],
    source: r.source,
    action_url: r.action_url || null,
    lane: r.lane,
    picked_by: r.picked_by,
    tone: r.tone,
    done: !!r.resolved_at,
    done_at: r.resolved_at || null,
    owner_label: ev.owner || OWNER_LABEL[r.blocked_on] || (r.owner_staff_id === TOBY ? 'Toby' : null),
    master_id: r.source === 'launch-list' ? r.source_key : null,
    focus_started_at: r.focus_started_at || null,
    reason: sc.reason,
    score: sc.score,
    stuck: (r.carried_days || 0) >= 2,
    starter: r.effort_minutes != null && Number(r.effort_minutes) <= picker.STARTER_MINS,
  };
}

const SEL = `${CAND_COLS}, detail, evidence, tone, focus_started_at`;

function cmp(a, b) { return b.score - a.score || a.id - b.id; }

// ── the view ─────────────────────────────────────────────────────────────────
async function buildMyList(db, user, now, opts = {}) {
  const asOf = londonToday(now);
  const me = Number(user && user.id) || TOBY;
  const settings = await getSettings(db);
  const launchMode = settings.mylist_launch_mode === 'true';

  await picker.pickToday(db, asOf, { staffId: me, launchMode });

  // Do now: today's picks, open first, then done today.
  const { rows: todays } = await db.query(
    `SELECT ${SEL} FROM attention_items
      WHERE picked_for = $1::date AND (owner_staff_id = $2 OR owner_staff_id IS NULL) AND dropped_at IS NULL
        AND (resolved_at IS NULL OR resolved_at >= $1::date)
      ORDER BY (resolved_at IS NOT NULL), sort_hint, id`, [asOf, me]);
  const do_now = todays.map(r => shape(r, asOf, launchMode));

  // Compact mode (top-bar chip, Dashboard card): countdown + today only. No lists.
  const cdDate = settings.mylist_countdown_date;
  const baseCountdown = {
    label: settings.mylist_countdown_label, date: cdDate, date_label: picker.dayLabel(cdDate),
    days_left: H.daysBetween(asOf, cdDate),
  };
  if (opts.compact) {
    return { ok: true, as_of: asOf, compact: true, countdown: baseCountdown, do_now,
             today: { done: do_now.filter(i => i.done).length, of: do_now.length } };
  }

  // Everything else that is live and a job-kind item.
  const { rows: live } = await db.query(
    `SELECT ${SEL} FROM attention_items
      WHERE ${OPEN_SQL} AND ${KIND_SQL} IN ('job','decision','waiting')
        AND picked_for IS DISTINCT FROM $1::date
      ORDER BY id`, [asOf]);

  const mine = live.filter(r => r.owner_staff_id === me && (r.blocked_on || 'toby') === 'toby');
  const nextAll = mine.filter(r => r.lane === 'next' && r.kind !== 'waiting').map(r => shape(r, asOf, launchMode)).sort(cmp);
  const claudeAll = live.filter(r => r.blocked_on === 'claude' && ['now', 'next'].includes(r.lane)).map(r => shape(r, asOf, launchMode)).sort(cmp);
  const waitingAll = live.filter(r => r.kind === 'waiting' && ['now', 'next'].includes(r.lane)).map(r => shape(r, asOf, launchMode));
  const laterRows = live.filter(r => r.lane === 'later');

  // LATER, collapsed by area.
  const byArea = new Map();
  for (const r of laterRows) {
    const a = r.category || 'other';
    if (!byArea.has(a)) byArea.set(a, []);
    byArea.get(a).push(r);
  }
  const later_by_area = [...byArea.entries()].map(([area, rs]) => ({
    area, n: rs.length,
    items: rs.sort((x, y) => (x.plan_due || '9999').localeCompare(y.plan_due || '9999') || x.id - y.id)
      .map(r => { const s = shape(r, asOf, launchMode); return { id: s.id, title: s.title, due_date: s.due_date, plan_due: s.plan_due, owner_label: s.owner_label, launch: s.tags.includes('launch'), kind: s.kind, detail: s.detail }; }),
  })).sort((a, b) => b.n - a.n || a.area.localeCompare(b.area));

  // PARKED (count + the first few for "review"), CLOSE, counts.
  const { rows: [pk] } = await db.query(
    `SELECT count(*)::int AS n FROM attention_items
      WHERE resolved_at IS NULL AND dropped_at IS NULL AND parked_at IS NOT NULL
        AND ${KIND_SQL} IN ('job','decision','waiting') AND NOT ('confirm-close' = ANY(tags))`);
  const { rows: closeRows } = await db.query(
    `SELECT id, title, category, evidence->>'owner' AS owner, detail, source, tags
       FROM attention_items
      WHERE resolved_at IS NULL AND dropped_at IS NULL AND 'confirm-close' = ANY(tags)
      ORDER BY (evidence->>'owner'), category, id`);

  // Wren is watching: ops counts only.
  const { rows: ragRows } = await db.query(
    `SELECT rag, count(*)::int AS n FROM attention_items
      WHERE resolved_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= now()) AND ${KIND_SQL} = 'ops'
      GROUP BY rag`);
  const watching = { red: 0, amber: 0, green: 0, top: [] };
  for (const r of ragRows) if (watching[r.rag] != null) watching[r.rag] = r.n;
  const { rows: topOps } = await db.query(
    `SELECT id, title, rag FROM attention_items
      WHERE resolved_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= now()) AND ${KIND_SQL} = 'ops' AND rag IN ('red','amber')
      ORDER BY (rag = 'red') DESC, due_date NULLS LAST, id LIMIT 3`);
  watching.top = topOps;

  // Countdown.
  const { rows: [lc] } = await db.query(
    `SELECT count(*) FILTER (WHERE resolved_at IS NULL AND dropped_at IS NULL AND parked_at IS NULL AND NOT ('confirm-close' = ANY(tags)))::int AS open,
            count(*) FILTER (WHERE resolved_at IS NULL AND dropped_at IS NULL AND parked_at IS NULL AND NOT ('confirm-close' = ANY(tags)) AND owner_staff_id = $1)::int AS open_toby,
            count(*) FILTER (WHERE resolved_at IS NULL AND dropped_at IS NULL AND parked_at IS NULL AND NOT ('confirm-close' = ANY(tags)) AND blocked_on = 'claude')::int AS open_claude,
            count(*) FILTER (WHERE resolved_at IS NOT NULL AND dropped_at IS NULL AND NOT ('confirm-close' = ANY(tags)))::int AS done
       FROM attention_items WHERE 'launch' = ANY(tags)`, [me]);
  const countdown = Object.assign({}, baseCountdown, {
    launch_open: lc.open, launch_done: lc.done,
    launch_open_toby: lc.open_toby, launch_open_claude: lc.open_claude,
    launch_open_others: lc.open - lc.open_toby - lc.open_claude,
  });

  const waitingDates = waitingAll.map(w => w.plan_due).filter(Boolean).sort();
  return {
    ok: true,
    as_of: asOf,
    countdown,
    do_now,
    today: { done: do_now.filter(i => i.done).length, of: do_now.length },
    next: nextAll.slice(0, opts.nextAll ? 100 : NEXT_MAX),
    next_total: nextAll.length,
    claude: { n: claudeAll.length, top: claudeAll.slice(0, 5), items: opts.claudeAll ? claudeAll.slice(0, 100) : undefined },
    waiting: { n: waitingAll.length, next_chase: waitingDates[0] || null, items: waitingAll.sort(cmp) },
    later_total: laterRows.length,
    later_by_area,
    parked_total: pk.n,
    parked_until: settings.mylist_parked_until, parked_until_label: picker.dayLabel(settings.mylist_parked_until),
    close: { n: closeRows.length, items: closeRows.map(r => ({ id: r.id, title: r.title, area: r.category, owner: r.owner || null, why: r.detail ? String(r.detail).slice(0, 220) : null })) },
    watching,
    settings: {
      enabled: settings.mylist_enabled === 'true', mode: launchMode ? 'launch' : 'normal',
      paused_until: settings.mylist_paused_until || null,
    },
  };
}

// ── write-through (Done) ─────────────────────────────────────────────────────
/**
 * Called BEFORE the generic resolve. For kanban/tasks rows it makes the source
 * row done too; a failure returns {ok:false} and the item stays open. Records
 * what is needed to undo in evidence._undo.
 */
async function writeThrough(db, id, user) {
  const { rows: [it] } = await db.query(`SELECT id, source, source_key, evidence, resolved_at FROM attention_items WHERE id = $1`, [id]);
  if (!it) return { ok: false, status: 404, error: 'not_found' };
  if (it.resolved_at) return { ok: true, noop: true };
  const me = Number(user && user.id) || TOBY;
  try {
    if (it.source === 'kanban') {
      const cardId = Number((it.evidence || {}).card_id);
      if (!Number.isInteger(cardId)) return { ok: true, noop: true };
      const { rows: [c] } = await db.query(`SELECT col FROM cockpit_cards WHERE id = $1`, [cardId]);
      if (c) {
        await db.query(`UPDATE cockpit_cards SET col = 'done', updated_at = now() WHERE id = $1`, [cardId]);
        await db.query(`UPDATE attention_items SET evidence = evidence || $2::jsonb WHERE id = $1`, [id, JSON.stringify({ _undo: { kind: 'kanban', card_id: cardId, prev_col: c.col } })]);
      }
    } else if (it.source === 'tasks' && /^task-\d+$/.test(it.source_key)) {
      const taskId = Number(it.source_key.slice(5));
      const { rows: [t] } = await db.query(
        `SELECT id, status, (due_date IS NOT NULL AND due_date < (now() AT TIME ZONE 'Europe/London')::date) AS overdue FROM tasks WHERE id = $1`, [taskId]);
      if (t && t.status !== 'done') {
        const note = t.overdue ? 'Completed from My list' : null;
        await db.query(`INSERT INTO task_assignees (task_id, staff_id) VALUES ($1,$2) ON CONFLICT (task_id, staff_id) DO NOTHING`, [taskId, me]);
        await db.query(`UPDATE task_assignees SET status='done', completed_at=NOW(), completion_note=$3 WHERE task_id=$1 AND staff_id=$2`, [taskId, me, note]);
        const { rows: [o] } = await db.query(`SELECT count(*)::int AS n FROM task_assignees WHERE task_id=$1 AND status <> 'done'`, [taskId]);
        let closed = false;
        if (o.n === 0) {
          await db.query(`UPDATE tasks SET status='done', completed_at=NOW(), updated_at=NOW(), completion_note=COALESCE($2, completion_note) WHERE id=$1 AND status <> 'done'`, [taskId, note]);
          closed = true;
        }
        await db.query(`UPDATE attention_items SET evidence = evidence || $2::jsonb WHERE id = $1`, [id, JSON.stringify({ _undo: { kind: 'tasks', task_id: taskId, staff_id: me, task_closed: closed, prev_status: t.status } })]);
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 500, error: 'write_through_failed', message: `Could not tick the source row (${e.message}); the item stays open.` };
  }
}

async function undoWriteThrough(db, row) {
  const u = (row.evidence || {})._undo;
  if (!u) return;
  if (u.kind === 'kanban') await db.query(`UPDATE cockpit_cards SET col = $2, updated_at = now() WHERE id = $1`, [u.card_id, u.prev_col || 'backlog']);
  if (u.kind === 'tasks') {
    await db.query(`UPDATE task_assignees SET status='open', completed_at=NULL, completion_note=NULL WHERE task_id=$1 AND staff_id=$2`, [u.task_id, u.staff_id]);
    if (u.task_closed) await db.query(`UPDATE tasks SET status=$2, completed_at=NULL, completion_note=NULL, updated_at=NOW() WHERE id=$1`, [u.task_id, u.prev_status || 'open']);
  }
}

// ── PATCH actions ────────────────────────────────────────────────────────────
const ACTIONS = new Set(['stage', 'park', 'unpark', 'drop', 'tomorrow', 'later', 'swap', 'use_buffer', 'tone', 'focus_start', 'focus_end', 'date', 'undo']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(status, error, message) { const e = new Error(message || error); e.status = status; e.code = error; return e; }

async function patch(db, user, id, action, body, now) {
  const me = Number(user && user.id) || TOBY;
  const asOf = londonToday(now);
  const { rows: [it] } = await db.query(`SELECT ${SEL}, resolved_by, dropped_at FROM attention_items WHERE id = $1`, [id]);
  if (!it) throw fail(404, 'not_found');

  switch (action) {
    case 'stage': {
      const st = parseInt(body.stage, 10);
      if (![0, 1, 2, 3].includes(st)) throw fail(400, 'bad_stage', 'stage must be 0, 1, 2 or 3');
      await db.query(`UPDATE attention_items SET stage = $2 WHERE id = $1`, [id, st]);
      break;
    }
    case 'park':
      await db.query(`UPDATE attention_items SET parked_at = now(), lane = 'later', picked_for = NULL, picked_by = NULL WHERE id = $1`, [id]);
      break;
    case 'unpark':
      await db.query(`UPDATE attention_items SET parked_at = NULL, lane = 'next' WHERE id = $1`, [id]);
      break;
    case 'drop':
      // Nothing is deleted: dropped rows stay, resolved, with dropped_at.
      await db.query(`UPDATE attention_items SET resolved_at = now(), resolved_by = $2, dropped_at = now(), status = 'done' WHERE id = $1 AND resolved_at IS NULL`, [id, me]);
      break;
    case 'tomorrow': {
      const day = H.nextWorkingDay(asOf);
      await db.query(`UPDATE attention_items SET picked_for = $2::date, picked_by = 'toby', lane = 'now' WHERE id = $1`, [id, day]);
      break;
    }
    case 'later':
      await db.query(`UPDATE attention_items SET lane = 'later', picked_for = NULL, picked_by = 'toby' WHERE id = $1`, [id]);
      break;
    case 'swap': {
      const withId = parseInt(body.with, 10);
      if (!Number.isInteger(withId) || withId === id) throw fail(400, 'bad_swap', 'swap needs {with: <other item id>}');
      const { rows: [o] } = await db.query(`SELECT id, lane, picked_for::text AS picked_for, resolved_at FROM attention_items WHERE id = $1`, [withId]);
      if (!o || o.resolved_at) throw fail(404, 'swap_target_not_found');
      // A <- B's place; B <- A's place. Both are Toby's own choice now.
      await db.query(`UPDATE attention_items SET lane = $2, picked_for = $3::date, picked_by = 'toby' WHERE id = $1`, [id, o.lane || 'next', o.picked_for]);
      await db.query(`UPDATE attention_items SET lane = $2, picked_for = $3::date, picked_by = 'toby' WHERE id = $1`, [withId, it.lane || 'next', it.picked_for]);
      break;
    }
    case 'use_buffer': {
      if (!it.due_date) throw fail(400, 'no_real_date', 'This job has no real deadline to move your date to.');
      await db.query(
        `UPDATE attention_items SET plan_due = due_date, tone = 'auto',
                evidence = evidence || jsonb_build_object('buffer_used_at', now()::text, 'buffer_was', plan_due::text)
          WHERE id = $1`, [id]);
      break;
    }
    case 'tone': {
      const t = String(body.tone || '');
      if (!['calm', 'loud', 'muted', 'auto'].includes(t)) throw fail(400, 'bad_tone', 'tone must be calm, loud, muted or auto');
      await db.query(`UPDATE attention_items SET tone = $2 WHERE id = $1`, [id, t]);
      break;
    }
    case 'focus_start': {
      const mins = Math.max(5, Math.min(120, parseInt(body.minutes, 10) || 25));
      await db.query(`UPDATE attention_items SET focus_started_at = now(), focus_minutes = $2 WHERE id = $1`, [id, mins]);
      break;
    }
    case 'focus_end':
      await db.query(`UPDATE attention_items SET focus_started_at = NULL WHERE id = $1`, [id]);
      break;
    case 'date': {
      const sets = [], params = [id];
      for (const col of ['plan_due', 'due_date']) {
        if (!(col in body)) continue;
        const v = body[col] === '' || body[col] == null ? null : String(body[col]).slice(0, 10);
        if (v && !DATE_RE.test(v)) throw fail(400, 'bad_date', `${col} must be YYYY-MM-DD`);
        params.push(v); sets.push(`${col} = $${params.length}::date`);
      }
      if (!sets.length) throw fail(400, 'no_dates', 'send plan_due and/or due_date');
      await db.query(`UPDATE attention_items SET ${sets.join(', ')} WHERE id = $1`, params);
      break;
    }
    case 'undo': {
      // 60 seconds, only the person who resolved it.
      const { rows } = await db.query(
        `UPDATE attention_items SET resolved_at = NULL, resolved_by = NULL, dropped_at = NULL, snoozed_until = NULL, status = 'open'
          WHERE id = $1 AND resolved_at IS NOT NULL AND resolved_by = $2 AND resolved_at > now() - interval '60 seconds'
          RETURNING id`, [id, me]);
      if (!rows.length) throw fail(409, 'undo_expired', 'Undo only works for 60 seconds after you tick something.');
      await undoWriteThrough(db, it);
      break;
    }
    default:
      throw fail(400, 'bad_action');
  }
  const { rows: [fresh] } = await db.query(`SELECT ${SEL} FROM attention_items WHERE id = $1`, [id]);
  return shape(fresh, asOf, false);
}

// ── capture, close, stats ────────────────────────────────────────────────────
async function capture(db, user, body, now) {
  const text = String(body.text || '').trim();
  if (!text) throw fail(400, 'text_required');
  if (text.length > 300) throw fail(400, 'text_too_long');
  const asOf = londonToday(now);
  const me = Number(user && user.id) || TOBY;
  const plan = H.nextWorkingDay(asOf);
  const c = classify({ dueDate: null, blockedOnToby: true, informational: true });
  const { rows: [r] } = await db.query(
    `INSERT INTO attention_items
       (source, source_key, rag, severity, title, why, category, due_date, plan_due, blocked_on, effort_minutes, evidence,
        manual, sort_hint, kind, owner_staff_id, lane, tags)
     VALUES ('manual', $1, $2, $2, $3, $4, 'manual', NULL, $5::date, 'toby', NULL, $6::jsonb, true, 0, 'job', $7, 'next', '{}')
     RETURNING ${SEL}`,
    [`toby-${Date.now()}`, c.rag, text, c.why, plan, JSON.stringify({ added_by_staff_id: me, via: String(body.via || 'roost').slice(0, 20) }), me]);
  return shape(r, asOf, false);
}

/** CLOSE section: resolve the ticked, keep (un-tag) the rest, one call. */
async function closeBatch(db, user, body) {
  const me = Number(user && user.id) || TOBY;
  const ids = Array.isArray(body.close) ? body.close.map(Number).filter(Number.isInteger) : [];
  const keep = Array.isArray(body.keep) ? body.keep.map(Number).filter(Number.isInteger) : [];
  let closed = 0, kept = 0;
  if (ids.length) {
    const r = await db.query(
      `UPDATE attention_items SET resolved_at = now(), resolved_by = $2, status = 'done',
              evidence = evidence || jsonb_build_object('closed_via', 'confirm-close')
        WHERE id = ANY($1::int[]) AND resolved_at IS NULL AND 'confirm-close' = ANY(tags)`, [ids, me]);
    closed = r.rowCount;
  }
  if (keep.length) {
    const r = await db.query(
      `UPDATE attention_items SET tags = array_remove(tags, 'confirm-close')
        WHERE id = ANY($1::int[]) AND resolved_at IS NULL AND 'confirm-close' = ANY(tags)`, [keep]);
    kept = r.rowCount;
  }
  return { closed, kept };
}

async function stats(db, user, now) {
  const me = Number(user && user.id) || TOBY;
  const asOf = londonToday(now);
  const { rows: [a] } = await db.query(
    `SELECT count(*) FILTER (WHERE resolved_by = $1 AND dropped_at IS NULL AND resolved_at > now() - interval '7 days' AND NOT ('confirm-close' = ANY(tags)))::int AS done_week,
            coalesce(sum(carried_days) FILTER (WHERE resolved_at IS NULL AND owner_staff_id = $1), 0)::int AS carried,
            count(*) FILTER (WHERE resolved_at IS NULL AND dropped_at IS NULL AND due_date < $2::date AND owner_staff_id = $1 AND NOT ('confirm-close' = ANY(tags)))::int AS real_missed
       FROM attention_items WHERE ${KIND_SQL} IN ('job','decision')`, [me, asOf]);
  const { rows: [d] } = await db.query(
    `SELECT coalesce(sum(plan_hit),0)::int AS hit, coalesce(sum(plan_missed),0)::int AS missed FROM mylist_days WHERE staff_id = $1`, [me]);
  const { rows: [n] } = await db.query(
    `SELECT count(*)::int AS sends, count(*) FILTER (WHERE response IS NOT NULL)::int AS taps,
            count(*) FILTER (WHERE event = 'selfmute')::int AS self_mutes FROM mylist_nudges WHERE staff_id = $1`, [me]);
  const judged = d.hit + d.missed;
  return {
    ok: true, sends: n.sends, taps: n.taps, tap_rate: n.sends ? Math.round(100 * n.taps / n.sends) : null,
    done_this_week: a.done_week, carried: a.carried,
    plan_hit_rate: judged ? Math.round(100 * d.hit / judged) : null,
    real_deadlines_missed: a.real_missed, self_mutes: n.self_mutes,
  };
}

module.exports = { TOBY, SETTING_DEFAULTS, ACTIONS, getSettings, setSetting, buildMyList, writeThrough, patch, capture, closeBatch, stats, shape, fail };
