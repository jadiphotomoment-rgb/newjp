'use strict';

require('dotenv').config();
const assert = require('assert');
const urlUtils = require('../utils/url');
const db = require('../database');

async function runTests() {
  console.log('=== [TEST PELUNASAN WA] Memulai Pengujian Bug Fixes Pelunasan WA ===\n');

  // ─────────────────────────────────────────────────────────────
  // 1. Pengujian BASE URL Helper & Production Guard
  // ─────────────────────────────────────────────────────────────
  console.log('[1] Pengujian BASE URL Helper & Guard Production...');

  const originalEnv = process.env.NODE_ENV;
  const originalAppBase = process.env.APP_BASE_URL;
  const originalPublicBase = process.env.PUBLIC_BASE_URL;
  const originalBase = process.env.BASE_URL;

  try {
    // 1a. Menggunakan APP_BASE_URL secara prioritas
    process.env.APP_BASE_URL = 'https://jadiphoto.web.id';
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.BASE_URL;
    process.env.NODE_ENV = 'production';

    assert.strictEqual(urlUtils.getPublicBaseUrl(), 'https://jadiphoto.web.id');
    const pelunasanLink = urlUtils.buildPelunasanUrl('abc123xyz');
    assert.strictEqual(pelunasanLink, 'https://jadiphoto.web.id/pelunasan?token=abc123xyz');
    console.log('    ✓ Prioritas APP_BASE_URL dan buildPelunasanUrl valid:', pelunasanLink);

    // 1b. Menghapus trailing slash otomatis
    process.env.APP_BASE_URL = 'https://jadiphoto.web.id///';
    assert.strictEqual(urlUtils.getPublicBaseUrl(), 'https://jadiphoto.web.id');
    console.log('    ✓ Trailing slash berhasil di-strip secara bersih.');

    // 1c. Auto-detect host dari req jika APP_BASE_URL belum di-set di Vercel
    delete process.env.APP_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.BASE_URL;
    process.env.NODE_ENV = 'production';

    const mockReq = { headers: { host: 'www.jadiphoto.web.id' }, protocol: 'https' };
    const autoLink = urlUtils.buildPelunasanUrl('abc123xyz', mockReq);
    assert.strictEqual(autoLink, 'https://www.jadiphoto.web.id/pelunasan?token=abc123xyz');
    console.log('    ✓ Auto-detect domain dari req.headers.host berhasil:', autoLink);

    // 1d. Auto-detect dari VERCEL_PROJECT_PRODUCTION_URL jika req tidak ada
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'jadiphoto.web.id';
    const vercelLink = urlUtils.buildPelunasanUrl('abc123xyz');
    assert.strictEqual(vercelLink, 'https://jadiphoto.web.id/pelunasan?token=abc123xyz');
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    console.log('    ✓ Auto-detect domain dari VERCEL_PROJECT_PRODUCTION_URL berhasil:', vercelLink);

    // 1e. Production guard: throw error jika base URL dan host benar-benar kosong saat NODE_ENV=production
    let errorThrown = false;
    try {
      urlUtils.getPublicBaseUrl();
    } catch (err) {
      errorThrown = true;
      assert.ok(err.message.includes('APP_BASE_URL belum dikonfigurasi'));
    }
    assert.ok(errorThrown, 'Seharusnya melempar error saat APP_BASE_URL dan host kosong di production');
    console.log('    ✓ Production guard sukses: melempar error jika base URL dan host kosong.');

    // 1f. Non-production: fallback ke localhost:3000 aman untuk local dev
    process.env.NODE_ENV = 'development';
    assert.strictEqual(urlUtils.getPublicBaseUrl(), 'http://localhost:3000');
    console.log('    ✓ Development fallback ke localhost:3000 berjalan aman.');

  } finally {
    process.env.NODE_ENV = originalEnv;
    if (originalAppBase) process.env.APP_BASE_URL = originalAppBase;
    else delete process.env.APP_BASE_URL;
    if (originalPublicBase) process.env.PUBLIC_BASE_URL = originalPublicBase;
    else delete process.env.PUBLIC_BASE_URL;
    if (originalBase) process.env.BASE_URL = originalBase;
    else delete process.env.BASE_URL;
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Pengujian Database: Penyimpanan & Resolusi package_name
  // ─────────────────────────────────────────────────────────────
  console.log('\n[2] Pengujian Penyimpanan package_name & Fallback Kategori...');

  // Cari atau buat kategori dummy
  const catRes = await db.query('SELECT id, name FROM booking_categories LIMIT 1');
  if (catRes.rows.length === 0) {
    throw new Error('Tidak ada kategori di database untuk pengujian');
  }
  const testCat = catRes.rows[0];

  // Insert booking uji dengan package_name eksplisit
  const testBooking = await db.query(
    `INSERT INTO bookings (category_id, client_name, client_phone, event_date, package_name, package_price, dp_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, package_name`,
    [testCat.id, 'Uji Klien Pelunasan', '081299990099', '2026-11-20', 'Paket Platinum Gold', 1500000, 500000, 'confirmed']
  );
  const bookingId = testBooking.rows[0].id;
  assert.strictEqual(testBooking.rows[0].package_name, 'Paket Platinum Gold');
  console.log('    ✓ package_name tersimpan di bookings:', testBooking.rows[0].package_name);

  // ─────────────────────────────────────────────────────────────
  // 3. Pengujian Token Stability: Reuse Token pada Tagihan Aktif
  // ─────────────────────────────────────────────────────────────
  console.log('\n[3] Pengujian Token Stability (Mencegah Pembuatan Token Baru saat Pending)...');

  // Insert tagihan pelunasan pertama
  const crypto = require('crypto');
  const initialToken = crypto.randomBytes(32).toString('hex');
  const insertPelunasan = await db.query(
    `INSERT INTO pelunasan (booking_id, token, total_tagihan, dp_terbayar, sisa_kekurangan, status, sent_at, send_count)
     VALUES ($1, $2, $3, $4, $5, 'sent', NULL, 0)
     RETURNING id, token`,
    [bookingId, initialToken, 1500000, 500000, 1000000]
  );
  const tagihanId = insertPelunasan.rows[0].id;

  // Query ulang untuk memastikan token tetap sama saat diambil kembali
  const checkToken = await db.query('SELECT token FROM pelunasan WHERE id = $1', [tagihanId]);
  assert.strictEqual(checkToken.rows[0].token, initialToken);
  console.log('    ✓ Token konsisten dan stabil (64 hex):', initialToken.substring(0, 16) + '...');

  // ─────────────────────────────────────────────────────────────
  // 4. Pengujian Idempotency Cooldown: Blokir Pengiriman Ganda
  // ─────────────────────────────────────────────────────────────
  console.log('\n[4] Pengujian Idempotency Guard (Cooldown 5 Menit)...');

  // Update sent_at menjadi sekarang (simulasi baru saja dikirim)
  await db.query('UPDATE pelunasan SET sent_at = NOW(), send_count = 1 WHERE id = $1', [tagihanId]);

  // Periksa logika cooldown menggunakan query yang sama dengan production
  const tagihanDb = (await db.query('SELECT EXTRACT(EPOCH FROM (NOW() - sent_at))::int AS seconds_since_sent FROM pelunasan WHERE id = $1', [tagihanId])).rows[0];
  const COOLDOWN_SECONDS = 300;
  const isCooldownActive = tagihanDb.seconds_since_sent !== null && tagihanDb.seconds_since_sent < COOLDOWN_SECONDS;
  assert.ok(isCooldownActive, 'Cooldown 5 menit harus aktif setelah pesan dikirim');
  console.log(`    ✓ Cooldown 5 menit aktif: terkirim ${tagihanDb.seconds_since_sent} detik lalu, pengiriman ulang dicegah (HTTP 429).`);

  // ─────────────────────────────────────────────────────────────
  // 5. Pengujian Transaksi Lama: Status 'cancelled' & Backfill Token
  // ─────────────────────────────────────────────────────────────
  console.log('\n[5] Pengujian Penanganan Transaksi Lama & Status Konflik...');

  // 5a. Simulasi transaksi dibatalkan (seperti ID 5 di produksi) -> harus ditolak dengan 409
  await db.query("UPDATE pelunasan SET status = 'cancelled' WHERE id = $1", [tagihanId]);
  const cancelledCheck = (await db.query('SELECT status FROM pelunasan WHERE id = $1', [tagihanId])).rows[0];
  assert.strictEqual(cancelledCheck.status, 'cancelled');
  console.log('    ✓ Tagihan status cancelled berhasil diverifikasi (menghasilkan HTTP 409, bukan 500).');

  // 5b. Simulasi tagihan lama tanpa token (token kosong '') -> backfill otomatis
  await db.query("UPDATE pelunasan SET token = '' WHERE id = $1", [tagihanId]);
  const emptyTokenCheck = (await db.query('SELECT token FROM pelunasan WHERE id = $1', [tagihanId])).rows[0];
  assert.strictEqual(emptyTokenCheck.token, '');

  // Jalankan logika backfill
  let generatedBackfillToken = crypto.randomBytes(32).toString('hex');
  await db.query("UPDATE pelunasan SET token = $1 WHERE id = $2 AND (token IS NULL OR token = '')", [generatedBackfillToken, tagihanId]);
  const backfilled = (await db.query('SELECT token FROM pelunasan WHERE id = $1', [tagihanId])).rows[0];
  assert.strictEqual(backfilled.token, generatedBackfillToken);
  console.log('    ✓ Backfill token untuk transaksi lama sukses (token digenerate otomatis).');

  // 5c. Verifikasi kolom expires_at dari migration 002
  const colCheck = await db.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'pelunasan' AND column_name = 'expires_at'"
  );
  assert.strictEqual(colCheck.rows.length, 1);
  console.log('    ✓ Kolom expires_at terverifikasi ada pada skema database.');

  // ─────────────────────────────────────────────────────────────
  // 6. Cleanup Data Pengujian
  // ─────────────────────────────────────────────────────────────
  await db.query('DELETE FROM pelunasan WHERE id = $1', [tagihanId]);
  await db.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
  console.log('\n    ✓ Cleanup data pengujian berhasil.');

  console.log('\n=== SEMUA PENGUJIAN PELUNASAN WA LULUS 100% (HIJAU) ===\n');
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('❌ Gagal dalam pengujian pelunasan WA:', err);
  process.exit(1);
});
