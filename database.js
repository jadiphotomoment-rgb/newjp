'use strict';

const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

// ── Setup PostgreSQL Pool ─────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL belum diset di environment variables!');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Agar bisa konek ke Neon tanpa masalah SSL
  }
});

// Helper functions to keep similarity with better-sqlite3 structure
// Tapi harus dijalankan secara asynchronous
const db = {
  pool,
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  
  // Inisialisasi tabel saat startup
  init: async () => {
    try {
      await pool.query(`
        -- Admin accounts
        CREATE TABLE IF NOT EXISTS admins (
          id            SERIAL PRIMARY KEY,
          username      VARCHAR(255) UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          name          VARCHAR(255) NOT NULL,
          created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Sorting sessions
        CREATE TABLE IF NOT EXISTS sessions (
          id           SERIAL PRIMARY KEY,
          uuid         VARCHAR(255) UNIQUE NOT NULL,
          client_name  VARCHAR(255) NOT NULL,
          folder_url   TEXT NOT NULL,
          folder_id    VARCHAR(255) NOT NULL,
          photo_limit  INTEGER NOT NULL DEFAULT 10,
          status       VARCHAR(50) NOT NULL DEFAULT 'active',
          admin_id     INTEGER NOT NULL,
          created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP,
          FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
        );

        -- Individual photo selections
        CREATE TABLE IF NOT EXISTS selections (
          id          SERIAL PRIMARY KEY,
          session_id  INTEGER NOT NULL,
          file_id     VARCHAR(255) NOT NULL,
          file_name   TEXT NOT NULL,
          selected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        -- Indexes
        CREATE INDEX IF NOT EXISTS idx_sessions_uuid ON sessions(uuid);
        CREATE INDEX IF NOT EXISTS idx_sessions_admin ON sessions(admin_id);
        CREATE INDEX IF NOT EXISTS idx_selections_sess ON selections(session_id);
      `);

      // Seed default admin
      const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM admins');
      if (parseInt(rows[0].cnt, 10) === 0) {
        const hash = bcrypt.hashSync('admin123', 10);
        await pool.query(
          'INSERT INTO admins (username, password_hash, name) VALUES ($1, $2, $3)',
          ['admin', hash, 'Administrator']
        );
        console.log('✅ Default admin created (username: admin, password: admin123)');
      }
      console.log('✅ Database Neon (PostgreSQL) terhubung dan siap.');
    } catch (error) {
      console.error('❌ Gagal inisialisasi database:', error.message);
    }
  }
};

module.exports = db;
