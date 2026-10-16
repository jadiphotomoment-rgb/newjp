-- Migration 002: Pelunasan Enhancements & Safe Backfill
-- Idempotent: Aman dijalankan berulang kali tanpa mengubah nominal pembayaran

-- 1. Tambah kolom expires_at pada tabel pelunasan jika belum ada
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'pelunasan' AND column_name = 'expires_at'
  ) THEN
    ALTER TABLE pelunasan ADD COLUMN expires_at TIMESTAMP NULL;
  END IF;
END $$;

-- 2. Tambah kolom package_name pada tabel bookings jika belum ada
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'bookings' AND column_name = 'package_name'
  ) THEN
    ALTER TABLE bookings ADD COLUMN package_name VARCHAR(150) NULL;
  END IF;
END $$;

-- 3. Indeks performa & pencarian pelunasan
CREATE INDEX IF NOT EXISTS idx_pelunasan_booking_id ON pelunasan(booking_id);
CREATE INDEX IF NOT EXISTS idx_pelunasan_token ON pelunasan(token);
CREATE INDEX IF NOT EXISTS idx_pelunasan_status ON pelunasan(status);
CREATE INDEX IF NOT EXISTS idx_pelunasan_sent_at ON pelunasan(sent_at);

-- 4. Backfill data transaksi lama (tanpa memodifikasi nominal total/dp/sisa):
-- a. Generate token unik acak 64-hex jika ada transaksi lama yang tokennya NULL/kosong
UPDATE pelunasan
SET token = md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text)
WHERE token IS NULL OR TRIM(token) = '';

-- b. Backfill package_name pada booking lama dari form_data atau nama kategori
UPDATE bookings b
SET package_name = COALESCE(
  NULLIF(TRIM(b.form_data->>'_package_name'), ''),
  NULLIF(TRIM(b.form_data->>'package_name'), ''),
  bc.name,
  'Layanan Fotografi'
)
FROM booking_categories bc
WHERE b.category_id = bc.id 
  AND (b.package_name IS NULL OR TRIM(b.package_name) = '');

-- c. Backfill expires_at default (30 hari setelah tagihan dibuat)
UPDATE pelunasan
SET expires_at = created_at + INTERVAL '30 days'
WHERE expires_at IS NULL;
