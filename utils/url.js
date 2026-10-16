'use strict';

/**
 * Single source of truth untuk base URL publik aplikasi
 * Menggunakan env var PUBLIC_BASE_URL (tanpa trailing slash).
 * Jangan bergantung pada host request / req.headers.host / VERCEL_URL
 * karena di Vercel bisa mengembalikan domain deployment (*.vercel.app).
 */
function getPublicBaseUrl(req = null) {
  let base = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || process.env.BASE_URL;

  // Coba deteksi domain dari request header host (misal https://www.jadiphoto.web.id)
  if (!base && req && req.headers && req.headers.host) {
    const host = req.headers.host;
    if (!host.includes('localhost') && !host.includes('127.0.0.1')) {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      base = `${proto}://${host}`;
    }
  }

  // Coba ambil dari environment otomatis Vercel jika env var kustom belum diisi
  if (!base && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    base = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  } else if (!base && process.env.VERCEL_URL) {
    base = `https://${process.env.VERCEL_URL}`;
  }

  if (!base) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'APP_BASE_URL belum dikonfigurasi di environment production. ' +
        'Silakan set APP_BASE_URL di Vercel Dashboard (contoh: https://jadiphoto.web.id).'
      );
    }
    return 'http://localhost:3000';
  }
  return base.replace(/\/+$/, '');
}

/**
 * Bangun URL absolut publik berdasarkan path yang diberikan
 * @param {string} path - path relatif, misal '/pelunasan?token=...' atau '/s/abc'
 * @param {object} [req] - Express request object opsional
 * @returns {string} - URL absolut publik
 */
function buildPublicUrl(path = '', req = null) {
  const base = getPublicBaseUrl(req);
  const normalizedPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `${base}${normalizedPath}`;
}

/**
 * Helper tunggal untuk membangun link pelunasan klien
 * @param {string} token
 * @param {object} [req] - Express request object opsional
 * @returns {string} - URL absolut pelunasan
 */
function buildPelunasanUrl(token, req = null) {
  if (!token) {
    throw new Error('Token pelunasan wajib diisi untuk membangun URL pelunasan');
  }
  return buildPublicUrl(`/pelunasan?token=${encodeURIComponent(token)}`, req);
}

module.exports = {
  getPublicBaseUrl,
  buildPublicUrl,
  buildPelunasanUrl,
};
