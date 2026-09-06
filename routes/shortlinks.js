'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');
const crypto  = require('crypto');

// Helper to generate random short code
function generateShortCode(length = 6) {
  return crypto.randomBytes(Math.ceil(length * 3 / 4))
    .toString('base64')
    .replace(/\+/g, '0')
    .replace(/\//g, '1')
    .substring(0, length);
}

// GET /api/shortlinks — Ambil daftar shortlinks
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.short_code, s.original_url, s.created_at,
              COALESCE(COUNT(c.id), 0) AS total_clicks
       FROM shortlinks s
       LEFT JOIN shortlink_clicks c ON s.id = c.shortlink_id
       GROUP BY s.id
       ORDER BY s.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[shortlinks] get list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/shortlinks — Buat shortlink baru
router.post('/', auth, async (req, res) => {
  const { original_url, custom_code } = req.body;
  if (!original_url) return res.status(400).json({ error: 'URL asli wajib diisi' });

  // Validasi URL basic
  let validUrl = original_url;
  if (!/^https?:\/\//i.test(validUrl)) {
    validUrl = 'http://' + validUrl;
  }

  if (custom_code) {
    // Validasi custom code (hanya huruf, angka, strip, underscore)
    if (!/^[a-zA-Z0-9-_]+$/.test(custom_code)) {
      return res.status(400).json({ error: 'Custom alias hanya boleh berisi huruf, angka, strip, dan underscore' });
    }
    try {
      const { rows } = await db.query(
        'INSERT INTO shortlinks (short_code, original_url, admin_id) VALUES ($1, $2, $3) RETURNING *',
        [custom_code, validUrl, req.admin.adminId]
      );
      return res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') { // unique_violation
        return res.status(400).json({ error: 'Custom alias sudah digunakan, silakan pilih yang lain' });
      }
      console.error('[shortlinks] create custom error:', err);
      return res.status(500).json({ error: 'Gagal membuat shortlink custom' });
    }
  }

  let code = generateShortCode();
  let maxRetries = 5;
  let success = false;
  
  // Pastikan unik
  while (maxRetries > 0) {
    try {
      const { rows } = await db.query(
        'INSERT INTO shortlinks (short_code, original_url, admin_id) VALUES ($1, $2, $3) RETURNING *',
        [code, validUrl, req.admin.adminId]
      );
      success = true;
      res.status(201).json(rows[0]);
      break;
    } catch (err) {
      if (err.code === '23505') { // unique_violation
        code = generateShortCode();
        maxRetries--;
      } else {
        console.error('[shortlinks] create error:', err);
        return res.status(500).json({ error: 'Gagal membuat shortlink' });
      }
    }
  }

  if (!success) {
    res.status(500).json({ error: 'Gagal membuat kode unik setelah beberapa percobaan' });
  }
});

// PUT /api/shortlinks/:id — Edit shortlink
router.put('/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { original_url, short_code } = req.body;
  
  if (!original_url || !short_code) return res.status(400).json({ error: 'URL asli dan short code wajib diisi' });

  if (!/^[a-zA-Z0-9-_]+$/.test(short_code)) {
    return res.status(400).json({ error: 'Short code hanya boleh berisi huruf, angka, strip, dan underscore' });
  }

  let validUrl = original_url;
  if (!/^https?:\/\//i.test(validUrl)) {
    validUrl = 'http://' + validUrl;
  }

  try {
    const { rows } = await db.query(
      'UPDATE shortlinks SET original_url = $1, short_code = $2 WHERE id = $3 RETURNING *',
      [validUrl, short_code, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Shortlink tidak ditemukan' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return res.status(400).json({ error: 'Short code sudah digunakan, silakan pilih yang lain' });
    }
    console.error('[shortlinks] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/shortlinks/:id/stats — Ambil statistik 7 hari terakhir & detail perangkat/referer
router.get('/:id/stats', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Trend 7 hari
    const { rows: trendRows } = await db.query(
      `SELECT TO_CHAR(clicked_at, 'YYYY-MM-DD') as date, COUNT(*) as clicks
       FROM shortlink_clicks
       WHERE shortlink_id = $1 AND clicked_at >= NOW() - INTERVAL '7 days'
       GROUP BY TO_CHAR(clicked_at, 'YYYY-MM-DD')
       ORDER BY date ASC`,
      [id]
    );

    // Top 10 Referrers
    const { rows: referrersRows } = await db.query(
      `SELECT COALESCE(NULLIF(referrer, ''), 'Direct') as referrer, COUNT(*) as clicks
       FROM shortlink_clicks
       WHERE shortlink_id = $1
       GROUP BY COALESCE(NULLIF(referrer, ''), 'Direct')
       ORDER BY clicks DESC
       LIMIT 10`,
      [id]
    );

    // Device grouping (basic parsing from user_agent)
    const { rows: uaRows } = await db.query(
      `SELECT user_agent
       FROM shortlink_clicks
       WHERE shortlink_id = $1
       LIMIT 500`, // limit to avoid massive memory load for now
      [id]
    );
    
    let devices = { Mobile: 0, Desktop: 0, Other: 0 };
    uaRows.forEach(row => {
      const ua = (row.user_agent || '').toLowerCase();
      if (/mobi|android|iphone|ipad/i.test(ua)) devices.Mobile++;
      else if (/windows|macintosh|linux/i.test(ua)) devices.Desktop++;
      else devices.Other++;
    });

    res.json({
      trend: trendRows,
      referrers: referrersRows,
      devices: Object.keys(devices).map(k => ({ device: k, count: devices[k] })).filter(d => d.count > 0)
    });
  } catch (err) {
    console.error('[shortlinks] get stats error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/shortlinks/:id — Hapus shortlink
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await db.query('DELETE FROM shortlinks WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Shortlink tidak ditemukan' });
    res.json({ message: 'Shortlink berhasil dihapus' });
  } catch (err) {
    console.error('[shortlinks] delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
