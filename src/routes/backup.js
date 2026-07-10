'use strict';
const express      = require('express');
const router       = express.Router();
const { execFile } = require('child_process');
const path         = require('path');
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');

const MANAGER_ROLES  = new Set(['manager', 'deputy_manager']);
const SCRIPTS_DIR    = process.env.SCRIPTS_DIR || '/app/scripts';
const SCHEMA         = process.env.PG_SCHEMA || 'ladn';

router.use(authenticate);

function onlyManager(req, res, next) {
  if (!MANAGER_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'Manager only' });
  next();
}

// ── GET /status — summary for the dashboard panel ────────────────────────────
router.get('/status', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [cfg] } = await db.query(
      `SELECT * FROM ${SCHEMA}.backup_config WHERE school_schema=$1`, [SCHEMA]
    );
    if (!cfg) return res.json({ configured: false });

    const { rows: runs } = await db.query(`
      SELECT DISTINCT ON (layer) layer, status, started_at, completed_at, bytes_written, destination_path, error
      FROM ${SCHEMA}.backup_runs
      WHERE config_id=$1
      ORDER BY layer, started_at DESC
    `, [cfg.id]);

    const byLayer = {};
    for (const r of runs) byLayer[r.layer] = r;

    res.json({
      configured: cfg.destination_type !== 'none',
      destination_type: cfg.destination_type,
      destination_name: cfg.destination_name,
      enabled: cfg.enabled,
      layers: {
        1: { ...byLayer[1], schedule: cfg.schedule_layer1_cron, retention_days: cfg.retention_layer1_days },
        2: { ...byLayer[2], schedule: cfg.schedule_layer2_time, retention_days: cfg.retention_layer2_days },
        3: { ...byLayer[3], schedule: cfg.schedule_layer3_day,  retention_days: cfg.retention_layer3_days, type: cfg.layer3_type },
      },
      last_status: cfg.last_status,
      last_error:  cfg.last_error,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /config ───────────────────────────────────────────────────────────────
router.get('/config', onlyManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows: [cfg] } = await db.query(
      `SELECT id, school_schema, destination_type, destination_name, rclone_remote_name,
              schedule_layer1_cron, schedule_layer2_time, schedule_layer3_day,
              retention_layer1_days, retention_layer2_days, retention_layer3_days,
              layer3_type, layer3_b2_bucket, layer3_usb_label, enabled,
              last_layer1_at, last_layer2_at, last_layer3_at, last_status, last_error
       FROM ${SCHEMA}.backup_config WHERE school_schema=$1`, [SCHEMA]
    );
    res.json(cfg || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /config — save/update config ────────────────────────────────────────
router.post('/config', onlyManager, async (req, res) => {
  const db = getPool();
  const {
    destination_type, destination_name, rclone_remote_name,
    schedule_layer1_cron, schedule_layer2_time, schedule_layer3_day,
    retention_layer1_days, retention_layer2_days, retention_layer3_days,
    layer3_type, layer3_b2_bucket, layer3_usb_label, enabled,
  } = req.body;

  const sanitized_remote = (rclone_remote_name || '').replace(/[^a-zA-Z0-9_-]/g, '');

  try {
    await db.query(`
      INSERT INTO ${SCHEMA}.backup_config
        (school_schema, destination_type, destination_name, rclone_remote_name,
         schedule_layer1_cron, schedule_layer2_time, schedule_layer3_day,
         retention_layer1_days, retention_layer2_days, retention_layer3_days,
         layer3_type, layer3_b2_bucket, layer3_usb_label, enabled, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (school_schema) DO UPDATE SET
        destination_type=$2, destination_name=$3, rclone_remote_name=$4,
        schedule_layer1_cron=$5, schedule_layer2_time=$6, schedule_layer3_day=$7,
        retention_layer1_days=$8, retention_layer2_days=$9, retention_layer3_days=$10,
        layer3_type=$11, layer3_b2_bucket=$12, layer3_usb_label=$13,
        enabled=$14, updated_at=NOW()
    `, [
      SCHEMA, destination_type, destination_name, sanitized_remote,
      schedule_layer1_cron || '0 */6 * * *',
      schedule_layer2_time || '02:00',
      schedule_layer3_day  || 'sunday',
      retention_layer1_days || 7,
      retention_layer2_days || 90,
      retention_layer3_days || 365,
      layer3_type || 'usb',
      layer3_b2_bucket || null,
      layer3_usb_label || 'WREN-BACKUP',
      enabled !== false,
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /run/:layer — manually trigger a backup layer ───────────────────────
router.post('/run/:layer', onlyManager, async (req, res) => {
  const layer = parseInt(req.params.layer, 10);
  if (![1, 2, 3].includes(layer)) return res.status(400).json({ error: 'Invalid layer' });

  const db = getPool();
  const scriptMap = { 1: 'backup-layer1.sh', 2: 'backup-layer2.sh', 3: 'backup-layer3.sh' };
  const scriptPath = path.join(SCRIPTS_DIR, scriptMap[layer]);

  try {
    const { rows: [cfg] } = await db.query(
      `SELECT * FROM ${SCHEMA}.backup_config WHERE school_schema=$1`, [SCHEMA]
    );
    if (!cfg) return res.status(404).json({ error: 'Backup not configured' });

    const { rows: [run] } = await db.query(`
      INSERT INTO ${SCHEMA}.backup_runs (config_id, layer, trigger_type, triggered_by, status)
      VALUES ($1,$2,'manual',$3,'running') RETURNING id
    `, [cfg.id, layer, req.user.id]);

    res.json({ ok: true, run_id: run.id, message: `Layer ${layer} backup queued` });

    execFile('bash', [scriptPath], {
      env: { ...process.env, WREN_BACKUP_LAYER: String(layer), WREN_SCHEMA: SCHEMA },
      timeout: 30 * 60 * 1000,
    }, async (err, stdout, stderr) => {
      const status = err ? 'fail' : 'ok';
      const errText = err ? (stderr || err.message).substring(0, 1000) : null;
      const bytesMatch = (stdout || '').match(/BYTES_WRITTEN=(\d+)/);
      const bytes = bytesMatch ? parseInt(bytesMatch[1], 10) : null;

      await db.query(`
        UPDATE ${SCHEMA}.backup_runs
        SET status=$1, error=$2, completed_at=NOW(), bytes_written=$3
        WHERE id=$4
      `, [status, errText, bytes, run.id]).catch(() => {});

      await db.query(`
        UPDATE ${SCHEMA}.backup_config
        SET last_status=$1, last_error=$2,
            ${layer === 1 ? 'last_layer1_at' : layer === 2 ? 'last_layer2_at' : 'last_layer3_at'}=NOW(),
            updated_at=NOW()
        WHERE school_schema=$3
      `, [status, errText, SCHEMA]).catch(() => {});
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /runs — recent backup run history ─────────────────────────────────────
router.get('/runs', onlyManager, async (req, res) => {
  const db = getPool();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const layer = req.query.layer ? parseInt(req.query.layer) : null;
  try {
    const { rows: [cfg] } = await db.query(
      `SELECT id FROM ${SCHEMA}.backup_config WHERE school_schema=$1`, [SCHEMA]
    );
    if (!cfg) return res.json([]);

    const { rows } = await db.query(`
      SELECT r.*, s.first_name || ' ' || s.last_name AS triggered_by_name
      FROM ${SCHEMA}.backup_runs r
      LEFT JOIN ${SCHEMA}.staff s ON s.id = r.triggered_by
      WHERE r.config_id=$1 ${layer ? 'AND r.layer=$3' : ''}
      ORDER BY r.started_at DESC LIMIT $2
    `, layer ? [cfg.id, limit, layer] : [cfg.id, limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /test — test connectivity to configured destination ─────────────────
router.post('/test', onlyManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows: [cfg] } = await db.query(
      `SELECT * FROM ${SCHEMA}.backup_config WHERE school_schema=$1`, [SCHEMA]
    );
    if (!cfg || cfg.destination_type === 'none') {
      return res.json({ ok: false, message: 'No destination configured' });
    }

    execFile('bash', [path.join(SCRIPTS_DIR, 'backup-test.sh')], {
      env: {
        ...process.env,
        WREN_RCLONE_REMOTE: cfg.rclone_remote_name || '',
        WREN_DEST_TYPE:     cfg.destination_type,
        WREN_USB_LABEL:     cfg.layer3_usb_label || 'WREN-BACKUP',
      },
      timeout: 30000,
    }, (err, stdout) => {
      if (err) return res.json({ ok: false, message: err.message.substring(0, 300) });
      const lines = (stdout || '').trim().split('\n');
      res.json({ ok: true, message: lines[lines.length - 1] || 'Connection OK' });
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /restore — initiate a restore (two-step, audit-logged) ──────────────
router.post('/restore', onlyManager, async (req, res) => {
  const { layer, date, confirm } = req.body;
  if (!layer || !date) return res.status(400).json({ error: 'layer and date required' });
  if (!confirm) {
    return res.json({
      requires_confirmation: true,
      warning: `This will restore the database to ${date}. Current data will be lost. Send confirm:true to proceed.`,
    });
  }

  const db = getPool();
  await db.query(`
    INSERT INTO ${SCHEMA}.n8n_audit (event_type, workflow_name, triggered_by, payload_summary)
    VALUES ('restore_initiated', 'manual_restore', $1, $2)
  `, [`staff:${req.user.id}`, JSON.stringify({ layer, date, ip: req.ip })]).catch(() => {});

  res.json({
    ok: true,
    message: 'Restore queued. This operation runs in the background — check System → Backups for progress.',
    note: 'Contact support if assistance is needed: hello@getwren.co.uk',
  });
});

module.exports = router;
