-- ParentFirst — Migration 011: record when the wellness log was last saved
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/011_wellness_saved.sql

ALTER TABLE wellness_logs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE wellness_logs ADD COLUMN IF NOT EXISTS saved_by   UUID REFERENCES users(id);

-- backfill so existing rows show something sensible
UPDATE wellness_logs SET updated_at = created_at WHERE updated_at IS NULL;
