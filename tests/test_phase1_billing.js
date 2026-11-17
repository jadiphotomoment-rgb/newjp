'use strict';

const assert = require('assert');

// Mock Audit Service
const auditCalls = [];
require.cache[require.resolve('../services/audit')] = {
  exports: {
    record: async (tx, params) => {
      auditCalls.push(params);
      return { id: 1 };
    }
  }
};

const { computeBilling, syncBilling, setPaidAmount } = require('../services/billing');

// In-Memory Database Simulator for Testing
class MockDB {
  constructor() {
    this.bookings = [];
    this.payments = [];
    this.financial_entries = [];
    this.pelunasan = [];
  }

  async query(sql, params = []) {
    const s = sql.trim();

    // 1. SELECT bookings FOR computeBilling or syncBilling
    if (s.includes('FROM bookings') && s.includes('WHERE id = $1')) {
      const bId = params[0];
      const found = this.bookings.find(b => b.id === bId && !b.deleted_at);
      return { rows: found ? [{ ...found }] : [] };
    }

    // 2. SELECT payments GROUP BY payment_type
    if (s.includes('FROM payments') && s.includes('WHERE booking_id = $1')) {
      const bId = params[0];
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
    if (s.includes('FROM financial_entries') && s.includes('WHERE booking_id = $1')) {
      const bId = params[0];
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

    // 4. UPDATE bookings
    if (s.startsWith('UPDATE bookings')) {
      const [paid, status, updated_by, id] = params;
      const b = this.bookings.find(x => x.id === id);
      if (b) {
        b.paid_amount = paid;
        b.status = status;
        b.updated_by = updated_by;
        b.version = (b.version || 1) + 1;
      }
      return { rows: [b] };
    }

    // 5. UPDATE pelunasan (sync tagihan aktif)
    if (s.includes('UPDATE pelunasan') && s.includes('status IN (\'sent\', \'rejected\')') && s.includes('SET total_tagihan')) {
      const [total, dp, sisa, bId] = params;
      this.pelunasan
        .filter(p => p.booking_id === bId && ['sent', 'rejected'].includes(p.status))
        .forEach(p => {
          p.total_tagihan = total;
          p.dp_terbayar = dp;
          p.sisa_kekurangan = sisa;
        });
      return { rows: [] };
    }

    // 6. UPDATE pelunasan CANCELLED when sisa == 0
    if (s.includes('UPDATE pelunasan') && s.includes('SET status = \'cancelled\'')) {
      const [bId] = params;
      this.pelunasan
        .filter(p => p.booking_id === bId && ['sent', 'rejected'].includes(p.status))
        .forEach(p => {
          p.status = 'cancelled';
          p.catatan = (p.catatan || '') + ' [Dibatalkan otomatis: tagihan sudah lunas]';
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
        booking_id,
        sumber_tipe: 'booking_adjustment',
        sumber_id: adjId,
        status: 'aktif',
        catatan,
        created_by
      });
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL in MockDB: ${sql}`);
  }
}

async function runTests() {
  console.log('Testing Phase 1: services/billing.js...');
  const db = new MockDB();

  // Seed Booking 1: Total 5.000.000, confirmed
  db.bookings.push({
    id: 1,
    client_name: 'Budi Test',
    package_price: 5000000,
    paid_amount: 0,
    status: 'confirmed',
    version: 1
  });

  // Seed Tagihan Pelunasan Aktif
  db.pelunasan.push({
    id: 10,
    booking_id: 1,
    status: 'sent',
    total_tagihan: 5000000,
    dp_terbayar: 0,
    sisa_kekurangan: 5000000
  });

  // 1. Skenario PRD #1: Total 5.000.000, DP approved 2.500.000
  {
    db.payments.push({
      id: 101,
      booking_id: 1,
      amount: 2500000,
      payment_type: 'dp',
      status: 'approved'
    });

    const b = await computeBilling(db, 1);
    assert.strictEqual(b.total, 5000000, 'Total harus 5jt');
    assert.strictEqual(b.paid, 2500000, 'Paid harus 2.5jt');
    assert.strictEqual(b.sisa, 2500000, 'Sisa harus 2.5jt');
    assert.strictEqual(b.kelebihan, 0, 'Kelebihan harus 0');
    assert.strictEqual(b.status_bayar, 'sebagian', 'Status bayar sebagian');
    assert.strictEqual(b.rincian.dp, 2500000, 'DP rincian 2.5jt');

    // Test syncBilling
    const synced = await syncBilling(db, 1, 99);
    assert.strictEqual(db.bookings[0].paid_amount, 2500000, 'Booking paid_amount tersinkron');
    assert.strictEqual(db.pelunasan[0].sisa_kekurangan, 2500000, 'Tagihan aktif tersinkron');
    console.log('  ✓ Skenario 1 (DP 50% approved): computeBilling & syncBilling lulus');
  }

  // 2. Skenario PRD #2: Owner menaikkan dibayar jadi 3.000.000 via setPaidAmount
  {
    const res = await setPaidAmount(db, 1, 3000000, 99);
    assert.strictEqual(res.paid, 3000000, 'Paid jadi 3jt');
    assert.strictEqual(res.sisa, 2000000, 'Sisa jadi 2jt');
    assert.strictEqual(db.bookings[0].paid_amount, 3000000, 'Cache booking terupdate ke 3jt');
    assert.strictEqual(db.pelunasan[0].sisa_kekurangan, 2000000, 'Tagihan aktif terupdate ke 2jt');

    // Cek entri financial_entries bertambah tipe 'masuk' sebesar 500rb
    const lastEntry = db.financial_entries[db.financial_entries.length - 1];
    assert.strictEqual(lastEntry.tipe, 'masuk');
    assert.strictEqual(lastEntry.nominal, 500000);
    console.log('  ✓ Skenario 2 (Naikkan dibayar via setPaidAmount): selisih masuk 500rb & sync tagihan');
  }

  // 3. Skenario PRD #3: Owner menurunkan dibayar jadi 1.500.000
  {
    const res = await setPaidAmount(db, 1, 1500000, 99);
    assert.strictEqual(res.paid, 1500000, 'Paid jadi 1.5jt');
    assert.strictEqual(res.sisa, 3500000, 'Sisa bertambah jadi 3.5jt');
    assert.strictEqual(db.bookings[0].paid_amount, 1500000);
    assert.strictEqual(db.pelunasan[0].sisa_kekurangan, 3500000);

    // Cek entri financial_entries bertambah tipe 'keluar' sebesar 1.5jt
    const lastEntry = db.financial_entries[db.financial_entries.length - 1];
    assert.strictEqual(lastEntry.tipe, 'keluar');
    assert.strictEqual(lastEntry.nominal, 1500000);
    console.log('  ✓ Skenario 3 (Turunkan dibayar): sisa bertambah & entri keluar tercatat');
  }

  // 4. Skenario PRD #4: Dibayar lunas (5.000.000) -> status booking lunas & tagihan aktif dibatalkan
  {
    const res = await setPaidAmount(db, 1, 5000000, 99);
    assert.strictEqual(res.paid, 5000000);
    assert.strictEqual(res.sisa, 0);
    assert.strictEqual(res.status_bayar, 'lunas');
    assert.strictEqual(db.bookings[0].status, 'lunas', 'Status booking otomatis berubah jadi lunas');
    assert.strictEqual(db.pelunasan[0].status, 'cancelled', 'Tagihan aktif otomatis dibatalkan');
    console.log('  ✓ Skenario 4 (Dibayar lunas): status booking lunas & tagihan aktif cancelled');
  }

  // 5. Penurunan dari status lunas kembali ke confirmed
  {
    const res = await setPaidAmount(db, 1, 4000000, 99);
    assert.strictEqual(res.paid, 4000000);
    assert.strictEqual(db.bookings[0].status, 'confirmed', 'Status lunas kembali ke confirmed saat dibayar turun');
    console.log('  ✓ Penurunan dari lunas: status otomatis kembali ke confirmed');
  }

  // 6. Skenario PRD #6: Hapus payment approved (ubah status bukan approved)
  {
    db.payments[0].status = 'deleted';
    const synced = await syncBilling(db, 1, 99);
    // Sebelumnya payments=2.5jt, penyesuaian net = +500rb - 1.5jt + 3.5jt - 1jt = +1.5jt.
    // Tanpa payment, paid = 0 + 1.5jt = 1.5jt.
    assert.strictEqual(synced.paid, 1500000, 'Hapus payment mengurangi total dibayar');
    assert.strictEqual(synced.sisa, 3500000, 'Sisa bertambah sesuai');
    console.log('  ✓ Skenario 6 (Hapus payment): sisa bertambah dan ledger berkurang');
  }

  // 7. Edge Case: package_price kosong (null)
  {
    db.bookings.push({
      id: 2,
      client_name: 'Tanpa Harga',
      package_price: null,
      paid_amount: 0,
      status: 'pending_dp'
    });

    const b = await computeBilling(db, 2);
    assert.strictEqual(b.total, null, 'Total null');
    assert.strictEqual(b.sisa, null, 'Sisa null');
    assert.strictEqual(b.kelebihan, 0, 'Kelebihan 0');
    assert.strictEqual(b.status_bayar, 'belum_bayar');
    console.log('  ✓ Edge case package_price null: sisa null tanpa error');
  }

  // 8. Validasi setPaidAmount: negatif & melebihi total
  {
    await assert.rejects(
      () => setPaidAmount(db, 1, -1000, 99),
      /tidak boleh negatif/,
      'Menolak nilai negatif'
    );
    await assert.rejects(
      () => setPaidAmount(db, 1, 999999999, 99),
      /tidak boleh melebihi total/,
      'Menolak nilai melebihi harga paket'
    );
    console.log('  ✓ Validasi setPaidAmount (negatif & melebihi total) berhasil ditolak');
  }

  console.log('All Phase 1 Billing tests passed successfully! ✅');
}

runTests().catch(err => {
  console.error('Test Phase 1 failed:', err);
  process.exit(1);
});
