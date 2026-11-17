'use strict';

require('dotenv').config();
const db = require('../database');
const { computeBilling, syncBilling } = require('../services/billing');

/**
 * Billing Reconcile Script
 * Default: DRY-RUN (hanya cetak tabel selisih & kategori)
 * Flag: --apply (memperbaiki CACHE_STALE dan TAGIHAN_STALE lewat syncBilling)
 * 
 * JANGAN JALANKAN LANGSUNG KE PRODUKSI TANPA BACKUP / SNAPSHOT NEON.
 */
async function reconcile(options = {}) {
  const isApply = options.apply !== undefined ? options.apply : process.argv.includes('--apply');
  const database = options.db || db;

  console.log('='.repeat(75));
  console.log(`🔍 BILLING RECONCILE TOOL (${isApply ? '🚀 MODE: APPLY' : '🛡️ MODE: DRY-RUN (READ-ONLY)'})`);
  console.log('='.repeat(75));

  const bookRes = await database.query(`
    SELECT b.id, b.client_name, b.status, b.package_price, b.paid_amount, b.version
    FROM bookings b
    WHERE b.deleted_at IS NULL
    ORDER BY b.id ASC
  `);

  const results = [];
  let countSynced = 0;
  let countFixable = 0;
  let countNeedsReview = 0;
  let countFixed = 0;

  for (const b of bookRes.rows) {
    const live = await computeBilling(database, b.id);
    const cachePaid = Number(b.paid_amount || 0);
    const ledgerPaid = live.paid;
    const selisih = ledgerPaid - cachePaid;

    // Ambil tagihan aktif jika ada
    const tagRes = await database.query(`
      SELECT id, total_tagihan, dp_terbayar, sisa_kekurangan, status
      FROM pelunasan
      WHERE booking_id = $1 AND status IN ('sent', 'rejected')
      ORDER BY id DESC LIMIT 1
    `, [b.id]);
    const tagihan = tagRes.rows[0] || null;

    let kategori = 'SYNCED';
    let tagihanStale = false;

    if (tagihan) {
      if (Number(tagihan.dp_terbayar) !== live.paid || Number(tagihan.sisa_kekurangan) !== (live.sisa ?? 0)) {
        tagihanStale = true;
      }
    }

    // Klasifikasi kategori selisih
    if (ledgerPaid === 0 && (cachePaid > 0 || ['confirmed', 'lunas'].includes(b.status))) {
      // Kasus data lama tanpa record payments / penyesuaian
      kategori = 'NEEDS_REVIEW';
      countNeedsReview++;
    } else if (selisih !== 0) {
      kategori = 'CACHE_STALE';
      countFixable++;
    } else if (tagihanStale) {
      kategori = 'TAGIHAN_STALE';
      countFixable++;
    } else {
      countSynced++;
    }

    if (kategori !== 'SYNCED') {
      results.push({
        id: b.id,
        client: b.client_name || '-',
        status: b.status,
        cachePaid,
        ledgerPaid,
        selisih,
        tagihan: tagihan ? `Sisa: ${Number(tagihan.sisa_kekurangan).toLocaleString('id-ID')}` : '—',
        kategori
      });

      // Hanya perbaiki kategori yang aman dan dapat diturunkan secara deterministik
      if (isApply && (kategori === 'CACHE_STALE' || kategori === 'TAGIHAN_STALE')) {
        let client;
        try {
          client = await database.getClient();
          await client.query('BEGIN');
          await syncBilling(client, b.id, null);
          await client.query('COMMIT');
          countFixed++;
        } catch (err) {
          if (client) await client.query('ROLLBACK');
          console.error(`  ❌ Gagal sinkronisasi booking #${b.id}:`, err.message);
        } finally {
          if (client) client.release();
        }
      }
    }
  }

  if (results.length > 0) {
    console.table(results.map(r => ({
      'Booking ID': r.id,
      'Klien': r.client,
      'Status': r.status,
      'Cache Paid': 'Rp ' + r.cachePaid.toLocaleString('id-ID'),
      'Ledger Paid': 'Rp ' + r.ledgerPaid.toLocaleString('id-ID'),
      'Selisih': (r.selisih > 0 ? '+' : '') + 'Rp ' + r.selisih.toLocaleString('id-ID'),
      'Tagihan Aktif': r.tagihan,
      'Kategori': r.kategori
    })));
  } else {
    console.log('✅ Semua booking dan tagihan sudah tersinkron dengan sempurna.');
  }

  console.log('-'.repeat(75));
  console.log(`📊 REKAPITULASI:`);
  console.log(`   Total Booking Dicek     : ${bookRes.rows.length}`);
  console.log(`   Sinkron Sempurna        : ${countSynced}`);
  console.log(`   Selisih Dapat Diperbaiki: ${countFixable}`);
  console.log(`   Perlu Review Manual     : ${countNeedsReview} (NEEDS_REVIEW)`);
  if (isApply) {
    console.log(`   Berhasil Diperbaiki     : ${countFixed}`);
  }
  console.log('='.repeat(75));

  return {
    totalChecked: bookRes.rows.length,
    countSynced,
    countFixable,
    countNeedsReview,
    countFixed,
    results
  };
}

// Eksekusi jika dijalankan langsung via CLI
if (require.main === module) {
  reconcile()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Error saat rekonsiliasi:', err);
      process.exit(1);
    });
}

module.exports = { reconcile };
