'use strict';

const jwt = require('jsonwebtoken');

/**
 * Express middleware: verify JWT from Authorization header.
 * Attaches decoded payload to req.admin on success.
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: 'Akses ditolak: token tidak ada' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_change_me');
    req.admin = decoded; // { adminId, username, name, iat, exp }
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError'
      ? 'Sesi login telah berakhir, silakan login kembali'
      : 'Token tidak valid';
    return res.status(403).json({ error: msg });
  }
}

module.exports = authMiddleware;
