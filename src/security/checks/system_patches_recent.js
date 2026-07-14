'use strict';
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

module.exports = {
  key: 'system_patches_recent',
  category: 'patching',
  title: 'Pending security patches',
  description: 'Checks for pending security updates in the Wren container image using apt-get dry-run. Any pending security patches should be applied by rebuilding the container.',
  async run() {
    let aptOutput = '';
    let aptError = false;

    try {
      const { stdout } = await execAsync(
        'apt-get -s upgrade 2>/dev/null | grep -i "^Inst" | head -50',
        { timeout: 25000 }
      );
      aptOutput = stdout.trim();
    } catch {
      aptError = true;
    }

    if (aptError) {
      // Try alternative: check if apt is available at all
      try {
        await execAsync('which apt-get', { timeout: 5000 });
      } catch {
        return {
          status: 'warn',
          finding: 'apt-get not available in this container. Cannot check for pending security updates. This is expected on Alpine/non-Debian base images.',
          remediation: 'Ensure your Wren container image is rebuilt periodically to include latest security patches.',
          evidence: { apt_available: false },
        };
      }

      return {
        status: 'warn',
        finding: 'Could not run apt-get dry-run to check for pending updates.',
        remediation: 'Run manually inside the container: apt-get update && apt-get -s upgrade | grep -c "^Inst"',
        evidence: { error: true },
      };
    }

    const lines = aptOutput ? aptOutput.split('\n').filter(Boolean) : [];
    const securityLines = lines.filter(l => l.toLowerCase().includes('security'));
    const totalPending = lines.length;
    const securityPending = securityLines.length;

    if (securityPending > 0) {
      return {
        status: 'warn',
        finding: `${securityPending} security update(s) pending in the Wren container: ${securityLines.slice(0, 5).map(l => l.split(' ')[1]).join(', ')}${securityPending > 5 ? ` and ${securityPending - 5} more` : ''}.`,
        remediation: 'Rebuild and redeploy the Wren container: cd /home/toby/wren && docker compose -f docker/docker-compose.yml build wren-ladn && docker compose -f docker/docker-compose.yml up -d wren-ladn',
        evidence: { security_pending: securityPending, total_pending: totalPending, packages: securityLines.slice(0, 20) },
      };
    }

    if (totalPending > 0) {
      return {
        status: 'warn',
        finding: `${totalPending} non-security update(s) pending. No critical security patches outstanding.`,
        remediation: 'Consider rebuilding the container periodically to keep packages current.',
        evidence: { security_pending: 0, total_pending: totalPending },
      };
    }

    return {
      status: 'pass',
      finding: 'No pending security updates found in the Wren container.',
      remediation: null,
      evidence: { security_pending: 0, total_pending: 0 },
    };
  },
};
