'use strict';
const fs = require('fs');
const path = require('path');

const BACKUP_DIRS = [
  '/var/backups/wren',
  '/backups',
  '/data/backups',
];

const PASS_HOURS = 48;
const WARN_HOURS = 168; // 7 days

function findLatestBackup(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.sql') || f.endsWith('.dump') || f.endsWith('.gz') || f.endsWith('.tar'))
      .map(f => {
        try {
          const stat = fs.statSync(path.join(dir, f));
          return { file: f, mtime: stat.mtime, size: stat.size };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    return files[0] || null;
  } catch {
    return null;
  }
}

module.exports = {
  key: 'backup_recent',
  category: 'backups',
  title: 'Recent backup exists',
  description: `Checks the modification time of the latest backup file. Pass if <${PASS_HOURS} hours old; warn if ${PASS_HOURS}–${WARN_HOURS} hours; fail if older than ${WARN_HOURS / 24} days.`,
  async run() {
    let latest = null;
    let foundDir = null;

    for (const dir of BACKUP_DIRS) {
      latest = findLatestBackup(dir);
      if (latest) { foundDir = dir; break; }
    }

    if (!latest) {
      return {
        status: 'fail',
        finding: `No backup files found in any expected backup directory (${BACKUP_DIRS.join(', ')}). If backups are stored elsewhere, update the BACKUP_DIR environment variable.`,
        remediation: 'Set up automated database backups. A simple cron entry: 0 2 * * * docker exec wren-postgres pg_dump -U wren wren | gzip > /var/backups/wren/wren-$(date +%Y%m%d).sql.gz. Create the directory first: mkdir -p /var/backups/wren.',
        evidence: { dirs_checked: BACKUP_DIRS },
      };
    }

    const ageMs = Date.now() - latest.mtime.getTime();
    const ageHours = Math.round(ageMs / 3600000);
    const sizeMb = (latest.size / 1048576).toFixed(1);

    if (ageHours <= PASS_HOURS) {
      return {
        status: 'pass',
        finding: `Most recent backup: ${latest.file} (${ageHours}h ago, ${sizeMb} MB) in ${foundDir}.`,
        remediation: null,
        evidence: { file: latest.file, age_hours: ageHours, size_mb: parseFloat(sizeMb), dir: foundDir },
      };
    }

    if (ageHours <= WARN_HOURS) {
      return {
        status: 'warn',
        finding: `Most recent backup is ${ageHours} hours old (${latest.file} in ${foundDir}). Backups should run at least every 48 hours.`,
        remediation: 'Check your backup cron job is running. Run: crontab -l | grep backup. Trigger a manual backup if needed.',
        evidence: { file: latest.file, age_hours: ageHours, size_mb: parseFloat(sizeMb), dir: foundDir },
      };
    }

    return {
      status: 'fail',
      finding: `Most recent backup is ${ageHours} hours (${Math.round(ageHours / 24)} days) old. This is a critical risk — data loss in a failure scenario would be severe.`,
      remediation: 'Restore your backup process immediately and run a manual backup now: docker exec wren-postgres pg_dump -U wren wren | gzip > /var/backups/wren/wren-manual-$(date +%Y%m%d%H%M).sql.gz',
      evidence: { file: latest.file, age_hours: ageHours, dir: foundDir },
    };
  },
};
