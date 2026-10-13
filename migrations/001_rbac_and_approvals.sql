-- Migrasi 001: RBAC, Audit Log, Approval Engine (UP)

-- 1. Tabel users
CREATE TABLE IF NOT EXISTS users (
  id                   SERIAL PRIMARY KEY,
  nama                 VARCHAR(100) NOT NULL,
  email                VARCHAR(150) NOT NULL,
  password_hash        TEXT NOT NULL,
  role                 VARCHAR(10) NOT NULL CHECK (role IN ('owner','staff')),
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  token_version        INT NOT NULL DEFAULT 0,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts      INT NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users (lower(email));

-- 2. Tabel refresh_tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by BIGINT,
  ip          INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_refresh_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

-- 3. Tabel audit_log
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    INT,        -- Tidak pakai FK (audit_log immutable, ON DELETE SET NULL bertentangan dengan trigger)
  actor_role  VARCHAR(10),
  aksi        VARCHAR(60) NOT NULL,
  entitas     VARCHAR(40) NOT NULL,
  entitas_id  BIGINT,
  sebelum     JSONB,
  sesudah     JSONB,
  approval_id BIGINT,
  ip          INET,
  request_id  VARCHAR(40),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_actor   ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_entitas ON audit_log(entitas, entitas_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_time    ON audit_log(created_at DESC);

-- Append-only trigger untuk audit_log
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: UPDATE and DELETE are prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_log;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- 4. Tabel approval_rules
CREATE TABLE IF NOT EXISTS approval_rules (
  tipe           VARCHAR(40) PRIMARY KEY,
  requires_owner BOOLEAN NOT NULL DEFAULT TRUE,
  expires_days   INT NOT NULL DEFAULT 7
);

INSERT INTO approval_rules (tipe, requires_owner, expires_days) VALUES
  ('booking.cancel_with_dp', true, 7),
  ('booking.delete', true, 7),
  ('booking.discount', true, 7),
  ('tagihan.override_amount', true, 7),
  ('payment.verify', false, 7),
  ('booking.status_change', false, 7)
ON CONFLICT (tipe) DO NOTHING;

-- 5. Tabel approval_requests
CREATE TABLE IF NOT EXISTS approval_requests (
  id            BIGSERIAL PRIMARY KEY,
  tipe          VARCHAR(40) NOT NULL REFERENCES approval_rules(tipe),
  entitas       VARCHAR(40) NOT NULL,
  entitas_id    BIGINT NOT NULL,
  payload       JSONB NOT NULL,
  base_version  INT NOT NULL,
  alasan        TEXT,
  status        VARCHAR(12) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','stale','expired','cancelled')),
  requested_by  INT NOT NULL,   -- Tidak FK agar user test bisa dihapus bebas
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    INT,            -- Tidak FK untuk alasan yang sama
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  applied_at    TIMESTAMPTZ,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_approval_pending ON approval_requests(tipe, entitas, entitas_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ix_approval_status ON approval_requests(status, requested_at DESC);

-- 6. Tambah kolom created_by, updated_by, version pada bookings, pelunasan, payments
DO $$
BEGIN
  -- bookings
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='created_by') THEN
    ALTER TABLE bookings ADD COLUMN created_by INT REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='updated_by') THEN
    ALTER TABLE bookings ADD COLUMN updated_by INT REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='version') THEN
    ALTER TABLE bookings ADD COLUMN version INT NOT NULL DEFAULT 1;
  END IF;

  -- pelunasan
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pelunasan' AND column_name='created_by') THEN
    ALTER TABLE pelunasan ADD COLUMN created_by INT REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pelunasan' AND column_name='updated_by') THEN
    ALTER TABLE pelunasan ADD COLUMN updated_by INT REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pelunasan' AND column_name='version') THEN
    ALTER TABLE pelunasan ADD COLUMN version INT NOT NULL DEFAULT 1;
  END IF;

  -- payments
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='created_by') THEN
    ALTER TABLE payments ADD COLUMN created_by INT REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='updated_by') THEN
    ALTER TABLE payments ADD COLUMN updated_by INT REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='version') THEN
    ALTER TABLE payments ADD COLUMN version INT NOT NULL DEFAULT 1;
  END IF;
END $$;
