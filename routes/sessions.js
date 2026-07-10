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

// ── GET /api/sessions — list all sessions (admin) ─────────────
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        s.id, s.uuid, s.client_name, s.folder_url, s.folder_id,
        s.photo_limit, s.status, s.created_at, s.completed_at,
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
    const totalRes = await db.query('SELECT COUNT(*) AS n FROM sessions WHERE admin_id = $1', [req.admin.adminId]);
    const activeRes = await db.query("SELECT COUNT(*) AS n FROM sessions WHERE admin_id = $1 AND status = 'active'", [req.admin.adminId]);
    const completedRes = await db.query("SELECT COUNT(*) AS n FROM sessions WHERE admin_id = $1 AND status = 'completed'", [req.admin.adminId]);
    const totalPicsRes = await db.query(`
      SELECT COUNT(*) AS n FROM selections sel
      JOIN sessions s ON sel.session_id = s.id
      WHERE s.admin_id = $1
    `, [req.admin.adminId]);

    res.json({
      total: parseInt(totalRes.rows[0].n, 10),
      active: parseInt(activeRes.rows[0].n, 10),
      completed: parseInt(completedRes.rows[0].n, 10),
      totalPics: parseInt(totalPicsRes.rows[0].n, 10)
    });
  } catch (err) {
    console.error('[sessions] stats error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/sessions/:uuid — get one session (public for client) ─
router.get('/:uuid', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, uuid, client_name, folder_id, photo_limit, status, created_at, completed_at
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

    const selectionsRes = await db.query(
      'SELECT file_id, file_name, selected_at FROM selections WHERE session_id = $1 ORDER BY selected_at',
      [session.id]
    );

    res.json(selectionsRes.rows);
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

  try {
    await db.query(`
      INSERT INTO sessions (uuid, client_name, folder_url, folder_id, photo_limit, admin_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [uuid, clientName.trim(), folderUrl.trim(), folderId, limit, req.admin.adminId]);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      uuid,
      galleryUrl: `${baseUrl}/gallery.html?session=${uuid}`,
      message: 'Sesi berhasil dibuat'
    });
  } catch (err) {
    console.error('[sessions] POST error:', err);
    res.status(500).json({ error: 'Gagal membuat sesi' });
  }
});

// ── PATCH /api/sessions/:uuid/expire — manually expire session ─
router.patch('/:uuid/expire', auth, async (req, res) => {
  try {
    const sessionRes = await db.query(
      'SELECT id FROM sessions WHERE uuid = $1 AND admin_id = $2',
      [req.params.uuid, req.admin.adminId]
    );
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    await db.query("UPDATE sessions SET status = 'expired' WHERE id = $1", [session.id]);
    res.json({ message: 'Sesi telah dinonaktifkan' });
  } catch (err) {
    console.error('[sessions] PATCH expire error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── PATCH /api/sessions/:uuid/reopen — reopen a completed session ─
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
      "UPDATE sessions SET status = 'active', completed_at = NULL WHERE id = $1",
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

// ── DELETE /api/sessions/:uuid — delete session (admin) ───────
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
