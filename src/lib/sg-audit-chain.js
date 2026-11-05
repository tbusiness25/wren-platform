'use strict';
/**
 * Safeguarding audit chain — the ONE implementation of "is this chain sound".
 *
 * E3b (2026-10-20). There were two copies of this walk: POST
 * /api/safeguarding-ext/validate-chain (what a DSL presses in Roost) and
 * scripts/validate-sg-chain.js (the 02:00 cron). Both had the same three faults, and
 * because the payload format has to match src/routes/safeguarding-ext.js writeAudit()
 * exactly, two copies were two chances to drift. There is now one.
 *
 * What the three kinds of finding mean — they are NOT the same severity:
 *
 *   TAMPER     a row's hash does not reproduce from its own contents at any nearby
 *              instant. The row was changed after it was written. This is the serious
 *              one and the only one that means a record was altered.
 *
 *   FORK       two rows claim the same parent. Until E3b, writeAudit read the tail hash
 *              and inserted in two separate queries, so simultaneous appends both
 *              claimed the same parent. Each row still verifies, so nothing was
 *              altered — the chain has a branch. Fixed at source by appending inside
 *              one transaction under an advisory lock.
 *
 *   TIMESTAMP  the row verifies at an instant a millisecond or two from its stored
 *              occurred_at. Until E3b, writeAudit hashed a JS clock read and let
 *              occurred_at fall to the column default now(), so the stored timestamp
 *              was not the hashed one and a row only verified when the two landed in
 *              the same millisecond. Contents intact; the row simply cannot be
 *              re-hashed exactly. Prod ids 2 and 3 are this, at -1 ms. Rows written
 *              from E3b onwards bind occurred_at to the hashed instant.
 *
 * Nothing here writes, deletes or re-hashes a row. Repairing history is not on offer:
 * an audit trail you can rewrite is not an audit trail.
 */

const crypto = require('crypto');

// Must stay identical to writeAudit() in src/routes/safeguarding-ext.js.
function expectedSelf(row, parentHash) {
  const ts = row.occurred_at instanceof Date
    ? row.occurred_at.toISOString()
    : String(row.occurred_at);
  return crypto.createHash('sha256').update([
    String(row.user_id || 0),
    row.action,
    row.entity_type || '',
    String(row.entity_id || ''),
    parentHash,
    ts,
  ].join('|')).digest('hex');
}

// Only ever called on a row that already failed the direct check, and bounded, so a
// healthy chain costs nothing.
const TS_PROBE_MS = 2000;
function contentIntactAt(row, parentHash) {
  const base = row.occurred_at instanceof Date
    ? row.occurred_at.getTime()
    : Date.parse(String(row.occurred_at));
  if (!Number.isFinite(base)) return null;
  for (let d = 1; d <= TS_PROBE_MS; d++) {
    for (const off of [-d, d]) {
      const probe = Object.assign({}, row, { occurred_at: new Date(base + off) });
      if (row.hash_self === expectedSelf(probe, parentHash)) {
        return { offsetMs: off, hashedAt: new Date(base + off).toISOString() };
      }
    }
  }
  return null;
}

/**
 * @param {Array} rows   safeguarding_access_audit, ordered by id ASC
 * @param {Set<number>} [acknowledged]  row ids Toby has already been told about
 * @returns {{rowsChecked:number, findings:Array, unacknowledged:Array, known:Array,
 *            tampered:number, ok:boolean, contentsIntact:boolean}}
 */
function classifyChain(rows, acknowledged) {
  const ack = acknowledged instanceof Set ? acknowledged : new Set();
  const raw = [];
  const seenParent = new Map();   // hash_previous -> first row id that claimed it
  let prevSelf = 'genesis';

  for (const row of rows) {
    const claimedParent = row.hash_previous == null ? 'genesis' : row.hash_previous;

    // (a) does the row reproduce its own hash from its own contents and claimed parent?
    if (row.hash_self !== expectedSelf(row, claimedParent)) {
      const intact = contentIntactAt(row, claimedParent);
      raw.push(intact
        ? { id: row.id, occurred_at: row.occurred_at, kind: 'TIMESTAMP',
            detail: `contents intact; hashed at ${intact.hashedAt} (` +
                    `${intact.offsetMs > 0 ? '+' : ''}${intact.offsetMs}ms from the stored ` +
                    `occurred_at) — written before E3b bound the two together` }
        : { id: row.id, occurred_at: row.occurred_at, kind: 'TAMPER',
            detail: 'hash_self does not match the row contents' });
    }

    // (b) has another row already claimed this parent?
    if (seenParent.has(claimedParent)) {
      raw.push({ id: row.id, occurred_at: row.occurred_at, kind: 'FORK',
                 detail: `same parent as id ${seenParent.get(claimedParent)} ` +
                         `(concurrent append; contents intact)` });
    } else {
      seenParent.set(claimedParent, row.id);
    }

    // (c) does it point at the row immediately before it?
    if (claimedParent !== prevSelf) {
      raw.push({ id: row.id, occurred_at: row.occurred_at, kind: 'LINK',
                 detail: "hash_previous is not the previous row's hash_self" });
    }

    prevSelf = row.hash_self;
  }

  // A fork always produces a LINK finding on the same row. That is one event, not two.
  const forked = new Set(raw.filter(f => f.kind === 'FORK').map(f => f.id));
  const findings = raw.filter(f => !(f.kind === 'LINK' && forked.has(f.id)));

  const tampered = findings.filter(f => f.kind === 'TAMPER');
  return {
    rowsChecked: rows.length,
    findings,
    unacknowledged: findings.filter(f => !ack.has(f.id)),
    known:          findings.filter(f =>  ack.has(f.id)),
    tampered: tampered.length,
    ok: findings.length === 0,
    // The distinction that actually matters to a DSL: has any RECORD changed?
    contentsIntact: tampered.length === 0,
  };
}

// Row ids already reported, from settings.sg_chain_acknowledged_breaks (a JSON array).
// Acknowledging an id is a deliberate, recorded decision and silences any finding on
// it. Unset means nothing is silenced.
async function acknowledgedIds(db) {
  try {
    const { rows } = await db.query(
      `SELECT value FROM settings WHERE key = 'sg_chain_acknowledged_breaks'`);
    if (!rows.length) return new Set();
    const parsed = JSON.parse(rows[0].value);
    return new Set((Array.isArray(parsed) ? parsed : []).map(Number).filter(Number.isFinite));
  } catch (_) { return new Set(); }
}

module.exports = { classifyChain, acknowledgedIds, expectedSelf, contentIntactAt };
