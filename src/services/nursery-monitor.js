'use strict';
/**
 * nursery-monitor.js — "Sentinel for the business".
 *
 * A watchdog for the NURSERY's health (finance / staffing / absence) — the
 * business-level equivalent of the container-level Sentinel at
 * /app/docker/sentinel. Pure reads + arithmetic, no LLM.
 *
 * Exports runChecks(db) -> Promise<Array<{
 *   category, severity('info'|'warn'|'critical'), title, detail,
 *   entity_type, entity_id
 * }>>
 *
 * Each check is wrapped so a single failure (e.g. a missing optional column)
 * never aborts the whole run. Alerts are deduped downstream by `fingerprint`.
 *
 * GDPR: alert ROWS may carry a child/staff name in `detail` (they live in the
 * ladn schema, same trust boundary), but callers/runners must only print
 * counts/ids to stdout — never the detail text.
 */

const ratioEngine = require('./ratio-engine');

// ── thresholds (kept here so they're easy to tune) ──────────────────────────
const T = {
  OVERDUE_COUNT_WARN: 3,          // >= this many overdue invoices → warn
  OVERDUE_TOTAL_WARN_PENCE: 50000,   // £500 overdue in aggregate → warn
  OVERDUE_TOTAL_CRIT_PENCE: 150000,  // £1,500 overdue in aggregate → critical
  BIG_SINGLE_BALANCE_PENCE: 150000,  // one unpaid invoice over £1,500 → warn
  INCOME_DIP_RATIO: 0.70,         // this-month income < 70% of trailing-3mo avg → warn
  INCOME_DIP_MIN_BASELINE_PENCE: 100000, // ignore dip check until baseline is meaningful (£1,000)
  EXPIRY_WARN_DAYS: 60,           // credential/contract expiring within N days → warn
  EXPIRY_CRIT_DAYS: 14,           // within N days → critical
  SICK_SPIKE_MIN: 3,              // need at least this many sick spells in the window to alert
  SICK_SPIKE_RATIO: 1.5,          // trailing-30d sick count > 1.5× the 90d-derived baseline → warn
  CHILD_ABSENCE_RUN: 3,           // >= N consecutive booked-day absences → info/warn
  CHILD_ABSENCE_WINDOW_DAYS: 21,  // look-back window for the run
};

const today = () => new Date().toISOString().slice(0, 10);

function fp(parts) { return parts.filter(x => x !== undefined && x !== null).join(':'); }

// node-postgres hands a DATE column back as a JS Date, so String(d).slice(0, 10) takes the
// head of Date.prototype.toString ("Thu Aug 20") instead of the calendar date. Format with
// LOCAL getters, not toISOString(): pg builds a DATE at local midnight, which under BST
// slides back a day in UTC. Same fix as toXeroDate() in src/services/xero-invoice-push.js.
function ymd(d) {
  if (!d) return '';
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── FINANCIAL ───────────────────────────────────────────────────────────────
async function financialChecks(db) {
  const out = [];
  const day = today();

  // Overdue = anything not paid/cancelled whose due date has passed, OR an
  // explicit 'overdue' status. (No 'overdue' status exists in the data today —
  // this derivation is what makes the check actually fire on real 'sent' rows.)
  const { rows: od } = await db.query(`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM(GREATEST(amount_pence - COALESCE(funding_deduction_pence,0), 0)),0)::bigint AS total
    FROM invoices
    WHERE (status = 'overdue'
           OR (status NOT IN ('paid','cancelled','void','credited') AND due_on IS NOT NULL AND due_on < CURRENT_DATE))
  `);
  const oCount = od[0].n, oTotal = Number(od[0].total);
  if (oCount > 0 && (oCount >= T.OVERDUE_COUNT_WARN || oTotal >= T.OVERDUE_TOTAL_WARN_PENCE)) {
    const severity = oTotal >= T.OVERDUE_TOTAL_CRIT_PENCE ? 'critical' : 'warn';
    out.push({
      category: 'financial', severity,
      title: `${oCount} overdue invoice${oCount === 1 ? '' : 's'} — £${(oTotal / 100).toFixed(2)} outstanding`,
      detail: `${oCount} invoice(s) are past their due date and unpaid, totalling £${(oTotal / 100).toFixed(2)}.`,
      entity_type: 'invoices', entity_id: null,
      _fp: fp(['financial_overdue', day]),
    });
  }

  // Large single outstanding balance.
  const { rows: big } = await db.query(`
    SELECT id, GREATEST(amount_pence - COALESCE(funding_deduction_pence,0),0)::bigint AS bal, invoice_number
    FROM invoices
    WHERE status NOT IN ('paid','cancelled','void','credited')
      AND GREATEST(amount_pence - COALESCE(funding_deduction_pence,0),0) >= $1
    ORDER BY bal DESC
    LIMIT 5
  `, [T.BIG_SINGLE_BALANCE_PENCE]);
  for (const r of big) {
    out.push({
      category: 'financial', severity: 'warn',
      title: `Large outstanding balance: £${(Number(r.bal) / 100).toFixed(2)}`,
      detail: `Invoice ${r.invoice_number || ('#' + r.id)} has an outstanding balance of £${(Number(r.bal) / 100).toFixed(2)}.`,
      entity_type: 'invoices', entity_id: r.id,
      _fp: fp(['financial_bigbalance', r.id, day]),
    });
  }

  // Income dip: this calendar month vs trailing-3-month average.
  const { rows: mth } = await db.query(`
    WITH m AS (
      SELECT date_trunc('month', COALESCE(issued_on, created_at::date))::date AS mon,
             SUM(amount_pence)::bigint AS billed
      FROM invoices
      WHERE COALESCE(issued_on, created_at::date) >= (date_trunc('month', CURRENT_DATE) - INTERVAL '3 months')
        AND status NOT IN ('cancelled','void')
      GROUP BY 1
    )
    SELECT
      COALESCE((SELECT billed FROM m WHERE mon = date_trunc('month', CURRENT_DATE)::date),0)::bigint AS this_month,
      COALESCE((SELECT AVG(billed) FROM m WHERE mon < date_trunc('month', CURRENT_DATE)::date),0)::numeric AS baseline
  `);
  const thisMonth = Number(mth[0].this_month), baseline = Number(mth[0].baseline);
  if (baseline >= T.INCOME_DIP_MIN_BASELINE_PENCE && thisMonth < baseline * T.INCOME_DIP_RATIO) {
    const pct = baseline > 0 ? Math.round((thisMonth / baseline) * 100) : 0;
    out.push({
      category: 'financial', severity: 'warn',
      title: `Invoiced income down: this month is ${pct}% of the 3-month average`,
      detail: `This month invoiced £${(thisMonth / 100).toFixed(2)} vs a trailing 3-month average of £${(baseline / 100).toFixed(2)} (${pct}%).`,
      entity_type: 'invoices', entity_id: null,
      _fp: fp(['financial_incomedip', day.slice(0, 7)]), // per-month fingerprint
    });
  }

  return out;
}

// ── STAFFING ──────────────────────────────────────────────────────────────
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function staffingChecks(db) {
  const out = [];
  const day = today();

  // (a) Under-ratio weekdays this week + next week, via the existing engine.
  // Walk from today for 14 calendar days, skip weekends.
  for (let i = 0; i < 14; i++) {
    const d = addDaysStr(day, i);
    const dow = new Date(d + 'T00:00:00').getDay();
    if (dow === 0 || dow === 6) continue;
    let res;
    try { res = await ratioEngine.checkDate(db, d); } catch { continue; }
    if (res && res.pass === false) {
      // Under-ratio in the next few days is more urgent than one ~2 weeks out.
      const severity = i <= 3 ? 'critical' : 'warn';
      out.push({
        category: 'staffing', severity,
        title: `Under ratio on ${d}`,
        detail: res.reason || `Under ratio on ${d}.`,
        entity_type: 'date', entity_id: null,
        _fp: fp(['staffing_ratio', d]),
      });
    }
  }

  // (b) Expiring staff credentials / contracts. Only the columns that exist in
  // ladn.staff are queried; paediatric/first-aid EXPIRY has no column (only the
  // boolean is_first_aider) so it is intentionally NOT checked (see report).
  const creds = [
    { col: 'dbs_expiry', label: 'DBS check' },
    { col: 'contract_end', label: 'Contract' },
    { col: 'right_to_work_expiry_date', label: 'Right to work' },
    { col: 'visa_expiry_date', label: 'Visa' },
  ];
  for (const c of creds) {
    let rows;
    try {
      ({ rows } = await db.query(`
        SELECT id, first_name, last_name, ${c.col} AS expiry,
               (${c.col} - CURRENT_DATE) AS days_left
        FROM staff
        WHERE is_active = true
          AND ${c.col} IS NOT NULL
          AND ${c.col} <= CURRENT_DATE + ($1 || ' days')::interval
        ORDER BY ${c.col} ASC
      `, [T.EXPIRY_WARN_DAYS]));
    } catch { continue; } // column absent → skip silently
    for (const r of rows) {
      const dl = Number(r.days_left);
      const severity = dl <= T.EXPIRY_CRIT_DAYS ? 'critical' : 'warn';
      const when = dl < 0 ? `expired ${-dl} day(s) ago` : `expires in ${dl} day(s)`;
      out.push({
        category: 'staffing', severity,
        title: `${c.label} ${dl < 0 ? 'expired' : 'expiring'}: ${r.first_name} ${r.last_name}`,
        detail: `${c.label} for ${r.first_name} ${r.last_name} ${when} (${r.expiry}).`,
        entity_type: 'staff', entity_id: r.id,
        _fp: fp(['staffing_expiry', c.col, r.id]),
      });
    }
  }

  return out;
}

// ── ABSENCE ─────────────────────────────────────────────────────────────────
async function absenceChecks(db) {
  const out = [];
  const day = today();

  // (a) Staff sick-absence spike: trailing 30d count vs a 90d-derived 30d baseline.
  const { rows: sk } = await db.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE start_date >= CURRENT_DATE - INTERVAL '30 days'
      )::int AS recent,
      (COUNT(*) FILTER (
        WHERE start_date >= CURRENT_DATE - INTERVAL '120 days'
          AND start_date <  CURRENT_DATE - INTERVAL '30 days'
      )::numeric / 3.0) AS baseline_30d
    FROM absence_requests
    WHERE absence_type = 'sick' AND status = 'approved'
  `);
  const recent = sk[0].recent, base = Number(sk[0].baseline_30d);
  if (recent >= T.SICK_SPIKE_MIN && recent > base * T.SICK_SPIKE_RATIO) {
    out.push({
      category: 'absence', severity: 'warn',
      title: `Sick-absence spike: ${recent} sick spells in the last 30 days`,
      detail: `${recent} approved sick absences in the last 30 days vs a rolling baseline of ~${base.toFixed(1)} per 30 days.`,
      entity_type: 'absence_requests', entity_id: null,
      _fp: fp(['absence_sickspike', day.slice(0, 7)]),
    });
  }

  // (b) Children with a run of consecutive booked-day absences.
  // Aggregate per child over the window; flag those whose longest run of
  // absent booked days reaches the threshold. Names live in `detail` only.
  const { rows: kids } = await db.query(`
    WITH marked AS (
      SELECT a.child_id, a.date, a.absent,
             ROW_NUMBER() OVER (PARTITION BY a.child_id ORDER BY a.date)
               - ROW_NUMBER() OVER (PARTITION BY a.child_id, a.absent ORDER BY a.date) AS grp
      FROM attendance a
      WHERE a.date >= CURRENT_DATE - ($1 || ' days')::interval
        AND a.date <= CURRENT_DATE
    ),
    runs AS (
      SELECT child_id, COUNT(*)::int AS run_len, MAX(date) AS last_day
      FROM marked
      WHERE absent = true
      GROUP BY child_id, grp
    ),
    worst AS (
      SELECT child_id, MAX(run_len) AS run_len, MAX(last_day) AS last_day
      FROM runs GROUP BY child_id
    )
    SELECT w.child_id, w.run_len, w.last_day,
           c.first_name, c.last_name
    FROM worst w
    JOIN children c ON c.id = w.child_id
    WHERE w.run_len >= $2
      AND COALESCE(c.is_active, true) = true
      AND COALESCE(c.is_demo, false) = false
    ORDER BY w.run_len DESC
  `, [T.CHILD_ABSENCE_WINDOW_DAYS, T.CHILD_ABSENCE_RUN]);
  for (const r of kids) {
    const severity = r.run_len >= T.CHILD_ABSENCE_RUN + 2 ? 'warn' : 'info';
    out.push({
      category: 'absence', severity,
      title: `Child absent ${r.run_len} booked days running`,
      detail: `${r.first_name} ${r.last_name} has been absent ${r.run_len} consecutive booked days (to ${r.last_day}). Check for a welfare/safeguarding follow-up.`,
      entity_type: 'children', entity_id: r.child_id,
      _fp: fp(['absence_childrun', r.child_id, r.last_day]),
    });
  }

  return out;
}

// ── compliance: supplier-contract renewals + registration/licence expiries ───
async function complianceChecks(db) {
  const out = [];
  // Contract renewals — alert early enough to clear the notice period.
  const { rows: cons } = await db.query(`
    SELECT sc.id, sc.title, sc.renewal_date, sc.notice_period_days, s.name AS supplier
    FROM supplier_contracts sc LEFT JOIN suppliers s ON s.id = sc.supplier_id
    WHERE COALESCE(sc.status,'active') <> 'inactive' AND sc.renewal_date IS NOT NULL
      AND sc.renewal_date <= (CURRENT_DATE + (($1 + COALESCE(sc.notice_period_days,0)) || ' days')::interval)
      AND sc.renewal_date >= CURRENT_DATE - INTERVAL '7 days'
  `, [T.EXPIRY_WARN_DAYS]).catch(() => ({ rows: [] }));
  for (const r of cons) {
    const dl = Math.round((new Date(r.renewal_date) - Date.now()) / 86400000);
    out.push({
      category: 'compliance', severity: dl <= T.EXPIRY_CRIT_DAYS ? 'critical' : 'warn',
      title: `Contract renewal due: ${[r.supplier, r.title].filter(Boolean).join(' — ')}`,
      detail: `Renews ${ymd(r.renewal_date)} (${dl}d)${r.notice_period_days ? `; notice period ${r.notice_period_days}d` : ''}.`,
      entity_type: 'supplier_contract', entity_id: r.id, _fp: fp(['compliance_contract', r.id]),
    });
  }
  // Registration / licence expiries (ICO, MPLC, insurance, Ofsted, food hygiene…).
  const { rows: regs } = await db.query(`
    SELECT id, name, expiry_date FROM compliance_registrations
    WHERE COALESCE(status,'active') <> 'inactive' AND expiry_date IS NOT NULL
      AND expiry_date <= (CURRENT_DATE + ($1 || ' days')::interval) AND expiry_date >= CURRENT_DATE - INTERVAL '7 days'
  `, [T.EXPIRY_WARN_DAYS]).catch(() => ({ rows: [] }));
  for (const r of regs) {
    const dl = Math.round((new Date(r.expiry_date) - Date.now()) / 86400000);
    out.push({
      category: 'compliance', severity: dl <= T.EXPIRY_CRIT_DAYS ? 'critical' : 'warn',
      title: `Registration expiring: ${r.name}`,
      detail: `${r.name} expires ${ymd(r.expiry_date)} (${dl}d). Renew to stay compliant.`,
      entity_type: 'compliance_registration', entity_id: r.id, _fp: fp(['compliance_reg', r.id]),
    });
  }
  return out;
}

// ── orchestrator ─────────────────────────────────────────────────────────────
async function runChecks(db) {
  const groups = [
    ['financial', financialChecks],
    ['staffing', staffingChecks],
    ['absence', absenceChecks],
    ['compliance', complianceChecks],
  ];
  const alerts = [];
  for (const [name, fn] of groups) {
    try {
      const rows = await fn(db);
      for (const a of rows) alerts.push(a);
    } catch (e) {
      // Never let one check group abort the whole run.
      console.error(`[nursery-monitor] ${name} check failed: ${e.message}`);
    }
  }
  return alerts;
}

module.exports = { runChecks, THRESHOLDS: T };
