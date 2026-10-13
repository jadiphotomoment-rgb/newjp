'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

router.use(auth);
router.use(auth.requirePermission('category.manage'));

// GET /api/admin/categories — list semua kategori
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM booking_categories ORDER BY id'
    );
    res.json(rows);
  } catch (err) {
    console.error('[categories] GET error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/admin/categories — tambah kategori baru
router.post('/', auth, async (req, res) => {
  const { name, slug } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'Nama dan Slug kategori wajib diisi' });
  
  // Format slug to lowercase and alphanumeric with dashes
  const formattedSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!formattedSlug) return res.status(400).json({ error: 'Slug tidak valid' });

  try {
    // Check if slug already exists
    const check = await db.query('SELECT id FROM booking_categories WHERE slug = $1', [formattedSlug]);
    if (check.rows.length > 0) return res.status(409).json({ error: 'Slug sudah digunakan oleh kategori lain' });

    const { rows } = await db.query(
      `INSERT INTO booking_categories (slug, name, fields, packages, dp_type, dp_value, color, is_active)
       VALUES ($1, $2, '[]', '[]', 'percent', 30, '#7c6dfa', true) RETURNING *`,
      [formattedSlug, name.trim()]
    );
    res.status(201).json({ message: 'Kategori baru berhasil ditambahkan', category: rows[0] });
  } catch (err) {
    console.error('[categories] POST error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/categories/:id — detail satu kategori
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM booking_categories WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[categories] GET detail error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/admin/categories/:id — update kategori (form-builder & paket harga)
router.put('/:id', auth, async (req, res) => {
  const { name, fields, packages, dp_type, dp_value, color, time_slots, drive_folder_id, drive_folder_name } = req.body;

  if (!name) return res.status(400).json({ error: 'Nama kategori wajib diisi' });
  if (!['percent', 'fixed'].includes(dp_type)) {
    return res.status(400).json({ error: 'dp_type harus "percent" atau "fixed"' });
  }
  if (isNaN(parseFloat(dp_value)) || parseFloat(dp_value) < 0) {
    return res.status(400).json({ error: 'dp_value tidak valid' });
  }
  if (!Array.isArray(fields)) {
    return res.status(400).json({ error: 'fields harus berupa array' });
  }

  // Validasi struktur fields
  for (const f of fields) {
    if (!f.key || !f.label || !f.type) {
      return res.status(400).json({ error: 'Setiap field harus punya key, label, dan type' });
    }
    const VALID_TYPES = ['text', 'number', 'select', 'date', 'textarea', 'tel'];
    if (!VALID_TYPES.includes(f.type)) {
      return res.status(400).json({ error: `Tipe field tidak valid: ${f.type}` });
    }
  }

  // Validasi packages jika dikirim
  const validPackages = Array.isArray(packages) ? packages.map((p, idx) => ({
    id: p.id || `pkg_${Date.now()}_${idx}`,
    name: (p.name || '').trim(),
    price: parseFloat(p.price) || 0,
    description: (p.description || '').trim()
  })) : [];

  try {
    const { rows } = await db.query(
      `UPDATE booking_categories
       SET name = $1, fields = $2, dp_type = $3, dp_value = $4, color = $5, time_slots = $6, packages = $7,
           drive_folder_id = $8, drive_folder_name = $9
       WHERE id = $10
       RETURNING *`,
      [
        name.trim(),
        JSON.stringify(fields),
        dp_type,
        parseFloat(dp_value),
        color || '#7c6dfa',
        JSON.stringify(time_slots || []),
        JSON.stringify(validPackages),
        drive_folder_id ? drive_folder_id.trim() : null,
        drive_folder_name ? drive_folder_name.trim() : null,
        req.params.id
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
    res.json({ message: 'Kategori & Paket Harga berhasil diperbarui', category: rows[0] });
  } catch (err) {
    console.error('[categories] PUT error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/admin/categories/:id/toggle — aktifkan/nonaktifkan
router.patch('/:id/toggle', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE booking_categories SET is_active = NOT is_active WHERE id = $1 RETURNING id, slug, is_active`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
    res.json({ message: `Kategori ${rows[0].is_active ? 'diaktifkan' : 'dinonaktifkan'}`, ...rows[0] });
  } catch (err) {
    console.error('[categories] toggle error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/settings — ambil semua konfigurasi app
router.get('/settings/all', auth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT key, value, label FROM app_settings ORDER BY key');
    const settings = {};
    for (const r of rows) settings[r.key] = { value: r.value, label: r.label };
    res.json(settings);
  } catch (err) {
    console.error('[settings] GET error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/admin/settings — update konfigurasi app
router.put('/settings/all', auth, async (req, res) => {
  const { settings } = req.body; // { key: value, ... }
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'Body harus berupa { settings: { key: value } }' });
  }
  try {
    for (const [key, value] of Object.entries(settings)) {
      await db.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [key, value || null]
      );
    }
    res.json({ message: 'Pengaturan berhasil disimpan' });
  } catch (err) {
    console.error('[settings] PUT error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
