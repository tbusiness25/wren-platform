'use strict';
const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

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

    // Optional child name for n8n payload
    let childName = null;
    if (ctx.child_id) {
      try {
        const r = await pool.query('SELECT full_name FROM ladn.children WHERE id=$1', [ctx.child_id]);
        childName = r.rows[0]?.full_name || null;
      } catch {}
    }

    const staffId = req.user.id;
    const audioPath = req.file.path;

    // Insert DB row
    const { rows } = await pool.query(`
      INSERT INTO ladn.voice_notes
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

    // Fire n8n webhook (async — don't block response)
    const webhookUrl = process.env.N8N_VOICE_NOTE_WEBHOOK_URL;
    if (webhookUrl) {
      const payload = {
        voice_note_id: noteId,
        audio_path:    audioPath,
        context:       ctx,
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

    res.status(201).json({ id: noteId });
  } catch (err) {
    console.error('[voice-notes] upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
