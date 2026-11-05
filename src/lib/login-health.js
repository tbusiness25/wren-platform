// login-20261023 — "Login health": can every member of staff and every parent
// actually get in on Monday (EyLog ends Mon 26 Oct 2026)?
//
// Toby: "make sure all staff are set up properly, and parents."
//
// One check per thing that has to be true for a person to reach the screen
// they need and get past it:
//
//   staff   — a PIN (every portal uses it), an email (HR + Roost ask for it),
//             that email on Cloudflare's list for hr. (and admin. for Roost
//             people), the authenticator app for roles that must have 2FA, and
//             not locked out. Wren ID is reported but OPTIONAL — PIN sign-in
//             is the primary way in and stays so.
//   parents — every active parent_portal_access row: a usable email, and that
//             email on Cloudflare's parents list (Cloudflare IS the parents'
//             front door), plus whether they have ever signed in.
//
// READ-ONLY. Nothing here changes a PIN, a 2FA secret, an Access policy or
// sends anything. The fixes live on existing, human-clicked endpoints.
//
// Used by src/routes/login-health.js (the Roost page) and
// scripts/login-health-audit.js (the counts-and-ids audit for the notes).

const cfAllow = require('./cf-allowlist');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CF_TTL_MS = 5 * 60 * 1000;

let _cf = { at: 0, data: null };

function baseDomain() {
  const admin = (process.env.ADMIN_DOMAIN || 'admin.example-nursery.co.uk').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return admin.replace(/^admin\./, '');
}

function summarisePolicies(policies) {
  const out = { emails: new Set(), domains: new Set(), ipOnly: new Set(), everyone: false };
  for (const p of policies || []) {
    if (p.decision !== 'allow') continue;
    const needsIp = (p.require || []).some((r) => r.ip);
    for (const r of p.include || []) {
      if (r.email && r.email.email) {
        const e = String(r.email.email).toLowerCase().trim();
        (needsIp ? out.ipOnly : out.emails).add(e);
      } else if (r.email_domain && r.email_domain.domain) {
        out.domains.add(String(r.email_domain.domain).toLowerCase());
      } else if (r.everyone) {
        out.everyone = true;
      }
    }
  }
  return out;
}

/**
 * The live Cloudflare Access lists for the hr., admin. and parents. apps.
 * GET only. Cached 5 minutes. { ok:false, reason } when it cannot be read —
 * the page then says "couldn't check Cloudflare", never "not on the list".
 */
async function readAccessLists({ fresh = false } = {}) {
  if (!fresh && _cf.data && Date.now() - _cf.at < CF_TTL_MS) return _cf.data;
  let data;
  try {
    const auth = await cfAllow.cfAuthHeaders();
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAllow.CF_ACCOUNT}/access/apps?per_page=100`,
      { headers: auth, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    if (!j || !j.success) throw new Error('cloudflare_error');
    const base = baseDomain();
    const want = { hr: `hr.${base}`, admin: `admin.${base}`, parents: `parents.${base}` };
    const lists = {};
    for (const [k, host] of Object.entries(want)) {
      const app = (j.result || []).find((a) => String(a.domain || '').toLowerCase() === host);
      lists[k] = app ? summarisePolicies(app.policies) : null;
    }
    data = { ok: true, fetched_at: new Date().toISOString(), lists };
  } catch (e) {
    data = { ok: false, reason: /credential/i.test(e.message) ? 'no_cloudflare_credentials' : 'cloudflare_unreachable', lists: {} };
  }
  _cf = { at: Date.now(), data };
  return data;
}

/** 'yes' | 'ip_only' | 'no' | null (could not check) */
function onList(list, email) {
  if (!list) return null;
  const e = String(email || '').toLowerCase().trim();
  if (!e) return 'no';
  if (list.everyone || list.emails.has(e)) return 'yes';
  const dom = e.split('@')[1];
  if (dom && list.domains.has(dom)) return 'yes';
  if (list.ipOnly.has(e)) return 'ip_only';
  return 'no';
}

const totpRoles = (db) => require('./totp-policy').getTotpRoles(db);

// The one reader of settings.roost_admin_staff_ids. null = unconfigured (demo editions: not restricted).
async function roostIds() {
  const { ids, configured } = await require('./roost-allowlist').getRoostAllowlist();
  return configured && ids ? new Set(ids.map(Number)) : null;
}

async function optional(db, sql, params) {
  try { return (await db.query(sql, params)).rows; }
  catch (e) { if (e.code === '42P01' || e.code === '42703') return []; throw e; }
}

// login-20261023 — Toby's four tiers, read off the role (see migrations/2026-10-23-login-tiers.sql).
function tierOf(s) {
  if (Number(s.id) === 1 || ['admin', 'owner', 'manager', 'accountant'].includes(s.role)) return 'Full access';
  if (['room_leader', 'deputy_manager'].includes(s.role)) return 'Leadership';
  if (s.role === 'apprentice') return 'Apprentice — learning journeys only';
  if (s.role === 'cook') return 'Kitchen';
  return 'Team';
}

function worst(checks) {
  if (checks.some((c) => c.state === 'bad')) return 'blocked';
  if (checks.some((c) => c.state === 'warn')) return 'attention';
  return 'ready';
}

function fmtTime(d) {
  return new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
}

// ── Staff ────────────────────────────────────────────────────────────────────
async function staffHealth(db, cf) {
  const base = baseDomain();
  const [roles, roost] = [await totpRoles(db), await roostIds()];
  const { rows: staff } = await db.query(
    `SELECT id, first_name, last_name, preferred_name, role, job_title, lower(trim(email)) AS email,
            (pin_hash IS NOT NULL) AS has_pin, COALESCE(pin_length, 4) AS pin_length,
            totp_verified, last_login_at
       FROM staff WHERE is_active = true AND NOT COALESCE(is_demo, false)
      ORDER BY lower(first_name), lower(last_name), id`);
  const locks = new Map((await optional(db,
    `SELECT account_key, locked_until FROM account_lockouts
      WHERE account_type='staff' AND locked_until > now()`)).map((r) => [String(r.account_key), r.locked_until]));
  const wid = new Map((await optional(db,
    `SELECT s.id,
            (SELECT login_count FROM staff_google_identities g
              WHERE g.provider='authentik' AND g.staff_id=s.id AND NOT COALESCE(g.revoked,false) LIMIT 1) AS logins,
            (SELECT status FROM staff_enrolment_invites e
              WHERE e.provider='authentik' AND e.staff_id=s.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS invite_status
       FROM staff s WHERE s.is_active = true AND NOT COALESCE(s.is_demo, false)`)).map((r) => [r.id, r]));
  // What the 07:17 sync WILL put on each list — so "not there yet" can be told apart from "never will be".
  let expHr = null, expRoost = null;
  try { expHr = new Set(await cfAllow.buildStaffAllowlist(db)); expRoost = new Set(await cfAllow.buildRoostAllowlist(db)); } catch (_) { /* unknown */ }
  const emailCount = staff.reduce((m, s) => { if (s.email) m[s.email] = (m[s.email] || 0) + 1; return m; }, {});

  return staff.map((s) => {
    const checks = [];
    const isAccountant = s.role === 'accountant';
    const isOwner = Number(s.id) === 1;
    const usesRoost = roost ? roost.has(Number(s.id)) : ['manager', 'deputy_manager', 'admin'].includes(s.role);
    const portals = isAccountant ? ['Roost (Wren ID)'] : ['EY tablets', 'Staff HR'].concat(usesRoost ? ['Roost'] : []);

    // 1. PIN — the way in on every portal.
    if (isAccountant) {
      checks.push({ key: 'pin', state: 'info', text: 'Signs in with Wren ID only — PIN sign-in is switched off for this role.' });
    } else if (s.has_pin) {
      checks.push({ key: 'pin', state: 'ok', text: `PIN set (${s.pin_length} digits).` });
    } else {
      checks.push({ key: 'pin', state: 'bad', text: 'No PIN — cannot sign in anywhere.', fix: isOwner ? null : 'set_pin' });
    }

    // 2. Email — HR and Roost ask for it, Cloudflare checks it.
    if (!s.email || !EMAIL_RE.test(s.email)) {
      checks.push({ key: 'email', state: 'bad', text: 'No usable email — cannot use Staff HR or Roost.', fix: 'edit_profile' });
    } else if (emailCount[s.email] > 1) {
      checks.push({ key: 'email', state: 'bad', text: 'Shares an email with another active member of staff — email sign-in refuses an ambiguous address.', fix: 'edit_profile' });
    } else {
      checks.push({ key: 'email', state: 'ok', text: 'Email on file.' });
    }

    // 3. Cloudflare in front of hr. — staff phones.
    if (!isAccountant && s.email) {
      const v = cf.ok ? onList(cf.lists.hr, s.email) : null;
      if (v === 'yes') checks.push({ key: 'cf_hr', state: 'ok', text: `Cloudflare lets this email into hr.${base}.` });
      else if (v === null) checks.push({ key: 'cf_hr', state: 'info', text: 'Could not check Cloudflare just now.' });
      else if (expHr && expHr.has(s.email)) checks.push({ key: 'cf_hr', state: 'warn', text: `Not on Cloudflare’s HR list yet — it is added at the next daily sync (07:17), or press “Update Cloudflare now”.`, fix: 'sync_access' });
      else checks.push({ key: 'cf_hr', state: 'bad', text: `Cloudflare will turn this email away at hr.${base}, and Wren’s list would not add it — check the email on their record.`, fix: 'edit_profile' });
    }

    // 4. Cloudflare in front of admin. — Roost people only (and the accountant, whose only door is Roost).
    if ((usesRoost || isAccountant) && s.email) {
      const v = cf.ok ? onList(cf.lists.admin, s.email) : null;
      if (v === 'yes') checks.push({ key: 'cf_admin', state: 'ok', text: `Cloudflare lets this email into Roost (admin.${base}).` });
      else if (v === 'ip_only') checks.push({ key: 'cf_admin', state: 'warn', text: 'Cloudflare lets this email into Roost only from one network (the work PC) — not from home or a phone.' });
      else if (v === null) checks.push({ key: 'cf_admin', state: 'info', text: 'Could not check Cloudflare just now.' });
      else if (expRoost && expRoost.has(s.email)) checks.push({ key: 'cf_admin', state: 'warn', text: 'Not on Cloudflare’s Roost list yet — it is added at the next daily sync, or press “Update Cloudflare now”.', fix: 'sync_access' });
      else checks.push({ key: 'cf_admin', state: 'bad', text: 'On the Roost allowlist in Wren, but Cloudflare will turn this email away at Roost.', fix: 'edit_profile' });
    }

    // 5. Two-step sign-in (authenticator app) — mandatory for these roles on HR and Roost (b491).
    if (roles.includes(s.role)) {
      if (s.totp_verified === true) checks.push({ key: 'totp', state: 'ok', text: 'Authenticator app set up (asked for on HR and Roost).' });
      else checks.push({ key: 'totp', state: 'warn', text: 'Authenticator app not set up yet — they will be walked through it at their next HR or Roost sign-in (needs their phone, about 2 minutes).' });
    }

    // 6. Locked out.
    const lockedUntil = locks.get(String(s.id));
    if (lockedUntil) checks.push({ key: 'locked', state: 'bad', text: `Locked out after too many wrong tries, until ${fmtTime(lockedUntil)}.`, fix: 'unlock' });

    // 7. Wren ID — optional, reported for information.
    const w = wid.get(s.id) || {};
    if (isAccountant) {
      checks.push({ key: 'wren_id', state: Number(w.logins) > 0 || w.invite_status === 'enrolled' ? 'ok' : 'bad',
        text: Number(w.logins) > 0 ? 'Wren ID set up and used.' : w.invite_status === 'enrolled' ? 'Wren ID password set.' : 'Needs a Wren ID — it is the only way in for this role.', fix: 'wren_id_invite' });
    } else {
      const t = Number(w.logins) > 0 ? `Wren ID (optional): used ${w.logins} time${Number(w.logins) === 1 ? '' : 's'}.`
        : w.invite_status === 'enrolled' ? 'Wren ID (optional): password set, not used yet — PIN sign-in is the normal way in.'
          : (w.invite_status === 'sent' || w.invite_status === 'opened') ? 'Wren ID (optional): set-up link sent, not finished.'
            : 'Wren ID (optional): not set up. Not needed to sign in.';
      checks.push({ key: 'wren_id', state: 'info', text: t, fix: 'wren_id_invite' });
    }

    return {
      id: s.id,
      name: `${s.preferred_name || s.first_name || ''} ${s.last_name || ''}`.trim(),
      role: s.role,
      job_title: s.job_title || null,
      tier: tierOf(s),
      email: s.email || null,
      portals,
      protected: isOwner,
      last_login_at: s.last_login_at || null,
      locked_until: lockedUntil || null,
      status: worst(checks),
      checks,
    };
  });
}

// ── Parents ──────────────────────────────────────────────────────────────────
async function parentHealth(db, cf) {
  const base = baseDomain();
  const rows = await db.query(
    `SELECT pa.id, pa.child_id, lower(trim(pa.email)) AS email, COALESCE(pa.access_level,'full') AS access_level,
            pa.created_at, c.first_name AS child_first, c.last_name AS child_last,
            c.is_active AS child_active, c.status AS child_status
       FROM parent_portal_access pa
       JOIN children c ON c.id = pa.child_id
      WHERE pa.is_active = true
      ORDER BY c.is_active DESC, lower(c.first_name), pa.id`).then((r) => r.rows);
  const keepsake = new Set((await optional(db,
    `SELECT DISTINCT child_id FROM leavers_gift_packages
      WHERE status='active' AND (expires_at IS NULL OR expires_at > now())`)).map((r) => r.child_id));
  const signedIn = new Set((await optional(db,
    `SELECT DISTINCT lower(trim(parent_email)) AS e FROM refresh_tokens WHERE parent_email IS NOT NULL`)).map((r) => r.e));
  let expected = null;
  try { expected = new Set(await cfAllow.buildAllowlist(db)); } catch (_) { expected = null; }

  const out = rows.map((p) => {
    const kind = p.child_active ? 'current'
      : (p.access_level === 'enquiry' && p.child_status === 'enquiry') ? 'enquiry'
        : keepsake.has(p.child_id) ? 'keepsake' : 'leaver';
    const checks = [];
    const validEmail = p.email && EMAIL_RE.test(p.email);
    if (!validEmail) checks.push({ key: 'email', state: kind === 'leaver' ? 'info' : 'bad', text: 'No usable email on this access row.', fix: 'edit_access' });

    if (kind === 'leaver') {
      checks.push({ key: 'kind', state: 'info', text: 'Child has left and there is no live memory book — no access expected. This row could be retired.' });
    } else if (validEmail) {
      const v = cf.ok ? onList(cf.lists.parents, p.email) : null;
      // 2026-10-29 — parents sign in with a Wren email code; Cloudflare's parents list no longer admits anyone.
      if (!cfAllow.parentsCfSyncOn()) checks.push({ key: 'cf_parents', state: 'ok', text: 'Signs in with an email code from Wren — this email gets a code.' });
      else if (v === 'yes') checks.push({ key: 'cf_parents', state: 'ok', text: `Cloudflare lets this email into parents.${base}.` });
      else if (v === null) checks.push({ key: 'cf_parents', state: 'info', text: 'Could not check Cloudflare just now.' });
      else if (expected && expected.has(p.email)) checks.push({ key: 'cf_parents', state: 'warn', text: 'Not on Cloudflare’s list yet — it is added at the next daily sync (07:17), or press “Update Cloudflare now”.', fix: 'sync_access' });
      else checks.push({ key: 'cf_parents', state: 'bad', text: 'Cloudflare will turn this email away, and Wren’s own list would not add it — check the child’s record.', fix: 'edit_access' });
      checks.push(signedIn.has(p.email)
        ? { key: 'used', state: 'ok', text: 'Has signed in to the parents app before.' }
        : { key: 'used', state: 'info', text: 'Has not signed in to the parents app yet.' });
    }

    return {
      id: p.id,
      child_id: p.child_id,
      child: `${p.child_first || ''} ${p.child_last || ''}`.trim(),
      email: p.email || null,
      kind,
      status: kind === 'leaver' ? 'n/a' : worst(checks),
      checks,
    };
  });

  // Children on roll that no parent can sign in for at all.
  const unreachable = (await db.query(
    `SELECT c.id FROM children c
      WHERE c.is_active = true
        AND COALESCE(trim(c.parent_1_email),'') = '' AND COALESCE(trim(c.parent_2_email),'') = ''
        AND NOT EXISTS (SELECT 1 FROM parent_portal_access pa WHERE pa.child_id = c.id AND pa.is_active = true
                          AND COALESCE(trim(pa.email),'') <> '')`)).rows.map((r) => r.id);
  return { rows: out, children_with_no_parent_login: unreachable };
}

function countBy(list, f) { return list.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {}); }

async function loginHealth(db, { fresh = false } = {}) {
  const cf = await readAccessLists({ fresh });
  const staff = await staffHealth(db, cf);
  const parents = await parentHealth(db, cf);
  return {
    generated_at: new Date().toISOString(),
    cloudflare: { ok: cf.ok, reason: cf.reason || null, fetched_at: cf.fetched_at || null },
    staff,
    parents: parents.rows,
    children_with_no_parent_login: parents.children_with_no_parent_login,
    counts: {
      staff: { total: staff.length, ...countBy(staff, (s) => s.status) },
      parents: { total: parents.rows.length, ...countBy(parents.rows, (p) => p.status), by_kind: countBy(parents.rows, (p) => p.kind) },
    },
  };
}

module.exports = { loginHealth, readAccessLists, onList, summarisePolicies };
