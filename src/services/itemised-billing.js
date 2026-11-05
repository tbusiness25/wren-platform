'use strict';
// ============================================================================
// b114 — Itemised billing engine (ONE SOURCE OF TRUTH)
// ----------------------------------------------------------------------------
// Compliance rules encoded here (DfE statutory guidance A1.32–A1.44, 1 Apr 2025;
// itemised invoices from Jan 2026):
//   • Funded hours are FREE — they ALWAYS appear as £0 lines showing the hours
//     delivered, grouped under the "free entitlement hours" statutory category.
//     No per-hour consumables price is ever stored or multiplied into a charge.
//   • Every consumable / extra is individually opt-out-able (voluntary); an
//     approved opt-out simply drops that line. Opting out never affects funding.
//   • Lines are grouped into the five statutory categories.
//   • "Per funded hour equivalent" is DISPLAY-ONLY, computed live here, never
//     stored, and always labelled "(equivalent)".
//
// Both the invoice generator (finance-invoices) and the parent/Roost calculator
// call buildItemisedLines() so the numbers can never drift apart.
// ============================================================================

// The five DfE statutory invoice categories (Jan 2026). `funded_entitlement` and
// `additional_paid_hours` are generated; food / non_food_consumables / activities
// come from fee_items.statutory_category.
const STATUTORY = {
  funded_entitlement:    'Free entitlement hours',
  additional_paid_hours: 'Additional paid hours',
  food:                  'Food (meals & snacks)',
  non_food_consumables:  'Non-food consumables',
  activities:            'Activities & extras',
};
const STATUTORY_ORDER = [
  'funded_entitlement', 'additional_paid_hours', 'food', 'non_food_consumables', 'activities',
];

// Standard funded weeks per year (term-time entitlement is delivered over 38 wks).
const FUNDED_WEEKS_PER_YEAR = 38;
// Full attendance day = 10 hours (08:00–18:00). "Full days only" for children;
// a private hour therefore pro-rates to day_rate ÷ 10.
const HOURS_PER_DAY = 10;
// Even monthly stretch: 52 weeks / 12 months.
const WEEKS_PER_MONTH = 52 / 12;

// Reference date for age-band assignment (age at 1 Sept of the funding year).
const AGE_BAND_REFERENCE = '2026-09-01';

// ── b299: a fee formula may not be scaled by funded hours ─────────────────────
// A consumables charge that RISES with the number of funded hours a child draws
// is the funding shortfall recovered under another name, and a provider may not
// make a funded place conditional on paying the difference. EyLog does exactly
// this ("weekly_funded_hours * 15.35 / 21.92"); Wren copied it in b216 and stops
// here. Toby, 2026-09-10: "we're not supposed to be charging the shortfall."
//
// The variable is no longer offered to evalFormula at all, so a formula naming it
// would already die on the arithmetic-only regex below — but it would die saying
// "Illegal fee formula", which reads like a typo. This check fails first and says
// what is actually wrong, and it is called from the fee_items write routes too so
// the formula cannot be saved in the first place.
//
// 2026-09-17 — Toby: "keep the EyLog rates, as I don't want parents complaining
// about how these are different since we switched. Our funding guide explains
// what the consumables are and the options if you don't want to pay." So the
// EyLog formula is back — but ONLY on an opt-out-able item. That is the line the
// guidance draws: a consumables charge is allowed when it is genuinely voluntary
// and never a condition of the funded place. A core (non-optional) item still
// may not scale with funded hours, and this guard still refuses one.
const FUNDED_HOURS_NAMES = /\b(weekly_funded_hours|funded_hours|monthly_funded_hours|meal_hours_basis)\b/i;

function assertNotFundedScaled(expr) {
  const m = FUNDED_HOURS_NAMES.exec(String(expr || ''));
  if (m) {
    throw new Error(
      `A fee formula may not use "${m[1]}". A charge that scales with funded hours is a `
      + 'funding shortfall, and a funded place cannot be made conditional on paying it. '
      + 'Use a flat per-day or per-week price instead.');
  }
  return true;
}

// ── Safe formula evaluator ────────────────────────────────────────────────────
// fee_items.formula is authored only by managers (CRUD is manager-guarded). We
// substitute the whitelisted variables, then hard-reject anything that is not a
// pure arithmetic expression before evaluating. No identifiers survive the regex,
// so there is no code-injection surface.
function evalFormula(expr, vars, opts = {}) {
  if (!opts.allowFundedHours) assertNotFundedScaled(expr);
  let s = String(expr || '').trim();
  if (!s) return 0;
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(new RegExp('\\b' + k + '\\b', 'g'), '(' + Number(v || 0) + ')');
  }
  if (!/^[0-9+\-*/(). ]+$/.test(s)) {
    throw new Error('Illegal fee formula: ' + expr);
  }
  // eslint-disable-next-line no-new-func
  const val = Function('"use strict"; return (' + s + ');')();
  if (!Number.isFinite(val)) throw new Error('Fee formula did not evaluate to a finite number: ' + expr);
  return val;
}

// Age band from date_of_birth relative to the funding-year reference date.
function ageBandFromDob(dob, referenceIso = AGE_BAND_REFERENCE) {
  if (!dob) return null;
  const d = new Date(dob), ref = new Date(referenceIso);
  const years = (ref - d) / (365.25 * 24 * 3600 * 1000);
  if (years < 2) return 'under_2';
  if (years < 3) return '2yo';
  return '3_4yo';
}

// Normalise a value that may be a pg Date object OR a 'YYYY-MM-DD' string to an
// ISO date string, using LOCAL components (pg builds `date` columns at local
// midnight, so getFullYear/Month/Date reconstruct the intended calendar date
// without any UTC-offset shift).
function toIso(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

// Is a fee_item live for a given ISO date?
function itemActiveOn(item, iso) {
  if (item.active === false) return false;
  const from = toIso(item.effective_from), to = toIso(item.effective_to);
  if (from && iso < from) return false;
  if (to  && iso >= to) return false;
  return true;
}

// Does a fee_item apply to a child's age band? (NULL age_band = all ages.)
function itemMatchesBand(item, ageBand) {
  return !item.age_band || item.age_band === ageBand;
}

// ── Core: build itemised lines for one child over `weeks` weeks ───────────────
// params:
//   ageBand            'under_2' | '2yo' | '3_4yo'
//   weeklyFundedHours  universal + extended stretched hrs/wk (e.g. 21.92)
//   daysPerWeek        attended days/week (full days)
//   fundedDaysPerWeek  of those, how many are funded days (funding covers them)
//   privateDaysPerWeek of those, how many are genuinely private (charged day rate)
//   weeks              number of weeks to bill (1 = weekly; 52/12 = one month)
//   feeItems           active fee_items rows (already filtered to the period/date)
//   fundingRatePence   funding £/hr for the band (pence) — for waive + equivalent
//   optedOutItemIds    Set/array of APPROVED opt-out fee_item ids for this child
//   periodLabel        display label
//   onDateIso          the invoice/estimate date (for effective-dating)
// Returns { lines, groups, total_pence, funded_hours_delivered,
//           per_funded_hour_equivalent_pence, per_funded_hour_equivalent_label }
function buildItemisedLines(params) {
  const {
    ageBand,
    weeklyFundedHours = 0,
    daysPerWeek = 0,
    fundedDaysPerWeek = daysPerWeek,
    privateDaysPerWeek = Math.max(0, daysPerWeek - (fundedDaysPerWeek ?? daysPerWeek)),
    weeks = 1,
    feeItems = [],
    fundingRatePence = 0,
    optedOutItemIds = [],
    periodLabel = '',
    onDateIso = AGE_BAND_REFERENCE,
    // b216 — optional, and both default to exactly today's behaviour.
    //   sessionBasis  when a month is billed on the sessions actually delivered
    //                 rather than the 52/12 average (see monthBillingBasis()).
    //   formulaVars   extra whitelisted names a fee_items.formula may use, so the
    //                 rates Toby reviews each April live in ladn.settings instead
    //                 of inside the formula string.
    sessionBasis = null,
    formulaVars = {},
    // b490 — a manager-set override for THIS child/period that replaces the
    // catalogue day rate below. { price_pence, reason } or null/undefined.
    dayRateOverride = null,
  } = params;

  // Billing a real-session month is the same arithmetic over a different number
  // of weeks: sessions delivered / days per week. Driving everything off one
  // "effective weeks" figure keeps funded hours, weekly items and day items in
  // step — a partial month cannot end up with a full month of funded hours.
  const onSessions = !!(sessionBasis && sessionBasis.kind === 'actual_sessions' && daysPerWeek > 0);
  const effWeeks = onSessions
    ? round2((Number(sessionBasis.total_sessions) || 0) / daysPerWeek)
    : weeks;

  const optedOut = new Set((optedOutItemIds || []).map(Number));
  const active = feeItems.filter(it => itemActiveOn(it, onDateIso) && itemMatchesBand(it, ageBand));
  const lines = [];
  // b299 — items that could not be priced and were left OFF the bill, with the
  // reason. A catalogue row whose formula is scaled by funded hours is refused
  // rather than charged, but refusing must not take the whole invoice run down
  // with it: prod still holds two such rows from the EyLog import, and an
  // exception here would stop every invoice for every child.
  const suppressed = [];

  // Day-rate lookup for this band (core childcare, optoutable=false). A b490
  // price override for this child/period replaces the catalogue figure outright
  // — it exists precisely so a room-moved child can be billed at a rate neither
  // age band's catalogue row states.
  const dayRateItem = active.find(it =>
    it.statutory_category === 'additional_paid_hours' && it.unit === 'day' && it.optoutable === false);
  const dayRatePence = dayRateOverride ? Number(dayRateOverride.price_pence || 0)
                      : (dayRateItem ? Number(dayRateItem.price_pence || 0) : 0);

  // Does the funding "cover the day"? Funded value per attended day vs day rate.
  const fundedValuePerDayPence = daysPerWeek > 0
    ? (weeklyFundedHours / daysPerWeek) * fundingRatePence : 0;
  const fundingCoversDay = dayRatePence > 0 && fundedValuePerDayPence >= dayRatePence;

  // 1) FUNDED HOURS — always a £0 line showing hours delivered.
  const fundedHoursDelivered = round2(weeklyFundedHours * effWeeks);
  if (weeklyFundedHours > 0) {
    lines.push({
      label: `Funded entitlement — ${round2(weeklyFundedHours)} hrs/wk delivered free`,
      category: 'funded_entitlement',
      statutory_category: 'funded_entitlement',
      fee_item_id: null,
      funded_hours_at_zero: true,
      is_funded: true,
      quantity: fundedHoursDelivered,
      unit_label: 'hours',
      unit_pence: 0,
      amount_pence: 0,
      basis: onSessions ? 'actual_sessions' : 'monthly_average',
      // DISPLAY ONLY, and never added to any total: what those free hours are
      // worth at the LA's funding rate, so an invoice can say what the funding
      // covered instead of leaving a parent to guess.
      funding_rate_pence: Math.round(Number(fundingRatePence) || 0),
      weekly_hours: round2(weeklyFundedHours),
      funding_value_pence: Math.round(fundedHoursDelivered * (Number(fundingRatePence) || 0)),
      note: `Government-funded early education. ${periodLabel ? periodLabel + '. ' : ''}Free at the point of access — no charge for these hours.`
          + (onSessions ? ` Pro-rated to the ${sessionBasis.total_sessions} session(s) actually delivered this month.` : ''),
    });
  }

  // 2) PRIVATE CHILDCARE — full private days at the day rate (never funded days).
  if (privateDaysPerWeek > 0 && dayRateItem) {
    const qtyDays = onSessions
      ? round2(Number(sessionBasis.private_sessions) || 0)
      : round2(privateDaysPerWeek * weeks);
    const amt = Math.round(qtyDays * dayRatePence);
    lines.push({
      label: onSessions
        ? `${dayRateItem.name} — ${qtyDays} session(s) delivered`
        : `${dayRateItem.name} — ${round2(privateDaysPerWeek)} private day(s)/wk`,
      category: 'additional_paid_hours',
      statutory_category: 'additional_paid_hours',
      fee_item_id: dayRateItem.id,
      funded_hours_at_zero: false,
      is_funded: false,
      optoutable: false,
      quantity: qtyDays,
      unit_label: 'day',
      unit_pence: dayRatePence,
      amount_pence: amt,
      basis: onSessions ? 'actual_sessions' : 'monthly_average',
      rule: onSessions
        ? { kind: 'actual_sessions', sessions: qtyDays, day_rate_pence: dayRatePence,
            expression: `${qtyDays} session(s) × £${(dayRatePence / 100).toFixed(2)}`,
            reason: sessionBasis.reason || null }
        : monthlyAverageRule({ weeklyPence: Math.round(privateDaysPerWeek * dayRatePence), weeksBilled: weeks }).rule,
      note: `Private hour pro-rata = £${(dayRatePence / 100).toFixed(2)} ÷ ${HOURS_PER_DAY} = £${(dayRatePence / 100 / HOURS_PER_DAY).toFixed(2)}/hr.`
          + (onSessions ? ` Billed on sessions actually delivered${sessionBasis.reason ? ' — ' + sessionBasis.reason : ''}.` : '')
          + (dayRateOverride ? ` Price changed for ${periodLabel || 'this period'}${dayRateOverride.reason ? ' — ' + dayRateOverride.reason : ''}.` : ''),
      price_overridden: !!dayRateOverride,
    });
  }

  // 3) CONSUMABLES / EXTRAS — every opt-out-able item, minus approved opt-outs.
  for (const it of active) {
    if (it.statutory_category === 'additional_paid_hours') continue;   // handled above / core
    if (it.optoutable === false) continue;                             // core, not a voluntary extra
    // b216 — a catalogue row with neither a price nor a formula cannot produce a
    // charge. The EyMan import brought several across (Deposit, Late Charge, the
    // per-occurrence meal charges), which were printing on every invoice as
    // "21.67 day  £0.00" — noise a parent has to decode. An item priced at an
    // explicit £0 is different, and still shown: that is a deliberately free item.
    if (!it.formula && it.price_pence == null) continue;
    const isOptedOut = optedOut.has(Number(it.id));

    let weeklyPence = 0;
    let unitLabel = it.unit;
    let chargeableDays = daysPerWeek;
    let waived = false;

    if (it.formula) {
      // Formula items are authored as a per-WEEK amount. Every item reaching this
      // block is opt-out-able, so it may use weekly_funded_hours (2026-09-17 —
      // the EyLog consumables formula; see the note on FUNDED_HOURS_NAMES).
      try {
        weeklyPence = Math.round(evalFormula(it.formula,
          { days: daysPerWeek, weekly_funded_hours: weeklyFundedHours, ...formulaVars },
          { allowFundedHours: it.optoutable !== false }) * 100);
      } catch (e) {
        suppressed.push({ fee_item_id: it.id, label: it.name, formula: it.formula,
                          reason: e.message });
        continue;
      }
      unitLabel = 'week';
    } else if (it.unit === 'week') {
      weeklyPence = Math.round(Number(it.price_pence || 0));
      unitLabel = 'week';
    } else {
      // 'day' / 'session' — per attended day, with the waive rule applied.
      if (it.waive_when_funding_covers_day && fundingCoversDay) {
        chargeableDays = Math.max(0, daysPerWeek - fundedDaysPerWeek);   // charge only non-funded days
        waived = chargeableDays < daysPerWeek;
      }
      weeklyPence = Math.round(Number(it.price_pence || 0) * chargeableDays);
      unitLabel = it.unit === 'session' ? 'session' : 'day';
    }

    // On a real-sessions month a per-day extra follows the sessions, not the
    // pattern: a child who attended six days in their first part-month is
    // charged six days of meals, not a month's worth.
    const sessionsForItem = onSessions
      ? (waived ? (Number(sessionBasis.private_sessions) || 0) : (Number(sessionBasis.total_sessions) || 0))
      : null;
    const qty = unitLabel === 'week' ? round2(effWeeks)
              : (onSessions ? round2(sessionsForItem) : round2(chargeableDays * weeks));
    const amount = isOptedOut ? 0
                 : (onSessions && unitLabel !== 'week'
                     ? Math.round(Number(it.price_pence || 0) * sessionsForItem)
                     : Math.round(weeklyPence * effWeeks));

    // A fully-waived / £0 opt-out-able item is still shown (transparency) but £0.
    const noteBits = [];
    if (it.note) noteBits.push(it.note);
    if (it.waive_when_funding_covers_day) {
      noteBits.push(fundingCoversDay
        ? 'Waived on funded days (funding covers the day).'
        : 'Waive-when-funded is set but funding does not fully cover the day for this pattern.');
    }
    // 2026-09-17, Toby: parents see the weekly charge and nothing else — no working.
    // The funding guide explains the fee and how to opt out.
    const isConsumables = !!(it.formula && /weekly_funded_hours/.test(it.formula));
    if (isConsumables) {
      noteBits.length = 0;
      noteBits.push(`£${(weeklyPence / 100).toFixed(2)} a week.`);
    } else if (it.optoutable) {
      noteBits.push('Voluntary — you may opt out; a free alternative (bring your own) is available.');
    }
    if (isOptedOut) noteBits.push('OPTED OUT (approved) — not charged.');

    lines.push({
      label: it.name,
      category: it.statutory_category,
      statutory_category: it.statutory_category,
      fee_item_id: it.id,
      funded_hours_at_zero: false,
      is_funded: false,
      optoutable: it.optoutable !== false,
      opted_out: isOptedOut,
      waived,
      quantity: qty,
      unit_label: unitLabel,
      unit_pence: it.formula ? null : Math.round(Number(it.price_pence || 0)),
      amount_pence: amount,
      basis: onSessions ? 'actual_sessions' : 'monthly_average',
      rule: onSessions
        ? { kind: 'actual_sessions', sessions: sessionsForItem,
            expression: it.formula ? `${it.formula} × ${round2(effWeeks)} wk`
                                   : `${round2(sessionsForItem)} × £${(Number(it.price_pence || 0) / 100).toFixed(2)}` }
        : monthlyAverageRule({ weeklyPence, weeksBilled: weeks }).rule,
      note: noteBits.join(' '),
    });
  }

  // ── Group by statutory category + totals ────────────────────────────────────
  const groups = {};
  for (const cat of STATUTORY_ORDER) {
    const catLines = lines.filter(l => l.statutory_category === cat);
    if (!catLines.length) continue;
    groups[cat] = {
      key: cat,
      label: STATUTORY[cat],
      lines: catLines,
      subtotal_pence: catLines.reduce((s, l) => s + (l.amount_pence || 0), 0),
    };
  }
  const total_pence = lines.reduce((s, l) => s + (l.amount_pence || 0), 0);

  // ── DISPLAY-ONLY: per funded hour equivalent (never stored) ─────────────────
  let per_funded_hour_equivalent_pence = null;
  let per_funded_hour_equivalent_label = null;
  if (fundedHoursDelivered > 0) {
    per_funded_hour_equivalent_pence = Math.round(total_pence / fundedHoursDelivered);
    per_funded_hour_equivalent_label =
      `≈ £${(per_funded_hour_equivalent_pence / 100).toFixed(2)} per funded hour (equivalent)`;
  }

  return {
    lines,
    groups,
    total_pence,
    // Charges deliberately NOT made, and why. Empty on a healthy catalogue.
    suppressed,
    funded_hours_delivered: fundedHoursDelivered,
    funding_covers_day: fundingCoversDay,
    billing_basis: onSessions ? 'actual_sessions' : 'monthly_average',
    basis_detail: onSessions
      ? { ...sessionBasis, effective_weeks: effWeeks }
      : { kind: 'monthly_average', weeks_billed: round2(weeks) },
    per_funded_hour_equivalent_pence,
    per_funded_hour_equivalent_label,
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ── 2026-10-01: the rate follows the child's age, changing the week after a birthday ──
// Toby: "their fees should have reduced from the 19th as they are 3 now. It should do it
// the week after the birthday." Until now every child was banded by their age on
// AGE_BAND_REFERENCE (1 September) for the whole year, so a child who turned 3 in October
// paid the 2-year rate until the following September. The band now changes on the MONDAY
// AFTER the 2nd and 3rd birthdays (a Sunday 18 Oct birthday → Monday 19 Oct), and a month
// that contains that Monday is split by booked sessions either side of it.
function _isoAddDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function _birthdayIso(dob, years) {
  const iso = toIso(dob); if (!iso) return null;
  const y = Number(iso.slice(0, 4)) + years, md = iso.slice(5);
  // 29 Feb birthdays fall on 1 Mar in a non-leap year
  if (md === '02-29' && !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) return `${y}-03-01`;
  return `${y}-${md}`;
}
/** The Monday strictly after a birthday: the first day the new band applies. */
function bandChangeDate(dob, years) {
  const b = _birthdayIso(dob, years); if (!b) return null;
  const dow = new Date(b + 'T00:00:00Z').getUTCDay();          // 0 Sun … 6 Sat
  return _isoAddDays(b, dow === 0 ? 1 : 8 - dow);
}
/** The fee band in force on a date, under the week-after-the-birthday rule. */
function ageBandOn(dob, isoDate) {
  if (!dob || !isoDate) return null;
  const two = bandChangeDate(dob, 2), three = bandChangeDate(dob, 3);
  if (isoDate < two) return 'under_2';
  if (isoDate < three) return '2yo';
  return '3_4yo';
}
/** If the band changes part-way through a month: { effective_iso, before, after }, else null. */
function bandChangeInMonth(dob, year, month) {
  if (!dob) return null;
  const start = ymd(year, month, 1), end = ymd(year, month, new Date(year, month, 0).getDate());
  for (const yrs of [2, 3]) {
    const eff = bandChangeDate(dob, yrs);
    if (eff && eff > start && eff <= end) {
      return { effective_iso: eff, before: ageBandOn(dob, start), after: ageBandOn(dob, eff) };
    }
  }
  return null;
}
const BAND_LABEL = { under_2: 'under-2 rate', '2yo': '2-year-old rate', '3_4yo': '3-4 year old rate' };
/**
 * Merge the month priced at the old band and at the new band, each scaled by its share
 * of the month's booked sessions. The family sees both halves as separate lines.
 */
function splitByBandChange(before, after, change, sessionsBefore, sessionsAfter) {
  const total = (Number(sessionsBefore) || 0) + (Number(sessionsAfter) || 0);
  const fAfter = total > 0 ? (Number(sessionsAfter) || 0) / total : 0;
  const fBefore = 1 - fAfter;
  const lastBefore = _isoAddDays(change.effective_iso, -1);
  const scale = (res, f, band, span) => (res.lines || []).filter(() => f > 0).map(l => ({
    ...l,
    quantity: l.quantity != null ? round2(Number(l.quantity) * f) : l.quantity,
    amount_pence: Math.round((Number(l.amount_pence) || 0) * f),
    label: `${l.label} (${BAND_LABEL[band] || band}, ${span})`,
    band_split: { band, share: round2(f) },
  }));
  const fmt = iso => { const d = new Date(iso + 'T00:00:00Z'); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); };
  const lines = [
    ...scale(before, fBefore, change.before, `to ${fmt(lastBefore)}`),
    ...scale(after, fAfter, change.after, `from ${fmt(change.effective_iso)}`),
  ];
  const groups = {};
  for (const cat of STATUTORY_ORDER) {
    const catLines = lines.filter(l => l.statutory_category === cat);
    if (!catLines.length) continue;
    groups[cat] = { key: cat, label: STATUTORY[cat], lines: catLines,
      subtotal_pence: catLines.reduce((s, l) => s + (l.amount_pence || 0), 0) };
  }
  return {
    ...after,
    lines, groups,
    total_pence: lines.reduce((s, l) => s + (l.amount_pence || 0), 0),
    suppressed: [...(before.suppressed || []), ...(after.suppressed || [])],
    basis_detail: { ...(after.basis_detail || {}), band_change: { ...change,
      sessions_before: sessionsBefore, sessions_after: sessionsAfter, share_after: round2(fAfter) } },
  };
}


module.exports = {
  STATUTORY, STATUTORY_ORDER, FUNDED_WEEKS_PER_YEAR, HOURS_PER_DAY, WEEKS_PER_MONTH,
  AGE_BAND_REFERENCE,
  buildItemisedLines, evalFormula, assertNotFundedScaled, ageBandFromDob,
  ageBandOn, bandChangeDate, bandChangeInMonth, splitByBandChange,
  itemActiveOn, itemMatchesBand, toIso,
};

// ============================================================================
// b216 — how a month gets its number
// ----------------------------------------------------------------------------
// Three rules, in the order they apply:
//
//   1. MONTHLY AVERAGE is the default. The weekly fee is annualised and split
//      evenly — weekly x 52 / 12 — so a family pays the same in February as in
//      March. The rule travels WITH the figure (monthlyAverageRule returns both)
//      because an invoice that cannot say "£445.00/week x 52 / 12" is an invoice
//      the office has to defend from memory.
//
//   2. ACTUAL SESSIONS when the average would be a lie: a child who starts or
//      leaves mid-month, or who did extra sessions, is billed the sessions
//      really delivered that month. Sessions come from ladn.child_bookings.
//
//   3. THE FINAL INVOICE RECONCILES THE YEAR. Averaging over-bills some months
//      and under-bills others by design; on the way out that has to come back to
//      what was actually delivered, shown as its own line so the family can see
//      the correction rather than a total that mysteriously moved.
//
// No floats reach a total: every figure below returns integer pence.
// ============================================================================

const DEFAULT_AVERAGING = { weeks: 52, months: 12 };

/** "52.00/12.00" (ladn.settings.invoice_calculation_factor) -> { weeks, months }. */
function parseAveragingRule(setting) {
  const m = /^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/.exec(String(setting || ''));
  if (!m) return { ...DEFAULT_AVERAGING };
  const weeks = parseFloat(m[1]), months = parseFloat(m[2]);
  if (!(weeks > 0) || !(months > 0)) return { ...DEFAULT_AVERAGING };
  return { weeks, months };
}

/**
 * The averaged monthly figure AND the rule that produced it.
 *
 * @param weeklyPence  the weekly fee in pence
 * @param weeks/months the averaging factor (default 52/12)
 * @param weeksBilled  weeks actually being billed; defaults to weeks/months, and
 *                     is what buildItemisedLines passes so a line can quote the
 *                     rule behind its own amount.
 */
function monthlyAverageRule({ weeklyPence, weeks, months, weeksBilled } = {}) {
  const w = Number(weeks) > 0 ? Number(weeks) : DEFAULT_AVERAGING.weeks;
  const m = Number(months) > 0 ? Number(months) : DEFAULT_AVERAGING.months;
  const billed = (weeksBilled != null && Number(weeksBilled) >= 0) ? Number(weeksBilled) : (w / m);
  const weekly = Math.round(Number(weeklyPence) || 0);
  const amount_pence = Math.round(weekly * billed);
  const pounds = p => '£' + (p / 100).toFixed(2);
  return {
    amount_pence,
    rule: {
      kind: 'monthly_average',
      weekly_pence: weekly,
      weeks_per_year: w,
      months_per_year: m,
      weeks_billed: round2(billed),
      monthly_pence: Math.round(weekly * w / m),
      expression: `${pounds(weekly)}/week × ${w} ÷ ${m}`,
      explanation: `Your fee is averaged over the year: ${pounds(weekly)} a week × ${w} weeks `
                 + `÷ ${m} months = ${pounds(Math.round(weekly * w / m))} every month. `
                 + `The amount is the same each month whether that month is long, short or has a bank holiday in it.`,
    },
  };
}

/** Local-date ISO for a Y/M/D, with no timezone shift. */
function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const DAY_COLS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Is a booking row live on an ISO date? */
function bookingCovers(b, iso) {
  if (b.is_active === false) return false;
  const from = toIso(b.start_date), to = toIso(b.end_date);
  if (from && iso < from) return false;
  if (to && iso > to) return false;
  return true;
}

/**
 * Sessions actually booked in one calendar month, day by day.
 *
 * A day is ONE session (Toby's places are full days, 08:00–18:00 — the same
 * assumption HOURS_PER_DAY encodes). A day covered by both a funded and a
 * private booking counts once, as funded, so an overlapping pattern can never
 * double-bill a Tuesday.
 *
 * A booking row does not end when a child leaves — leaving is recorded on the
 * CHILD, and the pattern happily runs on into next year. notBefore/notAfter clamp
 * the month to the days the child was actually on roll; without them a child
 * leaving on the 10th was billed for the whole of December.
 *
 * @param bookings      ladn.child_bookings rows
 * @param closureDates  ISO dates the nursery is shut (bank holidays, INSET)
 * @param notBefore     the child's start date — no session before it counts
 * @param notAfter      the child's leave date — no session after it counts
 */
function sessionDaysInMonth(bookings, year, month, { closureDates = [], notBefore = null, notAfter = null } = {}) {
  const shut = new Set((closureDates || []).map(d => toIso(d)).filter(Boolean));
  const from = toIso(notBefore), to = toIso(notAfter);
  const daysInMonth = new Date(year, month, 0).getDate();
  const days = [];
  let funded = 0, priv = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = ymd(year, month, d);
    const dow = new Date(year, month - 1, d).getDay();
    if (dow === 0 || dow === 6) continue;
    if (shut.has(iso)) continue;
    if (from && iso < from) continue;
    if (to && iso > to) continue;
    const col = DAY_COLS[dow];
    const live = (bookings || []).filter(b => b[col] && bookingCovers(b, iso));
    if (!live.length) continue;
    const isFunded = live.some(b => b.funded === true);
    if (isFunded) funded++; else priv++;
    days.push({ date: iso, funded: isFunded, room_id: (live.find(b => b.room_id) || {}).room_id || null });
  }
  return {
    total_sessions: funded + priv,
    funded_sessions: funded,
    private_sessions: priv,
    days,
  };
}

/** Days a week the pattern says, read on the first date of the month it covers. */
function patternDaysPerWeek(bookings, year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = ymd(year, month, d);
    const live = (bookings || []).filter(b => bookingCovers(b, iso));
    if (!live.length) continue;
    let funded = 0, priv = 0;
    for (const col of ['mon', 'tue', 'wed', 'thu', 'fri']) {
      const on = live.filter(b => b[col]);
      if (!on.length) continue;
      if (on.some(b => b.funded === true)) funded++; else priv++;
    }
    if (funded + priv > 0) return { daysPerWeek: funded + priv, fundedDays: funded, privateDays: priv };
  }
  return { daysPerWeek: 0, fundedDays: 0, privateDays: 0 };
}

/**
 * Which basis this month should be billed on, and why in words.
 *
 * The average is kept unless it would misstate the month:
 *   • the child started after the 1st, or left before the month ended, or
 *   • the sessions actually delivered differ from the averaged month by a whole
 *     session or more (extra days, or days dropped).
 *
 * A month with NO sessions at all is left on the average rather than silently
 * zeroed — an empty booking table is far more often a data gap than a month a
 * family genuinely owes nothing for, and quietly issuing a £0 invoice hides it.
 */
function monthBillingBasis({ bookings = [], year, month, startDate = null, leaveDate = null,
                             closureDates = [], weeks, months } = {}) {
  const rule = { weeks: Number(weeks) > 0 ? Number(weeks) : DEFAULT_AVERAGING.weeks,
                 months: Number(months) > 0 ? Number(months) : DEFAULT_AVERAGING.months };
  const monthStart = ymd(year, month, 1);
  const monthEnd = ymd(year, month, new Date(year, month, 0).getDate());
  const sessions = sessionDaysInMonth(bookings, year, month,
    { closureDates, notBefore: startDate, notAfter: leaveDate });
  const pattern = patternDaysPerWeek(bookings, year, month);
  const weeksPerMonth = rule.weeks / rule.months;
  const averagedSessions = round2(pattern.daysPerWeek * weeksPerMonth);

  const startIso = toIso(startDate), leaveIso = toIso(leaveDate);
  const startsMidMonth = !!(startIso && startIso > monthStart && startIso <= monthEnd);
  const leavesMidMonth = !!(leaveIso && leaveIso >= monthStart && leaveIso < monthEnd);
  const drift = sessions.total_sessions - averagedSessions;
  const extraSessions = pattern.daysPerWeek > 0 && Math.abs(drift) >= 1;

  const reasons = [];
  if (startsMidMonth) reasons.push(`started on ${startIso}, part-way through the month`);
  if (leavesMidMonth) reasons.push(`left on ${leaveIso}, part-way through the month`);
  if (extraSessions && !startsMidMonth && !leavesMidMonth) {
    reasons.push(drift > 0
      ? `${round2(drift)} session(s) more than the averaged month`
      : `${round2(-drift)} session(s) fewer than the averaged month`);
  }

  const useSessions = (startsMidMonth || leavesMidMonth || extraSessions) && sessions.total_sessions > 0;

  return {
    kind: useSessions ? 'actual_sessions' : 'monthly_average',
    reason: useSessions ? reasons.join('; ') : null,
    partial_month: startsMidMonth || leavesMidMonth,
    total_sessions: sessions.total_sessions,
    funded_sessions: sessions.funded_sessions,
    private_sessions: sessions.private_sessions,
    averaged_sessions: averagedSessions,
    pattern_days_per_week: pattern.daysPerWeek,
    pattern_funded_days: pattern.fundedDays,
    pattern_private_days: pattern.privateDays,
    month_start: monthStart,
    month_end: monthEnd,
    session_dates: sessions.days.map(d => d.date),
    averaging: rule,
  };
}

/**
 * The leaving invoice's year-end line: averaged months vs sessions delivered.
 *
 * Averaging is a promise that it evens out. It only evens out if somebody checks,
 * and the last invoice is the last chance to check. Positive = the family owes
 * for sessions the averaging under-charged; negative = a credit back to them.
 *
 * Returns null when there is nothing to reconcile, so the caller can simply not
 * add a line rather than print a £0.00 adjustment nobody asked about.
 */
function yearEndReconciliation({ billedSessions, deliveredSessions, dayRatePence,
                                 windowLabel = 'this year', windowFrom = null, windowTo = null } = {}) {
  const billed = round2(billedSessions);
  const delivered = round2(deliveredSessions);
  const rate = Math.round(Number(dayRatePence) || 0);
  const drift = round2(delivered - billed);
  if (!rate || Math.abs(drift) < 0.01) return null;
  const amount = Math.round(drift * rate);
  if (amount === 0) return null;
  const pounds = p => '£' + (Math.abs(p) / 100).toFixed(2);
  return {
    label: amount > 0
      ? 'Year-end adjustment — sessions delivered above the averaged months'
      : 'Year-end adjustment — sessions billed above those delivered (credit)',
    category: 'additional_paid_hours',
    statutory_category: 'additional_paid_hours',
    fee_item_id: null,
    is_funded: false,
    is_credit: amount < 0,
    optoutable: false,
    quantity: Math.abs(drift),
    unit_label: 'session',
    unit_pence: amount > 0 ? rate : -rate,
    amount_pence: amount,
    basis: 'final_reconciliation',
    rule: {
      kind: 'final_reconciliation',
      window_label: windowLabel,
      window_from: toIso(windowFrom),
      window_to: toIso(windowTo),
      sessions_billed: billed,
      sessions_delivered: delivered,
      drift_sessions: drift,
      day_rate_pence: rate,
      expression: `(${delivered} delivered − ${billed} billed) × £${(rate / 100).toFixed(2)}`,
    },
    note: `Your monthly fee was averaged (${windowLabel}), which bills the same amount every month `
        + `regardless of how many sessions that month held. Over ${windowLabel} you were billed for `
        + `${billed} session(s) and ${delivered} were delivered, so this final invoice `
        + (amount > 0 ? `charges the ${Math.abs(drift)} session(s) difference — ${pounds(amount)}.`
                      : `credits the ${Math.abs(drift)} session(s) difference — ${pounds(amount)}.`),
  };
}

/**
 * The fee-formula variables that come from ladn.settings rather than from code.
 *
 * Toby reviews meal/consumable charges every April, so the rate is a setting and
 * the formula names it rather than carrying the number.
 *
 * b299 (2026-09-10): `meal_hours_basis` is GONE, and the two rates now default to
 * ZERO rather than to EyLog's 15.35 / 37.05. Those three values together were the
 * shortfall formula — rate ÷ 21.92 funded hours × the hours a child actually
 * draws — and defaulting them meant an edition that had never configured a meal
 * charge still billed one. Unset now means unset: no line, no charge, until
 * somebody sets a real flat weekly price. The April-2027 fee schedule is where
 * that number gets designed; this file does not guess it.
 *
 * @param settings  { key: value } from ladn.settings
 */
function mealFormulaVars(settings = {}) {
  const num = (k) => {
    const v = parseFloat(settings[k]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  return {
    // pence in settings -> pounds in the formula, which is authored in pounds
    meal_rate_2yo_weekly:   num('meal_charge_2yo_weekly_pence') / 100,
    meal_rate_3_4yo_weekly: num('meal_charge_3_4yo_weekly_pence') / 100,
    // The EyLog basis: the weekly rate is for 21.92 funded hours (2026-09-17).
    meal_hours_basis:       num('meal_charge_hours_basis') || 21.92,
  };
}

module.exports.DEFAULT_AVERAGING = DEFAULT_AVERAGING;
module.exports.parseAveragingRule = parseAveragingRule;
module.exports.monthlyAverageRule = monthlyAverageRule;
module.exports.sessionDaysInMonth = sessionDaysInMonth;
module.exports.patternDaysPerWeek = patternDaysPerWeek;
module.exports.monthBillingBasis = monthBillingBasis;
module.exports.yearEndReconciliation = yearEndReconciliation;
module.exports.mealFormulaVars = mealFormulaVars;
module.exports.bookingCovers = bookingCovers;
