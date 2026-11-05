'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b524 (2026-10-21) — Roost → Finance → Accounts.  /api/finance/accounts/*
//
// Toby: "should we just build everything into the accounting section … and it's
// got an auto-allocate." Nathan (staff 23, role 'accountant') is the bookkeeper
// and needs to find everything in one place.
//
// MOUNTED UNDER /api/finance DELIBERATELY. server-unified.js gates by the FIRST
// path segment, and 'finance' is already in ROOST_ONLY_PREFIXES, in FINANCE_SET
// (the off-site denial), in PARENT_DENY and in HR_DENY. Hanging this off that
// segment means it inherits every one of those rules as written. A new top-level
// prefix would have had to be added to four separate lists correctly, and the
// failure mode of getting one wrong is silent — the same reasoning as b363's
// note at the top of src/routes/payroll-import.js.
//
// THE GATES, OUTERMOST FIRST
//   1. Roost person allowlist (ladn.settings roost_admin_staff_ids), except for
//      an 'accountant' token, which b480's scope gate has already restricted to
//      GET/HEAD on an explicit path list — see ACCOUNTANT NOTE below.
//   2. FINANCE_SET off-site denial — no money data off the premises.
//   3. authenticate + the manager/accountant role check here.
//   4. requireSalaryView on the PAY routes only. The Accounts home is NOT behind
//      it: it carries fee runs, the bank, funding and the allocation queue, and
//      a deputy has a legitimate reason to read those. The pay figures are
//      OMITTED from its payload instead (accounts-store.js stripPay) — b301:
//      a wage bill rendered as "0% of revenue" is worse than one that is absent.
//
// ACCOUNTANT NOTE. Nathan reads Accounts and changes nothing. That is enforced
// by b480's gate (GET/HEAD only, allow-listed paths), not by anything here, so
// the writes below need no second accountant check — a POST from an accountant
// token is refused before Express routes it. src/lib/accountant-gate.js has been
// extended with the two Accounts GET prefixes.
//
// NO CHILD DATA ON THESE SCREENS. Nothing in this router returns a child, a
// family, a bill-payer, a member of staff by name, or a line of bank text.
// Counts, totals, ids and age bands only.
// ─────────────────────────────────────────────────────────────────────────────

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { canViewSalaries, requireSalaryView } = require('../lib/capabilities');

const store = require('../lib/accounts-store');
const AA    = require('../lib/auto-allocate');
const DUP   = require('../lib/bank-duplicates');
const PRI   = require('../lib/payroll-run-import');

router.use(authenticate);
router.use((req, res, next) => {
  // Mirrors payment-matching.js / finance-reconcile.js. 'accountant' is safe
  // here only BECAUSE the b480 scope gate ran first.
  const ok = ['manager', 'deputy_manager', 'admin', 'accountant', 'headteacher', 'business_manager'];
  if (!ok.includes(req.user && req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});

const int = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) ? n : null; };
const idList = (v) => (Array.isArray(v) ? v : []).map(n => parseInt(n, 10)).filter(Number.isInteger);

// ── The one Finance home ─────────────────────────────────────────────────────
// GET /home — everything the landing page shows, in one round trip.
router.get('/home', async (req, res) => {
  const db = getPool();
  try {
    const pay = await canViewSalaries(req.user);
    const data = await store.home(db, { canViewSalaries: pay });
    res.json(data);
  } catch (e) {
    console.error('[finance-accounts] home:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /links — the money views this page links to, so the list of them lives in
// ONE place and a new Finance screen is added here rather than in the HTML.
router.get('/links', async (req, res) => {
  const pay = await canViewSalaries(req.user);
  res.json({
    groups: [
      { label: 'Fees and families', items: [
        { label: 'Invoices & Payments', href: '/money.html', blurb: 'Raise, send, take and allocate. The way in.' },
        { label: 'Reconcile', href: '/admin/finance/reconcile', blurb: 'The bank against the ledger.' },
        { label: 'Matching', href: '/admin/finance/reconcile#matching', blurb: 'Family payment references and the proposal queue (b325).' },
        { label: 'Finance Reports', href: '/admin/finance-reports/income', blurb: 'Income, aged debtors, the chase list.' },
      ] },
      { label: 'Staff pay', pay_only: true, items: pay ? [
        { label: 'Payroll runs', href: '/admin/payroll/runs', blurb: 'Every run, its lines and its totals.' },
        { label: 'Import from Paycheck', href: '/admin/accounts/payroll-import', blurb: 'Drop the payslip summary, P32 and pension files in.' },
        { label: 'Wages', href: '/admin/finance/wages', blurb: 'The wage bill against revenue.' },
      ] : [] },
      { label: 'Funding', items: [
        { label: 'Funding manager', href: '/funding.html?full=1', blurb: 'Terms, allocations, the council portal, declarations, Census.' },
        { label: 'Expected vs received', href: '/admin/accounts/funding', blurb: 'What Ealing owes for each claim month, by age group.' },
      ] },
      { label: 'Tax and the bank', items: [
        { label: 'HMRC & Deadlines', href: '/admin/finance-hmrc/calendar', blurb: 'The tax and filing calendar, and the termly money report.' },
        { label: 'Bank feeds and Xero', href: '/admin/finance/reconcile#bank', blurb: 'Open banking, the Xero feed and its status.' },
        { label: 'Auto-allocate queue', href: '/admin/accounts/allocate', blurb: 'What matched itself, and what needs a person.' },
      ] },
    ],
    can_view_salaries: pay,
  });
});

// GET /ledger?year=&month= — the ledger view.
router.get('/ledger', async (req, res) => {
  const db = getPool();
  try {
    const rows = await store.ledger(db, { year: int(req.query.year), month: int(req.query.month) });
    const pay = await canViewSalaries(req.user);
    res.json({ postings: pay ? rows : rows.filter(r => !r.is_pay),
               pay_withheld: !pay && rows.some(r => r.is_pay) });
  } catch (e) {
    console.error('[finance-accounts] ledger:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Fee runs ─────────────────────────────────────────────────────────────────
// GET /fee-runs — derived from the invoices, so a run appears with no extra step.
router.get('/fee-runs', async (req, res) => {
  const db = getPool();
  try { res.json({ runs: await store.feeRuns(db, { limit: int(req.query.limit) || 24 }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Payroll ──────────────────────────────────────────────────────────────────
// Everything from here to the end of the payroll block is behind the salary gate.
router.get('/payroll-runs', requireSalaryView, async (req, res) => {
  const db = getPool();
  try { res.json({ runs: await store.payrollRuns(db, { limit: int(req.query.limit) || 24 }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /payroll/analyse — read a Paycheck file and show what it would do.
// Writes nothing. Body: { csv, kind?, mapping? }
router.post('/payroll/analyse', requireSalaryView, async (req, res) => {
  const db = getPool();
  try {
    const csv = String((req.body && req.body.csv) || '');
    if (!csv.trim()) return res.status(400).json({ error: 'no_csv' });
    const a = await PRI.analyse(db, {
      csvText: csv,
      kind: req.body.kind || null,
      mapping: (req.body.mapping && typeof req.body.mapping === 'object') ? req.body.mapping : null,
    });
    // `_rows` holds NI numbers and per-person pay. It never leaves the server.
    const { _rows, ...safe } = a;
    res.json(safe);
  } catch (e) {
    console.error('[finance-accounts] payroll/analyse:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /payroll/import — apply it. Body: { csv, kind, mapping?, year, month, filename? }
router.post('/payroll/import', requireSalaryView, async (req, res) => {
  const db = getPool();
  try {
    const csv = String((req.body && req.body.csv) || '');
    if (!csv.trim()) return res.status(400).json({ error: 'no_csv' });
    const r = await PRI.applyFile(db, {
      csvText: csv,
      kind: req.body.kind || null,
      mapping: (req.body.mapping && typeof req.body.mapping === 'object') ? req.body.mapping : null,
      periodYear: int(req.body.year), periodMonth: int(req.body.month),
      filename: req.body.filename ? String(req.body.filename).slice(0, 200) : null,
      actorId: req.user.id,
      remember: req.body.remember !== false,
    });
    if (r.error) {
      const { _rows, ...safe } = r;
      return res.status(r.error === 'run_finalised' ? 409 : 400).json(safe);
    }
    recordAudit({ req, action: 'import', entity_type: 'payroll_run', entity_id: r.run_id,
      meta: { file_kind: r.file_kind, rows_matched: r.rows_matched, rows_unmatched: r.rows_unmatched,
              lines_written: r.lines_written } });
    res.json(r);
  } catch (e) {
    console.error('[finance-accounts] payroll/import:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /payroll/mappings — the remembered layouts, so one learned wrong can be seen.
router.get('/payroll/mappings', requireSalaryView, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT id, file_kind, source_label, mapping, headers, times_used, last_used_at, created_at
        FROM payroll_run_import_mappings ORDER BY last_used_at DESC NULLS LAST, id DESC`);
    res.json({ mappings: rows, kinds: PRI.KINDS,
               fields: Object.fromEntries(PRI.KINDS.map(k => [k, PRI.mappingOptions(k)])) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE is not offered: a remembered mapping is corrected by importing with an
// explicit `mapping`, which overwrites it. Forgetting one and re-guessing is how
// a layout gets learned wrong twice.
router.post('/payroll/mappings/:id/forget', requireSalaryView, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE payroll_run_import_mappings SET mapping='{}'::jsonb, updated_at=now()
        WHERE id=$1 RETURNING id, file_kind`, [int(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    recordAudit({ req, action: 'update', entity_type: 'payroll_import_mapping', entity_id: rows[0].id,
      meta: { cleared: true } });
    res.json({ ok: true, cleared: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /payroll/runs/:id/post — re-post a run's totals to the ledger view.
router.post('/payroll/runs/:id/post', requireSalaryView, async (req, res) => {
  const db = getPool();
  try {
    const r = await store.postPayrollRun(db, int(req.params.id), { actorId: req.user.id });
    if (r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Funding: expected vs received ────────────────────────────────────────────
router.get('/funding', async (req, res) => {
  const db = getPool();
  try {
    const months = await store.fundingExpectedVsReceived(db, {
      year: int(req.query.year), month: int(req.query.month) });
    res.json({
      months,
      attention: months.filter(m => m.is_short || m.is_missing),
      // Two claim periods in one month means two funding_terms rows cover it —
      // the duplicate-term fault. Surfaced, because the two disagree on what is
      // expected and a person has to decide which term is real.
      months_with_two_terms: [...new Set(months
        .filter((m, _, all) => all.filter(x => x.period_year === m.period_year
                                            && x.period_month === m.period_month).length > 1)
        .map(m => `${m.period_year}-${String(m.period_month).padStart(2, '0')}`))],
    });
  } catch (e) {
    console.error('[finance-accounts] funding:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /funding/receipts — link a bank line to a claim month by hand.
router.post('/funding/receipts', async (req, res) => {
  const db = getPool();
  try {
    const lineId = int(req.body && req.body.bank_line_id);
    const periodId = int(req.body && req.body.claim_period_id);
    if (!lineId || !periodId) return res.status(400).json({ error: 'bank_line_id and claim_period_id are required' });
    const { rows: [line] } = await db.query(
      'SELECT id, amount_pence, transaction_date FROM bank_statement_lines WHERE id=$1', [lineId]);
    if (!line) return res.status(404).json({ error: 'no_such_bank_line' });
    if (Number(line.amount_pence) <= 0) return res.status(400).json({ error: 'not_a_credit' });
    const { rows } = await db.query(`
      INSERT INTO funding_claim_receipts
        (claim_period_id, bank_line_id, amount_pence, received_on, is_adjustment, matched_rule, auto, matched_by)
      VALUES ($1,$2,$3,$4,$5,'manual',false,$6)
      ON CONFLICT (bank_line_id) DO UPDATE SET
        claim_period_id = EXCLUDED.claim_period_id, is_adjustment = EXCLUDED.is_adjustment,
        matched_rule = 'manual', matched_by = EXCLUDED.matched_by
      RETURNING *`,
      [periodId, lineId, line.amount_pence, store.ymd(line.transaction_date),
       !!(req.body && req.body.is_adjustment), req.user.id]);
    await db.query(`
      INSERT INTO reconciliation_audit (event_type, bank_line_id, actor_id, detail)
      VALUES ('b524_funding_receipt_manual',$1,$2,$3)`,
      [lineId, req.user.id, JSON.stringify({ claim_period_id: periodId })]);
    res.json({ ok: true, receipt: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/funding/receipts/:lineId', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      'DELETE FROM funding_claim_receipts WHERE bank_line_id=$1 RETURNING *', [int(req.params.lineId)]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    await db.query(`
      INSERT INTO reconciliation_audit (event_type, bank_line_id, actor_id, detail)
      VALUES ('b524_funding_receipt_removed',$1,$2,$3)`,
      [int(req.params.lineId), req.user.id, JSON.stringify({ removed: rows[0] })]);
    res.json({ ok: true, removed: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auto-allocate ────────────────────────────────────────────────────────────
// POST /allocate/scan — the dry run by default. Body: { auto?, limit?, kinds? }
router.post('/allocate/scan', async (req, res) => {
  const db = getPool();
  try {
    const r = await AA.scan(db, {
      actorId: req.user.id,
      limit: int(req.body && req.body.limit) || 500,
      // `auto` may only be passed to force a dry run (false). Turning auto-apply
      // ON is a SETTING, not a request parameter — otherwise the off-by-default
      // guard is one curl away from being off.
      autoApply: (req.body && req.body.auto === false) ? false : null,
      kinds: Array.isArray(req.body && req.body.kinds) ? req.body.kinds : null,
    });
    recordAudit({ req, action: 'scan', entity_type: 'bank_auto_match',
      meta: { scanned: r.scanned, queued: r.queued, auto_applied: r.auto_applied, by_kind: r.by_kind } });
    res.json(r);
  } catch (e) {
    console.error('[finance-accounts] allocate/scan:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /allocate/queue?status=queued|applied|undone|rejected|all
router.get('/allocate/queue', async (req, res) => {
  const db = getPool();
  try {
    const status = ['queued', 'applied', 'undone', 'rejected', 'all']
      .includes(String(req.query.status)) ? String(req.query.status) : 'queued';
    const rows = await AA.queue(db, { status, limit: int(req.query.limit) || 200 });
    const s = await AA.loadSettings(db);
    res.json({ matches: rows, status, settings: {
      auto_apply: s.autoApply, enabled_kinds: [...s.enabledKinds],
      funding_short_pct: s.shortPct, funding_late_days: s.lateDays,
      card_window_working_days: [s.cardMinDays, s.cardMaxDays] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /allocate/apply — Body: { ids: [...] }. One transaction each.
router.post('/allocate/apply', async (req, res) => {
  const db = getPool();
  const ids = idList(req.body && req.body.ids);
  if (!ids.length) return res.status(400).json({ error: 'no ids' });
  const applied = [], failed = [];
  for (const id of ids) {
    try { applied.push(await AA.apply(db, id, { actorId: req.user.id, auto: false })); }
    catch (e) { failed.push({ id, error: e.message }); }
  }
  recordAudit({ req, action: 'update', entity_type: 'bank_auto_match',
    meta: { applied: applied.length, failed: failed.length } });
  res.json({ applied: applied.length, failed, results: applied });
});

// POST /allocate/undo — Body: { ids: [...], reason? }
router.post('/allocate/undo', async (req, res) => {
  const db = getPool();
  const ids = idList(req.body && req.body.ids);
  if (!ids.length) return res.status(400).json({ error: 'no ids' });
  const reason = req.body.reason ? String(req.body.reason).slice(0, 500) : null;
  const undone = [], failed = [];
  for (const id of ids) {
    try { undone.push(await AA.undo(db, id, { actorId: req.user.id, reason })); }
    catch (e) { failed.push({ id, error: e.message }); }
  }
  recordAudit({ req, action: 'update', entity_type: 'bank_auto_match',
    meta: { undone: undone.length, failed: failed.length, reason } });
  res.json({ undone: undone.length, failed, results: undone });
});

// POST /allocate/reject — Body: { ids: [...], reason? }
router.post('/allocate/reject', async (req, res) => {
  const db = getPool();
  const ids = idList(req.body && req.body.ids);
  if (!ids.length) return res.status(400).json({ error: 'no ids' });
  const out = [];
  for (const id of ids) out.push(await AA.reject(db, id, { actorId: req.user.id, reason: req.body.reason || null }));
  res.json({ rejected: out.filter(r => r.rejected).length, results: out });
});

// PUT /allocate/settings — the switches. Auto-apply lives HERE and nowhere else.
const SETTING_KEYS = ['accounts_auto_allocate', 'accounts_auto_allocate_kinds',
  'accounts_funding_short_pct', 'accounts_funding_late_days',
  'accounts_card_settle_min_days', 'accounts_card_settle_max_days'];
router.get('/allocate/settings', async (req, res) => {
  const db = getPool();
  const { rows } = await db.query('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [SETTING_KEYS]);
  res.json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])), keys: SETTING_KEYS, kinds: AA.KINDS });
});
router.put('/allocate/settings', async (req, res) => {
  const db = getPool();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const written = {};
  for (const k of SETTING_KEYS) {
    if (!(k in body)) continue;
    let v = String(body[k]);
    if (k === 'accounts_auto_allocate_kinds') {
      v = v.split(',').map(s => s.trim()).filter(s => AA.KINDS.includes(s)).join(',');
    }
    await db.query(`INSERT INTO settings (key, value) VALUES ($1,$2)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
    written[k] = v;
  }
  recordAudit({ req, action: 'update', entity_type: 'settings', meta: { b524: written } });
  res.json({ ok: true, written });
});

// ── Card settlements ─────────────────────────────────────────────────────────
router.get('/card-settlements', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.bank_line_id, c.settled_on, c.gross_pence, c.net_pence, c.fee_pence,
             c.payment_count, c.era, c.rule, c.auto, c.status, c.created_at
        FROM card_settlements c ORDER BY c.settled_on DESC NULLS LAST, c.id DESC LIMIT 200`);
    // The BCARD lines still waiting, and which era each belongs to.
    const { rows: open } = await db.query(`
      SELECT l.id, l.transaction_date, l.amount_pence, l.reconciled,
             (l.excluded_reason IS NOT NULL) AS set_aside
        FROM bank_statement_lines l
       WHERE (l.description ~* '\\yBCARD\\y' OR l.reference ~* '\\yBCARD\\y')
         AND l.amount_pence > 0
         AND NOT EXISTS (SELECT 1 FROM card_settlements c
                          WHERE c.bank_line_id = l.id AND c.status='applied')
       ORDER BY l.transaction_date`);
    const cutover = '2026-09-26';
    res.json({
      settlements: rows,
      unsettled: open.map(l => Object.assign({}, l, {
        era: store.ymd(l.transaction_date) < cutover ? 'eylog' : 'wren' })),
      eylog_cutover: cutover,
      eylog_era_count: open.filter(l => store.ymd(l.transaction_date) < cutover).length,
      eylog_era_pence: open.filter(l => store.ymd(l.transaction_date) < cutover)
        .reduce((a, l) => a + Number(l.amount_pence), 0),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /card-settlements/eylog-era — the one-click reconcile for the old lines,
// BEHIND A DRY-RUN COUNT. Body: { confirm: true } to act; without it, a count.
//
// These settle card takings recorded in EyLog, so there is nothing in
// ladn.payments for them to link to and never will be. They are marked
// reconciled with a reason that says exactly that — and deliberately NOT matched
// to an invoice, which would invent a second payment for a bill EyLog already
// shows as paid (project_eylog_opening_balances_2026-10-06).
router.post('/card-settlements/eylog-era', async (req, res) => {
  const db = getPool();
  try {
    const cutover = String((req.body && req.body.cutover) || '2026-09-26').slice(0, 10);
    const { rows: lines } = await db.query(`
      SELECT l.id, l.transaction_date, l.amount_pence
        FROM bank_statement_lines l
       WHERE (l.description ~* '\\yBCARD\\y' OR l.reference ~* '\\yBCARD\\y')
         AND l.amount_pence > 0
         AND l.transaction_date < $1::date
         AND l.reconciled = false
         AND NOT EXISTS (SELECT 1 FROM card_settlements c
                          WHERE c.bank_line_id = l.id AND c.status='applied')
       ORDER BY l.transaction_date`, [cutover]);

    const preview = {
      dry_run: true, cutover, lines: lines.length,
      pence: lines.reduce((a, l) => a + Number(l.amount_pence), 0),
      dates: lines.map(l => store.ymd(l.transaction_date)),
      line_ids: lines.map(l => l.id),
      note: 'These settle card takings recorded in EyLog. They are marked reconciled with that reason and are never matched to a Wren invoice.',
    };
    if (!(req.body && req.body.confirm === true)) return res.json(preview);

    const reason = `Barclaycard settlement of card takings recorded in EyLog (before ${cutover}) — no Wren payment exists to match, reconciled by b524`;
    let done = 0;
    for (const l of lines) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          INSERT INTO card_settlements
            (bank_line_id, settled_on, gross_pence, net_pence, fee_pence, payment_count, era, rule, auto, matched_by)
          VALUES ($1,$2,$3,$3,0,0,'eylog','card_settlement_eylog_era',false,$4)`,
          [l.id, store.ymd(l.transaction_date), l.amount_pence, req.user.id]);
        // bank_statement_lines has no note column (reconciliation_note is on
        // ladn.payments, not here — checked), so the reason lives on the
        // card_settlements row and in the audit entry below.
        await client.query(
          'UPDATE bank_statement_lines SET reconciled=true, reconciled_at=now() WHERE id=$1 AND reconciled=false',
          [l.id]);
        await client.query(`
          INSERT INTO reconciliation_audit (event_type, bank_line_id, actor_id, detail)
          VALUES ('b524_eylog_card_settlement',$1,$2,$3)`,
          [l.id, req.user.id, JSON.stringify({ reason, amount_pence: Number(l.amount_pence), cutover })]);
        await client.query('COMMIT');
        done++;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
      } finally { client.release(); }
    }
    recordAudit({ req, action: 'update', entity_type: 'card_settlement',
      meta: { eylog_era: true, cutover, reconciled: done, offered: lines.length } });
    res.json({ ok: true, dry_run: false, cutover, reconciled: done, offered: lines.length, pence: preview.pence });
  } catch (e) {
    console.error('[finance-accounts] eylog-era:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Duplicate bank lines ─────────────────────────────────────────────────────
// GET /duplicates — the detection, live, with no report row written.
router.get('/duplicates', async (req, res) => {
  const db = getPool();
  try {
    const groups = await DUP.detect(db, { since: req.query.since || null });
    const { rows: [{ d }] } = await db.query('SELECT current_database() AS d');
    // Flattened with the group's amount carried onto each dropped line, so the
    // total does not need a reverse lookup per row.
    const drop = groups.flatMap(g => g.drop.map(d2 => Object.assign({}, d2,
      { transaction_date: g.transaction_date, amount_pence: g.amount_pence,
        keep_line_id: g.keep.id, keep_source: g.keep.source })));
    res.json({
      database: d,
      cause: 'The same Barclays account is fed by more than one provider — TrueLayer open banking (source=truelayer) and the Xero bank feed (source=xero). Each keys its lines on its own provider_id under its own statement row, so the unique index (statement_id, provider_id) cannot see the twin. The Xero description is built as [Contact, Reference, LineItem].join(" — "), which is why an Ealing receipt coded to the contact "Parent" with a line "Fees in" renders as "Parent — Fees in".',
      groups: groups.length,
      lines_flagged: drop.length,
      lines_already_excluded: drop.filter(d2 => d2.already_excluded).length,
      lines_to_exclude: drop.filter(d2 => !d2.already_excluded).length,
      pence_to_exclude: drop.filter(d2 => !d2.already_excluded)
        .reduce((a, d2) => a + Math.abs(d2.amount_pence), 0),
      detail: groups,
      dry_run: true,
    });
  } catch (e) {
    console.error('[finance-accounts] duplicates:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /duplicates/report — write the dry-run report. Changes no bank line.
router.post('/duplicates/report', async (req, res) => {
  const db = getPool();
  try {
    const r = await DUP.buildReport(db, { actorId: req.user.id,
      since: req.body && req.body.since ? String(req.body.since).slice(0, 10) : null,
      notes: req.body && req.body.notes ? String(req.body.notes).slice(0, 1000) : null });
    recordAudit({ req, action: 'create', entity_type: 'bank_line_duplicate_report',
      entity_id: r.report.id, meta: { groups: r.groups_found, lines: r.lines_flagged } });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/duplicates/reports', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT id, run_at, run_by, db_name, groups_found, lines_flagged, pence_flagged,
             applied_at, applied_by, notes
        FROM bank_line_duplicate_reports ORDER BY run_at DESC LIMIT 50`);
    res.json({ reports: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/duplicates/reports/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [rep] } = await db.query(
      'SELECT * FROM bank_line_duplicate_reports WHERE id=$1', [int(req.params.id)]);
    if (!rep) return res.status(404).json({ error: 'not_found' });
    const { rows: flags } = await db.query(
      'SELECT * FROM bank_line_duplicate_flags WHERE report_id=$1 ORDER BY transaction_date, id', [rep.id]);
    res.json({ report: rep, flags });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /duplicates/reports/:id/apply — set `excluded_reason` on the flagged lines.
// Nothing calls this on a schedule. Needs { confirm: true }.
router.post('/duplicates/reports/:id/apply', async (req, res) => {
  const db = getPool();
  try {
    if (!(req.body && req.body.confirm === true)) {
      return res.status(400).json({ error: 'confirm_required',
        message: 'Applying a duplicate report sets excluded_reason on real bank lines. Send { "confirm": true }.' });
    }
    const r = await DUP.applyReport(db, int(req.params.id), { actorId: req.user.id });
    if (r.error) return res.status(409).json(r);
    recordAudit({ req, action: 'update', entity_type: 'bank_line_duplicate_report',
      entity_id: int(req.params.id), meta: r });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── The bank, as a summary ───────────────────────────────────────────────────
router.get('/bank', async (req, res) => {
  const db = getPool();
  try { res.json(await store.bankSummary(db)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /status — is the b524 migration applied here, and what is switched on.
router.get('/status', async (req, res) => {
  const db = getPool();
  try {
    const have = await store.ready(db);
    const s = have.ok ? await AA.loadSettings(db) : null;
    res.json({
      b524_ready: have.ok, missing_tables: have.missing,
      auto_apply: s ? s.autoApply : null,
      enabled_kinds: s ? [...s.enabledKinds] : [],
      card_window_working_days: s ? [s.cardMinDays, s.cardMaxDays] : null,
      can_view_salaries: await canViewSalaries(req.user),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
