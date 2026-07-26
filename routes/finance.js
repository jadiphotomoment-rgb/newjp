'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');
const https   = require('https');
const { buildTemplateMsg } = require('../utils/template');

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

// GET /api/finance/summary — ringkasan keuangan
router.get('/summary', auth, async (req, res) => {
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
      `SELECT p.*, b.status AS booking_status, b.id AS bid, b.client_name, b.client_phone, b.event_date, b.event_time, b.category_id, b.form_data, b.location, b.package_price, b.dp_amount, bc.time_slots, bc.wa_template
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
    const eventDateFmt = new Date(payment.event_date).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    let msg = `✅ *Pembayaran Disetujui!*\n\nHalo ${payment.client_name},\n\nPembayaran Anda sebesar Rp ${Number(payment.amount).toLocaleString('id-ID')} telah kami terima dan diverifikasi.`;
    if (payment.payment_type === 'dp' && payment.booking_status === 'dp_review') {
      const templateMsg = buildTemplateMsg(payment, payment.wa_template);
      if (templateMsg) {
        msg = templateMsg;
      } else {
        msg += `\n\nBooking Anda untuk tanggal *${eventDateFmt}* telah dikonfirmasi dan tanggal resmi terkunci.`;
        msg += `\n\nTerima kasih telah mempercayai layanan kami! 📸`;
      }
    } else {
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
      const msg = `❌ *Bukti Transfer Ditolak*\n\nHalo ${b.client_name},\n\nMohon maaf, bukti transfer pembayaran Anda tidak dapat diverifikasi.${reasonText}\n\nSilakan upload ulang bukti transfer yang valid. Terima kasih.`;
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

module.exports = router;
