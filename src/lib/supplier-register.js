'use strict';
/**
 * supplier-register.js — b352 (2026-09-22)
 *
 * Everything the supplier & subscription register needs that is not SQL, as pure functions so it can be
 * tested without a database:
 *
 *   parseAudit(md)             the 15 September contacts-and-subscriptions audit -> {contacts, subscriptions, malformed}
 *   mapContact(row)            one contact row -> a supplier record, with `issues` for what it lacked or had stripped
 *   mapSubscription(row)       one subscription row -> a contract record, likewise
 *   continuityFor(...)         the "would this break the nursery if it lapsed" rules
 *   findRecurring(lines)       bank lines -> payees paid again and again
 *   matchRegister(payee, sup)  is that payee already in the register?
 *
 * ── THE RULE THAT SHAPES ALL OF IT ─────────────────────────────────────────────────────────────
 * "Import what is there, and note where a field is missing rather than guessing it." The audit was written
 * by a local model with every name the database knows stripped out afterwards, which left `[name]` fragments
 * inside some organisation names, addresses and descriptions. This module never repairs one. A field with a
 * fragment is stored as NULL and named in `issues`; the source row is kept verbatim in `raw`, so a person
 * can fix it from evidence rather than from a guess.
 */

// ── parsing the audit ─────────────────────────────────────────────────────────────────────────
function splitCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}
const isSep = l => /^\s*\|?\s*:?-{2,}/.test(l);

function sectionRows(md, headingRe, expectedCols) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex(l => headingRe.test(l));
  if (start < 0) return { rows: [], malformed: [], header: null, headingCount: null };
  const headingCount = (lines[start].match(/\((\d+)\)/) || [])[1];
  let i = start + 1;
  while (i < lines.length && !/^\s*\|/.test(lines[i])) i++;
  const header = i < lines.length ? splitCells(lines[i]) : null;
  i++;
  if (i < lines.length && isSep(lines[i])) i++;
  const rows = [], malformed = [];
  for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
    const cells = splitCells(lines[i]);
    if (cells.length === expectedCols) rows.push({ line: i + 1, cells });
    else malformed.push({ line: i + 1, cells: cells.length });
  }
  return { rows, malformed, header, headingCount: headingCount ? +headingCount : null };
}

function parseAudit(md) {
  const c = sectionRows(md, /^##\s+Business contacts/i, 7);
  const s = sectionRows(md, /^##\s+Subscriptions and recurring services/i, 8);
  return {
    contacts: c.rows.map(r => ({ line: r.line, org: r.cells[0], type: r.cells[1], what: r.cells[2], email: r.cells[3], phone: r.cells[4], web: r.cells[5], last: r.cells[6] })),
    subscriptions: s.rows.map(r => ({ line: r.line, vendor: r.cells[0], what: r.cells[1], cost: r.cells[2], frequency: r.cells[3], renews: r.cells[4], paidBy: r.cells[5], lastSeen: r.cells[6], evidence: r.cells[7] })),
    malformed: { contacts: c.malformed, subscriptions: s.malformed },
    declared: { contacts: c.headingCount, subscriptions: s.headingCount },
    headers: { contacts: c.header, subscriptions: s.header },
  };
}

// ── normalising ───────────────────────────────────────────────────────────────────────────────
const STRIPPED = /\[(name|redacted)\]/i;
const hasFragment = s => STRIPPED.test(String(s || ''));

/** The key two spellings of one organisation share: "Bright HR", "BrightHR Ltd", "Xero (UK) Limited" -> brighthr, brighthr, xero. */
function orgKey(name) {
  return String(name || '').toLowerCase()
    .replace(/\((uk|ltd|limited)\)/g, ' ')
    .replace(/\b(limited|ltd|plc|llp|uk|inc|the|co|company)\b/g, ' ')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '');
}

// audit type -> [org_type, existing suppliers.category]. The audit's own vocabulary is wider than the brief's list
// (nursery supplies, recruitment agencies, insurers…), so those get their own org_type rather than being forced into
// one that does not fit. The source's exact word is always kept in import_raw.type.
const TYPE_MAP = {
  'regulator':              ['regulator', 'other'],
  'local authority':        ['local authority', 'other'],
  'utilities':              ['utility', 'utilities'],
  'utility':                ['utility', 'utilities'],
  'waste':                  ['utility', 'refuse'],
  'telecoms':               ['utility', 'utilities'],
  'it software':            ['IT', 'software'],
  'trades and maintenance': ['trades', 'maintenance'],
  'cleaning':               ['trades', 'cleaning'],
  'professional services':  ['professional services', 'other'],
  'accountant':             ['professional services', 'other'],
  'training provider':      ['training', 'other'],
  'bank or finance':        ['finance', 'other'],
  'insurer':                ['insurance', 'insurance'],
  'nursery supplies':       ['supplies', 'other'],
  'food supplier':          ['supplies', 'food'],
  'recruitment agency':     ['recruitment', 'other'],
  'landlord':               ['property', 'other'],
  'other':                  ['other', 'other'],
};

const NOREPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|notifications?|feedback|mailer|bounce)[@=+-]/i;
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// 'YYYY-MM' as the source gave it, or a bare 'YYYY' where all it knew was the year (stored as that — never a guessed month)
const MONTH = /^\d{4}(-(0[1-9]|1[0-2]))?$/;

// ── continuity ────────────────────────────────────────────────────────────────────────────────
// What would break the nursery if it lapsed. The brief's own list — insurance, water, waste, payroll, HR, the
// phone line — plus the utilities that are the same kind of thing. A rule SUGGESTS; a manager decides, and a
// re-import never overwrites their answer.
const CONTINUITY_RULES = [
  ['insurance',  /insur|indemnity|public liability/i],
  ['water',      /\bwater\b|sewerage/i],
  ['waste',      /\bwaste\b|refuse|\bbins?\b|recycling/i],
  ['payroll',    /payroll|\bpaye\b|pension|auto-?enrol|national insurance/i],
  ['HR',         /\bHR\b|human resources|employment law/i],
  ['phone line', /telephon|telecom|phone line|landline|voip|broadband|internet (access|service|provider)/i],
  ['energy',     /electric|\bgas\b|\benergy\b/i],
];
function continuityFor(...texts) {
  const hay = texts.filter(Boolean).join(' · ');
  const hit = CONTINUITY_RULES.find(([, re]) => re.test(hay));
  if (!hit) return { critical: false, reason: null };
  // Show the WHOLE word that tripped the rule ("insurance"), not the stem the pattern matched ("insur").
  const m = hay.match(hit[1]); let a = m.index, b = m.index + m[0].length;
  while (a > 0 && /[A-Za-z]/.test(hay[a - 1])) a--;
  while (b < hay.length && /[A-Za-z]/.test(hay[b])) b++;
  return { critical: true, reason: `Suggested by the word “${hay.slice(a, b).trim()}” — a lapse in ${hit[0]} would stop the nursery. A manager confirms or clears this.` };
}

// ── one contact row → a supplier record ───────────────────────────────────────────────────────
function mapContact(r) {
  const issues = [];
  const raw = { org: r.org, type: r.type, what: r.what, email: r.email, phone: r.phone, web: r.web, last: r.last };

  let name = r.org;
  if (!name) { issues.push('name_missing'); }
  else if (hasFragment(name)) issues.push('name_stripped');

  const t = TYPE_MAP[String(r.type || '').trim().toLowerCase()];
  if (!r.type) issues.push('type_missing'); else if (!t) issues.push('type_unrecognised');
  const [orgType, category] = t || [null, 'other'];

  let whatFor = r.what || null;
  if (!whatFor) issues.push('what_for_missing'); else if (hasFragment(whatFor)) issues.push('what_for_partly_stripped');

  let email = r.email || null;
  if (!email) { issues.push('email_missing'); email = null; }
  else if (hasFragment(email)) { issues.push('email_stripped'); email = null; }
  else if (!EMAIL_OK.test(email)) { issues.push('email_invalid'); email = null; }
  else if (NOREPLY.test(email)) issues.push('email_is_a_sending_address');

  let phone = r.phone || null;
  if (!phone) { issues.push('phone_missing'); phone = null; } else if (hasFragment(phone)) { issues.push('phone_stripped'); phone = null; }

  let web = r.web || null;
  if (!web) { issues.push('website_missing'); web = null; } else if (hasFragment(web)) { issues.push('website_stripped'); web = null; }

  let last = r.last || null;
  if (!last) { issues.push('last_contact_missing'); last = null; } else if (!MONTH.test(last)) { issues.push('last_contact_unreadable'); last = null; }

  const cont = continuityFor(name, whatFor);
  return {
    key: hasFragment(name) || !name ? `contact-row:${r.line}` : `contact:${orgKey(name)}`,
    name: name || null, org_type: orgType, category, what_for: whatFor, email, phone, website: web, last_contact_month: last,
    continuity_critical: cont.critical, continuity_reason: cont.reason, issues, raw, rawEmail: r.email || '',
  };
}

// ── one subscription row → a contract record ──────────────────────────────────────────────────
const PAID_BY = { 'direct debit': 'direct_debit', 'card': 'card', 'invoice': 'invoice', 'unknown': 'unknown' };
function mapSubscription(r) {
  const issues = [];
  // The evidence column quotes emails and receipts; a card's last four digits have no business in a register.
  const evidence = String(r.evidence || '').replace(/(ending(?: in)?\s+)\d{4}\b/gi, '$1••••');
  const raw = { vendor: r.vendor, what: r.what, cost: r.cost, frequency: r.frequency, renews: r.renews, paidBy: r.paidBy, lastSeen: r.lastSeen, evidence };

  if (!r.vendor) issues.push('vendor_missing'); else if (hasFragment(r.vendor)) issues.push('vendor_name_stripped');
  let title = r.what || null;
  if (!title) issues.push('description_missing'); else if (hasFragment(title)) issues.push('description_partly_stripped');

  let costPence = null;
  const m = String(r.cost || '').match(/(?:GBP|£)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (m) costPence = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100); else issues.push('cost_missing');

  let frequency = String(r.frequency || '').trim().toLowerCase();
  if (!['monthly', 'annual'].includes(frequency)) { frequency = 'unknown'; issues.push('frequency_unknown'); }

  let renewal = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(r.renews || '')) renewal = r.renews; else issues.push('renewal_date_missing');

  const paid = PAID_BY[String(r.paidBy || '').trim().toLowerCase()] || 'unknown';
  if (paid === 'unknown') issues.push('paid_by_unknown');

  let last = MONTH.test(r.lastSeen || '') ? r.lastSeen : null;
  if (!last) issues.push('last_seen_missing');

  issues.push('who_can_cancel_missing');          // no source carries it — a manager fills it in

  const hay = `${r.vendor} ${r.what}`;
  let contractType = 'subscription';
  if (/insur|indemnity/i.test(hay)) contractType = 'insurance';
  else if (/\bwaste\b|\bwater\b|electric|\bgas\b|energy|tv licen/i.test(hay)) contractType = 'utility';
  const cont = continuityFor(r.vendor, r.what);

  return {
    key: `subscription:${orgKey(r.vendor) || 'row' + r.line}:${(r.what || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40) || r.line}`,
    vendor: r.vendor || null, vendorKey: hasFragment(r.vendor) || !r.vendor ? null : orgKey(r.vendor),
    title: title || r.vendor || 'Subscription', contract_type: contractType,
    cost_pence: costPence, frequency,
    monthly_cost_pence: frequency === 'monthly' ? costPence : null,     // only what the source said; never derived
    annual_cost_pence: frequency === 'annual' ? costPence : null,
    renewal_date: renewal, paid_by: paid, last_seen_month: last, auto_renew: null,
    continuity_critical: cont.critical, continuity_reason: cont.reason, issues, raw,
  };
}

// ── the whole plan, without touching a database ───────────────────────────────────────────────
/**
 * @param {string} md  the audit file
 * @param {{familyEmails?:Set<string>}} opts
 * @returns a plan: the supplier rows and contract rows an apply would write, and every count the dry-run prints
 */
function plan(md, opts = {}) {
  const parsed = parseAudit(md);
  const family = opts.familyEmails || new Set();
  const count = (arr, code) => arr.filter(x => x.issues.includes(code)).length;

  const suppliers = new Map();       // key -> record
  const duplicates = [];
  let skippedFamily = 0;
  const contactRecs = [];
  for (const row of parsed.contacts) {
    if (row.email && family.has(String(row.email).toLowerCase())) { skippedFamily++; continue; }
    const rec = mapContact(row);
    contactRecs.push(rec);
    if (suppliers.has(rec.key)) { duplicates.push({ key: rec.key, raw: rec.raw }); suppliers.get(rec.key).raw_duplicates = (suppliers.get(rec.key).raw_duplicates || []).concat([rec.raw]); continue; }
    suppliers.set(rec.key, rec);
  }

  const byOrg = new Map([...suppliers.values()].filter(s => s.name && !s.issues.includes('name_stripped')).map(s => [orgKey(s.name), s]));
  const contracts = [];
  let matched = 0, newSuppliers = 0;
  for (const row of parsed.subscriptions) {
    const c = mapSubscription(row);
    let sup = c.vendorKey ? byOrg.get(c.vendorKey) : null;
    if (sup) matched++;
    else {
      // A vendor the contacts table does not have (or whose name was stripped): it still gets a supplier row, so
      // the contract has an owner — with what the subscription row itself said, and nothing invented.
      const issues = ['org_type_missing', 'email_missing', 'phone_missing', 'website_missing'];
      if (!c.vendor) issues.push('name_missing'); else if (hasFragment(c.vendor)) issues.push('name_stripped');
      sup = { key: c.vendorKey ? `subscription-vendor:${c.vendorKey}` : `subscription-vendor-row:${row.line}`, name: c.vendor, org_type: null, category: 'other',
              what_for: c.title, email: null, phone: null, website: null, last_contact_month: c.last_seen_month,
              continuity_critical: c.continuity_critical, continuity_reason: c.continuity_reason, issues, raw: { fromSubscriptionRow: true, vendor: row.vendor }, fromSubscription: true };
      if (!suppliers.has(sup.key)) { suppliers.set(sup.key, sup); newSuppliers++; if (c.vendorKey) byOrg.set(c.vendorKey, sup); }
      else sup = suppliers.get(sup.key);
    }
    // a subscription that trips a continuity rule makes its supplier continuity-critical too
    if (c.continuity_critical && !sup.continuity_critical) { sup.continuity_critical = true; sup.continuity_reason = c.continuity_reason; }
    contracts.push({ ...c, supplierKey: sup.key });
  }

  const supList = [...suppliers.values()];
  const summary = {
    contacts: { parsed: parsed.contacts.length, declared: parsed.declared.contacts, malformed: parsed.malformed.contacts.length,
                skipped_family_email: skippedFamily, duplicate_rows_merged: duplicates.length },
    subscriptions: { parsed: parsed.subscriptions.length, declared: parsed.declared.subscriptions, malformed: parsed.malformed.subscriptions.length,
                     matched_to_a_contact: matched, needed_a_new_supplier_row: newSuppliers },
    would_write: { suppliers: supList.length, contracts: contracts.length },
    contact_rows_lacking: Object.fromEntries(['name_stripped', 'name_missing', 'type_missing', 'type_unrecognised', 'what_for_missing', 'what_for_partly_stripped',
      'email_missing', 'email_stripped', 'email_invalid', 'email_is_a_sending_address', 'phone_missing', 'phone_stripped', 'website_missing', 'website_stripped',
      'last_contact_missing', 'last_contact_unreadable'].map(k => [k, count(contactRecs, k)])),
    subscription_rows_lacking: Object.fromEntries(['vendor_name_stripped', 'description_missing', 'description_partly_stripped', 'cost_missing', 'frequency_unknown',
      'renewal_date_missing', 'paid_by_unknown', 'last_seen_missing', 'who_can_cancel_missing'].map(k => [k, count(contracts, k)])),
    continuity_critical_suggested: { suppliers: supList.filter(s => s.continuity_critical).length, contracts: contracts.filter(c => c.continuity_critical).length },
  };
  return { parsed, suppliers: supList, contracts, summary, duplicates };
}

// ── bank reconciliation ───────────────────────────────────────────────────────────────────────
const bankKey = s => String(s || '').toLowerCase()
  .replace(/\b(direct debit|dd|standing order|so|card payment|payment to|bill payment|faster payment|bacs|fpo|fpi|ref|reference|ltd|limited|plc|uk)\b/g, ' ')
  .replace(/[0-9]+/g, ' ').replace(/[^a-z]+/g, ' ').trim().split(' ').filter(w => w.length > 1).slice(0, 3).join(' ');

/**
 * Payees paid again and again. Outgoing lines only (amount_pence < 0 — finance-reconcile.js treats > 0 as money in).
 * "Recurring" is at least `minMonths` distinct calendar months with a payment, and a size that does not swing
 * wildly (so a shop you visit is not a subscription, and payroll to a named person — which varies — is not either).
 */
function findRecurring(lines, opts = {}) {
  const minMonths = opts.minMonths || 3;
  const groups = new Map();
  for (const l of lines) {
    const amt = Number(l.amount_pence);
    if (!(amt < 0)) continue;
    const label = (l.payee_name && String(l.payee_name).trim()) || (l.description && String(l.description).trim()) || '';
    const key = bankKey(label);
    if (!key) continue;
    const d = l.transaction_date instanceof Date ? l.transaction_date : new Date(String(l.transaction_date).slice(0, 10) + 'T12:00:00Z');
    const month = d.toISOString().slice(0, 7);
    if (!groups.has(key)) groups.set(key, { key, label, months: new Set(), amounts: [], last: d, first: d, n: 0 });
    const g = groups.get(key);
    g.months.add(month); g.amounts.push(Math.abs(amt)); g.n++;
    if (d > g.last) g.last = d; if (d < g.first) g.first = d;
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.months.size < minMonths) continue;
    const a = g.amounts.slice().sort((x, y) => x - y);
    const median = a[Math.floor(a.length / 2)];
    const steady = a.filter(x => x >= median * 0.7 && x <= median * 1.3).length / a.length;
    if (steady < 0.7) continue;                                    // amounts swing: not a subscription
    out.push({ payee_key: g.key, payee: g.label, payments: g.n, months: g.months.size, typical_pence: median,
               first: g.first.toISOString().slice(0, 10), last: g.last.toISOString().slice(0, 10) });
  }
  return out.sort((x, y) => y.typical_pence * y.months - x.typical_pence * x.months);
}

/** Is this payee already a supplier? Name tokens, or the supplier's web/email domain appearing in the bank text. */
function matchRegister(payee, suppliers) {
  const pk = orgKey(payee.payee), bk = payee.payee_key;
  const text = String(payee.payee || '').toLowerCase();
  for (const s of suppliers) {
    const sk = orgKey(s.name);
    if (sk && pk && (sk === pk || (sk.length >= 5 && pk.includes(sk)) || (pk.length >= 5 && sk.includes(pk)))) return s;
    const first = bankKey(s.name);
    if (first && bk && (first === bk || (first.length >= 5 && bk.startsWith(first)))) return s;
    for (const d of [s.website, s.email && s.email.split('@')[1]]) {
      const root = String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[\/:]/)[0].split('.')[0];
      if (root && root.length >= 5 && text.replace(/[^a-z]/g, '').includes(root)) return s;
    }
  }
  return null;
}

module.exports = { parseAudit, mapContact, mapSubscription, continuityFor, plan, orgKey, findRecurring, matchRegister, bankKey, hasFragment, TYPE_MAP, CONTINUITY_RULES };
