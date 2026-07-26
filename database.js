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
    rejectUnauthorized: false
  }
});

const db = {
  pool,
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),

  // Inisialisasi tabel saat startup
  init: async () => {
    try {
      // ── Create tables ────────────────────────────────────────────
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
          short_slug   VARCHAR(255) UNIQUE,
          client_name  VARCHAR(255) NOT NULL,
          folder_url   TEXT NOT NULL,
          folder_id    VARCHAR(255) NOT NULL,
          photo_limit  INTEGER NOT NULL DEFAULT 10,
          status       VARCHAR(50) NOT NULL DEFAULT 'active',
          edit_status  VARCHAR(30) NOT NULL DEFAULT 'received',
          edit_note    TEXT,
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
          note        TEXT,
          selected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        -- Indexes
        CREATE INDEX IF NOT EXISTS idx_sessions_uuid  ON sessions(uuid);
        CREATE INDEX IF NOT EXISTS idx_sessions_slug  ON sessions(short_slug);
        CREATE INDEX IF NOT EXISTS idx_sessions_admin ON sessions(admin_id);
        CREATE INDEX IF NOT EXISTS idx_selections_sess ON selections(session_id);
      `);

      // ── Run ALTER TABLE migrations for existing databases ─────────
      // Add new columns if they don't exist yet (idempotent)
      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sessions' AND column_name='short_slug') THEN
            ALTER TABLE sessions ADD COLUMN short_slug VARCHAR(255) UNIQUE;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sessions' AND column_name='edit_status') THEN
            ALTER TABLE sessions ADD COLUMN edit_status VARCHAR(30) NOT NULL DEFAULT 'received';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sessions' AND column_name='edit_note') THEN
            ALTER TABLE sessions ADD COLUMN edit_note TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='selections' AND column_name='note') THEN
            ALTER TABLE selections ADD COLUMN note TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='booking_categories' AND column_name='time_slots') THEN
            ALTER TABLE booking_categories ADD COLUMN time_slots JSONB DEFAULT '[]'::jsonb;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='booking_categories' AND column_name='wa_template') THEN
            ALTER TABLE booking_categories ADD COLUMN wa_template TEXT;
          END IF;
        END
        $$;

        CREATE INDEX IF NOT EXISTS idx_sessions_slug ON sessions(short_slug);
      `);

      // ── Create new tables (Scale-Up) ──────────────────────────────
      await pool.query(`
        -- Kategori booking sebagai template form
        CREATE TABLE IF NOT EXISTS booking_categories (
          id         SERIAL PRIMARY KEY,
          slug       VARCHAR(30) UNIQUE NOT NULL,
          name       VARCHAR(100) NOT NULL,
          fields     JSONB NOT NULL DEFAULT '[]',
          dp_type    VARCHAR(10) NOT NULL DEFAULT 'percent',
          dp_value   NUMERIC(12,2) NOT NULL DEFAULT 30,
          color      VARCHAR(10) NOT NULL DEFAULT '#7c6dfa',
          is_active  BOOLEAN NOT NULL DEFAULT true,
          time_slots JSONB DEFAULT '[]'::jsonb,
          wa_template TEXT,
          created_at TIMESTAMP DEFAULT now()
        );

        -- Data booking dari client
        CREATE TABLE IF NOT EXISTS bookings (
          id             SERIAL PRIMARY KEY,
          category_id    INT REFERENCES booking_categories(id),
          client_name    VARCHAR(150) NOT NULL,
          client_phone   VARCHAR(30) NOT NULL,
          event_date     DATE NOT NULL,
          event_time     TIME,
          location       TEXT,
          form_data      JSONB NOT NULL DEFAULT '{}',
          package_price  NUMERIC(12,2),
          dp_amount      NUMERIC(12,2),
          dp_deadline    TIMESTAMP NULL,
          status         VARCHAR(20) NOT NULL DEFAULT 'pending_dp',
          session_id     INT REFERENCES sessions(id) NULL,
          created_at     TIMESTAMP DEFAULT now()
        );

        -- Pencatatan pembayaran & bukti transfer
        CREATE TABLE IF NOT EXISTS payments (
          id            SERIAL PRIMARY KEY,
          booking_id    INT REFERENCES bookings(id) ON DELETE CASCADE,
          amount        NUMERIC(12,2),
          payment_type  VARCHAR(20) NOT NULL DEFAULT 'dp',
          proof_url     TEXT,
          proof_filename TEXT,
          status        VARCHAR(20) NOT NULL DEFAULT 'pending',
          approved_by   INT REFERENCES admins(id) NULL,
          approved_at   TIMESTAMP NULL,
          reject_reason TEXT,
          created_at    TIMESTAMP DEFAULT now()
        );

        -- Indexes
        CREATE INDEX IF NOT EXISTS idx_bookings_category ON bookings(category_id);
        CREATE INDEX IF NOT EXISTS idx_bookings_status   ON bookings(status);
        CREATE INDEX IF NOT EXISTS idx_bookings_date     ON bookings(event_date);
        CREATE INDEX IF NOT EXISTS idx_payments_booking  ON payments(booking_id);
        CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
      `);

      // ── Seed default booking categories ──────────────────────────
      const { rows: catRows } = await pool.query('SELECT COUNT(*) AS cnt FROM booking_categories');
      if (parseInt(catRows[0].cnt, 10) === 0) {
        const defaultCategories = [
          {
            slug: 'graduation',
            name: 'Graduation',
            fields: JSON.stringify([
              { key: 'school_name', label: 'Nama Sekolah / Kampus', type: 'text', required: true },
              { key: 'major', label: 'Jurusan / Program Studi', type: 'text', required: false },
              { key: 'people_count', label: 'Jumlah Orang dalam Frame', type: 'number', required: true },
              { key: 'graduation_location', label: 'Lokasi Wisuda', type: 'text', required: true }
            ]),
            dp_type: 'percent', dp_value: 20, color: '#22d374'
          },
          {
            slug: 'wedding',
            name: 'Wedding',
            fields: JSON.stringify([
              { key: 'groom_name', label: 'Nama Mempelai Pria', type: 'text', required: true },
              { key: 'bride_name', label: 'Nama Mempelai Wanita', type: 'text', required: true },
              { key: 'venue', label: 'Venue / Gedung', type: 'text', required: true },
              { key: 'session_count', label: 'Jumlah Sesi (Akad, Resepsi, dll)', type: 'number', required: true },
              { key: 'dresscode', label: 'Tema / Dresscode', type: 'text', required: false }
            ]),
            dp_type: 'percent', dp_value: 30, color: '#f472b6'
          },
          {
            slug: 'event',
            name: 'Event',
            fields: JSON.stringify([
              { key: 'event_name', label: 'Nama Acara', type: 'text', required: true },
              { key: 'event_type', label: 'Jenis Event', type: 'select', options: ['Ulang Tahun', 'Gathering', 'Seminar', 'Konser', 'Lainnya'], required: true },
              { key: 'guest_count', label: 'Estimasi Jumlah Tamu', type: 'number', required: false },
              { key: 'duration_hours', label: 'Durasi Acara (jam)', type: 'number', required: true }
            ]),
            dp_type: 'percent', dp_value: 25, color: '#fb923c'
          },
          {
            slug: 'corporation',
            name: 'Corporation',
            fields: JSON.stringify([
              { key: 'company_name', label: 'Nama Perusahaan', type: 'text', required: true },
              { key: 'pic_name', label: 'Nama PIC', type: 'text', required: true },
              { key: 'pic_phone', label: 'No. HP PIC', type: 'text', required: true },
              { key: 'doc_type', label: 'Jenis Dokumentasi', type: 'select', options: ['Foto Produk', 'Corporate Event', 'Headshot Karyawan', 'Video Profil', 'Lainnya'], required: true },
              { key: 'npwp', label: 'NPWP Perusahaan (opsional)', type: 'text', required: false }
            ]),
            dp_type: 'percent', dp_value: 50, color: '#60a5fa'
          }
        ];

        for (const cat of defaultCategories) {
          await pool.query(
            `INSERT INTO booking_categories (slug, name, fields, dp_type, dp_value, color)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [cat.slug, cat.name, cat.fields, cat.dp_type, cat.dp_value, cat.color]
          );
        }
        console.log('✅ Default booking categories seeded (graduation, wedding, event, corporation)');
      }

      // ── Seed default admin ────────────────────────────────────────
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
