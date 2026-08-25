'use strict';

/**
 * /api/upload — Vercel Blob Upload Handler
 *
 * Menggunakan pola "client-side direct upload" dari Vercel Blob:
 *   1. Client minta token → POST /api/upload/token
 *   2. Vercel Blob SDK generate token, client upload langsung ke Blob
 *   3. Setelah upload, Blob memanggil callback onUploadCompleted
 *   4. Metadata tersimpan di tabel `attachments`
 *
 * Referensi: https://vercel.com/docs/storage/vercel-blob/client-upload
 */

const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

// Require @vercel/blob and @vercel/blob/client
let blobHandleUpload;
let blobDel;
try {
  const blobClient = require('@vercel/blob/client');
  blobHandleUpload = blobClient.handleUpload;
  const blob = require('@vercel/blob');
  blobDel = blob.del;
} catch (e) {
  console.error('[upload] @vercel/blob tidak ditemukan:', e.message);
}

// ── Konstanta validasi ──────────────────────────────────────────
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// ── Cek & ambil token Vercel Blob secara dinamis ────────────────
function getBlobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;

  // Auto-detect jika Vercel menyuntikkan dengan nama store khusus (misal: booking_READ_WRITE_TOKEN)
  for (const [key, val] of Object.entries(process.env)) {
    if (typeof val === 'string' && (key.endsWith('_READ_WRITE_TOKEN') || val.startsWith('vercel_blob_rw_'))) {
      process.env.BLOB_READ_WRITE_TOKEN = val; // Set agar SDK resmi Vercel Blob otomatis mendeteksinya
      return val;
    }
  }
  return null;
}

function isBlobConfigured() {
  return !!getBlobToken();
}

/**
 * GET /api/upload/status
 *
 * Cek status konfigurasi Vercel Blob di server
 */
router.get('/status', (req, res) => {
  const token = getBlobToken();
  const configured = !!token;
  res.json({
    configured: configured,
    message: configured
      ? '✅ Vercel Blob Storage terkonfigurasi di server.'
      : '⚠️ Token Vercel Blob belum terdeteksi di Environment Variables.',
    allowedTypes: ALLOWED_MIME_TYPES,
    maxSizeMB: MAX_FILE_SIZE / (1024 * 1024),
  });
});


/**
 * POST /api/upload/token
 *
 * Endpoint yang dipanggil oleh client saat inisialisasi upload ke Vercel Blob.
 *
 * Query params:
 *   - bookingId  (optional) — ID booking yang terkait
 *   - fileType   (optional) — kategori file: payment_proof | reference | result | portfolio
 */
router.post('/token', async (req, res) => {
  if (!isBlobConfigured()) {
    return res.status(500).json({
      error: 'Vercel Blob belum dikonfigurasi.',
      hint: 'Tambahkan BLOB_READ_WRITE_TOKEN ke environment variables.'
    });
  }

  if (!blobHandleUpload) {
    return res.status(500).json({ error: 'Package @vercel/blob/client tidak tersedia di server.' });
  }

  try {
    const jsonBody = req.body && Object.keys(req.body).length > 0
      ? req.body
      : await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', chunk => (data += chunk));
          req.on('end', () => {
            try { resolve(JSON.parse(data || '{}')); }
            catch (e) { reject(new Error('Invalid JSON body')); }
          });
          req.on('error', reject);
        });

    const response = await blobHandleUpload({
      body:    jsonBody,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // Validasi ekstensi file
        const ext = (pathname.split('.').pop() || '').toLowerCase();
        const validExts = ['jpg', 'jpeg', 'png', 'webp', 'pdf'];
        if (!validExts.includes(ext)) {
          throw new Error(`Ekstensi file .${ext} tidak diizinkan. Gunakan: ${validExts.join(', ')}`);
        }

        return {
          allowedContentTypes: ALLOWED_MIME_TYPES,
          maximumSizeInBytes:  MAX_FILE_SIZE,
          tokenPayload:        JSON.stringify({
            bookingId: req.query.bookingId || null,
            fileType:  req.query.fileType  || 'payment_proof',
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Callback webhook dari Vercel setelah upload selesai
        try {
          const payload = JSON.parse(tokenPayload || '{}');
          await db.query(
            `INSERT INTO attachments (booking_id, file_url, blob_key, file_name, file_type, mime_type, file_size)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              payload.bookingId  || null,
              blob.url,
              blob.pathname,
              blob.pathname.split('/').pop(),
              payload.fileType   || 'payment_proof',
              blob.contentType   || null,
              blob.size          || null,
            ]
          );
          console.log('[upload] attachment saved via webhook:', blob.url);
        } catch (dbErr) {
          console.error('[upload] onUploadCompleted DB error:', dbErr.message);
        }
      },
    });

    return res.json(response);
  } catch (err) {
    console.error('[upload] token error:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/upload/save-metadata
 *
 * Simpan metadata ke tabel attachments (fallback atau direct call dari client)
 */
router.post('/save-metadata', async (req, res) => {
  const { bookingId, blobUrl, blobKey, fileName, fileType, mimeType, fileSize } = req.body;

  if (!blobUrl || !fileName) {
    return res.status(400).json({ error: 'blobUrl dan fileName wajib diisi' });
  }

  if (!blobUrl.includes('blob.vercel-storage.com')) {
    return res.status(400).json({ error: 'URL blob tidak valid' });
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
        [
          bookingId  || null,
          blobUrl,
          blobKey    || null,
          fileName,
          fileType   || 'payment_proof',
          mimeType   || null,
          fileSize   || null,
        ]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[upload] save-metadata error:', err.message);
    res.status(500).json({ error: 'Gagal menyimpan metadata file' });
  }
});

/**
 * GET /api/upload/attachments/:bookingId
 *
 * Ambil daftar semua attachment terkait booking tertentu
 */
router.get('/attachments/:bookingId', async (req, res) => {
  const bookingId = parseInt(req.params.bookingId, 10);
  if (isNaN(bookingId)) return res.status(400).json({ error: 'ID booking tidak valid' });

  try {
    const { rows } = await db.query(
      `SELECT id, booking_id, file_url, blob_key, file_name, file_type, mime_type, file_size, created_at
       FROM attachments
       WHERE booking_id = $1
       ORDER BY created_at DESC`,
      [bookingId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[upload] get attachments error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * DELETE /api/upload/attachments/:id
 *
 * Hapus attachment dari database dan dari Vercel Blob Storage (admin only)
 */
router.delete('/attachments/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID attachment tidak valid' });

  try {
    const { rows } = await db.query('SELECT * FROM attachments WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Attachment tidak ditemukan' });

    const attachment = rows[0];

    // Hapus dari Vercel Blob jika SDK & token tersedia
    if (blobDel && isBlobConfigured() && attachment.file_url) {
      try {
        await blobDel(attachment.file_url);
        console.log('[upload] deleted from Vercel Blob:', attachment.file_url);
      } catch (blobErr) {
        console.warn('[upload] warning deleting from Blob:', blobErr.message);
      }
    }

    // Hapus dari tabel attachments
    await db.query('DELETE FROM attachments WHERE id = $1', [id]);

    res.json({ message: 'Attachment berhasil dihapus' });
  } catch (err) {
    console.error('[upload] delete attachment error:', err.message);
    res.status(500).json({ error: 'Gagal menghapus attachment' });
  }
});

module.exports = router;
