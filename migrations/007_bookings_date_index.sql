-- Migrasi 007: Index kolom event_date dan event_time untuk filter tanggal booking
-- Idempotent: aman dijalankan berulang kali (CATATAN: JANGAN JALANKAN KE PRODUKSI)

CREATE INDEX IF NOT EXISTS idx_bookings_event_date_time
  ON bookings (event_date, event_time)
  WHERE deleted_at IS NULL;

