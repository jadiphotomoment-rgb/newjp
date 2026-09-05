'use strict';

const express = require('express');
const router  = express.Router();
const { google } = require('googleapis');
const db      = require('../database');
const auth    = require('../middleware/auth');

// Setup OAuth2 Client
function getOauth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/google/callback'
  );
}

// GET /api/google/auth — Generate Auth URL
router.get('/auth', auth, (req, res) => {
  try {
    const oauth2Client = getOauth2Client();
    const scopes = [
      'https://www.googleapis.com/auth/calendar.events'
    ];

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // Force to get refresh_token
      scope: scopes,
      state: req.admin.adminId.toString() // Pass admin ID in state to link account in callback
    });

    res.json({ url });
  } catch (err) {
    console.error('[google] auth error:', err);
    res.status(500).json({ error: 'Gagal membuat url autentikasi google' });
  }
});

// GET /api/google/callback — OAuth Callback
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  
  if (error) {
    console.error('[google] callback error:', error);
    return res.redirect('/admin/bookings.html?error=google_auth_failed');
  }

  if (!code || !state) {
    return res.status(400).send('Kode atau state (adminId) tidak valid');
  }

  try {
    const oauth2Client = getOauth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    
    // Save to database
    const adminId = parseInt(state, 10);
    const expiresAt = new Date(tokens.expiry_date || Date.now() + 3600000); // Default +1hr

    // Upsert token
    await db.query(
      `INSERT INTO google_oauth_tokens (admin_id, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (admin_id)
       DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, google_oauth_tokens.refresh_token),
         expires_at = EXCLUDED.expires_at`,
      [adminId, tokens.access_token, tokens.refresh_token || '', expiresAt]
    );

    res.redirect('/admin/bookings.html?success=google_connected');
  } catch (err) {
    console.error('[google] token exchange error:', err);
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
