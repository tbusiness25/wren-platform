'use strict';
const fs = require('fs');

const RESULT_PATHS = [
  '/var/backups/wren/restore-test-result.json',
  '/backups/restore-test-result.json',
];

module.exports = {
  key: 'backup_restorable',
  category: 'backups',
  title: 'Backup restore test passed',
  description: 'Reads the cached result of the most recent weekly automated restore-test. The test itself runs as a separate cron job and stores its result here.',
  async run() {
    let result = null;
    let foundPath = null;

    for (const p of RESULT_PATHS) {
      try {
        result = JSON.parse(fs.readFileSync(p, 'utf8'));
        foundPath = p;
        break;
      } catch { /* try next */ }
    }

    if (!result) {
      return {
        status: 'warn',
        finding: 'No restore-test result file found. The weekly restore test has not been configured or has not run yet.',
        remediation: 'Set up a weekly restore-test cron job. It should: restore the latest backup to a test database, verify row counts match, then write results to /var/backups/wren/restore-test-result.json. See /app/docs/security-dashboard.md for a sample script.',
        evidence: { paths_checked: RESULT_PATHS },
      };
    }

    const ranAt = result.ran_at ? new Date(result.ran_at) : null;
    const ageHours = ranAt ? Math.round((Date.now() - ranAt.getTime()) / 3600000) : null;

    if (result.status === 'pass') {
      return {
        status: 'pass',
        finding: `Backup restore test passed${ranAt ? ` (${ageHours}h ago, ${ranAt.toLocaleDateString('en-GB')})` : ''}. ${result.message || ''}`,
        remediation: null,
        evidence: { ...result, found_at: foundPath },
      };
    }

    if (result.status === 'fail') {
      return {
        status: 'fail',
        finding: `Backup restore test FAILED${ranAt ? ` (${ranAt.toLocaleDateString('en-GB')})` : ''}. ${result.message || 'Backups may not be restorable.'} This means a real recovery scenario may fail.`,
        remediation: 'Investigate the restore failure immediately. Check backup file integrity, available disk space, and PostgreSQL restore logs. Run a manual restore test to diagnose the issue.',
        evidence: { ...result, found_at: foundPath },
      };
    }

    return {
      status: 'warn',
      finding: `Restore test result has unknown status: "${result.status}". ${result.message || ''}`,
      remediation: 'Review the restore test script output at ' + foundPath,
      evidence: { ...result },
    };
  },
};
