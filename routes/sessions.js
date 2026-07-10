'use strict';

const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db   = require('../database');
const auth = require('../middleware/auth');

// ── Helper: extract Google Drive folder ID from URL ───────────
function extractFolderId(url) {
  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ── Helper: generate short slug from client name ──────────────
function generateSlug(clientName) {
  const base = clientName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // hapus karakter non-alfanumerik (kecuali spasi & strip)
    .trim()
    .replace(/\s+/g, '-')           // spasi → tanda hubung
    .replace(/-+/g, '-')            // deduplicasi strip
    .substring(0, 30);              // maks 30 karakter
  const suffix = Math.random().toString(36).substring(2, 6); // 4 karakter acak
  return `${base}-${suffix}`;
}

// ── GET /api/sessions — list all sessions (admin) ─────────────
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        s.id, s.uuid, s.short_slug, s.client_name, s.folder_url, s.folder_id,
        s.photo_limit, s.status, s.edit_status, s.edit_note,
        s.created_at, s.completed_at,
        (SELECT COUNT(*) FROM selections WHERE session_id = s.id) AS photo_count
      FROM sessions s
      WHERE s.admin_id = $1
      ORDER BY s.created_at DESC
    `, [req.admin.adminId]);
    res.json(rows);
  } catch (err) {
    console.error('[sessions] GET / error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/sessions/stats — dashboard stats (admin) ─────────
router.get('/stats', auth, async (req, res) => {
  try {
    const totalRes      = await db.query('SELECT COUNT(*) AS n FROM sessions WHERE admin_id = $1', [req.admin.adminId]);
    const activeRes     = await db.query("SELECT COUNT(*) AS n FROM sessions WHERE admin_id = $1 AND status = 'active'", [req.admin.adminId]);
    const completedRes  = await db.query("SELECT COUNT(*) AS n FROM sessions WHERE admin_id = $1 AND status = 'completed'", [req.admin.adminId]);
    const totalPicsRes  = await db.query(`
      SELECT COUNT(*) AS n FROM selections sel
      JOIN sessions s ON sel.session_id = s.id
      WHERE s.admin_id = $1
    `, [req.admin.adminId]);

    res.json({
      total:     parseInt(totalRes.rows[0].n, 10),
      active:    parseInt(activeRes.rows[0].n, 10),
      completed: parseInt(completedRes.rows[0].n, 10),
      totalPics: parseInt(totalPicsRes.rows[0].n, 10)
    });
  } catch (err) {
    console.error('[sessions] stats error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/sessions/slug/:slug — get session by short slug (public) ─
router.get('/slug/:slug', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, uuid, short_slug, client_name, folder_id, photo_limit, status,
             edit_status, edit_note, created_at, completed_at
      FROM sessions WHERE short_slug = $1
    `, [req.params.slug]);

    const session = rows[0];
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });
    res.json(session);
  } catch (err) {
    console.error('[sessions] GET slug error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/sessions/:uuid — get one session (public for client) ─
router.get('/:uuid', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, uuid, short_slug, client_name, folder_id, photo_limit, status,
             edit_status, edit_note, created_at, completed_at
      FROM sessions WHERE uuid = $1
    `, [req.params.uuid]);

    const session = rows[0];
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });
    res.json(session);
  } catch (err) {
    console.error('[sessions] GET uuid error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/sessions/:uuid/selections — get selections (admin) ─
router.get('/:uuid/selections', auth, async (req, res) => {
  try {
    const sessionRes = await db.query(
      'SELECT id FROM sessions WHERE uuid = $1 AND admin_id = $2',
      [req.params.uuid, req.admin.adminId]
    );
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    const { rows } = await db.query(
      'SELECT file_id, file_name, note, selected_at FROM selections WHERE session_id = $1 ORDER BY selected_at',
      [session.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[sessions] GET selections error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── POST /api/sessions — create new session (admin) ──────────
router.post('/', auth, async (req, res) => {
  const { clientName, folderUrl, photoLimit } = req.body;

  if (!clientName || !folderUrl || !photoLimit) {
    return res.status(400).json({ error: 'clientName, folderUrl, dan photoLimit wajib diisi' });
  }

  const limit = parseInt(photoLimit, 10);
  if (isNaN(limit) || limit < 1 || limit > 500) {
    return res.status(400).json({ error: 'photoLimit harus antara 1 dan 500' });
  }

  const folderId = extractFolderId(folderUrl.trim());
  if (!folderId) {
    return res.status(400).json({ error: 'URL Google Drive tidak valid. Pastikan berupa link folder Drive.' });
  }

  const uuid = uuidv4();

  // Generate unique short slug (retry jika kebetulan sudah ada)
  let shortSlug;
  let attempt = 0;
  while (attempt < 5) {
    const candidate = generateSlug(clientName);
    const exists = await db.query('SELECT 1 FROM sessions WHERE short_slug = $1', [candidate]);
    if (exists.rows.length === 0) { shortSlug = candidate; break; }
    attempt++;
  }
  if (!shortSlug) shortSlug = uuid.substring(0, 8); // fallback ke 8 char uuid

  try {
    await db.query(`
      INSERT INTO sessions (uuid, short_slug, client_name, folder_url, folder_id, photo_limit, admin_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [uuid, shortSlug, clientName.trim(), folderUrl.trim(), folderId, limit, req.admin.adminId]);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      uuid,
      shortSlug,
      galleryUrl:  `${baseUrl}/gallery.html?session=${uuid}`,
      shortUrl:    `${baseUrl}/s/${shortSlug}`,
      message:     'Sesi berhasil dibuat'
    });
  } catch (err) {
    console.error('[sessions] POST error:', err);
    res.status(500).json({ error: 'Gagal membuat sesi' });
  }
});

// ── PATCH /api/sessions/:uuid/status — update edit status (admin) ─
router.patch('/:uuid/status', auth, async (req, res) => {
  const { editStatus, editNote } = req.body;
  const VALID_STATUSES = ['received', 'editing', 'done'];

  if (!editStatus || !VALID_STATUSES.includes(editStatus)) {
    return res.status(400).json({ error: `editStatus harus salah satu dari: ${VALID_STATUSES.join(', ')}` });
  }

  try {
    const sessionRes = await db.query(
      'SELECT id FROM sessions WHERE uuid = $1 AND admin_id = $2',
      [req.params.uuid, req.admin.adminId]
    );
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    await db.query(
      'UPDATE sessions SET edit_status = $1, edit_note = $2 WHERE id = $3',
      [editStatus, editNote || null, session.id]
    );
    res.json({ message: 'Status berhasil diperbarui', editStatus, editNote: editNote || null });
  } catch (err) {
    console.error('[sessions] PATCH status error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── PATCH /api/sessions/:uuid/expire ─────────────────────────
router.patch('/:uuid/expire', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id FROM sessions WHERE uuid = $1 AND admin_id = $2',
      [req.params.uuid, req.admin.adminId]
    );
    const session = rows[0];
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    await db.query("UPDATE sessions SET status = 'expired' WHERE id = $1", [session.id]);
    res.json({ message: 'Sesi telah dinonaktifkan' });
  } catch (err) {
    console.error('[sessions] PATCH expire error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── PATCH /api/sessions/:uuid/reopen ─────────────────────────
router.patch('/:uuid/reopen', auth, async (req, res) => {
  let client;
  try {
    const sessionRes = await db.query(
      'SELECT id FROM sessions WHERE uuid = $1 AND admin_id = $2',
      [req.params.uuid, req.admin.adminId]
    );
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    client = await db.getClient();
    await client.query('BEGIN');
    await client.query(
      "UPDATE sessions SET status = 'active', edit_status = 'received', completed_at = NULL, edit_note = NULL WHERE id = $1",
      [session.id]
    );
    await client.query('DELETE FROM selections WHERE session_id = $1', [session.id]);
    await client.query('COMMIT');

    res.json({ message: 'Sesi dibuka kembali dan seleksi direset' });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[sessions] PATCH reopen error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

// ── DELETE /api/sessions/:uuid ────────────────────────────────
router.delete('/:uuid', auth, async (req, res) => {
  let client;
  try {
    const sessionRes = await db.query(
      'SELECT id FROM sessions WHERE uuid = $1 AND admin_id = $2',
      [req.params.uuid, req.admin.adminId]
    );
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    client = await db.getClient();
    await client.query('BEGIN');
    await client.query('DELETE FROM selections WHERE session_id = $1', [session.id]);
    await client.query('DELETE FROM sessions WHERE id = $1', [session.id]);
    await client.query('COMMIT');

    res.json({ message: 'Sesi berhasil dihapus' });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[sessions] DELETE error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
