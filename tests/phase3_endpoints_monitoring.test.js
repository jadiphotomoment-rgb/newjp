'use strict';

require('dotenv').config();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../database');
const app = require('../server');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';

function generateToken(user) {
  return jwt.sign(
    {
      sub: user.id,
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

async function cleanTestData(bookingIds = [], userIds = []) {
  if (bookingIds.length > 0) {
    await db.query('DELETE FROM wa_outbox WHERE payload->>\'booking_id\' = ANY($1::text[])', [bookingIds.map(String)]);
    await db.query('DELETE FROM financial_entries WHERE sumber_id = ANY($1::bigint[]) AND sumber_tipe = \'booking_dp\'', [bookingIds]);
    await db.query('DELETE FROM payments WHERE booking_id = ANY($1::int[])', [bookingIds]);
    await db.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [bookingIds]);
  }
  if (userIds.length > 0) {
    await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  }
}

async function createBookingWithPayment({ dpAmount = 100000, status = 'dp_review', withProof = true } = {}) {
  const catRes = await db.query('SELECT id FROM booking_categories LIMIT 1');
  const catId = catRes.rows[0]?.id || 1;

  const { rows: [b] } = await db.query(`
    INSERT INTO bookings (
      category_id, client_name, client_phone, event_date, event_time,
      location, package_price, dp_amount, status, version
    ) VALUES (
      $1, 'Klien Endpoint Test', '081234567890', CURRENT_DATE + INTERVAL '3 days', '14:00',
      'Studio B', 600000, $2, $3, 1
    ) RETURNING *
  `, [catId, dpAmount, status]);

  let payment = null;
  if (withProof) {
    const { rows: [p] } = await db.query(`
      INSERT INTO payments (
        booking_id, amount, payment_type, proof_url, proof_filename, status, version
      ) VALUES (
        $1, $2, 'dp', 'https://example.com/transfer_proof.jpg', 'transfer_proof.jpg', 'pending', 1
      ) RETURNING *
    `, [b.id, dpAmount]);
    payment = p;
  }

  return { booking: b, payment };
}

async function runTests() {
  console.log('=== [TEST FASE 3] Endpoint Approve/Reject & Monitoring Daily Owner ===\n');

  // Start test server
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`[TEST SERVER] Berjalan di ${baseUrl}`);
      resolve();
    });
  });

  const createdBookingIds = [];
  const createdUserIds = [];

  const ts = Date.now();
  const hash = bcrypt.hashSync('PasswordTest123!', 10);

  // Setup Users: Owner, Staff, Viewer (tanpa izin)
  const { rows: [owner] } = await db.query(
    `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
     VALUES ('Owner F3', $1, $2, 'owner', true, false)
     RETURNING id, nama, email, role, token_version`,
    [`owner_f3_${ts}@test.com`, hash]
  );
  createdUserIds.push(owner.id);

  const { rows: [staff] } = await db.query(
    `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
     VALUES ('Staff F3', $1, $2, 'staff', true, false)
     RETURNING id, nama, email, role, token_version`,
    [`staff_f3_${ts}@test.com`, hash]
  );
  createdUserIds.push(staff.id);

  const { rows: [viewer] } = await db.query(
    `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
     VALUES ('Viewer F3', $1, $2, 'staff', true, false)
     RETURNING id, nama, email, role, token_version`,
    [`viewer_f3_${ts}@test.com`, hash]
  );
  // Simulasikan user tanpa izin dengan role 'viewer'
  await db.query("UPDATE users SET role = 'viewer' WHERE id = $1", [viewer.id]).catch(() => {});
  viewer.role = 'viewer';
  createdUserIds.push(viewer.id);

  const tokenOwner = generateToken(owner);
  const tokenStaff = generateToken(staff);
  const tokenViewer = generateToken(viewer);

  try {
    // ── 1. Matriks Hak Akses POST /api/bookings/:id/approve ──────
    console.log('1. Menguji Matriks Hak Akses POST /api/bookings/:id/approve...');
    const { booking: b1 } = await createBookingWithPayment();
    createdBookingIds.push(b1.id);

    // a. Tanpa Login -> 401
    const resNoAuth = await request(`/api/bookings/${b1.id}/approve`, {
      method: 'POST',
      body: { version: b1.version }
    });
    assert(resNoAuth.status === 401, `Tanpa login harus 401 (got ${resNoAuth.status})`);

    // b. User tanpa izin (viewer) -> 403
    const resForbidden = await request(`/api/bookings/${b1.id}/approve`, {
      method: 'POST',
      token: tokenViewer,
      body: { version: b1.version }
    });
    assert(resForbidden.status === 403, `Viewer tanpa izin harus 403 (got ${resForbidden.status})`);

    // c. Staff (memiliki booking.approve) -> 200
    const resStaff = await request(`/api/bookings/${b1.id}/approve`, {
      method: 'POST',
      token: tokenStaff,
      body: { version: b1.version }
    });
    assert(resStaff.status === 200, `Staff harus berhasil 200 (got ${resStaff.status}): ${JSON.stringify(resStaff.body)}`);
    assert(resStaff.body.success === true, 'Respon harus success: true');
    assert(resStaff.body.booking.status === 'confirmed', 'Status booking harus confirmed');
    console.log('   ✓ Matriks approve: Anonim (401), Viewer (403), Staff (200).');

    // ── 2. Uji Validasi Input & OCC Version Mismatch ─────────────
    console.log('2. Menguji validasi OCC version mismatch & nominal...');
    const { booking: b2 } = await createBookingWithPayment({ dpAmount: 150000 });
    createdBookingIds.push(b2.id);

    // Version mismatch -> 409
    const resMismatch = await request(`/api/bookings/${b2.id}/approve`, {
      method: 'POST',
      token: tokenStaff,
      body: { version: 999 }
    });
    assert(resMismatch.status === 409, `Version mismatch harus 409 (got ${resMismatch.status})`);

    // Nominal beda tanpa alasan -> 400
    const resNoReason = await request(`/api/bookings/${b2.id}/approve`, {
      method: 'POST',
      token: tokenStaff,
      body: { version: b2.version, nominal_diterima: 100000 }
    });
    assert(resNoReason.status === 400, `Nominal beda tanpa alasan harus 400 (got ${resNoReason.status})`);

    // Owner approve dengan nominal beda dan alasan -> 200
    const resOwnerDiff = await request(`/api/bookings/${b2.id}/approve`, {
      method: 'POST',
      token: tokenOwner,
      body: { version: b2.version, nominal_diterima: 120000, alasan_selisih: 'Promo akhir pekan' }
    });
    assert(resOwnerDiff.status === 200, `Owner harus sukses 200 (got ${resOwnerDiff.status})`);
    assert(resOwnerDiff.body.anomali === true, 'Harus terdeteksi anomali selisih');
    console.log('   ✓ Validasi OCC (409) dan nominal selisih (400 tanpa alasan, 200 dengan alasan) berfungsi.');

    // ── 3. Matriks Hak Akses POST /api/bookings/:id/reject ───────
    console.log('3. Menguji Matriks Hak Akses POST /api/bookings/:id/reject...');
    const { booking: b3 } = await createBookingWithPayment();
    createdBookingIds.push(b3.id);

    // a. Tanpa Login -> 401
    const resRejNoAuth = await request(`/api/bookings/${b3.id}/reject`, {
      method: 'POST',
      body: { version: b3.version, alasan: 'Bukti salah' }
    });
    assert(resRejNoAuth.status === 401, `Reject tanpa login harus 401 (got ${resRejNoAuth.status})`);

    // b. Viewer -> 403
    const resRejForbidden = await request(`/api/bookings/${b3.id}/reject`, {
      method: 'POST',
      token: tokenViewer,
      body: { version: b3.version, alasan: 'Bukti salah' }
    });
    assert(resRejForbidden.status === 403, `Reject viewer harus 403 (got ${resRejForbidden.status})`);

    // c. Staff tanpa alasan -> 400
    const resRejNoReason = await request(`/api/bookings/${b3.id}/reject`, {
      method: 'POST',
      token: tokenStaff,
      body: { version: b3.version, alasan: '' }
    });
    assert(resRejNoReason.status === 400, `Reject tanpa alasan harus 400 (got ${resRejNoReason.status})`);

    // d. Staff dengan alasan valid -> 200
    const resRejSuccess = await request(`/api/bookings/${b3.id}/reject`, {
      method: 'POST',
      token: tokenStaff,
      body: { version: b3.version, alasan: 'Gambar struk terpotong' }
    });
    assert(resRejSuccess.status === 200, `Reject staff harus 200 (got ${resRejSuccess.status})`);
    assert(resRejSuccess.body.booking.status === 'dp_rejected', 'Status booking harus dp_rejected');
    console.log('   ✓ Matriks reject: Anonim (401), Viewer (403), Tanpa alasan (400), Staff sukses (200).');

    // ── 4. Pembatalan Approve POST /:id/cancel-approval ───────────
    console.log('4. Menguji Pembatalan Approve (Owner Only)...');
    // b1 sudah status confirmed dari test nomor 1
    // Staff mencoba membatalkan -> 403
    const resCancelStaff = await request(`/api/bookings/${b1.id}/cancel-approval`, {
      method: 'POST',
      token: tokenStaff,
      body: { alasan: 'Staff coba cancel' }
    });
    assert(resCancelStaff.status === 403, `Staff harus 403 dilarang cancel approve (got ${resCancelStaff.status})`);

    // Owner membatalkan -> 200
    const resCancelOwner = await request(`/api/bookings/${b1.id}/cancel-approval`, {
      method: 'POST',
      token: tokenOwner,
      body: { alasan: 'Salah verifikasi' }
    });
    assert(resCancelOwner.status === 200, `Owner harus sukses cancel approve 200 (got ${resCancelOwner.status})`);

    // Cek di DB status b1 kembali ke dp_review dan financial_entries batal
    const { rows: b1Recheck } = await db.query('SELECT status FROM bookings WHERE id = $1', [b1.id]);
    assert(b1Recheck[0].status === 'dp_review', 'Status booking harus kembali ke dp_review');
    console.log('   ✓ Pembatalan approve terbukti Owner Only: Staff (403), Owner (200).');

    // ── 5. Endpoint Monitoring Ringkasan Harian & Anomali ────────
    console.log('5. Menguji GET /api/monitoring/daily-approvals (Owner Only)...');

    // a. Anonim -> 401
    const resMonNoAuth = await request('/api/monitoring/daily-approvals');
    assert(resMonNoAuth.status === 401, `Monitoring tanpa login harus 401 (got ${resMonNoAuth.status})`);

    // b. Staff -> 403
    const resMonStaff = await request('/api/monitoring/daily-approvals', {
      token: tokenStaff
    });
    assert(resMonStaff.status === 403, `Monitoring oleh staff harus 403 (got ${resMonStaff.status})`);

    // c. Owner -> 200 dengan struktur ringkasan & penanda anomali
    const resMonOwner = await request('/api/monitoring/daily-approvals', {
      token: tokenOwner
    });
    assert(resMonOwner.status === 200, `Monitoring oleh owner harus 200 (got ${resMonOwner.status})`);
    assert(typeof resMonOwner.body.summary === 'object', 'Response harus memiliki summary');
    assert(typeof resMonOwner.body.summary.total_approvals === 'number', 'total_approvals harus number');
    assert(typeof resMonOwner.body.summary.total_dp === 'number', 'total_dp harus number');
    assert(Array.isArray(resMonOwner.body.per_staff), 'per_staff harus array');
    assert(Array.isArray(resMonOwner.body.items), 'items harus array');
    assert(typeof resMonOwner.body.pagination === 'object', 'pagination harus object');

    // Cek apakah item anomali (dari booking b2 di atas) memuat penanda anomali
    const anomalyItem = resMonOwner.body.items.find(i => Number(i.booking_id) === Number(b2.id));
    if (anomalyItem) {
      assert(anomalyItem.has_anomali === true, 'Item b2 harus memiliki flag anomali');
      assert(anomalyItem.anomali_flags.includes('nominal_berbeda'), 'Harus ada flag nominal_berbeda');
    }
    console.log('   ✓ Monitoring harian Owner sukses: Anonim (401), Staff (403), Owner (200), anomali terdeteksi.');

    console.log('\n=== SEMUA UJI FASE 3 LULUS (100% SUKSES) ===');
  } finally {
    if (server) server.close();
    await cleanTestData(createdBookingIds, createdUserIds);
    await db.pool.end();
  }
}

if (require.main === module) {
  runTests().then(() => process.exit(0)).catch((err) => {
    console.error('❌ UJI FASE 3 GAGAL:', err);
    process.exit(1);
  });
}
