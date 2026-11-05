'use strict';
// ===========================================================================
// detail-campaigns.js — b502. Reminder campaigns that repeat until each family has filled the items in.
//
// AUTOMATED, so this follows Toby's explicit rule (memory feedback_no_auto_email_to_parents):
//   * NOTHING starts automatically. A manager creates a campaign in Roost, sees a PREVIEW (the exact message, who it would reach,
//     the schedule) and presses Start. That one press is the human authorisation for that campaign's repeats.
//   * The only thing it ever sends is an IN-APP bell notification (category details_outstanding), plus a push to a parent who
//     switched push on for "Details we still need". There is NO email path: this file never touches a mailer, the category is on the
//     parent email BLOCK list, and detail_campaign_log.channel is 'bell'.
//   * Each family's reminders STOP BY THEMSELVES the moment their items are complete (the engine is live), and everything stops at the
//     deadline. Pause / resume / stop are one press each.
//   * The message names no child and no parent.
//
// Cadence: every `cadence_days` (default 2) plus the final day. Reminders go out 08:00-18:00 London.
// ===========================================================================

const TZ = 'Europe/London';
const OUT = require('./outstanding');

async function clock(db, override) {
  if (override) return override;
  const { rows: [r] } = await db.query(`SELECT (now() AT TIME ZONE $1)::date::text AS today, extract(hour FROM now() AT TIME ZONE $1)::int AS hour`, [TZ]);
  return r;
}
const dayDiff = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function validCodes(codes) {
  const ok = Object.keys(OUT.CODES).filter(c => OUT.CODES[c].who === 'parent');
  const list = (Array.isArray(codes) ? codes : String(codes || '').split(',')).map(s => String(s).trim()).filter(Boolean);
  const bad = list.filter(c => !ok.includes(c));
  return { list: [...new Set(list)], bad, allowed: ok };
}

async function load(db, id) {
  const { rows: [c] } = await db.query(`SELECT *, deadline::text AS deadline FROM detail_campaigns WHERE id=$1`, [id]);
  return c || null;
}

/** Families that currently have at least one of the campaign's items outstanding. */
async function currentFamilies(db, campaign) {
  return OUT.forChildren(db, { codes: campaign.codes, who: 'parent' });
}

async function progress(db, c) {
  const { rows: [t] } = await db.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE completed_at IS NOT NULL)::int AS complete FROM detail_campaign_targets WHERE campaign_id=$1`, [c.id]);
  const { rows: [l] } = await db.query(
    `SELECT count(*)::int AS reminders, count(DISTINCT child_id)::int AS families_reminded, max(sent_at) AS last_sent FROM detail_campaign_log WHERE campaign_id=$1`, [c.id]);
  const outstandingNow = (await currentFamilies(db, c)).length;
  return { targets: t.total, complete: t.complete, outstanding_now: outstandingNow, reminders_sent: l.reminders, families_reminded: l.families_reminded, last_sent: l.last_sent };
}

async function list(db) {
  const { rows } = await db.query(`SELECT *, deadline::text AS deadline FROM detail_campaigns ORDER BY (status='running') DESC, id DESC`);
  const out = [];
  for (const c of rows) out.push(Object.assign({}, c, { progress: await progress(db, c) }));
  return out;
}

async function detail(db, id) {
  const c = await load(db, id);
  if (!c) return null;
  const fams = await currentFamilies(db, c);
  const { rows: log } = await db.query(
    `SELECT child_id, count(*)::int AS n, max(sent_at) AS last FROM detail_campaign_log WHERE campaign_id=$1 GROUP BY child_id`, [id]);
  const by = new Map(log.map(r => [Number(r.child_id), r]));
  const { rows: done } = await db.query(`SELECT child_id, completed_at FROM detail_campaign_targets WHERE campaign_id=$1 AND completed_at IS NOT NULL ORDER BY completed_at DESC`, [id]);
  const kids = await OUT.forChildren(db, { childIds: done.map(d => Number(d.child_id)), includeComplete: true });
  return Object.assign({}, c, {
    progress: await progress(db, c),
    outstanding: fams.map(f => ({ child_id: f.child_id, name: f.name, room_name: f.room_name,
      items: f.items.map(i => i.label), reminders: (by.get(f.child_id) || {}).n || 0, last_reminder: (by.get(f.child_id) || {}).last || null })),
    completed: kids.map(k => ({ child_id: k.child_id, name: k.name, room_name: k.room_name })),
  });
}

async function create(db, user, body) {
  const b = body || {};
  const v = validCodes(b.codes);
  if (!String(b.title || '').trim()) return { status: 400, error: 'title required' };
  if (!v.list.length) return { status: 400, error: 'choose at least one item to chase' };
  if (v.bad.length) return { status: 400, error: `Not a parent item: ${v.bad.join(', ')}`, allowed: v.allowed };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.deadline || ''))) return { status: 400, error: 'deadline (YYYY-MM-DD) required' };
  const cad = Math.max(1, Math.min(14, parseInt(b.cadence_days, 10) || 2));
  const mt = String(b.message_title || 'Some details are still needed').slice(0, 120);
  const mb = String(b.message_body || 'The nursery is still waiting for some details for your child. Please open the app and finish the items under To do on the home screen.').slice(0, 600);
  const { rows: [c] } = await db.query(
    `INSERT INTO detail_campaigns (title, codes, message_title, message_body, deadline, cadence_days, final_day, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8) RETURNING *, deadline::text AS deadline`,
    [String(b.title).trim().slice(0, 160), v.list, mt, mb, b.deadline, cad, b.final_day !== false, user && user.id || null]);
  return { status: 201, campaign: c };
}

async function update(db, id, body) {
  const c = await load(db, id);
  if (!c) return { status: 404, error: 'Not found' };
  if (['ended', 'stopped'].includes(c.status)) return { status: 409, error: `A ${c.status} campaign cannot be changed. Create a new one.` };
  const b = body || {}, sets = [], vals = [];
  const put = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (b.deadline !== undefined) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.deadline))) return { status: 400, error: 'bad deadline' }; put('deadline', b.deadline); }
  if (b.cadence_days !== undefined) put('cadence_days', Math.max(1, Math.min(14, parseInt(b.cadence_days, 10) || 2)));
  if (b.final_day !== undefined) put('final_day', !!b.final_day);
  if (b.title !== undefined) put('title', String(b.title).slice(0, 160));
  if (b.message_title !== undefined) put('message_title', String(b.message_title).slice(0, 120));
  if (b.message_body !== undefined) put('message_body', String(b.message_body).slice(0, 600));
  if (b.codes !== undefined) { const v = validCodes(b.codes); if (!v.list.length || v.bad.length) return { status: 400, error: 'codes must be parent items', allowed: v.allowed }; put('codes', v.list); }
  if (!sets.length) return { status: 400, error: 'nothing to change' };
  vals.push(id);
  const { rows: [r] } = await db.query(`UPDATE detail_campaigns SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *, deadline::text AS deadline`, vals);
  return { status: 200, campaign: r };
}

/** Exactly what would happen if a manager pressed Start now. Names are for the manager's eyes inside Wren only. */
async function preview(db, id, clk) {
  const c = await load(db, id);
  if (!c) return null;
  const now = await clock(db, clk);
  const fams = await currentFamilies(db, c);
  const { rows: log } = await db.query(`SELECT child_id, count(*)::int AS n, max(sent_at) AS last FROM detail_campaign_log WHERE campaign_id=$1 GROUP BY child_id`, [id]);
  const by = new Map(log.map(r => [Number(r.child_id), r]));
  const schedule = [];
  if (now.today <= c.deadline) {
    for (let d = now.today; d <= c.deadline; d = addDays(d, c.cadence_days)) schedule.push(d);
    if (c.final_day && schedule[schedule.length - 1] !== c.deadline) schedule.push(c.deadline);
  }
  return {
    campaign: { id: c.id, title: c.title, status: c.status, deadline: c.deadline, cadence_days: c.cadence_days, final_day: c.final_day, codes: c.codes },
    message: { title: c.message_title, body: c.message_body },
    channels: { bell: true, push: 'only for a parent who chose push under "Details we still need"', email: 'never' },
    deadline_passed: now.today > c.deadline,
    families: fams.map(f => ({ child_id: f.child_id, name: f.name, room_name: f.room_name, items: f.items.map(i => i.label),
      reminders_so_far: (by.get(f.child_id) || {}).n || 0, last_reminder: (by.get(f.child_id) || {}).last || null })),
    family_count: fams.length,
    schedule_dates: schedule,
    stops_when: 'each family stops being reminded as soon as their items are complete; everything stops after the deadline',
  };
}

async function launch(db, user, id, clk) {
  const c = await load(db, id);
  if (!c) return { status: 404, error: 'Not found' };
  if (!['draft', 'paused'].includes(c.status)) return { status: 409, error: `This campaign is ${c.status}.` };
  const now = await clock(db, clk);
  if (now.today > c.deadline) return { status: 400, error: 'deadline_passed', message: `The deadline (${c.deadline}) has passed. Set a new deadline first.` };
  const fams = await currentFamilies(db, c);
  for (const f of fams) await db.query(`INSERT INTO detail_campaign_targets (campaign_id, child_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, f.child_id]);
  const { rows: [r] } = await db.query(
    `UPDATE detail_campaigns SET status='running', started_by=COALESCE(started_by,$2::int), started_at=COALESCE(started_at, now()), paused_at=NULL WHERE id=$1 RETURNING *, deadline::text AS deadline`, [id, user && user.id || null]);
  return { status: 200, campaign: r, targets: fams.length };
}
async function setStatus(db, id, from, to, stamp) {
  const { rows: [r] } = await db.query(`UPDATE detail_campaigns SET status=$3 ${stamp ? `, ${stamp}=now()` : ''} WHERE id=$1 AND status = ANY($2::text[]) RETURNING *, deadline::text AS deadline`, [id, from, to]);
  return r || null;
}
const pause = (db, id) => setStatus(db, id, ['running'], 'paused', 'paused_at');
const stop = (db, id) => setStatus(db, id, ['draft', 'paused', 'running'], 'stopped', 'stopped_at');
async function resume(db, id, clk) {
  const c = await load(db, id);
  if (!c) return { status: 404, error: 'Not found' };
  if (c.status !== 'paused') return { status: 409, error: `This campaign is ${c.status}.` };
  if ((await clock(db, clk)).today > c.deadline) return { status: 400, error: 'deadline_passed', message: `The deadline (${c.deadline}) has passed. Set a new deadline first.` };
  const r = await setStatus(db, id, ['paused'], 'running', null);
  return { status: 200, campaign: r };
}

/**
 * One pass. Only campaigns a manager STARTED (status 'running') are touched. `notifyFn(category, 'parent', childId, title, body, opts)` is the
 * dispatcher's notify; it writes the bell row (and a push for a parent who opted in). `clk` = { today, hour } for tests.
 */
async function runDue(db, notifyFn, clk) {
  const now = await clock(db, clk);
  const { rows: running } = await db.query(`SELECT *, deadline::text AS deadline FROM detail_campaigns WHERE status='running' ORDER BY id`);
  const result = { campaigns: running.length, sent: 0, completed: 0, ended: 0 };
  for (const c of running) {
    if (now.today > c.deadline) {
      await db.query(`UPDATE detail_campaigns SET status='ended', ended_at=now() WHERE id=$1 AND status='running'`, [c.id]);
      result.ended++; continue;
    }
    const fams = await currentFamilies(db, c);                 // live: the engine says who still has something to do
    const open = new Set(fams.map(f => f.child_id));
    // Anyone who was a target and is no longer outstanding has finished: they stop here, by themselves.
    const { rows: tg } = await db.query(`SELECT child_id FROM detail_campaign_targets WHERE campaign_id=$1 AND completed_at IS NULL`, [c.id]);
    for (const t of tg) {
      if (!open.has(Number(t.child_id))) {
        await db.query(`UPDATE detail_campaign_targets SET completed_at=now() WHERE campaign_id=$1 AND child_id=$2 AND completed_at IS NULL`, [c.id, t.child_id]);
        result.completed++;
      }
    }
    // A family that has become outstanding since Start (a new child, a new form) joins the campaign.
    for (const f of fams) await db.query(`INSERT INTO detail_campaign_targets (campaign_id, child_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [c.id, f.child_id]);
    await db.query(`UPDATE detail_campaign_targets SET completed_at=NULL WHERE campaign_id=$1 AND child_id = ANY($2::int[]) AND completed_at IS NOT NULL`, [c.id, [...open]]);

    if (now.hour < 8 || now.hour >= 18) continue;              // reminders go out in the working day only
    for (const f of fams) {
      const { rows: [l] } = await db.query(`SELECT count(*)::int AS n, max(sent_at) AS last, (max(sent_at) AT TIME ZONE $2)::date::text AS last_day FROM detail_campaign_log WHERE campaign_id=$1 AND child_id=$3`, [c.id, TZ, f.child_id]);
      const since = l.last_day ? dayDiff(now.today, l.last_day) : null;
      const finalDue = c.final_day && now.today === c.deadline && (l.last_day == null || l.last_day < now.today);
      const due = l.last_day == null || since >= c.cadence_days || finalDue;
      if (!due) continue;
      // claim first: (campaign, child, reminder_no) is unique, so a second process can never send the same reminder
      // `clk` (tests only) stamps the send on the fake clock so cadence is measured on one timeline; a real run always uses now().
      const sentAt = clk ? `${clk.today} ${String(clk.hour).padStart(2, '0')}:00:00+00` : null;
      const { rows: claim } = await db.query(
        `INSERT INTO detail_campaign_log (campaign_id, child_id, reminder_no, sent_at, channel, source) VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),'bell','campaign') ON CONFLICT DO NOTHING RETURNING id`,
        [c.id, f.child_id, l.n + 1, sentAt]);
      if (!claim.length) continue;
      let nid = null;
      try { nid = await notifyFn('details_outstanding', 'parent', f.child_id, c.message_title, c.message_body, { link: '/welcome', priority: 'normal' }); }
      catch (e) { console.error('[detail-campaigns] notify failed:', e.message); }
      await db.query(`UPDATE detail_campaign_log SET notification_id=$2 WHERE id=$1`, [claim[0].id, nid || null]);
      if (nid) result.sent++;
    }
  }
  return result;
}

module.exports = { list, detail, create, update, preview, launch, pause, resume, stop, runDue, currentFamilies, progress };
