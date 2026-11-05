'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b342 — a family keeps their own contacts up to date, in the parents' app.
//
//   familyRouter  mounted at /welcome/family/api
//     GET  /state    parent / carer 1, parent / carer 2, emergency contacts — per group of children
//     GET  /prompt   which children still have no emergency contact (the home screen's standing prompt)
//     POST /save     write one group's details
//
// Sits under /welcome/<feature>/api/, so server-unified.js's _requireVerifiedParentSession has already run
// requireParentIdentity before a handler here runs. Handlers read the answer with parentEmailOf(req) and never a
// header. A body child id or contact id is NEVER trusted: ownership is re-read from parent_portal_access on every
// call, the group is recomputed server-side, and every contact id must be one of that group's own.
//
// WHAT "MANDATORY" MEANS HERE (Toby, 2026-09-21): asked for, not locked out. A family with no emergency contact is
// asked on the home screen and on Your account until they add one. Nothing else — diary, photos, invoices — is
// ever held behind it. (The save endpoint does refuse to take a family from one emergency contact to none.)
//
// WHAT A PARENT CANNOT DO HERE
//   · put anybody on the collection list. Ticking "can collect" records a PROPOSAL; the office confirms it
//     (children.js: POST /:id/contacts/:contactId/collect). Collection passwords, court orders and authorised
//     collectors themselves stay staff-only — none of them is readable or writable from this file.
//   · remove a parent or carer, or edit a contact who is shared with another family.
//   · give a brand-new address a login. See src/lib/family-signin.js.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const { getPool } = require('../db/pool');
const { parentEmailOf } = require('../lib/parent-identity');
const { recordAudit } = require('../utils/audit');
const FC = require('../lib/family-contacts');
const SI = require('../lib/family-signin');

const parentsOnly = (req, res, next) => (req._portal === 'parents' ? next() : next('router'));
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
const label = c => c.preferred_name || c.first_name || 'your child';

const familyRouter = express.Router();
familyRouter.use(parentsOnly, noStore, express.json({ limit: '16kb' }));

// Every child this address has an active login to, who is on roll. Ownership starts and ends here.
async function ownedChildren(db, email) {
  const { rows } = await db.query(
    `SELECT DISTINCT c.id, c.first_name, c.preferred_name
       FROM parent_portal_access pa
       JOIN children c ON c.id = pa.child_id
      WHERE lower(pa.email) = $1 AND pa.is_active = true
        AND COALESCE(c.is_active, true) = true
        AND c.enrolment_status IS DISTINCT FROM 'left'
        AND c.erased_at IS NULL
      ORDER BY c.id`, [email]);
  return rows;
}

const clean = v => (v == null ? '' : String(v).trim());
const phoneOk = v => { const d = FC.digits(v); return d.length >= 7 && d.length <= 15; };

function firstNames(kids, ids) {
  return kids.filter(k => ids.includes(k.id)).map(label);
}

// One group as the screen needs it. Nothing here is a secret from the family: it is their own details.
async function groupState(db, email, kids, ownedIds, g, loginSet) {
  const emerg = await FC.emergencyContactsFor(db, g.child_ids);
  const flaggedFor = new Set(emerg.flatMap(c => c.child_ids).filter(id => g.child_ids.includes(id)));
  const legacy = await FC.legacyEmergencyFromColumns(db, g.child_ids, [...flaggedFor]);

  const person = c => {
    if (!c) return null;
    const em = clean(c.primary_email).toLowerCase();
    return {
      contact_id: c.id, name: c.full_name || '', email: em, phone: c.primary_phone || '',
      relationship: FC.choiceForStored(c.relationship),
      editable: FC.isSubset(c.child_ids, ownedIds) || em === email,
      signin: !!em && loginSet.has(em), is_you: em === email,
    };
  };
  const ids = [g.parent1 && g.parent1.id, g.parent2 && g.parent2.id, ...emerg.map(e => e.id)].filter(Boolean);
  const others = await FC.otherPeopleFor(db, g.child_ids, ids);

  return {
    key: g.key,
    child_ids: g.child_ids,
    children: firstNames(kids, g.child_ids),
    parent1: person(g.parent1),
    parent2: person(g.parent2),
    emergency: [...emerg, ...legacy].map(e => ({
      id: e.id, name: e.name || '', relationship: e.relationship || '', phone: e.phone || '',
      collect: e.collect, legacy: e.legacy, editable: e.legacy || FC.isSubset(e.child_ids, ownedIds),
    })),
    others: others.map(o => ({ name: o.full_name || '', relationship: o.relationship || '' })),
    max_emergency: FC.MAX_EMERGENCY,
  };
}

async function loadState(db, email) {
  const kids = await ownedChildren(db, email);
  if (!kids.length) return { groups: [], pending: [], relationship_choices: FC.RELATIONSHIP_CHOICES.map(({ value, label: l }) => ({ value, label: l })) };
  const ownedIds = kids.map(k => k.id);
  const groups = await FC.familyGroups(db, ownedIds);
  const loginSet = await SI.loginAddressesFor(db, ownedIds);
  const out = [];
  for (const g of groups) out.push(await groupState(db, email, kids, ownedIds, g, loginSet));
  const pending = (await SI.pendingFor(db, ownedIds)).map(p => ({ from: p.from, to: p.to, since: p.since }));
  return {
    you: email,
    groups: out, pending,
    relationship_choices: FC.RELATIONSHIP_CHOICES.map(({ value, label: l }) => ({ value, label: l })),
  };
}

// The address that just signed in has proved itself; retire whatever it replaced. Runs on every /state and /prompt —
// every app open — and is one indexed SELECT when nothing is pending.
async function settle(req, db, email) {
  let settled = [];
  try { settled = await SI.settleFor(db, email); } catch (e) { console.error('[family] settle:', e.message); }
  for (const s of settled) {
    recordAudit({ req, action: 'update', entity_type: 'signin_email', entity_id: String(s.child_ids[0]),
      actor_type: 'parent', actor_email: email,
      meta: { child_ids: s.child_ids, summary: 'Sign-in address change completed — the old address was retired',
              from: SI.mask(s.from), to: SI.mask(s.to) } });
  }
  if (settled.length) {
    try { require('../lib/cf-allowlist').syncCFAllowlist().catch(e => console.error('[family] CF sync:', e.message)); } catch (_) { /* best effort */ }
  }
  return settled;
}

const notReady = (res, e) => {
  if (e && e.code === 'B342_NOT_MIGRATED') return res.status(503).json({ error: 'not_ready' });
  return null;
};

// ── GET /state ───────────────────────────────────────────────────────────────
familyRouter.get('/state', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    await settle(req, db, email);
    res.json(await loadState(db, email));
  } catch (e) {
    if (notReady(res, e)) return;
    console.error('[family] state:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /prompt ──────────────────────────────────────────────────────────────
// Tiny on purpose: the home screen calls it on every open. First names only.
familyRouter.get('/prompt', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    await settle(req, db, email);
    const kids = await ownedChildren(db, email);
    const missing = await FC.childrenMissingEmergency(db, kids.map(k => k.id));
    res.json({ needs_emergency: missing.length > 0, children: firstNames(kids, missing), href: '/welcome/details#family' });
  } catch (e) {
    // A prompt that cannot be worked out is no prompt — never an error on the home screen.
    if (e && e.code === 'B342_NOT_MIGRATED') return res.json({ needs_emergency: false, children: [], href: '/welcome/details#family' });
    console.error('[family] prompt:', e.message);
    res.json({ needs_emergency: false, children: [], href: '/welcome/details#family' });
  }
});

// ── POST /save ───────────────────────────────────────────────────────────────
class Refusal extends Error {
  constructor(status, error, field) { super(error); this.status = status; this.error = error; this.field = field || null; }
}

function readParent(slot, raw, cur, ownedIds, email) {
  if (raw === undefined || raw === null) return null;
  const name = clean(raw.name), em = clean(raw.email).toLowerCase(), phone = clean(raw.phone);
  const rel = clean(raw.relationship).toLowerCase();
  const field = `parent${slot}`;
  const blank = !name && !em && !phone;
  if (blank && !cur) return { skip: true };
  if (blank && cur) throw new Refusal(400, 'To remove a parent or carer, please ask the office.', field);
  if (!name) throw new Refusal(400, `Please add a name for parent / carer ${slot}.`, field);
  if (name.length > 200) throw new Refusal(400, 'That name is too long.', field);
  if (!em && !phone) throw new Refusal(400, `Please add a phone number or an email address for parent / carer ${slot}.`, field);
  if (em && (!SI.EMAIL_RE.test(em) || em.length > 320)) throw new Refusal(400, 'That email address does not look right.', field);
  if (phone && !phoneOk(phone)) throw new Refusal(400, 'That phone number does not look right.', field);
  if (rel && !FC.storedForChoice(rel)) throw new Refusal(400, 'Please choose mother, father, carer or other.', field);
  if (cur) {
    const mine = FC.isSubset(cur.child_ids, ownedIds) || clean(cur.primary_email).toLowerCase() === email;
    if (!mine) throw new Refusal(409, 'These details are shared with another family, so we can not change them here. Please ask the office.', field);
    // Clearing the address a person signs in with would strand them; anything else can be cleared.
    if (clean(cur.primary_email) && !em) throw new Refusal(400, 'Please keep an email address for this person — to remove one, ask the office.', field);
  }
  return { name, email: em, phone, relationship: rel };
}

function readEmergency(list) {
  if (list === undefined) return null;
  if (!Array.isArray(list)) throw new Refusal(400, 'Emergency contacts were not understood.', 'emergency');
  if (list.length < 1) throw new Refusal(400, 'Please keep at least one emergency contact — someone we can ring if we can not reach you.', 'emergency');
  if (list.length > FC.MAX_EMERGENCY) throw new Refusal(400, `You can add up to ${FC.MAX_EMERGENCY} emergency contacts.`, 'emergency');
  const seen = new Set();
  return list.map((raw, i) => {
    const name = clean(raw && raw.name), rel = clean(raw && raw.relationship), phone = clean(raw && raw.phone);
    const field = `emergency.${i}`;
    if (!name) throw new Refusal(400, 'Please add a name for each emergency contact.', field);
    if (name.length > 200) throw new Refusal(400, 'That name is too long.', field);
    if (!rel) throw new Refusal(400, 'Please say how each emergency contact is related to your child.', field);
    if (rel.length > 60) throw new Refusal(400, 'That relationship is too long.', field);
    if (!phoneOk(phone)) throw new Refusal(400, 'Please add a phone number we can ring for each emergency contact.', field);
    const d = FC.digits(phone);
    if (seen.has(d)) throw new Refusal(400, 'The same phone number is listed twice.', field);
    seen.add(d);
    const id = raw.id == null || raw.id === '' ? null : parseInt(raw.id, 10);
    if (raw.id != null && raw.id !== '' && !Number.isInteger(id)) throw new Refusal(400, 'Emergency contacts were not understood.', field);
    return { id, name, relationship: rel, phone, collect: raw.collect === true };
  });
}

familyRouter.post('/save', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const b = req.body || {};
  const childIds = [...new Set((Array.isArray(b.child_ids) ? b.child_ids : []).map(Number).filter(Number.isInteger))].sort((a, c) => a - c);
  if (!childIds.length) return res.status(400).json({ error: 'child_ids required' });

  const pool = getPool();
  const client = await pool.connect();
  let began = false;
  const audits = [], notes = { p1: null, p2: null };
  let proposed = [], signinSummary = null;
  try {
    // 🔒 ownership — re-read, never trusted from the body
    const kids = await ownedChildren(client, email);
    const ownedIds = kids.map(k => k.id);
    if (!childIds.every(id => ownedIds.includes(id))) return res.status(403).json({ error: 'Not your child' });
    const groups = await FC.familyGroups(client, ownedIds);
    const g = groups.find(x => FC.sameSet(x.child_ids, childIds));
    if (!g) return res.status(409).json({ error: 'Your family details have changed since this page loaded — please reload it.', reason: 'stale' });

    // ── validate everything BEFORE the first write ────────────────────────────
    const p1 = readParent(1, b.parent1, g.parent1, ownedIds, email);
    const p2 = readParent(2, b.parent2, g.parent2, ownedIds, email);
    const emergency = readEmergency(b.emergency);

    // An emergency contact has to be somebody else — otherwise "at least one" is satisfied by copying a
    // parent's own number and the point of asking (a person to ring when the parents cannot be reached) is lost.
    if (emergency) {
      const parentPhones = new Set([
        p1 && !p1.skip ? FC.digits(p1.phone) : FC.digits(g.parent1 && g.parent1.primary_phone),
        p2 && !p2.skip ? FC.digits(p2.phone) : FC.digits(g.parent2 && g.parent2.primary_phone),
      ].filter(Boolean));
      emergency.forEach((e, i) => {
        if (parentPhones.has(FC.digits(e.phone))) {
          throw new Refusal(400, 'An emergency contact needs to be someone other than you or the other parent / carer.', `emergency.${i}`);
        }
      });
      // The family may never go from having one to having none through this screen.
      const have = await FC.emergencyContactsFor(client, g.child_ids);
      const legacy = await FC.legacyEmergencyFromColumns(client, g.child_ids, have.flatMap(c => c.child_ids));
      if (have.length + legacy.length > 0 && emergency.length === 0) {
        throw new Refusal(400, 'Please keep at least one emergency contact.', 'emergency');
      }
    }
    // Email uniqueness across the whole store, checked up front so the message is ours and not a constraint name.
    // The one exception is adopting: a sibling's parent 2 may exist as a contact that simply was not linked to this
    // group's children yet — that is the same person, and linking beats refusing (or creating a second copy).
    const adopt = {};
    for (const [slot, p, cur] of [[1, p1, g.parent1], [2, p2, g.parent2]]) {
      if (!p || p.skip || !p.email) continue;
      const clash = await client.query(
        'SELECT id, child_ids, lower(primary_email) AS em FROM contacts WHERE lower(primary_email) = $1 AND id <> $2 LIMIT 1',
        [p.email, cur ? cur.id : 0]);
      if (!clash.rows.length) continue;
      const o = clash.rows[0];
      const theirs = o.child_ids.some(id => ownedIds.includes(id)) && (FC.isSubset(o.child_ids, ownedIds) || o.em === email);
      if (!cur && theirs) adopt[slot] = o.id;
      else throw new Refusal(409, 'We could not save that email address. Please check it, or call the office.', `parent${slot}`);
    }

    // ── write ─────────────────────────────────────────────────────────────────
    await client.query('BEGIN'); began = true;
    await FC.pinParentSlots(client, g.child_ids);

    const changedFields = [];
    for (const [slot, p, cur] of [[1, p1, g.parent1], [2, p2, g.parent2]]) {
      if (!p || p.skip) continue;
      const oldEmail = cur ? clean(cur.primary_email).toLowerCase() : '';

      const r = await FC.upsertParent(client, { childIds: g.child_ids, slot, name: p.name, email: p.email, phone: p.phone,
        relationship: p.relationship, adoptId: adopt[slot] || null });
      if (r.created) changedFields.push(`parent ${slot} added`);
      else {
        if (clean(r.before.name) !== clean(r.after.name)) changedFields.push(`parent ${slot} name`);
        if (clean(r.before.email).toLowerCase() !== clean(r.after.email).toLowerCase()) changedFields.push(`parent ${slot} email`);
        if (clean(r.before.phone) !== clean(r.after.phone)) changedFields.push(`parent ${slot} phone`);
        if (r.before.relationship !== r.after.relationship) changedFields.push(`parent ${slot} relationship`);
      }

      // The address changed. Is it somebody's login?
      const newEmail = clean(r.after.email).toLowerCase();
      if (newEmail !== oldEmail) {
        if (!oldEmail) {
          notes[`p${slot}`] = { kind: 'new_address', to: newEmail };
        } else {
          const plan = await SI.planChange(client, { childIds: ownedIds, oldEmail, newEmail });
          if (plan.kind === 'signin_switch') {
            const done = await SI.applyChange(client, { plan, newEmail });
            notes[`p${slot}`] = { kind: 'signin_switch', from: oldEmail, to: newEmail, corrected: done.corrected_before_use };
            signinSummary = { from: oldEmail, to: newEmail, child_ids: done.child_ids };
          } else {
            notes[`p${slot}`] = { kind: 'contact_only', to: newEmail };
          }
        }
      }
    }

    let em = null;
    if (emergency) {
      em = await FC.saveEmergencyContacts(client, { childIds: g.child_ids, ownedIds, list: emergency });
      proposed = em.proposed;
    }
    await FC.syncChildColumns(client, g.child_ids);
    await client.query('COMMIT'); began = false;

    // ── record it (after commit, fire-and-forget: a failed audit never fails the save) ────────────────────
    const entity = String(g.child_ids[0]);
    const base = { req, actor_type: 'parent', actor_email: email, entity_id: entity };
    if (changedFields.length) {
      recordAudit({ ...base, action: 'update', entity_type: 'family_details',
        meta: { child_ids: g.child_ids, changed: changedFields, summary: `Family changed: ${changedFields.join(', ')}` } });
    }
    if (em && (em.added.length || em.updated.length || em.removed.length)) {
      const parts = [em.added.length && `${em.added.length} added`, em.updated.length && `${em.updated.length} changed`, em.removed.length && `${em.removed.length} removed`].filter(Boolean);
      recordAudit({ ...base, action: 'update', entity_type: 'emergency_contact',
        meta: { child_ids: g.child_ids, added: em.added.length, updated: em.updated.length, removed: em.removed.length,
                summary: `Emergency contacts ${parts.join(', ')}` } });
    }
    if (signinSummary) {
      recordAudit({ ...base, action: 'update', entity_type: 'signin_email',
        meta: { child_ids: g.child_ids, from: SI.mask(signinSummary.from), to: SI.mask(signinSummary.to),
                summary: 'Sign-in address change requested — the old address keeps working until the new one is used' } });
      try { require('../lib/cf-allowlist').syncCFAllowlist().catch(e => console.error('[family] CF sync:', e.message)); } catch (_) { /* best effort */ }
    }
    if (proposed.length) {
      // Tell the office INSIDE Wren. Names nobody: the notification links to the profile, where the access checks live.
      try {
        require('../services/notification-dispatcher').notify('parent_change_request', 'all-managers', null,
          'A family has asked for someone to be able to collect',
          'Proposed in the parents app. Open the child profile in Roost to confirm or decline — nobody can collect until you do.',
          { relatedTable: 'children', relatedId: g.child_ids[0], link: `/child-profile.html?id=${g.child_ids[0]}#family` });
      } catch (e) { console.error('[family] notify:', e.message); }
      recordAudit({ ...base, action: 'create', entity_type: 'collection_proposal',
        meta: { child_ids: g.child_ids, proposals: proposed.length, summary: 'Family proposed someone to collect (awaiting the office)' } });
    }

    const state = await loadState(pool, email);
    res.json({ ok: true, state, notes, proposed: proposed.length });
  } catch (e) {
    if (began) { try { await client.query('ROLLBACK'); } catch (_) { /* connection gone */ } }
    if (e instanceof Refusal) return res.status(e.status).json({ error: e.error, field: e.field });
    if (e && e.code === 'NOT_YOURS') return res.status(403).json({ error: 'Not your contact' });
    if (e && e.code === 'SHARED_CONTACT') return res.status(409).json({ error: 'This contact is shared with another family, so we can not change it here. Please ask the office.' });
    if (e && e.code === '23505') return res.status(409).json({ error: 'We could not save that. Please check the phone number and email address, or call the office.' });
    if (notReady(res, e)) return;
    console.error('[family] save:', e.message);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

module.exports = { familyRouter };
