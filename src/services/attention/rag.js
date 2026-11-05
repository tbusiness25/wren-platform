'use strict';
/**
 * rag.js — b232. THE RAG rules. One function, one place.
 *
 * The whole point of this file is that nothing else in the attention module is
 * allowed to decide a colour. A collector describes what it found in terms of
 * facts — is this statutory, does it involve a child's safety, is money moving,
 * when is it due — and `classify()` turns that into red / amber / green. If the
 * rules move, they move here, and every collector moves with them.
 *
 *   RED    a statutory or legal deadline that has passed or falls within 7 days;
 *          child safety; money leaving or not arriving; a security control off.
 *   AMBER  due within 14 days; blocked on Toby; a cron that has silently stopped.
 *   GREEN  on track, informational, or resolved in the last 7 days.
 *
 * classify() also returns `why` — the one line the "Start here" card shows under
 * the title. It is written from the same facts, so the colour and the sentence
 * can never disagree.
 */

const DAY = 86400000;

/** Whole days from today to `date` (negative = in the past). Null-safe. */
function daysUntil(date) {
  if (!date) return null;
  const d = (date instanceof Date) ? date : new Date(String(date).slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d)) return null;
  const today = new Date();
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12);
  return Math.round((d.getTime() - t) / DAY);
}

/**
 * @param {object} f  facts about the finding
 * @param {boolean} f.statutory     a legal/statutory obligation with a date
 * @param {boolean} f.childSafety   safeguarding, medication, ratios, allergens
 * @param {boolean} f.money         money leaving, or money not arriving
 * @param {boolean} f.securityOff   a control that should be on and is not
 * @param {boolean} f.cronStopped   a scheduled job that has silently stopped
 * @param {boolean} f.schemaDrift   live code depends on a schema change prod lacks
 * @param {boolean} f.blockedOnToby waiting on a decision only Toby can make
 * @param {boolean} f.informational true = never worse than green
 * @param {string|Date|null} f.dueDate
 * @param {Date|null} f.resolvedAt
 * @returns {{rag:'red'|'amber'|'green', why:string, days:number|null}}
 */
function classify(f = {}) {
  const days = daysUntil(f.dueDate);
  const overdue = days != null && days < 0;
  const soon7   = days != null && days >= 0 && days <= 7;
  const soon14  = days != null && days >= 0 && days <= 14;

  // GREEN first, because "resolved" and "informational" outrank everything else.
  if (f.resolvedAt) {
    const ago = Math.round((Date.now() - new Date(f.resolvedAt).getTime()) / DAY);
    return { rag: 'green', why: ago <= 7 ? `Cleared ${ago === 0 ? 'today' : ago + ' day' + (ago === 1 ? '' : 's') + ' ago'}.` : 'Cleared.', days };
  }

  // ── RED ───────────────────────────────────────────────────────────────────
  if (f.childSafety)  return { rag: 'red', why: due(days, 'A child\'s safety is the reason this is here.'), days };
  if (f.securityOff)  return { rag: 'red', why: due(days, 'A control that should be on is off.'), days };
  if (f.money)        return { rag: 'red', why: due(days, 'Money is either leaving or not arriving.'), days };
  // The brief's own rule for the migrations collector: a migration is red once
  // the feature that needs it is deployed, because from that moment the missing
  // table is a 500 for whoever opens the page first.
  if (f.schemaDrift) {
    return { rag: 'red', why: 'Applied on dev but not on production — the code that needs it is already in the tree.', days };
  }
  if (f.statutory && (overdue || soon7)) {
    return { rag: 'red', why: overdue
      ? `A statutory deadline passed ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago.`
      : `A statutory deadline falls ${days === 0 ? 'today' : 'in ' + days + ' day' + (days === 1 ? '' : 's')}.`, days };
  }

  if (f.informational) return { rag: 'green', why: f.why || 'For information — nothing is due.', days };

  // ── AMBER ─────────────────────────────────────────────────────────────────
  if (soon14)          return { rag: 'amber', why: `Due ${days === 0 ? 'today' : 'in ' + days + ' day' + (days === 1 ? '' : 's')}.`, days };
  if (overdue)         return { rag: 'amber', why: `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}.`, days };
  if (f.cronStopped)   return { rag: 'amber', why: 'A scheduled job has stopped without saying so.', days };
  if (f.blockedOnToby) return { rag: 'amber', why: 'Waiting on a decision only you can make.', days };

  return { rag: 'green', why: f.why || 'On track.', days };
}

function due(days, base) {
  if (days == null) return base;
  if (days < 0) return `${base} Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}.`;
  if (days === 0) return `${base} Due today.`;
  return `${base} Due in ${days} day${days === 1 ? '' : 's'}.`;
}

/**
 * Board rank. RED first, then soonest due, then shortest effort. `sort_hint`
 * breaks ties so a collector can nudge its own items without touching the rules.
 * Lower sorts first. This is what "Start here" picks the top of.
 */
const RAG_WEIGHT = { red: 0, amber: 1, green: 2 };
// 2026-08-26: safeguarding outranks a due date. An open concern has no deadline
// attached to it, so under a purely date-ordered rule it sank below eleven dated
// items — which is the wrong answer in a nursery whatever the calendar says.
// It sorts within its RAG band, so this never lifts a green concern above a red.
const SAFEGUARDING_CATEGORIES = new Set(['safeguarding']);
function rank(item) {
  const w = RAG_WEIGHT[item.rag] != null ? RAG_WEIGHT[item.rag] : 1;
  const sg = SAFEGUARDING_CATEGORIES.has(item.category) ? 0 : 1;
  const d = daysUntil(item.due_date);
  // No due date sorts after everything dated, but before nothing.
  const dueRank = d == null ? 9999 : d;
  const effort = item.effort_minutes == null ? 999 : item.effort_minutes;
  return [w, sg, dueRank, effort, item.sort_hint || 0, item.id || 0];
}
function compare(a, b) {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
  return 0;
}

module.exports = { classify, daysUntil, rank, compare, RAG_WEIGHT };
