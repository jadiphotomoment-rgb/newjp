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
        if (s.includes('begin') || s.includes('commit') || s.includes('rollback')) {
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
          const newId = mockBookings.length + 1;
          const b = { id: newId, client_name: params[1], terms_accepted_at: new Date() };
          mockBookings.push(b);
          return { rows: [{ id: newId }] };
        }
        if (s.includes('insert into terms_acceptances')) {
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
  console.log('[TEST] Menjalankan test Tahap 2 Backend (in-memory)...');

  // 1. Test GET /api/terms/active
  console.log('1. Menguji GET /api/terms/active...');
  let res = await request('GET', '/api/terms/active');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.version_number, 1);
  assert.strictEqual(res.body.points.length, 2);
  console.log('  PASS: Versi aktif berhasil didapatkan.');

  // 2. Test Staff/Non-owner access to /api/admin/terms (Harus 403)
  console.log('2. Menguji akses non-owner ke /api/admin/terms...');
  res = await request('GET', '/api/admin/terms', null, staffToken);
  assert.strictEqual(res.status, 403);
  console.log('  PASS: Staff ditolak 403 Forbidden.');

  // 3. Test Owner access to /api/admin/terms
  console.log('3. Menguji akses owner ke /api/admin/terms...');
  res = await request('GET', '/api/admin/terms', null, ownerToken);
  assert.strictEqual(res.status, 200);
  assert(Array.isArray(res.body.data));
  console.log('  PASS: Owner berhasil mengambil daftar versi T&C.');

  // 4. Test Publish dengan poin kosong (Harus 400)
  console.log('4. Menguji publish dengan poin kosong...');
  res = await request('POST', '/api/admin/terms/publish', { title: 'Baru', points: [] }, ownerToken);
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /tidak boleh kosong/i);
  console.log('  PASS: Publish poin kosong ditolak 400.');

  // 5. Test Publish dengan isi yang sama persis (Harus 400)
  console.log('5. Menguji publish dengan isi tanpa perubahan...');
  res = await request('POST', '/api/admin/terms/publish', {
    title: 'Syarat & Ketentuan Umum Layanan Studio',
    points: ['Poin 1: Wajib hadir tepat waktu', 'Poin 2: DP non-refundable']
  }, ownerToken);
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /tidak berubah/i);
  console.log('  PASS: Publish tanpa perubahan ditolak 400.');

  // 6. Test Publish versi baru valid
  console.log('6. Menguji publish versi baru valid...');
  res = await request('POST', '/api/admin/terms/publish', {
    title: 'Syarat & Ketentuan Update V2',
    points: ['Poin 1 baru', 'Poin 2 baru', 'Poin 3 baru']
  }, ownerToken);
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.data.version_number, 2);
  clearActiveTermsCache();
  console.log('  PASS: Versi 2 berhasil dipublikasikan.');

  // Cek apakah GET /api/terms/active sudah terupdate ke versi 2
  res = await request('GET', '/api/terms/active');
  assert.strictEqual(res.body.version_number, 2);
  const activeVersionId = res.body.id;

  // 7. Test Submit booking tanpa checkbox persetujuan (Harus 400)
  console.log('7. Menguji submit booking tanpa persetujuan T&C...');
  res = await request('POST', '/api/bookings/prewedding', {
    clientName: 'Budi Test',
    clientPhone: '08123456789',
    eventDate: '2026-12-01',
    terms_version_id: activeVersionId,
    terms_accepted: false
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /wajib.*menyetujui/i);
  console.log('  PASS: Booking tanpa persetujuan ditolak 400.');

  // 8. Test Submit booking dengan version mismatch (Harus 400)
  console.log('8. Menguji submit booking dengan version id tidak valid...');
  res = await request('POST', '/api/bookings/prewedding', {
    clientName: 'Budi Test',
    clientPhone: '08123456789',
    eventDate: '2026-12-01',
    terms_version_id: 9999,
    terms_accepted: true
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /tidak valid/i);
  console.log('  PASS: Booking dengan version id salah ditolak 400.');

  // 9. Test Submit booking sukses dengan persetujuan T&C
  console.log('9. Menguji submit booking sukses dengan persetujuan T&C...');
  res = await request('POST', '/api/bookings/prewedding', {
    clientName: 'Budi Sukses',
    clientPhone: '08123456789',
    eventDate: '2026-12-01',
    terms_version_id: activeVersionId,
    terms_accepted: true
  });
  assert.strictEqual(res.status, 201);
  assert(res.body.bookingId > 0);
  assert(res.body.terms_token);
  const newBookingId = res.body.bookingId;
  const verificationToken = res.body.terms_token;
  console.log('  PASS: Booking berhasil dibuat beserta catatan persetujuan.');

  // 10. Test Verifikasi publik lewat token: GET /api/terms/verify/:token
  console.log('10. Menguji verifikasi publik T&C via token...');
  res = await request('GET', `/api/terms/verify/${verificationToken}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.valid, true);
  assert.strictEqual(res.body.client_name, 'Budi Sukses');
  assert.match(res.body.snapshot_text, /Poin 1 baru/);
  console.log('  PASS: Verifikasi bukti persetujuan via token berhasil.');

  // 11. Test GET /api/bookings/admin/:id/terms
  console.log('11. Menguji admin ambil catatan T&C booking...');
  res = await request('GET', `/api/bookings/admin/${newBookingId}/terms`, null, staffToken);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.accepted, true);
  assert.strictEqual(res.body.data.booking_id, newBookingId);
  console.log('  PASS: Endpoint admin detail persetujuan T&C berhasil.');

  console.log('\n✅ SEMUA PENGUJIAN TAHAP 2 (BACKEND) BERHASIL 100% PASS!');
}

run().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
