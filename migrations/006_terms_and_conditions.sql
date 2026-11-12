-- Migrasi 006: Fitur Terms and Conditions (T&C) Konfirmasi Booking
-- Idempotent: aman dijalankan berulang kali

-- 1. Tabel terms_versions (manajemen versi & draf T&C)
CREATE TABLE IF NOT EXISTS terms_versions (
  id              SERIAL PRIMARY KEY,
  version_number  INT NOT NULL,
  title           VARCHAR(255) NOT NULL DEFAULT 'Syarat & Ketentuan Umum Layanan Studio',
  content_points  JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft',
  created_by      INT NULL,
  published_at    TIMESTAMP NULL,
  created_at      TIMESTAMP DEFAULT now(),
  updated_at      TIMESTAMP DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'terms_versions_created_by_fkey') THEN
    ALTER TABLE terms_versions DROP CONSTRAINT terms_versions_created_by_fkey;
  END IF;
END $$;

-- Indeks unik parsial: hanya boleh ada 1 versi aktif sekaligus
CREATE UNIQUE INDEX IF NOT EXISTS ux_terms_versions_active 
  ON terms_versions (status) 
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS ix_terms_versions_status 
  ON terms_versions (status);

-- 2. Tabel terms_acceptances (audit trail append-only bukti persetujuan klien)
CREATE TABLE IF NOT EXISTS terms_acceptances (
  id                  SERIAL PRIMARY KEY,
  booking_id          INT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  terms_version_id    INT NOT NULL REFERENCES terms_versions(id),
  snapshot_text       TEXT NOT NULL,
  verification_token  VARCHAR(64) UNIQUE NOT NULL,
  client_name         VARCHAR(150) NOT NULL,
  client_phone        VARCHAR(30) NOT NULL,
  ip_address          VARCHAR(50) NULL,
  user_agent          TEXT NULL,
  accepted_at         TIMESTAMP NOT NULL DEFAULT now(),
  created_at          TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_terms_acceptances_booking_id 
  ON terms_acceptances (booking_id);

CREATE INDEX IF NOT EXISTS ix_terms_acceptances_token 
  ON terms_acceptances (verification_token);

-- 3. Kolom stempel waktu persetujuan pada tabel bookings
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP NULL;

-- 4. Seed 1 versi aktif T&C Umum (FR9) secara idempotent
INSERT INTO terms_versions (version_number, title, content_points, status, published_at)
SELECT 
  1,
  'Syarat & Ketentuan Umum Layanan Studio',
  jsonb_build_array(
    'Kehadiran & Ketepatan Waktu: Klien wajib hadir di lokasi studio minimal 15 menit sebelum sesi foto dimulai. Keterlambatan kedatangan oleh klien akan mengurangi durasi waktu sesi tanpa kompensasi penambahan waktu.',
    'Ketentuan Uang Muka (DP): Pembayaran Uang Muka (DP) bersifat mengikat slot jadwal dan tidak dapat dikembalikan (non-refundable) apabila terjadi pembatalan sepihak oleh pihak klien.',
    'Penjadwalan Ulang (Reschedule): Permohonan jadwal ulang (reschedule) hanya diperbolehkan maksimal H-3 sebelum tanggal sesi foto dan wajib menyesuaikan ketersediaan slot kosong studio.',
    'Hak Cipta & Penyerahan Berkas: Studio berhak menggunakan sebagian hasil foto untuk keperluan portofolio/media sosial kecuali dinyatakan lain secara tertulis; berkas foto mentah (raw) dan hasil edit akan diserahkan setelah seluruh biaya pelunasan diselesaikan.'
  ),
  'active',
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM terms_versions WHERE status = 'active'
);
