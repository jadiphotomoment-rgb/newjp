'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');

// Initialize database (creates tables + default admin if needed)
const db = require('./database');
db.init();

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(require('./middleware/requestId'));

// Redirect .html requests to clean URLs
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    const cleanPath = req.path.slice(0, -5);
    const query = req.url.slice(req.path.length);
    return res.redirect(301, cleanPath + query);
  }
  next();
});

// Serve static files from public/ with extensions hidden
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html', 'htm'] }));

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
app.use('/api/google',               require('./routes/google'));
app.use('/api/shortlinks',           require('./routes/shortlinks'));
app.use('/api/wa-templates',         require('./routes/wa-templates'));
app.use('/api/settings/payment',     require('./routes/payment-settings'));
app.use('/api/pelunasan',            require('./routes/pelunasan'));
app.use('/api/dashboard',            require('./routes/dashboard'));
app.use('/api/approvals',            require('./routes/approvals'));
app.use('/api/users',                require('./routes/users'));
app.use('/api/audit',                require('./routes/audit-log'));
app.use('/api/monitoring',           require('./routes/monitoring'));

// ── Periodik: expire approval requests yang melewati batas waktu (tiap jam) ──
setInterval(async () => {
  try {
    const { expireAll } = require('./services/approval');
    await expireAll();
  } catch (e) {
    console.warn('[approval cron] expireAll error:', e.message);
  }
}, 60 * 60 * 1000); // tiap 1 jam


// ── Page Routes ──────────────────────────────────────────────
// Root → redirect to admin login
app.get('/', (req, res) => {
  res.redirect('/admin/login');
});

// Booking public pages — wildcard slug agar /booking/wedding-solo dll bisa diakses
app.get('/booking/:slug?', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'booking.html'));
});
app.get('/upload-dp', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'upload-dp.html'));
});

// Halaman publik pelunasan via token — /pelunasan?token=...
app.get('/pelunasan', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pelunasan.html'));
});

// Ignore favicon to prevent 404 logs
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── Short Link redirect: /s/:slug → gallery?session=UUID ─
app.get('/s/:slug', async (req, res) => {
  try {
    const db = require('./database');
    const { rows } = await db.query(
      'SELECT uuid FROM sessions WHERE short_slug = $1',
      [req.params.slug]
    );
    if (!rows[0]) return res.status(404).send('<h1>Link tidak ditemukan</h1>');
    res.redirect(`/gallery?session=${rows[0].uuid}`);
  } catch (err) {
    console.error('[shortlink] error:', err);
    res.status(500).send('<h1>Server Error</h1>');
  }
});

// ── Short Link Drive redirect: /s/:slug/drive → Direct to Google Drive ─
app.get('/s/:slug/drive', async (req, res) => {
  try {
    const db = require('./database');
    const { rows } = await db.query(
      'SELECT uuid, folder_url, result_drive_url FROM sessions WHERE short_slug = $1',
      [req.params.slug]
    );
    if (!rows[0]) return res.status(404).send('<h1>Link tidak ditemukan</h1>');
    const targetUrl = rows[0].result_drive_url || rows[0].folder_url;
    if (targetUrl) {
      return res.redirect(targetUrl);
    }
    res.redirect(`/gallery?session=${rows[0].uuid}`);
  } catch (err) {
    console.error('[shortlink drive] error:', err);
    res.status(500).send('<h1>Server Error</h1>');
  }
});

// ── General Short Link redirect: /l/:code ────────────────────
app.get('/l/:code', async (req, res) => {
  try {
    const db = require('./database');
    const { rows } = await db.query(
      'SELECT id, original_url FROM shortlinks WHERE short_code = $1',
      [req.params.code]
    );
    if (!rows[0]) return res.status(404).send('<h1>Link tidak ditemukan</h1>');
    
    // Redirect immediately
    res.redirect(rows[0].original_url);

    // Track click asynchronously
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';
    const referrer = req.headers.referer || req.headers.referrer || '';
    
    db.query(
      'INSERT INTO shortlink_clicks (shortlink_id, ip_address, user_agent, referrer) VALUES ($1, $2, $3, $4)',
      [rows[0].id, ip, userAgent, referrer]
    ).catch(err => console.error('[shortlink tracking error]:', err));

  } catch (err) {
    console.error('[shortlink /l/:code] error:', err);
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
