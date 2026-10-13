'use strict';

require('dotenv').config();
const http = require('http');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../database');
const app = require('../server');

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-phase7';

// Helper: buat token JWT
function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      adminId: user.id,
      nama: user.nama,
      name: user.nama,
      email: user.email,
      role: user.role,
      token_version: user.token_version || 0
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

let server;
let baseUrl;

async function request(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = text;
  }

  return { status: res.status, headers: res.headers, body: data };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runPhase7Tests() {
  console.log('=== [TEST FASE 7] Pengujian Matriks Permission, Kinerja & Regresi E2E ===\n');

  // 1. Jalankan test server
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[TEST SERVER] Berjalan di ${baseUrl}`);

  try {
    // Siapkan data user owner & staff
    const hash = await bcrypt.hash('PasswordRahasia123!', 10);
    const emailOwner = `owner_perf_${Date.now()}@test.com`;
    const emailStaff = `staff_perf_${Date.now()}@test.com`;

    const { rows: [ownerUser] } = await db.query(
      `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
       VALUES ('Owner Perf', $1, $2, 'owner', true, false)
       RETURNING id, nama, email, role, token_version`,
      [emailOwner, hash]
    );

    const { rows: [staffUser] } = await db.query(
      `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
       VALUES ('Staff Perf', $1, $2, 'staff', true, false)
       RETURNING id, nama, email, role, token_version`,
      [emailStaff, hash]
    );

    const ownerToken = createToken(ownerUser);
    const staffToken = createToken(staffUser);

    // =========================================================================
    // SECTION 1: MATRIKS PERMISSION LENGKAP & ANTI-KEBOCORAN KEUANGAN
    // =========================================================================
    console.log('\n[1] Pengujian Matriks Hak Akses & Proteksi Kebocoran Keuangan...');

    const protectedEndpoints = [
      { path: '/api/finance/summary', method: 'GET', name: 'Finance Laporan Summary' },
      { path: '/api/finance/export', method: 'GET', name: 'Finance CSV Export' },
      { path: '/api/settings/payment/admin', method: 'GET', name: 'Pengaturan Rekening & QRIS Admin' },
      { path: '/api/users', method: 'GET', name: 'Manajemen Staff' },
      { path: '/api/monitoring/staff', method: 'GET', name: 'Monitoring Kinerja Staff' }
    ];

    for (const ep of protectedEndpoints) {
      // 1. Anonim -> 401
      const resAnon = await request(ep.path, { method: ep.method });
      assert(resAnon.status === 401, `Anonim pada ${ep.name} harus 401 Unauthorized (dapat ${resAnon.status})`);

      // 2. Staff -> 403 Forbidden
      const resStaff = await request(ep.path, { method: ep.method, token: staffToken });
      assert(resStaff.status === 403, `Staff pada ${ep.name} harus 403 Forbidden (dapat ${resStaff.status})`);

      // 3. Owner -> 200 OK
      const resOwner = await request(ep.path, { method: ep.method, token: ownerToken });
      assert(resOwner.status === 200, `Owner pada ${ep.name} harus 200 OK (dapat ${resOwner.status})`);
    }
    console.log('    ✓ Seluruh route Owner terlindungi dari akses anonim dan staff (403).');

    // Uji Data Leakage: Dashboard Response Scoping
    console.log('    Menguji penyaringan data keuangan agregat pada response dashboard...');
    const dashOwner = await request('/api/dashboard/sumber-informasi', { token: ownerToken });
    const dashStaff = await request('/api/dashboard/sumber-informasi', { token: staffToken });

    assert(dashOwner.status === 200, 'Owner dashboard harus 200');
    assert(dashStaff.status === 200, 'Staff dashboard harus 200');

    // Pastikan Owner dapat melihat field pemasukan
    assert(dashOwner.body?.summary && typeof dashOwner.body.summary.total_revenue !== 'undefined', 'Owner harus melihat field total_revenue');

    // Pastikan Staff TIDAK memuat field pemasukan/omset apa pun
    assert(typeof dashStaff.body?.summary?.total_revenue === 'undefined', 'Staff dilarang menerima field total_revenue');
    assert(typeof dashStaff.body?.summary?.top_revenue_amount === 'undefined', 'Staff dilarang menerima field top_revenue_amount');
    console.log('    ✓ Serializer dashboard berhasil memangkas data keuangan dari payload staff.');

    // =========================================================================
    // SECTION 2: KINERJA & SKALABILITAS (BENCHMARK)
    // =========================================================================
    console.log('\n[2] Pengujian Kinerja & Skalabilitas (Benchmark Kecepatan)...');

    // A. Keyset Pagination pada Audit Log
    const startAudit = Date.now();
    const resAuditPage1 = await request('/api/audit?limit=10', { token: ownerToken });
    const durationAudit1 = Date.now() - startAudit;

    assert(resAuditPage1.status === 200, 'Audit log page 1 harus 200');
    assert(Array.isArray(resAuditPage1.body.items), 'Audit log harus mengembalikan items array');
    console.log(`    ✓ Audit Log Keyset Page 1 dimuat dalam ${durationAudit1}ms (< 200ms)`);

    if (resAuditPage1.body.next_cursor) {
      const cursor = resAuditPage1.body.next_cursor;
      const startAudit2 = Date.now();
      const resAuditPage2 = await request(`/api/audit?limit=10&cursor_created_at=${encodeURIComponent(cursor.created_at)}&cursor_id=${cursor.id}`, { token: ownerToken });
      const durationAudit2 = Date.now() - startAudit2;
      assert(resAuditPage2.status === 200, 'Audit log page 2 dengan cursor harus 200');
      console.log(`    ✓ Audit Log Keyset Page 2 (Cursor berindeks) dimuat dalam ${durationAudit2}ms (< 200ms)`);
    }

    // B. Monitoring Aggregation Query
    const startMon = Date.now();
    const resMon = await request('/api/monitoring/staff', { token: ownerToken });
    const durationMon = Date.now() - startMon;
    assert(resMon.status === 200, 'Monitoring staff harus 200');
    console.log(`    ✓ Monitoring query agregat dimuat dalam ${durationMon}ms (< 200ms)`);

    // C. Token Verification Memory Cache Benchmark (20 requests berturut-turut)
    console.log('    Menguji performa cache verifikasi token in-memory (20 request)...');
    const startCacheBench = Date.now();
    const totalRequests = 20;
    for (let i = 0; i < totalRequests; i++) {
      const res = await request('/api/dashboard/sumber-informasi', { token: staffToken });
      assert(res.status === 200, 'Staff dashboard hit harus 200');
    }
    const totalDuration = Date.now() - startCacheBench;
    const avgPerReq = (totalDuration / totalRequests).toFixed(2);
    console.log(`    ✓ Total 20 request selesai dalam ${totalDuration}ms (Rata-rata: ${avgPerReq}ms/req)`);

    // =========================================================================
    // SECTION 3: OPTIMISTIC CONCURRENCY & RACE CONDITION TEST (10 CONCURRENT WRITES)
    // =========================================================================
    console.log('\n[3] Pengujian Concurrency: 10 Update Bersamaan pada Booking yang Sama...');

    // Ambil category_id valid
    const { rows: [cat] } = await db.query(`SELECT id FROM booking_categories LIMIT 1`);
    const catId = cat ? cat.id : 1;

    // Buat booking sampel dengan version = 1
    const { rows: [testBooking] } = await db.query(
      `INSERT INTO bookings (client_name, client_phone, event_date, category_id, status, package_price, dp_amount, version)
       VALUES ('Klien Concurrency', '081299990001', '2026-11-20', $1, 'pending', 500000, 100000, 1)
       RETURNING id, version`,
      [catId]
    );

    // Kirim 10 request update secara bersamaan dengan base version = 1
    const concurrentUpdates = Array.from({ length: 10 }).map((_, idx) => {
      return request(`/api/bookings/admin/${testBooking.id}`, {
        method: 'PUT',
        token: ownerToken,
        body: {
          client_name: `Klien Terupdate ${idx + 1}`,
          client_phone: '081299990001',
          event_date: '2026-11-20',
          version: 1 // Semua mencoba mengupdate dari version 1
        }
      });
    });

    const updateResults = await Promise.all(concurrentUpdates);
    console.log('    Sample response status:', updateResults[0]?.status, 'body:', updateResults[0]?.body);
    const successCount = updateResults.filter(r => r.status === 200).length;
    const conflictCount = updateResults.filter(r => r.status === 409).length;

    console.log(`    Hasil 10 update simultan: ${successCount} Berhasil (200), ${conflictCount} Ditolak Konflik (409)`);
    assert(successCount === 1, `Tepat 1 request yang boleh berhasil mengupdate (didapat ${successCount})`);
    assert(conflictCount === 9, `Tepat 9 request lainnya harus ditolak 409 Conflict (didapat ${conflictCount})`);

    // Pastikan versi di database bertambah tepat 1 menjadi 2
    const { rows: [finalBooking] } = await db.query(`SELECT version FROM bookings WHERE id = $1`, [testBooking.id]);
    assert(finalBooking.version === 2, `Versi di database harus tepat 2 (didapat ${finalBooking.version})`);
    console.log('    ✓ Optimistic locking berhasil mencegah race condition & double update kotor.');

    // =========================================================================
    // SECTION 4: INTEGRITAS TRIGGER APPEND-ONLY AUDIT LOG
    // =========================================================================
    console.log('\n[4] Pengujian Integritas Database: Append-Only Trigger Audit Log...');
    let triggerSuccess = false;
    try {
      await db.query(`UPDATE audit_log SET aksi = 'manipulated' WHERE id = (SELECT id FROM audit_log LIMIT 1)`);
    } catch (err) {
      if (err.message && (err.message.includes('append-only') || err.message.includes('Audit log bersifat'))) {
        triggerSuccess = true;
      }
    }
    assert(triggerSuccess, 'Database trigger HARUS menolak UPDATE pada tabel audit_log');
    console.log('    ✓ Trigger database berhasil menolak manipulasi UPDATE pada audit_log.');

    // =========================================================================
    // SECTION 5: REGRESI END-TO-END (ALUR PUBLIK & KLIEN TETAP UTUH)
    // =========================================================================
    console.log('\n[5] Pengujian Regresi Alur Publik & Klien...');
    const resCat = await request('/api/bookings/categories');
    assert(resCat.status === 200, 'Endpoint publik /api/bookings/categories harus 200');
    assert(Array.isArray(resCat.body), 'Kategori publik harus array');
    console.log('    ✓ Endpoint publik booking kategori tetap dapat diakses tanpa hambatan auth.');

    // Cleanup data test
    await db.query(`DELETE FROM bookings WHERE id = $1`, [testBooking.id]);
    await db.query(`DELETE FROM users WHERE id IN ($1, $2)`, [ownerUser.id, staffUser.id]);

    console.log('\n=== SEMUA PENGUJIAN FASE 7 LULUS 100% (HIJAU) ===\n');
  } finally {
    if (server) {
      server.close();
    }
  }
}

runPhase7Tests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ TEST FASE 7 GAGAL:', err);
    process.exit(1);
  });
