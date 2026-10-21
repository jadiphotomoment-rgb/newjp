-- Migrasi 005: Penambahan kolom notes pada bookings & index unik presisi financial_entries
-- Idempotent: aman dijalankan berulang kali

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- Pastikan unique index ux_financial_entries_sumber_aktif aktif untuk status = 'aktif'
DROP INDEX IF EXISTS ux_financial_entries_sumber_aktif;
CREATE UNIQUE INDEX IF NOT EXISTS ux_financial_entries_sumber_aktif
  ON financial_entries (sumber_tipe, sumber_id)
  WHERE status = 'aktif';

-- Index pendukung pencarian booking by status & paid_amount
CREATE INDEX IF NOT EXISTS ix_bookings_status_paid
  ON bookings (status, paid_amount)
  WHERE deleted_at IS NULL;
