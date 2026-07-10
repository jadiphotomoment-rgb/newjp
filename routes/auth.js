'use strict';

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../database');
const auth    = require('../middleware/auth');

const JWT_SECRET  = process.env.JWT_SECRET || 'fallback_secret_change_me';
const JWT_EXPIRES = '24h';

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }

  try {
    const { rows } = await db.query('SELECT * FROM admins WHERE username = $1', [username.trim()]);
    const admin = rows[0];

    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.status(401).json({ error: 'Username atau password salah' });
    }

    const token = jwt.sign(
      { adminId: admin.id, username: admin.username, name: admin.name },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({
      token,
      admin: { id: admin.id, username: admin.username, name: admin.name }
    });
  } catch (err) {
    console.error('[auth] error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── POST /api/auth/verify ─────────────────────────────────────
// Lightweight endpoint to check token validity
router.post('/verify', auth, (req, res) => {
  res.json({ valid: true, admin: req.admin });
});

// ── POST /api/auth/change-password ───────────────────────────
router.post('/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Password lama dan baru wajib diisi' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
  }

  try {
    const { rows } = await db.query('SELECT * FROM admins WHERE id = $1', [req.admin.adminId]);
    const admin = rows[0];

    if (!bcrypt.compareSync(currentPassword, admin.password_hash)) {
      return res.status(401).json({ error: 'Password saat ini salah' });
    }

    const newHash = bcrypt.hashSync(newPassword, 10);
    await db.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [newHash, admin.id]);

    res.json({ message: 'Password berhasil diubah' });
  } catch (err) {
    console.error('[auth change-pass] error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/auth/check-db ────────────────────────────────────
router.get('/check-db', auth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT version() AS v');
    res.json({ status: 'success', version: rows[0].v, message: 'Berhasil terkoneksi ke Neon PostgreSQL!' });
  } catch (err) {
    console.error('[check-db] error:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;
