-- Migrasi 001: RBAC, Audit Log, Approval Engine (DOWN / ROLLBACK)

-- 1. Hapus kolom tambahan pada bookings, pelunasan, payments
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='created_by') THEN
    ALTER TABLE bookings DROP COLUMN created_by;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='updated_by') THEN
    ALTER TABLE bookings DROP COLUMN updated_by;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='version') THEN
    ALTER TABLE bookings DROP COLUMN version;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pelunasan' AND column_name='created_by') THEN
    ALTER TABLE pelunasan DROP COLUMN created_by;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pelunasan' AND column_name='updated_by') THEN
    ALTER TABLE pelunasan DROP COLUMN updated_by;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pelunasan' AND column_name='version') THEN
    ALTER TABLE pelunasan DROP COLUMN version;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='created_by') THEN
    ALTER TABLE payments DROP COLUMN created_by;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='updated_by') THEN
    ALTER TABLE payments DROP COLUMN updated_by;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='version') THEN
    ALTER TABLE payments DROP COLUMN version;
  END IF;
END $$;

-- 2. Hapus approval_requests
DROP TABLE IF EXISTS approval_requests CASCADE;

-- 3. Hapus approval_rules
DROP TABLE IF EXISTS approval_rules CASCADE;

-- 4. Hapus trigger dan audit_log
DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_log;
DROP FUNCTION IF EXISTS audit_log_immutable();
DROP TABLE IF EXISTS audit_log CASCADE;

-- 5. Hapus refresh_tokens
DROP TABLE IF EXISTS refresh_tokens CASCADE;

-- 6. Hapus users
DROP TABLE IF EXISTS users CASCADE;
