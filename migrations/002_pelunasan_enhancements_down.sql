-- Migration 002 Down: Rollback pelunasan enhancements

DROP INDEX IF EXISTS idx_pelunasan_sent_at;
ALTER TABLE pelunasan DROP COLUMN IF EXISTS expires_at;
