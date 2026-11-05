'use strict';
const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const WHISPER_URL = process.env.WHISPER_URL || 'http://wren-whisper:9876';

// Forward a saved audio file to the whisper STT service and return the transcript.
// Mirrors the contract in src/routes/transcribe.js (POST /transcribe, field "file").
async function whisperTranscribe(filePath, mimeType) {
  const buf = await fs.promises.readFile(filePath);
  const ext = (mimeType || '').includes('mp4') ? 'recording.mp4'
            : (mimeType || '').includes('ogg') ? 'recording.ogg'
            : (mimeType || '').includes('wav') ? 'recording.wav'
            : 'recording.webm';
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mimeType || 'audio/webm' }), ext);
  const r = await fetch(`${WHISPER_URL}/transcribe`, {
    method: 'POST', body: fd, signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error(`whisper ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const data = await r.json();
  return (data.text || '').trim();
}

// Disk storage: /app/uploads/voice-notes/{user_id}/{timestamp}.{ext}
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const uid = req.user ? String(req.user.id) : 'unknown';
    const dir = path.join('/app/uploads/voice-notes', uid);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = file.mimetype.includes('mp4') ? 'mp4' :
                file.mimetype.includes('ogg') ? 'ogg' : 'webm';
    cb(null, `${Date.now()}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter(_req, file, cb) {
    if (!file.mimetype.startsWith('audio/')) {
      return cb(Object.assign(new Error('Not an audio file'), { status: 400 }));
    }
    cb(null, true);
  },
});

router.use(authenticate);

// POST /api/voice-notes/upload
router.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    // Parse context
    let ctx = {};
    try { ctx = JSON.parse(req.body.context || '{}'); } catch {
      return res.status(400).json({ error: 'Invalid context JSON' });
    }

    const pool = getPool();

    // Optional child name for n8n payload. Also validates the link: if the child_id
    // isn't a real child, drop it so the note still saves (avoids an FK 500 / opaque
    // "Upload failed" when the page passes a stale or unknown child id). NB children
    // has no full_name column — build it from preferred_name/first_name + last_name.
    let childName = null;
    if (ctx.child_id) {
      try {
        const r = await pool.query(
          "SELECT trim(COALESCE(preferred_name, first_name, '') || ' ' || COALESCE(last_name, '')) AS full_name " +
          "FROM children WHERE id=$1",
          [ctx.child_id]
        );
        if (r.rows[0]) childName = r.rows[0].full_name || null;
        else ctx.child_id = null;
      } catch { ctx.child_id = null; }
    }

    const staffId = req.user.id;
    const audioPath = req.file.path;

    // Insert DB row
    const { rows } = await pool.query(`
      INSERT INTO voice_notes
        (recorded_by, child_id, source_url, source_page, audio_path,
         duration_ms, mime_type, size_bytes, recorded_at, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
      RETURNING id`,
      [
        staffId,
        ctx.child_id || null,
        ctx.source_url || null,
        ctx.source_page || null,
        audioPath,
        ctx.duration_ms || null,
        req.file.mimetype,
        req.file.size,
        ctx.recorded_at ? new Date(ctx.recorded_at) : new Date(),
      ]
    );

    const noteId = rows[0].id;

    // ── Synchronous transcription via whisper ─────────────────────────────────
    // Previously the only processing path was the n8n webhook below, which is
    // unconfigured in this deployment (N8N_VOICE_NOTE_WEBHOOK_URL unset) — so the
    // floating mic recorded + saved but the user never got any text back, i.e. it
    // "didn't work". Transcribe inline so the mic works standalone; the webhook
    // still fires (additive) for richer async classification/draft creation when set.
    let transcript = null, transcribeError = null;
    try {
      transcript = await whisperTranscribe(audioPath, req.file.mimetype);
      await pool.query(
        "UPDATE voice_notes SET transcript=$1, transcribed_at=now(), status='transcribed' WHERE id=$2",
        [transcript, noteId]
      );
    } catch (e) {
      transcribeError = e.message;
      console.warn('[voice-notes] whisper transcription failed (note saved as pending):', e.message);
    }

    // Fire n8n webhook (async — don't block response)
    const webhookUrl = process.env.N8N_VOICE_NOTE_WEBHOOK_URL;
    if (webhookUrl) {
      const payload = {
        voice_note_id: noteId,
        audio_path:    audioPath,
        context:       ctx,
        transcript:    transcript,
        staff_name:    req.user.name || req.user.email || String(staffId),
        child_name:    childName,
      };
      fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      }).catch(err => console.warn('[voice-notes] n8n webhook fire failed:', err.message));
    } else {
      console.warn('[voice-notes] N8N_VOICE_NOTE_WEBHOOK_URL not set — skipping webhook (note saved)');
    }

    res.status(201).json({ id: noteId, transcript, transcribe_error: transcribeError });
  } catch (err) {
    console.error('[voice-notes] upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
