'use strict';

require('dotenv').config();
const assert = require('assert');
const db = require('../database');
const { approveBooking, rejectBooking, processOutboxQueue } = require('../services/bookingApproval');

async function cleanTestData(bookingIds = [], userIds = []) {
  if (bookingIds.length > 0) {
    await db.query('DELETE FROM wa_outbox WHERE payload->>\'booking_id\' = ANY($1::text[])', [bookingIds.map(String)]);
    await db.query('DELETE FROM financial_entries WHERE sumber_id = ANY($1::bigint[]) AND sumber_tipe = \'booking_dp\'', [bookingIds]);
    // audit_log tidak di-DELETE karena dilindungi trigger append-only audit_log_immutable
    await db.query('DELETE FROM payments WHERE booking_id = ANY($1::int[])', [bookingIds]);
    await db.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [bookingIds]);
  }
  if (userIds.length > 0) {
    await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  }
}



async function createTestBooking({ withProof = true, dpAmount = 100000, status = 'dp_review' } = {}) {
  // Ambil kategori pertama
  const catRes = await db.query('SELECT id FROM booking_categories LIMIT 1');
  const categoryId = catRes.rows[0]?.id || 1;

  // Insert booking
  const bookRes = await db.query(`
    INSERT INTO bookings (
      category_id, client_name, client_phone, event_date, event_time,
      location, package_price, dp_amount, status, version
    ) VALUES (
      $1, 'Klien Uji Fase 2', '081234567890', CURRENT_DATE + INTERVAL '5 days', '10:00',
      'Studio A', 500000, $2, $3, 1
    ) RETURNING *
  `, [categoryId, dpAmount, status]);
  const booking = bookRes.rows[0];

  // Insert payment jika ada
  let payment = null;
  if (withProof) {
    const payRes = await db.query(`
      INSERT INTO payments (
        booking_id, amount, payment_type, proof_url, proof_filename, status, version
      ) VALUES (
        $1, $2, 'dp', 'https://example.com/proof.jpg', 'proof.jpg', 'pending', 1
      ) RETURNING *
    `, [booking.id, dpAmount]);
    payment = payRes.rows[0];
  }

  return { booking, payment };
}

async function runTests() {
  console.log('=== [TEST FASE 2] Service Approve & Reject Booking Langsung ===\n');
  const createdBookingIds = [];
  const createdUserIds = [];

  const ts = Date.now();
  const { rows: [staffUser] } = await db.query(
    `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
     VALUES ('Staff Uji F2', $1, 'hash_test', 'staff', true, false)
     RETURNING id, role, nama`,
    [`staff_f2_${ts}@test.com`]
  );
  createdUserIds.push(staffUser.id);

  const { rows: [ownerUser] } = await db.query(
    `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
     VALUES ('Owner Uji F2', $1, 'hash_test', 'owner', true, false)
     RETURNING id, role, nama`,
    [`owner_f2_${ts}@test.com`]
  );
  createdUserIds.push(ownerUser.id);

  const unauthorizedUser = { id: 997, role: 'viewer', nama: 'Viewer Uji' };


  try {
    // ── 1. Uji Otorisasi User Tanpa Izin ─────────────────────────
    console.log('1. Uji otorisasi aktor tanpa permission...');
    const { booking: b0 } = await createTestBooking();
    createdBookingIds.push(b0.id);

    await assert.rejects(
      async () => {
        await approveBooking({
          bookingId: b0.id,
          expectedVersion: b0.version,
          actor: unauthorizedUser
        });
      },
      (err) => {
        assert.strictEqual(err.status, 403, 'Harus melempar 403 Forbidden');
        return true;
      },
      'User tanpa izin booking.approve harus ditolak 403'
    );
    console.log('   ✅ Aktor tanpa izin berhasil ditolak (403).');

    // ── 2. Uji Sukses Penuh oleh Staff ───────────────────────────
    console.log('2. Uji approve langsung sukses penuh oleh Staff...');
    const { booking: b1, payment: p1 } = await createTestBooking();
    createdBookingIds.push(b1.id);

    const approveRes = await approveBooking({
      bookingId: b1.id,
      expectedVersion: b1.version,
      actor: staffUser
    });

    assert.strictEqual(approveRes.success, true, 'Respon harus sukses');
    assert.strictEqual(approveRes.booking.status, 'confirmed', 'Status booking harus confirmed');
    assert.strictEqual(approveRes.booking.version, b1.version + 1, 'Version booking harus bertambah 1');
    assert.strictEqual(approveRes.booking.updated_by, staffUser.id, 'updated_by harus ID staf');

    // Cek di database
    const { rows: b1Rows } = await db.query('SELECT status, version, updated_by FROM bookings WHERE id = $1', [b1.id]);
    assert.strictEqual(b1Rows[0].status, 'confirmed');
    assert.strictEqual(b1Rows[0].version, 2);

    const { rows: p1Rows } = await db.query('SELECT status, approved_by FROM payments WHERE id = $1', [p1.id]);
    assert.strictEqual(p1Rows[0].status, 'approved');
    assert.strictEqual(p1Rows[0].approved_by, staffUser.id);

    // Cek entri keuangan idempoten
    const { rows: finRows } = await db.query(
      'SELECT nominal, status, sumber_tipe, sumber_id FROM financial_entries WHERE sumber_tipe = \'booking_dp\' AND sumber_id = $1',
      [b1.id]
    );
    assert.strictEqual(finRows.length, 1, 'Harus ada tepat 1 entri keuangan');
    assert.strictEqual(Number(finRows[0].nominal), 100000);
    assert.strictEqual(finRows[0].status, 'aktif');

    // Cek audit log
    const { rows: auditRows } = await db.query(
      'SELECT actor_id, aksi, entitas, entitas_id FROM audit_log WHERE entitas = \'booking\' AND entitas_id = $1',
      [b1.id]
    );
    assert.strictEqual(auditRows.length, 1, 'Harus ada 1 baris audit log');
    assert.strictEqual(auditRows[0].aksi, 'booking.approve');

    // Cek antrean outbox WA
    const { rows: outboxRows } = await db.query(
      'SELECT phone, status, tipe FROM wa_outbox WHERE payload->>\'booking_id\' = $1',
      [String(b1.id)]
    );
    assert.strictEqual(outboxRows.length, 1, 'Pesan WA harus masuk ke antrean wa_outbox');
    assert.strictEqual(outboxRows[0].tipe, 'booking_confirmed');

    console.log('   ✅ Staff sukses approve booking: status confirmed, version +1, entri keuangan aktif, audit log tercatat, outbox WA dibuat.');

    // ── 3. Uji Approve Tanpa Bukti DP ────────────────────────────
    console.log('3. Uji approve booking tanpa bukti DP...');
    const { booking: b2 } = await createTestBooking({ withProof: false });
    createdBookingIds.push(b2.id);

    // Staff harus ditolak karena tidak memiliki booking.approve_without_dp
    await assert.rejects(
      async () => {
        await approveBooking({
          bookingId: b2.id,
          expectedVersion: b2.version,
          actor: staffUser
        });
      },
      (err) => {
        assert.ok(err.status === 400 || err.status === 403, 'Harus ditolak error 400/403');
        assert.match(err.message, /bukti/i, 'Pesan error harus menyebut bukti transfer');
        return true;
      },
      'Staff tidak boleh approve booking tanpa bukti transfer'
    );

    // Owner harus berhasil karena memiliki booking.approve_without_dp
    const ownerRes = await approveBooking({
      bookingId: b2.id,
      expectedVersion: b2.version,
      actor: ownerUser
    });
    assert.strictEqual(ownerRes.success, true);
    assert.strictEqual(ownerRes.booking.status, 'confirmed');
    console.log('   ✅ Approve tanpa bukti DP ditolak untuk Staff, tapi diizinkan untuk Owner.');

    // ── 4. Uji Selisih Nominal Tanpa Alasan Ditolak ───────────────
    console.log('4. Uji selisih nominal diterima vs diminta...');
    const { booking: b3 } = await createTestBooking({ dpAmount: 100000 });
    createdBookingIds.push(b3.id);

    // Beda nominal tanpa alasan -> wajib ditolak
    await assert.rejects(
      async () => {
        await approveBooking({
          bookingId: b3.id,
          expectedVersion: b3.version,
          nominalDiterima: 80000,
          actor: staffUser
        });
      },
      (err) => {
        assert.strictEqual(err.status, 400);
        assert.match(err.message, /alasan/i);
        return true;
      },
      'Selisih nominal tanpa alasan harus ditolak 400'
    );

    // Beda nominal dengan alasan -> sukses dan ditandai anomali
    const diffRes = await approveBooking({
      bookingId: b3.id,
      expectedVersion: b3.version,
      nominalDiterima: 80000,
      alasanSelisih: 'Diskon khusus klien setia',
      actor: staffUser
    });
    assert.strictEqual(diffRes.success, true);
    assert.strictEqual(diffRes.anomali, true);

    const { rows: b3Audit } = await db.query(
      'SELECT sesudah FROM audit_log WHERE entitas = \'booking\' AND entitas_id = $1 ORDER BY id DESC LIMIT 1',
      [b3.id]
    );
    assert.strictEqual(b3Audit[0].sesudah.anomali, true, 'Audit log harus mencatat anomali: true');
    assert.strictEqual(b3Audit[0].sesudah.alasan_selisih, 'Diskon khusus klien setia');
    console.log('   ✅ Nominal berbeda tanpa alasan ditolak; dengan alasan diterima dan ditandai anomali di audit.');

    // ── 5. Uji Optimistic Locking (OCC) Versi Usang ───────────────
    console.log('5. Uji OCC versi usang ditolak (409 Conflict)...');
    const { booking: b4 } = await createTestBooking();
    createdBookingIds.push(b4.id);

    await assert.rejects(
      async () => {
        await approveBooking({
          bookingId: b4.id,
          expectedVersion: 999, // Versi salah
          actor: staffUser
        });
      },
      (err) => {
        assert.strictEqual(err.status, 409);
        return true;
      },
      'Versi mismatch harus menghasilkan 409 Conflict'
    );
    console.log('   ✅ Versi usang berhasil ditolak dengan HTTP 409 Conflict.');

    // ── 6. Uji Concurrency (2 Approve Bersamaan) ─────────────────
    console.log('6. Uji Concurrency: 2 Approve Bersamaan pada Booking yang Sama...');
    const { booking: b5 } = await createTestBooking();
    createdBookingIds.push(b5.id);

    const results = await Promise.allSettled([
      approveBooking({ bookingId: b5.id, expectedVersion: b5.version, actor: staffUser }),
      approveBooking({ bookingId: b5.id, expectedVersion: b5.version, actor: staffUser })
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.strictEqual(fulfilled.length, 1, 'Tepat 1 approve harus berhasil');
    assert.strictEqual(rejected.length, 1, 'Tepat 1 approve harus gagal konflik');

    // Pastikan di DB entri keuangan tepat 1
    const { rows: b5Fin } = await db.query(
      'SELECT id FROM financial_entries WHERE sumber_tipe = \'booking_dp\' AND sumber_id = $1 AND status = \'aktif\'',
      [b5.id]
    );
    assert.strictEqual(b5Fin.length, 1, 'Entri keuangan tepat 1 baris (idempoten)');
    console.log('   ✅ Concurrency aman: 1 berhasil, 1 gagal, entri keuangan tepat 1.');

    // ── 7. Uji Rollback Atomik ────────────────────────────────────
    console.log('7. Uji Rollback Atomik jika terjadi kesalahan...');
    const { booking: b6 } = await createTestBooking();
    createdBookingIds.push(b6.id);

    // Panggil dengan simpanan custom untuk memaksa error setelah update tapi sebelum commit
    await assert.rejects(
      async () => {
        await approveBooking({
          bookingId: b6.id,
          expectedVersion: b6.version,
          actor: staffUser,
          _forceErrorBeforeCommit: true
        });
      },
      (err) => {
        assert.match(err.message, /forced_error_test/i);
        return true;
      }
    );

    // Verifikasi booking di database MASIH status dp_review
    const { rows: b6Check } = await db.query('SELECT status, version FROM bookings WHERE id = $1', [b6.id]);
    assert.strictEqual(b6Check[0].status, 'dp_review', 'Status booking harus tetap dp_review');
    assert.strictEqual(b6Check[0].version, 1, 'Version booking tidak boleh bertambah');

    // Verifikasi financial_entries dan outbox KOSONG
    const { rows: b6Fin } = await db.query('SELECT id FROM financial_entries WHERE sumber_id = $1', [b6.id]);
    assert.strictEqual(b6Fin.length, 0, 'financial_entries harus 0');

    const { rows: b6Outbox } = await db.query('SELECT id FROM wa_outbox WHERE payload->>\'booking_id\' = $1', [String(b6.id)]);
    assert.strictEqual(b6Outbox.length, 0, 'wa_outbox harus 0');
    console.log('   ✅ Rollback atomik sukses: tidak ada data yang berubah saat error.');

    // ── 8. Uji Reject Booking ────────────────────────────────────
    console.log('8. Uji rejectBooking dengan alasan wajib...');
    const { booking: b7, payment: p7 } = await createTestBooking();
    createdBookingIds.push(b7.id);

    // Reject tanpa alasan -> wajib ditolak 400
    await assert.rejects(
      async () => {
        await rejectBooking({
          bookingId: b7.id,
          expectedVersion: b7.version,
          alasan: '',
          actor: staffUser
        });
      },
      (err) => {
        assert.strictEqual(err.status, 400);
        return true;
      },
      'Reject tanpa alasan harus ditolak 400'
    );

    // Reject dengan alasan valid
    const rejectRes = await rejectBooking({
      bookingId: b7.id,
      expectedVersion: b7.version,
      alasan: 'Bukti transfer buram/tidak terbaca',
      actor: staffUser
    });

    assert.strictEqual(rejectRes.success, true);
    assert.strictEqual(rejectRes.booking.status, 'dp_rejected');

    const { rows: b7Db } = await db.query('SELECT status FROM bookings WHERE id = $1', [b7.id]);
    assert.strictEqual(b7Db[0].status, 'dp_rejected');

    const { rows: p7Db } = await db.query('SELECT status, reject_reason FROM payments WHERE id = $1', [p7.id]);
    assert.strictEqual(p7Db[0].status, 'rejected');
    assert.strictEqual(p7Db[0].reject_reason, 'Bukti transfer buram/tidak terbaca');

    const { rows: b7Outbox } = await db.query('SELECT tipe FROM wa_outbox WHERE payload->>\'booking_id\' = $1', [String(b7.id)]);
    assert.strictEqual(b7Outbox[0].tipe, 'dp_rejected');
    console.log('   ✅ Reject booking sukses: status dp_rejected, alasan tersimpan, outbox WA dibuat.');

    // ── 9. Uji Worker Outbox Queue ───────────────────────────────
    console.log('9. Uji pemrosesan worker antrean WA outbox...');
    await db.query(`
      INSERT INTO wa_outbox (phone, message, tipe, status, payload)
      VALUES ('081299998888', 'Pesan Uji Outbox Worker', 'test_message', 'pending', $1)
    `, [JSON.stringify({ booking_id: b1.id })]);

    const workerRes = await processOutboxQueue({ mockSend: true });
    assert.ok(workerRes.processed >= 1, 'Worker harus memproses setidaknya 1 pesan outbox');

    const { rows: testMsgRows } = await db.query(
      'SELECT status, sent_at FROM wa_outbox WHERE phone = \'081299998888\' ORDER BY id DESC LIMIT 1'
    );
    assert.strictEqual(testMsgRows[0].status, 'sent', 'Status outbox harus berubah menjadi sent');
    assert.ok(testMsgRows[0].sent_at !== null, 'sent_at harus terisi');
    console.log(`   ✅ Worker outbox sukses memproses ${workerRes.processed} pesan dan mengubah status menjadi 'sent'.`);


    console.log('\n=== SEMUA UJI FASE 2 LULUS (100% SUKSES) ===');
  } finally {
    await cleanTestData(createdBookingIds, createdUserIds);
    await db.pool.end();
  }

}

if (require.main === module) {
  runTests().then(() => process.exit(0)).catch((err) => {
    console.error('❌ UJI FASE 2 GAGAL:', err);
    process.exit(1);
  });
}
