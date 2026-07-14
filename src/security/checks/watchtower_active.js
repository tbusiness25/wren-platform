'use strict';
const { execSync } = require('child_process');
const fs = require('fs');

// Host-side evidence file written by watchtower-status-writer.sh every 15 min.
// This container has no Docker socket mount, so direct docker commands always fail.
// The script runs on the host and writes status here via the shared data volume.
const HOST_STATUS_PATH = '/app/data/watchtower-status.json';
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function readHostStatus() {
  try {
    const raw = fs.readFileSync(HOST_STATUS_PATH, 'utf8');
    const data = JSON.parse(raw);
    const age = Date.now() - new Date(data.timestamp).getTime();
    if (age > MAX_AGE_MS) return null; // stale — fall through to direct check
    return data;
  } catch {
    return null;
  }
}

function dockerExec(args) {
  try {
    return execSync(`docker ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

module.exports = {
  key: 'watchtower_active',
  category: 'patch',
  title: 'Watchtower container auto-update',
  description: 'Asserts watchtower is running in label-enable mode and that at least one container carries the watchtower.enable=true label.',
  async run() {
    // Prefer host-side evidence file (written by wren-watchtower-status.timer every 15 min)
    const hostStatus = readHostStatus();
    if (hostStatus) {
      const { running, healthy, label_enable, monitored_containers, schedule, timestamp } = hostStatus;

      const evidence = {
        source: 'host-status-file',
        file_timestamp: timestamp,
        running,
        healthy,
        label_enable_env: label_enable,
        labelled_containers: monitored_containers || [],
        schedule,
      };

      if (!running) {
        return {
          status: 'fail',
          finding: 'Watchtower container is not running (host status file reports down). Docker images will not be automatically updated.',
          remediation: 'Run: docker compose -f /home/toby/docker/watchtower/docker-compose.yml up -d',
          evidence,
        };
      }
      if (!label_enable) {
        return {
          status: 'warn',
          finding: 'Watchtower is running but WATCHTOWER_LABEL_ENABLE=true is not set — it will update ALL containers indiscriminately, including databases.',
          remediation: 'Ensure WATCHTOWER_LABEL_ENABLE=true in the watchtower compose environment block.',
          evidence,
        };
      }
      if (!monitored_containers || monitored_containers.length === 0) {
        return {
          status: 'warn',
          finding: 'Watchtower is running in label-enable mode but no containers have the watchtower.enable=true label.',
          remediation: 'Add label com.centurylinklabs.watchtower.enable=true to app containers.',
          evidence,
        };
      }
      return {
        status: 'pass',
        finding: `Watchtower active, label-enable mode on, schedule ${schedule || 'unknown'}, watching ${monitored_containers.length} container(s): ${monitored_containers.join(', ')}.`,
        remediation: null,
        evidence,
      };
    }

    // Fallback: attempt direct docker commands (will fail if no socket mount)
    const status = dockerExec("ps --filter name=watchtower --format '{{.Status}}'");
    const running = status.toLowerCase().startsWith('up');

    let labelEnabled = false;
    if (running) {
      const env = dockerExec("inspect watchtower --format '{{range .Config.Env}}{{.}}\n{{end}}'");
      labelEnabled = env.includes('WATCHTOWER_LABEL_ENABLE=true');
    }

    const labelledContainers = dockerExec(
      "ps --filter label=com.centurylinklabs.watchtower.enable=true --format '{{.Names}}'"
    ).split('\n').filter(Boolean);

    const evidence = {
      source: 'direct-docker',
      watchtower_status: status || 'not-found',
      label_enable_env: labelEnabled,
      labelled_containers: labelledContainers,
    };

    if (!running) {
      return {
        status: 'fail',
        finding: 'Watchtower container is not running. Docker images will not be automatically updated.',
        remediation: 'Run: docker compose -f /home/toby/docker/watchtower/docker-compose.yml up -d',
        evidence,
      };
    }
    if (!labelEnabled) {
      return {
        status: 'warn',
        finding: 'Watchtower is running but WATCHTOWER_LABEL_ENABLE=true is not set.',
        remediation: 'Ensure WATCHTOWER_LABEL_ENABLE=true in the watchtower compose environment block.',
        evidence,
      };
    }
    if (labelledContainers.length === 0) {
      return {
        status: 'warn',
        finding: 'Watchtower is running in label-enable mode but no containers have the watchtower.enable=true label.',
        remediation: 'Add label com.centurylinklabs.watchtower.enable=true to app containers.',
        evidence,
      };
    }
    return {
      status: 'pass',
      finding: `Watchtower active, label-enable mode on, watching ${labelledContainers.length} container(s): ${labelledContainers.join(', ')}.`,
      remediation: null,
      evidence,
    };
  },
};
