-- Migrasi 004: Penambahan kolom CRUD Transaksi Keuangan pada financial_entries
-- Idempotent: aman dijalankan berulang kali

ALTER TABLE financial_entries
  ADD COLUMN IF NOT EXISTS tanggal DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS booking_id INT REFERENCES bookings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_by INT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Tambah kolom paid_amount pada bookings jika belum ada
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12,2) DEFAULT 0;

-- Backfill paid_amount dari dp_amount untuk booking confirmed / completed / lunas
UPDATE bookings
SET paid_amount = COALESCE(dp_amount, 0)
WHERE (paid_amount IS NULL OR paid_amount = 0)
  AND dp_amount IS NOT NULL
  AND status IN ('confirmed', 'completed', 'lunas');

-- Tambah constraint CHECK jika belum ada (opsional, aman)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_financial_entries_source'
  ) THEN
    ALTER TABLE financial_entries
      ADD CONSTRAINT chk_financial_entries_source CHECK (source IN ('manual', 'booking'));
  END IF;
END $$;

-- Backfill baris lama yang terkait booking
UPDATE financial_entries
SET source = 'booking',
    booking_id = sumber_id
WHERE sumber_tipe LIKE 'booking%' AND (booking_id IS NULL OR source = 'manual');

-- Index untuk query list dan rekap
CREATE INDEX IF NOT EXISTS ix_financial_entries_filter
  ON financial_entries (tanggal DESC, tipe)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_financial_entries_booking
  ON financial_entries (booking_id)
  WHERE deleted_at IS NULL;

-- Index unik idempoten pada sumber_tipe + sumber_id untuk entri aktif (booking_dp, booking_pelunasan)
DROP INDEX IF EXISTS ux_financial_entries_sumber_aktif;
CREATE UNIQUE INDEX IF NOT EXISTS ux_financial_entries_sumber_aktif
  ON financial_entries (sumber_tipe, sumber_id)
  WHERE status = 'aktif';
