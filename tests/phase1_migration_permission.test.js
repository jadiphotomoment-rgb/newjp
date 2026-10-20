'use strict';

require('dotenv').config();
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { hasPermission, getPermissionsForRole } = require('../constants/permissions');
const { requirePermission } = require('../middleware/auth');

async function runSqlFile(client, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  await client.query(sql);
}

async function runTests() {
  console.log('=== [TEST FASE 1] Pengujian Permission & Migrasi Database ===\n');

  // ── 1. Uji Matriks Permission ─────────────────────────────────
  console.log('1. Menguji Matriks Hak Akses & Permission...');
  
  // Owner implisit semua permission
  assert.strictEqual(hasPermission('owner', 'booking.approve'), true, 'Owner harus memiliki booking.approve');
  assert.strictEqual(hasPermission('owner', 'booking.approve_without_dp'), true, 'Owner harus memiliki booking.approve_without_dp');
  assert.strictEqual(hasPermission('owner', 'random.custom_permission'), true, 'Owner harus memiliki semua izin implisit');
  assert.strictEqual(hasPermission('admin', 'booking.approve'), true, 'Admin (sinonim owner) harus memiliki booking.approve');

  // Staff memiliki booking.approve default
  assert.strictEqual(hasPermission('staff', 'booking.approve'), true, 'Staff harus memiliki booking.approve default');
  
  // Staff TIDAK memiliki permission sensitif Owner
  assert.strictEqual(hasPermission('staff', 'booking.approve_without_dp'), false, 'Staff TIDAK boleh memiliki booking.approve_without_dp');
  assert.strictEqual(hasPermission('staff', 'finance.view'), false, 'Staff TIDAK boleh memiliki finance.view');
  assert.strictEqual(hasPermission('staff', 'user.manage'), false, 'Staff TIDAK boleh memiliki user.manage');

  // Uji middleware requirePermission
  const reqOwner = { user: { role: 'owner' } };
  const reqStaff = { user: { role: 'staff' } };

  let nextCalled = false;
  requirePermission('booking.approve')(reqStaff, {}, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'requirePermission(booking.approve) harus meloloskan staff');

  nextCalled = false;
  requirePermission('booking.approve')(reqOwner, {}, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'requirePermission(booking.approve) harus meloloskan owner');

  let forbiddenStatus = null;
  const mockRes = {
    status(code) {
      forbiddenStatus = code;
      return { json: () => {} };
    }
  };
  requirePermission('booking.approve_without_dp')(reqStaff, mockRes, () => {});
  assert.strictEqual(forbiddenStatus, 403, 'requirePermission(booking.approve_without_dp) harus menolak staff dengan 403');

  console.log('   ✅ Matriks permission valid: Owner implisit semua, Staff punya booking.approve default, tanpa bukti DP hanya Owner.');

  // ── 2. Verifikasi Data Awal (Baseline) ────────────────────────
  console.log('2. Memeriksa baseline data database sebelum migrasi...');
  const baselineBookings = await db.query(
    'SELECT count(*)::int AS count, COALESCE(sum(dp_amount), 0)::numeric AS total_dp FROM bookings'
  );
  const baselinePayments = await db.query(
    'SELECT count(*)::int AS count, COALESCE(sum(amount), 0)::numeric AS total_amount FROM payments'
  );

  const initialBookingsCount = baselineBookings.rows[0].count;
  const initialBookingsDp = baselineBookings.rows[0].total_dp;
  const initialPaymentsCount = baselinePayments.rows[0].count;
  const initialPaymentsAmount = baselinePayments.rows[0].total_amount;

  console.log(`   Baseline bookings: ${initialBookingsCount} baris, total DP: Rp ${initialBookingsDp}`);
  console.log(`   Baseline payments: ${initialPaymentsCount} baris, total nominal: Rp ${initialPaymentsAmount}`);

  const upSqlPath = path.join(__dirname, '../migrations/003_staff_direct_approve.sql');
  const downSqlPath = path.join(__dirname, '../migrations/003_staff_direct_approve_down.sql');

  // ── 3. Uji Migrasi UP ─────────────────────────────────────────
  console.log('3. Menjalankan migrasi UP 003...');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await runSqlFile(client, upSqlPath);
    await client.query('COMMIT');
    console.log('   ✅ Migrasi UP selesai.');

    // Verifikasi skema tabel baru
    const { rows: tFinancial } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'financial_entries'"
    );
    assert.strictEqual(tFinancial.length, 1, 'Tabel financial_entries harus ada');

    const { rows: tOutbox } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'wa_outbox'"
    );
    assert.strictEqual(tOutbox.length, 1, 'Tabel wa_outbox harus ada');

    // Verifikasi unique index financial_entries (sumber_tipe, sumber_id)
    const { rows: idxRows } = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'financial_entries' AND indexname = 'ux_financial_entries_sumber_aktif'
    `);
    assert.strictEqual(idxRows.length, 1, 'Unique index ux_financial_entries_sumber_aktif harus aktif');

    // Verifikasi CHECK constraint approval_rules melarang booking.approve
    let constraintViolated = false;
    try {
      await client.query("INSERT INTO approval_rules (tipe, requires_owner) VALUES ('booking.approve', true)");
    } catch (err) {
      if (err.message.includes('chk_approval_rules_no_direct_approve') || err.code === '23514') {
        constraintViolated = true;
      }
    }
    assert.strictEqual(constraintViolated, true, 'CHECK constraint harus menolak booking.approve di approval_rules');
    console.log('   ✅ CHECK constraint approval_rules & Unique index financial_entries aktif.');

    // ── 4. Uji Migrasi DOWN (Rollback) ───────────────────────────
    console.log('4. Menjalankan migrasi DOWN (Rollback) 003...');
    await client.query('BEGIN');
    await runSqlFile(client, downSqlPath);
    await client.query('COMMIT');

    const { rows: tFinancialDown } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'financial_entries'"
    );
    assert.strictEqual(tFinancialDown.length, 0, 'Tabel financial_entries harus terhapus setelah rollback');
    console.log('   ✅ Migrasi DOWN sukses terverifikasi.');

    // ── 5. Uji Migrasi UP Kembali (Idempotency) ───────────────────
    console.log('5. Menjalankan migrasi UP kembali (Uji Idempotensi)...');
    await client.query('BEGIN');
    await runSqlFile(client, upSqlPath);
    await client.query('COMMIT');

    // Jalankan sekali lagi UP langsung untuk membuktikan aman dijalankan berulang
    await client.query('BEGIN');
    await runSqlFile(client, upSqlPath);
    await client.query('COMMIT');
    console.log('   ✅ Migrasi UP berulang terbukti idempotent tanpa error.');

    // ── 6. Verifikasi Integritas Data (GATE) ──────────────────────
    console.log('6. Verifikasi integritas data lama (Jumlah baris & total nominal)...');
    const afterBookings = await client.query(
      'SELECT count(*)::int AS count, COALESCE(sum(dp_amount), 0)::numeric AS total_dp FROM bookings'
    );
    const afterPayments = await client.query(
      'SELECT count(*)::int AS count, COALESCE(sum(amount), 0)::numeric AS total_amount FROM payments'
    );

    assert.strictEqual(afterBookings.rows[0].count, initialBookingsCount, 'Jumlah baris bookings harus tetap sama');
    assert.strictEqual(afterBookings.rows[0].total_dp, initialBookingsDp, 'Total nominal DP bookings harus tetap sama');
    assert.strictEqual(afterPayments.rows[0].count, initialPaymentsCount, 'Jumlah baris payments harus tetap sama');
    assert.strictEqual(afterPayments.rows[0].total_amount, initialPaymentsAmount, 'Total nominal payments harus tetap sama');

    console.log('   ✅ Integritas data 100% utuh: data sebelum === sesudah migrasi.');
    console.log('\n=== SEMUA UJI FASE 1 LULUS (100% SUKSES) ===');
  } finally {
    client.release();
    await db.pool.end();
  }
}

if (require.main === module) {
  runTests().then(() => process.exit(0)).catch((err) => {
    console.error('❌ UJI FASE 1 GAGAL:', err);
    process.exit(1);
  });
}
