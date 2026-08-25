'use strict';

/**
 * /api/upload — Vercel Blob Upload Handler (Server-Side Proxy)
 *
 * Flow:
 *   1. Browser → POST /api/upload/file (multipart form) → server menerima file
 *   2. Server  → put() ke Vercel Blob (server-to-server, NO CORS issues)
 *   3. Server  → response { url, pathname } ke browser
 *   4. Browser → simpan metadata via /api/bookings/:id/upload-dp atau /api/upload/save-metadata
 *
 * Kenapa server-side proxy?
 *   - Vercel Blob REST API (blob.vercel-storage.com) TIDAK mendukung CORS dari browser
 *   - Client SDK upload() + handleUploadUrl hanya bekerja di Next.js (bukan Express)
 *   - Server-side proxy 100% reliable, tanpa masalah CORS, dan cukup cepat untuk file <5MB
 */

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const db      = require('../database');
const auth    = require('../middleware/auth');

// Multer: simpan file di memory (buffer), max 5MB
const storage = multer.memoryStorage();
const uploadMiddleware = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipe file tidak diizinkan. Gunakan JPG, PNG, WebP, atau PDF.'));
    }
  },
});

// Require @vercel/blob (server-side SDK)
let blobPut, blobDel;
try {
  const blob = require('@vercel/blob');
  blobPut = blob.put;
  blobDel = blob.del;
} catch (e) {
  console.error('[upload] @vercel/blob tidak ditemukan:', e.message);
}

// ── Konstanta ───────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// ── Auto-detect Vercel Blob token ───────────────────────────────
function getBlobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;

  for (const [key, val] of Object.entries(process.env)) {
    if (typeof val === 'string' && (key.endsWith('_READ_WRITE_TOKEN') && val.startsWith('vercel_blob_rw_'))) {
      process.env.BLOB_READ_WRITE_TOKEN = val;
      return val;
    }
  }
  return null;
}

function isBlobConfigured() {
  return !!getBlobToken();
}

// ─────────────────────────────────────────────────────────────────
// GET /api/upload/status
// ─────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const token = getBlobToken();
  const configured = !!token;
  res.json({
    configured,
    message: configured
      ? '✅ Vercel Blob Storage terkonfigurasi di server.'
      : '⚠️ Token Vercel Blob belum terdeteksi di Environment Variables.',
    allowedTypes: ALLOWED_MIME_TYPES,
    maxSizeMB: MAX_FILE_SIZE / (1024 * 1024),
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /api/upload/file
//
// Server-side proxy upload: browser kirim file via multipart form,
// server upload ke Vercel Blob, kembalikan URL.
//
// Form fields:
//   - file      (required) — the file
//   - pathname  (optional) — custom path in blob store
//   - bookingId (optional)
//   - fileType  (optional) — payment_proof | reference | result | portfolio
// ─────────────────────────────────────────────────────────────────
router.post('/file', uploadMiddleware.single('file'), async (req, res) => {
  const token = getBlobToken();
  if (!token) {
    return res.status(500).json({
      error: 'Vercel Blob belum dikonfigurasi.',
      hint: 'Tambahkan BLOB_READ_WRITE_TOKEN ke environment variables.',
    });
  }

  if (!blobPut) {
    return res.status(500).json({ error: '@vercel/blob tidak tersedia di server.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'File wajib dikirim.' });
  }

  try {
    // Tentukan pathname
    const safeOrigName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const pathname = req.body.pathname || `uploads/${Date.now()}-${safeOrigName}`;

    // Upload ke Vercel Blob (server-to-server, no CORS)
    const blob = await blobPut(pathname, req.file.buffer, {
      access: 'public',
      token: token,
      contentType: req.file.mimetype,
      addRandomSuffix: false,
    });

    console.log('[upload] file uploaded to Vercel Blob:', blob.url);

    // Otomatis simpan ke attachments jika bookingId diberikan
    const bookingId = req.body.bookingId || req.query.bookingId || null;
    const fileType = req.body.fileType || req.query.fileType || 'payment_proof';

    if (bookingId) {
      try {
        await db.query(
          `INSERT INTO attachments (booking_id, file_url, blob_key, file_name, file_type, mime_type, file_size)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [bookingId, blob.url, blob.pathname, req.file.originalname, fileType, req.file.mimetype, req.file.size]
        );
      } catch (dbErr) {
        console.warn('[upload] DB save warning:', dbErr.message);
      }
    }

    return res.json({
      url: blob.url,
      downloadUrl: blob.downloadUrl,
      pathname: blob.pathname,
      contentType: blob.contentType,
      size: req.file.size,
    });
  } catch (err) {
    console.error('[upload] file upload error:', err.message);

    if (err.message?.includes('tipe file')) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Gagal mengunggah file ke storage: ' + err.message });
  }
});

// Multer error handler
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Ukuran file terlalu besar. Maksimal 5MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

// ─────────────────────────────────────────────────────────────────
// POST /api/upload/save-metadata  (legacy / fallback)
// ─────────────────────────────────────────────────────────────────
router.post('/save-metadata', async (req, res) => {
  const { bookingId, blobUrl, blobKey, fileName, fileType, mimeType, fileSize } = req.body;

  if (!blobUrl || !fileName) {
    return res.status(400).json({ error: 'blobUrl dan fileName wajib diisi' });
  }

  try {
    const existing = await db.query(
      'SELECT id FROM attachments WHERE file_url = $1 LIMIT 1',
      [blobUrl]
    );

    if (existing.rows.length === 0) {
      await db.query(
        `INSERT INTO attachments (booking_id, file_url, blob_key, file_name, file_type, mime_type, file_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [bookingId || null, blobUrl, blobKey || null, fileName, fileType || 'payment_proof', mimeType || null, fileSize || null]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[upload] save-metadata error:', err.message);
    res.status(500).json({ error: 'Gagal menyimpan metadata file' });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/upload/attachments/:bookingId
// ─────────────────────────────────────────────────────────────────
router.get('/attachments/:bookingId', async (req, res) => {
  const bookingId = parseInt(req.params.bookingId, 10);
  if (isNaN(bookingId)) return res.status(400).json({ error: 'ID booking tidak valid' });

  try {
    const { rows } = await db.query(
      `SELECT id, booking_id, file_url, blob_key, file_name, file_type, mime_type, file_size, created_at
       FROM attachments WHERE booking_id = $1 ORDER BY created_at DESC`,
      [bookingId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[upload] get attachments error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────────
// DELETE /api/upload/attachments/:id  (admin only)
// ─────────────────────────────────────────────────────────────────
router.delete('/attachments/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID attachment tidak valid' });

  try {
    const { rows } = await db.query('SELECT * FROM attachments WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Attachment tidak ditemukan' });

    const attachment = rows[0];

    if (blobDel && isBlobConfigured() && attachment.file_url) {
      try {
        await blobDel(attachment.file_url);
        console.log('[upload] deleted from Vercel Blob:', attachment.file_url);
      } catch (blobErr) {
        console.warn('[upload] warning deleting from Blob:', blobErr.message);
      }
    }

    await db.query('DELETE FROM attachments WHERE id = $1', [id]);
    res.json({ message: 'Attachment berhasil dihapus' });
  } catch (err) {
    console.error('[upload] delete attachment error:', err.message);
    res.status(500).json({ error: 'Gagal menghapus attachment' });
  }
});

module.exports = router;
