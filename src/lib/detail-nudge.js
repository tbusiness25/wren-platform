'use strict';
// ===========================================================================
// detail-nudge.js — parentdetails-20261023. "Funding week is coming": nudge families whose details have a gap that matters,
// before each claim window closes, and again every few days until the gap is filled.
//
// AUTOMATED, so this follows Toby's explicit rule (memory feedback_no_auto_email_to_parents) to the letter:
//   * OFF by default (settings.detail_nudge_enabled = 'false'). Turning it on in Roost needs a preview of exactly who would be
//     messaged and what, and a confirm. It then runs in DRY RUN (detail_nudge_dry_run = 'true': every would-be message is logged,
//     nothing is sent) until dry run is switched off as a second, separate confirmed step.
//   * The only thing it ever sends is an IN-APP bell (category details_outstanding), plus a push to a parent who switched push on
//     for "Details we still need". There is NO email path: this file never touches a mailer, the category is on the parent
//     email BLOCK list (src/services/parent-notify.js), and detail_nudge_log.channel is 'bell'.
//   * Caps per FAMILY (children who share a parent login), counted across this log AND reminder campaigns (detail_campaign_log):
//     at most detail_nudge_max_per_day a day (1) and detail_nudge_max_per_week in any 7 days (3).
//   * It stops for a family by itself the moment their gaps are filled: the Missing-details engine (src/lib/outstanding.js) is
//     live, so a family with nothing outstanding is simply not in the list. It stops for everyone when the portal closes.
//   * Messages are fixed sentences chosen by gap CODE, never free text, and only `who: 'parent'` codes can be chased, so no staff-only
//     or safeguarding content can ever be in one. No child or parent is named.
//   * Prod only: the dispatcher's sweep returns on a dev database, and reminders go out 09:00-17:00 London, Monday to Friday.
//
// Window: funding_claim_periods, the next period whose COALESCE(adj_portal_closes, portal_closes) is today or later. Nudging starts
// detail_nudge_lead_days (7) before that date and repeats every detail_nudge_every_days (3).
// ===========================================================================

const OUT = require('./outstanding');

const TZ = 'Europe/London';
let _lastRun = 0;
const CATEGORY = 'details_outstanding';
const FUNDING_CODES = ['funding_declaration', 'parent_ni', 'parent_dob', 'thirty_hour_code', 'thirty_hour_reconfirm'];
const DEFAULT_CODES = ['parent_ni', 'parent_dob', 'funding_declaration', 'thirty_hour_code', 'thirty_hour_reconfirm', 'allergies', 'emergency_contact'];

// What a family is asked for, in plain words. One phrase per code: the message is built from these and nothing else.
const ASK = {
  parent_ni: () => 'your National Insurance number',
  parent_dob: () => 'your date of birth',
  funding_declaration: () => 'this term\'s funding declaration, signed in the app',
  thirty_hour_code: () => 'your 11-digit 30-hour code',
  thirty_hour_reconfirm: () => 'your reconfirmed 30-hour code (HMRC asks you to reconfirm it every 3 months)',
  emergency_contact: () => 'an emergency contact',
  address: () => 'your home address and postcode',
  ethnicity: () => 'your child\'s ethnicity',
  consent: () => 'a consent question',
  form_to_sign: () => 'a form waiting for your signature',
  about_me_missing: () => 'your child\'s All About Me',
};
const ALLERGY_LINE = 'We can see you haven\'t told us whether your child has any allergies. Have you double-checked?';

const dayDiff = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const longDay = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const isoWeekStart = s => { const d = new Date(s + 'T00:00:00Z'); const wd = (d.getUTCDay() + 6) % 7; return addDays(s, -wd); };

async function clock(db, override) {
  if (override) return override;
  const { rows: [r] } = await db.query(
    `SELECT (now() AT TIME ZONE $1)::date::text AS today, extract(hour FROM now() AT TIME ZONE $1)::int AS hour,
            extract(isodow FROM now() AT TIME ZONE $1)::int AS dow`, [TZ]);
  return r;
}

// ── settings ─────────────────────────────────────────────────────────────────
const KEYS = ['detail_nudge_enabled', 'detail_nudge_dry_run', 'detail_nudge_lead_days', 'detail_nudge_every_days', 'detail_nudge_max_per_day',
  'detail_nudge_max_per_week', 'detail_nudge_codes', 'detail_nudge_manager_name', 'detail_inbox_search_enabled', 'detail_nudge_last_change'];
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isInteger(n) ? Math.max(lo, Math.min(hi, n)) : d; };
function parentCodes() { return Object.keys(OUT.CODES).filter(c => OUT.CODES[c].who === 'parent'); }

async function settings(db) {
  const m = {};
  try { const { rows } = await db.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [KEYS]); rows.forEach(r => { m[r.key] = r.value; }); }
  catch (e) { /* no settings table: everything off */ }
  const allowed = parentCodes();
  const codes = String(m.detail_nudge_codes || DEFAULT_CODES.join(',')).split(',').map(s => s.trim()).filter(c => allowed.includes(c));
  let lastChange = null; try { lastChange = m.detail_nudge_last_change ? JSON.parse(m.detail_nudge_last_change) : null; } catch (e) { lastChange = null; }
  return {
    enabled: m.detail_nudge_enabled === 'true',               // anything but the literal 'true' is OFF
    dry_run: m.detail_nudge_dry_run !== 'false',              // anything but the literal 'false' is a dry run
    lead_days: clampInt(m.detail_nudge_lead_days, 1, 21, 7),
    every_days: clampInt(m.detail_nudge_every_days, 1, 14, 3),
    max_per_day: clampInt(m.detail_nudge_max_per_day, 1, 3, 1),
    max_per_week: clampInt(m.detail_nudge_max_per_week, 1, 7, 3),
    codes: codes.length ? codes : DEFAULT_CODES.filter(c => allowed.includes(c)),
    manager_name: String(m.detail_nudge_manager_name || 'Toby').slice(0, 40),
    inbox_search_enabled: m.detail_inbox_search_enabled === 'true',
    last_change: lastChange,
    allowed_codes: allowed.map(c => ({ code: c, label: OUT.CODES[c].label })),
  };
}

async function _put(db, key, value) {
  await db.query(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, String(value)]);
}

/**
 * Change the switches. Turning the nudge ON, or turning dry run OFF (real sends), each need confirm:true — the UI shows the preview
 * first. Turning anything OFF never needs a confirm. Returns { status, settings? , error? }.
 */
async function setSettings(db, actor, body = {}) {
  const cur = await settings(db);
  const b = body || {};
  const goingLive = (b.enabled === true && !cur.enabled) || (b.dry_run === false && cur.dry_run);
  const searchOn = b.inbox_search_enabled === true && !cur.inbox_search_enabled;
  if ((goingLive || searchOn) && b.confirm !== true) {
    return { status: 400, error: 'confirm_required', message: 'Turning this on needs confirm:true, after the preview has been read.' };
  }
  const changed = [];
  if (typeof b.enabled === 'boolean') { await _put(db, 'detail_nudge_enabled', b.enabled ? 'true' : 'false'); changed.push('enabled'); }
  if (typeof b.dry_run === 'boolean') { await _put(db, 'detail_nudge_dry_run', b.dry_run ? 'true' : 'false'); changed.push('dry_run'); }
  // Switching the nudge OFF puts dry run back ON, so switching it on again can never go straight to real sends.
  if (b.enabled === false) await _put(db, 'detail_nudge_dry_run', 'true');
  if (typeof b.inbox_search_enabled === 'boolean') { await _put(db, 'detail_inbox_search_enabled', b.inbox_search_enabled ? 'true' : 'false'); changed.push('inbox_search_enabled'); }
  const ints = { lead_days: [1, 21], every_days: [1, 14], max_per_day: [1, 3], max_per_week: [1, 7] };
  for (const [k, [lo, hi]] of Object.entries(ints)) {
    if (b[k] !== undefined) { await _put(db, 'detail_nudge_' + k, clampInt(b[k], lo, hi, cur[k])); changed.push(k); }
  }
  if (b.codes !== undefined) {
    const list = (Array.isArray(b.codes) ? b.codes : String(b.codes).split(',')).map(s => String(s).trim());
    const bad = list.filter(c => !parentCodes().includes(c));
    if (bad.length || !list.length) return { status: 400, error: `Only things a family supplies can be chased: ${bad.join(', ') || 'choose at least one'}` };
    await _put(db, 'detail_nudge_codes', [...new Set(list)].join(',')); changed.push('codes');
  }
  if (b.manager_name !== undefined) { await _put(db, 'detail_nudge_manager_name', String(b.manager_name).trim().slice(0, 40) || 'Toby'); changed.push('manager_name'); }
  if (changed.length) await _put(db, 'detail_nudge_last_change', JSON.stringify({ by: actor && actor.id || null, at: new Date().toISOString(), changed }));
  return { status: 200, settings: await settings(db), changed };
}

// ── the claim window ──────────────────────────────────────────────────────────
async function window(db, s, now) {
  let p = null;
  try {
    const { rows: [r] } = await db.query(
      `SELECT id, period_label, to_char(COALESCE(adj_portal_closes, portal_closes),'YYYY-MM-DD') AS closes,
              to_char(COALESCE(adj_portal_opens, portal_opens),'YYYY-MM-DD') AS opens
         FROM funding_claim_periods
        WHERE COALESCE(adj_portal_closes, portal_closes) >= $1::date
        ORDER BY COALESCE(adj_portal_closes, portal_closes), id LIMIT 1`, [now.today]);
    p = r || null;
  } catch (e) { p = null; }
  if (!p) return { period: null, open: false, starts: null };
  const starts = addDays(p.closes, -s.lead_days);
  return { period: p, starts, closes: p.closes, open: now.today >= starts && now.today <= p.closes, days_left: dayDiff(p.closes, now.today) };
}

// ── families ─────────────────────────────────────────────────────────────────
/** Children who share an active parent login are one family. Map childId → { key, child_ids, has_login }. */
async function families(db, childIds) {
  const ids = [...new Set(childIds.map(Number))];
  const parent = new Map(ids.map(i => [i, i]));
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const login = new Set();
  try {
    const { rows } = await db.query(
      `SELECT lower(email) AS email, array_agg(DISTINCT child_id) AS kids FROM parent_portal_access
        WHERE is_active = true AND child_id = ANY($1::int[]) GROUP BY lower(email)`, [ids]);
    for (const r of rows) {
      const kids = (r.kids || []).map(Number).filter(k => parent.has(k));
      kids.forEach(k => login.add(k));
      for (let i = 1; i < kids.length; i++) { const a = find(kids[0]), b = find(kids[i]); if (a !== b) parent.set(Math.max(a, b), Math.min(a, b)); }
    }
  } catch (e) { /* no portal table: every child is its own family, none with a login */ }
  const groups = new Map();
  for (const i of ids) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  const out = new Map();
  for (const [root, kids] of groups) {
    const sorted = [...kids].sort((a, b) => a - b);     // sorted copy: sorting `kids` while iterating it skipped a child
    const key = String(sorted[0]);
    for (const k of sorted) out.set(k, { key, child_ids: sorted, has_login: sorted.some(c => login.has(c)) });
  }
  return out;
}

/** The exact message for one family's gaps. `win` = the open window (or null for a nudge pressed outside one). */
function compose(items, win, s, now) {
  const codes = [...new Set(items.map(i => i.code))];
  const asks = [];
  for (const it of items) {
    if (it.code === 'allergies') continue;
    const f = ASK[it.code]; if (!f) continue;
    const phrase = f(it);
    if (!asks.includes(phrase)) asks.push(phrase);
  }
  const funding = codes.some(c => FUNDING_CODES.includes(c));
  const allergies = codes.includes('allergies');
  let when = '';
  if (win && win.closes) {
    const sameWeek = isoWeekStart(win.closes) === isoWeekStart(now.today);
    const nextWeek = isoWeekStart(win.closes) === addDays(isoWeekStart(now.today), 7);
    when = sameWeek ? 'this week' : nextWeek ? 'next week' : `by ${longDay(win.closes)}`;
  }
  const parts = [];
  let title;
  if (funding) {
    title = 'Funding week is coming: are your details up to date?';
    parts.push(when ? `${s.manager_name}'s doing the funding ${when}. Are your details up to date?` : 'We\'re getting ready to claim your funded hours. Are your details up to date?');
  } else if (allergies && !asks.length) {
    title = 'Have you double-checked your child\'s allergies?';
  } else {
    title = 'Some details are still needed';
  }
  if (asks.length) parts.push(`We still need ${asks.length === 1 ? asks[0] : asks.slice(0, -1).join(', ') + ' and ' + asks[asks.length - 1]}.`);
  if (allergies) parts.push(ALLERGY_LINE);
  parts.push('Open the app and look under To do on the home screen.');
  return { title, body: parts.join(' '), codes };
}

async function _counts(db, key, kids, dry, now) {
  // sends to this family today and in the last 7 days, from BOTH logs. A real run counts real sends only; a dry run counts real
  // sends AND its own dry-run lines, so it simulates what would really happen (a manual nudge today blocks a dry-run line too).
  const { rows: [n] } = await db.query(
    `SELECT count(*) FILTER (WHERE (sent_at AT TIME ZONE $4)::date = $3::date)::int AS today,
            count(*) FILTER (WHERE (sent_at AT TIME ZONE $4)::date > $3::date - 7)::int AS week,
            to_char(max(sent_at) AT TIME ZONE $4, 'YYYY-MM-DD') AS last_day
       FROM (SELECT sent_at FROM detail_nudge_log WHERE family_key = $1 AND (dry_run = false OR $2)
             UNION ALL
             SELECT sent_at FROM detail_campaign_log WHERE child_id = ANY($5::int[])) x`,
    [key, dry, now.today, TZ, kids]);
  return n;
}

/**
 * Who would be nudged, with what, and why not. opts: { clk, childIds (manual), force (manual: ignore the window and cadence) }.
 * Names are for the manager's eyes inside Roost only.
 */
async function plan(db, opts = {}) {
  const s = await settings(db);
  const now = await clock(db, opts.clk);
  const win = await window(db, s, now);
  let ids;
  try {
    const { rows } = await db.query(`SELECT id FROM children WHERE is_active = true AND COALESCE(is_demo, false) = false`);
    ids = rows.map(r => Number(r.id));
  } catch (e) {
    const { rows } = await db.query(`SELECT id FROM children WHERE is_active = true`); ids = rows.map(r => Number(r.id));
  }
  if (Array.isArray(opts.childIds)) {
    const fam0 = await families(db, ids);
    const want = new Set();
    for (const c of opts.childIds.map(Number)) { const f = fam0.get(c); (f ? f.child_ids : [c]).forEach(k => want.add(k)); }
    ids = ids.filter(i => want.has(i));
  }
  const kids = await OUT.forChildren(db, { childIds: ids, codes: s.codes, who: 'parent' });
  const fam = await families(db, kids.map(k => k.child_id));
  const byKey = new Map();
  for (const k of kids) {
    const f = fam.get(k.child_id);
    if (!byKey.has(f.key)) byKey.set(f.key, { family_key: f.key, child_ids: f.child_ids, has_login: f.has_login, children: [], items: [] });
    const g = byKey.get(f.key);
    g.children.push({ child_id: k.child_id, name: k.name, room_name: k.room_name });
    for (const it of k.items) g.items.push(Object.assign({}, it, { child_id: k.child_id }));
  }
  const out = [];
  for (const g of byKey.values()) {
    const msg = compose(g.items, win.period ? win : null, s, now);    // outside a window (a manual nudge) it names the next close date
    const to = g.children.map(c => c.child_id).sort((a, b) => a - b)[0];
    const n = await _counts(db, g.family_key, g.child_ids, !opts.force && s.dry_run, now);
    let skip = null;
    if (!g.has_login) skip = 'No parent login: nobody would see it. Ring or speak to them.';
    else if (n.today >= s.max_per_day) skip = `Already reminded today (limit ${s.max_per_day} a day).`;
    else if (n.week >= s.max_per_week) skip = `Already reminded ${n.week} times this week (limit ${s.max_per_week}).`;
    else if (!opts.force && n.last_day && dayDiff(now.today, n.last_day) < s.every_days) skip = `Reminded ${longDay(n.last_day)}; next one ${longDay(addDays(n.last_day, s.every_days))}.`;
    out.push({
      family_key: g.family_key, to_child_id: to, child_ids: g.child_ids, children: g.children,
      gaps: [...new Set(g.items.map(i => i.label))], codes: msg.codes, title: msg.title, body: msg.body,
      sent_today: n.today, sent_week: n.week, last_sent: n.last_day, due: !skip, skip_reason: skip,
    });
  }
  out.sort((a, b) => (a.due === b.due ? 0 : a.due ? -1 : 1));
  return { settings: s, now, window: win, families: out, due: out.filter(f => f.due).length,
           channels: { bell: true, push: 'only for a parent who chose push under "Details we still need"', email: 'never' } };
}

/** The preview a manager sees before switching it on: the next window and exactly who would be messaged, and what. */
async function preview(db, clk) {
  const p = await plan(db, { clk });
  const w = p.window;
  return Object.assign(p, {
    schedule: w.period ? `From ${longDay(w.starts)} until the portal closes on ${longDay(w.closes)} (${w.period.period_label}), every ${p.settings.every_days} days, 9am to 5pm on weekdays.` : 'There is no claim window on the timetable.',
    stops_when: 'Each family stops being nudged as soon as their gaps are filled; everyone stops when the portal closes',
  });
}

async function _record(db, f, { mode, dry, periodId, actorId, notifyFn, clk }) {
  // `clk` (tests only) stamps the row on the fake clock so cadence and caps are measured on one timeline; a real run uses now()
  const sentAt = clk ? `${clk.today} ${String(clk.hour).padStart(2, '0')}:00:00 Europe/London` : null;
  const { rows: [l] } = await db.query(
    `INSERT INTO detail_nudge_log (family_key, child_id, child_ids, codes, title, body, mode, dry_run, period_id, channel, actor_id, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'bell',$10, COALESCE($11::timestamptz, now())) RETURNING id`,
    [f.family_key, f.to_child_id, f.child_ids, f.codes, f.title, f.body, mode, dry, periodId || null, actorId || null, sentAt]);
  if (dry) return { id: l.id, sent: false };
  let nid = null;
  try { nid = await notifyFn(CATEGORY, 'parent', f.to_child_id, f.title, f.body, { link: '/welcome', priority: 'normal' }); }
  catch (e) { console.error('[detail-nudge] notify failed:', e.message); }
  await db.query(`UPDATE detail_nudge_log SET notification_id = $2 WHERE id = $1`, [l.id, nid || null]);
  return { id: l.id, sent: !!nid };
}

/**
 * One pass of the scheduler. Does nothing unless a manager switched it on. In dry run it logs what it would have sent.
 * `notifyFn` = the dispatcher's notifyAsync. `clk` = { today, hour, dow } for tests.
 */
async function runDue(db, notifyFn, clk) {
  const s = await settings(db);
  if (!s.enabled) return { enabled: false, sent: 0, logged: 0 };
  const now = await clock(db, clk);
  if (now.dow > 5 || now.hour < 9 || now.hour >= 17) return { enabled: true, sent: 0, logged: 0, outside_hours: true };
  // the dispatcher polls every 30s; the plan reads every child's record, so a real run looks at most every 10 minutes
  if (!clk && Date.now() - _lastRun < 10 * 60 * 1000) return { enabled: true, sent: 0, logged: 0, throttled: true };
  if (!clk) _lastRun = Date.now();
  const lockClient = db.connect ? await db.connect() : null;
  const q = lockClient || db;
  try {
    const { rows: [lk] } = await q.query(`SELECT pg_try_advisory_lock(hashtext('ladn.detail_nudge')) AS ok`);
    if (!lk.ok) return { enabled: true, sent: 0, logged: 0, busy: true };
    try {
      const p = await plan(db, { clk: now });
      if (!p.window.open) return { enabled: true, sent: 0, logged: 0, window: false };
      const r = { enabled: true, dry_run: s.dry_run, window: p.window.period.period_label, sent: 0, logged: 0 };
      for (const f of p.families.filter(x => x.due)) {
        const x = await _record(db, f, { mode: 'auto', dry: s.dry_run, periodId: p.window.period.id, notifyFn, clk });
        r.logged++; if (x.sent) r.sent++;
      }
      return r;
    } finally { await q.query(`SELECT pg_advisory_unlock(hashtext('ladn.detail_nudge'))`).catch(() => {}); }
  } finally { if (lockClient) lockClient.release(); }
}

/**
 * A nudge a manager pressed by hand for one child's family. confirm:false → the preview (exact message); confirm:true → sends it.
 * Works whether or not the automatic nudge is on (a person pressed it, after seeing it), but the daily / weekly caps still apply.
 */
async function manual(db, notifyFn, actor, childId, { confirm = false, clk } = {}) {
  const p = await plan(db, { childIds: [Number(childId)], force: true, clk });
  const f = p.families[0];
  if (!f) return { status: 404, error: 'Nothing a family needs to supply is outstanding for this child.' };
  if (!confirm) return { status: 200, preview: f, channels: p.channels };
  if (!f.due) return { status: 409, error: f.skip_reason, preview: f };
  const x = await _record(db, f, { mode: 'manual', dry: false, periodId: p.window.open ? p.window.period.id : null, actorId: actor && actor.id, notifyFn, clk });
  return { status: 200, sent: x.sent, log_id: x.id, preview: f };
}

async function log(db, limit = 50) {
  const { rows } = await db.query(
    `SELECT l.id, l.family_key, l.child_id, l.child_ids, l.codes, l.title, l.body, l.mode, l.dry_run, l.sent_at, l.notification_id,
            COALESCE(NULLIF(c.preferred_name,''), c.first_name) || ' ' || coalesce(c.last_name,'') AS child_name, s.first_name AS actor_name
       FROM detail_nudge_log l LEFT JOIN children c ON c.id = l.child_id LEFT JOIN staff s ON s.id = l.actor_id
      ORDER BY l.sent_at DESC LIMIT $1`, [Math.max(1, Math.min(200, limit))]);
  return rows;
}

module.exports = { settings, setSettings, window, families, compose, plan, preview, runDue, manual, log, ASK, ALLERGY_LINE, CATEGORY };
