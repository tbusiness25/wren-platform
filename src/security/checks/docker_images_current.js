'use strict';
const fs = require('fs');
const path = require('path');

// No remote fetch — this check is local-only to avoid any phone-home.
// Customers populate /opt/wren/version-manifest.json via their own update channel.
const MANIFEST_PATHS = [
  '/opt/wren/version-manifest.json',
  '/app/version-manifest.json',
  path.join(__dirname, '../../../version-manifest.json'),
];

function parseVersion(v) {
  if (!v) return null;
  const m = String(v).match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], str: m[0] };
}

function versionsBehind(current, latest) {
  if (!current || !latest) return null;
  if (current.major !== latest.major) return (latest.major - current.major) * 1000;
  return (latest.minor - current.minor);
}

module.exports = {
  key: 'docker_images_current',
  category: 'patching',
  title: 'Wren image up to date',
  description: 'Compares the running Wren version against the local version manifest file. Warns if more than 2 minor versions behind. No external network call is made.',
  async run() {
    let manifest = null;
    let manifestPath = null;
    for (const p of MANIFEST_PATHS) {
      try {
        manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
        manifestPath = p;
        break;
      } catch { /* try next */ }
    }

    if (!manifest) {
      return {
        status: 'warn',
        finding: 'Version manifest not found. Cannot compare running version against latest release. Expected at /opt/wren/version-manifest.json.',
        remediation: 'Create /opt/wren/version-manifest.json with {"current":"1.0.0","latest":"1.0.0"} and keep it updated via your deployment pipeline. No internet access required — this file is managed locally.',
        evidence: { searched: MANIFEST_PATHS },
      };
    }

    const current = parseVersion(manifest.current_version || manifest.current || manifest.version);
    const latest = parseVersion(manifest.latest_version || manifest.latest);

    if (!current) {
      return {
        status: 'warn',
        finding: `Version manifest found at ${manifestPath} but current version cannot be parsed: "${manifest.current || manifest.version}".`,
        remediation: 'Ensure version-manifest.json contains a valid "current" field in semver format (e.g. "1.2.3").',
        evidence: { manifest },
      };
    }

    if (!latest) {
      return {
        status: 'pass',
        finding: `Running Wren ${current.str}. No latest version in manifest — version comparison not configured.`,
        remediation: null,
        evidence: { current: current.str, manifest_path: manifestPath },
      };
    }

    const behind = versionsBehind(current, latest);

    if (behind === null) {
      return {
        status: 'warn',
        finding: 'Cannot compare versions.',
        remediation: null,
        evidence: { manifest },
      };
    }

    if (behind <= 0) {
      return {
        status: 'pass',
        finding: `Running Wren ${current.str} — up to date (latest: ${latest.str}).`,
        remediation: null,
        evidence: { current: current.str, latest: latest.str, behind: 0 },
      };
    }

    if (behind <= 2) {
      return {
        status: 'warn',
        finding: `Running Wren ${current.str}; latest is ${latest.str} (${behind} minor version(s) behind).`,
        remediation: 'Consider updating Wren to the latest version. Follow the upgrade instructions in your release notes.',
        evidence: { current: current.str, latest: latest.str, behind },
      };
    }

    return {
      status: 'warn',
      finding: `Running Wren ${current.str}; latest is ${latest.str} (${behind} minor version(s) behind). You are missing significant updates.`,
      remediation: 'Update Wren promptly. More than 2 minor versions behind may mean missing security patches.',
      evidence: { current: current.str, latest: latest.str, behind },
    };
  },
};
