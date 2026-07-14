'use strict';
const fs = require('fs');

const RESULT_PATHS = [
  '/var/backups/wren/sar-test-result.json',
  '/backups/sar-test-result.json',
];

module.exports = {
  key: 'gdpr_export_working',
  category: 'gdpr',
  title: 'GDPR export (SAR) working',
  description: 'Reads the cached result of the most recent weekly Subject Access Request smoke test. The test creates a synthetic demo child record, exports it, verifies all GDPR-required fields are present, then deletes the test record.',
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
        finding: 'No SAR test result file found. The weekly GDPR export smoke test has not been configured or has not run yet.',
        remediation: 'Set up a weekly SAR test cron job that: creates a synthetic child record in the test schema, calls GET /api/children/:id/sar-export, verifies the response contains all required GDPR fields (name, dob, observations, attendance, messages), then deletes the test record and writes results to /var/backups/wren/sar-test-result.json. See /home/toby/wren/docs/security-dashboard.md.',
        evidence: { paths_checked: RESULT_PATHS },
      };
    }

    const ranAt = result.ran_at ? new Date(result.ran_at) : null;
    const ageHours = ranAt ? Math.round((Date.now() - ranAt.getTime()) / 3600000) : null;
    const ageDays = ageHours !== null ? Math.floor(ageHours / 24) : null;

    if (ageHours !== null && ageHours > 168) {
      return {
        status: 'warn',
        finding: `SAR test result is ${ageDays} days old (ran ${ranAt?.toLocaleDateString('en-GB')}). The weekly test may not be running.`,
        remediation: 'Check your weekly SAR test cron job is still running. Verify crontab -l output and check system logs.',
        evidence: { ...result, found_at: foundPath, age_hours: ageHours },
      };
    }

    if (result.status === 'pass') {
      const fields = result.fields_verified || [];
      return {
        status: 'pass',
        finding: `GDPR SAR export working${ranAt ? ` (last tested ${ranAt.toLocaleDateString('en-GB')})` : ''}. All required fields present: ${fields.join(', ') || 'verified'}.`,
        remediation: null,
        evidence: { ...result, found_at: foundPath },
      };
    }

    if (result.status === 'fail') {
      const missing = result.missing_fields || [];
      return {
        status: 'fail',
        finding: `GDPR SAR export test FAILED${ranAt ? ` (${ranAt.toLocaleDateString('en-GB')})` : ''}. ${missing.length > 0 ? `Missing required fields: ${missing.join(', ')}.` : ''} ${result.message || ''} This may mean you cannot fulfil a Subject Access Request.`,
        remediation: 'Review the SAR export endpoint (/api/children/:id/sar-export or equivalent) and ensure all GDPR-required data categories are included in the export. Under UK GDPR Article 15, subjects are entitled to all personal data you hold about them.',
        evidence: { ...result, found_at: foundPath },
      };
    }

    return {
      status: 'warn',
      finding: `SAR test returned unknown status: "${result.status}". ${result.message || ''}`,
      remediation: 'Review the SAR test script at ' + foundPath,
      evidence: { ...result },
    };
  },
};
