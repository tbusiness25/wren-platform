'use strict';
// Telegram voice-note → transcript service (2026-07-01).
//
// Purpose: give the Telegram bot(s) a single, self-contained HTTP endpoint that
// turns a voice note into text via the existing wren-whisper service, so the
// downstream router can treat the transcript exactly like a typed message.
//
// This is the *transcription* half of "voice notes on the bot". Wiring it into
// the live n8n master router is a one-node change (POST here when message.voice
// is present, then feed { text } back into the normal message flow) — deliberately
// NOT done unattended, because live master-router surgery risks the bot fleet.
// See wren-docs decision log 2026-07-01.
//
// PUBLIC + secret-gated (like /api/kitchen/sensor-log): mounted before any auth.
// If TELEGRAM_VOICE_TOKEN is set, callers must send a matching x-voice-token header.

const express = require('express');
const router = express.Router();
const multer = require('multer');

const WHISPER_URL = process.env.WHISPER_URL || 'http://wren-whisper:9876';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function gateOk(req) {
  const gate = process.env.TELEGRAM_VOICE_TOKEN;
  return !gate || req.headers['x-voice-token'] === gate;
}

// Send an audio buffer to whisper (field name 'file', matching routes/transcribe.js).
async function whisperTranscribe(buf, mime, name) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'audio/ogg' }), name || 'voice.ogg');
  const wr = await fetch(`${WHISPER_URL}/transcribe`, { method: 'POST', body: fd, signal: AbortSignal.timeout(90000) });
  if (!wr.ok) { const b = await wr.text(); throw new Error(`whisper ${wr.status}: ${b}`); }
  const data = await wr.json();
  return { text: (data.text || '').trim(), duration: data.duration || null };
}

// POST /api/telegram-voice/transcribe
// Body: { file_id, bot_token? } — resolves the Telegram file, downloads the OGG
// voice note, and transcribes it. bot_token falls back to TELEGRAM_BOT_TOKEN.
// Returns { text, duration, chars }.
router.post('/transcribe', express.json(), async (req, res) => {
  if (!gateOk(req)) return res.status(401).json({ error: 'bad token' });
  const fileId = req.body && (req.body.file_id || req.body.fileId);
  const botToken = (req.body && req.body.bot_token) || process.env.TELEGRAM_BOT_TOKEN;
  if (!fileId) return res.status(400).json({ error: 'file_id required' });
  if (!botToken) return res.status(500).json({ error: 'no bot token configured' });
  try {
    // 1) getFile → file_path
    const gf = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: AbortSignal.timeout(15000) });
    const gfj = await gf.json();
    if (!gfj.ok) return res.status(502).json({ error: 'telegram getFile failed', detail: gfj.description });
    // 2) download the voice file (OGG/Opus)
    const dl = await fetch(`https://api.telegram.org/file/bot${botToken}/${gfj.result.file_path}`,
      { signal: AbortSignal.timeout(30000) });
    if (!dl.ok) return res.status(502).json({ error: 'telegram file download failed', status: dl.status });
    const buf = Buffer.from(await dl.arrayBuffer());
    // 3) whisper
    const out = await whisperTranscribe(buf, 'audio/ogg', 'voice.ogg');
    res.json({ ...out, chars: out.text.length });
  } catch (e) {
    console.error('[telegram-voice/transcribe]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/telegram-voice/transcribe-file — multipart passthrough (field 'file').
// For local testing / any caller that already has the audio bytes.
router.post('/transcribe-file', upload.single('file'), async (req, res) => {
  if (!gateOk(req)) return res.status(401).json({ error: 'bad token' });
  if (!req.file) return res.status(400).json({ error: 'file required (multipart field: file)' });
  try {
    const out = await whisperTranscribe(req.file.buffer, req.file.mimetype, req.file.originalname);
    res.json({ ...out, chars: out.text.length });
  } catch (e) {
    console.error('[telegram-voice/transcribe-file]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
