'use strict';

require('dotenv').config();
const db = require('../database');
const { migrateUp, migrateDown } = require('./migrate');

async function run() {
  console.log('--- [TEST FASE 1] Memulai Uji Migrasi Database ---');

  // 1. Eksekusi Migrasi UP
  console.log('1. Menjalankan migrateUp()...');
  await migrateUp();

  // 2. Verifikasi tabel & index ada
  console.log('2. Verifikasi keberadaan tabel & trigger...');
  const tablesCheck = await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('users', 'refresh_tokens', 'audit_log', 'approval_rules', 'approval_requests')
  `);
  const foundTables = tablesCheck.rows.map(r => r.table_name);
  console.log('   Tabel ditemukan:', foundTables);
  if (foundTables.length !== 5) {
    throw new Error(`Tabel tidak lengkap! Ditemukan: ${foundTables.join(', ')}`);
  }

  // 3. Verifikasi kolom di bookings, pelunasan, payments
  console.log('3. Verifikasi kolom created_by, updated_by, version...');
  for (const t of ['bookings', 'pelunasan', 'payments']) {
    const colCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = $1 AND column_name IN ('created_by', 'updated_by', 'version')
    `, [t]);
    if (colCheck.rows.length !== 3) {
      throw new Error(`Kolom di tabel ${t} tidak lengkap!`);
    }
  }
  console.log('   Semua kolom audit & version valid.');

  // 4. Verifikasi Owner Account & Rules Seed
  console.log('4. Verifikasi data awal (Owner & approval_rules)...');
  const ownerCheck = await db.query("SELECT id, email, role FROM users WHERE role = 'owner'");
  if (ownerCheck.rows.length === 0) {
    throw new Error('Owner belum ter-seed!');
  }
  const ownerId = ownerCheck.rows[0].id;
  console.log(`   Owner valid: ID ${ownerId} (${ownerCheck.rows[0].email})`);

  const rulesCheck = await db.query("SELECT COUNT(*) AS n FROM approval_rules");
  console.log(`   Approval rules ter-seed: ${rulesCheck.rows[0].n} aturan.`);
  if (parseInt(rulesCheck.rows[0].n, 10) < 5) {
    throw new Error('Approval rules kurang dari 5!');
  }

  // 5. Uji Trigger Append-Only pada audit_log
  console.log('5. Menguji Append-Only trigger pada audit_log...');
  const insertAudit = await db.query(`
    INSERT INTO audit_log (actor_id, actor_role, aksi, entitas, entitas_id, sesudah)
    VALUES ($1, 'owner', 'test.migration', 'test', 999, '{"ok":true}'::jsonb)
    RETURNING id
  `, [ownerId]);
  const auditId = insertAudit.rows[0].id;
  console.log(`   Berhasil INSERT audit_log id = ${auditId}`);

  // 5a. Coba UPDATE (harus DITOLAK)
  let updateRejected = false;
  try {
    await db.query("UPDATE audit_log SET aksi = 'hacked' WHERE id = $1", [auditId]);
  } catch (err) {
    if (err.message.includes('audit_log is append-only')) {
      updateRejected = true;
      console.log('   ✅ UPDATE audit_log DITOLAK oleh trigger:', err.message);
    } else {
      throw err;
    }
  }
  if (!updateRejected) {
    throw new Error('CRITICAL: UPDATE pada audit_log tidak ditolak!');
  }

  // 5b. Coba DELETE (harus DITOLAK)
  let deleteRejected = false;
  try {
    await db.query("DELETE FROM audit_log WHERE id = $1", [auditId]);
  } catch (err) {
    if (err.message.includes('audit_log is append-only')) {
      deleteRejected = true;
      console.log('   ✅ DELETE audit_log DITOLAK oleh trigger:', err.message);
    } else {
      throw err;
    }
  }
  if (!deleteRejected) {
    throw new Error('CRITICAL: DELETE pada audit_log tidak ditolak!');
  }

  // 6. Uji Siklus DOWN -> UP
  console.log('6. Menguji migrasi DOWN (Rollback)...');
  await migrateDown();

  const tablesAfterDown = await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('users', 'refresh_tokens', 'audit_log', 'approval_rules', 'approval_requests')
  `);
  if (tablesAfterDown.rows.length !== 0) {
    throw new Error(`Migrasi DOWN gagal membersihkan tabel: ${tablesAfterDown.rows.map(r => r.table_name).join(', ')}`);
  }
  console.log('   ✅ Migrasi DOWN sukses, semua tabel dibersihkan.');

  console.log('7. Menguji migrasi UP kembali (Reapply idempotency)...');
  await migrateUp();

  const finalCheck = await db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'");
  if (parseInt(finalCheck.rows[0].n, 10) === 0) {
    throw new Error('Reapply UP gagal mengembalikan akun Owner!');
  }
  console.log('   ✅ Migrasi UP ulang sukses, Owner aktif kembali.');

  console.log('--- [TEST FASE 1] SEMUA UJI LULUS (100% SUKSES) ---');
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Uji Migrasi Gagal:', err);
  process.exit(1);
});
