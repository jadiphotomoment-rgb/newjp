'use strict';

require('dotenv').config();
const readline = require('readline');
const bcrypt   = require('bcryptjs');
const db       = require('../database');

function ask(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function main() {
  console.log('=== Buat / Reset Akun Owner Jadiphoto.Moment ===');
  const nama  = (process.env.OWNER_NAME) || await ask('Nama Owner: ');
  const email = (process.env.OWNER_EMAIL) || await ask('Email Owner: ');
  let pass    = process.env.OWNER_PASSWORD;

  if (!pass) {
    pass = await ask('Password (min 10 karakter): ');
  }

  if (!nama || !email || !pass) {
    console.error('Nama, email, dan password wajib diisi.');
    process.exit(1);
  }

  if (pass.length < 10) {
    console.error('Password minimal 10 karakter.');
    process.exit(1);
  }

  const hash = bcrypt.hashSync(pass, 12);

  try {
    const { rows } = await db.query(`
      INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
      VALUES ($1, lower($2), $3, 'owner', true, false)
      ON CONFLICT (lower(email)) DO UPDATE
      SET nama = EXCLUDED.nama,
          password_hash = EXCLUDED.password_hash,
          role = 'owner',
          is_active = true,
          token_version = users.token_version + 1,
          locked_until = NULL,
          failed_attempts = 0
      RETURNING id, nama, email, role;
    `, [nama.trim(), email.trim(), hash]);

    console.log('✅ Akun Owner berhasil dibuat/diperbarui:');
    console.log(rows[0]);
    process.exit(0);
  } catch (err) {
    console.error('❌ Gagal membuat/memperbarui akun Owner:', err);
    process.exit(1);
  }
}

main();
