'use strict';
// ===========================================================================
// briefings.js — b503. ONE briefings engine: weekly (every Monday), monthly (the first Monday) and termly (the first Monday of each funding
// term, plus a mid-term check). Toby: "Weekly briefings get sent to us every Monday morning and it's just a summary of the past week, what's
// on our to-do list this week, what's urgent, what's not so urgent… monthly briefings cover a slightly wider period and discuss staffing…
// a termly run where maybe we look at resources and planning."
//
//   build(db, period, scope, asOf) -> { period, scope, as_of, title, window, sections:[{ key, title, headline, child_data, money, items:[{ text, urgency, reason, link }] }], counts }
//     period  'week' | 'month' | 'term'
//     scope   { kind:'setting', money:true }  managers (Toby, the office manager, the admissions lead)
//             { kind:'setting', money:false } the deputy: the whole setting minus money
//             { kind:'room', room_id }        a room leader: their room only
//     asOf    the Monday it is for (YYYY-MM-DD; default: the Monday on or before today, London)
//   urgency 'urgent' (always with the REASON it is urgent), 'this_period', 'info'. Every item names the screen it links to by a KEY
//   (the page maps keys to URLs per portal), never a literal URL.
//
// Everything is READ from the live tables and from the engines that already own the answer (b501 tasks, b502 outstanding details, the training
// matrix): nothing is stored twice except the finished briefing itself (the archive, table `briefings`). A section that cannot be built (a table
// this edition lacks) says so instead of failing the whole briefing.
//
// GDPR: a briefing names children, so it exists only inside Wren (Roost, EY, and the HR page WITHOUT its child_data sections). It is never
// emailed. The one thing that can leave Wren is the notification, which carries COUNTS ONLY (deliver()).
// ===========================================================================

const fs = require('fs');
const path = require('path');
const taskReminders = require('./task-reminders');
const OUT = require('./outstanding');

const TZ = 'Europe/London';
const ISO = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ISO(d); };
const plural = (n, w, ws) => `${n} ${n === 1 ? w : (ws || w + 's')}`;
const money = p => '£' + (Number(p || 0) / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });
const nameList = (arr, n = 8) => arr.slice(0, n).join(', ') + (arr.length > n ? `, and ${arr.length - n} more` : '');

async function londonToday(db) {
  const { rows: [r] } = await db.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [TZ]);
  return r.d;
}
function mondayOnOrBefore(day) {
  const d = new Date(day + 'T00:00:00Z'); const dow = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() - (dow - 1)); return ISO(d);
}

function windows(period, asOf) {
  if (period === 'week') return { lastFrom: addDays(asOf, -7), lastTo: addDays(asOf, -1), thisFrom: asOf, thisTo: addDays(asOf, 6), lastLabel: 'Last week', thisLabel: 'This week', word: 'weekly' };
  if (period === 'month') return { lastFrom: addDays(asOf, -28), lastTo: addDays(asOf, -1), thisFrom: asOf, thisTo: addDays(asOf, 27), lastLabel: 'The last four weeks', thisLabel: 'The next four weeks', word: 'monthly' };
  return { lastFrom: addDays(asOf, -91), lastTo: addDays(asOf, -1), thisFrom: asOf, thisTo: addDays(asOf, 90), lastLabel: 'This term so far', thisLabel: 'Next term', word: 'termly' };
}

// run one section builder; if it throws (table missing on this edition) the briefing still builds
async function guarded(key, title, childData, isMoney, fn) {
  try {
    const r = await fn();
    if (!r) return null;
    return Object.assign({ key, title, child_data: !!childData, money: !!isMoney, headline: '', items: [] }, r);
  } catch (e) {
    return { key, title, child_data: !!childData, money: !!isMoney, headline: 'This section could not be built here.', items: [{ text: String(e.message).slice(0, 120), urgency: 'info', link: null }], failed: true };
  }
}
const I = (text, urgency, link, reason) => Object.assign({ text, urgency: urgency || 'info', link: link || null }, reason ? { reason } : {});

async function build(db, period, scope, asOfIn) {
  if (!['week', 'month', 'term'].includes(period)) throw new Error('period must be week, month or term');
  const today = await londonToday(db);
  const asOf = asOfIn ? mondayOnOrBefore(asOfIn) : mondayOnOrBefore(today);
  const W = windows(period, asOf);
  const S = Object.assign({ kind: 'setting', money: true }, scope || {});
  const room = S.kind === 'room' ? Number(S.room_id) : null;
  if (S.kind === 'room' && !room) throw new Error('a room scope needs room_id');
  const showMoney = S.kind === 'setting' && S.money !== false;
  const showStaffPrivate = S.kind === 'setting';
  const q = async (sql, p) => (await db.query(sql, p || [])).rows;
  const roomOfChild = (alias, params) => { if (!room) return ''; params.push(room); return ` AND ${alias}.room_id = $${params.length}`; };
  const defaultTime = await taskReminders.getDefaultDueTime(db);
  const dueAt = a => taskReminders.DUE_AT_SQL(a, '$1', '$2');
  const out = [];
  const add = s => { if (s) out.push(s); };

  // ═══ LAST PERIOD ══════════════════════════════════════════════════════════
  add(await guarded('attendance', 'Attendance and occupancy', true, false, async () => {
    const p = [W.lastFrom, W.lastTo]; const rc = roomOfChild('c', p);
    const rows = await q(`SELECT a.date::text AS d, count(DISTINCT a.child_id) FILTER (WHERE NOT COALESCE(a.absent,false))::int AS present, count(*) FILTER (WHERE COALESCE(a.absent,false))::int AS absent
                            FROM attendance a JOIN children c ON c.id = a.child_id WHERE a.date BETWEEN $1 AND $2${rc} GROUP BY 1 ORDER BY 1`, p);
    const days = rows.filter(r => r.present > 0);
    const avg = days.length ? Math.round(days.reduce((n, r) => n + r.present, 0) / days.length) : 0;
    const absent = rows.reduce((n, r) => n + r.absent, 0);
    const p2 = []; const rc2 = roomOfChild('c', p2);
    const [{ n: onRoll }] = await q(`SELECT count(*)::int AS n FROM children c WHERE c.is_active = true${rc2}`, p2);
    return { headline: `${avg} children in on an average open day (${plural(days.length, 'day')} recorded), ${plural(absent, 'absence')}. ${onRoll} on roll.`,
      items: days.length ? [I(`Busiest day ${days.slice().sort((a, b) => b.present - a.present)[0].d}: ${Math.max(...days.map(r => r.present))} children. Quietest ${days.slice().sort((a, b) => a.present - b.present)[0].d}: ${Math.min(...days.map(r => r.present))}.`, 'info', 'attendance')] : [I('No attendance was recorded in this period.', 'info', 'attendance')] };
  }));

  add(await guarded('starters_leavers', 'New starters and leavers', true, false, async () => {
    const p = [W.lastFrom, W.lastTo]; const rc = roomOfChild('c', p);
    const st = await q(`SELECT first_name || ' ' || last_name AS n FROM children c WHERE c.start_date BETWEEN $1 AND $2${rc} ORDER BY c.start_date`, p);
    const p2 = [W.lastFrom, W.lastTo]; const rc2 = roomOfChild('c', p2);
    const lv = await q(`SELECT first_name || ' ' || last_name AS n FROM children c WHERE c.leave_date BETWEEN $1 AND $2${rc2} ORDER BY c.leave_date`, p2);
    return { headline: `${plural(st.length, 'starter')}, ${plural(lv.length, 'leaver')}.`, items: [].concat(st.length ? [I('Started: ' + nameList(st.map(r => r.n)), 'info', 'children')] : [], lv.length ? [I('Left: ' + nameList(lv.map(r => r.n)), 'info', 'children')] : []) };
  }));

  add(await guarded('incidents', 'Accidents and incidents', true, false, async () => {
    const p = [W.lastFrom, W.lastTo]; const rc = roomOfChild('c', p);
    const [t] = await q(`SELECT count(*)::int AS n FROM incidents i JOIN children c ON c.id = i.child_id WHERE i.incident_date BETWEEN $1 AND $2${rc}`, p);
    const p2 = [asOf]; const rc2 = roomOfChild('c', p2);
    const unsigned = await q(`SELECT i.id, c.first_name || ' ' || c.last_name AS n, i.incident_date::text AS d FROM incidents i JOIN children c ON c.id = i.child_id
                               WHERE COALESCE(i.parent_signature_requested,false) AND i.parent_signed_at IS NULL AND i.incident_date <= ($1::date - 3)${rc2} ORDER BY i.incident_date`, p2);
    const items = unsigned.length ? [I(`${plural(unsigned.length, 'accident form')} not signed by parents for more than 3 days: ${nameList(unsigned.map(u => u.n + ' (' + u.d + ')'))}`, 'urgent', 'incidents', 'An accident form unsigned for more than 3 days is a gap in the record Ofsted can ask for.')] : [];
    return { headline: `${plural(t.n, 'accident or incident')} logged.${unsigned.length ? ' ' + unsigned.length + ' unsigned by parents.' : ''}`, items };
  }));

  add(await guarded('observations', 'Observations and coverage', true, false, async () => {
    const p = [W.lastFrom, W.lastTo]; const rc = roomOfChild('c', p);
    const [t] = await q(`SELECT count(*)::int AS n FROM observations o JOIN children c ON c.id = o.child_id WHERE o.created_at::date BETWEEN $1 AND $2${rc}`, p);
    const p2 = [asOf]; const rc2 = roomOfChild('c', p2);
    const gaps = await q(`SELECT c.first_name || ' ' || c.last_name AS n FROM children c WHERE c.is_active = true${rc2}
                            AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.child_id = c.id AND o.created_at::date > ($1::date - 14)) ORDER BY c.first_name`, p2);
    return { headline: `${plural(t.n, 'observation')} written. ${plural(gaps.length, 'child', 'children')} not observed in the last 2 weeks.`,
      items: gaps.length ? [I(`Not observed in 2 weeks: ${nameList(gaps.map(g => g.n), 10)}`, gaps.length > 5 ? 'this_period' : 'info', 'observations')] : [I('Every child has been observed in the last 2 weeks.', 'info', 'observations')] };
  }));

  add(await guarded('tasks_last', 'Tasks: done on time, late, not done', false, false, async () => {
    const p = [defaultTime, TZ, W.lastFrom, W.lastTo]; let extra = '';
    if (room) { p.push(room); extra = ` AND s.room_id = $${p.length}`; }
    const rows = await q(`
      WITH lines AS (
        SELECT a.staff_id, ${dueAt('t')} AS due_at, (a.status='done') AS done, a.completed_at AS done_at
          FROM task_assignees a JOIN tasks t ON t.id = a.task_id
         WHERE t.category='nursery' AND t.due_date BETWEEN $3 AND $4 AND t.status <> 'cancelled' AND t.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)
        UNION ALL
        SELECT t.owner_staff_id, ${dueAt('t')}, (t.status='done'), t.completed_at FROM tasks t
         WHERE t.owner_staff_id IS NOT NULL AND t.category='nursery' AND t.due_date BETWEEN $3 AND $4 AND t.status <> 'cancelled' AND t.archived_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id) AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id))
      SELECT s.id, s.first_name || ' ' || s.last_name AS name, count(*)::int AS assigned,
             count(*) FILTER (WHERE l.done AND l.done_at <= l.due_at)::int AS on_time, count(*) FILTER (WHERE l.done AND (l.done_at IS NULL OR l.done_at > l.due_at))::int AS late,
             count(*) FILTER (WHERE NOT l.done AND l.due_at < now())::int AS not_done
        FROM lines l JOIN staff s ON s.id = l.staff_id AND s.is_active = true${extra} GROUP BY s.id, s.first_name, s.last_name ORDER BY not_done DESC, name`, p);
    const tot = rows.reduce((a, r) => ({ on: a.on + r.on_time, late: a.late + r.late, nd: a.nd + r.not_done }), { on: 0, late: 0, nd: 0 });
    return { headline: `${tot.on} done on time, ${tot.late} done late, ${tot.nd} not done.`,
      items: rows.filter(r => r.not_done || r.late).map(r => I(`${r.name}: ${r.on_time} on time, ${r.late} late, ${r.not_done} not done (of ${r.assigned})`, r.not_done ? 'urgent' : 'info', 'tasks', r.not_done ? 'Work that has passed its deadline and is still open.' : null)) };
  }));

  add(await guarded('enquiries', 'Enquiries and viewings', true, false, async () => {
    if (room) return null;
    const [e] = await q(`SELECT count(*)::int AS n FROM enquiries WHERE created_at::date BETWEEN $1 AND $2`, [W.lastFrom, W.lastTo]);
    let v = { held: 0, cancelled: 0 };
    try { [v] = await q(`SELECT count(*) FILTER (WHERE status IN ('confirmed','attended','completed'))::int AS held, count(*) FILTER (WHERE status IN ('cancelled','declined'))::int AS cancelled FROM viewings WHERE slot_date BETWEEN $1 AND $2`, [W.lastFrom, W.lastTo]); } catch (_) { /* no viewings table */ }
    return { headline: `${plural(e.n, 'new enquiry', 'new enquiries')}, ${plural(v.held, 'viewing')} booked or held, ${v.cancelled} cancelled.`, items: [] };
  }));

  if (showMoney) add(await guarded('invoices_last', 'Invoices: paid and outstanding', false, true, async () => {
    const [paid] = await q(`SELECT count(*)::int AS n, COALESCE(sum(amount_pence),0)::bigint AS p FROM invoices WHERE paid_on BETWEEN $1 AND $2`, [W.lastFrom, W.lastTo]);
    const [od] = await q(`SELECT count(*)::int AS n, COALESCE(sum(amount_pence),0)::bigint AS p FROM invoices WHERE status NOT IN ('paid','void','cancelled','draft') AND paid_on IS NULL AND due_on < $1::date AND credit_note_for_id IS NULL`, [asOf]);
    const [old] = await q(`SELECT count(*)::int AS n FROM invoices WHERE status NOT IN ('paid','void','cancelled','draft') AND paid_on IS NULL AND due_on < ($1::date - 30) AND credit_note_for_id IS NULL`, [asOf]);
    return { headline: `${plural(paid.n, 'invoice')} paid (${money(paid.p)}). ${plural(od.n, 'invoice')} overdue (${money(od.p)}).`,
      items: old.n ? [I(`${plural(old.n, 'invoice')} more than 30 days overdue.`, 'this_period', 'finance', 'Money owed for over a month is the first thing to chase.')] : [] };
  }));

  // ═══ THIS PERIOD ══════════════════════════════════════════════════════════
  add(await guarded('tasks_due', 'On your list: tasks due, by person', false, false, async () => {
    const p = [defaultTime, TZ, W.thisFrom, W.thisTo]; let extra = '';
    if (room) { p.push(room); extra = ` AND s.room_id = $${p.length}`; }
    const rows = await q(`
      SELECT s.first_name || ' ' || s.last_name AS name, count(*)::int AS due, count(*) FILTER (WHERE ${dueAt('t')} < now())::int AS overdue
        FROM tasks t JOIN task_assignees a ON a.task_id = t.id AND a.status <> 'done' JOIN staff s ON s.id = a.staff_id AND s.is_active = true${extra}
       WHERE t.status = ANY(ARRAY['open','in_progress']) AND t.category='nursery' AND t.archived_at IS NULL AND t.due_date <= $4
         AND (t.due_date >= $3 OR ${dueAt('t')} < now()) AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)
       GROUP BY s.id, s.first_name, s.last_name ORDER BY overdue DESC, due DESC`, p);
    const total = rows.reduce((n, r) => n + r.due, 0), od = rows.reduce((n, r) => n + r.overdue, 0);
    return { headline: `${plural(total, 'task')} due or overdue${od ? ', ' + od + ' already overdue' : ''}.`, items: rows.map(r => I(`${r.name}: ${r.due} due${r.overdue ? ', ' + r.overdue + ' overdue' : ''}`, r.overdue ? 'urgent' : 'this_period', 'tasks', r.overdue ? 'These are already past their deadline.' : null)) };
  }));

  add(await guarded('events', 'Events and trips', false, false, async () => {
    const rows = await q(`SELECT title, event_date::text AS d FROM events WHERE event_date BETWEEN $1 AND $2 AND COALESCE(is_published, true) ORDER BY event_date LIMIT 12`, [W.thisFrom, W.thisTo]);
    return { headline: rows.length ? `${plural(rows.length, 'event')} coming up.` : 'No events booked.', items: rows.map(r => I(`${r.d}: ${r.title}`, 'this_period', 'events')) };
  }));

  if (showStaffPrivate) add(await guarded('staff_absence', 'Staff absences and cover', false, false, async () => {
    const rows = await q(`SELECT s.first_name || ' ' || s.last_name AS n, a.start_date::text AS s, a.end_date::text AS e, a.absence_type FROM absence_requests a JOIN staff s ON s.id = a.staff_id
                           WHERE a.status IN ('approved','auto_approved') AND a.start_date <= $2 AND a.end_date >= $1 ORDER BY a.start_date LIMIT 20`, [W.thisFrom, W.thisTo]);
    return { headline: `${plural(rows.length, 'approved absence')} in this period.`, items: rows.map(r => I(`${r.n}: ${r.s} to ${r.e} (${String(r.absence_type || '').replace(/_/g, ' ')})`, 'this_period', 'absence')) };
  }));

  add(await guarded('birthdays', 'Children\'s birthdays', true, false, async () => {
    const p = [W.thisFrom, W.thisTo]; const rc = roomOfChild('c', p);
    const rows = await q(`SELECT c.first_name || ' ' || c.last_name AS n, to_char(c.date_of_birth, 'DD Mon') AS d,
                                  extract(year FROM age(($1::date + (c.date_of_birth - date_trunc('year', c.date_of_birth)::date)::int), c.date_of_birth))::int AS turning
                            FROM children c WHERE c.is_active = true AND c.date_of_birth IS NOT NULL${rc}
                             AND (to_char(c.date_of_birth, 'MMDD') BETWEEN to_char($1::date, 'MMDD') AND to_char($2::date, 'MMDD')) ORDER BY to_char(c.date_of_birth, 'MMDD') LIMIT 30`, p);
    return { headline: rows.length ? `${plural(rows.length, 'birthday')} in this period.` : 'No birthdays.', items: rows.map(r => I(`${r.n} — ${r.d}`, 'info', 'children')) };
  }));

  if (showMoney) add(await guarded('deadlines', 'Deadlines: funding, invoices, payroll', false, true, async () => {
    const items = [];
    const [t] = await q(`SELECT name, end_date::text AS e FROM funding_terms WHERE is_current LIMIT 1`);
    if (t && t.e <= W.thisTo && t.e >= W.thisFrom) items.push(I(`The current funding term ends ${t.e} (${t.name}).`, 'this_period', 'funding'));
    const [pr] = await q(`SELECT period_label, status FROM payroll_runs ORDER BY period_year DESC, period_month DESC LIMIT 1`);
    if (pr && !['finalised', 'paid', 'final'].includes(String(pr.status))) items.push(I(`Payroll for ${pr.period_label} is ${pr.status}.`, 'this_period', 'payroll'));
    const [due] = await q(`SELECT count(*)::int AS n FROM invoices WHERE due_on BETWEEN $1 AND $2 AND paid_on IS NULL AND status NOT IN ('paid','void','cancelled','draft')`, [W.thisFrom, W.thisTo]);
    if (due.n) items.push(I(`${plural(due.n, 'invoice')} fall due in this period.`, 'this_period', 'finance'));
    return { headline: items.length ? `${plural(items.length, 'deadline')} to watch.` : 'No deadlines this period.', items };
  }));

  add(await guarded('outstanding', 'Outstanding details checklist', true, false, async () => {
    const cl = await OUT.checklist(db, room ? { room_id: room } : {});
    const items = cl.lines.slice(0, 14).map(l => I(`${l.label}: ${l.count}${l.children.length ? ' (' + nameList(l.children, 6) + ')' : ''}`, l.who === 'us' ? 'this_period' : 'info', 'missing_details'));
    return { headline: cl.total ? `${cl.total} items outstanding. Chase the families, or sort the ones that are ours.` : 'Nothing outstanding.', items };
  }));
  if (showStaffPrivate) add(await guarded('staff_outstanding', 'Staff records outstanding', false, false, async () => {
    const st = await OUT.forStaff(db);
    const exp = st.flatMap(s => s.items.filter(i => i.expired).map(i => I(`${s.name}: ${i.label}`, 'urgent', 'staff', 'A record that has expired is a safer-recruitment gap.')));
    const rest = st.flatMap(s => s.items.filter(i => !i.expired).map(i => I(`${s.name}: ${i.label}${i.detail ? ' - ' + i.detail : ''}`, 'this_period', 'staff')));
    return { headline: `${plural(st.length, 'person', 'people')} with something outstanding on their record.`, items: exp.concat(rest).slice(0, 25) };
  }));

  // ═══ MONTHLY AND TERMLY ═══════════════════════════════════════════════════
  if (period !== 'week' && showStaffPrivate) {
    add(await guarded('supervisions', 'Staffing: supervisions', false, false, async () => {
      const over = await q(`SELECT s.first_name || ' ' || s.last_name AS n, sv.scheduled_date::text AS d FROM supervisions sv JOIN staff s ON s.id = sv.staff_id AND s.is_active
                             WHERE sv.conducted_date IS NULL AND sv.scheduled_date < $1::date AND COALESCE(sv.status,'') NOT IN ('cancelled','completed') ORDER BY sv.scheduled_date LIMIT 15`, [asOf]);
      const soon = await q(`SELECT s.first_name || ' ' || s.last_name AS n, sv.scheduled_date::text AS d FROM supervisions sv JOIN staff s ON s.id = sv.staff_id AND s.is_active
                             WHERE sv.conducted_date IS NULL AND sv.scheduled_date BETWEEN $1::date AND $2::date ORDER BY sv.scheduled_date LIMIT 15`, [W.thisFrom, W.thisTo]);
      return { headline: `${over.length} overdue, ${soon.length} due soon.`, items: over.map(r => I(`${r.n}: supervision was due ${r.d}`, 'urgent', 'supervisions', 'Supervisions are a statutory expectation and this one is late.')).concat(soon.map(r => I(`${r.n}: due ${r.d}`, 'this_period', 'supervisions'))) };
    }));
    add(await guarded('bradford', 'Staffing: absence, lateness and probation', false, false, async () => {
      const brad = await q(`SELECT s.first_name || ' ' || s.last_name AS n, count(*)::int AS spells, COALESCE(sum(a.days_count),0)::numeric AS days
                             FROM absence_requests a JOIN staff s ON s.id = a.staff_id AND s.is_active WHERE a.status IN ('approved','auto_approved') AND a.absence_type ILIKE '%sick%' AND a.start_date >= ($1::date - 364)
                             GROUP BY s.id, s.first_name, s.last_name HAVING (count(*)*count(*)*COALESCE(sum(a.days_count),0)) >= 50 ORDER BY (count(*)*count(*)*COALESCE(sum(a.days_count),0)) DESC LIMIT 10`, [asOf]);
      let late = 0; try { [{ n: late }] = await q(`SELECT count(*)::int AS n FROM staff_lateness_notes WHERE created_at::date BETWEEN $1 AND $2`, [W.lastFrom, W.lastTo]); } catch (_) { /* no table */ }
      let off = 0; try { [{ n: off }] = await q(`SELECT count(*)::int AS n FROM offratio_log WHERE date BETWEEN $1 AND $2`, [W.lastFrom, W.lastTo]); } catch (_) { /* no table */ }
      let prob = []; try { prob = await q(`SELECT s.first_name || ' ' || s.last_name AS n, p.final_review_date::text AS d FROM probation_periods p JOIN staff s ON s.id = p.staff_id WHERE p.final_review_date BETWEEN $1 AND $2 AND COALESCE(p.status,'') NOT IN ('passed','failed','completed')`, [W.thisFrom, W.thisTo]); } catch (_) { /* no table */ }
      return { headline: `${brad.length} at or over the Bradford trigger (50), ${plural(late, 'lateness note')}, ${plural(off, 'over-ratio entry', 'over-ratio entries')}, ${plural(prob.length, 'probation review')} due.`,
        items: brad.map(b => I(`${b.n}: ${b.spells} spells, ${b.days} days in 12 months`, 'this_period', 'absence', 'Bradford score at or above 50.')).concat(prob.map(p2 => I(`${p2.n}: probation final review ${p2.d}`, 'this_period', 'staff'))) };
    }));
    add(await guarded('compliance', 'Compliance: policies, fire drill, checks', false, false, async () => {
      const pol = await q(`SELECT title, review_due::text AS d FROM policies WHERE COALESCE(is_active,true) AND review_due IS NOT NULL AND review_due <= $1::date ORDER BY review_due LIMIT 12`, [W.thisTo]);
      const [fd] = await q(`SELECT next_drill_due::text AS d FROM fire_drills WHERE next_drill_due IS NOT NULL ORDER BY drill_date DESC LIMIT 1`);
      const ce = await q(`SELECT title, next_due::text AS d FROM compliance_events WHERE is_active = true AND next_due <= $1::date ORDER BY next_due LIMIT 12`, [W.thisTo]);
      const items = [];
      pol.forEach(p2 => items.push(I(`Policy to review: ${p2.title} (due ${p2.d})`, p2.d < asOf ? 'urgent' : 'this_period', 'policies', p2.d < asOf ? 'The review date has passed.' : null)));
      if (fd) items.push(I(`Next fire drill due ${fd.d}`, fd.d < asOf ? 'urgent' : 'info', 'fire', fd.d < asOf ? 'The next fire drill date has passed.' : null));
      ce.forEach(c => items.push(I(`${c.title}: due ${c.d}`, c.d < asOf ? 'urgent' : 'this_period', 'compliance', c.d < asOf ? 'Overdue.' : null)));
      return { headline: `${plural(pol.length, 'policy', 'policies')} to review, ${plural(ce.length, 'compliance check')} due.`, items };
    }));
  }
  if (period !== 'week' && showMoney) {
    add(await guarded('money', 'Money: income, debtors and funding claim', false, true, async () => {
      const [inv] = await q(`SELECT COALESCE(sum(amount_pence),0)::bigint AS p FROM invoices WHERE issued_on BETWEEN $1 AND $2 AND credit_note_for_id IS NULL`, [W.lastFrom, W.lastTo]);
      const [paid] = await q(`SELECT COALESCE(sum(amount_pence),0)::bigint AS p FROM invoices WHERE paid_on BETWEEN $1 AND $2`, [W.lastFrom, W.lastTo]);
      const deb = await q(`SELECT count(DISTINCT child_id)::int AS n, COALESCE(sum(amount_pence),0)::bigint AS p FROM invoices WHERE status NOT IN ('paid','void','cancelled','draft') AND paid_on IS NULL AND due_on < $1::date AND credit_note_for_id IS NULL`, [asOf]);
      const [fs] = await q(`SELECT status, submitted_at::date::text AS d FROM funding_submissions ORDER BY submitted_at DESC NULLS LAST LIMIT 1`);
      return { headline: `Invoiced ${money(inv.p)}, paid ${money(paid.p)}. ${deb[0].n} families owe ${money(deb[0].p)}.`, items: fs ? [I(`Latest funding claim: ${fs.status}${fs.d ? ' (' + fs.d + ')' : ''}`, 'info', 'funding')] : [] };
    }));
  }
  if (period !== 'week' && !room) {
    add(await guarded('occupancy', 'Occupancy and waiting list', true, false, async () => {
      const wl = await q(`SELECT COALESCE(status,'unknown') AS s, count(*)::int AS n FROM waiting_list GROUP BY 1 ORDER BY 2 DESC`);
      const [en] = await q(`SELECT count(*)::int AS n FROM enquiries WHERE created_at::date BETWEEN $1 AND $2`, [W.lastFrom, W.lastTo]);
      return { headline: `Waiting list: ${wl.map(r => r.n + ' ' + r.s).join(', ') || 'empty'}. ${plural(en.n, 'enquiry', 'enquiries')} in the period.`, items: [] };
    }));
  }
  if (period === 'term') {
    add(await guarded('planning_review', 'Resources and planning review', false, false, async () => {
      const p = [W.lastFrom, W.lastTo]; let rc = '';
      if (room) { p.push(room); rc = ` AND w.room_id = $3`; }
      const rows = await q(`SELECT r.name, count(DISTINCT w.week_commencing)::int AS weeks FROM weekly_plans w JOIN rooms r ON r.id = w.room_id WHERE w.week_commencing BETWEEN $1 AND $2${rc} GROUP BY r.name ORDER BY r.name`, p);
      const env = await q(`SELECT r.name, max(e.assessed_at)::date::text AS d FROM environment_assessments e JOIN rooms r ON r.id = e.room_id GROUP BY r.name ORDER BY r.name`);
      const items = rows.map(r => I(`${r.name}: weekly plans for ${r.weeks} of about 13 weeks`, r.weeks < 8 ? 'this_period' : 'info', 'planning', r.weeks < 8 ? 'Fewer than 8 weeks of plans published this term.' : null))
        .concat(env.map(e => I(`${e.name}: last environment audit ${e.d}`, e.d < addDays(asOf, -180) ? 'this_period' : 'info', 'environment', e.d < addDays(asOf, -180) ? 'Over six months since the last audit.' : null)));
      return { headline: 'Room plans published against the weeks in the term, and the environment audits.', items };
    }));
    add(await guarded('feedback', 'Parent feedback and staffing for next term', false, false, async () => {
      const [sv] = await q(`SELECT count(*)::int AS n FROM survey_responses WHERE submitted_at::date BETWEEN $1 AND $2`, [W.lastFrom, W.lastTo]);
      const ends = showStaffPrivate ? await q(`SELECT first_name || ' ' || last_name AS n, contract_end::text AS d FROM staff WHERE is_active AND contract_end BETWEEN $1 AND $2 ORDER BY contract_end`, [W.thisFrom, W.thisTo]) : [];
      return { headline: `${plural(sv.n, 'survey response')} this term. ${plural(ends.length, 'contract')} ending next term.`, items: ends.map(e => I(`${e.n}: contract ends ${e.d}`, 'this_period', 'staff')) };
    }));
    let prompts = []; try { prompts = JSON.parse(fs.readFileSync(path.join(__dirname, '../content/briefings/evidence-prompts.json'), 'utf8')).prompts || []; } catch (_) { /* optional file */ }
    if (prompts.length) add({ key: 'evidence', title: 'Evidence prompts for your team meeting', child_data: false, money: false, headline: 'Questions to answer with something you have actually seen.', items: prompts.map(p2 => I(`${p2.area}: ${p2.prompt}`, 'info', null)) });
  }

  const sections = out.filter(Boolean);
  const counts = { urgent: 0, this_period: 0, info: 0 };
  sections.forEach(s => s.items.forEach(i => { counts[i.urgency] = (counts[i.urgency] || 0) + 1; }));
  return {
    period, as_of: asOf, scope: S, window: W,
    title: `${W.word[0].toUpperCase() + W.word.slice(1)} briefing, week of ${asOf}`,
    sections, counts,
  };
}

/** The HR page version: staff items only. Child data NEVER goes on HR, so every child_data section is dropped here, server-side. */
function forHr(b) {
  const sections = b.sections.filter(s => !s.child_data);
  const counts = { urgent: 0, this_period: 0, info: 0 };
  sections.forEach(s => s.items.forEach(i => { counts[i.urgency] = (counts[i.urgency] || 0) + 1; }));
  return Object.assign({}, b, { sections, counts, hr_version: true });
}

const scopeKeyOf = S => (S.kind === 'room' ? `room:${S.room_id}` : (S.money === false ? 'deputy' : 'setting'));
const scopeOf = key => key === 'setting' ? { kind: 'setting', money: true } : key === 'deputy' ? { kind: 'setting', money: false } : { kind: 'room', room_id: Number(String(key).split(':')[1]) };

/** Which scope a staff member gets, or null (practitioners and others get no briefing). */
function scopeForStaff(staff) {
  if (['manager', 'admin', 'headteacher'].includes(staff.role)) return { kind: 'setting', money: true };
  if (staff.role === 'deputy_manager') return { kind: 'setting', money: false };
  if (staff.role === 'room_leader' && staff.room_id) return { kind: 'room', room_id: Number(staff.room_id) };
  return null;
}

async function save(db, b) {
  const key = scopeKeyOf(b.scope);
  const { rows: [r] } = await db.query(
    `INSERT INTO briefings (period, scope_key, as_of, json) VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (period, scope_key, as_of) DO UPDATE SET json = EXCLUDED.json, created_at = now() RETURNING id, created_at`, [b.period, key, b.as_of, JSON.stringify(b)]);
  return { id: r.id, created_at: r.created_at, scope_key: key };
}

module.exports = { build, forHr, save, scopeKeyOf, scopeOf, scopeForStaff, mondayOnOrBefore, windows, londonToday, addDays };
