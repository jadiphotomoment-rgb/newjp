'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const auth = require('../middleware/auth');
const audit = require('../services/audit');
const { invalidateUserState } = require('../utils/tokenVersionCache');

// Semua endpoint users membutuhkan user.manage (hanya Owner)
router.use(auth);
router.use(auth.requirePermission('user.manage'));

// GET /api/users — List semua user / staff
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nama, nama AS name, email, role, is_active, must_change_password,
              token_version, created_at
       FROM users
       ORDER BY role ASC, id ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[users] GET error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/users — Buat user / staff baru
router.post('/', async (req, res) => {
  const { name, nama, email, role = 'staff', password } = req.body;
  const userName = (nama || name || '').trim();

  if (!userName || !email || !password) {
    return res.status(400).json({ error: 'Nama, email, dan password wajib diisi' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const validRoles = ['owner', 'staff'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Role tidak valid (owner atau staff)' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password minimal 8 karakter' });
  }

  let dbClient;
  try {
    const existing = await db.query('SELECT id FROM users WHERE lower(email) = $1', [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email sudah terdaftar' });
    }

    const salt = await bcrypt.genSalt(12);
    const hash = await bcrypt.hash(password, salt);

    dbClient = await db.getClient();
    await dbClient.query('BEGIN');

    const insertRes = await dbClient.query(
      `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, true, true)
       RETURNING id, nama, nama AS name, email, role, is_active, must_change_password, created_at`,
      [userName, cleanEmail, hash, role]
    );
    const newUser = insertRes.rows[0];

    await audit.record(dbClient, {
      req,
      aksi: 'user.create',
      entitas: 'user',
      entitas_id: newUser.id,
      data_setelah: {
        id: newUser.id,
        nama: newUser.nama,
        email: newUser.email,
        role: newUser.role,
        is_active: true
      }
    });

    await dbClient.query('COMMIT');
    res.status(201).json({ message: 'User berhasil dibuat', user: newUser });
  } catch (err) {
    if (dbClient) await dbClient.query('ROLLBACK');
    console.error('[users] POST error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (dbClient) dbClient.release();
  }
});

// GET /api/users/:id — Detail user
router.get('/:id', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'ID user tidak valid' });

  try {
    const { rows } = await db.query(
      `SELECT id, nama, nama AS name, email, role, is_active, must_change_password, created_at
       FROM users WHERE id = $1`,
      [userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User tidak ditemukan' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[users] GET :id error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/users/:id — Update data staff/user
router.put('/:id', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'ID user tidak valid' });

  const { name, nama, role, is_active } = req.body;
  const userName = (nama || name || '').trim();

  let dbClient;
  try {
    const currentRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!currentRes.rows[0]) return res.status(404).json({ error: 'User tidak ditemukan' });
    const current = currentRes.rows[0];

    // Mencegah owner menonaktifkan dirinya sendiri
    if (req.user.id === userId && is_active === false) {
      return res.status(400).json({ error: 'Tidak dapat menonaktifkan akun sendiri' });
    }

    const updatedRole = role !== undefined ? role : current.role;
    const updatedActive = is_active !== undefined ? Boolean(is_active) : current.is_active;

    dbClient = await db.getClient();
    await dbClient.query('BEGIN');

    const updateRes = await dbClient.query(
      `UPDATE users
       SET nama = COALESCE(NULLIF($1, ''), nama),
           role = $2,
           is_active = $3
       WHERE id = $4
       RETURNING id, nama, nama AS name, email, role, is_active, must_change_password`,
      [
        userName || null,
        updatedRole,
        updatedActive,
        userId
      ]
    );
    const updated = updateRes.rows[0];

    // Jika user dinonaktifkan, cabut semua refresh token & invalidate token_version cache
    if (updatedActive === false) {
      await dbClient.query(
        `UPDATE users SET token_version = token_version + 1 WHERE id = $1`,
        [userId]
      );
      await dbClient.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
      invalidateUserState(userId);
    }

    await audit.record(dbClient, {
      req,
      aksi: 'user.update',
      entitas: 'user',
      entitas_id: userId,
      data_sebelum: {
        nama: current.nama,
        role: current.role,
        is_active: current.is_active
      },
      data_setelah: {
        nama: updated.nama,
        role: updated.role,
        is_active: updated.is_active
      }
    });

    await dbClient.query('COMMIT');
    res.json({ message: 'User berhasil diperbarui', user: updated });
  } catch (err) {
    if (dbClient) await dbClient.query('ROLLBACK');
    console.error('[users] PUT error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (dbClient) dbClient.release();
  }
});

// POST /api/users/:id/reset-password — Reset password user (Owner only)
router.post('/:id/reset-password', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'ID user tidak valid' });

  const { new_password } = req.body;
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'Password baru minimal 8 karakter' });
  }

  let dbClient;
  try {
    const userRes = await db.query('SELECT id, email, token_version FROM users WHERE id = $1', [userId]);
    if (!userRes.rows[0]) return res.status(404).json({ error: 'User tidak ditemukan' });

    const salt = await bcrypt.genSalt(12);
    const hash = await bcrypt.hash(new_password, salt);

    dbClient = await db.getClient();
    await dbClient.query('BEGIN');

    await dbClient.query(
      `UPDATE users
       SET password_hash = $1,
           must_change_password = true,
           token_version = token_version + 1
       WHERE id = $2`,
      [hash, userId]
    );

    await dbClient.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );

    invalidateUserState(userId);

    await audit.record(dbClient, {
      req,
      aksi: 'user.reset_password',
      entitas: 'user',
      entitas_id: userId,
      data_setelah: { must_change_password: true, sessions_revoked: true }
    });

    await dbClient.query('COMMIT');
    res.json({ message: 'Password user berhasil direset. User wajib ganti password pada login berikutnya.' });
  } catch (err) {
    if (dbClient) await dbClient.query('ROLLBACK');
    console.error('[users] reset-password error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (dbClient) dbClient.release();
  }
});

// POST /api/users/:id/revoke-sessions — Cabut semua sesi aktif user
router.post('/:id/revoke-sessions', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'ID user tidak valid' });

  let dbClient;
  try {
    const userRes = await db.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!userRes.rows[0]) return res.status(404).json({ error: 'User tidak ditemukan' });

    dbClient = await db.getClient();
    await dbClient.query('BEGIN');

    await dbClient.query(
      `UPDATE users SET token_version = token_version + 1 WHERE id = $1`,
      [userId]
    );

    await dbClient.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );

    invalidateUserState(userId);

    await audit.record(dbClient, {
      req,
      aksi: 'user.revoke_sessions',
      entitas: 'user',
      entitas_id: userId,
      data_setelah: { sessions_revoked: true }
    });

    await dbClient.query('COMMIT');
    res.json({ message: 'Semua sesi user berhasil dicabut' });
  } catch (err) {
    if (dbClient) await dbClient.query('ROLLBACK');
    console.error('[users] revoke-sessions error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (dbClient) dbClient.release();
  }
});

module.exports = router;
