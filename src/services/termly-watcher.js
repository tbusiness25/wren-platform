'use strict';
/**
 * termly-watcher.js — b277 (2026-09-04)
 *
 * Toby, 2026-09-04: "can you create a watcher, that activates once the staff
 * member has done the termly update. It grabs the data from Eylog, puts it into
 * a termly update document along with the terms planning … then goes out to
 * parents on Wren."
 *
 * ── WHAT IT WATCHES, AND WHY THERE ARE TWO WAYS IN ──────────────────────────
 * A completion can reach Wren by two routes that have nothing in common:
 *
 *   the hook   a practitioner ticks "Termly Update & Tracking" in Wren. There is
 *              an HTTP request, so the watcher runs on it, and the family has the
 *              document seconds later.
 *   the sweep  the EyLog nightly sync (02:30, /app/eylog-sync.sh) upserts
 *              rows straight into ladn.observations. NOTHING calls Wren. Without
 *              a sweep the EyLog leg would simply never fire, which is the whole
 *              half of the brief that is about EyLog.
 *
 * Both funnel through processCompletion(), so a document made by the hook and one
 * made by the sweep are the same document. The sweep is also the repair path: it
 * picks up anything the hook missed because the server was restarting.
 *
 * ── THIS IS NOT b93 ─────────────────────────────────────────────────────────
 * b93's nightly engine wrote 63 drafts nobody has ever finalised, and b246
 * deliberately shipped with no cron for that reason. The difference is what
 * starts the work. b93 swept for children who MIGHT need a report and produced
 * machine prose speculatively. This sweeps for children whose key person HAS
 * ALREADY WRITTEN one, and packages what they wrote. It cannot produce a document
 * for a child nobody has written about — detectCompletions() returns nothing, and
 * nothing is what happens.
 *
 * ── IDEMPOTENCE IS A DATABASE FACT ──────────────────────────────────────────
 * reports_termly_update_cycle_uq (b246) is UNIQUE (child_id, cycle_key) WHERE
 * report_type='termly_update'. The insert is ON CONFLICT DO UPDATE returning
 * xmax=0, so "did I create this?" is answered by Postgres and not by a
 * check-then-insert that two sweeps could both win. Re-completing an update does
 * not make a second document — verified by scripts/b277-verify.js.
 *
 * ── GDPR ────────────────────────────────────────────────────────────────────
 * Every log line in this file prints ids and counts. No child's name, no staff
 * name, no observation text — including in the error paths, which is where that
 * discipline usually breaks. See memory/feedback_counts_only_every_write_path.
 * The one optional model call is in src/lib/termly-watch-document.js and goes
 * through sovereign-model.js, which cannot address a public host.
 */

const { getPool } = require('../db/pool');
const { notify } = require('./notification-dispatcher');
const TC = require('../lib/termly-cycle');
const TS = require('../lib/termly-sources');
const TU = require('../lib/termly-update');
const TWD = require('../lib/termly-watch-document');
const TT = require('./termly-tracker');

const LOG = '[b277-watcher]';
const REPORT_TYPE = 'termly_update';

// ── Settings this service reads (the rest live in termly-sources.js) ─────────
const S = {
  release:      'termly_watcher_release',
  aiHome:       'termly_watcher_ai_home_ideas',
  interval:     'termly_watcher_interval_minutes',
  nsDays:       'termly_next_steps_reminder_days',
  model:        'termly_watcher_model',
};

async function loadWatcherConfig(db) {
  // b404-C (Toby, 17 Oct 2026): the watcher NEVER shares on its own. A termly update
  // is approved by a room leader (POST /api/termly-update/:id/send) before a family
  // sees it, so `release` is pinned to 'review'. The termly_watcher_release setting
  // is still read and reported (release_setting) but no longer obeyed — a stale
  // 'auto' row, or none at all (prod has no row), cannot switch auto-share back on.
  const cfg = { release: 'review', release_setting: null, ai_home_ideas: false, interval_minutes: 60,
                next_steps_days: 14, model: null };
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [Object.values(S)]);
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    cfg.release_setting = String(m[S.release] || '').toLowerCase() || null;   // reported, not obeyed (b404-C)
    cfg.ai_home_ideas = /^(on|true|1|yes)$/i.test(String(m[S.aiHome] || '').trim());
    const iv = parseInt(m[S.interval], 10);
    if (Number.isFinite(iv) && iv >= 5) cfg.interval_minutes = iv;
    const nd = parseInt(m[S.nsDays], 10);
    if (Number.isFinite(nd) && nd >= 0) cfg.next_steps_days = nd;
    // Empty means "use the default" (ai-models.js role 'heavy', b333). A named
    // model overrides it for this feature alone — the inherited default was
    // once pulled off the Ascent and a settings row is a cheaper fix for that
    // than a deploy.
    const mdl = String(m[S.model] || '').trim();
    if (mdl) cfg.model = mdl;
  } catch (_) { /* defaults */ }
  return cfg;
}

// ═══════════════════════════════════════════════════════════════════════════
// One completion → one document
// ═══════════════════════════════════════════════════════════════════════════
const _inFlight = new Set();

/**
 * @returns {Promise<object>} { child_id, report_id, created, published, state, reason }
 */
async function processCompletion(db, signal, ctx = {}) {
  const cycle = ctx.cycle;
  const key = `${signal.child_id}:${cycle.key}`;
  if (_inFlight.has(key)) return { child_id: signal.child_id, state: 'in_flight' };
  _inFlight.add(key);
  try {
    const wcfg = ctx.watcherConfig || await loadWatcherConfig(db);

    // ── 1 · claim the row ───────────────────────────────────────────────────
    // The unique index does the deduplication. A row that already exists comes
    // back with inserted=false and is NOT rewritten: a document that has been
    // sent is the record of what a family was told, and a draft somebody is
    // editing is theirs.
    const claim = await db.query(`
      INSERT INTO reports (child_id, staff_id, report_type, cycle_key, status,
                           assigned_staff_id, lifecycle_status, ai_generated,
                           shared_with_parents, source, content, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'drafting', $2, 'draft', false, false, 'wren', $5::jsonb, now(), now())
      ON CONFLICT (child_id, cycle_key) WHERE report_type = 'termly_update' AND cycle_key IS NOT NULL
        DO UPDATE SET updated_at = reports.updated_at
      RETURNING id, status, sent_at, (xmax = 0) AS inserted`,
      [signal.child_id, signal.staff_id || null, REPORT_TYPE, cycle.key,
       JSON.stringify({ kind: 'termly_update', variant: 'watched', version: 1,
                        status_note: 'Assembling…',
                        cycle: { key: cycle.key, label: cycle.label } })]);
    const row = claim.rows[0];

    if (!row.inserted) {
      if (row.status === 'sent') {
        return { child_id: signal.child_id, report_id: row.id, created: false, published: false,
                 state: 'already_sent',
                 reason: 'This child already has a termly update for this half-term and it has been sent.' };
      }
      // A b246 draft a practitioner is working on. The watcher stays out of it —
      // overwriting somebody's half-finished review with a fresh assembly is the
      // single most annoying thing this service could do.
      return { child_id: signal.child_id, report_id: row.id, created: false, published: false,
               state: 'already_open',
               reason: 'A termly update for this half-term is already open for review; the watcher left it alone.' };
    }

    // ── 2 · assemble ────────────────────────────────────────────────────────
    let content;
    try {
      content = await TWD.assemble(db, {
        cycle, completion: signal, on: ctx.on,
        aiHomeIdeas: wcfg.ai_home_ideas,
        model: wcfg.model || undefined,
      });
    } catch (e) {
      // Never leave a row stuck in 'drafting' — that is a document nobody can
      // see and nothing will retry. Put it in front of the key person instead.
      await db.query(`
        UPDATE reports
           SET status='awaiting_review', lifecycle_status='draft',
               content = COALESCE(content,'{}'::jsonb) ||
                         jsonb_build_object('kind','termly_update','variant','watched',
                                            'assemble_error', $2::text),
               updated_at = now()
         WHERE id = $1 AND status = 'drafting'`, [row.id, e.message]);
      console.error(`${LOG} assemble failed report=${row.id} child=${signal.child_id}: ${e.message}`);
      return { child_id: signal.child_id, report_id: row.id, created: true, published: false,
               state: 'assemble_failed', reason: e.message };
    }

    // ── 3 · publish, or hand to review ──────────────────────────────────────
    const gate = TWD.canPublish(content);
    const wantAuto = wcfg.release === 'auto';
    const publish = wantAuto && gate.ok;

    if (publish) {
      content.sent = { by_staff_id: signal.staff_id || null, at: new Date().toISOString(), via: 'termly-watcher' };
      content.status_note = null;
      await db.query(`
        UPDATE reports
           SET content=$2, status='sent', sent_at=now(), shared_with_parents=true,
               lifecycle_status='pending_parent_review', ai_generated=$3, updated_at=now()
         WHERE id=$1`, [row.id, JSON.stringify(content), !!content.modelled]);

      // The family. notify() resolves 'parent' + child_id to that child's
      // contacts — the same call b246's send uses, so the parent gating is the
      // one that is already in production rather than a second one written here.
      try {
        notify('report_shared', 'parent', signal.child_id,
          'This term\'s update is ready',
          `${(content.cycle && content.cycle.label) || 'This term'}'s update from your child's key person is `
          + 'ready to read — what they have been doing, what the room has been working on, their next steps '
          + 'and where they are in their learning. You can read it in the app.',
          { relatedTable: 'reports', relatedId: row.id, link: '/welcome/termly-update' });
      } catch (e) { console.error(`${LOG} parent notify failed report=${row.id}: ${e.message}`); }

      console.log(`${LOG} published report=${row.id} child=${signal.child_id} cycle=${cycle.key} `
        + `src=${signal.source} matched=${signal.matched_by} on_time=${content.watcher.on_time}`);
      return { child_id: signal.child_id, report_id: row.id, created: true, published: true,
               state: 'published', on_time: content.watcher.on_time, source: signal.source };
    }

    // Review path — either the setting says so, or something Wren wrote is in it.
    content.status_note = 'Assembled from your termly update. Read it, then send it to your room leader — '
      + 'a family only sees it once a room leader has approved it.';
    content.publish_blocked_by = gate.problems;
    await db.query(`
      UPDATE reports
         SET content=$2, status='awaiting_review', lifecycle_status='draft',
             ai_generated=$3, assigned_staff_id=COALESCE(assigned_staff_id, $4), updated_at=now()
       WHERE id=$1`, [row.id, JSON.stringify(content), !!content.modelled, signal.staff_id || null]);

    const target = signal.staff_id || null;
    const title = 'Termly update ready to send';
    const body = 'Wren has put this term\'s update together from what you wrote, the room\'s plan for '
      + 'this half-term, the child\'s next steps and their tracker. '
      + (gate.ok ? 'Read it and send it to your room leader — a family only sees it once they have approved it.'
                 : 'Two things need you first: ' + gate.problems.slice(0, 2).join(' '));
    try {
      if (target) {
        notify('termly_update_draft', 'staff', target, title, body,
          { priority: 'normal', relatedTable: 'children', relatedId: signal.child_id,
            link: `/ey/termly-update?id=${row.id}` });
      } else {
        notify('termly_update_draft', 'all-managers', null, title,
          body + ' (Wren could not tell which staff member wrote it.)',
          { priority: 'normal', relatedTable: 'children', relatedId: signal.child_id,
            link: `/ey/termly-update?id=${row.id}` });
      }
    } catch (e) { console.error(`${LOG} staff notify failed report=${row.id}: ${e.message}`); }

    console.log(`${LOG} to_review report=${row.id} child=${signal.child_id} cycle=${cycle.key} `
      + `src=${signal.source} blocked=${gate.problems.length}`);
    return { child_id: signal.child_id, report_id: row.id, created: true, published: false,
             state: 'awaiting_review', reason: gate.problems[0] || null, source: signal.source };
  } finally {
    _inFlight.delete(key);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The sweep — what catches EyLog
// ═══════════════════════════════════════════════════════════════════════════
/**
 * @param {object} opts { on, cycleKey, dryRun, childIds, limit }
 */
async function sweep(db, opts = {}) {
  const on = TC.ymd(opts.on) || TC.ymd(new Date());
  const sourceCfg = await TS.loadSourceConfig(db);
  const watcherCfg = await loadWatcherConfig(db);

  if (!sourceCfg.enabled && !opts.force) {
    return { on, ran: false, reason: 'termly_watcher_enabled is off', cycle: null, results: [] };
  }

  const { cycles } = await TC.loadCycles(db);
  const cycle = opts.cycleKey ? TC.cycleByKey(cycles, String(opts.cycleKey)) : TC.currentCycle(cycles, on);
  const calendar = TC.calendarHealth(cycles, on);
  if (!cycle) {
    return { on, ran: false, reason: calendar.message || 'no cycle covers this date',
             cycle: null, calendar, results: [] };
  }

  let signals;
  try {
    signals = await TS.detectCompletions(db, cycle, {
      config: sourceCfg, window_to: on, childIds: opts.childIds, limit: opts.limit,
    });
  } catch (e) {
    console.error(`${LOG} source query failed cycle=${cycle.key}: ${e.code || ''} ${e.message}`);
    return { on, ran: false, cycle, calendar, results: [],
             reason: `A completion source could not be read (${e.code || e.message}). `
                   + 'Check settings.termly_watcher_eylog_text_re — an invalid regular expression there is the usual cause.' };
  }

  // Which of those already have a document for this cycle. One query, not one
  // per child: the sweep runs hourly and on prod this list is the whole roll.
  const ids = signals.map(s => s.child_id);
  const have = new Map();
  if (ids.length) {
    const { rows } = await db.query(`
      SELECT child_id, id, status FROM reports
       WHERE report_type=$1 AND cycle_key=$2 AND child_id = ANY($3::int[])`,
      [REPORT_TYPE, cycle.key, ids]);
    for (const r of rows) have.set(Number(r.child_id), r);
  }

  const todo = signals.filter(s => !have.has(Number(s.child_id)));

  if (opts.dryRun) {
    return {
      on, ran: true, dry_run: true, cycle: slimCycle(cycle), calendar,
      sources: TS.describeSources(sourceCfg),
      counts: { detected: signals.length, already_have: signals.length - todo.length, would_create: todo.length },
      // Ids only. A dry run is a diagnostic and diagnostics get read into logs.
      results: todo.map(s => ({ child_id: s.child_id, source: s.source, matched_by: s.matched_by,
                                completed_on: s.completed_on, observation_id: s.observation_id })),
    };
  }

  const results = [];
  for (const sig of todo) {
    try {
      results.push(await processCompletion(db, sig, { cycle, on, watcherConfig: watcherCfg }));
    } catch (e) {
      console.error(`${LOG} completion failed child=${sig.child_id} cycle=${cycle.key}: ${e.message}`);
      results.push({ child_id: sig.child_id, state: 'error', reason: e.message });
    }
  }

  const counts = results.reduce((m, r) => (m[r.state] = (m[r.state] || 0) + 1, m), {});
  if (results.length) {
    console.log(`${LOG} sweep cycle=${cycle.key} detected=${signals.length} processed=${results.length} `
      + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
  }
  return {
    on, ran: true, cycle: slimCycle(cycle), calendar,
    sources: TS.describeSources(sourceCfg),
    release: watcherCfg.release, release_setting: watcherCfg.release_setting, ai_home_ideas: watcherCfg.ai_home_ideas,
    counts: Object.assign({ detected: signals.length, already_have: signals.length - todo.length }, counts),
    results,
  };
}

function slimCycle(c) {
  return { key: c.key, label: c.label, name: c.name, academic_year: c.academic_year,
           opens_on: c.opens_on, due_on: c.due_on, overdue_on: c.overdue_on, closes_on: c.closes_on };
}

/**
 * The hook. Called (fire-and-forget) from src/routes/observations.js the moment
 * an observation is saved or edited with the termly-update flag on.
 *
 * Deliberately takes ids and nothing else: the route hands over a child id and
 * an observation id, and this re-reads everything from the database. Passing the
 * request body through would let a client decide what went in a parent's
 * document.
 */
async function onObservationCompleted(childId, observationId) {
  const db = getPool();
  try {
    const sourceCfg = await TS.loadSourceConfig(db);
    if (!sourceCfg.enabled) return null;
    const on = TC.ymd(new Date());
    const { cycles } = await TC.loadCycles(db);
    const cycle = TC.currentCycle(cycles, on);
    if (!cycle) {
      console.log(`${LOG} hook skipped child=${childId} — no cycle covers ${on}`);
      return null;
    }
    const sig = await TS.detectForChild(db, cycle, childId, { config: sourceCfg, window_to: on });
    if (!sig) return null;
    // The hook fires on the observation that was just saved, but the COMPLETION
    // is the earliest flagged one in the cycle (see termly-sources.js). If they
    // differ, the earlier one wins — the same answer the sweep would give, so
    // the two paths cannot produce different documents for the same child.
    if (observationId && Number(sig.observation_id) !== Number(observationId)) {
      console.log(`${LOG} hook child=${childId} using earlier completion obs=${sig.observation_id}`);
    }
    return await processCompletion(db, sig, { cycle, on });
  } catch (e) {
    console.error(`${LOG} hook failed child=${childId}: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NEXT TERM, WREN-NATIVE — the two things that replace EyLog's own chasing
// ═══════════════════════════════════════════════════════════════════════════
/**
 * "staff get reminders if they havent done next steps by the end of term".
 *
 * Runs inside the last `termly_next_steps_reminder_days` of a half-term (14 by
 * default) and nudges each key person about children whose next steps are still
 * open. One notification per key person, refreshed in place, cleared when they
 * are done — the same no-spam contract as the b246 drainer, which is the one
 * staff are already used to.
 *
 * A next step is "not done" when its status is still 'pending'. That is the
 * practitioner's own word for it; nothing here second-guesses it.
 */
async function nextStepsSweep(db, opts = {}) {
  const on = TC.ymd(opts.on) || TC.ymd(new Date());
  const wcfg = opts.watcherConfig || await loadWatcherConfig(db);
  const { cycles } = await TC.loadCycles(db);
  const cycle = opts.cycleKey ? TC.cycleByKey(cycles, String(opts.cycleKey)) : TC.currentCycle(cycles, on);
  if (!cycle) return { on, ran: false, reason: 'no cycle covers this date' };

  const daysLeft = TC.daysBetween(on, cycle.closes_on);
  const inWindow = daysLeft != null && daysLeft >= 0 && daysLeft <= wcfg.next_steps_days;
  if (!inWindow && !opts.force) {
    return { on, ran: false, cycle: slimCycle(cycle), days_left: daysLeft,
             reason: `not within ${wcfg.next_steps_days} days of the end of ${cycle.label}` };
  }

  // Open next steps set during this half-term, grouped by key person. Steps
  // older than the half-term are excluded on purpose: chasing somebody in
  // December about a step written in September is a different conversation, and
  // it belongs to the supervision cycle rather than to a term-end nudge.
  const { rows } = await db.query(`
    SELECT c.key_person_id                             AS staff_id,
           kp.first_name || ' ' || kp.last_name        AS staff_name,
           count(*)                                    AS open_steps,
           count(DISTINCT n.child_id)                  AS children
      FROM next_steps n
      JOIN children c ON c.id = n.child_id AND c.is_active = true
      LEFT JOIN staff kp ON kp.id = c.key_person_id
     WHERE n.status = 'pending'
       AND n.created_at >= $1::date
       AND c.key_person_id IS NOT NULL
     GROUP BY c.key_person_id, kp.first_name, kp.last_name
     ORDER BY count(*) DESC`, [cycle.opens_on]);

  let created = 0, refreshed = 0, cleared = 0;
  const seen = new Set();

  for (const r of rows) {
    seen.add(Number(r.staff_id));
    const n = Number(r.open_steps), kids = Number(r.children);
    const title = `${n} next step${n === 1 ? '' : 's'} still open — ${cycle.label} ends ${TCfmt(cycle.closes_on)}`;
    const body = `${cycle.label} ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'} and you have ${n} `
      + `next step${n === 1 ? '' : 's'} still open across ${kids} ${kids === 1 ? 'child' : 'children'}. `
      + 'Close the ones that are done and carry the rest forward, so this term\'s updates go out with '
      + 'next steps that are actually current.';

    const { rows: ex } = await db.query(`
      SELECT id, created_at FROM notifications
       WHERE category='termly_next_steps_due' AND recipient_type='staff' AND recipient_id=$1
         AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [r.staff_id]);

    if (!ex.length) {
      notify('termly_next_steps_due', 'staff', r.staff_id, title, body,
        { priority: daysLeft <= 3 ? 'high' : 'normal', link: '/ey/next-steps' });
      created++;
    } else {
      await db.query(`UPDATE notifications SET title=$1, body=$2, priority=$3 WHERE id=$4`,
        [title, body, daysLeft <= 3 ? 'high' : 'normal', ex[0].id]);
      refreshed++;
    }
  }

  // Anybody who has cleared theirs since the last pass.
  const { rowCount } = await db.query(`
    UPDATE notifications SET dismissed_at=NOW()
     WHERE category='termly_next_steps_due' AND dismissed_at IS NULL
       AND (recipient_id IS NULL OR NOT (recipient_id = ANY($1::int[])))`,
    [seen.size ? [...seen] : [-1]]);
  cleared = rowCount;

  console.log(`${LOG} next-steps cycle=${cycle.key} days_left=${daysLeft} staff=${rows.length} `
    + `created=${created} refreshed=${refreshed} cleared=${cleared}`);
  return { on, ran: true, cycle: slimCycle(cycle), days_left: daysLeft,
           staff: rows.length, created, refreshed, cleared };
}

function TCfmt(ymd) {
  if (!ymd) return '';
  const d = new Date(ymd + 'T00:00:00');
  return isNaN(d) ? ymd : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

/**
 * "I get termly reports on staff missed dates etc".
 *
 * Fires once per half-term, on the day it closes, to the management team: how
 * many updates were owed, how many went out, how many were late and by how much,
 * and who missed what. One notification per cycle — deduped on related_id =
 * the half-term's calendar id, so a restart on the same day cannot send it twice.
 */
async function managerReportSweep(db, opts = {}) {
  const on = TC.ymd(opts.on) || TC.ymd(new Date());
  const { cycles } = await TC.loadCycles(db);
  const cycle = opts.cycleKey ? TC.cycleByKey(cycles, String(opts.cycleKey)) : TC.currentCycle(cycles, on);
  if (!cycle) return { on, ran: false, reason: 'no cycle covers this date' };
  if (on < cycle.closes_on && !opts.force) {
    return { on, ran: false, cycle: slimCycle(cycle), reason: `${cycle.label} has not closed yet` };
  }

  const { rows: ex } = await db.query(`
    SELECT id FROM notifications
     WHERE category='termly_update_report' AND related_table='school_terms' AND related_id=$1
     ORDER BY id DESC LIMIT 1`, [cycle.half_term_id]);
  if (ex.length && !opts.force) {
    return { on, ran: false, cycle: slimCycle(cycle), reason: 'already sent for this half-term' };
  }

  const report = await TT.termReport(db, { cycleKey: cycle.key, on });
  const t = report.totals;
  const late = report.staff.filter(s => s.late > 0 || s.outstanding > 0);

  const title = `${cycle.label} termly updates: ${t.done} of ${t.owed} done, ${t.late} late`;
  const lines = [
    `${cycle.label} closed on ${TCfmt(cycle.closes_on)}. Updates were due ${TCfmt(cycle.due_on)}.`,
    `${t.done} of ${t.owed} went out. ${t.on_time} on time, ${t.late} late, ${t.outstanding} never written.`,
  ];
  if (t.late) lines.push(`The latest was ${t.worst_days_late} day${t.worst_days_late === 1 ? '' : 's'} past the due date.`);
  for (const s of late.slice(0, 8)) {
    lines.push(`• ${s.name}: ${s.done}/${s.owed} done`
      + (s.late ? `, ${s.late} late (avg ${s.avg_days_late}d)` : '')
      + (s.outstanding ? `, ${s.outstanding} not written` : ''));
  }
  if (late.length > 8) lines.push(`…and ${late.length - 8} more. Open the tracker for the full list.`);
  if (!late.length) lines.push('Every key person got theirs out. Nothing outstanding.');

  notify('termly_update_report', 'all-managers', null, title, lines.join('\n'),
    { priority: 'normal', relatedTable: 'school_terms', relatedId: cycle.half_term_id,
      link: `/ey/termly-tracker?cycle_key=${encodeURIComponent(cycle.key)}` });

  console.log(`${LOG} term report cycle=${cycle.key} owed=${t.owed} done=${t.done} `
    + `on_time=${t.on_time} late=${t.late} outstanding=${t.outstanding}`);
  return { on, ran: true, cycle: slimCycle(cycle), totals: t, staff_flagged: late.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// The loop
// ═══════════════════════════════════════════════════════════════════════════
/**
 * One pass = the document sweep, then the two next-term jobs. Each is guarded by
 * its own window, so running all three every hour costs three cheap queries on
 * the days they have nothing to do.
 */
async function runOnce(db, opts = {}) {
  const out = { at: new Date().toISOString() };
  try { out.sweep = await sweep(db, opts); }
  catch (e) { out.sweep = { error: e.message }; console.error(`${LOG} sweep error: ${e.message}`); }
  try { out.next_steps = await nextStepsSweep(db, opts); }
  catch (e) { out.next_steps = { error: e.message }; console.error(`${LOG} next-steps error: ${e.message}`); }
  try { out.report = await managerReportSweep(db, opts); }
  catch (e) { out.report = { error: e.message }; console.error(`${LOG} report error: ${e.message}`); }
  return out;
}

let _timer = null;
let _running = false;

function startTermlyWatcher(opts = {}) {
  if (process.env.TERMLY_WATCHER_DISABLED) {
    console.log(`${LOG} disabled by env`);
    return;
  }
  // Not an EYFS setting — a primary or secondary edition has no termly update in
  // this sense and must not have one invented for it. Same gate b246's router uses.
  if (!TU.isEyfsEdition()) {
    console.log(`${LOG} not started — ${TU.editionFamily()} edition`);
    return;
  }

  const tick = async () => {
    if (_running) return;
    _running = true;
    try {
      const db = getPool();
      await runOnce(db);
    } catch (e) {
      console.error(`${LOG} tick failed: ${e.message}`);
    } finally { _running = false; }
  };

  // The first pass is delayed. At boot the pool may still be warming and every
  // other drainer is doing its own first pass; a termly sweep is never urgent to
  // the second, and the EyLog rows it is really waiting for land at 02:30.
  const delay = parseInt(process.env.TERMLY_WATCHER_START_DELAY_MS || '45000', 10);
  const fallbackMs = (parseInt(process.env.TERMLY_WATCHER_INTERVAL_MIN || '', 10)
    || opts.intervalMinutes || 60) * 60000;

  setTimeout(() => {
    tick().catch(() => {});
    // The interval comes from settings, read once at start. Changing it is a
    // restart, which is the honest trade for not re-reading a settings row every
    // sixty minutes for a value that changes about never.
    getPool().query(`SELECT value FROM settings WHERE key=$1`, [S.interval])
      .then(({ rows }) => {
        const m = parseInt(rows[0] && rows[0].value, 10);
        const ms = (Number.isFinite(m) && m >= 5 ? m : 60) * 60000;
        _timer = setInterval(tick, ms);
        console.log(`${LOG} started (every ${ms / 60000} min)`);
      })
      .catch(() => {
        _timer = setInterval(tick, fallbackMs);
        console.log(`${LOG} started (every ${fallbackMs / 60000} min, settings unreadable)`);
      });
  }, delay);
}

function stopTermlyWatcher() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = {
  startTermlyWatcher, stopTermlyWatcher, runOnce,
  sweep, processCompletion, onObservationCompleted,
  nextStepsSweep, managerReportSweep,
  loadWatcherConfig,
};
