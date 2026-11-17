-- Migrasi 007 Down: Hapus index event_date dan event_time
DROP INDEX IF EXISTS idx_bookings_event_date_time;

