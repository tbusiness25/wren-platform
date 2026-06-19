const jwt = require('jsonwebtoken');

// Check if IP is on Tailscale network (100.x.x.x)
// req.ip is populated correctly when app.set('trust proxy', 1) is set in server.js
function isTailscaleIP(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip.startsWith('100.') || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.');
}

module.exports = function authenticate(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : req.headers['x-wren-token'] || '';

  if (!token) return res.status(401).json({ error: 'Unauthorised' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const expectedAud = req._portal || 'learning';
    // Strict audience check — grace period ended 2026-05-20
    if (!decoded.aud || decoded.aud !== expectedAud) {
      return res.status(401).json({ error: 'Invalid token audience' });
    }
    req.user = decoded;
    req.isTailscale = isTailscaleIP(req);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Middleware: enforce remote access restriction for EY-data routes
// Returns 403 for non-Tailscale requests when remote_full_access=false
module.exports.requireNetworkAccess = function requireNetworkAccess(edition) {
  return async (req, res, next) => {
    // EY/child-data editions only
    if (!['ladn','eyfs'].includes(edition)) return next();
    // HR routes are always allowed
    const path = req.path || '';
    const eyDataPrefixes = ['/api/children','/api/observations','/api/attendance','/api/diary',
      '/api/medicine','/api/incidents','/api/safeguarding','/api/sen','/api/phonics','/api/outings'];
    const isEyRoute = eyDataPrefixes.some(p => req.originalUrl.startsWith(p));
    if (!isEyRoute) return next();
    // Allow Tailscale always
    if (isTailscaleIP(req)) return next();
    // Check setting
    try {
      const { getPool } = require('../db/pool');
      const db = getPool();
      const { rows } = await db.query("SELECT value FROM settings WHERE key='remote_full_access'");
      if (rows[0]?.value === 'true') return next();
      return res.status(403).json({
        error: 'remote_access_restricted',
        message: 'EY portal access is restricted to the school network. Contact your manager or connect via Tailscale.'
      });
    } catch {
      return res.status(503).json({ error: 'Service unavailable' });
    }
  };
};

module.exports.requireRole = function requireRole(...roles) {
  return [
    module.exports,
    (req, res, next) => {
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    }
  ];
};
