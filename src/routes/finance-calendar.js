'use strict';
/**
 * finance-calendar.js (route) — b346 (2026-09-21)
 *
 * Finance → HMRC & Deadlines. The dated list of what the company owes and to whom.
 *
 *   GET  /api/finance/calendar                       schedule, company dates, who is blocked, reconciled-through
 *   PUT  /api/finance/calendar/settings              enter / correct the company dates      (finance-trusted)
 *   POST /api/finance/calendar/items/:rule/:period/done            mark done, with a note of what was filed
 *   POST /api/finance/calendar/items/:rule/:period/not-applicable  say why it does not apply
 *   POST /api/finance/calendar/items/:rule/:period/reopen
 *   POST /api/finance/calendar/items/:rule/:period/blocked         who has the ball: toby | accountant | bank | hmrc
 *   POST /api/finance/calendar/reconciled-through    record "bank accounts reconciled through <date>" (what the termly report trusts)
 *   GET  /api/finance/calendar/log                   the append-only record of who did what
 *
 * NOTHING HERE FILES ANYTHING OR TALKS TO HMRC, COMPANIES HOUSE, THE PENSIONS
 * REGULATOR OR XERO. It is a calendar with teeth: it computes, it reminds (the
 * What-needs-me board and the notification dispatcher), and it records that a
 * person said they did the thing.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Manager role AND the admin (Roost) portal, both enforced here — an EY manager
 * token carries aud='learning' and would otherwise pass requireRole('manager') —
 * the same guard as finance-intel.js and finance-reports.js.
 *
 * Company dates (settings) are a second gate on top: they move every deadline on the
 * page, so they need the finance-trusted check (`canViewSalaries`, the same gate
 * b301 put on the wage bill — the floor manager since b271 does not hold it). Marking
 * an occurrence done needs only the manager gate, because whoever did the filing
 * has to be able to say so.
 *
 * ── PAY DATA ────────────────────────────────────────────────────────────────
 * There is none here. Dates, rule text, sources and who is blocked. That is checked
 * by scripts/b346-verify.js, key by key, against a user without canViewSalaries.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { canViewSalaries } = require('../lib/capabilities');
const cal = require('../lib/finance-calendar');
const store = require('../lib/finance-calendar-store');
const { ragOf } = require('../services/attention/finance-calendar');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// ── the guard ────────────────────────────────────────────────────────────────
function managerAdminOnly(req, res, next) {
  if ((req._portal || null) !== 'admin') {
    return res.status(403).json({ error: 'forbidden_portal', message: 'The finance calendar is available on the Roost (admin) portal only.' });
  }
  if (!req.user || !hasRole(req.user, ['manager', 'admin'])) {
    return res.status(403).json({ error: 'forbidden_role', message: 'Manager access only — this is the company’s tax and filing record.' });
  }
  next();
}
async function attachTrust(req, _res, next) {
  try { req._financeTrusted = await canViewSalaries(req.user); } catch { req._financeTrusted = false; }
  next();
}
const guard = [authenticate, managerAdminOnly, attachTrust];

const ADVISORY = 'This is a calendar. It does not file anything, pay anything, or contact HMRC, Companies House, '
               + 'the Pensions Regulator or Xero. A deadline is only cleared when a person says it has been dealt with, '
               + 'and says what they did. Dates are computed from the company dates you enter — and from nothing else.';

const wrap = handler => async (req, res) => {
  try {
    const db = getPool();
    if (!(await store.hasTables(db))) {
      return res.status(503).json({ error: 'not_migrated', message: 'The b346 migration has not been applied to this database.' });
    }
    return await handler(db, req, res);
  } catch (e) {
    console.error('[finance-calendar]', req.method, req.path, e.message);
    return res.status(500).json({ error: 'calendar_failed', message: e.message });
  }
};

// ── settings: what may be written, and how it is checked ─────────────────────
const VALIDATORS = {
  [cal.SETTING_KEYS.year_end_md]:   v => cal.validMd(v),
  [cal.SETTING_KEYS.cs_review_end]: v => (cal.isIso(v) ? v : null),
  [cal.SETTING_KEYS.pension_start]: v => (cal.isIso(v) ? v : null),
  [cal.SETTING_KEYS.pension_last]:  v => (cal.isIso(v) ? v : null),
  [cal.SETTING_KEYS.from]:          v => (cal.isIso(v) ? v : null),
  [cal.SETTING_KEYS.payday_dom]:    v => int(v, 1, 31),
  [cal.SETTING_KEYS.pack_days]:     v => int(v, 1, 400),
  [cal.SETTING_KEYS.recon_dom]:     v => int(v, 1, 28),
  [cal.SETTING_KEYS.xero_dom]:      v => int(v, 1, 28),
  [cal.SETTING_KEYS.cutoff_days]:   v => int(v, 0, 20),
};
function int(v, lo, hi) { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? String(n) : null; }

const SETTING_HELP = [
  { key: cal.SETTING_KEYS.year_end_md,   label: 'Financial year end', type: 'md', hint: 'Month and day, e.g. 03-31. Every corporation tax and Companies House date counts from it.' },
  { key: cal.SETTING_KEYS.cs_review_end, label: 'Confirmation statement — review period ends', type: 'date', hint: 'The date on your Companies House record. Filed up to 14 days after it.' },
  { key: cal.SETTING_KEYS.pension_start, label: 'Pension duties start date', type: 'date', hint: 'Your automatic-enrolment duties start date, from The Pensions Regulator.' },
  { key: cal.SETTING_KEYS.pension_last,  label: 'Last pension re-enrolment date (optional)', type: 'date', hint: 'Only once you have been through a cycle — later cycles count from the date you chose.' },
  { key: cal.SETTING_KEYS.payday_dom,    label: 'Payday (day of the month)', type: 'int', min: 1, max: 31, hint: 'Moved back to the working day before if it falls on a weekend or bank holiday.' },
  { key: cal.SETTING_KEYS.cutoff_days,   label: 'Payroll cut-off (days before payday)', type: 'int', min: 0, max: 20, hint: 'Our own rule. Default 5.' },
  { key: cal.SETTING_KEYS.pack_days,     label: 'Accountant’s deadline for the year-end pack (days after year end)', type: 'int', min: 1, max: 400, hint: 'Ask your accountant. Wren does not guess it.' },
  { key: cal.SETTING_KEYS.recon_dom,     label: 'Bank reconciliation — by day of next month', type: 'int', min: 1, max: 28, hint: 'Our own rule. Default 10.' },
  { key: cal.SETTING_KEYS.xero_dom,      label: 'Xero catch-up — by day of next month', type: 'int', min: 1, max: 28, hint: 'Our own rule. Default 15.' },
  { key: cal.SETTING_KEYS.from,          label: 'Track deadlines from', type: 'date', hint: 'Earlier dates are not shown. Move it earlier to see what you want chased.' },
];

async function upsertSetting(db, key, value, staffId) {
  await db.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, value, staffId || null]);
}
async function logAction(db, o) {
  await db.query(
    `INSERT INTO finance_calendar_log (rule_code, period_key, action, actor_id, note, statutory_on, internal_on, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [o.rule, o.period, o.action, o.actor || null, o.note || null, o.statutory || null, o.internal || null, JSON.stringify(o.detail || {})]);
}
/** The board reflects the calendar; after any write, re-run ONLY this collector so a card appears/clears now, not at 06:45. */
async function syncBoard(db) {
  try {
    const { refresh } = require('../services/attention');
    const r = await refresh({ only: ['finance_calendar'], quiet: true });
    const e = r.collectors[0] || {};
    return { ok: !!e.ok, inserted: e.inserted || 0, closed: e.resolved || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── GET / ────────────────────────────────────────────────────────────────────
router.get('/', guard, wrap(async (db, req, res) => {
  const c = await store.loadCalendar(db);
  const days = d => (d ? cal.diffDays(c.today, d) : null);

  const occurrences = c.occurrences.map(o => {
    const open = o.status === 'open';
    const r = open ? ragOf(o) : { rag: 'green', why: o.status === 'done' ? 'Done.' : 'Marked not applicable.' };
    return Object.assign({}, o, {
      rag: o.marker ? null : r.rag,
      why: o.marker ? null : r.why,
      days_to_statutory: days(o.statutory),
      days_to_internal: days(o.internal),
      days_to_due: days(o.due),
    });
  });

  const open = occurrences.filter(o => !o.marker && o.status === 'open');
  const counts = {
    open: open.length,
    red: open.filter(o => o.rag === 'red').length,
    amber: open.filter(o => o.rag === 'amber').length,
    overdue: open.filter(o => o.phase === 'overdue').length,
    upcoming: open.filter(o => o.phase === 'upcoming').length,
    done: occurrences.filter(o => o.status === 'done').length,
  };

  const raw = c.raw;
  res.json({
    ok: true,
    today: c.today,
    tracking_from: c.schedule.tracking_from,
    counts,
    occurrences,
    needs: c.schedule.needs,
    conditional: c.schedule.conditional,
    rules: cal.RULES.map(r => cal.describeRule(r.code)),
    settings: {
      values: Object.fromEntries(Object.values(cal.SETTING_KEYS).filter(k => k !== cal.SETTING_KEYS.leads).map(k => [k, raw[k] == null ? '' : raw[k]])),
      help: SETTING_HELP,
      leads: c.ctx.leads,
      can_edit: !!req._financeTrusted,
    },
    reconciled_through: await store.attestedThrough(db),
    advisory: ADVISORY,
    generated_at: new Date().toISOString(),
  });
}));

// ── PUT /settings ────────────────────────────────────────────────────────────
router.put('/settings', guard, wrap(async (db, req, res) => {
  if (!req._financeTrusted) {
    return res.status(403).json({ error: 'finance_config_forbidden', message: 'Company dates move every deadline on this page, so they are limited to the owner and finance roles.' });
  }
  const incoming = (req.body && req.body.values) || {};
  const before = await store.loadSettingsMap(db);
  const changes = [];

  for (const [key, val] of Object.entries(incoming)) {
    if (key === cal.SETTING_KEYS.leads) continue;                  // handled below
    if (!Object.prototype.hasOwnProperty.call(VALIDATORS, key)) {
      return res.status(400).json({ error: 'unknown_setting', key, message: `“${key}” is not a company date Wren holds.` });
    }
    const blank = val == null || String(val).trim() === '';
    const clean = blank ? '' : VALIDATORS[key](String(val).trim());
    if (clean == null) return res.status(400).json({ error: 'bad_value', key, message: `“${val}” is not a valid value for ${key}.` });
    changes.push([key, clean]);
  }
  if (incoming[cal.SETTING_KEYS.leads] !== undefined) {
    const src = incoming[cal.SETTING_KEYS.leads] || {};
    const statutory = new Set(cal.RULES.filter(r => r.kind === 'statutory').map(r => r.code));
    const leads = {};
    for (const [code, n] of Object.entries(src)) {
      if (!statutory.has(code)) return res.status(400).json({ error: 'bad_lead', key: code, message: `“${code}” has no statutory date, so no lead time.` });
      if (!Number.isInteger(n) || n < 0 || n > 180) return res.status(400).json({ error: 'bad_lead', key: code, message: 'A lead time is a whole number of days, 0 to 180.' });
      leads[code] = n;
    }
    changes.push([cal.SETTING_KEYS.leads, Object.keys(leads).length ? JSON.stringify(leads) : '']);
  }

  for (const [key, value] of changes) {
    if ((before[key] == null ? '' : before[key]) === value) continue;
    await upsertSetting(db, key, value, req.user.id);
    await logAction(db, { rule: 'settings', period: key, action: 'settings', actor: req.user.id,
      detail: { key, from: before[key] == null ? null : before[key], to: value === '' ? null : value } });
  }
  const yearEndChanged = changes.some(([k, v]) => k === cal.SETTING_KEYS.year_end_md && (before[k] || '') !== v);
  res.json({
    ok: true, saved: changes.length, board: await syncBoard(db),
    warning: yearEndChanged
      ? 'The year end changed, so every deadline that counts from it has moved. Anything you already marked done is filed under the OLD year, and will not carry across.'
      : null,
  });
}));

// ── actions on one occurrence ────────────────────────────────────────────────
async function findOccurrence(db, rule, period) {
  const c = await store.loadCalendar(db);
  return { c, occ: c.occurrences.find(o => o.rule === rule && o.period === period) || null };
}
const cleanNote = v => String(v == null ? '' : v).trim().slice(0, 1000);

router.post('/items/:rule/:period/done', guard, wrap(async (db, req, res) => {
  const { rule, period } = req.params;
  const note = cleanNote(req.body && req.body.note);
  if (note.length < 3) return res.status(400).json({ error: 'note_required', message: 'Say what was filed — a few words is enough, but it cannot be blank.' });
  const { c, occ } = await findOccurrence(db, rule, period);
  if (!occ) return res.status(404).json({ error: 'unknown_occurrence', message: 'That deadline is not on the calendar.' });
  if (occ.marker) return res.status(400).json({ error: 'not_actionable', message: 'That is a date to know, not a job.' });

  let attested = null;
  if (occ.attests) {
    attested = (req.body && req.body.attested_through) || occ.month_end;
    if (!cal.isIso(attested)) return res.status(400).json({ error: 'bad_attested_through', message: '“Reconciled through” must be a date.' });
    if (attested > c.today) return res.status(400).json({ error: 'attested_in_future', message: 'You cannot reconcile through a date that has not happened.' });
  }
  const evidence = String((req.body && req.body.evidence_location) || '').trim().slice(0, 300) || null;

  await db.query(
    `INSERT INTO finance_calendar_items (rule_code, period_key, status, done_at, done_by, done_note, evidence_location, attested_through)
     VALUES ($1,$2,'done',now(),$3,$4,$5,$6)
     ON CONFLICT (rule_code, period_key) DO UPDATE
       SET status='done', done_at=now(), done_by=EXCLUDED.done_by, done_note=EXCLUDED.done_note,
           evidence_location=EXCLUDED.evidence_location, attested_through=EXCLUDED.attested_through, updated_at=now()`,
    [rule, period, req.user.id || null, note, evidence, attested]);
  await logAction(db, { rule, period, action: 'done', actor: req.user.id, note, statutory: occ.statutory, internal: occ.internal,
    detail: { evidence_location: evidence, attested_through: attested } });
  res.json({ ok: true, board: await syncBoard(db) });
}));

router.post('/items/:rule/:period/not-applicable', guard, wrap(async (db, req, res) => {
  const { rule, period } = req.params;
  const note = cleanNote(req.body && req.body.note);
  if (note.length < 3) return res.status(400).json({ error: 'note_required', message: 'Say why it does not apply.' });
  const { occ } = await findOccurrence(db, rule, period);
  if (!occ) return res.status(404).json({ error: 'unknown_occurrence', message: 'That deadline is not on the calendar.' });
  if (occ.marker) return res.status(400).json({ error: 'not_actionable', message: 'That is a date to know, not a job.' });
  await db.query(
    `INSERT INTO finance_calendar_items (rule_code, period_key, status, done_at, done_by, done_note)
     VALUES ($1,$2,'not_applicable',now(),$3,$4)
     ON CONFLICT (rule_code, period_key) DO UPDATE
       SET status='not_applicable', done_at=now(), done_by=EXCLUDED.done_by, done_note=EXCLUDED.done_note,
           evidence_location=NULL, attested_through=NULL, updated_at=now()`,
    [rule, period, req.user.id || null, note]);
  await logAction(db, { rule, period, action: 'not_applicable', actor: req.user.id, note, statutory: occ.statutory, internal: occ.internal });
  res.json({ ok: true, board: await syncBoard(db) });
}));

router.post('/items/:rule/:period/reopen', guard, wrap(async (db, req, res) => {
  const { rule, period } = req.params;
  const { rows } = await db.query(`SELECT status, done_note, to_char(attested_through,'YYYY-MM-DD') AS attested_through FROM finance_calendar_items WHERE rule_code=$1 AND period_key=$2`, [rule, period]);
  if (!rows.length || rows[0].status === 'open') return res.status(404).json({ error: 'nothing_to_reopen', message: 'That deadline is not marked done.' });
  await db.query(
    `UPDATE finance_calendar_items
        SET status='open', done_at=NULL, done_by=NULL, done_note=NULL, evidence_location=NULL, attested_through=NULL, updated_at=now()
      WHERE rule_code=$1 AND period_key=$2`, [rule, period]);
  await logAction(db, { rule, period, action: 'reopen', actor: req.user.id, note: cleanNote(req.body && req.body.note) || null,
    detail: { was: rows[0].status, previous_note: rows[0].done_note, previous_attested_through: rows[0].attested_through } });
  res.json({ ok: true, board: await syncBoard(db) });
}));

router.post('/items/:rule/:period/blocked', guard, wrap(async (db, req, res) => {
  const { rule, period } = req.params;
  const party = req.body && req.body.blocked_on;
  if (party != null && party !== '' && !cal.PARTIES.includes(party)) {
    return res.status(400).json({ error: 'bad_party', message: `blocked_on is one of ${cal.PARTIES.join(', ')}.` });
  }
  const { occ } = await findOccurrence(db, rule, period);
  if (!occ) return res.status(404).json({ error: 'unknown_occurrence', message: 'That deadline is not on the calendar.' });
  const value = party || null;
  await db.query(
    `INSERT INTO finance_calendar_items (rule_code, period_key, status, blocked_on) VALUES ($1,$2,'open',$3)
     ON CONFLICT (rule_code, period_key) DO UPDATE SET blocked_on = EXCLUDED.blocked_on, updated_at = now()`,
    [rule, period, value]);
  await logAction(db, { rule, period, action: 'blocked_on', actor: req.user.id, statutory: occ.statutory, internal: occ.internal, detail: { blocked_on: value } });
  res.json({ ok: true, board: await syncBoard(db) });
}));

// ── POST /reconciled-through ─────────────────────────────────────────────────
// "The bank accounts are reconciled in Xero up to this date." Recorded on its own, NOT
// as a scheduled occurrence: tracking starts on the day the calendar goes live, so on
// day one no past month's reconciliation job exists to be ticked — and the termly report
// needs to be told about history from the very first day, or it refuses forever. It is
// cumulative (a reconciliation to 31 August covers every earlier month) and it is the
// ONLY thing that lets the termly money report trust a month: Wren cannot see it for
// itself, because Xero's BankTransactions endpoint only returns transactions that are
// already reconciled (b226). A note is required and the record is append-only-logged.
router.post('/reconciled-through', guard, wrap(async (db, req, res) => {
  const through = String((req.body && req.body.through) || '').trim();
  const note = cleanNote(req.body && req.body.note);
  const today = store.londonToday();
  if (!cal.isIso(through) || through < '2018-01-01') return res.status(400).json({ error: 'bad_through', message: '“Reconciled through” must be a date.' });
  if (through > today) return res.status(400).json({ error: 'attested_in_future', message: 'You cannot reconcile through a date that has not happened.' });
  if (note.length < 3) return res.status(400).json({ error: 'note_required', message: 'Say which accounts were reconciled — a few words is enough, but it cannot be blank.' });
  const period = `THROUGH${through}`;
  await db.query(
    `INSERT INTO finance_calendar_items (rule_code, period_key, status, done_at, done_by, done_note, attested_through)
     VALUES ('bank-reconciliation', $1, 'done', now(), $2, $3, $4)
     ON CONFLICT (rule_code, period_key) DO UPDATE
       SET status='done', done_at=now(), done_by=EXCLUDED.done_by, done_note=EXCLUDED.done_note, attested_through=EXCLUDED.attested_through, updated_at=now()`,
    [period, req.user.id || null, note, through]);
  await logAction(db, { rule: 'bank-reconciliation', period, action: 'reconciled_through', actor: req.user.id, note, detail: { attested_through: through } });
  res.json({ ok: true, reconciled_through: await store.attestedThrough(db), board: await syncBoard(db) });
}));

// ── GET /log ─────────────────────────────────────────────────────────────────
router.get('/log', guard, wrap(async (db, req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const { rows } = await db.query(
    `SELECT l.id, l.rule_code, l.period_key, l.action, l.note, to_char(l.statutory_on,'YYYY-MM-DD') AS statutory_on,
            to_char(l.internal_on,'YYYY-MM-DD') AS internal_on, l.detail, l.at, s.first_name AS by
       FROM finance_calendar_log l LEFT JOIN staff s ON s.id = l.actor_id
      ORDER BY l.id DESC LIMIT $1`, [limit]);
  res.json({ ok: true, log: rows.map(r => Object.assign({}, r, { at: new Date(r.at).toISOString() })) });
}));

module.exports = router;
