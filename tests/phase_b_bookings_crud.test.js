'use strict';

require('dotenv').config();
const http = require('http');
const jwt = require('jsonwebtoken');
const db = require('../database');
const app = require('../server');

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-phase5';

function createToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      id: user.id,
      adminId: user.id,
      nama: user.nama,
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
  return { status: res.status, data };
}

async function run() {
  console.log('--- TEST FITUR B: CRUD BOOKING & JUMLAH DIBAYAR ---');
  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message}`);
    }
  }

  let ownerUser;
  let staffUser;
  let ownerToken;
  let staffToken;
  let categoryId;

  try {
    // 1. Setup server
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 2. Setup user owner & staff
    const ownerRes = await db.query(
      `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password, token_version)
       VALUES ('Owner Test B', 'owner_b_${Date.now()}@test.com', 'hash', 'owner', true, false, 0)
       RETURNING id, nama, email, role, token_version`
    );
    ownerUser = ownerRes.rows[0];
    ownerToken = createToken(ownerUser);

    const staffRes = await db.query(
      `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password, token_version)
       VALUES ('Staff Test B', 'staff_b_${Date.now()}@test.com', 'hash', 'staff', true, false, 0)
       RETURNING id, nama, email, role, token_version`
    );
    staffUser = staffRes.rows[0];
    staffToken = createToken(staffUser);

    // Kategori booking untuk test
    const catRes = await db.query('SELECT id FROM booking_categories LIMIT 1');
    categoryId = catRes.rows[0]?.id;

    // ── Test Group 1: Role Guard & Permissions ──────────────────────────────
    console.log('\nGroup 1: Role Guard & Permissions');
    const noAuth = await request('/api/bookings/admin/1/paid-amount', {
      method: 'PATCH',
      body: { paid_amount: 100000 }
    });
    assert(noAuth.status === 401, 'PATCH /paid-amount tanpa token -> 401');

    const staffAuth = await request('/api/bookings/admin/1/paid-amount', {
      method: 'PATCH',
      token: staffToken,
      body: { paid_amount: 100000 }
    });
    assert(staffAuth.status === 403, 'PATCH /paid-amount dengan role staff -> 403 Forbidden');

    // ── Test Group 2: Admin Create Booking Manual ──────────────────────────
    console.log('\nGroup 2: Admin Create Booking');
    const createRes = await request('/api/bookings/admin/create', {
      method: 'POST',
      token: ownerToken,
      body: {
        category_id: categoryId,
        client_name: 'Klien Test Fitur B',
        client_phone: '081299887766',
        event_date: '2026-11-20',
        event_time: '10:00',
        location: 'Studio Utama',
        package_price: 1500000,
        dp_amount: 300000,
        paid_amount: 0,
        notes: 'Catatan permintaan khusus dekorasi',
        status: 'confirmed'
      }
    });
    assert(createRes.status === 201 && createRes.data?.booking?.id, 'POST /admin/create berhasil membuat booking (201)');
    const bookingId = createRes.data?.booking?.id;

    // ── Test Group 3: Validasi Input Jumlah Dibayar ────────────────────────
    console.log('\nGroup 3: Validasi Input Jumlah Dibayar');
    const negPaid = await request(`/api/bookings/admin/${bookingId}/paid-amount`, {
      method: 'PATCH',
      token: ownerToken,
      body: { paid_amount: -50000 }
    });
    assert(negPaid.status === 400 && negPaid.data.error.includes('negatif'), 'Nominal paid_amount negatif ditolak 400');

    const overPaid = await request(`/api/bookings/admin/${bookingId}/paid-amount`, {
      method: 'PATCH',
      token: ownerToken,
      body: { paid_amount: 2000000 } // Total harga 1.500.000
    });
    assert(overPaid.status === 400 && overPaid.data.error.includes('melebihi'), 'Nominal paid_amount melebihi total harga paket ditolak 400');

    // Staff mencoba mengubah paid_amount via PUT
    const staffPutPaid = await request(`/api/bookings/admin/${bookingId}`, {
      method: 'PUT',
      token: staffToken,
      body: {
        client_name: 'Klien Edit Staff',
        client_phone: '081299887766',
        event_date: '2026-11-20',
        paid_amount: 500000
      }
    });
    assert(staffPutPaid.status === 403, 'Staff mencoba ubah paid_amount via PUT /admin/:id ditolak 403');

    // ── Test Group 4: Single Source of Truth & Sinkronisasi Keuangan ───────
    console.log('\nGroup 4: Sinkronisasi Buku Kas (financial_entries)');
    // 4.1 Update paid_amount pertama kali ke 500.000
    const patch1 = await request(`/api/bookings/admin/${bookingId}/paid-amount`, {
      method: 'PATCH',
      token: ownerToken,
      body: { paid_amount: 500000 }
    });
    assert(patch1.status === 200, 'Owner sukses ubah paid_amount ke 500.000 (200)');
    assert(patch1.data.booking?.sisa_tagihan === 1000000, 'Sisa tagihan dihitung otomatis 1.000.000');
    assert(patch1.data.booking?.payment_status === 'sebagian', 'Status pembayaran otomatis "sebagian"');

    // Cek di tabel financial_entries
    const fe1 = await db.query(
      `SELECT * FROM financial_entries WHERE booking_id = $1 AND deleted_at IS NULL AND status = 'aktif'`,
      [bookingId]
    );
    assert(fe1.rows.length === 1 && parseInt(fe1.rows[0].nominal, 10) === 500000 && fe1.rows[0].tipe === 'masuk',
      'Tercatat entri masuk 500.000 di financial_entries');

    // 4.2 Update paid_amount ke 1.500.000 (Lunas)
    const patch2 = await request(`/api/bookings/admin/${bookingId}/paid-amount`, {
      method: 'PATCH',
      token: ownerToken,
      body: { paid_amount: 1500000 }
    });
    assert(patch2.status === 200, 'Owner sukses ubah paid_amount ke 1.500.000 (200)');
    assert(patch2.data.booking?.status === 'lunas', 'Status booking otomatis berubah menjadi "lunas"');
    assert(patch2.data.booking?.sisa_tagihan === 0, 'Sisa tagihan menjadi 0');

    // Cek selisih di financial_entries: harus ada penambahan 1.000.000
    const fe2 = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN tipe = 'masuk' THEN nominal ELSE -nominal END), 0) AS total_fe
       FROM financial_entries WHERE booking_id = $1 AND deleted_at IS NULL AND status = 'aktif'`,
      [bookingId]
    );
    assert(parseInt(fe2.rows[0].total_fe, 10) === 1500000,
      'Total entri kas di financial_entries tepat bernilai 1.500.000 sinkron');

    // 4.3 Koreksi pengurangan pembayaran (misal refund/koreksi 200.000 -> sisa 1.300.000)
    const patch3 = await request(`/api/bookings/admin/${bookingId}/paid-amount`, {
      method: 'PATCH',
      token: ownerToken,
      body: { paid_amount: 1300000 }
    });
    assert(patch3.status === 200, 'Owner sukses kurangi paid_amount ke 1.300.000 (200)');

    const fe3 = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN tipe = 'masuk' THEN nominal ELSE -nominal END), 0) AS total_fe
       FROM financial_entries WHERE booking_id = $1 AND deleted_at IS NULL AND status = 'aktif'`,
      [bookingId]
    );
    assert(parseInt(fe3.rows[0].total_fe, 10) === 1300000,
      'Total entri kas di financial_entries berkurang tepat menjadi 1.300.000');

    // ── Test Group 5: Full Edit Booking & OCC ─────────────────────────────
    console.log('\nGroup 5: Full Edit Booking & OCC Versioning');
    const detailBefore = await request(`/api/bookings/admin/detail/${bookingId}`, { token: ownerToken });
    const currentVersion = detailBefore.data.version;

    // OCC conflict check
    const occConflict = await request(`/api/bookings/admin/${bookingId}`, {
      method: 'PUT',
      token: ownerToken,
      body: {
        client_name: 'Klien OCC',
        client_phone: '081299887766',
        event_date: '2026-11-20',
        version: currentVersion - 1 // version basi
      }
    });
    assert(occConflict.status === 409, 'OCC mismatch mengembalikan 409 Conflict');

    // Update data lengkap + notes
    const fullEdit = await request(`/api/bookings/admin/${bookingId}`, {
      method: 'PUT',
      token: ownerToken,
      body: {
        client_name: 'Klien Fitur B Terupdate',
        client_phone: '081233445566',
        event_date: '2026-11-25',
        event_time: '14:30',
        location: 'Hotel Bintang 5',
        category_id: categoryId,
        package_name: 'Diamond VIP',
        notes: 'Catatan penting: bawa tripod cadangan',
        status: 'confirmed',
        package_price: 2000000,
        paid_amount: 1300000,
        version: currentVersion
      }
    });
    assert(fullEdit.status === 200, 'Full edit booking sukses (200)');
    assert(fullEdit.data.booking?.client_name === 'Klien Fitur B Terupdate', 'Nama terupdate');
    assert(fullEdit.data.booking?.notes === 'Catatan penting: bawa tripod cadangan', 'Kolom notes tersimpan');
    assert(fullEdit.data.booking?.package_name === 'Diamond VIP', 'Package name terupdate');

    // ── Test Group 6: Proteksi Soft Delete ────────────────────────────────
    console.log('\nGroup 6: Proteksi Soft Delete Booking');
    // 6.1 Tolak delete jika ada transaksi aktif tanpa force
    const delNoForce = await request(`/api/bookings/admin/${bookingId}`, {
      method: 'DELETE',
      token: ownerToken
    });
    assert(delNoForce.status === 400 && delNoForce.data.has_active_transactions === true,
      'Soft delete ditolak 400 jika booking memiliki transaksi aktif tanpa force');

    // 6.2 Tolak delete jika booking punya sesi sortir aktif
    // Buat sesi aktif & tautkan ke booking
    const adminRow = await db.query('SELECT id FROM admins LIMIT 1');
    const validAdminId = adminRow.rows[0]?.id || 1;
    const sessRes = await db.query(
      `INSERT INTO sessions (uuid, client_name, client_phone, folder_id, folder_url, photo_limit, status, admin_id)
       VALUES ('sess-test-${Date.now()}', 'Klien Fitur B', '081233445566', 'fld1', 'https://drive.google.com/test', 50, 'active', $1)
       RETURNING id`,
      [validAdminId]
    );
    const activeSessionId = sessRes.rows[0].id;
    await db.query('UPDATE bookings SET session_id = $1 WHERE id = $2', [activeSessionId, bookingId]);

    const delActiveSess = await request(`/api/bookings/admin/${bookingId}`, {
      method: 'DELETE',
      token: ownerToken
    });
    assert(delActiveSess.status === 400 && delActiveSess.data.active_session === true,
      'Soft delete ditolak 400 jika terhubung dengan sesi sortir aktif');

    // Selesaikan sesi agar tidak lagi aktif
    await db.query(`UPDATE sessions SET status = 'completed' WHERE id = $1`, [activeSessionId]);

    // 6.3 Hapus paksa dengan ?force=true
    const delForce = await request(`/api/bookings/admin/${bookingId}?force=true`, {
      method: 'DELETE',
      token: ownerToken
    });
    assert(delForce.status === 200, 'DELETE ?force=true sukses (200)');

    // Verifikasi di DB: booking deleted_at terisi, financial_entries dibatalkan
    const checkBook = await db.query('SELECT status, deleted_at FROM bookings WHERE id = $1', [bookingId]);
    assert(checkBook.rows[0]?.deleted_at !== null && checkBook.rows[0]?.status === 'cancelled',
      'Booking tercatat soft-deleted dan status cancelled di DB');

    const checkFe = await db.query(
      `SELECT COUNT(*) AS active_count FROM financial_entries WHERE booking_id = $1 AND deleted_at IS NULL AND status = 'aktif'`,
      [bookingId]
    );
    assert(parseInt(checkFe.rows[0].active_count, 10) === 0,
      'Seluruh transaksi keuangan terkait booking dibatalkan otomatis');

    // Cek GET list tidak menampilkan booking yang soft deleted
    const listRes = await request('/api/bookings/admin/list', { token: ownerToken });
    const foundInList = listRes.data.some(b => b.id === bookingId);
    assert(!foundInList, 'Booking yang dihapus hilang dari GET /admin/list');

  } catch (err) {
    console.error('Test error:', err);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    // Cleanup data test
    if (ownerUser) {
      await db.query('DELETE FROM users WHERE id IN ($1, $2)', [ownerUser.id, staffUser.id]).catch(() => {});
    }
  }

  console.log(`\nHASIL TEST FITUR B: ${passed}/${total} PASS`);
  if (passed === total) {
    console.log('SEMUA TEST FITUR B BERHASIL! (100% PASS)');
    process.exit(0);
  } else {
    console.error(`ADA TEST FITUR B GAGAL: ${total - passed} GAGAL`);
    process.exit(1);
  }
}

run();
