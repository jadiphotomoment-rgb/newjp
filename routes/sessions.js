'use strict';

const express = require('express');
const router  = express.Router();
const https   = require('https');
const { v4: uuidv4 } = require('uuid');
const db   = require('../database');
const auth = require('../middleware/auth');
const { getWaTemplate } = require('../utils/template');

// ── Helper: WhatsApp sender via Fonnte ─────────────────────────
function sendWhatsApp(target, message) {
  return new Promise((resolve) => {
    const token = process.env.FONNTE_TOKEN;
    if (!token || !target) return resolve({ status: false, message: 'Token or target missing' });

    const body = JSON.stringify({ target, message, countryCode: '62' });
    const options = {
      hostname: 'api.fonnte.com',
      path:     '/send',
      method:   'POST',
      headers:  {
        'Authorization':  token,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { resolve({ status: res.statusCode >= 200 && res.statusCode < 300 }); }
      });
    });

    req.setTimeout(10000, () => { req.destroy(); resolve({ status: false, message: 'Timeout' }); });
    req.on('error', () => resolve({ status: false }));
    req.write(body);
    req.end();
  });
}

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
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 30);
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${base}-${suffix}`;
}

// ── GET /api/sessions — list all sessions (admin) ─────────────
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        s.id, s.uuid, s.short_slug, s.client_name, s.client_phone, s.folder_url, s.result_drive_url, s.folder_id,
        s.photo_limit, s.status, s.edit_status, s.edit_note,
        s.created_at, s.completed_at,
        b.id AS booking_id,
        COALESCE(s.client_phone, b.client_phone) AS active_phone,
        (SELECT COUNT(*) FROM selections WHERE session_id = s.id) AS photo_count
      FROM sessions s
      LEFT JOIN bookings b ON b.session_id = s.id
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

    // Query for Lead Sources (Sumber Info Kontak dari JSONB form_data)
    const sourcesRes = await db.query(`
      SELECT COALESCE(form_data->>'source', 'Lainnya/Tidak Diketahui') AS source, COUNT(*) AS count
      FROM bookings
      GROUP BY source
      ORDER BY count DESC
    `);

    res.json({
      total:     parseInt(totalRes.rows[0].n, 10),
      active:    parseInt(activeRes.rows[0].n, 10),
      completed: parseInt(completedRes.rows[0].n, 10),
      totalPics: parseInt(totalPicsRes.rows[0].n, 10),
      leadSources: sourcesRes.rows.map(r => ({
        source: r.source,
        count: parseInt(r.count, 10)
      }))
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
      SELECT id, uuid, short_slug, client_name, folder_id, folder_url, photo_limit, status,
             edit_status, edit_note, result_drive_url, created_at, completed_at
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

// ── GET /api/sessions/:uuid — get one session (public for client / admin) ─
router.get('/:uuid', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT s.id, s.uuid, s.short_slug, s.client_name, s.client_phone, s.folder_url, s.result_drive_url,
             s.folder_id, s.photo_limit, s.status, s.edit_status, s.edit_note, s.created_at, s.completed_at,
             b.id AS booking_id,
             COALESCE(s.client_phone, b.client_phone) AS active_phone
      FROM sessions s
      LEFT JOIN bookings b ON b.session_id = s.id
      WHERE s.uuid = $1
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
  const { clientName, clientPhone, folderUrl, photoLimit, resultDriveUrl } = req.body;

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

  let shortSlug;
  let attempt = 0;
  while (attempt < 5) {
    const candidate = generateSlug(clientName);
    const exists = await db.query('SELECT 1 FROM sessions WHERE short_slug = $1', [candidate]);
    if (exists.rows.length === 0) { shortSlug = candidate; break; }
    attempt++;
  }
  if (!shortSlug) shortSlug = uuid.substring(0, 8);

  try {
    await db.query(`
      INSERT INTO sessions (uuid, short_slug, client_name, client_phone, folder_url, result_drive_url, folder_id, photo_limit, admin_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      uuid,
      shortSlug,
      clientName.trim(),
      clientPhone ? clientPhone.trim() : null,
      folderUrl.trim(),
      resultDriveUrl ? resultDriveUrl.trim() : null,
      folderId,
      limit,
      req.admin.adminId
    ]);

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

// ── PATCH /api/sessions/:uuid/status — update edit status & kirim notif WA (admin) ─
router.patch('/:uuid/status', auth, async (req, res) => {
  const { editStatus, editNote, clientPhone, resultDriveUrl, sendWa } = req.body;
  const VALID_STATUSES = ['received', 'editing', 'done'];

  if (!editStatus || !VALID_STATUSES.includes(editStatus)) {
    return res.status(400).json({ error: `editStatus harus salah satu dari: ${VALID_STATUSES.join(', ')}` });
  }

  try {
    const sessionRes = await db.query(`
      SELECT s.*, b.client_phone AS booking_phone
      FROM sessions s
      LEFT JOIN bookings b ON b.session_id = s.id
      WHERE s.uuid = $1 AND s.admin_id = $2
    `, [req.params.uuid, req.admin.adminId]);

    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    const phoneToSave = clientPhone !== undefined ? (clientPhone ? clientPhone.trim() : null) : session.client_phone;
    const driveUrlToSave = resultDriveUrl !== undefined ? (resultDriveUrl ? resultDriveUrl.trim() : null) : session.result_drive_url;

    await db.query(`
      UPDATE sessions
      SET edit_status = $1,
          edit_note = $2,
          client_phone = COALESCE($3, client_phone),
          result_drive_url = $4
      WHERE id = $5
    `, [editStatus, editNote || null, phoneToSave, driveUrlToSave, session.id]);

    let waSent = false;
    let waMessage = null;

    // Kirim notifikasi WhatsApp jika status selesai (done) dan sendWa disetujui (default true jika nomor ada)
    const targetPhone = clientPhone || session.client_phone || session.booking_phone;
    const finalDriveUrl = driveUrlToSave || session.folder_url;

    if (editStatus === 'done' && sendWa !== false && targetPhone) {
      const noteSection = editNote && editNote.trim() ? `\n\n📝 *Catatan Fotografer:*\n${editNote.trim()}` : '';
      // Coba ambil template dari DB, fallback ke hardcode jika tidak ada
      let msg = await getWaTemplate('foto_selesai_edit', {
        client_name: session.client_name,
        drive_url: finalDriveUrl,
        note_section: noteSection,
      });
      if (!msg) {
        msg = [
          `📸 *Hasil Foto Selesai Diedit — Jadiphoto.Moment*`,
          ``,
          `Halo *${session.client_name}*,`,
          `Kabar gembira! Foto-foto pilihan Anda telah selesai diedit dan siap untuk diunduh. 🎉`,
          ``,
          `📁 *Link Google Drive:*`,
          `${finalDriveUrl}`,
          noteSection,
          ``,
          `Terima kasih telah mempercayai layanan fotografi Jadiphoto.Moment! Silakan beri tahu kami jika ada pertanyaan atau kendala unduhan. 📸✨`
        ].filter(l => l !== undefined).join('\n');
      }

      const waRes = await sendWhatsApp(targetPhone, msg);
      waSent = waRes.status === true || waRes.status === 'true';
      waMessage = waSent ? 'Notifikasi WhatsApp berhasil dikirim ke klien' : 'Status tersimpan, tetapi notifikasi WhatsApp gagal terkirim';
    }

    res.json({
      message: 'Status berhasil diperbarui',
      editStatus,
      editNote: editNote || null,
      resultDriveUrl: driveUrlToSave,
      waSent,
      waMessage
    });
  } catch (err) {
    console.error('[sessions] PATCH status error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── POST /api/sessions/:uuid/notify-done — kirim manual notif WA hasil edit (admin) ─
router.post('/:uuid/notify-done', auth, async (req, res) => {
  const { clientPhone, resultDriveUrl, editNote } = req.body;

  try {
    const sessionRes = await db.query(`
      SELECT s.*, b.client_phone AS booking_phone
      FROM sessions s
      LEFT JOIN bookings b ON b.session_id = s.id
      WHERE s.uuid = $1 AND s.admin_id = $2
    `, [req.params.uuid, req.admin.adminId]);

    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    const targetPhone = clientPhone || session.client_phone || session.booking_phone;
    if (!targetPhone) {
      return res.status(400).json({ error: 'Nomor WhatsApp klien belum diisi' });
    }

    const finalDriveUrl = resultDriveUrl || session.result_drive_url || session.folder_url;
    const finalNote = editNote !== undefined ? editNote : session.edit_note;

    // Update data terbaru ke database
    await db.query(`
      UPDATE sessions
      SET edit_status = 'done',
          client_phone = COALESCE($1, client_phone),
          result_drive_url = $2,
          edit_note = $3
      WHERE id = $4
    `, [targetPhone, finalDriveUrl, finalNote || null, session.id]);

    const noteSection = finalNote && finalNote.trim() ? `\n\n📝 *Catatan Fotografer:*\n${finalNote.trim()}` : '';
    // Coba ambil template dari DB, fallback ke hardcode jika tidak ada
    let msg = await getWaTemplate('foto_selesai_edit', {
      client_name: session.client_name,
      drive_url: finalDriveUrl,
      note_section: noteSection,
    });
    if (!msg) {
      msg = [
        `📸 *Hasil Foto Selesai Diedit — Jadiphoto.Moment*`,
        ``,
        `Halo *${session.client_name}*,`,
        `Kabar gembira! Foto-foto pilihan Anda telah selesai diedit dan siap untuk diunduh. 🎉`,
        ``,
        `📁 *Link Google Drive:*`,
        `${finalDriveUrl}`,
        noteSection,
        ``,
        `Terima kasih telah mempercayai layanan fotografi Jadiphoto.Moment! Silakan beri tahu kami jika ada pertanyaan atau kendala unduhan. 📸✨`
      ].filter(l => l !== undefined).join('\n');
    }

    const waRes = await sendWhatsApp(targetPhone, msg);
    const waOk = waRes.status === true || waRes.status === 'true';

    if (waOk) {
      res.json({ success: true, message: 'Notifikasi WhatsApp hasil edit berhasil dikirim ke klien!' });
    } else {
      res.status(500).json({ error: 'Gagal mengirim WhatsApp. Periksa konfigurasi Fonnte Anda.' });
    }
  } catch (err) {
    console.error('[sessions] notify-done error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── PATCH /api/sessions/:uuid/expire ─────────────────────────
router.patch('/:uuid/expire', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.client_name, COALESCE(s.client_phone, b.client_phone) AS active_phone 
       FROM sessions s
       LEFT JOIN bookings b ON b.session_id = s.id
       WHERE s.uuid = $1 AND s.admin_id = $2`,
      [req.params.uuid, req.admin.adminId]
    );
    const session = rows[0];
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    await db.query("UPDATE sessions SET status = 'expired' WHERE id = $1", [session.id]);
    
    // Notifikasi WhatsApp
    if (session.active_phone) {
      let msg = await getWaTemplate('session_expired', {
        client_name: session.client_name
      });
      if (!msg) {
        msg = `⚠️ *Pemberitahuan: Sesi Sortir Foto Kadaluarsa*\n\nHalo *${session.client_name}*,\n\nMohon maaf, batas waktu untuk pemilihan foto Anda telah habis dan sesi sortir saat ini telah dinonaktifkan.\n\nJika Anda masih ingin melanjutkan proses pemilihan foto, silakan hubungi admin Jadiphoto.Moment untuk membuka kembali akses galeri Anda.\n\nTerima kasih. 🙏`;
      }
      sendWhatsApp(session.active_phone, msg).catch(() => {});
    }

    res.json({ message: 'Sesi telah dinonaktifkan dan notifikasi dikirim' });
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

// ── GET /api/sessions/:uuid/drive — direct redirect to Drive URL (public) ─
router.get('/:uuid/drive', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT folder_url, result_drive_url FROM sessions WHERE uuid = $1',
      [req.params.uuid]
    );
    const session = rows[0];
    if (!session) return res.status(404).send('<h1>Sesi tidak ditemukan</h1>');
    const targetUrl = session.result_drive_url || session.folder_url;
    if (targetUrl) return res.redirect(targetUrl);
    return res.redirect(`/gallery?session=${req.params.uuid}`);
  } catch (err) {
    console.error('[sessions] direct drive error:', err);
    res.status(500).send('<h1>Server error</h1>');
  }
});

// ── PATCH /api/sessions/:uuid — update session details (admin) ─────
router.patch('/:uuid', auth, async (req, res) => {
  const { clientName, clientPhone, folderUrl, photoLimit, resultDriveUrl } = req.body;

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

  try {
    const sessionRes = await db.query(
      'SELECT id, result_drive_url FROM sessions WHERE uuid = $1 AND admin_id = $2',
      [req.params.uuid, req.admin.adminId]
    );
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    const driveUrlToSave = resultDriveUrl !== undefined 
      ? (resultDriveUrl ? resultDriveUrl.trim() : null) 
      : session.result_drive_url;

    await db.query(
      'UPDATE sessions SET client_name = $1, client_phone = $2, folder_url = $3, folder_id = $4, photo_limit = $5, result_drive_url = $6 WHERE id = $7',
      [clientName.trim(), clientPhone ? clientPhone.trim() : null, folderUrl.trim(), folderId, limit, driveUrlToSave, session.id]
    );
    res.json({ message: 'Sesi berhasil diperbarui', resultDriveUrl: driveUrlToSave });
  } catch (err) {
    console.error('[sessions] PATCH update error:', err);
    res.status(500).json({ error: 'Database error' });
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
