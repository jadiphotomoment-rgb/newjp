'use strict';

require('dotenv').config();
const http = require('http');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../database');
const app = require('../server');

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-phase5';

// Helper: buat token JWT langsung
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

  return { status: res.status, body: data };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function run() {
  console.log('=== [TEST FASE 5] Pengujian RBAC & Endpoint Baru Jadiphoto.Moment ===\n');

  // Start express server pada port dinamis
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`[TEST SERVER] Berjalan di ${baseUrl}`);
      resolve();
    });
  });

  const ts = Date.now();
  const hash = bcrypt.hashSync('PasswordTest123!', 10);

  // Setup user owner & staff di database
  const { rows: [owner] } = await db.query(
    `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
     VALUES ('Owner F5', $1, $2, 'owner', true, false)
     RETURNING id, nama, email, role, token_version`,
    [`owner_f5_${ts}@test.com`, hash]
  );

  const { rows: [staff] } = await db.query(
    `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
     VALUES ('Staff F5', $1, $2, 'staff', true, false)
     RETURNING id, nama, email, role, token_version`,
    [`staff_f5_${ts}@test.com`, hash]
  );

  // Setup category & booking untuk pengujian
  const { rows: [category] } = await db.query(
    `INSERT INTO booking_categories (name, slug, is_active, dp_type, dp_value)
     VALUES ('Category Test F5', $1, true, 'flat', 50000)
     RETURNING id, slug`,
    [`cat-f5-${ts}`]
  );

  const { rows: [testBooking] } = await db.query(
    `INSERT INTO bookings (client_name, client_phone, event_date, category_id, package_price, dp_amount, status, created_by, version)
     VALUES ('Client F5', '081299887766', CURRENT_DATE, $1, 1000000, 200000, 'confirmed', $2, 1)
     RETURNING id, version`,
    [category.id, owner.id]
  );

  const ownerToken = createToken(owner);
  const staffToken = createToken(staff);

  try {
    // ── 1. Endpoint Publik (Tanpa Autentikasi) ───────────────────
    console.log('[1] Pengujian Endpoint Publik...');
    const pubPayment = await request('/api/settings/payment');
    assert(pubPayment.status === 200, `GET /api/settings/payment status ${pubPayment.status} !== 200`);

    const pubCats = await request('/api/bookings/categories');
    assert(pubCats.status === 200, `GET /api/bookings/categories status ${pubCats.status} !== 200`);
    console.log('    ✓ Endpoint publik dapat diakses tanpa login.');

    // ── 2. Guard Anonim (Harus 401 Unauthorized) ────────────────
    console.log('[2] Pengujian Proteksi Anonim (401)...');
    const anonFinance = await request('/api/finance/summary');
    assert(anonFinance.status === 401, `GET /api/finance/summary anon status ${anonFinance.status} !== 401`);

    const anonPaymentAdmin = await request('/api/settings/payment/admin');
    assert(anonPaymentAdmin.status === 401, `GET /api/settings/payment/admin anon status ${anonPaymentAdmin.status} !== 401`);

    const anonUsers = await request('/api/users');
    assert(anonUsers.status === 401, `GET /api/users anon status ${anonUsers.status} !== 401`);

    const anonAudit = await request('/api/audit');
    assert(anonAudit.status === 401, `GET /api/audit anon status ${anonAudit.status} !== 401`);

    const anonMonitoring = await request('/api/monitoring/staff');
    assert(anonMonitoring.status === 401, `GET /api/monitoring/staff anon status ${anonMonitoring.status} !== 401`);
    console.log('    ✓ Semua route sensitif memblokir akses anonim dengan 401.');

    // ── 3. Pengujian RBAC Role Staff (403 untuk Hak Owner) ───────
    console.log('[3] Pengujian Proteksi RBAC Role Staff (403)...');
    const staffFinance = await request('/api/finance/summary', { token: staffToken });
    assert(staffFinance.status === 403, `Staff finance status ${staffFinance.status} !== 403`);

    const staffPaymentAdmin = await request('/api/settings/payment/admin', { token: staffToken });
    assert(staffPaymentAdmin.status === 403, `Staff payment admin status ${staffPaymentAdmin.status} !== 403`);

    const staffUsers = await request('/api/users', { token: staffToken });
    assert(staffUsers.status === 403, `Staff users status ${staffUsers.status} !== 403`);

    const staffCreateUser = await request('/api/users', {
      method: 'POST',
      token: staffToken,
      body: { nama: 'New Staff', email: 'ns@test.com', password: 'password123' }
    });
    assert(staffCreateUser.status === 403, `Staff create user status ${staffCreateUser.status} !== 403`);

    const staffMonitoring = await request('/api/monitoring/staff', { token: staffToken });
    assert(staffMonitoring.status === 403, `Staff monitoring status ${staffMonitoring.status} !== 403`);
    console.log('    ✓ Staff diblokir (403) dari finance, payment settings, user management, dan monitoring.');

    // ── 4. Pengujian Serializer Dashboard per-Role ───────────────
    console.log('[4] Pengujian Serializer Dashboard (Sembunyikan Omset dari Staff)...');
    const staffDash = await request('/api/dashboard/sumber-informasi', { token: staffToken });
    assert(staffDash.status === 200, `Staff dashboard status ${staffDash.status} !== 200`);
    assert(staffDash.body.summary.total_revenue === undefined, 'Staff tidak boleh melihat summary.total_revenue');
    assert(staffDash.body.summary.top_revenue_amount === undefined, 'Staff tidak boleh melihat summary.top_revenue_amount');
    if (staffDash.body.distribution.length > 0) {
      assert(staffDash.body.distribution[0].total_revenue === undefined, 'Staff tidak boleh melihat distribution.total_revenue');
    }

    const ownerDash = await request('/api/dashboard/sumber-informasi', { token: ownerToken });
    assert(ownerDash.status === 200, `Owner dashboard status ${ownerDash.status} !== 200`);
    assert(ownerDash.body.summary.total_revenue !== undefined, 'Owner harus bisa melihat summary.total_revenue');
    console.log('    ✓ Serializer dashboard berhasil menyembunyikan nominal revenue untuk Staff.');

    // ── 5. Pengujian Akses Staff ke Audit (Hanya Milik Sendiri) ──
    console.log('[5] Pengujian Audit Log Scoping...');
    // Catat satu aksi oleh owner dan satu oleh staff
    await db.query(
      `INSERT INTO audit_log (actor_id, actor_role, aksi, entitas, entitas_id, created_at)
       VALUES ($1, 'owner', 'test.owner_action', 'booking', '999', now() - INTERVAL '1 minute')`,
      [owner.id]
    );
    await db.query(
      `INSERT INTO audit_log (actor_id, actor_role, aksi, entitas, entitas_id, created_at)
       VALUES ($1, 'staff', 'test.staff_action', 'booking', '999', now())`,
      [staff.id]
    );

    const staffAudit = await request('/api/audit', { token: staffToken });
    assert(staffAudit.status === 200, `Staff audit status ${staffAudit.status} !== 200`);
    const allStaffItemsMatch = staffAudit.body.items.every(it => it.actor_id === staff.id);
    assert(allStaffItemsMatch, 'Staff tidak boleh melihat log audit milik pengguna lain!');

    const ownerAudit = await request('/api/audit', { token: ownerToken });
    assert(ownerAudit.status === 200, `Owner audit status ${ownerAudit.status} !== 200`);
    const hasOtherActors = ownerAudit.body.items.some(it => it.actor_id === staff.id);
    assert(hasOtherActors, 'Owner harus dapat melihat log semua aktor');
    console.log('    ✓ Staff hanya bisa melihat audit log miliknya sendiri; Owner bisa melihat semua.');

    // ── 6. Pengujian Aksi Sensitif Staff: Delete Booking ─────────
    console.log('[6] Pengujian Pengalihan Approval untuk Aksi Sensitif Staff...');
    const staffDeleteBooking = await request(`/api/bookings/admin/${testBooking.id}`, {
      method: 'DELETE',
      token: staffToken
    });
    assert(staffDeleteBooking.status === 202, `Staff delete booking harus 202 Accepted, got ${staffDeleteBooking.status}`);
    assert(staffDeleteBooking.body.status === 'pending_approval', 'Status respon harus pending_approval');
    assert(staffDeleteBooking.body.approval_id !== undefined, 'Harus mengembalikan approval_id');
    console.log(`    ✓ Penghapusan booking oleh staff dialihkan ke approval (ID: ${staffDeleteBooking.body.approval_id}).`);

    // ── 7. Pengujian Owner: Akses Penuh, User Management & Monitoring
    console.log('[7] Pengujian Fitur Owner (User CRUD & Monitoring)...');
    const ownerFinance = await request('/api/finance/summary', { token: ownerToken });
    assert(ownerFinance.status === 200, `Owner finance status ${ownerFinance.status} !== 200`);

    const ownerPaymentAdmin = await request('/api/settings/payment/admin', { token: ownerToken });
    assert(ownerPaymentAdmin.status === 200, `Owner payment admin status ${ownerPaymentAdmin.status} !== 200`);

    // Owner membuat staf baru
    const newStaffRes = await request('/api/users', {
      method: 'POST',
      token: ownerToken,
      body: {
        nama: 'Staff Baru Via API',
        email: `newstaff_${ts}@test.com`,
        password: 'PasswordBaru123!',
        role: 'staff'
      }
    });
    assert(newStaffRes.status === 201, `Owner create staff status ${newStaffRes.status} !== 201`);
    assert(newStaffRes.body.user.role === 'staff', 'Role user baru harus staff');

    // Owner melihat monitoring staf
    const monitorRes = await request('/api/monitoring/staff', { token: ownerToken });
    assert(monitorRes.status === 200, `Monitoring status ${monitorRes.status} !== 200`);
    assert(Array.isArray(monitorRes.body.staff_metrics), 'staff_metrics harus berupa array');

    // Owner melihat history booking
    const histRes = await request(`/api/bookings/admin/${testBooking.id}/history`, { token: ownerToken });
    assert(histRes.status === 200, `Booking history status ${histRes.status} !== 200`);
    assert(Array.isArray(histRes.body.history), 'history harus berupa array');
    console.log('    ✓ Owner dapat mengelola staff, melihat metrik monitoring, dan riwayat audit booking.');

    // ── 8. Pengujian Optimistic Locking ─────────────────────────
    console.log('[8] Pengujian Optimistic Locking pada Update Booking...');
    const conflictUpdate = await request(`/api/bookings/admin/${testBooking.id}`, {
      method: 'PUT',
      token: ownerToken,
      body: {
        client_name: 'Client F5 Updated Stale',
        client_phone: '081299887766',
        event_date: '2026-12-01',
        version: 999 // Versi salah / basi
      }
    });
    assert(conflictUpdate.status === 409, `Update stale version harus 409 Conflict, got ${conflictUpdate.status}`);

    const validUpdate = await request(`/api/bookings/admin/${testBooking.id}`, {
      method: 'PUT',
      token: ownerToken,
      body: {
        client_name: 'Client F5 Updated Valid',
        client_phone: '081299887766',
        event_date: '2026-12-01',
        version: testBooking.version // Versi cocok
      }
    });
    assert(validUpdate.status === 200, `Update valid version harus 200 OK, got ${validUpdate.status}`);
    console.log('    ✓ Optimistic locking berfungsi: 409 untuk version mismatch dan 200 untuk version valid.');

    console.log('\n=== SEMUA PENGUJIAN FASE 5 BERHASIL (HIJAU) ===\n');
  } finally {
    // Cleanup data uji
    await db.query(`DELETE FROM users WHERE id IN ($1, $2)`, [owner.id, staff.id]);
    await db.query(`DELETE FROM bookings WHERE id = $1`, [testBooking.id]);
    await db.query(`DELETE FROM booking_categories WHERE id = $1`, [category.id]);
    server.close();
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ TEST FASE 5 GAGAL:', err);
    if (server) server.close();
    process.exit(1);
  });
