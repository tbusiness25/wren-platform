'use strict';
/**
 * b202 — EyMan-shaped invoice statement.  (2026-08-19)
 *
 * WHY THIS EXISTS: Toby's families have read EyMan invoices for years, so Wren's invoice
 * has to look like the one they already understand.  This module reshapes a Wren invoice
 * row into the layout EyMan's "Invoice - View" screen uses, WITHOUT touching the generator:
 * every figure here is derived from what is already stored on the invoice, so the total a
 * parent sees is byte-for-byte the total Wren generated.
 *
 * The EyMan layout, copied from the live screen (example-nursery.eylog.co.uk, read
 * 2026-08-19), is:
 *
 *   header    Invoice No. · Payment Status · Sent-at per bill payer · Locked · Child URN
 *   dates     Invoice Date · Due Date · Invoice From Date · Invoice To Date · Reference
 *   items     Item | Description | Quantity | Amount (£)
 *               Monthly Charged Hours   01-08-2026 to 31-08-2026   121.68 hrs   1,082.95
 *               Monthly Funded Hours    Under Two, Two or Three…    94.99 hrs       0.00
 *               Meal charge - 3-4y…     Meals, Activities, Consu…        -       160.55
 *   totals    Account balance prior to <date> · Invoice Total · Payments · Total Due
 *   working   "…calculated based on the following information" — sample week, its booking
 *             schedule with the per-session rate, charged vs funded hours, and the
 *             52.00 weeks / 12.00 months calculation factor
 *   payments  Transaction ID | Amount(£) | Payment Mode | Payment Reference | Payment Date | Status
 *
 * THE ONE THING WORTH COPYING ABOVE ALL: funded hours are their own line at **£0.00**, with
 * the hours in the Quantity column.  Wren's own model carries funding as a NEGATIVE money
 * line, which reads to a parent like a mistake ("why is there a minus number on my bill?").
 * Presenting the same arithmetic EyMan's way — charge the hours you actually bill for, and
 * list the funded hours beside them at nil — is the whole point of the redesign.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// Term-time weeks the DfE entitlement is delivered over. Must track FUNDED_WEEKS_PER_YEAR
// in src/routes/finance-invoices.js — the generator and this presenter have to agree or the
// "how this was worked out" panel explains a number the invoice does not contain.
const FUNDED_WEEKS_PER_YEAR = 38;

// EyMan's own default, read off report 70 (every child: "Invoice Calculation Factor
// 52.00/12.00"). Overridable from ladn.settings.invoice_calculation_factor.
const DEFAULT_FACTOR = { weeks: 52, months: 12 };

// DFE_CATEGORIES.PAID_HOURS in src/routes/finance-invoices.js — the category the generator
// stamps on the gross childcare line. Spelt out here because a typo silently drops the
// childcare row out of the statement and the items stop adding up to the invoice total.
const CHILDCARE_CATEGORY = 'additional_private_paid_hours';

// b299 — and the b216 ITEMISED engine's core childcare line, which is a different
// category again: 'additional_paid_hours', optoutable false, priced per day. Before
// this was recognised, a funded child's day-rate line fell through to the generic
// extras bucket, so EyLog's "Monthly Charged Hours" row was missing from exactly
// the invoices that need it. `optoutable === false` is what separates the core
// childcare line from a voluntary extra sharing the same statutory category
// ("Extra time"), which must stay its own row.
const ITEMISED_CHILDCARE_CATEGORY = 'additional_paid_hours';

function isCoreChildcare(li) {
  if (li.category === CHILDCARE_CATEGORY) return true;
  if (/^childcare\b/i.test(li.label || '')) return true;
  return (li.category === ITEMISED_CHILDCARE_CATEGORY
          || li.statutory_category === ITEMISED_CHILDCARE_CATEGORY)
         && li.optoutable === false;
}

function iso(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date && !isNaN(d)) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return String(d).slice(0, 10);
}

function pence(n) { return Math.round(Number(n) || 0); }

/** Trim a note to a whole word plus an ellipsis — "(bring your o" is not a sentence. */
function clip(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s.,;:—-]+$/, '') + '…';
}

/** "52.00/12.00" -> { weeks: 52, months: 12 }; anything unparseable falls back to EyMan's default. */
function parseFactor(setting) {
  const m = /^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/.exec(String(setting || ''));
  if (!m) return { ...DEFAULT_FACTOR };
  const weeks = parseFloat(m[1]), months = parseFloat(m[2]);
  if (!(weeks > 0) || !(months > 0)) return { ...DEFAULT_FACTOR };
  return { weeks, months };
}

/**
 * Wren's DfE line items -> EyMan's Item/Description/Quantity/Amount rows.
 *
 * The reshape is deliberately conservative: the amounts are added up exactly as stored, so
 * `items` always sums to the invoice total.  What changes is only how the funding is shown —
 * the funded hours move out of the money column and into the quantity column, and the
 * childcare line carries the net that is actually being charged.
 */
function reshapeItems(lineItems, { periodFrom, periodTo, fundedLabel }) {
  const items = [];
  // b225 — discounts are collected separately so they land AFTER the things
  // being charged for, which is where EyMan puts them and where a reader
  // expects a reduction to appear.
  const discountRows = [];
  const raw = Array.isArray(lineItems) ? lineItems : [];

  let childcareGross = 0;
  // Money actually taken OFF the childcare line — the old generator stored funding
  // as a negative deduction, so its charge is gross minus this.
  let fundingDeducted = 0;
  // b299 — and money that was NEVER on the bill: `funding_value_pence` on the
  // b216 engine's £0 funded line is DISPLAY ONLY ("the government covered £772"),
  // because that engine already charges only the hours it bills for. Subtracting
  // it as well takes the funding off twice, and the rows stop adding up to the
  // invoice total by exactly that amount. The two are kept apart for that reason.
  let fundingValuePence = 0;
  let fundedHours = 0;
  // b299 — EyLog's funded-child invoice puts HOURS in the quantity column of the
  // charged line, not just money ("Monthly Charged Hours  121.68 hrs  £1,082.95").
  // The itemised engine states the charged side in DAYS, so the hours are carried
  // here and converted by the caller, which is the only place that knows how long
  // a session is (ladn.settings.invoice_session_hours).
  let chargedDays = 0;
  let chargedUnitPence = null;
  // b216 — the itemised engine puts the term-time weekly hours ON the funded line.
  // Taking the stated figure beats deriving one: the derivation below assumes the
  // 38-week term basis, and an invoice averaged 52/12 would otherwise explain
  // itself with a weekly figure the child never had.
  let statedWeeklyHours = null;
  const fundedBands = [];
  const notes = [];

  for (const li of raw) {
    const amt = pence(li.amount_pence);
    if (li.note) notes.push(li.note);
    if (li.is_funded && li.is_deduction) {
      fundingDeducted += -amt;                       // stored negative
      fundedHours += Number(li.quantity) || 0;
      // 2026-09-29 — the deduction line states its weekly funded hours ("21.92 hrs/wk
      // year-round", "21.92 funded hrs/wk x 2.67 week(s)"). Without reading it, the sample week
      // was derived as monthly x 12 / 38: 30.00 hrs on every full-month stretched invoice, and
      // 18.46 on a part month, instead of the 21.92 EyLog shows.
      if (li.weekly_hours != null) statedWeeklyHours = (statedWeeklyHours || 0) + (Number(li.weekly_hours) || 0);
      else {
        const m = /([\d.]+) (?:funded )?hrs\/wk(?: year-round|\b)/.exec(li.note || '');
        if (m && /year-round|funded hrs\/wk x/.test(li.note || '')) statedWeeklyHours = (statedWeeklyHours || 0) + Number(m[1]);
      }
      if (li.label) fundedBands.push(String(li.label).replace(/^Government funding\s*—\s*/, ''));
    } else if (li.is_funded && (li.funded_hours_at_zero || li.category === 'funded_entitlement')) {
      // b216 — the itemised engine states funded hours the way EyMan does: the
      // hours delivered, at £0.00, with no money line at all. Before this branch
      // existed the line fell through to the "capped adjustment" case below,
      // which added nothing and dropped the row off the statement entirely — a
      // funded child's invoice showed the meals and no sign of the funding.
      fundedHours += Number(li.quantity) || 0;
      fundingValuePence += Math.max(0, Math.round(Number(li.funding_value_pence) || 0));
      if (li.weekly_hours != null) statedWeeklyHours = Number(li.weekly_hours) || 0;
      if (li.label) fundedBands.push(String(li.label).replace(/^Funded entitlement\s*—\s*/, ''));
    } else if (li.is_funded) {
      // the generator's "capped to childcare charged" adjustment — a positive correction
      fundingDeducted += -amt;
    } else if (li.is_discount || li.category === 'discount' || li.statutory_category === 'discount') {
      // b225 — a discount gets its own row with its own negative amount, and is
      // never folded into the childcare line. A total that moved with nothing on
      // the page to explain it is exactly what parents ring the office about.
      discountRows.push({
        item: li.label || 'Discount',
        description: li.description || (li.note ? clip(li.note, 160) : ''),
        quantity: li.unit_label === '%' && li.quantity != null ? `${li.quantity}%` : '-',
        amount_pence: amt,
        kind: 'discount',
        basis_pence: li.basis_pence != null ? pence(li.basis_pence) : null,
        applies_to: li.applies_to || null,
      });
    } else if (!li.is_credit && isCoreChildcare(li)) {
      childcareGross += amt;
      if (li.unit_label === 'day' && li.quantity != null) chargedDays += Number(li.quantity) || 0;
      if (li.unit_pence != null) chargedUnitPence = Math.round(Number(li.unit_pence));
    } else {
      items.push({
        item: li.label || 'Charge',
        description: li.note ? clip(li.note, 160) : (li.unit_label || ''),
        quantity: li.quantity != null && li.unit_label ? `${li.quantity} ${li.unit_label}` : '-',
        amount_pence: amt,
        kind: li.is_credit ? 'credit' : 'extra',
      });
    }
  }

  const chargedPence = Math.max(0, childcareGross - fundingDeducted);
  const head = [];
  if (childcareGross > 0 || chargedPence > 0) {
    head.push({
      item: 'Childcare',
      description: periodFrom && periodTo ? `${periodFrom} to ${periodTo}` : 'This month',
      quantity: '-',
      amount_pence: chargedPence,
      kind: 'childcare',
    });
  }
  if (fundedHours > 0 || fundingDeducted > 0 || fundingValuePence > 0) {
    head.push({
      // EyMan calls this "Monthly Funded Hours". Same row, wording a parent uses.
      item: 'Government funded hours',
      description: fundedBands.length ? fundedBands.join(', ') : (fundedLabel || 'Early years funding'),
      quantity: fundedHours > 0 ? `${fundedHours.toFixed(2)} hrs` : '-',
      amount_pence: 0,                               // the EyMan £0.00 line
      kind: 'funded',
      // What the funding was worth, from whichever engine raised this invoice.
      // For the "you saved" line only — never added to, or taken off, a total.
      funding_value_pence: fundingDeducted + fundingValuePence,
    });
  }

  const discountPence = discountRows.reduce((sum, d) => sum + d.amount_pence, 0);   // negative
  return {
    items: head.concat(items, discountRows), notes, fundedHours,
    fundingDeducted: fundingDeducted + fundingValuePence,
    chargedPence, statedWeeklyHours, discountRows, discountPence,
    chargedDays, chargedUnitPence,
    // Everything that is not childcare and not funding — the extras EyLog prints
    // under the two hours rows (meals, consumables, activities).
    extraRows: items,
  };
}

/* ── b299: the two EyLog invoice layouts ──────────────────────────────────────
 *
 * EyLog does not print one invoice, it prints two, and which one a family gets
 * depends on whether the child draws funding:
 *
 *   PRIVATE  a WEEKLY breakdown. One block per week of the period —
 *            "Week [07-Sep-2026 to 13-Sep-2026]" — listing the days and times
 *            booked ("Mon - 08:00-18:00"), then Qty/Attended Hours, Funded Hrs,
 *            Chargeable Hours, Unit Price ("10.50/Hr") and Amount, with a Week
 *            Total under each block.
 *
 *   FUNDED   a MONTHLY summary — Monthly Charged Hours, Monthly Funded Hours at
 *            £0.00, then the extras — followed by the calculation appendix:
 *            sample week, its booking schedule, its charged and funded hours,
 *            and the two calculation factors.
 *
 * Everything below is PRESENTATION. Not one of these functions returns a total
 * that goes anywhere near `totals.invoice_total_pence`, which stays exactly what
 * the generator stored. Where the weekly rows do not add up to the stored total
 * — and on a 52/12 averaged invoice they will not, by design — the difference is
 * stated rather than hidden, because a bill whose rows do not sum to its total is
 * the single thing most likely to generate a phone call.
 */

/** 'YYYY-MM-DD' -> Date at LOCAL midnight (never `new Date(iso)`, which is UTC). */
function localDate(isoStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoStr || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/** "07-Sep-2026", the way EyLog prints a date inside a week label. */
function eylogDate(d) {
  if (!d) return '';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')}-${MON[d.getMonth()]}-${d.getFullYear()}`;
}

/**
 * The Monday-anchored weeks that overlap [fromIso, toIso].
 *
 * EyLog's week labels run Monday to Sunday and the first and last week of a
 * month are usually partial, so each week also carries the slice of itself that
 * actually falls inside the invoice period. Days are charged from that slice,
 * never from the whole week — otherwise September's invoice bills two days that
 * belong to August.
 */
function weeksInPeriod(fromIso, toIso) {
  const from = localDate(fromIso), to = localDate(toIso);
  if (!from || !to || to < from) return [];
  const out = [];
  // Monday of the week containing `from`. getDay(): 0=Sun … 6=Sat.
  let cursor = addDays(from, -((from.getDay() + 6) % 7));
  let guard = 0;
  while (cursor <= to && guard++ < 60) {
    const weekEnd = addDays(cursor, 6);
    out.push({
      week_start: iso(cursor),
      week_end: iso(weekEnd),
      label: `Week [${eylogDate(cursor)} to ${eylogDate(weekEnd)}]`,
      in_period_start: iso(cursor < from ? from : cursor),
      in_period_end: iso(weekEnd > to ? to : weekEnd),
      partial: cursor < from || weekEnd > to,
    });
    cursor = addDays(cursor, 7);
  }
  return out;
}

/** "08:00-18:00" from a start time and a session length, so the two cannot disagree. */
function sessionWindow(startHHMM, hours) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(startHHMM || '08:00'));
  const h0 = m ? Number(m[1]) : 8, m0 = m ? Number(m[2]) : 0;
  const endMins = h0 * 60 + m0 + Math.round((Number(hours) || 10) * 60);
  const hh = String(Math.floor(endMins / 60) % 24).padStart(2, '0');
  const mm = String(endMins % 60).padStart(2, '0');
  return { start: `${String(h0).padStart(2, '0')}:${String(m0).padStart(2, '0')}`, end: `${hh}:${mm}` };
}

/**
 * The private child's weekly breakdown.
 *
 * @param booking            ladn.child_bookings row (mon..fri booleans)
 * @param dayRatePence       the child's age-band day rate
 * @param sessionHours       ladn.settings.invoice_session_hours (10)
 * @param sessionStart       ladn.settings.invoice_session_start ('08:00')
 * @param weeklyFundedHours  funded hours a week, 0 for a genuinely private child
 * @param periodFromIso/periodToIso  the invoice period
 * @returns null when there is nothing honest to draw (no booking pattern, or no
 *          day rate) — a half-built week table is worse than none.
 */
function buildWeeklyBreakdown({ booking, dayRatePence, sessionHours = 10, sessionStart = '08:00',
                                weeklyFundedHours = 0, periodFromIso, periodToIso }) {
  if (!booking || !dayRatePence || !periodFromIso || !periodToIso) return null;
  const win = sessionWindow(sessionStart, sessionHours);
  const bookedDays = DAY_KEYS.map((k, i) => ({ key: k, idx: i, booked: !!booking[k] }))
                             .filter(d => d.booked);
  if (!bookedDays.length) return null;

  const hourlyPence = Number(dayRatePence) / (Number(sessionHours) || 10);
  const SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  const weeks = weeksInPeriod(periodFromIso, periodToIso).map(w => {
    const sliceStart = localDate(w.in_period_start), sliceEnd = localDate(w.in_period_end);
    // Which of the booked weekdays actually fall inside this week's slice.
    const days = bookedDays.filter(d => {
      const day = addDays(localDate(w.week_start), d.idx);
      return day >= sliceStart && day <= sliceEnd;
    }).map(d => ({
      day: SHORT[d.idx],
      date: iso(addDays(localDate(w.week_start), d.idx)),
      times: `${win.start}-${win.end}`,
      label: `${SHORT[d.idx]} - ${win.start}-${win.end}`,
      hours: Number(sessionHours),
    }));

    const attended = days.length * Number(sessionHours);
    // A child cannot draw more funded hours in a week than they attend in it, and
    // a part-week draws its funding pro-rata to the days it actually holds.
    const fullWeekDays = bookedDays.length;
    const fundedFull = Math.min(Number(weeklyFundedHours) || 0, fullWeekDays * Number(sessionHours));
    const funded = fullWeekDays > 0 ? (fundedFull * days.length) / fullWeekDays : 0;
    const chargeable = Math.max(0, attended - funded);
    return {
      ...w,
      days,
      days_count: days.length,
      attended_hours: round2(attended),
      funded_hours: round2(funded),
      chargeable_hours: round2(chargeable),
      unit_price_pence: Math.round(hourlyPence * 100) / 100,
      unit_price_label: `${(hourlyPence / 100).toFixed(2)}/Hr`,
      amount_pence: Math.round(chargeable * hourlyPence),
    };
  }).filter(w => w.days_count > 0);

  if (!weeks.length) return null;
  return {
    session_window: win,
    hourly_rate_pence: Math.round(hourlyPence),
    unit_price_label: `${(hourlyPence / 100).toFixed(2)}/Hr`,
    weeks,
    weeks_total_pence: weeks.reduce((sum, w) => sum + w.amount_pence, 0),
    total_attended_hours: round2(weeks.reduce((s, w) => s + w.attended_hours, 0)),
    total_funded_hours: round2(weeks.reduce((s, w) => s + w.funded_hours, 0)),
    total_chargeable_hours: round2(weeks.reduce((s, w) => s + w.chargeable_hours, 0)),
  };
}

/**
 * The funded child's monthly summary — EyLog's three-row shape.
 *
 * Charged and funded become one row each with the HOURS in the quantity column;
 * everything else on the invoice (meals, consumables, activities, a discount)
 * follows underneath exactly as stored. The amounts are the stored ones, so this
 * still sums to the invoice total.
 */
function buildMonthlySummary({ chargedPence, chargedHours, fundedHours, fundedBandsLabel,
                               extraRows = [], discountRows = [], periodFrom, periodTo,
                               unitPricePence }) {
  const rows = [];
  if (chargedPence > 0 || chargedHours > 0) {
    rows.push({
      item: 'Monthly Charged Hours',
      description: periodFrom && periodTo ? `${periodFrom} to ${periodTo}` : '',
      quantity: chargedHours > 0 ? `${round2(chargedHours).toFixed(2)} hrs` : '-',
      unit_price_label: unitPricePence ? `${(unitPricePence / 100).toFixed(2)}/Hr` : '',
      amount_pence: pence(chargedPence),
      kind: 'charged',
    });
  }
  if (fundedHours > 0) {
    rows.push({
      item: 'Monthly Funded Hours',
      description: fundedBandsLabel || 'Early years funding',
      quantity: `${round2(fundedHours).toFixed(2)} hrs`,
      unit_price_label: '',
      amount_pence: 0,
      kind: 'funded',
    });
  }
  for (const e of extraRows) rows.push({ ...e, unit_price_label: '', kind: e.kind || 'extra' });
  for (const d of discountRows) rows.push({ ...d, unit_price_label: '', kind: 'discount' });
  return rows.length ? rows : null;
}

/**
 * The calculation appendix EyLog prints under a funded child's summary.
 *
 * Every figure here has to be one the invoice above it actually used, which is
 * why the funding factor is read off the invoice (see `impliedWeeks` in
 * buildStatement) rather than assumed.
 */
function buildCalculationAppendix({ booking, sampleWeekOf, sessionHours = 10, sessionStart = '08:00',
                                    dayRatePence, weeklyChargedHours, weeklyFundedHours,
                                    factor, fundingFactorLabel }) {
  if (!booking) return null;
  const win = sessionWindow(sessionStart, sessionHours);
  const SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const schedule = DAY_KEYS.map((k, i) => ({
    day: DAY_NAMES[i],
    short: SHORT[i],
    booked: !!booking[k],
    label: booking[k] ? `${SHORT[i]} - ${win.start}-${win.end}` : `${SHORT[i]} - not booked`,
    hours: booking[k] ? Number(sessionHours) : 0,
  }));
  const daysBooked = schedule.filter(d => d.booked).length;
  if (!daysBooked) return null;

  return {
    sample_week_of: sampleWeekOf,
    sample_week_label: sampleWeekOf
      ? `Sample week beginning ${eylogDate(localDate(sampleWeekOf))}` : 'Sample week',
    schedule,
    days_per_week: daysBooked,
    sample_week_attended_hours: round2(daysBooked * Number(sessionHours)),
    sample_week_charged_hours: weeklyChargedHours == null ? null : round2(weeklyChargedHours),
    sample_week_funded_hours: weeklyFundedHours == null ? null : round2(weeklyFundedHours),
    day_rate_pence: dayRatePence == null ? null : Math.round(dayRatePence),
    unit_price_label: dayRatePence
      ? `${(dayRatePence / (Number(sessionHours) || 10) / 100).toFixed(2)}/Hr` : '',
    invoice_calculation_factor: `${factor.weeks.toFixed(2)} weeks/${factor.months.toFixed(2)} months`,
    funding_calculation_factor: fundingFactorLabel
      || `${factor.weeks.toFixed(2)} weeks/${factor.months.toFixed(2)} months`,
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * The "how this was worked out" panel — EyMan's sample-week working, told honestly about
 * what Wren actually did.
 *
 * EyMan's panel reproduces the two hour figures on its invoice: sample-week charged hours
 * and funded hours, each annualised by 52/12.  Wren's generator does NOT work that way
 * today — its childcare line is a flat rooms.monthly_fee_pence, and its funding line is
 * weekly term-time hours x 38/12.  So this panel:
 *
 *   • shows the real booked week from ladn.child_bookings, with the age-band day rate,
 *   • reproduces the funding arithmetic the invoice actually used (38 term weeks / 12),
 *   • states the charge basis Wren used in plain words rather than inventing hours for it,
 *   • and, for the office only, carries what the same week costs on EyMan's session-rate
 *     basis (`eyman_basis_pence`) so the gap the b202 reconciliation reports is visible on
 *     the screen instead of buried in a script.
 *
 * Returns null when it cannot be built honestly — no booking pattern, or no day rate for
 * the child's age band. A half-built calculation is worse than none.
 */
function buildWorking({ booking, dayRatePence, fundedWeeklyHours, monthlyFundedHours, factor,
                        sessionLabel, sampleWeekOf, chargePence, roomName, fundingFactorLabel }) {
  if (!booking || !dayRatePence) return null;
  const days = DAY_KEYS.map((k, i) => ({ key: k, name: DAY_NAMES[i], booked: !!booking[k] }));
  const daysBooked = days.filter(d => d.booked).length;
  if (!daysBooked) return null;

  const hoursPerDay = Number(booking.session_hours) || 10;   // EyMan's Day/FT is 08:00–18:00
  const bookedHours = daysBooked * hoursPerDay;
  const weeklyFunded = Math.min(Number(fundedWeeklyHours) || 0, bookedHours);

  return {
    sample_week_of: sampleWeekOf,
    schedule: days.map(d => ({
      day: d.name,
      booked: d.booked,
      label: d.booked ? `${sessionLabel || 'Day'} · £${(dayRatePence / 100).toFixed(2)}/session` : 'Not booked',
    })),
    days_per_week: daysBooked,
    booked_hours: Number(bookedHours.toFixed(2)),
    day_rate_pence: dayRatePence,

    // Funding, exactly as the invoice computed it.
    funded_weekly_hours: Number(weeklyFunded.toFixed(2)),
    funded_month_hours: Number((monthlyFundedHours != null
      ? monthlyFundedHours
      : weeklyFunded * FUNDED_WEEKS_PER_YEAR / 12).toFixed(2)),
    // The spread the invoice ACTUALLY used. b202-era invoices deducted funding on
    // the 38-week term basis; b216 itemised invoices average 52/12 like the fee
    // does, so the label has to follow the invoice rather than assume one of them.
    funding_factor_label: fundingFactorLabel || `${FUNDED_WEEKS_PER_YEAR}.00 term weeks / 12.00 months`,

    // What Wren charged, and on what basis. No invented hours.
    charge_basis: roomName ? `Flat monthly rate — ${roomName}` : 'Flat monthly rate',
    charge_pence: chargePence == null ? null : Math.round(chargePence),

    // Office-only comparison against the way EyMan bills the same week.
    eyman_factor_label: `${factor.weeks.toFixed(2)} weeks / ${factor.months.toFixed(2)} months`,
    eyman_basis_pence: Math.round(daysBooked * dayRatePence * factor.weeks / factor.months),
  };
}

/**
 * Build the whole statement.
 *
 * @param invoice   ladn.invoices row (line_items, amount_pence, dates, status, …)
 * @param child     { id, room_name, eylog_ref }
 * @param booking   latest ladn.child_bookings row for the child, or null
 * @param funding   { universal_hours_week, extended_hours_week, stretched_funding } or null
 * @param dayRatePence  the child's age-band day rate from ladn.fee_items, or null
 * @param payments  ladn.payments rows against this invoice
 * @param priorBalancePence  what the family owed the day before this invoice was raised
 * @param factorSetting      ladn.settings.invoice_calculation_factor, e.g. "52.00/12.00"
 */
function buildStatement({
  invoice, child = {}, booking = null, funding = null, dayRatePence = null,
  payments = [], priorBalancePence = 0, factorSetting = null, sessionLabel = 'Day 08:00–18:00',
  // b299 — the session window, so "Mon - 08:00-18:00" on the weekly breakdown is
  // the setting rather than a string baked into the renderer.
  sessionHours = 10, sessionStart = '08:00',
  // b299 — who the bill is addressed to. EyLog prints BOTH parents with their
  // address; Wren holds two parent names against one family address.
  parents = [],
}) {
  const factor = parseFactor(factorSetting);

  const year = invoice.period_year;
  const month = invoice.period_month;
  const monthName = (month >= 1 && month <= 12) ? `${MONTHS[month - 1]} ${year}` : (invoice.period_label || '');
  const periodFrom = (year && month) ? `1 ${MONTHS[month - 1]} ${year}` : null;
  const periodTo = (year && month)
    ? `${new Date(Date.UTC(year, month, 0)).getUTCDate()} ${MONTHS[month - 1]} ${year}` : null;

  const { items, notes, fundedHours, fundingDeducted, chargedPence, statedWeeklyHours,
          discountRows, discountPence, chargedDays, chargedUnitPence, extraRows } =
    reshapeItems(invoice.line_items, { periodFrom, periodTo });

  const paidPence = payments
    .filter(p => (p.status || 'succeeded') === 'succeeded')
    .reduce((s, p) => s + pence(p.amount_pence), 0);

  const invoiceTotal = pence(invoice.amount_pence);
  const settled = invoice.status === 'paid' || invoice.status === 'written_off';
  const itemsTotal = items.reduce((s, i) => s + i.amount_pence, 0);

  // Term-time weekly funded hours for the sample week.
  //
  // Derived from the invoice's OWN funded line wherever there is one (monthly hours are
  // weekly x FUNDED_WEEKS_PER_YEAR / 12), falling back to the child's current funding row
  // only when the invoice carries no funding at all. The panel's job is to explain the
  // invoice printed above it, so it has to start from that invoice — reading today's
  // child_funding instead would make a historic invoice explain itself with hours it was
  // never generated from, and children's funded hours change every term.
  // 2026-09-29 — a Wren-generated invoice with no funding line IS unfunded: say 0, never
  // borrow today's child_funding row (children 184/187 carry a row but were billed unfunded).
  const weeklyFunded = statedWeeklyHours != null
    ? statedWeeklyHours
    : fundedHours > 0
    ? fundedHours * 12 / FUNDED_WEEKS_PER_YEAR
    : !/^eylog/.test(invoice.source || '') ? 0
    : (funding
        ? (Number(funding.universal_hours_week || 0) + Number(funding.extended_hours_week || 0))
        : 0);

  // When the invoice states its own weekly funded hours, the spread it used is
  // simply monthly / weekly x 12 — read it off rather than assuming a basis.
  // A part-month invoice (starter/leaver) deducts weekly hours x weeks attended, so monthly /
  // weekly x 12 is not a spread there — it is the 52/12 basis applied to fewer weeks.
  const partMonthFunding = notes.some(n => /week\(s\) attended/.test(n));
  const impliedWeeks = partMonthFunding ? 52
    : (statedWeeklyHours && fundedHours > 0)
    ? Math.round((fundedHours / statedWeeklyHours) * 12 * 100) / 100 : null;
  const working = buildWorking({
    booking, dayRatePence, fundedWeeklyHours: weeklyFunded, monthlyFundedHours: fundedHours,
    factor, sessionLabel, sampleWeekOf: periodFrom, chargePence: chargedPence,
    roomName: child.room_name || child.room,
    fundingFactorLabel: impliedWeeks
      ? `${impliedWeeks.toFixed(2)} weeks / 12.00 months`
      : null,
  });

  /* ── b299: which of EyLog's two layouts this invoice gets ──────────────────
   * A child who draws funding gets the monthly summary plus the calculation
   * appendix; a genuinely private child gets the week-by-week breakdown. The
   * test is the invoice's own funded hours, not today's child_funding row — a
   * historic invoice has to keep explaining itself the way it was billed.        */
  const fromIso = (year && month) ? iso(new Date(year, month - 1, 1)) : null;
  const toIso = (year && month) ? iso(new Date(year, month, 0)) : null;
  // 2026-09-29 (Toby) — unfunded families get the sample-week layout too. The week-by-week
  // table listed October's actual weeks (£2,310 for child 104) above an averaged 52/12 charge
  // (£2,275 less a discount), so the page never added up to the bill. EyLog-imported historic
  // invoices (source eylog-import-*) keep the layout they were issued with. NB invoice.eylog_ref
  // here is the CHILD's EyLog ref (loadStatement joins c.eylog_ref over i.eylog_ref), so it
  // cannot tell an imported invoice from a Wren one.
  const layout = (fundedHours > 0 || !/^eylog/.test(invoice.source || '')) ? 'monthly' : 'weekly';

  // Charged hours: the engine states the charged side in DAYS, so convert with
  // the session length. Falls back to the money ÷ the hourly rate when a legacy
  // invoice carries no day quantity at all.
  const hourlyPence = dayRatePence ? Number(dayRatePence) / (Number(sessionHours) || 10) : null;
  const chargedHours = chargedDays > 0
    ? chargedDays * Number(sessionHours)
    : (hourlyPence > 0 ? chargedPence / hourlyPence : 0);

  const weeklyBreakdown = layout === 'weekly'
    ? buildWeeklyBreakdown({
        booking, dayRatePence, sessionHours, sessionStart,
        weeklyFundedHours: 0, periodFromIso: fromIso, periodToIso: toIso,
      })
    : null;

  const fundedBandsLabel = items.find(i => i.kind === 'funded')?.description || null;
  const monthlySummary = layout === 'monthly'
    ? buildMonthlySummary({
        chargedPence, chargedHours, fundedHours, fundedBandsLabel,
        extraRows, discountRows, periodFrom, periodTo,
        unitPricePence: chargedUnitPence != null && sessionHours
          ? chargedUnitPence / sessionHours : (hourlyPence || null),
      })
    : null;

  const appendix = layout === 'monthly'
    ? buildCalculationAppendix({
        booking, sampleWeekOf: fromIso, sessionHours, sessionStart, dayRatePence,
        weeklyChargedHours: working ? Math.max(0, working.booked_hours - (working.funded_weekly_hours || 0)) : null,
        weeklyFundedHours: working ? working.funded_weekly_hours : weeklyFunded,
        factor,
        fundingFactorLabel: impliedWeeks
          ? `${impliedWeeks.toFixed(2)} weeks/12.00 months`
          : null,
      })
    : null;

  // The weekly rows are a presentation of the SAME money, so when they do not add
  // up to the stored total the difference is stated rather than quietly absorbed.
  // On a 52/12 averaged invoice they will not: the month holds 4 or 5 weeks, the
  // charge holds 4.33. That is the averaging working, not an error.
  const weeklyReconciles = weeklyBreakdown
    ? weeklyBreakdown.weeks_total_pence === pence(invoice.amount_pence)
    : null;

  return {
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number || invoice.reference || `#${invoice.id}`,
    reference: invoice.reference || invoice.invoice_number || null,
    child_id: invoice.child_id,
    // 2026-09-29 (Toby) — the URN printed on the invoice is the child's WREN reference (the
    // number we use for them everywhere now), not the old EyLog one.
    child_urn: child.id != null ? String(child.id) : (child.eylog_ref || null),
    room: child.room_name || child.room || null,
    period_label: monthName,
    dates: {
      invoice_date: iso(invoice.issued_on),
      due_date: iso(invoice.due_on),
      from_date: (year && month) ? iso(new Date(Date.UTC(year, month - 1, 1))) : null,
      to_date: (year && month) ? iso(new Date(Date.UTC(year, month, 0))) : null,
      paid_date: iso(invoice.paid_on),
      sent_at: invoice.sent_at || null,
    },
    // EyMan splits these; Wren stores one column, so payment state is derived from the money
    // and invoice state from the row. Both are surfaced rather than collapsed, because
    // "sent but unpaid" and "not sent yet" are different jobs for the office.
    payment_status: paymentStatus(invoice, paidPence, invoiceTotal),
    invoice_status: invoiceStatus(invoice),
    items,
    // A stored invoice whose line items no longer add up to its total is a data problem, not
    // something to paper over in the renderer — say so rather than silently showing one of them.
    items_reconcile: itemsTotal === invoiceTotal,
    items_total_pence: itemsTotal,
    // b225 — what came off the bill, said out loud. total_pence is POSITIVE (the
    // amount taken off); the line items themselves carry it as a negative.
    discounts: {
      total_pence: -discountPence,
      lines: discountRows,
    },
    funding: {
      hours: Number(fundedHours.toFixed(2)),
      value_pence: fundingDeducted,
      weekly_hours: weeklyFunded || null,
      stretched: funding ? funding.stretched_funding !== false : null,
    },
    // An invoice the office has marked paid (or written off) owes nothing, even when
    // ladn.payments carries no matching row — most of the 547 historic paid invoices were
    // imported with the flag but no payment record. Subtracting a sparse payments table
    // from the total would print "Paid" beside a four-figure "Total due" on the same card.
    // The shortfall is surfaced instead of silently absorbed, so the gap stays visible.
    totals: {
      prior_balance_pence: pence(priorBalancePence),
      invoice_total_pence: invoiceTotal,
      payments_pence: paidPence,
      total_due_pence: settled ? 0 : invoiceTotal - paidPence,
      settled_without_payment_record: settled && paidPence < invoiceTotal,
    },
    working,
    // ── b299: the EyLog layouts ─────────────────────────────────────────────
    layout,
    weekly_breakdown: weeklyBreakdown,
    weekly_reconciles: weeklyReconciles,
    monthly_summary: monthlySummary,
    calculation_appendix: appendix,
    session_window: sessionWindow(sessionStart, sessionHours),
    parents: (parents || []).filter(p => p && (p.name || p.address)),
    notes,
    payments: payments.map(p => ({
      id: p.id,
      amount_pence: pence(p.amount_pence),
      method: p.payment_method || '—',
      reference: p.description || p.reference || '',
      date: iso(p.paid_at || p.created_at),
      status: p.status || 'succeeded',
    })),
    bill_payer_email: invoice.bill_payer_email || null,
  };
}

function paymentStatus(invoice, paidPence, totalPence) {
  if (invoice.status === 'written_off') return 'Written off';
  if (invoice.status === 'paid' || (totalPence > 0 && paidPence >= totalPence)) return 'Paid';
  if (paidPence > 0) return 'Part paid';
  if (invoice.status === 'overdue') return 'Overdue';
  const due = iso(invoice.due_on);
  if (due && invoice.status !== 'draft' && due < iso(new Date())) return 'Overdue';
  return 'Unpaid';
}

function invoiceStatus(invoice) {
  if (invoice.status === 'draft') return 'Draft';
  if (invoice.status === 'written_off') return 'Written off';
  return invoice.sent_at ? 'Sent' : 'Approved';
}

module.exports = {
  buildStatement, parseFactor, reshapeItems, buildWorking, isCoreChildcare,
  // b299 — exported so the verification harness can exercise each layout on its
  // own, without having to stand up a whole invoice to see one week label.
  buildWeeklyBreakdown, buildMonthlySummary, buildCalculationAppendix,
  weeksInPeriod, sessionWindow, eylogDate,
  // b225 — exported so the discount engine rounds money the same way the
  // statement does. Two rounding helpers would eventually disagree by a penny,
  // and the penny would land on a parent's bill.
  pence,
  FUNDED_WEEKS_PER_YEAR, DEFAULT_FACTOR, MONTHS, DAY_KEYS, DAY_NAMES,
};
