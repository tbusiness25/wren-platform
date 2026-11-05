'use strict';
/**
 * parents-group.js — b239 collector. The Google group vs the children register.
 *
 * Reads the last stored reconciliation (ladn.parents_group_reconciliation,
 * written by scripts/b239-parents-group-reconcile.js and by the nightly
 * allowlist sync). It does NOT call Google itself: the board refreshes often,
 * the Directory API does not want to be polled that hard, and rule 2 says a
 * collector that cannot look must resolve nothing — which a rate-limited API
 * call would trigger at random.
 *
 * Three findings, each with a different owner and a different urgency:
 *
 *   leavers still in the group   RED. Families whose relationship with the
 *                                nursery ended are still receiving its email.
 *                                That is processing without a basis, not mess.
 *   enrolled parents missing     RED at any count. A parent of a child who is
 *                                here today is getting no nursery email and has
 *                                no way to know that.
 *   addresses Wren has never seen AMBER. Not necessarily wrong — a grandparent,
 *                                an old staff address — but nobody has ever
 *                                looked, and the group is a mailing list for
 *                                children's information.
 *
 * Enquiry and waiting-list parents in the group are NOT reported. They are there
 * on purpose (src/lib/email-allowlist.js includes them so staff can reply to
 * prospective families) and flagging them would be the cry-wolf failure the
 * crons collector documents.
 *
 * Counts, ids and pseudonymous refs only — the evidence blob included here is
 * rendered on Roost, and it must stay free of addresses.
 */
const { getPool } = require('../../db/pool');
const { latest } = require('../../lib/parents-group-reconcile');

const SOURCE = 'parents_group';
const STALE_AFTER_HOURS = 48;   // the sync runs daily; two misses is a finding

module.exports = {
  name: 'parents-group',
  owns: [SOURCE],

  async collect() {
    const db = getPool();
    let row;
    try {
      row = await latest(db);
    } catch (e) {
      return { ok: false, items: [], note: `could not read reconciliation: ${e.message}` };
    }

    // Never run. Not "nothing wrong" — nothing looked. ok:false so the refresh
    // resolves none of this source's existing rows.
    if (!row) {
      return { ok: false, items: [], note: 'no reconciliation has ever run — see scripts/b239-parents-group-reconcile.js' };
    }

    const ageH = (Date.now() - new Date(row.ran_at).getTime()) / 3600000;
    const counts = row.counts || {};
    const items = [];

    // A stale reconciliation is itself the finding, and its numbers are not
    // trustworthy enough to raise the others from.
    if (ageH > STALE_AFTER_HOURS) {
      items.push({
        source: SOURCE,
        source_key: 'reconciliation_stale',
        rag: 'amber',
        title: `Parent group reconciliation is ${Math.floor(ageH / 24)} days old`,
        detail: `Last run ${new Date(row.ran_at).toISOString().slice(0, 16).replace('T', ' ')}. `
              + 'The daily allowlist sync should refresh it; if it has not, the sync is failing.',
        why: 'The numbers below are from that run, so they are as old as it is.',
        category: 'compliance',
        effort_minutes: 5,
        action_url: '/settings.html#parents-group',
        evidence: { ran_at: row.ran_at, age_hours: Math.round(ageH) },
        sort_hint: 40,
      });
      return { ok: true, items, note: `stale by ${Math.round(ageH)}h — downstream findings suppressed` };
    }

    if (!row.ok) {
      return { ok: false, items, note: `last reconciliation was partial: ${row.note || 'see the row'}` };
    }

    const leavers = Number(counts.leavers_still_in_group || 0);
    if (leavers > 0) {
      items.push({
        source: SOURCE,
        source_key: 'leavers_in_group',
        rag: 'red',
        title: `${leavers} former ${leavers === 1 ? 'family is' : 'families are'} still on the parents mailing group`,
        detail: `${leavers} address${leavers === 1 ? '' : 'es'} in ${row.group_email} belong to children who have left. `
              + 'They are still receiving nursery email.',
        why: 'Sending a former family the newsletter is processing their data after the basis for it ended. '
           + 'The group is synced from the allowlist, which does not remove leavers on its own.',
        category: 'compliance',
        effort_minutes: 15,
        action_url: '/settings.html#parents-group',
        evidence: {
          count: leavers,
          // refs and Wren ids only — see the file header.
          refs: (row.orphans || []).filter((o) => o.classification === 'leaver').slice(0, 25),
          ran_at: row.ran_at,
        },
        sort_hint: 90,
      });
    }

    const missing = Number(counts.missing || 0);
    if (missing > 0) {
      items.push({
        source: SOURCE,
        source_key: 'enrolled_missing_from_group',
        rag: 'red',
        title: `${missing} parent${missing === 1 ? '' : 's'} of enrolled children get no nursery email`,
        detail: `${missing} address${missing === 1 ? '' : 'es'} on the current register ${missing === 1 ? 'is' : 'are'} not in ${row.group_email}.`,
        why: 'They will not receive the newsletter or any group mail, and nothing tells them or us — '
           + 'it surfaces as "I never got that" weeks later.',
        category: 'comms',
        effort_minutes: 15,
        action_url: '/settings.html#parents-group',
        evidence: { count: missing, refs: (row.missing || []).slice(0, 25), ran_at: row.ran_at },
        sort_hint: 88,
      });
    }

    const unknown = Number(counts.unknown_to_wren || 0);
    if (unknown > 0) {
      items.push({
        source: SOURCE,
        source_key: 'unknown_addresses_in_group',
        rag: 'amber',
        title: `${unknown} address${unknown === 1 ? '' : 'es'} on the parents group ${unknown === 1 ? 'is' : 'are'} not known to Wren`,
        detail: 'Not on the register, not an enquiry, not on the waiting list, not a leaver.',
        why: 'The group carries information about children. An address nobody can account for should be '
           + 'accounted for — it may be a grandparent added by hand, or an old staff address nobody removed.',
        category: 'compliance',
        effort_minutes: 20,
        action_url: '/settings.html#parents-group',
        evidence: {
          count: unknown,
          refs: (row.orphans || []).filter((o) => o.classification === 'unknown_to_wren').slice(0, 25),
          ran_at: row.ran_at,
        },
        sort_hint: 55,
      });
    }

    return {
      ok: true,
      items,
      note: `group=${counts.group_members} enrolled=${counts.enrolled_parent_addresses} `
          + `orphans=${counts.orphans} missing=${counts.missing}`,
    };
  },
};
