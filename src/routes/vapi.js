const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// login-20261023: through the one Telegram sender (src/lib/notifications.js) — same text and format,
// plus its dev/MAIL_DISABLED guard, which this private copy never had.
async function sendTelegram(text) { return require('../lib/notifications').sendTelegramNow({ text, parse_mode: 'Markdown' }); }

// DND ("do not disturb") — settings key 'dnd' = 'on'|'off'. When ON: James offers
// the deputy (deputy, baby room) instead of Toby, and manager Telegram pings are
// suppressed (except urgent/safeguarding). Toggled from Roost → System. 2026-07-08.
async function getDnd(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='dnd'`);
    return (rows[0] && rows[0].value) === 'on';
  } catch { return false; }
}

async function aiSummary(transcript) {
  if (!transcript) return null;
  // 2026-10-08: call transcripts name families — keep them on the local model when the
  // edition is sovereign (AI_PROVIDER=ollama), same rule as planning.js.
  if (String(process.env.AI_PROVIDER || '').toLowerCase() === 'ollama') {
    try {
      const t = await require('../lib/sovereign-model').generate({ numPredict: 120, temperature: 0.2, timeoutMs: 60000,
        prompt: `Summarise this nursery call transcript in one sentence, noting the caller's name if mentioned and what they wanted:\n\n${transcript.slice(0, 2000)}` });
      return t.trim() || null;
    } catch (e) { console.error('ai summary (local) error:', e.message); return null; }
  }
  if (!ANTHROPIC_KEY) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{ role: 'user', content: `Summarise this nursery call transcript in one sentence, noting the caller's name if mentioned and what they wanted:\n\n${transcript.slice(0, 2000)}` }]
      }),
      signal: AbortSignal.timeout(15000)
    });
    const d = await r.json();
    return d.content?.[0]?.text || null;
  } catch(e) { console.error('ai summary error:', e.message); return null; }
}

// 2026-10-26: James's two Wren tools (notifyManager, getLiveData) were open to anyone who
// found the URL. Same shared secret as /webhook: Vapi sends it as the x-vapi-secret header
// (set on each tool's server.headers). A no-op until VAPI_WEBHOOK_SECRET is set.
function vapiSecretOk(req) {
  const s = process.env.VAPI_WEBHOOK_SECRET;
  return !s || req.headers['x-vapi-secret'] === s;
}

// POST /api/vapi/webhook — public endpoint, no auth (Vapi calls this)
router.post('/webhook', async (req, res) => {
  // 2026-06-16 audit: optional shared-secret gate (no-op until VAPI_WEBHOOK_SECRET is set,
  // so it cannot break the not-yet-configured Vapi integration). Set the env + the matching
  // x-vapi-secret header in the Vapi dashboard to harden against forged call records/Telegram.
  const VAPI_SECRET = process.env.VAPI_WEBHOOK_SECRET;
  if (VAPI_SECRET && req.headers['x-vapi-secret'] !== VAPI_SECRET) {
    return res.status(401).json({ error: 'unauthorised' });
  }
  const db = getPool();
  res.json({ ok: true });

  try {
    const evt = req.body;
    const msgType = evt.message?.type || evt.type || 'unknown';
    const call = evt.message?.call || evt.call || {};
    const callId = call.id || evt.id;
    if (!callId) return;

    const startedAt  = call.startedAt  || new Date().toISOString();
    const endedAt    = call.endedAt    || null;
    const duration   = Math.round(call.duration || 0);
    const fromNumber = call.customer?.number || call.from || null;
    const toNumber   = call.phoneNumber?.number || call.to || null;
    const endedReason= evt.message?.endedReason || call.endedReason || 'unknown';
    const artifact   = evt.message?.artifact || {};
    const analysis   = evt.message?.analysis || {};
    const transcript = artifact.transcript || evt.message?.transcript || null;
    const vapiSummary= analysis.summary || evt.message?.summary || null;
    const urgency    = analysis.structuredData?.urgency || null;

    let outcome = 'completed';
    if (endedReason.includes('transfer')) outcome = 'transferred';
    else if (endedReason.includes('voicemail') || endedReason.includes('vm')) outcome = 'voicemail';
    else if (endedReason.includes('silence') || endedReason.includes('abandon') || endedReason.includes('hang')) outcome = 'missed';
    else if (endedReason.includes('error')) outcome = 'error';

    let aiSum = vapiSummary;
    if (!aiSum && transcript && msgType === 'end-of-call-report') {
      aiSum = await aiSummary(transcript);
    }

    // Save to DB
    try {
      await db.query(
        `INSERT INTO vapi_calls (id, started_at, ended_at, duration_seconds, from_number, to_number, outcome, ended_reason, transcript, summary, urgency, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE
           SET ended_at=EXCLUDED.ended_at, duration_seconds=EXCLUDED.duration_seconds,
               outcome=EXCLUDED.outcome, ended_reason=EXCLUDED.ended_reason,
               transcript=EXCLUDED.transcript, summary=EXCLUDED.summary,
               urgency=EXCLUDED.urgency, raw=EXCLUDED.raw`,
        [callId, startedAt, endedAt, duration, fromNumber, toNumber, outcome, endedReason, transcript, aiSum, urgency, evt]
      );
    } catch(dbErr) {
      console.error('vapi DB error:', dbErr.message);
    }

    if (msgType === 'end-of-call-report') {
      const from = fromNumber || 'Unknown number';
      const dur  = duration ? `${Math.floor(duration/60)}m ${duration%60}s` : '–';

      // Notification policy (Toby, 2026-07-06): default 'messages_only' — only
      // ping Telegram when someone actually LEFT A MESSAGE (voicemail) or Aria
      // invoked notifyManager. Every call is still logged to vapi_calls, so the
      // digest/cockpit summaries see the full picture without the ping noise.
      // Change: UPDATE ladn.settings SET value='all' WHERE key='vapi_notify_mode'
      let notifyMode = 'messages_only';
      try {
        const { rows: nm } = await getPool().query(`SELECT value FROM settings WHERE key='vapi_notify_mode'`);
        if (nm[0] && nm[0].value) notifyMode = nm[0].value;
      } catch (e) { /* keep default */ }

      if (outcome === 'voicemail') {
        await sendTelegram(`📬 *Voicemail left*\nFrom: \`${from}\`\nDuration: ${dur}${transcript ? '\n📝 ' + transcript.slice(0,200) : ''}${aiSum ? '\n💬 ' + aiSum : ''}`);
      } else if (notifyMode === 'all') {
        if (outcome === 'transferred') {
          const dest = call.destination?.number || evt.message?.destination?.number || '?';
          const room = dest.includes('1754962') ? 'Baby Room' : dest.includes('1754963') ? 'Pre-school' : dest.includes('510349') ? 'Office' : dest;
          await sendTelegram(`📞 *Call transferred to ${room}*\nFrom: \`${from}\`\nDuration: ${dur}${aiSum ? '\n💬 ' + aiSum : ''}`);
        } else if (outcome === 'missed') {
          await sendTelegram(`📵 *Missed call*\nFrom: \`${from}\`\nReason: ${endedReason}`);
        } else if (outcome === 'completed') {
          await sendTelegram(`✅ *Call completed*\nFrom: \`${from}\`\nDuration: ${dur}${aiSum ? '\n💬 ' + aiSum : ''}`);
        }
      }
    }

    if (msgType === 'function-call' && evt.message?.functionCall?.name === 'notifyManager') {
      const args = evt.message.functionCall.parameters || {};
      const urg = args.urgency || 'normal';
      const msg = args.message || '(no message)';
      const emoji = urg === 'urgent' ? '🚨' : '📞';
      await sendTelegram(`${emoji} *Manager notification (${urg})*\nFrom: \`${fromNumber || 'unknown'}\`\n${msg}`);
    }

  } catch (err) {
    console.error('vapi webhook error:', err.message);
  }
});


// ─── Public Vapi tool endpoints — called directly by Aria ───────────────────
// These match the URLs configured in the Vapi assistant tool definitions.

// POST /api/vapi/notify-manager — invoked when Aria calls the notifyManager tool
router.post('/notify-manager', async (req, res) => {
  if (!vapiSecretOk(req)) return res.status(401).json({ error: 'unauthorised' });
  try {
    // Vapi sends { message: { toolCalls: [ { id, function: { name, arguments } } ] } }
    const toolCalls = req.body?.message?.toolCalls || [];
    const results = [];

    for (const tc of toolCalls) {
      const tcId = tc.id || tc.toolCallId;
      let args = {};
      try {
        args = typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : (tc.function?.arguments || {});
      } catch (e) { args = {}; }

      const urg = args.urgency || 'normal';
      const msg = args.message || '(no message)';
      const caller = req.body?.message?.call?.customer?.number
                  || req.body?.call?.customer?.number
                  || 'unknown';
      const emoji = urg === 'urgent' ? '🚨' : urg === 'low' ? '📝' : '📞';

      // DND: suppress non-urgent manager pings; urgent/safeguarding always gets through
      const dnd = await getDnd(getPool());
      if (dnd && urg !== 'urgent') {
        results.push({ toolCallId: tcId, result: 'Noted — the manager is unavailable right now; the message has been logged for review.' });
        continue;
      }

      try {
        await sendTelegram(`${emoji} *Manager notification (${urg})*\nFrom: \`${caller}\`\n${msg}`);
      } catch (tgErr) {
        console.error('notify-manager telegram error:', tgErr.message);
      }
      // 2026-10-01 — the same note in Wren, so it is on record and in the bell, not only
      // in Telegram. In-app only: 'vapi_call' is not on the dispatcher's email allowlist.
      try {
        const { notify } = require('../services/notification-dispatcher');
        const sid = Number((await getPool().query(`SELECT value FROM settings WHERE key='call_notify_staff_id'`)).rows[0]?.value) || 1;
        notify('vapi_call', 'staff', sid, `${urg === 'urgent' ? 'Urgent call' : 'Call'}: ${String(msg).slice(0, 80)}`,
          `${msg}\nFrom ${caller}`, { priority: urg === 'urgent' ? 'high' : 'normal', link: '/communications.html' });
      } catch (nErr) {
        console.error('notify-manager in-app error:', nErr.message);
      }

      results.push({ toolCallId: tcId, result: 'Manager has been notified.' });
    }

    // Vapi expects { results: [ { toolCallId, result } ] }
    res.json({ results });
  } catch (err) {
    console.error('notify-manager error:', err.message);
    res.status(200).json({ results: [] });  // return 200 so Aria doesn't retry-loop
  }
});

// POST /api/vapi/context (also available via /api/aria/context alias) — live data
// b330 (2026-09-15): James read children.room / children.status for "registered"
// counts. Neither holds a child's room any more (child_bookings does), so he was
// told the Baby Room had 0 children, alongside hard-coded availability text that
// had gone stale. He now gets the website's own availability engine.
const PUBLIC_AVAIL = require('./public-availability');
let _availCache = { at: 0, data: null };
async function availabilitySummary(db) {
  if (_availCache.data && Date.now() - _availCache.at < 120000) return _availCache.data;
  const now = new Date();
  const out = await PUBLIC_AVAIL.computeAvailability(db,
    { fromY: now.getUTCFullYear(), fromM: now.getUTCMonth(), months: 12 });
  const rooms = {};
  for (const m of out.series || []) {
    const label = new Date(m.month + '-15T12:00:00Z')
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    for (const c of m.rooms || []) {
      const key = /bab/i.test(c.room) ? 'baby_room' : 'preschool';
      rooms[key] = rooms[key] || { room: c.room, full_time_only: !!c.full_time_only, months: [], next_month_with_space: null };
      rooms[key].months.push(`${label}: ${c.status}`);
      if (!rooms[key].next_month_with_space && c.status !== 'full') rooms[key].next_month_with_space = label;
    }
  }
  for (const r of Object.values(rooms)) {
    if (!r.next_month_with_space) r.next_month_with_space = 'none in the next 12 months: offer the waiting list';
  }
  _availCache = { at: Date.now(), data: rooms };
  return rooms;
}
function ukNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  const wd = get('weekday'), hh = parseInt(get('hour'), 10);
  return {
    text: `${wd} ${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')}`,
    open: !['Saturday', 'Sunday'].includes(wd) && hh >= 8 && hh < 18,
  };
}

router.post('/context', async (req, res) => {
  if (!vapiSecretOk(req)) return res.status(401).json({ error: 'unauthorised' });
  const db = getPool();
  const results = [];
  const toolCalls = req.body?.message?.toolCalls || [];
  const tcId = toolCalls[0]?.id || toolCalls[0]?.toolCallId || 'ctx';

  try {
    // away_mode — Toby's holiday/away state
    let awayMode = { active: false, return_date: null, cover_available_today: false, cover: null, message: null };
    try {
      const am = await db.query(`
        SELECT am.active, am.return_date, am.cover_person_id, am.notify_callers,
               s.first_name, s.last_name, s.role, r.name AS room_name
          FROM away_mode am
          LEFT JOIN staff s ON s.id = am.cover_person_id
          LEFT JOIN rooms r ON r.id = s.room_id
         WHERE am.id = 1
      `);
      // notify_callers gates whether James/Vapi mentions the away state at all.
      // If away mode is on but this toggle is off, callers hear nothing about leave.
      if (am.rows.length && am.rows[0].notify_callers !== false) {
        const row = am.rows[0];
        const todayDow = new Date().getDay(); // 0=Sun, 4=Thu
        const coverAvailable = row.active && row.cover_person_id !== null && todayDow !== 4;
        const rd = row.return_date ? row.return_date.toISOString().slice(0, 10) : null;
        const roleLabel = (row.role || '').replace(/_/g, ' ');
        awayMode = {
          active: row.active,
          return_date: rd,
          cover_available_today: coverAvailable,
          cover: row.cover_person_id ? {
            name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
            first_name: row.first_name || null,
            role: roleLabel || null,
            room: row.room_name || null,
          } : null,
          // ready-made line for James to speak when active
          message: row.active
            ? `Toby is on annual leave${rd ? ` and will be back on ${rd}` : ''}. `
              + (row.first_name
                  ? `In the meantime you're welcome to speak to ${row.first_name}, our ${roleLabel || 'deputy manager'}${row.room_name ? ` in the ${row.room_name}` : ''}. `
                  : '')
              + `If you're calling about a place for your child, you can see our live availability and send an enquiry on our website at our website — I can also text you the links if that's easier.`
            : null,
          // For a Vapi tool / SMS follow-up when a caller wants a space.
          enquiry_url: 'https://example-nursery.co.uk/enquiry',
          availability_url: 'https://example-nursery.co.uk/availability.html',
        };
      }
    } catch(e) {}

    // dnd — manager do-not-disturb toggle (settings key 'dnd')
    let dndActive = false;
    try { dndActive = await getDnd(db); } catch(e) {}

    // b330 (2026-09-15): the same availability the website shows, plus the UK
    // time, so James can judge opening hours and never quotes a stale space.
    // 2026-10-01 — who works here, so James can confirm a name when a caller asks
    // for someone ("can I speak to the office manager?") instead of saying nobody of that name
    // works here. First names, role and room only: the prompt forbids surnames, and
    // nothing here says who is in today. Read live, so it follows ladn.staff.
    let staff = [];
    try {
      const { rows } = await db.query(`
        SELECT s.first_name, s.role, r.name AS room
          FROM staff s LEFT JOIN rooms r ON r.id = s.room_id
         WHERE s.is_active = true AND COALESCE(s.role, '') <> 'parent'
           AND COALESCE(btrim(s.first_name), '') <> ''
         ORDER BY s.first_name`);
      staff = rows.map(r => ({ first_name: r.first_name, role: String(r.role || '').replace(/_/g, ' '), room: r.room || null }));
    } catch (e) { console.error('[vapi/context] staff:', e.message); }

    const clock = ukNow();
    let availability = null;
    try { availability = await availabilitySummary(db); }
    catch (e) { console.error('[vapi/context] availability:', e.message); }
    const summary = {
      now_uk: clock.text,
      open_now: clock.open,
      availability: availability
        || 'Not available right now. Point the caller to example-nursery.co.uk/availability.html and take their details.',
      availability_notes: 'This is exactly what the availability page on the website shows. full = no space that month. '
        + 'limited = a few days may be free, not every day. Never promise a space: take the family\'s details for the '
        + 'waiting list and say Toby or the deputy will confirm. The Baby Room takes full-time places only.',
      availability_url: 'https://example-nursery.co.uk/availability.html',
      away_mode: awayMode,
      dnd: { active: dndActive },
      staff,
      staff_notes: 'Everyone who works at the nursery now. If a caller asks for someone on this list, confirm they work here '
        + 'and offer to put them through to the office or take a message. Never give surnames, rotas or whether someone is in today.',
    };

    results.push({ toolCallId: tcId, result: JSON.stringify(summary) });
    res.json({ results });
  } catch (err) {
    console.error('aria context error:', err.message);
    results.push({ toolCallId: tcId, result: 'Unable to fetch live data right now — please confirm with the team.' });
    res.json({ results });
  }
});

// POST /api/vapi/viewing-slots — getLiveData for James to offer the next open
// viewing slots on a call (b336, 2026-09-17). Read-only, same no-auth shape as
// /context above (unauthenticated caller = Vapi's webhook infra, not a browser).
// NOTE for whoever wires this into the live Vapi assistant: James's prompt
// currently free-texts "usually Tuesday or Thursday 2-3pm" — see
// /app/logs/b336-viewings.NOTES.md for the exact prompt change this
// endpoint is meant to replace that line with. Nothing about the live Vapi
// assistant config is touched by this build.
router.post('/viewing-slots', async (req, res) => {
  const toolCalls = req.body?.message?.toolCalls || [];
  const tcId = toolCalls[0]?.id || toolCalls[0]?.toolCallId || 'ctx';
  try {
    const { nextOpenSlots } = require('../lib/viewings-shared');
    const db = getPool();
    const slots = await nextOpenSlots(db, { limit: 5 });
    const spoken = slots.map(s => {
      const d = new Date(s.date + 'T12:00:00');
      const dayLabel = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      return `${s.room_name} on ${dayLabel} at ${s.start_time}`;
    });
    const summary = {
      next_viewing_slots: spoken,
      note: spoken.length
        ? 'Offer these in order. Take the family\'s name, phone/email and which child\'s room. Do not confirm the slot yourself — say the room will confirm it and they will get an email.'
        : 'No open slots found in the next 60 days — take the family\'s details and say the office will call them back.',
    };
    res.json({ results: [{ toolCallId: tcId, result: JSON.stringify(summary) }] });
  } catch (err) {
    console.error('[vapi/viewing-slots]', err.message);
    res.json({ results: [{ toolCallId: tcId, result: 'Unable to fetch viewing slots right now — take the family\'s details and say the office will call back.' }] });
  }
});

// POST /api/vapi/calls/:id/to-comms — push a stored call into the unified comms hub
// (contacts/threads/thread_messages, source='vapi_call'). Called by the n8n
// vapi-event-router for calls that carry a real message. Public (matches
// notify-manager/context): it only copies data already in vapi_calls, and is
// idempotent on thread_messages.vapi_call_id. 2026-07-08.
router.post('/calls/:id/to-comms', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id, from_number, started_at, summary, transcript FROM vapi_calls WHERE id=$1`,
      [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'call not found' });
    const call = rows[0];

    const dup = await db.query(
      `SELECT 1 FROM thread_messages WHERE vapi_call_id=$1 LIMIT 1`, [call.id]);
    if (dup.rows.length) return res.json({ ok: true, duplicate: true });

    // caller name from the structured summary's WHO line, if it gave one
    let name = null;
    const who = /WHO:\s*([^\n]+)/i.exec(call.summary || '');
    if (who && !/unknown|didn.?t say|not given|n\/a/i.test(who[1])) {
      name = who[1].split(/[–-]/)[0].trim().slice(0, 80) || null;
    }

    const { upsertContact, upsertThread, insertThreadMessage } = require('./contacts');
    const contactId = await upsertContact(db, { phone: call.from_number || null, name });
    // upgrade a backfill placeholder name ("Caller +44…") now the caller gave a real one
    if (name) {
      await db.query(
        `UPDATE contacts SET full_name=$1 WHERE id=$2 AND (full_name IS NULL OR full_name LIKE 'Caller %')`,
        [name, contactId]);
    }
    const threadId  = await upsertThread(db, contactId, 'Phone call');
    await insertThreadMessage(db, {
      threadId, direction: 'in', source: 'vapi_call',
      bodyText: call.summary || '(no summary — see call record)',
      senderPhone: call.from_number || null,
      createdAt: call.started_at || new Date(),
      vapiCallId: call.id,
    });
    res.json({ ok: true, contact_id: contactId, thread_id: threadId });
  } catch (e) {
    console.error('vapi to-comms error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.use(authenticate);

// GET /api/vapi/dnd — current do-not-disturb state (any staff)
router.get('/dnd', async (req, res) => {
  try { res.json({ active: await getDnd(getPool()) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/vapi/dnd {active: true|false} — manager toggle
router.put('/dnd', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin']))
    return res.status(403).json({ error: 'Manager only' });
  const active = !!(req.body && req.body.active);
  try {
    await getPool().query(`
      INSERT INTO settings (key, value, updated_by, updated_at)
      VALUES ('dnd', $1, $2, now())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()
    `, [active ? 'on' : 'off', req.user.id]);
    res.json({ ok: true, active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/vapi/calls
router.get('/calls', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT vc.*, s.first_name || ' ' || s.last_name AS reviewed_by_name
       FROM vapi_calls vc LEFT JOIN staff s ON s.id = vc.reviewed_by
       ORDER BY vc.started_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    console.error('vapi calls GET error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/vapi/calls/:id/reviewed
router.post('/calls/:id/reviewed', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE vapi_calls SET reviewed_by = $1, reviewed_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('vapi reviewed error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/vapi/pending-callbacks — calls needing a callback (last 48h, not transferred, not smoke-test)
router.get('/pending-callbacks', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id, from_number, summary, started_at, ended_at, outcome, urgency
       FROM vapi_calls
       WHERE started_at > now() - interval '48 hours'
         AND from_number != '+441208000001'
         AND outcome != 'transferred'
         AND callback_handled_at IS NULL
         AND archived_at IS NULL
         AND summary IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 10`
    );
    res.json(rows);
  } catch (err) {
    console.error('pending callbacks error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/vapi/calls/:id/archive — hide a call from the cockpit without deleting
// (2026-07-03, Toby item 12: act on calls in-place from the cockpit popup)
router.post('/calls/:id/archive', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE vapi_calls SET archived_at = now(), archived_by = $1 WHERE id = $2 RETURNING id, archived_at`,
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('vapi archive error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// DELETE /api/vapi/calls/:id — permanent delete, managers only
router.delete('/calls/:id', async (req, res) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Managers only' });
  }
  const db = getPool();
  try {
    const { rows } = await db.query(
      `DELETE FROM vapi_calls WHERE id = $1 RETURNING id`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted: rows[0].id });
  } catch (err) {
    console.error('vapi delete error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/vapi/calls/:id/escalate — flag urgent + notify all managers
router.post('/calls/:id/escalate', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE vapi_calls SET urgency = 'high', notes = COALESCE(notes,'') ||
        E'\nEscalated by staff #' || $1 || ' at ' || now()::text
       WHERE id = $2 RETURNING id, from_number, summary`,
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    try {
      const { notify } = require('../services/notification-dispatcher');
      notify('call_escalated', 'all-managers', null,
        `📞 Call escalated: ${rows[0].from_number || 'unknown number'}`,
        (rows[0].summary || '').slice(0, 200),
        { relatedTable: 'vapi_calls', relatedId: rows[0].id, link: '/aria.html', priority: 'high' });
    } catch (_) {}
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('vapi escalate error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/vapi/calls/:id/callback-handled — mark a call as handled
router.post('/calls/:id/callback-handled', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE vapi_calls SET callback_handled_at = now() WHERE id = $1 RETURNING id, callback_handled_at`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('callback handled error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/vapi/calls/:id/audio — stream local recording (auth required)
router.get('/calls/:id/audio', async (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const db   = getPool();
  try {
    const { rows: [call] } = await db.query(
      `SELECT audio_local_path, audio_download_status FROM vapi_calls WHERE id = $1`,
      [req.params.id]
    );
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (call.audio_download_status !== 'downloaded' || !call.audio_local_path) {
      return res.status(404).json({ error: 'Audio not available', status: call.audio_download_status });
    }
    if (!fs.existsSync(call.audio_local_path)) {
      return res.status(404).json({ error: 'Audio file missing from disk' });
    }
    const stat = fs.statSync(call.audio_local_path);
    const ext  = path.extname(call.audio_local_path).toLowerCase();
    const mimeTypes = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
    const contentType = mimeTypes[ext] || 'audio/wav';

    const range = req.headers.range;
    if (range) {
      const parts  = range.replace(/bytes=/, '').split('-');
      const start  = parseInt(parts[0], 10);
      const end    = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   contentType,
      });
      fs.createReadStream(call.audio_local_path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type':   contentType,
        'Accept-Ranges':  'bytes',
      });
      fs.createReadStream(call.audio_local_path).pipe(res);
    }
  } catch (err) {
    console.error('vapi audio serve error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/vapi/calls/:id/safeguarding — flag or unflag a call
router.post('/calls/:id/safeguarding', async (req, res) => {
  if (!hasRole(req.user, ['manager', 'admin'])) return res.status(403).json({ error: 'Manager only' });
  const { flagged, notes } = req.body;
  const db = getPool();
  try {
    const { rows: [call] } = await db.query(
      `UPDATE vapi_calls
       SET safeguarding_flagged    = $1,
           safeguarding_flagged_by = CASE WHEN $1 THEN $2 ELSE NULL END,
           safeguarding_flagged_at = CASE WHEN $1 THEN now() ELSE NULL END,
           notes                   = COALESCE($3, notes)
       WHERE id = $4 RETURNING *`,
      [!!flagged, req.user.id, notes || null, req.params.id]
    );
    if (!call) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, safeguarding_flagged: call.safeguarding_flagged });
  } catch (err) {
    console.error('vapi safeguarding error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/vapi/daily-digest — manually trigger the daily digest
router.post('/daily-digest', async (req, res) => {
  if (!hasRole(req.user, ['manager', 'admin'])) return res.status(403).json({ error: 'Manager only' });
  try {
    const { runDailyDigest } = require('../workers/vapi-daily-digest');
    const result = await runDailyDigest();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('manual digest error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vapi/audio-pull — manually trigger audio download batch
router.post('/audio-pull', async (req, res) => {
  if (!hasRole(req.user, ['manager', 'admin'])) return res.status(403).json({ error: 'Manager only' });
  try {
    const { runAudioPull } = require('../workers/vapi-audio-pull');
    const result = await runAudioPull();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('manual audio pull error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Dograh-compatible endpoints ─────────────────────────────────────────────
// Dograh uses standard OpenAI function-call format (POST body with named args).
// These wrap the existing handlers with Dograh's expected response shape { result }.

// POST /api/vapi/dograh/context — getLiveData tool for Dograh (no auth required)
router.post('/dograh/context', async (req, res) => {
  const db = getPool();
  try {
    const { rows: children } = await db.query(
      `SELECT room, COUNT(*) AS count FROM children WHERE is_active = true GROUP BY room`);
    const capacity = { baby_room: 10, pre_school: 22 };
    const occ = {};
    children.forEach(r => { occ[r.room] = parseInt(r.count); });

    const { rows: enq } = await db.query(
      `SELECT room, COUNT(*) AS cnt FROM enquiries WHERE status IN ('new','contacted','touring') GROUP BY room`);
    const enquiries = {};
    enq.forEach(r => { enquiries[r.room] = parseInt(r.cnt); });

    const { rows: [away] } = await db.query(
      `SELECT active, return_date FROM away_mode WHERE id = 1`).catch(() => ({ rows: [null] }));

    const result = {
      baby_room: { capacity: capacity.baby_room, registered: occ.baby_room || 0, spaces: capacity.baby_room - (occ.baby_room || 0) },
      pre_school: { capacity: capacity.pre_school, registered: occ.pre_school || 0, spaces: capacity.pre_school - (occ.pre_school || 0) },
      active_enquiries: enquiries,
      away_mode: away || { active: false }
    };
    res.json({ result });
  } catch (err) {
    console.error('dograh context error:', err.message);
    res.status(500).json({ result: 'error retrieving live data' });
  }
});

// POST /api/vapi/dograh/notify-manager — notifyManager tool for Dograh (no auth required)
router.post('/dograh/notify-manager', async (req, res) => {
  const { message, urgency = 'normal' } = req.body;
  const emoji = urgency === 'urgent' ? '🚨' : urgency === 'low' ? 'ℹ️' : '📋';
  try {
    await sendTelegram(`${emoji} *Manager notification (${urgency})*\n${message || '(no message)'}`);
    res.json({ result: 'Manager notified.' });
  } catch (err) {
    console.error('dograh notify-manager error:', err.message);
    res.status(500).json({ result: 'notification failed' });
  }
});


// POST /api/vapi/dograh/transfer-baby-room — transfer to Baby Room for Dograh (no auth required)
router.post('/dograh/transfer-baby-room', async (req, res) => {
  try {
    await sendTelegram('\U0001F37C *Aria transfer request*\nCaller asked to be put through to the Baby Room. Please pick up or call back shortly.');
    res.json({ result: 'Transfer initiated. Baby room staff have been notified via Telegram.' });
  } catch (err) {
    console.error('dograh transfer-baby-room error:', err.message);
    res.status(500).json({ result: 'Unable to reach baby room staff right now. Please try calling the nursery directly.' });
  }
});

// POST /api/vapi/dograh/transfer-preschool — transfer to Pre-school for Dograh (no auth required)
router.post('/dograh/transfer-preschool', async (req, res) => {
  try {
    await sendTelegram('\U0001F3A8 *Aria transfer request*\nCaller asked to be put through to the Pre-school. Please pick up or call back shortly.');
    res.json({ result: 'Transfer initiated. Pre-school staff have been notified via Telegram.' });
  } catch (err) {
    console.error('dograh transfer-preschool error:', err.message);
    res.status(500).json({ result: 'Unable to reach pre-school staff right now. Please try calling the nursery directly.' });
  }
});

module.exports = router;
