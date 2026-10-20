'use strict';

const https = require('https');
const db = require('../database');
const audit = require('./audit');
const { hasPermission } = require('../constants/permissions');
const { getWaTemplate } = require('../utils/template');
const { buildPublicUrl } = require('../utils/url');

/**
 * Pengirim WhatsApp mentah via Fonnte API
 */
function sendWhatsAppApi(target, message) {
  return new Promise((resolve) => {
    const fonnteToken = process.env.FONNTE_TOKEN;
    if (!fonnteToken) {
      return resolve({ status: false, error: 'FONNTE_TOKEN tidak dikonfigurasi' });
    }

    const body = JSON.stringify({ target, message, countryCode: '62' });
    const options = {
      hostname: 'api.fonnte.com',
      path: '/send',
      method: 'POST',
      headers: {
        'Authorization': fonnteToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: res.statusCode >= 200 && res.statusCode < 300, data: parsed });
        } catch (_) {
          resolve({ status: res.statusCode >= 200 && res.statusCode < 300 });
        }
      });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ status: false, error: 'Timeout WA API' });
    });
    req.on('error', (err) => resolve({ status: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

/**
 * Worker / Dispatcher untuk mengirim pesan outbox WA setelah transaksi commit
 */
async function processOutboxQueue({ mockSend = false } = {}) {
  const client = await db.getClient();
  let processed = 0;
  try {
    const { rows: pendingItems } = await client.query(`
      SELECT id, phone, message, retries, tipe
      FROM wa_outbox
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    `);

    for (const item of pendingItems) {
      let isSuccess = false;
      let errMsg = null;

      if (mockSend) {
        isSuccess = true;
      } else {
        const sendRes = await sendWhatsAppApi(item.phone, item.message);
        isSuccess = sendRes.status;
        errMsg = sendRes.error || (sendRes.data && sendRes.data.reason) || null;
      }

      if (isSuccess) {
        await client.query(
          `UPDATE wa_outbox SET status = 'sent', sent_at = now() WHERE id = $1`,
          [item.id]
        );
      } else {
        await client.query(`
          UPDATE wa_outbox 
          SET retries = retries + 1,
              status = CASE WHEN retries + 1 >= 3 THEN 'failed' ELSE 'pending' END,
              last_error = $1
          WHERE id = $2
        `, [errMsg || 'Gagal mengirim pesan', item.id]);
      }
      processed++;
    }
  } catch (err) {
    console.error('[bookingApproval] Error processing outbox queue:', err);
  } finally {
    client.release();
  }
  return { processed };
}

/**
 * Layanan Inti: Approve Booking Langsung
 * Transaksi database atomik (SELECT FOR UPDATE, UPDATE payment, UPDATE booking, INSERT financial_entries, INSERT audit_log, INSERT wa_outbox)
 */
async function approveBooking({
  bookingId,
  expectedVersion,
  nominalDiterima,
  alasanSelisih,
  actor,
  req,
  _forceErrorBeforeCommit = false
}) {
  if (!actor || !actor.role) {
    throw Object.assign(new Error('Aktor pengguna tidak terdefinisi'), { status: 401 });
  }

  // 1. Cek Permission booking.approve (Owner implisit semua)
  if (!hasPermission(actor.role, 'booking.approve')) {
    throw Object.assign(
      new Error(`Akses ditolak: peran '${actor.role}' tidak memiliki izin 'booking.approve'`),
      { status: 403 }
    );
  }

  // 2. Proteksi Spesifikasi 2: Larang booking.approve masuk approval engine / rules
  const { rows: ruleCheck } = await db.query(
    "SELECT tipe FROM approval_rules WHERE tipe IN ('booking.approve', 'booking.approve_without_dp')"
  );
  if (ruleCheck.length > 0) {
    throw Object.assign(
      new Error('Pelanggaran keamanan: booking.approve dilarang diatur dalam approval_rules'),
      { status: 500 }
    );
  }

  const bId = parseInt(bookingId, 10);
  if (isNaN(bId) || bId <= 0) {
    throw Object.assign(new Error('ID Booking tidak valid'), { status: 400 });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 3. Lock row Booking FOR UPDATE
    const bookRes = await client.query(
      `SELECT id, client_name, client_phone, event_date, event_time, status, category_id,
              dp_amount, package_price, version, location
       FROM bookings
       WHERE id = $1
       FOR UPDATE`,
      [bId]
    );

    if (bookRes.rows.length === 0) {
      throw Object.assign(new Error('Booking tidak ditemukan'), { status: 404 });
    }
    const booking = bookRes.rows[0];

    // Cek Optimistic Concurrency Control (OCC)
    if (expectedVersion !== undefined && expectedVersion !== null) {
      if (Number(booking.version) !== Number(expectedVersion)) {
        throw Object.assign(
          new Error('Data telah diubah oleh pengguna lain. Silakan refresh.'),
          { status: 409 }
        );
      }
    }

    // Cek Status harus 'dp_review'
    if (booking.status !== 'dp_review') {
      throw Object.assign(
        new Error(`Status booking tidak dapat di-approve. Status saat ini: '${booking.status}'`),
        { status: 409 }
      );
    }

    // 4. Lock row Payment DP FOR UPDATE
    const payRes = await client.query(
      `SELECT id, amount, payment_type, proof_url, proof_filename, status, version
       FROM payments
       WHERE booking_id = $1 AND payment_type = 'dp'
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [booking.id]
    );
    const payment = payRes.rows[0] || null;

    // Spesifikasi 5: Approve tanpa bukti DP ditolak kecuali permission terpisah booking.approve_without_dp (default Owner)
    const hasProof = payment && payment.proof_url && payment.proof_url.trim().length > 0;
    if (!hasProof) {
      const canApproveWithoutDp = hasPermission(actor.role, 'booking.approve_without_dp');
      if (!canApproveWithoutDp) {
        throw Object.assign(
          new Error('Approve tanpa bukti pembayaran DP ditolak. Diperlukan izin khusus (booking.approve_without_dp).'),
          { status: 403 }
        );
      }
    }

    // 5. Validasi Nominal Diterima & Selisih
    const dpDiminta = Number(booking.dp_amount || 0);
    let nominalFinal;
    if (nominalDiterima !== undefined && nominalDiterima !== null) {
      nominalFinal = Math.round(Number(nominalDiterima));
      if (isNaN(nominalFinal) || nominalFinal < 0) {
        throw Object.assign(new Error('Nominal diterima tidak valid'), { status: 400 });
      }
    } else {
      nominalFinal = Math.round(Number(booking.dp_amount || (payment ? payment.amount : 0) || 0));
    }

    let anomali = false;
    let diffAmount = 0;
    if (dpDiminta > 0 && nominalFinal !== dpDiminta) {
      diffAmount = nominalFinal - dpDiminta;
      if (!alasanSelisih || !alasanSelisih.trim()) {
        throw Object.assign(
          new Error('Nominal diterima berbeda dari DP yang diminta. Wajib mengisi alasan selisih.'),
          { status: 400 }
        );
      }
      anomali = true;
    }

    // 6. Cek bentrok kalender sebagai PERINGATAN (tidak memblokir transaksi, Spesifikasi 8)
    let calendarWarning = null;
    if (booking.event_date && booking.event_time) {
      const conflictRes = await client.query(
        `SELECT id, client_name FROM bookings 
         WHERE event_date = $1 AND event_time = $2 AND status IN ('confirmed', 'completed') AND id != $3
         LIMIT 1`,
        [booking.event_date, booking.event_time, booking.id]
      );
      if (conflictRes.rows.length > 0) {
        calendarWarning = `Jadwal bentrok dengan booking confirmed #${conflictRes.rows[0].id} (${conflictRes.rows[0].client_name})`;
      }
    }

    // 7. Update Payment DP -> approved (WHERE status = 'pending')
    if (payment) {
      const payUpdate = await client.query(
        `UPDATE payments
         SET status = 'approved',
             amount = $1,
             approved_by = $2,
             approved_at = now(),
             updated_by = $2,
             version = version + 1
         WHERE id = $3 AND status = 'pending'`,
        [nominalFinal, actor.id, payment.id]
      );
      if (payUpdate.rowCount === 0) {
        throw Object.assign(new Error('Pembayaran DP sudah diproses sebelumnya'), { status: 409 });
      }
    }

    // 8. Update Booking -> confirmed (WHERE status = 'dp_review')
    const bookUpdate = await client.query(
      `UPDATE bookings
       SET status = 'confirmed',
           updated_by = $1,
           version = version + 1
       WHERE id = $2 AND status = 'dp_review'
       RETURNING id, client_name, client_phone, event_date, event_time, status, version, updated_by`,
      [actor.id, booking.id]
    );

    if (bookUpdate.rowCount === 0) {
      throw Object.assign(new Error('Booking sudah diproses oleh staf lain'), { status: 409 });
    }
    const updatedBooking = bookUpdate.rows[0];

    // 9. INSERT Entri Keuangan Idempoten (Unique index pada sumber_tipe + sumber_id untuk entri aktif)
    await client.query(
      `INSERT INTO financial_entries (
         tipe, kategori, nominal, sumber_tipe, sumber_id, status, catatan, created_by
       ) VALUES (
         'masuk', 'dp_booking', $1, 'booking_dp', $2, 'aktif', $3, $4
       )
       ON CONFLICT (sumber_tipe, sumber_id) WHERE status = 'aktif' DO NOTHING`,
      [nominalFinal, booking.id, alasanSelisih ? `Selisih DP: ${alasanSelisih}` : 'Penerimaan DP Booking', actor.id]
    );

    // 10. INSERT Audit Log Atomik
    await audit.record(client, {
      req,
      aktor_id: actor.id,
      aktor_role: actor.role,
      aksi: 'booking.approve',
      entitas: 'booking',
      entitas_id: booking.id,
      data_sebelum: {
        status: booking.status,
        version: booking.version
      },
      data_setelah: {
        status: 'confirmed',
        version: updatedBooking.version,
        nominal_diterima: nominalFinal,
        dp_diminta: dpDiminta,
        selisih: diffAmount,
        alasan_selisih: alasanSelisih || null,
        anomali,
        calendar_warning: calendarWarning
      }
    });

    // 11. INSERT Antrean WA Outbox
    if (booking.client_phone) {
      const eventDateFmt = new Date(booking.event_date).toLocaleDateString('id-ID', {
        day: 'numeric', month: 'long', year: 'numeric'
      });

      let msg = await getWaTemplate('booking_confirmed', {
        client_name: booking.client_name,
        event_date: eventDateFmt,
        event_time: booking.event_time ? booking.event_time.slice(0, 5) : '-',
        location: booking.location || '-',
        package_price: booking.package_price ? 'Rp ' + Number(booking.package_price).toLocaleString('id-ID') : '-',
        dp_amount: 'Rp ' + nominalFinal.toLocaleString('id-ID'),
      });

      if (!msg) {
        msg = `✅ *Booking Dikonfirmasi — Jadiphoto.Moment*\n\nHalo ${booking.client_name},\n\nBooking Anda untuk tanggal *${eventDateFmt}* telah kami konfirmasi. DP sebesar Rp ${nominalFinal.toLocaleString('id-ID')} telah diterima dan jadwal resmi terkunci.\n\nTerima kasih telah mempercayai Jadiphoto.Moment! 📸`;
      }

      await client.query(
        `INSERT INTO wa_outbox (phone, message, tipe, status, payload)
         VALUES ($1, $2, 'booking_confirmed', 'pending', $3)`,
        [booking.client_phone, msg, JSON.stringify({ booking_id: booking.id, client_name: booking.client_name })]
      );
    }

    // Uji Rollback Injection
    if (_forceErrorBeforeCommit) {
      throw new Error('forced_error_test: Rollback verification');
    }

    await client.query('COMMIT');

    // Worker Outbox WA dieksekusi SETELAH commit (tidak memblokir transaksi)
    setImmediate(() => {
      processOutboxQueue().catch(err => console.error('[outbox] Error dispatching queue:', err));
    });

    return {
      success: true,
      booking: updatedBooking,
      nominal_diterima: nominalFinal,
      anomali,
      calendar_warning: calendarWarning,
      message: 'Booking berhasil disetujui dan dikonfirmasi.'
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Layanan Inti: Reject Booking
 * Transaksi database atomik (UPDATE payment -> rejected, UPDATE booking -> dp_rejected, INSERT audit_log, INSERT wa_outbox)
 */
async function rejectBooking({
  bookingId,
  expectedVersion,
  alasan,
  actor,
  req
}) {
  if (!actor || !actor.role) {
    throw Object.assign(new Error('Aktor pengguna tidak terdefinisi'), { status: 401 });
  }

  if (!hasPermission(actor.role, 'booking.approve')) {
    throw Object.assign(
      new Error(`Akses ditolak: peran '${actor.role}' tidak memiliki izin 'booking.approve'`),
      { status: 403 }
    );
  }

  // Spesifikasi 6: Reject alasan wajib
  if (!alasan || !alasan.trim()) {
    throw Object.assign(new Error('Alasan penolakan DP wajib diisi.'), { status: 400 });
  }

  const bId = parseInt(bookingId, 10);
  if (isNaN(bId) || bId <= 0) {
    throw Object.assign(new Error('ID Booking tidak valid'), { status: 400 });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. Lock row Booking FOR UPDATE
    const bookRes = await client.query(
      `SELECT id, client_name, client_phone, status, version
       FROM bookings
       WHERE id = $1
       FOR UPDATE`,
      [bId]
    );

    if (bookRes.rows.length === 0) {
      throw Object.assign(new Error('Booking tidak ditemukan'), { status: 404 });
    }
    const booking = bookRes.rows[0];

    // Cek OCC
    if (expectedVersion !== undefined && expectedVersion !== null) {
      if (Number(booking.version) !== Number(expectedVersion)) {
        throw Object.assign(
          new Error('Data telah diubah oleh pengguna lain. Silakan refresh.'),
          { status: 409 }
        );
      }
    }

    if (booking.status !== 'dp_review') {
      throw Object.assign(
        new Error(`Status booking tidak dapat di-reject. Status saat ini: '${booking.status}'`),
        { status: 409 }
      );
    }

    // 2. Lock row Payment DP
    const payRes = await client.query(
      `SELECT id, version FROM payments
       WHERE booking_id = $1 AND payment_type = 'dp' AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [booking.id]
    );
    const payment = payRes.rows[0] || null;

    // 3. Update Payment DP -> rejected
    if (payment) {
      await client.query(
        `UPDATE payments
         SET status = 'rejected',
             reject_reason = $1,
             approved_by = $2,
             approved_at = now(),
             updated_by = $2,
             version = version + 1
         WHERE id = $3`,
        [alasan.trim(), actor.id, payment.id]
      );
    }

    // 4. Update Booking -> dp_rejected
    const bookUpdate = await client.query(
      `UPDATE bookings
       SET status = 'dp_rejected',
           updated_by = $1,
           version = version + 1
       WHERE id = $2 AND status = 'dp_review'
       RETURNING id, client_name, client_phone, status, version, updated_by`,
      [actor.id, booking.id]
    );

    if (bookUpdate.rowCount === 0) {
      throw Object.assign(new Error('Booking sudah diproses oleh staf lain'), { status: 409 });
    }
    const updatedBooking = bookUpdate.rows[0];

    // 5. INSERT Audit Log Atomik
    await audit.record(client, {
      req,
      aktor_id: actor.id,
      aktor_role: actor.role,
      aksi: 'booking.reject',
      entitas: 'booking',
      entitas_id: booking.id,
      data_sebelum: {
        status: booking.status,
        version: booking.version
      },
      data_setelah: {
        status: 'dp_rejected',
        version: updatedBooking.version,
        alasan: alasan.trim()
      }
    });

    // 6. INSERT Antrean WA Outbox
    if (booking.client_phone) {
      const uploadDpUrl = buildPublicUrl(`/upload-dp.html?booking=${booking.id}`);
      let msg = await getWaTemplate('dp_rejected', {
        client_name: booking.client_name,
        reason_text: `\n\nAlasan: _${alasan.trim()}_`,
        upload_dp_url: uploadDpUrl,
      });

      if (!msg) {
        msg = `❌ *Bukti Transfer DP Ditolak*\n\nHalo ${booking.client_name},\n\nBukti transfer DP Anda tidak dapat diverifikasi.\nAlasan: _${alasan.trim()}_\n\nSilakan upload ulang bukti transfer yang valid melalui tautan berikut:\n🔗 ${uploadDpUrl}\n\nTerima kasih.`;
      }

      await client.query(
        `INSERT INTO wa_outbox (phone, message, tipe, status, payload)
         VALUES ($1, $2, 'dp_rejected', 'pending', $3)`,
        [booking.client_phone, msg, JSON.stringify({ booking_id: booking.id, client_name: booking.client_name, alasan: alasan.trim() })]
      );
    }

    await client.query('COMMIT');

    // Trigger outbox SETELAH commit
    setImmediate(() => {
      processOutboxQueue().catch(err => console.error('[outbox] Error dispatching queue:', err));
    });

    return {
      success: true,
      booking: updatedBooking,
      alasan: alasan.trim(),
      message: 'DP berhasil ditolak. Klien diminta mengupload ulang bukti transfer.'
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  approveBooking,
  rejectBooking,
  processOutboxQueue
};
