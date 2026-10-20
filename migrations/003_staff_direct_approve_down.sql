-- Migration 003 Down: Rollback staff direct approve, financial entries & wa outbox

DROP TABLE IF EXISTS wa_outbox CASCADE;
DROP TABLE IF EXISTS financial_entries CASCADE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_approval_rules_no_direct_approve'
  ) THEN
    ALTER TABLE approval_rules DROP CONSTRAINT chk_approval_rules_no_direct_approve;
  END IF;
END $$;
