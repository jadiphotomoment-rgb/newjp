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
  console.log('--- TEST FITUR C: CRUD USER VIA ADMIN ---');
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

  const ownerRes = await db.query("SELECT id, nama, email, role, token_version FROM users WHERE role = 'owner' AND is_active = true LIMIT 1");
  if (!ownerRes.rows[0]) {
    console.error('Owner tidak ditemukan di DB');
    process.exit(1);
  }
  const owner = ownerRes.rows[0];
  const ownerToken = createToken(owner);

  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const testEmail = `test.staff.${Date.now()}@jadiphoto.test`;
  let createdStaffId = null;

  try {
    // 1. GET /api/users — list tidak membocorkan password_hash
    const listRes = await request('/api/users', { token: ownerToken });
    assert(listRes.status === 200 && Array.isArray(listRes.data), 'GET /api/users mengembalikan list');
    const hasHash = listRes.data.some(u => u.password_hash !== undefined || u.password !== undefined);
    assert(!hasHash, 'Response GET /api/users tidak memuat password_hash');

    // 2. POST /api/users — tolak password < 8 karakter
    const weakPass = await request('/api/users', {
      method: 'POST',
      token: ownerToken,
      body: { nama: 'Weak Pass', email: testEmail, password: '123', role: 'staff' }
    });
    assert(weakPass.status === 400, 'POST /api/users tolak password < 8 karakter');

    // 3. POST /api/users — tambah user baru sukses
    const createRes = await request('/api/users', {
      method: 'POST',
      token: ownerToken,
      body: { nama: 'Staf Uji C', email: testEmail, password: 'password1234', role: 'staff' }
    });
    assert(createRes.status === 201 && createRes.data.user, 'POST /api/users berhasil membuat user baru');
    createdStaffId = createRes.data?.user?.id;
    assert(createRes.data.user.password_hash === undefined, 'POST response tidak memuat password_hash');

    // 4. POST /api/users — tolak duplikat email
    const dupRes = await request('/api/users', {
      method: 'POST',
      token: ownerToken,
      body: { nama: 'Duplikat', email: testEmail, password: 'password1234', role: 'staff' }
    });
    assert(dupRes.status === 409, 'POST /api/users tolak email duplikat dengan 409');

    // 5. PUT /api/users/:id — update nama & email
    const updatedEmail = `updated.${Date.now()}@jadiphoto.test`;
    const updateRes = await request(`/api/users/${createdStaffId}`, {
      method: 'PUT',
      token: ownerToken,
      body: { nama: 'Staf Uji Diperbarui', email: updatedEmail, role: 'staff', is_active: true }
    });
    assert(updateRes.status === 200 && updateRes.data.user.nama === 'Staf Uji Diperbarui', 'PUT /api/users/:id update nama & email');
    assert(updateRes.data.user.password_hash === undefined, 'PUT response tidak memuat password_hash');

    // 6. PUT /api/users/:id — tolak jika owner menonaktifkan akun sendiri
    const selfDeact = await request(`/api/users/${owner.id}`, {
      method: 'PUT',
      token: ownerToken,
      body: { is_active: false }
    });
    assert(selfDeact.status === 400, 'Tolak owner menonaktifkan akun sendiri (HTTP 400)');

    // 7. PUT /api/users/:id — tolak jika owner mengubah role sendiri dari owner
    const selfDemote = await request(`/api/users/${owner.id}`, {
      method: 'PUT',
      token: ownerToken,
      body: { role: 'staff' }
    });
    assert(selfDemote.status === 400, 'Tolak owner mengubah peran sendiri menjadi non-owner (HTTP 400)');

    // 8. POST /api/users/:id/reset-password — reset password sukses
    const resetRes = await request(`/api/users/${createdStaffId}/reset-password`, {
      method: 'POST',
      token: ownerToken,
      body: { new_password: 'newSecretPass123' }
    });
    assert(resetRes.status === 200, 'POST reset-password berhasil (HTTP 200)');

    // 9. DELETE /api/users/:id — soft deactivate user
    const deleteRes = await request(`/api/users/${createdStaffId}`, {
      method: 'DELETE',
      token: ownerToken
    });
    assert(deleteRes.status === 200 && deleteRes.data.is_active === false, 'DELETE /api/users/:id berhasil soft-deactivate (is_active=false)');

    // 10. DELETE /api/users/:id — tolak jika menonaktifkan diri sendiri
    const selfDel = await request(`/api/users/${owner.id}`, {
      method: 'DELETE',
      token: ownerToken
    });
    assert(selfDel.status === 400, 'DELETE /api/users/:id tolak menonaktifkan akun sendiri');

    // 11. DELETE /api/users/:id?permanent=true — tolak hapus permanen akun sendiri
    const selfPerm = await request(`/api/users/${owner.id}?permanent=true`, {
      method: 'DELETE',
      token: ownerToken
    });
    assert(selfPerm.status === 400, 'Tolak hapus permanen akun sendiri');

    // 12. Buat user aktif baru, coba hapus permanen langsung -> harus tolak (harus nonaktif dulu)
    const activeEmail = `active.${Date.now()}@jadiphoto.test`;
    const actRes = await request('/api/users', {
      method: 'POST',
      token: ownerToken,
      body: { nama: 'Staf Masih Aktif', email: activeEmail, password: 'password1234', role: 'staff' }
    });
    const activeStaffId = actRes.data?.user?.id;
    const directPerm = await request(`/api/users/${activeStaffId}?permanent=true`, {
      method: 'DELETE',
      token: ownerToken
    });
    assert(directPerm.status === 400, 'Tolak hapus permanen user yang masih aktif (harus dinonaktifkan dulu)');

    // 13. DELETE /api/users/:id?permanent=true — hapus permanen user yang sudah nonaktif (createdStaffId sudah nonaktif dari test 9)
    const permRes = await request(`/api/users/${createdStaffId}?permanent=true`, {
      method: 'DELETE',
      token: ownerToken
    });
    assert(permRes.status === 200 && permRes.data.deleted === true, 'DELETE ?permanent=true sukses menghapus user yang sudah nonaktif');

    // Verifikasi user benar-benar terhapus dari database
    const checkDb = await db.query('SELECT id FROM users WHERE id = $1', [createdStaffId]);
    assert(checkDb.rows.length === 0, 'User yang dihapus permanen tidak ditemukan lagi di DB');
    createdStaffId = null; // sudah terhapus, tidak perlu cleanup

    // Cleanup activeStaffId
    if (activeStaffId) {
      await db.query('DELETE FROM users WHERE id = $1', [activeStaffId]).catch(() => {});
    }

    console.log(`\nHasil: ${passed}/${total} test lulus.`);
    if (passed !== total) process.exit(1);
  } finally {
    // Cleanup data pengujian
    if (createdStaffId) {
      await db.query('DELETE FROM users WHERE id = $1', [createdStaffId]).catch(() => {});
    }
    if (server) server.close();
  }
}

run().then(() => {
  console.log('Fitur C test selesai dengan sukses.');
  process.exit(0);
}).catch((err) => {
  console.error('Test error:', err);
  if (server) server.close();
  process.exit(1);
});
