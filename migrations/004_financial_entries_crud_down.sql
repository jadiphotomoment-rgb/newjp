-- Rollback Migrasi 004
DROP INDEX IF EXISTS ix_financial_entries_filter;
DROP INDEX IF EXISTS ix_financial_entries_booking;

ALTER TABLE financial_entries
  DROP COLUMN IF EXISTS tanggal,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS booking_id,
  DROP COLUMN IF EXISTS deleted_at,
  DROP COLUMN IF EXISTS updated_by,
  DROP COLUMN IF EXISTS updated_at;
