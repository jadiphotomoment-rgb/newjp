-- Rollback Migrasi 006: Fitur Terms and Conditions (T&C) Konfirmasi Booking
-- Idempotent: aman dijalankan berulang kali

DROP TABLE IF EXISTS terms_acceptances CASCADE;
DROP TABLE IF EXISTS terms_versions CASCADE;
ALTER TABLE bookings DROP COLUMN IF EXISTS terms_accepted_at;
