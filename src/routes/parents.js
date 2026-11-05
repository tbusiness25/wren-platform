const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const { checkEnum } = require('../lib/enum-guard');
const { getMenuForDate } = require('../lib/menu-rotation'); // b171 (2026-07-28) — rotation-aware menu weeks
const { b247, b430 } = require('./phonics'); // b430 (2026-10-08) — "Phonics at home" card: room-week + book-match reuse

// ── Option B de-identification (2026-06-12) ───────────────────────────────────
// Parents see their OWN child fully, but any OTHER child's name is redacted to an
// initial in parent-facing free text (obs title/text, diary notes/activities).
// Photos: only obs/diary explicitly shared_with_parents are returned; group-photo
// detection needs staff tagging (not auto-detectable) — see note in /child/:id/gallery.
let _childNames = { at: 0, list: [] };
async function getChildNames(db) {
  if (Date.now() - _childNames.at < 300000 && _childNames.list.length) return _childNames.list;
  try {
    const { rows } = await db.query('SELECT id, first_name, last_name FROM children WHERE is_active=true');
    _childNames = { at: Date.now(), list: rows };
  } catch { /* keep stale cache on error */ }
  return _childNames.list;
}
function redactOthers(text, ownChildId, children) {
  if (!text) return text;
  let out = String(text);
  for (const c of children) {
    if (c.id === ownChildId) continue;
    for (const nm of [c.first_name, c.last_name]) {
      if (!nm || String(nm).trim().length < 3) continue;
      const esc = String(nm).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('\\b' + esc + '\\b', 'gi'), (String(nm)[0] || '').toUpperCase() + '.');
    }
  }
  return out;
}

// Parent auth middleware — strict audience check
// Waitlist gating middleware – restrict waitlist parents to allowed endpoints only
const parentAuth = (req, res, next) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-wren-token'] || '';
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.aud || decoded.aud !== 'parents') {
      return res.status(401).json({ error: 'Invalid token audience' });
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// GET /waitlist/status – returns waiting‑list info for the authenticated parent
// b367 (2026-09-29): parentAuth is applied by router.use() further down this file, which is
// AFTER this route — so this one was declared unauthenticated and read req.user.email off
// undefined. Every caller got a 500 instead of a 401, and the route sat in front of
// parent_portal_access with no token check at all. parentAuth is applied here explicitly.
router.get('/waitlist/status', parentAuth, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT waiting_list_id, access_level FROM parent_portal_access WHERE lower(email)=lower($1) AND is_active=true`,
      [req.user.email]
    );
    if (!rows.length) return res.status(404).json({ error: 'Parent not found' });
    const { waiting_list_id, access_level } = rows[0];
    // Fetch waiting list details (room wanted, position) – simplified example
    const wl = await db.query(
      `SELECT room_name, position FROM waiting_list WHERE id=$1`,
      [waiting_list_id]
    );
    const info = wl.rows[0] || {};
    res.json({ access_level, waiting_list_id, ...info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/settings', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      "SELECT value FROM settings WHERE key='portal_mode'"
    );
    // fledge-off (2026-10-26): whether the parents app may mention Fledge at all.
    // One switch, src/lib/fledge-switch.js (ladn.settings.fledge_enabled; absent = off).
    const fledge_enabled = await require('../lib/fledge-switch').isFledgeEnabled(db);
    res.json({ portal_mode: rows[0]?.value || 'full', fledge_enabled });
  } catch(e) { res.json({ portal_mode: 'full', fledge_enabled: false }); }
});

// GET /contact-numbers — item 12 (2026-07-29): tap-to-call direct lines.
// Numbers are held in the editable config key ladn.settings['parent_contact_phones']
// (JSON array of {label, phone}); falls back to the design-guideline defaults if unset.
// Pre-auth (public nursery numbers, no PII) — placed above parentAuth intentionally.
const DEFAULT_CONTACT_PHONES = [
  // 2026-09-15: one number for parents. It answers with 1 for the Baby Room, 2 for Pre-school.
  { label: 'Nursery — press 1 Baby Room, 2 Pre-school', phone: '020 7946 0000' },
];
router.get('/contact-numbers', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      "SELECT value FROM settings WHERE key='parent_contact_phones'"
    );
    let list = DEFAULT_CONTACT_PHONES;
    if (rows[0]?.value) {
      try {
        const parsed = JSON.parse(rows[0].value);
        if (Array.isArray(parsed) && parsed.length) {
          list = parsed
            .filter(x => x && x.phone && x.label)
            .map(x => ({ label: String(x.label), phone: String(x.phone) }));
        }
      } catch { /* malformed config → fall back to defaults */ }
    }
    // Never surface a "James" entry (item 12 explicit exclusion).
    list = list.filter(x => !/james/i.test(x.label));
    res.json({ numbers: list });
  } catch (e) {
    res.json({ numbers: DEFAULT_CONTACT_PHONES });
  }
});

// GET /fees-support-message — supportive fees text (build log 2026-08-03 §2).
// Configurable via settings['fees_support_message']; falls back to a sensible
// default. Non-PII, pre-auth so the welcome/fees view can render it same-origin.
const _PP = require('../services/payment-plan');
router.get('/fees-support-message', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query("SELECT value FROM settings WHERE key='fees_support_message'");
    const message = (rows[0] && rows[0].value && String(rows[0].value).trim())
      ? String(rows[0].value) : _PP.DEFAULT_SUPPORT_MESSAGE;
    res.json({ message });
  } catch (e) {
    res.json({ message: _PP.DEFAULT_SUPPORT_MESSAGE });
  }
});

// b257 — ONE exception to header-only auth, for one path.
// /oral-health/file is reached by a plain <a href> and by a <video src>; neither
// can set an Authorization header, and blob-fetching a 158 MB film would throw
// away byte-range streaming. So that path alone may carry the parent's own token
// as ?t=. Promoted into the header here so parentAuth below still does the
// actual verification — same audience check, same signature check, one code
// path. Deliberately an exact path match: no prefix, no regex, nothing else in
// this router changes.
router.use((req, res, next) => {
  if (req.path === '/oral-health/file' && req.query.t
      && !req.headers['authorization'] && !req.headers['x-wren-token']) {
    req.headers['x-wren-token'] = String(req.query.t);
  }
  next();
});

// GET /next-steps/switch — what the nav gate (pwa.js gateNextSteps) asks. b393 fix
// (2026-10-09): it sat below router.use(parentAuth), which only takes a bearer, and
// pwa.js sends just the session cookie — so every page boot got a 401, and lap-boot.js
// turns any /welcome 401 into a bounce to /login. Above parentAuth now, behind
// requireParentIdentity: the same check the phonics switch gets from the portal-wide
// gate (bearer, view-as cookie, session cookie or CF assertion). It returns one global
// boolean; _nextStepsVisible (hoisted, below) fails closed.
router.get('/next-steps/switch', require('../lib/parent-identity').requireParentIdentity, async (req, res) => {
  try {
    const enabled = await _nextStepsVisible(getPool());
    res.json({ enabled });
  } catch (e) { res.status(500).json({ error: 'Internal error' }); }
});

// All below require parent auth
router.use(parentAuth);

// ── Message delivery preference (parent email-reply gateway, 2026-08-04) ──────
// The signed-in parent chooses how they receive Wren messages: in-app only
// ('app', default/most secure), also-by-email ('email'), or 'both'. Keyed by the
// parent's email so it applies across all their children.
const _parentEmail = req => String((req.user && (req.user.email || req.user.name)) || '').toLowerCase().trim();

router.get('/comms-pref', async (req, res) => {
  const email = _parentEmail(req);
  if (!email) return res.json({ delivery_mode: 'app' });
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT delivery_mode FROM parent_comms_prefs WHERE parent_email=$1', [email]);
    res.json({ delivery_mode: rows[0]?.delivery_mode || 'app' });
  } catch (e) { res.json({ delivery_mode: 'app' }); }
});

// b340: this is no longer a rival setting. The Notifications screen (per-category push / email / both / off)
// is the one place a parent chooses; this old route is the same choice for the 'messages' category, written
// through src/services/parent-notification-prefs.js so both entry points leave the SAME rows behind and
// parent_comms_prefs stays in step for src/routes/messages.js. 'app' → off, 'email'/'both' → email, and the
// old column keeps exactly the word the old card sent.
router.put('/comms-pref', async (req, res) => {
  const mode = String(req.body?.delivery_mode || '').toLowerCase();
  if (!['app', 'email', 'both'].includes(mode)) return res.status(400).json({ error: 'invalid delivery_mode' });
  const email = _parentEmail(req);
  if (!email) return res.status(400).json({ error: 'no parent email on token' });
  try {
    await require('../services/parent-notification-prefs')
      .setChannel(getPool(), email, 'messages', mode === 'app' ? 'off' : 'email', { legacyValue: mode });
    res.json({ ok: true, delivery_mode: mode });
  } catch (e) {
    if (e.code === '42P01') {
      // b340's tables are not there yet (code deployed before the migration): behave exactly as before.
      try {
        await getPool().query(
          `INSERT INTO parent_comms_prefs (parent_email, delivery_mode, updated_at) VALUES ($1,$2,now())
           ON CONFLICT (parent_email) DO UPDATE SET delivery_mode=EXCLUDED.delivery_mode, updated_at=now()`, [email, mode]);
        return res.json({ ok: true, delivery_mode: mode });
      } catch (e2) { return res.status(500).json({ error: e2.message }); }
    }
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Waitlist gating middleware – restrict waitlist parents to allowed endpoints only
router.use((req, res, next) => {
  const accessLevel = req.user && req.user.access_level;
  if (accessLevel !== 'waitlist') return next();
  // Allowed paths for waitlist parents
  const allowed = [
    '/waitlist/status',
    '/messages', // placeholder for messaging endpoint if exists
    '/funding'   // placeholder for funding declarations endpoint
  ];
  if (allowed.some(p => req.path.startsWith(p))) return next();
  return res.status(403).json({ error: 'Forbidden: waitlist access limited' });
});

const childGuard = (req, res, next) => {
  const cid = parseInt(req.params.childId);
  if (req.user.role === 'parent') {
    const owned = (req.user.child_ids && req.user.child_ids.length) ? req.user.child_ids : [req.user.child_id];
    if (!owned.includes(cid)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  next();
};

// GET /child/:childId/diary
router.get('/child/:childId/diary', childGuard, async (req, res) => {
  try {
    const db = getPool();
    // 2026-09-24 — staff reported the daily diary "not working". It was working; parents
    // could not see it. Staff log into ladn.diary_entries (13 entries today), and this read
    // only ladn.daily_diary — which nothing in Wren writes. daily_diary has been filled by
    // eylog-sync.sh section 4 every night at ~01:38 since June, which is why those rows carry
    // no staff_id and why the diary looked fine until staff moved onto Wren.
    //
    // Two consequences: anything logged in Wren was invisible to the family, and on
    // 2026-10-26, when EyLog closes, the parents' diary would have stopped dead with no
    // error anywhere. So read BOTH — diary_entries for what staff log now, daily_diary for
    // the imported history — and merge them by day.
    // b405 (2026-10-06, ported 17 Oct 2026 as D08): today's STAFF-authored rows no longer
    // show live as they're written — only once this child is signed out, or once
    // closing_time has passed (src/lib/child-day-gate.js). A parent's own entry
    // (source='parent') is never gated, and an entry staff have already Published
    // (diaryfix2) shows as before. Supersedes the 2026-07-30 "d.date = CURRENT_DATE"
    // / live-today escape hatches this replaced.
    const { closingTimeSetting, revealedTodayClause } = require('../lib/child-day-gate');
    const closingTime = await closingTimeSetting(db);
    const revealedLegacy = revealedTodayClause('d.child_id', closingTime);
    const revealedLive = revealedTodayClause('diary_entries.child_id', closingTime);
    const [legacy, live] = await Promise.all([
      db.query(`
        SELECT d.date, d.mood, d.meals, d.naps, d.activities, d.notes, d.photo_urls
          FROM daily_diary d
         WHERE d.child_id=$1 AND d.shared_with_parents=true
           AND (d.status='published' OR (d.date = CURRENT_DATE AND ${revealedLegacy}))
         ORDER BY d.date DESC LIMIT 30`, [req.params.childId]),
      db.query(`
        SELECT (occurred_at AT TIME ZONE 'Europe/London')::date AS date,
               json_agg(json_build_object(
                 'type', entry_type, 'at', to_char(occurred_at AT TIME ZONE 'Europe/London','HH24:MI'),
                 'food_amount', food_amount, 'food_meal', food_meal,
                 'nappy_state', nappy_state, 'drink_ml', drink_ml, 'drink_type', drink_type,
                 'sleep_quality', sleep_quality, 'minutes', duration_minutes,
                 'notes', notes, 'by', logged_by_name
               ) ORDER BY occurred_at) AS entries
          FROM diary_entries
         WHERE child_id=$1 AND deleted_at IS NULL
           AND COALESCE(share_with_parents, true) = true
           AND (status IS NULL OR status <> 'draft' OR source='parent'
                OR ((occurred_at AT TIME ZONE 'Europe/London')::date = (now() AT TIME ZONE 'Europe/London')::date
                    AND ${revealedLive}))
         GROUP BY (occurred_at AT TIME ZONE 'Europe/London')::date
         ORDER BY 1 DESC LIMIT 30`, [req.params.childId]),
    ]);

    // one row per day, whichever store it came from
    const byDay = new Map();
    const key = (d) => new Date(d).toISOString().slice(0, 10);
    legacy.rows.forEach(r => byDay.set(key(r.date), { ...r }));
    live.rows.forEach(r => {
      const k = key(r.date);
      const existing = byDay.get(k) || { date: r.date, mood: null, meals: null, naps: null,
                                         activities: null, notes: null, photo_urls: [] };
      existing.entries = r.entries;          // the timeline for that day
      byDay.set(k, existing);
    });
    const rows = [...byDay.values()]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 30);
    const own = parseInt(req.params.childId, 10);
    const names = await getChildNames(db);
    res.json(rows.map(r => ({
      ...r,
      notes: redactOthers(r.notes, own, names),
      activities: redactOthers(r.activities, own, names),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/observations
router.get('/child/:childId/observations', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT o.id, o.title, o.observation_text, o.eyfs_areas, o.photo_urls,
             o.created_at, s.first_name as staff_first_name
      FROM observations o
      LEFT JOIN staff s ON s.id = o.staff_id
      WHERE o.child_id=$1 AND o.shared_with_parents=true
      ORDER BY o.created_at DESC LIMIT 50
    `, [req.params.childId]);
    const own = parseInt(req.params.childId, 10);
    const names = await getChildNames(db);
    res.json(rows.map(r => ({
      ...r,
      title: redactOthers(r.title, own, names),
      observation_text: redactOthers(r.observation_text, own, names),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/gallery — photos from diary + observations
router.get('/child/:childId/gallery', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const [diary, obs] = await Promise.all([
      db.query(`SELECT photo_urls, date as created_at FROM daily_diary WHERE child_id=$1 AND shared_with_parents=true AND status='published' AND array_length(photo_urls,1)>0 ORDER BY date DESC LIMIT 50`, [req.params.childId]),
      db.query(`SELECT photo_urls, created_at FROM observations WHERE child_id=$1 AND shared_with_parents=true AND array_length(photo_urls,1)>0 ORDER BY created_at DESC LIMIT 50`, [req.params.childId])
    ]);
    res.json({ diary: diary.rows, observations: obs.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/timeline — unified EyLog-style feed: published diary + observations
// (+ their photos), newest first. Diary entries carry a `finalised` flag: draft = live/
// provisional times during the day, finalised = locked at sign-out. Other children's names
// are redacted in free text. Parents see only their own child (childGuard) and only items
// staff have shared (shared_with_parents=true).
router.get('/child/:childId/timeline', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const cid = parseInt(req.params.childId, 10);
    // b354 (2026-09-24) — Toby: "the timeline would then be the timeline of
    // everything — so observations, daily diaries, photos, events, newsletters,
    // messages. It's just like this timeline stream." Photos already ride
    // inline on diary/observation rows above; events, newsletters and messages
    // did not, so the family only ever saw two of the six things Toby named.
    // Extending THIS endpoint, not building a second timeline.
    const childRow = (await db.query('SELECT room_id FROM children WHERE id=$1', [cid])).rows[0] || {};
    const parentEmail = (req.user && req.user.email || '').toLowerCase();
    const [diary, obs, homeActs, events, newsletters, threadMsgs] = await Promise.all([
      db.query(`
        SELECT id, date, mood, meals, lunch, naps, sleep_from, sleep_to, nappy, nappy_time,
               milk_amount_ml, milk_time, activities, notes, photo_urls, finalised_at
        FROM daily_diary
        WHERE child_id=$1 AND shared_with_parents=true AND status='published'
        ORDER BY date DESC LIMIT 60
      `, [cid]),
      db.query(`
        SELECT o.id, o.title, o.observation_text, o.eyfs_areas, o.photo_urls, o.created_at,
               s.first_name AS staff_first_name
        FROM observations o LEFT JOIN staff s ON s.id = o.staff_id
        WHERE o.child_id=$1 AND o.shared_with_parents=true
        ORDER BY o.created_at DESC LIMIT 60
      `, [cid]),
      // item 6 (2026-07-29) — home activities (curriculum/activity-bank items staff sent
      // home via shared_items) now appear inline on the parent timeline, with any attached
      // docs (resource cards, phonics sound sheets). Fails soft to empty on older schemas.
      db.query(`
        SELECT si.id, si.item_type, si.title, si.description, si.shared_at,
               COALESCE(si.attachments, '[]'::jsonb) AS attachments,
               s.first_name AS staff_first_name
        FROM shared_items si LEFT JOIN staff s ON s.id = si.shared_by
        WHERE si.child_id=$1 AND si.is_active=true
        ORDER BY si.shared_at DESC LIMIT 60
      `, [cid]).catch(() => ({ rows: [] })),
      // b354 — same audience rule as /welcome/events/api/list (all, or this
      // child's own room); only PAST events belong in a timeline of what
      // happened, not what's upcoming (that's Events, a different screen).
      db.query(`
        SELECT id, title, description, event_date, location
        FROM events
        WHERE is_published=true AND event_date < CURRENT_DATE
          AND (audience='all' OR audience = $1::text)
        ORDER BY event_date DESC LIMIT 30
      `, [String(childRow.room_id || '')]).catch(() => ({ rows: [] })),
      // b354 — same ownership rule as /welcome/newsletters/api/list.
      parentEmail ? db.query(`
        SELECT n.id, n.title, n.subject, n.sent_at
        FROM newsletter_sends s JOIN newsletters n ON n.id = s.newsletter_id
        WHERE lower(s.parent_email) = $1 AND n.status='sent' AND COALESCE(n.audience,'parents')='parents'
        ORDER BY n.sent_at DESC LIMIT 30
      `, [parentEmail]).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
      // b354 — this child's message threads (either direction); a thread with
      // no messages yet contributes nothing.
      db.query(`
        SELECT m.id, m.thread_id, m.sender_type, m.body, m.created_at, t.subject
        FROM messages m JOIN message_threads t ON t.id = m.thread_id
        WHERE t.child_id=$1
        ORDER BY m.created_at DESC LIMIT 30
      `, [cid]).catch(() => ({ rows: [] })),
    ]);
    const names = await getChildNames(db);
    const items = [];
    for (const d of diary.rows) {
      items.push({
        kind: 'diary', id: d.id, at: d.date, finalised: !!d.finalised_at,
        mood: d.mood, meals: d.meals, lunch: d.lunch, naps: d.naps,
        sleep_from: d.sleep_from, sleep_to: d.sleep_to,
        nappy: d.nappy, nappy_time: d.nappy_time,
        milk_amount_ml: d.milk_amount_ml, milk_time: d.milk_time,
        activities: redactOthers(d.activities, cid, names),
        notes: redactOthers(d.notes, cid, names),
        photo_urls: d.photo_urls || [],
      });
    }
    for (const o of obs.rows) {
      items.push({
        kind: 'observation', id: o.id, at: o.created_at,
        title: redactOthers(o.title, cid, names),
        text: redactOthers(o.observation_text, cid, names),
        eyfs_areas: o.eyfs_areas || [], staff: o.staff_first_name || null,
        photo_urls: o.photo_urls || [],
      });
    }
    for (const h of homeActs.rows) {
      items.push({
        kind: 'home_activity', id: h.id, at: h.shared_at,
        item_type: h.item_type,
        title: redactOthers(h.title, cid, names),
        text: redactOthers(h.description, cid, names),
        staff: h.staff_first_name || null,
        attachments: Array.isArray(h.attachments) ? h.attachments : [],
      });
    }
    // b354 — events/newsletters are staff-authored broadcasts, not per-child
    // free text, so (unlike diary/observation/home_activity above) there is no
    // other child's name to redact out of them.
    for (const ev of events.rows) {
      items.push({ kind: 'event', id: ev.id, at: ev.event_date, title: ev.title, text: ev.description, location: ev.location });
    }
    for (const n of newsletters.rows) {
      items.push({ kind: 'newsletter', id: n.id, at: n.sent_at, title: n.title || n.subject });
    }
    for (const m of threadMsgs.rows) {
      items.push({
        kind: 'message', id: m.id, at: m.created_at,
        title: m.subject || 'Message', text: m.body,
        from: m.sender_type === 'parent' ? 'you' : 'nursery',
      });
    }
    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    res.json(items.slice(0, 80));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/profile — child info shown to parent
router.get('/child/:childId/profile', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.first_name, c.last_name, c.preferred_name, c.date_of_birth,
             c.funded_hours, c.funded_hours_type, c.start_date,
             c.allergies, c.dietary_requirements, c.medical_notes,
             c.photo_url, c.collection_password,
             r.name as room_name,
             s.first_name as key_person_first,
             -- 2026-10-23 (keyperson): parents get the key person's first name only, never the
             -- surname; the photo comes only through /meet-the-team, when they chose to publish it.
             NULL::text as key_person_last, NULL::text as key_person_photo
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = c.key_person_id
      WHERE c.id = $1
    `, [req.params.childId]);
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/meet-the-team (b356, 2026-09-24) — the child's key person, shown large,
// plus the rest of their room's team, smaller — each only if that staff member has opted in
// (staff_about_me.is_visible) and is still active. A leaver's is_active flips false on their
// leaving day and they disappear from this response with no other change needed.
//
// 2026-10-23 (keyperson) — also feeds the "Your child's key person" card on the home screen
// (?only=key → key_person + buddy, no team). What a parent may see is decided in ONE place,
// src/lib/staff-parent-profile.js parentCards():
//   key_person / buddy  always first name + role label (EYFS 3.27: parents must be told who
//                       the key person is); blurb, b356's fields and photo only when that
//                       person published them and no manager has hidden them
//   team                as before — only staff who published, minus the key person and buddy
// Never a surname, phone or email. Photos arrive inline as data: URIs because
// /uploads/staff-photos is closed on the parents portal (server-unified.js, b491).
router.get('/child/:childId/meet-the-team', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const SPP = require('../lib/staff-parent-profile');
    const { rows: childRows } = await db.query(
      `SELECT c.room_id, c.key_person_id, c.first_name, c.preferred_name,
              ${await _hasBuddyCol(db) ? 'c.buddy_staff_id' : 'NULL::int AS buddy_staff_id'}
         FROM children c WHERE c.id = $1`, [req.params.childId]);
    const child = childRows[0];
    if (!child) return res.json({ key_person: null, buddy: null, team: [] });
    const onlyKey = String(req.query.only || '') === 'key';
    const ids = [child.key_person_id, child.buddy_staff_id];
    let teamIds = [];
    if (!onlyKey && child.room_id != null) {
      const { rows: t } = await db.query(`
        SELECT s.id FROM staff s JOIN staff_about_me a ON a.staff_id = s.id
         WHERE s.is_active IS NOT FALSE AND a.is_visible IS TRUE AND s.room_id = $1`, [child.room_id]);
      teamIds = t.map(r => r.id).filter(id => !ids.includes(id));
    }
    const cards = await SPP.parentCards(db, ids.concat(teamIds), { full: !onlyKey });
    const keyPerson = child.key_person_id ? (cards.get(child.key_person_id) || null) : null;
    const buddy = child.buddy_staff_id && child.buddy_staff_id !== child.key_person_id
      ? (cards.get(child.buddy_staff_id) || null) : null;
    const team = teamIds.map(id => cards.get(id)).filter(c => c && c.published)
      .sort((a, b) => String(a.first_name).localeCompare(String(b.first_name)));
    res.json({
      child_first_name: child.preferred_name || child.first_name || null,
      key_person: keyPerson, buddy, team: onlyKey ? [] : team,
    });
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return res.json({ key_person: null, buddy: null, team: [] });
    res.status(500).json({ error: e.message });
  }
});
let _buddyCol = null;
async function _hasBuddyCol(db) {
  if (_buddyCol !== null) return _buddyCol;
  const { rows } = await db.query(`SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'children' AND column_name = 'buddy_staff_id'`);
  _buddyCol = rows.length > 0;
  return _buddyCol;
}

// GET /child/:childId/attendance — attendance summary (last 60 records)
router.get('/child/:childId/attendance', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT date, session, absent, absence_reason, notes
      FROM attendance
      WHERE child_id = $1
      ORDER BY date DESC
      LIMIT 60
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/funding — funding info
router.get('/child/:childId/funding', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT funded_hours, funded_hours_type, start_date,
             pupil_premium, send_needs, looked_after
      FROM children WHERE id = $1
    `, [req.params.childId]);
    res.json(rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /announcements — recent newsletters as announcements
router.get('/announcements', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT id, subject as title, created_at, left(manager_intro, 200) as preview
      FROM newsletters
      WHERE status='sent' AND COALESCE(audience,'parents') = 'parents'  -- b295: never a staff bulletin
      ORDER BY sent_at DESC LIMIT 5
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /menu — current week's menu.
// b171 (2026-07-28): rotation-aware — resolves the active menu_group_weeks
// week for today via src/lib/menu-rotation.js instead of dumping every item
// in the active date-range group (which used to mix all weeks together).
// Rows keep the original flat shape (group_id/name/date_from/date_to/item_id/
// day_of_week/meal_type/description/allergens) so the existing parents-portal
// menu UI keeps working unchanged.
router.get('/menu', async (req, res) => {
  try {
    const db = getPool();
    const date = new Date().toISOString().slice(0, 10);
    const { group, week_number, items } = await getMenuForDate(db, date, null);
    if (!group) return res.json([]);
    const rows = items.length
      ? items.map(mi => ({
          group_id: group.id, name: group.name, date_from: group.date_from, date_to: group.date_to,
          week_number, item_id: mi.id, day_of_week: mi.day_of_week, meal_type: mi.meal_type,
          description: mi.description, allergens: mi.allergens,
        }))
      : [{ group_id: group.id, name: group.name, date_from: group.date_from, date_to: group.date_to,
           week_number, item_id: null, day_of_week: null, meal_type: null, description: null, allergens: null }];
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /articles — published resources
router.get('/articles', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, title, content_html, category, source_url, created_at FROM resources WHERE published=true ORDER BY created_at DESC LIMIT 20`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /resources — folder tree from gdrive via rclone.
//
// 2026-08-21: this listing takes ~14s against a 205-file Drive and the exec timeout
// was 15s, so it had begun failing intermittently with "Drive unavailable" — adding
// six SLT leaflets was enough to tip it over. Three changes:
//   1. timeout 15s -> 45s, so a cold call has room.
//   2. an in-memory cache (10 min), so parents almost never wait on Drive at all.
//   3. if Drive fails but a cached copy exists, serve that instead of an error —
//      stale resources beat no resources on a parent's phone.
// It also flags recently-added files so the page can show what is new.
const RES_CACHE_MS = 10 * 60 * 1000;
const RES_NEW_DAYS = 14;
let _resCache = null;                     // { at, payload }

function _buildResourcePayload(files) {
  const cutoff = Date.now() - RES_NEW_DAYS * 86400000;
  let newest = null, newCount = 0;
  const folders = {};
  files.forEach(f => {
    const parts = f.Path.split('/');
    const folder = parts.length > 1 ? parts[0] : 'General';
    const subfolder = parts.length > 2 ? parts[1] : null;
    const key = subfolder ? `${folder} / ${subfolder}` : folder;
    const mod = f.ModTime ? Date.parse(f.ModTime) : NaN;
    const isNew = Number.isFinite(mod) && mod >= cutoff;
    if (isNew) newCount++;
    if (Number.isFinite(mod) && (newest === null || mod > newest)) newest = mod;
    if (!folders[key]) folders[key] = [];
    folders[key].push({
      name: f.Name, path: f.Path, size: f.Size,
      modified: f.ModTime, mimeType: f.MimeType || '', is_new: isNew,
    });
  });
  const sorted = {};
  if (folders['Articles']) sorted['Articles'] = folders['Articles'];
  Object.keys(folders).sort().forEach(k => { if (k !== 'Articles') sorted[k] = folders[k]; });
  return {
    folders: sorted, total: files.length,
    new_count: newCount, new_days: RES_NEW_DAYS,
    newest_modified: newest ? new Date(newest).toISOString() : null,
  };
}

router.get('/resources', async (req, res) => {
  if (_resCache && (Date.now() - _resCache.at) < RES_CACHE_MS) {
    return res.json(Object.assign({}, _resCache.payload, { cached: true }));
  }
  const { exec } = require('child_process');
  exec('rclone lsjson gdrive:MASTER/PARENTS/ --recursive --files-only --max-depth 3',
    { timeout: 45000, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => {
      if (err) {
        if (_resCache) return res.json(Object.assign({}, _resCache.payload, { cached: true, stale: true }));
        return res.status(500).json({ error: 'Drive unavailable', detail: err.message });
      }
      try {
        const payload = _buildResourcePayload(JSON.parse(stdout));
        _resCache = { at: Date.now(), payload };
        res.json(payload);
      } catch (e) {
        if (_resCache) return res.json(Object.assign({}, _resCache.payload, { cached: true, stale: true }));
        res.status(500).json({ error: 'Parse error' });
      }
    }
  );
});

// GET /resources/file?path=X — stream file from gdrive
router.get('/resources/file', async (req, res) => {
  const { spawn } = require('child_process');
  const filePath = req.query.path;
  if (!filePath || !/^[A-Za-z0-9 ._/-]+$/.test(filePath) || filePath.startsWith('/') || filePath.includes('//')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const name = filePath.split('/').pop();
  const ext = name.split('.').pop().toLowerCase();
  const mimeMap = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png'
  };
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  const dl = spawn('rclone', ['cat', `gdrive:MASTER/PARENTS/${filePath}`]);
  dl.stdout.pipe(res);
  dl.stderr.on('data', d => console.error('rclone err:', d.toString()));
  dl.on('error', () => res.status(500).end());
});

// POST /contact — saves as message thread
router.post('/contact', async (req, res) => {
  const { subject, body, recipient_type } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });
  const db = getPool();
  try {
    const { rows: [child] } = await db.query(
      'SELECT id, key_person_id FROM children WHERE id=$1', [req.user.child_id]
    );
    if (!child) return res.status(404).json({ error: 'Child not found' });

    let recipientStaffId = null;
    if (recipient_type === 'key_person' && child.key_person_id) {
      recipientStaffId = child.key_person_id;
    } else if (recipient_type === 'manager') {
      const { rows } = await db.query(`SELECT id FROM staff WHERE role='manager' AND is_active=true LIMIT 1`);
      if (rows.length) recipientStaffId = rows[0].id;
    }

    const { rows: [thread] } = await db.query(
      `INSERT INTO message_threads (child_id, subject, recipient_type, recipient_staff_id)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [child.id, subject, recipient_type || 'nursery', recipientStaffId]
    );
    await db.query(
      `INSERT INTO messages (thread_id, sender_type, parent_email, body)
       VALUES ($1,'parent',$2,$3)`,
      [thread.id, req.user.name, body]
    );
    res.json({ ok: true, thread_id: thread.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /weekly-menu — from weekly_menus table or menu_groups/items
router.get('/weekly-menu', async (req, res) => {
  try {
    const db = getPool();
    // Try weekly_menus custom table first
    let rows = [];
    try {
      const r = await db.query(`
        SELECT day_of_week, meal_type, description, allergens
        FROM weekly_menus
        WHERE week_start >= CURRENT_DATE - 7
        ORDER BY CASE day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 ELSE 6 END,
          CASE meal_type WHEN 'Breakfast' THEN 1 WHEN 'Morning Snack' THEN 2 WHEN 'Lunch' THEN 3 WHEN 'Afternoon Snack' THEN 4 ELSE 5 END
      `);
      rows = r.rows;
    } catch {
      // Fallback to menu_groups/menu_items — b171 (2026-07-28): rotation-aware,
      // resolves the active menu_group_weeks week via src/lib/menu-rotation.js
      // instead of dumping every item in the date-range group across all weeks.
      const { items } = await getMenuForDate(db, new Date().toISOString().slice(0, 10), null);
      rows = items.map(mi => ({ day_of_week: mi.day_of_week, meal_type: mi.meal_type, description: mi.description, allergens: mi.allergens }));
    }
    res.json({ menu: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/invoices — invoices for a specific child
router.get('/child/:childId/invoices', childGuard, async (req, res) => {
  try {
    const db = getPool();
    // 2026-08-24: this ordered by i.period_start, which does not exist on this table
    // (the real columns are period_year / period_month / period_label). Postgres threw,
    // the .catch() swallowed it, and every parent silently saw an empty list — 651
    // imported invoices, none of them visible. Same shape as the Leavers Book bug:
    // schema drift hidden behind a catch-all. Ordering now uses real columns, the limit
    // covers the whole EyLog history (back to Sept 2023), and a failure is surfaced
    // rather than being indistinguishable from "you have no invoices".
    const { rows } = await db.query(`
      SELECT i.*, c.first_name || ' ' || c.last_name as child_name
      FROM invoices i
      JOIN children c ON c.id = i.child_id
      WHERE i.child_id = $1 AND COALESCE(i.status, '') <> 'draft'   -- 2026-10-06: drafts aren't bills yet
      ORDER BY i.period_year DESC NULLS LAST,
               i.period_month DESC NULLS LAST,
               i.issued_on DESC NULLS LAST,
               i.created_at DESC
      LIMIT 200
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update childGuard to support child_ids array
const childGuardMulti = (req, res, next) => {
  const cid = parseInt(req.params.childId);
  if (req.user.role === 'parent') {
    const allowedIds = req.user.child_ids || (req.user.child_id ? [req.user.child_id] : []);
    if (!allowedIds.includes(cid) && req.user.child_id !== cid) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  next();
};

// ── Parent-facing reports — list reports shared by staff ─────────────
// GET /report — all reports (from both reports + parent_reports tables)
// shared_with the parent's child. Parents see shared_with_parents=true
// on the reports table, or draft/finalised status on parent_reports.
router.get('/report', async (req, res) => {
  try {
    const db = getPool();
    const ownChildId = req.user.child_id || (req.user.child_ids && req.user.child_ids[0]);
    if (!ownChildId) return res.json({ reports: [] });

    // Gather child IDs the parent can see
    const allowedChildren = req.user.child_ids || (req.user.child_id ? [req.user.child_id] : []);
    const placeholders = allowedChildren.map((_, i) => `$${i + 1}`).join(',');

    // Reports table (staff-facing)
    const r1 = await db.query(`
      SELECT r.id, r.report_type, r.created_at, r.shared_with_parents,
             'staff' as _source
      FROM reports r
      WHERE r.shared_with_parents = true
        AND r.child_id IN (${placeholders})
    `, allowedChildren).catch(() => ({ rows: [] }));

    // Parent reports table (parent-facing workflow)
    const r2 = await db.query(`
      SELECT pr.id, pr.report_type, pr.generated_at as created_at,
             pr.status, pr.finalised_at,
             'parent' as _source
      FROM parent_reports pr
      WHERE pr.child_id IN (${placeholders})
    `, allowedChildren).catch(() => ({ rows: [] }));

    // Merge and de-duplicate by ID
    const seen = new Set();
    const all = [...r1.rows.map(r => ({
      ...r,
      child_id: ownChildId,
      acknowledged_at: r.shared_with_parents ? null : r.shared_with_parents,
    })), ...r2.rows.map(r => ({
      id: r.id,
      report_type: r.report_type,
      created_at: r.created_at,
      status: r.status,
      finalised_at: r.finalised_at,
      child_id: ownChildId,
      _source: r._source,
      ack: r.status === 'sent' || r.status === 'finalised',
    }))];

    res.json({ reports: all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /child/:childId/home-log – quick log entries from home
//
// Fixed 2026-09-08. This inserted `entry_type` into `daily_diary`, which has no
// such column — on dev AND prod — so every submission 500'd, and always had.
// Home-log entries belong in `ladn.diary_entries`, which is where the parents
// portal's own /welcome/baby-log/api/log has been writing them all along; this
// route is the API twin of that one and now matches it, source and all.
router.post('/child/:childId/home-log', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const b = req.body || {};
    // `data` kept for callers using the older nested shape; flat fields win.
    const d = (b.data && typeof b.data === 'object') ? b.data : {};
    const pick = (k) => (b[k] !== undefined ? b[k] : d[k]);
    const entry_type = b.entry_type || d.entry_type;

    for (const [col, val] of [
      ['entry_type',    entry_type],
      ['nappy_state',   pick('nappy_state')],
      ['drink_type',    pick('drink_type')],
      ['food_amount',   pick('food_amount')],
      ['food_meal',     pick('food_meal')],
      ['sleep_quality', pick('sleep_quality')],
    ]) {
      const bad = await checkEnum(db, 'diary_entries', col, val);
      if (bad) return res.status(400).json(bad);
    }
    if (!entry_type) return res.status(400).json({ error: 'entry_type is required', field: 'entry_type' });

    const notes = pick('notes') != null ? String(pick('notes')).slice(0, 500)
                : (b.data && typeof b.data === 'object' ? null : null);
    // b367 (2026-09-29): this said `ladn.diary_entries`. src/routes/parents.js is SHARED —
    // the eyfs demo edition mounts it too — so a parent home-log entry on a demo was
    // INSERTed straight into LADN PRODUCTION, and the GET below read production rows back.
    // Unqualified, so search_path picks the caller's own schema (every schema has the table).
    const { rows } = await db.query(`
      INSERT INTO diary_entries
        (child_id, entry_type, occurred_at, duration_minutes, food_amount, food_meal,
         nappy_state, drink_ml, drink_type, sleep_quality, notes, share_with_parents,
         source, logged_by_name)
      VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7,$8,$9,$10,$11,true,'parent',$12)
      RETURNING id`,
      [req.params.childId, entry_type, pick('occurred_at') || null,
       pick('duration_minutes') || null, pick('food_amount') || null, pick('food_meal') || null,
       pick('nappy_state') || null, pick('drink_ml') || null, pick('drink_type') || null,
       pick('sleep_quality') || null, notes,
       String(pick('logged_by_name') || 'Parent').slice(0, 60)]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error('[parents home-log]', e.message);
    res.status(500).json({ error: 'Could not save that entry' });
  }
});

// GET /child/:childId/home-log – list home log entries
router.get('/child/:childId/home-log', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { from, to } = req.query;
    // Reads what the POST above writes: ladn.diary_entries, source 'parent'.
    // Was `daily_diary … source='home'`, a table/flag pair nothing has ever
    // written to, so this returned an empty list to every parent, always.
    // b367 — unqualified for the same reason as the INSERT above: shared route, one
    // schema per edition, chosen by search_path.
    let query = `SELECT * FROM diary_entries
                  WHERE child_id=$1 AND source='parent' AND deleted_at IS NULL`;
    const params = [req.params.childId];
    if (from) { query += ` AND occurred_at >= $${params.length+1}`; params.push(from); }
    if (to) { query += ` AND occurred_at < ($${params.length+1}::date + 1)`; params.push(to); }
    query += ` ORDER BY occurred_at DESC LIMIT 500`;
    const { rows } = await db.query(query, params);
    res.json({ entries: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── About Me: parent-editable (build 75c, 2026-07-09) ─────────────────────────
// Parents read/update the soft "all about me" fields for their OWN child only.
// Medical/contact data is NOT editable here — that goes through change requests.
const ABOUT_ME_PARENT_FIELDS = [
  'comforter', 'interests', 'skills', 'fears', 'comforts', 'sleep_pattern', 'sleep_routine',
  'sleep_location', 'milk_type', 'milk_amount_ml', 'feeds_per_day', 'words_they_use',
  'toileting_stage', 'potty_training', 'nappy_size', 'nappy_type', 'food_preferences',
  'special_days', 'first_language', 'other_languages',
  // b268 — the paper "All About Me" questions parents already answer by hand.
  // food_texture is deliberately NOT here: see ABOUT_ME_PARENT_READONLY below.
  'nickname', 'needs_help_with', 'communication_support', 'premature_weeks',
  'favourite_songs_rhymes', 'milk_vessel', 'feed_times', 'finger_foods',
  'spoon_foods', 'sleep_method',
];

// b268 — shown to parents, never written by them. `food_texture` (pureed / lumpy /
// whole) is a choking-risk instruction the kitchen serves from, so it sits in the
// same category as allergies: a parent asks for a change, staff confirm it. The
// change-request flow (POST /child/:id/change-request) already exists for exactly
// this, and the portal points at it.
const ABOUT_ME_PARENT_READONLY = ['food_texture'];

/** About Me columns typed integer — '' from a form field is "not recorded", not 0. */
const ABOUT_ME_PARENT_INT = new Set(['milk_amount_ml', 'feeds_per_day', 'premature_weeks']);

router.get('/child/:childId/about-me', childGuard, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT ${[...ABOUT_ME_PARENT_FIELDS, ...ABOUT_ME_PARENT_READONLY].join(',')}, last_updated_at
         FROM child_about_me WHERE child_id=$1`,
      [req.params.childId]);
    // b268: tell the portal which keys it may not edit, rather than hard-coding
    // that knowledge in the page.
    res.json(Object.assign({ readonly_fields: ABOUT_ME_PARENT_READONLY }, rows[0] || {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/child/:childId/about-me', childGuard, async (req, res) => {
  const sets = [], vals = [];
  for (const k of ABOUT_ME_PARENT_FIELDS) {
    if (k in (req.body || {})) {
      let v = req.body[k] === '' ? null : req.body[k];
      // b268: an integer column must never receive '' or a stray word.
      if (v != null && ABOUT_ME_PARENT_INT.has(k)) {
        const n = parseInt(v, 10);
        v = Number.isFinite(n) ? n : null;
      }
      vals.push(v); sets.push(`${k}=$${vals.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  try {
    const db = getPool();
    vals.push(req.params.childId);
    const { rowCount } = await db.query(
      `UPDATE child_about_me SET ${sets.join(',')}, last_updated_at=now() WHERE child_id=$${vals.length}`, vals);
    if (!rowCount) {
      await db.query(
        `INSERT INTO child_about_me (child_id, ${sets.map(s => s.split('=')[0]).join(',')}, last_updated_at)
         VALUES ($${vals.length}, ${sets.map((_, i) => '$' + (i + 1)).join(',')}, now())`, vals);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Change requests: allergy / details — never applied silently (build 75d) ───
router.post('/child/:childId/change-request', childGuard, async (req, res) => {
  const { kind, detail } = req.body || {};
  if (!['allergy_add', 'allergy_remove', 'details_change'].includes(kind) || !detail || typeof detail !== 'object') {
    return res.status(400).json({ error: 'kind (allergy_add|allergy_remove|details_change) and detail required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO parent_change_requests (child_id, parent_email, kind, detail)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [req.params.childId, req.user.email || null, kind, JSON.stringify(detail)]);
    // Tell staff a request is waiting (best-effort).
    try {
      await db.query(
        `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
         VALUES ('all-staff', NULL, 'parent_request', $1, $2, '/app.html#children', 'parent_change_requests', $3, $4)`,
        [`Parent change request (${kind.replace('_', ' ')})`,
         `A parent submitted a ${kind.replace('_', ' ')} request — review it in Roost.`,
         rows[0].id, kind === 'allergy_add' ? 'high' : 'normal']);
    } catch (nErr) { console.error('[parents/change-request] notification failed (non-fatal):', nErr.message); }
    res.status(201).json({ ok: true, id: rows[0].id, status: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/child/:childId/change-requests', childGuard, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, kind, detail, status, created_at, decided_at FROM parent_change_requests
       WHERE child_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /child/:childId/medicine-consent — parent submits medicine consent/request
router.post('/child/:childId/medicine-consent', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { medicine_name, dose, reason, valid_from, valid_to } = req.body;
    if (!medicine_name || !dose || !reason || !valid_from || !valid_to) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const { rows } = await db.query(`
      INSERT INTO parent_medicine_consents (child_id, parent_email, medicine_name, dose, reason, valid_from, valid_to)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [req.params.childId, req.user.email, medicine_name, dose, reason, valid_from, valid_to]);

    // Raise all-staff notification
    const child = await db.query('SELECT first_name, last_name FROM children WHERE id=$1', [req.params.childId]);
    const childName = child.rows[0] ? `${child.rows[0].first_name} ${child.rows[0].last_name}` : 'Child';
    await db.query(`
      INSERT INTO notifications (recipient_type, recipient_id, category, title, body, related_table, related_id)
      SELECT 'staff', id, 'medicine', $1, $2, 'parent_medicine_consents', $3
      FROM staff WHERE is_active=true
    `, [
      'Parent Medicine Consent Submitted',
      `${childName}: ${medicine_name} - ${reason}`,
      rows[0].id
    ]);

    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── b155 SEN hub: Play Plan (parent side) ─────────────────────────────────────
// The SEN register itself is never parent-visible (blocked wholesale on /api/sen
// by server-unified.js's PARENT_DENY) — only a Play Plan a staff member has
// explicitly shared lands here, scoped to the parent's own child(ren).

// GET /child/:childId/play-plan — latest snapshot explicitly shared by staff
router.get('/child/:childId/play-plan', childGuardMulti, async (req, res) => {
  try {
    // b256 §2 — review_date, child_photo_url, parent_feedback_by_area and
    // home_achieved_by_area are Abbey's template fields b155 did not carry.
    // Added to the SELECT, not substituted for anything: parent_feedback (the
    // single free-text blob) is still returned and still written.
    const { rows } = await getPool().query(
      `SELECT id, target_date, review_date, child_photo_url, snapshot, generated_at, shared_at,
              parent_feedback, parent_feedback_at, parent_feedback_by_area, home_achieved_by_area
       FROM sen_play_plans WHERE child_id=$1 AND shared_with_parent=true ORDER BY generated_at DESC LIMIT 1`,
      [req.params.childId]);
    res.json(rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /child/:childId/play-plan-feedback — "Parental view on progress" (abbey-pack template)
//
// b256 §2: Abbey's template asks for the parental view FOUR times, once per area
// of need, and asks the family separately what the child has achieved AT HOME —
// her review page has a nursery column and a home column. b155 collected one
// free-text blob, so a family could not answer area by area and the printed plan
// could not lay their answer beside the target it belongs to.
//
// Backwards compatible on purpose: { feedback: "..." } still works exactly as it
// did and still writes parent_feedback. The two new shapes are additive:
//   { by_area:      { "Communication & Interaction": "...", ... } }
//   { home_achieved:{ "Sensory/Physical": "...", ... } }
// Any combination of the three may be sent in one request.
const PLAY_PLAN_AREAS = ['Communication & Interaction', 'Cognition & Learning',
  'Social, Emotional & Mental Health', 'Sensory/Physical'];

function cleanAreaMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const area of PLAY_PLAN_AREAS) {
    const v = input[area];
    if (v === undefined || v === null) continue;
    const t = String(v).trim();
    if (t) out[area] = t.slice(0, 4000);
  }
  return out;
}

router.post('/child/:childId/play-plan-feedback', childGuardMulti, async (req, res) => {
  const { feedback, by_area, home_achieved } = req.body;
  const byArea = cleanAreaMap(by_area);
  const homeMap = cleanAreaMap(home_achieved);
  const hasBlob = feedback && String(feedback).trim();
  if (!hasBlob && !(byArea && Object.keys(byArea).length) && !(homeMap && Object.keys(homeMap).length)) {
    return res.status(400).json({ error: 'feedback, by_area or home_achieved required' });
  }
  try {
    const sets = [], params = []; let pi = 1;
    if (hasBlob) {
      sets.push(`parent_feedback=$${pi++}`); params.push(String(feedback).trim());
      sets.push('parent_feedback_at=NOW()');
    }
    // Merge rather than replace — a family answering one area at a time must not
    // wipe the three they filled in last week.
    if (byArea && Object.keys(byArea).length) {
      sets.push(`parent_feedback_by_area = parent_feedback_by_area || $${pi++}::jsonb`);
      params.push(JSON.stringify(byArea));
      if (!hasBlob) sets.push('parent_feedback_at=NOW()');
    }
    if (homeMap && Object.keys(homeMap).length) {
      sets.push(`home_achieved_by_area = home_achieved_by_area || $${pi++}::jsonb`);
      params.push(JSON.stringify(homeMap));
    }
    params.push(req.params.childId);
    const { rows } = await getPool().query(
      `UPDATE sen_play_plans SET ${sets.join(', ')}
       WHERE id = (SELECT id FROM sen_play_plans WHERE child_id=$${pi} AND shared_with_parent=true ORDER BY generated_at DESC LIMIT 1)
       RETURNING id, target_date, review_date, parent_feedback, parent_feedback_at,
                 parent_feedback_by_area, home_achieved_by_area`, params);
    if (!rows.length) return res.status(404).json({ error: 'No shared play plan for this child' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── b256 §3/§4 — the parent-facing toolkit path ──────────────────────────────
// "If a toolkit strategy is worth sharing with a family, that path goes through
// parents.js." It does, and ONLY through here: /api/sen and /api/sen-toolkit are
// both on PARENT_DENY, so a parent token cannot reach either.
//
// A family sees a strategy only where a practitioner explicitly ticked "share
// with parent" on the link for THEIR child. There is no browse-the-whole-library
// endpoint for parents: reading the toolkit end to end tells a family what other
// children in the room might be working on, and that is not theirs to read.
//
// What comes back is the parent-useful half of the entry — what it is, who it is
// for, how to do it, what to look for — plus the practitioner's note. Deliberately
// NOT returned: when_to_escalate (a professional judgement that would read to a
// family as a prognosis) and the link's status field (a practitioner's working
// note on whether it is helping, not a verdict to hand over unexplained).
router.get('/child/:childId/strategies', childGuardMulti, async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT l.id, l.note, l.shared_at, l.target_id,
             s.slug, s.title, s.area, s.summary, s.who_for, s.age_stage,
             s.how_to, s.what_success_looks_like,
             s.licensed, s.licence_note, s.source_name, s.source_url,
             s.materials, s.resource_path,
             t.target_text
      FROM sen_strategy_links l
      JOIN sen_strategies s ON s.id = l.strategy_id
      LEFT JOIN sen_targets t ON t.id = l.target_id
      WHERE l.child_id = $1
        AND l.shared_with_parent = true
        AND l.status <> 'stopped'
        AND s.is_active
      ORDER BY s.area, l.shared_at DESC NULLS LAST
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/medicine-consents — parent views their submitted consents
router.get('/child/:childId/medicine-consents', childGuard, async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT id, medicine_name, dose, reason, valid_from, valid_to, status, created_at, acknowledged_at
      FROM parent_medicine_consents
      WHERE child_id=$1
      ORDER BY created_at DESC
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── b430 (2026-10-08): "Phonics at home" ─────────────────────────────────────
// Full-programme phonics (b406-b420), surfaced for a family: the child's ROOM
// week (b411/b420 effective week), the book matched to THIS child by their
// own secure sounds (b408 — falling back to the room's week book if the child
// has no assessed GPCs yet), this week's home slip PDF if one has been built
// (b421), and plain-English "how to help". childGuard-scoped like the SEN hub
// above (b155) — own child only, never another family's.
//
// Deliberately in THIS router, not /api/phonics (which wants a staff JWT and
// has no ownership scoping at all) and not the b247 /api/phonics/parent/*
// handlers in server-unified.js (that's the OLDER, simpler sound-progress
// scheme — this reads the NEWER full-programme room/lesson/book-match data
// instead, via the b430 export in src/routes/phonics.js).
const PHONICS_HOW_TO_HELP = [
  'Say each sound short and clear — "sss", not "suh"; "t", not "tuh".',
  'Sound out together, left to right, then blend: s-a-t… sat.',
  'For a tricky word, read the regular parts, then notice the tricky bit.',
  'Read the same book a few times this week — it gets easier, and that\'s the point.',
  'Five minutes, little and often, beats one long sitting.',
];

async function b430ChildRoomAndSwitch(db, childId) {
  const { rows } = await db.query(
    `SELECT c.id, c.first_name, c.room_id, c.phonics_enabled, r.name AS room_name, r.display_name AS room_display_name
       FROM children c LEFT JOIN rooms r ON r.id = c.room_id
      WHERE c.id = $1`, [childId]);
  return rows[0] || null;
}

router.get('/child/:childId/phonics-home', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const childId = parseInt(req.params.childId, 10);
    const child = await b430ChildRoomAndSwitch(db, childId);
    if (!child) return res.status(404).json({ error: 'not_found' });
    if (!child.phonics_enabled) return res.json({ enabled: false });

    const today = child.room_id ? await b430.todayForRoom(db, child.room_id) : { programme: null };

    const [secureGpc, secureTricky] = await Promise.all([
      b430.secureSet(db, childId, 'gpc'),
      b430.secureSet(db, childId, 'tricky_word', { lower: true }),
    ]);
    const catalog = b430.bookCatalog();
    // A child with no assessed sounds yet would "match" a wordless Phase 1 book (it decodes with nothing) —
    // only personalise once there is at least one secure sound; otherwise use the room's book for the week.
    const matches = secureGpc.size ? b430.matchBooks(catalog, secureGpc, secureTricky) : [];
    let book = null;
    if (matches[0]) {
      const full = b247.story(matches[0].slug);
      book = full ? { slug: full.slug, title: full.title, checkpoint: full.checkpoint, for_this_child: true } : null;
    } else if (today.week && today.week.matched_book && today.week.matched_book.title) {
      // Not yet matched to THIS child individually — fall back to the room's
      // week book, by title (the lesson JSON doesn't carry its slug).
      const roomBook = catalog.find((b) => b.title === today.week.matched_book.title);
      book = roomBook
        ? { slug: roomBook.slug, title: roomBook.title, checkpoint: null, for_this_child: false }
        : { slug: null, title: today.week.matched_book.title, checkpoint: null, for_this_child: false };
    }

    let homeSlipAvailable = false, homeSlipUrl = null;
    if (today.programme) {
      const slip = b430.homeSlipFor(today.programme.year_key, today.programme.effective_global_week);
      if (slip) { homeSlipAvailable = true; homeSlipUrl = b430.homeSlipUrl(slip); }
    }

    res.json({
      enabled: true,
      child: { id: child.id, first_name: child.first_name },
      room: child.room_id ? { id: child.room_id, name: child.room_display_name || child.room_name } : null,
      programme: today.programme,
      week: today.week || null,
      is_weekend: today.is_weekend === true,
      day_name: today.day_name || null,
      new_gpcs: today.week ? today.week.new_gpcs : [],
      new_tricky_words: today.week ? today.week.new_tricky_words : [],
      book,
      home_slip_available: homeSlipAvailable,
      home_slip_url: homeSlipUrl,
      how_to_help: PHONICS_HOW_TO_HELP,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/phonics-home/slip.pdf — this week's home slip (b421): redirects to the published
// getwren.co.uk copy (generic weekly sheet, no child data). The card links there directly.
router.get('/child/:childId/phonics-home/slip.pdf', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const child = await b430ChildRoomAndSwitch(db, parseInt(req.params.childId, 10));
    if (!child || !child.phonics_enabled || !child.room_id) return res.status(404).json({ error: 'not_found' });
    const today = await b430.todayForRoom(db, child.room_id);
    if (!today.programme) return res.status(404).json({ error: 'not_found' });
    const entry = b430.homeSlipFor(today.programme.year_key, today.programme.effective_global_week);
    if (!entry) return res.status(404).json({ error: 'not_found' });
    res.redirect(302, b430.homeSlipUrl(entry));   // the one published copy (see phonics.js b430HomeSlipFor)
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /payment-plan — parent-facing read of their own child's payment plan(s).
// Build log 2026-08-03 §2. Returns proposed/active plans for the parent's children
// plus the supportive fees message. Scoped strictly to the parent's own children.
router.get('/payment-plan', async (req, res) => {
  try {
    const db = getPool();
    const allowed = req.user.child_ids || (req.user.child_id ? [req.user.child_id] : []);
    if (!allowed.length) return res.json({ payment_plans: [], support_message: _PP.DEFAULT_SUPPORT_MESSAGE });
    const { rows } = await db.query(`
      SELECT id, child_id, monthly_pence, pay_now_pence, schedule, reason, status, created_at
      FROM payment_plans
      WHERE child_id = ANY($1::int[]) AND status IN ('proposed','active','agreed')
      ORDER BY created_at DESC`, [allowed]);
    let msg = _PP.DEFAULT_SUPPORT_MESSAGE;
    try {
      const { rows: s } = await db.query("SELECT value FROM settings WHERE key='fees_support_message'");
      if (s[0] && s[0].value && String(s[0].value).trim()) msg = String(s[0].value);
    } catch { /* default */ }
    res.json({ payment_plans: rows, support_message: msg });
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Oral health: the family half of the setting-content store (b257) ─────────
// The setting has the Aquafresh "Shine Bright" toothbrushing pack. Most of it is
// staff material and lives behind /api/setting-content (which is on PARENT_DENY).
// But the 21-day challenge calendar is *written to families* — it is useless
// sitting in a staff library — and so are the certificate, four of the posters
// and the brushing song.
//
// Two rules make this safe to expose:
//   • The list of parent-visible files is the programme manifest's `parent_files`
//     array, not a pattern. Widening it is an edit to content, not to a regex.
//   • The path a request asks for must appear verbatim in that array, and is then
//     re-resolved through setting-content's own containment check. A traversal
//     attempt fails both tests independently.
// No child data is involved, so there is nothing here to scope per child — every
// family sees the same pack, which is the point of it.
const _settingContent = require('./setting-content');

function _oralHealthProgramme() {
  return _settingContent._loadProgrammes()
    .find(p => Array.isArray(p.parent_files) && p.parent_files.length) || null;
}

// GET /oral-health — what a family can take home.
router.get('/oral-health', (req, res) => {
  try {
    const prog = _oralHealthProgramme();
    if (!prog) return res.json({ available: false, files: [] });
    res.json({
      available: true,
      title: prog.title || null,
      subtitle: prog.subtitle || null,
      attribution: prog.attribution || null,
      files: (prog.parent_files || []).map(f => ({
        label: f.label, note: f.note || '', kind: f.kind || 'pdf',
        bytes: f.bytes || 0, path: f.path,
      })),
    });
  } catch (e) { res.status(500).json({ error: 'Internal error' }); }
});

// GET /oral-health/file?path=... — stream one allowlisted file.
// Delegates to setting-content's handler so byte-range support (the brushing
// song is 158 MB and has to seek) has exactly one implementation.
router.get('/oral-health/file', (req, res) => {
  try {
    const wanted = String(req.query.path || '');
    const prog = _oralHealthProgramme();
    const entry = prog && (prog.parent_files || []).find(f => f.path === wanted);
    if (!entry) return res.status(403).json({ error: 'Not available on the parents portal' });

    const fsMod = require('fs'), pathMod = require('path');
    const abs = _settingContent._resolveInStore(entry.path);
    if (!abs) return res.status(400).json({ error: 'Invalid path' });
    const ext = pathMod.extname(abs).toLowerCase();
    if (!_settingContent._SERVABLE.has(ext)) return res.status(415).json({ error: 'Unsupported file type' });

    fsMod.stat(abs, (err, st) => {
      if (err || !st.isFile()) return res.status(404).json({ error: 'Not found' });
      res.setHeader('Content-Type', _settingContent._MIME[ext]);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      const name = pathMod.basename(abs).replace(/["\\]/g, '');
      res.setHeader('Content-Disposition',
        (req.query.download ? 'attachment' : 'inline') + '; filename="' + name + '"');
      res.sendFile(abs, { acceptRanges: true, dotfiles: 'deny' }, (e) => {
        if (e && !res.headersSent) res.status(e.status || 500).end();
      });
    });
  } catch (e) { res.status(500).json({ error: 'Internal error' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b393 (2026-10-05) — "What we're working on", optional, off by default.
// Gated by settings.parents_see_next_steps (Toby's to switch on), and even
// then only the next steps a practitioner has explicitly ticked
// parent_visible are shown — a key person opts a step in, not every step in
// by default. Parent-friendly wording only: no staff notes, no framework
// jargon, no evidence_note (that is the room's record, not the family's).
// ═══════════════════════════════════════════════════════════════════════════

/** Whether the setting is on. Fails closed on any error. */
async function _nextStepsVisible(db) {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key='parents_see_next_steps'");
    return rows.length ? rows[0].value === 'true' : false;
  } catch { return false; }
}

// GET /next-steps/switch lives above router.use(parentAuth) — see there.

// GET /child/:childId/next-steps — the card's content for one child.
router.get('/child/:childId/next-steps', childGuard, async (req, res) => {
  try {
    const db = getPool();
    if (!await _nextStepsVisible(db)) return res.json({ enabled: false, items: [] });
    const { rows } = await db.query(`
      SELECT n.id, n.description, n.resource_card_slug, n.resource_card_title, n.review_due
        FROM next_steps n
       WHERE n.child_id=$1 AND n.parent_visible=true
         AND n.status IN ('pending','open','planned') AND n.closed_at IS NULL
       ORDER BY n.review_due ASC NULLS LAST, n.created_at DESC
       LIMIT 10`, [req.params.childId]);

    let cardsBySlug = {};
    try { cardsBySlug = (require('./resource-cards')._loadCards().bySlug || {}); } catch { /* best-effort */ }

    res.json({
      enabled: true,
      items: rows.map(n => {
        const card = n.resource_card_slug && cardsBySlug[n.resource_card_slug];
        return {
          id: n.id,
          description: n.description,
          how_to_help: card ? { title: card.title, strapline: card.strapline || null } : null,
        };
      }),
    });
  } catch (e) { res.status(500).json({ error: 'Internal error' }); }
});

module.exports = router;

