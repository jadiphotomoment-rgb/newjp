'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const auth = require('../middleware/auth');

const publicRouter = express.Router();
const adminRouter = express.Router();

// ── In-Memory Cache untuk Versi Aktif (TTL 5 Menit) ─────────────────────────
let cachedActiveTerms = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

let tablesEnsured = false;
async function ensureTermsTables() {
  if (tablesEnsured) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS terms_versions (
        id              SERIAL PRIMARY KEY,
        version_number  INT NOT NULL,
        title           VARCHAR(255) NOT NULL DEFAULT 'Syarat & Ketentuan Umum Layanan Studio',
        content_points  JSONB NOT NULL DEFAULT '[]'::jsonb,
        status          VARCHAR(20) NOT NULL DEFAULT 'draft',
        created_by      INT NULL,
        published_at    TIMESTAMP NULL,
        created_at      TIMESTAMP DEFAULT now(),
        updated_at      TIMESTAMP DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_terms_versions_active 
        ON terms_versions (status) 
        WHERE status = 'active';

      CREATE INDEX IF NOT EXISTS ix_terms_versions_status 
        ON terms_versions (status);

      CREATE TABLE IF NOT EXISTS terms_acceptances (
        id                  SERIAL PRIMARY KEY,
        booking_id          INT NOT NULL,
        terms_version_id    INT NOT NULL,
        snapshot_text       TEXT NOT NULL,
        verification_token  VARCHAR(64) UNIQUE NOT NULL,
        client_name         VARCHAR(150) NOT NULL,
        client_phone        VARCHAR(30) NOT NULL,
        ip_address          VARCHAR(50) NULL,
        user_agent          TEXT NULL,
        accepted_at         TIMESTAMP NOT NULL DEFAULT now(),
        created_at          TIMESTAMP DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS ix_terms_acceptances_booking_id 
        ON terms_acceptances (booking_id);

      CREATE INDEX IF NOT EXISTS ix_terms_acceptances_token 
        ON terms_acceptances (verification_token);

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='terms_accepted_at') THEN
          ALTER TABLE bookings ADD COLUMN terms_accepted_at TIMESTAMP NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'terms_versions_created_by_fkey') THEN
          ALTER TABLE terms_versions DROP CONSTRAINT terms_versions_created_by_fkey;
        END IF;
      END $$;

      INSERT INTO terms_versions (version_number, title, content_points, status, published_at)
      SELECT 
        1,
        'Syarat & Ketentuan Umum Layanan Studio',
        jsonb_build_array(
          'Kehadiran & Ketepatan Waktu: Klien wajib hadir di lokasi studio minimal 15 menit sebelum sesi foto dimulai. Keterlambatan kedatangan oleh klien akan mengurangi durasi waktu sesi tanpa kompensasi penambahan waktu.',
          'Ketentuan Uang Muka (DP): Pembayaran Uang Muka (DP) bersifat mengikat slot jadwal dan tidak dapat dikembalikan (non-refundable) apabila terjadi pembatalan sepihak oleh pihak klien.',
          'Penjadwalan Ulang (Reschedule): Permohonan jadwal ulang (reschedule) hanya diperbolehkan maksimal H-3 sebelum tanggal sesi foto dan wajib menyesuaikan ketersediaan slot kosong studio.',
          'Hak Cipta & Penyerahan Berkas: Studio berhak menggunakan sebagian hasil foto untuk keperluan portofolio/media sosial kecuali dinyatakan lain secara tertulis; berkas foto mentah (raw) dan hasil edit akan diserahkan setelah seluruh biaya pelunasan diselesaikan.'
        ),
        'active',
        now()
      WHERE NOT EXISTS (
        SELECT 1 FROM terms_versions WHERE status = 'active'
      );
    `);
    tablesEnsured = true;
  } catch (err) {
    // Abaikan jika database mock/test tidak mendukung DDL atau sudah ada
  }
}

async function getActiveTerms(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && cachedActiveTerms && now < cacheExpiry) {
    return cachedActiveTerms;
  }

  await ensureTermsTables();

  const { rows } = await db.query(
    `SELECT id, version_number, title, content_points, published_at
     FROM terms_versions
     WHERE status = 'active'
     ORDER BY version_number DESC, id DESC
     LIMIT 1`
  );

  if (rows.length === 0) {
    cachedActiveTerms = null;
    return null;
  }

  const row = rows[0];
  let points = [];
  if (Array.isArray(row.content_points)) {
    points = row.content_points;
  } else if (typeof row.content_points === 'string') {
    try {
      points = JSON.parse(row.content_points);
    } catch (_) {
      points = [];
    }
  }

  cachedActiveTerms = {
    id: row.id,
    version_number: row.version_number,
    title: row.title,
    points: points,
    published_at: row.published_at
  };
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedActiveTerms;
}

function clearActiveTermsCache() {
  cachedActiveTerms = null;
  cacheExpiry = 0;
}

// ── Endpoint Publik ─────────────────────────────────────────────────────────

// GET /api/terms/active: Mendapatkan versi T&C aktif untuk form booking
publicRouter.get('/active', async (req, res) => {
  try {
    const active = await getActiveTerms();
    if (!active) {
      return res.status(404).json({ error: 'Belum ada Syarat & Ketentuan yang aktif' });
    }
    res.json(active);
  } catch (err) {
    console.error('[terms] get active error:', err);
    res.status(500).json({ error: 'Gagal mengambil Syarat & Ketentuan aktif' });
  }
});

// GET /api/terms/verify/:token: Verifikasi publik bukti persetujuan T&C
publicRouter.get('/verify/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token || token.length < 16) {
      return res.status(400).json({ error: 'Token verifikasi tidak valid' });
    }

    const { rows } = await db.query(
      `SELECT ta.id, ta.booking_id, ta.terms_version_id, ta.snapshot_text,
              ta.verification_token, ta.client_name, ta.client_phone, ta.accepted_at,
              tv.version_number, tv.title AS version_title
       FROM terms_acceptances ta
       LEFT JOIN terms_versions tv ON ta.terms_version_id = tv.id
       WHERE ta.verification_token = $1
       LIMIT 1`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Catatan persetujuan T&C tidak ditemukan' });
    }

    const row = rows[0];
    res.json({
      valid: true,
      booking_id: row.booking_id,
      client_name: row.client_name,
      version_number: row.version_number,
      title: row.version_title,
      accepted_at: row.accepted_at,
      snapshot_text: row.snapshot_text
    });
  } catch (err) {
    console.error('[terms] verify token error:', err);
    res.status(500).json({ error: 'Gagal memverifikasi catatan persetujuan' });
  }
});

// ── Endpoint Admin (Terbuka untuk Staf, Admin, dan Owner yang login) ────────

// GET /api/admin/terms: Riwayat seluruh versi T&C
adminRouter.get('/', auth, async (req, res) => {
  try {
    await ensureTermsTables();
    let rows;
    try {
      const qRes = await db.query(
        `SELECT tv.id, tv.version_number, tv.title, tv.content_points, tv.status,
                tv.created_by, tv.published_at, tv.created_at, tv.updated_at,
                COALESCE(u.nama, a.name, 'Sistem') AS creator_name
         FROM terms_versions tv
         LEFT JOIN users u ON tv.created_by = u.id
         LEFT JOIN admins a ON tv.created_by = a.id
         ORDER BY 
           CASE WHEN tv.status = 'active' THEN 0 WHEN tv.status = 'draft' THEN 1 ELSE 2 END,
           tv.version_number DESC, tv.id DESC`
      );
      rows = qRes.rows;
    } catch (_) {
      const qResFallback = await db.query(
        `SELECT tv.id, tv.version_number, tv.title, tv.content_points, tv.status,
                tv.created_by, tv.published_at, tv.created_at, tv.updated_at,
                'Sistem' AS creator_name
         FROM terms_versions tv
         ORDER BY 
           CASE WHEN tv.status = 'active' THEN 0 WHEN tv.status = 'draft' THEN 1 ELSE 2 END,
           tv.version_number DESC, tv.id DESC`
      );
      rows = qResFallback.rows;
    }
    res.json({ data: rows });
  } catch (err) {
    console.error('[admin/terms] list error:', err);
    res.status(500).json({ error: 'Gagal mengambil daftar T&C' });
  }
});

// GET /api/admin/terms/:id: Detail satu versi T&C
adminRouter.get('/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'ID tidak valid' });

    await ensureTermsTables();
    let row;
    try {
      const qRes = await db.query(
        `SELECT tv.*, COALESCE(u.nama, a.name, 'Sistem') AS creator_name
         FROM terms_versions tv
         LEFT JOIN users u ON tv.created_by = u.id
         LEFT JOIN admins a ON tv.created_by = a.id
         WHERE tv.id = $1`,
        [id]
      );
      row = qRes.rows[0];
    } catch (_) {
      const qResFallback = await db.query(
        `SELECT tv.*, 'Sistem' AS creator_name
         FROM terms_versions tv
         WHERE tv.id = $1`,
        [id]
      );
      row = qResFallback.rows[0];
    }

    if (!row) {
      return res.status(404).json({ error: 'Versi T&C tidak ditemukan' });
    }
    res.json({ data: row });
  } catch (err) {
    console.error('[admin/terms] detail error:', err);
    res.status(500).json({ error: 'Gagal mengambil detail T&C' });
  }
});

// PUT /api/admin/terms/draft: Simpan / perbarui draf T&C
adminRouter.put('/draft', auth, async (req, res) => {
  try {
    await ensureTermsTables();
    const title = (req.body.title || 'Syarat & Ketentuan Umum Layanan Studio').trim();
    const rawPoints = Array.isArray(req.body.points) ? req.body.points : [];
    const points = rawPoints
      .map(p => typeof p === 'string' ? p.trim() : (p && p.text ? String(p.text).trim() : ''))
      .filter(Boolean);

    const { rows: draftRows } = await db.query(
      `SELECT id FROM terms_versions WHERE status = 'draft' ORDER BY id DESC LIMIT 1`
    );

    let resultRow;
    if (draftRows.length > 0) {
      const updateRes = await db.query(
        `UPDATE terms_versions
         SET title = $1, content_points = $2::jsonb, updated_at = now()
         WHERE id = $3
         RETURNING *`,
        [title, JSON.stringify(points), draftRows[0].id]
      );
      resultRow = updateRes.rows[0];
    } else {
      const { rows: maxRows } = await db.query(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_ver FROM terms_versions`
      );
      const nextVer = parseInt(maxRows[0].next_ver, 10);
      let insertRes;
      try {
        insertRes = await db.query(
          `INSERT INTO terms_versions (version_number, title, content_points, status, created_by, updated_at)
           VALUES ($1, $2, $3::jsonb, 'draft', $4, now())
           RETURNING *`,
          [nextVer, title, JSON.stringify(points), req.user ? req.user.id : null]
        );
      } catch (fkErr) {
        // Fallback jika foreign key constraint created_by gagal
        insertRes = await db.query(
          `INSERT INTO terms_versions (version_number, title, content_points, status, created_by, updated_at)
           VALUES ($1, $2, $3::jsonb, 'draft', NULL, now())
           RETURNING *`,
          [nextVer, title, JSON.stringify(points)]
        );
      }
      resultRow = insertRes.rows[0];
    }

    res.json({ message: 'Draf T&C berhasil disimpan', data: resultRow });
  } catch (err) {
    console.error('[admin/terms] save draft error:', err);
    res.status(500).json({ error: 'Gagal menyimpan draf T&C' });
  }
});

// POST /api/admin/terms/publish: Menerbitkan versi baru T&C (atomik 1 DB transaction)
adminRouter.post('/publish', auth, async (req, res) => {
  let client;
  try {
    await ensureTermsTables();
    let title = req.body.title ? String(req.body.title).trim() : '';
    let rawPoints = req.body.points;

    // Jika body tidak mengirim points lengkap, coba baca dari draf aktif
    if (!rawPoints) {
      const { rows: draftRows } = await db.query(
        `SELECT title, content_points FROM terms_versions WHERE status = 'draft' ORDER BY id DESC LIMIT 1`
      );
      if (draftRows.length > 0) {
        if (!title) title = draftRows[0].title;
        rawPoints = draftRows[0].content_points;
      }
    }

    if (!title) title = 'Syarat & Ketentuan Umum Layanan Studio';

    let points = [];
    if (Array.isArray(rawPoints)) {
      points = rawPoints
        .map(p => typeof p === 'string' ? p.trim() : (p && p.text ? String(p.text).trim() : ''))
        .filter(Boolean);
    } else if (typeof rawPoints === 'string') {
      try {
        const parsed = JSON.parse(rawPoints);
        if (Array.isArray(parsed)) {
          points = parsed.map(p => String(p).trim()).filter(Boolean);
        }
      } catch (_) {}
    }

    // 1. Validasi: Tolak publish jika poin kosong
    if (points.length === 0) {
      return res.status(400).json({ error: 'Poin Syarat & Ketentuan tidak boleh kosong' });
    }

    // 2. Validasi: Tolak jika isi tidak berubah dari versi aktif saat ini
    const currentActive = await getActiveTerms(true);
    if (currentActive) {
      const currentPoints = Array.isArray(currentActive.points) ? currentActive.points : [];
      const sameTitle = (currentActive.title || '').trim() === title;
      const samePoints = JSON.stringify(currentPoints) === JSON.stringify(points);
      if (sameTitle && samePoints) {
        return res.status(400).json({
          error: 'Isi Syarat & Ketentuan tidak berubah dari versi aktif saat ini'
        });
      }
    }

    // 3. Eksekusi 1 DB Transaction
    client = await db.getClient();
    await client.query('BEGIN');

    // Dapatkan next_ver dari versi terbesar
    const maxRes = await client.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_ver FROM terms_versions`
    );
    const nextVersion = parseInt(maxRes.rows[0].next_ver, 10);

    // Arsipkan versi aktif sebelumnya
    await client.query(
      `UPDATE terms_versions
       SET status = 'archived', updated_at = now()
       WHERE status = 'active'`
    );

    // Hapus draft yang mungkin ada karena sudah dipublish
    await client.query(`DELETE FROM terms_versions WHERE status = 'draft'`);

    // Insert versi aktif baru
    let insertRes;
    try {
      insertRes = await client.query(
        `INSERT INTO terms_versions (version_number, title, content_points, status, created_by, published_at, updated_at)
         VALUES ($1, $2, $3::jsonb, 'active', $4, now(), now())
         RETURNING *`,
        [nextVersion, title, JSON.stringify(points), req.user ? req.user.id : null]
      );
    } catch (fkErr) {
      insertRes = await client.query(
        `INSERT INTO terms_versions (version_number, title, content_points, status, created_by, published_at, updated_at)
         VALUES ($1, $2, $3::jsonb, 'active', NULL, now(), now())
         RETURNING *`,
        [nextVersion, title, JSON.stringify(points)]
      );
    }

    await client.query('COMMIT');

    // Bersihkan in-memory cache
    clearActiveTermsCache();

    res.status(201).json({
      message: 'Versi Syarat & Ketentuan baru berhasil dipublikasikan',
      data: insertRes.rows[0]
    });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('[admin/terms] publish error:', err);
    res.status(500).json({ error: 'Gagal mempublikasikan versi T&C baru' });
  } finally {
    if (client) client.release();
  }
});

module.exports = {
  publicRouter,
  adminRouter,
  getActiveTerms,
  clearActiveTermsCache
};
