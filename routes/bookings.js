'use strict';

const express  = require('express');
const router   = express.Router();
const db       = require('../database');
const auth     = require('../middleware/auth');
const audit    = require('../services/audit');
const approvalSvc = require('../services/approval');
const { approveBooking, rejectBooking } = require('../services/bookingApproval');
const https    = require('https');

const { getWaTemplate } = require('../utils/template');
const { buildPublicUrl } = require('../utils/url');
const { google }           = require('googleapis');
const { getAuthenticatedClient } = require('../utils/googleAuth');

// ── Helper to safely extract YYYY-MM-DD from node-postgres DATE ──
function getLocalDateString(d) {
  if (!d) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ── WhatsApp sender (reuse logic from notify.js) ─────────────────
function sendWhatsApp(target, message) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ target, message, countryCode: '62' });
    const options = {
      hostname: 'api.fonnte.com', path: '/send', method: 'POST',
      headers: {
        'Authorization': process.env.FONNTE_TOKEN || '',
        'Content-Type':  'application/json',
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
    req.on('error', () => resolve({ status: false }));
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS (client-facing, no auth)
// ═══════════════════════════════════════════════════════════════

// GET /api/booking-categories — daftar kategori aktif
router.get('/categories', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, slug, name, fields, packages, dp_type, dp_value, color
       FROM booking_categories WHERE is_active = true ORDER BY id`
    );
    res.json(rows);
  } catch (err) {
    console.error('[bookings] GET categories error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/booking-categories/:slug — detail kategori
router.get('/categories/:slug', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, slug, name, fields, packages, dp_type, dp_value, color
       FROM booking_categories WHERE slug = $1 AND is_active = true`,
      [req.params.slug]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[bookings] GET category slug error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/booking-categories/:slug/slots — cek ketersediaan jam
router.get('/categories/:slug/slots', async (req, res) => {
  const { slug } = req.params;
  const { date } = req.query; // YYYY-MM-DD
  
  if (!date) return res.status(400).json({ error: 'Parameter date diperlukan' });

  try {
    const { rows: catRows } = await db.query(
      `SELECT id, time_slots FROM booking_categories WHERE slug = $1 AND is_active = true`,
      [slug]
    );
    if (!catRows[0]) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
    const category = catRows[0];
    const timeSlots = category.time_slots || [];

    // Jika tidak ada pengaturan slot waktu, kembalikan array kosong (bebas isi jam)
    if (timeSlots.length === 0) return res.json([]);

    // Hitung jumlah booking yang sudah ada di tanggal tersebut
    const { rows: bookRows } = await db.query(
      `SELECT event_time, COUNT(*) as count 
       FROM bookings 
       WHERE category_id = $1 AND event_date = $2 AND status IN ('confirmed', 'dp_review', 'completed')
       GROUP BY event_time`,
      [category.id, date]
    );

    const bookedMap = {};
    for (const r of bookRows) {
      // event_time dari DB formatnya "08:00:00"
      const t = (r.event_time || '').substring(0, 5); 
      bookedMap[t] = parseInt(r.count, 10);
    }

    const availableSlots = timeSlots.map(slot => {
      const booked = bookedMap[slot.time] || 0;
      const quota = parseInt(slot.quota, 10) || 1;
      return {
        time: slot.time,
        quota: quota,
        booked: booked,
        available: booked < quota
      };
    });

    res.json(availableSlots);
  } catch (err) {
    console.error('[bookings] GET slots error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/bookings/:categorySlug — submit booking baru
router.post('/:categorySlug', async (req, res) => {
  const { categorySlug } = req.params;
  const { clientName, clientPhone, eventDate, eventTime, location, formData, packageId, packagePrice, packageName } = req.body;

  if (!clientName || !clientPhone || !eventDate) {
    return res.status(400).json({ error: 'clientName, clientPhone, dan eventDate wajib diisi' });
  }

  try {
    const catRes = await db.query(
      'SELECT id, dp_type, dp_value, time_slots, packages FROM booking_categories WHERE slug = $1 AND is_active = true',
      [categorySlug]
    );
    if (!catRes.rows[0]) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
    const category = catRes.rows[0];

    // Tentukan paket harga & kalkulasi DP
    let finalPackagePrice = parseFloat(packagePrice) || 0;
    let finalPackageName = packageName || '';

    const pkgs = category.packages || [];
    if (packageId) {
      const matchedPkg = pkgs.find(p => p.id === packageId);
      if (matchedPkg) {
        finalPackagePrice = parseFloat(matchedPkg.price) || 0;
        finalPackageName = matchedPkg.name;
      }
    }

    let dpAmount = 0;
    if (finalPackagePrice > 0) {
      if (category.dp_type === 'percent') {
        dpAmount = (finalPackagePrice * parseFloat(category.dp_value)) / 100;
      } else {
        dpAmount = parseFloat(category.dp_value);
      }
    } else if (category.dp_type === 'fixed') {
      dpAmount = parseFloat(category.dp_value);
    }

    const fullFormData = Object.assign({}, formData || {});
    if (finalPackageName) {
      fullFormData['_package_name'] = finalPackageName;
      fullFormData['_package_price'] = finalPackagePrice;
    }

    // Jika kategori memiliki time_slots yang diatur dan jam diisi
    const timeSlots = category.time_slots || [];
    if (timeSlots.length > 0 && eventTime) {
      const slotConfig = timeSlots.find(s => s.time === eventTime);
      if (!slotConfig) {
        return res.status(400).json({ error: 'Jam yang dipilih tidak tersedia untuk layanan ini.' });
      }
      
      const { rows: bookRows } = await db.query(
        `SELECT COUNT(*) as count FROM bookings 
         WHERE category_id = $1 AND event_date = $2 AND event_time = $3 
           AND status IN ('confirmed', 'dp_review', 'completed')`,
        [category.id, eventDate, eventTime]
      );
      const booked = parseInt(bookRows[0].count, 10);
      const quota = parseInt(slotConfig.quota, 10) || 1;
      
      if (booked >= quota) {
        return res.status(409).json({ error: 'Maaf, jam yang dipilih sudah penuh (mencapai kuota). Silakan pilih jam atau tanggal lain.' });
      }
    } else {
      const conflictRes = await db.query(
        `SELECT id FROM bookings WHERE event_date = $1 AND event_time = $2 AND status = 'confirmed'`,
        [eventDate, eventTime]
      );
      if (conflictRes.rows.length > 0 && eventTime) {
        return res.status(409).json({ error: 'Tanggal dan jam tersebut sudah terbooking. Silakan pilih waktu lain.' });
      }
    }

    // Normalisasi sumber informasi (marketing lead channel)
    const rawSrc = req.body.sumberInformasi || (formData && (formData.sumber_informasi || formData.source)) || '';
    let sumberInfo = String(rawSrc).toLowerCase().trim();
    if (sumberInfo.includes('instagram')) sumberInfo = 'instagram';
    else if (sumberInfo.includes('tiktok')) sumberInfo = 'tiktok';
    else if (sumberInfo.includes('google')) sumberInfo = 'google';
    else if (sumberInfo.includes('rekomendasi') || sumberInfo.includes('referral') || sumberInfo.includes('teman')) sumberInfo = 'referral';
    else if (sumberInfo.includes('event') || sumberInfo.includes('pameran')) sumberInfo = 'event';
    else if (sumberInfo === 'lainnya') sumberInfo = 'lainnya';
    else if (sumberInfo) sumberInfo = 'lainnya';
    else sumberInfo = null;

    const rawDetail = req.body.sumberInformasiDetail || (formData && (formData.sumber_informasi_detail || formData.source_detail)) || null;
    const sumberDetail = rawDetail ? String(rawDetail).trim() : null;

    const resolvedPackageName = finalPackageName || category.name || null;

    const { rows } = await db.query(
      `INSERT INTO bookings (category_id, client_name, client_phone, event_date, event_time, location, form_data, package_price, dp_amount, sumber_informasi, sumber_informasi_detail, package_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        category.id,
        clientName.trim(),
        clientPhone.trim(),
        eventDate,
        eventTime || null,
        location ? location.trim() : null,
        JSON.stringify(fullFormData),
        finalPackagePrice > 0 ? finalPackagePrice : null,
        dpAmount > 0 ? dpAmount : null,
        sumberInfo,
        sumberDetail,
        resolvedPackageName
      ]
    );

    res.status(201).json({
      bookingId: rows[0].id,
      message:   'Booking berhasil dibuat. Silakan upload bukti DP.',
      nextStep:  `/upload-dp.html?booking=${rows[0].id}`
    });
  } catch (err) {
    console.error('[bookings] POST error:', err);
    res.status(500).json({ error: 'Gagal membuat booking' });
  }
});

// GET /api/bookings/:id — detail booking (publik, untuk halaman upload)
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT b.id, b.client_name, b.client_phone, b.event_date, b.event_time,
              b.location, b.form_data, b.package_price, b.dp_amount, b.status,
              b.created_at,
              bc.name AS category_name, bc.slug AS category_slug,
              bc.dp_type, bc.dp_value, bc.color
       FROM bookings b
       JOIN booking_categories bc ON b.category_id = bc.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });

    const booking = rows[0];
    // Hitung dp_amount jika package_price sudah diisi
    if (booking.package_price && !booking.dp_amount) {
      let dp = 0;
      if (booking.dp_type === 'percent') {
        dp = (parseFloat(booking.package_price) * parseFloat(booking.dp_value)) / 100;
      } else {
        dp = parseFloat(booking.dp_value);
      }
      booking.calculated_dp = dp;
    }

    // Ambil payment terkait (jika ada)
    const payRes = await db.query(
      `SELECT id, amount, payment_type, status, proof_url, blob_key, proof_filename, created_at FROM payments
       WHERE booking_id = $1 ORDER BY created_at DESC`,
      [booking.id]
    );
    booking.payments = payRes.rows;

    // Ambil attachments terkait (jika ada)
    const attachRes = await db.query(
      `SELECT id, file_url, blob_key, file_name, file_type, mime_type, file_size, created_at
       FROM attachments
       WHERE booking_id = $1 ORDER BY created_at DESC`,
      [booking.id]
    );
    booking.attachments = attachRes.rows;

    res.json(booking);
  } catch (err) {
    console.error('[bookings] GET detail error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/bookings/:id/upload-dp — konfirmasi metadata setelah client upload ke Vercel Blob
// Body JSON: { blobUrl, blobKey, fileName, mimeType, fileSize }
router.post('/:id/upload-dp', async (req, res) => {
  const bookingId = parseInt(req.params.id, 10);
  if (isNaN(bookingId)) return res.status(400).json({ error: 'ID booking tidak valid' });

  const { blobUrl, blobKey, fileName, mimeType, fileSize } = req.body;

  // Validasi input
  if (!blobUrl || !fileName) {
    return res.status(400).json({ error: 'blobUrl dan fileName wajib diisi' });
  }

  // Validasi URL berasal dari Vercel Blob
  if (!blobUrl.includes('blob.vercel-storage.com')) {
    return res.status(400).json({ error: 'URL file tidak valid. Harus berasal dari Vercel Blob Storage.' });
  }

  // Validasi tipe file
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (mimeType && !allowedMimes.includes(mimeType)) {
    return res.status(400).json({ error: 'Tipe file tidak diizinkan' });
  }

  try {
    const bookRes = await db.query(
      `SELECT b.id, b.client_name, b.client_phone, b.dp_amount, b.status,
              bc.dp_type, bc.dp_value
       FROM bookings b
       JOIN booking_categories bc ON b.category_id = bc.id
       WHERE b.id = $1`,
      [bookingId]
    );
    if (!bookRes.rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    const booking = bookRes.rows[0];

    if (booking.status === 'confirmed' || booking.status === 'cancelled') {
      return res.status(409).json({ error: `Booking sudah berstatus ${booking.status}` });
    }

    // Simpan ke tabel payments
    await db.query(
      `INSERT INTO payments (booking_id, amount, payment_type, proof_url, proof_filename, blob_key, status)
       VALUES ($1, $2, 'dp', $3, $4, $5, 'pending')`,
      [bookingId, booking.dp_amount || null, blobUrl, fileName, blobKey || null]
    );

    // Simpan ke tabel attachments (untuk tracking lengkap)
    await db.query(
      `INSERT INTO attachments (booking_id, file_url, blob_key, file_name, file_type, mime_type, file_size)
       VALUES ($1, $2, $3, $4, 'payment_proof', $5, $6)
       ON CONFLICT DO NOTHING`,
      [bookingId, blobUrl, blobKey || null, fileName, mimeType || null, fileSize || null]
    );

    // Update status booking → dp_review
    await db.query(
      `UPDATE bookings SET status = 'dp_review' WHERE id = $1`,
      [bookingId]
    );

    // Notifikasi WhatsApp ke admin
    const adminPhone = process.env.ADMIN_WHATSAPP;
    if (adminPhone) {
      let msg = await getWaTemplate('dp_uploaded_admin', {
        client_name: booking.client_name,
        client_phone: booking.client_phone
      });
      if (!msg) {
        msg = `📸 *Booking Baru (Jadiphoto.Moment) — DP Masuk!*\n\nKlien: *${booking.client_name}*\nNo. HP: ${booking.client_phone}\n\nBukti transfer sudah diupload dan menunggu verifikasi Anda.\n\nCek dashboard admin untuk approve/reject.`;
      }
      sendWhatsApp(adminPhone, msg).catch(() => {});
    }

    res.json({
      message: 'Bukti transfer berhasil diupload. Menunggu konfirmasi admin.',
      status:  'dp_review'
    });
  } catch (err) {
    console.error('[bookings] upload-dp error:', err);
    res.status(500).json({ error: 'Gagal menyimpan data bukti transfer' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS (butuh JWT)
// ═══════════════════════════════════════════════════════════════

// Helper function for admin booking list
async function handleAdminList(req, res) {
  const { category, status, month, search, sumber_informasi, include_deleted } = req.query;
  const params = [];
  const conditions = [];

  // Exclude soft-deleted bookings by default
  if (include_deleted !== 'true') {
    conditions.push('b.deleted_at IS NULL');
  }

  if (category) { params.push(category); conditions.push(`bc.slug = $${params.length}`); }
  if (status)   { params.push(status);   conditions.push(`b.status = $${params.length}`); }
  if (month)    {
    params.push(month + '-01');
    params.push(month + '-31');
    conditions.push(`b.event_date BETWEEN $${params.length - 1} AND $${params.length}`);
  }
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(b.client_name ILIKE $${params.length} OR b.client_phone ILIKE $${params.length})`);
  }
  if (sumber_informasi) {
    params.push(sumber_informasi);
    conditions.push(`b.sumber_informasi = $${params.length}`);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const { rows } = await db.query(
      `SELECT b.id, b.client_name, b.client_phone, b.event_date, b.event_time,
              b.location, b.form_data, b.package_price, b.dp_amount, b.status,
              b.created_at, b.session_id, b.sumber_informasi, b.sumber_informasi_detail,
              b.deleted_at, b.google_event_id, b.calendar_sync_status,
              bc.name AS category_name, bc.slug AS category_slug, bc.color,
              (SELECT COUNT(*) FROM payments WHERE booking_id = b.id AND status = 'pending') AS pending_payments,
              (SELECT COUNT(*) FROM pelunasan WHERE booking_id = b.id AND status = 'menunggu_verifikasi') AS pending_pelunasan
       FROM bookings b
       JOIN booking_categories bc ON b.category_id = bc.id
       ${where}
       ORDER BY b.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[bookings] admin list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
}

// GET /api/admin/bookings — daftar booking dengan filter
router.get('/admin/list', auth, auth.requirePermission('booking.view'), handleAdminList);
router.get('/', auth, auth.requirePermission('booking.view'), handleAdminList);

// GET /api/admin/bookings/:id — detail booking (admin)
async function handleAdminDetail(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT b.*, bc.name AS category_name, bc.slug AS category_slug,
              bc.color, bc.dp_type, bc.dp_value, bc.fields AS category_fields,
              COALESCE(u_up.nama, a_up.name) AS updated_by_name
       FROM bookings b
       JOIN booking_categories bc ON b.category_id = bc.id
       LEFT JOIN users u_up ON b.updated_by = u_up.id
       LEFT JOIN admins a_up ON b.updated_by = a_up.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });

    const booking = rows[0];
    const [payRes, attachRes, pelRes] = await Promise.all([
      db.query(
        `SELECT p.*, COALESCE(u.nama, a.name) AS approved_by_name
         FROM payments p
         LEFT JOIN users u ON p.approved_by = u.id
         LEFT JOIN admins a ON p.approved_by = a.id
         WHERE p.booking_id = $1 ORDER BY p.created_at DESC`,
        [booking.id]
      ),

      db.query(
        `SELECT id, file_url, blob_key, file_name, file_type, mime_type, file_size, created_at
         FROM attachments
         WHERE booking_id = $1 ORDER BY created_at DESC`,
        [booking.id]
      ),
      db.query(
        `SELECT p.*, a_verif.name AS verified_by_name, a_create.name AS created_by_name
         FROM pelunasan p
         LEFT JOIN admins a_verif  ON p.verified_by = a_verif.id
         LEFT JOIN admins a_create ON p.created_by  = a_create.id
         WHERE p.booking_id = $1 ORDER BY p.created_at DESC`,
        [booking.id]
      ),
    ]);

    booking.payments = payRes.rows;
    booking.attachments = attachRes.rows;
    booking.pelunasan = pelRes.rows;

    res.json(booking);
  } catch (err) {
    console.error('[bookings] admin detail error:', err);
    res.status(500).json({ error: 'Database error' });
  }
}

router.get('/admin/detail/:id', auth, auth.requirePermission('booking.view'), handleAdminDetail);

// PATCH /api/admin/bookings/:id/set-price — set harga paket & dp_amount (legacy, kept for compat)
router.patch('/admin/:id/set-price', auth, auth.requirePermission('booking.update'), async (req, res) => {
  const { packagePrice } = req.body;
  const price = parseFloat(packagePrice);
  if (isNaN(price) || price < 0) return res.status(400).json({ error: 'Harga tidak valid' });

  try {
    const bookRes = await db.query(
      `SELECT b.id, bc.dp_type, bc.dp_value
       FROM bookings b JOIN booking_categories bc ON b.category_id = bc.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!bookRes.rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    const { dp_type, dp_value } = bookRes.rows[0];

    let dpAmount = 0;
    if (dp_type === 'percent') {
      dpAmount = (price * parseFloat(dp_value)) / 100;
    } else {
      dpAmount = parseFloat(dp_value);
    }

    await db.query(
      'UPDATE bookings SET package_price = $1, dp_amount = $2 WHERE id = $3',
      [price, dpAmount, req.params.id]
    );

    res.json({ packagePrice: price, dpAmount, message: 'Harga paket disimpan' });
  } catch (err) {
    console.error('[bookings] set-price error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/admin/bookings/:id — edit full booking data
async function handleEditBooking(req, res) {
  const { client_name, client_phone, event_date, event_time, location, package_price, dp_amount_manual, form_data } = req.body;

  if (!client_name || !client_phone || !event_date) {
    return res.status(400).json({ error: 'Nama klien, nomor WA, dan tanggal acara wajib diisi' });
  }

  let dbClient;
  try {
    // Get existing booking + category rules
    const bookRes = await db.query(
      `SELECT b.*, bc.dp_type, bc.dp_value, bc.time_slots
       FROM bookings b
       JOIN booking_categories bc ON b.category_id = bc.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!bookRes.rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    const booking = bookRes.rows[0];

    // Recalculate dp_amount if package_price changed or dp_amount_manual is provided
    let dpAmount = booking.dp_amount;
    const price = package_price != null ? parseFloat(package_price) : null;
    
    if (dp_amount_manual != null && dp_amount_manual !== '') {
      dpAmount = parseFloat(dp_amount_manual);
    } else if (price != null && !isNaN(price) && price > 0) {
      if (booking.dp_type === 'percent') {
        dpAmount = (price * parseFloat(booking.dp_value)) / 100;
      } else {
        dpAmount = parseFloat(booking.dp_value);
      }
    }

    // If confirmed & date/time changed, check for slot conflicts
    const dateChanged = event_date !== (booking.event_date ? getLocalDateString(booking.event_date) : null);
    const timeChanged = event_time !== booking.event_time;
    if (booking.status === 'confirmed' && (dateChanged || timeChanged) && event_date) {
      const conflictRes = await db.query(
        `SELECT id FROM bookings
         WHERE event_date = $1 AND event_time = $2 AND status = 'confirmed' AND id <> $3`,
        [event_date, event_time || null, booking.id]
      );
      if (conflictRes.rows.length > 0) {
        return res.status(409).json({ error: 'Tanggal dan jam sudah dikunci oleh booking lain yang dikonfirmasi' });
      }
    }

    // Optimistic locking
    const expectedVersion = req.body.version !== undefined ? parseInt(req.body.version, 10) : null;
    if (expectedVersion !== null && !isNaN(expectedVersion) && booking.version !== expectedVersion) {
      return res.status(409).json({ error: 'Data telah diubah oleh pengguna lain. Silakan refresh.' });
    }

    dbClient = await db.getClient();
    await dbClient.query('BEGIN');

    // Update booking dengan atomic compare-and-swap (Optimistic Concurrency Control)
    const updateResult = await dbClient.query(
      `UPDATE bookings SET
         client_name   = $1,
         client_phone  = $2,
         event_date    = $3,
         event_time    = $4,
         location      = $5,
         package_price = COALESCE($6, package_price),
         dp_amount     = $7,
         form_data     = COALESCE($8, form_data),
         updated_by    = $9,
         version       = version + 1
       WHERE id = $10 AND ($11::int IS NULL OR version = $11)`,
      [
        client_name.trim(),
        client_phone.trim(),
        event_date,
        event_time || null,
        location || null,
        price || null,
        dpAmount,
        form_data ? JSON.stringify(form_data) : null,
        req.user.id,
        booking.id,
        expectedVersion
      ]
    );

    if (updateResult.rowCount === 0) {
      await dbClient.query('ROLLBACK');
      return res.status(409).json({ error: 'Data telah diubah oleh pengguna lain. Silakan refresh.' });
    }

    // Sync pending payment amount if dp_amount changed
    if (dpAmount !== booking.dp_amount) {
      await dbClient.query(
        `UPDATE payments SET amount = $1, updated_by = $2, version = version + 1
         WHERE booking_id = $3 AND status = 'pending'`,
        [dpAmount, req.user.id, booking.id]
      );
    }

    await audit.record(dbClient, {
      req,
      aksi: 'booking.update',
      entitas: 'booking',
      entitas_id: booking.id,
      data_sebelum: {
        client_name: booking.client_name,
        client_phone: booking.client_phone,
        event_date: booking.event_date,
        event_time: booking.event_time,
        package_price: booking.package_price,
        dp_amount: booking.dp_amount
      },
      data_setelah: {
        client_name: client_name.trim(),
        client_phone: client_phone.trim(),
        event_date,
        event_time: event_time || null,
        package_price: price || booking.package_price,
        dp_amount: dpAmount
      }
    });

    await dbClient.query('COMMIT');

    // Return updated booking
    const updRes = await db.query(
      `SELECT b.*, bc.name AS category_name, bc.color, bc.slug AS category_slug,
              bc.dp_type, bc.dp_value, bc.fields AS category_fields
       FROM bookings b JOIN booking_categories bc ON b.category_id = bc.id
       WHERE b.id = $1`,
      [booking.id]
    );
    res.json({ message: 'Booking berhasil diperbarui', booking: updRes.rows[0] });
  } catch (err) {
    if (dbClient) await dbClient.query('ROLLBACK');
    console.error('[bookings] edit error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (dbClient) dbClient.release();
  }
}

router.put('/admin/:id', auth, auth.requirePermission('booking.update'), handleEditBooking);
router.put('/:id', auth, auth.requirePermission('booking.update'), handleEditBooking);

// ── POST /api/bookings/:id/approve — Approve DP langsung oleh Staff/Owner ────────
router.post('/:id/approve', auth, auth.requirePermission('booking.approve'), async (req, res) => {
  try {
    const { version, nominal_diterima, alasan_selisih } = req.body || {};
    const result = await approveBooking({
      bookingId: req.params.id,
      expectedVersion: version !== undefined && version !== null ? parseInt(version, 10) : undefined,
      nominalDiterima: nominal_diterima,
      alasanSelisih: alasan_selisih,
      actor: req.user,
      req
    });
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || 'Terjadi kesalahan pada server',
      code: err.code || (status === 409 ? 'CONFLICT' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'SERVER_ERROR')
    });
  }
});

// ── POST /api/bookings/:id/reject — Reject DP langsung oleh Staff/Owner ──────────
router.post('/:id/reject', auth, auth.requirePermission('booking.approve'), async (req, res) => {
  try {
    const { version, alasan } = req.body || {};
    if (!alasan || !alasan.trim()) {
      return res.status(400).json({ error: 'Alasan penolakan DP wajib diisi' });
    }
    const result = await rejectBooking({
      bookingId: req.params.id,
      expectedVersion: version !== undefined && version !== null ? parseInt(version, 10) : undefined,
      alasan: alasan.trim(),
      actor: req.user,
      req
    });
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || 'Terjadi kesalahan pada server',
      code: err.code || (status === 409 ? 'CONFLICT' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'SERVER_ERROR')
    });
  }
});

// ── POST /api/bookings/:id/cancel-approval — Pembatalan approve (Owner Only) ─────
router.post('/:id/cancel-approval', auth, async (req, res) => {
  if (req.user.role !== 'owner' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Akses ditolak: Hanya Owner yang dapat membatalkan persetujuan booking' });
  }

  const bId = parseInt(req.params.id, 10);
  if (isNaN(bId) || bId <= 0) {
    return res.status(400).json({ error: 'ID Booking tidak valid' });
  }
  const { alasan } = req.body || {};
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const bRes = await client.query(
      `SELECT id, status, version, dp_amount FROM bookings WHERE id = $1 FOR UPDATE`,
      [bId]
    );
    if (!bRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking tidak ditemukan' });
    }
    const booking = bRes.rows[0];
    if (booking.status !== 'confirmed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Booking bukan dalam status confirmed (status saat ini: '${booking.status}')` });
    }

    await client.query(
      `UPDATE bookings SET status = 'dp_review', updated_by = $1, version = version + 1 WHERE id = $2`,
      [req.user.id, booking.id]
    );

    await client.query(
      `UPDATE payments SET status = 'pending', updated_by = $1, version = version + 1 WHERE booking_id = $2 AND payment_type = 'dp'`,
      [req.user.id, booking.id]
    );

    await client.query(
      `UPDATE financial_entries SET status = 'batal', catatan = catatan || ' (Dibatalkan oleh Owner)' WHERE sumber_tipe = 'booking_dp' AND sumber_id = $1 AND status = 'aktif'`,
      [booking.id]
    );

    await audit.record(client, {
      req,
      aktor_id: req.user.id,
      aktor_role: req.user.role,
      aksi: 'booking.cancel_approval',
      entitas: 'booking',
      entitas_id: booking.id,
      data_sebelum: { status: 'confirmed' },
      data_setelah: { status: 'dp_review', alasan: alasan || null }
    });

    await client.query('COMMIT');
    res.json({ success: true, message: 'Persetujuan booking berhasil dibatalkan oleh Owner' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[bookings] cancel-approval error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// ── GET /api/bookings/admin/daily-approvals — Ringkasan approve harian untuk Owner ─
router.get('/admin/daily-approvals', auth, async (req, res) => {
  if (req.user.role !== 'owner' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Akses ditolak: Hanya Owner yang dapat melihat ringkasan approve' });
  }
  const { date, cursor_id, limit: limitStr } = req.query;
  const targetDate = date || new Date().toISOString().slice(0, 10);
  const limit = Math.min(parseInt(limitStr, 10) || 50, 100);
  const cursorId = cursor_id ? parseInt(cursor_id, 10) : null;
  try {
    const params = [targetDate];
    let cursorClause = '';
    if (cursorId && !isNaN(cursorId)) {
      cursorClause = ' AND al.id < $2';
      params.push(cursorId);
    }
    params.push(limit + 1);
    const { rows } = await db.query(`
      SELECT al.id, al.actor_id, al.actor_role, al.entitas_id AS booking_id,
             al.sesudah, al.created_at,
             COALESCE(u.nama, a.name) AS aktor_name,
             b.client_name, b.dp_amount,
             (al.sesudah->>'nominal_diterima')::NUMERIC AS nominal_diterima,
             (al.sesudah->>'anomali')::BOOLEAN AS anomali,
             (al.sesudah->>'selisih')::NUMERIC AS selisih
      FROM audit_log al
      LEFT JOIN users u ON al.actor_id = u.id AND al.actor_role = 'staff'
      LEFT JOIN admins a ON al.actor_id = a.id AND al.actor_role = 'owner'
      LEFT JOIN bookings b ON al.entitas_id = b.id
      WHERE al.aksi = 'booking.approve'
        AND al.created_at::date = $1 AT TIME ZONE 'Asia/Jakarta'${cursorClause}
      ORDER BY al.id DESC
      LIMIT $${params.length}
    `, params);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    const totalDP = items.reduce((s, r) => s + Number(r.nominal_diterima || 0), 0);
    const anomalyCount = items.filter(r => r.anomali).length;

    res.json({
      date: targetDate,
      total: items.length,
      total_dp: totalDP,
      anomaly_count: anomalyCount,
      items: items.map(r => ({
        id: r.id,
        booking_id: r.booking_id,
        client_name: r.client_name,
        aktor_name: r.aktor_name,
        aktor_role: r.aktor_role,
        nominal_diterima: Number(r.nominal_diterima || 0),
        selisih: Number(r.selisih || 0),
        anomali: !!r.anomali,
        created_at: r.created_at
      })),
      next_cursor: nextCursor
    });
  } catch (err) {
    console.error('[bookings] daily-approvals error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/admin/bookings/:id/approve-dp — approve DP (legacy)

router.patch('/admin/:id/approve-dp', auth, auth.requirePermission('payment.verify'), async (req, res) => {
  let client;
  try {
    const bookRes = await db.query(
      `SELECT b.id, b.client_name, b.client_phone, b.event_date, b.event_time, b.status, b.category_id, b.form_data, b.location, b.package_price, b.dp_amount,
              bc.time_slots
       FROM bookings b 
       JOIN booking_categories bc ON b.category_id = bc.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!bookRes.rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    const booking = bookRes.rows[0];

    if (booking.status !== 'dp_review') {
      return res.status(409).json({ error: 'Status booking bukan dp_review' });
    }

    // Cek bentrok kalender / kuota
    const timeSlots = booking.time_slots || [];
    if (timeSlots.length > 0 && booking.event_time) {
      const slotConfig = timeSlots.find(s => s.time === booking.event_time);
      if (slotConfig) {
        const quota = parseInt(slotConfig.quota, 10) || 1;
        const { rows: cRows } = await db.query(
          `SELECT COUNT(*) as count FROM bookings 
           WHERE category_id = $1 AND event_date = $2 AND event_time = $3 
             AND status IN ('confirmed', 'completed') AND id != $4`,
          [booking.category_id, booking.event_date, booking.event_time, booking.id]
        );
        if (parseInt(cRows[0].count, 10) >= quota) {
          return res.status(409).json({ error: 'Maaf, kuota jam ini sudah penuh oleh booking lain.' });
        }
      }
    } else {
      // Fallback
      const conflictRes = await db.query(
        `SELECT id FROM bookings WHERE event_date = $1 AND event_time = $2 AND status = 'confirmed' AND id != $3`,
        [booking.event_date, booking.event_time, booking.id]
      );
      if (conflictRes.rows.length > 0 && booking.event_time) {
        return res.status(409).json({ error: 'Tanggal dan jam sudah dikunci oleh booking lain yang confirmed' });
      }
    }

    // Ambil payment pending terbaru
    const payRes = await db.query(
      `SELECT id, amount FROM payments WHERE booking_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [booking.id]
    );

    client = await db.getClient();
    await client.query('BEGIN');

    // Update booking → confirmed
    await client.query(
      `UPDATE bookings SET status = 'confirmed', updated_by = $1, version = version + 1 WHERE id = $2`,
      [req.user.id, booking.id]
    );

    // Update payment → approved
    if (payRes.rows[0]) {
      await client.query(
        `UPDATE payments SET status = 'approved', approved_by = $1, approved_at = now(), updated_by = $1, version = version + 1 WHERE id = $2`,
        [req.user.id, payRes.rows[0].id]
      );
    }

    await audit.record(client, {
      req,
      aksi: 'payment.verify',
      entitas: 'booking',
      entitas_id: booking.id,
      data_sebelum: { status: 'dp_review' },
      data_setelah: { status: 'confirmed', action: 'approve_dp' }
    });

    await client.query('COMMIT');

    // Notifikasi WA ke klien
    const eventDateFmt = new Date(booking.event_date).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    let msg = await getWaTemplate('booking_confirmed', {
      client_name: booking.client_name,
      event_date: eventDateFmt,
      event_time: booking.event_time ? booking.event_time.slice(0, 5) : '-',
      location: booking.location || '-',
      package_price: booking.package_price ? 'Rp ' + Number(booking.package_price).toLocaleString('id-ID') : '-',
      dp_amount: booking.dp_amount ? 'Rp ' + Number(booking.dp_amount).toLocaleString('id-ID') : '-',
    });
    if (!msg) {
      msg = `✅ *Booking Dikonfirmasi — Jadiphoto.Moment*\n\nHalo ${booking.client_name},\n\nBooking Anda untuk tanggal *${eventDateFmt}* telah dikonfirmasi. DP sudah diterima dan tanggal resmi terkunci.\n\nTerima kasih telah mempercayai Jadiphoto.Moment! 📸`;
    }
    if (booking.client_phone) sendWhatsApp(booking.client_phone, msg).catch(() => {});

    res.json({ message: 'DP disetujui. Booking terkonfirmasi dan tanggal terkunci.' });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[bookings] approve-dp error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

// PATCH /api/admin/bookings/:id/reject-dp — reject DP
router.patch('/admin/:id/reject-dp', auth, auth.requirePermission('payment.verify'), async (req, res) => {
  const { reason } = req.body;
  let client;
  try {
    const bookRes = await db.query(
      `SELECT id, client_name, client_phone, status FROM bookings WHERE id = $1`,
      [req.params.id]
    );
    if (!bookRes.rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    const booking = bookRes.rows[0];

    const payRes = await db.query(
      `SELECT id FROM payments WHERE booking_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [booking.id]
    );

    client = await db.getClient();
    await client.query('BEGIN');

    await client.query(
      `UPDATE bookings SET status = 'pending_dp', updated_by = $1, version = version + 1 WHERE id = $2`,
      [req.user.id, booking.id]
    );

    if (payRes.rows[0]) {
      await client.query(
        `UPDATE payments SET status = 'rejected', approved_by = $1, approved_at = now(), reject_reason = $2, updated_by = $1, version = version + 1 WHERE id = $3`,
        [req.user.id, reason || null, payRes.rows[0].id]
      );
    }

    await audit.record(client, {
      req,
      aksi: 'payment.verify',
      entitas: 'booking',
      entitas_id: booking.id,
      data_sebelum: { status: 'dp_review' },
      data_setelah: { status: 'pending_dp', action: 'reject_dp', reason: reason || null }
    });

    await client.query('COMMIT');

    // Notifikasi WA ke klien
    const reasonText = reason ? `\n\nAlasan: _${reason}_` : '';
    const uploadDpUrl = buildPublicUrl(`/upload-dp.html?booking=${booking.id}`);
    // Coba template dari DB (dp_rejected)
    let msg = await getWaTemplate('dp_rejected', {
      client_name: booking.client_name,
      reason_text: reason ? `\n\nAlasan: _${reason}_` : '',
      upload_dp_url: uploadDpUrl,
    });
    if (!msg) {
      msg = `❌ *Bukti Transfer Ditolak*\n\nHalo ${booking.client_name},\n\nBukti transfer DP Anda tidak dapat diverifikasi.${reasonText}\n\nSilakan upload ulang bukti transfer yang valid melalui link berikut:\n🔗 ${uploadDpUrl}\n\nTerima kasih.`;
    }
    if (booking.client_phone) sendWhatsApp(booking.client_phone, msg).catch(() => {});

    res.json({ message: 'DP ditolak. Klien perlu upload ulang.' });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[bookings] reject-dp error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

// POST /api/admin/bookings/:id/send-wa-confirmation — kirim WA konfirmasi manual
router.post('/admin/:id/send-wa-confirmation', auth, auth.requirePermission('tagihan.send'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT b.id, b.client_name, b.client_phone, b.event_date, b.event_time, b.status, b.category_id, b.form_data, b.location, b.package_price, b.dp_amount,
              bc.time_slots
       FROM bookings b 
       JOIN booking_categories bc ON b.category_id = bc.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    const booking = rows[0];

    if (!booking.client_phone) {
      return res.status(400).json({ error: 'Nomor WhatsApp klien tidak tersedia' });
    }

    const eventDateFmt = new Date(booking.event_date).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    let msg = await getWaTemplate('booking_confirmed', {
      client_name: booking.client_name,
      event_date: eventDateFmt,
      event_time: booking.event_time ? booking.event_time.slice(0, 5) : '-',
      location: booking.location || '-',
      package_price: booking.package_price ? 'Rp ' + Number(booking.package_price).toLocaleString('id-ID') : '-',
      dp_amount: booking.dp_amount ? 'Rp ' + Number(booking.dp_amount).toLocaleString('id-ID') : '-',
    });
    if (!msg) {
      msg = `✅ *Booking Dikonfirmasi — Jadiphoto.Moment*\n\nHalo ${booking.client_name},\n\nBooking Anda untuk tanggal *${eventDateFmt}* telah dikonfirmasi. DP sudah diterima dan tanggal resmi terkunci.\n\nTerima kasih telah mempercayai Jadiphoto.Moment! 📸`;
    }

    const waRes = await sendWhatsApp(booking.client_phone, msg);
    if (waRes && (waRes.status === true || waRes.status === 'true')) {
       res.json({ message: 'Pesan konfirmasi berhasil dikirim ke WhatsApp klien' });
    } else {
       res.status(500).json({ error: 'Gagal mengirim pesan WhatsApp. Cek token Fonnte.' });
    }
  } catch (err) {
    console.error('[bookings] send-wa-confirmation error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan pada server' });
  }
});

// PATCH /api/admin/bookings/:id/status — ubah status manual
router.patch('/admin/:id/status', auth, auth.requirePermission('booking.update'), async (req, res) => {
  const { status } = req.body;
  const VALID = ['pending_dp', 'dp_review', 'confirmed', 'menunggu_pelunasan', 'pelunasan_review', 'lunas', 'completed', 'cancelled'];
  if (!VALID.includes(status)) return res.status(400).json({ error: 'Status tidak valid' });

  const bookingId = parseInt(req.params.id, 10);
  if (isNaN(bookingId)) return res.status(400).json({ error: 'ID booking tidak valid' });

  let client;
  try {
    const bookRes = await db.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (!bookRes.rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    const current = bookRes.rows[0];

    // Jika dibatalkan dan sudah ada DP: cek apakah perlu approval
    if (status === 'cancelled') {
      const payCheck = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_dp
         FROM payments
         WHERE booking_id = $1 AND status = 'approved' AND payment_type = 'dp'`,
        [bookingId]
      );
      const hasDp = Number(payCheck.rows[0]?.total_dp || 0) > 0 || (current.dp_amount > 0 && current.status !== 'pending_dp');

      if (hasDp) {
        const mode = await approvalSvc.resolveAksi('booking.cancel_with_dp', req.user.role);
        if (mode === 'approval') {
          const appReq = await approvalSvc.ajukan({
            aksiTipe: 'booking.cancel_with_dp',
            requestedBy: req.user.id,
            entitasTipe: 'booking',
            entitasId: bookingId,
            baseVersion: current.version || 1,
            payload: { status: 'cancelled' },
            req
          });
          return res.status(202).json({
            status: 'pending_approval',
            message: 'Pembatalan booking dengan DP memerlukan persetujuan Owner',
            approval_id: appReq.id
          });
        }
      }
    }

    client = await db.getClient();
    await client.query('BEGIN');

    await client.query(
      `UPDATE bookings
       SET status = $1, updated_by = $2, version = version + 1
       WHERE id = $3`,
      [status, req.user.id, bookingId]
    );

    await audit.record(client, {
      req,
      aksi: 'booking.update',
      entitas: 'booking',
      entitas_id: bookingId,
      data_sebelum: { status: current.status },
      data_setelah: { status }
    });

    await client.query('COMMIT');
    res.json({ message: 'Status booking diperbarui', status });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[bookings] status update error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

// DELETE /api/admin/bookings/:id — soft delete booking
async function handleSoftDelete(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID booking tidak valid' });

  let client;
  try {
    const check = await db.query('SELECT * FROM bookings WHERE id = $1', [id]);
    if (!check.rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    if (check.rows[0].deleted_at) {
      return res.status(409).json({ error: 'Booking ini sudah dihapus (soft-deleted)' });
    }
    const current = check.rows[0];

    // Cek approval rule untuk booking.delete
    const mode = await approvalSvc.resolveAksi('booking.delete', req.user.role);
    if (mode === 'approval') {
      const appReq = await approvalSvc.ajukan({
        aksiTipe: 'booking.delete',
        requestedBy: req.user.id,
        entitasTipe: 'booking',
        entitasId: id,
        baseVersion: current.version || 1,
        payload: { id },
        req
      });
      return res.status(202).json({
        status: 'pending_approval',
        message: 'Penghapusan booking memerlukan persetujuan Owner',
        approval_id: appReq.id
      });
    }

    client = await db.getClient();
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE bookings
       SET deleted_at = now(), status = 'cancelled', updated_by = $1, version = version + 1
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING id, client_name, status, deleted_at`,
      [req.user.id, id]
    );

    await audit.record(client, {
      req,
      aksi: 'booking.delete',
      entitas: 'booking',
      entitas_id: id,
      data_sebelum: { status: current.status, deleted_at: null },
      data_setelah: { status: 'cancelled', deleted_at: rows[0]?.deleted_at }
    });

    await client.query('COMMIT');
    res.json({ message: 'Booking berhasil dibatalkan dan dihapus (soft delete)', booking: rows[0] });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[bookings] DELETE error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
}

router.delete('/admin/:id', auth, auth.requirePermission('booking.delete'), handleSoftDelete);
router.delete('/:id', auth, auth.requirePermission('booking.delete'), handleSoftDelete);

// POST /api/admin/bookings/create — admin manual booking input
async function handleAdminCreateBooking(req, res) {
  const { category_id, client_name, client_phone, event_date, event_time, location, package_price, dp_amount, form_data, status, sumber_informasi, sumber_informasi_detail } = req.body;

  if (!category_id || !client_name || !client_phone || !event_date) {
    return res.status(400).json({ error: 'Kategori, nama klien, no HP/WA, dan tanggal acara wajib diisi' });
  }

  let client;
  try {
    const catRes = await db.query('SELECT id, name FROM booking_categories WHERE id = $1', [category_id]);
    if (!catRes.rows[0]) return res.status(404).json({ error: 'Kategori tidak ditemukan' });

    const price = package_price ? parseFloat(package_price) : null;
    const dp = dp_amount ? parseFloat(dp_amount) : null;

    client = await db.getClient();
    await client.query('BEGIN');

    const pkgName = req.body.package_name || (form_data && (form_data.package_name || form_data._package_name)) || catRes.rows[0]?.name || null;

    const { rows } = await client.query(
      `INSERT INTO bookings (category_id, client_name, client_phone, event_date, event_time, location, package_price, dp_amount, form_data, status, sumber_informasi, sumber_informasi_detail, package_name, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
       RETURNING *`,
      [
        category_id,
        client_name.trim(),
        client_phone.trim(),
        event_date,
        event_time || null,
        location ? location.trim() : null,
        price,
        dp,
        form_data ? JSON.stringify(form_data) : '{}',
        status || 'confirmed',
        sumber_informasi || null,
        sumber_informasi_detail || null,
        pkgName,
        req.user.id
      ]
    );

    const newBooking = rows[0];

    await audit.record(client, {
      req,
      aksi: 'booking.create',
      entitas: 'booking',
      entitas_id: newBooking.id,
      data_setelah: {
        id: newBooking.id,
        client_name: newBooking.client_name,
        client_phone: newBooking.client_phone,
        event_date: newBooking.event_date,
        package_price: newBooking.package_price
      }
    });

    await client.query('COMMIT');
    res.status(201).json({ message: 'Booking berhasil dibuat manual oleh admin', booking: newBooking });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[bookings] admin create error:', err);
    res.status(500).json({ error: 'Gagal membuat booking' });
  } finally {
    if (client) client.release();
  }
}

router.post('/admin/create', auth, auth.requirePermission('booking.create'), handleAdminCreateBooking);
router.post('/admin', auth, auth.requirePermission('booking.create'), handleAdminCreateBooking);

// GET /api/admin/bookings/:id/history — riwayat audit log booking
async function handleBookingHistory(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID booking tidak valid' });

  try {
    const { rows } = await db.query(
      `SELECT a.id, a.request_id, a.actor_id, a.actor_role, a.aksi,
              a.entitas, a.entitas_id, a.sebelum, a.sesudah, a.approval_id,
              a.ip, a.created_at,
              u.nama AS actor_name, u.email AS actor_email
       FROM audit_log a
       LEFT JOIN users u ON a.actor_id = u.id
       WHERE a.entitas = 'booking' AND a.entitas_id = $1
       ORDER BY a.created_at DESC, a.id DESC`,
      [id.toString()]
    );
    res.json({ booking_id: id, history: rows });
  } catch (err) {
    console.error('[bookings] history error:', err);
    res.status(500).json({ error: 'Database error' });
  }
}

router.get('/admin/:id/history', auth, auth.requirePermission('booking.view'), handleBookingHistory);
router.get('/:id/history', auth, auth.requirePermission('booking.view'), handleBookingHistory);

// GET /api/bookings/:id/session-prefill — data prefill buat sesi sortir (admin)
router.get('/:id/session-prefill', auth, auth.requirePermission('booking.view'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT b.id, b.client_name, b.client_phone, b.event_date, b.package_name, b.status, b.session_created_at,
              bc.name AS category_name, bc.packages
       FROM bookings b
       JOIN booking_categories bc ON b.category_id = bc.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    const b = rows[0];

    // Ekstrak photo_limit dari deskripsi paket yang cocok (cari angka diikuti kata foto/photo/edited)
    let photoLimit = null;
    const pkgs = b.packages || [];
    const matchedPkg = pkgs.find(p => p.name === b.package_name) || pkgs[0];
    if (matchedPkg && matchedPkg.description) {
      const m = matchedPkg.description.match(/(\d+)\s*(edited\s*photo|foto\s*edit|photo)/i);
      if (m) photoLimit = parseInt(m[1], 10);
    }

    const eventDate = b.event_date
      ? (b.event_date instanceof Date ? b.event_date.toISOString().slice(0, 10) : String(b.event_date).slice(0, 10))
      : null;
    const note = [b.category_name, b.package_name, eventDate].filter(Boolean).join(' | ');

    res.json({
      name: b.client_name || '',
      wa: b.client_phone || '',
      photoLimit,
      note,
      status: b.status,
      sessionCreatedAt: b.session_created_at || null
    });
  } catch (err) {
    console.error('[bookings] session-prefill error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/admin/bookings/:id/mark-session-created — tandai sesi sudah dibuat dari booking
router.patch('/admin/:id/mark-session-created', auth, auth.requirePermission('booking.update'), async (req, res) => {
  try {
    await db.query('UPDATE bookings SET session_created_at = now() WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[bookings] mark-session-created error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/admin/bookings/:id/link-session — hubungkan ke sesi sortir
router.patch('/admin/:id/link-session', auth, auth.requirePermission('booking.update'), async (req, res) => {
  const { sessionUuid } = req.body;
  try {
    const sessRes = await db.query('SELECT id FROM sessions WHERE uuid = $1 AND admin_id = $2', [sessionUuid, req.admin.adminId]);
    if (!sessRes.rows[0]) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    await db.query('UPDATE bookings SET session_id = $1 WHERE id = $2', [sessRes.rows[0].id, req.params.id]);
    res.json({ message: 'Sesi sortir berhasil dihubungkan ke booking' });
  } catch (err) {
    console.error('[bookings] link-session error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/bookings/calendar — data untuk FullCalendar
router.get('/admin/calendar', auth, auth.requirePermission('booking.view'), async (req, res) => {
  const { month } = req.query;
  const params = [];
  let dateFilter = '';
  if (month) {
    // Use date_trunc to safely get first and last day of the month
    params.push(month + '-01');
    dateFilter = `AND b.event_date >= $1 AND b.event_date < ($1::date + INTERVAL '1 month')`;
  }

  try {
    const { rows } = await db.query(
      `SELECT b.id, b.client_name, b.client_phone, b.event_date, b.event_time,
              b.location, b.package_price, b.dp_amount, b.status,
              bc.name AS category_name, bc.color
       FROM bookings b
       JOIN booking_categories bc ON b.category_id = bc.id
       WHERE b.status IN ('confirmed', 'dp_review', 'completed', 'pending_dp', 'menunggu_pelunasan', 'pelunasan_review', 'lunas')
         AND b.deleted_at IS NULL ${dateFilter}
       ORDER BY b.event_date, b.event_time`,
      params
    );

    // Format untuk FullCalendar
    const STATUS_ALPHA = { confirmed: 'ff', lunas: 'ff', completed: 'aa', dp_review: 'cc', pelunasan_review: 'dd', menunggu_pelunasan: 'cc', pending_dp: '66' };
    const events = rows.map(r => {
      const dateStr = getLocalDateString(r.event_date);
      const baseColor = r.color || '#7c6dfa';
      // dim non-confirmed events
      const alpha = STATUS_ALPHA[r.status] || 'aa';
      const timeLabel = r.event_time ? r.event_time.slice(0,5) : '';
      return {
        id:    r.id,
        title: timeLabel ? `${timeLabel} ${r.client_name}` : r.client_name,
        start: r.event_time ? `${dateStr}T${r.event_time}` : dateStr,
        color: baseColor,
        textColor: '#fff',
        opacity: r.status === 'pending_dp' ? 0.5 : 1,
        extendedProps: {
          status:        r.status,
          clientName:    r.client_name,
          clientPhone:   r.client_phone,
          categoryName:  r.category_name,
          location:      r.location || '-',
          packagePrice:  r.package_price,
          dpAmount:      r.dp_amount,
          eventTime:     r.event_time ? r.event_time.slice(0,5) : '-',
        }
      };
    });
    res.json(events);
  } catch (err) {
    console.error('[bookings] calendar error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/admin/bookings/:id/sync-calendar — Sinkronisasi ke Google Calendar
router.post('/admin/:id/sync-calendar', auth, auth.requirePermission('booking.update'), async (req, res) => {
  try {
    // 1. Dapatkan token Google untuk admin ini
    const tokenRes = await db.query('SELECT * FROM google_oauth_tokens WHERE admin_id = $1', [req.admin.adminId]);
    if (!tokenRes.rows[0]) {
      return res.status(401).json({ error: 'Belum terhubung ke Google Calendar. Silakan hubungkan akun terlebih dahulu.' });
    }
    const tokenData = tokenRes.rows[0];

    // Gunakan helper terpusat: proactive refresh + auto-save token baru
    let oauth2Client;
    try {
      oauth2Client = await getAuthenticatedClient(tokenData, db, req.admin.adminId);
    } catch (authErr) {
      const isInvalidGrant =
        (authErr.message && authErr.message.includes('invalid_grant')) ||
        (authErr.response && authErr.response.data && authErr.response.data.error === 'invalid_grant');
      if (isInvalidGrant) {
        return res.status(401).json({
          error: 'Sesi Google kadaluarsa. Silakan hubungkan ulang akun Google Calendar Anda.',
          requireReconnect: true,
        });
      }
      throw authErr;
    }

    // 2. Ambil data booking
    const bookRes = await db.query(
      `SELECT b.*, bc.name as category_name
       FROM bookings b
       JOIN booking_categories bc ON b.category_id = bc.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!bookRes.rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    const booking = bookRes.rows[0];

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Siapkan data event
    // Format Waktu: event_date + event_time
    const dateStr = getLocalDateString(booking.event_date);
    const timeStr = booking.event_time || '09:00:00';
    const startDateTime = new Date(`${dateStr}T${timeStr}+07:00`);
    
    // Asumsi durasi 2 jam default jika tidak ada end_time
    const endDateTime = new Date(startDateTime.getTime() + 2 * 60 * 60 * 1000);

    const event = {
      summary: `[${booking.category_name}] ${booking.client_name}`,
      location: booking.location || '',
      description: `Client: ${booking.client_name}\\nPhone: ${booking.client_phone}\\nPaket: Rp ${Number(booking.package_price).toLocaleString('id-ID')}\\nStatus: ${booking.status}\\n\\nBooking ID: ${booking.id}`,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: 'Asia/Jakarta',
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: 'Asia/Jakarta',
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 },
          { method: 'popup', minutes: 30 },
        ],
      },
    };

    let calendarRes;
    if (booking.google_event_id) {
      // Update existing event
      try {
        calendarRes = await calendar.events.patch({
          calendarId: 'primary',
          eventId: booking.google_event_id,
          requestBody: event,
        });
      } catch (patchErr) {
        // Jika event dihapus dari calendar, id tidak ditemukan (404), kita buat baru
        if (patchErr.code === 404 || patchErr.code === 410) {
          calendarRes = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: event,
          });
        } else {
          throw patchErr; // Lemparkan error jika selain 404/410
        }
      }
    } else {
      // Insert new event
      calendarRes = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: event,
      });
    }

    const eventId = calendarRes.data.id;

    // 3. Update status booking & log
    await db.query(
      `UPDATE bookings SET google_event_id = $1, calendar_sync_status = 'synced' WHERE id = $2`,
      [eventId, booking.id]
    );

    await db.query(
      `INSERT INTO sync_logs (booking_id, status, message) VALUES ($1, 'success', 'Synced to calendar')`,
      [booking.id]
    );

    res.json({ message: 'Berhasil disinkronisasi ke Google Calendar', eventId, htmlLink: calendarRes.data.htmlLink });

  } catch (err) {
    console.error('[bookings] sync-calendar error:', err);
    let errorMessage = 'Gagal sinkronisasi dengan Google Calendar';
    let isInvalidGrant = (err.message && err.message.includes('invalid_grant'));
    
    if (err.response && err.response.data && err.response.data.error) {
       if (typeof err.response.data.error === 'string') {
         errorMessage = err.response.data.error_description || err.response.data.error;
         if (err.response.data.error === 'invalid_grant') isInvalidGrant = true;
       } else if (err.response.data.error.message) {
         errorMessage = err.response.data.error.message;
       }
    }

    errorMessage = errorMessage || 'Gagal sinkronisasi dengan Google Calendar';
    const statusCode = parseInt(err.code || (err.response && err.response.status), 10);

    if (statusCode === 401 || statusCode === 403 || isInvalidGrant) {
       errorMessage = 'Akses ditolak atau token kadaluarsa. Silakan hubungkan ulang akun Google Calendar Anda.';
       if (isInvalidGrant) {
         await db.query('DELETE FROM google_oauth_tokens WHERE admin_id = $1', [req.admin.adminId]).catch(e => console.error(e));
       }
    }

    await db.query(
      `UPDATE bookings SET calendar_sync_status = 'failed' WHERE id = $1`,
      [req.params.id]
    ).catch(e => console.error(e));

    await db.query(
      `INSERT INTO sync_logs (booking_id, status, message) VALUES ($1, 'failed', $2)`,
      [req.params.id, errorMessage]
    ).catch(e => console.error(e));

    res.status(500).json({ error: errorMessage });
  }
});

module.exports = router;
