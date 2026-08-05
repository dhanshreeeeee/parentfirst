-- ParentFirst — Migration 015: voice notes
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/015_voice_notes.sql

ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_kind TEXT;      -- 'audio' | 'image'
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_secs INT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS has_media  BOOLEAN NOT NULL DEFAULT false;
