'use strict';
// ===========================================================================
// PUBLIC AVAILABILITY + DEMAND — UNAUTHENTICATED, rate-limited.  (2026-07-02)
//
// The parent-facing side of the admissions work. Where the manager-gated
// /api/admissions-engine surfaces raw counts, bands and yield, this router
// exposes a SANITISED, honest view for the public availability heat-map + the
// "keep me on the waiting list" (Parked tier) flow.
//
// It is mounted in editions/ladn/server-unified.js BEFORE the auth/offsite
// gates (right next to the public-enquiry mount), so these three endpoints are
// reachable without a JWT. For now the LADN hosts all sit behind Cloudflare
// Access, so this is effectively private until the pages are proxied from the
// public nursery website — exactly the "hidden / behind CF Access for testing"
// posture the brief asks for.
//
//   GET  /api/public/availability?months=N   → per month×room Open/Limited/Full
//                                              + honest prob-of-space (demand-weighted,
//                                              INCLUDING recent parent interest taps).
//   POST /api/public/slot-interest {room,month} → record a tap → slot gets hotter.
//   POST /api/public/keep-on-list  {parent+child+slot} → waiting_list tier='parked'.
//
// NOTE ON DUPLICATION: the occupancy maths below deliberately mirrors the
// (module-private) helpers in src/routes/admissions-engine.js rather than
// importing them, so this public path can NEVER destabilise the prod-verified
// manager engine. Keep the two in step if the capacity model changes; the admin
// availability-preview.html reads the engine directly and is the source of truth.
// ===========================================================================
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();

router.use(express.json({ limit: '16kb' }));

// ── date + band helpers (mirror admissions-engine.js) ───────────────────────
const ymd = d => new Date(d).toISOString().slice(0, 10);
const ageMonths = (dob, at) => (new Date(at) - new Date(ymd(dob) + 'T00:00:00Z')) / (1000 * 60 * 60 * 24 * 30.4375);
function plusMonths(dateStr, n) { const t = new Date(dateStr + 'T00:00:00Z'); t.setUTCMonth(t.getUTCMonth() + n); return ymd(t); }
function plusDays(dateStr, n) { const t = new Date(dateStr + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return ymd(t); }
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKDAY_FROM_ISO = { 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri' };

const DEFAULTS = {
  transfer_age_min_months: 22,
  school_start_age_months: 60,
};
async function loadSettings(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key = ANY($1)`, [Object.keys(DEFAULTS)]);
  const cfg = { ...DEFAULTS };
  for (const r of rows) { const n = Number(r.value); cfg[r.key] = Number.isFinite(n) ? n : DEFAULTS[r.key]; }
  return cfg;
}
async function loadRooms(db, cfg) {
  const { rows } = await db.query(`
    SELECT id, name, min_age_months, max_age_months, capacity,
           COALESCE(target_capacity, capacity) AS target,
           COALESCE(legal_capacity, capacity)  AS legal
    FROM rooms ORDER BY min_age_months`);
  const baby = rows.find(r => r.min_age_months < cfg.transfer_age_min_months) || rows[0];
  const pre = rows.find(r => r.id !== (baby && baby.id)) || rows[rows.length - 1];
  const shape = r => ({ id: r.id, name: r.name, target: r.target, cap: r.capacity, legal: r.legal });
  return { baby: shape(baby), pre: shape(pre) };
}
function bandFor(count, room) {
  if (count > room.legal) return 'over';
  if (count > room.cap) return 'red';
  if (count > room.target) return 'orange';
  return 'green';
}
async function loadWeekdayPatterns(db, lookbackDays = 70) {
  const today = ymd(new Date());
  const from = plusDays(today, -lookbackDays);
  const { rows } = await db.query(`
    SELECT child_id, EXTRACT(ISODOW FROM date)::int AS dow, COUNT(*)::int AS n
    FROM attendance
    WHERE date BETWEEN $1::date AND $2::date AND COALESCE(absent,false)=false
      AND EXTRACT(ISODOW FROM date) <= 5
    GROUP BY child_id, EXTRACT(ISODOW FROM date)`, [from, today]);
  const { rows: opens } = await db.query(`
    SELECT EXTRACT(ISODOW FROM date)::int AS dow, COUNT(DISTINCT date)::int AS opendays
    FROM attendance
    WHERE date BETWEEN $1::date AND $2::date AND EXTRACT(ISODOW FROM date) <= 5
    GROUP BY EXTRACT(ISODOW FROM date)`, [from, today]);
  const openByDow = {}; for (const o of opens) openByDow[o.dow] = o.opendays;
  const byChild = new Map();
  for (const r of rows) {
    if (!byChild.has(r.child_id)) byChild.set(r.child_id, new Set());
    const denom = openByDow[r.dow] || 0;
    if (denom === 0 || r.n / denom >= 0.4) byChild.get(r.child_id).add(WEEKDAY_FROM_ISO[r.dow]);
  }
  // Children with no register history yet (future/confirmed starters) fall back
  // to their agreed contracted_days instead of the full-week default.
  const { rows: contracted } = await db.query(`
    SELECT id, contracted_days FROM children
    WHERE is_active=true AND contracted_days IS NOT NULL AND array_length(contracted_days,1) > 0`);
  for (const c of contracted) {
    if (byChild.has(c.id) && byChild.get(c.id).size) continue; // real attendance wins
    byChild.set(c.id, new Set(c.contracted_days.filter(d => WEEKDAYS.includes(d))));
  }
  return byChild;
}
function patternFor(byChild, childId) {
  const s = byChild.get(childId);
  return (s && s.size) ? [...s] : [...WEEKDAYS];
}
async function loadChildren(db) {
  const { rows } = await db.query(`
    SELECT id, room_id, date_of_birth AS dob, start_date, leave_date,
           notice_given_date, transfer_planned_date
    FROM children
    WHERE is_active=true AND date_of_birth IS NOT NULL`);
  return rows;
}
function effectiveLeave(c) { return c.leave_date ? ymd(c.leave_date) : null; }

// ── "one space per child move" (Toby, 2026-07-06) ───────────────────────────
// The Baby Room runs as a chain: a space only exists when a baby moves up to
// pre-school, and a CONFIRMED incoming baby is the replacement for that move —
// the date gap between "out" and "in" is scheduling flex (either side can shift
// ~a month), NOT a sellable place. So each future BR start is bridged back onto
// the latest unconsumed opening up to 60 days before it; bridged pairs never
// show a phantom space in between (e.g. Ethan out end-Feb ↔ Alex in end-Mar).
function bridgeBabyStarts(kids, rooms, cfg, todayS) {
  const openings = []; const incoming = [];
  for (const c of kids) {
    if (c.room_id !== rooms.baby.id) continue;
    const sd = c.start_date ? ymd(c.start_date) : null;
    if (sd && sd > todayS) incoming.push({ id: c.id, sd });
    const ld = effectiveLeave(c);
    const tdate = c.transfer_planned_date ? ymd(c.transfer_planned_date)
      : plusMonths(ymd(c.dob), cfg.transfer_age_min_months);
    const out = (ld && ld < tdate) ? ld : tdate;
    if (out > todayS) openings.push({ date: out, used: false });
  }
  openings.sort((a, b) => a.date < b.date ? -1 : 1);
  incoming.sort((a, b) => a.sd < b.sd ? -1 : 1);
  const eff = new Map();
  for (const inc of incoming) {
    let best = null;
    for (const o of openings) {
      if (o.used || o.date > inc.sd) continue;
      if (new Date(inc.sd) - new Date(o.date) <= 60 * 864e5) best = o; // latest within 60d wins
    }
    if (best) { best.used = true; eff.set(inc.id, best.date); }
  }
  return eff; // child_id -> bridged effective start (the opening they consume)
}
function roomAt(c, midS, lastS, rooms, cfg) {
  if (c.room_id === rooms.baby.id) {
    const tdate = c.transfer_planned_date ? ymd(c.transfer_planned_date)
      : plusMonths(ymd(c.dob), cfg.transfer_age_min_months);
    // Compare against month END, not mid: a baby moving up on the 19th means the
    // Baby Room space opens DURING that month, which is what a parent asking
    // "when can we start?" needs to see. (Slightly conservative for pre-school,
    // which absorbs the child for the whole month.)
    return tdate <= (lastS || midS) ? 'pre' : 'baby';
  }
  if (c.room_id === rooms.pre.id) return 'pre';
  return ageMonths(c.dob, midS) < cfg.transfer_age_min_months ? 'baby' : 'pre';
}

// ── manual overrides (Parent Waitlist Board, 2026-07-06) ────────────────────
// Managers can pin any room×month cell (status / prob / heat / note) from the
// Roost admissions "Waitlist Board" tab. Overrides beat the computed value —
// the escape hatch so Toby never needs a code change to correct the public map.
async function loadOverrides(db) {
  try {
    const { rows } = await db.query(
      `SELECT room_id, month, status, prob_space, heat, note FROM availability_overrides`);
    const map = {};
    for (const r of rows) map[`${r.room_id}:${r.month}`] = r;
    return map;
  } catch (e) { return {}; } // table may not exist in older/demo schemas
}

// ── core: forward availability with demand (enquiries + waitlist + taps) ─────
// Returns a per-month array of { month, rooms:[{room_id, room, status, prob_space,
// heat, full_time_only}] } — NO raw child counts leak out.
// opts.withMeta (manager board only): each cell also carries the computed
// (pre-override) values + override note, and each month carries raw loads.
async function computeAvailability(db, { fromY, fromM, months }, opts = {}) {
  const cfg = await loadSettings(db);
  const rooms = await loadRooms(db, cfg);
  const kids = await loadChildren(db);
  const patterns = await loadWeekdayPatterns(db);

  // Demand signal 1+2: active enquiries + active (non-parked) waitlist by room/month.
  const { rows: enq } = await db.query(`
    SELECT COALESCE(preferred_room, room_needed) AS room_name,
           TO_CHAR(COALESCE(preferred_start_date, start_date_requested), 'YYYY-MM') AS month
    FROM enquiries
    WHERE COALESCE(stage,'new') NOT IN ('registered','declined','lost')`);
  const { rows: wl } = await db.query(`
    SELECT room_needed AS room_name, TO_CHAR(expected_start_date,'YYYY-MM') AS month
    FROM waiting_list
    WHERE COALESCE(status,'waiting') NOT IN ('placed','declined','lost','withdrawn')
      AND COALESCE(tier,'active')='active'`);
  // Demand signal 3: recent parent interest taps (last 90d), DISTINCT device per slot.
  const { rows: taps } = await db.query(`
    SELECT room_id, month, COUNT(DISTINCT COALESCE(ip_hash, session_id, id::text))::int AS n
    FROM slot_interest
    WHERE created_at >= NOW() - INTERVAL '90 days'
    GROUP BY room_id, month`);

  const demand = {}; // `${roomId}:${month}` -> weighted demand
  const bump = (key, w) => { if (key) demand[key] = (demand[key] || 0) + w; };
  const roomIdFor = name => /pre|school/i.test(name || '') ? rooms.pre.id
    : /bab/i.test(name || '') ? rooms.baby.id : null;
  enq.forEach(e => { const id = roomIdFor(e.room_name); if (id && e.month) bump(`${id}:${e.month}`, 1); });
  wl.forEach(w => { const id = roomIdFor(w.room_name); if (id && w.month) bump(`${id}:${w.month}`, 1); });
  // Interest taps weighted lighter than a real enquiry (a tap ≠ a form) but still warm the slot.
  taps.forEach(t => { if (t.room_id && t.month) bump(`${t.room_id}:${t.month}`, Number(t.n) * 0.5); });

  const todayS = ymd(new Date());
  const bridged = bridgeBabyStarts(kids, rooms, cfg, todayS);
  const overrides = await loadOverrides(db);

  // Pass 1: raw monthly loads, one extra month for the Baby Room flex lookahead.
  const loads = [];
  for (let k = 0; k <= months; k++) {
    const d = new Date(Date.UTC(fromY, fromM + k, 1));
    const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const mid = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15));
    const label = d.toISOString().slice(0, 7), first = ymd(d), last = ymd(mEnd), midS = ymd(mid);

    let babyN = 0; const byDay = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0 };
    for (const c of kids) {
      const sd = bridged.get(c.id) || (c.start_date ? ymd(c.start_date) : null);
      const ld = effectiveLeave(c);
      if (!((!sd || sd <= last) && (!ld || ld >= first))) continue;
      if (ageMonths(c.dob, mid) >= cfg.school_start_age_months && !ld) continue; // aged out to school
      const room = roomAt(c, midS, last, rooms, cfg);
      if (room === 'baby') babyN++;
      else for (const wd of patternFor(patterns, c.id)) byDay[wd]++;
    }
    loads.push({ label, babyN, byDay });
  }

  const series = [];
  for (let k = 0; k < months; k++) {
    const L = loads[k], Lnext = loads[k + 1];
    const label = L.label;

    const cells = [rooms.baby, rooms.pre].map(r => {
      const isPre = r.id === rooms.pre.id;
      const load = isPre ? Math.max(...WEEKDAYS.map(wd => L.byDay[wd])) : L.babyN;
      let headroom = Math.max(0, r.cap - load);
      // Baby Room flex: an unpaired move-up next month can be brought forward
      // (~a month early), so next month's opening is reachable this month —
      // "a child going in April" = a space offered March–May.
      if (!isPre && Lnext) headroom = Math.max(headroom, Math.max(0, r.cap - Lnext.babyN));
      const dem = demand[`${r.id}:${label}`] || 0;
      const band = bandFor(load, r);
      // honest p(space): headroom shrinks as demand competes for it.
      const prob = headroom <= 0 ? 0 : Math.max(0, Math.min(1, (headroom - dem) / headroom));
      // heat: hotter with more demand relative to headroom; no headroom = max heat.
      const heat = headroom <= 0 ? 1 : Math.max(0, Math.min(1, dem / (headroom + dem || 1)));
      // Parent-facing status buckets (never expose raw counts).
      // 'full' means genuinely no physical space. A real opening that is heavily
      // contested shows as 'limited' with high heat + low prob — hiding it as
      // "full" would misstate the one thing parents come here for.
      let status;
      if (headroom <= 0 || band === 'over' || band === 'red') status = 'full';
      else if (headroom <= 2 || band === 'orange' || prob < 0.5) status = 'limited';
      else status = 'open';
      const cell = {
        room_id: r.id, room: r.name,
        full_time_only: r.id === rooms.baby.id,
        status,
        prob_space: Math.round(prob * 100) / 100,
        heat: Math.round(heat * 100) / 100,
      };
      // Manual override wins over the computed value (per-field: only set fields apply).
      const ov = overrides[`${r.id}:${label}`];
      if (ov) {
        if (opts.withMeta) {
          cell.computed = { status: cell.status, prob_space: cell.prob_space, heat: cell.heat };
          cell.override = { status: ov.status, prob_space: ov.prob_space === null ? null : Number(ov.prob_space), heat: ov.heat === null ? null : Number(ov.heat), note: ov.note };
        }
        if (ov.status) cell.status = ov.status;
        if (ov.prob_space !== null && ov.prob_space !== undefined) cell.prob_space = Math.round(Number(ov.prob_space) * 100) / 100;
        if (ov.heat !== null && ov.heat !== undefined) cell.heat = Math.round(Number(ov.heat) * 100) / 100;
      } else if (opts.withMeta) {
        cell.computed = { status: cell.status, prob_space: cell.prob_space, heat: cell.heat };
      }
      if (opts.withMeta) cell.load = load;
      return cell;
    });
    const monthRow = { month: label, rooms: cells };
    if (opts.withMeta) monthRow.loads = { baby: L.babyN, pre_by_day: L.byDay };
    series.push(monthRow);
  }
  return { generated: ymd(new Date()), from: series[0] && series[0].month, months, series };
}

// ── GET /api/public/availability ────────────────────────────────────────────
router.get('/api/public/availability', async (req, res) => {
  const db = require('../db/pool').getPool();
  try {
    const now = new Date();
    const fp = (req.query.from || '').match(/^(\d{4})-(\d{2})$/);
    const fromY = fp ? +fp[1] : now.getUTCFullYear();
    const fromM = fp ? +fp[2] - 1 : now.getUTCMonth();
    const months = Math.min(Math.max(parseInt(req.query.months) || 12, 1), 24);
    const out = await computeAvailability(db, { fromY, fromM, months });
    res.set('Cache-Control', 'public, max-age=120');
    res.json(out);
  } catch (e) {
    console.error('[public-availability]', e.message);
    res.status(500).json({ error: 'Could not load availability right now.' });
  }
});

// ── POST /api/public/slot-interest — record a tap, return the warmed slot ─────
const interestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 60,           // generous — taps are cheap, dedupe is by device
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
function hashIp(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const salt = process.env.SLOT_INTEREST_SALT || process.env.JWT_SECRET || 'ladn-slot';
  return ip ? crypto.createHash('sha256').update(ip + '|' + salt).digest('hex').slice(0, 40) : null;
}
router.post('/api/public/slot-interest', interestLimiter, async (req, res) => {
  const b = req.body || {};
  const month = (String(b.month || '').match(/^\d{4}-\d{2}$/) || [])[0];
  let roomId = parseInt(b.room_id);
  const db = require('../db/pool').getPool();
  try {
    // Accept a room name too (baby / pre-school) and resolve to id.
    if (!Number.isInteger(roomId) && b.room) {
      const cfg = await loadSettings(db);
      const rooms = await loadRooms(db, cfg);
      roomId = /pre|school/i.test(b.room) ? rooms.pre.id : /bab/i.test(b.room) ? rooms.baby.id : null;
    }
    if (!Number.isInteger(roomId) || !month) {
      return res.status(400).json({ error: 'room and month (YYYY-MM) required' });
    }
    const ipHash = hashIp(req);
    const sessionId = (typeof b.session_id === 'string') ? b.session_id.slice(0, 80) : null;
    const ua = (req.headers['user-agent'] || '').slice(0, 200) || null;
    // Dedupe: don't insert a second row for the same device+slot within 24h
    // (keeps the audit honest without letting one family spam the heat).
    const dupe = await db.query(`
      SELECT 1 FROM slot_interest
      WHERE room_id=$1 AND month=$2
        AND COALESCE(ip_hash,'')=COALESCE($3,'')
        AND created_at >= NOW() - INTERVAL '24 hours' LIMIT 1`, [roomId, month, ipHash]);
    if (!dupe.rows.length) {
      await db.query(`
        INSERT INTO slot_interest (room_id, month, source, ip_hash, session_id, user_agent)
        VALUES ($1,$2,'website',$3,$4,$5)`, [roomId, month, ipHash, sessionId, ua]);
    }
    // Return the freshly-recomputed slot so the UI can warm it live.
    const p = month.split('-');
    const out = await computeAvailability(db, { fromY: +p[0], fromM: +p[1] - 1, months: 1 });
    const cell = out.series[0] && out.series[0].rooms.find(r => r.room_id === roomId);
    res.json({ ok: true, counted: !dupe.rows.length, slot: cell || null });
  } catch (e) {
    console.error('[slot-interest]', e.message);
    res.status(500).json({ error: 'Could not record interest.' });
  }
});

// ── POST /api/public/keep-on-list — "keep me on the waiting list" (Parked) ───
const keepLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 8,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
function clean(v, maxLen) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s{3,}/g, ' ').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s || null;
}
function cleanDate(v) { const s = clean(v, 20); return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
function cleanMonthStart(v) { const s = clean(v, 7); return s && /^\d{4}-\d{2}$/.test(s) ? s + '-01' : null; }
function cleanDays(v) {
  if (!v) return null;
  let arr = Array.isArray(v) ? v : String(v).split(',');
  arr = arr.map(x => clean(x, 20)).filter(Boolean).slice(0, 7);
  return arr.length ? arr : null;
}
router.post('/api/public/keep-on-list', keepLimiter, async (req, res) => {
  const b = req.body || {};
  // Honeypot
  if (clean(b.company, 200) || clean(b.website_hp, 200)) return res.status(201).json({ ok: true });

  const parentName = clean(b.parent_name, 200);
  const parentEmail = clean(b.parent_email, 320);
  const parentPhone = clean(b.parent_phone, 50);
  if (!parentName || !parentEmail) return res.status(400).json({ error: 'Your name and email are required.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(parentEmail)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const childFirst = clean(b.child_first_name, 120);
  const childLast = clean(b.child_last_name, 120);
  const childDob = cleanDate(b.child_dob);
  let room = clean(b.preferred_room || b.room, 60);
  if (room) { const r = room.toLowerCase(); room = r.includes('baby') ? 'Baby Room' : r.includes('pre') ? 'Pre-school' : room; }
  const startReq = cleanDate(b.preferred_start_date || b.start_date_requested) || cleanMonthStart(b.month);
  const preferredDays = cleanDays(b.preferred_days || b.session);
  const notes = clean(b.notes || b.message, 2000);

  const db = require('../db/pool').getPool();
  try {
    const { rows } = await db.query(`
      INSERT INTO waiting_list
        (child_first_name, child_last_name, child_dob, room_needed,
         expected_start_date, parent_name, parent_email, parent_phone,
         source, status, tier, preferred_days, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'website','waiting','parked',$9,$10)
      RETURNING id`,
      // child_first_name / child_last_name are NOT NULL on waiting_list; a "keep me
      // on the list" parent may not give child details, so default to '' not null.
      [childFirst || '', childLast || '', childDob, room, startReq,
       parentName, parentEmail.toLowerCase(), parentPhone, preferredDays, notes]);
    const id = rows[0].id;

    // Best-effort low-key Telegram ping (parked = on-file, not urgent).
    const tgTok = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_CHAT_ID;
    if (tgTok && tgChat) {
      const childLabel = childFirst ? `${childFirst} ${childLast || ''}`.trim() : '(child not named)';
      const text = `📋 *Kept on the waiting list* (Parked)\n`
        + `Parent: ${parentName} <${parentEmail}>${parentPhone ? '\nPhone: ' + parentPhone : ''}\n`
        + `Child: ${childLabel}${childDob ? ' (DOB ' + childDob + ')' : ''}\n`
        + `${room ? 'Room: ' + room + '\n' : ''}${startReq ? 'Hoping for: ' + startReq + '\n' : ''}`
        + `They asked to stay on file in case a space opens.`;
      fetch(`https://api.telegram.org/bot${tgTok}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text, parse_mode: 'Markdown' }),
      }).catch(e => console.error('[keep-on-list] tg ping error:', e.message));
    }
    res.status(201).json({ ok: true, id });
  } catch (e) {
    console.error('[keep-on-list]', e.message);
    res.status(500).json({ error: 'Could not add you to the list. Please call or email us.' });
  }
});

module.exports = router;
// Re-used by src/routes/waitlist-board.js (manager board) — same maths, one source.
module.exports.computeAvailability = computeAvailability;
module.exports.bridgeBabyStarts = bridgeBabyStarts;
module.exports.loadSettings = loadSettings;
module.exports.loadRooms = loadRooms;
module.exports.helpers = { ymd, ageMonths, plusMonths, WEEKDAYS };
