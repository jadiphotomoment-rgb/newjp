'use strict';

const assert = require('assert');

// Mock Audit Service
require.cache[require.resolve('../services/audit')] = {
  exports: {
    record: async () => ({ id: 1 })
  }
};

// In-Memory Database Simulator for Phase 2 Endpoint Integrations
class MockDB {
  constructor() {
    this.bookings = [];
    this.payments = [];
    this.financial_entries = [];
    this.pelunasan = [];
  }

  async getClient() {
    const self = this;
    return {
      inTransaction: false,
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
    if (s.includes('FROM bookings') && s.includes('WHERE id = $1')) {
      const bId = parseInt(params[0], 10);
      const found = this.bookings.find(b => b.id === bId && !b.deleted_at);
      return { rows: found ? [{ ...found }] : [] };
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

    // 4. SELECT pelunasan by id
    if (s.includes('FROM pelunasan p') && s.includes('WHERE p.id = $1')) {
      const id = parseInt(params[0], 10);
      const found = this.pelunasan.find(p => p.id === id);
      if (!found) return { rows: [] };
      const book = this.bookings.find(b => b.id === found.booking_id) || {};
      return {
        rows: [{
          ...found,
          client_name: book.client_name,
          client_phone: book.client_phone,
          event_date: book.event_date,
          package_name: book.package_name
        }]
      };
    }

    // 5. UPDATE bookings
    if (s.startsWith('UPDATE bookings')) {
      const bId = parseInt(params[params.length - 1], 10);
      const b = this.bookings.find(x => x.id === bId);
      if (b) {
        if (s.includes('paid_amount = $1')) {
          b.paid_amount = params[0];
          b.status = params[1];
          b.updated_by = params[2];
        }
        b.version = (b.version || 1) + 1;
      }
      return { rows: b ? [{ ...b }] : [] };
    }

    // 6. UPDATE pelunasan
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

    if (s.includes('UPDATE pelunasan') && s.includes('SET status = \'lunas\'')) {
      const [uId, idRaw] = params;
      const id = parseInt(idRaw, 10);
      const p = this.pelunasan.find(x => x.id === id);
      if (p) {
        p.status = 'lunas';
        p.verified_by = uId;
      }
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

    // 7. INSERT INTO financial_entries
    if (s.startsWith('INSERT INTO financial_entries')) {
      const [tipe, kategori, nominal, booking_id, adjId, catatan, created_by] = params;
      this.financial_entries.push({
        id: this.financial_entries.length + 1,
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

    // 8. INSERT INTO payments
    if (s.startsWith('INSERT INTO payments')) {
      const bId = parseInt(params[0], 10);
      const amount = Number(params[1]);
      const pType = s.includes("'pelunasan'") ? 'pelunasan' : (params[2] || 'dp');
      this.payments.push({
        id: this.payments.length + 1,
        booking_id: bId,
        amount,
        payment_type: pType,
        status: 'approved',
        approved_by: params[params.length - 1]
      });
      return { rows: [] };
    }

    // 9. DELETE FROM payments
    if (s.startsWith('DELETE FROM payments')) {
      const id = parseInt(params[0], 10);
      const idx = this.payments.findIndex(p => p.id === id);
      if (idx === -1) return { rows: [] };
      const deleted = this.payments.splice(idx, 1)[0];
      return { rows: [deleted] };
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

// Override database in require cache
const mockDb = new MockDB();
require.cache[require.resolve('../database')] = {
  exports: mockDb
};

const mockAuth = (req, res, next) => {
  req.user = { id: 1, role: 'owner' };
  req.admin = { adminId: 1, id: 1, role: 'owner' };
  next();
};
mockAuth.requireRole = () => (req, res, next) => next();
mockAuth.requirePermission = () => (req, res, next) => next();

require.cache[require.resolve('../middleware/auth')] = {
  exports: mockAuth
};

const express = require('express');
const bookingsRouter = require('../routes/bookings');
const pelunasanRouter = require('../routes/pelunasan');
const financeRouter = require('../routes/finance');

const app = express();
app.use(express.json());
app.use('/api/bookings', bookingsRouter);
app.use('/api/pelunasan', pelunasanRouter);
app.use('/api/finance', financeRouter);

function mockReqRes(body = {}, params = {}) {
  const req = { body, params, user: { id: 1, role: 'owner' }, admin: { adminId: 1, id: 1, role: 'owner' } };
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
  console.log('Testing Phase 2: syncBilling at write points...');

  // Setup seed booking
  mockDb.bookings.push({
    id: 10,
    client_name: 'Client Alpha',
    package_price: 6000000,
    paid_amount: 0,
    status: 'pending_dp',
    version: 1
  });

  // Seed Tagihan
  mockDb.pelunasan.push({
    id: 100,
    booking_id: 10,
    total_tagihan: 6000000,
    dp_terbayar: 0,
    sisa_kekurangan: 6000000,
    status: 'sent'
  });

  // 1. Skenario PRD #2: Owner menaikkan dibayar via handlePatchPaidAmount ke 3.000.000
  {
    // Find handler
    const routeLayer = bookingsRouter.stack.find(l => l.route && l.route.path === '/admin/:id/paid-amount');
    const handler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;

    const { req, res, getStatus, getData } = mockReqRes({ paid_amount: 3000000, version: 1 }, { id: '10' });
    await handler(req, res);

    assert.strictEqual(getStatus(), 200, 'Status harus 200');
    assert.strictEqual(getData().booking.paid_amount, 3000000);
    assert.strictEqual(getData().booking.sisa_tagihan, 3000000);
    assert.strictEqual(mockDb.pelunasan[0].sisa_kekurangan, 3000000, 'Tagihan aktif tersinkron otomatis');
    console.log('  ✓ Skenario 2: PATCH /paid-amount menaikkan pembayaran & menyinkronkan tagihan aktif');
  }

  // 2. Skenario PRD #3: Owner menurunkan dibayar ke 2.000.000 -> sisa bertambah ke 4.000.000
  {
    const routeLayer = bookingsRouter.stack.find(l => l.route && l.route.path === '/admin/:id/paid-amount');
    const handler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;

    const currentVersion = mockDb.bookings[0].version;
    const { req, res, getStatus, getData } = mockReqRes({ paid_amount: 2000000, version: currentVersion }, { id: '10' });
    await handler(req, res);

    assert.strictEqual(getStatus(), 200);
    assert.strictEqual(getData().booking.paid_amount, 2000000);
    assert.strictEqual(getData().booking.sisa_tagihan, 4000000);
    assert.strictEqual(mockDb.pelunasan[0].sisa_kekurangan, 4000000, 'Sisa tagihan bertambah (tidak tertahan GREATEST)');
    console.log('  ✓ Skenario 3: Penurunan pembayaran tersinkron dan sisa bertambah (tidak tertahan GREATEST)');
  }

  // 3. Skenario PRD #5: Verifikasi pelunasan mengambil nominal dari sisa live
  {
    // Ubah tagihan ke status 'menunggu_verifikasi'
    mockDb.pelunasan[0].status = 'menunggu_verifikasi';
    mockDb.pelunasan[0].sisa_kekurangan = 9999999; // Nilai snapshot sengaja basi

    const routeLayer = pelunasanRouter.stack.find(l => l.route && l.route.path === '/:id/verify');
    const handler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;

    const { req, res, getStatus, getData } = mockReqRes({ action: 'approve' }, { id: '100' });
    await handler(req, res);
    if (getStatus() !== 200) {
      console.log('Verify failed with status:', getStatus(), getData());
    }
    assert.strictEqual(getStatus(), 200);

    // Cek payment pelunasan yang di-INSERT nilainya harus persis sisa live (4.000.000), BUKAN 9999999!
    const pelunasanPayment = mockDb.payments.find(p => p.payment_type === 'pelunasan');
    assert(pelunasanPayment, 'Payment pelunasan terbentuk');
    assert.strictEqual(pelunasanPayment.amount, 4000000, 'Nominal payment sama dengan sisa live 4jt');

    // Status booking otomatis jadi lunas
    assert.strictEqual(mockDb.bookings[0].status, 'lunas', 'Booking otomatis lunas setelah pelunasan diverifikasi');
    assert.strictEqual(mockDb.bookings[0].paid_amount, 6000000, 'Total dibayar 6jt');
    console.log('  ✓ Skenario 5: Verifikasi pelunasan mencatat sisa live & update booking jadi lunas');

    // Cek tolak 409 bila sisa live <= 0
    mockDb.pelunasan.push({
      id: 101,
      booking_id: 10,
      status: 'menunggu_verifikasi',
      sisa_kekurangan: 100000
    });
    const { req: req2, res: res2, getStatus: getStatus2, getData: getData2 } = mockReqRes({ action: 'approve' }, { id: '101' });
    await handler(req2, res2);
    assert.strictEqual(getStatus2(), 409, 'Tolak 409 jika sisa live <= 0');
    assert(getData2().error.includes('sudah lunas'), 'Error pesan sisa live <= 0');
    console.log('  ✓ Skenario 5b: Tolak 409 verifikasi bila sisa live sudah lunas');
  }

  // 4. Skenario PRD #6: Hapus payment via DELETE /api/finance/payments/:id
  {
    const routeLayer = financeRouter.stack.find(l => l.route && l.route.path === '/payments/:id' && l.route.methods.delete);
    const handler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;

    const pelunasanPayId = mockDb.payments.find(p => p.payment_type === 'pelunasan').id;
    const { req, res, getStatus } = mockReqRes({}, { id: String(pelunasanPayId) });
    await handler(req, res);

    assert.strictEqual(getStatus(), 200);
    // Setelah payment dihapus, paid berkurang dari 6jt jadi 2jt, sisa bertambah ke 4jt, status kembali confirmed
    assert.strictEqual(mockDb.bookings[0].paid_amount, 2000000, 'Paid kembali ke 2jt');
    assert.strictEqual(mockDb.bookings[0].status, 'confirmed', 'Status lunas kembali confirmed');
    console.log('  ✓ Skenario 6: Hapus payment mengembalikan sisa & status booking');
  }

  // 5. Skenario PRD #7: Error di tengah transaksi rollback total
  {
    // Coba PATCH paid-amount dengan input tidak valid (melebihi package price)
    const routeLayer = bookingsRouter.stack.find(l => l.route && l.route.path === '/admin/:id/paid-amount');
    const handler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;

    const currentVersion = mockDb.bookings[0].version;
    const { req, res, getStatus } = mockReqRes({ paid_amount: 99999999, version: currentVersion }, { id: '10' });
    await handler(req, res);

    assert.strictEqual(getStatus(), 400, 'Ditolak 400');
    assert.strictEqual(mockDb.bookings[0].paid_amount, 2000000, 'Data tidak berubah setelah rollback');
    console.log('  ✓ Skenario 7: Validasi gagal / rollback menjaga konsistensi atomik');
  }

  console.log('All Phase 2 Integration tests passed successfully! ✅');
}

runTests().catch(err => {
  console.error('Test Phase 2 failed:', err);
  process.exit(1);
});
