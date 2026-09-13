'use strict';

/**
 * utils/googleAuth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Helper terpusat untuk Google OAuth2.
 *
 * Mengapa helper ini penting?
 * - Memastikan redirect_uri SELALU konsisten di seluruh aplikasi
 * - Menghindari redirect_uri_mismatch (400 error) saat deploy di Vercel
 * - Menangani token refresh secara proaktif (tidak tunggu sampai 401)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { google } = require('googleapis');

/**
 * Kembalikan redirect URI yang valid.
 * Prioritas: GOOGLE_REDIRECT_URI env var → fallback ke localhost.
 *
 * PENTING: Path harus sesuai dengan route di server.js:
 *   app.use('/api/google', require('./routes/google'))
 * Sehingga callback real-nya: /api/google/callback
 */
function getRedirectUri() {
  return (
    process.env.GOOGLE_REDIRECT_URI ||
    `http://localhost:${process.env.PORT || 3000}/api/google/callback`
  );
}

/**
 * Buat instance OAuth2Client baru (stateless, tanpa credentials).
 * Gunakan ini untuk: generate auth URL, exchange code → token.
 */
function getOAuth2Client() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID atau GOOGLE_CLIENT_SECRET belum di-set. ' +
      'Pastikan environment variables sudah dikonfigurasi di Vercel Dashboard.'
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
}

/**
 * Buat OAuth2Client yang sudah terisi credentials dan siap pakai.
 * Secara proaktif me-refresh access_token jika sudah/hampir kadaluarsa.
 *
 * @param {object} tokenData - Row dari tabel google_oauth_tokens
 * @param {object} db        - Database instance (untuk update token baru)
 * @param {number} adminId   - ID admin (untuk update token baru)
 * @returns {google.auth.OAuth2}
 */
async function getAuthenticatedClient(tokenData, db, adminId) {
  const oauth2Client = getOAuth2Client();

  oauth2Client.setCredentials({
    access_token:  tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expiry_date:   new Date(tokenData.expires_at).getTime(),
  });

  // ── Proactive token refresh ───────────────────────────────────────────────
  // Jika token sudah expired atau akan expire dalam 5 menit,
  // refresh sekarang agar tidak gagal di tengah proses Calendar API.
  const expiryDate    = new Date(tokenData.expires_at).getTime();
  const fiveMinutesMs = 5 * 60 * 1000;
  const isExpiredOrSoon = !expiryDate || Date.now() >= expiryDate - fiveMinutesMs;

  if (isExpiredOrSoon && tokenData.refresh_token) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);

      // Simpan token baru ke database
      if (credentials.refresh_token) {
        await db.query(
          `UPDATE google_oauth_tokens
             SET access_token  = $1,
                 refresh_token = $2,
                 expires_at    = $3
           WHERE admin_id = $4`,
          [
            credentials.access_token,
            credentials.refresh_token,
            new Date(credentials.expiry_date),
            adminId,
          ]
        );
      } else {
        await db.query(
          `UPDATE google_oauth_tokens
             SET access_token = $1,
                 expires_at   = $2
           WHERE admin_id = $3`,
          [credentials.access_token, new Date(credentials.expiry_date), adminId]
        );
      }
    } catch (refreshErr) {
      // Jika refresh gagal (invalid_grant / token dicabut),
      // hapus token agar user diminta reconnect
      const isInvalidGrant =
        (refreshErr.message && refreshErr.message.includes('invalid_grant')) ||
        (refreshErr.response && refreshErr.response.data && refreshErr.response.data.error === 'invalid_grant');

      if (isInvalidGrant) {
        await db
          .query('DELETE FROM google_oauth_tokens WHERE admin_id = $1', [adminId])
          .catch(() => {});
      }

      throw refreshErr;
    }
  }

  // ── Auto-save saat library refresh secara internal ───────────────────────
  oauth2Client.on('tokens', async (tokens) => {
    try {
      if (tokens.refresh_token) {
        await db.query(
          `UPDATE google_oauth_tokens
             SET access_token  = $1,
                 refresh_token = $2,
                 expires_at    = $3
           WHERE admin_id = $4`,
          [tokens.access_token, tokens.refresh_token, new Date(tokens.expiry_date), adminId]
        );
      } else {
        await db.query(
          `UPDATE google_oauth_tokens
             SET access_token = $1,
                 expires_at   = $2
           WHERE admin_id = $3`,
          [tokens.access_token, new Date(tokens.expiry_date), adminId]
        );
      }
    } catch (dbErr) {
      console.error('[googleAuth] Gagal menyimpan token baru ke DB:', dbErr.message);
    }
  });

  return oauth2Client;
}

module.exports = { getOAuth2Client, getAuthenticatedClient, getRedirectUri };
