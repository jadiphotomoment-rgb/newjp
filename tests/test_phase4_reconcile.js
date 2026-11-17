'use strict';

const assert = require('assert');

// Mock Audit Service
require.cache[require.resolve('../services/audit')] = {
  exports: {
    record: async () => ({ id: 1 })
  }
};

const { reconcile } = require('../scripts/billing-reconcile');

class MockDB {
  constructor() {
    this.bookings = [];
    this.payments = [];
    this.financial_entries = [];
    this.pelunasan = [];
  }

  getClient() {
    return {
      query: (sql, params) => this.query(sql, params),
      release: () => {}
    };
  }

  async query(sql, params = []) {
    const s = sql.trim();

    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
      return { rows: [] };
    }

    // 1. SELECT list for reconcile
    if (s.includes('FROM bookings b') && s.includes('ORDER BY b.id ASC')) {
      const active = this.bookings
        .filter(b => !b.deleted_at)
        .map(b => ({
          id: b.id,
          client_name: b.client_name,
          status: b.status,
          package_price: b.package_price,
          paid_amount: b.paid_amount,
          version: b.version
        }));
      return { rows: active };
    }

    // 2. SELECT single booking
    if (s.includes('FROM bookings') && s.includes('WHERE id = $1')) {
      const bId = Number(params[0]);
      const found = this.bookings.find(b => b.id === bId && !b.deleted_at);
      return { rows: found ? [{ ...found }] : [] };
    }

    // 3. SELECT payments
    if (s.includes('FROM payments') && s.includes('WHERE booking_id = $1')) {
      const bId = Number(params[0]);
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

    // 4. SELECT financial_entries
    if (s.includes('FROM financial_entries') && s.includes('WHERE booking_id = $1')) {
      const bId = Number(params[0]);
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

    // 5. SELECT pelunasan for reconcile or syncBilling
    if (s.includes('FROM pelunasan') && s.includes('WHERE booking_id = $1')) {
      const bId = Number(params[0]);
      const found = this.pelunasan
        .filter(p => p.booking_id === bId && ['sent', 'rejected'].includes(p.status))
        .sort((a, b) => b.id - a.id);
      return { rows: found.map(p => ({ ...p })) };
    }

    // 6. UPDATE bookings
    if (s.startsWith('UPDATE bookings')) {
      const [paid, status, updated_by, id] = params;
      const b = this.bookings.find(item => item.id === Number(id));
      if (b) {
        b.paid_amount = Number(paid);
        b.status = status;
        b.updated_by = updated_by;
        b.version = (b.version || 1) + 1;
      }
      return { rowCount: 1, rows: [b] };
    }

    // 7. UPDATE pelunasan
    if (s.startsWith('UPDATE pelunasan')) {
      if (s.includes('SET total_tagihan')) {
        const [total, dp, sisa, bId] = params;
        this.pelunasan
          .filter(p => p.booking_id === Number(bId) && ['sent', 'rejected'].includes(p.status))
          .forEach(p => {
            p.total_tagihan = Number(total);
            p.dp_terbayar = Number(dp);
            p.sisa_kekurangan = Number(sisa);
          });
      } else if (s.includes('SET status = \'cancelled\'')) {
        const [bId] = params;
        this.pelunasan
          .filter(p => p.booking_id === Number(bId) && ['sent', 'rejected'].includes(p.status))
          .forEach(p => {
            p.status = 'cancelled';
            p.catatan = (p.catatan || '') + ' [Dibatalkan otomatis: tagihan sudah lunas]';
          });
      }
      return { rowCount: 1, rows: [] };
    }

    return { rows: [] };
  }
}

async function runTests() {
  console.log('🧪 Starting Phase 4 Reconcile Script Tests...');

  const db = new MockDB();

  // Booking 1: SYNCED
  // price: 1.000.000, payment: 300.000, paid_amount: 300.000
  db.bookings.push({ id: 1, client_name: 'Client Synced', status: 'confirmed', package_price: 1000000, paid_amount: 300000, version: 1 });
  db.payments.push({ id: 101, booking_id: 1, payment_type: 'dp', amount: 300000, status: 'approved' });

  // Booking 2: CACHE_STALE
  // price: 2.000.000, payment: 500.000, cache paid_amount: 0
  db.bookings.push({ id: 2, client_name: 'Client Stale Cache', status: 'confirmed', package_price: 2000000, paid_amount: 0, version: 1 });
  db.payments.push({ id: 102, booking_id: 2, payment_type: 'dp', amount: 500000, status: 'approved' });

  // Booking 3: TAGIHAN_STALE
  // price: 1.500.000, payment: 500.000, cache: 500.000, pelunasan snapshot: dp 200.000, sisa 1.300.000 (should be sisa 1.000.000)
  db.bookings.push({ id: 3, client_name: 'Client Stale Tagihan', status: 'confirmed', package_price: 1500000, paid_amount: 500000, version: 1 });
  db.payments.push({ id: 103, booking_id: 3, payment_type: 'dp', amount: 500000, status: 'approved' });
  db.pelunasan.push({ id: 201, booking_id: 3, total_tagihan: 1500000, dp_terbayar: 200000, sisa_kekurangan: 1300000, status: 'sent' });

  // Booking 4: NEEDS_REVIEW
  // ledger = 0, but cache paid_amount = 500.000 & status = confirmed
  db.bookings.push({ id: 4, client_name: 'Client Needs Review', status: 'confirmed', package_price: 1000000, paid_amount: 500000, version: 1 });

  // TEST 1: Dry-Run Mode
  console.log('\n--- Test 1: DRY-RUN Mode ---');
  const dryResult = await reconcile({ db, apply: false });
  assert.strictEqual(dryResult.totalChecked, 4, 'Total checked should be 4');
  assert.strictEqual(dryResult.countSynced, 1, 'Synced should be 1');
  assert.strictEqual(dryResult.countFixable, 2, 'Fixable should be 2 (1 cache stale + 1 tagihan stale)');
  assert.strictEqual(dryResult.countNeedsReview, 1, 'Needs review should be 1');
  assert.strictEqual(dryResult.countFixed, 0, 'In dry-run mode, countFixed must be 0');

  // Verify in-memory DB untouched in dry run
  assert.strictEqual(db.bookings.find(b => b.id === 2).paid_amount, 0, 'Booking 2 paid_amount should remain 0 in dry-run');
  assert.strictEqual(db.pelunasan.find(p => p.id === 201).dp_terbayar, 200000, 'Tagihan 201 should remain stale in dry-run');

  console.log('✅ Test 1 Passed: Dry-run accurately detected classifications without altering data.');

  // TEST 2: Apply Mode
  console.log('\n--- Test 2: APPLY Mode ---');
  const applyResult = await reconcile({ db, apply: true });
  assert.strictEqual(applyResult.countFixed, 2, 'Apply mode should fix 2 records');

  // Verify DB updates
  const b2 = db.bookings.find(b => b.id === 2);
  assert.strictEqual(b2.paid_amount, 500000, 'Booking 2 paid_amount should be synced to 500.000');

  const p201 = db.pelunasan.find(p => p.id === 201);
  assert.strictEqual(p201.dp_terbayar, 500000, 'Tagihan 201 dp_terbayar should be updated to 500.000');
  assert.strictEqual(p201.sisa_kekurangan, 1000000, 'Tagihan 201 sisa_kekurangan should be updated to 1.000.000');

  // Verify NEEDS_REVIEW booking 4 was NOT changed
  const b4 = db.bookings.find(b => b.id === 4);
  assert.strictEqual(b4.paid_amount, 500000, 'Booking 4 (NEEDS_REVIEW) must remain untouched');

  console.log('✅ Test 2 Passed: Apply mode successfully fixed stale cache and tagihan, leaving NEEDS_REVIEW safe.');

  // TEST 3: Re-running reconcile after apply
  console.log('\n--- Test 3: Post-Apply Verification ---');
  const postResult = await reconcile({ db, apply: false });
  assert.strictEqual(postResult.countFixable, 0, 'Fixable count should now be 0');
  assert.strictEqual(postResult.countNeedsReview, 1, 'Only NEEDS_REVIEW remains');

  console.log('✅ Test 3 Passed: All fixable items are resolved.');
  console.log('\n🎉 ALL PHASE 4 RECONCILE TESTS PASSED!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
