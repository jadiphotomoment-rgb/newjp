'use strict';

const cron = require('node-cron');
const db = require('../database');
const https = require('https');

// Reuse WA sender
function sendWhatsApp(target, message) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ target, message, countryCode: '62' });
    const options = {
      hostname: 'api.fonnte.com', path: '/send', method: 'POST',
      headers: {
        'Authorization': process.env.FONNTE_TOKEN || '',
        'Content-Type': 'application/json',
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

function initBookingCleaner() {
  // Run every hour at minute 0
  cron.schedule('0 * * * *', async () => {
    console.log('[cron] Memulai pengecekan booking kadaluarsa (pending > 24 jam)...');
    try {
      // Cari booking yang statusnya pending_dp dan sudah lewat 24 jam dari waktu pembuatan
      const { rows } = await db.query(
        `SELECT id, client_name, client_phone 
         FROM bookings 
         WHERE status = 'pending_dp' 
           AND created_at < NOW() - INTERVAL '24 hours'`
      );

      if (rows.length === 0) {
        console.log('[cron] Tidak ada booking yang kadaluarsa.');
        return;
      }

      console.log(`[cron] Ditemukan ${rows.length} booking kadaluarsa. Membatalkan...`);

      for (const booking of rows) {
        // Update status ke cancelled
        await db.query(
          `UPDATE bookings SET status = 'cancelled' WHERE id = $1`,
          [booking.id]
        );

        console.log(`[cron] Booking ID ${booking.id} (${booking.client_name}) dibatalkan.`);

        // Kirim WA notifikasi ke klien
        if (booking.client_phone) {
          const msg = `❌ *Booking Dibatalkan Otomatis*\n\nHalo ${booking.client_name},\n\nMohon maaf, booking Anda telah kami batalkan secara otomatis karena kami tidak menerima konfirmasi pembayaran DP dalam batas waktu 1x24 jam.\n\nJika Anda masih ingin melanjutkan sesi, silakan membuat booking ulang melalui website kami. Terima kasih.`;
          await sendWhatsApp(booking.client_phone, msg);
        }
      }

      console.log('[cron] Pengecekan selesai.');
    } catch (err) {
      console.error('[cron] Error saat menjalankan booking cleaner:', err);
    }
  });

  console.log('✅ Cron job Booking Cleaner (Auto-Cancel 24 jam) terdaftar.');
}

module.exports = { initBookingCleaner };
