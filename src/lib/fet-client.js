'use strict';

const http = require('http');

const FET_BASE = process.env.FET_SERVICE_URL || 'http://wren-fet-service:3030';

function fetRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(FET_BASE + path);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port:     url.port || 3030,
      path:     url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error(json.error || `FET HTTP ${res.statusCode}`));
          resolve(json);
        } catch { reject(new Error('Invalid JSON from FET service')); }
      });
    });

    req.on('error', err => reject(new Error('FET service unavailable: ' + err.message)));
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('FET service timeout')); });

    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = {
  solve:     (input)  => fetRequest('POST',   '/api/fet/solve',        input),
  getJob:    (jobId)  => fetRequest('GET',    `/api/fet/jobs/${jobId}`, null),
  cancelJob: (jobId)  => fetRequest('DELETE', `/api/fet/jobs/${jobId}`, null),
};
