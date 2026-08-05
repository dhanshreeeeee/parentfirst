-- ParentFirst — Migration 006: keep the original uploaded report file
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/006_report_files.sql

ALTER TABLE reports ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS file_mime TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS has_file  BOOLEAN NOT NULL DEFAULT false;
