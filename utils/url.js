'use strict';

/**
 * Single source of truth untuk base URL publik aplikasi
 * Menggunakan env var PUBLIC_BASE_URL (tanpa trailing slash).
 * Jangan bergantung pada host request / req.headers.host / VERCEL_URL
 * karena di Vercel bisa mengembalikan domain deployment (*.vercel.app).
 */
function getPublicBaseUrl() {
  const base = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || 'http://localhost:3000';
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

module.exports = {
  getPublicBaseUrl,
  buildPublicUrl,
};
