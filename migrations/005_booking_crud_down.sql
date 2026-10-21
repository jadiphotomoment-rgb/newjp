-- Rollback migrasi 005
DROP INDEX IF EXISTS ix_bookings_status_paid;
ALTER TABLE bookings DROP COLUMN IF EXISTS notes;

DROP INDEX IF EXISTS ux_financial_entries_sumber_aktif;
CREATE UNIQUE INDEX IF NOT EXISTS ux_financial_entries_sumber_aktif
  ON financial_entries (sumber_tipe, sumber_id)
  WHERE status = 'aktif' AND sumber_tipe LIKE 'booking%';
