'use strict';

/**
 * /api/settings/payment — Pengaturan Metode Pembayaran
 *
 * Endpoints:
 *   GET  /                 → QRIS + rekening aktif (publik, untuk halaman klien)
 *   GET  /admin            → semua rekening termasuk nonaktif (admin)
 *   PUT  /qris             → update URL gambar QRIS setelah upload
 *   DELETE /qris           → hapus gambar QRIS
 *   POST /banks            → tambah rekening bank baru
 *   PUT  /banks/:id        → edit rekening bank
 *   PATCH /banks/:id/toggle → aktifkan / nonaktifkan rekening
 *   PATCH /banks/reorder   → update urutan tampil sekaligus
 *   DELETE /banks/:id      → soft-disable rekening (is_active = false)
 */

const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

// ═══════════════════════════════════════════════════════════════
// PUBLIC — untuk halaman klien (/pelunasan.html)
// ═══════════════════════════════════════════════════════════════

// GET /api/settings/payment — QRIS + rekening aktif (tanpa auth)
router.get('/', async (req, res) => {
  try {
    const [qrisRes, banksRes] = await Promise.all([
      db.query('SELECT qris_image_url, updated_at FROM payment_settings WHERE id = 1'),
      db.query(
        'SELECT id, nama_bank, no_rekening, atas_nama FROM bank_accounts WHERE is_active = true ORDER BY sort_order, id'
      ),
    ]);
    res.json({
      qris_image_url: qrisRes.rows[0]?.qris_image_url || '/img/Qris Jadiphoto.webp',
      bank_accounts: banksRes.rows,
    });
  } catch (err) {
    console.error('[payment-settings] GET / error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════
router.use(auth);
router.use(auth.requirePermission('payment_settings.manage'));

// GET /api/settings/payment/admin — semua data (admin)
router.get('/admin', async (req, res) => {
  try {
    const [qrisRes, banksRes] = await Promise.all([
      db.query('SELECT id, qris_image_url, qris_blob_key, updated_at FROM payment_settings WHERE id = 1'),
      db.query(
        'SELECT id, nama_bank, no_rekening, atas_nama, is_active, sort_order, created_at FROM bank_accounts ORDER BY sort_order, id'
      ),
    ]);
    res.json({
      qris: qrisRes.rows[0] || null,
      bank_accounts: banksRes.rows,
    });
  } catch (err) {
    console.error('[payment-settings] GET /admin error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/settings/payment/qris — update URL gambar QRIS
// Admin upload via POST /api/upload/file dulu, lalu kirim url di sini
router.put('/qris', auth, async (req, res) => {
  const { qris_image_url, qris_blob_key } = req.body;
  if (!qris_image_url || typeof qris_image_url !== 'string') {
    return res.status(400).json({ error: 'URL gambar QRIS wajib diisi' });
  }
  try { new URL(qris_image_url); } catch (_) {
    return res.status(400).json({ error: 'URL gambar QRIS tidak valid' });
  }
  try {
    const { rows } = await db.query(
      `UPDATE payment_settings
       SET qris_image_url = $1, qris_blob_key = $2, updated_at = now()
       WHERE id = 1
       RETURNING id, qris_image_url, updated_at`,
      [qris_image_url, qris_blob_key || null]
    );
    res.json({ message: 'QRIS berhasil diperbarui', data: rows[0] });
  } catch (err) {
    console.error('[payment-settings] PUT /qris error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/settings/payment/qris — hapus gambar QRIS
router.delete('/qris', auth, async (req, res) => {
  try {
    await db.query(
      `UPDATE payment_settings SET qris_image_url = NULL, qris_blob_key = NULL, updated_at = now() WHERE id = 1`
    );
    res.json({ message: 'Gambar QRIS berhasil dihapus' });
  } catch (err) {
    console.error('[payment-settings] DELETE /qris error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Bank Accounts CRUD ─────────────────────────────────────────

// POST /api/settings/payment/banks — tambah rekening baru
router.post('/banks', auth, async (req, res) => {
  const { nama_bank, no_rekening, atas_nama, sort_order } = req.body;
  if (!nama_bank?.trim() || !no_rekening?.trim() || !atas_nama?.trim()) {
    return res.status(400).json({ error: 'Nama bank, nomor rekening, dan atas nama wajib diisi' });
  }
  if (no_rekening.trim().length < 5 || no_rekening.trim().length > 40) {
    return res.status(400).json({ error: 'Nomor rekening harus antara 5–40 karakter' });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO bank_accounts (nama_bank, no_rekening, atas_nama, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [nama_bank.trim(), no_rekening.trim(), atas_nama.trim(), typeof sort_order === 'number' ? sort_order : 0]
    );
    res.status(201).json({ message: 'Rekening bank berhasil ditambahkan', data: rows[0] });
  } catch (err) {
    console.error('[payment-settings] POST /banks error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/settings/payment/banks/reorder — update urutan sekaligus
// HARUS sebelum /banks/:id agar Express tidak salah tangkap "reorder" sebagai :id
router.patch('/banks/reorder', auth, async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: 'Data urutan tidak valid' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    for (const item of order) {
      if (!item.id || typeof item.sort_order !== 'number') continue;
      await client.query('UPDATE bank_accounts SET sort_order = $1 WHERE id = $2', [item.sort_order, item.id]);
    }
    await client.query('COMMIT');
    res.json({ message: 'Urutan rekening berhasil diperbarui' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[payment-settings] PATCH /banks/reorder error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// PUT /api/settings/payment/banks/:id — edit rekening
router.put('/banks/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID tidak valid' });
  const { nama_bank, no_rekening, atas_nama, sort_order } = req.body;
  if (!nama_bank?.trim() || !no_rekening?.trim() || !atas_nama?.trim()) {
    return res.status(400).json({ error: 'Nama bank, nomor rekening, dan atas nama wajib diisi' });
  }
  try {
    const { rows } = await db.query(
      `UPDATE bank_accounts SET nama_bank = $1, no_rekening = $2, atas_nama = $3,
       sort_order = COALESCE($4, sort_order) WHERE id = $5 RETURNING *`,
      [nama_bank.trim(), no_rekening.trim(), atas_nama.trim(), typeof sort_order === 'number' ? sort_order : null, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rekening tidak ditemukan' });
    res.json({ message: 'Rekening berhasil diperbarui', data: rows[0] });
  } catch (err) {
    console.error('[payment-settings] PUT /banks/:id error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/settings/payment/banks/:id/toggle — aktif / nonaktif
router.patch('/banks/:id/toggle', auth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID tidak valid' });
  try {
    const { rows } = await db.query(
      `UPDATE bank_accounts SET is_active = NOT is_active WHERE id = $1 RETURNING id, nama_bank, is_active`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rekening tidak ditemukan' });
    res.json({ message: rows[0].is_active ? 'Rekening diaktifkan' : 'Rekening dinonaktifkan', data: rows[0] });
  } catch (err) {
    console.error('[payment-settings] PATCH /banks/:id/toggle error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/settings/payment/banks/:id — soft-disable (is_active = false)
router.delete('/banks/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID tidak valid' });
  try {
    const { rows } = await db.query(
      `UPDATE bank_accounts SET is_active = false WHERE id = $1 RETURNING id, nama_bank`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rekening tidak ditemukan' });
    res.json({ message: `Rekening ${rows[0].nama_bank} dinonaktifkan`, data: rows[0] });
  } catch (err) {
    console.error('[payment-settings] DELETE /banks/:id error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
