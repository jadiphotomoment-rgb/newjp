'use strict';

const express  = require('express');
const router   = express.Router();
const db       = require('../database');
const auth     = require('../middleware/auth');
const { getOAuth2Client } = require('../utils/googleAuth');

// ─────────────────────────────────────────────────────────────────────────────
// CATATAN PENTING: redirect_uri HARUS sama persis dengan:
//   1. Yang didaftarkan di Google Cloud Console → Authorized redirect URIs
//   2. Environment variable GOOGLE_REDIRECT_URI di Vercel Dashboard
//
// Nilai yang benar: https://jadiphoto.web.id/api/google/callback
//   (bukan /auth/google/callback — itu path yang salah!)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/google/auth — Generate Auth URL
router.get('/auth', auth, (req, res) => {
  try {
    const oauth2Client = getOAuth2Client();

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      // 'consent' wajib agar Google selalu kembalikan refresh_token.
      // Tanpa ini, refresh_token hanya dikirim saat pertama kali authorize.
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/calendar.events',
      ],
      // Kirim adminId di state agar bisa di-link di callback
      state: req.admin.adminId.toString(),
    });

    res.json({ url });
  } catch (err) {
    console.error('[google] auth error:', err.message);
    // Env vars belum di-set → beri pesan yang jelas
    if (err.message && err.message.includes('belum di-set')) {
      return res.status(500).json({ error: err.message });
    }
    res.status(500).json({ error: 'Gagal membuat URL autentikasi Google' });
  }
});

// GET /api/google/callback — OAuth Callback
// URL ini HARUS terdaftar di Google Cloud Console → Authorized redirect URIs
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('[google] callback OAuth error dari Google:', error);
    return res.redirect(`/admin/bookings.html?error=google_auth_failed&reason=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    console.error('[google] callback: code atau state tidak ada');
    return res.redirect('/admin/bookings.html?error=google_auth_failed&reason=missing_code');
  }

  const adminId = parseInt(state, 10);
  if (isNaN(adminId)) {
    console.error('[google] callback: state bukan angka valid:', state);
    return res.redirect('/admin/bookings.html?error=google_auth_failed&reason=invalid_state');
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token) {
      throw new Error('Token tidak valid: access_token tidak ada dalam respons Google');
    }

    const expiresAt = new Date(tokens.expiry_date || Date.now() + 3600 * 1000);

    // Upsert token — jika sudah ada, update. Jangan timpa refresh_token lama
    // jika Google tidak mengirim yang baru (terjadi jika prompt bukan consent).
    await db.query(
      `INSERT INTO google_oauth_tokens (admin_id, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (admin_id)
       DO UPDATE SET
         access_token  = EXCLUDED.access_token,
         refresh_token = CASE
           WHEN EXCLUDED.refresh_token <> '' THEN EXCLUDED.refresh_token
           ELSE google_oauth_tokens.refresh_token
         END,
         expires_at    = EXCLUDED.expires_at`,
      [adminId, tokens.access_token, tokens.refresh_token || '', expiresAt]
    );

    console.log(`[google] callback: token berhasil disimpan untuk adminId=${adminId}`);
    res.redirect('/admin/bookings.html?success=google_connected');
  } catch (err) {
    console.error('[google] token exchange error:', err.message);
    res.redirect('/admin/bookings.html?error=google_token_exchange_failed');
  }
});

// GET /api/google/status — Check if admin is connected
router.get('/status', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id FROM google_oauth_tokens WHERE admin_id = $1',
      [req.admin.adminId]
    );
    res.json({ connected: rows.length > 0 });
  } catch (err) {
    console.error('[google] status error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/google/disconnect — Disconnect account
router.delete('/disconnect', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM google_oauth_tokens WHERE admin_id = $1 RETURNING id',
      [req.admin.adminId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tidak ada akun terhubung' });
    res.json({ message: 'Berhasil memutuskan koneksi Google Calendar' });
  } catch (err) {
    console.error('[google] disconnect error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
