'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const auth = require('../middleware/auth');
const { getPermissionsForRole } = require('../constants/permissions');
const { invalidateUserState } = require('../utils/tokenVersionCache');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_DAYS = 7;

// In-memory IP rate limiter sederhana untuk pencegahan brute force
const ipRateMap = new Map();
function checkIpRateLimit(ip) {
  const now = Date.now();
  const entry = ipRateMap.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 15 * 60 * 1000;
  }
  entry.count++;
  ipRateMap.set(ip, entry);
  return entry.count <= 30; // maks 30 request login per 15 menit per IP
}

// Helper untuk membaca cookies dari header tanpa dependensi tambahan
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [key, ...v] = c.trim().split('=');
    if (key) cookies[key] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkIpRateLimit(ip)) {
    return res.status(429).json({ error: 'Terlalu banyak permintaan login. Silakan tunggu 15 menit.' });
  }

  const { email, username, password } = req.body;
  const identifier = (email || username || '').trim().toLowerCase();

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Email/username dan password wajib diisi' });
  }

  try {
    // Cari pengguna di tabel users (dukung format email maupun username 'admin')
    const { rows } = await db.query(
      `SELECT * FROM users 
       WHERE lower(email) = $1 
          OR ($1 = 'admin' AND role = 'owner')
       ORDER BY (role = 'owner') DESC, id ASC 
       LIMIT 1`,
      [identifier]
    );
    const user = rows[0];

    // Cek apakah akun sedang terkunci karena lockout
    if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
      const waitMin = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(429).json({
        error: `Akun terkunci sementara karena terlalu banyak percobaan gagal. Silakan coba ${waitMin} menit lagi.`
      });
    }

    // Validasi kredensial (pesan error seragam untuk mencegah enumerasi akun)
    const isValid = user && user.is_active && bcrypt.compareSync(password, user.password_hash);

    if (!isValid) {
      if (user) {
        const nextAttempts = (user.failed_attempts || 0) + 1;
        const lockClause = nextAttempts >= 5
          ? ", locked_until = now() + interval '15 minutes'"
          : '';
        await db.query(
          `UPDATE users SET failed_attempts = $1 ${lockClause} WHERE id = $2`,
          [nextAttempts, user.id]
        );
      }
      return res.status(401).json({ error: 'Email atau password salah' });
    }

    // Login sukses: reset failed_attempts & update last_login_at
    await db.query(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
      [user.id]
    );

    // Buat Access Token (15 menit)
    const accessToken = jwt.sign(
      {
        sub: user.id,
        role: user.role,
        nama: user.nama,
        email: user.email,
        token_version: user.token_version
      },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    // Buat Refresh Token (7 hari)
    const rawRefreshToken = crypto.randomBytes(48).toString('base64url');
    const tokenHash = hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);

    const ipAddress = req.ip || null;
    const userAgent = req.headers['user-agent'] || null;

    await db.query(`
      INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
      VALUES ($1, $2, $3, $4::inet, $5)
    `, [user.id, tokenHash, expiresAt, ipAddress && ipAddress.includes('.') ? ipAddress : null, userAgent]);

    // Set cookie HttpOnly
    res.cookie('refreshToken', rawRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000
    });

    res.json({
      accessToken,
      token: accessToken, // backward compatibility
      refreshToken: rawRefreshToken, // untuk client non-browser/test
      expiresIn: 900,
      must_change_password: user.must_change_password,
      user: {
        id: user.id,
        nama: user.nama,
        email: user.email,
        role: user.role
      },
      permissions: getPermissionsForRole(user.role)
    });
  } catch (err) {
    console.error('[auth login] error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan sistem' });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const rawRefreshToken = req.body.refreshToken || cookies.refreshToken;

  if (!rawRefreshToken) {
    return res.status(401).json({ error: 'Token refresh tidak ditemukan' });
  }

  const tokenHash = hashToken(rawRefreshToken);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
      [tokenHash]
    );
    const storedToken = rows[0];

    if (!storedToken) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Token refresh tidak valid' });
    }

    // Deteksi pemakaian ulang (Token Reuse Detection)
    if (storedToken.revoked_at !== null) {
      console.warn(`[auth] ALARM: Deteksi penggunaan ulang refresh token untuk user_id: ${storedToken.user_id}!`);
      // Cabut seluruh rantai refresh token untuk user ini & naikkan token_version
      await client.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [storedToken.user_id]
      );
      await client.query(
        'UPDATE users SET token_version = token_version + 1 WHERE id = $1',
        [storedToken.user_id]
      );
      await client.query('COMMIT');

      invalidateUserState(storedToken.user_id);
      res.clearCookie('refreshToken', { path: '/api/auth' });
      return res.status(401).json({ error: 'Deteksi penggunaan ulang token. Seluruh sesi telah dicabut demi keamanan.' });
    }

    // Cek kadaluwarsa
    if (new Date(storedToken.expires_at) < new Date()) {
      await client.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1',
        [storedToken.id]
      );
      await client.query('COMMIT');
      res.clearCookie('refreshToken', { path: '/api/auth' });
      return res.status(401).json({ error: 'Token refresh telah kedaluwarsa' });
    }

    // Ambil info user terbaru
    const { rows: userRows } = await client.query(
      'SELECT id, nama, email, role, is_active, token_version, must_change_password FROM users WHERE id = $1',
      [storedToken.user_id]
    );
    const user = userRows[0];

    if (!user || !user.is_active) {
      await client.query('ROLLBACK');
      res.clearCookie('refreshToken', { path: '/api/auth' });
      return res.status(401).json({ error: 'Pengguna nonaktif atau tidak ditemukan' });
    }

    // Rotasi: buat refresh token baru
    const newRawRefreshToken = crypto.randomBytes(48).toString('base64url');
    const newTokenHash = hashToken(newRawRefreshToken);
    const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);

    const ipAddress = req.ip || null;
    const userAgent = req.headers['user-agent'] || null;

    const { rows: newTokenRows } = await client.query(`
      INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
      VALUES ($1, $2, $3, $4::inet, $5)
      RETURNING id
    `, [user.id, newTokenHash, newExpiresAt, ipAddress && ipAddress.includes('.') ? ipAddress : null, userAgent]);

    const newId = newTokenRows[0].id;

    // Tandai token lama sebagai revoked & set replaced_by
    await client.query(
      'UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $1 WHERE id = $2',
      [newId, storedToken.id]
    );

    await client.query('COMMIT');

    // Buat access token baru
    const accessToken = jwt.sign(
      {
        sub: user.id,
        role: user.role,
        nama: user.nama,
        email: user.email,
        token_version: user.token_version
      },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    // Set cookie baru
    res.cookie('refreshToken', newRawRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000
    });

    res.json({
      accessToken,
      token: accessToken,
      refreshToken: newRawRefreshToken,
      expiresIn: 900,
      must_change_password: user.must_change_password,
      user: {
        id: user.id,
        nama: user.nama,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[auth refresh] error:', err);
    res.status(500).json({ error: 'Gagal memperbarui sesi' });
  } finally {
    client.release();
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────
router.post('/logout', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const rawRefreshToken = req.body.refreshToken || cookies.refreshToken;

  if (rawRefreshToken) {
    try {
      const tokenHash = hashToken(rawRefreshToken);
      await db.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1',
        [tokenHash]
      );
    } catch (err) {
      console.warn('[auth logout] error revoking token:', err.message);
    }
  }

  res.clearCookie('refreshToken', { path: '/api/auth' });
  res.json({ message: 'Berhasil logout' });
});

// ── POST /api/auth/change-password ───────────────────────────
router.post('/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Password saat ini dan password baru wajib diisi' });
  }

  if (newPassword.length < 10) {
    return res.status(400).json({ error: 'Password baru minimal 10 karakter' });
  }

  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];

    if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Password saat ini tidak sesuai' });
    }

    const newHash = bcrypt.hashSync(newPassword, 12);

    // Update password, reset must_change_password, naikkan token_version
    const { rows: updated } = await db.query(`
      UPDATE users
      SET password_hash = $1,
          must_change_password = false,
          token_version = token_version + 1
      WHERE id = $2
      RETURNING id, token_version
    `, [newHash, user.id]);

    const newTokenVersion = updated[0].token_version;
    invalidateUserState(user.id);

    // Cabut refresh token lama
    await db.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id]
    );

    // Buat access token & refresh token baru untuk sesi saat ini
    const accessToken = jwt.sign(
      {
        sub: user.id,
        role: user.role,
        nama: user.nama,
        email: user.email,
        token_version: newTokenVersion
      },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    const newRawRefreshToken = crypto.randomBytes(48).toString('base64url');
    const tokenHash = hashToken(newRawRefreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);

    await db.query(`
      INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
      VALUES ($1, $2, $3)
    `, [user.id, tokenHash, expiresAt]);

    res.cookie('refreshToken', newRawRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000
    });

    res.json({
      message: 'Password berhasil diubah',
      accessToken,
      token: accessToken,
      refreshToken: newRawRefreshToken
    });
  } catch (err) {
    console.error('[auth change-pass] error:', err);
    res.status(500).json({ error: 'Gagal memperbarui password' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  res.json({
    user: req.user,
    permissions: getPermissionsForRole(req.user.role)
  });
});

// ── POST /api/auth/verify (Backward compatibility) ────────────
router.post('/verify', auth, (req, res) => {
  res.json({ valid: true, admin: req.admin, user: req.user });
});

module.exports = router;
