'use strict';

const jwt = require('jsonwebtoken');
const { hasPermission } = require('../constants/permissions');
const { getUserState } = require('../utils/tokenVersionCache');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';

/**
 * Express middleware: Verifikasi JWT access token (15 menit)
 * Memeriksa status aktif & token_version (dengan cache in-memory singkat).
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Akses ditolak: token tidak ada' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    const msg = err.name === 'TokenExpiredError'
      ? 'Sesi login telah berakhir, silakan refresh atau login kembali'
      : 'Token tidak valid';
    return res.status(401).json({ error: msg });
  }

  const userId = decoded.sub || decoded.adminId;
  if (!userId) {
    return res.status(401).json({ error: 'Token payload tidak valid' });
  }

  try {
    const userState = await getUserState(userId);
    if (!userState) {
      return res.status(401).json({ error: 'Pengguna tidak ditemukan atau telah dihapus' });
    }

    if (!userState.is_active) {
      return res.status(401).json({ error: 'Akun telah dinonaktifkan' });
    }

    // Cek token_version jika token memiliki token_version
    if (decoded.token_version !== undefined && decoded.token_version !== userState.token_version) {
      return res.status(401).json({ error: 'Sesi telah dicabut, silakan login kembali' });
    }

    // Pasang req.user (standar baru) dan req.admin (backward compatibility)
    req.user = {
      id: userId,
      role: decoded.role || 'owner',
      nama: decoded.nama || decoded.name || 'User',
      email: decoded.email || decoded.username || '',
      token_version: userState.token_version,
      must_change_password: userState.must_change_password
    };

    req.admin = {
      id: userId,
      adminId: userId,
      name: req.user.nama,
      username: req.user.email,
      role: req.user.role
    };

    // Pembatasan must_change_password
    if (userState.must_change_password) {
      const allowedPaths = ['/change-password', '/logout', '/me'];
      const isAllowed = allowedPaths.some(p => req.path.endsWith(p));
      if (!isAllowed) {
        return res.status(403).json({
          error: 'Wajib mengganti password sebelum melanjutkan',
          must_change_password: true
        });
      }
    }

    next();
  } catch (err) {
    console.error('[auth middleware] error validating user state:', err);
    return res.status(500).json({ error: 'Gagal memvalidasi sesi' });
  }
}

/**
 * Middleware untuk otorisasi berdasarkan permission key
 * Contoh: requirePermission('finance.view')
 * Mendukung feature flag RBAC_ENABLED (default: true). Jika diset 'false', seluruh request diloloskan (fallback kompatibel).
 */
function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Autentikasi diperlukan' });
    }

    const rbacEnabled = process.env.RBAC_ENABLED !== 'false';
    if (!rbacEnabled) {
      return next();
    }

    if (!hasPermission(req.user.role, permissionKey)) {
      return res.status(403).json({
        error: `Akses ditolak: peran '${req.user.role}' tidak memiliki izin '${permissionKey}'`
      });
    }

    next();
  };
}

function requireRole(expectedRole) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Autentikasi diperlukan' });
    }

    const rbacEnabled = process.env.RBAC_ENABLED !== 'false';
    if (!rbacEnabled) {
      return next();
    }

    const userRole = req.user.role === 'admin' ? 'owner' : req.user.role;
    const targetRole = expectedRole === 'admin' ? 'owner' : expectedRole;

    if (userRole !== targetRole) {
      return res.status(403).json({
        error: `Akses ditolak: endpoint ini memerlukan hak akses '${expectedRole}'`
      });
    }

    next();
  };
}

authenticate.authenticate = authenticate;
authenticate.requirePermission = requirePermission;
authenticate.requireRole = requireRole;

module.exports = authenticate;

