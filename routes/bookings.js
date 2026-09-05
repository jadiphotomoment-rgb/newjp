'use strict';

const express  = require('express');
const router   = express.Router();
const db       = require('../database');
const auth     = require('../middleware/auth');
const https    = require('https');
const { buildTemplateMsg } = require('../utils/template');
const { google } = require('googleapis');

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

    const { rows } = await db.query(
      `INSERT INTO bookings (category_id, client_name, client_phone, event_date, event_time, location, form_data, package_price, dp_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        category.id,
        clientName.trim(),
        clientPhone.trim(),
        eventDate,
        eventTime || null,
        location ? location.trim() : null,
        JSON.stringify(fullFormData),
        finalPackagePrice > 0 ? finalPackagePrice : null,
        dpAmount > 0 ? dpAmount : null
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
      const msg = `📸 *Booking Baru (Jadiphoto.Moment) — DP Masuk!*\n\nKlien: *${booking.client_name}*\nNo. HP: ${booking.client_phone}\n\nBukti transfer sudah diupload dan menunggu verifikasi Anda.\n\nCek dashboard admin untuk approve/reject.`;
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

// GET /api/admin/bookings — daftar booking dengan filter
router.get('/admin/list', auth, async (req, res) => {
  const { category, status, month } = req.query;
  const params = [];
  const conditions = [];

  if (category) { params.push(category); conditions.push(`bc.slug = $${params.length}`); }
  if (status)   { params.push(status);   conditions.push(`b.status = $${params.length}`); }
  if (month)    {
    params.push(month + '-01');
    params.push(month + '-31');
    conditions.push(`b.event_date BETWEEN $${params.length - 1} AND $${params.length}`);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const { rows } = await db.query(
      `SELECT b.id, b.client_name, b.client_phone, b.event_date, b.event_time,
              b.location, b.form_data, b.package_price, b.dp_amount, b.status,
              b.created_at, b.session_id,
              b.google_event_id, b.calendar_sync_status,
              bc.name AS category_name, bc.slug AS category_slug, bc.color,
              (SELECT COUNT(*) FROM payments WHERE booking_id = b.id AND status = 'pending') AS pending_payments
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
});

// GET /api/admin/bookings/:id — detail booking (admin)
router.get('/admin/detail/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT b.*, bc.name AS category_name, bc.slug AS category_slug,
              bc.color, bc.dp_type, bc.dp_value, bc.fields AS category_fields
       FROM bookings b
       JOIN booking_categories bc ON b.category_id = bc.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Booking tidak ditemukan' });

    const booking = rows[0];
    const payRes = await db.query(
      `SELECT p.*, a.name AS approved_by_name
       FROM payments p
       LEFT JOIN admins a ON p.approved_by = a.id
       WHERE p.booking_id = $1 ORDER BY p.created_at DESC`,
      [booking.id]
    );
    booking.payments = payRes.rows;

    const attachRes = await db.query(
      `SELECT id, file_url, blob_key, file_name, file_type, mime_type, file_size, created_at
       FROM attachments
       WHERE booking_id = $1 ORDER BY created_at DESC`,
      [booking.id]
    );
    booking.attachments = attachRes.rows;

    res.json(booking);
  } catch (err) {
    console.error('[bookings] admin detail error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/admin/bookings/:id/set-price — set harga paket & dp_amount (legacy, kept for compat)
router.patch('/admin/:id/set-price', auth, async (req, res) => {
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
router.put('/admin/:id', auth, async (req, res) => {
  const { client_name, client_phone, event_date, event_time, location, package_price, form_data } = req.body;

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

    // Recalculate dp_amount if package_price changed
    let dpAmount = booking.dp_amount;
    const price = package_price != null ? parseFloat(package_price) : null;
    if (price != null && !isNaN(price) && price > 0) {
      if (booking.dp_type === 'percent') {
        dpAmount = (price * parseFloat(booking.dp_value)) / 100;
      } else {
        dpAmount = parseFloat(booking.dp_value);
      }
    }

    // If confirmed & date/time changed, check for slot conflicts
    const dateChanged = event_date !== (booking.event_date ? booking.event_date.toISOString().slice(0,10) : null);
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

    dbClient = await db.getClient();
    await dbClient.query('BEGIN');

    // Update booking
    await dbClient.query(
      `UPDATE bookings SET
         client_name   = $1,
         client_phone  = $2,
         event_date    = $3,
         event_time    = $4,
         location      = $5,
         package_price = COALESCE($6, package_price),
         dp_amount     = $7,
         form_data     = COALESCE($8, form_data)
       WHERE id = $9`,
      [
        client_name.trim(),
        client_phone.trim(),
        event_date,
        event_time || null,
        location || null,
        price || null,
        dpAmount,
        form_data ? JSON.stringify(form_data) : null,
        booking.id
      ]
    );

    // Sync pending payment amount if dp_amount changed
    if (price && price !== parseFloat(booking.package_price)) {
      await dbClient.query(
        `UPDATE payments SET amount = $1
         WHERE booking_id = $2 AND status = 'pending'`,
        [dpAmount, booking.id]
      );
    }

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
});

// PATCH /api/admin/bookings/:id/approve-dp — approve DP
router.patch('/admin/:id/approve-dp', auth, async (req, res) => {
  let client;
  try {
    const bookRes = await db.query(
      `SELECT b.id, b.client_name, b.client_phone, b.event_date, b.event_time, b.status, b.category_id, b.form_data, b.location, b.package_price, b.dp_amount,
              bc.time_slots, bc.wa_template
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
      `SELECT id FROM payments WHERE booking_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [booking.id]
    );

    client = await db.getClient();
    await client.query('BEGIN');

    // Update booking → confirmed
    await client.query(
      `UPDATE bookings SET status = 'confirmed' WHERE id = $1`,
      [booking.id]
    );

    // Update payment → approved
    if (payRes.rows[0]) {
      await client.query(
        `UPDATE payments SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2`,
        [req.admin.adminId, payRes.rows[0].id]
      );
    }

    await client.query('COMMIT');

    // Notifikasi WA ke klien
    let msg = buildTemplateMsg(booking, booking.wa_template);
    if (!msg) {
      const eventDateFmt = new Date(booking.event_date).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
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
router.patch('/admin/:id/reject-dp', auth, async (req, res) => {
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
      `UPDATE bookings SET status = 'pending_dp' WHERE id = $1`,
      [booking.id]
    );

    if (payRes.rows[0]) {
      await client.query(
        `UPDATE payments SET status = 'rejected', approved_by = $1, approved_at = now(), reject_reason = $2 WHERE id = $3`,
        [req.admin.adminId, reason || null, payRes.rows[0].id]
      );
    }

    await client.query('COMMIT');

    // Notifikasi WA ke klien
    const reasonText = reason ? `\n\nAlasan: _${reason}_` : '';
    const msg = `❌ *Bukti Transfer Ditolak*\n\nHalo ${booking.client_name},\n\nBukti transfer DP Anda tidak dapat diverifikasi.${reasonText}\n\nSilakan upload ulang bukti transfer yang valid. Terima kasih.`;
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

// PATCH /api/admin/bookings/:id/status — ubah status manual
router.patch('/admin/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  const VALID = ['pending_dp', 'dp_review', 'confirmed', 'completed', 'cancelled'];
  if (!VALID.includes(status)) return res.status(400).json({ error: 'Status tidak valid' });

  try {
    await db.query(`UPDATE bookings SET status = $1 WHERE id = $2`, [status, req.params.id]);
    res.json({ message: 'Status booking diperbarui', status });
  } catch (err) {
    console.error('[bookings] status update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/admin/bookings/:id/link-session — hubungkan ke sesi sortir
router.patch('/admin/:id/link-session', auth, async (req, res) => {
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
router.get('/admin/calendar', auth, async (req, res) => {
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
       WHERE b.status IN ('confirmed', 'dp_review', 'completed', 'pending_dp') ${dateFilter}
       ORDER BY b.event_date, b.event_time`,
      params
    );

    // Format untuk FullCalendar
    const STATUS_ALPHA = { confirmed: 'ff', dp_review: 'cc', completed: 'aa', pending_dp: '66' };
    const events = rows.map(r => {
      const dateStr = r.event_date.toISOString().slice(0, 10);
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
router.post('/admin/:id/sync-calendar', auth, async (req, res) => {
  try {
    // 1. Dapatkan token Google untuk admin ini
    const tokenRes = await db.query('SELECT * FROM google_oauth_tokens WHERE admin_id = $1', [req.admin.adminId]);
    if (!tokenRes.rows[0]) {
      return res.status(401).json({ error: 'Belum terhubung ke Google Calendar. Silakan hubungkan akun terlebih dahulu.' });
    }
    const tokenData = tokenRes.rows[0];

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expiry_date: new Date(tokenData.expires_at).getTime()
    });

    // Handle token refresh otomatis
    oauth2Client.on('tokens', async (tokens) => {
      if (tokens.refresh_token) {
        await db.query(
          'UPDATE google_oauth_tokens SET access_token = $1, refresh_token = $2, expires_at = $3 WHERE admin_id = $4',
          [tokens.access_token, tokens.refresh_token, new Date(tokens.expiry_date), req.admin.adminId]
        );
      } else {
        await db.query(
          'UPDATE google_oauth_tokens SET access_token = $1, expires_at = $2 WHERE admin_id = $3',
          [tokens.access_token, new Date(tokens.expiry_date), req.admin.adminId]
        );
      }
    });

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
    const dateStr = booking.event_date.toISOString().slice(0, 10);
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
    if (err.response && err.response.data && err.response.data.error) {
       errorMessage = err.response.data.error.message;
       if(err.code === 401 || err.code === 403) {
         errorMessage = 'Akses ditolak atau token kadaluarsa. Silakan hubungkan ulang akun Google Calendar Anda.';
         // Jika invalid_grant atau auth issue, hapus token agar user bisa reconnect
         if (err.message && err.message.includes('invalid_grant')) {
           await db.query('DELETE FROM google_oauth_tokens WHERE admin_id = $1', [req.admin.adminId]).catch(e => console.error(e));
         }
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
