'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b325 — matching incoming money to the family that sent it.
//
// CERTAINTY FIRST, PROPOSALS NOT GUESSES. In order:
//
//   1. a TFC childcare reference in the transaction → that CHILD      — certain
//   2. the family payment reference                → that FAMILY      — certain
//   3. a payer a manager has confirmed once        → that family      — proposed
//   4. anything else                               → the unmatched queue
//
// There is deliberately no fourth heuristic. The old scorer in
// src/routes/finance-reconcile.js adds points for a surname appearing anywhere in
// the narrative, for an amount being within £5, for the word "tfc" — and
// auto-confirms at 95. This engine never scores. Either the transaction carries
// something that identifies exactly one family, or it does not and a human looks
// at it. That is what makes kinds 1 and 2 safe to call certain.
//
// DRY RUN BY DEFAULT. scanLines() writes PROPOSALS and moves no money. Applying
// is a separate, audited call. Auto-apply is off (settings.payment_match_auto_apply)
// and even when it is switched on only kinds 1 and 2 may take it — a confirmed
// payer is a memory of a human judgement, not a fact about this transaction.
//
// NOTHING HERE TALKS TO XERO. Xero is the bank-feed source; payments are recorded
// against WREN invoices. See the b325 brief and the 2026-09-09 Xero clean-up: LADN
// raises no invoices in Xero, 543 bogus payments had to be removed, and a
// successful Xero write can return HTTP 400.
// ─────────────────────────────────────────────────────────────────────────────

const PR = require('../lib/payment-references');
// b365 — an allocation carries the period of the INVOICE it pays, not the day
// the bank moved. Resolved here at write time so a row is right the moment it
// is created; the v_allocation_periods view derives it again at read time for
// anything written by a path that predates this.
const AP = require('../lib/allocation-period');

/** The one definition of "family", shared with src/lib/invoice-discounts.js. */
const FAMILY_KEY_SQL = (alias = 'c') => `NULLIF(lower(btrim(${alias}.primary_contact_email)), '')`;

const KIND = {
  TFC:    'tfc_reference',
  FAMILY: 'family_reference',
  PAYER:  'confirmed_payer',
  MANUAL: 'manual',
};
/** Only these two may ever auto-apply, and only once the setting is switched on. */
const AUTO_APPLY_KINDS = new Set([KIND.TFC, KIND.FAMILY]);

const pence = (v) => Math.round(Number(v) || 0);

/** A pg DATE is a local-midnight JS Date; both String() and toISOString() are wrong. */
function ymd(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

// ── Family references ────────────────────────────────────────────────────────

/**
 * Give this family its payment reference, or return the one it already has.
 *
 * Uniqueness is the database's (family_payment_refs_ref_uq); a collision is
 * retried rather than pre-checked, because a SELECT-then-INSERT is a race that
 * two managers pressing the button at once would win together.
 */
async function ensureFamilyRef(db, familyKey, createdBy = null) {
  const key = String(familyKey || '').toLowerCase().trim();
  if (!key) throw new Error('familyKey required');

  const { rows: [have] } = await db.query(
    `SELECT payment_ref FROM family_payment_refs
      WHERE family_key = $1 AND retired_at IS NULL LIMIT 1`, [key]);
  if (have) return { payment_ref: have.payment_ref, created: false };

  for (let attempt = 0; attempt < 25; attempt++) {
    const ref = PR.mintRef();
    try {
      const { rows } = await db.query(
        `INSERT INTO family_payment_refs (family_key, payment_ref, created_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (family_key) WHERE retired_at IS NULL DO NOTHING
         RETURNING payment_ref`, [key, ref, createdBy]);
      if (rows.length) return { payment_ref: rows[0].payment_ref, created: true };
      // The family-level conflict fired: somebody else got there first.
      const { rows: [now] } = await db.query(
        `SELECT payment_ref FROM family_payment_refs
          WHERE family_key = $1 AND retired_at IS NULL LIMIT 1`, [key]);
      if (now) return { payment_ref: now.payment_ref, created: false };
    } catch (e) {
      // 23505 on the REF index: this reference is taken (live or retired — a
      // reference is never reused). Mint another.
      if (e.code !== '23505') throw e;
    }
  }
  throw new Error('could not allocate a unique payment reference');
}

/** Every billing family, with its reference and its children. */
async function listFamilies(db, { includeLeavers = false } = {}) {
  const { rows } = await db.query(`
    SELECT ${FAMILY_KEY_SQL('c')}                          AS family_key,
           f.payment_ref,
           f.created_at                                    AS ref_created_at,
           count(*)                                        AS child_count,
           array_agg(c.id ORDER BY c.id)                   AS child_ids,
           array_agg(c.first_name || ' ' || c.last_name ORDER BY c.id) AS child_names,
           array_agg(NULLIF(btrim(c.tfc_payment_reference), '') ORDER BY c.id)
             FILTER (WHERE NULLIF(btrim(c.tfc_payment_reference), '') IS NOT NULL) AS tfc_refs
      FROM children c
      LEFT JOIN family_payment_refs f
             ON f.family_key = ${FAMILY_KEY_SQL('c')} AND f.retired_at IS NULL
     WHERE ${FAMILY_KEY_SQL('c')} IS NOT NULL
       ${includeLeavers ? '' : "AND c.status = 'active'"}
     GROUP BY ${FAMILY_KEY_SQL('c')}, f.payment_ref, f.created_at
     ORDER BY 1`);
  return rows;
}

/** Allocate a reference to every family that has none. Idempotent. */
async function ensureAllFamilyRefs(db, createdBy = null) {
  const families = await listFamilies(db);
  let created = 0;
  for (const f of families) {
    if (f.payment_ref) continue;
    const r = await ensureFamilyRef(db, f.family_key, createdBy);
    if (r.created) created++;
  }
  return { families: families.length, created,
           already_had: families.filter(f => f.payment_ref).length };
}

// ── Resolving one bank line ──────────────────────────────────────────────────

/**
 * The lookup tables a scan runs against. Loaded once per scan, not once per line.
 * Children are keyed by TFC reference; families by payment reference; payers by
 * the key src/lib/payment-references.js payerKey() builds.
 */
async function loadMatchContext(db) {
  const [{ rows: children }, { rows: refs }, { rows: payers }] = await Promise.all([
    db.query(`
      SELECT c.id, ${FAMILY_KEY_SQL('c')} AS family_key,
             upper(btrim(c.tfc_payment_reference)) AS tfc_ref
        FROM children c
       WHERE NULLIF(btrim(c.tfc_payment_reference), '') IS NOT NULL`),
    db.query(`SELECT family_key, payment_ref FROM family_payment_refs WHERE retired_at IS NULL`),
    db.query(`SELECT id, payer_key, family_key FROM payment_payer_links WHERE revoked_at IS NULL`),
  ]);
  return {
    byTfc:   new Map(children.map(r => [r.tfc_ref, r])),
    byRef:   new Map(refs.map(r => [r.payment_ref, r.family_key])),
    byPayer: new Map(payers.map(r => [r.payer_key, r])),
  };
}

/**
 * What, if anything, this transaction says about who sent it.
 *
 * Reads the description, the reference column and the payee name together — a
 * bank puts the reference in whichever of the three it feels like. Returns null
 * for the unmatched queue.
 *
 * AMBIGUITY IS NOT A MATCH. A line quoting two different family references, or
 * two children's TFC references, resolves to nothing and goes to the queue: two
 * answers is not more certain than one, it is less.
 */
function resolveLine(line, ctx) {
  const narrative = [line.description, line.reference, line.payee_name,
                     line.line_item_desc].filter(Boolean).join(' ');

  // ── 1. A TFC childcare reference → that child. Certain.
  const tfcHits = PR.findTfcRefsInText(narrative)
    .map(ref => ({ ref, child: ctx.byTfc.get(ref) }))
    .filter(h => h.child);
  const tfcChildIds = new Set(tfcHits.map(h => h.child.id));
  if (tfcChildIds.size > 1) {
    return { kind: null, ambiguous: 'tfc_reference',
             evidence: { refs: tfcHits.map(h => h.ref) } };
  }
  if (tfcHits.length) {
    const h = tfcHits[0];
    return {
      kind: KIND.TFC, certainty: 'certain',
      child_id: h.child.id, family_key: h.child.family_key,
      evidence: {
        tfc_reference: h.ref,
        tfc_account: PR.findTfcAccountNumbers(narrative)[0] || null,
        // Corroboration for the screen. NOT part of the decision: HMRC's payer
        // name changing would otherwise stop every TFC payment matching.
        payer_looks_like_hmrc: PR.looksLikeTfcPayer(narrative),
      },
    };
  }

  // ── 2. The family payment reference → that family. Certain.
  const refHits = PR.findRefsInText(narrative)
    .map(h => ({ ...h, family_key: ctx.byRef.get(h.ref) }))
    .filter(h => h.family_key);
  const refFamilies = new Set(refHits.map(h => h.family_key));
  if (refFamilies.size > 1) {
    return { kind: null, ambiguous: 'family_reference',
             evidence: { refs: refHits.map(h => h.ref) } };
  }
  if (refHits.length) {
    return {
      kind: KIND.FAMILY, certainty: 'certain',
      child_id: null, family_key: refHits[0].family_key,
      evidence: { family_reference: refHits[0].ref, matched_on: refHits[0].token },
    };
  }

  // ── 3. A payer a manager confirmed once → proposed, never certain.
  const pk = PR.payerKey(line.payee_name, line.description);
  const link = pk ? ctx.byPayer.get(pk) : null;
  if (link) {
    return {
      kind: KIND.PAYER, certainty: 'proposed',
      child_id: null, family_key: link.family_key,
      evidence: { payer_key: pk, payer_link_id: link.id,
                  payer_label: line.payee_name || null },
    };
  }

  // ── 4. The unmatched queue.
  return null;
}

// ── Allocation ───────────────────────────────────────────────────────────────

/**
 * Where the money goes: the oldest outstanding invoice first, and whatever is
 * left over becomes credit on the family's account.
 *
 * `childId` narrows it to one child's invoices — that is what a TFC payment is,
 * money paid for a named child. Its remainder still becomes FAMILY credit rather
 * than quietly paying a sibling's bill, which is a decision for the office.
 *
 * Outstanding is computed per invoice from the payments actually recorded against
 * it, never from invoices.status: a part-paid invoice is still 'sent'.
 * DRAFTS ARE EXCLUDED — an invoice nobody has been sent cannot have been paid.
 */
async function planAllocation(db, { familyKey, childId = null, amountPence, onDate }) {
  const params = [familyKey];
  let childFilter = '';
  if (childId) { params.push(childId); childFilter = ` AND i.child_id = $${params.length}`; }

  const { rows: open } = await db.query(`
    SELECT i.id, i.invoice_number, i.child_id, i.issued_on, i.due_on, i.status,
           i.amount_pence,
           -- 2026-10-28: the one outstanding rule (credit notes, allocations, then whole
           -- payments) — before this an invoice already covered by an allocation looked unpaid.
           ${require('../lib/invoice-outstanding').outstandingSql('i')} AS outstanding_pence,
           c.first_name || ' ' || c.last_name AS child_name
      FROM invoices i
      JOIN children c ON c.id = i.child_id
     WHERE ${FAMILY_KEY_SQL('c')} = $1
       ${childFilter}
       AND i.status IN ('sent', 'overdue')
       -- EyLog's own invoices are history: their effect is inside the opening balance.
       AND COALESCE(i.source, '') <> 'eylog-import-b205' AND i.eylog_ref IS NULL
     ORDER BY i.issued_on NULLS LAST, i.id`, params);

  let remaining = pence(amountPence);
  const allocation = [];
  for (const inv of open) {
    if (remaining <= 0) break;
    const outstanding = pence(inv.outstanding_pence);
    if (outstanding <= 0) continue;
    const take = Math.min(remaining, outstanding);
    allocation.push({
      invoice_id: inv.id, invoice_number: inv.invoice_number,
      child_id: inv.child_id, child_name: inv.child_name,
      issued_on: ymd(inv.issued_on), due_on: ymd(inv.due_on),
      invoice_total_pence: pence(inv.amount_pence),
      outstanding_pence: outstanding,
      allocate_pence: take,
      settles: take === outstanding,
    });
    remaining -= take;
  }
  return {
    allocation,
    allocated_pence: pence(amountPence) - remaining,
    credit_pence: remaining,
    open_invoice_count: open.length,
    on_date: ymd(onDate),
  };
}

// ── The scan (dry run) ───────────────────────────────────────────────────────

/**
 * Read the unreconciled credit lines and write a PROPOSAL for each one we can
 * resolve. Moves no money.
 *
 * Only CREDITS (amount_pence > 0) are considered — money leaving the account is
 * not a family paying a bill.
 */
async function scanLines(db, { statementId = null, limit = 500, autoApply = false, actorId = null } = {}) {
  const ctx = await loadMatchContext(db);
  // 2026-10-28 (Toby: "it should self learn, so if previously I've matched a reference to a
  // child and the same reference comes in again it will go to that child again"): a payer
  // remembered from Toby's own matches may now auto-apply too, behind its own setting.
  // A payer remembered for two families never reaches here (payer_key is unique).
  const learnedAuto = autoApply && await learnedAutoApplyEnabled(db);

  const params = [];
  let where = 'l.reconciled = false AND l.amount_pence > 0 AND l.excluded_reason IS NULL';  // set-aside lines (Xero copies, refunds) never match
  if (statementId) { params.push(statementId); where += ` AND l.statement_id = $${params.length}`; }
  params.push(Math.min(parseInt(limit, 10) || 500, 2000));

  const { rows: lines } = await db.query(`
    SELECT l.id, l.statement_id, l.transaction_date, l.description, l.reference,
           l.payee_name, l.line_item_desc, l.amount_pence
      FROM bank_statement_lines l
      -- A line with a proposal already waiting is left alone; re-scanning must not
      -- stack a second copy of the same suggestion in front of the manager.
     WHERE ${where}
       AND NOT EXISTS (SELECT 1 FROM payment_match_proposals p
                        WHERE p.bank_line_id = l.id AND p.status = 'pending')
     ORDER BY l.transaction_date DESC, l.id DESC
     LIMIT $${params.length}`, params);

  const out = { scanned: lines.length, proposed: 0, applied: 0, unmatched: 0,
                ambiguous: 0, by_kind: {}, errors: [] };

  for (const line of lines) {
    const hit = resolveLine(line, ctx);
    if (!hit || !hit.kind) {
      if (hit && hit.ambiguous) out.ambiguous++;
      out.unmatched++;
      continue;
    }
    const plan = await planAllocation(db, {
      familyKey: hit.family_key, childId: hit.child_id,
      amountPence: line.amount_pence, onDate: line.transaction_date,
    });

    const { rows: [prop] } = await db.query(`
      INSERT INTO payment_match_proposals
        (bank_line_id, kind, certainty, family_key, child_id, amount_pence,
         allocation, evidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
      ON CONFLICT (bank_line_id) WHERE status = 'pending' DO NOTHING
      RETURNING id`,
      [line.id, hit.kind, hit.certainty, hit.family_key, hit.child_id,
       pence(line.amount_pence), JSON.stringify(plan.allocation),
       JSON.stringify({ ...hit.evidence,
                        credit_pence: plan.credit_pence,
                        allocated_pence: plan.allocated_pence,
                        line_description: line.description || null })]);
    if (!prop) continue;                       // raced with another scan

    out.proposed++;
    out.by_kind[hit.kind] = (out.by_kind[hit.kind] || 0) + 1;

    // Auto-apply: off unless the setting says otherwise, and never for kind 3.
    if (autoApply && (AUTO_APPLY_KINDS.has(hit.kind) || (learnedAuto && hit.kind === KIND.PAYER))) {
      try {
        await applyProposal(db, prop.id, { actorId, auto: true });
        out.applied++;
      } catch (e) {
        out.errors.push({ proposal_id: prop.id, error: e.message });
      }
    }
  }
  return out;
}

// ── Applying ─────────────────────────────────────────────────────────────────

/**
 * Turn a proposal into money: a payment row per invoice it settles, the leftover
 * as an account credit, and the bank line marked reconciled.
 *
 * THE PLAN IS RE-COMPUTED, NOT REPLAYED. The allocation stored at scan time is
 * what the manager reviewed, but between scanning and approving somebody may have
 * keyed the same payment in by hand. Re-planning against the invoices as they are
 * NOW is what stops an invoice being paid twice; the stored plan is kept in the
 * proposal row as the record of what was shown.
 *
 * Runs in its own transaction on a dedicated client so a half-applied payment
 * cannot survive an error partway down.
 */
async function applyProposal(db, proposalId, { actorId = null, auto = false } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the proposal so two managers pressing Approve cannot both apply it.
    const { rows: [prop] } = await client.query(
      `SELECT * FROM payment_match_proposals WHERE id = $1 FOR UPDATE`, [proposalId]);
    if (!prop) throw new Error('proposal not found');
    if (prop.status !== 'pending') throw new Error(`proposal is already ${prop.status}`);

    const { rows: [line] } = await client.query(
      `SELECT * FROM bank_statement_lines WHERE id = $1 FOR UPDATE`, [prop.bank_line_id]);
    if (!line) throw new Error('bank line not found');
    if (line.reconciled) {
      await client.query(
        `UPDATE payment_match_proposals
            SET status='superseded', decided_by=$2, decided_at=now(),
                decided_reason='the bank line was reconciled another way'
          WHERE id=$1`, [proposalId, actorId]);
      await client.query('COMMIT');
      return { proposal_id: proposalId, status: 'superseded', payment_ids: [] };
    }

    const plan = await planAllocation(client, {
      familyKey: prop.family_key, childId: prop.child_id,
      amountPence: prop.amount_pence, onDate: line.transaction_date,
    });

    const { rows: [fam] } = await client.query(
      `SELECT payment_ref FROM family_payment_refs
        WHERE family_key = $1 AND retired_at IS NULL LIMIT 1`, [prop.family_key]);

    const evidence = {
      ...(prop.evidence || {}),
      matched_by: auto ? 'auto' : 'manager',
      bank_line_id: line.id,
      // Kept so a payment can explain itself even if the plan changes later.
      planned_at_scan: prop.allocation,
    };

    const paymentIds = [];
    const paidOn = ymd(line.transaction_date);
    for (const a of plan.allocation) {
      const { rows: [pmt] } = await client.query(`
        INSERT INTO payments
          (invoice_id, child_id, bill_payer_email, amount_pence, payment_method, status,
           description, bank_statement_line_id, reconciliation_status, paid_on, source,
           match_kind, match_certainty, match_evidence, match_proposal_id,
           family_payment_ref, updated_at)
        VALUES ($1,$2,$3,$4,'bank_transfer','succeeded',$5,$6,'reconciled',$7,'b325-match',
                $8,$9,$10::jsonb,$11,$12,now())
        RETURNING id`,
        [a.invoice_id, a.child_id, prop.family_key, a.allocate_pence,
         `Bank transfer — ${prop.kind.replace(/_/g, ' ')}`, line.id, paidOn,
         prop.kind, prop.certainty, JSON.stringify(evidence), prop.id,
         fam ? fam.payment_ref : null]);
      paymentIds.push(pmt.id);

      // The invoice↔payment link the finance screens derive paid state from.
      // b365: allocated_on stays the day the money moved (it is the only date
      // the bank gave us). period_* is the month the invoice is FOR, which is
      // what income is now reported on.
      const per = await AP.periodOfInvoiceId(client, a.invoice_id);
      await client.query(`
        INSERT INTO payment_allocations
          (payment_id, invoice_id, child_id, amount_pence, allocated_on, source, reference,
           period_year, period_month, period_source)
        VALUES ($1,$2,$3,$4,$5,'b325-match',$6,$7,$8,$9)`,
        [pmt.id, a.invoice_id, a.child_id, a.allocate_pence, paidOn,
         fam ? fam.payment_ref : (prop.evidence || {}).tfc_reference || null,
         per.year, per.month, per.source]);

      // Paid only when nothing is left owing — a part payment must stay 'sent'.
      if (a.settles) {
        await client.query(
          `UPDATE invoices SET status='paid', paid_on=$1, updated_at=now()
            WHERE id=$2 AND status IN ('sent','overdue')`, [paidOn, a.invoice_id]);
      }
    }

    // Overpayment becomes credit on the family's account, for the office to apply
    // to a future invoice. Never auto-applied to a draft — that would change a
    // bill a parent has not seen yet.
    // 2026-10-28: as a PAYMENT on the account (invoice_id NULL), not parent_account_credits —
    // the family ledger (the tally parents and Roost see) counts payments only, so credit
    // parked in that table vanished from the balance. account-allocate.js puts it on the
    // next bill, like EyLog.
    if (plan.credit_pence > 0) {
      let creditChild = prop.child_id || (plan.allocation[0] && plan.allocation[0].child_id) || null;
      if (!creditChild) {
        const { rows: [c] } = await client.query(
          `SELECT c.id FROM children c WHERE ${FAMILY_KEY_SQL('c')} = $1
            ORDER BY (c.status = 'active') DESC, c.id LIMIT 1`, [prop.family_key]);
        creditChild = c ? c.id : null;
      }
      if (!creditChild) throw new Error('no child in this family to hold the credit');
      const { rows: [cp] } = await client.query(`
        INSERT INTO payments
          (invoice_id, child_id, bill_payer_email, amount_pence, payment_method, status,
           description, bank_statement_line_id, reconciliation_status, paid_on, source,
           match_kind, match_certainty, match_evidence, match_proposal_id,
           family_payment_ref, updated_at)
        VALUES (NULL,$1,$2,$3,'bank_transfer','succeeded',$4,$5,'reconciled',$6,'b325-match',
                $7,$8,$9::jsonb,$10,$11,now())
        RETURNING id`,
        [creditChild, prop.family_key, plan.credit_pence,
         'Bank transfer — paid on account (credit)', line.id, paidOn,
         prop.kind, prop.certainty, JSON.stringify(evidence), prop.id,
         fam ? fam.payment_ref : null]);
      paymentIds.push(cp.id);
    }

    await client.query(
      `UPDATE bank_statement_lines SET reconciled=true, reconciled_at=now() WHERE id=$1`,
      [line.id]);

    if (prop.kind === KIND.PAYER && (prop.evidence || {}).payer_link_id) {
      await client.query(
        `UPDATE payment_payer_links
            SET times_used = times_used + 1, last_used_at = now()
          WHERE id = $1`, [prop.evidence.payer_link_id]);
    }

    await client.query(`
      UPDATE payment_match_proposals
         SET status='applied', auto_applied=$2, decided_by=$3, decided_at=now(),
             payment_ids=$4::int[], allocation=$5::jsonb
       WHERE id=$1`,
      [proposalId, !!auto, actorId, paymentIds, JSON.stringify(plan.allocation)]);

    await client.query(`
      INSERT INTO reconciliation_audit (event_type, bank_line_id, invoice_id, actor_id, detail)
      VALUES ($1,$2,$3,$4,$5::jsonb)`,
      ['b325_apply', line.id, plan.allocation[0]?.invoice_id || null, actorId,
       JSON.stringify({ proposal_id: proposalId, kind: prop.kind,
                        certainty: prop.certainty, auto: !!auto,
                        allocated_pence: plan.allocated_pence,
                        credit_pence: plan.credit_pence,
                        payment_ids: paymentIds })]);

    await client.query('COMMIT');
    return {
      proposal_id: proposalId, status: 'applied', payment_ids: paymentIds,
      allocated_pence: plan.allocated_pence, credit_pence: plan.credit_pence,
      allocation: plan.allocation,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Reject a proposal. The bank line stays unreconciled and returns to the queue. */
async function rejectProposal(db, proposalId, { actorId = null, reason = null } = {}) {
  const { rows } = await db.query(`
    UPDATE payment_match_proposals
       SET status='rejected', decided_by=$2, decided_at=now(), decided_reason=$3
     WHERE id=$1 AND status='pending'
     RETURNING id, bank_line_id`, [proposalId, actorId, reason]);
  if (!rows.length) throw new Error('proposal not found or already decided');
  return { proposal_id: proposalId, status: 'rejected' };
}

/** 2026-10-28: may a remembered payer auto-apply? settings.payment_match_auto_apply_learned. */
async function learnedAutoApplyEnabled(db) {
  const { rows } = await db.query(
    `SELECT value FROM settings WHERE key = 'payment_match_auto_apply_learned'`);
  const v = String(rows[0]?.value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** Is auto-apply switched on? Off unless the setting is exactly '1'/'true'/'on'. */
async function autoApplyEnabled(db) {
  const { rows } = await db.query(
    `SELECT value FROM settings WHERE key = 'payment_match_auto_apply'`);
  const v = String(rows[0]?.value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

module.exports = {
  KIND, AUTO_APPLY_KINDS, FAMILY_KEY_SQL,
  ensureFamilyRef, ensureAllFamilyRefs, listFamilies,
  loadMatchContext, resolveLine, planAllocation,
  scanLines, applyProposal, rejectProposal, autoApplyEnabled,
  ymd,
};
