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
  console.log('--- TEST FITUR D: 403 ROLE GUARD & PERMISSION HARDENING ---');
  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
    }
  }

  // 1. Ambil atau buat data user staff & owner di DB untuk validasi token
  const ownerRes = await db.query("SELECT id, nama, email, role, token_version FROM users WHERE role = 'owner' AND is_active = true LIMIT 1");
  const staffRes = await db.query("SELECT id, nama, email, role, token_version FROM users WHERE role = 'staff' AND is_active = true LIMIT 1");

  if (!ownerRes.rows[0] || !staffRes.rows[0]) {
    console.error('Data owner atau staff tidak ditemukan di DB. Pastikan migration/seed sudah jalan.');
    process.exit(1);
  }

  const ownerToken = createToken(ownerRes.rows[0]);
  const staffToken = createToken(staffRes.rows[0]);

  // Start HTTP server
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  try {
    // Test 1: Finance tanpa token -> 401
    const t1 = await request('/api/finance/summary');
    assert(t1.status === 401, `GET /api/finance/summary tanpa token harus 401 (got ${t1.status})`);

    // Test 2: Finance dengan staff token -> 403
    const t2 = await request('/api/finance/summary', { token: staffToken });
    assert(t2.status === 403, `GET /api/finance/summary dengan staff token harus 403 (got ${t2.status})`);

    // Test 3: Finance write (PATCH approve) dengan staff token -> 403
    const t3 = await request('/api/finance/payments/1/approve', { method: 'PATCH', token: staffToken });
    assert(t3.status === 403, `PATCH /api/finance/payments/1/approve dengan staff token harus 403 (got ${t3.status})`);

    // Test 4: Users tanpa token -> 401
    const t4 = await request('/api/users');
    assert(t4.status === 401, `GET /api/users tanpa token harus 401 (got ${t4.status})`);

    // Test 5: Users dengan staff token -> 403
    const t5 = await request('/api/users', { token: staffToken });
    assert(t5.status === 403, `GET /api/users dengan staff token harus 403 (got ${t5.status})`);

    // Test 6: Users write (POST create) dengan staff token -> 403
    const t6 = await request('/api/users', { method: 'POST', token: staffToken, body: { email: 'test@x.com' } });
    assert(t6.status === 403, `POST /api/users dengan staff token harus 403 (got ${t6.status})`);

    // Test 7: Booking set-price tanpa token -> 401
    const t7 = await request('/api/bookings/admin/1/set-price', { method: 'PATCH', body: { packagePrice: 1000 } });
    assert(t7.status === 401, `PATCH /api/bookings/admin/1/set-price tanpa token harus 401 (got ${t7.status})`);

    // Test 8: Booking set-price dengan staff token -> 403
    const t8 = await request('/api/bookings/admin/1/set-price', { method: 'PATCH', token: staffToken, body: { packagePrice: 1000 } });
    assert(t8.status === 403, `PATCH /api/bookings/admin/1/set-price dengan staff token harus 403 (got ${t8.status})`);

    // Test 9: Booking set-price dengan owner token -> bukan 401 dan bukan 403
    const t9 = await request('/api/bookings/admin/1/set-price', { method: 'PATCH', token: ownerToken, body: { packagePrice: 1000 } });
    assert(t9.status !== 401 && t9.status !== 403, `PATCH /api/bookings/admin/1/set-price dengan owner token diizinkan (got ${t9.status})`);

    // Test 10: Users dengan owner token -> 200
    const t10 = await request('/api/users', { token: ownerToken });
    assert(t10.status === 200, `GET /api/users dengan owner token diizinkan 200 (got ${t10.status})`);

    console.log(`\nHasil: ${passed}/${total} test lulus.`);
    if (passed !== total) {
      process.exit(1);
    }
  } finally {
    if (server) server.close();
  }
}

run().then(() => {
  console.log('Fitur D test selesai dengan sukses.');
  process.exit(0);
}).catch((err) => {
  console.error('Test error:', err);
  if (server) server.close();
  process.exit(1);
});
