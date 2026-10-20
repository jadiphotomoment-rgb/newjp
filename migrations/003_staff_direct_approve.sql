-- Migration 003: Staff Direct Approve, Idempotent Financial Entries & WA Outbox (UP)
-- Idempotent & Non-destructive

-- 1. Larang tipe 'booking.approve' dan 'booking.approve_without_dp' masuk ke approval_rules
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_approval_rules_no_direct_approve'
  ) THEN
    ALTER TABLE approval_rules ADD CONSTRAINT chk_approval_rules_no_direct_approve
      CHECK (tipe NOT IN ('booking.approve', 'booking.approve_without_dp'));
  END IF;
END $$;

-- 2. Pastikan kolom version dan updated_by ada di bookings & payments
DO $$
BEGIN
  -- bookings
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='version') THEN
    ALTER TABLE bookings ADD COLUMN version INT NOT NULL DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='updated_by') THEN
    ALTER TABLE bookings ADD COLUMN updated_by INT REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  -- payments
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='version') THEN
    ALTER TABLE payments ADD COLUMN version INT NOT NULL DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='updated_by') THEN
    ALTER TABLE payments ADD COLUMN updated_by INT REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Tabel financial_entries (Entri Keuangan Idempoten dengan unique index sumber_tipe + sumber_id)
CREATE TABLE IF NOT EXISTS financial_entries (
  id           BIGSERIAL PRIMARY KEY,
  tipe         VARCHAR(20) NOT NULL CHECK (tipe IN ('masuk', 'keluar')),
  kategori     VARCHAR(50) NOT NULL,
  nominal      NUMERIC(12,0) NOT NULL CHECK (nominal >= 0),
  sumber_tipe  VARCHAR(40) NOT NULL,
  sumber_id    BIGINT NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'aktif' CHECK (status IN ('aktif', 'batal')),
  catatan      TEXT,
  created_by   INT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index unik pada sumber_tipe + sumber_id untuk entri aktif (Mencegah pencatatan ganda)
CREATE UNIQUE INDEX IF NOT EXISTS ux_financial_entries_sumber_aktif
  ON financial_entries (sumber_tipe, sumber_id)
  WHERE status = 'aktif';

CREATE INDEX IF NOT EXISTS ix_financial_entries_created_at
  ON financial_entries (created_at DESC);

-- 4. Tabel wa_outbox (Outbox Pattern: WA disimpan dalam transaksi, dikirim worker setelah commit)
CREATE TABLE IF NOT EXISTS wa_outbox (
  id          BIGSERIAL PRIMARY KEY,
  phone       VARCHAR(30) NOT NULL,
  message     TEXT NOT NULL,
  tipe        VARCHAR(50) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  retries     INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_wa_outbox_pending
  ON wa_outbox (created_at ASC)
  WHERE status = 'pending';
