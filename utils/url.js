'use strict';

/**
 * Single source of truth untuk base URL publik aplikasi
 * Menggunakan env var PUBLIC_BASE_URL (tanpa trailing slash).
 * Jangan bergantung pada host request / req.headers.host / VERCEL_URL
 * karena di Vercel bisa mengembalikan domain deployment (*.vercel.app).
 */
function getPublicBaseUrl() {
  const base = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || process.env.BASE_URL;
  if (!base) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'APP_BASE_URL belum dikonfigurasi di environment production. ' +
        'Wajib set APP_BASE_URL di environment variables (contoh: https://jadiphoto.web.id) untuk mencegah pengiriman link invalid ke klien.'
      );
    }
    return 'http://localhost:3000';
  }
  return base.replace(/\/+$/, '');
}

/**
 * Bangun URL absolut publik berdasarkan path yang diberikan
 * @param {string} path - path relatif, misal '/pelunasan?token=...' atau '/s/abc'
 * @returns {string} - URL absolut publik
 */
function buildPublicUrl(path = '') {
  const base = getPublicBaseUrl();
  const normalizedPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `${base}${normalizedPath}`;
}

/**
 * Helper tunggal untuk membangun link pelunasan klien
 * @param {string} token
 * @returns {string} - URL absolut pelunasan
 */
function buildPelunasanUrl(token) {
  if (!token) {
    throw new Error('Token pelunasan wajib diisi untuk membangun URL pelunasan');
  }
  return buildPublicUrl(`/pelunasan?token=${encodeURIComponent(token)}`);
}

module.exports = {
  getPublicBaseUrl,
  buildPublicUrl,
  buildPelunasanUrl,
};
