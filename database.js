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
          client_phone VARCHAR(50),
          folder_url   TEXT NOT NULL,
          result_drive_url TEXT,
          folder_id    VARCHAR(255) NOT NULL,
          photo_limit  INTEGER NOT NULL DEFAULT 10,
          status       VARCHAR(50) NOT NULL DEFAULT 'active',
          edit_status  VARCHAR(30) NOT NULL DEFAULT 'received',
          edit_note    TEXT,
          notified_at  TIMESTAMP,
          user_id      INT REFERENCES admins(id) NULL,
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
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sessions' AND column_name='client_phone') THEN
            ALTER TABLE sessions ADD COLUMN client_phone VARCHAR(50);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sessions' AND column_name='result_drive_url') THEN
            ALTER TABLE sessions ADD COLUMN result_drive_url TEXT;
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
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='booking_categories' AND column_name='packages') THEN
            ALTER TABLE booking_categories ADD COLUMN packages JSONB DEFAULT '[]'::jsonb;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='booking_categories' AND column_name='drive_folder_id') THEN
            ALTER TABLE booking_categories ADD COLUMN drive_folder_id VARCHAR(255);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='booking_categories' AND column_name='drive_folder_name') THEN
            ALTER TABLE booking_categories ADD COLUMN drive_folder_name VARCHAR(255);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='blob_key') THEN
            ALTER TABLE payments ADD COLUMN blob_key TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='google_event_id') THEN
            ALTER TABLE bookings ADD COLUMN google_event_id VARCHAR(255) NULL;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='calendar_sync_status') THEN
            ALTER TABLE bookings ADD COLUMN calendar_sync_status VARCHAR(20) DEFAULT 'not_synced';
          END IF;

          -- ── FASE 0: Scale Pelunasan ─────────────────────────────────
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='sumber_informasi') THEN
            ALTER TABLE bookings ADD COLUMN sumber_informasi VARCHAR(20);
            -- instagram | tiktok | google | referral | event | lainnya
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='sumber_informasi_detail') THEN
            ALTER TABLE bookings ADD COLUMN sumber_informasi_detail TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='deleted_at') THEN
            ALTER TABLE bookings ADD COLUMN deleted_at TIMESTAMP NULL;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='package_name') THEN
            ALTER TABLE bookings ADD COLUMN package_name VARCHAR(150);
          END IF;
        END
        $$;

        CREATE INDEX IF NOT EXISTS idx_sessions_slug ON sessions(short_slug);
      `);

      // ── Create app_settings table (key-value store untuk konfigurasi) ──
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key        VARCHAR(100) PRIMARY KEY,
          value      TEXT,
          label      VARCHAR(255),
          updated_at TIMESTAMP DEFAULT now()
        );

        -- Seed default Drive settings jika belum ada
        INSERT INTO app_settings (key, value, label)
        VALUES
          ('global_payment_folder_id',   NULL, 'ID Folder Google Drive (Global Fallback)'),
          ('global_payment_folder_name', NULL, 'Nama Folder Google Drive (Global Fallback)')
        ON CONFLICT (key) DO NOTHING;
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
          packages   JSONB DEFAULT '[]'::jsonb,
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
          google_event_id VARCHAR(255) NULL,
          calendar_sync_status VARCHAR(20) DEFAULT 'not_synced',
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

        -- File attachments (Vercel Blob)
        CREATE TABLE IF NOT EXISTS attachments (
          id          SERIAL PRIMARY KEY,
          booking_id  INT REFERENCES bookings(id) ON DELETE CASCADE NULL,
          user_id     INT REFERENCES admins(id) NULL,
          file_url    TEXT NOT NULL,
          blob_key    TEXT,
          file_name   TEXT NOT NULL,
          file_type   VARCHAR(30) NOT NULL DEFAULT 'payment_proof',
          mime_type   VARCHAR(100),
          file_size   BIGINT,
          created_at  TIMESTAMP DEFAULT now()
        );

        -- Oauth Tokens
        CREATE TABLE IF NOT EXISTS google_oauth_tokens (
          id SERIAL PRIMARY KEY,
          admin_id INT REFERENCES admins(id) ON DELETE CASCADE UNIQUE,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT now()
        );

        -- Sync Logs
        CREATE TABLE IF NOT EXISTS sync_logs (
          id SERIAL PRIMARY KEY,
          booking_id INT REFERENCES bookings(id) ON DELETE CASCADE,
          status VARCHAR(20),
          message TEXT,
          created_at TIMESTAMP DEFAULT now()
        );

        -- Indexes
        CREATE INDEX IF NOT EXISTS idx_bookings_category  ON bookings(category_id);
        CREATE INDEX IF NOT EXISTS idx_bookings_status    ON bookings(status);
        CREATE INDEX IF NOT EXISTS idx_bookings_date      ON bookings(event_date);
        CREATE INDEX IF NOT EXISTS idx_payments_booking   ON payments(booking_id);
        CREATE INDEX IF NOT EXISTS idx_payments_status    ON payments(status);
        CREATE INDEX IF NOT EXISTS idx_attachments_booking ON attachments(booking_id);
      `);

      // ── Create tables (Shortlink) ──────────────────────────────
      await pool.query(`
        -- Data Shortlink
        CREATE TABLE IF NOT EXISTS shortlinks (
          id SERIAL PRIMARY KEY,
          short_code VARCHAR(50) UNIQUE NOT NULL,
          original_url TEXT NOT NULL,
          admin_id INT REFERENCES admins(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT now()
        );

        -- Data Analitik Klik Shortlink
        CREATE TABLE IF NOT EXISTS shortlink_clicks (
          id SERIAL PRIMARY KEY,
          shortlink_id INT REFERENCES shortlinks(id) ON DELETE CASCADE,
          ip_address VARCHAR(45),
          user_agent TEXT,
          referrer TEXT,
          clicked_at TIMESTAMP DEFAULT now()
        );

        -- Indexes
        CREATE INDEX IF NOT EXISTS idx_shortlinks_code ON shortlinks(short_code);
        CREATE INDEX IF NOT EXISTS idx_shortlink_clicks_link_id ON shortlink_clicks(shortlink_id);
      `);

      // ── FASE 0: Tabel pelunasan, payment_settings, bank_accounts ──
      await pool.query(`
        -- Tagihan pelunasan dengan token unik per booking
        CREATE TABLE IF NOT EXISTS pelunasan (
          id                SERIAL PRIMARY KEY,
          booking_id        INT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
          token             VARCHAR(64) UNIQUE NOT NULL,
          total_tagihan     BIGINT NOT NULL,
          dp_terbayar       BIGINT NOT NULL,
          sisa_kekurangan   BIGINT NOT NULL,
          catatan           TEXT,
          status            VARCHAR(25) NOT NULL DEFAULT 'sent',
          -- sent | menunggu_verifikasi | lunas | rejected | cancelled
          bukti_file_url    TEXT,
          bukti_blob_key    TEXT,
          bukti_filename    TEXT,
          reject_reason     TEXT,
          sent_to_wa        VARCHAR(25),
          sent_at           TIMESTAMP,
          send_count        SMALLINT NOT NULL DEFAULT 1,
          paid_at           TIMESTAMP,
          verified_by       INT REFERENCES admins(id) NULL,
          verified_at       TIMESTAMP,
          created_by        INT REFERENCES admins(id) NULL,
          created_at        TIMESTAMP DEFAULT now()
        );

        -- Pengaturan QRIS statis (satu baris aktif)
        CREATE TABLE IF NOT EXISTS payment_settings (
          id              SERIAL PRIMARY KEY,
          qris_image_url  TEXT,
          qris_blob_key   TEXT,
          updated_at      TIMESTAMP DEFAULT now()
        );

        -- Daftar rekening bank (multi-rekening, soft disable)
        CREATE TABLE IF NOT EXISTS bank_accounts (
          id          SERIAL PRIMARY KEY,
          nama_bank   VARCHAR(50) NOT NULL,
          no_rekening VARCHAR(40) NOT NULL,
          atas_nama   VARCHAR(100) NOT NULL,
          is_active   BOOLEAN NOT NULL DEFAULT true,
          sort_order  SMALLINT NOT NULL DEFAULT 0,
          created_at  TIMESTAMP DEFAULT now()
        );

        -- Indexes pelunasan
        CREATE INDEX IF NOT EXISTS idx_pelunasan_booking  ON pelunasan(booking_id);
        CREATE INDEX IF NOT EXISTS idx_pelunasan_token    ON pelunasan(token);
        CREATE INDEX IF NOT EXISTS idx_pelunasan_status   ON pelunasan(status);
        CREATE INDEX IF NOT EXISTS idx_bookings_deleted   ON bookings(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_bookings_sumber    ON bookings(sumber_informasi);
      `);

      // Seed payment_settings default row jika belum ada
      await pool.query(`
        INSERT INTO payment_settings (id, qris_image_url)
        VALUES (1, NULL)
        ON CONFLICT (id) DO NOTHING;
      `);

      // ── Create wa_templates table ──────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wa_templates (
          id          SERIAL PRIMARY KEY,
          key         VARCHAR(60) UNIQUE NOT NULL,
          label       VARCHAR(150) NOT NULL,
          description TEXT,
          template    TEXT NOT NULL,
          variables   TEXT,
          category    VARCHAR(40) NOT NULL DEFAULT 'booking',
          is_active   BOOLEAN NOT NULL DEFAULT true,
          updated_at  TIMESTAMP DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS idx_wa_templates_key ON wa_templates(key);
      `);

      // ── Seed default WA templates ──────────────────────────────
      const defaultTemplates = [
        {
          key: 'booking_confirmed',
          label: 'Konfirmasi Booking (DP Disetujui)',
          description: 'Dikirim otomatis ke klien saat admin menyetujui DP booking',
          template: `✅ *Booking Dikonfirmasi — Jadiphoto.Moment*

Halo {{client_name}},

Booking Anda untuk tanggal *{{event_date}}* pukul *{{event_time}}* telah dikonfirmasi. DP sebesar *{{dp_amount}}* sudah kami terima dan tanggal resmi terkunci. 🎉

📍 *Lokasi:* {{location}}
💰 *Total Paket:* {{package_price}}

Terima kasih telah mempercayai Jadiphoto.Moment! Kami siap mengabadikan momen terbaik Anda. 📸`,
          variables: 'client_name, event_date, event_time, location, package_price, dp_amount',
          category: 'booking',
        },
        {
          key: 'dp_rejected',
          label: 'DP Ditolak / Bukti Transfer Tidak Valid',
          description: 'Dikirim ke klien saat bukti transfer DP tidak bisa diverifikasi',
          template: `❌ *Bukti Transfer Ditolak*

Halo {{client_name}},

Bukti transfer DP Anda tidak dapat diverifikasi.{{reason_text}}

Silakan upload ulang bukti transfer yang valid melalui link yang telah dikirimkan sebelumnya.

Terima kasih atas pengertiannya. 🙏`,
          variables: 'client_name, reason_text',
          category: 'booking',
        },
        {
          key: 'sortir_selesai_admin',
          label: 'Notifikasi Sortir Foto Selesai (ke Admin)',
          description: 'Dikirim ke Admin/WhatsApp bisnis saat klien selesai memilih foto',
          template: `📸 *NOTIFIKASI SORTIR FOTO BARU — JADIPHOTO.MOMENT*
------------------------------------
*Nama Klien / Folder:* {{client_name}}
*Tanggal Seleksi:* {{selection_date}}
*Total Foto Dipilih:* {{total_selected}} Foto (Limit Maks: {{photo_limit}})

*DAFTAR FILE FOTO:*
{{file_list}}
------------------------------------
_Pesan ini dikirim otomatis oleh System Jadiphoto.Moment._`,
          variables: 'client_name, selection_date, total_selected, photo_limit, file_list',
          category: 'sortir',
        },
        {
          key: 'foto_selesai_edit',
          label: 'Hasil Foto Selesai Diedit (ke Klien)',
          description: 'Dikirim ke klien saat foto sudah selesai diedit dan siap diunduh',
          template: `📸 *Hasil Foto Selesai Diedit — Jadiphoto.Moment*

Halo *{{client_name}}*,
Kabar gembira! Foto-foto pilihan Anda telah selesai diedit dan siap untuk diunduh. 🎉

📁 *Link Google Drive:*
{{drive_url}}
{{note_section}}
Terima kasih telah mempercayai layanan fotografi Jadiphoto.Moment! Silakan beri tahu kami jika ada pertanyaan atau kendala unduhan. 📸✨`,
          variables: 'client_name, drive_url, note_section',
          category: 'sortir',
        },
        {
          key: 'dp_uploaded_admin',
          label: 'Notifikasi DP Masuk (ke Admin)',
          description: 'Dikirim ke admin saat klien mengunggah bukti transfer DP',
          template: `📸 *Booking Baru (Jadiphoto.Moment) — DP Masuk!*

Klien: *{{client_name}}*
No. HP: {{client_phone}}

Bukti transfer sudah diupload dan menunggu verifikasi Anda.

Cek dashboard admin untuk approve/reject.`,
          variables: 'client_name, client_phone',
          category: 'booking',
        },
        {
          key: 'session_expired',
          label: 'Notifikasi Sesi Sortir Kadaluarsa',
          description: 'Dikirim ke klien saat masa sortir foto telah habis/dinonaktifkan oleh admin',
          template: `⚠️ *Pemberitahuan: Sesi Sortir Foto Kadaluarsa*

Halo *{{client_name}}*,

Mohon maaf, batas waktu untuk pemilihan foto Anda telah habis dan sesi sortir saat ini telah dinonaktifkan.

Jika Anda masih ingin melanjutkan proses pemilihan foto, silakan hubungi admin Jadiphoto.Moment untuk membuka kembali akses galeri Anda.

Terima kasih. 🙏`,
          variables: 'client_name',
          category: 'sortir',
        },
      ];

      for (const tpl of defaultTemplates) {
        await pool.query(
          `INSERT INTO wa_templates (key, label, description, template, variables, category)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (key) DO NOTHING`,
          [tpl.key, tpl.label, tpl.description, tpl.template, tpl.variables, tpl.category]
        );
      }

      // ── Seed WA templates pelunasan (ON CONFLICT DO NOTHING = aman) ──
      const pelunasanTemplates = [
        {
          key: 'pelunasan_tagihan',
          label: 'Tagihan Pelunasan (ke Klien)',
          description: 'Dikirim ke klien saat admin membuat tagihan pelunasan baru',
          template: `💰 *Tagihan Pelunasan — Jadiphoto.Moment*

Halo {{client_name}},

Berikut rincian pelunasan booking Anda:

📦 *Paket:* {{package_name}}
📅 *Tanggal Acara:* {{event_date}}
💵 *Total Tagihan:* Rp{{total_tagihan}}
✅ *DP Terbayar:* Rp{{dp_terbayar}}
🔴 *Sisa Kekurangan: Rp{{sisa_kekurangan}}*
{{catatan_section}}
Silakan selesaikan pembayaran melalui link berikut:
🔗 {{link_pelunasan}}

Terima kasih 🙏`,
          variables: 'client_name, package_name, event_date, total_tagihan, dp_terbayar, sisa_kekurangan, catatan_section, link_pelunasan',
          category: 'pelunasan',
        },
        {
          key: 'pelunasan_lunas',
          label: 'Pelunasan Diterima / Lunas (ke Klien)',
          description: 'Dikirim ke klien saat admin menyetujui bukti bayar pelunasan',
          template: `✅ *Pembayaran Diterima — Jadiphoto.Moment*

Halo {{client_name}},

Pembayaran pelunasan Anda untuk paket *{{package_name}}* sudah kami terima dan booking Anda kini berstatus *LUNAS*. 🎉

📅 *Tanggal Acara:* {{event_date}}
💰 *Jumlah Diterima:* Rp{{sisa_kekurangan}}

Terima kasih telah mempercayai Jadiphoto.Moment! Kami siap mengabadikan momen terbaik Anda. 📸`,
          variables: 'client_name, package_name, event_date, sisa_kekurangan',
          category: 'pelunasan',
        },
        {
          key: 'pelunasan_rejected',
          label: 'Bukti Pelunasan Ditolak (ke Klien)',
          description: 'Dikirim ke klien saat admin menolak bukti bayar pelunasan, disertai alasan & link upload ulang',
          template: `❌ *Bukti Pembayaran Ditolak — Jadiphoto.Moment*

Halo {{client_name}},

Mohon maaf, bukti pembayaran pelunasan Anda tidak dapat kami verifikasi.

📝 *Alasan:* {{reject_reason}}

Silakan upload ulang bukti pembayaran yang valid melalui link yang sama:
🔗 {{link_pelunasan}}

Terima kasih atas pengertiannya. 🙏`,
          variables: 'client_name, reject_reason, link_pelunasan',
          category: 'pelunasan',
        },
      ];

      for (const tpl of pelunasanTemplates) {
        await pool.query(
          `INSERT INTO wa_templates (key, label, description, template, variables, category)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (key) DO NOTHING`,
          [tpl.key, tpl.label, tpl.description, tpl.template, tpl.variables, tpl.category]
        );
      }

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
            packages: JSON.stringify([
              { id: 'pkg_grad_1', name: 'Graduation Basic', price: 350000, description: '1 Sesi Foto, 10 High Res Edit Photos, All Raw Files via Drive' },
              { id: 'pkg_grad_2', name: 'Graduation Premium', price: 650000, description: '2 Sesi Foto (Individual + Family), 20 Edited Photos, Cetak 10R Premium Frame' },
              { id: 'pkg_grad_3', name: 'Graduation Ultimate', price: 1200000, description: 'Full Outdoor/Studio Session, Unlimited Edit Photos, Video Highlight 1 Menit' }
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
            packages: JSON.stringify([
              { id: 'pkg_wed_1', name: 'Akad Only Package', price: 2500000, description: '1 Photographer, 1 Videographer, 50 Edited Photos, Video Teaser 1 Menit' },
              { id: 'pkg_wed_2', name: 'Silver Wedding Package', price: 5000000, description: 'Akad + Resepsi (Max 6 Jam), 2 Photographers, Exclusive Album 20x30' },
              { id: 'pkg_wed_3', name: 'Gold Luxury Wedding', price: 8500000, description: 'Full Day Coverage, Drone Cinematic Video, Photobooth 2 Jam, Premium Leather Album' }
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
            packages: JSON.stringify([
              { id: 'pkg_evt_1', name: 'Half Day Event', price: 1500000, description: 'Durasi hingga 4 Jam, 1 Photographer, All High-Res Softcopy Files' },
              { id: 'pkg_evt_2', name: 'Full Day Event', price: 2800000, description: 'Durasi hingga 8 Jam, 2 Photographers, Highlight Reel Edit Photos' }
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
            packages: JSON.stringify([
              { id: 'pkg_corp_1', name: 'Corporate Headshot', price: 2000000, description: 'Studio Lighting Setup, Up to 15 Executives Headshot, Retouched High-Res' },
              { id: 'pkg_corp_2', name: 'Company Profile & Product', price: 4500000, description: 'Commercial Rights, Product Catalog Shoot, Office & Team In-Action Photo/Video' }
            ]),
            dp_type: 'percent', dp_value: 50, color: '#60a5fa'
          }
        ];

        for (const cat of defaultCategories) {
          await pool.query(
            `INSERT INTO booking_categories (slug, name, fields, packages, dp_type, dp_value, color)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [cat.slug, cat.name, cat.fields, cat.packages, cat.dp_type, cat.dp_value, cat.color]
          );
        }
        console.log('✅ Default booking categories & packages seeded (graduation, wedding, event, corporation)');
      }

      // Populate packages for existing categories if packages is empty array
      const seedPackages = {
        graduation: [
          { id: 'pkg_grad_1', name: 'Graduation Basic', price: 350000, description: '1 Sesi Foto, 10 High Res Edit Photos, All Raw Files via Drive' },
          { id: 'pkg_grad_2', name: 'Graduation Premium', price: 650000, description: '2 Sesi Foto (Individual + Family), 20 Edited Photos, Cetak 10R Premium Frame' },
          { id: 'pkg_grad_3', name: 'Graduation Ultimate', price: 1200000, description: 'Full Outdoor/Studio Session, Unlimited Edit Photos, Video Highlight 1 Menit' }
        ],
        wedding: [
          { id: 'pkg_wed_1', name: 'Akad Only Package', price: 2500000, description: '1 Photographer, 1 Videographer, 50 Edited Photos, Video Teaser 1 Menit' },
          { id: 'pkg_wed_2', name: 'Silver Wedding Package', price: 5000000, description: 'Akad + Resepsi (Max 6 Jam), 2 Photographers, Exclusive Album 20x30' },
          { id: 'pkg_wed_3', name: 'Gold Luxury Wedding', price: 8500000, description: 'Full Day Coverage, Drone Cinematic Video, Photobooth 2 Jam, Premium Leather Album' }
        ],
        event: [
          { id: 'pkg_evt_1', name: 'Half Day Event', price: 1500000, description: 'Durasi hingga 4 Jam, 1 Photographer, All High-Res Softcopy Files' },
          { id: 'pkg_evt_2', name: 'Full Day Event', price: 2800000, description: 'Durasi hingga 8 Jam, 2 Photographers, Highlight Reel Edit Photos' }
        ],
        corporation: [
          { id: 'pkg_corp_1', name: 'Corporate Headshot', price: 2000000, description: 'Studio Lighting Setup, Up to 15 Executives Headshot, Retouched High-Res' },
          { id: 'pkg_corp_2', name: 'Company Profile & Product', price: 4500000, description: 'Commercial Rights, Product Catalog Shoot, Office & Team In-Action Photo/Video' }
        ]
      };

      for (const [slug, pkgs] of Object.entries(seedPackages)) {
        await pool.query(
          `UPDATE booking_categories SET packages = $1 WHERE slug = $2 AND (packages IS NULL OR packages = '[]'::jsonb OR jsonb_array_length(packages) = 0)`,
          [JSON.stringify(pkgs), slug]
        );
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
