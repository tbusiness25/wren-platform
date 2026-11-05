'use strict';
const { execSync } = require('child_process');
const fs = require('fs');

// ClamAV check works in two modes:
// 1. Host mode (direct systemctl) — when the check runner has systemd access
// 2. Container mode (socket + log file) — when running inside the Wren app container
//    Requires the customer compose to mount:
//      /var/run/clamav:/var/run/clamav:ro
//      /var/log/clamav:/var/log/clamav:ro

function systemctlIsActive(unit) {
  try {
    const out = execSync(`systemctl is-active ${unit} 2>/dev/null`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    return out === 'active';
  } catch {
    return null; // null = systemctl unavailable (container context)
  }
}

function clamdSocketExists() {
  const sockets = [
    '/var/run/clamav/clamd.ctl',
    '/run/clamav/clamd.ctl',
    '/tmp/clamd.socket',
  ];
  return sockets.some(p => { try { fs.statSync(p); return true; } catch { return false; } });
}

function freshclamLogAge() {
  // freshclam rotates logs daily; skip empty files (log rotated but freshclam not yet run)
  const candidates = [
    '/var/log/clamav/freshclam.log',
    '/var/log/clamav/freshclam.log.1',
    '/var/log/clamav/clamav.log',
  ];
  let bestAge = Infinity;
  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      if (stat.size === 0) continue; // rotated but not yet written
      const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
      if (ageHours < bestAge) bestAge = ageHours;
    } catch { /* try next */ }
  }
  return bestAge;
}

module.exports = {
  key: 'clamav_active',
  category: 'malware',
  title: 'ClamAV anti-malware',
  description: 'Asserts that ClamAV daemon and freshclam are active and signatures are ≤7 days old. In container mode, requires /var/run/clamav and /var/log/clamav to be mounted read-only from the host.',
  async run() {
    const daemonSystemctl = systemctlIsActive('clamav-daemon');
    const freshclamSystemctl = systemctlIsActive('clamav-freshclam');
    const sigAgeHours = freshclamLogAge();
    const sigStale = sigAgeHours > 168;

    let daemonActive;
    let detectionMode;

    if (daemonSystemctl !== null) {
      // Direct systemctl access (running on host or privileged)
      daemonActive = daemonSystemctl && freshclamSystemctl;
      detectionMode = 'systemctl';
    } else {
      // Container fallback: check socket file + freshclam log accessibility
      const socketFound = clamdSocketExists();
      const logAccessible = sigAgeHours !== Infinity;
      daemonActive = socketFound;
      detectionMode = `container-fallback (socket=${socketFound}, log=${logAccessible})`;

      if (!socketFound && !logAccessible) {
        return {
          status: 'warn',
          finding: 'ClamAV status cannot be determined from inside the container — /var/run/clamav and /var/log/clamav are not mounted. Add these read-only host mounts to the wren-ladn compose to enable this check.',
          remediation: 'Add to wren-ladn compose volumes: /var/run/clamav:/var/run/clamav:ro and /var/log/clamav:/var/log/clamav:ro. Then verify ClamAV is running on the host: systemctl status clamav-daemon clamav-freshclam',
          evidence: { mode: detectionMode },
        };
      }
    }

    const evidence = {
      detection_mode: detectionMode,
      daemon_active: daemonActive,
      signature_age_hours: sigAgeHours === Infinity ? 'log-not-found' : Math.round(sigAgeHours),
    };

    if (!daemonActive) {
      return {
        status: 'fail',
        finding: 'ClamAV daemon is not running. Malware protection is not active on the host.',
        remediation: 'Run on host: sudo systemctl enable --now clamav-daemon clamav-freshclam',
        evidence,
      };
    }

    if (sigStale) {
      return {
        status: 'warn',
        finding: `ClamAV daemon is running but virus signatures are stale (~${Math.round(sigAgeHours / 24)} days old). Signatures should update daily via freshclam.`,
        remediation: 'Run on host: sudo freshclam && sudo systemctl status clamav-freshclam',
        evidence,
      };
    }

    return {
      status: 'pass',
      finding: `ClamAV active (${detectionMode}), signatures updated ${Math.round(sigAgeHours)} hours ago.`,
      remediation: null,
      evidence,
    };
  },
};
