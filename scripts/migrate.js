'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../database');

async function runSqlFile(client, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  await client.query(sql);
}

async function seedOwnerAndBackfill(client) {
  // 1. Cek apakah sudah ada user owner
  const { rows: owners } = await client.query("SELECT id, email FROM users WHERE role = 'owner' LIMIT 1");
  let ownerId;

  if (owners.length > 0) {
    ownerId = owners[0].id;
    console.log(`[migrate] Owner ditemukan: ID ${ownerId} (${owners[0].email})`);
  } else {
    // Cari admin dari tabel admins eksisting
    const { rows: admins } = await client.query("SELECT * FROM admins ORDER BY id ASC LIMIT 1");
    let name = 'Administrator';
    let email = process.env.OWNER_EMAIL || 'admin@jadiphoto.moment';
    let passwordHash = admins[0] ? admins[0].password_hash : null;

    if (!passwordHash) {
      const bcrypt = require('bcryptjs');
      const defaultPass = process.env.DEFAULT_OWNER_PASSWORD || 'OwnerJadiphoto2026!';
      passwordHash = bcrypt.hashSync(defaultPass, 10);
      console.log('[migrate] Membuat owner baru dengan password default/env');
    } else {
      name = admins[0].name || name;
      console.log(`[migrate] Migrasi akun owner dari tabel admins: ${name}`);
    }

    const { rows: newOwner } = await client.query(`
      INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
      VALUES ($1, $2, $3, 'owner', true, false)
      ON CONFLICT DO NOTHING
      RETURNING id, email
    `, [name, email, passwordHash]);

    if (newOwner.length > 0) {
      ownerId = newOwner[0].id;
      console.log(`[migrate] Owner dibuat: ID ${ownerId} (${email})`);
    } else {
      const { rows: existing } = await client.query("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
      ownerId = existing[0]?.id;
    }
  }

  // 2. Backfill created_by & updated_by pada bookings, pelunasan, payments
  if (ownerId) {
    const resBookings = await client.query("UPDATE bookings SET created_by = $1 WHERE created_by IS NULL", [ownerId]);
    const resPelunasan = await client.query("UPDATE pelunasan SET created_by = $1 WHERE created_by IS NULL", [ownerId]);
    const resPayments = await client.query("UPDATE payments SET created_by = $1 WHERE created_by IS NULL", [ownerId]);

    console.log(`[migrate] Backfill selesai: bookings (${resBookings.rowCount}), pelunasan (${resPelunasan.rowCount}), payments (${resPayments.rowCount}) diset ke owner_id = ${ownerId}`);
  }

  return ownerId;
}

async function migrateUp() {
  const client = await db.getClient();
  try {
    console.log('[migrate] Menjalankan migrasi UP...');
    await client.query('BEGIN');
    await runSqlFile(client, path.join(__dirname, '../migrations/001_rbac_and_approvals.sql'));
    await seedOwnerAndBackfill(client);
    await runSqlFile(client, path.join(__dirname, '../migrations/002_pelunasan_enhancements.sql'));
    await runSqlFile(client, path.join(__dirname, '../migrations/003_staff_direct_approve.sql'));
    await runSqlFile(client, path.join(__dirname, '../migrations/004_financial_entries_crud.sql'));
    await client.query('COMMIT');
    console.log('[migrate] Migrasi UP berhasil!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] Migrasi UP gagal:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function migrateDown() {
  const client = await db.getClient();
  try {
    console.log('[migrate] Menjalankan migrasi DOWN (Rollback)...');
    await client.query('BEGIN');
    await runSqlFile(client, path.join(__dirname, '../migrations/004_financial_entries_crud_down.sql'));
    await runSqlFile(client, path.join(__dirname, '../migrations/003_staff_direct_approve_down.sql'));
    await runSqlFile(client, path.join(__dirname, '../migrations/002_pelunasan_enhancements_down.sql'));
    await runSqlFile(client, path.join(__dirname, '../migrations/001_rbac_and_approvals_down.sql'));
    await client.query('COMMIT');
    console.log('[migrate] Migrasi DOWN berhasil!');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] Migrasi DOWN gagal:', err);
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'up') {
    migrateUp().then(() => process.exit(0)).catch(() => process.exit(1));
  } else if (cmd === 'down') {
    migrateDown().then(() => process.exit(0)).catch(() => process.exit(1));
  } else {
    console.log('Penggunaan: node scripts/migrate.js [up|down]');
    process.exit(1);
  }
}

module.exports = { migrateUp, migrateDown, seedOwnerAndBackfill };
