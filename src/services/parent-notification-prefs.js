'use strict';
/**
 * parent-notification-prefs.js — b340 (2026-09-18)
 * ─────────────────────────────────────────────────────────────────────────────
 * What a PARENT chose about being told things: per category, push / email / both / off.
 * ONE place reads and writes it — the parents Notifications screen, the old
 * "Message delivery" card (PUT /api/parents/comms-pref), the newsletter send and the
 * dispatcher's parent fan-out all come through here.
 *
 * "OFF" MEANS "NO ALERT", NOT "HIDDEN"
 * ------------------------------------
 * Every notification a parent has always appears under the bell in the app. That is the
 * app's own record and it never leaves Wren. These choices only decide whether Wren ALSO
 * nudges the parent — by push to a phone they set up, or by email.
 *
 * DEFAULTS ARE "HOW IT WORKS TODAY", AND ARE NEVER STORED
 * -------------------------------------------------------
 * A missing row is not a choice. It reads as what happens now, so releasing this changes
 * nobody's notifications:
 *   messages    — email only if the old parent_comms_prefs row says email/both (else nothing)
 *   newsletter  — email unless the old row says 'app'   ← the OPPOSITE default, on purpose:
 *                 that is what src/routes/newsletter.js has always done
 *   everything else — nothing beyond the bell
 * Nothing is written to the table by a release; rows appear only when a parent chooses.
 *
 * ONE SETTING, NOT TWO
 * --------------------
 * parent_comms_prefs.delivery_mode (the reply-by-email gateway, 2026-08-04) is still read by
 * src/routes/messages.js. Rather than a rival setting, this module is the only writer of it:
 * choosing 'messages' here keeps the old column in step (email/both → 'email', else 'app'), and
 * the old PUT route calls setChannel(). The first time a parent chooses ANYTHING, their old
 * setting is carried into explicit rows for messages and newsletter (source
 * 'legacy_comms_pref') so that changing one cannot silently shift the other — the old column
 * was shared by both.
 *
 * WHAT CAN ACTUALLY BE DELIVERED
 * ------------------------------
 * `push` — true only for categories that flow through the notification dispatcher (a parent-
 *          addressed notify()). `email` — 'dispatcher' (a fixed, content-free "something is
 *          waiting" email built in parent-notify.js), 'legacy' (an existing sender does it and
 *          reads the choice from here) or null. A category can only be given a channel it can
 *          really deliver; the rest are listed under NOT_YET so the screen is honest.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const CHANNELS = ['push', 'email', 'both', 'off'];

const CATEGORIES = [
  {
    id: 'messages',
    label: 'Messages from the nursery',
    help: 'When someone at the nursery sends you a message.',
    dispatcher: ['message_received'],
    channels: ['push', 'email', 'both', 'off'],
    push: true,
    email: 'legacy',            // src/routes/messages.js _emailParentOfThread — reply-by-email gateway
    email_help: 'Email sends you a copy of the message, so you can reply from your inbox.',
    push_text: 'You have a new message from the nursery.',
    email_phrase: 'a new message',
    default_from_legacy: 'messages',
  },
  {
    id: 'observations',
    label: 'New observations and photos',
    help: 'When a new observation or photo is shared in your child\'s learning journey.',
    dispatcher: ['observation_published'],
    channels: ['push', 'email', 'both', 'off'],
    push: true,
    email: 'dispatcher',
    email_help: 'Email only says something new is waiting, and links to the app.',
    push_text: 'There is something new in your child\'s learning journey.',
    email_phrase: 'a new observation or photo',
  },
  {
    id: 'reports',
    label: 'Reports and termly updates',
    help: 'When a progress report or termly update is shared with you.',
    dispatcher: ['report_shared'],
    channels: ['push', 'email', 'both', 'off'],
    push: true,
    email: 'dispatcher',
    email_help: 'Email only says something new is waiting, and links to the app.',
    push_text: 'A new report or update is ready for you.',
    email_phrase: 'a new report or update',
  },
  {
    // b343 (2026-09-21): forms a parent signs in the app. Moved here from NOT_YET — a producer now exists
    // (src/services/parent-forms-nudge.js). The wording is deliberately the vaguest in the file: it must not say WHICH form,
    // because "an accident form" on a lock screen or in a shared inbox is a disclosure. Default is nothing beyond the bell and
    // the standing card in the app; a parent who wants a nudge chooses it here.
    id: 'forms',
    label: 'Forms to sign',
    help: 'When there is a form for you to read and sign in the app.',
    dispatcher: ['form_needs_signature'],
    channels: ['push', 'email', 'both', 'off'],
    push: true,
    email: 'dispatcher',
    email_help: 'Email only says something is waiting for you to sign, and links to the app.',
    push_text: 'There is a form waiting for you to read and sign.',
    email_phrase: 'a form to read and sign',
    open_path: '/welcome/forms',       // where the nudge lands; every other category opens /welcome/notifications
  },
  {
    // b502 (2026-10-17): the reminder campaigns for details a family still has to fill in. Push only, and only for a parent who chooses it
    // here: the bell and the "To do" card on the home screen are always there. NO email, by construction: email is null and the dispatcher
    // category is on the parent email block list (parent-notify.js).
    id: 'details',
    label: 'Details we still need',
    help: 'When the nursery is still waiting for details or a form from you.',
    dispatcher: ['details_outstanding'],
    channels: ['push', 'off'],
    push: true,
    email: null,
    push_text: 'There is something in the app for you to fill in.',
    open_path: '/welcome',
  },
  {
    id: 'events',
    label: 'Events and trips',
    help: 'When the nursery publishes an event or a trip.',
    dispatcher: ['event_published'],
    channels: ['push', 'email', 'both', 'off'],
    push: true,
    email: 'dispatcher',
    email_help: 'Email only says something new is waiting, and links to the app.',
    push_text: 'There is a new event or trip to look at.',
    email_phrase: 'a new event or trip',
  },
  {
    id: 'newsletter',
    label: 'Newsletters',
    help: 'The nursery newsletter.',
    dispatcher: [],
    channels: ['email', 'off'],    // no push: a newsletter is not a notification the dispatcher raises
    push: false,
    email: 'legacy',               // src/routes/newsletter.js — reads the choice through newsletterAppOnly()
    email_help: 'Email sends the newsletter. It is always kept under Newsletters in the app as well.',
    default_from_legacy: 'newsletter',
  },
];

// Categories a parent might expect to see here that nothing can honestly deliver yet. They are
// listed on the screen (not hidden, not given a switch that would do nothing), and the service
// refuses to store a choice for them.
const NOT_YET = [
  { id: 'diary', label: 'Daily diary',
    note: 'Your child\'s diary is always in the app under Diary. We do not send a separate alert when it is updated yet.' },
  { id: 'invoices', label: 'Invoice issued',
    note: 'Invoices are emailed to whoever pays them, and are always in the app under Invoices. Choosing how they reach you is not switchable yet.' },
  { id: 'notices', label: 'Absence and closure notices',
    note: 'We do not send a separate alert for these yet.' },
];

const BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
// notifications.category (what the dispatcher sees) → the preference category that governs it
const PREF_FOR_DISPATCH = {};
for (const c of CATEGORIES) for (const d of c.dispatcher) PREF_FOR_DISPATCH[d] = c.id;

const normEmail = e => String(e || '').toLowerCase().trim();

// ── The default: how it works today ──────────────────────────────────────────
function defaultChannel(cat, legacyMode) {
  if (cat.default_from_legacy === 'messages') return (legacyMode === 'email' || legacyMode === 'both') ? 'email' : 'off';
  if (cat.default_from_legacy === 'newsletter') return legacyMode === 'app' ? 'off' : 'email';
  return 'off';
}

async function _legacyMode(db, email) {
  try {
    const { rows } = await db.query('SELECT delivery_mode FROM parent_comms_prefs WHERE parent_email=$1', [email]);
    return rows[0] ? rows[0].delivery_mode : null;
  } catch (_) { return null; }     // table absent (demo schema): behave as "no old setting"
}

/** Every category with the parent's effective channel, and whether they chose it. */
async function getPrefs(db, emailRaw) {
  const email = normEmail(emailRaw);
  const [{ rows }, legacy] = await Promise.all([
    db.query('SELECT category, channel, source, updated_at FROM parent_notification_prefs WHERE parent_email=$1', [email]),
    _legacyMode(db, email),
  ]);
  const stored = new Map(rows.map(r => [r.category, r]));
  return CATEGORIES.map(c => {
    const r = stored.get(c.id);
    return {
      id: c.id, label: c.label, help: c.help, email_help: c.email_help,
      channels: c.channels, can_push: c.push, email_by: c.email,
      channel: r ? r.channel : defaultChannel(c, legacy),
      chosen: !!(r && r.source === 'parent'),
      updated_at: r ? r.updated_at : null,
    };
  });
}

/**
 * Store a parent's choice. Returns the refreshed list. Throws an Error with .status 400 for a
 * category or channel that cannot be honoured — the service is the gate, not the screen, so a
 * hand-built request cannot record a choice nothing would act on.
 * `legacyValue` lets the old PUT route keep 'both' as 'both' in the old column.
 */
async function setChannel(db, emailRaw, categoryId, channel, opts) {
  const email = normEmail(emailRaw);
  const cat = BY_ID[categoryId];
  if (!email) { const e = new Error('no parent email'); e.status = 401; throw e; }
  if (!cat) { const e = new Error('Unknown category'); e.status = 400; throw e; }
  if (!CHANNELS.includes(channel) || !cat.channels.includes(channel)) {
    const e = new Error(`"${channel}" is not available for ${cat.label}`); e.status = 400; throw e;
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Carry the old shared setting into explicit rows first, so this change cannot move the other one.
    let legacy = null;
    try {
      const r = await client.query('SELECT delivery_mode FROM parent_comms_prefs WHERE parent_email=$1', [email]);
      legacy = r.rows[0] ? r.rows[0].delivery_mode : null;
    } catch (_) { await client.query('ROLLBACK'); await client.query('BEGIN'); }
    for (const c of CATEGORIES.filter(x => x.default_from_legacy)) {
      await client.query(
        `INSERT INTO parent_notification_prefs (parent_email, category, channel, source)
         VALUES ($1,$2,$3,'legacy_comms_pref') ON CONFLICT (parent_email, category) DO NOTHING`,
        [email, c.id, defaultChannel(c, legacy)]);
    }
    await client.query(
      `INSERT INTO parent_notification_prefs (parent_email, category, channel, source, updated_at)
       VALUES ($1,$2,$3,'parent',now())
       ON CONFLICT (parent_email, category) DO UPDATE SET channel=EXCLUDED.channel, source='parent', updated_at=now()`,
      [email, categoryId, channel]);
    if (cat.default_from_legacy === 'messages') {
      const mode = (opts && opts.legacyValue) || ((channel === 'email' || channel === 'both') ? 'email' : 'app');
      await client.query(
        `INSERT INTO parent_comms_prefs (parent_email, delivery_mode, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (parent_email) DO UPDATE SET delivery_mode=EXCLUDED.delivery_mode, updated_at=now()`,
        [email, mode]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
  return getPrefs(db, email);
}

/** Which of these addresses do NOT want the newsletter by email? (used by newsletter.js) */
async function newsletterAppOnly(db, emails) {
  const list = (emails || []).map(normEmail).filter(Boolean);
  const out = new Set();
  if (!list.length) return out;
  // If the b340 table has not been created yet (code deployed before the migration), nobody has chosen
  // anything: fall through to the old column, so a parent who picked "app only" is still not emailed.
  let explicit = [];
  try {
    ({ rows: explicit } = await db.query(
      `SELECT parent_email, channel FROM parent_notification_prefs WHERE category='newsletter' AND parent_email = ANY($1)`, [list]));
  } catch (_) { /* table absent */ }
  const chosen = new Map(explicit.map(r => [r.parent_email, r.channel]));
  let legacy = new Map();
  try {
    const { rows } = await db.query(
      `SELECT lower(parent_email) AS parent_email, delivery_mode FROM parent_comms_prefs WHERE lower(parent_email) = ANY($1)`, [list]);
    legacy = new Map(rows.map(r => [r.parent_email, r.delivery_mode]));
  } catch (_) { /* no old table */ }
  for (const e of list) {
    if (chosen.has(e)) { if (chosen.get(e) === 'off' || chosen.get(e) === 'push') out.add(e); }
    else if (legacy.get(e) === 'app') out.add(e);
  }
  return out;
}

// ── Push devices (one row per phone, revocable) ──────────────────────────────
const MAX_DEVICES = 10;

function deviceLabelFromUA(ua) {
  const s = String(ua || '');
  const device = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android phone'
    : /Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows computer' : /Linux/.test(s) ? 'Linux computer' : 'This device';
  const browser = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /(Chrome|CriOS)\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari' : '';
  return browser ? `${device} · ${browser}` : device;
}

const B64URL = /^[A-Za-z0-9_\-+/=]{8,300}$/;

async function addDevice(db, emailRaw, sub, userAgent) {
  const email = normEmail(emailRaw);
  const endpoint = sub && sub.endpoint, keys = (sub && sub.keys) || {};
  const bad = m => { const e = new Error(m); e.status = 400; return e; };
  if (!email) { const e = new Error('no parent email'); e.status = 401; throw e; }
  if (typeof endpoint !== 'string' || endpoint.length > 1024 || !/^https:\/\//i.test(endpoint)) throw bad('invalid_subscription');
  if (!B64URL.test(String(keys.p256dh || '')) || !B64URL.test(String(keys.auth || ''))) throw bad('invalid_subscription');
  const ua = String(userAgent || '').slice(0, 300);
  const { rows: [row] } = await db.query(
    `INSERT INTO parent_push_subscriptions (parent_email, endpoint, p256dh, auth, user_agent, device_label, last_used_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (endpoint) DO UPDATE SET parent_email=EXCLUDED.parent_email, p256dh=EXCLUDED.p256dh,
       auth=EXCLUDED.auth, user_agent=EXCLUDED.user_agent, device_label=EXCLUDED.device_label, last_used_at=now()
     RETURNING id`,
    [email, endpoint, keys.p256dh, keys.auth, ua || null, deviceLabelFromUA(ua)]);
  // A parent has a phone or two, not fifty: keep the newest few so a stale pile cannot build up.
  await db.query(
    `DELETE FROM parent_push_subscriptions WHERE parent_email=$1 AND id NOT IN (
       SELECT id FROM parent_push_subscriptions WHERE parent_email=$1 ORDER BY last_used_at DESC NULLS LAST, id DESC LIMIT $2)`,
    [email, MAX_DEVICES]);
  return row.id;
}

async function listDevices(db, emailRaw) {
  const { rows } = await db.query(
    `SELECT id, endpoint, device_label, created_at, last_used_at FROM parent_push_subscriptions
      WHERE parent_email=$1 ORDER BY created_at DESC`, [normEmail(emailRaw)]);
  return rows;
}

/** Remove one of THIS parent's devices, by id or by endpoint. Never another parent's. */
async function removeDevice(db, emailRaw, { id, endpoint }) {
  const email = normEmail(emailRaw);
  if (id != null) {
    const r = await db.query('DELETE FROM parent_push_subscriptions WHERE id=$1 AND parent_email=$2', [id, email]);
    return r.rowCount;
  }
  if (endpoint) {
    const r = await db.query('DELETE FROM parent_push_subscriptions WHERE endpoint=$1 AND parent_email=$2', [endpoint, email]);
    return r.rowCount;
  }
  return 0;
}

function maskEmail(emailRaw) {
  const e = normEmail(emailRaw), at = e.indexOf('@');
  if (at < 1) return '';
  return e.slice(0, 1) + '***' + e.slice(at);
}

module.exports = {
  CHANNELS, CATEGORIES, NOT_YET, BY_ID, PREF_FOR_DISPATCH,
  defaultChannel, getPrefs, setChannel, newsletterAppOnly,
  addDevice, listDevices, removeDevice, deviceLabelFromUA, maskEmail, normEmail, MAX_DEVICES,
};
