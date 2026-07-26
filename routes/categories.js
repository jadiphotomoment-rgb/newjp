'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

// GET /api/admin/categories — list semua kategori
router.get('/', auth, async (req, res) => {
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

// PUT /api/admin/categories/:id — update kategori (form-builder)
router.put('/:id', auth, async (req, res) => {
  const { name, fields, dp_type, dp_value, color, time_slots, wa_template } = req.body;

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

  try {
    const { rows } = await db.query(
      `UPDATE booking_categories
       SET name = $1, fields = $2, dp_type = $3, dp_value = $4, color = $5, time_slots = $6, wa_template = $7
       WHERE id = $8
       RETURNING *`,
      [name.trim(), JSON.stringify(fields), dp_type, parseFloat(dp_value), color || '#7c6dfa', JSON.stringify(time_slots || []), wa_template || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
    res.json({ message: 'Kategori berhasil diperbarui', category: rows[0] });
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

module.exports = router;
