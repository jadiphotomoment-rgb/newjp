'use strict';

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const { EventEmitter } = require('events');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';
const ownerToken = jwt.sign({ sub: 1, role: 'owner', nama: 'Owner Test' }, JWT_SECRET);
const staffToken = jwt.sign({ sub: 2, role: 'staff', nama: 'Staff Test' }, JWT_SECRET);

// Dummy database state
const mockTermsVersions = [
  {
    id: 1,
    version_number: 1,
    title: 'Syarat & Ketentuan Umum Layanan Studio',
    content_points: [
      'Poin 1: Wajib hadir tepat waktu',
      'Poin 2: DP non-refundable'
    ],
    status: 'active',
    created_by: 1,
    published_at: new Date().toISOString()
  }
];

const mockTermsAcceptances = [];
const mockBookings = [];
let shouldFailAcceptanceInsert = false;
let uncommittedBookings = [];

// Mock database module
const mockDb = {
  query: async (sql, params = []) => {
    const s = sql.toLowerCase();
    if (s.includes('from terms_versions') && s.includes("status = 'active'")) {
      const active = mockTermsVersions.filter(v => v.status === 'active');
      return { rows: active };
    }
    if (s.includes('from terms_versions') && s.includes("status = 'draft'")) {
      const draft = mockTermsVersions.filter(v => v.status === 'draft');
      return { rows: draft };
    }
    if (s.includes('from terms_versions') && s.includes('where tv.id = $1')) {
      const found = mockTermsVersions.filter(v => v.id === params[0]);
      return { rows: found };
    }
    if (s.includes('from terms_versions')) {
      return { rows: [...mockTermsVersions] };
    }
    if (s.includes('from terms_acceptances') && s.includes('where ta.verification_token = $1')) {
      const found = mockTermsAcceptances.filter(a => a.verification_token === params[0]);
      return { rows: found };
    }
    if (s.includes('from terms_acceptances') && s.includes('where ta.booking_id = $1')) {
      const found = mockTermsAcceptances.filter(a => a.booking_id === params[0]);
      return { rows: found };
    }
    if (s.includes('from booking_categories')) {
      return {
        rows: [{
          id: 1,
          slug: 'prewedding',
          name: 'Prewedding',
          dp_type: 'fixed',
          dp_value: 500000,
          time_slots: [],
          packages: []
        }]
      };
    }
    return { rows: [] };
  },
  getClient: async () => {
    return {
      query: async (sql, params = []) => {
        const s = sql.toLowerCase();
        if (s.includes('begin')) {
          uncommittedBookings = [];
          return { rows: [] };
        }
        if (s.includes('commit')) {
          mockBookings.push(...uncommittedBookings);
          uncommittedBookings = [];
          return { rows: [] };
        }
        if (s.includes('rollback')) {
          uncommittedBookings = [];
          return { rows: [] };
        }
        if (s.includes('select coalesce(max(version_number), 0) + 1')) {
          const max = mockTermsVersions.reduce((m, v) => Math.max(m, v.version_number), 0);
          return { rows: [{ next_ver: max + 1 }] };
        }
        if (s.includes("update terms_versions") && s.includes("set status = 'archived'")) {
          mockTermsVersions.forEach(v => {
            if (v.status === 'active') v.status = 'archived';
          });
          return { rows: [] };
        }
        if (s.includes("delete from terms_versions where status = 'draft'")) {
          const idx = mockTermsVersions.findIndex(v => v.status === 'draft');
          if (idx !== -1) mockTermsVersions.splice(idx, 1);
          return { rows: [] };
        }
        if (s.includes('insert into terms_versions')) {
          const newId = mockTermsVersions.length + 1;
          const newRow = {
            id: newId,
            version_number: params[0],
            title: params[1],
            content_points: JSON.parse(params[2]),
            status: 'active',
            created_by: params[3],
            published_at: new Date().toISOString()
          };
          mockTermsVersions.push(newRow);
          return { rows: [newRow] };
        }
        if (s.includes('insert into bookings')) {
          const newId = mockBookings.length + uncommittedBookings.length + 1;
          const b = { id: newId, client_name: params[1], terms_accepted_at: new Date() };
          uncommittedBookings.push(b);
          return { rows: [{ id: newId }] };
        }
        if (s.includes('insert into terms_acceptances')) {
          if (shouldFailAcceptanceInsert) {
            throw new Error('SIMULATED_DB_ERROR: Gagal insert terms_acceptances');
          }
          const newId = mockTermsAcceptances.length + 1;
          const ta = {
            id: newId,
            booking_id: params[0],
            terms_version_id: params[1],
            snapshot_text: params[2],
            verification_token: params[3],
            client_name: params[4],
            client_phone: params[5],
            ip_address: params[6],
            user_agent: params[7],
            accepted_at: new Date().toISOString()
          };
          mockTermsAcceptances.push(ta);
          return { rows: [ta] };
        }
        return { rows: [] };
      },
      release: () => {}
    };
  }
};

// Override database in require cache
const dbPath = require.resolve('../database');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: mockDb
};

// Override tokenVersionCache to allow JWT auth without real DB users table
const cachePath = require.resolve('../utils/tokenVersionCache');
require.cache[cachePath] = {
  id: cachePath,
  filename: cachePath,
  loaded: true,
  exports: {
    getUserState: async (id) => ({ id, is_active: true, token_version: 0, must_change_password: false }),
    invalidateUserState: () => {}
  }
};

// Load routes
const { publicRouter, adminRouter, clearActiveTermsCache } = require('../routes/terms');
const bookingsRouter = require('../routes/bookings');

const app = express();
app.use(express.json());
app.use('/api/terms', publicRouter);
app.use('/api/admin/terms', adminRouter);
app.use('/api/bookings', bookingsRouter);

// In-memory request simulator (no network sockets needed)
function request(method, urlPath, body = null, token = null) {
  return new Promise((resolve) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;

    const req = new EventEmitter();
    req.method = method;
    req.url = urlPath;
    req.originalUrl = urlPath;
    req.headers = headers;
    req.body = body || {};
    req.query = {};
    req.params = {};
    req.socket = { remoteAddress: '127.0.0.1' };

    let statusCode = 200;
    let resHeaders = {};
    let responseBody = null;

    const res = {
      statusCode: 200,
      setHeader: (k, v) => { resHeaders[k.toLowerCase()] = v; },
      getHeader: (k) => resHeaders[k.toLowerCase()],
      status: function (code) { statusCode = code; this.statusCode = code; return this; },
      json: function (obj) { responseBody = obj; resolve({ status: statusCode, body: responseBody }); },
      send: function (str) {
        try { responseBody = JSON.parse(str); } catch (_) { responseBody = str; }
        resolve({ status: statusCode, body: responseBody });
      },
      end: function () { resolve({ status: statusCode, body: responseBody }); }
    };

    app.handle(req, res, (err) => {
      if (err) {
        resolve({ status: 500, body: { error: err.message } });
      } else {
        resolve({ status: 404, body: { error: 'Not found' } });
      }
    });
  });
}

async function run() {
  console.log('=== [PENGUJIAN TAHAP 4: T&C KONFIRMASI BOOKING] ===\n');

  // Checklist Item 1: Submit booking tanpa centang
  console.log('Test 1: Submit booking tanpa centang (API ditolak 400)...');
  let res = await request('POST', '/api/bookings/prewedding', {
    clientName: 'Budi Test',
    clientPhone: '08123456789',
    eventDate: '2026-12-01',
    terms_version_id: 1,
    terms_accepted: false
  });
  assert.strictEqual(res.status, 400, 'Harus ditolak status 400');
  assert.match(res.body.error, /wajib.*menyetujui/i, 'Pesan error harus jelas');
  console.log('  ✅ PASS: Submit booking tanpa persetujuan ditolak 400.');

  // Checklist Item 2: Booking sukses -> terms_acceptances terbentuk lengkap
  console.log('Test 2: Booking sukses (terms_acceptances terbentuk dengan snapshot, waktu, IP, UA)...');
  res = await request('POST', '/api/bookings/prewedding', {
    clientName: 'Klien Sukses 1',
    clientPhone: '0811223344',
    eventDate: '2026-12-05',
    terms_version_id: 1,
    terms_accepted: true
  });
  assert.strictEqual(res.status, 201, 'Booking sukses harus 201');
  const booking1Id = res.body.bookingId;
  const token1 = res.body.terms_token;
  assert(booking1Id > 0);
  assert(token1 && token1.length >= 16);

  const savedAcceptance = mockTermsAcceptances.find(a => a.booking_id === booking1Id);
  assert(savedAcceptance, 'Data terms_acceptances harus tersimpan');
  assert(savedAcceptance.snapshot_text.includes('Poin 1: Wajib hadir tepat waktu'));
  assert(savedAcceptance.ip_address === '127.0.0.1');
  assert(savedAcceptance.accepted_at);
  console.log('  ✅ PASS: Baris terms_acceptances tersimpan lengkap dengan snapshot, waktu, dan IP.');

  // Checklist Item 3: Owner publish versi baru -> form klien versi baru, booking lama tetap snapshot lama
  console.log('Test 3: Owner publish versi baru (klien dapat versi baru, booking lama tetap isi lama)...');
  res = await request('POST', '/api/admin/terms/publish', {
    title: 'Syarat & Ketentuan Umum Versi 2',
    points: ['Poin Baru 1: Aturan Reschedule H-3', 'Poin Baru 2: Waktu Penyerahan Foto 7 Hari']
  }, ownerToken);
  assert.strictEqual(res.status, 201);
  clearActiveTermsCache();

  // Klien ambil versi aktif
  res = await request('GET', '/api/terms/active');
  assert.strictEqual(res.body.version_number, 2);
  assert.strictEqual(res.body.points[0], 'Poin Baru 1: Aturan Reschedule H-3');

  // Cek booking lama melalui verification token
  res = await request('GET', `/api/terms/verify/${token1}`);
  assert.strictEqual(res.status, 200);
  assert(res.body.snapshot_text.includes('Poin 1: Wajib hadir tepat waktu'), 'Snapshot booking lama tidak boleh berubah');
  console.log('  ✅ PASS: Publish versi 2 aktif, form klien mendapat versi 2, booking lama tetap snapshot lama.');

  // Checklist Item 4: Akses endpoint T&C terbuka untuk semua role terautentikasi (staff, admin, owner); unauthenticated ditolak 401
  console.log('Test 4: Akses T&C terbuka untuk Staf/Admin/Owner, unauthenticated ditolak 401...');
  res = await request('GET', '/api/admin/terms', null, staffToken);
  assert.strictEqual(res.status, 200, 'Staff harus bisa melihat daftar T&C');

  res = await request('PUT', '/api/admin/terms/draft', { title: 'Draf oleh Staff', points: ['Poin Staff 1'] }, staffToken);
  assert.strictEqual(res.status, 200, 'Staff harus bisa menyimpan draf T&C');

  res = await request('GET', '/api/admin/terms', null, null);
  assert.strictEqual(res.status, 401, 'User tanpa autentikasi harus ditolak 401');
  console.log('  ✅ PASS: Role Staff dapat mengakses & mengedit T&C, unauthenticated ditolak 401.');

  // Checklist Item 5: Publish poin kosong atau tanpa perubahan -> Ditolak pesan jelas
  console.log('Test 5: Publish dengan poin kosong atau tanpa perubahan...');
  res = await request('POST', '/api/admin/terms/publish', { title: 'Kosong', points: [] }, ownerToken);
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /tidak boleh kosong/i);

  res = await request('POST', '/api/admin/terms/publish', {
    title: 'Syarat & Ketentuan Umum Versi 2',
    points: ['Poin Baru 1: Aturan Reschedule H-3', 'Poin Baru 2: Waktu Penyerahan Foto 7 Hari']
  }, ownerToken);
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /tidak berubah/i);
  console.log('  ✅ PASS: Publish poin kosong & tanpa perubahan ditolak pesan jelas.');

  // Checklist Item 6: Gagal insert persetujuan -> Booking dibatalkan (Rollback transaksi)
  console.log('Test 6: Gagal insert persetujuan (Transaction rollback: booking tidak tersimpan)...');
  const countBefore = mockBookings.length;
  shouldFailAcceptanceInsert = true;
  res = await request('POST', '/api/bookings/prewedding', {
    clientName: 'Klien Gagal Transaksi',
    clientPhone: '0899887766',
    eventDate: '2026-12-10',
    terms_version_id: 2,
    terms_accepted: true
  });
  assert.strictEqual(res.status, 500, 'Harus gagal 500 saat DB error');
  const countAfter = mockBookings.length;
  assert.strictEqual(countBefore, countAfter, 'Booking tidak boleh tersimpan karena transaksi di-rollback');
  shouldFailAcceptanceInsert = false;
  console.log('  ✅ PASS: Transaksi di-rollback total, booking tidak tertinggal di database.');

  // Checklist Item 7: Booking lama tanpa persetujuan -> Tampil "Belum ada catatan T&C"
  console.log('Test 7: Booking lama tanpa persetujuan (Tampil "Belum ada catatan T&C")...');
  res = await request('GET', '/api/bookings/admin/99999/terms', null, staffToken);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.accepted, false);
  assert.strictEqual(res.body.message, 'Belum ada catatan T&C');
  console.log('  ✅ PASS: Booking lama tidak error dan memberikan respons "Belum ada catatan T&C".');

  console.log('\n=============================================================');
  console.log('🏆 SEMUA 7 CHECKLIST TAHAP 4 (UJI & PENUTUP) 100% LULUS / PASS');
  console.log('=============================================================');
}

run().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
