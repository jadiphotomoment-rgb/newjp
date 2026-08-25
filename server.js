'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');

// Initialize database (creates tables + default admin if needed)
const db = require('./database');
db.init();

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ───────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/sessions',   require('./routes/sessions'));
app.use('/api/drive',      require('./routes/drive'));
app.use('/api/notify',     require('./routes/notify'));
app.use('/api/upload',     require('./routes/upload'));

// ── Scale-Up Routes ───────────────────────────────────────────
app.use('/api/bookings',             require('./routes/bookings'));
app.use('/api/booking-categories',   require('./routes/bookings'));  // alias publik
app.use('/api/admin/categories',     require('./routes/categories'));
app.use('/api/finance',              require('./routes/finance'));

// ── Page Routes ──────────────────────────────────────────────
// Root → redirect to admin login
app.get('/', (req, res) => {
  res.redirect('/admin/login.html');
});

// Booking public pages
app.get('/booking', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'booking.html'));
});
app.get('/upload-dp', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'upload-dp.html'));
});

// Ignore favicon to prevent 404 logs
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── Short Link redirect: /s/:slug → gallery.html?session=UUID ─
app.get('/s/:slug', async (req, res) => {
  try {
    const db = require('./database');
    const { rows } = await db.query(
      'SELECT uuid FROM sessions WHERE short_slug = $1',
      [req.params.slug]
    );
    if (!rows[0]) return res.status(404).send('<h1>Link tidak ditemukan</h1>');
    res.redirect(`/gallery.html?session=${rows[0].uuid}`);
  } catch (err) {
    console.error('[shortlink] error:', err);
    res.status(500).send('<h1>Server Error</h1>');
  }
});

// ── 404 Handler ──────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint tidak ditemukan' });
  }
  res.status(404).send('<h1>404 - Halaman tidak ditemukan</h1>');
});

// ── Global Error Handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Terjadi kesalahan server' });
});

// ── Start Server (Only if not running on Vercel) ───────────────
if (require.main === module) {
  db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Server berjalan di http://localhost:${PORT}`);
      // Initialize cron jobs
      const { initBookingCleaner } = require('./cron/booking_cleaner');
      initBookingCleaner();
    });
  })
  .catch(err => {
    console.error('❌ Gagal inisialisasi database:', err);
    process.exit(1);
  });
}

// ── Export for Vercel ──────────────────────────────────────────
module.exports = app;
