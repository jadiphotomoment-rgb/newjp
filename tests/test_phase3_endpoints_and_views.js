'use strict';

const assert = require('assert');

// Mock Audit Service
require.cache[require.resolve('../services/audit')] = {
  exports: {
    record: async () => ({ id: 1 })
  }
};

// In-Memory Database Simulator for Phase 3 Testing
class MockDB {
  constructor() {
    this.bookings = [];
    this.payments = [];
    this.financial_entries = [];
    this.pelunasan = [];
    this.booking_categories = [
      { id: 1, name: 'Wedding', slug: 'wedding', color: '#6366f1', dp_type: 'percent', dp_value: '50' }
    ];
  }

  async getClient() {
    const self = this;
    return {
      async query(sql, params) {
        return self.query(sql, params);
      },
      release() {}
    };
  }

  async query(sql, params = []) {
    const s = sql.trim();

    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
      return { rows: [] };
    }

    // 1. SELECT bookings FOR UPDATE or simple
    if (s.includes('FROM bookings b') || (s.includes('FROM bookings') && s.includes('WHERE id = $1'))) {
      const bId = parseInt(params[0], 10);
      const found = this.bookings.find(b => b.id === bId && !b.deleted_at);
      if (!found) return { rows: [] };
      const cat = this.booking_categories.find(c => c.id === found.category_id) || {};
      return {
        rows: [{
          ...found,
          category_name: cat.name,
          category_slug: cat.slug,
          category_color: cat.color
        }]
      };
    }

    // 2. SELECT payments GROUP BY payment_type
    if (s.includes('FROM payments') && s.includes('WHERE booking_id = $1') && s.includes('GROUP BY payment_type')) {
      const bId = parseInt(params[0], 10);
      const groups = {};
      this.payments
        .filter(p => p.booking_id === bId && p.status === 'approved')
        .forEach(p => {
          groups[p.payment_type] = (groups[p.payment_type] || 0) + Number(p.amount);
        });
      const rows = Object.entries(groups).map(([payment_type, total_amount]) => ({
        payment_type,
        total_amount
      }));
      return { rows };
    }

    // 3. SELECT financial_entries GROUP BY tipe
    if (s.includes('FROM financial_entries') && s.includes('WHERE booking_id = $1') && s.includes('GROUP BY tipe')) {
      const bId = parseInt(params[0], 10);
      const groups = {};
      this.financial_entries
        .filter(f => f.booking_id === bId && f.sumber_tipe === 'booking_adjustment' && f.status === 'aktif')
        .forEach(f => {
          groups[f.tipe] = (groups[f.tipe] || 0) + Number(f.nominal);
        });
      const rows = Object.entries(groups).map(([tipe, total_nominal]) => ({
        tipe,
        total_nominal
      }));
      return { rows };
    }

    // 4. SELECT financial_entries detail riwayat
    if (s.includes('FROM financial_entries') && s.includes('sumber_tipe = \'booking_adjustment\'') && s.includes('ORDER BY id DESC')) {
      const bId = parseInt(params[0], 10);
      const rows = this.financial_entries
        .filter(f => f.booking_id === bId && f.sumber_tipe === 'booking_adjustment')
        .sort((a, b) => b.id - a.id);
      return { rows };
    }

    // 4.5 SELECT pelunasan by booking_id
    if (s.includes('FROM pelunasan p') && s.includes('p.booking_id = $1')) {
      const bId = parseInt(params[0], 10);
      return { rows: this.pelunasan.filter(p => p.booking_id === bId) };
    }

    // 5. SELECT pelunasan by token (GET /token/:token)
    if (s.includes('FROM pelunasan p') && s.includes('WHERE p.token = $1')) {
      const tok = params[0];
      const p = this.pelunasan.find(x => x.token === tok);
      if (!p) return { rows: [] };
      const book = this.bookings.find(b => b.id === p.booking_id) || {};
      const cat = this.booking_categories.find(c => c.id === book.category_id) || {};
      return {
        rows: [{
          ...p,
          client_name: book.client_name,
          event_date: book.event_date,
          event_time: book.event_time,
          location: book.location,
          package_name: book.package_name,
          category_name: cat.name,
          category_slug: cat.slug,
          category_color: cat.color
        }]
      };
    }

    // 6. SELECT payment_settings & bank_accounts
    if (s.includes('FROM payment_settings')) {
      return { rows: [{ id: 1, qris_image_url: '/img/qris.webp' }] };
    }
    if (s.includes('FROM bank_accounts')) {
      return { rows: [] };
    }

    // 7. SELECT payments list for detail
    if (s.includes('FROM payments') && (s.includes('booking_id = $1') || s.includes('p.booking_id = $1')) && !s.includes('GROUP BY')) {
      const bId = parseInt(params[0], 10);
      return { rows: this.payments.filter(p => p.booking_id === bId) };
    }

    // 8. SELECT attachments & terms_acceptances
    if (s.includes('FROM attachments') || s.includes('FROM terms_acceptances')) {
      return { rows: [] };
    }

    // 9. UPDATE bookings
    if (s.startsWith('UPDATE bookings')) {
      const bId = parseInt(params[params.length - 1], 10);
      const b = this.bookings.find(x => x.id === bId);
      if (b) {
        if (s.includes('paid_amount = $1')) {
          b.paid_amount = params[0];
          b.status = params[1];
        }
        b.version = (b.version || 1) + 1;
      }
      return { rows: b ? [{ ...b }] : [] };
    }

    // 10. UPDATE pelunasan
    if (s.includes('UPDATE pelunasan') && s.includes('SET total_tagihan')) {
      const [total, dp, sisa, bIdRaw] = params;
      const bId = parseInt(bIdRaw, 10);
      this.pelunasan
        .filter(p => p.booking_id === bId && ['sent', 'rejected'].includes(p.status))
        .forEach(p => {
          p.total_tagihan = total;
          p.dp_terbayar = dp;
          p.sisa_kekurangan = sisa;
        });
      return { rows: [] };
    }

    if (s.includes('UPDATE pelunasan') && s.includes('SET status = \'cancelled\'')) {
      const bId = parseInt(params[0], 10);
      this.pelunasan
        .filter(p => p.booking_id === bId && ['sent', 'rejected'].includes(p.status))
        .forEach(p => {
          p.status = 'cancelled';
        });
      return { rows: [] };
    }

    // 11. INSERT financial_entries
    if (s.startsWith('INSERT INTO financial_entries')) {
      const [tipe, kategori, nominal, booking_id, adjId, catatan, created_by] = params;
      this.financial_entries.push({
        id: this.financial_entries.length + 1,
        tanggal: '2026-11-17',
        tipe,
        kategori,
        nominal,
        booking_id: parseInt(booking_id, 10),
        sumber_tipe: 'booking_adjustment',
        sumber_id: adjId,
        status: 'aktif',
        catatan,
        created_by
      });
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

// Override database in require cache
const mockDb = new MockDB();
require.cache[require.resolve('../database')] = {
  exports: mockDb
};

let currentTestRole = 'owner';
const mockAuth = (req, res, next) => {
  req.user = { id: 1, role: currentTestRole };
  req.admin = { adminId: 1, id: 1, role: currentTestRole };
  next();
};
mockAuth.requireRole = (requiredRole) => (req, res, next) => {
  if (req.user?.role !== requiredRole) {
    return res.status(403).json({ error: 'Forbidden: Role tidak memiliki akses' });
  }
  next();
};
mockAuth.requirePermission = () => (req, res, next) => next();

require.cache[require.resolve('../middleware/auth')] = {
  exports: mockAuth
};

const bookingsRouter = require('../routes/bookings');
const pelunasanRouter = require('../routes/pelunasan');

function mockReqRes(params = {}, body = {}) {
  const req = {
    params,
    body,
    user: { id: 1, role: currentTestRole },
    admin: { adminId: 1, id: 1, role: currentTestRole }
  };
  let statusCode = 200;
  let responseData = null;
  const res = {
    status(c) {
      statusCode = c;
      return this;
    },
    json(d) {
      responseData = d;
      return this;
    }
  };
  return { req, res, getStatus: () => statusCode, getData: () => responseData };
}

async function runTests() {
  console.log('Testing Phase 3: Endpoints, Views, and Resync...');

  // Setup initial booking: 5.000.000, confirmed
  mockDb.bookings.push({
    id: 50,
    client_name: 'Dian Permata',
    package_price: 5000000,
    paid_amount: 0,
    status: 'confirmed',
    category_id: 1,
    package_name: 'Wedding Silver',
    version: 1
  });

  // Seed pelunasan tagihan
  const fixedToken = 'token_secret_32_characters_long_for_test';
  mockDb.pelunasan.push({
    id: 500,
    booking_id: 50,
    token: fixedToken,
    total_tagihan: 5000000,
    dp_terbayar: 0,
    sisa_kekurangan: 5000000,
    status: 'sent'
  });

  // 1. Skenario PRD #1: Total 5jt, DP approved 2.5jt
  {
    mockDb.payments.push({
      id: 5001,
      booking_id: 50,
      amount: 2500000,
      payment_type: 'dp',
      status: 'approved'
    });

    // Panggil GET /token/:token
    const getTokenLayer = pelunasanRouter.stack.find(l => l.route && l.route.path === '/token/:token');
    const getTokenHandler = getTokenLayer.route.stack[getTokenLayer.route.stack.length - 1].handle;

    const { req, res, getStatus, getData } = mockReqRes({ token: fixedToken });
    await getTokenHandler(req, res);

    assert.strictEqual(getStatus(), 200);
    assert.strictEqual(getData().tagihan.total_tagihan, 5000000);
    assert.strictEqual(getData().tagihan.dp_terbayar, 2500000);
    assert.strictEqual(getData().tagihan.sisa_kekurangan, 2500000);
    console.log('  ✓ Skenario 1: GET /token/:token mengembalikan total 5jt, DP 2.5jt, sisa 2.5jt');
  }

  // 2. Skenario PRD #2: Owner ubah dibayar jadi 3jt -> link klien otomatis menampilkan sisa 2jt tanpa buat ulang link
  {
    const patchPaidLayer = bookingsRouter.stack.find(l => l.route && l.route.path === '/admin/:id/paid-amount');
    const patchPaidHandler = patchPaidLayer.route.stack[patchPaidLayer.route.stack.length - 1].handle;

    const { req, res } = mockReqRes({ id: '50' }, { paid_amount: 3000000, version: mockDb.bookings[0].version });
    await patchPaidHandler(req, res);

    // Klien buka kembali link yang sama (token lama)
    const getTokenLayer = pelunasanRouter.stack.find(l => l.route && l.route.path === '/token/:token');
    const getTokenHandler = getTokenLayer.route.stack[getTokenLayer.route.stack.length - 1].handle;

    const { req: reqKlien, res: resKlien, getData: getDataKlien } = mockReqRes({ token: fixedToken });
    await getTokenHandler(reqKlien, resKlien);

    assert.strictEqual(getDataKlien().tagihan.dp_terbayar, 3000000, 'Link klien langsung menampilkan DP 3jt');
    assert.strictEqual(getDataKlien().tagihan.sisa_kekurangan, 2000000, 'Link klien langsung menampilkan sisa 2jt');
    console.log('  ✓ Skenario 2: Link klien otomatis membaca sisa 2jt live dari ledger tanpa generate ulang');
  }

  // 3. Skenario PRD #3: Owner turunkan dibayar jadi 1.5jt -> link klien menampilkan sisa 3.5jt
  {
    const patchPaidLayer = bookingsRouter.stack.find(l => l.route && l.route.path === '/admin/:id/paid-amount');
    const patchPaidHandler = patchPaidLayer.route.stack[patchPaidLayer.route.stack.length - 1].handle;

    const { req, res } = mockReqRes({ id: '50' }, { paid_amount: 1500000, version: mockDb.bookings[0].version });
    await patchPaidHandler(req, res);

    const getTokenLayer = pelunasanRouter.stack.find(l => l.route && l.route.path === '/token/:token');
    const getTokenHandler = getTokenLayer.route.stack[getTokenLayer.route.stack.length - 1].handle;

    const { req: reqKlien, res: resKlien, getData: getDataKlien } = mockReqRes({ token: fixedToken });
    await getTokenHandler(reqKlien, resKlien);

    assert.strictEqual(getDataKlien().tagihan.dp_terbayar, 1500000);
    assert.strictEqual(getDataKlien().tagihan.sisa_kekurangan, 3500000, 'Sisa 3.5jt langsung terbaca');
    console.log('  ✓ Skenario 3: Penurunan dibayar membuat sisa bertambah ke 3.5jt secara live');
  }

  // 4. Skenario PRD #4: Dibayar lunas (5jt) -> halaman klien status lunas
  {
    const patchPaidLayer = bookingsRouter.stack.find(l => l.route && l.route.path === '/admin/:id/paid-amount');
    const patchPaidHandler = patchPaidLayer.route.stack[patchPaidLayer.route.stack.length - 1].handle;

    const { req, res } = mockReqRes({ id: '50' }, { paid_amount: 5000000, version: mockDb.bookings[0].version });
    await patchPaidHandler(req, res);

    const getTokenLayer = pelunasanRouter.stack.find(l => l.route && l.route.path === '/token/:token');
    const getTokenHandler = getTokenLayer.route.stack[getTokenLayer.route.stack.length - 1].handle;

    const { req: reqKlien, res: resKlien, getData: getDataKlien } = mockReqRes({ token: fixedToken });
    await getTokenHandler(reqKlien, resKlien);

    assert.strictEqual(getDataKlien().tagihan.sisa_kekurangan, 0);
    assert.strictEqual(getDataKlien().tagihan.status, 'lunas', 'Halaman klien otomatis berstatus lunas');
    console.log('  ✓ Skenario 4: Pembayaran lunas membuat halaman klien berstatus lunas');
  }

  // 5. Detail booking: mengembalikan objek billing lengkap + riwayat
  {
    const detailLayer = bookingsRouter.stack.find(l => l.route && l.route.path === '/admin/detail/:id');
    const detailHandler = detailLayer.route.stack[detailLayer.route.stack.length - 1].handle;

    const { req, res, getData } = mockReqRes({ id: '50' });
    await detailHandler(req, res);

    const b = getData();
    assert(b.billing, 'Detail booking memiliki objek billing');
    assert.strictEqual(b.billing.total, 5000000);
    assert.strictEqual(b.billing.paid, 5000000);
    assert.strictEqual(b.billing.sisa, 0);
    assert(b.billing.rincian, 'Memiliki rincian DP/pelunasan/penyesuaian');
    assert(Array.isArray(b.billing.riwayat), 'Memiliki array riwayat penyesuaian');
    console.log('  ✓ Skenario 5: GET /admin/detail/:id mengembalikan objek billing lengkap');
  }

  // 6. Resync endpoint: Owner dapat 200, non-owner ditolak 403
  {
    const resyncLayer = bookingsRouter.stack.find(l => l.route && l.route.path === '/admin/bookings/:id/billing/resync');
    const authRoleMiddleware = resyncLayer.route.stack[1].handle;
    const resyncHandler = resyncLayer.route.stack[resyncLayer.route.stack.length - 1].handle;

    // Tes sebagai Staff (Harus 403)
    currentTestRole = 'staff';
    const { req: reqStaff, res: resStaff, getStatus: getStatusStaff } = mockReqRes({ id: '50' });
    authRoleMiddleware(reqStaff, resStaff, () => resyncHandler(reqStaff, resStaff));
    assert.strictEqual(getStatusStaff(), 403, 'Staff harus ditolak 403');
    console.log('  ✓ Skenario 6a: POST /resync menolak staf non-owner dengan HTTP 403');

    // Tes sebagai Owner (Harus 200)
    currentTestRole = 'owner';
    const { req: reqOwner, res: resOwner, getStatus: getStatusOwner, getData: getDataOwner } = mockReqRes({ id: '50' });
    authRoleMiddleware(reqOwner, resOwner, async () => {
      await resyncHandler(reqOwner, resOwner);
      assert.strictEqual(getStatusOwner(), 200, 'Owner harus berhasil 200');
      assert.strictEqual(getDataOwner().billing.paid, 5000000);
      console.log('  ✓ Skenario 6b: POST /resync berhasil untuk owner');
    });
  }

  console.log('All Phase 3 Integration tests passed successfully! ✅');
}

runTests().catch(err => {
  console.error('Test Phase 3 failed:', err);
  process.exit(1);
});
