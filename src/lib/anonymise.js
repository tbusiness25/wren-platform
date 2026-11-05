'use strict';
/**
 * anonymise.js — b402 (2026-10-06).
 *
 * Turns rows that name real people into rows that don't, for "anon mode" on
 * exports/reports and for anything sent to a non-local AI provider. Never
 * mutates its input — always returns new row objects.
 *
 * PSEUDONYMS
 * Every identifier-class NAME value becomes a label like "Child C-4F2A" — one
 * label per entity per call, so a child's name in two different columns (or
 * on two different rows, e.g. a sibling) still reads as the same label, and
 * a report that lists a child once per row still lines up with itself. The
 * label is HMAC-SHA256(salt, kind + ':' + entityId), truncated to 4 hex chars.
 * `stable: true` derives the salt from JWT_SECRET (same label every run, for a
 * repeat feed to one third party); otherwise the salt is random per call, so
 * two exports of the same data cannot be joined by matching labels.
 *
 * WHAT EACH CLASS BECOMES (see src/lib/pii-registry.js for the classes)
 *   identifier → name-shaped column: the row's pseudonym label
 *              → email-shaped column: "<slug>@anon.invalid"
 *              → phone-shaped column: removed (null)
 *              → postcode-shaped column: outward code only ("AB1 2CD" → "W13")
 *              → address-shaped column: removed (null)
 *   dob              → year-month only ("2022-03-17" → "2022-03"), or age in
 *                       months if opts.dobAsAge
 *   gov_id            → removed (null)
 *   financial         → removed (null)
 *   special_category  → removed (null), unless opts.keepSpecial === true
 *   free_text         → column deleted entirely, unless opts.scrubFreeText,
 *                       which replaces known names/emails/phones/postcodes
 *                       with best-effort masks (never a value guarantee)
 *   (unclassified)    → left unchanged
 */

const crypto = require('crypto');
const { classifyColumn } = require('./pii-registry');

const KIND_LETTER = { child: 'C', parent: 'P', staff: 'S', contact: 'K', person: 'X' };
const ENTITY_ID_KEYS = [['child', 'child_id'], ['staff', 'staff_id'], ['contact', 'contact_id'], ['parent', 'parent_id']];
const TABLE_KIND = { children: 'child', staff: 'staff', contacts: 'contact', parents: 'parent', guardians: 'contact' };

function randomSalt() { return crypto.randomBytes(16); }
function stableSalt() {
  const secret = process.env.JWT_SECRET || '';
  return crypto.createHash('sha256').update('pii-anon:stable:' + secret).digest();
}

function pseudonym(salt, kind, id) {
  if (id == null) return null;
  const letter = KIND_LETTER[kind] || KIND_LETTER.person;
  const hex = crypto.createHmac('sha256', salt).update(`${kind}:${id}`).digest('hex').slice(0, 4).toUpperCase();
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  return { label: `${label} ${letter}-${hex}`, slug: `${letter.toLowerCase()}-${hex.toLowerCase()}` };
}

// Which entity (kind, id) a row belongs to, for pseudonym consistency. Explicit
// opts win; otherwise look for a *_id column, then fall back to the table's own
// "kind" + its own id (e.g. a `children` row keyed by its own `id`).
function entityFor(row, table, opts) {
  if (opts.entityKind && row[opts.entityIdKey] != null) {
    return { kind: opts.entityKind, id: row[opts.entityIdKey] };
  }
  for (const [kind, key] of ENTITY_ID_KEYS) {
    if (row[key] != null) return { kind, id: row[key] };
  }
  const tableKind = TABLE_KIND[String(table || '').toLowerCase()];
  if (tableKind && row.id != null) return { kind: tableKind, id: row.id };
  return null;
}

function identifierKind(column) {
  const c = String(column).toLowerCase();
  if (/email/.test(c)) return 'email';
  if (/phone|mobile|\btel\b/.test(c)) return 'phone';
  if (/postcode|post_code/.test(c)) return 'postcode';
  if (/address/.test(c)) return 'address';
  return 'name';
}

function outwardCode(postcode) {
  const m = /^\s*([A-Za-z]{1,2}\d[A-Za-z\d]?)/.exec(String(postcode || ''));
  return m ? m[1].toUpperCase() : null;
}

function coarsenDob(value, asAge) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  if (asAge) {
    const months = Math.max(0, Math.floor((Date.now() - d.getTime()) / (30.44 * 24 * 3600 * 1000)));
    return `${months}m`;
  }
  return d.toISOString().slice(0, 7); // YYYY-MM
}

/**
 * @param {object[]} rows    plain row objects — never mutated
 * @param {object}   opts
 * @param {string}   opts.table            table / subject name, for classification + entity kind
 * @param {string[]} [opts.columns]        column names to consider; default = keys of rows[0]
 * @param {boolean}  [opts.keepSpecial]    keep special_category values (default: removed)
 * @param {boolean}  [opts.scrubFreeText]  best-effort scrub free_text instead of dropping it
 * @param {boolean}  [opts.dobAsAge]       dob → age in months instead of year-month
 * @param {boolean}  [opts.stable]         derive the pseudonym salt from JWT_SECRET (repeat feeds)
 * @param {Buffer}   [opts.salt]           explicit salt (keeps a caller's own exports joinable)
 * @param {string}   [opts.entityIdKey]    row key holding the entity id, overriding auto-detect
 * @param {string}   [opts.entityKind]     entity kind for entityIdKey ('child'|'staff'|'contact'|'parent')
 * @returns {object[]} new row objects
 */
function anonymiseRows(rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const table = opts.table || '';
  const columns = opts.columns || Object.keys(rows[0]);
  const salt = opts.salt || (opts.stable ? stableSalt() : randomSalt());

  const plan = columns.map(col => ({ col, cls: classifyColumn(table, col) }));
  const freeTextCols = plan.filter(p => p.cls === 'free_text' && !opts.scrubFreeText).map(p => p.col);

  // For scrubFreeText: collect every real name-ish string this row-set holds,
  // longest first so "Jo" doesn't eat the "Jo" inside "Joseph" first.
  let knownNames = [];
  if (opts.scrubFreeText) {
    const nameCols = plan.filter(p => p.cls === 'identifier' && identifierKind(p.col) === 'name').map(p => p.col);
    const set = new Set();
    for (const row of rows) for (const col of nameCols) {
      const v = row[col];
      if (v) String(v).split(/\s+/).filter(w => w.length > 1).forEach(w => set.add(w));
    }
    knownNames = [...set].sort((a, b) => b.length - a.length);
  }

  const pseudoCache = new Map(); // `${kind}:${id}` -> {label, slug}
  const pseudoForEntity = (entity) => {
    if (!entity) return null;
    const key = `${entity.kind}:${entity.id}`;
    if (!pseudoCache.has(key)) pseudoCache.set(key, pseudonym(salt, entity.kind, entity.id));
    return pseudoCache.get(key);
  };

  return rows.map(row => {
    const entity = entityFor(row, table, opts);
    const p = pseudoForEntity(entity) || pseudonym(salt, 'person', JSON.stringify(row).slice(0, 64));
    const out = {};
    for (const { col, cls } of plan) {
      if (freeTextCols.includes(col)) continue; // dropped column entirely
      const v = row[col];
      switch (cls) {
        case 'identifier': {
          const kind = identifierKind(col);
          if (v == null || v === '') { out[col] = v; break; }
          if (kind === 'email') out[col] = `${p.slug}@anon.invalid`;
          else if (kind === 'phone') out[col] = null;
          else if (kind === 'postcode') out[col] = outwardCode(v);
          else if (kind === 'address') out[col] = null;
          else out[col] = p.label;
          break;
        }
        case 'dob':
          out[col] = coarsenDob(v, opts.dobAsAge);
          break;
        case 'gov_id':
        case 'financial':
          out[col] = null;
          break;
        case 'special_category':
          out[col] = opts.keepSpecial ? v : null;
          break;
        case 'free_text': { // only reached when scrubFreeText is true
          let s = v == null ? v : String(v);
          if (s) {
            for (const name of knownNames) {
              if (name.length < 2) continue;
              s = s.split(name).join(p.label);
            }
            s = s.replace(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi, `${p.slug}@anon.invalid`);
            s = s.replace(/\b0\d{9,10}\b|\+44\s?\d{9,10}\b/g, '[phone removed]');
            s = s.replace(/\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b/g, m => outwardCode(m) || '[postcode removed]');
          }
          out[col] = s;
          break;
        }
        default:
          out[col] = v;
      }
    }
    return out;
  });
}

/**
 * Adapter for src/lib/report-builder.js's positional result shape
 * ({ columns: [{key,label,...}], rows: string[][], ids: number[] }), which
 * doesn't carry plain row objects. Builds objects, anonymises, and rebuilds
 * the same positional shape — columns whose class drops them (free_text) are
 * removed from the header too, so the CSV stays rectangular.
 *
 * @param {string} subject  the report-builder subject key (e.g. 'children')
 * @param {{columns: object[], rows: (string|null)[][], ids: (number|null)[]}} result
 * @param {object} [opts]   same opts as anonymiseRows (table/entityKind are set here)
 */
function anonymiseReportBuilderResult(subject, result, opts = {}) {
  const ENTITY_KIND = { children: 'child', staff: 'staff' };
  const entityKind = ENTITY_KIND[subject] || 'person';
  const keys = result.columns.map(c => c.key);

  const rowObjs = result.rows.map((cells, i) => {
    const o = {};
    keys.forEach((k, idx) => { o[k] = cells[idx]; });
    o.__entity_id = result.ids ? result.ids[i] : null;
    return o;
  });

  const anon = anonymiseRows(rowObjs, Object.assign({}, opts, {
    table: subject, columns: keys, entityIdKey: '__entity_id', entityKind,
  }));

  const keptKeys = keys.filter(k => anon.length === 0 || Object.prototype.hasOwnProperty.call(anon[0], k));
  const keptColumns = result.columns.filter(c => keptKeys.includes(c.key));
  const rows = anon.map(o => keptKeys.map(k => (o[k] == null ? null : String(o[k]))));

  return Object.assign({}, result, { columns: keptColumns, rows });
}

module.exports = { anonymiseRows, anonymiseReportBuilderResult, outwardCode, coarsenDob };
