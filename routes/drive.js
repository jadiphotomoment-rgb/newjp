'use strict';

const express = require('express');
const router  = express.Router();
const https   = require('https');
const http    = require('http');
const db      = require('../database');

// ── In-memory cache untuk file list (TTL 5 menit) ────────────────
const fileListCache = new Map();
const CACHE_TTL_MS  = 5 * 60 * 1000; // 5 menit

function getCached(key) {
  const entry = fileListCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { fileListCache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  fileListCache.set(key, { data, ts: Date.now() });
}

// ── Helper: HTTP/HTTPS GET dengan follow redirect ─────────────────
function httpGet(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, timeout).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── GET /api/drive/files?session=UUID ─────────────────────────────
router.get('/files', async (req, res) => {
  const { session: sessionUuid } = req.query;

  if (!sessionUuid) {
    return res.status(400).json({ error: 'Parameter session diperlukan' });
  }

  // Cek API Key
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
  if (!apiKey || apiKey === 'GANTI_DENGAN_API_KEY_ANDA') {
    return res.status(500).json({
      error: 'Google Drive API Key belum dikonfigurasi di server.',
      hint: ['Admin perlu memasukkan GOOGLE_DRIVE_API_KEY di file .env server']
    });
  }

  // Get session dari DB
  let session;
  try {
    const { rows } = await db.query('SELECT folder_id, status FROM sessions WHERE uuid = $1', [sessionUuid]);
    session = rows[0];
  } catch (err) {
    console.error('[drive] db error:', err);
    return res.status(500).json({ error: 'Database error' });
  }

  if (!session) {
    return res.status(404).json({ error: 'Sesi tidak ditemukan' });
  }
  if (session.status !== 'active') {
    return res.status(403).json({ error: 'Sesi ini sudah tidak aktif' });
  }

  const folderId = session.folder_id;

  // Cek cache dulu — hindari hit API berulang
  const cacheKey = `files_${folderId}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[drive] cache hit: ${folderId}`);
    return res.json(cached);
  }

  try {
    const q      = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`);
    const fields = encodeURIComponent('files(id,name,mimeType)'); // hanya ambil field yang perlu, lebih cepat!
    const url    = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000&orderBy=name&key=${apiKey}`;

    console.log(`[drive] fetching folder: ${folderId}`);
    const data   = await httpGet(url);
    const parsed = JSON.parse(data.body.toString('utf8'));

    if (data.status !== 200) {
      console.error('[drive] API error:', parsed.error?.message);
      return res.status(502).json({
        error: 'Gagal mengakses folder Google Drive.',
        hint: [
          parsed.error?.message || 'Pastikan link folder valid',
          'Pastikan folder diset "Siapa saja dengan link dapat melihat"'
        ]
      });
    }

    if (!parsed.files || parsed.files.length === 0) {
      return res.status(404).json({
        error: 'Tidak ada foto ditemukan di folder ini.',
        hint: [
          'Pastikan folder berisi file gambar (.jpg, .jpeg, .png, dll)',
          'Pastikan akses folder sudah diset ke "Publik / Anyone with the link"'
        ],
      });
    }

    // Gunakan endpoint /api/drive/thumbnail/:id sebagai proxy (relative path aman dari Mixed Content)
    const files  = parsed.files.map(f => ({
      id:           f.id,
      name:         f.name,
      thumbnailUrl: `/api/drive/thumbnail/${f.id}?sz=s400`,
      fullUrl:      `/api/drive/thumbnail/${f.id}?sz=s1200`,
    }));

    const result = { files, total: files.length };
    setCache(cacheKey, result);
    console.log(`[drive] ${files.length} files returned, cached for 5 min`);
    res.json(result);

  } catch (err) {
    console.error('[drive] fetch error:', err.message);
    res.status(502).json({ error: 'Koneksi ke Google Drive gagal: ' + err.message });
  }
});

// ── GET /api/drive/thumbnail/:fileId — Proxy cepat via server ─────
// Ini KUNCI UTAMA: browser minta gambar ke server kita, bukan langsung ke Google.
// Server kita proxy dan cache gambar, sehingga load hanya sekali per gambar.
const thumbCache = new Map(); // fileId+sz → { buf, contentType, ts }
const THUMB_TTL  = 30 * 60 * 1000; // 30 menit

router.get('/thumbnail/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const sz = req.query.sz || 's400';

  // Validasi fileId
  if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
    return res.status(400).send('Invalid file ID');
  }

  const cacheKey = `${fileId}_${sz}`;
  const cached   = thumbCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < THUMB_TTL) {
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=1800'); // 30 menit di browser juga
    res.set('X-Cache', 'HIT');
    return res.send(cached.buf);
  }

  // Google thumbnail URL — jauh lebih cepat dari /uc?export=view
  const googleUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=${sz}`;

  try {
    const data = await httpGet(googleUrl, 10000);

    if (data.status !== 200) {
      // Jika Google menolak, coba fallback ke /uc?export=view (resolusi lebih rendah)
      const fallback = await httpGet(`https://drive.google.com/uc?export=view&id=${fileId}&sz=${sz}`, 10000);
      if (fallback.status !== 200) {
        return res.status(fallback.status).send('Gambar tidak bisa diakses');
      }
      const ct = fallback.headers['content-type'] || 'image/jpeg';
      thumbCache.set(cacheKey, { buf: fallback.body, contentType: ct, ts: Date.now() });
      res.set('Content-Type', ct);
      res.set('Cache-Control', 'public, max-age=1800');
      res.set('X-Cache', 'MISS-FALLBACK');
      return res.send(fallback.body);
    }

    const ct = data.headers['content-type'] || 'image/jpeg';
    thumbCache.set(cacheKey, { buf: data.body, contentType: ct, ts: Date.now() });

    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=1800');
    res.set('X-Cache', 'MISS');
    res.send(data.body);

  } catch (err) {
    console.error('[drive] thumbnail error:', fileId, err.message);
    res.status(502).send('Gagal mengambil gambar');
  }
});

module.exports = router;
