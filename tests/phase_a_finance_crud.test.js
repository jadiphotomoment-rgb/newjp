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
  console.log('--- TEST FITUR A: CRUD TRANSAKSI KEUANGAN ---');
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
  const staffRes = await db.query("SELECT id, nama, email, role, token_version FROM users WHERE role = 'staff' AND is_active = true LIMIT 1");

  if (!ownerRes.rows[0] || !staffRes.rows[0]) {
    console.error('Owner atau Staff tidak ditemukan');
    process.exit(1);
  }
  const owner = ownerRes.rows[0];
  const staff = staffRes.rows[0];
  const ownerToken = createToken(owner);
  const staffToken = createToken(staff);

  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  let createdTxId1 = null;
  let createdTxId2 = null;
  let testBookingId = null;

  try {
    // 1. GET /api/finance/transactions tanpa token -> 401
    const unauth = await request('/api/finance/transactions');
    assert(unauth.status === 401, 'GET /api/finance/transactions tanpa token tolak 401');

    // 2. GET /api/finance/transactions dengan staff token -> 403
    const staffForbidden = await request('/api/finance/transactions', { token: staffToken });
    assert(staffForbidden.status === 403, 'GET /api/finance/transactions role staff tolak 403');

    // 3. POST /api/finance/transactions tolak tipe invalid
    const badTipe = await request('/api/finance/transactions', {
      method: 'POST',
      token: ownerToken,
      body: { tipe: 'investasi', kategori: 'Modal', nominal: 100000 }
    });
    assert(badTipe.status === 400, 'POST /api/finance/transactions tolak tipe tidak valid (400)');

    // 4. POST /api/finance/transactions tolak nominal negatif
    const negNominal = await request('/api/finance/transactions', {
      method: 'POST',
      token: ownerToken,
      body: { tipe: 'masuk', kategori: 'Test', nominal: -50000 }
    });
    assert(negNominal.status === 400, 'POST /api/finance/transactions tolak nominal negatif (400)');

    // 5. POST /api/finance/transactions buat pemasukan manual sukses
    const createIn = await request('/api/finance/transactions', {
      method: 'POST',
      token: ownerToken,
      body: {
        tanggal: '2026-10-20',
        tipe: 'masuk',
        kategori: 'Pendapatan Proyek',
        nominal: 750000,
        keterangan: 'Pemasukan Uji Kas'
      }
    });
    assert(createIn.status === 201 && createIn.data.transaction, 'POST buat pemasukan manual sukses (201)');
    createdTxId1 = createIn.data.transaction?.id;
    assert(createIn.data.transaction.source === 'manual', 'Transaksi manual memiliki source = "manual"');

    // 6. POST /api/finance/transactions buat pengeluaran manual sukses
    const createOut = await request('/api/finance/transactions', {
      method: 'POST',
      token: ownerToken,
      body: {
        tanggal: '2026-10-20',
        tipe: 'keluar',
        kategori: 'Operasional Studio',
        nominal: 250000,
        keterangan: 'Beli Perlengkapan Studio'
      }
    });
    assert(createOut.status === 201 && createOut.data.transaction, 'POST buat pengeluaran manual sukses (201)');
    createdTxId2 = createOut.data.transaction?.id;

    // 7. GET /api/finance/transactions verifikasi rekap summary di server
    const listRes = await request('/api/finance/transactions?start_date=2026-10-20&end_date=2026-10-20', { token: ownerToken });
    assert(listRes.status === 200, 'GET list transaksi berparameter tanggal sukses (200)');
    const sum = listRes.data.summary;
    assert(sum.total_income >= 750000, `Rekap total_income valid (${sum.total_income})`);
    assert(sum.total_expense >= 250000, `Rekap total_expense valid (${sum.total_expense})`);
    assert(sum.balance === (sum.total_income - sum.total_expense), 'Saldo dihitung akurat di server (income - expense)');

    // 8. PUT /api/finance/transactions/:id update nominal transaksi
    const updateRes = await request(`/api/finance/transactions/${createdTxId1}`, {
      method: 'PUT',
      token: ownerToken,
      body: { nominal: 800000, keterangan: 'Pemasukan Uji Kas (Diperbarui)' }
    });
    assert(updateRes.status === 200 && updateRes.data.transaction.nominal == 800000, 'PUT /api/finance/transactions/:id sukses update nominal');

    // 9. Transaksi terkait Booking: buat booking uji
    const bRes = await db.query(`
      INSERT INTO bookings (client_name, client_phone, event_date, status, package_price, dp_amount, paid_amount)
      VALUES ('Klien Tes Keuangan', '081299991111', '2026-11-25', 'pending', 1000000, 300000, 0)
      RETURNING id, paid_amount
    `);
    testBookingId = bRes.rows[0].id;

    // Buat transaksi kas masuk dengan booking_id
    const txBooking = await request('/api/finance/transactions', {
      method: 'POST',
      token: ownerToken,
      body: {
        tipe: 'masuk',
        kategori: 'DP Booking',
        nominal: 300000,
        keterangan: 'DP Booking Klien Tes',
        booking_id: testBookingId
      }
    });
    assert(txBooking.status === 201, 'POST transaksi terkait booking_id sukses (201)');
    const txBId = txBooking.data.transaction.id;
    assert(txBooking.data.transaction.source === 'booking', 'Transaksi dengan booking_id diset source = "booking"');

    // Verifikasi paid_amount booking tersinkronisasi
    const checkB = await db.query('SELECT paid_amount FROM bookings WHERE id = $1', [testBookingId]);
    assert(parseFloat(checkB.rows[0].paid_amount) === 300000, 'Nilai paid_amount booking otomatis tersinkronisasi (300000)');

    // 10. DELETE /api/finance/transactions/:id (Soft Delete)
    const delRes = await request(`/api/finance/transactions/${txBId}`, {
      method: 'DELETE',
      token: ownerToken
    });
    assert(delRes.status === 200, 'DELETE transaksi sukses (200)');

    // Verifikasi soft delete: deleted_at terisi, status = batal di DB
    const checkTxDb = await db.query('SELECT deleted_at, status FROM financial_entries WHERE id = $1', [txBId]);
    assert(checkTxDb.rows[0].deleted_at !== null && checkTxDb.rows[0].status === 'batal', 'Data di DB memiliki deleted_at dan status batal (tidak dihapus fisik)');

    // Verifikasi booking paid_amount terhitung ulang setelah transaksi dihapus
    const checkBAfter = await db.query('SELECT paid_amount FROM bookings WHERE id = $1', [testBookingId]);
    assert(parseFloat(checkBAfter.rows[0].paid_amount) === 0, 'paid_amount booking otomatis berkurang setelah transaksi dihapus');

    // Transaksi yang di-soft-delete tidak muncul di list
    const listAfter = await request('/api/finance/transactions', { token: ownerToken });
    const existsInList = listAfter.data.transactions.some(t => t.id === txBId);
    assert(!existsInList, 'Transaksi soft-deleted tidak muncul pada query list');

    console.log(`\nHasil: ${passed}/${total} test lulus.`);
    if (passed !== total) process.exit(1);
  } finally {
    // Cleanup data pengujian
    if (createdTxId1) await db.query('DELETE FROM financial_entries WHERE id = $1', [createdTxId1]).catch(() => {});
    if (createdTxId2) await db.query('DELETE FROM financial_entries WHERE id = $1', [createdTxId2]).catch(() => {});
    if (testBookingId) {
      await db.query('DELETE FROM financial_entries WHERE booking_id = $1', [testBookingId]).catch(() => {});
      await db.query('DELETE FROM bookings WHERE id = $1', [testBookingId]).catch(() => {});
    }
    if (server) server.close();
  }
}

run().then(() => {
  console.log('Fitur A test selesai dengan sukses.');
  process.exit(0);
}).catch((err) => {
  console.error('Test error:', err);
  if (server) server.close();
  process.exit(1);
});
