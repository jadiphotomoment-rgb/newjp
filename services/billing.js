'use strict';

const audit = require('./audit');

/**
 * Menghitung status tagihan terpusat (Single Source of Truth) dari ledger pembayaran
 * @param {object} q Database pool atau client transaksi
 * @param {number|string} bookingId
 * @returns {Promise<object>}
 */
async function computeBilling(q, bookingId) {
  if (!q || typeof q.query !== 'function') {
    throw new Error('Database client/pool (q) is required for computeBilling');
  }

  const bId = parseInt(bookingId, 10);

  // 1. Ambil data booking (package_price)
  const bookRes = await q.query(
    `SELECT id, package_price, paid_amount, status
     FROM bookings
     WHERE id = $1 AND deleted_at IS NULL`,
    [bId]
  );

  if (bookRes.rows.length === 0) {
    throw new Error(`Booking #${bId} tidak ditemukan`);
  }

  const booking = bookRes.rows[0];
  const total = booking.package_price != null ? Math.round(Number(booking.package_price)) : null;

  // 2. Ambil ledger payments (status 'approved') dikelompokkan berdasarkan payment_type
  const payRes = await q.query(
    `SELECT payment_type, COALESCE(SUM(amount), 0) AS total_amount
     FROM payments
     WHERE booking_id = $1 AND status = 'approved'
     GROUP BY payment_type`,
    [bId]
  );

  let dpPay = 0;
  let pelunasanPay = 0;
  let lainnyaPay = 0;

  for (const row of payRes.rows) {
    const amt = Math.round(Number(row.total_amount || 0));
    const pType = String(row.payment_type || '').toLowerCase();
    if (pType === 'dp') {
      dpPay += amt;
    } else if (pType === 'pelunasan') {
      pelunasanPay += amt;
    } else {
      lainnyaPay += amt;
    }
  }

  const paySum = dpPay + pelunasanPay + lainnyaPay;

  // 3. Ambil ledger penyesuaian Owner dari financial_entries (sumber_tipe = 'booking_adjustment', status = 'aktif')
  const adjRes = await q.query(
    `SELECT tipe, COALESCE(SUM(nominal), 0) AS total_nominal
     FROM financial_entries
     WHERE booking_id = $1 AND sumber_tipe = 'booking_adjustment' AND status = 'aktif'
     GROUP BY tipe`,
    [bId]
  );

  let masukAdj = 0;
  let keluarAdj = 0;

  for (const row of adjRes.rows) {
    const nom = Math.round(Number(row.total_nominal || 0));
    if (row.tipe === 'masuk') {
      masukAdj += nom;
    } else if (row.tipe === 'keluar') {
      keluarAdj += nom;
    }
  }

  const penyesuaian = masukAdj - keluarAdj;
  const paid = paySum + penyesuaian;

  const sisa = total == null ? null : Math.max(total - paid, 0);
  const kelebihan = total == null ? 0 : Math.max(paid - total, 0);

  let status_bayar = 'belum_bayar';
  if (paid <= 0) {
    status_bayar = 'belum_bayar';
  } else if (total != null && total > 0 && paid >= total) {
    status_bayar = 'lunas';
  } else {
    status_bayar = 'sebagian';
  }

  return {
    total,
    paid,
    sisa,
    kelebihan,
    status_bayar,
    rincian: {
      dp: dpPay,
      pelunasan: pelunasanPay,
      lainnya: lainnyaPay,
      penyesuaian
    }
  };
}

/**
 * Menyinkronkan cache booking dan tagihan aktif dengan ledger pembayaran
 * DILARANG membuka transaksi sendiri; client harus dalam transaksi aktif pemanggil.
 * @param {object} client DB Client dalam transaksi aktif
 * @param {number|string} bookingId
 * @param {number|string} userId
 * @returns {Promise<object>} Hasil computeBilling terbaru
 */
async function syncBilling(client, bookingId, userId) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('syncBilling requires an active database transaction client');
  }

  const bId = parseInt(bookingId, 10);
  const uId = userId ? parseInt(userId, 10) : null;

  // 1. Lock baris booking FOR UPDATE
  const lockRes = await client.query(
    `SELECT id, status, paid_amount, package_price, version
     FROM bookings
     WHERE id = $1 AND deleted_at IS NULL
     FOR UPDATE`,
    [bId]
  );

  if (lockRes.rows.length === 0) {
    throw new Error(`Booking #${bId} tidak ditemukan untuk sinkronisasi`);
  }

  const currentBooking = lockRes.rows[0];

  // 2. Hitung billing live
  const b = await computeBilling(client, bId);

  // 3. Terapkan aturan status booking (PRD Bagian 6)
  let newStatus = currentBooking.status;
  const total = b.total;
  const paid = b.paid;

  if (total != null && total > 0 && paid >= total) {
    if (['pending_dp', 'dp_review', 'confirmed', 'menunggu_pelunasan'].includes(currentBooking.status)) {
      newStatus = 'lunas';
    }
  } else if (paid === 0 && currentBooking.status === 'lunas') {
    newStatus = 'pending_dp';
  } else if (total != null && paid < total && currentBooking.status === 'lunas') {
    newStatus = 'confirmed';
  }

  // 4. Update cache bookings
  await client.query(
    `UPDATE bookings
     SET paid_amount = $1,
         status = $2,
         updated_by = $3,
         version = version + 1
     WHERE id = $4`,
    [b.paid, newStatus, uId, bId]
  );

  // 5. Update tagihan pelunasan aktif yang belum diunggah bukti ('sent', 'rejected')
  await client.query(
    `UPDATE pelunasan
     SET total_tagihan = $1,
         dp_terbayar = $2,
         sisa_kekurangan = $3
     WHERE booking_id = $4 AND status IN ('sent', 'rejected')`,
    [b.total != null ? b.total : 0, b.paid, b.sisa != null ? b.sisa : 0, bId]
  );

  // 6. Jika sisa == 0, batalkan tagihan aktif ('sent', 'rejected')
  if (b.sisa === 0) {
    await client.query(
      `UPDATE pelunasan
       SET status = 'cancelled',
           catatan = CASE 
             WHEN catatan IS NULL OR catatan = '' THEN 'Dibatalkan otomatis: tagihan sudah lunas'
             ELSE catatan || ' [Dibatalkan otomatis: tagihan sudah lunas]'
           END
       WHERE booking_id = $1 AND status IN ('sent', 'rejected')`,
      [bId]
    );
  }

  // 7. Catat audit log sinkronisasi
  await audit.record(client, {
    actor: { id: uId },
    aksi: 'billing.sync',
    entitas: 'booking',
    entitas_id: bId,
    sebelum: {
      paid_amount: currentBooking.paid_amount != null ? Number(currentBooking.paid_amount) : 0,
      status: currentBooking.status
    },
    sesudah: {
      paid_amount: b.paid,
      status: newStatus,
      total: b.total,
      sisa: b.sisa,
      status_bayar: b.status_bayar
    }
  });

  return b;
}

/**
 * Menetapkan jumlah dibayar dengan menuliskan selisih ke financial_entries (penyesuaian)
 * DILARANG membuka transaksi sendiri; client harus dalam transaksi aktif pemanggil.
 * @param {object} client DB Client dalam transaksi aktif
 * @param {number|string} bookingId
 * @param {number} targetPaid
 * @param {number|string} userId
 * @returns {Promise<object>} Hasil syncBilling terbaru
 */
async function setPaidAmount(client, bookingId, targetPaid, userId) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('setPaidAmount requires an active database transaction client');
  }

  const bId = parseInt(bookingId, 10);
  const uId = userId ? parseInt(userId, 10) : null;
  const newPaid = Math.round(Number(targetPaid));

  if (isNaN(newPaid) || newPaid < 0) {
    throw new Error('Jumlah dibayar tidak boleh negatif atau kosong');
  }

  // Lock booking terlebih dahulu
  const lockRes = await client.query(
    `SELECT id, client_name, package_price, paid_amount, status
     FROM bookings
     WHERE id = $1 AND deleted_at IS NULL
     FOR UPDATE`,
    [bId]
  );

  if (lockRes.rows.length === 0) {
    throw new Error(`Booking #${bId} tidak ditemukan`);
  }

  const booking = lockRes.rows[0];
  const price = booking.package_price != null ? Math.round(Number(booking.package_price)) : null;

  if (price != null && price > 0 && newPaid > price) {
    throw new Error(
      `Jumlah dibayar (Rp ${newPaid.toLocaleString('id-ID')}) tidak boleh melebihi total harga paket (Rp ${price.toLocaleString('id-ID')})`
    );
  }

  // Hitung selisih dari ledger live saat ini
  const currentBilling = await computeBilling(client, bId);
  const diff = newPaid - currentBilling.paid;

  if (diff !== 0) {
    const adjId = Date.now() + Math.floor(Math.random() * 1000);
    const isLunas = price != null && price > 0 && newPaid >= price;

    if (diff > 0) {
      await client.query(
        `INSERT INTO financial_entries (
           tanggal, tipe, kategori, nominal, source, booking_id,
           sumber_tipe, sumber_id, status, catatan, created_by, created_at
         ) VALUES (
           CURRENT_DATE, $1, $2, $3, 'booking', $4,
           'booking_adjustment', $5, 'aktif', $6, $7, now()
         )`,
        [
          'masuk',
          isLunas ? 'Pelunasan' : 'Pembayaran Booking',
          diff,
          bId,
          adjId,
          `Penyesuaian penambahan pembayaran booking #${bId} (${booking.client_name || ''})`,
          uId
        ]
      );
    } else {
      await client.query(
        `INSERT INTO financial_entries (
           tanggal, tipe, kategori, nominal, source, booking_id,
           sumber_tipe, sumber_id, status, catatan, created_by, created_at
         ) VALUES (
           CURRENT_DATE, $1, $2, $3, 'booking', $4,
           'booking_adjustment', $5, 'aktif', $6, $7, now()
         )`,
        [
          'keluar',
          'Koreksi Pembayaran',
          Math.abs(diff),
          bId,
          adjId,
          `Koreksi pengurangan pembayaran booking #${bId} (${booking.client_name || ''})`,
          uId
        ]
      );
    }

    await audit.record(client, {
      actor: { id: uId },
      aksi: 'billing.set_paid',
      entitas: 'booking',
      entitas_id: bId,
      sebelum: { paid_amount: currentBilling.paid },
      sesudah: { paid_amount: newPaid, diff }
    });
  }

  // Sinkronkan seluruh cache dan status booking & tagihan
  return await syncBilling(client, bId, uId);
}

module.exports = {
  computeBilling,
  syncBilling,
  setPaidAmount
};
