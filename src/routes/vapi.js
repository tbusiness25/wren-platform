const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'Markdown' });
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      signal: AbortSignal.timeout(8000)
    });
  } catch(e) { console.error('telegram error:', e.message); }
}

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
  if (!transcript || !ANTHROPIC_KEY) return null;
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
router.post('/context', async (req, res) => {
  const db = getPool();
  const results = [];
  const toolCalls = req.body?.message?.toolCalls || [];
  const tcId = toolCalls[0]?.id || toolCalls[0]?.toolCallId || 'ctx';

  try {
    // baby room + pre-school occupancy today
    let babyToday = 0, psToday = 0;
    try {
      const r = await db.query(`
        SELECT c.room, COUNT(*)::int AS n
        FROM children c
        WHERE c.status = 'active'
        GROUP BY c.room
      `);
      for (const row of r.rows) {
        if (row.room === 'baby') babyToday = row.n;
        else if (row.room === 'preschool') psToday = row.n;
      }
    } catch(e) {}

    // waiting list counts
    let waitingBaby = 0, waitingPs = 0;
    try {
      const w = await db.query(`
        SELECT preferred_room, COUNT(*)::int AS n
        FROM enquiries
        WHERE stage IN ('on_waiting_list','registered')
        GROUP BY preferred_room
      `);
      for (const row of w.rows) {
        if (row.preferred_room === 'baby') waitingBaby = row.n;
        else if (row.preferred_room === 'preschool') waitingPs = row.n;
      }
    } catch(e) {}

    // away_mode — Toby's holiday/away state
    let awayMode = { active: false, return_date: null, cover_available_today: false };
    try {
      const am = await db.query(`
        SELECT active, return_date, cover_person_id FROM away_mode WHERE id = 1
      `);
      if (am.rows.length) {
        const row = am.rows[0];
        const todayDow = new Date().getDay(); // 0=Sun, 4=Thu
        const coverAvailable = row.active && row.cover_person_id !== null && todayDow !== 4;
        awayMode = {
          active: row.active,
          return_date: row.return_date ? row.return_date.toISOString().slice(0, 10) : null,
          cover_available_today: coverAvailable,
        };
      }
    } catch(e) {}

    // dnd — manager do-not-disturb toggle (settings key 'dnd')
    let dndActive = false;
    try { dndActive = await getDnd(db); } catch(e) {}

    const summary = {
      baby_room: {
        capacity: 10,
        registered: babyToday,
        waiting_list: waitingBaby,
        availability: 'Full-time places only. Next expected spaces Summer 2027.'
      },
      preschool: {
        capacity: 22,
        registered: psToday,
        waiting_list: waitingPs,
        availability: 'Very limited — only a two-day space available (Tuesday + Friday).'
      },
      away_mode: awayMode,
      dnd: { active: dndActive },
    };

    results.push({ toolCallId: tcId, result: JSON.stringify(summary) });
    res.json({ results });
  } catch (err) {
    console.error('aria context error:', err.message);
    results.push({ toolCallId: tcId, result: 'Unable to fetch live data right now — please confirm with the team.' });
    res.json({ results });
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
  if (!['manager','deputy_manager'].includes(req.user.role))
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
  if (!['manager', 'deputy_manager'].includes(req.user.role)) {
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
  if (req.user.role !== 'manager') return res.status(403).json({ error: 'Manager only' });
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
  if (req.user.role !== 'manager') return res.status(403).json({ error: 'Manager only' });
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
  if (req.user.role !== 'manager') return res.status(403).json({ error: 'Manager only' });
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
