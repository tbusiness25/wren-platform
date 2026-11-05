'use strict';
/**
 * metrics.js — b348: the ONLY questions Wren Chat can ask the database.
 *
 * Each entry is a named, parameterised, aggregate query. The model is handed the catalogue as
 * function declarations and can call one by name with typed arguments; it can never write SQL,
 * name a table, or ask for a row. What comes back is a handful of counts / sums, labelled by
 * room, month, status or age band — never by child.
 *
 * ADDING A METRIC
 *   1. Write the SQL against the tenant schema with UNQUALIFIED table names (the pool sets the
 *      search_path; a hard-coded `ladn.` here would aim a demo edition at production data).
 *   2. It must pass guardSql() — sql-guard.js runs over every entry at load and switches off any
 *      that fail. No names, no ids, no free text, an aggregate over every protected table.
 *   3. Declare every result column. A column the SQL returns that is not declared here makes the
 *      result guard refuse the whole result.
 *   4. Pick a sensitivity. 'sensitive' withholds a count of 1–2, 'special' a count of 1–4 (policy.js
 *      MIN_CELL) — a "1" against a safeguarding status is one child, however it is labelled.
 *   Params are ints (bounded) or enums (closed lists). There are no free-text params, so a
 *   metric cannot be steered into a name.
 */

const ON_ROLL = 'c.is_active IS TRUE AND c.erased_at IS NULL';

/**
 * Vetted fragments a metric may splice in with {{name}}. They exist because a few useful
 * dimensions (an age band) need a column the banned-column scan rightly refuses to see in a
 * metric's own SQL. The fragment reduces the column to a coarse label and nothing else.
 */
const SNIPPETS = Object.freeze({
  age_band: "CASE WHEN c.date_of_birth IS NULL THEN 'Unknown' " +
            "WHEN age(current_date, c.date_of_birth) < interval '1 year' THEN 'Under 1' " +
            "WHEN age(current_date, c.date_of_birth) < interval '2 years' THEN '1 to 2' " +
            "WHEN age(current_date, c.date_of_birth) < interval '3 years' THEN '2 to 3' " +
            "WHEN age(current_date, c.date_of_birth) < interval '4 years' THEN '3 to 4' " +
            "ELSE '4 and over' END",
});

const monthsParam = (def = 6, max = 24) => ({ type: 'int', min: 1, max, default: def, description: 'How many months back, including this month' });
const dim = (name, description) => ({ name, kind: 'dimension', description });
const count = (name, description, extra) => Object.assign({ name, kind: 'measure', agg: 'count', description }, extra);
const value = (name, description, unit, extra) => Object.assign({ name, kind: 'measure', agg: 'value', unit, description }, extra);

const METRICS = [
  // ── roll and rooms ────────────────────────────────────────────────────────
  {
    id: 'children_on_roll_by_room', group: 'Roll & rooms', sensitivity: 'normal',
    title: 'Children on roll, by room',
    description: 'How many children are currently on roll (active, not erased) in each room.',
    params: {},
    columns: [dim('room', 'Room name'), count('children', 'Children on roll')],
    sql: `SELECT COALESCE(r.name, 'No room') AS room, COUNT(*)::int AS children
          FROM children c LEFT JOIN rooms r ON r.id = c.room_id
          WHERE ${ON_ROLL}
          GROUP BY 1 ORDER BY 1`,
  },
  {
    id: 'room_occupancy_vs_capacity', group: 'Roll & rooms', sensitivity: 'normal',
    title: 'Room occupancy against capacity',
    description: 'For each room: children on roll now, the room\'s capacity and legal capacity, and the spare places against capacity (negative = over).',
    params: {},
    columns: [dim('room', 'Room name'), count('on_roll', 'Children on roll'), value('capacity', 'Working capacity', 'places'),
              value('legal_capacity', 'Legal capacity', 'places'), value('spare_places', 'Capacity minus on roll', 'places')],
    sql: `WITH roll AS (
            SELECT c.room_id AS rid, COUNT(*)::int AS n FROM children c WHERE ${ON_ROLL} GROUP BY c.room_id)
          SELECT r.name AS room, COALESCE(roll.n, 0) AS on_roll, r.capacity AS capacity,
                 r.legal_capacity AS legal_capacity, r.capacity - COALESCE(roll.n, 0) AS spare_places
          FROM rooms r LEFT JOIN roll ON roll.rid = r.id ORDER BY r.id`,
  },
  {
    id: 'children_by_age_band', group: 'Roll & rooms', sensitivity: 'normal',
    title: 'Children on roll, by age band',
    description: 'Children on roll grouped into age bands (under 1, 1 to 2, 2 to 3, 3 to 4, 4 and over), worked out from date of birth today. No dates of birth are returned.',
    params: {},
    columns: [dim('age_band', 'Age band'), count('children', 'Children on roll')],
    sql: `SELECT {{age_band}} AS age_band, COUNT(*)::int AS children
          FROM children c WHERE ${ON_ROLL}
          GROUP BY 1 ORDER BY 1`,
  },
  {
    id: 'starters_and_leavers_by_month', group: 'Roll & rooms', sensitivity: 'normal',
    title: 'Starters and leavers, by month',
    description: 'Per month: children whose start date fell in it, and children whose leave date fell in it.',
    params: { months: monthsParam(12) },
    columns: [dim('month', 'Month (YYYY-MM)'), count('starters', 'Children who started'), count('leavers', 'Children who left')],
    sql: `WITH m AS (
            SELECT to_char(g, 'YYYY-MM') AS month, g AS d
            FROM generate_series(date_trunc('month', current_date) - make_interval(months => $1::int - 1),
                                 date_trunc('month', current_date), interval '1 month') AS g)
          SELECT m.month AS month,
            (SELECT COUNT(*) FROM children c WHERE c.erased_at IS NULL AND c.start_date >= m.d AND c.start_date < m.d + interval '1 month')::int AS starters,
            (SELECT COUNT(*) FROM children c WHERE c.erased_at IS NULL AND c.leave_date >= m.d AND c.leave_date < m.d + interval '1 month')::int AS leavers
          FROM m ORDER BY m.month`,
  },
  {
    id: 'bookings_by_weekday', group: 'Roll & rooms', sensitivity: 'normal',
    title: 'Booked children, by weekday',
    description: 'How many children have an active booking on each weekday, Monday to Friday.',
    params: {},
    columns: [dim('weekday', 'Weekday'), count('booked_children', 'Children with an active booking that day')],
    sql: `SELECT 'Monday' AS weekday, COUNT(*)::int AS booked_children FROM child_bookings b WHERE b.is_active IS TRUE AND b.mon IS TRUE
          UNION ALL SELECT 'Tuesday', COUNT(*)::int FROM child_bookings b WHERE b.is_active IS TRUE AND b.tue IS TRUE
          UNION ALL SELECT 'Wednesday', COUNT(*)::int FROM child_bookings b WHERE b.is_active IS TRUE AND b.wed IS TRUE
          UNION ALL SELECT 'Thursday', COUNT(*)::int FROM child_bookings b WHERE b.is_active IS TRUE AND b.thu IS TRUE
          UNION ALL SELECT 'Friday', COUNT(*)::int FROM child_bookings b WHERE b.is_active IS TRUE AND b.fri IS TRUE`,
  },
  {
    id: 'children_by_funding_type', group: 'Roll & rooms', sensitivity: 'normal',
    title: 'Funded children this term, by funding type',
    description: 'For the current funding term: children on roll on each funding type, and the funded hours per week across them.',
    params: {},
    columns: [dim('funding_type', 'Funding type'), count('children', 'Children'), value('hours_per_week', 'Total funded hours per week', 'hours')],
    sql: `SELECT COALESCE(f.funding_type, 'None recorded') AS funding_type, COUNT(*)::int AS children,
                 ROUND(COALESCE(SUM(f.total_hours_week), 0)::numeric, 1) AS hours_per_week
          FROM child_funding f JOIN funding_terms t ON t.id = f.term_id JOIN children c ON c.id = f.child_id
          WHERE t.is_current IS TRUE AND ${ON_ROLL}
          GROUP BY 1 ORDER BY 1`,
  },

  // ── attendance ────────────────────────────────────────────────────────────
  {
    id: 'attendance_by_day', group: 'Attendance', sensitivity: 'normal',
    title: 'Attendance, by day',
    description: 'For each recent day: children marked present and children marked absent in the register.',
    params: { days: { type: 'int', min: 1, max: 90, default: 14, description: 'How many days back, including today' } },
    columns: [dim('day', 'Date (YYYY-MM-DD)'), count('present', 'Present'), count('absent', 'Absent')],
    sql: `SELECT to_char(a.date, 'YYYY-MM-DD') AS day,
                 COUNT(*) FILTER (WHERE a.absent IS NOT TRUE)::int AS present,
                 COUNT(*) FILTER (WHERE a.absent IS TRUE)::int AS absent
          FROM attendance a
          WHERE a.date >= current_date - $1::int AND a.date <= current_date
          GROUP BY a.date ORDER BY a.date`,
  },

  // ── admissions ────────────────────────────────────────────────────────────
  {
    id: 'enquiries_by_stage', group: 'Admissions', sensitivity: 'normal',
    title: 'Enquiries, by stage',
    description: 'All enquiries on record, counted by pipeline stage.',
    params: {},
    columns: [dim('stage', 'Pipeline stage'), count('enquiries', 'Enquiries')],
    sql: `SELECT COALESCE(e.stage, 'unknown') AS stage, COUNT(*)::int AS enquiries
          FROM enquiries e GROUP BY 1 ORDER BY 2 DESC`,
  },
  {
    id: 'enquiries_by_month', group: 'Admissions', sensitivity: 'normal',
    title: 'Enquiries received, by month',
    description: 'How many enquiries arrived in each recent month.',
    params: { months: monthsParam(12) },
    columns: [dim('month', 'Month (YYYY-MM)'), count('enquiries', 'Enquiries received')],
    sql: `SELECT to_char(date_trunc('month', e.created_at), 'YYYY-MM') AS month, COUNT(*)::int AS enquiries
          FROM enquiries e
          WHERE e.created_at >= date_trunc('month', current_date) - make_interval(months => $1::int - 1)
          GROUP BY 1 ORDER BY 1`,
  },
  {
    id: 'waiting_list_by_status', group: 'Admissions', sensitivity: 'normal',
    title: 'Waiting list, by status and room',
    description: 'Children on the waiting list counted by status (waiting, viewing, placed …) and the room they need.',
    params: {},
    columns: [dim('status', 'Waiting-list status'), dim('room', 'Room needed'), count('children', 'Children')],
    sql: `SELECT COALESCE(w.status, 'unknown') AS status, COALESCE(w.room_needed, 'Any') AS room, COUNT(*)::int AS children
          FROM waiting_list w GROUP BY 1, 2 ORDER BY 1, 2`,
  },

  // ── staff ─────────────────────────────────────────────────────────────────
  {
    id: 'staff_headcount_by_role', group: 'Staff', sensitivity: 'normal',
    title: 'Staff headcount, by role',
    description: 'Active members of staff counted by role (practitioner, room_leader, manager, cook …). Counts only — no names.',
    params: {},
    columns: [dim('role', 'Role'), count('staff', 'Active staff')],
    sql: `SELECT COALESCE(s.role, 'unknown') AS role, COUNT(*)::int AS staff
          FROM staff s WHERE s.is_active IS NOT FALSE GROUP BY 1 ORDER BY 1`,
  },
  {
    id: 'staff_absence_by_month', group: 'Staff', sensitivity: 'sensitive',
    title: 'Staff absence, by month and type',
    description: 'Staff absence requests starting in each recent month, by type (holiday, sickness …): how many requests and how many days. Small groups are withheld.',
    params: { months: monthsParam(6, 12) },
    columns: [dim('month', 'Month (YYYY-MM)'), dim('absence_type', 'Type of absence'),
              count('requests', 'Requests', { cell: true }), value('days', 'Days', 'days')],
    sql: `SELECT to_char(date_trunc('month', a.start_date), 'YYYY-MM') AS month, COALESCE(a.absence_type, 'other') AS absence_type,
                 COUNT(*)::int AS requests, ROUND(COALESCE(SUM(a.duration_days), 0)::numeric, 1) AS days
          FROM absence_requests a
          WHERE a.start_date >= date_trunc('month', current_date) - make_interval(months => $1::int - 1)
          GROUP BY 1, 2 ORDER BY 1, 2`,
  },
  {
    id: 'mandatory_training_status', group: 'Staff', sensitivity: 'sensitive',
    title: 'Mandatory training status',
    description: 'For each type of mandatory training: how many active staff have it recorded, how many are in date, expired, or expiring within 60 days. Counts only — no names.',
    params: {},
    columns: [dim('training', 'Training type'), count('recorded', 'Staff with a record'), count('in_date', 'In date'),
              count('expired', 'Expired'), count('expiring_within_60_days', 'Expiring within 60 days')],
    sql: `SELECT COALESCE(m.training_type, 'unknown') AS training, COUNT(*)::int AS recorded,
                 COUNT(*) FILTER (WHERE m.expiry_date IS NULL OR m.expiry_date >= current_date)::int AS in_date,
                 COUNT(*) FILTER (WHERE m.expiry_date < current_date)::int AS expired,
                 COUNT(*) FILTER (WHERE m.expiry_date >= current_date AND m.expiry_date < current_date + 60)::int AS expiring_within_60_days
          FROM mandatory_training m JOIN staff s ON s.id = m.staff_id
          WHERE s.is_active IS NOT FALSE
          GROUP BY 1 ORDER BY 1`,
  },

  // ── money ─────────────────────────────────────────────────────────────────
  {
    id: 'invoices_by_month_status', group: 'Money', sensitivity: 'normal',
    title: 'Invoices, by billing month and status',
    description: 'Invoices for each recent billing month, by status (draft, sent, paid, overdue): how many and the total amount in pounds. Credit notes are included as negatives.',
    params: { months: monthsParam(6, 24) },
    columns: [dim('month', 'Billing month (YYYY-MM)'), dim('status', 'Invoice status'), count('invoices', 'Invoices'), value('total_gbp', 'Total amount', 'GBP')],
    sql: `SELECT to_char(make_date(i.period_year, i.period_month, 1), 'YYYY-MM') AS month, COALESCE(i.status, 'unknown') AS status,
                 COUNT(*)::int AS invoices, ROUND(COALESCE(SUM(i.amount_pence), 0) / 100.0, 2) AS total_gbp
          FROM invoices i
          WHERE i.period_year IS NOT NULL AND i.period_month BETWEEN 1 AND 12
            AND make_date(i.period_year, i.period_month, 1) >= date_trunc('month', current_date) - make_interval(months => $1::int - 1)
          GROUP BY 1, 2 ORDER BY 1, 2`,
  },
  {
    id: 'outstanding_invoices_summary', group: 'Money', sensitivity: 'sensitive',
    title: 'Unpaid invoices, by age',
    description: 'Invoices that are sent or overdue, grouped by how long past due they are: how many and the total in pounds. Small groups are withheld.',
    params: {},
    columns: [dim('status', 'Invoice status'), dim('age', 'How overdue'), count('invoices', 'Invoices', { cell: true }), value('total_gbp', 'Total amount', 'GBP')],
    sql: `SELECT COALESCE(i.status, 'unknown') AS status,
                 CASE WHEN i.due_on IS NULL THEN 'No due date' WHEN i.due_on >= current_date THEN 'Not yet due'
                      WHEN current_date - i.due_on <= 30 THEN '1-30 days overdue' WHEN current_date - i.due_on <= 60 THEN '31-60 days overdue'
                      ELSE 'Over 60 days overdue' END AS age,
                 COUNT(*)::int AS invoices, ROUND(COALESCE(SUM(i.amount_pence), 0) / 100.0, 2) AS total_gbp
          FROM invoices i WHERE i.status IN ('sent', 'overdue')
          GROUP BY 1, 2 ORDER BY 1, 2`,
  },

  // ── care and safety ───────────────────────────────────────────────────────
  {
    id: 'observations_by_month', group: 'Care & safety', sensitivity: 'normal',
    title: 'Observations recorded, by month',
    description: 'How many observations were recorded in each recent month, and how many of those were shared with parents. Counts only — no observation text.',
    params: { months: monthsParam(6, 24) },
    columns: [dim('month', 'Month (YYYY-MM)'), count('observations', 'Observations recorded'), count('shared_with_parents', 'Shared with parents')],
    sql: `SELECT to_char(date_trunc('month', o.created_at), 'YYYY-MM') AS month, COUNT(*)::int AS observations,
                 COUNT(*) FILTER (WHERE o.shared_with_parents IS TRUE)::int AS shared_with_parents
          FROM observations o
          WHERE o.created_at >= date_trunc('month', current_date) - make_interval(months => $1::int - 1)
          GROUP BY 1 ORDER BY 1`,
  },
  {
    id: 'incidents_by_month_type', group: 'Care & safety', sensitivity: 'sensitive',
    title: 'Incidents, by month and type',
    description: 'Incidents and accidents recorded in each recent month, by type, with how many were RIDDOR-reportable. Counts only. Small groups are withheld.',
    params: { months: monthsParam(6, 24) },
    columns: [dim('month', 'Month (YYYY-MM)'), dim('incident_type', 'Incident type'), count('incidents', 'Incidents'), count('riddor_reportable', 'RIDDOR-reportable')],
    sql: `SELECT to_char(date_trunc('month', n.incident_date), 'YYYY-MM') AS month, COALESCE(n.incident_type, 'other') AS incident_type,
                 COUNT(*)::int AS incidents, COUNT(*) FILTER (WHERE n.riddor_reportable IS TRUE)::int AS riddor_reportable
          FROM incidents n
          WHERE n.incident_date >= date_trunc('month', current_date) - make_interval(months => $1::int - 1)
          GROUP BY 1, 2 ORDER BY 1, 2`,
  },
  {
    id: 'medicine_administrations_by_month', group: 'Care & safety', sensitivity: 'sensitive',
    title: 'Medicine administrations, by month',
    description: 'How many medicine administrations were recorded in each recent month. A count only — no child, medicine or dose. Small groups are withheld.',
    params: { months: monthsParam(6, 24) },
    columns: [dim('month', 'Month (YYYY-MM)'), count('administrations', 'Administrations recorded')],
    sql: `SELECT to_char(date_trunc('month', m.time_given), 'YYYY-MM') AS month, COUNT(*)::int AS administrations
          FROM medicine_records m
          WHERE m.time_given >= date_trunc('month', current_date) - make_interval(months => $1::int - 1)
          GROUP BY 1 ORDER BY 1`,
  },
  // ── money (b365) ──────────────────────────────────────────────────────────
  // Three aggregates over the P&L and the invoice ledger. There is deliberately
  // NO wage-bill metric here: the total wage bill is company money, but it is
  // also 26 people's pay divided by 26, it is gated a second time behind
  // view_staff_salaries everywhere else in Wren (b301), and this is the one
  // surface that leaves the building. The on-site assistant already answers it.
  {
    id: 'pnl_by_month', group: 'Money', sensitivity: 'normal',
    title: 'Profit & loss by month (Xero)',
    description: 'For each of the last N months: total income, total expenses and the net, from the local '
               + 'mirror of Xero\'s P&L. Months that have not synced are simply absent — they are never estimated.',
    params: { months: monthsParam(12, 36) },
    columns: [dim('month', 'Month'), value('income', 'Income', 'GBP'),
              value('expenses', 'Expenses', 'GBP'), value('net', 'Income less expenses', 'GBP')],
    sql: `SELECT to_char(p.period_from, 'YYYY-MM') AS month,
                 ROUND(SUM(l.amount_pence) FILTER (WHERE l.section ILIKE '%income%')  / 100.0, 2) AS income,
                 ROUND(SUM(l.amount_pence) FILTER (WHERE l.section NOT ILIKE '%income%') / 100.0, 2) AS expenses,
                 ROUND((COALESCE(SUM(l.amount_pence) FILTER (WHERE l.section ILIKE '%income%'), 0)
                      - COALESCE(SUM(l.amount_pence) FILTER (WHERE l.section NOT ILIKE '%income%'), 0)) / 100.0, 2) AS net
            FROM finance_pnl_periods p
            JOIN finance_pnl_lines l ON l.period_id = p.id
           WHERE p.period_from >= date_trunc('month', current_date) - make_interval(months => $1::int - 1)
           GROUP BY 1 ORDER BY 1`,
  },
  {
    id: 'spend_by_category_by_month', group: 'Money', sensitivity: 'normal',
    title: 'Spend by category, by month',
    description: 'What each expense category cost in each of the last N months, from the local mirror of '
               + 'Xero\'s P&L. Categories are the accounts in the chart of accounts, not suppliers.',
    params: { months: monthsParam(6, 24) },
    columns: [dim('month', 'Month'), dim('category', 'Expense account'), value('spend', 'Spend', 'GBP')],
    sql: `SELECT to_char(p.period_from, 'YYYY-MM') AS month,
                 l.account_name AS category,
                 ROUND(SUM(l.amount_pence) / 100.0, 2) AS spend
            FROM finance_pnl_periods p
            JOIN finance_pnl_lines l ON l.period_id = p.id
           WHERE l.section NOT ILIKE '%income%'
             AND p.period_from >= date_trunc('month', current_date) - make_interval(months => $1::int - 1)
           GROUP BY 1, 2 ORDER BY 1, 2`,
  },
  {
    id: 'fee_income_by_invoice_period', group: 'Money', sensitivity: 'normal',
    title: 'Fee income by the period of the invoice it pays',
    description: 'Money received from families, counted in the month of the INVOICE it pays rather than the day '
               + 'the bank moved — so an October invoice settled on 28 September counts in October. Money matched '
               + 'to no invoice has no period and is not in these figures.',
    params: { months: monthsParam(12, 36) },
    columns: [dim('month', 'Invoice period'), value('received', 'Received', 'GBP'),
              count('allocations', 'Payment allocations')],
    sql: `SELECT to_char(make_date(v.period_year, v.period_month, 1), 'YYYY-MM') AS month,
                 ROUND(SUM(v.amount_pence) / 100.0, 2) AS received,
                 COUNT(*)::int AS allocations
            FROM v_allocation_periods v
           WHERE v.period_year IS NOT NULL AND v.period_month IS NOT NULL
             AND make_date(v.period_year, v.period_month, 1)
                 >= date_trunc('month', current_date) - make_interval(months => $1::int - 1)
           GROUP BY 1 ORDER BY 1`,
  },
  {
    id: 'safeguarding_concerns_by_status', group: 'Care & safety', sensitivity: 'special',
    title: 'Safeguarding concerns, by status',
    description: 'How many safeguarding concerns are recorded, by status (open, closed …). A count only. Groups of fewer than 5 are withheld and shown as "<5"; a real zero is shown as 0.',
    params: {},
    columns: [dim('status', 'Concern status'), count('concerns', 'Concerns')],
    sql: `SELECT COALESCE(s.status, 'unknown') AS status, COUNT(*)::int AS concerns
          FROM safeguarding_concerns s GROUP BY 1 ORDER BY 1`,
  },
  {
    id: 'children_flags_summary', group: 'Care & safety', sensitivity: 'special',
    title: 'Children with a support flag',
    description: 'Among children on roll: how many carry a SEND flag, are looked after, are eligible for the early years pupil premium, or are two-year funded. Counts only. Groups of fewer than 5 are withheld and shown as "<5".',
    params: {},
    columns: [count('on_roll', 'Children on roll'), count('with_send_flag', 'With a SEND flag'), count('looked_after', 'Looked after'),
              count('pupil_premium', 'Early years pupil premium'), count('two_year_funded', 'Two-year funded')],
    sql: `SELECT COUNT(*)::int AS on_roll,
                 COUNT(*) FILTER (WHERE c.send_needs IS TRUE)::int AS with_send_flag,
                 COUNT(*) FILTER (WHERE c.looked_after IS TRUE)::int AS looked_after,
                 COUNT(*) FILTER (WHERE c.pupil_premium IS TRUE)::int AS pupil_premium,
                 COUNT(*) FILTER (WHERE c.two_year_funded IS TRUE)::int AS two_year_funded
          FROM children c WHERE ${ON_ROLL}`,
  },
];

module.exports = { METRICS, SNIPPETS };
