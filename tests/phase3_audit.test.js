'use strict';

require('dotenv').config();
const db = require('../database');
const audit = require('../services/audit');

async function run() {
  console.log('--- [TEST FASE 3] Memulai Uji Layanan Audit Log ---');

  // Cari ID user owner untuk actor test
  const { rows: owners } = await db.query("SELECT id, role FROM users WHERE role = 'owner' LIMIT 1");
  if (owners.length === 0) {
    throw new Error('Tidak ada user owner di DB');
  }
  const testActor = { id: owners[0].id, role: owners[0].role };

  // 1. Uji Redaksi PII & Masking Nomor WA
  console.log('1. Menguji Redaksi PII & Masking Nomor WhatsApp...');
  const testData = {
    client_name: 'Budi Santoso',
    client_phone: '081234567890',
    password: 'secret_password_123',
    token: 'jwt_secret_token',
    notes: 'Booking foto wedding'
  };
  const sanitized = audit.sanitizeObject(testData);
  if (sanitized.password !== '[REDACTED]' || sanitized.token !== '[REDACTED]') {
    throw new Error(`Password/token tidak diredaksi: ${JSON.stringify(sanitized)}`);
  }
  if (sanitized.client_phone !== '0812****7890') {
    throw new Error(`Nomor telepon tidak dimasking dengan benar: ${sanitized.client_phone}`);
  }
  console.log('   ✅ Redaksi PII & masking WA sukses: ', sanitized.client_phone);

  // 2. Uji Perhitungan Diff (Hanya Field yang Berubah)
  console.log('2. Menguji Perhitungan Diff...');
  const beforeObj = { status: 'pending', package_price: 500000, client_name: 'Budi' };
  const afterObj  = { status: 'confirmed', package_price: 500000, client_name: 'Budi' };
  const { diffBefore, diffAfter } = audit.computeDiff(beforeObj, afterObj);

  if (diffBefore.status !== 'pending' || diffAfter.status !== 'confirmed') {
    throw new Error('Diff status gagal!');
  }
  if ('package_price' in diffBefore || 'client_name' in diffBefore) {
    throw new Error('Field yang tidak berubah seharusnya tidak masuk ke diff!');
  }
  console.log('   ✅ Perhitungan diff valid: hanya field berubah disimpan.');

  // 3. Uji Aksi Sukses = Tepat 1 Log
  console.log('3. Menguji Transaksi Sukses -> Tepat 1 Log...');
  const dummyBookingId = 999991;
  const dummyRequestId = 'req-test-' + Date.now();

  const countBeforeRes = await db.query(
    "SELECT COUNT(*) AS n FROM audit_log WHERE request_id = $1",
    [dummyRequestId]
  );
  const countBefore = parseInt(countBeforeRes.rows[0].n, 10);

  await audit.withAudit(async (tx, recordAudit) => {
    // Simulasi aksi domain
    await recordAudit({
      actor: testActor,
      aksi: 'booking.test_create',
      entitas: 'booking',
      entitas_id: dummyBookingId,
      sebelum: null,
      sesudah: { status: 'created', phone: '089876543210' },
      req: { requestId: dummyRequestId, ip: '127.0.0.1' }
    });
  });

  const countAfterRes = await db.query(
    "SELECT COUNT(*) AS n FROM audit_log WHERE request_id = $1",
    [dummyRequestId]
  );
  const countAfter = parseInt(countAfterRes.rows[0].n, 10);

  if (countAfter - countBefore !== 1) {
    throw new Error(`Transaksi sukses seharusnya menghasilkan 1 log, tapi bertambah ${countAfter - countBefore}`);
  }
  console.log('   ✅ Transaksi sukses mencatat tepat 1 baris audit log.');

  // 4. Uji Transaksi Gagal/Rollback = 0 Log
  console.log('4. Menguji Transaksi Gagal/Rollback -> 0 Log...');
  const failedRequestId = 'req-fail-' + Date.now();
  let errorCaught = false;

  try {
    await audit.withAudit(async (tx, recordAudit) => {
      // Catat log
      await recordAudit({
        actor: testActor,
        aksi: 'booking.test_fail',
        entitas: 'booking',
        entitas_id: dummyBookingId,
        sebelum: { status: 'pending' },
        sesudah: { status: 'cancelled' },
        req: { requestId: failedRequestId, ip: '127.0.0.1' }
      });

      // Sengaja lempar error untuk memicu ROLLBACK
      throw new Error('Simulasi kegagalan bisnis / database error');
    });
  } catch (err) {
    errorCaught = true;
  }

  if (!errorCaught) {
    throw new Error('Error yang dilempar harus ditangkap!');
  }

  const countFailRes = await db.query(
    "SELECT COUNT(*) AS n FROM audit_log WHERE request_id = $1",
    [failedRequestId]
  );
  const countFail = parseInt(countFailRes.rows[0].n, 10);

  if (countFail !== 0) {
    throw new Error(`Transaksi yang di-rollback seharusnya menghasilkan 0 log, tapi ditemukan: ${countFail}`);
  }
  console.log('   ✅ Transaksi yang di-rollback tidak meninggalkan baris log (0 log).');

  console.log('--- [TEST FASE 3] SELURUH UJI LAYANAN AUDIT LOG LULUS (100% SUKSES) ---');
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Uji Fase 3 Gagal:', err);
  process.exit(1);
});
