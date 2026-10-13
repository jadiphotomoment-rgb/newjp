'use strict';

require('dotenv').config();
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const authRoute = require('../routes/auth');
const auth = require('../middleware/auth');
const { invalidateUserState } = require('../utils/tokenVersionCache');

// Siapkan express app untuk testing langsung
const app = express();
app.use(express.json());
app.use('/api/auth', authRoute);

// Endpoint uji otorisasi
app.get('/api/test/finance', auth, auth.requirePermission('finance.view'), (req, res) => {
  res.json({ success: true, data: 'finance secret' });
});

app.get('/api/test/booking', auth, auth.requirePermission('booking.view'), (req, res) => {
  res.json({ success: true, data: 'booking ok' });
});

let server;
let port;
let baseUrl;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };
    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(url, { method, headers: reqHeaders }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('--- [TEST FASE 2] Memulai Uji Autentikasi & Otorisasi ---');

  // Jalankan test server pada port dinamis
  await new Promise(resolve => {
    server = app.listen(0, () => {
      port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const testEmailOwner = 'test_owner_' + Date.now() + '@jadiphoto.moment';
  const testEmailStaff = 'test_staff_' + Date.now() + '@jadiphoto.moment';
  const testPassword = 'PasswordSangatAman123!';
  const hash = bcrypt.hashSync(testPassword, 10);

  // Buat user test di DB
  const { rows: ownerRows } = await db.query(`
    INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
    VALUES ('Test Owner', $1, $2, 'owner', true, false)
    RETURNING id
  `, [testEmailOwner, hash]);
  const ownerId = ownerRows[0].id;

  const { rows: staffRows } = await db.query(`
    INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
    VALUES ('Test Staff', $1, $2, 'staff', true, true)
    RETURNING id
  `, [testEmailStaff, hash]);
  const staffId = staffRows[0].id;

  try {
    // 1. Test Login Sukses (Owner)
    console.log('1. Uji Login Sukses (Owner)...');
    const loginRes = await request('POST', '/api/auth/login', {
      email: testEmailOwner,
      password: testPassword
    });
    if (loginRes.status !== 200 || !loginRes.body.accessToken || !loginRes.body.refreshToken) {
      throw new Error(`Login gagal: ${JSON.stringify(loginRes.body)}`);
    }
    const ownerToken = loginRes.body.accessToken;
    const initialRefreshToken = loginRes.body.refreshToken;
    console.log('   ✅ Login sukses. Access token & Refresh token didapatkan.');

    // 2. Test Login Gagal (Pesan seragam)
    console.log('2. Uji Login Gagal (Password salah & Pesan Seragam)...');
    const failRes = await request('POST', '/api/auth/login', {
      email: testEmailOwner,
      password: 'wrong_password'
    });
    if (failRes.status !== 401 || failRes.body.error !== 'Email atau password salah') {
      throw new Error(`Respons error tidak sesuai: ${JSON.stringify(failRes.body)}`);
    }
    console.log('   ✅ Pesan error seragam diverifikasi.');

    // 3. Test Lockout (5x gagal beruntun)
    console.log('3. Uji Lockout Akun setelah 5x percobaan gagal...');
    for (let i = 0; i < 4; i++) {
      await request('POST', '/api/auth/login', { email: testEmailOwner, password: 'wrong' });
    }
    // Percobaan ke-5 memicu lock, percobaan berikutnya harus 429
    const lockRes = await request('POST', '/api/auth/login', { email: testEmailOwner, password: testPassword });
    if (lockRes.status !== 429) {
      throw new Error(`Akun harus terkunci (429), tapi mendapatkan status: ${lockRes.status}`);
    }
    console.log('   ✅ Akun terkunci dengan benar (HTTP 429 lockout).');

    // Buka lock untuk melanjutkan test
    await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [ownerId]);

    // 4. Test Autentikasi & RBAC Middleware
    console.log('4. Uji RBAC: Owner punya izin finance.*, Staff dilarang (403)...');
    const ownerFinance = await request('GET', '/api/test/finance', null, {
      'Authorization': `Bearer ${ownerToken}`
    });
    if (ownerFinance.status !== 200) {
      throw new Error(`Owner harusnya lolos finance: status ${ownerFinance.status}`);
    }

    // Login staff
    const staffLogin = await request('POST', '/api/auth/login', { email: testEmailStaff, password: testPassword });
    const staffToken = staffLogin.body.accessToken;

    // Staff coba akses endpoint normal saat must_change_password = true
    const staffBlocked = await request('GET', '/api/test/booking', null, {
      'Authorization': `Bearer ${staffToken}`
    });
    if (staffBlocked.status !== 403 || !staffBlocked.body.must_change_password) {
      throw new Error(`Staff dengan must_change_password harus diblokir (403): ${JSON.stringify(staffBlocked.body)}`);
    }
    console.log('   ✅ Staff dengan must_change_password berhasil diblokir dari endpoint normal.');

    // Staff ganti password
    const newStaffPass = 'PasswordBaruStaff2026!';
    const changePassRes = await request('POST', '/api/auth/change-password', {
      currentPassword: testPassword,
      newPassword: newStaffPass
    }, {
      'Authorization': `Bearer ${staffToken}`
    });
    if (changePassRes.status !== 200) {
      throw new Error(`Ganti password gagal: ${JSON.stringify(changePassRes.body)}`);
    }
    const updatedStaffToken = changePassRes.body.accessToken;

    // Sekarang staff boleh booking
    const staffBookingOk = await request('GET', '/api/test/booking', null, {
      'Authorization': `Bearer ${updatedStaffToken}`
    });
    if (staffBookingOk.status !== 200) {
      throw new Error(`Staff harusnya bisa booking setelah ganti password: ${staffBookingOk.status}`);
    }

    // Tapi staff TETAP DILARANG finance (403)
    const staffFinance = await request('GET', '/api/test/finance', null, {
      'Authorization': `Bearer ${updatedStaffToken}`
    });
    if (staffFinance.status !== 403) {
      throw new Error(`Staff dilarang akses finance, tapi dapat status: ${staffFinance.status}`);
    }
    console.log('   ✅ Staff dilarang (403) pada endpoint finance; Owner lolos.');

    // 5. Test Refresh Token Rotation
    console.log('5. Uji Refresh Token Rotation...');
    const refreshRes = await request('POST', '/api/auth/refresh', {
      refreshToken: initialRefreshToken
    });
    if (refreshRes.status !== 200 || !refreshRes.body.refreshToken) {
      throw new Error(`Refresh token rotation gagal: ${JSON.stringify(refreshRes.body)}`);
    }
    const rotatedRefreshToken = refreshRes.body.refreshToken;
    console.log('   ✅ Refresh token berhasil dirotasi ke token baru.');

    // 6. Test Refresh Token REUSE Detection
    console.log('6. Uji Deteksi Pemakaian Ulang (Reuse Detection)...');
    const reuseRes = await request('POST', '/api/auth/refresh', {
      refreshToken: initialRefreshToken // Pakai token lama yang sudah dirotasi
    });
    if (reuseRes.status !== 401) {
      throw new Error(`Pemakaian ulang token harus ditolak (401), didapat: ${reuseRes.status}`);
    }
    // Token yang baru pun harus ikut dicabut karena seluruh rantai dibatalkan!
    const subsequentRes = await request('POST', '/api/auth/refresh', {
      refreshToken: rotatedRefreshToken
    });
    if (subsequentRes.status !== 401) {
      throw new Error(`Seluruh rantai token seharusnya sudah dicabut setelah reuse: ${subsequentRes.status}`);
    }
    console.log('   ✅ Deteksi reuse aktif: seluruh sesi pengguna dicabut otomatis.');

    // 7. Test Nonaktifkan Pengguna
    console.log('7. Uji Nonaktifkan Pengguna...');
    // Login baru untuk staff
    const freshLogin = await request('POST', '/api/auth/login', {
      email: testEmailStaff,
      password: newStaffPass
    });
    const activeStaffToken = freshLogin.body.accessToken;

    // Nonaktifkan staff di DB
    await db.query('UPDATE users SET is_active = false WHERE id = $1', [staffId]);
    invalidateUserState(staffId);

    const deactRes = await request('GET', '/api/test/booking', null, {
      'Authorization': `Bearer ${activeStaffToken}`
    });
    if (deactRes.status !== 401) {
      throw new Error(`Pengguna nonaktif harus ditolak (401), didapat: ${deactRes.status}`);
    }
    console.log('   ✅ Pengguna yang dinonaktifkan langsung ditolak (401).');

    console.log('--- [TEST FASE 2] SELURUH UJI AUTENTIKASI & OTORISASI LULUS (100% SUKSES) ---');
  } finally {
    // Bersihkan data test
    await db.query('DELETE FROM users WHERE id IN ($1, $2)', [ownerId, staffId]);
    invalidateUserState();
    server.close();
  }
}

run().then(() => process.exit(0)).catch(err => {
  console.error('❌ Uji Fase 2 Gagal:', err);
  if (server) server.close();
  process.exit(1);
});
