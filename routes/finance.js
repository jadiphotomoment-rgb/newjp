'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');
const audit   = require('../services/audit');
const https   = require('https');
const { getWaTemplate } = require('../utils/template');
const { buildPublicUrl } = require('../utils/url');

// ── WhatsApp sender ──────────────────────────────────────────────
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

// Semua rute finance memerlukan autentikasi dan role Owner (finance.view & finance.manage)
router.use(auth);
router.use(auth.requireRole('owner'));
router.use(auth.requirePermission('finance.view'));

// GET /api/finance/summary — ringkasan keuangan
router.get('/summary', async (req, res) => {
  const { month, category } = req.query;

  try {
    // ── Total pemasukan keseluruhan (approved payments) ────────
    const totalRes = await db.query(
      `SELECT COALESCE(SUM(p.amount), 0) AS total_income,
              COUNT(*) AS total_payments
       FROM payments p
       JOIN bookings b ON p.booking_id = b.id
       WHERE p.status = 'approved'`
    );

    // ── Menunggu review ────────────────────────────────────────
    const pendingRes = await db.query(
      `SELECT COUNT(*) AS pending_count,
              COALESCE(SUM(p.amount), 0) AS pending_amount
       FROM payments p WHERE p.status = 'pending'`
    );

    // ── Total booking per status ───────────────────────────────
    const bookingStatsRes = await db.query(
      `SELECT status, COUNT(*) AS count FROM bookings GROUP BY status`
    );

    // ── Breakdown per kategori ─────────────────────────────────
    const byCategoryRes = await db.query(
      `SELECT bc.name AS category, bc.color,
              COUNT(b.id) AS booking_count,
              COALESCE(SUM(p.amount), 0) AS income
       FROM booking_categories bc
       LEFT JOIN bookings b ON b.category_id = bc.id
       LEFT JOIN payments p ON p.booking_id = b.id AND p.status = 'approved'
       GROUP BY bc.id, bc.name, bc.color
       ORDER BY bc.id`
    );

    // ── Breakdown per bulan (12 bulan terakhir) ────────────────
    const byMonthRes = await db.query(
      `SELECT TO_CHAR(p.created_at, 'YYYY-MM') AS month,
              COUNT(*) AS payment_count,
              COALESCE(SUM(p.amount), 0) AS income
       FROM payments p
       WHERE p.status = 'approved'
         AND p.created_at >= NOW() - INTERVAL '12 months'
       GROUP BY TO_CHAR(p.created_at, 'YYYY-MM')
       ORDER BY month`
    );

    // ── Bulan ini ──────────────────────────────────────────────
    const thisMonthRes = await db.query(
      `SELECT COALESCE(SUM(p.amount), 0) AS this_month_income
       FROM payments p
       WHERE p.status = 'approved'
         AND TO_CHAR(p.created_at, 'YYYY-MM') = TO_CHAR(NOW(), 'YYYY-MM')`
    );

    const bookingStatusMap = {};
    for (const row of bookingStatsRes.rows) {
      bookingStatusMap[row.status] = parseInt(row.count, 10);
    }

    res.json({
      totalIncome:     parseFloat(totalRes.rows[0].total_income),
      totalPayments:   parseInt(totalRes.rows[0].total_payments, 10),
      pendingCount:    parseInt(pendingRes.rows[0].pending_count, 10),
      pendingAmount:   parseFloat(pendingRes.rows[0].pending_amount),
      thisMonthIncome: parseFloat(thisMonthRes.rows[0].this_month_income),
      bookingStats:    bookingStatusMap,
      byCategory:      byCategoryRes.rows,
      byMonth:         byMonthRes.rows,
    });
  } catch (err) {
    console.error('[finance] summary error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/finance/payments — daftar pembayaran dengan filter
router.get('/payments', auth, async (req, res) => {
  const { status, category, month, limit = 50, offset = 0 } = req.query;
  const params = [];
  const conditions = [];

  if (status)   { params.push(status);   conditions.push(`p.status = $${params.length}`); }
  if (category) { params.push(category); conditions.push(`bc.slug = $${params.length}`); }
  if (month)    {
    params.push(month);
    conditions.push(`TO_CHAR(p.created_at, 'YYYY-MM') = $${params.length}`);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(parseInt(limit, 10));
  params.push(parseInt(offset, 10));

  try {
    const { rows } = await db.query(
      `SELECT p.id, p.booking_id, p.amount, p.payment_type, p.proof_url,
              p.proof_filename, p.status, p.reject_reason,
              p.approved_at, p.created_at,
              b.client_name, b.client_phone, b.event_date, b.package_price,
              bc.name AS category_name, bc.slug AS category_slug, bc.color,
              a.name AS approved_by_name
       FROM payments p
       JOIN bookings b ON p.booking_id = b.id
       JOIN booking_categories bc ON b.category_id = bc.id
       LEFT JOIN admins a ON p.approved_by = a.id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[finance] payments list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/finance/payments/:id/approve — approve pembayaran
router.patch('/payments/:id/approve', auth, async (req, res) => {
  let client;
  try {
    const payRes = await db.query(
      `SELECT p.*, b.status AS booking_status, b.id AS bid, b.client_name, b.client_phone, b.event_date, b.event_time, b.category_id, b.form_data, b.location, b.package_price, b.dp_amount, bc.time_slots
       FROM payments p 
       JOIN bookings b ON p.booking_id = b.id
       JOIN booking_categories bc ON b.category_id = bc.id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!payRes.rows[0]) return res.status(404).json({ error: 'Pembayaran tidak ditemukan' });
    const payment = payRes.rows[0];

    client = await db.getClient();
    await client.query('BEGIN');

    await client.query(
      `UPDATE payments SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2`,
      [req.admin.adminId, payment.id]
    );

    // Jika ini DP dan booking masih dp_review → konfirmasi booking
    if (payment.payment_type === 'dp' && payment.booking_status === 'dp_review') {
      // Cek bentrok kalender / kuota
      let isConflict = false;
      const timeSlots = payment.time_slots || [];
      if (timeSlots.length > 0 && payment.event_time) {
        const slotConfig = timeSlots.find(s => s.time === payment.event_time);
        if (slotConfig) {
          const quota = parseInt(slotConfig.quota, 10) || 1;
          const { rows: cRows } = await client.query(
            `SELECT COUNT(*) as count FROM bookings 
             WHERE category_id = $1 AND event_date = $2 AND event_time = $3 
               AND status IN ('confirmed', 'completed') AND id != $4`,
            [payment.category_id, payment.event_date, payment.event_time, payment.bid]
          );
          if (parseInt(cRows[0].count, 10) >= quota) {
            isConflict = true;
          }
        }
      } else {
        const conflictRes = await client.query(
          `SELECT id FROM bookings WHERE event_date = $1 AND event_time = $2 AND status = 'confirmed' AND id != $3`,
          [payment.event_date, payment.event_time, payment.bid]
        );
        if (conflictRes.rows.length > 0 && payment.event_time) {
          isConflict = true;
        }
      }

      if (isConflict) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Tanggal/Jam sudah dikunci oleh booking lain yang confirmed. Tidak bisa di-approve.' });
      }

      await client.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [payment.bid]);
    }

    await client.query('COMMIT');

    // Notifikasi WhatsApp
    let msg;
    if (payment.payment_type === 'dp' && payment.booking_status === 'dp_review') {
      const eventDateFmt = new Date(payment.event_date).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
      // Coba template dari DB (booking_confirmed)
      msg = await getWaTemplate('booking_confirmed', {
        client_name: payment.client_name,
        event_date: eventDateFmt,
        event_time: payment.event_time ? payment.event_time.slice(0, 5) : '-',
        location: payment.location || '-',
        package_price: payment.package_price ? 'Rp ' + Number(payment.package_price).toLocaleString('id-ID') : '-',
        dp_amount: payment.dp_amount ? 'Rp ' + Number(payment.dp_amount).toLocaleString('id-ID') : '-',
      });
      // Fallback
      if (!msg) {
        msg = `✅ *Pembayaran Disetujui!*\n\nHalo ${payment.client_name},\n\nPembayaran Anda sebesar Rp ${Number(payment.amount).toLocaleString('id-ID')} telah kami terima dan diverifikasi.`;
        msg += `\n\nBooking Anda untuk tanggal *${eventDateFmt}* telah dikonfirmasi dan tanggal resmi terkunci.`;
        msg += `\n\nTerima kasih telah mempercayai layanan kami! 📸`;
      }
    } else {
      msg = `✅ *Pembayaran Disetujui!*\n\nHalo ${payment.client_name},\n\nPembayaran Anda sebesar Rp ${Number(payment.amount).toLocaleString('id-ID')} telah kami terima dan diverifikasi.`;
      msg += `\n\nTerima kasih telah mempercayai layanan kami! 📸`;
    }
    
    if (payment.client_phone) sendWhatsApp(payment.client_phone, msg).catch(() => {});

    res.json({ message: 'Pembayaran disetujui' });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[finance] approve error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

// PATCH /api/finance/payments/:id/reject — reject pembayaran
router.patch('/payments/:id/reject', auth, async (req, res) => {
  const { reason } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE payments SET status = 'rejected', approved_by = $1, approved_at = now(), reject_reason = $2
       WHERE id = $3 RETURNING id, booking_id`,
      [req.admin.adminId, reason || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Pembayaran tidak ditemukan' });
    
    const payment = rows[0];
    // Fetch client info for WA notification
    const bookRes = await db.query(`SELECT client_name, client_phone FROM bookings WHERE id = $1`, [payment.booking_id]);
    
    if (bookRes.rows[0]) {
      const b = bookRes.rows[0];
      const reasonText = reason ? `\n\nAlasan: _${reason}_` : '';
      const uploadDpUrl = buildPublicUrl(`/upload-dp.html?booking=${b.id}`);
      
      // Coba template dari DB (dp_rejected)
      let msg = await getWaTemplate('dp_rejected', {
        client_name: b.client_name,
        reason_text: reasonText,
        upload_dp_url: uploadDpUrl,
      });
      
      if (!msg) {
        msg = `❌ *Bukti Transfer Ditolak*\n\nHalo ${b.client_name},\n\nMohon maaf, bukti transfer pembayaran Anda tidak dapat diverifikasi.${reasonText}\n\nSilakan upload ulang bukti transfer yang valid melalui link berikut:\n🔗 ${uploadDpUrl}\n\nTerima kasih.`;
      }
      
      if (b.client_phone) sendWhatsApp(b.client_phone, msg).catch(() => {});
    }

    res.json({ message: 'Pembayaran ditolak' });
  } catch (err) {
    console.error('[finance] reject error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/finance/export — download CSV laporan keuangan
router.get('/export', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.amount, p.payment_type, p.status, p.approved_at,
              b.client_name, b.client_phone, b.event_date,
              bc.name AS category_name
       FROM payments p
       JOIN bookings b ON p.booking_id = b.id
       JOIN booking_categories bc ON b.category_id = bc.id
       WHERE p.status = 'approved'
       ORDER BY p.approved_at DESC`
    );

    // Buat konten CSV secara manual
    let csvContent = "ID,Tanggal Approved,Klien,Telepon,Kategori,Tipe Pembayaran,Nominal\n";
    rows.forEach(r => {
      const date = r.approved_at ? r.approved_at.toISOString() : '';
      // Escape nama jika mengandung koma
      const name = `"${(r.client_name || '').replace(/"/g, '""')}"`;
      csvContent += `${r.id},${date},${name},${r.client_phone},${r.category_name},${r.payment_type},${r.amount}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="Laporan_Keuangan_Jadiphoto_Moment.csv"');
    res.send(csvContent);
  } catch (err) {
    console.error('[finance] export error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/finance/payments/:id — hapus data pembayaran (untuk data testing)
router.delete('/payments/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `DELETE FROM payments WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Pembayaran tidak ditemukan' });
    console.log(`[finance] Payment ${rows[0].id} deleted by admin ${req.admin.adminId}`);
    res.json({ message: 'Data pembayaran berhasil dihapus', id: rows[0].id });
  } catch (err) {
    console.error('[finance] delete payment error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Helper Sinkronisasi Booking Paid Amount ──────────────────────
async function recalculateBookingPaidAmount(client, bookingId) {
  if (!bookingId) return 0;
  const res = await client.query(
    `SELECT COALESCE(SUM(
       CASE WHEN tipe = 'masuk' THEN nominal
            WHEN tipe = 'keluar' THEN -nominal
            ELSE 0 END
     ), 0) AS total_paid
     FROM financial_entries
     WHERE booking_id = $1 AND deleted_at IS NULL AND status = 'aktif'`,
    [bookingId]
  );
  const totalPaid = Math.max(0, parseInt(res.rows[0].total_paid, 10) || 0);
  await client.query(
    `UPDATE bookings
     SET paid_amount = $1, version = version + 1
     WHERE id = $2`,
    [totalPaid, bookingId]
  );
  return totalPaid;
}

// ── CRUD TRANSAKSI KEUANGAN (financial_entries) ──────────────────

// GET /api/finance/transactions — list transaksi kas dengan filter & total rekap
router.get('/transactions', async (req, res) => {
  const { start_date, end_date, tipe, category, source, search, limit = 50, offset = 0 } = req.query;

  const conditions = ['fe.deleted_at IS NULL'];
  const params = [];

  if (start_date) {
    params.push(start_date);
    conditions.push(`fe.tanggal >= $${params.length}`);
  }
  if (end_date) {
    params.push(end_date);
    conditions.push(`fe.tanggal <= $${params.length}`);
  }
  if (tipe && tipe !== 'all') {
    const normTipe = tipe === 'pemasukan' ? 'masuk' : (tipe === 'pengeluaran' ? 'keluar' : tipe);
    params.push(normTipe);
    conditions.push(`fe.tipe = $${params.length}`);
  }
  if (category && category !== 'all' && category.trim() !== '') {
    params.push(category.trim());
    conditions.push(`fe.kategori = $${params.length}`);
  }
  if (source && source !== 'all') {
    params.push(source);
    conditions.push(`fe.source = $${params.length}`);
  }
  if (search && search.trim() !== '') {
    params.push(`%${search.trim()}%`);
    conditions.push(`(fe.catatan ILIKE $${params.length} OR fe.kategori ILIKE $${params.length} OR b.client_name ILIKE $${params.length})`);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    // 1. Rekap Total di Server (Pemasukan, Pengeluaran, Saldo)
    const summaryQuery = `
      SELECT
        COALESCE(SUM(CASE WHEN fe.tipe = 'masuk' THEN fe.nominal ELSE 0 END), 0) AS total_income,
        COALESCE(SUM(CASE WHEN fe.tipe = 'keluar' THEN fe.nominal ELSE 0 END), 0) AS total_expense,
        COUNT(fe.id) AS total_count
      FROM financial_entries fe
      LEFT JOIN bookings b ON fe.booking_id = b.id
      ${whereClause}
    `;
    const summaryRes = await db.query(summaryQuery, params);
    const totalIncome = parseInt(summaryRes.rows[0].total_income, 10) || 0;
    const totalExpense = parseInt(summaryRes.rows[0].total_expense, 10) || 0;
    const totalCount = parseInt(summaryRes.rows[0].total_count, 10) || 0;
    const balance = totalIncome - totalExpense;

    // 2. Data Transaksi
    const listParams = [...params];
    listParams.push(parseInt(limit, 10) || 50);
    listParams.push(parseInt(offset, 10) || 0);

    const listQuery = `
      SELECT
        fe.id,
        TO_CHAR(fe.tanggal, 'YYYY-MM-DD') AS tanggal,
        fe.tipe,
        fe.kategori,
        fe.nominal,
        fe.catatan,
        fe.catatan AS keterangan,
        fe.source,
        fe.booking_id,
        fe.status,
        fe.created_at,
        fe.created_by,
        u.nama AS created_by_name,
        b.client_name,
        b.client_phone
      FROM financial_entries fe
      LEFT JOIN users u ON fe.created_by = u.id
      LEFT JOIN bookings b ON fe.booking_id = b.id
      ${whereClause}
      ORDER BY fe.tanggal DESC, fe.id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;
    const { rows } = await db.query(listQuery, listParams);

    res.json({
      summary: {
        total_income: totalIncome,
        total_expense: totalExpense,
        balance,
        total_count: totalCount
      },
      transactions: rows
    });
  } catch (err) {
    console.error('[finance] transactions error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/finance/transactions — buat transaksi baru
router.post('/transactions', async (req, res) => {
  const { tanggal, tipe, kategori, nominal, keterangan, catatan, booking_id } = req.body;

  // Normalisasi tipe
  const rawTipe = (tipe || '').toLowerCase().trim();
  const normTipe = (rawTipe === 'pemasukan' || rawTipe === 'masuk') ? 'masuk' : ((rawTipe === 'pengeluaran' || rawTipe === 'keluar') ? 'keluar' : null);
  if (!normTipe) {
    return res.status(400).json({ error: 'Tipe transaksi harus masuk/pemasukan atau keluar/pengeluaran' });
  }

  // Validasi kategori
  const cleanKategori = (kategori || '').trim();
  if (!cleanKategori) {
    return res.status(400).json({ error: 'Kategori wajib diisi' });
  }

  // Validasi nominal (harus integer >= 0)
  const parsedNominal = parseInt(nominal, 10);
  if (isNaN(parsedNominal) || parsedNominal < 0) {
    return res.status(400).json({ error: 'Nominal harus berupa bilangan bulat positif (>= 0)' });
  }

  // Validasi tanggal
  const cleanTanggal = tanggal ? tanggal.trim() : new Date().toISOString().slice(0, 10);
  if (isNaN(new Date(cleanTanggal).getTime())) {
    return res.status(400).json({ error: 'Format tanggal tidak valid (YYYY-MM-DD)' });
  }

  const cleanKeterangan = (keterangan || catatan || '').trim();

  let client;
  try {
    let validBookingId = null;
    let bookingSource = 'manual';

    if (booking_id !== undefined && booking_id !== null && booking_id !== '') {
      validBookingId = parseInt(booking_id, 10);
      if (isNaN(validBookingId)) {
        return res.status(400).json({ error: 'Booking ID tidak valid' });
      }
      const bRes = await db.query('SELECT id, client_name, package_price FROM bookings WHERE id = $1 AND deleted_at IS NULL', [validBookingId]);
      if (!bRes.rows[0]) {
        return res.status(404).json({ error: 'Booking tidak ditemukan atau telah dihapus' });
      }
      bookingSource = 'booking';
    }

    client = await db.getClient();
    await client.query('BEGIN');

    const insertRes = await client.query(
      `INSERT INTO financial_entries (
         tanggal, tipe, kategori, nominal, catatan, source, booking_id,
         sumber_tipe, sumber_id, status, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, 'aktif', $10
       )
       RETURNING *`,
      [
        cleanTanggal,
        normTipe,
        cleanKategori,
        parsedNominal,
        cleanKeterangan || null,
        bookingSource,
        validBookingId,
        validBookingId ? 'booking_manual' : 'manual',
        validBookingId || 0,
        req.user.id
      ]
    );
    const newEntry = insertRes.rows[0];

    // Jika terkait booking, hitung ulang total paid booking
    if (validBookingId) {
      await recalculateBookingPaidAmount(client, validBookingId);
    }

    await audit.record(client, {
      req,
      aksi: 'finance.transaction_create',
      entitas: 'financial_entry',
      entitas_id: newEntry.id,
      data_setelah: {
        id: newEntry.id,
        tanggal: cleanTanggal,
        tipe: normTipe,
        kategori: cleanKategori,
        nominal: parsedNominal,
        source: bookingSource,
        booking_id: validBookingId
      }
    });

    await client.query('COMMIT');
    res.status(201).json({ message: 'Transaksi berhasil ditambahkan', transaction: newEntry });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[finance] create transaction error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

// GET /api/finance/transactions/:id — detail transaksi
router.get('/transactions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID transaksi tidak valid' });

  try {
    const { rows } = await db.query(
      `SELECT fe.*,
              TO_CHAR(fe.tanggal, 'YYYY-MM-DD') AS tanggal,
              fe.catatan AS keterangan,
              u.nama AS created_by_name,
              b.client_name, b.client_phone
       FROM financial_entries fe
       LEFT JOIN users u ON fe.created_by = u.id
       LEFT JOIN bookings b ON fe.booking_id = b.id
       WHERE fe.id = $1 AND fe.deleted_at IS NULL`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[finance] get transaction error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/finance/transactions/:id — update transaksi
router.put('/transactions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID transaksi tidak valid' });

  const { tanggal, tipe, kategori, nominal, keterangan, catatan } = req.body;

  let client;
  try {
    const curRes = await db.query('SELECT * FROM financial_entries WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!curRes.rows[0]) return res.status(404).json({ error: 'Transaksi tidak ditemukan atau telah dihapus' });
    const current = curRes.rows[0];

    // Normalisasi & validasi
    let updatedTipe = current.tipe;
    if (tipe !== undefined) {
      const raw = tipe.toLowerCase().trim();
      const norm = (raw === 'pemasukan' || raw === 'masuk') ? 'masuk' : ((raw === 'pengeluaran' || raw === 'keluar') ? 'keluar' : null);
      if (!norm) return res.status(400).json({ error: 'Tipe transaksi harus masuk/pemasukan atau keluar/pengeluaran' });
      updatedTipe = norm;
    }

    let updatedNominal = current.nominal;
    if (nominal !== undefined) {
      const pNom = parseInt(nominal, 10);
      if (isNaN(pNom) || pNom < 0) return res.status(400).json({ error: 'Nominal harus bilangan bulat positif (>= 0)' });
      updatedNominal = pNom;
    }

    let updatedTanggal = current.tanggal;
    if (tanggal !== undefined) {
      if (isNaN(new Date(tanggal).getTime())) return res.status(400).json({ error: 'Format tanggal tidak valid' });
      updatedTanggal = tanggal;
    }

    const updatedKategori = (kategori !== undefined ? kategori : current.kategori).trim();
    if (!updatedKategori) return res.status(400).json({ error: 'Kategori tidak boleh kosong' });

    const updatedKeterangan = (keterangan !== undefined || catatan !== undefined) ? (keterangan || catatan || '').trim() : current.catatan;

    client = await db.getClient();
    await client.query('BEGIN');

    const updateRes = await client.query(
      `UPDATE financial_entries
       SET tanggal = $1,
           tipe = $2,
           kategori = $3,
           nominal = $4,
           catatan = $5,
           updated_by = $6,
           updated_at = now()
       WHERE id = $7
       RETURNING *`,
      [
        updatedTanggal,
        updatedTipe,
        updatedKategori,
        updatedNominal,
        updatedKeterangan,
        req.user.id,
        id
      ]
    );
    const updated = updateRes.rows[0];

    // Jika terkait booking, hitung ulang total dibayar booking
    if (current.booking_id) {
      await recalculateBookingPaidAmount(client, current.booking_id);
    }

    await audit.record(client, {
      req,
      aksi: 'finance.transaction_update',
      entitas: 'financial_entry',
      entitas_id: id,
      data_sebelum: {
        tanggal: current.tanggal,
        tipe: current.tipe,
        kategori: current.kategori,
        nominal: current.nominal,
        catatan: current.catatan
      },
      data_setelah: {
        tanggal: updated.tanggal,
        tipe: updated.tipe,
        kategori: updated.kategori,
        nominal: updated.nominal,
        catatan: updated.catatan
      }
    });

    await client.query('COMMIT');
    res.json({ message: 'Transaksi berhasil diperbarui', transaction: updated });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[finance] update transaction error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

// DELETE /api/finance/transactions/:id — soft delete transaksi
router.delete('/transactions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID transaksi tidak valid' });

  let client;
  try {
    const curRes = await db.query('SELECT * FROM financial_entries WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!curRes.rows[0]) return res.status(404).json({ error: 'Transaksi tidak ditemukan atau sudah dihapus' });
    const current = curRes.rows[0];

    client = await db.getClient();
    await client.query('BEGIN');

    await client.query(
      `UPDATE financial_entries
       SET deleted_at = now(),
           status = 'batal',
           updated_by = $1,
           updated_at = now()
       WHERE id = $2`,
      [req.user.id, id]
    );

    // Jika terkait booking, hitung ulang total dibayar booking
    if (current.booking_id) {
      await recalculateBookingPaidAmount(client, current.booking_id);
    }

    await audit.record(client, {
      req,
      aksi: 'finance.transaction_delete',
      entitas: 'financial_entry',
      entitas_id: id,
      data_sebelum: {
        id: current.id,
        tipe: current.tipe,
        nominal: current.nominal,
        status: current.status,
        deleted_at: null
      },
      data_setelah: {
        status: 'batal',
        deleted_at: new Date()
      }
    });

    await client.query('COMMIT');
    res.json({ message: 'Transaksi berhasil dihapus (soft delete)', id });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[finance] delete transaction error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;

